/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Logins to and from the CSV that every browser and password manager exports.
 * No `vscode`, no relative value imports — `npm test` loads this directly.
 *
 * CSV is the migration format, not a storage one: it carries every password in
 * clear and cannot carry a passkey at all. The encrypted export in
 * `vaultSeal.ts` is the one that round-trips this vault.
 */

/** A login read from a file, before it has an id or a place in the vault. */
export interface CsvLogin {
	/**
	 * Every address the row names, in order. Usually one; Bitwarden puts all of
	 * a login's URIs in one cell, joined with commas (its own importer reads the
	 * cell as a CSV row of its own), and an app URI can come first. Which of
	 * them is a web address is decided by the caller, which has `originOf`.
	 */
	readonly urls: readonly string[];
	readonly username: string;
	readonly password: string;
	readonly title?: string;
	readonly note?: string;
	/** Milliseconds since the epoch, where the file says (Firefox does). */
	readonly created?: number;
	readonly updated?: number;
	readonly lastUsed?: number;
}

export interface CsvReadResult {
	readonly logins: readonly CsvLogin[];
	/** Rows with no address or no password — a note, a card, an app login. */
	readonly skipped: number;
}

/**
 * Splits CSV text into rows of fields, by RFC 4180.
 *
 * Quoted fields may hold commas, line breaks and doubled quotes; both line
 * endings are accepted, and a byte-order mark is ignored. A quote in the
 * middle of an unquoted field is kept as a character, the way spreadsheet
 * programs read it.
 */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	let fieldStarted = false;
	const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (quoted) {
			if (ch === '"') {
				if (source[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					quoted = false;
				}
			} else {
				field += ch;
			}
			continue;
		}
		if (ch === '"' && !fieldStarted) {
			quoted = true;
			fieldStarted = true;
		} else if (ch === ',') {
			row.push(field);
			field = '';
			fieldStarted = false;
		} else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && source[i + 1] === '\n') {
				i++;
			}
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
			fieldStarted = false;
		} else {
			field += ch;
			fieldStarted = true;
		}
	}
	if (fieldStarted || field || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter(cells => cells.some(cell => cell !== ''));
}

/**
 * Header names, lower-cased, by what they mean.
 *
 * Chrome and Edge: `name,url,username,password,note`. Firefox:
 * `url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged`.
 * Safari: `Title,URL,Username,Password,Notes,OTPAuth`. Bitwarden:
 * `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp`.
 * 1Password: `Title,Url,Username,Password,…`. Order never matters — only names.
 */
const columns = {
	url: ['url', 'login_uri', 'website', 'web site', 'uri', 'login url', 'origin'],
	username: ['username', 'login_username', 'user name', 'login', 'email', 'user', 'login name'],
	password: ['password', 'login_password'],
	title: ['name', 'title'],
	note: ['note', 'notes', 'extra'],
	type: ['type'],
	created: ['timecreated'],
	updated: ['timepasswordchanged'],
	lastUsed: ['timelastused'],
} as const;

type Column = keyof typeof columns;

/** Reads logins from CSV text, or `undefined` when it has no address and password columns. */
export function loginsFromCsv(text: string): CsvReadResult | undefined {
	const rows = parseCsv(text);
	if (rows.length === 0) {
		return undefined;
	}
	const header = rows[0].map(name => name.trim().toLowerCase());
	const index = {} as Record<Column, number>;
	// By alias first, then position: a file with both `email` and `username`
	// means the second, whichever comes first in the header.
	for (const column of Object.keys(columns) as Column[]) {
		index[column] = -1;
		for (const alias of columns[column]) {
			const at = header.indexOf(alias);
			if (at !== -1) {
				index[column] = at;
				break;
			}
		}
	}
	if (index.url === -1 || index.password === -1) {
		return undefined;
	}
	const cell = (row: string[], column: Column) => index[column] === -1 ? '' : (row[index[column]] ?? '');
	const timeCell = (row: string[], column: Column) => {
		const value = Number(cell(row, column));
		return Number.isFinite(value) && value > 0 ? value : undefined;
	};

	const logins: CsvLogin[] = [];
	let skipped = 0;
	for (const row of rows.slice(1)) {
		const type = cell(row, 'type').trim().toLowerCase();
		const url = cell(row, 'url').trim();
		const password = cell(row, 'password');
		// Bitwarden exports notes, cards and identities in the same file.
		if ((type && type !== 'login') || !url || !password) {
			skipped++;
			continue;
		}
		const title = cell(row, 'title').trim();
		const note = cell(row, 'note');
		const created = timeCell(row, 'created');
		const updated = timeCell(row, 'updated');
		const lastUsed = timeCell(row, 'lastUsed');
		logins.push({
			// Split on commas as well as line breaks. Reading the whole cell as
			// one address made `https://a.com,https://b.com` the origin
			// `https://a.com,https` — valid to every check, matching no page ever.
			// A comma inside one address only splits off its query string, which
			// no origin needs.
			urls: url.split(/[\r\n,]+/).map(part => part.trim()).filter(Boolean),
			username: cell(row, 'username'),
			password,
			...(title ? { title } : {}),
			...(note ? { note } : {}),
			...(created ? { created } : {}),
			...(updated ? { updated } : {}),
			...(lastUsed ? { lastUsed } : {}),
		});
	}
	return { logins, skipped };
}

function csvField(value: string): string {
	return /[",\r\n]/.test(value) || value !== value.trim()
		? `"${value.replace(/"/g, '""')}"`
		: value;
}

/**
 * Writes logins in Chrome's layout, which every importer reads.
 *
 * Values are written as they are. Prefixing a cell that starts with `=` — the
 * usual guard against spreadsheet formulas — would change the password itself,
 * and a password manager's export has to round-trip exactly; the warning before
 * writing the file is where that risk is stated.
 */
export function loginsToCsv(logins: readonly { origin: string; username: string; password: string; title?: string; note?: string }[]): string {
	const lines = ['name,url,username,password,note'];
	for (const login of logins) {
		lines.push([login.title ?? '', login.origin, login.username, login.password, login.note ?? '']
			.map(csvField).join(','));
	}
	return lines.join('\r\n') + '\r\n';
}
