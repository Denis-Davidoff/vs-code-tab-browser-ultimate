/** Local OS integration probe, no agents, models or network. Always cleans up its own children. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { strict as assert } from 'node:assert';
import { AgentProcessMonitor, readProcessTable, readProcessOwners } from '../src/chat/agentProcesses.ts';

if (process.platform !== 'darwin' && process.platform !== 'linux') { throw new Error('This probe requires macOS or Linux.'); }
let now = Date.now();
const monitor = new AgentProcessMonitor(readProcessTable, readProcessOwners, () => now, true, false);
const children = [];
const owners = [`probe-${randomUUID()}`, `probe-${randomUUID()}`];
try {
	for (const chat of owners) {
		const parent = spawn(process.execPath, ['-e', `
			const { spawn } = require('node:child_process');
			const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
			process.stdout.write(String(child.pid)); child.unref();
		`], { env: { ...process.env, ...monitor.environment(chat, 'codex') }, stdio: ['ignore', 'pipe', 'inherit'] });
		let output = ''; parent.stdout.on('data', chunk => { output += chunk; });
		await once(parent, 'close');
		assert.match(output, /^\d+$/); children.push(Number(output));
	}
	const started = performance.now();
	await monitor.refresh(); now += 6000; await monitor.refresh();
	for (let index = 0; index < owners.length; index++) {
		assert.deepEqual(monitor.forChat(owners[index]).processes.map(item => item.pid), [children[index]]);
		assert.equal(monitor.forChat(owners[index]).processes[0].detached, true);
	}
	console.log(`PASS: immediately detached children attributed to two separate chats; two samples took ${Math.round(performance.now() - started)} ms.`);
	const restored = new AgentProcessMonitor(readProcessTable, readProcessOwners, () => now, true, false);
	try {
		for (const owner of owners) { restored.environment(owner, 'codex'); }
		await restored.refresh(); now += 6000; await restored.refresh();
		assert.deepEqual(restored.forChat(owners[0]).processes.map(item => item.pid), [children[0]]);
		const first = restored.forChat(owners[0]).processes[0];
		await assert.rejects(restored.stop(owners[1], first.id));
		await restored.stop(owners[0], first.id);
		process.kill(children[1], 0);
		console.log('PASS: registry reload recovers the orphan; Stop rejects another chat and leaves its process alive.');
	} finally { restored.dispose(); }
} finally {
	monitor.dispose();
	for (const pid of children) { try { process.kill(pid, 'SIGTERM'); } catch { /* Already ended. */ } }
}
