import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
function relay() {
  const exports = {};
  runInNewContext(compiled, {
    exports,
    Buffer,
    require(name) {
      if (name === "./security/audit.js")
        return { requestIdentity: () => ({}) };
      if (name === "./stream-relay.js")
        return {
          StreamRelay: class {
            dispose() {}
          },
        };
      if (name === "./services.js") return { Services: class {} };
      if (name === "./origin-policy.js") return {};
      if (
        name === "./encrypted-envelope.js" ||
        name === "./schema.js" ||
        name === "@exchange/protocol"
      )
        return {};
      return require(name);
    },
  });
  return new exports.Relay({});
}
test("chat viewer presence counts separate sessions and is negotiated for older extensions", () => {
  const r = relay(),
    sent = [];
  const agent = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (raw) => sent.push(JSON.parse(raw)),
  };
  r.agents.set("point", agent);
  const laptop = { readyState: WebSocket.OPEN },
    phone = { readyState: WebSocket.OPEN },
    closed = { readyState: WebSocket.CLOSED };
  r.viewers.set("point", new Set([laptop, phone, closed]));
  r.notifyChatViewers("point");
  assert.equal(sent.length, 0);
  r.viewerPresence.add(agent);
  r.notifyChatViewers("point");
  assert.equal(sent.at(-1).count, 2);
  r.viewers.get("point").delete(phone);
  r.notifyChatViewers("point");
  assert.equal(sent.at(-1).count, 1);
  r.viewers.get("point").clear();
  r.notifyChatViewers("point");
  assert.equal(sent.at(-1).count, 0);
});

test("the agent address comes from the proxy headers behind loopback and from the peer otherwise", () => {
  const exports = {};
  runInNewContext(compiled, {
    exports,
    Buffer,
    require(name) {
      if (name === "./security/audit.js")
        return { requestIdentity: () => ({}) };
      if (name === "./stream-relay.js")
        return {
          StreamRelay: class {
            dispose() {}
          },
        };
      if (name === "./services.js") return { Services: class {} };
      if (
        [
          "./origin-policy.js",
          "./encrypted-envelope.js",
          "./schema.js",
          "@exchange/protocol",
        ].includes(name)
      )
        return {};
      return require(name);
    },
  });
  const req = (peer, headers = {}) => ({
    socket: { remoteAddress: peer },
    headers,
  });
  assert.equal(
    exports.clientAddress(
      req("127.0.0.1", {
        "cf-connecting-ip": "203.0.113.7",
        "x-forwarded-for": "1.1.1.1",
      }),
    ),
    "203.0.113.7",
  );
  assert.equal(
    exports.clientAddress(
      req("::1", { "x-forwarded-for": "198.51.100.2, 172.70.0.1" }),
    ),
    "198.51.100.2",
  );
  assert.equal(
    exports.clientAddress(
      req("::ffff:198.51.100.9", { "x-forwarded-for": "6.6.6.6" }),
    ),
    "198.51.100.9",
    "headers are ignored when the peer is not the local proxy",
  );
  assert.equal(
    exports.clientAddress(req("127.0.0.1", { "x-forwarded-for": "<b>x</b>" })),
    undefined,
  );
});
