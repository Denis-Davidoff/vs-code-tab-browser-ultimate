import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

function fixture() {
 const decoders: any[] = [], shown: any[] = [], painted: unknown[] = [];
 let failures = 0, closed = 0;
 const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (...args: unknown[]) => painted.push(args) }) };
 class Decoder {
  decodeQueueSize = 0; state = 'unconfigured'; calls: any[] = [];
  callbacks: any;
  constructor(callbacks: any) { this.callbacks = callbacks; decoders.push(this); }
  static async isConfigSupported() { return { supported: true }; }
  configure() { this.state = 'configured'; }
  decode(chunk: any) { this.calls.push(chunk); }
  close() { this.state = 'closed'; }
 }
 const exports: any = {};
 const source = readFileSync('exchange-server/apps/web/app/components/preview-video.ts', 'utf8');
 runInNewContext(transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText, {
  exports, VideoDecoder: Decoder, EncodedVideoChunk: class { constructor(value: any) { Object.assign(this, value); } },
  Uint8Array, Blob, atob, createImageBitmap: async () => ({ width: 640, height: 480, close() { closed++; } }),
 });
 const preview = exports.createPreviewVideo(() => canvas, (packet: any) => shown.push(packet), () => failures++);
 const packet = (timestamp: number, key = true, streamId = 'stream-1') => ({ tabId: 'a', codec: 'avc1.420028', streamId, key, timestamp, data: 'AAAAAQ==', width: 1600, height: 1000 });
 const output = (decoder: any, timestamp: number) => decoder.callbacks.output({ timestamp, displayWidth: 1440, displayHeight: 900, close() { closed++; } });
 return { preview, decoders, shown, painted, packet, output, canvas, failures: () => failures, closed: () => closed, supports: exports.supportsPreviewVideo };
}

test('decoder waits for a keyframe and preserves the logical viewport for input mapping', async () => {
 const f = fixture(); assert.equal(await f.supports(), true);
 f.preview.video(f.packet(1, false)); assert.equal(f.decoders.length, 0);
 f.preview.video(f.packet(2)); f.output(f.decoders[0], 2);
 assert.equal(f.canvas.width, 1440); assert.equal(f.canvas.height, 900);
 assert.equal(f.shown[0].width, 1600); assert.equal(f.shown[0].height, 1000);
 assert.equal(f.closed(), 1); assert.equal(f.failures(), 0);
});

test('navigation and a slow decoder discard obsolete work and wait for a fresh keyframe', () => {
 const f = fixture(); f.preview.video(f.packet(1)); const first = f.decoders[0];
 f.preview.video(f.packet(2, false, 'stream-2')); assert.equal(first.state, 'closed');
 f.output(first, 1); assert.equal(f.shown.length, 0);
 f.preview.video(f.packet(3, true, 'stream-2')); const second = f.decoders[1];
 second.decodeQueueSize = 5; f.preview.video(f.packet(4, false, 'stream-2')); assert.equal(second.state, 'closed');
 f.preview.video(f.packet(5, true, 'stream-2')); assert.equal(f.decoders.length, 3);
 f.output(f.decoders[2], 5); assert.equal(f.shown.length, 1);
});

test('decoding errors request JPEG fallback, and JPEG uses the same canvas', async () => {
 const f = fixture(); f.preview.video(f.packet(1)); f.decoders[0].callbacks.error(new Error('codec failed'));
 assert.equal(f.failures(), 1); assert.equal(f.decoders[0].state, 'closed');
 await f.preview.jpeg({ tabId: 'a', data: 'AAAAAQ==', width: 640, height: 480 });
 assert.equal(f.canvas.width, 640); assert.equal(f.shown.length, 1);
 f.preview.video({ ...f.packet(2), width: -1 }); assert.equal(f.failures(), 2);
 f.preview.dispose();
});
