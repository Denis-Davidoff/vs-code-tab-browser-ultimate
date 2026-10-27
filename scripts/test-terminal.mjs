// Real-PTY smoke test of the chat's terminal host: compiled src/terminal/terminalHost.js against the
// node-pty that scripts/stage-terminal.mjs staged. Manual — `npm run build-ext` first, then
// `node scripts/test-terminal.mjs`. Runs on macOS and Windows, and says so and stops where node-pty
// has no backend (Linux), which is what the extension does too.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const hostPath = fileURLToPath(
  new URL("../out/terminal/terminalHost.js", import.meta.url),
);
let host;
try {
  host = require(hostPath);
} catch (error) {
  console.error(
    "test-terminal: out/terminal/terminalHost.js is missing; run npm run build-ext first.\n" +
      error.message,
  );
  process.exit(1);
}
const { TerminalHost, resolveShell, scrubEnv, terminalAvailability } = host;

const availability = terminalAvailability();
if (!availability.ok) {
  console.log("test-terminal: skipped. " + availability.reason);
  process.exit(0);
}

const windows = process.platform === "win32";
const folder = mkdtempSync(join(tmpdir(), "ai-browser-terminal-"));
const terminals = new TerminalHost();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A shell with its output gathered. `/bin/sh` and `cmd.exe` give prompts and echo that do not depend on anyone's dotfiles. */
function open(options = {}) {
  const shell = options.shell ?? (windows ? { file: process.env.COMSPEC ?? "cmd.exe", args: [] } : { file: "/bin/sh", args: [] });
  const state = { text: "", chunks: [], exited: false, code: undefined };
  state.session = terminals.create({
    file: shell.file,
    args: shell.args,
    cwd: folder,
    env: scrubEnv(process.env, { PS1: "$ ", ...(options.env ?? {}) }),
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    onData: (chunk, seq) => {
      state.text += chunk;
      state.chunks.push({ chunk, seq });
      if (options.ack !== false) state.session.ack(chunk.length);
    },
    onExit: (code) => {
      state.exited = true;
      state.code = code;
    },
    ackHigh: options.ackHigh,
    ackLow: options.ackLow,
  });
  return state;
}

async function waitFor(what, test, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return;
    await sleep(25);
  }
  throw new Error("timed out waiting for " + what);
}

let failures = 0;
async function check(name, body) {
  const started = Date.now();
  try {
    await body();
    console.log("  ok   " + name + " (" + (Date.now() - started) + " ms)");
  } catch (error) {
    failures++;
    console.log("  FAIL " + name + "\n       " + (error.stack ?? error));
  }
}

console.log("test-terminal: " + process.platform + "-" + process.arch + ", shell in " + folder);

await check("runs a command and delivers its output", async () => {
  const t = open();
  t.session.write(windows ? "echo MARK-%CD:~0,0%42\r" : "echo MARK-$((40+2))\n");
  await waitFor("MARK-42", () => t.text.includes("MARK-42"));
  t.session.dispose();
});

await check("the environment is scrubbed and the terminal identity set", async () => {
  process.env.AI_BROWSER_MCP_AUTH = "Bearer should-not-reach-the-shell";
  process.env.ELECTRON_RUN_AS_NODE = "1";
  const t = open();
  t.session.write(
    windows
      ? "echo T=%TERM% E=%ELECTRON_RUN_AS_NODE% A=%AI_BROWSER_MCP_AUTH% TP=%TERM_PROGRAM%\r"
      : 'echo "T=$TERM E=${ELECTRON_RUN_AS_NODE-unset} A=${AI_BROWSER_MCP_AUTH-unset} TP=$TERM_PROGRAM"\n',
  );
  await waitFor("env line", () => /T=xterm-256color E=\S+ A=\S+ TP=ai-browser/.test(t.text));
  assert.ok(/E=(unset|%ELECTRON_RUN_AS_NODE%)/.test(t.text), "ELECTRON_RUN_AS_NODE leaked: " + t.text);
  assert.ok(!t.text.includes("should-not-reach-the-shell"), "token leaked");
  t.session.dispose();
});

