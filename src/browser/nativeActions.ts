/* Native browser input, independently implemented using CDP. No Stagehand runtime. */

export interface ActionScope { sessionId: string; contextId?: number }
export interface FrameOwner { frameId: string; parent: ActionScope }
export interface ActionEnvironment {
	send(method: string, params: object, sessionId: string): Promise<any>;
	scope(frameId?: string): Promise<ActionScope>;
	/** Outermost owner first. Never includes a frame from a different tab. */
	owners(frameId: string): Promise<FrameOwner[]>;
	mainSessionId: string;
}
export interface PointerOptions {
	button?: 'left' | 'middle' | 'right';
	clickCount?: number;
	smooth?: boolean;
	humanize?: boolean;
}
export interface Point { x: number; y: number }
interface PinnedOwner { id: string; scope: ActionScope; child: ActionScope; scriptless?: boolean }
type Matrix = number[];
const identity: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Unit square to a convex CSS content quad, including projective transforms. */
export function quadMatrix(width: number, height: number, quad: number[]): Matrix {
	if (!(width > 0 && height > 0) || quad.length !== 8 || !quad.every(Number.isFinite)) { throw new Error('Invalid frame content geometry.'); }
	const points = [[0, 0], [1, 0], [1, 1], [0, 1]];
	const rows: number[][] = [];
	for (let i = 0; i < 4; i++) {
		const [u, v] = points[i], x = quad[i * 2], y = quad[i * 2 + 1];
		rows.push([u, v, 1, 0, 0, 0, -x * u, -x * v, x], [0, 0, 0, u, v, 1, -y * u, -y * v, y]);
	}
	for (let column = 0; column < 8; column++) {
		let pivot = column;
		for (let row = column + 1; row < 8; row++) { if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) { pivot = row; } }
		if (Math.abs(rows[pivot][column]) < 1e-9) { throw new Error('The frame transform is singular or edge-on.'); }
		[rows[column], rows[pivot]] = [rows[pivot], rows[column]];
		const divisor = rows[column][column];
		rows[column] = rows[column].map(value => value / divisor);
		for (let row = 0; row < 8; row++) {
			if (row === column) { continue; }
			const factor = rows[row][column];
			rows[row] = rows[row].map((value, i) => value - factor * rows[column][i]);
		}
	}
	const h = rows.map(row => row[8]);
	return [h[0] / width, h[1] / height, h[2], h[3] / width, h[4] / height, h[5], h[6] / width, h[7] / height, 1];
}

