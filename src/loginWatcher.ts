/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { CDPClient } from './cdp';
import { loginFormSource, loginsApiName, loginsBinding, loginsWorld } from './loginFormScript';
import {
	readFormMessage, type FieldsMessage, type FillResult, type FormMessage, type PageLogin, type SubmitMessage,
} from './loginMessages';
import {
	passkeyBinding, passkeyGateSource, passkeyStateKey,
	type PasskeyMessage, type PasskeyRequestMessage, type PasskeyVerdictWord,
} from './passkeyGate';
import { isBrowserApiGranted } from './proposedApi';
import { originOf, type PasskeyEntry } from './vaultData';

/*
 * The CDP half of saved logins and passkeys.
 *
 * One session per recently active browser tab, **separate from the
 * controller's MCP sessions** and never shared with them: this one carries a
 * binding and a script in an isolated world, and a virtual authenticator, all
 * of which live exactly as long as the session that installed them. Mixing them
 * into the controller's cache would make an eviction there silently switch the
 * password manager off on a tab.
 *
 * Three things are measured facts about CDP, not choices, and the design rests
 * on them (Chrome 153 and Electron 43, which VS Code 1.140 ships):
 *
 * - `Runtime.bindingCalled` is delivered **only after `Runtime.enable`** on the
 *   session — calls made before it are lost, not queued — so the domains are
 *   enabled before anything is injected.
 * - A binding added with `executionContextName` exists only in that isolated
 *   world: the page's own scripts cannot see it, call it, or read what it is
 *   sent.
 * - The execution context's `origin` comes from the browser, so it is what a
 *   frame's origin is judged by — never anything the page reports. Its *id* is
 *   not stable, though: a cross-site navigation starts the numbering again, so
 *   an id alone never decides where a password goes (see `fill`).
 */

/** How many tabs keep a session. The rest attach again when they become active. */
const watchedTabLimit = 3;

/** A binding call larger than this is not ours. */
const messageLimit = 64 * 1024;

/** How long a submitted login waits for evidence that the sign-in worked. */
const outcomeWaitMs = 15_000;

/**
 * After a navigation, the longest the decision waits for the new document's
 * settled report. Past it, the last report seen decides.
 */
const settleWaitMs = 10_000;

/**
 * After a sign-in was judged successful, how long a sign-in form coming back on
 * the same site takes the offer back. The judgement is made from what the page
 * shows; a page that draws its error form late still gets caught.
 */
const withdrawWindowMs = 15_000;

/** How long a username from a username-only first step is remembered for its second step. */
const usernameMemoryMs = 10 * 60_000;

/** The longest a passkey request may wait for the user to answer. */
const ceremonyLimitMs = 5 * 60_000;

/**
 * Once the user has answered, how long the authenticator may hold what they
 * approved. The page calls the browser straight away; this only bounds a page
 * that never reports back.
 */
const decidedCeremonyMs = 60_000;

/**
 * After the user refuses a passkey request, the tab's next ones are refused
 * without asking for this long. A page calling `get()` in a loop would
 * otherwise put the picker back the instant it is dismissed, and the picker
 * takes the keyboard — a page could hold the editor's input hostage.
 */
const refusalCooldownMs = 5_000;

/** How long attaching to a tab may take before it is abandoned. */
const installTimeoutMs = 10_000;

/** How long a departing session spends taking its scripts out of the page. */
const teardownTimeoutMs = 1_500;

interface Context {
	readonly id: number;
	readonly origin: string;
	readonly frameId: string;
	readonly world: 'main' | 'logins';
}

/** What one frame last reported about its form fields. */
export interface FrameFields extends FieldsMessage {
	readonly frameId: string;
	readonly contextId: number;
	readonly origin: string;
	readonly at: number;
}

/** A sign-in that went through, with the username and password it carried. */
export interface SuccessfulSubmit {
	readonly origin: string;
	readonly kind: SubmitMessage['kind'];
	readonly username: string;
	readonly password: string;
	/** For a change-password form: the password it replaced. */
	readonly previousPassword?: string;
}

export interface PasskeyRequest extends PasskeyRequestMessage {
	/** The requesting frame's origin, as the browser reports it. */
	readonly origin: string;
}

/** The user's answer to a passkey request. */
export type PasskeyDecision =
	| { readonly kind: 'use'; readonly passkey: PasskeyEntry }
	| { readonly kind: 'save' }
	| { readonly kind: 'native' }
	| { readonly kind: 'deny' };

export interface WatcherHandlers {
	/** A frame's login fields appeared, changed or went. */
	onFields(tab: WatchedTab, frame: FrameFields): void;
	/** A sign-in, sign-up or password change that by every sign went through. */
	onSubmitted(tab: WatchedTab, submit: SuccessfulSubmit): void;
	/** The sign-in just reported as successful was not: the site shows its sign-in form again. */
	onSubmitWithdrawn(tab: WatchedTab, origin: string): void;
	onPasskeyRequest(tab: WatchedTab, request: PasskeyRequest, token: vscode.CancellationToken): Promise<PasskeyDecision>;
	/** A passkey the user agreed to save was created; `credential` is CDP's `WebAuthn.Credential`. */
	onPasskeyCreated(tab: WatchedTab, request: PasskeyRequest, credential: any): Promise<void>;
	onPasskeyUsed(tab: WatchedTab, passkey: PasskeyEntry, signCount: number): void;
}

