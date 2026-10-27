import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { NativeActions, actionLocatorSource, keyDescription, pointerRoute, quadMatrix, projectPoint, inverseMatrix, splitActionSelector } from './nativeActions.ts';

test('shadow selectors retain quoted >>> and refuse ambiguous or missing targets', () => {
	const button = {}, shadow = { querySelectorAll: (s: string) => s === '[title=">>>"]' ? [button] : [] };
	const host = { shadowRoot: shadow };
	const resolve = runInNewContext(actionLocatorSource, { document: { querySelectorAll: (s: string) => s === 'my-form' ? [host] : s === 'button' ? [{}, {}] : [] } });
	assert.equal(resolve('my-form >>> [title=">>>"]'), button);
	assert.throws(() => resolve('button'), /ambiguous/);
	assert.throws(() => resolve('missing'), /No element/);
	assert.throws(() => resolve('my-form >>>'), /Empty/);
});

test('keyboard grammar maps modifiers and text without accepting unknown or malformed keys', () => {
	assert.equal(keyDescription('Meta+a').modifiers, 4);
	assert.equal(keyDescription('Shift+Tab').windowsVirtualKeyCode, 9);
	assert.equal(keyDescription('Enter').text, '\r');
	assert.equal(keyDescription('Shift+a').text, 'A');
	assert.equal(keyDescription('Control+a').text, undefined);
	assert.deepEqual(keyDescription('Meta+a', 'darwin').commands, ['selectAll']);
	// The user's clipboard is never read or written by an agent's key press.
	for (const shortcut of ['Meta+v', 'Meta+Shift+v', 'Meta+c', 'Meta+x']) { assert.throws(() => keyDescription(shortcut, 'darwin'), /clipboard/); }
	for (const shortcut of ['Control+v', 'Control+c', 'Control+Shift+x']) { assert.throws(() => keyDescription(shortcut, 'linux'), /clipboard/); }
	assert.equal(keyDescription('Control+v', 'darwin').commands, undefined, 'Control+V on a Mac is not paste');
	assert.deepEqual(keyDescription('Control+Shift+z', 'linux').commands, ['redo']);
	assert.throws(() => keyDescription('Control+Control+a'), /modifiers/);
	assert.throws(() => keyDescription('F12'), /Unsupported/);
	assert.throws(() => keyDescription(''), /Unsupported/);
});

test('smooth pointer routes are bounded and land exactly on the target', () => {
	const route = pointerRoute({ x: 0, y: 0 }, { x: 700, y: 350 }, true);
	assert.ok(route.length <= 18);
	assert.deepEqual(route.at(-1), { x: 700, y: 350 });
	assert.ok(route.every((p, i) => i === 0 || p.x >= route[i - 1].x));
	assert.deepEqual(pointerRoute({ x: 0, y: 0 }, { x: 3, y: 4 }, false), [{ x: 3, y: 4 }]);
});

test('projective frame mapping round-trips rotation, scale, skew and perspective coordinates', () => {
	const quad = [40, 50, 350, 110, 300, 300, 70, 270];
	const matrix = quadMatrix(400, 200, quad), inverse = inverseMatrix(matrix);
	for (const point of [{ x: 0, y: 0 }, { x: 400, y: 200 }, { x: 135, y: 87 }]) {
		const result = projectPoint(inverse, projectPoint(matrix, point));
		assert.ok(Math.abs(result.x - point.x) < 1e-6 && Math.abs(result.y - point.y) < 1e-6);
	}
	assert.deepEqual(projectPoint(matrix, { x: 0, y: 0 }), { x: 40, y: 50 });
	assert.throws(() => quadMatrix(0, 200, quad), /Invalid/);
	assert.throws(() => quadMatrix(400, 200, [0, 0, 1, 0, 2, 0, 3, 0]), /singular/);
});

test('humanized pointer paths curve without overshooting the endpoint, with bounded event counts', () => {
	const route = pointerRoute({ x: 0, y: 0 }, { x: 700, y: 0 }, true, true, () => .9);
	assert.ok(route.length <= 28);
	assert.ok(route.some(point => point.y > 1));
	assert.deepEqual(route.at(-1), { x: 700, y: 0 });
	assert.deepEqual(splitActionSelector('x-host >>> [title=">>>"]'), ['x-host', '[title=">>>"]']);
	assert.throws(() => splitActionSelector('x-host >>>'), /Invalid/);
});

