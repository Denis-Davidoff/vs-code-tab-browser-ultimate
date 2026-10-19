import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import type { SleepControl as Control } from './sleepControl.ts';

// Load the same emitted CommonJS modules shipped in the extension, in isolation.
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), 'wake-test-'));
	mkdirSync(join(directory, 'power')); mkdirSync(join(directory, 'core'));
	for (const name of ['power/sleepProtocol', 'power/sleepControl', 'power/sleepDaemon', 'core/fileLock']) {
		const source = readFileSync(resolve('src', `${name}.ts`), 'utf8');
		writeFileSync(join(directory, `${name}.js`), transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText);
	}
	const require = createRequire(join(directory, 'power', 'test.cjs'));
	return { directory, require, close: () => rmSync(directory, { recursive: true, force: true }) };
}
async function until(check: () => boolean): Promise<void> {
	const end = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > end) { assert.fail('Timed out waiting for coordinator'); }
		await new Promise(r => setTimeout(r, 20));
	}
}

test('window timer replacement, expiry, cancellation and delayed subagents', () => {
	const f = fixture();
	const { SleepControl } = f.require('./sleepControl.js') as { SleepControl: typeof Control };
	let working = true;
	const control = new SleepControl(() => working, () => {}, 'Test: no OS assertion');
	try {
		control.choose({ mode: 'timer', minutes: 5 });
		assert.equal(control.state.minutes, 5);
		control.choose({ mode: 'timer', minutes: 4320 });
		assert.equal(control.state.minutes, 4320, '72 hours is available');
		control.choose({ mode: 'timer', minutes: 2880 });
		assert.equal(control.state.minutes, 2880);
		control.choose({ mode: 'timer', minutes: 50 });
		assert.equal(control.state.minutes, 2880, 'unlisted durations are rejected');
		control.state.until = Date.now() - 1;
		control.update();
		assert.equal(control.state.mode, 'off');
		control.choose({ mode: 'agents' });
		// Main agent finished, but working() still includes its child or approval.
		control.update();
		assert.equal(control.state.mode, 'agents');
		working = false;
		const now = Date.now;
		Date.now = () => now() + 1000;
		try { control.update(); } finally { Date.now = now; }
		assert.equal(control.state.mode, 'off');
		control.choose({ mode: 'timer', minutes: 60 });
		control.choose({ mode: 'off' });
		assert.deepEqual(control.state, { mode: 'off', active: false, error: undefined });
	} finally { control.dispose(); f.close(); }
});

test('agents mode scoped to one tab waits on that tab only; window scope on every tab', () => {
	const f = fixture();
	const { SleepControl } = f.require('./sleepControl.js') as { SleepControl: typeof Control };
	const busy = new Set(['a', 'b']);
	const asked: (string | undefined)[] = [];
	const control = new SleepControl(tabId => { asked.push(tabId); return tabId === undefined ? busy.size > 0 : busy.has(tabId); }, () => {}, 'Test: no OS assertion');
	const now = Date.now;
	const later = (fn: () => void) => { Date.now = () => now() + 1000; try { fn(); } finally { Date.now = now; } };
	try {
		control.choose({ mode: 'agents', scope: 'tab', tabId: '' });
		assert.equal(control.state.mode, 'off', 'a tab scope needs a tab');
		control.choose({ mode: 'agents', scope: 'window', tabId: 'a' } as never);
		assert.equal(control.state.mode, 'off', 'a window scope names no tab');
		control.choose({ mode: 'agents', scope: 'tab', tabId: 'a' });
		assert.deepEqual([control.state.scope, control.state.tabId], ['tab', 'a']);
		busy.delete('a');
		later(() => control.update());
		assert.equal(control.state.mode, 'off', 'tab a finished while b still works');
		assert.equal(asked.at(-1), 'a');
		control.choose({ mode: 'agents' });
		assert.equal(control.state.scope, 'window', 'no scope reads as the window');
		later(() => control.update());
		assert.equal(control.state.mode, 'agents', 'b still works');
		assert.equal(asked.at(-1), undefined);
		busy.delete('b');
		later(() => control.update());
		assert.equal(control.state.mode, 'off');
	} finally { control.dispose(); f.close(); }
});

test('all platforms request system sleep prevention while allowing display sleep', () => {
	const f = fixture();
	try {
		const { inhibitorCommand } = f.require('./sleepDaemon.js');
		assert.deepEqual(inhibitorCommand('darwin', 123).args, ['-i', '-w', '123']);
		assert.ok(inhibitorCommand('linux', 123).args.includes('--what=sleep'));
		const windows = inhibitorCommand('win32', 123).args.join(' ');
		assert.ok(windows.includes('2147483649')); // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
		assert.ok(windows.includes('2147483648')); // release assertion
	} finally { f.close(); }
});

test('two windows share one assertion and release only after the last disconnect', async () => {
	const f = fixture();
	const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\wake-test-${process.pid}` : join(f.directory, 'test.sock');
	const log = join(f.directory, 'inhibitor.log');
	const helper = join(f.directory, 'helper.cjs');
	writeFileSync(helper, `const fs = require('fs'); fs.appendFileSync(${JSON.stringify(log)}, 'start\\n'); console.log('READY'); process.stdin.resume(); process.stdin.on('end', () => { fs.appendFileSync(${JSON.stringify(log)}, 'stop\\n'); process.exit(0); });`);
	const runner = join(f.directory, 'runner.cjs');
	writeFileSync(runner, `const {spawn}=require('child_process'); require('./power/sleepDaemon.js').runSleepDaemon(${JSON.stringify(endpoint)}, () => spawn(process.execPath, [${JSON.stringify(helper)}], {stdio:['pipe','pipe','pipe']}));`);
	const daemon: ChildProcess = spawn(process.execPath, [runner], { stdio: 'ignore' });
	const sockets: Socket[] = [];
	const events: { active: boolean; error?: string }[] = [];
	const lines = () => existsSync(log) ? readFileSync(log, 'utf8') : '';
	try {
		if (process.platform !== 'win32') { await until(() => existsSync(endpoint)); }
		else { await new Promise(r => setTimeout(r, 300)); }
		for (let i = 0; i < 2; i++) {
			const socket = connect(endpoint); sockets.push(socket);
			let buffer = '';
			socket.on('data', chunk => {
				buffer += String(chunk);
				let n: number;
				while ((n = buffer.indexOf('\n')) >= 0) { events.push(JSON.parse(buffer.slice(0, n))); buffer = buffer.slice(n + 1); }
			});
			await once(socket, 'connect'); socket.write('true\n');
		}
		await until(() => events.some(e => e.active));
		await until(() => lines().includes('start'));
		assert.equal(lines().split('start').length - 1, 1);
		sockets[0].write('false\n');
		await new Promise(r => setTimeout(r, 80));
		assert.ok(!lines().includes('stop'), 'turning off one window retains the assertion');
		sockets[1].destroy();
		if (process.platform !== 'darwin') { await until(() => lines().includes('stop')); }
		await until(() => events.at(-1)?.active === false);
		assert.equal(lines().split('start').length - 1, 1);
	} finally {
		for (const socket of sockets) { socket.destroy(); }
		if (daemon.exitCode === null && daemon.signalCode === null) { const exited = once(daemon, 'exit'); daemon.kill(); await exited; }
		f.close();
	}
});
