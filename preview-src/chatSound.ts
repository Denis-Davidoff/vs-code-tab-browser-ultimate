/*---------------------------------------------------------------------------------------------
 *  The chat's finish sounds, synthesised with Web Audio: no audio files, so nothing for the
 *  CSP to allow and nothing extra to ship to Chrome or the website.
 *--------------------------------------------------------------------------------------------*/

import type { ChatSound } from '../src/chat/chatProtocol';

export const chatSoundLabels: Readonly<Record<ChatSound, string>> = {
	chime: 'Chime', bell: 'Bell', pop: 'Pop', dingdong: 'Ding-dong', marimba: 'Marimba',
	harp: 'Harp', kalimba: 'Kalimba', glass: 'Glass', bubble: 'Bubble', coin: 'Coin',
	levelup: 'Level up', sparkle: 'Sparkle', sonar: 'Sonar', arcade: 'Arcade', droplet: 'Droplet',
	woodblock: 'Woodblock', fanfare: 'Fanfare', zen: 'Zen bowl', whistle: 'Whistle', synth: 'Synth pad',
	lullaby: 'Lullaby', triad: 'Triad', ascend: 'Ascend', descend: 'Descend', doorbell: 'Doorbell', tick: 'Tick', blip: 'Blip', laser: 'Laser', ufo: 'UFO', boing: 'Boing', piano: 'Piano', celesta: 'Celesta', organ: 'Organ', flute: 'Flute', pluck: 'Pluck', gong: 'Gong', twinkle: 'Twinkle', heartbeat: 'Heartbeat', success: 'Success', notice: 'Notice', trill: 'Trill', jingle: 'Jingle', swoosh: 'Swoosh', robot: 'Robot', chirp: 'Chirp', harmony: 'Harmony', steel: 'Steel drum', cosmic: 'Cosmic', ping: 'Ping', victory: 'Victory',
};

/** One note: frequency, start and length in seconds, wave, loudness (0–1), and a frequency it glides to. */
type Note = readonly [freq: number, at: number, length: number, wave: OscillatorType, gain: number, to?: number];

