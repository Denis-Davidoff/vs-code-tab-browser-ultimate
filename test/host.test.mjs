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
/** Listeners on `workspace.onDidChangeConfiguration`, so a test can change a setting for real. */
const configListeners = [];
const changeSetting = async (key, value) => {
	settings[key] = value;
	const event = { affectsConfiguration: section => `tabBrowser.${key}`.startsWith(section) };
	for (const listener of [...configListeners]) {
		await listener(event);
	}
};
/** Extensions the stub reports as installed, and the commands they contribute. */
const installedExtensions = new Set();
const contributedCommands = new Set();
/** Commands the code under test executed, newest last. */
const executed = [];
/** Commands the extension registered during activation. */
const registeredCommands = new Map();
/** Messages the code under test showed, and the button the test picks in them. */
const dialogs = [];
let dialogAnswer = '1. Write .mcp.json';
/** Workspace folders the stub reports; `undefined` stands for "no folder open". */
let workspaceFolders;
let clipboard = '';
/** The terminal link provider, captured when the module under test registers it. */
let terminalLinkProvider;
/** The sidebar's tree provider and the view id it was registered for. */
let treeProvider;
let treeViewId;

// The extension host side of the copy menu, with `vscode` stubbed out.
globalThis.__vscodeStub = {
	l10n: { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, i) => args[i]) },
	Uri: {
		joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts), scheme: 'file' }),
		parse: value => ({ value, toString: () => value }),
		file: value => ({ fsPath: value, scheme: 'file' }),
	},
	Disposable: class { constructor(fn) { this.dispose = fn ?? (() => { }); } },
	ViewColumn: { Active: 1 },
	EventEmitter: class { constructor() { this.event = () => ({ dispose() { } }); } fire() { } dispose() { } },
	Disposable: class { dispose() { } },
	env: { clipboard: { writeText: async text => { clipboard = text; } } },
	workspace: {
		getConfiguration: () => ({ get: (key, fallback) => (key in settings ? settings[key] : fallback) }),
		get workspaceFolders() { return workspaceFolders; },
		openTextDocument: async uri => ({ uri }),
		onDidChangeConfiguration: listener => {
			configListeners.push(listener);
			return { dispose() { configListeners.splice(configListeners.indexOf(listener), 1); } };
		},
		fs: {
			readFile: async uri => new Uint8Array(await fs.readFile(uri.fsPath)),
			writeFile: async (uri, bytes) => fs.writeFile(uri.fsPath, Buffer.from(bytes)),
		},
	},
	commands: {
		executeCommand: (...args) => { executed.push(args); },
		getCommands: async () => [...contributedCommands],
		registerCommand: (id, handler) => {
			registeredCommands.set(id, handler);
			return { dispose() { } };
		},
	},
	extensions: {
		getExtension: id => (installedExtensions.has(id) ? { id } : undefined),
		onDidChange: () => ({ dispose() { } }),
	},
	ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
	ThemeColor: class { constructor(id) { this.id = id; } },
	TreeItem: class { constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); } },
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	window: {
		// The connect command asks what to do; the test answers with `dialogAnswer`.
		showInformationMessage: (message, ...rest) => {
			dialogs.push(['info', message]);
			const actions = rest.filter(item => typeof item === 'string');
			return Promise.resolve(actions.find(action => action === dialogAnswer));
		},
		registerTerminalLinkProvider: provider => {
			terminalLinkProvider = provider;
			return { dispose() { } };
		},
		registerWebviewPanelSerializer: () => ({ dispose() { } }),
		registerTreeDataProvider: (id, provider) => {
			treeViewId = id;
			treeProvider = provider;
			return { dispose() { } };
		},
		// The proposed api is on the object but throws for an extension without the proposal.
		registerExternalUriOpener: () => {
			throw new Error("CANNOT use API proposal: externalUriOpener");
		},
		createWebviewPanel: () => { throw new Error('not used by this test'); },
		showTextDocument: async () => { },
		showWarningMessage: (...args) => { dialogs.push(['warning', args[0]]); },
		showErrorMessage: (...args) => { dialogs.push(['error', args[0]]); },
		tabGroups: { all: [], close: async () => { } },
	},
	ExternalUriOpenerPriority: {},
	UIKind: {},
};

const { formatPickedElement, formatConsoleReport } = await import('./.bundles/view-bundle.mjs');
const { defaultIconUrl, discoverPage, fetchIcon } = await import('./.bundles/favicon-bundle.mjs');
const { registerTerminalLinks } = await import('./.bundles/terminal-links-bundle.mjs');
const assistants = await import('./.bundles/assistants-bundle.mjs');
const { McpServer } = await import('./.bundles/mcp-bundle.mjs');
const { BrowserController } = await import('./.bundles/controller-bundle.mjs');
const { connectToClaudeCode, connectToCodex, codexEntryName } =
	await import('./.bundles/mcp-setup-bundle.mjs');
const { claudeClientState, codexClientState } = await import('./.bundles/mcp-check-bundle.mjs');
const { refreshedClaudeConfig, refreshedCodexConfig, refreshClientConfigs } =
	await import('./.bundles/mcp-refresh-bundle.mjs');

/** A 1x1 png, the smallest thing that has to be recognised as an image. */
const pngBytes = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64');

const agentScript = await fs.readFile(path.join(projectRoot, 'media/agent.js'), 'utf8');
const webviewScript = await fs.readFile(
	path.join(projectRoot, 'test/.bundles/webview-bundle.js'), 'utf8');

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
	/* Css nesting, which a page written this year uses instead of a preprocessor. */
	.row {
		gap: 4px;
		& .field-input { outline-color: rgb(1, 2, 3); }
		.outlined { outline-style: dashed; }
		@media (min-width: 1px) { & .field-input { outline-width: 2px; } }
	}
	.outlined {
		& .never-matches-anything { color: red; }
		/* Written after a nested rule, so the engine keeps it in a rule of its own. */
		text-decoration-thickness: 2px;
	}
	/* An ampersand inside a string nests nothing: the attribute value is what it says. */
	.row { & [data-tag="a&b"] { outline-offset: 3px; } }
</style></head>
<body><div class="app"><div class="card"><form class="form"><div class="row">
	<input id="email" class="field-input outlined" type="text" placeholder="mail" data-tag="a&amp;b" style="letter-spacing: 0.2px">
