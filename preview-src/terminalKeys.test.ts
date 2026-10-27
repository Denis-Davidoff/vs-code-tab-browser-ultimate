import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { terminalKeyAction, terminalPlatform, type TerminalKeyEvent, type TerminalPlatform } from './terminalKeys.ts';

function key(k: string, mods = '', extra: Partial<TerminalKeyEvent> = {}): TerminalKeyEvent {
	return { type: 'keydown', key: k, ctrlKey: mods.includes('c'), metaKey: mods.includes('m'), altKey: mods.includes('a'), shiftKey: mods.includes('s'), ...extra };
}
const kind = (e: TerminalKeyEvent, platform: TerminalPlatform, selection = false) => terminalKeyAction(e, platform, selection).kind;

test('the platform is read from navigator.platform and the user agent', () => {
	assert.equal(terminalPlatform('MacIntel'), 'mac');
	assert.equal(terminalPlatform('Win32'), 'win');
	assert.equal(terminalPlatform('Linux x86_64'), 'linux');
	assert.equal(terminalPlatform('', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'mac');
});

test('ordinary typing and control characters are the shell\'s on every platform', () => {
	for (const platform of ['mac', 'win', 'linux'] as const) {
		for (const e of [key('a'), key('Enter'), key('Escape'), key('ArrowUp'), key('l', 'c'), key('d', 'c'), key('r', 'c'), key('w', 'c'), key('p', 'c'), key('b', 'c')]) {
			assert.equal(kind(e, platform), 'xterm', `${platform} ${JSON.stringify(e)}`);
		}
	}
});

test('on a Mac every command chord reaches the workbench, and copy, paste and select all are done through the host', () => {
	for (const k of ['p', 't', 'w', 'k', 'b', 'j', ',']) { assert.equal(kind(key(k, 'm'), 'mac'), 'passthrough', k); }
	assert.equal(kind(key('P', 'ms'), 'mac'), 'passthrough');
	assert.equal(kind(key('c', 'm'), 'mac'), 'copy');
	assert.equal(kind(key('C', 'm'), 'mac'), 'copy');
	assert.equal(kind(key('v', 'm'), 'mac'), 'paste');
	assert.equal(kind(key('a', 'm'), 'mac'), 'selectAll');
	// Shift changes the chord: ⇧⌘C is not copy.
	assert.equal(kind(key('C', 'ms'), 'mac'), 'passthrough');
});

test('on a Mac ⌘ and ⌥ with arrows and backspace edit the line like VS Code\'s terminal', () => {
	assert.deepEqual(terminalKeyAction(key('ArrowLeft', 'm'), 'mac', false), { kind: 'send', data: '\x01' });
	assert.deepEqual(terminalKeyAction(key('ArrowRight', 'm'), 'mac', false), { kind: 'send', data: '\x05' });
	assert.deepEqual(terminalKeyAction(key('Backspace', 'm'), 'mac', false), { kind: 'send', data: '\x15' });
	assert.deepEqual(terminalKeyAction(key('ArrowLeft', 'a'), 'mac', false), { kind: 'send', data: '\x1bb' });
	assert.deepEqual(terminalKeyAction(key('ArrowRight', 'a'), 'mac', false), { kind: 'send', data: '\x1bf' });
	// With another modifier it is xterm's to encode.
	assert.equal(kind(key('ArrowLeft', 'as'), 'mac'), 'xterm');
});

test('on Windows and Linux Ctrl+C copies only when there is a selection, otherwise it interrupts', () => {
	for (const platform of ['win', 'linux'] as const) {
		assert.equal(kind(key('c', 'c'), platform, true), 'copy');
		assert.equal(kind(key('c', 'c'), platform, false), 'xterm');
		assert.equal(kind(key('C', 'cs'), platform, false), 'copy');
		assert.equal(kind(key('V', 'cs'), platform), 'paste');
		assert.equal(kind(key('v', 'c'), platform), 'paste');
		assert.equal(kind(key('Insert', 's'), platform), 'paste');
		assert.equal(kind(key('Insert', 'c'), platform), 'copy');
	}
});

test('on Windows and Linux the workbench keeps the palette, the views and the editor switcher', () => {
	for (const platform of ['win', 'linux'] as const) {
		for (const e of [key('P', 'cs'), key('E', 'cs'), key('F', 'cs'), key('F1'), key('Tab', 'c'), key('Tab', 'cs'), key('PageUp', 'c'), key('PageDown', 'c'), key('`', 'c')]) {
			assert.equal(kind(e, platform), 'passthrough', `${platform} ${JSON.stringify(e)}`);
		}
	}
	// Ctrl+P and Ctrl+W without Shift are readline's and the shell's.
	assert.equal(kind(key('p', 'c'), 'linux'), 'xterm');
	assert.equal(kind(key('w', 'c'), 'win'), 'xterm');
});

test('AltGr arrives as Ctrl+Alt and types characters: it is never a chord', () => {
	assert.equal(kind(key('v', 'ca'), 'win'), 'xterm');
	assert.equal(kind(key('@', 'ca'), 'win'), 'xterm');
});

test('an input method\'s composition keys are its own', () => {
	assert.equal(kind(key('c', 'm', { isComposing: true }), 'mac'), 'xterm');
	assert.equal(kind(key('Process', '', { keyCode: 229 }), 'win'), 'xterm');
});

test('F1 and the editor switcher pass through on a Mac as well', () => {
	assert.equal(kind(key('F1'), 'mac'), 'passthrough');
	assert.equal(kind(key('Tab', 'c'), 'mac'), 'passthrough');
	assert.equal(kind(key('PageDown', 'c'), 'mac'), 'passthrough');
});
