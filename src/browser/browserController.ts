import { createRemoteVideoEncoder, type RemoteVideoEncoder, type RemoteVideoChunk } from './remoteVideo';
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { takeRemotePick } from './remotePick';
import * as vscode from 'vscode';
import { CDPClient } from '../core/cdp';
import { NativeActions, type ActionScope, type FrameOwner, type PointerOptions } from './nativeActions';
import type { RemoteBrowserInput } from './remoteBrowserProtocol';
import { extractElementData, renderElementMarkdown } from '../elements/elementContext';
import { tabs as tabSource } from './tabSource';
import { legacyMarkerRemoval, stripMarker, stripMarkerFromHtml } from './shareIndicator';
import { comparesFieldValue, isSecretField, redactSecretValues } from '../logins/secretGuards';
import { encodeJpeg } from './jpegEncode';
import { decodePng, rowsOf } from './pngDecode';
import { fitBands, modelJpegQuality, pixelRatios, planFullPage, planViewport, type Rect } from './screenshotFrames';
import {
	callerKey, everyone, ShareRegistry, targetName,
	type CallerIdentity, type ShareTarget,
} from './shareRegistry';
import type { ClientKind } from '../mcp/mcpProtocol';
import { translatorSource } from '../translate/translateScript';
import { isLanguageCode, maxSingleSegment, pageTitle, type Replacement } from '../translate/translateText';
import { plainInLabel } from '../core/notifyText';
import { chromeAnnotationSessions } from './chromeAnnotationSessions';
import { PageAnnotations, type AnnotationChange } from './pageAnnotations';
import type { PageAnnotation } from './annotationData';

/**
 * What the browser can do, expressed without transport or CDP detail.
 *
 * This is the only layer that turns "no tab is open" into a sentence a model can
 * act on: it throws `Error`, and the protocol layer reports the message as
 * `isError: true`. The transport knows nothing about tabs, and nothing here
 * knows about JSON-RPC.
 */

interface ConsoleLine {
	readonly level: string;
	readonly text: string;
}

/** How many console lines to keep. Enough to be useful, bounded so it cannot grow without limit. */
const consoleLimit = 200;
/**
 * A console line kept at most this long, and the tool's whole answer at most
 * `consoleOutputLimit` characters — the newest lines kept. The 200-line cap
 * bounded the count and not the size: a React app's key warnings carry stacks
 * of a few kilobytes each, and the answer then passed the 25 000 tokens Claude
 * Code accepts from a tool (#201), with no argument to narrow it but `clear`,
 * which throws away exactly what was asked for.
 */
const consoleLineLimit = 2_000;
const consoleOutputLimit = 40_000;

/**
 * A console line cut at `consoleLineLimit` — never inside a surrogate pair: half
 * an emoji is a lone surrogate, which `JSON.stringify` writes as `\ud83d` and
 * a strict JSON reader (serde, behind Codex) refuses, failing the whole answer
 * (#373's rule, for a different sink). Sliced rather than spread into code
 * points, since the line can be megabytes.
 */
function cutLine(text: string): string {
	let end = consoleLineLimit;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) {
		end--;
	}
	return `${text.slice(0, end)}… [${text.length - end} more characters]`;
}

/** Where a frame's scripts run: the session that reaches it, and its default context there. */
interface FrameScope {
	readonly sessionId: string;
	readonly contextId: number;
}

/** One frame of a tab, as `browser_frames` reports it. */
interface FrameInfo {
	readonly id: string;
	readonly parentId?: string;
	readonly url: string;
	readonly name?: string;
	readonly origin?: string;
	/** In another renderer process from the page — a frame from another site. */
	readonly outOfProcess?: boolean;
	/** Whether a frame id passed to the tools will reach it now. */
	readonly readable: boolean;
}

/**
 * How many frames in other processes one tab attaches to. Each is a session on
 * the tab's channel; a page of ads can carry dozens, and none of them is worth
 * an unbounded number of handshakes.
 */
const maxFrameSessions = 24;

/** Per step of attaching to, or reading the tree of, one frame. `send` has no timeout of its own. */
const frameAttachTimeoutMs = 3_000;

/** How long a listed frame with no document yet is waited for before the call says it is loading. */
const frameContextWaitMs = 3_000;

/**
 * Why a frame-scoped call failed when the frame moved on under it. Both are
 * matched by `documentReplaced`, so `browser_wait_for` follows the frame into
 * its next document, and the first by `frameContextGone`, so a single call
 * looks the frame up again.
 */
const frameSessionEnded = 'The frame\'s session ended: it navigated to another process or was removed';
const frameBetweenDocuments = 'is between documents — it is still loading';

/** One assignment, as the UI shows it. */
export interface ShareEntry {
	readonly target: ShareTarget;
	/** Who it is for, as it reads in a row: `Claude Code`, `all assistants`. */
	readonly label: string;
	readonly tabId: string;
	readonly url: string;
	readonly title: string | undefined;
	readonly usedBy: readonly ClientKind[];
}

/** Every assignment in this window, plus the ones waiting on the user. */
export interface ShareView {
	readonly assignments: readonly ShareEntry[];
	readonly paused: readonly { readonly target: ShareTarget; readonly label: string }[];
}

/**
 * What every tool answers once the tab the user shared has been closed.
 *
 * Falling back to whichever page is focused is what the share exists to
 * prevent, so the tools stay paused instead — a share is a decision by the
 * user, and only the user can move it. The message therefore has to name the
 * fix, because the model cannot apply it.
 */
function shareLostMessage(target: ShareTarget): string {
	const whose = target.scope === 'everyone'
		? 'The browser tab the user shared with the assistants'
		: `The browser tab the user shared with ${targetName(target)}`;
	return `${whose} has been closed, so the browser tools are paused for you. They will not fall back to whichever `
		+ 'page the user happens to be looking at. Ask the user to open the page you should work with and share it — '
		+ '"AI Browser: Share Tab with…", from the status bar menu or the toolbar menu on the browser tab.';
}

/**
 * A CDP session held open for one tab.
 *
 * Console capture is the reason this is cached rather than opened per call:
 * messages only arrive while something is attached, so a session created on
 * demand would report an empty log for everything that happened before.
 */
class TabSession {
	public readonly actions: NativeActions;

	private readonly _console: ConsoleLine[] = [];
	private readonly _subscriptions: vscode.Disposable[] = [];
	/**
	 * Where each frame's own scripts run: frame id → the session and the id of its
	 * default execution context. Context ids are numbered per session (a page and
	 * a frame in another process both start at 1), so the pair is the address.
	 * Kept from `Runtime.executionContext*` events on every session of this tab.
	 */
	private readonly _frameContexts = new Map<string, FrameScope>();
	/** Frames in another process that have been attached: target id → session id. */
	private readonly _frameSessions = new Map<string, Promise<string>>();
	/** The same attachments by session id, so a detach event can find its frame. */
	private readonly _frameSessionTargets = new Map<string, string>();

	private constructor(
		public readonly client: CDPClient,
		public readonly sessionId: string,
	) {
		this.actions = new NativeActions({
			send: (method, params, id) => client.send(method, params, id),
			mainSessionId: sessionId,
			scope: async frameId => frameId === undefined ? { sessionId } : this.frameScope(frameId),
			owners: frameId => this._actionOwners(frameId),
		});
	}

	/** Frame owners in parent document coordinates, including out-of-process frames. */
	private async _actionOwners(frameId: string): Promise<FrameOwner[]> {
		const frames = await this.frames(frameId);
		const { frameTree } = await this.client.send('Page.getFrameTree', {}, this.sessionId);
		const rootId = frameTree?.frame?.id;
		const path: FrameOwner[] = [], seen = new Set<string>();
		let id = frameId;
		while (id !== rootId) {
			if (seen.has(id) || seen.size >= 32) { throw new Error('The frame ancestry is invalid or too deep.'); }
			seen.add(id);
			const frame = frames.find(frame => frame.id === id);
			if (!frame?.parentId) { throw new Error('The frame ancestry changed. Refresh browser_frames before acting.'); }
			const parent: ActionScope = frame.parentId === rootId
				? { sessionId: this.sessionId } : await this.frameScope(frame.parentId);
			path.unshift({ frameId: id, parent });
			id = frame.parentId;
		}
		return path;
	}

	/**
	 * `signal` ends an open that is still in flight: the controller fires it when
	 * the tab closes. `CDPClient.send` has no timeout and closing a browser tab
	 * does not close its CDP session, so a page that stopped answering during
	 * the handshake left the open pending for ever — its session slot reserved
	 * and its channel open for the life of the window, until enough of them
	 * refused every healthy tab (item 177). Disposing the client rejects what it
	 * is waiting on, and the open unwinds through the normal failure path.
	 */
	public static async open(tab: vscode.BrowserTab, signal?: AbortSignal): Promise<TabSession> {
		const closed = () => new Error('The browser tab was closed while its session was opening.');
		// Before asking the host for a channel, not after: an open whose tab has
		// already gone must not start a handshake at all (#213).
		if (signal?.aborted) {
			throw closed();
		}
		const channel = await whenNotAborted(Promise.resolve(tab.startCDPSession()), signal, closed);
		const client = new CDPClient(channel);
		const onAbort = () => client.dispose();
		signal?.addEventListener('abort', onAbort, { once: true });
		try {
			if (signal?.aborted) {
				throw closed();
			}
			const sessionId = await client.attachToPage();
			const session = new TabSession(client, sessionId);
			await session._enableDomains();
			if (signal?.aborted) {
				throw closed();
			}
			session._removeLegacyMarker();
			return session;
		} catch (err) {
			client.dispose();
			throw signal?.aborted ? closed() : err;
		} finally {
			signal?.removeEventListener('abort', onAbort);
		}
	}

	/**
	 * Takes an older build's title marker off, once, when a session reaches the page.
	 *
	 * This extension used to append 🔗/🤖 to `document.title` over CDP. It no
	 * longer does, and the installer it left behind on any page still open from
	 * that build holds a `MutationObserver` that re-applies the suffix on every
	 * title change — so without this the last marker ever written would be
	 * permanent, the code able to reach it having been deleted.
	 *
	 * Fire-and-forget and unawaited on purpose: it is a tidy-up, not a step in
	 * opening a session, and `open()` is on the path every tool call waits for.
	 * On a page that never carried one the expression is a property read that
	 * answers `undefined`. The old `addScriptToEvaluateOnNewDocument`
	 * registration needs no undoing — it belonged to a CDP session that has
	 * since closed, and such a registration dies with its session.
	 *
	 * Delete this together with {@link legacyMarkerRemoval} once no build that
	 * installed a marker is plausibly still running.
	 */
	private _removeLegacyMarker(): void {
		void this.client.send('Runtime.evaluate', { expression: legacyMarkerRemoval }, this.sessionId)
			.catch(() => { /* a page we cannot reach cannot be carrying one of ours either */ });
	}

	private async _enableDomains(): Promise<void> {
		// **Subscribed before the enables, not after.** `Log.enable` replays every
		// entry collected so far as `Log.entryAdded`, and `Runtime.enable` replays
		// the stored `consoleAPICalled` messages — and those events arrive *before*
		// the command's reply. Listening only once the enables had resolved
		// dropped exactly the output `_primeConsole` exists to keep: a page that
		// threw on load before anything attached answered "The console is empty".
		// The console is the page's own. A frame attached for `browser_frames` has
		// Runtime enabled too, and its messages arrive on this same channel — so
		// without the check an embedded widget's chatter would fill the buffer.
		this._subscriptions.push(this.client.on('Runtime.consoleAPICalled', (params: any, from) => {
			if (!this._fromPage(from)) {
				return;
			}
			const text = (params.args ?? [])
				.map((arg: any) => arg.value ?? arg.description ?? arg.unserializableValue ?? '')
				.join(' ');
			this._record(params.type ?? 'log', text);
		}));

		this._subscriptions.push(this.client.on('Log.entryAdded', (params: any, from) => {
			if (this._fromPage(from)) {
				this._record(params.entry?.level ?? 'log', params.entry?.text ?? '');
			}
		}));

		this._subscriptions.push(this.client.on('Runtime.exceptionThrown', (params: any, from) => {
			if (!this._fromPage(from)) {
				return;
			}
			const details = params.exceptionDetails;
			this._record('error', details?.exception?.description ?? details?.text ?? 'Uncaught exception');
		}));

		// Frame contexts, before `Runtime.enable` for the same reason as the
		// console: the enable replays the contexts that already exist.
		this._subscriptions.push(this.client.on('Runtime.executionContextCreated', (params: any, from) => {
			const context = params.context;
			const frameId = context?.auxData?.frameId;
			if (context?.auxData?.isDefault === true && typeof frameId === 'string' && typeof context.id === 'number') {
				this._frameContexts.set(frameId, { sessionId: from ?? this.sessionId, contextId: context.id });
			}
		}));
		this._subscriptions.push(this.client.on('Runtime.executionContextDestroyed', (params: any, from) => {
			const sessionId = from ?? this.sessionId;
			for (const [frameId, scope] of this._frameContexts) {
				if (scope.sessionId === sessionId && scope.contextId === params.executionContextId) {
					this._frameContexts.delete(frameId);
				}
			}
		}));
		this._subscriptions.push(this.client.on('Runtime.executionContextsCleared', (_params: any, from) => {
			this._forgetContexts(from ?? this.sessionId);
		}));
		// The browser drops whatever was still on its way to a session that ends,
		// so this is what settles it — a frame-scoped call otherwise hung for ever.
		this._subscriptions.push(this.client.on('Target.detachedFromTarget', (params: any) => {
			if (typeof params?.sessionId === 'string') {
				// The page's own session ending is not a frame moving on: it gets the
				// words the rest of the controller already treats as a dead session.
				this.client.failSession(params.sessionId,
					params.sessionId === this.sessionId ? 'CDP session closed' : frameSessionEnded);
				this._forgetSession(params.sessionId);
			}
		}));

		// Independent of one another, so in parallel: this is on the path every
		// tool call waits for when a tab has no session yet. Page is enabled here
		// rather than per call because `navigate` waits for `Page.loadEventFired`
		// on this session.
		await Promise.all(['DOM', 'CSS', 'Runtime', 'Log', 'Page'].map(domain =>
			this.client.send(`${domain}.enable`, {}, this.sessionId)));
	}

	private _record(level: string, text: string): void {
		this._console.push({ level, text: text.length > consoleLineLimit ? cutLine(text) : text });
		if (this._console.length > consoleLimit) {
			this._console.splice(0, this._console.length - consoleLimit);
		}
	}

	/** An event from the page itself rather than from a frame attached through it. */
	private _fromPage(sessionId: string | undefined): boolean {
		return sessionId === undefined || sessionId === this.sessionId;
	}

	private _forgetContexts(sessionId: string): void {
		for (const [frameId, scope] of this._frameContexts) {
			if (scope.sessionId === sessionId) {
				this._frameContexts.delete(frameId);
			}
		}
	}

	/** A frame session that has gone: its contexts, and the attachment itself. */
	private _forgetSession(sessionId: string): void {
		this._forgetContexts(sessionId);
		const targetId = this._frameSessionTargets.get(sessionId);
		if (targetId !== undefined) {
			this._frameSessionTargets.delete(sessionId);
			this._frameSessions.delete(targetId);
		}
	}

	/** Ends a frame session of ours: what waits on it, our records of it, and the attachment. */
	private _detachFrame(sessionId: string): void {
		this.client.failSession(sessionId, frameSessionEnded);
		this._forgetSession(sessionId);
		void this.client.send('Target.detachFromTarget', { sessionId }).catch(() => { /* already gone */ });
	}

	/**
	 * A session on a frame that runs in another process, attached once and kept.
	 *
	 * **Such a frame is a target of its own.** Site isolation puts a frame from
	 * another site — OneNote inside SharePoint, a payment form, an embedded
	 * editor — in its own renderer, and nothing sent to the page's session
	 * reaches it: `Runtime.evaluate` there sees an empty `<iframe>`, and
	 * `Page.getFrameTree` does not even list it. It is listed by
	 * `Target.getTargets` as type `iframe`, with `parentFrameId` naming its
	 * parent, and the editor's CDP proxy serves those targets to an extension
	 * exactly as it does the page (its own element picker attaches to them the
	 * same way). `Runtime.enable` on the new session reports its contexts, which
	 * is what {@link frameScope} reads. Measured in Chrome 153.
	 */
	private _attachFrame(targetId: string): Promise<string> {
		const cached = this._frameSessions.get(targetId);
		if (cached) {
			return cached;
		}
		// **Whatever the attach created is detached if it does not complete.** A
		// busy frame answers the attach and not the enable, and the next listing
		// attached again: every `browser_frames` the "ask again" note invited left
		// one more live session on the frame. A reply arriving after its timeout
		// is detached as it lands, for the same reason.
		const pending = (async () => {
			const attach = this.client.send('Target.attachToTarget', { targetId, flatten: true });
			let sessionId: string;
			try {
				({ sessionId } = await withTimeout(attach, frameAttachTimeoutMs, 'The frame did not accept a connection in time.'));
			} catch (err) {
				attach.then(late => typeof late?.sessionId === 'string' && this._detachFrame(late.sessionId), () => undefined);
				throw err;
			}
			this._frameSessionTargets.set(sessionId, targetId);
			try {
				await withTimeout(this.client.send('Runtime.enable', {}, sessionId),
					frameAttachTimeoutMs, 'The frame did not answer in time.');
			} catch (err) {
				this._detachFrame(sessionId);
				throw err;
			}
			return sessionId;
		})();
		this._frameSessions.set(targetId, pending);
		pending.catch(() => {
			if (this._frameSessions.get(targetId) === pending) {
				this._frameSessions.delete(targetId);
			}
		});
		return pending;
	}

	/**
	 * Every frame in the tab, the page itself left out, in document order.
	 *
	 * Frames in the page's own process come from its frame tree; each frame in
	 * another process is attached and contributes its own tree, which holds it
	 * (with its parent) and whatever is nested inside it. A frame that could not
	 * be attached is still listed, as unreadable, so a model is told it is there.
	 *
	 * `wanted` is a frame a caller named: it is attached even when it falls past
	 * `maxFrameSessions`. The limit bounds what a *listing* connects to; a frame
	 * the model asked for by id is one it can see in the list, and refusing it
	 * there sent it off to list the frames again for the same answer.
	 */
	public async frames(wanted?: string): Promise<FrameInfo[]> {
		const { targetInfos } = await withTimeout(this.client.send('Target.getTargets'),
			frameAttachTimeoutMs, 'The browser did not list the page\'s frames in time.');
		const remote = (Array.isArray(targetInfos) ? targetInfos : [])
			.filter((t: any) => t?.type === 'iframe' && typeof t.targetId === 'string');
		const live = new Set(remote.map((t: any) => t.targetId as string));
		// A frame target that went without a detach event is not reused — and
		// its session is ended properly, so a call still waiting on it settles.
		for (const [sessionId, targetId] of [...this._frameSessionTargets]) {
			if (!live.has(targetId)) {
				this._detachFrame(sessionId);
			}
		}

		const reached = remote.slice(0, maxFrameSessions);
		const named = remote.find((t: any) => t.targetId === wanted);
		if (named && !reached.includes(named)) {
			reached.push(named);
		}
		const sessions = await Promise.all(reached.map(async (target: any) => {
			try {
				return await this._attachFrame(target.targetId);
			} catch {
				return undefined;
			}
		}));

		// **Every attached frame's tree, not only this listing's.** A frame past the
		// limit that a caller named stays attached, and walking only the sessions
		// reached above left whatever is nested inside it out of every later
		// listing — content readable by an id nothing would ever hand out.
		const attached = [...this._frameSessionTargets.keys()].filter(id => !sessions.includes(id));
		const trees = await Promise.all([this.sessionId, ...sessions, ...attached].map(async sessionId => {
			if (sessionId === undefined) {
				return undefined;
			}
			try {
				const { frameTree } = await withTimeout(this.client.send('Page.getFrameTree', {}, sessionId),
					frameAttachTimeoutMs, 'frame tree');
				return frameTree;
			} catch {
				return undefined;
			}
		}));

		const out: FrameInfo[] = [];
		const seen = new Set<string>();
		const add = (frame: any, outOfProcess: boolean) => {
			if (typeof frame?.id !== 'string' || seen.has(frame.id)) {
				return;
			}
			seen.add(frame.id);
			out.push({
				id: frame.id,
				parentId: typeof frame.parentId === 'string' ? frame.parentId : undefined,
				url: String(frame.url ?? '') + String(frame.urlFragment ?? ''),
				name: frame.name || undefined,
				origin: frame.securityOrigin && frame.securityOrigin !== '://' ? frame.securityOrigin : undefined,
				outOfProcess: outOfProcess || undefined,
				readable: this._frameContexts.has(frame.id),
			});
		};
		// Every frame of a tree after the first is in another process from the
		// page, the frames nested inside an attached frame included.
		const walk = (node: any, outOfProcess: boolean) => {
			// The root of the page's own tree is the page, which every tool
			// already reads without a frame id.
			if (node?.frame?.parentId !== undefined) {
				add(node.frame, outOfProcess);
			}
			for (const child of node?.childFrames ?? []) {
				walk(child, outOfProcess);
			}
		};
		trees.forEach((tree, index) => {
			if (tree) {
				walk(tree, index > 0);
			}
		});
		// Attached or not, every frame target is named, so an unreachable one is
		// reported rather than silently missing.
		for (const target of remote) {
			if (!seen.has(target.targetId)) {
				seen.add(target.targetId);
				out.push({
					id: target.targetId,
					parentId: typeof target.parentFrameId === 'string' ? target.parentFrameId : undefined,
					url: String(target.url ?? ''),
					outOfProcess: true,
					readable: this._frameContexts.has(target.targetId),
				});
			}
		}
		return out;
	}

