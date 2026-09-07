/*---------------------------------------------------------------------------------------------
 *  Everything the copy menu reports about a picked element beyond its path: the markup, the
 *  box it occupies, and the css that ends up on it.
 *
 *  The css is read back from the CSSOM of the page itself, so it only covers stylesheets the
 *  document may read: same-origin ones and inline `<style>` elements. Cross-origin sheets are
 *  counted, not guessed at.
 *--------------------------------------------------------------------------------------------*/

import { CssRule, ElementRect, ResolvedDeclaration, StyleSnapshot } from '../shared/protocol';

const limits = {
	outerHtml: 4000,
	matchedRules: 80,
	inheritedRules: 60,
	ancestors: 16,
	declarations: 2000,
	variables: 40,
};

/** Properties an element hands down to its children; the rest is noise on an ancestor. */
const inheritedProperties = new Set([
	'azimuth', 'border-collapse', 'border-spacing', 'caption-side', 'caret-color', 'color',
	'cursor', 'direction', 'empty-cells', 'font', 'font-family', 'font-feature-settings',
	'font-kerning', 'font-optical-sizing', 'font-size', 'font-size-adjust', 'font-stretch',
	'font-style', 'font-synthesis', 'font-variant', 'font-variant-caps',
	'font-variant-east-asian', 'font-variant-ligatures', 'font-variant-numeric',
	'font-variation-settings', 'font-weight', 'hyphens', 'letter-spacing', 'line-break',
	'line-height', 'list-style', 'list-style-image', 'list-style-position', 'list-style-type',
	'orphans', 'overflow-wrap', 'pointer-events', 'quotes', 'tab-size', 'text-align',
	'text-align-last', 'text-indent', 'text-justify', 'text-rendering', 'text-shadow',
	'text-transform', 'text-underline-position', 'text-wrap', 'visibility', 'white-space',
	'widows', 'word-break', 'word-spacing', 'writing-mode', '-webkit-font-smoothing',
	'-webkit-text-size-adjust', 'accent-color', 'color-scheme', 'user-select',
]);

/**
 * Reported under "Resolved values" on top of whatever the page's own rules declare, so the
 * layout of the element can be read without the stylesheets.
 */
const alwaysResolved = [
	'align-items', 'align-self', 'appearance', 'background-color', 'background-image',
	'border-radius', 'bottom', 'box-shadow', 'box-sizing', 'color', 'cursor', 'direction',
	'display', 'flex-basis', 'flex-direction', 'flex-grow', 'flex-shrink', 'flex-wrap', 'float',
	'font-family', 'font-size', 'font-style', 'font-weight', 'gap', 'grid-auto-flow',
	'grid-template-columns', 'grid-template-rows', 'height', 'justify-content', 'left',
	'letter-spacing', 'line-height', 'list-style', 'margin', 'max-height', 'max-width',
	'min-height', 'min-width', 'object-fit', 'opacity', 'order', 'outline', 'overflow-x',
	'overflow-y', 'padding', 'pointer-events', 'position', 'right', 'tab-size', 'text-align',
	'text-decoration', 'text-indent', 'text-overflow', 'text-transform', 'top', 'transform',
	'transition', 'user-select', 'vertical-align', 'visibility', 'white-space', 'width',
	'word-break', 'writing-mode', 'z-index',
];

/**
 * Longhands of the shorthands a page is likely to use. Only needed for the "does the page set
 * this?" test: `CSSStyleDeclaration` does not expand shorthands in every engine.
 */
