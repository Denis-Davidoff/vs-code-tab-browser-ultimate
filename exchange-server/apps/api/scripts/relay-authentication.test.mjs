import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { WebSocket } from "ws";

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/relay.ts", import.meta.url), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
    },
  },
).outputText;
const hash = (key) => createHash("sha256").update(key).digest("hex");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
class Socket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent = [];
  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = WebSocket.CLOSED;
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
}
function fixture({ waitAt = "audit", encryption } = {}) {
  const entered = deferred(),
    resume = deferred();
  let record = {
    id: "point",
    userId: "owner",
    keyHash: hash("old-key"),
    encryption: null,
  };
  const matches = (condition) =>
    Array.isArray(condition)
      ? condition.every(matches)
      : record && record[condition.key] === condition.value;
  const pause = async (stage) => {
    if (stage === waitAt) {
      entered.resolve();
      await resume.promise;
    }
  };
  const services = {
    db: {
      select: () => ({
        from: () => ({
          where: async (condition) =>
            matches(condition) ? [{ ...record }] : [],
        }),
      }),
      update: () => ({
        set: (values) => ({
          where: (condition) => ({
            returning: async () => {
              if (!matches(condition)) return [];
              Object.assign(record, values);
              return [{ id: record.id }];
            },
          }),
        }),
      }),
    },
    plugins: { agent: () => pause("quota"), isDenied: () => false },
    audit: { track: () => pause("audit") },
  };
  const exports = {};
  runInNewContext(compiled, {
    exports,
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
    require(name) {
      if (name === "./security/audit.js")
        return { requestIdentity: () => ({}) };
      if (name === "./stream-relay.js")
        return {
          StreamRelay: class {
            disconnectPoint() {}
          },
        };
      if (name === "./services.js") return { Services: class {} };
      if (name === "./schema.js")
        return {
          point: {
            id: "id",
            userId: "userId",
            keyHash: "keyHash",
            encryption: "encryption",
          },
        };
      if (name === "./origin-policy.js") return {};
      if (name === "./encrypted-envelope.js")
        return { encryptionSchema: { parse: (value) => value } };
      if (name === "@exchange/protocol")
        return { PROTOCOL_VERSION: 1, RELAY_FEATURES: [] };
      if (name === "drizzle-orm")
        return {
          eq: (key, value) => ({ key, value }),
          and: (...conditions) => conditions,
        };
      return require(name);
    },
  });
  const relay = new exports.Relay(services),
    socket = new Socket();
  const authenticate = () =>
    relay.authenticate(
      socket,
      { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
      "/ws/agent",
      JSON.stringify({
        type: "auth",
        version: 1,
        pointId: "point",
        key: "old-key",
        ...(encryption ? { encryption } : {}),
      }),
    );
  return {
    relay,
    socket,
    authenticate,
    entered: entered.promise,
    resume: resume.resolve,
    rotate: () => {
      record.keyHash = hash("new-key");
      relay.disconnectPoint("point");
    },
    remove: () => {
      record = undefined;
      relay.disconnectPoint("point");
    },
    record: () => record,
  };
}

for (const revoke of ["rotate", "remove"]) {
  test(`${revoke} during audit rejects the pending agent and preserves its replacement`, async () => {
    const f = fixture();
    const pending = f.authenticate();
    await f.entered;
    f[revoke]();
    const replacement = new Socket();
    f.relay.agents.set("point", replacement);
    f.resume();
    await assert.rejects(pending, /Access revoked/);
    assert.equal(f.relay.agents.get("point"), replacement);
    assert.equal(replacement.closed, undefined);
    assert.equal(f.socket.sent.length, 0);
  });
}

test("a key revoked during quota checks cannot change workspace encryption", async () => {
  const f = fixture({
    waitAt: "quota",
    encryption: { epoch: "new-encryption" },
  });
  const pending = f.authenticate();
  await f.entered;
  f.rotate();
  f.resume();
  await assert.rejects(pending, /Access revoked/);
  assert.equal(f.record().encryption, null);
  assert.equal(f.relay.agents.size, 0);
});

test("a still-authorized agent completes the handshake", async () => {
  const f = fixture();
  const pending = f.authenticate();
  await f.entered;
  f.resume();
  await pending;
  assert.equal(f.relay.agents.get("point"), f.socket);
  assert.equal(f.socket.sent[0].type, "ready");
});
