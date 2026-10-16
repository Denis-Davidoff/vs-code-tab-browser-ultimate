/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * What the login script in the page reports, and the check every report passes
 * before the extension believes it. No imports, so `npm test` loads this
 * directly.
 *
 * The script runs in an isolated world the page cannot reach, but it reads the
 * page's DOM, and the page decides what is in that — including field values
 * of any length. So every message is validated here: unknown types are
 * dropped, strings are capped, and a report that does not fit is not a report.
 */

/** What one frame shows. Sent whenever it changes. */
export interface FieldsMessage {
	readonly type: 'fields';
	/** A visible password field for signing in (not a new-password one). */
	readonly login: boolean;
	/** Any visible password field at all. */
	readonly password: boolean;
	/** A visible `autocomplete="new-password"` field. */
	readonly newPassword: boolean;
	/** The first step of a two-step sign-in: a username field and no password. */
	readonly usernameOnly: boolean;
	/**
	 * Sent once the document has loaded and had time to draw. A navigation is
	 * judged by this report, never by the first: the first goes out 300 ms into
	 * the document, before a slow page has drawn the form it is about to show.
	 */
	readonly settled: boolean;
}

/**
 * Credentials leaving the page. `kind` decides which password is the one to keep:
 * `password` for `login`, `newPassword` for `signup` and `change` — and for
 * `change`, `password` is the one being replaced.
 */
export interface SubmitMessage {
	readonly type: 'submit';
	readonly kind: 'login' | 'signup' | 'change' | 'username';
	readonly username: string;
	readonly password: string;
	readonly newPassword: string;
}

/**
 * What became of the submitted fields: gone from the page with no sign-in
 * field taking their place, or anything else. There is no "cleared": a page
 * empties a password box after a failure as readily as after a success.
 */
export interface OutcomeMessage {
	readonly type: 'outcome';
	readonly result: 'gone' | 'remained';
}

export type FormMessage = FieldsMessage | SubmitMessage | OutcomeMessage;

/** What a fill managed. `reason` says why nothing was filled. */
export interface FillResult {
	readonly username: boolean;
	readonly password: boolean;
	readonly reason?: 'noFields' | 'newPasswordOnly' | 'tooLong' | 'notEmpty';
}

/** The fields' current values, for "save the login on this page". */
export interface PageLogin {
	readonly kind: 'login' | 'signup' | 'change';
	readonly username: string;
	readonly password: string;
	readonly newPassword: string;
}

/** Longer than any real username or password; a page cannot make us hold more. */
const valueLimit = 4096;

const isBool = (value: unknown): value is boolean => typeof value === 'boolean';
const isValue = (value: unknown): value is string => typeof value === 'string' && value.length <= valueLimit;

/** A report from the page, or `undefined` when it is not a well-formed one. */
export function readFormMessage(payload: string): FormMessage | undefined {
	let raw: any;
	try {
		raw = JSON.parse(payload);
	} catch {
		return undefined;
	}
	if (raw?.type === 'fields') {
		if (!isBool(raw.login) || !isBool(raw.password) || !isBool(raw.newPassword) || !isBool(raw.usernameOnly)
			|| (raw.settled !== undefined && !isBool(raw.settled))) {
			return undefined;
		}
		return {
			type: 'fields', login: raw.login, password: raw.password, newPassword: raw.newPassword,
			usernameOnly: raw.usernameOnly, settled: raw.settled === true,
		};
	}
	if (raw?.type === 'submit') {
		if (!['login', 'signup', 'change', 'username'].includes(raw.kind)
			|| !isValue(raw.username) || !isValue(raw.password) || !isValue(raw.newPassword)) {
			return undefined;
		}
		return { type: 'submit', kind: raw.kind, username: raw.username.trim(), password: raw.password, newPassword: raw.newPassword };
	}
	if (raw?.type === 'outcome') {
		return ['gone', 'remained'].includes(raw.result) ? { type: 'outcome', result: raw.result } : undefined;
	}
	return undefined;
}
