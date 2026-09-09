/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { grantProposedApi, maskJsonc } from './argvJson.ts';

const ID = 'DenysDavydov.tab-browser-ultimate';

/** The file every editor ships, trimmed to the shape that matters. */
const SHIPPED = `// This configuration file allows you to pass permanent command line arguments to VS Code.
//
// PLEASE DO NOT CHANGE WITHOUT UNDERSTANDING THE IMPACT
{
	// Use software rendering instead of hardware accelerated rendering.
	// "disable-hardware-acceleration": true,

	// Allows to disable crash reporting.
	"enable-crash-reporter": true,

	// Unique id used for correlating crash reports sent from this instance.
	"crash-reporter-id": "55f975d5-c8ec-485f-9a90-5a6d8e17c6be"
}
`;

suite('maskJsonc', () => {

	test('blanks line comments but keeps offsets', () => {
		const text = '{\n\t// "enable-proposed-api": ["x"]\n}';
		const mask = maskJsonc(text);
		assert.strictEqual(mask.length, text.length);
		assert.ok(!mask.includes('enable-proposed-api'));
		assert.strictEqual(mask.indexOf('{'), text.indexOf('{'));
	});

	test('blanks block comments but keeps newlines', () => {
		const text = '/* a\n b */\n{}';
		const mask = maskJsonc(text);
		assert.strictEqual(mask.length, text.length);
		assert.ok(!mask.includes('a'));
		assert.strictEqual(mask.split('\n').length, text.split('\n').length);
	});

	test('a // inside a string does not open a comment', () => {
		const text = '{"url": "http://h/x", "k": 1}';
		const mask = maskJsonc(text);
		// Contents are blanked, quotes are not, so the key one char wide reads
		// as `" "` — what matters is that it is still there and still at its
		// own offset, which a comment starting at `//` would have eaten.
		assert.ok(mask.startsWith('" "', text.indexOf('"k"')), mask);
		assert.ok(mask.trimEnd().endsWith('1}'), 'the value past the URL survives');
	});

	test('an escaped quote does not end the string', () => {
		const text = '{"a": "x\\"y", "b": 1}';
		const mask = maskJsonc(text);
		assert.ok(mask.startsWith('" "', text.indexOf('"b"')), mask);
		assert.strictEqual(mask.length, text.length);
	});
});

