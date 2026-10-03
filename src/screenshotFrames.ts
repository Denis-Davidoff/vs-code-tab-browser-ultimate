/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How a screenshot for a *model* is cut into frames. Leaf module, under test.
 *
 * The limits are the model's, not the browser's. Claude takes an image in
 * unchanged up to 1568 px on the long edge and about 1.15 megapixels; anything
 * larger is scaled down on arrival. A full page as one image therefore arrives
 * as a strip too narrow to read — a 1280 × 10 000 page fits the long edge only
 * at 200 px wide — so a full page is cut into frames that each fit, and the
 * model reads them in order.
 *
 * Token cost follows pixels (about width × height / 750), never bytes, so the
 * JPEG quality only decides size on the wire and the 5 MB per-image ceiling.
 */

export const modelFrameLimits = {
	maxEdge: 1568,
	maxPixels: 1_150_000,
	/** About 9 000 tokens for the whole set; the rest of a longer page is reported as clipped. */
	maxFrames: 6,
} as const;

/**
 * Maximum. Tokens follow pixels, so quality costs only bytes: measured on a page
 * of 14 px text at 1440 × 798, 100 is about 750 KB a frame against 480 KB at 90 —
 * far inside the 5 MB per-image ceiling, and the edges of small text stay clean.
 */
export const modelJpegQuality = 100;

export interface Rect { x: number; y: number; width: number; height: number }

/**
 * How CSS pixels map onto what `Page.captureScreenshot` works in, read from
 * `Page.getLayoutMetrics` rather than from the page.
 */
export interface PixelRatios {
	/** CSS px → DIP: browser zoom, `cssVisualViewport.zoom`. */
	zoom: number;
	/** CSS px → device px: zoom × device scale factor. */
	device: number;
}

/**
 * The ratios from a `Page.getLayoutMetrics` reply.
 *
 * **Not `window.devicePixelRatio`**: that is the page's to redefine — a getter
 * answering 0.001 asks for frames a thousand times too large, and one returning
 * a promise that never settles holds the capture for good. The deprecated
 * `visualViewport` is in device pixels and `cssVisualViewport` in CSS pixels,
 * so their widths give the device ratio with no page script involved. Without
 * the deprecated half the device scale factor is taken as 1, which can only make
 * a frame smaller than planned, never larger.
 */
export function pixelRatios(metrics: {
	cssVisualViewport?: { clientWidth?: number; zoom?: number };
	visualViewport?: { clientWidth?: number };
}): PixelRatios {
	const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
	const zoom = positive(metrics.cssVisualViewport?.zoom) ? metrics.cssVisualViewport.zoom : 1;
	const css = metrics.cssVisualViewport?.clientWidth;
	const device = metrics.visualViewport?.clientWidth;
	return { zoom, device: positive(css) && positive(device) ? device / css : zoom };
}

export interface Frame {
	/** What the frame covers on the page, in CSS pixels. */
	rect: Rect;
	/** What `Page.captureScreenshot` is given — in DIP, which is CSS × zoom. */
	clip: Rect & { scale: number };
	/** The image that comes back. */
	pixels: { width: number; height: number };
}

/**
 * Two conversions, both measured in Chrome. **The clip is in DIP, not CSS
 * pixels** (`Page.Viewport` in the protocol), so at 200% browser zoom a CSS
 * rectangle passed as it is covers half the area at half the offset — a
 * scrolled viewport came back as the wrong part of the page. And **`scale`
 * multiplies with the device scale factor**: a 1280 × 800 clip at scale 1 is a
 * 2560 × 1600 image on a retina screen. Output is CSS × scale × device ratio,
 * so the scale asked for is the wanted factor divided by that ratio.
 */
function frame(rect: Rect, factor: number, ratios: PixelRatios): Frame {
	const { zoom, device } = ratios;
	return {
		rect,
		clip: {
			x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom,
			scale: factor / device,
		},
		pixels: { width: Math.round(rect.width * factor), height: Math.round(rect.height * factor) },
	};
}

