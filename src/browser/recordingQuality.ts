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
