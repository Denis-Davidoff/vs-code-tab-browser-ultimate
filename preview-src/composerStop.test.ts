import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule } from 'typescript';

const source = readFileSync('preview-src/chat.ts', 'utf8');
const lift = (name: string) => new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`).exec(source)![0];

function fixture() {
	const classes = new Set<string>();
	const attributes = new Map<string, string>();
	const sendButton = { disabled: false, title: '', classList: { toggle(name: string, on: boolean) { on ? classes.add(name) : classes.delete(name); } }, setAttribute(name: string, value: string) { attributes.set(name, value); } };
	const state = { running: true, attachments: [] as any[], access: { tabs: [{ id: 'browser', owner: 'this' }] } };
	const input = { value: '' };
	const sendOptionsButton = { disabled: false };
	const posted: any[] = [];
	const render = runInNewContext(transpileModule(lift('renderSend'), {}).outputText + '\nrenderSend;', {
		state, input, sendButton, sendOptionsButton, navigator: { platform: 'Mac' }, canSend: () => true, refreshSendMenu() {},
		setIcon() {}, isPinChip: (chip: any) => chip.kind === 'terminal' && chip.pinned === true,
	});
	const send = runInNewContext(transpileModule(lift('send'), {}).outputText + '\nsend;', {
		state, input, canSend: () => true, isPinChip: (chip: any) => chip.kind === 'terminal' && chip.pinned === true,
		post: (message: unknown) => posted.push(message), toolbarInvocation() { assert.fail('an empty draft must not send'); },
	});
	const items = runInNewContext(transpileModule(lift('sendMenuItems'), {}).outputText + '\nsendMenuItems;', {
		state, input, navigator: { platform: 'Mac' }, canSend: () => true,
		isPinChip: (chip: any) => chip.kind === 'terminal' && chip.pinned === true,
		send: (mode?: string) => posted.push({ type: 'send', mode }), post: (message: unknown) => posted.push(message),
	});
	return { state, input, sendButton, sendOptionsButton, attributes, classes, render, send, posted, items };
}

test('browser and terminal pins leave Stop available and cannot submit an empty draft', () => {
	const f = fixture();
	f.state.attachments = [{ kind: 'terminal', pinned: true, terminalId: 'shell' }];
	f.render();
	assert.equal(f.attributes.get('aria-label'), 'Stop');
	assert.equal(f.sendButton.disabled, false);
	assert.equal(f.sendOptionsButton.disabled, false);
	assert.equal(f.items()[1].disabled, true);
	assert.equal(f.items()[2].disabled, true);
	f.send();
	assert.equal(f.posted.length, 0);
	f.state.running = false;
	f.render();
	assert.equal(f.sendButton.disabled, true);
	assert.equal(f.sendOptionsButton.disabled, true);
});

test('typing a follow-up or attaching a file keeps Stop as the main action with three menu choices', () => {
	const f = fixture();
	for (const file of [false, true]) {
		f.input.value = file ? '' : 'Follow up';
		f.state.attachments = file ? [{ kind: 'file', id: 'file' }] : [];
		f.render();
		assert.equal(f.attributes.get('aria-label'), 'Stop');
		assert.deepEqual(Array.from(f.items(), (item: any) => item.label), ['Stop', 'Send now', 'Send later']);
		assert.equal(f.items()[1].disabled, false);
		assert.equal(f.items()[2].disabled, false);
	}
	f.state.running = false;
	f.render();
	assert.equal(f.attributes.get('aria-label'), 'Send');
	assert.equal(f.items().length, 2);
});

test('send menu actions use the same immediate and queue paths as the displayed shortcuts', () => {
	const f = fixture();
	f.input.value = 'Follow up';
	const [stop, now, later] = f.items();
	assert.equal(now.shortcut, 'Enter');
	assert.equal(later.shortcut, '⌘Enter');
	stop.run(); now.run(); later.run();
	assert.deepEqual(JSON.parse(JSON.stringify(f.posted)), [{ type: 'stop' }, { type: 'send' }, { type: 'send', mode: 'queue' }]);
});

test('tapping the explicit send-options button opens queue choices without stopping the turn', () => {
	const f = fixture();
	f.input.value = 'Follow up';
	const handlers = new Map<string, () => void>();
	const options = { setAttribute() {}, addEventListener: (type: string, fn: () => void) => handlers.set(type, fn) };
	const main = { disabled: false, setAttribute() {} };
	let open = false;
	let items: any[] = [];
	const menu = { classList: { contains: () => open } };
	const anchors = new Map([[menu, { anchor: main }]]);
	const clickBinding = /sendOptionsButton\.addEventListener\('click', toggleSendMenu\);/.exec(source)![0];
	runInNewContext(transpileModule([
		lift('toggleSendMenu'), lift('openSendMenu'), lift('closeSendMenu'),
		clickBinding,
	].join('\n'), {}).outputText, {
		sendButton: main, sendOptionsButton: options, menu, overlayAnchors: anchors,
		clearTimeout() {}, sendMenuOpenTimer: undefined, sendMenuCloseTimer: undefined, sendMenuShape: '',
		sendMenuItems: f.items, openMenu: (_anchor: unknown, choices: any[]) => { open = true; items = choices; },
		closePopups: () => { open = false; },
	});
	handlers.get('click')!();
	assert.equal(open, true);
	assert.equal(f.posted.length, 0, 'opening choices must not stop the current turn');
	handlers.get('click')!(); assert.equal(open, false);
	handlers.get('click')!();
	items[2].run();
	assert.deepEqual(JSON.parse(JSON.stringify(f.posted)), [{ type: 'send', mode: 'queue' }]);
});
