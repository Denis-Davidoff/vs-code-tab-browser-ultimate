/*---------------------------------------------------------------------------------------------
 *  Finds the icon the page declares, so the editor tab can show it.
 *
 *  A page usually offers several: the tab needs one small icon, so a scalable one wins over a
 *  bitmap, and among bitmaps the one closest to the size the tab draws at.
 *--------------------------------------------------------------------------------------------*/

/** The size the editor draws a tab icon at; icons are scored by how close they come to it. */
const wantedSize = 32;

const iconRelations = /(^|\s)(shortcut\s+icon|icon|apple-touch-icon(-precomposed)?|mask-icon)(\s|$)/i;

export function findIconHref(): string | undefined {
	const links = Array.prototype.slice.call(
		document.querySelectorAll('link[rel][href]')) as HTMLLinkElement[];

	let best: { href: string; score: number } | undefined;
	for (const link of links) {
		if (!iconRelations.test(link.getAttribute('rel') ?? '')) {
			continue;
		}
		const href = link.href;
		if (!href) {
			continue;
		}
		const score = scoreIcon(link, href);
		if (!best || score > best.score) {
			best = { href, score };
		}
	}

	return best?.href;
}

function scoreIcon(link: HTMLLinkElement, href: string): number {
	const type = (link.getAttribute('type') ?? '').toLowerCase();
	const extension = extensionOf(href);

	// Anything vector draws cleanly at whatever size the tab uses.
	if (type.includes('svg') || extension === 'svg') {
		return 100;
	}

	let score = extension === 'ico' || type.includes('icon') ? 40 : 60;

	// `apple-touch-icon` is a launcher image; it works, but it is the last resort.
	if (/apple-touch-icon/i.test(link.getAttribute('rel') ?? '')) {
		score -= 30;
	}

	const size = largestSize(link.getAttribute('sizes'));
	if (size) {
		// 32px is ideal, 16px and 180px are both further away from it.
		score += Math.max(0, 20 - Math.abs(size - wantedSize) / 8);
	}

	return score;
}

function largestSize(sizes: string | null): number | undefined {
	if (!sizes || /any/i.test(sizes)) {
		return undefined;
	}
	let largest: number | undefined;
	for (const part of sizes.split(/\s+/)) {
		const width = parseInt(part.split(/x/i)[0], 10);
		if (!isNaN(width) && (largest === undefined || width > largest)) {
			largest = width;
		}
	}
	return largest;
}

function extensionOf(href: string): string {
	try {
		const pathname = new URL(href, location.href).pathname;
		return (pathname.split('.').pop() ?? '').toLowerCase();
	} catch {
		return '';
	}
}
