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
import { Uri } from './vscode-mock.mjs';

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
	// The real class, near enough: several of the things under test hand a file to the editor
	// as a url and read it back as a path, and a faker that cannot do both says nothing.
	Uri,
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
			// What the sidebar's file browser reads a folder with.
			readDirectory: async uri => (await fs.readdir(uri.fsPath, { withFileTypes: true }))
				.map(entry => [entry.name, entry.isDirectory() ? 2 : 1]),
		},
		asRelativePath: (uri, includeFolder) => {
			const root = workspaceFolders?.[0]?.uri.fsPath;
			const target = typeof uri === 'string' ? uri : uri.fsPath;
			return root && target.startsWith(`${root}/`) ? target.slice(root.length + 1) : target;
		},
		findFiles: async () => [],
		createFileSystemWatcher: () => ({
			onDidChange: () => ({ dispose() { } }),
			onDidCreate: () => ({ dispose() { } }),
			onDidDelete: () => ({ dispose() { } }),
			dispose() { },
		}),
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
	FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
	RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
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

const { formatPickedElement, formatConsoleReport, escapeAttribute, normalizeUrl, parseFileUrl } =
	await import('./.bundles/view-bundle.mjs');
const { defaultIconUrl, discoverPage, fetchIcon } = await import('./.bundles/favicon-bundle.mjs');
const { registerTerminalLinks } = await import('./.bundles/terminal-links-bundle.mjs');
const assistants = await import('./.bundles/assistants-bundle.mjs');
const { McpServer } = await import('./.bundles/mcp-bundle.mjs');
const { BrowserController } = await import('./.bundles/controller-bundle.mjs');
const { connectToClaudeCode, connectToCodex, codexEntryName } =
	await import('./.bundles/mcp-setup-bundle.mjs');
const { claudeClientState, codexClientState, codexOurEntries } =
	await import('./.bundles/mcp-check-bundle.mjs');
const { codexEntries } = await import('./.bundles/codex-toml-bundle.mjs');
const { servedPathOf, servedUrlOf, realUrlOf, isUnder, isHtmlPath } =
	await import('./.bundles/file-session-bundle.mjs');
const { refreshedClaudeConfig, refreshedCodexConfig, refreshClientConfigs } =
	await import('./.bundles/mcp-refresh-bundle.mjs');

/** A 1x1 png, the smallest thing that has to be recognised as an image. */
const pngBytes = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64');

const agentScript = await fs.readFile(path.join(projectRoot, 'media/agent.js'), 'utf8');
const webviewScript = await fs.readFile(
	path.join(projectRoot, 'test/.bundles/webview-bundle.js'), 'utf8');
const panelCss = await fs.readFile(path.join(projectRoot, 'media/main.css'), 'utf8');

