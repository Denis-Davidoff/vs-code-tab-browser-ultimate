import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget, createSourceFile, forEachChild, isMethodDeclaration } from 'typescript';
import * as protocol from './agentProtocol.ts';
import * as attachmentReferences from './attachmentReferences.ts';
import * as terminalPins from './terminalPins.ts';
import * as toolbarText from './toolbarText.ts';
import * as notifyText from '../core/notifyText.ts';
import * as visualizationProtocol from './visualizationProtocol.ts';
import * as visualizationStore from './visualizationStore.ts';
import * as messageFiles from './messageFiles.ts';
import * as mcpProtocol from '../mcp/mcpProtocol.ts';
import * as chatFeatures from './core/chatFeatures.ts';
import type { AgentEvent } from './agentProtocol.ts';
import type { TabHost, StoredChat } from './chatTab.ts';

const nativeRequire = createRequire(path.resolve('package.json'));
function load<T>(file: string, dependencies: Record<string, unknown>): T {
	const exports = {};
	runInNewContext(transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText, {
		exports, process, Buffer, setTimeout, clearTimeout, require: (name: string) => dependencies[name] ?? (name === '../chat/core/chatFeatures' ? chatFeatures : nativeRequire(name)),
	});
	return exports as T;
}
const { ChatTab, newChat, settled } = load<typeof import('./chatTab.ts')>('src/chat/chatTab.ts', {
	vscode: { l10n: { t: (text: string) => text } }, './agentProtocol': protocol, './agents': { agentNames: { codex: 'Codex' } },
	'./attachmentReferences': attachmentReferences, './terminalPins': terminalPins, './toolbarText': toolbarText,
	'../core/notifyText': notifyText, '../core/uuid': { generateUuid: randomUUID },
	'./visualizationProtocol': visualizationProtocol, './visualizationStore': visualizationStore,
	'./messageFiles': messageFiles,
});

