/*---------------------------------------------------------------------------------------------
 *  What the panel's tab shows: the icon a page declares, put on disk because a panel's
 *  `iconPath` can only be a local file, and — for pages no injected script reaches — the title,
 *  read out of the same html.
 *
 *  Anything that is not actually an image is thrown away: a dev server answers `/favicon.ico`
 *  with its index page rather than a 404 often enough that the bytes have to be checked.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { getConfiguration, hostnameOf, parseHttpUrl } from './browserProxy';

const maxIconBytes = 512 * 1024;
const requestTimeout = 5000;
const maxRedirects = 3;
/** Icons are keyed by content, so a stale one is only wasted space. */
const keepIconsFor = 7 * 24 * 60 * 60 * 1000;

interface ImageType {
	readonly extension: string;
	readonly matches: (bytes: Buffer) => boolean;
}

const imageTypes: readonly ImageType[] = [
	{ extension: 'png', matches: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
	{ extension: 'ico', matches: b => b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02) && b[3] === 0x00 },
	{ extension: 'gif', matches: b => b.subarray(0, 3).toString('latin1') === 'GIF' },
	{ extension: 'jpg', matches: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
	{ extension: 'webp', matches: b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
	{ extension: 'svg', matches: b => /^\s*(<\?xml[\s\S]{0,200}?)?<svg[\s>]/i.test(b.subarray(0, 400).toString('utf8')) },
];

/** Downloads `href` and returns a file the editor can use as a tab icon. */
export async function fetchIcon(href: string): Promise<vscode.Uri | undefined> {
	try {
		const bytes = href.startsWith('data:') ? decodeDataUrl(href) : await download(href);
		if (!bytes?.length) {
			return undefined;
		}

		const type = imageTypes.find(candidate => candidate.matches(bytes));
		if (!type) {
			return undefined;
		}

		return await store(bytes, type.extension);
	} catch {
		// A page without a reachable icon simply keeps the default one.
		return undefined;
	}
}

export interface DiscoveredPage {
	/** The icon the page declares, absolute; absent when it declares none. */
	readonly iconHref?: string;
	readonly title?: string;
}

/**
 * Reads what the tab needs — the declared icon and the title — straight out of a page's html.
 * Only needed for pages that are not served through the proxy, where no injected script can
 * report either, and read in one request because both come from the same head.
 */
export async function discoverPage(pageUrl: string): Promise<DiscoveredPage | undefined> {
	try {
		const bytes = await download(pageUrl, maxRedirects, 'text/html,*/*;q=0.8');
		const html = bytes?.subarray(0, 256 * 1024).toString('utf8');
		if (!html) {
			return undefined;
		}

		return { iconHref: findIconHref(html, pageUrl), title: findTitle(html) };
	} catch {
		return undefined;
	}
}

/** The page's `<title>`, with the handful of entities a title realistically carries decoded. */
function findTitle(html: string): string | undefined {
	const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	const title = match?.[1]
		?.replace(/&(lt|gt|amp|quot|#39|apos|nbsp);/gi, entity => ({
			lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'", apos: "'", nbsp: ' ',
		}[entity.slice(1, -1).toLowerCase()] ?? entity))
		.replace(/\s+/g, ' ')
		.trim();
	return title || undefined;
}

function findIconHref(html: string, pageUrl: string): string | undefined {
	try {
		let fallback: string | undefined;
		for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
			const rel = /\brel\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
			const relation = (rel?.[2] ?? rel?.[3] ?? rel?.[4] ?? '').toLowerCase();
			if (!/(^|\s)(shortcut\s+icon|icon|apple-touch-icon(-precomposed)?)(\s|$)/.test(relation)) {
				continue;
			}

			const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
			const value = (href?.[2] ?? href?.[3] ?? href?.[4] ?? '').trim();
			if (!value) {
				continue;
			}

			const resolved = value.startsWith('data:') ? value : new URL(value, pageUrl).toString();
			if (!relation.includes('apple-touch-icon')) {
				return resolved;
			}
			fallback ??= resolved;
		}

		return fallback;
	} catch {
		return undefined;
	}
}

/** The url a page's icon sits at when the page does not say, i.e. `/favicon.ico`. */
export function defaultIconUrl(pageUrl: string): string | undefined {
	const url = parseHttpUrl(pageUrl);
	return url ? `${url.origin}/favicon.ico` : undefined;
}

function decodeDataUrl(href: string): Buffer | undefined {
	const match = /^data:([^,;]*)(;base64)?,(.*)$/s.exec(href);
	if (!match) {
		return undefined;
	}
	const [, , base64, data] = match;
	const bytes = base64
		? Buffer.from(data, 'base64')
		: Buffer.from(decodeURIComponent(data), 'utf8');
	return bytes.length <= maxIconBytes ? bytes : undefined;
}

function download(
	href: string,
	redirectsLeft = maxRedirects,
	accept = 'image/*,*/*;q=0.8',
): Promise<Buffer | undefined> {
	const url = parseHttpUrl(href);
	if (!url) {
		return Promise.resolve(undefined);
	}

	const transport = url.protocol === 'https:' ? https : http;

	return new Promise(resolve => {
		const request = transport.get({
			protocol: url.protocol,
			hostname: hostnameOf(url),
			port: url.port || (url.protocol === 'https:' ? 443 : 80),
			path: url.pathname + url.search,
			headers: { accept, host: url.host },
			rejectUnauthorized: !getConfiguration().get<boolean>('proxy.ignoreCertificateErrors', true),
			timeout: requestTimeout,
			setHost: false,
		}, response => {
			const status = response.statusCode ?? 0;
			const location = response.headers.location;

			if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
				response.resume();
				// A `Location` a browser would refuse too. Parsing it here rather than in the
				// next call is the point: this runs in node's own response handler, where a
				// throw is an uncaught exception in the extension host and leaves this promise
				// unsettled — the caller of an icon download waiting for good.
				let next: string | undefined;
				try {
					next = new URL(location, url).toString();
				} catch {
					next = undefined;
				}
				resolve(next ? download(next, redirectsLeft - 1, accept) : undefined);
				return;
			}

			if (status !== 200) {
				response.resume();
				resolve(undefined);
				return;
			}

			const chunks: Buffer[] = [];
			let size = 0;
			response.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > maxIconBytes) {
					request.destroy();
					resolve(undefined);
					return;
				}
				chunks.push(chunk);
			});
			response.on('end', () => resolve(Buffer.concat(chunks)));
			response.on('error', () => resolve(undefined));
		});

		request.on('timeout', () => request.destroy());
		request.on('error', () => resolve(undefined));
	});
}

async function store(bytes: Buffer, extension: string): Promise<vscode.Uri> {
	const directory = path.join(os.tmpdir(), 'tab-browser-ultimate', 'icons');
	await fs.mkdir(directory, { recursive: true });
	await pruneOldIcons(directory);

	// Naming by content means the same icon keeps the same path, and a changed one gets a new
	// path, which is what makes the editor repaint the tab.
	const name = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 16);
	const file = path.join(directory, `${name}.${extension}`);

	try {
		await fs.access(file);
	} catch {
		await fs.writeFile(file, bytes);
	}

	return vscode.Uri.file(file);
}

async function pruneOldIcons(directory: string): Promise<void> {
	try {
		const cutoff = Date.now() - keepIconsFor;
		for (const entry of await fs.readdir(directory)) {
			const file = path.join(directory, entry);
			const stat = await fs.stat(file);
			if (stat.mtimeMs < cutoff) {
				await fs.rm(file, { force: true });
			}
		}
	} catch {
		// Housekeeping only.
	}
}
