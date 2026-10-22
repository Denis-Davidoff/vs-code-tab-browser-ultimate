import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as vscode from 'vscode';
import { hostIsRemote } from '../setup/proposedApi';
import { chrome } from '../browser/chromeBrowser';
import { ChromeChatBridge, ChromeChatDelivery } from './chromeChatBridge';
import { ChromeChatPairing } from './chromeChatPairing';
import type { ChromeChatConnection } from './chromeChatProtocol';
import { ChatViewProvider, chatViewId } from './chatView';

/**
 * Resume grants: one per Chrome extension ID, kept as a hash in SecretStorage
 * (shared by every window of this profile). The key itself lives only in that
 * extension's `chrome.storage.local`. Disconnect Chrome Chat forgets them all.
 */
const resumeKey = 'aiBrowser.chromeChat.resume';
const hashOf = (key: string) => createHash('sha256').update(key).digest('hex');
async function readGrants(context: vscode.ExtensionContext): Promise<Record<string, string>> {
	try {
		const raw = JSON.parse(await context.secrets.get(resumeKey) ?? '{}') as unknown;
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return {}; }
		return Object.fromEntries(Object.entries(raw).filter(([id, hash]) => /^[a-p]{32}$/.test(id) && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)));
	} catch { return {}; }
}
async function grantResume(context: vscode.ExtensionContext, extensionId: string): Promise<string | undefined> {
	const key = randomBytes(32).toString('hex');
	try {
		const grants = await readGrants(context);
		grants[extensionId] = hashOf(key);
		await context.secrets.store(resumeKey, JSON.stringify(grants));
		return key;
	} catch { return undefined; /* no resume, only the click next time */ }
}
async function checkResume(context: vscode.ExtensionContext, extensionId: string, key: string): Promise<boolean> {
	const stored = (await readGrants(context))[extensionId];
	if (!stored) { return false; }
	return timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(hashOf(key), 'hex'));
}

/**
 * Full mode: the Chrome the panel runs in is the one the agents' browser tools
 * drive, i.e. it was opened from the editor (or attached to it). Told by the
 * extension's own pages among that Chrome's targets. Never starts a Chrome:
 * `chrome.targets()` connects, so it is only asked while one is connected.
 */
function watchDriven(bridge: ChromeChatBridge): vscode.Disposable {
	let busy = false;
	const prefix = `chrome-extension://${bridge.extensionId}/`;
	const check = async () => {
		if (busy) { return; }
		busy = true;
		try { bridge.setDriven(chrome.connected && (await chrome.targets()).some(target => target.url.startsWith(prefix))); }
		catch { bridge.setDriven(false); }
		finally { busy = false; }
	};
	void check();
	const timer = setInterval(() => void check(), 3000);
	return new vscode.Disposable(() => clearInterval(timer));
}

