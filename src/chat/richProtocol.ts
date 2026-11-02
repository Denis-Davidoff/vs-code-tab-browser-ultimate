import type { VisualizationReference } from './visualizationProtocol';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface ChatRelation { readonly messageId?: string; readonly toolId?: string }
export type RichAction =
	| { readonly label: string; readonly kind: 'link'; readonly url: string }
	| { readonly label: string; readonly kind: 'copy'; readonly text: string }
	| { readonly label: string; readonly kind: 'reveal'; readonly target: ChatRelation };
export interface NoticeData {
	/** Provenance of a linked-chat note. This is data, never a user instruction. */
	readonly linkedNote?: { readonly sourceChatId: string; readonly author: string; readonly text: string };
	readonly id?: string;
	readonly text: string;
	readonly level?: 'info' | 'warning' | 'error';
	readonly reason?: string;
	readonly at?: number;
	readonly related?: ChatRelation;
	readonly actions?: readonly RichAction[];
}
export interface ProgressData {
	readonly id: string;
	readonly title: string;
	readonly stage?: string;
	/** Null or absent is indeterminate; values are percentages from 0 to 100. */
	readonly percent?: number | null;
	readonly status?: 'running' | 'done' | 'failed' | 'cancelled';
	readonly related?: ChatRelation;
	/** Only cancellation supported by the backend: the current turn or a named agent. */
	readonly cancel?: { readonly agentId?: string };
}
export interface ProgressEntry extends ProgressData {
	readonly kind: 'progress';
	readonly status: 'running' | 'done' | 'failed' | 'cancelled';
	readonly startedAt: number;
	readonly updatedAt: number;
	readonly cancelRequestedAt?: number;
	readonly endedAt?: number;
}
export interface PlanStep { readonly id: string; readonly text: string; readonly status: 'pending' | 'inProgress' | 'done' | 'cancelled' }
export interface PlanData { readonly id: string; readonly title: string; readonly steps: readonly PlanStep[]; readonly related?: ChatRelation }
export interface PlanEntry extends PlanData { readonly kind: 'plan'; readonly updatedAt: number }
export type ResultBlock =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'json'; readonly value: JsonValue; readonly title?: string }
	| { readonly type: 'link'; readonly url: string; readonly title?: string }
	| { readonly type: 'image'; readonly mimeType?: string; readonly base64?: string; readonly path?: string; readonly ref?: VisualizationReference }
	| { readonly type: 'file'; readonly name: string; readonly mimeType?: string; readonly base64?: string; readonly path?: string; readonly url?: string; readonly ref?: VisualizationReference };
export interface ResultData { readonly id: string; title: string; blocks: readonly ResultBlock[] }
export interface ResultEntry extends ResultData { readonly kind: 'result'; readonly at: number }
export type CitationTarget =
	| { readonly type: 'url'; readonly url: string }
	| { readonly type: 'file'; readonly path: string; readonly line?: number }
	| { readonly type: 'message'; readonly messageId?: string; readonly toolId?: string };
export interface Citation { readonly id: string; readonly label: string; readonly start: number; readonly end: number; readonly target: CitationTarget }
