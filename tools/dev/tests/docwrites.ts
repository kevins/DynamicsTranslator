// Unit tests for the whole-document writers (providers/sitemap.ts, bpf.ts, formxml.ts) against someone else saving
// the same document while a save runs, a write Dataverse turned away (throttled) and a write whose answer was lost.
// The sitemap and process writers run on the real Http over a fake fetch (its retries are part of what is tested); the
// form writer on a fake LangSession hold. register() is called by tools/dev/unit.ts.
import { readHistory } from '../../../src/core/history';
import { DvError, Http, type BatchPart, type PartResult } from '../../../src/core/http';
import { baseNameFirst, MANAGED, PublishSet, type Change, type ChangeResult, type Lcid, type Slot } from '../../../src/core/model';
import { createSaver } from '../../../src/core/saver';
import { Store } from '../../../src/core/store';
import { parseXml, serializeXml } from '../../../src/core/xml';
import { bpfWriter } from '../../../src/providers/bpf';
import { formXmlWriter } from '../../../src/providers/formxml';
import { sitemapWriter } from '../../../src/providers/sitemap';
import { changeId, type SaveOptions } from '../../../src/providers/types';
import type { Kit } from './kit';
import { fast } from './lang';

const EN = 1033;
const FR = 1036;
const ORIGIN = 'https://org.test';
const API = `${ORIGIN}/api/data/v9.2/`;
const SM = '0b6f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const WF = '9a6faaaa-0000-4000-8000-0000000000b1';
const STAGE = '15322a8f-0000-4000-8000-000000000054';
const FORM = '5e07410a-0000-4000-8000-000000000071';
const LANGS = [
  { lcid: EN, name: 'English', isBase: true },
  { lcid: FR, name: 'French', isBase: false },
];

// ---- a fake Dataverse behind fetch, for the real Http ----

interface Req {
  method: string;
  /** Relative to the Web API root. */
  url: string;
  headers: Record<string, string>;
  body: any;
}
interface Answer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * A Dataverse answering through `route`. A $batch runs its parts one after another (continue-on-error). `throttle`
 * turns the next requests that write (a PATCH, or a $batch holding one) away whole with 429 before anything runs,
 * calling `onThrottle`; `lose` runs the next such requests and then loses their answer (a network failure).
 * `writes` lists every PATCH that ran, `log` every request ("GET url", "PATCH url", "[" and "]" around a $batch's
 * parts, "429" for one turned away).
 */
