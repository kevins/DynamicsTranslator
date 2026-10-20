import { build, transform } from 'esbuild';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
const cssText = { name: 'css-text', setup(b) { b.onLoad({ filter: /\.css$/ }, async (a) => { const { code } = await transform(readFileSync(a.path, 'utf8'), { loader: 'css', minify: true }); return { contents: `export default ${JSON.stringify(code.trim())};`, loader: 'js' }; }); } };
const r = await build({ entryPoints: ['src/main.ts'], bundle: true, format: 'iife', minify: true, write: false, metafile: true, plugins: [cssText], define: { __VERSION__: '"x"', __DEV__: 'false' }, target: 'chrome110' });
const out = Object.values(r.metafile.outputs)[0];
const rows = Object.entries(out.inputs).map(([f, v]) => [f, v.bytesInOutput]).sort((a, b) => b[1] - a[1]);
let tot = 0; for (const [, b] of rows) tot += b;
for (const [f, b] of rows) console.log(String(b).padStart(7), (b / tot * 100).toFixed(1).padStart(5) + '%', f);
console.log('total', tot);
// estimate compressed contribution per file by deflating each file's minified output chunk separately
