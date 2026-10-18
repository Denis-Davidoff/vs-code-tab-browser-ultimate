import type { AgentEvent } from './agentProtocol';

/** Child agents of one skill session; background shell tasks do not hold up a step. */
export class SkillAgents {
	private readonly _agents = new Map<string, { waitForReport: boolean; thread?: string; parent?: string; ended: boolean; failed: boolean }>();

	public get running(): boolean {
		return [...this._agents.values()].some(a => !a.ended);
	}

	public observe(event: AgentEvent): void {
		if (event.type === 'tool' && event.tool.kind === 'agent') {
			const a = event.tool.agent;
			// Codex reuses a thread ID when it assigns more work to an existing agent.
			const previous = this._agents.get(event.id);
			const thread = a?.threadId ?? previous?.thread;
			this._agents.set(event.id, { waitForReport: !!a?.background || !!thread, thread, parent: a?.parentId ?? previous?.parent, ended: false, failed: false });
		} else if (event.type === 'toolUpdate') {
			const a = this._agents.get(event.id);
			if (a) {
				a.thread = event.update.agent?.threadId ?? a.thread;
				a.waitForReport ||= !!event.update.agent?.background || !!a.thread;
				a.parent = event.update.agent?.parentId ?? a.parent;
				if (event.update.status) {
					a.ended = true;
					a.failed = event.update.status === 'failed' || event.update.status === 'stopped';
				}
			}
		} else if (event.type === 'agentStates') {
			for (const state of event.states) {
				for (const a of this._agents.values()) {
					if (a.thread === state.threadId) {
						a.ended = state.status !== 'running';
						a.failed = state.status === 'failed' || state.status === 'stopped';
					}
				}
			}
		} else if (event.type === 'turnEnd') {
			for (const a of this._agents.values()) {
				if (!a.waitForReport || event.error) {
					a.ended = true;
					a.failed ||= !!event.error;
				}
			}
		}
		// A failed/stopped parent cannot report its remaining children any more.
		let changed = true;
		while (changed) {
			changed = false;
			for (const a of this._agents.values()) {
				if (!a.ended && a.parent && this._agents.get(a.parent)?.failed) {
					a.ended = a.failed = true;
					changed = true;
				}
			}
		}
	}
}
