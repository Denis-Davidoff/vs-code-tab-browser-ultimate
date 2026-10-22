import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { negotiateChromeChatCapabilities, readChromeChatCapabilities } from './chromeChatCompatibility.ts';

test('feature negotiation chooses the highest shared version independently for each contract', () => {
  const selected = negotiateChromeChatCapabilities({ chat: [1], annotations: [2, 3], screenshots: [99], future: [1] }, 2,
    { chat: [1, 2], annotations: [1, 2], screenshots: [1] });
  assert.deepEqual(selected, { chat: 1, annotations: 2 });
});

test('transport-v2 clients without a map retain their original feature contracts', () => {
  const baseline = readChromeChatCapabilities(undefined, 2);
  assert.equal(baseline.chat[0], 1);
  assert.equal(baseline.git, undefined);
  assert.equal(baseline.usage, undefined);
  assert.deepEqual(negotiateChromeChatCapabilities(undefined, 2), Object.fromEntries(Object.keys(baseline).map(k => [k, 1])));
  assert.deepEqual(negotiateChromeChatCapabilities(undefined, 1), {});
  assert.deepEqual(negotiateChromeChatCapabilities({}, 2), {});
});

test('malformed or excessive capability declarations fail closed', () => {
  for (const input of ['{bad', [], { chat: [-1] }, { chat: ['1'] }, { chat: [1.5] }, { chat: Array(17).fill(1) }, ' '.repeat(4097)]) {
    assert.deepEqual(negotiateChromeChatCapabilities(input, 2), {});
  }
  assert.equal(negotiateChromeChatCapabilities(JSON.stringify({ chat: [1] }), 2).chat, 1);
});
