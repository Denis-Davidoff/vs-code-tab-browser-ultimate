import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
	CTRL_LETTERS, DRAWER_ROWS, KEY_ROWS, KeyRepeat, PROXY_SENTINEL, StickyModifiers, ctrlChar, keyDefSequence, keyEventSequence, modParam, namedKeySequence,
	noMods, proxyInput, repeatDelayMs, repeatFastAfter, repeatFastIntervalMs, repeatIntervalMs, sequenceWithMods, textSequence,
	type KeyDef, type KeyModes, type Modifiers, type NamedKey,
} from './terminalMobileKeys.ts';

const normal: KeyModes = { applicationCursorKeys: false };
const app: KeyModes = { applicationCursorKeys: true };
const mods = (s: string): Modifiers => ({ ctrl: s.includes('c'), alt: s.includes('a'), shift: s.includes('s') });
const E = '\x1b';

test('the modifier parameter is 1 + shift + 2 alt + 4 ctrl', () => {
	assert.equal(modParam(noMods), 1);
	assert.equal(modParam(mods('s')), 2);
	assert.equal(modParam(mods('a')), 3);
	assert.equal(modParam(mods('c')), 5);
	assert.equal(modParam(mods('cas')), 8);
});

test('plain arrows, Home and End follow application cursor keys mode (DECCKM); modified ones do not', () => {
	for (const [key, final] of [['ArrowUp', 'A'], ['ArrowDown', 'B'], ['ArrowRight', 'C'], ['ArrowLeft', 'D'], ['Home', 'H'], ['End', 'F']] as const) {
		assert.equal(namedKeySequence(key, noMods, normal), `${E}[${final}`, key);
		assert.equal(namedKeySequence(key, noMods, app), `${E}O${final}`, key);
		assert.equal(namedKeySequence(key, mods('c'), normal), `${E}[1;5${final}`, key);
		assert.equal(namedKeySequence(key, mods('c'), app), `${E}[1;5${final}`, `${key} ignores DECCKM when modified`);
	}
	assert.equal(namedKeySequence('ArrowUp', mods('s'), normal), `${E}[1;2A`);
	assert.equal(namedKeySequence('ArrowLeft', mods('a'), app), `${E}[1;3D`);
});

test('paging, editing and function keys use xterm\'s numbers', () => {
	assert.equal(namedKeySequence('PageUp', noMods, normal), `${E}[5~`);
	assert.equal(namedKeySequence('PageDown', noMods, normal), `${E}[6~`);
	assert.equal(namedKeySequence('Delete', noMods, normal), `${E}[3~`);
	assert.equal(namedKeySequence('Insert', noMods, normal), `${E}[2~`);
	assert.equal(namedKeySequence('Delete', mods('c'), normal), `${E}[3;5~`);
	const numbers: [NamedKey, string][] = [['F5', '15'], ['F6', '17'], ['F7', '18'], ['F8', '19'], ['F9', '20'], ['F10', '21'], ['F11', '23'], ['F12', '24']];
	for (const [key, n] of numbers) {
		assert.equal(namedKeySequence(key, noMods, normal), `${E}[${n}~`, key);
		assert.equal(namedKeySequence(key, mods('s'), normal), `${E}[${n};2~`, key);
	}
	for (const [key, f] of [['F1', 'P'], ['F2', 'Q'], ['F3', 'R'], ['F4', 'S']] as const) {
		assert.equal(namedKeySequence(key, noMods, app), `${E}O${f}`, key);
		assert.equal(namedKeySequence(key, mods('c'), app), `${E}[1;5${f}`, key);
	}
});

