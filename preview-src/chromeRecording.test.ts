import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInNewContext } from 'node:vm';
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript';
import { chromeChatAttachmentFeature } from '../src/chat/chromeChatCompatibility.ts';

function fixture() {
  const source = readFileSync('chrome-extension/sidepanel.ts', 'utf8');
  const ast = createSourceFile('sidepanel.ts', source, ScriptTarget.ES2022, true);
  const names = new Set(['attachFromChrome', 'chromeRecordingStatus', 'controlChromeRecording']);
  const functions = ast.statements.filter(node => isFunctionDeclaration(node) && names.has(node.name?.text ?? '')).map(node => node.getText(ast)).join('\n');
  const events: any[] = [], files: any[] = [], recorders: any[] = [];
  const track = { stopped: false, onended: undefined as (() => void) | undefined, stop() { this.stopped = true; } };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  let clock = 0, choices = 0;
  class Recorder {
    state = 'inactive'; mimeType = 'video/webm';
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    constructor() { recorders.push(this); }
    start() { this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    stop() {
      assert.notEqual(this.state, 'inactive'); this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['video']) });
      queueMicrotask(() => this.onstop?.());
    }
  }
  const context = createContext({ recording: undefined, recordingStarting: false, generation: 1, active: {}, latest: { chatId: 'chat-A' },
    supportsFeature: () => true, chromeChatAttachmentFeature,
    navigator: { mediaDevices: { async getDisplayMedia() { choices++; return stream; } } },
    MediaRecorder: Recorder, Blob, Date: { now: () => clock },
    emit: (message: unknown) => events.push(message), showFeedback: () => {},
    async fileAttachment(...args: unknown[]) { files.push(args); },
    setTimeout: () => 1, setInterval: () => 2, clearTimeout() {}, clearInterval() {},
  });
  runInNewContext(transpileModule(functions, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context);
  const settled = async () => { for (let i = 0; i < 5; i++) { await Promise.resolve(); } };
  return { context: context as any, events, files, recorders, track, stream, choices: () => choices, time: (value: number) => { clock = value; }, settled };
}

test('the recording bar pauses, resumes and stops, then attaches video to its original conversation', async () => {
  const f = fixture(); await f.context.attachFromChrome('video');
  assert.equal(f.events.at(-1).state, 'recording');
  f.time(5000); f.context.controlChromeRecording('pause');
  assert.equal(f.events.at(-1).state, 'paused'); assert.equal(f.events.at(-1).seconds, 5);
  f.time(9000); f.context.chromeRecordingStatus(); assert.equal(f.events.at(-1).seconds, 5);
  f.context.controlChromeRecording('resume');
  f.time(11000); f.context.latest = { chatId: 'chat-B' };
  f.context.controlChromeRecording('stop'); await f.settled();
  assert.equal(f.track.stopped, true); assert.equal(f.files.length, 1); assert.equal(f.files[0][0], 'chat-A');
  assert.equal(f.files[0][3], 'recording.webm'); assert.equal(f.events.at(-1).state, undefined);
});

test('Chrome Stop sharing finishes the recording and releases the stream', async () => {
  const f = fixture(); await f.context.attachFromChrome('video');
  f.track.onended!(); await f.settled();
  assert.equal(f.track.stopped, true); assert.equal(f.files.length, 1);
  f.context.controlChromeRecording('stop'); assert.equal(f.files.length, 1, 'repeated Stop is harmless');
});

test('a pending screen chooser cannot start a stale or duplicate recording', async () => {
  const f = fixture(); let finish!: (stream: unknown) => void;
  f.context.navigator.mediaDevices.getDisplayMedia = () => new Promise(resolve => { finish = resolve; });
  const first = f.context.attachFromChrome('video');
  await f.context.attachFromChrome('video');
  f.context.generation++; finish(f.stream); await first;
  assert.equal(f.recorders.length, 0); assert.equal(f.track.stopped, true);
});

test('disconnect stops capture without attaching a stale video to a later connection', async () => {
  const f = fixture(); await f.context.attachFromChrome('video');
  f.context.generation++; f.context.controlChromeRecording('stop'); await f.settled();
  assert.equal(f.track.stopped, true); assert.equal(f.files.length, 0);
});
