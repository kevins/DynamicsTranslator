// Seeded random sequences of saves through the real metadata writers (src/providers/metadata.ts) against a fake
// Dataverse whose reads lag (LIVE-FINDINGS 66) and whose writes can be dropped (finding 62), checking after every save the
// invariants the save path promises (docs/ARCHITECTURE.md §4.1, "Reads that lag"):
//   I1  every language a tab wrote (applied) or confirmed (saved, unchanged) still holds unless someone else changed it later;
//   I2  'saved' (and 'unchanged') only when the server holds that text at the end of the save;
//   I3  no refusal (behindMsg) and no wait unless a read of that save lags behind a write of this page or one of its writes
//       was dropped, and no refusal more than a minute after this page's last write of the component;
//   I4  fresh reads and nothing else going on: 2 reads, 1 write, no wait;
//   I5  a text someone else saved between a save's read and its write, which that write put back to what the read showed,
//       is written back (it holds at the end of the save) or the save says something (not every result saved), unless no
//       read could show it: the read in the write's batch lagged, or can't be told from one that did (as for I3, or a write
//       of the tabs that may not have run is less than a minute old), and the column's layers (from the database) did not
//       answer.
// Each write goes in a $batch behind a read of the component and, for the column, its layers (src/providers/metadata.ts
// Probe): Dataverse runs the parts in order, so that read lags like any other but shows anyone's save made before it.
// What no page can tell apart is not counted: a read is only a state of the component, and the page knows only the texts
// it kept. So
//   - a read that agrees, on every language this page wrote in the last minute, with a state from before one of those
//     writes may be a read behind it (someone put the old texts back), and so may one that shows a text the page knew there
//     before its write, put back by someone since, unless it also shows a text a later write of the page made that the
//     page never knew there before (ambiguous(), putBack(): I3);
//   - a read that lagged and agrees on them with the state the save asked for may be taken as its answer (an edit back
//     or Undo whose write Dataverse dropped, read from before the save it undid: lookedDone(), I2), unless the component
//     has solution layers that answer (the column, in most worlds): those come from the database;
//   - a text the page never kept as one from before its write (it wrote over it with no read of it showing it there, or
//     saw it only in a read it keeps nothing of: the check after a write, a save that wrote nothing) looks like someone
//     else's newer text when a later read, stale again, shows it (unseen(), collided(), kept(): I1, I2).
// Besides the random sequences, the scripted cases of earlier reviews (REGRESSIONS) must keep I1-I5.
//
// World: three components, each with a history of states (one per applied write): a column (DisplayName and Description,
// PUT, back 'labels'), an N:N relationship (both menu labels, PUT of the whole definition, back 'all') and a local choice
// option (Label and Description, UpdateOptionValue, back 'langs'). A read answers a state from 1-3 writes ago during a lag
// episode (and now and then at random), never one superseded more than LAGMAX ago. Writes: applied, dropped (204,
// nothing applied), 504 after applying, 504 before applying, turned away (lock). Someone else edits languages (also
// while a save runs). Tabs A and B: their own instance (ctx), one localStorage, one server, Web Locks as in Edge. The
// clock is fake: a pause is instant but moves it; Stop may come during a pause; the machine may sleep during one.
import { metadataWriters } from '../../../src/providers/metadata';
import { DvError, abortError } from '../../../src/core/http';
import { toLabels } from '../../../src/core/labels';
import { PublishSet, type Change, type ChangeResult, type Slot } from '../../../src/core/model';
import type { Kit } from './kit';

/** Sequences the unit test runs (seeds 1..SEQS, then EXTRA: later seeds that once showed a bug), steps per sequence. */
const SEQS = 400;
const EXTRA = [1249, 2258, 2342, 3134, 5483, 6497, 9683];
const STEPS = 20;

const EN = 1033;
const FR = 1036;
const DE = 1031;
const LANGS = [EN, FR, DE];
const LN: Record<number, string> = { 1033: 'EN', 1036: 'FR', 1031: 'DE' };

const K = {
  LAGMAX: 30_000,
  P_RANDOM_LAG: 0.08,
  P_LAG_AFTER: 0.35,
  P_OTHER_DURING: 0.03,
  P_READ_FAIL: 0.02,
  P_STOP: 0.05,
  P_SLEEP: 0.01,
  P_OK: 0.72,
  P_DROP: 0.08,
  P_504A: 0.06,
  P_504N: 0.06, // the rest: turned away by the lock
  P_OTHER_STEP: 0.12,
  P_CONC: 0.08,
};

function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickOf = <T>(R: () => number, xs: T[]): T => xs[Math.floor(R() * xs.length)];

// ---------- fake clock, Web Locks and localStorage (installed while the fuzz runs) ----------

const T0 = 1_800_000_000_000;
let BASE = T0;
let worlds = 0;
let NOW = T0;
interface Tm {
  at: number;
  seq: number;
  id: number;
  fn: () => void;
  ms: number;
}
let timers: Tm[] = [];
let tseq = 0;
let tid = 0;
const addTimer = (fn: () => void, ms: number): Tm => {
  const t = { at: NOW + ms, seq: tseq++, id: ++tid, fn, ms };
  timers.push(t);
  return t;
};
const realImmediate = (globalThis as unknown as { setImmediate: (f: () => void) => void }).setImmediate;
/** Runs the fake timers, earliest first, until every promise of `ps` settled. */
async function drive(ps: Promise<unknown>[]): Promise<void> {
  let done = false;
  void Promise.allSettled(ps).then(() => (done = true));
  for (let g = 0; g < 200_000; g++) {
    await new Promise<void>((r) => realImmediate(r));
    if (done) {
      timers = [];
      return;
    }
    if (!timers.length) throw new Error('deadlock: a save is pending with no timer');
    timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const t = timers.shift()!;
    if (t.at > NOW) NOW = t.at;
    t.fn();
  }
  throw new Error('drive: runaway');
}

/** Web Locks as Edge has them: one holder per name, granted in request order; a signal cancels a wait. */
const lockQ = new Map<string, Array<() => void>>();
const lockHeld = new Set<string>();
const LOCKS = {
  request(name: string, opt: { signal?: AbortSignal }, fn: () => Promise<unknown>): Promise<unknown> {
    return new Promise<void>((go, no) => {
      if (opt.signal?.aborted) return no(abortError());
      const grant = () => {
        opt.signal?.removeEventListener('abort', cancel);
        lockHeld.add(name);
        go();
      };
      const cancel = () => {
        lockQ.set(name, (lockQ.get(name) || []).filter((x) => x !== grant));
        no(abortError());
      };
      if (!lockHeld.has(name)) return grant();
      opt.signal?.addEventListener('abort', cancel, { once: true });
      lockQ.set(name, [...(lockQ.get(name) || []), grant]);
    }).then(() =>
      Promise.resolve()
        .then(fn)
        .finally(() => {
          lockHeld.delete(name);
          (lockQ.get(name) || []).shift()?.();
        }),
    );
  },
};
const LS = new Map<string, string>();

async function withFakes<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as Record<string, any>;
  const saved = { now: Date.now, st: g.setTimeout, ct: g.clearTimeout, ls: Object.getOwnPropertyDescriptor(g, 'localStorage') };
  const nav = g.navigator as Record<string, unknown> | undefined;
  const hadLocks = nav && Object.getOwnPropertyDescriptor(nav, 'locks');
  Date.now = () => NOW;
  g.setTimeout = (f: () => void, ms = 0) => {
    const t = addTimer(f, ms);
    if (ms >= 1000) onPause(t);
    return t.id;
  };
  g.clearTimeout = (id: number) => void (timers = timers.filter((t) => t.id !== id));
  Object.defineProperty(g, 'localStorage', { configurable: true, value: { getItem: (k: string) => LS.get(k) ?? null, setItem: (k: string, v: string) => void LS.set(k, String(v)), removeItem: (k: string) => void LS.delete(k) } });
  if (nav) Object.defineProperty(nav, 'locks', { configurable: true, value: LOCKS });
  else g.navigator = { locks: LOCKS };
  try {
    return await fn();
  } finally {
    Date.now = saved.now;
    g.setTimeout = saved.st;
    g.clearTimeout = saved.ct;
    if (saved.ls) Object.defineProperty(g, 'localStorage', saved.ls);
    else delete g.localStorage;
    if (!nav) delete g.navigator;
    else if (hadLocks) Object.defineProperty(nav, 'locks', hadLocks);
    else delete nav.locks;
  }
}

// ---------- the world ----------