	/**
	 * The frames directly visible from the page, without attaching to anything.
	 *
	 * For the hint `browser_text` and `browser_snapshot` add: those read the page
	 * document only, and a model shown an application shell has no way to tell
	 * that the content it wants is in a frame — the report that led here read
	 * "I only see the SharePoint shell". Cheap on purpose: two calls, no attach.
	 */
	public async frameHint(): Promise<{ id: string; url: string }[]> {
		try {
			const [{ frameTree }, { targetInfos }] = await withTimeout(Promise.all([
				this.client.send('Page.getFrameTree', {}, this.sessionId),
				this.client.send('Target.getTargets'),
			]), frameAttachTimeoutMs, 'frames');
			const local = (frameTree?.childFrames ?? []).map((child: any) => child.frame);
			const remote = (Array.isArray(targetInfos) ? targetInfos : []).filter((t: any) => t?.type === 'iframe')
				.map((t: any) => ({ id: t.targetId, url: t.url }));
			return [...local, ...remote]
				.filter((frame: any) => typeof frame?.id === 'string')
				.map((frame: any) => ({ id: frame.id as string, url: String(frame.url ?? '') }))
				.slice(0, 20);
		} catch {
			return [];
		}
	}

	/**
	 * Where to evaluate in a frame named by a model.
	 *
	 * The cached context answers at once; otherwise the frames are listed, which
	 * attaches any frame in another process and so reports its contexts.
	 */
	public async frameScope(frameId: string): Promise<FrameScope> {
		const known = this._frameContexts.get(frameId);
		if (known) {
			return known;
		}
		const listed = await this.frames(frameId);
		if (!listed.some(frame => frame.id === frameId)) {
			throw new Error(`No frame on this page has the id ${frameId}: it was removed, or the page navigated. `
				+ 'Call browser_frames for the current ids.');
		}
		// **A frame that is there with no context is between documents.** A click
		// on a link inside it ends the old document at once and the new one gets
		// its context only when it commits — so `browser_wait_for` straight after
		// the click, the commonest use of a wait, failed before it began. It
		// waits a little for the context to arrive, and says "still loading"
		// (which the wait's retry recognises) rather than "removed" if it does not.
		const deadline = Date.now() + frameContextWaitMs;
		while (Date.now() < deadline && !this.isClosed) {
			await new Promise(resolve => setTimeout(resolve, 50));
			const found = this._frameContexts.get(frameId);
			if (found) {
				return found;
			}
		}
		throw new Error(`The frame ${frameId} ${frameBetweenDocuments}. Try again in a moment.`);
	}

	/**
	 * Drops a frame context that turned out to be stale, so the next lookup asks
	 * again — and the whole frame session when it is the session that has gone,
	 * or `_attachFrame` would keep handing back the dead one.
	 *
	 * **Only the record that failed, never whatever is there now.** A call sent
	 * just before a navigation fails with the old context id, and by the time the
	 * failure arrives the new document's context has usually been recorded in its
	 * place. Deleting by frame id threw *that* away, and since nothing reports an
	 * existing context twice, the frame then read as "between documents" for good
	 * — a click on a link inside a frame followed by `browser_wait_for` timed out
	 * on a page that had long finished loading.
	 */
	public forgetFrame(frameId: string, stale: FrameScope, err: unknown): void {
		const current = this._frameContexts.get(frameId);
		if (current?.sessionId === stale.sessionId && current.contextId === stale.contextId) {
			this._frameContexts.delete(frameId);
		}
		const message = err instanceof Error ? err.message : String(err);
		if (stale.sessionId !== this.sessionId && /session|Target closed/i.test(message)) {
			this._forgetSession(stale.sessionId);
		}
	}

	/**
	 * Whether the channel under this session has gone.
	 *
	 * The host can drop a session; a stale one then rejects every send with "CDP
	 * session closed", which reads to a model as the browser being broken rather
	 * than as something to retry.
	 */
	public get isClosed(): boolean {
		return this.client.isClosed;
	}

	public get consoleLines(): readonly ConsoleLine[] {
		return this._console;
	}

	/** Empties the buffer, keeping its oldest `keep` lines. */
	public clearConsole(keep = 0): void {
		this._console.length = Math.min(keep, this._console.length);
	}

	public dispose(): void {
		for (const subscription of this._subscriptions) {
			subscription.dispose();
		}
		this.client.dispose();
	}
}

/**
 * `pending`, unless `signal` fires first. A session that arrives after the
 * abort is closed rather than left open with nobody holding it.
 */
function whenNotAborted(
	pending: Promise<vscode.BrowserCDPSession>,
	signal: AbortSignal | undefined,
	error: () => Error,
): Promise<vscode.BrowserCDPSession> {
	if (!signal) {
		return pending;
	}
	if (signal.aborted) {
		pending.then(session => session.close(), () => { /* never opened */ });
		return Promise.reject(error());
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			reject(error());
			pending.then(session => session.close(), () => { /* never opened */ });
		};
		signal.addEventListener('abort', onAbort, { once: true });
		pending.then(session => {
			signal.removeEventListener('abort', onAbort);
			if (signal.aborted) {
				session.close();
				return;
			}
			resolve(session);
		}, err => {
			signal.removeEventListener('abort', onAbort);
			reject(err);
		});
	});
}

/**
 * Refuses, in words a model can act on, when the `browser` proposal is not
 * ours to use. Every tool path reads `tabSource.all` sooner or
 * later, and on a host that carries the proposal without granting it that
 * read throws a raw "CANNOT use API proposal" instead.
 */
function requireGrant(): void {
	if (!tabSource.available()) {
		throw new Error(
			'No browser is available. The integrated browser needs the `browser` API proposal (the user can enable it with the "AI Browser: Enable Integrated Browser API" command), or the user can connect Google Chrome with "AI Browser: Open in Google Chrome".');
	}
}

/**
 * Refuses a selector that compares an element's `value` attribute.
 *
 * React mirrors a password into that attribute, so `input[type=password][value^="a"]`
 * matching or not was a way to read a password one character at a time with
 * any tool that takes a selector — the saved one included, once it is filled.
 * The message says what to use instead, since the model has to act on it.
 */
function refuseValueProbe(selector: string | undefined): void {
	if (selector && comparesFieldValue(selector)) {
		throw new Error('Selectors that compare an element\'s value attribute are not accepted: they can read what a '
			+ 'field holds, passwords included. Select the element by id, name, type, text or position instead.');
	}
}

/** Refuses an empty frame id: absent means "the page", and an empty one is neither. */
function requireFrameId(frameId: string | undefined): void {
	if (frameId !== undefined && !frameId) {
		throw new Error('`frameId` is empty. Pass an id from browser_frames, or leave the argument out to read the page itself.');
	}
}

/**
 * `value` with the page's frames named beside it, when there are any.
 *
 * The page document's text and elements stop at every `<iframe>`, and nothing
 * in a result read that way says so — so an application that renders its
 * content in a frame looked like a bare shell. With no frames the result keeps
 * its usual shape: `plain` when given, `value` otherwise.
 */
function withFrameHint(value: object, frames: readonly { id: string; url: string }[], plain?: unknown): unknown {
	if (frames.length === 0) {
		return plain !== undefined ? plain : value;
	}
	return {
		...value,
		frames,
		framesNote: 'This page embeds frames, and their content is not included above. Pass a frame id as frameId to '
			+ 'browser_text, browser_snapshot, browser_html, browser_click, browser_hover, browser_drag, browser_press, browser_type, browser_fill, browser_scroll or browser_wait_for '
			+ 'to work inside one; browser_frames lists every frame, nested ones included.',
	};
}

/** Refuses a `language` argument that is not a BCP 47 tag, before it reaches the page. */
function requireLanguageCode(language: string | undefined): void {
	if (language !== undefined && !isLanguageCode(language)) {
		throw new Error(`\`language\` must be a BCP 47 code such as "ru" or "pt-BR", not ${JSON.stringify(language)}.`);
	}
}

/**
 * Result of a page-side evaluation, already unwrapped.
 *
 * With `frameId` it runs in that frame's document instead of the page's — the
 * frame's own default context, in whichever session reaches it. A context that
 * has gone since it was recorded (the frame navigated, or its process was
 * swapped) is looked up once more before the call fails.
 */
async function evaluate(session: TabSession, expression: string, frameId?: string): Promise<any> {
	if (frameId === undefined) {
		return evaluateAt(session.client, session.sessionId, undefined, expression);
	}
	for (let attempt = 0; ; attempt++) {
		const scope = await session.frameScope(frameId);
		try {
			return await evaluateAt(session.client, scope.sessionId, scope.contextId, expression);
		} catch (err) {
			if (attempt > 0 || !frameContextGone(err)) {
				throw err;
			}
			session.forgetFrame(frameId, scope, err);
		}
	}
}

async function evaluateAt(client: CDPClient, sessionId: string, contextId: number | undefined, expression: string): Promise<any> {
	const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
		expression,
		returnByValue: true,
		awaitPromise: true,
		contextId,
	}, sessionId);

	if (exceptionDetails) {
		throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'Evaluation failed');
	}
	return result?.value;
}

/** CDP's ways of saying a recorded frame context or frame session is no longer there. */
function frameContextGone(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	// "Session not found" is the editor's proxy answering a send to a frame
	// session it has already dropped.
	return /Cannot find context with specified id|Session with given id not found|No session with given id|Session not found|Target closed/i
		.test(message) || message.includes(frameSessionEnded);
}

/** One `Page.captureScreenshot`, refusing the empty answer CDP sometimes gives instead of failing. */
async function screenshot(session: TabSession, params: Record<string, unknown>): Promise<string> {
	const { data } = await session.client.send('Page.captureScreenshot', params, session.sessionId);
	if (typeof data !== 'string' || data.length === 0) {
		throw new Error('The browser returned an empty screenshot');
	}
	return data;
}

/** `work`, or `message` as an error once `ms` have passed. `CDPClient.send` has no timeout of its own. */
function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		work,
		new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
	]).finally(() => clearTimeout(timer));
}

/** The loader of the tab's main document: it changes when the document does. */
async function documentLoader(session: TabSession): Promise<string | undefined> {
	try {
		const { frameTree } = await withTimeout(
			session.client.send('Page.getFrameTree', {}, session.sessionId), pageScrollTimeoutMs, 'frame tree');
		return typeof frameTree?.frame?.loaderId === 'string' ? frameTree.frame.loaderId : undefined;
	} catch {
		return undefined;
	}
}

/** How long a page gets to scroll before a capture goes ahead without it. */
const pageScrollTimeoutMs = 2_000;

/** How long a full-page capture waits for one already running on the same tab. */
const scrollGateWaitMs = 15_000;

/** The largest image side Chromium can render a capture into, in device pixels. */
const textureLimitPx = 16384;

/**
 * Where the page is scrolled to, in the coordinates `window.scrollTo` takes.
 *
 * **Not `cssLayoutViewport.pageX`**, which counts from the document's left
 * edge. `scrollTo` counts from the scroll *origin*, and on a right-to-left page
 * that is the right edge, with negative values going left — so an RTL page
 * wider than the window read as scrolled when it was at its start, every
 * full-page capture carried a false "could not be scrolled to the top" note,
 * and the restore put a user scrolled to -1000 back at 0. The visual
 * viewport's `pageX` is in scroll-origin coordinates; its `offsetX` is the
 * pinch-zoom offset inside the layout viewport, taken off to get the layout
 * viewport's own position. Vertical scroll has no origin question.
 * Breaks-silently #214.
 */
function scrollPosition(metrics: any): { x: number; y: number } {
	const visual = metrics?.cssVisualViewport;
	const x = typeof visual?.pageX === 'number' && Number.isFinite(visual.pageX)
		? visual.pageX - (Number(visual.offsetX) || 0)
		: Number(metrics?.cssLayoutViewport?.pageX) || 0;
	return { x: Math.round(x), y: Number(metrics?.cssLayoutViewport?.pageY) || 0 };
}

/**
 * Where the visible area starts, in the coordinates a screenshot `clip` takes:
 * from the document's top-left corner.
 *
 * **Not `cssVisualViewport.pageX`**, which `scrollPosition` uses because it is
 * what `scrollTo` takes — it counts from the scroll origin, and on a
 * right-to-left page that is the right edge. Measured in Chrome 153 on a 4000 px
 * RTL page opened at its start: visual `pageX` 0, layout `pageX` 2720, and a
 * clip at x 0 came back white while the page was at 2720. The model was handed
 * a blank frame as the visible area. Layout plus the pinch-zoom offset is the
 * document position in both directions, and equals visual `pageX` on a
 * left-to-right page.
 */
function visibleOrigin(metrics: any): { x: number; y: number } {
	const layout = metrics?.cssLayoutViewport;
	const visual = metrics?.cssVisualViewport;
	const at = (base: unknown, offset: unknown, fallback: unknown) =>
		typeof base === 'number' && Number.isFinite(base)
			? base + (Number(offset) || 0)
			: Number(fallback) || 0;
	return {
		x: at(layout?.pageX, visual?.offsetX, visual?.pageX),
		y: at(layout?.pageY, visual?.offsetY, visual?.pageY),
	};
}

/** How long switching inspect mode off may take before the call gives up on it. */
const inspectCleanupTimeoutMs = 2_000;

/** How long past its deadline `waitFor` lets a round already sent to the page answer. */
const waitForGraceMs = 1_000;

/** The pause between two checks of `waitFor`, kept on the host's clock, never the page's. */
const waitForPollMs = 100;

/**
 * Whether an evaluation failed because its document went away — a navigation
 * — rather than because of anything the page did. Measured in Chrome 153: a
 * pending `awaitPromise` evaluate is answered "Inspected target navigated or
 * closed" when the page navigates; the other two are what an evaluate sent
 * while the next document is still being created can meet.
 */
function documentReplaced(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /Inspected target navigated or closed|Execution context was destroyed|Cannot find default execution context/i.test(message)
		|| message.includes(frameSessionEnded) || message.includes(frameBetweenDocuments);
}

/** The longest delay `setTimeout` honours; past it Node fires after 1 ms. */
const maxTimerMs = 2 ** 31 - 1;

/**
 * Waits for a navigation to finish, and gives up rather than blocking a tool.
 *
 * The listener has to be in place *before* `Page.navigate` is sent: a fast load
 * fires the event before anything is listening, and the wait then runs to its
 * timeout for a page that is already there. Timing out is not an error — the
 * page is still loading, and the next tool sees whatever is there by then.
 */
function waitForLoad(session: TabSession, timeoutMs: number): { settled: Promise<boolean>; cancel(): void } {
	const source = new vscode.CancellationTokenSource();
	const timer = setTimeout(() => source.cancel(), timeoutMs);
	const settled = session.client.once('Page.loadEventFired', source.token)
		.then(() => true, () => false)
		.finally(() => {
			clearTimeout(timer);
			source.dispose();
		});
	// Callable so a navigation that will never fire the event does not leave the
	// timer armed for the full timeout behind it.
	return { settled, cancel: () => source.cancel() };
}

/**
 * Whether two targets are the same assignment.
 *
 * Deliberately structural and deliberately small: the registry owns key
 * identity (`keyOf`), and the one question this file has to ask — "is the
 * assignment a caller just resolved to the one being written?" — is answered
 * without a second key format to keep in step.
 */
function sameTarget(a: ShareTarget, b: ShareTarget): boolean {
	if (a.scope !== b.scope) {
		return false;
	}
	if (a.scope === 'kind' && b.scope === 'kind') {
		return a.kind === b.kind;
	}
	if (a.scope === 'session' && b.scope === 'session') {
		return a.session === b.session;
	}
	return true;
}

/** Embeds a value as a JS literal, so a selector cannot break out of the expression. */
function literal(value: unknown): string {
	return JSON.stringify(value ?? null);
}

export class BrowserController implements vscode.Disposable {

