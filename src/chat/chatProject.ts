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

/**
 * The project a conversation's tab is grouped under in the strip, the drawer and
 * the tab list (`ChatTabSummary.project`): its working folder, or for a separate
 * copy of a GitHub repository the repository, so every copy of one repository
 * reads as one project. The id is a hash, never the path: the summary goes to
 * Chrome and the website too. The home directory is no project.
 */
export function tabProject(folder: string, copyRepo: string | undefined, home: boolean): { readonly id: string; readonly name: string } {
	if (copyRepo) {
		return { id: createHash('sha1').update(`repo:${copyRepo.toLowerCase()}`).digest('hex').slice(0, 12), name: copyRepo.split('/').pop() || copyRepo };
	}
	if (home) { return { id: 'home', name: 'Home' }; }
	const trimmed = folder.replace(/[\\/]+$/, '');
	const name = trimmed.split(/[\\/]/).filter(Boolean).pop() || trimmed || folder;
	return { id: createHash('sha1').update(`folder:${trimmed}`).digest('hex').slice(0, 12), name };
}
