/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import { suite, test } from 'node:test';
import { parseNews } from './news.ts';

suite('parseNews', () => {

	test('the paragraph before the first entry is the introduction; the comment and title are not', () => {
		const news = parseNews('# News\n\n<!-- authoring notes\nover lines -->\n\nWork in the browser,\nright here.\n\n## 1.0 — today\n- one\n');
		assert.strictEqual(news.intro, 'Work in the browser, right here.');
		assert.deepStrictEqual(news.entries, [{ title: '1.0 — today', items: ['one'] }]);
	});

	test('entries keep their order, newest first as written, and only the first six are kept', () => {
		const md = Array.from({ length: 8 }, (_, i) => `## v${8 - i}\n- item ${8 - i}`).join('\n\n');
		const news = parseNews(md);
		assert.deepStrictEqual(news.entries.map(e => e.title), ['v8', 'v7', 'v6', 'v5', 'v4', 'v3']);
		assert.strictEqual(parseNews(md, 2).entries.length, 2);
	});

	test('an indented line continues the item above; other bullet markers count; stray text is ignored', () => {
		const news = parseNews('## 2.0\n- first part\n  and the rest\n* second\nnot a bullet\n+ third');
		assert.deepStrictEqual(news.entries[0].items, ['first part and the rest', 'second', 'third']);
	});

	test('an entry with no items is left out, and a deeper heading starts nothing', () => {
		const news = parseNews('## empty\n\n## 3.0\n### details\n- kept');
		assert.deepStrictEqual(news.entries, [{ title: '3.0', items: ['kept'] }]);
	});

	test('an unclosed comment hides the rest rather than leaking authoring notes', () => {
		assert.deepStrictEqual(parseNews('Intro\n<!-- never closed\n## 1.0\n- x'), { intro: 'Intro', features: [], entries: [] });
	});

	test('bullets before the first entry are features; one in another shape is skipped', () => {
		const news = parseNews('Intro.\n\n- $(coffee) **Keep awake** — the cup\n  at the top\n- no icon here\n- $(eye) **View Mode** - how much\n\n## 1.0\n- x');
		assert.strictEqual(news.intro, 'Intro.');
		assert.deepStrictEqual(news.features, [
			{ icon: 'coffee', title: 'Keep awake', text: 'the cup at the top' },
			{ icon: 'eye', title: 'View Mode', text: 'how much' },
		]);
		assert.deepStrictEqual(news.entries, [{ title: '1.0', items: ['x'] }]);
	});

	test('the shipped NEWS.md parses into an introduction and at least one entry', () => {
		// `npm test` runs from the repository root.
		const news = parseNews(fs.readFileSync('NEWS.md', 'utf8'));
		assert.ok(news.intro.length > 20, news.intro);
		assert.ok(news.features.length >= 1, 'the shipped features');
		assert.ok(news.entries.length >= 1 && news.entries.length <= 6);
		assert.ok(news.entries.every(e => e.items.length > 0));
	});
});