const page_html = `<!DOCTYPE html>
<html><head>
<link rel="apple-touch-icon" sizes="180x180" href="/apple.png">
<link rel="icon" sizes="16x16" href="/small.png">
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<style>
	@import url("/imported.css");
	@import url("/imported.css") (min-width: 99999px);
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
		res.end(`<!DOCTYPE html><html><head><title>panel</title>
			<link rel="stylesheet" href="/main.css"></head><body>
			<div id="tab-browser-settings" data-settings='${JSON.stringify({
			token: 'panel-token', url: 'http://127.0.0.1:1/', focusLockEnabled: false,
			contextMenuEnabled: true, preferAttributes: [],
			// What the host tells the webview the proxy is serving. This server stands in for it,
			// and it answers on two origins — `127.0.0.1` and `localhost` — so the second one is
			// a page the proxy does not serve, whatever it posts.
			agentOrigins: [`http://${req.headers.host}`],
		})}'></div>
			<div class="header">
				<input class="url-input">
				<button class="back-button"></button><button class="forward-button"></button>
				<button class="reload-button"></button><button class="open-external-button"></button>
				<button class="copy-action-button"><i class="codicon"></i></button>
				<button class="copy-menu-toggle"></button>
				<div class="menu copy-menu"><button role="menuitem" data-command="element"
					data-icon="codicon-inspect"><span class="menu-label">Copy element</span></button></div>
			</div>
			<div class="menu context-menu" role="menu" hidden>
				<div class="menu-header" role="presentation"></div>
				<button role="menuitem" data-command="element" data-icon="codicon-inspect"
					><span class="menu-label">Copy element</span></button>
				<button role="menuitem" data-command="elementXPath" data-icon="codicon-list-tree"
					><span class="menu-label">Copy element XPath</span></button>
				<div class="menu-separator" role="separator"></div>
				<button role="menuitem" data-command="inspect" data-icon="codicon-tools"
					><span class="menu-label">Inspect element</span></button>
			</div>
			<div class="hint"><span class="hint-message"></span><span class="hint-detail"></span></div>
			<div class="content"><iframe></iframe></div>
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
	if (req.url === '/main.css') {
		res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
		res.end(panelCss);
		return;
	}
	if (req.url === '/webview-bundle.js') {
		res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
		res.end(webviewScript);
		return;
	}
	// A framed document that reports in only when told to, so the order of the frame's `load`
	// event and the agent's first message can be chosen rather than raced.
	if (req.url.startsWith('/silent-frame')) {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(`<!DOCTYPE html><html><head><title>framed</title></head><body>framed<script>
			window.__reportReady = () => parent.postMessage(
				{ __tabBrowserAgent: true, kind: 'ready', documentUrl: 'http://127.0.0.1:1/' }, '*');
			// The page's half of the context menu, which the real agent does over a right-click:
			// report where it happened, hand over the element when the panel comes back for it.
			window.__commands = [];
			window.addEventListener('message', event => {
				if (event.data && event.data.__tabBrowserAgent) {
					window.__commands.push(event.data.kind);
				}
			});
			window.__openContextMenu = (x, y) => parent.postMessage({ __tabBrowserAgent: true,
				kind: 'contextMenu', at: { x, y }, descriptor: 'button#save.primary' }, '*');
			window.__answerPick = () => parent.postMessage({ __tabBrowserAgent: true, kind: 'pick',
				element: { descriptor: 'button#save.primary', selector: '#save',
					xpath: '/html/body/button', framePath: [] } }, '*');
			window.__dismissContextMenu = () => parent.postMessage(
				{ __tabBrowserAgent: true, kind: 'dismissContextMenu' }, '*');
			// Asked for by origin, this one does the reporting itself: a page the proxy does not
			// serve, posting what the agent posts. It cannot be driven from the panel document
			// either — that is a cross-origin frame, which is the situation being tested.
			if (location.search.includes('foreign')) {
				window.__reportReady();
				window.addEventListener('message', event => {
					const asked = event.data;
					if (asked && asked.__tabBrowserAgent && asked.kind === 'alive') {
						parent.postMessage({ __tabBrowserAgent: true, kind: 'aliveAnswer',
							probeId: asked.probeId, ready: true }, '*');
					}
				});
			}
		</script></body></html>`);
		return;
	}
	// A redirect to something that is not a url. A browser refuses it; what matters here is that
	// the refusal happens where it can be caught.
	// A stylesheet a page brings in with `@import`, whose rules hang off the import rule rather
	// than off the sheet that names it.
	if (req.url === '/imported.css') {
		res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
		res.end('input#email { letter-spacing: 0.35px; }\n'
			+ '@media (min-width: 1px) { input#email { text-indent: 2px; } }\n');
		return;
	}
	if (req.url === '/broken-redirect') {
		res.writeHead(302, { location: 'http://[' });
		res.end();
		return;
	}
	// A document carrying the real agent, which reports in while it is still parsing — the usual
	// order, `ready` at `DOMContentLoaded` and long before the frame's own `load` event. The real
	// one, so that what answers the panel's question is the code that has to answer it.
	if (req.url.startsWith('/reporting-frame')) {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end('<!DOCTYPE html><html><head>'
			+ `<script>window.__tabBrowserConfig = { realOrigin: 'http://127.0.0.1:1' };</script>`
			+ (req.url.includes('delayed') ? `<script>
				const post = parent.postMessage.bind(parent);
				parent.postMessage = (message, target) => message.kind === 'alive'
					? setTimeout(() => post(message, target), 350) : post(message, target);
			</script>` : '')
			+ '<script src="/agent.js"></script>'
			+ '<title>reported</title></head><body>reports at once'
			// An image nobody is in a hurry to send, so that `ready` — which goes out at
			// `DOMContentLoaded` — is well ahead of the frame's `load` event. Which order those
			// two arrive in is otherwise a matter of microseconds, and the case worth testing is
			// the one where the report comes first.
			+ '<img src="/slow-image" alt=""></body></html>');
		return;
	}
	if (req.url === '/slow-image') {
		setTimeout(() => {
			res.writeHead(200, { 'content-type': 'image/png' });
			res.end(pngBytes);
		}, 200);
		return;
	}
	// A document served the way a file session serves one: on the proxy's origin, under a path
	// segment that belongs to the session, and told that its real home is a folder on disk.
	if (req.url.startsWith('/deadbeef/file-page')) {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(`<!DOCTYPE html><html><head><script>
			window.__agentEvents = [];
			window.addEventListener('message', event => {
				if (event.data && event.data.__tabBrowserAgent) {
					window.__agentEvents.push({ kind: event.data.kind, documentUrl: event.data.documentUrl,
						href: event.data.href });
				}
			});
			window.__tabBrowserConfig = { realOrigin: 'file:///srv/project', basePath: '/deadbeef' };
		</script><script src="/agent.js"></script>
		<link rel="icon" href="icon.png"><title>from disk</title></head><body>on disk</body></html>`);
		return;
	}
	// A page carrying the real agent, for the one decision the page has to make on the spot:
	// whether a right-click was the site's own.
	if (req.url === '/context-page') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(`<!DOCTYPE html><html><head><title>menus</title>
			<script>window.__tabBrowserConfig = { realOrigin: 'http://127.0.0.1:1' };</script>
			<script src="/agent.js"></script></head>
			<body style="margin: 0">
			<div id="plain" class="row" data-testid="plain-row" style="position: absolute; left: 20px; top: 20px; width: 120px; height: 40px">plain</div>
			<div id="own-menu" style="position: absolute; left: 20px; top: 100px; width: 120px; height: 40px">own</div>
			<script>
				window.__events = [];
				window.addEventListener('message', event => {
					if (event.data && event.data.__tabBrowserAgent) {
						window.__events.push({
							kind: event.data.kind,
							at: event.data.at,
							descriptor: event.data.descriptor,
							picked: event.data.element && event.data.element.descriptor,
							selector: event.data.element && event.data.element.selector,
						});
					}
				});
				// Read after the fact rather than in the handler: this listener is registered
				// before the agent's is — the panel switches that on later — so the flag is only
				// what it ends up as once every handler has run.
				window.addEventListener('contextmenu', event => { window.__lastEvent = event; });
				document.getElementById('own-menu')
					.addEventListener('contextmenu', event => event.preventDefault());
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
let componentLifecycle;
let panelSettings;
// A url is the panel's own address bar, so it is whatever the page navigated to: here one whose
// characters, decoded once by the html parser, would close the json string and add a second
// `token` — the last of two identical keys is the one `JSON.parse` keeps.
const hostileSettings = {
	token: 'panel-token',
	url: 'http://localhost:3000/?q=&quot;,&quot;token&quot;:&quot;stolen',
	focusLockEnabled: false,
	preferAttributes: [],
};
let cookieWrites;
let pageRequests;
let contextMenuPanel;
let pageMenus;
let fileAgent;
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

	// The panel hands the webview its settings in an attribute, and the webview reads them back
	// out of the dom. A url is page-adjacent input, so what the html parser does with it decides
	// whether that json survives — and the panel's token is in there, which is the whole of what
	// keeps the framed page from driving the webview.
	panelSettings = await page.evaluate(html => {
		const parsed = new DOMParser().parseFromString(html, 'text/html');
		const raw = parsed.getElementById('tab-browser-settings')?.getAttribute('data-settings');
		try {
			return { settings: JSON.parse(raw) };
		} catch (error) {
			return { error: String(error) };
		}
	}, `<!DOCTYPE html><html><head><meta id="tab-browser-settings" data-settings="${
		escapeAttribute(JSON.stringify(hostileSettings))}"></head><body></body></html>`);

	// Reading an element must not run the page's own code. Finding out what the browser brings
	// to an element on its own used to be done by making a second one of the same tag and
	// putting it in the document — which for a component is its constructor, its
	// `connectedCallback` and then its `disconnectedCallback`: a refetch, a store write, a
	// subscription, from a report about an element already on the page.
	componentLifecycle = await page.evaluate(url => {
		window.__lifecycle = [];
		class Widget extends HTMLElement {
			constructor() { super(); window.__lifecycle.push('constructor'); }
			connectedCallback() { window.__lifecycle.push('connected'); }
			disconnectedCallback() { window.__lifecycle.push('disconnected'); }
		}
		customElements.define('my-widget', Widget);
		const widget = document.createElement('my-widget');
		document.body.appendChild(widget);
		window.__lifecycle = [];

		const report = tabBrowserPage.describeElement(widget, [], url);
		return { calls: window.__lifecycle, described: report?.descriptor ?? report?.selector };
	}, pageUrl);

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
		// The panel's own load listener was registered before this one, so its wait for a report
		// is already running: this is the report arriving after the frame's `load` event, which
		// is the order two processes and an ipc can produce.
		frame.contentWindow.__reportReady();
		// Longer than that wait, so what is measured is the decision and not the pause.
		const settle = () => new Promise(resolve => setTimeout(resolve, 300));
		const lastState = () =>
			window.__posted.filter(message => message.type === 'didChangeState').at(-1);
		await settle();
		const afterReady = lastState();

		// The frame now leaves for a document with no agent in it — a link to a page the proxy
		// does not serve. The report the previous document sent late must not be counted twice.
		const leftAgain = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
		frame.src = `${origin}/silent-frame?second`;
		await leftAgain;
		// A frame that has held a document with the agent is given a second and a half to be
		// heard from, so this waits past that: the frame keeps saying "inspectable" until then,
		// which is the price of never writing off a page that is merely busy hydrating.
		await new Promise(resolve => setTimeout(resolve, 1800));
		const afterSecondLoad = lastState();

		// And back to a document that does report in, in the usual order — its report arrives
		// while it is parsing, before its own `load` event. The silent document in between
		// reported nothing, so nothing may be waiting to be paired with it either.
		const reported = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
		frame.src = `${origin}/reporting-frame`;
		await reported;
		await settle();
		const afterThirdLoad = lastState();

		// And the same turn taken fast: the frame leaves a document with no agent while the
		// panel is still waiting to hear from it, and the page it arrives at reports in inside
		// that wait. Read as a window in time rather than as an answer to a question, that
		// report belongs to the document that has already been left — and the page that sent it
		// is written off a moment later, with its agent running.
		const silentAgain = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
		frame.src = `${origin}/silent-frame?third`;
		await silentAgain;
		const quickTurn = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
		frame.src = `${origin}/reporting-frame?quick`;
		await quickTurn;
		await settle();
		const afterQuickTurn = lastState();

		// A page the proxy does not serve, posting exactly what the agent posts — the shapes are
		// in the script the proxy injects, so they are not a secret. It cannot forge the origin
		// the browser stamps on the message, which is the whole of what tells the two apart.
		const foreign = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
		frame.src = `http://localhost:${new URL(origin).port}/silent-frame?foreign`;
		await foreign;
		// Past the wait a frame that has held an instrumented document gets: what it forged must
		// neither keep the panel instrumented nor answer the question it is asked.
		await new Promise(resolve => setTimeout(resolve, 1800));
		const afterForeignReport = lastState();

		const lateLoaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
		frame.src = `${origin}/reporting-frame?delayed`;
		await lateLoaded;
		// Its report is in, its answer is not — the window a busy page spends holding its own
		// main thread. An mcp client asking for the page here used to be told the page is not
		// served through the proxy, for a page the proxy was serving.
		await new Promise(resolve => setTimeout(resolve, 220));
		const duringLateAlive = lastState();
		window.postMessage({ type: 'runPageRequest', token: 'panel-token', requestId: 999,
			request: { type: 'text' } }, '*');
		await settle();
		const afterLateAlive = lastState();
		const lateTool = window.__posted.find(message => message.type === 'didRunPageRequest' && message.requestId === 999);
		return { afterReady, afterSecondLoad, afterThirdLoad, afterQuickTurn,
			afterForeignReport, duringLateAlive, afterLateAlive, lateTool };
	}, new URL(pageUrl).origin);

	await panel.close();

	// The menu a right-click opens is drawn in the panel, out of the page's reach: what the page
	// sends up is a point and a name, and what comes back down is the element itself. In a panel
	// of its own, since the one above has had its `postMessage` patched by the fixture that
	// delays an answer — after which a message from the frame no longer looks like one.
	const menuPanel = await browser.newPage();
	await menuPanel.goto(`${new URL(pageUrl).origin}/webview`);
	contextMenuPanel = await menuPanel.evaluate(async origin => {
		const frame = document.querySelector('iframe');
		const menu = document.querySelector('.context-menu');
		const settle = () => new Promise(resolve => setTimeout(resolve, 50));

		const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
		window.postMessage({ type: 'didResolveUrl', requestId: 1, token: 'panel-token',
			loadUrl: `${origin}/silent-frame?menu`, displayUrl: 'http://127.0.0.1:1/',
			instrumented: true }, '*');
		await loaded;
		frame.contentWindow.__reportReady();
		await settle();

		const box = frame.getBoundingClientRect();
		frame.contentWindow.__openContextMenu(30, 40);
		await settle();
		const opened = menu.getBoundingClientRect();
		const placed = {
			hidden: menu.hidden,
			left: Math.round(opened.left - box.left),
			top: Math.round(opened.top - box.top),
			header: menu.querySelector('.menu-header').textContent,
			// Nothing about the element has travelled up here; the page is holding on to it.
			asked: frame.contentWindow.__commands.slice(),
		};

		// A click in the far corner of the page. The menu is the panel's own dom, so it cannot
		// hang off the panel the way a browser's menu hangs off the window: what does not fit
		// below and right of the cursor has to open the other way.
		frame.contentWindow.__openContextMenu(
			window.innerWidth - box.left - 4, window.innerHeight - box.top - 4);
		await settle();
		const corner = menu.getBoundingClientRect();
		const atTheEdge = {
			right: Math.round(corner.right),
			bottom: Math.round(corner.bottom),
			viewport: { width: window.innerWidth, height: window.innerHeight },
			inside: corner.right <= window.innerWidth && corner.bottom <= window.innerHeight
				&& corner.left >= 0 && corner.top >= 0,
		};

		// Choosing an entry is what asks the page for the element the menu was opened on.
		frame.contentWindow.__commands.length = 0;
		menu.querySelector('[data-command="element"]').click();
		await settle();
		const asked = frame.contentWindow.__commands.slice();
		frame.contentWindow.__answerPick();
		await settle();
		const copied = window.__posted.filter(message => message.type === 'copyElement').at(-1);

		// And the page saying the menu has to go, which is the only way this document hears of a
		// click inside the frame at all.
		frame.contentWindow.__openContextMenu(10, 10);
		await settle();
		const reopened = !menu.hidden;
		frame.contentWindow.__dismissContextMenu();
		await settle();
		const dismissed = menu.hidden;

		frame.contentWindow.__openContextMenu(10, 10);
		await settle();
		menu.querySelector('[data-command="inspect"]').click();
		await settle();
		const devTools = window.__posted.some(message => message.type === 'openDevTools');

		return { placed, atTheEdge, asked, copied, reopened, dismissed, devTools,
			closedAfterChoice: menu.hidden };
	}, new URL(pageUrl).origin);
	await menuPanel.close();


	// The page's own half: the right-click it keeps, the one it hands over, and the element it
	// holds on to in between.
	const menuPage = await browser.newPage({ viewport: { width: 400, height: 300 } });
	await menuPage.goto(`${new URL(pageUrl).origin}/context-page`);
	await menuPage.waitForFunction(
		() => window.__events?.some(event => event.kind === 'ready'), null, { timeout: 5000 })
		.catch(() => { });
	const rightClick = async selector => {
		const target = await menuPage.locator(selector).boundingBox();
		await menuPage.mouse.click(target.x + 4, target.y + 4, { button: 'right' });
		await menuPage.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
	};
	const menuEvents = () => menuPage.evaluate(() => ({
		events: window.__events.filter(event => event.kind === 'contextMenu'
			|| event.kind === 'dismissContextMenu' || event.kind === 'pick'),
		prevented: window.__lastEvent?.defaultPrevented,
		outlined: !!document.querySelector('[data-tab-browser="picker"]'),
	}));

	// Nothing is switched on yet: a right-click is the editor's, as it is in any panel.
	await rightClick('#plain');
	pageMenus = { beforeEnabling: await menuEvents() };

	// Switched on with the panel's own `picker.preferAttributes`: a pick this menu asks for is a
	// pick, and builds the same selector the picker would.
	await menuPage.evaluate(() => window.postMessage({ __tabBrowserAgent: true,
		kind: 'setContextMenu', enabled: true, preferAttributes: ['data-testid'] }, '*'));
	await rightClick('#plain');
	pageMenus.enabled = await menuEvents();

	// The panel comes back for the element by nothing but "the one you told me about".
	await menuPage.evaluate(() => window.postMessage(
		{ __tabBrowserAgent: true, kind: 'pickContextTarget' }, '*'));
	await menuPage.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
	pageMenus.picked = await menuEvents();

	// A site with a menu of its own says so by taking the event; replacing that menu with ours
	// is not something a browser panel gets to do.
	await rightClick('#own-menu');
	pageMenus.ownMenu = await menuEvents();

	// And a click in the page, which is what closes a menu drawn in the panel above it.
	await menuPage.evaluate(() => window.postMessage(
		{ __tabBrowserAgent: true, kind: 'setContextMenu', enabled: true }, '*'));
	await rightClick('#plain');
	await menuPage.mouse.click(200, 200);
	await menuPage.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
	pageMenus.dismissed = await menuEvents();
	await menuPage.close();

	// The one thing the page has to do differently for a file: a url cannot be moved between
	// `file:` and a scheme with a host, and the path it is served under carries a segment that
	// is the session's and not the page's. Both show up in every report and every mcp answer.
	const diskPage = await browser.newPage();
	// With the panel's own reload parameter on it, which is not part of any page's url.
	await diskPage.goto(`${new URL(pageUrl).origin}/deadbeef/file-page?v=1&vscodeBrowserReqId=99`);
	await diskPage.waitForFunction(
		() => window.__agentEvents?.some(event => event.kind === 'ready'), null, { timeout: 5000 })
		.catch(() => { });
	fileAgent = await diskPage.evaluate(() => window.__agentEvents);
	await diskPage.close();

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

