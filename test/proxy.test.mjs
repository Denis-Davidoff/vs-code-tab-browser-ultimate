import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { BrowserProxy } from './.bundles/proxy-bundle.mjs';
import { Uri } from './vscode-mock.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const scriptPath = '/__tab-browser__/agent.js';

let failures = 0;
function check(name, ok, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
	if (!ok) { failures++; }
}

// --- an "app server" that behaves like a hostile-ish dev server -----------------------------
const app = http.createServer((req, res) => {
	const url = new URL(req.url, 'http://x');
	if (url.pathname === '/') {
		const html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'">
			<title>t</title></head><body><a href="${'http://127.0.0.1:' + app.address().port}/abs">abs</a>
			<script>window.__host = ${JSON.stringify(req.headers.host)}</script></body></html>`;
		res.writeHead(200, {
			'content-type': 'text/html; charset=utf-8',
			'content-security-policy': "default-src 'none'",
			'x-frame-options': 'DENY',
			'set-cookie': ['sid=1; Domain=example.com; Secure; SameSite=None; Path=/'],
			'etag': 'W/"abc"',
		});
		res.end(html);
		return;
	}
	if (url.pathname.startsWith('/legacy')) {
		res.writeHead(200, { 'content-type': url.pathname === '/legacy'
			? 'text/html; charset=windows-1251' : 'text/html' });
		res.end(Buffer.concat([
			Buffer.from(url.pathname === '/legacy-equiv'
				? '<html><head><meta http-equiv="content-type" content="text/html; charset=windows-1251"></head><body>'
				: '<html><head><meta charset="windows-1251"></head><body>'),
			Buffer.from('cff0e8e2e5f2', 'hex'), Buffer.from('</body></html>'),
		]));
		return;
	}
	if (url.pathname === '/gz') {
		res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
		res.end(zlib.gzipSync('<html><head></head><body>gz</body></html>'));
		return;
	}
	// A compressed response the server never finishes: the socket dies mid-body.
	if (url.pathname === '/gz-cut') {
		res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
		res.write(zlib.gzipSync('<html><head></head><body>gz</body></html>').subarray(0, 12));
		setTimeout(() => res.socket.destroy(), 30);
		return;
	}
	if (url.pathname === '/account/start') { res.writeHead(302, { location: 'login' }); res.end(); return; }
	if (url.pathname === '/cookies') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
		return;
	}
	if (url.pathname === '/redir-local') { res.writeHead(302, { location: `http://127.0.0.1:${app.address().port}/` }); res.end(); return; }
	if (url.pathname === '/redir-remote') { res.writeHead(302, { location: `http://127.0.0.1:${other.address().port}/` }); res.end(); return; }
	if (url.pathname === '/asset.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('console.log(1)'); return; }
	if (url.pathname === '/echo') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ method: req.method, headers: req.headers }));
		return;
	}
	res.writeHead(404); res.end('nope');
});

/** Another server on the same interface, i.e. what this session's cookies must never reach. */
const otherRequests = [];
const other = http.createServer((req, res) => {
	otherRequests.push({ url: req.url, cookie: req.headers.cookie ?? null });
	res.writeHead(200, { 'content-type': 'text/html' });
	res.end('<html><head></head><body>other</body></html>');
});

// A websocket-ish upgrade endpoint.
app.on('upgrade', (req, socket) => {
	socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
	socket.write('hello-from-upstream');
});

await new Promise(r => app.listen(0, '127.0.0.1', r));
await new Promise(r => other.listen(0, '127.0.0.1', r));
const appOrigin = `http://127.0.0.1:${app.address().port}`;

const proxy = new BrowserProxy(Uri.file(projectRoot));

// --- tests ---------------------------------------------------------------------------------
const proxiedRoot = await proxy.getProxiedUrl(`${appOrigin}/?a=1#frag`);
check('proxied url keeps path, query and hash', proxiedRoot.endsWith('/?a=1#frag'), proxiedRoot);
check('proxied url has a different port', new URL(proxiedRoot).port !== String(app.address().port), proxiedRoot);
check('isProxiedUrl recognises its own url', proxy.isProxiedUrl(proxiedRoot));
check('isProxiedUrl rejects the real url', !proxy.isProxiedUrl(appOrigin));
check('toRealUrl round-trips', proxy.toRealUrl(proxiedRoot) === `${appOrigin}/?a=1#frag`, proxy.toRealUrl(proxiedRoot));

