import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transpileModule, ScriptTarget } from 'typescript';
import { usageButtonLimit, usageButtonWindows } from '../src/chat/usageButton.ts';
import { claudeUsage, codexUsage } from '../src/chat/agentProtocol.ts';
import type { AgentId, UsageWindow } from '../src/chat/chatProtocol.ts';

function renderer() {
	const classes = new Set<string>(), styles = new Map<string, string>();
	const button = {
		title: '',
		style: { getPropertyValue: (key: string) => styles.get(key) ?? '', setProperty: (key: string, value: string) => styles.set(key, value), removeProperty: (key: string) => styles.delete(key) },
		classList: { toggle: (key: string, value: boolean) => value ? classes.add(key) : classes.delete(key) },
		setAttribute() {},
	};
	const mark = { textContent: 'U' };
	let fill: number | undefined;
	const source = readFileSync('preview-src/chat.ts', 'utf8');
	const fn = /function renderUsageLevel\([\s\S]*?\n\}/.exec(source)![0];
	const render = runInNewContext(transpileModule(`${fn}\nrenderUsageLevel;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText, {
		usageButtonWindows, usageButtonLimit, usageButton: button, usageMark: mark, usageRing: {},
		usageColor: String, usageTitle: 'Usage', agentName: (_s: unknown, agent: string) => agent,
		setRingFill: (_ring: unknown, value: number | undefined) => { fill = value; },
	});
	return { classes, button, mark, fill: () => fill,
		show(agent: AgentId, windows?: readonly UsageWindow[], legacy = false) {
			const closest = windows?.reduce<UsageWindow | undefined>((best, w) => !best || w.usedPercent > best.usedPercent ? w : best, undefined);
			render({ selection: { agent }, usage: closest ? { percent: closest.usedPercent, label: closest.label, usingCredits: false, ...(!legacy ? { windows } : {}) } : undefined });
		},
	};
}

test('real Claude and Codex usage responses drive both quota indicators', () => {
	const claude = claudeUsage({ rate_limits: { five_hour: { utilization: 60 }, seven_day: { utilization: 23 } } });
	const codex = codexUsage({ rateLimits: { primary: { usedPercent: 60, windowDurationMins: 300 }, secondary: { usedPercent: 23, windowDurationMins: 10080 } } });
	for (const usage of [claude, codex]) {
		const view = renderer();
		view.show(usage.agent, usage.windows);
		assert.equal(view.mark.textContent, '77');
		assert.equal(view.fill(), 0.6);
		assert.match(view.button.title, /Weekly limit — 77% remaining/);
	}
});

test('switching agents, unavailable quotas and resets clear both exhausted styles', () => {
	const view = renderer();
	const short = { label: '5-hour limit', usedPercent: 100 };
	const long = { label: 'Weekly limit', usedPercent: 100 };
	for (const agent of ['claude', 'codex', 'gemini', 'opencode', 'pi', 'openrouter'] as const) {
		view.show(agent, [short]);
		assert.equal(view.mark.textContent, 'U');
		assert.ok(view.classes.has('limit-short'));
		assert.ok(view.classes.has('limit-full'));
		view.show(agent, [short, long]);
		assert.ok(!view.classes.has('limit-short'));
		assert.ok(view.classes.has('limit-full'));
		view.show(agent);
		assert.equal(view.mark.textContent, 'U');
		assert.equal(view.fill(), undefined);
		assert.ok(!view.classes.has('limit-full'));
		assert.ok(!view.classes.has('limit-short'));
		view.show(agent, [{ ...short, usedPercent: 2 }, { ...long, usedPercent: 30 }]);
		assert.equal(view.mark.textContent, '70');
		assert.equal(view.fill(), 0.02);
	}
});

test('legacy remote state still displays its known period', () => {
	const view = renderer();
	view.show('codex', [{ label: '5-hour limit', usedPercent: 100 }], true);
	assert.ok(view.classes.has('limit-short'));
	view.show('codex', [{ label: 'Weekly limit', usedPercent: 42 }], true);
	assert.equal(view.mark.textContent, '58');
	assert.equal(view.fill(), undefined);
});