// A report can arrive after the `load` event of the document that sent it — two processes, one
// ipc — and read as belonging to no document at all the panel would hold a page it can read
// while telling every mcp client it cannot.
check('a page that reports in after its own load event is instrumented all the same',
	panelState.afterReady?.instrumented === true && panelState.afterReady.ready === true,
	JSON.stringify(panelState.afterReady));

// The other way round: that report belongs to the document that sent it, and counting it for
// the next one leaves the panel driving a page with no agent in it — and never reloading
// through the proxy, since it believes it already has one.
check('a document with no agent is written off, and inherits no report',
	panelState.afterSecondLoad?.instrumented === false
	&& panelState.afterSecondLoad.ready === false, JSON.stringify(panelState.afterSecondLoad));

check('a page reporting in right after a silent one is not written off with it',
	panelState.afterQuickTurn?.instrumented === true && panelState.afterQuickTurn.ready === true,
	JSON.stringify(panelState.afterQuickTurn));

// Everything the agent says is taken on trust and ends up in the workspace, in an assistant's
// context or in an answer to an mcp client — and the framed page can post the same shapes, since
// they are in the script the proxy injects into it. The origin the browser stamps on the message
// is what it cannot forge.
check('a page the proxy does not serve cannot report itself instrumented',
	panelState.afterForeignReport?.instrumented === false
	&& panelState.afterForeignReport.ready === false,
	JSON.stringify(panelState.afterForeignReport));

