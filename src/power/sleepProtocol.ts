export const sleepMinutes = [5, 10, 15, 20, 25, 30, 35, 40, 45, 55] as const;
export const sleepHours = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 24, 48, 72] as const;
export type SleepChoice = { mode: 'off' } | { mode: 'agents' } | { mode: 'timer'; minutes: number };
export interface SleepState {
	mode: SleepChoice['mode'];
	until?: number;
	minutes?: number;
	active: boolean;
	error?: string;
}
export function validSleepChoice(value: SleepChoice): boolean {
	return value?.mode === 'off' || value?.mode === 'agents' || (value?.mode === 'timer' &&
		([...sleepMinutes, ...sleepHours.map(h => h * 60)] as number[]).includes(value.minutes));
}
