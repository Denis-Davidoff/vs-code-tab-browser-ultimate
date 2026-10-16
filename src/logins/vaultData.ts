/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * What the saved-logins vault holds, and the rules for reading, matching and
 * merging it. No `vscode`, no relative value imports — `npm test` loads this
 * directly. `loginVault.ts` keeps it in SecretStorage; this file decides what a
 * valid vault *is*.
 */

import * as crypto from 'crypto';

/** See `webUrl.ts`: the base `lib` has no DOM, Node provides the global. */
declare class URL {
	constructor(input: string);
	readonly protocol: string;
	readonly hostname: string;
	readonly host: string;
}

export const vaultFormat = 'ai-browser-vault';
export const vaultVersion = 1;

/** A username and password saved for one origin. */
export interface LoginEntry {
	readonly id: string;
	/** `scheme://host[:port]`, exactly as {@link originOf} produces it. */
	readonly origin: string;
	readonly username: string;
	readonly password: string;
	readonly title?: string;
	readonly note?: string;
	/** Milliseconds since the epoch. */
	readonly created: number;
	/** When the password last changed. */
	readonly updated: number;
	readonly lastUsed?: number;
}

/**
 * A passkey: a WebAuthn credential whose private key lives here rather than in
 * a platform authenticator. The fields are the ones `WebAuthn.credentialAdded`
 * reports and `WebAuthn.addCredential` takes back — standard base64, not
 * base64url, because that is what CDP speaks.
 */
export interface PasskeyEntry {
	readonly id: string;
	readonly rpId: string;
	readonly credentialId: string;
	readonly userHandle?: string;
	readonly userName?: string;
	readonly userDisplayName?: string;
	/** PKCS#8, base64. The one field that must never leave the vault unencrypted. */
	readonly privateKey: string;
	/**
	 * Only ever grows. A relying party that sees it go backwards treats the
	 * authenticator as cloned, so a merge keeps the larger of two.
	 */
	readonly signCount: number;
	/** The page the passkey was created on, for display. */
	readonly origin?: string;
	readonly created: number;
	readonly lastUsed?: number;
}

export interface Vault {
	readonly logins: readonly LoginEntry[];
	readonly passkeys: readonly PasskeyEntry[];
	/** Origins the user said never to offer saving for. */
	readonly neverSave: readonly string[];
	/**
	 * Stored entries this build could not read, carried through untouched.
	 *
	 * Dropping them on the next write would delete somebody's password because
	 * of a hand edit or a bug in another build; keeping them costs nothing.
	 */
	readonly unreadable?: { readonly logins: readonly unknown[]; readonly passkeys: readonly unknown[] };
	/**
	 * A random id written with every store. `loginVault.ts` uses it to tell
	 * whether the vault it reads is the one last written — from any window —
	 * or a copy another window's cache has not caught up with yet.
	 */
	readonly revision?: string;
}

export function emptyVault(): Vault {
	return { logins: [], passkeys: [], neverSave: [] };
}

export function newId(): string {
	return crypto.randomUUID();
}

/**
 * A revision id that says when it was made: `<ms since epoch>-<random>`.
 *
 * Ordered by its time, so a writer can tell "the vault is older than the last
 * write" (wait for it) from "the vault is at least as new" (go ahead) — a
 * random id alone could only say "different".
 */
export function newRevision(now = Date.now()): string {
	return `${now}-${crypto.randomUUID()}`;
}

/** The time a {@link newRevision} was made, or `undefined` for one this build did not write. */
export function revisionTime(revision: string | undefined): number | undefined {
	const time = Number(/^(\d+)-/.exec(revision ?? '')?.[1]);
	return Number.isFinite(time) && time > 0 ? time : undefined;
}

/**
 * The origin a login is saved under, or `undefined` for anything that is not an
 * http(s) page.
 *
 * Only http and https: a password typed into `file:` or `data:` has no origin a
 * later visit could be matched against, and an opaque origin matches nothing.
 * `URL` lower-cases the host and drops a default port, so `HTTPS://Example.com:443/x`
 * and `https://example.com` save under the same key.
 */
export function originOf(url: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return undefined;
	}
	if (!parsed.hostname) {
		return undefined;
	}
	return `${parsed.protocol}//${parsed.host}`;
}

/** The hostname part of an origin, or `undefined`. */
export function hostOf(origin: string): string | undefined {
	try {
		return new URL(origin).hostname;
	} catch {
		return undefined;
	}
}