</div></form></div></div>
<p id="say&quot;hi&quot;" class="quoted-id">quoted</p>
<input id="secret" type="password" value="hunter2">
<select id="pick"><option value="a">A</option><option value="b">B</option></select>
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
			<title>Dashboard &amp;\n\t\tReports</title>
			<link rel="apple-touch-icon" href="/apple.png">
			<link rel="shortcut icon" href="icon.png?v=2"></head><body></body></html>`);
		return;
	}
	// The webview's own script, in a page that stands in for the panel: the settings element it
	// reads its token from, the controls it wires up, and a stub for the editor's api.
	if (req.url === '/webview') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(`<!DOCTYPE html><html><head><title>panel</title></head><body>
			<div id="tab-browser-settings" data-settings='${JSON.stringify({
			token: 'panel-token', url: 'http://127.0.0.1:1/', focusLockEnabled: false, preferAttributes: [],
		})}'></div>
			<div class="header">
				<input class="url-input">
				<button class="back-button"></button><button class="forward-button"></button>
				<button class="reload-button"></button><button class="open-external-button"></button>
				<button class="copy-action-button"><i class="codicon"></i></button>
				<button class="copy-menu-toggle"></button>
				<div class="copy-menu"><button class="copy-menu-item" data-command="element"
					data-icon="codicon-inspect"><span class="copy-menu-label">Copy element</span></button></div>
			</div>
			<div class="hint"><span class="hint-message"></span><span class="hint-detail"></span></div>
			<iframe></iframe>
			<script>
				window.__posted = [];
				window.acquireVsCodeApi = () => ({
					getState: () => undefined,
					setState() { },
					postMessage(message) { window.__posted.push(message); },
				});
			</script>
			<script src="/webview-bundle.js"></script>
		</body></html>`);
		return;
	}
	if (req.url === '/webview-bundle.js') {
		res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
		res.end(webviewScript);
		return;
	}
	// A framed document that reports in only when told to, so the order of the frame's `load`
	// event and the agent's first message can be chosen rather than raced.
	if (req.url === '/silent-frame') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(`<!DOCTYPE html><html><head><title>framed</title></head><body>framed<script>
			window.__reportReady = () => parent.postMessage(
				{ __tabBrowserAgent: true, kind: 'ready', documentUrl: 'http://127.0.0.1:1/' }, '*');
		</script></body></html>`);
		return;
	}
	// A page carrying the agent with a cookie prefix set, i.e. what the proxy serves.
	if (req.url === '/cookie-page') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(`<!DOCTYPE html><html><head><title>cookies</title>
			<script>window.__tabBrowserConfig = { realOrigin: 'http://localhost:5173', cookiePrefix: '__tbtest_' };</script>
			<script src="/agent.js"></script></head><body>cookies</body></html>`);
		return;
	}
	// The agent as the proxy serves it, so the timing of what it reports can be tested for real.
	if (req.url === '/agent.js') {
		res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
		res.end(agentScript);
		return;
	}
	// A document whose head is parsed long before its body arrives — the case that decides
	// whether "ready" means "there is a page to work on".
	if (req.url === '/late-body') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.write(`<!DOCTYPE html><html><head><script>
			window.__agentEvents = [];
			window.addEventListener('message', event => {
				if (event.data && event.data.__tabBrowserAgent) {
					window.__agentEvents.push({
						kind: event.data.kind,
						title: event.data.title,
						hasBody: !!document.body,
						hasLateElement: !!document.getElementById('late'),
					});
				}
			});
		</script><script src="/agent.js"></script>`);
		setTimeout(() => res.end(
			'<title>Late Page</title></head><body><div id="late">here</div></body></html>'), 300);
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
const panelBrowser = browser;
let element;
let iconHref;
let overlay;
let quotedId;
let agentEvents;
let panelState;
let consoleFormatting;
let cookieWrites;
let pageRequests;
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
	await page.goto(pageUrl);
	for (const bundle of ['page-bundle.js', 'page-icon-bundle.js', 'picker-bundle.js',
		'page-requests-bundle.js']) {
		await page.addScriptTag({
			content: await fs.readFile(path.join(projectRoot, 'test/.bundles', bundle), 'utf8'),
		});
	}
	element = await page.evaluate(url => {
		const target = document.getElementById('email');
		return tabBrowserPage.describeElement(target, [], url);
	}, pageUrl);
	iconHref = await page.evaluate(() => tabBrowserPageIcon.findIconHref());

	// What an mcp client asks the page for, run in the page.
	pageRequests = await page.evaluate(async url => {
		const run = request => tabBrowserRequests.handlePageRequest(request, url);
		const results = {};

		results.snapshot = await run({ type: 'snapshot' });

		// A field a framework would watch: filling it must raise the events typing would.
		const events = [];
		const field = document.getElementById('email');
		for (const type of ['input', 'change']) {
			field.addEventListener(type, () => events.push(type));
		}
		results.fill = await run({ type: 'fill', selector: '#email', value: 'a@b.c' });
		results.fillValue = field.value;
		results.fillEvents = events;

		const button = document.querySelector('.edge-target-primary-action');
		let clicks = 0;
		button.addEventListener('click', () => clicks++);
		results.click = await run({ type: 'click', selector: '.edge-target-primary-action' });
		results.clicks = clicks;

		const select = document.getElementById('pick');
		const selectEvents = [];
		select.addEventListener('change', () => selectEvents.push('change'));
		results.select = await run({ type: 'fill', selector: '#pick', value: 'b' });
		results.selectValue = select.value;
		results.selectEvents = selectEvents;

		results.small = await run({ type: 'snapshot', maxNodes: 2 });
		results.exact = await run({ type: 'snapshot', maxNodes: 1000 });

		results.text = await run({ type: 'text', selector: '.quoted-id' });
		results.html = await run({ type: 'html', selector: '#email' });
		results.inspect = await run({ type: 'inspect', selector: '#email' });

		setTimeout(() => {
			const late = document.createElement('div');
			late.className = 'rendered-late';
			document.body.appendChild(late);
		}, 250);
		results.waitFor = await run({ type: 'waitFor', selector: '.rendered-late', timeout: 3000 });

		// Most requests fail by throwing, `waitFor` by rejecting; the agent handles both.
		results.missing = await Promise.resolve()
			.then(() => run({ type: 'click', selector: '#nope' }))
			.then(() => 'resolved', error => error.message);

		return results;
	}, pageUrl);
	quotedId = await page.evaluate(url =>
		tabBrowserPage.describeElement(document.querySelector('.quoted-id'), [], url), pageUrl);

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

	// The frame's `load` event and the page's first message are two signals from two processes,
	// and nothing orders them. Here the worst order is forced: the frame is already loaded and
	// written off as uninstrumented before its agent reports in.
	const panel = await browser.newPage();
	await panel.goto(`${new URL(pageUrl).origin}/webview`);
	panelState = await panel.evaluate(async origin => {
		const frame = document.querySelector('iframe');
		const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));

		window.postMessage({
			type: 'didResolveUrl', requestId: 1, token: 'panel-token',
			loadUrl: `${origin}/silent-frame`, displayUrl: 'http://127.0.0.1:1/', instrumented: true,
		}, '*');

		await loaded;
		// The load handler runs in a listener of its own; let it have its turn first.
		await new Promise(resolve => setTimeout(resolve, 50));
		const afterLoad = window.__posted.filter(message => message.type === 'didChangeState').at(-1);

		frame.contentWindow.__reportReady();
		await new Promise(resolve => setTimeout(resolve, 50));
		const afterReady = window.__posted.filter(message => message.type === 'didChangeState').at(-1);

		// The frame now leaves for a document with no agent in it — a link to a page the proxy
		// does not serve. The report the previous document sent late must not be counted twice.
		const leftAgain = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
		frame.src = `${origin}/silent-frame?second`;
		await leftAgain;
		await new Promise(resolve => setTimeout(resolve, 50));
		const afterSecondLoad = window.__posted.filter(message => message.type === 'didChangeState').at(-1);

		return { afterLoad, afterReady, afterSecondLoad };
	}, new URL(pageUrl).origin);
	await panel.close();

	// A page sets cookies for the server it thinks it is talking to. Through the proxy that
	// server's name and scheme are not the ones the browser has the page from, and a cookie
	// whose attributes describe something else is not stored at all.
	const cookiePage = await browser.newPage();
	await cookiePage.goto(`${new URL(pageUrl).origin}/cookie-page`);
	cookieWrites = await cookiePage.evaluate(() => {
		const write = value => {
			document.cookie = value;
			return document.cookie;
		};
		return {
			plain: write('plain=1; Path=/'),
			domain: write('named=ok; Domain=localhost; Path=/'),
			secure: write('flagged=yes; Secure; SameSite=None; Path=/'),
		};
	});
	await cookiePage.close();

	// The whole agent, in a document whose body arrives long after its head.
	const latePage = await browser.newPage();
	await latePage.goto(`${new URL(pageUrl).origin}/late-body`);
	await latePage.waitForFunction(
		() => window.__agentEvents?.some(event => event.kind === 'ready'), null, { timeout: 5000 })
		.catch(() => { });
	// The console patch runs in front of every page script. Whatever a page logs, and however
	// badly it formats it, the call must behave as it would without the agent.
	consoleFormatting = await latePage.evaluate(async () => {
		const outcome = (log) => {
			try {
				log();
				return 'ok';
			} catch (error) {
				return String(error);
			}
		};
		const results = {
			symbolAsNumber: outcome(() => console.log('%d', Symbol('review'))),
			throwingGetter: outcome(() => console.log({ get boom() { throw new Error('nope'); } })),
			revokedProxy: outcome(() => {
				const { proxy, revoke } = Proxy.revocable({}, {});
				revoke();
				return console.log(proxy);
			}),
		};

		const collected = new Promise(resolve => {
			window.addEventListener('message', event => {
				if (event.data?.__tabBrowserAgent && event.data.kind === 'console') {
					resolve(event.data.entries.map(entry => entry.text));
				}
			});
		});
		window.postMessage({ __tabBrowserAgent: true, kind: 'collectConsole', requestId: 1 }, '*');
		results.entries = await collected;
		return results;
	});

	agentEvents = await latePage.evaluate(() => window.__agentEvents);
	await latePage.close();

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
	// The panel layout check below still needs it; closed at the end of the file.
}

// -- what the panel reported ------------------------------------------------------------------

check('a frame that has not reported in is treated as a page we do not serve',
	panelState.afterLoad?.instrumented === false, JSON.stringify(panelState.afterLoad));

// Otherwise the panel holds a page it can read while telling every mcp client it cannot.
check('a page that reports in after its own load event is instrumented all the same',
	panelState.afterReady?.instrumented === true && panelState.afterReady.ready === true,
	JSON.stringify(panelState.afterReady));

// The other way round: a report that arrived late belongs to the document that sent it, and
// counting it for the next one leaves the panel driving a page that has no agent in it.
check('the next document does not inherit the last one\'s report',
	panelState.afterSecondLoad?.instrumented === false
	&& panelState.afterSecondLoad.ready === false, JSON.stringify(panelState.afterSecondLoad));

// -- cookies a page sets itself -----------------------------------------------------------------

check('a cookie a page sets is kept, prefix hidden from the page',
	cookieWrites.plain.includes('plain=1') && !cookieWrites.plain.includes('__tbtest_'),
	JSON.stringify(cookieWrites));

// `Domain=localhost` on the `127.0.0.1` the browser actually has the page from is a cookie for
// somewhere else, and the browser stores nothing: the session simply never starts.
check('a Domain the proxy origin does not own does not lose the cookie',
	cookieWrites.domain.includes('named=ok'), JSON.stringify(cookieWrites));

// `Secure` and `SameSite=None` are dropped by the same rewrite the proxy uses on `Set-Cookie`
// (see the proxy test); on `127.0.0.1`, which the browser trusts, both forms survive anyway.
check('the rest of the attributes are rewritten the same way, and the cookie stands',
	cookieWrites.secure.includes('flagged=yes'), JSON.stringify(cookieWrites));

// -- the console patch ------------------------------------------------------------------------

// `console.log('%d', Symbol())` prints NaN in devtools. Throwing instead would be this
// extension breaking a page it is only supposed to watch.
check('a value the formatter cannot read does not turn a console call into a throw',
	consoleFormatting.symbolAsNumber === 'ok' && consoleFormatting.throwingGetter === 'ok'
	&& consoleFormatting.revokedProxy === 'ok', JSON.stringify(consoleFormatting));

check('the entry is still recorded, readable or not',
	consoleFormatting.entries?.length === 3
	&& consoleFormatting.entries[0].includes('NaN'), JSON.stringify(consoleFormatting.entries));

// -- what the page reported ------------------------------------------------------------------

// "ready" is what the panel waits on before it reads or drives anything, and the agent runs at
// the top of <head>: reporting from there would hand an mcp client an empty document.
const ready = agentEvents.find(event => event.kind === 'ready');
check('the page reports in only once there is a document to work on',
	ready?.hasBody === true && ready.hasLateElement === true, JSON.stringify(agentEvents));

check('the title is reported once it has been parsed, never as an empty string',
	agentEvents.some(event => event.kind === 'title' && event.title === 'Late Page')
	&& !agentEvents.some(event => event.kind === 'title' && !event.title),
	JSON.stringify(agentEvents));

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

// Native nesting: the rule that applies to this element is written inside another one, and its
// own `selectorText` is `& .field-input` — true of nothing on its own.
const nested = styles.matched.find(rule => rule.declarations.includes('outline-color'));
check('a nested rule is found, with its selector resolved against the rule it sits in',
	nested?.selector === ':is(.row) .field-input', JSON.stringify(nested));

check('a nested selector that does not say & is still a descendant of its parent',
	styles.matched.some(rule => rule.selector === ':is(.row) .outlined'
		&& rule.declarations.includes('outline-style')),
	selectors.join(' | '));

check('a nested rule inside a media query keeps both',
	styles.matched.some(rule => rule.declarations.includes('outline-width')
		&& rule.conditions?.[0] === '@media (min-width: 1px)'),
	JSON.stringify(styles.matched.filter(rule => rule.declarations.includes('outline'))));

// Everything after a nested rule lands in a `CSSNestedDeclarations` rule: no selector of its
// own, and it applies to the rule it sits in. Skipped, the declaration is missing from the
// report — and, absent from what the page declares, reads as the browser's own default.
check('declarations written after a nested rule stay with the rule they sit in',
	styles.matched.some(rule => rule.selector === '.outlined'
		&& rule.declarations.includes('text-decoration-thickness: 2px')),
	JSON.stringify(styles.matched.filter(rule => rule.selector === '.outlined')));

check('a nested rule is dropped only when the element really does not match it',
	!selectors.includes(':is(.row) .never-matches-anything'), selectors.join(' | '));

// The nesting selector is a `&` that stands on its own; one inside a string is part of a value,
// and rewriting it would turn a rule that matches into one that matches nothing.
check('an ampersand inside a string is left alone',
	selectors.includes(':is(.row) [data-tag="a&b"]'), selectors.join(' | '));

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

// -- paths and reports that carry page controlled text ----------------------------------------

check('an id that cannot be quoted in an xpath falls back to the positional path',
	!quotedId.xpath.includes('say"hi"') && /\/p(\[\d+\])?$/.test(quotedId.xpath), quotedId.xpath);

check('the css selector of that element is still usable',
	quotedId.selector.length > 0 && !quotedId.selector.includes('say"hi"'), quotedId.selector);

const fencedLog = formatConsoleReport('a log line with ``` in it\nand ```` too', 'http://x/');
check('a log containing a fence cannot end the code block early',
	fencedLog.split('\n').filter(line => /^`{3,}/.test(line)).every(line => line.length >= 5)
	&& fencedLog.includes('with ``` in it'), JSON.stringify(fencedLog));

const fencedElement = formatPickedElement({
	...element,
	outerHtml: '<div>```</div>',
	styles: { ...element.styles, variables: [{ property: '--x', value: '`````' }] },
}, 'context');
check('page markup and css cannot end their code blocks early',
	fencedElement.split('\n').filter(line => /^`{3,}html$/.test(line)).every(line => line.length >= 8)
	&& fencedElement.split('\n').filter(line => /^`{3,}css$/.test(line)).every(line => line.length >= 9),
	fencedElement.split('\n').filter(line => /^`{3,}/.test(line)).join(' | '));

// -- what an mcp client can ask the page ---------------------------------------------------------

const emailNode = pageRequests.snapshot.nodes.find(node => node.selector.includes('email'));
check('the snapshot names the interactive elements and how to reach them',
	emailNode?.role === 'input:text' && emailNode.name === 'mail'
	&& pageRequests.snapshot.title !== undefined
	&& pageRequests.snapshot.nodes.some(node => node.role === 'button'),
	JSON.stringify(pageRequests.snapshot.nodes.slice(0, 4)));

const password = pageRequests.snapshot.nodes.find(node => node.selector.includes('secret'));
check('a password never leaves the page',
	!!password && !JSON.stringify(pageRequests.snapshot).includes('hunter2')
	&& password.value?.includes('hidden'), JSON.stringify(password));

check('filling works on a select, which has its own value setter',
	pageRequests.selectValue === 'b' && pageRequests.selectEvents.join() === 'change',
	JSON.stringify([pageRequests.selectValue, pageRequests.selectEvents]));

check('a snapshot says when it is short of the page, and only then',
	pageRequests.small.truncated === true && pageRequests.small.nodes.length === 2
	&& pageRequests.exact.truncated === false,
	JSON.stringify([pageRequests.small.truncated, pageRequests.exact.truncated]));

check('filling a field raises the events a framework listens for',
	pageRequests.fillValue === 'a@b.c'
	&& pageRequests.fillEvents.join() === 'input,change', JSON.stringify(pageRequests.fillEvents));

check('clicking reaches the page', pageRequests.clicks === 1, String(pageRequests.clicks));

check('text and html come back for one element',
	pageRequests.text === 'quoted' && pageRequests.html.startsWith('<input id="email"'),
	JSON.stringify([pageRequests.text, pageRequests.html]));

check('inspect returns the same report the copy menu builds',
	pageRequests.inspect.descriptor === 'input#email.field-input.outlined'
	&& !!pageRequests.inspect.styles, pageRequests.inspect.descriptor);

check('waiting for an element that renders late succeeds',
	pageRequests.waitFor?.selector?.includes('rendered-late'), JSON.stringify(pageRequests.waitFor));

check('asking for something that is not there says so',
	pageRequests.missing.includes('#nope'), pageRequests.missing);

// -- the markup of the panel --------------------------------------------------------------------

// The toolbar is a template literal in the source, and an edit to it that leaves a tag stranded
// puts loose menu buttons straight into the toolbar. Checking the source is crude, but it is
// what catches the mistake.
const viewSource = await fs.readFile(path.join(projectRoot, 'src/tabBrowserView.ts'), 'utf8');
const template = viewSource.slice(
	viewSource.indexOf('<!DOCTYPE html>'), viewSource.indexOf('</html>') + '</html>'.length);

const voidElements = new Set(['meta', 'link', 'input', 'br', 'hr', 'img', 'source']);
const stack = [];
let unbalanced;

// Placeholders can hold anything, including whole elements: they are not markup here.
const tags = template.replace(/\$\{[^}]*\}/g, '').matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g);
for (const match of tags) {
	const [, closing, name, selfClosing] = match;
	if (voidElements.has(name.toLowerCase()) || selfClosing || name.toLowerCase() === '!doctype') {
		continue;
	}
	if (!closing) {
		stack.push(name);
		continue;
	}
	if (stack.pop() !== name) {
		unbalanced ??= `</${name}> at ${match.index}`;
	}
}

check('the panel markup closes every tag it opens',
	!unbalanced && stack.length === 0, unbalanced ?? `left open: ${stack.join(', ')}`);

check('every menu entry lives inside the copy menu',
	!/role="menuitem"/.test(template), 'a menu button is written into the toolbar itself');

// -- the panel's own layout --------------------------------------------------------------------

// The hint bar holds an unbreakable css selector, and a grid track is at least as wide as its
// widest item's min-content: without a `minmax(0, 1fr)` column the whole panel, iframe
// included, grows to the length of the longest path hovered and the page reflows to match.
const longSelector = 'div.a-very-long-generated-class-name > div.another-one-just-as-long'
	+ ' > section.and-a-third > ul.list > li:nth-of-type(7) > span.leaf-node-name';

const panel = await (async () => {
	const css = await fs.readFile(path.join(projectRoot, 'media/main.css'), 'utf8');
	const tab = await panelBrowser.newPage({ viewport: { width: 800, height: 600 } });
	await tab.setContent(`<!DOCTYPE html><html><head><style>${css}</style></head><body>
		<header class="header"><input class="url-input" value="http://localhost:5173/"></header>
		<div class="hint"><span class="hint-message">Click an element to copy it.</span
			><span class="hint-detail">${longSelector}</span></div>
		<div class="content"><iframe></iframe></div></body></html>`);
	const measured = await tab.evaluate(() => ({
		viewport: window.innerWidth,
		content: Math.round(document.querySelector('.content').getBoundingClientRect().width),
		iframe: Math.round(document.querySelector('iframe').getBoundingClientRect().width),
		scrollWidth: document.documentElement.scrollWidth,
	}));
	await tab.close();
	return measured;
})();

check('a long path in the hint bar does not widen the panel',
	panel.content === panel.viewport && panel.iframe === panel.viewport
	&& panel.scrollWidth === panel.viewport, JSON.stringify(panel));

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

const declared = await discoverPage(`${new URL(pageUrl).origin}/declares-icon`);
check('the icon a page declares is found in its html, relative urls included',
	declared?.iconHref === `${new URL(pageUrl).origin}/icon.png?v=2`, JSON.stringify(declared));

// The same read answers for the tab's title, which is what a page that carries no injected
// script has to be named after.
check('the title comes out of the same html, entities and line breaks resolved',
	declared?.title === 'Dashboard & Reports', JSON.stringify(declared));

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

// -- handing a report to an assistant ----------------------------------------------------------

const reportName = `report-${Date.now()}.md`;

check('nothing is delivered when the extension is not installed',
	await assistants.handOver('codex', 'x', reportName) === 'unavailable');

installedExtensions.add('openai.chatgpt');
check('an installed extension without the command still counts as unavailable',
	await assistants.handOver('codex', 'x', reportName) === 'unavailable');

contributedCommands.add('chatgpt.addFileToThread');
check('Codex takes the file by uri, and needs no folder open',
	await assistants.handOver('codex', '# report', reportName) === 'delivered'
	&& executed.at(-1)?.[0] === 'chatgpt.addFileToThread'
	&& String(executed.at(-1)?.[1]?.fsPath ?? '').endsWith(reportName),
	JSON.stringify(executed.at(-1)));

check('the report really is on disk, with its content',
	await fs.readFile(executed.at(-1)[1].fsPath, 'utf8') === '# report');

installedExtensions.add('Anthropic.claude-code');
contributedCommands.add('claude-vscode.insertAtMention');
check('Claude Code says so when there is no folder to name the file in',
	await assistants.handOver('claude', 'x', reportName) === 'noWorkspace');

workspaceFolders = [{ uri: { scheme: 'file', fsPath: await fs.mkdtemp('/tmp/tab-browser-test-') } }];
check('with a folder open Claude Code gets the file mentioned',
	await assistants.handOver('claude', '# report', reportName) === 'delivered'
	&& executed.at(-1)?.[0] === 'claude-vscode.insertAtMention', JSON.stringify(executed.at(-1)));

check('a Codex report stays out of the project even with a folder open',
	await assistants.handOver('codex', '# report', `codex-${reportName}`) === 'delivered'
	&& !String(executed.at(-1)[1].fsPath).startsWith(workspaceFolders[0].uri.fsPath),
	executed.at(-1)?.[1]?.fsPath);

check('the report lands in the workspace, in a folder git is told to ignore',
	await fs.readFile(path.join(workspaceFolders[0].uri.fsPath, '.tab-browser', reportName), 'utf8')
	=== '# report'
	&& (await fs.readFile(path.join(workspaceFolders[0].uri.fsPath, '.tab-browser', '.gitignore'), 'utf8'))
		.trim() === '*');

// -- reports do not pile up ---------------------------------------------------------------------

const reportsIn = path.join(workspaceFolders[0].uri.fsPath, '.tab-browser');
const stale = path.join(reportsIn, 'stale.md');
const fresh = path.join(reportsIn, 'fresh.md');
await fs.writeFile(stale, 'old');
await fs.writeFile(fresh, 'new');
const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
await fs.utimes(stale, sixHoursAgo, sixHoursAgo);

await assistants.cleanUpReports();
check('a report older than five hours is swept at startup',
	!(await fs.access(stale).then(() => true, () => false)));
check('a recent report and the .gitignore survive the sweep',
	await fs.readFile(fresh, 'utf8') === 'new'
	&& await fs.readFile(path.join(reportsIn, '.gitignore'), 'utf8') === '*\n');

// The sweep runs at most once an hour, so writing right after it leaves the file it just made.
await fs.utimes(fresh, sixHoursAgo, sixHoursAgo);
await assistants.handOver('codex', '# report', `after-${reportName}`);
check('writing a report does not sweep again within the hour',
	await fs.readFile(fresh, 'utf8') === 'new');

// -- navigating on behalf of a client -----------------------------------------------------------

// A tool call that answers "the panel is open" for a page that never arrived is worse than one
// that fails: the caller clicks on into whatever was standing there before.
const controllerFor = view => new BrowserController({ show() { }, activeView: view });
const neverReady = { url: 'http://127.0.0.1:1/', whenReady: () => Promise.reject(new Error('timed out')) };

// A dev server that is down is the case worth getting right: the proxy serves its own error
// page, which carries no agent, so `inspectable` is false here too — what tells the two apart
// is that the panel *asked* for an instrumented page.
const neverArrived = await controllerFor({ ...neverReady, expectsAgent: true, inspectable: false })
	.navigate('http://127.0.0.1:1/');
check('a page that never reports in is reported as not loaded',
	/did not finish loading/.test(neverArrived.error ?? ''), JSON.stringify(neverArrived));

// A page opened outside the proxy never reports in either, and that is not a failure: there is
// simply no script in it, which `inspectable` already says.
check('a page opened outside the proxy is not an error',
	(await controllerFor({ ...neverReady, expectsAgent: false, inspectable: false })
		.navigate('https://example.com/')).error === undefined);

check('a page that does report in is answered plainly',
	(await controllerFor({ url: 'http://localhost:3000/', expectsAgent: true, inspectable: true, whenReady: async () => { } })
		.navigate('http://localhost:3000/')).error === undefined);

// -- the mcp server ------------------------------------------------------------------------------

// A browser panel that answers from a script rather than from a webview.
const pageAnswers = { snapshot: { url: 'http://localhost:3000/', nodes: [] } };
const asked = [];
const fakeBrowser = {
	state: () => ({ open: true, url: 'http://localhost:3000/', inspectable: true }),
	navigate: async url => ({ open: true, url }),
	ask: async request => {
		asked.push(request);
		if (request.type === 'click' && request.selector === '#missing') {
			throw new Error('Nothing matches #missing on this page');
		}
		return pageAnswers[request.type] ?? { ok: request.type };
	},
	console: async () => ({ entries: [{ level: 'error', text: 'boom' }] }),
	lastPick: () => ({ descriptor: 'input#email' }),
};

const mcpToken = 'test-token';
const mcp = new McpServer(fakeBrowser, mcpToken);
await mcp.start(43310);

const rpc = async (body, { token = mcpToken, origin, method = 'POST' } = {}) => {
	const headers = { 'content-type': 'application/json' };
	if (token) { headers.authorization = `Bearer ${token}`; }
	if (origin) { headers.origin = origin; }
	const answer = await fetch(mcp.url, { method, headers, body: body && JSON.stringify(body) });
	const text = await answer.text();
	return { status: answer.status, body: text ? JSON.parse(text) : undefined };
};

check('the server listens where it says it does', /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(mcp.url), mcp.url);

const initialize = await rpc({
	jsonrpc: '2.0', id: 1, method: 'initialize',
	params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
});
check('initialize answers with the protocol version the client asked for',
	initialize.body?.result?.protocolVersion === '2025-06-18'
	&& initialize.body.result.capabilities?.tools
	&& initialize.body.result.serverInfo?.name === 'tab-browser-ultimate',
	JSON.stringify(initialize.body));

const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const toolNames = (listed.body?.result?.tools ?? []).map(tool => tool.name);
check('every browser tool is listed, with a schema',
	['browser_state', 'browser_navigate', 'browser_snapshot', 'browser_inspect_element',
		'browser_selected_element', 'browser_html', 'browser_text', 'browser_console',
		'browser_click', 'browser_fill', 'browser_wait_for'].every(name => toolNames.includes(name))
	&& listed.body.result.tools.every(tool => tool.inputSchema?.type === 'object'),
	toolNames.join(', '));

const call = async (name, args) => (await rpc({
	jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args },
})).body?.result;

const snapshot = await call('browser_snapshot', {});
check('a tool call reaches the page and comes back as text',
	!snapshot.isError && JSON.parse(snapshot.content[0].text).url === 'http://localhost:3000/',
	JSON.stringify(snapshot));

check('arguments are passed through to the page',
	(await call('browser_fill', { selector: '#email', value: 'a@b.c' }))
	&& asked.at(-1).type === 'fill' && asked.at(-1).value === 'a@b.c', JSON.stringify(asked.at(-1)));

const failed = await call('browser_click', { selector: '#missing' });
check('a failing tool answers with isError, not a protocol error',
	failed.isError === true && failed.content[0].text.includes('#missing'), JSON.stringify(failed));

const unknown = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } });
check('an unknown tool is a protocol error', unknown.body?.error?.code === -32602, JSON.stringify(unknown.body));

const notification = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
check('a notification is accepted without an answer', notification.status === 202);

// `null` and `[]` are valid json and not requests. Answering them is not politeness: an
// authorized client that gets nothing back waits for it until it gives up.
const nullAnswer = await fetch(mcp.url, {
	method: 'POST',
	headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpToken}` },
	body: 'null',
});
const nullBody = { status: nullAnswer.status, body: JSON.parse(await nullAnswer.text() || 'null') };
check('a json body that is not a request is answered rather than dropped',
	nullBody.status === 400 && nullBody.body?.error?.code === -32600, JSON.stringify(nullBody));
check('a batch is refused the same way',
	(await rpc([{ jsonrpc: '2.0', id: 9, method: 'ping' }])).status === 400);
check('the server still answers afterwards',
	(await rpc({ jsonrpc: '2.0', id: 10, method: 'ping' })).body?.result !== undefined);

check('a request without the token is refused',
	(await rpc({ jsonrpc: '2.0', id: 5, method: 'ping' }, { token: null })).status === 401);
check('a request with the wrong token is refused',
	(await rpc({ jsonrpc: '2.0', id: 5, method: 'ping' }, { token: 'guess' })).status === 401);

// A page cannot read the answer, but the side effect alone would be enough to drive the panel.
check('a request from a browser origin is refused before anything happens',
	(await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'http://evil/' } } },
		{ origin: 'http://evil.example' })).status === 403
	&& !asked.some(request => request.type === 'navigate'));

