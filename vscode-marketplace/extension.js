/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Marketplace build of AI Browser. It carries the listing — readme, video, screenshots —
// and does two jobs beyond it: it tells you where the working extension is, and it watches for
// new releases of it. Both exist because the real build declares VS Code API proposals, which
// the Marketplace does not accept, so it ships as a VSIX — and a hand-installed VSIX neither
// arrives on its own nor ever updates itself.
//
// It publishes under its own id, `DenysDavydov.tab-browser-ultimate-promo`, so both can be
// installed at once. That is the normal end state — someone finds this, installs the real
// build, and this one stays behind as the update watch.
//
// The visible surface is deliberately small and self-erasing:
//
//   - a status bar item, `$(cloud-download) Install AI Browser`, which is the answer to the
//     only complaint this build ever gets — "I installed it and nothing happens". It opens a
//     modal with the three version numbers and the two things you can do about them, and it
//     hides itself once the full build is installed and current;
//   - one notification per released listing version, so an install (or an update of the
//     listing) says what this entry is, and a window opened tomorrow does not repeat it;
//   - the release watch, which only speaks up when there is a newer version than the one
//     installed.
//
// Plain JavaScript on purpose. There is no build step, no dependency and no tsconfig in this
// folder; the whole extension is this file, and it must stay small enough to read in one sitting.

const vscode = require('vscode');

const VSIX_URL = 'https://github.com/Denis-Davidoff/vs-code-tab-browser-ultimate/raw/main/tab-browser-ultimate.vsix';
const GUIDE_URL = 'https://github.com/Denis-Davidoff/vs-code-tab-browser-ultimate#readme';

/**
 * Where a release lands first. The reply carries the version and a download URL pinned to that
 * exact version, which the `main` VSIX above is not — that one is whatever was committed last.
 */
const OPEN_VSX_API = 'https://open-vsx.org/api/DenysDavydov/tab-browser-ultimate';

/** Fallback source: the manifest next to the committed VSIX. Used when Open VSX cannot be reached. */
const RAW_MANIFEST_URL = 'https://raw.githubusercontent.com/Denis-Davidoff/vs-code-tab-browser-ultimate/main/package.json';

/** The real extension's id. Different from this one's — that is the whole point. */
const FULL_BUILD_ID = 'DenysDavydov.tab-browser-ultimate';

/**
 * The listing version whose welcome notice has already been shown.
 *
 * Keyed on the version rather than being a bare "shown" flag, so installing this entry — or
 * updating it — says its piece once, while every window after that stays quiet. A flag was the
 * earlier design and it had the wrong failure mode: install, dismiss, and no later release of
 * the listing could ever introduce itself again.
 */
const NOTICE_VERSION_KEY = 'aiBrowser.promo.noticeVersion';

/** The release already offered. The prompt is once per version, not once per window. */
const OFFERED_VERSION_KEY = 'aiBrowser.promo.offeredVersion';

/** When the registry was last asked, so opening ten windows a day is still two requests. */
const LAST_CHECK_KEY = 'aiBrowser.promo.lastCheck';

/**
 * The last answer the registry gave, so the status bar and the dialog can name a version while
 * the six-hour throttle is holding a request back. Without it a window opened five minutes
 * after the last check would have nothing to show but "unknown".
 */
const LATEST_RELEASE_KEY = 'aiBrowser.promo.latestRelease';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * How often the watch looks at the clock. It is not the request rate — {@link CHECK_INTERVAL_MS}
 * is, and the check throttles itself against it — this only has to be finer, so a window left
 * open for days keeps checking instead of asking once at startup and never again.
 */
const TICK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Everything that can put a notification on screen waits this long after activation.
 *
 * Not politeness: VS Code's browser editor is a native view laid over the workbench, and a
 * notification pauses the page behind it. A window that restores a browser tab is exactly the
 * window that must not be greeted with a toast the instant it opens. The status bar item is
 * exempt — it is part of the workbench layout and overlays nothing — so the visible half of
 * this build is up immediately either way.
 */
const STARTUP_DELAY_MS = 10_000;

const REQUEST_TIMEOUT_MS = 8_000;

/** @param {string} url */
function open(url) {
	return vscode.env.openExternal(vscode.Uri.parse(url));
}

