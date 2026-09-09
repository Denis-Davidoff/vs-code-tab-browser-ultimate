/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CDPClient } from './cdp';
import { extractElementData, renderElementMarkdown } from './elementContext';

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
 * A CDP session held open for one tab.
 *
 * Console capture is the reason this is cached rather than opened per call:
 * messages only arrive while something is attached, so a session created on
 * demand would report an empty log for everything that happened before.
 */
class TabSession {

	private readonly _console: ConsoleLine[] = [];
	private readonly _subscriptions: vscode.Disposable[] = [];

	private constructor(
		public readonly client: CDPClient,
		public readonly sessionId: string,
	) { }

	public static async open(tab: vscode.BrowserTab): Promise<TabSession> {
		const client = new CDPClient(await tab.startCDPSession());
		try {
			const sessionId = await client.attachToPage();
			const session = new TabSession(client, sessionId);
			await session._enableDomains();
			return session;
		} catch (err) {
			client.dispose();
			throw err;
		}
	}

	private async _enableDomains(): Promise<void> {
		await this.client.send('DOM.enable', {}, this.sessionId);
		await this.client.send('CSS.enable', {}, this.sessionId);
		await this.client.send('Runtime.enable', {}, this.sessionId);
		await this.client.send('Log.enable', {}, this.sessionId);

		this._subscriptions.push(this.client.on('Runtime.consoleAPICalled', (params: any) => {
			const text = (params.args ?? [])
				.map((arg: any) => arg.value ?? arg.description ?? arg.unserializableValue ?? '')
				.join(' ');
			this._record(params.type ?? 'log', text);
		}));

		this._subscriptions.push(this.client.on('Log.entryAdded', (params: any) => {
			this._record(params.entry?.level ?? 'log', params.entry?.text ?? '');
		}));

		this._subscriptions.push(this.client.on('Runtime.exceptionThrown', (params: any) => {
			const details = params.exceptionDetails;
			this._record('error', details?.exception?.description ?? details?.text ?? 'Uncaught exception');
		}));
	}

	private _record(level: string, text: string): void {
		this._console.push({ level, text });
		if (this._console.length > consoleLimit) {
			this._console.splice(0, this._console.length - consoleLimit);
		}
	}

	public get consoleLines(): readonly ConsoleLine[] {
		return this._console;
	}

	public clearConsole(): void {
		this._console.length = 0;
	}

	public dispose(): void {
		for (const subscription of this._subscriptions) {
			subscription.dispose();
		}
		this.client.dispose();
	}
}

/** Result of a page-side evaluation, already unwrapped. */
async function evaluate(session: TabSession, expression: string): Promise<any> {
	const { result, exceptionDetails } = await session.client.send('Runtime.evaluate', {
		expression,
		returnByValue: true,
		awaitPromise: true,
	}, session.sessionId);

	if (exceptionDetails) {
		throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'Evaluation failed');
	}
	return result?.value;
}

/** Embeds a value as a JS literal, so a selector cannot break out of the expression. */
function literal(value: unknown): string {
	return JSON.stringify(value ?? null);
}

export class BrowserController implements vscode.Disposable {

	private _session: TabSession | undefined;
	private _sessionTab: vscode.BrowserTab | undefined;

	/** Last element the user picked, so a follow-up question does not re-prompt. */
	private _selectedElement: string | undefined;

	/**
	 * The active tab, or a refusal the model can act on.
	 *
	 * Every tool goes through here, which is why the wording matters: this is the
	 * text the assistant sees when there is nothing to drive.
	 */
	private _requireTab(): vscode.BrowserTab {
		if (!('browserTabs' in vscode.window)) {
			throw new Error(
				'The integrated browser is unavailable in this editor. It needs the `browser` API proposal; ' +
				'the user can enable it with the "AI Browser: Enable Integrated Browser API" command.');
		}

		const tab = vscode.window.activeBrowserTab;
		if (!tab) {
			throw new Error(
				'No browser tab is open. Ask the user to open a page, or call `browser_navigate` with a URL first.');
		}
		return tab;
	}

	private async _withSession(): Promise<TabSession> {
		const tab = this._requireTab();

		if (this._session && this._sessionTab === tab) {
			return this._session;
		}

		// A different tab: the old session's console belongs to a page that is
		// no longer the subject.
		this._session?.dispose();
		this._session = await TabSession.open(tab);
		this._sessionTab = tab;
		return this._session;
	}

