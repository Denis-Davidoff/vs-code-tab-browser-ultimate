import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import type { HostToView, OpenRouterModelConfig, ViewToHost } from '../src/chat/chatProtocol';
import {
	localEndpoint, openrouterEndpoint, openrouterKeySecret, openrouterModelsKey, readOpenRouterModels,
	searchOpenRouterCatalog, validateOpenRouterModels,
} from '../src/chat/openrouterProtocol.ts';
import { describePrice, formatContext, modelFromCatalogItem, modelSummary } from '../src/chat/openrouterView.ts';

class Element {
	children: (Element | string)[] = [];
	dataset: Record<string, string> = {};
	attributes: Record<string, string> = {};
	events: Record<string, (event: { key: string; preventDefault(): void }) => void> = {};
	textContent = '';
	value = '';
	className = '';
	title = '';
	hidden = false;
	disabled = false;
	classList = { toggle() {} };
	readonly tag: string;
	constructor(tag: string) { this.tag = tag; }
	append(...children: (Element | string)[]) { this.children.push(...children); }
	replaceChildren(...children: (Element | string)[]) { this.children = children; }
	setAttribute(name: string, value: string) { this.attributes[name] = value; }
	addEventListener(name: string, handler: Element['events'][string]) { this.events[name] = handler; }
	fire(name: string) { this.events[name]?.({ key: 'Enter', preventDefault() {} }); }
	all(): Element[] { return [this, ...this.children.flatMap(child => child instanceof Element ? child.all() : [])]; }
}

type Message = Extract<ViewToHost, { type: 'openrouter' }>;
type Reply = Extract<HostToView, { type: 'openrouter' }>;
const compile = (code: string) => transpileModule(code, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;

function harness() {
	const source = readFileSync('preview-src/chat.ts', 'utf8');
	const section = source.match(/function createOpenRouterSettings\(\): HTMLElement \{[\s\S]*?\n\}/)?.[0];
	const method = readFileSync('src/chat/chatView.ts', 'utf8').match(/private async _openrouterAction\([\s\S]*?\n\t\}/)?.[0];
	assert.ok(section && method);
	const posts: Message[] = [];
	const fetched: string[] = [];
	let models: readonly OpenRouterModelConfig[] = [];
	const scope = {
		openrouterData: undefined as Reply | undefined, openrouterRender: undefined as (() => void) | undefined,
		post: (message: Message) => posts.push(message),
		el: (tag: string, props = {}, ...children: (Element | string)[]) => {
			const node = Object.assign(new Element(tag), props);
			if ('class' in props) { node.className = String(props.class); }
			if ('text' in props) { node.textContent = String(props.text); }
			node.append(...children); return node;
		},
		button: (children: (Element | string)[], props = {}) => { const node = Object.assign(new Element('button'), props); node.append(...children); return node; },
		icon: () => new Element('i'), modelSummary, formatContext, describePrice, modelFromCatalogItem,
	};
	const context = createContext(scope);
	const panel = runInContext(compile(`${section}\ncreateOpenRouterSettings();`), context) as Element;
	const host = runInNewContext(compile(`({ ${method.replace('private ', '')} })`), {
		localEndpoint, openrouterEndpoint, openrouterKeySecret, openrouterModelsKey, readOpenRouterModels, searchOpenRouterCatalog, validateOpenRouterModels,
		vscode: { workspace: { getConfiguration: () => ({ inspect: () => undefined }) }, l10n: { t: (text: string) => text } },
	}) as { _openrouterAction(this: unknown, message: Message): Promise<void> };
	const replies: Reply[] = [];
	const provider = {
		_context: { secrets: { get: async () => undefined }, globalState: { get: () => models, update: async (_key: string, value: OpenRouterModelConfig[]) => { models = value; } } },
		_registry: { redetect: async () => undefined },
		_openrouterEntries: async (endpoint: string) => { fetched.push(endpoint); return [{ id: 'local/model', name: 'Local model', tools: false, images: false, reasoning: false }]; },
		_postMessage: (reply: Reply) => { replies.push(reply); },
	};
	const deliver = (reply: Reply) => { scope.openrouterData = reply; scope.openrouterRender!(); };
	const flush = async () => {
		while (posts.length) { await host._openrouterAction.call(provider, posts.shift()!); deliver(replies.at(-1)!); }
	};
	const sourceSelect = panel.all().find(node => node.attributes['aria-label'] === 'Where to list models from')!;
	const custom = panel.all().find(node => node.attributes['aria-label'] === 'Local server address')!;
	const info = panel.all().find(node => node.className.includes('openrouter-catalog-info'))!;
	const catalog = panel.all().find(node => node.className.includes('openrouter-catalog'))!;
	const add = () => catalog.all().find(node => node.tag === 'button' && node.children.includes('Add'))!.fire('click');
	const ask = (url: string) => { sourceSelect.value = 'custom'; sourceSelect.fire('change'); custom.value = url; custom.fire('keydown'); };
	return { panel, fetched, flush, ask, info, add, deliver, replies, models: () => models, sourceSelect, custom };
}

for (const address of ['http://LOCALHOST:8080/v1', 'http://localhost:80/v1', 'http://127.1:8080/v1', 'http://localhost:8080/v1/']) {
	test(`custom catalogue renders and adds a model from ${address}`, async () => {
		const ui = harness(); await ui.flush();
		ui.ask(address); await ui.flush();
		assert.equal(ui.info.textContent, '1 model.');
		const canonical = localEndpoint(address); assert.ok('url' in canonical);
		assert.equal(ui.fetched.at(-1), canonical.url);
		ui.add(); await ui.flush();
		assert.equal(ui.models()[0].endpoint, canonical.url, 'Add uses the validated server rather than the original address');
	});
}

test('an invalid custom address displays the host refusal without fetching or adding models', async () => {
	const ui = harness(); await ui.flush();
	const before = ui.fetched.length;
	ui.ask('http://192.168.1.5:8080/v1'); await ui.flush();
	assert.match(ui.info.textContent, /Could not load the catalogue:.*must be on this computer/);
	assert.equal(ui.fetched.length, before);
	assert.equal(ui.models().length, 0);
});

test('a late reply from another server is ignored and Add follows a changed server with identical model ids', async () => {
	const ui = harness(); await ui.flush();
	ui.ask('http://localhost:8080/v1'); await ui.flush();
	const old = ui.replies.at(-1)!;
	ui.custom.value = 'http://localhost:8081/v1';
	ui.panel.all().find(node => node.title === 'Fetch the catalogue again')!.fire('click');
	await ui.flush();
	assert.equal(ui.info.textContent, '1 model.');
	ui.deliver({ ...old, catalog: { ...old.catalog!, error: 'stale error' } });
	assert.equal(ui.info.textContent, '1 model.', 'a reply for the previous server cannot replace the current result');
	ui.add(); await ui.flush();
	assert.equal(ui.models()[0].endpoint, 'http://localhost:8081/v1');
});
