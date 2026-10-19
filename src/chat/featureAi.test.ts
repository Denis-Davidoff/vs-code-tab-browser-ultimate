import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { aiFeatures, featureAiKey, featureEffort, readFeatureAiSettings } from './featureAi.ts';
import { titleModel } from './autoTitle.ts';
import type { ChatModel } from './chatProtocol.ts';

const model = (id: string, efforts: string[] = ['low', 'medium', 'high', 'max']): ChatModel => ({ id, label: id, efforts, isDefault: true });

test('feature choices have independent safe defaults and validate persisted input', () => {
	for (const feature of aiFeatures) {
		assert.deepEqual(readFeatureAiSettings(undefined)[feature], { agent: 'auto', effort: 'minimum' });
	}
	const settings = readFeatureAiSettings({ commitMessage: { agent: 'codex', effort: 'maximum' }, branchName: { agent: 'claude', effort: 'medium' }, chatTitle: { agent: 'other', effort: 'extreme' } });
	assert.deepEqual(settings.commitMessage, { agent: 'codex', effort: 'maximum' });
	assert.deepEqual(settings.branchName, { agent: 'claude', effort: 'medium' });
	assert.deepEqual(settings.chatTitle, { agent: 'auto', effort: 'minimum' });
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
	return runInNewContext(code, { featureAiKey, featureEffort, readFeatureAiSettings, titleModel, AbortController })[name];
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
	let applied: string | undefined;
	const tab = { chat: { id: 'chat' }, applyGeneratedTitle(_id: string, title: string) { applied = title; } };
	const host = {
		_featureSelection: (feature: string) => { assert.equal(feature, 'chatTitle'); return { agent: 'claude', model: model('haiku'), effort: 'max' }; },
		_registry: { backend(agent: string) { actualAgent = agent; return { async generateTitle(selected: ChatModel) { actualEffort = selected.efforts[0]; return 'Title'; } }; } },
		_titleRequests: new Map(), _featureRequestAgents: new WeakMap(), _tabs: [tab],
	};
	generate.call(host, tab, 'codex', 'discussion');
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(actualAgent, 'claude');
	assert.equal(actualEffort, 'max');
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
