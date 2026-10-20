import type { FileThemeIcon } from './chatProtocol';

/**
 * The selected file icon theme, reduced to what the chat view needs to put the
 * Explorer's icon in front of a file name: the theme's associations with the
 * light or high-contrast ones already merged in, its definitions resolved to
 * webview resources, and the editor's languages by file name and extension.
 * Every key is lower case. Built by `loadFileIconTable` on the host; read here,
 * in both builds — this module imports nothing.
 */
export interface FileIconTable {
	/** The theme's font files, once each; an icon names its font by index. */
	readonly fonts: readonly string[];
	/** Only the definitions the merged associations below can reach. */
	readonly icons: Readonly<Record<string, TableIcon>>;
	readonly file?: string;
	readonly folder?: string;
	readonly fileNames: Readonly<Record<string, string>>;
	readonly fileExtensions: Readonly<Record<string, string>>;
	readonly folderNames: Readonly<Record<string, string>>;
	readonly languageIds: Readonly<Record<string, string>>;
	readonly languageByName: Readonly<Record<string, string>>;
	readonly languageByExtension: Readonly<Record<string, string>>;
}

/** A definition as the table carries it: its font by index into `fonts`, not by address. */
export interface TableIcon {
	readonly image?: string;
	readonly character?: string;
	readonly font?: number;
	readonly color?: string;
	readonly size?: string;
}

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
	Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;

/**
 * The icon for a path — a folder when it ends with `/` — in VS Code's order:
 * the file's name, its extensions longest first (`spec.ts` before `ts`), its
 * language, then the theme's default. `undefined` where the theme has none,
 * and the caller draws a codicon instead.
 */
export function resolveFileIcon(table: FileIconTable, path: string): FileThemeIcon | undefined {
	const folder = /[\\/]$/.test(path);
	const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
	if (!name) { return undefined; }
	let id: string | undefined;
	if (folder) {
		id = own(table.folderNames, name) ?? table.folder;
	} else {
		id = own(table.fileNames, name);
		const suffixes: string[] = [];
		for (let dot = name.indexOf('.'); dot >= 0; dot = name.indexOf('.', dot + 1)) {
			suffixes.push(name.slice(dot + 1));
		}
		for (const suffix of suffixes) {
			if (id) { break; }
			id = own(table.fileExtensions, suffix);
		}
		let language = own(table.languageByName, name);
		for (const suffix of suffixes) {
			if (language) { break; }
			language = own(table.languageByExtension, suffix);
		}
		id ??= (language ? own(table.languageIds, language) : undefined) ?? table.file;
	}
	const icon = id ? own(table.icons, id) : undefined;
	if (!icon) { return undefined; }
	const font = icon.font !== undefined ? table.fonts[icon.font] : undefined;
	return { image: icon.image, character: icon.character, font, color: icon.color, size: icon.size };
}

const pathToken = /^(?:~|\.{1,2}|[\p{L}\p{N}_@+.-]+)?(?:[\\/][\p{L}\p{N}_@+.-]+)*[\\/]?$/u;

/**
 * Whether a token of a message names a file, so it gets an icon in front.
 * Anywhere: a path with a `/` whose last part has an extension (`src/a.ts`,
 * `./x.json`, `src/chat/`), or a dotted name the theme knows (`package.json`).
 * Extensionless names need a path or inline code: theme associations such as
 * `version` and `changelog` also match ordinary prose.
 * Markdown document names are also recognized by extension in prose, even if
 * the theme only has a special association for README.md. Inline code also
 * accepts a bare name with an extension the theme or a language knows
 * (`chat.ts`) — in prose that would put an icon before "Node.js".
 */
export function namesFile(table: FileIconTable, token: string, code: boolean): boolean {
	if (token.length > 260 || !pathToken.test(token) || !/\p{L}/u.test(token)) { return false; }
	const folder = /[\\/]$/.test(token);
	const trimmed = token.replace(/[\\/]+$/, '');
	const slash = /[\\/]/.test(trimmed);
	const name = trimmed.split(/[\\/]/).pop()?.toLowerCase() ?? '';
	if (!name || name === '.' || name === '..') { return false; }
	if (folder) { return slash || code; }
	if (own(table.fileNames, name)) { return slash || code || name.includes('.'); }
	const dot = name.indexOf('.', 1);
	const known = (() => {
		for (let at = name.indexOf('.'); at >= 0; at = name.indexOf('.', at + 1)) {
			const suffix = name.slice(at + 1);
			if (own(table.fileExtensions, suffix) || own(table.languageByExtension, suffix)) { return true; }
		}
		return false;
	})();
	const markdown = /\.(?:md|markdown|mdown|mkdn|mkd)$/.test(name);
	return known ? slash || code || markdown : slash && dot > 0 && dot < name.length - 1;
}
