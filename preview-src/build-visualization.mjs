import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Shared by all renderers, including the source-only Exchange Docker context. */
export async function buildVisualizationHtml(output) {
  const template = await readFile(fileURLToPath(new URL('./visualization.html', import.meta.url)), 'utf8');
  const script = await readFile(join(output, 'visualization.js'), 'utf8');
  const escaped = script.replace(/<\/script/gi, '<\\/script');
  const marker = '<!-- visualization-runtime -->';
  if (!template.includes(marker)) throw new Error('Visualization template is missing the runtime placeholder.');
  await writeFile(join(output, 'visualization.html'), template.replace(marker, () => `<script>${escaped}</script>`));
}
