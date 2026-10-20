import type { GitStatusFile } from './chatProtocol';

export interface GitDiffSide {
	path: string;
	/** HEAD or the index (''); absent for the working file. */
	ref?: string;
}

/** Undefined sides represent new/deleted files, without trying to open a missing blob. */
export function gitDiffSides(file: GitStatusFile, staged: boolean): { before?: GitDiffSide; after?: GitDiffSide } {
	return {
		before: file.status === '?' || (staged && file.status === 'A') ? undefined
			: { path: file.originalPath ?? file.path, ref: staged ? 'HEAD' : '' },
		after: file.status === 'D' ? undefined
			: staged ? { path: file.path, ref: '' } : { path: file.path },
	};
}
