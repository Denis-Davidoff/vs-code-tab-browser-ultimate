import type { ChatViewState, ViewToHost } from '../src/chat/chatProtocol';

/** Real layout and pointer events: pins must cost no height and Stop must stay reachable. */
export async function checkComposerControls(frame: HTMLIFrameElement, initial: ChatViewState, received: ViewToHost[]): Promise<void> {
	const doc = frame.contentDocument!;
	const win = frame.contentWindow!;
	const wait = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
	const check = (value: unknown, message: string) => { if (!value) { throw new Error(message); } };
	const event = (target: HTMLElement, name: string) => {
		const e = doc.createEvent('Event'); e.initEvent(name, true, false); target.dispatchEvent(e);
	};
	const base: ChatViewState = {
		...initial, running: true, entries: [], visualizations: {},
		agents: [{ id: 'codex', name: 'Codex', available: true, models: [{ id: 'test', label: 'Test', efforts: [], isDefault: true }] }],
		selection: { agent: 'codex', model: 'test' }, attachments: [],
		access: { tabs: [], chrome: false, terminals: [] },
	};
	const pinned: ChatViewState = {
		...base,
		attachments: [{ id: 'terminal-pin', kind: 'terminal', label: 'Terminal 1', pinned: true, terminalId: 'terminal', terminalStatus: 'running' }],
		access: { chrome: false, terminals: [], tabs: [
			{ id: 'browser', title: 'A long browser tab title', url: 'https://example.test', owner: 'this', focused: true, chrome: false },
		] },
	};
	const show = async (state: ChatViewState) => { win.postMessage({ type: 'state', state }, location.origin); await wait(); };
	for (const width of [320, 540, 900]) {
		frame.style.width = `${width}px`; frame.style.height = '700px';
		await show(base);
		const composer = doc.querySelector<HTMLElement>('.composer')!;
		const height = composer.getBoundingClientRect().height;
		await show(pinned);
		check(Math.abs(composer.getBoundingClientRect().height - height) < 1, `Pins increased composer height at ${width}px: ${height} to ${composer.getBoundingClientRect().height}, input ${doc.querySelector<HTMLElement>('textarea.input')?.style.height}.`);
		check(doc.querySelectorAll('.input-wrap > .attachments .chip').length === 2, 'Browser and terminal are missing from the message input.');
		check(!doc.querySelector('.queue-button'), 'The separate queue button still exists.');
	}
	const input = doc.querySelector<HTMLTextAreaElement>('textarea.input')!;
	const send = doc.querySelector<HTMLButtonElement>('.input-actions .send')!;
	check(send.getAttribute('aria-label') === 'Stop' && !send.disabled, 'A pin hid or disabled Stop.');
	event(send, 'mouseenter'); await wait(240);
	const rows = () => [...doc.querySelectorAll<HTMLButtonElement>('.menu.open .menu-item')];
	check(rows().length === 3, 'Stop hover did not offer three actions.');
	check(rows()[1].disabled && rows()[2].disabled, 'Pins were treated as sendable content.');
	input.value = 'Follow up'; event(input, 'input'); await wait();
	check(send.getAttribute('aria-label') === 'Stop', 'Typing hid Stop.');
	check(rows().length === 3 && !rows()[1].disabled && !rows()[2].disabled, 'Send choices did not update after typing.');
	check(rows()[1].textContent?.includes('Enter') && rows()[2].textContent?.includes('Enter'), 'Send shortcuts are missing.');
	const menuRect = doc.querySelector<HTMLElement>('.menu.open')!.getBoundingClientRect();
	check(menuRect.bottom <= send.getBoundingClientRect().top + 1, 'Send menu did not open above the button.');
	rows()[1].click(); await wait();
	check(received.some(message => message.type === 'send' && message.text === 'Follow up' && message.mode === undefined), 'Immediate send did not reach the host.');
	input.value = 'Later'; event(input, 'input'); event(send, 'mouseenter'); await wait(240);
	rows()[2].click(); await wait();
	check(received.some(message => message.type === 'send' && message.text === 'Later' && message.mode === 'queue'), 'Deferred send did not reach the queue.');
	send.click(); await wait();
	check(received.some(message => message.type === 'stop'), 'Direct click on Stop did not stop the turn.');
	await show({ ...pinned, running: false });
	input.value = 'Idle'; event(input, 'input'); event(send, 'mouseenter'); await wait(240);
	check(rows().length === 2 && rows()[1].disabled, 'Idle send menu should have two choices with deferred send unavailable.');
}
