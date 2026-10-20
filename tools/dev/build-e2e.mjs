import { build } from 'esbuild';
await build({ entryPoints: ['tools/dev/e2e-entry.ts'], bundle: true, format: 'iife', target: 'chrome110', outfile: 'dist/e2e-bundle.js', define: { __DEV__: 'true', __VERSION__: '"dev"' }, loader: { '.css': 'text' }, logLevel: 'warning' });
console.log('built dist/e2e-bundle.js');
import { copyFileSync } from 'node:fs';
copyFileSync('tools/e2e-suite.js', 'dist/e2e-suite.js');
console.log('copied dist/e2e-suite.js');
copyFileSync('tools/e2e-page.js', 'dist/e2e-page.js');
console.log('copied dist/e2e-page.js');
// The loader page tools/serve.mjs serves next to them (see its header for the address to open).
copyFileSync('tools/dev/bridge.html', 'dist/bridge.html');
console.log('copied dist/bridge.html');
