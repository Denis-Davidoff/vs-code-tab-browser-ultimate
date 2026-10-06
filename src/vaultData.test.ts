/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import {
	countConflicts, decideSave, emptyVault, matchLogins, mergeVault, newRevision, originOf, parseVault, passkeysFor,
	revisionTime,
	putLogin, rpIdMatchesHost, serializeVault, setNeverSave, toStandardBase64,
	type LoginEntry, type PasskeyEntry, type Vault,
} from './vaultData.ts';

const login = (origin: string, username: string, password: string, extra: Partial<LoginEntry> = {}): LoginEntry => ({
	id: `${origin}|${username}`, origin, username, password, created: 1, updated: 1, ...extra,
});

const vaultOf = (...logins: LoginEntry[]): Vault => ({ ...emptyVault(), logins });

suite('originOf', () => {

	test('normalises case and default ports', () => {
		assert.strictEqual(originOf('HTTPS://Example.COM:443/login?x=1'), 'https://example.com');
		assert.strictEqual(originOf('http://localhost:3000/a'), 'http://localhost:3000');
	});

	test('refuses anything that is not an http(s) page', () => {
		for (const url of ['file:///x.html', 'data:text/html,hi', 'about:blank', 'not a url', 'android://com.app']) {
			assert.strictEqual(originOf(url), undefined, url);
		}
	});
});

suite('matchLogins', () => {

	test('exact origin first, then the same host on another port', () => {
		const vault = vaultOf(
			login('http://localhost:5173', 'dev', 'a'),
			login('http://localhost:3000', 'dev', 'b'),
		);
		const matches = matchLogins(vault, 'http://localhost:3000/login');
		assert.deepStrictEqual(matches.map(m => [m.entry.origin, m.kind]), [
			['http://localhost:3000', 'exact'],
			['http://localhost:5173', 'sameHost'],
		]);
	});

	test('never a login of a lookalike or a subdomain', () => {
		// The matching rule is the phishing protection: a suffix or prefix of
		// the saved host is a different site.
		const vault = vaultOf(login('https://example.com', 'u', 'p'));
		for (const url of ['https://example.com.evil.net/', 'https://evil-example.com/', 'https://a.example.com/']) {
			assert.deepStrictEqual(matchLogins(vault, url), [], url);
		}
	});

	test('an https login is not offered on an http page, except locally', () => {
		const vault = vaultOf(login('https://example.com', 'u', 'p'), login('https://localhost:8443', 'u', 'p'));
		assert.deepStrictEqual(matchLogins(vault, 'http://example.com/'), []);
		assert.strictEqual(matchLogins(vault, 'http://localhost:8080/').length, 1);
	});

	test('an http login may be offered on the https page of the same host', () => {
		const vault = vaultOf(login('http://example.com', 'u', 'p'));
		assert.strictEqual(matchLogins(vault, 'https://example.com/')[0]?.kind, 'sameHost');
	});

	test('most recently used first within a kind', () => {
		const vault = vaultOf(
			login('https://a.test', 'old', 'p', { lastUsed: 10 }),
			login('https://a.test', 'new', 'p', { lastUsed: 20 }),
		);
		assert.deepStrictEqual(matchLogins(vault, 'https://a.test/').map(m => m.entry.username), ['new', 'old']);
	});
});

suite('decideSave', () => {

	const origin = 'https://a.test';

	test('a new username is saved', () => {
		assert.deepStrictEqual(decideSave(vaultOf(login(origin, 'x', 'p')), origin, 'y', 'q'), { kind: 'save' });
	});

	test('the same username and password says nothing', () => {
		assert.deepStrictEqual(decideSave(vaultOf(login(origin, 'x', 'p')), origin, 'x', 'p'),
			{ kind: 'none', reason: 'unchanged' });
	});

	test('the same username with a new password is an update of that login', () => {
		const saved = login(origin, 'x', 'p');
		assert.deepStrictEqual(decideSave(vaultOf(saved), origin, 'x', 'q'), { kind: 'update', entry: saved });
	});

	test('usernames compare without case', () => {
		const saved = login(origin, 'Me@Example.com', 'p');
		assert.deepStrictEqual(decideSave(vaultOf(saved), origin, 'me@example.com', 'p'), { kind: 'none', reason: 'unchanged' });
		assert.deepStrictEqual(decideSave(vaultOf(saved), origin, 'me@example.com', 'q'), { kind: 'update', entry: saved });
	});

	test('a password-only step updates the one login saved for the site', () => {
		const saved = login(origin, 'x', 'p');
		assert.deepStrictEqual(decideSave(vaultOf(saved), origin, '', 'q'), { kind: 'update', entry: saved });
		assert.deepStrictEqual(decideSave(vaultOf(saved), origin, '', 'p'), { kind: 'none', reason: 'unchanged' });
	});

	test('a password-only step with several logins saved is a new login', () => {
		const vault = vaultOf(login(origin, 'x', 'p'), login(origin, 'y', 'q'));
		assert.deepStrictEqual(decideSave(vault, origin, '', 'r'), { kind: 'save' });
	});

	test('a change-password form updates the login whose password it names', () => {
		const x = login(origin, 'x', 'old');
		const vault = vaultOf(x, login(origin, 'y', 'other'));
		assert.deepStrictEqual(decideSave(vault, origin, '', 'new', 'old'), { kind: 'update', entry: x });
	});

	test('other origins do not count', () => {
		const vault = vaultOf(login('https://b.test', 'x', 'p'));
		assert.deepStrictEqual(decideSave(vault, origin, 'x', 'p'), { kind: 'save' });
	});

	test('never-save and empty passwords say nothing', () => {
		assert.deepStrictEqual(decideSave(setNeverSave(emptyVault(), origin, true), origin, 'x', 'p'),
			{ kind: 'none', reason: 'neverSave' });
		assert.deepStrictEqual(decideSave(emptyVault(), origin, 'x', ''), { kind: 'none', reason: 'empty' });
	});
});

