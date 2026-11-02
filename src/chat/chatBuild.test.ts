import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('Exchange builds current chat assets from its deployment context without root scripts or prebuilt files', async () => {
	const root = await mkdtemp(join(tmpdir(), 'chat-deployment-'));
	try {
		await mkdir(join(root, 'exchange-server/scripts'), { recursive: true });
		await mkdir(join(root, 'chrome-extension'));
		await Promise.all([
			...['src', 'preview-src', 'media'].map(dir => cp(dir, join(root, dir), { recursive: true })),
			cp('exchange-server/chat-assets', join(root, 'exchange-server/chat-assets'), { recursive: true }),
			cp('exchange-server/scripts/build-chat.mjs', join(root, 'exchange-server/scripts/build-chat.mjs')),
			cp('chrome-extension/sidepanel.css', join(root, 'chrome-extension/sidepanel.css')),
			cp('package.json', join(root, 'package.json')),
			symlink(resolve('node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'),
		]);
		const result = spawnSync(process.execPath, ['exchange-server/scripts/build-chat.mjs'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
		assert.equal(result.status, 0, result.stderr || result.error?.message);
		const output = join(root, 'exchange-server/apps/web/public/remote-chat');
		const html = await readFile(join(output, 'index.html'), 'utf8');
		const versions = [...html.matchAll(/(?:href|src)="[^"?]+\.(?:css|js)\?v=([a-f0-9]{16})"/g)].map(m => m[1]);
		assert.equal(versions.length, 7, 'all styles and scripts need a release cache key');
		assert.equal(new Set(versions).size, 1, 'a renderer release must not mix script and style versions');
		const css = await readFile(join(output, 'chat.css'), 'utf8');
		assert.ok(css.includes('.new-messages'));
		assert.ok(css.includes('.usage-button.limit-full.limit-short'));
		assert.match(await readFile(join(output, 'visualization.html'), 'utf8'), /<script>/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
