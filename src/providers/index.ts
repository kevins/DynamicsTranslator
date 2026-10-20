// Provider registry: assembles every provider into the ProvidersApi the UI uses.

import { isLogicalName } from '../core/http';
import type { Kind, Slot } from '../core/model';
import { appSitemapId, loadSitemap, loadSitemapsScope, sitemapWriter } from './sitemap';
import { bpfWriter, loadBpfLabels, loadBpfScope, loadBpfStored } from './bpf';
import { formXmlWriter, loadFormXml, loadFormsScope } from './formxml';
import { listTables, loadMetadataScope, loadTables, metadataWriters, solutionTables } from './metadata';
import { findCommands, getForm, listSolutions, loadRecords, loadRecordsScope, recordsWriter, viewQuery } from './records';
import { loadRibbonLabels, loadRibbonScope, ribbonControls, ribbonWriter } from './ribbon';
import type { Loader, ProvidersApi, Writer } from './types';

const writers = new Map<Kind, Writer>();
for (const w of [...metadataWriters, recordsWriter, formXmlWriter, sitemapWriter, bpfWriter, ribbonWriter]) for (const k of w.kinds) writers.set(k, w);

const loaders: Loader[] = [loadMetadataScope, loadRecordsScope, loadFormsScope, loadSitemapsScope, loadBpfScope, loadRibbonScope];

export const providers: ProvidersApi = {
  async loadScope(ctx, scope, o) {
    // The scope may come from an imported file or stored settings: only logical names go on to the loaders' URLs.
    scope = { ...scope, entities: scope.entities.filter(isLogicalName) };
    const out: Slot[] = [];
    // Loaders are independent; run them together and keep partial results when one fails.
    const settled = await Promise.allSettled(loaders.map((l) => l(ctx, scope, o)));
    const errors: string[] = [];
    for (const s of settled) {
      if (s.status === 'fulfilled') out.push(...s.value);
      else if ((s.reason as Error)?.name !== 'AbortError') errors.push((s.reason as Error)?.message || String(s.reason));
    }
    if (o.signal.aborted) throw new DOMException('The operation was cancelled.', 'AbortError');
    if (errors.length && !out.length) throw new Error(errors[0]);
    if (errors.length) o.progress(`Loaded with problems: ${errors[0]}`);
    return out;
  },
  writerFor: (k) => writers.get(k),
  listTables,
  listSolutions,
  solutionTables,
  loadTables,
  loadRecords,
  findCommands,
  loadFormXml,
  getForm,
  viewQuery,
  appSitemapId,
  loadSitemap,
  loadBpf: loadBpfLabels,
  loadBpfStored,
  loadRibbonLabels,
  ribbonControls,
};
