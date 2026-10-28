import * as path from 'node:path';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { privateTempDirectory } from '../core/safeFiles';
import type { AgentId } from './chatProtocol';
import { isAgentAuthenticationError } from './agentAuthText';

export { isAgentAuthenticationError };

export function agentLoginArgs(agent: AgentId): string[] {
	return agent === 'claude' ? ['auth', 'login'] : agent === 'codex' ? ['login'] : agent === 'opencode' ? ['auth', 'login'] : agent === 'pi' ? [] : ['--prompt-interactive', '/auth'];
}

/** Status commands are local checks; their output may contain account details and stays private. */
export async function checkAgentLogin(agent: AgentId, binary: string): Promise<void> {
	// Gemini and OpenCode (ACP session/new) and Pi (get_state) are checked by detection itself.
	if (agent === 'gemini' || agent === 'opencode' || agent === 'pi') return;
	const cwd = await privateTempDirectory('agent-sign-in');
	const env: NodeJS.ProcessEnv = { ...process.env, PATH: [path.dirname(binary), process.env.PATH].filter(Boolean).join(path.delimiter) };
	delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
	await new Promise<void>((resolve, reject) => execFile(binary,
		agent === 'claude' ? ['auth', 'status'] : ['login', 'status'],
		{ cwd, env, timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true },
		error => error ? reject(new Error(`${agent}: sign-in could not be confirmed. Complete sign-in in the terminal and check again.`)) : resolve()));
}

/** Credentials remain owned by the CLI. Never read them or send terminal output to a webview. */
export class AgentAuthentication implements vscode.Disposable {
	private readonly terminals = new Map<AgentId, vscode.Terminal>();
	private readonly starting = new Set<AgentId>();
	private disposed = false;
	private readonly closed: vscode.Disposable;
	constructor(private readonly changed: () => void, private readonly completed: (id: AgentId) => Promise<void>) {
		this.closed = vscode.window.onDidCloseTerminal(terminal => {
			for (const [id, current] of this.terminals) {
				if (terminal !== current) continue;
				this.terminals.delete(id);
				this.changed();
				if (terminal.exitStatus?.code === 0) void this.completed(id).catch(error => {
					if (!this.disposed) void vscode.window.showErrorMessage(String(error));
				});
			}
		});
	}
	public active(id: AgentId): boolean { return this.starting.has(id) || this.terminals.has(id); }
	/** `pathEnv`: a PATH to use instead of the binary's folder (Pi's launcher needs a `node` on it; see `piPath`). */
	public async start(id: AgentId, binary: string, pathEnv?: string): Promise<void> {
		if (this.disposed) return;
		const existing = this.terminals.get(id);
		if (existing) { existing.show(); return; }
		if (this.starting.has(id)) return;
		this.starting.add(id); this.changed();
		try {
			// A cloned project's hooks and MCP configuration must not run during login.
			const cwd = await privateTempDirectory('agent-sign-in');
			if (this.disposed) return;
			const terminal = vscode.window.createTerminal({
				name: `Sign in · ${id}`, cwd, shellPath: binary, shellArgs: agentLoginArgs(id),
				env: { PATH: pathEnv ?? [path.dirname(binary), process.env.PATH].filter(Boolean).join(path.delimiter),
					CLAUDECODE: null, CLAUDE_CODE_ENTRYPOINT: null, GEMINI_CLI_NO_RELAUNCH: 'true',
					GEMINI_CLI_TRUST_WORKSPACE: 'false' },
				iconPath: new vscode.ThemeIcon('account'),
			});
			this.terminals.set(id, terminal); terminal.show();
		} finally { this.starting.delete(id); this.changed(); }
	}
	public dispose(): void {
		this.disposed = true; this.closed.dispose();
		for (const terminal of this.terminals.values()) terminal.dispose();
		this.terminals.clear();
	}
}
