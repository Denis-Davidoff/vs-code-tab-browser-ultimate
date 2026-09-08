/* Tests the shared config with independent processes, including a suspended writer. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

const worker = process.argv[2] === 'worker';
const directory = worker ? process.argv[3] : await fs.mkdtemp(path.join(os.tmpdir(), 'browser-lock-test-'));
const config = path.join(directory, 'config.toml');
const queue = `${config}.tab-browser-locks`;
const identity = process.argv[4] ?? 'a';
const folder = { name: identity, uri: { fsPath: path.join(directory, identity), toString() { return this.fsPath; } } };
let writes = 0;
globalThis.__vscodeStub = {
	workspace: {
		workspaceFolders: [folder],
		fs: {
			readFile: uri => fs.readFile(uri.fsPath),
			writeFile: async (uri, bytes) => {
				if (worker && process.argv[5] === 'hold' && !writes++) {
					process.send({ entered: true });
					await new Promise(resolve => process.once('message', resolve));
				}
				await fs.writeFile(uri.fsPath, bytes);
			},
		},
	},
	Uri: { file: fsPath => ({ fsPath }), joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts) }) },
};
const { refreshClientConfigs } = await import('./.bundles/mcp-refresh-bundle.mjs');
const { codexEntryName } = await import('./.bundles/mcp-setup-bundle.mjs');
const server = { url: `http://127.0.0.1:${identity === 'a' ? 43111 : 43110}/mcp`, token: identity };
const refresh = () => refreshClientConfigs(server, { fsPath: config });
if (worker) {
	await refresh();
	process.disconnect();
} else {
	const children = [];
	const start = (id, hold = '') => {
		const child = fork(import.meta.filename, ['worker', directory, id, hold], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
		children.push(child);
		const done = new Promise((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(Error(`worker exit ${code}`))));
		return { child, done };
	};
	const entry = (id, port) => {
		const f = { name: id, uri: { fsPath: path.join(directory, id), toString() { return this.fsPath; } } };
		return `[mcp_servers.${codexEntryName(f)}]\nurl = "http://127.0.0.1:${port}/mcp/${id}"\n`;
	};
	const original = entry('a', 43999) + entry('b', 43999);
	try {
		await fs.writeFile(config, original);
		const first = start('a', 'hold');
		await new Promise(resolve => first.child.once('message', resolve));
		// Even an artificially old claim belongs to this live, suspended writer.
		for (const name of await fs.readdir(queue)) await fs.utimes(path.join(queue, name), new Date(0), new Date(0));
		const second = start('b');
		await new Promise(resolve => setTimeout(resolve, 250));
		assert.equal(await fs.readFile(config, 'utf8'), original);
		first.child.send('continue');
		await Promise.all([first.done, second.done]);
		assert.equal(await fs.readFile(config, 'utf8'), entry('a', 43111) + entry('b', 43110));
		assert.deepEqual(await fs.readdir(queue), []);
		console.log('PASS  independent windows preserve both updates when a writer pauses before saving');

		// Simulate a crash while choosing a ticket, using a PID known to have exited.
		const deadClaim = path.join(queue, `${first.child.pid}.${randomUUID()}`);
		await fs.mkdir(deadClaim);
		await fs.writeFile(config, original);
		await Promise.all([start('a').done, start('b').done]);
		assert.equal(await fs.readFile(config, 'utf8'), entry('a', 43111) + entry('b', 43110));
		assert.deepEqual(await fs.readdir(queue), []);
		console.log('PASS  simultaneous recovery removes only a dead process claim');

		await fs.mkdir(deadClaim);
		const realRemove = fs.rm;
		let removals = 0;
		fs.rm = async (file, options) => {
			if (file === deadClaim) { removals++; throw Object.assign(Error('denied'), { code: 'EACCES' }); }
			return realRemove(file, options);
		};
		syncBuiltinESMExports();
		await fs.writeFile(config, original);
		try {
			await Promise.race([refresh(), new Promise((_, reject) => {
				const timer = setTimeout(() => reject(Error('lock cleanup did not terminate')), 2500);
				timer.unref();
			})]);
		} finally { fs.rm = realRemove; syncBuiltinESMExports(); }
		assert.equal(removals, 1);
		assert.equal(await fs.readFile(config, 'utf8'), original);
		await fs.rm(deadClaim, { recursive: true });
		console.log('PASS  a denied cleanup exits without spinning or writing unlocked');

		const choosing = path.join(queue, `${process.pid}.${randomUUID()}`);
		await fs.mkdir(choosing);
		const began = Date.now();
		await refresh();
		assert.ok(Date.now() - began >= 1900 && Date.now() - began < 3000);
		assert.equal(await fs.readFile(config, 'utf8'), original);
		console.log('PASS  waiting for a live process is bounded');
	} finally {
		for (const child of children) if (child.exitCode === null) child.kill();
		await fs.rm(directory, { recursive: true, force: true });
	}
}
