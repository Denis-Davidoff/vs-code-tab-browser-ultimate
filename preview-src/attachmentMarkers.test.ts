import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentMarker, readAttachmentMarkers, selectedAttachmentMarkers } from './attachmentMarkers.ts';

test('portable marker preserves identity through a text-only copy and avoids existing reference numbers', () => {
	const first = attachmentMarker({ id: 'screenshot-id', label: 'Screenshot' });
	const second = attachmentMarker({ id: 'file:номер/with spaces', label: 'résumé | final.ts' });
	const parsed = readAttachmentMarkers(`Before [@999999 literal] ${first}\n${second} after`)!;
	assert.deepEqual(parsed.items.map(item => item.id), ['screenshot-id', 'file:номер/with spaces']);
	assert.deepEqual(parsed.items.map(item => item.label), ['Screenshot', 'résumé | final.ts']);
	assert.ok(parsed.text.startsWith('Before [@999999 literal] [@999998 Screenshot]'));
	assert.ok(parsed.text.endsWith(' after'));
});

test('malformed and unknown text stays ordinary text and empty IDs are not exported as badges', () => {
	for (const text of ['ordinary text', '[att:|name]', '[att:%ZZ|name]', '[att:%00|name]']) {
		assert.equal(readAttachmentMarkers(text), undefined);
	}
	assert.equal(attachmentMarker({ id: '', label: 'Legacy attachment' }), 'Legacy attachment');
	assert.equal(attachmentMarker({ id: '\ud800', label: 'Invalid attachment' }), 'Invalid attachment');
	assert.equal(attachmentMarker({ id: 'id', label: 'a]\nb' }), '[att:id|a  b]');
});

test('marker imports are bounded to the host batch limit', () => {
	const text = Array.from({ length: 60 }, (_, i) => attachmentMarker({ id: `id-${i}`, label: `File ${i}` })).join(' ');
	const parsed = readAttachmentMarkers(text)!;
	assert.equal(parsed.items.length, 50);
	assert.ok(parsed.text.includes('[att:id-59|File 59]'));
});

test('full sent-badge selection copies a stable marker with surrounding paragraph breaks', () => {
	const textNode = (text: string): any => ({ nodeType: 3, nodeName: '#text', textContent: text, childNodes: [] });
	const clone: any = { nodeType: 1, nodeName: 'SPAN', dataset: { attachmentKey: 'key' }, childNodes: [textNode('[@1 file.ts]')] };
	const paragraph: any = { nodeType: 1, nodeName: 'DIV', childNodes: [textNode('Before '), clone, textNode(' after')] };
	clone.replaceWith = (node: any) => { paragraph.childNodes[1] = node; };
	const fragment: any = { nodeType: 11, nodeName: '#document-fragment', childNodes: [paragraph, { nodeType: 1, nodeName: 'DIV', childNodes: [textNode('Next paragraph')] }], querySelectorAll: () => [clone] };
	let full = true;
	const range: any = { cloneRange: () => range, intersectsNode: () => true, compareBoundaryPoints: (which: number) => which === 0 ? (full ? -1 : 1) : 1, cloneContents: () => fragment };
	const document: any = { createRange: () => ({ selectNodeContents() {} }), createTextNode: textNode };
	const badge: any = { ownerDocument: document, contains: () => false, querySelector: () => null, dataset: { attachmentKey: 'key', attachmentId: 'saved-id', attachmentLabel: 'file.ts' } };
	const root: any = { ownerDocument: document, querySelectorAll: () => [badge] };
	const selection: any = { rangeCount: 1, getRangeAt: () => range, toString: () => 'Before file.ts after\nNext paragraph' };
	const result = selectedAttachmentMarkers(selection, root)!;
	assert.equal(result.text, 'Before [att:saved-id|file.ts] after\nNext paragraph');
	assert.deepEqual(result.ids, ['saved-id']);
	full = false;
	assert.equal(selectedAttachmentMarkers(selection, root), undefined);
});

test('selecting the visible badge title without its hidden slots still copies a restorable attachment', () => {
	const title = {};
	let measured: unknown;
	let startExpanded = false, endExpanded = false;
	const clone: any = { dataset: { attachmentKey: 'key' }, replaceWith(node: any) { fragment.childNodes = [node]; } };
	const fragment: any = { childNodes: [], querySelectorAll: () => [clone] };
	const document: any = {
		createRange: () => ({ selectNodeContents(node: unknown) { measured = node; } }),
		createTextNode: (text: string) => ({ nodeType: 3, textContent: text }),
	};
	const badge: any = { ownerDocument: document, contains: (node: unknown) => node === title, querySelector: () => title,
		dataset: { attachmentKey: 'key', attachmentId: 'saved-file', attachmentLabel: 'file.ts' } };
	const range: any = { startContainer: title, endContainer: title, intersectsNode: () => true, compareBoundaryPoints: () => 0,
		cloneRange: () => ({
			setStartBefore(node: unknown) { assert.equal(node, badge); startExpanded = true; },
			setEndAfter(node: unknown) { assert.equal(node, badge); endExpanded = true; },
			cloneContents() { assert.ok(startExpanded && endExpanded); return fragment; },
		}),
	};
	const result = selectedAttachmentMarkers({ rangeCount: 1, getRangeAt: () => range, toString: () => 'file.ts' } as any,
		{ ownerDocument: document, querySelectorAll: () => [badge] } as any)!;
	assert.equal(measured, title);
	assert.deepEqual(readAttachmentMarkers(result.text)?.items.map(item => item.id), ['saved-file']);
	assert.equal(result.text, '[att:saved-file|file.ts]');
});
