// Unit tests for someone else's save landing in the middle of a whole-document write (providers/repair.ts with the form,
// sitemap and process writers): put back at once with only our label/language pairs on it, a pair they changed too a
// conflict keeping their text, a probe that fails never followed by a write where the batch can stop, and never a plain
// "saved" without a probe to prove nothing was replaced. The sitemap and process writers run on the real Http over a
// fake fetch whose $batch runs its parts in order and, without continue-on-error, stops at the first failing one
// (LIVE-FINDINGS 49); the form writer on the fake form of formlabels.ts. register() is called by tools/dev/unit.ts.
import { Http } from '../../../src/core/http';
import { droppedBack, PublishSet, type Change, type ChangeResult, type Lcid, type Slot } from '../../../src/core/model';
import { kid, normId, parseXml, readLabels } from '../../../src/core/xml';
import { bpfWriter, loadBpfLabels, withStored } from '../../../src/providers/bpf';
import { formXmlWriter } from '../../../src/providers/formxml';
import { RACE_THEIRS } from '../../../src/providers/repair';
import { sitemapWriter } from '../../../src/providers/sitemap';
import type { SaveOptions } from '../../../src/providers/types';
import { addTab, cellOf, formFake, FORM, kinds, loaded, moveKey, MOVED, relabel, told, type FormFake } from './formlabels';
import type { Kit } from './kit';
import { fast } from './lang';

const EN = 1033;
const FR = 1036;
const ORIGIN = 'https://org.test';
const API = `${ORIGIN}/api/data/v9.2/`;
const SM = '0b6f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const WF = '9a6faaaa-0000-4000-8000-0000000000b1';
const LANGS = [
  { lcid: EN, name: 'English', isBase: true },
  { lcid: FR, name: 'French', isBase: false },
];
const RACED = /^Saved, but someone else saved this (form|sitemap|process) at the same moment, and this save may have replaced their change/;
const UNSEEN = /right before the save could not be read, so a save someone else made at the same moment can't be ruled out/;

// ---- a fake Dataverse behind fetch, for the real Http ----

interface Req {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}
interface Answer {
  status: number;
  body?: unknown;
}

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

/**
 * A Dataverse answering through `route`. A $batch runs its parts one after another and, sent without
 * continue-on-error, stops at the first part that fails. `at` holds someone else's save, run once at a moment:
 * 'batch' (a batch with a write arrives: after the writer's read, before its probe), 'patch' (after the probe, right
 * before the PATCH), 'back' (right after the PATCH), 'read' (before the next GET outside a batch). `probe`: how the
 * next write batch's first part answers instead (a status, 'empty': 200 without the document, or an answer: e.g. an
 * older copy, as a read that lags would give). `log` lists every request ("[" and "]" around a batch, "-> status" for
 * a probe answered so), `writes` every PATCH that ran.
 */
