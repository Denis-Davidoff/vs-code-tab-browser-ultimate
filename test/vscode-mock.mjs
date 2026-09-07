import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const l10n = { t: (msg, ...args) => msg.replace(/\{(\d+)\}/g, (_, i) => args[i]) };

class Uri {
	constructor(value) { this.value = value; }
	static parse(v) { return new Uri(v); }
	static joinPath(base, ...parts) { return new Uri(path.join(base.value, ...parts)); }
	toString() { return this.value; }
	get fsPath() { return this.value; }
}
export { Uri };

export const env = { asExternalUri: async uri => uri };

export const workspace = {
	fs: { readFile: async uri => new Uint8Array(await fs.readFile(uri.fsPath)) },
	getConfiguration: () => ({ get: (key, fallback) => fallback }),
};
