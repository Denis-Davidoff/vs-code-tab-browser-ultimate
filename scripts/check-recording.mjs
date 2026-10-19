// Real Browser API + MediaRecorder smoke test. Run `npm run compile` first.
// Usage: node scripts/check-recording.mjs [path-to-editor-executable]
// Opens an isolated editor profile, records a local animation, and restores the clipboard.
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.argv[2] ?? process.env.AI_BROWSER_CODE_BIN
	?? (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : 'code');
if (!existsSync(join(repo, 'out/browser/recording.js')) || !existsSync(join(repo, 'media/chat.js'))) {
	throw new Error('Run npm run compile before the recording smoke test.');
}
// Electron's Unix socket path must fit in 103 bytes (macOS temp roots are long).
const root = mkdtempSync(join(tmpdir(), 'abr-'));
const extension = join(root, 'extension');
mkdirSync(extension);
cpSync(join(repo, 'out'), join(extension, 'out'), { recursive: true });
copyFileSync(join(repo, 'scripts/recording-smoke/extension.cjs'), join(extension, 'extension.cjs'));
writeFileSync(join(extension, 'package.json'), JSON.stringify({
	name: 'recording-probe', publisher: 'local', version: '0.0.1', engines: { vscode: '^1.85.0' },
	main: 'extension.cjs', enabledApiProposals: ['browser'], activationEvents: ['onStartupFinished'],
	contributes: { views: { explorer: [{ id: 'aiBrowser.chat', name: 'Recording test chat', type: 'webview' }] } },
}));
const env = { ...process.env, AI_BROWSER_RECORDING_REPO: repo, AI_BROWSER_RECORDING_OUTPUT: root };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [
	'--new-window', `--user-data-dir=${join(root, 'profile')}`, `--extensions-dir=${join(root, 'extensions')}`,
	`--extensionDevelopmentPath=${extension}`, '--enable-proposed-api=local.recording-probe',
	'--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', root,
], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let launchError;
child.on('error', error => { launchError = error; });
child.on('exit', code => { if (code) { launchError = new Error(`Editor exited with ${code}; see ${root}`); } });
child.stdout.on('data', data => writeFileSync(join(root, 'editor.log'), data, { flag: 'a' }));
child.stderr.on('data', data => writeFileSync(join(root, 'editor.log'), data, { flag: 'a' }));
try {
	const until = Date.now() + 90_000;
	const output = join(root, 'integration-result.json');
	while (!existsSync(output)) {
		if (launchError) { throw launchError; }
		if (Date.now() >= until) { throw new Error(`Recording smoke test timed out; see ${root}`); }
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	const result = JSON.parse(readFileSync(output, 'utf8'));
	console.log(JSON.stringify(result, null, 2));
	console.log(`Test artifacts: ${root}`);
	if (!result.ok) { process.exitCode = 1; }
} finally {
	// This process owns a unique profile; no working editor instance is stopped.
	child.kill();
}