test('Tab, Enter, Backspace and Escape', () => {
	assert.equal(namedKeySequence('Tab', noMods, normal), '\t');
	assert.equal(namedKeySequence('Tab', mods('s'), normal), `${E}[Z`, 'Shift+Tab');
	assert.equal(namedKeySequence('Tab', mods('a'), normal), `${E}\t`);
	assert.equal(namedKeySequence('Enter', noMods, normal), '\r');
	assert.equal(namedKeySequence('Enter', mods('a'), normal), `${E}\r`);
	assert.equal(namedKeySequence('Backspace', noMods, normal), '\x7f');
	assert.equal(namedKeySequence('Backspace', mods('c'), normal), '\x08');
	assert.equal(namedKeySequence('Backspace', mods('a'), normal), `${E}\x7f`);
	assert.equal(namedKeySequence('Escape', noMods, normal), E);
	assert.equal(namedKeySequence('Escape', mods('a'), normal), `${E}${E}`);
});

test('Ctrl on a character is xterm\'s control character', () => {
	assert.equal(ctrlChar('a'), '\x01');
	assert.equal(ctrlChar('C'), '\x03');
	assert.equal(ctrlChar('z'), '\x1a');
	for (const ch of [' ', '@', '2']) { assert.equal(ctrlChar(ch), '\x00', ch); }
	for (const ch of ['[', '3']) { assert.equal(ctrlChar(ch), '\x1b', ch); }
	for (const ch of ['\\', '4']) { assert.equal(ctrlChar(ch), '\x1c', ch); }
	for (const ch of [']', '5']) { assert.equal(ctrlChar(ch), '\x1d', ch); }
	for (const ch of ['^', '6']) { assert.equal(ctrlChar(ch), '\x1e', ch); }
	for (const ch of ['_', '/', '-', '7']) { assert.equal(ctrlChar(ch), '\x1f', ch); }
	for (const ch of ['?', '8']) { assert.equal(ctrlChar(ch), '\x7f', ch); }
	assert.equal(ctrlChar('é'), undefined);
	assert.equal(ctrlChar('ab'), undefined);
	assert.equal(ctrlChar('1'), undefined);
});

test('text with modifiers: Ctrl, Alt as an escape prefix, Shift uppercases, and only the first code point is touched', () => {
	assert.equal(textSequence('c', mods('c')), '\x03');
	assert.equal(textSequence('b', mods('a')), `${E}b`);
	assert.equal(textSequence('b', mods('ca')), `${E}\x02`);
	assert.equal(textSequence('b', mods('s')), 'B');
	assert.equal(textSequence('1', mods('s')), '1');
	assert.equal(textSequence('x', noMods), 'x');
	assert.equal(textSequence('', mods('c')), '');
	assert.equal(textSequence('é', mods('c')), 'é', 'Ctrl on a character with no control form is consumed, the character kept');
	// A non-BMP character is one code point, not two surrogates.
	assert.equal(textSequence('\u{1F600}', mods('a')), `${E}\u{1F600}`);
	// An IME word or a paste: the modifier applies to the first character only.
	assert.equal(textSequence('cat', mods('c')), '\x03at');
	assert.equal(textSequence('cat', mods('a')), `${E}cat`);
	assert.equal(textSequence('\u{1F600}x', mods('a')), `${E}\u{1F600}x`);
});

test('sticky modifiers reach the data xterm produced: sequences get the parameter, text gets the byte', () => {
	assert.equal(sequenceWithMods('a', noMods), 'a');
	assert.equal(sequenceWithMods('c', mods('c')), '\x03');
	assert.equal(sequenceWithMods(`${E}[A`, mods('c')), `${E}[1;5A`);
	assert.equal(sequenceWithMods(`${E}OA`, mods('c')), `${E}[1;5A`, 'application mode arrow');
	assert.equal(sequenceWithMods(`${E}[H`, mods('s')), `${E}[1;2H`);
	assert.equal(sequenceWithMods(`${E}[3~`, mods('c')), `${E}[3;5~`);
	assert.equal(sequenceWithMods(`${E}OP`, mods('c')), `${E}[1;5P`);
	// xterm already put Ctrl in it (a hardware key held with a sticky Alt): the two are merged.
	assert.equal(sequenceWithMods(`${E}[1;5A`, mods('a')), `${E}[1;7A`);
	assert.equal(sequenceWithMods(`${E}[5;5~`, mods('s')), `${E}[5;6~`);
	assert.equal(sequenceWithMods('\t', mods('s')), `${E}[Z`);
	assert.equal(sequenceWithMods('\r', mods('a')), `${E}\r`);
	assert.equal(sequenceWithMods('\x7f', mods('c')), '\x08');
	assert.equal(sequenceWithMods(E, mods('a')), `${E}${E}`);
	// Any other escape sequence (a bracketed paste marker, a mouse report) is left alone.
	assert.equal(sequenceWithMods(`${E}[200~`, mods('c')), `${E}[200~`, 'the bracketed-paste markers are not keys');
	assert.equal(sequenceWithMods(`${E}[201~`, mods('a')), `${E}[201~`);
	assert.equal(sequenceWithMods(`${E}[<0;5;5M`, mods('c')), `${E}[<0;5;5M`);
});

