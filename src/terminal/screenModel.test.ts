/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { ScreenModel, capLines, looksLikePrompt, loadEmulator, maxLineChars, maxReadLines } from './screenModel.ts';

// The real headless xterm, from node_modules (the staged copy only exists after a build): the byte samples below
// are what a program writes, and what comes out is what the emulator makes of them.

const later = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** A model and a stream counter; every `feed` is one batch of the PTY layer. */
function rig(cols = 40, rows = 6, scrollback = 200) {
	const model = new ScreenModel({ cols, rows, scrollback });
	let seq = 0;
	return {
		model,
		get seq() { return seq; },
		feed(text: string): void {
			seq += text.length;
			model.feed(text, seq);
		},
	};
}

suite('screen model: a screen, not a pile of escapes', () => {
	test('the emulator loads from node_modules', () => {
		assert.strictEqual(typeof loadEmulator(), 'function');
	});

	test('an Ink-style repaint (cursor up, erase below) reads as its last frame only', async () => {
		const r = rig(40, 8);
		r.feed('> thinking\r\nstep 1\r\nstep 2\r\n');
		r.feed('\x1b[3A\x1b[J> thinking.\r\nstep 1\r\nstep 2 done\r\n');
		r.feed('\x1b[3A\x1b[J> done\r\nstep 1\r\nstep 2 done\r\nall good\r\n');
		const read = await r.model.read();
		assert.strictEqual(read.text, '> done\nstep 1\nstep 2 done\nall good');
		assert.ok(!read.text.includes('thinking'));
	});

	test('a \\r progress bar is its last drawing', async () => {
		const r = rig();
		r.feed('Downloading 10%');
		r.feed('\rDownloading 55%');
		r.feed('\rDownloading 100%\r\ndone\r\n');
		assert.strictEqual((await r.model.read()).text, 'Downloading 100%\ndone');
	});

	test('a spinner drawn with CSI G / K leaves one line', async () => {
		const r = rig();
		for (const frame of ['|', '/', '-', '\\']) {
			r.feed('\x1b[1Gbuild ' + frame + '\x1b[K');
		}
		r.feed('\x1b[1Gbuild OK\x1b[K\r\n');
		assert.strictEqual((await r.model.read()).text, 'build OK');
	});

	test('absolute positioning makes a table out of cells', async () => {
		const r = rig(20, 4);
		r.feed('\x1b[2J\x1b[HNAME  CPU\x1b[2;1Hnode  12%\x1b[3;1Hvim    3%');
		assert.strictEqual((await r.model.read()).text, 'NAME  CPU\nnode  12%\nvim    3%');
	});

	test('the alternate screen is the viewport while a program runs, and the main screen is back after it', async () => {
		const r = rig(30, 5);
		r.feed('main one\r\nmain two\r\n');
		r.feed('\x1b[?1049h\x1b[Hvim frame\x1b[2;1H~\x1b[3;1H~');
		const alt = await r.model.read({ scrollback: true });
		assert.strictEqual(alt.state.altScreen, true);
		assert.strictEqual(alt.text, 'vim frame\n~\n~');
		assert.strictEqual(alt.viewport, alt.text);
		r.feed('\x1b[?1049l');
		const back = await r.model.read();
		assert.strictEqual(back.state.altScreen, false);
		assert.strictEqual(back.text, 'main one\nmain two');
	});

	test('wide characters, emoji and combining marks come out as the characters they are', async () => {
		const r = rig(20, 4);
		r.feed('\u4e16\u754c ok\r\ne\u0301clair \ud83d\ude00 x\r\n');
		assert.strictEqual((await r.model.read()).text, '\u4e16\u754c ok\ne\u0301clair \ud83d\ude00 x');
	});

	test('a soft-wrapped line is one line, and its inner spaces survive the join', async () => {
		const r = rig(10, 6);
		r.feed('aaaaaaaa  bbbbbbbbbb ccc\r\nnext\r\n');
		assert.strictEqual((await r.model.read()).text, 'aaaaaaaa  bbbbbbbbbb ccc\nnext');
	});

	test('a resize reflows what was wrapped', async () => {
		const r = rig(40, 6);
		r.feed('0123456789012345678901234567890\r\nend\r\n');
		r.model.resize(10, 6);
		const read = await r.model.read({ scrollback: true });
		assert.strictEqual(read.state.cols, 10);
		assert.strictEqual(read.text, '0123456789012345678901234567890\nend');
	});

	test('the title and the working directory are what the program set, without control characters', async () => {
		const r = rig();
		r.feed('\x1b]0;my build\x07');
		r.feed('\x1b]7;file://host/Users/m/My%20Dir\x07');
		const state = (await r.model.read()).state;
		assert.strictEqual(state.title, 'my build');
		assert.strictEqual(state.cwd, '/Users/m/My Dir');
		r.feed('\x1b]7;file:///C:/Users/m\x07');
		assert.strictEqual((await r.model.read()).state.cwd, 'C:/Users/m');
	});

	test('the starting folder is the cwd until the shell says otherwise', async () => {
		const model = new ScreenModel({ cols: 20, rows: 4, cwd: '/work' });
		assert.strictEqual((await model.read()).state.cwd, '/work');
		model.dispose();
	});
});

