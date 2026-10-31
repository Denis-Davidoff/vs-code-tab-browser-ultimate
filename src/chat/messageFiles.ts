import type { ChangedFile, ChatEntry, ToolEntry } from './chatProtocol';

export interface MessageFile extends ChangedFile {
	readonly entry: number;
}

const normalizedPath = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '');

/** Browser-safe path display, including files reached through ../ outside the project. */
export function messageFileLabel(file: string, root?: string): string {
	if (!root) { return normalizedPath(file); }
	const absolute = (p: string) => p.startsWith('/') || /^[a-z]:\//i.test(p);
	const resolve = (p: string) => {
		const parts: string[] = [];
		for (const part of p.split('/')) {
			if (part === '..') { if (parts.length && parts.at(-1) !== '' && !/^[a-z]:$/i.test(parts.at(-1)!)) { parts.pop(); } }
			else if (part !== '.') { parts.push(part); }
		}
		return parts.join('/').replace(/\/$/, '') || '/';
	};
	const base = resolve(normalizedPath(root));
	const name = normalizedPath(file);
	const full = resolve(absolute(name) ? name : `${base}/${name}`);
	const prefix = base.endsWith('/') ? base : `${base}/`;
	const windows = /^[a-z]:\//i.test(base) || base.startsWith('//');
	return (windows ? full.toLowerCase().startsWith(prefix.toLowerCase()) : full.startsWith(prefix))
		? full.slice(prefix.length) : full;
}

/** Only recorded patches for this file and turn; never substitute today's working file. */
export function messageFileDiff(entries: readonly ChatEntry[], rows: readonly number[], file: string): string | undefined {
	const patches: string[] = [];
	const matches = (p: string) => normalizedPath(p) === normalizedPath(file);
	for (const row of rows) {
		const tool = entries[row];
		if (tool?.kind !== 'tool' || tool.status !== 'done' || (tool.exitCode !== undefined && tool.exitCode !== 0)) { continue; }
		const files = toolChangedFiles(tool);
		if (!files.some(f => matches(f.path))) { continue; }
		let input = tool.input ?? '';
		try {
			const data = JSON.parse(input);
			input = typeof data === 'string' ? data : [data?.patch, data?.input, data?.diff].find(v => typeof v === 'string') ?? input;
		} catch { /* Already a diff. */ }
		const patchHeaders = [...input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)\r?$/gm)];
		const unifiedHeaders = [...input.matchAll(/^--- ([^\n]+)\n\+\+\+ ([^\n]+)\n/gm)];
		let diff: string | undefined;
		if (patchHeaders.length && input.includes('*** Begin Patch')) {
			const i = patchHeaders.findIndex((h, n) => {
				const body = input.slice(h.index! + h[0].length, patchHeaders[n + 1]?.index ?? input.length);
				const moved = /^\*\*\* Move to: (.+)\r?$/m.exec(body)?.[1].trim();
				return matches(h[1].trim()) || (moved !== undefined && matches(moved));
			});
			if (i >= 0) {
				diff = input.slice(patchHeaders[i].index! + patchHeaders[i][0].length, patchHeaders[i + 1]?.index ?? input.length)
					.replace(/^\*\*\* (?:Move to:.*|End Patch|End of File)\r?\n?/gm, '').trimEnd().replace(/^\r?\n/, '');
			}
		} else if (unifiedHeaders.length) {
			const clean = (p: string) => p.split('\t')[0].trim();
			const i = unifiedHeaders.findIndex(h => {
				const before = clean(h[1]), after = clean(h[2]);
				const prefixed = before.startsWith('a/') && after.startsWith('b/') || before === '/dev/null' && after.startsWith('b/') || after === '/dev/null' && before.startsWith('a/');
				return [before, after].filter(p => p !== '/dev/null').some(p => matches(prefixed ? p.slice(2) : p));
			});
			if (i >= 0) { diff = input.slice(unifiedHeaders[i].index! + unifiedHeaders[i][0].length, unifiedHeaders[i + 1]?.index ?? input.length).split(/\ndiff --git /)[0].trimEnd(); }
		} else if (files.length === 1 && tool.tool === 'edit' && /^[+-]/m.test(input)) {
			diff = input;
		}
		if (diff?.trim()) { patches.push(diff); }
	}
	return patches.length ? patches.join('\n@@\n') : undefined;
}