const shorthands: Readonly<Record<string, readonly string[]>> = {
	'background': ['background-attachment', 'background-clip', 'background-color',
		'background-image', 'background-origin', 'background-position', 'background-repeat',
		'background-size'],
	'border': ['border-color', 'border-style', 'border-width'],
	'border-block': ['border-block-color', 'border-block-style', 'border-block-width'],
	'border-bottom': ['border-bottom-color', 'border-bottom-style', 'border-bottom-width'],
	'border-color': ['border-bottom-color', 'border-left-color', 'border-right-color', 'border-top-color'],
	'border-inline': ['border-inline-color', 'border-inline-style', 'border-inline-width'],
	'border-left': ['border-left-color', 'border-left-style', 'border-left-width'],
	'border-radius': ['border-bottom-left-radius', 'border-bottom-right-radius',
		'border-top-left-radius', 'border-top-right-radius'],
	'border-right': ['border-right-color', 'border-right-style', 'border-right-width'],
	'border-style': ['border-bottom-style', 'border-left-style', 'border-right-style', 'border-top-style'],
	'border-top': ['border-top-color', 'border-top-style', 'border-top-width'],
	'border-width': ['border-bottom-width', 'border-left-width', 'border-right-width', 'border-top-width'],
	'flex': ['flex-basis', 'flex-grow', 'flex-shrink'],
	'flex-flow': ['flex-direction', 'flex-wrap'],
	'font': ['font-family', 'font-size', 'font-stretch', 'font-style', 'font-variant',
		'font-weight', 'line-height'],
	'gap': ['column-gap', 'row-gap'],
	'grid-area': ['grid-column-end', 'grid-column-start', 'grid-row-end', 'grid-row-start'],
	'inset': ['bottom', 'left', 'right', 'top'],
	'list-style': ['list-style-image', 'list-style-position', 'list-style-type'],
	'margin': ['margin-bottom', 'margin-left', 'margin-right', 'margin-top'],
	'outline': ['outline-color', 'outline-style', 'outline-width'],
	'overflow': ['overflow-x', 'overflow-y'],
	'padding': ['padding-bottom', 'padding-left', 'padding-right', 'padding-top'],
	'place-items': ['align-items', 'justify-items'],
	'text-decoration': ['text-decoration-color', 'text-decoration-line', 'text-decoration-style'],
	'transition': ['transition-delay', 'transition-duration', 'transition-property',
		'transition-timing-function'],
};

/** Only says something once the element takes part in a flex or grid layout. */
const flexAndGridProperties = new Set([
	'align-items', 'align-self', 'flex-basis', 'flex-direction', 'flex-grow', 'flex-shrink',
	'flex-wrap', 'gap', 'grid-auto-flow', 'grid-template-columns', 'grid-template-rows',
	'justify-content', 'order',
]);

/** Only says something once the element is taken out of the normal flow. */
const positionedProperties = new Set(['bottom', 'left', 'right', 'top', 'z-index']);

/** Pseudo classes and elements that describe a state the element is not necessarily in. */
const statePseudo = new RegExp(
	'::?(?:hover|focus|focus-within|focus-visible|active|visited|link|any-link|target'
	+ '|target-within|placeholder-shown|autofill|checked|indeterminate|default|disabled|enabled'
	+ '|read-only|read-write|required|optional|valid|invalid|in-range|out-of-range|user-valid'
	+ '|user-invalid|open|popover-open|modal|fullscreen|before|after|first-line|first-letter'
	+ '|placeholder|selection|backdrop|marker|file-selector-button|details-content'
	+ '|-webkit-[\\w-]+|-moz-[\\w-]+)\\b(?!\\()',
	'g');

export function describeNode(element: Element): string {
	const tag = element.tagName.toLowerCase();
	const id = element.id ? `#${element.id}` : '';
	const classes = (Array.prototype.slice.call(element.classList) as string[])
		.map(name => `.${name}`).join('');
	return `${tag}${id}${classes}`;
}

/** The chain of ancestors below `<body>`, the element itself last. */
export function htmlPath(element: Element): string[] {
	const path: string[] = [];
	for (let node: Element | null = element; node; node = node.parentElement) {
		if (node === document.body || node === document.documentElement) {
			break;
		}
		path.unshift(describeNode(node));
	}
	return path.length ? path : [describeNode(element)];
}

export function elementRect(element: Element): ElementRect {
	const rect = element.getBoundingClientRect();
	return {
		top: Math.round(rect.top),
		left: Math.round(rect.left),
		width: Math.round(rect.width),
		height: Math.round(rect.height),
	};
}

export function outerHtml(element: Element): string {
	const html = element.outerHTML ?? '';
	if (html.length <= limits.outerHtml) {
		return html;
	}

	const tag = element.tagName.toLowerCase();
	const openTagEnd = html.indexOf('>');
	const openTag = openTagEnd === -1 ? `<${tag}>` : html.slice(0, openTagEnd + 1);
	const children = element.children.length;
	return `${openTag}\n  <!-- ${children} child element${children === 1 ? '' : 's'} omitted -->\n</${tag}>`;
}

export function collectStyles(element: Element): StyleSnapshot | undefined {
	try {
		return buildSnapshot(element);
	} catch {
		// A page can break any of this; the rest of the report is still worth having.
		return undefined;
	}
}

