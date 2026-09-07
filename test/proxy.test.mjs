import * as http from 'node:http';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { BrowserProxy } from './.bundles/proxy-bundle.mjs';

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
	if (url.pathname === '/gz') {
		res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
		res.end(zlib.gzipSync('<html><head></head><body>gz</body></html>'));
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

const proxy = new BrowserProxy({ value: projectRoot });

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

const gz = await fetch(new URL('/gz', proxiedRoot));
const gzBody = await gz.text();
check('gzip html decoded and injected', gzBody.includes('agent.js') && gzBody.includes('gz'), gzBody.slice(0, 200));
check('content-encoding dropped for rewritten html', !gz.headers.has('content-encoding'));

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

proxy.dispose();
app.close(); other.close();
console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
