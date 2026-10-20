export type RecordingQuality = 'balanced' | 'high' | 'maximum';
export const recordingQualityKey = 'aiBrowser.recording.quality';
export const recordingProfiles = {
	balanced: { width: 1920, height: 1080, bitrate: 6_000_000, label: 'Balanced · 1080p' },
	high: { width: 2560, height: 1440, bitrate: 12_000_000, label: 'High · 1440p' },
	maximum: { width: 3840, height: 2160, bitrate: 24_000_000, label: 'Maximum · 4K' },
} as const;
export function readRecordingQuality(value: unknown): RecordingQuality {
	return value === 'balanced' || value === 'maximum' ? value : 'high';
}

/** How long a recording may run, in active (unpaused) seconds; set in Chat Settings. */
export const recordingSecondsKey = 'aiBrowser.recording.maxSeconds';
export const defaultRecordingSeconds = 300;
export const minRecordingSeconds = 10;
export const maxRecordingSeconds = 3600;
/** A stored or typed limit as whole seconds inside the allowed range; anything unreadable is the default. */
export function readRecordingSeconds(value: unknown): number {
	const seconds = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value) ? Number(value) : NaN;
	if (!Number.isFinite(seconds)) { return defaultRecordingSeconds; }
	return Math.min(maxRecordingSeconds, Math.max(minRecordingSeconds, Math.round(seconds)));
}

/** The smallest size limit a recording gets, whatever its length. */
export const minRecordingBytes = 256 * 1024 * 1024;
/**
 * The size limit that goes with a time limit: the preset's bitrate for that long,
 * with half again for a busy page (measured: a busy page at 12 Mbps reached
 * 256 MB at about 170 s, a little over the bitrate), and never below 256 MB.
 * A fixed 256 MB stopped a High recording at under three minutes, whatever the
 * time limit said.
 */
export function recordingByteLimit(seconds: number, bitrate: number): number {
	return Math.max(minRecordingBytes, Math.ceil(bitrate / 8 * seconds * 1.5));
}

/** "5 min", "1 h", "90 s", "1 min 30 s" — a limit as the settings and messages name it. */
export function formatRecordingSeconds(seconds: number): string {
	if (seconds >= 3600 && seconds % 3600 === 0) { return `${seconds / 3600} h`; }
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (!minutes) { return `${rest} s`; }
	return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}
