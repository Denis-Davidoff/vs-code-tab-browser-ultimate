import { annotationPointContext } from '../src/browser/annotationData';
import { chromeChatProtocolVersion, chromeChatProtocolHeader, chromeChatVersionHeader, chromeChatCompatibilityError, chromeChatCapabilities, chromeChatCapabilitiesHeader, negotiateChromeChatCapabilities, chromeChatFeatureError, chromeChatAttachmentFeature, chromeChatCommandFeature, chromeChatFooterCommands } from '../src/chat/chromeChatCompatibility';
import { chromePairingKind, chromePairingPorts, readChromeChatConnection, readChromeChatCommand, readChromeElementAttachments, type ChromeChatCommand, type ChromeChatConnection, type ChromeChatSnapshot, type ChromeElementAttachment } from '../src/chat/chromeChatProtocol';
import { formatAncestor, inertProse, oneLine, renderElementMarkdown } from '../src/elements/elementMarkdown';
import { ChromeAnnotations, type AnnotationTab, type AnnotationPage, type AnnotationRequest } from './annotations';
import { appendPickedElement, restorePickedElements, type ElementDraft } from './elementDrafts';
import type { ElementPickerWorld, ChromeElementPick } from './elementPicker';
import type { HostToView, ViewToHost } from '../src/chat/chatProtocol';
import type { ChatDraftState } from '../preview-src/chatHost';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) { throw new Error(`Missing panel element: ${id}`); }
  return node as T;
}
const pairing = element<HTMLFormElement>('pairing');
const code = element<HTMLTextAreaElement>('connection');
const status = element('status');
const app = element('app');
const disconnect = element<HTMLButtonElement>('disconnect');
const conversation = element<HTMLSelectElement>('conversation');
const modeButton = element<HTMLButtonElement>('mode');
const modeDetails = element('mode-details');
const modeText = element('mode-text');
/** Opened by the user, or once on its own the first time a connection turns out limited. */
let modeOpen = false;
let modeShownLimited = false;
modeButton.addEventListener('click', () => { modeOpen = !modeOpen; renderMode(); });
element('mode-close').addEventListener('click', () => { modeOpen = false; renderMode(); modeButton.focus(); });
const modeExplanations = {
  full: 'Full mode: this Chrome was opened from VS Code, so the agents\u2019 browser tools see and drive its tabs \u2014 reading pages, clicking, filling forms, screenshots \u2014 alongside everything in this panel.',
  limited: 'Limited mode: this Chrome was not opened from VS Code, so the agents cannot see or act on its pages. You can still chat, pick elements, attach screenshots and page addresses here. For every function, open Chrome from VS Code: in the AI Browser chat press the globe (Open browser) and choose Google Chrome, then use this panel in that window.',
} as const;
function renderMode(): void {
  const mode = latest?.agentChrome === undefined ? undefined : latest.agentChrome ? 'full' : 'limited';
  modeButton.hidden = !mode;
  if (!mode) { modeDetails.hidden = true; return; }
  if (mode === 'limited' && !modeShownLimited) { modeShownLimited = true; modeOpen = true; }
  modeButton.dataset.mode = mode; modeDetails.dataset.mode = mode;
  modeButton.textContent = mode === 'full' ? 'Full mode' : 'Limited mode';
  modeButton.title = `${modeExplanations[mode]}\nClick to ${modeOpen ? 'hide' : 'show'} details.`;
  modeButton.setAttribute('aria-expanded', String(modeOpen));
  modeText.textContent = modeExplanations[mode];
  modeDetails.hidden = !modeOpen;
}
const quickConnect = element<HTMLButtonElement>('quick-connect');
const cancelConnect = element<HTMLButtonElement>('cancel-connect');
const editorSources = element('editor-sources');
const pickerControls = element('element-picker-controls');
const pickerStatus = element('element-picker-status');
const cancelElementPick = element<HTMLButtonElement>('cancel-element-pick');
const elementDrafts: Record<string, ElementDraft> = Object.create(null);
let activePage: { id?: number; url?: string; title?: string; windowId?: number } | undefined;
let picking: { id: string; chatId: string; generation: number; tabId?: number; url?: string } | undefined;
let quickAttempt: { url: string; id: string; secret: string; controller: AbortController } | undefined;
element('extension-id').textContent = chrome.runtime.id;
let active: ChromeChatConnection | undefined;
let latest: ChromeChatSnapshot | undefined;
let etag: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let request: AbortController | undefined;
let generation = 0;
let failures = 0;
let compatible = false;
const chromeVersion = chrome.runtime.getManifest().version;
let draftState: ChatDraftState = {};
let outbox: ChromeChatCommand[] = [];
let outboxSession: string | undefined;
const persisted = new Set<string>();
let outboxWrite: Promise<void> = Promise.resolve();
let flushing = false;
let feedback: string | undefined;
let pairingPending = false;
const supported = new Set<string>([...Object.values(chromeChatFooterCommands).flat(), 'send', 'stop', 'openAttachment', 'select', 'switchAgent', 'approve', 'setViewMode', 'saveFeatureAi']);
const passive = new Set(['ready', 'saveDrafts', 'tabDraft']);