	/** Explicit human remote control, independent of assistants' tab assignments. */
	public async remoteTabs(): Promise<{id:string;title:string;url:string;kind:'chrome'|'vscode'}[]> {
		await this._settle(); requireGrant();
		const tabs=tabSource.all ?? []; this._identify(tabs);
		return tabs.slice(0,100).map(tab=>({id:this._idOf(tab),title:(stripMarker(tab.title)??'').slice(0,2000),url:tab.url.slice(0,16000),kind:tabSource.isChrome(tab)?'chrome' as const:'vscode' as const}));
	}
	private async _remoteTab(id:string): Promise<vscode.BrowserTab> {
		await this._settle(); requireGrant();
		if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before remote browser control.');
		const tabs=tabSource.all ?? [];this._identify(tabs);
		const tab=tabs.find(t=>this._idOf(t)===id);
		if(!tab)throw new Error('The selected browser tab was closed. Select another tab.');
		return tab;
	}
	public remoteTab(id:string):Promise<vscode.BrowserTab> { return this._remoteTab(id); }
	public async remoteVideoEncoder(id: string, output: (chunk: RemoteVideoChunk) => void, failed: (error: Error) => void): Promise<RemoteVideoEncoder> {
  const tab = await this._remoteTab(id);
  return createRemoteVideoEncoder(await this._sessionFor(tab), output, failed);
 }
	public async remoteStream(id:string,frame:(data:string,width:number,height:number)=>void):Promise<vscode.Disposable> {
		const tab=await this._remoteTab(id),release=this._hold(tab);
		let session:TabSession;
		try{session=await this._sessionFor(tab);}catch(error){release();throw error;}
		let closed=false,busy=false,lastFrame=0;
		const send=async(method:string,params?:object)=>{
			let timeout:ReturnType<typeof setTimeout>|undefined;
			try{return await Promise.race([session.client.send(method,params,session.sessionId),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Browser did not respond')),5000);})]);}
			finally{clearTimeout(timeout);}
		};
		const listener=session.client.on('Page.screencastFrame',(event,sessionId)=>{
			if(sessionId!==session.sessionId)return;
			void send('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{});
			if(closed || Date.now()-lastFrame<100)return;
			const width=event.metadata?.deviceWidth,height=event.metadata?.deviceHeight;
			if(typeof event.data==='string' && event.data.length<2_000_000 && Number.isFinite(width)&&width>0&&Number.isFinite(height)&&height>0){lastFrame=Date.now();frame(event.data,width,height);}
		});
		// Counted before the first await below, so an older stream disposed while this one is starting sees it.
		this._screencasts.set(tab,(this._screencasts.get(tab)??0)+1);
		try{await send('Page.startScreencast',{format:'jpeg',quality:60,maxWidth:1440,maxHeight:1000,everyNthFrame:1});}catch{/* Screenshot fallback also supports browsers without screencast. */}
		const tick=async()=>{
			if(closed||busy||Date.now()-lastFrame<1500)return;busy=true;
			try{
				await this._remoteTab(id);
				const metrics=await send('Page.getLayoutMetrics');
				const viewport=metrics.cssLayoutViewport ?? metrics.layoutViewport;
				// Capture the view, not a scaled compositor surface. Repeated clipped
				// surface captures can interfere with the live embedded browser's
				// visible region while the user scrolls it. Previewing must not resize it.
				const {data}=await send('Page.captureScreenshot',{format:'jpeg',quality:60,fromSurface:false,captureBeyondViewport:false});
				if(!closed&&typeof data==='string'&&data.length<2_000_000){lastFrame=Date.now();frame(data,viewport.clientWidth,viewport.clientHeight);}
			}catch{/* A closed tab is reported by the next tabs refresh. */}finally{busy=false;}
		};
		const timer=setInterval(()=>void tick(),500);void tick();
		return new vscode.Disposable(()=>{
			closed=true;clearInterval(timer);listener.dispose();
			const remaining=(this._screencasts.get(tab)??1)-1;
			if(remaining>0)this._screencasts.set(tab,remaining);
			else{this._screencasts.delete(tab);void send('Page.stopScreencast').catch(()=>{});}
			release();
		});
	}
	public async remoteInput(id:string,input:RemoteBrowserInput):Promise<void> {
		const tab=await this._remoteTab(id);
		if(input.action==='close'){await tab.close();return;}
		const release=this._hold(tab);
		try{
			if(input.action==='navigate'){
				// Navigation must not wait for screenshot setup or for all the DOM,
				// CSS and Runtime domains of a blank page to finish enabling.
				let client:CDPClient|undefined,finished=false;
				let timeout:ReturnType<typeof setTimeout>|undefined;
				try{
					await Promise.race([(async()=>{
						const connection=new CDPClient(await tab.startCDPSession());
						if(finished){connection.dispose();return;}
						client=connection;
						const sessionId=await connection.attachToPage();
						const result=await connection.send('Page.navigate',{url:input.url},sessionId);
						if(result?.errorText)throw new Error(`Could not open ${input.url}: ${result.errorText}`);
					})(),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Browser navigation timed out; check the page before retrying.')),5000);})]);
				}finally{finished=true;clearTimeout(timeout);client?.dispose();}
				return;
			}
			const session=await this._sessionFor(tab);
			const send=async(method:string,params?:object)=>{
				let timeout:ReturnType<typeof setTimeout>|undefined;
				try{return await Promise.race([session.client.send(method,params,session.sessionId),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Browser action timed out; check the page before retrying.')),5000);})]);}
				finally{clearTimeout(timeout);}
			};
			// "Fit to my view": the remote viewer asked for the page to be laid out at its own size.
			// Explicit and undone on 'unfit' or when the viewer stops watching this tab.
			if(input.action==='fit'){await send('Emulation.setDeviceMetricsOverride',{width:input.width,height:input.height,deviceScaleFactor:0,mobile:false});return;}
			if(input.action==='unfit'){await send('Emulation.clearDeviceMetricsOverride');return;}
			if(input.action==='reload'){await send('Page.reload');return;}
			if(input.action==='back'||input.action==='forward'){
				const history=await send('Page.getNavigationHistory');const entry=history.entries[history.currentIndex+(input.action==='back'?-1:1)];
				if(entry)await send('Page.navigateToHistoryEntry',{entryId:entry.id});return;
			}
			if(input.action==='text'){await send('Input.insertText',{text:input.text});return;}
			if(input.action==='key'){
				const codes:Record<string,number>={Backspace:8,Tab:9,Enter:13,Escape:27,Delete:46,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Home:36,End:35,PageUp:33,PageDown:34};
				const key={key:input.key,windowsVirtualKeyCode:codes[input.key]??input.key.toUpperCase().charCodeAt(0),modifiers:input.modifiers};
				// Chromium needs the carriage return on keyDown to produce Enter's
				// default action (submit a form or insert a newline), not just key events.
				const text=input.key==='Enter'&&!(input.modifiers&7)?{text:'\r',unmodifiedText:'\r'}:{};
				try{await send('Input.dispatchKeyEvent',{type:'keyDown',...key,...text});}
				finally{await send('Input.dispatchKeyEvent',{type:'keyUp',...key});}
				return;
			}
			if(input.action!=='click'&&input.action!=='scroll'&&input.action!=='move')return;
			const metrics=await send('Page.getLayoutMetrics');const viewport=metrics.cssLayoutViewport ?? metrics.layoutViewport;
			const x=Math.min(viewport.clientWidth-1,input.x*viewport.clientWidth),y=Math.min(viewport.clientHeight-1,input.y*viewport.clientHeight);
			// A pointer move from the viewer: the inspect overlay and the annotation picker highlight from it.
			if(input.action==='move'){await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,button:'none'});return;}
			if(input.action==='scroll'){await send('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaX:input.deltaX,deltaY:input.deltaY});return;}
			// A pick waiting on this tab takes the click by its coordinates (remotePick.ts).
			if(input.button==='left'&&await takeRemotePick(tab,x,y))return;
			await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,button:'none'});
			await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:input.button,clickCount:input.count});
			await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:input.button,clickCount:input.count});
		}finally{release();}
	}

	/**
	 * One CDP session per tab, not one for the window.
	 *
	 * It was a single slot, and that was only tenable while the tools acted on
	 * one tab: now Claude can be on one page and Codex on another, and a single
	 * slot would be dropped and re-opened on every alternating call — which
	 * costs a handshake each time and, worse, loses the **console**. Capture
	 * only happens while something is attached, so a buffer that is thrown away
	 * every other call reports an empty log for everything that mattered. That
	 * is the whole reason a session is cached rather than opened per call.
	 *
	 * Bounded, because a session is a live channel into a page and an agent can
	 * open tabs all day. The least recently used one goes first, and a tab
	 * somebody is assigned to is passed over while any unassigned one remains —
	 * evicting the page an assistant is working on to make room for a page
	 * nobody asked about is the wrong trade every time.
	 */
	private readonly _sessions = new Map<vscode.BrowserTab, TabSession>();
	/** The last full-page capture queued on each tab — see `_atTopOfPage`. */
	private readonly _scrollGates = new WeakMap<vscode.BrowserTab, Promise<unknown>>();

	/** Least recently used first, so eviction has an order to follow. */
	private _sessionOrder: vscode.BrowserTab[] = [];

	/**
	 * Tabs whose session is being *used* right now, counted.
	 *
	 * "Least recently used" is really "least recently **acquired**" — `_touch`
	 * runs when a session is handed out, not while it works — so the longest
	 * running call sits at the *front* of the eviction queue. A
	 * `browser_wait_for`, a slow `browser_text` or a full-page screenshot was
	 * therefore the first thing dropped when a fourth tab opened a session, and
	 * the caller was answered with the internal `CDP client disposed`: the one
	 * error the docs single out as reading to a model as a broken browser rather
	 * than as something to retry.
	 *
	 * An earlier fix covered the *pinned* case by adding pins to `claimed`, which
	 * left the ordinary one open — an assistant with no share and no selection is
	 * the default state, not an edge case. Counting the holds is what makes the
	 * guard structural: every route to a session takes one for the length of the
	 * work, so the rule cannot be re-entered by adding a call site.
	 */
	private readonly _inFlight = new Map<vscode.BrowserTab, number>();

	/**
	 * Remote previews running on each tab. They share the tab's one CDP session and
	 * so one screencast: a stream that starts again (selection repeated, viewers
	 * leaving and returning) can overlap the one it replaces, and the older one's
	 * disposal must not stop the capture the newer one is using. The screencast
	 * is stopped only when the last stream of the tab goes.
	 */
	private readonly _screencasts = new Map<vscode.BrowserTab, number>();

	/**
	 * Opens waiting for a session slot to come free.
	 *
	 * `_evict` will not drop a session that is in use, so with every slot busy
	 * there is nothing it can take and a new tab would otherwise open the fifth
	 * channel. Queueing here keeps the bound exact in the case that actually
	 * happens — calls overlapping for a moment — instead of letting the count
	 * drift up with concurrency.
	 */
	private readonly _slotWaiters = new Set<() => void>();

	/**
	 * Slots promised to opens that have not produced a session yet.
	 *
	 * Counted alongside `_sessions`, because an open is asynchronous: between
	 * taking the decision to open and the session landing in the map there is
	 * nothing else recording that the capacity is spoken for, and every caller
	 * arriving in that window reads the same free slot.
	 */
	private _reserved = 0;

	/**
	 * How long an open waits for a slot before going ahead anyway.
	 *
	 * **The wait is bounded, not the work**, which is the same shape as
	 * `repairQueueWaitMs`: a plain queue starves. `browser_wait_for` takes a
	 * timeout from its caller and may legitimately hold a session for a minute,
	 * so four of those would block every new tab for as long as they ran — and a
	 * tool call that hangs reads to a model as a dead browser, while its client's
	 * own timeout fires regardless. So the pathological case degrades to the
	 * previous behaviour, one channel over the bound, rather than to a hang.
	 * Ordinary calls finish in well under this, so in practice the bound holds.
	 */
	private static readonly _slotWaitMs = 5_000;

	/**
	 * How far over {@link _sessionLimit} the timeout path may take the count.
	 *
	 * **The give-up has to be bounded too.** Each waiter owns its own timer, so
	 * letting every one of them take a permit on expiry made the overflow the size
	 * of the burst: four busy sessions and N waiting calls opened `4 + N` channels,
	 * which is the bound removed exactly when it is needed. One over is what the
	 * documentation promises and what a single slow moment costs; past that a call
	 * is told to retry, because an honest refusal is better than a limit that only
	 * holds while nothing is happening.
	 */
	private static readonly _sessionOverflow = 1;

	/** Set while `_tryReserve` is making room, so a drop it causes cannot re-enter. */
	private _reserving = false;

	private static readonly _sessionLimit = 4;

	/**
	 * Opens in flight, per tab.
	 *
	 * Opening is asynchronous, so without this two calls arriving together both
	 * find no session and both open one — the second overwrites the first,
	 * which is then never disposed while its console listeners stay attached
	 * for the life of the window. Reproduced once with two concurrent
	 * `browser_console` calls.
	 *
	 * Per tab rather than one slot, which also retires the whole "superseded
	 * while opening" apparatus: with a map, an open is only ever unwanted
	 * because the controller was disposed or the tab closed, never because
	 * somebody else asked for a different tab.
	 */
	private readonly _opening = new Map<vscode.BrowserTab, Promise<TabSession>>();

	/**
	 * How to end each open in `_opening`, fired when its tab closes or the
	 * controller is disposed — and only then. `_dropSession` alone does not
	 * abort, because `navigate`'s retry drops a tab it is about to reopen and a
	 * concurrent caller may still be waiting on the open under way.
	 *
	 * **A set per tab, because two opens can be in flight for one tab** — the
	 * retry above starts the second while the first is still out. One slot per
	 * tab let the second overwrite the first's abort, so a first open stuck in
	 * a handshake on a page that had stopped answering could no longer be
	 * ended by anything: closing the tab and disposing the controller both
	 * reached only the newer one, and the stuck open kept its slot permit for
	 * the life of the window. Breaks-silently #213.
	 */
	private readonly _openAborts = new Map<vscode.BrowserTab, Set<AbortController>>();

	/**
	 * The tab the tools last acted on.
	 *
	 * `tabSource.active` means "a browser editor is the active
	 * pane", nothing more — the extension host sets it from
	 * `activeEditorPane?.input instanceof BrowserEditorInput` — so it goes
	 * `undefined` the moment the user clicks into a file, which is the normal
	 * thing to do while an agent works. Without a memory of the tab, every tool
	 * refuses with "no browser tab is open" whenever a document has focus, and
	 * `browser_navigate` opens a second tab for the page already sitting there.
	 */
	private _lastTab: vscode.BrowserTab | undefined;
	//
	// **Written only where the user's own focus was seen.** It used to be
	// written by `selectTab`, by `shareTab` and by `navigate`'s new-tab
	// branch — one caller's choice, recorded in a field every caller reads —
	// so Codex selecting a tab still redirected Claude's next call one level
	// below the per-caller pin that was introduced to stop exactly that:
	// with no browser tab focused, which the docstring above calls the normal
	// thing to do while an agent works, an unassigned caller fell through to
	// `_lastTab` and got the page somebody else had chosen. Reproduced.

	/**
	 * The tab a caller selected for itself, **per caller**.
	 *
	 * It was one field for the window while everything around it became per
	 * caller, and that is a redirect: Codex calling `browser_select_tab tab-2`
	 * moved Claude's next tool call to tab-2, and `browser_state` then reported
	 * `selection: "selected"` to a caller that had selected nothing. Giving a
	 * tab to one assistant cleared it for everybody too, so an unrelated
	 * assistant silently changed page.
	 *
	 * Keyed by {@link callerKey} — the conversation when the client echoes its
	 * session id, the assistant otherwise — and it stays *below* an assignment:
	 * a selection is the model's own guess and the user's instruction outranks
	 * it.
	 */
	private readonly _pins = new Map<string, { readonly tab: vscode.BrowserTab; readonly caller: CallerIdentity }>();

	/**
	 * Who works on which tab — **assistant → tab**, and the direction is the
	 * design.
	 *
	 * A single `_sharedTab` could only say "the assistants work here", and the
	 * ask was the other thing: Claude on one page, Codex on another, and both
	 * on the same page when that is what is wanted. Several assistants pointing
	 * at one tab falls out for free this way round, while one assistant is
	 * never in two places at once — and "which tab does this call act on", the
	 * only question a tool ever asks, is a single lookup.
	 *
	 * The rules themselves — precedence between a conversation, an assistant
	 * and everybody, what a closed tab does to each of them, who has driven
	 * what — live in [shareRegistry.ts](shareRegistry.ts), which is a
	 * leaf with tests. This class only resolves sessions and drives CDP.
	 *
	 * The user's own commands still do not come through here — the toolbar's
	 * screenshot passes {@link focusedTab} — so a share never redirects a
	 * button the user pressed.
	 */
	private readonly _shares = new ShareRegistry<vscode.BrowserTab>();

	/**
	 * A share transition in progress, and the reason one is needed at all.
	 *
	 * Moving a share is several async steps over fields every tool reads — the
	 * registry, `_pins`, `_sessions`. A call landing in the middle of one used to
	 * resolve the **new** tab and drop the session the transition was still
	 * using, and then fail itself with `The browser session was replaced while it
	 * was opening`, an internal sentence handed to a model.
	 *
	 * So a transition is a gate: `_transact` runs them in call order — two clicks
	 * on "Share this tab instead" cannot interleave either — and `_settle` is
	 * what every tool waits on.
	 *
	 * **Nothing inside a transition talks to a page any more.** It did: the
	 * marker came off one page and went on another, which is why there was a
	 * second route to the page for the cleanup and a `bounded` timeout so an
	 * unresponsive page could not hang the gate. All of that went with the page
	 * title marker — see CLAUDE.md, *Where a share is visible*. The gate stays
	 * because the field rewrites still need ordering, and it is now short by
	 * construction rather than by a budget: zero CDP round-trips.
	 */
	private _transition: Promise<void> = Promise.resolve();

	private readonly _onDidChangeShare = new vscode.EventEmitter<void>();

	/** Fires when the share changes, so the status bar can follow it without polling. */
	public readonly onDidChangeShare = this._onDidChangeShare.event;

	private readonly _tabWatch: vscode.Disposable | undefined;

	/**
	 * The browser tab the user last had in front of them — {@link userTab}.
	 *
	 * Not `_lastTab`: that one is written only when a tool resolves a tab, so
	 * it can name a page the user left long ago, or one its last-resort branch
	 * picked without anybody looking at it. This follows the focus itself.
	 */
	private _userFocus: vscode.BrowserTab | undefined;
	private readonly _focusWatch: vscode.Disposable | undefined;

	/**
	 * Set by {@link dispose}, and checked by everything that could still be in
	 * flight at that moment.
	 *
	 * An open takes two CDP round-trips, so a window closing or the MCP setting
	 * being switched off lands in the middle of one routinely. Without this the
	 * session arriving afterwards was cached and left running — there was
	 * nothing left to dispose it.
	 */
	private _disposed = false;
	private readonly _annotations = new PageAnnotations();

	constructor() {
		// The share has to notice a closed tab even when no tool is running, or
		// the status bar keeps advertising a share with nothing behind it until
		// the next call comes in. Guarded like every other use of the proposal:
		// on a host without it, reading the event throws.
		try {
			this._tabWatch = tabSource.onDidClose(tab => this._loseTab(tab));
			this._userFocus = tabSource.active;
			this._focusWatch = tabSource.onDidChangeActive(tab => {
				if (tab) {
					this._userFocus = tab;
					// A Chrome tab the user just opened is the one they turned to,
					// and the only way it enters the fallback: it is never `active`.
					if (tabSource.isChrome(tab)) {
						this._lastTab = tab;
					}
				}
			});
		} catch {
			// No browser API here; there is nothing to share in the first place.
		}
	}

	/**
	 * Ids handed out for `browser_tabs`, because the `browser` proposal exposes
	 * none: `BrowserTab` carries url, title, icon and two methods, and nothing
	 * that survives being written down. So identity is ours to mint, keyed on
	 * the tab object — which the extension host builds once per tab and only
	 * mutates in place, so it is stable for as long as the tab is open.
	 */
	private readonly _tabIds = new Map<vscode.BrowserTab, string>();
	/** Callers whose preferred tab has been applied, so it seeds a selection only once. */
	private readonly _seeded = new Set<string>();
	/** The tab each chat conversation's agent last worked on, for the terminal hand-over. */
	private readonly _chatTabs = new Map<string, vscode.BrowserTab>();
	private _nextTabId = 1;
	/**
	 * Tabs an AI Browser chat owns, by chat id: one its agent opened, or one the
	 * user took for it from the chat's Access tab. Another caller — another chat,
	 * an assistant in a terminal — neither sees nor reaches such a tab unless the
	 * user shares it (a share outranks ownership). A tab the user opened has no
	 * owner and is free for everyone. The user's own commands carry no caller and
	 * are never refused.
	 */
	private readonly _chatOwners = new Map<vscode.BrowserTab, string>();
	/**
	 * A few random characters in every id this window hands out (`tab-k3f-2`).
	 * Counting from 1 alone made `tab-1` mean a different page after a window
	 * reload, and in every other window — so an id written into a prompt and
	 * pasted later, or into another window's assistant, named some other open
	 * tab rather than none, and the refusal for a closed tab could not fire.
	 */
	private readonly _tabIdPrefix = Math.random().toString(36).slice(2, 5);

	/**
	 * The element last picked, **per tab**.
	 *
	 * It was one field for the window, which crossed the boundary the whole
	 * feature exists to draw: with Claude on one page and Codex on another,
	 * `browser_selected_element` handed whichever of them asked the context
	 * picked on the *other* one — a page it was never given. Keyed by tab, the
	 * lookup goes through the caller's own assignment, so there is nothing to
	 * cross.
	 *
	 * It also removes an invalidation that had to be remembered: selecting or
	 * navigating away used to leave a stale element behind unless the code
	 * cleared it, and now a tab simply has its own or has none.
	 */
	private readonly _selectedElements = new Map<vscode.BrowserTab, string>();

	/**
	 * Which tab the tools act on: the one selected by id, else the active one,
	 * else the one last used, else the most recently opened.
	 *
	 * The last fallback is deliberate rather than a refusal — with a single tab
	 * open, which is the usual case, it is the only answer that can be right.
	 */
	private _resolveTab(caller?: CallerIdentity): vscode.BrowserTab | undefined {
		const open = (tabSource.all ?? []).filter(tab => this._usableBy(tab, caller));
		// A chat that owns a tab works on it, not on whatever the user has in front.
		const chatId = caller?.chatId;
		const pinnedFirst = caller ? this._pins.get(callerKey(caller))?.tab : undefined;
		if (chatId && !(pinnedFirst && open.includes(pinnedFirst))) {
			const owned = open.filter(tab => this._chatOwners.get(tab) === chatId);
			if (owned.length) {
				const last = this._chatTabs.get(chatId);
				return last && owned.includes(last) ? last : owned[owned.length - 1];
			}
		}

		const key = caller ? callerKey(caller) : undefined;
		// A preferred tab seeds the caller's selection once, so a later
		// browser_select_tab still moves it; a closed one is ignored.
		if (key && caller?.preferredTab && !this._seeded.has(key) && !this._pins.has(key)) {
			// Bounded like the server's session map (256): an old entry only means a
			// session that reappears is not seeded again, which is the safe direction.
			if (this._seeded.size >= 256) { this._seeded.delete(this._seeded.values().next().value!); }
			this._seeded.add(key);
			const wanted = open.find(tab => this._idOf(tab) === caller.preferredTab);
			if (wanted) { this._pins.set(key, { tab: wanted, caller }); }
		}
		const pinned = key ? this._pins.get(key)?.tab : undefined;
		if (pinned) {
			if (open.includes(pinned)) {
				return pinned;
			}
			// The tab was closed. Falling back beats refusing every call until
			// something selects again, and `selection` reports which happened.
			this._pins.delete(key!);
		}

		const active = tabSource.active;
		if (active && open.includes(active)) {
			this._lastTab = active;
			return active;
		}

		if (this._lastTab && open.includes(this._lastTab)) {
			return this._lastTab;
		}

		// The last resort is a built-in tab only: a Chrome the user attached
		// lists their own pages, and nobody chose one of those for the tools.
		const builtIn = open.filter(tab => !tabSource.isChrome(tab));
		this._lastTab = builtIn.length > 0 ? builtIn[builtIn.length - 1] : undefined;
		return this._lastTab;
	}

	/**
	 * The tab one caller acts on, or why it has none.
	 *
	 * An assignment answers first and **does not fall through**: the user chose
	 * that page for this assistant, so resuming it on another — the one
	 * everybody else follows, or whatever happens to be focused — is undoing
	 * the instruction rather than recovering from it. Only a caller with no
	 * assignment at all follows the user, which is the state everything starts
	 * in and the right default for "just look at what I am looking at".
	 *
	 * Nothing here has a `user` flag any more, and that is the point of moving
	 * the rules into the registry: a paused assignment belongs to one
	 * assistant, so it can no longer spill onto a button the person pressed —
	 * their commands simply never carry a caller.
	 */
	private _resolveForCaller(caller: CallerIdentity): {
		readonly tab?: vscode.BrowserTab;
		readonly paused?: ShareTarget;
		readonly target?: ShareTarget;
	} {
		const open = tabSource.all ?? [];
		const resolution = this._shares.resolve(caller);

		if (resolution.kind === 'paused') {
			return { paused: resolution.target };
		}

		if (resolution.kind === 'shared') {
			if (open.includes(resolution.tab)) {
				if (caller.chatId) { this._chatTabs.set(caller.chatId, resolution.tab); }
				return { tab: resolution.tab, target: resolution.target };
			}
			// The resolve that *discovers* the closure — normally
			// `onDidCloseBrowserTab` beats it to this, but on a host that does
			// not fire the event it is the only detector there is.
			this._loseTab(resolution.tab);
			// Asked again rather than assumed paused: closing the last tab
			// releases the pause, and then this caller is simply unassigned.
			const after = this._shares.resolve(caller);
			if (after.kind === 'paused') {
				return { paused: after.target };
			}
		}

		const tab = this._resolveTab(caller);
		if (tab && caller.chatId) { this._chatTabs.set(caller.chatId, tab); }
		return { tab };
	}

	/** Whether a caller may act on a tab: free, its own chat's, or a user's command. */
	private _usableBy(tab: vscode.BrowserTab, caller?: CallerIdentity): boolean {
		const owner = this._chatOwners.get(tab);
		return !owner || !caller || owner === caller.chatId;
	}

	private _ownedRefusal(id: string): Error {
		return new Error(`Browser tab ${id} belongs to another AI Browser chat, and only that chat's agent may use it. `
			+ 'Do not act on it. Ask the user to share it with this chat from the chat\'s Access tab, or open a page of your own '
			+ 'with `browser_navigate` and `newTab: true`.');
	}

	/** Every open tab and who may use it, for a chat's Access tab. */
	public accessTabs(chatId: string): { id: string; title: string; url: string; owner: 'this' | 'other' | 'free'; ownerChat?: string; focused: boolean; chrome: boolean }[] {
		if (!tabSource.available()) { return []; }
		const open = tabSource.all ?? [];
		this._identify(open);
		const focused = tabSource.active;
		return open.map(tab => {
			const owner = this._chatOwners.get(tab);
			return {
				id: this._idOf(tab), title: stripMarker(tab.title) || tab.url || '', url: tab.url ?? '',
				owner: !owner ? 'free' as const : owner === chatId ? 'this' as const : 'other' as const,
				...(owner && owner !== chatId ? { ownerChat: owner } : {}),
				focused: tab === focused, chrome: tabSource.isChrome(tab),
			};
		});
	}

	/** Gives a tab to one chat, taking it from any other; `undefined` makes it free for everyone. */
	public setTabOwner(id: string, chatId: string | undefined): boolean {
		const open = tabSource.all ?? [];
		this._identify(open);
		const tab = open.find(candidate => this._tabIds.get(candidate) === id);
		if (!tab) { return false; }
		if (chatId) {
			this._chatOwners.set(tab, chatId);
			// Another caller's selection of this tab would only be refused from now on.
			for (const [key, pin] of [...this._pins]) {
				if (pin.tab === tab && pin.caller.chatId !== chatId) { this._pins.delete(key); }
			}
		} else {
			this._chatOwners.delete(tab);
		}
		this._onDidChangeShare.fire();
		return true;
	}

	/** A closed chat's tabs become free for everyone. */
	public releaseChatTabs(chatId: string): void {
		let changed = false;
		for (const [tab, owner] of [...this._chatOwners]) {
			if (owner === chatId) { this._chatOwners.delete(tab); changed = true; }
		}
		if (changed) { this._onDidChangeShare.fire(); }
	}

	/** Our id of the tab a chat conversation last worked on, while it is open. */
	public tabIdForChat(chatId: string): string | undefined {
		const tab = this._chatTabs.get(chatId);
		if (!tab) { return undefined; }
		if (!tabSource.all.includes(tab)) { this._chatTabs.delete(chatId); return undefined; }
		return this._idOf(tab);
	}

	/**
	 * The browser tab the user is looking at, if any.
	 *
	 * This is what a command the *user* pressed should act on, whatever an
	 * assistant has selected. `undefined` means no browser tab has focus, and
	 * the caller falls back to {@link _resolveTab}.
	 */
	public get focusedTab(): vscode.BrowserTab | undefined {
		return tabSource.available() ? tabSource.active : undefined;
	}

	/**
	 * Whether the window has any browser tab at all.
	 *
	 * Distinct from {@link focusedTab}, and the distinction is what the menu got
	 * wrong: "no tab is focused" is the normal state while somebody reads a
	 * file, and "no tab exists" is the state where every entry about giving a
	 * tab away is nonsense.
	 */
	public get hasOpenTabs(): boolean {
		return tabSource.available() && tabSource.all.length > 0;
	}

	/**
	 * The tab a command the *user* ran is about, when one is not necessarily
	 * focused — the status bar menu is clicked with focus wherever it was.
	 *
	 * The focused tab, else the one the user last had in front of them while it
	 * is still open, else the only one — the rule `LoginWatcher.userTab` follows
	 * for the same reason (#259). Never an assistant's pin or share: this is the
	 * person's own gesture. `undefined` when more than one tab is open and none
	 * can be told apart, so the caller asks rather than guesses.
	 */
	public get userTab(): vscode.BrowserTab | undefined {
		if (!tabSource.available()) {
			return undefined;
		}
		const open = tabSource.all ?? [];
		const focused = tabSource.active;
		if (focused) {
			this._userFocus = focused;
			return focused;
		}
		if (this._userFocus && open.includes(this._userFocus)) {
			return this._userFocus;
		}
		return open.length === 1 ? open[0] : undefined;
	}

	/** Our id for a tab, the one `browser_tabs` lists and `browser_select_tab` takes. */
	public tabIdOf(tab: vscode.BrowserTab): string {
		return this._idOf(tab);
	}

	/** Gives every open tab an id and forgets the ones that have closed. */
	private _identify(open: readonly vscode.BrowserTab[]): void {
		for (const tab of open) {
			if (!this._tabIds.has(tab)) {
				this._tabIds.set(tab, `tab-${this._tabIdPrefix}-${this._nextTabId++}`);
			}
		}
		for (const known of [...this._tabIds.keys()]) {
			if (!open.includes(known)) {
				this._tabIds.delete(known);
			}
		}
	}

	/** The id of a tab, minting one if this is the first time it is named. */
	private _idOf(tab: vscode.BrowserTab): string {
		this._identify(tabSource.all);
		return this._tabIds.get(tab) ?? 'tab-0';
	}

	/**
	 * How this caller's tab was chosen, which is what tells a model whether its
	 * own choice still holds.
	 *
	 * Per caller now, because the answer differs between them: the same window
	 * can have Claude on a page of its own, Codex following the user, and a
	 * third assistant paused because the page it was given was closed.
	 */
	private _selectionKind(caller: CallerIdentity): 'shared' | 'paused' | 'selected' | 'automatic' {
		const resolution = this._shares.resolve(caller);
		if (resolution.kind === 'shared') {
			return 'shared';
		}
		// Not `automatic`: nothing is being followed, and reporting the mode the
		// tools *would* be in reads as "carry on" next to a refusal.
		if (resolution.kind === 'paused') {
			return 'paused';
		}
		return this._pins.has(callerKey(caller)) ? 'selected' : 'automatic';
	}

	/** Resolve once for a long-lived recording, using the same access rules as other tools. */
	public recordingTab(caller?: CallerIdentity): vscode.BrowserTab { return this._requireTab(caller); }

	/** A recording stays on its original tab; changing focus or a tool pin does not revoke access. */
	public canRecordTab(tab: vscode.BrowserTab, caller?: CallerIdentity): boolean {
		if (!tabSource.available() || !tabSource.all.includes(tab)) { return false; }
		if (!caller) { return true; }
		const assignment = this._shares.resolve(caller);
		return assignment.kind === 'unassigned' || (assignment.kind === 'shared' && assignment.tab === tab);
	}

	/**
	 * The tab to act on, or a refusal the model can act on.
	 *
	 * Every tool goes through here, which is why the wording matters: this is the
	 * text the assistant sees when there is nothing to drive.
	 */
	private _requireTab(caller?: CallerIdentity): vscode.BrowserTab {
		requireGrant();

		// No caller means a command the user pressed. It never pauses: a lost
		// assignment is an assistant's problem, and blocking a button would be
		// answering a question nobody asked — they can see which tab they are
		// in.
		if (!caller) {
			const tab = this._resolveTab();
			if (!tab) {
				throw new Error('No browser tab is open.');
			}
			return tab;
		}

		const { tab, paused } = this._resolveForCaller(caller);
		if (paused) {
			throw new Error(shareLostMessage(paused));
		}
		if (!tab) {
			throw new Error(
				'No browser tab is open. Ask the user to open a page, or call `browser_navigate` with a URL first.');
		}
		this._noteTabUse(tab, caller);
		return tab;
	}

	/**
	 * Records that an assistant holding this tab has actually called something.
	 *
	 * **This used to exclude `browser_state` and `browser_tabs`**, on the
	 * grounds that they answer without touching a page and a marker lighting up
	 * on them would claim work on a tab nothing had opened. That was the right
	 * rule while the marker was a suffix written into the page title, where 🤖
	 * sat beside the page's own name and read as "something is happening here".
	 *
	 * It is the wrong rule now. The two states live in the status bar and its
	 * menu (see `statusBar.ts`), where the question they answer is *"has this
	 * assistant picked the tools up, or does it need restarting?"* — and a
	 * `browser_state` call settles that as conclusively as a click does. The
	 * connect prompt prescribes exactly that call as the check, so excluding it
	 * meant a check that succeeded still left 🔗 and a menu row telling the user
	 * to restart a session that had just proved it works.
	 *
	 * **The test is on the caller's own assignment, not on the tab.** It used to
	 * be `isShared(tab)`, which asks whether *anybody* holds the tab — and an
	 * unassigned caller resolves to the focused tab, which may well be one the
	 * user gave to somebody else. Reproduced against the registry: Claude holds
	 * tab A, Codex holds nothing, A is focused, Codex calls `browser_state` →
	 * A's usage (then kept per tab) became `['codex']`. `usedByTarget` filters by kind, so
	 * Claude's row was unharmed and the bug stayed invisible — until the user
	 * later gave A to Codex as well, at which point that row read "Working on
	 * this tab" from a call made before the assignment existed, and the
	 * "restart it" hint the two states exist for was suppressed.
	 *
	 * The guard predates this rule and the old wording claimed a caller-level
	 * test it never performed; what changed is that `state` and `tabs` are now
	 * call sites, and `browser_state` is the call the server's instructions and
	 * the connect prompt both tell a model to make first — so the reachable
	 * path became the common one.
	 *
	 * `resolve` also settles the session-scoped case for free: one Claude
	 * conversation cannot mark a tab assigned to another.
	 */
	private _noteTabUse(tab: vscode.BrowserTab, caller: CallerIdentity): void {
		const resolution = this._shares.resolve(caller);
		if (resolution.kind !== 'shared' || resolution.tab !== tab) {
			return;
		}
		if (!this._shares.noteUse(tab, caller.kind, resolution.target)) {
			return;
		}
		this._onDidChangeShare.fire();
	}

	/**
	 * The session for the tab this caller acts on.
	 *
	 * Every tool goes through here, which is why it takes the caller: the tab
	 * is no longer a property of the window but of whoever is asking.
	 */
	private async _withSession<T>(
		caller: CallerIdentity,
		run: (session: TabSession, tab: vscode.BrowserTab) => Promise<T>,
	): Promise<T> {
		await this._settle();
		const tab = this._requireTab(caller);
		// **A scope rather than a hand-out**, so the claim covers the work instead
		// of the acquisition, and released in a `finally`, so a page-side throw
		// cannot leave the tab claimed for the life of the window.
		//
		// **Taken before the open, not after it.** `_sessionFor` resolves into a
		// microtask, and another tab's open can run its own `_evict` in between —
		// at which point this tab is in `_sessions` with nothing recording that
		// somebody is about to use it, so it reads as a spare and is dropped under
		// the caller that just asked for it. Holding first covers the open as well
		// as the work; a tab with no session yet is simply never a candidate.
		const release = this._hold(tab);
		try {
			const session = await this._sessionFor(tab);
			return await run(session, tab);
		} finally {
			release();
		}
	}

	/**
	 * The session for a tab, opening one if there is none to reuse.
	 *
	 * No "superseded while opening" case any more: a session belongs to its tab
	 * rather than to the window, so the only reasons an arriving one is unwanted
	 * are that the controller was disposed or the tab closed — both of which it
	 * checks for itself, and neither of which another caller can cause. The
	 * retry, the token and the `_stillWanted` predicate that guarded that shape
	 * are gone with it.
	 */
	private _sessionFor(tab: vscode.BrowserTab): Promise<TabSession> {
		if (this._disposed) {
			return Promise.reject(new Error('The integrated browser connection has been closed.'));
		}

		const cached = this._sessions.get(tab);
		if (cached && !cached.isClosed) {
			this._touch(tab);
			return Promise.resolve(cached);
		}
		if (cached) {
			this._dropSession(tab);
		}

		// An open already under way for this tab is shared, not raced.
		const pending = this._opening.get(tab);
		if (pending) {
			return pending;
		}

		// Queued, so an open does not push the count past the bound while every
		// existing session is busy. Bounded, so it cannot hang behind one.
		// **Held from the moment the permit is granted, released in the same turn
		// the session lands.** A trailing `.finally` runs a microtask *after*
		// `_sessions.set`, so for that tick the session was counted twice — once as
		// a reservation and once as itself — and a `_tryReserve` landing in it read
		// the sum as one over and evicted a session that did not need to go, taking
		// a console buffer with it. The mirror is just as real: a waiter refused a
		// slot that existed and stalled for the full wait.
		let slotHeld = false;
		const releaseSlot = () => {
			if (!slotHeld) {
				return;
			}
			slotHeld = false;
			this._reserved--;
			this._notifySlots();
		};

		const abort = new AbortController();
		const aborts = this._openAborts.get(tab) ?? new Set<AbortController>();
		aborts.add(abort);
		this._openAborts.set(tab, aborts);
		// Assigned below, before anything can land; read by the landing open to
		// ask whether it is still the current one for this tab.
		let promise: Promise<TabSession> | undefined;
		const opening = this._awaitSlot(abort.signal).then(() => {
			slotHeld = true;
			return TabSession.open(tab, abort.signal);
		}).then(session => {
			const open = tabSource.all ?? [];
			if (this._disposed || !open.includes(tab)) {
				// Nobody will ever read this one, so it closes itself rather
				// than leaking: before the map, an open landing after `dispose`
				// was cached and left running with nothing to close it.
				session.dispose();
				throw new Error('The integrated browser connection has been closed.');
			}
			// **Only the current open may adopt the slot.** `navigate`'s retry
			// drops an open without aborting it and starts another, so two can be
			// in flight for one tab. The older one used to delete the newer one's
			// `_opening` entry on landing, and whichever landed second overwrote
			// `_sessions` without disposing what it replaced — a leaked channel
			// and its console listeners for the life of the window (item 29's
			// shape). A live session already cached for the tab wins; the
			// newcomer closes itself and hands that one out instead.
			if (this._opening.get(tab) === promise) {
				this._opening.delete(tab);
			}
			const current = this._sessions.get(tab);
			if (current && current !== session && !current.isClosed) {
				session.dispose();
				releaseSlot();
				this._touch(tab);
				return current;
			}
			if (current && current !== session) {
				current.dispose();
			}
			this._sessions.set(tab, session);
			this._touch(tab);
			this._evict(tab);
			// Synchronously, so the double count above never exists.
			releaseSlot();
			return session;
		});

		// Only for the paths that never reached the line above: the open failed, the
		// tab closed while it was in flight, or the controller was disposed. A
		// success has already given the slot back, and `releaseSlot` is idempotent.
		promise = opening.finally(() => {
			releaseSlot();
			const mine = this._openAborts.get(tab);
			mine?.delete(abort);
			if (mine?.size === 0) {
				this._openAborts.delete(tab);
			}
		});

		this._opening.set(tab, promise);
		// A rejection has to release the entry, or the failed attempt is cached:
		// the lookup above would hand the same rejected promise to every later
		// call, so one failed handshake — a page that crashed, a host hiccup —
		// made that tab permanently broken until something dropped it.
		promise.catch(() => {
			if (this._opening.get(tab) === promise) {
				this._opening.delete(tab);
			}
		});
		return promise;
	}

	/**
	 * Takes one slot for an open that is about to start, making room if it can.
	 *
	 * **A reservation, not a question.** Asking "is there room?" and then opening
	 * was wrong in two ways at once, and both were reproduced. `_notifySlots`
	 * wakes every waiter, and resolving a promise does not run its continuations
	 * before the next waiter is called — so each one saw the *same* freed session
	 * and all of them went on to open. And a check against `_sessions` alone is
	 * blind to opens already under way, so callers arriving together at a cold
	 * start all passed while the map was still empty: six simultaneous calls
	 * opened six channels against a limit of four.
	 *
	 * Counting `_reserved` alongside `_sessions` closes both, because the permit
	 * is taken here — synchronously, before anything awaits — so the second
	 * caller in the same turn already sees it.
	 *
	 * Room is *made* rather than merely promised: a session the sweep would give
	 * up is dropped now, so what the caller is handed is capacity that exists.
	 */
	private _tryReserve(ceiling: number = BrowserController._sessionLimit): boolean {
		// The drops below free capacity this call is about to take, so waking the
		// queue from them would hand the slot being made to somebody else.
		this._reserving = true;
		try {
			while (this._sessions.size + this._reserved >= ceiling) {
				const spare = this._evictableTab();
				if (!spare) {
					return false;
				}
				this._dropSession(spare);
			}
			this._reserved++;
			return true;
		} finally {
			this._reserving = false;
		}
	}

	/**
	 * Waits for a slot, and gives up waiting after {@link _slotWaitMs}.
	 *
	 * It always resolves holding exactly one reservation — on the timeout and on
	 * teardown it simply takes one — so the release in `_sessionFor` is
	 * unconditional and the count cannot drift. It *rejects* holding none, and
	 * that is the one other way out: `signal`, fired when the tab closes.
	 *
	 * **A closed tab leaves the queue at once, without a permit.** The signal
	 * used to reach only `TabSession.open`, after the wait, so an open queued
	 * for a tab that had closed sat out the whole `_slotWaitMs` before saying
	 * so — and when a busy call finished first, the dead open won the slot and
	 * `_tryReserve` evicted the session that had just gone idle to make room
	 * for an open that could not succeed. Breaks-silently #213.
	 */
	private _awaitSlot(signal?: AbortSignal): Promise<void> {
		const closed = () => new Error('The browser tab was closed while its session was opening.');
		if (signal?.aborted) {
			return Promise.reject(closed());
		}
		if (this._disposed) {
			this._reserved++;
			return Promise.resolve();
		}
		if (this._tryReserve()) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			const leave = () => {
				clearTimeout(timer);
				this._slotWaiters.delete(waiter);
				signal?.removeEventListener('abort', onAbort);
			};
			const onAbort = () => {
				leave();
				reject(closed());
			};
			const waiter = () => {
				// Each waiter competes for the permit rather than trusting the
				// wake-up: one release frees one slot, so exactly one of them wins
				// and the rest stay queued.
				if (this._disposed) {
					this._reserved++;
				} else if (!this._tryReserve()) {
					return;
				}
				leave();
				resolve();
			};
			// Going ahead beats hanging — but only as far as `_sessionOverflow`.
			// Granting unconditionally here gave every waiter its own permit, so the
			// overflow was the size of the burst rather than the one channel the
			// documentation promises. Past the ceiling the call is refused instead,
			// with something a model can act on: the work already running will end,
			// and a retry then finds a slot.
			const timer = setTimeout(() => {
				this._slotWaiters.delete(waiter);
				signal?.removeEventListener('abort', onAbort);
				if (this._tryReserve(
					BrowserController._sessionLimit + BrowserController._sessionOverflow)) {
					resolve();
					return;
				}
				reject(new Error('Too many browser pages are in use at once. Wait for the calls already '
					+ 'running to finish, then try again.'));
			}, BrowserController._slotWaitMs);
			this._slotWaiters.add(waiter);
			signal?.addEventListener('abort', onAbort, { once: true });
		});
	}

	/** Wakes everything queued for a slot; each re-checks for itself. */
	private _notifySlots(): void {
		// `_tryReserve` drops sessions to make the very slot it is about to take;
		// waking the queue from inside that would hand it to another waiter and
		// leave the reserver to drop a second one.
		if (this._reserving) {
			return;
		}
		for (const waiter of [...this._slotWaiters]) {
			waiter();
		}
	}

	/**
	 * Claims a tab's session for the length of one piece of work.
	 *
	 * The returned release is idempotent, so a `finally` that runs twice — or a
	 * caller that releases and then throws — cannot drive the count negative and
	 * pin a tab out of the eviction queue for the life of the window.
	 */
	private _hold(tab: vscode.BrowserTab): () => void {
		this._inFlight.set(tab, (this._inFlight.get(tab) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			const rest = (this._inFlight.get(tab) ?? 1) - 1;
			if (rest > 0) {
				this._inFlight.set(tab, rest);
				return;
			}
			this._inFlight.delete(tab);
			// `_evict` stands down rather than dropping a session that is in use, so
			// the limit can be over by the time this call ends. This is what brings
			// it back: without it the excess would persist until the next open. The
			// sweep runs first, so a waiter woken below sees the slot it frees.
			if (!this._disposed) {
				this._evict();
			}
			this._notifySlots();
		};
	}

	/** Marks a tab as the most recently used, for eviction order. */
	private _touch(tab: vscode.BrowserTab): void {
		this._sessionOrder = this._sessionOrder.filter(known => known !== tab);
		this._sessionOrder.push(tab);
	}

	/**
	 * Keeps the number of live channels bounded.
	 *
	 * A tab somebody is assigned to is passed over while any unassigned one
	 * remains: evicting the page an assistant is working on — losing the console
	 * buffer that is the whole reason a session is cached — to make room for a
	 * page nobody asked about is the wrong trade every time. When every session
	 * belongs to an assignment, the least recently used goes anyway; the
	 * alternative is an unbounded number of open channels.
	 */
	private _evict(arriving?: vscode.BrowserTab): void {
		while (this._sessions.size > BrowserController._sessionLimit) {
			const target = this._evictableTab(arriving);
			if (!target) {
				// Every candidate is working, so the bound stays over until one of
				// them finishes. `_hold`'s release sweeps again the moment a tab
				// goes idle, so it is a delay rather than a leak, and breaking a
				// live call to hold a number is the wrong way round.
				return;
			}
			this._dropSession(target);
		}
	}

	/**
	 * The session this controller would give up next, or `undefined` while every
	 * one of them is working.
	 *
	 * `exclude` is the arrival, which is never the target: it is the most
	 * recently used *and* unassigned whenever the caller has no tab of its own,
	 * so the search below would pick it — the opener then got a session that had
	 * already been disposed, and its first send failed with "CDP session closed".
	 *
	 * **Being used is a hard constraint; being assigned is only a preference**,
	 * and collapsing the two into one predicate with a `?? candidates[0]`
	 * fallback dropped the session of a live call while the guard above it did
	 * nothing at all. The two differ in what eviction costs: an assigned but idle
	 * tab loses its console buffer and reopens on its next call, while a tab with
	 * work in flight loses the call itself — the one
	 * error the docs single out as reading to a model as a broken browser rather
	 * than as something to retry. So an assignment is given up when there is
	 * nothing else to take, and work in flight is never given up at all.
	 *
	 * One rule, used by `_evict` *and* by `_tryReserve`, so capacity can never be
	 * taken under a rule the sweep would not have agreed with.
	 */
	private _evictableTab(exclude?: vscode.BrowserTab): vscode.BrowserTab | undefined {
		const candidates = this._sessionOrder.filter(tab =>
			tab !== exclude && this._sessions.has(tab));

		const inUse = (tab: vscode.BrowserTab) => this._inFlight.has(tab);
		const spokenFor = (tab: vscode.BrowserTab) =>
			this._shares.isShared(tab)
			|| [...this._pins.values()].some(pin => pin.tab === tab);

		return candidates.find(tab => !inUse(tab) && !spokenFor(tab))
			?? candidates.find(tab => !inUse(tab));
	}

	/** Closes the session for one tab, or for all of them. */
	private _dropSession(tab?: vscode.BrowserTab): void {
		if (!tab) {
			for (const known of [...this._sessions.keys()]) {
				this._dropSession(known);
			}
			this._opening.clear();
			return;
		}
		this._sessions.get(tab)?.dispose();
		this._sessions.delete(tab);
		this._opening.delete(tab);
		this._sessionOrder = this._sessionOrder.filter(known => known !== tab);
		// **A slot has just come free, whoever freed it.** The queue was woken only
		// from `_hold`'s release and from an open settling, so capacity given back
		// any other way — a tab closing, `navigate`'s `CDP session closed` retry,
		// the stale-cache branch above — went unnoticed and a queued open sat there
		// until its timeout, with a usable slot in front of it the whole time.
		this._notifySlots();
	}

	/* ------------------------------------------------------------ sharing a tab */

	/**
	 * Runs a share transition, after any already queued.
	 *
	 * The chain kept in `_transition` is a copy whose rejection is absorbed, so a transition that
	 * fails cannot reject in the face of the next one — or of a tool waiting in
	 * {@link _settle}. The caller still gets the real error.
	 */
	private _transact<T>(work: () => Promise<T>): Promise<T> {
		const run = this._transition.then(work);
		this._transition = run.then(() => undefined, () => undefined);
		return run;
	}

	/**
	 * Waits for any share transition to finish.
	 *
	 * Loops, because a transition can begin while we are waiting for the one
	 * before it — the whole point is that no tool starts while the tab it would
	 * resolve is being changed underneath it.
	 */
	private async _settle(): Promise<void> {
		let awaited: Promise<void> | undefined;
		while (awaited !== this._transition) {
			awaited = this._transition;
			await awaited;
		}
	}

	/** Everything the UI needs to render the assignments and undo them. */
	public get shares(): ShareView {
		return {
			assignments: this._shares.assignments().map(assignment => ({
				target: assignment.target,
				label: targetName(assignment.target),
				tabId: this._idOf(assignment.tab),
				url: assignment.tab.url,
				title: stripMarker(assignment.tab.title),
				usedBy: assignment.usedBy,
			})),
			paused: this._shares.pausedTargets().map(target => ({ target, label: targetName(target) })),
		};
	}

	/** Whether this tab is assigned to anyone, for the menu that offers to move it. */
	public isShared(tab: vscode.BrowserTab): boolean {
		return this._shares.isShared(tab);
	}

	/**
	 * Gives one tab to one target, on the user's instruction.
	 *
	 * Clearing the assistant's own pin is part of it: a pin under an assignment
	 * can never take effect, and leaving it in place would bring it back the
	 * moment the assignment was released — the agent would resume on a page
	 * chosen in a conversation that has since moved on.
	 */
	public shareTab(
		tab: vscode.BrowserTab,
		target: ShareTarget = everyone,
	): Promise<{ id: string; url: string; title: string | undefined; label: string }> {
		return this._transact(() => this._shareTab(tab, target));
	}

	private async _shareTab(
		tab: vscode.BrowserTab,
		target: ShareTarget,
	): Promise<{ id: string; url: string; title: string | undefined; label: string }> {
		// Checked here rather than at the caller, because `_transact` can defer
		// this body past several CDP round-trips: two clicks queue up, and the
		// second one's tab can be closed by the time its turn comes. Adopting it
		// left the UI advertising a share on a tab that no longer existed.
		if (!tabSource.all.includes(tab)) {
			throw new Error('That browser tab is no longer open.');
		}

		// Asked of the target itself rather than of a caller built from it:
		// resolving that answered with a *different* assignment for `everyone`
		// (it became `{ kind: 'other' }`, which resolves `kind:other` first).
		const alreadyThere = this._shares.tabOf(target) === tab;

		// Re-giving the tab that this target already holds is a no-op, and has
		// to be: the entry sits in the shared tab's own menu, so it is one click
		// away, and re-running it reset `usedBy` — taking the status bar from 🤖
		// back to 🔗 and the menu row back to "has not picked it up yet", which
		// is advice for a broken setup — while the assistants carried on
		// working.
		if (alreadyThere) {
			return {
				id: this._idOf(tab), url: tab.url, title: stripMarker(tab.title), label: targetName(target),
			};
		}

		this._shares.share(target, tab);
		// Deliberately *not* `_lastTab = tab`: that field is the tab the user
		// was last looking at, and an assignment made for one assistant is not
		// that. Writing it here handed the assigned page to every unassigned
		// caller as its fallback.
		//
		// **Every caller this assignment now answers for** loses its own
		// selection, and nobody else does. An assignment outranks a selection,
		// so a shadowed pin would resurrect a stale choice the moment the
		// assignment was released — and deriving one key from the target was
		// not the same thing: a Codex *conversation* keeps its pin under
		// `session:<id>`, so giving Codex a tab deleted `kind:codex` and left
		// the conversation's own pin behind, which it then went back to as soon
		// as the assignment was released. Asking the registry who each pin
		// resolves to now covers a conversation, an assistant and everybody
		// with one rule.
		for (const [key, pin] of [...this._pins]) {
			const resolution = this._shares.resolve(pin.caller);
			if (resolution.kind === 'shared' && resolution.tab === tab
				&& this._shares.tabOf(resolution.target) === tab
				&& sameTarget(resolution.target, target)) {
				this._pins.delete(key);
			}
		}
		this._onDidChangeShare.fire();
		this._primeConsole(tab);

		return {
			id: this._idOf(tab), url: tab.url, title: stripMarker(tab.title), label: targetName(target),
		};
	}

	/**
	 * Opens the tab's session now, so the console is captured from the moment it
	 * is given away rather than from the assistant's first call.
	 *
	 * Console messages only arrive while something is attached — that is the
	 * whole reason a session is cached rather than opened per call — so between
	 * "share this tab" and the first `browser_` call there was a window whose
	 * output nothing recorded. The user spends that window reloading the page
	 * and describing what went wrong, which is exactly the output the assistant
	 * is about to be asked for.
	 *
	 * This used to happen **by accident**: `_shareTab` ended in `_armMarker`,
	 * which called `_sessionFor` to install the title marker. Removing the
	 * marker removed the priming with it and nothing said so, because nothing
	 * had ever said it was load-bearing. It is explicit now.
	 *
	 * Best effort and unawaited: sharing must not fail, or wait, because a page
	 * would not attach. It takes no hold — there is no work to protect, and the
	 * session is worth exactly as much as it is worth to evict.
	 */
	private _primeConsole(tab: vscode.BrowserTab): void {
		void this._sessionFor(tab).catch(() => { /* the first tool call will try again */ });
	}

	/** Releases one assignment, or every one of them, and tidies the tabs. */
	public stopSharing(target?: ShareTarget): Promise<void> {
		return this._transact(() => this._stopSharing(target));
	}

	private async _stopSharing(target?: ShareTarget): Promise<void> {
		if (target) {
			this._shares.stop(target);
		} else {
			this._shares.stopAll();
		}
		this._onDidChangeShare.fire();
	}

	/**
	 * A tab has closed: every assignment on it pauses, and nobody else's moves.
	 *
	 * Paused rather than released, because "the page you were given is gone" and
	 * "you were never given one" are different answers — see the registry.
	 */
	private _loseTab(tab: vscode.BrowserTab): void {
		this._annotations.close(tab);
		// The cleanup is unconditional, and used to sit behind the early return
		// below: closing an ordinary tab — the common case — left its
		// `TabSession` undisposed and still counting against the session limit,
		// and kept the element markdown picked on it for the life of the
		// window, keyed by a tab that no longer exists.
		this._selectedElements.delete(tab);
		if (this._chatOwners.delete(tab)) { this._onDidChangeShare.fire(); }
		// An open still in flight for this tab is ended, not abandoned: if the
		// page had stopped answering, nothing else would ever settle it.
		for (const abort of this._openAborts.get(tab) ?? []) {
			abort.abort();
		}
		this._dropSession(tab);
		for (const [key, pin] of [...this._pins]) {
			if (pin.tab === tab) {
				this._pins.delete(key);
			}
		}

		const lost = this._shares.forget(tab);
		// The last tab gone releases every pause, not only this tab's: with no
		// page open there is nothing an assistant could drift onto, and the
		// paused item would otherwise stay yellow in a window with no browser
		// at all. The closing tab is filtered out explicitly rather than
		// trusting `browserTabs` to have dropped it before the event fires.
		const remaining = tabSource.all.filter(open => open !== tab);
		const released = remaining.length === 0 ? this._shares.releasePaused() : [];
		if (lost.length === 0 && released.length === 0) {
			return;
		}
		this._onDidChangeShare.fire();
	}


	public async state(caller: CallerIdentity): Promise<unknown> {
		await this._settle();
		if (!tabSource.available()) {
			return {
				available: false,
				annotationTabs: chromeAnnotationSessions.visible(caller),
				reason: 'Open Google Chrome with "AI Browser: Open in Google Chrome", or enable native browser tabs with '
					+ '"AI Browser: Enable Integrated Browser API".',
			};
		}

		const open = tabSource.all ?? [];
		this._identify(open);
		// The tab *this caller* will act on, which is not the same thing as the
		// focused editor, and not the same thing as another assistant's tab.
		const { tab: target, paused, target: assignment } = this._resolveForCaller(caller);
		// Answering at all proves this caller has the tools — which is the whole
		// of what the status bar's 🔗/🤖 is asking. See `_noteTabUse`.
		if (target) {
			this._noteTabUse(target, caller);
		}
		// `assignment !== undefined` is not the test — a *paused* caller has no
		// assignment in that sense, and answering it with the window's tab count
		// is the same mistake the sibling method was fixed for: the moment its
		// page is gone is not the moment to start describing the others.
		const bounded = assignment !== undefined || paused !== undefined;
		return {
			available: true,
			annotationTabs: chromeAnnotationSessions.visible(caller),
			// Assigned callers are told how many other tabs exist, not what
			// they are: the page they were given is their scope, and every
			// other address in the window — one-time links, tokens in a query
			// string — is not theirs to read.
			openTabs: paused ? 0 : (bounded ? 1 : open.length),
			...(assignment && open.length > 1 ? { otherTabsInWindow: open.length - 1 } : {}),
			tab: target ? { id: this._tabIds.get(target), url: target.url, title: stripMarker(target.title) } : undefined,
			selection: this._selectionKind(caller),
			...(assignment ? { sharedByUser: true, sharedWith: targetName(assignment) } : {}),
			...(paused ? { sharedTabClosed: true, note: shareLostMessage(paused) } : {}),
			hasSelectedElement: target !== undefined && this._selectedElements.has(target),
		};
	}

	/**
	 * Every open tab with an id to address it by.
	 *
	 * The ids are ours, not the editor's — see {@link _tabIds} — so they are
	 * only good for as long as this window lives, and a model has to list before
	 * it selects rather than remembering an id from an earlier conversation.
	 */
	public async tabs(caller: CallerIdentity): Promise<unknown> {
		await this._settle();
		if (!tabSource.available()) {
			return {
				available: false,
				annotationTabs: chromeAnnotationSessions.visible(caller),
				reason: 'Open Google Chrome with "AI Browser: Open in Google Chrome", or enable native browser tabs with '
					+ '"AI Browser: Enable Integrated Browser API".',
			};
		}

		const open = tabSource.all ?? [];
		this._identify(open);
		const { tab: target, paused, target: assignment } = this._resolveForCaller(caller);
		if (target) {
			this._noteTabUse(target, caller);
		}
		const focused = tabSource.active;

		// **An assigned caller sees its own tab and nothing else.** The other
		// tabs used to be listed as context, on the reasoning that they are not
		// *selectable* anyway — but a user who gives one page to an assistant is
		// bounding what it can see, and a list of every other address in the
		// window (one-time links, tokens in a query string) is the one hole in
		// that. Unassigned callers still get the whole list: nothing has been
		// bounded, and they follow the user.
		// A paused caller gets **nothing**, not the full list: the page it was
		// given is gone, and answering with every other tab in the window —
		// their addresses, one-time links and query-string tokens included — is
		// the opposite of what the assignment was for. The note says what
		// happened; the count of others is withheld for the same reason.
		const visible = paused ? [] : (assignment && target ? [target] : open.filter(tab => this._usableBy(tab, caller)));

		return {
			selection: this._selectionKind(caller),
			...(paused ? { sharedTabClosed: true, note: shareLostMessage(paused) } : {}),
			...(assignment && open.length > visible.length
				? { otherTabsInWindow: open.length - visible.length }
				: {}),
			annotationTabs: chromeAnnotationSessions.visible(caller),
			tabs: visible.map(tab => ({
				id: this._tabIds.get(tab),
				url: tab.url,
				title: stripMarker(tab.title),
				inUse: tab === target,
				...(caller.chatId && this._chatOwners.get(tab) === caller.chatId ? { ownedByThisChat: true } : {}),
				sharedByUser: this._shares.isShared(tab),
				focusedInEditor: tab === focused,
			})),
		};
	}

	/**
	 * Points every later tool at one tab, by an id from {@link tabs}.
	 *
	 * `auto` releases it, which is the state everything starts in: follow the
	 * focused tab, and fall back to the last one used. A selection also outlives
	 * the user clicking into a file or into another page — that is the point of
	 * it — but not the tab being closed, after which `selection` reads
	 * `automatic` again.
	 */
	public async selectTab(id: string, caller: CallerIdentity): Promise<unknown> {
		// Before the share checks below, or a selection arriving mid-transition
		// would be judged against a share that is halfway moved.
		await this._settle();
		if (!tabSource.available()) {
			requireGrant();
		}

		const assignment = this._shares.resolve(caller);
		if (assignment.kind === 'paused') {
			throw new Error(shareLostMessage(assignment.target));
		}
		if (assignment.kind === 'shared') {
			throw new Error(
				`The user has given you one browser tab (${this._idOf(assignment.tab)}), and your tools act on that `
				+ 'tab only — a selection made here could never take effect. Ask the user to give you a different '
				+ 'tab, or to stop sharing, from the AI Browser status bar menu.');
		}

		const open = tabSource.all ?? [];
		this._identify(open);

		if (id === 'auto') {
			this._pins.delete(callerKey(caller));
			const target = this._resolveTab();
			return {
				selection: this._selectionKind(caller),
				tab: target
					? { id: this._tabIds.get(target), url: target.url, title: stripMarker(target.title) }
					: undefined,
			};
		}

		const match = open.find(tab => this._tabIds.get(tab) === id);
		if (!match) {
			throw new Error(`No open browser tab has the id ${id}. `
				+ 'Call `browser_tabs` for the current list — ids change as tabs open and close.');
		}

		if (!this._usableBy(match, caller)) {
			throw this._ownedRefusal(id);
		}
		// The pin above is this caller's; `_lastTab` is the user's, and a
		// selection is not a user action.
		this._pins.set(callerKey(caller), { tab: match, caller });
		// The session in hand may belong to the tab we are leaving.
		// Nothing to invalidate: a picked element belongs to its tab now, so
		// selecting another cannot hand back the one picked on this.
		return {
			selection: this._selectionKind(caller),
			tab: { id, url: match.url, title: stripMarker(match.title) },
		};
	}

	/**
	 * Opens a URL, driving the tab the tools are already on unless a new one is
	 * asked for.
	 *
	 * Reuse is the default because the alternative piles up editor tabs. There is
	 * no "navigate" in the `browser` proposal, and `openBrowserTab` always mints
	 * a new editor — `$openBrowserTab` generates a fresh id per call, so VS Code
	 * cannot even collapse the tabs into one preview slot — which left an agent
	 * that navigated ten times with ten tabs behind it. `Page.navigate` over the
	 * session we already hold drives the existing tab instead, and stays attached
	 * across the load, so the console of the new page is captured from its first
	 * line rather than from whenever the next tool happens to attach.
	 *
	 * `file:` is refused. Otherwise an agent can point the browser at any file on
	 * disk and then read it back with `browser_text` — turning a browser tool
	 * into an unrestricted file reader.
	 */
	public async navigate(rawUrl: string, newTab: boolean, caller: CallerIdentity): Promise<unknown> {
		await this._settle();
		let parsed: URL;
		try {
			parsed = new URL(rawUrl);
		} catch {
			throw new Error(`Not a valid absolute URL: ${rawUrl}`);
		}

		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			throw new Error(
				`Refusing to open a ${parsed.protocol} URL. Only http and https are allowed, ` +
				'because other schemes would let this tool read local files.');
		}

		if (!tabSource.available()) {
			requireGrant();
		}

		const assignment = this._shares.resolve(caller);
		if (assignment.kind === 'paused') {
			throw new Error(shareLostMessage(assignment.target));
		}
		// A new tab under an assignment would be opened and then never used — it
		// is not the tab this caller resolves to, so the next tool goes back to
		// the page it was given. That shape is already recorded as a bug worth
		// avoiding: a call that reports one tab while everything after it acts
		// on another.
		if (assignment.kind === 'shared' && newTab) {
			throw new Error(
				'The user has given you one browser tab, and your tools stay on it — a new tab would be opened and '
				+ 'then never used. Navigate in your own tab instead (drop `newTab`), or ask the user to give you '
				+ 'another tab.');
		}

		// Whatever was picked on the tab being navigated describes something
		// that is gone. Cleared for the *resolved* tab further down — keyed by
		// tab, this used to be conditional on the caller having an assignment,
		// which left an unassigned caller reading the previous document's
		// element after a same-tab navigation, with `hasSelectedElement` still
		// saying yes.

		const url = parsed.toString();
		// Resolved through the caller, and re-checked afterwards: resolution is
		// the lazy detector for an assigned tab that has gone — the only one on
		// a host that does not fire `onDidCloseBrowserTab` — so the gate above
		// is not the last word. Without the re-check the one tool that *acts*
		// instead of refusing went on to open a brand-new tab at a model-chosen
		// URL, in precisely the state the assignment exists to pause, and
		// reported `openedNewTab: true` while every later call refused.
		const resolved = newTab ? { tab: undefined, paused: undefined } : this._resolveForCaller(caller);
		if (resolved.paused) {
			throw new Error(shareLostMessage(resolved.paused));
		}
		const target = resolved.tab;

		if (target) {
			this._selectedElements.delete(target);
			this._noteTabUse(target, caller);
		}

		if (!target) {
			// Nothing to drive, and nothing of this caller's to drop: sessions
			// belong to tabs now, so the no-argument form would have closed
			// every one of them — another assistant's console buffer with it.
			// A new tab goes to the browser the caller was already working in.
			const tab = await tabSource.open(url, { preserveFocus: true, where: tabSource.isChrome(this._resolveTab(caller)) ? 'chrome' : undefined });
			// An explicit `newTab` selects the tab it just created, and it has
			// to: the tab is opened with `preserveFocus`, so the *old* tab
			// stays active and wins the focused-tab branch of `_resolveTab`,
			// which sits above `_lastTab`. This used to be guarded on a
			// selection already existing, which meant `navigate(newTab: true)`
			// reported the new tab and then every following tool acted on the
			// old one.
			//
			// The other way into this branch is "no tab was open at all", and
			// that one deliberately does not select: nothing was chosen, so
			// the user's focus should still lead. An existing selection is
			// carried over either way, or the next tool would go back to the
			// page the caller chose to leave.
			//
			// Asked again **after** the await: the user can give this caller a
			// tab while `openBrowserTab` is still opening, and that share clears
			// the caller's pins. A pin written underneath it anyway is exactly
			// the shadowed pin the share rules forbid — it comes back the moment
			// the share is stopped, and the assistant returns to a tab it chose
			// before the user overruled it.
			if (caller.chatId) {
				this._chatOwners.set(tab, caller.chatId);
				this._onDidChangeShare.fire();
			}
			const stillUnassigned = this._shares.resolve(caller).kind === 'unassigned';
			if (stillUnassigned && (newTab || this._pins.has(callerKey(caller)))) {
				this._pins.set(callerKey(caller), { tab, caller });
			}
			return { url: tab.url, title: stripMarker(tab.title), tabId: this._idOf(tab), openedNewTab: true };
		}

		try {
			return await this._navigateInTab(target, url);
		} catch (err) {
			// A session can be dropped by the host between two calls. One fresh
			// attempt, and only for that, so a real navigation failure still
			// reports itself instead of being retried twice.
			if (!String(err).includes('CDP session closed')) {
				throw err;
			}
			// This tab's session, not everyone's: the no-argument form closed
			// every session in the window to recover one of them.
			this._dropSession(target);
			return await this._navigateInTab(target, url);
		}
	}

	/** How long `navigate` waits for the load event before reporting what it has. */
	private static readonly _navigationTimeoutMs = 15_000;

	private async _navigateInTab(tab: vscode.BrowserTab, url: string): Promise<unknown> {
		// The longest hold there is: a load event is waited for up to
		// `_navigationTimeoutMs`, so without a claim this is the likeliest call of
		// all to be evicted out from under itself. Taken before the open, for the
		// reason given in `_withSession`.
		const release = this._hold(tab);
		try {
			const session = await this._sessionFor(tab);
			// The buffer describes the page being left.
			session.clearConsole();

			const load = waitForLoad(session, BrowserController._navigationTimeoutMs);
			try {
				const result = await session.client.send('Page.navigate', { url }, session.sessionId);
				if (result?.errorText) {
					throw new Error(`Could not open ${url}: ${result.errorText}`);
				}

				// A same-document navigation — `/docs` to `/docs#intro` — loads nothing
				// and fires no load event, and CDP says so by omitting `loaderId` from
				// the reply ("the previously committed loaderId would not change").
				// Waiting for an event that cannot come stalls every anchor change for
				// the full timeout.
				if (result?.loaderId) {
					await load.settled;
				}
			} finally {
				load.cancel();
			}

			// Read the page rather than the tab: `BrowserTab.url` catches up over an
			// event and can still hold the previous address here. Best effort — the
			// navigation happened either way, and reporting it as a failure because a
			// title could not be read would be a lie.
			let info: { url?: string; title?: string } | undefined;
			try {
				info = await evaluate(session, '({ url: location.href, title: document.title })');
			} catch {
				info = undefined;
			}
			return { url: info?.url ?? url, title: stripMarker(info?.title), tabId: this._idOf(tab), openedNewTab: false };
		} finally {
			release();
		}
	}

	/**
	 * A compact list of things worth interacting with, for orientation.
	 *
	 * **Every selector it hands out is verified to resolve back to the element
	 * it describes**. The original click used the first document.querySelector
	 * match; native actions now require uniqueness. The old builder fell back
	 * to the bare tag name, so two
	 * buttons with no `id` and no `name` were both reported as `button`, and an
	 * agent told to press the second one pressed the first: asked for Delete,
	 * it clicked Save. Nothing anywhere reported a problem — the click
	 * succeeded, on the wrong element.
	 *
	 * The shared snapshot builder verifies uniqueness within each shadow root;
	 * actions resolve every segment again through CDP, including closed roots.
	 *
	 * Classes are deliberately not used, for the reason given under the element
	 * commands: utility-class frameworks make them long and unstable.
	 */
	public async snapshot(frameId: string | undefined, caller: CallerIdentity, signal?: AbortSignal): Promise<unknown> {
		requireFrameId(frameId);
		return this._withSession(caller, async session => {
			const value = await session.actions.snapshot(frameId, signal);
			// Nothing writes a marker into a page any more, but a page an older
			// build reached can still be open with its observer re-applying one.
			// This title is read from the page, so it is one of the two sites
			// `stripMarker` can actually clean — see the note in
			// `shareIndicator.ts` on why the `BrowserTab.title` sites cannot be.
			if (!value) {
				return value;
			}
			const snapshot = { ...value, title: stripMarker(value.title) };
			return frameId === undefined ? withFrameHint(snapshot, await session.frameHint()) : snapshot;
		});
	}

	/**
	 * Asks the user to click an element and returns its full context.
	 *
	 * This one blocks on a human, so its description tells the model to only
	 * call it after asking. The result is remembered for
	 * {@link selectedElement}.
	 */
	public async inspectElement(timeoutMs: number, caller: CallerIdentity, signal?: AbortSignal): Promise<unknown> {
		await this._settle();
		const tab = this._requireTab(caller);

		// **Watched from the start, not from the wait.** Closing a browser tab
		// does not close its CDP session, so without a watch of our own the wait
		// ran out the model's whole `timeoutMs` and then blamed the user for not
		// clicking a page that no longer existed — breaks-silently #123, fixed in
		// `elementPicker.ts` and not here. Armed only once the setup was done, it
		// also missed a tab closed *during* setup, whose sends may never be
		// answered at all; disposing the client rejects them.
		const cts = new vscode.CancellationTokenSource();
		const stop = new AbortController();
		let client: CDPClient | undefined;
		let tabClosed = false;
		let waiting = false;
		let cancelled = false;
		const closeWatch = tabSource.onDidClose(gone => {
			if (gone === tab) {
				tabClosed = true;
				stop.abort();
				cts.cancel();
				client?.dispose();
			}
		});
		const closedMessage = 'The browser tab was closed before an element was picked. '
			+ 'Call `browser_tabs` to see what is open.';

		// **The timeout and a cancellation reach the setup, not only the wait.**
		// Both used to cancel a token that only `once` observed, so a page whose
		// renderer was busy kept `startCDPSession`, the enables and the cleanup
		// waiting with no bound, well past `timeoutMs` — the shape the element
		// picker had before #189, which CLAUDE.md then credited this method with
		// having. While the click is awaited `once` settles on its own and the
		// cleanup still has a live session to switch inspect mode off through;
		// before that, disposing the client is what releases a send nobody will
		// answer. Breaks-silently #212.
		const giveUp = () => {
			stop.abort();
			cts.cancel();
			if (!waiting) {
				client?.dispose();
			}
		};
		const onCancel = () => {
			cancelled = true;
			giveUp();
		};
		signal?.addEventListener('abort', onCancel, { once: true });
		// `setTimeout` treats anything past 2^31 - 1 ms as 1 ms, which answered
		// "did not pick in time" at once.
		const timer = setTimeout(giveUp, Math.min(Math.max(0, timeoutMs), maxTimerMs));

		let sessionId: string | undefined;
		try {
			if (signal?.aborted) {
				onCancel();
			}
			const channel = await whenNotAborted(
				Promise.resolve(tab.startCDPSession()), stop.signal, () => new vscode.CancellationError());
			client = new CDPClient(channel);
			if (cts.token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			sessionId = await client.attachToPage();
			await client.send('DOM.enable', {}, sessionId);
			await client.send('CSS.enable', {}, sessionId);
			await client.send('Overlay.enable', {}, sessionId);
			await client.send('Overlay.setInspectMode', {
				mode: 'searchForNode',
				highlightConfig: { showInfo: true, contentColor: { r: 111, g: 168, b: 220, a: 0.45 } },
			}, sessionId);

			waiting = true;
			const { backendNodeId } = await client.once('Overlay.inspectNodeRequested', cts.token);
			waiting = false;
			const data = await extractElementData(client, sessionId, backendNodeId);
			const rendered = renderElementMarkdown(data, tab.url);
			this._selectedElements.set(tab, rendered);
			return rendered;
		} catch (err) {
			if (tabClosed) {
				throw new Error(closedMessage);
			}
			if (cancelled) {
				throw new Error('The call was cancelled before an element was picked.');
			}
			if (err instanceof vscode.CancellationError || cts.token.isCancellationRequested) {
				throw new Error(
					'The user did not pick an element in time. Ask them to click one, then call this again.');
			}
			throw err;
		} finally {
			signal?.removeEventListener('abort', onCancel);
			closeWatch.dispose();
			clearTimeout(timer);
			cts.dispose();
			// Not on a closed tab: its session is still open and nothing may
			// ever answer. Bounded everywhere else for the same reason — `send`
			// has no timeout of its own.
			if (client && !client.isClosed && sessionId !== undefined && !tabClosed) {
				await withTimeout(
					client.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }, sessionId),
					inspectCleanupTimeoutMs, 'inspect cleanup')
					.catch(() => { /* navigated away, detached, or not answering */ });
			}
			client?.dispose();
		}
	}

