// npm test: offline unit tests (tools/dev/unit.ts) plus a check that the built bookmarklet decodes to
// exactly dist/translator.min.js when its loader runs. Live tests: tools/e2e-suite.js.
import { build } from 'esbuild';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// One bundle per run (its process id): two runs at once never load each other's half-written file.
const out = join(root, 'node_modules', '.cache', `dxt-unit-${process.pid}.mjs`);
mkdirSync(dirname(out), { recursive: true });

// xmldom stands in for the browser's DOMParser; it lacks `children`/`firstElementChild`, which the code uses.
const elProto = Object.getPrototypeOf(new DOMParser().parseFromString('<a/>', 'application/xml').documentElement);
const def = (name, get) => Object.getOwnPropertyDescriptor(elProto, name) || Object.defineProperty(elProto, name, { get, configurable: true });
def('children', function () { return Array.from(this.childNodes).filter((n) => n.nodeType === 1); });
def('firstElementChild', function () { return this.children[0] || null; });
def('lastElementChild', function () { const c = this.children; return c[c.length - 1] || null; });
def('nextElementSibling', function () { let n = this.nextSibling; while (n && n.nodeType !== 1) n = n.nextSibling; return n; });
globalThis.DOMParser = class extends DOMParser {
  parseFromString(s, t) {
    // Report malformed XML like browsers do (a <parsererror> element) instead of printing warnings.
    let bad = '';
    const d = new DOMParser({ onError: (lvl, msg) => { if (lvl !== 'warning') bad ||= msg; } }).parseFromString(s, t);
    if (bad) return new DOMParser().parseFromString(`<parsererror>${bad.replace(/[<&]/g, '')}</parsererror>`, t);
    return d;
  }
};
globalThis.XMLSerializer = XMLSerializer;