interface PendingSubmit {
	readonly message: SubmitMessage;
	readonly origin: string;
	readonly frameId: string;
	readonly timer: ReturnType<typeof setTimeout>;
	readonly navigated: boolean;
	/** Since the navigation: the latest report from the new document in this frame. */
	readonly seen?: FrameFields;
}

interface Ceremony {
	readonly request: PasskeyRequest;
	readonly contextId: number;
	readonly cancel: vscode.CancellationTokenSource;
	decision?: PasskeyDecision;
	timer: ReturnType<typeof setTimeout>;
}

/** One tab with the password manager attached. */
export class WatchedTab implements vscode.Disposable {

	private readonly _contexts = new Map<number, Context>();
	private readonly _fields = new Map<string, FrameFields>();
	private readonly _pending = new Map<string, PendingSubmit>();
	private readonly _recent = new Map<string, { origin: string; until: number }>();
	private readonly _usernames = new Map<string, { username: string; at: number }>();
	private readonly _subscriptions: vscode.Disposable[] = [];
	private _mainFrameId: string | undefined;
	private _authenticatorId: string | undefined;
	private _passkeysOn = false;
	private _ceremony: Ceremony | undefined;
	private _lastRefusal = 0;
	private _disposed = false;
	/** Contexts already filled on load, so a page is filled once, not on every report. */
	public readonly autofilled = new Set<number>();
	/**
	 * Who installed the page scripts. The isolated world and the main world are
	 * shared by every session on the tab, so each install is named for its
	 * session and an uninstall names who is asking.
	 */
	private readonly _owner = crypto.randomUUID();

	private constructor(
		public readonly tab: vscode.BrowserTab,
		private readonly _client: CDPClient,
		private readonly _sessionId: string,
		private readonly _handlers: WatcherHandlers,
	) { }

	/**
	 * Attaches to `tab`, bounded and abortable.
	 *
	 * **Every step has a deadline**, because `CDPClient.send` has none and a
	 * page busy in a long task answers nothing: unbounded, the open stayed
	 * pending for as long as the page was busy, and "Fill Saved Login" waited on
	 * it in silence (the shape of breaks-silently #177). `signal` is fired when
	 * the tab closes, which does not close its CDP session (#123).
	 */
	public static async open(tab: vscode.BrowserTab, handlers: WatcherHandlers, passkeys: boolean, signal: AbortSignal): Promise<WatchedTab> {
		const client = new CDPClient(await startSession(tab, signal));
		const onAbort = () => client.dispose();
		signal.addEventListener('abort', onAbort, { once: true });
		try {
			const sessionId = await withTimeout(client.attachToPage(), installTimeoutMs, 'The browser tab did not attach');
			const watched = new WatchedTab(tab, client, sessionId, handlers);
			await withTimeout(watched._install(passkeys), installTimeoutMs, 'The browser tab did not finish attaching');
			if (signal.aborted) {
				throw new Error('The browser tab was closed while it was being attached');
			}
			return watched;
		} catch (err) {
			client.dispose();
			throw err;
		} finally {
			signal.removeEventListener('abort', onAbort);
		}
	}

	private _send(method: string, params?: object): Promise<any> {
		return this._client.send(method, params, this._sessionId);
	}

	/**
	 * Listeners first, then the domains, then the scripts — in that order,
	 * because the domains replay what already exists as events (every live
	 * execution context arrives as `executionContextCreated` during
	 * `Runtime.enable`), and a binding call made before `Runtime.enable` is
	 * never delivered at all.
	 *
	 * **The authenticator comes before the passkey gate**, not after: the gate
	 * refuses every request this session cannot answer, so installing it and
	 * then failing to create the authenticator left a page whose passkeys were
	 * all refused — the opposite of "the page keeps its own authenticators".
	 */
	private async _install(passkeys: boolean): Promise<void> {
		const on = (method: string, handler: (params: any) => void) =>
			this._subscriptions.push(this._client.on(method, params => {
				if (!this._disposed) {
					handler(params);
				}
			}));

		on('Runtime.executionContextCreated', ({ context }) => this._contextCreated(context));
		on('Runtime.executionContextDestroyed', ({ executionContextId }) => this._contextDestroyed(executionContextId));
		on('Runtime.executionContextsCleared', () => {
			for (const id of [...this._contexts.keys()]) {
				this._contextDestroyed(id);
			}
		});
		on('Runtime.bindingCalled', params => this._bindingCalled(params));
		on('Page.frameNavigated', ({ frame }) => {
			if (!frame?.parentId) {
				this._mainFrameId = frame?.id;
			}
		});
		on('WebAuthn.credentialAdded', ({ authenticatorId, credential }) => {
			if (authenticatorId === this._authenticatorId) {
				void this._credentialAdded(credential);
			}
		});
		on('WebAuthn.credentialAsserted', ({ authenticatorId, credential }) => {
			if (authenticatorId === this._authenticatorId) {
				void this._credentialAsserted(credential);
			}
		});

		await this._send('Page.enable');
		const { frameTree } = await this._send('Page.getFrameTree');
		this._mainFrameId = frameTree?.frame?.id;
		await this._send('Runtime.enable');

		await this._send('Runtime.addBinding', { name: loginsBinding, executionContextName: loginsWorld });
		await this._send('Page.addScriptToEvaluateOnNewDocument',
			{ source: loginFormSource(this._owner), worldName: loginsWorld, runImmediately: true });

		if (passkeys) {
			try {
				await this._enableAuthenticator();
			} catch {
				// An embedder without the WebAuthn domain, or an authenticator it
				// would not create: no gate goes in, and the page keeps its own
				// authenticators. If `WebAuthn.enable` did succeed, the virtual
				// environment it switched on hides every real authenticator while
				// holding none of its own — so it goes off again.
				await this._send('WebAuthn.disable').catch(() => { });
				this._authenticatorId = undefined;
				return;
			}
			await this._send('Runtime.addBinding', { name: passkeyBinding });
			await this._send('Page.addScriptToEvaluateOnNewDocument', { source: passkeyGateSource(this._owner), runImmediately: true });
			this._passkeysOn = true;
		}
	}

