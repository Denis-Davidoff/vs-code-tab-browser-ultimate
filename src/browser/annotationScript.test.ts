import { strict as assert } from 'node:assert';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { annotationSource } from './annotationScript.ts';

/** Small DOM fixture exercises the shipped source, including its trusted-event boundary. */
function page() {
	let document: any;
	class Element {
		children: Element[] = []; parentElement?: Element; shadow?: Element; id = ''; value = ''; hidden = false;
		style: any = { setProperty(name: string, value: string) { this[name] = value; } }; className = ''; data = ''; isContentEditable = false; attributes = new Map<string, string>();
		listeners = new Map<string, ((event: any) => void)[]>();
		classList = { toggle: (name: string, on: boolean) => { const set = new Set(this.className.split(' ')); if (on) { set.add(name); } else { set.delete(name); } this.className = [...set].join(' '); } };
		localName: string;
		constructor(localName: string) { this.localName = localName; }
		get tagName() { return this.localName.toUpperCase(); }
		get nodeType() { return 1; }
		get isConnected(): boolean { return this === document.documentElement || !!this.parentElement?.isConnected; }
		get textContent(): string { return this.data + this.children.map(child => child.textContent).join(''); }
		set textContent(value: string) { this.data = value; this.children = []; }
		get previousElementSibling() { const index = this.parentElement?.children.indexOf(this) ?? -1; return this.parentElement?.children[index - 1]; }
		get offsetHeight() { return 200; }
		append(...nodes: Element[]) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
		remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = undefined; } }
		attachShadow() { this.shadow = new Element('shadow-root'); return this.shadow; }
		setAttribute(name: string, value: string) { this.attributes.set(name, value); }
		getAttribute(name: string) { return this.attributes.get(name) ?? null; }
		getRootNode() { return document; }
		closest(_selector: string): Element | undefined { return ['script', 'style', 'noscript', 'input', 'textarea', 'select'].includes(this.localName) || this.isContentEditable ? this : this.parentElement?.closest(_selector); }
		getBoundingClientRect() { return { left: 100, right: 280, top: 100, bottom: 140, width: 180, height: 40 }; }
		captured?: number;
		setPointerCapture(id: number) { this.captured = id; }
		hasPointerCapture(id: number) { return this.captured === id; }
		releasePointerCapture(_id: number) { this.captured = undefined; }
		focus() { document.activeElement = this; }
		addEventListener(type: string, fn: (event: any) => void) { const entries = this.listeners.get(type) ?? []; entries.push(fn); this.listeners.set(type, entries); }
		fire(type: string, extra: any = {}) { for (const fn of this.listeners.get(type) ?? []) { fn({ isTrusted: true, stopPropagation() {}, ...extra }); } }
	}
	const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
	const positional = (node: Element): string => {
		const parts: string[] = [];
		for (let at: Element | undefined = node; at; at = at.parentElement) {
			const index = (at.parentElement?.children ?? [at]).filter(sibling => sibling.localName === at!.localName).indexOf(at) + 1;
			parts.unshift(`${at.localName}:nth-of-type(${index})`);
		}
		return parts.join(' > ');
	};
	document = {
		documentElement: new Element('html'), createElement: (tag: string) => new Element(tag),
		createElementNS: (_ns: string, tag: string) => new Element(tag),
		elementsFromPoint: () => all(document.documentElement).filter(node => !node.shadow).reverse(),
		querySelectorAll: (selector: string) => all(document.documentElement).filter(node => selector === `#${node.id}` || selector === positional(node)),
		createTreeWalker: (root: Element) => {
			const entries = all(root).filter(node => node.data).map(node => ({ parentElement: node, data: node.data })); let index = 0;
			return { nextNode: () => entries[index++] };
		},
	};
	const windowEvents = new Map<string, (event: any) => void>();
	const window = { scrollX: 0, scrollY: 0, addEventListener: (name: string, handler: (event: any) => void) => { const previous = windowEvents.get(name); windowEvents.set(name, previous ? (event: any) => { previous(event); handler(event); } : handler); }, removeEventListener: (name: string) => windowEvents.delete(name) };
	const ticks = new Set<() => void>(); const messages: any[] = [];
	const location = { href: 'http://example.test/page' };
	const context = { document, window, location, Element, NodeFilter: { SHOW_TEXT: 4 }, CSS: { escape: (value: string) => value },
		crypto: webcrypto, Uint8Array, innerWidth: 800, innerHeight: 600,
		setInterval: (tick: () => void) => { ticks.add(tick); return tick; }, clearInterval: (tick: () => void) => ticks.delete(tick),
		__aiBrowserAnnotationChanged: (value: string) => messages.push(JSON.parse(value)),
	};
	const api = runInNewContext(annotationSource, context);
	const body = new Element('body'); document.documentElement.append(body);
	const target = new Element('button'); target.id = 'save'; target.textContent = 'Save'; body.append(target);
	const shadow = document.documentElement.children.find((node: Element) => node.shadow)?.shadow!;
	const find = (className: string) => all(shadow).find(node => node.className.split(' ').includes(className))!;
	const pick = (element = target, trusted = true, clientX = 120, clientY = 110) => {
		let prevented = false;
		windowEvents.get('click')!({ target: element, clientX, clientY, isTrusted: trusted, composedPath: () => [element, body, document.documentElement], preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
		return prevented;
	};
	return { api, target, body, Element, messages, find, pick, ticks, windowEvents, location, shadow, all, window };
}

test('toolbar lives outside the page; trusted selection creates editable notes and stable numbered badges', () => {
	const p = page();
	try {
		p.api.start({ records: [], nextNumber: 1 });
		assert.equal(p.all(p.shadow).some(node => node.className === 'toolbar'), false);
		assert.equal(p.pick(p.target, false), false); assert.equal(p.api.collect().records.length, 0);
		assert.equal(p.pick(), true); assert.equal(p.api.collect().records[0].elementFound, true);
		const textarea = p.all(p.shadow).find(node => node.localName === 'textarea')!;
		textarea.value = '<script>plain note</script>'; textarea.fire('input');
		assert.equal(p.api.collect().records[0].text, '<script>plain note</script>');
		assert.equal(p.find('head').children.length, 5);
		assert.equal(p.find('tag').textContent, 'button');
		p.find('number').fire('click'); assert.equal(p.find('palette').hidden, false);
		assert.equal(p.find('palette').children.length, 10);
		p.find('palette').children[3].fire('click'); assert.equal(p.api.collect().records[0].color, '#b91c1c');
		assert.equal(p.find('palette').hidden, true);
		p.find('head').children[2].fire('click'); assert.equal(p.messages.at(-1).type, 'copy');
		p.find('head').children[3].fire('click'); assert.equal(p.messages.at(-1).type, 'requestDelete');
		assert.equal(p.api.collect().records.length, 1);
		p.find('head').children[4].fire('click'); assert.equal(p.find('card').hidden, true); assert.equal(p.find('badge').hidden, false);
		p.find('badge').fire('click'); assert.equal(p.find('card').hidden, false);
		const first = p.api.collect().records[0];
		p.api.start({ records: [first], nextNumber: 2 }); p.pick();
		assert.equal(p.api.collect().records[1].number, 2);
		p.api.remove([first.id]); assert.equal(p.api.collect().records[0].number, 2);
	} finally { p.api.dispose(); }
	assert.equal(p.ticks.size, 0); assert.equal(p.windowEvents.size, 0);
});

test('rehydration keeps live targets and reattaches a weak path only with the same tag and text', () => {
	const p = page();
	try {
		p.target.id = ''; p.api.start({ records: [], nextNumber: 1 }); p.pick();
		const record = p.api.collect().records[0]; assert.equal(record.element.strong, false);
		p.api.start({ records: [record], nextNumber: 2 }); assert.equal(p.api.collect().records[0].elementFound, true);
		// A reload: the same document again, a new script. The marker goes back on its element.
		const reloaded = page();
		try { reloaded.target.id = ''; reloaded.api.hydrate({ records: [record], nextNumber: 2 }); assert.equal(reloaded.api.collect().records[0].elementFound, true); }
		finally { reloaded.api.dispose(); }
		// The same position holding other text is another element, and stays unresolved.
		const changed = page();
		try { changed.target.id = ''; changed.target.textContent = 'Cancel'; changed.api.hydrate({ records: [record], nextNumber: 2 }); assert.equal(changed.api.collect().records[0].elementFound, false); }
		finally { changed.api.dispose(); }
		p.target.remove(); assert.equal(p.api.collect().records[0].elementFound, false);
	} finally { p.api.dispose(); }
});

test('SPA URL change hides old annotations and requests the new URL without copying records', () => {
	const p = page();
	try {
		p.api.start({ records: [], nextNumber: 1 }); p.pick();
		p.location.href = 'http://example.test/another'; for (const tick of p.ticks) { tick(); }
		assert.equal(p.api.collect().records.length, 0);
		assert.equal(p.messages.at(-1).type, 'navigate'); assert.equal(p.messages.at(-1).url, p.location.href);
	} finally { p.api.dispose(); }
});


test('point annotations keep their page coordinates, stacked context and mode after restoration', () => {
	const p = page();
	try {
		p.window.scrollY = 200;
		p.api.start({ records: [], nextNumber: 1, mode: 'point' });
		p.pick();
		const record = p.api.collect().records[0];
		assert.equal(record.point.x, 120);
		assert.equal(record.point.y, 310);
		assert.equal(record.point.elements[0].selector, '#save');
		assert.equal(record.point.elements.some((el: any) => el.tag === 'body'), true);
		assert.equal(p.find('note').style.top, '110px');
		p.window.scrollY = 250;
		for (const tick of p.ticks) { tick(); }
		assert.equal(p.find('note').style.top, '60px');
		p.target.remove();
		p.api.hydrate({ records: [record], nextNumber: 2 });
		assert.equal(p.api.collect().records[0].elementFound, true);
		assert.equal(p.find('tag').textContent, 'Page point');
	} finally { p.api.dispose(); }
});


function pointer(type: string, x: number, y: number, extra: any = {}) {
	return { type, button: 0, pointerId: 1, clientX: x, clientY: y, isTrusted: true,
		preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...extra };
}

test('dragging an anywhere marker preserves its note and refreshes context only on drop', () => {
	const p = page();
	try {
		p.api.start({ records: [], nextNumber: 1, mode: 'point' }); p.pick();
		const record = p.api.collect().records[0]; record.text = 'Keep this note';
		p.api.hydrate({ records: [record], nextNumber: 2 });
		const badge = p.find('badge'), changes = p.messages.length;
		badge.fire('pointerdown', pointer('pointerdown', 125, 115));
		p.windowEvents.get('pointermove')!(pointer('pointermove', 225, 215));
		assert.equal(p.find('note').style.left, '220px');
		assert.equal(p.messages.length, changes);
		p.target.id = 'new-target'; p.target.textContent = 'New context';
		p.windowEvents.get('pointerup')!(pointer('pointerup', 225, 215));
		const moved = p.api.collect().records[0];
		assert.equal(moved.id, record.id); assert.equal(moved.text, 'Keep this note');
		assert.equal(moved.point.x, 220); assert.equal(moved.point.y, 210);
		assert.equal(moved.element.selector, '#new-target');
		assert.equal(moved.point.elements[0].text, 'New context');
		assert.equal(p.messages.length, changes + 1);
		badge.fire('click'); assert.equal(p.find('card').hidden, true);
		assert.equal(badge.captured, undefined);
	} finally { p.api.dispose(); }
});

test('anywhere drag cancellation restores coordinates and a simple click still opens the note', () => {
	const p = page();
	try {
		p.api.start({ records: [], nextNumber: 1, mode: 'point' }); p.pick();
		const record = p.api.collect().records[0];
		p.api.hydrate({ records: [record], nextNumber: 2 });
		const badge = p.find('badge'), changes = p.messages.length;
		badge.fire('pointerdown', pointer('pointerdown', 125, 115));
		p.windowEvents.get('pointermove')!(pointer('pointermove', 225, 215));
		p.windowEvents.get('pointercancel')!(pointer('pointercancel', 225, 215));
		assert.equal(p.api.collect().records[0].point.x, 120);
		assert.equal(p.messages.length, changes);
		badge.fire('click'); // Consume the synthetic click following a cancelled drag.
		badge.fire('pointerdown', pointer('pointerdown', 125, 115));
		p.windowEvents.get('pointerup')!(pointer('pointerup', 125, 115));
		badge.fire('click'); assert.equal(p.find('card').hidden, false);
	} finally { p.api.dispose(); }
});