suite('parseVault', () => {

	test('round-trips through serializeVault, revision included', () => {
		let vault: Vault = { ...putLogin(emptyVault(), login('https://a.test', 'x', 'p', { title: 'A', lastUsed: 5 })), revision: 'r1' };
		vault = setNeverSave(vault, 'https://b.test', true);
		const read = parseVault(serializeVault(vault));
		assert.deepStrictEqual(read, { vault, dropped: 0 });
	});

	test('a collection that is not a list makes the vault unreadable, not empty', () => {
		for (const key of ['logins', 'passkeys', 'neverSave']) {
			const text = JSON.stringify({ format: 'ai-browser-vault', version: 1, [key]: { a: 1 } });
			assert.strictEqual(parseVault(text), undefined, key);
		}
	});

	test('a revision is ordered by the time it was made', () => {
		assert.strictEqual(revisionTime(newRevision(1234)), 1234);
		assert.strictEqual(revisionTime('random-uuid-from-an-older-build'), undefined);
		assert.strictEqual(revisionTime(undefined), undefined);
	});

	test('unreadable text and a newer version are not a vault, so nothing writes over them', () => {
		assert.strictEqual(parseVault('{'), undefined);
		assert.strictEqual(parseVault('{"format":"something-else","version":1}'), undefined);
		assert.strictEqual(parseVault('{"format":"ai-browser-vault","version":2,"logins":[]}'), undefined);
	});

	test('a malformed entry is set aside and counted, and written back untouched', () => {
		const bad = { id: 'bad', origin: 'javascript:alert(1)' };
		const text = JSON.stringify({
			format: 'ai-browser-vault', version: 1,
			logins: [login('https://a.test', 'x', 'p'), bad],
			passkeys: [{ id: 'k' }], neverSave: ['https://ok.test', 'not an origin'],
		});
		const read = parseVault(text);
		assert.strictEqual(read?.vault.logins.length, 1);
		assert.strictEqual(read?.dropped, 2);
		assert.deepStrictEqual(read?.vault.neverSave, ['https://ok.test']);

		// A write after an edit must not lose what this build could not read.
		const edited = putLogin(read!.vault, login('https://b.test', 'y', 'q'));
		const stored = JSON.parse(serializeVault(edited));
		assert.deepStrictEqual(stored.logins.filter((e: any) => e.id === 'bad'), [bad]);
		assert.deepStrictEqual(stored.passkeys, [{ id: 'k' }]);
	});
});

