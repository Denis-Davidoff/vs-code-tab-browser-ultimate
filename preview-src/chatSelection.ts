/** Route selected message text through the editor clipboard, as the Copy buttons do. */
export function installChatSelectionCopy(document: Document, root: HTMLElement, copy: (text: string) => void): void {
  const selectedText = () => {
    // Leave native copy/cut/paste in editing fields alone, including the composer.
    const active = document.activeElement;
    if (active?.closest('input, textarea, [contenteditable="true"]')) return '';
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode ||
      !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return '';
    return selection.toString();
  };
  document.addEventListener('keydown', event => {
    if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'c' || event.isComposing) return;
    const text = selectedText();
    if (!text) return;
    event.preventDefault();
    event.stopPropagation();
    copy(text);
  }, true);
  // VS Code's native context-menu Copy dispatches a copy event in the webview.
  document.addEventListener('copy', event => {
    const text = selectedText();
    if (!text) return;
    event.clipboardData?.setData('text/plain', text);
    event.preventDefault();
    copy(text);
  });
}
