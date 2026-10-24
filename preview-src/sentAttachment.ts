import type { ChatEntry } from '../src/chat/chatProtocol';

/**
 * A chip of a sent message, shown where the remote viewer is: the Chrome side panel
 * and the website have no editor to open it in, so its saved text or image is shown
 * in a dialog of their own. Answers whether the chip was found.
 */
export function showSentAttachment(entries: readonly ChatEntry[] | undefined, index: number | undefined, id: string): boolean {
	const entry = index === undefined ? undefined : entries?.[index];
	const saved = entry?.kind === 'user' ? entry.attachmentData?.find(item => item.chip.id === id) : undefined;
	if (!saved) { return false; }
	const dialog = document.createElement('dialog');
	dialog.className = 'chrome-element-preview sent-attachment-preview';
	const close = document.createElement('button');
	close.textContent = 'Close';
	close.addEventListener('click', () => dialog.close());
	const title = document.createElement('strong');
	title.textContent = saved.chip.label;
	dialog.append(close, title);
	if (saved.image) {
		const image = document.createElement('img');
		image.src = `data:${/^image\/(png|jpeg|gif|webp)$/.test(saved.image.mediaType) ? saved.image.mediaType : 'image/png'};base64,${saved.image.base64}`;
		image.alt = saved.chip.label;
		image.style.maxWidth = '100%';
		dialog.append(image);
	}
	// Text only, never HTML: a page wrote much of it.
	const text = document.createElement('pre');
	text.textContent = saved.text ?? (saved.file ? `File on the VS Code machine: ${decodeURIComponent(saved.file.replace(/^file:\/\//, ''))}` : '');
	if (text.textContent) { dialog.append(text); }
	dialog.addEventListener('close', () => dialog.remove());
	document.body.append(dialog);
	dialog.showModal();
	return true;
}
