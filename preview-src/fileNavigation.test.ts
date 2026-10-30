import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileGridNeighbor } from './fileNavigation.ts';

const grid = (columns: number, count: number) => Array.from({ length: count }, (_, i) => ({
	top: 14 + Math.floor(i / columns) * 103,
	left: 4 + (i % columns) * 92.5,
}));

test('tile arrows follow rendered rows and columns at different widths', () => {
	for (const columns of [1, 2, 3, 4, 7]) {
		const tiles = grid(columns, columns * 3);
		for (let at = 0; at < tiles.length; at++) {
			assert.equal(fileGridNeighbor(tiles, at, 'ArrowDown'), at + columns < tiles.length ? at + columns : at);
			assert.equal(fileGridNeighbor(tiles, at, 'ArrowUp'), at >= columns ? at - columns : at);
			assert.equal(fileGridNeighbor(tiles, at, 'ArrowLeft'), at % columns ? at - 1 : at);
			assert.equal(fileGridNeighbor(tiles, at, 'ArrowRight'), at % columns < columns - 1 ? at + 1 : at);
		}
	}
});

test('incomplete last row chooses the closest column and does not wrap horizontally', () => {
	const tiles = grid(4, 10);
	assert.equal(fileGridNeighbor(tiles, 6, 'ArrowDown'), 9);
	assert.equal(fileGridNeighbor(tiles, 7, 'ArrowDown'), 9);
	assert.equal(fileGridNeighbor(tiles, 9, 'ArrowUp'), 5);
	assert.equal(fileGridNeighbor(tiles, 9, 'ArrowRight'), 9);
	assert.equal(fileGridNeighbor(tiles, 8, 'ArrowLeft'), 8);
});

test('uses current geometry after resize, scroll, and unequal row heights', () => {
	assert.equal(fileGridNeighbor(grid(3, 12), 4, 'ArrowDown'), 7);
	const resized = grid(4, 12).map(tile => ({ ...tile, top: tile.top - 230 + (tile.top > 150 ? 24 : 0) }));
	assert.equal(fileGridNeighbor(resized, 4, 'ArrowDown'), 8);
	assert.equal(fileGridNeighbor(resized, 8, 'ArrowUp'), 4);
});

test('empty grids and grids without an existing selection', () => {
	assert.equal(fileGridNeighbor([], -1, 'ArrowDown'), -1);
	for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const) {
		assert.equal(fileGridNeighbor(grid(3, 5), -1, key), 0);
		assert.equal(fileGridNeighbor(grid(1, 1), 0, key), 0);
	}
});