if (!windows) {
  await check("UTF-8 survives, astral characters whole", async () => {
    const t = open();
    t.session.write("printf '\\360\\237\\230\\200 caf\\303\\251 %s\\n' END\n");
    await waitFor("emoji line", () => t.text.includes("\u{1F600} café END"));
    for (const { chunk } of t.chunks) {
      assert.ok(!/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk), "a chunk splits a pair");
    }
    t.session.dispose();
  });

  await check("resize reaches the shell, clamped", async () => {
    const t = open({ cols: 80, rows: 24 });
    t.session.write("stty size\n");
    await waitFor("initial size", () => /\n24 80\r?\n/.test(t.text));
    t.session.resize(120, 31);
    t.session.write("stty size\n");
    await waitFor("new size", () => /\n31 120\r?\n/.test(t.text));
    t.session.resize(5000, 5000);
    t.session.write("stty size\n");
    await waitFor("clamped size", () => /\n200 500\r?\n/.test(t.text));
    t.session.dispose();
  });
}

await check("Ctrl+C interrupts a running command and the shell lives on", async () => {
  const t = open();
  t.session.write(windows ? "ping -n 60 127.0.0.1 > nul\r" : "sleep 60\n");
  await sleep(600);
  t.session.write("\x03");
  await sleep(300);
  t.session.write(windows ? "echo ALIVE-%CD:~0,0%2\r" : "echo ALIVE-$((1+1))\n");
  await waitFor("ALIVE-2", () => t.text.includes("ALIVE-2"));
  assert.equal(t.exited, false);
  t.session.dispose();
});

await check("replay holds the delivered output and ends at the last seq", async () => {
  const t = open();
  t.session.write(windows ? "echo REPLAY-%CD:~0,0%7\r" : "echo REPLAY-$((3+4))\n");
  await waitFor("REPLAY-7", () => t.text.includes("REPLAY-7"));
  await sleep(50);
  const replay = t.session.replay();
  assert.ok(replay.data.includes("REPLAY-7"));
  assert.equal(replay.seq, t.chunks[t.chunks.length - 1].seq);
  assert.equal(replay.seq, t.text.length);
  t.session.dispose();
});

if (!windows) {
  await check("backpressure: an unacknowledged view stops the shell, acknowledging lets it finish", async () => {
    const high = 200 * 1024;
    const t = open({ ack: false, ackHigh: high, ackLow: 50 * 1024 });
    t.session.write("head -c 6000000 /dev/zero | tr '\\0' x; echo; echo FINISHED-$((2+3))\n");
    await sleep(1500);
    assert.ok(t.text.length > high, "nothing arrived: " + t.text.length);
    assert.ok(
      t.text.length < 2 * 1024 * 1024,
      "kept reading past the high mark: " + t.text.length + " units",
    );
    const stalled = t.text.length;
    await sleep(400);
    assert.equal(t.text.length, stalled, "still reading while paused");
    // acknowledge as the view would, as fast as it likes
    const timer = setInterval(() => {
      t.session.ack(t.text.length);
    }, 5);
    try {
      await waitFor("the end of the output", () => t.text.includes("FINISHED-5"), 30000);
    } finally {
      clearInterval(timer);
    }
    assert.ok(t.text.length > 6000000, "output lost: " + t.text.length);
    t.session.dispose();
  });
}

await check("the exit code is reported after the last output", async () => {
  const t = open();
  t.session.write(windows ? "echo BYE-%CD:~0,0%1 & exit 7\r" : "echo BYE-$((0+1)); exit 7\n");
  await waitFor("exit", () => t.exited);
  assert.equal(t.code, 7);
  assert.ok(t.text.includes("BYE-1"), "output after the exit or lost: " + JSON.stringify(t.text));
  assert.equal(t.session.exited, true);
  t.session.write("ignored\n");
  t.session.resize(100, 40);
  t.session.dispose();
});

