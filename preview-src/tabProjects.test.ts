import { test } from 'node:test';
import * as assert from 'node:assert';
import { allTotals, groupStrip, projectColors, tabForProject, type ProjectTab } from './tabProjects.ts';

const a = { id: 'pa', name: 'alpha' };
const b = { id: 'pb', name: 'beta' };
const strip: ProjectTab[] = [
	{ id: '1', project: a, status: 'working' },
	{ id: '2', project: b, status: 'unread' },
	{ id: '3', project: a, status: 'read' },
	{ id: 't1', terminal: {} },
	{ id: '4', project: b, status: 'working' },
	{ id: '5', project: b, status: 'waiting' },
];

test('groups keep first-appearance order and strip order inside, terminals last', () => {
	const g = groupStrip(strip);
	assert.deepStrictEqual(g.groups.map(x => x.id), ['pa', 'pb']);
	assert.deepStrictEqual(g.ordered.map(t => t.id), ['1', '3', '2', '4', '5', 't1']);
	assert.deepStrictEqual(g.groups.map(x => [x.thinking, x.unread, x.waiting]), [[1, 0, 0], [1, 1, 1]]);
	assert.deepStrictEqual(allTotals(g.groups), { tabs: 5, thinking: 2, unread: 1, waiting: 1, failed: 0 });
});

test('tabs with no project share one group, and repeated names are numbered', () => {
	const g = groupStrip<ProjectTab>([{ id: '1' }, { id: '2', project: { id: 'x', name: 'app' } }, { id: '3', project: { id: 'y', name: 'app' } }, { id: '4' }]);
	assert.deepStrictEqual(g.groups.map(x => [x.id, x.name, x.tabs.length]), [['', 'Chats', 2], ['x', 'app', 1], ['y', 'app (2)', 1]]);
});

test('choosing a project brings forward what needs the user first', () => {
	const g = groupStrip(strip);
	assert.strictEqual(tabForProject(g.groups[1])?.id, '5');
	assert.strictEqual(tabForProject(g.groups[0], '3')?.id, '3');
	assert.strictEqual(tabForProject(g.groups[0])?.id, '1');
});

test('projects get distinct folder colours that stay put', () => {
	const ids = Array.from({ length: 10 }, (_, i) => `project-${i}`);
	const first = projectColors(ids, {}, 12);
	assert.strictEqual(new Set(ids.map(id => first[id])).size, 10, 'no two open projects share a colour');
	for (const id of ids) { assert.ok(first[id] >= 0 && first[id] < 12); }
	// Another project opening, one closing: the rest keep theirs.
	const next = projectColors([...ids.slice(1), 'project-new'], first, 12);
	for (const id of ids.slice(1)) { assert.strictEqual(next[id], first[id]); }
	assert.ok(!ids.slice(1).some(id => next[id] === next['project-new']));
	// The closed one is remembered and comes back with its colour when free.
	assert.strictEqual(next['project-0'], first['project-0']);
	// A remembered clash (two ids on one slot, a slot out of range) is resolved.
	const fixed = projectColors(['x', 'y', 'z'], { x: 3, y: 3, z: 99 }, 4);
	assert.strictEqual(fixed.x, 3);
	assert.strictEqual(new Set([fixed.x, fixed.y, fixed.z]).size, 3);
	// More projects than colours: every colour is used before any repeats.
	const many = projectColors(['a', 'b', 'c', 'd', 'e'], {}, 4);
	const counts = [0, 0, 0, 0];
	for (const id of ['a', 'b', 'c', 'd', 'e']) { counts[many[id]]++; }
	assert.deepStrictEqual([...counts].sort(), [1, 1, 1, 2]);
});

test('a project that stayed open keeps its colour when a closed one returns', () => {
	// What the last call stored: B open with slot 0, then A, closed, remembered at slot 0 too.
	const remembered = JSON.parse(JSON.stringify({ B: 0, A: 0 })) as Record<string, number>;
	// A comes back ahead of B in the strip: B keeps its colour, A gets another.
	const after = projectColors(['A', 'B'], remembered, 4);
	assert.strictEqual(after.B, 0);
	assert.notStrictEqual(after.A, 0);
	// And what is stored next keeps that ranking.
	const later = projectColors(['A', 'B'], JSON.parse(JSON.stringify(after)), 4);
	assert.deepStrictEqual(later, after);
});
