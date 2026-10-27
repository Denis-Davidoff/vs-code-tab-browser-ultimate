import { surfaceControls } from './core/commands';
import { chromeChatProtocolVersion, chromeChatCapabilities, readChromeChatCapabilities, type ChromeChatCapabilities } from './chromeChatCompatibility';
import type { ChatEntry, ChatViewMode, ChatViewState, Selection, ViewToHost } from './chatProtocol';
import type { FeatureAiSettings } from './featureAi';
import { validToolbarSkill } from './toolbarText';
import { readFeatureAiSettings } from './featureAi';

export interface ChromeChatConnection {
	readonly version: 1;
	readonly deliverySession?: string;
	readonly protocolVersion?: number;
	readonly editorVersion?: string;
	readonly capabilities?: ChromeChatCapabilities;
	readonly url: string;
	readonly token: string;
	readonly extensionId: string;
}

/** A small, dedicated loopback range for discovery; never carries chat data. */
export const chromePairingPorts = Array.from({ length: 20 }, (_, index) => 19371 + index);
export const chromePairingKind = 'ai-browser-chrome-pairing';

/** Explicit projection: no MCP credentials, drag tokens or webview resource URLs. */
export interface ChromeChatSnapshot {
	readonly version: 1;
	readonly deliverySession?: string;
	readonly protocolVersion: number;
	readonly editorVersion?: string;
	readonly capabilities?: ChromeChatCapabilities;
	readonly title: string;
	readonly chatId: string;
	readonly running: boolean;
	readonly blocked?: string;
	readonly entries: readonly ChatEntry[];
	readonly view: ChatViewState;
	readonly canSend: boolean;
	readonly canAttachElements: boolean;
	/**
	 * The agents' browser tools drive the Chrome this panel runs in — it was
	 * opened from the editor. Otherwise they cannot see its pages. Absent from
	 * older editors.
	 */
	readonly agentChrome?: boolean;
	/** The bridge's epoch for `terminal.*` frames; absent from an editor that gives Chrome no terminals. */
	readonly terminalEpoch?: string;
	readonly settings: {
		readonly selection: Selection;
		readonly viewMode: ChatViewMode;
		readonly featureAi?: FeatureAiSettings;
		readonly recordingQuality?: ChatViewState['recordingQuality'];
		readonly recordingSeconds?: number;
	};
}

/**
 * What of the editor's state may leave it for Chrome and the website. Every
 * field of `ChatViewState` has to be classified here — the `satisfies` makes a
 * new field fail the typecheck until it is — so a field holding a path, a
 * pairing request or a drag token cannot reach a remote surface by default, as
 * it could while the snapshot was `...state` with known fields blanked.
 * `override` fields are sent, rebuilt by `chromeChatSnapshot`.
 */
const viewFields = {
	remoteWorkspace: 'shared', exchangeConnection: 'editor', chromeConnectionRequest: 'editor', chromeMirror: 'editor',
	themeTokens: 'shared', themeKind: 'shared', panel: 'editor', surfaceId: 'shared', surface: 'override', controls: 'override',
	dragToken: 'editor', chatSurfaces: 'override', recordingQuality: 'shared', recordingSeconds: 'shared', featureAi: 'shared',
	sleep: 'shared', voice: 'override', blocked: 'shared', detecting: 'shared', agents: 'override', selection: 'shared',
	chatId: 'shared', entries: 'shared', running: 'shared', attachments: 'override', suggestions: 'override',
	hasBrowserTab: 'shared', browserApi: 'shared', nativeBrowser: 'shared', news: 'shared', newsHidden: 'shared',
	tabs: 'shared', activeTab: 'shared', tabLimit: 'shared', terminals: 'editor', terminalFront: 'editor', terminalSupport: 'editor', pendingSends: 'shared', queuePaused: 'shared',
	approvals: 'shared', switchTo: 'shared', commands: 'shared', toolbar: 'shared', toolbarRuns: 'shared',
	skillAgents: 'shared', viewMode: 'shared', collapseTools: 'shared', context: 'shared', workdir: 'shared',
	usage: 'shared', usageAlert: 'shared', snapshotEvents: 'shared',
} as const satisfies Record<keyof ChatViewState, 'shared' | 'editor' | 'override'>;