const notes: Readonly<Record<ChatSound, readonly Note[]>> = {
	chime: [[880, 0, 0.6, 'sine', 0.6], [1318.5, 0.09, 0.8, 'sine', 0.5], [1760, 0.18, 0.9, 'sine', 0.35]],
	bell: [[659.3, 0, 1.6, 'sine', 0.6], [1318.5, 0, 1.2, 'sine', 0.25], [1977, 0, 0.8, 'sine', 0.12]],
	pop: [[520, 0, 0.12, 'triangle', 0.8], [780, 0.07, 0.14, 'triangle', 0.6]],
	dingdong: [[784, 0, 0.7, 'sine', 0.6], [622.3, 0.32, 0.9, 'sine', 0.6]],
	marimba: [[523.3, 0, 0.3, 'triangle', 0.6], [659.3, 0.1, 0.3, 'triangle', 0.55], [784, 0.2, 0.45, 'triangle', 0.5]],
	harp: [[523.3, 0, 0.9, 'triangle', 0.45], [659.3, 0.06, 0.9, 'triangle', 0.42], [784, 0.12, 0.9, 'triangle', 0.4], [1046.5, 0.18, 1.1, 'triangle', 0.38], [1318.5, 0.24, 1.2, 'sine', 0.3]],
	kalimba: [[1046.5, 0, 0.5, 'sine', 0.6], [2093, 0, 0.12, 'sine', 0.2], [1318.5, 0.14, 0.6, 'sine', 0.5], [2637, 0.14, 0.12, 'sine', 0.15]],
	glass: [[1567.98, 0, 1.4, 'sine', 0.45], [2349.3, 0, 1.0, 'sine', 0.2], [3135.96, 0.02, 0.7, 'sine', 0.12]],
	bubble: [[300, 0, 0.12, 'sine', 0.7, 900], [420, 0.12, 0.14, 'sine', 0.6, 1200]],
	coin: [[987.8, 0, 0.08, 'square', 0.35], [1318.5, 0.08, 0.4, 'square', 0.35]],
	levelup: [[523.3, 0, 0.1, 'square', 0.3], [659.3, 0.09, 0.1, 'square', 0.3], [784, 0.18, 0.1, 'square', 0.3], [1046.5, 0.27, 0.35, 'square', 0.32]],
	sparkle: [[2093, 0, 0.25, 'sine', 0.3], [2637, 0.05, 0.25, 'sine', 0.28], [3136, 0.1, 0.25, 'sine', 0.25], [3951, 0.15, 0.35, 'sine', 0.22], [2637, 0.22, 0.4, 'sine', 0.18]],
	sonar: [[1200, 0, 1.4, 'sine', 0.55, 1150], [1200, 0.6, 1.0, 'sine', 0.2, 1150]],
	arcade: [[440, 0, 0.3, 'square', 0.3, 1760]],
	droplet: [[1400, 0, 0.18, 'sine', 0.65, 600], [1800, 0.16, 0.14, 'sine', 0.35, 900]],
	woodblock: [[1100, 0, 0.07, 'triangle', 0.8], [880, 0.13, 0.08, 'triangle', 0.75]],
	fanfare: [[392, 0, 0.16, 'sawtooth', 0.25], [523.3, 0.15, 0.16, 'sawtooth', 0.25], [659.3, 0.3, 0.16, 'sawtooth', 0.25], [784, 0.45, 0.6, 'sawtooth', 0.28], [523.3, 0.45, 0.6, 'sawtooth', 0.15]],
	zen: [[220, 0, 2.6, 'sine', 0.55], [440.5, 0, 2.2, 'sine', 0.25], [661.2, 0, 1.6, 'sine', 0.12], [1325, 0, 0.9, 'sine', 0.06]],
	whistle: [[1200, 0, 0.22, 'sine', 0.45, 1800], [1500, 0.25, 0.3, 'sine', 0.45, 1100]],
	synth: [[261.6, 0, 1.3, 'sawtooth', 0.12], [329.6, 0, 1.3, 'sawtooth', 0.11], [392, 0, 1.3, 'sawtooth', 0.11], [523.3, 0, 1.3, 'triangle', 0.15]],
	lullaby: [[659.3,0,0.5,'sine',0.5],[587.3,0.35,0.5,'sine',0.45],[523.3,0.7,0.9,'sine',0.45]],
	triad: [[523.3,0,1.0,'sine',0.35],[659.3,0,1.0,'sine',0.3],[784,0,1.0,'sine',0.3]],
	ascend: [[392,0,0.15,'sine',0.5],[523.3,0.12,0.15,'sine',0.5],[659.3,0.24,0.15,'sine',0.5],[784,0.36,0.5,'sine',0.5]],
	descend: [[1046.5,0,0.15,'sine',0.5],[784,0.12,0.15,'sine',0.5],[659.3,0.24,0.15,'sine',0.5],[523.3,0.36,0.5,'sine',0.5]],
	doorbell: [[659.3,0,0.8,'triangle',0.5],[523.3,0.45,1.0,'triangle',0.5]],
	tick: [[2000,0,0.03,'square',0.4],[2000,0.12,0.03,'square',0.3]],
	blip: [[880,0,0.08,'square',0.35]],
	laser: [[1800,0,0.35,'sawtooth',0.25,200]],
	ufo: [[600,0,0.6,'sine',0.4,1200],[1200,0.6,0.6,'sine',0.35,600]],
	boing: [[150,0,0.4,'sine',0.7,600]],
	piano: [[523.3,0,0.9,'triangle',0.5],[1046.5,0,0.5,'sine',0.15],[784,0.2,1.0,'triangle',0.45]],
	celesta: [[1568,0,0.6,'sine',0.4],[2093,0.1,0.6,'sine',0.35],[2637,0.2,0.8,'sine',0.3]],
	organ: [[261.6,0,1.0,'square',0.12],[523.3,0,1.0,'square',0.08],[784,0,1.0,'sine',0.15]],
	flute: [[880,0,0.35,'sine',0.45],[987.8,0.3,0.35,'sine',0.45],[1174.7,0.6,0.6,'sine',0.45]],
	pluck: [[440,0,0.25,'sawtooth',0.3],[660,0.12,0.3,'sawtooth',0.25]],
	gong: [[110,0,3.0,'sine',0.5],[220.7,0,2.4,'sine',0.25],[331,0,1.8,'sine',0.15]],
	twinkle: [[1318.5,0,0.15,'sine',0.35],[1760,0.1,0.15,'sine',0.35],[1318.5,0.2,0.15,'sine',0.35],[2093,0.3,0.4,'sine',0.35]],
	heartbeat: [[70,0,0.15,'sine',0.9],[65,0.2,0.18,'sine',0.8]],
	success: [[587.3,0,0.12,'triangle',0.5],[880,0.12,0.45,'triangle',0.5]],
	notice: [[740,0,0.2,'sine',0.5],[740,0.25,0.2,'sine',0.5]],
	trill: [[1046.5,0,0.06,'sine',0.4],[1174.7,0.06,0.06,'sine',0.4],[1046.5,0.12,0.06,'sine',0.4],[1174.7,0.18,0.06,'sine',0.4],[1318.5,0.24,0.4,'sine',0.4]],
	jingle: [[1318.5,0,0.2,'triangle',0.4],[1318.5,0.2,0.2,'triangle',0.4],[1318.5,0.4,0.4,'triangle',0.4]],
	swoosh: [[300,0,0.3,'sawtooth',0.12,2400]],
	robot: [[220,0,0.1,'square',0.3],[330,0.12,0.1,'square',0.3],[165,0.24,0.2,'square',0.3]],
	chirp: [[2500,0,0.08,'sine',0.4,3500],[2500,0.12,0.08,'sine',0.4,3500]],
	harmony: [[392,0,1.2,'sine',0.3],[493.9,0.15,1.0,'sine',0.28],[587.3,0.3,0.9,'sine',0.26]],
	steel: [[587.3,0,0.4,'sine',0.5],[1174.7,0,0.2,'sine',0.2],[880,0.18,0.5,'sine',0.45],[1760,0.18,0.2,'sine',0.15]],
	cosmic: [[196,0,1.5,'sine',0.35,392],[293.7,0.2,1.3,'triangle',0.2,587.3]],
	ping: [[1760,0,0.5,'sine',0.5]],
	victory: [[523.3,0,0.12,'square',0.25],[523.3,0.14,0.12,'square',0.25],[523.3,0.28,0.12,'square',0.25],[698.5,0.42,0.6,'square',0.3]],
};

