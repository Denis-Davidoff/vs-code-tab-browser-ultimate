/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import type { ClientKind } from './mcpProtocol.ts';
import {
	everyone, forKind, forSession, isShareTarget, ShareRegistry, targetName,
} from './shareRegistry.ts';

/** Tabs are opaque tokens to the registry, so a string stands in for one. */
const tabA = 'tab-A';
const tabB = 'tab-B';
const tabC = 'tab-C';

/**
 * Who has driven a tab under any of its current assignments.
 *
 * A test helper rather than a registry method: nothing in the extension asks
 * this — the UI reads usage per assignment — and a public query with no
 * consumer reads as a contract that is not one.
 */
function usedOn(shares: ShareRegistry<string>, tab: string): ClientKind[] {
	const used = new Set(shares.assignments().filter(a => a.tab === tab).flatMap(a => a.usedBy));
	return (['claude', 'codex', 'other'] as const).filter(kind => used.has(kind));
}

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

suite('ShareRegistry share state', () => {

	test('reports nothing for a tab nobody was given', () => {
		const shares = new ShareRegistry<string>();
		assert.strictEqual(shares.isShared(tabA), false);
	});

	test('a tab held by anyone reads as shared', () => {
		const shares = new ShareRegistry<string>();
		shares.share(everyone, tabA);
		assert.strictEqual(shares.isShared(tabA), true);

		shares.share(forKind('codex'), tabA);
		shares.share(forKind('claude'), tabA);
		assert.strictEqual(shares.isShared(tabA), true);
	});

	test('use is recorded once per assistant', () => {
		const shares = new ShareRegistry<string>();
		shares.share(forKind('claude'), tabA);

		assert.strictEqual(shares.noteUse(tabA, 'claude', forKind('claude')), true);
		assert.strictEqual(shares.noteUse(tabA, 'claude', forKind('claude')), false, 'no news the second time');
		assert.deepStrictEqual(usedOn(shares, tabA), ['claude']);
	});

	// Usage is reported per *assignment*, not per tab: giving a tab Claude has
	// worked on to Codex must not show Codex as already working, which is what
	// hides the "restart it, it never picked the tools up" hint.
	test('a fresh assignment on a used tab has not been picked up', () => {
		const shares = new ShareRegistry<string>();
		shares.share(forKind('claude'), tabA);
		shares.noteUse(tabA, 'claude', forKind('claude'));
		shares.share(forKind('codex'), tabA);
		assert.deepStrictEqual(shares.usedByTarget(forKind('codex'), tabA), []);
		assert.deepStrictEqual(shares.usedByTarget(forKind('claude'), tabA), ['claude']);
	});

	/*
	 * `BrowserController._noteTabUse` composes `resolve` and `noteUse` to decide
	 * whether a call counts as this caller picking the tab up. It cannot be
	 * tested directly — its file imports `vscode` — so the rule it depends on is
	 * pinned here: only a caller whose *own* assignment resolves to this tab may
	 * mark it. The guard used to ask `isShared(tab)`, which is true whenever
	 * anybody holds it, so an unassigned caller acting on the focused tab
	 * recorded use against somebody else's page — and a later assignment to that
	 * caller then read as "already working", suppressing the restart hint.
	 */
	const picksUp = (shares: ShareRegistry<string>, tab: string, caller: { kind: 'claude' | 'codex' | 'other'; sessionId?: string }) => {
		const resolution = shares.resolve(caller);
		return resolution.kind === 'shared' && resolution.tab === tab && shares.noteUse(tab, caller.kind, resolution.target);
	};

	test('an unassigned caller does not mark somebody else\'s tab', () => {
		const shares = new ShareRegistry<string>();
		shares.share(forKind('claude'), tabA);

		assert.strictEqual(picksUp(shares, tabA, { kind: 'codex' }), false);
		assert.deepStrictEqual(usedOn(shares, tabA), []);

		// And the later assignment still reports honestly.
		shares.share(forKind('codex'), tabA);
		assert.deepStrictEqual(shares.usedByTarget(forKind('codex'), tabA), []);
	});

	test('one conversation does not mark a tab assigned to another', () => {
		const shares = new ShareRegistry<string>();
		shares.share(forSession('conv-1', 'claude'), tabA);

		assert.strictEqual(picksUp(shares, tabA, { kind: 'claude', sessionId: 'conv-2' }), false);
		assert.deepStrictEqual(usedOn(shares, tabA), []);
	});

	test('an everyone share is picked up by whoever calls', () => {
		const shares = new ShareRegistry<string>();
		shares.share(everyone, tabA);

		assert.strictEqual(picksUp(shares, tabA, { kind: 'codex' }), true);
		assert.deepStrictEqual(usedOn(shares, tabA), ['codex']);
	});

	// Usage is per assignment, so taking one away and giving it back starts
	// over — the re-share is often *because* the session lost its tools, and
	// showing it as working would hide the restart hint (#61).
	test('a stopped and re-made assignment has not been picked up', () => {
		const shares = new ShareRegistry<string>();
		shares.share(forKind('claude'), tabA);
		shares.noteUse(tabA, 'claude', forKind('claude'));
		shares.stop(forKind('claude'));
		shares.share(forKind('claude'), tabA);
		assert.deepStrictEqual(shares.usedByTarget(forKind('claude'), tabA), []);

		shares.noteUse(tabA, 'claude', forKind('claude'));
		shares.stopAll();
		shares.share(forKind('claude'), tabA);
		assert.deepStrictEqual(shares.usedByTarget(forKind('claude'), tabA), []);
	});

	test('re-sharing the tab already held keeps its usage', () => {
		const shares = new ShareRegistry<string>();
		shares.share(forKind('claude'), tabA);
		shares.noteUse(tabA, 'claude', forKind('claude'));
		shares.share(forKind('claude'), tabA);
		assert.deepStrictEqual(shares.usedByTarget(forKind('claude'), tabA), ['claude']);
	});

	test('moving an assignment to another tab starts over', () => {
		const shares = new ShareRegistry<string>();
		shares.share(forKind('claude'), tabA);
		shares.noteUse(tabA, 'claude', forKind('claude'));
		shares.share(forKind('claude'), tabB);
		assert.deepStrictEqual(shares.usedByTarget(forKind('claude'), tabB), []);
	});

	test('a closed tab forgets who used it', () => {
		const shares = new ShareRegistry<string>();
		shares.share(forKind('claude'), tabA);
		shares.noteUse(tabA, 'claude', forKind('claude'));
		shares.forget(tabA);
		assert.deepStrictEqual(usedOn(shares, tabA), []);
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
		// key from it and threw, which stopped the entry that matters most.
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
		shares.noteUse(tabA, 'claude', forKind('claude'));
		shares.share(forKind('codex'), tabA);

		const byTarget = new Map(shares.assignments().map(a => [targetName(a.target), a.usedBy]));
		assert.deepStrictEqual(byTarget.get('Claude Code'), ['claude']);
		assert.deepStrictEqual(byTarget.get('Codex'), []);
	});

	test('the everyone assignment still reports everyone who has driven it', () => {
		const shares = new ShareRegistry<string>();
		shares.share(everyone, tabA);
		shares.noteUse(tabA, 'claude', everyone);
		shares.noteUse(tabA, 'codex', everyone);
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
