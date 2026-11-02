import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AgentProcessMonitor, parseProcessTable, processOwnerVariable, type ProcessRow } from './agentProcesses.ts';

const birth = 'Mon Nov 2 12:00:00 2026';
const row = (pid: number, ppid: number, extra: Partial<ProcessRow> = {}): ProcessRow => ({ pid, ppid, birth, command: '/usr/local/bin/node', ...extra });
function fixture() {
	let now = Date.parse(birth);
	let rows: ProcessRow[] = [];
	const markers = new Map<number, string>();
	const signalled: number[] = [];
	const reads: number[][] = [];
	const monitor = new AgentProcessMonitor(async () => rows, async pids => {
		reads.push([...pids]); return new Map([...markers].filter(([pid]) => pids.includes(pid)));
	}, () => now, true, false, pid => { signalled.push(pid); });
	return { monitor, markers, signalled, reads, rows: (next: ProcessRow[]) => { rows = next; }, advance: (ms = 5000) => { now += ms; },
		owner: (chat: string) => monitor.environment(chat, 'codex')[processOwnerVariable] };
}

test('ps parsing keeps birth identity, executable spaces and zombie state without argv', () => {
	assert.deepEqual(parseProcessTable(' 123 1 Mon Nov  2 12:00:00 2026 S /Applications/My App/node\n 124 1 Mon Nov  2 12:00:00 2026 Z node\ninvalid'), [
		row(123, 1, { command: '/Applications/My App/node', zombie: false }), row(124, 1, { command: 'node', zombie: true }),
	]);
});

test('sampled descendants survive setsid/reparenting and discover new descendants after CLI exit', async () => {
	const f = fixture(); const marker = f.owner('a');
	const root = f.monitor.register(100, marker);
	f.rows([row(100, 1), row(200, 100), row(300, 200)]);
	await f.monitor.refresh(); assert.equal(f.monitor.forChat('a').processes.length, 0, 'short calls stay out of the list');
	f.advance(); root.dispose(); f.rows([row(200, 1), row(300, 200), row(400, 300)]);
	await f.monitor.refresh();
	assert.deepEqual(f.monitor.forChat('a').processes.map(item => [item.pid, item.detached, item.attribution]), [[200, true, 'ancestry'], [300, true, 'ancestry']]);
	f.advance(); await f.monitor.refresh();
	assert.equal(f.monitor.forChat('a').processes.length, 3);
});

test('environment markers recover already detached processes and distinguish chats below one shared CLI', async () => {
	const f = fixture(); const a = f.owner('a'), b = f.owner('b');
	f.monitor.register(100);
	f.markers.set(200, a); f.markers.set(300, b); f.markers.set(400, a);
	f.rows([row(100, 1), row(200, 100), row(300, 100), row(400, 1), row(500, 100)]);
	await f.monitor.refresh(); f.advance(); await f.monitor.refresh();
	assert.deepEqual(f.monitor.forChat('a').processes.map(item => item.pid), [200, 400]);
	assert.deepEqual(f.monitor.forChat('b').processes.map(item => item.pid), [300]);
	assert.deepEqual(f.monitor.forChat('unknown').processes, []);
	assert.equal(f.monitor.snapshot.processes.some(item => item.pid === 500), false, 'a shared parent never implies chat ownership');
});

test('live attached descendants stay attached across samples, regardless of table order', async () => {
	const f = fixture(); f.monitor.register(100, f.owner('a'));
	f.rows([row(400, 300), row(300, 200), row(200, 100), row(100, 1)]);
	await f.monitor.refresh(); f.advance(); await f.monitor.refresh();
	assert.ok(f.monitor.forChat('a').processes.every(item => !item.detached));
});

test('PID reuse, zombies and unrelated old root PIDs never inherit attribution', async () => {
	const f = fixture(); f.monitor.register(100, f.owner('a'));
	f.rows([row(100, 1), row(200, 100)]); await f.monitor.refresh(); f.advance();
	f.rows([row(100, 1, { birth: 'Mon Nov 2 12:01:00 2026' }), row(200, 100, { birth: 'Mon Nov 2 12:01:00 2026' }), row(300, 1, { zombie: true })]);
	await f.monitor.refresh(); assert.deepEqual(f.monitor.snapshot.processes, []);
});

test('process exits remove rows and stable samples emit no UI update', async () => {
	const f = fixture(); f.monitor.register(100, f.owner('a'));
	let changed = 0; f.monitor.subscribe(() => { changed++; });
	f.rows([row(100, 1), row(200, 100)]); await f.monitor.refresh(); f.advance(); await f.monitor.refresh();
	const before = changed; await f.monitor.refresh(); assert.equal(changed, before);
	f.rows([row(100, 1)]); await f.monitor.refresh();
	assert.equal(changed, before + 1); assert.deepEqual(f.monitor.snapshot.processes, []);
});

