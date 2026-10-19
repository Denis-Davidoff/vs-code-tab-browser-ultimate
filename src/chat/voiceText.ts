/**
 * Voice messages as text: what the helper says on stdout, read; and the chip and the prompt line a
 * transcript becomes. Neither agent can hear audio — Codex's `localAudio` input is in its protocol
 * and the model answers that it cannot listen — so a voice message reaches them as its transcript.
 * Leaf module, under test. See "Voice messages" in CLAUDE.md.
 */

/** The longest recording, in seconds. A message, not a dictation session: five minutes is ~2 MB of AAC. */
export const voiceMaxSeconds = 300;

/**
 * What `aiBrowser.chat.voiceLanguage` may hold: a BCP 47 tag. The manifest's `pattern` is the same
 * expression, so a setting that would be refused here is marked in the Settings editor first.
 */
export const voiceLocalePattern = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/;

/** The longest transcript passed on; five minutes of speech is about 5 000 characters. */
const maxTranscript = 20_000;

export type HelperLine =
	| { readonly e: 'ready'; readonly locale?: string }
	| { readonly e: 'level'; readonly v: number; readonly t: number }
	| { readonly e: 'limit'; readonly t: number }
	| { readonly e: 'status'; readonly v: 'downloading' | 'transcribing' }
	| { readonly e: 'text'; readonly v: string; readonly t: number }
	| { readonly e: 'error'; readonly code: string; readonly message: string };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** One line of the helper's stdout, or undefined for anything that is not one of its events. */
export function parseHelperLine(line: string): HelperLine | undefined {
	let data: unknown;
	try {
		data = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!data || typeof data !== 'object') {
		return undefined;
	}
	const o = data as Record<string, unknown>;
	switch (o.e) {
		case 'ready': return { e: 'ready', locale: typeof o.locale === 'string' ? o.locale.slice(0, 40) : undefined };
		case 'level': return finite(o.v) && finite(o.t) ? { e: 'level', v: Math.max(0, Math.min(1, o.v)), t: Math.max(0, o.t) } : undefined;
		case 'limit': return finite(o.t) ? { e: 'limit', t: Math.max(0, o.t) } : undefined;
		case 'status': return o.v === 'downloading' || o.v === 'transcribing' ? { e: 'status', v: o.v } : undefined;
		case 'text': return typeof o.v === 'string' && finite(o.t) ? { e: 'text', v: o.v, t: Math.max(0, o.t) } : undefined;
		case 'error': return { e: 'error', code: typeof o.code === 'string' ? o.code : 'unknown', message: typeof o.message === 'string' ? o.message.slice(0, 300) : 'The voice helper failed.' };
		default: return undefined;
	}
}

/** `m:ss`. */
export function clock(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** The transcript tidied: whitespace collapsed, cut by code point so no half surrogate pair is left (#373). */
export function tidyTranscript(text: string): string {
	const one = text.replace(/\s+/g, ' ').trim();
	const points = Array.from(one);
	return points.length > maxTranscript ? points.slice(0, maxTranscript).join('') + '…' : one;
}

/** The chip: the length and the first words, so two voice messages in one box can be told apart. */
export function voiceChipLabel(transcript: string, seconds: number): string {
	const words = Array.from(tidyTranscript(transcript));
	const start = words.length > 32 ? words.slice(0, 32).join('').trimEnd() + '…' : words.join('');
	return `${clock(seconds)} · ${start}`;
}

/** What the agent is given: the transcript, said to be one, since on-device recognition mishears. */
export function voicePromptText(transcript: string, seconds: number): string {
	return `Voice message from the user (${clock(seconds)}, transcribed on their device — it may contain recognition errors):\n${tidyTranscript(transcript)}`;
}
