import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { usageButtonLimit, usageButtonWindows } from './usageButton.ts';

test('weekly figure and session ring are independent, regardless of quota order or reset time', () => {
	const weekly = { label: 'Weekly limit', usedPercent: 7, resetsAt: 1 };
	const session = { label: '5-hour limit', usedPercent: 80, resetsAt: 900000 };
	for (const windows of [[weekly, session], [session, weekly]]) {
		assert.deepEqual(usageButtonWindows(windows), { figure: weekly, session, mark: '93' });
	}
});

test('unknown usage keeps U; weekly-only data does not fill the session ring', () => {
	assert.deepEqual(usageButtonWindows([]), { figure: undefined, session: undefined, mark: 'U' });
	assert.equal(usageButtonWindows([{ label: 'Weekly limit', usedPercent: 100 }]).session, undefined);
	assert.equal(usageButtonWindows([{ label: 'Weekly limit', usedPercent: 100 }]).mark, '00');
	assert.equal(usageButtonWindows([{ label: 'Weekly limit', usedPercent: NaN }]).mark, 'U');
});

test('other agents can use daily, hourly or primary session quotas', () => {
	for (const label of ['Daily quota', '1-day limit', '3-hour limit', 'Model · primary', 'Session']) {
		const quota = { label, usedPercent: 12.9 };
		assert.deepEqual(usageButtonWindows([quota]), { figure: quota, session: quota, mark: '87' });
	}
});

test('plan-wide weekly usage wins over scoped weekly usage; shortest session period wins', () => {
	const weekly = { label: 'Weekly limit', usedPercent: 20 };
	const session = { label: '5-hour limit', usedPercent: 10 };
	assert.deepEqual(usageButtonWindows([
		{ label: 'Weekly · Model', usedPercent: 99 },
		{ label: '1-day limit', usedPercent: 90 }, weekly, session,
	]), { figure: weekly, session, mark: '80' });
});

test('exhausted short and long quotas have distinct states, with long taking precedence', () => {
	const short = (usedPercent: number) => ({ label: '5-hour limit', usedPercent });
	const long = (usedPercent: number) => ({ label: 'Weekly limit', usedPercent });
	assert.equal(usageButtonLimit([]), undefined);
	assert.equal(usageButtonLimit([short(99), long(99)]), undefined);
	assert.equal(usageButtonLimit([short(100), long(20)]), 'short');
	assert.equal(usageButtonLimit([short(20), long(100)]), 'long');
	assert.equal(usageButtonLimit([short(100), long(100)]), 'long');
	assert.equal(usageButtonLimit([short(100)]), 'short');
	assert.equal(usageButtonLimit([long(100)]), 'long');
	assert.equal(usageButtonLimit([{ label: 'Daily quota', usedPercent: 100 }]), 'short');
	assert.equal(usageButtonLimit([short(100), { label: 'Other · 5-hour limit', usedPercent: 100 }]), 'short');
	assert.equal(usageButtonLimit([short(100), { label: 'Weekly · Model', usedPercent: 100 }]), 'long');
});

test('without a weekly quota the figure uses the longer period, even when the short quota is higher', () => {
	const short = { label: '2-hour limit', usedPercent: 80 };
	const long = { label: '1-day limit', usedPercent: 12 };
	assert.deepEqual(usageButtonWindows([short, long]), { figure: long, session: short, mark: '88' });
	const primary = { label: 'primary', usedPercent: 60 };
	const secondary = { label: 'secondary', usedPercent: 9 };
	assert.deepEqual(usageButtonWindows([primary, secondary]), { figure: secondary, session: primary, mark: '91' });
});
