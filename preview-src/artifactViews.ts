import type { ArtifactSnapshot, VisualizationReference, VisualizationSnapshot, TableData } from '../src/chat/visualizationProtocol';

export interface ArtifactActions {
	download?(revision: string, artifact: ArtifactSnapshot): void;
	openLink?(url: string, external: boolean): void;
	sourceLink?(url: string, title: string): HTMLElement;
	openLinkLabel?: string;
	externalLinkLabel?: string;
}
interface View {
	readonly element: HTMLElement;
	readonly title: HTMLElement;
	readonly body: HTMLElement;
	readonly status: HTMLElement;
	readonly download: HTMLButtonElement;
	revision?: string;
	objectUrl?: string;
	media?: HTMLMediaElement;
	renderError?: string;
}
const groups = new WeakMap<HTMLElement, Map<number, View>>();
const live = new Set<View>();
let observer: MutationObserver | undefined;

/** Downloads are initiated only by a user gesture; media stays local to the viewer. */
export function downloadArtifact(artifact: ArtifactSnapshot): void {
	const url = URL.createObjectURL(new Blob([decode(artifact.base64)], { type: 'application/octet-stream' }));
	const link = document.createElement('a'); link.href = url; link.download = artifact.name;
	document.body.append(link); link.click(); link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function decode(base64: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}
function release(view: View): void {
	view.media?.pause();
	view.media?.removeAttribute('src');
	view.media?.load();
	view.media = undefined;
	if (view.objectUrl) { URL.revokeObjectURL(view.objectUrl); view.objectUrl = undefined; }
	live.delete(view);
}
export function updateArtifactViews(container: HTMLElement, references: readonly VisualizationReference[], snapshots: Readonly<Record<string, VisualizationSnapshot>>, actions: ArtifactActions): Map<number, View> {
	let views = groups.get(container);
	if (!views) { views = new Map(); groups.set(container, views); }
	const refs = references.filter(ref => ref.kind && ref.kind !== 'image');
	for (const [at, view] of views) {
		if (!refs.some(ref => ref.at === at)) { release(view); view.element.remove(); views.delete(at); }
	}
	for (const ref of refs) {
		let view = views.get(ref.at);
		if (!view) {
			const element = document.createElement('section'); element.className = 'visualization-card artifact-card';
			const header = document.createElement('div'); header.className = 'visualization-header';
			const title = document.createElement('span');
			const download = document.createElement('button'); download.type = 'button'; download.textContent = 'Download'; download.className = 'ghost';
			const body = document.createElement('div'); body.className = 'artifact-body';
			const status = document.createElement('div'); status.className = 'visualization-status'; status.setAttribute('role', 'status');
			header.append(title, download); element.append(header, body, status); container.append(element);
			view = { element, title, download, body, status }; views.set(ref.at, view);
		}
		view.title.textContent = ref.title;
		const saved = ref.revision ? snapshots[ref.revision]?.artifact : undefined;
		const artifact = saved?.kind === ref.kind ? saved : undefined;
		const revision = artifact ? ref.revision : undefined;
		view.download.disabled = !artifact;
		view.download.onclick = artifact && ref.revision ? () => (actions.download ?? ((_revision, value) => downloadArtifact(value)))(ref.revision!, artifact) : null;
		if (revision !== view.revision) {
			release(view); view.revision = revision; view.renderError = undefined; view.body.replaceChildren();
			if (artifact) {
				try { fill(view, artifact, actions); } catch { view.renderError = 'The saved artifact could not be displayed. You can download the original file.'; view.status.textContent = view.renderError; continue; }
			}
		}
		view.status.textContent = ref.error || view.renderError || (artifact ? '' : 'This saved artifact is unavailable.');
	}
	observer ??= new MutationObserver(() => { for (const view of live) { if (!view.element.isConnected) { release(view); view.revision = undefined; } } });
	observer.observe(document.body, { childList: true, subtree: true });
	return views;
}
function fill(view: View, artifact: ArtifactSnapshot, actions: ArtifactActions): void {
	const details = document.createElement('div'); details.className = 'artifact-details';
	details.textContent = `${artifact.name} · ${artifact.bytes < 1_000_000 ? `${Math.ceil(artifact.bytes / 1000)} KB` : `${(artifact.bytes / 1_000_000).toFixed(1)} MB`}`;
	view.body.append(details);
	if (artifact.kind === 'audio' || artifact.kind === 'video') {
		const media = document.createElement(artifact.kind); media.controls = true; media.preload = 'metadata';
		media.setAttribute('aria-label', view.title.textContent || artifact.name);
		view.objectUrl = URL.createObjectURL(new Blob([decode(artifact.base64)], { type: artifact.mimeType }));
		media.src = view.objectUrl; view.media = media;
		media.addEventListener('error', () => { view.renderError = 'Playback is unavailable for this format or codec. Download the file to open it in another player.'; view.status.textContent = view.renderError; });
		view.body.append(media); live.add(view);
	} else if (artifact.kind === 'table' && artifact.table) {
		view.body.append(tableView(artifact.table));
	} else if (artifact.kind === 'sources' && artifact.sources) {
		const list = document.createElement('ol'); list.className = 'artifact-sources';
		for (const source of artifact.sources) {
			const url = new URL(source.url);
			if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { continue; }
			const item = document.createElement('li');
			const link = actions.sourceLink?.(url.href, source.title) ?? document.createElement('a');
			if (link instanceof HTMLAnchorElement) {
				link.href = url.href; link.textContent = source.title; link.target = '_blank'; link.rel = 'noopener noreferrer';
				if (actions.openLink) { link.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); actions.openLink!(url.href, false); }); }
			}
			const address = document.createElement('div'); address.className = 'artifact-source-url'; address.textContent = url.href;
			item.append(link, address);
			if (source.description) { const description = document.createElement('p'); description.textContent = source.description; item.append(description); }
			if (actions.openLink) {
				const controls = document.createElement('div'); controls.className = 'artifact-source-actions';
				for (const [label, external] of [[actions.openLinkLabel ?? 'Open in new tab', false], [actions.externalLinkLabel, true]] as const) {
					if (!label) { continue; }
					const button = document.createElement('button'); button.type = 'button'; button.className = 'ghost'; button.textContent = label;
					button.title = `${label}: ${url.href}`;
					button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); actions.openLink!(url.href, external); });
					controls.append(button);
				}
				item.append(controls);
			}
			list.append(item);
		}
		view.body.append(list);
	}
}
function tableView(data: TableData): HTMLElement {
	const root = document.createElement('div'); root.className = 'artifact-table';
	const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Filter rows…'; search.setAttribute('aria-label', 'Filter table rows');
	const scroll = document.createElement('div'); scroll.className = 'artifact-table-scroll';
	const table = document.createElement('table'); const head = document.createElement('thead'); const row = document.createElement('tr'); const body = document.createElement('tbody');
	const footer = document.createElement('div'); footer.className = 'artifact-table-footer';
	const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = 'Previous';
	const next = document.createElement('button'); next.type = 'button'; next.textContent = 'Next';
	const count = document.createElement('span'); count.setAttribute('role', 'status');
	let page = 0, sort = -1, direction = 1;
	const headers: HTMLTableCellElement[] = [];
	const render = () => {
		const query = search.value.toLocaleLowerCase();
		const rows = data.rows.filter(row => row.some(cell => String(cell ?? '').toLocaleLowerCase().includes(query)));
		if (sort >= 0) { rows.sort((a, b) => { const left = a[sort], right = b[sort]; return direction * (typeof left === 'number' && typeof right === 'number' ? left - right : String(left ?? '').localeCompare(String(right ?? ''), undefined, { numeric: true })); }); }
		page = Math.max(0, Math.min(page, Math.ceil(rows.length / 100) - 1));
		body.replaceChildren();
		for (const values of rows.slice(page * 100, (page + 1) * 100)) {
			const row = document.createElement('tr');
			for (const value of values) { const cell = document.createElement('td'); cell.textContent = String(value ?? ''); row.append(cell); }
			body.append(row);
		}
		previous.disabled = page === 0; next.disabled = (page + 1) * 100 >= rows.length;
		count.textContent = rows.length ? `${page * 100 + 1}–${Math.min((page + 1) * 100, rows.length)} of ${rows.length} rows` : 'No matching rows';
		headers.forEach((header, index) => { if (index === sort) { header.setAttribute('aria-sort', direction === 1 ? 'ascending' : 'descending'); } else { header.removeAttribute('aria-sort'); } });
	};
	data.columns.forEach((name, index) => {
		const header = document.createElement('th'); header.scope = 'col'; headers.push(header);
		const button = document.createElement('button'); button.type = 'button'; button.textContent = name; button.title = `Sort by ${name}`;
		button.addEventListener('click', () => { direction = sort === index ? -direction : 1; sort = index; render(); });
		header.append(button); row.append(header);
	});
	search.addEventListener('input', () => { page = 0; render(); });
	previous.addEventListener('click', () => { page--; render(); }); next.addEventListener('click', () => { page++; render(); });
	head.append(row); table.append(head, body); scroll.append(table); footer.append(previous, count, next); root.append(search, scroll, footer); render();
	return root;
}