function buildSnapshot(element: Element): StyleSnapshot {
	let unreadableStyleSheets = 0;
	let counted = false;
	const sheets = Array.prototype.slice.call(document.styleSheets) as CSSStyleSheet[];

	const visit = (
		visitor: (rule: CSSStyleRule, conditions: readonly string[], selector: string) => void,
	) => {
		for (const sheet of sheets) {
			let rules: CSSRuleList | undefined;
			try {
				rules = sheet.cssRules;
			} catch {
				if (!counted) {
					unreadableStyleSheets++;
				}
				continue;
			}
			walkRules(rules, [], visitor);
		}
		counted = true;
	};

	const matched: CssRule[] = [];
	// Property names the page declares on the element, shorthands expanded.
	const declared = new Set<string>();
	// The same names as written, in cascade order: they lead the resolved values.
	const declaredOrder: string[] = [];

	const inlineStyle = (element as HTMLElement).style;
	if (inlineStyle?.length) {
		matched.push({ selector: 'element.style', declarations: declarationText(inlineStyle) });
		collectDeclared(inlineStyle, declared, declaredOrder);
	}

	visit((rule, conditions, selector) => {
		if (matched.length >= limits.matchedRules || !matchesElement(element, selector)) {
			return;
		}
		const declarations = declarationText(rule.style);
		if (!declarations) {
			return;
		}
		matched.push({
			selector,
			declarations,
			conditions: conditions.length ? conditions.slice() : undefined,
		});
		collectDeclared(rule.style, declared, declaredOrder);
	});

	const inherited: CssRule[] = [];
	const ancestors: Element[] = [];
	for (let node = element.parentElement; node && ancestors.length < limits.ancestors; node = node.parentElement) {
		ancestors.push(node);
	}

	for (const ancestor of ancestors) {
		const from = describeNode(ancestor);
		const ancestorInline = (ancestor as HTMLElement).style;
		const inlineInherited = ancestorInline?.length
			? declarationsOf(ancestorInline, property => inheritedProperties.has(property))
			: '';
		if (inlineInherited) {
			inherited.push({ selector: 'element.style', declarations: inlineInherited, from });
		}
	}

	visit((rule, conditions, selector) => {
		if (inherited.length >= limits.inheritedRules) {
			return;
		}
		// Cheaper than asking every ancestor whether it matches a rule that says nothing
		// a child could inherit.
		const declarations = declarationsOf(rule.style, property => inheritedProperties.has(property));
		if (!declarations) {
			return;
		}
		for (const ancestor of ancestors) {
			if (matchesElement(ancestor, selector)) {
				inherited.push({
					selector,
					declarations,
					conditions: conditions.length ? conditions.slice() : undefined,
					from: describeNode(ancestor),
				});
				return;
			}
		}
	});

	const computed = getComputedStyle(element);
	return {
		matched,
		inherited,
		resolved: resolveValues(element, computed, declared, declaredOrder),
		variables: resolveVariables(computed, [...matched, ...inherited]),
		unreadableStyleSheets,
	};
}

// -- rule walking --------------------------------------------------------------------------------

function walkRules(
	rules: CSSRuleList,
	conditions: readonly string[],
	visit: (rule: CSSStyleRule, conditions: readonly string[], selector: string) => void,
	/** Selector the rules are nested in, already resolved; the `&` of this level. */
	parentSelector?: string,
): void {
	for (const rule of Array.prototype.slice.call(rules) as CSSRule[]) {
		const styleRule = rule as CSSStyleRule;
		const group = rule as CSSRule & { cssRules?: CSSRuleList };

		if (typeof styleRule.selectorText === 'string' && styleRule.style) {
			const selector = resolveNestedSelector(styleRule.selectorText, parentSelector);
			visit(styleRule, conditions, selector);
			// Css nesting: a style rule can hold rules of its own, and they are the ones that
			// actually apply to the children — `.card { & > button { … } }`.
			if (group.cssRules?.length) {
				walkRules(group.cssRules, conditions, visit, selector);
			}
			continue;
		}

		if (!group.cssRules) {
			continue;
		}
		const condition = groupCondition(rule);
		if (condition === undefined) {
			continue;
		}
		walkRules(
			group.cssRules,
			condition ? [...conditions, condition] : conditions,
			visit,
			parentSelector);
	}
}

/**
 * What a nested selector means on its own. `&` stands for the whole rule it is nested in, which
 * may be a list, hence `:is()`; a nested selector that never says `&` is a descendant of it.
 */
function resolveNestedSelector(selector: string, parentSelector?: string): string {
	if (!parentSelector) {
		return selector;
	}

	const parent = `:is(${parentSelector})`;
	return splitSelectorList(selector)
		.map(part => (part.indexOf('&') === -1 ? `${parent} ${part}` : part.split('&').join(parent)))
		.join(', ');
}

