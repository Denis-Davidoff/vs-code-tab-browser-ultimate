import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transpileModule, ScriptTarget } from 'typescript';
import { aiFeatures, readFeatureAiSettings, type FeatureAiSettings } from '../src/chat/featureAi.ts';

// Exercise the actual handlers with delayed host replies; no model or VS Code process is started.
class Element {
	children: (Element | string)[] = [];
	dataset: Record<string, string> = {};
	events: Record<string, () => void> = {};
	textContent = '';
	value = '';
	disabled = false;
	classList = { add() {} };
	readonly tag: string;
	constructor(tag: string) { this.tag = tag; }
	append(...nodes: (Element | string)[]) { this.children.push(...nodes); }
	replaceChildren(...nodes: (Element | string)[]) { this.children = nodes; }
	setAttribute() {}
	focus() {}
	addEventListener(event: string, handler: () => void) { this.events[event] = handler; }
	querySelectorAll(tag: string): Element[] {
		return this.children.flatMap(child => child instanceof Element ? [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)] : []);
	}
}
const source = readFileSync('preview-src/chat.ts', 'utf8');
function harness() {
	const panel = new Element('div');
	const save = new Element('button');
	const status = new Element('div');
	const posts: { settings: FeatureAiSettings }[] = [];
	const scope = {
		state: { featureAi: readFeatureAiSettings(undefined), agents: [] },
		featureSettingsPanel: panel, featureSettingsSave: save, featureSettingsStatus: status,
		featureSettingsSaving: false, featureSettingsDraft: readFeatureAiSettings(undefined),
		readFeatureAiSettings, aiFeatures, input: { focus() {} }, closePopups() {},
		el(tag: string, _props: unknown, ...children: (Element | string)[]) { const node = new Element(tag); node.append(...children); return node; },
		button: () => new Element('button'), icon: () => new Element('i'),
		post(message: { settings: FeatureAiSettings }) { posts.push(message); }, message: {} as { settings?: FeatureAiSettings; error?: string },
	};
	const context = createContext(scope);
	const execute = (code: string) => runInContext(transpileModule(code, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context);
	const open = source.match(/function openFeatureSettings\(\): void \{[\s\S]*?\n\}/)?.[0];
	const listener = source.match(/featureSettingsSave.addEventListener\('click', \(\) => \{[\s\S]*?\n\}\);/)?.[0];
	const acknowledgement = source.split("case 'featureAiSaved':")[1]?.split('return;')[0];
	assert.ok(open && listener && acknowledgement);
	execute(open + '\n' + listener);
	return { scope, panel, save, status, posts, open: () => execute('openFeatureSettings();'),
		ack(settings?: FeatureAiSettings, error?: string) { scope.message = { settings, error }; execute(acknowledgement); } };
}

for (const failed of [false, true]) {
	test(`reopening during a ${failed ? 'failed' : 'successful'} save preserves choices and the next edit`, () => {
		const ui = harness();
		ui.open();
		const proposed = readFeatureAiSettings({ commitMessage: { agent: 'claude', effort: 'maximum' } });
		ui.scope.featureSettingsDraft = proposed;
		ui.save.events.click();
		ui.open(); // The old host state is still current while storage is pending.
		let fields = ui.panel.querySelectorAll('select');
		assert.equal(fields[0].value, 'claude');
		assert.equal(fields[1].value, 'maximum');
		assert.ok(fields.every(field => field.disabled));
		assert.equal(ui.status.textContent, 'Saving…');
		ui.ack(failed ? undefined : proposed, failed ? 'Storage unavailable' : undefined);
		fields = ui.panel.querySelectorAll('select');
		assert.equal(fields[0].value, 'claude');
		assert.equal(fields[1].value, 'maximum');
		assert.ok(fields.every(field => !field.disabled));
		assert.match(ui.status.textContent, failed ? /Storage unavailable/ : /Settings saved/);
		fields[2].value = 'codex';
		fields[2].events.change();
		ui.save.events.click();
		assert.deepEqual(ui.posts[1].settings.commitMessage, proposed.commitMessage);
		assert.equal(ui.posts[1].settings.branchName.agent, 'codex');
	});
}

test('save confirmation supplies authoritative choices without waiting for a state update', () => {
	const ui = harness();
	ui.open();
	ui.save.events.click();
	const saved = readFeatureAiSettings({ chatTitle: { agent: 'codex', effort: 'medium' } });
	ui.ack(saved);
	const fields = ui.panel.querySelectorAll('select');
	assert.equal(fields[4].value, 'codex');
	assert.equal(fields[5].value, 'medium');
	assert.deepEqual(ui.scope.featureSettingsDraft, saved);
});
