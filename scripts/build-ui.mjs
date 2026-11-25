import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const uiDir = resolve(rootDir, 'ui');
const distDir = resolve(rootDir, 'dist');

mkdirSync(distDir, { recursive: true });

const result = await build({
  entryPoints: [resolve(uiDir, 'app.js')],
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  minify: true,
  write: false,
  platform: 'browser',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

const jsCode = result.outputFiles[0].text.replace(/<\/script>/gi, '<\\/script>');
const cssCode = readFileSync(resolve(uiDir, 'styles.css'), 'utf-8').replace(/<\/style>/gi, '<\\/style>');
const htmlTemplate = readFileSync(resolve(uiDir, 'index.html'), 'utf-8');

const finalHtml = htmlTemplate
  .replace('/*__INLINE_CSS__*/', () => cssCode)
  .replace('/*__INLINE_JS__*/', () => jsCode);

const outPath = resolve(distDir, 'app.html');
writeFileSync(outPath, finalHtml, 'utf-8');
console.log(`[qtc-build] Built self-contained app: ${outPath} (${(Buffer.byteLength(finalHtml, 'utf8') / 1024).toFixed(1)} KB)`);