/** The shared fields of the state, by the classification above; nothing else is copied. */
export function projectView(state: ChatViewState): ChatViewState {
	const result: Record<string, unknown> = {};
	for (const [key, kind] of Object.entries(viewFields)) {
		if (kind === 'shared' && Object.prototype.hasOwnProperty.call(state, key)) { result[key] = (state as unknown as Record<string, unknown>)[key]; }
	}
	// The terminals pinned to a conversation are editor-only (`ChatTabSummary.terminals`): their names and ids stay home.
	if (Array.isArray(result.tabs)) { result.tabs = withoutPinnedTerminals(result.tabs as ChatViewState['tabs']); }
	return result as unknown as ChatViewState;
}

/** The tabs as a remote surface sees them: no pinned terminals. */
export function withoutPinnedTerminals(tabs: ChatViewState['tabs']): ChatViewState['tabs'] {
	return tabs.map(({ terminals: _terminals, ...tab }) => tab);
}

export function chromeChatSnapshot(state: ChatViewState, editorVersion?: string): ChromeChatSnapshot {
	return {
		version: 1, protocolVersion: chromeChatProtocolVersion, capabilities: chromeChatCapabilities, editorVersion,
		title: state.tabs.find(tab => tab.id === state.activeTab)?.title ?? 'AI Browser',
		chatId: state.chatId,
		running: state.running,
		blocked: state.blocked,
		entries: state.entries,
		canSend: true,
		canAttachElements: true,
		view: { ...projectView(state), surface: 'chrome', controls: surfaceControls('chrome'), chatSurfaces: [],
			tabs: withoutPinnedTerminals(state.tabs), attachments: [], suggestions: [],
			voice: { ...state.voice, available: false },
			agents: state.agents?.map(({ copies: _copies, binary: _binary, pinned: _pinned, ...agent }) => agent) ?? [],
		},
		settings: { selection: state.selection, viewMode: state.viewMode, featureAi: state.featureAi,
			recordingQuality: state.recordingQuality, recordingSeconds: state.recordingSeconds },
	};
}

export interface ChromeChatCommand {
	readonly id: string;
	readonly chatId: string;
	readonly message: ViewToHost;
	readonly attachments?: readonly ChromeElementAttachment[];
}

export interface ChromeElementAttachment {
	readonly id: string;
	readonly label: string;
	readonly reference: string;
	readonly text: string;
	readonly kind?: 'element' | 'page' | 'sharedPage' | 'annotation' | 'screenshot' | 'file' | 'video';
	readonly file?: { readonly name: string; readonly mime: string; readonly base64: string };
	readonly tabId?: number;
	readonly annotation?: { readonly tabId: number; readonly url: string; readonly id: string };
}

export function readChromeElementAttachments(value: unknown): ChromeElementAttachment[] | undefined {
	if (!Array.isArray(value) || value.length > 8) { return undefined; }
	const attachments: ChromeElementAttachment[] = [];
	const ids = new Set<string>(), references = new Set<string>();
	let length = 0, binaryLength = 0;
	for (const raw of value) {
		if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(raw.id)
			|| typeof raw.label !== 'string' || raw.label.length > 160 || /[\u0000-\u001f]/.test(raw.label)
			|| typeof raw.reference !== 'string' || !/^@[1-9][0-9]{0,5}$/.test(raw.reference)
			|| typeof raw.text !== 'string' || !raw.text || raw.text.length > 64_000 || raw.text.includes('\0')
			|| ids.has(raw.id) || references.has(raw.reference)) { return undefined; }
		length += raw.text.length;
		if (length > 200_000) { return undefined; }
		ids.add(raw.id); references.add(raw.reference);
		if (raw.kind !== undefined && !['element', 'page', 'sharedPage', 'annotation', 'screenshot', 'file', 'video'].includes(raw.kind)) { return undefined; }
		if (raw.tabId !== undefined && (!Number.isSafeInteger(raw.tabId) || raw.tabId < 0 || raw.kind !== 'sharedPage')) { return undefined; }
		if (raw.annotation !== undefined && (raw.kind !== 'annotation' || !raw.annotation || typeof raw.annotation !== 'object'
			|| !Number.isSafeInteger(raw.annotation.tabId) || raw.annotation.tabId < 0 || typeof raw.annotation.url !== 'string'
			|| raw.annotation.url.length > 20_000 || !/^https?:/.test(raw.annotation.url)
			|| typeof raw.annotation.id !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.annotation.id))) { return undefined; }
		if (raw.file !== undefined) {
			const f = raw.file;
			if (!f || typeof f !== 'object' || !['screenshot', 'file', 'video'].includes(raw.kind)
				|| typeof f.name !== 'string' || !f.name || f.name.length > 160 || /[\u0000-\u001f/\\]/.test(f.name)
				|| typeof f.mime !== 'string' || !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(f.mime)
				|| typeof f.base64 !== 'string' || !f.base64 || f.base64.length % 4 !== 0
				|| !/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64)) { return undefined; }
			binaryLength += f.base64.length;
			if (binaryLength > 5_600_000) { return undefined; }
		}
		attachments.push({ id: raw.id, label: raw.label, reference: raw.reference, text: raw.text,
			...(raw.kind ? { kind: raw.kind } : {}), ...(raw.file ? { file: { name: raw.file.name, mime: raw.file.mime, base64: raw.file.base64 } } : {}),
			...(raw.tabId !== undefined ? { tabId: raw.tabId } : {}),
			...(raw.annotation ? { annotation: { tabId: raw.annotation.tabId, url: raw.annotation.url, id: raw.annotation.id } } : {}) });
	}
	return attachments;
}