/**
 * Hosts on which plain http is not a downgrade.
 *
 * Kept in step with `localHosts` in `webUrl.ts` by hand — this module may not
 * import that one (the leaf-module rule), and the two answer the same question.
 */
const localHosts: ReadonlySet<string> = new Set([
	'localhost', '127.0.0.1', '[0:0:0:0:0:0:0:1]', '[::1]', '0.0.0.0', '[0:0:0:0:0:0:0:0]', '[::]',
]);

export type MatchKind = 'exact' | 'sameHost';

export interface LoginMatch {
	readonly entry: LoginEntry;
	readonly kind: MatchKind;
}

/**
 * The saved logins that belong to a page, best first.
 *
 * **Exact origin, then the same host on another port or scheme — and nothing
 * wider.** A password manager's matching rule *is* its phishing protection: the
 * address bar is the only thing that tells `example.com` from
 * `example.com.evil.net`, and a looser rule hands that judgement back to the
 * user at the worst possible moment. Subdomain matching would need the Public
 * Suffix List to be safe (`a.github.io` and `b.github.io` are unrelated
 * parties), and approximating it is how it goes wrong. Anything else is
 * reachable deliberately, through "other saved logins", never offered.
 *
 * Same host is there for dev servers, which move between ports all day. It
 * never offers an https login on an http page — that would send a credential
 * saved over TLS across the network in clear — except on a local host, where
 * there is no network to cross.
 */
export function matchLogins(vault: Vault, pageUrl: string): LoginMatch[] {
	const page = originOf(pageUrl);
	if (!page) {
		return [];
	}
	const pageHost = hostOf(page);
	const pageIsHttp = page.startsWith('http:');
	const exact: LoginMatch[] = [];
	const sameHost: LoginMatch[] = [];
	for (const entry of vault.logins) {
		if (entry.origin === page) {
			exact.push({ entry, kind: 'exact' });
			continue;
		}
		if (hostOf(entry.origin) !== pageHost) {
			continue;
		}
		const downgrade = pageIsHttp && entry.origin.startsWith('https:') && !localHosts.has(pageHost ?? '');
		if (!downgrade) {
			sameHost.push({ entry, kind: 'sameHost' });
		}
	}
	const byUse = (a: LoginMatch, b: LoginMatch) =>
		(b.entry.lastUsed ?? b.entry.updated) - (a.entry.lastUsed ?? a.entry.updated);
	return [...exact.sort(byUse), ...sameHost.sort(byUse)];
}

/**
 * Whether `rpId` may be used from a page on `host`, by the WebAuthn rule:
 * the RP ID is the host itself or a registrable suffix of it.
 *
 * The browser enforces this again before any authenticator is asked; this copy
 * decides only which saved passkeys are worth listing, so a page cannot get a
 * credential of another site's *offered* to the user under its own name.
 */
export function rpIdMatchesHost(rpId: string, host: string): boolean {
	const id = rpId.toLowerCase();
	const h = host.toLowerCase();
	if (!id || id.startsWith('.') || id.endsWith('.')) {
		return false;
	}
	return h === id || (h.endsWith('.' + id) && id.includes('.'));
}

/** Saved passkeys for a relying party, most recently used first. */
export function passkeysFor(vault: Vault, rpId: string, allowCredentials?: readonly string[]): PasskeyEntry[] {
	const allowed = allowCredentials && allowCredentials.length > 0
		? new Set(allowCredentials.map(toStandardBase64))
		: undefined;
	return vault.passkeys
		.filter(p => p.rpId === rpId && (!allowed || allowed.has(toStandardBase64(p.credentialId))))
		.sort((a, b) => (b.lastUsed ?? b.created) - (a.lastUsed ?? a.created));
}

/**
 * The same bytes in standard base64 with padding.
 *
 * A page names credentials in base64url (`PublicKeyCredential.id`), CDP in
 * standard base64 — comparing them as strings misses every match.
 */
export function toStandardBase64(value: string): string {
	const standard = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
	return standard + '='.repeat((4 - standard.length % 4) % 4);
}

export function isNeverSave(vault: Vault, origin: string): boolean {
	return vault.neverSave.includes(origin);
}

