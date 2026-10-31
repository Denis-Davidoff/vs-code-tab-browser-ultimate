import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';

import { windowEntries } from '../src/chat/core/entryWindow.ts';
import type { ChatEntry } from '../src/chat/chatProtocol.ts';

function setup() {
	const source = readFileSync('preview-src/chat.ts', 'utf8');
	const start = source.indexOf("const newMessagesBadge = el('button', { class: 'new-messages' });");
	const end = source.indexOf("const footer = el('div'", start);
	assert.ok(start >= 0 && end > start);
	const frames: (() => void)[] = [];
	const handlers = new Map<string, () => void>();
	const observed: unknown[] = [];
	let resize!: () => void;
	let below = 0;
	const classes = new Set<string>();
	const badge = {
		hidden: true, textContent: '', type: '', title: '',
		classList: { toggle(name: string, on: boolean) { if (on) { classes.add(name); } else { classes.delete(name); } } },
		addEventListener() {},
		replaceChildren(...children: { textContent: string }[]) { this.textContent = children.map(c => c.textContent).join(''); },
	};
	const thread = {
		scrollHeight: 3000, scrollTop: 2500, clientHeight: 500,
		getBoundingClientRect: () => ({ bottom: 500 }),
		querySelectorAll: () => Array.from({ length: below }, () => ({ getBoundingClientRect: () => ({ top: 600 }) })),
		addEventListener(name: string, fn: () => void) { handlers.set(name, fn); },
	};
	const context = {
		state: { chatId: 'chat', messageCount: 100 }, thread, threadInner: {},
		el: (_tag: string, props: { text?: string } = {}) => props.text ? { textContent: props.text } : badge,
		icon: () => ({ textContent: '' }),
		requestAnimationFrame(fn: () => void) { frames.push(fn); return frames.length; },
		ResizeObserver: class {
			constructor(fn: () => void) { resize = fn; }
			observe(node: unknown) { observed.push(node); }
		},
	};
	runInNewContext(transpileModule(source.slice(start, end), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context);
	const flush = () => { for (const fn of frames.splice(0)) { fn(); } };
	const scroll = () => { handlers.get('scroll')!(); flush(); };
	scroll(); // Establish the read watermark at the end.
	return { context, badge, thread, classes, frames, handlers, observed, resize, flush, scroll,
		setBelow(value: number) { below = value; } };
}

test('navigation past new messages reduces the count and reaching the end hides the badge', () => {
	const view = setup();
	view.thread.scrollTop = 500;
	view.context.state.messageCount = 103;
	view.setBelow(3);
	view.scroll();
	assert.equal(view.badge.textContent, '3 new messages');
	view.thread.scrollTop = 1500;
	view.setBelow(1);
	view.scroll();
	assert.equal(view.badge.textContent, '1 new message');
	view.thread.scrollTop = 2500;
	view.setBelow(0);
	view.handlers.get('scrollend')!();
	view.flush();
	assert.equal(view.badge.hidden, true);
	// Going back up does not make messages already reached new again.
	view.thread.scrollTop = 500;
	view.setBelow(3);
	view.scroll();
	assert.equal(view.badge.textContent, '3 messages below');
	assert.equal(view.classes.has('fresh'), false);
});

test('link scrolling measures the final layout after sticky prompt handlers', () => {
	const view = setup();
	view.thread.scrollTop = 500;
	view.setBelow(5);
	view.scroll();
	assert.equal(view.badge.hidden, false);
	view.handlers.get('scroll')!();
	view.handlers.get('scrollend')!();
	assert.equal(view.frames.length, 1);
	// Another handler changes the layout after this scroll listener ran.
	view.thread.scrollTop = 2500;
	view.setBelow(0);
	view.flush();
	assert.equal(view.badge.hidden, true);
});

test('content and viewport resizing refresh the badge without a scroll event', () => {
	const view = setup();
	assert.deepEqual(view.observed, [view.thread, view.context.threadInner]);
	view.thread.scrollTop = 500;
	view.setBelow(4);
	view.scroll();
	assert.equal(view.badge.textContent, '4 messages below');
	view.setBelow(2);
	view.resize(); view.flush();
	assert.equal(view.badge.textContent, '2 messages below');
	view.thread.clientHeight = 2500;
	view.resize(); view.flush();
	assert.equal(view.badge.hidden, true);
});

test('switching chats resets the read watermark', () => {
	const view = setup();
	view.thread.scrollTop = 500;
	view.context.state = { chatId: 'other', messageCount: 120 };
	view.setBelow(6);
	view.scroll();
	assert.equal(view.badge.textContent, '6 messages below');
	assert.equal(view.classes.has('fresh'), false);
});

const source = readFileSync('preview-src/chat.ts', 'utf8');
const code = source.match(/function messageCount\([\s\S]*?\n\}/)![0];
const count = runInNewContext(transpileModule(`${code}\nmessageCount;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText);

test('new message counts survive sliding history windows and loading earlier tool entries', () => {
	const entries = Array.from({ length: 20 }, () => [
		{ kind: 'user' }, { kind: 'tool' }, { kind: 'notice' }, { kind: 'assistant' },
	]).flat() as ChatEntry[];
	const state = (prompts: number) => {
		const w = windowEntries(entries, prompts);
		return { entries: w.entries, entriesOffset: w.offset, messageCount: entries.filter(e => e.kind === 'user' || e.kind === 'assistant').length };
	};
	const seen = count(state(20));
	entries.push({ kind: 'user' } as ChatEntry);
	assert.equal(count(state(20)) - seen, 1);
	assert.equal(count(state(40)), count(state(20)), 'loading earlier entries does not change the total');
	entries.push({ kind: 'tool' } as ChatEntry);
	assert.equal(count(state(20)) - seen, 1, 'tool activity is not a new message');
	assert.equal(count({ entries: [{ kind: 'user' }, { kind: 'tool' }], entriesOffset: 10 }), 1, 'older hosts never add an offset measured in tools');
});