/**
 * Status bar rather than a toast, for everything that is not an available update.
 *
 * Same reason as {@link STARTUP_DELAY_MS}: a notification takes the live page away until it is
 * dismissed. A new release is worth that; "you are up to date" is not.
 *
 * @param {string} text
 * @param {number} [ms]
 */
function status(text, ms = 8_000) {
	vscode.window.setStatusBarMessage(text, ms);
}

function fullBuild() {
	return vscode.extensions.getExtension(FULL_BUILD_ID);
}

function hasFullBuild() {
	return !!fullBuild();
}

/** @returns {string | undefined} */
function installedVersion() {
	const version = fullBuild()?.packageJSON?.version;
	return typeof version === 'string' ? version : undefined;
}

/** @param {string} url */
async function getJson(url) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
		if (!response.ok) {
			throw new Error(`${url} answered ${response.status}`);
		}
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The newest published release, or `undefined` when neither source could be reached.
 *
 * Being offline is the common case here, not an error worth reporting: this runs on a timer in
 * the background and has nothing the user asked for to deliver.
 *
 * @returns {Promise<{ version: string, download: string, source: string } | undefined>}
 */
async function fetchLatestRelease() {
	try {
		const info = await getJson(OPEN_VSX_API);
		if (typeof info?.version === 'string') {
			return { version: info.version, download: info.files?.download ?? VSIX_URL, source: 'Open VSX' };
		}
	} catch {
		// Offline, blocked by a proxy, or the registry is down. The repository still answers.
	}

	try {
		const manifest = await getJson(RAW_MANIFEST_URL);
		if (typeof manifest?.version === 'string') {
			return { version: manifest.version, download: VSIX_URL, source: 'GitHub' };
		}
	} catch {
		// Nothing reachable. Nothing to say.
	}
	return undefined;
}

/**
 * The last release this machine heard about, whatever window heard it.
 *
 * @param {vscode.ExtensionContext} context
 * @returns {{ version: string, download: string, source: string } | undefined}
 */
function cachedRelease(context) {
	const cached = context.globalState.get(LATEST_RELEASE_KEY);
	if (cached && typeof cached === 'object' && typeof cached.version === 'string') {
		return {
			version: cached.version,
			download: typeof cached.download === 'string' ? cached.download : VSIX_URL,
			source: typeof cached.source === 'string' ? cached.source : 'Open VSX',
		};
	}
	return undefined;
}

/**
 * Ask the registry, unless the throttle says not to, and remember the answer either way.
 *
 * @param {vscode.ExtensionContext} context
 * @param {boolean} force A user-invoked check ignores the six-hour throttle.
 * @returns {Promise<{ version: string, download: string, source: string } | undefined>}
 */
async function refreshRelease(context, force) {
	if (!force) {
		const last = Number(context.globalState.get(LAST_CHECK_KEY) ?? 0);
		if (Number.isFinite(last) && Date.now() - last < CHECK_INTERVAL_MS) {
			return cachedRelease(context);
		}
	}

	const release = await fetchLatestRelease();
	if (!release) {
		// The throttle is deliberately not stamped here: an attempt that reached nobody must not
		// buy six hours of silence, or a laptop that opens its first window offline stops
		// checking for the rest of the day.
		return cachedRelease(context);
	}
	await context.globalState.update(LAST_CHECK_KEY, Date.now());
	await context.globalState.update(LATEST_RELEASE_KEY, release);
	return release;
}

/**
 * Whether `candidate` is a later release than `installed`.
 *
 * Compared field by field as numbers, because `'0.5.10' > '0.5.9'` is false as strings — which
 * would hide every update between .9 and .20. Anything that is not plain numbers, a `-rc.1`
 * suffix for instance, answers "not newer": failing to offer an update is recoverable, offering
 * a downgrade is not.
 *
 * @param {string} candidate
 * @param {string} installed
 */
function isNewer(candidate, installed) {
	const left = String(candidate).split('.');
	const right = String(installed).split('.');
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const a = Number(left[i] ?? 0);
		const b = Number(right[i] ?? 0);
		if (!Number.isFinite(a) || !Number.isFinite(b)) {
			return false;
		}
		if (a !== b) {
			return a > b;
		}
	}
	return false;
}

/**
 * What the status bar item is for, in one word.
 *
 * `ok` is the state that hides it, and it is deliberately generous: with the full build
 * installed and no *known* newer release — including when the registry could not be reached —
 * there is nothing to act on, and a permanent button offering to install what is already
 * installed is exactly the noise this build must not add.
 *
 * @param {vscode.ExtensionContext} context
 * @returns {'install' | 'update' | 'ok'}
 */
