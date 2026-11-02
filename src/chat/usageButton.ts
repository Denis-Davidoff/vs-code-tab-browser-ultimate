import type { UsageWindow } from './chatProtocol';

function duration(w: UsageWindow): number | undefined {
	if (/\bweek(?:ly)?\b/i.test(w.label)) { return 10080; }
	if (/\bdaily\b/i.test(w.label)) { return 1440; }
	const match = /\b(\d+(?:\.\d+)?)[ -]*(minute|hour|day)s?\b/i.exec(w.label);
	return match ? Number(match[1]) * (match[2].toLowerCase() === 'day' ? 1440 : match[2].toLowerCase() === 'hour' ? 60 : 1) : undefined;
}

/** Separate the long-period figure from the short-period ring. Reset times
 * are deliberately not durations: a weekly window may reset in a minute. */
export function usageButtonWindows(windows: readonly UsageWindow[]): { figure?: UsageWindow; session?: UsageWindow; mark: string } {
	const valid = windows.filter(w => Number.isFinite(w.usedPercent));
	const highest = (items: readonly UsageWindow[]) => items.reduce<UsageWindow | undefined>((best, w) => !best || w.usedPercent > best.usedPercent ? w : best, undefined);
	const weekly = valid.filter(w => duration(w) === 10080);
	const longest = Math.max(...valid.map(w => duration(w) ?? 0));
	const long = valid.filter(w => (duration(w) ?? 0) === longest);
	// Prefer the plan-wide weekly quota over model-specific weekly quotas.
	const figure = weekly.find(w => /(?:^| · )Weekly limit$/i.test(w.label)) ?? highest(weekly)
		?? highest(valid.filter(w => /\bsecondary\b/i.test(w.label))) ?? highest(long);
	const short = valid.filter(w => /\b(?:session|primary)\b/i.test(w.label) || (duration(w) !== undefined && duration(w)! < 10080));
	const shortest = Math.min(...short.map(w => duration(w) ?? 0));
	const session = highest(short.filter(w => (duration(w) ?? 0) === shortest));
	const mark = figure ? String(Math.max(0, Math.min(100, Math.floor(100 - figure.usedPercent)))).padStart(2, '0') : 'U';
	return { figure, session, mark };
}

/** A long quota takes precedence when both periods are exhausted. */
export function usageButtonLimit(windows: readonly UsageWindow[]): 'short' | 'long' | undefined {
	const { session } = usageButtonWindows(windows);
	const reached = windows.filter(w => Number.isFinite(w.usedPercent) && w.usedPercent >= 100);
	const isShort = (w: UsageWindow) => !!session && (w === session
		|| (duration(w) !== undefined && duration(w) === duration(session))
		|| /\b(?:session|primary)\b/i.test(w.label));
	if (reached.some(w => !isShort(w))) { return 'long'; }
	return reached.length ? 'short' : undefined;
}
