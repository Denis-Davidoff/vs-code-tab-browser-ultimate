/** Real renderer and shipped styles on editor, Chrome and Exchange surfaces. */
import { surfaceControls } from '../src/chat/core/commands';
import type { ChatViewState, HostToView, ViewToHost } from '../src/chat/chatProtocol';

const output = document.getElementById('result')!;
const wait = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
const check = (value: unknown, message: string) => { if (!value) { throw Error(message); } };
const base: ChatViewState = {
	chatId: 'parity', activeTab: 'one', entries: Array.from({ length: 30 }, (_, i) => [
		{ kind: 'user' as const, text: `Question ${i}`, attachments: [] },
		{ kind: 'assistant' as const, text: `Answer ${i}\n\n${'A paragraph of the conversation. '.repeat(20)}` },
	]).flat(),
	voice: { available: false, maxSeconds: 60 }, detecting: false,
	agents: [{ id: 'codex', name: 'Codex', available: true, models: [{ id: 'test', label: 'Test', efforts: [], isDefault: true }] }],
	selection: { agent: 'codex', model: 'test' }, running: false, attachments: [], suggestions: [],
	hasBrowserTab: false, browserApi: false, newsHidden: true,
	tabs: [{ id: 'one', chatId: 'parity', title: 'Parity', running: false, busy: false, agents: 0, skillRuns: 0, queued: 0 }], tabLimit: 10,
	pendingSends: [], approvals: { policy: {}, servers: [] }, commands: {}, toolbar: [], toolbarRuns: {}, skillAgents: [], viewMode: 'compact', collapseTools: true,
	workdir: { picked: false, workspace: [], recent: [], locked: false, empty: true, references: [], recentRepos: [] },
};