function emit(message: HostToView): void { window.dispatchEvent(new MessageEvent('message', { data: message })); }
function render(): void {
  if (!latest?.view) { return; }
  app.hidden = false;
  renderConversations(latest);
  renderMode();
  if (resumeState && resumeState.chatId !== latest.chatId) { void saveResume({ ...resumeState, chatId: latest.chatId }); }
  const view = latest.view;
  const light = view.themeKind === 1 || view.themeKind === 4;
  document.documentElement.style.colorScheme = light ? 'light' : 'dark';
  for (const name of ['vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light']) { document.body.classList.remove(name); }
  document.body.classList.add(view.themeKind === 4 ? 'vscode-high-contrast-light' : view.themeKind === 3 ? 'vscode-high-contrast' : light ? 'vscode-light' : 'vscode-dark');
  for (const [key, value] of Object.entries(view.themeTokens ?? {})) {
    if (/^--vscode-[a-zA-Z0-9-]+$/.test(key)) { document.documentElement.style.setProperty(key, value); }
  }
  emit({ type: 'state', state: { ...view,
    browserApi: true, nativeBrowser: 'unsupported', hasBrowserTab: activePage?.id !== undefined,
    attachments: (elementDrafts[latest.chatId]?.attachments ?? []).map(item => ({ id: item.id, kind: item.kind ?? 'element', label: item.label, reference: item.reference })),
    blocked: latest.canSend ? view.blocked : 'Update the editor extension to enable sending from Chrome.',
    entries: feedback ? [...view.entries, { kind: 'notice', text: feedback }] : view.entries,
  } });
}
/** The conversations of the editor panel; the one chosen stays put when the editor switches tabs. */
function renderConversations(snapshot: ChromeChatSnapshot): void {
  const tabs = snapshot.view.tabs;
  const signature = JSON.stringify([snapshot.chatId, tabs.map(tab => [tab.chatId, tab.title, tab.busy])]);
  conversation.hidden = tabs.length < 2;
  if (conversation.dataset.signature === signature || document.activeElement === conversation) { return; }
  conversation.dataset.signature = signature;
  conversation.replaceChildren(...tabs.map(tab => {
    const option = document.createElement('option');
    option.value = tab.chatId; option.textContent = `${tab.busy ? '● ' : ''}${tab.title}`;
    return option;
  }));
  conversation.value = snapshot.chatId;
}
let pinning = 0;
conversation.addEventListener('change', () => {
  const connection = active, chatId = conversation.value, current = generation, request = ++pinning;
  if (!connection || !latest || chatId === latest.chatId) { return; }
  conversation.disabled = true;
  void fetch(`${connection.url}/command`, { method: 'POST',
    headers: bridgeHeaders(connection, true),
    body: JSON.stringify({ id: crypto.randomUUID(), chatId, message: { type: 'pin' } }), signal: AbortSignal.timeout(10_000),
  }).then(async response => {
    const result = await response.json().catch(() => ({})) as { error?: string; snapshot?: ChromeChatSnapshot };
    if (current !== generation || request !== pinning) { return; }
    if (response.status === 426) { requireUpdate(result.error ?? 'Update both AI Browser extensions.'); return; }
    if (!response.ok) { throw new Error(result.error ?? 'Could not switch conversations.'); }
    cancelPick(); feedback = undefined; etag = undefined;
    if (result.snapshot?.view) { latest = result.snapshot; }
  }).catch(error => {
    if (current === generation && request === pinning) { feedback = error instanceof Error ? error.message : 'Could not switch conversations.'; }
  }).finally(() => {
    if (current !== generation || request !== pinning) { return; }
    conversation.disabled = false; delete conversation.dataset.signature; render();
  });
});
function showFeedback(text: string): void { feedback = text; render(); }
function persistOutbox(): Promise<void> {
  const saved = outbox.slice();
  const drafts = JSON.parse(JSON.stringify(elementDrafts)) as Record<string, ElementDraft>;
  const footerPosition = { token: active?.token, deliverySession: active?.deliverySession, cursor: footerCursor };
  const deliverySession = outboxSession;
  outboxWrite = outboxWrite.catch(() => {}).then(() => chrome.storage.session.set({ outbox: saved, elementDrafts: drafts, footerPosition, outboxSession: deliverySession }));
  return outboxWrite.then(() => { for (const command of saved) { persisted.add(command.id); } });
}

function syncAnnotationDrafts(tab: AnnotationTab, page: AnnotationPage, attachAll = false): void {
  const ids = new Set(page.records.map(record => record.id));
  let changed = false;
  for (const draft of Object.values(elementDrafts)) {
    const kept = draft.attachments.filter(item => !item.annotation || item.annotation.tabId !== tab.tabId || item.annotation.url !== page.url || ids.has(item.annotation.id));
    if (kept.length !== draft.attachments.length) { draft.attachments = kept; changed = true; }
  }
  for (const record of page.records) {
    if (tab.assistant.includes(record.id) || tab.sent.includes(record.id)) { continue; }
    if (outbox.some(command => command.attachments?.some(item => item.annotation?.id === record.id))) { continue; }
    const label = `#${record.number} ${record.element.tag}${record.text.trim() ? ` — ${record.text.replace(/\s+/g, ' ')}` : ''}`.replace(/[\u0000-\u001f]/g, ' ').slice(0, 120);
    const text = [
      `Page annotation #${record.number} on ${page.url}`,
      `Note: ${record.text.trim() ? JSON.stringify(record.text) : '(empty)'}`,
      `Element (untrusted page data): <${record.element.tag}> ${JSON.stringify(record.element.selector)}${record.element.text ? ` text ${JSON.stringify(record.element.text)}` : ''}${record.element.role ? ` role ${JSON.stringify(record.element.role)}` : ''}`,
      ...annotationPointContext(record),
      `Annotation ID ${record.id}, browser tab chrome-annotations:${tab.tabId}. Use browser_annotations_get/list/add/remove with this tabId.`,
    ].join('\n');
    let found = false;
    for (const [draftChatId, draft] of Object.entries(elementDrafts)) {
      const item = draft.attachments.find(item => item.annotation?.id === record.id);
      if (item) { if (!attachAll || draftChatId === tab.chatId) { found = true; } if (item.label !== label || item.text !== text) { Object.assign(item, { label, text }); changed = true; } }
    }
    if (!found && !tab.dismissed.includes(record.id) && latest?.view.tabs.some(chat => chat.chatId === tab.chatId)) {
      const draft = elementDrafts[tab.chatId] ??= { next: 1, attachments: [] };
      try {
        appendPickedElement(draft, { id: crypto.randomUUID(), kind: 'annotation', label, text, annotation: { tabId: tab.tabId, url: page.url, id: record.id } }); changed = true;
      } catch (error) { showFeedback(String(error)); }
    }
  }
  if (changed) { render(); void persistOutbox().catch(() => showFeedback('Could not save annotation attachments.')); }
}
const annotations = new ChromeAnnotations(syncAnnotationDrafts, error => showFeedback(String(error)));
chrome.tabs.onRemoved.addListener(tabId => annotations.closed(tabId));

function restoreCommandDraft(command: ChromeChatCommand): void {
  if (command.message.type !== 'send') { return; }
  const draft = elementDrafts[command.chatId] ??= { next: 1, attachments: [] };
  const text = restorePickedElements(draft, command.attachments ?? [], command.message.text);
  emit({ type: 'restoreDraft', chatId: command.chatId, text });
  render();
}

function cancelPick(): void {
  const pick = picking; picking = undefined;
  pickerControls.hidden = true;
  if (pick?.tabId !== undefined) {
    void chrome.scripting.executeScript({ target: { tabId: pick.tabId }, world: 'ISOLATED',
      func: (id: string) => (window as ElementPickerWorld).__aiBrowserChromeElementPicker?.cancel(id), args: [pick.id],
    }).catch(() => {});
  }
}

async function injectPick(pick: NonNullable<typeof picking>): Promise<void> {
  if (picking !== pick || pick.generation !== generation || pick.tabId === undefined) { return; }
  pickerStatus.textContent = 'Hover over an element and click to select it. Press Esc to cancel.';
  try {
    await chrome.scripting.executeScript({ target: { tabId: pick.tabId }, world: 'ISOLATED', files: ['elementPicker.js'] });
  } catch {
    if (picking !== pick || pick.generation !== generation) { return; }
    cancelPick(); showFeedback('Chrome denied access to this page. Check the extension\'s site access settings at chrome://extensions.'); return;
  }
  if (picking !== pick || pick.generation !== generation) { return; }
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: pick.tabId }, world: 'ISOLATED',
      func: (id: string) => {
        const picker = (window as ElementPickerWorld).__aiBrowserChromeElementPicker;
        if (!picker) { throw new Error('Element picker is unavailable'); }
        return picker.start(id);
      }, args: [pick.id],
    });
    if (picking !== pick || pick.generation !== generation) { return; }
    const data: ChromeElementPick | undefined = results[0]?.result;
    if (!data) { cancelPick(); return; }
    const report = renderElementMarkdown(data, data.url).replace('from Integrated Browser', 'from Google Chrome')
      + `\n\nCSS selector: ${inertProse(oneLine(data.selector))}`;
    if (report.length > 64_000) { throw new Error('The element context is too large. Select a smaller element.'); }
    const self = data.ancestors.at(-1);
    const label = self ? formatAncestor(self).slice(0, 120) : 'Element';
    const draft = elementDrafts[pick.chatId] ??= { next: 1, attachments: [] };
    appendPickedElement(draft, { id: crypto.randomUUID(), kind: 'element', label, text: report });
    await persistOutbox();
    if (pick.generation === generation) {
      feedback = latest?.chatId === pick.chatId ? undefined : 'Element saved in the original conversation\'s draft.';
      render();
    }
  } catch (error) {
    if (pick.generation === generation) { showFeedback(error instanceof Error ? error.message : 'Could not select the element.'); }
  } finally { if (picking === pick) { cancelPick(); } }
}

