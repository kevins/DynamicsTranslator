// Business process flow stage and step labels.
//
// Verified live: every language of a stage or step label is stored inline as StepLabel entries keyed by
// LabelId + LanguageCode, in BOTH workflow.xaml and workflow.clientdata. PATCHing both keeps a new
// language even on an activated BPF, without deactivating it (~9 s per PATCH). The xaml is edited by
// string splicing only, because a DOM round trip loses the utf-16 declaration and adds xmlns attributes
// (reported to fail with "Error generating UiData"): every byte outside the StepLabel tags being added,
// changed or removed stays identical, whitespace included.
//
// Nothing guards the definition between the writer's read and its PATCH (the process PATCH refuses If-Match,
// LIVE-FINDINGS 29). So the PATCH goes in one $batch between two reads of the definition: a save someone else made in
// between shows in the first one (a $batch runs its parts in order), and their definition is written back with only
// these labels on it (providers/repair.ts); a label they changed too keeps their text and is a conflict.
//
// What the page shows is not always in the definition (LIVE-FINDINGS 83, 85): once Dynamics has stored a stage or
// step translation it keeps showing it after that language's StepLabel is removed, until a StepLabel in that
// language replaces it. Such a text is read per language from GetClientMetadata, the request the page makes for
// the process (answered in the caller's UI language only, so through LangSession), and fills the languages the
// definition lacks (`ref.stored`, model.ts keeps). Saving one writes its StepLabel as usual, measured against that
// text. Clearing a translation, kept or in the definition, is refused (model.ts stays), as Dynamics would go on
// showing it; the writer's removal (that language's StepLabel tag out of every xaml collection of the label and its
// entry out of every clientdata stepLabels list) only runs where no translation was loaded (see clears).

import type { Ctx } from '../core/context';
import { DvError, abortError, guid, isAbort, isGuid, mayHaveRun, partError, pause, turnedAway, type BatchPart, type PartResult } from '../core/http';
import { pick } from '../core/labels';
import { LangSession } from '../core/langsession';
import { lcidName } from '../core/lcid';
import { MANAGED, canClear, cantClearText, isManaged, keeps, type Change, type ChangeResult, type Labels, type Lcid, type Slot } from '../core/model';
import { blank, presentLabels, xmlAttr } from '../core/xml';
import { Unsent, olderVersion, settle, type DocOps, type Sent } from './repair';
import { changeId, check, type LoadOptions, type Loader, type ProcessPage, type SaveOptions, type Writer } from './types';

/** One StepLabel: a clientdata `stepLabels.list` entry, or a decoded xaml tag. */
interface Entry {
  labelId?: unknown;
  languageCode?: unknown;
  description?: unknown;
}
interface Tag extends Entry {
  labelId: string;
  description: string;
  prefix: string;
  s: number;
  end: number;
  text: string;
}
/** LabelId -> every StepLabels collection (xaml) or stepLabels.list (clientdata) holding that label. */
type Index<T> = Map<string, T[][]>;
interface Doc {
  xaml: string;
  cdText: string | null;
  cd: any;
  x: Index<Tag>;
  c: Index<Entry>;
  etag: string;
  /** The row's versionnumber: a read showing a lower one than an earlier read lags behind it (providers/repair.ts). */
  ver?: unknown;
  /** The process is from a managed solution (workflow.ismanaged): its labels are never written. */
  managed: boolean;
}
interface Item {
  kind: 'stage' | 'step';
  id: string;
  stage: string;
  entity: string;
  field?: string;
  display?: string;
}