	public async selectedElement(caller: CallerIdentity): Promise<unknown> {
		// Settled and guarded like every other tool. Without the guard the read
		// of `browserTabs` below threw the getter's raw "CANNOT use API
		// proposal" at the model instead of the refusal written for it; without
		// the settle it could read a share halfway through a transition.
		await this._settle();
		requireGrant();
		// Resolved through the caller, so this can only ever return what was
		// picked on the tab that caller works on.
		const { tab, paused } = this._resolveForCaller(caller);
		if (paused) {
			throw new Error(shareLostMessage(paused));
		}
		const picked = tab ? this._selectedElements.get(tab) : undefined;
		if (!picked) {
			throw new Error(
				'No element has been picked on your tab yet. Call `browser_inspect_element` after asking the user to '
				+ 'click one.');
		}
		return picked;
	}

	/**
	 * The page's markup, with the value of every password field left out.
	 *
	 * **React writes a controlled input's value into its `value` attribute**, so
	 * on a React sign-in page the password the user typed — or the one a saved
	 * login filled — is in `outerHTML` in clear. Measured with React 19.2. This
	 * tool hands that markup to a model, which must not get a password by
	 * reading a page, any more than `browser_snapshot` gives it one (#211).
	 *
	 * **Redacted here, in the extension, after the markup leaves the page** —
	 * `redactSecretValues` reads it as HTML. The first version cloned the element
	 * in the page and stripped the clone, which ran the page's own code (a deep
	 * clone upgrades custom elements, so their constructors run) from a tool that
	 * had been a pure read, and kept a second copy of the field rule in page
	 * script. A field is secret by type, `autocomplete` token or name, so a "show
	 * password" toggle that turned it into a text field does not reveal it.
	 */
	public async html(selector: string | undefined, frameId: string | undefined, caller: CallerIdentity): Promise<unknown> {
		refuseValueProbe(selector);
		requireFrameId(frameId);
		return this._withSession(caller, async session => {
			const value = await evaluate(session, `(() => {
				const sel = ${literal(selector)};
				const el = sel ? document.querySelector(sel) : document.documentElement;
				if (!el) { throw new Error('No element matches ' + sel); }
				return el.outerHTML;
			})()`, frameId);
			// Nothing writes a marker into a page any more, but a page an older
			// build reached can still be open with its observer re-applying one —
			// and this is the tool a model uses to check a page against itself, so
			// it is the last place a stray suffix may appear.
			return typeof value === 'string' ? redactSecretValues(stripMarkerFromHtml(value)) : value;
		});
	}

