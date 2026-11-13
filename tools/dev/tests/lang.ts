// Unit tests for the UI-language switching path (core/langsession.ts: the hold lock, the switch window and
// quiet(), the repair marker and the checks after a switch, across two "tabs" sharing one Web Locks stand-in), a
// language the user chooses for good (core/uilang.ts and LangSession.adoptLanguage), the $batch plumbing it rides on (core/http.ts), form XML loading and writing through it (providers/formxml.ts)
// and the saver's lane scheduling (core/saver.ts) with the process update after it (core/publish.ts). Dataverse is a small in-memory fake that behaves like the live
// findings: tab and section labels in a per-UI-language store (a write keeps only the caller's language), cell
// labels inline in every language, a $batch runs its parts one after another and goes on after a failed part
// (odata.continue-on-error), and the probe answers in the current UI language.
import { buildBatch, CONTINUE, DvError, Http, parseBatch, type BatchPart, type PartResult } from '../../../src/core/http';
import { LangSession, MARKER_AGE, markerSays, PROBE, probeSays, type LangEnv } from '../../../src/core/langsession';
import { MANAGED, PublishSet, type Change, type ChangeResult, type Kind, type Lcid, type Slot } from '../../../src/core/model';
import { createSaver } from '../../../src/core/saver';
import { Store } from '../../../src/core/store';
import { langLock, markerKey, NotConfirmed, setUiLanguage, windowLock } from '../../../src/core/uilang';
import { loadBpfStored } from '../../../src/providers/bpf';
import { formNote, formXmlWriter, knownOwnLabels, loadFormsScope, loadFormXml, loadOwnLabels, mergeReads, NO_UNPUB, pageOwnLabels, PUB_ONLY } from '../../../src/providers/formxml';
import { PageLoader, WANT_FORM, WANT_QUICK } from '../../../src/inspector/pageload';
import { recordsWriter } from '../../../src/providers/records';
import type { OwnCopy, SaveOptions, Writer } from '../../../src/providers/types';
import type { Kit } from './kit';
import { batchOf } from './records';

const EN = 1033;
const FR = 1036;
const DE = 1031;
const FORM = '5e07410a-0000-4000-8000-000000000071';
const API = 'https://org.test/api/data/v9.2/';
const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

// ---- a fake Dataverse ----

interface Fake {
  ui: Lcid;
  /** Tab / section labels per language (the per-UI-language store); cell labels inline. */
  tab: Record<number, string>;
  section: Record<number, string>;
  cell: Record<number, string>;
  /** The cell's column display name per language: the published definition shows it for a cell without a label (LIVE-FINDINGS 52). */
  column: Record<number, string>;
  /** Published etag (If-Match is compared with it, LIVE-FINDINGS 22). */
  pub: string;
  /** Every request, in order: "GET url", "PATCH url {json}", and "[" / "]" around a batch's parts. */
  log: string[];
  /** The parts of each http.batch call, and the options it got. */
  batches: Array<{ parts: BatchPart[]; idempotent?: boolean; once?: boolean; signal?: AbortSignal }>;
  /** Batches running right now, and the most at once. */
  inBatch: number;
  maxBatches: number;
  /** A batch that switches the UI language is running (its switch window is open). */
  switching: boolean;
  /** Milliseconds each batch takes. */
  delay: number;
  /** Switch PATCHes (usersettings inside a batch) are answered 204 but ignored. */
  ignoreSwitch: boolean;
  /** The last part of switching batches (the switch back) fails with 500 and does nothing. */
  failRestore: number;
  /** Plain (non-batch) usersettings PATCHes that fail with a network error. */
  failPatch: number;
  /** The next form PATCH answers 412 (a publish happened in between). */
  conflict412: number;
  /** versionnumber of the published and the unpublished form (a PATCH moves the unpublished one on). */
  vpub: number;
  vun: number;
  /** The next batches with a form PATCH are turned away whole (HTTP 429, nothing runs); `onThrottle` runs then. */
  throttle: number;
  onThrottle?: () => void;
  /**
   * The next switching batches lose their answer (a network error at once) while the server runs them later: the
   * switch `late` ms after, the rest of the parts `gap` ms after that.
   */
  lose: number;
  late: number;
  gap: number;
  /** The next batches with a form PATCH run, then their answer is lost (a network error). */
  dropAnswer: number;
  /** Called before each part runs (tests change the server under the writer). */
  onPart?: (p: BatchPart, i: number) => void;
  /**
   * The `Labels` GetClientMetadata answers with per UI language (the process names the page shows, LIVE-FINDINGS 85; a
   * form's labels of its own, 114), beside the form and its published versionnumber; null: the call fails; 'no Labels':
   * an answer without them.
   */
  gcm: Record<number, unknown[] | null | 'no Labels'>;
  /** GetClientMetadata's metadata comes as an object, as the page's own read asks for it, not as a JSON string. */
  gcmObject: boolean;
  /** The form is from a managed solution (its ismanaged, in every read of it). */
  managed: boolean;
  /**
   * The form also holds a timeline, a control bound to no column whose cell's labels are stored per UI language like a
   * tab's ({C2}, `timeline`), and a sub-grid, whose cell's labels come with every language ({C3}, `grid`): LIVE-FINDINGS 102.
   */
  extra: boolean;
  timeline: Record<number, string>;
  /** The timeline's Name from the form designer (its UClientUniqueName parameter), one text for every language. */
  tlName?: string;
  grid: Record<number, string>;
  http: any;
}

const LABEL = (lc: number, t: string) => `<label description="${t}" languagecode="${lc}" />`;

function fake(ui: Lcid = FR): Fake {
  const S: Fake = {
    ui,
    tab: { [EN]: 'General', [FR]: 'Général' },
    section: { [EN]: 'Details' },
    cell: { [EN]: 'Name', [FR]: 'Nom' },
    column: { [EN]: 'Account Name', [FR]: 'Nom du compte' },
    pub:'W/"100"',
    log: [],
    batches: [],
    inBatch: 0,
    maxBatches: 0,
    switching: false,
    delay: 1,
    ignoreSwitch: false,
    failRestore: 0,
    failPatch: 0,
    conflict412: 0,
    vpub: 7,
    vun: 7,
    throttle: 0,
    lose: 0,
    late: 0,
    gap: 0,
    dropAnswer: 0,
    gcm: {},
    gcmObject: false,
    managed: false,
    extra: false,
    timeline: { [EN]: 'Note Text', [FR]: 'Texte de la remarque' },
    grid: { [EN]: 'Contacts', [FR]: 'Contacts liés' },
    http: null,
  };
  // Per-language store: the caller's language, else the base language flagged as such.
  const perLang = (l: Record<number, string>) => (l[S.ui] !== undefined ? LABEL(S.ui, l[S.ui]) : l[EN] !== undefined ? LABEL(EN, l[EN]) : '');
  const every = (l: Record<number, string>) =>
    Object.entries(l)
      .map(([k, t]) => LABEL(Number(k), t))
      .join('');
  const extra = () =>
    S.extra
      ? `<row><cell id="{C2}"><labels>${perLang(S.timeline)}</labels><control id="notescontrol" classid="{06375649-C143-495E-A496-C962E5B4488E}">${S.tlName ? `<parameters><UClientUniqueName>${S.tlName}</UClientUniqueName></parameters>` : ''}</control></cell></row>` +
        `<row><cell id="{C3}"><labels>${every(S.grid)}</labels><control id="contacts" classid="{E7A81278-8635-4D9E-8D4D-59480B391C5B}" /></cell></row>`
      : '';
  const xml = () =>
    `<form><tabs><tab id="{A1}" name="general"><labels>${perLang(S.tab)}</labels><columns><column width="100%"><sections><section id="{B1}" name="details"><labels>${perLang(S.section)}</labels>` +
    `<rows><row><cell id="{C1}"><labels>${every(S.cell)}</labels><control id="name" datafieldname="name" /></cell></row>${extra()}</rows></section></sections></column></columns></tab></tabs></form>`;
  const row = () => ({ formid: FORM, formxml: xml(), name: 'Main', type: 2, objecttypecode: 'acc', iscustomizable: { Value: true }, ismanaged: S.managed, versionnumber: S.vun });
  // The published definition: cells too carry the caller's language only, else the base language flagged as such, else
  // (a label in neither) the column's display name in the caller's language, flagged as if it were the cell's label
  // (LIVE-FINDINGS 52).
  const pubCell = () => perLang(S.cell) || (S.column[S.ui] !== undefined ? LABEL(S.ui, S.column[S.ui]) : '');
  // The sub-grid's published cell, like a field's, carries the caller's language only.
  const pubRow = () => ({
    ...row(),
    formxml: xml()
      .replace(/<cell id="\{C1\}"><labels>.*?<\/labels>/, `<cell id="{C1}"><labels>${pubCell()}</labels>`)
      .replace(/<cell id="\{C3\}"><labels>.*?<\/labels>/, `<cell id="{C3}"><labels>${perLang(S.grid)}</labels>`),
    versionnumber: S.vpub,
    '@odata.etag': S.pub,
  });
  const ok = (data: any = null, status = 200): PartResult => ({ ok: true, status, data, headers: {} });
  const fail = (status: number, message: string): PartResult => ({ ok: false, status, data: null, error: message, headers: {} });
  /** A form row as a read gets it: ismanaged only where its $select asks for it, so a read that stops asking never sees it. */
  const asked = (u: string, r: any) => {
    if (/[?&]\$select=[^&]*\bismanaged\b/.test(u)) return r;
    const x = { ...r };
    delete x.ismanaged;
    return x;
  };
  /**
   * A form PATCH keeps tab and section labels in the caller's language only, so does the timeline's cell, and merges the
   * other cells per language.
   */
  const apply = (formxml: string) => {
    const d = new DOMParser().parseFromString(formxml, 'application/xml');
    const lab = (el: Element): [number, string] => [Number(el.getAttribute('languagecode')), el.getAttribute('description') || ''];
    const labels = (el: Element | undefined) => (el ? Array.from(el.getElementsByTagName('labels')[0]?.getElementsByTagName('label') || []).map(lab) : []);
    const cell = (id: string) => Array.from(d.getElementsByTagName('cell')).find((c) => c.getAttribute('id') === id);
    for (const [tag, store] of [['tab', S.tab], ['section', S.section]] as const)
      for (const [l, t] of labels(d.getElementsByTagName(tag)[0])) if (l === S.ui) store[l] = t;
    for (const [l, t] of labels(cell('{C1}'))) S.cell[l] = t;
    for (const [l, t] of labels(cell('{C2}'))) if (l === S.ui) S.timeline[l] = t;
    for (const [l, t] of labels(cell('{C3}'))) S.grid[l] = t;
  };
  const exec = (p: BatchPart, inBatch: boolean): PartResult => {
    const u = p.url.replace(API, '');
    S.log.push(`${p.method} ${u}${p.body !== undefined && !/systemforms/.test(u) ? ' ' + JSON.stringify(p.body) : ''}`);
    if (u.startsWith('usersettingscollection(u)')) {
      if (p.method === 'GET') return ok({ uilanguageid: S.ui });
      if (!inBatch && S.failPatch > 0) {
        S.failPatch--;
        throw new DvError('Could not reach Dataverse (network error).', 0, 'network');
      }
      if (!(inBatch && S.ignoreSwitch)) S.ui = (p.body as { uilanguageid: number }).uilanguageid;
      return ok(null, 204);
    }
    if (u === PROBE.url) return ok({ DisplayName: { LocalizedLabels: [{ Label: 'User', LanguageCode: EN }, { Label: 'Utilisateur', LanguageCode: FR }], UserLocalizedLabel: { Label: '?', LanguageCode: S.ui } } });
    if (u.startsWith('systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()')) return ok({ value: u.includes(FORM) ? [asked(u, row())] : [] });
    if (u.startsWith(`systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`)) return ok(asked(u, row()));
    if (u.startsWith(`systemforms(${FORM})?$select=formid,formxml`)) return ok(asked(u, pubRow()));
    if (u.startsWith(`systemforms(${FORM})?$select=formid`)) return ok({ formid: FORM, '@odata.etag': S.pub, versionnumber: S.vpub });
    if (u === `systemforms(${FORM})` && p.method === 'PATCH') {
      const m = p.headers?.['If-Match'];
      if (S.conflict412 > 0 || (m !== '*' && m !== S.pub)) {
        S.conflict412 = Math.max(0, S.conflict412 - 1);
        return fail(412, 'The version of the existing record doesn\'t match the RowVersion property provided.');
      }
      apply((p.body as { formxml: string }).formxml);
      S.vun++;
      return ok(null, 204);
    }
    if (u.startsWith('GetClientMetadata(') && p.method === 'GET') {
      // The form the query asks for.
      const id = String(JSON.parse(decodeURIComponent(u.split('@q=')[1])).MetadataId);
      const labels = S.gcm[S.ui];
      const md = { Forms: [{ FormId: `{${id.toUpperCase()}}`, VersionNumber: S.vpub }], ...(labels === 'no Labels' ? {} : { Labels: labels ?? [] }) };
      return S.gcm[S.ui] === null ? fail(500, 'Generic SQL error.') : ok({ Metadata: S.gcmObject ? md : JSON.stringify(md) });
    }
    return fail(404, 'Resource not found for the segment.');
  };
  S.http = {
    api: API,
    stats: { requests: 0, failures: 0, ms: 0 },
    async get(url: string) {
      await tick();
      const r = exec({ method: 'GET', url }, false);
      if (!r.ok) throw new DvError(r.error || '', r.status);
      return r.data;
    },
    async patch(url: string, body: unknown) {
      await tick();
      const r = exec({ method: 'PATCH', url, body }, false);
      if (!r.ok) throw new DvError(r.error || '', r.status);
      return {};
    },
    async all(url: string) {
      await tick();
      return url.startsWith('EntityDefinitions') ? [{ LogicalName: 'acc', DisplayName: { LocalizedLabels: [{ Label: 'Account', LanguageCode: EN }, { Label: 'Compte', LanguageCode: FR }] } }] : [];
    },
    async post() {
      return {};
    },
    async batch(parts: BatchPart[], o: { signal?: AbortSignal; idempotent?: boolean; once?: boolean } = {}) {
      S.batches.push({ parts, idempotent: o.idempotent, once: o.once, signal: o.signal });
      const switching = parts[0]?.method === 'GET' && parts[0].url.startsWith('usersettingscollection');
      if (S.throttle > 0 && parts.some((p) => p.method === 'PATCH' && p.url.includes('systemforms'))) {
        S.throttle--;
        S.log.push('[throttled]');
        S.onThrottle?.();
        throw new DvError('Number of requests exceeded the limit of 6000 over time window of 300 seconds.', 429);
      }
      if (switching && S.lose > 0) {
        // The answer never comes back; the server runs the batch all the same, later.
        S.lose--;
        S.log.push('[lost');
        setTimeout(() => {
          S.switching = true;
          parts.slice(0, 2).forEach((p) => exec(p, true));
          setTimeout(() => {
            parts.slice(2).forEach((p) => exec(p, true));
            S.switching = false;
            S.log.push('lost]');
          }, S.gap);
        }, S.late);
        throw new DvError('Could not reach Dataverse (network error).', 0, 'network');
      }
      S.maxBatches = Math.max(S.maxBatches, ++S.inBatch);
      S.log.push('[');
      if (switching) S.switching = true;
      try {
        await tick(S.delay);
        const out = parts.map((p, i) => {
          S.onPart?.(p, i);
          if (switching && S.failRestore > 0 && i === parts.length - 1) {
            S.failRestore--;
            S.log.push(`${p.method} (failed)`);
            return fail(500, 'Generic SQL error.');
          }
          return exec(p, true);
        });
        if (S.dropAnswer > 0 && parts.some((p) => p.method === 'PATCH' && p.url.includes('systemforms'))) {
          S.dropAnswer--;
          throw new DvError('Could not reach Dataverse (network error).', 0, 'network');
        }
        return out;
      } finally {
        if (switching) S.switching = false;
        S.inBatch--;
        S.log.push(']');
      }
    },
  };
  return S;
}

function memStorage() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

/** Runs `fn` with a working localStorage (the saver's history journal, the answers loadOwnLabels keeps), or `storage`. */
async function withStorage(fn: () => Promise<void>, storage: object = memStorage()): Promise<void> {
  const g = globalThis as { localStorage?: unknown };
  const had = Object.getOwnPropertyDescriptor(g, 'localStorage');
  Object.defineProperty(g, 'localStorage', { configurable: true, value: storage });
  try {
    await fn();
  } finally {
    if (had) Object.defineProperty(g, 'localStorage', had);
    else delete g.localStorage;
  }
}

/**
 * A Web Locks stand-in shared by every "tab" of a test: exclusive and shared modes, granted in request order; a
 * request whose signal aborts while it waits leaves the queue and rejects with an AbortError, as in browsers.
 * Records each request ("name" or "name shared") and flags an exclusive holder that overlaps any other holder.
 */
function memLocks() {
  const names: string[] = [];
  const held = new Map<string, { x: number; s: number }>();
  const queues = new Map<string, Array<{ x: boolean; go: () => void }>>();
  let overlap = false;
  const state = (n: string) => held.get(n) ?? (held.set(n, { x: 0, s: 0 }), held.get(n)!);
  const fits = (n: string, x: boolean) => (x ? state(n).x + state(n).s === 0 : state(n).x === 0);
  const take = (n: string, x: boolean) => {
    const h = state(n);
    if (x) h.x++;
    else h.s++;
    if (h.x > 1 || (h.x && h.s)) overlap = true;
  };
  const grant = (n: string, q: Array<{ x: boolean; go: () => void }>) => {
    while (q.length && fits(n, q[0].x)) {
      const w = q.shift()!;
      take(n, w.x);
      w.go();
    }
  };
  const aborted = () => new DOMException('The lock request was aborted.', 'AbortError');
  return {
    names,
    get overlap() {
      return overlap;
    },
    async request(name: string, o: { signal?: AbortSignal; mode?: 'shared' | 'exclusive' }, fn: () => Promise<unknown>) {
      const x = o.mode !== 'shared';
      names.push(name + (x ? '' : ' shared'));
      if (o.signal?.aborted) throw aborted();
      const q = queues.get(name) ?? (queues.set(name, []), queues.get(name)!);
      if (q.length || !fits(name, x))
        await new Promise<void>((go, fail) => {
          const drop = () => {
            q.splice(q.indexOf(w), 1);
            grant(name, q);
            fail(aborted());
          };
          const w = { x, go: () => (o.signal?.removeEventListener('abort', drop), go()) };
          q.push(w);
          o.signal?.addEventListener('abort', drop, { once: true });
        });
      else take(name, x);
      try {
        return await fn();
      } finally {
        const h = state(name);
        if (x) h.x--;
        else h.s--;
        grant(name, q);
      }
    },
  };
}

const MARK = 'dxt:langrestore:o:u';

function rig(ui: Lcid = FR, user: Lcid = FR) {
  const S = fake(ui);
  const storage = memStorage();
  const locks = memLocks();
  const changes: Array<number | null> = [];
  const ctx = { http: S.http, xrm: null, origin: 'https://org.test', org: 'org', orgId: 'o', envType: '', userId: 'u', base: EN, user, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }], version: '9.2' };
  const env: LangEnv = { storage, locks, sleep: () => tick() };
  const lang = new LangSession(ctx as never, (l) => changes.push(l), env);
  /** Another browser tab of the same user: its own context and session, the same server, storage and Web Locks. */
  const tab = () => new LangSession({ ...ctx } as never, () => {}, env);
  return { S, storage, locks, changes, ctx, env, lang, tab };
}

