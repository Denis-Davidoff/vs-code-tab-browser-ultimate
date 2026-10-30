/** Serialize only into an opaque-origin iframe; never attach parsed nodes to the chat. */
export function nonceVisualizationDocument(html: string, nonce: string): string {
	if (!nonce) { return html; }
	const parsed = new DOMParser().parseFromString(html, 'text/html');
	for (const element of parsed.querySelectorAll('script,style')) { element.setAttribute('nonce', nonce); }
	// Nonces authorize style elements, not style attributes. Preserve authoring
	// compatibility without relaxing the main chat's inherited style policy.
	const rules: string[] = [];
	let index = 0;
	for (const element of parsed.querySelectorAll<HTMLElement>('[style]')) {
		const name = `visualization-inline-${index++}`;
		rules.push(`.${name}{${element.getAttribute('style')}}`);
		element.removeAttribute('style'); element.classList.add(name);
	}
	if (rules.length) {
		const styles = parsed.createElement('style'); styles.setAttribute('nonce', nonce);
		styles.textContent = rules.join('\n'); parsed.head.append(styles);
	}
	return '<!doctype html>' + parsed.documentElement.outerHTML;
}
