/** Browser probe against the real chat renderer, including user actions and media CSP. */
import type { ChatViewState, ViewToHost } from '../src/chat/chatProtocol';
import type { ArtifactSnapshot, ArtifactKind, VisualizationSnapshot } from '../src/chat/visualizationProtocol';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition: unknown, message: string) => { if (!condition) { throw new Error(message); } };
const base64 = (bytes: Uint8Array) => btoa(Array.from(bytes, value => String.fromCharCode(value)).join(''));
function wav(): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(1644), view = new DataView(bytes.buffer);
	for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']] as const) { bytes.set(new TextEncoder().encode(text), offset); }
	view.setUint32(4, bytes.length - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
	view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, 1600, true);
	return bytes;
}
async function webm(): Promise<Uint8Array<ArrayBuffer>> {
	const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
	canvas.getContext('2d')!.fillRect(0, 0, 16, 16);
	const stream = canvas.captureStream(10), chunks: Blob[] = [];
	const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
	recorder.ondataavailable = event => { if (event.data.size) { chunks.push(event.data); } };
	const stopped = new Promise<void>((resolve, reject) => { recorder.onstop = () => resolve(); recorder.onerror = () => reject(new Error('Test video recording failed.')); });
	try { recorder.start(); await sleep(150); recorder.stop(); await stopped; return new Uint8Array(await new Blob(chunks).arrayBuffer()); }
	finally { stream.getTracks().forEach(track => track.stop()); }
}