/** Called directly by the shared menu's click handler, retaining Chrome's user gesture. */
function startPick(): void {
  if (!active || !latest) { return; }
  if (!supportsFeature('elements')) { showFeedback(chromeChatFeatureError('elements')); return; }
  if (!latest.canAttachElements) { showFeedback('Update the editor extension and reconnect to attach elements.'); return; }
  cancelPick();
  const pick: NonNullable<typeof picking> = { id: crypto.randomUUID(), chatId: latest.chatId, generation, tabId: activePage?.id };
  picking = pick; pickerControls.hidden = false; pickerStatus.textContent = 'Preparing the element picker…';
  // Tab and site access are granted at install (manifest), so nothing is asked here.
  void (async () => {
    const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (picking !== pick || pick.generation !== generation) { return; }
    if (tab?.id === undefined || !tab.url || (pick.tabId !== undefined && pick.tabId !== tab.id)) { throw new Error('The active tab changed. Select the element again.'); }
    const url = new URL(tab.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname === 'chromewebstore.google.com' || (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'))) {
      throw new Error('Elements cannot be selected on internal Chrome pages. Open a website.');
    }
    pick.tabId = tab.id; pick.url = url.href;
    await injectPick(pick);
  })().catch(error => {
    if (picking === pick) { cancelPick(); showFeedback(error instanceof Error ? error.message : 'Could not open the element picker.'); }
  });
}
/** Capture the destination before any asynchronous picker or file read. */
async function addChromeAttachment(chatId: string, current: number, value: Omit<ChromeElementAttachment, 'id' | 'reference'>): Promise<void> {
  if (current !== generation || !active) { return; }
  const draft = elementDrafts[chatId] ??= { next: 1, attachments: [] };
  const item = { ...value, id: crypto.randomUUID(), reference: `@${draft.next}` };
  if (!readChromeElementAttachments([...draft.attachments, item])) { throw new Error('Attachments exceed the limit: 8 items, 200,000 text characters and 4 MB of files in total.'); }
  appendPickedElement(draft, item);
  try { await persistOutbox(); }
  catch (error) { draft.attachments = draft.attachments.filter(a => a.id !== item.id); throw error; }
  render();
}

async function fileAttachment(chatId: string, current: number, file: Blob, name: string, kind: 'file' | 'video' | 'screenshot', text = `Attached file: ${name}`): Promise<void> {
  if (file.size > 4_000_000) { throw new Error('File exceeds 4 MB. Attach a smaller file.'); }
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file);
  });
  await addChromeAttachment(chatId, current, { kind, label: name.slice(0, 160), text,
    file: { name, mime: file.type.split(';')[0] || 'application/octet-stream', base64 } });
}
let recording: { recorder: MediaRecorder; stream: MediaStream; started: number; elapsed: number } | undefined;
let recordingStarting = false;
function chromeRecordingStatus(): void {
  if (!recording) { emit({ type: 'recordingStatus', seconds: 0 }); return; }
  const { recorder, started, elapsed } = recording;
  emit({ type: 'recordingStatus', state: recorder.state === 'inactive' ? 'stopping' : recorder.state === 'paused' ? 'paused' : 'recording',
    seconds: (elapsed + (recorder.state === 'recording' ? Date.now() - started : 0)) / 1000 });
}
function controlChromeRecording(action: 'pause' | 'resume' | 'stop'): void {
  const session = recording;
  if (!session || session.recorder.state === 'inactive') { return; }
  if (session.recorder.state === 'recording') { session.elapsed += Date.now() - session.started; session.started = Date.now(); }
  if (action === 'stop') { session.recorder.stop(); }
  else if (action === 'pause' && session.recorder.state === 'recording') { session.recorder.pause(); }
  else if (action === 'resume' && session.recorder.state === 'paused') { session.started = Date.now(); session.recorder.resume(); }
  chromeRecordingStatus();
}
function supportsFeature(feature: keyof typeof chromeChatCapabilities): boolean {
  return !!latest && !!negotiateChromeChatCapabilities(latest.capabilities, latest.protocolVersion)[feature];
}
async function attachFromChrome(kind: string): Promise<void> {
  if (!latest || !active) { return; }
  const chatId = latest.chatId, current = generation;
  const feature = chromeChatAttachmentFeature(kind);
  if (feature && !supportsFeature(feature)) { showFeedback(chromeChatFeatureError(feature)); return; }
  if (kind === 'annotation' || kind === 'pointAnnotation') {
    cancelPick();
    const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (current !== generation || tab?.id === undefined) { return; }
    await annotations.start(tab.id, chatId, kind === 'pointAnnotation' ? 'point' : 'element'); return;
  }
  if (kind === 'file') {
    const input = document.createElement('input'); input.type = 'file';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) { void fileAttachment(chatId, current, file, file.name, 'file').catch(error => showFeedback(String(error))); }
      input.remove();
    });
    input.addEventListener('cancel', () => input.remove());
    input.hidden = true; document.body.append(input); input.click(); return;
  }
  if (kind === 'video') {
    if (recording) { controlChromeRecording('stop'); return; }
    if (recordingStarting) { return; }
    recordingStarting = true;
    emit({ type: 'recordingStatus', state: 'starting', seconds: 0 });
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); }
    catch (error) { if (generation === current) { chromeRecordingStatus(); } throw error; }
    finally { recordingStarting = false; }
    if (generation !== current || !active) { stream.getTracks().forEach(track => track.stop()); return; }
    let recorder: MediaRecorder;
    try { recorder = new MediaRecorder(stream, { videoBitsPerSecond: 1_000_000 }); }
    catch (error) { stream.getTracks().forEach(track => track.stop()); chromeRecordingStatus(); throw error; }
    const chunks: Blob[] = []; let size = 0;
    const session = { recorder, stream, started: Date.now(), elapsed: 0 }; recording = session;
    const timer = setInterval(chromeRecordingStatus, 250);
    const timeout = setTimeout(() => { if (recording === session) { controlChromeRecording('stop'); } }, 20_000);
    recorder.ondataavailable = event => {
      chunks.push(event.data); size += event.data.size;
      if (size >= 3_500_000 && recording === session) { controlChromeRecording('stop'); }
    };
    recorder.onstop = () => {
      clearTimeout(timeout); clearInterval(timer); stream.getTracks().forEach(track => track.stop());
      const save = chunks.length && current === generation && active ? fileAttachment(chatId, current, new Blob(chunks, { type: recorder.mimeType }), recorder.mimeType.includes('mp4') ? 'recording.mp4' : 'recording.webm', 'video') : Promise.resolve();
      void save.catch(error => showFeedback(String(error))).finally(() => {
        if (recording === session) { recording = undefined; chromeRecordingStatus(); }
      });
    };
    recorder.onerror = () => { showFeedback('Chrome could not record the selected screen.'); if (recording === session) { controlChromeRecording('stop'); } };
    stream.getVideoTracks()[0].onended = () => { if (recording === session) { controlChromeRecording('stop'); } };
    try { recorder.start(500); chromeRecordingStatus(); }
    catch (error) {
      clearTimeout(timeout); clearInterval(timer); stream.getTracks().forEach(track => track.stop());
      if (recording === session) { recording = undefined; chromeRecordingStatus(); }
      throw error;
    }
    return;
  }
  const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.url || tab.id === undefined || !/^https?:/.test(tab.url)) { throw new Error('Open a regular website in Chrome first.'); }
  const url = new URL(tab.url); url.username = ''; url.password = '';
  if (kind === 'screenshot') {
    if (tab.windowId === undefined) { throw new Error('Chrome window unavailable.'); }
    const data = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const after = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (after?.id !== tab.id || after.url !== tab.url) { throw new Error('The active page changed during capture. Try again.'); }
    await addChromeAttachment(chatId, current, { kind: 'screenshot', label: 'screenshot.png', text: `Screenshot of ${url.href}`, file: { name: 'screenshot.png', mime: 'image/png', base64: data.split(',')[1] } }); return;
  }
  if (kind === 'page' || kind === 'sharedPage') {
    await addChromeAttachment(chatId, current, { kind, label: (tab.title || url.href).slice(0, 160),
      text: `The page the user is looking at: ${url.href}\n${tab.title || ''}\nThis address alone does not grant browser tool access. Check browser_tabs before interacting.`,
      ...(kind === 'sharedPage' ? { tabId: tab.id } : {}) }); return;
  }
  throw new Error('This attachment is unavailable in Chrome.');
}