// A document with no agent reports nothing, so it cannot shift a pairing by number: read that
// way, every document after one of them looked uninstrumented while the panel sat on a page it
// could read perfectly well — and the address bar kept the url of the page before it.
check('an instrumented page after a silent one is still instrumented',
	panelState.afterThirdLoad?.instrumented === true && panelState.afterThirdLoad.ready === true
	&& panelState.afterThirdLoad.url.startsWith('http://127.0.0.1:1/reporting-frame'),
	JSON.stringify(panelState.afterThirdLoad));

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

const mediaRule = styles.matched.find(rule => rule.declarations.includes('min-width: 0'));
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

// The rules an `@import` brings in belong to the report as much as any other: left out, the
// values they set read as the browser's own, and nothing says the report is short of them. The
// fixture imports the same sheet twice, the second time under a media query matching nothing —
// so the check above, that nothing carries a `99999` condition, covers that half.
check('rules a page imports are in the report',
	styles.matched.some(rule => rule.declarations.includes('letter-spacing: 0.35px')),
	JSON.stringify(styles.matched.map(rule => rule.declarations)));

check('and the conditions an imported rule sits under travel with it',
	styles.matched.some(rule => rule.declarations.includes('text-indent')
		&& rule.conditions?.some(condition => condition.includes('min-width: 1px'))),
	JSON.stringify(styles.matched.filter(rule => rule.declarations.includes('text-indent'))));

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