const SELECT = 'name,primaryentity,ismanaged,iscustomizable,xaml,clientdata,versionnumber';
const UNSAFE = 'Safety check failed: the change would have modified more than the translated labels, so nothing was saved.';
const TAG = /<(\w+):StepLabel\b((?:"[^"]*"|'[^']*'|[^>"'])*?)\/>/g;
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * XAML reads an attribute value that starts with { as a markup extension ({Binding …}) unless "{}" comes first, the escape
 * XAML writers put there. So a StepLabel's Description is written with it when the text starts with {, and read without it.
 */
const xamlText = (s: string): string => (s.startsWith('{') ? '{}' + s : s);
const unXamlText = (s: string): string => (s.startsWith('{}') ? s.slice(2) : s);

const unxml = (s: string): string =>
  s.replace(/&(?:#(x?)([\da-f]+)|(\w+));/gi, (m, x: string, n: string, e: string) => {
    if (e) return ENT[e] ?? m;
    const c = parseInt(n, x ? 16 : 10);
    return c <= 0x10ffff ? String.fromCodePoint(c) : m;
  });

const is = (e: Entry, id: string, lcid?: number): boolean => guid(e.labelId) === id && (lcid === undefined || Number(e.languageCode) === lcid);
const lid = (c: Change): string => guid(c.slot.ref.labelId);

function add<T extends Entry>(m: Index<T>, list: T[], owner = ''): void {
  for (const id of new Set([owner, ...list.map((e) => guid(e.labelId))])) if (id) (m.get(id) ?? m.set(id, []).get(id)!).push(list);
}

function labelsOf(m: Index<Entry>, id: string): Labels {
  const out: Labels = {};
  for (const l of m.get(id) || []) for (const e of l) if (is(e, id) && Number(e.languageCode)) out[Number(e.languageCode)] ??= String(e.description ?? '');
  return out;
}

/** Server value of a label: clientdata preferred, gaps filled from the xaml. */
const cur = (d: Doc, id: string): Labels => ({ ...labelsOf(d.x, id), ...labelsOf(d.c, id) });

/** True when every collection holding the label has `text` in `lcid`. */
const holds = (m: Index<Entry>, id: string, lcid: number, text: string): boolean =>
  (m.get(id) || []).every((l) => l.some((e) => is(e, id, lcid) && e.description === text));

/** True when no collection holding the label has an entry in `lcid` (a removed translation). */
const lacks = (m: Index<Entry>, id: string, lcid: number): boolean => (m.get(id) || []).every((l) => !l.some((e) => is(e, id, lcid)));

/** Number of StepLabel tags in a xaml text, however they are written. */
const tagCount = (xaml: string): number => (xaml.match(/<\w+:StepLabel\b/g) || []).length;

/** StepLabel tags grouped by collection: tags separated only by whitespace share one. */
function scan(xaml: string): Tag[][] {
  const out: Tag[][] = [];
  let prev = -1;
  for (const m of xaml.matchAll(TAG)) {
    const a: Record<string, string> = {};
    for (const [, k, dq, sq] of m[2].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) a[k] = unxml(dq ?? sq);
    const t: Tag = { labelId: a.LabelId ?? '', languageCode: Number(a.LanguageCode), description: unXamlText(a.Description ?? ''), prefix: m[1], s: m.index, end: m.index + m[0].length, text: m[0] };
    if (prev >= 0 && !xaml.slice(prev, t.s).trim()) out[out.length - 1].push(t);
    else out.push([t]);
    prev = t.end;
  }
  // A StepLabel the pattern missed (e.g. not self-closing) could be duplicated by an insert.
  if (out.flat().length !== tagCount(xaml)) throw new Error('This process stores its labels in a format the translator does not recognize.');
  return out;
}

function parse(w: any): Doc {
  const xaml = String(w.xaml || '');
  const cdText: string | null = w.clientdata || null;
  let cd: any = null;
  try {
    cd = cdText && JSON.parse(cdText);
  } catch {
    /* unreadable clientdata: the loader falls back to the xaml, the writer refuses */
  }
  const x: Index<Tag> = new Map();
  for (const g of scan(xaml)) add(x, g);
  const c: Index<Entry> = new Map();
  const visit = (v: any): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v.stepLabels?.list)) add(c, v.stepLabels.list, guid(v.stageId ?? v.stepStepId));
    for (const k in v) visit(v[k]);
  };
  visit(cd);
  return { xaml, cdText, cd, x, c, etag: w['@odata.etag'], ver: w.versionnumber, managed: w.ismanaged === true };
}

/** Stages and steps in tree order. A step's ControlStep child names its column. */
function walk(v: any, stage: string, entity: string, out: Item[]): void {
  if (!v || typeof v !== 'object') return;
  const cls = String(v.__class || '');
  if (cls.startsWith('EntityStep') && /^\w+$/.test(v.description || '')) entity = v.description;
  if (cls.startsWith('StageStep') && v.stageId) out.push({ kind: 'stage', id: (stage = guid(v.stageId)), stage, entity });
  if (cls.startsWith('StepStep') && v.stepStepId) {
    const ctl = (v.steps?.list || []).find((s: any) => String(s?.__class).startsWith('ControlStep'));
    out.push({ kind: 'step', id: guid(v.stepStepId), stage, entity, field: ctl?.dataFieldName || undefined, display: ctl?.controlDisplayName || undefined });
  }
  for (const k in v) if (k !== 'stepLabels') walk(v[k], stage, entity, out);
}

/** Stage and step slots of one BPF (its name and description are 'bpf' record slots, loaded elsewhere). */
export async function loadBpfLabels(ctx: Ctx, workflowId: string, o: LoadOptions): Promise<Slot[]> {
  const id = guid(workflowId);
  if (!isGuid(id)) throw new Error('This business process flow could not be read: its id is not valid.');
  const w = await ctx.http.get(`workflows(${id})?$select=${SELECT}`, { signal: o.signal });
  const d = parse(w);
  const primary = String(w.primaryentity || '');
  const items: Item[] = [];
  walk(d.cd, '', primary, items);
  if (!items.length) {
    // No usable clientdata: classify the xaml labels by the stage and step ids stored next to them.
    const ids = (k: string) => new Set(Array.from(d.xaml.matchAll(new RegExp(`Key="${k}">\\s*([^<\\s]+)`, 'g')), (m) => guid(m[1])));
    const stages = ids('StageId');
    const steps = ids('ProcessStepId');
    for (const l of d.x.keys()) if (stages.has(l) || steps.has(l)) items.push({ kind: stages.has(l) ? 'stage' : 'step', id: l, stage: '', entity: primary });
  }
  const name = String(w.name || 'Business process flow');
  // A process from a managed solution is read-only whatever its managed properties allow: a translation would be an
  // unmanaged layer on top of it (workflows are "top wins"). Managed properties only bind managed layers.
  const readOnly = d.managed ? MANAGED : '';
  const stageTitles = new Map<string, string>();
  const out = new Map<string, Slot>();
  for (const n of items) {
    const comp = `${n.kind}|${id}|${n.id}`;
    if (out.has(comp)) continue;
    const labels = presentLabels(cur(d, n.id)); // a label stored as '' counts as missing
    const title = pick(labels, ctx.user, ctx.base) || n.display || n.field || `Untitled ${n.kind}`;
    if (n.kind === 'stage') stageTitles.set(n.id, title);
    out.set(comp, {
      key: `${comp}|Label`,
      kind: n.kind,
      prop: 'Label',
      entity: n.entity,
      comp,
      group: `bpfxaml|${id}`,
      title,
      path: n.kind === 'step' && stageTitles.has(n.stage) ? [name, stageTitles.get(n.stage)!] : [name],
      sub: n.field || (n.entity !== primary ? n.entity : ''),
      labels,
      readOnly,
      baseRequired: true,
      // Stage names become processstage.stagename (100); 500 is the translation file limit.
      max: n.kind === 'stage' ? 100 : 500,
      order: out.size,
      // managed: the process is from a managed solution, so its labels are read-only (never an unmanaged layer on it).
      // primary: the process's table, whose records GetClientMetadata answers for (loadBpfStored).
      ref: { workflowId: id, labelId: n.id, attribute: n.field, stageId: n.stage || undefined, primary, managed: d.managed },
    });
  }
  return [...out.values()];
}

const GUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

/**
 * The request the page makes for a process on a record of its table (LIVE-FINDINGS 85). Its answer carries the
 * process's names in the caller's UI language only.
 */
export function clientMetadataPart(entity: string, record: string, app: string): BatchPart {
  const q = { MetadataType: 'businessprocessflow', EntityLogicalName: entity, MetadataId: record, GetDefault: false, ...(app ? { AppId: app } : {}) };
  return {
    method: 'GET',
    url: `GetClientMetadata(ClientMetadataQuery=@q)?@q=${encodeURIComponent(JSON.stringify(q))}`,
    headers: { 'x-ms-metadatareductionlevel': '5', ClientHost: 'Browser' },
  };
}

/**
 * The names in a GetClientMetadata answer, by label id (LIVE-FINDINGS 85): its metadata is a JSON string inside the
 * answer's JSON (so escaped twice, "\u00c9" for "É"), holding `Labels` lists of {Id, LabelColumnName, Value}. Only
 * the `column` texts (a stage's or step's name is its 'description'); a blank one counts as none.
 */
export function clientLabels(answer: unknown, column = 'description'): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (v: unknown, depth: number): void => {
    if (typeof v === 'string') {
      if (depth < 4 && /^\s*[[{]/.test(v))
        try {
          visit(JSON.parse(v), depth + 1);
        } catch {
          /* a text that only starts like JSON */
        }
      return;
    }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.Labels))
      for (const e of o.Labels as Array<Record<string, unknown> | null>) {
        const id = guid(e?.Id);
        if (id && typeof e?.Value === 'string' && e.Value.trim() && String(e.LabelColumnName).toLowerCase() === column && !out.has(id)) out.set(id, e.Value);
      }
    for (const k in o) if (k !== 'Labels') visit(o[k], depth);
  };
  visit(answer, 0);
  return out;
}

/** A slot's labels from the definition: without the languages an earlier read filled in (ref.stored). */
function own(s: Slot): Labels {
  const out = { ...s.labels };
  for (const l of Array.isArray(s.ref?.stored) ? (s.ref.stored as Lcid[]) : []) delete out[l];
  return out;
}

/**
 * Fills each stage and step slot's languages the definition has no label in with the name Dynamics shows there from
 * its own store (`read`: language -> label id -> text, see clientLabels), and lists them in `ref.stored`. The
 * definition wins; a text equal to the base-language one counts too (Dynamics shows it). Languages not in `read`
 * keep what an earlier read filled. Titles, and the stage names in the steps' paths, follow the user's language.
 */
export function withStored(ctx: Ctx, slots: Slot[], read: Map<Lcid, Map<string, string>>): Slot[] {
  const titles = new Map<string, string>();
  const out = slots.map((s): Slot => {
    const labels = own(s);
    const stored = (Array.isArray(s.ref?.stored) ? (s.ref.stored as Lcid[]) : []).filter((l) => !read.has(l) && s.labels[l] !== undefined);
    for (const l of stored) labels[l] = s.labels[l];
    for (const [l, texts] of read) {
      const v = texts.get(guid(s.ref?.labelId));
      if (v !== undefined && !labels[l]) {
        labels[l] = v;
        stored.push(l);
      }
    }
    const title = pick(labels, ctx.user, ctx.base) || s.title;
    if (s.kind === 'stage') titles.set(guid(s.ref?.labelId), title);
    return { ...s, labels, title, ref: { ...s.ref, stored: stored.sort((a, b) => a - b) } };
  });
  return out.map((s) => {
    const t = s.kind === 'step' && s.path.length > 1 ? titles.get(guid(s.ref?.stageId)) : undefined;
    return t === undefined ? s : { ...s, path: [s.path[0], t, ...s.path.slice(2)] };
  });
}

