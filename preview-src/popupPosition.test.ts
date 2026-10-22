import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ScriptTarget } from 'typescript';

function position(top: number, bottom: number, height: number) {
	const source = readFileSync('preview-src/chat.ts', 'utf8');
	const body = /function openAbove\([\s\S]*?\n\}/.exec(source)![0];
	const classList = { add() {}, remove() {} };
	const popup = { style: { top: '', bottom: '', left: '', right: '', maxHeight: '1px' }, classList, getBoundingClientRect: () => ({ height, right: 300 }) };
	const anchor = { classList, getBoundingClientRect: () => ({ top, bottom, left: 100, right: 124 }) };
	const open = runInNewContext(transpileModule(`${body}\nopenAbove;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, {
		constrainOverlay() {}, closePopups() {}, paramsPopup: {}, app: { getBoundingClientRect: () => ({ top: 20, bottom: 620, left: 20, right: 420 }) },
	});
	open(popup, anchor, 'left');
	return popup.style;
}

test('new chat menu opens below the top tab strip', () => {
	const style = position(24, 48, 120);
	assert.equal(style.top, '34px');
	assert.equal(style.bottom, '');
	assert.equal(style.maxHeight, '120px');
});

test('composer menus still open above and reset an earlier height limit', () => {
	const style = position(560, 584, 120);
	assert.equal(style.top, '');
	assert.equal(style.bottom, '66px');
	assert.equal(style.maxHeight, '');
});

test('large menus are constrained to the available space', () => {
	assert.equal(position(24, 48, 900).maxHeight, '558px');
	assert.equal(position(400, 424, 900).maxHeight, '366px');
});