let context: AudioContext | undefined;
/** What the last call started, so a new sound (a choice in settings, a second finish) cuts it off, repeats included. */
let playing: { limiter: AudioNode; oscillators: OscillatorNode[] } | undefined;

/** Stops the sound still playing, if any. */
export function stopChatSound(): void {
	const last = playing;
	playing = undefined;
	if (!last) { return; }
	for (const osc of last.oscillators) { try { osc.stop(); } catch { /* already ended */ } }
	try { last.limiter.disconnect(); } catch { /* already gone */ }
}

/** Plays `sound` at `volume` (0–200; above 100 is louder than the first build's maximum). Silently does nothing where audio is unavailable. */
export function playChatSound(sound: ChatSound, volume: number, repeat = 1): void {
	stopChatSound();
	const level = Math.min(2, Math.max(0, volume / 100));
	if (level <= 0) { return; }
	try {
		context ??= new AudioContext();
		const ctx = context;
		// A context made without a user gesture (a finish in a background window) starts suspended,
		// and notes scheduled before resume() lands are in the past by then and never sound.
		if (ctx.state !== 'running') {
			void ctx.resume().then(() => schedule(ctx, sound, level, repeat), () => { /* audio not allowed */ });
			return;
		}
		schedule(ctx, sound, level, repeat);
	} catch {
		// No audio device, or the page may not start audio: a sound is never worth an error.
	}
}

function schedule(ctx: AudioContext, sound: ChatSound, level: number, repeat: number): void {
	try {
		const start = ctx.currentTime + 0.02;
		// Loud levels and chords add up past 1: a limiter keeps them loud without clipping into noise.
		const limiter = ctx.createDynamicsCompressor();
		limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.1;
		limiter.connect(ctx.destination);
		const oscillators: OscillatorNode[] = [];
		playing = { limiter, oscillators };
		const list = notes[sound] ?? notes.chime;
		const span = Math.max(...list.map(([, at, length]) => at + length)) + 0.15;
		const times = Math.round(Math.min(5, Math.max(1, Number.isFinite(repeat) ? repeat : 1)));
		for (let r = 0; r < times; r++) for (const [freq, at0, length, wave, gain, to] of list) {
			const at = at0 + r * span;
			const osc = ctx.createOscillator();
			const amp = ctx.createGain();
			osc.type = wave;
			const t = start + at;
			osc.frequency.setValueAtTime(freq, t);
			if (to) { osc.frequency.exponentialRampToValueAtTime(to, t + length * 0.8); }
			amp.gain.setValueAtTime(0.0001, t);
			amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * level * 0.5), t + 0.012);
			amp.gain.exponentialRampToValueAtTime(0.0001, t + length);
			osc.connect(amp).connect(limiter);
			osc.start(t);
			osc.stop(t + length + 0.05);
			oscillators.push(osc);
		}
	} catch {
		// No audio device, or the page may not start audio: a sound is never worth an error.
	}
}

/** Starts the audio context on the first press or key in the view, so a later finish in a background window may play. */
export function unlockChatSound(target: EventTarget): void {
	const unlock = (): void => {
		try { context ??= new AudioContext(); if (context.state !== 'running') { void context.resume().catch(() => undefined); } } catch { /* no audio */ }
		if (context?.state === 'running') { target.removeEventListener('pointerdown', unlock, true); target.removeEventListener('keydown', unlock, true); }
	};
	target.addEventListener('pointerdown', unlock, true);
	target.addEventListener('keydown', unlock, true);
}
