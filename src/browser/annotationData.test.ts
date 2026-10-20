import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseAnnotations, annotationColors } from './annotationData.ts';

const record = (number = 1) => ({ id: `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`, number, createdAt: 100,
	text: '<script>not markup</script>', element: { selector: '#save', strong: true, tag: 'button', text: 'Save', role: 'button' } });

test('annotation data keeps stable numbers and sorts by creation sequence', () => {
	const records = parseAnnotations([record(3), record(1)]);
	assert.deepEqual(records.map(item => item.number), [1, 3]);
	assert.equal(records[0].text, '<script>not markup</script>');
	assert.notEqual(records[0], records[1]);
});

test('renderer input cannot exceed bounds or duplicate identities', () => {
	for (const value of [null, {}, Array.from({ length: 51 }, () => record()), [record(), record()], [{ ...record(), text: 'x'.repeat(2001) }],
		[{ ...record(), number: -1 }], [{ ...record(), element: { ...record().element, selector: 'x'.repeat(4001) } }]]) {
		assert.throws(() => parseAnnotations(value));
	}
});

test('ten annotation colors round trip and arbitrary CSS color values are refused', () => {
	assert.equal(annotationColors.length, 10);
	for (const color of annotationColors) { assert.equal(parseAnnotations([{ ...record(), color }])[0].color, color); }
	assert.equal(parseAnnotations([record()])[0].color, '#2563eb');
	assert.throws(() => parseAnnotations([{ ...record(), color: 'url(x)' }]));
});