function web(route: (r: Req) => Answer, empty: unknown) {
  const W = { log: [] as string[], writes: [] as Req[], at: {} as Record<string, (() => void) | undefined>, probe: undefined as undefined | number | 'empty' | Answer, continued: [] as boolean[] };
  const fire = (k: string) => {
    const f = W.at[k];
    W.at[k] = undefined;
    f?.();
  };
  const run = (r: Req): Answer => {
    W.log.push(`${r.method} ${r.url.split('?')[0]}`);
    if (r.method === 'PATCH') W.writes.push(r);
    return route(r);
  };
  const json = (a: Answer) => (a.body === undefined ? '' : JSON.stringify(a.body));
  const fetch = async (input: unknown, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Response> => {
    await new Promise((r) => setTimeout(r, 0));
    const url = String(input).replace(API, '');
    if (url !== '$batch') {
      if (init.method === 'GET') fire('read');
      const a = run({ method: init.method, url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
      return new Response(a.status === 204 ? null : json(a), { status: a.status });
    }
    const parts = parseParts(init.body || '', /boundary=(\S+)/.exec(init.headers['Content-Type'])![1]);
    const goOn = /continue-on-error/.test(init.headers.Prefer || '');
    const writes = parts.some((p) => p.method === 'PATCH');
    if (writes) W.continued.push(goOn);
    if (writes) fire('batch');
    W.log.push('[');
    const answers: Answer[] = [];
    for (const [i, p] of parts.entries()) {
      if (writes && p.method === 'PATCH') fire('patch');
      let a: Answer;
      if (writes && i === 0 && W.probe !== undefined) {
        a = typeof W.probe === 'object' ? W.probe : W.probe === 'empty' ? { status: 200, body: empty } : { status: W.probe, body: { error: { code: '0x80040216', message: 'The probe failed.' } } };
        W.probe = undefined;
        W.log.push(`${p.method} ${p.url.split('?')[0]} -> ${a.status}`);
      } else a = run(p);
      answers.push(a);
      if (writes && p.method === 'PATCH') fire('back');
      if (!goOn && a.status >= 400) break;
    }
    W.log.push(']');
    const b = 'batchresponse_1';
    const text =
      answers.map((a) => `--${b}\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nHTTP/1.1 ${a.status} X\r\nContent-Type: application/json\r\n\r\n${json(a)}\r\n`).join('') + `--${b}--\r\n`;
    return new Response(text, { status: 200, headers: { 'Content-Type': `multipart/mixed; boundary=${b}` } });
  };
  return { W, fetch };
}

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
const ctxOf = (http: unknown) => ({ http, xrm: null, origin: ORIGIN, org: 'org', orgId: 'docrace', envType: '', userId: 'u', base: EN, user: EN, langs: LANGS, version: '9.2' }) as never;
/** A LangSession stand-in: no switching (every language is written inline in these documents). */
const LANG = { quiet: <T>(fn: () => Promise<T>) => fn(), run: <T>(_l: Lcid, fn: () => Promise<T>) => fn(), restore: async () => {} } as never;
const opts = (lang: unknown = LANG): SaveOptions => ({ signal: new AbortController().signal, publish: new PublishSet(), progress() {}, force: new Set<string>(), lang: lang as SaveOptions['lang'], allowPublish: true });
const outcomes = (rs: ChangeResult[]) => rs.map((r) => [r.outcome, r.message ?? '']);
const ch = (slot: Slot, lcid: Lcid, before: string, after: string): Change => ({ slot, lcid, before, after });
const writeBatches = (log: string[]) => log.join(' ').split('[').slice(1).filter((b) => b.includes('PATCH')).length;

// ---- a sitemap with two areas ----

const title = (l: Lcid, t: string) => `<Title LCID="${l}" Title="${t}" />`;
const sitemapXml = (salesFr = 'Ventes', serviceFr = '') =>
  `<SiteMap><Area Id="sales"><Titles>${title(EN, 'Sales')}${salesFr ? title(FR, salesFr) : ''}</Titles><Group Id="g1" /></Area>` +
  `<Area Id="service"><Titles>${title(EN, 'Service')}${serviceFr ? title(FR, serviceFr) : ''}</Titles></Area></SiteMap>`;

/** The unpublished sitemap as RetrieveUnpublishedMultiple answers it; `ver` its versionnumber (a save raises it). */
const sitemapRows = (xml: string, ver: number) => ({ value: [{ sitemapid: SM, sitemapname: 'Sales Hub', sitemapnameunique: 'saleshub', sitemapxml: xml, versionnumber: ver }] });

function sitemapServer() {
  const S = { un: sitemapXml(), etag: 'W/"1"', ver: 700 };
  const f = web((r) => {
    if (r.method === 'GET' && r.url.startsWith('sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()')) return { status: 200, body: sitemapRows(S.un, S.ver) };
    if (r.method === 'GET' && r.url.startsWith(`sitemaps(${SM})`)) return { status: 200, body: { sitemapid: SM, sitemapxml: S.un, '@odata.etag': S.etag } };
    if (r.method === 'PATCH' && r.url === `sitemaps(${SM})`) {
      if (r.headers['If-Match'] !== '*' && r.headers['If-Match'] !== S.etag) return error(412, "The version of the existing record doesn't match.");
      S.un = r.body.sitemapxml;
      S.ver++;
      return { status: 204 };
    }
    return error(404, 'Resource not found for the segment.');
  }, { value: [] });
  /** Another maker adds an area and a French title to the service area (the language this save writes, another item). */
  const theirs = (n = '') => () => {
    S.un = S.un.replace('</SiteMap>', `<Area Id="theirs${n}"><Titles>${title(EN, 'Theirs' + n)}</Titles></Area></SiteMap>`).replace(/(<Area Id="service"><Titles><Title LCID="1033" Title="Service"\s*\/>)(<Title LCID="1036"[^>]*\/>)?/, `$1${title(FR, 'Service FR' + n)}`);
    S.ver++;
  };
  return { S, f, theirs, ctx: ctxOf(new Http(ORIGIN)) };
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
  labels: { [EN]: 'Sales', [FR]: fr },
  readOnly: '',
  baseRequired: true,
  max: 0,
  order: 0,
  ref: { sitemapId: SM, id: 'sales' },
});
/** The French title of an area in a sitemap XML ('' when it has none). */
const frOf = (xml: string, area: string) => new RegExp(`<Area Id="${area}"><Titles>[^]*?<Title LCID="1036" Title="([^"]*)"`).exec(xml.split('</Area>').find((a) => a.includes(`Id="${area}"`)) || '')?.[1] ?? '';

// ---- a process: three stages, each with one step, English everywhere, French on some ----

const S1 = '8f912143-0000-4000-8000-000000000051';
const S2 = '2c3b1a8e-5d4f-4e6a-9b7c-1d2e3f4a5b6c';
const S3 = '3d4c2b9f-6e5a-4f7b-8c8d-2e3f4a5b6c7d';
const P1 = '4550377b-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const P2 = '5661488c-2d3e-4f6a-9bac-1d2e3f4a5b6c';
const P3 = '6772599d-3e4f-4a7b-acbd-2e3f4a5b6c7d';
const tag = (id: string, l: Lcid, t: string) => `<mxswa:StepLabel Description="${t}" LabelId="${id}" LanguageCode="${l}" />`;
const entry = (id: string, l: Lcid, t: string) => ({ labelId: id, languageCode: l, description: t });
const cls = (c: string, o: object) => ({ __class: `${c}:#Microsoft.Crm.Workflow.ObjectModel`, ...o });
const LABELS: Array<[string, Array<[Lcid, string]>]> = [
  [S1, [[EN, 'Stage 1'], [FR, 'Étape 1']]],
  [P1, [[EN, 'Field 1'], [FR, 'Champ 1']]],
  [S2, [[EN, 'Stage 2'], [FR, 'Étape 2']]],
  [P2, [[EN, 'Field 2'], [FR, 'Champ 2']]],
  [S3, [[EN, 'Stage 3']]],
  [P3, [[EN, 'Field 3']]],
];
function definition() {
  const labels = new Map(LABELS);
  const list = (id: string) => ({ list: labels.get(id)!.map(([l, t]) => entry(id, l, t)) });
  const stage = (s: string, p: string, field: string) =>
    cls('StageStep', { stageId: s, stepLabels: list(s), steps: { list: [cls('StepStep', { stepStepId: p, stepLabels: list(p), steps: { list: [cls('ControlStep', { dataFieldName: field, controlDisplayName: field })] } })] } });
  const clientdata = cls('EntityStep', { description: 'account', steps: { list: [stage(S1, P1, 'name'), stage(S2, P2, 'accountnumber'), stage(S3, P3, 'industrycode')] } });
  const coll = (id: string) => `<mxswa:StepLabels>\n    ${labels.get(id)!.map(([l, t]) => tag(id, l, t)).join('\n    ')}\n  </mxswa:StepLabels>`;
  const xaml = `<Activity designer="before">\n  ${[S1, P1, S2, P2, S3, P3].map(coll).join('\n  ')}\n</Activity>`;
  return { name: 'bpf test', primaryentity: 'account', ismanaged: false, iscustomizable: { Value: true }, xaml, clientdata: JSON.stringify(clientdata) };
}

function bpfServer() {
  const P = { doc: { ...definition(), versionnumber: 900 } as Record<string, unknown> };
  const f = web((r) => {
    if (r.method === 'GET' && r.url.startsWith(`workflows(${WF})?`)) return { status: 200, body: JSON.parse(JSON.stringify(P.doc)) };
    if (r.method === 'PATCH' && r.url === `workflows(${WF})`) {
      if (r.headers['If-Match']) return error(400, "Optimistic concurrency isn't enabled for entity type WorkflowDependency.");
      Object.assign(P.doc, r.body, { versionnumber: Number(P.doc.versionnumber) + 1 });
      return { status: 204 };
    }
    return error(404, 'Resource not found for the segment.');
  }, {});
  /** Another maker sets (or adds) a label in both documents, as the process designer saves them. */
  const set = (id: string, l: Lcid, t: string) => () => {
    P.doc.versionnumber = Number(P.doc.versionnumber) + 1;
    const xaml = String(P.doc.xaml);
    const has = new RegExp(`<mxswa:StepLabel Description="[^"]*" LabelId="${id}" LanguageCode="${l}" />`);
    P.doc.xaml = has.test(xaml) ? xaml.replace(has, tag(id, l, t)) : xaml.replace(new RegExp(`(<mxswa:StepLabel [^>]*LabelId="${id}" [^>]*/>)(\\s*</mxswa:StepLabels>)`), `$1${tag(id, l, t)}$2`);
    const cd = JSON.parse(String(P.doc.clientdata));
    const visit = (v: any): void => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v.stepLabels?.list) && (v.stageId === id || v.stepStepId === id)) {
        const e = v.stepLabels.list.find((x: any) => x.languageCode === l);
        if (e) e.description = t;
        else v.stepLabels.list.push(entry(id, l, t));
      }
      for (const k in v) visit(v[k]);
    };
    visit(cd);
    P.doc.clientdata = JSON.stringify(cd);
  };
  /** Every label of the definition in both documents: `<id>|<lcid>` -> [xaml texts, clientdata texts]. */
  const labels = () => {
    const out: Record<string, [string[], string[]]> = {};
    const at = (id: string, l: unknown) => (out[`${id}|${l}`] ??= [[], []]);
    for (const m of String(P.doc.xaml).matchAll(/<mxswa:StepLabel Description="([^"]*)" LabelId="([^"]*)" LanguageCode="(\d+)" \/>/g)) at(m[2], m[3])[0].push(m[1]);
    const visit = (v: any): void => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v.stepLabels?.list)) for (const e of v.stepLabels.list) at(e.labelId, e.languageCode)[1].push(e.description);
      for (const k in v) if (k !== 'stepLabels') visit(v[k]);
    };
    visit(JSON.parse(String(P.doc.clientdata)));
    return out;
  };
  const ctx = ctxOf(new Http(ORIGIN));
  const load = async () => Object.fromEntries((await loadBpfLabels(ctx, WF, { signal: new AbortController().signal, progress() {} })).map((s) => [s.ref.labelId, s]));
  return { P, f, set, labels, ctx, load };
}