/** The `@rule` a group contributes to the path, or `undefined` when it does not apply here. */
function groupCondition(rule: CSSRule): string | undefined {
	const media = (rule as CSSMediaRule).media;
	if (media) {
		const text = media.mediaText;
		if (!text || text === 'all') {
			return '';
		}
		try {
			return matchMedia(text).matches ? `@media ${text}` : undefined;
		} catch {
			return `@media ${text}`;
		}
	}

	const conditionText = (rule as CSSSupportsRule).conditionText;
	if (typeof conditionText === 'string') {
		// `@supports` can be evaluated; `@container` cannot, so it is kept either way.
		const isSupports = /^@supports/i.test(rule.cssText ?? '');
		if (isSupports) {
			try {
				return CSS.supports(conditionText) ? `@supports ${conditionText}` : undefined;
			} catch {
				return `@supports ${conditionText}`;
			}
		}
		return `@container ${conditionText}`;
	}

	const name = (rule as CSSLayerBlockRule).name;
	if (typeof name === 'string') {
		return name ? `@layer ${name}` : '';
	}

	// `@keyframes`, `@font-face` and friends hold nothing that can match an element.
	return undefined;
}

function matchesElement(element: Element, selectorText: string): boolean {
	for (const part of splitSelectorList(selectorText)) {
		const testable = part.replace(statePseudo, '').trim();
		// Nesting is resolved before this; a `&` that is still here stands for no parent.
		if (!testable || testable.indexOf('&') !== -1) {
			continue;
		}
		try {
			if (element.matches(testable)) {
				return true;
			}
		} catch {
			// A selector this engine does not understand.
		}
	}
	return false;
}

/** Splits on the commas that separate selectors, ignoring the ones inside `(…)`, `[…]` or a string. */
function splitSelectorList(selectorText: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote: string | undefined;
	let start = 0;

	for (let i = 0; i < selectorText.length; i++) {
		const char = selectorText[i];
		if (quote) {
			if (char === '\\') {
				i++;
			} else if (char === quote) {
				quote = undefined;
			}
			continue;
		}
		switch (char) {
			case '"':
			case '\'':
				quote = char;
				break;
			case '(':
			case '[':
				depth++;
				break;
			case ')':
			case ']':
				depth--;
				break;
			case ',':
				if (depth === 0) {
					parts.push(selectorText.slice(start, i));
					start = i + 1;
				}
				break;
		}
	}

	parts.push(selectorText.slice(start));
	return parts;
}

// -- declarations --------------------------------------------------------------------------------

/**
 * The rule as the page wrote it: `cssText` keeps shorthands together, where enumerating the
 * declaration one by one hands out the longhands the engine expanded them into.
 */
function declarationText(style: CSSStyleDeclaration): string {
	const text = (style.cssText ?? '').replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();
	return text.length > limits.declarations ? `${text.slice(0, limits.declarations)}…` : text;
}

/** Property names of a `cssText`, in the order they were written. */
function declaredNames(cssText: string): string[] {
	const names: string[] = [];
	let depth = 0;
	let quote: string | undefined;
	let start = 0;

	const take = (end: number) => {
		const colon = cssText.indexOf(':', start);
		if (colon !== -1 && colon < end) {
			const name = cssText.slice(start, colon).trim();
			if (name) {
				names.push(name);
			}
		}
		start = end + 1;
	};

	for (let i = 0; i < cssText.length; i++) {
		const char = cssText[i];
		if (quote) {
			if (char === '\\') {
				i++;
			} else if (char === quote) {
				quote = undefined;
			}
			continue;
		}
		switch (char) {
			case '"':
			case '\'':
				quote = char;
				break;
			case '(':
				depth++;
				break;
			case ')':
				depth--;
				break;
			case ';':
				if (depth === 0) {
					take(i);
				}
				break;
		}
	}
	take(cssText.length);

	return names;
}

function declarationsOf(
	style: CSSStyleDeclaration,
	filter?: (property: string) => boolean,
): string {
	const parts: string[] = [];
	for (let i = 0; i < style.length; i++) {
		const property = style.item(i);
		if (filter && !filter(property)) {
			continue;
		}
		const value = style.getPropertyValue(property);
		if (!value) {
			continue;
		}
		const priority = style.getPropertyPriority(property);
		parts.push(`${property}: ${value}${priority ? ` !${priority}` : ''}`);
	}

	const text = parts.join('; ');
	return text.length > limits.declarations ? `${text.slice(0, limits.declarations)}…` : text;
}