export async function checkArtifactCards(frame: HTMLIFrameElement, state: ChatViewState, received: ViewToHost[]): Promise<void> {
	const table = { columns: ['Name', 'Value'], rows: Array.from({ length: 201 }, (_, index) => [`Row ${index}`, 201 - index]) };
	const sources = [{ title: '<img src=x onerror=alert(1)>', url: 'https://example.com/reference', description: 'Source supplied by the assistant' }];
	const audio = wav(), video = await webm();
	const items: { kind: ArtifactKind; data: Uint8Array; mimeType: string; name: string; extra?: Partial<ArtifactSnapshot> }[] = [
		{ kind: 'file', data: new TextEncoder().encode('<script>throw new Error("executed downloadable file")</script>'), mimeType: 'application/octet-stream', name: 'report.html' },
		{ kind: 'table', data: new TextEncoder().encode(JSON.stringify(table)), mimeType: 'application/json', name: 'table.json', extra: { table } },
		{ kind: 'sources', data: new TextEncoder().encode(JSON.stringify(sources)), mimeType: 'application/json', name: 'sources.json', extra: { sources } },
		{ kind: 'audio', data: audio, mimeType: 'audio/wav', name: 'sound.wav' },
		{ kind: 'video', data: video, mimeType: 'video/webm', name: 'clip.webm' },
	];
	const snapshots: Record<string, VisualizationSnapshot> = { ...state.visualizations };
	const entries = [...state.entries];
	items.forEach((item, index) => {
		const revision = String(index + 1).repeat(64);
		snapshots[revision] = { artifact: { kind: item.kind, name: item.name, mimeType: item.mimeType, base64: base64(item.data), bytes: item.data.length, ...item.extra } };
		entries.push({ kind: 'assistant', text: `${item.kind}${JSON.stringify({ path: `/tmp/${item.name}` })}`, visualizations: [{ at: 0, id: item.kind, revision, title: `Test ${item.kind}`, kind: item.kind }] });
	});
	const updated: ChatViewState = { ...state, entries, visualizations: snapshots };
	frame.contentWindow!.postMessage({ type: 'state', state: updated }, location.origin);
	await sleep(180);
	const doc = frame.contentDocument!;
	assert(doc.querySelectorAll('.artifact-card').length === 5, 'Missing artifact cards.');
	assert(doc.querySelectorAll('.artifact-card iframe').length === 0, 'Artifact created an executing iframe.');
	const tableRoot = doc.querySelector<HTMLElement>('.artifact-table')!;
	assert(tableRoot.querySelectorAll('tbody tr').length === 100, 'Table is not paginated.');
	const headers = tableRoot.querySelectorAll<HTMLButtonElement>('th button'); headers[1].click();
	assert(tableRoot.querySelector('tbody tr td:nth-child(2)')?.textContent === '1', 'Numeric ascending sort failed.');
	headers[1].click();
	assert(tableRoot.querySelector('tbody tr td:nth-child(2)')?.textContent === '201', 'Numeric descending sort failed.');
	const next = tableRoot.querySelectorAll<HTMLButtonElement>('.artifact-table-footer button')[1]; next.click();
	assert(tableRoot.querySelector('.artifact-table-footer span')?.textContent === '101–200 of 201 rows', 'Table page navigation failed.');
	const search = tableRoot.querySelector<HTMLInputElement>('input')!;
	search.value = 'Row 200'; search.dispatchEvent(new Event('input'));
	assert(tableRoot.querySelectorAll('tbody tr').length === 1, 'Table filtering failed.');
	const sourceLink = doc.querySelector<HTMLElement>('.artifact-sources [role="link"]')!;
	assert(sourceLink.textContent === sources[0].title && !sourceLink.querySelector('img'), 'Source title was interpreted as HTML.');
	sourceLink.click();
	await sleep(50);
	assert(received.some(message => message.type === 'openLink' && message.url === sources[0].url && message.external === false), 'Source title did not open in AI Browser by default.');
	const sourceActions = doc.querySelectorAll<HTMLButtonElement>('.artifact-source-actions button');
	assert(sourceActions[0]?.textContent === 'Open in AI Browser' && sourceActions[1]?.textContent === 'Open in System Browser ↗', 'Source browser destinations are not explicit.');
	sourceActions[0].click();
	sourceActions[1].click();
	sourceLink.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
	assert(doc.body.textContent?.includes('Copy Link'), 'Source link has no standard link context menu.');
	doc.querySelector<HTMLButtonElement>('.artifact-card .visualization-header button')!.click();
	await sleep(100);
	assert(received.some(message => message.type === 'openLink' && message.url === sources[0].url && message.external), 'Source link did not use host routing.');
	assert(received.some(message => message.type === 'saveArtifact' && message.chatId === state.chatId && message.revision === '1'.repeat(64)), 'File download did not identify its conversation and revision.');
	const audioNode = doc.querySelector<HTMLAudioElement>('.artifact-card audio')!;
	const videoNode = doc.querySelector<HTMLVideoElement>('.artifact-card video')!;
	for (let attempt = 0; attempt < 20 && (!audioNode.readyState || !videoNode.readyState); attempt++) { await sleep(50); }
	assert(audioNode.controls && audioNode.readyState >= 1 && !audioNode.autoplay, 'Audio metadata failed to load under the chat CSP.');
	assert(videoNode.controls && videoNode.readyState >= 1 && !videoNode.autoplay, 'Video metadata failed to load under the chat CSP.');
	const audioUrl = audioNode.src, videoUrl = videoNode.src;
	const urls = (frame.contentWindow as Window & typeof globalThis).URL;
	const revoke = urls.revokeObjectURL.bind(urls), revoked = new Set<string>();
	urls.revokeObjectURL = url => { revoked.add(url); revoke(url); };
	frame.contentWindow!.postMessage({ type: 'state', state: { ...updated, entries: [...entries, { kind: 'assistant', text: 'Artifacts remain stable' }] } }, location.origin);
	await sleep(100);
	assert(tableRoot === doc.querySelector('.artifact-table') && search.value === 'Row 200', 'Streaming replaced interactive table state.');
	assert(audioNode === doc.querySelector('.artifact-card audio') && videoNode === doc.querySelector('.artifact-card video'), 'Streaming replaced a media element.');
	frame.contentWindow!.postMessage({ type: 'state', state: { ...state, chatId: 'another-chat', entries: [], visualizations: {} } }, location.origin);
	await sleep(100);
	assert(!doc.querySelector('.artifact-card'), 'Switching conversations retained old cards.');
	assert(!audioNode.hasAttribute('src') && !videoNode.hasAttribute('src'), 'Removed media retained its source.');
	urls.revokeObjectURL = revoke;
	assert(revoked.has(audioUrl) && revoked.has(videoUrl), 'Removed media retained its Blob URL.');
}
