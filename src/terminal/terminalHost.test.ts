/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import {
	TerminalHost, TerminalSession, plainText, resolveShell, safeTailStart, scrubEnv, terminalAvailability,
} from './terminalHost.ts';
import type { PtyProcess, PtySpawn } from './terminalHost.ts';
import { createScreenModel } from './screenModel.ts';

class FakePty implements PtyProcess {
	dataCb: ((data: string) => void) | undefined;
	exitCb: ((e: { exitCode: number }) => void) | undefined;
	written: string[] = [];
	sizes: Array<[number, number]> = [];
	paused = 0;
	resumed = 0;
	killed = 0;
	onData(cb: (data: string) => void): void { this.dataCb = cb; }
	onExit(cb: (e: { exitCode: number }) => void): void { this.exitCb = cb; }
	write(data: string): void { this.written.push(data); }
	resize(cols: number, rows: number): void { this.sizes.push([cols, rows]); }
	pause(): void { this.paused++; }
	resume(): void { this.resumed++; }
	kill(): void { this.killed++; }
	emit(data: string): void { this.dataCb?.(data); }
	exit(exitCode: number): void { this.exitCb?.({ exitCode }); }
}

interface Rig {
	pty: FakePty;
	session: TerminalSession;
	chunks: Array<{ chunk: string; seq: number }>;
	exits: Array<number | undefined>;
}

function rig(options: { batchMs?: number; maxBatch?: number; tailBytes?: number; ackHigh?: number; ackLow?: number } = {}): Rig {
	const pty = new FakePty();
	const chunks: Array<{ chunk: string; seq: number }> = [];
	const exits: Array<number | undefined> = [];
	const session = new TerminalSession(pty, {
		onData: (chunk, seq) => chunks.push({ chunk, seq }),
		onExit: code => exits.push(code),
		batchMs: 5,
		...options,
	});
	return { pty, session, chunks, exits };
}

const later = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const joined = (r: Rig) => r.chunks.map(c => c.chunk).join('');

suite('TerminalSession output', () => {
	test('batches what arrives within the window into one chunk, in order', async () => {
		const r = rig();
		r.pty.emit('a'); r.pty.emit('b'); r.pty.emit('c');
		assert.strictEqual(r.chunks.length, 0);
		await later(40);
		assert.deepStrictEqual(r.chunks, [{ chunk: 'abc', seq: 3 }]);
		r.pty.emit('de');
		await later(40);
		assert.deepStrictEqual(r.chunks.map(c => c.seq), [3, 5]);
		r.session.dispose();
	});

	test('a batch that reaches maxBatch goes out at once, in slices of at most maxBatch', () => {
		const r = rig({ maxBatch: 10, batchMs: 10_000 });
		r.pty.emit('x'.repeat(25));
		assert.deepStrictEqual(r.chunks.map(c => c.chunk.length), [10, 10, 5]);
		assert.deepStrictEqual(r.chunks.map(c => c.seq), [10, 20, 25]);
		r.session.dispose();
	});

	test('never cuts a surrogate pair in two when slicing', () => {
		const r = rig({ maxBatch: 4, batchMs: 10_000 });
		// "abc" + a pair puts the pair's halves at the cut (index 3 and 4)
		const input = 'abc\u{1F600}def\u{1F600}\u{1F600}\u{1F600}';
		r.pty.emit(input);
		for (const { chunk } of r.chunks) {
			assert.ok(chunk.length <= 5);
			assert.ok(!/[\uD800-\uDBFF]$/.test(chunk), JSON.stringify(chunk) + ' ends in a high surrogate');
			assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk), JSON.stringify(chunk) + ' starts with a low surrogate');
		}
		assert.strictEqual(joined(r), input);
		r.session.dispose();
	});

	test('a maxBatch of 1 still takes a pair whole', () => {
		const r = rig({ maxBatch: 1, batchMs: 10_000 });
		r.pty.emit('\u{1F600}a');
		assert.deepStrictEqual(r.chunks.map(c => c.chunk), ['\u{1F600}', 'a']);
		r.session.dispose();
	});

	test('a pair whose second half comes later is held once and delivered whole', async () => {
		const r = rig({ batchMs: 50 });
		r.pty.emit('hi\uD83D');
		await later(70);
		assert.strictEqual(joined(r), 'hi');
		r.pty.emit('\uDE00!');
		await later(100);
		assert.strictEqual(joined(r), 'hi\u{1F600}!');
		r.session.dispose();
	});

	test('a lone high surrogate that never completes is delivered at the next flush and at exit', async () => {
		const r = rig();
		r.pty.emit('x\uD83D');
		await later(60);
		assert.strictEqual(joined(r), 'x\uD83D');
		r.session.dispose();
		const e = rig();
		e.pty.emit('y\uD83D');
		e.pty.exit(0);
		assert.strictEqual(joined(e), 'y\uD83D');
	});

	test('seq is cumulative and the replay ends at the last delivered unit', async () => {
		const r = rig();
		r.pty.emit('one\n');
		await later(30);
		r.pty.emit('two\n');
		assert.deepStrictEqual(r.session.replay(), { data: 'one\n', seq: 4 }, 'pending output is not in the replay');
		await later(30);
		assert.deepStrictEqual(r.session.replay(), { data: 'one\ntwo\n', seq: 8 });
		r.session.dispose();
	});
});

