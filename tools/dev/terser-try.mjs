// Compares terser settings on the esbuild-minified bundle (deflated size is what counts).
import { build, transform } from 'esbuild';
import { minify } from 'terser';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
const cssText = { name: 'css-text', setup(b) { b.onLoad({ filter: /\.css$/ }, async (a) => { const { code } = await transform(readFileSync(a.path, 'utf8'), { loader: 'css', minify: true }); return { contents: `export default ${JSON.stringify(code.trim())};`, loader: 'js' }; }); } };
const r = await build({ entryPoints: ['src/main.ts'], bundle: true, format: 'iife', minify: true, write: false, plugins: [cssText], define: { __VERSION__: '"x"', __DEV__: 'false' }, target: ['chrome110', 'edge110', 'firefox115', 'safari16'], charset: 'utf8', legalComments: 'none' });
const es = r.outputFiles[0].text;
const D = (s) => deflateRawSync(Buffer.from(s), { level: 9 }).length;
console.log('esbuild', es.length, D(es));
const base = { passes: 3, pure_getters: false, unsafe_arrows: true, unsafe_methods: true, keep_fargs: false, drop_debugger: true };
const variants = {
  current: { compress: base },
  passes5: { compress: { ...base, passes: 5 } },
  unsafe: { compress: { ...base, unsafe: true, unsafe_comps: true, unsafe_math: true, unsafe_symbols: true, unsafe_proto: true, unsafe_regexp: true, unsafe_undefined: true } },
  pureGetters: { compress: { ...base, pure_getters: true } },
  noCompress: { compress: false },
};
for (const [k, c] of Object.entries(variants)) {
  const t = await minify(es, { ecma: 2020, module: false, toplevel: true, mangle: { toplevel: true }, format: { comments: false, ascii_only: false, wrap_func_args: false }, ...c });
  console.log(k, t.code.length, D(t.code));
}
