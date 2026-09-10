/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import {
	everyone, forKind, forSession, isShareTarget, ShareRegistry, targetName,
} from './shareRegistry.ts';

/** Tabs are opaque tokens to the registry, so a string stands in for one. */
const tabA = 'tab-A';
const tabB = 'tab-B';
const tabC = 'tab-C';

const claude = { kind: 'claude' as const };
const codex = { kind: 'codex' as const };

suite('ShareRegistry precedence', () => {

	test('an assistant with no assignment follows the user', () => {
		const shares = new ShareRegistry<string>();
		assert.deepStrictEqual(shares.resolve(claude), { kind: 'unassigned' });
	});

	test('the everyone assignment answers for anyone', () => {
		const shares = new ShareRegistry<string>();
		shares.share(everyone, tabA);
		assert.strictEqual(shares.resolve(claude).kind, 'shared');
		assert.strictEqual(shares.resolve(codex).kind, 'shared');
	});

	test('an assistant of its own outranks the everyone assignment', () => {
		const shares = new ShareRegistry<string>();
		shares.share(everyone, tabA);
		shares.share(forKind('claude'), tabB);

		const forClaude = shares.resolve(claude);
		assert.strictEqual(forClaude.kind === 'shared' && forClaude.tab, tabB);
		const forCodex = shares.resolve(codex);
		assert.strictEqual(forCodex.kind === 'shared' && forCodex.tab, tabA);
	});

	test('one conversation outranks its own assistant', () => {
		const shares = new ShareRegistry<string>();
		shares.share(forKind('claude'), tabA);
		shares.share(forSession('s1', 'claude'), tabB);

		const one = shares.resolve({ kind: 'claude', sessionId: 's1' });
		assert.strictEqual(one.kind === 'shared' && one.tab, tabB);
		const other = shares.resolve({ kind: 'claude', sessionId: 's2' });
		assert.strictEqual(other.kind === 'shared' && other.tab, tabA);
	});

	test('two assistants can be given the same tab', () => {
		// The case this whole shape exists for: Claude and Codex on one page.
		const shares = new ShareRegistry<string>();
		shares.share(forKind('claude'), tabA);
		shares.share(forKind('codex'), tabA);

		const first = shares.resolve(claude);
		const second = shares.resolve(codex);
		assert.strictEqual(first.kind === 'shared' && first.tab, tabA);
		assert.strictEqual(second.kind === 'shared' && second.tab, tabA);
		assert.deepStrictEqual(shares.tabs(), [tabA]);
	});

	test('sharing again moves that assignment and leaves the others alone', () => {
		const shares = new ShareRegistry<string>();
		shares.share(forKind('claude'), tabA);
		shares.share(forKind('codex'), tabB);
		shares.share(forKind('claude'), tabC);

		const forClaude = shares.resolve(claude);
		const forCodex = shares.resolve(codex);
		assert.strictEqual(forClaude.kind === 'shared' && forClaude.tab, tabC);
		assert.strictEqual(forCodex.kind === 'shared' && forCodex.tab, tabB);
	});
});

suite('ShareRegistry when a tab closes', () => {

	test('only the assistants that were on it are paused', () => {
		const shares = new ShareRegistry<string>();
		shares.share(forKind('claude'), tabA);
		shares.share(forKind('codex'), tabB);

		const lost = shares.forget(tabA);
		assert.deepStrictEqual(lost.map(targetName), ['Claude Code']);
		assert.strictEqual(shares.resolve(claude).kind, 'paused');
		assert.strictEqual(shares.resolve(codex).kind, 'shared');
	});

	test('a paused assistant does not fall through to a broader assignment', () => {
		// Falling back is what the share exists to prevent: the user chose that
		// page for this assistant, and resuming on another is undoing it.
		const shares = new ShareRegistry<string>();
		shares.share(everyone, tabA);
		shares.share(forKind('claude'), tabB);
		shares.forget(tabB);

		assert.strictEqual(shares.resolve(claude).kind, 'paused');
		assert.strictEqual(shares.resolve(codex).kind, 'shared');
	});

	test('releasing the assignment lets that assistant follow the user again', () => {
		const shares = new ShareRegistry<string>();
		shares.share(forKind('claude'), tabA);
		shares.forget(tabA);
		assert.strictEqual(shares.resolve(claude).kind, 'paused');

		shares.stop(forKind('claude'));
		assert.deepStrictEqual(shares.resolve(claude), { kind: 'unassigned' });
		assert.ok(shares.isEmpty);
	});

	test('a tab closing while two assistants share it pauses both', () => {
		const shares = new ShareRegistry<string>();
		shares.share(forKind('claude'), tabA);
		shares.share(forSession('s1', 'codex'), tabA);

		assert.strictEqual(shares.forget(tabA).length, 2);
		assert.strictEqual(shares.resolve(claude).kind, 'paused');
		assert.strictEqual(shares.resolve({ kind: 'codex', sessionId: 's1' }).kind, 'paused');
	});
});

