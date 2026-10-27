import { randomUUID } from 'crypto';

export interface RemoteVideoChunk {
 codec: 'avc1.420028'; streamId: string; key: boolean; timestamp: number;
 data: string; width: number; height: number;
}
interface Session {
 sessionId: string;
 client: {
  send(method: string, params: object, sessionId: string): Promise<any>;
  on(method: string, callback: (params: any, sessionId?: string) => void): { dispose(): void };
 };
}
export interface RemoteVideoEncoder {
 push(data: string, width: number, height: number): Promise<void>;
 requestKeyframe(): void;
 dispose(): void;
}

/** Runs in an isolated renderer world. Nothing is installed in the page's DOM or main JS world. */
function installEncoder(binding: string, name: string, stream: string): boolean {
 const scope = globalThis as any;
 if (!scope.VideoEncoder || !scope.VideoFrame || !scope.createImageBitmap || !scope.OffscreenCanvas) return false;
 scope[name]?.dispose();
 let encoder: any, canvas: any, context: any, closed = false, busy = false, force = true;
 let size = '', serial = 0, lastKey = 0, lastImage = '', lastSent = 0, timestamp = 0;
 let last: { data: string; width: number; height: number } | undefined;
 const frames = new Map<number, { width: number; height: number; streamId: string }>();
 const report = (value: unknown) => { if (!closed) scope[binding](JSON.stringify(value)); };
 const dispose = () => {
  closed = true; frames.clear(); last = undefined;
  try { encoder?.close(); } catch { /* Already closed. */ }
  encoder = undefined; lastImage = '';
  if (canvas) { canvas.width = 0; canvas.height = 0; }
  canvas = undefined; context = undefined;
  if (scope[name]?.dispose === dispose) delete scope[name];
 };
 const push = async (data: string, width: number, height: number): Promise<boolean> => {
  last = { data, width, height };
  if (closed || busy || (encoder?.encodeQueueSize ?? 0) > 2) return false;
  if (!force && data === lastImage && Date.now() - lastSent < 15_000) return false;
  busy = true;
  let bitmap: any;
  try {
   const bytes = Uint8Array.from(scope.atob(data), (c: string) => c.charCodeAt(0));
   bitmap = await scope.createImageBitmap(new scope.Blob([bytes], { type: 'image/jpeg' }));
   if (closed) return false;
   const scale = Math.min(1, 1440 / bitmap.width, 1000 / bitmap.height);
   const w = Math.max(2, Math.floor(bitmap.width * scale / 2) * 2);
   const h = Math.max(2, Math.floor(bitmap.height * scale / 2) * 2);
   const nextSize = `${w}x${h}`;
   if (!encoder || size !== nextSize) {
    try { encoder?.close(); } catch { /* Already closed. */ }
    frames.clear(); serial++; size = nextSize; force = true;
    canvas = new scope.OffscreenCanvas(w, h); context = canvas.getContext('2d', { alpha: false });
    const config = { codec: 'avc1.420028', width: w, height: h, bitrate: 1_000_000, framerate: 10, latencyMode: 'realtime', avc: { format: 'annexb' } };
    if (!(await scope.VideoEncoder.isConfigSupported(config)).supported) throw new Error('H.264 encoder unavailable');
    if (closed) return false;
    const configuration = serial;
    encoder = new scope.VideoEncoder({
     output(chunk: any) {
      const info = frames.get(chunk.timestamp); frames.delete(chunk.timestamp);
      if (!info || closed) return;
      const encoded = new Uint8Array(chunk.byteLength); chunk.copyTo(encoded);
      let binary = '';
      for (let at = 0; at < encoded.length; at += 8192) binary += String.fromCharCode(...encoded.subarray(at, at + 8192));
      report({ ...info, codec: 'avc1.420028', key: chunk.type === 'key', timestamp: chunk.timestamp, data: scope.btoa(binary) });
     },
     error(error: any) { if (configuration === serial) report({ error: String(error?.message ?? error) }); },
    });
    encoder.configure(config);
   }
   context.drawImage(bitmap, 0, 0, w, h);
   if (frames.size >= 32) { frames.clear(); force = true; }
   const keyFrame = force || Date.now() - lastKey >= 2000;
   if (keyFrame) lastKey = Date.now();
   force = false;
   timestamp = Math.max(timestamp + 1, Math.round(scope.performance.now() * 1000));
   frames.set(timestamp, { width, height, streamId: `${stream}-${serial}` });
   const frame = new scope.VideoFrame(canvas, { timestamp });
   try { encoder.encode(frame, { keyFrame }); } finally { frame.close(); }
   lastImage = data; lastSent = Date.now();
   return true;
  } catch (error: any) { report({ error: String(error?.message ?? error) }); throw error; }
  finally { bitmap?.close(); busy = false; }
 };
 scope[name] = { push, requestKeyframe() { force = true; return last ? push(last.data, last.width, last.height) : Promise.resolve(false); }, dispose };
 return true;
}

