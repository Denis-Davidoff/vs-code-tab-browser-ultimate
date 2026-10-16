/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { suite, test } from 'node:test';
import { fitBands, modelFrameLimits, pixelRatios, planFullPage, planViewport } from './screenshotFrames.ts';

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

	test('a short page is one band, covered whole, captured once at CSS size', () => {
		const { clip, bands, covered } = planFullPage({ width: 1280, height: 600 }, retina);
		assert.strictEqual(bands.length, 1);
		assert.strictEqual(covered, 600);
		assert.deepStrictEqual(bands[0].pixels, { width: 1280, height: 600 });
		assert.deepStrictEqual(clip, { x: 0, y: 0, width: 1280, height: 600, scale: 0.5 });
	});

	test('bands tile the page and the image with no gap and no overlap', () => {
		for (const [width, height, ratios] of [[1280, 3000, plain], [1440, 11975, retina], [4000, 5000, plain], [987, 4321, { zoom: 1.25, device: 2.5 }]] as const) {
			const { clip, bands, covered } = planFullPage({ width, height }, ratios);
			let y = 0, top = 0;
			for (const b of bands) {
				assert.strictEqual(b.rect.y, y);
				assert.strictEqual(b.top, top);
				assert.ok(within(b.pixels), JSON.stringify(b.pixels));
				y += b.rect.height;
				top += b.pixels.height;
			}
			assert.strictEqual(y, covered);
			// The single capture is exactly as tall as the bands put together.
			assert.strictEqual(top, Math.round(clip.height / ratios.zoom * (clip.scale * ratios.device)));
		}
	});

	test('a long page stops at the frame cap', () => {
		const { bands, covered } = planFullPage({ width: 1280, height: 40_000 }, retina);
		assert.strictEqual(bands.length, modelFrameLimits.maxFrames);
		assert.ok(covered < 40_000);
	});

	test('a page exactly as tall as the cap covers is covered whole', () => {
		// 1 150 000 / 1280 px wide = 898 px a frame.
		const height = 898 * modelFrameLimits.maxFrames;
		const { bands, covered } = planFullPage({ width: 1280, height }, plain);
		assert.strictEqual(bands.length, modelFrameLimits.maxFrames);
		assert.strictEqual(covered, height);
	});

	test('a narrow page gets bands as tall as the long edge allows', () => {
		const { clip, bands } = planFullPage({ width: 400, height: 5000 }, { zoom: 1, device: 3 });
		assert.strictEqual(bands[0].pixels.height, modelFrameLimits.maxEdge);
		assert.strictEqual(clip.scale, 1 / 3);
	});

	test('under zoom the one clip is in DIP', () => {
		const { clip, covered } = planFullPage({ width: 640, height: 6000 }, { zoom: 2, device: 4 });
		assert.deepStrictEqual(clip, { x: 0, y: 0, width: 1280, height: covered * 2, scale: 0.25 });
	});

	test('a last CSS pixel that rounds to no image row is folded into the band before', () => {
		// 1920 wide: factor 0.8167, frames of 897 CSS px — the 898th rounds to zero rows.
		const { bands, covered } = planFullPage({ width: 1920, height: 898 }, plain);
		assert.ok(bands.every(b => b.pixels.height > 0), JSON.stringify(bands));
		assert.strictEqual(bands[bands.length - 1].rect.y + bands[bands.length - 1].rect.height, covered);
		assert.strictEqual(bands.length, 1);
	});
});

suite('fitBands', () => {

	test('an image of exactly the planned size is cut exactly as planned', () => {
		const { bands, covered } = planFullPage({ width: 1440, height: 5000 }, retina);
		const last = bands[bands.length - 1];
		assert.deepStrictEqual(fitBands(bands, covered, { width: 1440, height: last.top + last.pixels.height }), bands);
	});

	test('an image a rounding pixel off is cut by its own size, edge to edge', () => {
		const { bands, covered } = planFullPage({ width: 987, height: 4321 }, { zoom: 1.25, device: 2.5 });
		const last = bands[bands.length - 1];
		for (const delta of [-1, 1]) {
			const image = { width: last.pixels.width + delta, height: last.top + last.pixels.height + delta };
			const fitted = fitBands(bands, covered, image);
			let top = 0;
			for (const b of fitted) {
				assert.strictEqual(b.top, top);
				assert.strictEqual(b.pixels.width, image.width);
				assert.ok(b.pixels.height > 0);
				top += b.pixels.height;
			}
			assert.strictEqual(top, image.height, `delta ${delta}`);
		}
	});

	test('nothing planned is nothing to cut', () => {
		assert.deepStrictEqual(fitBands([], 0, { width: 10, height: 10 }), []);
	});
});
