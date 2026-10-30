import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import * as protocol from './agentProtocol.ts';
import * as attachmentReferences from './attachmentReferences.ts';
import * as terminalPins from './terminalPins.ts';
import * as toolbarText from './toolbarText.ts';
import * as notifyText from '../core/notifyText.ts';
import * as visualizationProtocol from './visualizationProtocol.ts';
import * as visualizationStore from './visualizationStore.ts';
import * as mcpProtocol from '../mcp/mcpProtocol.ts';
import type { AgentEvent } from './agentProtocol.ts';
import type { TabHost, StoredChat } from './chatTab.ts';

const nativeRequire = createRequire(path.resolve('package.json'));
function load<T>(file: string, dependencies: Record<string, unknown>): T {
	const exports = {};
	runInNewContext(transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText, {
		exports, process, Buffer, setTimeout, clearTimeout, require: (name: string) => dependencies[name] ?? nativeRequire(name),
	});
	return exports as T;
}
const { ChatTab, newChat } = load<typeof import('./chatTab.ts')>('src/chat/chatTab.ts', {
	vscode: { l10n: { t: (text: string) => text } }, './agentProtocol': protocol, './agents': { agentNames: { codex: 'Codex' } },
	'./attachmentReferences': attachmentReferences, './terminalPins': terminalPins, './toolbarText': toolbarText,
	'../core/notifyText': notifyText, '../core/uuid': { generateUuid: randomUUID },
	'./visualizationProtocol': visualizationProtocol, './visualizationStore': visualizationStore,
});

async function fixture(run: (tab: InstanceType<typeof ChatTab>, host: TabHost, file: string) => Promise<void>) {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-browser-visualization-integration-'));
	let tab: InstanceType<typeof ChatTab> | undefined;
	try {
		const host: TabHost = {
			cwd: () => base, projectRoot: () => base, ownSettings: () => true, changed() {}, limits() {}, turnEnded() {},
			save: async () => {}, inHistory: () => false, approvalMode: () => 'ask', noteServer() {}, released() {},
			visualizationArchive: () => path.join(base, 'archive'),
		};
		tab = new ChatTab(host, newChat('codex'));
		const store = new visualizationStore.VisualizationStore(base, host.visualizationArchive!(), tab.chat.id);
		await store.prepare();
		await run(tab, host, path.join(store.directory, 'chart.html'));
	} finally { tab?.discard(); await fs.rm(base, { recursive: true, force: true }); }
}
function feed(tab: InstanceType<typeof ChatTab>, event: AgentEvent): void { Reflect.get(tab, '_onAgentEvent').call(tab, event); }
const drain = async (tab: InstanceType<typeof ChatTab>) => { await Reflect.get(tab, '_visualizationWork'); };

test('explicit publications update one card and restored history reads immutable snapshots', async () => fixture(async (tab, host, file) => {
	await fs.writeFile(file, '<input value="first">');
	await tab.presentVisualization(file, 'First chart');
	const first = tab.chat.entries.find(entry => entry.kind === 'assistant')!;
	assert.equal(first.kind, 'assistant');
	if (first.kind !== 'assistant') { return; }
	const original = first.visualizations![0].revision!;
	feed(tab, { type: 'text', text: 'Here is your graph.' });
	assert.equal(tab.chat.entries.length, 2, 'Agent text must not append to a tool-created marker.');
	await fs.writeFile(file, '<input value="second">');
	await tab.presentVisualization(file, 'Revised chart');
	assert.equal(tab.chat.entries.length, 2);
	assert.equal(first.visualizations![0].title, 'Revised chart');
	assert.notEqual(first.visualizations![0].revision, original);
	await fs.unlink(file);
	const stored = JSON.parse(JSON.stringify(tab.chat)) as StoredChat;
	const restored = new ChatTab(host, stored);
	await drain(restored);
	assert.equal(Object.values(restored.visualizations)[0]?.html, '<input value="second">');
	assert.equal(JSON.stringify(stored).includes('<input'), false, 'History must not embed large executable HTML.');
	restored.discard();
}));

test('split markers publish only after completion and failed updates retain the last good revision', async () => fixture(async (tab, _host, file) => {
	await fs.writeFile(file, '<p>Good</p>');
	const reference = `\uE200visualize\uE202${JSON.stringify({ path: file })}\uE201`;
	feed(tab, { type: 'text', text: reference.slice(0, -1) });
	await drain(tab);
	assert.equal(Object.keys(tab.visualizations).length, 0);
	feed(tab, { type: 'text', text: reference.slice(-1) });
	await drain(tab);
	const entry = tab.chat.entries[0];
	assert.equal(entry.kind, 'assistant');
	if (entry.kind !== 'assistant') { return; }
	const revision = entry.visualizations![0].revision!;
	assert.equal(tab.visualizations[revision].html, '<p>Good</p>');
	await fs.unlink(file);
	feed(tab, { type: 'tool', id: 'write', tool: { kind: 'edit', name: 'Write HTML' } });
	feed(tab, { type: 'toolUpdate', id: 'write', update: { status: 'done' } });
	await drain(tab);
	assert.equal(entry.visualizations![0].revision, revision);
	assert.ok(entry.visualizations![0].error);
	assert.equal(tab.visualizations[revision].html, '<p>Good</p>');
}));

test('presentation tool uses the caller capability and cannot select a different conversation', async () => {
	const { chatTools, ChatControlPort } = load<typeof import('../mcp/chatTools.ts')>('src/mcp/chatTools.ts', { './mcpProtocol': mcpProtocol });
	const port = new ChatControlPort();
	const seen: unknown[] = [];
	port.target = { tabOf: (id: string) => id === 'own' ? 'own-tab' : undefined, presentHtml: async (...args: unknown[]) => { seen.push(args); return { displayed: true }; } } as unknown as NonNullable<typeof port.target>;
	const tool = chatTools(port).find(item => item.name === 'chat_present_html')!;
	await assert.rejects(tool.run({ path: '/tmp/a.html' }, {} as mcpProtocol.Caller), /Only the agents/);
	await assert.rejects(tool.run({ path: '/tmp/a.html' }, { chatId: 'unknown' } as mcpProtocol.Caller), /no longer open/);
	await tool.run({ path: '/tmp/a.html', chatId: 'other', title: 'Chart' }, { chatId: 'own' } as mcpProtocol.Caller);
	assert.deepEqual(seen, [['own-tab', '/tmp/a.html', 'Chart']]);
});