await check("the user's own login shell starts and answers", async () => {
  const shell = resolveShell(process.platform, process.env, {});
  const t = open({ shell });
  await sleep(300);
  t.session.write(windows ? "echo LOGIN-%CD:~0,0%OK\r" : "echo LOGIN-$((1+1))-OK\n");
  await waitFor("LOGIN answer", () => /LOGIN-(2-)?OK/.test(t.text.replace("LOGIN-$((1+1))-OK", "")), 20000);
  t.session.dispose();
});

if (!windows) {
  await check("dispose takes the shell's jobs with it", async () => {
    const t = open();
    t.session.write("sleep 31337 &\n");
    t.session.write("sleep 31338\n");
    await sleep(1000);
    const alive = () => {
      try {
        return execFileSync("pgrep", ["-f", "sleep 3133[78]"], { encoding: "utf8" }).trim().length > 0;
      } catch {
        return false;
      }
    };
    assert.ok(alive(), "the sleeps never started");
    t.session.dispose();
    const end = Date.now() + 6000;
    while (Date.now() < end && alive()) await sleep(100);
    assert.ok(!alive(), "a sleep outlived dispose");
    assert.equal(t.exited, false, "exit reported after dispose");
  });
}

// ---------------------------------------------------------------------------------------------
// The host-side screen an agent reads (terminal_read / terminal_wait): the real emulator behind a real PTY.
// ---------------------------------------------------------------------------------------------

await check("the compiled build loads the staged headless emulator", async () => {
  const t = open();
  assert.equal(t.session.screenDegraded, false, "reads would be degraded: out/terminal/vendor/xterm-headless is missing (run npm run build-ext)");
  const staged = Object.keys(require.cache).filter((k) => k.includes("xterm-headless"));
  assert.ok(staged.some((k) => k.includes("vendor")), "not the staged copy: " + staged);
  t.session.dispose();
});

