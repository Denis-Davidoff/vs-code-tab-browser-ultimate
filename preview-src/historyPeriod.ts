export type HistoryPeriod = 'all' | 'today' | 'yesterday' | 'week' | 'month' | 'lastMonth';

/** Local calendar boundaries; weeks start on Monday. End is exclusive. */
export function historyPeriodRange(period: HistoryPeriod, now = new Date()): readonly [number, number] {
	const year = now.getFullYear();
	const month = now.getMonth();
	const day = now.getDate();
	const midnight = (offset: number) => new Date(year, month, day + offset).getTime();
	switch (period) {
		case 'today': return [midnight(0), midnight(1)];
		case 'yesterday': return [midnight(-1), midnight(0)];
		case 'week': return [midnight(-((now.getDay() + 6) % 7)), midnight(1)];
		case 'month': return [new Date(year, month, 1).getTime(), midnight(1)];
		case 'lastMonth': return [new Date(year, month - 1, 1).getTime(), new Date(year, month, 1).getTime()];
		case 'all': return [-Infinity, Infinity];
	}
}
