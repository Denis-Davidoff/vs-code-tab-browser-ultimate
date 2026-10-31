import type { VisualizationReference, VisualizationSnapshot } from '../src/chat/visualizationProtocol';
import { updateArtifactViews, type ArtifactActions } from './artifactViews';
import { updateImageViews } from './imageViews';
import { nonceVisualizationDocument } from './visualizationDocument';

interface View {
	readonly element: HTMLElement;
	readonly title: HTMLElement;
	readonly status: HTMLElement;
	readonly frame: HTMLIFrameElement;
	readonly run: HTMLButtonElement;
	port?: MessagePort;
	revision?: string;
	ready: boolean;
	state?: unknown;
	ref: VisualizationReference;
	html?: string;
	timer?: ReturnType<typeof setTimeout>;
	stopped?: boolean;
	pauseReason?: string;
	runtimeError?: string;
}

const groups = new WeakMap<HTMLElement, Map<number, View>>();
const live = new Set<View>();
let observer: MutationObserver | undefined;
let themeObserver: MutationObserver | undefined;

/** Frames keep their browsing contexts while surrounding assistant text streams. */
export function updateVisualizationViews(container: HTMLElement, references: readonly VisualizationReference[], snapshots: Readonly<Record<string, VisualizationSnapshot>>, actions: ArtifactActions = {}): void {
	const artifacts = updateArtifactViews(container, references, snapshots, actions);
	const images = updateImageViews(container, references, snapshots);
	let views = groups.get(container);
	if (!views) { views = new Map(); groups.set(container, views); }
	for (const [at, view] of views) {
		if (!references.some(ref => ref.at === at && !ref.kind)) { dispose(view); view.element.remove(); views.delete(at); }
	}
	for (const ref of references.filter(ref => !ref.kind)) {
		let view = views.get(ref.at);
		if (!view) {
			view = createView(ref);
			views.set(ref.at, view);
			container.append(view.element);
		}
		if (view.ref.revision !== ref.revision) { view.runtimeError = undefined; }
		view.ref = ref;
		view.title.textContent = ref.title;
		view.frame.title = ref.title;
		view.element.classList.toggle('visualization-wide', !!ref.wide);
		view.html = ref.revision ? snapshots[ref.revision]?.html : undefined;
		view.status.textContent = view.stopped ? view.pauseReason || 'Visualization stopped.' : ref.error || view.runtimeError || (view.html === undefined ? 'This saved visualization is unavailable.' : '');
		if (view.html === undefined && view.frame.isConnected) { dispose(view); }
		else if (view.html !== undefined && !view.stopped && !view.frame.isConnected) { attach(view); }
		view.run.textContent = view.frame.isConnected ? 'Stop' : 'Run';
		if (view.ready) { render(view); }
	}
	// Keep mixed HTML/image cards in the order of their assistant references.
	let previous: HTMLElement | undefined;
	for (const ref of [...references].sort((a, b) => a.at - b.at)) {
		const element = (ref.kind === 'image' ? images.get(ref.at) : ref.kind ? artifacts.get(ref.at) : views.get(ref.at))?.element;
		if (!element) { continue; }
		element.dataset.presentationAt = String(ref.at);
		const next = previous ? previous.nextSibling : container.firstChild;
		if (next !== element) { container.insertBefore(element, next); }
		previous = element;
	}
}

