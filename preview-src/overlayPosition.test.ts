import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { overlayBounds, fitOverlay, anchoredOverlay } from './overlayPosition.ts';

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

const mobileBounds = overlayBounds({ left: 0, top: 0, right: 360, bottom: 720 },
  { left: 0, top: 0, right: 360, bottom: 720 }, 8);
test('usage stays above its button when loading content grows, without crossing the footer', () => {
  const anchor = { left: 300, right: 328, top: 630, bottom: 658 };
  const loading = anchoredOverlay(mobileBounds, anchor, 270, 30, 'right');
  const loaded = anchoredOverlay(mobileBounds, anchor, 270, 900, 'right');
  assert.equal(loading.top + loading.maxHeight, 624);
  assert.equal(loaded.top + loaded.maxHeight, 624);
  assert.equal(loaded.top, 8);
});
test('top anchors open below, and keyboard viewport limits both edges', () => {
  const bounds = overlayBounds({ left: 0, top: 0, right: 360, bottom: 720 },
    { left: 0, top: 0, right: 360, bottom: 300 }, 8);
  const result = anchoredOverlay(bounds, { left: 330, right: 358, top: 20, bottom: 48 }, 270, 400, 'left');
  assert.equal(result.top, 54);
  assert.equal(result.left, 82);
  assert.equal(result.top + result.maxHeight, 292);
});
test('a CSS capped menu keeps the measured height used for positioning', () => {
  const result = anchoredOverlay(mobileBounds, { left: 20, right: 48, top: 630, bottom: 658 }, 270, 400, 'left');
  assert.equal(result.maxHeight, 400);
  assert.equal(result.top, 224);
});
