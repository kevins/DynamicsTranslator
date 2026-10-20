// End-to-end tests of the publish path of translation mode v3, with nothing faked but Dataverse and the page:
// staged edits in the store → the Publish dialog's plan (ui/review.ts: what is written, what is skipped) → the
// real saver (core/saver.ts: validation, grouping, commit, journal, one publish) → a writer that behaves like the
// real ones against an in-memory server (fresh read, conflict check, only the changed languages, read-back). Then
// what the dialog does after a run (Try again, Publish again, the forms check) and the refresh (ui/refresh.ts:
// the purge of every cache that holds labels or the language, the reload without the warm boot, the questions
// before reloading, "Show Dynamics in", the check after it).
import { readHistory } from '../../../src/core/history';
import { DvError, type BatchPart, type PartResult } from '../../../src/core/http';
import { toLabels } from '../../../src/core/labels';
import { canClear, keepsEmpty, MANAGED, PublishSet, savesEmpty, type Change, type ChangeResult, type Kind, type Lcid, type Slot } from '../../../src/core/model';
import { publishTargets } from '../../../src/core/publish';
import { createSaver } from '../../../src/core/saver';
import { Store } from '../../../src/core/store';
import { shownLanguage } from '../../../src/core/uilang';
import { changeId, type SaveOptions, type Writer } from '../../../src/providers/types';
import { createIo } from '../../../src/io/workbook';
import { bpfWriter } from '../../../src/providers/bpf';
import { metadataWriters } from '../../../src/providers/metadata';
import { recordsWriter } from '../../../src/providers/records';
import { logWrite } from '../../../src/providers/writelog';
import { dynamicsItems } from '../../../src/ui/bar';
import { createEditor } from '../../../src/ui/editor';
import { mergeCopies, openHistory, openReview, othersNote, othersText, placesOf, planPublish, progressNote, publishAgain, retryable, titleOf, unpublishedForms, whatOf, whereOf } from '../../../src/ui/review';
import { dropKey, FRESH_FLAGS, freshUrl, KEEP_CACHES, LABEL_CACHE, metaStore, notShowing, pageEnv, purge, readVerify, refreshNow, refreshPage, reloadFresh, SW_PURGE, switchLanguage, verifyKey, withFlags, type LabelRequest, type PurgeEnv, type SwTarget, type VerifyItem, type WorkerPort } from '../../../src/ui/refresh';
import type { AppApi, SaveReport } from '../../../src/ui/types';
import { modal, modalOpen, setLayer, teardownLayer } from '../../../src/ui/widgets';
import { dom, FEl, fire, install, type Ev } from './callout';
import type { Kit } from './kit';
import { fast } from './lang';
import { register as fuzzTests } from './metafuzz';
import { batchOf } from './records';

const EN = 1033;
const FR = 1036;
const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

export interface Rig {
  store: Store;
  app: AppApi;
  /** The server's labels: change id → text (absent = no label). */
  server: Map<string, string>;
  /** Each writer call: the [change id, text] pairs it wrote, and whether publishing was allowed. */
  writes: Array<{ ids: Array<[string, string]>; allowPublish: boolean }>;
  /** PublishXml bodies. */
  posts: string[];
  /** Others' unpublished forms per table, for the saver's pending-work check. */
  work: Map<string, string[]>;
  /** Change ids whose next write fails before it is sent (the writer reports an error, nothing is written). */
  failOnce: Set<string>;
  /** Change ids whose next write lands but whose answer is lost (the writer reports it as not checked). */
  landOnce: Set<string>;
  /** PublishXml calls that fail before one goes through. */
  publishFails: number;
  /** What the writer reports while it writes (SaveOptions.progress), in order: the item it saves, that it waits for Dataverse. */
  say?: string[];
  /** The writer's reads alone (Writer.read), and the error they fail with when set. */
  reads?: number;
  unreadable?: string;
  /** versionnumber per form id: [published, unpublished]; a form missing here can't be read. */
  versions: Map<string, [number, number]>;
  add(kind: Kind, key: string, labels: Record<number, string>, o?: Partial<Slot>): Slot;
  /** The Publish button: plans the staged changes and saves those it writes, always publishing. */
  publish(): Promise<{ rep: SaveReport; plan: ReturnType<typeof planPublish> }>;
  done(): void;
}

export function rig(t: Kit): Rig {
  const store = new Store();
  const server = new Map<string, string>();
  const writes: Rig['writes'] = [];
  const posts: string[] = [];
  const work = new Map<string, string[]>();
  const failOnce = new Set<string>();
  const landOnce = new Set<string>();
  const versions = new Map<string, [number, number]>();
  let running = 0;
  // The journal lives in localStorage (absent in Node): a private one for this rig.
  const g = globalThis as { localStorage?: unknown };
  const had = Object.getOwnPropertyDescriptor(g, 'localStorage');
  const mem = new Map<string, string>();
  Object.defineProperty(g, 'localStorage', { configurable: true, value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) } });

  const stored = (s: string) => (s.trim() ? s : '');
  /** A writer like the real ones (providers/types Writer): one call per save group. */
  const writer = (kinds: Kind[], lane: Writer['lane']): Writer => ({
    kinds,
    lane,
    // The read save() makes before writing, alone (Recent publishes › Undo shows it first); `R.reads` counts them.
    async read(_ctx, cs: Change[]) {
      await tick();
      R.reads = (R.reads ?? 0) + 1;
      if (R.unreadable) throw new Error(R.unreadable);
      return new Map(cs.map((c) => [changeId(c), server.get(changeId(c)) ?? ''] as const));
    },
    async save(_ctx, cs: Change[], o: SaveOptions): Promise<ChangeResult[]> {
      running++;
      t.ok(running === 1, 'two writes at once');
      try {
        for (const m of R.say ?? []) o.progress(m);
        await tick();
        if (cs.some((c) => c.slot.kind === 'ribbon') && !o.allowPublish)
          return cs.map((change) => ({ change, outcome: 'error', message: 'Classic button labels can only be saved with publishing turned on.' }));
        const out: ChangeResult[] = [];
        const send: Change[] = [];
        const target = (c: Change) => c.slot.kind !== 'command' && o.publish.entities.add(String(c.slot.ref?.entity || c.slot.entity));
        for (const c of cs) {
          const now = server.get(changeId(c)) ?? ''; // 1. a fresh read
          // A metadata description (keepsEmpty) keeps a '' stored apart from no label at all, as the real writer does
          // (providers/metadata.ts compare): saved empty where there is none, '' is written; an edit made over none
          // (Change.beforeMissing) that finds one stored empty is a conflict.
          const none = !server.has(changeId(c)) && !stored(c.after) && savesEmpty(c.slot, c.lcid, EN, c.untranslated);
          const theirs = !!c.beforeMissing && server.get(changeId(c)) === '' && !!stored(c.after) && !o.force.has(changeId(c));
          // Never sent (the read before it failed): not in SaveOptions.ran.
          if (failOnce.delete(changeId(c))) out.push({ change: c, outcome: 'error', message: 'Could not reach Dataverse.' });
          else if (theirs || (now !== c.before && now !== stored(c.after) && !o.force.has(changeId(c)))) out.push({ change: c, outcome: 'conflict', server: now }); // 2.
          else if (now === stored(c.after) && !none) {
            // Possibly an earlier write whose answer was lost, never published (5.).
            out.push({ change: c, outcome: 'unchanged' });
            target(c);
          } else if (landOnce.delete(changeId(c))) {
            // Written, but the answer was lost: reported as not checked, and published with the rest (5.). It may have run (7.).
            server.set(changeId(c), c.after);
            o.ran?.add(changeId(c));
            out.push({ change: c, outcome: 'error', message: 'Sent to Dataverse, but the result could not be checked. Reload to confirm it.' });
            target(c);
          } else send.push(c);
        }
        for (const c of send) o.ran?.add(changeId(c)); // 7.
        if (send.length) {
          // 3. only the changed languages; a blank removes the label, but a metadata description's, stored as ''
          writes.push({ ids: send.map((c) => [changeId(c), c.after]), allowPublish: o.allowPublish });
          for (const c of send) if (stored(c.after) || keepsEmpty(c.slot)) server.set(changeId(c), stored(c.after));
          else server.delete(changeId(c));
        }
        for (const c of send) {
          // 4. read back
          out.push({ change: c, outcome: (server.get(changeId(c)) ?? '') === stored(c.after) ? 'saved' : 'error' });
          target(c); // 5.
        }
        return out;
      } finally {
        running--;
      }
    },
  });
  const writers = [writer(['attribute', 'field', 'tab', 'entity', 'command'], 'metadata'), writer(['ribbon'], 'ribbon')];
  const R: Partial<Rig> = { publishFails: 0 };
  const http = {
    stats: {},
    post: async (fn: string, body: { ParameterXml?: string }) => {
      t.ok(running === 0, 'publishing while a write runs');
      if (fn !== 'PublishXml') return;
      if (R.publishFails! > 0) {
        R.publishFails!--;
        throw new Error('The publish failed on the server.');
      }
      posts.push(body.ParameterXml || '');
    },
    get: async (url: string) => {
      // The Publish dialog's forms check: published and unpublished versionnumber.
      const m = /^systemforms\(([^)]+)\)(\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublished\(\))?\?\$select=versionnumber$/.exec(url);
      const v = m && versions.get(m[1]);
      if (!v) throw new Error('404 ' + url);
      return { versionnumber: m![2] ? v[1] : v[0] };
    },
    all: async (url: string) => {
      // The saver's pending-work check: unpublished forms of the tables (RetrieveUnpublishedMultiple).
      if (!url.startsWith('systemforms')) return [];
      const out: Array<Record<string, string>> = [];
      for (const [e, names] of work) if (url.includes(`'${e}'`)) names.forEach((name, i) => out.push({ formid: `0000000${i}-0000-0000-0000-000000000000`, name, objecttypecode: e }));
      return out;
    },
  };
  const ctx = { base: EN, user: EN, orgId: 'savepath', langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }], http };
  const prefs = { target: FR, shown: [EN, FR] };
  const app = { ctx, store, prefs, toast() {} } as unknown as AppApi;
  const lang = { restore: async () => {}, quiet: <T>(fn: () => Promise<T>) => fn() };
  app.saver = createSaver(app.ctx, store, lang as unknown as AppApi['lang'], (k) => writers.find((w) => w.kinds.includes(k)));

  return Object.assign(R, {
    store,
    app,
    server,
    writes,
    posts,
    work,
    failOnce,
    landOnce,
    versions,
    add(kind: Kind, key: string, labels: Record<number, string>, o: Partial<Slot> = {}) {
      const s = { ...t.slot(kind, key, { ...labels }), entity: 'acc', group: key, ref: {}, baseRequired: true, ...o } as Slot;
      for (const [l, v] of Object.entries(labels)) server.set(`${key}#${l}`, v);
      store.add([s]);
      return s;
    },
    async publish() {
      const plan = planPublish(app, store.changes());
      const rep = await app.saver.save(plan.send, { signal: new AbortController().signal, publish: true, onProgress() {} });
      return { rep, plan };
    },
    done() {
      if (had) Object.defineProperty(g, 'localStorage', had);
      else delete g.localStorage;
    },
  }) as Rig;
}

const WF1 = '9a6faaaa-0000-4000-8000-0000000000b1';
const WF2 = '5d1c0b2e-7a43-4c1e-9d1f-3b2a1c0d9e8f';
const STAGE = '15322a8f-0000-4000-8000-000000000054';

interface Procs {
  /** Localizable column texts on the server: `${record id}|${column}` → language → text. */
  labels: Map<string, Record<number, string>>;
  /** The user's UI language on the server: French, English inside a run() window. */
  ui: Lcid;
  /**
   * What reached the server, in order: "set <id>|<column>" (SetLocLabels), "read <id>|name", "stage <id>" (its xaml),
   * "publish", "update <id> "<name>" in <UI language>[ once]" (the PATCH of a workflow's name), "[<lcid>" and "]"
   * around each run() window.
   */
  log: string[];
  /** The language of each run() window. */
  runs: Lcid[];
  /** Process updates still to fail (answered 500, nothing written). */
  fail: number;
  /** run() windows leave the UI language as it is (a Dataverse that did not switch). */
  stay: boolean;
  /** Records from a managed solution (their ids), as the reads right before a write and the process update find them. */
  managed: Set<string>;
  name(id: string): Slot;
  desc(id: string): Slot;
  stage: Slot;
  view: Slot;
  /** Saves the staged changes, publishing; `said`: the progress messages. */
  save(said?: string[]): Promise<SaveReport>;
  /** The process updates sent. */
  updates(): string[];
}

/**
 * Turns a rig into one with two business process flows and a view, saved by the real records and BPF writers through
 * the real saver on a fake Dataverse (LIVE-FINDINGS 83): the processes' names and descriptions per language
 * (RetrieveLocLabels, SetLocLabels), the first one's stage label in its xaml and clientdata, and the PATCH of a
 * workflow's name, which updates the copy of the process the app is served and writes the name of the caller's UI
 * language. The user works in French, English is the base language; the LangSession stand-in switches the UI
 * language for its run() windows and fails the test when one opens inside a quiet() job.
 */
function processes(t: Kit, r: Rig): Procs {
  const ctx = r.app.ctx as unknown as { user: Lcid; http: Record<string, unknown> };
  ctx.user = FR;
  const P = { labels: new Map(), ui: FR, log: [], runs: [], fail: 0, stay: false, managed: new Set() } as unknown as Procs;
  P.labels.set(`${WF1}|name`, { [EN]: 'bpf test', [FR]: 'Processus test' });
  P.labels.set(`${WF1}|description`, { [EN]: 'A test process' });
  P.labels.set(`${WF2}|name`, { [EN]: 'Second flow', [FR]: 'Deuxième processus' });
  P.labels.set(`${WF2}|description`, {});
  P.labels.set('v1|name', { [EN]: 'Active Accounts', [FR]: 'Comptes actifs' });
  const doc = {
    xaml: `<Activity><mxswa:StepLabels><mxswa:StepLabel Description="Stage 1" LabelId="${STAGE}" LanguageCode="1033" /></mxswa:StepLabels></Activity>`,
    clientdata: JSON.stringify({ __class: 'StageStep:#Microsoft.Crm.Workflow.ObjectModel', stageId: STAGE, stepLabels: { list: [{ labelId: STAGE, languageCode: 1033, description: 'Stage 1' }] } }),
  };
  const loc = (k: string) => ({ Label: { LocalizedLabels: Object.entries(P.labels.get(k) ?? {}).map(([l, v]) => ({ Label: v, LanguageCode: Number(l) })) } });
  const get = ctx.http.get as (u: string) => Promise<unknown>;
  Object.assign(ctx.http, {
    fn: (name: string, p: { EntityMoniker: { '@odata.id': string }; AttributeName: string }) => `${name}(${p.EntityMoniker['@odata.id']},${p.AttributeName})`,
    get: async (u: string) => {
      await tick();
      const m = /^RetrieveLocLabels\(\w+\(([^)]+)\),(\w+)\)$/.exec(u);
      if (m) {
        P.log.push(`read ${m[1]}|${m[2]}`);
        return loc(`${m[1]}|${m[2]}`);
      }
      // Whether a record is from a managed solution: the records writer and the process update ask right before writing.
      const mm = /^\w+\(([^)]+)\)\?\$select=ismanaged$/.exec(u);
      if (mm) return { ismanaged: P.managed.has(mm[1]) };
      if (u.startsWith(`workflows(${WF1})?$select=`)) return { name: 'bpf test', primaryentity: 'account', ismanaged: false, iscustomizable: { Value: true }, ...doc };
      return get(u);
    },
    post: async (fn: string, body: { ParameterXml?: string; EntityMoniker?: Record<string, string>; AttributeName?: string; Labels?: Array<{ Label: string; LanguageCode: number }> }) => {
      await tick();
      if (fn === 'PublishXml') return void (P.log.push('publish'), r.posts.push(body.ParameterXml || ''));
      if (fn !== 'SetLocLabels') return;
      const k = `${body.EntityMoniker!.workflowid ?? body.EntityMoniker!.savedqueryid}|${body.AttributeName}`;
      const now = { ...P.labels.get(k) };
      for (const l of body.Labels!) if (l.Label) now[l.LanguageCode] = l.Label;
      else delete now[l.LanguageCode];
      P.labels.set(k, now);
      P.log.push(`set ${k}`);
    },
    patch: async (u: string, body: { name?: string; xaml?: string; clientdata?: string }, o: { once?: boolean } = {}) => {
      await tick();
      const id = /^workflows\(([^)]+)\)$/.exec(u)?.[1];
      if (!id) throw new DvError('Resource not found for the segment.', 404);
      if (body.xaml !== undefined) {
        Object.assign(doc, body);
        return void P.log.push(`stage ${id}`);
      }
      P.log.push(`update ${id} "${body.name}" in ${P.ui}${o.once ? ' once' : ''}`);
      if (P.fail > 0) {
        P.fail--;
        throw new DvError('Generic SQL error.', 500);
      }
      // A PATCH of a localizable column writes the label of the caller's UI language.
      P.labels.get(`${id}|name`)![P.ui] = body.name!;
    },
    batch: (parts: never, o: never) => batchOf(ctx.http)(parts, o),
  });
  let quiet = 0;
  const lang = {
    quiet: async <T>(fn: () => Promise<T>) => {
      quiet++;
      try {
        return await fn();
      } finally {
        quiet--;
      }
    },
    restore: async () => {},
    run: async <T>(lcid: Lcid, fn: () => Promise<T>): Promise<T> => {
      t.ok(!quiet, 'a run() window inside a quiet() job would wait for itself');
      P.runs.push(lcid);
      const was = P.ui;
      if (!P.stay) P.ui = lcid;
      P.log.push(`[${lcid}`);
      try {
        return await fn();
      } finally {
        P.ui = was;
        P.log.push(']');
      }
    },
  };
  const writers = [recordsWriter, bpfWriter];
  r.app.saver = createSaver(r.app.ctx, r.store, lang as unknown as AppApi['lang'], (k) => writers.find((w) => w.kinds.includes(k)));
  const rec = (kind: Kind, id: string, prop: 'Name' | 'Description', table: string, entitySet: string, title: string) => {
    const column = prop.toLowerCase();
    return {
      ...t.slot(kind, `${kind}|${id}|${prop}`, { ...P.labels.get(`${id}|${column}`) }),
      kind,
      prop,
      entity: 'account',
      comp: `${kind}|${id}`,
      group: `${kind}|${id}`,
      title,
      path: ['Account'],
      ref: { id, table, entitySet, column, entity: 'account', managed: false },
    } as Slot;
  };
  const slots = [
    rec('bpf', WF1, 'Name', 'workflow', 'workflows', 'Processus test'),
    rec('bpf', WF1, 'Description', 'workflow', 'workflows', 'Processus test'),
    rec('bpf', WF2, 'Name', 'workflow', 'workflows', 'Deuxième processus'),
    rec('bpf', WF2, 'Description', 'workflow', 'workflows', 'Deuxième processus'),
    rec('view', 'v1', 'Name', 'savedquery', 'savedqueries', 'Comptes actifs'),
  ];
  P.stage = {
    ...t.slot('stage', `stage|${WF1}|${STAGE}|Label`, { [EN]: 'Stage 1' }),
    entity: 'account',
    comp: `stage|${WF1}|${STAGE}`,
    group: `bpfxaml|${WF1}`,
    title: 'Stage 1',
    path: ['Processus test'],
    ref: { workflowId: WF1, labelId: STAGE, managed: false },
  } as Slot;
  r.store.add([...slots, P.stage]);
  P.name = (id) => slots.find((s) => s.key === `bpf|${id}|Name`)!;
  P.desc = (id) => slots.find((s) => s.key === `bpf|${id}|Description`)!;
  P.view = slots[4];
  P.save = (said = []) => r.app.saver.save(r.store.changes(), { signal: new AbortController().signal, publish: true, onProgress: (x) => void said.push(x.message) });
  P.updates = () => P.log.filter((e) => e.startsWith('update '));
  return P;
}

/** A fake uci-state worker port that answers clearState (or stays silent). */
function port(answer: boolean): WorkerPort & { got: unknown[] } {
  const fns = new Set<(e: MessageEvent) => void>();
  const got: unknown[] = [];
  return {
    got,
    addEventListener: (_t, fn) => void fns.add(fn),
    removeEventListener: (_t, fn) => void fns.delete(fn),
    start() {},
    postMessage(m) {
      got.push(m);
      const id = (m as { requestId?: string }).requestId;
      if (answer) setTimeout(() => fns.forEach((fn) => fn({ data: { type: 'clearStateResult', requestId: id } } as MessageEvent)), 5);
    },
  };
}
/** In-memory Storage with key order. */
function storage(keys: string[]) {
  const m = new Map(keys.map((k) => [k, 'v'] as [string, string]));
  return {
    m,
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    cleared: false,
    clear() {
      m.clear();
      this.cleared = true;
    },
  };
}

