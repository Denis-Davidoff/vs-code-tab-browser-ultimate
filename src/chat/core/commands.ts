import type { ViewToHost } from '../chatProtocol';

/**
 * Every message the chat's view can send, and what each surface does with it.
 * This is the one list: the Chrome side panel's forwarding, the host's checks
 * for Chrome and the Exchange website, and the website's refusals all read it,
 * and `satisfies Record<ViewToHost['type'], …>` makes a new message type fail
 * the typecheck until it has a row. A remote surface may do only what its row
 * says (`host`); anything else is refused there, so a new type is closed by
 * default. Leaf module: types only from elsewhere, no `vscode`.
 */
export type SurfaceKind = 'editor' | 'chrome' | 'exchange';
export type RemoteSurface = Exclude<SurfaceKind, 'editor'>;

/**
 * - `host`: the surface forwards it and the host carries it out;
 * - `local`: the surface's own shim answers it, nothing reaches the host;
 *   `{ local }` the same, with what the host says if it does arrive;
 * - `mixed`: some forms are local or refused by the host (an attachment kind,
 *   a link opened in the viewer's own browser); the host still checks the rest;
 * - `{ no }`: unavailable there, with the reason shown to the user.
 */
export type SurfaceRule = 'host' | 'local' | 'mixed' | { readonly local: string } | { readonly no: string; readonly hide?: true };

/** The feature a command belongs to, as negotiated with the Chrome side panel. */
export type CommandFeature = 'chat' | 'usage' | 'context' | 'skills' | 'workdir' | 'git' | 'github';

export interface CommandSpec {
	readonly feature: CommandFeature;
	readonly chrome: SurfaceRule;
	readonly exchange: SurfaceRule;
}

const editorOnly = 'This action is available only in VS Code.';
const chromeEditor = 'This action is available in the editor. Chrome supports chat, attachments, approvals, model selection and chat settings.';
const approvals = 'Approvals are set only in VS Code: a remote Auto would run commands without a card.';
const internal = 'Internal to the editor.';

/** Shorthands for the common rows. */
const chat = (chrome: SurfaceRule, exchange: SurfaceRule): CommandSpec => ({ feature: 'chat', chrome, exchange });
const both = (feature: CommandFeature): CommandSpec => ({ feature, chrome: 'host', exchange: 'host' });
const local = chat('local', 'local');
const editor = (reason = editorOnly): CommandSpec => chat({ no: chromeEditor }, { no: reason });
/** Physically impossible away from the editor's machine (its microphone, its screen): hidden, not disabled. */
const machine = (reason: string): CommandSpec => chat({ no: reason, hide: true }, { no: reason, hide: true });

const terminal = machine('Terminals run only in VS Code, on the editor\u2019s own machine.');
const terminalStream = 'Terminal output and keys use the terminal stream.';
const terminalLifecycle: CommandSpec = chat('host', 'host');
const terminalLocal = (reason: string): CommandSpec => chat({ local: reason }, { local: reason });

