import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findLinks, linkableUrl, maxLinkLength, rangeCoversRow, spanToRange } from './terminalLinks.ts';

const urls = (text: string) => findLinks(text).map(l => text.slice(l.start, l.end));

test('http and https addresses in a line are found, with their position', () => {
	const text = 'see https://example.com/a?b=1 and http://localhost:3000/x#y.';
	assert.deepEqual(urls(text), ['https://example.com/a?b=1', 'http://localhost:3000/x#y']);
	const [first] = findLinks(text);
	assert.equal(first.start, 4);
	assert.equal(first.url, 'https://example.com/a?b=1');
});

test('sentence punctuation and unbalanced brackets are not part of the address; balanced ones are', () => {
	assert.deepEqual(urls('(https://example.com/a)'), ['https://example.com/a']);
	assert.deepEqual(urls('https://en.wikipedia.org/wiki/Foo_(bar)'), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
	assert.deepEqual(urls('<https://example.com/a>, and "https://example.com/b".'), ['https://example.com/a', 'https://example.com/b']);
	assert.deepEqual(urls('**https://example.com/a**'), ['https://example.com/a']);
	assert.deepEqual(urls('visit https://example.com!'), ['https://example.com']);
	assert.deepEqual(urls('[x](https://example.com/y)'), ['https://example.com/y']);
});

test('only http and https with a host and no credentials are links', () => {
	for (const text of ['file:///etc/passwd', 'command:workbench.action.quit', 'javascript:alert(1)', 'vscode://x/y', 'ftp://example.com/x', 'mailto:a@b.c']) {
		assert.deepEqual(findLinks(text), [], text);
	}
	assert.deepEqual(findLinks('https://user:secret@example.com/'), [], 'credentials in the address');
	assert.deepEqual(findLinks('https://'), []);
	assert.equal(linkableUrl('https://example.com'), 'https://example.com/');
	assert.equal(linkableUrl('HTTPS://EXAMPLE.COM/a'), 'https://example.com/a');
	assert.equal(linkableUrl('ftp://example.com'), undefined);
	assert.equal(linkableUrl('https://example.com/' + 'a'.repeat(maxLinkLength)), undefined, 'too long');
});

test('a control character ends an address, and a line of megabytes is not searched', () => {
	assert.deepEqual(urls('https://example.com/a\u001b[0m rest'), ['https://example.com/a']);
	assert.deepEqual(findLinks('https://example.com/ '.repeat(1000)), []);
});

test('a link\'s cells: characters map to cells, rows wrap at the column count, and a range names the rows it touches', () => {
	// 10 columns; the text is two rows joined: "see https:" / "//x.com ok".
	const text = 'see https://x.com ok';
	const cells = [...text].map((_, i) => i);
	const [span] = findLinks(text);
	const range = spanToRange(span, cells, 10, 5)!;
	assert.deepEqual(range, { start: { x: 5, y: 5 }, end: { x: 7, y: 6 } });
	assert.equal(rangeCoversRow(range, 5), true);
	assert.equal(rangeCoversRow(range, 6), true);
	assert.equal(rangeCoversRow(range, 7), false);
	assert.equal(rangeCoversRow(range, 4), false);
});

test('a double-width character shifts the cells of what follows it', () => {
	// "日 https://x.com": the first character takes two cells, so the address starts at cell 3 and not 2.
	const text = '日 https://x.com';
	const cells = [...text].map((_, i) => (i === 0 ? 0 : i + 1));
	assert.equal(cells.length, text.length);
	const [span] = findLinks(text);
	assert.deepEqual(spanToRange(span, cells, 80, 1), { start: { x: 4, y: 1 }, end: { x: 16, y: 1 } });
	assert.equal(spanToRange({ start: 0, end: 99, url: 'x' }, cells, 80, 1), undefined, 'a span past the text has no range');
});
