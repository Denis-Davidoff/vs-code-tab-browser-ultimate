import type { ChatEntry } from './chatProtocol';
import type { ResultBlock } from './richProtocol';
import type { VisualizationReference } from './visualizationProtocol';

export type MessageContentKind = 'visualization' | 'image' | 'video' | 'audio' | 'table' | 'sources' | 'file' | 'json' | 'link';
export interface MessageContent {
	readonly kind: MessageContentKind;
	readonly title: string;
	readonly entry: number;
	readonly referenceAt?: number;
	readonly block?: number;
	readonly attachmentId?: string;
}

const basename = (value: string) => value.split(/[\\/]/).pop() || value;
function mediaKind(name: string, mime = ''): MessageContentKind {
	if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(name)) { return 'image'; }
	if (mime.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv)$/i.test(name)) { return 'video'; }
	if (mime.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/i.test(name)) { return 'audio'; }
	return 'file';
}

/** A small index of saved content, without copying media payloads into History. */
export function messageContent(entries: readonly ChatEntry[], rows: readonly number[]): MessageContent[] {
	const items = new Map<string, MessageContent>();
	const reference = (ref: VisualizationReference, entry: number, block?: number) => {
		items.set(`ref:${ref.kind ?? 'visualization'}:${ref.id}:${ref.revision ?? ref.at}`, {
			kind: ref.kind ?? 'visualization', title: ref.title, entry, referenceAt: ref.at, ...(block === undefined ? {} : { block }),
		});
	};
	const blocks = (values: readonly ResultBlock[], entry: number, title?: string) => {
		values.forEach((block, index) => {
			if ((block.type === 'image' || block.type === 'file') && block.ref) { reference(block.ref, entry, index); return; }
			if (block.type === 'text') { return; }
			let kind: MessageContentKind = block.type;
			let label = title;
			if (block.type === 'image') { label = block.path ? basename(block.path) : title; }
			else if (block.type === 'file') { label = block.name || (block.path ? basename(block.path) : title); kind = mediaKind(label ?? '', block.mimeType); }
			else if (block.type === 'json') { label = block.title || title; }
			else if (block.type === 'link') { label = block.title || block.url; }
			items.set(`block:${entry}:${index}`, { kind, title: label || (kind === 'json' ? 'JSON' : kind === 'image' ? 'Image' : 'File'), entry, block: index });
		});
	};
	for (const entry of rows) {
		const value = entries[entry];
		if (!value) { continue; }
		if (value.kind === 'assistant') { for (const ref of value.visualizations ?? []) { reference(ref, entry); } }
		else if (value.kind === 'result') { blocks(value.blocks, entry, value.title); }
		else if (value.kind === 'tool') { blocks(value.blocks ?? [], entry); }
		else if (value.kind === 'user') {
			value.attachments.forEach((label, index) => {
				const data = value.attachmentData?.[index], chip = data?.chip;
				const attachmentKind = chip?.kind ?? value.attachmentKinds?.[index];
				if (attachmentKind && !['file', 'screenshot', 'video', 'voice'].includes(attachmentKind)) { return; }
				const title = chip?.label || label.replace(/^@\d+\s*/, '');
				const kind = data?.image || chip?.thumbnail || attachmentKind === 'screenshot' ? 'image'
					: attachmentKind === 'video' ? 'video' : attachmentKind === 'voice' ? 'audio'
						: mediaKind(chip?.iconName || value.attachmentFiles?.[index] || title);
				items.set(`attachment:${entry}:${index}`, { kind, title, entry, ...(chip?.id ? { attachmentId: chip.id } : {}) });
			});
		}
	}
	return [...items.values()];
}