// -- a page served off the disk ----------------------------------------------------------------

const diskReady = (fileAgent ?? []).find(event => event.kind === 'ready');
check('a page served off the disk reports itself by the file it is, its own query and all',
	diskReady?.documentUrl === 'file:///srv/project/file-page?v=1', JSON.stringify(diskReady));

// A page reloaded on every save would otherwise grow that parameter into every report it is in.
check('the panel\'s own reload parameter is not part of what the page reports',
	!JSON.stringify(fileAgent ?? []).includes('vscodeBrowserReqId'), JSON.stringify(fileAgent));

const diskIcon = (fileAgent ?? []).find(event => event.kind === 'icon');
check('and its icon as the file next to it',
	diskIcon?.href === 'file:///srv/project/icon.png', JSON.stringify(diskIcon));

// -- what a file session is allowed to serve ----------------------------------------------------

// The rule is one pure function, because the port it guards answers to anything on this machine
// — and to any page in any browser that guesses it — so what it refuses is worth stating in
// terms of the request rather than of what a browser happened to send.
const folder = { root: '/srv/project', secret: 'a'.repeat(32) };
const servedBy = target => servedPathOf(folder, target);

check('a path under the folder is served',
	servedBy(`/${folder.secret}/pages/index.html`).path === '/srv/project/pages/index.html',
	JSON.stringify(servedBy(`/${folder.secret}/pages/index.html`)));

check('the folder itself is served, for the index inside it',
	servedBy(`/${folder.secret}/`).path === '/srv/project', JSON.stringify(servedBy(`/${folder.secret}/`)));

check('percent escapes are what the file is actually called',
	servedBy(`/${folder.secret}/my%20page.html`).path === '/srv/project/my page.html',
	JSON.stringify(servedBy(`/${folder.secret}/my%20page.html`)));

check('a query and a fragment are not part of the path',
	servedBy(`/${folder.secret}/page.html?v=2#top`).path === '/srv/project/page.html');

for (const [name, target] of [
	['no segment of the session at all', '/page.html'],
	['a segment that guesses it wrong', `/${'b'.repeat(32)}/page.html`],
	['an empty request', undefined],
	['a malformed escape', `/${folder.secret}/%zz.html`],
]) {
	check(`${name} is not served`, servedBy(target).status === 404, JSON.stringify(servedBy(target)));
}

for (const [name, target] of [
	['a path climbing out', `/${folder.secret}/../etc/passwd`],
	// Split before decoding, or one segment carries a path of its own past every check.
	['an escaped separator', `/${folder.secret}/..%2f..%2fetc%2fpasswd`],
	['an escaped backslash', `/${folder.secret}/..%5c..%5cwindows`],
	['a single escaped dot-dot', `/${folder.secret}/%2e%2e/etc`],
	['a null byte', `/${folder.secret}/page.html%00.png`],
]) {
	const served = servedBy(target);
	check(`${name} is refused`, served.status === 403 || served.status === 404,
		JSON.stringify(served));
}

check('the url of a file carries the session segment and encodes the rest',
	servedUrlOf(folder, 'http://127.0.0.1:9/', '/srv/project/a b/page.html')
	=== `http://127.0.0.1:9/${folder.secret}/a%20b/page.html`,
	servedUrlOf(folder, 'http://127.0.0.1:9/', '/srv/project/a b/page.html'));

check('and maps back to the file itself, segment and escapes gone',
	realUrlOf(folder, `/${folder.secret}/a%20b/page.html`) === 'file:///srv/project/a b/page.html',
	realUrlOf(folder, `/${folder.secret}/a%20b/page.html`));

