import { readFileSync, writeFileSync } from 'node:fs';
// Reuse the production outline, with a shorter hexagon transition for this study.
const source = readFileSync(new URL('../../scripts/build-liquid-loader.mjs', import.meta.url), 'utf8');
const base = source.slice(source.indexOf('const DUR ='), source.indexOf('const frames ='))
  .replace('HW: .34', 'HW: .10');
writeFileSync(new URL('./loader-base.mjs', import.meta.url), base + '\nexport { shell, ring, hexW, collapse };\n');
console.log('Preview geometry refreshed from the production spinner.');
