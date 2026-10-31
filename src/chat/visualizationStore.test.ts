import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { VisualizationStore, visualizationByteLimit } from './visualizationStore.ts';

async function fixture(run: (store: VisualizationStore, base: string) => Promise<void>): Promise<void> {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-browser-visualization-test-'));
	try {
		await fs.mkdir(path.join(base, 'project'));
		await run(new VisualizationStore(path.join(base, 'project'), path.join(base, 'archive'), 'chat-one'), base);
	} finally { await fs.rm(base, { recursive: true, force: true }); }
}

test('publishes immutable versions, survives source deletion, and isolates conversations', async () => fixture(async (store, base) => {
	await store.prepare();
	const file = path.join(store.directory, 'chart.html');
	await fs.writeFile(file, '<p>One</p>');
	const first = await store.publish(file);
	const secondStore = new VisualizationStore(path.join(base, 'project'), path.join(base, 'archive'), 'chat-two');
	await assert.rejects(secondStore.publish(file), /conversation/);
	assert.equal(await secondStore.load(first.revision), undefined);
	await fs.writeFile(file, '<p>Two</p>');
	const second = await store.publish(file);
	assert.equal(first.id, second.id);
	assert.notEqual(first.revision, second.revision);
	await fs.unlink(file);
	const restored = new VisualizationStore(path.join(base, 'project'), path.join(base, 'archive'), 'chat-one');
	assert.equal(await restored.load(first.revision), '<p>One</p>');
	assert.equal(await restored.load(second.revision), '<p>Two</p>');
	assert.equal(await restored.load('../../secret'), undefined);
}));

test('refuses traversal, symlinks, directories, oversized and non-UTF-8 inputs', async () => fixture(async (store, base) => {
	await store.prepare();
	const outside = path.join(base, 'outside.html');
	await fs.writeFile(outside, '<p>Secret</p>');
	await assert.rejects(store.publish(outside), /conversation/);
	await assert.rejects(store.publish(path.join(store.directory, '..', 'outside.html')), /conversation/);
	const file = path.join(store.directory, 'link.html');
	await fs.symlink(outside, file);
	await assert.rejects(store.publish(file));
	await fs.unlink(file);
	await fs.link(outside, file);
	await assert.rejects(store.publish(file), /hard links/);
	await fs.unlink(file);
	await fs.mkdir(file);
	await assert.rejects(store.publish(file), /regular/);
	await fs.rmdir(file);
	await fs.writeFile(file, Buffer.alloc(visualizationByteLimit + 1));
	await assert.rejects(store.publish(file), /1 MB/);
	await fs.writeFile(file, Buffer.from([0xff, 0xfe, 0x00]));
	await assert.rejects(store.publish(file));
	await assert.rejects(store.publish('https://evil.test/chart.html'), /absolute/);
}));

test('refuses linked source directory components before creating output outside the project', async () => fixture(async (store, base) => {
	const elsewhere = path.join(base, 'elsewhere');
	await fs.mkdir(elsewhere);
	await fs.symlink(elsewhere, path.join(base, 'project', '.ai-browser'));
	await assert.rejects(store.prepare(), /symbolic/);
	assert.deepEqual(await fs.readdir(elsewhere), []);
}));

test('archive corruption is not accepted as a saved revision', async () => fixture(async (store, base) => {
	await store.prepare();
	const file = path.join(store.directory, 'chart.html');
	await fs.writeFile(file, '<p>Original</p>');
	const published = await store.publish(file);
	const scopes = await fs.readdir(path.join(base, 'archive'));
	await fs.writeFile(path.join(base, 'archive', scopes[0], `${published.revision}.html`), '<script>changed()</script>');
	const restored = new VisualizationStore(path.join(base, 'project'), path.join(base, 'archive'), 'chat-one');
	assert.equal(await restored.load(published.revision), undefined);
}));

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('image snapshots survive source deletion and verify MIME, hash and conversation ownership', async () => fixture(async (store, base) => {
	await store.prepare();
	const file = path.join(store.directory, 'cat.png');
	await fs.writeFile(file, png);
	const published = await store.publishImage(file);
	await fs.unlink(file);
	assert.deepEqual(await store.loadImage(published.revision), { mimeType: 'image/png', base64: png.toString('base64') });
	const other = new VisualizationStore(path.join(base, 'project'), path.join(base, 'archive'), 'other-chat');
	assert.equal(await other.loadImage(published.revision), undefined);
	const scope = (await fs.readdir(path.join(base, 'archive')))[0];
	await fs.writeFile(path.join(base, 'archive', scope, `${published.revision}.image`), Buffer.concat([png, Buffer.from('changed')]));
	const restored = new VisualizationStore(path.join(base, 'project'), path.join(base, 'archive'), 'chat-one');
	assert.equal(await restored.loadImage(published.revision), undefined);
	assert.equal(await restored.loadImage('../outside'), undefined);
}));