/**
 * Another load of stages and steps whose names Dynamics keeps were read before (`get`: the store's slot by key, with
 * `ref.stored`), carrying those names over, as mergeUsedBy (inspector/pageload.ts) carries a choice's columns. A load
 * of the definition only (the Workbench's, the page's before the read it passes them through) would drop them: the popups would show the
 * English text again, a save would be measured against nothing and a clear would pass. Such a slot gets the earlier
 * read's names in the languages its definition lacks, its `ref.stored` and its `ref.unread`; a slot from a read of
 * its own only the languages that read missed (`ref.unread`). The definition wins, as in withStored, and titles and
 * step paths follow. Slots never read before are left as they are.
 */
export function mergeStored(ctx: Ctx, slots: Slot[], get: (key: string) => Slot | undefined): Slot[] {
  const prep = new Map<string, Slot>();
  for (const s of slots) {
    const o = s.kind === 'stage' || s.kind === 'step' ? get(s.key) : undefined;
    if (!o || !Array.isArray(o.ref?.stored)) continue;
    const read = Array.isArray(s.ref?.stored);
    const open: Lcid[] = read ? (Array.isArray(s.ref.unread) ? s.ref.unread : []) : o.ref.stored;
    const add = (o.ref.stored as Lcid[]).filter((l) => open.includes(l) && o.labels[l] && !s.labels[l]);
    if (read && !add.length) continue;
    const labels = { ...s.labels };
    for (const l of add) labels[l] = o.labels[l];
    const ref = read ? { ...s.ref, stored: [...s.ref.stored, ...add] } : { ...s.ref, stored: add, ...(Array.isArray(o.ref.unread) ? { unread: o.ref.unread } : {}) };
    prep.set(s.key, { ...s, labels, ref });
  }
  if (!prep.size) return slots;
  // Nothing new read: withStored only sets the titles and paths from the languages now listed.
  const out = new Map(withStored(ctx, [...prep.values()], new Map()).map((s) => [s.key, s]));
  return slots.map((s) => out.get(s.key) ?? s);
}

/**
 * The stage and step names Dynamics shows in the languages a process's definition has none in (LIVE-FINDINGS 83,
 * 85): GetClientMetadata for the page's record, once per such language, each through LangSession (a switch window
 * for another language, none for the user's own, read first). `slots` are loadBpfLabels' slots of one process; they
 * come back with those names filled in (withStored). Only for a record of the process's own table (a cross-table
 * process on a later stage's table is left as it is). Without `o.lang` only the user's own language is read. A
 * language whose answer failed or was not proven to be in it is left out, listed in `missed` and in each slot's
 * `ref.unread` (so a later page load reads it again).
 */
export async function loadBpfStored(ctx: Ctx, slots: Slot[], page: ProcessPage, o: LoadOptions): Promise<{ slots: Slot[]; missed: Lcid[] }> {
  const primary = String(slots[0]?.ref?.primary || '');
  const record = guid(page.record);
  if (!primary || primary.toLowerCase() !== page.entity.toLowerCase() || !GUID.test(record)) return { slots, missed: [] };
  const need = ctx.langs
    .map((l) => l.lcid)
    .filter((l) => (o.lang || l === ctx.user) && slots.some((s) => !own(s)[l]))
    .sort((a, b) => Number(b === ctx.user) - Number(a === ctx.user));
  const lang = o.lang ?? LangSession.of(ctx) ?? new LangSession(ctx);
  const part = clientMetadataPart(primary, record, guid(page.app));
  const read = new Map<Lcid, Map<string, string>>();
  const missed: Lcid[] = [];
  // One language at a time, each in a hold of its own: the page's other language-sensitive work runs in between.
  for (const L of need) {
    try {
      const b = await lang.hold((h) => h.batch(L, [part], o.signal), o.signal);
      // An answer not proven to be in L would put another language's names there.
      if (b.inLang && b.results[0]?.ok) read.set(L, clientLabels(b.results[0].data));
      else missed.push(L);
    } catch (e) {
      if (isAbort(e) || o.signal.aborted) throw e;
      missed.push(L);
    }
  }
  const out = withStored(ctx, slots, read);
  // What this read missed, and only that: slots carrying an earlier read's names (mergeStored) bring its misses along.
  return {
    slots: out.map((s) => {
      const { unread: _, ...ref } = s.ref || {};
      return { ...s, ref: missed.length ? { ...ref, unread: missed } : ref };
    }),
    missed,
  };
}

/** BPFs on the scope's tables, plus (with a solution) the BPFs in that solution. */
export const loadBpfScope: Loader = async (ctx, scope, o) => {
  if (!scope.kinds.has('stage') && !scope.kinds.has('step')) return [];
  const ents = new Set(scope.entities);
  const [flows, inSolution] = await Promise.all([
    ctx.http.all('workflows?$select=workflowid,primaryentity,ismanaged,iscustomizable,businessprocesstype&$filter=category eq 4 and type eq 1', { signal: o.signal }),
    scope.solutionId
      ? ctx.http
          .all(`solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${guid(scope.solutionId)} and componenttype eq 29`, { signal: o.signal })
          .then((r) => new Set(r.map((x) => guid(x.objectid))))
      : null,
  ]);
  const ids = flows
    .filter(
      (w) =>
        w.businessprocesstype !== 1 && // task flows have pages, not stages
        (scope.includeReadOnly || w.ismanaged !== true) && // read-only: from a managed solution
        (ents.has(w.primaryentity) || inSolution?.has(guid(w.workflowid))),
    )
    .map((w) => guid(w.workflowid));
  let done = 0;
  const res = await Promise.allSettled(ids.map((id) => loadBpfLabels(ctx, id, o).finally(() => o.progress('Loading business process flows', ++done, ids.length))));
  if (o.signal.aborted) throw abortError();
  const bad = res.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (bad.length && bad.length === res.length) throw bad[0].reason;
  if (bad.length) o.progress(`${bad.length} business process flow${bad.length > 1 ? 's' : ''} could not be loaded: ${(bad[0].reason as Error)?.message}`);
  return res.flatMap((r) => (r.status === 'fulfilled' ? r.value.filter((s) => scope.kinds.has(s.kind)) : []));
};