// ---- a form on the fake of formlabels.ts (a LangSession hold that never switches) ----

const LABEL = (l: Lcid, t: string) => `<label description="${t}" languagecode="${l}" />`;
const cellXml = (id: string, ctl: string, en: string, fr: string) => `<row><cell id="{${id}}"><labels>${LABEL(EN, en)}${fr ? LABEL(FR, fr) : ''}</labels><control id="${ctl}" datafieldname="${ctl}" /></cell></row>`;
/** The name field has a label of its own in both languages; the email field in English only, its French follows its column. */
const formXml = () =>
  `<form><tabs><tab id="{a1}" name="general"><labels>${LABEL(EN, 'General')}</labels><columns><column width="100%"><sections><section id="{b1}" name="details"><labels>${LABEL(EN, 'Details')}</labels>` +
  `<rows>${cellXml('c1', 'name', 'Name', 'Nom')}${cellXml('c2', 'emailaddress1', 'Email', '')}</rows></section></sections></column></columns></tab></tabs></form>`;

/**
 * The form on formFake: a column cell's labels kept per label key, a read filling in the column's name where the key
 * holds none (LIVE-FINDINGS 103, 104); If-Match checked against the published row (22). A batch runs its parts in order
 * and always goes on after a failed one (LangSession sends continue-on-error). `at` and `probe` as in web(); `stale`: an
 * older copy the next write batch's probe answers with (a read that lags). `ver` is the unpublished versionnumber,
 * raised by every save; `writes` counts the PATCHes that ran; `F.xml = …` is someone else's save of the whole form.
 */
