/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { OpenRouterCatalogItem, OpenRouterModelConfig } from './chatProtocol';

/**
 * What the OpenRouter section of Chat Settings shows, as text. A leaf with no
 * `vscode` and no Node, read by the webview (esbuild) and by `npm test`.
 * Nothing here is validation: the host checks every number and id again
 * (`openrouterProtocol.ts`), what the view does is only format and parse what
 * the user typed so the form can say what is wrong before anything is sent.
 */

/** `200000` → `200K`, `1000000` → `1M`. */
export function formatContext(tokens: number | undefined): string {
	if (!tokens || tokens <= 0) { return ''; }
	if (tokens >= 1_000_000) { return `${Number((tokens / 1_000_000).toFixed(1))}M`; }
	if (tokens >= 1000) { return `${Math.round(tokens / 1000)}K`; }
	return String(tokens);
}

/** `$3 in · $15 out per 1M tokens`, `free`, or empty where the catalogue states no price. */
export function describePrice(entry: Pick<OpenRouterCatalogItem, 'promptPrice' | 'completionPrice'>): string {
	const { promptPrice: p, completionPrice: c } = entry;
	if (p === undefined && c === undefined) { return ''; }
	if ((p ?? 0) === 0 && (c ?? 0) === 0) { return 'free'; }
	const money = (n: number | undefined) => n === undefined ? '?' : `$${Number(n.toFixed(n < 0.1 ? 4 : 2))}`;
	return `${money(p)} in · ${money(c)} out per 1M tokens`;
}

/** The options a configured model sets, in one line; empty when it sets none. */
export function modelSummary(model: OpenRouterModelConfig): string {
	return [
		model.endpoint ? `local ${model.endpoint.replace(/^https?:\/\//, '')}` : undefined,
		model.maxTokens !== undefined ? `max ${model.maxTokens} tokens` : undefined,
		model.temperature !== undefined ? `temperature ${model.temperature}` : undefined,
		model.reasoning ? `reasoning ${model.reasoning}` : undefined,
		model.tools === false ? 'no tools' : undefined,
		model.images ? 'images' : undefined,
	].filter(Boolean).join(' · ');
}

/** A catalogue entry as a configured model: what the service declares, nothing guessed. */
export function modelFromCatalogItem(item: OpenRouterCatalogItem, endpoint?: string): OpenRouterModelConfig {
	if (endpoint) {
		// A local server's list names models and nothing else: tools are assumed (the user can switch them off), images are not.
		return { id: item.id, tools: true, images: false, endpoint };
	}
	return {
		id: item.id,
		...(item.name && item.name !== item.id ? { name: item.name } : {}),
		tools: item.tools, images: item.images,
		...(item.reasoning ? { reasoning: 'medium' as const } : {}),
	};
}

/** A number field's text: empty means "not set"; otherwise plain decimal digits (no hex, no exponent). */
export function parseOptionalNumber(text: string): { readonly value: number | undefined } | { readonly error: string } {
	const t = text.trim();
	if (!t) { return { value: undefined }; }
	if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(t)) { return { error: 'must be a number' }; }
	const n = Number(t);
	return Number.isFinite(n) ? { value: n } : { error: 'must be a number' };
}