type CompId = 'attr' | 'rel' | 'opt';
type Lbl = Record<number, string>;
type St = Record<string, Lbl>;
interface Snap {
  st: St;
  at: number;
  actor: string;
}
interface Comp {
  id: CompId;
  parts: string[];
  hist: Snap[];
  lag: { k: number; n: number } | null;
}
type TabName = 'A' | 'B';
interface Ev {
  t: 'read' | 'readfail' | 'probe' | 'write' | 'pause' | 'progress' | 'stop';
  at: number;
  idx?: number;
  latest?: number;
  mode?: string;
  kind?: string;
  m?: string;
  ms?: number;
  /** Reads and writes: the place among all reads and applied writes (World.n). */
  n?: number;
}
/** A scripted save: how far behind each read is, each write's mode, the pause to press Stop in, a delay before its write lands. */
interface Plan {
  reads?: number[];
  writes?: string[];
  stopAtPause?: number;
  pauses?: number;
  writeDelay?: number;
  /** Someone else's edits [part, lcid, text] applied when its first write batch arrives, right before the read in it. */
  meanwhile?: Array<[string, number, string]>;
}
interface Rec {
  n: number;
  step: number;
  tab: Tab;
  comp: Comp;
  changes: Change[];
  ev: Ev[];
  t0: number;
  ac: AbortController;
  rnd: () => number;
  /** The random stream of the reads in its write batches (their own, so the sequences keep their shape). */
  prnd: () => number;
  conc: boolean;
  how: string;
  plan?: Plan;
  results?: ChangeResult[];
  error?: unknown;
  undoOf?: Entry;
  p?: Promise<void>;
  /** When it started (World.n), and the texts its edits started from and their slots held: what the page knew there. */
  n0: number;
  known: Array<[string, string]>;
  /** Its results were taken in (finishSave): a conflict it reported releases the texts its writes put there. */
  done?: boolean;
}
interface Entry {
  items: Array<{ key: string; lcid: number; before: string; after: string }>;
}
/** What a tab holds for a language: the text, and the texts its writes accepted but not applied (either may be there). */
interface Claim {
  v: string;
  alt: string[];
  why: string;
}
interface Tab {
  name: TabName;
  ctx: any;
  slots: Map<string, Slot>;
  claims: Map<string, Claim>;
  pending: Change[];
  conflicts: Array<{ c: Change; server: string }>;
  history: Entry[];
  cur: Rec | null;
}
interface Applied {
  actor: string;
  id: string;
  from: string;
  to: string;
  at: number;
  intended: boolean;
  rec: number;
  /** The history index of the state it made, how many events its save had then, its place among reads and writes. */
  idx: number;
  ev: number;
  n: number;
}
export interface Viol {
  inv: string;
  seed: number;
  step: number;
  detail: string;
}
interface World {
  seed: number;
  /** The column's solution layers answer (layerRows): four seeds in five, and the scripted cases run both ways. */
  layers: boolean;
  comps: Record<CompId, Comp>;
  tabs: Record<TabName, Tab>;
  log: string[];
  viol: Viol[];
  ourWrites: Array<{ comp: CompId; at: number; mode: string }>;
  applied: Applied[];
  recs: Rec[];
  /** Every text a tab's applied write put in a language it edited, changed or not. */
  wrote: Array<{ id: string; to: string; at: number; n: number; idx: number }>;
  /** Counts reads and applied writes, in order. */
  n: number;
  /** Every read of a tab (saves and loads). */
  reads: Array<{ comp: CompId; idx: number; at: number; n: number; rec: number }>;
  step: number;
  active: Rec | null;
  rnd: () => number;
}
let W: World;

const PARTS: Record<CompId, string[]> = { attr: ['DisplayName', 'Description'], rel: ['1', '2'], opt: ['Label', 'Description'] };
const KEYS: Record<CompId, (p: string) => string> = {
  attr: (p) => `attribute|t.x|${p}`,
  rel: (p) => `relationship|acc_con|${p}`,
  opt: (p) => `option|t.k|1|${p}`,
};
const GROUP: Record<CompId, string> = { attr: 'attribute|t.x', rel: 'relationship|acc_con', opt: 'option|t.k|1' };
const SHORT: Record<CompId, Record<string, string>> = { attr: { DisplayName: 'N', Description: 'D' }, rel: { '1': 'P', '2': 'Q' }, opt: { Label: 'L', Description: 'O' } };
const pool = (comp: CompId, part: string, lcid: number, n: number) => `${SHORT[comp][part]}${LN[lcid]}${n}`;
const compOfKey = (key: string): CompId => (key.startsWith('attribute') ? 'attr' : key.startsWith('relationship') ? 'rel' : 'opt');
const partOfKey = (key: string) => key.slice(key.lastIndexOf('|') + 1);
const txt = (c: Change) => (c.after.trim() ? c.after : '');
const cid = (c: Change) => `${c.slot.key}#${c.lcid}`;
const idParts = (id: string) => {
  const [key, l] = id.split('#');
  return { key, lcid: Number(l), comp: compOfKey(key), part: partOfKey(key) };
};
const valIn = (st: St, id: string) => st[idParts(id).part][idParts(id).lcid] ?? '';
const truth = (id: string): string => {
  const h = W.comps[idParts(id).comp].hist;
  return valIn(h[h.length - 1].st, id);
};
const shortId = (id: string) => `${idParts(id).comp}.${idParts(id).part}.${LN[idParts(id).lcid]}`;
const log = (s: string) => W.log.push(`[${((NOW - BASE) / 1000).toFixed(1)}s] ${s}`);
const show = (c: Comp, st: St) => c.parts.map((p) => `${p}{${LANGS.filter((l) => st[p][l] !== undefined).map((l) => `${LN[l]}:${st[p][l]}`).join(',')}}`).join(' ');

function initState(id: CompId): St {
  const s = (part: string, langs: number[]) => Object.fromEntries(langs.map((l) => [l, pool(id, part, l, 0)]));
  if (id === 'attr') return { DisplayName: s('DisplayName', [EN, FR, DE]), Description: s('Description', [EN, FR]) };
  if (id === 'rel') return { '1': s('1', [EN, FR, DE]), '2': s('2', [EN, FR]) };
  return { Label: s('Label', [EN, FR, DE]), Description: s('Description', [EN]) };
}

const REL_ID = '11111111-2222-3333-4444-555555555555';
const ATTR_ID = 'aaaaaaaa-2222-3333-4444-555555555555';
function mkSlot(comp: CompId, part: string, labels: Lbl): Slot {
  const key = KEYS[comp](part);
  const base = { key, path: [], sub: '', readOnly: '', max: 0, order: 0, labels: { ...labels }, title: comp };
  if (comp === 'attr')
    return { ...base, kind: 'attribute', comp: GROUP.attr, group: GROUP.attr, prop: part, entity: 't', baseRequired: part !== 'Description', ref: { entity: 't', attribute: 'x', odataType: 'Microsoft.Dynamics.CRM.StringAttributeMetadata', metadataId: ATTR_ID } } as unknown as Slot;
  if (comp === 'rel') return { ...base, kind: 'relationship', comp: key, group: GROUP.rel, prop: 'Label', entity: 'account', baseRequired: true, ref: { metadataId: REL_ID, type: 'ManyToMany', side: Number(part) } } as unknown as Slot;
  return { ...base, kind: 'option', comp: GROUP.opt, group: GROUP.opt, prop: part, entity: 't', baseRequired: part !== 'Description', ref: { entity: 't', attribute: 'k', value: 1, cast: 'Picklist' } } as unknown as Slot;
}

const lab = (l: Lbl) => ({ LocalizedLabels: Object.entries(l).map(([k, v]) => ({ Label: v, LanguageCode: Number(k) })) });
function render(c: Comp, st: St): any {
  if (c.id === 'attr')
    return { '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata', MetadataId: ATTR_ID, LogicalName: 'x', AttributeType: 'String', AttributeTypeName: { Value: 'StringType' }, DisplayName: lab(st.DisplayName), Description: lab(st.Description), IsCustomizable: { Value: true }, IsRenameable: { Value: true } };
  if (c.id === 'rel') {
    const menu = (l: Lbl) => ({ Behavior: 'UseLabel', Group: 'Details', Order: 10000, Label: lab(l) });
    return { '@odata.type': '#Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata', MetadataId: REL_ID, SchemaName: 'acc_con', Entity1LogicalName: 'account', Entity2LogicalName: 'contact', IsCustomizable: { Value: true }, Entity1AssociatedMenuConfiguration: menu(st['1']), Entity2AssociatedMenuConfiguration: menu(st['2']) };
  }
  return { LogicalName: 'k', IsCustomizable: { Value: true }, OptionSet: { Options: [{ Value: 1, Label: lab(st.Label), Description: lab(st.Description) }] } };
}
function bodyParts(c: Comp, body: any): Record<string, Lbl> {
  const out: Record<string, Lbl> = {};
  const take = (p: string, L: any) => {
    if (L?.LocalizedLabels) out[p] = toLabels(L);
  };
  if (c.id === 'attr') {
    take('DisplayName', body.DisplayName);
    take('Description', body.Description);
  } else if (c.id === 'rel') {
    take('1', body.Entity1AssociatedMenuConfiguration?.Label);
    take('2', body.Entity2AssociatedMenuConfiguration?.Label);
    for (const n of [1, 2]) {
      const m = body[`Entity${n}AssociatedMenuConfiguration`];
      if (m && (m.Behavior !== 'UseLabel' || m.Group !== 'Details' || m.Order !== 10000)) addViol('REL-SETTINGS', `menu ${n} settings sent changed`);
    }
  } else {
    take('Label', body.Label);
    take('Description', body.Description);
  }
  return out;
}

