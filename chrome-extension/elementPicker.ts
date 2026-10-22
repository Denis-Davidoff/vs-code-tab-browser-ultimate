import { redactSecretValues } from '../src/logins/secretGuards';
import type { ElementData } from '../src/elements/elementMarkdown';

export interface ChromeElementPick extends ElementData { url: string; selector: string }
export interface ElementPickerWorld extends Window {
  __aiBrowserChromeElementPicker?: { start(id: string): Promise<ChromeElementPick | undefined>; cancel(id?: string): void };
}

/** Runs in Chrome's isolated world. Redact before truncating, storing or returning HTML. */
export function captureElement(element: Element): ChromeElementPick {
  const ancestors: ElementData['ancestors'] = [];
  const path: string[] = [];
  let node: Element | null = element;
  for (let depth = 0; node && depth < 12; depth++) {
    ancestors.unshift({ tagName: node.localName, id: node.id.slice(0, 100), classNames: [...node.classList].slice(0, 4).map(value => value.slice(0, 80)) });
    let part = node.localName;
    if (node.id) { part += `#${CSS.escape(node.id)}`; }
    else if (node.parentElement) {
      const siblings = [...node.parentElement.children].filter(sibling => sibling.localName === node!.localName);
      if (siblings.length > 1) { part += `:nth-of-type(${siblings.indexOf(node) + 1})`; }
    }
    path.unshift(part);
    if (node.parentElement) { node = node.parentElement; }
    else {
      const root = node.getRootNode();
      node = root instanceof ShadowRoot ? root.host : null;
      if (node) { path.unshift('>>>'); }
    }
  }
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const properties = ['display', 'position', 'box-sizing', 'width', 'height', 'margin', 'padding', 'gap', 'align-items', 'justify-content',
    'grid-template-columns', 'flex', 'color', 'background-color', 'border', 'border-radius', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align', 'overflow', 'z-index'];
  const url = new URL(location.href); url.username = ''; url.password = '';
  return {
    outerHTML: redactSecretValues(element.outerHTML).slice(0, 36_000),
    computedStyle: properties.map(property => `${property}: ${style.getPropertyValue(property)};`).join('\n').slice(0, 12_000),
    ancestors, dimensions: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    url: url.href.slice(0, 2000), selector: path.join(' > ').replace(/ > >>> > /g, ' >>> ').slice(0, 2000),
  };
}

let cancelCurrent: ((id?: string) => void) | undefined;

export function startElementPick(id: string): Promise<ChromeElementPick | undefined> {
  cancelCurrent?.();
  return new Promise((resolve, reject) => {
    const overlay = document.createElement('div');
    for (const [name, value] of Object.entries({ all: 'initial', position: 'fixed', inset: '0', 'z-index': '2147483647', cursor: 'crosshair', 'pointer-events': 'auto' })) {
      overlay.style.setProperty(name, value, 'important');
    }
    const shadow = overlay.attachShadow({ mode: 'closed' });
    const highlight = document.createElement('div');
    highlight.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #61a9ff;background:#61a9ff25;box-sizing:border-box;display:none;';
    const label = document.createElement('div');
    label.textContent = 'Click an element to attach · Esc to cancel';
    label.style.cssText = 'position:fixed;pointer-events:none;top:10px;left:10px;max-width:calc(100vw - 40px);padding:8px 12px;color:white;background:#202835;border:1px solid #61a9ff;border-radius:6px;font:12px/1.5 system-ui;overflow-wrap:anywhere;';
    shadow.append(highlight, label); document.documentElement.append(overlay);
    let finished = false;
    const cleanup = () => {
      clearTimeout(timeout); overlay.remove();
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('pagehide', cancel);
      if (cancelCurrent === cancel) { cancelCurrent = undefined; }
    };
    const cancel = (requestId?: string | Event) => {
      if (typeof requestId === 'string' && requestId !== id || finished) { return; }
      finished = true; cleanup(); resolve(undefined);
    };
    const targetAt = (event: MouseEvent): Element | null => {
      overlay.style.setProperty('pointer-events', 'none', 'important');
      let target = document.elementFromPoint(event.clientX, event.clientY);
      while (target?.shadowRoot) {
        const inner = target.shadowRoot.elementFromPoint(event.clientX, event.clientY);
        if (!inner || inner === target) { break; }
        target = inner;
      }
      overlay.style.setProperty('pointer-events', 'auto', 'important');
      return target;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel(); }
    };
    const timeout = setTimeout(cancel, 120_000);
    cancelCurrent = cancel;
    window.addEventListener('keydown', key, true);
    window.addEventListener('pagehide', cancel, { once: true });
    overlay.addEventListener('mousemove', event => {
      const target = targetAt(event);
      if (!target || target === overlay) { return; }
      const rect = target.getBoundingClientRect();
      Object.assign(highlight.style, { display: 'block', top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      label.textContent = `${target.localName}${target.id ? `#${target.id}` : ''} · Click to attach · Esc to cancel`;
    });
    overlay.addEventListener('mousedown', event => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
    overlay.addEventListener('click', event => {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.isTrusted || event.button !== 0 || finished) { return; }
      const target = targetAt(event);
      if (!target || target === overlay) { return; }
      finished = true; cleanup();
      try { resolve(captureElement(target)); } catch (error) { reject(error); }
    }, true);
  });
}

if (typeof window !== 'undefined') {
  const world = window as ElementPickerWorld;
  world.__aiBrowserChromeElementPicker ??= { start: startElementPick, cancel: id => cancelCurrent?.(id) };
}
