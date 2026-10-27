import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { opaqueColor, safeFontFamily, terminalOptions, terminalTheme } from './terminalTheme.ts';

const reader = (vars: Record<string, string>) => (name: string) => vars[name] ?? '';

test('the theme is the editor\'s terminal colours, camelCase names kept', () => {
	const theme = terminalTheme(reader({
		'--vscode-terminal-background': '#101010',
		'--vscode-terminal-foreground': ' #eeeeee ',
		'--vscode-terminalCursor-foreground': '#ff0000',
		'--vscode-terminalCursor-background': '#000000',
		'--vscode-terminal-selectionBackground': '#264f78',
		'--vscode-terminal-ansiRed': '#cd3131',
		'--vscode-terminal-ansiBrightBlue': '#3b8eea',
		'--vscode-terminal-ansiBrightWhite': '#ffffff',
		'--vscode-terminal-ansiBlack': '#000000',
	}));
	assert.equal(theme.background, '#101010');
	assert.equal(theme.foreground, '#eeeeee');
	assert.equal(theme.cursor, '#ff0000');
	assert.equal(theme.cursorAccent, '#000000');
	assert.equal(theme.selectionBackground, '#264f78');
	assert.equal(theme.red, '#cd3131');
	assert.equal(theme.brightBlue, '#3b8eea');
	assert.equal(theme.brightWhite, '#ffffff');
	assert.equal(theme.black, '#000000');
});

test('terminal.background has no default: the side bar, then the editor, stand in for it', () => {
	assert.equal(terminalTheme(reader({ '--vscode-sideBar-background': '#222', '--vscode-editor-background': '#333' })).background, '#222');
	assert.equal(terminalTheme(reader({ '--vscode-editor-background': '#333' })).background, '#333');
	assert.equal(terminalTheme(reader({})).background, undefined);
});

test('a colour the theme does not give is left out, so xterm\'s own stays', () => {
	const theme = terminalTheme(reader({ '--vscode-terminal-foreground': '#fff' }));
	assert.equal('red' in theme, false);
	assert.equal('selectionForeground' in theme, false);
	assert.equal(theme.cursor, '#fff');
});

test('the background is made opaque', () => {
	assert.equal(opaqueColor('#11223380'), '#112233');
	assert.equal(opaqueColor('#1238'), '#123');
	assert.equal(opaqueColor('rgba(10, 20, 30, 0.5)'), 'rgb(10, 20, 30)');
	assert.equal(opaqueColor('#112233'), '#112233');
	assert.equal(opaqueColor('rgb(1, 2, 3)'), 'rgb(1, 2, 3)');
	assert.equal(terminalTheme(reader({ '--vscode-terminal-background': '#00000000' })).background, '#000000');
});

test('options follow the terminal settings, then the editor\'s font, and are clamped', () => {
	assert.deepEqual(terminalOptions({}, { family: 'Menlo, monospace', size: 12 }), {
		fontFamily: 'Menlo, monospace', fontSize: 12, lineHeight: 1, letterSpacing: 0,
		cursorStyle: 'block', cursorBlink: false, scrollback: 1000, macOptionIsMeta: false,
	});
	assert.deepEqual(terminalOptions({ fontFamily: 'Fira Code', fontSize: 15, lineHeight: 1.2, letterSpacing: 1, cursorStyle: 'line', cursorBlink: true, scrollback: 5000, macOptionIsMeta: true }, { family: 'Menlo' }), {
		fontFamily: 'Fira Code', fontSize: 15, lineHeight: 1.2, letterSpacing: 1,
		cursorStyle: 'bar', cursorBlink: true, scrollback: 5000, macOptionIsMeta: true,
	});
	assert.equal(terminalOptions({ cursorStyle: 'underline' }).cursorStyle, 'underline');
	assert.equal(terminalOptions({}).fontFamily, 'monospace');
	assert.equal(terminalOptions({}).fontSize, 13);
	const wild = terminalOptions({ fontSize: 1000, lineHeight: 0, letterSpacing: -4, scrollback: 1e9 });
	assert.equal(wild.fontSize, 100);
	assert.equal(wild.lineHeight, 1);
	assert.equal(wild.letterSpacing, 0);
	assert.equal(wild.scrollback, 100000);
	assert.equal(terminalOptions({ fontSize: Number.NaN, scrollback: Number.POSITIVE_INFINITY }).scrollback, 1000);
});

test('a font family is a list of names and nothing xterm could write into a stylesheet as CSS', () => {
	for (const ok of ['monospace', 'Menlo, Monaco, \'Courier New\', monospace', '"SF Mono", -apple-system', 'Fira Code', '"Cascadia Code PL", Consolas', 'JetBrains Mono']) {
		assert.equal(safeFontFamily(ok), ok, ok);
	}
	assert.equal(safeFontFamily('  Menlo  '), 'Menlo');
	for (const bad of [
		'monospace; } .approval button { display: none } .x{',
		'monospace;color:red',
		'a } b',
		'</style><script>',
		'x { y }',
		'url(https://evil/)',
		'a/*b*/',
		'a\\',
		'"unbalanced',
		'\'also',
		'"mixed\'',
		'line\nbreak',
		'a:b',
		'a@import',
		'a!important',
		'',
		'   ',
		' , ',
		'x'.repeat(501),
	]) {
		assert.equal(safeFontFamily(bad), undefined, JSON.stringify(bad));
	}
	assert.equal(safeFontFamily(undefined), undefined);
});

test('an unsafe font from the settings or from the editor falls back, to the next source and then to monospace', () => {
	const injection = 'monospace; } .approval-actions button:first-child { display: none } .x{';
	assert.equal(terminalOptions({ fontFamily: injection }, { family: 'Menlo' }).fontFamily, 'Menlo');
	assert.equal(terminalOptions({ fontFamily: injection }, { family: injection }).fontFamily, 'monospace');
	assert.equal(terminalOptions({}, { family: injection }).fontFamily, 'monospace');
	assert.equal(terminalOptions({ fontFamily: injection }).fontFamily, 'monospace');
	for (const o of [terminalOptions({ fontFamily: injection }), terminalOptions({}, { family: '"Fira Code";}' })]) {
		assert.ok(!/[;{}<>]/.test(o.fontFamily), o.fontFamily);
	}
	// A good setting still wins over the editor's.
	assert.equal(terminalOptions({ fontFamily: 'Fira Code' }, { family: injection }).fontFamily, 'Fira Code');
});
