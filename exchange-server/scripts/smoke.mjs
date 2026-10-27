import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { originChecksDisabled } from "../apps/api/src/origin-policy.ts";
const base = process.env.EXCHANGE_TEST_URL ?? "http://localhost:3000";
const wsBase = process.env.EXCHANGE_TEST_WS_URL ?? base.replace(/^http/, "ws");
const sockets = [];
async function request(
  path,
  { cookie, body, method = "GET", origin = base } = {},
) {
  return fetch(base + path, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function account() {
  const email = `smoke-${randomUUID()}@example.com`;
  const response = await request("/api/auth/sign-up/email", {
    method: "POST",
    body: { name: "Smoke test", email, password: randomUUID() },
  });
  assert.equal(response.status, 200, await response.clone().text());
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.ok(cookie, "Session cookie must be returned");
  return cookie;
}
function connect(path, hello, cookie) {
  const socket = new WebSocket(wsBase + path, {
    headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
  });
  sockets.push(socket);
  const inbox = [],
    waiting = [];
  socket.on("message", (raw) => {
    const value = JSON.parse(raw.toString());
    const waiter = waiting.shift();
    if (waiter) waiter(value);
    else inbox.push(value);
  });
  const next = () =>
    new Promise((resolve, reject) => {
      if (inbox.length) {
        resolve(inbox.shift());
        return;
      }
      const timer = setTimeout(
        () => reject(new Error("WebSocket message timeout")),
        5000,
      );
      waiting.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  socket.on("open", () => socket.send(JSON.stringify(hello)));
  return { socket, next };
}
let cookie, point;
try {
  assert.equal((await request("/api/points")).status, 401);
  cookie = await account();
  const other = await account();
  let response = await request("/api/points", {
    cookie,
    method: "POST",
    body: { name: "  Smoke laptop  " },
  });
  assert.equal(response.status, 201, await response.clone().text());
  point = await response.json();
  assert.equal(point.name, "Smoke laptop");
  assert.match(point.key, /^exch_/);
  response = await request("/api/points", { cookie });
  const rows = await response.json();
  assert.equal(rows.length, 1);
  assert.equal("key" in rows[0], false);
  assert.equal("keyHash" in rows[0], false);
  assert.deepEqual(
    await (await request("/api/points", { cookie: other })).json(),
    [],
  );
  assert.equal(
    (
      await request("/api/points/" + point.id, {
        cookie: other,
        method: "DELETE",
      })
    ).status,
    404,
  );
  const crossOrigin = await request("/api/points", {
    cookie,
    method: "POST",
    origin: "https://attacker.invalid",
    body: { name: "Origin policy test" },
  });
  if (originChecksDisabled()) {
    assert.equal(crossOrigin.status, 201);
    const extra = await crossOrigin.json();
    assert.equal(
      (await request("/api/points/" + extra.id, { cookie, method: "DELETE" }))
        .status,
      200,
    );
  } else assert.equal(crossOrigin.status, 403);
  assert.equal(
    (await request("/api/points/" + point.id, { cookie: other })).status,
    404,
  );
  const hello = { type: "auth", version: 1, pointId: point.id };
  // The independent media channel uses the same point ownership and key checks.
  const deniedMedia = connect("/ws/stream-browser", hello, other);
  assert.equal(
    await new Promise((resolve) => deniedMedia.socket.once("close", resolve)),
    1008,
  );
  const mediaAgent = connect("/ws/stream-agent", { ...hello, key: point.key });
  assert.equal((await mediaAgent.next()).type, "ready");
  assert.equal((await mediaAgent.next()).active, false);
  const mediaViewer = connect("/ws/stream-browser", hello, cookie);
  assert.equal((await mediaViewer.next()).online, true);
  mediaViewer.socket.send(
    JSON.stringify({ type: "browser.watch", active: true }),
  );
  assert.equal((await mediaAgent.next()).active, true);
  const browserState = {
    type: "browser.state",
    tabs: [{ id: "test-tab", title: "Smoke", url: "http://localhost:5173" }],
    selected: "test-tab",
  };
  mediaAgent.socket.send(JSON.stringify(browserState));
  assert.deepEqual(await mediaViewer.next(), browserState);
  const browserFrame = {
    type: "browser.frame",
    tabId: "test-tab",
    data: "/9j/AA==",
    width: 800,
    height: 600,
  };
  mediaAgent.socket.send(JSON.stringify(browserFrame));
  assert.deepEqual(await mediaViewer.next(), browserFrame);
  const browserCommand = {
    type: "browser.command",
    id: randomUUID(),
    action: "input",
    tabId: "test-tab",
    input: { action: "text", text: "Remote smoke" },
  };
  mediaViewer.socket.send(JSON.stringify(browserCommand));
  assert.deepEqual(await mediaAgent.next(), browserCommand);
  mediaAgent.socket.send(
    JSON.stringify({ type: "browser.result", id: browserCommand.id, ok: true }),
  );
  assert.equal((await mediaViewer.next()).ok, true);
  mediaViewer.socket.close();
  assert.equal((await mediaAgent.next()).active, false);
  mediaAgent.socket.close();
  const rejected = connect("/ws/agent", { ...hello, key: "wrong" });
  assert.equal(
    await new Promise((resolve) =>
      rejected.socket.once("close", (code) => resolve(code)),
    ),
    4001,
  );
  const viewer = connect("/ws/browser", hello, cookie);
  assert.equal((await viewer.next()).online, false);
  const offlineId = randomUUID();
  viewer.socket.send(
    JSON.stringify({
      type: "chat.send",
      id: offlineId,
      chatId: "demo",
      text: "offline",
    }),
  );
  assert.equal((await viewer.next()).ok, false);
  const agent = connect("/ws/agent", { ...hello, key: point.key });
  assert.equal((await agent.next()).type, "ready");
  assert.equal((await viewer.next()).online, true);
  const snapshot = {
    type: "chat.snapshot",
    chatId: "demo",
    running: false,
    messages: [{ id: "m1", role: "assistant", text: "hello" }],
  };
  agent.socket.send(JSON.stringify(snapshot));
  assert.deepEqual(await viewer.next(), snapshot);
  const command = {
    type: "chat.send",
    id: randomUUID(),
    chatId: "demo",
    text: "from browser",
  };
  viewer.socket.send(JSON.stringify(command));
  assert.deepEqual(await agent.next(), command);
  agent.socket.send(
    JSON.stringify({ type: "command.result", id: command.id, ok: true }),
  );
  assert.equal((await viewer.next()).ok, true);
  const fullSnapshot = {
    ...snapshot,
    uiVersion: 1,
    view: {
      chatId: "demo",
      entries: [{ kind: "assistant", text: "Full UI" }],
      tabs: [{ id: "tab-demo", chatId: "demo", title: "Demo" }],
    },
  };
  agent.socket.send(JSON.stringify(fullSnapshot));
  assert.deepEqual(await viewer.next(), fullSnapshot);
  const uiCommand = {
    type: "chat.command",
    id: randomUUID(),
    chatId: "demo",
    message: { type: "select", selection: { agent: "codex", model: "test" } },
  };
  viewer.socket.send(JSON.stringify(uiCommand));
  assert.deepEqual(await agent.next(), uiCommand);
  agent.socket.send(
    JSON.stringify({
      type: "chat.event",
      chatId: "demo",
      message: { type: "usage", usage: [], loading: false },
    }),
  );
  assert.equal((await viewer.next()).type, "chat.event");
  agent.socket.send(
    JSON.stringify({ type: "command.result", id: uiCommand.id, ok: true }),
  );
  assert.equal((await viewer.next()).ok, true);
  const pin = { type: "chat.pin", id: randomUUID(), chatId: "demo" };
  viewer.socket.send(JSON.stringify(pin));
  assert.deepEqual(await agent.next(), pin);
  agent.socket.send(
    JSON.stringify({ type: "command.result", id: pin.id, ok: true }),
  );
  assert.equal((await viewer.next()).ok, true);
  const agentClosed = new Promise((resolve) =>
    agent.socket.once("close", resolve),
  );
  response = await request("/api/points/" + point.id + "/key", {
    cookie,
    method: "POST",
  });
  assert.equal(response.status, 201);
  const rotated = await response.json();
  assert.notEqual(rotated.key, point.key);
  await agentClosed;
  const stale = connect("/ws/agent", { ...hello, key: point.key });
  assert.equal(
    await new Promise((resolve) => stale.socket.once("close", resolve)),
    4001,
  );
  const renewed = connect("/ws/agent", { ...hello, key: rotated.key });
  assert.equal((await renewed.next()).type, "ready");
  console.log(
    "PASS: registration, sessions, ownership isolation, origin check, key secrecy, offline rejection, relay, rotation and old-key rejection",
  );
} finally {
  for (const socket of sockets) socket.terminate();
  if (cookie && point)
    await request("/api/points/" + point.id, { cookie, method: "DELETE" });
}
