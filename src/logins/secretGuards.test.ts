/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { cleanHtml, comparesFieldValue, isProtectedField, isSecretField, redactSecretValues } from './secretGuards.ts';

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

	test('a type inside a functional pseudo-class pins nothing', () => {
		// `:not([type=radio])` matches a password field; read as "a radio", these
		// were a one-character oracle on its value.
		for (const selector of ['input:not([type=radio])[value^="h"]', ':not([type=radio])[value^="a"]',
			'input:is([type=radio],[type=password])[value^="a"]', 'input:where(:not([type=checkbox]))[value^=a]',
			'input:is(:not([type=radio]))[value^=a]', 'form :not([type=radio])[value^="a"]',
			'input:has(+ [type=radio])[value^=a]', ':is(option)[value^=a]']) {
			assert.ok(comparesFieldValue(selector), selector);
		}
		// An escaped parenthesis is part of a name, not the end of the argument.
		for (const selector of ['input:not(.a\\)[type=radio])[value^="h"]', 'input:not(.a\\29 [type=radio])[value^="h"]',
			':not(.a\\)[type=checkbox])[value^=h]', 'input:is(.x\\,[type=radio])[value^=h]']) {
			assert.ok(comparesFieldValue(selector), selector);
		}
		// What the compound itself pins still counts.
		for (const selector of ['input[type=radio]:not(.x)[value=pro]', 'option:not([disabled])[value=us]',
			'input:checked[type=checkbox][value=yes]']) {
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

	test('a raw-text end tag is found in any ASCII case, at its own index', () => {
		const html = '<STYLE>a{}</StYlE><input type="password" value="s3cret"><script>x</SCRIPT><input type=password value=s4>';
		const out = redactSecretValues(html);
		assert.ok(!out.includes('s3cret') && !out.includes('s4'), out);
		assert.ok(out.startsWith('<STYLE>a{}</StYlE><input type="password">'), out);
	});

	test('text that changes length when lowercased does not move the end of a raw-text element', () => {
		// 'İ'.toLowerCase() is two code units. Searching a lowered copy put the
		// end of the style twenty units late, inside the input after it, and the
		// rest of that tag — its value included — was copied through unscanned.
		const html = 'İ'.repeat(20) + '<style>a{}</style><input type="password" value="s3cret">';
		const out = redactSecretValues(html);
		assert.ok(!out.includes('s3cret'), out);
		assert.strictEqual(out, 'İ'.repeat(20) + '<style>a{}</style><input type="password">');
	});

	test('a long-s is not an s: only ASCII case is folded in a tag name', () => {
		// `</ſtyle>` does not close a style element; its text stays raw text.
		const html = '<style>a{}</ſtyle><input type="password" value="s3cret"></style><input type="password" value="s4">';
		const out = redactSecretValues(html);
		assert.ok(out.includes('value="s3cret"'), 'inside the style, so not a tag');
		assert.ok(!out.includes('s4'), out);
	});

	test('many raw-text elements are each found in one pass', () => {
		// Lowercasing the document per element made this quadratic; it is linear
		// now. Checked for correctness, not timed: every value is redacted.
		let html = '<div>';
		for (let n = 0; n < 5000; n++) {
			html += `<style>a{}</style><input type="password" value="v${n}x">`;
		}
		const out = redactSecretValues(html + '</div>');
		assert.ok(!/value="v\d+x"/.test(out));
		assert.strictEqual(out.split('<style>a{}</style><input type="password">').length, 5001);
	});

	test('a quote in an attribute name opens nothing', () => {
		// Only a quote right after `=` begins a value. Read as one, the quote in
		// the name ran on to the next quote in the document, past the input.
		const html = '<div a\'="x"></div><input type="password" value="hunter2" b\'="y">';
		const out = redactSecretValues(html);
		assert.ok(!out.includes('hunter2'), out);
		assert.ok(!redactSecretValues('<input type = \'password\' data-x = "a>b" value = \'s3cret\'>').includes('s3cret'));
		// An `=` before any name character starts a name, as the tokenizer reads it.
		const named = '<div =\'=""></div><input type="password" value="hunter2"><p title=\'x\'>';
		assert.ok(!redactSecretValues(named).includes('hunter2'));
		assert.ok(!redactSecretValues('<div a="1"b=\'2\'/></div><input type=password value=hunter2>').includes('hunter2'));
	});

	test('markup with no secret is returned unchanged', () => {
		const html = '<div><input type="search" value="query"> <p>value="x"</p><input name="passengers" value="2"></div>';
		assert.strictEqual(redactSecretValues(html), html);
	});
});

suite('isProtectedField', () => {
	test('passwords and payment fields are protected', () => {
		assert.ok(isProtectedField({ type: 'password' }));
		assert.ok(isProtectedField({ autocomplete: 'cc-number' }));
		assert.ok(isProtectedField({ autocomplete: 'billing cc-csc' }));
		assert.ok(isProtectedField({ name: 'cardNumber' }));
		assert.ok(isProtectedField({ name: 'cvv' }));
		assert.ok(isProtectedField({ id: 'cc-cvc' }));
		for (const name of ['card-number', 'cc-number', 'credit_card', 'creditCardNumber', 'security_code', 'card_no']) {
			assert.ok(isProtectedField({ name }), name);
		}
	});
	test('ordinary fields are not', () => {
		assert.ok(!isProtectedField({ type: 'email', name: 'email' }));
		assert.ok(!isProtectedField({ name: 'discount_code' }));
		assert.ok(!isProtectedField({ name: 'cardholder_name' }));
		assert.ok(!isProtectedField({ name: 'scorecard' }));
		assert.ok(!isProtectedField({ name: 'credit_card_holder' }));
		assert.ok(!isProtectedField({ name: 'creditCardType' }));
	});
});

test('cleanHtml drops scripts, styles, comments, handlers and data attributes', () => {
	const html = '<div class="a" data-x="1" onclick="go()" style="color:red"><!-- <input type=password value=s> -->'
		+ '<script>const x = "<input value=\'pw\'>";</script><style>a{}</style><b id="t">Hi</b></div>';
	assert.strictEqual(cleanHtml(html), '<div class="a"><b id="t">Hi</b></div>');
});

test('cleanHtml redacts a secret value and keeps a plain one', () => {
	assert.strictEqual(cleanHtml('<input type="password" name="p" value="hunter2">'), '<input type="password" name="p">');
	assert.strictEqual(cleanHtml('<input type="text" name="q" value="shoes">'), '<input type="text" name="q" value="shoes">');
});

test('cleanHtml is not fooled by quotes that open no value', () => {
	// `a'` is an attribute name, not a quote: the password input after it must still be cleaned.
	const out = cleanHtml('<div a\'="x">t</div><input type=password value=hunter2 onfocus=steal()>');
	assert.ok(!out.includes('hunter2'), out);
	assert.ok(!out.includes('onfocus'), out);
	const out2 = cleanHtml('<div =\'>t</div><input type=password value=hunter2>');
	assert.ok(!out2.includes('hunter2'), out2);
});

test('cleanHtml empties svg and template, keeping the svg tag', () => {
	assert.strictEqual(
		cleanHtml('<button aria-label="Close"><svg viewBox="0 0 1 1"><svg><path d="M0"/></svg><path d="M1"/></svg></button><p>x</p>'),
		'<button aria-label="Close"><svg viewBox="0 0 1 1"></svg></button><p>x</p>');
	assert.strictEqual(cleanHtml('<template><template><p>a</p></template><b>b</b></template><i>c</i>'), '<i>c</i>');
});

test('cleanHtml shortens long data URLs and squeezes blank lines outside pre', () => {
	const src = 'data:image/png;base64,' + 'A'.repeat(400);
	assert.strictEqual(cleanHtml(`<img alt="x" src="${src}">`), '<img alt="x" src="data:…">');
	assert.strictEqual(cleanHtml('<p>a</p>\n\n\n   \n<p>b</p>'), '<p>a</p>\n<p>b</p>');
	assert.strictEqual(cleanHtml('<pre>a\n\n\nb</pre>'), '<pre>a\n\n\nb</pre>');
});

test('cleanHtml stays linear on long whitespace and odd input', () => {
	const started = Date.now();
	cleanHtml('<p>' + ' '.repeat(200_000) + '\n' + ' '.repeat(200_000) + '</p>' + '<style>'.repeat(20_000));
	assert.ok(Date.now() - started < 2000);
	assert.strictEqual(cleanHtml('<b>open'), '<b>open');
	assert.strictEqual(cleanHtml('a < b'), 'a < b');
});