function web(route: (r: Req) => Answer) {
  const W = { log: [] as string[], writes: [] as Req[], throttle: 0, lose: 0, onThrottle: undefined as undefined | (() => void) };
  const run = (r: Req): Answer => {
    W.log.push(`${r.method} ${r.url.split('?')[0]}`);
    if (r.method === 'PATCH') W.writes.push(r);
    return route(r);
  };
  const json = (a: Answer) => (a.body === undefined ? '' : JSON.stringify(a.body));
  const fetch = async (input: unknown, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Response> => {
    await new Promise((r) => setTimeout(r, 0));
    const url = String(input).replace(API, '');
    const batch = url === '$batch';
    const parts: Req[] = batch ? parseParts(init.body || '', /boundary=(\S+)/.exec(init.headers['Content-Type'])![1]) : [{ method: init.method, url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined }];
    const writes = parts.some((p) => p.method === 'PATCH');
    if (writes && W.throttle > 0) {
      W.throttle--;
      W.log.push('429');
      W.onThrottle?.();
      return new Response(JSON.stringify({ error: { code: '0x80072322', message: 'Number of requests exceeded the limit of 6000 over time window of 300 seconds.' } }), { status: 429, headers: { 'Retry-After': '1' } });
    }
    const lost = writes && W.lose > 0;
    if (lost) W.lose--;
    if (batch) W.log.push('[');
    const answers = parts.map(run);
    if (batch) W.log.push(']');
    if (lost) throw new TypeError('Failed to fetch');
    if (!batch) {
      const a = answers[0];
      return new Response(a.status === 204 ? null : json(a), { status: a.status, headers: a.headers });
    }
    const b = 'batchresponse_1';
    const text =
      answers.map((a) => `--${b}\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nHTTP/1.1 ${a.status} X\r\nContent-Type: application/json\r\n\r\n${json(a)}\r\n`).join('') + `--${b}--\r\n`;
    return new Response(text, { status: 200, headers: { 'Content-Type': `multipart/mixed; boundary=${b}` } });
  };
  return { W, fetch };
}

/** The parts of a multipart $batch request as Http.batch builds it. */
function parseParts(body: string, boundary: string): Req[] {
  const out: Req[] = [];
  for (const seg of body.split('--' + boundary)) {
    const m = /^(GET|POST|PATCH|PUT|DELETE) (.+) HTTP\/1\.1$/m.exec(seg);
    if (!m) continue;
    const rest = seg.slice(m.index + m[0].length);
    const j = rest.search(/\r?\n\r?\n/);
    const headers: Record<string, string> = {};
    for (const line of rest.slice(0, j).split(/\r?\n/)) if (line.includes(':')) headers[line.slice(0, line.indexOf(':')).trim()] = line.slice(line.indexOf(':') + 1).trim();
    const raw = rest.slice(j).trim();
    out.push({ method: m[1], url: m[2].replace(API, ''), headers, body: raw ? JSON.parse(raw) : undefined });
  }
  return out;
}

/** Runs `fn` with `fetch` answered by the fake, and every wait of a second or more 100 times shorter. */
async function withWeb(f: ReturnType<typeof web>, fn: () => Promise<void>): Promise<void> {
  const g = globalThis as { fetch: unknown };
  const had = g.fetch;
  g.fetch = f.fetch;
  try {
    await fast(fn);
  } finally {
    g.fetch = had;
  }
}

const error = (status: number, message: string): Answer => ({ status, body: { error: { code: '0x80040216', message } } });
const ctxOf = (http: unknown) => ({ http, xrm: null, origin: ORIGIN, org: 'org', orgId: 'docwrites', envType: '', userId: 'u', base: EN, user: EN, langs: LANGS, version: '9.2' }) as never;
/** A LangSession stand-in: no switching (every language is written inline in these documents). */
const LANG = { quiet: <T>(fn: () => Promise<T>) => fn(), run: <T>(_l: Lcid, fn: () => Promise<T>) => fn(), restore: async () => {} } as never;
const opts = (signal = new AbortController().signal): SaveOptions => ({ signal, publish: new PublishSet(), progress() {}, force: new Set<string>(), lang: LANG, allowPublish: true });
const outcomes = (rs: ChangeResult[]) => rs.map((r) => [r.outcome, r.message ?? '']);

// ---- the sitemap ----

const titles = (fr: string) => `<Titles><Title LCID="1033" Title="Sales" />${fr ? `<Title LCID="1036" Title="${fr}" />` : ''}</Titles>`;
const sitemapXml = (fr: string, extra = '') => `<SiteMap><Area Id="sales">${titles(fr)}<Group Id="g1">${extra}</Group></Area></SiteMap>`;

/**
 * One app's sitemap: the unpublished document, the published one (PublishXml copies it), its published etag, and whether
 * it is from a managed solution (both reads answer ismanaged).
 */
function sitemapServer(fr = 'Ventes', xml = sitemapXml(fr)) {
  const S = { un: xml, pub: xml, etag: 'W/"1"', publishes: [] as string[], managed: false };
  const f = web((r) => {
    if (r.method === 'GET' && r.url.startsWith('sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()'))
      return { status: 200, body: { value: r.url.includes(SM) ? [{ sitemapid: SM, sitemapname: 'Sales Hub', sitemapnameunique: 'saleshub', sitemapxml: S.un, ismanaged: S.managed, '@odata.etag': 'W/"u"' }] : [] } };
    if (r.method === 'GET' && r.url.startsWith(`sitemaps(${SM})`)) return { status: 200, body: { sitemapid: SM, sitemapname: 'Sales Hub', sitemapxml: S.pub, ismanaged: S.managed, '@odata.etag': S.etag } };
    if (r.method === 'PATCH' && r.url === `sitemaps(${SM})`) {
      const m = r.headers['If-Match'];
      if (m !== '*' && m !== S.etag) return error(412, "The version of the existing record doesn't match the RowVersion property provided.");
      S.un = r.body.sitemapxml;
      return { status: 204 };
    }
    if (r.method === 'POST' && r.url === 'PublishXml') {
      S.publishes.push(r.body.ParameterXml);
      S.pub = S.un;
      S.etag = `W/"${S.publishes.length + 1}"`;
      return { status: 204 };
    }
    return error(404, 'Resource not found for the segment.');
  });
  return { S, f, ctx: ctxOf(new Http(ORIGIN)) };
}

const areaSlot = (fr = 'Ventes'): Slot => ({
  key: `area|${SM}|sales|Title`,
  kind: 'area',
  prop: 'Title',
  entity: '',
  comp: `area|${SM}|sales`,
  group: `sitemap|${SM}`,
  title: 'Sales',
  path: ['Sales Hub'],
  sub: 'sales',
  labels: { [EN]: 'Sales', ...(fr ? { [FR]: fr } : {}) },
  readOnly: '',
  baseRequired: true,
  max: 0,
  order: 0,
  ref: { sitemapId: SM, id: 'sales' },
});

/** Runs `fn` with a working localStorage (the saver's history journal). */
async function withStorage(fn: (m: Map<string, string>) => Promise<void>): Promise<void> {
  const g = globalThis as { localStorage?: unknown };
  const had = Object.getOwnPropertyDescriptor(g, 'localStorage');
  const m = new Map<string, string>();
  Object.defineProperty(g, 'localStorage', { configurable: true, value: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } });
  try {
    await fn(m);
  } finally {
    if (had) Object.defineProperty(g, 'localStorage', had);
    else delete g.localStorage;
  }
}

// ---- the business process flow ----

const stepLabel = (l: Lcid, t: string) => `<mxswa:StepLabel Description="${t}" LabelId="${STAGE}" LanguageCode="${l}" />`;
function workflow() {
  return {
    name: 'bpf test',
    primaryentity: 'account',
    ismanaged: false,
    iscustomizable: { Value: true },
    xaml: `<Activity designer="before"><mxswa:StepLabels>${stepLabel(EN, 'Stage 1')}</mxswa:StepLabels></Activity>`,
    clientdata: JSON.stringify({ __class: 'StageStep:#Microsoft.Crm.Workflow.ObjectModel', stageId: STAGE, designer: 'before', stepLabels: { list: [{ labelId: STAGE, languageCode: EN, description: 'Stage 1' }] } }),
  };
}

/** One process definition; a PATCH with If-Match is refused as live (LIVE-FINDINGS 29); with `refuse`, every PATCH is refused with that status. */
function bpfServer() {
  const P = { doc: workflow() as Record<string, unknown>, refuse: 0 };
  const f = web((r) => {
    if (r.method === 'GET' && r.url.startsWith(`workflows(${WF})?`)) return { status: 200, body: JSON.parse(JSON.stringify(P.doc)) };
    if (r.method === 'PATCH' && r.url === `workflows(${WF})`) {
      if (r.headers['If-Match']) return error(400, "Optimistic concurrency isn't enabled for entity type WorkflowDependency.");
      if (P.refuse) return error(P.refuse, 'You do not have permission to do this.');
      Object.assign(P.doc, r.body);
      return { status: 204 };
    }
    return error(404, 'Resource not found for the segment.');
  });
  /** Another maker saves the process in the designer: a change outside every StepLabel, in both documents. */
  const maker = () => {
    P.doc.xaml = String(P.doc.xaml).replace('designer="before"', 'designer="theirs"');
    P.doc.clientdata = String(P.doc.clientdata).replace('"designer":"before"', '"designer":"theirs"');
  };
  return { P, f, maker, ctx: ctxOf(new Http(ORIGIN)) };
}

