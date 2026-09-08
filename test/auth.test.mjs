import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as path from 'node:path';
import { chromium } from 'playwright-core';
import { BrowserProxy } from './.bundles/proxy-bundle.mjs';
import { Uri } from './vscode-mock.mjs';
import { findChromium } from './chromium.mjs';

// The editor's webview is a different site from its framed proxy page. A top-level page
// alone cannot reproduce Chromium rejecting SameSite cookies inside that frame.
const requests = [];
const app = http.createServer((req, res) => {
	if (req.url === '/') {
		res.setHeader('content-type', 'text/html');
		res.end('<!doctype html><html><head></head><body><script src="/app.js"></script></body></html>');
	} else if (req.url === '/app.js') {
		res.setHeader('content-type', 'text/javascript');
		res.end(`window.signIn = async (omit = false) => {
			const origin = 'http://localhost:${app.address().port}';
			const { csrfToken } = await (await fetch(origin + '/api/auth/csrf')).json();
			const response = await fetch(origin + '/api/auth/callback', {
				method: 'POST', credentials: omit ? 'omit' : 'same-origin',
				body: new URLSearchParams({ csrfToken })
			});
			return response.status;
		};`);
	} else if (req.url === '/api/auth/csrf') {
		res.setHeader('content-type', 'application/json');
		res.setHeader('set-cookie', 'authjs.csrf-token=fixture-token; HttpOnly; SameSite=Lax; Path=/');
		res.end(JSON.stringify({ csrfToken: 'fixture-token' }));
	} else if (req.url === '/api/auth/callback') {
		let body = '';
		req.on('data', chunk => { body += chunk; });
		req.on('end', () => {
			const hasCookie = req.headers.cookie?.split(';').some(c => c.trim() === 'authjs.csrf-token=fixture-token');
			requests.push({ hasCookie: !!hasCookie, origin: req.headers.origin });
			const valid = hasCookie && req.headers.origin === `http://localhost:${app.address().port}`
				&& new URLSearchParams(body).get('csrfToken') === 'fixture-token';
			res.writeHead(valid ? 200 : 403);
			res.end(valid ? 'signed in' : 'invalid CSRF');
		});
	} else { res.writeHead(404); res.end(); }
});
const parent = http.createServer((_req, res) => {
	res.setHeader('content-type', 'text/html');
	res.end('<!doctype html><iframe sandbox="allow-scripts allow-forms allow-same-origin"></iframe>');
});
const proxy = new BrowserProxy(Uri.file(path.resolve(import.meta.dirname, '..')));
let browser;
try {
	await new Promise(r => app.listen(0, '127.0.0.1', r));
	await new Promise(r => parent.listen(0, '127.0.0.1', r));
	const executablePath = findChromium();
	assert.ok(executablePath, 'Chromium is required for the embedded authentication test');
	browser = await chromium.launch({ executablePath, args: ['--site-per-process'] });
	const url = await proxy.getProxiedUrl(`http://localhost:${app.address().port}/`);
	for (const embedded of [false, true]) {
		const context = await browser.newContext();
		try {
			const page = await context.newPage();
			if (embedded) {
				await page.goto(`http://localhost:${parent.address().port}/`);
				await page.locator('iframe').evaluate((frame, url) => { frame.src = url; }, url);
			} else { await page.goto(url); }
			const frame = embedded ? await page.waitForEvent('framenavigated', {
				predicate: frame => frame.url() === url,
			}).catch(() => page.frames().find(frame => frame.url() === url)) : page.mainFrame();
			await frame.waitForFunction(() => typeof window.signIn === 'function');
			const status = await frame.evaluate(() => window.signIn());
			assert.equal(status, 200, `${embedded ? 'cross-site iframe' : 'top-level'} CSRF login: ${JSON.stringify(requests.at(-1))}`);
			assert.equal(await frame.evaluate(() => document.cookie.includes('authjs.csrf-token')), false,
				'HttpOnly cookie must remain unreadable to the page');
			assert.equal(await frame.evaluate(() => window.signIn(true)), 403, 'credentials: omit stays unauthenticated');
			console.log(`PASS ${embedded ? 'cross-site iframe' : 'top-level'} CSRF login and HttpOnly/omit behavior`);
		} finally { await context.close(); }
	}
} finally {
	await browser?.close();
	proxy.dispose();
	app.close();
	parent.close();
}
