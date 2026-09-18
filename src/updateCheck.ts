/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { refuse } from './notify';
import { isBrowserApiGranted } from './proposedApi';
import { dueForCheck, isNewerVersion, readManifestVersion } from './updateVersion';

/**
 * Tells the user when the repository is ahead of the build they are running.
 *
 * This extension declares API proposals, so it is not on the Marketplace and is
 * hand-installed from a VSIX — which means **nothing updates it and nothing
 * announces a release**. The promo listing watches for releases too, but only
 * for the people who found the extension through it; someone who installed the
 * VSIX directly has never had any signal at all.
 *
 * The version is read from the repository's root `package.json` on `main`,
 * because that is the one file every release necessarily touches.
 */

/** The manifest the running build is compared against. */
const manifestUrl =
	'https://raw.githubusercontent.com/Denis-Davidoff/vs-code-tab-browser-ultimate/main/package.json';

/**
 * Where the `.vsix` actually is.
 *
 * Deliberately the committed artifact on `main` and **not** the repository's
 * releases page: `PUBLISHING.md` has six release steps and none of them cuts a
 * GitHub Release, so that page is empty — the button would have been a dead
 * end on the one surface this feature exists to provide. This is the same URL
 * the README documents as *the* download and the same one the promo build
 * opens, so all three agree.
 */
const vsixUrl =
	'https://github.com/Denis-Davidoff/vs-code-tab-browser-ultimate/raw/main/tab-browser-ultimate.vsix';

/** The registry that can install it in place, on the hosts that have it. */
const openVsxUrl = 'https://open-vsx.org/extension/DenysDavydov/tab-browser-ultimate';

/** The setting behind the notification's "Don't show again" button. */
const settingSection = 'aiBrowser';
const settingKey = 'updateCheck.enabled';

/** The release already announced, so this is once per version, not once per window. */
const offeredVersionKey = 'aiBrowser.update.offeredVersion';

/**
 * When the repository was last *reached*.
 *
 * It bounds successful checks and nothing else, and the two gaps are worth
 * knowing rather than rounding off: a request that reached nobody does not
 * stamp it (see {@link UpdateWatch._tick}), so an offline machine retries on
 * every tick; and windows that start together all read this before any of them
 * writes it, so a restored session of ten windows is ten requests, not one.
 * Both are accepted — the alternative to the first is a laptop that opens
 * offline once and then says nothing for six hours.
 */
const lastCheckKey = 'aiBrowser.update.lastCheck';

const checkIntervalMs = 6 * 60 * 60 * 1000;

/**
 * How often the watch looks at the clock.
 *
 * Not the request rate — {@link checkIntervalMs} is, and the check throttles
 * itself against it. This only has to be finer, because a single `setTimeout`
 * at activation leaves a window that stays open for days checking exactly once
 * ever.
 */
const tickIntervalMs = 60 * 60 * 1000;

/**
 * How long after activation the first look happens.
 *
 * Not politeness. The built-in browser is a native view laid over the
 * workbench, so a notification pauses the page behind it — and a window that
 * restores a browser tab is exactly the window that must not be greeted with a
 * toast as it opens. See "A notification pauses the built-in browser" in
 * CLAUDE.md; {@link UpdateWatch._deliver} is the other half of the same
 * precaution.
 */
const startupDelayMs = 10_000;

const requestTimeoutMs = 8_000;

/** Whether the user still wants to hear about releases. */
function enabled(): boolean {
	return vscode.workspace.getConfiguration(settingSection).get<boolean>(settingKey, true);
}

/**
 * Whether a browser page can be seen right now.
 *
 * A toast shown over the built-in browser replaces the live page with a
 * screenshot and a "Paused due to Notification" overlay until it is dismissed.
 * An update notice is the least urgent thing this extension has to say, so it
 * waits rather than doing that — see {@link UpdateWatch._deliver}.
 *
 * **The question is visibility, not focus**, and testing `activeBrowserTab`
 * alone got that wrong. The editor decides the pause geometrically —
 * `_refreshOverlayObscured` asks the overlay manager for anything *overlapping*
 * the browser container and never consults which pane has focus — so a browser
 * tab in a split beside a file, which is the normal way this extension is used,
 * is paused by a toast while `activeBrowserTab` is `undefined`. That is
 * breaks-silently #10, whose wording is "while a browser tab is **visible**".
 *
 * There is no direct signal for it: the proposal exposes only the active tab,
 * and `window.tabGroups` has no `TabInputBrowser` — a browser editor is one of
 * the inputs the extension host does not model, so it arrives as `input:
 * undefined`. That is what the second test uses, and it is deliberately the
 * cautious direction: another unmodelled editor being visible merely defers the
 * notice to the next delivery attempt, while missing a visible browser pauses
 * somebody's page.
 */