export function register(t: Kit): void {
  t.test('publish dialog: the same edit of every copy of a field on a form is one entry listing its places; different texts and other fields stay apart', () => {
    const cell = (id: string, tab: string, df = 'contoso_title', form = 'f1') =>
      ({ ...t.slot('field', `field|${form}|${id}|Label`, { [EN]: 'Service request title' }), kind: 'field', prop: 'Label', path: ['Service request', 'Main form (Main form)', tab, 'Details'], ref: { formId: form, datafield: df, elId: id } }) as Slot;
    const ch = (s: Slot, after = 'Service request titles') => ({ slot: s, lcid: EN, before: 'Service request title', after });
    const gs = [[ch(cell('a', 'Memo'))], [ch(cell('b', 'General'))], [ch(cell('c', 'Memo'))], [ch(cell('d', 'CCM'), 'Other')], [ch(cell('e', 'Memo', 'contoso_other'))], [ch(cell('f', 'Memo', 'contoso_title', 'f2'))]];
    const m = mergeCopies(gs as never, () => true);
    t.eq(m.map((cg) => cg.map((g) => g[0].slot.ref.elId)), [['a', 'b', 'c'], ['d'], ['e'], ['f']]);
    t.eq(placesOf(m[0] as never), ['Memo', 'General']);
    t.eq(mergeCopies(gs as never, (g) => g[0].slot.ref.elId !== 'b').map((cg) => cg.length), [2, 1, 1, 1, 1], 'a copy with a problem keeps its own row');
  });

  t.test("publish dialog: a progress message shows on its step's line as the item's title, a wait in lower case, a retry in short; only waits are announced", () => {
    const say = {
      'Saving…': ['', false],
      'Undoing…': ['', false],
      'Publishing…': ['', false],
      "Saving Nom de l'équipe (column)": ["Nom de l'équipe", false],
      'Saving Motif (status reason)': ['Motif', false],
      'Saving Oui (yes/no option)': ['Oui', false],
      'Saving Name (old) (column)': ['Name (old)', false],
      'Saving view “Comptes actifs” › Name': ['Comptes actifs', false],
      'Saving Statut “VIP” (column)': ['Statut “VIP”', false],
      'Saving Statut “VIP” › Ancien (column)': ['Statut “VIP” › Ancien', false],
      'Saving Account › Main form (French)': ['Account › Main form (French)', false],
      'Saving Sales process again in French': ['Sales process again in French', false],
      'Updating the process bpf test': ['Updating the process bpf test', false],
      "Waiting for Dataverse to confirm Nom de l'équipe…": ["waiting for Dataverse to confirm Nom de l'équipe", true],
      'Waiting for Dataverse to show your last save of Nom…': ['waiting for Dataverse to show your last save of Nom', true],
      'Dataverse is busy with another customization. Publishing again in 10 seconds…': ['Dataverse is busy, trying again in 10 s', true],
      'Apps could not be published with the rest; publishing the other components.': ['trying again without the apps', true],
      'Command bar (classic) · Account: Dataverse is busy with another import, trying again in 5 s': ['Command bar (classic) · Account: Dataverse is busy with another import, trying again in 5 s', true],
      'Command bar (classic) · Account: importing (usually 10–20 s)': ['Command bar (classic) · Account: importing (usually 10–20 s)', false],
    };
    for (const [m, want] of Object.entries(say)) t.eq([progressNote(m).text, progressNote(m).wait], want, m);
  });

  const run = (name: string, fn: (r: Rig) => Promise<void>) =>
    t.test(`publish path: ${name}`, async () => {
      const r = rig(t);
      try {
        await fn(r);
      } finally {
        r.done();
      }
    });

  run('Publish writes only the language typed, verifies it, publishes once and journals it as published', async (r) => {
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    r.store.set(k, FR, 'Nom du compte'); // typed in a popup: staged, nothing written
    t.eq([r.writes.length, r.posts.length, r.store.pendingCount()], [0, 0, 1], 'staged only');
    const { rep, plan } = await r.publish();
    t.eq([plan.send.length, plan.blocked.size], [1, 0]);
    t.eq(r.writes, [{ ids: [[`${k}#${FR}`, 'Nom du compte']], allowPublish: true }], 'one write, French only');
    t.eq([r.server.get(`${k}#${EN}`), r.server.get(`${k}#${FR}`)], ['Name', 'Nom du compte']);
    t.eq([rep.saved, rep.published, rep.publishError], [1, true, undefined]);
    t.eq(r.store.pendingCount(), 0);
    t.eq(r.store.get(k)!.labels[FR], 'Nom du compte', 'the store holds the server text');
    t.eq(r.posts.length, 1, 'published once');
    t.ok(r.posts[0].includes('<entity>acc</entity>'), r.posts[0]);
    t.eq(readHistory(r.app.ctx).map((e) => [e.published, e.items.map((i) => [i.lcid, i.before, i.after])]), [[true, [[FR, 'Nom', 'Nom du compte']]]]);
  });

  run('several staged edits are written in one run with one publish; a field placed twice is one form write', async (r) => {
    const a = r.add('field', 'field|f1|c1|Label', { [EN]: 'Client' }, { group: 'form|f1' }).key;
    const b = r.add('field', 'field|f1|c2|Label', { [EN]: 'Client' }, { group: 'form|f1' }).key;
    const d = r.add('attribute', 'attribute|acc.client|Description', { [EN]: 'The client' }).key;
    // "Also change the other copy of this field on this form": the popup writes both copies' keys.
    r.store.group(() => [a, b].forEach((k) => r.store.set(k, FR, 'Client FR')));
    r.store.set(d, FR, 'Le client');
    const { rep } = await r.publish();
    t.eq(rep.saved, 3);
    t.eq(r.writes.length, 2, 'one write per save group');
    t.eq(r.writes.find((w) => w.ids.length === 2)?.ids.map(([id]) => id).sort(), [`${a}#${FR}`, `${b}#${FR}`]);
    t.eq(r.posts.length, 1, 'one publish for everything');
  });

  run('blocked changes are skipped and stay staged with a short reason; the others are published', async (r) => {
    // A form label showing a column whose names aren't loaded: Dataverse can't remove its translation, and what would
    // stand in for it (the column's French name) isn't known.
    const f = r.add('field', 'field|f1|c1|Label', { [EN]: 'Client', [FR]: 'Client FR' }, { ref: { datafield: 'phone', controlId: 'phone' } }).key;
    const long = r.add('attribute', 'attribute|acc.code|DisplayName', { [EN]: 'Code', [FR]: 'Code' }, { max: 5 }).key;
    const blank = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    const ok = r.add('attribute', 'attribute|acc.city|DisplayName', { [EN]: 'City', [FR]: 'Ville' }).key;
    t.ok(!canClear(r.store.get(f)!));
    r.store.set(f, FR, ''); // a form label translation Dataverse can't remove, nothing to stand in for it
    r.store.set(long, FR, 'Beaucoup trop long');
    r.store.set(blank, EN, '   '); // the base language can't be blank
    r.store.set(ok, FR, 'Cité');
    const { plan } = await r.publish();
    t.eq(Object.fromEntries(plan.blocked), {
      [`${f}#${FR}`]: "Dataverse can't remove this translation, and its column's names aren't loaded: load its table's columns to put the column's name in its place, or type the text.",
      [`${long}#${FR}`]: 'Too long (max 5)',
      [`${blank}#${EN}`]: "Can't be empty",
    });
    t.eq(r.writes.map((w) => w.ids), [[[`${ok}#${FR}`, 'Cité']]], 'only the valid change');
    t.eq(r.server.get(`${f}#${FR}`), 'Client FR');
    t.eq(r.store.pendingCount(), 3, 'the blocked ones stay staged');
    t.eq(r.posts.length, 1);
  });

  run("an emptied translation Dataverse can't remove is written as its stand-in before the checks and the writers (no writer sees it blank): a column's name as its English text, a form label as its column's French name as this save leaves it; journaled as written, the edit dropped; a removable one is removed as before", async (r) => {
    const col = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Account Name', [FR]: 'Nom' }).key;
    const city = r.add('attribute', 'attribute|acc.city|DisplayName', { [EN]: 'City', [FR]: 'Ville' }).key;
    const cell = r.add('field', 'field|f1|c1|Label', { [EN]: 'Customer', [FR]: 'Client' }, { ref: { formId: 'f1', datafield: 'name', controlId: 'name' } }).key;
    const tab = r.add('tab', 'tab|f1|t1|Label', { [EN]: 'General', [FR]: 'Général' }, { ref: { formId: 'f1' } }).key;
    r.store.set(city, FR, ' '); // only spaces count as emptied
    r.store.set(col, FR, 'Nom du compte'); // typed in the same save: the form label gets that
    r.store.set(cell, FR, '');
    r.store.set(tab, FR, '');
    const { rep, plan } = await r.publish();
    t.eq([plan.blocked.size, rep.saved, rep.errors], [0, 4, 0], JSON.stringify(rep.results.map((x) => x.message)));
    const sent = new Map(r.writes.flatMap((w) => w.ids));
    t.eq([sent.get(`${city}#${FR}`), sent.get(`${cell}#${FR}`), sent.get(`${tab}#${FR}`)], ['City', 'Nom du compte', 'General'], 'the stand-ins, never a blank');
    t.eq([r.server.get(`${city}#${FR}`), r.server.get(`${cell}#${FR}`), r.server.get(`${tab}#${FR}`)], ['City', 'Nom du compte', 'General']);
    t.eq(rep.results.map((x) => [x.change.slot.key, x.change.after, x.change.standIn ?? null]), [
      [city, 'City', { from: 'base', typed: ' ' }],
      [col, 'Nom du compte', null],
      [cell, 'Nom du compte', { from: 'column', typed: '' }],
      [tab, 'General', { from: 'base', typed: '' }],
    ]);
    // The store drops the edits (the stand-in is now the server text); the journal holds the texts written.
    t.eq([r.store.pendingCount(), r.store.original(cell, FR), r.store.cellStatus(cell, FR)?.outcome], [0, 'Nom du compte', 'saved']);
    t.eq(readHistory(r.app.ctx)[0].items.map((it) => [it.key, it.before, it.after]), [
      [city, 'Ville', 'City'],
      [col, 'Nom', 'Nom du compte'],
      [cell, 'Client', 'Nom du compte'],
      [tab, 'Général', 'General'],
    ]);
    // Its column's French name emptied in the same save as well: its English name, which the column gets too.
    r.store.set(cell, FR, '');
    r.store.set(col, FR, '');
    const { rep: two } = await r.publish();
    t.eq(two.results.map((x) => [x.change.slot.key, x.change.after, x.change.standIn?.from]), [
      [cell, 'Account Name', 'columnBase'],
      [col, 'Account Name', 'base'],
    ]);
    // A translation Dataverse can remove is removed, as before.
    const view = r.add('command', 'command|v1|Label', { [EN]: 'Run', [FR]: 'Lancer' }).key;
    r.store.set(view, FR, '');
    const { rep: three } = await r.publish();
    t.eq([three.saved, three.results[0].change.after, three.results[0].change.standIn, r.server.has(`${view}#${FR}`)], [1, '', undefined, false]);
  });

  run("an emptied translation that has no stand-in is refused, saying why, nothing written: its English text empty (only spaces); one whose column's names aren't loaded is held back (skipped, saying what to load); the base language keeps its own rules", async (r) => {
    const nameless = r.add('attribute', 'attribute|acc.tip|DisplayName', { [FR]: 'Astuce' }).key; // a name: a description is saved empty (model.ts savesEmpty)
    const cell = r.add('field', 'field|f1|c2|Label', { [EN]: 'Phone', [FR]: 'Téléphone' }, { ref: { datafield: 'phone', controlId: 'phone' } }).key;
    const name = r.add('attribute', 'attribute|acc.city|DisplayName', { [EN]: 'City', [FR]: 'Ville' }).key;
    r.store.set(nameless, FR, '');
    r.store.set(cell, FR, '');
    r.store.set(name, EN, ' '); // the base language: never a stand-in, it can't be blank
    const writes = r.writes.length;
    const rep = await r.app.saver.save(r.store.changes(), { signal: new AbortController().signal, publish: true, onProgress() {} });
    t.eq(rep.results.map((x) => [x.outcome, x.message]), [
      ['error', "Dataverse can't remove this translation, and its English text is empty: type the text instead."],
      ['skipped', "Dataverse can't remove this translation, and its column's names aren't loaded: load its table's columns to put the column's name in its place, or type the text."],
      ['error', "The English label can't be blank: it is the base language."],
    ]);
    t.eq([r.writes.length, r.store.pendingCount()], [writes, 3], 'nothing written, still staged');
  });

  run("a stand-in is never made of a staged text the save doesn't write: an English edit in conflict (Publish skips it), one a reload moved (its writer finds the conflict), one the checks refuse; the English text on the server instead", async (r) => {
    // (a) English in conflict: Publish skips it until Keep mine / Use theirs, so it never stands in.
    const name = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    r.server.set(`${name}#${EN}`, 'Name (Marie)'); // another maker, since the load
    r.store.set(name, EN, 'Full name');
    await r.publish();
    t.eq(r.store.cellStatus(name, EN)?.outcome, 'conflict');
    r.store.set(name, FR, '');
    const { rep, plan } = await r.publish();
    t.eq([[...plan.blocked.keys()], plan.send.map(changeId)], [[`${name}#${EN}`], [`${name}#${FR}`]]);
    t.eq([plan.written.get(`${name}#${FR}`)?.after, plan.written.has(`${name}#${EN}`)], ['Name', false], 'shown as the English text on the server as loaded, never the staged one');
    // That text is not the server's any more: read again first, nothing written, and the store takes the new one.
    t.eq(rep.results.map((x) => [x.outcome, x.message]), [['error', 'Its English text changed on the server since it was loaded (now “Name (Marie)”), so nothing was written: Try again to put the new text in its place.']]);
    t.eq([r.server.get(`${name}#${FR}`), r.store.original(name, EN), r.store.value(name, EN), r.store.moved(name, EN)], ['Nom', 'Name (Marie)', 'Full name', true]);
    const { rep: two } = await r.publish();
    t.eq(two.results.map((x) => [x.change.lcid, x.outcome, x.change.after]), [[FR, 'saved', 'Name (Marie)']], 'the English text on the server, never “Full name”');
    // Use theirs: the English edit goes, and French shows what English does.
    r.store.resolve(name, EN, false);
    t.eq([r.server.get(`${name}#${EN}`), r.server.get(`${name}#${FR}`), r.store.pendingCount()], ['Name (Marie)', 'Name (Marie)', 0]);

    // (b) A reload moved the English text under its edit: sent, its writer finds the conflict; French gets the English
    // text the reload brought, never the edit.
    const city = r.add('attribute', 'attribute|acc.city|DisplayName', { [EN]: 'City', [FR]: 'Ville' }).key;
    r.store.set(city, EN, 'Town');
    r.server.set(`${city}#${EN}`, 'City (Marie)');
    r.store.add([{ ...r.store.get(city)!, labels: { [EN]: 'City (Marie)', [FR]: 'Ville' } }]);
    r.store.set(city, FR, '');
    const { rep: three, plan: p3 } = await r.publish();
    t.eq(p3.written.get(`${city}#${FR}`)?.after, 'City (Marie)');
    t.eq(three.results.map((x) => [x.change.lcid, x.outcome, x.change.after]), [[EN, 'conflict', 'Town'], [FR, 'saved', 'City (Marie)']]);
    t.eq([r.server.get(`${city}#${EN}`), r.server.get(`${city}#${FR}`)], ['City (Marie)', 'City (Marie)']);

    // (c) English refused by the checks (the base language can't be blank): French gets the English text on the server.
    const code = r.add('attribute', 'attribute|acc.code|DisplayName', { [EN]: 'Code', [FR]: 'Code FR' }).key;
    r.store.set(code, EN, '  ');
    r.store.set(code, FR, '');
    const { rep: four, plan: p4 } = await r.publish();
    t.eq([p4.blocked.has(`${code}#${EN}`), p4.written.get(`${code}#${FR}`)?.after], [true, 'Code']);
    t.eq([four.results.map((x) => [x.outcome, x.change.after]), r.server.get(`${code}#${FR}`)], [[['saved', 'Code']], 'Code']);

    // (d) The Publish dialog checks what it sends the same way: a name with no English text, its English edit in
    // conflict, has nothing to stand in for its emptied French (refused, saying why), never the staged English.
    const tip = r.add('attribute', 'attribute|acc.tip|DisplayName', { [FR]: 'Astuce' }).key;
    r.server.set(`${tip}#${EN}`, 'Tip (Marie)');
    r.store.set(tip, EN, 'Tip');
    await r.publish();
    t.eq(r.store.cellStatus(tip, EN)?.outcome, 'conflict');
    r.store.set(tip, FR, '');
    const { rep: five, plan: p5 } = await r.publish();
    t.eq([p5.blocked.get(`${tip}#${EN}`), p5.blocked.get(`${tip}#${FR}`)], ['', "Dataverse can't remove this translation, and its English text is empty: type the text instead."]);
    t.eq([five.results.length, r.server.get(`${tip}#${FR}`)], [0, 'Astuce'], 'nothing sent');
  });

  run("a publish of one component never makes a stand-in of a pending text on another: a form label emptied gets its column's French name on the server, not the column's unsaved edit", async (r) => {
    const COL = 'attribute|acc.phone|DisplayName';
    r.add('attribute', COL, { [EN]: 'Phone', [FR]: 'Téléphone' });
    const cell = r.add('field', 'field|f1|c1|Label', { [EN]: 'Main phone', [FR]: 'Tél.' }, { ref: { formId: 'f1', datafield: 'phone', controlId: 'phone' } });
    r.store.set(COL, FR, 'Téléphone (brouillon)'); // staged on the column, not published with the form label
    r.store.set(cell.key, FR, '');
    // The editor card's "Review and publish this component".
    const plan = planPublish(r.app, r.store.changes((s) => s.comp === cell.comp));
    t.eq([plan.send.map(changeId), plan.written.get(`${cell.key}#${FR}`)?.after], [[`${cell.key}#${FR}`], 'Téléphone']);
    const rep = await r.app.saver.save(plan.send, { signal: new AbortController().signal, publish: true, onProgress() {} });
    t.eq(rep.results.map((x) => [x.outcome, x.change.after, x.change.standIn?.from]), [['saved', 'Téléphone', 'column']]);
    t.eq([r.server.get(`${cell.key}#${FR}`), r.server.get(`${COL}#${FR}`), r.store.value(COL, FR)], ['Téléphone', 'Téléphone', 'Téléphone (brouillon)'], 'the column untouched, its edit still staged');
  });

  run("a stand-in made of a text that changed on the server since it was loaded is never written: a column's English text, a form label's column name. Nothing written, the reason said, the store takes the new text, and Try again writes that", async (r) => {
    const name = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    const COL = 'attribute|acc.phone|DisplayName';
    r.add('attribute', COL, { [EN]: 'Phone', [FR]: 'Téléphone' });
    const cell = r.add('field', 'field|f1|c1|Label', { [EN]: 'Main phone', [FR]: 'Tél.' }, { ref: { formId: 'f1', datafield: 'phone', controlId: 'phone' } }).key;
    // Other makers, since the load.
    r.server.set(`${name}#${EN}`, 'Account name');
    r.server.set(`${COL}#${FR}`, 'Téléphone pro');
    r.store.set(name, FR, '');
    r.store.set(cell, FR, '');
    const o = { signal: new AbortController().signal, publish: true, onProgress() {} };
    const { rep, plan } = await r.publish();
    t.eq([plan.written.get(`${name}#${FR}`)?.after, plan.written.get(`${cell}#${FR}`)?.after], ['Name', 'Téléphone'], 'measured by the texts as loaded');
    t.eq(rep.results.map((x) => [x.outcome, x.message]), [
      ['error', 'Its English text changed on the server since it was loaded (now “Account name”), so nothing was written: Try again to put the new text in its place.'],
      ['error', 'Its column\'s French name changed on the server since it was loaded (now “Téléphone pro”), so nothing was written: Try again to put the new text in its place.'],
    ]);
    t.eq([r.writes.length, r.posts.length, r.server.get(`${name}#${FR}`), r.server.get(`${cell}#${FR}`)], [0, 0, 'Nom', 'Tél.'], 'nothing stale written');
    t.eq([r.store.original(name, EN), r.store.original(COL, FR), r.store.pendingCount(), r.store.cellStatus(cell, FR)?.outcome], ['Account name', 'Téléphone pro', 2, 'error']);
    // Try again: the new texts, as the Publish dialog now shows them.
    const again = retryable(r.app, rep.results);
    t.eq(again.map(changeId), [`${name}#${FR}`, `${cell}#${FR}`]);
    const p2 = planPublish(r.app, r.store.changes());
    t.eq([p2.written.get(`${name}#${FR}`)?.after, p2.written.get(`${cell}#${FR}`)?.after], ['Account name', 'Téléphone pro']);
    const two = await r.app.saver.save(again, o);
    t.eq([two.saved, r.server.get(`${name}#${FR}`), r.server.get(`${cell}#${FR}`), r.store.pendingCount()], [2, 'Account name', 'Téléphone pro', 0]);
    // A text that couldn't be read to check it: nothing written either.
    r.store.set(name, FR, '');
    r.unreadable = 'Could not reach Dataverse.';
    const three = await r.app.saver.save(r.store.changes(), o);
    r.unreadable = undefined;
    t.eq(three.results.map((x) => [x.outcome, x.message]), [['error', "Its English text couldn't be read to check it before writing (Could not reach Dataverse), so nothing was written. Try again."]]);
  });

  run("an emptied translation whose stand-in is its text already changes nothing: never sent to a writer, nothing published or journaled, the edit dropped", async (r) => {
    const k = r.add('attribute', 'attribute|acc.desc|DisplayName', { [EN]: 'Description', [FR]: 'Description' }).key;
    const city = r.add('attribute', 'attribute|acc.city|DisplayName', { [EN]: 'City', [FR]: 'Ville' }).key;
    r.store.set(k, FR, '');
    t.eq(r.store.standIn(k, FR, EN), { text: 'Description', from: 'base', same: true });
    const { rep, plan } = await r.publish();
    t.eq([plan.send.length, plan.written.get(`${k}#${FR}`)?.after], [1, 'Description']);
    t.eq([rep.unchanged, rep.saved, r.writes.length, r.posts.length, r.store.pendingCount(), r.store.original(k, FR), readHistory(r.app.ctx).length], [1, 0, 0, 0, 0, 'Description', 0]);
    // With a real change in the same publish: only that one is written, and only its table published for it.
    r.store.set(k, FR, '');
    r.store.set(city, FR, 'Cité');
    const { rep: two } = await r.publish();
    t.eq([two.unchanged, two.saved, r.writes.map((w) => w.ids), r.posts.length], [1, 1, [[[`${city}#${FR}`, 'Cité']]], 1]);
    t.eq(readHistory(r.app.ctx)[0].items.map((it) => it.key), [city], 'only the change that was written is journaled');
  });

  run("a form label emptied to stand in for its column's French name typed in the same publish is written after the column, once that name is saved: the column's save failing or in conflict holds it back (skipped, saying so), its translation kept; Try again writes both. One that is that name already waits the same way", async (r) => {
    const col = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Account Name', [FR]: 'Nom' }).key;
    const cell = r.add('field', 'field|f1|c1|Label', { [EN]: 'Customer', [FR]: 'Client' }, { ref: { formId: 'f1', datafield: 'name', controlId: 'name' } }).key;
    const HELD = "Its column's French name wasn't saved, so nothing was written here either: Try again to save both.";
    // Every write says 'writing' first: `hook` runs then (someone else's save between the check before writing and the write).
    r.say = ['writing'];
    const o = (hook?: () => void) => ({ signal: new AbortController().signal, publish: true, onProgress: (x: { message: string }) => void (x.message === 'writing' && hook?.()) });
    // (a) The column's save fails: the form label is never written with a name the column doesn't have.
    r.store.set(col, FR, 'Nom du compte');
    r.store.set(cell, FR, '');
    r.failOnce.add(`${col}#${FR}`);
    const one = await r.app.saver.save(r.store.changes(), o());
    t.eq(one.results.map((x) => [x.change.slot.key, x.outcome, x.change.after, x.message]), [
      [col, 'error', 'Nom du compte', 'Could not reach Dataverse.'],
      [cell, 'skipped', 'Nom du compte', HELD],
    ]);
    t.eq([r.writes.length, r.server.get(`${cell}#${FR}`), r.store.pendingCount(), r.store.cellStatus(cell, FR)?.message, readHistory(r.app.ctx).length], [0, 'Client', 2, HELD, 0]);
    // Try again: the column first, then the form label of its new name.
    const two = await r.app.saver.save(retryable(r.app, one.results), o());
    t.eq(two.results.map((x) => [x.outcome, x.change.after]), [['saved', 'Nom du compte'], ['saved', 'Nom du compte']]);
    t.eq(r.writes.map((w) => w.ids.map(([id]) => id)), [[`${col}#${FR}`], [`${cell}#${FR}`]], 'the column, then the form label');
    t.eq(readHistory(r.app.ctx)[0].items.map((it) => [it.key, it.before, it.after]), [[col, 'Nom', 'Nom du compte'], [cell, 'Client', 'Nom du compte']]);
    // (b) Someone else renames the column after the check before writing: its write is a conflict, and the label waits.
    r.store.set(col, FR, 'Nom 3');
    r.store.set(cell, FR, '');
    const three = await r.app.saver.save(r.store.changes(), o(() => r.server.set(`${col}#${FR}`, 'Nom (Marie)')));
    t.eq(three.results.map((x) => [x.change.slot.key, x.outcome, x.message ?? '']), [[col, 'conflict', ''], [cell, 'skipped', HELD]]);
    t.eq([r.server.get(`${cell}#${FR}`), r.store.cellStatus(col, FR)?.outcome, r.store.pendingCount()], ['Nom du compte', 'conflict', 2]);
    // Use theirs: the label then stands in for the name the column has.
    r.store.resolve(col, FR, false);
    const four = await r.app.saver.save(r.store.changes(), o());
    t.eq([four.results.map((x) => [x.change.slot.key, x.outcome, x.change.after]), r.server.get(`${cell}#${FR}`)], [[[cell, 'saved', 'Nom (Marie)']], 'Nom (Marie)']);
    // (c) A label that is the column's new name already needs no write, once that name is saved: held while it isn't.
    const col2 = r.add('attribute', 'attribute|acc.city|DisplayName', { [EN]: 'City', [FR]: 'Ville' }).key;
    const cell2 = r.add('field', 'field|f1|c2|Label', { [EN]: 'Town', [FR]: 'Cité' }, { ref: { formId: 'f1', datafield: 'city', controlId: 'city' } }).key;
    r.store.set(col2, FR, 'Cité');
    r.store.set(cell2, FR, '');
    r.failOnce.add(`${col2}#${FR}`);
    const five = await r.app.saver.save(r.store.changes(), o());
    t.eq(five.results.map((x) => [x.change.slot.key, x.outcome, x.message ?? '']), [[col2, 'error', 'Could not reach Dataverse.'], [cell2, 'skipped', "Its column's French name wasn't saved, so nothing was written here either: Try again to save both."]]);
    const writes = r.writes.length;
    const six = await r.app.saver.save(retryable(r.app, five.results), o());
    t.eq([six.results.map((x) => [x.change.slot.key, x.outcome]), r.writes.length - writes, r.store.pendingCount()], [[[col2, 'saved'], [cell2, 'unchanged']], 1, 0]);
  });

  run("an undo that puts a column's French name back and empties a form label the publish added writes that label's stand-in (the name put back) only once the column is back: a column that fails holds it back, and the publish stays undoable", async (r) => {
    const col = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Account Name', [FR]: 'Nom' }).key;
    const cell = r.add('field', 'field|f1|c1|Label', { [EN]: 'Customer' }, { ref: { formId: 'f1', datafield: 'name', controlId: 'name' } }).key;
    r.store.set(col, FR, 'Nom 2');
    r.store.set(cell, FR, 'Client');
    await r.publish();
    const [e] = readHistory(r.app.ctx);
    t.eq(e.items.map((it) => [it.key, it.before, it.after]), [[col, 'Nom', 'Nom 2'], [cell, '', 'Client']]);
    const o = { signal: new AbortController().signal, publish: true, onProgress() {} };
    r.failOnce.add(`${col}#${FR}`);
    const one = await r.app.saver.undo(e, o);
    t.eq(one.results.map((x) => [x.change.slot.key, x.outcome, x.change.after]), [[col, 'error', 'Nom'], [cell, 'skipped', 'Nom']]);
    t.eq([r.server.get(`${cell}#${FR}`), readHistory(r.app.ctx).find((x) => x.id === e.id)?.undoneAt], ['Client', undefined]);
    const two = await r.app.saver.undo(e, o);
    t.eq(two.results.map((x) => [x.change.slot.key, x.outcome, x.change.after]), [[col, 'saved', 'Nom'], [cell, 'saved', 'Nom']]);
    t.ok(readHistory(r.app.ctx).find((x) => x.id === e.id)?.undoneAt, 'undone');
  });

  run("an emptied translation whose stand-in is the text it replaces is read first: someone else's newer text there is a conflict showing it (nothing written), never a silent 'unchanged'; Keep mine writes the stand-in over it. The same in an undo", async (r) => {
    const k = r.add('attribute', 'attribute|acc.desc|DisplayName', { [EN]: 'Description', [FR]: 'Description' }).key;
    r.server.set(`${k}#${FR}`, 'Descriptif (Marie)'); // another maker, since the load
    r.store.set(k, FR, '');
    const { rep } = await r.publish();
    t.eq(rep.results.map((x) => [x.outcome, x.server, x.change.after]), [['conflict', 'Descriptif (Marie)', 'Description']]);
    t.eq([rep.unchanged, rep.conflicts, rep.published, r.writes.length, r.posts.length, r.store.pendingCount(), r.store.cellStatus(k, FR)?.server], [0, 1, false, 0, 0, 1, 'Descriptif (Marie)']);
    r.store.resolve(k, FR, true); // Keep mine
    const { rep: two } = await r.publish();
    t.eq([two.results.map((x) => [x.outcome, x.change.after]), r.server.get(`${k}#${FR}`)], [[['saved', 'Description']], 'Description']);
    // An undo: the publish added a French name that is the English one; someone changed it since.
    const code = r.add('attribute', 'attribute|acc.code|DisplayName', { [EN]: 'Code' }).key;
    r.store.set(code, FR, 'Code');
    const { rep: three } = await r.publish();
    const e = readHistory(r.app.ctx).find((x) => x.id === three.historyId)!;
    r.server.set(`${code}#${FR}`, 'Code (Marie)');
    const writes = r.writes.length;
    const o = { signal: new AbortController().signal, publish: true, onProgress() {} };
    const u = await r.app.saver.undo(e, o);
    t.eq(u.results.map((x) => [x.outcome, x.server]), [['conflict', 'Code (Marie)']]);
    t.eq([readHistory(r.app.ctx).find((x) => x.id === e.id)?.undoneAt, r.server.get(`${code}#${FR}`)], [undefined, 'Code (Marie)']);
    // Back as the publish left it: nothing to write, and the publish is undone.
    r.server.set(`${code}#${FR}`, 'Code');
    const u2 = await r.app.saver.undo(e, o);
    t.eq([u2.results.map((x) => x.outcome), !!readHistory(r.app.ctx).find((x) => x.id === e.id)?.undoneAt, r.writes.length], [['unchanged'], true, writes]);
  });

  run("an undo measures each stand-in by the texts it leaves on the server: the earlier text it writes back (never a pending edit); the server's where that label is left alone (changed since, not chosen); the earlier text where it is undone anyway; a text that moved since it was loaded is read again first, never written stale, and Try again writes the new one", async (r) => {
    const k: Record<string, string> = {};
    for (const x of ['a', 'b', 'c', 'd']) k[x] = r.add('attribute', `attribute|acc.${x}|DisplayName`, { [EN]: x.toUpperCase() }).key;
    // One publish renamed each in English and added French.
    for (const key of Object.values(k)) {
      r.store.set(key, EN, 'Full name');
      r.store.set(key, FR, 'Nom');
    }
    await r.publish();
    const [e] = readHistory(r.app.ctx);
    // Since: a's English has an edit staged here; b's, c's and d's were renamed by someone, b's and d's reloaded here.
    r.store.set(k.a, EN, 'Pending');
    for (const x of ['b', 'c', 'd']) r.server.set(`${k[x]}#${EN}`, 'Account name');
    for (const x of ['b', 'd']) r.store.add([{ ...r.store.get(k[x])!, labels: { [EN]: 'Account name', [FR]: 'Nom' } }]);
    // d is undone anyway, as the Undo question does it: measured against the text just read.
    const id = `${k.d}#${EN}`;
    const entry = { ...e, items: e.items.map((it) => (`${it.key}#${it.lcid}` === id ? { ...it, after: 'Account name' } : it)) };
    const o = { signal: new AbortController().signal, publish: true, onProgress() {} };
    const rep = await r.app.saver.undo(entry, { ...o, anyway: new Set([id]) });
    const texts = () => ['a', 'b', 'c', 'd'].map((x) => [r.server.get(`${k[x]}#${EN}`), r.server.get(`${k[x]}#${FR}`)]);
    t.eq(texts(), [
      ['A', 'A'], // its English text as the undo puts it back, never the pending “Pending” nor the published “Full name”
      ['Account name', 'Account name'], // English left alone (changed since): French gets it
      ['Account name', 'Nom'], // English as loaded is stale: read again, nothing written
      ['D', 'D'], // undone anyway: its earlier English text
    ]);
    t.eq(r.store.value(k.a, EN), 'Pending', 'the staged edit stays staged');
    t.eq(rep.results.filter((x) => x.change.slot.key === k.c).map((x) => [x.change.lcid, x.outcome, x.message ?? '']), [
      [EN, 'conflict', ''],
      [FR, 'error', 'Its English text changed on the server since it was loaded (now “Account name”), so nothing was written: Try again to put the new text in its place.'],
    ]);
    t.eq(readHistory(r.app.ctx).find((x) => x.id === e.id)?.undoneAt, undefined, 'not undone while a label is left');
    // Try again: c's English is now known to be someone's, left alone, so French gets it.
    const left = { ...e, items: e.items.filter((it) => it.key === k.c) };
    await r.app.saver.undo(left, o);
    t.eq(texts()[2], ['Account name', 'Account name']);
  });

  run("someone else's change is a conflict: nothing overwritten, skipped until resolved; Keep mine then Try again publishes mine", async (r) => {
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    r.server.set(`${k}#${FR}`, 'Nom (par Marie)');
    r.store.set(k, FR, 'Nom 2');
    const { rep } = await r.publish();
    t.eq([rep.conflicts, r.writes.length, r.posts.length], [1, 0, 0], 'nothing written or published');
    t.eq(r.store.cellStatus(k, FR), { outcome: 'conflict', server: 'Nom (par Marie)' });
    t.eq(retryable(r.app, rep.results), [], 'Try again leaves an open conflict alone');
    t.eq([planPublish(r.app, r.store.changes()).blocked.get(`${k}#${FR}`)], [''], 'a new Publish skips it too (Keep mine / Use theirs shown)');
    r.store.resolve(k, FR, true); // Keep mine
    const again = retryable(r.app, rep.results);
    t.eq(again.map((c) => [c.before, c.after]), [['Nom (par Marie)', 'Nom 2']], 'rebased on their text');
    const rep2 = await r.app.saver.save(again, { signal: new AbortController().signal, publish: true, onProgress() {} });
    t.eq([rep2.saved, r.server.get(`${k}#${FR}`), r.posts.length], [1, 'Nom 2', 1]);
    t.eq(readHistory(r.app.ctx)[0].items[0].before, 'Nom (par Marie)', 'undo puts their text back');
  });

  run('Use theirs drops the staged change', async (r) => {
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    r.server.set(`${k}#${FR}`, 'Nom (par Marie)');
    r.store.set(k, FR, 'Nom 2');
    const { rep } = await r.publish();
    r.store.resolve(k, FR, false);
    t.eq([r.store.pendingCount(), r.store.value(k, FR), retryable(r.app, rep.results).length], [0, 'Nom (par Marie)', 0]);
  });

  run('a failed write stays staged and Try again writes it; the ones that went through are not written again', async (r) => {
    const a = r.add('attribute', 'attribute|acc.a|DisplayName', { [EN]: 'A', [FR]: 'A fr' }).key;
    const b = r.add('attribute', 'attribute|acc.b|DisplayName', { [EN]: 'B', [FR]: 'B fr' }).key;
    r.store.set(a, FR, 'A 2');
    r.store.set(b, FR, 'B 2');
    r.failOnce.add(`${b}#${FR}`);
    const { rep } = await r.publish();
    t.eq([rep.saved, rep.errors, rep.published], [1, 1, true]);
    t.eq(r.store.cellStatus(b, FR)?.outcome, 'error');
    const again = retryable(r.app, rep.results);
    t.eq(again.map(changeId), [`${b}#${FR}`]);
    await r.app.saver.save(again, { signal: new AbortController().signal, publish: true, onProgress() {} });
    t.eq([r.server.get(`${a}#${FR}`), r.server.get(`${b}#${FR}`), r.store.pendingCount()], ['A 2', 'B 2', 0]);
    t.eq(r.writes.map((w) => w.ids.map(([id]) => id)), [[`${a}#${FR}`], [`${b}#${FR}`]]);
  });

  run('a write whose answer was lost, found already as asked by Try again, is published and journaled, so it can be undone', async (r) => {
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    r.store.set(k, FR, 'Nom 2');
    r.landOnce.add(`${k}#${FR}`);
    const { rep } = await r.publish();
    t.eq([rep.errors, rep.published, readHistory(r.app.ctx).length], [1, false, 0]);
    const o = { signal: new AbortController().signal, publish: true, onProgress() {} };
    const rep2 = await r.app.saver.save(retryable(r.app, rep.results), o);
    t.eq([rep2.unchanged, rep2.published, r.posts.length], [1, true, 1]);
    const [e] = readHistory(r.app.ctx);
    t.eq([e?.id, e?.published, e?.items.map((i) => [i.lcid, i.before, i.after])], [rep2.historyId, true, [[FR, 'Nom', 'Nom 2']]]);
    const rep3 = await r.app.saver.undo(e, o);
    t.eq([rep3.saved, r.server.get(`${k}#${FR}`)], [1, 'Nom'], 'undone');
    // An undo that finds a label already back journals only what it wrote (its Redo).
    const rep4 = await r.app.saver.undo(e, o);
    t.eq([rep4.unchanged, rep4.historyId], [1, undefined]);
  });

  run("a write whose answer was lost, then a run that finds someone else's text there (a conflict): the lost write is settled, so a later run finding the asked text again (theirs, after Keep mine) never journals it as this publish's", async (r) => {
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    const id = `${k}#${FR}`;
    r.store.set(k, FR, 'Nom 2');
    r.landOnce.add(id);
    const o = { signal: new AbortController().signal, publish: true, onProgress() {} };
    const { rep } = await r.publish();
    t.eq([rep.errors, r.server.get(id)], [1, 'Nom 2'], 'written, not confirmed');
    r.server.set(id, 'Nom (Marie)');
    const rep2 = await r.app.saver.save(retryable(r.app, rep.results), o);
    t.eq(rep2.conflicts, 1, 'someone else saved over it');
    // They then save the very text this publish asked for; Keep mine, Try again.
    r.server.set(id, 'Nom 2');
    r.store.resolve(k, FR, true);
    const rep3 = await r.app.saver.save(retryable(r.app, rep2.results), o);
    t.eq([rep3.unchanged, rep3.results[0].found, rep3.historyId, readHistory(r.app.ctx).length], [1, true, undefined, 0], "theirs: never journaled");
  });

  run("a label someone else saved as asked before this publish's first attempt is not this publish's change: reported already as asked and published, never journaled, so its Undo never puts back what it didn't write", async (r) => {
    const a = r.add('attribute', 'attribute|acc.a|DisplayName', { [EN]: 'A', [FR]: 'Ancien' }).key;
    const b = r.add('attribute', 'attribute|acc.b|DisplayName', { [EN]: 'B', [FR]: 'B fr' }).key;
    r.store.set(a, FR, 'Nouveau');
    r.store.set(b, FR, 'B 2');
    r.server.set(`${a}#${FR}`, 'Nouveau'); // another maker saved and published the same text first
    const { rep } = await r.publish();
    t.eq(rep.results.map((x) => [x.change.slot.key, x.outcome, x.found ?? false]), [[a, 'unchanged', true], [b, 'saved', false]]);
    t.eq([rep.unchanged, rep.saved, rep.published, r.posts.length, r.store.pendingCount()], [1, 1, true, 1, 0]);
    t.eq(readHistory(r.app.ctx).map((e) => e.items.map((it) => [it.key, it.before, it.after])), [[[b, 'B fr', 'B 2']]], "only this publish's own write");
    // Alone: nothing journaled at all, and nothing to undo.
    r.store.set(b, FR, 'B 3');
    r.server.set(`${b}#${FR}`, 'B 3');
    const { rep: two } = await r.publish();
    t.eq([two.unchanged, two.results[0].found, two.historyId, readHistory(r.app.ctx).length], [1, true, undefined, 1]);
  });

  run('a failed publish: saved, journaled as not published; Publish again publishes and marks the journal', async (r) => {
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    r.store.set(k, FR, 'Nom 2');
    r.publishFails = 1;
    const { rep } = await r.publish();
    t.eq([rep.saved, rep.published, /publishing failed/.test(rep.publishError || '')], [1, false, true], rep.publishError);
    t.eq(readHistory(r.app.ctx)[0].published, false);
    const saved = rep.results.filter((x) => x.outcome === 'saved').map((x) => x.change);
    await publishAgain(r.app, saved, [rep.historyId!]);
    t.eq(r.posts.length, 1);
    t.ok(r.posts[0].includes('<entity>acc</entity>'), r.posts[0]);
    t.eq(readHistory(r.app.ctx)[0].published, true, 'Recent publishes: published');
  });

  run("others' unpublished work is one plain sentence; publishing always publishes", async (r) => {
    r.add('entity', 'entity|acc|DisplayName', { [EN]: 'Account' }, { title: 'Account' });
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    r.work.set('acc', ['Sales form (draft)', 'Quick form']);
    r.store.set(k, FR, 'Nom 2');
    const found = await r.app.saver.pendingWork(planPublish(r.app, r.store.changes()).send);
    t.eq(othersText(r.app, found), 'Publishing Account also publishes 2 other unpublished changes on it.');
    t.eq(othersText(r.app, []), '');
    await r.publish();
    t.eq(r.posts.length, 1, 'published anyway');
  });

  run("the check of others' work: a failed read rejects (never \"nothing pending\"); one that never answers is said as not checked after its time; a stopped one says nothing", async (r) => {
    r.add('entity', 'entity|acc|DisplayName', { [EN]: 'Account' }, { title: 'Account' });
    r.add('entity', 'entity|con|DisplayName', { [EN]: 'Contact' }, { title: 'Contact' });
    const a = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' });
    const c = r.add('attribute', 'attribute|con.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }, { entity: 'con' });
    const cs = [a, c].map((slot) => ({ slot, lcid: FR, before: 'Nom', after: 'Nom 2' }));
    const http = r.app.ctx.http as unknown as { all: (url: string, o?: { signal?: AbortSignal }) => Promise<unknown[]> };
    http.all = async (url) => {
      if (url.startsWith('savedqueryvisualizations')) throw new DvError('You do not have permission to do this.', 403);
      return [];
    };
    let failed = false;
    await r.app.saver.pendingWork(cs).catch(() => (failed = true));
    t.ok(failed, 'rejected');
    t.eq(await othersNote(r.app, cs), "Couldn't check Account and Contact for other unpublished changes: publishing them also publishes any there are.");
    http.all = (_url, o) => new Promise((_ok, no) => o?.signal?.addEventListener('abort', () => no(new DOMException('Aborted', 'AbortError'))));
    t.eq(await othersNote(r.app, cs, undefined, 5), "Couldn't check Account and Contact for other unpublished changes: publishing them also publishes any there are.");
    const ac = new AbortController();
    const stopped = othersNote(r.app, cs, ac.signal);
    ac.abort();
    t.eq(await stopped, '');
  });

  run('a classic button is saved together with publishing; a modern command is live once saved', async (r) => {
    const rb = r.add('ribbon', 'ribbon|acc.btn|Label', { [EN]: 'Run' }, { ref: { entity: 'acc' }, comp: 'ribbon|acc.btn' }).key;
    r.store.set(rb, FR, 'Lancer');
    const { rep } = await r.publish();
    t.eq([rep.saved, r.writes[0].allowPublish, r.posts.length], [1, true, 1]);
    const cmd = r.add('command', 'command|cmd1|Label', { [EN]: 'Approve' }).key;
    r.store.set(cmd, FR, 'Approuver');
    const { rep: rep2 } = await r.publish();
    t.eq([rep2.saved, rep2.published, r.posts.length], [1, true, 1], 'nothing more published');
  });

  run('the forms check: a form whose unpublished version is still newer after publishing is reported; a form it can\'t read is "not known", never published', async (r) => {
    const a = r.add('field', 'field|f1|c1|Label', { [EN]: 'A' }, { path: ['Account', 'Main form'], ref: { formId: '{F1}' } });
    const b = r.add('tab', 'tab|f2|t1|Label', { [EN]: 'B' }, { path: ['Account', 'Quick form'], ref: { formId: 'f2' } });
    const c = r.add('field', 'field|f3|c1|Label', { [EN]: 'C' }, { path: ['Account', 'Card form'], ref: { formId: 'f3' } });
    const d = r.add('attribute', 'attribute|acc.d|DisplayName', { [EN]: 'D' });
    r.versions.set('f1', [10, 12]);
    r.versions.set('f2', [20, 20]);
    const cs = [a, b, c, d].map((slot) => ({ slot, lcid: FR, before: '', after: 'x' }));
    t.eq(await unpublishedForms(r.app, cs, undefined, 0), { left: ['Main form'], unread: ['Card form'] });
    r.versions.set('f1', [13, 13]);
    r.versions.set('f3', [5, 5]);
    t.eq(await unpublishedForms(r.app, cs, undefined, 0), { left: [], unread: [] });
    // Refused (403), throttled past Http's own retries (429), unreachable, or answered without a version.
    const http = r.app.ctx.http as unknown as { get: (url: string) => Promise<unknown> };
    for (const fail of [new DvError('You do not have permission to do this.', 403), new DvError('Rate limit exceeded.', 429), new DvError('Could not reach Dataverse (network error).', 0, 'network'), null]) {
      http.get = async (url) => {
        if (!url.startsWith('systemforms(f2)')) return { versionnumber: 7 };
        if (fail) throw fail;
        return {};
      };
      t.eq(await unpublishedForms(r.app, cs, undefined, 0), { left: [], unread: ['Quick form'] }, String(fail?.status ?? 'no version'));
    }
  });

  // ---- the Publish dialog itself (ui/review.ts) on the fake DOM of the popup tests ----

  interface Dlg {
    /** Times app.refreshPage() ran. */
    refreshed: number;
    toasts: string[];
    view: 'page' | 'workbench';
    /** Opens the Publish dialog (openReview); `closed` settles when it closes. */
    open(): void;
    closed: Promise<SaveReport | undefined>;
    /** The topmost dialog. */
    dlg(): FEl;
    title(): string;
    text(): string;
    /** The labels of its footer buttons. */
    actions(): string[];
    /** Clicks its first button with this text. */
    click(label: string, o?: Partial<Ev>): void;
    until(what: string, cond: () => boolean): Promise<void>;
    /**
     * The running step: what follows its label (counter · item) and its hover text; then what the run's one live
     * region (visually hidden) said last.
     */
    running(): string[];
    /** Its body's parts (lists with their row counts) and its footer: the same from Publish until the result shows. */
    shape(): string;
    /** Waits for Recent publishes' Undo question to have read the labels and checked others' work; its Undo button. */
    undoReady(): Promise<FEl>;
    /** The dialog's own rules (app.adoptStyles). */
    css: string;
  }
  const dialog = (name: string, fn: (r: Rig, d: Dlg) => Promise<void>) =>
    run(`the dialog: ${name}`, async (r) => {
      const off = install();
      setLayer(dom.layer as unknown as HTMLElement);
      const d = { refreshed: 0, toasts: [], view: 'page' } as unknown as Dlg;
      // What the dialog needs of the app besides the rig: the view, the refresh (a spy: it would reload), toasts.
      Object.assign(r.app, { view: () => d.view, refreshPage: async () => (d.refreshed++, true), adoptStyles: (css: string) => void (d.css = css), toast: (m: string) => void d.toasts.push(m) });
      d.open = () => {
        d.closed = openReview(r.app);
        d.closed.catch(() => {}); // a failing test reports its own error
      };
      d.dlg = () => dom.layer.querySelectorAll('.dialog').pop()!;
      d.title = () => d.dlg().querySelector('h3')!.textContent;
      d.text = () => d.dlg().textContent;
      d.actions = () => d.dlg().querySelectorAll('.dlg-actions button').map((b) => b.textContent);
      d.click = (label, o = {}) => {
        const b = d.dlg().querySelectorAll('button').find((x) => x.textContent === label);
        t.ok(b, `no ${label} button in: ${d.text()}`);
        fire(b!, 'click', { detail: 1, ...o });
      };
      d.until = async (what, cond) => {
        for (let i = 0; i < 400 && !cond(); i++) await tick(5);
        t.ok(cond(), `${what}; the dialog shows: ${d.title()} | ${d.text()} | ${d.actions().join(', ')}`);
      };
      d.running = () => {
        const row = d.dlg().querySelector('.pd-st .pr[aria-current]');
        const live = d.dlg().querySelectorAll('[aria-live]');
        t.eq([live.length, live[0]?.className, live[0]?.getAttribute('aria-live')], [1, 'vh', 'polite'], 'one polite live region, visually hidden');
        return [row?.querySelector('small')?.textContent ?? '', row?.title ?? '', live[0]?.textContent ?? ''];
      };
      d.shape = () =>
        d.dlg().querySelector('.dlg-body')!.children.map((c) => `${c.className.split(' ')[0]}:${c.matches('.pl') ? c.children.length : ''}`).join(' ') +
        ' | ' +
        d.dlg().querySelector('.dlg-actions')!.textContent;
      d.undoReady = async () => {
        const go = () => d.dlg().querySelector('.dlg-actions .btn.primary');
        await d.until('the Undo question', () => d.title() === 'Undo this publish?' && !!go() && !go()!.disabled);
        return go()!;
      };
      try {
        await fn(r, d);
      } finally {
        teardownLayer(); // closes what is still open
        off();
      }
    });

  dialog('a full success publishes once, checks and refreshes the page; Stop never takes the focus', async (r, d) => {
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    r.store.set(k, FR, 'Nom 2');
    d.open();
    t.eq([d.title(), d.actions()], ['Publish 1 change', ['Cancel', 'Publish']]);
    t.ok(d.css.includes('.pd-st{flex:none}'), 'the steps never shrink into a scrolling box that hides one on a short window');
    await tick(); // the check of others' work has answered (nothing): Publish starts at once
    d.click('Publish');
    t.eq(d.actions(), ['Stop'], 'the progress');
    t.ok(dom.root.activeElement === d.dlg(), 'the dialog keeps the focus: a second Enter meant for Publish does nothing');
    d.click('Stop', { detail: 2 }); // the second click of the double-click on Publish
    d.click('Stop'); // right away: it lands where Publish was
    await d.until('refreshed', () => d.refreshed > 0);
    t.eq([r.posts.length, r.store.pendingCount(), d.refreshed, readHistory(r.app.ctx)[0].published], [1, 0, 1, true], 'not stopped');
    t.ok(d.text().includes('Done. Refreshing the page…'), d.text());
  });

  dialog('a write whose answer was lost: Try again finds it already saved, publishes it, checks and refreshes', async (r, d) => {
    const k = r.add('field', 'field|f1|c1|Label', { [EN]: 'Client', [FR]: 'Client' }, { path: ['Account', 'Main form'], ref: { formId: 'f1' } }).key;
    r.store.set(k, FR, 'Client FR');
    r.landOnce.add(`${k}#${FR}`);
    r.versions.set('f1', [10, 10]); // the forms check finds it published once PublishXml ran
    d.open();
    d.click('Publish');
    await d.until('the problems', () => d.actions().includes('Try again'));
    t.eq([r.server.get(`${k}#${FR}`), r.posts.length, d.refreshed], ['Client FR', 0, 0], 'written, nothing published yet (nothing was confirmed)');
    t.ok(d.text().includes('could not be checked'), d.text());
    d.click('Try again');
    await d.until('refreshed', () => d.refreshed > 0);
    t.eq(r.posts.length, 1, 'published: never "Nothing needed publishing" for a write that may be unpublished');
    t.ok(r.posts[0].includes('<entity>acc</entity>'), r.posts[0]);
    t.eq([r.store.pendingCount(), r.store.cellStatus(k, FR)?.outcome], [0, 'saved']);
  });

  dialog('a failed metadata row has a "Copy details" link that copies what this page sent and Dataverse answered for its component; rows without any write kept have none', async (r, d) => {
    const k = r.add('attribute', 'attribute|acc.copy|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    const k2 = r.add('attribute', 'attribute|acc.other|DisplayName', { [EN]: 'Other', [FR]: 'Autre' }).key;
    r.store.set(k, FR, 'Nom 2');
    r.store.set(k2, FR, 'Autre 2');
    r.failOnce.add(`${k}#${FR}`);
    r.failOnce.add(`${k2}#${FR}`);
    // What the metadata writer logged for the first one (providers/writelog.ts); the rig's writer is a stand-in.
    logWrite({
      at: Date.UTC(2026, 9, 16, 18, 10, 25),
      group: k,
      title: 'Nom (column)',
      calls: [{ req: "PUT EntityDefinitions(LogicalName='acc')/Attributes(LogicalName='copy')", status: 'HTTP 204', requestId: 'req-9' }],
      items: [{ id: `${k}#${FR}`, what: 'DisplayName, French (1036)', before: 'Nom', wrote: 'Nom 2', read: 'Nom', layers: ['2026-10-16T18:10:26.000Z: "Nom" (Active layer modifiedon 2026-10-16T18:10:25.927)'], outcome: 'error: …' }],
    });
    (r.app.ctx as { origin?: string }).origin = 'https://org.example';
    let copied = '';
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    Object.defineProperty(nav, 'clipboard', { configurable: true, value: { writeText: async (s: string) => void (copied = s) } });
    try {
      d.open();
      d.click('Publish');
      await d.until('the problems', () => d.actions().includes('Try again'));
      t.eq(d.dlg().querySelectorAll('button').filter((b) => b.textContent === 'Copy details').length, 1, 'only the row whose component has writes kept');
      d.click('Copy details');
      await d.until('the link says it copied', () => d.text().includes('Copied'));
      for (const s of ['Org: https://org.example', 'Reported: Could not reach Dataverse.', '"Nom" -> "Nom 2"', "-> HTTP 204, x-ms-service-request-id req-9", '2026-10-16T18:10:25.000Z  Nom (column)', 'layers 2026-10-16T18:10:26.000Z: "Nom" (Active layer modifiedon 2026-10-16T18:10:25.927)'])
        t.ok(copied.includes(s), `${s}\nin:\n${copied}`);
    } finally {
      delete nav.clipboard;
    }
  });

  dialog('a write whose answer was lost, found already as asked by Try again on a form still unpublished: journaled as not published, and Recent publishes › Publish publishes it', async (r, d) => {
    const k = r.add('field', 'field|f1|c1|Label', { [EN]: 'Client', [FR]: 'Client' }, { path: ['Account', 'Main form'], ref: { formId: 'f1' } }).key;
    r.store.set(k, FR, 'Client FR');
    r.landOnce.add(`${k}#${FR}`);
    r.versions.set('f1', [10, 12]); // PublishXml does not take: the unpublished version stays newer
    d.open();
    d.click('Publish');
    await d.until('the problems', () => d.actions().includes('Try again'));
    t.ok(d.text().includes('1 of 1 needs attention'), `never "not saved" over a row that may say the change was accepted: ${d.text()}`);
    d.click('Try again');
    await d.until('the check', () => d.actions().includes('Publish again'));
    t.eq([d.title(), r.posts.length, readHistory(r.app.ctx).map((e) => e.published)], ['Saved, but not published', 1, [false]], 'Recent publishes shows it as not published');
    d.click('Close');
    await d.closed;
    t.eq(d.toasts, ['Your translations are saved, but not published yet. Publish them from Recent publishes.']);
    r.versions.set('f1', [13, 13]);
    openHistory(r.app);
    t.ok(d.text().includes('Not published'), d.text());
    d.click('Publish');
    await d.until('published', () => d.title() === 'Published');
    t.eq([r.posts.length, readHistory(r.app.ctx)[0].published], [2, true]);
  });

  /**
   * A view's French name saved by the real records writer (providers/records.ts) instead of the rig's: RetrieveLocLabels
   * answers the labels stored, a write batch [read, SetLocLabels, read] runs its parts in order and stops at a failed one.
   * `fail` says how the next attempt ends: its read of the current label refused (403, no write sent), its SetLocLabels
   * refused (403), or its answer lost once its parts ran. `writes` counts the SetLocLabels sent; `reports` each run's.
   */
  const recordsView = (r: Rig, d: Dlg) => {
    const key = r.add('view', 'view|v1|Name', { [EN]: 'Open', [FR]: 'Ancien' }, { prop: 'Name', comp: 'view|v1', group: 'view|v1', title: 'Open', ref: { id: 'v1', table: 'savedquery', entitySet: 'savedqueries', column: 'name', entity: 'acc' } }).key;
    const S = { labels: { [EN]: 'Open', [FR]: 'Ancien' } as Record<number, string>, fail: '' as '' | 'read' | 'write' | 'lost', writes: 0, reports: [] as SaveReport[] };
    const read = () => ({ Label: { LocalizedLabels: Object.entries(S.labels).map(([l, v]) => ({ Label: v, LanguageCode: Number(l) })) } });
    const refused = () => new DvError('You do not have permission to do this.', 403);
    const http = r.app.ctx.http as unknown as Record<string, unknown>;
    const get = http.get as (url: string, o?: unknown) => Promise<unknown>;
    Object.assign(http, {
      fn: (name: string) => `${name}(savedqueries(v1),name)`,
      get: async (url: string, o?: unknown) => {
        if (url.endsWith('?$select=ismanaged')) return { ismanaged: false };
        if (!url.startsWith('RetrieveLocLabels')) return get(url, o);
        if (S.fail === 'read') throw ((S.fail = ''), refused());
        return read();
      },
      batch: async (parts: BatchPart[], o: { stop?: boolean } = {}): Promise<PartResult[]> => {
        const out: PartResult[] = [];
        for (const p of parts) {
          if (p.method === 'GET') {
            out.push({ ok: true, status: 200, data: read(), headers: {} });
            continue;
          }
          S.writes++;
          if (S.fail === 'write') {
            S.fail = '';
            out.push({ ok: false, status: 403, data: null, error: refused().message, headers: {} });
            if (o.stop) break;
            continue;
          }
          for (const l of (p.body as { Labels: Array<{ Label: string; LanguageCode: number }> }).Labels)
            if (l.Label) S.labels[l.LanguageCode] = l.Label;
            else delete S.labels[l.LanguageCode];
          out.push({ ok: true, status: 204, data: null, headers: {} });
        }
        if (S.fail === 'lost') throw ((S.fail = ''), new DvError('Could not reach Dataverse (network error).', 0, 'network'));
        while (out.length < parts.length) out.push({ ok: false, status: 0, data: null, error: 'Dataverse sent no answer for this part of the request.', headers: {} });
        return out;
      },
    });
    const lang = { restore: async () => {}, quiet: <T>(fn: () => Promise<T>) => fn() } as unknown as AppApi['lang'];
    const saver = createSaver(r.app.ctx, r.store, lang, (k) => (k === 'view' ? recordsWriter : undefined));
    const save = saver.save;
    saver.save = async (cs, o) => {
      const rep = await save(cs, o);
      S.reports.push(rep);
      return rep;
    };
    r.app.saver = saver;
    // Not a page: the dialog says how it ended instead of refreshing the page.
    d.view = 'workbench';
    r.store.set(key, FR, 'Nouveau');
    return { key, S };
  };

  for (const [how, sent] of [
    ['its read of the current label is refused (403), so no write is sent', 0],
    ['its SetLocLabels is refused (403)', 1],
  ] as const)
    dialog(`a first attempt where ${how}, then someone else saves the same text: Try again finds it there and never journals it as this publish's, so Recent publishes' Undo can't put the old text back over theirs`, async (r, d) => {
      const { key, S } = recordsView(r, d);
      S.fail = sent ? 'write' : 'read';
      d.open();
      await tick();
      d.click('Publish');
      await d.until('the refusal', () => S.reports.length === 1 && d.actions().includes('Try again'));
      t.eq([S.reports[0].errors, S.writes, S.labels[FR], r.posts.length, readHistory(r.app.ctx).length], [1, sent, 'Ancien', 0, 0], 'refused: nothing saved, published or journaled');
      // Another maker saves and publishes the same text while the dialog waits.
      S.labels[FR] = 'Nouveau';
      d.click('Try again');
      await d.until('the second run', () => S.reports.length === 2 && d.actions().includes('Close'));
      const rep = S.reports[1];
      t.eq([rep.unchanged, rep.saved, rep.results[0].found, rep.historyId, S.writes], [1, 0, true, undefined, sent], "already as asked: someone else's text, nothing written");
      t.eq([readHistory(r.app.ctx).length, r.posts.length, r.store.pendingCount(), r.store.get(key)!.labels[FR]], [0, 1, 0, 'Nouveau'], 'published with the rest, never journaled');
      t.ok(d.text().includes('1 change was already on the server: nothing was written.'), d.text());
    });

  dialog("a first attempt whose SetLocLabels answer is lost once it ran: Try again finds it there, publishes it and journals it as this publish's, so Undo puts the old text back", async (r, d) => {
    const { key, S } = recordsView(r, d);
    S.fail = 'lost';
    d.open();
    await tick();
    d.click('Publish');
    await d.until('the lost answer', () => S.reports.length === 1 && d.actions().includes('Try again'));
    t.eq([S.reports[0].errors, S.writes, S.labels[FR], r.posts.length, readHistory(r.app.ctx).length], [1, 1, 'Nouveau', 0, 0], 'written, not confirmed');
    d.click('Try again');
    await d.until('the second run', () => S.reports.length === 2 && d.actions().includes('Close'));
    const rep = S.reports[1];
    t.eq([rep.unchanged, rep.results[0].found ?? false, S.writes, r.posts.length], [1, false, 1, 1], 'found as this write left it: nothing written again, published');
    const [e] = readHistory(r.app.ctx);
    t.eq([e?.id, e?.published, e?.items.map((i) => [i.key, i.lcid, i.before, i.after])], [rep.historyId, true, [[key, FR, 'Ancien', 'Nouveau']]]);
    t.ok(d.text().includes('Published 1 change.'), d.text());
    const undone = await r.app.saver.undo(e, { signal: new AbortController().signal, publish: true, onProgress() {} });
    t.eq([undone.saved, S.labels[FR]], [1, 'Ancien'], 'undone');
  });

  dialog("a first attempt whose answer is lost once it ran, then a Try again whose read is refused (nothing sent): the next Try again finds it there and still journals it as this publish's, so Undo puts the old text back", async (r, d) => {
    const { key, S } = recordsView(r, d);
    S.fail = 'lost';
    d.open();
    await tick();
    d.click('Publish');
    await d.until('the lost answer', () => S.reports.length === 1 && d.actions().includes('Try again'));
    t.eq([S.reports[0].errors, S.writes, S.labels[FR]], [1, 1, 'Nouveau'], 'written, not confirmed');
    S.fail = 'read';
    d.click('Try again');
    await d.until('the refused read', () => S.reports.length === 2 && d.actions().includes('Try again'));
    t.eq([S.reports[1].errors, S.writes, readHistory(r.app.ctx).length], [1, 1, 0], 'refused before anything was sent: what the first write may have saved is still unknown');
    d.click('Try again');
    await d.until('the third run', () => S.reports.length === 3 && d.actions().includes('Close'));
    const rep = S.reports[2];
    t.eq([rep.unchanged, rep.results[0].found ?? false, S.writes, r.posts.length], [1, false, 1, 1], "found as the first write left it: this publish's");
    const [e] = readHistory(r.app.ctx);
    t.eq([e?.id, e?.items.map((i) => [i.key, i.lcid, i.before, i.after])], [rep.historyId, [[key, FR, 'Ancien', 'Nouveau']]]);
    const undone = await r.app.saver.undo(e, { signal: new AbortController().signal, publish: true, onProgress() {} });
    t.eq([undone.saved, S.labels[FR]], [1, 'Ancien'], 'undone');
  });

  dialog("what a write saves or waits for shows on its step's line after the counter while it lasts; one live region says the steps and the waits, never each item; the dialog keeps its size", async (r, d) => {
    r.add('entity', 'entity|acc|DisplayName', { [EN]: 'Team' }, { title: 'Équipe' });
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Team name', [FR]: 'Nom' }).key;
    r.store.set(k, FR, "Nom de l'équipe");
    const wait = "Waiting for Dataverse to confirm Nom de l'équipe…";
    r.say = ["Saving Nom de l'équipe (column)", wait];
    // A PublishXml retry, as publishXml reports it once the publish has started.
    const busy = 'Dataverse is busy with another customization. Publishing again in 10 seconds…';
    const save = r.app.saver.save;
    const said: string[] = [];
    const seen: string[][] = [];
    let shape = '';
    r.app.saver.save = (cs, o) =>
      save(cs, {
        ...o,
        onProgress: (x) => {
          said.push(x.message);
          for (const message of x.message === 'Publishing…' ? [x.message, busy] : [x.message]) {
            o.onProgress({ ...x, message });
            seen.push(d.running());
            shape ||= d.shape();
            t.eq(d.shape(), shape, `nothing appears or goes under the steps (${message})`);
          }
        },
      });
    d.open();
    d.click('Publish');
    await d.until('refreshed', () => d.refreshed > 0);
    t.eq(shape, 'pl:4 vh: | Stop takes effect before the next write.Stop');
    t.eq(seen, [
      ['0 of 1', '', 'Saving 1 change'],
      ["0 of 1 · Nom de l'équipe", "Saving Nom de l'équipe (column)", 'Saving 1 change'],
      ["0 of 1 · waiting for Dataverse to confirm Nom de l'équipe", wait, wait],
      ['1 of 1', '', wait],
      ['', '', 'Publishing Équipe'],
      ['Dataverse is busy, trying again in 10 s', busy, busy],
    ]);
    t.eq(said, ['Saving…', "Saving Nom de l'équipe (column)", wait, 'Saving…', 'Publishing…'], "the saver never says a finished write's message again");
    t.ok(d.text().includes('Done. Refreshing the page…'), d.text());
  });

  dialog("Publish again and Recent publishes › Publish: Dataverse's busy retry shows on the Publishing step's line, the full sentence on hover", async (r, d) => {
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    r.store.set(k, FR, 'Nom 2');
    r.publishFails = 1;
    const busy = 'Dataverse is busy with another customization. Publishing again in 5 seconds…';
    // Dataverse is busy at the next publish; what the dialog shows when publishXml tries again.
    const http = r.app.ctx.http as unknown as { post: (fn: string, body: unknown) => Promise<unknown> };
    const post = http.post;
    const seen: string[][] = [];
    let lock: 'next' | 'retry' | '' = '';
    http.post = async (fn, body) => {
      if (fn === 'PublishXml' && lock === 'next') {
        lock = 'retry';
        throw new DvError('Cannot start another [EntityCustomization] because there is a previous [Import] running at this moment.', 429);
      }
      if (fn === 'PublishXml' && lock === 'retry') {
        lock = '';
        seen.push([...d.running(), d.shape()]);
      }
      return post(fn, body);
    };
    // publishXml waits 5 s before trying again: not here.
    const g = globalThis as { setTimeout: (fn: () => void, ms?: number) => unknown };
    const st = g.setTimeout;
    g.setTimeout = (fn, ms) => st(fn, ms === 5000 ? 1 : ms);
    try {
      d.open();
      d.click('Publish');
      await d.until('Publish again', () => d.actions().includes('Publish again'));
      lock = 'next';
      d.click('Publish again');
      await d.until('refreshed', () => d.refreshed > 0);
      t.eq(seen, [['Dataverse is busy, trying again in 5 s', busy, busy, 'pl:3 vh: | ']]);
      // A later save whose publish failed, published from Recent publishes.
      r.store.set(k, FR, 'Nom 3');
      r.publishFails = 1;
      await r.publish();
      openHistory(r.app);
      lock = 'next';
      d.click('Publish');
      await d.until('published', () => d.title() === 'Published');
      t.eq(seen[1], ['Dataverse is busy, trying again in 5 s', busy, busy, 'pl:2 vh: | ']);
      t.eq([r.posts.length, readHistory(r.app.ctx).map((e) => e.published)], [2, [true, true]]);
    } finally {
      g.setTimeout = st;
    }
  });

  dialog("Recent publishes › Undo shows its steps as the Publish dialog does: the label written now on the running step's line, one live region, the same size all along", async (r, d) => {
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    r.store.set(k, FR, "Nom de l'équipe");
    await r.publish();
    r.say = ['Saving Nom (column)'];
    const seen: string[][] = [];
    let shape = '';
    const undo = r.app.saver.undo;
    r.app.saver.undo = (x, o) =>
      undo(x, {
        ...o,
        onProgress: (p) => {
          o.onProgress(p);
          seen.push(d.running());
          shape ||= d.shape();
          t.eq(d.shape(), shape, `nothing appears or goes under the steps (${p.message})`);
        },
      });
    openHistory(r.app);
    d.click('Undo');
    fire(await d.undoReady(), 'click', { detail: 1 });
    await d.until('undone', () => d.title() === 'Publish undone');
    t.eq(shape, 'pbar: pl:2 vh: pl:1 | Stop takes effect before the next write.Stop');
    t.eq(seen, [
      ['0 of 1', '', 'Undoing 1 label'],
      ['0 of 1 · Nom', 'Saving Nom (column)', 'Undoing 1 label'],
      ['1 of 1', '', 'Undoing 1 label'],
      ['', '', 'Publishing'],
    ]);
  });

  dialog("a process name: the Publishing step says the process is being updated while it is, then the page refreshes; Recent publishes › Undo updates it again, on its own Publishing step", async (r, d) => {
    const P = processes(t, r);
    r.store.set(P.name(WF1).key, FR, 'Processus FR');
    const seen: string[][] = [];
    const save = r.app.saver.save;
    r.app.saver.save = (cs, o) => save(cs, { ...o, onProgress: (x) => (o.onProgress(x), void seen.push(d.running())) });
    d.open();
    d.click('Publish');
    await d.until('refreshed', () => d.refreshed > 0);
    t.eq(seen.slice(-2), [
      ['', '', 'Publishing Processus test'],
      ['Updating the process Processus test', 'Updating the process Processus test', 'Publishing Processus test'],
    ]);
    t.eq(P.updates(), [`update ${WF1} "bpf test" in 1033 once`]);
    // Undone from Recent publishes: the French name goes back, and the process is updated again.
    const undone: string[][] = [];
    const undo = r.app.saver.undo;
    r.app.saver.undo = (x, o) => undo(x, { ...o, onProgress: (p) => (o.onProgress(p), void undone.push(d.running())) });
    openHistory(r.app);
    d.click('Undo');
    fire(await d.undoReady(), 'click', { detail: 1 });
    await d.until('undone', () => d.title() === 'Publish undone');
    t.eq(undone.at(-1), ['Updating the process Processus test', 'Updating the process Processus test', 'Publishing']);
    t.eq(P.updates(), [`update ${WF1} "bpf test" in 1033 once`, `update ${WF1} "bpf test" in 1033 once`]);
    t.eq([P.labels.get(`${WF1}|name`), P.runs], [{ [EN]: 'bpf test', [FR]: 'Processus test' }, [EN, EN]]);
  });

  dialog('a process that could not be updated: saved, and the dialog says the page may show the old process name; nothing refreshes by itself', async (r, d) => {
    const P = processes(t, r);
    P.fail = 1;
    r.store.set(P.name(WF1).key, FR, 'Processus FR');
    d.open();
    d.click('Publish');
    await d.until('the result', () => d.actions().includes('Close'));
    t.eq([d.title(), d.actions(), d.refreshed, r.store.pendingCount()], ['Published', ['Refresh anyway', 'Close'], 0, 0]);
    t.ok(d.text().includes('Saved; the page may show the old process name until the process is updated.'), d.text());
    t.eq([P.updates().length, P.labels.get(`${WF1}|name`)], [1, { [EN]: 'bpf test', [FR]: 'Processus FR' }], 'never sent again; the save stays');
  });

  dialog('a row whose server text a reload changed under the edit says so; publishing it is a conflict, nothing overwritten', async (r, d) => {
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    const other = r.add('attribute', 'attribute|acc.city|DisplayName', { [EN]: 'City', [FR]: 'Ville' }).key;
    r.store.set(k, FR, 'Nom 2');
    r.store.set(other, FR, 'Cité');
    // Another maker saved, and a reload brought their text under the staged edit.
    r.server.set(`${k}#${FR}`, 'Nom (par Marie)');
    r.store.add([{ ...r.store.get(k)!, labels: { [EN]: 'Name', [FR]: 'Nom (par Marie)' } }]);
    d.open();
    const line = 'Changed on the server since you edited it';
    t.eq(d.text().split(line).length - 1, 1, `one row flagged: ${d.text()}`);
    d.click('Publish');
    await d.until('the problems', () => d.actions().includes('Close'));
    t.eq([r.server.get(`${k}#${FR}`), r.server.get(`${other}#${FR}`)], ['Nom (par Marie)', 'Cité'], 'their text kept, the other row published');
    t.ok(d.text().includes('Someone changed this on the server after you loaded it'), d.text());
  });

  dialog('a blocked row: the others are published, never an automatic refresh; Refresh anyway', async (r, d) => {
    const ok = r.add('attribute', 'attribute|acc.city|DisplayName', { [EN]: 'City', [FR]: 'Ville' }).key;
    const long = r.add('attribute', 'attribute|acc.code|DisplayName', { [EN]: 'Code', [FR]: 'Code' }, { max: 5 }).key;
    r.store.set(ok, FR, 'Cité');
    r.store.set(long, FR, 'Beaucoup trop long');
    d.open();
    t.ok(d.text().includes('Too long (max 5)'), d.text());
    d.click('Publish');
    await d.until('the problems', () => d.actions().includes('Close'));
    t.eq([d.title(), d.actions(), d.refreshed, r.posts.length], ["Some changes weren't published", ['Refresh anyway', 'Close'], 0, 1]);
    t.eq(r.store.changes().map(changeId), [`${long}#${FR}`], 'it stays staged');
    d.click('Refresh anyway');
    t.eq(d.refreshed, 1);
  });

  dialog("an emptied translation Dataverse can't remove shows the text it writes in its place, with a quiet note why; after publishing, its row follows that text", async (r, d) => {
    const col = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Account Name', [FR]: 'Nom' }).key;
    const cell = r.add('field', 'field|f1|c1|Label', { [EN]: 'Customer', [FR]: 'Client' }, { path: ['Account', 'Main form', 'General'], ref: { formId: 'f1', datafield: 'name', controlId: 'name' } }).key;
    r.versions.set('f1', [3, 3]);
    r.store.set(col, FR, '');
    r.store.set(cell, FR, '');
    r.failOnce.add(`${cell}#${FR}`);
    const rows = () => d.dlg().querySelectorAll('.pd-r').map((x) => [x.querySelector('.wd')!.textContent, ...x.querySelectorAll('.iss').map((i) => i.textContent)].join(' | '));
    d.open();
    t.eq(rows(), [
      "Nom→Account Name | English text: Dataverse can't remove a translation",
      // Its column's French name is emptied in the same save: the column's English name.
      "Client→Account Name | The column's English name: Dataverse can't remove a translation",
    ]);
    t.eq(d.title(), 'Publish 2 changes', 'both are published, none blocked');
    d.click('Publish');
    await d.until('the problems', () => d.actions().includes('Try again'));
    t.eq(r.server.get(`${col}#${FR}`), 'Account Name', 'the stand-in written');
    // The column's French name is now its English text, so the form label gets that (the page looks the same).
    t.eq(rows(), ["Client→Account Name | Could not reach Dataverse. | The column's French name: Dataverse can't remove a translation"]);
    d.click('Try again');
    await d.until('refreshed', () => d.refreshed > 0);
    t.eq([r.server.get(`${cell}#${FR}`), r.store.pendingCount()], ['Account Name', 0]);
    t.eq(readHistory(r.app.ctx).map((e) => e.items.map((it) => it.after)), [['Account Name'], ['Account Name']], 'journaled as written');
  });

  dialog("an emptied translation already worded as its stand-in says that nothing changes; publishing writes and publishes nothing for it, and drops the edit", async (r, d) => {
    const k = r.add('attribute', 'attribute|acc.desc|DisplayName', { [EN]: 'Description', [FR]: 'Description' }).key;
    r.store.set(k, FR, '');
    const notes = () => d.dlg().querySelectorAll('.pd-r').map((x) => x.querySelectorAll('.iss').map((i) => i.textContent).join(' | '));
    d.open();
    t.eq(notes(), ['Already the English text: nothing changes']);
    d.click('Publish');
    await d.until('done', () => d.refreshed > 0 || d.title() === 'Published');
    t.eq([r.writes.length, r.posts.length, r.store.pendingCount(), readHistory(r.app.ctx).length], [0, 0, 0, 0]);
  });

  dialog('a failed publish: saved, not published, no refresh; Publish again publishes, then refreshes', async (r, d) => {
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    r.store.set(k, FR, 'Nom 2');
    r.publishFails = 1;
    d.open();
    d.click('Publish');
    await d.until('Publish again', () => d.actions().includes('Publish again'));
    t.eq([d.title(), d.actions(), d.refreshed], ['Saved, but not published', ['Publish again', 'Close'], 0], 'nothing was published: no Refresh anyway');
    t.ok(d.text().includes('Saved, but publishing failed: The publish failed on the server.'), d.text());
    t.eq(readHistory(r.app.ctx)[0].published, false);
    d.click('Publish again');
    await d.until('refreshed', () => d.refreshed > 0);
    t.eq([r.posts.length, readHistory(r.app.ctx)[0].published], [1, true]);
  });

  dialog("forms still unpublished after publishing: no refresh, journaled as not published; Close says so; Recent publishes › Publish publishes them", async (r, d) => {
    const f = r.add('field', 'field|f1|c1|Label', { [EN]: 'Client', [FR]: 'Client' }, { path: ['Account', 'Main form'], ref: { formId: 'f1' } }).key;
    r.store.set(f, FR, 'Client FR');
    r.versions.set('f1', [10, 12]); // PublishXml did not take: the unpublished version stays newer
    d.open();
    d.click('Publish');
    await d.until('the check', () => d.actions().includes('Close'));
    t.eq([d.title(), d.actions(), d.refreshed], ['Saved, but not published', ['Publish again', 'Refresh anyway', 'Close'], 0]);
    t.ok(d.text().includes('Main form still has unpublished changes.'), d.text());
    t.eq(readHistory(r.app.ctx)[0].published, false, 'Recent publishes shows it as not published');
    d.click('Close');
    await d.closed;
    t.eq(d.toasts, ['Your translations are saved, but not published yet. Publish them from Recent publishes.']);
    // Later, from Recent publishes: its row offers Publish.
    r.versions.set('f1', [13, 13]);
    openHistory(r.app);
    t.ok(d.text().includes('Not published'), d.text());
    d.click('Publish');
    await d.until('published', () => d.title() === 'Published');
    t.eq([r.posts.length, readHistory(r.app.ctx)[0].published, d.actions()], [2, true, ['Refresh page', 'Close']]);
  });

  dialog('Undo keeps the list where it was and the focus on the row now in its place; a double-click undoes one', async (r, d) => {
    const ks = ['a', 'b', 'c'].map((x) => r.add('attribute', `attribute|acc.${x}|DisplayName`, { [EN]: x, [FR]: x }).key);
    for (const k of ks) r.store.set(k, FR, 'new');
    d.open();
    const undos = () => d.dlg().querySelectorAll('[data-u]');
    d.dlg().querySelector('.dlg-body')!.scrollTop = 120;
    fire(undos()[0], 'click', { detail: 1 });
    t.eq([undos().length, d.dlg().querySelector('.dlg-body')!.scrollTop, d.title()], [2, 120, 'Publish 2 changes']);
    t.ok(dom.root.activeElement === undos()[0], 'the focus is on the Undo now in that place');
    fire(undos()[0], 'click', { detail: 2 }); // the second click of the double-click
    t.eq([undos().length, r.store.changes().map((c) => c.slot.key)], [2, ks.slice(1)]);
  });

  dialog("Recent publishes › Undo › Try again sends only the labels not undone yet; the publish is then undone: a translation it added that Dataverse can't remove gets its stand-in, one with none is kept and counted", async (r, d) => {
    // c had no French: Dataverse can't remove the translation the publish added, so the undo writes its English text.
    // t had no French either, and has no English text to stand in for it (a column with no English name): kept. (A
    // tooltip there is saved empty instead: its users saw no text before, core/saver.ts withStandIns.)
    const [a, b, c] = ['a', 'b', 'c'].map((x) => r.add('attribute', `attribute|acc.${x}|DisplayName`, x === 'c' ? { [EN]: x } : { [EN]: x, [FR]: x }).key);
    const tip = r.add('attribute', 'attribute|acc.t|DisplayName', {}).key;
    for (const k of [a, b, c, tip]) r.store.set(k, FR, 'new');
    await r.publish();
    const [e] = readHistory(r.app.ctx);
    const sent: string[][] = [];
    const undo = r.app.saver.undo;
    r.app.saver.undo = (x, o) => (sent.push(x.items.map((i) => i.key)), undo(x, o));
    r.failOnce.add(`${b}#${FR}`);
    openHistory(r.app);
    d.click('Undo');
    fire(await d.undoReady(), 'click', { detail: 1 });
    await d.until('the problems', () => d.actions().includes('Try again'));
    t.eq(d.title(), 'Undone with problems');
    d.click('Try again');
    await d.until('undone', () => d.title() === 'Publish undone');
    t.eq(sent, [[a, b, c, tip], [b]], 'Try again sends only b: a is back, c has its English text, t is kept');
    const done = readHistory(r.app.ctx).find((x) => x.id === e.id)!;
    t.eq([!!done.undoneAt, done.kept], [true, 1]);
    t.eq([a, b, c, tip].map((k) => r.server.get(`${k}#${FR}`)), ['a', 'b', 'c', 'new']);
  });

  dialog('the same edit of 3 copies of a field is one entry with one Undo, counted as 3 changes from the title to Done', async (r, d) => {
    const ks = ['General', 'Memo', 'CCM'].map(
      (tab, i) =>
        r.add('field', `field|f1|c${i}|Label`, { [EN]: 'Service request title', [FR]: 'Titre' }, { path: ['Service request', 'Main form', tab], ref: { formId: 'f1', datafield: 'contoso_title', elId: `c${i}` } }).key,
    );
    for (const k of ks) r.store.set(k, FR, 'Titre de la demande');
    r.versions.set('f1', [10, 10]);
    d.view = 'workbench';
    d.open();
    t.eq([d.title(), d.dlg().querySelectorAll('[data-u]').length, r.store.pendingCount()], ['Publish 3 changes', 1, 3], 'the same number as the bar');
    t.ok(d.text().includes('3 places (General, Memo, CCM)'), d.text());
    await tick(); // the check of others' work has answered
    d.click('Publish');
    t.eq(d.title(), 'Publishing 3 changes');
    await d.until('done', () => d.actions().includes('Close'));
    t.ok(d.text().includes('Done. Published 3 changes.'), d.text());
  });

  dialog('in the Workbench: Done with Refresh page and Close, never an automatic refresh', async (r, d) => {
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    r.store.set(k, FR, 'Nom 2');
    d.view = 'workbench';
    d.open();
    t.ok(!d.text().includes('refreshes'), d.text());
    d.click('Publish');
    await d.until('done', () => d.actions().includes('Close'));
    t.eq([d.title(), d.actions(), d.refreshed], ['Published', ['Refresh page', 'Close'], 0]);
    t.ok(d.text().includes('Done. Published 1 change.'), d.text());
  });

  dialog('in the Workbench, Done tells a label found already on the server apart: not published as this publish, nor undone with it', async (r, d) => {
    const a = r.add('attribute', 'attribute|acc.a|DisplayName', { [EN]: 'A', [FR]: 'Ancien' }).key;
    const b = r.add('attribute', 'attribute|acc.b|DisplayName', { [EN]: 'B', [FR]: 'B fr' }).key;
    r.store.set(a, FR, 'Nouveau');
    r.store.set(b, FR, 'B 2');
    r.server.set(`${a}#${FR}`, 'Nouveau'); // another maker saved the same text first
    d.view = 'workbench';
    d.open();
    await tick();
    d.click('Publish');
    await d.until('done', () => d.actions().includes('Close'));
    t.ok(d.text().includes('Done. Published 1 change. 1 change was already on the server, so Undo of this publish leaves it alone.'), d.text());
  });

  dialog('in the Workbench, Done for a publish whose only label was found already on the server says nothing was written', async (r, d) => {
    const a = r.add('attribute', 'attribute|acc.a|DisplayName', { [EN]: 'A', [FR]: 'Ancien' }).key;
    r.store.set(a, FR, 'Nouveau');
    r.server.set(`${a}#${FR}`, 'Nouveau');
    d.view = 'workbench';
    d.open();
    await tick();
    d.click('Publish');
    await d.until('done', () => d.actions().includes('Close'));
    t.ok(d.text().includes('Done. 1 change was already on the server: nothing was written.'), d.text());
    t.eq(readHistory(r.app.ctx).length, 0);
  });

  dialog('the double-click that opened it does not close it again (the scrim appears under the pointer)', async (r, d) => {
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    r.store.set(k, FR, 'Nom 2');
    d.open();
    const dlg = d.dlg();
    const scrim = dlg.parentElement!;
    const at = (o: Partial<Ev>) => (fire(scrim, 'pointerdown', { target: scrim }), fire(scrim, 'click', { target: scrim, ...o }));
    at({ detail: 2 });
    at({ detail: 1 }); // right after opening (the click after Ctrl+S)
    t.ok(dlg.isConnected, 'still open');
    await tick(320);
    at({ detail: 2 });
    t.ok(dlg.isConnected, 'a second click never closes it');
    at({ detail: 1 });
    t.ok(!dlg.isConnected, 'a click on the scrim closes it');
    t.eq(await d.closed, undefined);
  });

  // ---- what publishing also publishes, the saver's warnings, the forms check ----

  /** The others'-work check of the Publish dialog: each call waits until the test answers it (ok / no). */
  const held = (r: Rig) => {
    type Work = Awaited<ReturnType<AppApi['saver']['pendingWork']>>;
    const calls: Array<{ signal?: AbortSignal; ok: (w: Work) => void; no: (e: unknown) => void }> = [];
    r.app.saver.pendingWork = (_cs, signal) => new Promise<Work>((ok, no) => void calls.push({ signal, ok, no }));
    return calls;
  };
  /** The dialog's one sentence about what else publishing publishes ('' when hidden or absent). */
  const othersLine = (d: Dlg) => {
    const p = d.dlg().querySelector('.pd-o');
    return p && !p.hidden ? p.textContent : '';
  };

  dialog("Publish waits for the check of others' unpublished work: a click before it answers publishes once it finds nothing; what it finds is said first, and the next click publishes", async (r, d) => {
    r.add('entity', 'entity|acc|DisplayName', { [EN]: 'Account' }, { title: 'Account' });
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    r.store.set(k, FR, 'Nom 2');
    const calls = held(r);
    d.open();
    d.click('Publish');
    d.click('Publish'); // a second click (or Ctrl+Enter) while it checks
    await tick();
    t.eq([r.writes.length, d.title(), d.actions(), calls.length], [0, 'Publish 1 change', ['Cancel', 'Publish'], 1], 'nothing written while the check runs');
    t.eq([othersLine(d), calls[0].signal?.aborted], ['Checking for other unpublished changes…', false], 'it says so, and the check goes on');
    calls[0].ok([{ entity: 'acc', items: [{ kind: 'form', name: 'Sales form (draft)' }] }]);
    await tick();
    t.eq([r.writes.length, d.title(), othersLine(d)], [0, 'Publish 1 change', 'Publishing Account also publishes 1 other unpublished change on it.'], 'what it found is said first');
    d.click('Publish');
    await d.until('refreshed', () => d.refreshed > 0);
    t.eq([r.writes.length, r.posts.length], [1, 1]);
  });

  dialog('Publish clicked before the check of others\' work answers goes on by itself once it finds nothing', async (r, d) => {
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    r.store.set(k, FR, 'Nom 2');
    const calls = held(r);
    d.open();
    d.click('Publish');
    await tick();
    t.eq(r.writes.length, 0);
    calls[0].ok([]);
    await d.until('refreshed', () => d.refreshed > 0);
    t.eq([r.writes.length, r.posts.length, calls.length], [1, 1, 1]);
  });

  dialog("a check of others' work that fails says it couldn't check (never nothing), and Publish then publishes", async (r, d) => {
    r.add('entity', 'entity|acc|DisplayName', { [EN]: 'Account' }, { title: 'Account' });
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    r.store.set(k, FR, 'Nom 2');
    const http = r.app.ctx.http as unknown as { all: (url: string) => Promise<unknown[]> };
    const all = http.all;
    http.all = async (url) => {
      if (url.startsWith('savedqueries')) throw new DvError('Rate limit exceeded.', 429);
      return all(url);
    };
    d.open();
    await tick();
    t.eq(othersLine(d), "Couldn't check Account for other unpublished changes: publishing it also publishes any there are.");
    d.click('Publish');
    await d.until('refreshed', () => d.refreshed > 0);
    t.eq(r.posts.length, 1);
  });

  dialog('a form being translated that already holds unpublished work (it goes live with the translation) is named by the check', async (r, d) => {
    r.add('entity', 'entity|acc|DisplayName', { [EN]: 'Account' }, { title: 'Account' });
    const F1 = '1d2c3b4a-0000-0000-0000-000000000001';
    const k = r.add('field', `field|${F1}|c1|Label`, { [EN]: 'Client', [FR]: 'Client' }, { group: `form|${F1}`, path: ['Account', 'Main form'], ref: { formId: F1 } }).key;
    r.store.set(k, FR, 'Client FR');
    // A maker rearranged this very form and did not publish it.
    const http = r.app.ctx.http as unknown as { all: (url: string) => Promise<unknown[]> };
    http.all = async (url) => (url.startsWith('systemforms') && url.includes("objecttypecode eq 'acc'") ? [{ formid: F1, name: 'Main form', objecttypecode: 'acc' }] : []);
    d.open();
    await tick();
    t.eq(othersLine(d), 'Publishing Account also publishes 1 other unpublished change on it.');
  });

  dialog("the whole publish scope, with what the translator can't check, is said next to Publish from the start (never another click when the check finds nothing), in the Undo question, and in Recent publishes › Publish's question", async (r, d) => {
    r.add('entity', 'entity|acc|DisplayName', { [EN]: 'Account' }, { title: 'Account' });
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    r.store.set(k, FR, 'Nom 2');
    const SCOPE = 'Publishing also publishes anything else not yet published on: Account (table); the translator can only check its forms, views and charts.';
    const scope = () => d.dlg().querySelector('.pd-sc')?.textContent ?? '';
    const calls = held(r);
    d.open();
    t.eq([scope(), othersLine(d)], [SCOPE, ''], 'said before the check answers, apart from its sentence');
    d.click('Publish');
    await tick();
    t.eq([r.writes.length, othersLine(d), scope()], [0, 'Checking for other unpublished changes…', SCOPE]);
    calls[0].ok([]);
    await d.until('refreshed', () => d.refreshed > 0);
    t.eq(r.writes.length, 1, 'no second click: the scope was on screen before the first');
    // Undo: in its question, from the start.
    openHistory(r.app);
    d.click('Undo');
    await d.until('the question', () => d.title() === 'Undo this publish?');
    t.ok(d.text().includes(SCOPE), d.text());
    calls[1].ok([]);
    d.click('Cancel');
    d.click('Close');
    // Recent publishes › Publish asks when the check finds something: the scope is in its question too.
    r.store.set(k, FR, 'Nom 3');
    r.publishFails = 1;
    await r.publish();
    r.work.set('acc', ['Sales form (draft)']);
    r.app.saver.pendingWork = async () => [{ entity: 'acc', items: [{ kind: 'form', name: 'Sales form (draft)' }] }];
    openHistory(r.app);
    d.click('Publish');
    await d.until('the question', () => d.title() === 'Publish this save?');
    t.ok(d.text().includes('Publishing Account also publishes 1 other unpublished change on it.') && d.text().includes(SCOPE), d.text());
  });

  dialog("Recent publishes › Publish says what else it publishes first (others' work found, or a check that failed); with nothing to say it publishes at once", async (r, d) => {
    r.add('entity', 'entity|acc|DisplayName', { [EN]: 'Account' }, { title: 'Account' });
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    r.store.set(k, FR, 'Nom 2');
    r.publishFails = 1;
    await r.publish();
    r.work.set('acc', ['Sales form (draft)']);
    openHistory(r.app);
    d.click('Publish');
    await d.until('the question', () => d.title() === 'Publish this save?');
    t.ok(d.text().includes('Publishing Account also publishes 1 other unpublished change on it.'), d.text());
    t.eq(r.posts.length, 0, 'nothing published before the answer');
    d.click('Cancel');
    t.eq([r.posts.length, readHistory(r.app.ctx)[0].published], [0, false]);
    d.click('Publish');
    await d.until('the question', () => d.title() === 'Publish this save?');
    d.click('Publish');
    await d.until('published', () => d.title() === 'Published');
    t.eq([r.posts.length, readHistory(r.app.ctx)[0].published], [1, true]);
  });

  dialog("Recent publishes › Publish: the form the save itself left unpublished is not someone else's work (it publishes at once); once published, a draft on it is said before Undo", async (r, d) => {
    r.add('entity', 'entity|acc|DisplayName', { [EN]: 'Account' }, { title: 'Account' });
    const F1 = '1d2c3b4a-0000-0000-0000-000000000001';
    const k = r.add('field', `field|${F1}|c1|Label`, { [EN]: 'Client', [FR]: 'Client' }, { group: `form|${F1}`, path: ['Account', 'Main form'], ref: { formId: F1 } }).key;
    r.store.set(k, FR, 'Client FR');
    r.publishFails = 1;
    await r.publish();
    t.eq(readHistory(r.app.ctx)[0].published, false);
    // Saved, not published: its form is now an unpublished form of the table, as Dataverse lists it.
    const http = r.app.ctx.http as unknown as { all: (url: string) => Promise<unknown[]> };
    http.all = async (url) => (url.startsWith('systemforms') && url.includes("objecttypecode eq 'acc'") ? [{ formid: F1, name: 'Main form', objecttypecode: 'acc' }] : []);
    r.versions.set(F1, [13, 13]);
    openHistory(r.app);
    d.click('Publish');
    await d.until('published', () => d.title() === 'Published' || d.title() === 'Publish this save?');
    t.eq([d.title(), r.posts.length, readHistory(r.app.ctx)[0].published], ['Published', 1, true], d.text());
    // Published now: an unpublished version of that form is someone else's draft, which an Undo would publish too.
    d.click('Close');
    openHistory(r.app);
    d.click('Undo');
    await d.undoReady();
    t.ok(d.text().includes('Publishing Account also publishes 1 other unpublished change on it.'), d.text());
  });

  dialog("Recent publishes › Undo: a check of others' work that fails says it couldn't check", async (r, d) => {
    r.add('entity', 'entity|acc|DisplayName', { [EN]: 'Account' }, { title: 'Account' });
    const k = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }).key;
    r.store.set(k, FR, 'Nom 2');
    await r.publish();
    (r.app.ctx.http as unknown as { all: () => Promise<never> }).all = async () => {
      throw new DvError('Could not reach Dataverse (network error).', 0, 'network');
    };
    openHistory(r.app);
    d.click('Undo');
    await d.undoReady();
    t.ok(d.text().includes("Couldn't check Account for other unpublished changes: publishing it also publishes any there are."), d.text());
  });

  dialog("the saver's warnings show on their rows (placeholders, a global choice's other columns); notes about how labels are saved show once", async (r, d) => {
    const g = r.add('globaloption', 'globaloption|cr_greet|1|Label', { [EN]: 'Hello {0}', [FR]: 'Bonjour {0}' }, {
      title: 'Hello {0}',
      path: ['Choice', 'Greeting'],
      ref: { name: 'cr_greet', value: 1, usedBy: ['acc.a', 'acc.b', 'con.c'], managed: false },
    }).key;
    const a = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }, { ref: { managed: false } }).key;
    const long = r.add('attribute', 'attribute|acc.code|DisplayName', { [EN]: 'Code', [FR]: 'Code' }, { max: 5, ref: { managed: false } }).key;
    const same = r.add('attribute', 'attribute|acc.total|DisplayName', { [EN]: 'Total' }, { ref: { managed: false } }).key;
    r.store.set(g, FR, 'Bonjour');
    r.store.set(a, FR, 'Nom 2');
    r.store.set(long, FR, 'Beaucoup trop long');
    r.store.set(same, FR, 'Total');
    d.open();
    const text = d.text();
    for (const w of ["Placeholders like {0} don't match: 0 here, 1 in the English text.", 'Global choice: this changes all 3 columns that use it.'])
      t.eq(text.split(w).length - 1, 1, `${w} in: ${text}`);
    // A managed solution's components are never saved (read-only), so no note says how they would be.
    t.ok(!/unmanaged/i.test(text), text);
    // A translation worded like the English text is not flagged: many labels read the same in both languages.
    t.ok(!/same as the english|not translated/i.test(text), text);
    t.eq(r.app.saver.validate(r.store.changes().filter((c) => c.slot.key === same)), [], 'no issue for a translation equal to the English text');
    const warned = d.dlg().querySelectorAll('.pd-r').filter((x) => x.querySelector('.iss.warn'));
    t.eq(warned.length, 1, 'only the global choice row: the blocked one shows its error only, the one worded like English nothing');
    t.ok(text.includes('Too long (max 5)'), text);
    // They follow the list: undone, its warnings go; a removal and two tab labels saved in a switched language.
    fire(warned[0].querySelector('[data-u]')!, 'click', { detail: 1 });
    t.ok(!d.text().includes('Global choice:'), d.text());
    const nav = r.add('subarea', 'subarea|sm1|accounts|Title', { [EN]: 'Accounts', [FR]: 'Comptes' }).key;
    const tabs = ['t1', 't2'].map((x) => r.add('tab', `tab|f1|${x}|Label`, { [EN]: 'General', [FR]: 'Général' }, { path: ['Account', 'Main form'] }).key);
    r.store.set(nav, FR, '');
    for (const k of tabs) r.store.set(k, FR, 'Général 2');
    d.click('Cancel');
    d.open();
    const now = d.text();
    t.ok(now.includes('Removes the French translation; French users will see the English text.'), now);
    t.eq(now.split('Saving French tab and section labels briefly switches your Dynamics language to French.').length - 1, 1, `said once: ${now}`);
  });

  dialog('a form the check after publishing could not read: not called published, no refresh, journaled as not published; Publish again publishes and checks again', async (r, d) => {
    const k = r.add('field', 'field|f1|c1|Label', { [EN]: 'Client', [FR]: 'Client' }, { path: ['Account', 'Main form'], ref: { formId: 'f1' } }).key;
    r.store.set(k, FR, 'Client FR');
    // No versions for f1: both reads of the check fail.
    d.open();
    d.click('Publish');
    await d.until('the result', () => d.actions().includes('Close'));
    t.eq([d.title(), d.actions(), d.refreshed, r.posts.length], ['Published, but not checked', ['Publish again', 'Refresh anyway', 'Close'], 0, 1]);
    t.ok(d.text().includes("Couldn't check whether Main form is published. Publish again to publish it and check again."), d.text());
    t.eq(readHistory(r.app.ctx)[0].published, false, 'Recent publishes keeps Publish for it');
    r.versions.set('f1', [13, 13]);
    d.click('Publish again');
    await d.until('refreshed', () => d.refreshed > 0);
    t.eq([r.posts.length, readHistory(r.app.ctx)[0].published], [2, true]);
  });

  dialog('Recent publishes › Publish: a form the check could not read is not called published; Try again checks again', async (r, d) => {
    const k = r.add('field', 'field|f1|c1|Label', { [EN]: 'Client', [FR]: 'Client' }, { path: ['Account', 'Main form'], ref: { formId: 'f1' } }).key;
    r.store.set(k, FR, 'Client FR');
    r.publishFails = 1;
    await r.publish();
    openHistory(r.app);
    d.click('Publish');
    await d.until('the result', () => d.title() !== 'Recent publishes' && d.actions().includes('Close'));
    t.eq([d.title(), d.actions(), r.posts.length, readHistory(r.app.ctx)[0].published], ['Published, but not checked', ['Try again', 'Close'], 1, false]);
    t.ok(d.text().includes("Couldn't check whether Main form is published."), d.text());
    r.versions.set('f1', [13, 13]);
    d.click('Try again');
    await d.until('published', () => d.title() === 'Published');
    t.eq([r.posts.length, readHistory(r.app.ctx)[0].published], [2, true]);
  });

  dialog("the full editor's Review and publish closes the editor, then opens the Publish dialog", async (r, d) => {
    const s = r.add('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' });
    r.store.set(s.key, FR, 'Nom 2');
    Object.assign(r.app, { root: dom.root, prefs: { target: FR, shown: [EN, FR] } });
    const asked: boolean[] = [];
    // app.review() opens nothing while a dialog is open (app.ts): what it would see.
    r.app.review = async () => (asked.push(modalOpen()), undefined);
    // As app.ts fullEditor(): the card in a dialog of its own.
    // What the card and the menu test besides the popup's fake DOM.
    const g = globalThis as { HTMLTextAreaElement?: unknown; Element?: unknown };
    g.HTMLTextAreaElement = class {};
    g.Element = FEl;
    try {
      let close: (() => void) | undefined;
      const ed = createEditor(r.app, s.comp, { onClose: () => close?.() });
      void modal('Edit translations', (c) => ((close = c), ed.el as unknown as Node));
      fire(d.dlg().querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'More actions')!, 'click', { detail: 1 });
      const item = dom.layer.querySelectorAll('button').find((b) => b.textContent === 'Review and publish this component')!;
      fire(item, 'click', { detail: 1 });
      t.eq([asked, modalOpen()], [[false], false], 'the editor closed first');
      ed.destroy();
    } finally {
      delete g.HTMLTextAreaElement;
      delete g.Element;
    }
  });

  // ---- the real writers: never resend a write built from an earlier read; publish what may be unpublished ----

  const DE = 1031;
  const LOCK = 'Cannot start another [EntityCustomization] because there is a previous [Import] running at this moment. 0x80071151';
  const lab = (l: Record<number, string>) => ({ LocalizedLabels: Object.entries(l).map(([k, v]) => ({ Label: v, LanguageCode: Number(k) })) });
  const writeOpts = () => ({ signal: new AbortController().signal, publish: new PublishSet(), progress() {}, force: new Set<string>(), lang: null as never, allowPublish: true });

  t.test('save path: a metadata write turned away by the customization lock starts again from a new read, never resent as built before', () =>
    fast(async () => {
      const srv: Record<number, string> = { [EN]: 'Name', [FR]: 'Nom' };
      const puts: Array<{ body: any; once?: boolean }> = [];
      let lock = 1;
      let reads = 0;
      const view = () => ({ '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata', LogicalName: 'new_name', DisplayName: lab(srv), Description: lab({}), IsCustomizable: { Value: true }, IsRenameable: { Value: true } });
      const http = {
        get: async () => (reads++, view()),
        put: async (_u: string, body: any, o: { once?: boolean }) => {
          puts.push({ body, once: o.once });
          if (lock-- > 0) {
            srv[DE] = 'Name DE'; // the solution import holding the lock changed German
            throw new DvError(LOCK, 429);
          }
          for (const l of body.DisplayName.LocalizedLabels) srv[l.LanguageCode] = l.Label;
        },
        // The write batch's read right before the write (not counted): the server as it is.
        batch: (parts: never, o: never) => batchOf(http, view)(parts, o),
      };
      const ctx = { http, base: EN, user: FR, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] };
      const slot = { ...t.slot('attribute', 'attribute|acc.new_name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }), prop: 'DisplayName', entity: 'acc', ref: { entity: 'acc', attribute: 'new_name' } } as Slot;
      const w = metadataWriters.find((x) => x.kinds.includes('attribute'))!;
      const o = writeOpts();
      const res = await w.save(ctx as never, [{ slot, lcid: FR, before: 'Nom', after: 'Nom du compte' }], o);
      t.eq(res.map((x) => x.outcome), ['saved'], JSON.stringify(res));
      // German, which the translator did not know of, is read twice more before it goes back as read (someone else's).
      t.eq([puts.map((p) => p.once), reads], [[true, true], 5], 'a read before each write, 2 more for German, one to verify; Http never resent one');
      t.eq(toLabels(puts[1].body.DisplayName), { [EN]: 'Name', [FR]: 'Nom du compte', [DE]: 'Name DE' }, 'the second PUT carries German as read after the wait');
      t.eq(srv[DE], 'Name DE', 'their German kept');
      t.eq([...o.publish.entities], ['acc']);
      // Already as asked (a PUT whose answer was lost): nothing written, the table still published with the rest.
      const o2 = writeOpts();
      const res2 = await w.save(ctx as never, [{ slot, lcid: FR, before: 'Nom', after: 'Nom du compte' }], o2);
      t.eq([res2[0].outcome, [...o2.publish.entities], puts.length], ['unchanged', ['acc'], 2]);
    }),
  );

  t.test('save path: an Owner column is written with its AttributeType (Dataverse refuses it as a plain Lookup); other columns as before', () =>
    fast(async () => {
      const srv: Record<string, Record<number, string>> = { ownerid: { [EN]: 'Owner Id', [FR]: 'ID du propriétaire' }, new_name: { [EN]: 'Primary name' } };
      const types: Record<string, [string, string]> = { ownerid: ['LookupAttributeMetadata', 'Owner'], new_name: ['StringAttributeMetadata', 'String'] };
      const puts: any[] = [];
      const col = (u: string) => /LogicalName='(\w+)'\)\??[^/]*$/.exec(u)![1];
      const http = {
        get: async (u: string) => {
          const a = col(u);
          const [type, at] = types[a];
          return { '@odata.type': '#Microsoft.Dynamics.CRM.' + type, LogicalName: a, AttributeType: at, AttributeTypeName: { Value: at + 'Type' }, DisplayName: lab({ [EN]: a }), Description: lab(srv[a]), IsCustomizable: { Value: true }, IsRenameable: { Value: true } };
        },
        put: async (u: string, body: any) => {
          puts.push(body);
          const a = col(u);
          // Live (finding 59): 400 0x80041a06, nothing written.
          if (a === 'ownerid' && body.AttributeType !== 'Owner') throw new DvError('Attribute ownerid is a Owner, but a Lookup type was specified.', 400);
          for (const l of body.Description.LocalizedLabels) srv[a][l.LanguageCode] = l.Label;
        },
        batch: (parts: never, o: never) => batchOf(http)(parts, o),
      };
      const ctx = { http, base: EN, user: FR, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] };
      const w = metadataWriters.find((x) => x.kinds.includes('attribute'))!;
      const change = (a: string, before: string, after: string): Change => ({
        slot: { ...t.slot('attribute', `attribute|acc.${a}|Description`, srv[a]), prop: 'Description', entity: 'acc', ref: { entity: 'acc', attribute: a, odataType: 'Microsoft.Dynamics.CRM.' + types[a][0] } } as Slot,
        lcid: FR,
        before,
        after,
      });
      const res = await w.save(ctx as never, [change('ownerid', 'ID du propriétaire', 'Infobulle')], writeOpts());
      t.eq([res.map((x) => x.outcome), srv.ownerid], [['saved'], { [EN]: 'Owner Id', [FR]: 'Infobulle' }], JSON.stringify(res));
      t.eq([puts[0].AttributeType, puts[0].AttributeTypeName], ['Owner', { Value: 'OwnerType' }]);
      const res2 = await w.save(ctx as never, [change('new_name', '', 'Nom principal')], writeOpts());
      t.eq(res2.map((x) => x.outcome), ['saved'], JSON.stringify(res2));
      t.eq(Object.keys(puts[1]).sort(), ['@odata.type', 'Description', 'LogicalName'], 'a String column is sent as before');
    }),
  );

  t.test('save path: a metadata write that still reads as before is read again for a while (a lagging read is saved, no second write), then written once more; a text someone else changed meanwhile is a conflict', () =>
    fast(async () => {
      const mk = (ignore: number, lag = 0) => {
        const srv = { dn: { [EN]: 'Task status', [FR]: 'Statut' } as Record<number, string>, desc: { [EN]: 'The status', [FR]: "L'état" } as Record<number, string> };
        const puts: any[] = [];
        let reads = 0;
        // `lag` reads after each applied write still answer with the text from before it (a metadata cache catching up).
        let stale: typeof srv | null = null;
        let left = 0;
        const snap = () => ({ dn: { ...srv.dn }, desc: { ...srv.desc } });
        const view = (v = srv) => ({ '@odata.type': '#Microsoft.Dynamics.CRM.PicklistAttributeMetadata', LogicalName: 'contoso_taskstatus', DisplayName: lab(v.dn), Description: lab(v.desc), IsCustomizable: { Value: true }, IsRenameable: { Value: true } });
        const http = {
          get: async () => {
            reads++;
            return view(left-- > 0 && stale ? stale : srv);
          },
          batch: (parts: never, o: never) => batchOf(http, () => view())(parts, o),
          put: async (_u: string, body: any) => {
            puts.push(body);
            if (ignore-- > 0) return; // 204, nothing applied
            stale = snap();
            left = lag;
            for (const l of body.DisplayName?.LocalizedLabels || []) srv.dn[l.LanguageCode] = l.Label;
            for (const l of body.Description?.LocalizedLabels || []) srv.desc[l.LanguageCode] = l.Label;
          },
        };
        const ctx = { http, base: EN, user: FR, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] };
        const sl = (prop: string, l: Record<number, string>) => ({ ...t.slot('attribute', `attribute|t.contoso_taskstatus|${prop}`, l), prop, entity: 't', ref: { entity: 't', attribute: 'contoso_taskstatus' } }) as Slot;
        const dn = sl('DisplayName', { [EN]: 'Task status', [FR]: 'Statut' });
        const ds = sl('Description', { [EN]: 'The status', [FR]: "L'état" });
        const cs = [
          { slot: dn, lcid: EN, before: 'Task status', after: 'Task statuss' },
          { slot: dn, lcid: FR, before: 'Statut', after: 'Statuts' },
          { slot: ds, lcid: EN, before: 'The status', after: 'The statuss' },
        ];
        return { srv, puts, reads: () => reads, ctx, cs };
      };
      const w = metadataWriters.find((x) => x.kinds.includes('attribute'))!;
      // Applied, but the next 3 reads still answer with the old text (what the user's Edge saw): saved, one write.
      const d = mk(0, 3);
      const rd = await w.save(d.ctx as never, d.cs as never, writeOpts());
      t.eq(rd.map((x) => x.outcome), ['saved', 'saved', 'saved'], JSON.stringify(rd.map((x) => x.message)));
      t.eq([d.puts.length, d.reads()], [1, 5], 'read, write, verify (old), then old, old, new: never written twice');
      // Ignored once: still old after waiting, so written again from a new read, which keeps all three.
      const a = mk(1);
      const ra = await w.save(a.ctx as never, a.cs as never, writeOpts());
      t.eq(ra.map((x) => x.outcome), ['saved', 'saved', 'saved'], JSON.stringify(ra.map((x) => x.message)));
      t.eq([a.puts.length, a.reads()], [2, 8], 'read, write, verify, 4 reads while waiting; then read, write, verify');
      t.eq([a.srv.dn, a.srv.desc[EN]], [{ [EN]: 'Task statuss', [FR]: 'Statuts' }, 'The statuss']);
      // Ignored every time: two writes, each followed by the wait, then reported, saying so.
      const b = mk(9);
      const rb = await w.save(b.ctx as never, b.cs as never, writeOpts());
      t.eq([rb.map((x) => x.outcome), b.puts.length], [['error', 'error', 'error'], 2]);
      t.ok(/still shows the old English text "Task status", 15 seconds after writing it 2 times/.test(rb[0].message || ''), rb[0].message);
      // Ignored once, and another maker changed the French name while it waited: the new read finds French changed
      // under the edit (a conflict, their text kept); the rest is written.
      const c = mk(1);
      const get = c.ctx.http.get;
      c.ctx.http.get = async () => {
        if (c.reads() === 2) c.srv.dn[FR] = 'Statut (eux)';
        return get();
      };
      const rc = await w.save(c.ctx as never, c.cs as never, writeOpts());
      const by = (l: number, p: string) => rc.find((x) => x.change.lcid === l && x.change.slot.prop === p)?.outcome;
      t.eq([by(EN, 'DisplayName'), by(EN, 'Description'), by(FR, 'DisplayName')], ['saved', 'saved', 'conflict'], JSON.stringify(rc.map((x) => x.message)));
      t.eq([c.srv.dn, c.srv.desc[EN]], [{ [EN]: 'Task statuss', [FR]: 'Statut (eux)' }, 'The statuss'], 'their French kept');
    }),
  );

  t.test('save path: a conflict found at the read before writing is read again first: a lagging read of our own last save is not someone else', () =>
    fast(async () => {
      const srv: Record<number, string> = { [EN]: 'Task status', [FR]: 'Statuts' }; // our previous publish wrote Statuts
      let reads = 0;
      const puts: any[] = [];
      const view = (dn: Record<number, string>) => ({ '@odata.type': '#Microsoft.Dynamics.CRM.PicklistAttributeMetadata', LogicalName: 'x', DisplayName: lab(dn), Description: lab({}), IsCustomizable: { Value: true }, IsRenameable: { Value: true } });
      const http = {
        // The first read still answers with the text from before that publish.
        get: async () => view(reads++ === 0 ? { ...srv, [FR]: 'Statut' } : srv),
        batch: (parts: never, o: never) => batchOf(http, () => view(srv))(parts, o),
        put: async (_u: string, body: any) => {
          puts.push(body);
          for (const l of body.DisplayName.LocalizedLabels) srv[l.LanguageCode] = l.Label;
        },
      };
      const ctx = { http, base: EN, user: FR, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] };
      const slot = { ...t.slot('attribute', 'attribute|t.x|DisplayName', { [EN]: 'Task status', [FR]: 'Statuts' }), prop: 'DisplayName', entity: 't', ref: { entity: 't', attribute: 'x' } } as Slot;
      const w = metadataWriters.find((x) => x.kinds.includes('attribute'))!;
      const res = await w.save(ctx as never, [{ slot, lcid: FR, before: 'Statuts', after: 'Statut final' }], writeOpts());
      t.eq([res[0].outcome, puts.length, srv[FR]], ['saved', 1, 'Statut final'], JSON.stringify(res));
      // A real change by someone else stays a conflict after the reads again.
      srv[FR] = 'Statut (eux)';
      const res2 = await w.save(ctx as never, [{ slot, lcid: FR, before: 'Statut final', after: 'Statut 2' }], writeOpts());
      t.eq([res2[0].outcome, puts.length, srv[FR]], ['conflict', 1, 'Statut (eux)']);
    }),
  );

  type ColSrv = { dn: Record<number, string>; desc: Record<number, string> };
  /**
   * A column whose server is `srv`; `put` applies a PUT body (the default: every language it carries). `st.stale`, when
   * set, answers the next `st.n` reads (1 unless set) instead of `srv` (a read lagging behind a write, as in the user's
   * Edge). Its slots hold a copy of the labels as loaded: a write changes only the server.
   */
  const column = (srv: ColSrv, put?: (body: any, n: number) => void) => {
    const puts: any[] = [];
    let reads = 0;
    const st = { stale: null as ColSrv | null, n: 1 };
    const view = (v: ColSrv) => ({ '@odata.type': '#Microsoft.Dynamics.CRM.PicklistAttributeMetadata', LogicalName: 'contoso_taskstatus', DisplayName: lab(v.dn), Description: lab(v.desc), IsCustomizable: { Value: true }, IsRenameable: { Value: true } });
    const http = {
      get: async () => {
        reads++;
        const v = st.stale ?? srv;
        if (st.stale && --st.n <= 0) Object.assign(st, { stale: null, n: 1 });
        return view(v);
      },
      batch: (parts: never, o: never) => batchOf(http, () => view(srv))(parts, o),
      put: async (_u: string, body: any) => {
        puts.push(body);
        if (put) return put(body, puts.length);
        for (const l of body.DisplayName?.LocalizedLabels || []) srv.dn[l.LanguageCode] = l.Label;
        for (const l of body.Description?.LocalizedLabels || []) srv.desc[l.LanguageCode] = l.Label;
      },
    };
    const ctx = { http, base: EN, user: FR, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] };
    const sl = (prop: string) => ({ ...t.slot('attribute', `attribute|t.contoso_taskstatus|${prop}`, { ...(prop === 'DisplayName' ? srv.dn : srv.desc) }), prop, entity: 't', ref: { entity: 't', attribute: 'contoso_taskstatus' } }) as Slot;
    return { http, ctx, puts, st, reads: () => reads, dn: sl('DisplayName'), ds: sl('Description'), w: metadataWriters.find((x) => x.kinds.includes('attribute'))! };
  };

  t.test('save path: when the second write of a change still old fails (lock, read), the changes the first write saved stay saved', () =>
    fast(async () => {
      for (const fail of ['lock', 'read'] as const) {
        const srv = { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: { [EN]: 'The status', [FR]: "L'état" } };
        const c = column(srv, (body, n) => {
          // Every write after the first: another maker's publish holds the customization lock.
          if (n > 1) throw new DvError(LOCK, 429);
          // The first write keeps everything but French.
          for (const l of body.DisplayName?.LocalizedLabels || []) if (l.LanguageCode !== FR) srv.dn[l.LanguageCode] = l.Label;
          for (const l of body.Description?.LocalizedLabels || []) srv.desc[l.LanguageCode] = l.Label;
        });
        if (fail === 'read') {
          // The read before the second write fails (after the read, the write and the check: the check shows the rest of that
          // write made, so the French is no read lagging behind it and is written again at once).
          const get = c.http.get;
          c.http.get = async () => {
            if (c.reads() === 2) throw new DvError('Server error', 500);
            return get();
          };
        }
        const cs = [
          { slot: c.dn, lcid: EN, before: 'Task status', after: 'Task statuss' },
          { slot: c.dn, lcid: FR, before: 'Statut', after: 'Statuts' },
          { slot: c.ds, lcid: EN, before: 'The status', after: 'The statuss' },
        ];
        const o = writeOpts();
        const res = await c.w.save(c.ctx as never, cs as never, o);
        const by = (l: number, p: string) => res.find((x) => x.change.lcid === l && x.change.slot.prop === p);
        t.eq([by(EN, 'DisplayName')?.outcome, by(EN, 'Description')?.outcome, by(FR, 'DisplayName')?.outcome, res.length], ['saved', 'saved', 'error', 3], `${fail}: ${JSON.stringify(res.map((x) => x.message))}`);
        // Worded around Try again (it publishes the change once Dataverse shows it), never "reload" nor "try Save again".
        t.eq(
          by(FR, 'DisplayName')?.message,
          `Dataverse accepted this change once but hasn't confirmed it yet, and checking again failed (${fail === 'read' ? 'Server error' : 'Dataverse was busy'}). Try again: it publishes the change once Dataverse shows it, or writes it again.`,
        );
        t.eq([c.puts.length, [...o.publish.entities]], [fail === 'lock' ? 6 : 1, ['t']], `${fail}: the first write, then 5 turned away by the lock; the table is published`);
      }
    }),
  );

  t.test('save path: a write confirmed only by a later read gets the same checks as one confirmed at once (another language, the other label)', () =>
    fast(async () => {
      const cases: Array<[string, (srv: ColSrv) => void, RegExp]> = [
        // The base-language trap (finding 2): the English name overwritten with the French text.
        ['base language', (srv) => (srv.dn[EN] = 'Statuts'), /^Saved, but Dataverse also changed the English text to "Statuts"/],
        ['other label', (srv) => (srv.desc[EN] = 'Changed'), /^Saved, but Dataverse also changed the English .*"Changed"/],
        ['nothing else', () => {}, /^$/],
      ];
      for (const [name, side, msg] of cases) {
        const srv: ColSrv = { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: { [EN]: 'The status' } };
        const c = column(srv, (body) => {
          // The read right after the write still answers with the text from before it (the user's Edge).
          c.st.stale = { dn: { ...srv.dn }, desc: { ...srv.desc } };
          for (const l of body.DisplayName.LocalizedLabels) srv.dn[l.LanguageCode] = l.Label;
          side(srv);
        });
        const res = await c.w.save(c.ctx as never, [{ slot: c.dn, lcid: FR, before: 'Statut', after: 'Statuts' }] as never, writeOpts());
        t.eq([res[0].outcome, c.puts.length, c.reads()], [name === 'nothing else' ? 'saved' : 'error', 1, 3], `${name}: read, write, verify (old), then the new text: ${res[0].message}`);
        t.ok(msg.test(res[0].message || ''), `${name}: ${res[0].message}`);
      }
    }),
  );

  t.test('save path: a text already as asked is read again first: an Undo right after its save, read from before that save, is still written', () =>
    fast(async () => {
      const srv = { dn: { [EN]: 'Task status', [FR]: 'Statut final' }, desc: {} }; // our save wrote "Statut final"
      const c = column(srv);
      // The first read still answers with the text from before that save: exactly what the Undo writes back.
      c.st.stale = { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: {} };
      const o = writeOpts();
      const res = await c.w.save(c.ctx as never, [{ slot: c.dn, lcid: FR, before: 'Statut final', after: 'Statut' }] as never, o);
      t.eq([res[0].outcome, c.puts.length, srv.dn[FR], c.reads(), [...o.publish.entities]], ['saved', 1, 'Statut', 3, ['t']], JSON.stringify(res));
      // Really already as asked: still nothing written after reading again twice.
      const res2 = await c.w.save(c.ctx as never, [{ slot: c.dn, lcid: FR, before: 'Statut final', after: 'Statut' }] as never, writeOpts());
      t.eq([res2[0].outcome, c.puts.length, c.reads()], ['unchanged', 1, 6]);
    }),
  );

  t.test('save path: Cancel while waiting to confirm a write stops the wait at once and says the change was accepted, not that it waited', () =>
    fast(async () => {
      const srv = { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: {} };
      const c = column(srv, () => {}); // 204, nothing applied: every read shows the old text
      const ac = new AbortController();
      const o = {
        ...writeOpts(),
        signal: ac.signal,
        progress: (m: string) => {
          if (/^Waiting for Dataverse/.test(m)) setTimeout(() => ac.abort(), 1); // during the first wait
        },
      };
      const res = await c.w.save(c.ctx as never, [{ slot: c.dn, lcid: FR, before: 'Statut', after: 'Statuts' }] as never, o);
      t.eq([res[0].outcome, c.puts.length, c.reads()], ['error', 1, 2], 'read, write, verify; no read after the cancelled wait');
      t.eq(res[0].message, 'Stopped before Dataverse confirmed it. Dataverse accepted the change: Try again publishes it once Dataverse shows it.');
    }),
  );

  t.test('save path: Cancel while a change is read again before its second write says the first write was accepted, never "Cancelled before saving"', () =>
    fast(async () => {
      const srv: ColSrv = { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: {} };
      const c = column(srv, () => {}); // 204, nothing applied: every read shows the old text
      const ac = new AbortController();
      let rounds = 0;
      const o = {
        ...writeOpts(),
        signal: ac.signal,
        progress: (m: string) => {
          if (/^Saving/.test(m) && ++rounds === 2) ac.abort(); // as the second round starts
        },
      };
      const res = await c.w.save(c.ctx as never, [{ slot: c.dn, lcid: FR, before: 'Statut', after: 'Statuts' }] as never, o);
      t.eq([res[0].outcome, c.puts.length, c.reads()], ['error', 1, 7], 'read, write, verify, 4 reads while waiting, the read before writing again');
      t.eq(res[0].message, 'Stopped before Dataverse confirmed it. Dataverse accepted the change: Try again publishes it once Dataverse shows it.');
    }),
  );

  t.test('save path: a new translation still not shown after waiting says there is no text yet (never the old text ""), and that it was accepted', () =>
    fast(async () => {
      const srv: ColSrv = { dn: { [EN]: 'Task status' }, desc: {} };
      const c = column(srv, () => {}); // 204, nothing applied
      const res = await c.w.save(c.ctx as never, [{ slot: c.dn, lcid: FR, before: '', after: 'Statut' }] as never, writeOpts());
      t.eq(
        [res[0].outcome, res[0].message, c.puts.length],
        ['error', "Dataverse still shows no French text, 15 seconds after writing it 2 times. Dataverse accepted the change but doesn't show it yet: try again in a minute.", 2],
      );
    }),
  );

  t.test('save path: a change a later read shows as written by its first write (the reads before lagged) is saved, with the checks of that write', () =>
    fast(async () => {
      for (const base of [false, true]) {
        const srv: ColSrv = { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: {} };
        let old: ColSrv | null = null;
        const c = column(srv, (body) => {
          old = { dn: { ...srv.dn }, desc: { ...srv.desc } };
          for (const l of body.DisplayName.LocalizedLabels) srv.dn[l.LanguageCode] = l.Label;
          if (base) srv.dn[EN] = 'Statuts'; // the base-language trap (finding 2)
        });
        // Reads 2 to 6 (the check after the write, the 4 while waiting) still answer with the text from before it.
        const get = c.http.get;
        c.http.get = async () => {
          if (old && c.reads() < 6) c.st.stale = old;
          return get();
        };
        const res = await c.w.save(c.ctx as never, [{ slot: c.dn, lcid: FR, before: 'Statut', after: 'Statuts' }] as never, writeOpts());
        t.eq([res[0].outcome, c.puts.length, c.reads()], [base ? 'error' : 'saved', 1, 9], `read 7 shows it written, read again twice; never written again: ${res[0].message}`);
        if (base) t.ok(/^Saved, but Dataverse also changed the English text to "Statuts"/.test(res[0].message || ''), res[0].message);
        else t.eq(res[0].message, undefined);
      }
    }),
  );

  t.test("save path: a read before writing that shows another language of the label from before a save just made is read again first, so that save stays; someone else's text goes back as read", () =>
    fast(async () => {
      // Our previous publish wrote the English "Task statuss" (the store knows it); the first read still shows the text before it.
      const srv: ColSrv = { dn: { [EN]: 'Task statuss', [FR]: 'Statut' }, desc: {} };
      const c = column(srv);
      c.st.stale = { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: {} };
      const res = await c.w.save(c.ctx as never, [{ slot: c.dn, lcid: FR, before: 'Statut', after: 'Statuts' }] as never, writeOpts());
      t.eq([res[0].outcome, c.puts.length, c.reads()], ['saved', 1, 3], JSON.stringify(res));
      t.eq([toLabels(c.puts[0].DisplayName), srv.dn], [{ [EN]: 'Task statuss', [FR]: 'Statuts' }, { [EN]: 'Task statuss', [FR]: 'Statuts' }], 'the English save kept');
      // English another maker changed since the load still reads so after reading again twice: written back as read.
      const srv2: ColSrv = { dn: { [EN]: 'Their status', [FR]: 'Statut' }, desc: {} };
      const c2 = column(srv2);
      const slot = { ...c2.dn, labels: { [EN]: 'Task status', [FR]: 'Statut' } };
      const res2 = await c2.w.save(c2.ctx as never, [{ slot, lcid: FR, before: 'Statut', after: 'Statuts' }] as never, writeOpts());
      t.eq([res2[0].outcome, c2.puts.length, c2.reads(), srv2.dn], ['saved', 1, 4, { [EN]: 'Their status', [FR]: 'Statuts' }]);
    }),
  );

  t.test('save path: a slot out of date (a language added since the load) costs the wait once: later saves of the label check against what this page saw saved', () =>
    fast(async () => {
      const srv: ColSrv = { dn: { [EN]: 'Status', [FR]: 'Statut', [DE]: 'Status DE' }, desc: {} };
      const c = column(srv);
      const slot = { ...c.dn, labels: { [EN]: 'Status', [FR]: 'Statut' } }; // loaded before German existed
      const reads: number[] = [];
      let before = 'Statut';
      for (const after of ['Statut 1', 'Statut 2', 'Statut 3']) {
        const n = c.reads();
        const res = await c.w.save(c.ctx as never, [{ slot, lcid: FR, before, after }] as never, writeOpts());
        t.eq(res[0].outcome, 'saved', JSON.stringify(res));
        reads.push(c.reads() - n);
        before = after;
      }
      t.eq(reads, [4, 2, 2], 'read, again after 1 and 2 s, verify; then read and verify only');
      t.eq(srv.dn, { [EN]: 'Status', [FR]: 'Statut 3', [DE]: 'Status DE' }, 'their German kept');
    }),
  );

  t.test('save path: a text already as asked counts as this page\'s save: the next save of the other label reads nothing behind and waits for nothing', () =>
    fast(async () => {
      const srv: ColSrv = { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: { [EN]: 'The status' } };
      const c = column(srv);
      const save = async (cs: unknown[]) => {
        const n = c.reads();
        const res = await c.w.save(c.ctx as never, cs as never, writeOpts());
        return [res[0].outcome, c.reads() - n];
      };
      t.eq(await save([{ slot: c.dn, lcid: FR, before: 'Statut', after: 'A' }]), ['saved', 2]);
      // A write of "B" whose answer was lost: it landed, then the connection failed.
      const put = c.http.put;
      c.http.put = async (u: string, body: any) => {
        await put(u, body);
        throw new DvError('Could not reach Dataverse (network error).', 0, 'network');
      };
      await c.w.save(c.ctx as never, [{ slot: c.dn, lcid: FR, before: 'A', after: 'B' }] as never, writeOpts()).catch(() => {});
      c.http.put = put;
      t.eq(await save([{ slot: c.dn, lcid: FR, before: 'A', after: 'B' }]), ['unchanged', 3], 'Try again: read again after 1 and 2 s, as any text already as asked');
      // Already as asked, but this page's last write there was another text ("B"): the read may be behind that write (a text
      // from before it this page never saw), so it is written (the same text), never taken as made.
      srv.dn[FR] = 'C';
      t.eq(await save([{ slot: c.dn, lcid: FR, before: 'B', after: 'C' }]), ['saved', 2]);
      t.eq([c.puts.length, srv.dn[FR]], [3, 'C']);
      t.eq(await save([{ slot: c.ds, lcid: FR, before: '', after: 'Le statut' }]), ['saved', 2]);
    }),
  );

  t.test('save path: a read still behind this page\'s last save of a label after every wait writes nothing (it would undo that save); one that catches up is written; a write that never sends that label back is made at once', () =>
    fast(async () => {
      // [what, reads behind, outcome, reads of the second save]
      const cases: Array<[string, number, string, number]> = [
        ['English name', 1, 'saved', 3],
        ['English name', 99, 'error', 5],
        // A PUT of the description carries only the description: made at once, however long the reads stay behind.
        ['English description', 1, 'saved', 2],
        ['English description', 99, 'saved', 2],
      ];
      for (const [what, lag, outcome, reads] of cases) {
        const srv: ColSrv = { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: {} };
        const c = column(srv, (body) => {
          // The reads after a write show it made.
          Object.assign(c.st, { stale: null, n: 1 });
          for (const l of body.DisplayName?.LocalizedLabels || []) srv.dn[l.LanguageCode] = l.Label;
          for (const l of body.Description?.LocalizedLabels || []) srv.desc[l.LanguageCode] = l.Label;
        });
        const r1 = await c.w.save(c.ctx as never, [{ slot: c.dn, lcid: FR, before: 'Statut', after: 'Statuts' }] as never, writeOpts());
        t.eq([r1[0].outcome, c.reads()], ['saved', 2]);
        // The next save's reads still show the French name from before that save.
        Object.assign(c.st, { stale: { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: {} }, n: lag });
        const said: string[] = [];
        const change = what === 'English name' ? { slot: c.dn, lcid: EN, before: 'Task status', after: 'Task statuss' } : { slot: c.ds, lcid: EN, before: '', after: 'The status' };
        const r2 = await c.w.save(c.ctx as never, [change] as never, { ...writeOpts(), progress: (m: string) => void said.push(m) });
        t.eq([r2[0].outcome, c.puts.length, c.reads() - 2], [outcome, outcome === 'saved' ? 2 : 1, reads], `${what}, ${lag}: ${r2[0].message}`);
        t.eq(srv.dn[FR], 'Statuts', `${what}: the French save kept`);
        if (outcome === 'saved') t.eq(r2[0].message, undefined, `${what}, ${lag}: never "Saved, but Dataverse also changed" (the French name catching up is this page's save)`);
        else {
          t.eq(r2[0].message, "Not saved: Dataverse doesn't show your last change to this column yet, and saving now could undo it. Try again in a minute.");
          t.ok(said.includes('Waiting for Dataverse to show your last save of t…'), said.join(' | '));
        }
      }
    }),
  );

  const BEHIND = "Not saved: Dataverse doesn't show your last change to this column yet, and saving now could undo it. Try again in a minute.";

  t.test("save path: a read behind two saves of one language is behind both: a later save waits for it (or writes nothing), never sends the older text back, never calls it someone else's change nor not kept", () =>
    fast(async () => {
      const first = { [EN]: 'Task status', [FR]: 'Statut' };
      /** A column whose French name was saved twice (a typo fixed by a second save), both confirmed; `behind(n)`: the next n reads show it as before both. */
      const twice = async () => {
        const srv: ColSrv = { dn: { ...first }, desc: {} };
        const c = column(srv);
        for (const [before, after] of [['Statut', 'Statuts'], ['Statuts', 'État']]) {
          const r = await c.w.save(c.ctx as never, [{ slot: c.dn, lcid: FR, before, after }] as never, writeOpts());
          t.eq(r[0].outcome, 'saved', JSON.stringify(r));
        }
        return { srv, c, behind: (n: number) => void Object.assign(c.st, { stale: { dn: { ...first }, desc: {} }, n }) };
      };
      // Another language, from reads still showing the French from before both saves: the PUT never carries "Statut".
      for (const lag of [2, 99]) {
        const { srv, c, behind } = await twice();
        behind(lag);
        const r = await c.w.save(c.ctx as never, [{ slot: c.dn, lcid: EN, before: 'Task status', after: 'Status' }] as never, writeOpts());
        t.eq(srv.dn[FR], 'État', `${lag}: both French saves kept`);
        if (lag < 99) t.eq([r[0].outcome, toLabels(c.puts[2].DisplayName)[FR]], ['saved', 'État'], JSON.stringify(r));
        else t.eq([r[0].outcome, r[0].message, c.puts.length], ['error', BEHIND, 2]);
      }
      // French again, from 3 such reads: this page's own older text, not someone else's change (no conflict).
      const a = await twice();
      a.behind(3);
      const ra = await a.c.w.save(a.c.ctx as never, [{ slot: a.c.dn, lcid: FR, before: 'État', after: 'État 2' }] as never, writeOpts());
      t.eq([ra[0].outcome, a.srv.dn[FR]], ['saved', 'État 2'], JSON.stringify(ra));
      // The check after a write reads as before both saves: read again until it shows the write, never "did not keep".
      const b = await twice();
      const put = b.c.http.put;
      b.c.http.put = async (u: string, body: any) => {
        await put(u, body);
        b.behind(1);
      };
      const rb = await b.c.w.save(b.c.ctx as never, [{ slot: b.c.dn, lcid: FR, before: 'État', after: 'État 2' }] as never, writeOpts());
      t.eq([rb[0].outcome, b.c.puts.length, b.srv.dn[FR]], ['saved', 3, 'État 2'], JSON.stringify(rb));
    }),
  );

  t.test("save path: a read after a write that shows another language put back to a text this page's save replaced is a change, not that save catching up: reported, and the next save of the label is made at once", () =>
    fast(async () => {
      const srv: ColSrv = { dn: { [EN]: 'Type', [FR]: 'Genre' }, desc: {} };
      const c = column(srv, (body, n) => {
        for (const l of body.DisplayName.LocalizedLabels) srv.dn[l.LanguageCode] = l.Label;
        if (n === 2) srv.dn[EN] = srv.dn[FR]; // the base-language trap (finding 2), on the French write only
      });
      const save = async (lcid: number, before: string, after: string) => {
        const n = c.reads();
        const [r] = await c.w.save(c.ctx as never, [{ slot: c.dn, lcid, before, after }] as never, writeOpts());
        return [r.outcome, r.message, c.reads() - n];
      };
      t.eq(await save(EN, 'Type', 'Kind'), ['saved', undefined, 2]);
      // The French text moved from the English name: Dataverse also puts it into English.
      t.eq(await save(FR, 'Genre', 'Type'), ['error', 'Saved, but Dataverse also changed the English text to "Type". Check those languages.', 2]);
      // The English put right: "Type" is what Dataverse holds, never taken for a read behind the first save.
      t.eq(await save(EN, 'Type', 'Kind'), ['saved', undefined, 2]);
      t.eq(srv.dn, { [EN]: 'Kind', [FR]: 'Type' });
    }),
  );

  t.test('save path: an edit back (or Undo) of a save just made is never taken for a read behind that save, nor confirmed by one: written again until the read right after a write shows it, Try again writes it again', () =>
    fast(async () => {
      /**
       * Saves "Statut" → "Statuts", then back to "Statut" with `o`; the next `lag` reads after the first write of that edit back
       * (`every`: after each of its writes) still show "Statuts".
       */
      const editBack = async (lag: number, o = writeOpts(), every = false) => {
        const srv: ColSrv = { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: {} };
        const c = column(srv, (body, n) => {
          for (const l of body.DisplayName.LocalizedLabels) srv.dn[l.LanguageCode] = l.Label;
          if ((every ? n > 1 : n === 2) && lag) Object.assign(c.st, { stale: { dn: { [EN]: 'Task status', [FR]: 'Statuts' }, desc: {} }, n: lag });
        });
        const fr = (before: string, after: string) => [{ slot: c.dn, lcid: FR, before, after }] as never;
        t.eq((await c.w.save(c.ctx as never, fr('Statut', 'Statuts'), writeOpts()))[0].outcome, 'saved');
        const n = c.reads();
        const [r] = await c.w.save(c.ctx as never, fr('Statuts', 'Statut'), o);
        // Try again, once the reads show what Dataverse holds.
        const again = (o2 = writeOpts()) => ((c.st.stale = null), (lag = 0), c.w.save(c.ctx as never, fr('Statuts', 'Statut'), o2));
        return { srv, c, r, reads: c.reads() - n, again };
      };
      // The read right after the write shows it, and nothing says that read is behind: saved at once.
      const d = await editBack(0);
      t.eq([d.r.outcome, d.c.puts.length, d.reads], ['saved', 2, 2], d.r.message);
      // The check and the 4 reads while waiting still show "Statuts". The second round's read shows "Statut", as a read behind
      // the first save would: written again, and the read right after that write confirms it.
      const a = await editBack(5);
      t.eq([a.r.outcome, a.c.puts.length, a.reads, a.srv.dn[FR]], ['saved', 3, 8, 'Statut'], `read, write, check, 4 while waiting; read, write, check: ${a.r.message}`);
      // Stopped while waiting: Try again writes it again (the same text) and publishes it, never "Not saved".
      const ac = new AbortController();
      const b = await editBack(5, { ...writeOpts(), signal: ac.signal, progress: (m: string) => void (/^Waiting for Dataverse to confirm/.test(m) && setTimeout(() => ac.abort(), 1)) });
      t.eq(b.r.message, 'Stopped before Dataverse confirmed it. Dataverse accepted the change: Try again publishes it once Dataverse shows it.');
      const ob = writeOpts();
      const rb = await b.again(ob);
      t.eq([rb[0].outcome, [...ob.publish.entities], b.c.puts.length], ['saved', ['t'], 3], rb[0].message);
      // Not shown after both rounds (each wrote it): Try again writes it again, and the next save of the column waits for nothing.
      const c = await editBack(6, writeOpts(), true);
      t.ok(/still shows the old French text "Statuts", 15 seconds after writing it 2 times/.test(c.r.message || ''), c.r.message);
      const rc = await c.again();
      t.eq([rc[0].outcome, c.c.puts.length], ['saved', 4], rc[0].message);
      const n = c.c.reads();
      const re = await c.c.w.save(c.c.ctx as never, [{ slot: c.c.dn, lcid: EN, before: 'Task status', after: 'Status' }] as never, writeOpts());
      t.eq([re[0].outcome, c.c.reads() - n, c.srv.dn], ['saved', 2, { [EN]: 'Status', [FR]: 'Statut' }], re[0].message);
    }),
  );

  t.test('save path: what this page saved is known after a reload (or in another tab): an Undo or the next save from a read still behind it waits for it, never a silent undo nor a false "already as asked"', () =>
    fast(async () => {
      const g = globalThis as { localStorage?: unknown };
      const had = Object.getOwnPropertyDescriptor(g, 'localStorage');
      const mem = new Map<string, string>();
      Object.defineProperty(g, 'localStorage', { configurable: true, value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) } });
      try {
        const loaded = { [EN]: 'Task status', [FR]: 'Statut' };
        /** Publishes "Statut" → "Statuts"; then the page reloads (a new instance) while the next 3 reads still show "Statut". */
        const published = async () => {
          mem.clear();
          const srv: ColSrv = { dn: { ...loaded }, desc: {} };
          const c = column(srv);
          const r = await c.w.save({ ...c.ctx, orgId: 'o' } as never, [{ slot: c.dn, lcid: FR, before: 'Statut', after: 'Statuts' }] as never, writeOpts());
          t.eq(r[0].outcome, 'saved');
          Object.assign(c.st, { stale: { dn: { ...loaded }, desc: {} }, n: 3 });
          return { srv, c, reloaded: { ...c.ctx, orgId: 'o' } as never };
        };
        // Recent publishes › Undo: written once a read shows the publish, so it really is undone.
        const u = await published();
        const ru = await u.c.w.save(u.reloaded, [{ slot: u.c.dn, lcid: FR, before: 'Statuts', after: 'Statut' }] as never, writeOpts());
        t.eq([ru[0].outcome, u.c.puts.length, u.srv.dn[FR]], ['saved', 2, 'Statut'], JSON.stringify(ru));
        // The next language of the column: its PUT carries the French published.
        const e = await published();
        const re = await e.c.w.save(e.reloaded, [{ slot: e.c.dn, lcid: EN, before: 'Task status', after: 'Status' }] as never, writeOpts());
        t.eq([re[0].outcome, toLabels(e.c.puts[1].DisplayName)[FR], e.srv.dn[FR]], ['saved', 'Statuts', 'Statuts'], JSON.stringify(re));
        t.eq([...mem.keys()], ['dxt:mine:o']);
      } finally {
        if (had) Object.defineProperty(g, 'localStorage', had);
        else delete g.localStorage;
      }
    }),
  );

  t.test('save path: an edit back not yet confirmed reaches another tab that saved the column too: its next save, from a read showing the edit back, is made at once; a new tab still waits for a read behind it', () =>
    fast(async () => {
      const g = globalThis as { localStorage?: unknown };
      const had = Object.getOwnPropertyDescriptor(g, 'localStorage');
      const mem = new Map<string, string>();
      Object.defineProperty(g, 'localStorage', { configurable: true, value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) } });
      try {
        /**
         * A column whose French name tab A saved "Statut" → "Statuts", then put back, stopped while the reads still showed
         * "Statuts"; with `withB`, tab B saved the French description in between.
         */
        const undone = async (withB: boolean) => {
          mem.clear();
          const srv: ColSrv = { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: {} };
          const c = column(srv);
          // A tab: its own instance, the same storage and server.
          const tab = () => ({ ...c.ctx, orgId: 'o' }) as never;
          const a = tab();
          const b = tab();
          const fr = (before: string, after: string) => [{ slot: c.dn, lcid: FR, before, after }] as never;
          t.eq((await c.w.save(a, fr('Statut', 'Statuts'), writeOpts()))[0].outcome, 'saved');
          if (withB) t.eq((await c.w.save(b, [{ slot: c.ds, lcid: FR, before: '', after: 'Le statut' }] as never, writeOpts()))[0].outcome, 'saved');
          const put = c.http.put;
          c.http.put = async (url: string, body: any) => {
            await put(url, body);
            Object.assign(c.st, { stale: { dn: { ...srv.dn, [FR]: 'Statuts' }, desc: { ...srv.desc } }, n: 5 });
          };
          const ac = new AbortController();
          const stop = { ...writeOpts(), signal: ac.signal, progress: (m: string) => void (/^Waiting for Dataverse to confirm/.test(m) && setTimeout(() => ac.abort(), 1)) };
          const r = await c.w.save(a, fr('Statuts', 'Statut'), stop);
          t.ok(/^Stopped before Dataverse confirmed it/.test(r[0].message || ''), r[0].message);
          c.http.put = put;
          Object.assign(c.st, { stale: null, n: 1 });
          /** The English name saved in the tab `ctx`: its outcome, its reads and the name after it. */
          const save = async (ctx: never) => {
            const n = c.reads();
            const [x] = await c.w.save(ctx, [{ slot: c.dn, lcid: EN, before: 'Task status', after: 'Status' }] as never, writeOpts());
            return [x.outcome, c.reads() - n, { ...srv.dn }];
          };
          return { c, b, tab, save };
        };
        // Tab B learned of tab A's first save when it saved the description: it learns of the edit back too.
        const u = await undone(true);
        t.eq(await u.save(u.b), ['saved', 2, { [EN]: 'Status', [FR]: 'Statut' }], 'read, write, check: the French put back kept');
        // A new tab whose first read is still behind the edit back: the read differs from the labels it loaded, so it reads again.
        const v = await undone(false);
        v.c.st.stale = { dn: { [EN]: 'Task status', [FR]: 'Statuts' }, desc: {} };
        t.eq(await v.save(v.tab()), ['saved', 3, { [EN]: 'Status', [FR]: 'Statut' }], 'read (behind), again after 1 s, write, check');
      } finally {
        if (had) Object.defineProperty(g, 'localStorage', had);
        else delete g.localStorage;
      }
    }),
  );

  const STOPPED = 'Stopped before Dataverse confirmed it. Dataverse accepted the change: Try again publishes it once Dataverse shows it.';

  t.test('save path: an edit back (or Undo) Dataverse accepted but no read showed yet (Stopped, its answer lost) is never undone by the next save of another language from a read behind it', () =>
    fast(async () => {
      for (const how of ['stopped', 'answer lost'] as const) {
        const srv: ColSrv = { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: {} };
        const c = column(srv, (body, n) => {
          for (const l of body.DisplayName.LocalizedLabels) srv.dn[l.LanguageCode] = l.Label;
          if (n !== 2) return;
          // The edit back: the reads after it still show "Statuts" for a while, or its answer is lost (made, then a network error).
          Object.assign(c.st, { stale: { dn: { [EN]: 'Task status', [FR]: 'Statuts' }, desc: {} }, n: 5 });
          if (how === 'answer lost') throw new DvError('Could not reach Dataverse (network error).', 0, 'network');
        });
        const fr = (before: string, after: string) => [{ slot: c.dn, lcid: FR, before, after }] as never;
        t.eq((await c.w.save(c.ctx as never, fr('Statut', 'Statuts'), writeOpts()))[0].outcome, 'saved');
        const ac = new AbortController();
        const stop = { ...writeOpts(), signal: ac.signal, progress: (m: string) => void (/^Waiting for Dataverse to confirm/.test(m) && setTimeout(() => ac.abort(), 1)) };
        const r = await c.w.save(c.ctx as never, fr('Statuts', 'Statut'), stop).then((x) => x[0].message, (e: Error) => e.message);
        t.eq([r, srv.dn[FR]], [how === 'stopped' ? STOPPED : 'Could not reach Dataverse (network error).', 'Statut'], how);
        // The English name, from 2 reads still showing "Statuts": read again until a read shows the edit back, so the PUT carries it.
        Object.assign(c.st, { stale: { dn: { [EN]: 'Task status', [FR]: 'Statuts' }, desc: {} }, n: 2 });
        const n = c.reads();
        const [e] = await c.w.save(c.ctx as never, [{ slot: c.dn, lcid: EN, before: 'Task status', after: 'Status' }] as never, writeOpts());
        t.eq([e.outcome, e.message, c.reads() - n, toLabels(c.puts[2].DisplayName)[FR]], ['saved', undefined, 4, 'Statut'], `${how}: read, again after 1 and 2 s, write, check`);
        t.eq(srv.dn, { [EN]: 'Status', [FR]: 'Statut' }, `${how}: the edit back kept`);
      }
    }),
  );

  t.test('save path: a first save of a label (or an Undo of an older publish) Dataverse accepted but no read showed yet is never undone by a save of another language from a read behind it, in this tab or another', () =>
    fast(async () => {
      const g = globalThis as { localStorage?: unknown };
      const had = Object.getOwnPropertyDescriptor(g, 'localStorage');
      const mem = new Map<string, string>();
      Object.defineProperty(g, 'localStorage', { configurable: true, value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) } });
      try {
        const cases: Array<[string, string, string, boolean]> = [
          ['first save', 'Statut', 'Statuts', false],
          ['first save, then another tab', 'Statut', 'Statuts', true],
          // Recent publishes › Undo, more than a minute after that publish: nothing of it is known any more.
          ['Undo of an older publish', 'Statuts', 'Statut', false],
        ];
        for (const [what, from, to, other] of cases) {
          mem.clear();
          const srv: ColSrv = { dn: { [EN]: 'Task status', [FR]: from }, desc: {} };
          const c = column(srv, (body, n) => {
            for (const l of body.DisplayName.LocalizedLabels) srv.dn[l.LanguageCode] = l.Label;
            if (n === 1) behind(5); // the reads after the French write still show it as before for a while
          });
          const behind = (n: number) => void Object.assign(c.st, { stale: { dn: { [EN]: 'Task status', [FR]: from }, desc: {} }, n });
          // A tab: its own instance, the same storage and server; the slots were loaded before the French write.
          const tab = () => ({ ...c.ctx, orgId: 'o' }) as never;
          const a = tab();
          const ac = new AbortController();
          const stop = { ...writeOpts(), signal: ac.signal, progress: (m: string) => void (/^Waiting for Dataverse to confirm/.test(m) && setTimeout(() => ac.abort(), 1)) };
          const [r] = await c.w.save(a, [{ slot: c.dn, lcid: FR, before: from, after: to }] as never, stop);
          t.eq([r.message, srv.dn[FR]], [STOPPED, to], what);
          // The English name, from 2 reads still showing the French as before: read again until one shows that write.
          behind(2);
          const n = c.reads();
          const [e] = await c.w.save(other ? tab() : a, [{ slot: c.dn, lcid: EN, before: 'Task status', after: 'Status' }] as never, writeOpts());
          t.eq([e.outcome, e.message, c.reads() - n, srv.dn], ['saved', undefined, 4, { [EN]: 'Status', [FR]: to }], `${what}: the French write kept`);
        }
      } finally {
        if (had) Object.defineProperty(g, 'localStorage', had);
        else delete g.localStorage;
      }
    }),
  );

  t.test('save path: a write accepted but not shown yet whose text another tab loaded is no conflict there: a change of it back from a read behind that write waits for it, never "already as asked"', () =>
    fast(async () => {
      const g = globalThis as { localStorage?: unknown };
      const had = Object.getOwnPropertyDescriptor(g, 'localStorage');
      const mem = new Map<string, string>();
      Object.defineProperty(g, 'localStorage', { configurable: true, value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) } });
      try {
        const srv: ColSrv = { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: {} };
        const c = column(srv, (body, n) => {
          for (const l of body.DisplayName.LocalizedLabels) srv.dn[l.LanguageCode] = l.Label;
          if (n === 1) behind(5);
        });
        const behind = (n: number) => void Object.assign(c.st, { stale: { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: {} }, n });
        const tab = () => ({ ...c.ctx, orgId: 'o' }) as never;
        const ac = new AbortController();
        const stop = { ...writeOpts(), signal: ac.signal, progress: (m: string) => void (/^Waiting for Dataverse to confirm/.test(m) && setTimeout(() => ac.abort(), 1)) };
        t.eq((await c.w.save(tab(), [{ slot: c.dn, lcid: FR, before: 'Statut', after: 'Statuts' }] as never, stop))[0].message, STOPPED);
        // Tab B loaded the column after that write and puts the French back, from 3 reads still showing "Statut".
        behind(3);
        const slot = { ...c.dn, labels: { [EN]: 'Task status', [FR]: 'Statuts' } };
        const n = c.reads();
        const [r] = await c.w.save(tab(), [{ slot, lcid: FR, before: 'Statuts', after: 'Statut' }] as never, writeOpts());
        t.eq([r.outcome, c.reads() - n, c.puts.length, srv.dn[FR]], ['saved', 5, 2, 'Statut'], `read again after 1, 2 and 4 s, write, check: ${r.message}`);
      } finally {
        if (had) Object.defineProperty(g, 'localStorage', had);
        else delete g.localStorage;
      }
    }),
  );

  t.test('save path: an edit back really dropped by both rounds is no read behind for long: the next save of another language waits and writes nothing, and after a minute is made from what Dataverse holds', () =>
    fast(async () => {
      const srv: ColSrv = { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: {} };
      const c = column(srv, (body, n) => {
        // Every write of the edit back is accepted (204) and dropped.
        if (n === 2 || n === 3) return;
        for (const l of body.DisplayName.LocalizedLabels) srv.dn[l.LanguageCode] = l.Label;
      });
      const fr = (before: string, after: string) => [{ slot: c.dn, lcid: FR, before, after }] as never;
      t.eq((await c.w.save(c.ctx as never, fr('Statut', 'Statuts'), writeOpts()))[0].outcome, 'saved');
      const [r] = await c.w.save(c.ctx as never, fr('Statuts', 'Statut'), writeOpts());
      t.eq([c.puts.length, srv.dn[FR]], [3, 'Statuts'], 'the second round wrote it again, from a read that showed it not made');
      t.ok(/still shows the old French text "Statuts", 15 seconds after writing it 2 times/.test(r.message || ''), r.message);
      // Dataverse holds "Statuts" as every read shows, which no read can tell from one behind the edit back.
      const en = () => c.w.save(c.ctx as never, [{ slot: c.dn, lcid: EN, before: 'Task status', after: 'Status' }] as never, writeOpts());
      const [e] = await en();
      t.eq([e.outcome, e.message, c.puts.length], ['error', BEHIND, 3]);
      const now = Date.now;
      Date.now = () => now() + 61_000;
      try {
        const [e2] = await en();
        t.eq([e2.outcome, e2.message, srv.dn], ['saved', undefined, { [EN]: 'Status', [FR]: 'Statuts' }]);
      } finally {
        Date.now = now;
      }
    }),
  );

  /** A local choice whose option 1 has the label `srv.dn` and the description `srv.desc`; `st.stale` as column's, until the next write. */
  const choice = (srv: ColSrv) => {
    const st = { stale: null as ColSrv | null, n: 1 };
    let reads = 0;
    const view = (v: ColSrv) => ({ LogicalName: 'contoso_kind', IsCustomizable: { Value: true }, OptionSet: { Options: [{ Value: 1, Label: lab(v.dn), Description: lab(v.desc) }] } });
    const http = {
      get: async () => {
        reads++;
        const v = st.stale ?? srv;
        if (st.stale && --st.n <= 0) Object.assign(st, { stale: null, n: 1 });
        return view(v);
      },
      batch: (parts: never, o: never) => batchOf(http, () => view(srv))(parts, o),
      post: async (fn: string, body: any) => {
        t.eq(fn, 'UpdateOptionValue');
        for (const l of body.Label?.LocalizedLabels || []) srv.dn[l.LanguageCode] = l.Label;
        for (const l of body.Description?.LocalizedLabels || []) srv.desc[l.LanguageCode] = l.Label;
        Object.assign(st, { stale: null, n: 1 }); // read back as made
      },
    };
    const ctx = { http, base: EN, user: FR, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] };
    const sl = (prop: string) =>
      ({ ...t.slot('option', `option|t.contoso_kind|1|${prop}`, { ...(prop === 'Label' ? srv.dn : srv.desc) }), prop, entity: 't', ref: { entity: 't', attribute: 'contoso_kind', value: 1 } }) as Slot;
    return { ctx, st, reads: () => reads, label: sl('Label'), desc: sl('Description'), w: metadataWriters.find((x) => x.kinds.includes('option'))! };
  };

  t.test("save path: a choice option action sends only the languages it writes, so it never waits for a read behind this page's save of another language or the description, nor reports that save as changed by Dataverse", () =>
    fast(async () => {
      const srv: ColSrv = { dn: { [EN]: 'Open', [FR]: 'Ouvert' }, desc: { [EN]: 'Still open' } };
      const ch = choice(srv);
      const save = async (change: Change, lag: number) => {
        // Reads show the choice from before this page's first save (one state: the French label, and the description saved
        // since) until the next write.
        if (lag) Object.assign(ch.st, { stale: { dn: { [EN]: 'Open', [FR]: 'Ouvert' }, desc: { [EN]: 'Still open' } }, n: lag });
        const n = ch.reads();
        const [r] = await ch.w.save(ch.ctx as never, [change], writeOpts());
        return [r.outcome, r.message, ch.reads() - n];
      };
      t.eq(await save({ slot: ch.label, lcid: FR, before: 'Ouvert', after: 'Ouverte' }, 0), ['saved', undefined, 2]);
      t.eq(await save({ slot: ch.desc, lcid: FR, before: '', after: 'Encore ouverte' }, 99), ['saved', undefined, 2], 'the French description: read, write, check');
      t.eq(await save({ slot: ch.label, lcid: EN, before: 'Open', after: 'Opened' }, 99), ['saved', undefined, 2], 'the English label');
      // The French label itself, from 2 such reads: read again until the read shows that save (not a conflict).
      t.eq(await save({ slot: ch.label, lcid: FR, before: 'Ouverte', after: 'Ouverte 2' }, 2), ['saved', undefined, 4]);
      t.eq([srv.dn, srv.desc], [{ [EN]: 'Opened', [FR]: 'Ouverte 2' }, { [EN]: 'Still open', [FR]: 'Encore ouverte' }]);
    }),
  );

  t.test('save path: a choice option action never waits for a language it does not send that reads otherwise than when loaded (someone else\'s text since the load)', () =>
    fast(async () => {
      const srv: ColSrv = { dn: { [EN]: 'Opened', [FR]: 'Ouvert' }, desc: {} };
      const ch = choice(srv);
      const slot = { ...ch.label, labels: { [EN]: 'Open', [FR]: 'Ouvert' } }; // loaded before their English
      const [r] = await ch.w.save(ch.ctx as never, [{ slot, lcid: FR, before: 'Ouvert', after: 'Ouverte' }], writeOpts());
      t.eq([r.outcome, r.message, ch.reads(), srv.dn], ['saved', undefined, 2, { [EN]: 'Opened', [FR]: 'Ouverte' }], 'read, write, check');
    }),
  );

  t.test('save path: a write Dataverse accepted but no read showed yet, caught up by the check of a save made at once (a choice option\'s other language, a column\'s description), is this page\'s write, never reported as changed by Dataverse', () =>
    fast(async () => {
      const stopping = () => {
        const ac = new AbortController();
        return { ...writeOpts(), signal: ac.signal, progress: (m: string) => void (/^Waiting for Dataverse to confirm/.test(m) && setTimeout(() => ac.abort(), 1)) };
      };
      // A choice option: its French label stopped while the reads still show "Ouvert", then its English label.
      const srv: ColSrv = { dn: { [EN]: 'Open', [FR]: 'Ouvert' }, desc: {} };
      const ch = choice(srv);
      const http = ch.ctx.http as { post: (fn: string, body: any) => Promise<void> };
      const post = http.post;
      http.post = async (fn, body) => {
        await post(fn, body);
        Object.assign(ch.st, { stale: { dn: { ...srv.dn, [FR]: 'Ouvert' }, desc: {} }, n: 5 });
      };
      t.eq((await ch.w.save(ch.ctx as never, [{ slot: ch.label, lcid: FR, before: 'Ouvert', after: 'Ouverte' }], stopping()))[0].message, STOPPED);
      http.post = post; // the reads after the next write show everything made
      Object.assign(ch.st, { stale: { dn: { [EN]: 'Open', [FR]: 'Ouvert' }, desc: {} }, n: 1 });
      const [r] = await ch.w.save(ch.ctx as never, [{ slot: ch.label, lcid: EN, before: 'Open', after: 'Opened' }], writeOpts());
      t.eq([r.outcome, r.message, srv.dn], ['saved', undefined, { [EN]: 'Opened', [FR]: 'Ouverte' }], 'the French label catching up in the check');
      // A column: its French name stopped the same way, then its English description (a PUT that sends no name).
      const cs: ColSrv = { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: {} };
      const c = column(cs, (body, n) => {
        for (const l of body.DisplayName?.LocalizedLabels || []) cs.dn[l.LanguageCode] = l.Label;
        for (const l of body.Description?.LocalizedLabels || []) cs.desc[l.LanguageCode] = l.Label;
        if (n === 1) Object.assign(c.st, { stale: { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: {} }, n: 5 });
      });
      t.eq((await c.w.save(c.ctx as never, [{ slot: c.dn, lcid: FR, before: 'Statut', after: 'Statuts' }] as never, stopping()))[0].message, STOPPED);
      Object.assign(c.st, { stale: { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: {} }, n: 1 });
      const [d] = await c.w.save(c.ctx as never, [{ slot: c.ds, lcid: EN, before: '', after: 'The status' }] as never, writeOpts());
      t.eq([d.outcome, d.message, c.puts.length], ['saved', undefined, 2], 'the French name catching up in the check');
    }),
  );

  t.test('save path: the second round writes again from a read that shows what the first round saved, with no wait for the slot; a read still behind that round writes nothing, so its save stays', () =>
    fast(async () => {
      for (const lag of [0, 2, 99]) {
        const srv: ColSrv = { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: {} };
        const c = column(srv, (body, n) => {
          // The first write keeps English and drops French; the second keeps both.
          for (const l of body.DisplayName.LocalizedLabels) if (n > 1 || l.LanguageCode !== FR) srv.dn[l.LanguageCode] = l.Label;
        });
        // Read 3 (the second round's read before writing: the check showed the English made, so the French is written again at
        // once) and `lag` - 1 more answer with the name from before the first write.
        const get = c.http.get;
        c.http.get = async () => {
          if (c.reads() === 2 && lag) Object.assign(c.st, { stale: { dn: { [EN]: 'Task status', [FR]: 'Statut' }, desc: {} }, n: lag });
          return get();
        };
        const cs = [
          { slot: c.dn, lcid: EN, before: 'Task status', after: 'Task statuss' },
          { slot: c.dn, lcid: FR, before: 'Statut', after: 'Statuts' },
        ];
        const res = await c.w.save(c.ctx as never, cs as never, writeOpts());
        const by = (l: number) => res.find((x) => x.change.lcid === l)!;
        t.eq(c.dn.labels, { [EN]: 'Task status', [FR]: 'Statut' }, 'the slot still holds the English from before');
        t.eq(srv.dn[EN], 'Task statuss', `${lag}: the English save kept`);
        if (lag < 99) {
          t.eq([by(EN).outcome, by(FR).outcome, c.puts.length, c.reads()], ['saved', 'saved', 2, 4 + lag], `${lag}: read, write, verify; read (again after 1, 2 s while behind), write, verify`);
          t.eq(toLabels(c.puts[1].DisplayName), { [EN]: 'Task statuss', [FR]: 'Statuts' }, `${lag}: the second write carries the English saved`);
        } else {
          t.eq([by(EN).outcome, by(FR).outcome, c.puts.length, c.reads()], ['saved', 'error', 1, 7], 'the second round read 5 times, all behind: nothing written');
          t.eq(by(FR).message, "Dataverse accepted this change once but hasn't confirmed it yet. Try again: it publishes the change once Dataverse shows it, or writes it again.");
        }
      }
    }),
  );

  type Sides = Record<1 | 2, Record<number, string>>;
  /** An N:N relationship whose menu labels are `srv`; `st.stale`, when set, answers the next `st.n` reads (1 unless set). */
  const relation = (srv: Sides) => {
    const id = '11111111-2222-3333-4444-555555555555';
    const st = { stale: null as Sides | null, n: 1 };
    const puts: any[] = [];
    let reads = 0;
    const menu = (l: Record<number, string>) => ({ Behavior: 'UseLabel', Group: 'Details', Order: 10000, Label: lab(l) });
    const view = (v: Sides) => ({
      '@odata.type': '#Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata',
      MetadataId: id,
      SchemaName: 'acc_con',
      Entity1LogicalName: 'account',
      Entity2LogicalName: 'contact',
      IsCustomizable: { Value: true },
      Entity1AssociatedMenuConfiguration: menu(v[1]),
      Entity2AssociatedMenuConfiguration: menu(v[2]),
    });
    const http = {
      get: async () => {
        reads++;
        const v = st.stale ?? srv;
        if (st.stale && --st.n <= 0) Object.assign(st, { stale: null, n: 1 });
        return view(v);
      },
      batch: (parts: never, o: never) => batchOf(http, () => view(srv))(parts, o),
      put: async (_u: string, body: any) => {
        puts.push(body);
        srv[1] = toLabels(body.Entity1AssociatedMenuConfiguration.Label);
        srv[2] = toLabels(body.Entity2AssociatedMenuConfiguration.Label);
      },
    };
    const ctx = { http, base: EN, user: FR, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] };
    const side = (n: 1 | 2) =>
      ({ ...t.slot('relationship', `relationship|acc_con|${n}`, { ...srv[n] }), entity: 'account', group: 'relationship|acc_con', ref: { metadataId: id, type: 'ManyToMany', side: n } }) as Slot;
    return { http, ctx, st, puts, reads: () => reads, s1: side(1), s2: side(2), w: metadataWriters.find((x) => x.kinds.includes('relationship'))! };
  };

  t.test('save path: a relationship menu label written right after the other side of the same relationship waits for a read that shows that save, so it stays', () =>
    fast(async () => {
      const srv: Sides = { 1: { [EN]: 'Contacts', [FR]: 'Contacts' }, 2: { [EN]: 'Accounts', [FR]: 'Comptes' } };
      const r = relation(srv);
      const r1 = await r.w.save(r.ctx as never, [{ slot: r.s2, lcid: FR, before: 'Comptes', after: 'Comptes liés' }], writeOpts());
      t.eq([r1.map((x) => x.outcome), r.reads()], [['saved'], 2]);
      // The other side, right after: its first read still shows side 2 from before that save.
      r.st.stale = { 1: { ...srv[1] }, 2: { [EN]: 'Accounts', [FR]: 'Comptes' } };
      const r2 = await r.w.save(r.ctx as never, [{ slot: r.s1, lcid: FR, before: 'Contacts', after: 'Contacts liés' }], writeOpts());
      t.eq([r2.map((x) => x.outcome), r.puts.length, r.reads()], [['saved'], 2, 5], JSON.stringify(r2));
      t.eq([srv[1][FR], srv[2][FR], toLabels(r.puts[1].Entity2AssociatedMenuConfiguration.Label)[FR]], ['Contacts liés', 'Comptes liés', 'Comptes liés'], 'the first save kept');
    }),
  );

  t.test('save path: a relationship menu label confirmed only by the second round counts as this page\'s save: the other side, written right after from a read behind it, waits, so it stays', () =>
    fast(async () => {
      const srv: Sides = { 1: { [EN]: 'Contacts', [FR]: 'Contacts' }, 2: { [EN]: 'Accounts', [FR]: 'Comptes' } };
      const r = relation(srv);
      const put = r.http.put;
      r.http.put = async (u: string, body: any) => {
        // The check after the write and the 4 reads while waiting still answer with the labels from before it.
        if (!r.puts.length) Object.assign(r.st, { stale: { 1: { ...srv[1] }, 2: { ...srv[2] } }, n: 5 });
        return put(u, body);
      };
      const r1 = await r.w.save(r.ctx as never, [{ slot: r.s2, lcid: FR, before: 'Comptes', after: 'Comptes liés' }], writeOpts());
      t.eq([r1.map((x) => x.outcome), r.puts.length, r.reads()], [['saved'], 1, 9], 'read, write, 5 behind; read 7 shows it written, read again twice');
      r.st.stale = { 1: { ...srv[1] }, 2: { [EN]: 'Accounts', [FR]: 'Comptes' } };
      const r2 = await r.w.save(r.ctx as never, [{ slot: r.s1, lcid: FR, before: 'Contacts', after: 'Contacts liés' }], writeOpts());
      t.eq([r2.map((x) => x.outcome), r.puts.length, r.reads()], [['saved'], 2, 12], 'read (behind), read again after 1 s, write, verify');
      t.eq([srv[2][FR], toLabels(r.puts[1].Entity2AssociatedMenuConfiguration.Label)[FR]], ['Comptes liés', 'Comptes liés'], 'the first save kept');
    }),
  );

  t.test('save path: a relationship menu label put back, accepted but no read showed yet (Stopped), is never undone by the other side written next from a read behind it', () =>
    fast(async () => {
      const srv: Sides = { 1: { [EN]: 'Contacts', [FR]: 'Contacts' }, 2: { [EN]: 'Accounts', [FR]: 'Comptes' } };
      const r = relation(srv);
      /** The next `n` reads still show side 2's French label as "Comptes liés". */
      const behind = (n: number) => void Object.assign(r.st, { stale: { 1: { ...srv[1] }, 2: { [EN]: 'Accounts', [FR]: 'Comptes liés' } }, n });
      t.eq((await r.w.save(r.ctx as never, [{ slot: r.s2, lcid: FR, before: 'Comptes', after: 'Comptes liés' }], writeOpts()))[0].outcome, 'saved');
      const put = r.http.put;
      r.http.put = async (u: string, body: any) => {
        await put(u, body);
        behind(5);
      };
      const ac = new AbortController();
      const stop = { ...writeOpts(), signal: ac.signal, progress: (m: string) => void (/^Waiting for Dataverse to confirm/.test(m) && setTimeout(() => ac.abort(), 1)) };
      t.eq((await r.w.save(r.ctx as never, [{ slot: r.s2, lcid: FR, before: 'Comptes liés', after: 'Comptes' }], stop))[0].message, STOPPED);
      r.http.put = put;
      behind(2);
      const n = r.reads();
      const [s1] = await r.w.save(r.ctx as never, [{ slot: r.s1, lcid: FR, before: 'Contacts', after: 'Contacts liés' }], writeOpts());
      t.eq([s1.outcome, s1.message, r.reads() - n], ['saved', undefined, 4], 'read, again after 1 and 2 s, write, check');
      t.eq([srv[2][FR], toLabels(r.puts[2].Entity2AssociatedMenuConfiguration.Label)[FR]], ['Comptes', 'Comptes'], 'the label put back kept');
    }),
  );

  t.test('save path: a record label write turned away (throttled) reads again first; one whose answer was lost is published with the rest', () =>
    fast(async () => {
      const srv: Record<number, string> = { [EN]: 'Active Accounts', [FR]: 'Comptes actifs' };
      const posts: Array<{ body: any; once?: boolean }> = [];
      let mode: 'throttle' | 'lose' | '' = 'throttle';
      const http = {
        fn: () => 'RetrieveLocLabels()',
        get: async () => ({ Label: lab(srv) }),
        post: async (_fn: string, body: any, o: { once?: boolean }) => {
          posts.push({ body, once: o.once });
          if (mode === 'throttle') {
            mode = '';
            srv[DE] = 'Aktive Konten'; // someone added German meanwhile
            throw new DvError('Number of requests exceeded the limit.', 429);
          }
          for (const l of body.Labels) srv[l.LanguageCode] = l.Label;
          if (mode === 'lose') {
            mode = '';
            throw new DvError('Could not reach Dataverse (network error).', 0, 'network');
          }
        },
        batch: (parts: never, o: never) => batchOf(http)(parts, o),
      };
      const ctx = { http, base: EN, user: FR, langs: [] };
      const slot = { ...t.slot('view', 'view|v1|Name', { [EN]: 'Active Accounts', [FR]: 'Comptes actifs' }), kind: 'view', prop: 'Name', ref: { id: 'v1', table: 'savedquery', entitySet: 'savedqueries', column: 'name', entity: 'account' } } as Slot;
      const o = writeOpts();
      const res = await recordsWriter.save(ctx as never, [{ slot, lcid: FR, before: 'Comptes actifs', after: 'Comptes ouverts' }], o);
      t.eq(res.map((x) => x.outcome), ['saved'], JSON.stringify(res));
      t.eq(posts.map((p) => p.once), [true, true]);
      t.eq([posts[1].body.Labels, srv[DE]], [[{ Label: 'Comptes ouverts', LanguageCode: FR }], 'Aktive Konten'], 'the second write sends French alone; German, added meanwhile, is kept');
      t.eq([...o.publish.entities], ['account']);
      // The answer of a write that landed is lost: an error, but the view's table is published with the rest.
      mode = 'lose';
      const o2 = writeOpts();
      const res2 = await recordsWriter.save(ctx as never, [{ slot, lcid: FR, before: 'Comptes ouverts', after: 'Comptes en cours' }], o2);
      t.eq([res2[0].outcome, srv[FR], [...o2.publish.entities]], ['error', 'Comptes en cours', ['account']]);
      // Try again: already there, so nothing is written, and it is still published.
      const o3 = writeOpts();
      const res3 = await recordsWriter.save(ctx as never, [{ slot, lcid: FR, before: 'Comptes ouverts', after: 'Comptes en cours' }], o3);
      t.eq([res3[0].outcome, [...o3.publish.entities], posts.length], ['unchanged', ['account'], 3]);
    }),
  );

  t.test("save path: a process's name (the label above its stages) is the workflow record's localizable name: SetLocLabels with the edited language, nothing to publish", async () => {
    const srv: Record<number, string> = { [EN]: 'bpf test' };
    const posts: any[] = [];
    const reads: string[] = [];
    const http = {
      fn: (name: string, p: { EntityMoniker: { '@odata.id': string }; AttributeName: string }) => `${name}(${p.EntityMoniker['@odata.id']},${p.AttributeName})`,
      get: async (u: string, o: { headers?: Record<string, string> }) => (reads.push(`${u} ${o.headers?.Consistency}`), u.endsWith('?$select=ismanaged') ? { ismanaged: false } : { Label: lab(srv) }),
      post: async (_fn: string, body: any) => {
        posts.push(body);
        for (const l of body.Labels) srv[l.LanguageCode] = l.Label;
      },
      batch: (parts: never, o: never) => batchOf(http)(parts, o),
    };
    const ctx = { http, base: EN, user: FR, langs: [] };
    const WF = '9a6faaaa-0000-4000-8000-0000000000b1';
    const slot = {
      ...t.slot('bpf', `bpf|${WF}|Name`, { [EN]: 'bpf test' }),
      kind: 'bpf',
      prop: 'Name',
      comp: `bpf|${WF}`,
      entity: 'account',
      ref: { id: WF, table: 'workflow', entitySet: 'workflows', column: 'name', entity: 'account', managed: false },
    } as Slot;
    const change: Change = { slot, lcid: FR, before: '', after: 'test du processus' };
    const o = writeOpts();
    const res = await recordsWriter.save(ctx as never, [change], o);
    t.eq(res.map((x) => x.outcome), ['saved'], JSON.stringify(res));
    t.eq(posts, [{ EntityMoniker: { '@odata.type': 'Microsoft.Dynamics.CRM.workflow', workflowid: WF }, AttributeName: 'name', Labels: [{ Label: 'test du processus', LanguageCode: FR }] }]);
    t.eq(srv, { [EN]: 'bpf test', [FR]: 'test du processus' });
    t.eq(
      reads,
      [`workflows(${WF})?$select=ismanaged Strong`, `RetrieveLocLabels(workflows(${WF}),name) Strong`, `RetrieveLocLabels(workflows(${WF}),name) Strong`, `RetrieveLocLabels(workflows(${WF}),name) Strong`],
      'whether the process is from a managed solution, then the text read fresh before the write, then in its batch right before and after it',
    );
    // Workflows aren't published (PublishXml has no element for them); the app is served a compiled copy of the process
    // that keeps the old name until the process is updated, so the saver updates it after the save (LIVE-FINDINGS 83).
    t.eq([o.publish.empty, publishTargets([change]).empty], [true, true]);
    t.eq([[...o.publish.processes.keys()], [...publishTargets([change]).processes.keys()]], [[WF], [WF]]);
  });

  run('a process name: once every label is written and published, each process whose name was saved is updated once, outside every quiet() job, in a base-language window, with its base-language name read right before it; no label changes', async (r) => {
    const P = processes(t, r);
    r.store.set(P.name(WF1).key, FR, 'Processus FR');
    r.store.set(P.desc(WF1).key, FR, 'Un processus de test');
    r.store.set(P.name(WF2).key, EN, 'Second flow 2'); // the base-language name itself
    r.store.set(P.stage.key, FR, 'Étape 1');
    r.store.set(P.view.key, FR, 'Comptes ouverts');
    const said: string[] = [];
    const rep = await P.save(said);
    t.eq([rep.saved, rep.errors, rep.published, rep.warning, rep.notice], [5, 0, true, undefined, undefined], JSON.stringify(rep.results.map((x) => x.message)));
    // In the order their names were written, which the records lane's parallel writes leave open: compared sorted.
    t.eq(P.updates().sort(), [`update ${WF2} "Second flow 2" in 1033 once`, `update ${WF1} "bpf test" in 1033 once`], 'once per process, with the base-language name, never resent');
    t.eq(P.runs, [EN, EN]);
    const first = P.log.indexOf(`[${EN}`);
    const writes = P.log.flatMap((e, i) => (/^(set|stage|publish)\b/.test(e) ? [i] : []));
    t.ok(writes.length === 6 && first > Math.max(...writes), `after every write and the publish: ${P.log.join(' | ')}`);
    // The name read, then one batch [the name, the update, the name] (procname.ts: what the batch's reads catch).
    const win = (id: string, name: string) => ['[1033', `read ${id}|name`, `read ${id}|name`, `update ${id} "${name}" in 1033 once`, `read ${id}|name`, ']'];
    const tail = P.log.slice(first);
    t.eq(tail.slice(0, 6)[1] === `read ${WF1}|name` ? tail : [...tail.slice(6), ...tail.slice(0, 6)], [...win(WF1, 'bpf test'), ...win(WF2, 'Second flow 2')], 'the name read in the window, right before the update, and in its batch; read again after it');
    t.eq([P.labels.get(`${WF1}|name`), P.labels.get(`${WF2}|name`)], [{ [EN]: 'bpf test', [FR]: 'Processus FR' }, { [EN]: 'Second flow 2', [FR]: 'Deuxième processus' }], 'no label changed by the updates');
    const pub = said.slice(said.indexOf('Publishing…'));
    t.eq([pub[0], pub.slice(1).sort()], ['Publishing…', ['Updating the process Deuxième processus', 'Updating the process Processus test']]);
    t.eq(r.posts.length, 1, 'the view published once');
  });

  run("a process's new base-language name: a read in its update's batch still behind that save (LIVE-FINDINGS 66) shows the name the save replaced, nobody's: never put back", async (r) => {
    const P = processes(t, r);
    const http = (r.app.ctx as unknown as { http: { get: (u: string) => Promise<unknown> } }).http;
    const get = http.get;
    let n = 0;
    const stale = { Label: { LocalizedLabels: [{ Label: 'Second flow', LanguageCode: EN }, { Label: 'Deuxième processus', LanguageCode: FR }] } };
    // The second read of its name inside the update's base-language window: the first read of the update's batch.
    http.get = async (u: string) => {
      const x = await get(u);
      return u === `RetrieveLocLabels(workflows(${WF2}),name)` && P.ui === EN && ++n === 2 ? stale : x;
    };
    r.store.set(P.name(WF2).key, EN, 'Second flow 2');
    const rep = await P.save();
    t.eq([rep.saved, rep.errors, rep.warning, rep.notice], [1, 0, undefined, undefined], JSON.stringify(rep));
    t.eq(P.updates(), [`update ${WF2} "Second flow 2" in 1033 once`], 'the update alone, nothing put back');
    t.eq(P.labels.get(`${WF2}|name`), { [EN]: 'Second flow 2', [FR]: 'Deuxième processus' });
  });

  run("a process from a managed solution: its name loaded as one (read-only) is never staged; one loaded as this environment's but read as a managed solution's right before the write is never written nor updated, nothing published; the other process of the save is", async (r) => {
    const P = processes(t, r);
    // Loaded from a managed solution: read-only, nothing staged.
    r.store.add([{ ...P.name(WF2), ref: { ...P.name(WF2).ref, managed: true } }]);
    r.store.set(P.name(WF2).key, EN, 'Second flow 2');
    t.eq([r.store.get(P.name(WF2).key)!.readOnly, r.store.isEdited(P.name(WF2).key)], [MANAGED, false]);
    // Loaded as this environment's; Dataverse says it is a managed solution's now.
    r.store.add([{ ...P.name(WF2), readOnly: '', ref: { ...P.name(WF2).ref, managed: false } }]);
    r.store.set(P.name(WF2).key, EN, 'Second flow 2');
    r.store.set(P.name(WF1).key, FR, 'Processus FR');
    P.managed.add(WF2);
    const rep = await P.save();
    const by = new Map(rep.results.map((x) => [x.change.slot.key, [x.outcome, x.message]]));
    t.eq([by.get(P.name(WF2).key), by.get(P.name(WF1).key)], [['error', MANAGED], ['saved', undefined]]);
    t.eq(P.updates(), [`update ${WF1} "bpf test" in 1033 once`], 'only the other process is updated');
    t.eq([P.labels.get(`${WF2}|name`), P.log.filter((e) => e.startsWith(`set ${WF2}`))], [{ [EN]: 'Second flow', [FR]: 'Deuxième processus' }, []], 'never written');
    // Nothing of a managed solution's component is predicted to be published or updated either (the Publish dialog).
    const managed = (s: Slot): Change => ({ slot: { ...s, ref: { ...s.ref, managed: true } }, lcid: EN, before: '', after: 'x' });
    const p = publishTargets([managed(P.name(WF2)), managed(P.view), managed(P.stage)]);
    t.eq([p.empty, [...p.processes]], [true, []]);
  });

  run('no process update for a save of only a stage label, or only a process description', async (r) => {
    const P = processes(t, r);
    r.store.set(P.stage.key, FR, 'Étape 1');
    const said: string[] = [];
    const rep = await P.save(said);
    t.eq([rep.saved, rep.published, P.labels.get(`${WF1}|name`)], [1, true, { [EN]: 'bpf test', [FR]: 'Processus test' }]);
    t.ok(P.log.includes(`stage ${WF1}`), P.log.join(' | '));
    r.store.set(P.desc(WF1).key, FR, 'Un processus de test');
    r.store.set(P.desc(WF2).key, EN, 'The second process');
    const rep2 = await P.save(said);
    t.eq([rep2.saved, rep2.published, P.labels.get(`${WF2}|description`)], [2, true, { [EN]: 'The second process' }]);
    t.eq([P.updates(), P.runs, said.includes('Publishing…'), rep.notice, rep2.notice], [[], [], false, undefined, undefined], 'nothing updated, nothing switched');
    const step = { ...P.stage, kind: 'step', key: `step|${WF1}|x|Label` } as Slot;
    t.eq([...publishTargets([P.stage, step, P.desc(WF1)].map((slot) => ({ slot, lcid: FR, before: '', after: 'x' }))).processes], [], 'none predicted either');
  });

  run("a stage name Dynamics keeps (filled from its own store where the definition has none, LIVE-FINDINGS 83, 85): emptied, its English text is written into the definition in its place (removing it would leave the kept name showing), measured against the kept name; a new text then replaces it", async (r) => {
    const P = processes(t, r);
    const kept = { ...P.stage, labels: { [EN]: 'Stage 1', [FR]: 'Étape 1 FR' }, title: 'Étape 1 FR', ref: { ...P.stage.ref, stored: [FR] } } as Slot;
    r.store.add([kept]);
    r.store.set(kept.key, FR, '');
    const rep = await P.save();
    t.eq([rep.saved, rep.errors, rep.results.map((x) => [x.change.after, x.change.standIn?.from])], [1, 0, [['Stage 1', 'base']]], JSON.stringify(rep.results.map((x) => x.message)));
    t.ok(P.log.includes(`stage ${WF1}`), P.log.join(' | '));
    t.eq([r.store.get(kept.key)!.labels[FR], r.store.pendingCount(), readHistory(r.app.ctx)[0].items.map((it) => [it.before, it.after])], ['Stage 1', 0, [['Étape 1 FR', 'Stage 1']]]);
    r.store.set(kept.key, FR, 'Étape 1');
    const rep2 = await P.save();
    t.eq([rep2.saved, rep2.conflicts, rep2.errors, r.store.get(kept.key)!.labels[FR], r.store.pendingCount()], [1, 0, 0, 'Étape 1', 0], JSON.stringify(rep2.results.map((x) => x.message)));
  });

  run('a process update that fails is not sent again and never undoes the save: saved, journaled, and the page may show the old name; with no base-language name to send, nothing is sent', async (r) => {
    const P = processes(t, r);
    P.fail = 1;
    r.store.set(P.name(WF1).key, FR, 'Processus FR');
    const rep = await P.save();
    const soft = 'Saved; the page may show the old process name until the process is updated.';
    t.eq([rep.saved, rep.errors, rep.published, rep.warning, rep.notice], [1, 0, true, undefined, soft]);
    t.eq(P.updates(), [`update ${WF1} "bpf test" in 1033 once`], 'sent once');
    t.eq([P.labels.get(`${WF1}|name`), r.store.pendingCount(), r.store.get(P.name(WF1).key)!.labels[FR]], [{ [EN]: 'bpf test', [FR]: 'Processus FR' }, 0, 'Processus FR']);
    t.eq(readHistory(r.app.ctx).map((e) => [e.published, e.items.map((i) => [i.lcid, i.before, i.after])]), [[true, [[FR, 'Processus test', 'Processus FR']]]], 'Recent publishes can undo it');
    // A process without a base-language name: nothing to update it with.
    delete P.labels.get(`${WF2}|name`)![EN];
    r.store.set(P.name(WF2).key, FR, 'Deuxième processus 2');
    const rep2 = await P.save();
    t.eq([rep2.saved, rep2.notice, P.updates().length, P.runs], [1, soft, 1, [EN, EN]]);
    t.eq(P.labels.get(`${WF2}|name`), { [FR]: 'Deuxième processus 2' });
  });

  run("what Recent publishes › Undo reads first (saver.current): a view's and a process's names and a stage label as the records and process writers read them before writing; nothing written", async (r) => {
    const P = processes(t, r);
    const ch = (slot: Slot, lcid: Lcid): Change => ({ slot, lcid, before: '', after: '' });
    P.labels.set('v1|name', { [EN]: 'Active Accounts', [FR]: 'Comptes actifs (Marie)' }); // saved by someone since it was loaded
    const got = await r.app.saver.current([ch(P.view, FR), ch(P.name(WF1), FR), ch(P.name(WF1), EN), ch(P.desc(WF2), FR), ch(P.stage, EN), ch(P.stage, FR)]);
    t.eq([...got], [
      [`${P.view.key}#${FR}`, 'Comptes actifs (Marie)'],
      [`${P.name(WF1).key}#${FR}`, 'Processus test'],
      [`${P.name(WF1).key}#${EN}`, 'bpf test'],
      [`${P.desc(WF2).key}#${FR}`, ''],
      [`${P.stage.key}#${EN}`, 'Stage 1'],
      [`${P.stage.key}#${FR}`, ''],
    ]);
    t.eq(P.log.filter((x) => !x.startsWith('read ')), [], 'reads only');
  });

  run('a process update that changed another language of the name (run in the wrong UI language) is caught by the read after it and named, to check', async (r) => {
    const P = processes(t, r);
    P.stay = true; // Dataverse stays in French
    r.store.set(P.name(WF1).key, FR, 'Processus FR');
    const rep = await P.save();
    t.eq(P.updates(), [`update ${WF1} "bpf test" in 1036 once`]);
    t.eq([rep.saved, rep.notice, rep.warning], [1, undefined, 'Updating the process Processus test also changed its French name in Dataverse. Check it and save it again.']);
  });

  // The metadata writers against seeded random sequences of lagging reads, dropped writes, other makers and two tabs.
  fuzzTests(t);

  t.test('publish path: row headers say what and where (the place as the user sees it, which Recent publishes keeps)', () => {
    const s = (kind: string, prop: string, path: string[] = []) => ({ ...t.slot(kind), prop, path }) as Slot;
    const rows = [
      s('field', 'Label', ['Demande de service', 'Formulaire principal', 'Général', 'Résumé']),
      s('attribute', 'Description', ['Demande de service', 'Columns']),
      s('attribute', 'DisplayName'),
      s('tab', 'Label', ['Demande de service', 'Formulaire principal']),
      s('section', 'Label', ['Account', 'Account (Main form)', 'Summary']),
      s('entity', 'DisplayCollectionName', ['Account']),
      s('entity', 'DisplayName'),
      s('status', 'Label', ['Account', 'Status Reason (statuscode)', 'Choices']),
      s('globaloption', 'Label', ['Global choices', 'Urgency']),
      s('command', 'Label'),
      s('ribbon', 'ToolTipDescription', ['Account', 'Command bar (classic)']),
      s('subarea', 'Title', ['Sales Hub', 'Customers', 'Accounts and contacts']),
      s('stage', 'Label', ['bpf test']),
      s('step', 'Label', ['bpf test', 'Qualify']),
      s('view', 'Name', ['Account']),
      s('relationship', 'Label', ['Account', 'Relationships']),
      s('app', 'Name'),
    ];
    t.eq(rows.map((x) => [whatOf(x), whereOf(x)]), [
      ['Form label', 'Formulaire principal › Général › Résumé'],
      ['Tooltip (everywhere)', 'Demande de service'],
      ['Column name (everywhere)', ''],
      ['Tab', 'Formulaire principal'],
      ['Section', 'Account (Main form) › Summary'],
      ['Plural name', ''],
      ['Table name', ''],
      ['Choice', 'Account › Status Reason'],
      ['Choice', 'Urgency'],
      ['Button', ''],
      ['Button tooltip', 'Account'],
      ['Menu item', 'Sales Hub › Customers › Accounts and contacts'],
      ['Stage', 'bpf test'],
      ['Step', 'bpf test › Qualify'],
      ['View name', 'Account'],
      ['Menu item', 'Account'],
      ['App name', ''],
    ]);
    // The title is the popup's: a cell without a label of its own shows its column's name, never its control id.
    const store = new Store();
    const cell = { ...t.slot('field', 'field|f1|c1|Label', {}), entity: 'acc', title: 'new_primarywriter', ref: { controlId: 'new_primarywriter', datafield: 'new_primarywriter' } } as Slot;
    store.add([cell, { ...t.slot('attribute', 'attribute|acc.new_primarywriter|DisplayName', { [EN]: 'Primary writer', [FR]: 'Rédacteur principal' }), entity: 'acc' } as Slot]);
    const app = { store, ctx: { base: EN, user: FR } } as unknown as AppApi;
    t.eq(titleOf(app, cell), 'Rédacteur principal');
    t.eq(titleOf(app, { ...cell, labels: { [FR]: 'Rédacteur' }, title: 'Rédacteur' }), 'Rédacteur', 'its own label shows');
  });

  t.test('import: a file with global choice rows loads every global choice, so rows of choices its tables do not use still match', async () => {
    const io = createIo({ base: EN, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] });
    const csv = (rows: string[]) => new File([['Key,Type,Table,Component,Property,1033,1036', ...rows].join('\r\n')], 'labels.csv', { type: 'text/csv' });
    const g = await io.parse(csv(['attribute|acc.name|DisplayName,,acc,,,Name,Nom', 'globaloption|new_color|1|Label,,,,,Red,Rouge']));
    t.eq([g.scope.allGlobals, g.scope.entities], [true, ['acc']]);
    const a = await io.parse(csv(['attribute|acc.name|DisplayName,,acc,,,Name,Nom']));
    t.ok(!a.scope.allGlobals, 'only the tables');
  });

  // ---- refresh (ui/refresh.ts) ----

  const CODE = ['CDN_Resources', 'clientsdk', 'WebResources', 'sw-feature-status'];
  const CACHES = [...CODE, 'mainaspx', 'gcm_11992198_org_user', 'gcm_no_version_org_user', 'https://uci-state/', 'https://uci-state/app1/', 'fast-block', 'DATA__org_user', 'Resources_2', 'some-future-cache'];
  const KEYS = ['uci-state-hint', 'uci-state-v2', 'Form:account', 'UCI_RESOURCE_STRINGS', 'ActualControls/f1/tab0', 'dxt:prefs:o', 'dxt:history:o', 'dxt:langrestore:o:u', 'dxt:verify:o', 'siteMapState', 'lastTimeCheckCache'];
  /** The org's IndexedDB as seen live (LIVE-FINDINGS 82): metadata stores, and the offline data next to them. */
  const META = ['usercontext', 'entitymetadata', 'attributemetadata', 'applicationmetadata', 'metadataversionstamp', 'navigationdata', 'userpersonalization', 'tempformdata'];
  const OFFLINE = ['entityrecord', 'list', 'offlinedatabaseinformation', 'sessionstate'];
  const ORG = 'https://org.crm4.dynamics.com';
  const cachesOf = (names: string[]) => {
    const left = new Set(names);
    return { left, keys: async () => [...left], delete: async (n: string) => left.delete(n) };
  };
  /**
   * An IndexedDB stand-in: databases by name, each store's rows. Opening one that doesn't exist upgrades it (a new
   * database) unless the upgrade is aborted; `hang` never answers. It has no deleteDatabase: the purge never needs one.
   */
  const idbOf = (dbs: Record<string, Record<string, number[]>>, o: { hang?: boolean } = {}) => {
    const modes: string[] = [];
    const factory = {
      open(name: string) {
        const req: any = { result: null, error: null, transaction: null };
        if (o.hang) return req;
        setTimeout(() => {
          if (!dbs[name]) {
            let aborted = false;
            req.transaction = { abort: () => void (aborted = true) };
            req.onupgradeneeded?.();
            if (aborted) {
              req.error = new Error('AbortError');
              return req.onerror?.();
            }
            dbs[name] = {};
          }
          const db = dbs[name];
          req.result = {
            objectStoreNames: Object.keys(db),
            close() {},
            transaction(names: string[], mode: string) {
              modes.push(mode);
              const tx: any = { error: null, objectStore: (n: string) => ({ clear: () => void (names.includes(n) && (db[n] = [])) }) };
              setTimeout(() => tx.oncomplete?.(), 1);
              return tx;
            },
          };
          req.onsuccess?.();
        }, 1);
        return req;
      },
    };
    return { factory: factory as unknown as IDBFactory, dbs, modes };
  };
  const rows = () => Object.fromEntries([...META, ...OFFLINE].map((n) => [n, [1, 2]]));

  t.test('refresh: the purge sends the service worker its purge commands in order, then removes every cache but code (main.aspx too), UCI\'s keys, the worker state, the IndexedDB metadata and sessionStorage', async () => {
    const caches = cachesOf(CACHES);
    const local = storage(KEYS);
    const session = storage(['page-stack']);
    const p = port(true);
    const sent: unknown[] = [];
    let order = '';
    const db = idbOf({ [ORG]: rows(), 'another-db': { usercontext: [1] } });
    const rep = await purge(
      {
        caches: { keys: async () => ((order ||= 'sw before caches? ' + (sent.length === SW_PURGE.length)), caches.keys()), delete: caches.delete },
        local,
        session,
        port: () => p,
        sw: async () => ({ postMessage: (m: unknown) => void sent.push(m) }),
        idb: { factory: db.factory, name: ORG },
      },
      { sw: 1 },
    );
    t.eq(sent, SW_PURGE.map((name) => ({ name })), 'every command, in order');
    t.eq(SW_PURGE, ['PurgeUserContextGcmCacheEntry', 'PurgeUserSettingsCollectionDataCacheEntry', 'PurgeGcmCache', 'PurgeDataCache', 'PurgeMainAspxCache']);
    t.eq([rep.sw, order], [SW_PURGE, 'sw before caches? true']);
    t.eq([...caches.left].sort(), [...CODE].sort(), 'only the code caches stay');
    t.ok(rep.caches.includes('mainaspx') && rep.caches.includes('gcm_no_version_org_user'), JSON.stringify(rep.caches));
    t.eq([...local.m.keys()], ['dxt:prefs:o', 'dxt:history:o', 'dxt:langrestore:o:u', 'dxt:verify:o', 'siteMapState', 'lastTimeCheckCache'], 'every dxt: key kept');
    t.eq(rep.keys, ['uci-state-hint', 'uci-state-v2', 'Form:account', 'UCI_RESOURCE_STRINGS', 'ActualControls/f1/tab0']);
    t.eq([rep.worker, (p.got[0] as { type?: string }).type, rep.session, session.cleared], ['cleared', 'clearState', true, true]);
    t.ok(!KEYS.filter((k) => k.startsWith('dxt:')).some(dropKey), 'a dxt: key never matches');
    // IndexedDB: the metadata stores are emptied in one readwrite transaction; offline data and other databases stay.
    t.eq([rep.idb, [...rep.stores].sort(), db.modes], ['cleared', [...META].sort(), ['readwrite']]);
    const d = db.dbs[ORG];
    t.eq([META.filter((n) => d[n].length), OFFLINE.filter((n) => d[n].length)], [[], OFFLINE], 'offline data kept');
    t.eq(db.dbs['another-db'].usercontext, [1], 'another database untouched');
    t.ok([...META].every(metaStore) && !OFFLINE.some(metaStore));
    t.ok(KEEP_CACHES.test('CDN_Resources') && !KEEP_CACHES.test('mainaspx'));
  });

  t.test('refresh: every label metadata request is fetched again past the HTTP cache first (two language switches in a row), before the service worker drops the list; a hanging one never holds the rest', async () => {
    const log: string[] = [];
    const reqs: LabelRequest[] = [
      { url: 'https://org/api/data/v9.0/GetClientMetadata(form)&umv=1&mv=2', headers: { accept: 'application/json', 'x-ms-metadatareductionlevel': '5' } },
      { url: 'https://org/api/data/v9.0/GetClientMetadata(entity)&umv=1&mv=2', headers: { accept: 'application/json' } },
      { url: 'https://org/api/data/v9.0/GetClientMetadata(form)&umv=1&mv=2', headers: { accept: 'application/json' } }, // the same, in another cache
    ];
    const inits: RequestInit[] = [];
    const labels: NonNullable<PurgeEnv['labels']> = {
      requests: async () => reqs,
      fetch: async (url, init) => {
        log.push('fetch ' + url.slice(-30));
        inits.push(init);
        return { ok: !url.includes('entity'), arrayBuffer: async () => (log.push('read'), new ArrayBuffer(0)) };
      },
    };
    const rep = await purge({ labels, sw: async () => ({ postMessage: (m: unknown) => void log.push('sw ' + (m as { name: string }).name) }) }, { sw: 1 });
    t.eq(log.slice(0, 4), ['fetch ' + reqs[0].url.slice(-30), 'fetch ' + reqs[1].url.slice(-30), 'read', 'read'], 'each URL once, both before any service worker command');
    t.ok(log.indexOf('sw ' + SW_PURGE[0]) > log.lastIndexOf('read'), log.join(' | '));
    t.eq(inits[0], { headers: { accept: 'application/json', 'x-ms-metadatareductionlevel': '5', 'x-ms-sw-skipcache': '1' }, cache: 'reload', credentials: 'same-origin' }, 'its own headers, past the service worker and the HTTP cache');
    t.eq(rep.primed, { ok: 1, failed: 1, skipped: 0 });
    // A request that never answers: the rest goes on once the time is up, and what wasn't sent is counted.
    const many = Array.from({ length: 20 }, (_, i): LabelRequest => ({ url: 'u' + i, headers: {} }));
    const t0 = Date.now();
    const rep2 = await purge({ labels: { requests: async () => many, fetch: () => new Promise(() => {}) } }, { sw: 1, prime: 40 });
    t.ok(Date.now() - t0 < 1500, String(Date.now() - t0));
    t.eq(rep2.primed, { ok: 0, failed: 0, skipped: 12 }, 'eight sent, twelve skipped');
    // The list can't be read: nothing is fetched and the purge carries on.
    const rep3 = await purge({ labels: { requests: async () => Promise.reject(new Error('no caches')), fetch: async () => ({ ok: true, arrayBuffer: async () => 0 }) } }, { sw: 1 });
    t.eq(rep3.primed, { ok: 0, failed: 0, skipped: 0 });
  });

  t.test('refresh: the page reads the label requests from the versioned label caches only, without the headers the browser sets itself', async () => {
    const mkReq = (url: string, h: Record<string, string>) => ({ url, headers: new Map(Object.entries(h)) as unknown as Headers });
    const stores: Record<string, ReturnType<typeof mkReq>[]> = {
      gcm_12092946_t_u: [mkReq('https://o/a', { accept: 'application/json', 'sec-ch-ua': 'x', 'user-agent': 'y', 'x-ms-app-id': 'app' })],
      gcm_no_version_t_u: [mkReq('https://o/boot', { accept: 'application/json' })],
      CDN_Resources: [mkReq('https://o/app.js', {})],
    };
    const win = {
      caches: {
        keys: async () => Object.keys(stores),
        open: async (n: string) => ({ keys: async () => stores[n] }),
      },
      fetch: async () => ({ ok: true, arrayBuffer: async () => 0 }),
      navigator: {},
      location: { origin: 'https://o' },
    } as unknown as Window;
    const got = await pageEnv(win).labels!.requests();
    t.eq(got, [{ url: 'https://o/a', headers: { accept: 'application/json', 'x-ms-app-id': 'app' } }]);
    t.ok(LABEL_CACHE.test('gcm_12092946_t_u') && !LABEL_CACHE.test('gcm_no_version_t_u') && !LABEL_CACHE.test('CDN_Resources'));
  });

  t.test('refresh: an org without that IndexedDB gets none (its creation is aborted); a page without a service worker sends nothing', async () => {
    const db = idbOf({});
    const rep = await purge({ idb: { factory: db.factory, name: ORG }, sw: async () => null }, { sw: 1 });
    t.eq([rep.idb, rep.stores, Object.keys(db.dbs), rep.sw], ['none', [], [], []]);
    // A database with no metadata stores: nothing is opened for writing.
    const only = idbOf({ [ORG]: { entityrecord: [1] } });
    const rep2 = await purge({ idb: { factory: only.factory, name: ORG } }, { sw: 1 });
    t.eq([rep2.idb, rep2.stores, only.modes, only.dbs[ORG].entityrecord], ['cleared', [], [], [1]]);
  });

  t.test('refresh: a hanging cache API, IndexedDB or service worker and a silent state worker never hold the reload; a failing step never stops the others', async () => {
    const local = storage(['uci-state-hint', 'dxt:prefs:o']);
    const session = storage(['x']);
    const t0 = Date.now();
    const hang: PurgeEnv = {
      caches: { keys: () => new Promise<string[]>(() => {}), delete: async () => true },
      local,
      session,
      port: () => port(false),
      sw: () => new Promise<null>(() => {}),
      idb: { factory: idbOf({}, { hang: true }).factory, name: ORG },
    };
    const rep = await purge(hang, { total: 60, worker: 30 });
    t.ok(Date.now() - t0 < 1000, 'capped');
    t.eq([rep.worker, rep.idb, [...local.m.keys()], session.cleared], ['timeout', 'timeout', ['dxt:prefs:o'], true]);
    const broken: PurgeEnv = {
      caches: { keys: async () => Promise.reject(new Error('blocked')), delete: async () => true },
      local: { get length() { return 2; }, key: () => { throw new Error('blocked'); }, removeItem() {} },
      session,
      port: () => {
        throw new Error('no SharedWorker');
      },
      sw: () => {
        throw new Error('no service worker');
      },
      idb: {
        factory: {
          open: () => {
            throw new Error('blocked');
          },
        },
        name: ORG,
      },
    };
    const rep2 = await purge(broken, { total: 60, worker: 30 });
    t.eq([rep2.sw, rep2.caches, rep2.keys, rep2.worker, rep2.idb, rep2.session], [[], [], [], 'failed', 'failed', true]);
    // A service worker that refuses one command still gets the others.
    const got: string[] = [];
    const picky = { postMessage: (m: { name: string }) => (m.name === 'PurgeDataCache' ? (() => { throw new Error('no'); })() : void got.push(m.name)) };
    const rep3 = await purge({ sw: () => picky as SwTarget }, { sw: 1 });
    t.eq([got, rep3.sw], [SW_PURGE.filter((n) => n !== 'PurgeDataCache'), got]);
  });

  t.test("refresh: the page loads again with main.aspx's warm boot off: the flags merged into its URL, every other parameter and flag kept", () => {
    const U = `${ORG}/main.aspx?appid=a1&pagetype=entityrecord&etn=account&id=42`;
    const OFF = 'FCB.PersistReduxStore=false,FCB.PersistReduxStoreV2=false';
    t.eq(freshUrl(U), `${U}&flags=${OFF}`);
    t.eq(freshUrl(freshUrl(U)), freshUrl(U), 'the same the second time');
    t.eq(
      freshUrl(`${ORG}/main.aspx?flags=FCB.Other=true,FCB.PersistReduxStore=true&appid=a1#x`),
      `${ORG}/main.aspx?flags=FCB.Other=true,${OFF}&appid=a1#x`,
      'flags already there stay where they were, ours win',
    );
    t.eq(
      freshUrl(`${ORG}/main.aspx?flags=FCB.Other%3Dtrue&appid=a1&Flags=FCB.More=false`),
      `${ORG}/main.aspx?flags=FCB.Other=true,FCB.More=false,${OFF}&appid=a1`,
      'an encoded flags parameter, and a second one merged into the first',
    );
    t.eq(withFlags(`${ORG}/main.aspx`, { 'FCB.X': true }), `${ORG}/main.aspx?flags=FCB.X=true`);
    t.eq(freshUrl(`${ORG}/apps/home?x=1`), `${ORG}/apps/home?x=1`, 'not main.aspx: as it is');
    t.ok(Object.values(FRESH_FLAGS).every((v) => v === false));
    const did: string[] = [];
    const loc = (href: string) => ({ href, replace: (u: string) => void did.push('replace ' + u), reload: () => void did.push('reload') });
    reloadFresh(loc(U));
    reloadFresh(loc(`${freshUrl(U)}#tab`));
    t.eq(did, [`replace ${U}&flags=${OFF}`, 'reload'], 'an address that would not change (or only scroll) is reloaded');
  });

  t.test('refresh: refreshNow reloads whatever the purge does: done, hanging past its time, or throwing', async () => {
    const did: string[] = [];
    const rep = await refreshNow({ env: { local: storage(['uci-state-hint']) }, reload: () => void did.push('reload 1'), purge: { sw: 1 } });
    t.eq(rep?.keys, ['uci-state-hint']);
    const t0 = Date.now();
    await refreshNow({ env: { caches: { keys: () => new Promise<string[]>(() => {}), delete: async () => true }, sw: () => new Promise<null>(() => {}) }, reload: () => void did.push('reload 2'), purge: { total: 40 } });
    t.ok(Date.now() - t0 < 1000, 'capped');
    const throwing = {
      get local(): never {
        throw new Error('storage blocked');
      },
    } as PurgeEnv;
    t.eq(await refreshNow({ env: throwing, reload: () => void did.push('reload 3') }), null);
    t.eq(did, ['reload 1', 'reload 2', 'reload 3']);
  });

  const items: VerifyItem[] = [{ comp: 'field|f|c', kind: 'field', key: 'field|f|c|Label', lcid: FR, text: 'Nom 2' }];
  const opts = (o: { dirty?: boolean; pending?: number; answers?: boolean[]; teardown?: boolean; env?: PurgeEnv }) => {
    const did: string[] = [];
    const asked: string[] = [];
    const store = storage([]);
    const answers = [...(o.answers ?? [])];
    return {
      did,
      asked,
      store,
      o: {
        xrm: { Page: { data: { getIsDirty: () => !!o.dirty } } },
        orgId: 'o',
        items,
        pending: o.pending ?? 0,
        confirm: async (c: { body: unknown }) => (asked.push(String(c.body)), answers.shift() ?? false),
        toast: (m: string) => void did.push('toast: ' + m),
        teardown: () => (did.push('teardown'), o.teardown ?? true),
        restore: async () => void did.push('restore'),
        env: o.env ?? ({ caches: cachesOf(['gcm_1']), local: storage(['uci-state-hint']), session: storage([]), port: () => null } as PurgeEnv),
        storage: store,
        reload: () => void did.push('reload'),
        now: () => 1000,
        note: (text: string) => (did.push('note: ' + text), { remove: () => void did.push('note gone') }),
      },
    };
  };

  t.test('refresh: unsaved record changes ask first; Not now refreshes nothing and says to refresh later', async () => {
    const x = opts({ dirty: true, answers: [false] });
    t.eq(await refreshPage(x.o), false);
    t.eq(x.asked, ['This record has unsaved changes. Refresh anyway and lose them?']);
    t.eq(x.did, ['toast: Refresh the page later to see your changes.']);
    const y = opts({ pending: 2, answers: [false] });
    t.eq([await refreshPage(y.o), y.asked, y.did], [false, ['You have 2 unpublished changes. Refreshing the page discards them.'], []], 'staged changes would be lost');
  });

  t.test('refresh: tears the app down, says it is refreshing, restores the language, stores what to check, purges, reloads', async () => {
    const x = opts({ dirty: true, answers: [true] });
    t.eq(await refreshPage(x.o), true);
    t.eq(x.did, ['teardown', 'note: Refreshing the page…', 'restore', 'reload']);
    t.eq(JSON.parse(x.store.getItem(verifyKey('o'))!), { at: 1000, items });
    t.eq([...(x.o.env.local as ReturnType<typeof storage>).m.keys()], [], 'purged');
    const y = opts({ teardown: false });
    t.eq([await refreshPage(y.o), y.did], [false, ['teardown', 'toast: Saving is in progress. Refresh the page once it has finished.']], 'never while a save runs');
    // Every purge step hanging or throwing: the page is reloaded all the same.
    const z = opts({ env: { caches: { keys: () => new Promise<string[]>(() => {}), delete: async () => true }, port: () => port(false), sw: () => { throw new Error('x'); } } });
    t.eq([await refreshPage(z.o), z.did.at(-1)], [true, 'reload']);
  });

  t.test('refresh: a prepare step (the language switch) runs once the questions are answered, before the teardown; when it fails nothing is torn down or reloaded', async () => {
    const x = opts({ pending: 1, answers: [true] });
    t.eq(await refreshPage({ ...x.o, prepare: async () => void x.did.push('prepare') }), true);
    t.eq([x.asked.length, x.did], [1, ['prepare', 'teardown', 'note: Refreshing the page…', 'restore', 'reload']]);
    const y = opts({});
    t.eq(await refreshPage({ ...y.o, prepare: async () => Promise.reject(new Error('Dataverse refused it.')) }), false);
    t.eq(y.did, ['toast: Dataverse refused it.']);
    const z = opts({ pending: 1, answers: [false] });
    let ran = false;
    t.eq([await refreshPage({ ...z.o, prepare: async () => void (ran = true) }), ran], [false, false], 'Not now: not even prepared');
  });

  t.test('refresh: Show Dynamics in <language> sets the language, then refreshes; refused while a save or a language switch runs, and nothing reloads when the switch fails', async () => {
    const run = (busy: string, adopt: () => Promise<void>) => {
      const x = opts({});
      return { x, go: switchLanguage({ ...x.o, name: 'French', busy: () => busy, adopt: () => (x.did.push('adopt'), adopt()) }) };
    };
    const a = run('', async () => {});
    t.eq(await a.go, true);
    t.eq(a.x.did, ['toast: Switching Dynamics to French…', 'adopt', 'teardown', 'note: Refreshing the page…', 'restore', 'reload']);
    const b = run('Publishing is in progress. Switch the language once it has finished.', async () => {});
    t.eq([await b.go, b.x.did], [false, ['toast: Publishing is in progress. Switch the language once it has finished.']], 'refused: never sent');
    const c = run('', async () => Promise.reject(new Error('You do not have permission to do this.')));
    t.eq([await c.go, c.x.did], [false, ['toast: Switching Dynamics to French…', 'adopt', 'toast: You do not have permission to do this.']]);
  });

  t.test('refresh: the Show Dynamics in menu goes by the language on screen (<html lang>), not the one the server already says', () => {
    // LIVE-FINDINGS 78: switched to French elsewhere; the server and userSettings say French, the page still English.
    t.eq([shownLanguage([EN, FR], FR, 'en'), shownLanguage([EN, FR], EN, 'fr-FR'), shownLanguage([EN, FR], FR, 'de'), shownLanguage([EN, FR], FR, '')], [EN, FR, FR, FR]);
    const app = { ctx: { user: FR, langs: [{ lcid: EN, name: 'English' }, { lcid: FR, name: 'French' }] } } as unknown as AppApi;
    const labels = (shown: number) => dynamicsItems(app, shown).map((i) => (typeof i === 'string' ? i : 'head' in i ? `[${i.head}]` : i.label));
    t.eq(labels(EN), ['Refresh page', '-', '[Show Dynamics in]', 'French'], 'the language chosen elsewhere is offered');
    t.eq(labels(FR), ['Refresh page', '-', '[Show Dynamics in]', 'English']);
  });

  t.test('refresh: a navigation cancelled ("Leave site?" answered Stay) drops the note after a while', async () => {
    const x = opts({});
    t.eq(await refreshPage({ ...x.o, stayed: 10 }), true);
    t.eq(x.did.at(-1), 'reload');
    await new Promise((r) => setTimeout(r, 40));
    t.eq(x.did.at(-1), 'note gone');
  });

  t.test('refresh: after the reload, the stored check is read back unless it is broken or older than an hour', () => {
    const now = 10 * 3_600_000;
    t.eq(readVerify(JSON.stringify({ at: now - 3_700_000, items }), now), null, 'older than an hour');
    t.eq(readVerify('{broken', now), null);
    t.eq(readVerify(JSON.stringify({ at: now - 1000, items }), now)?.items, items);
  });

  t.test('refresh: after the check, only changes the page does not show yet are said (no message when they all show)', () => {
    t.eq([notShowing(0), notShowing(1), notShowing(3)], ['', "1 change isn't showing yet", "3 changes aren't showing yet"]);
  });
}