const rootRes = await fetch(proxiedRoot.split('#')[0], { redirect: 'manual' });
const rootBody = await rootRes.text();
check('agent script tag injected', rootBody.includes(scriptPath));
check('bootstrap config carries the real origin', rootBody.includes(`"realOrigin":"${appOrigin}"`), rootBody.slice(0, 300));
check('injection happens inside <head>', /<head[^>]*>\s*<script data-tab-browser="bootstrap"/.test(rootBody));
check('csp header stripped', !rootRes.headers.has('content-security-policy'));
check('x-frame-options stripped', !rootRes.headers.has('x-frame-options'));
check('csp meta tag stripped', !/http-equiv\s*=\s*"Content-Security-Policy"/i.test(rootBody), rootBody.slice(0, 400));
check('absolute links rewritten to the proxy', rootBody.includes(`${new URL(proxiedRoot).origin}/abs`));
check('upstream sees its own Host header', rootBody.includes(`window.__host = "127.0.0.1:${app.address().port}"`), rootBody.match(/__host = "[^"]*"/)?.[0]);
const cookie = rootRes.headers.getSetCookie()[0];
check('set-cookie: Domain removed', !/domain=/i.test(cookie), cookie);
check('set-cookie: Secure removed', !/(^|;)\s*secure\s*(;|$)/i.test(cookie), cookie);
check('set-cookie: SameSite=None downgraded', /samesite=lax/i.test(cookie), cookie);
check('html not cached', rootRes.headers.get('cache-control') === 'no-store');
check('etag dropped so we always get a body to inject', !rootRes.headers.has('etag'));
check('content-length matches rewritten body',
	Number(rootRes.headers.get('content-length')) === Buffer.byteLength(rootBody), rootRes.headers.get('content-length'));

for (const route of ['/legacy', '/legacy-meta', '/legacy-equiv']) {
	const response = await fetch(new URL(route, proxiedRoot));
	check(`legacy HTML is transcoded to UTF-8 (${route})`,
		response.headers.get('content-type') === 'text/html; charset=utf-8'
		&& (await response.text()).includes('Привет'));
}
const head = await fetch(new URL('/gz', proxiedRoot), { method: 'HEAD' });
check('HEAD of compressed HTML preserves status and headers without decoding a body',
	head.status === 200 && head.headers.get('content-encoding') === 'gzip' && await head.text() === '');

const gz = await fetch(new URL('/gz', proxiedRoot));
const gzBody = await gz.text();
check('gzip html decoded and injected', gzBody.includes('agent.js') && gzBody.includes('gz'), gzBody.slice(0, 200));
check('content-encoding dropped for rewritten html', !gz.headers.has('content-encoding'));

// A dead upstream has to become an answer. `pipe` does not pass the abort on to the decoder,
// which then waits for an end that is not coming — and so does whoever opened the tab.
const cut = await Promise.race([
	fetch(new URL('/gz-cut', proxiedRoot)).then(answer => answer.status, () => 'network error'),
	new Promise(resolve => setTimeout(() => resolve('never answered'), 5000)),
]);
check('a compressed response that is cut off is answered, not left hanging',
	cut !== 'never answered', String(cut));

const asset = await fetch(new URL('/asset.js', proxiedRoot));
check('non-html passes through untouched', (await asset.text()) === 'console.log(1)');

const localRedir = await fetch(new URL('/redir-local', proxiedRoot), { redirect: 'manual' });
check('same-origin redirect becomes relative', localRedir.headers.get('location') === '/', localRedir.headers.get('location'));

const remoteRedir = await fetch(new URL('/redir-remote', proxiedRoot), { redirect: 'manual' });
const remoteLocation = remoteRedir.headers.get('location');
check('cross-origin redirect points at a second proxy',
	!!remoteLocation && proxy.isProxiedUrl(remoteLocation) && !remoteLocation.includes(String(other.address().port)),
	remoteLocation);
check('following the cross-origin redirect reaches the other server',
	(await (await fetch(remoteLocation)).text()).includes('other'));

const relativeRedir = await fetch(new URL('/account/start', proxiedRoot), { redirect: 'manual' });
check('a relative redirect resolves against the request, not the origin',
	relativeRedir.headers.get('location') === '/account/login', relativeRedir.headers.get('location'));

// --- cookies belong to one session only ------------------------------------------------------
check('set-cookie is renamed with the session prefix', /^__tb\d+_sid=1/.test(cookie), cookie);

const sessionPrefix = cookie.slice(0, cookie.indexOf('sid='));
const cookieEcho = async header => (await (await fetch(new URL('/cookies', proxiedRoot), {
	headers: { cookie: header },
})).json()).cookie;

check('the session gets its own cookies back under their real names',
	await cookieEcho(`${sessionPrefix}sid=1`) === 'sid=1', await cookieEcho(`${sessionPrefix}sid=1`));

check('a cookie belonging to another proxied site is not forwarded',
	await cookieEcho('__tb1_other=2; plain=3') === null,
	await cookieEcho('__tb1_other=2; plain=3'));

check('only the foreign cookies are dropped',
	await cookieEcho(`__tb1_other=2; ${sessionPrefix}sid=1`) === 'sid=1',
	await cookieEcho(`__tb1_other=2; ${sessionPrefix}sid=1`));

// --- a path is a path, never another server ---------------------------------------------------
// `//host/path` is a valid request target, but resolved against the origin it names a host: a
// page could ask this session to forward its cookies — the HttpOnly ones included, which it
// cannot read itself — to any server it likes.
otherRequests.length = 0;
const smuggled = await fetch(
	`${new URL(proxiedRoot).origin}//127.0.0.1:${other.address().port}/steal`,
	{ headers: { cookie: `${sessionPrefix}sid=1` } });
check('a request target naming another host stays on the session\'s own server',
	otherRequests.length === 0 && smuggled.status === 404,
	`${smuggled.status} ${JSON.stringify(otherRequests)}`);

// --- one server per origin, however the requests arrive -----------------------------------
// Two navigations to one origin can land before either has a port: the panel's own and an mcp
// client's, say. Two servers would leave the first url unrecognised and the spare listening
// after dispose, so the origin has to be claimed before the first await.
const fresh = http.createServer((_req, res) => { res.writeHead(204); res.end(); });
await new Promise(r => fresh.listen(0, '127.0.0.1', r));
const freshOrigin = `http://127.0.0.1:${fresh.address().port}`;
const [firstUrl, secondUrl] = await Promise.all([
	proxy.getProxiedUrl(`${freshOrigin}/one`),
	proxy.getProxiedUrl(`${freshOrigin}/two`),
]);
check('parallel requests for one origin share a single proxy server',
	new URL(firstUrl).port === new URL(secondUrl).port
	&& proxy.isProxiedUrl(firstUrl) && proxy.isProxiedUrl(secondUrl),
	`${firstUrl} ${secondUrl}`);
fresh.close();

// --- ipv6 ----------------------------------------------------------------------------------
// `URL` keeps the brackets an ipv6 literal is written with, and `http.request` would resolve
// `[::1]` as a name: a dev server listening on it answered ENOTFOUND through the proxy.
let ipv6 = 'skipped: no ipv6 loopback';
try {
	const six = http.createServer((_req, res) => {
		res.writeHead(200, { 'content-type': 'text/html' });
		res.end('<html><head></head><body>v6</body></html>');
	});
	await new Promise((resolve, reject) => {
		six.once('error', reject);
		six.listen(0, '::1', resolve);
	});
	const sixUrl = await proxy.getProxiedUrl(`http://[::1]:${six.address().port}/`);
	const sixBody = await (await fetch(sixUrl)).text();
	ipv6 = sixBody.includes('v6') && sixBody.includes(scriptPath) ? 'ok' : sixBody.slice(0, 200);
	six.close();
	check('a server on the ipv6 loopback is reachable through the proxy', ipv6 === 'ok', ipv6);
} catch {
	console.log(`SKIP  ipv6 (${ipv6})`);
}

const script = await fetch(new URL(scriptPath, proxiedRoot));
const scriptBody = await script.text();
check('agent script is served by the proxy',
	script.headers.get('content-type')?.includes('javascript') && scriptBody.length > 1000);
check('agent script carries the message channel and console patch',
	scriptBody.includes('__tabBrowserAgent') && scriptBody.includes('unhandledrejection'));

const echo = await fetch(new URL('/echo', proxiedRoot), {
	method: 'POST',
	headers: { origin: new URL(proxiedRoot).origin, referer: `${new URL(proxiedRoot).origin}/page` },
	body: 'x=1',
});
const echoed = await echo.json();
check('POST body and method forwarded', echoed.method === 'POST');
check('same-origin requests reach upstream without an Origin header',
	!('origin' in echoed.headers), echoed.headers.origin);
check('Referer rewritten to the real origin', echoed.headers.referer === `${appOrigin}/page`, echoed.headers.referer);
check('conditional request headers dropped', !('if-none-match' in echoed.headers));

// An Origin from somewhere else is still rewritten rather than dropped.
const foreignEcho = await (await fetch(new URL('/echo', proxiedRoot), {
	method: 'POST',
	headers: { origin: 'http://example.com' },
	body: 'x=1',
})).json();
// Not ours to rewrite: forging it would hide a genuine cross-origin request from upstream.
check('a foreign Origin is passed through untouched',
	foreignEcho.headers.origin === 'http://example.com', foreignEcho.headers.origin);

// A dev server that rejects anything carrying an Origin (VS Code's Live Preview does) must
// still be usable.
const strict = http.createServer((req, res) => {
	if (req.headers.origin) { res.writeHead(401); res.end('Unauthorized'); return; }
	res.writeHead(200, { 'content-type': 'text/javascript' });
	res.end('ok');
});
await new Promise(r => strict.listen(0, '127.0.0.1', r));
const strictProxied = await proxy.getProxiedUrl(`http://127.0.0.1:${strict.address().port}/mod.js`);
const strictRes = await fetch(strictProxied, { headers: { origin: new URL(strictProxied).origin } });
check('an origin-rejecting server answers 200 through the proxy',
	strictRes.status === 200 && (await strictRes.text()) === 'ok', strictRes.status);
strict.close();

// websocket upgrade
const wsResult = await new Promise(resolve => {
	const req = http.request({
		host: '127.0.0.1', port: new URL(proxiedRoot).port, path: '/hmr',
		headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'x' },
	});
	req.on('upgrade', (res, socket, head) => {
		// Upstream's payload can ride along in the same segment as the 101 response.
		if (head?.length) {
			resolve({ status: res.statusCode, data: head.toString() });
			socket.destroy();
			return;
		}
		socket.once('data', chunk => { resolve({ status: res.statusCode, data: chunk.toString() }); socket.destroy(); });
	});
	req.on('error', e => resolve({ error: e.message }));
	req.end();
	setTimeout(() => resolve({ error: 'timeout' }), 3000);
});
check('websocket upgrade proxied', wsResult.status === 101 && wsResult.data === 'hello-from-upstream', JSON.stringify(wsResult));