suite('screen model: reading from a cursor', () => {
	test('a since read starts at the row the cursor was on, so a progress bar is not duplicated', async () => {
		const r = rig(40, 8);
		r.feed('line1\r\nline2\r\nprog 10%');
		const first = await r.model.read();
		assert.strictEqual(first.text, 'line1\nline2\nprog 10%');
		r.feed('\rprog 50%\r\nprog done\r\nline4\r\n');
		const next = await r.model.read({ since: first.cursor });
		assert.strictEqual(next.text, 'prog 50%\nprog done\nline4');
		assert.strictEqual(next.truncated, false);
		assert.ok(next.cursor !== first.cursor);
	});

	test('a since read with nothing new is the line the cursor is on', async () => {
		const r = rig();
		r.feed('a\r\nb\r\n$ ');
		const first = await r.model.read();
		const again = await r.model.read({ since: first.cursor });
		assert.strictEqual(again.text, '$');
		assert.strictEqual(again.cursor, first.cursor);
	});

	test('output past the scrollback makes the place gone: the retained tail, and truncated', async () => {
		const r = rig(20, 4, 5);
		r.feed('start\r\n');
		const first = await r.model.read();
		let flood = '';
		for (let i = 0; i < 40; i++) {
			flood += 'row ' + i + '\r\n';
		}
		r.feed(flood);
		const next = await r.model.read({ since: first.cursor });
		assert.strictEqual(next.truncated, true);
		assert.ok(next.text.endsWith('row 39'));
		assert.ok(!next.text.includes('start'));
	});

	test('a cursor from another model, or a made-up one, is not a place', async () => {
		const a = rig();
		const b = rig();
		a.feed('x\r\n');
		b.feed('y\r\n');
		const cursor = (await a.model.read()).cursor;
		const foreign = await b.model.read({ since: cursor });
		assert.strictEqual(foreign.truncated, true);
		assert.strictEqual(foreign.text, 'y');
		assert.strictEqual((await b.model.read({ since: 'nonsense' })).truncated, true);
	});

	test('scrollback: true reads what scrolled off, the default reads the screen', async () => {
		const r = rig(20, 3, 50);
		let text = '';
		for (let i = 1; i <= 10; i++) {
			text += 'n' + i + '\r\n';
		}
		r.feed(text);
		const screen = await r.model.read();
		assert.strictEqual(screen.text, 'n9\nn10');
		const all = await r.model.read({ scrollback: true });
		assert.strictEqual(all.text, 'n1\nn2\nn3\nn4\nn5\nn6\nn7\nn8\nn9\nn10');
		assert.strictEqual(all.viewport, screen.viewport);
	});

	test('a read right after feed sees it: the emulator parses in slices and the read waits for them', async () => {
		const r = rig(80, 24, 10000);
		let big = '';
		for (let i = 0; i < 20000; i++) {
			big += 'line ' + i + '\r\n';
		}
		r.feed(big);
		assert.ok(r.model.backlog > 0);
		const read = await r.model.read({ scrollback: true });
		assert.strictEqual(r.model.backlog, 0);
		assert.ok(read.text.endsWith('line 19999'));
	});
});

