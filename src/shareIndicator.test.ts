/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import {
	inUseMarker, legacyMarkerRemoval, sharedMarker, stripMarker, stripMarkerFromHtml,
} from './shareIndicator.ts';

/*
 * Nothing writes a marker into a page any more, so what is left to test is the
 * reading half — the two strippers, which still have to recognise a suffix an
 * *older* build wrote — and the one expression that takes such a suffix off a
 * page that is still open.
 *
 * The strip suites are unchanged from when the installer existed: they are the
 * specification of what a marker looks like, and that shape is fixed by what
 * was already shipped rather than by anything this file can still choose.
 */

/** The separator the marker is glued on with: U+2009, a thin space. */
const separator = '\u2009';

suite('stripMarker', () => {

	test('takes off the suffix this extension appends', () => {
		assert.strictEqual(stripMarker(`Orders${separator}${sharedMarker}`), 'Orders');
		assert.strictEqual(stripMarker(`Orders${separator}${inUseMarker}`), 'Orders');
	});

	test('takes off a composed suffix whole', () => {
		assert.strictEqual(stripMarker(`Orders${separator}🤖🟠🟦`), 'Orders');
		assert.strictEqual(stripMarker(`Orders${separator}🔗🟣`), 'Orders');
	});

	test('leaves a tail that is not made of our glyphs', () => {
		// The separator alone does not make a suffix ours: a title that happens
		// to end in a thin space and something else is the page's.
		assert.strictEqual(stripMarker(`Orders${separator}v2`), `Orders${separator}v2`);
		assert.strictEqual(stripMarker(`Orders${separator}🤖x`), `Orders${separator}🤖x`);
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

	test('removes a composed suffix from a serialized title', () => {
		const html = `<html><head><title>Orders${separator}🤖🟠🟦</title></head></html>`;
		assert.strictEqual(stripMarkerFromHtml(html), '<html><head><title>Orders</title></head></html>');
	});

	test("finds our suffix past a thin space of the page's own", () => {
		// A thin space is a real typographic character: a title like `1 000
		// Orders` has one, and a scan that gave up on the first occurrence left
		// our glyph in the html of every such page.
		const html = `<html><head><title>1${separator}000 Orders${separator}🤖🟠</title></head></html>`;
		assert.strictEqual(
			stripMarkerFromHtml(html), `<html><head><title>1${separator}000 Orders</title></head></html>`);
	});

	test("never touches the page's own content", () => {
		// A `<meta>` description or an inline legend can carry a thin space
		// before one of our glyphs. Scanning the whole document matched that
		// decoy first: the page's own text was edited and the real marker was
		// left in the title.
		const html = `<html><head><meta content="Deploy${separator}🔗 status">`
			+ `<title>Orders${separator}🤖🟠</title></head></html>`;
		assert.strictEqual(stripMarkerFromHtml(html),
			`<html><head><meta content="Deploy${separator}🔗 status"><title>Orders</title></head></html>`);
	});

	test('leaves html that carries none of ours', () => {
		const html = `<html><head><title>Deploy Bot ${inUseMarker}</title></head></html>`;
		assert.strictEqual(stripMarkerFromHtml(html), html);
	});
});

suite('legacyMarkerRemoval', () => {

	/*
	 * A page an older build reached still carries `window.__aiBrowserShareMarker`,
	 * whose `remove()` restores the title and disconnects the observer that would
	 * otherwise keep re-applying the suffix. The expression has to reach that, and
	 * — much more often — has to be harmless on the pages that never had one.
	 */
	function page(withMarker: boolean) {
		const calls: string[] = [];
		const context: Record<string, unknown> = {};
		context.window = context;
		if (withMarker) {
			context.__aiBrowserShareMarker = { remove: () => { calls.push('remove'); } };
		}
		return { calls, run: () => runInNewContext(legacyMarkerRemoval, context), context };
	}

	test('calls remove on a page an older build marked', () => {
		const p = page(true);
		p.run();
		assert.deepStrictEqual(p.calls, ['remove']);
	});

	test('is a harmless no-op on a page that never carried one', () => {
		const p = page(false);
		// The guard is the whole point: this runs on every session open, and a
		// throw here would surface as a failed tool call on an ordinary page.
		assert.doesNotThrow(() => p.run());
		assert.deepStrictEqual(p.calls, []);
	});
});
