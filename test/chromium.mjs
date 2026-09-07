import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { chromium } from 'playwright-core';

/** Uses whichever chromium build is already on this machine. */
export function findChromium() {
	try {
		const fromPlaywright = chromium.executablePath();
		if (fromPlaywright && fsSync.existsSync(fromPlaywright)) {
			return fromPlaywright;
		}
	} catch {
		// Playwright has no browser of its own installed.
	}

	const caches = [
		path.join(process.env.HOME ?? '', 'Library/Caches/ms-playwright'),
		path.join(process.env.HOME ?? '', '.cache/ms-playwright'),
	];
	for (const cache of caches.filter(c => fsSync.existsSync(c))) {
		const revisions = fsSync.readdirSync(cache)
			.filter(entry => entry.startsWith('chromium-'))
			.sort()
			.reverse();
		for (const revision of revisions) {
			for (const candidate of [
				'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
				'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
				'chrome-linux/chrome',
			]) {
				const full = path.join(cache, revision, candidate);
				if (fsSync.existsSync(full)) {
					return full;
				}
			}
		}
	}

	const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
	return fsSync.existsSync(chrome) ? chrome : undefined;
}
