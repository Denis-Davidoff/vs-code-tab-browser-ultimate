import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { namesFile, resolveFileIcon, type FileIconTable } from './fileIconTable.ts';

const table: FileIconTable = {
	fonts: ['seti.woff'],
	icons: { generic: { character: 'g', font: 0, color: '#ccc', size: '150%' }, npm: { character: 'n' }, test: { character: 't' }, ts: { character: 'T' }, md: { character: 'm' }, shell: { character: 's' }, src: { image: 'src.svg' } },
	file: 'generic',
	fileNames: { 'package.json': 'npm' },
	fileExtensions: { 'spec.ts': 'test', ts: 'ts' },
	folderNames: { src: 'src' },
	languageIds: { markdown: 'md', shellscript: 'shell' },
	languageByName: { '.bashrc': 'shellscript' },
	languageByExtension: { md: 'markdown' },
};

test('names, compound extensions, languages, then the default', () => {
	assert.equal(resolveFileIcon(table, 'a/PACKAGE.JSON')?.character, 'n');
	assert.equal(resolveFileIcon(table, 'x.spec.ts')?.character, 't');
	assert.equal(resolveFileIcon(table, 'C:\\dev\\x.ts')?.character, 'T');
	assert.equal(resolveFileIcon(table, 'README.md')?.character, 'm');
	assert.equal(resolveFileIcon(table, '~/.bashrc')?.character, 's');
	assert.equal(resolveFileIcon(table, 'notes.xyz')?.character, 'g');
});

test('an icon names its font by index, and gets its address back', () => {
	assert.deepEqual(resolveFileIcon(table, 'notes.xyz'), { image: undefined, character: 'g', font: 'seti.woff', color: '#ccc', size: '150%' });
	assert.equal(resolveFileIcon(table, 'a.ts')?.font, undefined);
});

test('folders use folder names and have no icon without a folder default', () => {
	assert.equal(resolveFileIcon(table, 'repo/src/')?.image, 'src.svg');
	assert.equal(resolveFileIcon(table, 'lib/'), undefined);
});

test('a key inherited from Object is not an association', () => {
	assert.equal(resolveFileIcon(table, 'constructor')?.character, 'g');
	assert.equal(resolveFileIcon({ ...table, file: undefined }, 'x.tostring'), undefined);
});

test('which tokens of a message name a file', () => {
	assert.equal(namesFile(table, 'src/chat/chatView.ts', false), true);
	assert.equal(namesFile(table, './notes.xyz', false), true);
	assert.equal(namesFile(table, 'package.json', false), true);
	assert.equal(namesFile(table, 'Node.ts', false), false);
	assert.equal(namesFile(table, 'chatView.ts', true), true);
	assert.equal(namesFile(table, 'docs/', false), false);
	assert.equal(namesFile(table, 'src/chat/', false), true);
	assert.equal(namesFile(table, 'e.g.', true), false);
	assert.equal(namesFile(table, '1.2.3', true), false);
	assert.equal(namesFile(table, 'and/or', false), false);
	assert.equal(namesFile(table, 'npm test', true), false);
	assert.equal(namesFile(table, 'https://x.ts', true), false);
});

test('theme file names do not turn ordinary words into file references', () => {
	const themed = { ...table, fileNames: { ...table.fileNames, version: 'generic', changelog: 'generic', readme: 'generic', 'readme.md': 'md', 'news.md': 'md' } };
	for (const word of ['version', 'changelog', 'readme', 'VERSION', 'CHANGELOG']) {
		assert.equal(namesFile(themed, word, false), false, word);
		assert.equal(namesFile(themed, word, true), true, `inline code: ${word}`);
		assert.equal(namesFile(themed, `./${word}`, false), true, `path: ${word}`);
	}
	for (const file of ['package.json', 'README.md', 'NEWS.md']) {
		assert.equal(namesFile(themed, file, false), true, file);
	}
});

test('Markdown file names in prose do not require a theme association for each name', () => {
	const themed = { ...table, fileNames: { ...table.fileNames, 'readme.md': 'md' } };
	for (const file of ['README.md', 'NEWS.md', 'CHANGELOG.md', 'notes.md']) {
		assert.equal(namesFile(themed, file, false), true, file);
		assert.equal(resolveFileIcon(themed, file)?.character, 'm', file);
	}
	for (const word of ['news', 'readme', 'changelog', 'Node.js']) {
		assert.equal(namesFile(themed, word, false), false, word);
	}
});
