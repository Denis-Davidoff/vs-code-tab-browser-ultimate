import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { formatRecordingSeconds, minRecordingBytes, readRecordingSeconds, recordingByteLimit } from './recordingQuality.ts';

test('the maximum length is whole seconds from 10 s to 1 h, 5 min when unreadable', () => {
	assert.equal(readRecordingSeconds(undefined), 300);
	assert.equal(readRecordingSeconds('abc'), 300);
	assert.equal(readRecordingSeconds(Number.NaN), 300);
	assert.equal(readRecordingSeconds(2), 10);
	assert.equal(readRecordingSeconds(99999), 3600);
	assert.equal(readRecordingSeconds(90.4), 90);
	assert.equal(readRecordingSeconds('45'), 45);
});

test('the size limit follows the length and the bitrate, never below 256 MB', () => {
	assert.equal(recordingByteLimit(10, 6_000_000), minRecordingBytes);
	assert.equal(recordingByteLimit(3600, 12_000_000), Math.ceil(12_000_000 / 8 * 3600 * 1.5));
});

test('a limit is named the way the settings show it', () => {
	assert.equal(formatRecordingSeconds(300), '5 min');
	assert.equal(formatRecordingSeconds(3600), '1 h');
	assert.equal(formatRecordingSeconds(45), '45 s');
	assert.equal(formatRecordingSeconds(90), '1 min 30 s');
});
