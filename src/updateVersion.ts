/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Deciding whether the repository is ahead of the build that is running.
 *
 * This extension is hand-installed from a VSIX, so nothing updates it and
 * nothing announces a release: the Marketplace gallery only tracks the promo
 * id, and an Open VSX install exists on some hosts and not on VS Code itself.
 * The repository's root `package.json` is the one place every release
 * necessarily touches, so it is what gets asked.
 *
 * Leaf module: no imports at all, so `npm test` can load it directly. The
 * `vscode` half — the timer, the request and the notification — is in
 * `updateCheck.ts`.
 */

/**
 * Whether `candidate` is a later release than `installed`.
 *
 * Compared field by field **as numbers**, because `'0.5.10' > '0.5.9'` is false
 * as strings, which would hide every release between .9 and .20. A field that
 * is not a number ends the comparison with "not newer": failing to announce a
 * release is recoverable, telling someone to downgrade is not.
 *
 * Stated precisely, because the loop is easy to read as stricter than it is:
 * the comparison stops at the first field that *differs*, so `0.6.0-rc.1`
 * against `0.5.24` answers "newer" on the minor field and never reaches the
 * suffix. That is the intended direction — it really is a later release — and
 * the guard only bites where the unreadable field is the deciding one.
 *
 * The same rule as the promo build's `isNewer`, deliberately. The two cannot
 * share code (that one is plain JavaScript in a folder with no build step) and
 * they must not disagree, or the two surfaces announce different things about
 * the same pair of versions.
 */
export function isNewerVersion(candidate: string, installed: string): boolean {
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
 * What a version may look like, and nothing else.
 *
 * **This is a security boundary, not tidiness.** The value arrives from the
 * network and is interpolated into a notification message — and VS Code renders
 * a notification body as *linked text*, opening those links with
 * `allowCommands: true` (`renderMessage` in the notification renderer:
 * `render(e.message, { callback: n => openerService.open(parse(n), { allowCommands: true }) })`).
 * So a `version` of `99.0.0 [Update now](command:workbench.action.terminal.sendSequence?…)`
 * renders as a button that runs a command on one click. `isNewerVersion` is no
 * defence: it stops at the first field that *differs*, so it answers "newer" on
 * the leading `99` and never looks at the rest.
 *
 * The trust boundary here is a GitHub name rather than a signature — a
 * repository that is renamed or deleted frees that name for anybody to
 * re-register, and every installed copy goes on polling it — so the value is
 * checked rather than trusted.
 */
const versionShape = /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/;

/**
 * The `version` of a manifest we just fetched, if it has a usable one.
 *
 * The body is whatever the network handed back, so it is treated as untrusted
 * input rather than as a manifest: a proxy login page, an HTML error, a JSON
 * document with a `version` that is a number or an object, or a string built to
 * be rendered rather than to be read. Anything that is not a plain version
 * answers `undefined`, which the caller reads as "nothing to say" — the same
 * answer as being offline.
 */
export function readManifestVersion(body: unknown): string | undefined {
	const version = (body as { version?: unknown } | null | undefined)?.version;
	if (typeof version !== 'string') {
		return undefined;
	}
	const trimmed = version.trim();
	return versionShape.test(trimmed) ? trimmed : undefined;
}

/**
 * Whether enough time has passed since the last look at the repository.
 *
 * Ten windows opened in a morning are one request, not ten. A stamp in the
 * future — a clock that moved, a machine restored from a backup — is treated as
 * due rather than as six hours of silence that could last indefinitely.
 */
export function dueForCheck(lastCheck: unknown, now: number, intervalMs: number): boolean {
	const last = Number(lastCheck ?? 0);
	if (!Number.isFinite(last) || last <= 0 || last > now) {
		return true;
	}
	return now - last >= intervalMs;
}
