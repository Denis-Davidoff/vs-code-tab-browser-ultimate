import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transpileModule, ScriptTarget } from 'typescript';
import { aiFeatures, defaultFeaturePrompts, featurePromptLimit, readFeatureAiSettings, readTitleRefresh, titleRefreshLimits, type FeatureAiSettings } from '../src/chat/featureAi.ts';
import { maxRecordingSeconds, minRecordingSeconds, recordingProfiles, readRecordingQuality, readRecordingSeconds, type RecordingQuality } from '../src/browser/recordingQuality.ts';

// Exercise the actual handlers with delayed host replies; no model or VS Code process is started.
class Element {
	children: (Element | string)[] = [];
	dataset: Record<string, string> = {};
	events: Record<string, () => void> = {};
	textContent = '';
	value = '';
	id = '';
	className = '';
	hidden = false;
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
		const matches = (child: Element) => tag.split(',').some(raw => {
            const selector = raw.trim();
            return selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1))
                : selector === 'textarea[data-feature]' ? child.tag === 'textarea' && !!child.dataset.feature : child.tag === selector;
        });
        return this.children.flatMap(child => child instanceof Element ? [...(matches(child) ? [child] : []), ...child.querySelectorAll(tag)] : []);
	}
}
const source = readFileSync('preview-src/chat.ts', 'utf8');
function harness() {
	const panel = new Element('div');
	const save = new Element('button');
	const status = new Element('div');
	const posts: { settings: FeatureAiSettings; recordingQuality?: RecordingQuality }[] = [];
	const scope = {
		state: { featureAi: readFeatureAiSettings(undefined), recordingQuality: 'high' as RecordingQuality, agents: [] },
		featureSettingsPanel: panel, featureSettingsSave: save, featureSettingsStatus: status,
		featureSettingsSaving: false, featureSettingsDraft: readFeatureAiSettings(undefined),
		videoQualityDraft: 'high' as RecordingQuality, videoSecondsDraft: 300 as number | undefined, recordingProfiles, readRecordingQuality,
		readRecordingSeconds, minRecordingSeconds, maxRecordingSeconds,
		readFeatureAiSettings, readTitleRefresh, titleRefreshLimits, aiFeatures, defaultFeaturePrompts, featurePromptLimit, createAppearanceSettings: () => new Element('div'), createTemporarySettings: () => new Element('div'), createServerSettings: () => new Element('div'), createOpenRouterSettings: () => new Element('div'), createRemoteTerminalSettings: () => new Element('div'), input: { focus() {} }, closePopups() {},
		el(tag: string, props: { class?: string } = {}, ...children: (Element | string)[]) { const node = new Element(tag); node.className = props.class ?? ''; node.append(...children); return node; },
		button: (children: (Element | string)[], props: { class?: string } = {}) => { const node = new Element('button'); node.className = props.class ?? ''; node.append(...children); return node; }, icon: () => new Element('i'),
		gate: () => ({ s: 'on' }),
		showScreenOverlay() {},
		setTimeout: (f: () => void) => { f(); return undefined; }, clearTimeout() {},
		featureSettingsTimer: undefined, featureSettingsAgain: false,
		post(message: { settings: FeatureAiSettings; recordingQuality?: RecordingQuality }) { posts.push(message); }, message: {} as { settings?: FeatureAiSettings; recordingQuality?: RecordingQuality; error?: string },
	};
	const context = createContext(scope);
	const execute = (code: string) => runInContext(transpileModule(code, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, context);
	const open = source.match(/function openFeatureSettings\([^)]*\): void \{[\s\S]*?\n\}/)?.[0];
	const listener = source.match(/function scheduleFeatureSave[\s\S]*?function saveFeatureSettings\(\)[\s\S]*?\n\}/)?.[0]
		?.replace(/^let .*$/gm, '');
	const acknowledgement = source.split("case 'featureAiSaved':")[1]?.split("case 'openSleep':")[0];
	assert.ok(open && listener && acknowledgement);
	const lengthFields = source.match(/function lengthFields\([\s\S]*?\n\}/)?.[0];
	assert.ok(lengthFields);
	execute(lengthFields + '\n' + open + '\n' + listener);
	return { scope, panel, save, status, posts, open: () => execute('openFeatureSettings();'),
		ack(settings?: FeatureAiSettings, error?: string, recordingQuality?: RecordingQuality) { scope.message = { settings, error, recordingQuality }; execute(`(() => {${acknowledgement}})()`); } };
}

