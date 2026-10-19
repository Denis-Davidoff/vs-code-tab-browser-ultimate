// This page belongs to the extension, never to the recorded website.
// CDP JPEGs become origin-clean canvas pixels; no getDisplayMedia permission is needed.
(() => {
	const host = (globalThis as unknown as { acquireVsCodeApi(): { postMessage(message: unknown): void } }).acquireVsCodeApi();
	const canvas = document.querySelector('canvas')!;
	const context = canvas.getContext('2d', { alpha: false })!;
	const status = document.getElementById('status')!;
	const video = document.querySelector('video')!;
	const save = document.getElementById('save')!;
	let recorder: MediaRecorder | undefined;
	let stream: MediaStream | undefined;
	let mime = '';
	let stopped = false;
	let sequence = 0;
	let chunks: Promise<void> = Promise.resolve();
	let queue: Promise<void> = Promise.resolve();
	let playbackUrl: string | undefined;
	let frameTimer: number | undefined;
	const acknowledgements = new Map<number, () => void>();
	const blobs: Blob[] = [];
	const send = (message: unknown) => host.postMessage(message);
	const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
	const fail = (error: unknown) => { status.textContent = `Recording failed: ${errorText(error)}`; send({ type: 'error', error: errorText(error) }); };
	const cleanup = () => {
		stopped = true;
		window.clearInterval(frameTimer);
		stream?.getTracks().forEach(track => track.stop());
		if (recorder && recorder.state !== 'inactive') { recorder.stop(); }
	};
	const requestFrame = () => {
		// requestFrame still needs a canvas paint. Redraw unchanged pixels so the
		// first and last second of a static page are not trimmed by the encoder.
		context.drawImage(canvas, 0, 0);
		(stream?.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined)?.requestFrame();
	};
	const pumpFrames = () => {
		window.clearInterval(frameTimer);
		requestFrame();
		// Preserve time on a static page too: CDP emits only when pixels change.
		frameTimer = window.setInterval(requestFrame, 1000 / 30);
	};

	function waitForChunk(seq: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => { acknowledgements.delete(seq); reject(new Error('Saving video data timed out.')); }, 15_000);
			acknowledgements.set(seq, () => { clearTimeout(timeout); resolve(); });
		});
	}
	function startEncoder(): void {
		stream = canvas.captureStream(0);
		recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
		recorder.ondataavailable = event => {
			if (!event.data.size || stopped) { return; }
			blobs.push(event.data);
			chunks = chunks.then(async () => {
				const data = await new Promise<string>((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = () => resolve(String(reader.result).split(',')[1]);
					reader.onerror = () => reject(reader.error);
					reader.readAsDataURL(event.data);
				});
				const seq = ++sequence;
				const saved = waitForChunk(seq);
				send({ type: 'chunk', seq, data });
				await saved;
			});
			void chunks.catch(fail);
		};
		recorder.onerror = event => fail(event);
		recorder.start(1000);
		pumpFrames();
		status.textContent = 'Recording the browser page. Pause or stop using the browser toolbar.';
	}

	async function handle(message: any): Promise<Record<string, unknown> | undefined> {
		switch (message.type) {
			case 'init': {
				mime = ['video/mp4;codecs=avc1.42001E', 'video/mp4', 'video/webm;codecs=vp8', 'video/webm']
					.find(format => MediaRecorder.isTypeSupported(format)) ?? '';
				if (!mime) { throw new Error('This editor has no supported video encoder.'); }
				return { mime };
			}
			case 'frame': {
				if (stopped || recorder?.state === 'paused') { return {}; }
				const bytes = Uint8Array.from(atob(message.data), character => character.charCodeAt(0));
				const picture = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
				try {
					if (!recorder) {
						canvas.width = Math.max(2, Math.floor(picture.width / 2) * 2);
						canvas.height = Math.max(2, Math.floor(picture.height / 2) * 2);
					}
					// A fixed video size survives viewport resizing, preserving the page's aspect ratio.
					const scale = Math.min(canvas.width / picture.width, canvas.height / picture.height);
					const width = picture.width * scale, height = picture.height * scale;
					context.fillStyle = '#000';
					context.fillRect(0, 0, canvas.width, canvas.height);
					context.drawImage(picture, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
					if (!recorder) { startEncoder(); }
				} finally { picture.close(); }
				return { mime: recorder?.mimeType };
			}
			case 'pause':
				window.clearInterval(frameTimer);
				if (recorder?.state === 'recording') {
					await new Promise<void>(resolve => { recorder!.addEventListener('pause', () => resolve(), { once: true }); recorder!.pause(); });
				}
				status.textContent = 'Paused. No browser frames are being captured.';
				return {};
			case 'resume':
				if (recorder?.state === 'paused') {
					await new Promise<void>(resolve => { recorder!.addEventListener('resume', () => resolve(), { once: true }); recorder!.resume(); });
				}
				status.textContent = 'Recording the browser page.';
				pumpFrames();
				return {};
			case 'stop': {
				if (!recorder) { throw new Error('No video frames were received.'); }
				if (recorder.state !== 'inactive') {
					if (recorder.state === 'recording') {
						requestFrame();
						await new Promise(resolve => window.setTimeout(resolve, 60));
					}
					await new Promise<void>(resolve => { recorder!.addEventListener('stop', () => resolve(), { once: true }); recorder!.stop(); });
				}
				await chunks;
				cleanup();
				const blob = new Blob(blobs, { type: recorder.mimeType });
				blobs.length = 0;
				playbackUrl = URL.createObjectURL(blob);
				video.src = playbackUrl;
				await new Promise<void>((resolve, reject) => {
					const timeout = window.setTimeout(() => reject(new Error('The recorded video could not be opened.')), 10_000);
					video.onloadeddata = () => { window.clearTimeout(timeout); resolve(); };
					video.onerror = () => { window.clearTimeout(timeout); reject(new Error('The recorded video could not be decoded.')); };
					video.load();
				});
				video.hidden = false;
				canvas.hidden = true;
				save.hidden = false;
				status.textContent = 'Video recorded.';
				return { duration: Number.isFinite(video.duration) ? video.duration : undefined };
			}
			case 'abort':
				cleanup(); blobs.length = 0;
				status.textContent = `Recording failed: ${message.error}`;
				return undefined;
		}
		return undefined;
	}
	window.addEventListener('message', event => {
		const message = event.data;
		if (message?.type === 'chunkAck') {
			acknowledgements.get(message.seq)?.(); acknowledgements.delete(message.seq); return;
		}
		queue = queue.then(async () => {
			try {
				const reply = await handle(message);
				if (reply) { send({ type: 'reply', seq: message.seq, ...reply }); }
			} catch (error) { send({ type: 'reply', seq: message.seq, error: errorText(error) }); }
		});
	});
	save.addEventListener('click', () => send({ type: 'save' }));
	window.addEventListener('unload', () => { cleanup(); if (playbackUrl) { URL.revokeObjectURL(playbackUrl); } });
	send({ type: 'ready' });
})();