	public async text(selector: string | undefined, frameId: string | undefined, caller: CallerIdentity): Promise<unknown> {
		refuseValueProbe(selector);
		requireFrameId(frameId);
		return this._withSession(caller, async session => {
			const text = await evaluate(session, `(() => {
				const sel = ${literal(selector)};
				const el = sel ? document.querySelector(sel) : document.body;
				if (!el) { throw new Error('No element matches ' + sel); }
				return (el.innerText || el.textContent || '').trim();
			})()`, frameId);
			// The whole page and no frame named: say what the text leaves out.
			// With a selector the caller asked for one element and gets just that.
			return frameId === undefined && selector === undefined
				? withFrameHint({ text }, await session.frameHint(), text)
				: text;
		});
	}

	/**
	 * The tab's frames with the ids the other tools take — `browser_frames`.
	 *
	 * Listing attaches to every frame in another process (up to
	 * `maxFrameSessions`), so a frame reported `readable` will take a frame id
	 * at once. See `TabSession._attachFrame` for why such a frame needs it.
	 */
	public async frames(caller: CallerIdentity): Promise<unknown> {
		return this._withSession(caller, async (session, tab) => {
			const frames = await session.frames();
			return {
				url: tab.url,
				frames,
				note: frames.length === 0 ? 'This page has no frames.'
					: frames.some(frame => !frame.readable)
						? 'A frame with readable: false is not connected: it is still loading, it is not answering, or it is past the '
							+ `first ${maxFrameSessions} frames from other sites that a listing connects to. Passing its id as frameId `
							+ 'connects it for that call.'
						: undefined,
			};
		});
	}