for (const failed of [false, true]) {
	test(`a choice saves itself, and a ${failed ? 'failed' : 'successful'} save says so`, () => {
		const ui = harness();
		ui.open();
		const fields = ui.panel.querySelectorAll('select');
		fields[0].value = 'claude'; fields[0].events.change();
		assert.equal(ui.posts.length, 1);
		assert.equal(ui.posts[0].settings.commitMessage.agent, 'claude');
		assert.equal(ui.status.textContent, 'Saving…');
		assert.ok(fields.every(field => !field.disabled), 'nothing is locked while it saves');
		fields[2].value = 'codex'; fields[2].events.change(); // while the first is on its way
		assert.equal(ui.posts.length, 1);
		ui.ack(failed ? undefined : ui.posts[0].settings, failed ? 'Storage unavailable' : undefined);
		assert.equal(ui.posts.length, 2, 'the change made meanwhile goes next');
		assert.equal(ui.posts[1].settings.commitMessage.agent, 'claude');
		assert.equal(ui.posts[1].settings.branchName.agent, 'codex');
		ui.ack(failed ? undefined : ui.posts[1].settings, failed ? 'Storage unavailable' : undefined);
		assert.match(ui.status.textContent, failed ? /Storage unavailable/ : /Saved/);
	});
}

test('there is no Save button on any tab', () => {
	const ui = harness(); ui.open();
	ui.panel.querySelectorAll('button').find(button => button.id === 'appearance-tab')!.events.click();
	assert.equal(ui.status.hidden, true);
	ui.panel.querySelectorAll('button').find(button => button.id === 'feature-ai-tab')!.events.click();
	assert.equal(ui.status.hidden, false);
});

test('video quality saves itself without changing AI choices', () => {
	const ui = harness(); ui.open();
	ui.panel.querySelectorAll('button').find(button => button.id === 'video-quality-tab')!.events.click();
	assert.equal(ui.panel.querySelectorAll('div').find(node => node.id === 'video-quality-content')!.hidden, false);
	const quality = ui.panel.querySelectorAll('select').find(field => field.dataset.field === 'recordingQuality')!;
	assert.equal(quality.value, 'high'); quality.value = 'maximum'; quality.events.change();
	assert.equal(ui.posts[0].recordingQuality, 'maximum');
	assert.deepEqual(ui.posts[0].settings, readFeatureAiSettings(undefined));
});

test('temporary storage tab requests current accounting independently of AI settings saves', () => {
 const ui = harness();
 ui.open();
 const layout = ui.panel.children[1] as Element;
 const tabs = layout.children[0] as Element;
 const temporary = tabs.children[2] as Element;
 // The settings panel's host request is separate from its Save action.
 Object.assign(ui.scope, { temporaryStorageBusy: false, renderTemporaryStorage() {} });
 temporary.events.click();
 assert.deepEqual(JSON.parse(JSON.stringify(ui.posts[0])), { type: 'temporaryStorage', action: 'refresh' });
});


test('custom system prompts save themselves and can be restored independently', () => {
 const ui = harness(); ui.open();
 const fields = ui.panel.querySelectorAll('textarea');
 assert.equal(fields.length, 3);
 assert.equal(fields[0].value, defaultFeaturePrompts.commitMessage);
 fields[0].value = 'Write a concise commit message in Russian.'; fields[0].events.input();
 assert.equal(ui.posts[0].settings.commitMessage.prompt, 'Write a concise commit message in Russian.');
 ui.ack(ui.posts[0].settings);
 assert.equal(fields[0].value, 'Write a concise commit message in Russian.');
 const resets = ui.panel.querySelectorAll('.feature-prompt-reset');
 resets[0].events.click();
 assert.equal(fields[0].value, defaultFeaturePrompts.commitMessage);
 assert.equal(ui.scope.featureSettingsDraft.commitMessage.prompt, undefined);
 assert.equal(fields[1].value, defaultFeaturePrompts.branchName);
});

test('the maximum video length is saved in seconds, and a length out of range is not sent', () => {
	const h = harness();
	h.open();
	const length = (function find(node: Element): Element | undefined {
		for (const child of node.children) {
			if (child instanceof Element) { if (child.dataset.field === 'recordingSeconds') { return child; } const inner = find(child); if (inner) { return inner; } }
		}
		return undefined;
	})(h.panel)!;
	assert.equal(length.value, '5', 'five minutes by default');
	length.value = '0.1'; length.events.input();
	assert.match(h.status.textContent, /10 seconds to 1 hour/);
	assert.equal(h.posts.length, 0, 'nothing out of range is sent');
	length.value = '60'; length.events.input();
	assert.equal((h.posts.at(-1) as { recordingSeconds?: number }).recordingSeconds, 3600);
});
