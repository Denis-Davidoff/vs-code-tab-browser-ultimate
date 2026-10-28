import { readChromeChatCommand, type ChromeChatCommand } from './chromeChatProtocol';
import { validSleepChoice } from '../power/sleepProtocol';
import type { ViewToHost } from './chatProtocol';

export type ExchangeUiMessage = ViewToHost | { readonly type: 'history' };
export interface ExchangeUiCommand { readonly type: 'chat.command'; readonly id: string; readonly chatId: string; readonly message: ExchangeUiMessage; readonly attachments?: ChromeChatCommand['attachments'] }

/** Reuse Chrome's bounded action projection, then add the local chat's navigation and controls. */
export function readExchangeUiCommand(value: unknown): ExchangeUiCommand | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
	const raw = value as Record<string, any>;
	if (raw.type !== 'chat.command' || typeof raw.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw.id)
		|| typeof raw.chatId !== 'string' || !raw.chatId || raw.chatId.length > 100
		|| Object.keys(raw).some(key => !['type', 'id', 'chatId', 'message', 'attachments'].includes(key))) { return undefined; }
	const base = readChromeChatCommand(raw);
	if (base) { return { type: 'chat.command', ...base }; }
	if (raw.attachments !== undefined || !raw.message || typeof raw.message !== 'object' || Array.isArray(raw.message)) { return undefined; }
	const m = raw.message;
	const text = (key: string, max = 4096) => typeof m[key] === 'string' && m[key].length <= max && !m[key].includes('\0');
	const id = () => text('id', 200) && !!m.id;
	let message: ExchangeUiMessage;
	switch (m.type) {
		case 'attach':
			if (!['screenshot','page','element','selection','annotation','pointAnnotation'].includes(m.kind)) { return undefined; } message = {type:'attach',kind:m.kind}; break;
		case 'ready': case 'history': case 'refreshAgents': case 'clearChat':
			message = { type: m.type }; break;
		case 'newChat': case 'newTab': message = { type: m.type, location: 'here' }; break;
		case 'removeAttachment': case 'openChat': case 'deleteChat': case 'closeTab': case 'selectTab': case 'unqueue': case 'stopAgent': case 'resumeInTerminal':
			if (!id()) { return undefined; } message = { type: m.type, id: m.id }; break;
		// Terminal lifecycle; the host checks again (`aiBrowser.chat.remoteTerminal`, encryption, consent, shared).
		case 'newTerminal':
			if (Object.keys(m).some(k => !['type','agent'].includes(k)) || (m.agent !== undefined && m.agent !== 'claude' && m.agent !== 'codex' && m.agent !== 'gemini' && m.agent !== 'openrouter' && m.agent !== 'opencode' && m.agent !== 'pi')) { return undefined; }
			message = { type: 'newTerminal', ...(m.agent ? { agent: m.agent } : {}) }; break;
		case 'closeTerminal': case 'restartTerminal':
			if (!id() || Object.keys(m).some(k => !['type','id'].includes(k))) { return undefined; } message = { type: m.type, id: m.id }; break;
		case 'renameTerminal':
			if (!id() || !text('name',200) || Object.keys(m).some(k => !['type','id','name'].includes(k))) { return undefined; } message = { type: 'renameTerminal', id: m.id, name: m.name }; break;
		case 'resumeQueue':
			if (!text('tabId',100)) { return undefined; } message = { type: 'resumeQueue', tabId: m.tabId }; break;
		case 'renameTab':
			if (!id() || !text('title',200)) { return undefined; } message = { type: 'renameTab', id: m.id, title: m.title }; break;
		case 'setApprovalMode':
			if (!text('key',100) || !['ask','auto','deny'].includes(m.mode)) { return undefined; } message = { type: 'setApprovalMode', key: m.key, mode: m.mode }; break;
		case 'openFile':
			if (!text('path')) { return undefined; } message = { type: 'openFile', path: m.path }; break;
		case 'openAttachment':
			if (!text('id',200) || typeof m.entry !== 'number' || !Number.isSafeInteger(m.entry) || m.entry < 0) { return undefined; }
			message = { type: 'openAttachment', id: m.id, entry: m.entry }; break;
		case 'openText': case 'openDiff':
			if (!text('name',200) || !text(m.type === 'openText' ? 'text' : 'diff',1000000)) { return undefined; }
			message = m.type === 'openText' ? { type: 'openText', name: m.name, text: m.text } : { type: 'openDiff', name: m.name, diff: m.diff }; break;
		case 'openLink':
			if (!text('url',20000) || typeof m.external !== 'boolean') { return undefined; } message = { type: 'openLink', url: m.url, external: m.external, reveal: m.reveal === true }; break;
		case 'localLinkInfo':
			if (!text('url',20000) || !Number.isSafeInteger(m.request)) { return undefined; } message = { type: 'localLinkInfo', url: m.url, request: m.request }; break;
		case 'setNewsHidden':
			if (typeof m.hidden !== 'boolean') { return undefined; } message = { type: 'setNewsHidden', hidden: m.hidden }; break;
		case 'setAutomaticAwake':
			if (typeof m.enabled !== 'boolean') { return undefined; } message = { type: 'setAutomaticAwake', enabled: m.enabled }; break;
		case 'setSleep': {
			const c = m.choice;
			if (!c || typeof c !== 'object' || !validSleepChoice(c)) { return undefined; }
			message = { type: 'setSleep', choice: c.mode === 'off' || c.mode === 'forever' ? {mode:c.mode} : c.mode === 'timer' ? {mode:'timer',minutes:c.minutes} : {mode:'agents',scope:c.scope,tabId:c.tabId} }; break;
		}
		case 'temporaryStorage':
			if (!['refresh','all','project'].includes(m.action) || (m.project !== undefined && !text('project'))) { return undefined; }
			message = { type: 'temporaryStorage', action: m.action, project: m.project }; break;
		case 'secondOpinion':
			if (!text('chatId',100) || !Number.isSafeInteger(m.index) || m.index < 0 || !['claude','codex','gemini','openrouter','opencode','pi'].includes(m.agent) || !text('model',200)) { return undefined; }
			message = { type: 'secondOpinion', chatId:m.chatId,index:m.index,agent:m.agent,model:m.model }; break;
		case 'exportChat':
			if (!['clipboard','file'].includes(m.to)) { return undefined; } message = {type:'exportChat',to:m.to}; break;
		case 'openAgentSetting': case 'setAgentBinary':
			if (!['claude','codex','gemini','openrouter','opencode','pi'].includes(m.agent) || (m.path !== undefined && !text('path'))) { return undefined; }
			message = m.type === 'setAgentBinary' ? {type:'setAgentBinary',agent:m.agent,path:m.path} : {type:'openAgentSetting',agent:m.agent}; break;
		case 'openBrowser':
			if (m.where !== undefined && !['vscode','chrome'].includes(m.where)) { return undefined; } message = { type:'openBrowser',where:m.where }; break;
		default: return undefined;
	}
	return { type:'chat.command',id:raw.id,chatId:raw.chatId,message };
}
