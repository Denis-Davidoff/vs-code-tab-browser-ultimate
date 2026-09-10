/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import {
	inUseMarker, ShareIndicator, sharedMarker, stripMarker, stripMarkerFromHtml,
} from './shareIndicator.ts';
import type { PageChannel } from './shareIndicator.ts';

/*
 * The marker is the one part of this feature that runs inside somebody else's
 * page, so the installer is exercised as *text* against a fake document rather
 * than trusted by reading. `ShareIndicator` is driven with a fake channel to get
 * hold of the real emitted source — the same string a browser would be handed.
 */

const separator = ' ';

/** A minimal document, enough for the installer and its observer. */
function fakeDocument(title: string) {
	const state = {
		title,
		listeners: new Map<string, () => void>(),
		observers: 0,
		readyState: 'complete',
	};
	const observers = new Set<() => void>();
	const context: Record<string, unknown> = {};
	context.window = context;
	context.MutationObserver = class {
		// A plain field, not a parameter property: Node strips types, it does
		// not compile them, and `constructor(private x)` is not erasable
		// syntax — it fails at load with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
		public callback: () => void;
		constructor(callback: () => void) { this.callback = callback; }
		observe(): void { observers.add(this.callback); state.observers = observers.size; }
		disconnect(): void { observers.delete(this.callback); state.observers = observers.size; }
	};
	context.document = {
		head: {},
		get readyState() { return state.readyState; },
		get title() { return state.title; },
		set title(value: string) {
			state.title = value;
			for (const observer of [...observers]) { observer(); }
		},
		addEventListener(type: string, handler: () => void) { state.listeners.set(type, handler); },
		removeEventListener(type: string) { state.listeners.delete(type); },
	};
	return {
		state,
		run: (source: string) => runInNewContext(source, context),
		/** What the page itself does when it renames its own tab. */
		rename: (value: string) => { (context.document as { title: string }).title = value; },
	};
}

/**
 * Captures what the indicator sends, and can make the page throw.
 *
 * Typed against `PageChannel`, the structural slice the module declares — not
 * against `CDPClient`, whose file would drag the `browser` proposal's typings
 * into this project. Only `send` is ever reached.
 */
function fakeClient(options: { throws?: boolean } = {}) {
	const sent: { method: string; params: any }[] = [];
	const client = {
		send: async (method: string, params: any) => {
			sent.push({ method, params });
			if (method === 'Runtime.evaluate' && options.throws) {
				return { exceptionDetails: { text: 'the page refused' } };
			}
			if (method === 'Page.addScriptToEvaluateOnNewDocument') {
				return { identifier: `script-${sent.length}` };
			}
			return {};
		},
	};
	return {
		client: client as PageChannel,
		sent,
		sources: () => sent.filter(m => m.method === 'Runtime.evaluate').map(m => m.params.expression as string),
		methods: () => sent.map(m => m.method),
	};
}

/** The source the indicator would evaluate for one marker. */
async function installerFor(marker: string): Promise<string> {
	const fake = fakeClient();
	await new ShareIndicator(fake.client, 'session').set(marker);
	return fake.sources()[0];
}

suite('stripMarker', () => {

	test('takes off the suffix this extension appends', () => {
		assert.strictEqual(stripMarker(`Orders${separator}${sharedMarker}`), 'Orders');
		assert.strictEqual(stripMarker(`Orders${separator}${inUseMarker}`), 'Orders');
	});

	test('leaves a title that never carried one', () => {
		assert.strictEqual(stripMarker('Orders'), 'Orders');
		assert.strictEqual(stripMarker('Orders '), 'Orders ');
		assert.strictEqual(stripMarker(undefined), undefined);
		assert.strictEqual(stripMarker(''), '');
	});

	test('leaves the page its own trailing emoji', () => {
		// The separator is what tells the two apart: a plain space in front of
		// the emoji means the page put it there. Eating it rewrote somebody
		// else's title, irreversibly.
		assert.strictEqual(stripMarker(`Deploy Bot ${inUseMarker}`), `Deploy Bot ${inUseMarker}`);
		assert.strictEqual(stripMarker(`Docs ${sharedMarker}`), `Docs ${sharedMarker}`);
	});

	test('takes off one suffix, not every marker it can find', () => {
		const title = `Deploy Bot ${inUseMarker}${separator}${sharedMarker}`;
		assert.strictEqual(stripMarker(title), `Deploy Bot ${inUseMarker}`);
	});
});

suite('stripMarkerFromHtml', () => {

	test('removes the marker from a serialized title', () => {
		const html = `<html><head><title>Orders${separator}${sharedMarker}</title></head><body>x</body></html>`;
		assert.strictEqual(stripMarkerFromHtml(html), '<html><head><title>Orders</title></head><body>x</body></html>');
	});

	test('leaves html that carries none of ours', () => {
		const html = `<html><head><title>Deploy Bot ${inUseMarker}</title></head></html>`;
		assert.strictEqual(stripMarkerFromHtml(html), html);
	});
});

