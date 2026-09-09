/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import {
	fenced, formatElementReport, formatPathReport, reportFileName, slugify, stamp,
} from './reportFormat.ts';

suite('fenced', () => {

	test('uses three backticks when the content has none', () => {
		assert.strictEqual(fenced('body { color: red }', 'css'), '```css\nbody { color: red }\n```');
	});

	test('single backticks in the content still get the minimum fence', () => {
		// A page with a template literal in an inline script hits this; runs of
		// one are already shorter than the three-backtick minimum.
		const content = 'const t = `hi`;';
		assert.strictEqual(fenced(content, 'html'), '```html\nconst t = `hi`;\n```');
	});

	test('a double run forces a triple fence, which is also the minimum', () => {
		assert.strictEqual(fenced('a ``b`` c', 'txt'), '```txt\na ``b`` c\n```');
	});

	test('a triple run forces a four-backtick fence', () => {
		const out = fenced('```\nnested\n```', 'md');
		assert.ok(out.startsWith('````md\n'), out);
		assert.ok(out.endsWith('\n````'), out);
	});

	test('a five run forces a six-backtick fence', () => {
		const out = fenced('`````', 'md');
		assert.ok(out.startsWith('``````md\n'), out);
		assert.ok(out.endsWith('\n``````'), out);
	});

	test('the fence never drops below three, even for a single backtick', () => {
		const out = fenced('a ` b', 'txt');
		assert.ok(out.startsWith('```txt\n'), out);
	});
});

suite('slugify', () => {

	test('lowercases and collapses punctuation', () => {
		assert.strictEqual(slugify('DIV.flex.items-center'), 'div-flex-items-center');
		assert.strictEqual(slugify('main#content'), 'main-content');
	});

	test('trims leading and trailing separators', () => {
		assert.strictEqual(slugify('  ...div...  '), 'div');
	});

	test('caps the length', () => {
		assert.strictEqual(slugify('a'.repeat(80)).length, 40);
	});

	test('falls back rather than returning an empty name', () => {
		assert.strictEqual(slugify('...'), 'element');
		assert.strictEqual(slugify(''), 'element');
	});
});

suite('stamp and reportFileName', () => {

	test('stamp is zero-padded HHMMSS', () => {
		assert.strictEqual(stamp(new Date(2026, 0, 1, 9, 5, 3)), '090503');
	});

	test('the file name carries kind, descriptor and time', () => {
		const name = reportFileName('css', 'div.flex', new Date(2026, 0, 1, 14, 32, 7));
		assert.strictEqual(name, 'element-css-div-flex-143207.md');
	});

	test('every kind is representable', () => {
		const at = new Date(2026, 0, 1, 0, 0, 0);
		assert.ok(reportFileName('xpath', 'x', at).startsWith('element-xpath-'));
		assert.ok(reportFileName('element', 'x', at).startsWith('element-element-'));
	});
});

suite('report bodies', () => {

	test('a path report names the format and the page', () => {
		const report = formatPathReport('div.flex', 'css', '#main > div', 'http://localhost:3000/fr');
		assert.ok(report.startsWith('# CSS selector of `div.flex`'), report);
		assert.ok(report.includes('http://localhost:3000/fr'));
		assert.ok(report.includes('```css\n#main > div\n```'));
	});

	test('an xpath report says XPath, not CSS', () => {
		const report = formatPathReport('span', 'xpath', '//*[@id="a"]', undefined);
		assert.ok(report.includes('# XPath of `span`'));
		assert.ok(!report.includes('CSS'));
		assert.ok(report.includes('in the integrated browser'), 'no URL: falls back to a generic line');
	});

	test('an element report keeps the context verbatim under a heading', () => {
		const report = formatElementReport('Attached Element Context\n\nElement: div', 'div');
		assert.strictEqual(report, '# Element context of `div`\n\nAttached Element Context\n\nElement: div\n');
	});
});
