/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Runs before `vsce package` in this folder. It copies the icon from the real extension and
// then checks the three things that would otherwise only be discovered after the listing is
// live — every one of them is silent at package time.

import { readFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(here);

const stub = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const real = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const problems = [];

// 1. The two builds are separate extensions with separate ids, so their versions do not
// interact at all — nothing auto-updates across them. Keeping the numbers equal is a
// convention, not a safety rule: it makes the listing say which release it describes. A
// mismatch is reported and nothing more.
if (stub.version !== real.version) {
	console.warn(`prepare: note — listing is ${stub.version}, the extension it describes is ${real.version}`);
}

// 2. A proposal in the manifest is what keeps an extension out of the Marketplace in the first
// place. This build exists precisely because it declares none.
if (stub.enabledApiProposals) {
	problems.push('enabledApiProposals is set — the Marketplace will not take this build');
}

// 3. Relative image paths. vsce rewrites them against the package root, which is this folder,
// so `![](demo.png)` would resolve to a file at the repository root and render as a broken
// image in the listing. Absolute https URLs are the only form that survives.
const readme = readFileSync(join(here, 'README.md'), 'utf8');
// Html comments hold the video slot's ready-made snippets, which are inert until someone
// uncomments them. Checking them would report the template as a mistake.
const rendered = readme.replace(/<!--[\s\S]*?-->/g, '');
// Every form an image can take, because checking one of them is the same as checking none:
// Markdown inline, an HTML `<img>` (Markdown allows raw html, and vsce rewrites its `src` the
// same way), and a reference definition, whose `![alt][id]` use site carries no url at all.
//
// **A definition is only an image's when an image uses it.** Reference definitions are shared by
// links and images, so checking all of them turned an ordinary `[guide]: ./guide.md` into
// `readme image "./guide.md" is not an absolute https URL` — and since `prepare` gates `package`
// and `publish`, a perfectly good readme edit blocked the release. So the ids an image actually
// refers to are collected first, and only those definitions are looked at.
const imageIds = new Set();
// `![alt][id]`, and the collapsed `![id][]` where the label is the id.
for (const match of rendered.matchAll(/!\[([^\]]*)\]\[([^\]]*)\]/g)) {
	imageIds.add((match[2] || match[1]).trim().toLowerCase());
}
// The shortcut `![id]`, which is neither inline nor a full reference.
for (const match of rendered.matchAll(/!\[([^\]]+)\](?![[(])/g)) {
	imageIds.add(match[1].trim().toLowerCase());
}
const definitions = new Map();
for (const match of rendered.matchAll(/^[ \t]*\[([^\]]+)\]:[ \t]*<?([^\s>]+)/gm)) {
	definitions.set(match[1].trim().toLowerCase(), match[2]);
}

const imageSources = [
	...[...rendered.matchAll(/!\[[^\]]*\]\(\s*<?([^)>\s]+)/g)].map(m => m[1]),
	...[...rendered.matchAll(/<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]),
	...[...imageIds].map(id => definitions.get(id)).filter(source => source !== undefined),
];
for (const source of imageSources) {
	if (!source.startsWith('https://')) {
		problems.push(`readme image "${source}" is not an absolute https URL`);
	}
}

// 4. The Marketplace strips iframes and <video> from a readme, so an embed renders as nothing
// at all. A video has to be a still image linking out.
if (/<iframe|<video/i.test(rendered)) {
	problems.push('readme contains an <iframe> or <video> — the Marketplace strips both');
}

const iconSource = join(root, real.icon);
const iconTarget = join(here, stub.icon);
if (!existsSync(iconSource)) {
	problems.push(`icon ${real.icon} is missing from the real extension`);
} else {
	mkdirSync(dirname(iconTarget), { recursive: true });
	copyFileSync(iconSource, iconTarget);
}

if (problems.length) {
	console.error('prepare: failed\n' + problems.map(p => `  - ${p}`).join('\n'));
	process.exit(1);
}

if (readme.includes('VIDEO SLOT')) {
	console.warn('prepare: note — the video slot in README.md is still commented out');
}

console.log(`prepare: ok — ${stub.name} ${stub.version}, icon copied from ${real.icon}`);
