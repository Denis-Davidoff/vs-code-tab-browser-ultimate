import { unlinkSync } from 'node:fs';
import { withLock } from '../core/fileLock';
import { connect, createServer, type Socket } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';

export function inhibitorCommand(platform: NodeJS.Platform, pid: number): { command: string; args: string[] } {
	let command: string;
	let args: string[];
	switch (platform) {
		case 'darwin': command = '/usr/bin/caffeinate'; args = ['-i', '-w', String(pid)]; break;
		case 'linux':
			command = 'systemd-inhibit';
			args = ['--what=sleep', '--mode=block', '--who=AI Browser', '--why=Agents or wake timer running', 'sh', '-c', 'echo READY; cat >/dev/null'];
			break;
		case 'win32':
			command = 'powershell.exe';
			args = ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Wake { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }'; if ([Wake]::SetThreadExecutionState(2147483649) -eq 0) { exit 1 }; Write-Output READY; [Console]::In.ReadLine() | Out-Null; [Wake]::SetThreadExecutionState(2147483648) | Out-Null`];
			break;
		default: throw new Error('Sleep prevention is unavailable on this operating system.');
	}
	return { command, args };
}

/** One local daemon owns the OS assertion; a closed socket releases that window's vote. */
export function runSleepDaemon(endpoint: string, launch: () => ChildProcess = () => {
	const { command, args } = inhibitorCommand(process.platform, process.pid);
	return spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}): void {
	const clients = new Map<Socket, boolean>();
	let inhibitor: ChildProcess | undefined;
	let ready = false;
	let error: string | undefined;
	let idle: ReturnType<typeof setTimeout> | undefined;
	const broadcast = () => {
		const line = JSON.stringify({ active: ready, error }) + '\n';
		for (const socket of clients.keys()) { socket.write(line); }
	};
	const reconcile = () => {
		const wanted = [...clients.values()].some(Boolean);
		if (!wanted) {
			const old = inhibitor;
			inhibitor = undefined;
			ready = false;
			error = undefined;
			old?.stdin?.end();
			// caffeinate does not read stdin; its -w also protects against daemon crashes.
			if (process.platform === 'darwin') { old?.kill(); }
			broadcast();
			return;
		}
		if (inhibitor || error) { broadcast(); return; }
		let child: ChildProcess;
		try { child = launch(); }
		catch (err) { error = String(err); broadcast(); return; }
		inhibitor = child;
		let detail = '';
		let output = '';
		const deadline = setTimeout(() => {
			if (inhibitor === child && !ready) { failed('The OS sleep inhibitor did not become ready.'); child.stdin?.end(); child.kill(); }
		}, 15000);
		child.stdin?.on('error', () => { /* exit reports failure */ });
		child.stderr?.on('data', data => { detail = (detail + String(data)).slice(-1500); });
		const started = () => { clearTimeout(deadline); if (inhibitor === child) { ready = true; broadcast(); } };
		if (process.platform === 'darwin') { child.once('spawn', started); }
		else { child.stdout?.on('data', data => { output = (output + String(data)).slice(-100); if (output.includes('READY')) { started(); } }); }
		const failed = (message: string) => {
			clearTimeout(deadline);
			if (inhibitor !== child) { return; }
			inhibitor = undefined;
			ready = false;
			error = message;
			broadcast();
		};
		child.once('error', err => failed(err.message));
		child.once('exit', () => failed(detail.trim() || 'The OS sleep inhibitor stopped unexpectedly.'));
	};
	const server = createServer(socket => {
		clearTimeout(idle);
		clients.set(socket, false);
		let buffer = '';
		socket.on('data', data => {
			buffer += String(data);
			if (buffer.length > 4096) { socket.destroy(); return; }
			let end: number;
			while ((end = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
				if (line !== 'true' && line !== 'false') { socket.destroy(); return; }
				if (line === 'true' && error) { error = undefined; }
				clients.set(socket, line === 'true'); reconcile();
			}
		});
		socket.on('error', () => socket.destroy());
		socket.once('close', () => {
			clients.delete(socket); reconcile();
			if (!clients.size) { idle = setTimeout(() => server.close(() => process.exit(0)), 3000); }
		});
	});
	server.once('error', () => process.exit(0)); // Another window won the startup race.
	const listen = () => new Promise<void>(resolve => {
		server.listen(endpoint, () => {
			idle = setTimeout(() => { if (!clients.size) { server.close(() => process.exit(0)); } }, 10000);
			resolve();
		});
	});
	if (process.platform === 'win32') { void listen(); }
	else {
		// Serialize probing/removing stale sockets with the project's existing
		// crash-recoverable lock, so simultaneous window startups keep one owner.
		void withLock(endpoint + '.startup', async () => {
			const live = await new Promise<boolean>(resolve => {
				const probe = connect(endpoint);
				probe.once('connect', () => { probe.end(); resolve(true); });
				probe.once('error', () => { probe.destroy(); resolve(false); });
			});
			if (live) { return; }
			try { unlinkSync(endpoint); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; } }
			await listen();
		}).catch(() => process.exit(1));
	}
}
if (require.main === module && process.argv[2]) { runSleepDaemon(process.argv[2]); }
