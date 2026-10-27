import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { mintTerminalGrant, keyBytes, normalizeKeyName, planKeys, terminalInputFingerprint, terminalKeyNames, terminalMaxKeys, terminalMaxText, typedTextProblem } from './terminalInput.ts';

describe('named keys', () => {
	test('every listed name has bytes, and ctrl keys are code minus 64', () => {
		for (const name of terminalKeyNames) {
			assert.ok(keyBytes(name) !== undefined, name);
		}
		assert.strictEqual(keyBytes('ctrl-a'), '\x01');
		assert.strictEqual(keyBytes('ctrl-c'), '\x03');
		assert.strictEqual(keyBytes('ctrl-d'), '\x04');
		assert.strictEqual(keyBytes('ctrl-z'), '\x1a');
		assert.strictEqual(terminalKeyNames.filter(n => n.startsWith('ctrl-')).length, 26);
		assert.strictEqual(terminalKeyNames.filter(n => /^f\d+$/.test(n)).length, 12);
	});

	test('the bytes of the common keys', () => {
		assert.strictEqual(keyBytes('enter'), '\r');
		assert.strictEqual(keyBytes('esc'), '\x1b');
		assert.strictEqual(keyBytes('backspace'), '\x7f');
		assert.strictEqual(keyBytes('tab'), '\t');
		assert.strictEqual(keyBytes('shift-tab'), '\x1b[Z');
		assert.strictEqual(keyBytes('up'), '\x1b[A');
		assert.strictEqual(keyBytes('down'), '\x1b[B');
		assert.strictEqual(keyBytes('right'), '\x1b[C');
		assert.strictEqual(keyBytes('left'), '\x1b[D');
		assert.strictEqual(keyBytes('delete'), '\x1b[3~');
		assert.strictEqual(keyBytes('f5'), '\x1b[15~');
		assert.strictEqual(keyBytes('f12'), '\x1b[24~');
	});

	test('spellings a model uses are the same key, and nothing else is', () => {
		assert.strictEqual(normalizeKeyName(' Escape '), 'esc');
		assert.strictEqual(normalizeKeyName('Return'), 'enter');
		assert.strictEqual(normalizeKeyName('Ctrl+C'), 'ctrl-c');
		assert.strictEqual(normalizeKeyName('control-d'), 'ctrl-d');
		assert.strictEqual(normalizeKeyName('^z'), 'ctrl-z');
		assert.strictEqual(normalizeKeyName('PgDn'), 'pagedown');
		assert.strictEqual(normalizeKeyName('ctrl-1'), undefined);
		assert.strictEqual(normalizeKeyName('ctrl-ab'), undefined);
		assert.strictEqual(normalizeKeyName('f13'), undefined);
		// Names that exist on every object are not keys.
		assert.strictEqual(normalizeKeyName('constructor'), undefined);
		assert.strictEqual(normalizeKeyName('__proto__'), undefined);
		assert.strictEqual(keyBytes('toString'), undefined);
	});

	test('planKeys joins the bytes in order and refuses what it cannot send', () => {
		const plan = planKeys(['Up', 'ctrl-c', 'enter']);
		assert.ok(plan.ok);
		assert.deepStrictEqual(plan.names, ['up', 'ctrl-c', 'enter']);
		assert.strictEqual(plan.bytes, '\x1b[A\x03\r');

		for (const bad of [undefined, 'enter', [], [1], ['enter', 'nope'], [['enter']], null]) {
			const refused = planKeys(bad);
			assert.strictEqual(refused.ok, false, JSON.stringify(bad));
		}
		const unknown = planKeys(['hyper-x']);
		assert.ok(!unknown.ok && unknown.error.includes('hyper-x') && unknown.error.includes('ctrl-c'));
		assert.ok(planKeys(Array(terminalMaxKeys).fill('tab')).ok);
		assert.ok(!planKeys(Array(terminalMaxKeys + 1).fill('tab')).ok);
	});

	test('a long unknown key name is cut in the refusal', () => {
		const refused = planKeys(['x'.repeat(500)]);
		assert.ok(!refused.ok && refused.error.length < 600);
	});
});

describe('typedTextProblem', () => {
	test('a plain line is fine, Unicode included', () => {
		assert.strictEqual(typedTextProblem('git status --short'), undefined);
		assert.strictEqual(typedTextProblem('echo "héllo wörld" 日本語 🙂'), undefined);
		assert.strictEqual(typedTextProblem(''), undefined);
	});

	test('line breaks are refused and say what to do', () => {
		for (const text of ['a\nb', 'a\rb', 'ls\n']) {
			const problem = typedTextProblem(text);
			assert.ok(problem?.includes('one line'), JSON.stringify(text));
		}
	});

	test('every control character is refused: C0, DEL, C1, ESC, separators, bidi', () => {
		const bad = ['\x00', '\x07', '\t', '\x1b', '\x1b[201~', '\x7f', '\x80', '\x9b', '\x9f', ...[0x2028, 0x2029, 0x202e, 0x2066, 0x200f].map(c => String.fromCharCode(c))];
		for (const c of bad) {
			assert.ok(typedTextProblem(`ls ${c}x`), JSON.stringify(c));
		}
		// The first refused character is named by its code point.
		assert.ok(typedTextProblem('a\x1bb')!.includes('U+001B'));
	});

	test('length is bounded', () => {
		assert.strictEqual(typedTextProblem('x'.repeat(terminalMaxText)), undefined);
		assert.ok(typedTextProblem('x'.repeat(terminalMaxText + 1))?.includes(String(terminalMaxText)));
	});
});

