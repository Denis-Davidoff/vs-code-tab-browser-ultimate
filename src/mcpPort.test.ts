/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { portOffset, portOrder, portSpan } from './mcpPort.ts';

const a = 'file:///Users/someone/dev/project-a';
const b = 'file:///Users/someone/dev/project-b';

suite('portOffset', () => {

	test('the same folder always gets the same offset', () => {
		// The whole point: a window has to land on the same port after a
		// restart, or the port written into a config goes stale.
		assert.strictEqual(portOffset(a), portOffset(a));
	});

	test('different folders generally get different offsets', () => {
		assert.notStrictEqual(portOffset(a), portOffset(b));
	});

	test('the offset stays inside the span', () => {
		for (const uri of [a, b, '', 'x', 'file:///' + 'z'.repeat(500)]) {
			const offset = portOffset(uri);
			assert.ok(offset >= 0 && offset < portSpan, `${uri} -> ${offset}`);
		}
	});
});

suite('portOrder', () => {

	test('covers the whole span exactly once', () => {
		const ports = portOrder(43110, 7);
		assert.strictEqual(ports.length, portSpan);
		assert.strictEqual(new Set(ports).size, portSpan);
		for (const port of ports) {
			assert.ok(port >= 43110 && port < 43110 + portSpan, String(port));
		}
	});

	test('starts at the offset and wraps round', () => {
		assert.deepStrictEqual(portOrder(100, 18, 20).slice(0, 4), [118, 119, 100, 101]);
	});

	test('an offset of zero is the original straight walk', () => {
		// What an explicitly configured aiBrowser.mcp.port must still get.
		assert.deepStrictEqual(portOrder(43110, 0, 3), [43110, 43111, 43112]);
	});
});
