import { build, transform } from 'esbuild';
import { cp, copyFile, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../chrome-extension/', import.meta.url));
const output = `${source}dist/`;
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
  entryPoints: { background: `${source}background.ts`, sidepanel: `${source}sidepanel.ts`,
    elementPicker: `${source}elementPicker.ts`,
    chat: `${source}../preview-src/chat.ts`, codicon: `${source}../node_modules/@vscode/codicons/dist/codicon.css` },
  outdir: output, bundle: true, platform: 'browser', format: 'iife', target: 'chrome116', logLevel: 'info',
  loader: { '.ttf': 'dataurl', '.csv': 'text' },
});
await Promise.all(['manifest.json', 'sidepanel.html', 'sidepanel.css'].map(file => copyFile(`${source}${file}`, `${output}${file}`)));
await copyFile(`${source}../media/chat.css`, `${output}chat.css`);
await copyFile(`${source}../media/liquid-loader.css`, `${output}liquid-loader.css`);
await copyFile(`${source}../media/appearance.css`, `${output}appearance.css`);
await cp(`${source}icons/`, `${output}icons/`, { recursive: true });

// Package the exact CDP overlay as a static content script: Chrome never evaluates a string.
const compiled = await transform(await readFile(`${source}../src/browser/annotationScript.ts`, 'utf8'), { loader: 'ts', format: 'esm' });
const { annotationSource } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);
await writeFile(`${output}annotationOverlay.js`, `(() => {
  if (!globalThis.__aiBrowserChromeAnnotationEvents) {
    const events = [];
    globalThis.__aiBrowserChromeAnnotationEvents = events;
    globalThis.__aiBrowserAnnotationChanged = value => {
      const event = JSON.parse(value);
      // A complete snapshot is collected on every poll. Only user intents need a queue.
      if (event.type === 'copy' || event.type === 'requestDelete') {
        if (events.length < 50) events.push({ type: event.type, id: event.id, url: event.url });
      }
    };
  }
  ${annotationSource};
})();`);
