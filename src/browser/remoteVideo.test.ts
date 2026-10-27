import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createContext, runInContext } from 'node:vm';
import { createRemoteVideoEncoder } from './remoteVideo.ts';

function fixture(supported = true, producesFrames = true) {
 const listeners = new Map<string, (params: any, session?: string) => void>();
 const encoded: any[] = [], chunks: any[] = [], errors: Error[] = [], calls: string[] = [];
 let clock = 10000, contextId = 1, closedFrames = 0;
 const world: any = createContext({
  Uint8Array, Blob, atob, btoa, Date: { now: () => clock }, performance: { now: () => clock },
  createImageBitmap: async () => ({ width: 1600, height: 1000, close() {} }),
  OffscreenCanvas: class { width: number; height: number; constructor(width: number, height: number) { this.width=width;this.height=height; } getContext() { return { drawImage() {} }; } },
  VideoFrame: class { timestamp: number; constructor(_: unknown, options: { timestamp: number }) { this.timestamp = options.timestamp; } close() { closedFrames++; } },
  VideoEncoder: class {
   static async isConfigSupported(config: any) { return { supported, config }; }
   encodeQueueSize = 0; state = 'unconfigured';
   private readonly callbacks:any; constructor(callbacks: any) { this.callbacks=callbacks; }
   configure(config: any) { encoded.push({ config }); this.state = 'configured'; }
   encode(frame: any, options: any) {
    encoded.push({ timestamp: frame.timestamp, ...options });
    if (!producesFrames) return;
    this.callbacks.output({ timestamp: frame.timestamp, type: options.keyFrame ? 'key' : 'delta', byteLength: 4, copyTo(bytes: Uint8Array) { bytes.set([0, 0, 0, 1]); } });
   }
   close() { this.state = 'closed'; }
  },
 });
 const session = { sessionId: 'page', client: {
  on(method: string, callback: any) { listeners.set(method, callback); return { dispose() { listeners.delete(method); } }; },
  async send(method: string, params: any) {
   calls.push(method);
   if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
   if (method === 'Page.createIsolatedWorld') return { executionContextId: contextId };
   if (method === 'Runtime.addBinding') world[params.name] = (payload: string) => listeners.get('Runtime.bindingCalled')?.({ name: params.name, executionContextId: contextId, payload }, 'page');
   if (method === 'Runtime.evaluate') {
    try { return { result: { value: await runInContext(params.expression, world) } }; }
    catch (error) { return { exceptionDetails: { text: String(error) } }; }
   }
   return {};
  },
 } };
 return { session, encoded, chunks, errors, calls, listeners, framesClosed: () => closedFrames,
  advance(ms: number) { clock += ms; },
  navigate() { listeners.get('Runtime.executionContextsCleared')?.({}, 'page'); contextId++; },
  create: () => createRemoteVideoEncoder(session, chunk => chunks.push(chunk), error => errors.push(error)),
 };
}

test('H.264 encoder uses Annex B, bounds resolution and keeps original pointer dimensions', async () => {
 const f = fixture(), encoder = await f.create();
 await encoder.push('AAAA', 1600, 1000);
 assert.equal(f.chunks.length, 1); assert.equal(f.chunks[0].codec, 'avc1.420028'); assert.equal(f.chunks[0].key, true);
 assert.equal(f.chunks[0].width, 1600); assert.equal(f.chunks[0].height, 1000);
 assert.equal(f.encoded[0].config.avc.format, 'annexb'); assert.equal(f.encoded[0].config.width, 1440);
 assert.equal(f.encoded[0].config.bitrate, 1_000_000); assert.equal(f.framesClosed(), 1);
 encoder.dispose(); assert.equal(f.listeners.size, 0);
});

test('unchanged images are suppressed and a joining viewer can request a new keyframe', async () => {
 const f = fixture(), encoder = await f.create();
 await encoder.push('AAAA', 1600, 1000); await encoder.push('AAAA', 1600, 1000); assert.equal(f.chunks.length, 1);
 f.advance(100); await encoder.push('BBBB', 1600, 1000); assert.equal(f.chunks.at(-1).key, false);
 encoder.requestKeyframe(); await new Promise(resolve => setImmediate(resolve));
 assert.equal(f.chunks.at(-1).key, true); assert.equal(f.chunks.length, 3);
 f.advance(16_000); await encoder.push('BBBB', 1600, 1000); assert.equal(f.chunks.length, 4);
 encoder.dispose();
});

test('navigation creates a new isolated encoder stream and unsupported encoding cleans up', async () => {
 const f = fixture(), encoder = await f.create(); await encoder.push('AAAA', 1600, 1000);
 const first = f.chunks[0].streamId;
 f.navigate(); await encoder.push('AAAA', 1600, 1000);
 assert.notEqual(f.chunks.at(-1).streamId, first); assert.equal(f.chunks.at(-1).key, true);
 encoder.dispose(); const before = f.chunks.length; await encoder.push('BBBB', 1600, 1000); assert.equal(f.chunks.length, before);
 const unavailable = fixture(false);
 // Capability is checked on the first image, when the actual dimensions are known.
 const unsupported = await unavailable.create(); await assert.rejects(unsupported.push('AAAA', 1600, 1000));
 assert.equal(unavailable.errors.length, 1); unsupported.dispose(); assert.equal(unavailable.listeners.size, 0);
});


test('a supported encoder that produces no output triggers fallback instead of a permanent blank screen', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const f = fixture(true, false), encoder = await f.create();
 try {
  await encoder.push('AAAA', 1600, 1000); assert.equal(f.errors.length, 0);
  t.mock.timers.tick(5001); assert.equal(f.errors.length, 1); assert.match(f.errors[0].message, /no frames/);
 } finally { encoder.dispose(); }
});