	public async state(): Promise<unknown> {
		if (!('browserTabs' in vscode.window)) {
			return {
				available: false,
				reason: 'The `browser` API proposal is not enabled. Ask the user to run '
					+ '"AI Browser: Enable Integrated Browser API".',
			};
		}

		const tabs = vscode.window.browserTabs ?? [];
		const active = vscode.window.activeBrowserTab;
		return {
			available: true,
			openTabs: tabs.length,
			active: active ? { url: active.url, title: active.title } : undefined,
			hasSelectedElement: this._selectedElement !== undefined,
		};
	}

	/**
	 * Opens a URL, reusing the active tab when there is one.
	 *
	 * `file:` is refused. Otherwise an agent can point the browser at any file on
	 * disk and then read it back with `browser_text` — turning a browser tool
	 * into an unrestricted file reader.
	 */
	public async navigate(rawUrl: string): Promise<unknown> {
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

		if (!('browserTabs' in vscode.window)) {
			throw new Error('The integrated browser is unavailable in this editor. Ask the user to run '
				+ '"AI Browser: Enable Integrated Browser API".');
		}

		// A new tab means a new page: the cached session and the picked element
		// both describe something that is gone.
		this._session?.dispose();
		this._session = undefined;
		this._sessionTab = undefined;
		this._selectedElement = undefined;

		const tab = await vscode.window.openBrowserTab(parsed.toString(), { preserveFocus: true });
		return { url: tab.url, title: tab.title };
	}

	/** A compact list of things worth interacting with, for orientation. */
	public async snapshot(): Promise<unknown> {
		const session = await this._withSession();
		const value = await evaluate(session, `(() => {
			const out = [];
			const nodes = document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"]');
			for (const el of nodes) {
				const rect = el.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) { continue; }
				const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().slice(0, 80);
				let selector = el.tagName.toLowerCase();
				if (el.id) { selector = '#' + CSS.escape(el.id); }
				else if (el.getAttribute('name')) { selector += '[name=' + JSON.stringify(el.getAttribute('name')) + ']'; }
				out.push({ tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || undefined, label, selector });
				if (out.length >= 150) { break; }
			}
			return { url: location.href, title: document.title, elements: out };
		})()`);
		return value;
	}

