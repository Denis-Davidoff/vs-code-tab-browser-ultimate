import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { aiFeatures, defaultFeaturePrompts, featureAgent, featurePromptLimit, featureAiKey, featureEffort, readFeatureAiSettings, defaultTitleRefresh, readTitleRefresh, titleRefreshDue } from './featureAi.ts';
import { titleModel } from './autoTitle.ts';
import type { ChatModel } from './chatProtocol.ts';

const model = (id: string, efforts: string[] = ['low', 'medium', 'high', 'max']): ChatModel => ({ id, label: id, efforts, isDefault: true });

test('feature choices have independent safe defaults and validate persisted input', () => {
	for (const feature of aiFeatures) {
		assert.deepEqual(readFeatureAiSettings(undefined)[feature], { agent: 'auto', effort: 'minimum', ...(feature === 'chatTitle' ? { refresh: defaultTitleRefresh } : {}) });
	}
	const settings = readFeatureAiSettings({ commitMessage: { agent: 'codex', effort: 'maximum' }, branchName: { agent: 'claude', effort: 'medium' }, chatTitle: { agent: 'other', effort: 'extreme' } });
	assert.deepEqual(settings.commitMessage, { agent: 'codex', effort: 'maximum' });
	assert.deepEqual(settings.branchName, { agent: 'claude', effort: 'medium' });
	assert.deepEqual(settings.chatTitle, { agent: 'auto', effort: 'minimum', refresh: defaultTitleRefresh });
	assert.deepEqual(readFeatureAiSettings(null), readFeatureAiSettings([]));
});

test('effort maps to supported levels, including absent and nonstandard ranges', () => {
	assert.equal(featureEffort(model('m'), 'minimum'), 'low');
	assert.equal(featureEffort(model('m'), 'medium'), 'medium');
	assert.equal(featureEffort(model('m'), 'maximum'), 'max');
	assert.equal(featureEffort(model('m', ['none', 'low', 'high']), 'medium'), 'low');
	for (const level of ['minimum', 'medium', 'maximum'] as const) {
		assert.equal(featureEffort(model('m', []), level), undefined);
		assert.equal(featureEffort(model('m', ['high']), level), 'high');
	}
});

