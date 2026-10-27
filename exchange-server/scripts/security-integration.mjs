import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { WebSocket } from "ws";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/test/i.test(new URL(database).pathname))
  throw new Error(
    "Set TEST_DATABASE_URL to an isolated test database (name must contain test)",
  );
const full = process.argv.includes("--full");
const root = fileURLToPath(new URL("../", import.meta.url));
const pool = new pg.Pool({ connectionString: database });
const suffix = randomUUID().slice(0, 8),
  email = `security-${suffix}@example.test`,
  password = `Test-only-${randomUUID()}`;
const port = Number(process.env.TEST_API_PORT ?? (full ? 40272 : 40271)),
  base = `http://127.0.0.1:${port}`;
const sockets = [];
let child;
let output = "";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function start(admin = "") {
  child = spawn(process.execPath, ["apps/api/dist/main.js"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: database,
      BETTER_AUTH_URL: base,
      WEB_ORIGIN: base,
      BETTER_AUTH_SECRET: "security-integration-secret-at-least-32-characters",
      HOST: "127.0.0.1",
      PORT: String(port),
      EXCHANGE_PLUGINS: full ? "sessions,commercial" : "",
      SECURITY_ADMIN_IDS: admin,
      AUDIT_TRUSTED_PROXIES: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) return;
    } catch {}
    if (child.exitCode !== null)
      throw new Error("API failed to start: " + output);
    await delay(50);
  }
  throw new Error("API startup timeout: " + output);
}
async function stop() {
  if (child?.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  child = undefined;
}
async function request(path, { cookie, body, method, headers = {} } = {}) {
  return fetch(base + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      origin: base,
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
function cookie(response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}
async function login() {
  const response = await request("/api/auth/sign-in/email", {
    body: { email, password },
  });
  assert.equal(response.status, 200);
  return cookie(response);
}
async function connect(path, hello, cookieValue) {
  const ws = new WebSocket(base.replace("http", "ws") + path, {
    headers: { origin: base, ...(cookieValue ? { cookie: cookieValue } : {}) },
  });
  sockets.push(ws);
  const messages = [];
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "auth", version: 1, ...hello }));
  for (let i = 0; i < 100; i++) {
    const ready = messages.find((m) => m.type === "ready");
    if (ready) return { ws, messages };
    if (ws.readyState === WebSocket.CLOSED)
      throw new Error(`Handshake refused on ${path}`);
    await delay(10);
  }
  throw new Error("Handshake timed out");
}
async function until(test) {
  for (let i = 0; i < 100; i++) {
    if (await test()) return;
    await delay(20);
  }
  throw new Error("Condition timeout");
}
try {
  const migration = spawn(process.execPath, ["apps/api/scripts/migrate.mjs"], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: database, DATABASE_SCHEMA: "public" },
    stdio: "pipe",
  });
  let migrationOutput = "";
  migration.stderr.on("data", (v) => (migrationOutput += v));
  const [code] = await once(migration, "exit");
  assert.equal(code, 0, migrationOutput);
  await start();
  const signup = await request("/api/auth/sign-up/email", {
    body: { email, password, name: "Security test" },
    headers: {
      "x-forwarded-for": "203.0.113.99",
      "x-exchange-client-ip": "203.0.113.98",
    },
  });
  assert.equal(signup.status, 200, await signup.clone().text());
  const owner = (await signup.json()).user.id;
  let firstCookie = cookie(signup);
  const secondCookie = await login();
  const third = await request("/api/auth/sign-up/email", {
    body: { email: `other-${email}`, password, name: "Other user" },
  });
  assert.equal(third.status, 200);
  const otherCookie = cookie(third);
  let response = await request("/api/security/events?admin=true", {
    cookie: otherCookie,
  });
  assert.equal(response.status, 403);
  response = await request("/api/security/events", { cookie: otherCookie });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).items.every((e) => e.user_id !== owner));
  response = await request("/api/security/events?before=bad", {
    cookie: firstCookie,
  });
  assert.equal(response.status, 400);
  for (let i = 0; i < 5; i++) {
    response = await request("/api/auth/sign-in/email", {
      body: { email, password: "incorrect-password" },
    });
    assert.ok(response.status >= 400);
  }
  response = await request("/api/points", {
    cookie: firstCookie,
    body: { name: "Test workstation" },
  });
  assert.equal(response.status, 201);
  const point = await response.json();
  const deviceId = "a".repeat(64);
  const agent = await connect("/ws/agent", {
    pointId: point.id,
    key: point.key,
    deviceId,
  });
  let chat = await connect(
    "/ws/browser",
    { pointId: point.id, viewerId: "test-viewer" },
    firstCookie,
  );
  const mediaAgent = await connect("/ws/stream-agent", {
    pointId: point.id,
    key: point.key,
    deviceId,
    encryption: null,
  });
  let media = await connect(
    "/ws/stream-browser",
    { pointId: point.id, viewerId: "test-viewer" },
    firstCookie,
  );
  media.ws.send(JSON.stringify({ type: "browser.watch", active: true }));
  await until(() =>
    mediaAgent.messages.some((m) => m.type === "browser.viewers" && m.active),
  );
  mediaAgent.ws.send(
    JSON.stringify({
      type: "browser.frame",
      tabId: "tab",
      data: "AAAA",
      width: 800,
      height: 600,
    }),
  );
  await until(() => media.messages.some((m) => m.type === "browser.frame"));
  assert.equal(
    (await request("/api/plugins/commercial", { cookie: firstCookie })).status,
    full ? 200 : 404,
  );
  const {
    rows: [created],
  } = await pool.query(
    "SELECT ip,user_agent FROM exchange_audit_event WHERE user_id=$1 AND event='auth.session.created' LIMIT 1",
    [owner],
  );
  assert.equal(
    created.ip,
    "127.0.0.1",
    "spoofed client headers must be ignored",
  );
  const { rows: journal } = await pool.query(
    "SELECT * FROM exchange_audit_event WHERE user_id=$1",
    [owner],
  );
  assert.ok(!JSON.stringify(journal).includes(point.key));
  assert.ok(!JSON.stringify(journal).includes(password));
  if (full) {
    const secondTab = await connect(
      "/ws/browser",
      { pointId: point.id, viewerId: "other-tab" },
      firstCookie,
    );
    const activity = await (
      await request("/api/plugins/sessions", { cookie: secondCookie })
    ).json();
    const target = activity.connections.find(
      (c) => c.kind === "chat" && c.viewerId === "test-viewer",
    );
    assert.ok(target);
    assert.equal(
      (
        await request(`/api/plugins/viewers/${target.id}/disconnect`, {
          cookie: otherCookie,
          method: "POST",
        })
      ).status,
      404,
    );
    const viewerClosed = once(chat.ws, "close"),
      mediaClosed = once(media.ws, "close");
    assert.equal(
      (
        await request(`/api/plugins/viewers/${target.id}/disconnect`, {
          cookie: secondCookie,
          method: "POST",
        })
      ).status,
      200,
    );
    assert.equal((await viewerClosed)[0], 1008);
    assert.equal((await mediaClosed)[0], 1008);
    assert.equal(
      secondTab.ws.readyState,
      WebSocket.OPEN,
      "another tab must remain connected",
    );
    assert.equal(
      (await request("/api/security/events", { cookie: firstCookie })).status,
      200,
      "viewer disconnect must not sign out the device",
    );
    const blocked = new WebSocket(base.replace("http", "ws") + "/ws/browser", {
      headers: { origin: base, cookie: firstCookie },
    });
    sockets.push(blocked);
    await once(blocked, "open");
    const blockedClosed = once(blocked, "close");
    blocked.send(
      JSON.stringify({
        type: "auth",
        version: 1,
        pointId: point.id,
        viewerId: "test-viewer",
      }),
    );
    assert.equal((await blockedClosed)[0], 1008);
    assert.equal(
      (
        await request(`/api/plugins/viewers/access/${point.id}/resume`, {
          cookie: firstCookie,
          body: { viewerId: "test-viewer" },
        })
      ).status,
      200,
    );
    chat = await connect(
      "/ws/browser",
      { pointId: point.id, viewerId: "test-viewer" },
      firstCookie,
    );
    media = await connect(
      "/ws/stream-browser",
      { pointId: point.id, viewerId: "test-viewer" },
      firstCookie,
    );
    media.ws.send(JSON.stringify({ type: "browser.watch", active: true }));
    await delay(30);
    const {
      rows: [sub],
    } = await pool.query(
      "SELECT used_bytes FROM exchange_subscription WHERE user_id=$1",
      [owner],
    );
    assert.ok(Number(sub.used_bytes) > 0);
    // Exhaust media quota; chat must remain available.
    await pool.query(
      "UPDATE exchange_subscription SET used_bytes=included_bytes WHERE user_id=$1",
      [owner],
    );
    const closed = once(media.ws, "close");
    mediaAgent.ws.send(
      JSON.stringify({
        type: "browser.frame",
        tabId: "tab",
        data: "AAAA",
        width: 800,
        height: 600,
      }),
    );
    assert.equal((await closed)[0], 4001);
    assert.equal(chat.ws.readyState, WebSocket.OPEN);
    // Another workspace on the SAME machine is allowed; a different machine exceeds trial.
    response = await request("/api/points", {
      cookie: firstCookie,
      body: { name: "Second workspace" },
    });
    const point2 = await response.json();
    await connect("/ws/agent", {
      pointId: point2.id,
      key: point2.key,
      deviceId,
    });
    response = await request("/api/points", {
      cookie: firstCookie,
      body: { name: "Different computer" },
    });
    const point3 = await response.json();
    const denied = new WebSocket(base.replace("http", "ws") + "/ws/agent");
    sockets.push(denied);
    await once(denied, "open");
    const refused = once(denied, "close");
    denied.send(
      JSON.stringify({
        type: "auth",
        version: 1,
        pointId: point3.id,
        key: point3.key,
        deviceId: "b".repeat(64),
      }),
    );
    assert.equal((await refused)[0], 4001);
    // A different account cannot revoke this owner's sign-in.
    const sessions = await (
      await request("/api/plugins/sessions", { cookie: secondCookie })
    ).json();
    const original = sessions.items.find((s) => !s.current);
    assert.ok(original);
    const foreign = await request(
      `/api/plugins/sessions/${original.id}/revoke`,
      { cookie: otherCookie, method: "POST" },
    );
    assert.equal((await foreign.json()).revoked, 0);
    assert.equal(chat.ws.readyState, WebSocket.OPEN);
    const chatClosed = once(chat.ws, "close");
    response = await request(`/api/plugins/sessions/${original.id}/revoke`, {
      cookie: secondCookie,
      method: "POST",
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).revoked, 1);
    assert.equal((await chatClosed)[0], 1008);
    assert.equal(
      (await request("/api/security/events", { cookie: firstCookie })).status,
      401,
      "revoked cookie must not restore access",
    );
    const remainingViewer = await connect(
      "/ws/browser",
      { pointId: point.id, viewerId: "remaining-viewer" },
      secondCookie,
    );
    const remainingClosed = once(remainingViewer.ws, "close");
    assert.equal(
      (
        await request("/api/plugins/viewers/disconnect-all", {
          cookie: secondCookie,
          method: "POST",
        })
      ).status,
      200,
    );
    assert.equal((await remainingClosed)[0], 1008);
    assert.equal(
      agent.ws.readyState,
      WebSocket.OPEN,
      "disconnecting viewers must leave the computer online",
    );
    // Expiry also stops already connected agents at the periodic check.
    const expiredAgent = once(agent.ws, "close");
    await pool.query(
      "UPDATE exchange_subscription SET period_end=now()-interval '1 second' WHERE user_id=$1",
      [owner],
    );
    const expiryTimeout = setTimeout(() => agent.ws.terminate(), 20_000);
    const [expiryCode] = await expiredAgent;
    clearTimeout(expiryTimeout);
    assert.equal(
      expiryCode,
      4001,
      "expired subscription must close existing agents",
    );
    for (const args of [
      ["plan", owner, "pro"],
      ["traffic", owner, "5"],
    ]) {
      const grant = spawn(
        process.execPath,
        ["private-plugins/commercial/manage.mjs", ...args],
        {
          cwd: root,
          env: { ...process.env, DATABASE_URL: database },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let grantError = "";
      grant.stderr.on("data", (data) => (grantError += data));
      assert.equal((await once(grant, "exit"))[0], 0, grantError);
    }
    const {
      rows: [granted],
    } = await pool.query(
      "SELECT plan,extra_bytes FROM exchange_subscription WHERE user_id=$1",
      [owner],
    );
    assert.equal(granted.plan, "pro");
    assert.equal(Number(granted.extra_bytes), 5_000_000_000);
  } else {
    media.ws.close();
    chat.ws.close();
  }
  await until(async () => {
    const {
      rows: [row],
    } = await pool.query(
      "SELECT count(*)::int AS n FROM exchange_connection WHERE user_id=$1 AND ended_at IS NOT NULL",
      [owner],
    );
    return row.n > 0;
  });
  const history = await (
    await request("/api/security/connections", { cookie: secondCookie })
  ).json();
  assert.ok(history.some((c) => c.ended_at && Number(c.duration_ms) >= 0));
  for (const ws of sockets) ws.terminate();
  await stop();
  // Restart with an explicit administrator; failed anonymous attempts become inspectable.
  await start(owner);
  const warnings = await (
    await request("/api/security/alerts?admin=true", { cookie: secondCookie })
  ).json();
  assert.ok(warnings.repeatedFailures.some((a) => a.attempts >= 5));
  console.log(
    `${full ? "Full" : "Base"} integration passed: migrations, auth metadata, history, tenant isolation, media${full ? ", device quotas, traffic exhaustion and session revocation" : ""}.`,
  );
} finally {
  for (const ws of sockets) ws.terminate();
  await stop();
  await pool.end();
}
