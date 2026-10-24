import { createHash } from 'node:crypto';

/** A named workspace owns its tabs even when its folder list changes. */
export function chatProjectId(workspaceFile: string | undefined, folders: readonly string[], emptyWindow?: string): string {
	const identity = workspaceFile ? ['workspace', workspaceFile]
		: folders.length ? ['folders', ...[...new Set(folders)].sort()]
			: ['empty', emptyWindow ?? 'window'];
	return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export interface SavedChatTabs {
	project?: string;
	ids?: unknown;
	fresh?: unknown;
	active?: unknown;
	names?: unknown;
	folders?: unknown;
	repos?: unknown;
	ultracodes?: unknown;
}

/**
 * Tabs saved before they were kept per project. They sit in this workspace's own
 * `workspaceState`, so every one belongs here: a tab's working folder says nothing
 * about ownership, since a chat may work in any folder or in a managed copy of a
 * repository kept in the extension's storage. Only a snapshot already stamped for
 * another project is refused.
 */
export function legacyProjectTabs(saved: SavedChatTabs | undefined, project: string): SavedChatTabs | undefined {
	if (!saved) return;
	if (saved.project) return saved.project === project ? saved : undefined;
	const ids = (Array.isArray(saved.ids) ? saved.ids : []).filter((id): id is string => typeof id === 'string');
	return { ...saved, project, ids, active: ids.includes(saved.active as string) ? saved.active : undefined };
}