/** What a submitted form means against what is already saved. */
export type SaveDecision =
	| { readonly kind: 'none'; readonly reason: 'neverSave' | 'unchanged' | 'empty' }
	| { readonly kind: 'save' }
	| { readonly kind: 'update'; readonly entry: LoginEntry };

/**
 * Save, update, or say nothing — for a username and password that just left a
 * page on `origin`.
 *
 * - the origin is on the never list → nothing;
 * - the same username (case-insensitively) is saved with the same password →
 *   nothing (the caller bumps `lastUsed`);
 * - the same username with another password → update that one;
 * - no username was found, and exactly one login is saved for the origin →
 *   update it if the password differs: a password-only step of a multi-step
 *   sign-in, or a change-password form, is about the account already saved;
 * - no username, and the password matches a saved one → nothing;
 * - otherwise → save as new.
 *
 * `previousPassword` is the current password of a change-password form. When
 * it matches a saved login of the origin, that login is the one being changed,
 * whatever its username — the form rarely shows one.
 */
export function decideSave(
	vault: Vault,
	origin: string,
	username: string,
	password: string,
	previousPassword?: string,
): SaveDecision {
	if (!password) {
		return { kind: 'none', reason: 'empty' };
	}
	if (isNeverSave(vault, origin)) {
		return { kind: 'none', reason: 'neverSave' };
	}
	const forOrigin = vault.logins.filter(entry => entry.origin === origin);

	if (previousPassword && previousPassword !== password) {
		const changed = forOrigin.filter(entry => entry.password === previousPassword
			&& (!username || sameUsername(entry.username, username)));
		if (changed.length === 1) {
			return { kind: 'update', entry: changed[0] };
		}
	}

	if (username) {
		const same = forOrigin.find(entry => sameUsername(entry.username, username));
		if (!same) {
			return { kind: 'save' };
		}
		return same.password === password
			? { kind: 'none', reason: 'unchanged' }
			: { kind: 'update', entry: same };
	}

	if (forOrigin.some(entry => entry.password === password)) {
		return { kind: 'none', reason: 'unchanged' };
	}
	if (forOrigin.length === 1) {
		return { kind: 'update', entry: forOrigin[0] };
	}
	return { kind: 'save' };
}

/**
 * Whether two usernames name one account.
 *
 * Case-insensitive, as Bitwarden compares them: an email address typed
 * `Me@Example.com` on one visit and `me@example.com` on the next is one
 * account, and treating them as two would offer a second login instead of an
 * update. Two accounts on one site differing only in case are not a real
 * shape. The login keeps the spelling it was saved with.
 */