const stageSlot = (): Slot => ({
  key: `stage|${WF}|${STAGE}|Label`,
  kind: 'stage',
  prop: 'Label',
  entity: 'account',
  comp: `stage|${WF}|${STAGE}`,
  group: `bpfxaml|${WF}`,
  title: 'Stage 1',
  path: ['bpf test'],
  sub: '',
  labels: { [EN]: 'Stage 1' },
  readOnly: '',
  baseRequired: true,
  max: 100,
  order: 0,
  ref: { workflowId: WF, labelId: STAGE, managed: false },
});

// ---- the form (formxml.ts writes through a LangSession hold; this one never switches) ----

const LABEL = (l: Lcid, t: string) => `<label description="${t}" languagecode="${l}" />`;
const formXml = (extraTab = '') =>
  `<form><tabs><tab id="{a1}" name="general"><labels>${LABEL(EN, 'General')}</labels><columns><column width="100%"><sections><section id="{b1}" name="details"><labels>${LABEL(EN, 'Details')}</labels>` +
  `<rows><row><cell id="{c1}"><labels>${LABEL(EN, 'Name')}${LABEL(FR, 'Nom')}</labels><control id="name" datafieldname="name" /></cell></row></rows></section></sections></column></columns></tab>${extraTab}</tabs></form>`;

/**
 * A form on a fake Dataverse: a PATCH replaces the whole unpublished definition and moves its versionnumber on; If-Match
 * is compared with the published row (LIVE-FINDINGS 22), so a save of someone else's draft does not change it.
 * `between` runs once a batch that writes arrives, before any of its parts: someone else's save landing between the
 * writer's read and its write. `lose`: the next batches that write run, then their answer is lost (a network failure).
 * `patch`: the status every PATCH part is answered with: 0 runs it and answers nothing for it (a batch answer cut
 * short), 403 and 412 refuse it.
 */
function formServer() {
  const F = { xml: formXml(), v: 7, vpub: 7, etag: 'W/"100"', batches: [] as string[][], between: undefined as undefined | (() => void), lose: 0, patch: undefined as undefined | number };
  const ok = (data: unknown = null, status = 200): PartResult => ({ ok: true, status, data, headers: {} });
  const exec = (p: BatchPart): PartResult => {
    if (p.method === 'GET' && p.url.startsWith(`systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`)) return ok({ formxml: F.xml, versionnumber: F.v });
    if (p.method === 'GET' && p.url.startsWith(`systemforms(${FORM})?`)) return ok({ formid: FORM, versionnumber: F.vpub, '@odata.etag': F.etag });
    if (p.method === 'PATCH' && p.url === `systemforms(${FORM})`) {
      if (F.patch === 403) return { ok: false, status: 403, data: null, error: 'You do not have permission to do this.', headers: {} };
      if (F.patch === 412 || p.headers?.['If-Match'] !== F.etag) return { ok: false, status: 412, data: null, error: 'The version of the existing record does not match.', headers: {} };
      F.xml = (p.body as { formxml: string }).formxml;
      F.v++;
      if (F.patch === 0) return { ok: false, status: 0, data: null, error: 'Dataverse sent no answer for this part of the request.', headers: {} };
      return ok(null, 204);
    }
    return { ok: false, status: 404, data: null, error: 'Resource not found for the segment.', headers: {} };
  };
  const h = {
    async batch(_l: Lcid, parts: BatchPart[]) {
      await new Promise((r) => setTimeout(r, 0));
      F.batches.push(parts.map((p) => `${p.method} ${p.url.split('?')[0]}${p.url.includes('$select=versionnumber') ? ' (version)' : ''}`));
      const writes = parts.some((p) => p.method === 'PATCH');
      if (writes) {
        const b = F.between;
        F.between = undefined;
        b?.();
      }
      const results = parts.map(exec);
      if (writes && F.lose > 0) {
        F.lose--;
        throw new DvError('Could not reach Dataverse (network error).', 0, 'network');
      }
      return { inLang: true, results };
    },
    window: <T>(fn: () => Promise<T>) => fn(),
  };
  /** Another maker saves the form in the designer: a tab added (a whole definition PATCH, so a new version). */
  const maker = () => {
    F.xml = F.xml.replace('</tabs>', `<tab id="{a2}" name="theirs"><labels>${LABEL(EN, 'Theirs')}</labels></tab></tabs>`);
    F.v++;
  };
  const lang = { hold: <T>(fn: (x: typeof h) => Promise<T>) => fn(h), run: <T>(_l: Lcid, fn: () => Promise<T>) => fn(), quiet: <T>(fn: () => Promise<T>) => fn(), restore: async () => {} };
  return { F, maker, lang: lang as never, ctx: ctxOf(null) };
}

const fieldSlot = (): Slot => ({
  key: `field|${FORM}|c1|Label`,
  kind: 'field',
  prop: 'Label',
  entity: 'account',
  comp: `field|${FORM}|c1`,
  group: `formxml|${FORM}`,
  title: 'Name',
  path: ['Account', 'Main (Main form)', 'General', 'Details'],
  sub: 'name',
  labels: { [EN]: 'Name', [FR]: 'Nom' },
  readOnly: '',
  baseRequired: false,
  max: 0,
  order: 0,
  ref: { formId: FORM, elId: 'c1', formType: 2, area: 'body', tag: 'cell', controlId: 'name', datafield: 'name' },
});