/** Only explicit, bounded commands may cross from Chrome into the chat controller. */
export function readChromeChatCommand(value: unknown): ChromeChatCommand | undefined {
	if (!value || typeof value !== 'object') { return undefined; }
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(raw.id)
		|| typeof raw.chatId !== 'string' || raw.chatId.length > 100 || !raw.chatId
		|| !raw.message || typeof raw.message !== 'object') { return undefined; }
	const m = raw.message as Record<string, unknown>;
	const attachments = raw.attachments === undefined ? undefined : readChromeElementAttachments(raw.attachments);
	if (raw.attachments !== undefined && (!attachments || m.type !== 'send')) { return undefined; }
	let message: ViewToHost;
	switch (m.type) {
		case 'openBrowser':
			if (m.where !== 'vscode') { return undefined; }
			message = { type: 'openBrowser', where: 'vscode' }; break;
		case 'openAttachment':
			if (typeof m.id !== 'string' || m.id.length > 200 || typeof m.entry !== 'number' || !Number.isSafeInteger(m.entry) || m.entry < 0) { return undefined; }
			message = { type: 'openAttachment', id: m.id, entry: m.entry }; break;
		case 'setViewMode':
			if (m.mode !== 'minimal' && m.mode !== 'compact' && m.mode !== 'standard') { return undefined; }
			message = { type: 'setViewMode', mode: m.mode }; break;
		case 'saveFeatureAi':
			if (m.recordingSeconds !== undefined && (typeof m.recordingSeconds !== 'number' || !Number.isFinite(m.recordingSeconds))) { return undefined; }
			message = { type: 'saveFeatureAi', settings: readFeatureAiSettings(m.settings),
				recordingSeconds: m.recordingSeconds as number | undefined,
				...(m.recordingQuality === 'balanced' || m.recordingQuality === 'high' || m.recordingQuality === 'maximum' ? { recordingQuality: m.recordingQuality } : {}) }; break;
		case 'send':
			if (typeof m.text !== 'string' || (!m.text.trim() && !attachments?.length) || m.text.length > 100_000 || m.text.includes('\0')) { return undefined; }
			message = { type: 'send', text: m.text, ...(m.mode === 'queue' ? { mode: 'queue' as const } : {}) }; break;
		case 'stop': message = { type: 'stop' }; break;
		// Terminal lifecycle: the bridge asks for consent first, the host checks the setting and the share.
		case 'newTerminal':
			if (Object.keys(m).some(k => !['type', 'agent'].includes(k)) || (m.agent !== undefined && m.agent !== 'claude' && m.agent !== 'codex' && m.agent !== 'gemini')) { return undefined; }
			message = { type: 'newTerminal', ...(m.agent ? { agent: m.agent } : {}) }; break;
		case 'closeTerminal': case 'restartTerminal':
			if (typeof m.id !== 'string' || !m.id || m.id.length > 100 || Object.keys(m).some(k => !['type', 'id'].includes(k))) { return undefined; }
			message = { type: m.type, id: m.id }; break;
		case 'renameTerminal':
			if (typeof m.id !== 'string' || !m.id || m.id.length > 100 || typeof m.name !== 'string' || m.name.length > 200 || m.name.includes('\0')
				|| Object.keys(m).some(k => !['type', 'id', 'name'].includes(k))) { return undefined; }
			message = { type: 'renameTerminal', id: m.id, name: m.name }; break;
		case 'switchAgent':
			if (m.choice !== 'newTab' && m.choice !== 'replace' && m.choice !== 'continue' && m.choice !== 'cancel') { return undefined; }
			message = { type: 'switchAgent', choice: m.choice }; break;
		case 'select': {
			if (!m.selection || typeof m.selection !== 'object') { return undefined; }
			const s = m.selection as Record<string, unknown>;
			if (s.agent !== undefined && !['claude', 'codex', 'gemini'].includes(String(s.agent))) { return undefined; }
			if ([s.model, s.effort].some(v => v !== undefined && (typeof v !== 'string' || v.length > 200))) { return undefined; }
			message = { type: 'select', selection: { agent: s.agent as Selection['agent'], model: s.model as string | undefined,
				effort: s.effort as string | undefined, ...(typeof s.ultracode === 'boolean' ? { ultracode: s.ultracode } : {}) } }; break;
		}
		case 'approve': {
			if (typeof m.id !== 'string' || m.id.length > 200 || typeof m.allow !== 'boolean') { return undefined; }
			const answers: Record<string, string[]> = {};
			if (m.answers !== undefined) {
				if (!m.answers || typeof m.answers !== 'object' || Array.isArray(m.answers)) { return undefined; }
				for (const [key, values] of Object.entries(m.answers)) {
					if (key.length > 200 || !Array.isArray(values) || values.length > 100
						|| values.some(v => typeof v !== 'string' || v.length > 12_000)) { return undefined; }
					Object.defineProperty(answers, key, { value: values, enumerable: true });
				}
			}
			message = { type: 'approve', id: m.id, allow: m.allow, answers }; break;
		}
		default: {
			const footer = readChromeFooterMessage(m);
			if (!footer) { return undefined; }
			message = footer; break;
		}
	}
	return { id: raw.id, chatId: raw.chatId, message, ...(attachments?.length ? { attachments } : {}) };
}

