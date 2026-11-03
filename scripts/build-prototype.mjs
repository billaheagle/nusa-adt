// Bundles src/entry-prototype.ts and inlines it with the stylesheet into one HTML page.
let esbuild;
try { esbuild = await import('esbuild'); } catch { esbuild = await import('/opt/npm-tools/node_modules/esbuild/lib/main.js'); }
const { build } = esbuild.default ?? esbuild;
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const res = await build({
  entryPoints: ['src/entry-prototype.ts'], bundle: true, format: 'iife', target: 'es2020',
  minify: true, write: false, legalComments: 'none',
});
const js = res.outputFiles[0].text;
const css = readFileSync('src/ui/styles.css', 'utf8');
const cm = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16';
const html = `<title>Nusa ADT</title>
<meta name="description" content="A lightweight ABAP development workbench">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600;700&display=swap">
<style>${css}</style>
<script src="${cm}/codemirror.min.js"></script>
<script src="${cm}/addon/mode/simple.min.js"></script>
<script src="${cm}/addon/hint/show-hint.min.js"></script>
<script src="${cm}/addon/selection/active-line.min.js"></script>
<script src="${cm}/addon/edit/matchbrackets.min.js"></script>
<script>${js.replace(/<\/script/gi, '<\\/script')}</script>
`;
mkdirSync('dist', { recursive: true });
writeFileSync('dist/nusa-adt-prototype.html', html);
console.log('dist/nusa-adt-prototype.html', (html.length / 1024).toFixed(1) + ' KB');
