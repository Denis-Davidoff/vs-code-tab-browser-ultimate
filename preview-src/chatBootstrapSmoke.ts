/** Full chat startup under the parent-hiding preload used by VS Code/VSCodium. */
import type { ChatViewState } from '../src/chat/chatProtocol';

const output = document.getElementById('result')!;
const frame = document.createElement('iframe');
frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
frame.src = '/fake.html';
document.body.append(frame);
let written = false;
let finished = false;
const fail = (reason: string) => { if (!finished) { finished = true; output.textContent = `FAIL: ${reason}`; } };
const state: ChatViewState = {
	chatId: 'bootstrap-test', activeTab: 'tab-one', entries: [{ kind: 'user', text: 'Startup question', attachments: [] }, { kind: 'assistant', text: 'Host delivery works' }],
	voice: { available: false, maxSeconds: 60 }, detecting: false, agents: [], selection: {}, running: false,
	attachments: [], suggestions: [], hasBrowserTab: false, browserApi: false, newsHidden: true,
	tabs: [{ id: 'tab-one', chatId: 'bootstrap-test', title: 'Bootstrap test', running: false, busy: false, agents: 0, skillRuns: 0, queued: 0 }], tabLimit: 10,
	pendingSends: [], approvals: { policy: {}, servers: [] }, commands: {}, toolbar: [], toolbarRuns: {}, skillAgents: [], viewMode: 'compact', collapseTools: true,
	workdir: { picked: false, workspace: [], recent: [], locked: false, empty: true, references: [], recentRepos: [] },
};
frame.addEventListener('load', () => {
	if (written) { return; }
	written = true;
	const document = frame.contentDocument!;
	document.open();
	document.write(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-bootstrap-smoke'; style-src 'self' 'nonce-bootstrap-smoke'; frame-src 'self'; img-src data:;"><link rel="stylesheet" href="/chat.css"></head><body><div id="app"></div><script nonce="bootstrap-smoke">
const realParent = window.parent;
globalThis.acquireVsCodeApi = () => ({postMessage: message => realParent.postMessage({type:'bootstrap-api',message}, location.origin),getState:()=>undefined,setState:()=>{}});
window.parent = window; window.top = window; window.frameElement = null;
window.addEventListener('error', event => realParent.postMessage({type:'bootstrap-error',message:event.message}, location.origin));
<\/script><script nonce="bootstrap-smoke" src="/chat.js"><\/script></body></html>`);
	document.close();
});
window.addEventListener('message', event => {
	if (event.source !== frame.contentWindow || event.origin !== location.origin) { return; }
	if (event.data?.type === 'bootstrap-error') { fail(event.data.message); return; }
	if (event.data?.type !== 'bootstrap-api' || event.data.message?.type !== 'ready') { return; }
	frame.contentWindow!.postMessage({ type: 'state', state }, location.origin);
	setTimeout(() => {
		if (finished) { return; }
		const document = frame.contentDocument!;
		if (!document.body.textContent?.includes('Host delivery works') || !document.body.textContent.includes('Startup question')) { fail('Chat stayed empty after the host snapshot.'); return; }
		if (frame.contentWindow!.parent !== frame.contentWindow) { fail('Fixture did not reproduce the VS Code preload.'); return; }
		const child = document.createElement('iframe');
		const forged = JSON.stringify({ type: 'state', state: { ...state, entries: [{ kind: 'assistant', text: 'FORGED CHILD SNAPSHOT' }] } });
		child.srcdoc = `<script nonce="bootstrap-smoke">parent.postMessage(${forged},'*')<\/script>`;
		document.body.append(child);
		setTimeout(() => {
			if (document.body.textContent?.includes('FORGED CHILD SNAPSHOT')) { fail('Child frame replaced trusted chat state.'); return; }
			child.remove();
			frame.contentWindow!.postMessage({ type: 'state', state: { ...state, entries: [...state.entries, { kind: 'assistant', text: 'Second host snapshot works' }] } }, location.origin);
			setTimeout(() => {
				if (!document.body.textContent?.includes('Second host snapshot works')) { fail('Subsequent host snapshot was lost.'); return; }
				if (!finished) { finished = true; output.textContent = 'PASS: full chat bootstrap, hidden parent, host snapshots, child rejection'; }
			}, 100);
		}, 150);
	}, 200);
});
setTimeout(() => fail('Full chat bootstrap timed out.'), 5000);