function installState(context) {
	const installed = installedVersion();
	if (!installed) {
		return 'install';
	}
	const release = cachedRelease(context);
	return release && isNewer(release.version, installed) ? 'update' : 'ok';
}

/**
 * The footer button. Present exactly while there is something to do about it.
 *
 * A status bar item rather than a notification, because this one has to persist: the whole
 * failure it addresses is someone installing the listing, dismissing the toast, and concluding
 * the extension is broken. It is also the one attention-getting surface that cannot pause a
 * browser tab.
 *
 * @param {vscode.ExtensionContext} context
 * @param {vscode.StatusBarItem} item
 */
function refreshStatusItem(context, item) {
	const state = installState(context);
	if (state === 'ok') {
		item.hide();
		return;
	}

	const release = cachedRelease(context);
	if (state === 'install') {
		item.text = '$(cloud-download) Install AI Browser';
		item.tooltip = 'This entry is the Marketplace listing for AI Browser. The working extension '
			+ 'ships as a VSIX — click to see the versions and download it.';
		// The only attention mechanism the API offers, and this is the state that earns it:
		// until the VSIX is installed, nothing the listing advertises actually works.
		item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	} else {
		item.text = `$(cloud-download) Update AI Browser ${release?.version ?? ''}`.trim();
		item.tooltip = `AI Browser ${release?.version} is out — you have ${installedVersion()}. `
			+ 'A VSIX install does not update itself. Click to download.';
		// No background here: an update is worth mentioning, not worth an orange badge sitting
		// in the footer until it is dealt with.
		item.backgroundColor = undefined;
	}
	item.show();
}

/**
 * The modal behind the footer button: the three version numbers, and the two things anyone
 * ever wants to do with them.
 *
 * Modal because it is user-invoked and the answer is the point — a toast that can be missed is
 * what this button exists to replace. The versions are refreshed first, under a *window*
 * progress: `ProgressLocation.Notification` would pause the browser tab behind it.
 *
 * @param {vscode.ExtensionContext} context
 */
async function showInstallDialog(context) {
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, title: 'AI Browser: checking for the latest release…' },
		() => refreshRelease(context, true));

	const release = cachedRelease(context);
	const installed = installedVersion();
	const listing = context.extension.packageJSON.version;

	const detail = [
		`This listing (Marketplace): ${listing}`,
		release
			? `Latest full build (${release.source}): ${release.version}`
			: 'Latest full build: could not reach Open VSX or GitHub',
		installed
			? `Installed full build: ${installed}${release && isNewer(release.version, installed) ? ' — an update is available' : ' — up to date'}`
			: 'Installed full build: not installed',
		'',
		'The full build declares VS Code API proposals, which the Marketplace does not accept, so '
		+ 'it is distributed as a VSIX. Download it, then run "Extensions: Install from VSIX…" '
		+ 'from the Command Palette and pick the downloaded file.',
	].join('\n');

	const title = installed
		? 'AI Browser — the full build'
		: 'AI Browser is not installed yet — this entry is the listing for it';
	const download = release ? `Download ${release.version} (VSIX)` : 'Download the VSIX';
	const guide = 'Open the Guide';

	const choice = await vscode.window.showInformationMessage(title, { modal: true, detail }, download, guide);
	if (choice === download) {
		await open(release?.download ?? VSIX_URL);
		status('Then run "Extensions: Install from VSIX…" from the Command Palette and pick the downloaded file.', 15_000);
	} else if (choice === guide) {
		await open(GUIDE_URL);
	}
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {vscode.StatusBarItem} item
 * @param {boolean} manual A user-invoked check reports every outcome, and ignores both the
 * six-hour throttle and the memory of what has already been offered.
 */
