import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { toolGroup, toolHints, toolIcons } from './toolMeta.ts';

const toolFiles = ['mcpServer.ts', 'chatTools.ts', 'terminalTools.ts'];

/** Every tool name the tool files register, the two templated families expanded. */
function registeredTools(): Set<string> {
	const names = new Set<string>();
	for (const file of toolFiles) {
		const text = readFileSync(`src/mcp/${file}`, 'utf8');
		for (const m of text.matchAll(/\bname: '((?:browser|editor|chat|terminal|skill)_[a-z_]+)'/g)) {
			names.add(m[1]);
		}
	}
	for (const action of ['pause', 'resume', 'stop', 'status']) {
		names.add(`browser_recording_${action}`);
	}
	for (const kind of ['file', 'table', 'audio', 'video', 'sources']) {
		names.add(`chat_present_${kind}`);
	}
	return names;
}

test('every registered tool has hints, and every hint names a registered tool', () => {
	const registered = registeredTools();
	assert.ok(registered.size > 60, `only ${registered.size} tools found; the pattern no longer matches the files`);
	const missing = [...registered].filter(name => !(name in toolHints));
	assert.deepStrictEqual(missing, [], 'tools with no entry in toolHints');
	const stale = Object.keys(toolHints).filter(name => !registered.has(name));
	assert.deepStrictEqual(stale, [], 'toolHints entries for tools that do not exist');
});

test('a read-only hint is never destructive, and page actions are open-world', () => {
	for (const [name, h] of Object.entries(toolHints)) {
		assert.ok(!(h.readOnlyHint && h.destructiveHint), `${name} is read-only and destructive`);
	}
	for (const name of ['browser_click', 'browser_press', 'browser_type', 'terminal_send', 'terminal_key']) {
		assert.strictEqual(toolHints[name].readOnlyHint, false, name);
		assert.strictEqual(toolHints[name].destructiveHint, true, name);
	}
	assert.strictEqual(toolHints.browser_close_tab.destructiveHint, true);
});

test('icons are a data URI per group, cached', () => {
	assert.strictEqual(toolGroup('editor_context'), 'editor');
	assert.strictEqual(toolGroup('skill_get'), 'skill');
	assert.strictEqual(toolGroup('browser_click'), 'browser');
	const [icon] = toolIcons('chat_state');
	assert.match(icon.src, /^data:image\/svg\+xml;base64,/);
	assert.strictEqual(toolIcons('chat_alert'), toolIcons('chat_state'));
	assert.notStrictEqual(toolIcons('browser_click'), toolIcons('chat_state'));
});
