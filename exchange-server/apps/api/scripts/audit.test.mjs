import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const require = createRequire(import.meta.url);
const exports = {};
runInNewContext(
  ts.transpileModule(
    readFileSync(new URL("../src/security/audit.ts", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText,
  { exports, require, process, console, setInterval, clearInterval },
);
const { Audit, requestIdentity } = exports;
test("audit IPs ignore spoofed headers and only honor an explicitly trusted proxy", () => {
  const original = process.env.AUDIT_TRUSTED_PROXIES;
  try {
    delete process.env.AUDIT_TRUSTED_PROXIES;
    const request = {
      socket: { remoteAddress: "::ffff:127.0.0.1" },
      headers: {
        "x-forwarded-for": "203.0.113.5",
        "user-agent": "a".repeat(900),
      },
    };
    assert.equal(requestIdentity(request).ip, "127.0.0.1");
    assert.equal(requestIdentity(request).userAgent.length, 512);
    process.env.AUDIT_TRUSTED_PROXIES = "127.0.0.1";
    assert.equal(requestIdentity(request).ip, "203.0.113.5");
    request.headers["x-forwarded-for"] = "untrusted text";
    assert.equal(requestIdentity(request).ip, "127.0.0.1");
    request.socket.remoteAddress = "198.51.100.7";
    request.headers["x-forwarded-for"] = "203.0.113.5";
    assert.equal(requestIdentity(request).ip, "198.51.100.7");
  } finally {
    if (original === undefined) delete process.env.AUDIT_TRUSTED_PROXIES;
    else process.env.AUDIT_TRUSTED_PROXIES = original;
  }
});
test("audit connections persist closure once and exclude arbitrary secrets and close reasons", async () => {
  const calls = [];
  const audit = new Audit({
    query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: [] };
    },
  });
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.terminate = () => {
    socket.readyState = 3;
    socket.emit("close", 1006);
  };
  await audit.track(
    socket,
    {
      socket: { remoteAddress: "127.0.0.1" },
      headers: {
        cookie: "secret-cookie",
        authorization: "secret-token",
        "user-agent": "device",
      },
    },
    {
      userId: "owner",
      pointId: "workspace",
      kind: "chat",
      authSessionId: "session",
    },
  );
  assert.equal(audit.connections.size, 1);
  socket.emit("close", 1008, Buffer.from("untrusted secret reason"));
  socket.emit("close", 1008);
  await audit.close();
  assert.equal(audit.connections.size, 0);
  assert.equal(
    calls.filter((c) => c.sql.startsWith("UPDATE exchange_connection")).length,
    1,
  );
  const persisted = JSON.stringify(calls);
  for (const secret of [
    "secret-cookie",
    "secret-token",
    "untrusted secret reason",
  ])
    assert.ok(!persisted.includes(secret));
  assert.ok(persisted.includes("close_1008"));
});