/** Bridge renderer WebCodecs through CDP; bounded work, no external encoder executable. */
export async function createRemoteVideoEncoder(session: Session, output: (chunk: RemoteVideoChunk) => void, failed: (error: Error) => void): Promise<RemoteVideoEncoder> {
 const id = randomUUID().replace(/-/g, ''), binding = `__ai_video_${id}`, name = `${binding}_encoder`;
 let outputSerial = 0, outputTimer: ReturnType<typeof setTimeout> | undefined;
 let closed = false, contextId: number | undefined, installing: Promise<void> | undefined, busy = false, installation = 0;
 const send = async (method: string, params: object) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([session.client.send(method, params, session.sessionId), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Video encoder timed out')), 5000); })]); }
  finally { clearTimeout(timer); }
 };
 const evaluate = async (expression: string) => {
  const response = await send('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true, silent: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? 'Video encoder failed');
  return response.result?.value;
 };
 const tracked = async (action: () => Promise<any>) => {
  const serial = outputSerial, queued = await action();
  if (queued && serial === outputSerial && !closed && !outputTimer) {
   outputTimer = setTimeout(() => { outputTimer = undefined; if (!closed) failed(new Error('Video encoder produced no frames')); }, 5000);
  }
 };
 const install = async () => {
  const { frameTree } = await send('Page.getFrameTree', {});
  const world = await send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: name });
  contextId = world.executionContextId;
  await send('Runtime.addBinding', { name: binding, executionContextId: contextId });
  const ready = await evaluate(`(${installEncoder.toString()})(${JSON.stringify(binding)},${JSON.stringify(name)},${JSON.stringify(`${id}-${++installation}`)})`);
  if (!ready) throw new Error('WebCodecs is unavailable for this page');
  if (closed) {
   await evaluate(`globalThis[${JSON.stringify(name)}]?.dispose()`);
   await send('Runtime.removeBinding', { name: binding });
  }
 };
 const ensure = async () => {
  if (closed) return;
  if (contextId !== undefined) return;
  installing ??= install().finally(() => { installing = undefined; });
  await installing;
 };
 const listener = session.client.on('Runtime.bindingCalled', (event, from) => {
  if (closed || from !== session.sessionId || event.name !== binding || event.executionContextId !== contextId) return;
  try {
   if (typeof event.payload !== 'string' || event.payload.length > 2_000_000) throw new Error('Invalid video packet');
   const value = JSON.parse(event.payload);
   if (value.error) throw new Error(String(value.error));
   if (value.codec !== 'avc1.420028' || typeof value.streamId !== 'string' || value.streamId.length > 100 || typeof value.key !== 'boolean' || !Number.isSafeInteger(value.timestamp) || value.timestamp < 0 || typeof value.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data) || !Number.isFinite(value.width) || value.width <= 0 || value.width > 32000 || !Number.isFinite(value.height) || value.height <= 0 || value.height > 32000) throw new Error('Invalid video packet');
   outputSerial++; clearTimeout(outputTimer); outputTimer = undefined;
   output(value);
  } catch (error) { failed(error instanceof Error ? error : new Error(String(error))); }
 });
 const destroyed = session.client.on('Runtime.executionContextDestroyed', (event, from) => {
  if (from === session.sessionId && event.executionContextId === contextId) contextId = undefined;
 });
 const cleared = session.client.on('Runtime.executionContextsCleared', (_, from) => { if (from === session.sessionId) contextId = undefined; });
 const dispose = () => {
  if (closed) return;
  closed = true; clearTimeout(outputTimer); listener.dispose(); destroyed.dispose(); cleared.dispose();
  if (contextId !== undefined) void evaluate(`globalThis[${JSON.stringify(name)}]?.dispose()`).catch(() => {});
  void send('Runtime.removeBinding', { name: binding }).catch(() => {});
 };
 try { await ensure(); } catch (error) { dispose(); throw error; }
 return {
  async push(data, width, height) {
   if (closed || busy) return;
   busy = true;
   try {
    await ensure();
    if (!closed) {
     try { await tracked(() => evaluate(`globalThis[${JSON.stringify(name)}].push(${JSON.stringify(data)},${JSON.stringify(width)},${JSON.stringify(height)})`)); }
     catch (error) {
      if (closed || contextId !== undefined) throw error;
      await ensure();
      if (!closed) await tracked(() => evaluate(`globalThis[${JSON.stringify(name)}].push(${JSON.stringify(data)},${JSON.stringify(width)},${JSON.stringify(height)})`));
     }
    }
   } finally { busy = false; }
  },
  requestKeyframe() { if (!closed && contextId !== undefined) void tracked(() => evaluate(`globalThis[${JSON.stringify(name)}]?.requestKeyframe()`)).catch(error => failed(error)); },
  dispose,
 };
}