if (!windows) {
  await check("readScreen: a redrawn \\r line is its last drawing, and the command's own echo is not output", async () => {
    const t = open();
    t.session.write("printf 'PROG-%s\\rPROG-%s\\n' 1 2\n");
    const done = await t.session.waitFor({ until: "text", text: "PROG-2", timeoutMs: 8000 });
    assert.equal(done.reason, "text");
    const read = await t.session.readScreen();
    assert.ok(read.text.includes("PROG-2"), read.text);
    assert.ok(!read.text.includes("PROG-1"), read.text);
    assert.equal(read.state.status, "running");
    assert.equal(read.state.degraded, undefined);
    t.session.dispose();
  });

  await check("waitFor idle after a command, then a since read holds only what came after the cursor", async () => {
    const t = open();
    await t.session.waitFor({ until: "idle", quietMs: 400, timeoutMs: 8000 });
    const first = await t.session.readScreen();
    t.session.write("echo SINCE-$((20+22))\n");
    const idle = await t.session.waitFor({ until: "idle", quietMs: 400, timeoutMs: 8000, since: first.cursor });
    assert.equal(idle.reason, "idle");
    assert.ok(idle.text.includes("SINCE-42"), idle.text);
    const later = await t.session.readScreen({ since: idle.cursor });
    assert.ok(!later.text.includes("SINCE-42"), "a since read repeated what the cursor had already seen: " + later.text);
    t.session.dispose();
  });

  await check("waitFor text sees what the command prints, not its echo", async () => {
    const t = open();
    t.session.write("sleep 0.5; echo DONE-$((2+3))\n");
    const done = await t.session.waitFor({ until: "text", text: "DONE-5", timeoutMs: 8000 });
    assert.equal(done.reason, "text");
    assert.ok(done.text.includes("DONE-5"));
    t.session.dispose();
  });

  await check("a command wait on a shell that reports nothing falls back to idle", async () => {
    const t = open();
    t.session.write("echo FALLBACK-$((1+1))\n");
    const done = await t.session.waitFor({ until: "command", quietMs: 400, timeoutMs: 8000 });
    assert.equal(done.reason, "idle");
    assert.equal(done.state.integration, "none");
    assert.ok(done.text.includes("FALLBACK-2"));
    t.session.dispose();
  });

  await check("the alternate screen reads as the viewport and flags it, and the main screen returns", async () => {
    const t = open();
    t.session.write("printf '\\033[?1049h\\033[HALT-FRAME'\n");
    const inAlt = await t.session.waitFor({ until: "text", text: "ALT-FRAME", timeoutMs: 8000 });
    const alt = await t.session.readScreen({ scrollback: true });
    assert.equal(alt.state.altScreen, true, inAlt.text);
    assert.ok(alt.text.includes("ALT-FRAME") && !alt.text.includes("printf"), alt.text);
    t.session.write("printf '\\033[?1049lBACK-%s\\n' 1\n");
    await t.session.waitFor({ until: "text", text: "BACK-1", timeoutMs: 8000 });
    assert.equal((await t.session.readScreen()).state.altScreen, false);
    t.session.dispose();
  });

  await check("the screen follows the PTY's size", async () => {
    const t = open({ cols: 80, rows: 24 });
    t.session.resize(100, 30);
    const read = await t.session.readScreen();
    assert.equal(read.state.cols, 100);
    assert.equal(read.state.rows, 30);
    t.session.dispose();
  });

  for (const [name, file, args] of [
    ["zsh", "/bin/zsh", ["-f"]],
    ["bash", "/bin/bash", ["--norc", "--noprofile"]],
  ]) {
    if (!existsSync(file)) continue;
    await check(`a real ${name}: a command, its screen, its exit`, async () => {
      const t = open({ shell: { file, args } });
      await t.session.waitFor({ until: "idle", quietMs: 500, timeoutMs: 15000 });
      const first = await t.session.readScreen();
      t.session.write("echo REAL-$((6*7))\n");
      const done = await t.session.waitFor({ until: "text", text: "REAL-42", since: first.cursor, timeoutMs: 8000 });
      assert.equal(done.reason, "text");
      assert.ok(done.state.cwd === undefined || typeof done.state.cwd === "string");
      t.session.write("exit 3\n");
      const ended = await t.session.waitFor({ until: "idle", quietMs: 60000, timeoutMs: 8000 });
      assert.equal(ended.reason, "exit");
      assert.equal(ended.state.status, "exited");
      assert.equal(ended.state.exitCode, 3);
      assert.ok((await t.session.readScreen({ scrollback: true })).text.includes("REAL-42"), "the final screen is not readable after the exit");
      t.session.dispose();
    });
  }

  await check("30 MB of output acknowledged at once: only the emulator bounds the shell, and it keeps up, the shell is not lost, the screen reads", async () => {
    const t = open();
    t.session.write("yes 'flood line of some length, 0123456789' | head -c 30000000; echo; echo FLOOD-END-$((2*3))\n");
    const done = await t.session.waitFor({ until: "text", text: "FLOOD-END-6", timeoutMs: 60000 });
    assert.equal(done.reason, "text");
    assert.equal(t.session.screenDegraded, false, "the emulator failed under load");
    const all = await t.session.readScreen({ scrollback: true });
    assert.ok(all.text.split("\n").length <= 500, "the read was not capped");
    assert.ok(all.text.length <= 12000, "the read was not capped in characters");
    assert.equal(all.truncated, true);
    t.session.dispose();
  });
}

terminals.dispose();
rmSync(folder, { recursive: true, force: true });
if (failures > 0) {
  console.log("test-terminal: " + failures + " failed");
  process.exit(1);
}
console.log("test-terminal: all passed");
process.exit(0);
