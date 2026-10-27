import type { ChatEntry } from '../src/chat/chatProtocol';

let nextPreviewId = 0;
/** Shared attachment viewer for sent messages and drafts on the website and in Chrome. */
export function showAttachmentPreview(options: { label: string; text?: string; image?: string }): void {
 const dialog = document.createElement('dialog');
 dialog.className = 'attachment-preview';
 const heading = document.createElement('strong');
 heading.id = `attachment-preview-${++nextPreviewId}`;
 heading.textContent = options.label;
 dialog.setAttribute('aria-labelledby', heading.id);
 const closeButton = (bottom = false) => {
  const button = document.createElement('button'); button.type = 'button';
  button.className = bottom ? 'attachment-preview-dismiss' : 'attachment-preview-close';
  button.title = 'Close preview'; button.setAttribute('aria-label', 'Close preview');
  const glyph = document.createElement('span'); glyph.className = 'codicon codicon-close'; glyph.setAttribute('aria-hidden', 'true');
  button.append(glyph);
  if (bottom) button.append(document.createTextNode('Close'));
  button.addEventListener('click', () => dialog.close());
  return button;
 };
 const header = document.createElement('header'); header.className = 'attachment-preview-header'; header.append(heading, closeButton());
 const content = document.createElement('div'); content.className = 'attachment-preview-content';
 if (options.image) {
  const image = document.createElement('img'); image.src = options.image; image.alt = options.label; content.append(image);
 }
 if (options.text) { const text = document.createElement('pre'); text.textContent = options.text; content.append(text); }
 const footer = document.createElement('footer'); footer.className = 'attachment-preview-footer'; footer.append(closeButton(true));
 dialog.append(header, content, footer);
 dialog.addEventListener('close', () => dialog.remove());
 document.body.append(dialog); dialog.showModal();
}

/**
 * A chip of a sent message, shown where the remote viewer is: the Chrome side panel
 * and the website have no editor to open it in, so its saved text or image is shown
 * in a dialog of their own. Answers whether the chip was found.
 */
export function showSentAttachment(entries: readonly ChatEntry[] | undefined, index: number | undefined, id: string): boolean {
	const entry = index === undefined ? undefined : entries?.[index];
	const saved = entry?.kind === 'user' ? entry.attachmentData?.find(item => item.chip.id === id) : undefined;
	if (!saved) { return false; }
 showAttachmentPreview({
  label: saved.chip.label,
  text: saved.text ?? (saved.file ? `File on the VS Code machine: ${decodeURIComponent(saved.file.replace(/^file:\/\//, ''))}` : ''),
  image: saved.image ? `data:${/^image\/(png|jpeg|gif|webp)$/.test(saved.image.mediaType) ? saved.image.mediaType : 'image/png'};base64,${saved.image.base64}` : undefined,
 });
 return true;
}
