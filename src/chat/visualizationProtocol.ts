/** The portable file-reference adapter. Only standalone assistant lines are active. */
export interface VisualizationMarker {
	readonly start: number;
	readonly end: number;
	readonly path: string;
	readonly title?: string;
	readonly wide?: boolean;
}

/** Stored in history; HTML lives in a separate, content-addressed archive. */
export interface VisualizationReference {
	readonly at: number;
	readonly id: string;
	readonly revision?: string;
	readonly title: string;
	readonly wide?: boolean;
	readonly error?: string;
}

export interface VisualizationSnapshot {
	readonly html: string;
}

export function visualizationMarkers(text: string): VisualizationMarker[] {
	const result: VisualizationMarker[] = [];
	let fence: { char: string; length: number } | undefined;
	let offset = 0;
	for (const line of text.split('\n')) {
		const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (delimiter) {
			if (!fence) { fence = { char: delimiter[1][0], length: delimiter[1].length }; }
			else if (delimiter[1][0] === fence.char && delimiter[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) { fence = undefined; }
		} else if (!fence && result.length < 8) {
			const match = /^ {0,3}\uE200visualize\uE202([^\r\n]{1,8192})\uE201\s*$/.exec(line)
				?? /^ {0,3}visualize(\{[^\r\n]{1,8190}\})\s*$/.exec(line); // Claude Code drops the private-use delimiters Codex writes.
			if (match) {
				try {
					const value = JSON.parse(match[1]);
					if (value && typeof value === 'object' && !Array.isArray(value)
						&& typeof value.path === 'string' && value.path.length <= 4096 && !/[\x00-\x1f]/.test(value.path)
						&& (/^\/(?!\/)/.test(value.path) || /^[A-Za-z]:[\\/]/.test(value.path))
						&& (value.title === undefined || typeof value.title === 'string' && value.title.length <= 160)
						&& (value.mode === undefined || value.mode === 'wide')) {
						result.push({ start: offset, end: offset + line.length, path: value.path, title: value.title, wide: value.mode === 'wide' || undefined });
					}
				} catch { /* Incomplete or malformed references remain ordinary text. */ }
			}
		}
		offset += line.length + 1;
	}
	return result;
}
