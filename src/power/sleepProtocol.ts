export const sleepMinutes = [5, 10, 15, 20, 25, 30, 35, 40, 45, 55] as const;
export const sleepHours = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 24, 48, 72] as const;
/** What "until the agents finish" waits for: one tab of the chat, or every tab of this window. */
export type SleepScope = 'tab' | 'window';
export type SleepChoice = { mode: 'off' } | { mode: 'agents'; scope?: SleepScope; tabId?: string } | { mode: 'timer'; minutes: number };
export interface SleepState {
	automatic?: boolean;
	automaticActive?: boolean;
	mode: SleepChoice['mode'];
	until?: number;
	minutes?: number;
	/** `agents` only: absent reads as `window`. */
	scope?: SleepScope;
	/** `agents` with `scope: 'tab'`: the tab whose work holds the computer awake. */
	tabId?: string;
	active: boolean;
	error?: string;
}
export function validSleepChoice(value: SleepChoice): boolean {
	if (value?.mode === 'agents') {
		const scope = value.scope ?? 'window';
		return scope === 'window' ? value.tabId === undefined
			: scope === 'tab' && typeof value.tabId === 'string' && value.tabId.length > 0 && value.tabId.length <= 200;
	}
	return value?.mode === 'off' || (value?.mode === 'timer' &&
		([...sleepMinutes, ...sleepHours.map(h => h * 60)] as number[]).includes(value.minutes));
}
