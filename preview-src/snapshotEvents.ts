import type { HostToView } from '../src/chat/chatProtocol';

/**
 * Remote surfaces (the Chrome side panel, the website) get the editor's last
 * snapshot messages inside each state (`snapshotEvents`). This hands each one to
 * the renderer once, and again only when it changes: the state itself arrives
 * many times a second while a reply streams. Shared by both shims, so the two
 * cannot drift. Leaf module.
 */
export function snapshotReplay(emit: (message: HostToView) => void): (events: readonly HostToView[] | undefined) => void {
	const seen = new Map<string, string>();
	return events => {
		for (const message of events ?? []) {
			const key = message.type === 'workdirGit' ? `workdirGit:${message.folder}` : message.type;
			const body = JSON.stringify(message);
			if (seen.get(key) === body) { continue; }
			seen.set(key, body);
			emit(message);
		}
	};
}
