import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { AttachmentReferenceScope, attachmentContext, attachmentReference, preserveAttachmentReference } from './attachmentReferences.ts';
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

test('navigation keeps a typed reference bound to the refreshed page content', () => {
	const original = chip('live-page', 'sharedPage');
	const typed = attachmentReference(original);
	const refreshed = { ...original, label: 'Destination page' };
	preserveAttachmentReference(original, refreshed);
	const updatedAgain = { ...refreshed, label: 'Updated title' };
	preserveAttachmentReference(refreshed, updatedAgain);
	assert.equal(attachmentReference(updatedAgain), typed);
	assert.ok(attachmentContext([{ chip: updatedAgain, text: 'https://example.com/destination' }])
		.includes(`${typed} — sharedPage: Updated title\nhttps://example.com/destination`));
	assert.notEqual(attachmentReference(chip('another-page', 'sharedPage')), typed);
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


test('each draft starts at one while queued messages retain their references', () => {
	const queued = [chip('queued-one'), chip('queued-two')];
	const draft = new AttachmentReferenceScope();
	draft.assign(queued);
	assert.deepEqual(queued.map(attachmentReference), ['@1', '@2']);
	const next = chip('next-message');
	new AttachmentReferenceScope().assign([next]);
	assert.equal(attachmentReference(next), '@1');
	assert.ok(attachmentContext(queued.map(chip => ({ chip }))).includes('@2 — file:'));
	assert.deepEqual(queued.map(attachmentReference), ['@1', '@2']);
});

test('removing all chips does not reuse a typed reference within the same draft', () => {
	const draft = new AttachmentReferenceScope();
	const first = chip('removed');
	draft.assign([first]);
	draft.assign([]);
	const second = chip('replacement');
	draft.assign([second]);
	assert.equal(attachmentReference(first), '@1');
	assert.equal(attachmentReference(second), '@2');
	const refreshed = { ...second, label: 'Refreshed' };
	preserveAttachmentReference(second, refreshed);
	draft.assign([refreshed, chip('third')]);
	assert.equal(attachmentReference(refreshed), '@2');
});


test('returning queued messages to a draft remaps colliding references and their text', () => {
	const draft = new AttachmentReferenceScope();
	draft.assign([chip('current')]);
	const first = chip('queued-first');
	const second = chip('queued-second');
	new AttachmentReferenceScope().assign([first]);
	new AttachmentReferenceScope().assign([second]);
	assert.equal(draft.restore([first], 'See @1 and @10'), 'See @2 and @10');
	assert.equal(draft.restore([second], 'Compare @1'), 'Compare @3');
	assert.equal(attachmentReference(first), '@2');
	assert.equal(attachmentReference(second), '@3');
});