function harness() {
	const calls: { method: string; params: any; session: string }[] = [];
	const state = { covered: false, failPress: false, redirect: false, abortOnPress: undefined as AbortController | undefined,
		abortOnKey: undefined as AbortController | undefined, missPointer: false };
	const actions = new NativeActions({
		mainSessionId: 'main', scope: async frameId => ({ sessionId: frameId ? 'child' : 'main', contextId: frameId ? 9 : undefined }),
		owners: async () => [{ frameId: 'child-frame', parent: { sessionId: 'main' } }],
		send: async (method, params: any, session) => {
			calls.push({ method, params, session });
			if (method === 'Runtime.evaluate') { return params.expression.includes('innerWidth') ? { result: { value: { width: 200, height: 200 } } } : { result: { objectId: 'element' } }; }
			if (method === 'DOM.getFrameOwner') { return { backendNodeId: 17 }; }
			if (method === 'DOM.resolveNode') { return { object: { objectId: 'owner' } }; }
			if (method === 'DOM.getBoxModel') { return { model: { content: [100, 150, 300, 150, 300, 350, 100, 350] } }; }
			if (method === 'Runtime.callFunctionOn') {
				if (params.returnByValue === false) { return { result: { objectId: 'probe' } }; }
				if (params.functionDeclaration.includes('this.seen')) { return { result: { value: !state.missPointer } }; }
				if (params.functionDeclaration.includes('rectangles')) {
					if (state.covered) { return { exceptionDetails: { text: 'covered' } }; }
					return { result: { value: { x: 20, y: 30 } } };
				}
				if (state.redirect && params.functionDeclaration.includes('receive focus')) { return { exceptionDetails: { text: 'focus redirected' } }; }
				return { result: { value: 'button' } };
			}
			if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
				state.abortOnPress?.abort();
				if (state.failPress) { throw new Error('press failed'); }
			}
			if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') { state.abortOnKey?.abort(); }
			return {};
		},
	});
	return { actions, calls, state };
}

