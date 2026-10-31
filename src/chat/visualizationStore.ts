import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import type { ArtifactKind, ArtifactSnapshot, TableData, SourceData } from './visualizationProtocol';
import { createHash } from 'node:crypto';

/** Bounded before decoding, including files which grow during the read. */
export const visualizationByteLimit = 1_000_000;
export const visualizationTotalLimit = 2_000_000;
export const imageByteLimit = 4_000_000;
/** Includes base64 expansion and HTML, below the remote relay frame limit. */
export const presentationTotalLimit = 6_000_000;

const hash = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');

/** One conversation's source directory and immutable, host-owned snapshots. */
export class VisualizationStore {
	readonly directory: string;
	private readonly _archive: string;
	private readonly _cache = new Map<string, string>();
	private readonly _artifacts = new Map<string, ArtifactSnapshot>();
	private readonly _images = new Map<string, { mimeType: string; base64: string }>();
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

	/** Images use the same conversation directory, with a separate binary archive. */
	async publishImage(file: string): Promise<{ id: string; revision: string }> {
		if (!path.isAbsolute(file) || /[\x00-\x1f]/.test(file) || !/\.(png|jpe?g|gif|webp)$/i.test(file)) { throw new Error('Use an absolute path to a PNG, JPEG, GIF or WebP image.'); }
		if (path.dirname(path.resolve(file)) !== path.resolve(this.directory)) { throw new Error("Copy the image directly inside this conversation's visualization directory before publishing it."); }
		const root = await this.prepare();
		const target = path.join(root, path.basename(file));
		const bytes = await readRegularBytes(target, imageByteLimit);
		if (await fs.realpath(this.directory) !== root || await fs.realpath(target) !== target) { throw new Error('The image changed location.'); }
		if (!imageMime(bytes)) { throw new Error('The file is not a supported raster image.'); }
		const revision = hash(bytes);
		await fs.mkdir(this._archive, { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(this._archive, `${revision}.image`), bytes, { flag: 'wx', mode: 0o600 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') { throw e; } });
		return { id: hash(path.basename(file)).slice(0, 32), revision };
	}

	async loadImage(revision: string): Promise<{ mimeType: string; base64: string } | undefined> {
		if (!/^[a-f0-9]{64}$/.test(revision)) { return undefined; }
		const cached = this._images.get(revision);
		if (cached) { return cached; }
		try {
			const bytes = await readRegularBytes(path.join(this._archive, `${revision}.image`), imageByteLimit);
			const mimeType = imageMime(bytes);
			if (!mimeType || hash(bytes) !== revision) { return undefined; }
			const image = { mimeType, base64: bytes.toString('base64') };
			this._images.set(revision, image);
			let size = [...this._images.values()].reduce((sum, value) => sum + value.base64.length, 0);
			while (size > presentationTotalLimit && this._images.size > 1) {
				const oldest = this._images.keys().next().value!;
				size -= this._images.get(oldest)!.base64.length;
				this._images.delete(oldest);
			}
			return image;
		} catch { return undefined; }
	}

	/** Native provider result blocks are already bytes: archive them without a source file. */
	async publishInline(base64: string, kind: 'image' | 'file', name = 'attachment'): Promise<{ id: string; revision: string }> {
		if (base64.length > 5_333_336 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) { throw new Error('Use valid base64 containing at most 4 MB.'); }
		const bytes = Buffer.from(base64, 'base64');
		if (bytes.length > imageByteLimit || bytes.toString('base64').replace(/=+$/, '') !== base64.replace(/=+$/, '')) { throw new Error('Use valid base64 containing at most 4 MB.'); }
		if (kind === 'image' && !imageMime(bytes)) { throw new Error('Unsupported image signature.'); }
		const content = kind === 'image' ? bytes : Buffer.from(JSON.stringify(artifactOf(bytes, name, 'file')));
		const revision = hash(content);
		await fs.mkdir(this._archive, { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(this._archive, `${revision}.${kind === 'image' ? 'image' : 'artifact'}`), content, { flag: 'wx', mode: 0o600 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') { throw e; } });
		return { id: revision.slice(0, 32), revision };
	}

	async publishArtifact(file: string, kind: ArtifactKind): Promise<{ id: string; revision: string }> {
		if (!path.isAbsolute(file) || /[\x00-\x1f]/.test(file)) { throw new Error('Use an absolute path to a completed file.'); }
		if (path.dirname(path.resolve(file)) !== path.resolve(this.directory)) { throw new Error("Copy the file directly inside this conversation's visualization directory."); }
		const root = await this.prepare();
		const target = path.join(root, path.basename(file));
		const bytes = await readRegularBytes(target, kind === 'table' || kind === 'sources' ? visualizationByteLimit : imageByteLimit);
		if (await fs.realpath(this.directory) !== root || await fs.realpath(target) !== target) { throw new Error('The file changed location.'); }
		const artifact = artifactOf(bytes, path.basename(file), kind);
		const serialized = JSON.stringify(artifact);
		const revision = hash(serialized);
		await fs.mkdir(this._archive, { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(this._archive, `${revision}.artifact`), serialized, { flag: 'wx', mode: 0o600 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') { throw e; } });
		return { id: hash(`${kind}:${path.basename(file)}`).slice(0, 32), revision };
	}

	async loadArtifact(revision: string): Promise<ArtifactSnapshot | undefined> {
		if (!/^[a-f0-9]{64}$/.test(revision)) { return undefined; }
		const cached = this._artifacts.get(revision);
		if (cached) { return cached; }
		try {
			const bytes = await readRegularBytes(path.join(this._archive, `${revision}.artifact`), presentationTotalLimit);
			if (hash(bytes) !== revision) { return undefined; }
			const saved = JSON.parse(bytes.toString('utf8')) as ArtifactSnapshot;
			const artifact = artifactOf(Buffer.from(saved.base64, 'base64'), saved.name, saved.kind);
			if (JSON.stringify(artifact) !== bytes.toString('utf8')) { return undefined; }
			this._artifacts.set(revision, artifact);
			let size = [...this._artifacts.values()].reduce((sum, value) => sum + JSON.stringify(value).length, 0);
			while (size > presentationTotalLimit && this._artifacts.size > 1) {
				const oldest = this._artifacts.keys().next().value!;
				size -= JSON.stringify(this._artifacts.get(oldest)!).length;
				this._artifacts.delete(oldest);
			}
			return artifact;
		} catch { return undefined; }
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
	return new TextDecoder('utf-8', { fatal: true }).decode(await readRegularBytes(file, visualizationByteLimit));
}

async function readRegularBytes(file: string, limit: number): Promise<Buffer> {
	// O_NONBLOCK prevents a FIFO from blocking before fstat can reject it.
	const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1 || before.size > limit) { throw new Error(`Use a regular file of at most ${limit / 1_000_000} MB, without hard links.`); }
		const bytes = Buffer.alloc(limit + 1);
		let length = 0;
		while (length < bytes.length) {
			const chunk = await handle.read(bytes, length, bytes.length - length, null);
			if (!chunk.bytesRead) { break; }
			length += chunk.bytesRead;
		}
		const after = await handle.stat();
		if (length > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) { throw new Error('The file is still being written. Publish it after the write finishes.'); }
		return bytes.subarray(0, length);
	} finally { await handle.close(); }
}

/** Determine the MIME from bytes, never from a model-supplied MIME or suffix. SVG stays inert. */
function imageMime(bytes: Buffer): string | undefined {
	if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') { return 'image/png'; }
	if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) { return 'image/jpeg'; }
	if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) { return 'image/gif'; }
	if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') { return 'image/webp'; }
	return undefined;
}

function artifactOf(bytes: Buffer, name: string, kind: ArtifactKind): ArtifactSnapshot {
	if (!['file', 'table', 'sources', 'audio', 'video'].includes(kind) || !name || name.length > 255 || /[\x00-\x1f/\\]/.test(name)) { throw new Error('Invalid artifact kind or file name.'); }
	let mimeType = 'application/octet-stream';
	let table: TableData | undefined;
	let sources: SourceData[] | undefined;
	if (kind === 'table' || kind === 'sources') {
		if (bytes.length > visualizationByteLimit) { throw new Error('Structured data must be at most 1 MB.'); }
		let value: unknown;
		try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('Use a valid UTF-8 JSON file.'); }
		if (kind === 'table') {
			const data = value as TableData | null;
			if (!data || !Array.isArray(data.columns) || !data.columns.length || data.columns.length > 100 || !data.columns.every(c => typeof c === 'string' && c.length <= 200)
				|| !Array.isArray(data.rows) || data.rows.length > 10_000 || !data.rows.every(row => Array.isArray(row) && row.length === data.columns.length && row.every(cell => cell === null || typeof cell === 'boolean' || typeof cell === 'number' && Number.isFinite(cell) || typeof cell === 'string' && cell.length <= 10_000))) {
				throw new Error('Table JSON requires columns (1–100 strings) and rows (at most 10000 arrays of matching length, containing strings, finite numbers, booleans or null).');
			}
			table = { columns: data.columns, rows: data.rows };
		} else {
			if (!Array.isArray(value) || value.length > 100 || !value.every(source => {
				if (!source || typeof source.title !== 'string' || !source.title || source.title.length > 300 || typeof source.url !== 'string' || source.url.length > 4096 || source.description !== undefined && (typeof source.description !== 'string' || source.description.length > 4000)) { return false; }
				try { const url = new URL(source.url); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
			})) { throw new Error('Sources JSON requires at most 100 objects with title, http(s) url and optional description.'); }
			sources = value.map(source => ({ title: source.title, url: source.url, ...(source.description === undefined ? {} : { description: source.description }) }));
		}
		mimeType = 'application/json';
	} else if (kind === 'audio' || kind === 'video') {
		const ext = path.extname(name).toLowerCase();
		const ascii = (start: number, end: number) => bytes.toString('ascii', start, end);
		if (kind === 'audio' && ext === '.mp3' && (ascii(0, 3) === 'ID3' || bytes.length > 1 && bytes[0] === 255 && (bytes[1] & 224) === 224)) { mimeType = 'audio/mpeg'; }
		else if (kind === 'audio' && ext === '.wav' && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') { mimeType = 'audio/wav'; }
		else if (kind === 'audio' && ext === '.ogg' && ascii(0, 4) === 'OggS') { mimeType = 'audio/ogg'; }
		else if ((kind === 'video' && ext === '.mp4' || kind === 'audio' && ext === '.m4a') && ascii(4, 8) === 'ftyp') { mimeType = kind === 'video' ? 'video/mp4' : 'audio/mp4'; }
		else if (ext === '.webm' && bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) { mimeType = `${kind}/webm`; }
		else { throw new Error('Use MP3, WAV, OGG, M4A or WebM for audio; MP4 or WebM for video, with a matching file signature.'); }
	}
	if (bytes.length > imageByteLimit) { throw new Error('Files and media must be at most 4 MB.'); }
	return { kind, name, mimeType, base64: bytes.toString('base64'), bytes: bytes.length, ...(table ? { table } : {}), ...(sources ? { sources } : {}) };
}
