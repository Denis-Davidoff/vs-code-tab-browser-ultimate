import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { visualizationMarkers } from './visualizationProtocol.ts';

const marker = (value: unknown) => `\uE200visualize\uE202${JSON.stringify(value)}\uE201`;

test('visualization references survive every possible text delta split', () => {
	const text = `Intro\n${marker({ path: '/work/chart.html', title: 'Chart', mode: 'wide' })}\nEnd`;
	for (let split = 0; split < text.length; split++) {
		const prefix = visualizationMarkers(text.slice(0, split));
		assert.ok(prefix.length === 0 || prefix[0].path === '/work/chart.html');
		assert.deepEqual(visualizationMarkers(text.slice(0, split) + text.slice(split)), [{ start: 6, end: text.indexOf('\nEnd'), path: '/work/chart.html', title: 'Chart', wide: true }]);
	}
});

test('examples, quotes, indented code and incomplete or malformed markers stay inert', () => {
	const reference = marker({ path: '/work/chart.html' });
	for (const text of [`\x60\x60\x60text\n${reference}\n\x60\x60\x60`, `~~~\n${reference}\n~~~`, `> ${reference}`, `    ${reference}`, `Example: ${reference}`, reference.slice(0, -1), marker({ path: 'https://evil.test/x.html' }), marker({ path: '//server/file.html' }), marker({ path: '/x\0.html' }), marker({ path: '/x.html', mode: 'unknown' }), marker({ path: '/x.html', title: 'x'.repeat(161) })]) {
		assert.deepEqual(visualizationMarkers(text), [], text);
	}
});

test('fences close only on matching delimiters and marker counts are bounded', () => {
	const reference = marker({ path: '/work/chart.html' });
	assert.equal(visualizationMarkers(`\x60\x60\x60\x60\n\x60\x60\x60\n${reference}`).length, 0);
	assert.equal(visualizationMarkers(Array(100).fill(reference).join('\n')).length, 8);
	assert.equal(visualizationMarkers(marker({ path: 'C:\\work\\chart.html' })).length, 1);
});

test('a reference without the private-use delimiters is read too (Claude Code)', () => {
	const text = 'Graph:\n\nvisualize{"path":"/tmp/v/a.html","title":"y = 2x"}\n\ndone';
	const [marker] = visualizationMarkers(text);
	assert.equal(marker?.path, '/tmp/v/a.html');
	assert.equal(marker?.title, 'y = 2x');
	assert.equal(visualizationMarkers('see visualize{"path":"/tmp/a.html"} inline').length, 0);
	assert.equal(visualizationMarkers('```\nvisualize{"path":"/tmp/a.html"}\n```').length, 0);
});

test('image references share safe parsing, including mixed cards and quoted examples', async () => {
	const { presentationMarkers } = await import('./visualizationProtocol.ts');
	const image = `\uE200image\uE202${JSON.stringify({ path: '/tmp/cat.png', title: 'Cat' })}\uE201`;
	const html = marker({ path: '/tmp/chart.html' });
	const text = `${image}\n${html}`;
	assert.deepEqual(presentationMarkers(text).map(ref => [ref.kind, ref.path, ref.start]), [['image', '/tmp/cat.png', 0], [undefined, '/tmp/chart.html', image.length + 1]]);
	for (const example of [`\`\`\`\n${image}\n\`\`\``, `> ${image}`, `    ${image}`, image.slice(0, -1)]) {
		assert.equal(presentationMarkers(example).length, 0);
	}
	assert.equal(presentationMarkers('image{"path":"/tmp/cat.png"}')[0]?.kind, 'image');
});