const attr = (text: string) => `Description="${xmlAttr(xamlText(text))}"`;

/**
 * A non-base translation saved empty (or as only spaces) is removed, so that language shows the base text. Only one
 * nobody loaded gets here (none to remove, or one added since: a conflict); a loaded one is refused in save().
 */
const clears = (ctx: Ctx, c: Change): boolean => c.lcid !== ctx.base && !c.after.trim();

/**
 * The name Dynamics shows from its own store where the definition has no label (model.ts keeps), as loaded: what a
 * change of it is measured against, as the definition has nothing to compare with. undefined for any other language.
 */
const kept = (c: Change): string | undefined => (keeps(c.slot, c.lcid) ? c.slot.labels[c.lcid] : undefined);

/**
 * Whether a document holds a change: its text in that language in every collection of the label, or, for
 * a removal (`remove`), no entry in that language anywhere. Checked before writing and after.
 */
const settled = (d: Doc, c: Change, remove: boolean): boolean =>
  remove
    ? lacks(d.x, lid(c), c.lcid) && lacks(d.c, lid(c), c.lcid)
    : d.x.has(lid(c)) && holds(d.x, lid(c), c.lcid, c.after) && holds(d.c, lid(c), c.lcid, c.after);

/**
 * check() with blank values treated alike, so a label stored as '' or as spaces is no conflict for a user who
 * saw no text (the store keeps '' for a cleared label). `server` is the current value (undefined when there is
 * none). A change is 'unchanged' only when both documents already hold exactly what it asks for (settled): a
 * label kept in only one of them, or an empty entry left behind by a removal, is written again.
 */
function compare(d: Doc, c: Change, server: string | undefined, remove: boolean, force: Set<string>): ChangeResult | null {
  const r = check({ ...c, before: blank(c.before), after: remove ? '' : c.after }, blank(server), force);
  if (r?.outcome === 'unchanged' && !settled(d, c, remove)) return null;
  return r && { ...r, change: c, ...(r.outcome === 'conflict' ? { server: server ?? '' } : {}) };
}

interface Spliced {
  xaml: string;
  /** StepLabel tags inserted and deleted, for the tag count check in sanity(). */
  added: number;
  removed: number;
}

/**
 * Applies each change to every StepLabels collection of its label: update the tag's Description, add a tag
 * right after the collection's last tag, or, for a removal (`rm`), delete the tag. Only tag bytes are
 * inserted or deleted, never whitespace around them, so the xaml stays byte-identical outside the edited
 * StepLabel tags (whitespace between collection items means nothing to XAML).
 */
function splice(d: Doc, todo: Change[], rm: Set<Change>): Spliced {
  const ops: Array<[number, number, string]> = [];
  let added = 0;
  let removed = 0;
  for (const c of todo) {
    const id = lid(c);
    for (const g of d.x.get(id) || []) {
      const hits = g.filter((t) => is(t, id, c.lcid));
      if (rm.has(c)) {
        for (const t of hits) ops.push([t.s, t.end - t.s, '']);
        removed += hits.length;
        continue;
      }
      for (const t of hits)
        ops.push([
          t.s,
          t.end - t.s,
          /\sDescription\s*=/.test(t.text) ? t.text.replace(/(\s)Description\s*=\s*(?:"[^"]*"|'[^']*')/, (_, s: string) => s + attr(c.after)) : t.text.replace(/^<[\w:]+/, (m) => `${m} ${attr(c.after)}`),
        ]);
      if (hits.length) continue;
      const sib = g.find((t) => is(t, id))!;
      const last = g[g.length - 1];
      ops.push([last.end, 0, `<${sib.prefix}:StepLabel ${attr(c.after)} LabelId="${xmlAttr(sib.labelId)}" LanguageCode="${c.lcid}" />`]);
      added++;
    }
  }
  // Positions never overlap: each tag is touched by one change at most, and inserts go at the end of a
  // collection, where no other tag starts. sort() is stable, so inserts at one spot keep their order.
  ops.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [at, del, text] of ops) {
    out += d.xaml.slice(pos, at) + text;
    pos = at + del;
  }
  return { xaml: out + d.xaml.slice(pos), added, removed };
}

/**
 * Applies each change to every clientdata stepLabels.list of its label: update or add the entry, or, for a
 * removal (`rm`), delete it. Edits the lists inside `d.cd` in place. True when the JSON needs re-writing.
 */
