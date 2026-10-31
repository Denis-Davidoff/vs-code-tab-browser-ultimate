import type { VisualizationReference, VisualizationSnapshot } from '../src/chat/visualizationProtocol';

interface ImageView {
	readonly element: HTMLElement;
	readonly image: HTMLImageElement;
	readonly title: HTMLElement;
	readonly status: HTMLElement;
	revision?: string;
	decodeError?: boolean;
}
const groups = new WeakMap<HTMLElement, Map<number, ImageView>>();

/** Native image cards share the host's archived snapshots, without an executing iframe. */
export function updateImageViews(container: HTMLElement, references: readonly VisualizationReference[], snapshots: Readonly<Record<string, VisualizationSnapshot>>): Map<number, ImageView> {
	let views = groups.get(container);
	if (!views) { views = new Map(); groups.set(container, views); }
	for (const [at, view] of views) {
		if (!references.some(ref => ref.kind === 'image' && ref.at === at)) { view.element.remove(); views.delete(at); }
	}
	for (const ref of references.filter(ref => ref.kind === 'image')) {
		let view = views.get(ref.at);
		if (!view) {
			const element = document.createElement('section'); element.className = 'visualization-card image-card';
			const header = document.createElement('div'); header.className = 'visualization-header';
			const title = document.createElement('span');
			const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'ghost'; toggle.textContent = 'Expand';
			toggle.addEventListener('click', () => { toggle.textContent = element.classList.toggle('image-expanded') ? 'Collapse' : 'Expand'; });
			const image = document.createElement('img'); image.loading = 'lazy'; image.decoding = 'async';
			const status = document.createElement('div'); status.className = 'visualization-status'; status.setAttribute('role', 'status');
			image.addEventListener('error', () => { const current = views!.get(ref.at); if (current) { current.decodeError = true; } status.textContent = 'The image could not be decoded.'; });
			header.append(title, toggle); element.append(header, image, status); container.append(element);
			view = { element, image, title, status }; views.set(ref.at, view);
		}
		view.title.textContent = ref.title; view.image.alt = ref.title;
		const snapshot = ref.revision ? snapshots[ref.revision]?.image : undefined;
		const available = snapshot && /^image\/(png|jpeg|gif|webp)$/.test(snapshot.mimeType) && snapshot.base64.length <= 5_333_336;
		const revision = available ? ref.revision : undefined;
		if (view.revision !== revision) {
			view.revision = revision;
			view.decodeError = false;
			if (available) { view.image.src = `data:${snapshot.mimeType};base64,${snapshot.base64}`; }
			else { view.image.removeAttribute('src'); }
		}
		view.image.hidden = !available;
		view.status.textContent = ref.error || (view.decodeError ? 'The image could not be decoded.' : available ? '' : 'This saved image is unavailable.');
	}
	return views;
}
