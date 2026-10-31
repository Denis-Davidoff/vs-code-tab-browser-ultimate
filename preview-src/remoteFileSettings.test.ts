import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { connectionPermissionGroups, readConnectionPermissions } from '../src/chat/core/commands.ts';

test('Permissions shows saved access separately for Chrome and the website and posts the chosen level', () => {
	const source = readFileSync('preview-src/chat.ts', 'utf8');
	const permissionFn = /function createConnectionPermissionSettings\([\s\S]*?\n\}/.exec(source)![0];
	const fn = /function createRemoteTerminalSettings\([\s\S]*?\n\}/.exec(source)![0];
	const nodes: any[] = [], posts: any[] = [];
	const context: any = {
		remoteTerminalData: undefined, remoteTerminalRender: undefined, connectionPermissionRender: undefined,
		state: undefined, connectionPermissionGroups, readConnectionPermissions,
		post: (message: any) => posts.push(message),
		el(tag: string, props: any = {}, ...children: any[]) {
			const node = { tag, ...props, children, isConnected: true, attrs: {} as any, events: {} as any,
				append(...items: any[]) { this.children.push(...items); },
				setAttribute(key: string, value: string) { this.attrs[key] = value; },
				addEventListener(key: string, handler: () => void) { this.events[key] = handler; },
			};
			nodes.push(node); return node;
		},
	};
	runInNewContext(transpileModule(`${permissionFn}\n${fn}\ncreateRemoteTerminalSettings();`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context);
	assert.equal(posts[0].action, 'load');
	const chrome = nodes.find(n => n.attrs['aria-label'] === 'Chrome project file access');
	const website = nodes.find(n => n.attrs['aria-label'] === 'Website project file access');
	assert.equal(chrome.disabled, true);
	context.remoteTerminalData = { remoteTerminal: false, shell: false, agent: false, files: { chrome: 'attach', exchange: 'off' } };
	context.remoteTerminalRender();
	assert.equal(chrome.value, 'attach');
	assert.equal(website.value, 'off');
	assert.equal(chrome.disabled, false);
	website.value = 'read'; website.events.change();
	assert.equal(JSON.stringify(posts.at(-1)), JSON.stringify({ type: 'remoteTerminalSettings', action: 'setFiles', surface: 'exchange', value: 'read' }));
	assert.equal(chrome.value, 'attach');
	const permissionBoxes = nodes.filter(n => n.tag === 'input' && n.type === 'checkbox');
	assert.equal(permissionBoxes[0].checked, true);
	permissionBoxes[0].checked = false; permissionBoxes[0].events.change();
	assert.equal(JSON.stringify(posts.at(-1)), JSON.stringify({ type: 'setConnectionPermission', surface: 'chrome', group: 'conversations', allowed: false }));
});