let rejected;
try { await proxy.getProxiedUrl('file:///etc/hosts'); } catch (e) { rejected = e.message; }
check('non-http urls rejected', !!rejected, rejected);

const unreachable = await proxy.getProxiedUrl('http://127.0.0.1:1/');
const bad = await fetch(unreachable);
check('unreachable upstream yields a 502 page', bad.status === 502 && (await bad.text()).includes('Could not reach'));

// --- a page off the disk --------------------------------------------------------------------

// The panel frames the page, and an `<iframe>` cannot load `file:` — nor could anything be
// injected into it if it could. So a file is served by a session of its own, out of the folder
// it belongs to and nothing else.
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-browser-files-'));
await fs.mkdir(path.join(folder, 'assets'));
await fs.writeFile(path.join(folder, 'page.html'),
	'<!DOCTYPE html><html><head><link rel="stylesheet" href="assets/app.css">'
	+ `<title>on disk</title></head><body><a href="file://${folder}/other.html">next</a>`
	+ '<p>from the file system</p></body></html>');
await fs.writeFile(path.join(folder, 'assets', 'app.css'), 'p { color: rebeccapurple }');
await fs.writeFile(path.join(folder, 'index.html'), '<html><head></head><body>the index</body></html>');
await fs.writeFile(path.join(path.dirname(folder), 'outside.txt'), 'not yours');

