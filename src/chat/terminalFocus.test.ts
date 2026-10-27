/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// A structural guard on `chatView.ts` (which imports `vscode`, so it cannot be loaded here): when a
// conversation takes the front back from a terminal, `focusInput` must go out AFTER the state that
// removes the terminal, or the view focuses the xterm that is about to be hidden and the focus falls
// to the page's body (#7 and #9 of the terminal review). The rule is kept by two helpers:
// `_leaveTerminal` (the only caller of `clearFront`) and `_focusInput` (the only direct poster of
// `focusInput`, besides the state timer that posts it after the state). A new call site that
// bypasses them would bring the race back, and this test says so.

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import { suite, test } from 'node:test';

const source = fs.readFileSync('src/chat/chatView.ts', 'utf8');

function bodyOf(name: string): string {
	const start = source.indexOf(`private ${name}(`);
	assert.ok(start >= 0, `${name} exists`);
	const open = source.indexOf('{', source.indexOf(')', start));
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === '{') { depth++; }
		else if (source[i] === '}' && --depth === 0) { return source.slice(open, i + 1); }
	}
	throw new Error('unbalanced');
}

suite('leaving a terminal focuses the composer after the state', () => {
	test('clearFront is called only by _leaveTerminal', () => {
		const calls = source.match(/\.clearFront\(\)/g) ?? [];
		assert.strictEqual(calls.length, 1);
		assert.ok(bodyOf('_leaveTerminal').includes('.clearFront()'));
	});

	test('the provider posts focusInput directly only from _focusInput and after the state in _post', () => {
		const direct = source.match(/this\._postMessage\(\{ type: 'focusInput' \}\)/g) ?? [];
		assert.strictEqual(direct.length, 2);
		assert.ok(bodyOf('_focusInput').includes("this._postMessage({ type: 'focusInput' })"));
		const post = bodyOf('_post');
		const state = post.indexOf("type: 'state'");
		const focus = post.indexOf("type: 'focusInput'");
		assert.ok(state >= 0 && focus > state, 'focusInput follows the state in the timer');
		assert.ok(post.indexOf('_terminalLeftPending = false') > state, 'the pending mark is lifted only once the state is posted');
	});

	test('_focusInput defers while a terminal was just left', () => {
		const body = bodyOf('_focusInput');
		assert.ok(/if \(this\._terminalLeftPending\) \{ this\._focusAfterState = true; return; \}/.test(body));
	});
});
