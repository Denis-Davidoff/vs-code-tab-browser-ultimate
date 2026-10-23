import { annotationClipboardText, parseAnnotations, type PageAnnotation } from '../src/browser/annotationData';

interface OverlayApi {
  hydrate(data: { records: PageAnnotation[]; nextNumber: number }): void;
  start(data: { records: PageAnnotation[]; nextNumber: number; mode?: 'element' | 'point' }): void;
  collect(): { url: string; records: (PageAnnotation & { elementFound?: boolean })[] };
  add(selector: string, text: string, color: string, id: string): unknown;
  remove(ids: string[], url: string): void;
  dispose(): void;
}
interface AnnotationWorld extends Window {
  __aiBrowserAnnotations?: OverlayApi;
  __aiBrowserChromeAnnotationEvents?: { type: string; id: string; url: string }[];
}
export interface AnnotationPage { url: string; records: PageAnnotation[]; found: string[] }
export interface AnnotationTab { tabId: number; chatId: string; chatIds: string[]; nextNumber: number; url: string; pages: AnnotationPage[]; assistant: string[]; dismissed: string[]; sent: string[]; owners: Record<string, string> }
export interface AnnotationRequest { id: string; tabId: number; chatId: string; url: string; action: 'add' | 'remove'; selector?: string; text?: string; color?: string; annotationId?: string; ids?: string[] }

/** The same overlay as CDP, driven through Chrome's isolated content-script world. */
export class ChromeAnnotations {
  private readonly tabs = new Map<number, AnnotationTab>();
  private readonly locks = new Map<number, Promise<unknown>>();
  private polling?: Promise<void>;
  constructor(private readonly changed: (tab: AnnotationTab, page: AnnotationPage, attachAll?: boolean) => void,
    private readonly error: (error: unknown) => void) {}