	/**
	 * A platform authenticator that holds nothing and approves nothing.
	 *
	 * `automaticPresenceSimulation: false` is what stops a page that skips the
	 * wrapper from *creating* a credential silently — creating needs no stored
	 * key, only a user-presence check, and with simulation on the virtual
	 * authenticator passes that check for anyone. It is switched on only for a
	 * ceremony the user approved, before the page is told to go ahead.
	 *
	 * Having one at all is also what makes `isUserVerifyingPlatformAuthenticatorAvailable()`
	 * answer `true`, which is how sites decide whether to offer a passkey.
	 */
	private async _enableAuthenticator(): Promise<void> {
		await this._send('WebAuthn.enable', { enableUI: false });
		const { authenticatorId } = await this._send('WebAuthn.addVirtualAuthenticator', {
			options: {
				protocol: 'ctap2',
				ctap2Version: 'ctap2_1',
				transport: 'internal',
				hasResidentKey: true,
				hasUserVerification: true,
				isUserVerified: true,
				automaticPresenceSimulation: false,
			},
		});
		this._authenticatorId = authenticatorId;
	}

	public get passkeysOn(): boolean {
		return this._passkeysOn;
	}

	private _contextCreated(context: any): void {
		const frameId = context?.auxData?.frameId;
		if (typeof context?.id !== 'number' || typeof frameId !== 'string') {
			return;
		}
		const origin = originOf(String(context.origin ?? ''));
		if (!origin) {
			return;
		}
		const world = context.auxData?.type === 'default' ? 'main'
			: context.name === loginsWorld ? 'logins' : undefined;
		if (world) {
			this._contexts.set(context.id, { id: context.id, origin, frameId, world });
		}
	}

	private _contextDestroyed(id: number): void {
		const context = this._contexts.get(id);
		this._contexts.delete(id);
		this.autofilled.delete(id);
		// The document that asked for a passkey is gone, so nobody will report
		// `done`: the ceremony ends here, and with it whatever the authenticator
		// was holding for that document. Left open it kept the approved key and
		// presence switched on for minutes, for any page of that site to use.
		if (this._ceremony?.contextId === id) {
			void this._endCeremony(this._ceremony);
		}
		if (!context || context.world !== 'logins') {
			return;
		}
		// The document behind it went: a navigation, a reload, or the frame was
		// removed. Its form report goes with it; a submission waiting on it now
		// waits for the next document to say whether it shows a login form again.
		const fields = this._fields.get(context.frameId);
		if (fields && [...this._contexts.values()].every(c => c.frameId !== context.frameId || c.world !== 'logins')) {
			this._fields.delete(context.frameId);
			this._handlers.onFields(this, {
				...fields, login: false, password: false, newPassword: false, usernameOnly: false, settled: false, at: Date.now(),
			});
		}
		const pending = this._pending.get(context.frameId);
		if (pending && !pending.navigated) {
			clearTimeout(pending.timer);
			this._pending.set(context.frameId, {
				...pending,
				navigated: true,
				timer: setTimeout(() => this._settleFromLastSeen(context.frameId), settleWaitMs),
			});
		}
	}

	private _bindingCalled(params: any): void {
		const context = this._contexts.get(params?.executionContextId);
		if (!context || typeof params.payload !== 'string' || params.payload.length > messageLimit) {
			return;
		}
		if (params.name === loginsBinding && context.world === 'logins') {
			const message = readFormMessage(params.payload);
			if (message) {
				this._formMessage(context, message);
			}
		} else if (params.name === passkeyBinding && context.world === 'main') {
			let message: PasskeyMessage;
			try {
				message = JSON.parse(params.payload);
			} catch {
				return;
			}
			void this._passkeyMessage(context, message);
		}
	}

