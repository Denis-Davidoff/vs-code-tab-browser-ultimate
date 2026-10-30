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