function apply(c: Comp, actor: string, parts: Record<string, Lbl>, note: string, rec: Rec | null): void {
  const prev = c.hist[c.hist.length - 1].st;
  const st: St = JSON.parse(JSON.stringify(prev));
  for (const [p, l] of Object.entries(parts)) for (const [lang, v] of Object.entries(l)) st[p][Number(lang)] = v;
  c.hist.push({ st, at: NOW, actor });
  const diffs: string[] = [];
  for (const p of c.parts)
    for (const lang of new Set([...Object.keys(prev[p]), ...Object.keys(st[p])].map(Number))) {
      const a = prev[p][lang] ?? '';
      const b = st[p][lang] ?? '';
      if (a === b) continue;
      const id = `${KEYS[c.id](p)}#${lang}`;
      let intended = true;
      if (actor === 'other') for (const t of Object.values(W.tabs)) t.claims.delete(id);
      else {
        intended = !!rec?.changes.some((ch) => cid(ch) === id && txt(ch) === b);
        if (intended) {
          W.tabs[actor as TabName].claims.set(id, { v: b, alt: [], why: `applied write rec#${rec!.n}` });
          W.tabs[actor === 'A' ? 'B' : 'A'].claims.delete(id);
        }
      }
      W.applied.push({ actor, id, from: a, to: b, at: NOW, intended, rec: rec?.n ?? -1, idx: c.hist.length - 1, ev: rec?.ev.length ?? 0, n: W.n++ });
      diffs.push(`${shortId(id)} ${a || "''"}->${b || "''"}${intended ? '' : ' (UNINTENDED)'}`);
    }
  if (rec && actor !== 'other')
    for (const ch of rec.changes)
      if (parts[partOfKey(ch.slot.key)]?.[ch.lcid] === txt(ch)) W.wrote.push({ id: cid(ch), to: txt(ch), at: NOW, n: W.n++, idx: c.hist.length - 1 });
  log(`  APPLY by ${actor} (${note}) #${c.hist.length - 1}: ${diffs.join('; ') || 'no change'}`);
}

function pickIdx(c: Comp, R: () => number): number {
  const latest = c.hist.length - 1;
  let idx = latest;
  if (c.lag) {
    idx = latest - c.lag.k;
    if (--c.lag.n <= 0) c.lag = null;
  } else if (R() < K.P_RANDOM_LAG) idx = latest - 1 - Math.floor(R() * 3);
  idx = Math.max(0, idx);
  while (idx < latest && c.hist[idx + 1].at <= NOW - K.LAGMAX) idx++;
  return idx;
}

function otherEdit(c: Comp, R: () => number, why: string): void {
  const part = pickOf(R, c.parts);
  const lang = pickOf(R, LANGS);
  const cur = c.hist[c.hist.length - 1].st[part][lang] ?? '';
  const earlier = [...new Set(c.hist.map((h) => h.st[part][lang]).filter((v) => v && v !== cur))];
  const to = earlier.length && R() < 0.5 ? pickOf(R, earlier) : pool(c.id, part, lang, 1 + Math.floor(R() * 4));
  if (to !== cur) apply(c, 'other', { [part]: { [lang]: to } }, why, null);
}

const compOfUrl = (url: string): Comp => W.comps[url.startsWith('RelationshipDefinitions') ? 'rel' : url.includes('PicklistAttributeMetadata') ? 'opt' : 'attr'];

function pickMode(R: () => number): string {
  const r = R();
  if (r < K.P_OK) return 'ok';
  if (r < K.P_OK + K.P_DROP) return 'drop';
  if (r < K.P_OK + K.P_DROP + K.P_504A) return '504a';
  if (r < K.P_OK + K.P_DROP + K.P_504A + K.P_504N) return '504n';
  return 'lock';
}

async function write(tab: Tab, c: Comp, body: any): Promise<void> {
  const rec = tab.cur!;
  W.active = rec;
  const R = rec.rnd;
  if (rec.plan?.writeDelay) {
    const ms = rec.plan.writeDelay;
    rec.plan.writeDelay = 0;
    await new Promise<void>((r) => addTimer(r, ms)); // the request in flight, not a pause of the writer
  }
  const mode = rec.plan ? (rec.plan.writes?.shift() ?? 'ok') : pickMode(R);
  const parts = bodyParts(c, body);
  rec.ev.push({ t: 'write', mode, at: NOW, n: W.n++ });
  W.ourWrites.push({ comp: c.id, at: NOW, mode });
  log(`  ${tab.name} WRITE rec#${rec.n} [${mode}] ${Object.entries(parts).map(([p, l]) => `${p}{${Object.entries(l).map(([k, v]) => `${LN[+k]}:${v}`).join(',')}}`).join(' ')}`);
  if (mode === 'lock') throw new DvError('Cannot start another [Import] because there is a previous [Publish] running at this moment. 0x80071151', 429);
  if (mode === 'drop' || mode === '504n') {
    // Accepted (or may have run) but not applied: the tab's text there may now be either one.
    for (const ch of rec.changes) {
      const p = partOfKey(ch.slot.key);
      if (parts[p]?.[ch.lcid] !== txt(ch)) continue;
      for (const t of Object.values(W.tabs)) {
        const cl = t.claims.get(cid(ch));
        if (cl && !cl.alt.includes(txt(ch))) cl.alt.push(txt(ch));
      }
    }
    if (mode === '504n') throw new DvError('Gateway Timeout', 504);
    return;
  }
  apply(c, tab.name, parts, `write rec#${rec.n}`, rec);
  if (!rec.plan && R() < K.P_LAG_AFTER) {
    c.lag = { k: 1 + Math.floor(R() * 3), n: 1 + Math.floor(R() * 8) };
    log(`  (lag episode: k=${c.lag.k} n=${c.lag.n})`);
  }
  if (mode === '504a') throw new DvError('Gateway Timeout', 504);
}

/**
 * The column's solution layers (msdyn_componentlayers, src/providers/layers.ts): read from the database, so always the
 * latest state, never a lagging one. A System layer holds the first state; the Active layer every language a write (anyone's)
 * ever changed, with its text now, as for a managed column. One world in five has no access to them (403), and the scripted
 * cases run both ways: the save path must then behave as without them.
 */
