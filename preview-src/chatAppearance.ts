/** Per-device chat display preference, independent of the editor's file icon theme. */
export const chatFileIconsKey = 'ai-browser:chat-file-icons';
let fileIcons = true;
function apply(): void { document.documentElement.dataset.chatFileIcons = String(fileIcons); }
export function getChatFileIcons(): boolean { return fileIcons; }
export function setChatFileIcons(enabled: boolean): void {
  fileIcons = enabled;
  try { localStorage.setItem(chatFileIconsKey, String(enabled)); } catch { /* Keep the session choice. */ }
  apply();
}
export function initChatAppearance(): () => void {
  try { fileIcons = localStorage.getItem(chatFileIconsKey) !== 'false'; } catch { /* Default to showing icons. */ }
  apply();
  const storage = (event: StorageEvent) => {
    if (event.key !== chatFileIconsKey && event.key !== null) return;
    fileIcons = event.newValue !== 'false';
    apply();
  };
  window.addEventListener('storage', storage);
  return () => window.removeEventListener('storage', storage);
}
