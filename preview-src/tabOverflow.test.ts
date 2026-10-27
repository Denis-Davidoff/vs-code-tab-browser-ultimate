import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { fitTabs } from './tabOverflow.ts';

test('everything fits: no overflow', () => {
	assert.deepEqual(fitTabs({ widths: [60, 60, 130], front: 2, available: 260, gap: 2, overflowWidth: 40 }), { visible: [0, 1, 2], hidden: [] });
});

test('the front tab is always shown, then tabs in order while they fit', () => {
	const fit = fitTabs({ widths: [60, 60, 60, 60, 130, 60], front: 4, available: 300, gap: 2, overflowWidth: 40 });
	// budget 300-40-2=258; front 130 → 128; 62 → 66; 62 → 4; stop
	assert.deepEqual(fit, { visible: [0, 1, 4], hidden: [2, 3, 5] });
});

test('stops at the first tab that does not fit, keeping strip order', () => {
	const fit = fitTabs({ widths: [60, 140, 60], front: 0, available: 220, gap: 0, overflowWidth: 40 });
	assert.deepEqual(fit, { visible: [0], hidden: [1, 2] });
});

test('a front tab wider than the room is still shown', () => {
	assert.deepEqual(fitTabs({ widths: [200, 60], front: 0, available: 100, gap: 2, overflowWidth: 40 }), { visible: [0], hidden: [1] });
});

test('no front tab', () => {
	assert.deepEqual(fitTabs({ widths: [60, 60, 60], front: -1, available: 150, gap: 0, overflowWidth: 30 }), { visible: [0, 1], hidden: [2] });
	assert.deepEqual(fitTabs({ widths: [], front: -1, available: 10, gap: 0, overflowWidth: 30 }), { visible: [], hidden: [] });
});
