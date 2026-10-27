import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { NativeActions, type ActionScope, type FrameOwner } from './nativeActions.ts';

// Opt-in, dependency-free end-to-end check. Uses a disposable profile and CDP pipes,
// never the user's running Chrome, login profile, or a network debugging port.
test('native actions in Chromium: trusted events, shadow DOM, frames, coverage and editing', {
	skip: !process.env.AI_BROWSER_TEST_CHROME, timeout: 45_000,
}, async t => {
	const profile = await mkdtemp(join(tmpdir(), 'ai-browser-native-actions-'));
	const child = spawn(process.env.AI_BROWSER_TEST_CHROME!, ['--headless=new', '--disable-gpu', '--no-first-run',
		'--no-default-browser-check', '--remote-debugging-pipe', '--site-per-process', `--user-data-dir=${profile}`, 'about:blank'],
	{ stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
	const writer = child.stdio[3] as NodeJS.WritableStream, reader = child.stdio[4] as NodeJS.ReadableStream;
	const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
	const scopes = new Map<string, ActionScope>();
	let nextId = 0, data = '', stderr = '';
	child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
	const fail = (error: Error) => { for (const task of pending.values()) { task.reject(error); } pending.clear(); };
	child.on('error', fail);
	child.on('exit', (code, signal) => fail(new Error(`Chrome exited (${code ?? signal}): ${stderr}`)));
	writer.on('error', fail);
	reader.on('data', chunk => {
		data += chunk.toString();
		for (let end; (end = data.indexOf('\0')) >= 0;) {
			const message = JSON.parse(data.slice(0, end)); data = data.slice(end + 1);
			if (message.id) {
				const task = pending.get(message.id); pending.delete(message.id);
				if (message.error) { task?.reject(new Error(message.error.message)); } else { task?.resolve(message.result); }
			} else if (message.method === 'Runtime.executionContextCreated' && message.params.context.auxData?.isDefault) {
				scopes.set(message.params.context.auxData.frameId, { sessionId: message.sessionId, contextId: message.params.context.id });
			}
		}
	});
	function send(method: string, params: object = {}, sessionId?: string): Promise<any> {
		return new Promise((resolve, reject) => {
			const id = ++nextId; pending.set(id, { resolve, reject });
			writer.write(JSON.stringify({ id, method, params, sessionId }) + '\0');
		});
	}
	t.after(async () => {
		child.kill();
		await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode) { resolve(); } else { child.once('exit', () => resolve()); } });
		await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});
	const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
	const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
	await send('Runtime.enable', {}, sessionId); await send('Page.enable', {}, sessionId);
	async function evaluate(expression: string, scope: ActionScope = { sessionId }): Promise<any> {
		const reply = await send('Runtime.evaluate', { expression, contextId: scope.contextId, returnByValue: true, awaitPromise: true }, scope.sessionId);
		if (reply.exceptionDetails) { throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text); }
		return reply.result?.value;
	}
	await evaluate(`document.body.innerHTML = '<button id="button">Click</button><input id="field"><div id="host"></div>';
		window.events=[];
		for (const name of ['click','dblclick','contextmenu','mouseover','keydown','input']) document.addEventListener(name,e=>events.push({type:e.type,trusted:e.isTrusted,target:e.target.id}));
		document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<button id="shadow">Shadow</button><input id="secret" type="password" value="do-not-report-this">';`);
	const frameParents = new Map<string, string>();
	const { frameTree } = await send('Page.getFrameTree', {}, sessionId), rootId = frameTree.frame.id;
	const actions = new NativeActions({ mainSessionId: sessionId, send,
		scope: async id => { const scope = id ? scopes.get(id) : { sessionId }; assert.ok(scope, `Missing scope ${id}`); return scope; },
		owners: async id => {
			const result: FrameOwner[] = [];
			while (id !== rootId) {
				const parentId = frameParents.get(id); assert.ok(parentId);
				const parent = parentId === rootId ? { sessionId } : scopes.get(parentId); assert.ok(parent);
				result.unshift({ frameId: id, parent }); id = parentId;
			}
			return result;
		},
	});
	await t.test('native click, double click, context menu and hover emit trusted events', async () => {
		await actions.pointerAction('click', '#button', undefined, { clickCount: 2 });
		await actions.pointerAction('click', '#button', undefined, { button: 'right' });
		await actions.pointerAction('hover', '#host', undefined, { smooth: true });
		const events = await evaluate('events');
		assert.ok(events.some((e: any) => e.type === 'dblclick'));
		assert.ok(events.some((e: any) => e.type === 'contextmenu'));
		assert.ok(events.every((e: any) => e.trusted));
	});
	await t.test('shadow elements can be discovered and acted upon without leaking field values', async () => {
		const snapshot = await actions.snapshot();
		assert.ok(!JSON.stringify(snapshot).includes('do-not-report-this'));
		const entry = snapshot.elements.find((e: any) => e.label === 'Shadow'); assert.ok(entry?.selector?.includes('>>>'));
		await actions.pointerAction('click', entry.selector, undefined);
		await actions.keyboardAction('#host >>> #secret', undefined, { key: process.platform === 'darwin' ? 'Meta+a' : 'Control+a' });
		await actions.keyboardAction('#host >>> #secret', undefined, { text: 'replacement' });
		assert.equal(await evaluate(`document.querySelector('#host').shadowRoot.querySelector('#secret').value`), 'replacement');
	});
	await t.test('closed and nested closed shadow roots support discovery, click, hover, typing and fill', async () => {
		await evaluate(`window.closedClicks=0;const host=document.createElement('div');host.id='closed';document.body.append(host);const root=host.attachShadow({mode:'closed'});root.innerHTML='<button id="closed-button">Closed action</button><input id="closed-secret" type="password" value="never-return-this"><div id="nested-host"></div>';root.querySelector('button').onclick=e=>{if(e.isTrusted)closedClicks++};const nested=root.querySelector('#nested-host').attachShadow({mode:'closed'});nested.innerHTML='<input id="nested-edit" placeholder="Nested edit">';window.readClosed=()=>root.querySelector('input').value;window.readNested=()=>nested.querySelector('input').value;`);
		const snapshot = await actions.snapshot();
		assert.ok(!JSON.stringify(snapshot).includes('never-return-this'));
		const button = snapshot.elements.find((entry: any) => entry.label === 'Closed action'); assert.ok(button?.selector?.includes('>>>'));
		await actions.pointerAction('click', button.selector, undefined);
		assert.equal(await evaluate('closedClicks'), 1);
		await actions.pointerAction('hover', button.selector, undefined);
		await actions.keyboardAction('#closed >>> #closed-secret', undefined, { key: process.platform === 'darwin' ? 'Meta+a' : 'Control+a' });
		await actions.keyboardAction('#closed >>> #closed-secret', undefined, { text: 'changed' });
		assert.equal(await evaluate('readClosed()'), 'changed');
		await actions.onElement('#closed >>> #nested-host >>> #nested-edit', undefined, `function(value){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(this,value);return 'filled';}`, ['filled closed']);
		assert.equal(await evaluate('readNested()'), 'filled closed');
	});
	await t.test('covered and disabled targets refuse input, while native editing preserves text outside selection', async () => {
		await actions.keyboardAction('#field', undefined, { text: 'hello' });
		await actions.keyboardAction('#field', undefined, { key: 'End' });
		await actions.keyboardAction('#field', undefined, { text: ' world' });
		assert.equal(await evaluate(`document.querySelector('#field').value`), 'hello world');
		await evaluate(`document.querySelector('#button').disabled=true`);
		await assert.rejects(() => actions.pointerAction('click', '#button', undefined), /disabled/);
		await evaluate(`document.querySelector('#button').disabled=false; const overlay=document.createElement('div');overlay.id='cover';overlay.style='position:fixed;inset:0;background:white;z-index:9999';document.body.append(overlay)`);
		await assert.rejects(() => actions.pointerAction('click', '#button', undefined), /covered/);
		await assert.rejects(() => actions.pointerAction('click', '#closed >>> #closed-button', undefined), /covered/);
		await evaluate(`document.querySelector('#cover').remove()`);
	});
	await t.test('nested frame input uses child contexts and main viewport pointer coordinates', async () => {
		await evaluate(`const frame=document.createElement('iframe');frame.id='frame';frame.style='margin:80px;border:7px solid black;width:400px;height:220px';frame.srcdoc='<button id="inside">Inside</button><input id="edit">';document.body.append(frame);new Promise(resolve=>frame.onload=resolve)`);
		const tree = await send('Page.getFrameTree', {}, sessionId);
		const frameId = tree.frameTree.childFrames[0].frame.id; frameParents.set(frameId, rootId);
		await evaluate(`window.clicks=0;document.querySelector('#inside').onclick=e=>{if(e.isTrusted) clicks++}`, scopes.get(frameId));
		await actions.pointerAction('click', '#inside', frameId);
		assert.equal(await evaluate('clicks', scopes.get(frameId)), 1);
		await actions.keyboardAction('#edit', frameId, { text: 'in frame' });
		assert.equal(await evaluate(`document.querySelector('#edit').value`, scopes.get(frameId)), 'in frame');
		await evaluate(`const nested=document.createElement('iframe');nested.style='width:250px;height:80px;border:4px solid black';nested.srcdoc='<button id="nested">Nested</button>';document.body.append(nested);new Promise(resolve=>nested.onload=resolve)`, scopes.get(frameId));
		const nestedTree = await send('Page.getFrameTree', {}, sessionId);
		const nestedId = nestedTree.frameTree.childFrames[0].childFrames[0].frame.id; frameParents.set(nestedId, frameId);
		await evaluate(`window.clicked=false;document.querySelector('#nested').onclick=e=>clicked=e.isTrusted`, scopes.get(nestedId));
		await actions.pointerAction('click', '#nested', nestedId);
		assert.equal(await evaluate('clicked', scopes.get(nestedId)), true);
		for (const transform of ['scale(0.8)', 'rotate(12deg)', 'skew(8deg, 4deg)', 'perspective(700px) rotateY(18deg)']) {
			await evaluate(`document.querySelector('#frame').style.transform=${JSON.stringify(transform)}`);
			const before = await evaluate('clicks', scopes.get(frameId));
			await actions.pointerAction('click', '#inside', frameId);
			assert.equal(await evaluate('clicks', scopes.get(frameId)), before + 1, transform);
			await actions.pointerAction('click', '#nested', nestedId);
		}
		await evaluate(`document.querySelector('#frame').style.zoom='1.2'`);
		await actions.pointerAction('click', '#inside', frameId);
	});
	await t.test('pointer-based dragging sends a trusted release at the destination', async () => {
		await evaluate(`document.querySelector('#frame').remove();const source=document.createElement('div');source.id='drag';source.textContent='Drag';source.style='width:80px;height:40px;background:red;touch-action:none';const target=document.createElement('div');target.id='drop';target.style='margin-left:240px;width:80px;height:40px;background:blue';document.body.append(source,target);window.dragged=false;source.onpointerdown=e=>source.setPointerCapture(e.pointerId);source.onpointerup=e=>{const r=target.getBoundingClientRect();dragged=e.isTrusted && e.clientX>=r.left && e.clientX<=r.right}`);
		await actions.drag('#drag', '#drop', undefined);
		assert.equal(await evaluate('dragged'), true);
	});
	await t.test('humanized input preserves Unicode and emits per-character native events', async () => {
		await evaluate(`document.querySelector('#field').value='';window.typed=[];document.querySelector('#field').addEventListener('keydown',e=>typed.push({key:e.key,trusted:e.isTrusted}));`);
		await actions.keyboardAction('#field', undefined, { text: 'Привет 👩‍💻!' }, undefined, true);
		assert.equal(await evaluate(`document.querySelector('#field').value`), 'Привет 👩‍💻!');
		const typed = await evaluate('typed'); assert.equal(typed.length, 9); assert.ok(typed.every((entry: any) => entry.trusted));
		await actions.pointerAction('click', '#button', undefined, { humanize: true, clickCount: 2 });
		await evaluate(`const area=document.createElement('textarea');area.id='multiline';document.body.append(area)`);
		await actions.keyboardAction('#multiline', undefined, {text:'A\n你'}, undefined, true);
		assert.equal(await evaluate(`document.querySelector('#multiline').value`), 'A\n你');
	});
	await t.test('cross-origin frames in a separate renderer receive pointer and keyboard input', async () => {
		const server = createServer((_request, response) => {
			response.setHeader('Content-Type', 'text/html');
			response.end('<button id="remote" onclick="window.clicked=event.isTrusted">Remote</button><input id="remote-edit"><a id="native-link" href="#done">Native link</a>');
		});
		await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
		try {
			const address = server.address(); assert.ok(address && typeof address !== 'string');
			const url = `http://127.0.0.1:${address.port}/frame`;
			await evaluate(`const remote=document.createElement('iframe');remote.id='remote-frame';remote.style='margin:30px;border:6px solid black;width:350px;height:140px';remote.src=${JSON.stringify(url)};document.body.append(remote);new Promise(resolve=>remote.onload=resolve)`);
			const { targetInfos } = await send('Target.getTargets');
			const target = targetInfos.find((target: any) => target.type === 'iframe' && target.url === url);
			assert.ok(target, 'Expected a site-isolated frame target');
			const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
			await send('Runtime.enable', {}, attached.sessionId);
			frameParents.set(target.targetId, rootId);
			const clicked = await actions.pointerAction('click', '#remote', target.targetId);
			assert.equal(await evaluate('window.clicked', scopes.get(target.targetId)), true, JSON.stringify({clicked,
				root:await evaluate(`({rect:document.querySelector('#remote-frame').getBoundingClientRect().toJSON(),scrollY,innerHeight})`),
				child:await evaluate(`({rect:document.querySelector('#remote').getBoundingClientRect().toJSON(),innerWidth,innerHeight})`,scopes.get(target.targetId))}));
			await actions.keyboardAction('#remote-edit', target.targetId, { text: 'cross origin' });
			assert.equal(await evaluate(`document.querySelector('#remote-edit').value`, scopes.get(target.targetId)), 'cross origin');
			await evaluate(`document.querySelector('#remote-frame').style.transform='perspective(600px) rotateY(12deg) rotate(10deg) scale(.85)'`);
			await evaluate('window.clicked=false', scopes.get(target.targetId));
			const transformedClick = await actions.pointerAction('click', '#remote', target.targetId);
			assert.equal(await evaluate('clicked', scopes.get(target.targetId)), true, JSON.stringify(transformedClick));
			await evaluate(`const inner=document.createElement('iframe');inner.style='width:250px;height:65px;border:4px solid black;transform:rotate(-6deg) scale(.9)';inner.srcdoc='<button id="mixed" onclick="window.clicked=event.isTrusted">Mixed nesting</button>';document.body.append(inner);new Promise(resolve=>inner.onload=resolve)`,scopes.get(target.targetId));
			const childTree = await send('Page.getFrameTree',{},attached.sessionId);
			const mixedId = childTree.frameTree.childFrames[0].frame.id; frameParents.set(mixedId,target.targetId);
			await actions.pointerAction('click','#mixed',mixedId);
			assert.equal(await evaluate('window.clicked',scopes.get(mixedId)),true);
			await evaluate(`const host=document.createElement('div');host.id='remote-closed';document.body.append(host);const root=host.attachShadow({mode:'closed'});root.innerHTML='<button id="remote-closed-button" onclick="window.closedClicked=event.isTrusted">Remote closed</button>'`,scopes.get(target.targetId));
			const remoteSnapshot = await actions.snapshot(target.targetId);
			assert.ok(remoteSnapshot.elements.some((entry:any)=>entry.selector?.includes('>>>') && entry.label==='Remote closed'));
			await actions.pointerAction('click','#remote-closed >>> #remote-closed-button',target.targetId);
			assert.equal(await evaluate('window.closedClicked',scopes.get(target.targetId)),true);
			await evaluate(`document.querySelector('#remote-frame').remove()`);
			const sandboxUrl = `${url}/sandbox`;
			await evaluate(`const sandboxed=document.createElement('iframe');sandboxed.id='sandboxed';sandboxed.setAttribute('sandbox','');sandboxed.style='border:5px solid black;transform:rotate(8deg) scale(.9)';sandboxed.src=${JSON.stringify(sandboxUrl)};document.body.append(sandboxed);new Promise(resolve=>sandboxed.onload=resolve)`);
			const sandboxTargets = await send('Target.getTargets');
			const sandboxTarget = sandboxTargets.targetInfos.find((target:any)=>target.type==='iframe' && target.url===sandboxUrl); assert.ok(sandboxTarget);
			const sandboxSession = await send('Target.attachToTarget',{targetId:sandboxTarget.targetId,flatten:true});
			await send('Runtime.enable',{},sandboxSession.sessionId); frameParents.set(sandboxTarget.targetId,rootId);
			await actions.pointerAction('click','#native-link',sandboxTarget.targetId);
			assert.equal(await evaluate('location.hash',scopes.get(sandboxTarget.targetId)),'#done');
			await evaluate(`document.querySelector('#sandboxed').remove()`);
		} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
	});
});