export function sameUsername(a: string, b: string): boolean {
	return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

/** Adds a login, or replaces the one with the same id. */
export function putLogin(vault: Vault, entry: LoginEntry): Vault {
	const others = vault.logins.filter(existing => existing.id !== entry.id);
	return { ...vault, logins: [...others, entry] };
}

export function removeLogin(vault: Vault, id: string): Vault {
	return { ...vault, logins: vault.logins.filter(entry => entry.id !== id) };
}

export function putPasskey(vault: Vault, entry: PasskeyEntry): Vault {
	const others = vault.passkeys.filter(existing => existing.id !== entry.id);
	return { ...vault, passkeys: [...others, entry] };
}

export function removePasskey(vault: Vault, id: string): Vault {
	return { ...vault, passkeys: vault.passkeys.filter(entry => entry.id !== id) };
}

export function setNeverSave(vault: Vault, origin: string, never: boolean): Vault {
	const rest = vault.neverSave.filter(existing => existing !== origin);
	return { ...vault, neverSave: never ? [...rest, origin] : rest };
}

/** The vault as stored: a versioned envelope, so a later format can tell. */
export function serializeVault(vault: Vault): string {
	return JSON.stringify({
		format: vaultFormat,
		version: vaultVersion,
		logins: [...vault.logins, ...(vault.unreadable?.logins ?? [])],
		passkeys: [...vault.passkeys, ...(vault.unreadable?.passkeys ?? [])],
		neverSave: vault.neverSave,
		...(vault.revision ? { revision: vault.revision } : {}),
	});
}

/**
 * Reads a stored vault, or `undefined` when the text is not one.
 *
 * **`undefined` is not "empty", and the caller must not treat it so.** A vault
 * that cannot be read still holds somebody's passwords; writing a fresh one
 * over it is how every one of them is lost — the rule recorded for config files
 * as breaks-silently #101, and the stakes are higher here. A *newer* version is
 * `undefined` for the same reason: this build cannot know what it would drop.
 *
 * Individual entries are read leniently instead. One malformed login — a hand
 * edit, a bug in another build — is left out of the lists rather than making
 * the whole vault unreadable, and kept in `unreadable` so the next write puts
 * it back exactly as it was; `dropped` says how many.
 */
export function parseVault(text: string): { vault: Vault; dropped: number } | undefined {
	let raw: any;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== 'object' || raw.format !== vaultFormat
		|| typeof raw.version !== 'number' || raw.version > vaultVersion) {
		return undefined;
	}
	// A collection that is there but not a list is a vault this build cannot
	// read, not an empty one. Read as empty, `"logins": {…}` was dropped on the
	// next write with everything in it — the entry-level care below kept every
	// malformed *entry* and lost a malformed *list* whole.
	for (const key of ['logins', 'passkeys', 'neverSave']) {
		if (raw[key] !== undefined && !Array.isArray(raw[key])) {
			return undefined;
		}
	}
	const logins: LoginEntry[] = [];
	const unreadableLogins: unknown[] = [];
	for (const item of Array.isArray(raw.logins) ? raw.logins : []) {
		const entry = readLogin(item);
		if (entry) {
			logins.push(entry);
		} else {
			unreadableLogins.push(item);
		}
	}
	const passkeys: PasskeyEntry[] = [];
	const unreadablePasskeys: unknown[] = [];
	for (const item of Array.isArray(raw.passkeys) ? raw.passkeys : []) {
		const entry = readPasskey(item);
		if (entry) {
			passkeys.push(entry);
		} else {
			unreadablePasskeys.push(item);
		}
	}
	const neverSave = (Array.isArray(raw.neverSave) ? raw.neverSave : [])
		.filter((origin: unknown): origin is string => typeof origin === 'string' && originOf(origin) === origin);
	const dropped = unreadableLogins.length + unreadablePasskeys.length;
	return {
		vault: {
			logins, passkeys, neverSave,
			...(typeof raw.revision === 'string' && raw.revision ? { revision: raw.revision } : {}),
			...(dropped > 0 ? { unreadable: { logins: unreadableLogins, passkeys: unreadablePasskeys } } : {}),
		},
		dropped,
	};
}

const str = (value: unknown): value is string => typeof value === 'string';
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function readLogin(item: any): LoginEntry | undefined {
	if (!item || !str(item.id) || !str(item.origin) || originOf(item.origin) !== item.origin
		|| !str(item.username) || !str(item.password) || !time(item.created) || !time(item.updated)) {
		return undefined;
	}
	return {
		id: item.id,
		origin: item.origin,
		username: item.username,
		password: item.password,
		...(str(item.title) ? { title: item.title } : {}),
		...(str(item.note) ? { note: item.note } : {}),
		created: item.created,
		updated: item.updated,
		...(time(item.lastUsed) ? { lastUsed: item.lastUsed } : {}),
	};
}

function readPasskey(item: any): PasskeyEntry | undefined {
	if (!item || !str(item.id) || !str(item.rpId) || !item.rpId || !str(item.credentialId) || !item.credentialId
		|| !str(item.privateKey) || !item.privateKey || !time(item.signCount) || !time(item.created)) {
		return undefined;
	}
	return {
		id: item.id,
		rpId: item.rpId,
		credentialId: item.credentialId,
		...(str(item.userHandle) ? { userHandle: item.userHandle } : {}),
		...(str(item.userName) ? { userName: item.userName } : {}),
		...(str(item.userDisplayName) ? { userDisplayName: item.userDisplayName } : {}),
		privateKey: item.privateKey,
		signCount: item.signCount,
		...(str(item.origin) ? { origin: item.origin } : {}),
		created: item.created,
		...(time(item.lastUsed) ? { lastUsed: item.lastUsed } : {}),
	};
}

/** How an import treats a login that is saved here with another password. */
export type ConflictPolicy = 'replace' | 'keep';

export interface MergeReport {
	readonly vault: Vault;
	readonly added: number;
	readonly updated: number;
	readonly unchanged: number;
	/** Saved here with another password and left alone, under `keep`. */
	readonly kept: number;
	/** Rows of the import that repeated an origin and username already in it, and were not used. */
	readonly duplicates: number;
}

const loginKey = (origin: string, username: string) => `${origin}\n${username.toLocaleLowerCase()}`;