describe('terminalInputFingerprint', () => {
	const send = (args: unknown) => terminalInputFingerprint('terminal_send', args);
	const key = (args: unknown) => terminalInputFingerprint('terminal_key', args);

	test('a send is the terminal, the text and whether Enter follows', () => {
		assert.strictEqual(send({ terminalId: 't1', text: 'ls' }), JSON.stringify(['t1', 'ls', true]));
		assert.strictEqual(send({ terminalId: 't1', text: 'ls', enter: true }), send({ terminalId: 't1', text: 'ls' }), 'enter defaults to true');
		assert.notStrictEqual(send({ terminalId: 't1', text: 'ls', enter: false }), send({ terminalId: 't1', text: 'ls' }));
		assert.notStrictEqual(send({ terminalId: 't1', text: 'ls -a' }), send({ terminalId: 't1', text: 'ls' }));
		assert.notStrictEqual(send({ terminalId: 't2', text: 'ls' }), send({ terminalId: 't1', text: 'ls' }));
		assert.strictEqual(send({ terminalId: ' t1 ', text: 'ls' }), send({ terminalId: 't1', text: 'ls' }), 'the id is trimmed');
	});

	test('text is not trimmed: a trailing space is a different input', () => {
		assert.notStrictEqual(send({ terminalId: 't1', text: 'ls ' }), send({ terminalId: 't1', text: 'ls' }));
	});

	test('a number the model meant as text is text; extra arguments are not part of it', () => {
		assert.strictEqual(send({ terminalId: 't1', text: 5 }), send({ terminalId: 't1', text: '5' }));
		assert.strictEqual(send({ terminalId: 't1', text: 'ls', waitMs: 9000 }), send({ terminalId: 't1', text: 'ls' }));
	});

	test('keys are matched by their canonical names', () => {
		assert.strictEqual(key({ terminalId: 't1', keys: ['Up', 'Return'] }), JSON.stringify(['t1', ['up', 'enter']]));
		assert.strictEqual(key({ terminalId: 't1', keys: ['up', 'enter'] }), key({ terminalId: 't1', keys: ['Up', 'Return'] }));
		assert.notStrictEqual(key({ terminalId: 't1', keys: ['enter', 'up'] }), key({ terminalId: 't1', keys: ['up', 'enter'] }));
	});

	test('arguments that are not a valid call have no fingerprint', () => {
		assert.strictEqual(send(undefined), undefined);
		assert.strictEqual(send([]), undefined);
		assert.strictEqual(send({ text: 'ls' }), undefined, 'no terminal');
		assert.strictEqual(send({ terminalId: 't1', text: { a: 1 } }), undefined);
		assert.strictEqual(send({ terminalId: 't1', text: 'ls', enter: 'false' }), undefined, 'a string is not a boolean');
		assert.strictEqual(key({ terminalId: 't1', keys: ['nope'] }), undefined);
		assert.strictEqual(key({ terminalId: 't1' }), undefined);
	});
});

describe('mintTerminalGrant', () => {
	function store() {
		const minted: { chatId: string; tool: string; fingerprint?: string }[] = [];
		return { minted, mint: (chatId: string, tool: string, fingerprint?: string) => { minted.push({ chatId, tool, fingerprint }); } };
	}

	test('an input approved with readable arguments gets an exact grant', () => {
		const grants = store();
		assert.strictEqual(mintTerminalGrant(grants, 'c1', { tool: 'terminal_send', args: { terminalId: 't1', text: 'ls' } }), true);
		assert.deepStrictEqual(grants.minted, [{ chatId: 'c1', tool: 'terminal_send', fingerprint: terminalInputFingerprint('terminal_send', { terminalId: 't1', text: 'ls' }) }]);
	});

	test('arguments the CLI did not show give a wildcard', () => {
		const grants = store();
		assert.strictEqual(mintTerminalGrant(grants, 'c1', { tool: 'terminal_key' }), true);
		assert.deepStrictEqual(grants.minted, [{ chatId: 'c1', tool: 'terminal_key', fingerprint: undefined }]);
	});

	test('arguments that are not a valid call, a read and another tool mint nothing', () => {
		const grants = store();
		assert.strictEqual(mintTerminalGrant(grants, 'c1', { tool: 'terminal_send', args: { terminalId: 't1', text: { x: 1 } } }), false);
		assert.strictEqual(mintTerminalGrant(grants, 'c1', { tool: 'terminal_key', args: { terminalId: 't1', keys: ['nope'] } }), false);
		assert.strictEqual(mintTerminalGrant(grants, 'c1', { tool: 'terminal_read', read: true, args: { terminalId: 't1' } }), false);
		assert.strictEqual(mintTerminalGrant(grants, 'c1', { tool: 'browser_click', args: {} }), false);
		assert.strictEqual(grants.minted.length, 0);
	});
});