test('a hardware keyboard on the proxy: named keys, Ctrl and Alt chords, and what is left to the input event', () => {
	const ev = (key: string, o: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; isComposing: boolean; keyCode: number }> = {}) =>
		({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o });
	assert.equal(keyEventSequence(ev('ArrowUp'), normal), `${E}[A`);
	assert.equal(keyEventSequence(ev('ArrowUp'), app), `${E}OA`);
	assert.equal(keyEventSequence(ev('ArrowUp', { ctrlKey: true }), app), `${E}[1;5A`);
	assert.equal(keyEventSequence(ev('Tab', { shiftKey: true }), normal), `${E}[Z`);
	assert.equal(keyEventSequence(ev('Enter'), normal), '\r');
	assert.equal(keyEventSequence(ev('c', { ctrlKey: true }), normal), '\x03');
	assert.equal(keyEventSequence(ev('C', { ctrlKey: true, shiftKey: true }), normal), '\x03');
	assert.equal(keyEventSequence(ev('b', { altKey: true }), normal), `${E}b`);
	assert.equal(keyEventSequence(ev('a'), normal), undefined, 'a plain character is the input event\'s');
	assert.equal(keyEventSequence(ev('A', { shiftKey: true }), normal), undefined);
	assert.equal(keyEventSequence(ev('c', { metaKey: true }), normal), undefined);
	assert.equal(keyEventSequence(ev('Enter', { isComposing: true }), normal), undefined);
	assert.equal(keyEventSequence(ev('Unidentified', { keyCode: 229 }), normal), undefined);
	assert.equal(keyEventSequence(ev('Shift'), normal), undefined);
	// AltGr (Ctrl+Alt) typing a symbol is text.
	assert.equal(keyEventSequence(ev('€', { ctrlKey: true, altKey: true }), normal), undefined);
	// A sticky modifier applies to a plain character, and a sticky shift to a named key.
	assert.equal(keyEventSequence(ev('d'), normal, mods('c')), '\x04');
	assert.equal(keyEventSequence(ev('a'), normal, mods('s')), 'A');
	assert.equal(keyEventSequence(ev('ArrowLeft'), normal, mods('s')), `${E}[1;2D`);
});

test('proxy input: the sentinel, deletes, line breaks, and no control characters', () => {
	assert.equal(PROXY_SENTINEL, ' ');
	assert.equal(proxyInput(' a'), 'a');
	assert.equal(proxyInput(' hello'), 'hello');
	assert.equal(proxyInput('a'), 'a', 'a selection replaced the sentinel');
	assert.equal(proxyInput('  '), ' ', 'a typed space after the sentinel');
	assert.equal(proxyInput(''), '\x7f', 'the sentinel was deleted: Backspace');
	assert.equal(proxyInput(' ', 'deleteContentBackward'), '\x7f');
	assert.equal(proxyInput('', 'deleteContentBackward'), '\x7f');
	assert.equal(proxyInput(' ', 'deleteContentForward'), `${E}[3~`);
	assert.equal(proxyInput(' ', 'deleteWordBackward'), '\x17');
	assert.equal(proxyInput(' ', 'insertLineBreak'), '\r');
	assert.equal(proxyInput(' ', 'insertParagraph'), '\r');
	assert.equal(proxyInput(' ls\n'), 'ls\r');
	assert.equal(proxyInput(' a\r\nb'), 'a\rb');
	assert.equal(proxyInput(' a\tb'), 'a\tb');
	assert.equal(proxyInput(` a${E}[201~b\x00`), 'a[201~b', 'no ESC and no other control character');
	assert.equal(proxyInput(' \u{1F600}'), '\u{1F600}');
	assert.equal(proxyInput(' \u009b31m'), '31m', 'C1 controls are dropped too');
});

