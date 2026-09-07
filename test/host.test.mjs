/*---------------------------------------------------------------------------------------------
 *  Picks an element in a real browser with the page script and formats it the way the copy menu
 *  does, then checks how the page's icon is found and stored for the tab. Skipped when no
 *  chromium build can be found on this machine.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { chromium } from 'playwright-core';
import { findChromium } from './chromium.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');

let failures = 0;
function check(name, ok, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
	if (!ok) { failures++; }
}

/** Settings the stubbed `workspace.getConfiguration` hands out; empty means "use the default". */
const settings = {};
/** The terminal link provider, captured when the module under test registers it. */
let terminalLinkProvider;

// The extension host side of the copy menu, with `vscode` stubbed out.
globalThis.__vscodeStub = {
	l10n: { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, i) => args[i]) },
	Uri: { joinPath: () => ({}), parse: value => ({ value }), file: value => ({ fsPath: value, scheme: 'file' }) },
	ViewColumn: { Active: 1 },
	EventEmitter: class { constructor() { this.event = () => ({ dispose() { } }); } fire() { } dispose() { } },
	Disposable: class { dispose() { } },
	env: { clipboard: { writeText: async () => { } } },
	workspace: {
		getConfiguration: () => ({ get: (key, fallback) => (key in settings ? settings[key] : fallback) }),
	},
	commands: { executeCommand: () => { } },
	window: {
		showInformationMessage: () => { }, showErrorMessage: () => { },
		registerTerminalLinkProvider: provider => {
			terminalLinkProvider = provider;
			return { dispose() { } };
		},
	},
	ExternalUriOpenerPriority: {},
	UIKind: {},
};

const { formatPickedElement } = await import('./.bundles/view-bundle.mjs');
const { defaultIconUrl, discoverIconUrl, fetchIcon } = await import('./.bundles/favicon-bundle.mjs');
const { registerTerminalLinks } = await import('./.bundles/terminal-links-bundle.mjs');

/** A 1x1 png, the smallest thing that has to be recognised as an image. */
const pngBytes = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64');

const page_html = `<!DOCTYPE html>
<html><head>
<link rel="apple-touch-icon" sizes="180x180" href="/apple.png">
<link rel="icon" sizes="16x16" href="/small.png">
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<style>
	*, ::before, ::after { box-sizing: border-box; border: 0 solid; margin: 0; padding: 0; }
	button, input, select, textarea { font: inherit; color: inherit; }
	.app { font-family: Inter, sans-serif; font-size: 14px; color: rgb(17, 17, 17); --brand: #415aa3; }
	.card { padding: 8px; }
	.field-input { display: inline-block; width: 384px; padding: 4px 11px; border-radius: 6px;
		border: 1px solid var(--brand); background: #f2f2f2; transition: all 0.2s; }
	.field-input:hover { border-color: #000000; }
	@media (min-width: 1px) { .field-input { min-width: 0; } }
	@media (min-width: 99999px) { .field-input { color: red; } }
</style></head>
<body><div class="app"><div class="card"><form class="form"><div class="row">
	<input id="email" class="field-input outlined" type="text" placeholder="mail" style="letter-spacing: 0.2px">
</div></form></div></div>
<div style="position: absolute; right: 0; top: 200px">
	<button class="first-of-the-two-buttons">a</button
	><button class="edge-target-primary-action with-another-long-class-name">b</button>
</div></body></html>`;