function formServer() {
  const f = formFake(formXml(), { cols: { name: { [EN]: 'Name', [FR]: 'Nom' }, emailaddress1: { [EN]: 'Email', [FR]: 'Courriel' } } });
  const F = Object.defineProperties(f.F, {
    ver: { get: () => f.F.v, set: (v: number) => void (f.F.v = v) },
    writes: { get: () => f.F.patches.length },
  }) as FormFake & { ver: number; readonly writes: number };
  /** Another maker saves the form in the designer: a tab added and the email field's French label changed. */
  const theirs = (n = '') => () =>
    f.designerSave((d) => {
      addTab(d, `a9${n}`, `theirs${n}`, 'Theirs' + n);
      relabel(d, 'c2', FR, 'Adresse courriel' + n);
    });
  return { F, theirs, lang: f.lang, ctx: f.ctx, label: f.label, own: f.own, key: f.key, rename: f.rename, designerSave: f.designerSave };
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
/** The tab's English label in a form XML. */
const tabEn = (xml: string) => /<tab id="\{a1\}"[^>]*><labels><label description="([^"]*)" languagecode="1033"/.exec(xml)?.[1];
/** A cell's labels in a form XML. */
const labelsOf = (xml: string, id: string) => readLabels(cellOf(parseXml(xml), id)!, 'labels', 'label', 'languagecode', 'description');

