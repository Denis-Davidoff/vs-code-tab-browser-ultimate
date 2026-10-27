/*
 * What xterm needs from the page's Content-Security-Policy.
 *
 * The chat view's policy has no `'unsafe-inline'`, and xterm 6 creates inline
 * styles at runtime in two ways: `<style>` elements (the scrollbar's colours, the
 * DOM renderer's cell sizing and its whole ANSI palette) and
 * `setAttribute('style', …)` (24-bit colours). It has no option for a nonce, so
 * both are fixed from outside, once, when the first terminal is made:
 *
 *  - every `<style>` created afterwards carries the script's nonce, which the
 *    policy allows (`style-src 'nonce-…'`). Permanent, not only around `open()`:
 *    the dimensions element is made lazily, on the first resize;
 *  - `setAttribute('style', v)` becomes `style.cssText = v`, which the policy
 *    allows (only the attribute form is blocked).
 *
 * Measured in headless Chrome under the exact policy: all three style sheets
 * apply and the 16 colours and a truecolor span read back right. The chat's own
 * code creates no `<style>` and sets no `style` attribute (both were blocked), so
 * nothing relied on the old behaviour.
 *
 * Takes the two objects to patch so a test can hand it plain ones.
 */

export interface CspTargets {
	readonly document: { createElement: (tag: string, options?: ElementCreationOptions) => unknown };
	readonly elementPrototype: { setAttribute: (name: string, value: string) => void };
}

let installed = false;

export function installTerminalCsp(nonce: string | undefined, targets: CspTargets = { document, elementPrototype: Element.prototype }): void {
	if (installed) { return; }
	installed = true;
	const { document: doc, elementPrototype } = targets;
	const createElement = doc.createElement;
	doc.createElement = function (this: unknown, tag: string, options?: ElementCreationOptions): unknown {
		const node = createElement.call(this, tag, options) as { setAttribute(name: string, value: string): void };
		if (nonce && String(tag).toLowerCase() === 'style') {
			node.setAttribute('nonce', nonce);
		}
		return node;
	};
	const setAttribute = elementPrototype.setAttribute;
	elementPrototype.setAttribute = function (this: { style?: { cssText: string } }, name: string, value: string): void {
		if (typeof name === 'string' && name.toLowerCase() === 'style' && this.style) {
			this.style.cssText = value;
			return;
		}
		setAttribute.call(this, name, value);
	};
}

/** For tests: lets a second install run against fresh objects. */
export function resetTerminalCspForTests(): void {
	installed = false;
}