function edit(d: Doc, todo: Change[], rm: Set<Change>): boolean {
  let touched = false;
  for (const c of todo) {
    const id = lid(c);
    for (const l of d.c.get(id) || []) {
      if (rm.has(c)) {
        for (let i = l.length - 1; i >= 0; i--)
          if (is(l[i], id, c.lcid)) {
            l.splice(i, 1);
            touched = true;
          }
        continue;
      }
      touched = true;
      const hits = l.filter((e) => is(e, id, c.lcid));
      for (const e of hits) e.description = c.after;
      if (hits.length) continue;
      // Copy a sibling so the new entry has the shape and key order Dataverse writes.
      const sib = l.find((e) => is(e, id));
      l.push(sib ? { ...sib, languageCode: typeof sib.languageCode === 'string' ? String(c.lcid) : c.lcid, description: c.after } : { labelId: id, languageCode: c.lcid, description: c.after });
    }
  }
  return touched;
}

const GONE = 'This label is no longer in the process definition. Reload and try again.';

/** The edited label/language pairs: which StepLabel entries are `todo`'s. */
const pairsOf = (todo: Change[]) => (e: Entry) => todo.some((c) => is(e, lid(c), c.lcid));

/** The xaml outside the StepLabel tags `mine` matches: every other byte, and every other tag as written. */
const restOf = (xaml: string, mine: (e: Entry) => boolean): string =>
  JSON.stringify([xaml.replace(new RegExp(TAG.source, 'g'), ''), ...scan(xaml).flat().filter((t) => !mine(t)).map((t) => t.text)]);

/**
 * Clientdata without the stepLabels entries `mine` matches ('' for none). `sorted`: keys in order, for comparing two
 * reads (Dataverse may write the clientdata it stores itself).
 */
function cdOf(text: string | null, mine: (e: Entry) => boolean, sorted = false): string {
  if (!text) return '';
  const order = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(order) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, order((v as Record<string, unknown>)[k])])) : v;
  const cd = JSON.parse(text);
  return JSON.stringify(sorted ? order(cd) : cd, (k, v) => (k === 'stepLabels' && Array.isArray(v?.list) ? { ...v, list: v.list.filter((e: Entry) => !mine(e)) } : v));
}

/**
 * Proves only the edited languages changed: byte-identical xaml outside StepLabel tags (whitespace
 * included, since splice() never touches it), every other StepLabel tag byte-identical, exactly as many
 * tags as were meant to be added or removed, every edited label in the wanted state in both documents,
 * and the same clientdata once the edited languages' entries are left out.
 */
function sanity(d: Doc, next: Spliced, cdText: string | null, todo: Change[], rm: Set<Change>): void {
  const mine = pairsOf(todo);
  let ok = false;
  try {
    const after = parse({ xaml: next.xaml, clientdata: cdText });
    // No DOM parse here: browsers reject XAML's `clr-namespace:…, Version=…` namespace URIs (verified live),
    // and restOf already proves every byte outside the edited StepLabel tags is unchanged.
    ok =
      restOf(d.xaml, mine) === restOf(next.xaml, mine) &&
      cdOf(d.cdText, mine) === cdOf(cdText, mine) &&
      tagCount(next.xaml) === tagCount(d.xaml) + next.added - next.removed &&
      todo.every((c) => settled(after, c, rm.has(c)));
  } catch {
    /* a document that no longer parses fails the check */
  }
  if (!ok) throw new Error(UNSAFE);
}

interface Built {
  xaml: string;
  cdText: string | null;
}

