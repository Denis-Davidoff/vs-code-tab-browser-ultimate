/** What a selection is copied as: `text` for text/plain (Markdown), `html` for text/html when there is markup. */
export interface SelectionPayload { text: string; html?: string }

/**
 * Copy a selection in the chat as Markdown (text/plain) and, where it carries
 * formatting, as HTML (text/html), so a paste into a document keeps headings,
 * lists, code and links, and a paste into a plain editor or a chat gets Markdown.
 *
 * Cmd/Ctrl+C runs `execCommand('copy')` so our own `copy` handler can put both
 * formats on the clipboard; only if that event never comes (no clipboard access
 * in this frame) does the text go through the host's `env.clipboard`, which is
 * text-only. The native context-menu Copy dispatches the same `copy` event.
 * Posting to the host after setting the event's data would replace the HTML
 * with plain text, so the host is used only when the event has no clipboard.
 */
export function installChatSelectionCopy(document: Document, root: HTMLElement, copy: (text: string) => void, serialize?: (selection: Selection) => SelectionPayload | string | undefined): void {
  const selected = (): SelectionPayload | undefined => {
    // Leave native copy/cut/paste in editing fields alone, including the composer.
    const active = document.activeElement;
    if (active?.closest('input, textarea, [contenteditable="true"]')) return undefined;
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode ||
      !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return undefined;
    let payload: SelectionPayload | string | undefined;
    try { payload = serialize?.(selection); } catch { payload = undefined; }
    if (typeof payload === 'string') payload = { text: payload };
    if (!payload?.text) payload = { text: selection.toString() };
    return payload.text ? payload : undefined;
  };
  let pending: SelectionPayload | undefined;
  let delivered = false;
  const put = (event: ClipboardEvent, payload: SelectionPayload) => {
    event.clipboardData!.setData('text/plain', payload.text);
    if (payload.html) event.clipboardData!.setData('text/html', payload.html);
    event.preventDefault();
  };
  document.addEventListener('keydown', event => {
    if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'c' || event.isComposing) return;
    const payload = selected();
    if (!payload) return;
    event.preventDefault();
    event.stopPropagation();
    pending = payload;
    delivered = false;
    let ran = false;
    try { ran = document.execCommand?.('copy') ?? false; } catch { ran = false; }
    pending = undefined;
    if (!ran || !delivered) copy(payload.text);
  }, true);
  document.addEventListener('copy', event => {
    const payload = pending ?? selected();
    if (!payload) return;
    if (event.clipboardData) {
      put(event, payload);
      delivered = true;
      return;
    }
    event.preventDefault();
    copy(payload.text);
    delivered = true;
  });
}
