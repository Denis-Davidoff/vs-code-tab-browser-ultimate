import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { treeHasMarkup, treeHtml, treeMarkdown, type RichNode, type RichTree } from './selectionRich.ts';

const t = (text: string): RichNode => ({ kind: 'text', text });
const e = (tag: string, children: RichNode[] = [], cls: string[] = [], attrs: Record<string, string> = {}): RichNode => ({ kind: 'el', tag, cls, attrs, children });
const badge = (id: string, label: string): RichNode => ({ kind: 'badge', id, label });
const o = { badge: (id: string, label: string) => `[att:${id}|${label}]` };
const block = (...nodes: RichNode[]): RichTree => ({ mode: 'block', nodes });

test('a reply as rendered comes back as Markdown', () => {
	const tree = block(
		e('div', [t('Plan')], ['heading', 'h2', 'level-2']),
		e('p', [t('Run '), e('code', [t('npm test')]), t(', then '), e('strong', [t('commit')]), t('.')]),
		e('ul', [e('li', [t('one'), e('ol', [e('li', [t('a')]), e('li', [t('b')])], [], { start: '3' })]), e('li', [e('em', [t('two')])])]),
		e('div', [e('div', [e('span', [t('ts')], ['code-lang'])], ['code-head']), e('pre', [e('code', [t('const a = 1;\n')])])], ['code-block']),
		e('blockquote', [e('p', [t('quoted')]), e('p', [t('second')])]),
		e('div', [e('table', [e('thead', [e('tr', [e('th', [t('A')]), e('th', [t('B')])])]), e('tbody', [e('tr', [e('td', [t('1')]), e('td', [t('x|y')])])])])], ['table-wrap']),
		e('hr'),
		e('p', [e('span', [t('docs')], ['link'], { 'data-href': 'https://example.com/a' }), t(' and '), e('span', [t('https://x.io')], ['link'], { 'data-href': 'https://x.io' })]),
	);
	assert.equal(treeMarkdown(tree, o), [
		'## Plan',
		'Run `npm test`, then **commit**.',
		'- one\n  3. a\n  4. b\n- *two*',
		'```ts\nconst a = 1;\n```',
		'> quoted\n>\n> second',
		'| A | B |\n| --- | --- |\n| 1 | x\\|y |',
		'---',
		'[docs](https://example.com/a) and https://x.io',
	].join('\n\n'));
	assert.ok(treeHasMarkup(tree));
});

test('the same as HTML, with links limited to addresses a click could open', () => {
	const tree = block(
		e('div', [t('Plan')], ['heading', 'level-3']),
		e('p', [t('a < b '), e('span', [t('x')], ['link'], { 'data-href': 'javascript:alert(1)' }), t(' '), e('span', [t('y')], ['link'], { 'data-href': 'https://y.io/?a=1&b="2"' })]),
		e('div', [e('span', [t('sh')], ['code-lang']), e('pre', [e('code', [t('echo <hi>')])])], ['code-block']),
		e('ol', [e('li', [t('n')])], [], { start: '2' }),
	);
	assert.equal(treeHtml(tree), '<h3>Plan</h3><p>a &lt; b x <a href="https://y.io/?a=1&amp;b=&quot;2&quot;">y</a></p>'
		+ '<pre><code class="language-sh">echo &lt;hi&gt;</code></pre><ol start="2"><li>n</li></ol>');
});

test('sent attachment badges are a tag in Markdown and a code label in HTML', () => {
	const tree: RichTree = { mode: 'inline', nodes: [t('See '), badge('id1', 'file.ts'), t(' here')] };
	assert.equal(treeMarkdown(tree, o), 'See [att:id1|file.ts] here');
	assert.equal(treeHtml(tree), 'See <code>file.ts</code> here');
	assert.ok(treeHasMarkup(tree));
});

test('plain text and selections inside code carry no markup', () => {
	assert.equal(treeHasMarkup(block(e('p', [t('just words')]))), false);
	const code: RichTree = { mode: 'plain', nodes: [t('a `b` c')] };
	assert.equal(treeMarkdown(code, o), 'a `b` c');
	assert.equal(treeHasMarkup(code), false);
});

test('inline code containing backticks gets a longer fence', () => {
	assert.equal(treeMarkdown({ mode: 'inline', nodes: [e('code', [t('a`b')])] }, o), '``a`b``');
	assert.equal(treeMarkdown({ mode: 'inline', nodes: [e('code', [t('`x')])] }, o), '`` `x ``');
});
