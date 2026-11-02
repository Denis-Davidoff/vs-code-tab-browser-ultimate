import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transpileModule, ScriptTarget } from 'typescript';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ShellOutput } from './shellOutput.ts';
import type { ToolEntry } from './chatProtocol.ts';

const entry = (output: string, status: ToolEntry['status'] = 'running'): ToolEntry => ({
	kind: 'tool', id: 'shell', tool: 'command', name: 'Bash', input: 'npm run dev', output, status, startedAt: 1,
});

test('the output terminal replays once, appends new output, and reports completion once', () => {
	const view = new ShellOutput();
	const first = view.update(entry('Ready\n'));
	assert.match(first, /read only/);
	assert.match(first, /\$ npm run dev/);
	assert.ok(first.endsWith('Ready\r\n'));
	assert.equal(view.update(entry('Ready\n')), '');
	assert.equal(view.update(entry('Ready\nRequest\n')), 'Request\r\n');
	assert.equal(view.update({ ...entry('Ready\nRequest\n', 'done'), exitCode: 0 }), '\r\n[done · exit 0]\r\n');
	assert.equal(view.update({ ...entry('Ready\nRequest\n', 'done'), exitCode: 0 }), '');
});

test('replacement or truncated CLI output redraws instead of repeating the whole buffer on every update', () => {
	const view = new ShellOutput();
	view.update(entry('old output'));
	const replacement = view.update(entry('new tail'));
	assert.ok(replacement.startsWith('\x1b[2J\x1b[H'));
	assert.ok(replacement.endsWith('new tail'));
	assert.equal(view.update(entry('new tail!')), '!');
	assert.equal(view.update(undefined), '\r\n[This command is no longer available in the open conversation.]\r\n');
	assert.equal(view.update(undefined), '');
});


test('the real host action reuses its viewer, streams the same command, and closing the viewer leaves the command running', () => {
	const source = readFileSync('src/chat/chatView.ts', 'utf8');
	const text = /private _showShellOutput\([\s\S]*?\n\t\}/.exec(source)![0].replace('private _showShellOutput', 'function show');
	const terminals: { pty: { open(): void; close(): void; handleInput?: unknown }; shows: number; show(): void }[] = [];
	const written: string[] = [];
	class Emitter {
		event() {}
		fire(value: string) { written.push(value); }
		dispose() {}
	}
	const show = runInNewContext(transpileModule(`${text}\nshow;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, {
		ShellOutput, vscode: { EventEmitter: Emitter, window: {
			createTerminal(options: { pty: (typeof terminals)[number]['pty'] }) {
				const terminal = { pty: options.pty, shows: 0, show() { if (!this.shows++) { this.pty.open(); } } };
				terminals.push(terminal); return terminal;
			},
			onDidCloseTerminal() { return { dispose() {} }; },
		} },
	});
	const command = entry('Ready\n');
	const tab = { chat: { id: 'chat', entries: [command] } };
	const host = { _tabs: [tab], _shellOutputViews: new Map<string, { refresh(): void }>() };
	show.call(host, 'other-chat', command.id);
	assert.equal(terminals.length, 0);
	show.call(host, 'chat', command.id);
	show.call(host, 'chat', command.id);
	assert.equal(terminals.length, 1);
	assert.equal(terminals[0].shows, 2);
	assert.equal(terminals[0].pty.handleInput, undefined);
	assert.equal(written.length, 1);
	command.output += 'Request\n';
	for (const view of host._shellOutputViews.values()) { view.refresh(); }
	assert.equal(written.at(-1), 'Request\r\n');
	terminals[0].pty.close();
	assert.equal(host._shellOutputViews.size, 0);
	assert.equal(command.status, 'running');
});


test('Claude process exit settles native shell tasks even when the parent turn has already ended', () => {
	const source = readFileSync('src/chat/claudeAgent.ts', 'utf8');
	const method = (name: string) => new RegExp(`private ${name}\\([\\s\\S]*?\\n\\t\\}`).exec(source)![0].replace(`private ${name}`, `function ${name}`);
	const emitted: unknown[] = [];
	const context = {
		_agents: new Set<string>(), _shellTasks: new Map<string, boolean>(), _agentTools: new Set<string>(),
		_toldWaiting: false, _pendingTurns: 0, _disposed: false, _onEvent: { fire: (event: unknown) => emitted.push(event) },
	};
	const handle = runInNewContext(transpileModule(`${method('_handle')}\n_handle;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText);
	const end = runInNewContext(transpileModule(`${method('_endAgents')}\n_endAgents;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText);
	handle.call(context, { type: 'toolUpdate', id: 'background', update: { shell: { taskId: 'task', background: true } } });
	handle.call(context, { type: 'toolUpdate', id: 'background', update: { status: 'done', output: 'Task launched' } });
	handle.call(context, { type: 'toolUpdate', id: 'finished', update: { shell: { taskId: 'done', background: true } } });
	handle.call(context, { type: 'toolUpdate', id: 'finished', update: { status: 'done', agent: {} } });
	assert.equal(context._agents.size, 0);
	assert.equal(context._shellTasks.size, 1);
	emitted.length = 0;
	end.call(context);
	assert.equal(JSON.stringify(emitted), JSON.stringify([{ type: 'toolUpdate', id: 'background', update: { status: 'stopped', shell: { background: false } } }]));
	assert.equal(context._shellTasks.size, 0);
});
