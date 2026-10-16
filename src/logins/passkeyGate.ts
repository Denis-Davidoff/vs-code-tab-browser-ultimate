/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The page-side half of passkeys: a wrapper around `navigator.credentials`
 * that asks the extension before any WebAuthn ceremony runs. No imports, so it
 * can be loaded anywhere; the source is sent to the page as a string.
 *
 * **Why a wrapper in the page's own world, and why it is not the security
 * boundary.** The virtual authenticator `loginWatcher.ts` attaches to the tab
 * answers whoever calls it, and there is no CDP event for "a WebAuthn request
 * has started" — so without this the extension cannot ask the user anything.
 * But a page can always reach the browser's own `get` (through the prototype,
 * or from a fresh iframe), so the wrapper is only the *doorbell*. The lock is
 * the authenticator itself: it holds no credential, and has presence
 * simulation off, except while a ceremony the user approved is running.
 * Measured in Chrome 153: a page bypassing the wrapper gets `NotAllowedError`
 * from the empty authenticator, and a credential added after a request has
 * started is not picked up by it.
 */

/** The CDP binding the wrapper reports to. Removed from the page as soon as it is captured. */
export const passkeyBinding = '__aiBrowserPasskey';

/** Where the wrapper keeps its state, for the extension to settle a request through. */
export const passkeyStateKey = 'aiBrowser.passkey';

/** What the wrapper sends for a ceremony. Ids are base64url, as the page spells them. */
export interface PasskeyRequestMessage {
	readonly op: 'get' | 'create';
	readonly token: string;
	readonly rpId: string;
	readonly rpName?: string;
	readonly userName?: string;
	readonly userDisplayName?: string;
	readonly allow?: readonly string[];
	readonly exclude?: readonly string[];
}

export type PasskeyMessage =
	| PasskeyRequestMessage
	| { readonly op: 'abort' | 'done'; readonly token: string };

/**
 * How the extension answers a request: run it, or refuse it.
 *
 * There is no "already registered" answer, and its absence is deliberate. It
 * used to exist, sent without asking anybody — which let a site test which of
 * its credential ids this browser holds and recognise a signed-out user. The
 * spec reveals `InvalidStateError` only after the user has made a gesture; a
 * refusal that looks like any other is the answer that reveals nothing.
 */
export type PasskeyVerdictWord = 'proceed' | 'deny';

/**
 * The wrapper. Runs in the main world, on every new document and once in the
 * current one.
 *
 * Details that are load-bearing:
 *
 * - **Installed twice, it hands over rather than stacking.** A new CDP session
 *   on the same tab runs this again in the same document, and the old
 *   session's binding no longer reaches anyone. So a second run replaces
 *   `notify` in the shared state, denies whatever the old session left
 *   waiting, and wraps again if an uninstall had unwrapped.
 * - **It can be uninstalled**, and must be when its session goes for good —
 *   the passkey or logins setting switched off, the tab dropped from the
 *   watched set, the extension shutting down. Otherwise every later sign-in
 *   with a passkey on that page waits for an answer nobody will give. The
 *   browser's own methods come back, and a request already waiting goes to
 *   them.
 * - **Every wait has a deadline**: the page's own WebAuthn `timeout`, or five
 *   minutes. It is the backstop for the case no uninstall reaches — an
 *   extension host that crashed.
 * - **Conditional mediation passes straight through.** It is the passkey
 *   autofill a sign-in page starts on load and leaves pending; prompting for it
 *   would put a picker in front of everybody who merely opened the page.
 * - **Anything that is not `publicKey`** — passwords, federated, OTP — is not
 *   ours and goes to the browser untouched.
 * - **An `AbortSignal` is honoured while the user is being asked**, and tells
 *   the extension to take the prompt down: a page that gives up must not leave
 *   a picker behind it.
 * - **`done` is reported once the browser's call settles**, success or not, so
 *   the extension can empty the authenticator again straight away.
 * - **Every install has an `owner`**, the session that made it. A hand-over
 *   moves the gate to the new owner, and an uninstall only acts for the
 *   current one — a session that left calls it late, after its successor took
 *   over, and an uninstall that did not check would switch the new gate off.
 */
