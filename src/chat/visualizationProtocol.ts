export type ArtifactKind = 'file' | 'table' | 'audio' | 'video' | 'sources';
export type PresentationKind = 'image' | ArtifactKind;
export interface TableData { readonly columns: readonly string[]; readonly rows: readonly (readonly (string | number | boolean | null)[])[] }
export interface SourceData { readonly title: string; readonly url: string; readonly description?: string }
export interface ArtifactSnapshot { readonly kind: ArtifactKind; readonly name: string; readonly mimeType: string; readonly base64: string; readonly bytes: number; readonly table?: TableData; readonly sources?: readonly SourceData[] }

/** The portable file-reference adapter. Only standalone assistant lines are active. */
export interface VisualizationMarker {
	readonly start: number;
	readonly end: number;
	readonly path: string;
	readonly title?: string;
	readonly wide?: boolean;
	readonly kind?: PresentationKind;
}

/** Stored in history; HTML and images live in a separate, content-addressed archive. */
export interface VisualizationReference {
	readonly at: number;
	readonly id: string;
	readonly revision?: string;
	readonly title: string;
	readonly wide?: boolean;
	readonly kind?: PresentationKind;
	readonly error?: string;
}

export interface VisualizationSnapshot {
	readonly artifact?: ArtifactSnapshot;
	readonly html?: string;
	readonly image?: { readonly mimeType: string; readonly base64: string };
}

export function visualizationMarkers(text: string, kind: 'visualize' | PresentationKind = 'visualize'): VisualizationMarker[] {
	const result: VisualizationMarker[] = [];
	const native = new RegExp(`^ {0,3}\uE200${kind}\uE202([^\\r\\n]{1,8192})\uE201\\s*$`);
	const plain = new RegExp(`^ {0,3}${kind}(\\{[^\\r\\n]{1,8190}\\})\\s*$`);
	let fence: { char: string; length: number } | undefined;
	let offset = 0;
	for (const line of text.split('\n')) {
		const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (delimiter) {
			if (!fence) { fence = { char: delimiter[1][0], length: delimiter[1].length }; }
			else if (delimiter[1][0] === fence.char && delimiter[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) { fence = undefined; }
		} else if (!fence && result.length < 8) {
			const match = native.exec(line) ?? plain.exec(line); // Claude Code drops the private-use delimiters Codex writes.
			if (match) {
				try {
					const value = JSON.parse(match[1]);
					if (value && typeof value === 'object' && !Array.isArray(value)
						&& typeof value.path === 'string' && value.path.length <= 4096 && !/[\x00-\x1f]/.test(value.path)
						&& (/^\/(?!\/)/.test(value.path) || /^[A-Za-z]:[\\/]/.test(value.path))
						&& (value.title === undefined || typeof value.title === 'string' && value.title.length <= 160)
						&& (value.mode === undefined || value.mode === 'wide')) {
						result.push({ start: offset, end: offset + line.length, path: value.path, title: value.title, wide: value.mode === 'wide' || undefined, ...(kind !== 'visualize' ? { kind } : {}) });
					}
				} catch { /* Incomplete or malformed references remain ordinary text. */ }
			}
		}
		offset += line.length + 1;
	}
	return result;
}

/** Both adapters share placement, validation and snapshot transport. */
export function presentationMarkers(text: string): VisualizationMarker[] {
	return (['visualize', 'image', 'file', 'table', 'audio', 'video', 'sources'] as const).flatMap(kind => visualizationMarkers(text, kind)).sort((a, b) => a.start - b.start);
}
