/** Local Markdown destinations only; never command:, vscode:, or remote file hosts. */
export function localFileLink(target: string): { path: string; line?: number; column?: number } | undefined {
	let file = target;
	if (/^file:/i.test(file)) {
		try {
			const url = new URL(file);
			if (url.hostname && url.hostname !== 'localhost') { return undefined; }
			file = decodeURIComponent(url.pathname) + url.hash;
			if (/^\/[A-Za-z]:\//.test(file)) { file = file.slice(1); }
		} catch { return undefined; }
	} else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(file) && !/^[A-Za-z]:[\\/]/.test(file)) {
		return undefined;
	} else {
		try { file = decodeURIComponent(file); } catch { return undefined; }
	}
	if (!file || file.startsWith('#') || file.startsWith('//') || file.startsWith('\\\\') || /[\0\n\r]/.test(file)) { return undefined; }
	const location = /(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?(?:-L\d+)?)$/.exec(file);
	if (!location) { return { path: file }; }
	return { path: file.slice(0, location.index), line: Number(location[1] ?? location[3]), column: Number(location[2] ?? location[4]) || undefined };
}
