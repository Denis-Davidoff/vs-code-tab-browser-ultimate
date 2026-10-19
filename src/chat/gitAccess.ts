/** Coordinate Git mutations with agent launches by canonical per-worktree Git directory. */
export class GitAccess {
	private readonly _mutations = new Map<string, Promise<void>>();

	private readonly _identity: (folder: string) => Promise<string>;

	constructor(identity: (folder: string) => Promise<string>) { this._identity = identity; }

	async mutate(folder: string, busyFolders: () => readonly string[]): Promise<() => void> {
		const key = await this._identity(folder);
		if (this._mutations.has(key)) { throw new Error('Another Git operation is running in this repository.'); }
		// Reserve before checking agents: launches must see the lock throughout asynchronous discovery.
		let finish!: () => void;
		this._mutations.set(key, new Promise<void>(resolve => { finish = resolve; }));
		let released = false;
		const release = () => {
			if (!released) { released = true; this._mutations.delete(key); finish(); }
		};
		try {
			for (const busy of busyFolders()) {
				if (await this._identity(busy) === key) {
					throw new Error('Wait for agents working in this repository to finish.');
				}
			}
			return release;
		} catch (error) {
			release();
			throw error;
		}
	}

	async launch<T>(folder: string, current: () => boolean, start: () => T | Promise<T>, wait = false): Promise<T> {
		while (this._mutations.size) {
			const key = await this._identity(folder);
			const finished = this._mutations.get(key);
			if (!finished) { break; }
			if (!wait) { throw new Error('Git is updating this repository. Try again when the operation finishes.'); }
			await finished;
		}
		if (!current()) { throw new Error('The conversation or working folder changed before the agent could start.'); }
		// No await between the final lock check and start, which synchronously marks the tab/run busy.
		return start();
	}
}
