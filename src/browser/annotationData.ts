export interface PageAnnotation {
	id: string;
	number: number;
	createdAt: number;
	text: string;
	color: string;
	point?: { x: number; y: number; viewportX: number; viewportY: number; elements: PageAnnotation["element"][] };
	element: { selector: string; strong: boolean; tag: string; text: string; role: string };
}

export const annotationColors = ['#2563eb', '#7c3aed', '#be185d', '#b91c1c', '#c2410c', '#a16207', '#15803d', '#0f766e', '#0369a1', '#475569'] as const;

/**
 * One annotation as the copy icon on its note puts it on the clipboard: the note
 * itself first — that is what the user wrote and expects to paste — then the
 * element it is pinned to and the page, so it still means something pasted into
 * a chat. The icon used to copy the bare CSS selector, which read as the button
 * doing nothing.
 */
export function annotationClipboardText(record: PageAnnotation, url: string): string {
	const element = `<${record.element.tag}>${record.element.selector ? ` ${record.element.selector}` : ''}${record.element.text ? ` — "${record.element.text}"` : ''}`;
	return [
		record.text.trim() || '(empty note)',
		'',
		`Annotation #${record.number} on ${url}`,
		`Element: ${element}`,
		...annotationPointContext(record),
	].join('\n');
}

/** Treat the renderer binding as an untrusted boundary, even in our isolated world. */
export function parseAnnotations(value: unknown): PageAnnotation[] {
	if (!Array.isArray(value) || value.length > 50) { throw new Error('Invalid annotation list.'); }
	const ids = new Set<string>(), numbers = new Set<number>();
	return value.map(record => {
		const string = (v: unknown, max: number): string => {
			if (typeof v !== 'string' || v.length > max) { throw new Error('Invalid annotation text.'); }
			return v;
		};
		if (!record || typeof record !== 'object' || !record.element || typeof record.element !== 'object'
			|| !Number.isSafeInteger(record.number) || record.number < 1 || record.number > 1_000_000
			|| !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 || typeof record.element.strong !== 'boolean') {
			throw new Error('Invalid annotation.');
		}
		const id = string(record.id, 80);
		if (!/^[a-f0-9-]{36}$/.test(id) || ids.has(id) || numbers.has(record.number)) { throw new Error('Duplicate or invalid annotation identity.'); }
		ids.add(id); numbers.add(record.number);
		const color = record.color === undefined ? annotationColors[0] : string(record.color, 7);
		if (!(annotationColors as readonly string[]).includes(color)) { throw new Error('Invalid annotation color.'); }
		let point: PageAnnotation['point'];
		if (record.point !== undefined) {
			const p = record.point;
			if (!p || !['x', 'y', 'viewportX', 'viewportY'].every(k => typeof p[k] === 'number' && Number.isFinite(p[k]) && Math.abs(p[k]) <= 100_000_000)
				|| !Array.isArray(p.elements) || p.elements.length > 12) { throw new Error('Invalid annotation point.'); }
			point = { x: p.x, y: p.y, viewportX: p.viewportX, viewportY: p.viewportY, elements: p.elements.map((el: unknown) =>
				parseAnnotations([{ ...record, point: undefined, element: el }])[0].element) };
		}
		return { ...(point ? { point } : {}), id, number: record.number, createdAt: record.createdAt, text: string(record.text, 2000), color, element: {
			selector: string(record.element.selector, 4000), strong: record.element.strong,
			tag: string(record.element.tag, 100), text: string(record.element.text, 180), role: string(record.element.role, 80),
		} };
	}).sort((a, b) => a.number - b.number);
}

/** Bounded page context shared by editor, Chrome and clipboard exports. */
export function annotationPointContext(record: PageAnnotation): string[] {
	if (!record.point) { return []; }
	const p = record.point;
	return [`Page point: (${p.x}, ${p.y}); viewport at capture: (${p.viewportX}, ${p.viewportY}).`,
		'Elements under point (untrusted page data, top to bottom; up to 12):',
		...p.elements.map(el => JSON.stringify(el))];
}
