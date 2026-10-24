/** Local appearance preference. Website and embedded chat share it through storage events. */
export type ThemePreference = 'system' | 'light' | 'dark';
export const themeStorageKey = 'ai-browser:theme';
export const themeChangeEvent = 'ai-browser-theme-change';
let preference: ThemePreference = 'system';
let initialized = false;

export function readThemePreference(value: unknown): ThemePreference {
 return value === 'light' || value === 'dark' ? value : 'system';
}
export function getThemePreference(): ThemePreference { return preference; }
export function setThemePreference(value: ThemePreference): void {
 preference = readThemePreference(value);
 try { localStorage.setItem(themeStorageKey, preference); } catch { /* Keep the session preference. */ }
 window.dispatchEvent(new Event(themeChangeEvent));
}
export function initTheme(editor = false): () => void {
 if (initialized) return () => {};
 initialized = true;
 try { preference = readThemePreference(localStorage.getItem(themeStorageKey)); } catch { /* Storage can be unavailable. */ }
 const media = window.matchMedia('(prefers-color-scheme: light)');
 const apply = () => {
  if (editor && preference === 'system') {
   delete document.documentElement.dataset.theme;
   document.documentElement.style.removeProperty('color-scheme');
  } else {
   const theme = preference === 'system' ? (media.matches ? 'light' : 'dark') : preference;
   document.documentElement.dataset.theme = theme;
   document.documentElement.style.colorScheme = theme;
  }
 };
 const storage = (event: StorageEvent) => {
  if (event.key !== themeStorageKey && event.key !== null) return;
  preference = readThemePreference(event.newValue);
  window.dispatchEvent(new Event(themeChangeEvent));
 };
 apply();
 media.addEventListener('change', apply);
 window.addEventListener(themeChangeEvent, apply);
 window.addEventListener('storage', storage);
 return () => {
  initialized = false;
  media.removeEventListener('change', apply);
  window.removeEventListener(themeChangeEvent, apply);
  window.removeEventListener('storage', storage);
 };
}