async function checkForUpdates(context, item, manual) {
	const release = await refreshRelease(context, manual);
	refreshStatusItem(context, item);

	const installed = installedVersion();

	// Nothing to update — the full build is not here at all. The footer button and the welcome
	// notice already make that case; a second toast saying the same thing would be nagging.
	if (!installed) {
		if (manual) {
			await showInstallDialog(context);
		}
		return;
	}

	if (!release) {
		if (manual) {
			status('AI Browser: could not reach Open VSX or GitHub to check for updates.');
		}
		return;
	}

	if (!isNewer(release.version, installed)) {
		if (manual) {
			status(`AI Browser ${installed} is the latest release.`);
		}
		return;
	}

	if (!manual && context.globalState.get(OFFERED_VERSION_KEY) === release.version) {
		return;
	}
	void context.globalState.update(OFFERED_VERSION_KEY, release.version);

	const download = `Download ${release.version}`;
	const choice = await vscode.window.showInformationMessage(
		`AI Browser ${release.version} is out — you have ${installed}. A VSIX install does not update itself, `
		+ 'so it has to be downloaded and installed by hand.',
		download, 'Later');
	if (choice === download) {
		await open(release.download);
		status('Then run "Extensions: Install from VSIX…" from the Command Palette and pick the downloaded file.', 15_000);
	}
}

/**
 * The introduction, shown once per released version of this listing.
 *
 * Delayed for the reason in {@link STARTUP_DELAY_MS}, and skipped entirely once the full build
 * is installed — at that point this entry has nothing to introduce and is only the update watch.
 *
 * @param {vscode.ExtensionContext} context
 */
async function showWelcome(context) {
	const listing = context.extension.packageJSON.version;
	if (hasFullBuild() || context.globalState.get(NOTICE_VERSION_KEY) === listing) {
		return;
	}
	void context.globalState.update(NOTICE_VERSION_KEY, listing);

	const install = 'Download the full build';
	const guide = 'Read the guide';
	const choice = await vscode.window.showInformationMessage(
		'AI Browser: the working extension ships as a VSIX, because the Marketplace does not accept the '
		+ 'API proposals it is built on. This entry is how you get it — use "Install AI Browser" in the '
		+ 'status bar at any time — and it stays behind afterwards to tell you when a new version is '
		+ 'released, which a hand-installed VSIX will never do on its own.',
		install, guide);
	if (choice === install) {
		await showInstallDialog(context);
	} else if (choice === guide) {
		await open(GUIDE_URL);
	}
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
	const item = vscode.window.createStatusBarItem(
		'aiBrowser.promo.install', vscode.StatusBarAlignment.Left, 1000);
	item.name = 'AI Browser: install';
	item.command = 'aiBrowser.promo.install';
	context.subscriptions.push(item);
	refreshStatusItem(context, item);

	context.subscriptions.push(
		vscode.commands.registerCommand('aiBrowser.promo.install', () => showInstallDialog(context)),
		vscode.commands.registerCommand('aiBrowser.promo.getFullBuild', () => open(VSIX_URL)),
		vscode.commands.registerCommand('aiBrowser.promo.openGuide', () => open(GUIDE_URL)),
		vscode.commands.registerCommand('aiBrowser.promo.checkForUpdates',
			() => checkForUpdates(context, item, true)),
	);

	// Drives the `when` on the listing entries, so they disappear once the real build is
	// installed rather than sitting next to the real commands under the same category. The
	// update check is not among them: that is what this build is for once the other one is here.
	// Republished whenever an extension is installed or removed.
	const publishState = () => vscode.commands.executeCommand(
		'setContext', 'aiBrowser.fullBuildInstalled', hasFullBuild());

	/**
	 * The watch: one look shortly after startup, then a slow tick.
	 *
	 * It runs whether or not the full build is installed, because the version it reports is
	 * what the footer button and its dialog are built out of. What differs is what it does with
	 * the answer — see {@link checkForUpdates}.
	 */
	const startup = setTimeout(() => {
		void checkForUpdates(context, item, false);
		void showWelcome(context);
	}, STARTUP_DELAY_MS);
	const ticker = setInterval(() => void checkForUpdates(context, item, false), TICK_INTERVAL_MS);
	context.subscriptions.push({
		dispose: () => {
			clearTimeout(startup);
			clearInterval(ticker);
		},
	});

	// Installing or removing the full build is the one thing that moves every piece of state
	// here, and it happens *after* activation in the flow this build exists for: find the
	// listing, download the VSIX, install it. Without this the footer button would still be
	// offering the install in the very session where it had just been done.
	context.subscriptions.push(vscode.extensions.onDidChange(() => {
		void publishState();
		refreshStatusItem(context, item);
	}));
	void publishState();
}

function deactivate() { }

module.exports = { activate, deactivate };
