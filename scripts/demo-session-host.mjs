// Run `npm run build-ext` first. This demo imports no VS Code or agent runtime.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SessionHost, sessionChannel, reduceSession } = require('../out/chat/core/sessionHost.js');
const { AhpPrototypeConnection } = require('../out/chat/core/ahpPrototype.js');

const channel = sessionChannel('demo-chat');
let current = { id: 'demo-chat', title: 'Browser verification', agent: 'codex', directory: '/demo', running: true,
  entries: [{ kind: 'user', id: 'prompt', text: 'Verify the page', attachments: [] }], pendingSends: [] };
const host = new SessionHost({ replayLimit: 2, execute(command) {
  if (command.type === 'stop') { current = { ...current, running: false }; }
  else { current = { ...current, entries: current.entries.map(entry => entry.kind === 'approval' && entry.id === command.approvalId
    ? { ...entry, status: command.allow ? 'allowed' : 'denied' } : entry) }; }
  host.publish(current);
} });
host.publish(current);
const rpc = (method, params) => ({ jsonrpc: '2.0', id: 1, method, params });
const peers = ['desktop', 'phone'].map(name => {
  const peer = { name, state: undefined, sequence: 0, connected: true };
  peer.connection = new AhpPrototypeConnection(host, { clientKey: `demo/${name}`, canRead: () => true, canControl: () => true,
    send(message) {
      if (!peer.connected) return;
      if ('method' in message) {
        peer.state = reduceSession(peer.state, message.params.action.change); peer.sequence = message.params.serverSeq;
        return;
      }
      // Install response bases in the same delivery stream as live actions.
      const result = message.result;
      if (!result) return;
      for (const snapshot of [...(result.snapshots ?? []), ...(result.snapshot ? [result.snapshot] : [])]) {
        if (snapshot.resource === channel) { peer.state = snapshot.state; peer.sequence = snapshot.fromSeq; }
      }
      for (const event of result.actions ?? []) { peer.state = reduceSession(peer.state, event.action.change); peer.sequence = event.serverSeq; }
      if (result.serverSeq !== undefined) peer.sequence = result.serverSeq;
    } });
  return peer;
});
try {
  for (const peer of peers) {
    const result = await peer.connection.receive(rpc('initialize', { channel: 'ahp-root://', clientId: peer.name,
      protocolVersions: ['1.0.0'], initialSubscriptions: [channel] }));
    assert.ok(result.result);
  }
  current = { ...current, entries: [...current.entries, { kind: 'assistant', id: 'reply', text: 'Checking…' }] }; host.publish(current);
  assert.deepEqual(peers[0].state, peers[1].state);
  console.log('PASS: desktop and phone receive the same streaming state');

  peers[1].connected = false;
  current = { ...current, entries: [...current.entries, { kind: 'approval', id: 'approval', what: 'command', title: 'Run checks?', status: 'pending' }] }; host.publish(current);
  const approval = { channel, chatId: 'demo-chat', commandId: 1, approvalId: 'approval', allow: true };
  assert.ok((await peers[0].connection.receive(rpc('x-ai-browser/approve', approval))).result);
  assert.ok((await peers[0].connection.receive(rpc('x-ai-browser/approve', approval))).result);
  assert.ok((await peers[1].connection.receive(rpc('x-ai-browser/approve', { ...approval, allow: false }))).error);
  console.log('PASS: approval retry is idempotent; a second client cannot resolve it twice');

  for (const title of ['Checking layout', 'Checking links', 'Checks complete']) { current = { ...current, title }; host.publish(current); }
  peers[1].connected = true;
  const recovered = await peers[1].connection.receive(rpc('reconnect', { channel: 'ahp-root://', clientId: 'phone',
    lastSeenServerSeq: peers[1].sequence, subscriptions: [channel] }));
  assert.equal(recovered.result.type, 'snapshot');
  assert.deepEqual(peers[0].state, peers[1].state);
  console.log('PASS: offline phone recovers through a snapshot after replay eviction');

  assert.ok((await peers[1].connection.receive(rpc('x-ai-browser/stop', { channel, chatId: 'demo-chat', commandId: 2 }))).result);
  assert.equal(peers[0].state.running, false); assert.equal(peers[1].state.running, false);
  console.log('PASS: Stop from the phone reaches both clients');
} finally { for (const peer of peers) peer.connection.dispose(); host.dispose(); }