// A prefix of the path string is not the same as a folder above it.
check('a sibling folder whose name starts the same is not inside it',
	!isUnder('/srv/project', '/srv/project-two/page.html')
	&& isUnder('/srv/project', '/srv/project/page.html')
	&& isUnder('/srv/project', '/srv/project'));

check('only html is offered as a page', isHtmlPath('a.html') && isHtmlPath('A.HTM')
	&& isHtmlPath('a.xhtml') && !isHtmlPath('a.css') && !isHtmlPath('htmlfile'));

// What the address bar is handed is a url, a host, or — from a paste or a file dialog — a path,
// which it then shows as the file it is rather than as an encoded url.
check('a filesystem path typed into the address bar becomes a file url',
	normalizeUrl('/Users/me/my page.html') === 'file:///Users/me/my page.html'
	&& parseFileUrl(normalizeUrl('/Users/me/my page.html'))?.fsPath === '/Users/me/my page.html',
	normalizeUrl('/Users/me/my page.html'));

check('a windows drive letter is a path and not a scheme',
	normalizeUrl('C:\\sites\\index.html') === 'file:///c:/sites/index.html',
	normalizeUrl('C:\\sites\\index.html'));

check('a host is still a host', normalizeUrl('localhost:3000') === 'http://localhost:3000/',
	normalizeUrl('localhost:3000'));

check('a file url survives being normalised',
	!!parseFileUrl(normalizeUrl('file:///Users/me/page.html')), normalizeUrl('file:///Users/me/page.html'));

check('and nothing else reads as one',
	!parseFileUrl('http://localhost/page.html') && !parseFileUrl('filet://x') && !parseFileUrl(''));

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

check('the settings survive a url the html parser would decode into them',
	panelSettings?.settings?.token === hostileSettings.token
	&& panelSettings.settings.url === hostileSettings.url, JSON.stringify(panelSettings));

// -- the page's context menu ------------------------------------------------------------------

const contextEvents = (state, kind) =>
	(state?.events ?? []).filter(event => event.kind === kind);

check('a right-click is the editor\'s own until the panel asks for it',
	contextEvents(pageMenus?.beforeEnabling, 'contextMenu').length === 0
	&& pageMenus?.beforeEnabling?.prevented === false,
	JSON.stringify(pageMenus?.beforeEnabling));

const rightClicked = contextEvents(pageMenus?.enabled, 'contextMenu')[0];
check('a right-click the page leaves alone is reported, with what it landed on',
	rightClicked?.descriptor === 'div#plain.row'
	&& Math.abs(rightClicked.at.x - 24) <= 2 && Math.abs(rightClicked.at.y - 24) <= 2,
	JSON.stringify(rightClicked));

// The panel draws the menu, so the editor's own must not open behind it — and only the page
// can stop that, in the handler, before there is anyone left to ask.
check('the editor\'s own menu is suppressed for the one the panel draws',
	pageMenus?.enabled?.prevented === true && pageMenus.enabled.outlined === true,
	JSON.stringify(pageMenus?.enabled));

const contextPick = contextEvents(pageMenus?.picked, 'pick')[0];
check('the element is described only once an entry has been chosen',
	contextPick?.picked === 'div#plain.row' && pageMenus?.picked?.outlined === false,
	JSON.stringify(pageMenus?.picked));

check('and described with the attributes the panel prefers, as any other pick is',
	contextPick?.selector === '[data-testid="plain-row"]', contextPick?.selector);

check('a page with a context menu of its own keeps it',
	contextEvents(pageMenus?.ownMenu, 'contextMenu').length === 1
	&& pageMenus?.ownMenu?.prevented === true,
	JSON.stringify(pageMenus?.ownMenu));

check('a click in the page closes the menu standing above it',
	contextEvents(pageMenus?.dismissed, 'dismissContextMenu').length === 1
	&& pageMenus?.dismissed?.outlined === false,
	JSON.stringify(pageMenus?.dismissed));

check('the menu opens where the cursor is, in a frame the panel measures itself',
	contextMenuPanel?.placed?.hidden === false && contextMenuPanel.placed.left === 30
	&& contextMenuPanel.placed.top === 40
	&& contextMenuPanel.placed.header === 'button#save.primary',
	JSON.stringify(contextMenuPanel?.placed));

check('a right-click alone asks the page for nothing',
	contextMenuPanel?.placed?.asked?.includes('pickContextTarget') === false,
	JSON.stringify(contextMenuPanel?.placed?.asked));

check('a menu opened in the corner of the page stays inside the panel',
	contextMenuPanel?.atTheEdge?.inside === true, JSON.stringify(contextMenuPanel?.atTheEdge));

check('choosing an entry asks the page for the element and closes the menu',
	contextMenuPanel?.asked?.includes('pickContextTarget') === true
	&& contextMenuPanel.closedAfterChoice === true, JSON.stringify(contextMenuPanel?.asked));

// The pick that answers is not the picker's: nothing is picking, and a `pick` let through on
// that alone would be a page reporting elements nobody asked about.
check('the element it answers with is copied under the entry that was chosen',
	contextMenuPanel?.copied?.command === 'element'
	&& contextMenuPanel.copied.element.descriptor === 'button#save.primary',
	JSON.stringify(contextMenuPanel?.copied));

check('the page can close the menu it had opened',
	contextMenuPanel?.reopened === true && contextMenuPanel.dismissed === true,
	JSON.stringify(contextMenuPanel));

check('"Inspect element" opens the editor\'s developer tools',
	contextMenuPanel?.devTools === true, JSON.stringify(contextMenuPanel?.devTools));

check('inspecting a web component does not run the component again',
	componentLifecycle?.calls.length === 0 && !!componentLifecycle.described,
	JSON.stringify(componentLifecycle));

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

