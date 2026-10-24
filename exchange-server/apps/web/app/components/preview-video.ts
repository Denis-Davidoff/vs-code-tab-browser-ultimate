export type PreviewFrame = { tabId: string; data: string; width: number; height: number };
export type PreviewVideoChunk = PreviewFrame & { codec: 'avc1.420028'; streamId: string; key: boolean; timestamp: number };
export async function supportsPreviewVideo(): Promise<boolean> {
 try { return typeof VideoDecoder !== 'undefined' && (await VideoDecoder.isConfigSupported({ codec: 'avc1.420028', optimizeForLatency: true })).supported === true; }
 catch { return false; }
}
/** One canvas keeps pointer mapping and mobile zoom identical for JPEG and H.264. */
export function createPreviewVideo(canvas: () => HTMLCanvasElement | null, shown: (frame: PreviewFrame) => void, failed: () => void) {
 let decoder: VideoDecoder | undefined, stream = '', generation = 0, jpegSequence = 0, waitingKey = true;
 const pending = new Map<number, PreviewVideoChunk>();
 const reset = () => {
  generation++; jpegSequence++; stream = ''; waitingKey = true; pending.clear();
  try { decoder?.close(); } catch { /* Already closed. */ }
  decoder = undefined;
 };
 const paint = (source: CanvasImageSource, width: number, height: number, packet: PreviewFrame) => {
  const target = canvas(); if (!target) return;
  const context = target.getContext('2d', { alpha: false }); if (!context) return;
  if (target.width !== width || target.height !== height) { target.width = width; target.height = height; }
  context.drawImage(source, 0, 0, width, height); shown(packet);
 };
 return {
  reset, dispose: reset,
  async jpeg(packet: PreviewFrame) {
   if (decoder) reset();
   const sequence = ++jpegSequence, epoch = generation;
   let bitmap: ImageBitmap | undefined;
   try {
    if (typeof createImageBitmap === 'undefined') {
     const image = new Image();
     await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('Image unavailable')); image.src = `data:image/jpeg;base64,${packet.data}`; });
     if (epoch === generation && sequence === jpegSequence) paint(image, image.naturalWidth, image.naturalHeight, packet);
     return;
    }
    const bytes = Uint8Array.from(atob(packet.data), c => c.charCodeAt(0));
    bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    if (epoch === generation && sequence === jpegSequence) paint(bitmap, bitmap.width, bitmap.height, packet);
   } catch { /* Keep the last good preview. */ } finally { bitmap?.close(); }
  },
  video(packet: PreviewVideoChunk) {
   try {
    if (packet.codec !== 'avc1.420028' || typeof packet.streamId !== 'string' || !Number.isSafeInteger(packet.timestamp) || packet.timestamp < 0 || typeof packet.key !== 'boolean' || typeof packet.data !== 'string' || packet.data.length > 2_000_000 || !Number.isFinite(packet.width) || packet.width <= 0 || packet.width > 32000 || !Number.isFinite(packet.height) || packet.height <= 0 || packet.height > 32000) throw new Error('Invalid video packet');
    if (packet.streamId !== stream || (decoder?.decodeQueueSize ?? 0) > 4) reset();
    if (!decoder) {
     if (!packet.key) return;
     stream = packet.streamId; waitingKey = true;
     const epoch = generation;
     decoder = new VideoDecoder({
      output(frame) {
       try {
        if (epoch !== generation) return;
        const info = pending.get(frame.timestamp); pending.delete(frame.timestamp);
        if (info) paint(frame, frame.displayWidth, frame.displayHeight, info);
       } finally { frame.close(); }
      },
      error() { if (epoch === generation) { reset(); failed(); } },
     });
     decoder.configure({ codec: packet.codec, optimizeForLatency: true });
    }
    if (waitingKey && !packet.key) return;
    waitingKey = false;
    const bytes = Uint8Array.from(atob(packet.data), c => c.charCodeAt(0));
    if (pending.size >= 32) { reset(); return; }
    pending.set(packet.timestamp, packet);
    decoder.decode(new EncodedVideoChunk({ type: packet.key ? 'key' : 'delta', timestamp: packet.timestamp, data: bytes }));
   } catch { reset(); failed(); }
  },
 };
}