export const COMMANDS = {
	// Pairing and the window's own plumbing: never from a remote surface.
	connectExchange: editor(internal), disconnectExchange: editor(internal), answerChromeConnection: editor(internal),
	reportTheme: chat('local', 'local'), copy: local, saveDrafts: local, tabDraft: local,
	ready: chat('local', 'host'),
	loadEarlier: chat('host', 'host'),

	// Terminal tabs: a shell on the editor's machine. Chrome and the website reach the ones the editor
	// shares (`aiBrowser.chat.remoteTerminal`; the website on encrypted connections only): lifecycle as
	// commands, gated again by the host (consent, setting); output, keys and acks as `terminal.*` frames
	// (`remoteTerminalProtocol.ts`, Chrome's over the bridge's `/terminal` routes), never here.
	newTerminal: terminalLifecycle, closeTerminal: terminalLifecycle, renameTerminal: terminalLifecycle, restartTerminal: terminalLifecycle,
	selectTerminal: terminalLocal('Handled in the browser.'),
	terminalAttach: terminalLocal(terminalStream), terminalInput: terminalLocal(terminalStream), terminalResize: terminalLocal(terminalStream), terminalAck: terminalLocal(terminalStream),
	// The editor's clipboard and its front conversation are never the website's.
	terminalPasteRequest: terminalLocal('Handled in the browser.'), terminalToChat: terminal,
	pinTerminal: terminal, terminalAskAgent: terminal, setTerminalAgentControl: terminal,
	setTerminalRemote: editor('Remote access to a terminal is granted only in VS Code.'), terminalInsert: terminal,
	runInTerminal: editor('Commands run only in VS Code.'),

	// The conversation.
	send: chat('host', 'host'), stop: chat('host', 'host'), select: chat('host', 'host'), switchAgent: chat('host', 'host'),
	approve: chat('host', 'host'), setViewMode: chat('host', 'host'), saveFeatureAi: chat('host', 'host'),
	openAttachment: chat('mixed', 'mixed'),
	reattachAttachment: editor('Attaching a saved item is available in VS Code.'),
	unqueue: chat({ no: chromeEditor }, 'host'), resumeQueue: chat({ no: chromeEditor }, 'host'),
	clearChat: chat({ no: chromeEditor }, 'host'), exportChat: chat({ no: chromeEditor }, 'mixed'),
	attach: chat('local', 'mixed'), pasteFile: chat('local', 'local'), removeAttachment: chat('local', 'mixed'),
	pasteAttachments: editor('Attachments pasted here stay text outside VS Code.'),
	rememberAttachments: editor('Attachment clipboard snapshots are kept only in VS Code.'),
	acceptSuggestion: chat('local', 'local'), stopAgent: chat({ no: chromeEditor }, 'host'), secondOpinion: chat({ no: chromeEditor }, 'host'),
	refreshAgents: chat({ no: chromeEditor }, 'host'),

	// Tabs and history.
	newChat: chat({ no: chromeEditor }, 'host'), newTab: chat({ no: chromeEditor }, 'host'),
	// Chrome's tab strip picks which editor conversation the side panel shows (a pin).
	selectTab: chat('local', 'mixed'), closeTab: chat({ no: chromeEditor }, 'host'), renameTab: chat({ no: chromeEditor }, 'host'),
	openChat: editor('Opening another saved conversation is available only in VS Code.'),
	tabAccess: editor('Who may use a browser tab is decided only in VS Code.'),
	listAllAgents: editor('Every chat\'s agents are listed only in VS Code.'),
	listHistory: editor('The saved conversations are listed only in VS Code.'),
	deleteChat: editor('Deleting saved conversations is available only in VS Code.'),
	resolveHistoryChat: editor(), resumeInTerminal: editor('Terminals are available only in VS Code.'),
	placeTab: editor(), placeTerminal: editor(), beginTabDrag: editor(), acceptTabDrop: editor(), moveTabTo: editor(), moveTabToNew: editor(), moveTerminalTo: editor(), moveTerminalToNew: editor(),

	// Settings that act on the editor or its machine.
	setApprovalMode: editor(approvals),
	setAgentBinary: editor('Agent apps are chosen only in VS Code.'), openAgentSetting: editor('Agent apps are chosen only in VS Code.'),
	authenticateAgent: editor('Sign in to the agent in the VS Code window.'), checkAgentAuthentication: editor('Check agent sign-in in the VS Code window.'),
	temporaryStorage: editor('Temporary files are managed only in VS Code.'),
	// The key and the model list decide where prompts and the key are sent: edited only in the editor, never from a remote surface.
	// These switches decide what a remote surface may open on this machine: changed only in the editor, never from the surface they limit.
	soundSettings: editor('The finish sound is changed only in VS Code.'),
	osNotify: editor('Chrome and the website show their own notification.'),
	remoteTerminalSettings: editor('Remote terminal access is changed only in VS Code.'),
	openrouter: editor('The OpenRouter key and models are edited only in VS Code.'),
	setNewsHidden: chat({ no: chromeEditor }, 'host'),
	setAutomaticAwake: chat({ no: chromeEditor }, 'host'), setSleep: chat({ no: chromeEditor }, 'host'),
	setExchangeKeepAwake: editor(),
	controlRecording: chat('local', { no: 'Recording is available in VS Code and Chrome.', hide: true }),
	recording: machine('Recording is available in VS Code and Chrome.'),
	voiceStart: machine('Voice messages need the microphone of the computer running VS Code.'),
	voiceStop: machine('Voice messages need the microphone of the computer running VS Code.'),
	voiceCancel: machine('Voice messages need the microphone of the computer running VS Code.'),

	// Opening things.
	openText: chat({ no: chromeEditor }, 'host'), openDiff: chat({ no: chromeEditor }, 'host'),
	saveAttachment: editor(), openFile: editor('Local files open only in VS Code.'),
	openLink: chat('local', 'mixed'), localLinkInfo: chat({ no: chromeEditor }, 'host'),
	openBrowser: chat('mixed', 'mixed'),

	// Footer features, negotiated with Chrome per feature.
	usage: both('usage'), dismissUsageAlert: both('usage'),
	compact: both('context'),
	listCommands: both('skills'), runToolbarSkill: both('skills'), stopToolbarSkill: both('skills'), toolbarApprove: both('skills'),
	saveToolbarSkill: both('skills'), deleteToolbarSkill: both('skills'), moveToolbarSkill: both('skills'), placeToolbarSkill: both('skills'),
	listWorkdir: both('workdir'), setWorkdir: { feature: 'workdir', chrome: 'host', exchange: 'mixed' },
	// The website asks for the path in a dialog of its own and sends `setWorkdir`.
	chooseWorkdir: { feature: 'workdir', chrome: 'host', exchange: { local: 'Enter the folder path in the website instead of opening a local folder dialog.' } }, attachPath: both('workdir'),
	refreshWorkdirGit: both('git'), gitCommit: both('git'), gitIndexAction: both('git'), openGitDiff: both('git'),
	fixGitCommit: both('git'), dismissGitCommit: both('git'), gitBranchName: both('git'), gitBranchAction: both('git'),
	gitRemoteAction: both('git'), restoreBranchStash: both('git'),
	githubStatus: editor('Pull requests and Actions runs are listed only in VS Code.'),
	files: editor('Files are browsed only in VS Code.'),
	githubCreatePr: editor('Pull requests are opened only from VS Code.'),
	openRepo: both('github'), repoAction: both('github'), trustWorkdir: both('github'), removeRepoFolder: both('github'),
} as const satisfies Record<ViewToHost['type'], CommandSpec>;