const filePage = await proxy.getServedFileUrl(Uri.file(path.join(folder, 'page.html')));
const filePageRes = await fetch(filePage);
const filePageBody = await filePageRes.text();

check('a local file is served over http', filePageRes.status === 200
	&& filePageBody.includes('from the file system'), String(filePageRes.status));

check('the agent is injected into it like into any other page',
	filePageBody.includes(scriptPath) && /<head[^>]*>\s*<script data-tab-browser="bootstrap"/.test(filePageBody),
	filePageBody.slice(0, 200));

check('the page is told its real url is the folder it came from',
	filePageBody.includes(`"realOrigin":"file://${folder}"`), filePageBody.slice(0, 400));

// The path a file session answers under starts with a segment of its own, so the page needs to
// be told which one it is: without that, every url it reports carries it.
check('and which part of the path is the session\'s own',
	new RegExp(`"basePath":"/[0-9a-f]{32}"`).test(filePageBody), filePageBody.slice(0, 400));

check('an absolute file url in the markup is rewritten onto the session',
	filePageBody.includes(`${new URL(filePage).origin}/${new URL(filePage).pathname.split('/')[1]}/other.html`),
	filePageBody.match(/href="[^"]*"/g)?.join(' '));

check('the panel maps it back to the file, not to the url it is served under',
	proxy.toRealUrl(filePage) === `file://${folder}/page.html`, proxy.toRealUrl(filePage));

const css = await fetch(new URL('./assets/app.css', filePage));
check('a stylesheet the page pulls in is served with its own content type',
	css.status === 200 && css.headers.get('content-type') === 'text/css; charset=utf-8'
	&& (await css.text()).includes('rebeccapurple'), String(css.status));

check('nothing off the disk is cached, since saving the file is the point',
	css.headers.get('cache-control') === 'no-store' && filePageRes.headers.get('cache-control') === 'no-store');

const secret = new URL(filePage).pathname.split('/')[1];
const origin = new URL(filePage).origin;

// The port answers to anything on this machine, and to any page that guesses it. Without the
// segment the session would be a read of the project to whoever asks first.
const guessed = await fetch(`${origin}/page.html`);
check('a request without the session\'s own segment is not served', guessed.status === 404, String(guessed.status));

const wrongSecret = await fetch(`${origin}/${'0'.repeat(32)}/page.html`);
check('nor is one that guesses it wrong', wrongSecret.status === 404, String(wrongSecret.status));

for (const [name, target] of [
	['a path climbing out of the folder', `${origin}/${secret}/../outside.txt`],
	['an escaped separator, which must not become one', `${origin}/${secret}/..%2foutside.txt`],
	['a doubly escaped one', `${origin}/${secret}/%2e%2e%2foutside.txt`],
]) {
	const refused = await fetch(target, { redirect: 'manual' });
	check(`${name} is refused`, refused.status === 403 || refused.status === 404
		|| !(await refused.text()).includes('not yours'), `${refused.status}`);
}

const folderRequest = await fetch(`${origin}/${secret}/`);
check('a folder is answered with its index.html, as a static server would',
	folderRequest.status === 200 && (await folderRequest.text()).includes('the index'),
	String(folderRequest.status));

const missing = await fetch(`${origin}/${secret}/nothing-here.html`);
check('a file that is not there is a 404 and not an empty page', missing.status === 404, String(missing.status));

const written = await fetch(`${origin}/${secret}/page.html`, { method: 'PUT', body: 'x' });
check('a file session only reads', written.status === 405, String(written.status));

// Hot reload: a page off the disk has no dev server in front of it, so saving the file — or
// something it pulled in — is the only signal there is. Only the files the page actually asked
// for are watched; a project is full of files it has nothing to do with.
const reloads = [];
proxy.onDidChangeServedFile(root => reloads.push(root));
await new Promise(resolve => setTimeout(resolve, 200));
await fs.writeFile(path.join(folder, 'assets', 'app.css'), 'p { color: teal }');
await new Promise(resolve => setTimeout(resolve, 400));
check('saving a file the page pulled in reports the folder it was served from',
	reloads.includes(folder), JSON.stringify(reloads));

reloads.length = 0;
await fs.writeFile(path.join(folder, 'untouched.html'), '<html></html>');
await new Promise(resolve => setTimeout(resolve, 400));
check('a file this page never asked for reports nothing', reloads.length === 0, JSON.stringify(reloads));

const secondPage = await proxy.getServedFileUrl(Uri.file(path.join(folder, 'index.html')));
check('a second file in the same folder is served by the same session',
	new URL(secondPage).origin === origin && new URL(secondPage).pathname.split('/')[1] === secret,
	secondPage);

let refusedScheme;
try { await proxy.getServedFileUrl(Uri.parse('vscode-vfs://github/o/r/index.html')); }
catch (error) { refusedScheme = error.message; }
check('a file that is not on this machine cannot be served', !!refusedScheme, refusedScheme);

proxy.dispose();
app.close(); other.close();
await fs.rm(folder, { recursive: true, force: true });
await fs.rm(path.join(path.dirname(folder), 'outside.txt'), { force: true });
console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