cancelElementPick.addEventListener('click', cancelPick);
window.addEventListener('pagehide', () => { cancelPick(); generation++; controlChromeRecording('stop'); recording?.stream.getTracks().forEach(track => track.stop()); });
let pageQuery = 0;
function refreshActivePage(): void {
  const current = ++pageQuery;
  void chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    if (current !== pageQuery) { return; }
    activePage = tabs[0];
    for (const draft of Object.values(elementDrafts)) {
      for (let index = 0; index < draft.attachments.length; index++) {
        const item = draft.attachments[index];
        if (item.kind === 'sharedPage' && item.tabId === activePage?.id && activePage?.url && /^https?:/.test(activePage.url)) {
          const url = new URL(activePage.url); url.username = ''; url.password = '';
          draft.attachments[index] = { ...item, label: (activePage.title || url.href).slice(0, 160),
            text: `Shared page: ${url.href}\n${activePage.title || ''}\nCheck browser_tabs before interacting; Chrome sharing does not grant tool access.` };
        }
      }
    }
    if (picking?.tabId !== undefined && (activePage?.id !== picking.tabId || (picking.url && activePage?.url && picking.url !== activePage.url))) { cancelPick(); }
    render();
  }).catch(() => { if (current === pageQuery) { activePage = undefined; render(); } });
}
chrome.tabs.onActivated.addListener(refreshActivePage);
chrome.tabs.onUpdated.addListener((tabId, _change, tab) => {
  let changed = false;
  if (tab.url && /^https?:/.test(tab.url)) {
    const url = new URL(tab.url); url.username = ''; url.password = '';
    for (const draft of Object.values(elementDrafts)) {
      draft.attachments = draft.attachments.map(item => {
        if (item.kind !== 'sharedPage' || item.tabId !== tabId) { return item; }
        changed = true;
        return { ...item, label: (tab.title || url.href).slice(0, 160),
          text: `Shared page: ${url.href}\n${tab.title || ''}\nCheck browser_tabs before interacting; Chrome sharing does not grant tool access.` };
      });
    }
  }
  if (changed) { void persistOutbox().catch(() => showFeedback('Could not save the shared page.')); }
  refreshActivePage();
});
refreshActivePage();