const source = readFileSync('src/chat/chatView.ts', 'utf8');
function method(name: string) {
	const match = new RegExp(`private ${name}\\([\\s\\S]*?\\n\\t\\}`).exec(source)?.[0];
	assert.ok(match);
	const code = transpileModule(`({ ${match.replace('private ', '')} })`, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
	return runInNewContext(code, { featureAgent, featureAiKey, defaultFeaturePrompts, featureEffort, readFeatureAiSettings, titleModel, AbortController })[name];
}

test('feature routing follows Auto, supports a different agent and keeps lightweight naming models', () => {
	const select = method('_featureSelection');
	let stored: unknown;
	const host = {
		_context: { globalState: { get(key: string) { assert.equal(key, featureAiKey); return stored; } } },
		_registry: { agents: [
			{ id: 'codex', available: true, models: [model('gpt-large'), model('gpt-mini')] },
			{ id: 'claude', available: true, models: [model('sonnet'), model('haiku')] },
		] },
		_remembered: { models: { claude: 'sonnet' } },
		_selection: () => ({ agent: 'codex', model: 'gpt-large' }),
	};
	assert.equal(select.call(host, 'commitMessage', {}).model.id, 'gpt-large');
	assert.equal(select.call(host, 'branchName', {}).model.id, 'gpt-mini');
	assert.equal(select.call(host, 'chatTitle', {}).effort, 'low');
	stored = { commitMessage: { agent: 'claude', effort: 'maximum' }, branchName: { agent: 'claude', effort: 'medium' } };
	assert.equal(select.call(host, 'commitMessage', {}).agent, 'claude');
	assert.equal(select.call(host, 'commitMessage', {}).model.id, 'sonnet');
	assert.equal(select.call(host, 'commitMessage', {}).effort, 'max');
	assert.equal(select.call(host, 'branchName', {}).model.id, 'haiku');
	assert.equal(select.call(host, 'branchName', {}).effort, 'medium');
	host._registry.agents[1].available = false;
	assert.throws(() => select.call(host, 'branchName', {}), /unavailable/);
	host._registry.agents[0].models = [model('gpt-large')];
	assert.throws(() => select.call(host, 'chatTitle', {}), /lightweight/);
});

test('automatic chat titles send the configured agent and effort to the backend', async () => {
	const generate = method('_generateTabTitle');
	let actualAgent: string | undefined;
	let actualEffort: string | undefined;
	let actualPrompt: string | undefined;
	let applied: string | undefined;
	const tab = { chat: { id: 'chat' }, applyGeneratedTitle(_id: string, title: string) { applied = title; } };
	const host = {
		_featureSelection: (feature: string) => { assert.equal(feature, 'chatTitle'); return { agent: 'claude', model: model('haiku'), effort: 'max', prompt: 'Custom title system prompt' }; },
		_registry: { backend(agent: string) { actualAgent = agent; return { async generateTitle(selected: ChatModel, _context: string, _signal: AbortSignal, _purpose: unknown, prompt?: string) { actualPrompt = prompt; actualEffort = selected.efforts[0]; return 'Title'; } }; } },
		_titleRequests: new Map(), _featureRequestAgents: new WeakMap(), _tabs: [tab],
	};
	generate.call(host, tab, 'codex', 'discussion');
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(actualAgent, 'claude');
	assert.equal(actualEffort, 'max');
	assert.equal(actualPrompt, 'Custom title system prompt');
	assert.equal(applied, 'Title');
	assert.equal(host._titleRequests.size, 0);
});


test('refreshing a feature agent cancels its requests even when the chat uses another agent', () => {
	const replace = method('_onBackendReplaced');
	const title = new AbortController();
	const branch = new AbortController();
	const tab = { chat: { agent: 'codex' }, backendReplaced() {} };
	const messages: { type: string; id?: number }[] = [];
	const host = {
		_tabs: [tab], _titleRequests: new Map([[tab, title]]), _branchNameRequests: new Map([[tab, branch]]),
		_featureRequestAgents: new WeakMap([[title, 'claude'], [branch, 'claude']]),
		_branchNameRequestIds: new WeakMap([[branch, 7]]), _gitCommits: new Map(),
		_runs: { backendReplaced() {} }, _postMessage(message: { type: string; id?: number }) { messages.push(message); },
	};
	replace.call(host, 'codex', false);
	assert.equal(title.signal.aborted, false);
	assert.equal(branch.signal.aborted, false);
	replace.call(host, 'claude', false);
	assert.equal(title.signal.aborted, true);
	assert.equal(branch.signal.aborted, true);
	assert.equal(messages[0].type, 'gitBranchNameResult');
	assert.equal(messages[0].id, 7);
});


test('system prompts validate stored input and independently fall back to defaults', () => {
 const value = readFeatureAiSettings({ chatTitle: { prompt: '  Custom title instruction  ' }, branchName: { prompt: ' ' }, commitMessage: { prompt: 'x'.repeat(featurePromptLimit + 1) } });
 assert.equal(value.chatTitle.prompt, 'Custom title instruction');
 assert.equal(value.branchName.prompt, undefined); assert.equal(value.commitMessage.prompt, undefined);
 assert.equal(readFeatureAiSettings({ chatTitle: { prompt: 'bad\0prompt' } }).chatTitle.prompt, undefined);
 assert.equal(readFeatureAiSettings({ chatTitle: { prompt: 12 } }).chatTitle.prompt, undefined);
});

test('Auto runs a feature on the tab agent when it can, and falls back from Gemini CLI', () => {
 const auto = { agent: 'auto', effort: 'minimum' } as const;
 const all = () => true;
 assert.equal(featureAgent(auto, 'codex', all), 'codex');
 assert.equal(featureAgent(auto, 'gemini', all), 'claude');
 assert.equal(featureAgent(auto, 'gemini', id => id === 'codex'), 'codex');
 assert.equal(featureAgent(auto, 'claude', id => id === 'codex'), 'codex');
 // Nothing that can do it: the tab's agent, which then refuses with a reason.
 assert.equal(featureAgent(auto, 'gemini', id => id === 'gemini'), 'gemini');
 assert.equal(featureAgent({ agent: 'codex', effort: 'minimum' }, 'gemini', all), 'codex');
});

test('title refresh: read, clamped to the default, and when it is due', () => {
	assert.deepEqual(readTitleRefresh({ mode: 'once' }), { mode: 'once', every: 5 });
	assert.deepEqual(readTitleRefresh({ mode: 'messages', every: 3 }), { mode: 'messages', every: 3 });
	assert.deepEqual(readTitleRefresh({ mode: 'messages', every: 1 }), { mode: 'messages', every: 5 });
	assert.deepEqual(readTitleRefresh({ mode: 'context', every: 5 }), { mode: 'context', every: 100 });
	assert.deepEqual(readTitleRefresh({ mode: 'x' }), defaultTitleRefresh);
	const five = { mode: 'messages', every: 5 } as const;
	assert.deepEqual([1, 4, 5, 6].map(n => titleRefreshDue(five, n, undefined, 0)), [false, false, true, true]);
	const ctx = { mode: 'context', every: 50 } as const;
	assert.equal(titleRefreshDue(ctx, 3, 70000, 30000), false);
	assert.equal(titleRefreshDue(ctx, 3, 80000, 30000), true);
	assert.equal(titleRefreshDue(ctx, 3, undefined, 0), false);
	assert.equal(titleRefreshDue({ mode: 'once', every: 5 }, 6, 1e6, 0), false);
});