check('there is no stream to open', (await rpc(undefined, { method: 'GET' })).status === 405);

// Codex can only name an environment variable to read a bearer token from, so the token has to
// be able to travel in the url instead.
const withToken = async (url, body) => {
	const answer = await fetch(url, {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
	});
	return { status: answer.status, body: await answer.json().catch(() => undefined) };
};

check('the url carries the token for clients that cannot send a header',
	mcp.urlWithToken === `${mcp.url}/${mcpToken}`, mcp.urlWithToken);

check('a request authorised by the path is served',
	(await withToken(mcp.urlWithToken, { jsonrpc: '2.0', id: 7, method: 'ping' })).body?.result
	!== undefined);

check('a wrong token in the path is refused',
	(await withToken(`${mcp.url}/not-the-token`, { jsonrpc: '2.0', id: 8, method: 'ping' })).status
	=== 401);

// -- writing the Claude Code configuration --------------------------------------------------------

const configFile = path.join(workspaceFolders[0].uri.fsPath, '.mcp.json');
await fs.writeFile(configFile, JSON.stringify({
	mcpServers: { existing: { type: 'http', url: 'http://example/mcp' } },
}, null, 2));

await connectToClaudeCode(mcp);
const written = JSON.parse(await fs.readFile(configFile, 'utf8'));
check('connecting adds this server without dropping the ones already configured',
	written.mcpServers.existing?.url === 'http://example/mcp'
	&& written.mcpServers['tab-browser']?.url === mcp.url
	&& written.mcpServers['tab-browser'].headers.Authorization === `Bearer ${mcpToken}`,
	JSON.stringify(written));

