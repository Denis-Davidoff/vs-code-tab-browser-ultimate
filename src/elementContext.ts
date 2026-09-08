/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Pulls an element's context out of the page over CDP.
 *
 * `extractElementData` is a port of `extractNodeData` from microsoft/vscode
 * (`vs/platform/browserView/electron-main/browserViewFrameInspector.ts`,
 * 1.134.0-1325-gaa7291eba7d), talking to our CDPClient instead of the
 * workbench's ICDPConnection. The CSS assembly it relies on is untouched
 * upstream code in cssHelpers.ts — that is what makes the result match the
 * built-in browser's own "Add Element to Chat" output. Rendering lives in
 * elementMarkdown.ts.
 */

import type { CDPClient } from './cdp';
import { collapseToShorthands, formatMatchedStyles, type IMatchedStyles } from './cssHelpers';
import type { ElementAncestor, ElementData } from './elementMarkdown';

export { formatAncestor, renderElementMarkdown } from './elementMarkdown';
export type { ElementAncestor, ElementData } from './elementMarkdown';

interface Node {
	nodeId: number;
	backendNodeId: number;
	parentId?: number;
	localName: string;
	attributes: string[];
	children?: Node[];
	pseudoElements?: Node[];
}

function attributeArrayToRecord(attributes: string[] | undefined): Record<string, string> {
	const record: Record<string, string> = {};
	for (let i = 0; i < (attributes?.length ?? 0); i += 2) {
		record[attributes![i]] = attributes![i + 1];
	}
	return record;
}

export async function extractElementData(
	client: CDPClient,
	sessionId: string,
	backendNodeId: number,
): Promise<ElementData> {

	// Ancestors are reconstructed from DOM.setChildNodes, which the browser
	// pushes while the document is being walked — so the listener has to be in
	// place *before* DOM.getDocument, not after.
	const discovered: Record<number, Node> = {};
	const subscription = client.on('DOM.setChildNodes', (params: { nodes: Node[] }) => {
		for (const node of params.nodes ?? []) {
			discovered[node.nodeId] = node;
			for (const child of node.children ?? []) {
				discovered[child.nodeId] = { ...child, parentId: node.nodeId };
			}
			for (const pseudo of node.pseudoElements ?? []) {
				discovered[pseudo.nodeId] = { ...pseudo, parentId: node.nodeId };
			}
		}
	});

	try {
		await client.send('DOM.getDocument', {}, sessionId);

		const { node } = await client.send('DOM.describeNode', { backendNodeId }, sessionId) as { node: Node };
		if (!node) {
			throw new Error('Failed to describe node.');
		}

		let nodeId = node.nodeId;
		if (!nodeId) {
			const { nodeIds } = await client.send('DOM.pushNodesByBackendIdsToFrontend',
				{ backendNodeIds: [node.backendNodeId] }, sessionId) as { nodeIds: number[] };
			if (!nodeIds?.length) {
				throw new Error('Failed to get node ID.');
			}
			nodeId = nodeIds[0];
		}

		const { model } = await client.send('DOM.getBoxModel', { nodeId }, sessionId) as {
			model: { content: number[]; margin: number[] };
		};
		if (!model) {
			throw new Error('Failed to get box model.');
		}

		// Union of the margin and content boxes, matching upstream.
		const { content, margin } = model;
		const left = Math.min(margin[0], content[0]);
		const top = Math.min(margin[1], content[1]);
		const width = Math.max(margin[2] - margin[0], content[2] - content[0]);
		const height = Math.max(margin[5] - margin[1], content[5] - content[1]);

		const matched = await client.send('CSS.getMatchedStylesForNode', { nodeId }, sessionId);
		if (!matched) {
			throw new Error('Failed to get matched css.');
		}
		const { rulesText, referencedVars, authorPropertyNames, userAgentPropertyNames } =
			formatMatchedStyles(matched as IMatchedStyles);

		const { outerHTML } = await client.send('DOM.getOuterHTML', { nodeId }, sessionId) as { outerHTML: string };
		if (!outerHTML) {
			throw new Error('Failed to get outerHTML.');
		}

		const ancestors: ElementAncestor[] = [];
		let current: Node | undefined = discovered[nodeId] ?? node;
		while (current) {
			const attributes = attributeArrayToRecord(current.attributes);
			ancestors.unshift({
				tagName: current.localName,
				id: attributes.id,
				classNames: attributes.class?.trim().split(/\s+/).filter(Boolean),
			});
			current = current.parentId ? discovered[current.parentId] : undefined;
		}

		let computedStyle = rulesText;
		try {
			const { computedStyle: computed } = await client.send(
				'CSS.getComputedStyleForNode', { nodeId }, sessionId) as
				{ computedStyle?: Array<{ name: string; value: string }> };

			if (computed) {
				const resolved = new Map<string, string>();
				const varLines: string[] = [];

				for (const prop of computed) {
					if (!prop.name || typeof prop.value !== 'string') {
						continue;
					}
					if (authorPropertyNames.has(prop.name)) {
						resolved.set(prop.name, prop.value);
					} else if (userAgentPropertyNames.has(prop.name)) {
						resolved.set(prop.name, `${prop.value} /*UA*/`);
					}
					if (referencedVars.has(prop.name)) {
						varLines.push(`${prop.name}: ${prop.value};`);
					}
				}

				if (resolved.size > 0) {
					computedStyle += '\n\n/* Resolved values */\n' + collapseToShorthands(resolved).join('\n');
				}
				if (varLines.length > 0) {
					computedStyle += '\n\n/* CSS variables */\n' + varLines.join('\n');
				}
			}
		} catch {
			// Computed styles are a bonus; the matched rules are already useful.
		}

		return { outerHTML, computedStyle, ancestors, dimensions: { top, left, width, height } };
	} finally {
		subscription.dispose();
	}
}