	/**
	 * Scrolls the page, a frame or one element — `browser_scroll`.
	 *
	 * With no selector it scrolls what a person would: the document when the
	 * document scrolls, and otherwise the largest scrolling element in it. An
	 * application shell — OneNote, a mail client, a chat — keeps the document
	 * fixed and scrolls an inner panel, and "scroll the window" moved nothing
	 * there. The result names what moved and whether it reached the end, so a
	 * model reading a long page in screenshots knows when to stop.
	 *
	 * In turn with full-page captures (`_onScrollGate`): those scroll the page to
	 * the top and back, and a scroll landing in between would be undone.
	 */
	public async scroll(
		selector: string | undefined,
		by: number | undefined,
		to: 'top' | 'bottom' | undefined,
		frameId: string | undefined,
		caller: CallerIdentity,
	): Promise<unknown> {
		refuseValueProbe(selector);
		requireFrameId(frameId);
		// Both at once has no single meaning; taking one silently is the false
		// success #210 is about. The types themselves are checked at the boundary.
		if (by !== undefined && to !== undefined) {
			throw new Error('Pass either `by` or `to`, not both.');
		}
		return this._withSession(caller, (session, tab) => this._onScrollGate(tab, () => evaluate(session, `(() => {
			const sel = ${literal(selector)};
			const by = ${literal(by)};
			const to = ${literal(to)};
			const root = document.scrollingElement || document.documentElement;
			const hidden = (el) => el && getComputedStyle(el).overflowY === 'hidden';
			const scrolls = (el) => el.scrollHeight > el.clientHeight + 1 && (el === root
				? !hidden(document.documentElement) && !hidden(document.body)
				: /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY));
			let el;
			if (sel) {
				el = document.querySelector(sel);
				if (!el) { throw new Error('No element matches ' + sel); }
			} else if (scrolls(root)) {
				el = root;
			} else {
				let area = 0;
				for (const candidate of document.querySelectorAll('*')) {
					if (!scrolls(candidate)) { continue; }
					const rect = candidate.getBoundingClientRect();
					if (rect.width * rect.height > area) { area = rect.width * rect.height; el = candidate; }
				}
				if (!el) { return { moved: 0, note: 'Nothing in this document scrolls.' }; }
			}
			const before = el.scrollTop;
			if (to === 'top') { el.scrollTo({ top: 0, behavior: 'instant' }); }
			else if (to === 'bottom') { el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }); }
			else { el.scrollBy({ top: by ?? Math.round(el.clientHeight * 0.8), behavior: 'instant' }); }
			const name = el === root ? 'document'
				: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
			return {
				scrolled: name,
				moved: Math.round(el.scrollTop - before),
				scrollTop: Math.round(el.scrollTop),
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
				atTop: el.scrollTop <= 0,
				atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
			};
		})()`, frameId)));
	}

