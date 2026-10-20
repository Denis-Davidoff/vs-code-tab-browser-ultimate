export interface PageAnnotation {
	id: string;
	number: number;
	createdAt: number;
	text: string;
	color: string;
	element: { selector: string; strong: boolean; tag: string; text: string; role: string };
}

export const annotationColors = ['#2563eb', '#7c3aed', '#be185d', '#b91c1c', '#c2410c', '#a16207', '#15803d', '#0f766e', '#0369a1', '#475569'] as const;

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
		return { id, number: record.number, createdAt: record.createdAt, text: string(record.text, 2000), color, element: {
			selector: string(record.element.selector, 4000), strong: record.element.strong,
			tag: string(record.element.tag, 100), text: string(record.element.text, 180), role: string(record.element.role, 80),
		} };
	}).sort((a, b) => a.number - b.number);
}