	private _formMessage(context: Context, message: FormMessage): void {
		if (message.type === 'fields') {
			const frame: FrameFields = {
				...message, frameId: context.frameId, contextId: context.id, origin: context.origin, at: Date.now(),
			};
			this._fields.set(context.frameId, frame);
			const pending = this._pending.get(context.frameId);
			if (pending?.navigated) {
				// **Only the settled report decides.** The first report of a new
				// document goes out 300 ms in, before a slow page — a parser-blocking
				// script, an app shell — has drawn the form it is about to show,
				// and deciding on it called every such wrong password a success.
				this._pending.set(context.frameId, { ...pending, seen: frame });
				if (message.settled) {
					this._settle(context.frameId, !this._signInShownAgain(frame, pending.origin));
				}
			}
			const recent = this._recent.get(context.frameId);
			if (recent && Date.now() < recent.until && this._signInShownAgain(frame, recent.origin)) {
				// Judged a success, and the site's sign-in form is back: it was
				// not one. The offer goes — a missed save costs the user nothing
				// they cannot redo, a wrong one costs them their password.
				this._recent.delete(context.frameId);
				this._handlers.onSubmitWithdrawn(this, recent.origin);
			}
			this._handlers.onFields(this, frame);
			return;
		}
		if (message.type === 'submit') {
			if (message.kind === 'username') {
				if (message.username) {
					this._usernames.set(context.origin, { username: message.username, at: Date.now() });
				}
				return;
			}
			const existing = this._pending.get(context.frameId);
			if (existing) {
				clearTimeout(existing.timer);
			}
			this._pending.set(context.frameId, {
				message,
				origin: context.origin,
				frameId: context.frameId,
				navigated: false,
				timer: setTimeout(() => this._settle(context.frameId, false), outcomeWaitMs),
			});
			return;
		}
		// `outcome`: what became of the fields of the last submission, judged in
		// the page. Only "gone" — the field left and no sign-in field took its
		// place — is evidence of success.
		const pending = this._pending.get(context.frameId);
		if (pending && !pending.navigated) {
			this._settle(context.frameId, message.result === 'gone');
		}
	}

	/**
	 * A password field on the page that follows a submission — any password
	 * field, on any origin.
	 *
	 * Narrower versions each let a failure through as a success: a sign-in
	 * field only (a sign-up or password-reset form the server rejected and
	 * drew again is all new-password fields), and the same origin only (a
	 * failed sign-in sent back to its form on another host). The rare success
	 * that lands on a page with a password field loses its offer; the user
	 * can save it from the page.
	 */
	private _signInShownAgain(frame: FrameFields, _origin: string): boolean {
		return frame.password;
	}

	/**
	 * The settled report never came: decide by the last report the new
	 * document did send — and with **no report at all, nothing worked**.
	 * A sign-in POST that fails on the network lands on Chrome's error page,
	 * whose origin is not http(s), so its context is never recorded and it never
	 * reports; reading that silence as success offered a password no server had
	 * checked.
	 */
	private _settleFromLastSeen(frameId: string): void {
		const pending = this._pending.get(frameId);
		if (pending) {
			this._settle(frameId, pending.seen !== undefined && !this._signInShownAgain(pending.seen, pending.origin));
		}
	}

	private _settle(frameId: string, success: boolean): void {
		const pending = this._pending.get(frameId);
		if (!pending) {
			return;
		}
		clearTimeout(pending.timer);
		this._pending.delete(frameId);
		if (!success || this._disposed) {
			return;
		}
		const { message } = pending;
		let username = message.username;
		if (!username) {
			// The second step of a sign-in that asked for the username on a
			// page of its own. Without this the password arrives alone and
			// can only update a login, never save one with its account.
			const remembered = this._usernames.get(pending.origin);
			if (remembered && Date.now() - remembered.at < usernameMemoryMs) {
				username = remembered.username;
			}
		}
		const password = message.kind === 'login' ? message.password : message.newPassword;
		if (!password) {
			return;
		}
		this._recent.set(frameId, { origin: pending.origin, until: Date.now() + withdrawWindowMs });
		this._handlers.onSubmitted(this, {
			origin: pending.origin,
			kind: message.kind,
			username,
			password,
			...(message.kind === 'change' && message.password ? { previousPassword: message.password } : {}),
		});
	}

	/** The origin of the page in the tab, as its main frame's context reports it. */
	public get pageOrigin(): string | undefined {
		for (const context of this._contexts.values()) {
			if (context.frameId === this._mainFrameId && context.world === 'main') {
				return context.origin;
			}
		}
		return originOf(this.tab.url);
	}

	/**
	 * Whether the channel under this tab has gone. The host can drop a session
	 * (CLAUDE.md, `navigate`'s retry); a watched tab on a dead one would answer
	 * "no sign-in fields" and capture nothing, so `ensure` opens a new one.
	 */
	public get isClosed(): boolean {
		return this._disposed || this._client.isClosed;
	}

	/** Changes with every document the main frame loads: what "this page" means for a one-time hint. */
	public get documentKey(): number | undefined {
		for (const context of this._contexts.values()) {
			if (context.frameId === this._mainFrameId && context.world === 'main') {
				return context.id;
			}
		}
		return undefined;
	}

	/** Whether any frame of the page shows something to sign in with. */
	public get showsLoginForm(): boolean {
		for (const frame of this._fields.values()) {
			if (frame.login || frame.usernameOnly) {
				return true;
			}
		}
		return false;
	}

