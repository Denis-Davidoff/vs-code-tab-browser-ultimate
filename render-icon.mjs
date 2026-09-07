/*---------------------------------------------------------------------------------------------
 *  Renders `media/icon.svg` to the png the manifest points at.
 *
 *  The svg is the source: edit that, then run `npm run icon`. Chromium does the rasterising
 *  because it is already here for the tests, and because it renders the same svg the browser
 *  would.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from './test/chromium.mjs';

const size = Number(process.argv[2] ?? 256);
const source = path.join(import.meta.dirname, 'media/icon.svg');
const target = path.join(import.meta.dirname, 'media/icon.png');

const executablePath = findChromium();
if (!executablePath) {
	console.error('No chromium build found; the icon cannot be rendered here.');
	process.exit(1);
}

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
await page.setContent(`<style>html,body{margin:0;padding:0;background:transparent}`
	+ `svg{display:block;width:${size}px;height:${size}px}</style>${await fs.readFile(source, 'utf8')}`);
await page.screenshot({ path: target, omitBackground: true });
await browser.close();

console.log(`media/icon.png rendered at ${size}px`);