export function readChromeChatConnection(value: unknown): ChromeChatConnection | undefined {
	if (!value || typeof value !== 'object') { return undefined; }
	const c = value as Record<string, unknown>;
	if (c.version !== 1 || typeof c.url !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(c.url)
		|| Number(c.url.split(':').at(-1)) > 65535 || typeof c.token !== 'string' || !/^[a-f0-9]{64}$/.test(c.token)
		|| typeof c.extensionId !== 'string' || !/^[a-p]{32}$/.test(c.extensionId)) { return undefined; }
	if (c.protocolVersion !== undefined && (typeof c.protocolVersion !== 'number' || !Number.isSafeInteger(c.protocolVersion) || c.protocolVersion < 1)) { return undefined; }
	if (c.editorVersion !== undefined && (typeof c.editorVersion !== 'string' || c.editorVersion.length > 50)) { return undefined; }
	if (c.deliverySession !== undefined && (typeof c.deliverySession !== 'string' || !/^[a-f0-9]{32}$/.test(c.deliverySession))) { return undefined; }
	return { version: 1, ...(c.deliverySession ? { deliverySession: c.deliverySession as string } : {}), url: c.url, token: c.token, extensionId: c.extensionId,
		...(c.capabilities !== undefined ? { capabilities: readChromeChatCapabilities(c.capabilities, c.protocolVersion) } : {}),
		...(c.protocolVersion !== undefined ? { protocolVersion: c.protocolVersion as number } : {}),
		...(c.editorVersion !== undefined ? { editorVersion: c.editorVersion as string } : {}) };
}

