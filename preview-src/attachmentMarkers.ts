import type { AttachmentChip, PastedAttachment } from '../src/chat/chatProtocol';

/** A stable attachment ID, unlike the per-draft @N. Survives text-only clipboard round trips. */
export function attachmentMarker(chip: Pick<AttachmentChip, 'id' | 'label'>): string {
	const label = chip.label.replace(/[\]\n\r]/g, ' ').trim().slice(0, 120);
	if (!chip.id || chip.id.length > 512 || /[\u0000-\u001f\u007f]/.test(chip.id)) { return label; }
	try { return `[att:${encodeURIComponent(chip.id)}|${label}]`; }
	catch { return label; }
}

/** Adapt portable markers to the same pending-reference flow as the rich clipboard format. */
export function readAttachmentMarkers(value: string): { text: string; items: PastedAttachment[] } | undefined {
	const used = new Set([...value.matchAll(/\[@([1-9][0-9]{0,5})[ \u00a0]/g)].map(match => Number(match[1])));
	let next = 999999;
	const items: PastedAttachment[] = [];
	const text = value.replace(/\[att:([^|\]\s]{1,1536})\|([^\]\n]{0,200})\]/g, (whole: string, encodedId: string, label: string) => {
		if (items.length >= 50) { return whole; }
		let id: string;
		try { id = decodeURIComponent(encodedId); } catch { return whole; }
		if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) { return whole; }
		while (used.has(next) && next > 0) { next--; }
		if (!next) { return whole; }
		used.add(next);
		const token = `[@${next--} ${label}]`;
		items.push({ token, id, label, kind: 'file' }); // The host resolves the actual type from its saved snapshot.
		return token;
	});
	return items.length ? { text, items } : undefined;
}

/** Replace fully selected sent badges with portable text, preserving the surrounding block breaks. */
export function selectedAttachmentMarkers(selection: Selection, root: HTMLElement): { text: string; ids: string[] } | undefined {
	if (!selection.rangeCount) { return undefined; }
	const range = selection.getRangeAt(0);
	const exportRange = range.cloneRange();
	const markers = new Map<string, { id: string; label: string }>();
	for (const badge of root.querySelectorAll<HTMLElement>('.sent-attachment[data-attachment-key]')) {
		if (!badge.dataset.attachmentId || !range.intersectsNode(badge)) { continue; }
		const contents = badge.ownerDocument.createRange();
		// Chromium can omit the transparent prefix and hidden remove-button slots
		// from a visual selection. The entire visible title is the atomic badge.
		contents.selectNodeContents(badge.querySelector('.att-token-label') ?? badge);
		if (range.compareBoundaryPoints(0, contents) <= 0 && range.compareBoundaryPoints(2, contents) >= 0) {
			markers.set(badge.dataset.attachmentKey!, { id: badge.dataset.attachmentId, label: badge.dataset.attachmentLabel ?? '' });
			// A range inside the title clones only its text, without the badge's
			// identifying wrapper. Include that wrapper in the copy, not the UI selection.
			if (badge.contains(range.startContainer)) { exportRange.setStartBefore(badge); }
			if (badge.contains(range.endContainer)) { exportRange.setEndAfter(badge); }
		}
	}
	if (!markers.size) { return undefined; }
	const fragment = exportRange.cloneContents();
	for (const badge of fragment.querySelectorAll<HTMLElement>('[data-attachment-key]')) {
		const chip = markers.get(badge.dataset.attachmentKey!);
		if (chip) { badge.replaceWith(root.ownerDocument.createTextNode(attachmentMarker(chip))); }
	}
	const block = /^(DIV|P|LI|UL|OL|PRE|BLOCKQUOTE|H[1-6]|TR)$/;
	const textOf = (node: Node): string => {
		if (node.nodeType === 3) { return node.textContent ?? ''; }
		if (node.nodeName === 'BR') { return '\n'; }
		let text = '';
		for (const child of node.childNodes) {
			const newline = block.test(child.nodeName);
			if (newline && text && !text.endsWith('\n')) { text += '\n'; }
			text += textOf(child);
			if (newline && !text.endsWith('\n')) { text += '\n'; }
		}
		return text;
	};
	const trailing = /\n*$/.exec(selection.toString())![0];
	return { text: textOf(fragment).replace(/\n+$/, '') + trailing, ids: [...new Set([...markers.values()].map(chip => chip.id))] };
}