// A config with a trailing comma is a config, not an empty one.
const brokenConfig = '{ "mcpServers": { "existing": { "type": "http", "url": "http://example/mcp" }, } }';
await fs.writeFile(configFile, brokenConfig);
dialogs.length = 0;
await connectToClaudeCode(mcp);
check('a config that cannot be parsed is left alone, with an explanation',
	await fs.readFile(configFile, 'utf8') === brokenConfig
	&& dialogs.some(([kind]) => kind === 'error'), JSON.stringify(dialogs));

dialogAnswer = 'Copy CLI command';
await connectToClaudeCode(mcp);
check('the Claude Code cli command carries the url and the token',
	clipboard.includes(`--transport http`) && clipboard.includes(mcp.url)
	&& clipboard.includes(`Bearer ${mcpToken}`), clipboard);

clipboard = '';
dialogAnswer = 'Copy CLI command';
await connectToCodex(mcp);
check('the Codex cli command names the server after the project, not just "tab-browser"',
	new RegExp(`^codex mcp add tab-browser-${path.basename(workspaceFolders[0].uri.fsPath).toLowerCase()}`
		+ `-[0-9a-f]{6} --url ${mcp.urlWithToken.replace(/[.?*+^$[\]\\(){}|/-]/g, '\\$&')}$`)
		.test(clipboard), clipboard);