function collectDeclared(style: CSSStyleDeclaration, declared: Set<string>, order: string[]): void {
	const add = (property: string) => {
		declared.add(property);
		for (const longhand of shorthands[property] ?? []) {
			declared.add(longhand);
			// A shorthand of shorthands, e.g. `border` -> `border-color` -> `border-top-color`.
			for (const nested of shorthands[longhand] ?? []) {
				declared.add(nested);
			}
		}
	};

	// The longhands the engine expanded the rule into...
	for (let i = 0; i < style.length; i++) {
		add(style.item(i));
	}

	// ...and the names the page actually wrote, which are what the report leads with.
	for (const property of declaredNames(style.cssText ?? '')) {
		if (order.indexOf(property) === -1) {
			order.push(property);
		}
		add(property);
	}
}

function resolveValues(
	element: Element,
	computed: CSSStyleDeclaration,
	declared: Set<string>,
	declaredOrder: readonly string[],
): ResolvedDeclaration[] {
	const resolved: ResolvedDeclaration[] = [];
	const seen = new Set<string>();

	const push = (property: string, fromUserAgent?: boolean) => {
		if (seen.has(property) || property.startsWith('--')) {
			return;
		}
		const value = computed.getPropertyValue(property);
		if (!value) {
			return;
		}
		seen.add(property);
		resolved.push(fromUserAgent ? { property, value, fromUserAgent } : { property, value });
	};

	for (const property of declaredOrder) {
		push(property);
	}

	const wanted = alwaysResolved.filter(property => !seen.has(property) && isRelevant(property, element, computed));
	const untouched = untouchedValues(element, wanted);
	for (const property of wanted) {
		const value = computed.getPropertyValue(property);
		const isDefault = !declared.has(property) && !!value && untouched.get(property) === value;
		push(property, isDefault || undefined);
	}

	return resolved;
}

/** Keeps properties out of the report that only describe a layout the element is not in. */
function isRelevant(property: string, element: Element, computed: CSSStyleDeclaration): boolean {
	if (flexAndGridProperties.has(property)) {
		const parent = element.parentElement;
		const displays = computed.getPropertyValue('display')
			+ (parent ? ` ${getComputedStyle(parent).getPropertyValue('display')}` : '');
		return /flex|grid/.test(displays);
	}
	if (positionedProperties.has(property)) {
		return computed.getPropertyValue('position') !== 'static';
	}
	return true;
}

/**
 * What a bare element of the same tag resolves those properties to. A value the page never
 * declares and that survives on such an element comes from the browser, not from the page.
 */
function untouchedValues(element: Element, properties: readonly string[]): Map<string, string> {
	const values = new Map<string, string>();
	if (!properties.length || !document.body) {
		return values;
	}

	const host = document.createElement('div');
	host.setAttribute('data-tab-browser', 'probe');
	host.style.cssText = 'all: initial; position: absolute; left: -99999px; top: 0;'
		+ 'width: 0; height: 0; overflow: hidden; contain: strict;';

	let probe: Element | undefined;
	try {
		probe = document.createElement(element.tagName.toLowerCase());
		host.appendChild(probe);
		document.body.appendChild(host);

		const computed = getComputedStyle(probe);
		for (const property of properties) {
			values.set(property, computed.getPropertyValue(property));
		}
	} catch {
		// Some tag names cannot be recreated; the report simply loses the markers.
	} finally {
		host.remove();
	}

	return values;
}

function resolveVariables(
	computed: CSSStyleDeclaration,
	rules: readonly CssRule[],
): ResolvedDeclaration[] {
	const names = new Set<string>();
	const pattern = /var\(\s*(--[\w-]+)/g;

	for (const rule of rules) {
		for (const declaration of rule.declarations.split(';')) {
			const property = declaration.split(':')[0]?.trim();
			if (property?.startsWith('--')) {
				names.add(property);
			}
		}
		pattern.lastIndex = 0;
		for (let match = pattern.exec(rule.declarations); match; match = pattern.exec(rule.declarations)) {
			names.add(match[1]);
		}
	}

	const variables: ResolvedDeclaration[] = [];
	for (const name of names) {
		if (variables.length >= limits.variables) {
			break;
		}
		const value = computed.getPropertyValue(name).trim();
		if (value) {
			variables.push({ property: name, value });
		}
	}
	return variables;
}