function counts(diff: string): { added: number; removed: number } {
	const lines = diff.split('\n');
	return {
		added: lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length,
		removed: lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length,
	};
}

/** Recover file operations from older transcripts that lack structured file metadata. */
export function toolChangedFiles(tool: ToolEntry): readonly ChangedFile[] {
	if (tool.files?.length) {
		return tool.files.length === 1 ? [{ ...tool.files[0], added: tool.files[0].added ?? tool.added, removed: tool.files[0].removed ?? tool.removed }] : tool.files;
	}
	let input = tool.input ?? '';
	try {
		const data = JSON.parse(input);
		if (typeof data === 'string') { input = data; }
		else if (data && typeof data === 'object') {
			input = [data.patch, data.input, data.diff].find(v => typeof v === 'string') ?? input;
		}
	} catch { /* Plain diff or command text. */ }
	const patch = [...input.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)\r?$/gm)];
	if (patch.length && input.includes('*** Begin Patch')) {
		return patch.flatMap((m, i): ChangedFile[] => {
			const body = input.slice(m.index! + m[0].length, patch[i + 1]?.index ?? input.length);
			const path = m[2].trim();
			const move = /^\*\*\* Move to: (.+)\r?$/m.exec(body);
			if (move) { return [{ path, status: 'deleted' }, { path: move[1].trim(), status: 'created', ...counts(body) }]; }
			return [{ path, status: m[1] === 'Add' ? 'created' : m[1] === 'Delete' ? 'deleted' : 'modified',
				...(m[1] === 'Delete' ? {} : counts(body)) }];
		});
	}
	if (tool.tool !== 'edit') { return []; }
	const headers = [...input.matchAll(/^--- ([^\n]+)\n\+\+\+ ([^\n]+)\n/gm)];
	if (headers.length) {
		const clean = (path: string) => path.split('\t')[0].trim();
		return headers.map((m, i) => {
			const before = clean(m[1]);
			const after = clean(m[2]);
			const prefixed = before.startsWith('a/') && after.startsWith('b/') || before === '/dev/null' && after.startsWith('b/') || after === '/dev/null' && before.startsWith('a/');
			const path = after === '/dev/null' ? before : after;
			return {
				path: prefixed ? path.slice(2) : path,
				status: before === '/dev/null' ? 'created' : after === '/dev/null' ? 'deleted' : 'modified',
				...counts(input.slice(m.index, headers[i + 1]?.index ?? input.length)),
			};
		});
	}
	if (!tool.detail || /^\d+ files?$/.test(tool.detail)) { return []; }
	// A Write can overwrite an existing file. Only an explicit result proves creation.
	const created = /(?:file created|created (?:a )?new file|successfully created)/i.test(tool.output ?? '');
	return [{ path: tool.detail, status: created ? 'created' : 'modified', added: tool.added, removed: tool.removed }];
}

/** Successful file operations for one user message, accumulated once per path. */
export function messageFiles(entries: readonly ChatEntry[], rows: readonly number[]): MessageFile[] {
	const files = new Map<string, MessageFile>();
	for (const index of rows) {
		const tool = entries[index];
		if (tool?.kind !== 'tool' || tool.status !== 'done' || (tool.exitCode !== undefined && tool.exitCode !== 0)) { continue; }
		for (const file of toolChangedFiles(tool)) {
			const path = file.path.replace(/\\/g, '/').replace(/^\.\//, '');
			if (!path || path === '/dev/null') { continue; }
			const previous = files.get(path);
			const status = previous?.status === 'created' && file.status === 'modified' ? 'created'
				: previous?.status === 'deleted' && file.status === 'created' ? 'modified' : file.status;
			const sum = (a: number | undefined, b: number | undefined) => a === undefined || b === undefined ? undefined : a + b;
			files.set(path, { ...file, path, status, entry: index,
				added: previous ? sum(previous.added, file.added) : file.added,
				removed: previous ? sum(previous.removed, file.removed) : file.removed });
		}
	}
	return [...files.values()];
}
