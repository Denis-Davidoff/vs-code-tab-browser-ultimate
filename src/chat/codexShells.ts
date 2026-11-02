import type { AgentEvent } from './agentProtocol';

type Translate = (method: string, params: unknown) => AgentEvent[];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Native unified-exec events already describe commands nested inside functions.exec.
 * Correlate write_stdin interactions by the CLI's process id, never by parsing JavaScript.
 * One instance belongs to one provider session; thread ids scope child-process identities.
 */
export class CodexShells {
	private readonly _processes = new Map<string, string>();
	private readonly _aliases = new Map<string, string>();
	private readonly _started = new Set<string>();
	private readonly _streamed = new Set<string>();

	private readonly _translate: Translate;
	public constructor(translate: Translate) { this._translate = translate; }

	public events(method: string, params: Record<string, unknown>): AgentEvent[] {
		const item = record(params.item) && params.item.type === 'commandExecution' ? params.item : undefined;
		const id = item && typeof item.id === 'string' ? item.id : typeof params.itemId === 'string' ? params.itemId : undefined;
		const pid = item?.processId ?? params.processId;
		const processKey = typeof pid === 'string' ? JSON.stringify([params.threadId ?? '', pid]) : undefined;
		const interaction = item?.source === 'unifiedExecInteraction';
		if (id && item && (method === 'item/started' || method === 'item/completed')) {
			const parent = interaction && processKey ? this._processes.get(processKey) : undefined;
			if (parent) { this._aliases.set(id, parent); }
			else if (processKey && (method === 'item/started' || !this._processes.has(processKey))) { this._processes.set(processKey, id); }
		}
		const canonical = id ? this._aliases.get(id) ?? id : undefined;
		if (canonical && processKey && method === 'item/commandExecution/terminalInteraction') { this._processes.set(processKey, canonical); }
		if (id && method === 'item/commandExecution/outputDelta') { this._streamed.add(id); }
		const result: AgentEvent[] = [];
		// A resumed stream or a late completion can arrive without its start.
		if (item && canonical && method === 'item/completed' && !this._started.has(canonical)) {
			for (const event of this._translate('item/started', params)) {
				if (event.type === 'tool') { result.push({ ...event, id: canonical }); this._started.add(canonical); }
			}
		}
		for (const event of this._translate(method, params)) {
			if (event.type === 'tool' && event.tool.kind === 'command') {
				const row = this._aliases.get(event.id) ?? event.id;
				if (this._started.has(row)) { continue; }
				this._started.add(row);
				result.push({ ...event, id: row });
			} else if (event.type === 'toolUpdate') {
				const row = this._aliases.get(event.id) ?? event.id;
				let update = event.update;
				if (interaction && row !== event.id && update.output !== undefined) {
					// Interaction snapshots contain that read's output. Streaming deltas
					// have already appended those bytes to the original command.
					const { output, ...rest } = update;
					update = this._streamed.has(event.id) ? rest : { ...rest, output, append: true };
				}
				result.push({ ...event, id: row, update });
				if (update.status) {
					for (const [key, active] of this._processes) { if (active === row) { this._processes.delete(key); } }
				}
			} else { result.push(event); }
		}
		if (id && method === 'item/completed') { this._streamed.delete(id); }
		// Retain a bounded alias tail for late output, without growing with a long chat.
		if (this._aliases.size > 512) { this._aliases.delete(this._aliases.keys().next().value!); }
		if (this._started.size > 2048) { this._started.delete(this._started.values().next().value!); }
		return result;
	}

	public clear(): void { this._processes.clear(); this._aliases.clear(); this._started.clear(); this._streamed.clear(); }
}