function browserTabVisible(): boolean {
	try {
		if (!isBrowserApiGranted()) {
			return false;
		}
		if (vscode.window.activeBrowserTab !== undefined) {
			return true;
		}
		if ((vscode.window.browserTabs ?? []).length === 0) {
			// Nothing to pause, so no need to ask the weaker question below.
			return false;
		}
		// `activeTab` is the visible one of its group, which is exactly the set
		// that can overlap a toast.
		return vscode.window.tabGroups.all.some(
			group => group.activeTab !== undefined && group.activeTab.input === undefined);
	} catch {
		return false;
	}
}

/**
 * The version in the repository's manifest, or `undefined` when it could not be
 * had.
 *
 * Being offline is the normal case rather than an error worth reporting: this
 * runs on a timer, in the background, with nothing the user asked for to
 * deliver. Every failure — no network, a proxy, a 404, a body that is not a
 * manifest — answers the same way, and the next tick tries again.
 */
async function fetchLatestVersion(): Promise<string | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
	try {
		const response = await fetch(manifestUrl, {
			signal: controller.signal,
			// `raw.githubusercontent.com` is cached hard, and a stale answer here
			// is the whole failure this feature exists to remove.
			headers: { 'accept': 'application/json', 'cache-control': 'no-cache' },
		});
		if (!response.ok) {
			return undefined;
		}
		return readManifestVersion(await response.json());
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/** The release to announce, once there is somewhere safe to announce it. */
interface PendingOffer {
	readonly version: string;
	readonly installed: string;
}

class UpdateWatch implements vscode.Disposable {

	private readonly _subs: vscode.Disposable[] = [];
	private readonly _timers: NodeJS.Timeout[] = [];
	private _pending: PendingOffer | undefined;
	private _running = false;
	private _disposed = false;

	constructor(private readonly _context: vscode.ExtensionContext) {
		this._timers.push(setTimeout(() => void this._tick(), startupDelayMs));
		this._timers.push(setInterval(() => void this._tick(), tickIntervalMs));

		// Turning the setting back on should not mean waiting an hour for the
		// answer it re-enabled.
		this._subs.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${settingSection}.${settingKey}`)) {
				void this._tick();
			}
		}));

		// The moment the user looks away from a page is the moment a held-back
		// notice can be delivered without taking that page away.
		try {
			if (isBrowserApiGranted()) {
				this._subs.push(vscode.window.onDidChangeActiveBrowserTab(() => this._deliver()));
				this._subs.push(vscode.window.onDidCloseBrowserTab(() => this._deliver()));
			}
		} catch {
			// No browser API on this host; nothing can be paused by a toast.
		}
		// `browserTabVisible` also asks which tab is visible in each group, and
		// that changes without either event above — closing the split, or
		// switching the other group to a file. Without this the notice waits
		// for the hourly tick instead.
		this._subs.push(vscode.window.tabGroups.onDidChangeTabGroups(() => this._deliver()));
	}

	/**
	 * One pass: deliver what is held back, or ask the repository.
	 *
	 * Everything it can decline to do it declines silently. The one thing that
	 * reaches the screen is a release that is genuinely newer than the running
	 * build and has not been announced before.
	 */
	private async _tick(): Promise<void> {
		if (this._disposed || !enabled()) {
			// A notice the user has just switched off is dropped rather than
			// held: the setting means "stop telling me", not "tell me later".
			this._pending = undefined;
			return;
		}

		if (this._pending) {
			this._deliver();
			return;
		}

		if (this._running || !dueForCheck(this._context.globalState.get(lastCheckKey), Date.now(), checkIntervalMs)) {
			return;
		}

		this._running = true;
		try {
			const version = await fetchLatestVersion();
			if (!version || this._disposed || !enabled()) {
				// The stamp is deliberately not written for an attempt that
				// reached nobody: a laptop whose first window of the day opens
				// offline must not buy six hours of silence for every window
				// after it.
				return;
			}
			await this._remember(lastCheckKey, Date.now());

			const installed = String(this._context.extension.packageJSON?.version ?? '');
			if (!installed || !isNewerVersion(version, installed)) {
				return;
			}
			if (this._context.globalState.get(offeredVersionKey) === version) {
				return;
			}
			this._pending = { version, installed };
			this._deliver();
		} finally {
			this._running = false;
		}
	}

	/**
	 * Puts the held notice on screen, if this is a moment when it may.
	 *
	 * Called from the tick and from the active-tab event, so a notice held back
	 * while the user was reading a page arrives as soon as they look away
	 * rather than up to an hour later.
	 */
	private _deliver(): void {
		const offer = this._pending;
		if (!offer || this._disposed || !enabled() || browserTabVisible()) {
			return;
		}
		this._pending = undefined;
		// The rejection handler is the point of the `void`, not an afterthought:
		// `_announce` awaits `openExternal` and a settings write, either of
		// which can fail, and an unhandled rejection here is breaks-silently
		// #93 on the one path written to be silent.
		this._announce(offer).catch(err => {
			console.warn('[ai-browser] update notice failed:', err);
		});
	}

	/**
	 * The notification itself.
	 *
	 * An update is exactly the case the project's own rule keeps a notification
	 * for — something the user has to decide about — and the two routes to it
	 * are buttons rather than a link in the text, because a toast's body is not
	 * clickable.
	 *
	 * The version is recorded **before** the message goes up, not after the
	 * user answers: a notice that is dismissed rather than clicked has still
	 * been seen, and repeating it in every window until a button is pressed is
	 * how a helpful notice becomes something people disable the extension over.
	 */
	private async _announce(offer: PendingOffer): Promise<void> {
		await this._remember(offeredVersionKey, offer.version);
		if (this._disposed) {
			return;
		}

		const openVsx = vscode.l10n.t("Open VSX");
		const github = vscode.l10n.t("Download from GitHub");
		const never = vscode.l10n.t("Don't show again");

		const choice = await vscode.window.showInformationMessage(
			vscode.l10n.t(
				"AI Browser {0} is available on GitHub — you have {1}. A hand-installed VSIX does not update itself.",
				offer.version, offer.installed),
			openVsx, github, never);

		switch (choice) {
			case openVsx:
				await this._open(openVsxUrl);
				return;
			case github:
				await this._open(vsixUrl);
				return;
			case never:
				await this._optOut();
				return;
		}
	}

	/** Opens a link, and says so in the status bar if it could not be opened. */
	private async _open(url: string): Promise<void> {
		try {
			await vscode.env.openExternal(vscode.Uri.parse(url));
		} catch {
			// The link is the whole answer to what the user just clicked, so a
			// failure has to be visible — through the status bar, since a
			// second toast would pause a page the first one did not.
			try {
				await vscode.env.clipboard.writeText(url);
			} catch {
				// Then the message below is all there is, which is still better
				// than a click that did nothing.
			}
			refuse(vscode.l10n.t("Could not open the link — it is on the clipboard: {0}", url));
		}
	}

	/**
	 * Turns the watch off for good.
	 *
	 * Global, and the same switch as the checkbox in Settings, so there is a way
	 * back from this button; a window-scoped write would silently not apply
	 * anywhere else.
	 *
	 * **The failure has to be reported**, which is why this is not one unguarded
	 * `await`. VS Code refuses to write settings while `settings.json` has a
	 * syntax error, so the one button whose whole meaning is "stop asking me"
	 * silently did not apply — and the version had already been recorded as
	 * announced, so the only visible consequence was the *next* release
	 * appearing regardless.
	 */
	private async _optOut(): Promise<void> {
		try {
			await vscode.workspace.getConfiguration(settingSection)
				.update(settingKey, false, vscode.ConfigurationTarget.Global);
		} catch (err) {
			refuse(vscode.l10n.t(
				"Could not turn update notices off ({0}). Set \"aiBrowser.updateCheck.enabled\" to false in Settings.",
				err instanceof Error ? err.message : String(err)));
		}
	}

	/**
	 * A `globalState` write that cannot become an unhandled rejection.
	 *
	 * `Memento.update` persists the whole memento through the main process and
	 * can fail; a discarded promise is breaks-silently #100. Failing to record
	 * it costs one repeated notice, which is why it is caught rather than
	 * reported.
	 */
	private async _remember(key: string, value: unknown): Promise<void> {
		try {
			await this._context.globalState.update(key, value);
		} catch {
			// Nothing the user can act on.
		}
	}

	public dispose(): void {
		this._disposed = true;
		for (const timer of this._timers) {
			// One list holds both the startup timeout and the hourly interval.
			// Node's timers are one type and either call cancels either kind,
			// but both are spelled out rather than relying on that.
			clearTimeout(timer);
			clearInterval(timer);
		}
		for (const sub of this._subs) {
			sub.dispose();
		}
	}
}

/**
 * Starts the release watch for this window.
 *
 * Silent by construction: it speaks only when the repository carries a version
 * newer than this build, at most once per release, and never while a browser
 * page is in front of the user.
 */
export function registerUpdateCheck(context: vscode.ExtensionContext): void {
	context.subscriptions.push(new UpdateWatch(context));
}