suite('TerminalSession tail', () => {
	test('keeps at most tailBytes and starts after a line break when one is near', () => {
		const r = rig({ tailBytes: 100, maxBatch: 1000, batchMs: 10_000 });
		let text = '';
		for (let i = 0; i < 40; i++) {
			text += 'line number ' + String(i).padStart(2, '0') + '\n';
		}
		r.pty.emit(text);
		r.pty.exit(0);
		const replay = r.session.replay();
		assert.ok(replay.data.length <= 100);
		assert.ok(replay.data.length > 50);
		assert.ok(/^line number \d\d\n/.test(replay.data), JSON.stringify(replay.data.slice(0, 20)));
		assert.ok(text.endsWith(replay.data));
		assert.strictEqual(replay.seq, text.length);
	});

	test('does not start inside a surrogate pair', () => {
		const text = 'ab\u{1F600}\u{1F600}\u{1F600}';
		// cut between the halves of the first pair (index 3)
		const start = safeTailStart(text, 3);
		assert.ok(start >= 4);
		assert.ok(!/^[\uDC00-\uDFFF]/.test(text.slice(start)));
	});

	test('does not start inside an escape sequence', () => {
		const text = 'before\x1b[38;5;123mcolour\x1b[0m rest of the line without a break at all';
		const inside = text.indexOf('5;123') ;
		const start = safeTailStart(text, inside);
		assert.strictEqual(text.slice(start).startsWith('colour'), true);
		const osc = 'x\x1b]0;a window title\x07after';
		assert.strictEqual(osc.slice(safeTailStart(osc, 6)).startsWith('after'), true);
		const st = 'x\x1b]8;;http://e.x\x1b\\link';
		assert.strictEqual(st.slice(safeTailStart(st, 6)).startsWith('link'), true);
	});

	test('a cut at the start of a sequence or a line is left where it is', () => {
		const text = 'aaa\nbbb\x1b[1mccc';
		assert.strictEqual(safeTailStart(text, 4), 4);
		assert.strictEqual(safeTailStart(text, 7), 7);
		assert.strictEqual(safeTailStart(text, 0), 0);
		assert.strictEqual(safeTailStart(text, 999), text.length);
	});

	test('a tail with no line break near still starts on a safe point', () => {
		const text = ('\x1b[31mred\x1b[0m ').repeat(200);
		const start = safeTailStart(text, 301);
		const rest = text.slice(start);
		// The cut (index 301) falls inside the CSI `\x1b[31m` that begins at 299 (13 units a repeat): it moves forward to the
		// first unit after the sequence, never back, so the tail stays within its budget and begins on the word.
		assert.strictEqual(start, 23 * 13 + 5);
		assert.ok(rest.startsWith('red\x1b[0m '), JSON.stringify(rest.slice(0, 12)));
		assert.ok(start >= 301);
	});
});

suite('TerminalSession flow control', () => {
	test('pauses above the high mark and resumes below the low mark', () => {
		const r = rig({ ackHigh: 100, ackLow: 20, maxBatch: 50, batchMs: 10_000 });
		r.pty.emit('x'.repeat(50));
		assert.strictEqual(r.pty.paused, 0);
		r.pty.emit('x'.repeat(50));
		assert.strictEqual(r.pty.paused, 0, '100 is not above 100');
		r.pty.emit('x'.repeat(50));
		assert.strictEqual(r.pty.paused, 1);
		r.pty.emit('x'.repeat(50));
		assert.strictEqual(r.pty.paused, 1, 'paused once');
		r.session.ack(100);
		assert.strictEqual(r.pty.resumed, 0, '100 outstanding is still above the low mark');
		r.session.ack(81);
		assert.strictEqual(r.pty.resumed, 1);
		r.session.ack(10_000);
		assert.strictEqual(r.pty.resumed, 1, 'once');
		r.session.dispose();
	});

	test('an ack larger than what is outstanding clamps to zero and bad numbers are ignored', async () => {
		const r = rig({ ackHigh: 10, ackLow: 2, batchMs: 1 });
		r.pty.emit('y'.repeat(50));
		await later(15);
		assert.strictEqual(r.pty.paused, 1);
		r.session.ack(-5); r.session.ack(NaN); r.session.ack(0);
		assert.strictEqual(r.pty.resumed, 0);
		r.session.ack(1e9);
		assert.strictEqual(r.pty.resumed, 1);
		r.pty.emit('z'.repeat(5));
		await later(15);
		r.session.ack(3);
		// the huge ack left nothing outstanding, then 5 arrived and 3 were acknowledged: 2, not negative
		r.pty.emit('z'.repeat(9));
		await later(15);
		assert.strictEqual(r.pty.paused, 2, '2 + 9 = 11 is above 10 again');
		r.session.dispose();
	});

	test('resetAck lets a paused shell read again', async () => {
		const r = rig({ ackHigh: 10, ackLow: 2, batchMs: 1 });
		r.pty.emit('y'.repeat(50));
		await later(15);
		assert.strictEqual(r.pty.paused, 1);
		r.session.resetAck();
		assert.strictEqual(r.pty.resumed, 1);
		r.session.dispose();
	});
});