/** Project only validated fields; never forward arbitrary Chrome JSON to the editor. */
function readChromeFooterMessage(m: Record<string, unknown>): ViewToHost | undefined {
  const text = (key: string, max = 4096, optional = false): boolean =>
    m[key] === undefined ? optional : typeof m[key] === 'string' && (m[key] as string).length <= max && !(m[key] as string).includes('\0');
  const tab = () => text('tabId', 100) && !!m.tabId;
  const folder = () => text('folder') && !!m.folder;
  switch (m.type) {
    case 'usage': case 'listWorkdir': case 'chooseWorkdir': case 'trustWorkdir':
      return { type: m.type };
    case 'refreshWorkdirGit':
      return m.fetch === undefined || m.fetch === 'auto' || m.fetch === 'force' ? { type: m.type, ...(m.fetch ? { fetch: m.fetch } : {}) } : undefined;
    case 'compact': return tab() ? { type: m.type, tabId: m.tabId as string } : undefined;
    case 'setWorkdir': return text('path', 4096, true) ? { type: m.type, path: m.path as string | undefined } : undefined;
    case 'attachPath': case 'removeRepoFolder': return text('path') ? { type: m.type, path: m.path as string } : undefined;
    case 'listCommands': return ['claude', 'codex', 'gemini'].includes(String(m.agent)) ? { type: m.type, agent: m.agent as Selection['agent'] & string } : undefined;
    case 'runToolbarSkill': {
      if (!text('id', 200) || !text('tabId', 100, true) || !m.values || typeof m.values !== 'object' || Array.isArray(m.values)) { return undefined; }
      const values = Object.entries(m.values);
      if (values.length > 100 || values.some(([key, v]) => key.length > 200 || typeof v !== 'string' || v.length > 12000 || v.includes('\0'))) { return undefined; }
      return { type: m.type, id: m.id as string, tabId: m.tabId as string | undefined, values: Object.fromEntries(values) as Record<string, string>, again: m.again === true, queue: m.queue === true };
    }
    case 'saveToolbarSkill': {
      const skill = validToolbarSkill(m.skill);
      return typeof skill === 'string' ? undefined : { type: m.type, skill };
    }
    case 'deleteToolbarSkill': case 'stopToolbarSkill': return text('id', 200) ? { type: m.type, id: m.id as string } : undefined;
    case 'moveToolbarSkill': return text('id', 200) && (m.by === -1 || m.by === 1) ? { type: m.type, id: m.id as string, by: m.by } : undefined;
    case 'placeToolbarSkill': return text('id', 200) && text('target', 200) && typeof m.after === 'boolean' ? { type: m.type, id: m.id as string, target: m.target as string, after: m.after } : undefined;
    case 'toolbarApprove': return text('id', 200) && text('approvalId', 200) && typeof m.allow === 'boolean' ? { type: m.type, id: m.id as string, approvalId: m.approvalId as string, allow: m.allow } : undefined;
    case 'gitCommit': return folder() && tab() && (m.scope === undefined || m.scope === 'all' || m.scope === 'staged') ? { type: m.type, folder: m.folder as string, tabId: m.tabId as string, scope: m.scope as 'all' | 'staged' | undefined } : undefined;
    case 'gitIndexAction': return folder() && tab() && ['stage', 'unstage'].includes(String(m.action)) && text('path', 4096, true) ? { type: m.type, folder: m.folder as string, tabId: m.tabId as string, action: m.action as 'stage' | 'unstage', path: m.path as string | undefined } : undefined;
    case 'openGitDiff': return folder() && tab() && text('path') && typeof m.staged === 'boolean' ? { type: m.type, folder: m.folder as string, tabId: m.tabId as string, path: m.path as string, staged: m.staged } : undefined;
    case 'fixGitCommit': case 'dismissGitCommit': return folder() && tab() && text('id', 200) ? { type: m.type, folder: m.folder as string, tabId: m.tabId as string, id: m.id as string } : undefined;
    case 'gitBranchName': return folder() && tab() && Number.isSafeInteger(m.id) && (m.id as number) >= 0 ? { type: m.type, folder: m.folder as string, tabId: m.tabId as string, id: m.id as number } : undefined;
    case 'gitBranchAction': return folder() && text('name', 1024) && ['switch', 'create', 'delete'].includes(String(m.action)) ? { type: m.type, folder: m.folder as string, name: m.name as string, action: m.action as 'switch' | 'create' | 'delete', remote: m.remote === true } : undefined;
    case 'gitRemoteAction': return folder() && ['publish', 'push', 'pull'].includes(String(m.action)) && text('remote', 200, true) && text('confirmed', 4096, true) ? { type: m.type, folder: m.folder as string, action: m.action as 'publish' | 'push' | 'pull', remote: m.remote as string | undefined, confirmed: m.confirmed as string | undefined } : undefined;
    case 'restoreBranchStash': return folder() ? { type: m.type, folder: m.folder as string } : undefined;
    case 'openRepo': return text('repo', 2048) && text('branch', 1024) && ['copy', 'clone', 'reference'].includes(String(m.mode)) ? { type: m.type, repo: m.repo as string, branch: m.branch as string, mode: m.mode as 'copy' | 'clone' | 'reference' } : undefined;
    case 'repoAction': return ['changes', 'push', 'window', 'remove'].includes(String(m.action)) ? { type: m.type, action: m.action as 'changes' | 'push' | 'window' | 'remove' } : undefined;
    case 'dismissUsageAlert': {
      const a = m.alert as Record<string, unknown> | undefined;
      return a && ['claude', 'codex', 'gemini'].includes(String(a.agent)) && typeof a.label === 'string' && a.label.length <= 200 && typeof a.percent === 'number' && Number.isFinite(a.percent) && ['high', 'reached', 'credits'].includes(String(a.kind))
        ? { type: m.type, alert: { agent: a.agent, label: a.label, percent: a.percent, kind: a.kind } as import('./chatProtocol').UsageAlert } : undefined;
    }
    default: return undefined;
  }
}
