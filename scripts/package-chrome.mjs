import { createWriteStream } from 'node:fs';
import { readdir, readFile, rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';

// Always package the freshly built extension, independent of the caller's working directory.
await import('./build-chrome.mjs');
const extension = fileURLToPath(new URL('../chrome-extension/', import.meta.url));
const dist = `${extension}dist/`;
const manifest = JSON.parse(await readFile(`${dist}manifest.json`, 'utf8'));
if (!/^\d+(?:\.\d+){1,3}$/.test(manifest.version)) { throw new Error('Invalid Chrome extension version.'); }
const archive = `${extension}ai-browser-chrome-${manifest.version}.zip`;
const temporary = `${archive}.tmp`;

async function files(directory, prefix = '') {
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) { throw new Error(`Unexpected symlink in Chrome build: ${prefix}${entry.name}`); }
    if (entry.isDirectory()) { result.push(...await files(`${directory}${entry.name}/`, `${prefix}${entry.name}/`)); }
    else if (entry.isFile()) { result.push(`${prefix}${entry.name}`); }
  }
  return result;
}
const entries = await files(dist);
const zip = new yazl.ZipFile();
const output = createWriteStream(temporary);
zip.on('error', error => output.destroy(error));
const completed = pipeline(zip.outputStream, output);
try {
  for (const entry of entries) { zip.addFile(`${dist}${entry}`, entry); }
  zip.end();
  await completed;
  await rename(temporary, archive);
} catch (error) {
  output.destroy();
  await completed.catch(() => {});
  await rm(temporary, { force: true });
  throw error;
}
console.log(`Chrome extension ZIP: ${archive}`);
