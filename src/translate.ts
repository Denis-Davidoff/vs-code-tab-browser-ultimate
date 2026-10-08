/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { BrowserController } from './browserController';
import { isBrowserApiGranted, workspaceIsRemoteFromHost } from './proposedApi';
import { refuse } from './notify';
import { plainInLabel, plainInPrompt } from './notifyText';
import {
	languageNameProblem, orderLanguages, pageTitle, readRecentLanguages, rememberLanguage, resolveLanguage,
	translationPrompt,
	type Language,
} from './translateText';

/*
 * Translate Page: pick a language, get a prompt on the clipboard, paste it into
 * an assistant. The assistant does the translating through
 * `browser_text_segments` / `browser_replace_text`.
 *
 * **Why a prompt and not a translation.** An MCP server cannot start work in a
 * client: tools are called by the model, and the one server-to-client request
 * that could ask a model for text (`sampling/createMessage`) needs a stream this
 * server does not have, and is not something every assistant answers. The
 * paste is the one step the user takes anyway when they talk to an assistant.
 */

export const translatePageCommand = 'aiBrowser.translatePage';

const recentKey = 'aiBrowser.translate.recentLanguages';

interface LanguageItem extends vscode.QuickPickItem {
	readonly language?: Language;
	readonly other?: true;
}

/**
 * Runs inside `McpLifecycle.withServer`, which refuses with a reason when the
 * server is off, failed or still starting: the prompt only works through it.
 */
export async function translatePage(context: vscode.ExtensionContext, browser: BrowserController): Promise<void> {
	// The same refusal as Connect (#225): an assistant running next to a remote
	// folder cannot reach this machine's loopback, so the prompt would only
	// produce "I have no ai-browser tools".
	if (workspaceIsRemoteFromHost()) {
		vscode.window.showWarningMessage(vscode.l10n.t(
			"This window's folder is on a remote machine ({0}), while AI Browser and its MCP server run on this one — an assistant running next to that folder cannot reach this machine's loopback, so it could not translate the page.",
			vscode.env.remoteName ?? 'remote'));
		return;
	}
	if (!isBrowserApiGranted()) {
		refuse(vscode.l10n.t("Translating a page needs the integrated browser API — see the AI Browser status bar item."));
		return;
	}
	const tab = browser.userTab ?? await pickTab();
	if (!tab) {
		return;
	}

	// The page is named in the picker and in the confirmation, because the tab
	// may have been chosen without asking — the one last in front of the user,
	// while focus is in a file — and a guess the user cannot see is the one the
	// logins feature refuses to make (#259).
	const page = plainInLabel(pageTitle(tab.title, tab.url) || tab.url);
	const recent = readRecentLanguages(context.globalState.get(recentKey));
	const language = await pickLanguage(recent, page);
	if (!language) {
		return;
	}
	await context.globalState.update(recentKey, rememberLanguage(recent, language));

	// The tab can close while the picker is open; the prompt would then name a
	// page that is gone.
	if (!(vscode.window.browserTabs ?? []).includes(tab)) {
		refuse(vscode.l10n.t("The browser tab was closed — open the page again and run Translate Page from it."));
		return;
	}

	const prompt = translationPrompt(language, {
		// Page-chosen, into text a model acts on — see `plainInPrompt`. Without
		// the ` (<url>)` the host appends, or the prompt prints the address twice.
		title: plainInPrompt(pageTitle(tab.title, tab.url)),
		url: tab.url,
		tabId: browser.tabIdOf(tab),
	});
	await vscode.env.clipboard.writeText(prompt);

	// Modal, not a toast: a toast stays up over the page and pauses it until it
	// is dismissed, while a modal goes with the one click the user makes anyway.
	// The same choice as the paste prompt after Connect (`askToPaste`).
	await vscode.window.showInformationMessage(
		vscode.l10n.t("The translation prompt is on your clipboard."),
		{
			modal: true,
			detail: vscode.l10n.t(
				"Paste it into Claude Code, Codex or another assistant connected to AI Browser. It translates \"{0}\" into {1} and writes the text into the page.",
				page, language.name),
		});
}

/**
 * Asks which tab, when more than one is open and none can be told apart — no
 * tab is focused and none has been since the window opened.
 */
async function pickTab(): Promise<vscode.BrowserTab | undefined> {
	const open = vscode.window.browserTabs ?? [];
	if (open.length === 0) {
		refuse(vscode.l10n.t("Open a page in the integrated browser first."));
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(
		open.map(tab => ({
			// Page-chosen: a label renders `$(icon)` syntax, see `plainInLabel`.
			label: plainInLabel(pageTitle(tab.title, tab.url) || tab.url),
			description: plainInLabel(tab.url),
			tab,
		})),
		{ title: vscode.l10n.t("Translate Page"), placeHolder: vscode.l10n.t("Which page?") });
	return picked?.tab;
}

async function pickLanguage(recent: readonly Language[], page: string): Promise<Language | undefined> {
	const ordered = orderLanguages(recent, vscode.env.language);
	const items: LanguageItem[] = ordered.map(({ language, reason }) => ({
		label: language.native && language.native !== language.name
			? `${language.name} — ${language.native}`
			: language.name,
		description: reason === 'recent'
			? vscode.l10n.t("recently used")
			: reason === 'editor'
				? vscode.l10n.t("VS Code's language")
				: undefined,
		language,
	}));
	items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
	items.push({ label: vscode.l10n.t("$(edit) Other language…"), other: true });

	const picked = await vscode.window.showQuickPick(items, {
		title: vscode.l10n.t("Translate Page — {0}", page),
		placeHolder: vscode.l10n.t("Translate into…"),
		matchOnDescription: true,
	});
	if (!picked) {
		return undefined;
	}
	if (picked.language) {
		return picked.language;
	}

	// `ignoreFocusOut` and a refused empty value, or Enter "does nothing":
	// breaks-silently #79 and #80, and this box is opened from a menu exactly
	// like the ones those were found on.
	const typed = await vscode.window.showInputBox({
		title: vscode.l10n.t("Translate Page — {0}", page),
		prompt: vscode.l10n.t("The language to translate into, in any spelling the assistant will understand"),
		placeHolder: vscode.l10n.t("e.g. Georgian, Brazilian Portuguese, українська"),
		ignoreFocusOut: true,
		validateInput: value => languageNameProblem(value),
	});
	return typed === undefined ? undefined : resolveLanguage({ name: typed.trim() });
}
