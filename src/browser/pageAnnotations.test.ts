import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { annotationClipboardText, annotationColors, parseAnnotations } from './annotationData.ts';

function fixture() {
	const clipboard: string[] = [];
	const deletion = { confirm: false, asked: 0 };
	class Client {
		isClosed = false;
		url = 'https://example.test/first';
		listeners = new Map<string, ((params: any, sid?: string) => void)[]>();
		records: any[] = [];
		nextNumber = 1;
		async attachToPage() { return 'session'; }
		on(method: string, callback: (params: any, sid?: string) => void) {
			const entries = this.listeners.get(method) ?? []; entries.push(callback); this.listeners.set(method, entries);
			return { dispose: () => this.listeners.set(method, entries.filter(entry => entry !== callback)) };
		}
		emit(method: string, params: any, sid = 'session') { for (const callback of this.listeners.get(method) ?? []) { callback(params, sid); } }
		async send(method: string, args: any) {
			if (this.isClosed) { throw new Error('closed'); }
			if (method === 'Page.getFrameTree') { return { frameTree: { frame: { id: 'main' } } }; }
			if (method === 'Page.createIsolatedWorld') { return { executionContextId: 42 }; }
			if (method !== 'Runtime.evaluate') { return {}; }
			const api = {
				hydrate: (data: any) => { this.records = data.records; this.nextNumber = data.nextNumber; },
				start: (data: any) => { this.records = data.records; this.nextNumber = data.nextNumber; },
				collect: () => ({ url: this.url, records: this.records.map(record => ({ ...record, elementFound: true })) }),
				remove: (ids: string[]) => { this.records = this.records.filter(record => !ids.includes(record.id)); },
				add: (selector: string, text: string, color: string, id: string) => {
					if (selector === '#missing') { return { error: 'No element on the page matches the selector.' }; }
					const record = { id, number: this.nextNumber++, createdAt: 1, text, color, element: { selector, strong: true, tag: 'button', text: 'Save', role: '' } };
					this.change([...this.records, record]);
					return { id, number: record.number, url: this.url };
				},
			};
			return { result: { value: runInNewContext(args.expression, { __api: api, location: { href: this.url }, globalThis: {} }) } };
		}
		dispose() { this.isClosed = true; }
		async close() { this.dispose(); }
		change(records: any[], context = 42) {
			this.records = records;
			this.emit('Runtime.bindingCalled', { name: '__aiBrowserAnnotationChanged', executionContextId: context, payload: JSON.stringify({ type: 'change', url: this.url, records }) });
		}
	}
	const exports: any = {};
	runInNewContext(transpileModule(readFileSync('src/browser/pageAnnotations.ts', 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText, {
		exports, setTimeout, clearTimeout, AbortController,
		require: (name: string) => name === '../core/cdp' ? { CDPClient: class { constructor(channel: any) { return channel; } } }
			: name === './annotationData' ? { parseAnnotations, annotationColors, annotationClipboardText }
				: name === 'crypto' ? { randomUUID: () => '00000000-0000-0000-0000-0000000000aa' } : name === './annotationScript' ? { annotationSource: '__api' }
				: name === '../core/notify' ? { confirm() {}, refuse() {} }
					: name === 'vscode' ? { env: { clipboard: { writeText: async (text: string) => { clipboard.push(text); } } },
						window: { showWarningMessage: async () => { deletion.asked++; return deletion.confirm ? 'Delete' : undefined; } } } : {},
	});
	const client = new Client();
	const tab: any = { url: client.url, startCDPSession: async () => client };
	return { annotations: new exports.PageAnnotations(), client, tab, clipboard, deletion };
}
const note = (number: number) => ({ id: `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`, number, createdAt: 100,
	text: 'Please change this', element: { selector: '#save', strong: true, tag: 'button', text: 'Save', role: '' } });

test('host stores notes, paginates, removes by ID without renumbering, and clears overlay', async () => {
	const { annotations, client, tab } = fixture();
	try {
		await annotations.start(tab); client.change([note(1), note(2), note(3)]);
		const first = await annotations.list(tab, 0, 2);
		assert.equal(first.total, 3); assert.equal(first.hasMore, true); assert.equal(first.annotations[0].elementFound, true);
		assert.equal((await annotations.remove(tab, [note(2).id])).removed, 1);
		assert.deepEqual(Array.from((await annotations.list(tab, 0, 10)).annotations, (record: any) => record.number), [1, 3]);
		assert.equal(client.records.length, 2);
		assert.equal((await annotations.remove(tab, undefined)).removed, 2); assert.equal(client.records.length, 0);
	} finally { annotations.dispose(); }
});

test('binding messages from another execution context do not overwrite saved notes', async () => {
	const { annotations, client, tab } = fixture();
	try {
		await annotations.start(tab); client.change([note(1)]); client.change([note(2)], 99);
		assert.equal((await annotations.list(tab, 0, 10)).annotations[0].number, 1);
		client.change([{ ...note(1), text: 'x'.repeat(3000) }]);
		assert.equal((await annotations.list(tab, 0, 10)).annotations[0].text, 'Please change this');
	} finally { annotations.dispose(); }
});

test('reload restores notes and SPA navigation keeps different URLs separate', async () => {
	const { annotations, client, tab } = fixture();
	try {
		await annotations.start(tab); client.change([{ ...note(1), color: '#7c3aed' }]);
		client.emit('Page.frameNavigated', { frame: { id: 'main' } }); client.records = [];
		await annotations.start(tab); assert.equal(client.records[0].number, 1); assert.equal(client.records[0].color, '#7c3aed');
		client.url = 'https://example.test/second';
		client.emit('Runtime.bindingCalled', { name: '__aiBrowserAnnotationChanged', executionContextId: 42, payload: JSON.stringify({ type: 'navigate', url: client.url }) });
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal((await annotations.list(tab, 0, 10)).total, 0); assert.equal(client.nextNumber, 2);
		client.change([note(2)]);
		client.url = tab.url;
		client.emit('Runtime.bindingCalled', { name: '__aiBrowserAnnotationChanged', executionContextId: 42, payload: JSON.stringify({ type: 'navigate', url: client.url }) });
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal((await annotations.list(tab, 0, 10)).annotations[0].number, 1);
	} finally { annotations.dispose(); }
});

test('closing a tab during channel acquisition cancels and closes a channel arriving later', async () => {
	const { annotations, client, tab } = fixture();
	let deliver!: (value: any) => void;
	tab.startCDPSession = () => new Promise(resolve => { deliver = resolve; });
	const starting = annotations.start(tab); annotations.close(tab);
	await assert.rejects(starting, /cancelled|closed/);
	deliver(client); await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(client.isClosed, true); annotations.dispose();
});

test('copy uses the stored note and selector and refuses foreign context clipboard requests', async () => {
	const { annotations, client, tab, clipboard } = fixture();
	try {
		await annotations.start(tab); client.change([note(1)]);
		const request = { name: '__aiBrowserAnnotationChanged', executionContextId: 99,
			payload: JSON.stringify({ type: 'copy', url: client.url, id: note(1).id, records: [{ element: { selector: 'untrusted' } }] }) };
		client.emit('Runtime.bindingCalled', request); assert.equal(clipboard.length, 0);
		client.emit('Runtime.bindingCalled', { ...request, executionContextId: 42 });
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepEqual(clipboard, [`Please change this\n\nAnnotation #1 on ${client.url}\nElement: <button> #save — "Save"`]);
	} finally { annotations.dispose(); }
});

test('the delete icon requires confirmation; cancelling keeps both host data and marker', async () => {
	const { annotations, client, tab, deletion } = fixture();
	try {
		await annotations.start(tab); client.change([note(1)]);
		const request = { name: '__aiBrowserAnnotationChanged', executionContextId: 42,
			payload: JSON.stringify({ type: 'requestDelete', url: client.url, id: note(1).id }) };
		client.emit('Runtime.bindingCalled', request); await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(deletion.asked, 1); assert.equal((await annotations.list(tab, 0, 10)).total, 1); assert.equal(client.records.length, 1);
		deletion.confirm = true; client.emit('Runtime.bindingCalled', request);
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(deletion.asked, 2); assert.equal((await annotations.list(tab, 0, 10)).total, 0); assert.equal(client.records.length, 0);
	} finally { annotations.dispose(); }
});

test('changes report created and removed ids; get finds records on any page of the tab', async () => {
	const { annotations, client, tab } = fixture();
	const changes: any[] = [];
	annotations.onDidChange((change: any) => changes.push(JSON.parse(JSON.stringify({ ...change, tab: undefined }))));
	try {
		await annotations.start(tab); client.change([note(1)]);
		assert.deepEqual(changes.at(-1).created, [note(1).id]); assert.deepEqual(changes.at(-1).removed, []);
		client.change([{ ...note(1), text: 'Edited' }]);
		assert.deepEqual(changes.at(-1).created, []); assert.equal(changes.at(-1).records[0].text, 'Edited');
		client.url = 'https://example.test/second';
		client.emit('Runtime.bindingCalled', { name: '__aiBrowserAnnotationChanged', executionContextId: 42, payload: JSON.stringify({ type: 'navigate', url: client.url }) });
		await new Promise(resolve => setTimeout(resolve, 0));
		client.change([note(2)]);
		const got: any = JSON.parse(JSON.stringify(annotations.get(tab, [note(1).id, note(9).id])));
		assert.equal(got.annotations[0].url, 'https://example.test/first'); assert.equal(got.annotations[0].text, 'Edited');
		assert.deepEqual(got.missing, [note(9).id]);
		await annotations.removeEverywhere(tab, [note(1).id, note(2).id]);
		assert.deepEqual(changes.flatMap(change => change.removed).sort(), [note(1).id, note(2).id].sort());
		assert.equal(client.records.length, 0);
		assert.equal((annotations.get(tab, [note(1).id]) as any).annotations.length, 0);
	} finally { annotations.dispose(); }
});

test('closing the browser tab reports every stored annotation as removed', async () => {
	const { annotations, client, tab } = fixture();
	const removed: string[] = [];
	annotations.onDidChange((change: any) => removed.push(...change.removed));
	await annotations.start(tab); client.change([note(1), note(2)]);
	annotations.close(tab);
	assert.deepEqual([...removed], [note(1).id, note(2).id]);
	annotations.dispose();
});

test('an assistant\'s marker is added by selector and is not reported as the user\'s new note', async () => {
	const { annotations, client, tab } = fixture();
	const changes: any[] = [];
	annotations.onDidChange((change: any) => changes.push(JSON.parse(JSON.stringify({ ...change, tab: undefined }))));
	try {
		await annotations.start(tab);
		const added: any = JSON.parse(JSON.stringify(await annotations.add(tab, '#save', 'Look here', 'green')));
		assert.equal(added.id, '00000000-0000-0000-0000-0000000000aa'); assert.equal(added.color, '#15803d');
		assert.equal(client.records.length, 1); assert.deepEqual(changes.at(-1).created, []);
		await assert.rejects(annotations.add(tab, '#save', 'x', 'magenta'), /color must be one of/);
		await assert.rejects(annotations.add(tab, '#missing', 'x', undefined), /No element/);
	} finally { annotations.dispose(); }
});

test('an empty note (blank after trim) is deleted without asking', async () => {
	const { annotations, client, tab, deletion } = fixture();
	try {
		await annotations.start(tab); client.change([{ ...note(1), text: '  \n ' }]);
		client.emit('Runtime.bindingCalled', { name: '__aiBrowserAnnotationChanged', executionContextId: 42,
			payload: JSON.stringify({ type: 'requestDelete', url: client.url, id: note(1).id }) });
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(deletion.asked, 0); assert.equal((await annotations.list(tab, 0, 10)).total, 0);
	} finally { annotations.dispose(); }
});