	/** Frames of `origin` that run our script, the ones showing a login form first, then the main frame. */
	private _loginContexts(origins: ReadonlySet<string>): Context[] {
		const candidates = [...this._contexts.values()].filter(c => c.world === 'logins' && origins.has(c.origin));
		const score = (c: Context) => {
			const fields = this._fields.get(c.frameId);
			return (fields?.login ? 4 : fields?.usernameOnly ? 2 : 0) + (c.frameId === this._mainFrameId ? 1 : 0);
		};
		return candidates.sort((a, b) => score(b) - score(a) || (this._fields.get(b.frameId)?.at ?? 0) - (this._fields.get(a.frameId)?.at ?? 0));
	}

	/** Whether `context` is still the one we listed: same id, same origin, same world. */
	private _stillCurrent(context: Context): boolean {
		const now = this._contexts.get(context.id);
		return now?.origin === context.origin && now.world === context.world;
	}

	/**
	 * Fills the first frame of one of `origins` that has fields to fill.
	 *
	 * **The values travel as call arguments, never in source text.** An
	 * expression containing the password would be a script the page's own
	 * DevTools lists among its sources; `callFunctionOn` passes it as data.
	 *
	 * **And the page checks where it is before using them.** A context id is
	 * renumbered after a cross-site navigation, so an id taken a moment ago can
	 * already name the next site's world; the list is re-checked before each
	 * call, and the page compares its own `location.origin` — the browser's,
	 * not the page's, in an isolated world — with the origins meant.
	 *
	 * When nothing was filled anywhere, the first frame's reason is returned,
	 * so the user hears "this is a sign-up form" rather than "no fields".
	 */
	public async fill(username: string, password: string, origins: ReadonlySet<string>, onlyEmpty = false): Promise<FillResult> {
		let refusal: FillResult | undefined;
		const meant = [...origins];
		for (const context of this._loginContexts(origins)) {
			if (!this._stillCurrent(context)) {
				continue;
			}
			const result = await this._call(context.id,
				'function (u, p, e, o, n) { const api = globalThis[n]; return api ? api.fill(u, p, e, o) : undefined; }',
				[username, password, onlyEmpty, meant, loginsApiName(this._owner)]) as FillResult | undefined;
			if (result && (result.username || result.password)) {
				return result;
			}
			if (result?.reason && result.reason !== 'noFields') {
				refusal ??= result;
			}
		}
		return refusal ?? { username: false, password: false, reason: 'noFields' };
	}

	/** The login the page's fields hold right now, for "save login from page". */
	public async read(origins: ReadonlySet<string>): Promise<{ origin: string; login: PageLogin } | undefined> {
		const meant = [...origins];
		for (const context of this._loginContexts(origins)) {
			if (!this._stillCurrent(context)) {
				continue;
			}
			const login = await this._call(context.id,
				'function (o, n) { const api = globalThis[n]; return api ? api.read(o) : undefined; }',
				[meant, loginsApiName(this._owner)]) as PageLogin | undefined;
			if (login && (login.password || login.newPassword)) {
				return { origin: context.origin, login };
			}
		}
		return undefined;
	}

	private async _call(contextId: number, functionDeclaration: string, args: unknown[], timeoutMs = 5_000): Promise<unknown> {
		try {
			const { result, exceptionDetails } = await withTimeout(this._send('Runtime.callFunctionOn', {
				functionDeclaration,
				executionContextId: contextId,
				arguments: args.map(value => ({ value })),
				returnByValue: true,
				awaitPromise: true,
			}), timeoutMs, 'The page did not answer');
			return exceptionDetails ? undefined : result?.value;
		} catch {
			return undefined;
		}
	}

	// --- passkeys -----------------------------------------------------------

