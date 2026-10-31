/** Checks actual renderer behavior, rather than a DOM mock of the implementation. */
import type { ChatViewState, ViewToHost, ToolEntry, ChatEntry } from '../src/chat/chatProtocol';
import type { Citation } from '../src/chat/richProtocol';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition: unknown, text: string) => { if (!condition) { throw new Error(text); } };

export async function checkRichCards(frame: HTMLIFrameElement, state: ChatViewState, received: ViewToHost[]): Promise<void> {
	const doc = frame.contentDocument!;
	const value = { count: 42, enabled: false, empty: null, nested: { match: 'needle', unsafe: '<img src=x onerror=alert(1)>' } };
	const tool: ToolEntry = { kind: 'tool', id: 'mixed-tool', tool: 'mcp', name: 'Mixed output', startedAt: Date.now() - 2000, status: 'done', blocks: [
		{ type: 'text', text: 'Plain <strong>text</strong>' }, { type: 'json', value }, { type: 'link', title: 'Result link', url: 'https://example.com/result' },
		{ type: 'image', ref: { at: 3, id: 'native-image', revision: 'c'.repeat(64), kind: 'image', title: 'Native result image' } },
		{ type: 'file', name: 'result.txt', ref: { at: 4, id: 'native-file', revision: 'd'.repeat(64), kind: 'file', title: 'Result file' } },
	] };
	const answer = 'A **typed result** has 42 items.';
	const citations: Citation[] = [
		{ id: 'web', label: '1', start: answer.indexOf('**'), end: answer.lastIndexOf('**') + 2, target: { type: 'url', url: 'https://example.com/reference' } },
		{ id: 'file', label: '2', start: answer.indexOf('42'), end: answer.indexOf('42') + 2, target: { type: 'file', path: '/tmp/result.ts', line: 12 } },
		{ id: 'tool', label: '3', start: answer.indexOf('items'), end: answer.indexOf('items') + 5, target: { type: 'message', toolId: tool.id } },
	];
	let entries: ChatEntry[] = [
		...state.entries, tool,
		{ kind: 'notice', id: 'info', level: 'info', text: 'Information', at: 1_700_000_000_000 },
		{ kind: 'notice', id: 'warning', level: 'warning', text: 'Attention', reason: 'A concrete cause', at: 1_700_000_000_001, related: { toolId: tool.id }, actions: [{ kind: 'copy', label: 'Copy diagnostic', text: 'diagnostic' }, { kind: 'link', label: 'Help', url: 'https://example.com/help' }] },
		{ kind: 'notice', id: 'error', level: 'error', text: 'Failure', reason: 'A concrete error', at: 1_700_000_000_002 },
		{ kind: 'progress', id: 'job', title: 'Build', stage: 'Preparing', percent: null, status: 'running', cancel: {}, startedAt: Date.now() - 5000, updatedAt: Date.now() },
		{ kind: 'plan', id: 'plan', title: 'Implementation', updatedAt: Date.now(), steps: [{ id: 'read', text: 'Read', status: 'done' }, { id: 'build', text: 'Build', status: 'inProgress' }, { id: 'test', text: 'Test', status: 'pending' }, { id: 'skip', text: 'Skip', status: 'cancelled' }] },
		{ kind: 'assistant', id: 'cited-answer', text: answer, citations },
	];
	let snapshot: ChatViewState = { ...state, entries, visualizations: { ...state.visualizations, ['d'.repeat(64)]: { artifact: { kind: 'file', name: 'result.txt', mimeType: 'application/octet-stream', base64: 'aGk=', bytes: 2 } } } };
	const send = async () => { frame.contentWindow!.postMessage({ type: 'state', state: { ...snapshot, entries } }, location.origin); await sleep(120); };
	await send();
	assert(doc.querySelectorAll('.rich-notice').length === 3 && doc.querySelector('.notice-error[role="alert"]'), 'Notification levels or alert semantics are missing.');
	assert(doc.querySelector('.notice-warning time')?.getAttribute('datetime') === new Date(1_700_000_000_001).toISOString(), 'Notification timestamp was not preserved.');
	assert(doc.querySelector('.notice-warning .rich-reason')?.textContent === 'A concrete cause', 'Notification lost its reason.');
	const notificationButtons = doc.querySelectorAll<HTMLButtonElement>('.notice-warning button');
	notificationButtons[1].click(); notificationButtons[2].click();
	await sleep(50);
	assert(received.some(message => message.type === 'copy' && message.text === 'diagnostic'), 'Notification copy action failed.');
	assert(received.some(message => message.type === 'openLink' && message.url === 'https://example.com/help'), 'Notification link action failed.');
	const progress = doc.querySelector<HTMLElement>('.rich-progress')!;
	assert(!progress.querySelector('progress')!.hasAttribute('value'), 'Indeterminate progress is displayed as a fake percentage.');
	assert(parseInt(progress.querySelector('.rich-duration')?.textContent || '0', 10) >= 5, 'Progress elapsed time is missing.');
	const plan = doc.querySelector<HTMLElement>('.rich-plan')!;
	assert(plan.querySelector('[aria-current="step"]')?.textContent?.includes('Build'), 'Current plan step is missing.');
	assert(plan.querySelector('.plan-cancelled')?.textContent?.includes('Skip'), 'Cancelled plan step is missing.');
	const head = doc.querySelector<HTMLButtonElement>('[data-tool-id="mixed-tool"] .activity-head')!; head.click();
	await sleep(50);
	const result = doc.querySelector<HTMLElement>('[data-tool-id="mixed-tool"] .rich-results')!;
	assert(result.querySelectorAll(':scope > .rich-block').length === 5, 'Mixed tool blocks were flattened or dropped.');
	assert(result.querySelector('.rich-block-text pre')?.textContent === 'Plain <strong>text</strong>' && !result.querySelector('.rich-block-text strong'), 'Tool text executed HTML.');
	assert(result.querySelector('.image-card img')?.getAttribute('src')?.startsWith('data:image/gif;base64,'), 'Native tool image did not load from its archived reference.');
	const json = result.querySelector<HTMLElement>('.json-view')!;
	const details = json.querySelector<HTMLDetailsElement>('details')!; details.open = true; await sleep(30);
	assert(details.textContent?.includes('false') && details.textContent.includes('null'), 'JSON tree lost primitive types.');
	json.querySelector<HTMLButtonElement>('.rich-header button')!.click();
	const search = json.querySelector<HTMLInputElement>('input')!; search.value = 'needle'; search.dispatchEvent(new Event('input'));
	json.querySelector<HTMLButtonElement>('.json-search-match button')!.click();
	await sleep(50);
	assert(received.some(message => message.type === 'copy' && message.text === '"needle"'), 'Copying a JSON value did not preserve its type.');
	assert(received.some(message => message.type === 'copy' && message.text.includes('"enabled": false') && JSON.parse(message.text).count === 42), 'Copy whole JSON failed.');
	const cited = doc.querySelector<HTMLElement>('[data-entry-id="cited-answer"]')!;
	assert(cited.querySelectorAll('.assistant-text .citation-button').length === 3, 'Citations did not attach to answer fragments.');
	assert(!cited.textContent?.includes('\uE200citation:'), 'Internal citation marker leaked into the answer.');
	assert(cited.querySelector('strong')?.textContent?.includes('typed result'), 'Citations broke Markdown rendering.');
	const citeButtons = cited.querySelectorAll<HTMLButtonElement>('.assistant-text .citation-button');
	citeButtons[0].click(); citeButtons[1].click(); citeButtons[2].click();
	await sleep(50);
	assert(received.some(message => message.type === 'openLink' && message.url === 'https://example.com/reference'), 'Web citation did not open its source.');
	assert(received.some(message => message.type === 'openLink' && message.url === '/tmp/result.ts:12' && !message.external), 'File citation lost its source line.');
	assert(doc.querySelector('[data-tool-id="mixed-tool"].rich-highlight'), 'Tool citation did not reveal the related call.');
	entries = entries.map(entry => entry.kind === 'progress' ? { ...entry, stage: 'Compiling', percent: 65 } : entry.kind === 'tool' && entry.id === tool.id ? { ...entry, status: 'running', output: 'streamed status', blocks: entry.blocks?.map(block => block.type === 'text' ? { ...block, text: `${block.text} continued` } : block) } : entry);
	await send();
	assert(progress === doc.querySelector('.rich-progress') && progress.querySelector('progress')!.value === 65, 'Progress update replaced the card or lost its value.');
	assert(json === doc.querySelector('[data-tool-id="mixed-tool"] .json-view') && search.value === 'needle' && details.open, 'Tool update discarded JSON search or expansion state.');
	progress.querySelector<HTMLButtonElement>('button')!.click(); await sleep(50);
	assert(received.some(message => message.type === 'cancelProgress' && message.chatId === state.chatId && message.id === 'job'), 'Progress cancellation lost its conversation scope.');
	entries = entries.map(entry => entry.kind === 'progress' ? { ...entry, status: 'cancelled', endedAt: entry.startedAt + 6000 } : entry.kind === 'plan' ? { ...entry, steps: entry.steps.map(step => step.status === 'inProgress' ? { ...step, status: 'done' } : step) } : entry);
	await send();
	assert(progress === doc.querySelector('.rich-progress') && !progress.querySelector('button') && progress.querySelector('.rich-duration')?.textContent === '6s', 'Cancellation did not finalize the original card and duration.');
	assert(plan === doc.querySelector('.rich-plan') && !plan.querySelector('[aria-current="step"]'), 'Plan update duplicated the card or left a stale current step.');
	frame.contentWindow!.postMessage({ type: 'state', state: { ...snapshot, chatId: 'empty-chat', entries: [], visualizations: {} } }, location.origin);
	await sleep(100);
}
