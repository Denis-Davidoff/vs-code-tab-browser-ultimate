/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { formatAncestor, renderElementMarkdown, type ElementData } from './elementMarkdown.ts';

const fixture: ElementData = {
	outerHTML: '<div class="flex py-8"><span>14</span></div>',
	computedStyle: '.flex { display: flex; }\n\n/* Resolved values */\nmargin: 0px;',
	dimensions: { top: 128.4, left: 70.6, width: 565, height: 148 },
	ancestors: [
		{ tagName: 'div', classNames: ['ant-app'] },
		{ tagName: 'main', id: 'content', classNames: ['ant-layout-content'] },
		{ tagName: 'div', classNames: ['flex', 'py-8'] },
	],
};

suite('formatAncestor', () => {

	test('combines tag, id and classes', () => {
		assert.strictEqual(
			formatAncestor({ tagName: 'main', id: 'content', classNames: ['a', 'b'] }),
			'main#content.a.b');
	});

	test('omits the parts that are absent', () => {
		assert.strictEqual(formatAncestor({ tagName: 'div' }), 'div');
		assert.strictEqual(formatAncestor({ tagName: 'div', classNames: [] }), 'div');
		assert.strictEqual(formatAncestor({ tagName: 'div', id: 'x' }), 'div#x');
	});
});

suite('renderElementMarkdown', () => {

	test('renders every section, in order', () => {
		const md = renderElementMarkdown(fixture, 'http://localhost:3000/fr');
		// The CSS block has blank lines of its own, so only the leading sections
		// can be recovered by splitting the document on blank lines.
		const headings = md.split('\n\n').slice(0, 7).map(s => s.split('\n', 1)[0]);

		assert.deepStrictEqual(headings, [
			'Attached Element Context from Integrated Browser',
			'Element: div.flex.py-8',
			'URL: http://localhost:3000/fr',
			'HTML Path: div.ant-app > main#content.ant-layout-content > div.flex.py-8',
			'Outer HTML:',
			'Dimensions:',
			'CSS:',
		]);
	});

	test('names the element from the last ancestor, which is the element itself', () => {
		const md = renderElementMarkdown(fixture, undefined);
		assert.ok(md.includes('Element: div.flex.py-8'));
		assert.ok(md.includes('> div.flex.py-8'), 'the path ends with the same element');
	});

	test('rounds the dimensions to whole pixels', () => {
		const md = renderElementMarkdown(fixture, undefined);
		assert.ok(md.includes('- top: 128px'), md);
		assert.ok(md.includes('- left: 71px'), md);
		assert.ok(md.includes('- width: 565px'));
		assert.ok(md.includes('- height: 148px'));
	});

	test('fences the html and css blocks with the right languages', () => {
		const md = renderElementMarkdown(fixture, undefined);
		assert.ok(md.includes('Outer HTML:\n```html\n' + fixture.outerHTML + '\n```'));
		assert.ok(md.includes('CSS:\n```css\n' + fixture.computedStyle + '\n```'));
	});

	test('drops the URL line when there is no URL', () => {
		assert.ok(!renderElementMarkdown(fixture, undefined).includes('URL:'));
	});

	test('survives an element with no ancestors', () => {
		const md = renderElementMarkdown({ ...fixture, ancestors: [] }, undefined);
		assert.ok(!md.includes('Element:'));
		assert.ok(!md.includes('HTML Path:'));
		assert.ok(md.includes('Outer HTML:'));
	});
});
