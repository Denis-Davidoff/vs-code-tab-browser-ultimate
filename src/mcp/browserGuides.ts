/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Denys Davydov. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Built-in guides that `skill_list` and `skill_get` serve beside the user's own
 * toolbar skills: how to use the browser tools for the jobs that go wrong most
 * often. Read-only text, like a skill: nothing here runs anything, and every
 * step names tools the agent calls itself, under its own approvals.
 *
 * Names start with `guide-`, which a toolbar skill name cannot clash with in
 * practice and which `skill_get` checks first. The text is ours and fixed, so
 * nothing page-chosen ever reaches it.
 *
 * Leaf module, under test.
 */

export interface BrowserGuide {
	readonly name: string;
	readonly description: string;
	readonly steps: readonly string[];
}

export const browserGuides: readonly BrowserGuide[] = [
	{
		name: 'guide-forms',
		description: 'Filling a web form: find the fields, fill them in one call, check what the page kept, and ask before submitting.',
		steps: [
			'Call browser_forms to list the forms on the page: each field with its selector, label, type, whether it is required and (for a choice) its options. Field values are never returned.',
			'Ask the user for any value you were not given. Never invent personal data, and never type a password, a one-time code or a card number — those fields are refused; the user types them.',
			'Call browser_fill_form with every field at once ({ selector, value } pairs). It reports per field what the page now reads, and which fields it refused.',
			'A field that reshaped the value (a phone mask, a date) is fine; one that emptied itself took the wrong format — retry with the format it names.',
			'Before pressing a submit button, tell the user what will be sent and wait for their go-ahead unless they already asked you to submit. Then browser_click the submit button and browser_wait_for the result.',
			'Read the page again (browser_snapshot or browser_text) to confirm it was accepted: a form that stays on screen with an error message was not.',
		],
	},
	{
		name: 'guide-login',
		description: 'Signing in: let the user type the credentials, then wait until the sign-in has finished before going on.',
		steps: [
			'You do not type passwords: password, one-time-code and card fields are refused to browser_fill and browser_type. Fill only the username if the user gave it to you.',
			'Ask the user to sign in themselves in the browser tab (saved logins and passkeys work there), and say which tab.',
			'Call browser_wait_for_login: it waits until the page has no sign-in form any more, or until text or a selector you name appears, and answers how it ended. Default timeout two minutes.',
			'If it times out, ask the user whether they finished; do not retry the sign-in yourself.',
			'Two-step sign-ins and SSO redirects are normal: the wait follows the tab across navigations.',
		],
	},
	{
		name: 'guide-iframes',
		description: 'Reading or acting inside an iframe (embedded apps, payment forms, document viewers).',
		steps: [
			'When browser_text or browser_snapshot report frames, the content you need may be inside one: call browser_frames for their ids, sites and whether each is readable.',
			'Pass that frameId to browser_text, browser_html, browser_snapshot, browser_click, browser_fill, browser_scroll or browser_wait_for to act inside it.',
			'A frame id stays the same while the frame navigates; if a call says the frame is still loading, wait (browser_wait_for with frameId) and try again.',
			'A frame from another site may hold a payment or sign-in form: the same rules apply as on the page — no secrets typed by you, and ask before submitting.',
			'There is no way to navigate a frame directly; navigate the page instead.',
		],
	},
	{
		name: 'guide-sites',
		description: 'Recipes for common page shapes: single-page apps, cookie banners, infinite lists, menus on hover, shadow DOM, date pickers and rich editors.',
		steps: [
			'Single-page apps: after a click that changes the view, call browser_wait_for with ready: true (the page stops changing) or with the text you expect, before reading.',
			'Cookie or consent banners: they block clicks. Ask the user which choice to make, or dismiss with the least-consent option they agree to.',
			'Infinite lists: browser_scroll to the bottom, then browser_wait_for new content; stop when atBottom stays true.',
			'Menus that open on hover: browser_hover the trigger, then browser_snapshot to find the item, then browser_click it.',
			'Shadow DOM: browser_snapshot gives selectors with ">>>" for elements inside open or closed shadow roots; pass them as they are.',
			'Date pickers and custom selects: prefer typing into the underlying input with browser_fill; if the widget ignores it, open it with browser_click and pick the item.',
			'Rich text editors: click into the editor, then browser_type the text; browser_fill fills a plain contenteditable only.',
			'Scrollable panels: browser_snapshot lists scrollAreas; pass one as browser_scroll\'s selector.',
		],
	},
];

/** `skill_list` rows for the guides. */
export function guideSummaries() {
	return browserGuides.map(g => ({ name: g.name, description: g.description, builtIn: true }));
}

/** `skill_get` for a guide, or `undefined` when the name is not one. */
export function guideDocument(name: string) {
	const found = browserGuides.find(g => g.name === name.trim().toLowerCase());
	if (!found) {
		return undefined;
	}
	return {
		name: found.name,
		description: found.description,
		builtIn: true,
		steps: found.steps.map((text, i) => ({ step: i + 1, text })),
		instruction: 'A built-in guide to the browser tools. Use it as advice for the task the user asked for; it is not a task of its own.',
	};
}