suite('TerminalSession lifetime', () => {
	test('flushes the pending batch before reporting the exit, then ignores late data', async () => {
		const r = rig({ batchMs: 10_000 });
		const order: string[] = [];
		const pty = new FakePty();
		const session = new TerminalSession(pty, { onData: chunk => order.push('data:' + chunk), onExit: code => order.push('exit:' + code), batchMs: 10_000 });
		pty.emit('last words');
		pty.exit(3);
		pty.emit('too late');
		assert.deepStrictEqual(order, ['data:last words', 'exit:3']);
		assert.strictEqual(session.exited, true);
		assert.strictEqual(session.exitCode, 3);
		pty.exit(4);
		assert.deepStrictEqual(order, ['data:last words', 'exit:3'], 'one exit');
		r.session.dispose();
		session.dispose();
		assert.strictEqual(pty.killed, 0, 'an ended shell is not killed');
	});

	test('write and resize are ignored after the exit', () => {
		const r = rig();
		r.session.write('a');
		r.session.resize(80, 24);
		r.pty.exit(0);
		r.session.write('b');
		r.session.resize(100, 30);
		assert.deepStrictEqual(r.pty.written, ['a']);
		assert.deepStrictEqual(r.pty.sizes, [[80, 24]]);
	});

	test('write ignores empty, oversized and non-string input', () => {
		const r = rig();
		r.session.write('');
		r.session.write('x'.repeat((1 << 20) + 1));
		r.session.write(5 as unknown as string);
		r.session.write('ok');
		assert.deepStrictEqual(r.pty.written, ['ok']);
		r.session.dispose();
	});

	test('resize clamps, floors, skips what has not changed and ignores non-numbers', () => {
		const r = rig();
		r.session.resize(80.9, 24.2);
		r.session.resize(80, 24);
		r.session.resize(1, 0);
		r.session.resize(9999, 9999);
		r.session.resize(NaN, 10);
		r.session.resize(Infinity, 10);
		r.session.resize(-3, -3);
		assert.deepStrictEqual(r.pty.sizes, [[80, 24], [2, 1], [500, 200], [2, 1]]);
		r.session.dispose();
	});

	test('dispose kills once, delivers nothing more and is idempotent', async () => {
		const r = rig({ batchMs: 5 });
		r.pty.emit('pending');
		r.session.dispose();
		r.session.dispose();
		r.pty.emit('more');
		r.pty.exit(0);
		await later(30);
		assert.strictEqual(r.pty.killed, 1);
		assert.deepStrictEqual(r.chunks, []);
		assert.deepStrictEqual(r.exits, []);
		r.session.write('x');
		assert.deepStrictEqual(r.pty.written, []);
	});

	test('a throwing callback does not stop the reader', async () => {
		const pty = new FakePty();
		let calls = 0;
		const session = new TerminalSession(pty, { onData: () => { calls++; throw new Error('view gone'); }, onExit: () => { throw new Error('view gone'); }, batchMs: 1 });
		pty.emit('a');
		await later(20);
		pty.emit('b');
		await later(20);
		pty.exit(0);
		assert.strictEqual(calls, 2);
		assert.strictEqual(session.exited, true);
	});

	test('pty errors from pause, resume, write and resize are contained', () => {
		const pty = new FakePty();
		pty.pause = () => { throw new Error('closed'); };
		pty.resume = () => { throw new Error('closed'); };
		pty.write = () => { throw new Error('closed'); };
		pty.resize = () => { throw new Error('closed'); };
		const session = new TerminalSession(pty, { onData: () => { }, onExit: () => { }, ackHigh: 1, ackLow: 0, maxBatch: 10, batchMs: 10_000 });
		pty.emit('xxxxxx');
		session.ack(100);
		session.write('a');
		session.resize(80, 24);
		session.dispose();
	});
});

