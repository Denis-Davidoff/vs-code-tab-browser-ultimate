/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { modelFrameLimits, pixelRatios, planFullPage, planViewport } from './screenshotFrames.ts';

const within = (pixels: { width: number; height: number }) =>
	pixels.width <= modelFrameLimits.maxEdge
	&& pixels.height <= modelFrameLimits.maxEdge
	&& pixels.width * pixels.height <= modelFrameLimits.maxPixels * 1.001;

const plain = { zoom: 1, device: 1 };
const retina = { zoom: 1, device: 2 };

suite('pixelRatios', () => {

	// Each case is a `Page.getLayoutMetrics` reply measured in Chrome.
	test('retina, no zoom', () => {
		assert.deepStrictEqual(pixelRatios({
			cssVisualViewport: { clientWidth: 1280, zoom: 1 }, visualViewport: { clientWidth: 2560 },
		}), { zoom: 1, device: 2 });
	});

	test('200% browser zoom on a retina screen', () => {
		assert.deepStrictEqual(pixelRatios({
			cssVisualViewport: { clientWidth: 640, zoom: 2 }, visualViewport: { clientWidth: 2560 },
		}), { zoom: 2, device: 4 });
	});

	test('without the deprecated half the device scale factor is taken as 1', () => {
		assert.deepStrictEqual(pixelRatios({ cssVisualViewport: { clientWidth: 640, zoom: 2 } }), { zoom: 2, device: 2 });
	});

	test('nonsense reads as 1', () => {
		assert.deepStrictEqual(pixelRatios({
			cssVisualViewport: { clientWidth: 0, zoom: NaN }, visualViewport: { clientWidth: -5 },
		}), plain);
		assert.deepStrictEqual(pixelRatios({}), plain);
	});
});

suite('planViewport', () => {

	test('a retina viewport comes back at CSS size, not device size', () => {
		const f = planViewport({ x: 0, y: 0, width: 1024, height: 700 }, retina);
		assert.strictEqual(f.clip.scale, 0.5);
		assert.deepStrictEqual(f.pixels, { width: 1024, height: 700 });
	});

	test('a large viewport is scaled into the pixel budget', () => {
		const f = planViewport({ x: 0, y: 0, width: 1920, height: 1080 }, plain);
		assert.ok(within(f.pixels), JSON.stringify(f.pixels));
		assert.ok(f.clip.scale < 1);
	});

	test('the scroll offset is kept, since a clip is in document coordinates', () => {
		const f = planViewport({ x: 0, y: 3000, width: 800, height: 600 }, plain);
		assert.strictEqual(f.clip.y, 3000);
		assert.strictEqual(f.rect.y, 3000);
	});

	test('under browser zoom the clip is in DIP and the image still at CSS size', () => {
		// Measured: 200% zoom, DSF 1, scrolled to 3500 CSS px. A CSS clip came
		// back as the wrong half of the page; this one is the visible area.
		const f = planViewport({ x: 0, y: 3500, width: 640, height: 356 }, { zoom: 2, device: 2 });
		assert.deepStrictEqual(f.clip, { x: 0, y: 7000, width: 1280, height: 712, scale: 0.5 });
		assert.deepStrictEqual(f.pixels, { width: 640, height: 356 });
		assert.deepStrictEqual(f.rect, { x: 0, y: 3500, width: 640, height: 356 });
	});
});

suite('planFullPage', () => {

	test('a short page is one frame, covered whole', () => {
		const { frames, covered } = planFullPage({ width: 1280, height: 600 }, retina);
		assert.strictEqual(frames.length, 1);
		assert.strictEqual(covered, 600);
		assert.deepStrictEqual(frames[0].pixels, { width: 1280, height: 600 });
	});

	test('frames tile the page from the top with no gap and no overlap', () => {
		const { frames, covered } = planFullPage({ width: 1280, height: 3000 }, plain);
		let y = 0;
		for (const f of frames) {
			assert.strictEqual(f.rect.y, y);
			assert.ok(within(f.pixels), JSON.stringify(f.pixels));
			y += f.rect.height;
		}
		assert.strictEqual(y, 3000);
		assert.strictEqual(covered, 3000);
	});

	test('a long page stops at the frame cap', () => {
		const { frames, covered } = planFullPage({ width: 1280, height: 40_000 }, retina);
		assert.strictEqual(frames.length, modelFrameLimits.maxFrames);
		assert.ok(covered < 40_000);
	});

	test('a page exactly as tall as the cap covers is covered whole', () => {
		// 1 150 000 / 1280 px wide = 898 px a frame.
		const height = 898 * modelFrameLimits.maxFrames;
		const { frames, covered } = planFullPage({ width: 1280, height }, plain);
		assert.strictEqual(frames.length, modelFrameLimits.maxFrames);
		assert.strictEqual(covered, height);
	});

	test('a very wide page is scaled to the long edge and stays within budget', () => {
		const { frames } = planFullPage({ width: 4000, height: 5000 }, plain);
		for (const f of frames) {
			assert.ok(within(f.pixels), JSON.stringify(f.pixels));
		}
	});

	test('a narrow page gets frames as tall as the long edge allows', () => {
		const { frames } = planFullPage({ width: 400, height: 5000 }, { zoom: 1, device: 3 });
		assert.strictEqual(frames[0].pixels.height, modelFrameLimits.maxEdge);
		assert.strictEqual(frames[0].clip.scale, 1 / 3);
	});

	test('under zoom every frame offset is in DIP', () => {
		const { frames } = planFullPage({ width: 640, height: 6000 }, { zoom: 2, device: 4 });
		for (const f of frames) {
			assert.strictEqual(f.clip.y, f.rect.y * 2);
			assert.strictEqual(f.clip.height, f.rect.height * 2);
		}
	});
});