/** The visible area as one frame, scaled down only as far as it has to be. */
export function planViewport(viewport: Rect, ratios: PixelRatios, limits = modelFrameLimits): Frame {
	const { width, height } = viewport;
	const factor = Math.min(1,
		limits.maxEdge / width,
		limits.maxEdge / height,
		Math.sqrt(limits.maxPixels / (width * height)));
	return frame(viewport, factor, ratios);
}

/** One frame of a full page: a band of the single capture, not a capture of its own. */
export interface Band {
	/** What the frame covers on the page, in CSS pixels. */
	rect: Rect;
	/** Its rows in the captured image. */
	top: number;
	pixels: { width: number; height: number };
}

/**
 * The whole page as one capture from the top, to be cut into frames that each
 * fit the limits at full width.
 *
 * One capture rather than one per frame, because each `captureBeyondViewport`
 * capture makes the page lay itself out again — measured as one `resize` event
 * per frame — and a page that moves between them (a slideshow, a canvas drawn
 * on `requestAnimationFrame`) comes back as frames from different moments.
 *
 * The width is scaled to the long-edge limit at most, and each frame is then as
 * tall as the pixel budget allows at that width — 898 px for a 1280 px page, so
 * nothing in it is scaled again on arrival. Bands are rounded edge to edge, so
 * they tile the image with no gap and no overlap.
 */
export function planFullPage(
	page: { width: number; height: number },
	ratios: PixelRatios,
	limits = modelFrameLimits,
): { clip: Rect & { scale: number }; bands: Band[]; covered: number } {
	const width = Math.ceil(page.width);
	const height = Math.ceil(page.height);
	const factor = Math.min(1, limits.maxEdge / width);
	const frameHeight = Math.min(limits.maxEdge, Math.floor(limits.maxPixels / (width * factor)));
	const step = Math.max(1, Math.floor(frameHeight / factor));
	const pixelWidth = Math.round(width * factor);

	const bands: Band[] = [];
	for (let y = 0; y < height && bands.length < limits.maxFrames; y += step) {
		const bottom = Math.min(y + step, height);
		const top = Math.round(y * factor);
		bands.push({
			rect: { x: 0, y, width, height: bottom - y },
			top,
			pixels: { width: pixelWidth, height: Math.round(bottom * factor) - top },
		});
	}
	const covered = bands.length ? bands[bands.length - 1].rect.y + bands[bands.length - 1].rect.height : 0;
	return { clip: frame({ x: 0, y: 0, width, height: covered }, factor, ratios).clip, bands: withoutEmpty(bands), covered };
}

/**
 * The bands laid onto the image Chromium actually returned.
 *
 * The plan rounds `covered × factor` itself, and under a fractional zoom or
 * device ratio Chromium can round the output a pixel the other way. Cutting by
 * the plan then drifts a row per band, reports a width the JPEG does not have,
 * or asks for a band past the last row. So each band's edges are scaled from
 * its CSS edges onto the real height, and the real width is reported.
 */
export function fitBands(bands: readonly Band[], covered: number, image: { width: number; height: number }): Band[] {
	const last = bands[bands.length - 1];
	if (!last || covered <= 0) {
		return [];
	}
	if (last.top + last.pixels.height === image.height && last.pixels.width === image.width) {
		return [...bands];
	}
	const edge = (y: number) => Math.round((y / covered) * image.height);
	return withoutEmpty(bands.map(band => {
		const top = edge(band.rect.y);
		return { rect: band.rect, top, pixels: { width: image.width, height: edge(band.rect.y + band.rect.height) - top } };
	}));
}

/**
 * Folds a band with no rows into the one before it.
 *
 * Rounding can leave one: a 1920 × 898 page scales by 0.8167 into frames of
 * 897 CSS px, and the last CSS pixel rounds to no image row at all — and asking
 * for a band of zero rows failed the whole screenshot. The CSS edge moves to the
 * band before, which loses nothing, since there was no row to lose.
 */
function withoutEmpty(bands: Band[]): Band[] {
	const out: Band[] = [];
	for (const band of bands) {
		const previous = out[out.length - 1];
		if (band.pixels.height > 0 || !previous) {
			out.push(band);
		} else {
			out[out.length - 1] = {
				...previous,
				rect: { ...previous.rect, height: band.rect.y + band.rect.height - previous.rect.y },
			};
		}
	}
	return out;
}