suite('the page-side installer', () => {

	test('appends the marker with the separator that identifies it', async () => {
		const page = fakeDocument('Orders');
		page.run(await installerFor(sharedMarker));
		assert.strictEqual(page.state.title, `Orders${separator}${sharedMarker}`);
	});

	test('re-applies the marker after the page renames its own tab', async () => {
		const page = fakeDocument('Orders');
		page.run(await installerFor(sharedMarker));
		page.rename('Orders (3)');
		assert.strictEqual(page.state.title, `Orders (3)${separator}${sharedMarker}`);
	});

	test('upgrading the marker replaces it rather than stacking', async () => {
		const page = fakeDocument('Orders');
		page.run(await installerFor(sharedMarker));
		page.run(await installerFor(inUseMarker));
		assert.strictEqual(page.state.title, `Orders${separator}${inUseMarker}`);
	});

	test('removal restores the title exactly and disarms everything', async () => {
		const page = fakeDocument('Orders');
		page.run(await installerFor(sharedMarker));
		page.run('window.__aiBrowserShareMarker.remove()');

		assert.strictEqual(page.state.title, 'Orders');
		assert.strictEqual(page.state.observers, 0);
		assert.strictEqual(page.run('typeof window.__aiBrowserShareMarker'), 'undefined');
	});

	test('a page whose own title ends in the same emoji keeps it', async () => {
		const page = fakeDocument(`Deploy Bot ${inUseMarker}`);
		page.run(await installerFor(sharedMarker));
		assert.strictEqual(page.state.title, `Deploy Bot ${inUseMarker}${separator}${sharedMarker}`);

		page.run('window.__aiBrowserShareMarker.remove()');
		assert.strictEqual(page.state.title, `Deploy Bot ${inUseMarker}`);
	});

	test('removal mid-load disarms the deferred start', async () => {
		const page = fakeDocument('Orders');
		page.state.readyState = 'loading';
		page.run(await installerFor(sharedMarker));

		// Nothing applied yet: the installer is waiting for the document.
		assert.strictEqual(page.state.title, 'Orders');
		const start = page.state.listeners.get('DOMContentLoaded');
		assert.ok(start, 'the installer waits on DOMContentLoaded');

		page.run('window.__aiBrowserShareMarker.remove()');
		assert.strictEqual(page.state.listeners.has('DOMContentLoaded'), false);

		// Even if the host fires it anyway, nothing comes back.
		start();
		assert.strictEqual(page.state.title, 'Orders');
		assert.strictEqual(page.state.observers, 0);
	});
});

suite('ShareIndicator', () => {

	test('registers the script as well as evaluating it, so it survives a navigation', async () => {
		const fake = fakeClient();
		await new ShareIndicator(fake.client, 'session').set(sharedMarker);
		assert.deepStrictEqual(fake.methods(), ['Page.addScriptToEvaluateOnNewDocument', 'Runtime.evaluate']);
	});

	test('setting the marker it already has sends nothing', async () => {
		const fake = fakeClient();
		const indicator = new ShareIndicator(fake.client, 'session');
		await indicator.set(sharedMarker);
		await indicator.set(sharedMarker);
		assert.strictEqual(fake.methods().length, 2);
	});

	test('changing the marker replaces the registration', async () => {
		const fake = fakeClient();
		const indicator = new ShareIndicator(fake.client, 'session');
		await indicator.set(sharedMarker);
		await indicator.set(inUseMarker);
		assert.deepStrictEqual(fake.methods(), [
			'Page.addScriptToEvaluateOnNewDocument',
			'Runtime.evaluate',
			'Page.removeScriptToEvaluateOnNewDocument',
			'Page.addScriptToEvaluateOnNewDocument',
			'Runtime.evaluate',
		]);
	});

	test('clear reports failure when the page throws, so the caller can try its own session', async () => {
		const fake = fakeClient({ throws: true });
		const indicator = new ShareIndicator(fake.client, 'session');
		assert.strictEqual(await indicator.clear(), false);
	});

	test('a page-side throw is not recorded as an installed marker', async () => {
		// CDP answers a thrown expression with a *successful* reply carrying
		// `exceptionDetails`. Recording the marker anyway made the "already in
		// that state" short-circuit suppress every retry for the session.
		const fake = fakeClient({ throws: true });
		const indicator = new ShareIndicator(fake.client, 'session');
		await assert.rejects(() => indicator.set(sharedMarker));
		await assert.rejects(() => indicator.set(sharedMarker));
		assert.strictEqual(fake.sources().length, 2, 'the second attempt was still made');
	});
});
