/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Marketplace build of AI Browser. It carries the listing — readme, video, screenshots —
// and nothing else: the working extension declares VS Code API proposals, which the Marketplace
// does not accept, so it ships as the VSIX linked below.
//
// It publishes under its own id, `DenysDavydov.tab-browser-ultimate-promo`, so both can be
// installed at once. That is the normal end state — someone finds this, installs the real
// build, and this one stays behind — which is why everything here checks for the real
// extension first and goes quiet when it is there.
//
// Plain JavaScript on purpose. There is no build step, no dependency and no tsconfig in this
// folder; the whole extension is this file, and it must stay small enough to read in one screen.

const vscode = require('vscode');

const VSIX_URL = 'https://github.com/Denis-Davidoff/vs-code-tab-browser-ultimate/raw/main/tab-browser-ultimate.vsix';
const GUIDE_URL = 'https://github.com/Denis-Davidoff/vs-code-tab-browser-ultimate#readme';

/** The real extension's id. Different from this one's — that is the whole point. */
const FULL_BUILD_ID = 'DenysDavydov.tab-browser-ultimate';

/** Shown once per machine, never again — a stub that nags on every window is worse than no stub. */
const NOTICE_SHOWN_KEY = 'aiBrowser.promo.noticeShown';

/** @param {string} url */
function open(url) {
	return vscode.env.openExternal(vscode.Uri.parse(url));
}

function hasFullBuild() {
	return !!vscode.extensions.getExtension(FULL_BUILD_ID);
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand('aiBrowser.promo.getFullBuild', () => open(VSIX_URL)),
		vscode.commands.registerCommand('aiBrowser.promo.openGuide', () => open(GUIDE_URL)),
	);

	// Drives the `when` on both palette entries, so this build's commands disappear once the
	// real one is installed rather than sitting next to the real commands under the same
	// category. Republished whenever an extension is installed or removed.
	const publishState = () => vscode.commands.executeCommand(
		'setContext', 'aiBrowser.fullBuildInstalled', hasFullBuild());
	context.subscriptions.push(vscode.extensions.onDidChange(publishState));
	void publishState();

	if (hasFullBuild() || context.globalState.get(NOTICE_SHOWN_KEY)) {
		return;
	}
	void context.globalState.update(NOTICE_SHOWN_KEY, true);

	const download = 'Download the full build';
	const guide = 'Read the guide';
	void vscode.window.showInformationMessage(
		'AI Browser: this Marketplace entry is the guide. The working extension is one VSIX away.',
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