	private async _passkeyMessage(context: Context, message: PasskeyMessage): Promise<void> {
		if (typeof message?.token !== 'string') {
			return;
		}
		if (message.op === 'abort' || message.op === 'done') {
			// The page gave up, or its call to the browser has settled. Either
			// way the authenticator is emptied now — not when a timer says so.
			const ceremony = this._ceremony;
			if (ceremony?.request.token === message.token) {
				// A page that aborts while the user is still being asked starts
				// the cool-down like a refusal does. Otherwise `create` in a loop,
				// each aborted after a moment, put the picker — and the keyboard —
				// back for ever.
				if (message.op === 'abort' && !ceremony.decision) {
					this._lastRefusal = Date.now();
				}
				await this._endCeremony(ceremony);
			}
			return;
		}
		if ((message.op !== 'get' && message.op !== 'create') || typeof message.rpId !== 'string') {
			return;
		}
		if (!this._passkeysOn || this._ceremony || Date.now() - this._lastRefusal < refusalCooldownMs) {
			// One ceremony at a time: a second request while the user is still
			// answering the first is refused, not queued behind a picker.
			await this._answer(context.id, message.token, 'deny');
			return;
		}
		const request: PasskeyRequest = {
			op: message.op,
			token: message.token,
			rpId: message.rpId.toLowerCase(),
			origin: context.origin,
			...(typeof message.rpName === 'string' ? { rpName: message.rpName } : {}),
			...(typeof message.userName === 'string' ? { userName: message.userName } : {}),
			...(typeof message.userDisplayName === 'string' ? { userDisplayName: message.userDisplayName } : {}),
			...(Array.isArray(message.allow) ? { allow: message.allow.filter(id => typeof id === 'string') } : {}),
			...(Array.isArray(message.exclude) ? { exclude: message.exclude.filter(id => typeof id === 'string') } : {}),
		};
		const cancel = new vscode.CancellationTokenSource();
		const ceremony: Ceremony = {
			request,
			contextId: context.id,
			cancel,
			timer: setTimeout(() => void this._endCeremony(ceremony), ceremonyLimitMs),
		};
		this._ceremony = ceremony;

		let decision: PasskeyDecision;
		try {
			decision = await this._handlers.onPasskeyRequest(this, request, cancel.token);
		} catch {
			decision = { kind: 'deny' };
		}
		if (this._ceremony !== ceremony || cancel.token.isCancellationRequested) {
			await this._endCeremony(ceremony);
			return;
		}
		if (decision.kind === 'deny') {
			this._lastRefusal = Date.now();
		}
		ceremony.decision = decision;
		clearTimeout(ceremony.timer);
		ceremony.timer = setTimeout(() => void this._endCeremony(ceremony), decidedCeremonyMs);
		try {
			if (decision.kind === 'use') {
				await this._send('WebAuthn.addCredential', {
					authenticatorId: this._authenticatorId,
					credential: {
						credentialId: decision.passkey.credentialId,
						isResidentCredential: true,
						rpId: decision.passkey.rpId,
						privateKey: decision.passkey.privateKey,
						...(decision.passkey.userHandle ? { userHandle: decision.passkey.userHandle } : {}),
						...(decision.passkey.userName ? { userName: decision.passkey.userName } : {}),
						...(decision.passkey.userDisplayName ? { userDisplayName: decision.passkey.userDisplayName } : {}),
						signCount: decision.passkey.signCount,
					},
				});
				await this._presence(true);
			} else if (decision.kind === 'save') {
				await this._presence(true);
			} else if (decision.kind === 'native') {
				// The user's own security key or phone: the virtual
				// environment hides every real authenticator while it is on,
				// so it goes for this one request and comes back on `done`.
				await this._send('WebAuthn.disable');
				this._authenticatorId = undefined;
			}
		} catch {
			decision = { kind: 'deny' };
			ceremony.decision = decision;
		}
		// The ceremony can have ended while those calls were in flight — the
		// document went, the page aborted. `_endCeremony` emptied the
		// authenticator before `addCredential` landed, so it is emptied again:
		// a key must never stay behind a ceremony that is over.
		if (this._ceremony !== ceremony) {
			await this._resetAuthenticator();
			return;
		}
		const verdict: PasskeyVerdictWord = decision.kind === 'deny' ? 'deny' : 'proceed';
		await this._answer(context.id, request.token, verdict);
		if (verdict !== 'proceed') {
			await this._endCeremony(ceremony);
		}
	}