const server = http.createServer((req, res) => {
	if (req.url === '/icon.png') {
		res.writeHead(200, { 'content-type': 'image/png' });
		res.end(pngBytes);
		return;
	}
	// A dev server that answers everything with its index page, `/favicon.ico` included.
	if (req.url === '/favicon.ico') {
		res.writeHead(200, { 'content-type': 'text/html' });
		res.end('<!DOCTYPE html><html><body>not an icon</body></html>');
		return;
	}
	if (req.url === '/declares-icon') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(`<!DOCTYPE html><html><head>
			<link rel="apple-touch-icon" href="/apple.png">
			<link rel="shortcut icon" href="icon.png?v=2"></head><body></body></html>`);
		return;
	}
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
	res.end(page_html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/page`;

const executablePath = findChromium();
if (!executablePath) {
	console.log('SKIP  host test: no chromium build found');
	server.close();
	process.exit(0);
}

const browser = await chromium.launch({ executablePath });
let element;
let iconHref;
let overlay;
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
	await page.goto(pageUrl);
	for (const bundle of ['page-bundle.js', 'page-icon-bundle.js', 'picker-bundle.js']) {
		await page.addScriptTag({
			content: await fs.readFile(path.join(projectRoot, 'test/.bundles', bundle), 'utf8'),
		});
	}
	element = await page.evaluate(url => {
		const target = document.getElementById('email');
		return tabBrowserPage.describeElement(target, [], url);
	}, pageUrl);
	iconHref = await page.evaluate(() => tabBrowserPageIcon.findIconHref());

	// Hovering the element that sits against the right edge, with the picker running.
	await page.evaluate(() => {
		window.__picker = new tabBrowserPicker.ElementPicker({
			onHover: () => { }, onPick: () => { }, onCancel: () => { }, documentUrl: () => location.href,
		});
		window.__picker.enable([]);
	});
	const target = await page.locator('.edge-target-primary-action').boundingBox();
	await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
	await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

	overlay = await page.evaluate(() => {
		const root = document.querySelector('[data-tab-browser="picker"]');
		const label = root.shadowRoot.lastElementChild;
		const box = label.getBoundingClientRect();
		return {
			text: label.textContent,
			right: box.right, height: box.height, width: box.width,
			fontSize: getComputedStyle(label).fontSize,
			viewportWidth: window.innerWidth,
			scrollWidth: document.documentElement.scrollWidth,
			inTopLayer: root.matches(':popover-open'),
			bodyWidth: document.body.getBoundingClientRect().width,
		};
	});
} finally {
	await browser.close();
}

// -- what the page reported ------------------------------------------------------------------

check('descriptor names the element with every class',
	element.descriptor === 'input#email.field-input.outlined', element.descriptor);

check('html path starts below body and ends at the element',
	element.htmlPath.join(' > ') === 'div.app > div.card > form.form > div.row > input#email.field-input.outlined',
	element.htmlPath.join(' > '));

check('outer html is the markup of the element',
	element.outerHtml.startsWith('<input id="email"') && element.outerHtml.includes('placeholder="mail"'),
	element.outerHtml);

check('dimensions come from the rendered box',
	element.rect.width === 384 && element.rect.height > 0 && element.rect.left > 0,
	JSON.stringify(element.rect));

const styles = element.styles;
const selectors = styles.matched.map(rule => rule.selector);

check('the inline style attribute is reported first',
	styles.matched[0]?.selector === 'element.style'
	&& styles.matched[0].declarations.includes('letter-spacing: 0.2px'),
	JSON.stringify(styles.matched[0]));

check('rules matching the element are collected in cascade order',
	selectors.includes('*, ::before, ::after')
	&& selectors.includes('button, input, select, textarea')
	&& selectors.includes('.field-input')
	&& selectors.indexOf('*, ::before, ::after') < selectors.indexOf('.field-input'),
	selectors.join(' | '));

check('a rule behind a pseudo class the element is not in still shows',
	selectors.includes('.field-input:hover'), selectors.join(' | '));

const mediaRule = styles.matched.find(rule => rule.conditions?.length);
check('an applying media query is kept, with its condition',
	mediaRule?.declarations.includes('min-width: 0') && mediaRule.conditions[0] === '@media (min-width: 1px)',
	JSON.stringify(mediaRule));

check('a media query that does not apply is dropped',
	!styles.matched.some(rule => rule.conditions?.some(condition => condition.includes('99999'))),
	JSON.stringify(styles.matched.map(rule => rule.conditions)));

check('shorthands survive as the page wrote them',
	styles.matched.some(rule => /(^|; )padding: 4px 11px/.test(rule.declarations)),
	styles.matched.map(rule => rule.declarations).join(' | '));

const inherited = styles.inherited.find(rule => rule.selector === '.app');
check('inheritable declarations of an ancestor are reported',
	!!inherited && inherited.from === 'div.app'
	&& inherited.declarations.includes('font-family')
	&& !inherited.declarations.includes('--brand'),
	JSON.stringify(inherited));

const resolved = new Map(styles.resolved.map(entry => [entry.property, entry]));
check('resolved values lead with what the page declares',
	resolved.get('padding')?.value === '4px 11px' && !resolved.get('padding')?.fromUserAgent,
	JSON.stringify(styles.resolved.slice(0, 8)));

check('resolved values include the layout of the element',
	resolved.get('width')?.value === '384px' && resolved.get('display')?.value === 'inline-block',
	JSON.stringify([resolved.get('width'), resolved.get('display')]));

check('a value nothing on the page sets is marked as coming from the browser',
	resolved.get('cursor')?.fromUserAgent === true, JSON.stringify(resolved.get('cursor')));

check('custom properties the rules reference are resolved',
	styles.variables.some(variable => variable.property === '--brand' && variable.value.includes('415aa3')),
	JSON.stringify(styles.variables));

// -- what the clipboard gets -----------------------------------------------------------------

const report = formatPickedElement(element, 'context');
const sections = ['Attached Element Context from Integrated Browser', 'Element: input#email',
	'URL: ' + pageUrl, 'HTML Path: div.app', 'Outer HTML:', '```html', 'Dimensions:', '- width: 384px',
	'CSS:', '```css', '/* Inherited */', '/* Resolved values */', '/* CSS variables */'];

let cursor = -1;
let ordered = true;
for (const section of sections) {
	const index = report.indexOf(section);
	if (index <= cursor) {
		ordered = false;
		console.log(`      missing or out of order: ${section}`);
	}
	cursor = index;
}
check('the report carries every section, in order', ordered);

check('the report ends the css fence', report.trimEnd().endsWith('```'), report.slice(-40));

check('xpath format still writes a single line',
	!formatPickedElement(element, 'xpath').includes('\n')
	&& formatPickedElement(element, 'xpath').includes('@id="email"'),
	formatPickedElement(element, 'xpath'));

// -- the picker's overlay ---------------------------------------------------------------------

check('the label of an element at the right edge stays inside the viewport',
	overlay.right <= overlay.viewportWidth, JSON.stringify(overlay));

check('the overlay never widens the page',
	overlay.scrollWidth <= overlay.viewportWidth, JSON.stringify(overlay));

check('a long path wraps instead of running off',
	overlay.height > 16 && overlay.width <= 360, JSON.stringify(overlay));

// Clipping alone would keep the label inside by squeezing it into a sliver at the edge.
check('the label is moved left rather than squeezed against the edge',
	overlay.width >= 120, JSON.stringify(overlay));

check('the label text is 8.8px', overlay.fontSize === '8.8px', overlay.fontSize);

check('the overlay sits in the top layer, above anything the page can stack',
	overlay.inTopLayer === true, JSON.stringify(overlay));

// -- the page's icon -------------------------------------------------------------------------

check('a scalable icon wins over the bitmaps a page also offers',
	iconHref === `${new URL(pageUrl).origin}/icon.svg`, iconHref);

const icon = await fetchIcon(`${new URL(pageUrl).origin}/icon.png`);
check('a real image is stored as a file the editor can show',
	icon?.scheme === 'file' && icon.fsPath.endsWith('.png') && (await fs.stat(icon.fsPath)).size === pngBytes.length,
	JSON.stringify(icon));

check('the same icon keeps the same file',
	(await fetchIcon(`${new URL(pageUrl).origin}/icon.png`))?.fsPath === icon?.fsPath);

check('a page answering /favicon.ico with html gets no icon',
	await fetchIcon(defaultIconUrl(pageUrl)) === undefined);

check('an icon that is not there at all gets no icon',
	await fetchIcon(`${new URL(pageUrl).origin}/missing.png`) === undefined);

check('the icon a page declares is found in its html, relative urls included',
	await discoverIconUrl(`${new URL(pageUrl).origin}/declares-icon`)
	=== `${new URL(pageUrl).origin}/icon.png?v=2`,
	await discoverIconUrl(`${new URL(pageUrl).origin}/declares-icon`));

// -- terminal links --------------------------------------------------------------------------

const opened = [];
registerTerminalLinks(url => opened.push(url));
const linksOn = line => terminalLinkProvider.provideTerminalLinks({ line }, undefined);

const viteLine = '  \u279c  Local:   http://localhost:5173/';
const [viteLink] = linksOn(viteLine);
check('the url a dev server prints becomes a link, and only the url',
	viteLink && viteLine.slice(viteLink.startIndex, viteLink.startIndex + viteLink.length)
	=== 'http://localhost:5173/',
	JSON.stringify(viteLink));

check('activating the link opens it in the browser panel',
	(terminalLinkProvider.handleTerminalLink(viteLink),
		opened[0] === 'http://localhost:5173/'), JSON.stringify(opened));

check('punctuation around a url is left out of it',
	linksOn('serving (http://127.0.0.1:3000/app), press q to quit.')[0]?.length
	=== 'http://127.0.0.1:3000/app'.length,
	JSON.stringify(linksOn('serving (http://127.0.0.1:3000/app), press q to quit.')));

check('a link to somewhere else is left to the editor by default',
	linksOn('read https://example.com/docs for more').length === 0);

settings['terminalLinks.mode'] = 'always';
check('mode "always" takes those too',
	linksOn('read https://example.com/docs for more')[0]?.length === 'https://example.com/docs'.length,
	JSON.stringify(linksOn('read https://example.com/docs for more')));

settings['terminalLinks.mode'] = 'never';
check('mode "never" hands every url back to the editor',
	linksOn(viteLine).length === 0);
delete settings['terminalLinks.mode'];

server.close();

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
