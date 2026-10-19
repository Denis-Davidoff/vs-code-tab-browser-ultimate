import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ScriptTarget } from 'typescript';

test('recording notice shows elapsed time, pause state and adjacent controls', () => {
	const source = readFileSync('preview-src/chat.ts', 'utf8');
	const body = source.split("case 'recordingStatus': {")[1]?.split("case 'recording':")[0];
	assert.ok(body);
	const run = transpileModule(`(function () { ${body.slice(0, body.lastIndexOf('}'))} })();`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
	const paused = new Set<string>();
	const scope = {
		message: { state: 'recording' as string | undefined, seconds: 75 }, videoIsPaused: false,
		videoRecordingBar: { hidden: true, classList: { toggle: (key: string, value: boolean) => { if (value) { paused.add(key); } else { paused.delete(key); } } } },
		videoRecordingLabel: { textContent: '' }, videoPauseButton: { title: '', disabled: false, replaceChildren() {} },
		videoStopButton: { disabled: false }, icon: () => ({}),
	};
	runInNewContext(run, scope); assert.equal(scope.videoRecordingBar.hidden, false); assert.match(scope.videoRecordingLabel.textContent, /1:15/);
	scope.message.state = 'paused'; runInNewContext(run, scope);
	assert.equal(scope.videoIsPaused, true); assert.equal(scope.videoPauseButton.title, 'Resume video recording'); assert.ok(paused.has('paused'));
	scope.message.state = 'stopping'; runInNewContext(run, scope); assert.equal(scope.videoStopButton.disabled, true);
	scope.message.state = undefined; runInNewContext(run, scope); assert.equal(scope.videoRecordingBar.hidden, true);
});