function layerRows(url: string, tab: Tab): unknown[] {
  if (!W.layers) throw new DvError('You do not have permission to do this.', 403);
  const c = W.comps.attr;
  if (!url.includes(`'${ATTR_ID}'`) || !url.includes("'Attribute'")) return [];
  const first = c.hist[0].st;
  const now = c.hist[c.hist.length - 1].st;
  const touched = (p: string) => LANGS.filter((l) => c.hist.some((x) => x.st[p][l] !== first[p][l]));
  const changes = (st: St, langs: (p: string) => number[], at: number) =>
    JSON.stringify({
      Attributes: [
        { Key: 'modifiedon', Value: new Date(at).toISOString().replace('Z', '') },
        ...c.parts.map((p) => ({ Key: `${p} - LocalizedLabel`, Value: JSON.stringify({ LocalizedLabels: Object.fromEntries(langs(p).filter((l) => st[p][l] !== undefined).map((l) => [l, { LocalizedLabel: st[p][l], ComponentState: 0 }])) }) })),
      ],
    });
  log(`  ${tab.name} LAYERS ${tab.cur ? `rec#${tab.cur.n}` : ''}: ${show(c, now)}`);
  return [
    { msdyn_solutionname: 'System', msdyn_order: 1, msdyn_changes: changes(first, () => LANGS, c.hist[0].at) },
    { msdyn_solutionname: 'Active', msdyn_order: 2, msdyn_changes: changes(now, touched, c.hist[c.hist.length - 1].at) },
  ];
}

function makeHttp(tab: Tab) {
  return {
    get: async (url: string, o?: { signal?: AbortSignal }) => {
      if (o?.signal?.aborted) throw abortError();
      if (url.startsWith('msdyn_componentlayers')) return { value: layerRows(url, tab) };
      const c = compOfUrl(url);
      const rec = tab.cur;
      const R = rec?.rnd ?? W.rnd;
      if (rec) {
        W.active = rec;
        if (!rec.plan && R() < K.P_OTHER_DURING) otherEdit(c, R, `during rec#${rec.n}`);
        if (!rec.plan && R() < K.P_READ_FAIL) {
          rec.ev.push({ t: 'readfail', at: NOW });
          log(`  ${tab.name} READ rec#${rec.n} FAILED (504)`);
          throw new DvError('Gateway Timeout', 504);
        }
      }
      const latest = c.hist.length - 1;
      const idx = rec?.plan ? Math.max(0, latest - (rec.plan.reads?.shift() ?? 0)) : pickIdx(c, R);
      const n = W.n++;
      rec?.ev.push({ t: 'read', idx, latest, at: NOW, n });
      W.reads.push({ comp: c.id, idx, at: NOW, n, rec: rec?.n ?? -1 });
      log(`  ${tab.name} READ ${rec ? `rec#${rec.n}` : '(load)'} #${idx}/${latest}${idx < latest ? ' BEHIND' : ''}: ${show(c, c.hist[idx].st)}`);
      return render(c, c.hist[idx].st);
    },
    put: async (url: string, body: any) => write(tab, compOfUrl(url), body),
    post: async (name: string, body: any) => {
      if (name !== 'UpdateOptionValue') throw new Error('unexpected action ' + name);
      return write(tab, W.comps.opt, body);
    },
    /**
     * A write batch: its reads (the component, the column's layers), then the write, in order. Sent without
     * continue-on-error, a failed read stops it there. A gateway timeout (504) loses the whole answer.
     */
    batch: async (parts: Array<{ method: string; url: string; body?: any }>, o: { stop?: boolean } = {}) => {
      const out: any[] = [];
      for (const p of parts) {
        try {
          if (p.method === 'GET') out.push({ ok: true, status: 200, data: p.url.startsWith('msdyn_componentlayers') ? { value: layerRows(p.url, tab) } : probe(tab, p.url), headers: {} });
          else {
            await (p.method === 'PUT' ? write(tab, compOfUrl(p.url), p.body) : write(tab, W.comps.opt, p.body));
            out.push({ ok: true, status: 204, data: null, headers: {} });
          }
        } catch (e) {
          const x = e instanceof DvError ? e : new DvError(String(e), 500);
          if (p.method !== 'GET' && x.status === 504) throw x;
          out.push({ ok: false, status: x.status, data: null, error: x.message, code: x.code, headers: {} });
          if (o.stop) break;
        }
      }
      while (out.length < parts.length) out.push({ ok: false, status: 0, data: null, error: 'Dataverse sent no answer for this part of the request.', headers: {} });
      return out;
    },
  };
}

/**
 * The read in a write batch, right before its write: someone else may save first (P_OTHER_DURING), it may fail, and it
 * lags like any read during a lag episode or now and then, on the save's own random stream and without using up the
 * episode; in a scripted save it shows the latest state. Not one of the save's reads (I4) nor kept by the page (knew()).
 */
function probe(tab: Tab, url: string): any {
  const c = compOfUrl(url);
  const rec = tab.cur;
  const R = rec?.prnd ?? W.rnd;
  for (const [part, lang, text] of rec?.plan?.meanwhile?.splice(0) ?? []) apply(c, 'other', { [part]: { [lang]: text } }, `before the write of rec#${rec!.n}`, null);
  if (rec && !rec.plan) {
    if (R() < K.P_OTHER_DURING) otherEdit(c, R, `before the write of rec#${rec.n}`);
    if (R() < K.P_READ_FAIL) {
      rec.ev.push({ t: 'readfail', at: NOW });
      log(`  ${tab.name} PROBE rec#${rec.n} FAILED (504)`);
      throw new DvError('Gateway Timeout', 504);
    }
  }
  const latest = c.hist.length - 1;
  let idx = latest;
  if (rec && !rec.plan) {
    if (c.lag) idx = latest - c.lag.k;
    else if (R() < K.P_RANDOM_LAG) idx = latest - 1 - Math.floor(R() * 3);
  }
  idx = Math.max(0, idx);
  while (idx < latest && c.hist[idx + 1].at <= NOW - K.LAGMAX) idx++;
  const n = W.n++;
  rec?.ev.push({ t: 'probe', idx, latest, at: NOW, n });
  // The page keeps what the read before a write showed, as it keeps the save's own reads (knew()).
  W.reads.push({ comp: c.id, idx, at: NOW, n, rec: rec?.n ?? -1 });
  log(`  ${tab.name} PROBE ${rec ? `rec#${rec.n}` : ''} #${idx}/${latest}${idx < latest ? ' BEHIND' : ''}: ${show(c, c.hist[idx].st)}`);
  return render(c, c.hist[idx].st);
}
const newCtx = (tab: Tab) => ({ http: makeHttp(tab), base: EN, user: EN, orgId: 'fuzz', langs: LANGS.map((l) => ({ lcid: l, name: LN[l], isBase: l === EN })) });

function onPause(t: Tm): void {
  const rec = W?.active;
  if (!rec) return;
  let kind = 'conflict';
  for (let i = rec.ev.length - 1; i >= 0; i--) {
    const e = rec.ev[i];
    if (e.t === 'progress') {
      if (/show your last save/.test(e.m!)) {
        kind = 'lag';
        break;
      }
      if (/to confirm/.test(e.m!)) {
        kind = 'settle';
        break;
      }
      continue;
    }
    if (e.t === 'write') {
      kind = e.mode === 'lock' ? 'lock' : 'after-write';
      break;
    }
    if (e.t === 'read' || e.t === 'readfail') break;
  }
  rec.ev.push({ t: 'pause', ms: t.ms, kind, at: NOW });
  log(`  ${rec.tab.name} PAUSE rec#${rec.n} ${t.ms}ms (${kind})`);
  const stop = (d: number) =>
    addTimer(() => {
      if (rec.results || rec.error) return;
      rec.ev.push({ t: 'stop', at: NOW });
      log(`  ${rec.tab.name} STOP rec#${rec.n}`);
      rec.ac.abort();
    }, d);
  if (rec.plan) {
    rec.plan.pauses = (rec.plan.pauses ?? 0) + 1;
    if (rec.plan.stopAtPause === rec.plan.pauses) stop(Math.floor(t.ms / 2));
    return;
  }
  if (rec.rnd() < K.P_STOP) stop(Math.floor(rec.rnd() * t.ms));
  if (rec.rnd() < K.P_SLEEP) {
    const j = 30_000 + Math.floor(rec.rnd() * 40_000);
    t.at += j;
    log(`  (machine sleeps ${j}ms during that pause)`);
  }
}

// ---------- steps ----------

type SaveStep = { t: 'save'; tab: TabName; comp: CompId; how: 'new' | 'retry' | 'undo' | 'resolve'; seed: number };
/** A save scripted for a regression case: [part, lcid, after, before (default: the tab's slot)], with its Plan. */
type ScriptStep = { t: 'xsave'; tab: TabName; comp: CompId; ch: Array<[string, number, string, string?]>; plan?: Plan };
export type Step =
  | SaveStep
  | ScriptStep
  | { t: 'conc'; a: SaveStep; b: SaveStep }
  | { t: 'xconc'; a: ScriptStep; b: ScriptStep }
  | { t: 'other'; comp: CompId; seed: number }
  | { t: 'xother'; comp: CompId; part: string; lang: number; text: string }
  | { t: 'lag'; comp: CompId; k: number; n: number }
  | { t: 'jump'; ms: number }
  | { t: 'reload'; tab: TabName; seed: number };

function genSteps(seed: number, n: number): Step[] {
  const R = rng(seed * 7919 + 13);
  const focus = pickOf(R, ['attr', 'rel', 'opt'] as CompId[]);
  const comp = (): CompId => (R() < 0.75 ? focus : pickOf(R, ['attr', 'rel', 'opt'] as CompId[]));
  const save = (tab: TabName): SaveStep => {
    const r = R();
    const how = r < 0.55 ? 'new' : r < 0.75 ? 'retry' : r < 0.9 ? 'undo' : 'resolve';
    return { t: 'save', tab, comp: comp(), how, seed: Math.floor(R() * 2 ** 31) };
  };
  const out: Step[] = [];
  for (let i = 0; i < n; i++) {
    const r = R();
    if (r < 0.5) out.push(save(R() < 0.7 ? 'A' : 'B'));
    else if (r < 0.5 + K.P_CONC) out.push({ t: 'conc', a: save('A'), b: save('B') });
    else if (r < 0.5 + K.P_CONC + K.P_OTHER_STEP) out.push({ t: 'other', comp: comp(), seed: Math.floor(R() * 2 ** 31) });
    else if (r < 0.8) out.push({ t: 'lag', comp: comp(), k: 1 + Math.floor(R() * 3), n: 1 + Math.floor(R() * 8) });
    else if (r < 0.94) out.push({ t: 'jump', ms: pickOf(R, [300, 1000, 3000, 8000, 20000, 45000, 59000, 61000, 120000]) });
    else out.push({ t: 'reload', tab: R() < 0.7 ? 'A' : 'B', seed: Math.floor(R() * 2 ** 31) });
  }
  return out;
}

/** The changes of a save as the UI would make them: new edits, Try again, Undo (Recent publishes), keep mine after a conflict. */
function buildChanges(tab: Tab, s: SaveStep, R: () => number): { changes: Change[]; how: string; undoOf?: Entry } | null {
  const slot = (key: string) => tab.slots.get(key)!;
  const before = (key: string, l: number) => slot(key).labels[l] ?? '';
  const ofComp = (c: Change) => compOfKey(c.slot.key) === s.comp;
  if (s.how === 'retry') {
    const list = tab.pending.filter(ofComp);
    if (list.length) {
      const by = new Map<string, Change>();
      for (const c of list) by.set(cid(c), c);
      tab.pending = tab.pending.filter((c) => !ofComp(c));
      return { how: 'retry', changes: [...by.values()].map((c) => ({ slot: slot(c.slot.key), lcid: c.lcid, before: before(c.slot.key, c.lcid), after: c.after })) };
    }
  }
  if (s.how === 'undo') {
    const list = tab.history.filter((e) => e.items.every((i) => compOfKey(i.key) === s.comp));
    if (list.length) {
      const e = pickOf(R, list);
      return { how: 'undo', undoOf: e, changes: e.items.map((i) => ({ slot: slot(i.key), lcid: i.lcid, before: i.after, after: i.before })) };
    }
  }
  if (s.how === 'resolve') {
    const list = tab.conflicts.filter((x) => ofComp(x.c));
    if (list.length) {
      const x = pickOf(R, list);
      tab.conflicts = tab.conflicts.filter((y) => y !== x);
      const sl = slot(x.c.slot.key);
      if (x.server) sl.labels[x.c.lcid] = x.server;
      else delete sl.labels[x.c.lcid];
      if (R() < 0.4) {
        log(`${tab.name} Use theirs on ${shortId(cid(x.c))} ("${x.server}")`);
        return null;
      }
      return { how: 'keep-mine', changes: [{ slot: sl, lcid: x.c.lcid, before: x.server, after: x.c.after }] };
    }
  }
  const n = R() < 0.6 ? 1 : R() < 0.75 ? 2 : 3;
  const pairs = new Map<string, [string, number]>();
  for (let i = 0; i < n * 3 && pairs.size < n; i++) {
    const p = pickOf(R, PARTS[s.comp]);
    const l = pickOf(R, LANGS);
    pairs.set(`${p}#${l}`, [p, l]);
  }
  const changes: Change[] = [];
  for (const [p, l] of pairs.values()) {
    const key = KEYS[s.comp](p);
    const b = before(key, l);
    let k = Math.floor(R() * 4);
    let after = pool(s.comp, p, l, k);
    if (after === b) after = pool(s.comp, p, l, (k = (k + 1) % 4));
    changes.push({ slot: slot(key), lcid: l, before: b, after });
  }
  return { how: 'new', changes };
}

function startSave(s: SaveStep | ScriptStep, conc: boolean): Rec | null {
  const tab = W.tabs[s.tab];
  const R = rng(s.t === 'save' ? s.seed : 1);
  const b =
    s.t === 'save'
      ? buildChanges(tab, s, R)
      : {
          how: 'script',
          undoOf: undefined,
          changes: s.ch.map(([p, l, after, before]): Change => {
            const slot = tab.slots.get(KEYS[s.comp](p))!;
            return { slot, lcid: l, before: before ?? slot.labels[l] ?? '', after };
          }),
        };
  if (!b || !b.changes.length) return null;
  const known = b.changes.flatMap((c): Array<[string, string]> => [[cid(c), txt({ ...c, after: c.before })], [cid(c), c.slot.labels[c.lcid] ?? '']]);
  const rec: Rec = { n: W.recs.length, step: W.step, tab, comp: W.comps[s.comp], changes: b.changes, ev: [], t0: NOW, ac: new AbortController(), rnd: R, prnd: rng((s.t === 'save' ? s.seed : 1) ^ 0x2545f491), conc, how: b.how, undoOf: b.undoOf, n0: W.n++, known };
  if (s.t === 'xsave') rec.plan = JSON.parse(JSON.stringify(s.plan ?? {}));
  W.recs.push(rec);
  tab.cur = rec;
  log(`${tab.name} SAVE rec#${rec.n} (${b.how}) ${b.changes.map((c) => `${shortId(cid(c))} "${c.before}"->"${c.after}"`).join(', ')}`);
  const o = { signal: rec.ac.signal, publish: new PublishSet(), progress: (m: string) => void rec.ev.push({ t: 'progress', m, at: NOW }), force: new Set<string>(), lang: null as never, allowPublish: true };
  const w = metadataWriters.find((x) => x.kinds.includes(b.changes[0].slot.kind))!;
  rec.p = w.save(tab.ctx, b.changes, o).then(
    (r) => void (rec.results = r),
    (e) => void (rec.error = e),
  );
  return rec;
}

function addViol(inv: string, detail: string): void {
  W.viol.push({ inv, seed: W.seed, step: W.step, detail });
  log(`!!! VIOLATION ${inv}: ${detail}`);
}

const isOk = (r: ChangeResult) => r.outcome === 'saved' || r.outcome === 'unchanged';
const REFUSAL = (m = '') => /^Not saved: Dataverse doesn't show your last change/.test(m) || (/hasn't confirmed it yet\. Try again/.test(m) && !/checking again failed/.test(m));
const ours = (actor: string) => actor === 'A' || actor === 'B';

/**
 * The languages of `comp` that a tab wrote (applied, as asked) in the minute before `at`, and the latest state that write
 * made: what a page can tell lag by (see the top).
 */
function recent(comp: Comp, at: number): { ids: Set<string>; last: number } {
  const own = W.applied.filter((a) => ours(a.actor) && idParts(a.id).comp === comp.id && a.at <= at && a.at > at - 60_000);
  return { ids: new Set(own.map((a) => a.id)), last: Math.max(-1, ...own.map((a) => a.idx)) };
}
/**
 * True when the read `e` can't be told apart from one behind a recent write of a tab: it agrees, on every language the tabs
 * wrote in the last minute, with a state from before one of those writes that was current less than a minute before.
 */
function ambiguous(comp: Comp, e: Ev): boolean {
  const { ids, last } = recent(comp, e.at);
  if (!ids.size) return false;
  const st = comp.hist[e.idx!].st;
  for (let j = 0; j < last; j++) if (j !== e.idx && comp.hist[j + 1].at > e.at - 60_000 && [...ids].every((id) => valIn(comp.hist[j].st, id) === valIn(st, id))) return true;
  return false;
}

/**
 * True when a read of a save is one whose texts the page keeps (accepted() in the writers): one before a write of that
 * save, not the reads that check a write nor those of a save that wrote nothing.
 */
function kept(r: { rec: number; n: number }): boolean {
  const ev = r.rec < 0 ? [] : W.recs[r.rec].ev;
  const i = ev.findIndex((x) => (x.t === 'read' || x.t === 'probe') && x.n === r.n);
  for (const e of ev.slice(i + 1)) {
    // The read in a write's batch reaches the page only with the batch's answer (a 504 loses it).
    if (e.t === 'write' && e.mode !== 'lock') return ev[i]?.t !== 'probe' || (e.mode !== '504a' && e.mode !== '504n');
    if (e.t === 'pause' && e.kind === 'settle') return false;
  }
  return false;
}
/**
 * True when the tabs knew the text `t` in language `id` in the minute before their write `a`: a read made while saving
 * that label showed it there (kept()), an edit of it started from it or its slot held it in a save that wrote, or a write
 * of theirs put it there (what the page records, MINE). What a page never saw or kept, it can't tell from anything else.
 */
function knew(id: string, t: string, a: { n: number; at: number; idx?: number }): boolean {
  const c = W.comps[idParts(id).comp];
  const near = (x: { at: number; n: number }) => x.n < a.n && x.at > a.at - 60_000;
  const saving = (rec: number) => rec >= 0 && W.recs[rec].changes.some((x) => x.slot.key === idParts(id).key);
  return (
    W.reads.some((r) => r.comp === c.id && near(r) && saving(r.rec) && kept(r) && valIn(c.hist[r.idx].st, id) === t) ||
    W.recs.some((r) => near({ at: r.t0, n: r.n0 }) && r.ev.some((e) => e.t === 'write' && e.mode !== 'lock') && r.known.some(([x, y]) => x === id && y === t)) ||
    W.applied.some((b) => ours(b.actor) && b.id === id && near(b) && b.idx < (a.idx ?? Infinity) && b.to === t)
  );
}
/**
 * True when the tabs did not know `have` in language `id` when tab `tab` last wrote `v` there (their reads lagged behind
 * someone else's edit, or saw it only while saving another label): a later read showing it looks like someone else's
 * newer text (see the top).
 */
function unseen(tab: string, id: string, v: string, have: string): boolean {
  const a = [...W.applied].reverse().find((x) => x.id === id && x.actor === tab && x.intended && x.to === v);
  return !!a && !knew(id, have, a);
}
/**
 * True when, in the minute before `at`, a tab wrote in `comp` a text that was there in the minute before that write while
 * the tabs never saw it there: the page takes that text for its own, and a read showing it for proof of its write.
 */
function collided(comp: CompId, at: number): boolean {
  const c = W.comps[comp];
  return W.wrote.some(
    (a) =>
      idParts(a.id).comp === comp &&
      a.at <= at &&
      a.at > at - 60_000 &&
      c.hist.some((h, j) => j < a.idx && c.hist[j + 1].at > a.at - 60_000 && valIn(h.st, a.id) === a.to) &&
      !knew(a.id, a.to, a),
  );
}

/**
 * True when the read `e` shows, in a label a tab saved in the last minute, a text the tabs knew there before that save's
 * write (knew()) and the write replaced (with its edit or with what it sent back), put back by someone else since, and
 * nothing that tells it from a read behind that write: no language whose text was last put there by a write of the tabs
 * after it, a text they never knew there before (past() in the writers). A write applied that changed nothing (the next
 * round writing what the first one already made) is told apart from the last one of that save that changed something.
 */
function putBack(comp: Comp, e: Ev): boolean {
  const st = comp.hist[e.idx!].st;
  const at = (x: Ev, id: string) => valIn(comp.hist[x.idx!].st, id);
  const ids = comp.parts.flatMap((p) => LANGS.map((l) => `${KEYS[comp.id](p)}#${l}`));
  const madeSince = (n: number) =>
    ids.some((id) => {
      const a = [...W.applied].reverse().find((b) => b.id === id && b.idx <= e.idx!);
      return !!a && ours(a.actor) && a.intended && a.n > n && !knew(id, a.to, a);
    });
  return W.recs.some(
    (rec) =>
      rec.comp === comp &&
      rec.ev.some((w, i) => {
        if (w.t !== 'write' || w.mode === 'lock' || w.at <= e.at - 60_000 || w.n! > e.n!) return false;
        const changed = (j: number) => rec.ev[j].t === 'write' && (['drop', '504n'].includes(rec.ev[j].mode!) || W.applied.some((b) => b.rec === rec.n && b.ev === j + 1));
        let base = i;
        while (base >= 0 && !changed(base)) base--;
        if (base < 0 || madeSince(rec.ev[base].n!)) return false;
        const seen = rec.ev.slice(0, i).filter((x) => x.t === 'read');
        if (!seen.length) return false;
        return [...new Set(rec.changes.map((c) => c.slot.key))].some((key) =>
          LANGS.some((l) => {
            const id = `${key}#${l}`;
            const t = valIn(st, id);
            const c = rec.changes.find((x) => cid(x) === id);
            const wrote = c ? txt(c) : at(seen[seen.length - 1], id);
            return t !== wrote && knew(id, t, { n: w.n!, at: w.at }) && W.applied.some((b) => b.actor === 'other' && b.id === id && b.to === t && b.n > w.n! && b.idx <= e.idx!);
          }),
        );
      }),
  );
}

function finishSave(rec: Rec): void {
  const tab = rec.tab;
  tab.cur = null;
  rec.done = true;
  const res: ChangeResult[] = rec.results ?? rec.changes.map((change) => ({ change, outcome: 'error' as const, message: `(threw) ${(rec.error as Error)?.message || rec.error}` }));
  rec.results = res;
  if (debug) log(`  MINE ${LS.get('dxt:mine:fuzz')}`);
  log(`${tab.name} RESULT rec#${rec.n}: ${res.map((r) => `${shortId(cid(r.change))}=${r.outcome}${r.message ? ` "${r.message}"` : ''}${r.server !== undefined ? ` server="${r.server}"` : ''}`).join(' | ')}`);
  const comp = rec.comp;
  const reads = rec.ev.filter((e) => e.t === 'read');
  const someoneElse = (id: string) => W.applied.some((a) => a.id === id && a.at >= rec.t0 && a.actor !== tab.name && (a.actor === 'other' || a.intended));

  // I2: what the save calls saved (or already as asked) is on the server, unless a read of it that lagged agrees, on every
  // language the tabs wrote in the last minute and every language of this save, with the state this save asked for.
  const asked = (id: string) => {
    const r = res.find((x) => cid(x.change) === id && isOk(x));
    return r ? txt(r.change) : truth(id);
  };
  // (Or a read that lagged only behind someone else's edits showed it: no page can tell that read from a fresh one.) Not for
  // what the column's save calls saved when its layers answer: the database tells, and the writers ask it (byLayers).
  const lookedDone = (id: string, saved: boolean) =>
    !(saved && comp.id === 'attr' && W.layers) &&
    reads.some(
      (e) =>
        e.idx! < e.latest! &&
        valIn(comp.hist[e.idx!].st, id) === asked(id) &&
        (comp.hist.slice(e.idx! + 1, e.latest! + 1).every((h) => !ours(h.actor)) || [...new Set([...recent(comp, e.at).ids, ...rec.changes.map(cid)])].every((x) => valIn(comp.hist[e.idx!].st, x) === asked(x))),
    );
  for (const r of res)
    if (isOk(r)) {
      const id = cid(r.change);
      if (truth(id) !== txt(r.change) && !someoneElse(id) && !lookedDone(id, r.outcome === 'saved') && !unseen(tab.name, id, txt(r.change), truth(id)) && !collided(comp.id, NOW))
        addViol(r.outcome === 'saved' ? 'I2' : 'I2u', `rec#${rec.n} ${tab.name} reported ${r.outcome} for ${shortId(id)}="${txt(r.change)}" but the server holds "${truth(id)}"`);
    }

  // What the tab now holds (the UI's store, Try again, Undo, conflicts).
  for (const r of res) {
    const c = r.change;
    const id = cid(c);
    if (isOk(r)) {
      const v = txt(c);
      for (const s of new Set([tab.slots.get(c.slot.key)!, c.slot]))
        if (v) s.labels[c.lcid] = v;
        else delete s.labels[c.lcid];
      // A text already as asked is this page's only when a tab wrote it in the last minute: otherwise it is someone else's
      // that the page found as asked, and recording it would make the page wait for nobody's write (I3).
      const mine = r.outcome === 'saved' || W.wrote.some((a) => a.id === id && a.to === v && a.at > NOW - 60_000);
      if (truth(id) === v && !someoneElse(id) && mine) tab.claims.set(id, { v, alt: [], why: `${r.outcome} rec#${rec.n}` });
      else if (tab.claims.get(id)?.v !== v) tab.claims.delete(id);
      tab.pending = tab.pending.filter((p) => cid(p) !== id);
      tab.conflicts = tab.conflicts.filter((x) => cid(x.c) !== id);
    } else if (r.outcome === 'conflict' || /^Dataverse did not keep this change/.test(r.message || '')) {
      // The save told the user the server holds another text: what it wrote is no longer claimed.
      if (tab.claims.get(id)?.why === `applied write rec#${rec.n}`) tab.claims.delete(id);
    }
    if (r.outcome === 'conflict') {
      tab.conflicts = tab.conflicts.filter((x) => cid(x.c) !== id);
      tab.conflicts.push({ c, server: r.server ?? '' });
      tab.pending = tab.pending.filter((p) => cid(p) !== id);
    } else if (!isOk(r) && !/can't remove|can't be blank/i.test(r.message || '')) {
      tab.pending = tab.pending.filter((p) => cid(p) !== id);
      tab.pending.push(c);
    }
  }
  for (const r of res) if (r.outcome === 'unchanged') W.ourWrites.push({ comp: comp.id, at: NOW, mode: 'unchanged' });
  const items = res
    .filter((r) => r.outcome === 'saved' || (rec.how !== 'undo' && r.outcome === 'unchanged' && r.change.before !== txt(r.change)))
    .map((r) => ({ key: r.change.slot.key, lcid: r.change.lcid, before: r.change.before, after: txt(r.change) }));
  if (items.length) tab.history.push({ items });
  if (rec.undoOf && res.every(isOk)) tab.history = tab.history.filter((e) => e !== rec.undoOf);

  // I1: nothing a tab holds was put back silently, unless it was a text the write that replaced it never read (see the top).
  if (res.some(isOk))
    for (const t of Object.values(W.tabs))
      for (const [id, cl] of [...t.claims]) {
        const have = truth(id);
        if (have === cl.v || cl.alt.includes(have)) continue;
        // A save of two at once that has not been taken in yet is judged when it is (it may report a conflict there).
        if (W.recs.some((x) => !x.done && x !== rec && cl.why === `applied write rec#${x.n}`)) continue;
        t.claims.delete(id);
        const last = [...W.applied].reverse().find((a) => a.id === id);
        if (unseen(t.name, id, cl.v, have) || collided(idParts(id).comp, NOW)) continue;
        addViol('I1', `after rec#${rec.n} (${tab.name}): ${t.name}'s ${shortId(id)} should hold "${cl.v}" (${cl.why}) but the server holds "${have}" (last change by ${last?.actor} rec#${last?.rec}${last?.intended ? '' : ', unintended'})`);
      }

  // I5: someone else's text that a write of this save put back to what its read showed is written back, or the save says
  // something; unless the read in that write's batch lagged and the column's layers did not answer (no read could show it).
  if (res.every(isOk))
    for (const a of W.applied.filter((x) => x.rec === rec.n && x.actor === tab.name && !x.intended)) {
      const prev = [...W.applied].reverse().find((b) => b.id === a.id && b.n < a.n);
      if (!prev || prev.actor === tab.name || prev.to !== a.from) continue; // not someone else's text
      if (truth(a.id) !== a.to || W.applied.some((b) => b.id === a.id && b.n > a.n && b.actor !== tab.name)) continue; // theirs is back, or newer
      const w = rec.ev.findIndex((e) => e.t === 'write' && e.n !== undefined && e.n < a.n && !rec.ev.slice(rec.ev.indexOf(e) + 1).some((f) => f.t === 'write' && f.n! < a.n));
      const pr = [...rec.ev.slice(0, Math.max(0, w))].reverse().find((e) => e.t === 'probe');
      // (A read that agrees with a state from before a recent write of the tabs, or with one a write of theirs that may not
      // have run replaced, can't be told from one lagging behind it: I3.)
      const unsure = W.ourWrites.some((x) => x.comp === comp.id && (x.mode === 'drop' || x.mode === '504n') && !!pr && x.at >= pr.at - 60_000);
      const seen = !!pr && pr.idx === pr.latest && !ambiguous(comp, pr) && !putBack(comp, pr) && !unsure && !rec.ev.slice(rec.ev.indexOf(pr), w).some((e) => e.t === 'readfail');
      if (seen || (comp.id === 'attr' && W.layers)) addViol('I5', `rec#${rec.n} (${tab.name}) put back ${shortId(a.id)} "${a.from}" -> "${a.to}" (${prev.actor}'s text) and reported ${res.map((r) => r.outcome).join(',')}`);
    }
  if (rec.conc) return;

  // I3: a refusal or a wait only for a read behind a write of a tab (or one that can't be told apart from one: it agrees
  // with an earlier state on what the tabs wrote, or shows a text they replaced put back), or a write of theirs dropped.
  const unclear = (e: Ev) => ambiguous(comp, e) || putBack(comp, e);
  const behindOurs = (upTo: number) => rec.ev.slice(0, upTo).some((e) => e.t === 'read' && (comp.hist.slice(e.idx! + 1, e.latest! + 1).some((h) => ours(h.actor)) || unclear(e)));
  const droppedOurs = W.ourWrites.some((w) => w.comp === comp.id && (w.mode === 'drop' || w.mode === '504n') && w.at >= rec.t0 - 60_000);
  const refusals = res.filter((r) => REFUSAL(r.message));
  if (refusals.length) {
    if (!behindOurs(rec.ev.length) && !droppedOurs) addViol('I3', `rec#${rec.n} refused (${refusals.map((r) => shortId(cid(r.change))).join(',')}) with no read behind a write of A/B and no dropped write of theirs in 60 s`);
    const lastOur = Math.max(-Infinity, ...W.ourWrites.filter((w) => w.comp === comp.id && w.mode !== 'lock' && w.at <= rec.t0 + 60_000).map((w) => w.at));
    if (NOW - lastOur > 60_000) addViol('I3-60', `rec#${rec.n} refused ${(NOW - lastOur) / 1000}s after the last write of A/B on ${comp.id}`);
  }
  let waited = false;
  rec.ev.forEach((e, i) => {
    if (e.t !== 'pause' || (e.kind !== 'lag' && e.kind !== 'settle') || behindOurs(i) || droppedOurs) return;
    if (e.kind === 'lag' && !waited) {
      waited = true;
      addViol('I3w', `rec#${rec.n} waited (lag) with no read behind a write of A/B and no dropped write of theirs`);
    }
    if (e.kind === 'settle') addViol('I3s', `rec#${rec.n} waited to confirm with no read behind a write of A/B and no dropped write of theirs`);
  });

  // I4: fresh reads, its writes applied, nobody else at work, everything saved: 2 reads, 1 write, no wait.
  const fresh = reads.every((e) => e.idx === e.latest && !unclear(e)) && !rec.ev.some((e) => e.t === 'readfail' || e.t === 'stop');
  const writes = rec.ev.filter((e) => e.t === 'write');
  const pauses = rec.ev.filter((e) => e.t === 'pause');
  const nobody = !W.applied.some((a) => a.at >= rec.t0 && a.actor !== tab.name && idParts(a.id).comp === comp.id);
  if (fresh && nobody && !droppedOurs && writes.every((e) => e.mode === 'ok') && res.every((r) => r.outcome === 'saved') && (reads.length !== 2 || writes.length !== 1 || pauses.length))
    addViol('I4', `rec#${rec.n}: fresh reads, all saved, but ${reads.length} reads, ${writes.length} writes, pauses ${pauses.map((p) => `${p.ms}/${p.kind}`).join(',') || 'none'}`);
}

async function runStep(s: Step): Promise<void> {
  if (s.t === 'save' || s.t === 'xsave') {
    const rec = startSave(s, false);
    if (!rec) return;
    await drive([rec.p!]);
    W.active = null;
    finishSave(rec);
  } else if (s.t === 'conc' || s.t === 'xconc') {
    const ps = [startSave(s.a, true), startSave(s.b, true)].filter(Boolean) as Rec[];
    if (!ps.length) return;
    await drive(ps.map((r) => r.p!));
    W.active = null;
    for (const r of ps) finishSave(r);
  } else if (s.t === 'other') otherEdit(W.comps[s.comp], rng(s.seed), 'step');
  else if (s.t === 'xother') apply(W.comps[s.comp], 'other', { [s.part]: { [s.lang]: s.text } }, 'script', null);
  else if (s.t === 'lag') {
    W.comps[s.comp].lag = { k: s.k, n: s.n };
    log(`lag episode on ${s.comp}: k=${s.k} n=${s.n}`);
  } else if (s.t === 'jump') {
    NOW += s.ms;
    log(`clock +${s.ms}ms`);
  } else if (s.t === 'reload') {
    // A new instance: nothing in memory, the slots loaded from (possibly lagging) reads.
    const tab = W.tabs[s.tab];
    tab.ctx = newCtx(tab);
    tab.pending = [];
    tab.conflicts = [];
    log(`${tab.name} RELOAD`);
    const saved = W.rnd;
    W.rnd = rng(s.seed);
    for (const id of ['attr', 'rel', 'opt'] as CompId[]) {
      const url = id === 'rel' ? 'RelationshipDefinitions(x)' : id === 'opt' ? 'x/PicklistAttributeMetadata' : 'x';
      const cur = await tab.ctx.http.get(url);
      const st: St =
        id === 'attr'
          ? { DisplayName: toLabels(cur.DisplayName), Description: toLabels(cur.Description) }
          : id === 'rel'
            ? { '1': toLabels(cur.Entity1AssociatedMenuConfiguration.Label), '2': toLabels(cur.Entity2AssociatedMenuConfiguration.Label) }
            : { Label: toLabels(cur.OptionSet.Options[0].Label), Description: toLabels(cur.OptionSet.Options[0].Description) };
      for (const p of W.comps[id].parts) tab.slots.set(KEYS[id](p), mkSlot(id, p, Object.fromEntries(Object.entries(st[p]).filter(([, v]) => v !== ''))));
    }
    W.rnd = saved;
  }
}

function newWorld(seed: number, layers = seed % 5 !== 0): void {
  // Each run is a new page a day later (module state such as the write counter carries over, as in a browser).
  BASE = T0 + ++worlds * 86_400_000;
  NOW = BASE;
  timers = [];
  LS.clear();
  lockQ.clear();
  lockHeld.clear();
  const comps = Object.fromEntries((['attr', 'rel', 'opt'] as CompId[]).map((id) => [id, { id, parts: PARTS[id], hist: [{ st: initState(id), at: NOW - 3_600_000, actor: 'init' }], lag: null }])) as Record<CompId, Comp>;
  const tab = (name: TabName): Tab => {
    const t: Tab = { name, ctx: null, slots: new Map(), claims: new Map(), pending: [], conflicts: [], history: [], cur: null };
    t.ctx = newCtx(t);
    for (const c of Object.values(comps)) for (const p of c.parts) t.slots.set(KEYS[c.id](p), mkSlot(c.id, p, c.hist[0].st[p]));
    return t;
  };
  W = { seed, layers, comps, tabs: { A: tab('A'), B: tab('B') }, log: [], viol: [], ourWrites: [], applied: [], recs: [], reads: [], wrote: [], n: 0, step: 0, active: null, rnd: rng(seed ^ 0x5bd1e995) };
}

async function runSeq(seed: number, steps: Step[], layers?: boolean): Promise<World> {
  newWorld(seed, layers);
  for (let i = 0; i < steps.length; i++) {
    W.step = i;
    log(`--- step ${i}: ${JSON.stringify(steps[i])}`);
    try {
      await runStep(steps[i]);
    } catch (e) {
      addViol('CRASH', `${(e as Error)?.stack || e}`);
      break;
    }
  }
  return W;
}

/** The shortest sequence (steps dropped one at a time) that still shows the violation `inv`. */
async function shrink(seed: number, steps: Step[], inv: string): Promise<Step[]> {
  const has = async (ss: Step[]) => (await runSeq(seed, ss)).viol.some((v) => v.inv === inv);
  const first = (await runSeq(seed, steps)).viol.find((v) => v.inv === inv);
  let cur = steps.slice(0, (first?.step ?? steps.length - 1) + 1);
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = cur.length - 1; i >= 0; i--) {
      const cand = [...cur.slice(0, i), ...cur.slice(i + 1)];
      if (await has(cand)) {
        cur = cand;
        changed = true;
      }
    }
  }
  return cur;
}

