/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Making a page-supplied string safe to put in a notification. No imports at
 * all, so `npm test` can load it.
 */

/**
 * **This is a security boundary, not tidiness**, and it is the same one
 * {@link versionShape} guards one file along.
 *
 * VS Code renders a notification body as *linked text*, and opens those links
 * with `allowCommands: true` — `renderMessage` in the notification renderer is
 * `render(e.message, { callback: n => openerService.open(parse(n), { allowCommands: true }) })`.
 * So a `[label](command:…)` anywhere in the body is a button that runs a command
 * on one click.
 *
 * A version string arrives from the network and is checked by *shape*, because
 * a version has one. A page title has no shape: it is `document.title` of
 * whatever the user happens to have open, so the page chooses it outright and
 * there is nothing to validate against. It reaches a notification through
 * `scopeNote`, which names the shared page in four refusals — including the
 * no-folder one, which is an ordinary window state reached from the browser
 * tab's own dropdown. So the value is neutralised instead.
 *
 * `[` and `]` are what open and close a link *label*, and without a label there
 * is no link whatever follows it, so dropping them is enough and does not
 * depend on which target schemes the renderer happens to accept. They are
 * dropped rather than escaped because a backslash is not an escape in linked
 * text — it would render literally and still leave the bracket in place.
 *
 * Whitespace is collapsed and the result is capped for a second reason that is
 * not security: a title is page-chosen, so it can be thousands of characters or
 * carry newlines, and a notification is one line with a close button.
 */
export function plainInNotification(value: string, limit = 80): string {
	const collapsed = value.replace(/\s+/g, ' ').trim();
	const delinked = collapsed.replace(/[[\]]/g, '');
	return delinked.length > limit ? `${delinked.slice(0, limit - 1)}…` : delinked;
}
