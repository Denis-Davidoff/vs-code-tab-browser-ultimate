import type { ChromeElementAttachment } from '../src/chat/chromeChatProtocol';

export interface ElementDraft { next: number; attachments: ChromeElementAttachment[] }

export function appendPickedElement(draft: ElementDraft, element: Omit<ChromeElementAttachment, 'reference'>): void {
  if (draft.attachments.length >= 8 || draft.attachments.reduce((size, item) => size + item.text.length, element.text.length) > 200_000) {
    throw new Error('Remove an attachment before adding another (maximum 8 attachments / 200,000 characters).');
  }
  draft.next = Math.max(draft.next, ...draft.attachments.map(item => Number(item.reference.slice(1)) + 1));
  draft.attachments.push({ ...element, reference: `@${draft.next++}` });
}

/** A refused send is restored alongside newer draft picks without reusing their references. */
export function restorePickedElements(draft: ElementDraft, attachments: readonly ChromeElementAttachment[], text: string): string {
  const renamed = new Map<string, string>();
  draft.next = Math.max(draft.next, ...draft.attachments.map(item => Number(item.reference.slice(1)) + 1));
  for (const attachment of attachments) {
    const existing = draft.attachments.find(item => item.id === attachment.id);
    const reference = existing?.reference ?? `@${draft.next++}`;
    if (!existing) { draft.attachments.push({ ...attachment, reference }); }
    renamed.set(attachment.reference, reference);
  }
  return text.replace(/@\d+\b/g, reference => renamed.get(reference) ?? reference);
}
