/*
 * What a remote surface (the Chrome side panel, the Exchange website) is told
 * about the editor's terminal tabs. One rule for both, so the two cannot
 * disagree on when terminals are offered and what the reason says.
 *
 * Leaf: types only from elsewhere, no `vscode` (`npm test` loads it).
 */

import type { TerminalSupport, TerminalTabSummary } from './chatProtocol';
import type { Availability } from './core/commands';

export type RemoteTerminalSurface = 'chrome' | 'exchange';

export interface RemoteTerminalGates {
	readonly surface: RemoteTerminalSurface;
	/** The Exchange connection is end-to-end encrypted. Chrome's loopback bridge needs none. */
	readonly encrypted: boolean;
	/** `aiBrowser.chat.remoteTerminal`, read at the user level. */
	readonly setting: boolean;
	/** `aiBrowser.chat.remoteTerminalShell`: may this surface open a plain shell? Absent: yes. */
	readonly openShell?: boolean;
	/** `aiBrowser.chat.remoteTerminalAgent`: may this surface open an agent's CLI? Absent: yes. */
	readonly openAgent?: boolean;
	/** The per-connection consent asked in VS Code. */
	readonly consent: 'unasked' | 'asking' | 'yes' | 'no';
	/** The chat is blocked in that window (Restricted Mode, a remote window …). */
	readonly blocked: boolean;
}

/** The exact words for the setting, so a user can find it in Settings by either spelling. */
export const remoteTerminalSettingHint = 'In VS Code, turn on the setting “AI Browser › Chat: Remote Terminal” (aiBrowser.chat.remoteTerminal) on the computer running VS Code.';

/** The words for one of the two "open" settings. */
export function remoteOpenHint(kind: 'shell' | 'agent'): string {
	return kind === 'shell'
		? 'Opening a plain terminal from Chrome and the website is off: in VS Code, turn on “AI Browser › Chat: Remote Terminal Shell” (aiBrowser.chat.remoteTerminalShell).'
		: 'Opening an agent in a terminal from Chrome and the website is off: in VS Code, turn on “AI Browser › Chat: Remote Terminal Agent” (aiBrowser.chat.remoteTerminalAgent).';
}

/** Why terminals are not on offer there, or `undefined` when they are. */
export function remoteTerminalReason(g: RemoteTerminalGates): string | undefined {
	if (g.surface === 'exchange' && !g.encrypted) { return 'Terminals need an encrypted connection: reconnect VS Code with a workspace password.'; }
	if (!g.setting) { return `Terminals are off for ${g.surface === 'chrome' ? 'Chrome' : 'the website'}. ${remoteTerminalSettingHint}`; }
	if (g.consent === 'no') { return 'Terminal access was declined in VS Code for this connection. Reconnect to be asked again.'; }
	if (g.blocked) { return 'The chat is not available in this VS Code window.'; }
	return undefined;
}

export const terminalLifecycleTypes = ['newTerminal', 'closeTerminal', 'renameTerminal', 'restartTerminal'] as const;

/**
 * The terminal half of a remote snapshot: the shared terminals (the folder by
 * its last segment only), the support the "New terminal" entries read, and the
 * lifecycle controls disabled with the reason — disabled, not hidden, so the
 * entry is there and says what to enable.
 */
export function remoteTerminalView(g: RemoteTerminalGates, shared: () => readonly TerminalTabSummary[], support: () => TerminalSupport): {
	terminals: TerminalTabSummary[]; terminalSupport: TerminalSupport; controls: Record<string, Availability>;
} {
	const reason = remoteTerminalReason(g);
	if (reason) {
		return {
			terminals: [], terminalSupport: { available: false, reason },
			controls: Object.fromEntries(terminalLifecycleTypes.map(type => [type, { s: 'off' as const, reason }])),
		};
	}
	const supported = support();
	const shell = g.openShell !== false, agent = g.openAgent !== false;
	// Neither kind may be opened: existing shared terminals stay watchable, "New terminal" says why not.
	const noOpen = supported.available && !shell && (!agent || supported.agents.length === 0) ? (agent ? remoteOpenHint('shell') : `${remoteOpenHint('shell')} ${remoteOpenHint('agent')}`) : undefined;
	return {
		terminals: shared().map(t => ({
			id: t.id, name: t.name, status: t.status, cwd: t.cwd.split(/[\\/]/).filter(Boolean).pop() ?? '',
			...(t.exitCode !== undefined ? { exitCode: t.exitCode } : {}), ...(t.agent ? { agent: t.agent } : {}), remote: true as const,
		})),
		// Sharing is decided in VS Code only; a remote surface never sees the row.
		terminalSupport: noOpen ? { available: false, reason: noOpen }
			: supported.available ? { available: true, limit: supported.limit, agents: agent ? supported.agents : [], ...(shell ? {} : { shell: false as const }) } : supported,
		controls: noOpen ? { newTerminal: { s: 'off' as const, reason: noOpen } } : {},
	};
}