suite('TerminalHost', () => {
	const spawnOptions: PtySpawn = { file: '/bin/sh', args: ['-l'], cwd: '/tmp', env: { A: 'b' }, cols: 9999, rows: 0 };

	test('spawns through the loader with clamped size and returns a live session', () => {
		const pty = new FakePty();
		let seen: PtySpawn | undefined;
		const host = new TerminalHost(() => ({ spawn: o => { seen = o; return pty; } }));
		const chunks: string[] = [];
		const session = host.create({ ...spawnOptions, onData: c => chunks.push(c), onExit: () => { }, batchMs: 1 });
		assert.deepStrictEqual(seen, { file: '/bin/sh', args: ['-l'], cwd: '/tmp', env: { A: 'b' }, cols: 500, rows: 1 });
		pty.emit('hi');
		pty.exit(0);
		assert.deepStrictEqual(chunks, ['hi']);
		assert.strictEqual(session.exited, true);
		host.dispose();
	});

	test('a spawn failure is a readable Error', () => {
		const host = new TerminalHost(() => ({ spawn: () => { throw new Error('posix_spawnp failed.'); } }));
		assert.throws(() => host.create({ ...spawnOptions, onData: () => { }, onExit: () => { } }), /Could not start \/bin\/sh in \/tmp: posix_spawnp failed\. \(check that the shell and the folder exist\)/);
	});

	test('a loader that cannot load is a readable Error', () => {
		const host = new TerminalHost(() => { throw new Error('boom'); });
		assert.throws(() => host.create({ ...spawnOptions, onData: () => { }, onExit: () => { } }), /Could not start/);
	});

	test('dispose kills every live session and refuses new ones', () => {
		const ptys: FakePty[] = [];
		const host = new TerminalHost(() => ({ spawn: () => { const p = new FakePty(); ptys.push(p); return p; } }));
		const a = host.create({ ...spawnOptions, onData: () => { }, onExit: () => { } });
		host.create({ ...spawnOptions, onData: () => { }, onExit: () => { } });
		a.dispose();
		host.dispose();
		assert.deepStrictEqual(ptys.map(p => p.killed), [1, 1]);
		assert.throws(() => host.create({ ...spawnOptions, onData: () => { }, onExit: () => { } }), /shut down/);
	});
});

suite('terminalAvailability', () => {
	const ok = () => ({ spawn: () => new FakePty() });

	test('Linux has no prebuilt backend, and says so', () => {
		const a = terminalAvailability('linux', 'x64', ok);
		assert.strictEqual(a.ok, false);
		assert.match(a.reason ?? '', /Linux/);
		assert.match(a.reason ?? '', /prebuilt/);
	});

	test('an architecture with no prebuild is named', () => {
		const a = terminalAvailability('win32', 'ia32', ok);
		assert.strictEqual(a.ok, false);
		assert.match(a.reason ?? '', /win32 \(ia32\)/);
		assert.strictEqual(terminalAvailability('freebsd', 'x64', ok).ok, false);
	});

	test('macOS and Windows with a loadable backend are available', () => {
		for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'], ['win32', 'arm64']] as const) {
			assert.deepStrictEqual(terminalAvailability(platform, arch, ok), { ok: true });
		}
	});

	test('a backend that fails to load names the failure', () => {
		const a = terminalAvailability('darwin', 'arm64', () => { throw new Error('Cannot find module x'); });
		assert.strictEqual(a.ok, false);
		assert.match(a.reason ?? '', /could not be loaded: Cannot find module x/);
	});
});