	/**
	 * Asks the user to click an element and returns its full context.
	 *
	 * This one blocks on a human, so its description tells the model to only
	 * call it after asking. The result is remembered for
	 * {@link selectedElement}.
	 */
	public async inspectElement(timeoutMs: number): Promise<unknown> {
		const tab = this._requireTab();
		const client = new CDPClient(await tab.startCDPSession());
		let sessionId: string | undefined;

		try {
			sessionId = await client.attachToPage();
			await client.send('DOM.enable', {}, sessionId);
			await client.send('CSS.enable', {}, sessionId);
			await client.send('Overlay.enable', {}, sessionId);
			await client.send('Overlay.setInspectMode', {
				mode: 'searchForNode',
				highlightConfig: { showInfo: true, contentColor: { r: 111, g: 168, b: 220, a: 0.45 } },
			}, sessionId);

			const cts = new vscode.CancellationTokenSource();
			const timer = setTimeout(() => cts.cancel(), timeoutMs);
			try {
				const { backendNodeId } = await client.once('Overlay.inspectNodeRequested', cts.token);
				const data = await extractElementData(client, sessionId, backendNodeId);
				this._selectedElement = renderElementMarkdown(data, tab.url);
				return this._selectedElement;
			} catch (err) {
				if (err instanceof vscode.CancellationError) {
					throw new Error(
						'The user did not pick an element in time. Ask them to click one, then call this again.');
				}
				throw err;
			} finally {
				clearTimeout(timer);
				cts.dispose();
			}
		} finally {
			if (sessionId !== undefined) {
				await client.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }, sessionId)
					.catch(() => { /* navigated away or detached */ });
			}
			client.dispose();
		}
	}

	public async selectedElement(): Promise<unknown> {
		if (!this._selectedElement) {
			throw new Error(
				'No element has been picked yet. Call `browser_inspect_element` after asking the user to click one.');
		}
		return this._selectedElement;
	}

	public async html(selector: string | undefined): Promise<unknown> {
		const session = await this._withSession();
		return evaluate(session, `(() => {
			const sel = ${literal(selector)};
			const el = sel ? document.querySelector(sel) : document.documentElement;
			if (!el) { throw new Error('No element matches ' + sel); }
			return el.outerHTML;
		})()`);
	}

	public async text(selector: string | undefined): Promise<unknown> {
		const session = await this._withSession();
		return evaluate(session, `(() => {
			const sel = ${literal(selector)};
			const el = sel ? document.querySelector(sel) : document.body;
			if (!el) { throw new Error('No element matches ' + sel); }
			return (el.innerText || el.textContent || '').trim();
		})()`);
	}

	public async consoleOutput(clear: boolean): Promise<unknown> {
		const session = await this._withSession();
		const lines = session.consoleLines.map(line => `[${line.level}] ${line.text}`);
		if (clear) {
			session.clearConsole();
		}
		return lines.length
			? lines.join('\n')
			: 'The console is empty. Note that only messages logged since this tab was first inspected are captured.';
	}

	/**
	 * PNG of the page.
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
	public async capture(fullPage: boolean): Promise<{ png: Buffer; clipped: boolean }> {
		const session = await this._withSession();
		await session.client.send('Page.enable', {}, session.sessionId);

		let clip: object | undefined;
		let clipped = false;

		if (fullPage) {
			const metrics = await session.client.send('Page.getLayoutMetrics', {}, session.sessionId);
			const size = metrics.cssContentSize ?? metrics.contentSize;
			const width = Math.ceil(size?.width ?? 0);
			const height = Math.ceil(size?.height ?? 0);

			if (width > 0 && height > 0) {
				// Chromium cannot allocate a texture beyond roughly this, and past
				// it the capture comes back blank rather than failing. Better a
				// truthfully clipped image than an empty one.
				const limit = 16384;
				clipped = height > limit;
				clip = { x: 0, y: 0, width, height: Math.min(height, limit), scale: 1 };
			}
		}

		const { data } = await session.client.send('Page.captureScreenshot', {
			format: 'png',
			captureBeyondViewport: fullPage,
			...(clip ? { clip } : {}),
		}, session.sessionId);

		if (typeof data !== 'string' || data.length === 0) {
			throw new Error(fullPage
				? 'The browser returned an empty screenshot. The page may be too large to capture in one image.'
				: 'The browser returned an empty screenshot');
		}
		return { png: Buffer.from(data, 'base64'), clipped };
	}

	/** URL of the tab a screenshot came from, for naming the file. */
	public get activeUrl(): string | undefined {
		return ('browserTabs' in vscode.window) ? vscode.window.activeBrowserTab?.url : undefined;
	}

	public async click(selector: string): Promise<unknown> {
		const session = await this._withSession();
		return evaluate(session, `(() => {
			const el = document.querySelector(${literal(selector)});
			if (!el) { throw new Error('No element matches ' + ${literal(selector)}); }
			el.scrollIntoView({ block: 'center' });
			el.click();
			return 'clicked ' + (el.tagName.toLowerCase());
		})()`);
	}

	public async fill(selector: string, value: string): Promise<unknown> {
		const session = await this._withSession();
		return evaluate(session, `(() => {
			const el = document.querySelector(${literal(selector)});
			if (!el) { throw new Error('No element matches ' + ${literal(selector)}); }
			el.focus();
			if (el.isContentEditable) {
				el.textContent = ${literal(value)};
			} else {
				el.value = ${literal(value)};
			}
			// Frameworks listen for these, not for the assignment.
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
			return 'filled ' + el.tagName.toLowerCase();
		})()`);
	}

	/** Polls in the page until a selector or a piece of text shows up. */
	public async waitFor(
		selector: string | undefined,
		text: string | undefined,
		timeoutMs: number,
	): Promise<unknown> {
		if (!selector && !text) {
			throw new Error('Give either a selector or a text to wait for.');
		}

		const session = await this._withSession();
		return evaluate(session, `(async () => {
			const sel = ${literal(selector)};
			const needle = ${literal(text)};
			const deadline = Date.now() + ${Math.max(0, timeoutMs)};
			const found = () => {
				if (sel && !document.querySelector(sel)) { return false; }
				if (needle && !(document.body.innerText || '').includes(needle)) { return false; }
				return true;
			};
			while (Date.now() < deadline) {
				if (found()) { return 'found'; }
				await new Promise(r => setTimeout(r, 100));
			}
			throw new Error('Timed out waiting for ' + (sel || '') + (sel && needle ? ' and ' : '') + (needle ? JSON.stringify(needle) : ''));
		})()`);
	}

	public dispose(): void {
		this._session?.dispose();
		this._session = undefined;
		this._sessionTab = undefined;
	}
}
