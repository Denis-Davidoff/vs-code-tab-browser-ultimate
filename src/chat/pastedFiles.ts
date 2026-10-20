/** Bound the in-memory clipboard transfer, including files reported without a MIME type. */
export const pastedFileLimit = 64 * 1024 * 1024;

export function pastedFileName(name: string): string {
	const leaf = name.split(/[\\/]/).pop() ?? '';
	const clean = leaf.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/^\.+|[. ]+$/g, '');
	// Cut by code point: a UTF-16 slice can leave half of an emoji, and the
	// path handed to the agent then names a file that is not the one written.
	// And by bytes: a name is at most 255 bytes on most file systems, and the
	// host prefixes a 37-byte UUID, so 180 CJK characters (540 bytes) failed
	// with ENAMETOOLONG. The end is kept, extension included.
	const points = Array.from(clean).slice(-180);
	// `TextEncoder`, not `Buffer`: the webview imports this module too.
	const bytes = (text: string) => new TextEncoder().encode(text).length;
	while (points.length && bytes(points.join('')) > 200) {
		points.shift();
	}
	return points.join('') || 'pasted-file';
}

/** SVG and other formats stay files; only agent-supported raster formats are image input. */
export function pastedImageType(name: string, mime: string): string | undefined {
	const type = mime.toLowerCase();
	if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)) { return type; }
	if (type && type !== 'application/octet-stream') { return undefined; }
	return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[name.split('.').pop()?.toLowerCase() ?? ''];
}