test('double/right clicks emit native events, release remote objects and map child coordinates to the main session', async () => {
	const h = harness();
	await h.actions.pointerAction('click', '#button', 'child-frame', { button: 'right', clickCount: 2 });
	const input = h.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
	assert.deepEqual(input.map(c => c.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased', 'mousePressed', 'mouseReleased']);
	assert.ok(input.every(c => c.session === 'main' && c.params.x === 120 && c.params.y === 180));
	assert.equal(input[3].params.clickCount, 2);
	assert.equal(input[1].params.button, 'right');
	assert.equal(input.at(-1)?.params.buttons, 0);
	assert.deepEqual(h.calls.filter(c => c.method === 'Runtime.releaseObject').map(c => c.params.objectId).sort(), ['element', 'owner', 'probe']);
});

test('covered targets issue no input; failed presses release the button without replaying the click', async () => {
	const h = harness(); h.state.covered = true;
	await assert.rejects(() => h.actions.pointerAction('click', '#button', undefined), /covered/);
	assert.equal(h.calls.filter(c => c.method.startsWith('Input.')).length, 0);
	h.state.covered = false; h.state.failPress = true;
	await assert.rejects(() => h.actions.pointerAction('click', '#button', undefined), /press failed/);
	assert.equal(h.calls.filter(c => c.params.type === 'mousePressed').length, 1);
	assert.equal(h.calls.filter(c => c.params.type === 'mouseReleased').length, 1);
});

test('cancellation releases a pressed button and prevents the second click', async () => {
	const h = harness(), abort = new AbortController(); h.state.abortOnPress = abort;
	await assert.rejects(() => h.actions.pointerAction('click', '#button', undefined, { clickCount: 2 }, abort.signal), /abort/i);
	assert.equal(h.calls.filter(c => c.params.type === 'mousePressed').length, 1);
	assert.equal(h.calls.filter(c => c.params.type === 'mouseReleased').length, 1);
	assert.ok(h.calls.some(c => c.method === 'Runtime.releaseObject'));
});

test('native text never appears in the result; keyboard uses the selected frame and refuses redirected focus', async () => {
	const h = harness(), secret = 'private-password';
	const result = await h.actions.keyboardAction('#field', 'child-frame', { text: secret });
	assert.ok(!JSON.stringify(result).includes(secret));
	assert.equal(h.calls.find(c => c.method === 'Input.insertText')?.session, 'child');
	await h.actions.keyboardAction('#field', undefined, { key: 'Enter' });
	assert.deepEqual(h.calls.filter(c => c.method === 'Input.dispatchKeyEvent').map(c => c.params.type), ['keyDown', 'keyUp']);
	h.state.redirect = true; const before = h.calls.filter(c => c.method.startsWith('Input.')).length;
	await assert.rejects(() => h.actions.keyboardAction('#field', undefined, { text: 'x' }), /focus redirected/);
	assert.equal(h.calls.filter(c => c.method.startsWith('Input.')).length, before);
});

test('invalid options and pre-cancelled operations issue no browser commands', async () => {
	const h = harness(), abort = new AbortController(); abort.abort();
	await assert.rejects(() => h.actions.pointerAction('click', '#button', undefined, {}, abort.signal), /abort/i);
	await assert.rejects(() => h.actions.pointerAction('click', '#button', undefined, { smooth: 'yes' as any }), /boolean/);
	await assert.rejects(() => h.actions.pointerAction('click', '#button', undefined, { clickCount: null as any }), /clickCount/);
	assert.equal(h.calls.length, 0);
});

test('drags hold the left button during movement and release it on cancellation', async () => {
	const h = harness();
	await h.actions.drag('#source', '#target', undefined, false);
	const input = h.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
	assert.deepEqual(input.map(c => c.params.type), ['mouseMoved', 'mousePressed', 'mouseMoved', 'mouseReleased']);
	assert.equal(input[2].params.buttons, 1);
	assert.equal(input[3].params.buttons, 0);
	const abort = new AbortController(); h.state.abortOnPress = abort;
	await assert.rejects(() => h.actions.drag('#source', '#target', undefined, false, abort.signal), /abort/i);
	assert.equal(h.calls.filter(c => c.params.type === 'mouseReleased').length, 2);
});

test('concurrent native actions on one session do not interleave input sequences', async () => {
	const h = harness();
	await Promise.all([h.actions.pointerAction('click', '#first', undefined), h.actions.keyboardAction('#second', undefined, { key: 'Enter' })]);
	assert.deepEqual(h.calls.filter(c => c.method.startsWith('Input.')).map(c => c.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased', 'keyDown', 'keyUp']);
});

test('humanized typing cancels between characters, releases the key, and rejects excessive text', async () => {
	const h = harness(), controller = new AbortController(); h.state.abortOnKey = controller;
	await assert.rejects(() => h.actions.keyboardAction('#field', undefined, { text: 'private' }, controller.signal, true), /abort/i);
	assert.equal(h.calls.filter(call => call.params.type === 'keyDown').length, 1);
	assert.equal(h.calls.filter(call => call.params.type === 'keyUp').length, 1);
	const count = h.calls.length;
	await assert.rejects(() => h.actions.keyboardAction('#field', undefined, { text: 'x'.repeat(401) }, undefined, true), /400/);
	await assert.rejects(() => h.actions.keyboardAction('#field', undefined, { text: 'x' }, undefined, 'yes' as any), /boolean/);
	assert.equal(h.calls.length, count);
});

test('an OOPIF pointer miss never advances to a mouse press and removes its transient probe', async () => {
	const h = harness(); h.state.missPointer = true;
	await assert.rejects(() => h.actions.pointerAction('click', '#button', 'child-frame'), /did not reach/);
	assert.equal(h.calls.filter(call => call.params.type === 'mousePressed').length, 0);
	assert.ok(h.calls.some(call => call.method === 'Runtime.callFunctionOn' && call.params.functionDeclaration.includes('this.dispose')));
	assert.ok(h.calls.some(call => call.method === 'Runtime.releaseObject' && call.params.objectId === 'probe'));
});
