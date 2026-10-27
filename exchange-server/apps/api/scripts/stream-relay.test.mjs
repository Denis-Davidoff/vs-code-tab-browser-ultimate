import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
const require = createRequire(import.meta.url);
const source = readFileSync(
  new URL("../src/stream-relay.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const encryptedExports = {};
runInNewContext(
  ts.transpileModule(
    readFileSync(
      new URL("../src/encrypted-envelope.ts", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText,
  { exports: encryptedExports, require },
);
function load() {
  const exports = {};
  runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === "./security/audit.js")
        return { requestIdentity: () => ({}) };
      if (name === "./encrypted-envelope.js") return encryptedExports;
      if (name === "./schema.js")
        return { point: { id: "id", userId: "owner", keyHash: "hash" } };
      if (name === "drizzle-orm")
        return {
          eq: (key, value) => ({ key, value }),
          and: (...items) => items,
        };
      return require(name);
    },
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    Buffer,
    URL,
  });
  return exports;
}
test("stream commands reject raw CDP, file navigation, malformed input and extra fields", () => {
  const { streamCommandSchema } = load();
  const command = {
    type: "browser.command",
    id: randomUUID(),
    action: "input",
    tabId: "tab-1",
    input: { action: "click", x: 0.5, y: 0.2, button: "left", count: 1 },
  };
  assert.equal(streamCommandSchema.safeParse(command).success, true);
  for (const input of [
    { action: "navigate", url: "file:///etc/passwd" },
    { action: "Runtime.evaluate", expression: "secret" },
    { ...command.input, x: 2 },
    { action: "text", text: "x".repeat(4001) },
  ])
    assert.equal(
      streamCommandSchema.safeParse({ ...command, input }).success,
      false,
    );
});
function inbox(ws) {
  const queue = [],
    waiting = [];
  ws.on("message", (raw) => {
    const data = JSON.parse(raw.toString());
    if (waiting.length) waiting.shift()(data);
    else queue.push(data);
  });
  return async (type) => {
    for (let count = 0; count < 20; count++) {
      let timer;
      const message = queue.length
        ? queue.shift()
        : await Promise.race([
            new Promise((resolve) => waiting.push(resolve)),
            new Promise(
              (_, reject) =>
                (timer = setTimeout(
                  () => reject(new Error("Waiting for " + type)),
                  2000,
                )),
            ),
          ]).finally(() => clearTimeout(timer));
      if (message.type === type) return message;
    }
    throw new Error("Missing " + type);
  };
}
test("media relay authenticates, forwards selected-tab frames and inputs, stops on disconnect and revokes access", async (t) => {
  const { StreamRelay } = load(),
    id = randomUUID();
  let allowed = true;
  const services = {
    audit: {
      track: async () => {},
      record: async () => {},
      background: () => {},
    },
    plugins: { agent: async () => {}, viewer: async () => true, policies: [] },
    identity: async (headers) => {
      if (headers.cookie !== "session=owner") throw new Error("Not signed in");
      return { userId: "owner", sessionId: "session" };
    },
    owner: async (headers) => {
      if (headers.cookie !== "session=owner") throw new Error("Not signed in");
      return "owner";
    },
    db: {
      select: () => ({
        from: () => ({
          where: async (conditions) =>
            !Array.isArray(conditions)
              ? [{ id, userId: "owner", encryption: null }]
              : allowed &&
                  conditions.every((c) =>
                    c.key === "id"
                      ? c.value === id
                      : c.key === "owner"
                        ? c.value === "owner"
                        : c.value ===
                          require("node:crypto")
                            .createHash("sha256")
                            .update("test-key")
                            .digest("hex"),
                  )
                ? [{ id }]
                : [],
        }),
      }),
    },
  };
  const relay = new StreamRelay(services),
    server = createServer();
  server.on("upgrade", (request, socket, head) =>
    relay.upgrade(
      request,
      socket,
      head,
      new URL(request.url, "http://localhost").pathname,
    ),
  );
  const sockets = [];
  t.after(() => {
    for (const ws of sockets) ws.terminate();
    relay.dispose();
    server.close();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "ws://127.0.0.1:" + server.address().port;
  async function connect(path, hello, cookie) {
    const ws = new WebSocket(base + path, {
      headers: cookie ? { cookie } : {},
    });
    sockets.push(ws);
    const read = inbox(ws);
    await once(ws, "open");
    ws.send(
      JSON.stringify({ type: "auth", version: 1, pointId: id, ...hello }),
    );
    return { ws, read };
  }
  const bad = await connect("/ws/stream-agent", { key: "wrong" });
  assert.equal((await once(bad.ws, "close"))[0], 4001);
  const agent = await connect("/ws/stream-agent", { key: "test-key" });
  await agent.read("ready");
  const viewer = await connect("/ws/stream-browser", {}, "session=owner");
  await viewer.read("ready");
  viewer.ws.send(JSON.stringify({ type: "browser.watch", active: true }));
  assert.equal((await agent.read("browser.viewers")).active, false);
  assert.equal((await agent.read("browser.viewers")).active, true);
  const state = {
    type: "browser.state",
    tabs: [{ id: "tab-1", title: "Test", url: "http://localhost:5173" }],
    selected: "tab-1",
  };
  agent.ws.send(JSON.stringify(state));
  assert.deepEqual(await viewer.read("browser.state"), state);
  const frame = {
    type: "browser.frame",
    tabId: "tab-1",
    data: "/9j/AA==",
    width: 800,
    height: 600,
  };
  agent.ws.send(JSON.stringify(frame));
  assert.deepEqual(await viewer.read("browser.frame"), frame);
  viewer.ws.send(
    JSON.stringify({ type: "browser.watch", active: true, video: "h264" }),
  );
  assert.equal((await agent.read("browser.viewers")).video, "h264");
  const video = {
    type: "browser.video",
    tabId: "tab-1",
    codec: "avc1.420028",
    streamId: "stream-1",
    key: true,
    timestamp: 100,
    data: "AAAAAQ==",
    width: 800,
    height: 600,
  };
  agent.ws.send(JSON.stringify(video));
  assert.deepEqual(await viewer.read("browser.video"), video);

  // A congested viewer drops images, while command acknowledgements remain reliable.
  let frameCount = 0;
  viewer.ws.on("message", (raw) => {
    if (JSON.parse(raw.toString()).type === "browser.frame") frameCount++;
  });
  const serverViewer = [...relay.viewers.get(id)][0];
  Object.defineProperty(serverViewer, "bufferedAmount", { get: () => 300_000 });
  agent.ws.send(JSON.stringify(frame));
  const command = {
    type: "browser.command",
    id: randomUUID(),
    action: "input",
    tabId: "tab-1",
    input: { action: "text", text: "Hello" },
  };
  viewer.ws.send(JSON.stringify(command));
  assert.deepEqual(await agent.read("browser.command"), command);
  agent.ws.send(
    JSON.stringify({ type: "browser.result", id: command.id, ok: true }),
  );
  assert.equal((await viewer.read("browser.result")).ok, true);
  assert.equal(frameCount, 0);
  viewer.ws.close();
  assert.equal((await agent.read("browser.viewers")).active, false);
  allowed = false;
  relay.disconnectPoint(id);
  assert.equal((await once(agent.ws, "close"))[0], 4001);
});

test("viewer counts track each active socket separately, including the same account", () => {
  const { StreamRelay } = load();
  const relay = new StreamRelay({});
  const messages = [];
  const viewer = () => ({
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (raw) => messages.push(JSON.parse(raw)),
  });
  const laptop = viewer(),
    phone = viewer(),
    background = viewer(),
    agent = viewer();
  try {
    relay.agents.set("point", agent);
    relay.viewers.set("point", new Set([laptop, phone, background]));
    relay.watching.add(laptop);
    relay.watching.add(phone);
    relay.notify("point");
    assert.equal(messages.length, 4);
    assert.ok(
      messages.every((message) => message.count === 2 && message.active),
    );
    messages.length = 0;
    relay.watching.delete(phone);
    relay.notify("point");
    assert.ok(messages.every((message) => message.count === 1));
    messages.length = 0;
    laptop.readyState = WebSocket.CLOSED;
    relay.notify("point");
    assert.ok(
      messages.every((message) => message.count === 0 && !message.active),
    );
  } finally {
    relay.dispose();
  }
});

test("video negotiation requires every active viewer and video packets are bounded", () => {
  const { StreamRelay, videoSchema } = load(),
    relay = new StreamRelay({});
  const messages = [],
    make = () => ({
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: (raw) => messages.push(JSON.parse(raw)),
    });
  const agent = make(),
    modern = make(),
    legacy = make();
  try {
    relay.agents.set("point", agent);
    relay.viewers.set("point", new Set([modern, legacy]));
    relay.watching.add(modern);
    relay.videoViewers.add(modern);
    relay.notify("point");
    assert.equal(messages[0].video, "h264");
    messages.length = 0;
    relay.watching.add(legacy);
    relay.notify("point");
    assert.equal(messages[0].video, undefined);
    messages.length = 0;
    relay.videoViewers.add(legacy);
    relay.notify("point");
    assert.equal(messages[0].video, "h264");
    const packet = {
      type: "browser.video",
      tabId: "a",
      codec: "avc1.420028",
      streamId: "s",
      data: "AAAAAQ==",
      key: true,
      timestamp: 1,
      width: 1440,
      height: 1000,
    };
    assert.equal(videoSchema.safeParse(packet).success, true);
    for (const invalid of [
      { codec: "unknown" },
      { data: "bad!" },
      { timestamp: -1 },
      { width: 0 },
      { streamId: "" },
    ])
      assert.equal(
        videoSchema.safeParse({ ...packet, ...invalid }).success,
        false,
      );
  } finally {
    relay.dispose();
  }
});