export function register(t: Kit): void {
  // ---- sitemaps ----

  t.test('doc race: a sitemap saved by someone else between the read and the write (another item, the same language too) is put back with ours on it, from a new read, in a batch that stops at a failed probe', async () => {
    const { S, f, theirs, ctx } = sitemapServer();
    f.W.at.batch = theirs();
    await withWeb(f, async () => {
      const res = await sitemapWriter.save(ctx, [ch(areaSlot(), FR, 'Ventes', 'Ventes 2')], opts());
      t.eq(outcomes(res), [['saved', '']]);
    });
    t.eq([frOf(S.un, 'sales'), frOf(S.un, 'service'), S.un.includes('Id="theirs"')], ['Ventes 2', 'Service FR', true], S.un);
    t.eq([f.W.writes.length, f.W.continued], [2, [false, false]], 'written again once; never with continue-on-error');
    const repair = f.W.log.slice(f.W.log.indexOf(']') + 1);
    t.ok(repair[0].startsWith('GET sitemaps') && repair.indexOf('[') > 0, 'read again before it is written back: ' + f.W.log.join(' | '));
  });

  t.test('doc race: a sitemap title someone else changed in the same language at the same moment keeps their text, and ours is a conflict showing it; their other change stays', async () => {
    const { S, f, theirs, ctx } = sitemapServer();
    f.W.at.batch = () => {
      theirs()();
      S.un = S.un.replace('Title="Ventes"', 'Title="Ventes (eux)"');
    };
    let res: ChangeResult[] = [];
    await withWeb(f, async () => void (res = await sitemapWriter.save(ctx, [ch(areaSlot(), FR, 'Ventes', 'Ventes 2')], opts())));
    t.eq(res.map((r) => [r.outcome, r.server, r.message]), [['conflict', 'Ventes (eux)', RACE_THEIRS]]);
    t.eq([frOf(S.un, 'sales'), frOf(S.un, 'service'), S.un.includes('Id="theirs"')], ['Ventes (eux)', 'Service FR', true], S.un);
  });

  t.test('doc race: a sitemap probe Dataverse answers with an error stops the batch before the PATCH: nothing written, the pass starts again from a new read', async () => {
    const { S, f, ctx } = sitemapServer();
    f.W.probe = 500;
    await withWeb(f, async () => {
      const res = await sitemapWriter.save(ctx, [ch(areaSlot(), FR, 'Ventes', 'Ventes 2')], opts());
      t.eq(outcomes(res), [['saved', '']]);
    });
    t.eq([f.W.writes.length, frOf(S.un, 'sales')], [1, 'Ventes 2']);
    t.ok(f.W.log.join(' | ').includes('[ | GET sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple() -> 500 | ]'), 'the first batch stopped at its probe: ' + f.W.log.join(' | '));
  });

  t.test("doc race: a sitemap probe that answers without the sitemap can't rule out someone else's save: never plain saved, at most \"can't be ruled out\" when the read-back is exactly the read with the edit; nothing written back", async () => {
    const a = sitemapServer();
    a.f.W.probe = 'empty';
    await withWeb(a.f, async () => {
      const res = await sitemapWriter.save(a.ctx, [ch(areaSlot(), FR, 'Ventes', 'Ventes 2')], opts());
      t.eq(res[0].outcome, 'error');
      t.ok(UNSEEN.test(res[0].message || ''), res[0].message);
    });
    t.eq(a.f.W.writes.length, 1);
    // Someone else's save right after the PATCH: the read-back is not the read with the edit, so it may have replaced theirs.
    const b = sitemapServer();
    b.f.W.probe = 'empty';
    b.f.W.at.back = b.theirs();
    await withWeb(b.f, async () => {
      const res = await sitemapWriter.save(b.ctx, [ch(areaSlot(), FR, 'Ventes', 'Ventes 2')], opts());
      t.eq(res[0].outcome, 'error');
      t.ok(RACED.test(res[0].message || ''), res[0].message);
    });
    t.eq(b.f.W.writes.length, 1, 'nothing written back over a save it did not see');
  });

  t.test('doc race: someone saves the sitemap again after our PATCH (before the new read): nothing more is written over it, and it is said', async () => {
    const { S, f, theirs, ctx } = sitemapServer();
    f.W.at.batch = () => {
      theirs()();
      f.W.at.read = theirs('2');
    };
    let res: ChangeResult[] = [];
    await withWeb(f, async () => void (res = await sitemapWriter.save(ctx, [ch(areaSlot(), FR, 'Ventes', 'Ventes 2')], opts())));
    t.eq(res[0].outcome, 'error');
    t.ok(RACED.test(res[0].message || ''), res[0].message);
    t.eq([f.W.writes.length, S.un.includes('Id="theirs2"')], [1, true], 'their later save left as it is');
  });

  t.test('doc race: a save landing before every write is put back each time, at most 3 times, then said; never "saved"', async () => {
    const { S, f, theirs, ctx } = sitemapServer();
    let n = 0;
    const again = () => {
      theirs(String(++n))();
      f.W.at.batch = again;
    };
    f.W.at.batch = again;
    let res: ChangeResult[] = [];
    await withWeb(f, async () => void (res = await sitemapWriter.save(ctx, [ch(areaSlot(), FR, 'Ventes', 'Ventes 2')], opts())));
    t.eq(res[0].outcome, 'error');
    t.ok(RACED.test(res[0].message || ''), res[0].message);
    t.eq(f.W.writes.length, 4, 'the first write and three repairs');
    t.ok(frOf(S.un, 'sales') === 'Ventes 2', S.un);
  });

  t.test('doc race: what no read can show is a sitemap save landing between the probe and the PATCH inside the same batch (the window the probe leaves): replaced, and reported saved', async () => {
    const { S, f, theirs, ctx } = sitemapServer();
    f.W.at.patch = theirs();
    let res: ChangeResult[] = [];
    await withWeb(f, async () => void (res = await sitemapWriter.save(ctx, [ch(areaSlot(), FR, 'Ventes', 'Ventes 2')], opts())));
    t.eq(outcomes(res), [['saved', '']]);
    t.ok(!S.un.includes('Id="theirs"'), 'theirs replaced: ' + S.un);
  });

  // ---- forms ----

  t.test("doc race: a form saved by someone else between the read and the write (a tab added, the first tab's English label and another field's French changed): the tab and the tab's label are put back with ours on it, from a new read; the field's French was never erased", async () => {
    const { F, theirs, lang, ctx, label } = formServer();
    F.at.batch = () => {
      theirs()();
      F.xml = F.xml.replace(LABEL(EN, 'General'), LABEL(EN, 'General (theirs)'));
    };
    const o = opts(lang);
    const res = await formXmlWriter.save(ctx, [ch(fieldSlot(), FR, 'Nom', 'Nom complet')], o);
    t.eq(outcomes(res), [['saved', '']]);
    t.eq(!!kid(cellOf(parseXml(F.patches[0]), 'c2')!, 'labels'), false, 'our PATCH posted no label of the email field');
    // The tab's label goes out as read on every write (it is no column's cell): our PATCH put back the one it read.
    t.eq([tabEn(F.patches[0]), tabEn(F.xml)], ['General', 'General (theirs)'], 'their tab label, which our PATCH replaced, put back');
    t.eq([label('c1')[FR], label('c2')[FR], F.xml.includes('name="theirs"')], ['Nom complet', 'Adresse courriel', true], F.xml);
    t.eq(F.batches.map((b) => (b.some((p) => p.startsWith('PATCH')) ? 'write' : 'read')), ['read', 'write', 'read', 'write']);
    t.eq([...o.publish.entities], ['account']);
  });

  t.test("doc race: someone else's edit of another field's label between the read and the PATCH is never erased nor repaired: one write batch, saved", async () => {
    const { F, lang, ctx, label, designerSave } = formServer();
    F.at.batch = () => designerSave((d) => relabel(d, 'c2', FR, 'Adresse courriel'));
    const res = await formXmlWriter.save(ctx, [ch(fieldSlot(), FR, 'Nom', 'Nom complet')], opts(lang));
    t.eq(outcomes(res), [['saved', '']]);
    t.eq([label('c1')[FR], label('c2')[FR], F.writes, kinds(F.batches)], ['Nom complet', 'Adresse courriel', 1, ['read', 'write']], F.xml);
  });

  t.test('doc race: a column renamed between the read and the PATCH is no race on a main form: one write batch, saved, nothing frozen', async () => {
    const { F, lang, ctx, label, own, rename } = formServer();
    F.at.batch = () => rename('emailaddress1', FR, 'Courriel 2');
    const res = await formXmlWriter.save(ctx, [ch(fieldSlot(), FR, 'Nom', 'Nom complet')], opts(lang));
    t.eq(outcomes(res), [['saved', '']]);
    t.eq([F.writes, kinds(F.batches), own('c2')], [1, ['read', 'write'], { [EN]: 'Email' }], 'no repair storing the new name');
    rename('emailaddress1', FR, 'Courriel 3');
    t.eq(label('c2')[FR], 'Courriel 3', 'the email field still follows its column');
  });

  t.test("doc race: on a main form a label the write leaves out never tells a race (LIVE-FINDINGS 104): another field's French changed between the read and the probe is no race, though someone else saves right after the PATCH (one write batch, their tab kept); our field's English changed after the PATCH never stops the repair of an earlier save (their tab put back, their English kept)", async () => {
    // Their French of the email field before our probe, then their tab right after our PATCH: nothing to repair, and no
    // repair built on the probe erases their tab.
    {
      const { F, lang, ctx, label, designerSave } = formServer();
      F.at.batch = () => designerSave((d) => relabel(d, 'c2', FR, 'Adresse courriel'));
      F.at.back = () => designerSave((d) => addTab(d, 'a2', 'later', 'Later'));
      const res = await formXmlWriter.save(ctx, [ch(fieldSlot(), FR, 'Nom', 'Nom complet')], opts(lang));
      t.eq(outcomes(res), [['saved', '']]);
      t.eq([kinds(F.batches), F.xml.includes('name="later"'), label('c1')[FR], label('c2')[FR]], [['read', 'write'], true, 'Nom complet', 'Adresse courriel'], F.xml);
    }
    // Their tab before our probe (erased by our PATCH), then their English of the name field, a label our PATCH leaves out,
    // before the repair's read: outside that label the form is still the one our PATCH left, so the repair goes out.
    {
      const { F, theirs, lang, ctx, label, designerSave } = formServer();
      F.at.batch = theirs();
      F.at.back = () => void (F.at.read = () => designerSave((d) => relabel(d, 'c1', EN, 'Name 3')));
      const res = await formXmlWriter.save(ctx, [ch(fieldSlot(), FR, 'Nom', 'Nom complet')], opts(lang));
      t.eq(outcomes(res), [['saved', '']]);
      t.eq([label('c1'), F.xml.includes('name="theirs"'), F.writes], [{ [EN]: 'Name 3', [FR]: 'Nom complet' }, true, 2], F.xml);
    }
  });

  t.test('doc race: a label someone else changed in the same language at the same moment is put back by posting their text (repair.ts theirs), ours a conflict showing it', async () => {
    const { F, theirs, lang, ctx, label } = formServer();
    F.at.batch = () => {
      theirs()();
      F.xml = F.xml.replace('description="Nom"', 'description="Nom (eux)"');
    };
    const x = told();
    const res = await formXmlWriter.save(ctx, [ch(fieldSlot(), FR, 'Nom', 'Nom complet')], { ...opts(lang), column: loaded, warn: x.warn });
    t.eq(res.map((r) => [r.outcome, r.server, r.message]), [['conflict', 'Nom (eux)', RACE_THEIRS]]);
    t.eq([label('c1')[FR], label('c2')[FR], F.xml.includes('name="theirs"')], ['Nom (eux)', 'Adresse courriel', true], F.xml);
    // Our first PATCH overwrote their French on the same key; the repair posts theirs explicitly (a write that leaves a
    // label out keeps whatever is stored, LIVE-FINDINGS 104).
    t.eq([F.writes, /<cell id="\{c1\}"><labels><label description="Nom \(eux\)" languagecode="1036"\s*\/><\/labels>/.test(F.patches[1])], [2, true], F.patches[1]);
    // The check after the write knows the clashed label as one our first PATCH posted (the repair's build records nothing
    // for it): the conflict says it, nothing else does.
    t.eq(x.said, []);
  });

  t.test('doc race: a form probe that fails (the batch goes on, as every language batch must): never plain saved; "can\'t be ruled out" when the read-back is the read with the edit; nothing written back', async () => {
    const { F, lang, ctx, label } = formServer();
    F.probe = 500;
    const res = await formXmlWriter.save(ctx, [ch(fieldSlot(), FR, 'Nom', 'Nom complet')], opts(lang));
    t.eq(res[0].outcome, 'error');
    t.ok(UNSEEN.test(res[0].message || ''), res[0].message);
    t.eq([F.writes, label('c1')[FR]], [1, 'Nom complet']);
  });

  t.test('doc race: another form save landing before the repair is put back too, on the newest form; as the first may be lost with it, it is said, never "saved"', async () => {
    const { F, theirs, lang, ctx, label } = formServer();
    F.at.batch = () => {
      theirs()();
      // The next one lands right before the repair's write (built on the form our first PATCH left).
      F.at.batch = theirs('2');
    };
    const res = await formXmlWriter.save(ctx, [ch(fieldSlot(), FR, 'Nom', 'Nom complet')], opts(lang));
    t.eq(res[0].outcome, 'error');
    t.ok(RACED.test(res[0].message || ''), res[0].message);
    t.eq([label('c1')[FR], F.xml.includes('name="theirs2"'), F.writes], ['Nom complet', true, 3], F.xml);
  });

  t.test("doc race: someone else gives the cell a new label key without its English between the read and the PATCH (LIVE-FINDINGS 105): our edit is posted on their key, and their change stands", async () => {
    const { F, lang, ctx, label, own, key, rename, designerSave } = formServer();
    F.at.batch = () => designerSave((d) => moveKey(d, 'c1', EN));
    const res = await formXmlWriter.save(ctx, [ch(fieldSlot(), FR, 'Nom', 'Nom complet')], { ...opts(lang), column: loaded });
    t.eq(outcomes(res), [['saved', '']]);
    t.eq([F.writes, normId(cellOf(parseXml(F.patches[1]), 'c1')!.getAttribute('labelid')), labelsOf(F.patches[1], 'c1')], [2, MOVED, { [FR]: 'Nom complet' }], 'the repair: our French on their key');
    t.eq([key('c1'), own('c1')], [MOVED, { [FR]: 'Nom complet' }]);
    rename('name', EN, 'Name 2');
    t.eq(label('c1'), { [EN]: 'Name 2', [FR]: 'Nom complet' }, 'their change stands: English follows its column');
  });

  // ---- processes ----

  t.test("doc race: another step's French updated by someone else between the read and the write (the follow-up's case) is back in both documents, with ours", async () => {
    const { f, set, labels, ctx, load } = bpfServer();
    let m: Record<string, Slot> = {};
    await withWeb(f, async () => {
      m = await load();
      f.W.at.batch = set(P2, FR, 'Autre traduction concurrente');
      const res = await bpfWriter.save(ctx, [ch(m[P1], FR, 'Champ 1', 'Champ un')], opts());
      t.eq(outcomes(res), [['saved', '']]);
    });
    const l = labels();
    t.eq([l[`${P2}|${FR}`], l[`${P1}|${FR}`]], [[['Autre traduction concurrente'], ['Autre traduction concurrente']], [['Champ un'], ['Champ un']]]);
    t.eq([f.W.writes.length, f.W.continued], [2, [false, false]], 'written back once, never with continue-on-error');
  });

  t.test("doc race: another step's French added by someone else at the same moment stays in both documents; every other label unchanged", async () => {
    const { f, set, labels, ctx, load } = bpfServer();
    const before = labels();
    await withWeb(f, async () => {
      const m = await load();
      f.W.at.batch = set(P3, FR, 'Nouvelle traduction concurrente');
      const res = await bpfWriter.save(ctx, [ch(m[P1], FR, 'Champ 1', 'Champ un')], opts());
      t.eq(outcomes(res), [['saved', '']]);
    });
    const l = labels();
    t.eq(l[`${P3}|${FR}`], [['Nouvelle traduction concurrente'], ['Nouvelle traduction concurrente']]);
    for (const k of Object.keys(before)) if (k !== `${P1}|${FR}`) t.eq(l[k], before[k], k);
  });

  t.test('doc race: a step label someone else changed in the same language at the same moment keeps their text in both documents, and ours is a conflict showing it', async () => {
    const { f, set, labels, ctx, load } = bpfServer();
    let res: ChangeResult[] = [];
    await withWeb(f, async () => {
      const m = await load();
      f.W.at.batch = set(P1, FR, 'Champ (eux)');
      res = await bpfWriter.save(ctx, [ch(m[P1], FR, 'Champ 1', 'Champ un')], opts());
    });
    t.eq(res.map((r) => [r.outcome, r.server, r.message]), [['conflict', 'Champ (eux)', RACE_THEIRS]]);
    t.eq(labels()[`${P1}|${FR}`], [['Champ (eux)'], ['Champ (eux)']]);
  });

  t.test('doc race: a process probe Dataverse answers with an error stops the batch before the PATCH (about 9 s it would take): nothing written, the pass starts again from a new read', async () => {
    const { f, labels, ctx, load } = bpfServer();
    await withWeb(f, async () => {
      const m = await load();
      f.W.probe = 503;
      const res = await bpfWriter.save(ctx, [ch(m[P1], FR, 'Champ 1', 'Champ un')], opts());
      t.eq(outcomes(res), [['saved', '']]);
    });
    t.eq([f.W.writes.length, labels()[`${P1}|${FR}`]], [1, [['Champ un'], ['Champ un']]]);
    t.ok(f.W.log.join(' | ').includes(`[ | GET workflows(${WF}) -> 503 | ]`), f.W.log.join(' | '));
  });

  t.test('doc race: a process probe that answers without the definition is never taken for theirs: nothing written back, never plain saved', async () => {
    const { f, labels, ctx, load } = bpfServer();
    let res: ChangeResult[] = [];
    await withWeb(f, async () => {
      const m = await load();
      f.W.probe = 'empty';
      res = await bpfWriter.save(ctx, [ch(m[P1], FR, 'Champ 1', 'Champ un')], opts());
    });
    t.eq(res[0].outcome, 'error');
    t.ok(UNSEEN.test(res[0].message || ''), res[0].message);
    t.eq([f.W.writes.length, writeBatches(f.W.log), labels()[`${S1}|${EN}`]], [1, 1, [['Stage 1'], ['Stage 1']]]);
  });

  t.test("doc race: putting a process back never writes a name Dynamics only keeps (ref.stored): the definition still has no French for that step", async () => {
    const { f, set, labels, ctx, load } = bpfServer();
    await withWeb(f, async () => {
      const m = await load();
      const [p1] = withStored(ctx, [m[P1], m[P3]], new Map([[FR, new Map([[P3, 'Pas stocké']])]]));
      f.W.at.batch = set(S2, EN, 'Stage 2 (theirs)');
      const res = await bpfWriter.save(ctx, [ch(p1, FR, 'Champ 1', 'Champ un')], opts());
      t.eq(outcomes(res), [['saved', '']]);
    });
    const l = labels();
    t.eq([l[`${P3}|${FR}`], l[`${S2}|${EN}`], l[`${P1}|${FR}`]], [undefined, [['Stage 2 (theirs)'], ['Stage 2 (theirs)']], [['Champ un'], ['Champ un']]]);
  });

  // ---- a probe older than the read (a read that lags, LIVE-FINDINGS 66) is nobody's save ----

  t.test('doc race: a form probe older than the read (lower versionnumber: a read that lags) is never written back: a translation saved just before stays, nothing more is written, never plain saved', async () => {
    const { F, lang, ctx, label } = formServer();
    const old = { xml: F.xml, ver: F.ver };
    // A save just made (the user's own, a moment ago): the tab's English label, which every write posts as read.
    F.xml = F.xml.replace(LABEL(EN, 'General'), LABEL(EN, 'General 2'));
    F.stale = old;
    const res = await formXmlWriter.save(ctx, [ch(fieldSlot(), FR, 'Nom', 'Nom complet')], opts(lang));
    t.eq(res[0].outcome, 'error');
    t.ok(UNSEEN.test(res[0].message || ''), res[0].message);
    t.eq([tabEn(F.xml), label('c1')[FR], F.writes], ['General 2', 'Nom complet', 1], F.xml);
  });

  t.test('doc race: the check runs on the first write batch of a race too, and never on a probe older than the read: a translation saved just before stays, no false notice', async () => {
    // Someone else's save lands before the PATCH, and Dataverse drops the email field's labels the PATCH left out: the
    // race is repaired, and their French, which the probe had, is written back (it reads back as the column's name).
    const a = formServer();
    a.F.at.batch = a.theirs();
    a.F.violate = new Set(['c2']);
    const x = told();
    const res = await formXmlWriter.save(a.ctx, [ch(fieldSlot(), FR, 'Nom', 'Nom complet')], { ...opts(a.lang), column: loaded, warn: x.warn });
    t.eq(outcomes(res), [['saved', '']]);
    t.eq(x.said, [['notice', droppedBack('Main', 1)]]);
    t.eq([a.label('c1')[FR], a.label('c2')[FR], a.F.xml.includes('name="theirs"'), a.F.writes], ['Nom complet', 'Adresse courriel', true, 3], a.F.xml);
    // The user's own French of the email field saved a moment ago, and a probe that lags behind it: however like the read
    // it looks, it is not the form the PATCH replaced, so a save made in between can't be ruled out (never plain saved),
    // and nothing is checked against it (no notice, no write-back).
    const b = formServer();
    const old = { xml: b.F.xml, ver: b.F.ver };
    b.designerSave((d) => relabel(d, 'c2', FR, 'Courriel 2'));
    b.F.stale = old;
    const y = told();
    const r = await formXmlWriter.save(b.ctx, [ch(fieldSlot(), FR, 'Nom', 'Nom complet')], { ...opts(b.lang), warn: y.warn });
    t.eq(r[0].outcome, 'error');
    t.ok(UNSEEN.test(r[0].message || ''), r[0].message);
    t.eq([y.said, b.label('c2')[FR], b.label('c1')[FR], b.F.writes], [[], 'Courriel 2', 'Nom complet', 1], b.F.xml);
  });

  t.test('doc race: a repair whose own probe is older than the read it was built from is never built on: their change stays, said, never plain saved, even when that probe shows the very form the read did', async () => {
    const { F, theirs, lang, ctx, label } = formServer();
    const old = { xml: F.xml, ver: F.ver };
    F.at.batch = theirs();
    // The repair's probe lags: it answers with the form as it was before their save.
    F.at.back = () => void (F.stale = old);
    const res = await formXmlWriter.save(ctx, [ch(fieldSlot(), FR, 'Nom', 'Nom complet')], opts(lang));
    t.eq(res[0].outcome, 'error');
    t.ok(UNSEEN.test(res[0].message || ''), res[0].message);
    t.eq([label('c1')[FR], label('c2')[FR], F.xml.includes('name="theirs"'), F.writes], ['Nom complet', 'Adresse courriel', true, 2], F.xml);
    // The repair's probe answers with the form its read got, at a lower versionnumber: a copy that lags is no proof of
    // what that PATCH replaced.
    const b = formServer();
    b.F.at.batch = b.theirs();
    b.F.at.back = () => void (b.F.at.read = () => void (b.F.stale = { xml: b.F.xml, ver: b.F.ver - 1 }));
    const r = await formXmlWriter.save(b.ctx, [ch(fieldSlot(), FR, 'Nom', 'Nom complet')], opts(b.lang));
    t.eq(r[0].outcome, 'error');
    t.ok(UNSEEN.test(r[0].message || ''), r[0].message);
    t.eq([b.label('c1')[FR], b.F.xml.includes('name="theirs"'), b.F.writes], ['Nom complet', true, 2], b.F.xml);
  });

  t.test('doc race: a sitemap probe older than the read (a read that lags) is never written back: a title saved just before stays', async () => {
    const { S, f, ctx } = sitemapServer();
    const old = sitemapRows(S.un, S.ver);
    S.un = sitemapXml('Ventes', 'Service FR');
    S.ver++;
    f.W.probe = { status: 200, body: old };
    let res: ChangeResult[] = [];
    await withWeb(f, async () => void (res = await sitemapWriter.save(ctx, [ch(areaSlot(), FR, 'Ventes', 'Ventes 2')], opts())));
    t.eq(res[0].outcome, 'error');
    t.ok(UNSEEN.test(res[0].message || ''), res[0].message);
    t.eq([frOf(S.un, 'service'), frOf(S.un, 'sales'), f.W.writes.length], ['Service FR', 'Ventes 2', 1], S.un);
  });

  t.test('doc race: a process probe older than the read (a read that lags) is never written back: a step translation saved just before stays in both documents', async () => {
    const { P, f, set, labels, ctx, load } = bpfServer();
    const old = JSON.parse(JSON.stringify(P.doc));
    set(P2, FR, 'Champ 2 bis')();
    let res: ChangeResult[] = [];
    await withWeb(f, async () => {
      const m = await load();
      f.W.probe = { status: 200, body: old };
      res = await bpfWriter.save(ctx, [ch(m[P1], FR, 'Champ 1', 'Champ un')], opts());
    });
    t.eq(res[0].outcome, 'error');
    t.ok(UNSEEN.test(res[0].message || ''), res[0].message);
    const l = labels();
    t.eq([l[`${P2}|${FR}`], l[`${P1}|${FR}`], f.W.writes.length], [[['Champ 2 bis'], ['Champ 2 bis']], [['Champ un'], ['Champ un']], 1]);
  });
}