/** Runs the sequences of `seeds`; on a violation, the log of the shortest sequence that shows the first one. */
export async function fuzz(seeds: number[], steps = STEPS): Promise<{ seqs: number; saves: number; viol: Viol[]; trace: string }> {
  return withFakes(async () => {
    const viol: Viol[] = [];
    let saves = 0;
    for (const seed of seeds) {
      const w = await runSeq(seed, genSteps(seed, steps));
      saves += w.recs.length;
      viol.push(...w.viol);
    }
    let trace = '';
    if (viol.length) {
      const v = viol[0];
      const min = await shrink(v.seed, genSteps(v.seed, steps), v.inv);
      const w = await runSeq(v.seed, min);
      trace = `seed ${v.seed}, ${min.length} steps: ${JSON.stringify(min)}\n${w.log.join('\n')}`;
    }
    return { seqs: seeds.length, saves, viol, trace };
  });
}

let debug = false;
/** The log of seed `seed`, shrunk to the steps that still show `inv` when given (to debug a failure by hand); `mine` adds the record after each save. */
export async function trace(seed: number, inv?: string, mine = false, steps = STEPS): Promise<string> {
  return withFakes(async () => {
    const all = genSteps(seed, steps);
    const min = inv ? await shrink(seed, all, inv) : all;
    debug = mine;
    const w = await runSeq(seed, min);
    debug = false;
    return `seed ${seed}, ${min.length} steps: ${JSON.stringify(min)}\n${w.log.join('\n')}`;
  });
}

