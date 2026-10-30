type TilePosition = { readonly top: number; readonly left: number };
export type FileArrow = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

/** Choose a neighbour from the rendered grid, including its incomplete last row. */
export function fileGridNeighbor(tiles: readonly TilePosition[], at: number, key: FileArrow): number {
	if (!tiles.length) { return -1; }
	if (at < 0 || at >= tiles.length) { return 0; }
	const current = tiles[at];
	const vertical = key === 'ArrowUp' || key === 'ArrowDown';
	const sign = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1;
	let next = at, distance = Infinity, across = Infinity;
	for (let i = 0; i < tiles.length; i++) {
		const tile = tiles[i];
		const along = sign * (vertical ? tile.top - current.top : tile.left - current.left);
		if (along <= 0 || (!vertical && Math.abs(tile.top - current.top) > 1)) { continue; }
		const cross = vertical ? Math.abs(tile.left - current.left) : 0;
		if (along < distance || (along === distance && cross < across)) {
			next = i; distance = along; across = cross;
		}
	}
	return next;
}