suite('screen model: caps', () => {
	test('lines past 500 keep the newest, and say so', () => {
		const lines = Array.from({ length: maxReadLines + 100 }, (_, i) => 'l' + i);
		const capped = capLines(lines, 40_000);
		assert.strictEqual(capped.truncated, true);
		assert.strictEqual(capped.text.split('\n').length, maxReadLines);
		assert.ok(capped.text.endsWith('l' + (maxReadLines + 99)));
		assert.ok(!capped.text.includes('l99\n'));
	});

	test('characters past the budget drop whole old lines first', () => {
		const capped = capLines(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc'], 25);
		assert.deepStrictEqual(capped, { text: 'bbbbbbbbbb\ncccccccccc', truncated: true });
	});

	test('a line over 2000 characters is cut, never inside a surrogate pair', () => {
		const long = 'x'.repeat(maxLineChars - 1) + '\ud83d\ude00' + 'tail';
		const capped = capLines([long], 40_000);
		assert.strictEqual(capped.truncated, true);
		assert.strictEqual(capped.text, 'x'.repeat(maxLineChars - 1) + '\u2026');
		assert.doesNotThrow(() => encodeURIComponent(capped.text));
	});

	test('one newest line over a tiny budget keeps its start', () => {
		assert.deepStrictEqual(capLines(['0123456789', 'abcdefghij'], 4), { text: 'abcd', truncated: true });
	});

	test('maxChars on a read is honoured and floors at 100', async () => {
		const r = rig(80, 24);
		r.feed(Array.from({ length: 20 }, (_, i) => 'row-' + String(i).padStart(3, '0') + ' ' + 'x'.repeat(30)).join('\r\n'));
		const read = await r.model.read({ maxChars: 120 });
		assert.ok(read.text.length <= 120);
		assert.strictEqual(read.truncated, true);
		assert.ok(read.text.includes('row-019'));
	});

	test('a prompt-looking last line', () => {
		assert.strictEqual(looksLikePrompt('Proceed? [y/N] '), true);
		assert.strictEqual(looksLikePrompt('Password:\n\n'), true);
		assert.strictEqual(looksLikePrompt('what do you want to do?'), true);
		assert.strictEqual(looksLikePrompt('build finished'), false);
		assert.strictEqual(looksLikePrompt(''), false);
	});
});

suite('screen model: shell integration (OSC 133)', () => {
	test('no integration is reported as such, and a command wait is an idle wait', async () => {
		const r = rig();
		r.feed('$ ');
		const read = await r.model.read();
		assert.strictEqual(read.state.integration, 'none');
		assert.strictEqual(read.state.commandState, 'unknown');
		const waited = await r.model.wait({ until: 'command', timeoutMs: 3000, quietMs: 60 });
		assert.strictEqual(waited.reason, 'idle');
	});

	test('a command wait ends at the shell\'s end-of-command mark with its exit status and its output', async () => {
		const r = rig(40, 10);
		r.feed('\x1b]133;D;0\x07$ ');
		const before = await r.model.read();
		assert.strictEqual(before.state.integration, 'osc133');
		assert.strictEqual(before.state.commandState, 'prompt');
		const pending = r.model.wait({ until: 'command', timeoutMs: 5000, since: before.cursor });
		await later(30);
		r.feed('ls\r\n\x1b]133;C\x07file1\r\nfile2\r\n');
		assert.strictEqual((await r.model.read()).state.commandState, 'running');
		await later(30);
		r.feed('\x1b]133;D;3\x07$ ');
		const done = await pending;
		assert.strictEqual(done.reason, 'command');
		assert.strictEqual(done.exitCode, 3);
		assert.strictEqual(done.output, 'file1\nfile2');
		assert.strictEqual(done.state.lastExitCode, 3);
		assert.strictEqual(done.state.commandState, 'prompt');
	});

	test('the D a shell prints when it starts is a prompt, not the end of a command', async () => {
		const r = rig();
		r.feed('\x1b]133;D;0\x07$ ');
		const result = await r.model.wait({ until: 'command', timeoutMs: 250 });
		assert.strictEqual(result.reason, 'timeout');
		assert.strictEqual(result.state.lastExitCode, undefined);
	});

	test('a D after keys with a newline were sent counts as a result even when the shell prints no C', async () => {
		const r = rig();
		r.feed('\x1b]133;A\x07$ ');
		const at = await r.model.read();
		const pending = r.model.wait({ until: 'command', timeoutMs: 5000, since: at.cursor });
		r.model.noteInput('true\r', r.seq);
		await later(20);
		r.feed('true\r\n\x1b]133;D;0\x07$ ');
		const done = await pending;
		assert.strictEqual(done.reason, 'command');
		assert.strictEqual(done.exitCode, 0);
		assert.strictEqual(done.output, undefined);
	});

	test('OSC 633 (VS Code\'s) carries the same marks and a working directory', async () => {
		const r = rig();
		r.feed('\x1b]633;P;Cwd=/src/app\x07\x1b]633;C\x07out\r\n\x1b]633;D;7\x07');
		const read = await r.model.read();
		assert.strictEqual(read.state.integration, 'osc133');
		assert.strictEqual(read.state.lastExitCode, 7);
		assert.strictEqual(read.state.cwd, '/src/app');
	});

	test('a wait with no since does not return a command that ended before it began', async () => {
		const r = rig();
		r.feed('\x1b]133;C\x07old\r\n\x1b]133;D;0\x07$ ');
		await r.model.read();
		const result = await r.model.wait({ until: 'command', timeoutMs: 250 });
		assert.strictEqual(result.reason, 'timeout');
	});
});

suite('screen model: waiting', () => {
	test('idle: the screen unchanged for quietMs, however much it was redrawn before', async () => {
		const r = rig();
		const started = Date.now();
		const pending = r.model.wait({ until: 'idle', quietMs: 150, timeoutMs: 5000 });
		for (let i = 0; i < 4; i++) {
			await later(40);
			r.feed('tick ' + i + '\r\n');
		}
		const done = await pending;
		assert.strictEqual(done.reason, 'idle');
		assert.ok(Date.now() - started >= 150 + 120, 'waited out the last change');
		assert.ok(done.text.includes('tick 3'));
	});

	test('idle compares the screen, not the bytes: a redraw to the same picture is quiet', async () => {
		const r = rig(20, 3);
		r.feed('static');
		await r.model.read();
		const pending = r.model.wait({ until: 'idle', quietMs: 200, timeoutMs: 5000 });
		const timer = setInterval(() => r.feed('\r\x1b[2Kstatic'), 20);
		const done = await pending;
		clearInterval(timer);
		assert.strictEqual(done.reason, 'idle');
	});

	test('idle says a trailing question may be waiting for input', async () => {
		const r = rig();
		r.feed('Overwrite? [y/N] ');
		const done = await r.model.wait({ until: 'idle', quietMs: 60, timeoutMs: 3000 });
		assert.strictEqual(done.reason, 'idle');
		assert.strictEqual(done.maybeAwaitingInput, true);
	});

	test('text: a literal (not a pattern) found in what arrives', async () => {
		const r = rig();
		const pending = r.model.wait({ until: 'text', text: '[y/N]', timeoutMs: 5000 });
		await later(30);
		r.feed('Continue [y/N]');
		assert.strictEqual((await pending).reason, 'text');
		const regexLike = await r.model.wait({ until: 'text', text: '.*', timeoutMs: 200 });
		assert.strictEqual(regexLike.reason, 'timeout');
	});

	test('text is also found in what the cursor says came after, when it has scrolled off the screen', async () => {
		const r = rig(20, 3, 100);
		r.feed('a\r\n');
		const at = await r.model.read();
		let text = 'BUILD OK\r\n';
		for (let i = 0; i < 10; i++) {
			text += 'more ' + i + '\r\n';
		}
		r.feed(text);
		const done = await r.model.wait({ until: 'text', text: 'BUILD OK', since: at.cursor, timeoutMs: 1000 });
		assert.strictEqual(done.reason, 'text');
		assert.ok(done.text.includes('BUILD OK'));
	});

	test('text without any text is an error, not a wait that never ends', async () => {
		const r = rig();
		await assert.rejects(r.model.wait({ until: 'text', timeoutMs: 100 }));
		await assert.rejects(r.model.wait({ until: 'text', text: '', timeoutMs: 100 }));
	});

	test('exit ends every kind of wait, with the final screen readable', async () => {
		for (const until of ['idle', 'text', 'command', 'exit'] as const) {
			const r = rig();
			r.feed('bye\r\n');
			const pending = r.model.wait({ until, text: 'never appears', timeoutMs: 5000, quietMs: 5000 });
			await later(20);
			r.model.markExit(7);
			const done = await pending;
			assert.strictEqual(done.reason, 'exit', until);
			assert.strictEqual(done.state.status, 'exited');
			assert.strictEqual(done.state.exitCode, 7);
			assert.strictEqual(done.text, 'bye');
		}
	});

	test('a signal ends the wait at once, with a read', async () => {
		const r = rig();
		r.feed('x');
		const controller = new AbortController();
		const started = Date.now();
		const pending = r.model.wait({ until: 'idle', quietMs: 60_000, timeoutMs: 60_000, signal: controller.signal });
		setTimeout(() => controller.abort(), 40);
		const done = await pending;
		assert.strictEqual(done.reason, 'aborted');
		assert.ok(Date.now() - started < 1000);
		assert.strictEqual(done.text, 'x');
		const early = await r.model.wait({ until: 'idle', timeoutMs: 5000, signal: AbortSignal.abort() });
		assert.strictEqual(early.reason, 'aborted');
	});

	test('the timeout answers with the screen and the reason', async () => {
		const r = rig();
		r.feed('busy');
		const started = Date.now();
		const done = await r.model.wait({ until: 'text', text: 'nope', timeoutMs: 200 });
		assert.strictEqual(done.reason, 'timeout');
		assert.ok(Date.now() - started >= 190);
		assert.strictEqual(done.text, 'busy');
	});

	test('a wait lays a cursor the next read can use', async () => {
		const r = rig(40, 8);
		r.feed('one\r\n$ ');
		const done = await r.model.wait({ until: 'idle', quietMs: 50, timeoutMs: 2000 });
		r.feed('echo\r\ntwo\r\n$ ');
		const next = await r.model.read({ since: done.cursor });
		assert.strictEqual(next.truncated, false);
		assert.strictEqual(next.text, '$ echo\ntwo\n$');
	});
});

suite('screen model: failure and the end', () => {
	test('the emulator refusing data is a failed model, not an exception in the shell\'s reader', () => {
		const r = rig(80, 24);
		const megabyte = 'x'.repeat(1 << 20);
		assert.doesNotThrow(() => {
			for (let i = 0; i < 70; i++) {
				r.feed(megabyte);
			}
		});
		assert.strictEqual(r.model.failed, true);
		assert.doesNotThrow(() => r.feed('more'));
		r.model.dispose();
	});

	test('a disposed model answers its waiters and stays failed', async () => {
		const r = rig();
		r.feed('x');
		const pending = r.model.wait({ until: 'text', text: 'zzz', timeoutMs: 5000 });
		await later(20);
		r.model.dispose();
		const done = await pending;
		assert.strictEqual(done.reason, 'exit');
		assert.strictEqual(r.model.failed, true);
	});
});