/** Runs `fn` with waits of a second or more (the writers' retries after 2, 4, 8 s) 100 times shorter. */
export async function fast(fn: () => Promise<void>): Promise<void> {
  const g = globalThis as { setTimeout: typeof setTimeout };
  const real = g.setTimeout;
  g.setTimeout = ((f: () => void, ms?: number, ...a: unknown[]) => real(f, (ms ?? 0) >= 1000 ? (ms ?? 0) / 100 : ms, ...a)) as typeof setTimeout;
  try {
    await fn();
  } finally {
    g.setTimeout = real;
  }
}

/** Calls `fn` every few milliseconds until `done` settles; resolves with how often it ran. */
async function meanwhile(done: Promise<unknown>, fn: () => Promise<unknown>): Promise<number> {
  let over = false;
  void done.finally(() => (over = true)).catch(() => {});
  let n = 0;
  const all: Promise<unknown>[] = [];
  while (!over) {
    all.push(fn());
    n++;
    await tick(2);
  }
  await Promise.all(all);
  return n;
}

/** The parts of a batch as "METHOD path" (the probe as PROBE). */
const shape = (parts: BatchPart[]) => parts.map((p) => (p === PROBE || p.url === PROBE.url ? 'PROBE' : `${p.method} ${p.url.replace(API, '').replace(/\?.*$/, '')}${p.url.includes('usersettings') && p.body ? ' ' + (p.body as { uilanguageid: number }).uilanguageid : ''}`));

const slotsOf = async (r: ReturnType<typeof rig>) => {
  const slots = await loadFormXml(r.ctx as never, [{ formId: FORM, entity: '', name: '', type: NaN }], [EN, FR], { signal: new AbortController().signal, progress() {}, lang: r.lang });
  return new Map(slots.map((s) => [s.kind, s] as [Kind, Slot]));
};
const saveOpts = (r: ReturnType<typeof rig>, force = new Set<string>()): SaveOptions => ({ signal: new AbortController().signal, publish: new PublishSet(), progress() {}, force, lang: r.lang, allowPublish: true });
const change = (slot: Slot, lcid: Lcid, after: string): Change => ({ slot, lcid, before: slot.labels[lcid] ?? '', after });