await build({
  entryPoints: [join(root, 'tools/dev/unit.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: out,
  define: { __DEV__: 'false', __VERSION__: '"test"' },
  loader: { '.css': 'text' },
  logLevel: 'warning',
});
console.log('Unit tests');
let fail;
try {
  fail = await (await import(pathToFileURL(out).href + '?' + Date.now())).run();
} finally {
  rmSync(out, { force: true });
}

// Every view shares one shadow root with ui/styles.css, so a state class a view toggles must not also be a
// bare global class there: the inspector's selected row once got the select box's .sel width and height.
{
  console.log('Stylesheets');
  const { readdirSync, statSync } = await import('node:fs');
  const css = readFileSync(join(root, 'src/ui/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const global = new Set();
  for (const sel of css.split('{').map((s) => s.slice(s.lastIndexOf('}') + 1)))
    for (const part of sel.split(',')) {
      const m = part.trim().match(/^\.([\w-]+)(?=$|[:[])/);
      if (m) global.add(m[1]);
    }
  const clash = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts'))
        for (const m of readFileSync(p, 'utf8').matchAll(/classList\.(?:toggle|add|remove)\('([\w-]+)'/g)) if (global.has(m[1])) clash.push(`${p.slice(root.length + 1)}: .${m[1]}`);
    }
  };
  walk(join(root, 'src'));
  const pass = global.size > 50 && !clash.length;
  console.log(`  ${pass ? '✓' : '✗'} no toggled state class is also a global class${clash.length ? ` (${clash.join(', ')})` : ''}`);
  if (!pass) fail++;
  // The same shadow root also holds every component stylesheet: a component rule that starts with a bare class
  // of ui/styles.css (the page list once used .pl, the review dialog's list) restyles that widget everywhere.
  const own = [];
  const sheets = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) sheets(p);
      else if (p.endsWith('.css') && !p.endsWith(join('ui', 'styles.css'))) {
        const text = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const sel of text.split('{').map((s) => s.slice(s.lastIndexOf('}') + 1)))
          for (const part of sel.split(',')) {
            const m = part.trim().match(/^\.([\w-]+)(?=$|[\s.:[>+~])/);
            if (m && global.has(m[1]) && !part.trim().startsWith('@')) own.push(`${p.slice(root.length + 1)}: .${m[1]}`);
          }
      }
    }
  };
  sheets(join(root, 'src'));
  const uniq = [...new Set(own)];
  console.log(`  ${uniq.length ? '✗' : '✓'} no component stylesheet restyles a global class${uniq.length ? ` (${uniq.join(', ')})` : ''}`);
  if (uniq.length) fail++;
  // The other way round: the shared dialogs (src/ui) open over every view, so a class they use must not be one a
  // view's stylesheet styles bare (the Workbench's root .wb once turned the Publish dialog's diff into a column).
  // Stylesheets of views with their own shadow root (the page overlay) can't reach the dialogs.
  const viewBare = new Map();
  const views = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) views(p);
      else if (p.endsWith('.css') && !p.startsWith(join(root, 'src', 'ui'))) {
        const ts = p.replace(/\.css$/, '.ts');
        if (existsSync(ts) && /attachShadow\(/.test(readFileSync(ts, 'utf8'))) continue;
        const text = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const sel of text.split('{').map((s) => s.slice(s.lastIndexOf('}') + 1)))
          for (const part of sel.split(',')) {
            const m = part.trim().match(/^\.([\w-]+)(?=$|[\s.:[>+~])/);
            if (m) viewBare.set(m[1], p.slice(root.length + 1));
          }
      }
    }
  };
  views(join(root, 'src'));
  const used = [];
  for (const f of readdirSync(join(root, 'src', 'ui')).filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(join(root, 'src', 'ui', f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    for (const m of text.matchAll(/'([^'\n]*)'|"([^"\n]*)"/g))
      for (const tok of (m[1] ?? m[2]).split(/\s+/)) if (viewBare.has(tok)) used.push(`src/ui/${f}: '${tok}' (${viewBare.get(tok)})`);
  }
  const usedU = [...new Set(used)];
  console.log(`  ${usedU.length ? '✗' : '✓'} the shared dialogs use no class a view's stylesheet styles bare${usedU.length ? ` (${usedU.join(', ')})` : ''}`);
  if (usedU.length) fail++;
}

// The loader must reproduce dist/translator.min.js exactly (decode → inflate → eval).
const txt = join(root, 'dist/translator.bookmarklet.txt');
if (!existsSync(txt)) console.log('(no dist/translator.bookmarklet.txt yet: run npm run build first to test its loader)');
else {
  console.log('Bookmarklet loader');
  const url = readFileSync(txt, 'utf8');
  const min = readFileSync(join(root, 'dist/translator.min.js'), 'utf8');
  let got = null;
  let alerted = null;
  const sandbox = { Uint8Array, Response, Blob, DecompressionStream, alert: (m) => (alerted = m), document: {}, URL };
  sandbox.eval = (t) => (got = t);
  vm.createContext(sandbox);
  vm.runInContext(decodeURIComponent(url.replace(/^javascript:/, '').replace(/%(?![0-9a-f]{2})/gi, '%25')), sandbox);
  for (let i = 0; i < 1000 && got === null && alerted === null; i++) await new Promise((r) => setTimeout(r, 20));
  const data = (url.match(/,d='([^']*)'/) || [])[1] || '';
  const checks = [
    ['decodes to exactly translator.min.js' + (alerted ? ` (alert: ${alerted})` : ''), got === min],
    ['data uses only URL- and quote-safe characters', data.length > 1000 && !/[\s"#%'<>\\`^]/.test(data)],
    [`under the 2,000,000-character Edge limit (${url.length.toLocaleString('en-US')})`, url.length < 2000000],
  ];
  for (const [what, pass] of checks) {
    console.log(`  ${pass ? '✓' : '✗'} ${what}`);
    if (!pass) fail++;
  }
}
process.exit(fail ? 1 : 0);
