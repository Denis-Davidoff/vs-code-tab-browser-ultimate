/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import {
	fetchOpenRouterCatalog, readOpenRouterCatalog, searchOpenRouterCatalog,
	validateOpenRouterKey, validateOpenRouterModel, validateOpenRouterModels,
} from './openrouterProtocol.ts';
import { describePrice, formatContext, modelFromCatalogItem, modelSummary, parseOptionalNumber } from './openrouterView.ts';

// Shapes follow OpenRouter's documented GET /models, NOT recorded from the live service.
const sample = {
	data: [
		{ id: 'anthropic/claude-sonnet-4', name: 'Anthropic: Claude Sonnet 4', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' },
			architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools', 'reasoning', 'temperature'], top_provider: { max_completion_tokens: 64000 } },
		{ id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Meta: Llama 3.3 70B <b>x</b>', context_length: 131072, pricing: { prompt: '0', completion: '0' },
			architecture: { input_modalities: ['text'] }, supported_parameters: ['temperature'] },
		{ id: 'bad id with spaces', name: 'x' },
		{ name: 'no id' },
		{ id: 'openai/gpt-4o', name: 'OpenAI: GPT-4o', pricing: { prompt: '-1', completion: 'abc' } },
	],
};

suite('OpenRouter settings: model validation', () => {
	test('a full model is accepted as typed', () => {
		const r = validateOpenRouterModel({ id: ' anthropic/claude-sonnet-4 ', name: 'Sonnet', maxTokens: 8000, temperature: 0.5, reasoning: 'high', tools: true, images: false });
		assert.deepStrictEqual(r, { model: { id: 'anthropic/claude-sonnet-4', name: 'Sonnet', maxTokens: 8000, temperature: 0.5, reasoning: 'high', tools: true, images: false } });
	});
	test('absent and null options are not set', () => {
		assert.deepStrictEqual(validateOpenRouterModel({ id: 'a/b', maxTokens: null, temperature: undefined, reasoning: '' }), { model: { id: 'a/b' } });
	});
	test('bad ids and numbers are refused with a reason, never clamped', () => {
		for (const bad of [{}, { id: '' }, { id: 'a b' }, { id: 'a/b\nc' }, { id: '-x' }, { id: 'a'.repeat(201) },
			{ id: 'a/b', maxTokens: 0 }, { id: 'a/b', maxTokens: 1.5 }, { id: 'a/b', maxTokens: '5' }, { id: 'a/b', maxTokens: 2_000_001 },
			{ id: 'a/b', temperature: 2.1 }, { id: 'a/b', temperature: -0.1 }, { id: 'a/b', temperature: NaN }, { id: 'a/b', reasoning: 'max' },
			{ id: 'a/b', tools: 'yes' }, { id: 'a/b', images: 1 }, { id: 'a/b', name: 5 }, null, 'x']) {
			assert.ok('error' in validateOpenRouterModel(bad), JSON.stringify(bad));
		}
	});
	test('control characters leave a name', () => {
		const r = validateOpenRouterModel({ id: 'a/b', name: 'A\u0000\nB' });
		assert.ok('model' in r && r.model.name === 'A B');
	});
	test('a list refuses duplicates in any case, over 100 entries and non-lists', () => {
		assert.ok('error' in validateOpenRouterModels([{ id: 'a/b' }, { id: 'A/B' }]));
		assert.ok('error' in validateOpenRouterModels(Array.from({ length: 101 }, (_, i) => ({ id: `a/m${i}` }))));
		assert.ok('error' in validateOpenRouterModels('x'));
		assert.ok('error' in validateOpenRouterModels([{ id: 'a/b' }, { id: 'bad id' }]));
		assert.deepStrictEqual(validateOpenRouterModels([{ id: 'a/b' }, { id: 'c/d' }]), { models: [{ id: 'a/b' }, { id: 'c/d' }] });
	});
});

suite('OpenRouter settings: the key', () => {
	test('a plausible key is trimmed and kept', () => {
		assert.deepStrictEqual(validateOpenRouterKey('  sk-or-v1-abcdef0123456789\n'), { key: 'sk-or-v1-abcdef0123456789' });
	});
	test('refusals never contain the key', () => {
		for (const bad of ['', '   ', 'abcde', 'has space inside the key', 'sk-or-v1-éééééé', 'a'.repeat(513), 5]) {
			const r = validateOpenRouterKey(bad);
			assert.ok('error' in r);
			if (typeof bad === 'string' && bad.trim().length > 4) { assert.ok(!r.error.includes(bad.trim())); }
		}
	});
});

suite('OpenRouter settings: the catalogue', () => {
	test('reads entries, skips malformed ones and keeps names as plain text', () => {
		const entries = readOpenRouterCatalog(sample);
		assert.deepStrictEqual(entries.map(e => e.id), ['anthropic/claude-sonnet-4', 'meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-4o']);
		const [a, b, c] = entries;
		assert.deepStrictEqual([a.contextLength, a.promptPrice, a.completionPrice, a.maxCompletion, a.tools, a.images, a.reasoning], [200000, 3, 15, 64000, true, true, true]);
		assert.deepStrictEqual([b.promptPrice, b.completionPrice, b.tools, b.images], [0, 0, false, false]);
		assert.strictEqual(b.name, 'Meta: Llama 3.3 70B <b>x</b>'); // text, shown with textContent
		assert.deepStrictEqual([c.promptPrice, c.completionPrice], [undefined, undefined]); // "-1" and junk are no price
		assert.deepStrictEqual(readOpenRouterCatalog(null), []);
		assert.deepStrictEqual(readOpenRouterCatalog({ data: 'x' }), []);
	});
	test('search needs every word, ranks an id prefix first, and reports the total', () => {
		const entries = readOpenRouterCatalog(sample);
		assert.deepStrictEqual(searchOpenRouterCatalog(entries, 'claude sonnet').entries.map(e => e.id), ['anthropic/claude-sonnet-4']);
		assert.deepStrictEqual(searchOpenRouterCatalog(entries, 'openai/').entries.map(e => e.id), ['openai/gpt-4o']);
		assert.strictEqual(searchOpenRouterCatalog(entries, '').total, 3);
		assert.strictEqual(searchOpenRouterCatalog(entries, '', 2).entries.length, 2);
		assert.strictEqual(searchOpenRouterCatalog(entries, 'nothing like it').total, 0);
		assert.strictEqual(searchOpenRouterCatalog(entries, 'LLAMA').total, 1);
	});
	test('a catalogue entry becomes a model with only what it declares', () => {
		const [a, b] = readOpenRouterCatalog(sample);
		assert.deepStrictEqual(modelFromCatalogItem(a), { id: a.id, name: a.name, tools: true, images: true, reasoning: 'medium' });
		assert.deepStrictEqual(modelFromCatalogItem(b), { id: b.id, name: b.name, tools: false, images: false });
		assert.ok('model' in validateOpenRouterModel(modelFromCatalogItem(a)));
	});
	test('context and summaries read as short text', () => {
		assert.deepStrictEqual([formatContext(200000), formatContext(1_000_000), formatContext(131072), formatContext(8000), formatContext(undefined)], ['200K', '1M', '131K', '8K', '']);
		assert.strictEqual(modelSummary({ id: 'a/b', maxTokens: 8000, temperature: 0.5, reasoning: 'high', tools: false, images: true }), 'max 8000 tokens · temperature 0.5 · reasoning high · no tools · images');
		assert.strictEqual(modelSummary({ id: 'a/b' }), '');
	});
	test('an optional number field: empty is unset, anything else must be a number', () => {
		assert.deepStrictEqual(parseOptionalNumber(''), { value: undefined });
		assert.deepStrictEqual(parseOptionalNumber(' 0.7 '), { value: 0.7 });
		assert.ok('error' in parseOptionalNumber('abc'));
		assert.ok('error' in parseOptionalNumber('1e999'));
		assert.ok('error' in parseOptionalNumber('0x10'));
	});
	test('prices read as dollars per million tokens', () => {
		assert.strictEqual(describePrice({ promptPrice: 3, completionPrice: 15 }), '$3 in · $15 out per 1M tokens');
		assert.strictEqual(describePrice({ promptPrice: 0, completionPrice: 0 }), 'free');
		assert.strictEqual(describePrice({}), '');
		assert.strictEqual(describePrice({ promptPrice: 0.15, completionPrice: 0.6 }), '$0.15 in · $0.6 out per 1M tokens');
	});
});

suite('OpenRouter settings: the catalogue request', () => {
	const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
	test('reads /models without the key', async () => {
		let seen: { url: string; headers: Record<string, string> } | undefined;
		const entries = await fetchOpenRouterCatalog(async (url, init) => { seen = { url, headers: init.headers }; return new Response(JSON.stringify(sample)); }, 'https://openrouter.ai/api/v1');
		assert.strictEqual(entries.length, 3);
		assert.strictEqual(seen?.url, 'https://openrouter.ai/api/v1/models');
		assert.ok(!Object.keys(seen!.headers).some(k => k.toLowerCase() === 'authorization'));
	});
	test('refuses an error status, non-JSON, an empty list and an oversized body', async () => {
		await assert.rejects(fetchOpenRouterCatalog(json({}, 500), 'https://x'), /500/);
		await assert.rejects(fetchOpenRouterCatalog(async () => new Response('<html>'), 'https://x'), /not JSON/);
		await assert.rejects(fetchOpenRouterCatalog(json({ data: [] }), 'https://x'), /no models/);
		const big = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(4 * 1024 * 1024)); } }));
		await assert.rejects(fetchOpenRouterCatalog(async () => big, 'https://x'), /larger than expected/);
	});
	test('an outer abort ends it with its own reason, not the timeout text', async () => {
		const ctl = new AbortController();
		const p = fetchOpenRouterCatalog((_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))), 'https://x', ctl.signal);
		ctl.abort(new Error('closed'));
		await assert.rejects(p, /aborted/);
	});
});
