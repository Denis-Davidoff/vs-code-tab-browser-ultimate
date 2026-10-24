import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { exchangeCipher, encryptedExchangeSocket } from './exchangeCrypto.ts';
const pause = () => new Promise((resolve) => setTimeout(resolve, 15));
async function waitFor(check: () => boolean) {
	for (let i = 0; i < 100; i++) {
		if (check()) return;
		await pause();
	}
	assert.fail('Encrypted transport timed out');
}
async function pair() {
	const pointId = crypto.randomUUID(),
		cipher = await exchangeCipher('a long test-only password', pointId),
		transports: Transport[] = [],
		received: any[] = [];
	class Transport extends EventTarget {
		readyState = 1;
		bufferedAmount = 0;
		sent: any[] = [];
		code?: number;
		readonly url: string;
		constructor(url: string) {
			super();
			this.url = url;
			transports.push(this);
			queueMicrotask(() => this.dispatchEvent(new Event('open')));
		}
		send(raw: string) {
			const value = JSON.parse(raw);
			this.sent.push(value);
			if (value.type === 'auth') {
				queueMicrotask(() =>
					this.deliver({
						type: 'ready',
						version: 1,
						online: true,
						encryption: cipher.descriptor,
					}),
				);
				return;
			}
			const peer = transports.find((t) => t !== this);
			if (peer) queueMicrotask(() => peer.deliver(value));
		}
		deliver(value: any) {
			this.dispatchEvent(
				new MessageEvent('message', { data: JSON.stringify(value) }),
			);
		}
		close(code?: number) {
			if (this.readyState === 3) return;
			this.readyState = 3;
			this.code = code;
			this.dispatchEvent(
				Object.assign(new Event('close'), { code: code ?? 1000 }),
			);
		}
	}
	const agent = encryptedExchangeSocket(
		'ws://localhost/ws/agent',
		cipher,
		true,
		undefined,
		Transport as any,
	);
	agent.onopen = () => agent.send(JSON.stringify({ type: 'auth' }));
	agent.onmessage = (e) => received.push(JSON.parse(e.data));
	const viewer = encryptedExchangeSocket(
		'ws://localhost/ws/browser',
		{ ...cipher, received: undefined },
		false,
		undefined,
		Transport as any,
	);
	let unlocked = false;
	viewer.onopen = () => viewer.send(JSON.stringify({ type: 'auth' }));
	viewer.onmessage = (e) => {
		if (JSON.parse(e.data).type === 'ready') unlocked = true;
	};
	await waitFor(() => unlocked);
	return { cipher, transports, received, agent, viewer };
}
test('workspace passwords are checked locally and descriptors contain no password', async () => {
	const password = 'a separate test password',
		cipher = await exchangeCipher(password, crypto.randomUUID());
	assert.equal(JSON.stringify(cipher.descriptor).includes(password), false);
	await exchangeCipher(password, cipher.pointId, cipher.descriptor);
	await assert.rejects(
		() =>
			exchangeCipher('incorrect password', cipher.pointId, cipher.descriptor),
		/Incorrect/,
	);
	await assert.rejects(
		() => exchangeCipher(password, crypto.randomUUID(), cipher.descriptor),
		/Incorrect/,
	);
});
test('encrypted commands arrive once; ciphertext replay cannot execute them again', async () => {
	const h = await pair();
	h.viewer.send(
		JSON.stringify({ type: 'chat.command', text: 'private content' }),
	);
	await waitFor(() => h.received.some((v) => v.text === 'private content'));
	const packet = h.transports[1].sent.at(-1);
	assert.equal(packet.type, 'secure');
	assert.equal(JSON.stringify(packet).includes('private content'), false);
	h.transports[0].deliver(packet);
	await pause();
	assert.equal(
		h.received.filter((v) => v.text === 'private content').length,
		1,
	);
	h.agent.close();
	h.viewer.close();
});
test('modified ciphertext is rejected before any command is dispatched', async () => {
	const h = await pair();
	h.viewer.send(
		JSON.stringify({ type: 'chat.command', text: 'private content' }),
	);
	await waitFor(() => h.received.some((v) => v.text === 'private content'));
	const packet = { ...h.transports[1].sent.at(-1) };
	packet.data = (packet.data[0] === 'A' ? 'B' : 'A') + packet.data.slice(1);
	packet.seq++;
	h.transports[0].deliver(packet);
	await waitFor(() => h.transports[0].readyState === 3);
	assert.equal(h.transports[0].code, 1008);
	assert.equal(
		h.received.filter((v) => v.text === 'private content').length,
		1,
	);
	h.viewer.close();
});
test('reflection and plaintext downgrade are rejected by protected endpoints', async () => {
	const h = await pair();
	h.viewer.send(
		JSON.stringify({ type: 'chat.command', text: 'private content' }),
	);
	await waitFor(() => h.received.some((v) => v.text === 'private content'));
	h.transports[1].deliver(h.transports[1].sent.at(-1));
	await waitFor(() => h.transports[1].readyState === 3);
	assert.equal(h.transports[1].code, 1008);
	h.transports[0].deliver({ type: 'chat.command', text: 'forged cleartext' });
	await waitFor(() => h.transports[0].readyState === 3);
	assert.equal(
		h.received.some((v) => v.text === 'forged cleartext'),
		false,
	);
});

test('encrypted Exchange connections accept relay viewer presence without exposing chat content',async()=>{
 const h=await pair();
 h.transports[0].deliver({type:'chat.viewers',count:2});
 await waitFor(()=>h.received.some(value=>value.type==='chat.viewers'));
 assert.equal(h.received.find(value=>value.type==='chat.viewers').count,2);
 assert.equal(h.transports[0].readyState,1);
 h.agent.close();h.viewer.close();
});
