/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Marketplace build of AI Browser. It carries the listing — readme, video, screenshots —
// and does one job beyond it: it watches for new releases of the real extension and offers the
// download. That job exists because the real build declares VS Code API proposals, which the
// Marketplace does not accept, so it ships as a VSIX — and a hand-installed VSIX never updates
// itself. Nothing else would ever tell you a new version is out.
//
// It publishes under its own id, `DenysDavydov.tab-browser-ultimate-promo`, so both can be
// installed at once. That is the normal end state — someone finds this, installs the real
// build, and this one stays behind as the update watch.
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

/** Shown once per machine, never again — a stub that nags on every window is worse than no stub. */
const NOTICE_SHOWN_KEY = 'aiBrowser.promo.noticeShown';

/** The release already offered. The prompt is once per version, not once per window. */
const OFFERED_VERSION_KEY = 'aiBrowser.promo.offeredVersion';

/** When the registry was last asked, so opening ten windows a day is still two requests. */
const LAST_CHECK_KEY = 'aiBrowser.promo.lastCheck';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * How often the watch looks at the clock. It is not the request rate — {@link CHECK_INTERVAL_MS}
 * is, and the check throttles itself against it — this only has to be finer, so a window left
 * open for days keeps checking instead of asking once at startup and never again.
 */
const TICK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The automatic check waits this long after activation.
 *
 * Not politeness: VS Code's browser editor is a native view laid over the workbench, and a
 * notification pauses the page behind it. A window that restores a browser tab is exactly the
 * window that must not be greeted with a toast the instant it opens.
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
 * @returns {Promise<{ version: string, download: string } | undefined>}
 */
async function latestRelease() {
	try {
		const info = await getJson(OPEN_VSX_API);
		if (typeof info?.version === 'string') {
			return { version: info.version, download: info.files?.download ?? VSIX_URL };
		}
	} catch {
		// Offline, blocked by a proxy, or the registry is down. The repository still answers.
	}

	try {
		const manifest = await getJson(RAW_MANIFEST_URL);
		if (typeof manifest?.version === 'string') {
			return { version: manifest.version, download: VSIX_URL };
		}
	} catch {
		// Nothing reachable. Nothing to say.
	}
	return undefined;
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
 * @param {vscode.ExtensionContext} context
 * @param {boolean} manual A user-invoked check reports every outcome, and ignores both the
 * six-hour throttle and the memory of what has already been offered.
 */
async function checkForUpdates(context, manual) {
	if (!manual) {
		const last = Number(context.globalState.get(LAST_CHECK_KEY) ?? 0);
		if (Number.isFinite(last) && Date.now() - last < CHECK_INTERVAL_MS) {
			return;
		}
	}

	const release = await latestRelease();
	if (!release) {
		// The throttle is deliberately not stamped here: an attempt that reached nobody must not
		// buy six hours of silence, or a laptop that opens its first window offline stops
		// checking for the rest of the day.
		if (manual) {
			status('AI Browser: could not reach Open VSX or GitHub to check for updates.');
		}
		return;
	}
	void context.globalState.update(LAST_CHECK_KEY, Date.now());

	const installed = installedVersion();
	if (installed && !isNewer(release.version, installed)) {
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
	const message = installed
		? `AI Browser ${release.version} is out — you have ${installed}. A VSIX install does not update itself, `
			+ 'so it has to be downloaded and installed by hand.'
		: `AI Browser ${release.version} is available. The working extension ships as a VSIX.`;

	const choice = await vscode.window.showInformationMessage(message, download, 'Later');
	if (choice === download) {
		await open(release.download);
		status('Then run "Extensions: Install from VSIX…" from the Command Palette and pick the downloaded file.', 15_000);
	}
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand('aiBrowser.promo.getFullBuild', () => open(VSIX_URL)),
		vscode.commands.registerCommand('aiBrowser.promo.openGuide', () => open(GUIDE_URL)),
		vscode.commands.registerCommand('aiBrowser.promo.checkForUpdates', () => checkForUpdates(context, true)),
	);

	// Drives the `when` on the two listing entries, so they disappear once the real build is
	// installed rather than sitting next to the real commands under the same category. The
	// update check is not among them: that is what this build is for once the other one is here.
	// Republished whenever an extension is installed or removed.
	const publishState = () => vscode.commands.executeCommand(
		'setContext', 'aiBrowser.fullBuildInstalled', hasFullBuild());

	/**
	 * The watch: one look shortly after startup, then a slow tick.
	 *
	 * Armed from two places, because the flow this build exists for — find the listing, download
	 * the VSIX, install it — installs the real build *after* activation. Without the second arm
	 * the watch would sit inert until the window was reloaded, in exactly the session where it
	 * was just asked for.
	 */
	let startup;
	let ticker;
	const arm = () => {
		if (ticker || !hasFullBuild()) {
			return;
		}
		startup = setTimeout(() => void checkForUpdates(context, false), STARTUP_DELAY_MS);
		ticker = setInterval(() => void checkForUpdates(context, false), TICK_INTERVAL_MS);
	};
	const disarm = () => {
		clearTimeout(startup);
		clearInterval(ticker);
		startup = undefined;
		ticker = undefined;
	};

	context.subscriptions.push(vscode.extensions.onDidChange(() => {
		void publishState();
		if (hasFullBuild()) {
			arm();
		} else {
			disarm();
		}
	}));
	context.subscriptions.push({ dispose: disarm });
	void publishState();
	arm();

	if (hasFullBuild() || context.globalState.get(NOTICE_SHOWN_KEY)) {
		return;
	}
	void context.globalState.update(NOTICE_SHOWN_KEY, true);

	const download = 'Download the full build';
	const guide = 'Read the guide';
	void vscode.window.showInformationMessage(
		'AI Browser: the working extension ships as a VSIX, because the Marketplace does not accept the '
		+ 'API proposals it is built on. This entry is how you get it — and it stays behind afterwards to '
		+ 'tell you when a new version is released, which a hand-installed VSIX will never do on its own.',
		download,
		guide,
	).then(choice => {
		if (choice === download) {
			return open(VSIX_URL);
		}
		if (choice === guide) {
			return open(GUIDE_URL);
		}
		return undefined;
	});
}

function deactivate() { }

module.exports = { activate, deactivate };
