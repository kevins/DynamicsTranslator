// Builds the translator's bookmarklet from its entry point, src/main.ts.
//   entry --esbuild--> bundle --terser--> minified --deflate-raw--> base85 --> javascript: loader
// Outputs (dist/):
//   translator.debug.js        readable bundle, handy for injecting while testing
//   translator.min.js          the exact code the bookmarklet runs
//   translator.bookmarklet.txt the javascript: URL to paste into a bookmark
// Target browser: Microsoft Edge. Measured in Edge 155: javascript: favorites run up to 2,040,060 characters and
// silently do nothing at 2,100,060 (Chromium caps URLs at 2 MiB = 2,097,152 characters when they cross processes).
// The build fails at 2,000,000 characters, leaving a margin below that cap.
import { build, transform } from 'esbuild';
import { minify } from 'terser';
import { deflateRawSync, inflateRawSync, constants } from 'node:zlib';
import zopfli from '@gfx/zopfli';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const LIMIT = 2_000_000;
const args = new Set(process.argv.slice(2));

// Imports of *.css return the minified stylesheet as a string.
const cssText = {
  name: 'css-text',
  setup(b) {
    b.onLoad({ filter: /\.css$/ }, async (a) => {
      const src = readFileSync(a.path, 'utf8');
      const { code } = await transform(src, { loader: 'css', minify: true, target: ['chrome110', 'firefox115', 'safari16'] });
      return { contents: `export default ${JSON.stringify(code.trim())};`, loader: 'js' };
    });
  },
};

// Base-85 text with an alphabet that is safe inside a javascript: URL and a single-quoted JS string:
// printable ASCII without " # % ' < > \ ` ^ (percent-decoding, URL query/fragment encoding, quoting).
const UNSAFE = new Set(['"', '#', '%', "'", '<', '>', '\\', '`', '^']);
const ALPHA = [...Array(94)].map((_, i) => String.fromCharCode(33 + i)).filter((c) => !UNSAFE.has(c)).join('');
if (ALPHA.length !== 85) throw new Error("alphabet");

/**
 * Bundles, minifies and packs the entry point into a javascript: loader. Returns the readable bundle, the minified
 * code, the packed bytes and the loader.
 */
async function pack(entry) {
  const common = {
    entryPoints: [join(root, entry)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome110', 'edge110', 'firefox115', 'safari16'],
    charset: 'utf8',
    legalComments: 'none',
    write: false,
    plugins: [cssText],
    define: { __VERSION__: JSON.stringify(pkg.version), __DEV__: args.has('--dev') ? 'true' : 'false' },
  };

  const debug = await build({ ...common, minify: false, sourcemap: false });
  const debugCode = debug.outputFiles[0].text;

  const prod = await build({ ...common, minify: true, define: { ...common.define, __DEV__: 'false' } });
  const esMin = prod.outputFiles[0].text;

  const ters = await minify(esMin, {
    ecma: 2020,
    module: false,
    toplevel: true,
    compress: { passes: 3, pure_getters: false, unsafe_arrows: true, unsafe_methods: true, keep_fargs: false, drop_debugger: true },
    mangle: { toplevel: true },
    format: { comments: false, ascii_only: false, wrap_func_args: false },
  });
  let code = ters.code;
  if (code.length > esMin.length) code = esMin; // keep whichever is smaller

  const raw = Buffer.from(code, "utf8");
  // Zopfli finds a smaller DEFLATE stream than zlib -9; the browser still inflates it natively.
  const zlibPacked = deflateRawSync(raw, { level: 9, memLevel: 9, windowBits: 15, strategy: constants.Z_DEFAULT_STRATEGY });
  const zop = await new Promise((res, rej) => zopfli.deflate(raw, { numiterations: args.has("--fast") ? 5 : 60 }, (e, r) => (e ? rej(e) : res(Buffer.from(r)))));
  const packed = zop.length < zlibPacked.length ? zop : zlibPacked;
  if (!inflateRawSync(packed).equals(raw)) throw new Error("Compression round-trip failed.");
  const pad = (4 - (packed.length % 4)) % 4;
  const padded = Buffer.concat([packed, Buffer.alloc(pad)]);
  let enc = "";
  for (let i = 0; i < padded.length; i += 4) {
    let v = padded.readUInt32BE(i);
    const g = [];
    for (let j = 0; j < 5; j++) { g.unshift(ALPHA[v % 85]); v = Math.floor(v / 85); }
    enc += g.join("");
  }
  // Round-trip the decoder exactly as the loader runs it.
  {
    const T = []; for (let i = 0; i < 85; i++) T[ALPHA.charCodeAt(i)] = i;
    const u = new Uint8Array(enc.length / 5 * 4);
    for (let i = 0, k = 0; i < enc.length; i += 5, k += 4) { let v = 0; for (let j = 0; j < 5; j++) v = v * 85 + T[enc.charCodeAt(i + j)]; u[k] = v >>> 24; u[k + 1] = v >>> 16 & 255; u[k + 2] = v >>> 8 & 255; u[k + 3] = v & 255; }
    if (!Buffer.from(u.subarray(0, packed.length)).equals(packed)) throw new Error("Base-85 round-trip failed.");
  }

  // The loader decompresses with DecompressionStream, then runs the code with indirect eval.
  // Pages whose CSP blocks eval fall back to a blob: script.
  const loader =
    "javascript:void(async()=>{try{const A='" + ALPHA + "',d='" + enc + "',T=[],u=new Uint8Array(d.length/5*4);" +
    "for(let i=0;i<85;i++)T[A.charCodeAt(i)]=i;for(let i=0,k=0;i<d.length;i+=5,k+=4){let v=0;for(let j=0;j<5;j++)v=v*85+T[d.charCodeAt(i+j)];" +
    "u[k]=v>>>24;u[k+1]=v>>>16&255;u[k+2]=v>>>8&255;u[k+3]=v&255}" +
    "const t=await new Response(new Blob([u.subarray(0," + packed.length + ")]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();" +
    "try{(0,eval)(t)}catch(e){if(!(e instanceof EvalError))throw e;const s=document.createElement('script');" +
    "s.src=URL.createObjectURL(new Blob([t],{type:'text/javascript'}));s.onerror=()=>alert('This page does not allow the translator to run.');" +
    "document.head.appendChild(s)}}catch(e){alert('The translator could not start: '+(e&&e.message||e))}})()";
  return { debugCode, code, packed, loader };
}

mkdirSync(dist, { recursive: true });
const r = await pack('src/main.ts');
writeFileSync(join(dist, 'translator.debug.js'), r.debugCode);
writeFileSync(join(dist, 'translator.min.js'), r.code);
writeFileSync(join(dist, 'translator.bookmarklet.txt'), r.loader);

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(`translator: bundle (readable) ${kb(r.debugCode.length)} | minified ${kb(r.code.length)} | deflated ${kb(r.packed.length)} | bookmarklet ${r.loader.length.toLocaleString('en-US')} bytes (${kb(r.loader.length)})`);
if (r.loader.length >= LIMIT) {
  console.error(`FAIL: the translator bookmarklet is ${r.loader.length} characters; Edge needs it under ${LIMIT}.`);
  process.exit(1);
}
console.log(`OK: ${(LIMIT - r.loader.length).toLocaleString('en-US')} characters below the Edge limit.`);
