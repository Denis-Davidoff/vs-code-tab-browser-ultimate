/** The small Chrome API surface used here; no content-script messaging is exposed. */
declare const chrome: {
  runtime: { id: string; getManifest(): { version: string } };
  sidePanel: { setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void> };
  tabs: {
    get(tabId: number): Promise<{ id?: number; url?: string; title?: string }>;
    onRemoved: { addListener(listener: (tabId: number) => void): void };
    create(options: { url: string }): Promise<unknown>;
    captureVisibleTab(windowId: number, options: { format: 'png' }): Promise<string>;
    query(options: { active: boolean; currentWindow: boolean }): Promise<{ id?: number; url?: string; title?: string; windowId?: number }[]>;
    onActivated: { addListener(listener: () => void): void };
    onUpdated: { addListener(listener: (tabId: number, change: unknown, tab: { url?: string; title?: string }) => void): void };
  };
  permissions: { request(options: { permissions?: string[]; origins?: string[] }): Promise<boolean> };
  scripting: { executeScript<T, A extends unknown[]>(options: {
    target: { tabId: number }; world?: 'ISOLATED'; files?: string[]; func?: (...args: A) => T; args?: A;
  }): Promise<{ result?: Awaited<T> }[]> };
  storage: { session: {
    get(key: string | string[]): Promise<Record<string, unknown>>;
    set(value: Record<string, unknown>): Promise<void>;
    remove(key: string | string[]): Promise<void>;
  }; local: {
    get(key: string | string[]): Promise<Record<string, unknown>>;
    set(value: Record<string, unknown>): Promise<void>;
    remove(key: string | string[]): Promise<void>;
  } };
};
