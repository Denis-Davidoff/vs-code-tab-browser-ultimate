/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The page half of Translate Page: an expression that evaluates to the page's
 * translator, installing it on first use. Each tool call is
 * `<translatorSource>.segments(…)` and the like, in one `Runtime.evaluate`.
 *
 * `String.raw`, so a regular expression reads as it would in a `.js` file
 * (breaks-silently #230). Two rules follow from it being a template literal:
 * **no backtick anywhere inside, comments included**, and no `${`.
 *
 * What it does, and why each part is that way:
 *
 * - **A segment is a distinct source string, not a node.** The same "Cancel" in
 *   twenty rows is one segment, translated once and written into all twenty —
 *   and into a twenty-first that a list renders later, through the dictionary.
 * - **Only `Text.data` and attribute values are written, never the DOM's
 *   shape.** Google Translate wraps text in <font> elements, and React apps
 *   then fail with "Failed to execute 'removeChild'", because React holds
 *   references to its own text nodes. Changing `data` leaves every node where
 *   React put it.
 * - **React puts the original back when a component re-renders with new text**,
 *   and a list grows rows. A MutationObserver re-applies the dictionary to both,
 *   and tells our own writes from the page's by remembering what it wrote.
 * - **But it gives up on a node the page keeps reverting.** A page with its own
 *   observer that undoes outside edits made the two observers rewrite each
 *   other for ever in microtasks, freezing the tab. A node rewritten more than
 *   three times in a second is left as the page wants it; a change that equals
 *   our text once whitespace is collapsed (a page turning spaces into nbsp) is
 *   ours, not a revert.
 * - **Every write re-checks that the node may be written**, at the moment of
 *   writing; and **every eligibility control is observed** — contenteditable,
 *   translate, a notranslate class, an option's value — so a node that becomes
 *   writable is translated and offered, and one that stops being writable is
 *   put back on the spot rather than left for an editor to save.
 * - **Nothing a form or an editor submits is touched.** Input values are never
 *   read; text anywhere inside an option with no value attribute is skipped,
 *   since that text *is* the option's value (breaks-silently #291); and nothing
 *   inside an editing host is, text or attribute — including the
 *   contenteditable="false" islands editors use for mentions and embeds, which
 *   are still part of the HTML the editor saves.
 * - **The index is rebuilt, never appended to.** The first batch indexes every
 *   string with the nodes carrying it; the observer only raises a flag when the
 *   page shows a string with no translation, and the next batch walks again.
 * - **Text that keeps changing is not offered.** An element the observer has
 *   seen show a third untranslated string ("Updated 4 seconds ago") is live
 *   text; offering each new value made the prompt's "until nothing is left"
 *   loop endless. It is counted as `changing` instead.
 * - **A batch is settled by the write that answers it, not by being handed
 *   out.** A result can be lost on the way, so a batch nobody answered is
 *   offered again; a write answering any of its ids — or none, with an empty
 *   list, for a batch with nothing to translate — settles what it left out.
 * - **A translation is recognised wherever it turns up**, through a reverse map
 *   from translation to source: a carousel's clone of a translated slide is
 *   ours, not new source text. **Unless the text is itself a source string of
 *   the page**: masking "Alice" as "Bob Jones" on a page that also shows "Bob
 *   Jones" must leave the real one a source, or it is never translated and
 *   restore turns it into "Alice".
 * - **Each start-over is a new document id.** A different target language, or
 *   a restore, puts the page back and renumbers the document, so an answer
 *   still on its way for the previous run is refused.
 *
 * It runs in the page's own world, like every other tool here. The page can
 * see and break it: it can spoil its own translation, and like any page it can
 * stall the tool call that evaluates this.
 */
export const translatorSource = String.raw`(() => {
	const KEY = Symbol.for('aiBrowser.translate.v4');
	if (window[KEY]) {
		return window[KEY];
	}

	// Whole subtrees that are never text for a reader.
	const REJECT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'CANVAS', 'MATH']);
	// Text inside these is code, or a field's own value.
	const VERBATIM = new Set(['CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TEXTAREA']);
	const ATTRIBUTES = ['placeholder', 'title', 'alt', 'aria-label'];
	// Attributes that decide whether something may be translated at all.
	const CONTROLS = ['contenteditable', 'translate', 'class', 'value'];
	const LETTER = /\p{L}/u;
	const NOTRANSLATE = /(^|\s)notranslate(\s|$)/;
	// How often the observer re-applies a translation the page took away, per node and second.
	const REWRITES_PER_SECOND = 3;

	const base = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
	let generation = 0;
	const documentId = () => base + '.' + generation;
	const idOfKey = new Map();
	const keyOfId = new Map();
	// The current language's translations, by source key.
	const dictionary = new Map();
	// Every translation ever written on this document, collapsed, to its source key.
	const reverse = new Map();
	// Strings a write answered around without translating them.
	const settled = new Set();
	// The strings of the last batch handed out and not yet answered.
	let batch = new Set();
	// key -> [{ ref: WeakRef, name? }], rebuilt by a walk whenever it is stale.
	let index;
	let stale = true;
	// What was written where: lets the observer tell our write from the page's.
	let textRecords = new WeakMap();
	let attributeRecords = new WeakMap();
	// Weak, or every shadow root a component page ever discarded stays alive.
	let observedRoots = new WeakSet();
	// Nodes the page keeps reverting, and how often it has.
	let churn = new WeakMap();
	let givenUp = new WeakSet();
	// Elements whose untranslated text keeps changing: element -> { key, changes }.
	let volatility = new WeakMap();
	let nextId = 1;
	let observer;
	let target;
	let langSet = false;
	let originalLang = null;

	// The tag in upper case for every namespace: an SVG or MathML element
	// reports a lower-case tagName, so <svg><style> would read as text.
	const tagOf = el => (el.localName || '').toUpperCase();
	const collapse = value => value.replace(/\s+/g, ' ').trim();
	// Line breaks kept, for text the page lays out with white-space: pre-wrap.
	const collapseKeepingLines = value => value.replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
	const wrap = (source, translation) => {
		const lead = source.match(/^\s*/)[0];
		const trail = source.slice(lead.length).match(/\s*$/)[0];
		return lead + translation + trail;
	};
	// Enumerated attributes: their keywords are case-insensitive.
	const keyword = (el, name) => {
		const value = el.getAttribute(name);
		return value === null ? null : value.trim().toLowerCase();
	};
	// The element above a node, crossing out of a shadow root to its host.
	const up = node => {
		const parent = node.parentNode;
		return !parent ? null : parent.nodeType === 1 ? parent : (parent.host || null);
	};

	// Facts inherited down the tree, each cached for every element on the way
	// up, so a deep page is not climbed once per text node. A cache lives for
	// one operation, so a change between operations is always seen.
	//   verbatim: code, a field, or an option that submits its own text, above.
	//   refused:  the nearest translate attribute (or notranslate class) says no.
	//   editor:   an editing host above — through contenteditable="false"
	//             islands, which are still the editor's content.
	const memo = () => ({
		verbatim: new Map(), refused: new Map(), editor: new Map(), lines: new Map(),
		design: document.designMode === 'on',
	});
	const inherited = (el, cache, kind) => {
		const chain = [];
		let node = el;
		let value;
		while (node) {
			if (cache[kind].has(node)) {
				value = cache[kind].get(node);
				break;
			}
			chain.push(node);
			const tag = tagOf(node);
			if (kind === 'verbatim') {
				if (REJECT.has(tag) || VERBATIM.has(tag) || (tag === 'OPTION' && !node.hasAttribute('value'))) {
					value = true;
					break;
				}
			} else if (kind === 'editor') {
				const editable = keyword(node, 'contenteditable');
				if (node.isContentEditable === true || (editable !== null && editable !== 'false')) {
					value = true;
					break;
				}
			} else {
				const attr = keyword(node, 'translate');
				if (attr === 'no' || (node.classList && node.classList.contains('notranslate'))) {
					value = true;
					break;
				}
				if (attr === 'yes' || attr === '') {
					value = false;
					break;
				}
			}
			node = up(node);
		}
		value = value === true;
		for (const visited of chain) {
			cache[kind].set(visited, value);
		}
		return value;
	};
	const textExcluded = (el, cache) => !el || cache.design || inherited(el, cache, 'editor')
		|| inherited(el, cache, 'verbatim') || inherited(el, cache, 'refused');
	// An attribute is judged by the element itself and the ancestors above it,
	// so a textarea's own placeholder is translated while its contents are not.
	const attributeExcluded = (el, cache) => {
		if (REJECT.has(tagOf(el)) || cache.design || inherited(el, cache, 'editor')) {
			return true;
		}
		const attr = keyword(el, 'translate');
		if (attr === 'no' || (el.classList && el.classList.contains('notranslate'))) {
			return true;
		}
		const parent = up(el);
		if (!parent) {
			return false;
		}
		return inherited(parent, cache, 'verbatim')
			|| (attr !== 'yes' && attr !== '' && inherited(parent, cache, 'refused'));
	};
	const keepsLines = (el, cache) => {
		if (!cache.lines.has(el)) {
			const style = el.isConnected ? getComputedStyle(el) : undefined;
			const mode = style ? (style.whiteSpaceCollapse || style.whiteSpace || '') : '';
			cache.lines.set(el, /^(pre|preserve|break-spaces)/.test(mode));
		}
		return cache.lines.get(el);
	};

	// Whether a value is still what we wrote: exactly, or once whitespace is
	// collapsed, for a page that normalises spaces into nbsp after us.
	const ours = (record, value) => Boolean(record)
		&& (record.written === value || collapse(record.written) === collapse(value));
	// A source string of this page, which a translation that happens to equal it
	// must not shadow.
	const isSource = key => idOfKey.has(key) || dictionary.has(key) || (index !== undefined && index.has(key));
	const recognised = value => {
		const key = collapse(value);
		return isSource(key) ? undefined : reverse.get(key);
	};
	// The source a text node stands for: our record, else a translation we
	// recognise, else what it says.
	const sourceOfText = node => {
		const record = textRecords.get(node);
		if (ours(record, node.data)) {
			return record.original;
		}
		const known = recognised(node.data);
		return known === undefined ? node.data : wrap(node.data, known);
	};
	const sourceOfAttribute = (el, name) => {
		const value = el.getAttribute(name);
		if (value === null) {
			return null;
		}
		const records = attributeRecords.get(el);
		const record = records && records.get(name);
		if (ours(record, value)) {
			return record.original;
		}
		const known = recognised(value);
		return known === undefined ? value : wrap(value, known);
	};
	const textKey = (node, cache) => {
		const source = sourceOfText(node);
		return keepsLines(up(node), cache) ? collapseKeepingLines(source) : collapse(source);
	};
	const attributeKey = (el, name) => collapse(sourceOfAttribute(el, name) || '');
	const translatable = key => Boolean(key) && LETTER.test(key);

	// Whether a node may be written now — asked at the moment of writing.
	const textEligible = (node, cache) => node.nodeType === 3 && node.isConnected && !textExcluded(up(node), cache);
	const attributeEligible = (el, name, cache) =>
		el.isConnected && el.hasAttribute(name) && !attributeExcluded(el, cache);

	const writeText = (node, cache) => {
		if (!textEligible(node, cache)) {
			return false;
		}
		const translation = dictionary.get(textKey(node, cache));
		if (translation === undefined) {
			return false;
		}
		const source = sourceOfText(node);
		const next = wrap(source, translation);
		if (node.data === next) {
			return false;
		}
		if (collapse(node.data) === collapse(next)) {
			// Already translated, and reformatted by the page: adopt its spelling.
			textRecords.set(node, { original: source, written: node.data });
			return false;
		}
		textRecords.set(node, { original: source, written: next });
		node.data = next;
		return true;
	};
	const writeAttribute = (el, name, cache) => {
		if (!attributeEligible(el, name, cache)) {
			return false;
		}
		const translation = dictionary.get(attributeKey(el, name));
		if (translation === undefined) {
			return false;
		}
		const source = sourceOfAttribute(el, name);
		const next = wrap(source, translation);
		const now = el.getAttribute(name);
		if (now === next) {
			return false;
		}
		let records = attributeRecords.get(el);
		if (!records) {
			records = new Map();
			attributeRecords.set(el, records);
		}
		if (collapse(now) === collapse(next)) {
			records.set(name, { original: source, written: now });
			return false;
		}
		records.set(name, { original: source, written: next });
		el.setAttribute(name, next);
		return true;
	};

	// Puts one node back if we wrote it, whatever it is now.
	const revertText = node => {
		const record = textRecords.get(node);
		textRecords.delete(node);
		if (ours(record, node.data) && node.data !== record.original) {
			node.data = record.original;
			return true;
		}
		return false;
	};
	const revertAttributes = el => {
		const records = attributeRecords.get(el);
		attributeRecords.delete(el);
		let reverted = 0;
		for (const [name, record] of records || []) {
			const value = el.getAttribute(name);
			if (value !== null && ours(record, value) && value !== record.original) {
				el.setAttribute(name, record.original);
				reverted++;
			}
		}
		return reverted;
	};

	const observe = root => {
		if (observer && !observedRoots.has(root)) {
			observedRoots.add(root);
			observer.observe(root, {
				subtree: true, childList: true, characterData: true,
				attributes: true, attributeOldValue: true, attributeFilter: ATTRIBUTES.concat(CONTROLS),
			});
		}
	};

	// Every eligible text node and attribute under a root, shadow roots included.
	const visit = (root, onText, onAttribute, cache) => {
		const handle = node => {
			if (node.nodeType === 3) {
				if (!textExcluded(up(node), cache)) {
					onText(node);
				}
			} else if (node.nodeType === 1) {
				if (!attributeExcluded(node, cache)) {
					for (const name of ATTRIBUTES) {
						if (node.hasAttribute(name)) {
							onAttribute(node, name);
						}
					}
				}
				if (node.shadowRoot) {
					observe(node.shadowRoot);
					visit(node.shadowRoot, onText, onAttribute, cache);
				}
			}
		};
		if (root.nodeType === 3) {
			handle(root);
			return;
		}
		if (root.nodeType === 1) {
			if (REJECT.has(tagOf(root))) {
				return;
			}
			handle(root);
		}
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
			acceptNode: node => node.nodeType === 1 && REJECT.has(tagOf(node))
				? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
		});
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			handle(node);
		}
	};

	// Every node under a root, translatable or not, shadow roots included.
	const everyNode = (root, each) => {
		each(root);
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			each(node);
			if (node.nodeType === 1 && node.shadowRoot) {
				everyNode(node.shadowRoot, each);
			}
		}
	};

	const buildIndex = () => {
		const cache = memo();
		index = new Map();
		const add = (key, entry) => {
			if (!translatable(key)) {
				return;
			}
			const entries = index.get(key);
			if (entries) {
				entries.push(entry);
			} else {
				index.set(key, [entry]);
			}
		};
		visit(document.documentElement,
			node => add(textKey(node, cache), { ref: new WeakRef(node) }),
			(el, name) => add(attributeKey(el, name), { ref: new WeakRef(el), name }),
			cache);
		stale = false;
	};

	// The node an index entry points at, if it may still be written and still
	// carries the string.
	const live = (entry, key, cache) => {
		const node = entry.ref.deref();
		if (!node) {
			return undefined;
		}
		if (entry.name) {
			return attributeEligible(node, entry.name, cache) && attributeKey(node, entry.name) === key ? node : undefined;
		}
		return textEligible(node, cache) && textKey(node, cache) === key ? node : undefined;
	};

	// Whether the observer may rewrite a node the page has just changed.
	const rewriteAllowed = holder => {
		if (givenUp.has(holder)) {
			return false;
		}
		const now = Date.now();
		let count = churn.get(holder);
		if (!count || now - count.since > 1000) {
			count = { n: 0, since: now };
			churn.set(holder, count);
		}
		if (++count.n > REWRITES_PER_SECOND) {
			givenUp.add(holder);
			return false;
		}
		return true;
	};
	const noteChange = (el, key) => {
		const seen = volatility.get(el);
		if (!seen) {
			volatility.set(el, { key, changes: 0 });
		} else if (seen.key !== key) {
			seen.key = key;
			seen.changes++;
		}
	};
	const isVolatile = el => {
		const seen = el && volatility.get(el);
		return Boolean(seen) && seen.changes >= 1;
	};

	// The observer translates what it can and only flags the rest: the next
	// batch walks the page again rather than this growing a list.
	const noteText = (node, cache) => {
		const record = textRecords.get(node);
		if (record && !ours(record, node.data) && !rewriteAllowed(node)) {
			return;
		}
		if (!writeText(node, cache) && textEligible(node, cache)) {
			const key = textKey(node, cache);
			if (translatable(key) && !dictionary.has(key)) {
				noteChange(up(node), key);
				stale = true;
			}
		}
	};
	const noteAttribute = (el, name, cache) => {
		const records = attributeRecords.get(el);
		const record = records && records.get(name);
		const value = el.getAttribute(name);
		if (record && value !== null && !ours(record, value) && !rewriteAllowed(el)) {
			return;
		}
		if (!writeAttribute(el, name, cache) && attributeEligible(el, name, cache)) {
			const key = attributeKey(el, name);
			if (translatable(key) && !dictionary.has(key)) {
				noteChange(el, key);
				stale = true;
			}
		}
	};

	// Whether an attribute change can have changed what may be translated.
	const controlChanged = record => {
		const el = record.target;
		const name = record.attributeName;
		if (name === 'class') {
			return NOTRANSLATE.test(record.oldValue || '') !== el.classList.contains('notranslate');
		}
		if (name === 'value') {
			return tagOf(el) === 'OPTION' && (record.oldValue === null) !== !el.hasAttribute('value');
		}
		return record.oldValue !== el.getAttribute(name);
	};
	// A subtree whose eligibility changed: what may no longer be written is put
	// back now, what may be written now is translated, and the next batch walks
	// again so newly eligible strings are offered.
	const recheck = root => {
		const cache = memo();
		everyNode(root, node => {
			if (node.nodeType === 3) {
				if (textRecords.has(node) && !textEligible(node, cache)) {
					revertText(node);
				}
			} else if (attributeRecords.has(node) && attributeExcluded(node, cache)) {
				revertAttributes(node);
			}
		});
		visit(root, node => noteText(node, cache), (el, name) => noteAttribute(el, name, cache), cache);
		stale = true;
	};

	const start = () => {
		if (observer) {
			return;
		}
		observer = new MutationObserver(records => {
			let cache = memo();
			for (const record of records) {
				if (record.type === 'characterData') {
					// Text only: a comment's data is a framework's, not the reader's.
					if (record.target.nodeType === 3) {
						noteText(record.target, cache);
					}
				} else if (record.type === 'attributes') {
					if (ATTRIBUTES.includes(record.attributeName)) {
						noteAttribute(record.target, record.attributeName, cache);
					} else if (record.target.isConnected && controlChanged(record)) {
						recheck(record.target);
						cache = memo();
					}
				} else {
					for (const added of record.addedNodes) {
						if ((added.nodeType === 1 || added.nodeType === 3) && added.isConnected) {
							visit(added, node => noteText(node, cache), (el, name) => noteAttribute(el, name, cache), cache);
						}
					}
				}
			}
		});
		observe(document);
	};

	const putBack = () => {
		if (observer) {
			observer.disconnect();
			observer = undefined;
		}
		let restored = 0;
		const cache = memo();
		// A walk rather than a list of what was written: a list grows with every
		// node a re-rendering page creates, for as long as the page is open. A
		// node with our record goes back whatever it is now — editable, an option
		// that lost its value — since the record proves we wrote it; copies of our
		// text with no record are recognised only where we may write.
		everyNode(document.documentElement, node => {
			if (node.nodeType === 3) {
				if (textRecords.has(node)) {
					restored += revertText(node) ? 1 : 0;
					return;
				}
				if (textExcluded(up(node), cache)) {
					return;
				}
				const known = recognised(node.data);
				if (known !== undefined) {
					node.data = wrap(node.data, known);
					restored++;
				}
			} else {
				restored += revertAttributes(node);
				if (attributeExcluded(node, cache)) {
					return;
				}
				for (const name of ATTRIBUTES) {
					const value = node.getAttribute(name);
					const known = value === null ? undefined : recognised(value);
					if (known !== undefined) {
						node.setAttribute(name, wrap(value, known));
						restored++;
					}
				}
			}
		});
		textRecords = new WeakMap();
		attributeRecords = new WeakMap();
		observedRoots = new WeakSet();
		churn = new WeakMap();
		givenUp = new WeakSet();
		volatility = new WeakMap();
		index = undefined;
		stale = true;
		dictionary.clear();
		settled.clear();
		batch = new Set();
		target = undefined;
		generation++;
		const root = document.documentElement;
		if (langSet) {
			if (originalLang === null) {
				root.removeAttribute('lang');
			} else {
				root.setAttribute('lang', originalLang);
			}
			langSet = false;
		}
		return restored;
	};

	const sameLanguage = (a, b) => a.toLowerCase() === b.toLowerCase();

	const api = {
		segments(maxChars, maxSingle, lang) {
			if (lang && target && !sameLanguage(lang, target)) {
				putBack();
			}
			target = lang || target;
			start();
			if (stale || !index) {
				buildIndex();
			}

			const cache = memo();
			const pending = [];
			let tooLong = 0;
			let changing = 0;
			for (const [key, entries] of [...index]) {
				if (dictionary.has(key)) {
					index.delete(key);
					continue;
				}
				const kept = entries.filter(entry => live(entry, key, cache));
				if (kept.length === 0) {
					index.delete(key);
					continue;
				}
				if (kept.length !== entries.length) {
					index.set(key, kept);
				}
				if (settled.has(key)) {
					continue;
				}
				const steady = kept.some(entry => {
					const node = entry.ref.deref();
					return node && !isVolatile(entry.name ? node : up(node));
				});
				if (!steady) {
					changing++;
					continue;
				}
				if (key.length > maxSingle) {
					tooLong++;
					continue;
				}
				pending.push(key);
			}

			// The previous batch, if nobody answered it, is simply offered again.
			batch = new Set();
			const segments = [];
			let used = 0;
			for (const key of pending) {
				// A little per segment for the JSON around it.
				const cost = key.length + 24;
				if (segments.length > 0 && used + cost > maxChars) {
					break;
				}
				let id = idOfKey.get(key);
				if (!id) {
					id = 's' + nextId++;
					idOfKey.set(key, id);
					keyOfId.set(id, key);
				}
				segments.push({ id, text: key });
				batch.add(key);
				used += cost;
			}
			return {
				documentId: documentId(),
				// The page's own, not the one a write set.
				pageLanguage: (langSet ? originalLang : document.documentElement.getAttribute('lang')) || undefined,
				segments,
				remaining: pending.length - segments.length,
				tooLong: tooLong || undefined,
				changing: changing || undefined,
			};
		},

		replace(id, lang, pairs) {
			if (id !== documentId()) {
				throw new Error('This page has reloaded, navigated, been put back or switched to another language since '
					+ 'browser_text_segments was called, so these segment ids no longer apply. Call '
					+ 'browser_text_segments again and translate what it returns.');
			}
			if (lang && target && !sameLanguage(lang, target)) {
				throw new Error('This page is now being translated into ' + target + ', not ' + lang + '. Call '
					+ 'browser_text_segments with the language you are translating into.');
			}
			start();
			const unknownIds = [];
			const accepted = [];
			let corrected = false;
			let answersBatch = pairs.length === 0;
			for (const pair of pairs) {
				const key = keyOfId.get(pair.id);
				if (key === undefined) {
					unknownIds.push(pair.id);
					continue;
				}
				corrected = corrected || (dictionary.has(key) && dictionary.get(key) !== pair.text);
				dictionary.set(key, pair.text);
				reverse.set(collapse(pair.text), key);
				settled.delete(key);
				answersBatch = answersBatch || batch.has(key);
				accepted.push(key);
			}
			// The batch was received: what it left out was left out on purpose.
			let skipped = 0;
			if (answersBatch) {
				for (const key of batch) {
					if (!dictionary.has(key)) {
						settled.add(key);
						skipped++;
					}
				}
				batch = new Set();
			}
			if (lang) {
				const html = document.documentElement;
				if (!langSet) {
					originalLang = html.getAttribute('lang');
					langSet = true;
				}
				html.setAttribute('lang', lang);
				target = target || lang;
			}

			let applied = 0;
			const cache = memo();
			if (corrected || stale || !index) {
				// A correction reaches nodes already showing the old translation, and
				// a stale index may miss nodes the page added since: walk the page.
				visit(document.documentElement,
					node => { applied += writeText(node, cache) ? 1 : 0; },
					(el, name) => { applied += writeAttribute(el, name, cache) ? 1 : 0; },
					cache);
			} else {
				for (const key of accepted) {
					for (const entry of index.get(key) || []) {
						const node = live(entry, key, cache);
						if (node && (entry.name ? writeAttribute(node, entry.name, cache) : writeText(node, cache))) {
							applied++;
						}
					}
					index.delete(key);
				}
			}
			return { accepted: accepted.length, applied, skipped, unknownIds };
		},

		restore() {
			return { restored: putBack() };
		},
	};

	Object.defineProperty(window, KEY, { value: api, configurable: true });
	return api;
})()`;
