/** Trusted sandbox entry point. It has no chat transport, credentials, or extension API. */
import { nonceVisualizationDocument } from './visualizationDocument';

const inheritedNonce = (document.currentScript as HTMLScriptElement | null)?.nonce || '';

let channel: MessagePort | undefined;
let frame: HTMLIFrameElement | undefined;
let activeRevision = '';

window.addEventListener('message', event => {
	if (event.source === window.parent && event.data?.type === 'ai-browser-visualization-connect' && event.ports.length === 1 && !channel) {
		channel = event.ports[0];
		channel.onmessage = incoming => {
			const data = incoming.data;
			if (!data || typeof data !== 'object') { return; }
			if (data.type === 'render' && typeof data.html === 'string' && data.html.length <= 1_000_000
				&& typeof data.revision === 'string' && /^[a-f0-9]{64}$/.test(data.revision)) {
				activeRevision = data.revision;
				const next = document.createElement('iframe');
				next.setAttribute('sandbox', 'allow-scripts');
				next.referrerPolicy = 'no-referrer';
				next.title = 'Visualization content';
				// Both documents are self-contained. Neither may load a script resource.
				const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'";
				const initial = scriptJson({ state: data.state ?? null, theme: data.theme });
				next.srcdoc = nonceVisualizationDocument(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><style>${baseStyles}</style><script>(${visualizationRuntime.toString()})(${initial});<\/script></head><body>${data.html}</body></html>`, inheritedNonce);
				const old = frame;
				frame = next;
				document.body.append(next);
				old?.remove();
			} else if (data.type === 'theme') {
				frame?.contentWindow?.postMessage({ type: 'visualization-theme', theme: data.theme }, '*');
			}
		};
		channel.start();
		channel.postMessage({ type: 'ready' });
		return;
	}
	if (!frame || event.source !== frame.contentWindow || !channel || !event.data || typeof event.data !== 'object') { return; }
	const data = event.data;
	if (data.type === 'resize' && Number.isFinite(data.height)) {
		channel.postMessage({ type: 'resize', height: Math.max(120, Math.min(1200, data.height)), revision: activeRevision });
	} else if (data.type === 'state') {
		try {
			if (JSON.stringify(data.state).length <= 16_384) { channel.postMessage({ type: 'state', state: data.state, revision: activeRevision }); }
		} catch { /* Unsupported state is ignored. */ }
	} else if (data.type === 'error' && typeof data.message === 'string') {
		channel.postMessage({ type: 'error', message: data.message.slice(0, 300), revision: activeRevision });
	}
});

function scriptJson(value: unknown): string { return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }

/** Serialized into the untrusted view; keep this function self-contained. */
function visualizationRuntime(initial: { state: unknown; theme?: Record<string, string> }): void {
	const send = (data: unknown) => window.parent.postMessage(data, '*');
	const theme = (colors?: Record<string, string>) => {
		if (!colors || typeof colors !== 'object') { return; }
		for (const [key, value] of Object.entries(colors)) {
			if (/^--[a-z0-9-]{1,50}$/.test(key) && typeof value === 'string' && value.length < 160 && !/[;{}<>]/.test(value)) {
				document.documentElement.style.setProperty(key, value);
			}
		}
	};
	theme(initial.theme);
	const api = {
		widgetState: initial.state,
		setWidgetState: async (value: unknown) => { api.widgetState = value; send({ type: 'state', state: value }); },
	};
	Object.defineProperty(window, 'openai', { value: api, writable: false });
	window.addEventListener('message', event => {
		if (event.source === window.parent && event.data?.type === 'visualization-theme') { theme(event.data.theme); }
	});
	window.addEventListener('error', event => send({ type: 'error', message: event.message }));
	window.addEventListener('unhandledrejection', event => send({ type: 'error', message: String(event.reason) }));
	window.addEventListener('DOMContentLoaded', () => {
		let scheduled = false;
		const resize = () => {
			if (scheduled) { return; }
			scheduled = true;
			requestAnimationFrame(() => {
				scheduled = false;
				send({ type: 'resize', height: Math.ceil(document.body.getBoundingClientRect().height) });
			});
		};
		new ResizeObserver(resize).observe(document.body);
		resize();
	});
}

const baseStyles = `
:root{color-scheme:light dark;--background:#fff;--foreground:#222;--primary:#2868ce;--border:#bbb;--muted:#eee;--muted-foreground:#666;--font-size-base:14px}
*{box-sizing:border-box}body{margin:0;padding:12px;background:var(--background);color:var(--foreground);font:var(--font-size-base)/1.5 system-ui,sans-serif;overflow-wrap:anywhere}
svg,canvas,img{max-width:100%}button,input,select{font:inherit}button{cursor:pointer}button,.btn{border:1px solid var(--border);border-radius:6px;padding:5px 10px;background:var(--background);color:var(--foreground)}
.card{padding:12px;background:var(--card,var(--background));border:1px solid var(--border);border-radius:8px}.text-small{font-size:.86em}.text-muted{color:var(--muted-foreground)}.tabular-nums{font-variant-numeric:tabular-nums}.btn-primary{background:var(--primary);color:var(--primary-foreground,#fff)}
`;
