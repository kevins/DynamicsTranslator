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
import { formNote, formXmlWriter, loadFormsScope, loadFormXml, mergeReads, NO_UNPUB, PUB_ONLY } from '../../../src/providers/formxml';
import { recordsWriter } from '../../../src/providers/records';
import type { SaveOptions, Writer } from '../../../src/providers/types';
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
  /** The `Labels` GetClientMetadata answers with per UI language (the process names the page shows, LIVE-FINDINGS 85). */
  gcm: Record<number, unknown[]>;
  /** The form is from a managed solution (its ismanaged, in every read of it). */
  managed: boolean;
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
    managed: false,
    http: null,
  };
  // Per-language store: the caller's language, else the base language flagged as such.
  const perLang = (l: Record<number, string>) => (l[S.ui] !== undefined ? LABEL(S.ui, l[S.ui]) : l[EN] !== undefined ? LABEL(EN, l[EN]) : '');
  const xml = () =>
    `<form><tabs><tab id="{A1}" name="general"><labels>${perLang(S.tab)}</labels><columns><column width="100%"><sections><section id="{B1}" name="details"><labels>${perLang(S.section)}</labels>` +
    `<rows><row><cell id="{C1}"><labels>${Object.entries(S.cell)
      .map(([l, t]) => LABEL(Number(l), t))
      .join('')}</labels><control id="name" datafieldname="name" /></cell></row></rows></section></sections></column></columns></tab></tabs></form>`;
  const row = () => ({ formid: FORM, formxml: xml(), name: 'Main', type: 2, objecttypecode: 'acc', iscustomizable: { Value: true }, ismanaged: S.managed, versionnumber: S.vun });
  // The published definition: cells too carry the caller's language only, else the base language flagged as such, else
  // (a label in neither) the column's display name in the caller's language, flagged as if it were the cell's label
  // (LIVE-FINDINGS 52).
  const pubCell = () => perLang(S.cell) || (S.column[S.ui] !== undefined ? LABEL(S.ui, S.column[S.ui]) : '');
  const pubRow = () => ({ ...row(), formxml: xml().replace(/<cell id="\{C1\}"><labels>.*?<\/labels>/, `<cell id="{C1}"><labels>${pubCell()}</labels>`), versionnumber: S.vpub, '@odata.etag': S.pub });
  const ok = (data: any = null, status = 200): PartResult => ({ ok: true, status, data, headers: {} });
  const fail = (status: number, message: string): PartResult => ({ ok: false, status, data: null, error: message, headers: {} });
  /** A form row as a read gets it: ismanaged only where its $select asks for it, so a read that stops asking never sees it. */
  const asked = (u: string, r: any) => {
    if (/[?&]\$select=[^&]*\bismanaged\b/.test(u)) return r;
    const x = { ...r };
    delete x.ismanaged;
    return x;
  };
  /** A form PATCH keeps tab and section labels in the caller's language only, and merges cells per language. */
  const apply = (formxml: string) => {
    const d = new DOMParser().parseFromString(formxml, 'application/xml');
    const labels = (tag: string) => Array.from(d.getElementsByTagName(tag)[0].getElementsByTagName('labels')[0].getElementsByTagName('label'));
    const lab = (el: Element): [number, string] => [Number(el.getAttribute('languagecode')), el.getAttribute('description') || ''];
    for (const [tag, store] of [['tab', S.tab], ['section', S.section]] as const)
      for (const [l, t] of labels(tag).map(lab)) if (l === S.ui) store[l] = t;
    for (const [l, t] of labels('cell').map(lab)) S.cell[l] = t;
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
    if (u.startsWith('GetClientMetadata(') && p.method === 'GET') return ok({ Metadata: JSON.stringify({ Labels: S.gcm[S.ui] ?? [] }) });
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
      r.S.onThrottle = () => void (r.S.cell[DE] = 'Name DE'); // another maker added German meanwhile
      const n = r.S.batches.length;
      const res = await formXmlWriter.save(r.ctx as never, [change(by.get('tab')!, EN, 'Overview')], saveOpts(r));
      t.eq(res.map((x) => x.outcome), ['saved'], JSON.stringify(res));
      const sent = r.S.batches.slice(n);
      const isWrite = (p: BatchPart) => p.method === 'PATCH' && p.url.includes('systemforms');
      t.eq(sent.map((b) => (b.parts.some(isWrite) ? 'write' : 'read')), ['read', 'write', 'read', 'write'], 'a new read before the second write');
      t.eq(sent.filter((b) => b.parts.some(isWrite)).map((b) => b.once), [true, true], 'never resent by Http');
      const body = (sent[3].parts.find(isWrite)!.body as { formxml: string }).formxml;
      t.ok(body.includes('languagecode="1031"'), 'built from the second read (German kept)');
      t.eq([r.S.tab[EN], r.S.cell[DE]], ['Overview', 'Name DE']);
      await r.lang.restore();
      t.eq([r.S.ui, r.storage.getItem(MARK)], [FR, null]);
    }),
  );

  // ---- saver lanes (core/saver.ts) ----

  /** Runs `fn` with a working localStorage (the saver's history journal). */
  const withStorage = async (fn: () => Promise<void>) => {
    const g = globalThis as { localStorage?: unknown };
    const had = Object.getOwnPropertyDescriptor(g, 'localStorage');
    Object.defineProperty(g, 'localStorage', { configurable: true, value: memStorage() });
    try {
      await fn();
    } finally {
      if (had) Object.defineProperty(g, 'localStorage', had);
      else delete g.localStorage;
    }
  };

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
    return { ev, most, st, add, save, progress, results, at: (e: string) => ev.indexOf(e) };
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
