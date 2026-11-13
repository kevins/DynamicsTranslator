// The live suite (tools/e2e-suite.js) runs on either dev bundle, as its header says: the headless one
// (tools/dev/e2e-entry.ts: the provider modules' own exports) and the full app (src/main.ts: the registry of
// src/providers/index.ts). A provider it calls by a name one of them lacks only logs that step's TypeError.
import { readFileSync } from 'node:fs';
import * as bpf from '../../../src/providers/bpf';
import * as formxml from '../../../src/providers/formxml';
import { providers } from '../../../src/providers/index';
import * as metadata from '../../../src/providers/metadata';
import * as records from '../../../src/providers/records';
import * as ribbon from '../../../src/providers/ribbon';
import * as sitemap from '../../../src/providers/sitemap';
import type { Kit } from './kit';

export function register(t: Kit): void {
  const { test, eq, ok } = t;

  test('e2e suite: each provider it calls is in both dev bundles by the name it calls (a fallback: one of its two names in each; a call it guards may be in neither)', () => {
    // tools/test.mjs runs the tests bundled into node_modules/.cache/.
    const src = readFileSync(new URL('../../tools/e2e-suite.js', import.meta.url), 'utf8');
    const shapes: Record<string, Record<string, unknown>> = { 'full app': { ...providers }, headless: { ...metadata, ...records, ...formxml, ...sitemap, ...bpf, ...ribbon } };
    const has = (o: Record<string, unknown>, n: string) => typeof o[n] === 'function';
    const either = [...src.matchAll(/providers\.(\w+)\s*\|\|\s*providers\.(\w+)/g)];
    const calls = [...new Set([...src.matchAll(/providers\.(\w+)\(/g)].map((m) => m[1]))].filter((n) => !src.includes(`if (providers.${n})`));
    ok(either.some((m) => m[1] === 'loadBpf') && calls.includes('loadTables') && calls.includes('loadBpfStored'), 'the suite read: its calls found');
    const missing: string[] = [];
    for (const [shape, o] of Object.entries(shapes)) {
      for (const m of either) if (!has(o, m[1]) && !has(o, m[2])) missing.push(`${shape}: ${m[0]}`);
      for (const n of calls) if (!has(o, n)) missing.push(`${shape}: providers.${n}`);
    }
    eq(missing, []);
  });
}
