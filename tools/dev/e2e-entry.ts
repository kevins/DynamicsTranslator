// Dev-only bundle: exposes the finished providers + saver for live tests before the UI exists.
import { createCtx } from '../../src/core/context';
import { LangSession } from '../../src/core/langsession';
import { Store } from '../../src/core/store';
import { createSaver } from '../../src/core/saver';
import * as metadata from '../../src/providers/metadata';
import * as records from '../../src/providers/records';
import * as formxml from '../../src/providers/formxml';
import * as sitemap from '../../src/providers/sitemap';
import * as bpf from '../../src/providers/bpf';
import * as ribbon from '../../src/providers/ribbon';
import type { Kind } from '../../src/core/model';
import type { Writer } from '../../src/providers/types';

(async () => {
  const ctx = await createCtx();
  const store = new Store();
  const lang = new LangSession(ctx, (l) => console.log('[dxt] lang', l));
  const writers = new Map<Kind, Writer>();
  for (const w of [...metadata.metadataWriters, records.recordsWriter, formxml.formXmlWriter, sitemap.sitemapWriter, bpf.bpfWriter, ribbon.ribbonWriter]) for (const k of w.kinds) writers.set(k, w);
  const saver = createSaver(ctx, store, lang, (k) => writers.get(k));
  const providers = { ...metadata, ...records, ...formxml, ...sitemap, ...bpf, ...ribbon };
  (window as any).__dxtDev = { ctx, store, lang, providers, app: { saver }, ready: true };
  console.log('[dxt] dev ready');
})();