// Two projects, one global config: a shared name would have the second overwrite the first, and
// with the token in the url that reconnection would even authenticate.
const otherFolder = { uri: { scheme: 'file', fsPath: await fs.mkdtemp('/tmp/other-project-') } };
const firstCommand = clipboard;
workspaceFolders = [{ ...otherFolder, name: 'other-project' }];
clipboard = '';
await connectToCodex(mcp);
check('a second project gets its own entry rather than replacing the first',
	clipboard !== firstCommand && clipboard.includes('tab-browser-other-project'), clipboard);

// Every client has a project called `frontend`. Named after the folder alone, the second one
// would take the first one's entry over — and the token being in the url, it would connect.
const nameOnly = async fsPath => {
	workspaceFolders = [{ uri: { scheme: 'file', fsPath, toString: () => `file://${fsPath}` }, name: 'frontend' }];
	clipboard = '';
	await connectToCodex(mcp);
	return clipboard.split(' ')[3];
};
const [clientA, clientB] = [await nameOnly('/clients/a/frontend'), await nameOnly('/clients/b/frontend')];
check('two projects with the same folder name still get an entry each',
	clientA !== clientB && clientA.startsWith('tab-browser-frontend-'), `${clientA} vs ${clientB}`);
check('the name of one project does not change between connections',
	await nameOnly('/clients/a/frontend') === clientA, clientA);

