import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { COMMANDS, commandFeature, forwardedTypes, remoteRefusal } from './commands.ts';
import { chromeChatCommandFeature } from '../chromeChatCompatibility.ts';

/**
 * The golden table: the command list must say exactly what the code that
 * predates it does — the Chrome side panel's `supported` set, and what the
 * website reader accepts minus what the host refuses. A change to either side
 * that is not made in `COMMANDS` fails here, and an intended change of
 * behaviour shows up as a diff of these sets.
 */
const read = (path: string) => readFileSync(path, 'utf8');
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

function cases(source: string, from: string, to?: string): string[] {
	const start = source.indexOf(from);
	const body = source.slice(start, to ? source.indexOf(to, start) : undefined);
	return [...body.matchAll(/case '([A-Za-z]+)'/g)].map(m => m[1]);
}

// Frozen from the code before the table existed (sidepanel.ts `supported`, the
// website reader minus `exchangeForbidden` and the host's own refusals).
// Changing a set here is changing what a remote surface may do: review it.
const chromeGolden = ["approve","attachPath","chooseWorkdir","compact","deleteToolbarSkill","dismissGitCommit","dismissUsageAlert","fixGitCommit","gitBranchAction","gitBranchName","gitCommit","gitIndexAction","gitRemoteAction","listCommands","listWorkdir","moveToolbarSkill","openAttachment","openGitDiff","openRepo","placeToolbarSkill","refreshWorkdirGit","removeRepoFolder","repoAction","restoreBranchStash","runToolbarSkill","saveFeatureAi","saveToolbarSkill","select","send","setViewMode","setWorkdir","stop","stopToolbarSkill","switchAgent","toolbarApprove","trustWorkdir","usage"];
const exchangeGolden = ["approve","attach","attachPath","clearChat","closeTab","compact","deleteToolbarSkill","dismissGitCommit","dismissUsageAlert","exportChat","fixGitCommit","gitBranchAction","gitBranchName","gitCommit","gitIndexAction","gitRemoteAction","listCommands","listWorkdir","localLinkInfo","moveToolbarSkill","newChat","newTab","openAttachment","openBrowser","openDiff","openGitDiff","openLink","openRepo","openText","placeToolbarSkill","ready","refreshAgents","refreshWorkdirGit","removeAttachment","removeRepoFolder","renameTab","repoAction","restoreBranchStash","resumeQueue","runToolbarSkill","saveFeatureAi","saveToolbarSkill","secondOpinion","select","selectTab","send","setAutomaticAwake","setNewsHidden","setSleep","setViewMode","setWorkdir","stop","stopAgent","stopToolbarSkill","switchAgent","toolbarApprove","trustWorkdir","unqueue","usage"];

test('what each remote surface may ask the host for is the reviewed set', () => {
	assert.deepStrictEqual(sorted(forwardedTypes('chrome')), sorted(chromeGolden));
	assert.deepStrictEqual(sorted(forwardedTypes('exchange')), sorted(exchangeGolden));
	assert.deepStrictEqual(sorted(chromeGolden.filter(t => !COMMANDS[t as keyof typeof COMMANDS])), []);
});

test('Chrome forwards the table, and the website reader accepts nothing the table refuses', () => {
	assert.match(read('chrome-extension/sidepanel.ts'), /const supported = new Set<string>\(forwardedTypes\('chrome'\)\)/);
	const accepted = new Set([
		...cases(read('src/chat/chromeChatProtocol.ts'), 'export function readChromeChatCommand', 'export function readChromeChatConnection'),
		...cases(read('src/chat/chromeChatProtocol.ts'), 'function readChromeFooterMessage'),
		...cases(read('src/chat/exchangeUiProtocol.ts'), 'switch (m.type)'),
	]);
	accepted.delete('history');
	// The reader is wider than the table (it predates it); the host refuses the rest.
	for (const type of forwardedTypes('exchange')) { assert.ok(accepted.has(type), `${type} cannot reach the host`); }
	for (const type of forwardedTypes('chrome')) { assert.ok(accepted.has(type), `${type} cannot reach the host`); }
});

test('the feature of every command is the one Chrome negotiates', () => {
	for (const type of Object.keys(COMMANDS)) {
		assert.strictEqual(commandFeature(type), chromeChatCommandFeature({ type } as never), type);
	}
});

test('a remote refusal always has words, and an unknown type is refused', () => {
	for (const type of Object.keys(COMMANDS)) {
		for (const surface of ['chrome', 'exchange'] as const) {
			const reason = remoteRefusal(surface, type);
			assert.ok(reason === undefined || reason.length > 10, `${surface} ${type}`);
		}
	}
	assert.ok(remoteRefusal('exchange', 'somethingNew'));
	assert.ok(remoteRefusal('chrome', 'constructor'));
});
