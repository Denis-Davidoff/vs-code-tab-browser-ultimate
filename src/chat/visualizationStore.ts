import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/** Bounded before decoding, including files which grow during the read. */
export const visualizationByteLimit = 1_000_000;
export const visualizationTotalLimit = 2_000_000;

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** One conversation's source directory and immutable, host-owned snapshots. */
export class VisualizationStore {
	readonly directory: string;
	private readonly _archive: string;
	private readonly _cache = new Map<string, string>();
	constructor(project: string, archive: string, chatId: string) {
		const scope = hash(chatId).slice(0, 32);
		this.directory = path.join(project, '.ai-browser', 'visualizations', scope);
		this._archive = path.join(archive, scope);
	}

	/** Refuse linked directory components, including a malicious .ai-browser in a checkout. */
	async prepare(): Promise<string> {
		const project = path.resolve(this.directory, '../../..');
		const actual = await fs.realpath(project);
		for (const directory of [path.join(actual, '.ai-browser'), path.join(actual, '.ai-browser', 'visualizations'), path.join(actual, '.ai-browser', 'visualizations', path.basename(this.directory))]) {
			await fs.mkdir(directory, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') { throw e; } });
			const stat = await fs.lstat(directory);
			if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new Error('The visualization directory must not contain symbolic links.'); }
		}
		const expected = path.join(actual, '.ai-browser', 'visualizations', path.basename(this.directory));
		if (await fs.realpath(this.directory) !== expected) {
			throw new Error('The visualization directory changed.');
		}
		await fs.writeFile(path.join(actual, '.ai-browser', 'visualizations', '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') { throw e; } });
		return expected;
	}

	async publish(file: string): Promise<{ id: string; revision: string; html: string }> {
		if (!path.isAbsolute(file) || /[\x00-\x1f]/.test(file) || !/\.html?$/i.test(file)) { throw new Error('Use an absolute path to an HTML file.'); }
		// Direct children only: no descendant directories to swap while opening a file.
		if (path.dirname(path.resolve(file)) !== path.resolve(this.directory)) { throw new Error('Write the HTML file directly inside this conversation\'s visualization directory.'); }
		const root = await this.prepare();
		const target = path.join(root, path.basename(file));
		const html = await readRegular(target);
		if (await fs.realpath(this.directory) !== root || await fs.realpath(target) !== target) { throw new Error('The visualization file changed location.'); }
		const revision = hash(html);
		const id = hash(path.basename(file)).slice(0, 32);
		await fs.mkdir(this._archive, { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(this._archive, `${revision}.html`), html, { flag: 'wx', mode: 0o600 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') { throw e; } });
		this._remember(revision, html);
		return { id, revision, html };
	}

	async load(revision: string): Promise<string | undefined> {
		if (!/^[a-f0-9]{64}$/.test(revision)) { return undefined; }
		const cached = this._cache.get(revision);
		if (cached !== undefined) { return cached; }
		try {
			const html = await readRegular(path.join(this._archive, `${revision}.html`));
			if (hash(html) !== revision) { return undefined; }
			this._remember(revision, html);
			return html;
		} catch { return undefined; }
	}

	private _remember(revision: string, html: string): void {
		this._cache.delete(revision);
		this._cache.set(revision, html);
		let bytes = [...this._cache.values()].reduce((sum, value) => sum + Buffer.byteLength(value), 0);
		while (bytes > visualizationTotalLimit && this._cache.size > 1) {
			const key = this._cache.keys().next().value!;
			bytes -= Buffer.byteLength(this._cache.get(key)!);
			this._cache.delete(key);
		}
	}
}

async function readRegular(file: string): Promise<string> {
	// O_NONBLOCK prevents a FIFO from blocking before fstat can reject it.
	const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size > visualizationByteLimit) { throw new Error('Use a regular HTML file of at most 1 MB, without hard links.'); }
		const bytes = Buffer.alloc(visualizationByteLimit + 1);
		let length = 0;
		while (length < bytes.length) {
			const chunk = await handle.read(bytes, length, bytes.length - length, null);
			if (!chunk.bytesRead) { break; }
			length += chunk.bytesRead;
		}
		const after = await handle.stat();
		if (length > visualizationByteLimit || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) { throw new Error('The HTML file is still being written. Publish it after the write finishes.'); }
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
	} finally { await handle.close(); }
}
