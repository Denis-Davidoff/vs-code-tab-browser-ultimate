import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createSourceFile, isClassDeclaration, isMethodDeclaration, ScriptTarget, transpileModule } from 'typescript';
import { codexAgentThreadEvents } from './agentProtocol.ts';

function fixture(request: (method: string, params: any) => Promise<unknown>) {
  const source = readFileSync('src/chat/codexAgent.ts', 'utf8');
  const ast = createSourceFile('codexAgent.ts', source, ScriptTarget.ES2022, true);
  const session = ast.statements.find(node => isClassDeclaration(node) && node.name?.text === 'CodexSession');
  assert.ok(session && isClassDeclaration(session));
  const names = new Set(['emit', 'notifyAgent', '_watchAgentHealth', '_checkAgent', 'stopAgent']);
  const methods = session.members.filter(node => isMethodDeclaration(node) && names.has(node.name.getText(ast))).map(node => node.getText(ast));
  const Session = runInNewContext(transpileModule(`class Session { ${methods.join('\n')} }; Session;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, {
    codexAgentThreadEvents, setInterval: () => 1, clearInterval() {}, vscode: { l10n: { t: (s: string) => s } },
  });
  const instance = new Session(), events: any[] = [];
  Object.assign(instance, { _backend: { request }, _agentActivity: new Map(), _agentTurns: new Map(), _backgroundAgents: new Set(), _onEvent: { fire: (event: unknown) => events.push(event) }, _noteChanges() {}, _watchAgent() {} });
  instance.emit({ type: 'tool', id: 'row-child', tool: { kind: 'agent', agent: { threadId: 'child-thread', background: true } } });
  return { instance, events };
}

test('usage-limit errors settle the child row and release background work', () => {
  const f = fixture(async () => ({}));
  f.instance.notifyAgent('child-thread', 'error', { error: { message: 'Usage limit reached' }, willRetry: false });
  assert.equal(f.events.at(-1).id, 'row-child'); assert.equal(f.events.at(-1).update.status, 'failed');
  assert.equal(f.instance._backgroundAgents.size, 0); assert.equal(f.instance._agentActivity.size, 0);
});

test('watchdog reconciles a missed failure but preserves genuinely active long-running work', async () => {
  const failed = fixture(async () => ({ thread: { status: { type: 'idle' }, turns: [{ status: 'failed', error: { message: 'Usage limit reached' } }] } }));
  await failed.instance._checkAgent('child-thread');
  assert.equal(failed.events.at(-1).update.status, 'failed'); assert.equal(failed.instance._backgroundAgents.size, 0);
  const active = fixture(async () => ({ thread: { status: { type: 'active' }, turns: [{ id: 'turn-1', status: 'inProgress' }] } }));
  await active.instance._checkAgent('child-thread');
  assert.equal(active.events.at(-1).update.agent.health, 'responsive'); assert.equal(active.instance._backgroundAgents.size, 1);
});

test('unreachable backend is shown as unresponsive rather than falsely successful or stopped', async () => {
  const f = fixture(async () => { throw new Error('No connection'); });
  await f.instance._checkAgent('child-thread');
  assert.equal(f.events.at(-1).update.agent.health, 'unresponsive'); assert.equal(f.events.at(-1).update.status, undefined);
  assert.equal(f.instance._backgroundAgents.size, 1);
});

test('a late watchdog response cannot overwrite newer agent activity', async () => {
  let resolve!: (value: unknown) => void;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  const checking = f.instance._checkAgent('child-thread');
  f.instance.notifyAgent('child-thread', 'turn/started', { turn: { id: 'new-turn' } });
  resolve({ thread: { status: { type: 'idle' }, turns: [{ status: 'failed' }] } }); await checking;
  assert.equal(f.instance._backgroundAgents.size, 1); assert.equal(f.instance._agentTurns.get('child-thread'), 'new-turn');
});

test('Stop reconciles an already failed child instead of leaving its Running row behind', async () => {
  const f = fixture(async () => ({ thread: { status: { type: 'idle' }, turns: [{ status: 'failed', error: { message: 'Usage limit' } }] } }));
  await f.instance.stopAgent('row-child', 'child-thread');
  assert.equal(f.events.at(-1).update.status, 'failed'); assert.equal(f.instance._backgroundAgents.size, 0);
});

test('fresh agent activity clears a stale unresponsive label immediately', async () => {
  const f = fixture(async () => { throw new Error('Disconnected'); });
  await f.instance._checkAgent('child-thread');
  f.instance.notifyAgent('child-thread', 'thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 42 } } });
  assert.equal(f.events.at(-2).update.agent.health, 'responsive');
  assert.equal(f.events.at(-1).update.agent.tokens, 42);
});

for (const [kind, status] of [['completed', 'done'], ['interrupted', 'stopped']] as const) {
  test(`nested agent ${kind} preserves the parent's running turn and health tracking`, () => {
    const f = fixture(async () => ({}));
    f.instance.notifyAgent('child-thread', 'turn/started', { turn: { id: 'parent-turn' } });
    f.instance.notifyAgent('child-thread', 'item/started', { item: {
      type: 'subAgentActivity', kind: 'started', agentThreadId: 'nested-thread', agentPath: '/root/child/nested',
    } });
    f.instance._agentTurns.set('nested-thread', 'nested-turn');
    f.instance.notifyAgent('child-thread', 'item/started', { item: {
      type: 'subAgentActivity', kind, agentThreadId: 'nested-thread',
    } });
    assert.equal(f.events.at(-1).id, 'nested-thread');
    assert.equal(f.events.at(-1).update.status, status);
    assert.equal(f.instance._agentTurns.get('child-thread'), 'parent-turn');
    assert.ok(f.instance._agentActivity.has('child-thread'));
    assert.ok(f.instance._backgroundAgents.has('row-child'));
    assert.ok(!f.instance._agentActivity.has('nested-thread'));
    assert.ok(!f.instance._backgroundAgents.has('nested-thread'));
  });
}
