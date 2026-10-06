/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { loginsFromCsv, loginsToCsv, parseCsv } from './loginCsv.ts';

suite('parseCsv', () => {

	test('quotes, doubled quotes, embedded commas and line breaks', () => {
		const text = '﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\n1,,3\n';
		assert.deepStrictEqual(parseCsv(text), [
			['a', 'b', 'c'],
			['x, y', 'say "hi"', 'line1\nline2'],
			['1', '', '3'],
		]);
	});

	test('a last row without a line break, and blank lines', () => {
		assert.deepStrictEqual(parseCsv('a,b\n\n1,2'), [['a', 'b'], ['1', '2']]);
	});
});

suite('loginsFromCsv', () => {

	test('Chrome', () => {
		const read = loginsFromCsv('name,url,username,password,note\nGitHub,https://github.com/login,me,s3cret,\n');
		assert.deepStrictEqual(read, {
			logins: [{ urls: ['https://github.com/login'], username: 'me', password: 's3cret', title: 'GitHub' }],
			skipped: 0,
		});
	});

	test('Firefox, with its timestamps', () => {
		const text = '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n'
			+ '"https://a.test","u","p",,"https://a.test","{1}","1000","3000","2000"\n';
		assert.deepStrictEqual(loginsFromCsv(text)?.logins, [
			{ urls: ['https://a.test'], username: 'u', password: 'p', created: 1000, updated: 2000, lastUsed: 3000 },
		]);
	});

	test('Bitwarden: only logins, every address of a row, comma-joined as Bitwarden writes them', () => {
		const text = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n'
			+ ',,login,Site,,,0,"androidapp://com.site,https://a.test,https://b.test",u,p,\n'
			+ ',,login,Lines,,,0,"https://c.test\nhttps://d.test",v,q,\n'
			+ ',,note,Secret note,text,,0,,,,\n';
		assert.deepStrictEqual(loginsFromCsv(text), {
			logins: [
				{ urls: ['androidapp://com.site', 'https://a.test', 'https://b.test'], username: 'u', password: 'p', title: 'Site' },
				{ urls: ['https://c.test', 'https://d.test'], username: 'v', password: 'q', title: 'Lines' },
			],
			skipped: 1,
		});
	});

	test('Safari, with capitalised headers', () => {
		const read = loginsFromCsv('Title,URL,Username,Password,Notes,OTPAuth\nA,https://a.test,u,p,n,\n');
		assert.deepStrictEqual(read?.logins, [{ urls: ['https://a.test'], username: 'u', password: 'p', title: 'A', note: 'n' }]);
	});

	test('a username column wins over an email column, wherever each sits', () => {
		const read = loginsFromCsv('email,url,password,username\nmail@x,https://a.test,p,handle\n');
		assert.strictEqual(read?.logins[0].username, 'handle');
	});

	test('a file without address and password columns is not a login export', () => {
		assert.strictEqual(loginsFromCsv('a,b\n1,2\n'), undefined);
		assert.strictEqual(loginsFromCsv(''), undefined);
	});
});

suite('loginsToCsv', () => {

	test('round-trips awkward values exactly', () => {
		const logins = [
			{ origin: 'https://a.test', username: ' padded ', password: '=1+2,"q"\n', title: 'T' },
		];
		const read = loginsFromCsv(loginsToCsv(logins));
		assert.deepStrictEqual(read?.logins, [
			{ urls: ['https://a.test'], username: ' padded ', password: '=1+2,"q"\n', title: 'T' },
		]);
	});
});
