/** Content encryption for Exchange. The relay never receives passwords or derived keys. */
export interface ExchangeEncryption {
	version: 1;
	salt: string;
	epoch: string;
	check: string;
	iv: string;
}
export interface ExchangeCipher {
	descriptor: ExchangeEncryption;
	key: Awaited<ReturnType<typeof crypto.subtle.importKey>>;
	pointId: string;
	received?: Map<string, Map<string, number>>;
}
const utf8 = new TextEncoder();
const b64 = (bytes: Uint8Array) => {
	let text = '';
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text);
};
const bytes = (text: string) =>
	Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
const aad = (value: unknown) => utf8.encode(JSON.stringify(value));
export async function exchangeCipher(
	password: string,
	pointId: string,
	descriptor?: ExchangeEncryption,
): Promise<ExchangeCipher> {
	if (!globalThis.crypto?.subtle)
		throw new Error('Encrypted workspaces require HTTPS (or localhost).');
	const salt = descriptor
		? bytes(descriptor.salt)
		: crypto.getRandomValues(new Uint8Array(16));
	if (salt.length !== 16 || (descriptor && descriptor.version !== 1))
		throw new Error('Unsupported workspace encryption.');
	const material = await crypto.subtle.importKey(
		'raw',
		utf8.encode(password),
		'PBKDF2',
		false,
		['deriveKey'],
	);
	const key = await crypto.subtle.deriveKey(
		{ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt },
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
	if (descriptor) {
		try {
			const plain = await crypto.subtle.decrypt(
				{
					name: 'AES-GCM',
					iv: bytes(descriptor.iv),
					additionalData: aad([pointId, descriptor.epoch, 'check']),
				},
				key,
				bytes(descriptor.check),
			);
			if (new TextDecoder().decode(plain) !== 'AI Browser workspace')
				throw new Error();
		} catch {
			throw new Error('Incorrect workspace password.');
		}
	} else {
		const epoch = crypto.randomUUID(),
			iv = crypto.getRandomValues(new Uint8Array(12));
		descriptor = {
			version: 1,
			salt: b64(salt),
			epoch,
			iv: b64(iv),
			check: b64(
				new Uint8Array(
					await crypto.subtle.encrypt(
						{
							name: 'AES-GCM',
							iv,
							additionalData: aad([pointId, epoch, 'check']),
						},
						key,
						utf8.encode('AI Browser workspace'),
					),
				),
			),
		};
	}
	return { key, pointId, descriptor };
}

/** A socket-compatible transport. Service presence/auth stay outside the encrypted content. */
export function encryptedExchangeSocket(
	url: string,
	cipher?: ExchangeCipher,
	agent = false,
	sync?: () => void,
	Constructor: typeof WebSocket = WebSocket,
): WebSocket {
	if (!cipher) return new Constructor(url);
	const channel = url.includes('/ws/stream-') ? 'media' : 'chat',
		sender = crypto.randomUUID();
	const transport = new Constructor(url),
		events = new EventTarget();
	let sequence = 0,
		sendQueue = Promise.resolve(),
		receiveQueue = Promise.resolve(),
		challenge = '',
		verified = agent;
	let ready: Record<string, unknown> | undefined;
	cipher.received ??= new Map();
	const bucket = channel + (agent ? ':agent' : ':viewer');
	let seen = cipher.received.get(bucket);
	if (!seen) {
		seen = new Map<string, number>();
		cipher.received.set(bucket, seen);
	}
	const emit = (type: string, event: Event) => {
		events.dispatchEvent(event);
		const handler = (facade as any)['on' + type];
		if (typeof handler === 'function') handler.call(facade, event);
	};
	const dispatch = (value: unknown) =>
		emit(
			'message',
			new MessageEvent('message', { data: JSON.stringify(value) }),
		);
	const seal = (value: unknown) => {
		sendQueue = sendQueue
			.then(async () => {
				const header = {
					type: 'secure',
					version: 1,
					epoch: cipher.descriptor.epoch,
					sender,
					seq: ++sequence,
					frame: (value as any)?.type === 'browser.frame',
				};
				const iv = crypto.getRandomValues(new Uint8Array(12));
				const ciphertext = await crypto.subtle.encrypt(
					{
						name: 'AES-GCM',
						iv,
						additionalData: aad([
							cipher.pointId,
							channel,
							agent ? 'agent' : 'viewer',
							header,
						]),
					},
					cipher.key,
					utf8.encode(JSON.stringify(value)),
				);
				if (transport.readyState === 1)
					transport.send(
						JSON.stringify({
							...header,
							iv: b64(iv),
							data: b64(new Uint8Array(ciphertext)),
						}),
					);
			})
			.catch(() => transport.close(1008, 'Encryption failed'));
	};
	const hello = () => {
		verified = false;
		challenge = crypto.randomUUID();
		seal({ type: 'secure.hello', challenge });
	};
	const facade = {
		get readyState() {
			return transport.readyState;
		},
		get bufferedAmount() {
			return transport.bufferedAmount;
		},
		close(code?: number, reason?: string) {
			transport.close(code, reason);
		},
		send(raw: string) {
			const value = JSON.parse(raw);
			if (value.type === 'auth') {
				transport.send(
					JSON.stringify({
						...value,
						...(agent
							? { encryption: cipher.descriptor }
							: { encrypted: true }),
					}),
				);
				return;
			}
			if (value.type === 'browser.watch') {
				transport.send(raw);
				return;
			}
			if (!agent && !verified) throw new Error('Workspace is locked.');
			seal(value);
		},
		addEventListener: events.addEventListener.bind(events),
		removeEventListener: events.removeEventListener.bind(events),
		onopen: null,
		onmessage: null,
		onclose: null,
		onerror: null,
	};
	transport.addEventListener('open', () => emit('open', new Event('open')));
	transport.addEventListener('error', () => emit('error', new Event('error')));
	transport.addEventListener('close', (event) =>
		emit(
			'close',
			Object.assign(new Event('close'), {
				code: event.code,
				reason: event.reason,
			}),
		),
	);
	transport.addEventListener('message', (event) => {
		receiveQueue = receiveQueue
			.then(async () => {
				const value = JSON.parse(String(event.data));
				if (value.type === 'ready') {
					if (
						!value.encryption ||
						(['version', 'salt', 'epoch', 'check', 'iv'] as const).some(
							(field) => value.encryption[field] !== cipher.descriptor[field],
						)
					)
						throw new Error(
							'Workspace encryption changed. Reload and unlock again.',
						);
					ready = value;
					if (agent) dispatch(value);
					else if (value.online) hello();
					else dispatch(value);
					return;
				}
				if (
					['presence', 'browser.presence', 'browser.viewers', 'chat.viewers'].includes(
						value.type,
					)
				) {
					if (!agent && value.online === true) hello();
					dispatch(value);
					return;
				}
				if (
					value.type !== 'secure' ||
					value.version !== 1 ||
					value.epoch !== cipher.descriptor.epoch ||
					typeof value.sender !== 'string' ||
					!Number.isSafeInteger(value.seq) ||
					value.seq <= 0
				)
					throw new Error('Unencrypted or invalid workspace content.');
				if (
					value.sender.length > 64 ||
					(!seen.has(value.sender) && seen.size >= 1024)
				)
					throw new Error('Too many encrypted sessions.');
				const { iv, data, ...header } = value;
				const plain = await crypto.subtle.decrypt(
					{
						name: 'AES-GCM',
						iv: bytes(iv),
						additionalData: aad([
							cipher.pointId,
							channel,
							agent ? 'viewer' : 'agent',
							header,
						]),
					},
					cipher.key,
					bytes(data),
				);
				if (value.seq <= (seen.get(value.sender) ?? 0)) return;
				seen.set(value.sender, value.seq);
				const message = JSON.parse(new TextDecoder().decode(plain));
				if (agent && message.type === 'secure.hello') {
					seal({ type: 'secure.welcome', challenge: message.challenge });
					sync?.();
					return;
				}
				if (!agent && message.type === 'secure.welcome') {
					if (message.challenge === challenge) {
						verified = true;
						if (ready) dispatch(ready);
					}
					return;
				}
				if (agent || verified) dispatch(message);
			})
			.catch(() =>
				transport.close(
					1008,
					'Workspace encryption changed or verification failed. Reload to unlock.',
				),
			);
	});
	return facade as unknown as WebSocket;
}

export function workspaceExchangeSocket(
	url: string,
	pointId: string,
): WebSocket {
	const host = (
		globalThis as unknown as {
			parent: {
				aiBrowserWorkspaceKeys?: Map<string, ExchangeCipher | undefined>;
			};
		}
	).parent;
	if (!host.aiBrowserWorkspaceKeys?.has(pointId))
		throw new Error('Open and unlock this workspace from your connections.');
	return encryptedExchangeSocket(url, host.aiBrowserWorkspaceKeys.get(pointId));
}
