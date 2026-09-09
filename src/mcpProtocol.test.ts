/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import {
	dispatch, errorCodes, invalidRequestReason, isNotification, schema, string,
	stringOrUndefined, numberOrUndefined, authorizeRequest, normalisePath,
	type DispatchContext, type Tool, type RequestFacts,
} from './mcpProtocol.ts';

const tools: Tool[] = [
	{
		name: 'browser_state', title: 'State', description: 'Reports the page.',
		inputSchema: schema({}),
		run: async () => ({ url: 'http://localhost:3000' }),
	},
	{
		name: 'browser_text', title: 'Text', description: 'Reads text.',
		inputSchema: schema({ selector: string('CSS selector') }),
		run: async args => `text of ${args.selector}`,
	},
	{
		name: 'browser_boom', title: 'Boom', description: 'Always fails.',
		inputSchema: schema({}),
		run: async () => { throw new Error('No browser tab is open'); },
	},
];

const ctx: DispatchContext = { serverVersion: '1.2.3', workspaceName: 'demo', tools };

const call = (method: string, params?: unknown, id: unknown = 1) =>
	dispatch({ jsonrpc: '2.0', id, method, params }, ctx);

suite('argument sanitising', () => {

	test('only non-empty strings survive', () => {
		assert.strictEqual(stringOrUndefined('a'), 'a');
		assert.strictEqual(stringOrUndefined(''), undefined);
		assert.strictEqual(stringOrUndefined(7), undefined);
		assert.strictEqual(stringOrUndefined(null), undefined);
		assert.strictEqual(stringOrUndefined({}), undefined);
	});

	test('only finite numbers survive', () => {
		assert.strictEqual(numberOrUndefined(3), 3);
		assert.strictEqual(numberOrUndefined(0), 0);
		assert.strictEqual(numberOrUndefined(NaN), undefined);
		assert.strictEqual(numberOrUndefined(Infinity), undefined);
		assert.strictEqual(numberOrUndefined('3'), undefined);
	});
});

suite('dispatch', () => {

	test('initialize echoes the requested protocol version', async () => {
		const response = await call('initialize', { protocolVersion: '2024-11-05' });
		assert.strictEqual((response!.result as any).protocolVersion, '2024-11-05');
	});

	test('initialize falls back to a default version', async () => {
		const response = await call('initialize', {});
		assert.strictEqual((response!.result as any).protocolVersion, '2025-06-18');
	});

	test('initialize advertises tools and names the workspace', async () => {
		const result = (await call('initialize', {}))!.result as any;
		assert.deepStrictEqual(result.capabilities, { tools: { listChanged: false } });
		assert.strictEqual(result.serverInfo.version, '1.2.3');
		assert.ok(result.instructions.includes('demo'));
	});

	test('ping answers empty', async () => {
		assert.deepStrictEqual((await call('ping'))!.result, {});
	});

	test('tools/list omits the run function', async () => {
		const listed = (await call('tools/list'))!.result as any;
		assert.deepStrictEqual(listed.tools.map((t: any) => t.name),
			['browser_state', 'browser_text', 'browser_boom']);
		assert.ok(!('run' in listed.tools[0]));
		assert.strictEqual(listed.tools[0].inputSchema.additionalProperties, false);
	});

	test('tools/call returns text content', async () => {
		const result = (await call('tools/call', { name: 'browser_text', arguments: { selector: 'h1' } }))!.result as any;
		assert.deepStrictEqual(result.content, [{ type: 'text', text: 'text of h1' }]);
	});

	test('a non-string result is pretty-printed JSON', async () => {
		const result = (await call('tools/call', { name: 'browser_state' }))!.result as any;
		assert.strictEqual(result.content[0].text, '{\n  "url": "http://localhost:3000"\n}');
	});

	test('a tool failure is a result with isError, not a protocol error', async () => {
		const response = (await call('tools/call', { name: 'browser_boom' }))!;
		assert.strictEqual(response.error, undefined, 'the model never sees a protocol error');
		const result = response.result as any;
		assert.strictEqual(result.isError, true);
		assert.strictEqual(result.content[0].text, 'No browser tab is open');
	});

	test('an unknown tool is also a readable result', async () => {
		const result = (await call('tools/call', { name: 'nope' }))!.result as any;
		assert.strictEqual(result.isError, true);
		assert.ok(result.content[0].text.includes('nope'));
	});

	test('missing arguments become an empty object', async () => {
		const result = (await call('tools/call', { name: 'browser_text' }))!.result as any;
		assert.strictEqual(result.content[0].text, 'text of undefined');
	});

	test('an unknown method is method-not-found', async () => {
		const response = (await call('resources/list'))!;
		assert.strictEqual(response.error?.code, errorCodes.methodNotFound);
	});

	test('notifications are not answered', async () => {
		assert.strictEqual(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), undefined);
		assert.strictEqual(await dispatch({ jsonrpc: '2.0', id: null, method: 'ping' }, ctx), undefined);
		assert.strictEqual(isNotification({ method: 'x' }), true);
		assert.strictEqual(isNotification({ id: 0, method: 'x' }), false, 'id 0 is a real id');
	});
});