/**
 * The logins of an import that the merge will consider: one per origin and
 * username — **the most recently changed** — plus how many were set aside.
 *
 * Not the first: a file with the same account twice (Chrome keeps one per
 * path) put whichever came first into the vault, which could be the stale one
 * while the file also held the current password. Rows without a date keep
 * their order. Shared by {@link countConflicts} and {@link mergeVault}, so the
 * question the user is asked and the merge that applies the answer see the
 * same rows. Indexed, not searched: the file may hold a million rows.
 */
function distinctLogins(incoming: readonly LoginEntry[]): { logins: LoginEntry[]; duplicates: number } {
	const chosen = new Map<string, LoginEntry>();
	let duplicates = 0;
	for (const entry of incoming) {
		const key = loginKey(entry.origin, entry.username);
		const held = chosen.get(key);
		if (!held) {
			chosen.set(key, entry);
			continue;
		}
		duplicates++;
		if (entry.updated > held.updated) {
			chosen.set(key, entry);
		}
	}
	return { logins: [...chosen.values()], duplicates };
}

/** Saved logins by origin and username, for lookups that would otherwise scan the vault per row. */
function indexLogins(logins: readonly LoginEntry[]): Map<string, number> {
	const index = new Map<string, number>();
	logins.forEach((entry, at) => {
		const key = loginKey(entry.origin, entry.username);
		if (!index.has(key)) {
			index.set(key, at);
		}
	});
	return index;
}

/**
 * How many incoming logins collide with a saved one on origin and username but
 * not password. Usernames compare without case, as everywhere else: `Me@x` in
 * the vault and `me@x` in a file are one account, and comparing them exactly
 * imported a second copy without asking which password wins.
 */
export function countConflicts(vault: Vault, incoming: readonly LoginEntry[]): number {
	const index = indexLogins(vault.logins);
	return distinctLogins(incoming).logins.filter(entry => {
		const at = index.get(loginKey(entry.origin, entry.username));
		return at !== undefined && vault.logins[at].password !== entry.password;
	}).length;
}

/**
 * Folds an import into the vault.
 *
 * A login is the same login when origin and username agree — ids are local to
 * one vault and mean nothing across two. A passkey is the same passkey when
 * the relying party and credential id agree, and the copy with the higher
 * signature counter wins whatever the policy: going backwards on it is what a
 * relying party reads as a cloned authenticator.
 */
export function mergeVault(
	vault: Vault,
	incoming: { logins: readonly LoginEntry[]; passkeys?: readonly PasskeyEntry[]; neverSave?: readonly string[] },
	policy: ConflictPolicy,
	now: number,
): MergeReport {
	let added = 0;
	let updated = 0;
	let unchanged = 0;
	let kept = 0;
	const logins = [...vault.logins];
	const index = indexLogins(logins);
	const distinct = distinctLogins(incoming.logins);
	for (const entry of distinct.logins) {
		const key = loginKey(entry.origin, entry.username);
		const at = index.get(key);
		if (at === undefined) {
			index.set(key, logins.length);
			logins.push({ ...entry, id: newId() });
			added++;
			continue;
		}
		const existing = logins[at];
		if (existing.password === entry.password) {
			unchanged++;
			continue;
		}
		if (policy === 'keep') {
			kept++;
			continue;
		}
		logins[at] = {
			...existing,
			password: entry.password,
			updated: Math.max(entry.updated, now),
			...(entry.title && !existing.title ? { title: entry.title } : {}),
			...(entry.note && !existing.note ? { note: entry.note } : {}),
		};
		updated++;
	}

	const passkeys = [...vault.passkeys];
	for (const entry of incoming.passkeys ?? []) {
		const at = passkeys.findIndex(existing => existing.rpId === entry.rpId
			&& toStandardBase64(existing.credentialId) === toStandardBase64(entry.credentialId));
		if (at === -1) {
			passkeys.push({ ...entry, id: newId() });
			added++;
		} else if (entry.signCount > passkeys[at].signCount) {
			passkeys[at] = { ...passkeys[at], signCount: entry.signCount };
			updated++;
		} else {
			unchanged++;
		}
	}

	const neverSave = [...new Set([...vault.neverSave, ...(incoming.neverSave ?? [])])];
	return { vault: { ...vault, logins, passkeys, neverSave }, added, updated, unchanged, kept, duplicates: distinct.duplicates };
}
