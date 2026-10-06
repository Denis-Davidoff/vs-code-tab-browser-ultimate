/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { comparesFieldValue, isSecretField, redactSecretValues } from './secretGuards.ts';

suite('comparesFieldValue', () => {

	test('every operator on a field value is a comparison', () => {
		for (const selector of [
			'input[value="hunter2"]', 'input[type=password][value^="a"]', '[value$=x]', '[value*=x]',
			'[value~=x]', '[value|=x]', '[ value ^= "a" i ]', '[*|value^=a]', 'form:has(input[value^="a"]) button',
			'textarea[value^=a]', 'sl-input[value^=a]',
		]) {
			assert.ok(comparesFieldValue(selector), selector);
		}
	});

	test('comments do not hide it, wherever they sit', () => {
		// CSS drops a comment between tokens: these all still select by value.
		for (const selector of ['input[value/**/^="h"]', 'input[/**/value^="h"]', '[ value /* c */ ^= "hu" ]',
			':is([value/*x*/="hunter2"])', 'input[val\\75 e/**/^=h]', 'input[type=password][value^=a]/* unterminated']) {
			assert.ok(comparesFieldValue(selector), selector);
		}
	});

	test('a comment inside a string is the string, not a comment', () => {
		// Read as a comment, the middle would vanish and the comparison with it.
		assert.ok(comparesFieldValue('[title="/*"][value^=a][title="*/"]'));
	});

	test('escapes and case do not hide it', () => {
		// In CSS `\61 ` is an escaped `a`; `\a` would be a newline — a different name.
		for (const selector of ['[VALUE^=a]', '[val\\75 e^=a]', '[\\76 alue^=a]', '[v\\61 lue^=a]', '[v\\61lue^=a]']) {
			assert.ok(comparesFieldValue(selector), selector);
		}
	});

	test('a comparison on an element that never holds a typed secret is allowed', () => {
		for (const selector of ['option[value="us"]', 'select > option[value=de]', 'button[value=delete]',
			'input[type=radio][value=pro]', 'input[name=plan][type="checkbox"][value=yes]', 'li[value="3"]',
			'#plans input[type=radio][value=pro]:checked']) {
			assert.ok(!comparesFieldValue(selector), selector);
		}
	});

	test('an input of no stated type, or a text-like type, is still refused', () => {
		for (const selector of ['input[name=plan][value=pro]', 'input[type=text][value^=a]', '[value=x]']) {
			assert.ok(comparesFieldValue(selector), selector);
		}
	});

	test('ordinary selectors, presence tests and other attributes pass', () => {
		for (const selector of ['#login', 'input[type=password]', 'input[value]', '[data-value="x"]',
			'button:nth-of-type(2)', 'input[name=valued]', '[title="[value^=a]"]']) {
			assert.ok(!comparesFieldValue(selector), selector);
		}
	});
});

suite('isSecretField', () => {

	test('by type, autocomplete token or name', () => {
		assert.ok(isSecretField({ type: 'password' }));
		assert.ok(isSecretField({ type: 'PASSWORD' }));
		assert.ok(isSecretField({ type: 'text', autocomplete: 'current-password' }));
		assert.ok(isSecretField({ type: 'text', name: 'user_password' }), 'a field a show-password toggle turned into text');
		assert.ok(isSecretField({ type: 'text', name: 'userPassword' }));
		assert.ok(isSecretField({ type: 'text', id: 'pwd' }));
		assert.ok(isSecretField({ type: 'text', name: 'passcode' }));
		assert.ok(!isSecretField({ type: 'email', name: 'email' }));
		assert.ok(!isSecretField({ type: 'submit', value: 'Sign in' }));
	});

	test('a word that merely contains "pass" is not a password', () => {
		for (const name of ['passenger_count', 'passengers', 'passport_number', 'compass_heading', 'bypass_cache', 'passportNo']) {
			assert.ok(!isSecretField({ type: 'text', name }), name);
		}
	});
});

suite('redactSecretValues', () => {

	test('removes the value of a password field and nothing else', () => {
		const html = '<form><input type="email" value="me@x"><input type="password" value="Saved-Pa55" id="pw"></form>';
		assert.strictEqual(redactSecretValues(html),
			'<form><input type="email" value="me@x"><input type="password" id="pw"></form>');
	});

	test('a > inside an attribute does not cut the tag short', () => {
		const html = '<input data-x="a>b" type="password" value="s3cret">';
		assert.ok(!redactSecretValues(html).includes('s3cret'));
	});

	test('script text cannot open a quote that swallows the next real input', () => {
		const html = '<div><script>const x = \'<input data-x="\';</script><input type="password" value="s3cret"></div>';
		const out = redactSecretValues(html);
		assert.ok(!out.includes('s3cret'), out);
		assert.ok(out.includes('<script>const x = \'<input data-x="\';</script>'), 'the script is copied as it was');
	});

	test('comments, CDATA and style text are not scanned for tags', () => {
		const html = '<!-- <input data-x=" --><style>a[x="</style><input type="password" value="s1"><![CDATA[ <input " ]]><input type="password" value="s2">';
		const out = redactSecretValues(html);
		assert.ok(!out.includes('s1') && !out.includes('s2'), out);
	});

	test('single quotes, unquoted values and upper case', () => {
		assert.ok(!redactSecretValues("<INPUT TYPE='password' VALUE='s3cret'>").includes('s3cret'));
		assert.ok(!redactSecretValues('<input type=password value=s3cret>').includes('s3cret'));
	});

	test('a toggled field keeps its secret by name', () => {
		assert.ok(!redactSecretValues('<input type="text" name="password" value="s3cret">').includes('s3cret'));
	});

	test('markup with no secret is returned unchanged', () => {
		const html = '<div><input type="search" value="query"> <p>value="x"</p><input name="passengers" value="2"></div>';
		assert.strictEqual(redactSecretValues(html), html);
	});
});