suite('ShareRegistry marker state', () => {

	test('reports nothing for a tab nobody was given', () => {
		const shares = new ShareRegistry<string>();
		assert.strictEqual(shares.stateOf(tabA), undefined);
	});

	test('names the assistant-specific owners and the everyone case apart', () => {
		const shares = new ShareRegistry<string>();
		shares.share(everyone, tabA);
		assert.deepStrictEqual(shares.stateOf(tabA), { used: false, kinds: [], everyone: true });

		shares.share(forKind('codex'), tabA);
		shares.share(forKind('claude'), tabA);
		assert.deepStrictEqual(shares.stateOf(tabA), {
			used: false, kinds: ['claude', 'codex'], everyone: true,
		});
	});

	test('use is recorded once per assistant and shows on the tab', () => {
		const shares = new ShareRegistry<string>();
		shares.share(forKind('claude'), tabA);

		assert.strictEqual(shares.noteUse(tabA, 'claude'), true);
		assert.strictEqual(shares.noteUse(tabA, 'claude'), false, 'no news the second time');
		assert.deepStrictEqual(shares.stateOf(tabA)?.used, true);
		assert.deepStrictEqual(shares.usedBy(tabA), ['claude']);
	});

	test('a closed tab forgets who used it', () => {
		const shares = new ShareRegistry<string>();
		shares.share(forKind('claude'), tabA);
		shares.noteUse(tabA, 'claude');
		shares.forget(tabA);
		assert.deepStrictEqual(shares.usedBy(tabA), []);
	});
});

suite('isShareTarget', () => {

	test('accepts the three target shapes', () => {
		assert.ok(isShareTarget(everyone));
		assert.ok(isShareTarget(forKind('claude')));
		assert.ok(isShareTarget(forSession('s1', 'codex')));
	});

	test('rejects what a menu actually hands over', () => {
		// A command invoked from `editor/title` is given the editor's resource,
		// so the first argument is a `Uri` whenever the entry is used from the
		// browser tab's own toolbar — and reading that as a target resolved a
		// key from it and threw, which killed the entry that matters most.
		assert.strictEqual(isShareTarget({ scheme: 'file', path: '/tmp/x', fsPath: '/tmp/x' }), false);
		assert.strictEqual(isShareTarget(undefined), false);
		assert.strictEqual(isShareTarget(null), false);
		assert.strictEqual(isShareTarget('everyone'), false);
		assert.strictEqual(isShareTarget({ scope: 'something else' }), false);
	});
});

suite('ShareRegistry usage per assignment', () => {

	test('an assignment reports only its own assistant as working', () => {
		// Let Claude use a tab, then give that tab to Codex: reporting the
		// tab's whole history made Codex look like work in progress, which
		// suppressed the one hint that matters — "it has not picked this up
		// yet, so restart it if it reports no tools".
		const shares = new ShareRegistry<string>();
		shares.share(forKind('claude'), tabA);
		shares.noteUse(tabA, 'claude');
		shares.share(forKind('codex'), tabA);

		const byTarget = new Map(shares.assignments().map(a => [targetName(a.target), a.usedBy]));
		assert.deepStrictEqual(byTarget.get('Claude Code'), ['claude']);
		assert.deepStrictEqual(byTarget.get('Codex'), []);
	});

	test('the everyone assignment still reports everyone who has driven it', () => {
		const shares = new ShareRegistry<string>();
		shares.share(everyone, tabA);
		shares.noteUse(tabA, 'claude');
		shares.noteUse(tabA, 'codex');
		assert.deepStrictEqual(shares.assignments()[0].usedBy, ['claude', 'codex']);
	});
});

suite('ShareRegistry reporting', () => {

	test('assignments read from the broadest to the most specific', () => {
		const shares = new ShareRegistry<string>();
		shares.share(forSession('s1', 'claude'), tabC);
		shares.share(everyone, tabA);
		shares.share(forKind('codex'), tabB);

		assert.deepStrictEqual(shares.assignments().map(a => targetName(a.target)), [
			'all assistants', 'Codex', 'Claude Code (this conversation)',
		]);
	});

	test('stopAll reports every tab it was holding, once', () => {
		const shares = new ShareRegistry<string>();
		shares.share(forKind('claude'), tabA);
		shares.share(forKind('codex'), tabA);
		shares.share(everyone, tabB);

		assert.deepStrictEqual(shares.stopAll().sort(), [tabA, tabB]);
		assert.ok(shares.isEmpty);
	});
});