test('sticky modifiers: off, armed, locked by a second tap within 400 ms, off again', () => {
	const s = new StickyModifiers();
	assert.equal(s.state('ctrl'), 'off');
	assert.equal(s.tap('ctrl', 1000), 'armed');
	assert.deepEqual(s.snapshot(), { ctrl: true, alt: false, shift: false });
	assert.equal(s.tap('ctrl', 1300), 'locked');
	assert.equal(s.tap('ctrl', 5000), 'off', 'a tap on a locked one releases it');
	assert.equal(s.state('ctrl'), 'off');
	// A second tap too late disarms instead of locking.
	assert.equal(s.tap('alt', 1000), 'armed');
	assert.equal(s.tap('alt', 1401), 'off');
	assert.equal(s.tap('alt', 2000), 'armed');
	assert.equal(s.tap('alt', 2400), 'locked', 'exactly 400 ms still locks');
});

test('consume uses up an armed modifier and keeps a locked one', () => {
	const s = new StickyModifiers();
	s.tap('ctrl', 0);
	s.tap('shift', 0);
	s.tap('shift', 100);
	assert.deepEqual(s.consume(), { ctrl: true, alt: false, shift: true });
	assert.equal(s.state('ctrl'), 'off');
	assert.equal(s.state('shift'), 'locked');
	assert.deepEqual(s.consume(), { ctrl: false, alt: false, shift: true });
	assert.equal(s.active, true);
	s.clear();
	assert.equal(s.active, false);
	assert.deepEqual(s.consume(), noMods);
});

function fakeTimers() {
	let now = 0;
	let nextId = 1;
	const pending = new Map<number, { at: number; fn: () => void }>();
	return {
		timers: {
			set: (fn: () => void, ms: number) => { const id = nextId++; pending.set(id, { at: now + ms, fn }); return id; },
			clear: (id: unknown) => { pending.delete(id as number); },
		},
		advance(ms: number) {
			const end = now + ms;
			for (;;) {
				let due: [number, { at: number; fn: () => void }] | undefined;
				for (const entry of pending) { if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) { due = entry; } }
				if (!due) { break; }
				pending.delete(due[0]);
				now = due[1].at;
				due[1].fn();
			}
			now = end;
		},
		get pending() { return pending.size; },
	};
}

test('holding a key repeats it after a delay, then at an interval that speeds up', () => {
	const clock = fakeTimers();
	const repeat = new KeyRepeat(clock.timers);
	let count = 0;
	repeat.start(() => count++);
	assert.equal(count, 1, 'once at once');
	clock.advance(repeatDelayMs - 1);
	assert.equal(count, 1);
	clock.advance(1);
	assert.equal(count, 2, 'then after the delay');
	clock.advance(repeatIntervalMs);
	assert.equal(count, 3);
	// Up to repeatFastAfter repeats at the slow interval, then the fast one.
	clock.advance(repeatIntervalMs * repeatFastAfter);
	const before = count;
	clock.advance(repeatFastIntervalMs * 4);
	assert.equal(count - before, 4, 'four fast intervals, four sends');
	repeat.stop();
});