suite('invalidRequestReason', () => {

	test('rejects batches, non-objects and missing methods', () => {
		assert.ok(invalidRequestReason([{ method: 'ping' }])!.includes('Batch'));
		assert.ok(invalidRequestReason(null));
		assert.ok(invalidRequestReason('ping'));
		assert.ok(invalidRequestReason({})!.includes('method'));
	});

	test('accepts a well-formed request', () => {
		assert.strictEqual(invalidRequestReason({ jsonrpc: '2.0', id: 1, method: 'ping' }), undefined);
	});
});

suite('authorizeRequest', () => {

	const token = 'secrettoken';
	const facts = (over: Partial<RequestFacts> = {}): RequestFacts => ({
		method: 'POST', path: '/mcp', origin: undefined,
		authorization: `Bearer ${token}`, ...over,
	});

	test('accepts a POST with the bearer token', () => {
		assert.deepStrictEqual(authorizeRequest(facts(), token), { kind: 'ok' });
	});

	test('accepts the token as the last path segment, which is all Codex can do', () => {
		assert.deepStrictEqual(
			authorizeRequest(facts({ path: `/mcp/${token}`, authorization: undefined }), token),
			{ kind: 'ok' });
	});

	test('anything but POST is 405, because there is no stream to GET', () => {
		assert.strictEqual(authorizeRequest(facts({ method: 'GET' }), token).kind, 'methodNotAllowed');
		assert.strictEqual(authorizeRequest(facts({ method: 'OPTIONS' }), token).kind, 'methodNotAllowed');
		assert.strictEqual(authorizeRequest(facts({ method: undefined }), token).kind, 'methodNotAllowed');
	});

	test('an Origin is refused before the token is even considered', () => {
		const decision = authorizeRequest(facts({ origin: 'http://localhost:3000' }), token);
		assert.strictEqual(decision.kind, 'forbidden');

		// Crucially, also refused when the credentials are perfect.
		const withGoodToken = authorizeRequest(
			facts({ origin: 'https://evil.test', authorization: `Bearer ${token}` }), token);
		assert.strictEqual(withGoodToken.kind, 'forbidden');
	});

	test('a wrong, absent or malformed token is unauthorized', () => {
		assert.strictEqual(authorizeRequest(facts({ authorization: 'Bearer nope' }), token).kind, 'unauthorized');
		assert.strictEqual(authorizeRequest(facts({ authorization: undefined }), token).kind, 'unauthorized');
		assert.strictEqual(authorizeRequest(facts({ authorization: token }), token).kind, 'unauthorized');
		assert.strictEqual(authorizeRequest(facts({ path: '/mcp/wrong', authorization: undefined }), token).kind, 'unauthorized');
	});

	test('an authorized request to another path is 404', () => {
		assert.strictEqual(authorizeRequest(facts({ path: '/admin' }), token).kind, 'notFound');
	});

	test('normalisePath drops the query and trailing slashes', () => {
		assert.strictEqual(normalisePath('/mcp/?x=1'), '/mcp');
		assert.strictEqual(normalisePath('/mcp///'), '/mcp');
		assert.strictEqual(normalisePath(undefined), '');
	});
});