window.aiBrowserChatHost = {
  getState: () => draftState,
  setState(state) { draftState = state; void chrome.storage.session.set({ draftState: state }); },
  postMessage(message: ViewToHost) {
    if (message.type === 'controlRecording') { controlChromeRecording(message.action); return; }
    if (message.type === 'copy') { void navigator.clipboard.writeText(message.text).catch(error => showFeedback(String(error))); return; }
    if (message.type === 'openLink' && /^https?:\/\//i.test(message.url)) { void chrome.tabs.create({ url: message.url }).catch(error => showFeedback(String(error))); return; }
    if (message.type === 'openBrowser') { void chrome.tabs.create({ url: 'chrome://newtab/' }); return; }
    if (message.type === 'attach') {
      if (message.kind === 'element') { startPick(); }
      else { void attachFromChrome(message.kind).catch(error => showFeedback(error instanceof Error ? error.message : String(error))); }
      return;
    }
    if (message.type === 'pasteFile') {
      if (!supportsFeature('files')) { emit({ type: 'pastedFileResult', id: message.id, error: chromeChatFeatureError('files') }); return; }
      const chatId = message.chatId;
      if (!active || !latest?.view.tabs.some(tab => tab.chatId === chatId && tab.id === message.tabId)) {
        emit({ type: 'pastedFileResult', id: message.id, error: 'The destination chat is no longer open.' }); return;
      }
      void addChromeAttachment(chatId, generation, { kind: 'file', label: message.name.slice(0, 160), text: `Attached file: ${message.name}`,
        file: { name: message.name, mime: message.mime || 'application/octet-stream', base64: message.base64 } })
        .then(() => emit({ type: 'pastedFileResult', id: message.id }), error => emit({ type: 'pastedFileResult', id: message.id, error: String(error) }));
      return;
    }
    if (message.type === 'removeAttachment' || (message.type === 'openAttachment' && message.entry === undefined)) {
      const draft = latest && elementDrafts[latest.chatId];
      const attachment = draft?.attachments.find(item => item.id === message.id);
      if (attachment) {
        if (message.type === 'removeAttachment') {
          if (attachment.annotation) { annotations.dismiss(attachment.annotation.tabId, attachment.annotation.id); }
          draft!.attachments = draft!.attachments.filter(item => item.id !== message.id);
          render(); void persistOutbox().catch(() => showFeedback('Could not save the attachment draft.'));
        } else {
          const dialog = document.createElement('dialog'); dialog.className = 'chrome-element-preview';
          const close = document.createElement('button'); close.textContent = 'Close'; close.addEventListener('click', () => dialog.close());
          const text = document.createElement('pre'); text.textContent = attachment.text;
          dialog.append(close, text);
          if (attachment.file?.mime.startsWith('image/')) {
            const image = document.createElement('img'); image.src = `data:${attachment.file.mime};base64,${attachment.file.base64}`;
            image.alt = attachment.label; image.style.maxWidth = '100%'; dialog.append(image);
          }
          dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal();
        }
        return;
      }
    }
    if (passive.has(message.type)) { return; }
    if (!supported.has(message.type)) {
      const error = 'This action is available in the editor. Chrome supports chat, attachments, approvals, model selection and chat settings.';
      if (message.type === 'temporaryStorage') { emit({ type: 'temporaryStorage', error }); }
      showFeedback(error); return;
    }
    if (!active || !latest) { return; }
    const chatId = latest.chatId, current = generation;
    const feature = chromeChatCommandFeature(message);
    if (!supportsFeature(feature)) { showFeedback(chromeChatFeatureError(feature)); return; }
    if (message.type === 'chooseWorkdir') { showFeedback('Choose the working folder in the VS Code window.'); }
    prepareChromeMessage(message, chatId, current);
  },
};

const pendingSends = new Set<{ chatId: string; text: string }>();
function prepareChromeMessage(message: ViewToHost, chatId: string, current: number): void {
  if (message.type === 'stop') {
    for (const pending of pendingSends) {
      if (pending.chatId !== chatId) { continue; }
      pendingSends.delete(pending);
      emit({ type: 'restoreDraft', chatId, text: pending.text });
    }
  }
  if (message.type !== 'send') { enqueueChromeMessage(message, chatId, current); return; }
  const pending = { chatId, text: message.text };
  pendingSends.add(pending);
  void annotations.poll().then(() => {
    if (!pendingSends.delete(pending)) { return; }
    enqueueChromeMessage(message, chatId, current);
  }).catch(error => {
    if (!pendingSends.delete(pending)) { return; }
    emit({ type: 'restoreDraft', chatId, text: message.text }); showFeedback(String(error));
  });
}

function enqueueChromeMessage(message: ViewToHost, chatId: string, current: number): void {
  if (current !== generation || !active) {
    if (message.type === 'send') { emit({ type: 'restoreDraft', chatId, text: message.text }); }
    return;
  }
  const attachments = message.type === 'send' ? elementDrafts[chatId]?.attachments.slice() : undefined;
  const command = readChromeChatCommand({ id: crypto.randomUUID(), chatId, message, ...(attachments?.length ? { attachments } : {}) });
  if (!command) {
    if (message.type === 'send') { queueMicrotask(() => emit({ type: 'restoreDraft', chatId, text: message.text })); }
    showFeedback('This message is invalid or too large (maximum 100,000 characters).'); return;
  }
  outbox.push(command); feedback = undefined;
  if (message.type === 'send') { delete elementDrafts[chatId]; render(); }
  void persistOutbox().then(() => flush()).catch(() => {
    outbox = outbox.filter(item => item.id !== command.id);
    restoreCommandDraft(command);
    showFeedback('Could not save the outgoing message. Your text was returned to the draft.');
  });
}

async function flush(): Promise<void> {
  if (flushing || !active || !compatible) { return; }
  flushing = true;
  const current = generation;
  const connection = active;
  try {
    while (outbox.length && current === generation) {
      const command = outbox[0];
      if (!persisted.has(command.id)) { return; }
      const commandFeature = chromeChatCommandFeature(command.message);
      if (!supportsFeature(commandFeature)) {
        outbox.shift(); persisted.delete(command.id); restoreCommandDraft(command); await persistOutbox();
        showFeedback(chromeChatFeatureError(commandFeature)); continue;
      }
      const unavailable = command.attachments?.map(item => chromeChatAttachmentFeature(item.kind)).find(feature => !supportsFeature(feature));
      if (unavailable) {
        outbox.shift(); persisted.delete(command.id); restoreCommandDraft(command); await persistOutbox();
        showFeedback(chromeChatFeatureError(unavailable)); continue;
      }
      let response: Response;
      try {
        if (command.attachments?.some(item => item.annotation)) {
          await exchangeAnnotations(connection, current);
          if (current !== generation) { return; }
        }
        response = await fetch(`${connection.url}/command`, { method: 'POST',
          headers: bridgeHeaders(connection, true),
          body: JSON.stringify(command), signal: AbortSignal.timeout(10_000),
        });
      } catch {
        if (current === generation) { showFeedback('Message pending. Reconnecting and retrying automatically.'); }
        return;
      }
      if (current !== generation) { return; }
      if (response.status >= 500) { showFeedback('Editor unavailable. The outgoing message will retry automatically.'); return; }
      const result = await response.json().catch(error => {
        if (response.ok) { throw error; }
        return { error: 'Connection refused. Reconnect to the editor before sending again.' };
      }) as { error?: string; snapshot?: ChromeChatSnapshot };
      if (current !== generation) { return; }
      if (response.status === 426) { requireUpdate(result.error ?? 'Update both AI Browser extensions to the latest version.'); return; }
      outbox.shift(); persisted.delete(command.id);
      if (!response.ok) { restoreCommandDraft(command); }
      else if (command.message.type === 'send') {
        for (const item of command.attachments ?? []) { if (item.annotation) { annotations.sent(item.annotation.tabId, item.annotation.id); } }
      }
      await persistOutbox();
      if (current !== generation) { return; }
      if (!response.ok) {
        showFeedback(result.error ?? 'Action refused. Review the conversation in the editor.');
      } else {
        feedback = undefined;
        if (result.snapshot?.view) { latest = result.snapshot; render(); }
      }
      if (command.message.type === 'saveFeatureAi') {
        emit(response.ok ? { type: 'featureAiSaved', settings: latest?.settings.featureAi,
          recordingQuality: latest?.settings.recordingQuality, recordingSeconds: latest?.settings.recordingSeconds }
          : { type: 'featureAiSaved', error: result.error ?? 'Settings were not saved.' });
      }
    }
  } catch { showFeedback('Could not confirm delivery. Reconnecting before retrying.'); }
  finally { flushing = false; }
}

/** Unknown delivery after a host restart must never silently repeat a mutation. */
async function reconcileDelivery(session: string | undefined): Promise<void> {
  if (outbox.length && (!session || outboxSession !== session)) {
    const pending = outbox.splice(0);
    for (const command of pending) { persisted.delete(command.id); restoreCommandDraft(command); }
    showFeedback('Delivery could not be confirmed after reconnecting. Pending messages were returned to their drafts. Check the conversation and Git state before retrying.');
  }
  if (outboxSession !== session) { outboxSession = session; await persistOutbox(); }
}

/**
 * Gives every queued outgoing message back to its draft. The composer cleared
 * the text and chips at send, so dropping the queue — a Disconnect, a new
 * connection code — would otherwise lose them for good.
 */
function returnOutboxToDrafts(): boolean {
  const pending = outbox.splice(0);
  for (const command of pending) { persisted.delete(command.id); restoreCommandDraft(command); }
  persisted.clear();
  return pending.length > 0;
}

function reset(): void {
  controlChromeRecording('stop');
  emit({ type: 'recordingStatus', seconds: 0 });
  cancelPick();
  cancelQuickAttempt();
  generation++; compatible = false; annotationResults.clear(); active = undefined; latest = undefined;
  request?.abort(); clearTimeout(timer); etag = undefined; failures = 0; feedback = undefined;
  pairing.hidden = false; app.hidden = true; disconnect.hidden = true; conversation.hidden = true; modeButton.hidden = true; modeDetails.hidden = true; modeOpen = false; modeShownLimited = false; conversation.disabled = false;
}

function bridgeHeaders(connection: ChromeChatConnection, json = false): Record<string, string> {
  return { Authorization: `Bearer ${connection.token}`, [chromeChatProtocolHeader]: String(chromeChatProtocolVersion),
    [chromeChatVersionHeader]: chromeVersion, [chromeChatCapabilitiesHeader]: JSON.stringify(chromeChatCapabilities), ...(json ? { 'Content-Type': 'application/json' } : {}) };
}
function requireUpdate(message: string): void {
  // Keep outgoing commands and drafts intact. Nothing retries until a fresh connection is compatible.
  reset(); status.textContent = message; status.dataset.state = 'error';
}
function editorCompatibility(peer: { protocolVersion?: unknown; editorVersion?: unknown; capabilities?: unknown }): string | undefined {
  return chromeChatCompatibilityError(peer.protocolVersion, chromeChatProtocolVersion, peer.editorVersion, chromeVersion)
    ?? (negotiateChromeChatCapabilities(peer.capabilities, peer.protocolVersion).chat ? undefined : chromeChatFeatureError('chat'));
}

function pairingHeaders(secret?: string): Record<string, string> {
  return { [chromeChatProtocolHeader]: String(chromeChatProtocolVersion), [chromeChatVersionHeader]: chromeVersion, [chromeChatCapabilitiesHeader]: JSON.stringify(chromeChatCapabilities), 'X-AI-Browser-Extension': chrome.runtime.id, ...(secret ? { 'X-Pairing-Secret': secret } : {}) };
}
function cancelQuickAttempt(): void {
  const attempt = quickAttempt; quickAttempt = undefined;
  attempt?.controller.abort();
  if (attempt) {
    void fetch(`${attempt.url}/pair/${attempt.id}`, { method: 'DELETE', headers: pairingHeaders(attempt.secret), signal: AbortSignal.timeout(2000) }).catch(() => {});
  }
  quickConnect.disabled = false; cancelConnect.hidden = true;
}

async function requestQuickConnection(url: string, current: number): Promise<void> {
  if (current !== generation) { return; }
  const attempt = { url, id: crypto.randomUUID(),
    secret: Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join(''),
    controller: new AbortController() };
  quickAttempt = attempt; quickConnect.disabled = true; cancelConnect.hidden = false; editorSources.replaceChildren();
  status.textContent = 'Click Allow in the editor chat.';
  const deadline = Date.now() + 90_000;
  const expired = setTimeout(() => attempt.controller.abort(), 90_000);
  try {
    let method = 'POST';
    while (current === generation && !attempt.controller.signal.aborted) {
      const response = await fetch(`${url}/pair/${attempt.id}`, { method, headers: pairingHeaders(attempt.secret), signal: attempt.controller.signal });
      if (current !== generation) { return; }
      if (response.status === 429) { throw new Error('A request is already pending in the editor. Allow or deny it, then try again.'); }
      if (response.status === 426) { const error = await response.json() as { error?: string }; throw new Error(error.error ?? 'Update both AI Browser extensions.'); }
      if (!response.ok) { throw new Error('The request expired or the editor is unavailable. Click Connect again.'); }
      const result = await response.json() as { status?: string; connection?: unknown };
      if (current !== generation) { return; }
      if (result.status === 'approved') {
        const connection = readChromeChatConnection(result.connection);
        if (!connection || connection.extensionId !== chrome.runtime.id) { throw new Error('The editor returned invalid connection details.'); }
        const problem = editorCompatibility(connection); if (problem) { throw new Error(problem); }
        const key = (result.connection as { resumeKey?: unknown }).resumeKey;
        await saveResume(typeof key === 'string' && /^[a-f0-9]{64}$/.test(key) ? { key } : undefined);
        await outboxWrite.catch(() => {});
        if (current !== generation || attempt.controller.signal.aborted) { return; }
        returnOutboxToDrafts(); await persistOutbox().catch(() => {});
        await chrome.storage.session.set({ connection, outbox });
        if (current !== generation || attempt.controller.signal.aborted) { return; }
        quickAttempt = undefined;
        connect(connection); return;
      }
      if (result.status !== 'pending') { throw new Error('Connection denied in the editor.'); }
      if (Date.now() >= deadline) { throw new Error('The request timed out.'); }
      method = 'GET';
      await new Promise<void>(resolve => setTimeout(resolve, 500));
    }
  } catch (error) {
    if (current === generation) { status.textContent = attempt.controller.signal.aborted ? 'The request timed out. Try again.' : error instanceof Error ? error.message : 'Could not connect.'; }
  } finally {
    clearTimeout(expired);
    if (quickAttempt === attempt) { cancelQuickAttempt(); }
  }
}

quickConnect.addEventListener('click', () => {
  cancelQuickAttempt();
  const current = ++generation;
  quickConnect.disabled = true; cancelConnect.hidden = false; editorSources.replaceChildren();
  status.textContent = 'Looking for an open editor…';
  void Promise.all(chromePairingPorts.map(async port => {
    const url = `http://127.0.0.1:${port}`;
    try {
      const response = await fetch(`${url}/discovery`, { headers: pairingHeaders(), signal: AbortSignal.timeout(1500) });
      if (!response.ok) { return undefined; }
      const host = await response.json() as { kind?: string; version?: number; label?: string; protocolVersion?: number; editorVersion?: string; capabilities?: unknown };
      return host.kind === chromePairingKind && host.version === 1 ? { url, label: typeof host.label === 'string' ? host.label : 'AI Browser', problem: editorCompatibility(host) } : undefined;
    } catch { return undefined; }
  })).then(found => {
    if (current !== generation) { return; }
    const hosts = found.filter((host): host is { url: string; label: string; problem: string | undefined } => !!host);
    quickConnect.disabled = false; cancelConnect.hidden = true;
    if (!hosts.length) { status.textContent = 'No editor found. Open a local window with an updated AI Browser extension and try again.'; return; }
    if (hosts.length === 1) {
      if (hosts[0].problem) { status.textContent = hosts[0].problem; status.dataset.state = 'error'; }
      else { void requestQuickConnection(hosts[0].url, current); }
      return;
    }
    status.textContent = 'Choose an editor window:';
    for (const host of hosts) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = host.problem ? `${host.label} — ${host.problem}` : host.label; button.disabled = !!host.problem;
      button.addEventListener('click', () => void requestQuickConnection(host.url, current)); editorSources.append(button);
    }
  });
});
cancelConnect.addEventListener('click', () => {
  generation++; cancelQuickAttempt(); editorSources.replaceChildren(); status.textContent = 'Connection cancelled.';
});