export function passkeyGateSource(owner: string): string {
	return `(() => {
	const notify = globalThis[${JSON.stringify(passkeyBinding)}];
	try { delete globalThis[${JSON.stringify(passkeyBinding)}]; } catch (e) { /* not configurable: harmless */ }
	if (typeof notify !== 'function' || !navigator.credentials) { return; }
	const key = Symbol.for(${JSON.stringify(passkeyStateKey)});
	const existing = globalThis[key];
	if (existing && typeof existing.handOver === 'function') { existing.handOver(notify, ${JSON.stringify(owner)}); return; }
	let owner = ${JSON.stringify(owner)};

	const container = navigator.credentials;
	const nativeGet = container.get.bind(container);
	const nativeCreate = container.create.bind(container);
	const waiting = new Map();
	let reporter = notify;
	let next = 0;

	const send = (message) => { if (reporter) { try { reporter(JSON.stringify(message)); } catch (e) { /* session gone */ } } };
	const bytes = (source) => {
		if (!source) { return undefined; }
		const view = source instanceof ArrayBuffer ? new Uint8Array(source)
			: ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : undefined;
		if (!view) { return undefined; }
		let text = '';
		for (let i = 0; i < view.length; i++) { text += String.fromCharCode(view[i]); }
		return btoa(text).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
	};
	const ids = (list) => Array.isArray(list)
		? list.slice(0, 64).map(item => bytes(item && item.id)).filter(Boolean) : undefined;
	const refused = () => new DOMException(
		'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.',
		'NotAllowedError');

	const ask = (message, publicKey, signal) => new Promise((resolve, reject) => {
		const token = String(++next) + '.' + Math.random().toString(36).slice(2);
		if (signal && signal.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return; }
		const requested = Number(publicKey.timeout);
		const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.max(requested, 10000), 600000) : 300000;
		let timer = 0;
		const stop = () => { clearTimeout(timer); if (signal) { signal.removeEventListener('abort', onAbort); } };
		const giveUp = (error) => { stop(); waiting.delete(token); send({ op: 'abort', token }); reject(error); };
		const onAbort = () => giveUp(signal.reason ?? new DOMException('Aborted', 'AbortError'));
		if (signal) { signal.addEventListener('abort', onAbort, { once: true }); }
		timer = setTimeout(() => giveUp(refused()), limit);
		waiting.set(token, (verdict) => { stop(); resolve({ token, verdict }); });
		send({ ...message, token });
	});

	const run = async (message, options, native) => {
		const { token, verdict } = await ask(message, options.publicKey, options.signal);
		if (verdict !== 'proceed') { throw refused(); }
		try {
			return await native(options);
		} finally {
			send({ op: 'done', token });
		}
	};

	const wrappedGet = function get(options) {
		const publicKey = options && options.publicKey;
		if (!reporter || !publicKey || options.mediation === 'conditional') { return nativeGet(options); }
		return run({
			op: 'get',
			rpId: typeof publicKey.rpId === 'string' ? publicKey.rpId : location.hostname,
			allow: ids(publicKey.allowCredentials),
		}, options, nativeGet);
	};
	const wrappedCreate = function create(options) {
		const publicKey = options && options.publicKey;
		if (!reporter || !publicKey) { return nativeCreate(options); }
		const rp = publicKey.rp || {};
		const user = publicKey.user || {};
		return run({
			op: 'create',
			rpId: typeof rp.id === 'string' ? rp.id : location.hostname,
			rpName: typeof rp.name === 'string' ? rp.name.slice(0, 200) : undefined,
			userName: typeof user.name === 'string' ? user.name.slice(0, 200) : undefined,
			userDisplayName: typeof user.displayName === 'string' ? user.displayName.slice(0, 200) : undefined,
			exclude: ids(publicKey.excludeCredentials),
		}, options, nativeCreate);
	};
	const wrap = () => {
		for (const [name, value] of [['get', wrappedGet], ['create', wrappedCreate]]) {
			Object.defineProperty(container, name, { value, writable: true, configurable: true, enumerable: false });
		}
	};
	const answerAll = (verdict) => {
		const pending = [...waiting.values()];
		waiting.clear();
		for (const settle of pending) { settle(verdict); }
	};
	Object.defineProperty(globalThis, key, {
		value: Object.freeze({
			settle(token, verdict) {
				const settle = waiting.get(token);
				if (settle) { waiting.delete(token); settle(verdict); }
			},
			handOver(fresh, newOwner) { reporter = fresh; owner = newOwner; answerAll('deny'); wrap(); },
			uninstall(who) {
				if (who !== undefined && who !== owner) { return; }
				// With nobody reporting, a waiting request goes to the browser's
				// own authenticators: the virtual one left with the session.
				reporter = null;
				answerAll('proceed');
				delete container.get;
				delete container.create;
			},
		}),
	});
	wrap();
})();`;
}