suite('grantProposedApi', () => {

	test('adds the key to the file editors actually ship', () => {
		const { text, changed, alreadyListed } = grantProposedApi(SHIPPED, ID);
		assert.ok(changed);
		assert.ok(!alreadyListed);
		assert.deepStrictEqual(JSON.parse(strip(text))['enable-proposed-api'], [ID]);
	});

	test('every comment survives, including the warning header', () => {
		const { text } = grantProposedApi(SHIPPED, ID);
		assert.ok(text.includes('PLEASE DO NOT CHANGE WITHOUT UNDERSTANDING THE IMPACT'));
		assert.ok(text.includes('// "disable-hardware-acceleration": true,'));
		assert.ok(text.includes('// Unique id used for correlating crash reports'));
	});

	test('existing settings are preserved', () => {
		const parsed = JSON.parse(strip(grantProposedApi(SHIPPED, ID).text));
		assert.strictEqual(parsed['enable-crash-reporter'], true);
		assert.strictEqual(parsed['crash-reporter-id'], '55f975d5-c8ec-485f-9a90-5a6d8e17c6be');
	});

	test('a commented-out switch is not mistaken for a live one', () => {
		const source = '{\n\t// "enable-proposed-api": ["someone.else"],\n\t"enable-crash-reporter": true\n}\n';
		const { text } = grantProposedApi(source, ID);
		// The live key is added; the example stays an example.
		assert.deepStrictEqual(JSON.parse(strip(text))['enable-proposed-api'], [ID]);
		assert.ok(text.includes('// "enable-proposed-api": ["someone.else"],'));
	});

	test('appends to an existing array, keeping the other extension', () => {
		const source = '{\n\t"enable-proposed-api": ["other.ext"]\n}\n';
		const { text, changed } = grantProposedApi(source, ID);
		assert.ok(changed);
		assert.deepStrictEqual(JSON.parse(strip(text))['enable-proposed-api'], ['other.ext', ID]);
	});

	test('appends inside a multi-line array without moving the bracket', () => {
		const source = '{\n\t"enable-proposed-api": [\n\t\t"other.ext"\n\t]\n}\n';
		const { text } = grantProposedApi(source, ID);
		assert.deepStrictEqual(JSON.parse(strip(text))['enable-proposed-api'], ['other.ext', ID]);
		assert.ok(text.trimEnd().endsWith('}'));
	});

	test('an empty array is filled without a stray comma', () => {
		const { text } = grantProposedApi('{\n\t"enable-proposed-api": []\n}\n', ID);
		assert.deepStrictEqual(JSON.parse(strip(text))['enable-proposed-api'], [ID]);
	});

	test('already listed is a no-op, not a duplicate', () => {
		const source = `{\n\t"enable-proposed-api": [${JSON.stringify(ID)}]\n}\n`;
		const { text, changed, alreadyListed } = grantProposedApi(source, ID);
		assert.ok(!changed);
		assert.ok(alreadyListed);
		assert.strictEqual(text, source);
	});

	test('an empty file becomes a valid one', () => {
		const { text, changed } = grantProposedApi('', ID);
		assert.ok(changed);
		assert.deepStrictEqual(JSON.parse(text)['enable-proposed-api'], [ID]);
	});

	test('an empty object gets the key', () => {
		const { text } = grantProposedApi('{}\n', ID);
		assert.deepStrictEqual(JSON.parse(strip(text))['enable-proposed-api'], [ID]);
	});

	test('the file indentation is copied rather than assumed', () => {
		const source = '{\n    "enable-crash-reporter": true\n}\n';
		const { text } = grantProposedApi(source, ID);
		assert.ok(text.includes('\n    "enable-proposed-api"'), text);
	});

	test('a trailing comma is left alone — real argv.json files have one', () => {
		// `~/.vscode/argv.json` on a machine here ends `"crash-reporter-id": "…",`
		// followed by `}`. Legal JSONC, not legal JSON, and inserting after the
		// opening brace has to stay clear of it.
		const source = '{\n\t"crash-reporter-id": "abc",\n}\n';
		const { text } = grantProposedApi(source, ID);
		assert.ok(text.includes('"enable-proposed-api": ["DenysDavydov.tab-browser-ultimate"],'));
		assert.ok(text.includes('"crash-reporter-id": "abc",'), 'the existing entry is untouched');
		assert.ok(!text.includes(',,'));
	});

	test("a neighbouring array is never mistaken for our value", () => {
		// The loose "next `[` after the key" search appended into `js-flags`
		// and reported success: someone else's setting rewritten, our grant
		// still missing, and the not-an-array guard never firing.
		const source = '{\n\t"enable-proposed-api": true,\n\t"js-flags": ["--harmony"]\n}\n';
		assert.throws(() => grantProposedApi(source, ID), /not an array/);
		// And the neighbour is untouched, since nothing was written.
		assert.ok(source.includes('["--harmony"]'));
	});

	test('a trailing comma inside the array is legal JSONC and is accepted', () => {
		const { text, changed } = grantProposedApi('{\n\t"enable-proposed-api": ["other.ext",]\n}\n', ID);
		assert.ok(changed);
		assert.ok(text.includes(`"other.ext", ${JSON.stringify(ID)},`), text);
		assert.ok(!text.includes(',,'), 'no double comma');
	});

	test('a comment inside the array does not swallow the appended id', () => {
		const source = '{\n\t"enable-proposed-api": [\n\t\t"other.ext" // theirs\n\t]\n}\n';
		const { text } = grantProposedApi(source, ID);
		// Appended after the element, before the comment — not after the comment,
		// where the rest of the line is comment and the id would vanish.
		const idAt = text.indexOf(ID);
		assert.ok(idAt > 0 && idAt < text.indexOf('// theirs'), text);
		assert.ok(text.includes('// theirs'), 'their comment survives');
	});

	test('already listed is still detected through a comment and a trailing comma', () => {
		const source = `{\n\t"enable-proposed-api": [\n\t\t${JSON.stringify(ID)}, // ours\n\t]\n}\n`;
		const { changed, alreadyListed } = grantProposedApi(source, ID);
		assert.ok(!changed, 'a configured editor must not be told the grant is missing');
		assert.ok(alreadyListed);
	});

	test('a block comment inside the array is skipped', () => {
		const source = '{\n\t"enable-proposed-api": [/* none yet */]\n}\n';
		const { text, changed } = grantProposedApi(source, ID);
		assert.ok(changed);
		assert.ok(text.includes('/* none yet */'), 'comment kept');
		assert.ok(text.includes(JSON.stringify(ID)));
	});

	test('an array of something other than strings is refused', () => {
		assert.throws(
			() => grantProposedApi('{\n\t"enable-proposed-api": [1, 2]\n}\n', ID),
			/could not be read/);
	});

	test('a value that is not an array is refused, never overwritten', () => {
		assert.throws(
			() => grantProposedApi('{\n\t"enable-proposed-api": true\n}\n', ID),
			/not an array/);
	});
});

/** Strips comments so the result can go through `JSON.parse` in assertions. */
function strip(text: string): string {
	const mask = maskJsonc(text);
	// Rebuild from the original, dropping only what the mask blanked outside strings.
	let out = '';
	for (let i = 0; i < text.length; i++) {
		out += mask[i] === ' ' && text[i] !== ' ' && !inString(mask, i) ? ' ' : text[i];
	}
	return out;
}

function inString(mask: string, at: number): boolean {
	let quotes = 0;
	for (let i = 0; i < at; i++) {
		if (mask[i] === '"') {
			quotes++;
		}
	}
	return quotes % 2 === 1;
}