test('image publication refuses outside files, links, oversized and disguised active content', async () => fixture(async (store, base) => {
	await store.prepare();
	const outside = path.join(base, 'outside.png');
	await fs.writeFile(outside, png);
	await assert.rejects(store.publishImage(outside), /conversation/);
	const file = path.join(store.directory, 'cat.png');
	await fs.symlink(outside, file);
	await assert.rejects(store.publishImage(file));
	await fs.unlink(file);
	await fs.link(outside, file);
	await assert.rejects(store.publishImage(file), /hard links/);
	await fs.unlink(file);
	await fs.writeFile(file, '<svg onload="alert(1)"></svg>');
	await assert.rejects(store.publishImage(file), /raster/);
	await fs.writeFile(file, Buffer.alloc(4_000_001));
	await assert.rejects(store.publishImage(file), /4 MB/);
	await assert.rejects(store.publishImage(path.join(store.directory, 'cat.svg')), /PNG/);
}));

test('structured artifacts validate tables, safe sources and media signatures before archival', async () => fixture(async (store) => {
	await store.prepare();
	const file = path.join(store.directory, 'data.json');
	const data = { columns: ['Name', 'Value'], rows: [['Example', 42], ['Other', null]] };
	await fs.writeFile(file, JSON.stringify(data));
	const published = await store.publishArtifact(file, 'table');
	const saved = await store.loadArtifact(published.revision);
	assert.deepEqual(saved?.table, data);
	assert.equal(saved?.kind, 'table');
	await fs.unlink(file);
	assert.equal((await store.loadArtifact(published.revision))?.name, 'data.json');
	await fs.writeFile(file, JSON.stringify({ ...data, rows: [['missing a cell']] }));
	await assert.rejects(store.publishArtifact(file, 'table'), /Table JSON/);
	await fs.writeFile(file, JSON.stringify({ ...data, rows: [[{ html: '<script>' }, 42]] }));
	await assert.rejects(store.publishArtifact(file, 'table'), /Table JSON/);
	for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://secret:password@example.com']) {
		await fs.writeFile(file, JSON.stringify([{ title: 'Unsafe', url }]));
		await assert.rejects(store.publishArtifact(file, 'sources'), /Sources JSON/);
	}
	await fs.writeFile(file, JSON.stringify([{ title: '<script>', url: 'https://example.com', description: 'User-provided source' }]));
	const source = await store.publishArtifact(file, 'sources');
	assert.equal((await store.loadArtifact(source.revision))?.sources?.[0].title, '<script>');
	const audio = path.join(store.directory, 'sound.wav');
	await fs.writeFile(audio, Buffer.from('RIFF0000WAVE'));
	assert.equal((await store.loadArtifact((await store.publishArtifact(audio, 'audio')).revision))?.mimeType, 'audio/wav');
	await fs.writeFile(audio, 'not a WAV');
	await assert.rejects(store.publishArtifact(audio, 'audio'), /matching file signature/);
	const video = path.join(store.directory, 'clip.webm');
	await fs.writeFile(video, Buffer.from([26, 69, 223, 163]));
	assert.equal((await store.loadArtifact((await store.publishArtifact(video, 'video')).revision))?.mimeType, 'video/webm');
}));

test('downloadable files are immutable, scoped, bounded, and archived without executing their contents', async () => fixture(async (store, base) => {
	await store.prepare();
	const file = path.join(store.directory, 'report.html');
	await fs.writeFile(file, '<script>throw new Error("must never execute")</script>');
	const published = await store.publishArtifact(file, 'file');
	const other = new VisualizationStore(path.join(base, 'project'), path.join(base, 'archive'), 'other');
	assert.equal(await other.loadArtifact(published.revision), undefined);
	await assert.rejects(other.publishArtifact(file, 'file'), /conversation/);
	const artifact = await store.loadArtifact(published.revision);
	assert.equal(artifact?.mimeType, 'application/octet-stream');
	assert.match(Buffer.from(artifact!.base64, 'base64').toString('utf8'), /must never execute/);
	await fs.writeFile(file, Buffer.alloc(4_000_001));
	await assert.rejects(store.publishArtifact(file, 'file'), /4 MB/);
	const linked = path.join(store.directory, 'link.html');
	await fs.symlink(file, linked);
	await assert.rejects(store.publishArtifact(linked, 'file'));
	const scope = (await fs.readdir(path.join(base, 'archive')))[0];
	await fs.writeFile(path.join(base, 'archive', scope, `${published.revision}.artifact`), '{}');
	const restored = new VisualizationStore(path.join(base, 'project'), path.join(base, 'archive'), 'chat-one');
	assert.equal(await restored.loadArtifact(published.revision), undefined);
}));