export function projectPoint(matrix: Matrix, point: Point): Point {
	const d = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
	if (!Number.isFinite(d) || Math.abs(d) < 1e-9) { throw new Error('The frame transform projects outside the visible plane.'); }
	const x = (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / d;
	const y = (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / d;
	if (!Number.isFinite(x) || !Number.isFinite(y)) { throw new Error('Invalid projected frame coordinates.'); }
	return { x, y };
}

export function inverseMatrix(m: Matrix): Matrix {
	const [a, b, c, d, e, f, g, h, i] = m;
	const adj = [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d];
	const determinant = a * adj[0] + b * adj[3] + c * adj[6];
	if (Math.abs(determinant) < 1e-12) { throw new Error('The frame transform is not invertible.'); }
	return adj.map(value => value / determinant);
}

export function splitActionSelector(selector: string): string[] {
	if (typeof selector !== 'string' || !selector.trim() || selector.length > 4000) { throw new Error('A selector of 1–4000 characters is required.'); }
	const parts: string[] = []; let start = 0, quote = '', depth = 0;
	for (let i = 0; i < selector.length; i++) {
		const c = selector[i];
		if (c === '\\') { i++; continue; }
		if (quote) { if (c === quote) { quote = ''; } continue; }
		if (c === '"' || c === "'") { quote = c; continue; }
		if (c === '[' || c === '(') { depth++; }
		if (c === ']' || c === ')') { depth--; }
		if (!depth && selector.slice(i, i + 3) === '>>>') { parts.push(selector.slice(start, i).trim()); i += 2; start = i + 1; }
	}
	parts.push(selector.slice(start).trim());
	if (parts.some(part => !part) || parts.length > 32) { throw new Error('Invalid or excessively deep shadow selector.'); }
	return parts;
}

/** Shared by page scripts; explicit >>> crosses an open shadow root. Plain CSS stays CSS. */
export const actionLocatorSource = String.raw`(selector => {
	if (typeof selector !== 'string' || !selector.trim()) throw new Error('A non-empty selector is required.');
	const parts = []; let start=0, quote='', depth=0;
	for (let i=0; i<selector.length; i++) {
		const c=selector[i];
		if (c === '\\') { i++; continue; }
		if (quote) { if (c === quote) quote=''; continue; }
		if (c === '"' || c === "'") { quote=c; continue; }
		if (c === '[' || c === '(') depth++;
		if (c === ']' || c === ')') depth--;
		if (!depth && selector.slice(i,i+3) === '>>>') { parts.push(selector.slice(start,i).trim()); i+=2; start=i+1; }
	}
	parts.push(selector.slice(start).trim());
	let root = document, el;
	for (let i = 0; i < parts.length; i++) {
		if (!parts[i]) throw new Error('Empty shadow selector segment.');
		const matches = root.querySelectorAll(parts[i]);
		if (!matches.length) throw new Error('No element matches the selector. Refresh browser_snapshot before retrying.');
		if (matches.length !== 1) throw new Error('The selector is ambiguous. Use a unique selector before acting.');
		el = matches[0];
		if (i < parts.length - 1) {
			root = el.shadowRoot;
			if (!root) throw new Error('The selected element has no open shadow root.');
		}
	}
	return el;
})`;

/** Bounded orientation, including open shadow roots; never reports editable values as labels. */
const actionSnapshotFunction = String.raw`function(...closedRoots) {
	const closed=new Map(closedRoots.map(root=>[root.host,root]));
	const shadowFor=el=>el.shadowRoot || closed.get(el);
	const out=[], roots=[{root:document,prefix:''}]; let visited=0;
	function localSelector(el,root) {
		const unique=s => { try { const matches=root.querySelectorAll(s); return matches.length===1 && matches[0]===el; } catch { return false; } };
		if (el.id) { const s='#'+CSS.escape(el.id); if (unique(s)) return s; }
		for (const attr of ['data-testid','name','aria-label']) {
			const value=el.getAttribute(attr);
			if (value) { const s=CSS.escape(el.localName)+'['+attr+'='+JSON.stringify(value)+']'; if (unique(s)) return s; }
		}
		const parts=[];
		for (let node=el; node && node.nodeType===1; node=node.parentElement) {
			const siblings=[...(node.parentElement || root).children].filter(sibling=>sibling.localName===node.localName);
			parts.unshift(CSS.escape(node.localName)+':nth-of-type('+(siblings.indexOf(node)+1)+')');
		}
		const path=parts.join(' > '); return unique(path) ? path : undefined;
	}
	for (let r=0; r<roots.length && r<200 && visited<20000 && out.length<150; r++) {
		const {root,prefix}=roots[r];
		for (const el of root.querySelectorAll('*')) {
			if (++visited>20000 || out.length>=150) break;
			const interactive=el.matches('a[href],button,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="switch"],[contenteditable="true"],[contenteditable=""],[tabindex]');
			const shadow=shadowFor(el);
			if (!interactive && !shadow) continue;
			const local=localSelector(el,root), selector=local ? prefix+local : undefined;
			if (shadow && selector && roots.length<200) roots.push({root:shadow,prefix:selector+' >>> '});
			if (!interactive) continue;
			const rect=el.getBoundingClientRect(), style=getComputedStyle(el);
			if (!rect.width || !rect.height || style.visibility==='hidden' || style.visibility==='collapse') continue;
			const buttonLike=el.tagName==='INPUT' && /^(submit|button|reset)$/i.test(el.type);
			const editable=el.isContentEditable || el.matches('input,textarea,select');
			const label=(el.getAttribute('aria-label') || (!editable ? el.innerText : '') || (buttonLike ? el.value : '') || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().slice(0,80);
			const entry={tag:el.localName,type:el.getAttribute('type') || undefined,label};
			if (!buttonLike && el.matches('input,textarea') && el.value) entry.filled=true;
			if (el.matches(':disabled') || el.getAttribute('aria-disabled')==='true') entry.disabled=true;
			if (selector && selector.length<=4000) entry.selector=selector;
			out.push(entry);
		}
	}
	return {url:location.href,title:document.title,elements:out,truncated:out.length>=150 || visited>=20000 || roots.length>=200};
}`;
export const actionSnapshotSource = `(${actionSnapshotFunction})()`;

/** Functions run on a pinned remote element: a rerender must not redirect an action. */
const prepareSource = String.raw`function(mode) {
	if (!this.isConnected) throw new Error('The element was detached. Refresh browser_snapshot.');
	for (let node=this; node; node=node.parentElement || node.getRootNode().host) {
		if (node.matches(':disabled,[inert],[aria-disabled="true"]')) throw new Error('The element is disabled or inert.');
	}
	const style = getComputedStyle(this);
	if (style.visibility === 'hidden' || style.visibility === 'collapse' || !this.getClientRects().length)
		throw new Error('The element is not visible.');
	this.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
	if (mode === 'focus' || mode === 'type') {
		if (mode === 'type' && !(this.isContentEditable || this.matches('textarea, input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]):not([type=range]):not([type=color])')))
			throw new Error('Select a text input, textarea or contenteditable to type.');
		if (mode === 'type' && this.readOnly) throw new Error('The field is read-only.');
		this.focus({preventScroll:true});
		if (this.getRootNode().activeElement !== this) throw new Error('The element could not receive focus.');
	}
	return this.localName;
}`;

const pointSource = String.raw`function() {
	if (!this.isConnected) throw new Error('The element was detached before input.');
	for (let node=this; node; node=node.parentElement || node.getRootNode().host) {
		if (node.matches(':disabled,[inert],[aria-disabled="true"]')) throw new Error('The element became disabled or inert.');
	}
	const rectangles = [...this.getClientRects()].map(r => ({
		left:Math.max(0,r.left), top:Math.max(0,r.top), right:Math.min(innerWidth,r.right), bottom:Math.min(innerHeight,r.bottom)
	})).filter(r => r.right > r.left && r.bottom > r.top);
	for (const r of rectangles) {
		const x=(r.left+r.right)/2, y=(r.top+r.bottom)/2;
		let hit=this.getRootNode().elementFromPoint(x,y);
		while (hit && hit.shadowRoot) {
			const inner=hit.shadowRoot.elementFromPoint(x,y);
			if (!inner || inner === hit) break;
			hit=inner;
		}
		for (let node=hit; node; node=node.parentNode || node.host) {
			if (node === this) return {x,y};
		}
	}
	throw new Error('The element is outside the viewport or covered by another element.');
}`;

const ownerHitSource = String.raw`function(x,y) {
	let hit=this.getRootNode().elementFromPoint(x,y);
	while (hit && hit.shadowRoot) { const inner=hit.shadowRoot.elementFromPoint(x,y); if (!inner || inner===hit) break; hit=inner; }
	if (hit !== this) throw new Error('The frame is covered or outside its parent viewport.');
}`;

export function pointerRoute(from: Point, to: Point, smooth: boolean, humanize = false, random = Math.random): Point[] {
	if (!smooth) { return [to]; }
	const distance = Math.hypot(to.x - from.x, to.y - from.y);
	const steps = Math.max(4, Math.min(humanize ? 28 : 18, Math.ceil(distance / (humanize ? 22 : 35))));
	const bend = humanize ? (random() - .5) * Math.min(90, distance * .35) : 0;
	return Array.from({ length: steps }, (_, index) => {
		const t = (index + 1) / steps, eased = t * t * (3 - 2 * t);
		const arc = Math.sin(Math.PI * eased) * bend;
		return index === steps - 1 ? { ...to } : {
			x: from.x + (to.x - from.x) * eased - (to.y - from.y) / (distance || 1) * arc,
			y: from.y + (to.y - from.y) * eased + (to.x - from.x) / (distance || 1) * arc,
		};
	});
}

/** Deliberately small, explicit keyboard grammar; no raw CDP arguments. */
export function keyDescription(shortcut: string, platform = process.platform): Record<string, unknown> {
	const parts = shortcut.split('+');
	let modifiers = 0;
	const bits: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
	for (const part of parts.slice(0, -1)) {
		if (!bits[part] || (modifiers & bits[part])) { throw new Error('Use modifiers Alt, Control, Meta, Shift followed by one key, for example Control+a.'); }
		modifiers |= bits[part];
	}
	const key = parts.at(-1)!;
	const codes: Record<string, number> = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, Space: 32, PageUp: 33, PageDown: 34,
		End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };
	const code = codes[key] ?? (/^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : undefined);
	if (code === undefined) { throw new Error('Unsupported key. Use a letter, digit, Enter, Tab, Escape, Space, Backspace, Delete, arrows, Home, End, PageUp or PageDown.'); }
	const actual = key === 'Space' ? ' ' : key.length === 1 && (modifiers & 8) ? key.toUpperCase() : key;
	const text = !(modifiers & 7) ? key === 'Enter' ? '\r' : actual.length === 1 ? actual : undefined : undefined;
	const primary = platform === 'darwin' ? 4 : 2;
	// The clipboard is the user's: a paste would put what they copied — a password, a token —
	// into a page the agent then reads, and a copy or cut would overwrite it. The shortcut is
	// refused outright, since without the command Chromium still runs Control+V natively on
	// Windows and Linux. Text goes in with browser_type.
	if ((modifiers === primary || modifiers === (primary | 8)) && /^[cvx]$/i.test(key)) {
		throw new Error('Copy, cut and paste shortcuts are not available: the clipboard holds the user\'s own data. Use browser_type to enter text.');
	}
	const editing: Record<string, string> = { a: 'selectAll', z: 'undo', y: 'redo' };
	const command = (modifiers === primary || modifiers === (primary | 8)) ? editing[key.toLowerCase()] : undefined;
	const commands = command ? [command === 'undo' && (modifiers & 8) ? 'redo' : command] : undefined;
	return { key: actual, windowsVirtualKeyCode: code, modifiers, ...(commands ? { commands } : {}), ...(text ? { text, unmodifiedText: text } : {}) };
}

/** One per tab session. Serializes native input; never retries an issued mutation. */
export class NativeActions {
	private tail: Promise<unknown> = Promise.resolve();
	private pointer: Point = { x: 0, y: 0 };
	private readonly env: ActionEnvironment;
	constructor(env: ActionEnvironment) { this.env = env; }

	private async send(method: string, params: object, scope: ActionScope, signal?: AbortSignal): Promise<any> {
		signal?.throwIfAborted();
		return this.wait(this.env.send(method, params, scope.sessionId), signal);
	}

	private async wait<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			return await Promise.race([work, new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('Browser input timed out. Check the page before retrying; input may already have been delivered.')), 2500);
				onAbort = () => reject(signal!.reason);
				signal?.addEventListener('abort', onAbort, { once: true });
				if (signal?.aborted) { onAbort(); }
			})]);
		} finally {
			clearTimeout(timer);
			if (onAbort) { signal?.removeEventListener('abort', onAbort); }
		}
	}

	private async call(objectId: string, scope: ActionScope, functionDeclaration: string, args: unknown[] = [], signal?: AbortSignal): Promise<any> {
		const reply = await this.send('Runtime.callFunctionOn', { objectId, functionDeclaration,
			arguments: args.map(value => ({ value })), returnByValue: true }, scope, signal);
		if (reply.exceptionDetails) { throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text); }
		return reply.result?.value;
	}

	private async release(objectId: string, scope: ActionScope): Promise<void> {
		await this.send('Runtime.releaseObject', { objectId }, scope).catch(() => undefined);
	}

	private async element<T>(selector: string, frameId: string | undefined, signal: AbortSignal | undefined,
		work: (objectId: string, scope: ActionScope) => Promise<T>): Promise<T> {
		const scope = await this.wait(this.env.scope(frameId), signal);
		const objectId = await this.resolveElement(selector, scope, signal);
		try { return await work(objectId, scope); }
		finally { await this.release(objectId, scope); }
	}

	private async resolveElement(selector: string, scope: ActionScope, signal?: AbortSignal): Promise<string> {
		const parts = splitActionSelector(selector), temporary: string[] = [];
		let finalId: string | undefined;
		try {
			let reply = await this.send('Runtime.evaluate', {
				expression: `${actionLocatorSource}(${JSON.stringify(parts[0])})`, contextId: scope.contextId, returnByValue: false,
			}, scope, signal);
			for (let index = 0; index < parts.length; index++) {
				if (reply.exceptionDetails) { throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text); }
				const objectId = reply.result?.objectId;
				if (!objectId) { throw new Error('The selector did not resolve to an element.'); }
				temporary.push(objectId);
				if (index === parts.length - 1) { finalId = objectId; return objectId; }
				const { node } = await this.send('DOM.describeNode', { objectId, depth: 1, pierce: true }, scope, signal);
				const root = node?.shadowRoots?.find((root: any) => root.shadowRootType === 'open' || root.shadowRootType === 'closed');
				if (!root) { throw new Error('The selected element has no author shadow root.'); }
				const resolved = await this.send('DOM.resolveNode', { backendNodeId: root.backendNodeId, executionContextId: scope.contextId }, scope, signal);
				const rootId = resolved.object?.objectId;
				if (!rootId) { throw new Error('The shadow root could not be resolved.'); }
				temporary.push(rootId);
				reply = await this.send('Runtime.callFunctionOn', { objectId: rootId, returnByValue: false,
					functionDeclaration: `function(selector) { const matches=this.querySelectorAll(selector); if (!matches.length) throw new Error('No element matches inside the shadow root.'); if (matches.length!==1) throw new Error('The shadow selector is ambiguous.'); return matches[0]; }`,
					arguments: [{ value: parts[index + 1] }],
				}, scope, signal);
			}
			throw new Error('The shadow selector did not resolve.');
		} finally { await Promise.all(temporary.filter(id => id !== finalId).map(id => this.release(id, scope))); }
	}

	/** Used by fill, keeping its framework-aware value logic on a pinned element. */
	onElement(selector: string, frameId: string | undefined, functionDeclaration: string, args: unknown[], signal?: AbortSignal): Promise<any> {
		return this.enqueue(signal, signal => this.element(selector, frameId, signal, (id, scope) => this.call(id, scope, functionDeclaration, args, signal)));
	}

	/** DOM discovery stays in the selected document; UA roots and iframe documents are excluded. */
	snapshot(frameId?: string, signal?: AbortSignal): Promise<any> {
		return this.enqueue(signal, async signal => {
			const scope = await this.wait(this.env.scope(frameId), signal), ids: string[] = [];
			try {
				const doc = await this.send('Runtime.evaluate', { expression: 'document', contextId: scope.contextId, returnByValue: false }, scope, signal);
				const documentId = doc.result?.objectId;
				if (!documentId) { throw new Error('The page document is unavailable.'); }
				ids.push(documentId);
				const { node } = await this.send('DOM.describeNode', { objectId: documentId, depth: -1, pierce: true }, scope, signal);
				const stack = [node]; let visited = 0, truncated = false;
				while (stack.length && visited++ < 20000 && ids.length <= 200) {
					const current = stack.pop();
					if (!current) { continue; }
					if (current.shadowRootType === 'closed') {
						const reply = await this.send('DOM.resolveNode', { backendNodeId: current.backendNodeId, executionContextId: scope.contextId }, scope, signal);
						if (reply.object?.objectId) { ids.push(reply.object.objectId); }
					}
					for (const child of current.children ?? []) { stack.push(child); }
					for (const root of current.shadowRoots ?? []) { if (root.shadowRootType !== 'user-agent') { stack.push(root); } }
				}
				truncated = stack.length > 0;
				const reply = await this.send('Runtime.callFunctionOn', { objectId: documentId, functionDeclaration: actionSnapshotFunction,
					arguments: ids.slice(1).map(objectId => ({ objectId })), returnByValue: true }, scope, signal);
				if (reply.exceptionDetails) { throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text); }
				return { ...reply.result?.value, truncated: truncated || !!reply.result?.value?.truncated };
			} finally { await Promise.all(ids.map(id => this.release(id, scope))); }
		});
	}

	private async owners(frameId: string | undefined, signal: AbortSignal | undefined): Promise<PinnedOwner[]> {
		const owners: PinnedOwner[] = [];
		try {
			for (const owner of frameId ? await this.wait(this.env.owners(frameId), signal) : []) {
				const node = await this.send('DOM.getFrameOwner', { frameId: owner.frameId }, owner.parent, signal);
				const resolved = await this.send('DOM.resolveNode', { backendNodeId: node.backendNodeId,
					executionContextId: owner.parent.contextId }, owner.parent, signal);
				const id = resolved.object?.objectId;
				if (!id) { throw new Error('The frame owner could not be resolved.'); }
				const pinned: PinnedOwner = { id, scope: owner.parent, child: owner.parent }; owners.push(pinned);
				pinned.child = await this.wait(this.env.scope(owner.frameId), signal);
				await this.call(id, owner.parent, prepareSource, ['pointer'], signal);
				pinned.scriptless = await this.call(id, owner.parent, `function(){return this.hasAttribute('sandbox') && !this.sandbox.contains('allow-scripts');}`, [], signal) === true;
			}
			return owners;
		} catch (error) {
			await Promise.all(owners.map(owner => this.release(owner.id, owner.scope)));
			throw error;
		}
	}

	private async point(objectId: string, scope: ActionScope, owners: PinnedOwner[], signal?: AbortSignal): Promise<Point> {
		let point: Point = await this.call(objectId, scope, pointSource, [], signal);
		const sessions = new Map<string, Matrix>([[this.env.mainSessionId, identity]]), parents: Matrix[] = [];
		let transform = identity;
		for (const owner of owners) {
			parents.push(transform);
			const { model } = await this.send('DOM.getBoxModel', { objectId: owner.id }, owner.scope, signal);
			const viewport = await this.send('Runtime.evaluate', { expression: '({width:innerWidth,height:innerHeight})', contextId: owner.child.contextId, returnByValue: true }, owner.child, signal);
			const width = viewport.result?.value?.width, height = viewport.result?.value?.height;
			const sessionTransform = sessions.get(owner.scope.sessionId);
			if (!sessionTransform || !model?.content) { throw new Error('The frame content geometry is unavailable.'); }
			const quad: number[] = [];
			for (let index = 0; index < 8; index += 2) {
				const p = projectPoint(sessionTransform, { x: model.content[index], y: model.content[index + 1] }); quad.push(p.x, p.y);
			}
			transform = quadMatrix(width, height, quad);
			if (owner.child.sessionId !== owner.scope.sessionId) { sessions.set(owner.child.sessionId, transform); }
		}
		point = projectPoint(transform, point);
		for (let index = 0; index < owners.length; index++) {
			const local = projectPoint(inverseMatrix(parents[index]), point), owner = owners[index];
			await this.call(owner.id, owner.scope, ownerHitSource, [local.x, local.y], signal);
		}
		if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) { throw new Error('Invalid element geometry.'); }
		return point;
	}

	private enqueue<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>, budgetMs = 15_000): Promise<T> {
		// Do not require AbortSignal.any: older supported editors embed older Node.
		const controller = new AbortController(), abort = () => controller.abort(signal?.reason);
		signal?.addEventListener('abort', abort, { once: true });
		if (signal?.aborted) { abort(); }
		const timer = setTimeout(() => controller.abort(new Error('Browser action timed out. Check the page before retrying; input may already have been delivered.')), budgetMs);
		timer.unref();
		const turn = this.tail.then(() => { controller.signal.throwIfAborted(); return work(controller.signal); }).finally(() => {
			clearTimeout(timer); signal?.removeEventListener('abort', abort);
		});
		this.tail = turn.catch(() => undefined);
		return turn;
	}

	private async pause(min: number, max: number, signal?: AbortSignal): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try { await this.wait(new Promise<void>(resolve => { timer = setTimeout(resolve, min + Math.random() * (max - min)); }), signal); }
		finally { clearTimeout(timer); }
	}

	private async move(point: Point, smooth: boolean, signal?: AbortSignal, dragging = false, humanize = false): Promise<void> {
		for (const next of pointerRoute(this.pointer, point, smooth || humanize, humanize)) {
			await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...next, button: dragging ? 'left' : 'none', buttons: dragging ? 1 : 0 }, { sessionId: this.env.mainSessionId }, signal);
			this.pointer = next;
			if (smooth || humanize) { await this.pause(humanize ? 8 : 12, humanize ? 23 : 12, signal); }
		}
	}

	/** A renderer's layout may be newer than the compositor's OOPIF hit-test data. */
	private async hoverTarget(id: string, scope: ActionScope, owners: PinnedOwner[], point: Point, options: PointerOptions, signal: AbortSignal): Promise<Point> {
		if (!owners.some(owner => owner.scope.sessionId !== owner.child.sessionId)) {
			await this.move(point, options.smooth ?? false, signal, false, options.humanize); return point;
		}
		if (owners.some(owner => owner.scriptless)) {
			// Sandbox blocks page event callbacks. Poll geometry from the host instead.
			await this.pause(100, 140, signal);
			const stable = await this.point(id, scope, owners, signal);
			if (Math.hypot(stable.x - point.x, stable.y - point.y) > 1) { throw new Error('The sandboxed frame is still moving.'); }
			await this.move(stable, options.smooth ?? false, signal, false, options.humanize); return stable;
		}
		const reply = await this.send('Runtime.callFunctionOn', { objectId: id, returnByValue: false,
			functionDeclaration: `function() {
				const root=this.getRootNode(), target=this;
				const probe={seen:false,dispose:()=>root.removeEventListener('pointermove',listener,true)};
				const listener=event=>{if(event.isTrusted && event.composedPath().includes(target)) probe.seen=true;};
				root.addEventListener('pointermove',listener,true); return probe;
			}`,
		}, scope, signal);
		const probe = reply.result?.objectId;
		if (!probe || reply.exceptionDetails) { throw new Error('Could not verify native pointer targeting.'); }
		try {
			for (let attempt = 0; attempt < 5; attempt++) {
				await this.move(point, options.smooth ?? false, signal, false, options.humanize);
				if (await this.call(probe, scope, 'function(){return this.seen;}', [], signal) === true) { return point; }
				await this.pause(35, 55, signal);
				point = await this.point(id, scope, owners, signal);
			}
			throw new Error('Native pointer input did not reach the selected element. Its frame may still be moving or covered.');
		} finally {
			await this.call(probe, scope, 'function(){this.dispose();}').catch(() => undefined);
			await this.release(probe, scope);
		}
	}

	pointerAction(kind: 'click' | 'hover', selector: string, frameId: string | undefined, options: PointerOptions = {}, signal?: AbortSignal): Promise<unknown> {
		const button = options.button ?? 'left', count = options.clickCount ?? 1;
		if ((options.button !== undefined && !['left', 'middle', 'right'].includes(options.button))
			|| (options.clickCount !== undefined && ![1, 2].includes(options.clickCount)) || (options.smooth !== undefined && typeof options.smooth !== 'boolean')
			|| (options.humanize !== undefined && typeof options.humanize !== 'boolean')) {
			return Promise.reject(new Error('Use button left/middle/right, clickCount 1/2, and boolean smooth/humanize.'));
		}
		return this.enqueue(signal, async signal => {
			const owners = await this.owners(frameId, signal);
			try {
				return await this.element(selector, frameId, signal, async (id, scope) => {
					const tag = await this.call(id, scope, prepareSource, ['pointer'], signal);
					let point = await this.point(id, scope, owners, signal);
					const main = { sessionId: this.env.mainSessionId };
					point = await this.hoverTarget(id, scope, owners, point, options, signal);
					// Hover handlers can change layout. Recheck before pressing; never fall back to el.click().
					if (kind === 'click') {
						if (options.humanize) { await this.pause(45, 110, signal); }
						const verified = await this.point(id, scope, owners, signal);
						if (Math.hypot(verified.x - point.x, verified.y - point.y) > 1) { throw new Error('The target moved after hovering. Refresh browser_snapshot before clicking.'); }
						for (let clickCount = 1; clickCount <= count; clickCount++) {
							if (clickCount > 1) {
								const current = await this.point(id, scope, owners, signal);
								if (Math.hypot(current.x - point.x, current.y - point.y) > 1) { throw new Error('The target moved between clicks.'); }
							}
							signal.throwIfAborted();
							this.pointer = point;
							try {
								await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4, clickCount }, main, signal);
								if (options.humanize) { await this.pause(30, 65, signal); }
							} finally {
								// Also release on cancellation or a failed press acknowledgement.
								await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, buttons: 0, clickCount }, main);
							}
							if (options.humanize && clickCount < count) { await this.pause(45, 85, signal); }
						}
					}
					return { action: kind, tag, ...(kind === 'click' ? { button, clickCount: count } : {}), ...point };
				});
			} finally { await Promise.all(owners.map(owner => this.release(owner.id, owner.scope))); }
		});
	}

	drag(selector: string, targetSelector: string, frameId: string | undefined, smooth = true, signal?: AbortSignal, humanize = false): Promise<unknown> {
		if (typeof smooth !== 'boolean' || typeof humanize !== 'boolean') { return Promise.reject(new Error('smooth and humanize must be boolean.')); }
		return this.enqueue(signal, async signal => {
			const owners = await this.owners(frameId, signal);
			try {
				return await this.element(selector, frameId, signal, async (source, scope) =>
					this.element(targetSelector, frameId, signal, async (target, targetScope) => {
						await this.call(source, scope, prepareSource, ['pointer'], signal);
						await this.call(target, targetScope, prepareSource, ['pointer'], signal);
						let from = await this.point(source, scope, owners, signal);
						const to = await this.point(target, targetScope, owners, signal);
						const main = { sessionId: this.env.mainSessionId };
						from = await this.hoverTarget(source, scope, owners, from, { smooth, humanize }, signal);
						const checked = await this.point(source, scope, owners, signal);
						if (Math.hypot(checked.x - from.x, checked.y - from.y) > 1) { throw new Error('The drag source moved before pressing. Refresh browser_snapshot.'); }
						signal.throwIfAborted();
						try {
							await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', buttons: 1, clickCount: 1 }, main, signal);
							if (humanize) { await this.pause(45, 100, signal); }
							await this.move(to, smooth, signal, true, humanize);
						} finally {
							await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...this.pointer, button: 'left', buttons: 0, clickCount: 1 }, main);
						}
						return { action: 'drag', from, to };
					}));
			} finally { await Promise.all(owners.map(owner => this.release(owner.id, owner.scope))); }
		});
	}

	keyboardAction(selector: string, frameId: string | undefined, input: { text: string } | { key: string }, signal?: AbortSignal, humanize = false): Promise<unknown> {
		if (typeof humanize !== 'boolean') { return Promise.reject(new Error('humanize must be a boolean.')); }
		const key = 'key' in input ? keyDescription(input.key) : undefined;
		if ('text' in input && (typeof input.text !== 'string' || input.text.length > 20_000)) {
			return Promise.reject(new Error('text must be a string of at most 20000 characters.'));
		}
		const characters = 'text' in input && humanize ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(input.text), part => part.segment) : [];
		if (characters.length > 400) { return Promise.reject(new Error('Humanized typing accepts at most 400 characters per call. Split longer text or disable humanize.')); }
		return this.enqueue(signal, signal => this.element(selector, frameId, signal, async (id, scope) => {
			const tag = await this.call(id, scope, prepareSource, [key ? 'focus' : 'type'], signal);
			if (key) {
				signal.throwIfAborted();
				try { await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key }, scope, signal); }
				finally { const { text: _text, unmodifiedText: _unmodified, commands: _commands, ...up } = key;
					await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...up }, scope); }
			} else if (humanize) {
				for (const character of characters) {
					await this.call(id, scope, `function() { if (!this.isConnected || this.getRootNode().activeElement!==this || this.readOnly || this.matches(':disabled')) throw new Error('The typing target lost focus, detached or became unavailable.'); }`, [], signal);
					// Chromium's keyboard-event text buffer holds at most four UTF-16 units.
					// Insert longer graphemes atomically, between their native key events.
					const key = character === '\n' ? 'Enter' : Array.from(character).length === 1 ? character : 'Unidentified';
					const down = { key, ...(character.length <= 4 ? { text: character === '\n' ? '\r' : character } : {}) };
					signal.throwIfAborted();
					try {
						await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...down }, scope, signal);
						if (character.length > 4) { await this.send('Input.insertText', { text: character }, scope, signal); }
					}
					finally { await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: down.key }, scope); }
					await this.pause(/[\s.,!?;:]/u.test(character) ? 65 : 25, /[\s.,!?;:]/u.test(character) ? 120 : 65, signal);
				}
			} else {
				await this.send('Input.insertText', { text: (input as { text: string }).text }, scope, signal);
			}
			// Never echo a value: the focused field can hold a password or OTP.
			return { action: key ? 'press' : 'type', tag };
		}), humanize ? Math.min(55_000, 15_000 + characters.length * 100) : 15_000);
	}
}
