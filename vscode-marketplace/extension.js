/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The Marketplace build of AI Browser. It carries the listing — readme, video, screenshots —
// and nothing else: the working extension declares VS Code API proposals, which the Marketplace
// does not accept, so it ships as the VSIX linked below.
//
// Plain JavaScript on purpose. There is no build step, no dependency and no tsconfig in this
// folder; the whole extension is this file, and it must stay small enough to read in one screen.

const vscode = require('vscode');

const VSIX_URL = 'https://github.com/Denis-Davidoff/vs-code-tab-browser-ultimate/raw/main/tab-browser-ultimate.vsix';
const GUIDE_URL = 'https://github.com/Denis-Davidoff/vs-code-tab-browser-ultimate#readme';

/** Shown once per machine, never again — a stub that nags on every window is worse than no stub. */
const NOTICE_SHOWN_KEY = 'aiBrowser.marketplace.noticeShown';

/** @param {string} url */
function open(url) {
	return vscode.env.openExternal(vscode.Uri.parse(url));
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand('aiBrowser.marketplace.getFullBuild', () => open(VSIX_URL)),
		vscode.commands.registerCommand('aiBrowser.marketplace.openGuide', () => open(GUIDE_URL)),
	);

	if (context.globalState.get(NOTICE_SHOWN_KEY)) {
		return;
	}
	void context.globalState.update(NOTICE_SHOWN_KEY, true);

	const download = 'Download the full build';
	const guide = 'Read the guide';
	void vscode.window.showInformationMessage(
		'AI Browser: this Marketplace entry is the guide. The working extension is one VSIX away — it installs over this one.',
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
