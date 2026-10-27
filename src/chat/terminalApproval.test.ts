import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import type { AgentEvent, ApprovalRequest, TerminalApproval } from './agentProtocol.ts';
import type { ApprovalEntry, ApprovalMode } from './chatProtocol.ts';
import type { TabHost } from './chatTab.ts';
import { TerminalGrants } from '../mcp/terminalGrants.ts';
import { mintTerminalGrant, terminalInputFingerprint } from '../mcp/terminalInput.ts';

// The approval of typing into a terminal, as ChatTab handles it: a look answered without a
// card, an input asked on a card that names the terminal, and a one-shot grant minted
// before the agent is told yes — whether by a click, "Always" or the approval menu.

const nativeRequire = createRequire(resolve('package.json'));
function load<T>(file: string, dependencies: Record<string, unknown> = {}): T {
	const code = transpileModule(readFileSync(resolve(file), 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
	const exports = {};
	runInNewContext(code, { exports, process, Buffer, setTimeout, clearTimeout, require: (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : nativeRequire(name) });
	return exports as T;
}
const protocol = load<typeof import('./agentProtocol.ts')>('src/chat/agentProtocol.ts');

function fixture(modes: Record<string, ApprovalMode> = {}, pinned = true) {
	const { ChatTab, newChat } = load<typeof import('./chatTab.ts')>('src/chat/chatTab.ts', {
		vscode: { l10n: { t: (text: string) => text } },
		'./agentProtocol': protocol, './agents': { agentNames: { claude: 'Claude Code' } },
		'../core/uuid': { generateUuid: () => 'test-chat' }, '../core/notifyText': load('src/core/notifyText.ts'),
		'./terminalPins': load('src/chat/terminalPins.ts'), './toolbarText': {},
		'./attachmentReferences': load('src/chat/attachmentReferences.ts'),
	});
	const grants = new TerminalGrants();
	const log: string[] = [];
	const host = {
		cwd: () => '/tmp', projectRoot: () => undefined, ownSettings: () => true,
		changed() {}, limits() {}, turnEnded() {}, save: async () => {}, inHistory: () => false,
		approvalMode: (key: string) => modes[key] ?? 'ask', noteServer() {}, released() {},
		pinnedTerminals: () => pinned ? [{ id: 't1', name: 'Build', status: 'running', cwd: '/work/app', cols: 80, rows: 24, agentControl: 'allowed' }] : [],
		mintTerminalGrant: (chatId: string, approval: TerminalApproval) => { log.push('mint'); mintTerminalGrant(grants, chatId, approval); },
	} as unknown as TabHost;
	const tab = new ChatTab(host, newChat('claude'));
	const session = { running: false, ref: 'r', async send() { return true; }, stop() {}, dispose() {}, answer: (id: string, allow: boolean) => { log.push(`answer:${id}:${allow}`); } };
	Reflect.set(tab, '_session', session);
	const feed = Reflect.get(tab, '_onAgentEvent') as (event: AgentEvent) => void;
	const approve = (request: ApprovalRequest) => feed.call(tab, { type: 'approval', request });
	const entries = () => tab.chat.entries.filter((e): e is ApprovalEntry => e.kind === 'approval');
	return { tab, grants, log, approve, entries, chatId: tab.chat.id, host, modes };
}

const claude = (tool: string, input: Record<string, unknown>, id = 'r1') =>
	protocol.claudeApproval(id, { tool_name: `mcp__ai-browser__${tool}`, input }, '/w');
const send = (text: string, id = 'r1') => claude('terminal_send', { terminalId: 't1', text }, id);
const fp = (text: string) => terminalInputFingerprint('terminal_send', { terminalId: 't1', text })!;

test('a card for an input names the terminal and the exact text, and waits', () => {
	const f = fixture();
	f.approve(send('npm test'));
	const [card] = f.entries();
	assert.equal(card.status, 'pending');
	assert.equal(card.what, 'command');
	assert.equal(card.ask, 'Type into a terminal?');
	assert.equal(card.title, 'npm test  ⏎');
	assert.ok(card.detail?.startsWith('Terminal “Build” (/work/app)'), card.detail);
	assert.deepEqual(f.log, [], 'nothing answered, nothing granted');
});

test('a yes by click mints the grant for that exact input before the agent is told', () => {
	const f = fixture();
	f.approve(send('npm test'));
	f.tab.answer('r1', true);
	assert.deepEqual(f.log, ['mint', 'answer:r1:true']);
	assert.equal(f.grants.consume(f.chatId, 'terminal_send', fp('npm test -- --watch')), false, 'another input is not covered');
	assert.equal(f.grants.consume(f.chatId, 'terminal_send', fp('npm test')), true);
	assert.equal(f.grants.consume(f.chatId, 'terminal_send', fp('npm test')), false, 'once');
});

test('a no mints nothing, and a card answered twice mints once', () => {
	const f = fixture();
	f.approve(send('rm -rf build'));
	f.tab.answer('r1', false);
	assert.deepEqual(f.log, ['answer:r1:false']);
	assert.equal(f.grants.count(f.chatId), 0);

	const g = fixture();
	g.approve(send('ls'));
	g.tab.answer('r1', true);
	g.tab.answer('r1', true);
	assert.equal(g.grants.count(g.chatId), 1);
	assert.deepEqual(g.log, ['mint', 'answer:r1:true']);
});

test('Terminal on Auto: no card, and the grant is there before the answer', () => {
	const f = fixture({ command: 'auto' });
	f.approve(send('git pull'));
	assert.equal(f.entries().length, 0);
	assert.deepEqual(f.log, ['mint', 'answer:r1:true']);
	assert.equal(f.grants.consume(f.chatId, 'terminal_send', fp('git pull')), true);
});

test('Terminal on Deny: a quiet refusal, no grant', () => {
	const f = fixture({ command: 'deny' });
	f.approve(send('git push'));
	const [line] = f.entries();
	assert.equal(line.status, 'denied');
	assert.equal(line.auto, true);
	assert.deepEqual(f.log, ['answer:r1:false']);
	assert.equal(f.grants.count(f.chatId), 0);
});

test('a menu change that answers a waiting card grants it as a click would', () => {
	const f = fixture();
	f.approve(send('make'));
	f.modes.command = 'auto';
	f.tab.approvalModesChanged();
	assert.deepEqual(f.log, ['mint', 'answer:r1:true']);
	assert.equal(f.grants.count(f.chatId), 1);

	const g = fixture();
	g.approve(send('make'));
	g.modes.command = 'deny';
	g.tab.approvalModesChanged();
	assert.deepEqual(g.log, ['answer:r1:false']);
	assert.equal(g.grants.count(g.chatId), 0);
});

test('a card the CLI withdrew cannot be granted afterwards', () => {
	const f = fixture();
	f.approve(send('make'));
	(Reflect.get(f.tab, '_onAgentEvent') as (e: AgentEvent) => void).call(f.tab, { type: 'approvalDone', id: 'r1' });
	f.tab.answer('r1', true);
	assert.equal(f.grants.count(f.chatId), 0);
	assert.deepEqual(f.log, []);
});

test('keys are granted by their canonical names', () => {
	const f = fixture({ command: 'auto' });
	f.approve(claude('terminal_key', { terminalId: 't1', keys: ['Up', 'Return'] }));
	assert.equal(f.grants.consume(f.chatId, 'terminal_key', terminalInputFingerprint('terminal_key', { terminalId: 't1', keys: ['up', 'enter'] })!), true);
});

test('a look at a pinned terminal asks nothing — and is refused when Terminal is Deny', () => {
	for (const mode of ['ask', 'auto'] as const) {
		const f = fixture({ command: mode });
		f.approve(claude('terminal_read', { terminalId: 't1' }));
		assert.equal(f.entries().length, 0);
		assert.deepEqual(f.log, ['answer:r1:true'], mode);
		assert.equal(f.grants.count(f.chatId), 0);
	}
	const denied = fixture({ command: 'deny' });
	denied.approve(claude('terminal_list', {}));
	assert.deepEqual(denied.log, ['answer:r1:false']);
	assert.equal(denied.entries()[0].status, 'denied');
});

test('an input for a terminal that is not pinned here says it will be refused', () => {
	const f = fixture({}, false);
	f.approve(send('ls'));
	assert.ok(f.entries()[0].detail?.startsWith('Terminal t1 is not attached to this conversation'), f.entries()[0].detail);
});

test('an ordinary tool is untouched: no ask headline, no grant', () => {
	const f = fixture({ browser: 'auto' });
	f.approve(protocol.claudeApproval('r1', { tool_name: 'mcp__ai-browser__browser_click', input: { selector: '#a' } }, '/w'));
	assert.deepEqual(f.log, ['answer:r1:true']);
	const g = fixture();
	g.approve(protocol.claudeApproval('r1', { tool_name: 'Bash', input: { command: 'ls' } }, '/w'));
	assert.equal(g.entries()[0].ask, undefined);
	g.tab.answer('r1', true);
	assert.equal(g.grants.count(g.chatId), 0);
});
