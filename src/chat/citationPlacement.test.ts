import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { citationInsertionOffset } from './citationPlacement.ts';

test('citations into Markdown destinations follow the whole link and preserve its syntax', () => {
	for (const text of ['Read [documentation](https://example.com/docs).', 'Read [documentation](<https://example.com/docs>).']) {
		const end = text.indexOf('/docs') + '/docs'.length;
		const at = citationInsertionOffset(text, end);
		assert.equal(at, text.indexOf(')') + 1);
		const marked = text.slice(0, at) + ' [1]' + text.slice(at);
		assert.ok(marked.includes(text.slice(0, at)));
		assert.ok(marked.includes('documentation]('));
	}
});

test('citations inside bare URLs preserve their full destination and sentence punctuation', () => {
	const text = 'See https://example.com/path/to/docs.';
	const end = text.indexOf('example.com') + 'example.com'.length;
	assert.equal(citationInsertionOffset(text, end), text.length - 1);
	const multiline = `Header\n${text}`;
	assert.equal(citationInsertionOffset(multiline, end + 7), multiline.length - 1);
});

test('ordinary prose and visible Markdown labels keep their exact citation positions', () => {
	const prose = 'A **typed result** has 42 items.';
	const end = prose.indexOf('42') + 2;
	assert.equal(citationInsertionOffset(prose, end), end);
	const label = '[documentation](https://example.com/docs)';
	assert.equal(citationInsertionOffset(label, label.indexOf(']')), label.indexOf(']'));
});