window.addEventListener('pagehide', cancelQuickAttempt);
const annotationResults = new Map<string, { id: string; value?: unknown; error?: string }>();
let annotationExchange: { generation: number; promise: Promise<void> } | undefined;
function exchangeAnnotations(connection: ChromeChatConnection, current: number): Promise<void> {
  if (annotationExchange?.generation === current) { return annotationExchange.promise; }
  const slot = { generation: current, promise: Promise.resolve() };
  slot.promise = performAnnotationExchange(connection, current).finally(() => { if (annotationExchange === slot) { annotationExchange = undefined; } });
  annotationExchange = slot;
  return slot.promise;
}
async function performAnnotationExchange(connection: ChromeChatConnection, current: number): Promise<void> {
  if (!compatible) { return; }
  const chats = new Set(latest?.view.tabs.map(tab => tab.chatId) ?? []);
  const results = [...annotationResults.values()];
  if (!supportsFeature('annotations')) { return; }
  const response = await fetch(`${connection.url}/annotations`, { method: 'POST',
    headers: bridgeHeaders(connection, true),
    body: JSON.stringify({ tabs: annotations.snapshot().filter(tab => chats.has(tab.chatId)), results }), signal: AbortSignal.timeout(5000) });
  if (response.status === 404) { throw new Error(chromeChatFeatureError('annotations')); }
  const data = await response.json() as { requests?: AnnotationRequest[]; error?: string };
  if (current !== generation) { return; }
  if (response.status === 426) { requireUpdate(data.error ?? 'Update both AI Browser extensions.'); return; }
  if (!response.ok) { throw new Error(data.error ?? 'Could not synchronize Chrome annotations.'); }
  for (const result of results) { annotationResults.delete(result.id); }
  for (const task of data.requests ?? []) {
    if (annotationResults.has(task.id)) { continue; }
    try { const value = await annotations.execute(task); if (current === generation) { annotationResults.set(task.id, { id: task.id, value }); } }
    catch (error) { if (current === generation) { annotationResults.set(task.id, { id: task.id, error: String(error) }); } }
    if (current !== generation) { return; }
  }
}

