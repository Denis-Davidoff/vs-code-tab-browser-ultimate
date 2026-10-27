import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { exchangeServerUrl, exchangeSnapshot, readExchangeCommand } from './exchangeProtocol.ts';
import type { ChatViewState } from './chatProtocol';

test('Exchange permits TLS and private-network development, rejecting credentials and public plaintext', () => {
	assert.equal(exchangeServerUrl('https://exchange.example'), 'wss://exchange.example');
	assert.equal(exchangeServerUrl('http://localhost:3001'), 'ws://localhost:3001');
	for (const host of ['192.168.1.172', '10.2.3.4', '172.16.0.1', '172.31.255.255', '[fd12::1]']) {
		assert.equal(exchangeServerUrl(`http://${host}:3000`), `ws://${host}:3000`);
	}
	for (const url of ['http://remote.example', 'http://172.32.0.1', 'http://192.169.1.1', 'http://192.168.1.172.evil.example', 'http://8.8.8.8', 'ws://localhost.evil.example', 'https://user:password@example.com', 'https://example.com/?token=secret', 'https://example.com/path', 'file:///tmp/socket']) {
		assert.throws(() => exchangeServerUrl(url));
	}
});

test('Exchange accepts only bounded chat commands with no extra capabilities', () => {
	const send = { type: 'chat.send', id: randomUUID(), chatId: 'chat', text: 'Hello' };
	assert.deepEqual(readExchangeCommand(send), send);
	for (const command of [{ ...send, text: '' }, { ...send, text: 'a'.repeat(64001) }, { ...send, command: 'terminal' }, { ...send, type: 'executeCommand' }, { ...send, id: 'bad' }, { ...send, type: 'chat.stop' }]) {
		assert.equal(readExchangeCommand(command), undefined);
	}
	assert.ok(readExchangeCommand({ type: 'chat.stop', id: randomUUID(), chatId: 'chat' }));
});

test('Exchange publishes a bounded text projection without local credentials or tools', () => {
	const state = { chatId: 'chat', running: false, dragToken: 'private-token', entries: [
		{ kind: 'user', text: 'Hello', attachments: ['private-file'] },
		{ kind: 'tool', id: 'tool', input: 'private-command', output: 'private-output' },
		{ kind: 'assistant', text: 'Hi' },
		{ kind: 'approval', title: 'Run command', detail: 'private-detail', status: 'pending' },
	] } as unknown as ChatViewState;
	const body = exchangeSnapshot(state);
	assert.equal(body.includes('private-'), false);
	assert.equal(JSON.parse(body).messages.length, 3);
	const huge = { ...state, entries: Array.from({ length: 1000 }, () => ({ kind: 'assistant', text: 'я'.repeat(64000) })) } as ChatViewState;
	assert.ok(Buffer.byteLength(exchangeSnapshot(huge)) <= 900000);
});
