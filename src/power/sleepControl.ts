import { connect, type Socket } from 'node:net';
import { fork } from 'node:child_process';
import { mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { validSleepChoice, type SleepChoice, type SleepState } from './sleepProtocol';

/** Window-local selection; only the boolean vote crosses the process boundary. */
export class SleepControl {
	public state: SleepState = { mode: 'off', active: false };
	private socket?: Socket;
	private timer: ReturnType<typeof setInterval>;
	private retry?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private wanted = false;
	private osActive = false;
	private connecting = false;
	private endpoint = '';
	private armedAt = 0;
	constructor(private readonly working: () => boolean, private readonly changed: () => void, private readonly unavailable?: string) {
		this.timer = setInterval(() => this.update(), 1000);
	}
	public choose(choice: SleepChoice): void {
		if (!validSleepChoice(choice)) { return; }
		this.armedAt = Date.now();
		this.state = { mode: choice.mode, active: false, ...(choice.mode === 'timer' ? { minutes: choice.minutes, until: Date.now() + choice.minutes * 60000 } : {}) };
		this.update();
		this.socket?.write(`${this.wanted}\n`);
		this.changed();
	}
	public update(): void {
		if (this.disposed) { return; }
		const before = JSON.stringify(this.state);
		if ((this.state.mode === 'timer' && Date.now() >= this.state.until!) ||
			(this.state.mode === 'agents' && !this.working() && Date.now() - this.armedAt > 500)) {
			this.state = { mode: 'off', active: false };
		}
		const wanted = this.state.mode !== 'off';
		if (wanted && this.unavailable) { this.state.error = this.unavailable; }
		if (wanted && !this.unavailable && !this.socket && !this.connecting) { this.start(); }
		if (wanted !== this.wanted) { this.wanted = wanted; this.socket?.write(`${wanted}\n`); }
		this.state.active = wanted && this.osActive;
		if (!wanted) { this.state.error = undefined; }
		if (JSON.stringify(this.state) !== before) { this.changed(); }
	}
	private start(): void {
		this.connecting = true;
		try {
			const uid = process.platform === 'win32' ? userInfo().username.replace(/[^a-zA-Z0-9_-]/g, '_') : String(process.getuid!());
			const directory = join(tmpdir(), `ai-browser-wake-${uid}`);
			if (process.platform === 'win32') { this.endpoint = `\\\\.\\pipe\\ai-browser-wake-${uid}-v1`; }
			else { mkdirSync(directory, { recursive: true, mode: 0o700 });
				const info = lstatSync(directory);
				if (!info.isDirectory() || info.uid !== process.getuid!()) { throw new Error('Unsafe sleep coordinator directory.'); }
				chmodSync(directory, 0o700); this.endpoint = join(directory, 'v1.sock'); }
			this.open(true);
		} catch (err) { this.connecting = false; this.state.error = String(err); }
	}
	private open(launch: boolean): void {
		const socket = connect(this.endpoint);
		let buffer = '';
		socket.once('connect', () => {
			if (this.disposed) { socket.destroy(); return; }
			this.connecting = false; this.socket = socket;
			socket.write(`${this.wanted}\n`);
		});
		socket.on('data', data => {
			buffer += String(data);
			let end: number;
			while ((end = buffer.indexOf('\n')) >= 0) {
				try {
					const response = JSON.parse(buffer.slice(0, end));
					this.osActive = response.active === true;
					this.state.error = this.wanted && typeof response.error === 'string' ? response.error : undefined;
					this.state.active = this.wanted && this.osActive;
					this.changed();
				} catch { /* incomplete/invalid response cannot claim an assertion */ }
				buffer = buffer.slice(end + 1);
			}
		});
		socket.once('error', (err: NodeJS.ErrnoException) => {
			if (this.disposed) { return; }
			if (launch && (err.code === 'ENOENT' || err.code === 'ECONNREFUSED')) {
				const child = fork(join(__dirname, 'sleepDaemon.js'), [this.endpoint], { detached: true, stdio: 'ignore', execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
				child.on('error', failure => { this.state.error = failure.message; this.changed(); });
				child.unref();
				this.retry = setTimeout(() => { if (!this.disposed) { this.open(false); } }, 350);
			} else { this.connecting = false; this.state.error = err.message; this.changed(); }
		});
		socket.once('close', () => {
			if (this.socket === socket) { this.socket = undefined; this.osActive = false; this.state.active = false; this.changed(); }
		});
	}
	public dispose(): void {
		this.disposed = true;
		clearInterval(this.timer); clearTimeout(this.retry);
		this.socket?.destroy();
	}
}