let footerCursor = 0;
let footerSession: string | undefined;
async function pollFooterEvents(connection: ChromeChatConnection, current: number): Promise<void> {
  if (!Object.keys(chromeChatFooterCommands).some(feature => supportsFeature(feature as keyof typeof chromeChatCapabilities))) { return; }
  const response = await fetch(`${connection.url}/events?after=${footerCursor}`, { headers: bridgeHeaders(connection), signal: AbortSignal.timeout(5000) });
  if (!response.ok) { throw new Error('Could not receive editor action results.'); }
  const result = await response.json() as { cursor: number; events: { id: number; chatId: string; message?: HostToView; error?: string }[] };
  if (current !== generation) { return; }
  const previousCursor = footerCursor;
  for (const event of result.events) {
    if (event.id <= footerCursor) { continue; }
    // Save attachment receipt and draft atomically, so reopening cannot attach it twice.
    footerCursor = event.id;
    if (event.message?.type === 'chromeAttachment') {
      if (latest?.view.tabs.some(tab => tab.chatId === event.chatId)) {
        try { await addChromeAttachment(event.chatId, current, { kind: 'file', label: event.message.label, text: event.message.text }); }
        catch (error) { showFeedback(String(error)); }
      }
    } else if (event.chatId === latest?.chatId) {
      if (event.error) { showFeedback(event.error); }
      else if (event.message) { emit(event.message); }
    }
    if (current !== generation) { return; }
    footerCursor = event.id;
  }
  footerCursor = result.cursor;
  if (footerCursor !== previousCursor) { await persistOutbox(); }
}

