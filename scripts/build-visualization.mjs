import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resource iframe documents cannot rely on the parent webview's service worker for subresources. */
export async function buildVisualizationHtml(output) {
  const template = await readFile(fileURLToPath(new URL('../preview-src/visualization.html', import.meta.url)), 'utf8');
  const script = await readFile(join(output, 'visualization.js'), 'utf8');
  const escaped = script.replace(/<\/script/gi, '<\\/script');
  const marker = '<!-- visualization-runtime -->';
  if (!template.includes(marker)) throw new Error('Visualization template is missing the runtime placeholder.');
  await writeFile(join(output, 'visualization.html'), template.replace(marker, () => `<script>${escaped}</script>`));
}