// The project file is ours to write, and it must leave the rest of the file alone.
workspaceFolders = [{ ...otherFolder, name: 'other-project' }];
const codexConfig = path.join(otherFolder.uri.fsPath, '.codex', 'config.toml');
await fs.mkdir(path.dirname(codexConfig), { recursive: true });
await fs.writeFile(codexConfig, '[mcp_servers.something_else]\ncommand = "node"\n');

dialogAnswer = '1. Write .codex/config.toml';
await connectToCodex(mcp);
let codexToml = await fs.readFile(codexConfig, 'utf8');
check('writing the project config keeps the servers already in it',
	codexToml.includes('[mcp_servers.something_else]') && codexToml.includes('command = "node"')
	&& codexToml.includes(`[mcp_servers.tab-browser]`) && codexToml.includes(mcp.urlWithToken),
	codexToml);

// Connecting twice must not define the same table twice, which would not parse at all.
await connectToCodex(mcp);
codexToml = await fs.readFile(codexConfig, 'utf8');
check('connecting again replaces our table instead of adding a second one',
	codexToml.split('[mcp_servers.tab-browser]').length === 2
	&& codexToml.includes('[mcp_servers.something_else]'), codexToml);

// A header is a header wherever TOML allows one to be written. Recognising ours only as a bare
// line used to add a second table with the same name, which no longer parses at all.
await fs.writeFile(codexConfig,
	'[mcp_servers.tab-browser]   # ours, from an older window\nurl = "http://127.0.0.1:1/mcp/old"\n\n'
	+ '# the one we must not swallow\n[mcp_servers.something_else]\ncommand = "node"\n');
await connectToCodex(mcp);
codexToml = await fs.readFile(codexConfig, 'utf8');
check('our table is found even when its header carries a comment',
	codexToml.split(/\[mcp_servers\.tab-browser\]/).length === 2
	&& codexToml.includes(mcp.urlWithToken) && !codexToml.includes('mcp/old'), codexToml);
check('the comment introducing the next table survives',
	codexToml.includes('# the one we must not swallow')
	&& codexToml.includes('[mcp_servers.something_else]'), codexToml);

// `codex mcp add` writes arrays over several lines. A table read as ending at its first line
// leaves the rest of the value — and a stray `]` — behind, which parses as nothing at all.
await fs.writeFile(codexConfig,
	'[mcp_servers.tab-browser]\nurl = "http://127.0.0.1:1/mcp/old"\n'
	+ 'enabled_tools = [\n  "browser_state",\n  "browser_click",\n]\n\n'
	+ '[mcp_servers.something_else]\ncommand = "node"\n');
await connectToCodex(mcp);
codexToml = await fs.readFile(codexConfig, 'utf8');
check('a value written over several lines is replaced whole',
	!codexToml.includes('browser_state') && !/^\s*\]/m.test(codexToml)
	&& codexToml.includes(mcp.urlWithToken) && codexToml.includes('[mcp_servers.something_else]'),
	codexToml);

// Neither assistant can be handed text, so the prompt goes on the clipboard: the entry this
// extension writes, and the command that adds it for a file that was never written.
dialogAnswer = '2. Copy connection prompt';
clipboard = '';
await connectToCodex(mcp);
check('the Codex prompt names its config file and the command behind it',
	clipboard.includes('.codex/config.toml') && clipboard.includes('tab-browser')
	&& clipboard.includes(`codex mcp add tab-browser-other-project`)
	&& clipboard.includes(mcp.urlWithToken), clipboard);

clipboard = '';
await connectToClaudeCode(mcp);
check('the Claude Code prompt names its own file and command',
	clipboard.includes('.mcp.json') && clipboard.includes('claude mcp add')
	&& clipboard.includes(mcp.url) && clipboard.includes(`Bearer ${mcpToken}`), clipboard);

// -- keeping a configuration that was written once ----------------------------------------------

// What goes stale is the port, not the token: ports are handed out in the order windows open, so
// the entry written for this project last week names whichever window opened first today. Every
// start of the server repairs it, or connecting would have to be done again every time.
const otherPort = 'http://127.0.0.1:43999/mcp';
const claudeEntry = entry => JSON.stringify({
	mcpServers: { existing: { url: 'http://example/mcp' }, 'tab-browser': entry },
}, null, 2);
const refreshedClaude = entry => JSON.parse(
	refreshedClaudeConfig(claudeEntry(entry), mcp.url, mcpToken) ?? 'null');

let repaired = refreshedClaude({
	type: 'http', url: otherPort, headers: { Authorization: `Bearer ${mcpToken}` },
});
check('an entry naming another window\'s port is pointed back here',
	repaired?.mcpServers['tab-browser'].url === mcp.url
	// And nothing else in the file, nor anything else in the entry, is touched by it.
	&& repaired.mcpServers.existing.url === 'http://example/mcp'
	&& repaired.mcpServers['tab-browser'].type === 'http', JSON.stringify(repaired));

check('an entry that already points here is not rewritten at all',
	refreshedClaudeConfig(claudeEntry({ url: mcp.url, headers: { Authorization: `Bearer ${mcpToken}` } }),
		mcp.url, mcpToken) === undefined);

check('a token from another machine is replaced along with the port',
	refreshedClaude({ url: otherPort, headers: { authorization: 'Bearer someone-elses' } })
		?.mcpServers['tab-browser'].headers.authorization === `Bearer ${mcpToken}`);

// The shape of the entry says what the client can do, so it is kept: a token in the url is a
// client that cannot send a header, and a `${...}` is one reading it from the environment.
check('a token carried in the url stays in the url',
	refreshedClaude({ url: `${otherPort}/${mcpToken}` })?.mcpServers['tab-browser'].url
	=== mcp.urlWithToken);

repaired = refreshedClaude({
	url: otherPort, headers: { Authorization: 'Bearer ${TAB_BROWSER_TOKEN}' },
});
check('a token read from the environment is left as it is',
	repaired?.mcpServers['tab-browser'].url === mcp.url
	&& repaired.mcpServers['tab-browser'].headers.Authorization === 'Bearer ${TAB_BROWSER_TOKEN}',
	JSON.stringify(repaired));

check('an entry naming something that is not this extension\'s server is not ours to move',
	refreshedClaudeConfig(claudeEntry({ url: 'https://example.com/mcp' }), mcp.url, mcpToken)
	=== undefined);

