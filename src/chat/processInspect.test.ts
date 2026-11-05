import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyProcLink, FileFollower, followableOutputs, nodeFiles, parseLsof, parsePsDetails, parseWindowsProcess, terminalSafe } from './processInspect.ts';

test('lsof fields: cwd, a regular file shared by stdout and stderr, a pipe, a tty and /dev/null', () => {
	const parsed = parseLsof('p5179\nfcwd\ntDIR\nn/Users/me/project\nf1\ntREG\nn/private/tmp/out.log\nf2\ntREG\nn/private/tmp/out.log\n');
	assert.equal(parsed.cwd, '/Users/me/project');
	assert.deepEqual(parsed.outputs, [{ fd: 1, kind: 'file', path: '/private/tmp/out.log' }, { fd: 2, kind: 'file', path: '/private/tmp/out.log' }]);
	assert.deepEqual(followableOutputs(parsed.outputs), ['/private/tmp/out.log']);
	assert.deepEqual(parseLsof('p1\nf1\ntPIPE\nn->0x1\nf2\ntCHR\nn/dev/ttys003\n').outputs, [{ fd: 1, kind: 'pipe' }, { fd: 2, kind: 'terminal', path: '/dev/ttys003' }]);
	assert.deepEqual(parseLsof('p1\nf1\ntCHR\nn/dev/null\n').outputs, [{ fd: 1, kind: 'null' }]);
	assert.deepEqual(followableOutputs(parseLsof('p1\nf1\ntPIPE\nn->0x1\n').outputs), []);
});

test('/proc fd links: a pipe or socket is never a path to follow', () => {
	assert.deepEqual(classifyProcLink('pipe:[1234]'), { kind: 'pipe' });
	assert.deepEqual(classifyProcLink('socket:[9]'), { kind: 'socket' });
	assert.deepEqual(classifyProcLink('/dev/pts/2'), { kind: 'terminal', path: '/dev/pts/2' });
	assert.deepEqual(classifyProcLink('/tmp/x.log (deleted)'), { kind: 'other', path: '/tmp/x.log' });
});

test('ps details and Windows CIM details', () => {
	assert.deepEqual(parsePsDetails('  0.1    960 00:05 SN   sleep 30\n'), { cpu: '0.1%', memory: '960 KB', elapsed: '00:05', state: 'SN', commandLine: 'sleep 30' });
	assert.equal(parsePsDetails(''), undefined);
	const win = parseWindowsProcess(JSON.stringify({ CommandLine: 'node server.js', WorkingSetSize: 50 * 1024 * 1024, CreationDate: new Date(Date.now() - 65_000).toISOString() }));
	assert.equal(win?.commandLine, 'node server.js');
	assert.equal(win?.memory, '50.0 MB');
	assert.equal(win?.elapsed, '1m 5s');
	assert.equal(parseWindowsProcess('not json'), undefined);
});

test('terminal output keeps colours and drops OSC, cursor moves and C1', () => {
	assert.equal(terminalSafe('\x1b[31mred\x1b[0m\n'), '\x1b[31mred\x1b[0m\r\n');
	assert.equal(terminalSafe('a\x1b]52;c;aGk=\x07b\x1b[2Jc\x9bd\x07e'), 'abcde');
});

test('a followed file prints its tail, then appends, then reads again after truncation', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'aib-follow-'));
	const path = join(dir, 'out.log');
	try {
		writeFileSync(path, 'x'.repeat(100) + 'TAIL\n');
		let seen = '';
		const follower = new FileFollower(path, text => { seen += text; }, nodeFiles, 5, 60_000);
		await follower.start();
		assert.match(seen, /earlier output/);
		assert.ok(seen.endsWith('TAIL\r\n') && !seen.includes('xxxxxx'), seen);
		appendFileSync(path, 'more\n'); await follower.tick();
		assert.ok(seen.endsWith('more\r\n'));
		writeFileSync(path, 'new\n'); await follower.tick();
		assert.match(seen, /truncated[\s\S]*new\r\n$/);
		follower.stop();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing file says so instead of throwing', async () => {
	let seen = '';
	await new FileFollower('/nonexistent/aib/out.log', text => { seen += text; }, nodeFiles).start();
	assert.match(seen, /Cannot read/);
});