/** Runs scripted steps (a regression case), with or without the column's layers, and returns its violations and log. */
export async function script(steps: Step[], layers = false): Promise<{ viol: Viol[]; log: string }> {
  return withFakes(async () => {
    const w = await runSeq(0, steps, layers);
    return { viol: w.viol, log: w.log.join('\n') };
  });
}

/** Scripted cases of earlier reviews (each name says what once went wrong); each must keep I1-I5. */
const REGRESSIONS: Record<string, Step[]> = {
  R1_aba_verify_corrupts_mine_then_silent_self_revert: [
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['Description', 1036, 'DFR1']] },
    { t: 'jump', ms: 1000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR1']] },
    { t: 'jump', ms: 1000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR0']], plan: { reads: [0, 3] } },
    { t: 'jump', ms: 1000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['Description', 1031, 'DDE1']], plan: { reads: [3, 0] } },
  ],
  R1b_aba_dropped_undo_reported_saved: [
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR1']] },
    { t: 'jump', ms: 2000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR0']], plan: { reads: [0, 0, 1], writes: ['drop'] } },
  ],
  R1c_atomic_write_half_confirmed: [
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['Description', 1033, 'DEN1']] },
    { t: 'jump', ms: 2000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['Description', 1033, 'DEN0'], ['DisplayName', 1036, 'NFR2']], plan: { reads: [0, 1], writes: ['drop'], stopAtPause: 1 } },
  ],
  R2_previous_own_text_not_replaced_silent_self_revert: [
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR1']], plan: { writes: ['504a'] } },
    { t: 'jump', ms: 2000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR2']], plan: { reads: [1, 0] } },
    { t: 'jump', ms: 2000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1033, 'NEN1']], plan: { reads: [1, 0] } },
  ],
  R2b_previous_own_text_false_unchanged: [
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR1']], plan: { reads: [0, 1], stopAtPause: 1 } },
    { t: 'jump', ms: 2000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR2', 'NFR0']], plan: { reads: [1, 0] } },
    { t: 'jump', ms: 2000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR1', 'NFR2']], plan: { reads: [1, 1, 1] } },
  ],
  R2c_older_text_two_writes_back_cross_tab: [
    { t: 'xother', comp: 'attr', part: 'DisplayName', lang: 1031, text: 'NDE4' },
    { t: 'jump', ms: 2000 },
    { t: 'xsave', tab: 'B', comp: 'attr', ch: [['DisplayName', 1031, 'NDE1', 'NDE4']] },
    { t: 'jump', ms: 2000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR1']], plan: { reads: [2, 0] } },
  ],
  R3_putback_refused_although_read_shows_later_write: [
    { t: 'xsave', tab: 'A', comp: 'rel', ch: [['1', 1036, 'PFR3']] },
    { t: 'jump', ms: 2000 },
    { t: 'xsave', tab: 'A', comp: 'rel', ch: [['2', 1036, 'QFR3'], ['1', 1033, 'PEN3']] },
    { t: 'jump', ms: 5000 },
    { t: 'xother', comp: 'rel', part: '1', lang: 1036, text: 'PFR0' },
    { t: 'xsave', tab: 'A', comp: 'rel', ch: [['2', 1031, 'QDE1']] },
  ],
  R4_refusal_more_than_60s_after_write: [
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR1']], plan: { reads: [0, 1, 1, 1, 1, 0] } },
    { t: 'jump', ms: 44000 },
    { t: 'xother', comp: 'attr', part: 'DisplayName', lang: 1036, text: 'NFR0' },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1033, 'NEN1']] },
  ],
  R5_two_tabs_saving_at_once: [
    { t: 'xconc', a: { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR1']] }, b: { t: 'xsave', tab: 'B', comp: 'attr', ch: [['DisplayName', 1031, 'NDE1']], plan: { writeDelay: 500 } } },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['Description', 1036, 'DFR1']] },
  ],
  R6_conflict_cleared_by_stale_reread: [
    { t: 'xother', comp: 'attr', part: 'DisplayName', lang: 1033, text: 'NEN4' },
    { t: 'jump', ms: 3000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1033, 'NEN3', 'NEN0']], plan: { reads: [0, 0, 1, 0] } },
  ],
  R6b_conflict_cleared_by_stale_reread_option: [
    { t: 'xother', comp: 'opt', part: 'Label', lang: 1033, text: 'LEN4' },
    { t: 'jump', ms: 3000 },
    { t: 'xsave', tab: 'A', comp: 'opt', ch: [['Label', 1033, 'LEN3', 'LEN0']], plan: { reads: [0, 0, 1, 0] } },
  ],
  R5b_lock_retry_then_stale_read: [
    { t: 'xconc', a: { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR1']], plan: { reads: [0, 0] } }, b: { t: 'xsave', tab: 'B', comp: 'attr', ch: [['DisplayName', 1031, 'NDE1']], plan: { reads: [0, 1, 0], writes: ['lock', 'ok'] } } },
    { t: 'jump', ms: 1000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['Description', 1036, 'DFR1']] },
  ],
  R1x_reads_4_0: [
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['Description', 1036, 'DFR1']] },
    { t: 'jump', ms: 1000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR1']] },
    { t: 'jump', ms: 1000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR0']], plan: { reads: [0, 3] } },
    { t: 'jump', ms: 1000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['Description', 1031, 'DDE1']], plan: { reads: [4, 4, 4, 4, 4, 0] } },
  ],
  R1y_verify_lag_then_settle_lag: [
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['Description', 1036, 'DFR1']] },
    { t: 'jump', ms: 1000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR1']] },
    { t: 'jump', ms: 1000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR0']], plan: { reads: [0, 3, 3, 3, 3, 3, 0, 0] } },
    { t: 'jump', ms: 1000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['Description', 1031, 'DDE1']], plan: { reads: [3, 0] } },
  ],
  R1z_undo_fresh_verify_shows_other_lang_old: [
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['Description', 1036, 'DFR1']] },
    { t: 'jump', ms: 1000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR1']] },
    { t: 'jump', ms: 1000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR0']], plan: { reads: [0, 1] } },
    { t: 'jump', ms: 1000 },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['Description', 1031, 'DDE1']], plan: { reads: [3, 0] } },
  ],
  R3opt_putback_same_write_other_lang: [
    { t: 'xsave', tab: 'A', comp: 'opt', ch: [['Label', 1036, 'LFR1'], ['Description', 1033, 'OEN2']] },
    { t: 'jump', ms: 5000 },
    { t: 'xother', comp: 'opt', part: 'Label', lang: 1036, text: 'LFR0' },
    { t: 'xsave', tab: 'A', comp: 'opt', ch: [['Label', 1036, 'LFR1', 'LFR0']] },
  ],
  R3attr_putback_same_write_other_lang: [
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR1'], ['Description', 1033, 'DEN2']] },
    { t: 'jump', ms: 5000 },
    { t: 'xother', comp: 'attr', part: 'DisplayName', lang: 1036, text: 'NFR0' },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1031, 'NDE1']] },
  ],
  R3opt_round2_restamp: [
    { t: 'xsave', tab: 'A', comp: 'opt', ch: [['Label', 1031, 'LDE1'], ['Description', 1033, 'OEN2']], plan: { reads: [0, 1, 1, 1, 1, 1, 1, 0] } },
    { t: 'jump', ms: 2000 },
    { t: 'xother', comp: 'opt', part: 'Label', lang: 1031, text: 'LDE0' },
    { t: 'xsave', tab: 'A', comp: 'opt', ch: [['Label', 1031, 'LDE1', 'LDE0']] },
  ],
  T1_try_again_after_another_save: [
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1031, 'NDE1']], plan: { writes: ['drop', 'drop'] } },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['Description', 1033, 'DEN1']] },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1031, 'NDE1', 'NDE0']], plan: { reads: [1, 0] } },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR1']], plan: { reads: [1, 1, 1, 1, 1, 1] } },
  ],
  T2_same_text_again_after_put_back: [
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1031, 'NDE1'], ['Description', 1033, 'DEN1']] },
    { t: 'jump', ms: 2000 },
    { t: 'xother', comp: 'attr', part: 'DisplayName', lang: 1031, text: 'NDE0' },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1031, 'NDE1', 'NDE0']] },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR1']], plan: { reads: [1, 1, 1, 1, 1, 1] } },
  ],
  T3_round2_restamp_conflict: [
    { t: 'xsave', tab: 'A', comp: 'opt', ch: [['Label', 1031, 'LDE1'], ['Label', 1036, 'LFR2']], plan: { reads: [0, 1, 1, 1, 1, 1, 1, 0] } },
    { t: 'jump', ms: 2000 },
    { t: 'xother', comp: 'opt', part: 'Label', lang: 1031, text: 'LDE0' },
    { t: 'xsave', tab: 'A', comp: 'opt', ch: [['Label', 1031, 'LDE2', 'LDE1']] },
  ],
  // Someone else saves between a save's read and its write (the read in the write's batch shows it): another language of the
  // label the PUT sends back is written back from the layers (or, without them, said); the same language is a conflict.
  X1_other_language_saved_before_the_write: [{ t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR1']], plan: { meanwhile: [['DisplayName', 1031, 'NDE4']] } }],
  X2_same_language_saved_before_the_write: [
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR1'], ['Description', 1033, 'DEN1']], plan: { meanwhile: [['DisplayName', 1036, 'NFR4']] } },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['Description', 1036, 'DFR1']] },
  ],
  X3_relationship_other_side_saved_before_the_write: [{ t: 'xsave', tab: 'A', comp: 'rel', ch: [['1', 1036, 'PFR1']], plan: { meanwhile: [['2', 1036, 'QFR4']] } }],
  X4_option_same_language_saved_before_the_write: [{ t: 'xsave', tab: 'A', comp: 'opt', ch: [['Label', 1036, 'LFR1']], plan: { meanwhile: [['Label', 1036, 'LFR4'], ['Label', 1031, 'LDE4']] } }],
  // The layers confirm a save the reads lag behind; its Undo is dropped, and its first read, still behind that save, shows
  // the Undo's text: with the layers it is written again, never reported saved.
  L1_undo_dropped_after_layer_confirmed_save: [
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR1']], plan: { reads: [0, 1] } },
    { t: 'xsave', tab: 'A', comp: 'attr', ch: [['DisplayName', 1036, 'NFR0', 'NFR1']], plan: { reads: [0, 1], writes: ['drop'] } },
  ],
};

export function register(t: Kit): void {
  const seeds = [...Array.from({ length: SEQS }, (_, i) => i + 1), ...EXTRA];
  t.test(`save path (fuzz): ${seeds.length} random sequences of metadata saves under lagging reads, dropped writes, other makers and two tabs keep I1-I5`, async () => {
    const r = await fuzz(seeds);
    const by = new Map<string, number[]>();
    for (const v of r.viol) by.set(v.inv, [...(by.get(v.inv) || []), v.seed]);
    t.ok(!r.viol.length, `${[...by].map(([inv, ss]) => `${inv} x${ss.length} (seeds ${[...new Set(ss)].slice(0, 8).join(',')})`).join('; ')}\n${r.viol[0]?.detail}\n${r.trace}`);
    t.ok(r.saves > seeds.length * 8, `only ${r.saves} saves`);
  });
  t.test(`save path (fuzz): ${Object.keys(REGRESSIONS).length} scripted cases of earlier reviews keep I1-I5, with and without the column's layers`, async () => {
    const bad: string[] = [];
    for (const layers of [false, true])
      for (const [name, steps] of Object.entries(REGRESSIONS)) {
        const r = await script(steps, layers);
        if (r.viol.length) bad.push(`${name}${layers ? ' (layers)' : ''}: ${r.viol.map((v) => `${v.inv} ${v.detail}`).join('; ')}\n${r.log}`);
      }
    t.ok(!bad.length, bad.join('\n\n'));
  });
}