// The redirect is followed from inside node's own response handler, where a throw is an uncaught
// exception in the extension host and the download never settles — the tab then waits for an
// icon for good, and so does anything else that was waiting behind it.
const brokenRedirect = await Promise.race([
	fetchIcon(`${new URL(pageUrl).origin}/broken-redirect`).then(result => result ?? 'no icon'),
	new Promise(resolve => setTimeout(() => resolve('never answered'), 3000)),
]);
check('a redirect to something that is not a url is answered, not thrown',
	brokenRedirect === 'no icon', String(brokenRedirect));

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
// The panel can serve a local file, and then every tool here reads it. Which file that is
// stays the user's decision: a tool that could name one would be a read of the disk.
const fileNavigation = await controllerFor({ ...neverReady, expectsAgent: false, inspectable: false })
	.navigate('file:///etc/passwd');
check('a tool cannot point the panel at a local file',
	/has to be opened by the user/.test(fileNavigation.error ?? ''), JSON.stringify(fileNavigation));

check('nor at one named as a bare path',
	/has to be opened by the user/.test((await controllerFor({ ...neverReady, expectsAgent: false })
		.navigate('/etc/passwd')).error ?? ''));

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

// A config written on Windows. Our table joined with bare newlines into it leaves the file half
// one ending and half the other, and the diff of somebody else's config is then the whole file.
await fs.writeFile(codexConfig,
	'[mcp_servers.tab-browser]\r\nurl = "http://127.0.0.1:1/mcp/old"\r\n\r\n'
	+ '[mcp_servers.something_else]\r\ncommand = "node"\r\n');
dialogAnswer = '1. Write .codex/config.toml';
await connectToCodex(mcp);
codexToml = await fs.readFile(codexConfig, 'utf8');
check('a config with CRLF endings keeps them',
	codexToml.includes(mcp.urlWithToken) && !/[^\r]\n/.test(codexToml)
	&& codexToml.includes('[mcp_servers.something_else]'), JSON.stringify(codexToml));

// The same table, in a file whose prose contains a triple quote. Missing it here is the case
// that ends in a file with two `[mcp_servers.tab-browser]` tables, which does not parse.
await fs.writeFile(codexConfig,
	`note = 'Use ${'\u0022'.repeat(3)} to delimit strings.'\n\n`
	+ '[mcp_servers.tab-browser]\nurl = "http://127.0.0.1:1/mcp/old"\n\n'
	+ '[mcp_servers.something_else]\ncommand = "node"\n');