const ch = (slot: Slot, lcid: Lcid, before: string, after: string): Change => ({ slot, lcid, before, after });

export function register(t: Kit): void {
  // ---- a sitemap retry must publish what an earlier write may have left unpublished ----

  t.test('doc writes: a sitemap PATCH whose answer was lost, then Try again: the retry publishes the sitemap (one PublishXml), never "published" without it', () =>
    withStorage(async (store) => {
      const { S, f, ctx } = sitemapServer();
      await withWeb(f, async () => {
        const st = new Store();
        const slot = areaSlot();
        st.add([slot]);
        const saver = createSaver(ctx, st, LANG, (k) => (k === 'area' ? sitemapWriter : undefined));
        const run = () => saver.save([ch(slot, FR, 'Ventes', 'Ventes FR')], { signal: new AbortController().signal, publish: true, onProgress() {} });
        f.W.lose = 1; // the PATCH lands; its answer is lost
        const a = await run();
        t.eq([a.saved, a.errors, a.published, S.un.includes('Ventes FR'), S.publishes.length], [0, 1, false, true, 0], 'first run: written, not confirmed, nothing published (nothing was saved)');
        const b = await run();
        t.eq([b.unchanged, b.errors, b.published], [1, 0, true], 'Try again finds it already there');
        t.eq(S.publishes, [`<importexportxml><sitemaps><sitemap>{${SM}}</sitemap></sitemaps></importexportxml>`], 'and publishes the sitemap');
        t.ok(S.pub.includes('Ventes FR'), 'users see it');
        t.ok(store.size > 0, 'journaled');
        t.eq(readHistory(ctx)[0]?.published, true, 'journaled as published once it was');
      });
    }),
  );

  t.test('doc writes: a sitemap label already as asked puts the sitemap in the publish set (it may be an earlier write never published); a write whose answer was lost too', async () => {
    const { S, f, ctx } = sitemapServer('Ventes FR');
    S.pub = sitemapXml('Ventes'); // the text is in the unpublished sitemap only
    await withWeb(f, async () => {
      const o = { ...opts(), ran: new Set<string>() };
      const res = await sitemapWriter.save(ctx, [ch(areaSlot('Ventes'), FR, 'Ventes', 'Ventes FR')], o);
      t.eq([outcomes(res), [...o.publish.sitemaps], [...o.ran]], [[['unchanged', '']], [SM], []], 'nothing sent (SaveOptions.ran)');
      f.W.lose = 1;
      const o2 = { ...opts(), ran: new Set<string>() };
      const lost = ch(areaSlot('Ventes FR'), FR, 'Ventes FR', 'Ventes 2');
      const res2 = await sitemapWriter.save(ctx, [lost], o2);
      t.eq([res2[0].outcome, [...o2.publish.sitemaps], [...o2.ran]], ['error', [SM], [changeId(lost)]], res2[0].message);
      t.eq(f.W.writes.length, 1, 'a write whose answer was lost is never sent again');
      const o3 = { ...opts(), ran: new Set<string>() };
      const sent = ch(areaSlot('Ventes 2'), FR, 'Ventes 2', 'Ventes 3');
      t.eq([outcomes(await sitemapWriter.save(ctx, [sent], o3)), [...o3.ran]], [[['saved', '']], [changeId(sent)]], 'a write that ran');
    });
  });

  // ---- a write Dataverse turned away is never resent as built from the earlier read ----

  t.test('doc writes: a sitemap write turned away (429) is not resent by Http: it is built again from a new read, so a sitemap saved by someone else meanwhile is kept', async () => {
    const { S, f, ctx } = sitemapServer();
    f.W.throttle = 1;
    f.W.onThrottle = () => void (S.un = sitemapXml('Ventes', '<SubArea Id="theirs" Entity="contact" />')); // someone else adds a subarea
    await withWeb(f, async () => {
      const res = await sitemapWriter.save(ctx, [ch(areaSlot(), FR, 'Ventes', 'Ventes FR')], opts());
      t.eq(outcomes(res), [['saved', '']]);
    });
    t.ok(S.un.includes('Ventes FR') && S.un.includes('Id="theirs"'), `both kept: ${S.un}`);
    t.eq(f.W.writes.length, 1, 'one write ran');
    const after = f.W.log.slice(f.W.log.indexOf('429'));
    const read = after.findIndex((e) => e.startsWith('GET sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple'));
    t.ok(read >= 0 && read < after.findIndex((e) => e.startsWith('PATCH')), 'read again before the next write: ' + f.W.log.join(' | '));
  });

  t.test('doc writes: a process write turned away (429) is not resent by Http: it is built again from a new read, so a process saved by someone else meanwhile is kept', async () => {
    const { P, f, maker, ctx } = bpfServer();
    f.W.throttle = 1;
    f.W.onThrottle = maker;
    await withWeb(f, async () => {
      const res = await bpfWriter.save(ctx, [ch(stageSlot(), FR, '', 'Étape 1')], opts());
      t.eq(outcomes(res), [['saved', '']]);
    });
    t.ok(String(P.doc.xaml).includes('designer="theirs"') && String(P.doc.clientdata).includes('"designer":"theirs"'), 'their change kept in both documents');
    t.ok(String(P.doc.xaml).includes('Description="Étape 1"'), 'ours written');
    t.eq(f.W.log.filter((e) => e !== '429'), [`GET workflows(${WF})`, `GET workflows(${WF})`, '[', `GET workflows(${WF})`, `PATCH workflows(${WF})`, `GET workflows(${WF})`, ']'], 'read again, then one batch: read right before, written once, read back');
  });

  t.test('doc writes: Stop while waiting after a write was turned away writes nothing more (sitemap, process)', async () => {
    const sm = sitemapServer();
    const bp = bpfServer();
    for (const [f, save] of [
      [sm.f, (o: SaveOptions) => sitemapWriter.save(sm.ctx, [ch(areaSlot(), FR, 'Ventes', 'Ventes FR')], o)],
      [bp.f, (o: SaveOptions) => bpfWriter.save(bp.ctx, [ch(stageSlot(), FR, '', 'Étape 1')], o)],
    ] as const) {
      const ac = new AbortController();
      f.W.throttle = 1;
      f.W.onThrottle = () => setTimeout(() => ac.abort(), 1);
      let res: ChangeResult[] = [];
      await withWeb(f, async () => void (res = await save(opts(ac.signal))));
      t.eq([outcomes(res), f.W.writes.length], [[['skipped', 'Cancelled before saving.']], 0]);
    }
  });

  t.test('doc writes: a write turned away again and again is tried 3 more times, each from a new read, then reported (sitemap, process)', async () => {
    const sm = sitemapServer();
    sm.f.W.throttle = 4;
    await withWeb(sm.f, async () => {
      const res = await sitemapWriter.save(sm.ctx, [ch(areaSlot(), FR, 'Ventes', 'Ventes FR')], opts());
      t.eq(res[0].outcome, 'error');
      t.ok(/Number of requests exceeded/.test(res[0].message || ''), res[0].message);
    });
    t.eq(sm.f.W.log.filter((e) => e === '429').length, 4);
    const bp = bpfServer();
    bp.f.W.throttle = 4;
    let err: unknown;
    await withWeb(bp.f, () => bpfWriter.save(bp.ctx, [ch(stageSlot(), FR, '', 'Étape 1')], opts()).then(() => {}, (e) => void (err = e)));
    t.eq([(err as { status?: number })?.status, bp.f.W.log.filter((e) => e === '429').length, bp.f.W.log.filter((e) => e.startsWith('GET')).length], [429, 4, 4], 'a read before each try');
  });

  t.test('doc writes: a process write whose answer was lost is never sent again by Http (it may have run), and SaveOptions.ran says so; a write that ran too, never one refused (403) or turned away (429)', async () => {
    const id = changeId(ch(stageSlot(), FR, '', 'Étape 1'));
    const attempt = async (set: (b: ReturnType<typeof bpfServer>) => void): Promise<[unknown, number, string[]]> => {
      const b = bpfServer();
      set(b);
      const o = { ...opts(), ran: new Set<string>() };
      let got: unknown;
      await withWeb(b.f, () => bpfWriter.save(b.ctx, [ch(stageSlot(), FR, '', 'Étape 1')], o).then((r) => void (got = r[0].outcome), (e) => void (got = (e as { status?: number }).status)));
      return [got, b.f.W.writes.length, [...o.ran]];
    };
    t.eq(await attempt((b) => (b.f.W.lose = 1)), [0, 1, [id]], 'its answer lost');
    t.eq(await attempt(() => {}), ['saved', 1, [id]], 'saved');
    t.eq(await attempt((b) => (b.P.refuse = 403)), [403, 1, []], 'refused');
    t.eq(await attempt((b) => (b.f.W.throttle = 4)), [429, 0, []], 'turned away every time');
  });

  // ---- a managed solution's sitemap or process: never written (no unmanaged layer on it) ----

  t.test('doc writes: a sitemap from a managed solution is never written: refused as loaded (nothing read) and as read right before the write (no PATCH, nothing published)', async () => {
    const { S, f, ctx } = sitemapServer();
    await withWeb(f, async () => {
      const loaded = { ...areaSlot(), ref: { ...areaSlot().ref, managed: true } };
      const o = opts();
      t.eq(outcomes(await sitemapWriter.save(ctx, [ch(loaded, FR, 'Ventes', 'Ventes 2')], o)), [['error', MANAGED]]);
      t.eq([f.W.log, o.publish.sitemaps.size], [[], 0], 'nothing read, nothing to publish');
      // Loaded as this environment's, read as a managed solution's right before the write.
      S.managed = true;
      const o2 = opts();
      t.eq(outcomes(await sitemapWriter.save(ctx, [ch(areaSlot(), FR, 'Ventes', 'Ventes 2'), ch(areaSlot(), EN, 'Sales', 'Sales 2')], o2)), [['error', MANAGED], ['error', MANAGED]]);
      t.eq([f.W.writes.length, o2.publish.sitemaps.size, S.un], [0, 0, sitemapXml('Ventes')], 'no PATCH, nothing published, the sitemap as it was');
      t.ok(f.W.log.every((e) => e.startsWith('GET')), f.W.log.join(' | '));
    });
  });

  t.test('doc writes: a process from a managed solution is never written: refused as loaded (nothing read) and as read right before the write (no PATCH)', async () => {
    const { P, f, ctx } = bpfServer();
    const before = JSON.stringify(P.doc);
    await withWeb(f, async () => {
      const loaded = { ...stageSlot(), ref: { ...stageSlot().ref, managed: true } };
      t.eq(outcomes(await bpfWriter.save(ctx, [ch(loaded, FR, '', 'Étape 1')], opts())), [['error', MANAGED]]);
      t.eq(f.W.log, [], 'nothing read');
      P.doc.ismanaged = true;
      t.eq(outcomes(await bpfWriter.save(ctx, [ch(stageSlot(), FR, '', 'Étape 1'), ch(stageSlot(), EN, 'Stage 1', 'Stage A')], opts())), [['error', MANAGED], ['error', MANAGED]]);
    });
    t.eq([f.W.writes.length, JSON.stringify({ ...P.doc, ismanaged: false })], [0, before], 'no PATCH: the definition as it was');
  });

  t.test("doc writes: the saver never sends a managed solution's sitemap or process label to its writer: skipped with the reason, also for a slot that slipped through as editable", () =>
    withStorage(async () => {
      const { f, ctx } = sitemapServer();
      await withWeb(f, async () => {
        const st = new Store();
        const saver = createSaver(ctx, st, LANG, (k) => (k === 'area' ? sitemapWriter : k === 'stage' ? bpfWriter : undefined));
        const area = { ...areaSlot(), ref: { ...areaSlot().ref, managed: true } };
        const stage = { ...stageSlot(), ref: { ...stageSlot().ref, managed: true } };
        const rep = await saver.save([ch(area, FR, 'Ventes', 'Ventes 2'), ch(stage, FR, '', 'Étape 1')], { signal: new AbortController().signal, publish: true, onProgress() {} });
        t.eq(rep.results.map((r) => [r.outcome, r.message]), [['skipped', `Read-only: ${MANAGED}`], ['skipped', `Read-only: ${MANAGED}`]]);
        t.eq([rep.saved, rep.published, f.W.log], [0, false, []], 'nothing read, written or published');
      });
    }),
  );

  // ---- someone else's save between the writer's read and its write ----

  t.test('doc writes: a form save someone else made between the read and the PATCH is put back at once, with ours on it (If-Match only guards the published form)', async () => {
    const { F, maker, lang, ctx } = formServer();
    F.between = maker;
    const o = { ...opts(), lang };
    const res = await formXmlWriter.save(ctx, [ch(fieldSlot(), FR, 'Nom', 'Nom complet')], o);
    t.eq(outcomes(res), [['saved', '']]);
    t.ok(F.xml.includes('Nom complet') && F.xml.includes('name="theirs"'), `both on the server: ${F.xml}`);
    t.eq(F.batches.map((b) => (b.some((p) => p.startsWith('PATCH')) ? 'write' : 'read')), ['read', 'write', 'read', 'write'], 'their form read again before it is written back');
    t.eq([...o.publish.entities], ['account']);
  });

  t.test('doc writes: a form write says in SaveOptions.ran each label its PATCH may have saved: answered (204), its batch answer lost, its part unanswered; never one refused (403) or turned down (412)', async () => {
    const id = changeId(ch(fieldSlot(), FR, 'Nom', 'Nom complet'));
    const attempt = async (set: (F: ReturnType<typeof formServer>['F']) => void): Promise<[string, string, string[]]> => {
      const { F, lang, ctx } = formServer();
      set(F);
      const o = { ...opts(), lang, ran: new Set<string>() };
      const [r] = await formXmlWriter.save(ctx, [ch(fieldSlot(), FR, 'Nom', 'Nom complet')], o);
      return [r.outcome, F.xml.includes('Nom complet') ? 'written' : 'not written', [...o.ran]];
    };
    t.eq(await attempt(() => {}), ['saved', 'written', [id]], '204');
    t.eq(await attempt((F) => (F.lose = 1)), ['error', 'written', [id]], 'its batch answer lost');
    t.eq(await attempt((F) => (F.patch = 0)), ['error', 'written', [id]], 'no answer for its PATCH');
    t.eq(await attempt((F) => (F.patch = 403)), ['error', 'not written', []], 'refused');
    t.eq(await attempt((F) => (F.patch = 412)), ['conflict', 'not written', []], 'turned down twice (If-Match)');
  });

  t.test("doc writes: a form label whose PATCH answer was lost, then Try again: found as asked, journaled as this publish's (its Undo can put the old label back); one refused and found as asked (someone else's) is not", () =>
    withStorage(async () => {
      for (const lose of [true, false]) {
        const { F, lang, ctx } = formServer();
        const st = new Store();
        const slot = fieldSlot();
        st.add([slot]);
        const saver = createSaver(ctx, st, lang, (k) => (k === 'field' ? formXmlWriter : undefined));
        const run = () => saver.save([ch(slot, FR, 'Nom', 'Nom complet')], { signal: new AbortController().signal, publish: false, onProgress() {} });
        if (lose) F.lose = 1;
        else F.patch = 403;
        const a = await run();
        t.eq([a.saved, a.errors], [0, 1], lose ? 'lost' : 'refused');
        // Refused: someone else saves the same label meanwhile.
        if (!lose) F.xml = F.xml.replace(LABEL(FR, 'Nom'), LABEL(FR, 'Nom complet'));
        F.patch = undefined;
        const b = await run();
        t.eq([b.unchanged, b.results[0].found ?? false, b.historyId !== undefined], [1, !lose, lose], lose ? 'this write' : "someone else's");
        const h = readHistory(ctx).filter((e) => e.id === b.historyId);
        t.eq(h.map((e) => e.items.map((i) => [i.key, i.lcid, i.before, i.after])), lose ? [[[slot.key, FR, 'Nom', 'Nom complet']]] : []);
      }
    }),
  );

  t.test('doc writes: a form write batch reads the whole unpublished form right before its PATCH; with no other save in between it is saved as before', async () => {
    const { F, lang, ctx } = formServer();
    const res = await formXmlWriter.save(ctx, [ch(fieldSlot(), FR, 'Nom', 'Nom complet')], { ...opts(), lang });
    t.eq(outcomes(res), [['saved', '']]);
    t.eq(F.batches, [
      [`GET systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`, `GET systemforms(${FORM})`],
      [`GET systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`, `PATCH systemforms(${FORM})`, `GET systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`],
    ]);
  });

  t.test('doc writes: a sitemap saved by someone else between the read and the PATCH is put back at once, with ours on it; a write with no other save in between is saved', async () => {
    const { S, f, ctx } = sitemapServer();
    await withWeb(f, async () => {
      const res = await sitemapWriter.save(ctx, [ch(areaSlot(), FR, 'Ventes', 'Ventes FR')], opts());
      t.eq(outcomes(res), [['saved', '']]);
      // Someone else's save arrives right after the next read.
      let reads = 0;
      const fetch0 = f.fetch;
      (globalThis as { fetch: unknown }).fetch = async (u: unknown, init: { method: string }) => {
        const r = await fetch0(u as never, init as never);
        if (String(u).includes('RetrieveUnpublishedMultiple') && ++reads === 1) S.un = S.un.replace('</SiteMap>', '<Area Id="theirs" /></SiteMap>');
        return r;
      };
      const o = opts();
      const res2 = await sitemapWriter.save(ctx, [ch(areaSlot('Ventes FR'), FR, 'Ventes FR', 'Ventes 2')], o);
      t.eq(outcomes(res2), [['saved', '']]);
      t.eq([...o.publish.sitemaps], [SM]);
      t.ok(S.un.includes('Ventes 2') && S.un.includes('Id="theirs"'), `both on the server: ${S.un}`);
      t.eq(f.W.writes.length, 3, 'the first save, then this one and the one putting theirs back');
    });
  });

  // ---- an app designer's placeholder named here (LIVE-FINDINGS 99) ----

  /** "Model Driven 2": an area named in English, a group the app designer never named, holding a table's subarea. */
  const OPEN = '<Group Id="group_62c1b167" ResourceId="SitemapDesigner.NewGroup" DescriptionResourceId="SitemapDesigner.NewGroup" IntroducedVersion="7.0.0.0" IsProfile="false" ToolTipResourseId="SitemapDesigner.Unknown">';
  const md2 =
    '<SiteMap IntroducedVersion="7.0.0.0"><Area Id="area_ab12" ResourceId="SitemapDesigner.NewTitle" DescriptionResourceId="SitemapDesigner.NewTitle" ShowGroups="true" IntroducedVersion="7.0.0.0">' +
    '<Titles><Title LCID="1033" Title="Area1"/></Titles>' +
    `${OPEN}<SubArea Id="subarea_c4" Icon="/_imgs/imagestrips/transparent_spacer.gif" Entity="category" Client="All,Outlook,OutlookLaptopClient,OutlookWorkstationClient,Web" AvailableOffline="true" PassParams="false" Sku="All,OnPremise,Live,SPLA"/></Group>` +
    '<Group Id="g_ms" ResourceId="Group_Customers"><SubArea Id="nav_accts" Entity="account" ResourceId="Homepage_Accounts"/></Group></Area></SiteMap>';
  const groupSlot = (): Slot => ({
    ...areaSlot(),
    key: `group|${SM}|group_62c1b167|Title`,
    kind: 'group',
    comp: `group|${SM}|group_62c1b167`,
    title: 'Unnamed group',
    sub: 'group_62c1b167',
    labels: {},
    ref: { sitemapId: SM, id: 'group_62c1b167', resource: 'NewGroup', unnamed: true, placeholder: true },
  });

  t.test('doc writes: naming a placeholder group adds its Titles as its first child, in the base language and the target, and leaves every other byte of the sitemap as it was', async () => {
    const { S, f, ctx } = sitemapServer('', md2);
    t.eq(serializeXml(parseXml(md2)), md2, 'the fixture reads back as written');
    await withWeb(f, async () => {
      const o = opts();
      const g = groupSlot();
      const res = await sitemapWriter.save(ctx, [ch(g, EN, '', 'Sales'), ch(g, FR, '', 'Ventes')], o);
      t.eq(outcomes(res), [['saved', ''], ['saved', '']]);
      t.eq(S.un, md2.replace(OPEN, `${OPEN}<Titles><Title LCID="1033" Title="Sales"/><Title LCID="1036" Title="Ventes"/></Titles>`));
      t.eq([f.W.writes.length, [...o.publish.sitemaps]], [1, [SM]]);
    });
  });

  t.test("doc writes: a placeholder named in another language only is refused, nothing written; someone else's save meanwhile is kept when it is named", async () => {
    const { S, f, ctx } = sitemapServer('', md2);
    await withWeb(f, async () => {
      const g = groupSlot();
      const res = await sitemapWriter.save(ctx, [ch(g, FR, '', 'Ventes')], opts());
      t.eq(outcomes(res), [['error', baseNameFirst(EN)]]);
      t.eq([f.W.writes.length, S.un], [0, md2], 'nothing written');
      // Someone else adds an area right after the read: theirs is put back with our titles on it.
      let reads = 0;
      const fetch0 = f.fetch;
      (globalThis as { fetch: unknown }).fetch = async (u: unknown, init: { method: string }) => {
        const r = await fetch0(u as never, init as never);
        if (String(u).includes('RetrieveUnpublishedMultiple') && ++reads === 1) S.un = S.un.replace('</SiteMap>', '<Area Id="theirs"/></SiteMap>');
        return r;
      };
      const res2 = await sitemapWriter.save(ctx, [ch(g, EN, '', 'Sales'), ch(g, FR, '', 'Ventes')], opts());
      t.eq(outcomes(res2), [['saved', ''], ['saved', '']]);
      t.eq(S.un, md2.replace(OPEN, `${OPEN}<Titles><Title LCID="1033" Title="Sales"/><Title LCID="1036" Title="Ventes"/></Titles>`).replace('</SiteMap>', '<Area Id="theirs"/></SiteMap>'));
    });
  });

  t.test('doc writes: an English title given to another kind of item with the same Id (a subarea) does not let the placeholder group be named in French alone', async () => {
    const SUB = '<SubArea Id="group_62c1b167" Url="/x"><Titles><Title LCID="1033" Title="Things"/></Titles></SubArea>';
    const xml = md2.replace(`${OPEN}<SubArea `, `${OPEN}${SUB}<SubArea `);
    const { S, f, ctx } = sitemapServer('', xml);
    await withWeb(f, async () => {
      const sub: Slot = { ...groupSlot(), key: `subarea|${SM}|group_62c1b167|Title`, kind: 'subarea', comp: `subarea|${SM}|group_62c1b167`, labels: { [EN]: 'Things' }, ref: { sitemapId: SM, id: 'group_62c1b167' } };
      const res = await sitemapWriter.save(ctx, [ch(sub, EN, 'Things', 'Stuff'), ch(groupSlot(), FR, '', 'Ventes')], opts());
      t.eq(outcomes(res), [['saved', ''], ['error', baseNameFirst(EN)]]);
      t.eq(S.un, xml.replace('Title="Things"', 'Title="Stuff"'), 'the subarea renamed, the group still without titles');
    });
  });

  t.test('doc writes: naming a placeholder group of a sitemap from a managed solution is refused (as loaded, and as read right before the write): nothing written', async () => {
    const { S, f, ctx } = sitemapServer('', md2);
    await withWeb(f, async () => {
      const g = groupSlot();
      const loaded = { ...g, ref: { ...g.ref, managed: true } };
      t.eq(outcomes(await sitemapWriter.save(ctx, [ch(loaded, EN, '', 'Sales'), ch(loaded, FR, '', 'Ventes')], opts())), [['error', MANAGED], ['error', MANAGED]]);
      S.managed = true;
      t.eq(outcomes(await sitemapWriter.save(ctx, [ch(g, EN, '', 'Sales'), ch(g, FR, '', 'Ventes')], opts())), [['error', MANAGED], ['error', MANAGED]]);
      t.eq([f.W.writes.length, S.un], [0, md2], 'never named');
    });
  });

  // ---- what Recent publishes › Undo reads first (Writer.read): the save's own read, alone ----

  const texts = (m: Map<string, string | Error>) => [...m].map(([id, v]) => [id, typeof v === 'string' ? v : `Error: ${v.message}`]);
  const ro = () => ({ signal: new AbortController().signal, lang: LANG });

  t.test("doc writes: read() of the sitemap, process and form writers gives each label's text as their save reads it (the unpublished document, a name Dynamics keeps), writing nothing", async () => {
    const sm = sitemapServer('Ventes');
    await withWeb(sm.f, async () => {
      const gone = { ...areaSlot(), key: `area|${SM}|gone|Title`, ref: { sitemapId: SM, id: 'gone' } };
      sm.S.pub = sitemapXml('Ventes (published)');
      const got = await sitemapWriter.read!(sm.ctx, [ch(areaSlot(), FR, '', ''), ch(areaSlot(), EN, '', ''), ch(gone, FR, '', '')], ro());
      t.eq(texts(got), [
        [`area|${SM}|sales|Title#${FR}`, 'Ventes'],
        [`area|${SM}|sales|Title#${EN}`, 'Sales'],
        [`area|${SM}|gone|Title#${FR}`, 'Error: This item is no longer in the sitemap. Reload to see the current sitemap.'],
      ]);
      t.eq(sm.f.W.writes.length, 0);
    });
    const bp = bpfServer();
    await withWeb(bp.f, async () => {
      // French only kept by Dynamics (ref.stored): what the page shows there, and what a save of it is measured against.
      const kept = { ...stageSlot(), labels: { [EN]: 'Stage 1', [FR]: 'Étape 1' }, ref: { ...stageSlot().ref, stored: [FR] } };
      t.eq(texts(await bpfWriter.read!(bp.ctx, [ch(stageSlot(), EN, '', ''), ch(stageSlot(), FR, '', '')], ro())), [[`${stageSlot().key}#${EN}`, 'Stage 1'], [`${stageSlot().key}#${FR}`, '']]);
      t.eq(texts(await bpfWriter.read!(bp.ctx, [ch(kept, FR, '', '')], ro())), [[`${stageSlot().key}#${FR}`, 'Étape 1']]);
      // A stage gone from the definition since: said as its save says it, never read as a text someone changed.
      const gone = { ...stageSlot(), key: `stage|${WF}|gone|Label`, ref: { ...stageSlot().ref, labelId: '00000000-0000-0000-0000-00000000dead' } };
      const res = await bpfWriter.save(bp.ctx, [ch(gone, FR, '', 'Étape')], opts());
      t.eq(texts(await bpfWriter.read!(bp.ctx, [ch(gone, FR, '', 'Étape')], ro())), [[`${gone.key}#${FR}`, `Error: ${res[0].message}`]]);
      t.eq(bp.f.W.writes.length, 0);
    });
    const { F, lang, ctx } = formServer();
    const tab: Slot = { ...fieldSlot(), key: `tab|${FORM}|a1|Label`, kind: 'tab', comp: `tab|${FORM}|a1`, labels: { [EN]: 'General' } };
    const gone: Slot = { ...fieldSlot(), key: `field|${FORM}|c9|Label`, comp: `field|${FORM}|c9` };
    const got = await formXmlWriter.read!(ctx, [ch(fieldSlot(), FR, '', ''), ch(fieldSlot(), EN, '', ''), ch(tab, FR, '', ''), ch(tab, EN, '', ''), ch(gone, FR, '', '')], { signal: new AbortController().signal, lang });
    t.eq(texts(got), [
      [`field|${FORM}|c1|Label#${FR}`, 'Nom'],
      [`field|${FORM}|c1|Label#${EN}`, 'Name'],
      [`tab|${FORM}|a1|Label#${FR}`, ''],
      [`tab|${FORM}|a1|Label#${EN}`, 'General'],
      [`field|${FORM}|c9|Label#${FR}`, 'Error: This label is no longer on the form.'],
    ]);
    t.ok(F.batches.flat().every((p) => p.startsWith('GET ')), F.batches.join(' / '));
  });
}
