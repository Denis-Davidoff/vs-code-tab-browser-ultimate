import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { installTerminalCsp, resetTerminalCspForTests, type CspTargets } from './terminalCsp.ts';

class FakeElement {
	readonly attributes = new Map<string, string>();
	readonly style = { cssText: '' };
	readonly tag: string;
	constructor(tag: string) { this.tag = tag; }
	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
}

function targets(): { readonly doc: { createElement(tag: string): unknown }; readonly proto: { setAttribute(name: string, value: string): void }; readonly cspTargets: CspTargets } {
	const doc = { createElement(tag: string): unknown { return new FakeElement(tag); } };
	const proto = { setAttribute: FakeElement.prototype.setAttribute };
	return { doc, proto, cspTargets: { document: doc, elementPrototype: proto } };
}

test('style elements made afterwards carry the nonce, and nothing else does', () => {
	resetTerminalCspForTests();
	const { doc, cspTargets } = targets();
	installTerminalCsp('abc123', cspTargets);
	const style = doc.createElement('style') as FakeElement;
	assert.equal(style.attributes.get('nonce'), 'abc123');
	assert.equal((doc.createElement('STYLE') as FakeElement).attributes.get('nonce'), 'abc123');
	assert.equal((doc.createElement('div') as FakeElement).attributes.has('nonce'), false);
});

test('setAttribute("style") becomes cssText, which the policy allows; other attributes are untouched', () => {
	resetTerminalCspForTests();
	const { proto, cspTargets } = targets();
	installTerminalCsp('n', cspTargets);
	const el = new FakeElement('span');
	proto.setAttribute.call(el, 'style', 'color: rgb(10, 200, 30)');
	assert.equal(el.style.cssText, 'color: rgb(10, 200, 30)');
	assert.equal(el.attributes.has('style'), false);
	proto.setAttribute.call(el, 'class', 'x');
	assert.equal(el.attributes.get('class'), 'x');
	proto.setAttribute.call(el, 'Style', 'top: 1px');
	assert.equal(el.style.cssText, 'top: 1px');
});

test('with no nonce only the attribute shim is installed, and a second install changes nothing', () => {
	resetTerminalCspForTests();
	const { doc, cspTargets } = targets();
	installTerminalCsp(undefined, cspTargets);
	assert.equal((doc.createElement('style') as FakeElement).attributes.has('nonce'), false);
	const created = doc.createElement;
	installTerminalCsp('late', cspTargets);
	assert.equal(doc.createElement, created, 'installed once');
});
