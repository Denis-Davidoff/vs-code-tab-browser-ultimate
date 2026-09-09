/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Checks the parts of package.json that nothing else validates.
 *
 * None of this produces a compile error: a menu item pointing at a command that
 * does not exist, a command with no activation event, an icon path with a typo,
 * an icon file nobody references — every one of them is silent, and shows up as
 * a button that is missing or does nothing. Run with `npm run check-manifest`.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const contributes = manifest.contributes;

const problems = [];
const commands = new Map(contributes.commands.map(c => [c.command, c]));
const submenus = new Map((contributes.submenus ?? []).map(s => [s.id, s]));

/* every menu item must reference something that exists */
for (const [menu, items] of Object.entries(contributes.menus ?? {})) {
	for (const item of items) {
		if (item.command && !commands.has(item.command)) {
			problems.push(`${menu}: unknown command ${item.command}`);
		}
		if (item.submenu && !submenus.has(item.submenu)) {
			problems.push(`${menu}: unknown submenu ${item.submenu}`);
		}
	}
}

/* a submenu with no items renders as an empty dropdown */
for (const id of submenus.keys()) {
	if (!contributes.menus?.[id]?.length) {
		problems.push(`submenu ${id} has no items`);
	}
}

/*
 * Commands need an explicit activation event: `contributes.menus` renders before
 * the extension activates, so without one the button silently does nothing until
 * something else wakes the extension.
 */
const activation = new Set(manifest.activationEvents ?? []);
for (const id of commands.keys()) {
	if (!activation.has(`onCommand:${id}`)) {
		problems.push(`command ${id} has no onCommand activation event`);
	}
}

/* icon paths must resolve, and every icon file must be referenced */
const referenced = new Set();
const collectIcon = (icon, owner) => {
	if (!icon || typeof icon === 'string') {
		return; // `$(codicon)` or absent
	}
	for (const path of Object.values(icon)) {
		referenced.add(path);
		if (!existsSync(join(root, path))) {
			problems.push(`${owner}: icon not found — ${path}`);
		}
	}
};
for (const command of commands.values()) {
	collectIcon(command.icon, command.command);
}
for (const submenu of submenus.values()) {
	collectIcon(submenu.icon, submenu.id);
}
for (const file of readdirSync(join(root, 'media', 'icons'))) {
	const path = `media/icons/${file}`;
	if (!referenced.has(path)) {
		problems.push(`orphaned icon file — ${path}`);
	}
}

/*
 * The element commands encode two things in one icon: the centre dot is *what*
 * is copied, the ring is *where it goes*. So the same kind must share a dot
 * across destinations, and the same destination must share a ring across kinds —
 * which, given the file naming, reduces to the stems lining up.
 */
const grid = {
	element: ['aiBrowser.copyElement', 'aiBrowser.addElementToClaudeCode', 'aiBrowser.addElementToCodex'],
	cssPath: ['aiBrowser.copyElementCssPath', 'aiBrowser.addCssPathToClaudeCode', 'aiBrowser.addCssPathToCodex'],
	xpath: ['aiBrowser.copyElementXPath', 'aiBrowser.addXPathToClaudeCode', 'aiBrowser.addXPathToCodex'],
};
const stem = id => {
	const icon = commands.get(id)?.icon;
	const match = /crosshair-(\w+?)(?:-(claude|codex))?-dark\.svg$/.exec(icon?.dark ?? '');
	return match ? { dot: match[1], dest: match[2] ?? 'copy' } : undefined;
};
for (const [kind, ids] of Object.entries(grid)) {
	const stems = ids.map(stem);
	if (stems.some(s => !s)) {
		problems.push(`${kind}: a command has no crosshair icon`);
		continue;
	}
	if (new Set(stems.map(s => s.dot)).size !== 1) {
		problems.push(`${kind}: the centre dot differs across destinations`);
	}
	if (new Set(stems.map(s => s.dest)).size !== 3) {
		problems.push(`${kind}: destinations are not copy/claude/codex`);
	}
}

/* exactly one primary button may match at a time */
const primaries = (contributes.menus['editor/title'] ?? []).filter(m => m.group === 'navigation@2');
const actions = primaries.map(m => /lastElementAction == '([^']+)'/.exec(m.when ?? '')?.[1]);
if (actions.some(a => !a)) {
	problems.push('a navigation@2 button has no lastElementAction condition');
}
if (new Set(actions).size !== actions.length) {
	problems.push('two primary buttons share a lastElementAction value');
}

if (problems.length) {
	console.error(`check-manifest: ${problems.length} problem(s)`);
	for (const problem of problems) {
		console.error(`  - ${problem}`);
	}
	process.exit(1);
}

console.log(`check-manifest: ok — ${commands.size} commands, ${submenus.size} submenu(s), `
	+ `${referenced.size} icon files, ${actions.length} primary buttons`);