/** `todo` written on `base`: new xaml and clientdata, checked to differ from it in those label/language pairs only. */
function built(ctx: Ctx, base: Doc, todo: Change[]): Built {
  // A document of its own: edit() changes the clientdata lists in place, and `base` is compared with later reads.
  const d = parse({ xaml: base.xaml, clientdata: base.cdText });
  const rm = new Set(todo.filter((c) => clears(ctx, c)));
  const next = splice(d, todo, rm);
  // Dataverse writes clientdata with .NET's "\/" escaping (also how it marks "\/Date(...)\/" values);
  // keep it. Every "/" in JSON.stringify output sits inside a string, so escaping all of them is exact.
  const json = edit(d, todo, rm) && JSON.stringify(d.cd);
  const cdText = json ? (d.cdText!.includes('\\/') ? json.replace(/\//g, '\\/') : json) : d.cdText;
  sanity(d, next, cdText, todo, rm);
  return { xaml: next.xaml, cdText };
}

/** A process definition a part read; null when it could not be read (an answer without its xaml included: never one to write back). */
function docOf(r: PartResult): Doc | null {
  if (!r.ok || typeof r.data?.xaml !== 'string' || !r.data.xaml) return null;
  try {
    const d = parse(r.data);
    return d.cdText && !d.cd ? null : d;
  } catch {
    return null;
  }
}

/**
 * One write batch: the definition right before the PATCH (the probe: a $batch runs its parts in order), the PATCH, the
 * definition right after it. The clientdata is sent when it differs from the one `fresh` read. Sent `once` and without
 * continue-on-error, so a probe Dataverse answered with an error stops it before the PATCH (Unsent). No If-Match:
 * verified live, a BPF update cascades into WorkflowDependency rows, which reject IfVersionMatches ("Optimistic
 * concurrency isn't enabled for entity type WorkflowDependency", LIVE-FINDINGS 29). Throws the PATCH's error.
 */
async function post(ctx: Ctx, id: string, b: Built, fresh: Doc): Promise<Sent<Doc>> {
  const get: BatchPart = { method: 'GET', url: `workflows(${id})?$select=${SELECT}` };
  const body = b.cdText === fresh.cdText ? { xaml: b.xaml } : { xaml: b.xaml, clientdata: b.cdText };
  const [p, pr, back] = await ctx.http.batch([get, { method: 'PATCH', url: `workflows(${id})`, body }, get], { once: true, stop: true });
  if (!pr.ok) throw !pr.status && !p.ok && p.status ? new Unsent(partError(p)) : partError(pr);
  return { probe: docOf(p), back: docOf(back) };
}

/** A label/language pair's entries in both documents, for comparing reads; null when the label is gone. */
function pairState(d: Doc, c: Change, remove: boolean): string | null {
  const id = lid(c);
  if (!remove && !d.x.has(id)) return null;
  const of = (m: Index<Entry>) => (m.get(id) || []).map((l) => l.filter((e) => is(e, id, c.lcid)).map((e) => String(e.description ?? '')));
  return JSON.stringify([of(d.x), of(d.c)]);
}

/** A process definition's documents for settle(). */
function bpfOps(ctx: Ctx, id: string): DocOps<Doc, Built> {
  const none = () => false;
  return {
    noun: 'process',
    publish: false,
    gone: GONE,
    dropped: (c) => `Dataverse did not ${clears(ctx, c) ? 'remove' : 'keep'} the ${lcidName(c.lcid)} label.`,
    async read() {
      const d = parse(await ctx.http.get(`workflows(${id})?$select=${SELECT}`));
      if (d.cdText && !d.cd) throw new Error('The process definition returned by Dataverse could not be read.');
      return d;
    },
    build: (base, todo) => built(ctx, base, todo),
    send: (b, fresh) => post(ctx, id, b, fresh),
    same: (a, b) => a.xaml === b.xaml && (a.cdText === b.cdText || cdOf(a.cdText, none, true) === cdOf(b.cdText, none, true)),
    older: (a, b) => olderVersion(a.ver, b.ver),
    alike: (a, b, todo) => {
      const mine = pairsOf(todo);
      return restOf(a.xaml, mine) === restOf(b.xaml, mine) && cdOf(a.cdText, mine, true) === cdOf(b.cdText, mine, true);
    },
    state: (d, c) => pairState(d, c, clears(ctx, c)),
    text: (d, c) => cur(d, lid(c))[c.lcid] || kept(c) || '',
    holds: (d, c) => settled(d, c, clears(ctx, c)),
  };
}

/**
 * Fresh read -> conflict check -> splice xaml + edit clientdata -> safety checks -> one batch [probe, PATCH, read back]
 * (see post) -> verify. Returns the results and the changes Dataverse did not keep. Nothing guards the definition from
 * the read until the PATCH: the probe right before it shows a save someone else made in between, which this PATCH
 * replaced, and settle() puts it back. A save Dataverse applies while the PATCH runs (~9 s) can't be seen by the probe.
 * A PATCH Dataverse turned away unrun (throttled, the customization lock, or a probe that failed and stopped the batch)
 * is never resent as built (Http sends it `once`): the pass is done again from a new read after 2, 4 and 8 s, so a
 * process someone saved meanwhile is kept.
 * `retry`: the changes were just written but not kept, so a server value equal to the wanted one (kept in
 * one store only) is written again; a value that is neither `before` nor the wanted one is still a conflict.
 */
async function pass(ctx: Ctx, id: string, changes: Change[], o: SaveOptions, retry: boolean): Promise<[ChangeResult[], Change[]]> {
  const ops = bpfOps(ctx, id);
  // Reads after a PATCH ignore the signal: once written, report what really is on the server.
  const read = (signal?: AbortSignal) => ctx.http.get(`workflows(${id})?$select=${SELECT}`, { signal }).then(parse);
  for (let stale = 0, waits = 0; ; ) {
    const d = await read(o.signal);
    if (d.cdText && !d.cd) throw new Error('The process definition returned by Dataverse could not be read.');
    // From a managed solution as read right before the write (one that slipped through as editable): never written, so
    // no unmanaged layer is ever put on it.
    if (d.managed) return [changes.map((c): ChangeResult => ({ change: c, outcome: 'error', message: MANAGED })), []];
    const out: ChangeResult[] = [];
    const todo: Change[] = [];
    const rm = new Set<Change>();
    for (const c of changes) {
      const remove = clears(ctx, c);
      // A removal aims for no entry, whatever spaces were typed.
      const want = remove ? '' : c.after;
      // Where the definition has no text, a name Dynamics keeps is what the page shows (LIVE-FINDINGS 83).
      const s: string | undefined = cur(d, lid(c))[c.lcid] || kept(c);
      let r: ChangeResult | null = null;
      // A removal needs nothing from the xaml: a label that is gone already has no translation.
      if (!remove && !d.x.has(lid(c))) r = { change: c, outcome: 'error', message: GONE };
      else if (c.lcid === ctx.base && !c.after.trim()) r = { change: c, outcome: 'error', message: `The ${lcidName(ctx.base)} label can't be blank: it is the base language.` };
      else if (!retry || (blank(s) !== blank(c.before) && blank(s) !== blank(want))) r = compare(d, c, s, remove, o.force);
      if (r) out.push(r);
      else {
        todo.push(c);
        if (remove) rm.add(c);
      }
    }
    if (!todo.length) return [out, []];
    const b = built(ctx, d, todo);
    let seen: Sent<Doc> | null = null;
    if (b.xaml !== d.xaml || b.cdText !== d.cdText) {
      if (o.signal.aborted) throw abortError();
      try {
        // No signal: an aborted request may still be applied by the server.
        seen = await post(ctx, id, b, d);
      } catch (e) {
        if ((turnedAway(e) || e instanceof Unsent) && waits < 3) {
          // Nothing of this pass was written; Stop during the wait ends it there.
          if (await pause(2000 << waits++, o.signal).then(() => false, () => true))
            return [[...out, ...todo.map((c): ChangeResult => ({ change: c, outcome: 'skipped', message: 'Cancelled before saving.' }))], []];
          continue;
        }
        if (e instanceof Unsent) throw e.error;
        if (e instanceof DvError && e.status === 412) {
          if (!stale++) continue;
          const f = await read();
          const message = 'Someone else saved this process at the same time. Reload and try again.';
          return [[...out, ...todo.map((c): ChangeResult => ({ change: c, outcome: 'conflict', server: cur(f, lid(c))[c.lcid] || kept(c) || '', message }))], []];
        }
        // Its answer was lost, so it may have been written (SaveOptions.ran): said before the saver words the error.
        if (mayHaveRun(e)) for (const c of todo) o.ran?.add(changeId(c));
        throw e instanceof DvError && e.code.includes('80045002')
          ? new Error('Dataverse does not allow changes to this activated process. Deactivate it in the process designer, save again, then activate it.')
          : e;
      }
      for (const c of todo) o.ran?.add(changeId(c));
      const fixed = await settle(ops, d, todo, seen);
      if (fixed) return [[...out, ...fixed], []];
    }
    let v = seen?.back ?? null;
    if (!v)
      try {
        v = await read();
      } catch {
        // Written but not confirmed: report that instead of a bare network error, as the other XML writers do.
        const message = seen ? 'Sent to Dataverse, but the result could not be checked. Reload to confirm it.' : 'The process definition could not be read again to check this label. Reload to confirm it.';
        return [[...out, ...todo.map((c): ChangeResult => ({ change: c, outcome: 'error', message }))], []];
      }
    const missing = todo.filter((c) => !settled(v!, c, rm.has(c)));
    for (const c of todo) if (!missing.includes(c)) out.push({ change: c, outcome: 'saved' });
    return [out, missing];
  }
}

export const bpfWriter: Writer = {
  kinds: ['stage', 'step'],
  lane: 'doc',
  async read(ctx, changes, o) {
    const d = parse(await ctx.http.get(`workflows(${guid(changes[0].slot.ref.workflowId)})?$select=${SELECT}`, { signal: o.signal }));
    if (d.cdText && !d.cd) throw new Error('The process definition returned by Dataverse could not be read.');
    // As pass() measures a change: a name Dynamics keeps where the definition has none; a label gone from it (but for a
    // removal, which needs nothing there) is GONE.
    return new Map(changes.map((c): [string, string | Error] => [changeId(c), !clears(ctx, c) && !d.x.has(lid(c)) ? new Error(GONE) : cur(d, lid(c))[c.lcid] || kept(c) || '']));
  },
  async save(ctx, changes, o) {
    const id = guid(changes[0].slot.ref.workflowId);
    const name = changes[0].slot.path[0] || 'business process flow';
    // Removing a stage or step translation would leave the page showing it (LIVE-FINDINGS 83), whether it is in the
    // definition or only kept: refused before anything is read or written (the saver's check refuses it first).
    const out: ChangeResult[] = [];
    const rest: Change[] = [];
    // A label of a process loaded from a managed solution is refused before anything is read (pass() checks again).
    for (const c of changes)
      if (isManaged(c.slot)) out.push({ change: c, outcome: 'error', message: MANAGED });
      else if (clears(ctx, c) && !canClear(c.slot, c.lcid)) out.push({ change: c, outcome: 'error', message: cantClearText(c.slot, c.lcid) });
      else rest.push(c);
    if (!rest.length) return out;
    o.progress(`Saving ${name}`);
    const [done, missing] = await pass(ctx, id, rest, o, false);
    out.push(...done);
    // Live tests kept every language regardless of the UI language. Should Dataverse ever drop one (or keep
    // a removed one), retry it once while the UI language is that language, the way form tab and section
    // labels need.
    for (const lcid of new Set(missing.map((c) => c.lcid))) {
      const lang = lcidName(lcid);
      let failed = missing.filter((c) => c.lcid === lcid);
      let extra = '';
      try {
        o.progress(`Saving ${name} again in ${lang}`);
        const [r, still] = await o.lang.run(lcid, () => pass(ctx, id, failed, o, true));
        out.push(...r);
        failed = still;
      } catch (e) {
        extra = isAbort(e) ? ' The save was cancelled before it could try again.' : ` ${(e as Error)?.message || ''}`;
      }
      out.push(
        ...failed.map((c): ChangeResult => {
          const why = clears(ctx, c) ? `Dataverse did not remove the ${lang} label.` : `Dataverse did not keep the ${lang} label.`;
          return { change: c, outcome: 'error', message: (why + extra).trim() };
        }),
      );
    }
    return out;
  },
};