async function poll(connection: ChromeChatConnection, current: number): Promise<void> {
  if (latest) { await annotations.retainChats(new Set(latest.view.tabs.map(tab => tab.chatId))).catch(error => showFeedback(String(error))); }
  await annotations.poll();
  if (current !== generation) { return; }
  if (latest) {
    try { await exchangeAnnotations(connection, current); }
    catch (error) { if (current === generation) { showFeedback(String(error)); } }
  }
  if (current !== generation || active !== connection) { return; }
  const controller = new AbortController(); request = controller;
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const headers = bridgeHeaders(connection);
    if (etag) { headers['If-None-Match'] = etag; }
    const response = await fetch(`${connection.url}/snapshot`, { headers, cache: 'no-store', signal: controller.signal });
    if (current !== generation) { return; }
    if (response.status === 401 || response.status === 403) {
      await chrome.storage.session.remove('connection');
      if (current === generation) { void editorGone('The editor ended this connection.'); }
      return;
    }
    if (response.status === 426) { const error = await response.json() as { error?: string }; requireUpdate(error.error ?? 'Update both AI Browser extensions.'); return; }
    if (response.status !== 304) {
      if (!response.ok) { throw new Error('Editor unavailable'); }
      const snapshot = await response.json() as ChromeChatSnapshot;
      if (current !== generation) { return; }
      const problem = editorCompatibility(snapshot);
      if (problem || snapshot.version !== 1 || !snapshot.view) {
        requireUpdate(problem ?? 'Update both AI Browser extensions to the latest version.'); return;
      }
      await reconcileDelivery(snapshot.deliverySession ?? `legacy:${connection.token}`);
      if (current !== generation) { return; }
      compatible = true;
      status.title = `Chrome ${chromeVersion} · VS Code ${snapshot.editorVersion ?? 'unknown'}`;
      latest = snapshot; render(); etag = response.headers.get('ETag') ?? undefined;
    }
    status.textContent = latest?.blocked ?? (latest?.running ? 'Working…' : 'Connected');
    status.dataset.state = latest?.blocked ? 'error' : 'connected';
    await pollFooterEvents(connection, current);
    if (current !== generation) { return; }
    failures = 0; void flush();
  } catch {
    if (current !== generation) { return; }
    failures++; status.textContent = 'Editor unavailable · Reconnecting…'; status.dataset.state = 'error';
    // A restarted editor listens on a new port with a new key: the old address never comes back.
    if (failures >= 2) { void editorGone('The editor was closed or reloaded.'); return; }
  } finally { clearTimeout(timeout); }
  if (current === generation) { timer = setTimeout(() => void poll(connection, current), failures ? Math.min(10_000, 1000 * 2 ** Math.min(failures, 4)) : 750); }
}
function connect(connection: ChromeChatConnection, restoredCursor?: number): void {
  const cursor = restoredCursor ?? (footerSession && footerSession === connection.deliverySession ? footerCursor : 0);
  reset(); active = connection; footerSession = connection.deliverySession; footerCursor = cursor;
  pairing.hidden = true; app.hidden = true; disconnect.hidden = false;
  status.textContent = 'Connecting…'; delete status.dataset.state;
  void poll(connection, generation);
}
pairing.addEventListener('submit', event => {
  event.preventDefault(); if (pairingPending) { return; } pairingPending = true;
  void (async () => {
    try {
      const connection = readChromeChatConnection(JSON.parse(code.value.trim()));
      if (!connection || connection.extensionId !== chrome.runtime.id) { throw new Error('Paste a valid connection code for this Chrome extension.'); }
      const problem = editorCompatibility(connection); if (problem) { throw new Error(problem); }
      const current = ++generation;
      returnOutboxToDrafts(); await persistOutbox().catch(() => {});
      await chrome.storage.session.set({ connection, outbox });
      if (current !== generation) { return; }
      code.value = ''; connect(connection);
    } catch (error) { status.textContent = error instanceof Error ? error.message : 'Paste a valid connection code.'; status.dataset.state = 'error'; }
    finally { pairingPending = false; }
  })();
});
disconnect.addEventListener('click', () => {
  reset();
  const returned = returnOutboxToDrafts();
  status.textContent = returned ? 'Disconnected from editor. Messages not yet delivered were returned to their drafts.' : 'Disconnected from editor';
  // A deliberate disconnect forgets the grant: the next connection asks in the editor again.
  void saveResume(undefined);
  void persistOutbox().catch(() => {}).then(() => chrome.storage.session.remove(['connection']));
});
const initialGeneration = generation;
void chrome.storage.session.get(['connection', 'draftState', 'outbox', 'elementDrafts', 'annotationTabs', 'footerPosition', 'outboxSession']).then(saved => {
  if (initialGeneration !== generation) { return; }
  if (saved.draftState && typeof saved.draftState === 'object') {
    draftState = saved.draftState as ChatDraftState;
    emit({ type: 'hydrateDrafts', drafts: draftState.drafts ?? {} });
  }
  if (saved.elementDrafts && typeof saved.elementDrafts === 'object') {
    for (const [chatId, value] of Object.entries(saved.elementDrafts)) {
      if (!value || typeof value !== 'object' || chatId.length > 100) { continue; }
      const raw = value as { attachments?: unknown; next?: number };
      const attachments = readChromeElementAttachments(raw.attachments);
      if (attachments) { elementDrafts[chatId] = { attachments, next: Number.isSafeInteger(raw.next) && raw.next! > 0 ? raw.next! : 1 }; }
    }
  }
  annotations.restore(saved.annotationTabs);
  outbox = Array.isArray(saved.outbox) ? saved.outbox.map(readChromeChatCommand).filter((item): item is ChromeChatCommand => !!item) : [];
  outboxSession = typeof saved.outboxSession === 'string' ? saved.outboxSession : undefined;
  for (const command of outbox) { persisted.add(command.id); }
  const connection = readChromeChatConnection(saved.connection);
  const position = saved.footerPosition as { token?: string; deliverySession?: string; cursor?: number } | undefined;
  const cursor = (position?.deliverySession ? position.deliverySession === connection?.deliverySession : position?.token === connection?.token) && Number.isSafeInteger(position?.cursor) && position!.cursor! >= 0 ? position!.cursor! : 0;
  if (connection?.extensionId === chrome.runtime.id) { connect(connection, cursor); }
  else { void resumeOnce(); }
  watchForEditor();
}).catch(() => { status.textContent = 'Session storage unavailable. Reload the extension.'; });

/* ------------------------------------------------------------ resume after the editor restarts */

interface ResumeGrant { key: string; chatId?: string }
let resumeState: ResumeGrant | undefined;
let resuming = false;
const resumeLoaded = chrome.storage.local.get('resume').then(saved => {
  const raw = saved.resume as Partial<ResumeGrant> | undefined;
  resumeState = raw && typeof raw.key === 'string' && /^[a-f0-9]{64}$/.test(raw.key)
    ? { key: raw.key, ...(typeof raw.chatId === 'string' && raw.chatId.length <= 100 ? { chatId: raw.chatId } : {}) } : undefined;
}).catch(() => { resumeState = undefined; });

async function saveResume(grant: ResumeGrant | undefined): Promise<void> {
  resumeState = grant;
  await (grant ? chrome.storage.local.set({ resume: grant }) : chrome.storage.local.remove('resume')).catch(() => {});
}

/** The editor went away: back to the Connect screen, and keep looking for it while a grant is remembered. */
async function editorGone(reason: string): Promise<void> {
  reset();
  status.textContent = resumeState ? `${reason} Reconnecting automatically when it is back…` : `${reason} Click Connect.`;
  status.dataset.state = 'error';
  void resumeOnce();
}

/**
 * Finds a running editor and proves the earlier "Allow" with the resume key.
 * First only the window holding the pinned conversation may answer, then any.
 * A rejection from another profile never deletes the original owner's grant.
 */
async function resumeOnce(): Promise<boolean> {
  await resumeLoaded;
  if (resuming || active || quickAttempt || !resumeState) { return false; }
  resuming = true;
  const current = generation;
  try {
    const hosts = (await Promise.all(chromePairingPorts.map(async port => {
      const url = `http://127.0.0.1:${port}`;
      try {
        const response = await fetch(`${url}/discovery`, { headers: pairingHeaders(), signal: AbortSignal.timeout(1000) });
        if (!response.ok) { return undefined; }
        const host = await response.json() as { kind?: string; version?: number; protocolVersion?: number; editorVersion?: string; capabilities?: unknown };
        return host.kind === chromePairingKind && host.version === 1 && !editorCompatibility(host) ? url : undefined;
      } catch { return undefined; }
    }))).filter((url): url is string => !!url);
    for (const strict of [true, false]) {
      for (const url of hosts) {
        if (current !== generation || active || !resumeState) { return false; }
        const response = await fetch(`${url}/resume`, { method: 'POST', signal: AbortSignal.timeout(8000), headers: {
          ...pairingHeaders(), 'X-Resume-Key': resumeState.key, 'X-Resume-Strict': strict ? '1' : '0',
          ...(resumeState.chatId ? { 'X-Resume-Chat': resumeState.chatId } : {}) } }).catch(() => undefined);
        if (!response || current !== generation || active) { continue; }
        // A discovery host may belong to another profile. Its denial cannot revoke the owner's grant.
        if (response.status === 401 || response.status === 403) { continue; }
        if (!response.ok) { continue; }
        const result = await response.json().catch(() => ({})) as { connection?: unknown };
        const connection = readChromeChatConnection(result.connection);
        if (!connection || connection.extensionId !== chrome.runtime.id || editorCompatibility(connection)) { continue; }
        await chrome.storage.session.set({ connection });
        if (current !== generation || active) { return false; }
        connect(connection);
        return true;
      }
    }
    return false;
  } finally { resuming = false; }
}

/** While disconnected with a grant remembered, look for the editor every few seconds. */
function watchForEditor(): void {
  setInterval(() => { if (!active && !quickAttempt && resumeState) { void resumeOnce(); } }, 3000);
}