test('stop is idempotent and nothing is sent after it', () => {
	const clock = fakeTimers();
	const repeat = new KeyRepeat(clock.timers);
	let count = 0;
	repeat.start(() => count++);
	clock.advance(repeatDelayMs + repeatIntervalMs * 3);
	const at = count;
	assert.ok(at >= 4);
	repeat.stop();
	repeat.stop();
	assert.equal(repeat.running, false);
	assert.equal(clock.pending, 0);
	clock.advance(10_000);
	assert.equal(count, at);
	// A new start after a stop begins from the slow cadence again.
	repeat.start(() => count++);
	assert.equal(count, at + 1);
	repeat.stop();
});

test('starting a repeat while another runs stops the first', () => {
	const clock = fakeTimers();
	const repeat = new KeyRepeat(clock.timers);
	let a = 0, b = 0;
	repeat.start(() => a++);
	repeat.start(() => b++);
	clock.advance(repeatDelayMs + repeatIntervalMs);
	assert.equal(a, 1, 'the first only ever fired its immediate call');
	assert.equal(b, 3);
	repeat.stop();
});

function allKeys(): KeyDef[] {
	return [...KEY_ROWS, ...DRAWER_ROWS].flat();
}

test('every key of the layout has a label and an accessible name, and the two main rows are eight wide', () => {
	for (const key of allKeys()) {
		assert.ok(key.label.length > 0, JSON.stringify(key));
		assert.ok(key.aria.length > 0, JSON.stringify(key));
	}
	assert.equal(KEY_ROWS.length, 2);
	for (const row of KEY_ROWS) { assert.equal(row.length, 8); }
	for (const row of DRAWER_ROWS) { assert.equal(row.length, 8); }
	const names = allKeys().map(k => k.aria);
	assert.equal(new Set(names).size, names.length, 'accessible names are unique');
});

test('the layout sends the right bytes', () => {
	const find = (aria: string) => allKeys().find(k => k.aria === aria)!;
	assert.equal(keyDefSequence(find('Arrow up'), noMods, normal), `${E}[A`);
	assert.equal(keyDefSequence(find('Arrow up'), noMods, app), `${E}OA`);
	assert.equal(keyDefSequence(find('Arrow left'), mods('c'), app), `${E}[1;5D`);
	assert.equal(keyDefSequence(find('Escape'), noMods, normal), E);
	assert.equal(keyDefSequence(find('Tab'), noMods, normal), '\t');
	assert.equal(keyDefSequence(find('Shift Tab'), noMods, normal), `${E}[Z`);
	assert.equal(keyDefSequence(find('Control C'), noMods, normal), '\x03');
	assert.equal(keyDefSequence(find('Control D'), mods('a'), normal), '\x04', 'a control character is not modified again');
	assert.equal(keyDefSequence(find('Control L'), noMods, normal), '\x0c');
	assert.equal(keyDefSequence(find('Control R'), noMods, normal), '\x12');
	assert.equal(keyDefSequence(find('Slash'), noMods, normal), '/');
	assert.equal(keyDefSequence(find('Slash'), mods('c'), normal), '\x1f');
	assert.equal(keyDefSequence(find('Vertical bar'), noMods, normal), '|');
	assert.equal(keyDefSequence(find('Page up'), noMods, normal), `${E}[5~`);
	assert.equal(keyDefSequence(find('Enter'), noMods, normal), '\r');
	assert.equal(keyDefSequence(find('Control, sticky'), noMods, normal), undefined);
	assert.equal(keyDefSequence(find('More keys'), noMods, normal), undefined);
	// Only the keys a finger holds repeat: arrows, paging, Delete.
	const repeating = allKeys().filter(k => k.kind === 'named' && k.repeat).map(k => k.kind === 'named' ? k.key : '');
	assert.deepEqual(repeating.sort(), ['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'Delete', 'PageDown', 'PageUp']);
});

test('every control key of the drawer is a real control character', () => {
	for (const key of allKeys()) {
		if (key.kind !== 'data' || !key.label.startsWith('^')) { continue; }
		assert.equal(key.data, String.fromCharCode(key.label.charCodeAt(1) & 0x1f), key.label);
	}
	for (const letter of CTRL_LETTERS) { assert.ok(ctrlChar(letter), letter); }
});