	/**
	 * User action: annotations always follow the user's tab, never an agent's pin.
	 * The picker waits for a click, so the page must be on screen (#355); the
	 * tab is returned so the confirmation can name it.
	 */
	public async annotatePage(mode: 'element' | 'point' = 'element'): Promise<vscode.BrowserTab> {
		requireGrant();
		const tab = this.focusedTab ?? this.userTab;
		if (!tab) { throw new Error('Open a page in the integrated browser first.'); }
		if (!this.onScreen(tab)) {
			throw new Error(`"${plainInLabel(pageTitle(tab.title, tab.url), 60)}" is not on screen — bring its tab to the front, then add a marker.`);
		}
		await this._annotations.start(tab, mode);
		return tab;
	}

	/**
	 * Whether `tab` is in front of the user: the focused browser tab, or a
	 * browser editor visible in some group — `window.tabGroups` models no browser
	 * input, so it is a visible tab with `input: undefined` (the heuristic of
	 * `LoginWatcher.tabInFront`, erring towards "visible").
	 */
	public onScreen(tab: vscode.BrowserTab): boolean {
		// Chrome is a window of its own, beside the editor rather than under it.
		if (this.focusedTab === tab || tabSource.isChrome(tab)) { return true; }
		try { return vscode.window.tabGroups.all.some(group => group.activeTab !== undefined && group.activeTab.input === undefined); }
		catch { return true; }
	}

	/** The notes stored for the page the tab is showing, if it was ever annotated. */
	public annotationsOf(tab: vscode.BrowserTab): { url: string; records: readonly PageAnnotation[]; agentMade: ReadonlySet<string> } | undefined {
		return this._annotations.current(tab);
	}

	/** User action: removes every marker on the page the user's tab shows. */
	public async clearPageAnnotations(tab: vscode.BrowserTab): Promise<number> {
		requireGrant();
		const result = await this._annotations.remove(tab, undefined) as { removed?: number };
		return result.removed ?? 0;
	}

	/** User action from the chat's "+": the tab the chat resolved, on screen. */
	public async annotateTab(tab: vscode.BrowserTab, mode: 'element' | 'point' = 'element'): Promise<void> {
		requireGrant();
		await this._annotations.start(tab, mode);
	}

	public onDidChangeAnnotations(listener: (change: AnnotationChange) => void): vscode.Disposable {
		return new vscode.Disposable(this._annotations.onDidChange(listener).dispose);
	}

	/** User action (a chat tab closing): no caller, so no share or pin applies. */
	public removeAnnotations(tab: vscode.BrowserTab, ids: readonly string[]): Promise<void> {
		return this._annotations.removeEverywhere(tab, ids);
	}

	public async annotationsGet(tabId: string | undefined, ids: readonly string[], caller: CallerIdentity): Promise<unknown> {
		if (tabId?.startsWith('chrome-annotations:')) { return chromeAnnotationSessions.forTab(tabId, caller).get(tabId, ids, caller); }
		return this._withNamedTab(caller, tabId, async (_session, tab) => this._annotations.get(tab, ids));
	}

	public async annotationsAdd(tabId: string | undefined, selector: string, text: string, color: string | undefined, caller: CallerIdentity): Promise<unknown> {
		refuseValueProbe(selector);
		if (tabId?.startsWith('chrome-annotations:')) { return chromeAnnotationSessions.forTab(tabId, caller).add(tabId, selector, text, color, caller); }
		return this._withNamedTab(caller, tabId, (_session, tab) => this._annotations.add(tab, selector, text, color));
	}

	public async annotationsList(tabId: string | undefined, offset: number, limit: number, caller: CallerIdentity): Promise<unknown> {
		if (tabId?.startsWith('chrome-annotations:')) { return chromeAnnotationSessions.forTab(tabId, caller).list(tabId, offset, limit, caller); }
		return this._withNamedTab(caller, tabId, (_session, tab) => this._annotations.list(tab, offset, limit));
	}

	public async annotationsRemove(tabId: string | undefined, ids: readonly string[] | undefined, caller: CallerIdentity): Promise<unknown> {
		if (tabId?.startsWith('chrome-annotations:')) { return chromeAnnotationSessions.forTab(tabId, caller).remove(tabId, ids, caller); }
		return this._withNamedTab(caller, tabId, (_session, tab) => this._annotations.remove(tab, ids));
	}

	/**
	 * The next batch of the page's text to translate — `browser_text_segments`.
	 *
	 * The page half is `translateScript.ts`, which says why a segment is a
	 * distinct string rather than a node, and how a batch is settled.
	 */
	public async textSegments(
		maxChars: number,
		language: string | undefined,
		tabId: string | undefined,
		caller: CallerIdentity,
	): Promise<unknown> {
		// Required: it is what tells a new run from the one before, and a page
		// translated without it could never notice the language changing.
		if (!language) {
			throw new Error('`language` is required: the BCP 47 code of the language you translate into, such as "ru".');
		}
		requireLanguageCode(language);
		return this._withNamedTab(caller, tabId, session => evaluate(session,
			`${translatorSource}.segments(${literal(maxChars)}, ${literal(maxSingleSegment)}, ${literal(language)})`));
	}

	/**
	 * Writes translations into the page — `browser_replace_text`.
	 *
	 * `segments` is checked before anything reaches the page, so a refusal is a
	 * sentence the model reads rather than a page-side exception. The text goes
	 * in as `Text.data` and attribute values only, never as markup, so a
	 * translation cannot add an element or a script to the page.
	 */
	public async replaceText(
		documentId: string,
		language: string | undefined,
		segments: readonly Replacement[],
		tabId: string | undefined,
		caller: CallerIdentity,
	): Promise<unknown> {
		if (!documentId) {
			throw new Error('`documentId` is required: pass the one browser_text_segments returned.');
		}
		requireLanguageCode(language);
		return this._withNamedTab(caller, tabId, async session => {
			const result = await evaluate(session,
				`${translatorSource}.replace(${literal(documentId)}, ${literal(language)}, ${literal(segments)})`);
			const unknownIds: string[] = Array.isArray(result?.unknownIds) ? result.unknownIds : [];
			return {
				accepted: result?.accepted,
				applied: result?.applied,
				unknownIds: unknownIds.length > 0 ? unknownIds : undefined,
				note: unknownIds.length > 0
					? 'Some ids were never handed out on this page; only ids from browser_text_segments on the current document are accepted.'
					: undefined,
			};
		});
	}

	/** Puts the page's own text back — `browser_restore_text`. A reload does the same. */
	public async restoreText(tabId: string | undefined, caller: CallerIdentity): Promise<unknown> {
		return this._withNamedTab(caller, tabId, session =>
			evaluate(session, `${translatorSource}.restore()`));
	}

	/**
	 * {@link _withSession} on a tab the call names, for this call only.
	 *
	 * The translation prompt names the tab the user pressed the button on, and
	 * `browser_select_tab` would have done the same at a price: the pin outlives
	 * the request, so the assistant stopped following the user for the rest of
	 * its session because of one translation. A share still outranks the name —
	 * an assistant given one tab may not act on another — and is refused in
	 * words that say so, so the prompt's "stop when refused" has something to
	 * stop on.
	 */
	private async _withNamedTab<T>(
		caller: CallerIdentity,
		tabId: string | undefined,
		run: (session: TabSession, tab: vscode.BrowserTab) => Promise<T>,
	): Promise<T> {
		if (tabId === undefined) {
			return this._withSession(caller, run);
		}
		if (!tabId) {
			throw new Error('`tabId` is empty. Pass the tab id you were given, or leave the argument out.');
		}
		await this._settle();
		requireGrant();
		const { tab: own, paused, target } = this._resolveForCaller(caller);
		if (paused) {
			throw new Error(shareLostMessage(paused));
		}
		const open = tabSource.all ?? [];
		this._identify(open);
		const tab = open.find(candidate => this._tabIds.get(candidate) === tabId);
		if (!tab) {
			throw new Error(`No open browser tab has the id ${tabId} — it has been closed, or the window was reloaded. `
				+ 'Tell the user, and do not act on another tab instead.');
		}
		if (!target && !this._usableBy(tab, caller)) {
			throw this._ownedRefusal(tabId);
		}
		if (target && own && own !== tab) {
			throw new Error(`The user has given you browser tab ${this._idOf(own)}, and your tools act on that tab only, `
				+ `not on ${tabId}. Tell the user: they can give you ${tabId}, or stop sharing, from the AI Browser `
				+ 'status bar menu.');
		}
		this._noteTabUse(tab, caller);
		// Held before the open, for the reason given in `_withSession`.
		const release = this._hold(tab);
		try {
			return await run(await this._sessionFor(tab), tab);
		} finally {
			release();
		}
	}

	public async consoleOutput(clear: boolean, caller: CallerIdentity): Promise<unknown> {
		return this._withSession(caller, async session => {
			const lines = session.consoleLines.map(line => `[${line.level}] ${line.text}`);
			// The newest lines, as many as fit.
			let size = 0;
			let from = lines.length;
			while (from > 0 && size + lines[from - 1].length + 1 <= consoleOutputLimit) {
				size += lines[from - 1].length + 1;
				from--;
			}
			if (clear) {
				// Only what this answer carries: the older lines it leaves out stay
				// in our buffer for the next call. Cleared with the rest, they were
				// gone while the answer said only that they had been left out.
				session.clearConsole(from);
				// **The browser's copy too, not only ours.** `Runtime.enable` and
				// `Log.enable` replay what the page logged before a session attached
				// — `_enableDomains` relies on it — so clearing our buffer alone was
				// undone by the next session that opened on this tab (an eviction,
				// a dropped session, `navigate`'s retry), and the cleared errors came
				// back reading as new. Best effort and bounded: the buffer above is
				// already empty either way. Breaks-silently #216.
				await Promise.all([
					session.client.send('Runtime.discardConsoleEntries', {}, session.sessionId),
					session.client.send('Log.clear', {}, session.sessionId),
				].map(sent => withTimeout(sent, pageScrollTimeoutMs, 'console clear').catch(() => undefined)));
			}
			if (!lines.length) {
				return 'The console is empty. Note that only messages logged since this tab was first inspected are captured.';
			}
			const shown = lines.slice(from).join('\n');
			if (!from) {
				return shown;
			}
			return clear
				? `[${from} older lines left out to keep the answer small; they were not cleared — call again to read them]\n${shown}`
				: `[${from} older lines left out to keep the answer small]\n${shown}`;
		});
	}

	/**
	 * PNG of the page, for the user — Copy Screenshot. The model's capture is {@link captureFrames}.
	 *
	 * `captureBeyondViewport` is stated rather than left to the default, which
	 * has moved between Chromium versions — `false` is the visible area, `true`
	 * goes past it.
	 *
	 * For a full page the size is taken from `Page.getLayoutMetrics` and passed
	 * as an explicit `clip`. Relying on `captureBeyondViewport` alone is what
	 * produces the familiar half-captured screenshot, because the capture is
	 * still bounded by the viewport unless the region is spelled out.
	 */
	public async capture(
		fullPage: boolean,
		preferred?: vscode.BrowserTab,
	): Promise<{ png: Buffer; clipped: boolean; url: string | undefined }> {
		await this._settle();

		if (!preferred) {
			// A toolbar press with no browser tab focused: resolved the way any
			// user command is — no caller, so never paused. The session is the
			// cached one rather than a borrowed throwaway, since the tab resolved
			// here is the tools' own subject and a throwaway would cost its
			// console buffer the priming. Assistants never come through here:
			// `browser_screenshot` is `captureFrames`, which requires a caller.
			const tab = this._requireTab();
			// Held before the open, for the reason given in `_withSession`.
			const release = this._hold(tab);
			try {
				return await this._capture(tab, await this._sessionFor(tab), fullPage);
			} finally {
				release();
			}
		}

		// A tab named by the caller may not be the subject — the toolbar passes
		// the one in front of the user — and moving the cache to it would take the
		// subject tab's console buffer with it.
		return this._borrowSession(preferred, session => this._capture(preferred, session, fullPage));
	}

	/**
	 * The page as frames sized for a model — `browser_screenshot`.
	 *
	 * Not {@link capture}: that one is the user's PNG, at device resolution and
	 * in one piece, for the clipboard. A model takes an image in unchanged only
	 * up to about 1568 px and 1.15 megapixels, so the visible area is one JPEG
	 * scaled into that budget, and a full page is **one** PNG capture from the
	 * top, cut into frames here and each encoded as JPEG (`screenshotFrames.ts`,
	 * `pngDecode.ts`, `jpegEncode.ts`).
	 * Through `_withSession`, so the cached session primes the console and the
	 * hold covers the open.
	 *
	 * The page is measured again after the capture: it is taken from the top, and
	 * scrolling there can load more of a lazily built page. A change is reported
	 * rather than the frames being presented as covering a page that has since
	 * changed shape.
	 */
	public async captureFrames(fullPage: boolean, caller: CallerIdentity): Promise<{
		frames: { base64: string; mimeType: string; rect: Rect; pixels: { width: number; height: number } }[];
		/** Something the model should know about how faithful the frames are. */
		notes: string[];
		clipped: boolean;
		url: string | undefined;
	}> {
		return this._withSession(caller, async (session, tab) => {
			const notes: string[] = [];
			const shot = fullPage
				? await this._atTopOfPage(tab, session, async metrics => {
					const page = metrics.cssContentSize;
					if (!(page?.width > 0 && page?.height > 0)) {
						return undefined;
					}
					const plan = planFullPage(page, pixelRatios(metrics));
					const png = await screenshot(session, { format: 'png', captureBeyondViewport: true, clip: plan.clip });
					return { plan, png, height: Math.ceil(page.height) };
				})
				: undefined;

			if (!shot?.value) {
				// The visible area: no scroll, no resize, one JPEG straight from Chromium.
				if (fullPage) {
					notes.push('The browser reported no page size, so this is the visible area rather than the whole page.');
				}
				// On the scroll gate too: a full-page capture running on this tab
				// has it at the top, and reading the metrics then captured the top
				// of the page as "the visible area" (#214).
				return this._onScrollGate(tab, async () => {
					const metrics = await session.client.send('Page.getLayoutMetrics', {}, session.sessionId);
					const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
					if (!(viewport?.clientWidth > 0 && viewport?.clientHeight > 0)) {
						throw new Error('The browser reported no page size to capture');
					}
					const frame = planViewport({
						...visibleOrigin(metrics),
						width: viewport.clientWidth, height: viewport.clientHeight,
					}, pixelRatios(metrics));
					const base64 = await screenshot(session, { format: 'jpeg', quality: modelJpegQuality, captureBeyondViewport: false, clip: frame.clip });
					return { frames: [{ base64, mimeType: 'image/jpeg', rect: frame.rect, pixels: frame.pixels }], notes, clipped: false, url: tab.url };
				});
			}

			// Everything below runs after the scroll is back: decoding and encoding
			// take longer than the capture, and the user should not watch the page
			// sit at the top for them.
			const { plan, png, height: before } = shot.value;
			if (!shot.atTop) {
				notes.push('The page could not be scrolled to the top for the capture, so sticky or fixed elements may sit '
					+ 'where the page was scrolled to rather than where it opens.');
			}
			const image = await decodePng(Buffer.from(png, 'base64'));
			// The bands come from the image Chromium actually returned, which can
			// differ from the plan by a rounding pixel under fractional ratios.
			const bands = fitBands(plan.bands, plan.covered, image);
			const frames: { base64: string; mimeType: string; rect: Rect; pixels: { width: number; height: number } }[] = [];
			for (const band of bands) {
				const jpeg = encodeJpeg(rowsOf(image, band.top, band.pixels.height), modelJpegQuality);
				frames.push({ base64: jpeg.toString('base64'), mimeType: 'image/jpeg', rect: band.rect, pixels: band.pixels });
				// Encoding is synchronous and a frame takes tens of milliseconds;
				// yield between them so the extension host is not held for the set.
				await new Promise(resolve => setImmediate(resolve));
			}

			const after = (await session.client.send('Page.getLayoutMetrics', {}, session.sessionId))
				.cssContentSize?.height;
			const now = typeof after === 'number' && after > 0 ? Math.ceil(after) : before;
			if (now !== before) {
				notes.push(`The page changed height while it was captured (${before} → ${now} CSS px), `
					+ 'so the frames show it as it was measured before.');
			}
			return { frames, notes, clipped: plan.covered < Math.max(before, now), url: tab.url };
		});
	}

	/**
	 * Runs a full-page capture with the page scrolled to the top, then puts the
	 * scroll back. `run` gets the layout metrics as they are at the top.
	 *
	 * `captureBeyondViewport` renders the document from where it is scrolled to:
	 * measured in Chrome on a page scrolled to 2500 px, a `position: sticky`
	 * header came back 2500 px down the image and a `position: fixed` badge at
	 * the bottom of that view — over the footer, in the case that was reported.
	 * From the top both are where the page itself puts them when it opens.
	 *
	 * - **Serialised per tab.** Two captures overlapping on one tab — an
	 *   assistant's and a toolbar press — each read the scroll, and whichever
	 *   restored first moved the page under the other's capture, or the second
	 *   read the top as "where the user was" and left them there. Sessions and
	 *   holds do not order this; the gate does. A wait for a previous capture is
	 *   bounded, the shape of `repairQueueWaitMs`: a page that stopped answering
	 *   must not queue every later capture behind it.
	 * - **The page is asked, and its answer checked.** `scrollTo` is the page's
	 *   to replace, so a throw comes back as a *successful* CDP reply with
	 *   `exceptionDetails` (breaks-silently #48) — `evaluate` reads that — and a
	 *   call that never answers is bounded. A replaced `window.scrollTo` falls
	 *   back to the document scroller's own. Where the scroll still did not take
	 *   effect, judged from the metrics rather than from the call, the capture
	 *   goes ahead and `atTop` says so.
	 * - **`behavior: 'instant'`**, or a page with `scroll-behavior: smooth`
	 *   animates and the capture lands mid-scroll.
	 * - **Restored only on the same document.** Back to the same offsets, which
	 *   is right for an ordinary page and wrong for one that loads content above
	 *   when scrolled to the top (a chat history), where it lands elsewhere —
	 *   known, not handled. A document that changed in between (a navigation
	 *   racing the capture) is not scrolled at all: it should open at its top.
	 * - A page already at the top is not touched.
	 */
	private async _atTopOfPage<T>(
		tab: vscode.BrowserTab,
		session: TabSession,
		run: (metrics: any) => Promise<T>,
	): Promise<{ value: T; atTop: boolean }> {
		return this._onScrollGate(tab, async () => {
			const metrics = await session.client.send('Page.getLayoutMetrics', {}, session.sessionId);
			const { x, y } = scrollPosition(metrics);
			if (x === 0 && y === 0) {
				return { value: await run(metrics), atTop: true };
			}

			// `window.scrollTo` first, and the document's own scroller where the
			// page replaced that with something that throws or ignores the call.
			// Either is the page's to break; the metrics below are what decide.
			const scrollTo = (left: number, top: number) => withTimeout(
				evaluate(session, `(() => {
					const to = { left: ${left}, top: ${top}, behavior: 'instant' };
					try { window.scrollTo(to); } catch { }
					if (scrollX !== ${left} || scrollY !== ${top}) {
						Element.prototype.scrollTo.call(document.scrollingElement || document.documentElement, to);
					}
				})()`),
				pageScrollTimeoutMs, 'The page did not answer a scroll');
			const loader = await documentLoader(session);
			await scrollTo(0, 0).catch(() => undefined);
			try {
				const top = await session.client.send('Page.getLayoutMetrics', {}, session.sessionId);
				const at = scrollPosition(top);
				return { value: await run(top), atTop: at.x === 0 && at.y === 0 };
			} finally {
				if (loader !== undefined && loader === await documentLoader(session)) {
					await scrollTo(x, y).catch(() => undefined);
				}
			}
		});
	}

