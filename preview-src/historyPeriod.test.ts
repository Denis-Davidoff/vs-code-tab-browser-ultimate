import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { historyPeriodRange } from './historyPeriod.ts';

test('history periods use local calendar days and Monday weeks', () => {
	const now = new Date(2026, 9, 21, 15, 30);
	const at = (day: number) => new Date(2026, 9, day).getTime();
	assert.deepEqual(historyPeriodRange('today', now), [at(21), at(22)]);
	assert.deepEqual(historyPeriodRange('yesterday', now), [at(20), at(21)]);
	assert.deepEqual(historyPeriodRange('week', now), [at(19), at(22)]);
	assert.deepEqual(historyPeriodRange('month', now), [at(1), at(22)]);
	assert.deepEqual(historyPeriodRange('week', new Date(2026, 9, 25)), [at(19), at(26)]);
	assert.deepEqual(historyPeriodRange('week', new Date(2026, 9, 26)), [at(26), at(27)]);
	assert.deepEqual(historyPeriodRange('all', now), [-Infinity, Infinity]);
});

test('previous month crosses years and includes leap days', () => {
	assert.deepEqual(historyPeriodRange('lastMonth', new Date(2026, 0, 5)),
		[new Date(2025, 11, 1).getTime(), new Date(2026, 0, 1).getTime()]);
	assert.deepEqual(historyPeriodRange('lastMonth', new Date(2024, 2, 5)),
		[new Date(2024, 1, 1).getTime(), new Date(2024, 2, 1).getTime()]);
});