  private serial<T>(tabId: number, work: () => Promise<T>): Promise<T> {
    const pending = (this.locks.get(tabId) ?? Promise.resolve()).catch(() => {}).then(work);
    this.locks.set(tabId, pending);
    void pending.finally(() => { if (this.locks.get(tabId) === pending) { this.locks.delete(tabId); } }).catch(() => {});
    return pending;
  }
  snapshot(): AnnotationTab[] { return [...this.tabs.values()]; }
  async save(): Promise<void> { await chrome.storage.session.set({ annotationTabs: this.snapshot() }); }
  restore(value: unknown): void {
    if (!Array.isArray(value)) { return; }
    for (const raw of value.slice(0, 8)) {
      try {
        if (!raw || !Number.isSafeInteger(raw.tabId) || raw.tabId < 0 || typeof raw.chatId !== 'string' || raw.chatId.length > 100
          || typeof raw.url !== 'string' || !Number.isSafeInteger(raw.nextNumber) || !Array.isArray(raw.pages) || raw.pages.length > 8) { continue; }
        const pages = raw.pages.map((page: AnnotationPage) => {
          if (typeof page.url !== 'string' || page.url.length > 20000) { throw new Error('Invalid annotation URL'); }
          return { url: page.url, records: parseAnnotations(page.records), found: [] };
        });
        const owners = raw.owners && typeof raw.owners === 'object' ? Object.fromEntries(Object.entries(raw.owners).filter(([id, chat]) => /^[a-f0-9-]{36}$/.test(id) && typeof chat === 'string' && chat.length <= 100)) as Record<string, string> : {};
        const chatIds = [...new Set<string>([raw.chatId, ...(raw.chatIds === undefined ? Object.values(owners)
          : Array.isArray(raw.chatIds) ? raw.chatIds.filter((chat: unknown) => typeof chat === 'string' && chat.length > 0 && chat.length <= 100).slice(0, 1000) : [])])];
        this.tabs.set(raw.tabId, { tabId: raw.tabId, chatId: raw.chatId, chatIds, url: raw.url, nextNumber: Math.max(1, raw.nextNumber), pages,
          owners,
          dismissed: Array.isArray(raw.dismissed) ? raw.dismissed.filter((id: unknown) => typeof id === 'string').slice(0, 400) : [],
          sent: Array.isArray(raw.sent) ? raw.sent.filter((id: unknown) => typeof id === 'string').slice(0, 400) : [],
          assistant: Array.isArray(raw.assistant) ? raw.assistant.filter((id: unknown) => typeof id === 'string').slice(0, 400) : [] });
      } catch { /* Invalid persisted data must not reach the overlay. */ }
    }
  }
  private async inject(tabId: number): Promise<void> {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: ['annotationOverlay.js'] });
  }
  private async read(tabId: number) {
    const result = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: () => {
      const world = window as AnnotationWorld;
      return { snapshot: world.__aiBrowserAnnotations?.collect(), events: world.__aiBrowserChromeAnnotationEvents?.splice(0) ?? [] };
    } });
    return result[0]?.result;
  }
  private page(tab: AnnotationTab, url: string): AnnotationPage {
    let page = tab.pages.find(page => page.url === url);
    if (!page) {
      if (tab.pages.length >= 8) { tab.pages = tab.pages.filter(page => page.records.length > 0); }
      if (tab.pages.length >= 8) { throw new Error('This tab already has annotations on 8 pages. Remove some annotations first.'); }
      page = { url, records: [], found: [] }; tab.pages.push(page);
    }
    return page;
  }
  private async hydrate(tab: AnnotationTab, start: boolean, mode: 'element' | 'point' = 'element'): Promise<void> {
    const page = this.page(tab, tab.url);
    await chrome.scripting.executeScript({ target: { tabId: tab.tabId }, world: 'ISOLATED',
      func: (url: string, records: PageAnnotation[], nextNumber: number, start: boolean, mode: 'element' | 'point') => {
        if (location.href !== url) { throw new Error('The page navigated. Try again.'); }
        const api = (window as AnnotationWorld).__aiBrowserAnnotations;
        if (!api) { throw new Error('Annotations unavailable.'); }
        if (start) { api.start({ records, nextNumber, mode }); } else { api.hydrate({ records, nextNumber }); }
      }, args: [tab.url, page.records, tab.nextNumber, start, mode] });
  }
  async start(tabId: number, chatId: string, mode: 'element' | 'point' = 'element'): Promise<void> {
    await this.serial(tabId, async () => {
      const browserTab = await chrome.tabs.get(tabId);
      if (!browserTab.url || !/^https?:/.test(browserTab.url)) { throw new Error('Open a regular website in Chrome first.'); }
      let tab = this.tabs.get(tabId);
      const fresh = !tab;
      if (!tab) {
        if (this.tabs.size >= 8) { throw new Error('Annotations are already active in 8 tabs.'); }
        tab = { tabId, chatId, chatIds: [chatId], url: browserTab.url, nextNumber: 1, pages: [], assistant: [], dismissed: [], sent: [], owners: {} };
        this.tabs.set(tabId, tab);
      }
      await this.inject(tabId);
      if (!fresh) { await this.collect(tab); }
      tab.dismissed = [];
      tab.chatId = chatId; tab.url = browserTab.url;
      if (!tab.chatIds.includes(chatId)) { tab.chatIds.push(chatId); }
      const page = this.page(tab, tab.url);
      if (page.records.length >= 50) { throw new Error('This page already has 50 annotations. Remove a note first.'); }
      await this.hydrate(tab, true, mode);
      this.changed(tab, page, true); await this.save();
    });
  }
  private async collect(tab: AnnotationTab): Promise<void> {
    const data = await this.read(tab.tabId);
    if (this.tabs.get(tab.tabId) !== tab) { return; }
    if (!data?.snapshot) {
      const browserTab = await chrome.tabs.get(tab.tabId);
      if (!browserTab.url || !/^https?:/.test(browserTab.url)) { tab.url = browserTab.url ?? ''; return; }
      tab.url = browserTab.url; await this.inject(tab.tabId); await this.hydrate(tab, false); return;
    }
    const { snapshot, events } = data;
    if (snapshot.url !== tab.url) {
      tab.url = snapshot.url; await this.hydrate(tab, false); return;
    }
    const page = this.page(tab, tab.url);
    const records = parseAnnotations(snapshot.records);
    page.found = snapshot.records.filter(record => record.elementFound).map(record => record.id);
    if (JSON.stringify(page.records) !== JSON.stringify(records)) {
      for (const record of records) { if (!tab.assistant.includes(record.id)) { tab.owners[record.id] ??= tab.chatId; } }
      page.records = records; tab.nextNumber = Math.max(tab.nextNumber, ...records.map(record => record.number + 1));
      this.changed(tab, page); await this.save();
    }
    for (const event of events) {
      const record = page.records.find(record => record.id === event.id);
      if (!record || event.url !== tab.url) { continue; }
      if (event.type === 'copy') {
        // Clicking a page note focuses the page, leaving the side panel unfocused.
        const copied = await chrome.scripting.executeScript({ target: { tabId: tab.tabId }, world: 'ISOLATED',
          func: async (text: string, url: string) => {
            if (location.href !== url) { throw new Error('The page changed before copying the annotation.'); }
            // Never a field in the page's DOM: the page could read the note from it.
            try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
          }, args: [annotationClipboardText(record, tab.url), tab.url] });
        // The side panel is an extension page holding clipboardWrite, so its own
        // document can copy without focus, and the page sees nothing of it.
        if (copied[0]?.result !== true && !copyInPanel(annotationClipboardText(record, tab.url))) { throw new Error('Could not copy the annotation. Focus its page and try again.'); }
      }
      if (event.type === 'requestDelete' && (!record.text.trim() || window.confirm(`Delete annotation #${record.number}?\n\n${record.text}`))) {
        await this.removeNow(tab, page.url, [record.id]);
      }
    }
  }
  async poll(): Promise<void> {
    if (!this.polling) {
      this.polling = Promise.all([...this.tabs.values()].map(tab => this.serial(tab.tabId, () => this.collect(tab)).catch(this.error)))
        .then(() => {}).finally(() => { this.polling = undefined; });
    }
    return this.polling;
  }
  private async removeNow(tab: AnnotationTab, url: string, ids: string[]): Promise<void> {
    const page = tab.pages.find(page => page.url === url);
    if (!page) { return; }
    // Only touch the live overlay if this URL is still on screen. Other URLs stay in the store.
    const browserTab = await chrome.tabs.get(tab.tabId);
    if (browserTab.url === url) {
      await chrome.scripting.executeScript({ target: { tabId: tab.tabId }, world: 'ISOLATED',
        func: (ids: string[], url: string) => (window as AnnotationWorld).__aiBrowserAnnotations?.remove(ids, url), args: [ids, url] });
    }
    page.records = page.records.filter(record => !ids.includes(record.id));
    for (const id of ids) { delete tab.owners[id]; }
    this.changed(tab, page); await this.save();
  }
  async remove(tabId: number, url: string, ids: string[]): Promise<void> {
    await this.serial(tabId, async () => { const tab = this.tabs.get(tabId); if (tab) { await this.removeNow(tab, url, ids); } });
  }
  dismiss(tabId: number, id: string): void {
    const tab = this.tabs.get(tabId); if (tab && !tab.dismissed.includes(id)) { tab.dismissed.push(id); void this.save().catch(this.error); }
  }
  sent(tabId: number, id: string): void {
    const tab = this.tabs.get(tabId); if (tab && !tab.sent.includes(id)) { tab.sent.push(id); void this.save().catch(this.error); }
  }
  async retainChats(chats: ReadonlySet<string>): Promise<void> {
    for (const tab of [...this.tabs.values()]) {
      const previous = tab.chatIds.length;
      tab.chatIds = tab.chatIds.filter(chat => chats.has(chat));
      for (const page of tab.pages) {
        const removed = page.records.filter(record => tab.owners[record.id] && !chats.has(tab.owners[record.id])).map(record => record.id);
        if (removed.length) { await this.remove(tab.tabId, page.url, removed); }
      }
      if (tab.chatIds.length) {
        if (!tab.chatIds.includes(tab.chatId)) { tab.chatId = tab.chatIds[0]; }
        if (tab.chatIds.length !== previous) { await this.save(); }
        continue;
      }
      this.closed(tab.tabId);
      try { await chrome.scripting.executeScript({ target: { tabId: tab.tabId }, world: 'ISOLATED', func: () => (window as AnnotationWorld).__aiBrowserAnnotations?.dispose() }); }
      catch { /* The tab may have closed along with the chat. */ }
    }
  }
  async execute(request: AnnotationRequest): Promise<unknown> {
    return this.serial(request.tabId, async () => {
      const tab = this.tabs.get(request.tabId);
      if (!tab || !tab.chatIds.includes(request.chatId) || (request.action !== 'remove' && tab.url !== request.url)) { throw new Error('The annotated page changed or is no longer available.'); }
      if (request.action === 'remove') { await this.removeNow(tab, request.url, request.ids ?? []); return { removed: request.ids?.length ?? 0 }; }
      if (!request.annotationId) { throw new Error('Missing annotation ID.'); }
      if (!tab.assistant.includes(request.annotationId)) { tab.assistant.push(request.annotationId); }
      const result = await chrome.scripting.executeScript({ target: { tabId: request.tabId }, world: 'ISOLATED',
        func: (url: string, selector: string, text: string, color: string, id: string) => {
          if (location.href !== url) { throw new Error('The page navigated.'); }
          const api = (window as AnnotationWorld).__aiBrowserAnnotations;
          const existing = api?.collect().records.find(record => record.id === id);
          return existing ? { id, number: existing.number, url } : api?.add(selector, text, color, id);
        }, args: [request.url, request.selector ?? '', request.text ?? '', request.color ?? '#2563eb', request.annotationId] });
      const value = result[0]?.result as { error?: string } | undefined;
      if (!value || value.error) { throw new Error(value?.error ?? 'Could not add the annotation.'); }
      await this.collect(tab); return value;
    });
  }
  closed(tabId: number): void {
    const tab = this.tabs.get(tabId); if (!tab) { return; }
    this.tabs.delete(tabId);
    for (const page of tab.pages) { this.changed(tab, { ...page, records: [] }); }
    void this.save().catch(this.error);
  }
}

/** Copies through a field in the side panel's own document, never the page's. */
function copyInPanel(text: string): boolean {
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
  document.body.append(field);
  try { field.select(); return document.execCommand('copy'); }
  catch { return false; }
  finally { field.remove(); }
}