	/**
	 * Runs `work` in turn with every other capture on this tab.
	 *
	 * A full-page capture scrolls the page to the top and back, so anything else
	 * that reads the scroll — another full-page capture, and a visible-area one,
	 * which captures "what the user sees" — has to wait for it. The wait for the
	 * previous turn is bounded (`scrollGateWaitMs`): a page that stopped
	 * answering must not queue every later capture behind it.
	 */
	private _onScrollGate<T>(tab: vscode.BrowserTab, work: () => Promise<T>): Promise<T> {
		const previous = this._scrollGates.get(tab);
		const turn = (async () => {
			if (previous) {
				await withTimeout(previous, scrollGateWaitMs, 'gate').catch(() => undefined);
			}
			return work();
		})();
		this._scrollGates.set(tab, turn.catch(() => undefined));
		return turn;
	}

	/**
	 * A session for one read of a tab that is not the subject of the tools.
	 *
	 * The cached session is reused when it already belongs to this tab;
	 * otherwise a throwaway one is opened rather than the cache being *moved*.
	 * `_sessionFor` drops whatever it was holding, and for a screenshot that is
	 * destructive in a way it is not for the tools: it threw away the console
	 * buffer the assistant was collecting, for a picture of a different page.
	 * (It also disarmed the shared tab's title marker, whose registration went
	 * with the session — that half is gone with the marker itself, and the
	 * console half is reason enough on its own.)
	 *
	 * The throwaway session is the same shape as the picker's: opened, used,
	 * disposed, and never cached.
	 */
	private async _borrowSession<T>(
		tab: vscode.BrowserTab,
		run: (session: TabSession) => Promise<T>,
	): Promise<T> {
		const cached = this._sessions.get(tab);
		if (cached && !cached.isClosed) {
			// Held like any other use. A borrow deliberately does not `_touch` — a
			// one-off read should not reorder the queue — so without this the
			// session keeps its old position and a fourth tab opening one mid
			// capture drops it under the caller, who is a *user* here: the toolbar
			// button answers "Could not capture the page: CDP client disposed", in
			// an error toast, which pauses the very tab just captured.
			const release = this._hold(tab);
			try {
				return await run(cached);
			} finally {
				release();
			}
		}
		// **Watched for the tab closing, from the open to the end of the work.**
		// Closing a tab does not close its CDP session, and `send` has no timeout,
		// so a toolbar screenshot of a tab closed mid-handshake or mid-capture
		// waited for an answer that was never coming — the progress item and the
		// channel both stayed up for good. Aborting ends the open; disposing the
		// session rejects whatever the capture is waiting on.
		const abort = new AbortController();
		let session: TabSession | undefined;
		let watch: vscode.Disposable | undefined;
		try {
			watch = tabSource.onDidClose(gone => {
				if (gone === tab) {
					abort.abort();
					session?.dispose();
				}
			});
		} catch {
			// Proposal-gated; a host without the grant has no tab to borrow.
		}
		try {
			session = await TabSession.open(tab, abort.signal);
			if (abort.signal.aborted) {
				throw new Error('The browser tab was closed.');
			}
			return await run(session);
		} catch (err) {
			throw abort.signal.aborted ? new Error('The browser tab was closed.') : err;
		} finally {
			watch?.dispose();
			session?.dispose();
		}
	}

	/** The capture itself. `Page` is already enabled by {@link TabSession}, so nothing does it here. */
	private async _capture(
		tab: vscode.BrowserTab,
		session: TabSession,
		fullPage: boolean,
	): Promise<{ png: Buffer; clipped: boolean; url: string | undefined }> {
		// From the top, for the sticky-header reason given at `_atTopOfPage`.
		return fullPage
			? (await this._atTopOfPage(tab, session, metrics => this._captureFrom(tab, session, metrics))).value
			: this._onScrollGate(tab, () => this._captureFrom(tab, session, undefined));
	}

	/** `metrics` for a full page, as `_atTopOfPage` read them; `undefined` for the visible area. */
	private async _captureFrom(
		tab: vscode.BrowserTab,
		session: TabSession,
		metrics: any,
	): Promise<{ png: Buffer; clipped: boolean; url: string | undefined }> {
		const fullPage = metrics !== undefined;
		let clip: object | undefined;
		let clipped = false;

		if (fullPage) {
			const size = metrics.cssContentSize ?? metrics.contentSize;
			const width = Math.ceil(size?.width ?? 0);
			const height = Math.ceil(size?.height ?? 0);
			// The clip is in DIP, which is CSS × browser zoom (breaks-silently #202).
			const { zoom, device } = pixelRatios(metrics);

			if (width > 0 && height > 0) {
				// Chromium cannot allocate a texture beyond roughly this, and past
				// it the capture comes back wrong rather than failing. Better a
				// truthfully clipped image than a broken one.
				//
				// **The limit is on the image Chromium produces, which is in device
				// pixels** — the clip times the device scale factor, since `scale` is
				// 1. It used to be applied to the clip, in DIP, so on a retina screen
				// every page taller than 8192 CSS px came back with each row past
				// 16384 repeating the top of the page, `clipped: false`, and "copied"
				// in the status bar. Width is bounded the same way. Breaks-silently
				// #215.
				const limit = textureLimitPx;
				const perCss = device;
				clipped = height * perCss > limit || width * perCss > limit;
				clip = {
					x: 0, y: 0,
					width: Math.min(width * zoom, limit * zoom / perCss),
					height: Math.min(height * zoom, limit * zoom / perCss),
					scale: 1,
				};
			}
		}

		const { data } = await session.client.send('Page.captureScreenshot', {
			format: 'png',
			captureBeyondViewport: fullPage,
			...(!fullPage ? { fromSurface: false } : {}),
			...(clip ? { clip } : {}),
		}, session.sessionId);

		if (typeof data !== 'string' || data.length === 0) {
			throw new Error(fullPage
				? 'The browser returned an empty screenshot. The page may be too large to capture in one image.'
				: 'The browser returned an empty screenshot');
		}
		return { png: Buffer.from(data, 'base64'), clipped, url: tab.url };
	}

	public async click(selector: string, frameId: string | undefined, caller: CallerIdentity, options?: PointerOptions, signal?: AbortSignal): Promise<unknown> {
		refuseValueProbe(selector);
		requireFrameId(frameId);
		return this._withSession(caller, (session, tab) => this._onScrollGate(tab,
			() => session.actions.pointerAction('click', selector, frameId, options, signal)));
	}

	public async hover(selector: string, frameId: string | undefined, caller: CallerIdentity, smooth?: boolean, signal?: AbortSignal, humanize?: boolean): Promise<unknown> {
		refuseValueProbe(selector);
		requireFrameId(frameId);
		return this._withSession(caller, (session, tab) => this._onScrollGate(tab,
			() => session.actions.pointerAction('hover', selector, frameId, { smooth, humanize }, signal)));
	}

	public async press(selector: string, key: string, frameId: string | undefined, caller: CallerIdentity, signal?: AbortSignal): Promise<unknown> {
		refuseValueProbe(selector);
		requireFrameId(frameId);
		return this._withSession(caller, (session, tab) => this._onScrollGate(tab,
			() => session.actions.keyboardAction(selector, frameId, { key }, signal)));
	}

	public async type(selector: string, text: string, frameId: string | undefined, caller: CallerIdentity, signal?: AbortSignal, humanize?: boolean): Promise<unknown> {
		refuseValueProbe(selector);
		requireFrameId(frameId);
		return this._withSession(caller, (session, tab) => this._onScrollGate(tab,
			() => session.actions.keyboardAction(selector, frameId, { text }, signal, humanize)));
	}

	public async drag(selector: string, targetSelector: string, frameId: string | undefined, caller: CallerIdentity, smooth?: boolean, signal?: AbortSignal, humanize?: boolean): Promise<unknown> {
		refuseValueProbe(selector);
		refuseValueProbe(targetSelector);
		requireFrameId(frameId);
		return this._withSession(caller, (session, tab) => this._onScrollGate(tab,
			() => session.actions.drag(selector, targetSelector, frameId, smooth, signal, humanize)));
	}

	/**
	 * Sets a field the way typing would, so the page's framework sees it.
	 *
	 * **A plain `el.value = …` does not reach React**, and it reported success
	 * anyway. React installs its own `value` setter on each controlled input
	 * and keeps a tracker of the last value it saw; assigning through that
	 * setter updates the tracker, so the `input` event that follows looks like
	 * no change, `onChange` never runs, and the next render puts the old value
	 * back — while the tool answered `filled input`. The setter on the element's
	 * *prototype* is the browser's own and leaves the tracker behind, which is
	 * what makes the event count. Same for `textarea` and `select`.
	 *
	 * The other shapes each need their own answer rather than the same one:
	 *
	 * - a `select` is refused unless an option has that value, or the field is
	 *   silently left empty;
	 * - a checkbox or radio is refused — `value` there is the submitted string,
	 *   not whether it is ticked, and `browser_click` is what toggles it;
	 * - a contenteditable gets `insertText`, which fires `beforeinput`/`input`
	 *   the way editors built on them expect, falling back to `textContent`;
	 * - a form-associated custom element (`sl-input`, `ion-input`) goes through
	 *   its own `value` setter, which is its contract — its inner input is in a
	 *   shadow root no selector can reach, so refusing it made such forms
	 *   unfillable;
	 * - and the result is read back. A field that kept its old value (a `number`
	 *   input given text, a `maxlength`) is a failure; one that *reshaped* the
	 *   value (a mask, a trimmed email, a lowercased colour) took it, and says
	 *   what it now reads rather than being reported as a failure.
	 */
	public async fill(selector: string, value: string, frameId: string | undefined, caller: CallerIdentity, signal?: AbortSignal): Promise<unknown> {
		refuseValueProbe(selector);
		requireFrameId(frameId);
		return this._withSession(caller, async session => {
			const result = await session.actions.onElement(selector, frameId, `function(value) {
				const el = this;
				const tag = el.tagName.toLowerCase();
				el.focus();
				if (el.isContentEditable) {
					const range = document.createRange();
					range.selectNodeContents(el);
					const selection = window.getSelection();
					selection.removeAllRanges();
					selection.addRange(range);
					if (!document.execCommand('insertText', false, value)) {
						el.textContent = value;
						el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
					}
					return 'filled ' + tag;
				}
				const type = (el.getAttribute('type') || '').toLowerCase();
				if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
					throw new Error('This is a ' + type + ': its value is not whether it is checked. Use browser_click to toggle it.');
				}
				const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype
					: tag === 'select' ? HTMLSelectElement.prototype
					: tag === 'input' ? HTMLInputElement.prototype
					: undefined;
				if (!proto) {
					// A form-associated custom element — sl-input, ion-input,
					// md-outlined-text-field — exposes its own value setter,
					// and its inner input sits in a shadow root no selector can
					// reach. Its setter is the host's contract, so it is the
					// one to call.
					//
					// **Only a custom element**, whose tag always has a hyphen.
					// 'value' in el alone also admits <button>, <li>,
					// <option>, <meter>, <progress>, <data> and <output>, so a
					// selector that missed the field by one element was
					// "filled button" with nothing on screen changed — a false
					// success the model moved on from (breaks-silently #210).
					if (!tag.includes('-') || !('value' in el)) {
						throw new Error('A <' + tag + '> is not a field. Give the selector of an input, textarea, select or contenteditable.');
					}
					el.value = value;
					el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
					el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
					return 'filled ' + tag;
				}
				if (tag === 'select' && ![...el.options].some(option => option.value === value)) {
					throw new Error('No option has the value ' + JSON.stringify(value) + '. Options: '
						+ [...el.options].map(option => JSON.stringify(option.value)).join(', '));
				}
				const before = el.value;
				Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
				// Frameworks listen for these, not for the assignment.
				el.dispatchEvent(new Event('input', { bubbles: true }));
				el.dispatchEvent(new Event('change', { bubbles: true }));
				if (el.value === value) {
					return 'filled ' + tag;
				}
				// Emptied by a value it would not take: a number input given text,
				// a date input given 12/31/2024. Whatever the field held before is
				// gone, so it is put back — and the call is a refusal, not the
				// "reformatted" success it read as when the field had held something.
				// **Only the types the browser itself sanitises to ''.** A text box
				// that empties itself has usually *taken* the value — a tag input
				// turning "tag1," into a chip — and putting the old text back there
				// undid a fill the page had accepted.
				const sanitising = ['number', 'date', 'datetime-local', 'month', 'week', 'time'];
				const rejected = tag === 'input' && sanitising.includes(type) && el.value === '' && value !== '';
				if (rejected && before !== '') {
					Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, before);
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				}
				// The rest is worded in the extension, which knows which fields are
				// secret: the attributes travel, and the value with them.
				return {
					tag, now: el.value, unchanged: el.value === before, rejected, restored: rejected && before !== '', maxLength: el.maxLength,
					attributes: { type: el.getAttribute('type') ?? '', name: el.getAttribute('name') ?? '',
						id: el.getAttribute('id') ?? '', autocomplete: el.getAttribute('autocomplete') ?? '' },
				};
			}`, [value], signal);
			if (typeof result === 'string') {
				return result;
			}
			// Refused only when nothing changed. A field that *reshapes* what it is
			// given — a phone or card mask, an email input trimming spaces, a
			// colour input lowercasing — has taken it, and calling that a failure
			// sent a model back to fill a finished form, firing its handlers twice.
			// **A secret is not read back to the model** (#211), by the same rule as
			// the markup: by type alone, a toggled password field or a one-time
			// code that rejected the value was echoed in the error.
			const shown = isSecretField(result.attributes) ? '(a hidden value)' : JSON.stringify(result.now);
			if (result.rejected) {
				const type = String(result.attributes?.type ?? '').toLowerCase();
				const format = type === 'date' ? ' A date input takes YYYY-MM-DD.'
					: type === 'datetime-local' ? ' A datetime-local input takes YYYY-MM-DDTHH:MM.'
						: type === 'time' ? ' A time input takes HH:MM.'
							: type === 'number' || type === 'range' ? ' A number input takes digits only.'
								: '';
				throw new Error('The field rejected the value and emptied itself'
					+ (result.restored ? '; what it held before was put back.' : '.') + format);
			}
			if (result.unchanged) {
				throw new Error('The field did not take the value: it still reads ' + shown
					+ (result.maxLength > 0 ? ' (maxlength ' + result.maxLength + ')' : '') + '.');
			}
			return 'filled ' + result.tag + '; the field reformatted it and now reads ' + shown;
		});
	}

	/**
	 * Waits until a selector or a piece of text shows up — `browser_wait_for`.
	 *
	 * **Polled from here, one synchronous check per round, never by a loop in
	 * the page.** The loop it replaced slept on the page's own `setTimeout`, and
	 * a document that runs no timers ran its check once and never again: a frame
	 * sandboxed without `allow-scripts` — an HTML mail or document preview that
	 * its parent writes into — answers `Runtime.evaluate` and resolves promises,
	 * but a timer scheduled from an evaluate never fires (measured, Chrome 153).
	 * The call then timed out over text on screen, and left its evaluate pending
	 * for the life of the frame. Frames made that a normal target. Polling from
	 * the host also retires what the page loop needed to be stopped: a page with
	 * frozen or fake timers (#212) and a loop left reading `innerText` after the
	 * call had ended (#311) no longer have anything to act on.
	 *
	 * **A navigation during the wait is not a failure.** A round that meets a
	 * replaced document (`documentReplaced`, which also covers a frame between
	 * documents or whose session ended) counts as "not yet", and the next round
	 * looks the document up again — the frame's too, when one was named. The
	 * deadline and a cancellation from the client end the wait even while a
	 * round is unanswered: a page busy in a long task holds an evaluate for as
	 * long as it likes, and the hold in `_withSession` must not be kept with it.
	 */
	public async waitFor(
		selector: string | undefined,
		text: string | undefined,
		timeoutMs: number,
		frameId: string | undefined,
		caller: CallerIdentity,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (!selector && !text) {
			throw new Error('Give either a selector or a text to wait for.');
		}
		refuseValueProbe(selector);
		requireFrameId(frameId);
		const timedOut = 'Timed out waiting for ' + (selector ?? '') + (selector && text ? ' and ' : '')
			+ (text ? JSON.stringify(text) : '');
		const check = `(() => {
			const sel = ${literal(selector)};
			const needle = ${literal(text)};
			if (sel && !document.querySelector(sel)) { return false; }
			// No body yet is "not yet": a round after a navigation can land in the
			// new document before its body is parsed (#322).
			if (needle && !(document.body?.innerText ?? '').includes(needle)) { return false; }
			return true;
		})()`;

		return this._withSession(caller, async session => {
			const deadline = Date.now() + Math.max(0, timeoutMs);
			let release: () => void = () => undefined;
			// Settles when the call is over regardless of the page: past the
			// deadline (with a little grace for the round in flight) or cancelled.
			const ended = new Promise<'timeout' | 'cancelled'>(resolve => {
				const timer = setTimeout(() => resolve('timeout'),
					Math.min(Math.max(0, timeoutMs) + waitForGraceMs, maxTimerMs));
				const onAbort = () => resolve('cancelled');
				signal?.addEventListener('abort', onAbort, { once: true });
				release = () => {
					clearTimeout(timer);
					signal?.removeEventListener('abort', onAbort);
				};
			});
			const settle = (outcome: 'timeout' | 'cancelled'): never => {
				throw new Error(outcome === 'cancelled' ? 'The wait was cancelled.' : timedOut);
			};
			try {
				for (;;) {
					if (signal?.aborted) {
						settle('cancelled');
					}
					const round = evaluate(session, check, frameId).then(
						found => found === true,
						err => {
							if (documentReplaced(err)) {
								return false;
							}
							throw err;
						});
					round.catch(() => { /* answered below, or abandoned with the call */ });
					const outcome = await Promise.race([round, ended]);
					if (outcome === true) {
						return 'found';
					}
					if (outcome === 'timeout' || outcome === 'cancelled') {
						settle(outcome);
					}
					if (Date.now() >= deadline) {
						settle('timeout');
					}
					const paused = await Promise.race([
						new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), waitForPollMs)),
						ended,
					]);
					if (paused) {
						settle(paused);
					}
				}
			} finally {
				release();
			}
		});
	}

	public dispose(): void {
		// First, so an open still in flight sees it when it lands.
		this._disposed = true;
		this._annotations.dispose();

		// Anything queued for a session slot is released rather than left to its
		// timeout: the open it is waiting for will refuse the moment it lands, and
		// a pending timer would hold the host's event loop for `_slotWaitMs` after
		// the window is done with this controller.
		this._notifySlots();

		this._tabWatch?.dispose();
		this._focusWatch?.dispose();
		this._onDidChangeShare.dispose();
		for (const aborts of this._openAborts.values()) {
			for (const abort of aborts) {
				abort.abort();
			}
		}
		this._dropSession();
	}
}