suite('scrubEnv', () => {
	const env = {
		HOME: '/Users/me', PATH: '/usr/bin', SHELL: '/bin/zsh', LANG: 'en_GB.UTF-8',
		VSCODE_IPC_HOOK_CLI: '/x', VSCODE_PID: '1', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1',
		NODE_OPTIONS: '--x', AI_BROWSER_MCP_AUTH: 'Bearer secret', AI_BROWSER_MCP_TAB: 'tab-1',
		CLAUDECODE: '1', TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.140', TERM: 'dumb', COLORTERM: '',
	};

	test('drops what only the editor or the chat should hold and sets the terminal identity', () => {
		const out = scrubEnv(env, {}, 'darwin');
		assert.deepStrictEqual(out, { HOME: '/Users/me', PATH: '/usr/bin', SHELL: '/bin/zsh', LANG: 'en_GB.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'ai-browser' });
	});

	test('extra comes last and can put a dropped variable back on purpose', () => {
		const out = scrubEnv(env, { AI_BROWSER_MCP_AUTH: 'Bearer ours', TERM: 'screen' }, 'linux');
		assert.strictEqual(out.AI_BROWSER_MCP_AUTH, 'Bearer ours');
		assert.strictEqual(out.TERM, 'screen');
		assert.strictEqual(out.AI_BROWSER_MCP_TAB, undefined);
	});

	test('gives a shell without a locale one', () => {
		assert.strictEqual(scrubEnv({ PATH: '/bin' }, {}, 'darwin').LANG, 'en_US.UTF-8');
		assert.strictEqual(scrubEnv({ LC_ALL: 'C' }, {}, 'linux').LANG, undefined);
		assert.strictEqual(scrubEnv({ PATH: 'C:\\' }, {}, 'win32').LANG, undefined);
	});

	test('is case-insensitive on Windows only', () => {
		const win = scrubEnv({ Path: 'C:\\x', vscode_pid: '1', Electron_Run_As_Node: '1', node_options: 'x', Term: 'dumb' }, {}, 'win32');
		assert.deepStrictEqual(Object.keys(win).sort(), ['COLORTERM', 'Path', 'TERM', 'TERM_PROGRAM']);
		const posix = scrubEnv({ vscode_pid: '1' }, {}, 'linux');
		assert.strictEqual(posix.vscode_pid, '1');
	});

	test('skips undefined values', () => {
		const out = scrubEnv({ A: undefined, B: 'b' } as NodeJS.ProcessEnv, {}, 'linux');
		assert.strictEqual('A' in out, false);
		assert.strictEqual(out.B, 'b');
	});
});

suite('resolveShell', () => {
	const has = (...present: string[]) => (p: string) => present.includes(p);

	test('with no profile: $SHELL as a login shell on macOS, /bin/zsh then /bin/sh without it', () => {
		assert.deepStrictEqual(resolveShell('darwin', { SHELL: '/opt/homebrew/bin/fish' }, {}, has('/opt/homebrew/bin/fish')), { file: '/opt/homebrew/bin/fish', args: ['-l'], name: 'fish' });
		assert.deepStrictEqual(resolveShell('darwin', {}, {}, has('/bin/zsh')), { file: '/bin/zsh', args: ['-l'], name: 'zsh' });
		assert.deepStrictEqual(resolveShell('darwin', { SHELL: '/gone' }, {}, has()), { file: '/bin/sh', args: ['-l'], name: 'sh' });
	});

	test('with no profile on Linux: $SHELL, else /bin/sh, no login flag', () => {
		assert.deepStrictEqual(resolveShell('linux', { SHELL: '/bin/bash' }, {}, has('/bin/bash')), { file: '/bin/bash', args: [], name: 'bash' });
		assert.deepStrictEqual(resolveShell('linux', {}, {}, has()), { file: '/bin/sh', args: [], name: 'sh' });
	});

	test('with no profile on Windows: %COMSPEC% (any case), else powershell.exe', () => {
		assert.deepStrictEqual(resolveShell('win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, {}, has()), { file: 'C:\\Windows\\System32\\cmd.exe', args: [], name: 'cmd' });
		assert.deepStrictEqual(resolveShell('win32', {}, {}, has()), { file: 'powershell.exe', args: [], name: 'powershell' });
	});

	test('a named profile with a path, args as an array or a string', () => {
		const profiles = { mine: { path: '/usr/local/bin/fish', args: ['--private'] }, spaced: { path: '/bin/bash', args: '--rcfile "/my files/rc" -i' } };
		assert.deepStrictEqual(resolveShell('linux', {}, { defaultProfile: 'mine', profiles }, has('/usr/local/bin/fish')), { file: '/usr/local/bin/fish', args: ['--private'], name: 'mine' });
		assert.deepStrictEqual(resolveShell('linux', {}, { defaultProfile: 'spaced', profiles }, has('/bin/bash')), { file: '/bin/bash', args: ['--rcfile', '/my files/rc', '-i'], name: 'spaced' });
	});

	test('a path list is tried in order, and a bare name is found on PATH', () => {
		const profiles = { zsh: { path: ['/opt/zsh', '/usr/local/bin/zsh', 'zsh'] } };
		assert.strictEqual(resolveShell('darwin', {}, { defaultProfile: 'zsh', profiles }, has('/usr/local/bin/zsh')).file, '/usr/local/bin/zsh');
		assert.strictEqual(resolveShell('darwin', { PATH: '/a:/b' }, { defaultProfile: 'zsh', profiles }, has('/b/zsh')).file, '/b/zsh');
	});

	test('on macOS a profile without args is a login shell, with args it is not', () => {
		assert.deepStrictEqual(resolveShell('darwin', {}, { defaultProfile: 'zsh', profiles: { zsh: { path: '/bin/zsh' } } }, has('/bin/zsh')).args, ['-l']);
		assert.deepStrictEqual(resolveShell('darwin', {}, { defaultProfile: 'zsh', profiles: { zsh: { path: '/bin/zsh', args: [] } } }, has('/bin/zsh')).args, []);
		assert.deepStrictEqual(resolveShell('linux', {}, { defaultProfile: 'zsh', profiles: { zsh: { path: '/bin/zsh' } } }, has('/bin/zsh')).args, []);
	});

	test('${env:NAME} in a path is substituted', () => {
		const out = resolveShell('linux', { MYSHELL: '/opt/sh' }, { defaultProfile: 'x', profiles: { x: { path: '${env:MYSHELL}' } } }, has('/opt/sh'));
		assert.strictEqual(out.file, '/opt/sh');
	});

	test('a profile that names a built-in without defining it is resolved by name', () => {
		assert.strictEqual(resolveShell('linux', { PATH: '/usr/bin' }, { defaultProfile: 'bash' }, has('/usr/bin/bash')).file, '/usr/bin/bash');
		const git = resolveShell('win32', { ProgramFiles: 'C:\\Program Files' }, { defaultProfile: 'Git Bash' }, has('C:\\Program Files\\Git\\bin\\bash.exe'));
		assert.strictEqual(git.file, 'C:\\Program Files\\Git\\bin\\bash.exe');
		const ps = resolveShell('win32', { Path: 'C:\\pwsh;C:\\ps' }, { defaultProfile: 'PowerShell' }, has('C:\\ps\\powershell.exe'));
		assert.strictEqual(ps.file, 'C:\\ps\\powershell.exe');
	});

	test('a profile with only a source falls back to that built-in', () => {
		const out = resolveShell('win32', { Path: 'C:\\ps' }, { defaultProfile: 'PS', profiles: { PS: { source: 'Windows PowerShell' } } }, has('C:\\ps\\powershell.exe'));
		assert.strictEqual(out.file, 'C:\\ps\\powershell.exe');
		assert.strictEqual(out.name, 'PS');
	});

	test('a profile that cannot be resolved, or is null, falls back to the platform shell', () => {
		assert.strictEqual(resolveShell('linux', { SHELL: '/bin/bash' }, { defaultProfile: 'gone', profiles: { gone: { path: '/nope' } } }, has('/bin/bash')).file, '/bin/bash');
		assert.strictEqual(resolveShell('linux', { SHELL: '/bin/bash' }, { defaultProfile: 'off', profiles: { off: null } }, has('/bin/bash')).file, '/bin/bash');
		assert.strictEqual(resolveShell('linux', { SHELL: '/bin/bash' }, { defaultProfile: 'unknown-name' }, has('/bin/bash')).file, '/bin/bash');
	});
});

suite('plainText', () => {
	test('strips colours, cursor movement, titles and hyperlinks', () => {
		const screen = '\x1b[1;32mok\x1b[0m done\x1b[2K\x1b[?25h\x1b]0;title\x07\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\';
		assert.strictEqual(plainText(screen), 'ok donelink');
	});

	test('keeps only the last drawing of a line redrawn with a carriage return', () => {
		assert.strictEqual(plainText('10%\r50%\r100%\nnext\r\nCRLF line'), '100%\nnext\nCRLF line');
	});

	test('applies backspaces and drops other control characters', () => {
		assert.strictEqual(plainText('abd\bc\x07\x00\x7f'), 'abc');
	});

	test('trims trailing spaces and blank lines and keeps the last lines asked for', () => {
		assert.strictEqual(plainText('a  \nb\n\n\n'), 'a\nb');
		assert.strictEqual(plainText('1\n2\n3\n4\n', 2), '3\n4');
		assert.strictEqual(plainText('1\n2', 0), '');
		assert.strictEqual(plainText('1\n2', 10), '1\n2');
	});

	test('survives an unterminated escape at the end', () => {
		assert.strictEqual(plainText('a\x1b[3'), 'a');
		assert.strictEqual(plainText('b\x1b]0;half a title'), 'b');
		assert.strictEqual(plainText('c\x1b'), 'c');
	});

	test('leaves tabs and non-ASCII alone', () => {
		assert.strictEqual(plainText('a\tb \u{1F600} \u00e9'), 'a\tb \u{1F600} \u00e9');
	});
});

// ---------------------------------------------------------------------------------------------
// The screen of a session (the model itself is tested in screenModel.test.ts)
// ---------------------------------------------------------------------------------------------


function screenRig(options: { cols?: number; rows?: number; batchMs?: number; ackHigh?: number } = {}) {
	const pty = new FakePty();
	const screen = createScreenModel({ cols: options.cols ?? 40, rows: options.rows ?? 6, cwd: '/work' });
	const chunks: Array<{ chunk: string; seq: number }> = [];
	const exits: Array<number | undefined> = [];
	const session = new TerminalSession(pty, {
		onData: (chunk, seq) => chunks.push({ chunk, seq }),
		onExit: code => exits.push(code),
		batchMs: options.batchMs ?? 5,
		ackHigh: options.ackHigh,
		screen,
	});
	return { pty, session, screen, chunks, exits };
}

suite('TerminalSession screen', () => {
	test('a read right after the shell wrote sees it, before the batch timer fires', async () => {
		const r = screenRig({ batchMs: 5000 });
		r.pty.emit('hello\r\nworld');
		assert.strictEqual(r.chunks.length, 0);
		const read = await r.session.readScreen();
		assert.strictEqual(read.text, 'hello\nworld');
		assert.strictEqual(r.chunks.length, 1);
		assert.strictEqual(read.state.cwd, '/work');
		assert.strictEqual(read.state.degraded, undefined);
		assert.strictEqual(r.session.screenDegraded, false);
		r.session.dispose();
	});

	test('what the view is sent and what the screen is fed is the same stream', async () => {
		const r = screenRig();
		r.pty.emit('a\r\n');
		r.pty.emit('b\r\n');
		await later(30);
		const read = await r.session.readScreen({ scrollback: true });
		assert.strictEqual(joined({ chunks: r.chunks } as Rig), 'a\r\nb\r\n');
		assert.strictEqual(read.text, 'a\nb');
		assert.strictEqual(read.cursor.split('.')[1], String(r.chunks[r.chunks.length - 1].seq));
		r.session.dispose();
	});

	test('input is stamped, and a resize reaches the screen', async () => {
		const r = screenRig({ cols: 40, rows: 6 });
		assert.strictEqual(r.session.lastInputAt, 0);
		const before = Date.now();
		r.session.write('ls\r');
		assert.ok(r.session.lastInputAt >= before);
		assert.deepStrictEqual(r.pty.written, ['ls\r']);
		r.session.resize(100, 30);
		const read = await r.session.readScreen();
		assert.strictEqual(read.state.cols, 100);
		assert.strictEqual(read.state.rows, 30);
		r.session.write('');
		const stamp = r.session.lastInputAt;
		r.session.write('x'.repeat((1 << 20) + 1));
		assert.strictEqual(r.session.lastInputAt, stamp, 'a write that is dropped is not input');
		r.session.dispose();
	});

	test('the exit is on the screen, the final text stays readable, and a wait for it ends', async () => {
		const r = screenRig();
		const waiting = r.session.waitFor({ until: 'exit', timeoutMs: 5000 });
		r.pty.emit('last words\r\n');
		r.pty.exit(2);
		const done = await waiting;
		assert.strictEqual(done.reason, 'exit');
		assert.strictEqual(done.state.status, 'exited');
		assert.strictEqual(done.state.exitCode, 2);
		assert.strictEqual(done.text, 'last words');
		assert.strictEqual((await r.session.readScreen()).text, 'last words');
		r.session.dispose();
	});

	test('a session with no screen reads the stream\'s tail, and says so', async () => {
		const r = rig({ batchMs: 5000 });
		r.pty.emit('\x1b[32mgreen\x1b[0m\r\nline two\r\nprog 10%\rprog 90%');
		const read = await r.session.readScreen();
		assert.strictEqual(r.session.screenDegraded, true);
		assert.strictEqual(read.state.degraded, true);
		assert.strictEqual(read.state.integration, 'none');
		assert.strictEqual(read.viewport, 'green\nline two\nprog 90%');
		assert.strictEqual(read.text, read.viewport);
		const since = await r.session.readScreen({ since: read.cursor });
		assert.strictEqual(since.text, '');
		r.pty.emit('\r\nnext');
		const after = await r.session.readScreen({ since: read.cursor });
		assert.strictEqual(after.text, 'next');
		const gone = await r.session.readScreen({ since: 'x.1' });
		assert.strictEqual(gone.truncated, true);
	});

	test('a degraded wait supports text, idle and exit', async () => {
		const r = rig();
		const text = r.session.waitFor({ until: 'text', text: 'ready', timeoutMs: 5000 });
		await later(20);
		r.pty.emit('now ready\r\n');
		assert.strictEqual((await text).reason, 'text');
		const idle = await r.session.waitFor({ until: 'idle', quietMs: 60, timeoutMs: 3000 });
		assert.strictEqual(idle.reason, 'idle');
		const timeout = await r.session.waitFor({ until: 'text', text: 'absent', timeoutMs: 120 });
		assert.strictEqual(timeout.reason, 'timeout');
		const controller = new AbortController();
		const pending = r.session.waitFor({ until: 'idle', quietMs: 60_000, timeoutMs: 60_000, signal: controller.signal });
		setTimeout(() => controller.abort(), 30);
		assert.strictEqual((await pending).reason, 'aborted');
		const exited = r.session.waitFor({ until: 'exit', timeoutMs: 5000 });
		r.pty.exit(0);
		assert.strictEqual((await exited).reason, 'exit');
		await assert.rejects(r.session.waitFor({ until: 'text', timeoutMs: 100 }));
	});

	test('a disposed session reads its tail, degraded', async () => {
		const r = screenRig();
		r.pty.emit('kept\r\n');
		await later(20);
		r.session.dispose();
		const read = await r.session.readScreen();
		assert.strictEqual(read.state.degraded, true);
		assert.strictEqual(read.text, 'kept');
	});

	test('TerminalHost builds the screen with the shell\'s size and folder, or none when told not to', async () => {
		const ptys: FakePty[] = [];
		const loader = () => ({ spawn: (_o: PtySpawn) => { const p = new FakePty(); ptys.push(p); return p; } });
		const options = { file: '/bin/sh', args: [], cwd: '/proj', env: {}, cols: 50, rows: 7, onData: () => undefined, onExit: () => undefined };
		const withScreen = new TerminalHost(loader, createScreenModel);
		const a = withScreen.create(options);
		ptys[0].emit('hi');
		const read = await a.readScreen();
		assert.strictEqual(read.state.cols, 50);
		assert.strictEqual(read.state.rows, 7);
		assert.strictEqual(read.state.cwd, '/proj');
		assert.strictEqual(read.state.degraded, undefined);
		withScreen.dispose();
		const without = new TerminalHost(loader, false);
		const b = without.create(options);
		assert.strictEqual(b.screenDegraded, true);
		without.dispose();
		const broken = new TerminalHost(loader, () => { throw new Error('no emulator'); });
		assert.strictEqual(broken.create(options).screenDegraded, true, 'a shell without a screen still works');
		broken.dispose();
	});
});

suite('TerminalSession flow control with the screen', () => {
	/** A PTY that stops sending while it is paused, as the real one does. */
	class PausablePty extends FakePty {
		held = false;
		override pause(): void { super.pause(); this.held = true; }
		override resume(): void { super.resume(); this.held = false; }
	}

	test('100 MB of output through a screen nobody is reading: the shell is paused at the emulator\'s backlog, nothing is lost or thrown', async () => {
		const pty = new PausablePty();
		const screen = createScreenModel({ cols: 120, rows: 30, scrollback: 3000 });
		let acked = 0;
		const session: TerminalSession = new TerminalSession(pty, {
			// No view attached: everything is acknowledged at once, so only the emulator's backlog can hold the shell back.
			onData: chunk => { acked += chunk.length; session.ack(chunk.length); },
			onExit: () => undefined,
			batchMs: 1,
			screen,
		});
		const line = 'The quick brown fox jumps over the lazy dog 0123456789 '.repeat(2) + '\r\n';
		const block = line.repeat(Math.floor(65536 / line.length));
		const total = 100 * 1024 * 1024;
		let sent = 0;
		let peak = 0;
		while (sent < total) {
			if (pty.held) {
				await later(2);
				peak = Math.max(peak, screen.backlog);
				continue;
			}
			pty.emit(block);
			sent += block.length;
			peak = Math.max(peak, screen.backlog);
		}
		const read = await session.readScreen();
		assert.strictEqual(screen.failed, false, 'the emulator never saw more than it could take');
		assert.ok(pty.paused > 0, 'the shell was paused');
		assert.ok(pty.resumed > 0, 'and read again');
		assert.ok(peak < 10 << 20, 'the backlog stayed near its cap, was ' + peak);
		assert.strictEqual(acked, sent);
		assert.strictEqual(screen.backlog, 0);
		assert.ok(read.text.includes('The quick brown fox'));
		assert.ok((await session.readScreen({ scrollback: true })).text.split('\n').length <= 500);
		session.dispose();
	});

	test('a view that is behind pauses the shell as before, and the backlog does not resume it early', async () => {
		const pty = new PausablePty();
		const screen = createScreenModel({ cols: 80, rows: 24 });
		const session = new TerminalSession(pty, { onData: () => undefined, onExit: () => undefined, batchMs: 1, ackHigh: 1000, ackLow: 100, screen });
		pty.emit('x'.repeat(2000));
		await later(20);
		assert.strictEqual(pty.paused, 1);
		await screen.settle();
		assert.strictEqual(screen.backlog, 0);
		assert.strictEqual(pty.resumed, 0, 'the emulator is done, the view is not');
		session.ack(2000);
		assert.strictEqual(pty.resumed, 1);
		session.dispose();
	});
});