check('a config that cannot be parsed is left alone here too',
	refreshedClaudeConfig('{ "mcpServers": { }, }', mcp.url, mcpToken) === undefined);

check('a file with no entry of ours gets none added',
	refreshedClaudeConfig(JSON.stringify({ mcpServers: { existing: { url: 'http://example/mcp' } } }),
		mcp.url, mcpToken) === undefined);

// Codex's config is TOML, held by `codex mcp add` where it is the global one, so only the `url`
// line of our own table is rewritten and everything around it survives.
const codexProject = (values = `url = "${otherPort}/${mcpToken}"`) =>
	`[mcp_servers.tab-browser]\n${values}\n\n[mcp_servers.something_else]\ncommand = "node"\n`;
const refreshedProject = (text = codexProject()) =>
	refreshedCodexConfig(text, mcp.url, mcpToken, { names: ['tab-browser'] });

let toml = refreshedProject();
check('the project entry is pointed back here without disturbing the file',
	toml?.includes(`url = "${mcp.urlWithToken}"`) && !toml.includes('43999')
	&& toml.includes('[mcp_servers.something_else]') && toml.includes('command = "node"'), toml);

check('a project entry that already points here is not rewritten',
	refreshedProject(codexProject(`url = "${mcp.urlWithToken}"`)) === undefined);

// Everything else in the table is somebody's decision, `enabled = false` included.
toml = refreshedProject(codexProject(`url = "${otherPort}/${mcpToken}"\nenabled = false`));
check('the rest of the table is left as written',
	toml?.includes(`url = "${mcp.urlWithToken}"`) && toml.includes('enabled = false'), toml);

toml = refreshedProject(codexProject(
	`url = "${otherPort}"\nbearer_token_env_var = "TAB_BROWSER_TOKEN"`));
check('an entry reading its token from the environment keeps it out of the url',
	toml?.includes(`url = "${mcp.url}"`) && !toml.includes(mcpToken)
	&& toml.includes('bearer_token_env_var'), toml);

check('a table of somebody else\'s is not repaired by name alone',
	refreshedCodexConfig(codexProject(), mcp.url, mcpToken, { names: ['tab-browser-elsewhere'] })
	=== undefined);

// The global config is shared by every project on the machine, so an entry there has to say it
// is ours: the name carries a hash of the folder, or the url carries this workspace's token.
const globalEntry = (name, url) => `[mcp_servers.${name}]\nurl = "${url}"\n`;
const refreshedGlobal = (name, url, allowed = name) => refreshedCodexConfig(
	globalEntry(name, url), mcp.url, mcpToken, { names: [allowed], shared: true });

check('an entry named after this workspace is repaired',
	refreshedGlobal('tab-browser-frontend-a1b2c3', `${otherPort}/${mcpToken}`)
		?.includes(mcp.urlWithToken));

check('so is one under the bare name that carries this workspace\'s token',
	refreshedGlobal('tab-browser', `${otherPort}/${mcpToken}`)?.includes(mcp.urlWithToken));

check('but not one under the bare name holding another project\'s token',
	refreshedGlobal('tab-browser', `${otherPort}/${'b'.repeat(64)}`) === undefined);

// And the whole of it against real files, since that is where a path or a missing file bites.
const refreshFolder = { uri: { scheme: 'file', fsPath: await fs.mkdtemp('/tmp/refresh-') } };
workspaceFolders = [{ ...refreshFolder, name: 'refresh' }];
const refreshMcpJson = path.join(refreshFolder.uri.fsPath, '.mcp.json');
const refreshToml = path.join(refreshFolder.uri.fsPath, '.codex', 'config.toml');
await fs.mkdir(path.dirname(refreshToml), { recursive: true });
await fs.writeFile(refreshMcpJson,
	claudeEntry({ url: otherPort, headers: { Authorization: `Bearer ${mcpToken}` } }));
await fs.writeFile(refreshToml, codexProject());

await refreshClientConfigs(mcp);
check('both of the project\'s files are repaired on startup',
	JSON.parse(await fs.readFile(refreshMcpJson, 'utf8')).mcpServers['tab-browser'].url === mcp.url
	&& (await fs.readFile(refreshToml, 'utf8')).includes(mcp.urlWithToken));

// The global config is the one file the other windows are also in. Each of them repairs its own
// entry, so two starting together would both write the text they read and the later one would
// undo the earlier one's repair — putting a client that was configured correctly on another
// window's port.
const sharedConfig = path.join(await fs.mkdtemp('/tmp/shared-codex-'), 'config.toml');
const sharedUri = { scheme: 'file', fsPath: sharedConfig };
const codexTable = (name, url) => `[mcp_servers.${name}]\nurl = "${url}"\n`;

// The location is what the entry is named after, and `toString` is what reads it — a plain
// object has one of those already, so leaving it out gives both windows the same name.
const otherWindow = fsPath =>
	({ uri: { scheme: 'file', fsPath, toString: () => `file://${fsPath}` }, name: 'frontend' });
const folderA = otherWindow('/clients/a/frontend');
const folderB = otherWindow('/clients/b/frontend');
await fs.writeFile(sharedConfig, `${codexTable(codexEntryName(folderA), `${otherPort}/${mcpToken}`)}\n`
	+ codexTable(codexEntryName(folderB), `${otherPort}/${mcpToken}`));

// Read at the top of the call, so this is two windows starting at the same moment.
workspaceFolders = [folderA];
const windowA = refreshClientConfigs(mcp, sharedUri);
workspaceFolders = [folderB];
const windowB = refreshClientConfigs(mcp, sharedUri);
await Promise.all([windowA, windowB]);

let shared = await fs.readFile(sharedConfig, 'utf8');
check('two windows starting together do not undo each other\'s repair',
	shared.split(mcp.urlWithToken).length === 3 && !shared.includes('43999'), shared);

// The bare name is the one an older version of the connect command wrote, and the token is what
// says it was written from here. Left out of the names, it would be beyond repair.
workspaceFolders = [{ ...refreshFolder, name: 'refresh' }];
await fs.writeFile(sharedConfig, codexTable('tab-browser', `${otherPort}/${mcpToken}`));
await refreshClientConfigs(mcp, sharedUri);
check('a global entry under the bare name carrying this workspace\'s token is repaired',
	(await fs.readFile(sharedConfig, 'utf8')).includes(mcp.urlWithToken));

const elsewhere = 'b'.repeat(64);
await fs.writeFile(sharedConfig, codexTable('tab-browser', `${otherPort}/${elsewhere}`));
await refreshClientConfigs(mcp, sharedUri);
shared = await fs.readFile(sharedConfig, 'utf8');
check('one holding another project\'s token is still not ours to move',
	shared.includes(elsewhere) && !shared.includes(mcpToken), shared);

check('and the lock is not left behind for the next window to wait on',
	!await fs.access(`${sharedConfig}.lock`).then(() => true, () => false));

// A project that was never connected is one nothing was added to, and a window with no folder
// open has no project files at all — neither may end up creating one.
await fs.rm(refreshMcpJson);
await fs.rm(refreshToml);
workspaceFolders = undefined;
await refreshClientConfigs(mcp);
workspaceFolders = [{ ...refreshFolder, name: 'refresh' }];
await refreshClientConfigs(mcp);
check('a file that is not there is not created',
	!await fs.access(refreshMcpJson).then(() => true, () => false)
	&& !await fs.access(refreshToml).then(() => true, () => false));

workspaceFolders = [{ uri: { scheme: 'file', fsPath: path.dirname(configFile) } }];

mcp.dispose();
check('the port is released on dispose',
	await fetch(mcp.url ?? 'http://127.0.0.1:43310/mcp').then(() => false, () => true));

// -- reading a client's configuration back ------------------------------------------------------

// The point of the check is to say which client would actually reach *this* window. A config
// that names the right url and cannot use it — an old token, a commented out line, an entry
// turned off — is the case worth catching: reported as working, it hides the one button that
// would fix it.
const checkUrl = 'http://127.0.0.1:43110/mcp';
const checkToken = 'a'.repeat(64);
const checkUrlWithToken = `${checkUrl}/${checkToken}`;
const claudeConfig = entry => JSON.stringify({ mcpServers: { 'tab-browser': entry } });
const claudeState = entry => claudeClientState(claudeConfig(entry), checkUrl, checkToken);
const codexState = (...texts) => codexClientState(texts, checkUrl, checkUrlWithToken);

