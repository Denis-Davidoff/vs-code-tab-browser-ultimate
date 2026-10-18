import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentContext, attachmentReference } from './attachmentReferences.ts';
import type { AttachmentChip } from './chatProtocol.ts';

function chip(id: string, kind: AttachmentChip['kind'] = 'file'): AttachmentChip {
	return { id, kind, label: 'same label' };
}

test('references stay stable across removal, reordering, and queued sends', () => {
	const first = chip('one');
	const second = chip('two');
	const a = attachmentReference(first);
	const b = attachmentReference(second);
	assert.match(a, /^@\d+$/);
	assert.notEqual(a, b);
	assert.equal(attachmentReference(first), a);
	const context = attachmentContext([{ chip: second, text: '/project/two.ts' }, { chip: first, text: '/project/one.ts' }]);
	assert.ok(context.includes(`${b} — file: same label\n/project/two.ts`));
	assert.ok(context.includes(`${a} — file: same label\n/project/one.ts`));
	assert.ok(attachmentContext([{ chip: second }]).includes(b));
	assert.notEqual(attachmentReference(chip('three')), a);
});

test('image references correspond to image order even among text attachments', () => {
	const a = chip('image-one', 'screenshot');
	const b = chip('page', 'page');
	const c = chip('image-two', 'screenshot');
	const context = attachmentContext([
		{ chip: a, image: {} }, { chip: b, text: 'https://example.com' }, { chip: c, image: {}, text: 'Second screenshot' },
	]);
	assert.ok(context.includes(`${attachmentReference(a)} — screenshot: same label\nAttached image #1`));
	assert.ok(context.includes(`${attachmentReference(c)} — screenshot: same label\nAttached image #2`));
	assert.ok(context.includes('https://example.com'));
	assert.equal(attachmentContext([]), '');
});
