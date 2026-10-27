// Both ends of a remote terminal in one process: the website's shim (`remoteTerminal.ts`) and the
// editor's hub, with a real TerminalTab on a fake PTY. Frames pass through JSON, as on the socket.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createRemoteTerminalShim } from './remoteTerminal.ts';
import { RemoteTerminalHub, isTerminalReply, readAgentTerminalFrame, remoteInputFrameMax, splitTerminalData } from '../src/chat/remoteTerminalProtocol.ts';
import { TerminalTab, type TerminalHandlers, type TerminalSessionLike } from '../src/chat/terminalTab.ts';

class FakeSession implements TerminalSessionLike {
	written: string[] = [];
	resized: [number, number][] = [];
	exited = false;
	exitCode: number | undefined;
	write(data: string): void { this.written.push(data); }
	resize(c: number, r: number): void { this.resized.push([c, r]); }
	ack(): void {}
	replay() { return { data: 'user@host $ ', seq: 12 }; }
	dispose(): void {}
}

test('website shim and editor hub: watch, take control, type, editor resize held, editor takes back', async () => {
	const session = new FakeSession();
	let handlers!: TerminalHandlers;
	const tab = new TerminalTab('t1', 'zsh', '/p', undefined, async h => { handlers = h; return { session }; }, () => undefined, () => undefined);
	await tab.start();
	tab.setRemote(true);
	const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
	const emitted: Record<string, unknown>[] = [];
	const notices: string[] = [];
	let shim!: ReturnType<typeof createRemoteTerminalShim>;
	const hub = new RemoteTerminalHub({
		allowed: () => true, epoch: () => 'ep1', find: id => (id === 't1' ? tab : undefined),
		send: frame => { shim.fromAgent(wire(frame)); },
	});
	shim = createRemoteTerminalShim({
		viewerId: 'viewer-0001', epoch: () => 'ep1', send: frame => { hub.receive(wire(frame)); return true; },
		emit: m => emitted.push(m as unknown as Record<string, unknown>), notice: t => notices.push(t),
		readAgentFrame: readAgentTerminalFrame, isTerminalReply, splitData: splitTerminalData, inputFrameMax: remoteInputFrameMax,
		setTimer: () => 0, clearTimer: () => {},
	});
	const of = (type: string) => emitted.filter(m => m.type === type);

	shim.fromView({ type: 'terminalAttach', id: 't1', cols: 60, rows: 20 });
	assert.equal(of('terminalReplay')[0]?.data, 'user@host $ ');
	assert.equal(shim.holder('t1'), 'editor', 'a new viewer watches');
	assert.deepEqual(session.resized, [], 'attaching does not resize the PTY');

	handlers.onData('ls\r\n', 4);
	assert.equal(of('terminalData').at(-1)?.data, 'ls\r\n');

	shim.fromView({ type: 'terminalInput', id: 't1', data: 'whoami\r' });
	assert.deepEqual(session.written, [], 'a watcher types nothing');
	assert.equal(notices.length, 1);

	shim.toggle('t1');
	assert.equal(shim.holder('t1'), 'you');
	assert.equal(tab.remoteControl, true);
	assert.equal(tab.summary().remoteControl, true);
	shim.fromView({ type: 'terminalResize', id: 't1', cols: 40, rows: 15 });
	assert.deepEqual(session.resized.at(-1), [40, 15]);
	tab.resize(120, 40);
	assert.deepEqual(session.resized.at(-1), [40, 15], 'the editor view does not resize the PTY while the website holds control');
	shim.fromView({ type: 'terminalInput', id: 't1', data: 'whoami\r' });
	assert.deepEqual(session.written, ['whoami\r']);

	tab.input('x');
	assert.equal(shim.holder('t1'), 'editor', 'the editor\'s typing takes control back');
	assert.equal(tab.remoteControl, false);
	assert.deepEqual(session.resized.at(-1), [120, 40], 'the editor view\'s size returns');
	shim.fromView({ type: 'terminalInput', id: 't1', data: 'again\r' });
	assert.deepEqual(session.written, ['whoami\r', 'x']);
	assert.equal(tab.summary().remoteViewers, 1);
	hub.dropAll();
	assert.equal(tab.summary().remoteViewers, undefined);
});