test('discovery reads at most 64 environments per pass and stops retrying unmarked live identities', async () => {
	const f = fixture(); f.owner('a');
	f.rows(Array.from({ length: 200 }, (_, i) => row(100 + i, 1)));
	for (let i = 0; i < 10; i++) { await f.monitor.refresh(); }
	assert.ok(f.reads.every(pids => pids.length <= 64));
	assert.equal(f.reads.reduce((sum, pids) => sum + pids.length, 0), 400);
});

test('failed reads preserve last observed rows, mark them stale, and recover without false exits', async () => {
	let failed = false; let now = Date.parse(birth);
	const monitor = new AgentProcessMonitor(async () => { if (failed) { throw new Error('blocked'); } return [row(100, 1), row(200, 100)]; }, async () => new Map(), () => now, true, false);
	monitor.register(100, monitor.environment('a', 'claude')[processOwnerVariable]);
	await monitor.refresh(); now += 5000; await monitor.refresh(); failed = true;
	await monitor.refresh(); assert.equal(monitor.snapshot.unavailable, true); assert.equal(monitor.snapshot.processes.length, 1);
	failed = false; await monitor.refresh(); assert.equal(monitor.snapshot.unavailable, undefined);
});

test('overlapping refreshes share one scan and dispose prevents late events', async () => {
	let finish!: (rows: ProcessRow[]) => void; let reads = 0; let changes = 0;
	const monitor = new AgentProcessMonitor(() => { reads++; return new Promise(resolve => { finish = resolve; }); }, async () => new Map(), Date.now, true, false);
	monitor.environment('a', 'codex'); monitor.subscribe(() => { changes++; });
	const a = monitor.refresh(), b = monitor.refresh(); assert.equal(a, b); assert.equal(reads, 1);
	monitor.dispose(); finish([]); await a; assert.equal(changes, 0);
});

test('Stop revalidates chat and birth identity before signalling only the selected process', async () => {
	const f = fixture(); f.monitor.register(100, f.owner('a'));
	f.rows([row(100, 1), row(200, 100)]); await f.monitor.refresh(); f.advance(); await f.monitor.refresh();
	const id = f.monitor.forChat('a').processes[0].id;
	await assert.rejects(f.monitor.stop('other-chat', id));
	f.rows([row(200, 1, { birth: 'Mon Nov 2 12:02:00 2026' })]); await assert.rejects(f.monitor.stop('a', id));
	assert.deepEqual(f.signalled, []);
	f.rows([row(200, 1)]); await f.monitor.stop('a', id); assert.deepEqual(f.signalled, [200]);
});

test('unsupported platforms and chats without owners never start a scan', async () => {
	let reads = 0;
	for (const supported of [true, false]) {
		const monitor = new AgentProcessMonitor(async () => { reads++; return []; }, async () => new Map(), Date.now, supported, false);
		if (!supported) { assert.deepEqual(monitor.environment('a', 'codex'), {}); }
		await monitor.refresh(); monitor.dispose();
	}
	assert.equal(reads, 0);
});

test('registering another restored chat rechecks previously unknown markers', async () => {
	const f = fixture(); f.owner('a');
	const other = new AgentProcessMonitor(undefined, undefined, undefined, true, false);
	const b = other.environment('b', 'codex')[processOwnerVariable]; other.dispose();
	f.markers.set(200, b); f.rows([row(200, 1)]);
	await f.monitor.refresh(); await f.monitor.refresh(); assert.deepEqual(f.monitor.snapshot.processes, []);
	f.owner('b'); await f.monitor.refresh(); f.advance(); await f.monitor.refresh();
	assert.deepEqual(f.monitor.forChat('b').processes.map(item => item.pid), [200]);
});

test('discovery prioritizes OS birth time when PID numbers wrap', async () => {
	const f = fixture(); const marker = f.owner('a');
	f.rows([row(50, 1, { birth: 'Mon Nov 2 12:01:00 2026' }), ...Array.from({ length: 100 }, (_, index) => row(90000 + index, 1))]);
	f.markers.set(50, marker); await f.monitor.refresh();
	assert.ok(f.reads[0].includes(50), 'a newly wrapped PID belongs in the first discovery batch');
	f.advance(); await f.monitor.refresh(); assert.equal(f.monitor.forChat('a').processes[0].pid, 50);
});
