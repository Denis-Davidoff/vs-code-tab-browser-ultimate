/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import {
	fenced, formatElementReport, formatPathReport, inlineCode, locationSeparator, reportFileName,
	slugify, stamp, withLocation,
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

suite('inlineCode', () => {

	test('wraps an ordinary value in one backtick', () => {
		assert.strictEqual(
			inlineCode('http://localhost:3000/a → #main > li:nth-of-type(2)'),
			'`http://localhost:3000/a → #main > li:nth-of-type(2)`');
	});

	test('grows the delimiter past a backtick in the value', () => {
		// A backtick is legal in a URL query string, and a single-backtick
		// wrapper around one closes early — the tail of the address then renders
		// as prose, which is the same failure `fenced` exists to prevent.
		assert.strictEqual(inlineCode('http://h/x?q=`b → #a'), '``http://h/x?q=`b → #a``');
	});

	test('a double run forces a triple delimiter', () => {
		assert.strictEqual(inlineCode('a ``b`` c'), '```a ``b`` c```');
	});

	test('pads a value that begins or ends with a backtick', () => {
		// CommonMark strips one space from each side only when both are there,
		// so the padding has to be symmetric.
		assert.strictEqual(inlineCode('`a'), '`` `a ``');
		assert.strictEqual(inlineCode('a`'), '`` a` ``');
	});

	test('round-trips through a CommonMark reading of the result', () => {
		for (const value of [
			'http://h/a → #main > div',
			'http://h/x?q=`b → #a',
			'`edge`',
			'a ``b`` c',
		]) {
			const out = inlineCode(value);
			const delimiter = /^`+/.exec(out)?.[0];
			assert.ok(delimiter, out);
			assert.ok(out.endsWith(delimiter), out);
			let inner = out.slice(delimiter.length, out.length - delimiter.length);
			if (inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '') {
				inner = inner.slice(1, -1);
			}
			assert.strictEqual(inner, value);
			assert.ok(!inner.includes(delimiter), `delimiter ${delimiter} occurs inside ${inner}`);
		}
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

	test('the camelCase kind becomes a hyphenated file token', () => {
		// The kind is compared verbatim in `when` clauses, so it stays camelCase;
		// a file name carrying it raw would be the only mixed-case name written.
		const at = new Date(2026, 0, 1, 0, 0, 0);
		assert.strictEqual(
			reportFileName('cssLocation', 'div.flex', at), 'element-css-location-div-flex-000000.md');
	});
});

suite('withLocation', () => {

	test('puts the page first, in the order the pair is used', () => {
		assert.strictEqual(
			withLocation('#main > li:nth-of-type(2)', 'http://localhost:3000/a/b'),
			'http://localhost:3000/a/b → #main > li:nth-of-type(2)');
	});

	test('both halves survive a split on the separator', () => {
		// The point of the format: the left half goes to a navigation, the right
		// half to `querySelector`. A separator that could occur inside either
		// would make this ambiguous, which is why it is not `[page: …]`.
		const url = 'http://localhost:3000/search?q=a+b#top';
		const joined = withLocation('form > input:nth-of-type(1)', url);
		const at = joined.indexOf(locationSeparator);
		assert.strictEqual(joined.slice(0, at), url);
		assert.strictEqual(joined.slice(at + locationSeparator.length), 'form > input:nth-of-type(1)');
	});

	test('the separator cannot appear in a selector this project builds', () => {
		// `CSS.escape` leaves code points at or above U+0080 alone, so a bare
		// arrow *can* reach the selector half — it escapes the space, though, so
		// the padded separator cannot. The spaces are load-bearing.
		for (const selector of [
			'html > body > div:nth-of-type(2) > form',
			'#a\\→b > input',                 // an id containing an arrow, escaped as CSS.escape would
			'#a\\ →\\ b > input',              // and one containing the separator itself
		]) {
			assert.ok(!selector.includes(locationSeparator), selector);
		}
	});

	test('no URL yields the bare selector, never a dangling separator', () => {
		assert.strictEqual(withLocation('#main', undefined), '#main');
		assert.strictEqual(withLocation('#main', ''), '#main');
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

	test('a css+location report is fenced as text, not as css', () => {
		// The body is a selector *and* a URL, so calling it CSS invites whatever
		// reads it — a highlighter, a model — to parse it as a rule and fail.
		const path = withLocation('#main > div', 'http://localhost:3000/fr');
		const report = formatPathReport('div.flex', 'cssLocation', path, 'http://localhost:3000/fr');
		assert.ok(report.startsWith('# Page address and CSS selector of `div.flex`'), report);
		assert.ok(report.includes('```text\nhttp://localhost:3000/fr → #main > div\n```'), report);
		assert.ok(!report.includes('```css'), report);
	});

	test('a css+location report spells the format out for its reader', () => {
		const report = formatPathReport('div', 'cssLocation', 'http://h/x → #a', 'http://h/x');
		assert.ok(report.includes('Format: `<page url> → <css selector>`'), report);
	});

	test('a plain css report gains no format line', () => {
		const report = formatPathReport('div', 'css', '#main > div', 'http://h/x');
		assert.ok(!report.includes('Format:'), report);
	});

	test('an element report keeps the context verbatim under a heading', () => {
		const report = formatElementReport('Attached Element Context\n\nElement: div', 'div');
		assert.strictEqual(report, '# Element context of `div`\n\nAttached Element Context\n\nElement: div\n');
	});
});