function createView(ref: VisualizationReference): View {
	const element = document.createElement('section');
	element.className = 'visualization-card';
	const header = document.createElement('div');
	header.className = 'visualization-header';
	const title = document.createElement('span');
	const toggle = document.createElement('button');
	toggle.type = 'button'; toggle.textContent = 'Expand'; toggle.className = 'ghost';
	toggle.addEventListener('click', () => { const expanded = element.classList.toggle('visualization-expanded'); toggle.textContent = expanded ? 'Collapse' : 'Expand'; });
	const stop = document.createElement('button');
	stop.type = 'button'; stop.textContent = 'Stop'; stop.className = 'ghost';
	stop.addEventListener('click', () => {
		if (view.frame.isConnected) { view.stopped = true; view.pauseReason = undefined; dispose(view); status.textContent = 'Visualization stopped.'; stop.textContent = 'Run'; }
		else if (view.html !== undefined) { attach(view); status.textContent = view.ref.error || ''; stop.textContent = 'Stop'; }
	});
	header.append(title, toggle, stop);
	const status = document.createElement('div'); status.className = 'visualization-status'; status.setAttribute('role', 'status');
	const frame = document.createElement('iframe');
	frame.title = ref.title;
	frame.setAttribute('sandbox', 'allow-scripts');
	frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; usb 'none'");
	frame.referrerPolicy = 'no-referrer';
	frame.loading = 'lazy';
	const renderer = document.querySelector<HTMLMetaElement>('meta[name="ai-browser-visualization-renderer"]')?.content;
	const embedded = document.querySelector<HTMLMetaElement>('meta[name="ai-browser-visualization-srcdoc"]')?.content;
	const nonce = document.querySelector<HTMLMetaElement>('meta[name="ai-browser-visualization-nonce"]')?.content;
	if (embedded && nonce) { frame.srcdoc = nonceVisualizationDocument(atob(embedded), nonce); }
	else { frame.src = renderer || new URL('visualization.html', document.baseURI).href; }
	const view: View = { element, title, status, frame, run: stop, ready: false, ref };
	frame.addEventListener('load', () => {
		clearTimeout(view.timer);
		view.port?.close();
		view.ready = false; view.revision = undefined;
		const channel = new MessageChannel();
		view.port = channel.port1;
		view.timer = setTimeout(() => { status.textContent = 'The visualization renderer did not start. Reload the chat after updating the extension.'; }, 8000);
		channel.port1.onmessage = event => {
			const message = event.data;
			if (!message || typeof message !== 'object') { return; }
			if (message.type === 'ready') { clearTimeout(view.timer); view.ready = true; render(view); return; }
			if (message.revision !== view.revision) { return; }
			if (message.type === 'resize' && Number.isFinite(message.height)) { frame.style.height = `${Math.max(120, Math.min(1200, message.height))}px`; }
			else if (message.type === 'state') {
				try { if (JSON.stringify(message.state).length <= 16_384) { view.state = message.state; } } catch { /* Ignore non-JSON widget state. */ }
			} else if (message.type === 'error' && typeof message.message === 'string') { view.runtimeError = message.message.slice(0, 300); status.textContent = view.runtimeError ?? ''; }
		};
		channel.port1.start();
		frame.contentWindow?.postMessage({ type: 'ai-browser-visualization-connect' }, '*', [channel.port2]);
	});
	element.append(header, status);
	live.add(view);
	observer ??= new MutationObserver(() => { for (const item of live) { if (!item.element.isConnected) { dispose(item); } } });
	observer.observe(document.body, { childList: true, subtree: true });
	if (!themeObserver) {
		themeObserver = new MutationObserver(() => { for (const item of live) { if (item.ready) { render(item); } } });
		themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
		themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
	}
	return view;
}

function render(view: View): void {
	if (!view.ref.revision || view.html === undefined) { return; }
	const colors = theme();
	if (view.revision !== view.ref.revision) {
		view.revision = view.ref.revision;
		view.port?.postMessage({ type: 'render', revision: view.revision, html: view.html, state: view.state, theme: colors });
	} else { view.port?.postMessage({ type: 'theme', theme: colors }); }
}

function attach(view: View): void {
	const active = [...live].filter(item => item.frame.isConnected);
	if (active.length >= 8) {
		const oldest = active[0];
		oldest.stopped = true;
		oldest.pauseReason = 'Paused to free resources. Press Run to reopen.';
		dispose(oldest);
		oldest.status.textContent = oldest.pauseReason;
		oldest.run.textContent = 'Run';
	}
	view.stopped = false; view.pauseReason = undefined;
	live.add(view);
	view.element.insertBefore(view.frame, view.status);
}

function dispose(view: View): void {
	clearTimeout(view.timer);
	view.port?.close(); view.port = undefined; view.ready = false;
	view.frame.remove(); live.delete(view);
}

function theme(): Record<string, string> {
	const styles = getComputedStyle(document.body);
	const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
	const foreground = styles.color || '#222';
	const background = read('--vscode-sideBar-background', read('--vscode-editor-background', '#fff'));
	return {
		'--background': background, '--foreground': foreground, '--card': background, '--card-foreground': foreground,
		'--muted': read('--vscode-input-background', background), '--muted-foreground': read('--vscode-descriptionForeground', foreground),
		'--border': read('--vscode-input-border', '#888'), '--primary': read('--vscode-button-background', '#2868ce'),
		'--primary-foreground': read('--vscode-button-foreground', '#fff'), '--secondary': background, '--secondary-foreground': foreground,
		'--accent': read('--vscode-focusBorder', '#2868ce'), '--accent-foreground': foreground,
		...Object.fromEntries(['blue', 'orange', 'green', 'red', 'purple', 'yellow'].flatMap((color, index) => {
			const value = read(`--vscode-charts-${color}`, ['#438ee8', '#dc8b34', '#62a66c', '#d75b5b', '#aa78cf', '#b5a12d'][index]);
			return [[`--${color}`, value], [`--viz-series-${index + 1}`, value]];
		})),
	};
}