async function run() {
	for (const surface of ['editor', 'chrome', 'exchange'] as const) {
		const frame = document.createElement('iframe');
		frame.style.cssText = 'height:740px;border:0;';
		document.body.append(frame);
		const doc = frame.contentDocument!;
		const commands: ViewToHost[] = [];
		let listener: ((message: HostToView) => void) | undefined;
		doc.open();
		const root = `/surface-assets/${surface}/`;
		doc.write(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${root}chat.css">${surface !== 'editor' ? `<link rel="stylesheet" href="${root}sidepanel.css">` : ''}${surface === 'exchange' ? `<link rel="stylesheet" href="${root}web-chat.css">` : ''}</head><body>${surface !== 'editor' ? `<header class="${surface === 'chrome' ? 'chrome' : 'remote'}-shell">Connected test workspace</header>` : ''}<div id="app"></div></body></html>`);
		doc.close();
		frame.contentWindow!.aiBrowserChatHost = {
			onMessage: fn => { listener = fn; }, postMessage: message => commands.push(message), getState: () => undefined, setState() {},
		};
		const script = doc.createElement('script');
		script.src = root + 'chat.js';
		await new Promise<void>((resolve, reject) => { script.onload = () => resolve(); script.onerror = () => reject(Error('Renderer load failed')); doc.body.append(script); });
		await wait();
		check(listener, `${surface}: renderer failed to subscribe`);
		const state = { ...base, surface, controls: surfaceControls(surface) };
		const show = async (next: ChatViewState = state) => { listener!({ type: 'state', state: next }); await wait(); };
		for (const width of [360, 768, 1280]) {
			frame.style.width = `${width}px`;
			await show();
			const thread = doc.querySelector<HTMLElement>('.thread')!;
			const badge = doc.querySelector<HTMLButtonElement>('.new-messages')!;
			check(thread.clientHeight > 100 && thread.scrollHeight > thread.clientHeight, `${surface}/${width}: thread does not scroll`);
			thread.scrollTop = thread.scrollHeight; await wait();
			check(badge.hidden, `${surface}/${width}: badge visible at end`);
			thread.scrollTop -= 120; await wait();
			check(badge.hidden, `${surface}/${width}: badge shown before a full-screen scroll without new messages`);
			thread.scrollTop -= thread.clientHeight; await wait();
			const rect = badge.getBoundingClientRect();
			check(!badge.hidden && rect.width > 0 && rect.height > 0, `${surface}/${width}: return button missing after a full-screen scroll`);
			check(rect.top >= 0 && rect.bottom <= frame.clientHeight, `${surface}/${width}: return button outside viewport`);
			const hit = doc.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
			check(hit && badge.contains(hit), `${surface}/${width}: return button is covered by ${hit?.className}`);
			badge.click(); await wait(700);
			check(thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60 && badge.hidden, `${surface}/${width}: return button did not reach the end`);
			thread.scrollTop -= 120; await wait();
			await show({ ...state, entries: [...state.entries, { kind: 'user', text: 'New unseen question', attachments: [] }, { kind: 'assistant', text: 'New unseen reply. '.repeat(50) }] });
			check(!badge.hidden && badge.classList.contains('fresh') && /2 new messages/.test(badge.textContent ?? ''), `${surface}/${width}: unseen arrivals not shown within one screen`);
			badge.click(); await wait(700);
			thread.scrollTop -= 120; await wait();
			check(badge.hidden, `${surface}/${width}: seen messages became new again`);
			const usage = (short: number, long: number) => ({ ...state, usage: { percent: Math.max(short, long), label: 'Weekly limit', usingCredits: false, windows: [{ label: '5-hour limit', usedPercent: short }, { label: 'Weekly limit', usedPercent: long }] } });
			await show(usage(60, 23));
			const button = doc.querySelector<HTMLElement>('.usage-button')!;
			check(button.textContent === '77' && button.querySelector<HTMLElement>('.ring-meter')!.style.getPropertyValue('--fill') === '60%', `${surface}/${width}: usage periods lost`);
			for (const [short, long, bg, fg] of [[100, 20, 'rgb(255, 212, 59)', 'rgb(229, 20, 31)'], [100, 100, 'rgb(229, 20, 31)', 'rgb(255, 212, 59)']] as const) {
				await show(usage(short, long));
				const style = frame.contentWindow!.getComputedStyle(button.querySelector('.ring-meter')!);
				check(button.textContent === 'U' && style.backgroundColor === bg && style.color === fg, `${surface}/${width}: exhausted quota colours differ`);
			}
			await show({ ...state, running: true });
			const send = doc.querySelector<HTMLButtonElement>('.input-actions .send')!;
			check(send.getAttribute('aria-label') === 'Stop' && !send.disabled, `${surface}/${width}: Stop unavailable`);
			send.click();
			check(commands.at(-1)?.type === 'stop', `${surface}/${width}: Stop not delivered`);
			const input = doc.querySelector<HTMLTextAreaElement>('textarea.input')!;
			input.value = 'Follow up'; input.dispatchEvent(new Event('input', { bubbles: true }));
			const sendOptions = doc.querySelector<HTMLButtonElement>('.input-actions .send-options')!;
			check(sendOptions && !sendOptions.disabled, `${surface}/${width}: tap-accessible send choices missing`);
			const beforeOpen = commands.length;
			sendOptions.click(); await wait();
			check(commands.length === beforeOpen, `${surface}/${width}: opening send choices stopped or sent a turn`);
			const items = [...doc.querySelectorAll<HTMLButtonElement>('.menu.open .menu-item')];
			check(items.length === 3 && !items[1].disabled && !items[2].disabled, `${surface}/${width}: Send/Queue actions missing while working`);
			items[2].click();
			check(commands.some(m => m.type === 'send' && m.text === 'Follow up' && m.mode === 'queue'), `${surface}/${width}: queued send not delivered`);
				// The tab list: always at the right end of the narrow strip, every tab by its whole name.
				const longTitle = 'A conversation whose title is far too long for the strip to show whole';
				await show({ ...state, tabs: [...state.tabs, { id: 'two', chatId: 'second', title: longTitle, running: false, busy: false, agents: 0, skillRuns: 0, queued: 0 }] });
				const listButton = doc.querySelector<HTMLButtonElement>('.tab-overflow-button');
				if (width < 1000) {
					check(listButton && !listButton.hidden, `${surface}/${width}: tab list button missing`);
					const strip = doc.querySelector<HTMLElement>('.tab-row')!.getBoundingClientRect();
					check(strip.right - listButton!.getBoundingClientRect().right < 16, `${surface}/${width}: tab list button not at the right end`);
					listButton!.click(); await wait();
					const rows = [...doc.querySelectorAll<HTMLElement>('.tab-overflow.open .tab-overflow-row')];
					check(rows.length === 2 && rows[0].classList.contains('current') && rows[1].textContent?.includes(longTitle), `${surface}/${width}: tab list does not show every tab`);
					check(doc.querySelector<HTMLElement>('.tab-overflow')!.getBoundingClientRect().width >= Math.min(300, width - 24), `${surface}/${width}: tab list too narrow`);
					check(/^All tabs.*shown/.test(doc.querySelector('.tab-overflow .menu-heading')?.textContent ?? '') && rows.every(r => r.classList.contains('shown-tab') || r.classList.contains('hidden-tab')), `${surface}/${width}: tab list does not say which tabs are shown`);
					const label = rows[1].querySelector<HTMLElement>('.menu-label')!;
					check(label.scrollWidth <= label.clientWidth + 1, `${surface}/${width}: tab list cuts a title`);
					doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait();
				} else {
					check(!listButton || listButton.hidden, `${surface}/${width}: tab list button shown beside the wide drawer`);
				}
				await show();
		}
		const shell = (id: string, status: 'running' | 'done' | 'failed', startedAt: number) => ({
			kind: 'tool' as const, id, tool: 'command' as const, name: 'Bash', input: `echo ${id}`, output: `Output ${id}`, status, startedAt,
			...(status !== 'running' ? { endedAt: startedAt + 100, exitCode: status === 'failed' ? 1 : 0 } : {}),
		});
		const live = shell('live', 'running', Date.now() - 1000);
		const shellState: ChatViewState = { ...state, entriesOffset: 40, runningShells: [live], entries: [
			{ kind: 'user', text: 'Run commands', attachments: [] }, shell('old', 'done', 1), shell('failed', 'failed', 2), live,
		] };
		await show(shellState);
		const tabs = [...doc.querySelectorAll<HTMLButtonElement>('.composer-tab')];
		const bash = tabs.find(b => b.textContent?.startsWith('Bash'))!;
		check(bash && tabs.some(b => b.textContent === 'Conversation') && !tabs.some(b => b.textContent === 'History'), `${surface}: Bash/Conversation labels missing`);
		bash.click(); await wait();
		const panel = doc.querySelector<HTMLElement>('.composer-bash')!;
		check(!panel.hidden, `${surface}: Bash tab did not open`);
		check([...panel.querySelectorAll('.cl-head-title')].map(e => e.textContent).join(',') === 'Running,All calls', `${surface}: Bash sections missing`);
		check([...panel.querySelectorAll('[data-shell-id]')].map(e => (e as HTMLElement).dataset.shellId).join(',') === 'live,live,failed,old', `${surface}: commands not ordered or duplicated by snapshot summaries`);
		check(panel.textContent?.includes('Exit 1') && panel.textContent?.includes('Show earlier calls'), `${surface}: exit codes or pagination missing`);
		const options = panel.querySelector<HTMLButtonElement>('[aria-label="View command output"]')!;
		options.click(); await wait();
		const outputMenu = [...doc.querySelectorAll<HTMLButtonElement>('.menu.open .menu-item')];
		check(outputMenu.some(b => b.textContent?.includes('Output in chat')), `${surface}: chat output choice missing`);
		const vscodeOutput = outputMenu.find(b => b.textContent?.includes('Output in VS Code terminal'));
		if (surface === 'editor') {
			check(vscodeOutput && !vscodeOutput.disabled, `${surface}: VS Code output choice unavailable`);
			vscodeOutput!.click(); await wait();
			check(commands.some(c => c.type === 'showShellOutput' && c.id === 'live' && c.chatId === state.chatId), `${surface}: output terminal action not delivered`);
		} else {
			check(!vscodeOutput || vscodeOutput.disabled, `${surface}: remote viewer can open editor terminals`);
			doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		}

		panel.querySelector<HTMLButtonElement>('[data-shell-id="live"]')!.click(); await wait();
		check(doc.querySelector('[data-tool-id="live"]')?.textContent?.includes('Output live'), `${surface}: command click did not reveal output`);
		// Revealing a row near the thread's top may already have requested the same page.
		const earlier = [...panel.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Show earlier calls'))!;
		earlier.click();
		check(commands.some(c => c.type === 'loadEarlier' && c.chatId === shellState.chatId), `${surface}: Bash pagination not delivered`);
		await show({ ...shellState, entriesOffset: 0, entries: shellState.entries.map(e => e.kind === 'tool' && e.id === 'live' ? { ...e, status: 'done', endedAt: Date.now() } : e), runningShells: [] });
		check(panel.querySelectorAll('[data-shell-id="live"]').length === 1 && panel.textContent?.includes('No shell command is running.'), `${surface}: completed command left in Running`);
		check(bash.querySelector<HTMLElement>('.composer-tab-count')?.hidden, `${surface}: running badge not cleared`);
		if (surface === 'editor') {
			const commandNode = doc.querySelector('[data-tool-id="live"]');
			listener!({ type: 'agentProcesses', chatId: state.chatId, snapshot: { supported: true, processes: [{
				id: 'process-one', pid: 12345, chatId: state.chatId, command: '/usr/local/bin/node', source: 'codex',
				startedAt: Date.now() - 10000, detached: true, attribution: 'environment',
			}] } }); await wait();
			check(panel.textContent?.includes('PID 12345') && panel.textContent.includes('Detached'), 'editor: detached process not shown in Bash');
			check(doc.querySelector('[data-tool-id="live"]') === commandNode, 'editor: process delta rebuilt conversation DOM');
			check(!bash.querySelector<HTMLElement>('.composer-tab-count')?.hidden, 'editor: process-only badge missing');
			panel.querySelector<HTMLButtonElement>('[aria-label="Stop process 12345"]')!.click();
			check(commands.some(c => c.type === 'stopAgentProcess' && c.chatId === state.chatId && c.id === 'process-one'), 'editor: process Stop lost chat scope');
			listener!({ type: 'agentProcesses', chatId: 'different-chat', snapshot: { supported: true, processes: [] } }); await wait();
			check(panel.textContent?.includes('PID 12345'), 'editor: late process delta from another chat replaced current state');
		}
		// An old task remains visible even after its initiating turn leaves the history window.
		await show({ ...shellState, entries: [{ kind: 'user', text: 'Recent turn', attachments: [] }] });
		check(panel.querySelector('[data-shell-id="live"]'), `${surface}: old running command disappeared outside the window`);
		await show({ ...state, chatId: 'another-chat', entries: [] });
		check(panel.querySelectorAll('[data-shell-id]').length === 0, `${surface}: command leaked across chats`);
		frame.remove();
	}
}
void run().then(() => { output.textContent = 'PASS: editor, Chrome and Exchange scroll navigation, usage and Stop at phone, tablet and desktop widths'; }, error => { output.textContent = `FAIL: ${error instanceof Error ? error.stack : error}`; });