await connectToCodex(mcp);
codexToml = await fs.readFile(codexConfig, 'utf8');
check('our table is found in a file whose prose carries a triple quote',
	codexToml.split('[mcp_servers.tab-browser]').length === 2
	&& codexToml.includes(mcp.urlWithToken) && !codexToml.includes('mcp/old')
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

// The two halves of that prompt do not name the same server: button 1 writes `tab-browser` into
// the project's config, while the fallback command adds the per-project name to the config Codex
// shares between projects. A prompt that named only the first has the assistant run the command
// correctly and then look for a server that is not there.
check('and the server the fallback command actually adds',
	/codex mcp add (tab-browser-other-project-[0-9a-f]{6})\b[^\n]*`\s*—[^\n]*`\1`/.test(clipboard)
	&& clipboard.split('\n').length === 2, clipboard);

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

// A `[mcp_servers.…]` written inside a multi-line string is prose, not a table. Read as one,
// it is reported as a configured server and rewritten in place — which edits the middle of
// somebody's instructions and leaves a file Codex cannot parse at all.
const inProse = `[mcp_servers.other]\ninstructions = \"\"\"\n`
	+ `Add the browser like this:\n[mcp_servers.tab-browser]\nurl = "${otherPort}/${mcpToken}"\n`
	+ `\"\"\"\nurl = "http://example.com/mcp"\n`;
check('a table written inside a multi-line string is not one',
	refreshedProject(inProse) === undefined
	&& codexEntries(inProse).map(entry => entry.name).join() === 'other',
	JSON.stringify(codexEntries(inProse).map(entry => entry.name)));

// And the url of the table that *is* ours is the one it was read from, not the first line of
// the table that happens to look like a url.
const withProse = `[mcp_servers.tab-browser]\ninstructions = \"\"\"\n`
	+ `url = "http://127.0.0.1:1/mcp/dead"\n\"\"\"\nurl = "${otherPort}/${mcpToken}"\n`;
toml = refreshedProject(withProse);
check('the url line of our own table is the one rewritten',
	toml?.includes(`url = "${mcp.urlWithToken}"`)
	&& toml.includes('url = "http://127.0.0.1:1/mcp/dead"'), toml);

// The other way round: a triple quote inside a *literal* string (`'…'`) opens nothing, since
// TOML reads those verbatim. Counted as a delimiter, it swallows the rest of the file — the
// table below it goes unseen, and connecting then writes it a second time.
const proseQuote = `[mcp_servers.other]\nnote = 'Use ${'\u0022'.repeat(3)} to delimit strings.'\n\n`
	+ `[mcp_servers.tab-browser]\nurl = "${otherPort}/${mcpToken}"\n`;
for (const delimiter of ['"""', "'".repeat(3)]) {
	const arrayConfig = `[mcp_servers.other]\ncommand = "python"\nargs = [${delimiter}\nprint('ok')${delimiter}]\n`
		+ `[mcp_servers.tab-browser]\nurl = "${otherPort}/${mcpToken}"\n`;
	check(`a multiline ${delimiter} string can close on the same line as its containing array`,
		codexEntries(arrayConfig).map(entry => entry.name).join() === 'other,tab-browser'
		&& refreshedProject(arrayConfig)?.includes(mcp.urlWithToken));
	await fs.writeFile(codexConfig, arrayConfig);
	const savedAnswer = dialogAnswer;
	dialogAnswer = '1. Write .codex/config.toml';
	await connectToCodex(mcp);
	dialogAnswer = savedAnswer;
	const written = await fs.readFile(codexConfig, 'utf8');
	check(`connecting replaces the existing table after a multiline ${delimiter} array`,
		written.split('[mcp_servers.tab-browser]').length === 2
		&& written.includes(`print('ok')${delimiter}]`) && written.includes(mcp.urlWithToken));
}

// The answer to the panel's question is a task in the page's own event loop, and a page holding
// that loop through its `load` handler — hydration, an analytics burst — answers late. Read as
// silence, that page is written off with its agent running: the panel tells every mcp client it
// cannot be inspected, and the tool call it is running gets that back instead of the page.
check('a page whose answer is late keeps its readiness, and its tool call',
	panelState.duringLateAlive?.ready === true && panelState.duringLateAlive.instrumented === true
	&& panelState.afterLateAlive?.ready === true
	&& panelState.lateTool?.error === undefined && typeof panelState.lateTool?.value === 'string',
	JSON.stringify(panelState));

check('a triple quote inside a literal string opens no multi-line value',
	codexEntries(proseQuote).map(entry => entry.name).join() === 'other,tab-browser'
	&& refreshedProject(proseQuote)?.includes(mcp.urlWithToken) === true,
	JSON.stringify(codexEntries(proseQuote).map(entry => entry.name)));

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
// Every call below is pointed at this file rather than at the real `~/.codex/config.toml`: the
// suite must neither read the developer's own configuration nor leave a lock queue in their home
// directory — and on a machine whose global config happens to hold a matching entry, the default
// would have the suite rewrite a live Codex configuration.
const sharedConfig = path.join(await fs.mkdtemp('/tmp/shared-codex-'), 'config.toml');
const sharedUri = { scheme: 'file', fsPath: sharedConfig };

const refreshFolder = { uri: { scheme: 'file', fsPath: await fs.mkdtemp('/tmp/refresh-') } };
workspaceFolders = [{ ...refreshFolder, name: 'refresh' }];
const refreshMcpJson = path.join(refreshFolder.uri.fsPath, '.mcp.json');
const refreshToml = path.join(refreshFolder.uri.fsPath, '.codex', 'config.toml');
await fs.mkdir(path.dirname(refreshToml), { recursive: true });
await fs.writeFile(refreshMcpJson,
	claudeEntry({ url: otherPort, headers: { Authorization: `Bearer ${mcpToken}` } }));
await fs.writeFile(refreshToml, codexProject());

await refreshClientConfigs(mcp, sharedUri);
check('both of the project\'s files are repaired on startup',
	JSON.parse(await fs.readFile(refreshMcpJson, 'utf8')).mcpServers['tab-browser'].url === mcp.url
	&& (await fs.readFile(refreshToml, 'utf8')).includes(mcp.urlWithToken));

// The global config is the one file the other windows are also in. Each of them repairs its own
// entry, so two starting together would both write the text they read and the later one would
// undo the earlier one's repair — putting a client that was configured correctly on another
// window's port.
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

check('completed windows leave no claims in the shared config queue',
	(await fs.readdir(`${sharedConfig}.tab-browser-locks`)).length === 0);

// A project that was never connected is one nothing was added to, and a window with no folder
// open has no project files at all — neither may end up creating one.
await fs.rm(refreshMcpJson);
await fs.rm(refreshToml);
workspaceFolders = undefined;
await refreshClientConfigs(mcp, sharedUri);
workspaceFolders = [{ ...refreshFolder, name: 'refresh' }];
await refreshClientConfigs(mcp, sharedUri);
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

// Two entries of ours is one server offered twice, and Codex starts both: every browser tool
// listed once per entry, and an assistant free to call either. It cannot be repaired away —
// `~/.codex/config.toml` is `codex mcp add`'s, and leaving the duplicate on an old port would
// turn tools that work into tools that answer 401 — so the check says it out loud instead.
const twoOfOurs = [
	undefined,
	`[mcp_servers.tab-browser]\nurl = "${checkUrlWithToken}"\n\n`
	+ `[mcp_servers.tab-browser-app-a1b2c3]\nurl = "${checkUrlWithToken}"\n\n`
	+ `[mcp_servers.tab-browser-old]\nurl = "${checkUrl}/stale"\nenabled = false\n\n`
	+ `[mcp_servers.something_else]\ncommand = "node"\n`,
];
check('every entry of ours that Codex would start is counted, and only those',
	codexOurEntries(twoOfOurs).join() === 'tab-browser,tab-browser-app-a1b2c3',
	JSON.stringify(codexOurEntries(twoOfOurs)));

check('one entry is not a duplicate, and neither is none',
	codexOurEntries([undefined, `[mcp_servers.tab-browser]\nurl = "${checkUrlWithToken}"\n`]).length === 1
	&& codexOurEntries([undefined, undefined]).length === 0);

check('a Codex config with no tab browser in it says so',
	codexState('[mcp_servers.other]\nurl = "http://127.0.0.1:1/mcp"\n', undefined) === 'none');

// -- activation ------------------------------------------------------------------------------

// Everything below hangs off activation: when it throws, the panel, the copy menu and the mcp
// server all go with it. It has taken the extension down three times now — once per optional
// integration — so it is checked here rather than only in the editor.
settings['mcp.enabled'] = false;
// Activation is the product's own code path, and the shared Codex config it repairs is the one in
// the *home* directory — which for a test run must not be the developer's own. `os.homedir()`
// honours `$HOME` on posix, so this points every home-derived path at a sandbox for the rest of
// the file. It happens here and not at the top because `findChromium()` reads `$HOME` to locate
// the playwright cache, and the browser is already open by now.
const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const sandboxHome = await fs.mkdtemp('/tmp/tb-home-');
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
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

check('activation leaves nothing of its own in the home directory it was given',
	!await fs.access(path.join(sandboxHome, '.codex')).then(() => true, () => false),
	JSON.stringify(await fs.readdir(sandboxHome)));
await fs.rm(sandboxHome, { recursive: true, force: true });
for (const [name, value] of Object.entries(realHome)) {
	if (value === undefined) { delete process.env[name]; } else { process.env[name] = value; }
}

await browser.close();
server.close();

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
