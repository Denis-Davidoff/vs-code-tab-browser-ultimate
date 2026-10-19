import { test } from 'node:test';
import * as assert from 'node:assert';
import { clock, parseHelperLine, tidyTranscript, voiceChipLabel, voicePromptText } from './voiceText.ts';

test('parseHelperLine reads every event and nothing else', () => {
	assert.deepStrictEqual(parseHelperLine('{"e":"ready","locale":"ru-RU"}'), { e: 'ready', locale: 'ru-RU' });
	assert.deepStrictEqual(parseHelperLine('{"e":"level","v":1.7,"t":3.25}'), { e: 'level', v: 1, t: 3.25 });
	assert.deepStrictEqual(parseHelperLine('{"e":"limit","t":300}'), { e: 'limit', t: 300 });
	assert.deepStrictEqual(parseHelperLine('{"e":"status","v":"downloading"}'), { e: 'status', v: 'downloading' });
	assert.deepStrictEqual(parseHelperLine('{"t":6.3,"e":"text","v":"Привет"}'), { e: 'text', v: 'Привет', t: 6.3 });
	assert.deepStrictEqual(parseHelperLine('{"e":"error","code":"denied","message":"no"}'), { e: 'error', code: 'denied', message: 'no' });
	assert.strictEqual(parseHelperLine('{"e":"status","v":"other"}'), undefined);
	assert.strictEqual(parseHelperLine('{"e":"level","v":"x","t":1}'), undefined);
	assert.strictEqual(parseHelperLine('not json'), undefined);
	assert.strictEqual(parseHelperLine('null'), undefined);
});

test('clock and the chip label', () => {
	assert.strictEqual(clock(0), '0:00');
	assert.strictEqual(clock(65.9), '1:05');
	assert.strictEqual(clock(300), '5:00');
	assert.strictEqual(voiceChipLabel('  Привет   мир ', 3), '0:03 · Привет мир');
	assert.strictEqual(voiceChipLabel('a'.repeat(40), 10), `0:10 · ${'a'.repeat(32)}…`);
});

test('the transcript is tidied and cut by code point', () => {
	assert.strictEqual(tidyTranscript('a\n\n b'), 'a b');
	const long = '😀'.repeat(20_001);
	const cut = tidyTranscript(long);
	assert.ok(cut.endsWith('…'));
	assert.strictEqual(Array.from(cut).length, 20_001);
	assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut));
});

test('the prompt says it is a transcript', () => {
	assert.strictEqual(voicePromptText('открой настройки', 12), 'Voice message from the user (0:12, transcribed on their device — it may contain recognition errors):\nоткрой настройки');
});
