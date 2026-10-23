import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { Pool } from "pg";
import WebSocket from "ws";
import {
  exchangeCipher,
  encryptedExchangeSocket,
} from "../../src/core/exchangeCrypto.ts";
const base = process.env.EXCHANGE_TEST_URL ?? "http://localhost:3000",
  wsBase = base.replace(/^http/, "ws");
const created = [],
  sockets = [];
function client() {
  const cookies = new Map();
  return {
    cookies,
    async call(path, body) {
      const response = await fetch(base + "/api/" + path, {
        method: body ? "POST" : "GET",
        headers: {
          Origin: base,
          Cookie: [...cookies].map(([k, v]) => k + "=" + v).join("; "),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(";")[0],
          split = pair.indexOf("=");
        cookies.set(pair.slice(0, split), pair.slice(split + 1));
      }
      const data = await response.json();
      return { status: response.status, data };
    },
  };
}
function code(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret.toUpperCase().replace(/=+$/, ""))
    bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}
function socket(path, cipher, agent, cookie, sync) {
  const raw = [];
  class Transport extends WebSocket {
    constructor(url) {
      super(url, { headers: { Origin: base, Cookie: cookie ?? "" } });
      sockets.push(this);
    }
    send(value) {
      raw.push(JSON.parse(value));
      return super.send(value);
    }
  }
  const ws = encryptedExchangeSocket(
    wsBase + path,
    cipher,
    agent,
    sync,
    Transport,
  );
  const inbox = [],
    waiting = [];
  ws.onmessage = (e) => {
    const value = JSON.parse(e.data);
    if (waiting.length) waiting.shift()(value);
    else inbox.push(value);
  };
  const next = () =>
    new Promise((resolve, reject) => {
      if (inbox.length) return resolve(inbox.shift());
      const timeout = setTimeout(
        () => reject(new Error("Encrypted message timeout")),
        5000,
      );
      waiting.push((v) => {
        clearTimeout(timeout);
        resolve(v);
      });
    });
  ws.onopen = () =>
    ws.send(
      JSON.stringify({
        type: "auth",
        version: 1,
        pointId: cipher.pointId,
        ...(agent ? { key: point.key } : {}),
      }),
    );
  return { ws, raw, next };
}
let point;
try {
  const owner = client(),
    email = "security-" + randomUUID() + "@example.com",
    password = randomUUID();
  let result = await owner.call("auth/sign-up/email", {
    name: "Security check",
    email,
    password,
  });
  assert.equal(result.status, 200);
  created.push(result.data.user.id);
  result = await owner.call("auth/two-factor/enable", {
    password,
    method: "totp",
  });
  assert.equal(result.status, 200);
  const setup = result.data;
  assert.ok(setup.totpURI);
  assert.ok(setup.backupCodes.length);
  const secret = new URL(setup.totpURI).searchParams.get("secret");
  assert.equal(
    (await owner.call("auth/two-factor/verify-totp", { code: code(secret) }))
      .status,
    200,
  );
  let login = client();
  result = await login.call("auth/sign-in/email", { email, password });
  assert.equal(result.status, 200);
  assert.equal(result.data.twoFactorRedirect, true);
  assert.equal((await login.call("points")).status, 401);
  assert.notEqual(
    (await login.call("auth/two-factor/verify-totp", { code: "00000000" }))
      .status,
    200,
  );
  assert.equal(
    (await login.call("auth/two-factor/verify-totp", { code: code(secret) }))
      .status,
    200,
  );
  assert.equal((await login.call("points")).status, 200);
  login = client();
  await login.call("auth/sign-in/email", { email, password });
  assert.equal(
    (
      await login.call("auth/two-factor/verify-backup-code", {
        code: setup.backupCodes[0],
      })
    ).status,
    200,
  );
  login = client();
  await login.call("auth/sign-in/email", { email, password });
  assert.notEqual(
    (
      await login.call("auth/two-factor/verify-backup-code", {
        code: setup.backupCodes[0],
      })
    ).status,
    200,
  );
  assert.equal(
    (await owner.call("auth/two-factor/disable", { password })).status,
    200,
  );
  console.log(
    "PASS: 2FA enrollment, login challenge, invalid code rejection, single-use recovery codes, disable",
  );
  result = await owner.call("points", { name: "Encrypted smoke workspace" });
  assert.equal(result.status, 201);
  point = result.data;
  const cipher = await exchangeCipher("test-only-" + randomUUID(), point.id);
  await assert.rejects(
    () => exchangeCipher("wrong password", point.id, cipher.descriptor),
    /Incorrect/,
  );
  const cookie = [...owner.cookies].map(([k, v]) => k + "=" + v).join("; ");
  let agent;
  agent = socket("/ws/agent", cipher, true, cookie, () =>
    agent.ws.send(
      JSON.stringify({ type: "chat.snapshot", text: "private chat content" }),
    ),
  );
  assert.equal((await agent.next()).type, "ready");
  const viewer = socket(
    "/ws/browser",
    { ...cipher, received: undefined },
    false,
    cookie,
  );
  assert.equal((await viewer.next()).type, "ready");
  assert.equal((await viewer.next()).text, "private chat content");
  viewer.ws.send(
    JSON.stringify({
      type: "chat.command",
      id: randomUUID(),
      text: "private command",
    }),
  );
  assert.equal((await agent.next()).text, "private command");
  let media;
  media = socket("/ws/stream-agent", cipher, true, cookie, () =>
    media.ws.send(
      JSON.stringify({ type: "browser.frame", data: "private frame bytes" }),
    ),
  );
  assert.equal((await media.next()).type, "ready");
  const browsers = socket(
    "/ws/stream-browser",
    { ...cipher, received: undefined },
    false,
    cookie,
  );
  assert.equal((await browsers.next()).type, "ready");
  assert.equal((await browsers.next()).data, "private frame bytes");
  const content = [
    ...agent.raw,
    ...viewer.raw,
    ...media.raw,
    ...browsers.raw,
  ].filter((v) => v.type !== "auth");
  assert.ok(content.length >= 6);
  assert.ok(content.every((v) => v.type === "secure"));
  assert.ok(!JSON.stringify(content).includes("private"));
  const unprotected = new WebSocket(wsBase + "/ws/browser", {
    headers: { Origin: base, Cookie: cookie },
  });
  sockets.push(unprotected);
  unprotected.on("open", () =>
    unprotected.send(
      JSON.stringify({ type: "auth", version: 1, pointId: point.id }),
    ),
  );
  const close = await new Promise((resolve) =>
    unprotected.once("close", resolve),
  );
  assert.equal(close, 1008);
  const details = await owner.call("points/" + point.id);
  assert.equal(details.status, 200);
  assert.equal(details.data.encryption.epoch, cipher.descriptor.epoch);
  assert.equal((await client().call("points/" + point.id)).status, 401);
  assert.equal(
    (await owner.call("points")).data.find((row) => row.id === point.id)
      .protected,
    true,
  );
  const legacy = new WebSocket(wsBase + "/ws/agent", {
    headers: { Origin: base },
  });
  sockets.push(legacy);
  legacy.on("open", () =>
    legacy.send(
      JSON.stringify({
        type: "auth",
        version: 1,
        pointId: point.id,
        key: point.key,
      }),
    ),
  );
  assert.equal(
    await new Promise((resolve) => legacy.once("close", resolve)),
    4001,
  );
  const disabled = new WebSocket(wsBase + "/ws/agent", {
    headers: { Origin: base },
  });
  sockets.push(disabled);
  disabled.on("open", () =>
    disabled.send(
      JSON.stringify({
        type: "auth",
        version: 1,
        pointId: point.id,
        key: point.key,
        encryption: null,
      }),
    ),
  );
  const unlocked = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Protection removal timeout")),
      5000,
    );
    disabled.once("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw));
    });
  });
  assert.equal(unlocked.type, "ready");
  assert.equal(unlocked.encryption, null);
  assert.equal((await owner.call("points/" + point.id)).data.encryption, null);
  console.log(
    "PASS: encrypted chat, commands and media, wrong password rejection, plaintext downgrade rejection",
  );
} finally {
  for (const ws of sockets) ws.terminate();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    for (const id of created)
      await pool.query('DELETE FROM "user" WHERE id=$1', [id]);
  } finally {
    await pool.end();
  }
}
