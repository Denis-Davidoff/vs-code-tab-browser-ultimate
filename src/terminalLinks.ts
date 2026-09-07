/*---------------------------------------------------------------------------------------------
 *  Takes over the urls the terminal prints, so `Cmd`/`Ctrl` + click on the address a dev server
 *  announces opens the browser panel instead of an external browser.
 *
 *  `registerExternalUriOpener`, which is what the built-in Simple Browser uses for this, is a
 *  proposed api the editor only grants to its own extensions. A terminal link provider is the
 *  stable way in, and it is consulted before the terminal's own url detection.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getConfiguration, isLocalUrl, parseHttpUrl } from './browserProxy';

/** Trailing characters a url in prose or in a log line tends to pick up. */
const trailingNoise = /[.,;:!?)\]}>'"`]+$/;

/**
 * Built per call: the api may ask several terminals at once, and a shared global regex would
 * carry its `lastIndex` between them.
 */
function urlPattern(): RegExp {
	return /https?:\/\/[^\s<>"'`|()[\]{}]+/g;
}

interface BrowserLink extends vscode.TerminalLink {
	readonly url: string;
}

export function registerTerminalLinks(open: (url: string) => void): vscode.Disposable {
	const provider: vscode.TerminalLinkProvider<BrowserLink> = {
		provideTerminalLinks(context) {
			const mode = getConfiguration().get<'localhost' | 'always' | 'never'>(
				'terminalLinks.mode', 'localhost');
			if (mode === 'never') {
				return [];
			}

			const links: BrowserLink[] = [];
			const pattern = urlPattern();

			for (let match = pattern.exec(context.line); match; match = pattern.exec(context.line)) {
				const raw = match[0].replace(trailingNoise, '');
				const url = parseHttpUrl(raw);
				if (!url || (mode === 'localhost' && !isLocalUrl(url))) {
					continue;
				}

				links.push({
					startIndex: match.index,
					length: raw.length,
					url: url.toString(),
					tooltip: vscode.l10n.t("Open in Tab Browser Ultimate"),
				});
			}

			return links;
		},

		handleTerminalLink(link) {
			open(link.url);
		},
	};

	return vscode.window.registerTerminalLinkProvider(provider);
}