	private async _presence(on: boolean): Promise<void> {
		if (this._authenticatorId) {
			await this._send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: this._authenticatorId, enabled: on });
		}
	}

	private async _answer(contextId: number, token: string, verdict: PasskeyVerdictWord): Promise<void> {
		await this._call(contextId,
			`function (t, v) { const s = globalThis[Symbol.for(${JSON.stringify(passkeyStateKey)})]; if (s) { s.settle(t, v); } }`,
			[token, verdict]);
	}

	/** Ends `ceremony` if it is the current one, and empties the authenticator. */
	private async _endCeremony(ceremony: Ceremony): Promise<void> {
		if (this._ceremony !== ceremony) {
			return;
		}
		this._ceremony = undefined;
		clearTimeout(ceremony.timer);
		ceremony.cancel.cancel();
		ceremony.cancel.dispose();
		await this._resetAuthenticator();
	}

	/** No credential, presence off — and the environment back on if a native request had taken it away. */
	private async _resetAuthenticator(): Promise<void> {
		if (this._disposed) {
			return;
		}
		try {
			if (this._authenticatorId) {
				await this._presence(false);
				await this._send('WebAuthn.clearCredentials', { authenticatorId: this._authenticatorId });
			} else if (this._passkeysOn) {
				await this._enableAuthenticator();
			}
		} catch {
			// The session is going; the authenticator goes with it.
		}
	}

	/**
	 * A credential was created. The authenticator is emptied **first**, and the
	 * vault written after: the event carries everything the vault needs, and
	 * awaiting the write first left the new key loaded with presence on for as
	 * long as the write took — the lock, the wait for other windows — during
	 * which the page could sign with it without being asked again.
	 */
	private async _credentialAdded(credential: any): Promise<void> {
		const ceremony = this._ceremony;
		const approved = ceremony?.request.op === 'create' && ceremony.decision?.kind === 'save'
			&& credential?.rpId === ceremony.request.rpId;
		if (approved && ceremony) {
			await this._endCeremony(ceremony);
		}
		// Whatever happened, the key does not stay in the browser.
		if (this._authenticatorId && typeof credential?.credentialId === 'string') {
			await this._send('WebAuthn.removeCredential',
				{ authenticatorId: this._authenticatorId, credentialId: credential.credentialId }).catch(() => { });
		}
		if (approved && ceremony) {
			await this._handlers.onPasskeyCreated(this, ceremony.request, credential);
		}
	}

	/**
	 * One approved sign-in is one signature. Waiting for the page's `done`
	 * instead let a page that withheld it — or never sent it, because it had
	 * navigated — collect silent assertions until a timer ran out.
	 */
	private async _credentialAsserted(credential: any): Promise<void> {
		const ceremony = this._ceremony;
		const decision = ceremony?.decision;
		if (!ceremony || decision?.kind !== 'use') {
			return;
		}
		if (typeof credential?.signCount === 'number') {
			this._handlers.onPasskeyUsed(this, decision.passkey, credential.signCount);
		}
		await this._endCeremony(ceremony);
	}

	/**
	 * Takes both scripts out of every document of the tab, then disposes.
	 *
	 * For a session that goes while the page stays — a setting switched off,
	 * the tab dropped from the watched set. The registrations die with the
	 * session, the scripts already running do not: the passkey wrapper would go
	 * on waiting for answers nobody gives, and the form script would keep its
	 * observer busy reporting to nobody. Bounded, since a busy page may not
	 * answer, and disposed whatever happens.
	 */
	public async close(): Promise<void> {
		if (this._disposed) {
			return;
		}
		const contexts = [...this._contexts.values()];
		try {
			await withTimeout(Promise.allSettled(contexts.map(context => context.world === 'main'
				? this._call(context.id,
					`function (o) { const s = globalThis[Symbol.for(${JSON.stringify(passkeyStateKey)})]; if (s && s.uninstall) { s.uninstall(o); } }`,
					[this._owner], teardownTimeoutMs)
				: this._call(context.id,
					'function (n, o) { const api = globalThis[n]; if (api && api.uninstall) { api.uninstall(o); } }',
					[loginsApiName(this._owner), this._owner], teardownTimeoutMs))), teardownTimeoutMs, 'teardown');
		} catch {
			// A page that does not answer keeps its leftovers; the deadline in
			// the passkey wrapper still bounds what they can do.
		}
		this.dispose();
	}

	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		for (const pending of this._pending.values()) {
			clearTimeout(pending.timer);
		}
		this._pending.clear();
		if (this._ceremony) {
			clearTimeout(this._ceremony.timer);
			this._ceremony.cancel.cancel();
			this._ceremony.cancel.dispose();
			this._ceremony = undefined;
		}
		for (const subscription of this._subscriptions) {
			subscription.dispose();
		}
		// Closing the session takes the bindings, the registrations and the
		// virtual authenticator with it — they belong to the session.
		this._client.dispose();
	}
}

/**
 * Keeps a {@link WatchedTab} on the tabs the user has most recently been in.
 *
 * Not only the active one: switching between two tabs would otherwise detach
 * and re-attach on every switch. Not every open tab either: each session
 * carries `Runtime.enable`, which streams that page's console to the extension
 * host.
 */
export class LoginWatcher implements vscode.Disposable {

	private readonly _tabs = new Map<vscode.BrowserTab, { readonly opening: Promise<WatchedTab | undefined>; readonly abort: AbortController }>();
	private readonly _subscriptions: vscode.Disposable[] = [];
	/** The browser tab the user was in last, kept when focus moves to another editor. */
	private _lastActive: vscode.BrowserTab | undefined;
	private _generation = 0;
	private _disposed = false;

	constructor(
		private readonly _handlers: WatcherHandlers,
		private readonly _settings: () => { enabled: boolean; passkeys: boolean },
	) { }

	/** Starts following the active tab. A host without the browser API has nothing to follow. */
	public start(): void {
		if (!isBrowserApiGranted()) {
			return;
		}
		this._subscriptions.push(vscode.window.onDidChangeActiveBrowserTab(tab => {
			if (tab) {
				this._lastActive = tab;
				void this.ensure(tab);
			}
		}));
		this._subscriptions.push(vscode.window.onDidCloseBrowserTab(tab => {
			if (this._lastActive === tab) {
				this._lastActive = undefined;
			}
			this._drop(tab, false);
		}));
		const active = vscode.window.activeBrowserTab;
		if (active) {
			this._lastActive = active;
			void this.ensure(active);
		}
	}

	/**
	 * The browser tab a command the user ran is about: the active one, else the
	 * one they were in last, else the only one open.
	 *
	 * **`activeBrowserTab` alone is the wrong answer**, and it was a reported
	 * bug: VS Code sets it from the globally active editor pane and nothing
	 * else, so it is empty whenever the user's last click went to a file, a
	 * diff or another editor — including with the browser on screen in a split
	 * beside it, and including when "Fill Saved Login" is picked from the
	 * dropdown of a browser tab in a group that is not the active one (that
	 * menu is shown by the group's own context). The command then answered "no
	 * browser tab is active" about a page in plain sight. The picker that
	 * follows names the site, so the tab chosen here is never a silent guess.
	 */
	public userTab(): { readonly tab: vscode.BrowserTab; readonly focused: boolean } | undefined {
		if (!isBrowserApiGranted()) {
			return undefined;
		}
		const open = vscode.window.browserTabs ?? [];
		const active = vscode.window.activeBrowserTab;
		if (active) {
			return { tab: active, focused: true };
		}
		if (this._lastActive && open.includes(this._lastActive)) {
			return { tab: this._lastActive, focused: false };
		}
		return open.length === 1 ? { tab: open[0], focused: false } : undefined;
	}

