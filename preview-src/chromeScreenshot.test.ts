import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('side-panel screenshots have the literal all-URLs grant required by captureVisibleTab', () => {
  const manifest = JSON.parse(readFileSync('chrome-extension/manifest.json', 'utf8'));
  // A click in a side panel does not grant activeTab. HTTP and HTTPS wildcards
  // permit script injection but do not satisfy captureVisibleTab's permission check.
  assert.ok(manifest.host_permissions.includes('<all_urls>'));
});