async function fixture(run: (tab: InstanceType<typeof ChatTab>, host: TabHost, file: string) => Promise<void>, agent: StoredChat['agent'] = 'codex') {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-browser-visualization-integration-'));
	let tab: InstanceType<typeof ChatTab> | undefined;
	try {
		const host: TabHost = {
			cwd: () => base, projectRoot: () => base, ownSettings: () => true, changed() {}, limits() {}, turnEnded() {},
			save: async () => {}, inHistory: () => false, approvalMode: () => 'ask', noteServer() {}, released() {},
			visualizationArchive: () => path.join(base, 'archive'),
		};
		tab = new ChatTab(host, newChat(agent));
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

test('image cards revise in place, restore from archive and retain a last good snapshot', async () => fixture(async (tab, host, htmlFile) => {
	const file = path.join(path.dirname(htmlFile), 'cat.png');
	const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
	await fs.writeFile(file, png);
	await tab.presentImage(file, 'Cat');
	const entry = tab.chat.entries[0];
	assert.equal(entry.kind, 'assistant');
	if (entry.kind !== 'assistant') { return; }
	assert.equal(entry.visualizations![0].kind, 'image');
	const original = entry.visualizations![0].revision!;
	assert.equal(tab.visualizations[original].image?.base64, png.toString('base64'));
	feed(tab, { type: 'text', text: 'Your cat.' });
	assert.equal(tab.chat.entries.length, 2);
	await fs.writeFile(file, Buffer.concat([png, Buffer.from('revision')]));
	await tab.presentImage(file, 'New cat');
	assert.equal(tab.chat.entries.length, 2);
	assert.notEqual(entry.visualizations![0].revision, original);
	await fs.unlink(file);
	feed(tab, { type: 'tool', id: 'write', tool: { kind: 'edit', name: 'Write image' } });
	feed(tab, { type: 'toolUpdate', id: 'write', update: { status: 'done' } });
	await drain(tab);
	assert.ok(entry.visualizations![0].error);
	const saved = JSON.parse(JSON.stringify(tab.chat)) as StoredChat;
	assert.equal(JSON.stringify(saved).includes(png.toString('base64')), false);
	const restored = new ChatTab(host, saved);
	await drain(restored);
	assert.ok(restored.visualizations[entry.visualizations![0].revision!].image);
	restored.discard();
}));

test('image markers stream to cards and the MCP image tool requires the caller conversation', async () => fixture(async (tab, _host, htmlFile) => {
	const file = path.join(path.dirname(htmlFile), 'cat.gif');
	await fs.writeFile(file, Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
	const reference = `\uE200image\uE202${JSON.stringify({ path: file })}\uE201`;
	feed(tab, { type: 'text', text: reference.slice(0, -1) });
	await drain(tab);
	assert.equal(Object.keys(tab.visualizations).length, 0);
	feed(tab, { type: 'text', text: reference.slice(-1) });
	await drain(tab);
	assert.equal(Object.values(tab.visualizations)[0].image?.mimeType, 'image/gif');
	const { chatTools, ChatControlPort } = load<typeof import('../mcp/chatTools.ts')>('src/mcp/chatTools.ts', { './mcpProtocol': mcpProtocol });
	const port = new ChatControlPort();
	port.target = { tabOf: (id: string) => id === 'own' ? tab.id : undefined, presentImage: async (_tab: string, file: string, title?: string) => tab.presentImage(file, title) } as unknown as NonNullable<typeof port.target>;
	const tool = chatTools(port).find(tool => tool.name === 'chat_present_image')!;
	await assert.rejects(tool.run({ path: file }, {} as mcpProtocol.Caller), /Only the agents/);
	await assert.rejects(tool.run({ path: file }, { chatId: 'unknown' } as mcpProtocol.Caller), /no longer open/);
	await assert.rejects(tool.run({ path: file, title: 'x'.repeat(161) }, { chatId: 'own' } as mcpProtocol.Caller), /160/);
	await tool.run({ path: file, title: 'Cat' }, { chatId: 'own' } as mcpProtocol.Caller);
	assert.equal(tab.chat.entries.length, 1);
}));

for (const agent of ['codex', 'claude'] as const) {
	test(`${agent} publishes all artifact tools and restores their files after source removal`, async () => fixture(async (tab, host, htmlFile) => {
		const { chatTools, ChatControlPort } = load<typeof import('../mcp/chatTools.ts')>('src/mcp/chatTools.ts', { './mcpProtocol': mcpProtocol });
		const port = new ChatControlPort();
		port.target = { tabOf: (id: string) => id === 'own' ? tab.id : undefined, presentArtifact: async (_tab: string, file: string, kind: import('./visualizationProtocol.ts').ArtifactKind, title?: string) => tab.presentArtifact(file, kind, title) } as unknown as NonNullable<typeof port.target>;
		const inputs = [
			{ kind: 'file', name: 'report.pdf', data: Buffer.from('%PDF-1.4 example') },
			{ kind: 'table', name: 'table.json', data: Buffer.from(JSON.stringify({ columns: ['Value'], rows: [[42]] })) },
			{ kind: 'sources', name: 'sources.json', data: Buffer.from(JSON.stringify([{ title: 'Example', url: 'https://example.com' }])) },
			{ kind: 'audio', name: 'audio.wav', data: Buffer.from('RIFF0000WAVE') },
			{ kind: 'video', name: 'video.webm', data: Buffer.from([26, 69, 223, 163]) },
		] as const;
		for (const input of inputs) {
			const file = path.join(path.dirname(htmlFile), input.name);
			await fs.writeFile(file, input.data);
			const tool = chatTools(port).find(tool => tool.name === `chat_present_${input.kind}`)!;
			await assert.rejects(tool.run({ path: file }, {} as mcpProtocol.Caller), /Only the agents/);
			await tool.run({ path: file, title: input.name }, { chatId: 'own' } as mcpProtocol.Caller);
			await fs.unlink(file);
		}
		const entries = tab.chat.entries.filter(entry => entry.kind === 'assistant');
		assert.equal(entries.length, inputs.length);
		for (const entry of entries) {
			const revision = entry.visualizations![0].revision!;
			assert.ok(await tab.artifactFile(revision));
		}
		assert.equal(await tab.artifactFile('a'.repeat(64)), undefined);
		const restored = new ChatTab(host, JSON.parse(JSON.stringify(tab.chat)));
		await drain(restored);
		assert.equal(Object.values(restored.visualizations).filter(value => value.artifact).length, 5);
		restored.discard();
	}, agent));
}

test('Claude Code plain markers and MCP completions reach the same image and table cards', async () => fixture(async (tab, _host, htmlFile) => {
	const instruction = await Reflect.get(tab, '_visualizationInstruction').call(tab);
	assert.match(instruction, /mcp__ai-browser__chat_present_image/);
	const image = path.join(path.dirname(htmlFile), 'claude.gif');
	await fs.writeFile(image, Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
	const table = path.join(path.dirname(htmlFile), 'table.json');
	await fs.writeFile(table, JSON.stringify({ columns: ['Value'], rows: [[42]] }));
	const text = `image${JSON.stringify({ path: image })}\ntable${JSON.stringify({ path: table })}`;
	const send = (message: Record<string, unknown>) => { for (const event of protocol.claudeEvents(message)) { feed(tab, event); } };
	send({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
	for (const part of [text.slice(0, 17), text.slice(17)]) {
		send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } });
	}
	send({ type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} });
	await drain(tab);
	const entry = tab.chat.entries.find(entry => entry.kind === 'assistant')!;
	assert.deepEqual(Array.from(entry.visualizations!, ref => ref.kind), ['image', 'table']);
	assert.equal(Object.keys(tab.visualizations).length, 2);
}, 'claude'));

for (const agent of ['codex', 'claude'] as const) {
	test(`${agent} rich tools update notifications, progress, plans and JSON cards without duplicates`, async () => fixture(async (tab) => {
		const { chatTools, ChatControlPort } = load<typeof import('../mcp/chatTools.ts')>('src/mcp/chatTools.ts', { './mcpProtocol': mcpProtocol });
		const port = new ChatControlPort();
		port.target = { tabOf: (id: string) => id === 'own' ? tab.id : undefined, presentRich: async (_tab: string, kind: string, args: Record<string, unknown>) => tab.presentRich(kind, args) } as unknown as NonNullable<typeof port.target>;
		const tools = chatTools(port);
		for (const name of ['chat_notify', 'chat_progress', 'chat_update_plan', 'chat_present_json', 'chat_present_result', 'chat_cite']) {
			await assert.rejects(tools.find(tool => tool.name === name)!.run({}, {} as mcpProtocol.Caller), /Only the agents/);
		}
		await tab.presentRich('notification', { id: 'notice', text: 'Starting', level: 'info' });
		const initial = tab.chat.entries.find(entry => entry.kind === 'notice')!;
		await tab.presentRich('notification', { id: 'notice', text: 'Check this', level: 'warning', reason: 'Needs attention', actions: [{ label: 'Docs', kind: 'link', url: 'https://example.com' }] });
		assert.equal(tab.chat.entries.filter(entry => entry.kind === 'notice').length, 1);
		const notice = tab.chat.entries.find(entry => entry.kind === 'notice')!;
		assert.equal(notice.kind === 'notice' && notice.at, initial.kind === 'notice' && initial.at);
		assert.equal(notice.kind === 'notice' && notice.level, 'warning');
		await tab.presentRich('progress', { id: 'job', title: 'Work', percent: 10, cancel: {} });
		const startedAt = tab.chat.entries.find(entry => entry.kind === 'progress')!.startedAt;
		await tab.presentRich('progress', { id: 'job', title: 'Work', stage: 'Second phase', percent: null });
		const progress = tab.chat.entries.find(entry => entry.kind === 'progress')!;
		assert.equal(progress.startedAt, startedAt); assert.equal(progress.percent, null);
		const generation = tab.stopGeneration;
		await tab.cancelProgress('job'); await tab.cancelProgress('job');
		assert.equal(tab.stopGeneration, generation + 1);
		assert.ok(progress.cancelRequestedAt);
		await tab.presentRich('plan', { id: 'plan', steps: [{ id: 'read', text: 'Read', status: 'done' }, { id: 'build', text: 'Build', status: 'inProgress' }] });
		feed(tab, { type: 'turnEnd', error: 'Stopped.' });
		assert.equal(progress.status, 'cancelled'); assert.ok(progress.endedAt);
		const plan = tab.chat.entries.find(entry => entry.kind === 'plan')!;
		assert.deepEqual(Array.from(plan.steps, step => step.status), ['done', 'cancelled']);
		await tab.presentRich('json', { id: 'json', title: 'Object', value: { count: 42, enabled: false, empty: null } });
		await tab.presentRich('json', { id: 'json', title: 'Updated', value: [1, true, null] });
		const results = tab.chat.entries.filter(entry => entry.kind === 'result');
		assert.equal(results.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(results[0].blocks)), [{ type: 'json', value: [1, true, null] }]);
	}, agent));
}

test('native mixed tool results archive binary blocks, keep JSON types and restore without inline payloads in history', async () => fixture(async (tab, host) => {
	const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
	feed(tab, { type: 'tool', id: 'mixed', tool: { kind: 'mcp', name: 'Mixed result' } });
	const events = protocol.codexEvents('item/completed', { item: { type: 'mcpToolCall', id: 'mixed', status: 'completed', result: { content: [
		{ type: 'text', text: 'Result' }, { type: 'image', mimeType: 'image/gif', data: gif }, { type: 'resource', resource: { uri: 'report.txt', blob: 'aGk=' } }, { type: 'resource_link', uri: 'https://example.com', name: 'Link' },
	], structuredContent: { count: 42, valid: false } } } });
	for (const event of events) { feed(tab, event); }
	await Reflect.get(tab, '_richWork'); await drain(tab);
	const tool = tab.chat.entries.find(entry => entry.kind === 'tool')!;
	assert.deepEqual(Array.from(tool.blocks!, block => block.type), ['text', 'image', 'file', 'link', 'json']);
	assert.deepEqual(tool.blocks!.at(-1), { type: 'json', title: 'Structured result', value: { count: 42, valid: false } });
	assert.equal(JSON.stringify(tab.chat).includes(gif), false);
	assert.equal(Object.values(tab.visualizations).filter(snapshot => snapshot.image || snapshot.artifact).length, 2);
	const restored = new ChatTab(host, JSON.parse(JSON.stringify(tab.chat)));
	await drain(restored);
	assert.equal(Object.values(restored.visualizations).filter(snapshot => snapshot.image || snapshot.artifact).length, 2);
	const file = tool.blocks!.find(block => block.type === 'file')!;
	assert.equal((await restored.artifactFile(file.type === 'file' ? file.ref!.revision! : ''))?.base64, 'aGk=');
	restored.discard();
}));

test('cited answers keep stable message ids, exact quote ranges, and reject citations into another conversation', async () => fixture(async (tab) => {
	const text = 'The **cat** is orange.';
	const answer = await tab.presentRich('citations', { text, citations: [{ quote: '**cat**', target: { type: 'url', url: 'https://example.com/cat' } }] }) as { messageId: string };
	const message = tab.chat.entries.find(entry => entry.kind === 'assistant' && entry.id === answer.messageId)!;
	assert.equal(message.kind === 'assistant' && message.citations?.length, 1);
	await tab.presentRich('citations', { messageId: answer.messageId, citations: [{ quote: 'orange', target: { type: 'file', path: '/tmp/colors.ts', line: 12 } }] });
	assert.equal(tab.chat.entries.filter(entry => entry.kind === 'assistant').length, 1);
	await assert.rejects(tab.presentRich('citations', { messageId: 'foreign', citations: [] }), /not in this conversation/);
	await assert.rejects(tab.presentRich('citations', { messageId: answer.messageId, citations: [{ quote: 'orange', target: { type: 'message', toolId: 'foreign-tool' } }] }), /does not belong/);
	feed(tab, { type: 'tool', id: 'own-tool', tool: { kind: 'read', name: 'Read file' } });
	await tab.presentRich('citations', { messageId: answer.messageId, citations: [{ quote: 'orange', target: { type: 'message', toolId: 'own-tool' } }] });
	assert.equal(message.kind === 'assistant' && message.citations?.[0].target.type, 'message');
}));

test('closing a tab while native attachments archive still saves the received data', async () => fixture(async (tab, host) => {
	const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
	let saved: StoredChat | undefined;
	host.save = async chat => { saved = JSON.parse(JSON.stringify(chat)); };
	await tab.presentRich('progress', { id: 'job', title: 'Work', cancel: {} });
	feed(tab, { type: 'tool', id: 'image', tool: { kind: 'mcp', name: 'Image' } });
	feed(tab, { type: 'toolUpdate', id: 'image', update: { status: 'done', blocks: [{ type: 'image', mimeType: 'image/gif', base64: gif }] } });
	tab.close();
	await Reflect.get(tab, '_richWork'); await Reflect.get(tab, '_save').call(tab);
	const tool = saved?.entries.find(entry => entry.kind === 'tool');
	assert.equal(tool?.blocks?.[0].type, 'image');
	assert.equal(JSON.stringify(saved).includes(gif), false);
	assert.equal(saved?.entries.find(entry => entry.kind === 'progress')?.status, 'cancelled');
}));

test('queued rich results cannot resurrect a deleted conversation when a tab is reused', async () => fixture(async (tab, host) => {
	const oldId = tab.chat.id, saved: string[] = [];
	host.save = async chat => { saved.push(chat.id); };
	feed(tab, { type: 'tool', id: 'image', tool: { kind: 'mcp', name: 'Image' } });
	feed(tab, { type: 'toolUpdate', id: 'image', update: { blocks: [{ type: 'image', mimeType: 'image/gif', base64: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }] } });
	tab.discard(); tab.start(newChat('codex'));
	await Reflect.get(tab, '_richWork'); await drain(tab);
	assert.equal(saved.includes(oldId), false);
}));

test('a restarted progress card resets cancellation and history settles unfinished progress', async () => fixture(async (tab) => {
	await tab.presentRich('progress', { id: 'job', title: 'First run', cancel: {} });
	await tab.cancelProgress('job');
	feed(tab, { type: 'turnEnd', error: 'Stopped.' });
	await tab.presentRich('progress', { id: 'job', title: 'Second run', status: 'running', percent: 0 });
	const progress = tab.chat.entries.find(entry => entry.kind === 'progress')!;
	assert.equal(progress.cancelRequestedAt, undefined); assert.equal(progress.endedAt, undefined);
	const ended = settled(progress);
	assert.equal(ended.kind === 'progress' && ended.status, 'cancelled'); assert.equal(ended.kind === 'progress' && ended.endedAt, progress.updatedAt);
}));

test('background-agent progress ends on its own agent state rather than the parent turn', async () => fixture(async (tab) => {
	feed(tab, { type: 'tool', id: 'agent-row', tool: { kind: 'agent', name: 'Worker', agent: { threadId: 'child', background: true } } });
	await tab.presentRich('progress', { id: 'agent-job', title: 'Worker progress', cancel: { agentId: 'agent-row' } });
	feed(tab, { type: 'turnEnd' });
	const progress = tab.chat.entries.find(entry => entry.kind === 'progress')!;
	assert.equal(progress.status, 'running');
	feed(tab, { type: 'agentStates', states: [{ threadId: 'child', status: 'stopped' }] });
	assert.equal(progress.status, 'cancelled'); assert.ok(progress.endedAt);
}));


/** Exercise the actual HTTP body reader without opening a socket. */
async function readPresentationRequest(args: Record<string, unknown>): Promise<mcpProtocol.JsonRpcRequest> {
	const source = readFileSync('src/mcp/mcpServer.ts', 'utf8');
	const file = createSourceFile('mcpServer.ts', source, ScriptTarget.ES2022, true);
	let method = '';
	const visit = (node: import('typescript').Node) => { if (isMethodDeclaration(node) && node.name.getText(file) === '_readBody') { method = node.getText(file); } forEachChild(node, visit); };
	visit(file);
	const limits = Array.from(source.matchAll(/^const (?:maxRequestBytes|drainLimitBytes) = .*;$/gm), match => match[0]).join('\n');
	const exports = {} as { Probe: new () => { _readBody(request: EventEmitter): Promise<string> } };
	runInNewContext(transpileModule(`${limits}\nclass Probe {${method}}\nexports.Probe=Probe;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, { exports, Buffer });
	const request = new EventEmitter(); Object.assign(request, { destroy() {} });
	const pending = new exports.Probe()._readBody(request);
	request.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'chat_present_result', arguments: args } })));
	request.emit('end');
	return JSON.parse(await pending) as mcpProtocol.JsonRpcRequest;
}

for (const agent of ['codex', 'claude'] as const) {
	test(`${agent} publishes 1 MB and 4 MB multipart files through the real MCP request limit using paths`, async () => fixture(async (tab, _host, htmlFile) => {
		const { chatTools, ChatControlPort } = load<typeof import('../mcp/chatTools.ts')>('src/mcp/chatTools.ts', { './mcpProtocol': mcpProtocol });
		const port = new ChatControlPort();
		port.target = { tabOf: (id: string) => id === 'own' ? tab.id : undefined, presentRich: async (_tab: string, kind: string, args: Record<string, unknown>) => tab.presentRich(kind, args) } as unknown as NonNullable<typeof port.target>;
		const file = path.join(path.dirname(htmlFile), 'report.bin'), image = path.join(path.dirname(htmlFile), 'cat.gif');
		await fs.writeFile(image, Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
		for (const size of [1_000_000, 4_000_000]) {
			const bytes = Buffer.alloc(size, 97); await fs.writeFile(file, bytes);
			const request = await readPresentationRequest({ id: 'multipart', blocks: [{ type: 'text', text: 'Report' }, { type: 'json', value: { bytes: size } }, { type: 'file', path: file }, { type: 'image', path: image }] });
			const response = await mcpProtocol.dispatch(request, { tools: chatTools(port), serverVersion: 'test', workspaceName: undefined }, { kind: agent, chatId: 'own' } as mcpProtocol.Caller);
			assert.equal((response?.result as { isError?: boolean }).isError, undefined);
			const result = tab.chat.entries.find(entry => entry.kind === 'result')!;
			assert.deepEqual(Array.from(result.blocks, block => block.type), ['text', 'json', 'file', 'image']);
			const block = result.blocks[2]; assert.equal(block.type, 'file');
			if (block.type !== 'file') { return; }
			const saved = await tab.artifactFile(block.ref!.revision!);
			assert.equal(saved?.bytes, size); assert.ok(Buffer.from(saved!.base64, 'base64').equals(bytes));
			assert.equal(JSON.stringify(tab.chat).includes('"path"'), false);
		}
		await assert.rejects(readPresentationRequest({ blocks: [{ type: 'file', name: 'report.bin', base64: Buffer.alloc(1_000_000).toString('base64') }] }), /exceeds 1 MB/);
		const outside = path.join(path.dirname(path.dirname(htmlFile)), 'outside.bin');
		await fs.writeFile(outside, 'outside');
		await tab.presentRich('result', { id: 'outside', blocks: [{ type: 'file', path: outside }] });
		const rejected = tab.chat.entries.find((entry): entry is Extract<typeof entry, { kind: 'result' }> => entry.kind === 'result' && entry.id === 'outside')!;
		assert.equal(rejected.blocks[0].type, 'text');
		assert.equal(rejected.blocks.some(block => block.type === 'file'), false);
	}, agent));
}

for (const error of [undefined, 'Stopped.']) {
	test(`uncancellable related background progress survives parent completion (${error ?? 'success'})`, async () => fixture(async (tab) => {
		feed(tab, { type: 'tool', id: 'worker', tool: { kind: 'agent', name: 'Worker', agent: { threadId: 'child', background: true } } });
		await tab.presentRich('progress', { id: 'job', title: 'Worker progress', related: { toolId: 'worker' }, percent: 20 });
		feed(tab, { type: 'turnEnd', error });
		const progress = tab.chat.entries.find(entry => entry.kind === 'progress')!;
		assert.equal(progress.status, 'running'); assert.equal(progress.endedAt, undefined);
		await tab.presentRich('progress', { id: 'job', title: 'Worker progress', percent: 40 });
		assert.equal(tab.chat.entries.find(entry => entry.kind === 'progress')!.status, 'running');
		feed(tab, { type: 'agentStates', states: [{ threadId: 'child', status: 'done' }] });
		assert.equal(tab.chat.entries.find(entry => entry.kind === 'progress')!.status, 'done');
	}, 'codex'));
}
