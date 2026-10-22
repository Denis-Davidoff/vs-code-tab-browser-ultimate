import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { overlayBounds, fitOverlay } from './overlayPosition.ts';

test('right-aligned branch popups cannot extend past the left edge of a narrow Chrome panel', () => {
  const bounds = overlayBounds({ left: 0, top: 60, right: 320, bottom: 700 }, { left: 0, top: 0, right: 320, bottom: 700 }, 8);
  assert.deepEqual(fitOverlay(bounds, -120, 400, 304, 220), { left: 8, top: 400 });
  assert.deepEqual(fitOverlay(bounds, 290, 600, 304, 220), { left: 8, top: 412 });
});

test('all four edges respect the visible viewport even when the app extends beyond it', () => {
  const bounds = overlayBounds({ left: -20, top: 40, right: 600, bottom: 900 }, { left: 0, top: 100, right: 360, bottom: 500 }, 8);
  assert.deepEqual(bounds, { left: 28, top: 68, right: 372, bottom: 452, width: 344, height: 384 });
  assert.deepEqual(fitOverlay(bounds, 500, -200, 200, 100), { left: 172, top: 68 });
});

test('oversized overlays fit after their scrollable dimensions are limited to available space', () => {
  const bounds = overlayBounds({ left: 0, top: 0, right: 180, bottom: 140 }, { left: 0, top: 0, right: 180, bottom: 140 }, 8);
  assert.deepEqual(fitOverlay(bounds, -100, 130, bounds.width, bounds.height), { left: 8, top: 8 });
});