/** Pairing is explicit, local to one IDE window, and revoked by re-pairing or shutdown. */
export function registerChromeChat(context: vscode.ExtensionContext): void {
	const editorVersion = String(context.extension.packageJSON.version);
	let connection: vscode.Disposable | undefined;
	let connecting = false;
	const deliveries = new Map<string, ChromeChatDelivery>();
	let generation = 0;
	const pairing = new ChromeChatPairing(vscode.workspace.name ? `AI Browser · ${vscode.workspace.name}` : 'AI Browser', async (id, extensionId, signal) => {
		const current = ++generation;
		if (signal.aborted) { return undefined; }
		await vscode.commands.executeCommand(`${chatViewId}.focus`);
		if (signal.aborted) { return undefined; }
		const sourceId = await ChatViewProvider.requestChromeConnection(id, extensionId, signal);
		if (!sourceId || signal.aborted || current !== generation) { return undefined; }
		const delivery = new ChromeChatDelivery();
		deliveries.set(extensionId, delivery);
		const bridge = new ChromeChatBridge(extensionId, (command, reply) => ChatViewProvider.commandChromeSource(sourceId, command.chatId, command.message, command.attachments, reply), editorVersion, delivery);
		let attached: vscode.Disposable | undefined;
		try {
			const config = await bridge.start();
			attached = ChatViewProvider.observeChromeSource(sourceId, bridge);
			if (signal.aborted || current !== generation) { attached.dispose(); return undefined; }
			connection?.dispose(); connection = vscode.Disposable.from(attached, watchDriven(bridge));
			const resume = await grantResume(context, extensionId);
			return resume ? { ...config, resumeKey: resume } as ChromeChatConnection : config;
		} catch (error) { attached?.dispose(); bridge.close(); throw error; }
	}, 90_000, editorVersion, message => { void vscode.window.showWarningMessage(message); });
	pairing.onResume(async (extensionId, key, chatId, strict) => {
		const requested = generation;
		const allowed = await checkResume(context, extensionId, key);
		if (requested !== generation) { return 'unavailable'; }
		if (!allowed) { return undefined; }
		// First pass from Chrome: only the window that holds its conversation answers.
		if (strict && chatId && ChatViewProvider.chromeSourceFor(chatId, true) === undefined) { return 'elsewhere'; }
		const current = ++generation;
		let sourceId = ChatViewProvider.chromeSourceFor(chatId);
		if (!sourceId) {
			// The chat view is not open yet after a restart: open it, then wait for it to resolve.
			await vscode.commands.executeCommand(`${chatViewId}.focus`);
			for (let i = 0; i < 30 && !sourceId; i++) {
				await new Promise(resolve => setTimeout(resolve, 100));
				sourceId = ChatViewProvider.chromeSourceFor(chatId);
			}
		}
		if (!sourceId || current !== generation) { return 'unavailable'; }
		const source = sourceId;
		const delivery = deliveries.get(extensionId) ?? new ChromeChatDelivery();
		deliveries.set(extensionId, delivery);
		const bridge = new ChromeChatBridge(extensionId, (command, reply) => ChatViewProvider.commandChromeSource(source, command.chatId, command.message, command.attachments, reply), editorVersion, delivery);
		bridge.pin(chatId);
		let attached: vscode.Disposable | undefined;
		try {
			const config = await bridge.start();
			attached = ChatViewProvider.observeChromeSource(source, bridge);
			if (current !== generation) { attached.dispose(); return undefined; }
			connection?.dispose(); connection = vscode.Disposable.from(attached, watchDriven(bridge));
			return config;
		} catch (error) { attached?.dispose(); bridge.close(); throw error; }
	});
	context.subscriptions.push(pairing);
	if (!hostIsRemote()) { void pairing.start().catch(error => {
		console.warn(`AI Browser quick connection unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}); }
	context.subscriptions.push({ dispose: () => { generation++; connection?.dispose(); } });
	context.subscriptions.push(vscode.commands.registerCommand('aiBrowser.chat.disconnectChrome', () => {
		generation++;
		pairing.cancelPending();
		connection?.dispose(); connection = undefined; deliveries.clear();
		// Revoking means Chrome must be allowed again, not quietly resumed.
		void context.secrets.delete(resumeKey).then(undefined, () => undefined);
		void vscode.window.showInformationMessage('Chrome chat connection revoked.');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('aiBrowser.chat.connectChrome', async () => {
		if (connecting) { return; }
		connecting = true;
		const current = ++generation;
		pairing.cancelPending();
		let bridge: ChromeChatBridge | undefined;
		let attached: vscode.Disposable | undefined;
		try {
			if (hostIsRemote()) { throw new Error('Chrome chat currently requires a local VS Code window.'); }
			await vscode.commands.executeCommand(`${chatViewId}.focus`);
			const sources = ChatViewProvider.chromeSources();
			const source = sources.length === 1 ? sources[0] : await vscode.window.showQuickPick(sources, {
				placeHolder: 'Choose the chat panel to display in Chrome',
			});
			if (!source) { return; }
			const extensionId = await vscode.window.showInputBox({
				title: 'Connect Chrome chat', prompt: 'Paste the extension ID shown in the AI Browser Chrome side panel',
				ignoreFocusOut: true,
				validateInput: value => /^[a-p]{32}$/.test(value.trim()) ? undefined : 'A Chrome extension ID contains 32 letters (a–p).',
			});
			if (extensionId === undefined) { return; }
			const delivery = new ChromeChatDelivery();
			deliveries.set(extensionId.trim(), delivery);
			bridge = new ChromeChatBridge(extensionId.trim(), (command, reply) => ChatViewProvider.commandChromeSource(source.id, command.chatId, command.message, command.attachments, reply), editorVersion, delivery);
			const config = await bridge.start();
			attached = ChatViewProvider.observeChromeSource(source.id, bridge);
			await vscode.env.clipboard.writeText(JSON.stringify(config));
			if (current !== generation) { return; }
			connection?.dispose();
			connection = vscode.Disposable.from(attached, watchDriven(bridge!));
			attached = undefined;
			bridge = undefined;
			void vscode.window.showInformationMessage('Connection code copied. Paste it into the Chrome side panel. It shows the active conversation of the selected panel.');
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not connect Chrome chat: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			attached?.dispose(); bridge?.close(); connecting = false;
		}
	}));
}
