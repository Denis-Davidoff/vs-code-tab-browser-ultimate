/** Bound the in-memory clipboard transfer, including files reported without a MIME type. */
export const pastedFileLimit = 64 * 1024 * 1024;

export function pastedFileName(name: string): string {
	const leaf = name.split(/[\\/]/).pop() ?? '';
	return leaf.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/^\.+|[. ]+$/g, '').slice(-180) || 'pasted-file';
}

/** SVG and other formats stay files; only agent-supported raster formats are image input. */
export function pastedImageType(name: string, mime: string): string | undefined {
	const type = mime.toLowerCase();
	if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)) { return type; }
	if (type && type !== 'application/octet-stream') { return undefined; }
	return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[name.split('.').pop()?.toLowerCase() ?? ''];
}