export type CommandType = keyof typeof COMMANDS;

export function commandSpec(type: string): CommandSpec | undefined {
	return Object.prototype.hasOwnProperty.call(COMMANDS, type) ? (COMMANDS as Record<string, CommandSpec>)[type] : undefined;
}

/** The feature a message belongs to; unknown types count as chat. */
export function commandFeature(type: string): CommandFeature {
	return commandSpec(type)?.feature ?? 'chat';
}

/** Whether the host may act on this message from a remote surface. */
export function remoteAllowed(surface: RemoteSurface, type: string): boolean {
	const rule = commandSpec(type)?.[surface];
	return rule === 'host' || rule === 'mixed';
}

/** Why a remote surface may not do this, or `undefined` when it may. */
export function remoteRefusal(surface: RemoteSurface, type: string): string | undefined {
	const rule = commandSpec(type)?.[surface];
	if (rule === 'host' || rule === 'mixed') { return undefined; }
	if (rule && typeof rule === 'object') { return 'local' in rule ? rule.local : rule.no; }
	return surface === 'chrome' ? chromeEditor : editorOnly;
}

/** The types a surface forwards to the host. */
export function forwardedTypes(surface: RemoteSurface): string[] {
	return Object.keys(COMMANDS).filter(type => remoteAllowed(surface, type));
}

/**
 * What the renderer shows for a control: on, disabled with the reason (so the
 * tooltip says why before anything is clicked), or hidden. Policy and
 * destructive actions are disabled with a reason; what cannot work away from
 * the editor's machine at all is hidden.
 */
export type Availability = { readonly s: 'on' } | { readonly s: 'off'; readonly reason: string } | { readonly s: 'hidden' };
export type ControlMap = Readonly<Record<string, Availability>>;

/**
 * Controls that are not one message type: a form of a `mixed` command that the
 * surface refuses. Keyed `<type>.<form>`.
 */
const formRules: Readonly<Record<RemoteSurface, Readonly<Record<string, Availability>>>> = {
	// The website's own request for the history list (`history`, not a `ViewToHost`).
	chrome: { history: { s: 'hidden' } },
	exchange: {
		'attach.file': { s: 'on' },
	},
};

/**
 * The control map a surface's state carries: only what is not on, so the
 * editor's own state (no map) means everything is on. Built from the table, so
 * the renderer and the host's refusals can never disagree.
 */
export function surfaceControls(surface: SurfaceKind): ControlMap {
	if (surface === 'editor') { return {}; }
	const result: Record<string, Availability> = Object.create(null);
	for (const [type, spec] of Object.entries(COMMANDS) as [string, CommandSpec][]) {
		const rule = spec[surface];
		if (rule && typeof rule === 'object' && 'no' in rule) {
			result[type] = rule.hide ? { s: 'hidden' } : { s: 'off', reason: rule.no };
		}
	}
	for (const [id, value] of Object.entries(formRules[surface])) {
		if (value.s !== 'on') { result[id] = value; }
	}
	return result;
}

/** A control's availability in a map; absent is on. */
export function controlOf(controls: ControlMap | undefined, id: string): Availability {
	return (controls && Object.prototype.hasOwnProperty.call(controls, id) ? controls[id] : undefined) ?? { s: 'on' };
}