check('a Claude Code config with this window\'s token is the one working case',
	claudeState({ type: 'http', url: checkUrl, headers: { Authorization: `Bearer ${checkToken}` } })
	=== 'thisServer');

check('an http header name is read whatever its case',
	claudeState({ url: checkUrl, headers: { authorization: `Bearer ${checkToken}` } }) === 'thisServer');

check('a Claude Code config carrying another window\'s token is not "points at this server"',
	claudeState({ url: checkUrl, headers: { Authorization: `Bearer ${'b'.repeat(64)}` } })
	=== 'staleToken');

check('nor is one carrying no token at all',
	claudeState({ url: checkUrl }) === 'staleToken');

check('a token in the url is accepted there too, as the server accepts it',
	claudeState({ url: checkUrlWithToken }) === 'thisServer');

check('another port is another window',
	claudeState({ url: 'http://127.0.0.1:43111/mcp', headers: { Authorization: `Bearer ${checkToken}` } })
	=== 'otherServer');

check('no entry and no file are both "nothing points here"',
	claudeClientState(JSON.stringify({ mcpServers: {} }), checkUrl, checkToken) === 'none'
	&& claudeClientState(undefined, checkUrl, checkToken) === 'none'
	&& claudeClientState('{ not json', checkUrl, checkToken) === 'none');

check('a Codex entry with this url is the one working case',
	codexState(`[mcp_servers.tab-browser]\nurl = "${checkUrlWithToken}"\n`) === 'thisServer');

check('a Codex entry named after another project counts as well',
	codexState(`[mcp_servers.tab-browser-my-app]\nurl = "${checkUrlWithToken}"\n`) === 'thisServer');

check('a Codex entry that is turned off is not a working configuration',
	codexState(`[mcp_servers.tab-browser]\nurl = "${checkUrlWithToken}"\nenabled = false\n`)
	=== 'disabled');

check('this url in a comment is not a configuration either',
	codexState(`[mcp_servers.tab-browser]\n# url = "${checkUrlWithToken}"\nurl = "http://127.0.0.1:43999/mcp"\n`)
	=== 'otherServer');

check('a whole entry left in comments is nothing at all',
	codexState(`# [mcp_servers.tab-browser]\n# url = "${checkUrlWithToken}"\n`) === 'none');

check('a token read from the environment cannot be judged, so the endpoint decides',
	codexState(`[mcp_servers.tab-browser]\nurl = "${checkUrl}"\nbearer_token_env_var = "TB_TOKEN"\n`)
	=== 'thisServer');

check('this endpoint with no way to authenticate is a 401 waiting to happen',
	codexState(`[mcp_servers.tab-browser]\nurl = "${checkUrl}"\n`) === 'staleToken');

// A parser that ignored the second header would read its url as ours and call it working.
check('keys after another table do not fall into ours',
	codexState(`[mcp_servers.tab-browser]\nurl = "http://127.0.0.1:43999/mcp"\n\n[something_else]\nurl = "${checkUrlWithToken}"\n`)
	=== 'otherServer');

check('several entries are reported by the one that works',
	codexState(
		`[mcp_servers.tab-browser]\nurl = "${checkUrlWithToken}"\nenabled = false\n`,
		`[mcp_servers.tab-browser-other]\nurl = "${checkUrlWithToken}"\n`)
	=== 'thisServer');

check('and by the closest to working when none does',
	codexState(`[mcp_servers.tab-browser]\nurl = "http://127.0.0.1:43999/mcp"\n[mcp_servers.tab-browser-b]\nurl = "${checkUrl}"\n`)
	=== 'staleToken');

check('a name defined in both files is read from the project, which is the more specific one',
	codexState(
		`[mcp_servers.tab-browser]\nurl = "http://127.0.0.1:43999/mcp"\n`,
		`[mcp_servers.tab-browser]\nurl = "${checkUrlWithToken}"\n`)
	=== 'otherServer');

check('a Codex config with no tab browser in it says so',
	codexState('[mcp_servers.other]\nurl = "http://127.0.0.1:1/mcp"\n', undefined) === 'none');

// -- activation ------------------------------------------------------------------------------

// Everything below hangs off activation: when it throws, the panel, the copy menu and the mcp
// server all go with it. It has taken the extension down three times now — once per optional
// integration — so it is checked here rather than only in the editor.
settings['mcp.enabled'] = false;
const { activate } = await import('./.bundles/extension-bundle.mjs');
const context = {
	subscriptions: [],
	extensionUri: { fsPath: projectRoot, scheme: 'file' },
	extension: { id: 'test.tab-browser-ultimate', packageJSON: { version: '0.0.0-test' } },
	globalState: { get: () => undefined, update: async () => { } },
	workspaceState: { get: (_key, fallback) => fallback, update: async () => { } },
};

let activationError;
try {
	await activate(context);
} catch (error) {
	activationError = error;
}

check('activation survives a proposed api that is present but refuses to be called',
	!activationError, String(activationError));

check('every contributed command is registered, mcp disabled or not',
	['tabBrowser.show', 'tabBrowser.copyElement', 'tabBrowser.addElementToClaude',
		'tabBrowser.addElementToCodex', 'tabBrowser.copyConsole', 'tabBrowser.connectMcpToClaudeCode',
		'tabBrowser.checkMcp', 'tabBrowser.copyMcpUrl', 'tabBrowser.openSettings',
		'tabBrowser.refreshView']
		.every(id => registeredCommands.has(id)),
	[...registeredCommands.keys()].join(', '));

// The sidebar is the one place where a command id is written twice; the second copy is only
// exercised when someone clicks the row, so it is checked here instead.
const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
check('the sidebar is registered for the view the manifest declares',
	treeViewId === manifest.contributes.views.tabBrowser[0].id,
	`${treeViewId} vs ${manifest.contributes.views.tabBrowser[0].id}`);

const sidebarRows = [];
const collectRows = async parent => {
	for (const row of await treeProvider.getChildren(parent)) {
		sidebarRows.push(row);
		await collectRows(row);
	}
};
await collectRows(undefined);

check('every sidebar row runs a command that exists',
	sidebarRows.length > 4
	&& sidebarRows.filter(row => row.command).every(row => registeredCommands.has(row.command)),
	sidebarRows.map(row => `${row.label}${row.command ? ` -> ${row.command}` : ''}`).join(', '));

check('every sidebar row renders',
	sidebarRows.every(row => treeProvider.getTreeItem(row).label === row.label));

check('the manifest puts every title bar button on this view',
	manifest.contributes.menus['view/title'].every(entry =>
		entry.when === `view == ${treeViewId}` && registeredCommands.has(entry.command)),
	JSON.stringify(manifest.contributes.menus['view/title']));

// The mcp setting is not a startup flag. A server left answering after it was switched off is
// one the sidebar reports as disabled while an assistant still drives the panel through it.
const settingPort = 43955;
const mcpAnswers = () => fetch(`http://127.0.0.1:${settingPort}/mcp`, { method: 'POST', body: '{}' })
	.then(answer => answer.status, () => 'no server');
const until = async expected => {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (await mcpAnswers() === expected) {
			return expected;
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	return mcpAnswers();
};

await changeSetting('mcp.port', settingPort);
await changeSetting('mcp.enabled', true);
// 401 and not 200: the point is that something is listening, and the token is the server's own.
check('switching the setting on starts the server without a reload', await until(401) === 401);

await changeSetting('mcp.enabled', false);
check('switching it off again stops it answering', await until('no server') === 'no server');

delete settings['mcp.port'];

check('the connect command explains itself instead of throwing when mcp is off',
	await registeredCommands.get('tabBrowser.connectMcpToClaudeCode')().then(() => true, () => false)
	&& dialogs.some(([kind, message]) => kind === 'warning' && /mcp server is not running/.test(message)),
	JSON.stringify(dialogs.slice(-2)));

delete settings['mcp.enabled'];

await browser.close();
server.close();

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