suite('passkeys', () => {

	const key = (rpId: string, credentialId: string, extra: Partial<PasskeyEntry> = {}): PasskeyEntry => ({
		id: credentialId, rpId, credentialId, privateKey: 'AAAA', signCount: 0, created: 1, ...extra,
	});

	test('an RP ID is the host or a registrable suffix of it', () => {
		assert.ok(rpIdMatchesHost('example.com', 'example.com'));
		assert.ok(rpIdMatchesHost('example.com', 'login.example.com'));
		assert.ok(rpIdMatchesHost('localhost', 'localhost'));
		assert.ok(!rpIdMatchesHost('example.com', 'badexample.com'));
		assert.ok(!rpIdMatchesHost('com', 'example.com'));
		assert.ok(!rpIdMatchesHost('login.example.com', 'example.com'));
	});

	test('base64url from the page matches base64 from CDP', () => {
		assert.strictEqual(toStandardBase64('MY_Mzpd9-w'), 'MY/Mzpd9+w==');
		const vault: Vault = { ...emptyVault(), passkeys: [key('a.test', 'MY/Mzpd9+w=='), key('a.test', 'other')] };
		assert.deepStrictEqual(passkeysFor(vault, 'a.test', ['MY_Mzpd9-w']).map(p => p.credentialId), ['MY/Mzpd9+w==']);
		assert.strictEqual(passkeysFor(vault, 'a.test').length, 2);
		assert.strictEqual(passkeysFor(vault, 'b.test').length, 0);
	});

	test('a merge keeps the higher signature counter', () => {
		const vault: Vault = { ...emptyVault(), passkeys: [key('a.test', 'c', { signCount: 7 })] };
		const lower = mergeVault(vault, { logins: [], passkeys: [key('a.test', 'c', { signCount: 3 })] }, 'replace', 0);
		assert.strictEqual(lower.vault.passkeys[0].signCount, 7);
		const higher = mergeVault(vault, { logins: [], passkeys: [key('a.test', 'c', { signCount: 9 })] }, 'keep', 0);
		assert.strictEqual(higher.vault.passkeys[0].signCount, 9);
	});
});

suite('mergeVault', () => {

	test('adds, updates, keeps and counts by origin and username', () => {
		const vault = vaultOf(login('https://a.test', 'x', 'p'), login('https://a.test', 'y', 'same'));
		const incoming = [
			login('https://a.test', 'x', 'changed'),
			login('https://a.test', 'y', 'same'),
			login('https://b.test', 'z', 'new'),
		];
		assert.strictEqual(countConflicts(vault, incoming), 1);

		const replaced = mergeVault(vault, { logins: incoming }, 'replace', 100);
		assert.deepStrictEqual([replaced.added, replaced.updated, replaced.unchanged, replaced.kept], [1, 1, 1, 0]);
		assert.strictEqual(replaced.vault.logins.find(e => e.username === 'x')?.password, 'changed');

		const kept = mergeVault(vault, { logins: incoming }, 'keep', 100);
		assert.deepStrictEqual([kept.added, kept.updated, kept.unchanged, kept.kept], [1, 0, 1, 1]);
		assert.strictEqual(kept.vault.logins.find(e => e.username === 'x')?.password, 'p');
	});

	test('an imported login gets an id of this vault', () => {
		const merged = mergeVault(emptyVault(), { logins: [login('https://a.test', 'x', 'p', { id: 'foreign' })] }, 'keep', 0);
		assert.notStrictEqual(merged.vault.logins[0].id, 'foreign');
	});

	test('a username differing only in case is the same login, and a conflict', () => {
		const vault = vaultOf(login('https://a.test', 'Me@x.com', 'old'));
		const incoming = [login('https://a.test', 'me@x.com', 'new')];
		assert.strictEqual(countConflicts(vault, incoming), 1);
		const merged = mergeVault(vault, { logins: incoming }, 'replace', 0);
		assert.deepStrictEqual(merged.vault.logins.map(e => [e.username, e.password]), [['Me@x.com', 'new']]);
	});

	test('a duplicate inside one file is counted once, as it is merged once', () => {
		const vault = vaultOf(login('https://a.test', 'x', 'saved'));
		const incoming = [login('https://a.test', 'x', 'first'), login('https://a.test', 'X', 'second')];
		assert.strictEqual(countConflicts(vault, incoming), 1);
	});

	test('of duplicates in one file, the most recently changed wins, and the rest are counted', () => {
		const vault = vaultOf(login('https://a.test', 'x', 'current', { updated: 50 }));
		const incoming = [login('https://a.test', 'x', 'stale', { updated: 10 }), login('https://a.test', 'X', 'current', { updated: 60 })];
		assert.strictEqual(countConflicts(vault, incoming), 0, 'the stale row is not what the merge would apply');
		const merged = mergeVault(vault, { logins: incoming }, 'replace', 0);
		assert.deepStrictEqual([merged.vault.logins[0].password, merged.unchanged, merged.duplicates], ['current', 1, 1]);
	});

	test('a large import is linear, not quadratic', () => {
		const many = Array.from({ length: 50_000 }, (_, i) => login(`https://s${i}.test`, `u${i}`, 'p'));
		const started = Date.now();
		const merged = mergeVault(vaultOf(...many.slice(0, 25_000)), { logins: many }, 'keep', 0);
		assert.strictEqual(merged.added, 25_000);
		assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
	});

	test('a duplicate inside one file is imported once', () => {
		const merged = mergeVault(emptyVault(), {
			logins: [login('https://a.test', 'x', 'first'), login('https://a.test', 'x', 'second')],
		}, 'replace', 0);
		assert.deepStrictEqual(merged.vault.logins.map(e => e.password), ['first']);
	});
});