export function register(t: Kit): void {
  // ---- $batch plumbing (core/http.ts) ----

  t.test('lang: buildBatch keeps the parts in order, absolute URLs, part headers and ASCII-only JSON bodies', () => {
    const body = buildBatch(API, 'b1', [
      { method: 'GET', url: 'usersettingscollection(u)?$select=uilanguageid' },
      { method: 'PATCH', url: 'usersettingscollection(u)', body: { uilanguageid: EN } },
      { method: 'PATCH', url: `systemforms(${FORM})`, headers: { 'If-Match': 'W/"1"' }, body: { formxml: '<a d="Général ✓"/>' } },
    ]);
    const parts = body.split('--b1').slice(1, -1);
    t.eq(parts.length, 3, 'three parts');
    t.ok(parts[0].includes(`GET ${API}usersettingscollection(u)?$select=uilanguageid HTTP/1.1\r\nAccept: application/json\r\n\r\n`), parts[0]);
    t.ok(parts[1].includes('PATCH ' + API + 'usersettingscollection(u) HTTP/1.1\r\nAccept: application/json\r\nContent-Type: application/json\r\n\r\n{"uilanguageid":1033}'), parts[1]);
    t.ok(parts[2].includes('If-Match: W/"1"\r\n'), 'part header');
    t.ok(parts[2].includes('G\\u00e9n\\u00e9ral \\u2713'), 'non-ASCII escaped');
    t.ok(!/[^\x00-\x7f]/.test(body), 'the whole body is ASCII');
    t.ok(body.endsWith('\r\n--b1--\r\n'), 'closing delimiter');
    t.eq(JSON.parse(parts[2].slice(parts[2].indexOf('{'))).formxml, '<a d="Général ✓"/>', 'escapes decode to the typed text');
  });

  const answer = (b: string, eol = '\r\n') =>
    [
      `--${b}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      '',
      'HTTP/1.1 204 No Content',
      'OData-Version: 4.0',
      '',
      '',
      `--${b}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      '',
      'HTTP/1.1 200 OK',
      'Content-Type: application/json; odata.metadata=minimal',
      'OData-Version: 4.0',
      '',
      '{"@odata.etag":"W/\\"5\\"","formxml":"<form>Général</form>"}',
      `--${b}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      '',
      'HTTP/1.1 404 Not Found',
      'Content-Type: application/json; odata.metadata=minimal',
      '',
      '{"error":{"code":"0x80040217","message":"systemform With Id = x Does Not Exist"}}',
      `--${b}`,
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      '',
      'HTTP/1.1 200 OK',
      'Content-Type: application/json',
      '',
      '{"broken":',
      `--${b}--`,
      '',
    ].join(eol);

  t.test('lang: parseBatch reads 204, 200 and 404 parts (CRLF and LF), headers and error messages', () => {
    for (const eol of ['\r\n', '\n']) {
      const r = parseBatch(answer('batchresponse_1', eol), 'multipart/mixed; boundary=batchresponse_1');
      t.eq(r.map((x) => [x.ok, x.status]), [[true, 204], [true, 200], [false, 404], [false, 0]], 'statuses');
      t.eq(r[0].data, null, '204 has no body');
      t.eq(r[1].data.formxml, '<form>Général</form>', 'JSON body');
      t.eq(r[1].data['@odata.etag'], 'W/"5"');
      t.eq(r[1].headers['odata-version'], '4.0', 'part headers');
      t.eq([r[2].error, r[2].code], ['systemform With Id = x Does Not Exist', '0x80040217']);
    }
    t.ok(parseBatch('', 'multipart/mixed; boundary="q"').length === 0, 'quoted boundary');
    let threw = false;
    try {
      parseBatch('x', 'application/json');
    } catch {
      threw = true;
    }
    t.ok(threw, 'no boundary');
  });

  t.test('lang: Http.batch always sends odata.continue-on-error and pads missing answers', async () => {
    const g = globalThis as { fetch?: unknown };
    const had = g.fetch;
    const seen: Array<{ url: string; init: RequestInit }> = [];
    g.fetch = async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      const body = answer('batchresponse_9').split('--batchresponse_9').slice(0, 2).join('--batchresponse_9') + '--batchresponse_9--\r\n';
      return new Response(body, { status: 200, headers: { 'Content-Type': 'multipart/mixed; boundary=batchresponse_9' } });
    };
    try {
      const http = new Http('https://org.test');
      const r = await http.batch([{ method: 'PATCH', url: 'usersettingscollection(u)', body: { uilanguageid: EN } }, { method: 'GET', url: 'x' }, { method: 'GET', url: 'y' }]);
      const h = seen[0].init.headers as Record<string, string>;
      t.eq(seen[0].url, API + '$batch');
      t.eq(seen[0].init.method, 'POST');
      t.eq(h.Prefer, CONTINUE, 'continue-on-error');
      t.ok(/^multipart\/mixed; boundary=batch_[\w-]+$/.test(h['Content-Type']), h['Content-Type']);
      t.eq(seen[0].init.cache, 'no-store');
      t.eq(h['x-ms-sw-skipcache'], '1', "UCI's service worker leaves it alone");
      t.eq(r.map((x) => x.status), [204, 0, 0], 'one result per part; the unanswered ones as status 0');
    } finally {
      g.fetch = had;
    }
  });

  t.test('lang: probeSays accepts the asked language, or the base language only when the asked one has no label', () => {
    const p = (lc: number, langs = [EN, FR]) => ({ ok: true, status: 200, headers: {}, data: { DisplayName: { LocalizedLabels: langs.map((l) => ({ LanguageCode: l })), UserLocalizedLabel: { LanguageCode: lc } } } });
    t.eq(probeSays(p(FR), FR, EN), true);
    t.eq(probeSays(p(EN), FR, EN), false, 'still in the base language');
    t.eq(probeSays(p(EN, [EN]), DE, EN), true, 'no label in that language: the base fallback is the answer');
    t.eq(probeSays({ ok: false, status: 500, data: null, headers: {} }, FR, EN), false);
  });

  // ---- LangSession ----

  t.test('lang: a switching batch is [GET language, PATCH L, probe, work, PATCH back]; the switch back is last', async () => {
    const r = rig();
    const b = await r.lang.hold((h) => h.batch(EN, [{ method: 'GET', url: 'x' }]));
    t.eq(shape(r.S.batches[0].parts), ['GET usersettingscollection(u)', 'PATCH usersettingscollection(u) 1033', 'PROBE', 'GET x', 'PATCH usersettingscollection(u) 1036']);
    t.eq(b.inLang, true, 'probe in English');
    t.eq(b.results.length, 1, 'only the work comes back');
    t.eq(b.results[0].status, 404);
    t.eq(r.S.batches[0].idempotent, false, 'a switching batch is never sent twice');
    await r.lang.restore();
    t.eq(r.S.ui, FR);
    // In the user's own language: no switch, only the probe.
    await r.lang.hold((h) => h.batch(FR, [{ method: 'GET', url: 'x' }]));
    t.eq(shape(r.S.batches[1].parts), ['PROBE', 'GET x']);
    t.eq(r.S.batches[1].idempotent, true, 'reads that do not switch may be retried');
    t.eq(r.changes, [], 'quick switches do not raise the banner');
  });

  t.test("lang: the stage names Dynamics keeps (providers/bpf.ts loadBpfStored) are read in the user's own language with a probe and no switch, in another one in a switch window of its own, and the language is back after; without the switch, the user's own only", async () => {
    const r = rig();
    r.ctx.langs.push({ lcid: DE, name: 'German', isBase: false });
    const ST = '8f912143-0000-4000-8000-000000000051';
    const REC = '6f3e0a52-0000-0000-0000-000000000001';
    r.S.gcm = { [FR]: [{ Id: ST, LabelColumnName: 'description', Value: 'Étape 1 FR' }], [DE]: [{ Id: `{${ST.toUpperCase()}}`, LabelColumnName: 'description', Value: 'Phase 1' }], [EN]: [{ Id: ST, LabelColumnName: 'description', Value: 'Stage one' }] };
    const stage = { ...t.slot('stage', `stage|w|${ST}|Label`, { [EN]: 'Test1s' }), title: 'Test1s', path: ['bpf test'], ref: { workflowId: 'w', labelId: ST, stageId: ST, primary: 'acc' } } as Slot;
    const o = (lang?: LangSession) => ({ signal: new AbortController().signal, progress() {}, lang });
    const got = await loadBpfStored(r.ctx as never, [stage], { entity: 'acc', record: REC, app: '' }, o(r.lang));
    t.eq([got.missed, got.slots[0].labels, got.slots[0].ref.stored, got.slots[0].title], [[], { [EN]: 'Test1s', [FR]: 'Étape 1 FR', [DE]: 'Phase 1' }, [DE, FR], 'Étape 1 FR'], 'English is in the definition: not read');
    t.eq(r.S.batches.map((b) => shape(b.parts)), [
      ['PROBE', 'GET GetClientMetadata(ClientMetadataQuery=@q)'],
      ['GET usersettingscollection(u)', 'PATCH usersettingscollection(u) 1031', 'PROBE', 'GET GetClientMetadata(ClientMetadataQuery=@q)', 'PATCH usersettingscollection(u) 1036'],
    ]);
    await r.lang.restore();
    t.eq([r.S.ui, r.changes, r.storage.m.size], [FR, [], 0], 'back in French, no banner, no marker left');
    // Without the switch (no o.lang): the page's session reads the user's own language only.
    r.S.batches.length = 0;
    const own = await loadBpfStored(r.ctx as never, [stage], { entity: 'acc', record: REC, app: '' }, o());
    t.eq([own.missed, own.slots[0].labels, r.S.batches.map((b) => shape(b.parts).length)], [[], { [EN]: 'Test1s', [FR]: 'Étape 1 FR' }, [2]]);
  });

  t.test('lang: the marker is written before the switch is sent and cleared once the language reads back', async () => {
    const r = rig();
    let atSend: string | null | undefined;
    r.S.onPart = (_p, i) => {
      if (i === 0) atSend = r.storage.getItem(MARK);
    };
    await r.lang.hold((h) => h.batch(EN, [{ method: 'GET', url: 'x' }]));
    t.eq(JSON.parse(atSend || '{}').lcid, FR, 'marker holds the original language while the batch runs');
    await r.lang.restore();
    t.eq(r.storage.getItem(MARK), null, 'marker cleared');
    // The check after the batch is a separate read of the language.
    const after = r.S.log.slice(r.S.log.lastIndexOf(']') + 1);
    t.eq(after, ['GET usersettingscollection(u)?$select=uilanguageid'], 'one re-read after the batch');
    t.eq(r.lang.active, false);
  });

  t.test('lang: a switch back that failed inside the batch is repaired from the read-back', async () => {
    const r = rig();
    r.S.failRestore = 1;
    const b = await r.lang.hold((h) => h.batch(EN, [{ method: 'GET', url: 'x' }]));
    t.eq(b.inLang, true);
    await r.lang.restore();
    t.eq(r.S.ui, FR, 'back in French');
    const after = r.S.log.slice(r.S.log.lastIndexOf(']') + 1);
    t.eq(after, ['GET usersettingscollection(u)?$select=uilanguageid', 'PATCH usersettingscollection(u) {"uilanguageid":1036}', 'GET usersettingscollection(u)?$select=uilanguageid']);
    t.eq(r.storage.getItem(MARK), null);
  });

  t.test('lang: when the language cannot be put back, the marker stays, the banner shows and nothing else runs until it is', async () => {
    const r = rig();
    r.S.failRestore = 1;
    r.S.failPatch = 9; // the check before the window closes, the one after the hold, then restore()'s own attempt
    await r.lang.hold((h) => h.batch(EN, [{ method: 'GET', url: 'x' }]));
    let err: unknown;
    await r.lang.restore().catch((e) => (err = e));
    t.ok(err instanceof DvError && /could not be switched back to French/.test(err.message), String(err));
    t.eq(r.S.ui, EN, 'still switched');
    t.eq(JSON.parse(r.storage.getItem(MARK) || '{}').lcid, FR, 'marker kept for recover()');
    t.eq(r.lang.active, true);
    t.eq(r.changes, [EN], 'banner up');
    // The next operation repairs first (the network is back), and only then runs.
    const n = r.S.batches.length;
    await r.lang.hold((h) => h.batch(FR, [{ method: 'GET', url: 'x' }]));
    t.eq(r.S.batches.length, n + 1);
    t.eq(r.S.ui, FR);
    t.eq(r.changes, [EN, null], 'banner gone');
    t.eq(r.storage.getItem(MARK), null);
  });

  t.test('lang: holds never overlap, and a user-language read waits for a switch window to close', async () => {
    const r = rig();
    r.S.delay = 15;
    const seen: Lcid[] = [];
    r.S.onPart = (p) => {
      if (p.url === 'user-read') seen.push(r.S.ui);
    };
    const a = r.lang.hold(async (h) => {
      await h.batch(EN, [{ method: 'GET', url: 'x' }]);
      await h.batch(EN, [{ method: 'PATCH', url: 'y', body: {} }]);
    });
    const b = r.lang.hold((h) => h.batch(FR, [{ method: 'GET', url: 'user-read' }]));
    const c = r.lang.hold((h) => h.batch(EN, [{ method: 'GET', url: 'x' }]));
    await Promise.all([a, b, c, r.lang.restore()]);
    t.eq(r.S.maxBatches, 1, 'one batch at a time');
    t.eq(seen, [FR], 'the user-language read ran in French');
    t.ok(!r.locks.overlap, 'cross-tab lock never held twice');
    t.eq([...new Set(r.locks.names)], ['dxt:lang:o:u', 'dxt:langwin:o:u'], 'the hold lock, and the window lock around each switch');
    t.eq(r.locks.names.filter((n) => n === 'dxt:langwin:o:u').length, 3, 'one window per switching batch, none for the user-language read');
    // The read waited for the first hold's check (a plain re-read of the language, between the batches).
    const ends = r.S.log.flatMap((e, i) => (e === ']' ? [i] : []));
    const starts = r.S.log.flatMap((e, i) => (e === '[' ? [i] : []));
    t.ok(r.S.log.indexOf('GET user-read') > starts[2], 'third batch');
    t.eq(r.S.log.slice(ends[1] + 1, starts[2]), ['GET usersettingscollection(u)?$select=uilanguageid'], 'checked back before the read');
    t.eq(r.S.ui, FR);
  });

  t.test('lang: a read Dataverse did not answer in the asked language is tried once more, then reported', async () => {
    const r = rig();
    r.S.ignoreSwitch = true;
    const b = await r.lang.hold((h) => h.batch(EN, [{ method: 'GET', url: 'x' }]));
    t.eq(b.inLang, false);
    t.eq(r.S.batches.length, 2, 'tried twice');
    // A batch with a write is never sent twice.
    await r.lang.hold((h) => h.batch(EN, [{ method: 'PATCH', url: 'y', body: {} }]));
    t.eq(r.S.batches.length, 3);
    t.eq(r.S.batches[2].signal, undefined, 'a write batch is sent without the cancel signal');
  });

  t.test('lang: a language changed outside the translator is the one put back', async () => {
    const r = rig(EN, FR); // the page started in French; the user has since switched to English elsewhere
    await r.lang.hold((h) => h.batch(DE, [{ method: 'GET', url: 'x' }]));
    await r.lang.restore();
    t.eq(r.S.ui, EN, 'English, as the user set it');
    // The user-language read now switches to the page's language around itself.
    await r.lang.hold((h) => h.batch(FR, [{ method: 'GET', url: 'x' }]));
    t.eq(shape(r.S.batches.at(-1)!.parts)[1], 'PATCH usersettingscollection(u) 1036');
    await r.lang.restore();
    t.eq(r.S.ui, EN);
  });

  t.test('lang: a switch left unfinished by another tab (its marker) is repaired before the next switch', async () => {
    const r = rig(EN, FR); // another tab closed in the middle of its switch to English
    r.storage.setItem(MARK, JSON.stringify({ lcid: FR, to: EN, at: Date.now() }));
    await r.lang.hold((h) => h.batch(DE, [{ method: 'GET', url: 'x' }]));
    await r.lang.restore();
    t.eq(r.S.ui, FR, 'the marker named the user language, not the leftover English');
    t.eq(r.S.log.indexOf('PATCH usersettingscollection(u) {"uilanguageid":1036}') < r.S.log.indexOf('['), true, 'repaired before the batch');
    t.eq(r.storage.getItem(MARK), null);
  });

  t.test('lang: recover() repairs a marker under the lock and leaves no marker; without one it sends nothing', async () => {
    const r = rig(EN, FR);
    t.eq(await LangSession.recover(r.ctx as never, r.env), 0, 'no marker');
    t.eq(r.S.log, [], 'nothing sent');
    r.storage.setItem(MARK, JSON.stringify({ lcid: FR, to: EN, at: Date.now() }));
    t.eq(await LangSession.recover(r.ctx as never, r.env), FR);
    t.eq(r.S.ui, FR);
    t.eq(r.storage.getItem(MARK), null);
    t.eq(r.locks.names, ['dxt:lang:o:u']);
  });

  t.test('lang: run() switches around fn with the marker and the banner, and checks the language back', async () => {
    const r = rig();
    const got = await r.lang.run(EN, async () => {
      t.eq(JSON.parse(r.storage.getItem(MARK) || '{}').lcid, FR, 'marker while switched');
      t.eq(r.lang.active, true);
      return r.S.ui;
    });
    await r.lang.restore();
    t.eq(got, EN, 'fn ran in English');
    t.eq(r.S.ui, FR);
    t.eq(r.changes, [EN, null]);
    t.eq(r.storage.getItem(MARK), null);
  });

  t.test('lang: run() sets the language back when the page goes away (pagehide), never on beforeunload, which also comes before a "Leave site?" prompt the user may stay on', async () => {
    const r = rig();
    const g = globalThis as Record<string, unknown>;
    const had = { window: g.window, fetch: g.fetch };
    const on: Record<string, Array<() => void>> = {};
    const sent: string[] = [];
    try {
      g.window = {
        addEventListener: (n: string, f: () => void) => void (on[n] ??= []).push(f),
        removeEventListener: (n: string, f: () => void) => void (on[n] = (on[n] || []).filter((x) => x !== f)),
      };
      g.fetch = async (_u: string, i: { body: string }) => (sent.push(i.body), new Response(null, { status: 204 }));
      await r.lang.run(EN, async () => {
        for (const f of on.beforeunload || []) f();
        t.eq(sent, [], 'beforeunload: nothing sent, the work goes on in English');
        for (const f of on.pagehide || []) f();
        t.eq(sent, [JSON.stringify({ uilanguageid: FR })], 'pagehide: the user language goes back (keepalive)');
      });
      t.eq([on.pagehide?.length ?? 0, on.beforeunload?.length ?? 0], [0, 0], 'no listener left');
      t.eq(r.S.ui, FR);
    } finally {
      for (const [k, v] of Object.entries(had))
        if (v === undefined) delete g[k];
        else g[k] = v;
    }
  });

  t.test("lang: a repair marker no switch could have written is not trusted: an until far past its time (a clock set back, another script) holds nothing back; a language this environment doesn't have is never switched to", async () => {
    const r = rig(EN, FR);
    const now = Date.now();
    r.storage.setItem(MARK, JSON.stringify({ lcid: FR, to: EN, at: now, until: now + 10 * 86_400_000 }));
    t.eq(await LangSession.recover(r.ctx as never, r.env), FR, 'repaired at once, not waited for for ten days');
    t.eq([r.S.ui, r.storage.getItem(MARK)], [FR, null]);
    const r2 = rig(EN, FR);
    r2.storage.setItem(MARK, JSON.stringify({ lcid: 1049, to: EN, at: now }));
    t.eq(await LangSession.recover(r2.ctx as never, r2.env), 0, 'Russian is not installed here');
    t.eq([r2.S.ui, r2.S.log], [EN, []], 'nothing sent');
    // One written as a switch writes it (until at most LOST_MS after its time) is still waited for.
    const r3 = rig(EN, FR);
    r3.storage.setItem(MARK, JSON.stringify({ lcid: FR, to: EN, at: now, until: now + 60_000 }));
    t.eq([await LangSession.recover(r3.ctx as never, r3.env), r3.S.log], [0, []], 'may still run: left to the session');
  });

  // ---- a language chosen for good: "Show Dynamics in" (core/uilang.ts, LangSession.adoptLanguage) ----

  /** core/uilang's two calls on the fake Dataverse; `heads` gets the headers of each read. */
  const uiApi = (r: ReturnType<typeof rig>, heads: Array<Record<string, string>> = []) => ({
    get: (p: string, h: Record<string, string>) => (heads.push(h), r.S.http.get(p)),
    patch: (p: string, b: unknown) => r.S.http.patch(p, b),
  });

  t.test('lang: setUiLanguage sets the UI and help language (not the locale) and reads it back past every cache until it shows', async () => {
    const r = rig(FR, FR);
    const heads: Array<Record<string, string>> = [];
    await setUiLanguage(uiApi(r, heads), '{U}', EN, { sleep: () => tick() });
    t.eq(r.S.log, ['PATCH usersettingscollection(u) {"uilanguageid":1033,"helplanguageid":1033}', 'GET usersettingscollection(u)?$select=uilanguageid']);
    t.eq([heads, r.S.ui], [[{ Consistency: 'Strong', 'If-None-Match': 'null', 'x-ms-sw-skipcache': '1' }], EN]);
    // Reads that still show the old language are read again; reads that never show it: NotConfirmed (it was sent).
    let stale = 2;
    const lag = { get: async () => ({ uilanguageid: stale-- > 0 ? FR : EN }), patch: async () => ({}) };
    await setUiLanguage(lag, 'u', EN, { sleep: () => tick() });
    t.eq(stale, -1, 'read three times');
    let err: unknown = null;
    await setUiLanguage({ get: async () => ({ uilanguageid: FR }), patch: async () => ({}) }, 'u', EN, { sleep: () => tick() }).catch((e) => (err = e));
    t.ok(err instanceof NotConfirmed, String(err));
    // A help language Dataverse refuses (400): the UI language alone. Any other failure is the caller's to report.
    const sent: unknown[] = [];
    const picky = {
      get: async () => ({ uilanguageid: EN }),
      patch: async (_p: string, b: any) => {
        sent.push(b);
        if ('helplanguageid' in b) throw new DvError('The help language is not valid.', 400);
        return {};
      },
    };
    await setUiLanguage(picky, 'u', EN);
    t.eq(sent, [{ uilanguageid: EN, helplanguageid: EN }, { uilanguageid: EN }]);
    const no = { get: async () => ({ uilanguageid: FR }), patch: async () => Promise.reject(new DvError('You do not have permission to do this.', 403)) };
    err = null;
    await setUiLanguage(no, 'u', EN).catch((e) => (err = e));
    t.eq([(err as DvError)?.status, err instanceof NotConfirmed], [403, false]);
  });

  t.test('lang: adoptLanguage sets the language once no switch window is open, and every later switch goes back to it', async () => {
    const r = rig(FR, FR);
    // A page load is reading English labels (a switch window) when the user chooses German.
    r.S.delay = 20;
    const read = r.lang.hold((h) => h.batch(EN, [{ method: 'GET', url: 'x' }]));
    await tick();
    const chose = r.lang.adoptLanguage(DE, () => setUiLanguage(uiApi(r), 'u', DE, { sleep: () => tick() }));
    await Promise.all([read, chose]);
    const set = r.S.log.indexOf('PATCH usersettingscollection(u) {"uilanguageid":1031,"helplanguageid":1031}');
    t.ok(set > r.S.log.indexOf(']'), 'after the switch window closed: ' + JSON.stringify(r.S.log));
    t.eq([r.S.ui, r.storage.getItem(MARK), r.lang.active], [DE, null, false]);
    await r.lang.hold((h) => h.batch(EN, [{ method: 'GET', url: 'x' }]));
    await r.lang.restore();
    t.eq([shape(r.S.batches.at(-1)!.parts).at(-1), r.S.ui], ['PATCH usersettingscollection(u) 1031', DE], 'back to German, not French');
  });

  t.test("lang: a language chosen for good drops the repair marker: an earlier interrupted switch never puts the old one back", async () => {
    // Another tab closed while it had the user (French) in English for a moment; the user now chooses English for good.
    const r = rig(EN, FR);
    r.storage.setItem(MARK, JSON.stringify({ lcid: FR, to: EN, at: Date.now() }));
    await r.lang.adoptLanguage(EN, () => setUiLanguage(uiApi(r), 'u', EN, { sleep: () => tick() }));
    t.eq([r.S.ui, r.storage.getItem(MARK)], [EN, null]);
    t.eq(await LangSession.recover(r.ctx as never, r.env), 0, 'the next start repairs nothing');
    await r.lang.hold((h) => h.batch(FR, [{ method: 'GET', url: 'x' }]));
    await r.lang.restore();
    t.eq(r.S.ui, EN, 'a switch goes back to English');
    // When setting it fails, nothing changes: the marker stays for its repair.
    const s = rig(EN, FR);
    s.storage.setItem(MARK, JSON.stringify({ lcid: FR, to: EN, at: Date.now() }));
    let err = '';
    await s.lang.adoptLanguage(DE, async () => Promise.reject(new Error('refused'))).catch((e) => (err = e.message));
    t.eq([err, s.storage.getItem(MARK) !== null, s.S.ui], ['refused', true, EN]);
  });

  t.test('lang: the repair marker and the two Web Locks are named by org and user (core/uilang.ts)', () => {
    t.eq([markerKey('o', 'u'), langLock('o', 'u'), windowLock('o', 'u')], [MARK, 'dxt:lang:o:u', 'dxt:langwin:o:u'], "the translator's own names");
  });

  t.test('lang: markerSays repairs only a recent switch the user is still in; one that finished is cleared; an old one is asked about', () => {
    const at = 1_000_000_000;
    const m = { lcid: FR, to: EN, at };
    t.eq(markerSays(m, FR, at + 5), 'clear', 'already back');
    t.eq(markerSays(m, EN, at + 5), 'repair', 'still in the language it switched to');
    t.eq(markerSays(m, DE, at + 5), 'clear', 'the switch finished on the server, and the user chose German since');
    t.eq(markerSays(m, EN, at + MARKER_AGE + 1), 'ask', 'still English long after: the user may have chosen it');
    t.eq(markerSays({ lcid: FR, at }, DE, at + 5), 'repair', 'a marker of an older version (no `to`), recent');
    t.eq(markerSays({ lcid: FR, at }, DE, at + MARKER_AGE + 1), 'ask');
  });

  t.test('lang: recover() leaves a language chosen since an interrupted switch alone, and asks before undoing an old one', async () => {
    // The tab closed during a page load's switch to English; the server switched back; the user then chose German.
    const r = rig(DE, DE);
    r.storage.setItem(MARK, JSON.stringify({ lcid: FR, to: EN, at: Date.now() }));
    t.eq(await LangSession.recover(r.ctx as never, r.env), 0);
    t.eq([r.S.ui, r.storage.getItem(MARK)], [DE, null], 'German kept, marker gone');
    t.ok(!r.S.log.some((e) => e.startsWith('PATCH')), 'nothing written');
    // In English since a switch an hour ago: asked first, and declining keeps English.
    const asked: unknown[] = [];
    r.S.ui = EN;
    const old = () => r.storage.setItem(MARK, JSON.stringify({ lcid: FR, to: EN, at: Date.now() - MARKER_AGE - 1 }));
    old();
    t.eq(await LangSession.recover(r.ctx as never, r.env, (m, now) => (asked.push([m.lcid, now]), false)), 0, 'declined');
    t.eq([asked, r.S.ui, r.storage.getItem(MARK)], [[[FR, EN]], EN, null]);
    old();
    t.eq(await LangSession.recover(r.ctx as never, r.env, () => true), FR, 'accepted');
    t.eq([r.S.ui, r.storage.getItem(MARK)], [FR, null]);
  });

  t.test("lang: another tab's marker for a switch that finished is dropped: the language the user chose since is the one put back", async () => {
    const r = rig(DE, FR); // the page started in French; the user chose German since; a tab's switch to English had finished
    r.storage.setItem(MARK, JSON.stringify({ lcid: FR, to: EN, at: Date.now() }));
    await r.lang.hold((h) => h.batch(EN, [{ method: 'GET', url: 'x' }]));
    await r.lang.restore();
    t.eq([r.S.ui, r.storage.getItem(MARK)], [DE, null], 'German, as the user set it');
    t.ok(!r.S.log.includes('PATCH usersettingscollection(u) {"uilanguageid":1036}'), 'never switched to French');
  });

  t.test('lang: a switching read is never aborted: Stop drops its answer once it has ended and switched back', async () => {
    const r = rig();
    r.S.delay = 20;
    const ac = new AbortController();
    const p = r.lang.hold((h) => h.batch(EN, [{ method: 'GET', url: 'x' }], ac.signal));
    await tick(5);
    ac.abort(); // while the batch runs
    let err: unknown;
    await p.catch((e) => (err = e));
    t.ok(err instanceof DOMException && err.name === 'AbortError', String(err));
    const b = r.S.batches.find((x) => x.parts[0].url.startsWith('usersettings'))!;
    t.eq(b.signal, undefined, 'sent without the signal');
    t.ok(r.S.log.lastIndexOf('PATCH usersettingscollection(u) {"uilanguageid":1036}') > r.S.log.indexOf('GET x'), 'it ran to its switch back');
    await r.lang.restore();
    t.eq([r.S.ui, r.storage.getItem(MARK), r.lang.active], [FR, null, false]);
  });

  t.test('lang: a switching batch whose answer is lost: the language is left alone until it reads back twice; nothing else runs meanwhile', async () => {
    const r = rig();
    r.S.lose = 1;
    r.S.late = 5; // the server switches to English 5 ms after the client saw a network error
    r.S.gap = 60; // and back 60 ms after that
    const lang = new LangSession(r.ctx as never, () => {}, { ...r.env, sleep: (ms: number) => tick(ms / 100) }); // 1.5 s → 15 ms
    const seen: Array<[Lcid, boolean]> = [];
    const get = r.S.http.get;
    r.S.http.get = async (url: string) => {
      const v = await get(url);
      if (url.startsWith('usersettings')) seen.push([r.S.ui, r.storage.getItem(MARK) !== null]);
      return v;
    };
    let user: Lcid | null = null;
    r.S.onPart = (p) => {
      if (p.url === 'user-read') user = r.S.ui;
    };
    let err: unknown;
    const a = lang.hold((h) => h.batch(EN, [{ method: 'GET', url: 'x' }])).catch((e) => (err = e));
    // Another page load's read, queued right behind it, never runs inside the server's switch.
    const b = lang.hold((h) => h.batch(FR, [{ method: 'GET', url: 'user-read' }]));
    await Promise.all([a, b]);
    t.ok(err instanceof DvError && err.code === 'network', String(err));
    t.ok(r.S.log.indexOf('lost]') < r.S.log.indexOf('GET user-read'), `the batch ended first: ${r.S.log.join(' | ')}`);
    t.eq(user, FR, 'the read ran in French');
    t.eq(r.S.log.filter((e) => e === 'PATCH usersettingscollection(u) {"uilanguageid":1036}').length, 1, "only the batch's own switch back: never set back by hand in the middle of it");
    t.ok(seen.some(([l, marked]) => l === EN && marked), 'it saw the server inside the switch, with the marker kept');
    t.eq(seen.slice(-2), [[FR, true], [FR, true]], 'and French twice before the marker went');
    t.eq([r.S.ui, r.storage.getItem(MARK), lang.active], [FR, null, false]);
  });

  t.test('lang: a switching batch whose answer is lost before the server starts it: French read back twice proves nothing; the lock, the window and the marker stay, and the next write never runs inside its late switch', async () => {
    const r = rig();
    const lang = new LangSession(r.ctx as never, () => {}, { ...r.env, sleep: (ms: number) => tick(ms / 100) }); // 1.5 s → 15 ms
    const { batch, get } = r.S.http;
    let lost = false;
    let reads = 0;
    const marked: boolean[] = [];
    r.S.http.batch = async (parts: BatchPart[], o: object) => {
      if (lost || !parts[0].url.startsWith('usersettings')) return batch(parts, o);
      lost = true;
      throw new DvError('Could not reach Dataverse (network error).', 0, 'network');
    };
    r.S.http.get = async (url: string) => {
      const v = await get(url);
      if (lost && url.startsWith('usersettings')) {
        marked.push(r.storage.getItem(MARK) !== null);
        // The server starts the lost batch only now, after two reads of French: English for 40 ms, then back.
        if (++reads === 2) {
          r.S.ui = EN;
          r.S.log.push('late switch');
          setTimeout(() => void ((r.S.ui = FR), r.S.log.push('late switch back')), 40);
        }
      }
      return v;
    };
    let ran: Lcid | null = null;
    r.S.onPart = (p) => {
      if (p.url === 'y') ran = r.S.ui;
    };
    let err: unknown;
    const a = lang.hold((h) => h.batch(EN, [{ method: 'GET', url: 'x' }])).catch((e) => (err = e));
    // The next operation, queued right behind it: a write in the user's own language.
    const b = lang.hold((h) => h.batch(FR, [{ method: 'PATCH', url: 'y', body: {} }]));
    const [, next] = await Promise.all([a, b]);
    t.ok(err instanceof DvError && err.code === 'network', String(err));
    t.eq([ran, next.inLang], [FR, true], `the write ran in French: ${r.S.log.join(' | ')}`);
    t.ok(r.S.log.indexOf('late switch back') < r.S.log.findIndex((e) => e.startsWith('PATCH y')), 'after the late switch was over');
    t.ok(marked.length > 2 && marked.every(Boolean), 'the marker stayed while the batch could still run');
    t.ok(!r.S.log.includes('PATCH usersettingscollection(u) {"uilanguageid":1036}'), 'never set back by hand in the middle of it');
    t.eq([r.S.ui, r.storage.getItem(MARK), lang.active], [FR, null, false]);
  });

  t.test('lang: a lost switching batch never seen to switch is waited for until it can no longer run (LOST_MS, 150 s after it was sent); one Dataverse answered as a whole (turned away, refused, unreadable) has ended, and the language is only checked once', async () => {
    const fails = [
      new DvError('Could not reach Dataverse (network error).', 0, 'network'),
      new DvError('Number of requests exceeded the limit of 6000 over time window of 300 seconds.', 429),
      new DvError('Your Dynamics session has expired. Reload the page and sign in again.', 401),
      new DvError('Dataverse sent an unexpected answer to a batch request.', 0, 'batch'),
    ];
    const got: Array<[number, number]> = [];
    for (const e of fails) {
      const r = rig();
      let waited = 0;
      let clock = 0;
      const lang = new LangSession(r.ctx as never, () => {}, { ...r.env, now: () => clock, sleep: (ms: number) => ((waited += ms), (clock += ms), tick()) });
      const batch = r.S.http.batch;
      r.S.http.batch = async (parts: BatchPart[], o: object) => (parts[0].url.startsWith('usersettings') ? Promise.reject(e) : batch(parts, o));
      let err: unknown;
      await lang.hold((h) => h.batch(EN, [{ method: 'PATCH', url: 'y', body: {} }])).catch((x) => (err = x));
      t.eq([err === e, r.S.ui, r.storage.getItem(MARK), lang.active], [true, FR, null, false], e.message);
      got.push([waited, r.S.log.filter((l) => l.startsWith('GET usersettings')).length]);
    }
    // Read every 1.5 s until 150 s (101 reads), once more at the end, and once by the check after it.
    t.eq(got, [[150_000, 103], [0, 1], [0, 1], [0, 1]]);
  });

  t.test('lang: h.window keeps the switch window across a read and the write built from it: quiet() waits for both', async () => {
    const r = rig();
    r.S.delay = 5;
    const order: string[] = [];
    let q: Promise<unknown> = Promise.resolve();
    await r.lang.hold((h) =>
      h.window(async () => {
        await h.batch(EN, [{ method: 'GET', url: 'x' }]);
        q = r.lang.quiet(async () => void order.push('quiet'));
        await tick(10);
        order.push('read done');
        await h.batch(EN, [{ method: 'PATCH', url: 'y', body: {} }]);
        order.push('write done');
      }),
    );
    await q;
    t.eq(order, ['read done', 'write done', 'quiet']);
    t.eq(r.locks.names.filter((n) => n === 'dxt:langwin:o:u').length, 1, 'one exclusive window for both batches');
    t.eq(r.S.batches.at(-1)!.once, true, 'the write batch is never resent by Http');
    await r.lang.restore();
    t.eq(r.S.ui, FR);
  });

  // ---- the switch window (quiet) ----

  t.test('lang: a switch back that failed is repaired before the window closes; quiet() runs after that, not after the hold', async () => {
    const r = rig();
    r.S.failRestore = 1;
    r.S.delay = 10;
    const seen: Array<[Lcid, boolean]> = [];
    const a = r.lang.hold(async (h) => {
      await h.batch(EN, [{ method: 'GET', url: 'x' }]);
      await tick(25); // the hold goes on with other work
      r.S.log.push('hold done');
    });
    await tick(2);
    const q = r.lang.quiet(async () => {
      seen.push([r.S.ui, r.S.switching]);
      r.S.log.push('quiet');
    });
    await Promise.all([a, q]);
    t.eq(seen, [[FR, false]], 'in French, outside the switch window');
    const at = (e: string) => r.S.log.indexOf(e);
    t.ok(at('PATCH usersettingscollection(u) {"uilanguageid":1036}') < at('quiet'), 'repaired first: ' + r.S.log.join(' | '));
    t.ok(at('quiet') < at('hold done'), 'did not wait for the rest of the hold');
    t.eq(r.storage.getItem(MARK), null);
  });

  t.test('lang: quiet() in another tab never runs inside a switch window, yet runs during the hold', async () => {
    const r = rig();
    r.S.delay = 8;
    const b = r.tab();
    let bad = 0;
    let during = 0;
    let holding = false;
    const a = r.lang.hold(async (h) => {
      holding = true;
      await h.batch(FR, [{ method: 'GET', url: 'u1' }]);
      await h.batch(EN, [{ method: 'GET', url: 'x' }]);
      await h.batch(FR, [{ method: 'GET', url: 'u2' }]);
      await h.batch(EN, [{ method: 'PATCH', url: 'y', body: {} }]);
      await h.batch(FR, [{ method: 'GET', url: 'u3' }]);
      holding = false;
    });
    const n = await meanwhile(a, () =>
      b.quiet(async () => {
        if (r.S.switching || r.S.ui !== FR) bad++;
        if (holding) during++;
        await tick(1);
        if (r.S.switching || r.S.ui !== FR) bad++;
      }),
    );
    await r.lang.restore();
    t.eq(bad, 0, 'never while switched');
    t.ok(during > 0 && n > 3, `ran ${during} of ${n} times during the hold`);
    t.ok(!r.locks.overlap, 'no exclusive window overlapped a shared one');
    t.ok(r.locks.names.includes('dxt:langwin:o:u shared'), 'shared window lock');
    t.eq(r.S.ui, FR);
  });

  t.test("lang: a second tab's user-language read waits for the first tab's switch and its check", async () => {
    const r = rig();
    r.S.delay = 10;
    const b = r.tab();
    const seen: Lcid[] = [];
    r.S.onPart = (p) => {
      if (p.url === 'user-read') seen.push(r.S.ui);
    };
    const a = r.lang.hold(async (h) => {
      await h.batch(EN, [{ method: 'GET', url: 'x' }]);
      await h.batch(EN, [{ method: 'GET', url: 'x' }]);
    });
    await tick(1);
    const rd = b.hold((h) => h.batch(FR, [{ method: 'GET', url: 'user-read' }]));
    await Promise.all([a, rd, r.lang.restore(), b.restore()]);
    t.eq(seen, [FR]);
    t.eq(r.S.maxBatches, 1, 'one batch at a time across tabs');
    t.ok(!r.locks.overlap);
    t.eq([r.S.ui, r.storage.getItem(MARK)], [FR, null]);
    const ends = r.S.log.flatMap((e, i) => (e === ']' ? [i] : []));
    t.eq(r.S.log[ends[1] + 1], 'GET usersettingscollection(u)?$select=uilanguageid', "the first tab's check came before the read");
  });

  t.test('lang: without Web Locks (or when the browser refuses them) the in-tab locks still keep everything apart', async () => {
    for (const locks of [null, { request: () => Promise.reject(new DOMException('Not allowed.', 'SecurityError')) }]) {
      const r = rig();
      r.S.delay = 6;
      const lang = new LangSession(r.ctx as never, () => {}, { storage: r.storage, locks, sleep: () => tick() });
      let bad = 0;
      const seen: Lcid[] = [];
      r.S.onPart = (p) => {
        if (p.url === 'user-read') seen.push(r.S.ui);
      };
      const a = lang.hold(async (h) => {
        await h.batch(EN, [{ method: 'GET', url: 'x' }]);
        await h.batch(EN, [{ method: 'GET', url: 'x' }]);
      });
      const rd = lang.hold((h) => h.batch(FR, [{ method: 'GET', url: 'user-read' }]));
      await meanwhile(Promise.all([a, rd]), () =>
        lang.quiet(async () => {
          if (r.S.switching || r.S.ui !== FR) bad++;
          await tick(1);
        }),
      );
      await lang.restore();
      t.eq([bad, seen, r.S.maxBatches, r.S.ui, r.storage.getItem(MARK)], [0, [FR], 1, FR, null], locks ? 'refused' : 'none');
    }
    // recover() too.
    const r = rig(EN, FR);
    r.storage.setItem(MARK, JSON.stringify({ lcid: FR, to: EN, at: Date.now() }));
    t.eq(await LangSession.recover(r.ctx as never, { storage: r.storage, locks: { request: () => Promise.reject(new Error('no')) } }), FR);
    t.eq([r.S.ui, r.storage.getItem(MARK)], [FR, null]);
  });

  t.test('lang: a cancelled hold that waits for the lock sends nothing', async () => {
    const r = rig();
    r.S.delay = 10;
    const ac = new AbortController();
    const a = r.lang.hold((h) => h.batch(EN, [{ method: 'GET', url: 'x' }]));
    const b = r.lang.hold((h) => h.batch(EN, [{ method: 'GET', url: 'cancelled' }]), ac.signal);
    ac.abort();
    let err: unknown;
    await Promise.all([a, b.catch((e) => (err = e))]);
    t.ok(err instanceof DOMException && err.name === 'AbortError', String(err));
    t.ok(!r.S.log.includes('GET cancelled'));
    await r.lang.restore();
    t.eq(r.S.ui, FR);
  });

  // ---- form XML through LangSession (providers/formxml.ts) ----

  t.test('lang: form load reads the unpublished definition in the user language and, for a form with no unpublished change, the published one in the other language (quick); the form ref is filled in', async () => {
    const r = rig();
    const by = await slotsOf(r);
    t.eq(by.get('tab')!.labels, { [FR]: 'Général', [EN]: 'General' }, 'tab in both languages');
    t.eq(by.get('section')!.labels, { [EN]: 'Details' }, 'section: no French label (the French read fell back to English)');
    t.eq(by.get('field')!.labels, { [EN]: 'Name', [FR]: 'Nom' }, 'cell: every language from the unpublished definition');
    t.eq(by.get('tab')!.ref.partial, undefined, 'complete');
    t.eq([by.get('field')!.entity, by.get('field')!.ref.formType, by.get('field')!.path.slice(0, 2)], ['acc', 2, ['Compte', 'Main (Main form)']], 'FormRef filled from the read');
    t.eq(r.S.batches.map((b) => shape(b.parts)), [
      ['PROBE', 'GET systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()'],
      ['GET usersettingscollection(u)', 'PATCH usersettingscollection(u) 1033', 'PROBE', `GET systemforms(${FORM})`, 'PATCH usersettingscollection(u) 1036'],
    ], 'the other language reads the published definition');
    t.ok(r.S.batches[0].parts[1].url.includes('name,type,objecttypecode,versionnumber'), 'one read, no separate form lookup, with the versionnumber');
    await r.lang.restore();
    t.eq(r.S.ui, FR);
  });

  /** A main form's column cells as a form load gives them (`ref.sparse`, with the version read). */
  const cellsOf = async (r: ReturnType<typeof rig>) => (await loadFormXml(r.ctx as never, [{ formId: FORM, entity: '', name: '', type: NaN }], [EN, FR], { signal: new AbortController().signal, progress() {}, lang: r.lang })).filter((s) => s.ref.sparse);
  const ownOf = async (r: ReturnType<typeof rig>, cells: Slot[], signal = new AbortController().signal) => [...(await loadOwnLabels(r.ctx as never, cells, signal))];
  const GCM = 'GET GetClientMetadata(ClientMetadataQuery=@q)';
  const reads = (r: ReturnType<typeof rig>) => r.S.log.filter((x) => x.includes('GetClientMetadata')).length;
  /** The batches sent since the first `n`, by their parts. */
  const since = (r: ReturnType<typeof rig>, n: number) => r.S.batches.slice(n).map((b) => shape(b.parts));
  /** A batch whose `parts` run in English: switched to it and back (the rig's user is French). */
  const inEnglish = (...parts: string[]) => ['GET usersettingscollection(u)', 'PATCH usersettingscollection(u) 1033', 'PROBE', ...parts, 'PATCH usersettingscollection(u) 1036'];
  /** The answers kept in the browser, by key. */
  const keptIn = (storage: ReturnType<typeof memStorage>) => [...storage.m.keys()].filter((k) => k.startsWith('dxt:own:')).sort();
  /** A load of the page asking for the language lock (a read in the user's language). */
  const aLoad = (r: ReturnType<typeof rig>) => r.lang.hold((h) => h.batch(FR, [{ method: 'GET', url: 'load' }]));

  t.test("lang: a form load never reads GetClientMetadata (its switch window is as before); loadOwnLabels reads it for a main form's column cells in the user's language, in a batch of its own without a switch, then in the other language, in a switch window of its own after it: each gets whether it lists a label of the cell's own there (displayname, never the base language's displayname_1033); a read that fails, isn't proven to be in its language or answers without `Labels` leaves that language unknown and keeps nothing of it (LIVE-FINDINGS 114)", async () => {
    await withStorage(async () => {
      const r = rig();
      // Read in French, the cell has no French label of its own (its English one is served instead); in English, it has one.
      r.S.gcm = { [FR]: [{ Id: '{C1}', LabelColumnName: 'displayname_1033', Value: 'Name' }], [EN]: [{ Id: '{C1}', LabelColumnName: 'displayname', Value: 'Name' }] };
      const cells = await cellsOf(r);
      t.eq([cells.map((s) => [s.kind, s.ref.formVersion, s.ref.own]), reads(r)], [[['field', '7', undefined]], 0], 'the load never asks');
      t.eq(since(r, 0), [['PROBE', 'GET systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()'], inEnglish(`GET systemforms(${FORM})`)], "the load's window as before");
      const n = r.S.batches.length;
      t.eq(await ownOf(r, cells), [[cells[0].key, { [EN]: true, [FR]: false }]], 'both languages');
      t.eq(since(r, n), [['PROBE', GCM], inEnglish(GCM)], "the user's language without a switch, then English in a window of its own");
      // The part of the page's own read of the form that holds its labels (LIVE-FINDINGS 114): no x-ms-gcm-object header,
      // which leaves a $batch part's answer empty.
      const q = JSON.parse(decodeURIComponent(r.S.batches[n].parts[1].url.split('@q=')[1]));
      t.eq(q, { MetadataType: 'form', MetadataSubtype: 'Main', EntityLogicalName: 'acc', MetadataId: FORM, MetadataNames: ['{"Exclude":["entity","ribbon","webresource"]}'], GetDefault: false, DependencyDepth: 'OnDemandWithoutContext' });
      t.eq(r.S.batches[n].parts[1].headers, undefined, 'no headers');
      t.eq(r.S.batches[n + 1].parts[3].url, r.S.batches[n].parts[1].url, 'the same query in English');
      await r.lang.restore();
      t.eq(r.S.ui, FR);
    });
    // A read that fails, or isn't proven to be in English (Dynamics ignores the switch; the batch is tried once more, as
    // any read not proven): that language unknown, nothing kept of it.
    const cases: Array<[string, Record<number, unknown[] | null | 'no Labels'>, boolean, Record<number, boolean> | null]> = [
      ['French failing', { [FR]: null, [EN]: [] }, false, { [EN]: false }],
      ['English failing', { [FR]: [], [EN]: null }, false, { [FR]: false }],
      ['English not proven', { [FR]: [], [EN]: [] }, true, { [FR]: false }],
      ['both failing', { [FR]: null, [EN]: null }, false, null],
      ['English without Labels', { [FR]: [], [EN]: 'no Labels' }, false, { [FR]: false }],
    ];
    for (const [why, gcm, ignore, own] of cases) {
      const storage = memStorage();
      await withStorage(async () => {
        const f = rig();
        f.S.gcm = gcm;
        const cells = await cellsOf(f);
        f.S.ignoreSwitch = ignore;
        t.eq([await ownOf(f, cells), keptIn(storage)], [own ? [[cells[0].key, own]] : [], Object.keys(own ?? {}).map((l) => `dxt:own:o:${FORM}:${l}`)], why);
        f.S.ignoreSwitch = false;
        await f.lang.restore();
        t.eq(f.S.ui, FR, why);
      }, storage);
    }
  });

  t.test("lang: loadOwnLabels keeps each answer in the browser, per language, with the published version it describes: a form loaded at that version sends nothing again, no read and no window, also in another UI language; a form loaded with a change not published (the answer is the published form's, and the load's quick read says that isn't the version loaded) gets no version, so nothing is read, kept or known of it until it is published; a new version is read again; a language whose answer is gone or holds something else is read alone; storage that throws keeps nothing, and the reads still give the answer", async () => {
    const storage = memStorage();
    await withStorage(async () => {
      const r = rig();
      r.S.gcm = { [FR]: [{ Id: '{C1}', LabelColumnName: 'displayname', Value: 'Nom' }] };
      let cells = await cellsOf(r);
      t.eq([await ownOf(r, cells), reads(r), keptIn(storage)], [[[cells[0].key, { [EN]: false, [FR]: true }]], 2, [`dxt:own:o:${FORM}:${EN}`, `dxt:own:o:${FORM}:${FR}`]]);
      cells = await cellsOf(r);
      let n = r.S.batches.length;
      t.eq([await ownOf(r, cells), since(r, n)], [[[cells[0].key, { [EN]: false, [FR]: true }]], []], 'loaded again at that version: kept in both languages, nothing sent');
      // Published since: read again.
      r.S.vun = r.S.vpub = 8;
      r.S.gcm = { [FR]: [] };
      cells = await cellsOf(r);
      t.eq([await ownOf(r, cells), reads(r)], [[[cells[0].key, { [EN]: false, [FR]: false }]], 4], 'a new version');
      // A visit with English as the UI language, the same version: both kept, nothing read.
      const e = rig(EN, EN);
      e.S.vun = e.S.vpub = 8;
      t.eq([await ownOf(e, await cellsOf(e)), reads(e)], [[[cells[0].key, { [EN]: false, [FR]: false }]], 0], 'in English');
      // Saved again without publishing: the answer describes the published form, not the one loaded (the load's quick read
      // in English says so), so nothing is read, kept or known (its labels show as loaded) until it is published, then
      // read once.
      r.S.vun = 9;
      cells = await cellsOf(r);
      n = r.S.batches.length;
      t.eq([cells[0].ref.formVersion, await ownOf(r, cells), since(r, n), keptIn(storage).length], [undefined, [], [], 2], 'a change not published');
      r.S.vpub = 9;
      for (const k of [6, 6]) {
        cells = await cellsOf(r);
        t.eq([cells[0].ref.formVersion, await ownOf(r, cells), reads(r)], ['9', [[cells[0].key, { [EN]: false, [FR]: false }]], k], 'published');
      }
      // Something else under French's key: French read again, alone. English's gone: English read again, alone.
      storage.m.set(`dxt:own:o:${FORM}:${FR}`, '{"v":"9","k":"c1"}');
      cells = await cellsOf(r);
      n = r.S.batches.length;
      t.eq([await ownOf(r, cells), since(r, n)], [[[cells[0].key, { [EN]: false, [FR]: false }]], [['PROBE', GCM]]], 'French');
      storage.m.delete(`dxt:own:o:${FORM}:${EN}`);
      cells = await cellsOf(r);
      n = r.S.batches.length;
      t.eq([await ownOf(r, cells), since(r, n)], [[[cells[0].key, { [EN]: false, [FR]: false }]], [inEnglish(GCM)]], 'English');
    }, storage);
    const blocked = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    await withStorage(async () => {
      const r = rig();
      r.S.gcm = { [FR]: [{ Id: '{C1}', LabelColumnName: 'displayname', Value: 'Nom' }] };
      const cells = await cellsOf(r);
      for (const n of [2, 4]) t.eq([await ownOf(r, cells), reads(r)], [[[cells[0].key, { [EN]: false, [FR]: true }]], n], 'storage blocked');
    }, { getItem: blocked, setItem: blocked, removeItem: blocked });
  });

  t.test("lang: loadOwnLabels takes no answer of another version than the one its cells were loaded at, nor keeps it: a form with a change not published, loaded without a read in another language to say so (its field labels only), or one published again since it was loaded", async () => {
    const run = async (o: { fieldsOnly?: boolean; publishedSince?: boolean }) => {
      const storage = memStorage();
      let out: unknown[] = [];
      await withStorage(async () => {
        const r = rig();
        r.S.gcm = { [FR]: [{ Id: '{C1}', LabelColumnName: 'displayname', Value: 'Nom' }], [EN]: [] };
        if (o.fieldsOnly) r.S.vun = 8; // saved without publishing: the published form is version 7
        const cells = o.fieldsOnly
          ? (await loadFormXml(r.ctx as never, [{ formId: FORM, entity: '', name: '', type: NaN }], [EN, FR], { signal: new AbortController().signal, progress() {}, lang: r.lang }, new Set<Kind>(['field']))).filter((s) => s.ref.sparse)
          : await cellsOf(r);
        if (o.publishedSince) r.S.vun = r.S.vpub = 8;
        out = [cells.map((s) => s.ref.formVersion), (await ownOf(r, cells)).map(([k, v]) => [k === cells[0].key ? 'the cell' : k, v]), reads(r), keptIn(storage)];
        await r.lang.restore();
      }, storage);
      return out;
    };
    t.eq(await run({}), [['7'], [['the cell', { [EN]: false, [FR]: true }]], 2, [`dxt:own:o:${FORM}:${EN}`, `dxt:own:o:${FORM}:${FR}`]], 'the version loaded: taken and kept');
    t.eq(await run({ fieldsOnly: true }), [['8'], [], 2, []], 'a change not published');
    t.eq(await run({ publishedSince: true }), [['7'], [], 2, []], 'published again since');
  });

  t.test("lang: the answers kept in the browser (OWN_KEY) stay within a budget: those of the 100 forms of the org written last, each with the time it was written, every language of a form together; one an earlier build kept, without its time, is read as before and goes first; storage that is full makes room the same way, the form written longest ago first, and another org's are never touched", async () => {
    /** localStorage as browsers have it, its keys listed (length, key) in the order written; full past `cap` characters. */
    const listed = () => {
      const m = new Map<string, string>();
      const size = () => [...m].reduce((n, [k, v]) => n + k.length + v.length, 0);
      const s = {
        m,
        cap: Infinity,
        size,
        get length() {
          return m.size;
        },
        key: (i: number) => [...m.keys()][i] ?? null,
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => {
          if (size() - (m.has(k) ? k.length + m.get(k)!.length : 0) + k.length + v.length > s.cap) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
          m.set(k, v);
        },
        removeItem: (k: string) => void m.delete(k),
      };
      return s;
    };
    const kept = (v: string, t?: number) => JSON.stringify({ ...(t === undefined ? {} : { t }), v, k: ['x'.repeat(100)] });
    /** The forms of the org with an answer kept, in the order written. */
    const forms = (s: ReturnType<typeof listed>) => [...new Set([...s.m.keys()].filter((k) => k.startsWith('dxt:own:o:')).map((k) => k.split(':')[3]))];
    /** Loads the rig's form and reads its answers (its English one kept by an earlier build for the version loaded), over `s`. */
    const load = async (s: ReturnType<typeof listed>, cap = false) => {
      let out: unknown[] = [];
      s.m.set(`dxt:own:o:${FORM}:${EN}`, JSON.stringify({ v: '7', k: [] }));
      await withStorage(async () => {
        const r = rig();
        r.S.gcm = { [FR]: [{ Id: '{C1}', LabelColumnName: 'displayname', Value: 'Nom' }], [EN]: [{ Id: '{C1}', LabelColumnName: 'displayname', Value: 'Name' }] };
        const cells = await cellsOf(r);
        if (cap) s.cap = s.size() + 20;
        out = [(await ownOf(r, cells)).map(([, v]) => v), reads(r)];
        await r.lang.restore();
      }, s);
      const fr = JSON.parse(s.m.get(`dxt:own:o:${FORM}:${FR}`) ?? 'null');
      return [...out, typeof fr?.t === 'number' && fr.v === '7' && fr.k.join() === 'c1'];
    };
    // 100 other forms of the org kept: one by an earlier build, then 99 written since, oldest first; one of another org.
    const s = listed();
    for (const l of [EN, FR]) s.m.set(`dxt:own:o:old:${l}`, kept('3'));
    for (let i = 1; i <= 99; i++) for (const l of [EN, FR]) s.m.set(`dxt:own:o:f${i}:${l}`, kept('3', 1000 + i));
    s.m.set(`dxt:own:p:f0:${EN}`, kept('3', 1));
    // English kept by the earlier build: read as before (no request); French read, and kept with its time.
    t.eq(await load(s), [[{ [EN]: false, [FR]: true }], 1, true]);
    const left = forms(s);
    t.eq([left.length, left.includes('old'), left.includes('f1'), left.includes(FORM), s.m.has(`dxt:own:o:old:${EN}`), s.m.has(`dxt:own:p:f0:${EN}`)], [100, false, true, true, false, true], "the earlier build's form goes, in every language; the 99 others and another org's stay");
    // Storage full: the form written longest ago goes, in every language, until the answer fits.
    const full = listed();
    for (let i = 1; i <= 9; i++) for (const l of [EN, FR]) full.m.set(`dxt:own:o:f${i}:${l}`, kept('3', 1000 + i));
    t.eq(await load(full, true), [[{ [EN]: false, [FR]: true }], 1, true]);
    t.eq(forms(full), ['f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', FORM], 'f1 made room');
  });

  t.test("lang: loadOwnLabels reads the other language once the user's language is in, every form in one window, and gives what is known before that window; the window is a hold of its own, so a load that asks for the lock while the user's language is read goes first", async () => {
    await withStorage(async () => {
      const r = rig();
      r.S.gcm = { [FR]: [{ Id: '{C1}', LabelColumnName: 'displayname', Value: 'Nom' }], [EN]: [] };
      const cells = await cellsOf(r);
      // The same cells on a second form.
      const F2 = '5e07410a-0000-4000-8000-000000000072';
      const two = [...cells, ...cells.map((s) => ({ ...s, key: s.key.replace(FORM, F2), ref: { ...s.ref, formId: F2 } }))];
      const n = r.S.batches.length;
      const known: unknown[] = [];
      const own = await loadOwnLabels(r.ctx as never, two, new AbortController().signal, (o) => known.push([[...o], r.S.batches.length - n]));
      t.eq(since(r, n), [['PROBE', GCM], ['PROBE', GCM], inEnglish(GCM, GCM)], "each form in the user's language, then both in one English window");
      t.eq(r.S.batches[n + 2].parts.slice(3, 5).map((p) => JSON.parse(decodeURIComponent(p.url.split('@q=')[1])).MetadataId), [FORM, F2]);
      t.eq(known, [[two.map((s) => [s.key, { [FR]: true }]), 2]], 'French, before the window');
      t.eq([...own], two.map((s) => [s.key, { [EN]: false, [FR]: true }]));
    });
    await withStorage(async () => {
      const r = rig();
      const cells = await cellsOf(r);
      const n = r.S.batches.length;
      let load: Promise<unknown> | undefined;
      r.S.onPart = (p) => void (!load && p.url.includes('GetClientMetadata') && (load = aLoad(r)));
      await ownOf(r, cells);
      await load;
      t.eq(since(r, n), [['PROBE', GCM], ['PROBE', 'GET load'], inEnglish(GCM)], 'the load between the two');
    });
  });

  t.test("lang: a load that starts before the other language's window is sent stops it (AbortError), nothing of it sent, and the user's language is kept, so the read run again sends that window alone; a load that starts once it is sent waits for it, and its answer is kept and given, never read again", async () => {
    await withStorage(async () => {
      const r = rig();
      r.S.gcm = { [FR]: [{ Id: '{C1}', LabelColumnName: 'displayname', Value: 'Nom' }], [EN]: [] };
      const cells = await cellsOf(r);
      const n = r.S.batches.length;
      // A load starts as the window is taken: the window's hold has the lock by then.
      const ac = new AbortController();
      const request = r.locks.request;
      r.locks.request = (name, o, fn) => {
        if (name === windowLock('o', 'u') && o.mode !== 'shared') ac.abort();
        return request(name, o, fn);
      };
      let err: unknown;
      await ownOf(r, cells, ac.signal).catch((e) => (err = e));
      r.locks.request = request;
      t.ok(err instanceof DOMException && err.name === 'AbortError', String(err));
      t.eq(since(r, n), [['PROBE', GCM]], 'nothing of the window sent');
      t.eq(await ownOf(r, cells), [[cells[0].key, { [EN]: false, [FR]: true }]]);
      t.eq(since(r, n), [['PROBE', GCM], inEnglish(GCM)], 'run again: the window alone');
      await r.lang.restore();
      t.eq(r.S.ui, FR);
    });
    await withStorage(async () => {
      const r = rig();
      r.S.gcm = { [FR]: [{ Id: '{C1}', LabelColumnName: 'displayname', Value: 'Nom' }], [EN]: [] };
      const cells = await cellsOf(r);
      const n = r.S.batches.length;
      // A load starts while the window runs.
      const ac = new AbortController();
      let load: Promise<unknown> | undefined;
      r.S.onPart = (p) => void (!load && r.S.switching && p.url.includes('GetClientMetadata') && (ac.abort(), (load = aLoad(r))));
      t.eq(await ownOf(r, cells, ac.signal), [[cells[0].key, { [EN]: false, [FR]: true }]], 'given');
      await load;
      r.S.onPart = undefined;
      t.eq(since(r, n), [['PROBE', GCM], inEnglish(GCM), ['PROBE', 'GET load']], 'the load after the window');
      t.eq([await ownOf(r, cells), reads(r)], [[[cells[0].key, { [EN]: false, [FR]: true }]], 2], 'kept: never read again');
      await r.lang.restore();
      t.eq(r.S.ui, FR);
    });
  });

  t.test("lang: with English the user's language, the French answer read in its window, and then kept, makes a French form label whose text is the column's French name follow its column (Store.follows: empty in the popup, the name its placeholder); the English label of the cell's own doesn't", async () => {
    await withStorage(async () => {
      // No French label of the cell's own: every read fills in the column's French name there (LIVE-FINDINGS 103).
      const r = rig(EN, EN);
      r.S.cell[FR] = r.S.column[FR];
      r.S.gcm = { [EN]: [{ Id: '{C1}', LabelColumnName: 'displayname', Value: 'Name' }], [FR]: [{ Id: '{C1}', LabelColumnName: 'displayname_1033', Value: 'Name' }] };
      const COL = 'attribute|acc.name|DisplayName';
      const page = async () => {
        const st = new Store();
        const cells = await cellsOf(r);
        st.add([...cells, t.slot('attribute', COL, { [EN]: r.S.column[EN], [FR]: r.S.column[FR] })]);
        const key = cells[0].key;
        const before = st.follows(key, FR, EN);
        st.setOwn(await loadOwnLabels(r.ctx as never, cells, new AbortController().signal));
        return [before, st.follows(key, EN, EN), st.follows(key, FR, EN), reads(r)];
      };
      t.eq(await page(), [false, false, true, 2], 'read in its window');
      t.eq(await page(), [false, false, true, 2], 'kept: nothing read');
      await r.lang.restore();
      t.eq(r.S.ui, EN);
    });
  });

  t.test("lang: loadOwnLabels reads an answer whose metadata is an object (the page's own read asks for one) as it reads one whose metadata is a JSON string", async () => {
    for (const gcmObject of [false, true])
      await withStorage(async () => {
        const r = rig();
        r.S.gcmObject = gcmObject;
        r.S.gcm = { [FR]: [{ Id: '{C1}', LabelColumnName: 'displayname', Value: 'Nom' }], [EN]: [] };
        const cells = await cellsOf(r);
        t.eq(await ownOf(r, cells), [[cells[0].key, { [EN]: false, [FR]: true }]], `an object: ${gcmObject}`);
        await r.lang.restore();
      });
  });

  t.test("lang: loadOwnLabels reads a language only where a cell is undecided there (its text is the column's name, Store.fillsIn): none in the user's language, no read without a switch; none in the other one, no window; none anywhere, nothing sent; an answer kept for the version is given all the same", async () => {
    const cases: Array<[string, (s: Slot, l: Lcid) => boolean, Record<number, boolean> | null, string[][]]> = [
      ['in both', () => true, { [EN]: false, [FR]: true }, [['PROBE', GCM], inEnglish(GCM)]],
      ['in English only', (_s, l) => l === EN, { [EN]: false }, [inEnglish(GCM)]],
      ['in French only', (_s, l) => l === FR, { [FR]: true }, [['PROBE', GCM]]],
      ['in neither', () => false, null, []],
    ];
    for (const [why, undecided, own, sent] of cases)
      await withStorage(async () => {
        const r = rig();
        r.S.gcm = { [FR]: [{ Id: '{C1}', LabelColumnName: 'displayname', Value: 'Nom' }], [EN]: [] };
        const cells = await cellsOf(r);
        const n = r.S.batches.length;
        t.eq([...(await loadOwnLabels(r.ctx as never, cells, new AbortController().signal, undefined, undecided))], own ? [[cells[0].key, own]] : [], why);
        t.eq(since(r, n), sent, why);
        await r.lang.restore();
        t.eq(r.S.ui, FR, why);
      });
    await withStorage(async () => {
      const r = rig();
      r.S.gcm = { [FR]: [{ Id: '{C1}', LabelColumnName: 'displayname', Value: 'Nom' }], [EN]: [] };
      const cells = await cellsOf(r);
      await ownOf(r, cells);
      const n = r.S.batches.length;
      t.eq([...(await loadOwnLabels(r.ctx as never, cells, new AbortController().signal, undefined, () => false)), since(r, n)], [[cells[0].key, { [EN]: false, [FR]: true }], []], 'kept');
    });
  });

  // ---- the page's own copies of a form's answer (LIVE-FINDINGS 115) ----

  const EXCL = '{"Exclude":["entity","ribbon","webresource"]}';
  /**
   * The metadata of the part of the page's read of a form that holds its labels: the form (`form`) at version `v`, its
   * cells' labels of their own (`own`, by label key) and a custom control whose resource files are in `lcids`.
   */
  const labelsPart = (v: number, own: Record<string, string>, lcids: number[], form = FORM) => ({
    Forms: [{ FormId: `{${form.toUpperCase()}}`, VersionNumber: v }],
    Labels: [...Object.entries(own).map(([Id, Value]) => ({ Id, LabelColumnName: 'displayname', Value })), { Id: `{${form.toUpperCase()}}`, LabelColumnName: 'name', Value: 'Main' }],
    CustomControls: lcids.map((l) => ({ Name: 'MscrmControls.FieldControls.TextBoxControl', Resources: [{ Name: `cc_MscrmControls.FieldControls.TextBoxControl/strings/TextBoxControl.${l}.resx`, LoadOrder: 0, Type: 5 }] })),
  });
  /** A cached request of the page's read of a form: its MetadataNames part, its answer's metadata (an object, or a JSON string), its table; `bad`: an answer that isn't JSON. */
  interface Cached {
    names: string;
    md: unknown;
    entity?: string;
    bad?: true;
  }
  /**
   * The service worker's caches as CacheStorage gives them (cache name → cached requests), recording the caches opened and
   * the answers read ("<cache> <index>"). `fail`: the call that throws ('keys', 'open'), or 'hang' (keys() never answers).
   */
  const cacheStorage = (all: Record<string, Cached[]>, fail = '') => {
    const opened: string[] = [];
    const read: string[] = [];
    const storage = {
      keys: () => (fail === 'hang' ? new Promise<string[]>(() => {}) : fail === 'keys' ? Promise.reject(new DOMException('The operation is insecure.', 'SecurityError')) : Promise.resolve(Object.keys(all))),
      open: async (n: string) => {
        if (fail === 'open') throw new DOMException('The operation is insecure.', 'SecurityError');
        opened.push(n);
        const q = (x: Cached) => ({ MetadataType: 'form', MetadataSubtype: 'Main', EntityLogicalName: x.entity ?? 'acc', MetadataId: FORM, MetadataNames: [x.names], GetDefault: false });
        const reqs = (all[n] ?? []).map((x, i) => ({ url: `https://org.test/api/data/v9.0/GetClientMetadata(ClientMetadataQuery=@ClientMetadataQuery)?@ClientMetadataQuery=${encodeURIComponent(JSON.stringify(q(x)))}&umv=${i}&mv=1` }));
        return {
          keys: async () => reqs,
          match: async (r: unknown) => {
            const i = reqs.indexOf(r as (typeof reqs)[number]);
            read.push(`${n} ${i}`);
            const x = all[n][i];
            return { ok: true, json: async () => (x.bad ? Promise.reject(new SyntaxError('Unexpected token')) : { Metadata: x.md }) };
          },
        };
      },
    };
    return { storage, opened, read };
  };
  /** Runs `fn` with `storage` as the page's CacheStorage (undefined: the page has none). */
  async function withCaches(storage: unknown, fn: () => Promise<void>): Promise<void> {
    const g = globalThis as { caches?: unknown };
    const had = Object.getOwnPropertyDescriptor(g, 'caches');
    Object.defineProperty(g, 'caches', { configurable: true, value: storage });
    try {
      await fn();
    } finally {
      if (had) Object.defineProperty(g, 'caches', had);
      else delete g.caches;
    }
  }

  t.test("lang: the page's own copies of a form's GetClientMetadata answer (pageOwnLabels, LIVE-FINDINGS 115): newest label cache first (gcm_<n>, not gcm_no_version), only a part that holds labels (a KeepOnly part is never read, even holding the form), per language the first copy its resource files prove, in a language this environment has; a copy with no or several resx languages, without the form, of another table, or not JSON is left out; its metadata an object or a JSON string; taken (knownOwnLabels), the user's language and French need no read, nothing is sent", async () => {
    await withStorage(async () => {
      const r = rig();
      const cells = await cellsOf(r);
      const n = r.S.batches.length;
      const { storage, opened, read } = cacheStorage({
        // Not in number order: the newest is looked at first all the same.
        gcm_200_t_u: [{ names: EXCL, md: labelsPart(6, {}, [FR]) }, { names: EXCL, md: labelsPart(6, {}, [EN]) }],
        // Each a copy that would say no cell has a label of its own, were it taken: with no resx language, a part without
        // labels that holds the form all the same, one without `Labels`, an older English one.
        gcm_310_t_u: [{ names: EXCL, md: labelsPart(7, {}, []) }],
        gcm_300_t_u: [
          { names: '{"KeepOnly":["entity"]}', md: labelsPart(7, {}, [EN]) },
          { names: '{"KeepOnly":["ribbon"]}', md: { Ribbons: [] } },
          { names: '{"KeepOnly":["webresource"]}', md: { WebResources: [] } },
          { names: EXCL, md: null, bad: true },
          { names: EXCL, md: { ...labelsPart(7, {}, [EN]), Labels: undefined } },
          { names: EXCL, md: labelsPart(7, { '{C1}': 'Name' }, [EN, EN]) },
        ],
        gcm_295_t_u: [{ names: EXCL, md: labelsPart(6, {}, [EN]) }],
        gcm_290_t_u: [{ names: EXCL, md: labelsPart(7, {}, [FR, EN]) }],
        gcm_270_t_u: [{ names: EXCL, md: labelsPart(7, {}, [FR], '5e07410a-0000-4000-8000-000000000072') }],
        gcm_260_t_u: [{ names: EXCL, md: labelsPart(7, {}, [FR]), entity: 'other' }],
        gcm_255_t_u: [{ names: EXCL, md: labelsPart(7, {}, [DE]) }],
        gcm_250_t_u: [{ names: EXCL, md: JSON.stringify(labelsPart(7, { '{C1}': 'Nom' }, [FR])) }],
        gcm_100_t_u: [{ names: EXCL, md: labelsPart(5, {}, [FR]) }],
      });
      await withCaches(storage, async () => {
        const copies = await pageOwnLabels(r.ctx as never, FORM, 'acc');
        t.eq(copies, [
          { form: FORM, l: EN, v: '7', k: ['c1'], t: { c1: 'Name' } },
          { form: FORM, l: FR, v: '7', k: ['c1'], t: { c1: 'Nom' } },
        ]);
        t.eq(opened, ['gcm_310_t_u', 'gcm_300_t_u', 'gcm_295_t_u', 'gcm_290_t_u', 'gcm_270_t_u', 'gcm_260_t_u', 'gcm_255_t_u', 'gcm_250_t_u'], 'newest first, until each language has its copy');
        t.eq(read, ['gcm_310_t_u 0', 'gcm_300_t_u 3', 'gcm_300_t_u 4', 'gcm_300_t_u 5', 'gcm_295_t_u 0', 'gcm_290_t_u 0', 'gcm_270_t_u 0', 'gcm_255_t_u 0', 'gcm_250_t_u 0'], "never a part without labels, nor another table's form");
        t.eq([...knownOwnLabels(r.ctx as never, cells, copies)], [[cells[0].key, { [EN]: true, [FR]: true }]], 'taken');
        t.eq(await ownOf(r, cells), [[cells[0].key, { [EN]: true, [FR]: true }]]);
      });
      t.eq(since(r, n), [], 'nothing sent');
    });
    // No French copy: every label cache is looked in, never another cache.
    const one = { gcm_300_t_u: [{ names: EXCL, md: labelsPart(7, {}, [EN]) }] };
    const all = cacheStorage({ ...one, gcm_no_version_t_u: [{ names: EXCL, md: labelsPart(7, {}, [FR]) }], CDN_Resources: [] });
    await withCaches(all.storage, async () => t.eq([(await pageOwnLabels(rig().ctx as never, FORM, 'acc')).map((c) => c.l), all.opened], [[EN], ['gcm_300_t_u']], 'label caches only'));
    // The search fails, or the page has no CacheStorage: none.
    for (const fail of ['keys', 'open']) await withCaches(cacheStorage(one, fail).storage, async () => t.eq(await pageOwnLabels(rig().ctx as never, FORM, 'acc'), [], fail));
    await withCaches(undefined, async () => t.eq(await pageOwnLabels(rig().ctx as never, FORM), [], 'no CacheStorage'));
    // One that never answers: given up after 3 s (30 ms here).
    await fast(() => withCaches(cacheStorage(one, 'hang').storage, async () => t.eq(await pageOwnLabels(rig().ctx as never, FORM, 'acc'), [], 'hangs')));
  });

  t.test("lang: what is known without a request (knownOwnLabels): the page's copies of the version loaded, each kept as its language's answer, so loadOwnLabels reads nothing for it (a French copy serving French), no read and no window; a copy of another version, whose text of a cell isn't the one loaded (a language other than its resource files say, a change not published), or that leaves out a cell whose text there isn't the one a read fills in (`fills`: a label of the cell's own it lacks, LIVE-FINDINGS 113; the column's names not loaded; no `fills`), is not taken, and its language is read; the answers kept for the version too", async () => {
    const copy = (l: Lcid, v: string, own: Record<string, string>): OwnCopy => ({ form: FORM, l, v, k: Object.keys(own), t: own });
    // The rig's cell: English "Name", French "Nom", the user's language French; a label of its own in French only, so its
    // English text is the column's name a read fills in (the column's names "Name" and "Nom du compte").
    const named: Record<number, string> = { [EN]: 'Name', [FR]: 'Nom du compte' };
    const fills = (s: Slot, l: Lcid) => s.labels[l] === named[l];
    const cases: Array<[string, OwnCopy[], Record<number, boolean> | null, string[][], ((s: Slot, l: Lcid) => boolean)?]> = [
      ['both', [copy(EN, '7', {}), copy(FR, '7', { c1: 'Nom' })], { [EN]: false, [FR]: true }, []],
      ['English only', [copy(EN, '7', {})], { [EN]: false }, [['PROBE', GCM]]],
      ['French only', [copy(FR, '7', { c1: 'Nom' })], { [FR]: true }, [inEnglish(GCM)]],
      ['other versions', [copy(EN, '6', {}), copy(FR, '8', { c1: 'Nom' })], null, [['PROBE', GCM], inEnglish(GCM)]],
      ['a text not the one loaded', [copy(EN, '7', { c1: 'Nom' }), copy(FR, '7', { c1: 'Nom' })], { [FR]: true }, [inEnglish(GCM)]],
      ["a label of the cell's own left out", [copy(EN, '7', {}), copy(FR, '7', {})], { [EN]: false }, [['PROBE', GCM]]],
      ["the column's names not loaded", [copy(EN, '7', {}), copy(FR, '7', { c1: 'Nom' })], { [FR]: true }, [inEnglish(GCM)], () => false],
    ];
    for (const [why, copies, known, sent, check = fills] of cases) {
      const storage = memStorage();
      await withStorage(async () => {
        const r = rig();
        r.S.gcm = { [FR]: [{ Id: '{C1}', LabelColumnName: 'displayname', Value: 'Nom' }], [EN]: [] };
        const cells = await cellsOf(r);
        t.eq([[...knownOwnLabels(r.ctx as never, cells, copies, check)], keptIn(storage)], [known ? [[cells[0].key, known]] : [], Object.keys(known ?? {}).map((l) => `dxt:own:o:${FORM}:${l}`)], why);
        const n = r.S.batches.length;
        t.eq([await ownOf(r, cells), since(r, n)], [[[cells[0].key, { [EN]: false, [FR]: true }]], sent], why);
        // Read or taken, kept: known without a request next time, with or without a copy.
        t.eq([...knownOwnLabels(r.ctx as never, cells)], [[cells[0].key, { [EN]: false, [FR]: true }]], why);
        await r.lang.restore();
      }, storage);
    }
    await withStorage(async () => {
      const r = rig();
      const cells = await cellsOf(r);
      t.eq([...knownOwnLabels(r.ctx as never, cells, [copy(EN, '7', {}), copy(FR, '7', { c1: 'Nom' })])], [[cells[0].key, { [FR]: true }]], 'no fills');
      await r.lang.restore();
    });
  });

  t.test('lang: form load of a form with an unpublished change, or one published again between the reads, reads the other language the exact way', async () => {
    const exact = (r: ReturnType<typeof rig>) =>
      r.S.batches.some((b) => { const p = shape(b.parts); return p.includes('PATCH usersettingscollection(u) 1033') && p.includes('GET systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()'); });
    const r = rig();
    r.S.vun = 8; // someone saved the form without publishing it
    r.S.tab[EN] = 'General (unpublished)';
    const by = await slotsOf(r);
    t.eq(by.get('tab')!.labels, { [FR]: 'Général', [EN]: 'General (unpublished)' }, 'the unpublished English tab');
    t.ok(exact(r), 'switched exact read');
    const r2 = rig();
    r2.S.onPart = (p) => {
      if (r2.S.ui === EN && p.url.includes(`systemforms(${FORM})?`)) r2.S.vpub = r2.S.vun = 9; // published again meanwhile
    };
    const by2 = await slotsOf(r2);
    t.eq(by2.get('tab')!.labels, { [FR]: 'Général', [EN]: 'General' });
    t.ok(exact(r2), 'read again the exact way');
    await Promise.all([r.lang.restore(), r2.lang.restore()]);
  });

  t.test('lang: form load without the switch the other language marks tabs not loaded, and a failed switch too', async () => {
    const r = rig();
    const slots = await loadFormXml(r.ctx as never, [{ formId: FORM, entity: 'acc', name: 'Main', type: 2 }], [EN, FR], { signal: new AbortController().signal, progress() {} });
    const tab = slots.find((s) => s.kind === 'tab')!;
    t.eq([tab.labels, tab.ref.partial], [{ [FR]: 'Général' }, true]);
    t.eq(r.S.batches.length, 1, 'user language only, still through the lock');
    const r2 = rig();
    r2.S.ignoreSwitch = true;
    const tab2 = (await slotsOf(r2)).get('tab')!;
    t.eq([tab2.labels, tab2.ref.partial], [{ [FR]: 'Général' }, true], 'English not proven: not loaded, never the French text as English');
  });

  // ---- form load: reading again what failed, the published fallback in every language, the note ----

  t.test('lang: form load reads a language whose read failed once more, after a new wait for the language lock, and then has it', async () => {
    const r = rig();
    r.S.ignoreSwitch = true; // Dynamics does not switch: English is not proven, so not used
    const said: string[] = [];
    let locks = -1;
    const slots = await loadFormXml(r.ctx as never, [{ formId: FORM, entity: '', name: '', type: NaN }], [EN, FR], {
      signal: new AbortController().signal,
      progress: (m) => {
        said.push(m);
        if (/ again$/.test(m)) (r.S.ignoreSwitch = false), (locks = r.locks.names.length);
      },
      lang: r.lang,
    });
    const tab = slots.find((s) => s.kind === 'tab')!;
    t.eq([tab.labels, tab.ref.partial, tab.ref.unread], [{ [FR]: 'Général', [EN]: 'General' }, undefined, undefined], 'read the second time');
    t.eq(said, ['Reading form labels', 'Reading form labels in English', 'Reading form labels in English again']);
    t.ok(locks > 0 && r.locks.names.length > locks, 'the second read waited for the language lock afresh');
    t.eq(formNote(slots), null, 'nothing to report');
    await r.lang.restore();
    t.eq(r.S.ui, FR);
  });

  t.test('lang: a language still not read keeps its labels not loaded with why on them; formNote names the form, the language and the reason; Read again merged with the store completes them', async () => {
    const r = rig();
    r.S.ignoreSwitch = true;
    const signal = new AbortController().signal;
    const slots = await loadFormXml(r.ctx as never, [{ formId: FORM, entity: 'acc', name: 'Main', type: 2 }], [EN, FR], { signal, progress() {}, lang: r.lang });
    const by = new Map(slots.map((s) => [s.kind, s] as [Kind, Slot]));
    const why = 'Dynamics did not answer in English, so its form labels were not used. Try again.';
    t.eq([by.get('tab')!.labels, by.get('tab')!.ref.partial, by.get('tab')!.ref.unread], [{ [FR]: 'Général' }, true, { [EN]: why }], 'English never shown as empty');
    t.eq([by.get('field')!.labels, by.get('field')!.ref.partial], [{ [EN]: 'Name', [FR]: 'Nom' }, undefined], 'cells come in every language with the French read');
    const note = formNote(slots)!;
    t.eq(note, { forms: [{ formId: FORM, entity: 'acc', name: '', type: 2 }], langs: [EN], why: [why] });
    // The Workbench's Read again: only that form, only English, merged with what the store holds.
    r.S.ignoreSwitch = false;
    const st = new Store();
    st.add(slots);
    const n = r.S.batches.length;
    st.add(mergeReads(await loadFormXml(r.ctx as never, note.forms, note.langs, { signal, progress() {}, lang: r.lang }), (k) => st.get(k), [EN, FR]));
    const tab = st.get(by.get('tab')!.key)!;
    t.eq([tab.labels, tab.ref.partial, tab.ref.unread], [{ [EN]: 'General', [FR]: 'Général' }, undefined, undefined]);
    t.eq(formNote(st.slots.values()), null);
    t.ok(r.S.batches.slice(n).every((b) => !shape(b.parts).includes('PATCH usersettingscollection(u) 1031')), 'no other language');
    await r.lang.restore();
  });

  /** A rig whose RetrieveUnpublished does not find the form (404): every read of it falls back to its published definition. */
  const pubOnly = (ui: Lcid = FR) => {
    const r = rig(ui, ui);
    const batch = r.S.http.batch;
    const gone: PartResult = { ok: false, status: 404, data: null, error: 'Resource not found for the segment.', headers: {} };
    r.S.http.batch = async (parts: BatchPart[], o?: unknown) =>
      ((await batch(parts, o)) as PartResult[]).map((x, i) =>
        parts[i].url.includes('RetrieveUnpublishedMultiple') ? { ...x, data: { value: [] } } : parts[i].url.includes('RetrieveUnpublished()') ? gone : x,
      );
    return r;
  };

  t.test("lang: a form RetrieveUnpublished does not find has its tabs and sections read from its published definition in each language; its cells keep the user's language only, with why, and are never asked to be read again", async () => {
    const r = pubOnly();
    const slots = await loadFormXml(r.ctx as never, [{ formId: FORM, entity: '', name: '', type: NaN }], [EN, FR], { signal: new AbortController().signal, progress() {}, lang: r.lang });
    const by = new Map(slots.map((s) => [s.kind, s] as [Kind, Slot]));
    t.eq([by.get('tab')!.labels, by.get('section')!.labels], [{ [EN]: 'General', [FR]: 'Général' }, { [EN]: 'Details' }]);
    t.eq([by.get('tab')!.ref.partial, by.get('section')!.ref.partial], [undefined, undefined], 'tabs and sections: read in every language');
    const cell = by.get('field')!;
    t.eq([cell.labels, cell.ref.partial, cell.ref.unreadable, cell.ref.unread], [{ [FR]: 'Nom' }, true, PUB_ONLY, undefined], 'the cell: French only, English not loaded (never the published English text)');
    t.eq(formNote(slots), null, 'Read again could not change it: nothing to read again');
    t.ok(slots.every((s) => s.readOnly === NO_UNPUB), 'every label read-only: there is no unpublished definition to write over, so a save could only fail');
    const en = r.S.batches.filter((b) => shape(b.parts).includes('PATCH usersettingscollection(u) 1033'));
    t.eq(en.map((b) => shape(b.parts).filter((p) => p.includes('systemforms'))), [[`GET systemforms(${FORM})`]], 'English: the published definition, read once');
    await r.lang.restore();
    t.eq(r.S.ui, FR);
  });

  t.test("lang: a published cell without a label in the reading language comes with its column's name (LIVE-FINDINGS 52): never taken for the form's label", async () => {
    const r = pubOnly();
    r.S.cell = { [FR]: 'Nom' }; // no English label, and English is the base language
    const slots = await loadFormXml(r.ctx as never, [{ formId: FORM, entity: '', name: '', type: NaN }], [EN, FR], { signal: new AbortController().signal, progress() {}, lang: r.lang });
    // The published definition read in English (for the tab) says the cell is “Account Name”, flagged English.
    const en = r.S.batches.filter((b) => shape(b.parts).includes('PATCH usersettingscollection(u) 1033'));
    t.eq(en.map((b) => shape(b.parts).filter((p) => p.includes('systemforms'))), [[`GET systemforms(${FORM})`]], 'English: the published definition');
    const cell = slots.find((s) => s.kind === 'field')!;
    t.eq([cell.labels, cell.ref.partial, cell.ref.unreadable], [{ [FR]: 'Nom' }, true, PUB_ONLY], 'English not loaded, never “Account Name” as its form label');
    t.ok(!Object.values(cell.labels).includes('Account Name'));
    // A load that keeps fields only reads no other language at all (only tabs and sections would need one).
    const r2 = pubOnly();
    const fields = await loadFormXml(r2.ctx as never, [{ formId: FORM, entity: '', name: '', type: NaN }], [EN, FR], { signal: new AbortController().signal, progress() {}, lang: r2.lang }, new Set<Kind>(['field']));
    t.ok(!r2.S.batches.some((b) => shape(b.parts).includes('PATCH usersettingscollection(u) 1033')), 'no language switch');
    t.eq(fields.find((s) => s.kind === 'field')!.labels, { [FR]: 'Nom' });
    await r.lang.restore();
    await r2.lang.restore();
  });

  t.test("lang: a quick view's cell kept per language that a read left in the user's language alone (ref.partial) is read again in every language when the page shows the quick view, once that language can be read; an edit staged on it stays. Known in every language, or one no read can complete (ref.unreadable), it is not read again", async () => {
    const signal = new AbortController().signal;
    const providers = { loadFormXml, loadTables: async () => [], knownOwnLabels: () => new Map(), loadOwnLabels: async () => new Map() };
    /** The page showing the form as a quick view, in a new page loader: the form reads and language switches it sent. */
    const show = async (q: ReturnType<typeof rig>, st: Store) => {
      const ld = new PageLoader({ ctx: q.ctx, providers, store: st, lang: q.lang } as never, () => {});
      const n = q.S.log.length;
      ld.request([WANT_QUICK + FORM]);
      for (let i = 0; i < 400 && ld.busy.size; i++) await new Promise((go) => setTimeout(go, 5));
      return q.S.log.slice(n).filter((x) => /systemforms|GetClientMetadata|^PATCH usersettings/.test(x));
    };
    const r = rig();
    r.S.extra = true; // the timeline's cell: bound to no column, its label is kept per language (as a web resource's)
    r.S.ignoreSwitch = true; // English can't be read
    const st = new Store();
    st.add(await loadFormXml(r.ctx as never, [{ formId: FORM, entity: '', name: '', type: NaN }], [EN, FR], { signal, progress() {}, lang: r.lang }));
    const key = [...st.slots.values()].find((s) => s.kind === 'field' && s.ref?.partial)!.key;
    t.eq([st.get(key)!.labels, !!st.get(key)!.ref.unread?.[EN]], [{ [FR]: 'Texte de la remarque' }, true], 'English not loaded');
    st.set(key, FR, 'Remarques');
    r.S.ignoreSwitch = false; // Dataverse switches again
    const sent = await show(r, st);
    t.ok(sent.some((x) => x.startsWith('PATCH usersettingscollection(u) {"uilanguageid":1033}')), `read in English: ${sent.join(' | ')}`);
    t.eq([st.get(key)!.labels, st.get(key)!.ref.partial, st.value(key, FR), st.isEdited(key)], [{ [EN]: 'Note Text', [FR]: 'Texte de la remarque' }, undefined, 'Remarques', true], 'completed; the staged edit kept');
    t.eq(await show(r, st), [], 'known in every language: nothing read');
    await r.lang.restore();
    t.eq(r.S.ui, FR);
    // A form read through its published fallback: its cells are known in the user's language only for good.
    const p = pubOnly();
    const ps = new Store();
    ps.add(await loadFormXml(p.ctx as never, [{ formId: FORM, entity: '', name: '', type: NaN }], [EN, FR], { signal, progress() {}, lang: p.lang }, new Set<Kind>(['field'])));
    t.ok([...ps.slots.values()].some((s) => s.ref?.partial && s.ref.unreadable === PUB_ONLY));
    t.eq(await show(p, ps), [], 'nothing read');
    await p.lang.restore();
  });

  t.test("lang: a quick view's or a side pane's form read in some languages only (a language the read missed) counts as failed, as the page's own form does: what was read is kept, the bar says so and the request is given up; Try again (PageLoader.retry) reads it again in every language and completes it, an edit staged meanwhile kept, and then has nothing left to read. One no read can complete (ref.unreadable) says nothing", async () => {
    const providers = { loadFormXml, loadTables: async () => [], knownOwnLabels: () => new Map(), loadOwnLabels: async () => new Map() };
    const settle = async (ld: PageLoader) => {
      for (let i = 0; i < 400 && ld.busy.size; i++) await new Promise((go) => setTimeout(go, 5));
    };
    const reads = (q: ReturnType<typeof rig>, from: number) => q.S.log.slice(from).filter((x) => /systemforms|^PATCH usersettings/.test(x));
    const MSG = 'Could not load the form labels in every language.';
    for (const [want, kind] of [[WANT_QUICK, 'field'], [WANT_FORM, 'tab']] as const) {
      const r = rig();
      r.S.extra = true; // the timeline's cell: bound to no column, its label is kept per language (as a web resource's)
      r.S.ignoreSwitch = true; // English can't be read
      const st = new Store();
      const ld = new PageLoader({ ctx: r.ctx, providers, store: st, lang: r.lang } as never, () => {});
      ld.request([want + FORM]);
      await settle(ld);
      const key = [...st.slots.values()].find((s) => s.kind === kind && s.ref?.partial)!.key;
      t.eq([[...ld.errors.values()], [...ld.gaveUp], st.get(key)!.labels[EN] ?? null, !!st.get(key)!.labels[FR]], [[MSG], [want + FORM], null, true], `${kind}: failed, what was read kept`);
      st.set(key, FR, 'Modifié');
      r.S.ignoreSwitch = false; // Dataverse switches again
      const n = r.S.log.length;
      ld.retry();
      await settle(ld);
      t.ok(reads(r, n).includes('PATCH usersettingscollection(u) {"uilanguageid":1033}'), `${kind}: read again in English: ${reads(r, n).join(' | ')}`);
      t.eq([[...ld.errors.values()], [...ld.gaveUp], st.get(key)!.ref.partial, !!st.get(key)!.labels[EN], st.value(key, FR), st.isEdited(key)], [[], [], undefined, true, 'Modifié', true], `${kind}: completed, the edit kept`);
      const m = r.S.log.length;
      ld.retry();
      await settle(ld);
      t.eq(reads(r, m), [], `${kind}: nothing left to read`);
      await r.lang.restore();
      t.eq(r.S.ui, FR);
    }
    // A form read through its published fallback: its cells are known in the user's language only for good.
    const p = pubOnly();
    const ps = new Store();
    const pl = new PageLoader({ ctx: p.ctx, providers, store: ps, lang: p.lang } as never, () => {});
    pl.request([WANT_QUICK + FORM]);
    await settle(pl);
    t.ok([...ps.slots.values()].some((s) => s.ref?.partial && s.ref.unreadable === PUB_ONLY));
    t.eq([[...pl.errors.values()], [...pl.gaveUp]], [[], []], 'nothing said, nothing given up');
    const k = p.S.log.length;
    pl.retry();
    await settle(pl);
    t.eq(reads(p, k), [], 'nothing read again');
    await p.lang.restore();
  });

  t.test('lang: a form a read in another language did not bring is read again once; still missing, it says so', async () => {
    const run = async (blankAlways: boolean) => {
      const r = rig();
      r.S.vun = 8; // an unpublished change: English is read the exact way
      let blank = true;
      const batch = r.S.http.batch;
      const gone: PartResult = { ok: false, status: 404, data: null, error: 'Resource not found for the segment.', headers: {} };
      r.S.http.batch = async (parts: BatchPart[], o?: unknown) => {
        const out = (await batch(parts, o)) as PartResult[];
        const en = parts.some((p) => p.url.includes('usersettings') && (p.body as { uilanguageid?: number } | undefined)?.uilanguageid === EN);
        return out.map((x, i) => (blank && en && parts[i].url.includes('RetrieveUnpublished') ? (parts[i].url.includes('Multiple') ? { ...x, data: { value: [] } } : gone) : x));
      };
      const said: string[] = [];
      const slots = await loadFormXml(r.ctx as never, [{ formId: FORM, entity: '', name: '', type: NaN }], [EN, FR], {
        signal: new AbortController().signal,
        progress: (m) => {
          said.push(m);
          if (!blankAlways && / again$/.test(m)) blank = false;
        },
        lang: r.lang,
      });
      await r.lang.restore();
      return { tab: slots.find((s) => s.kind === 'tab')!, said };
    };
    const ok = await run(false);
    t.eq([ok.tab.labels, ok.tab.ref.partial], [{ [EN]: 'General', [FR]: 'Général' }, undefined]);
    t.ok(ok.said.includes('Reading form labels in English again'));
    const ko = await run(true);
    t.eq([ko.tab.labels, ko.tab.ref.partial, ko.tab.ref.unread], [{ [FR]: 'Général' }, true, { [EN]: 'Dynamics did not return the form in that language.' }]);
  });

  /**
   * A LangSession stand-in for loads of many forms: each batch answers in its language with one tab per form (labelled
   * in that language only), unless `fail` names why the whole batch fails. Records the form ids of each batch.
   */
  const many = (fail: (L: Lcid, ids: string[]) => string | null) => {
    const sent: Array<[Lcid, string[]]> = [];
    const row = (id: string, L: Lcid) => ({
      formid: id,
      formxml: `<form><tabs><tab id="{${id}}" name="t"><labels>${LABEL(L, `Tab ${id.slice(-2)} ${L}`)}</labels></tab></tabs></form>`,
      name: `Form ${id.slice(-2)}`,
      type: 2,
      objecttypecode: 'acc',
      iscustomizable: { Value: true },
      ismanaged: false,
    });
    const answer = (L: Lcid, p: BatchPart): PartResult => {
      const ids = p.url.match(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/g) || [];
      return { ok: true, status: 200, headers: {}, data: p.url.includes('RetrieveUnpublishedMultiple') ? { value: ids.map((id) => row(id, L)) } : row(ids[0], L) };
    };
    const lang = {
      hold: async (fn: (h: unknown) => Promise<unknown>) =>
        fn({
          batch: async (L: Lcid, parts: BatchPart[]) => {
            const ids = parts.flatMap((p) => p.url.match(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/g) || []);
            sent.push([L, ids]);
            const why = fail(L, ids);
            if (why) throw new DvError(why, 500);
            return { inLang: true, results: parts.map((p) => answer(L, p)) };
          },
          window: (f: () => Promise<unknown>) => f(),
        }),
    };
    const ctx = { http: { all: async () => [] }, user: FR, base: EN, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] };
    return { sent, lang, ctx };
  };
  const F = [1, 2, 3, 4, 5].map((i) => `5e07410a-0000-4000-8000-0000000000a${i}`);
  const fref = (formId: string, name = '') => ({ formId, entity: 'acc', name, type: 2 });
  const tabsOf = (slots: Slot[]) => slots.map((s) => [s.ref.formId.slice(-2), s.labels, s.ref.partial ?? null, s.ref.unread ?? null]);

  t.test('lang: a language whose batch fails again is read one form at a time: the forms that can be read are, the one that cannot says why', async () => {
    const m = many((L, ids) => (L !== EN ? null : ids.length > 1 ? 'The batch failed.' : ids[0] === F[1] ? 'Form a2 is broken.' : null));
    const said: string[] = [];
    const slots = await loadFormXml(m.ctx as never, F.slice(0, 3).map((id) => fref(id)), [EN, FR], { signal: new AbortController().signal, progress: (x) => said.push(x), lang: m.lang as never });
    t.eq(tabsOf(slots), [
      ['a1', { [EN]: 'Tab a1 1033', [FR]: 'Tab a1 1036' }, null, null],
      ['a2', { [FR]: 'Tab a2 1036' }, true, { [EN]: 'Form a2 is broken.' }],
      ['a3', { [EN]: 'Tab a3 1033', [FR]: 'Tab a3 1036' }, null, null],
    ]);
    t.eq(m.sent.filter(([L]) => L === EN).map(([, ids]) => ids.map((id) => id.slice(-2))), [['a1', 'a2', 'a3'], ['a1', 'a2', 'a3'], ['a1'], ['a2'], ['a3']], 'together, together again, then one at a time');
    t.eq(formNote(slots), { forms: [fref(F[1])], langs: [EN], why: ['Form a2 is broken.'] });
    t.ok(!said.some((x) => /^Loaded with problems/.test(x)), 'every form is there: nothing left out');
  });

  t.test('lang: reading one form at a time stops after three in a row fail; the rest keep that reason', async () => {
    const m = many((L) => (L === EN ? 'The language lock could not be taken.' : null));
    const slots = await loadFormXml(m.ctx as never, F.map((id) => fref(id)), [EN, FR], { signal: new AbortController().signal, progress() {}, lang: m.lang as never });
    t.eq(m.sent.filter(([L]) => L === EN).map(([, ids]) => ids.length), [5, 5, 1, 1, 1]);
    t.ok(slots.every((s) => s.ref.partial === true && s.ref.unread?.[EN] === 'The language lock could not be taken.' && !(EN in s.labels)), 'never English as empty');
    t.eq(formNote(slots)!.forms.length, 5);
  });

  t.test("lang: a form the user's language cannot read is read again, then left out and reported; the load fails only when no form could be read", async () => {
    const m = many((L, ids) => (L === FR && ids.includes(F[1]) ? 'Form a2 is broken.' : null));
    const said: string[] = [];
    const slots = await loadFormXml(m.ctx as never, [fref(F[0]), fref(F[1], 'Second'), fref(F[2])], [EN, FR], { signal: new AbortController().signal, progress: (x) => said.push(x), lang: m.lang as never });
    t.eq(slots.map((s) => [s.ref.formId.slice(-2), s.ref.partial ?? null]), [['a1', null], ['a3', null]], 'the others in every language');
    t.eq(said[said.length - 1], 'Loaded with problems. The labels of the form “Second” could not be read: Form a2 is broken.');
    const none = many((L) => (L === FR ? 'Dataverse is not available.' : null));
    let err = '';
    await loadFormXml(none.ctx as never, [fref(F[0]), fref(F[1])], [EN, FR], { signal: new AbortController().signal, progress() {}, lang: none.lang as never }).catch((e) => (err = e.message));
    t.eq(err, 'Dataverse is not available.');
  });

  t.test('lang: mergeReads keeps the languages read before and completes a slot once every language is known; formNote gathers forms, languages and reasons once', () => {
    const tab = (labels: Record<number, string>, ref: Record<string, unknown>, form = 'f'): Slot => ({
      key: `tab|${form}|A|Label`,
      kind: 'tab',
      prop: 'Label',
      entity: 'acc',
      comp: `tab|${form}|A`,
      group: `formxml|${form}`,
      title: 'A',
      path: [],
      sub: '',
      labels,
      readOnly: '',
      baseRequired: false,
      max: 0,
      order: 0,
      ref: { formId: form, formType: 2, ...ref },
    });
    const all = [EN, FR, DE];
    // Held: French (the user's) and German (no label there) read, English failed.
    const had = tab({ [FR]: 'Général', [DE]: '' }, { partial: true, unread: { [EN]: 'The batch failed.' } });
    // Read again asked for English only, and got it: complete, German simply missing.
    const [done] = mergeReads([tab({ [FR]: 'Général', [EN]: 'General' }, { partial: true })], () => had, all);
    t.eq([done.labels, done.ref.partial, done.ref.unread], [{ [EN]: 'General', [FR]: 'Général' }, undefined, undefined]);
    // Failed again: German stays read, English keeps the new reason.
    const [still] = mergeReads([tab({ [FR]: 'Général' }, { partial: true, unread: { [EN]: 'Still failing.' } })], () => had, all);
    t.eq([still.labels, still.ref.partial, still.ref.unread], [{ [FR]: 'Général', [DE]: '' }, true, { [EN]: 'Still failing.' }]);
    // A label known in every language is never made partial by a read that missed one.
    const whole = tab({ [EN]: 'General', [FR]: 'Général' }, {});
    const [kept] = mergeReads([tab({ [FR]: 'Général 2' }, { partial: true, unread: { [EN]: 'x' } })], () => whole, all);
    t.eq([kept.labels, kept.ref.partial], [{ [EN]: 'General', [FR]: 'Général 2' }, undefined]);
    // Nothing held, or a complete fresh slot: taken as it is.
    const fresh = tab({ [FR]: 'X' }, { partial: true });
    t.eq(mergeReads([fresh, whole], () => undefined, all), [fresh, whole]);
    t.eq(
      formNote([
        had,
        tab({ [FR]: 'B' }, { partial: true, unread: { [EN]: 'The batch failed.', [DE]: 'German failed.' } }, 'g'),
        tab({ [FR]: 'C', [EN]: 'Saved since' }, { partial: true, unread: { [EN]: 'Old reason.' } }, 'h'),
        tab({ [FR]: 'D' }, { unread: { [EN]: 'Not partial.' } }, 'i'),
      ]),
      { forms: [fref('f'), fref('g')], langs: [EN, DE], why: ['The batch failed.', 'German failed.'] },
    );
    t.eq(formNote([done, whole]), null);
  });

  t.test('lang: form save writes cells (every language) and the user-language tab in one PATCH, the other language in a switched batch, and verifies', async () => {
    const r = rig();
    const by = await slotsOf(r);
    const o = saveOpts(r);
    const cs = [change(by.get('field')!, EN, 'Full name'), change(by.get('field')!, FR, 'Nom complet'), change(by.get('tab')!, FR, 'Général FR'), change(by.get('tab')!, EN, 'Overview'), change(by.get('section')!, FR, 'Détails')];
    const n = r.S.batches.length;
    const res = await formXmlWriter.save(r.ctx as never, cs, o);
    t.eq(res.map((x) => x.outcome), ['saved', 'saved', 'saved', 'saved', 'saved'], JSON.stringify(res.map((x) => x.message)));
    t.eq([r.S.cell, r.S.tab, r.S.section], [{ [EN]: 'Full name', [FR]: 'Nom complet' }, { [EN]: 'Overview', [FR]: 'Général FR' }, { [EN]: 'Details', [FR]: 'Détails' }]);
    const sent = r.S.batches.slice(n).map((b) => shape(b.parts));
    t.eq(sent, [
      ['PROBE', `GET systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`, `GET systemforms(${FORM})`],
      // The whole unpublished form right before each PATCH (a save someone else made since the read shows there).
      ['PROBE', `GET systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`, `PATCH systemforms(${FORM})`, `GET systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`],
      ['GET usersettingscollection(u)', 'PATCH usersettingscollection(u) 1033', 'PROBE', `GET systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`, `GET systemforms(${FORM})`, 'PATCH usersettingscollection(u) 1036'],
      ['GET usersettingscollection(u)', 'PATCH usersettingscollection(u) 1033', 'PROBE', `GET systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`, `PATCH systemforms(${FORM})`, `GET systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`, 'PATCH usersettingscollection(u) 1036'],
    ]);
    t.eq(r.S.batches.slice(n)[1].parts[2].headers, { 'If-Match': 'W/"100"' }, 'published etag');
    t.eq([...o.publish.entities], ['acc']);
    await r.lang.restore();
    t.eq(r.S.ui, FR);
  });

  t.test('lang: a form or dashboard from a managed solution: every label of it loads read-only with the managed reason, whatever its managed properties allow; its save is refused as loaded (nothing read, no switch) and as read right before the write (no form PATCH in any language)', async () => {
    const r = rig();
    r.S.managed = true;
    const by = await slotsOf(r);
    t.eq([...by.values()].map((s) => [s.kind, s.readOnly, s.ref.managed]), [['tab', MANAGED, true], ['section', MANAGED, true], ['field', MANAGED, true]]);
    const dash = await loadFormXml(r.ctx as never, [{ formId: FORM, entity: 'none', name: 'Main', type: 0 }], [FR], { signal: new AbortController().signal, progress() {}, lang: r.lang });
    t.eq(dash.map((s) => [s.kind, s.readOnly]), [['dtab', MANAGED], ['dsection', MANAGED], ['dfield', MANAGED]]);
    // Loaded so: refused before anything is read or switched.
    const n = r.S.batches.length;
    const res = await formXmlWriter.save(r.ctx as never, [change(by.get('field')!, FR, 'Nom 2'), change(by.get('tab')!, EN, 'Overview')], saveOpts(r));
    t.eq(res.map((x) => [x.outcome, x.message]), [['error', MANAGED], ['error', MANAGED]]);
    t.eq(r.S.batches.length, n, 'nothing read, nothing switched');
    // Loaded as this environment's, read as a managed solution's right before the write: refused in every language.
    r.S.managed = false;
    const un = await slotsOf(r);
    t.eq([...un.values()].map((s) => s.readOnly), ['', '', '']);
    r.S.managed = true;
    const m = r.S.batches.length;
    const res2 = await formXmlWriter.save(r.ctx as never, [change(un.get('field')!, FR, 'Nom 2'), change(un.get('tab')!, EN, 'Overview')], saveOpts(r));
    t.eq(res2.map((x) => [x.outcome, x.message]), [['error', MANAGED], ['error', MANAGED]]);
    t.ok(r.S.batches.slice(m).some((b) => b.parts.some((p) => p.method === 'GET' && /RetrieveUnpublished\(\)\?\$select=[^&]*\bismanaged\b/.test(p.url))), 'the read right before the write asks for ismanaged');
    t.ok(!r.S.batches.slice(m).some((b) => b.parts.some((p) => p.method === 'PATCH' && p.url.includes('systemforms'))), 'no form PATCH sent');
    t.eq([r.S.cell, r.S.tab], [{ [EN]: 'Name', [FR]: 'Nom' }, { [EN]: 'General', [FR]: 'Général' }]);
    await r.lang.restore();
    t.eq(r.S.ui, FR);
  });

  t.test('lang: a form from a managed solution where this session allows changes to managed labels (Ctx.managedEdits): its labels load editable, both reasons kept; the Workbench brings it without read-only labels asked for; its save writes the form, also read as managed right before the write', async () => {
    const r = rig();
    (r.ctx as { managedEdits?: boolean }).managedEdits = true;
    r.S.managed = true;
    const by = await slotsOf(r);
    t.eq([...by.values()].map((s) => [s.kind, s.readOnly, s.ref.managed, s.ref.lock, s.ref.held]), [['tab', '', true, '', MANAGED], ['section', '', true, '', MANAGED], ['field', '', true, '', MANAGED]]);
    const all = r.S.http.all;
    r.S.http.all = async (url: string) =>
      url.startsWith('systemforms/') ? [{ formid: FORM, name: 'Main', type: 2, objecttypecode: 'acc', iscustomizable: { Value: true }, ismanaged: true }] : all(url);
    const wb = await loadFormsScope(r.ctx as never, { entities: ['acc'], kinds: new Set<Kind>(['tab', 'section', 'field']) }, { signal: new AbortController().signal, progress() {}, lang: r.lang });
    t.eq(wb.map((s) => [s.kind, s.readOnly]), [['tab', ''], ['section', ''], ['field', '']]);
    r.S.http.all = all;
    const res = await formXmlWriter.save(r.ctx as never, [change(by.get('field')!, FR, 'Nom 2'), change(by.get('tab')!, EN, 'Overview')], saveOpts(r));
    t.eq(res.map((x) => x.outcome), ['saved', 'saved'], JSON.stringify(res.map((x) => x.message)));
    t.eq([r.S.cell[FR], r.S.tab[EN]], ['Nom 2', 'Overview']);
    await r.lang.restore();
    t.eq(r.S.ui, FR);
  });

  t.test('lang: the Workbench leaves a form from a managed solution, or one RetrieveUnpublished does not find, out unless read-only labels are asked for, then shows it read-only; an unmanaged form of the same table is in', async () => {
    const r = rig();
    r.S.managed = true;
    const asked: string[] = [];
    const all = r.S.http.all;
    // The forms of the table: this managed one, as RetrieveUnpublishedMultiple lists it.
    r.S.http.all = async (url: string) =>
      url.startsWith('systemforms/') ? (asked.push(url), [{ formid: FORM, name: 'Main', type: 2, objecttypecode: 'acc', iscustomizable: { Value: true }, ismanaged: r.S.managed }]) : all(url);
    const scope = (includeReadOnly: boolean) => loadFormsScope(r.ctx as never, { entities: ['acc'], kinds: new Set<Kind>(['tab', 'section', 'field']), includeReadOnly }, { signal: new AbortController().signal, progress() {}, lang: r.lang });
    t.eq((await scope(false)).length, 0, 'left out');
    t.ok(asked[0].includes('ismanaged'), asked[0]);
    t.eq((await scope(true)).map((s) => [s.kind, s.readOnly]), [['tab', MANAGED], ['section', MANAGED], ['field', MANAGED]]);
    r.S.managed = false;
    t.eq((await scope(false)).map((s) => [s.kind, s.readOnly]), [['tab', ''], ['section', ''], ['field', '']]);
    await r.lang.restore();
    // A form the listing names but RetrieveUnpublished doesn't find: read-only (nothing to write over), so left out too.
    const p = pubOnly();
    const pall = p.S.http.all;
    p.S.http.all = async (url: string) =>
      url.startsWith('systemforms/') ? [{ formid: FORM, name: 'Main', type: 2, objecttypecode: 'acc', iscustomizable: { Value: true }, ismanaged: false }] : pall(url);
    const pscope = (includeReadOnly: boolean) => loadFormsScope(p.ctx as never, { entities: ['acc'], kinds: new Set<Kind>(['tab', 'section', 'field']), includeReadOnly }, { signal: new AbortController().signal, progress() {}, lang: p.lang });
    t.eq((await pscope(false)).length, 0, 'no unpublished definition: left out');
    t.eq((await pscope(true)).map((s) => [s.kind, s.readOnly]), [['tab', NO_UNPUB], ['section', NO_UNPUB], ['field', NO_UNPUB]]);
    await p.lang.restore();
  });

  t.test("lang: a cell whose control is bound to no column (a timeline) is read per language, as a tab is: each language from its own read, never another language's text as its own; a sub-grid's cell keeps every language from the user's read (LIVE-FINDINGS 102)", async () => {
    const load = async (r: ReturnType<typeof rig>, lang = true) => {
      const slots = await loadFormXml(r.ctx as never, [{ formId: FORM, entity: '', name: '', type: NaN }], [EN, FR], { signal: new AbortController().signal, progress() {}, ...(lang ? { lang: r.lang } : {}) });
      return (id: string) => slots.find((s) => s.ref?.elId === id)!;
    };
    const r = rig();
    r.S.extra = true;
    let cell = await load(r);
    t.eq([cell('c2').labels, cell('c2').ref.partial], [{ [FR]: 'Texte de la remarque', [EN]: 'Note Text' }, undefined], 'the timeline: each language from its own read');
    t.eq(cell('c3').labels, { [EN]: 'Contacts', [FR]: 'Contacts liés' }, 'the sub-grid: every language from the user read');
    t.eq(cell('c2').ref.uniqueName, undefined, 'no Name');
    // Its Name from the form designer, the heading it shows (LIVE-FINDINGS 101): kept on its slot.
    r.S.tlName = 'Timelines';
    cell = await load(r);
    t.eq([cell('c2').ref.uniqueName, cell('c2').labels], ['Timelines', { [FR]: 'Texte de la remarque', [EN]: 'Note Text' }]);
    r.S.tlName = undefined;
    // No French label: the French read brings the English one, flagged as English, never taken as the French text.
    r.S.timeline = { [EN]: 'Note Text' };
    cell = await load(r);
    t.eq(cell('c2').labels, { [EN]: 'Note Text' }, 'French missing');
    // An English user: the French label comes from the French read, the English one from the user's.
    const e = rig(EN, EN);
    e.S.extra = true;
    cell = await load(e);
    t.eq(cell('c2').labels, { [EN]: 'Note Text', [FR]: 'Texte de la remarque' });
    // Without the switch: the user's language only, the rest not loaded (as a tab's).
    cell = await load(e, false);
    t.eq([cell('c2').labels, cell('c2').ref.partial, cell('c3').labels], [{ [EN]: 'Note Text' }, true, { [EN]: 'Contacts', [FR]: 'Contacts liés' }]);
    await Promise.all([r.lang.restore(), e.lang.restore()]);
  });

  t.test("lang: form save writes a timeline cell's label in its own language, switched to it, and checks it there; a sub-grid's rides along with the user's language (LIVE-FINDINGS 102)", async () => {
    const r = rig(EN, EN);
    r.S.extra = true;
    const slots = await loadFormXml(r.ctx as never, [{ formId: FORM, entity: '', name: '', type: NaN }], [EN, FR], { signal: new AbortController().signal, progress() {}, lang: r.lang });
    const cell = (id: string) => slots.find((s) => s.ref?.elId === id)!;
    const n = r.S.batches.length;
    const res = await formXmlWriter.save(r.ctx as never, [change(cell('c2'), FR, 'Chronologie'), change(cell('c2'), EN, 'Timeline'), change(cell('c3'), FR, 'Contacts 2')], saveOpts(r));
    const by = res.map((x) => [`${x.change.slot.ref.elId}#${x.change.lcid}`, x.outcome, x.message]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
    t.eq(by, [[`c2#${EN}`, 'saved', undefined], [`c2#${FR}`, 'saved', undefined], [`c3#${FR}`, 'saved', undefined]]);
    t.eq([r.S.timeline, r.S.grid], [{ [EN]: 'Timeline', [FR]: 'Chronologie' }, { [EN]: 'Contacts', [FR]: 'Contacts 2' }]);
    // The user's language first (the timeline's English, the sub-grid's French), then the French pass, switched.
    const sent = r.S.batches.slice(n).map((b) => shape(b.parts));
    t.eq(sent.map((p) => p.filter((x) => /PATCH/.test(x))), [[], [`PATCH systemforms(${FORM})`], ['PATCH usersettingscollection(u) 1036', 'PATCH usersettingscollection(u) 1033'], ['PATCH usersettingscollection(u) 1036', `PATCH systemforms(${FORM})`, 'PATCH usersettingscollection(u) 1033']]);
    await r.lang.restore();
    t.eq(r.S.ui, EN);
  });

  t.test('lang: form save reports a conflict when the other language changed since it was loaded, and writes nothing for it', async () => {
    const r = rig();
    const by = await slotsOf(r);
    r.S.tab[EN] = 'General (theirs)';
    const res = await formXmlWriter.save(r.ctx as never, [change(by.get('tab')!, EN, 'Overview'), change(by.get('field')!, FR, 'Nom 2')], saveOpts(r));
    t.eq(res.map((x) => [x.change.lcid, x.outcome, x.server]), [[FR, 'saved', undefined], [EN, 'conflict', 'General (theirs)']]);
    t.eq(r.S.tab[EN], 'General (theirs)', 'theirs kept');
    t.eq(r.S.cell[FR], 'Nom 2');
    await r.lang.restore();
  });

  t.test('lang: form save does nothing in a language Dataverse did not switch to; a 412 is read again once', async () => {
    const r = rig();
    const by = await slotsOf(r);
    r.S.ignoreSwitch = true;
    const n = r.S.batches.length;
    const res = await formXmlWriter.save(r.ctx as never, [change(by.get('tab')!, EN, 'Overview')], saveOpts(r));
    t.eq([res[0].outcome, /did not answer in English, so nothing was saved/.test(res[0].message || '')], ['error', true], res[0].message);
    t.ok(!r.S.batches.slice(n).some((b) => b.parts.some((p) => p.method === 'PATCH' && p.url.includes('systemforms'))), 'no form PATCH sent');
    r.S.ignoreSwitch = false;
    r.S.conflict412 = 1;
    const res2 = await formXmlWriter.save(r.ctx as never, [change(by.get('tab')!, EN, 'Overview')], saveOpts(r));
    t.eq(res2[0].outcome, 'saved', 'saved after one fresh read');
    t.eq(r.S.tab[EN], 'Overview');
    await r.lang.restore();
    t.eq(r.S.ui, FR);
  });

  t.test('lang: form save of a label already as asked publishes the form only while it has unpublished changes', async () => {
    const r = rig();
    const by = await slotsOf(r);
    // An earlier save's PATCH landed and its answer was lost: the text is there, unpublished.
    r.S.cell[FR] = 'Nom 2';
    r.S.vun = 8;
    const n = r.S.batches.length;
    const o = saveOpts(r);
    const res = await formXmlWriter.save(r.ctx as never, [change(by.get('field')!, FR, 'Nom 2')], o);
    t.eq([res[0].outcome, [...o.publish.entities]], ['unchanged', ['acc']]);
    t.ok(!r.S.batches.slice(n).some((b) => b.parts.some((p) => p.method === 'PATCH')), 'nothing written');
    t.ok(r.S.batches[n].parts.every((p) => p.url === PROBE.url || p.url.includes('versionnumber')), 'both reads bring the versionnumber');
    // Published since (both versions equal): nothing to publish.
    r.S.vpub = 8;
    const o2 = saveOpts(r);
    const res2 = await formXmlWriter.save(r.ctx as never, [change(by.get('field')!, FR, 'Nom 2')], o2);
    t.eq([res2[0].outcome, [...o2.publish.entities]], ['unchanged', []]);
    await r.lang.restore();
  });

  t.test('lang: a form write whose answer was lost is in the publish set; Try again finds it saved and publishes it', async () => {
    const r = rig();
    const by = await slotsOf(r);
    r.S.dropAnswer = 1;
    const o = saveOpts(r);
    const res = await formXmlWriter.save(r.ctx as never, [change(by.get('field')!, FR, 'Nom 2')], o);
    t.eq([res[0].outcome, /could not be checked/.test(res[0].message || ''), r.S.cell[FR], [...o.publish.entities]], ['error', true, 'Nom 2', ['acc']], res[0].message);
    const o2 = saveOpts(r);
    const res2 = await formXmlWriter.save(r.ctx as never, [change(by.get('field')!, FR, 'Nom 2')], o2);
    t.eq([res2[0].outcome, [...o2.publish.entities]], ['unchanged', ['acc']]);
    await r.lang.restore();
  });

  t.test('lang: form save never resends a write Dataverse turned away: it reads the form again and builds the PATCH from that read', () =>
    fast(async () => {
      const r = rig();
      const by = await slotsOf(r);
      r.S.throttle = 1;
      // Another maker meanwhile renamed the section (posted as read) and added German to the field (a main form's write
      // posts no label of a field it doesn't change: Dataverse keeps it, LIVE-FINDINGS 104).
      r.S.onThrottle = () => {
        r.S.section[EN] = 'Details 2';
        r.S.cell[DE] = 'Name DE';
      };
      const n = r.S.batches.length;
      const res = await formXmlWriter.save(r.ctx as never, [change(by.get('tab')!, EN, 'Overview')], saveOpts(r));
      t.eq(res.map((x) => x.outcome), ['saved'], JSON.stringify(res));
      const sent = r.S.batches.slice(n);
      const isWrite = (p: BatchPart) => p.method === 'PATCH' && p.url.includes('systemforms');
      t.eq(sent.map((b) => (b.parts.some(isWrite) ? 'write' : 'read')), ['read', 'write', 'read', 'write'], 'a new read before the second write');
      t.eq(sent.filter((b) => b.parts.some(isWrite)).map((b) => b.once), [true, true], 'never resent by Http');
      const body = (sent[3].parts.find(isWrite)!.body as { formxml: string }).formxml;
      t.ok(body.includes('description="Details 2"'), 'built from the second read (their section name kept)');
      t.eq([r.S.tab[EN], r.S.section[EN], r.S.cell[DE]], ['Overview', 'Details 2', 'Name DE']);
      await r.lang.restore();
      t.eq([r.S.ui, r.storage.getItem(MARK)], [FR, null]);
    }),
  );

  // ---- saver lanes (core/saver.ts) ----

  /**
   * A saver over fake writers that log "+key" / "-key" around their work and count how many run at once per
   * lane. A 'form' writer works inside a hold and then sends a batch that switches to English ("[key" / "]key"
   * around it); metadata and records writers count the times they found the user switched; 'throw' fails.
   */
  function saverRig(r: ReturnType<typeof rig>, spec: Array<[kinds: Kind[], lane: Writer['lane'], ms: number, mode?: 'form' | 'option' | 'throw']>) {
    const ev: string[] = [];
    const live = new Map<string, number>();
    const most = new Map<string, number>();
    const st = { switched: 0, publishes: 0, atPublish: [] as unknown[] };
    r.S.http.post = async (fn: string) => {
      if (fn === 'PublishXml') {
        st.publishes++;
        st.atPublish.push([...live.values()].reduce((a, b) => a + b, 0), r.S.switching, r.S.ui, r.storage.getItem(MARK));
        ev.push('publish');
      }
      return {};
    };
    const writers: Writer[] = spec.map(([kinds, lane, ms, mode]) => ({
      kinds,
      lane,
      async save(_ctx, cs: Change[], o): Promise<ChangeResult[]> {
        const name = cs[0].slot.key;
        const body = async () => {
          live.set(lane, (live.get(lane) || 0) + 1);
          most.set(lane, Math.max(most.get(lane) || 0, live.get(lane)!));
          ev.push('+' + name);
          const calm = lane === 'metadata' || lane === 'records';
          if (calm && (r.S.switching || r.S.ui !== FR)) st.switched++;
          await tick(ms);
          if (calm && (r.S.switching || r.S.ui !== FR)) st.switched++;
          ev.push('-' + name);
          live.set(lane, live.get(lane)! - 1);
          if (mode === 'throw') throw new DvError('Generic SQL error.', 500);
        };
        if (mode === 'form')
          await o.lang.hold(async (h) => {
            await body();
            ev.push('[' + name);
            await h.batch(EN, [{ method: 'GET', url: 'x' }]);
            ev.push(']' + name);
          });
        else await body();
        o.publish.entities.add('acc');
        return cs.map((change) => ({ change, outcome: 'saved' }));
      },
    }));
    const store = new Store();
    const add = (kind: string, key: string, group = key, ref: Record<string, unknown> = {}) => {
      const s = { ...t.slot(kind, key, { [EN]: 'a', [FR]: 'b' }), group, ref } as Slot;
      store.add([s]);
      store.set(key, FR, 'x ' + key);
    };
    const saver = createSaver(r.ctx as never, store, r.lang, (k) => writers.find((w) => w.kinds.includes(k)));
    const progress: number[] = [];
    const results: string[] = [];
    const save = (publish = true) =>
      saver.save(store.changes(), { signal: new AbortController().signal, publish, onProgress: (p) => progress.push(p.done), onResult: (x) => results.push(`${x.change.slot.key}:${x.outcome}`) });
    return { ev, most, st, store, add, save, progress, results, at: (e: string) => ev.indexOf(e) };
  }

  t.test('lang: saver runs form XML alongside metadata, metadata one at a time, no metadata or record write in a switch window (LIVE-FINDINGS 62), one publish after every write', () =>
    withStorage(async () => {
      const r = rig();
      r.S.delay = 50; // the form's English batch keeps its switch window open ~50 ms
      const x = saverRig(r, [
        [['attribute', 'entity'], 'metadata', 15],
        [['option'], 'metadata', 5, 'option'],
        [['field'], 'xml', 5, 'form'],
        [['view', 'form'], 'records', 5],
      ]);
      x.add('option', 'opt');
      x.add('attribute', 'colA');
      x.add('field', 'cell', 'formxml|' + FORM, { formId: FORM });
      x.add('attribute', 'colB');
      x.add('form', 'fname', 'form|' + FORM.toUpperCase());
      x.add('view', 'vname', 'view|v1');
      const rep = await x.save();
      const { at, ev } = x;
      t.eq(x.most.get('metadata'), 1, 'metadata never two at once');
      t.ok(at('+cell') < at('-colA'), `form XML started while the first metadata write ran: ${ev.join(' ')}`);
      t.ok(at('+colA') < at('+opt') && at('+colB') < at('+opt'), 'PUTs before the option action');
      t.ok(at('+colB') > at('[cell') || at('-colB') < at('[cell') || at('+opt') > at('[cell'), `a metadata write was due around the form's switch window: ${ev.join(' ')}`);
      t.eq(x.st.switched, 0, `none ran while the language was switched: ${ev.join(' ')}`);
      t.ok(at('+fname') > at(']cell'), "the form's name waited for its XML");
      t.ok(at('+vname') < at('-colA'), 'other records ran alongside');
      t.eq([x.st.publishes, ev.at(-1)], [1, 'publish'], 'one publish, last');
      t.eq(x.st.atPublish, [0, false, FR, null], 'nothing written, no switch open, French checked back and the marker cleared when publishing');
      t.eq([rep.saved, rep.published], [6, true]);
      t.eq(x.results.sort(), ['cell:saved', 'colA:saved', 'colB:saved', 'fname:saved', 'opt:saved', 'vname:saved'], 'one result per change');
      t.eq(x.progress.at(-1), 6, 'progress counts every change');
    }),
  );

  t.test("lang: a form posting a cell of a column the same save renames as read (a footer cell, a quick view control, a form whose fields aren't loaded) waits for the metadata lane; a main form whose cells of it are body and header cells goes on beside it", () =>
    withStorage(async () => {
      const COL = 'attribute|e.name|DisplayName';
      /** A save of the name column's English name and of a tab label of the form, its field slots `cells` loaded: whether the form waited for the rename. */
      const waited = async (cells: Array<Record<string, unknown>>) => {
        const x = saverRig(rig(), [
          [['attribute'], 'metadata', 15],
          [['field', 'tab'], 'xml', 5, 'form'],
        ]);
        x.store.add(cells.map((ref, i) => ({ ...t.slot('field', `field|${FORM}|c${i}|Label`), group: 'formxml|' + FORM, baseRequired: false, ref: { formId: FORM, ...ref } }) as Slot));
        x.store.add([{ ...t.slot('attribute', COL), prop: 'DisplayName' } as Slot]);
        x.store.set(COL, EN, 'Full name');
        x.add('tab', 'tab', 'formxml|' + FORM, { formId: FORM });
        await x.save(false);
        return x.at('+tab') > x.at('-' + COL);
      };
      const name = { datafield: 'name', controlId: 'name' };
      t.eq(await waited([{ ...name, area: 'footer' }]), true, 'a footer cell of the column');
      t.eq(await waited([{ datafield: 'name', controlId: 'parent_name', classid: '{5C5600E0-1D6E-4205-A272-BE80DA87FD42}' }]), true, 'a quick view control on it');
      t.eq(await waited([]), true, "a form whose fields aren't loaded");
      t.eq(await waited([{ ...name, sparse: true }, { datafield: 'name', controlId: 'header_name', sparse: true }]), false, 'body and header cells of it: beside it');
      t.eq(await waited([{ datafield: 'phone', controlId: 'phone', area: 'footer' }]), false, 'a footer cell of another column: beside it');
    }),
  );

  t.test('lang: saver runs other documents and the ribbon after every other lane, a failed group never stops the rest, and publishes once at the end', () =>
    withStorage(async () => {
      const r = rig();
      const x = saverRig(r, [
        [['attribute'], 'metadata', 10],
        [['option'], 'metadata', 20, 'throw'],
        [['field'], 'xml', 15, 'form'],
        [['view'], 'records', 30],
        [['stage'], 'doc', 5],
        [['area'], 'doc', 5],
        [['ribbon'], 'ribbon', 5],
      ]);
      x.add('attribute', 'col');
      x.add('option', 'opt');
      x.add('field', 'cell', 'formxml|' + FORM, { formId: FORM });
      x.add('view', 'view');
      x.add('stage', 'bpf');
      x.add('area', 'map');
      x.add('ribbon', 'rib');
      const rep = await x.save();
      const { at, ev } = x;
      const lastOther = Math.max(at('-col'), at('-opt'), at(']cell'), at('-view'));
      t.ok(at('+bpf') > lastOther && at('+map') > at('-bpf') && at('+rib') > at('-map'), ev.join(' '));
      t.eq([x.st.publishes, ev.at(-1)], [1, 'publish']);
      t.eq(x.results.filter((s) => !s.endsWith(':saved')), ['opt:error'], 'only the failed group');
      t.eq([rep.saved, rep.errors, rep.published], [6, 1, true]);
      // Saving without publishing never publishes.
      const r2 = rig();
      const y = saverRig(r2, [[['attribute'], 'metadata', 1]]);
      y.add('attribute', 'col');
      const rep2 = await y.save(false);
      t.eq([y.st.publishes, rep2.saved, rep2.published], [0, 1, false]);
    }),
  );

  t.test('lang: a process name saved from a French UI: its SetLocLabels in a shared quiet() window, then the process update in an exclusive English window with the real locks (no deadlock), the name sent as read, French back after', () =>
    withStorage(async () => {
      const r = rig(); // the user works in French; English is the base language
      const WF = '9a6faaaa-0000-4000-8000-0000000000b1';
      const names: Record<number, string> = { [EN]: 'bpf test', [FR]: 'Processus test' };
      const seen: string[] = [];
      const where = () => (r.S.switching ? 'in a switching batch' : `in ${r.S.ui}`);
      const { get, patch, batch } = r.S.http;
      Object.assign(r.S.http, {
        // The records writer's [read, SetLocLabels, read] batch and the update's [read, PATCH, read] go through the get, post and patch below.
        batch: (parts: BatchPart[], o?: object) => (parts.some((p) => p.url === 'SetLocLabels' || p.url === `workflows(${WF})`) ? batchOf(r.S.http)(parts, o) : batch(parts, o)),
        fn: (name: string, p: { EntityMoniker: { '@odata.id': string }; AttributeName: string }) => `${name}(${p.EntityMoniker['@odata.id']},${p.AttributeName})`,
        get: async (u: string) => {
          // The records writer and the update ask whether the process is from a managed solution first: it is not.
          if (u === `workflows(${WF})?$select=ismanaged`) return { ismanaged: false };
          if (u !== `RetrieveLocLabels(workflows(${WF}),name)`) return get(u);
          await tick();
          return { Label: { LocalizedLabels: Object.entries(names).map(([l, v]) => ({ Label: v, LanguageCode: Number(l) })) } };
        },
        post: async (fn: string, body: { Labels: Array<{ Label: string; LanguageCode: number }> }) => {
          await tick(5);
          seen.push(`${fn} ${where()}`);
          if (fn === 'SetLocLabels') for (const l of body.Labels) names[l.LanguageCode] = l.Label;
          return {};
        },
        patch: async (u: string, body: { name: string }, o: { once?: boolean } = {}) => {
          if (u !== `workflows(${WF})`) return patch(u, body);
          await tick();
          seen.push(`update "${body.name}" ${where()}${o.once ? ' once' : ''}`);
          names[r.S.ui] = body.name; // a PATCH of a localizable column writes the caller's UI language
          return {};
        },
      });
      const store = new Store();
      const slot = {
        ...t.slot('bpf', `bpf|${WF}|Name`, { ...names }),
        prop: 'Name',
        comp: `bpf|${WF}`,
        group: `bpf|${WF}`,
        title: 'Processus test',
        ref: { id: WF, table: 'workflow', entitySet: 'workflows', column: 'name', entity: 'account', managed: false },
      } as Slot;
      store.add([slot]);
      store.set(slot.key, FR, 'Processus FR');
      const saver = createSaver(r.ctx as never, store, r.lang, (k) => (recordsWriter.kinds.includes(k) ? recordsWriter : undefined));
      const save = saver.save(store.changes(), { signal: new AbortController().signal, publish: true, onProgress() {} });
      const rep = await Promise.race([save, tick(3000).then(() => null)]);
      t.ok(rep, 'the save never ended: the process update waited for the quiet() window it ran in');
      t.eq([rep?.saved, rep?.notice, rep?.warning], [1, undefined, undefined]);
      t.eq(seen, ['SetLocLabels in 1036', 'update "bpf test" in 1033 once']);
      t.eq(names, { [EN]: 'bpf test', [FR]: 'Processus FR' }, 'no label changed by the update');
      t.eq([r.S.ui, r.storage.getItem(MARK), r.changes, r.lang.active], [FR, null, [EN, null], false], 'French again, the marker gone');
      t.ok(!r.locks.overlap, 'cross-tab locks never held twice');
      t.eq(r.locks.names.filter((n) => n.startsWith('dxt:langwin')), ['dxt:langwin:o:u shared', 'dxt:langwin:o:u'], 'the write in a shared window, the update in an exclusive one after it');
    }),
  );
}
