/**
 * A themed search box for the chat's cards (JSON, tables): a magnifier, the
 * input and a clear button shown only while it holds text. A bare
 * `<input type="search">` takes the system's white field here, since nothing
 * in chat.css styles it, and its own cancel button ignores the theme.
 */
export interface SearchField { readonly field: HTMLElement; readonly input: HTMLInputElement }

export function searchField(placeholder: string, label: string, onChange: () => void): SearchField {
	const glyph = (name: string) => { const icon = document.createElement('span'); icon.className = `codicon codicon-${name}`; icon.setAttribute('aria-hidden', 'true'); return icon; };
	const field = document.createElement('div'); field.className = 'inline-search';
	const icon = glyph('search'); icon.classList.add('inline-search-icon');
	const input = document.createElement('input');
	input.type = 'search'; input.className = 'inline-search-input'; input.placeholder = placeholder;
	input.spellcheck = false; input.autocomplete = 'off'; input.setAttribute('aria-label', label);
	const clear = document.createElement('button');
	clear.type = 'button'; clear.className = 'inline-search-clear'; clear.title = 'Clear search'; clear.setAttribute('aria-label', 'Clear search');
	// Escape clears from the keyboard, so the button stays out of the tab order.
	clear.tabIndex = -1; clear.append(glyph('close'));
	const reset = () => { if (!input.value) { return; } input.value = ''; onChange(); };
	// A press must not take focus out of the box: the caret stays where typing goes on.
	clear.addEventListener('mousedown', event => event.preventDefault());
	clear.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); reset(); input.focus(); });
	input.addEventListener('input', onChange);
	// Escape with text clears it and goes no further; with an empty box it is left to whatever holds the card.
	input.addEventListener('keydown', event => { if (event.key === 'Escape' && input.value && !event.isComposing) { event.preventDefault(); event.stopPropagation(); reset(); } });
	field.append(icon, input, clear);
	return { field, input };
}
