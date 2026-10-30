import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { trustedWebviewMessage } from './chatHost.ts';

function fixture() {
	const view = { origin: 'https://private-webview.example' } as unknown as Window;
	Object.assign(view, { parent: view, top: view });
	const parent = { 0: view, length: 1 } as unknown as Window;
	return { view, parent };
}

test('VS Code host messages arrive when the preload shadows window.parent and top', () => {
	const { view, parent } = fixture();
	assert.equal(view.parent, view);
	assert.equal(trustedWebviewMessage({ source: parent, origin: view.origin }, view), true);
});

test('descendants, siblings, self and synthetic messages cannot impersonate the host', () => {
	const { view } = fixture();
	for (const source of [null, view, { length: 0 }, { 0: {}, length: 1 }]) {
		assert.equal(trustedWebviewMessage({ source: source as Window | null, origin: view.origin }, view), false);
	}
});

test('foreign and opaque origins are rejected even when the frame relationship matches', () => {
	const { view, parent } = fixture();
	for (const origin of ['null', '', 'https://foreign.example']) {
		assert.equal(trustedWebviewMessage({ source: parent, origin }, view), false);
	}
});