	/**
	 * The tab in front of the user: the active one, or the last one they were
	 * in while some browser editor is still on screen.
	 *
	 * What the suggestion and a passkey prompt need — they are about the page
	 * being looked at, not merely the one last touched. There is no direct
	 * signal: `window.tabGroups` models no browser input, so a browser editor
	 * shows up as a visible tab with `input: undefined` — the same heuristic
	 * `updateCheck.ts` uses, and it errs towards "visible", which here costs a
	 * status bar item, never a fill.
	 */
	public tabInFront(): vscode.BrowserTab | undefined {
		const found = this.userTab();
		if (!found) {
			return undefined;
		}
		if (found.focused) {
			return found.tab;
		}
		try {
			const browserOnScreen = vscode.window.tabGroups.all.some(
				group => group.activeTab !== undefined && group.activeTab.input === undefined);
			return browserOnScreen ? found.tab : undefined;
		} catch {
			return undefined;
		}
	}

	/** The watched tab for `tab`, attaching first if it has none. `undefined` when the feature is off or attaching failed. */
	public async ensure(tab: vscode.BrowserTab): Promise<WatchedTab | undefined> {
		const settings = this._settings();
		if (this._disposed || !settings.enabled) {
			return undefined;
		}
		const existing = this._tabs.get(tab);
		if (existing) {
			// Most recently used last, so eviction takes the oldest.
			this._tabs.delete(tab);
			this._tabs.set(tab, existing);
			const watched = await existing.opening;
			if (watched && !watched.isClosed) {
				return watched;
			}
			if (this._tabs.get(tab) === existing) {
				this._tabs.delete(tab);
				watched?.dispose();
			}
		}
		const generation = this._generation;
		const abort = new AbortController();
		const opening: Promise<WatchedTab | undefined> = WatchedTab.open(tab, this._handlers, settings.passkeys, abort.signal).then(watched => {
			if (this._disposed || generation !== this._generation || this._tabs.get(tab)?.opening !== opening
				|| !(vscode.window.browserTabs ?? []).includes(tab)) {
				void watched.close();
				return undefined;
			}
			return watched;
		}, () => undefined);
		this._tabs.set(tab, { opening, abort });
		this._evict();
		const watched = await opening;
		if (!watched && this._tabs.get(tab)?.opening === opening) {
			this._tabs.delete(tab);
		}
		return watched;
	}

	/**
	 * The watched tab for `tab` if it already has a live one. A closed one keeps
	 * the last fields it saw, and would go on advertising a form nothing watches.
	 */
	public async existing(tab: vscode.BrowserTab): Promise<WatchedTab | undefined> {
		const watched = await this._tabs.get(tab)?.opening;
		return watched && !watched.isClosed ? watched : undefined;
	}

	private _evict(): void {
		while (this._tabs.size > watchedTabLimit) {
			const [oldest] = this._tabs.keys();
			this._drop(oldest, true);
		}
	}

	/**
	 * Lets a tab go. `pageStays` is whether its documents live on — an eviction
	 * or a restart, where the scripts have to be taken out of the page — as
	 * against a closed tab, whose documents are gone with it.
	 */
	private _drop(tab: vscode.BrowserTab, pageStays: boolean): void {
		const entry = this._tabs.get(tab);
		this._tabs.delete(tab);
		if (!entry) {
			return;
		}
		entry.abort.abort();
		void entry.opening.then(watched => pageStays ? watched?.close() : watched?.dispose());
	}

	/** Detaches everywhere and attaches the active tab again — after a setting changed. */
	public restart(): void {
		this._generation++;
		for (const tab of [...this._tabs.keys()]) {
			this._drop(tab, true);
		}
		if (isBrowserApiGranted() && vscode.window.activeBrowserTab) {
			void this.ensure(vscode.window.activeBrowserTab);
		}
	}

	public dispose(): void {
		this._disposed = true;
		for (const subscription of this._subscriptions) {
			subscription.dispose();
		}
		for (const tab of [...this._tabs.keys()]) {
			this._drop(tab, true);
		}
	}
}

/**
 * The tab's CDP session, bounded and abortable. A session that arrives after
 * the open gave up is closed rather than left with nobody holding it.
 */
async function startSession(tab: vscode.BrowserTab, signal: AbortSignal): Promise<vscode.BrowserCDPSession> {
	const pending = Promise.resolve(tab.startCDPSession());
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			pending,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('The browser tab did not open a session')), installTimeoutMs);
				onAbort = () => reject(new Error('The browser tab was closed'));
				if (signal.aborted) {
					onAbort();
				} else {
					signal.addEventListener('abort', onAbort, { once: true });
				}
			}),
		]);
	} catch (err) {
		pending.then(session => session.close(), () => { /* never opened */ });
		throw err;
	} finally {
		clearTimeout(timer);
		if (onAbort) {
			signal.removeEventListener('abort', onAbort);
		}
	}
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		work,
		new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
	]).finally(() => clearTimeout(timer));
}
