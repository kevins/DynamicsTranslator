// Classic ribbon writer (providers/ribbon.ts) against an in-memory Dataverse that applies translation imports by
// the rules seen live (LIVE-FINDINGS 72–77): rows only for the named solution's components and the layer's
// ribboncustomization row, a row with an empty base cell skipped whole, a cell equal to the published title
// skipped, an empty cell kept, unknown LocLabels ignored, nothing visible in ribbondiffs before a publish.
import { DvError, Http } from '../../../src/core/http';
import { MANAGED, PublishSet, type Change, type ChangeResult, type Kind, type Labels, type Slot } from '../../../src/core/model';
import { RIBBON_DRY_RUN, RIBBON_OWED, loadRibbonLabels, loadRibbonScope, ribbonWriter, translationXml } from '../../../src/providers/ribbon';
import { changeId, type SaveOptions } from '../../../src/providers/types';
import { b64ToBytes, fromUtf8, unzip } from '../../../src/core/zip';
import { Store } from '../../../src/core/store';
import { describe, useRibbonControls } from '../../../src/inspector/describe';
import type { Anchor } from '../../../src/inspector/types';
import type { AppApi } from '../../../src/ui/types';
import type { Kit } from './kit';
import { fast } from './lang';

const EN = 1033;
const FR = 1036;
const DE = 1031;
const LAYER = '28d29b95-0000-4000-8000-0000000000a1';
const APP_LAYER = 'b1008475-0000-4000-8000-0000000000a2';
const ME = '0a1b2c3d-0000-4000-8000-00000000000a';
const LT = 'new.t.Btn.LabelText';
const TT = 'new.t.Btn.ToolTipTitle';
const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** One Localized Labels row of an imported file: language → cell text. */
type FileRow = { entity: string; object: string; id: string; cells: Map<number, string> };

function readFile(xml: string): { info: Map<string, string>; langs: number[]; rows: FileRow[] } {
  const d = new DOMParser().parseFromString(xml, 'application/xml');
  const sheets = Array.from(d.getElementsByTagName('Worksheet'));
  const sheet = (n: string) => sheets.find((s) => s.getAttribute('ss:Name') === n)!;
  const rowsOf = (n: string) => Array.from(sheet(n).getElementsByTagName('Row')).map((r) => Array.from(r.getElementsByTagName('Cell')).map((c) => c.getElementsByTagName('Data')[0]?.textContent ?? ''));
  const info = new Map(rowsOf('Information').map(([k, v]) => [k, v]));
  const [head, ...body] = rowsOf('Localized Labels');
  const langs = head.slice(3).map(Number);
  return { info, langs, rows: body.map((r) => ({ entity: r[0], object: r[1], id: r[2], cells: new Map(langs.map((l, i) => [l, r[3 + i]])) })) };
}

interface Server {
  scope: string;
  /** Published titles per unmanaged LocLabel (what ribbondiffs shows). */
  pub: Map<string, Labels>;
  /** Unpublished titles (what the next publish shows). */
  pending: Map<string, Labels>;
  managed: Map<string, Labels>;
  /** ribbondiffs lists the managed rows before the unmanaged ones. */
  managedFirst?: boolean;
  calls: string[];
  files: string[];
  solutions: Map<string, { name: string; comps: Array<{ id: string; type: number; noSub: boolean }> }>;
  jobs: Map<string, string>;
  /** Imports that fail as a deadlock victim (500, job Failed, nothing applied) before one goes through. */
  deadlocks: number;
  /** Runs after each lost deadlock (e.g. another maker publishing before the next try). */
  afterDeadlock?: () => void;
  /** Runs right before each import is applied (e.g. another maker publishing). */
  beforeImport?: () => void;
  /** The next import is applied, but its answer is lost (a 504). */
  loseAnswer?: boolean;
  /** Imports whose answer is lost (a 504) before anything was applied, and no job was logged. */
  loseBefore?: number;
  /** The next import's answer is lost (a 504) and no job is logged: applied at once ('now'), or only when `deferred` is called ('late'). */
  lostNoJob?: 'now' | 'late';
  deferred?: () => void;
  /** Runs right after each import is applied (e.g. another maker publishing). */
  afterImport?: () => void;
  /** PublishXml calls (1 = the first) that fail with a 500, publishing nothing. */
  failPublish: Set<number>;
  publishes: number;
  /** GET ribbondiffs calls (1 = the first) that fail with a 503. */
  failReads: Set<number>;
  reads: number;
  /** Runs right after each ribbondiffs read is answered (e.g. another maker publishing just after it). */
  afterRead?: () => void;
  /** What `solutions?` answers (whatever its filter says), and the URLs it was asked. */
  stale: Array<Record<string, unknown>>;
  staleAsked: string[];
}

function server(scope = 't', pub: Record<string, Labels> = { [LT]: { [EN]: 'Run', [FR]: 'Lancer' }, [TT]: { [EN]: 'Run it', [FR]: 'Le lancer', [DE]: 'Ausführen' } }): Server {
  const copy = (m: Map<string, Labels>) => new Map([...m].map(([k, v]) => [k, { ...v }]));
  const S: Server = { scope, pub: new Map(Object.entries(pub)), pending: new Map(), managed: new Map(), calls: [], files: [], solutions: new Map(), jobs: new Map(), deadlocks: 0, failPublish: new Set(), publishes: 0, failReads: new Set(), reads: 0, stale: [], staleAsked: [] };
  S.pending = copy(S.pub);
  return S;
}

function rig(S: Server) {
  RIBBON_OWED.clear();
  const app = S.scope === '_app';
  const layer = app ? APP_LAYER : LAYER;
  const rdx = (id: string, l: Labels) => `<LocLabel Id="${id}"><Titles>${Object.entries(l).map(([k, v]) => `<Title description="${xmlEsc(v)}" languagecode="${k}" />`).join('')}</Titles></LocLabel>`;
  const rows = () => {
    const un = [...S.pub].map(([id, l]) => ({ diffid: id, entity: app ? null : S.scope, rdx: rdx(id, l), ismanaged: false, difftype: 3, componentstate: 0 }));
    const man = [...S.managed].map(([id, l]) => ({ diffid: id, entity: app ? null : S.scope, rdx: rdx(id, l), ismanaged: true, difftype: 3, componentstate: 0 }));
    return S.managedFirst ? [...man, ...un] : [...un, ...man];
  };
  const job = (status: string, code = '0') => `<importtranslations><status>${status}</status><errordetails><errorcode>${code}</errorcode></errordetails></importtranslations>`;
  const read = async (url: string): Promise<any> => {
    S.calls.push(`GET ${url.replace(/\?.*$/, '')}`);
    if (url.includes('RetrieveUnpublishedMultiple')) throw new DvError('The RetrieveUnpublishedMultiple method does not support entities of type ribbondiff.', 400);
    if (url.startsWith('ribbondiffs')) {
      if (S.failReads.has(++S.reads)) throw new DvError('Service unavailable.', 503);
      const value = rows();
      S.afterRead?.();
      return { value };
    }
    if (url.startsWith('ribboncustomizations')) return { value: [{ ribboncustomizationid: layer }] };
    if (url.startsWith('publishers')) return { value: [{ publisherid: 'p1', uniquename: 'DefaultPublisherorg', customizationprefix: 'new' }] };
    if (url.startsWith('EntityDefinitions(')) return { MetadataId: `meta-${S.scope}` };
    if (url.startsWith('EntityDefinitions?')) return { value: [{ LogicalName: S.scope, DisplayName: { UserLocalizedLabel: { Label: 'Test table' } } }] };
    if (url.startsWith('importjobs(')) {
      const j = S.jobs.get(/importjobs\(([^)]+)\)/.exec(url)![1]);
      if (!j) throw new DvError('importjob does not exist', 404);
      return { data: j };
    }
    if (url.startsWith('solutions?')) {
      S.staleAsked.push(url);
      return { value: S.stale };
    }
    throw new Error('unexpected GET ' + url);
  };
  const http = {
    get: read,
    async all(url: string) {
      return (await read(url)).value;
    },
    async post(url: string, body: any) {
      S.calls.push(`POST ${url.replace(/\?.*$/, '')}`);
      if (url.startsWith('solutions?')) {
        const id = `sol${S.solutions.size + 1}`;
        S.solutions.set(id, { name: body.uniquename, comps: [] });
        return { solutionid: id };
      }
      if (url === 'AddSolutionComponent') {
        // Live: the application ribbon refuses DoNotIncludeSubcomponents (LIVE-FINDINGS 75).
        if (body.ComponentType === 50 && body.DoNotIncludeSubcomponents) throw new DvError('DoNotIncludeSubcomponents can not be set to true on non Entity root', 400, '0x80040216');
        [...S.solutions.values()].find((s) => s.name === body.SolutionUniqueName)!.comps.push({ id: body.ComponentId, type: body.ComponentType, noSub: body.DoNotIncludeSubcomponents });
        return {};
      }
      if (url === 'PublishXml') {
        S.calls.push(body.ParameterXml);
        if (S.failPublish.has(++S.publishes)) throw new DvError('Generic SQL error.', 500);
        S.pub = new Map([...S.pending].map(([k, v]) => [k, { ...v }]));
        return {};
      }
      if (url === 'ImportTranslation') {
        const parts = await unzip(b64ToBytes(body.TranslationFile));
        const xml = fromUtf8(parts.find((p) => p.name === 'CrmTranslations.xml')!.data);
        S.files.push(xml);
        const f = readFile(xml);
        if (f.info.get('Organization ID:') !== 'org-1') throw new DvError('The Organization ID present in the translations file does not match the current Organization ID.', 400, '0x80044248');
        if (S.deadlocks > 0) {
          S.deadlocks--;
          S.jobs.set(body.ImportJobId, job('Failed', '0x80044150'));
          S.afterDeadlock?.();
          throw new DvError('Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205', 500, '0x80044150');
        }
        if (S.loseBefore) {
          S.loseBefore--;
          throw new DvError('Gateway timeout', 504);
        }
        S.beforeImport?.();
        const sol = [...S.solutions.values()].find((s) => s.name === f.info.get('Solution Name:'));
        const holds = !!sol?.comps.some((c) => (app ? c.type === 50 && c.id === layer : c.type === 1 && c.id === `meta-${S.scope}`));
        const base = f.langs[0];
        const apply = () => {
          for (const r of f.rows) {
            if (!holds || r.entity !== 'RibbonCustomization' || r.object !== layer || !S.pending.has(r.id)) continue; // ignored, as live
            if (base === EN && !r.cells.get(EN)) continue; // an empty base cell skips the whole row (finding 73)
            for (const [l, v] of r.cells) if (v && v !== S.pub.get(r.id)![l]) S.pending.get(r.id)![l] = v;
          }
        };
        if (S.lostNoJob) {
          const late = S.lostNoJob === 'late';
          S.lostNoJob = undefined;
          if (late) S.deferred = () => ((S.deferred = undefined), apply());
          else apply();
          throw new DvError('Gateway timeout', 504);
        }
        apply();
        S.afterImport?.();
        S.jobs.set(body.ImportJobId, job('Succeeded'));
        if (S.loseAnswer) {
          S.loseAnswer = false;
          throw new DvError('Gateway timeout', 504);
        }
        return {};
      }
      throw new Error('unexpected POST ' + url);
    },
    async del(url: string) {
      S.calls.push(`DELETE ${url}`);
      S.solutions.delete(/solutions\(([^)]+)\)/.exec(url)![1]);
      return {};
    },
  };
  const ctx = { http, base: EN, user: EN, orgId: 'org-1', userId: ME, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }, { lcid: DE, name: 'German', isBase: false }] } as never;
  const lo = { signal: new AbortController().signal, progress() {} };
  const slots = async (): Promise<Map<string, Slot>> => new Map((await loadRibbonLabels(ctx, [S.scope], lo)).map((s) => [s.ref.locLabelId as string, s]));
  const change = (s: Slot, lcid: number, after: string, before = s.labels[lcid] ?? ''): Change => ({ slot: s, lcid, before, after });
  const save = (cs: Change[], o: Partial<SaveOptions> = {}): Promise<ChangeResult[]> =>
    ribbonWriter.save(ctx, cs, { signal: new AbortController().signal, publish: new PublishSet(), progress() {}, force: new Set(), lang: null as never, allowPublish: true, ...o });
  const outcomes = (rs: ChangeResult[]) => rs.map((r) => [r.change.slot.ref.locLabelId, r.change.lcid, r.outcome]);
  return { ctx, slots, change, save, outcomes };
}

export function register(t: Kit): void {
  t.test('ribbon file: base language first, the other languages after, empty cells where a row edits nothing, text escaped', () => {
    const xml = translationXml({ orgId: 'org-1', base: EN, solution: 'dxt_ribbon_t_1', layer: LAYER, when: new Date('2026-10-16T13:02:43.123Z'), rows: [[LT, { [EN]: 'Run', [FR]: 'A & <b> "c"\n\td' }], [TT, { [EN]: 'Tip', [DE]: ' Tipp ' }]] });
    const f = readFile(xml);
    t.eq([...f.info], [['Organization ID:', 'org-1'], ['Exported on:', '2026-10-16T13:02:43'], ['Base language name:', 'English'], ['Base language ID:', '1033'], ['Solution Name:', 'dxt_ribbon_t_1']]);
    t.eq(f.langs, [EN, DE, FR]);
    t.eq(f.rows.map((r) => [r.entity, r.object, r.id, ...r.cells.values()]), [
      ['RibbonCustomization', LAYER, LT, 'Run', '', 'A & <b> "c"\n\td'],
      ['RibbonCustomization', LAYER, TT, 'Tip', ' Tipp ', ''],
    ]);
    t.ok(xml.includes('ss:Type="DateTime">2026-10-16T13:02:43<') && xml.includes('<Worksheet ss:Name="Display Strings" ss:Id="Display Strings">'), 'the import validates the Information sheet and its ss:Id');
    let threw = '';
    try {
      translationXml({ orgId: 'o', base: EN, solution: 's', layer: LAYER, when: new Date(), rows: [[LT, { [FR]: 'x' }]] });
    } catch (e) {
      threw = (e as Error).message;
    }
    t.ok(/no English text/.test(threw), 'a row without base text is refused, never written with an empty base cell');
  });

  t.test('ribbon writer: a French title is imported with the English title in its row, published, checked; nothing else moves', async () => {
    const S = server();
    const r = rig(S);
    const sl = await r.slots();
    const res = await r.save([r.change(sl.get(LT)!, FR, 'Lancer le test')]);
    t.eq(r.outcomes(res), [[LT, FR, 'saved']]);
    t.eq(S.pub.get(LT), { [EN]: 'Run', [FR]: 'Lancer le test' });
    t.eq(S.pub.get(TT), { [EN]: 'Run it', [FR]: 'Le lancer', [DE]: 'Ausführen' });
    const f = readFile(S.files[0]);
    t.eq(f.langs, [EN, FR]);
    t.eq(f.rows.map((x) => [x.id, ...x.cells.values()]), [[LT, 'Run', 'Lancer le test']]);
    // Publish first (so pending work is visible to the check), the import, the publish that shows it, the cleanup.
    const steps = S.calls.filter((c) => /^POST (PublishXml|ImportTranslation|AddSolutionComponent|solutions)|^DELETE/.test(c));
    t.eq(steps, ['POST PublishXml', 'POST solutions', 'POST AddSolutionComponent', 'POST ImportTranslation', 'POST PublishXml', 'DELETE solutions(sol1)']);
    t.eq(S.calls.filter((c) => c.startsWith('<importexportxml>')), ['<importexportxml><entities><entity>t</entity></entities></importexportxml>', '<importexportxml><entities><entity>t</entity></entities></importexportxml>']);
    t.eq(S.solutions.size, 0, 'the temporary solution is deleted');
  });

  t.test('ribbon writer: the table is added as a shell; the application ribbon by its unmanaged row, without the subcomponent flag', async () => {
    const S = server();
    const r = rig(S);
    const sol = { comps: [] as unknown[] };
    const keep = S.solutions.set.bind(S.solutions);
    S.solutions.set = (k, v) => ((sol.comps = v.comps), keep(k, v));
    await r.save([r.change((await r.slots()).get(LT)!, FR, 'X')]);
    t.eq(sol.comps, [{ id: 'meta-t', type: 1, noSub: true }]);

    const A = server('_app', { 'dxt.test.AppLabel': { [EN]: 'App test' } });
    const a = rig(A);
    const asl = await a.slots();
    const comps = { v: [] as unknown[] };
    const keepA = A.solutions.set.bind(A.solutions);
    A.solutions.set = (k, v) => ((comps.v = v.comps), keepA(k, v));
    const res = await a.save([a.change(asl.get('dxt.test.AppLabel')!, FR, "Test de l'application")]);
    t.eq(a.outcomes(res), [['dxt.test.AppLabel', FR, 'saved']]);
    t.eq(comps.v, [{ id: APP_LAYER, type: 50, noSub: false }]);
    t.eq(readFile(A.files[0]).rows[0].object, APP_LAYER);
    t.eq(A.calls.filter((c) => c.startsWith('<importexportxml>')), ['<importexportxml><ribbons><ribbon></ribbon></ribbons></importexportxml>', '<importexportxml><ribbons><ribbon></ribbon></ribbons></importexportxml>']);
  });

  t.test('ribbon writer: several labels and languages in one file; a row never loses its base cell, so no row is skipped', async () => {
    const S = server();
    const r = rig(S);
    const sl = await r.slots();
    const res = await r.save([r.change(sl.get(LT)!, EN, 'Run test'), r.change(sl.get(TT)!, FR, 'Le lancer 2'), r.change(sl.get(TT)!, DE, 'Ausführen 2')]);
    t.eq(r.outcomes(res), [[LT, EN, 'saved'], [TT, FR, 'saved'], [TT, DE, 'saved']]);
    t.eq(S.pub.get(LT), { [EN]: 'Run test', [FR]: 'Lancer' });
    t.eq(S.pub.get(TT), { [EN]: 'Run it', [FR]: 'Le lancer 2', [DE]: 'Ausführen 2' });
    t.eq(readFile(S.files[0]).rows.map((x) => [x.id, ...x.cells.values()]), [
      [LT, 'Run test', '', ''],
      [TT, 'Run it', 'Ausführen 2', 'Le lancer 2'],
    ]);
  });

  t.test('ribbon writer: work someone has pending is published first and then seen as a conflict, not overwritten', async () => {
    const S = server();
    const r = rig(S);
    const sl = await r.slots();
    S.pending.get(LT)![FR] = 'Lancer (collègue)'; // unpublished: ribbondiffs still show "Lancer"
    const res = await r.save([r.change(sl.get(LT)!, FR, 'Lancer le test')]);
    t.eq(res.map((x) => [x.outcome, x.server]), [['conflict', 'Lancer (collègue)']]);
    t.eq(S.files.length, 0, 'nothing imported');
    t.eq(S.pub.get(LT)![FR], 'Lancer (collègue)');
    t.eq(S.solutions.size, 0);
  });

  t.test('ribbon writer: refuses managed labels, removals and saving without publishing before anything is written', async () => {
    const S = server();
    S.managed.set('Mscrm.T.Lbl', { [EN]: 'Microsoft', [FR]: 'Microsoft FR' });
    const r = rig(S);
    const sl = await r.slots();
    const res = await r.save([r.change(sl.get('Mscrm.T.Lbl')!, FR, 'X'), r.change(sl.get(LT)!, FR, ''), r.change(sl.get(TT)!, FR, '   ')]);
    t.eq(r.outcomes(res), [['Mscrm.T.Lbl', FR, 'error'], [LT, FR, 'error'], [TT, FR, 'error']]);
    t.ok(res[0].message === MANAGED && /can't remove/.test(res[1].message!), JSON.stringify(res.map((x) => x.message)));
    t.eq([sl.get('Mscrm.T.Lbl')!.readOnly, sl.get('Mscrm.T.Lbl')!.ref.managed, sl.get(LT)!.readOnly], [MANAGED, true, ''], 'loaded read-only with the managed reason');
    // Loaded as this environment's, read as a managed solution's right before the import; and the other way round.
    S.managed.set(LT, S.pub.get(LT)!);
    S.pub.delete(LT);
    const late = await r.save([r.change(sl.get(LT)!, FR, 'Lancer 2')]);
    t.eq(late.map((x) => [x.outcome, x.message]), [['error', MANAGED]]);
    const asLoaded = await r.save([r.change({ ...sl.get(TT)!, ref: { ...sl.get(TT)!.ref, managed: true } }, FR, 'Infobulle 2')]);
    t.eq(asLoaded.map((x) => [x.outcome, x.message]), [['error', MANAGED]]);
    t.eq([S.files.length, S.solutions.size], [0, 0], 'nothing imported');
    S.pub.set(LT, S.managed.get(LT)!);
    S.managed.delete(LT);
    const nop = await r.save([r.change(sl.get(LT)!, FR, 'Y')], { allowPublish: false });
    t.eq(r.outcomes(nop), [[LT, FR, 'error']]);
    t.ok(/publishing turned on/.test(nop[0].message!));
    t.eq(S.calls.filter((c) => c.startsWith('POST')), [], 'no publish, no solution, no import');
  });

  t.test('ribbon: a label a managed solution defines that someone customized (an unmanaged row of it too, listed before or after it) loads with the unmanaged texts but read-only with MANAGED; refused as read right before the import; the Workbench leaves it out unless read-only labels are asked for', async () => {
    for (const first of [false, true]) {
      const S = server();
      S.managedFirst = first;
      S.managed.set(LT, { [EN]: 'Run (ISV)', [FR]: 'Lancer (ISV)' });
      const r = rig(S);
      const sl = await r.slots();
      const lt = sl.get(LT)!;
      t.eq([lt.labels, lt.readOnly, lt.ref.managed, sl.get(TT)!.readOnly], [{ [EN]: 'Run', [FR]: 'Lancer' }, MANAGED, true, ''], `managed row first: ${first}`);
      // Slipped through as editable: the read right before the import refuses it.
      const res = await r.save([r.change({ ...lt, readOnly: '', ref: { ...lt.ref, managed: false } }, FR, 'Lancer 2')]);
      t.eq(res.map((x) => [x.outcome, x.message]), [['error', MANAGED]]);
      t.eq([S.files.length, S.solutions.size], [0, 0], 'nothing imported');
      const scope = (includeReadOnly: boolean) => loadRibbonScope(r.ctx, { entities: ['t'], kinds: new Set<Kind>(['ribbon']), includeReadOnly }, { signal: new AbortController().signal, progress() {} });
      t.eq((await scope(false)).map((s) => s.ref.locLabelId), [TT]);
      t.eq((await scope(true)).map((s) => [s.ref.locLabelId, s.readOnly]), [[LT, MANAGED], [TT, '']]);
    }
  });

  t.test('ribbon writer: a label without base text is refused per change (its row would be skipped silently)', async () => {
    const S = server('t', { [LT]: { [FR]: 'Lancer' }, [TT]: { [EN]: 'Run it' } });
    const r = rig(S);
    const sl = await r.slots();
    const res = await r.save([r.change(sl.get(LT)!, FR, 'Lancer 2'), r.change(sl.get(TT)!, FR, 'Le lancer')]);
    t.eq(r.outcomes(res), [[LT, FR, 'error'], [TT, FR, 'saved']]);
    t.ok(/no English text/.test(res[0].message!));
    // With its English text in the same save, it goes through.
    const S2 = server('t', { [LT]: { [FR]: 'Lancer' } });
    const r2 = rig(S2);
    const sl2 = await r2.slots();
    t.eq(r2.outcomes(await r2.save([r2.change(sl2.get(LT)!, FR, 'Lancer 2'), r2.change(sl2.get(LT)!, EN, 'Run')])), [[LT, FR, 'saved'], [LT, EN, 'saved']]);
    t.eq(S2.pub.get(LT), { [FR]: 'Lancer 2', [EN]: 'Run' });
  });

  t.test('ribbon writer: an import that lost a deadlock is tried again from a fresh read; a change made meanwhile is a conflict', () =>
    fast(async () => {
      const S = server();
      S.deadlocks = 1;
      const r = rig(S);
      const sl = await r.slots();
      const res = await r.save([r.change(sl.get(LT)!, FR, 'Lancer le test')]);
      t.eq(r.outcomes(res), [[LT, FR, 'saved']]);
      t.eq(S.files.length, 2);
      t.eq(S.calls.filter((c) => c === 'GET ribbondiffs').length >= 4, true, 'read before each try');

      const B = server();
      B.deadlocks = 1;
      const b = rig(B);
      const bl = await b.slots();
      // Between the failed try and the next one, another maker changes and publishes the same title.
      B.afterDeadlock = () => {
        B.pending.get(LT)![FR] = 'Lancer (collègue)';
        B.pub.get(LT)![FR] = 'Lancer (collègue)';
      };
      const res2 = await b.save([b.change(bl.get(LT)!, FR, 'Lancer le test')]);
      t.eq(res2.map((x) => [x.outcome, x.server]), [['conflict', 'Lancer (collègue)']]);
      t.eq(B.pub.get(LT)![FR], 'Lancer (collègue)');
      t.eq(B.solutions.size, 0);
    }),
  );

  t.test('ribbon writer: deadlocks every time end with "busy, nothing changed"; a refused file is reported and cleaned up', () =>
    fast(async () => {
      const S = server();
      S.deadlocks = 9;
      const r = rig(S);
      const sl = await r.slots();
      // Imports that did not run say so in SaveOptions.ran: none (a Try again finding the text there found someone else's).
      const ran = new Set<string>();
      const res = await r.save([r.change(sl.get(LT)!, FR, 'Lancer le test')], { ran });
      t.eq(r.outcomes(res), [[LT, FR, 'error']]);
      t.ok(/busy/.test(res[0].message!) && /Nothing was changed/.test(res[0].message!), res[0].message);
      t.eq(ran.size, 0, 'no import ran');
      t.eq(S.files.length, 3, 'three tries');
      t.eq(S.pub.get(LT)![FR], 'Lancer');
      t.eq(S.solutions.size, 0);

      const B = server();
      const b = rig(B);
      (b.ctx as { orgId: string }).orgId = 'other-org';
      const bl = await b.slots();
      const res2 = await b.save([b.change(bl.get(LT)!, FR, 'Lancer le test')], { ran });
      t.eq(b.outcomes(res2), [[LT, FR, 'error']]);
      t.ok(/Organization ID/.test(res2[0].message!), res2[0].message);
      t.eq(ran.size, 0, 'the refused file never ran');
      t.eq(B.files.length, 1, 'not retried');
      t.eq(B.solutions.size, 0);
    }),
  );

  t.test('ribbon writer: an import whose answer was lost is published and checked like any other; it ran, as SaveOptions.ran says', async () => {
    const S = server();
    S.loseAnswer = true;
    const r = rig(S);
    const sl = await r.slots();
    const ran = new Set<string>();
    const ch = r.change(sl.get(LT)!, FR, 'Lancer le test');
    const res = await r.save([ch], { ran });
    // The job says Succeeded, so the lost answer doesn't matter; the solution is not kept either.
    t.eq(r.outcomes(res), [[LT, FR, 'saved']]);
    t.eq(S.solutions.size, 0);
    t.eq([...ran], [changeId(ch)]);
    // Its answer lost and no job to read: it may have run, which a Try again finding the text there may be finding.
    const L = server();
    L.lostNoJob = 'now';
    const l = rig(L);
    const ll = await l.slots();
    const lran = new Set<string>();
    const lch = l.change(ll.get(LT)!, FR, 'Lancer le test');
    await l.save([lch], { ran: lran }).catch(() => {});
    t.eq([...lran], [changeId(lch)]);
  });

  t.test('ribbon writer: an import turned away (429) is never resent by Http as built: it is built again from a new read, so a title someone published meanwhile is kept', () =>
    fast(async () => {
      const S = server();
      const r = rig(S);
      const sl = await r.slots();
      // ImportTranslation goes through the real Http (its retries are what is tested) over a fake fetch.
      const http = (r.ctx as { http: { post: (u: string, b: unknown, o?: object) => Promise<unknown> } }).http;
      const inner = http.post.bind(http);
      const real = new Http('https://org.test');
      http.post = (u, b, o) => (u === 'ImportTranslation' ? real.post(u, b, o) : inner(u, b, o));
      let throttle = 1;
      const g = globalThis as { fetch: unknown };
      const had = g.fetch;
      g.fetch = async (_u: unknown, init: { body: string }) => {
        if (throttle > 0) {
          throttle--;
          // While Dataverse throttles, another maker changes the English title and publishes it.
          S.pending.get(LT)![EN] = 'Run now';
          S.pub.get(LT)![EN] = 'Run now';
          return new Response(JSON.stringify({ error: { code: '0x80072322', message: 'Number of requests exceeded the limit.' } }), { status: 429, headers: { 'Retry-After': '1' } });
        }
        try {
          return new Response(JSON.stringify((await inner('ImportTranslation', JSON.parse(init.body))) ?? {}), { status: 200 });
        } catch (e) {
          const x = e as DvError;
          return new Response(JSON.stringify({ error: { code: x.code, message: x.message } }), { status: x.status || 500 });
        }
      };
      try {
        const res = await r.save([r.change(sl.get(LT)!, FR, 'Lancer le test')]);
        t.eq(r.outcomes(res), [[LT, FR, 'saved']]);
        t.eq(S.pub.get(LT), { [EN]: 'Run now', [FR]: 'Lancer le test' }, "the other maker's English title is kept");
        t.eq(S.files.length, 1, 'only one file reached the import');
        t.eq(readFile(S.files[0]).rows.map((x) => [...x.cells.values()]), [['Run now', 'Lancer le test']], 'built from a new read');
      } finally {
        g.fetch = had;
      }
    }),
  );

  t.test('ribbon writer: rows Dataverse ignored are errors, never "saved"', async () => {
    // The import "succeeds" but applies no row when the solution doesn't hold the table (finding 27)…
    const S = server();
    const r = rig(S);
    const sl = await r.slots();
    S.beforeImport = () => {
      for (const s of S.solutions.values()) s.comps = [];
    };
    const res = await r.save([r.change(sl.get(LT)!, FR, 'Lancer le test')]);
    t.eq(res.map((x) => x.outcome), ['error']);
    t.ok(/does not show this text/.test(res[0].message!), res[0].message);
    t.eq(S.pub.get(LT)![FR], 'Lancer');
    // …or when the label left the ribbon in the meantime (an unknown LocLabel is ignored, finding 72).
    const B = server();
    const b = rig(B);
    const bl = await b.slots();
    B.beforeImport = () => void B.pending.delete(TT);
    const res2 = await b.save([b.change(bl.get(TT)!, FR, 'Le lancer 2')]);
    t.eq(res2.map((x) => x.outcome), ['error']);
    t.ok(/no longer on the command bar/.test(res2[0].message!), res2[0].message);
  });

  t.test('ribbon writer: a dry run builds the file and stops before the import', async () => {
    const S = server();
    const r = rig(S);
    const sl = await r.slots();
    RIBBON_DRY_RUN.on = true;
    try {
      const res = await r.save([r.change(sl.get(TT)!, FR, 'Le lancer 2')]);
      t.eq(res.map((x) => x.outcome), ['skipped']);
      t.ok(RIBBON_DRY_RUN.last?.xml.includes('Le lancer 2') && RIBBON_DRY_RUN.last.entity === 't');
      t.eq(S.files.length, 0);
      t.eq(S.solutions.size, 0);
    } finally {
      RIBBON_DRY_RUN.on = false;
      RIBBON_DRY_RUN.last = undefined;
    }
  });

  // ---- someone else publishing while a save runs ----

  t.test('ribbon writer: an English title someone publishes after the read and before the import is put back once this save is published; the French saves, and says to check the label', async () => {
    const S = server();
    const r = rig(S);
    const sl = await r.slots();
    S.beforeImport = () => {
      S.pending.get(LT)![EN] = 'Run now';
      S.pub.get(LT)![EN] = 'Run now';
    };
    const res = await r.save([r.change(sl.get(LT)!, FR, 'Lancer le test')]);
    // The put-back import runs for seconds no read sees into: never plainly saved.
    t.eq(r.outcomes(res), [[LT, FR, 'error']]);
    t.eq(res[0].message, "Saved, but someone else was changing this button's text at the same time — check it: the English text of “Run” (new.t.Btn.LabelText). It now reads English “Run now”, French “Lancer le test”.");
    t.eq(S.pub.get(LT), { [EN]: 'Run now', [FR]: 'Lancer le test' }, 'their English, our French');
    t.eq(S.files.map((f) => readFile(f).rows.map((x) => [x.id, ...x.cells.values()])), [[[LT, 'Run', 'Lancer le test']], [[LT, 'Run now']]], 'the import carried the English it read; the second one puts theirs back');
    t.eq(S.calls.filter((c) => /^POST (PublishXml|ImportTranslation)/.test(c)), ['POST PublishXml', 'POST ImportTranslation', 'POST PublishXml', 'POST ImportTranslation', 'POST PublishXml']);
    t.eq(S.solutions.size, 0);
  });

  t.test('ribbon writer: an English title published after the import needs nothing put back; nothing else is imported', async () => {
    const S = server();
    const r = rig(S);
    const sl = await r.slots();
    S.afterImport = () => {
      S.afterImport = undefined;
      S.pending.get(LT)![EN] = 'Run now';
      S.pub = new Map([...S.pending].map(([k, v]) => [k, { ...v }])); // their publish shows our pending French too
    };
    const res = await r.save([r.change(sl.get(LT)!, FR, 'Lancer le test')]);
    t.eq(r.outcomes(res), [[LT, FR, 'saved']], JSON.stringify(res.map((x) => x.message)));
    t.eq(S.pub.get(LT), { [EN]: 'Run now', [FR]: 'Lancer le test' });
    t.eq(S.files.length, 1);
  });

  t.test('ribbon writer: a French title someone publishes just before the import is put back and the change is a conflict, never silently replaced', async () => {
    const S = server();
    const r = rig(S);
    const sl = await r.slots();
    S.beforeImport = () => {
      S.beforeImport = undefined;
      S.pending.get(LT)![FR] = 'Lancer (collègue)';
      S.pub.get(LT)![FR] = 'Lancer (collègue)';
    };
    const res = await r.save([r.change(sl.get(LT)!, FR, 'Lancer le test')]);
    t.eq(res.map((x) => [x.outcome, x.server]), [['conflict', 'Lancer (collègue)']]);
    t.eq(S.pub.get(LT), { [EN]: 'Run', [FR]: 'Lancer (collègue)' });
    t.eq(readFile(S.files[1]).rows.map((x) => [x.id, ...x.cells.values()]), [[LT, 'Run', 'Lancer (collègue)']], 'theirs, with the base text the row needs');

    // The same French text from both: nothing to put back, saved.
    const B = server();
    const b = rig(B);
    const bl = await b.slots();
    B.beforeImport = () => {
      B.pending.get(LT)![FR] = 'Lancer le test';
      B.pub.get(LT)![FR] = 'Lancer le test';
    };
    t.eq(b.outcomes(await b.save([b.change(bl.get(LT)!, FR, 'Lancer le test')])), [[LT, FR, 'saved']]);
    t.eq(B.files.length, 1);
  });

  t.test('ribbon writer: without the read right after the import, a change published at that moment cannot be ruled out: never plainly saved', () =>
    fast(async () => {
      const S = server();
      const r = rig(S);
      const sl = await r.slots();
      const before = S.reads;
      // The reads: before publishing, before the import, then right after it (and its second try).
      S.failReads = new Set([before + 3, before + 4]);
      const res = await r.save([r.change(sl.get(LT)!, FR, 'Lancer le test')]);
      t.eq(r.outcomes(res), [[LT, FR, 'error']]);
      t.ok(/can't be ruled out/.test(res[0].message!), res[0].message);
      t.eq(S.pub.get(LT), { [EN]: 'Run', [FR]: 'Lancer le test' });
    }),
  );

  t.test('ribbon writer: a publish that fails after the import says the text is imported but not published; Try again publishes it', async () => {
    const S = server();
    const r = rig(S);
    const sl = await r.slots();
    S.failPublish = new Set([2]); // the publish first goes through, the one after the import fails
    const ch = r.change(sl.get(LT)!, FR, 'Lancer le test');
    const ran = new Set<string>();
    const res = await r.save([ch], { ran });
    t.eq(r.outcomes(res), [[LT, FR, 'error']]);
    t.eq([...ran], [changeId(ch)], 'imported: a Try again finding it as asked finds this import (SaveOptions.ran)');
    t.ok(/^The French text was imported but not published \(Generic SQL error\): users see the old text until Test table's command bar is published\. Try again to publish it\./.test(res[0].message!), res[0].message);
    t.eq([S.pub.get(LT)![FR], S.pending.get(LT)![FR], S.solutions.size], ['Lancer', 'Lancer le test', 0], 'pending, not published; the temporary solution is gone');
    const again = await r.save([ch]);
    t.eq(r.outcomes(again), [[LT, FR, 'unchanged']]);
    t.eq([S.pub.get(LT)![FR], S.files.length], ['Lancer le test', 1], 'published by the first publish of Try again; nothing imported again');
  });

  t.test("ribbon writer: when that publish fails after an import that wrote over someone else's English, the message says so and Try again puts theirs back", async () => {
    const S = server();
    const r = rig(S);
    const sl = await r.slots();
    S.beforeImport = () => {
      S.beforeImport = undefined;
      S.pending.get(LT)![EN] = 'Run now';
      S.pub.get(LT)![EN] = 'Run now';
    };
    S.failPublish = new Set([2]);
    const ch = r.change(sl.get(LT)!, FR, 'Lancer le test');
    const res = await r.save([ch]);
    t.eq(r.outcomes(res), [[LT, FR, 'error']]);
    t.ok(/Someone else published “Run now” as the English text at the same moment, which this save may have put back: Try again puts theirs back after publishing/.test(res[0].message!), res[0].message);
    t.eq(S.pending.get(LT)![EN], 'Run', 'the import wrote the English it read over theirs (unpublished)');
    const again = await r.save([ch]);
    t.eq(r.outcomes(again), [[LT, FR, 'error']], 'a put-back ran: never plainly up to date');
    t.ok(/^Saved, but someone else was changing this button's text at the same time — check it: the English text of “Run”.*It now reads English “Run now”, French “Lancer le test”\.$/.test(again[0].message!), again[0].message);
    t.eq(S.pub.get(LT), { [EN]: 'Run now', [FR]: 'Lancer le test' }, 'theirs is back, our French published');
  });

  t.test('ribbon writer: when putting their English back fails, the French change says so, never saved', () =>
    fast(async () => {
      const S = server();
      const r = rig(S);
      const sl = await r.slots();
      S.beforeImport = () => {
        S.beforeImport = undefined;
        S.pending.get(LT)![EN] = 'Run now';
        S.pub.get(LT)![EN] = 'Run now';
      };
      S.afterImport = () => (S.deadlocks = 9); // every import after this one loses a deadlock
      const ch = r.change(sl.get(LT)!, FR, 'Lancer le test');
      const res = await r.save([ch]);
      t.eq(r.outcomes(res), [[LT, FR, 'error']]);
      t.ok(/^Saved, but someone else published “Run now” as the English text of this label at the same moment, and this save put back “Run”; putting theirs back failed \(Dataverse is busy/.test(res[0].message!), res[0].message);
      t.eq([S.pub.get(LT)![EN], S.solutions.size], ['Run', 0]);
      // Try again, once imports go through: the French is already there, and theirs is put back before anything is read.
      S.afterImport = undefined;
      S.deadlocks = 0;
      const again = await r.save([ch]);
      t.eq(r.outcomes(again), [[LT, FR, 'error']]);
      t.ok(/^Saved, but someone else was changing this button's text at the same time — check it/.test(again[0].message!), again[0].message);
      t.eq(S.pub.get(LT), { [EN]: 'Run now', [FR]: 'Lancer le test' });
      t.eq(RIBBON_OWED.size, 0, 'nothing owed any more');
    }),
  );

  t.test('ribbon writer: when putting their French back fails, Try again puts it back and calls the change a conflict, never "already up to date"', () =>
    fast(async () => {
      const S = server();
      const r = rig(S);
      const sl = await r.slots();
      S.beforeImport = () => {
        S.beforeImport = undefined;
        S.pending.get(LT)![FR] = 'Lancer (collègue)';
        S.pub.get(LT)![FR] = 'Lancer (collègue)';
      };
      S.afterImport = () => (S.deadlocks = 9);
      const ch = r.change(sl.get(LT)!, FR, 'Lancer le test');
      const res = await r.save([ch]);
      t.eq(r.outcomes(res), [[LT, FR, 'error']]);
      t.ok(/^Someone else published “Lancer \(collègue\)” here at the same moment, and this save replaced it; putting theirs back failed/.test(res[0].message!), res[0].message);
      t.eq(S.pub.get(LT)![FR], 'Lancer le test');
      S.afterImport = undefined;
      S.deadlocks = 0;
      // Our French reads as asked before Try again puts theirs back: the answer is the text there once theirs is back.
      const again = await r.save([ch]);
      t.eq(again.map((x) => [x.outcome, x.server]), [['conflict', 'Lancer (collègue)']], JSON.stringify(again.map((x) => x.message)));
      t.eq(S.pub.get(LT), { [EN]: 'Run', [FR]: 'Lancer (collègue)' });
      t.eq(RIBBON_OWED.size, 0);
    }),
  );

  t.test('ribbon writer: a put-back import whose answer was lost and that changed nothing is owed like a failed one: Try again puts theirs back', () =>
    fast(async () => {
      const S = server();
      const r = rig(S);
      const sl = await r.slots();
      S.beforeImport = () => {
        S.beforeImport = undefined;
        S.pending.get(LT)![EN] = 'Run now';
        S.pub.get(LT)![EN] = 'Run now';
      };
      S.afterImport = () => {
        S.afterImport = undefined;
        S.loseBefore = 1; // the import that puts theirs back: 504, nothing applied
      };
      const ch = r.change(sl.get(LT)!, FR, 'Lancer le test');
      const res = await r.save([ch]);
      t.eq(r.outcomes(res), [[LT, FR, 'error']]);
      t.ok(/putting theirs back failed/.test(res[0].message!), res[0].message);
      t.eq([S.pub.get(LT)![EN], RIBBON_OWED.size], ['Run', 1], 'still ours, and owed');
      t.ok(/\(the import did not answer, and Dataverse does not show it\)/.test(res[0].message!), res[0].message);
      const again = await r.save([ch]);
      t.eq(r.outcomes(again), [[LT, FR, 'error']]);
      t.ok(/^Saved, but someone else was changing this button's text at the same time — check it/.test(again[0].message!), again[0].message);
      t.eq([S.pub.get(LT), RIBBON_OWED.size], [{ [EN]: 'Run now', [FR]: 'Lancer le test' }, 0]);
    }),
  );

  t.test("ribbon writer: a publish that fails after an import whose check right after could not be read says that a change published meanwhile can't be ruled out", () =>
    fast(async () => {
      const S = server();
      const r = rig(S);
      const sl = await r.slots();
      const before = S.reads;
      S.failReads = new Set([before + 3, before + 4]);
      S.failPublish = new Set([2]);
      const res = await r.save([r.change(sl.get(LT)!, FR, 'Lancer le test')]);
      t.eq(r.outcomes(res), [[LT, FR, 'error']]);
      t.ok(/^The French text was imported but not published \(Generic SQL error\)/.test(res[0].message!), res[0].message);
      t.ok(/can't be ruled out/.test(res[0].message!), res[0].message);
    }),
  );

  // ---- someone else publishing while a put-back import runs ----

  /** Another maker publishing `text` as the `lcid` title of `id` (their import, then their publish). */
  const publishBy = (S: Server, id: string, lcid: number, text: string) => {
    S.pending.get(id)![lcid] = text;
    S.pub.get(id)![lcid] = text;
  };
  /** Runs `fn` once, right after the first ribbondiffs read once `n` publishes have run (the put-back's own read). */
  const afterReadOnce = (S: Server, n: number, fn: () => void) => {
    S.afterRead = () => {
      if (S.publishes !== n) return;
      S.afterRead = undefined;
      fn();
    };
  };
  const rowsOf = (S: Server) => S.files.map((f) => readFile(f).rows.map((x) => [x.id, ...x.cells.values()]));

  t.test('ribbon writer: English B published while the put-back of English A runs is put back too, never replaced by A; the French change is never plainly saved', async () => {
    const S = server();
    const r = rig(S);
    const sl = await r.slots();
    S.beforeImport = () => {
      S.beforeImport = undefined;
      publishBy(S, LT, EN, 'English A');
    };
    afterReadOnce(S, 2, () => publishBy(S, LT, EN, 'English B'));
    const res = await r.save([r.change(sl.get(LT)!, FR, 'My French')]);
    t.eq(S.pub.get(LT), { [EN]: 'English B', [FR]: 'My French' }, 'the newest English survives');
    t.eq(S.pub.get(TT), { [EN]: 'Run it', [FR]: 'Le lancer', [DE]: 'Ausführen' });
    t.eq(rowsOf(S), [[[LT, 'Run', 'My French']], [[LT, 'English A']], [[LT, 'English B']]], 'A put back, then B over the put-back that replaced it');
    t.eq(r.outcomes(res), [[LT, FR, 'error']]);
    t.ok(/^Saved, but someone else was changing this button's text at the same time — check it: the English text of “Run” \(new\.t\.Btn\.LabelText\)\. It now reads English “English B”, French “My French”\./.test(res[0].message!), res[0].message);
    t.eq([S.solutions.size, RIBBON_OWED.size], [0, 0]);
  });

  t.test('ribbon writer: a put-back that carries the English base cell next to their French: an English change published meanwhile is put back, and the French conflict does not hide it', async () => {
    const S = server();
    const r = rig(S);
    const sl = await r.slots();
    S.beforeImport = () => {
      S.beforeImport = undefined;
      publishBy(S, LT, FR, 'Lancer (collègue)');
    };
    afterReadOnce(S, 2, () => publishBy(S, LT, EN, 'Run now'));
    const res = await r.save([r.change(sl.get(LT)!, FR, 'Lancer le test')]);
    t.eq(S.pub.get(LT), { [EN]: 'Run now', [FR]: 'Lancer (collègue)' }, 'their French and the newer English');
    t.eq(rowsOf(S), [[[LT, 'Run', 'Lancer le test']], [[LT, 'Run', 'Lancer (collègue)']], [[LT, 'Run now']]]);
    t.eq(r.outcomes(res), [[LT, FR, 'error']], 'never a bare conflict: the review shows a conflict without its message');
    t.ok(/^Someone else published this text at the same moment\. Theirs was put back: choose which one to keep\. Also, someone else was changing this button's text at the same time — check it: the English text of “Run”/.test(res[0].message!), res[0].message);
    t.ok(/It now reads English “Run now”, French “Lancer \(collègue\)”\./.test(res[0].message!), res[0].message);
  });

  t.test('ribbon writer: when the English published during that put-back cannot be put back, the French conflict says the English was lost; Try again puts it back', () =>
    fast(async () => {
      const S = server();
      const r = rig(S);
      const sl = await r.slots();
      S.beforeImport = () => {
        S.beforeImport = undefined;
        publishBy(S, LT, FR, 'Lancer (collègue)');
      };
      afterReadOnce(S, 2, () => publishBy(S, LT, EN, 'Run now'));
      // The put-back of their French goes through; every import after it loses a deadlock.
      let n = 0;
      S.afterImport = () => void (++n === 2 && (S.deadlocks = 9));
      const ch = r.change(sl.get(LT)!, FR, 'Lancer le test');
      const res = await r.save([ch]);
      t.eq([S.pub.get(LT), r.outcomes(res)], [{ [EN]: 'Run', [FR]: 'Lancer (collègue)' }, [[LT, FR, 'error']]]);
      t.ok(/^Someone else published this text at the same moment\. Theirs was put back: choose which one to keep\. Also, someone else published “Run now” as the English text of this label at the same moment, and this save put back “Run”; putting theirs back failed \(Dataverse is busy/.test(res[0].message!), res[0].message);
      t.eq(RIBBON_OWED.get('t')?.length, 1, 'their English is owed');
      S.afterImport = undefined;
      S.deadlocks = 0;
      const again = await r.save([ch]);
      t.eq(S.pub.get(LT), { [EN]: 'Run now', [FR]: 'Lancer (collègue)' });
      t.eq(again.map((x) => x.outcome), ['conflict'], JSON.stringify(again.map((x) => x.message)));
      t.eq(RIBBON_OWED.size, 0);
    }),
  );

  t.test('ribbon writer: repeated put-backs: each English published while one runs is put back by the next, the newest survives', async () => {
    const S = server();
    const r = rig(S);
    const sl = await r.slots();
    S.beforeImport = () => {
      S.beforeImport = undefined;
      publishBy(S, LT, EN, 'English A');
    };
    afterReadOnce(S, 2, () => {
      publishBy(S, LT, EN, 'English B');
      afterReadOnce(S, 3, () => publishBy(S, LT, EN, 'English C'));
    });
    const res = await r.save([r.change(sl.get(LT)!, FR, 'My French')]);
    t.eq(S.pub.get(LT), { [EN]: 'English C', [FR]: 'My French' });
    t.eq(rowsOf(S).slice(1), [[[LT, 'English A']], [[LT, 'English B']], [[LT, 'English C']]]);
    t.eq(r.outcomes(res), [[LT, FR, 'error']]);
    t.ok(/check it: the English text of “Run”.*It now reads English “English C”, French “My French”\./.test(res[0].message!), res[0].message);
  });

  t.test('ribbon writer: put-backs are bounded: one more English published while the last allowed one runs is owed, said, and put back by Try again', () =>
    fast(async () => {
      const S = server();
      const r = rig(S);
      const sl = await r.slots();
      S.beforeImport = () => {
        S.beforeImport = undefined;
        publishBy(S, LT, EN, 'English A');
      };
      afterReadOnce(S, 2, () => {
        publishBy(S, LT, EN, 'English B');
        afterReadOnce(S, 3, () => {
          publishBy(S, LT, EN, 'English C');
          afterReadOnce(S, 4, () => publishBy(S, LT, EN, 'English D'));
        });
      });
      const ch = r.change(sl.get(LT)!, FR, 'My French');
      const res = await r.save([ch]);
      t.eq([S.pub.get(LT)![EN], S.files.length], ['English C', 4], 'three put-backs at most');
      t.eq(r.outcomes(res), [[LT, FR, 'error']]);
      t.ok(/^Saved, but someone else published “English D” as the English text of this label at the same moment, and this save put back “English C”; putting theirs back failed \(someone else kept changing it/.test(res[0].message!), res[0].message);
      t.eq(RIBBON_OWED.get('t')?.length, 1);
      const again = await r.save([ch]);
      t.eq(S.pub.get(LT), { [EN]: 'English D', [FR]: 'My French' });
      t.eq(r.outcomes(again), [[LT, FR, 'error']], 'a put-back ran: never plainly up to date');
      t.ok(/^Saved, but someone else was changing this button's text at the same time — check it: the English text of “Run”.*It now reads English “English D”, French “My French”\./.test(again[0].message!), again[0].message);
      t.eq(RIBBON_OWED.size, 0);
    }),
  );

  t.test("ribbon writer: Try again's own put-back is watched the same way: an English published while it runs is put back, or said and owed when it can't be", () =>
    fast(async () => {
      const S = server();
      const r = rig(S);
      const sl = await r.slots();
      S.beforeImport = () => {
        S.beforeImport = undefined;
        publishBy(S, LT, EN, 'Run now');
      };
      S.afterImport = () => (S.deadlocks = 9); // the put-back of their English never runs: owed
      const ch = r.change(sl.get(LT)!, FR, 'Lancer le test');
      await r.save([ch]);
      t.eq([S.pub.get(LT)![EN], S.publishes, RIBBON_OWED.get('t')?.length], ['Run', 2, 1]);
      S.afterImport = undefined;
      S.deadlocks = 0;
      // Try again: right after the read its put-back is built from (once its first publish ran), a third English.
      afterReadOnce(S, 3, () => publishBy(S, LT, EN, 'Run later'));
      const again = await r.save([ch]);
      t.eq(S.pub.get(LT), { [EN]: 'Run later', [FR]: 'Lancer le test' });
      t.eq(rowsOf(S).slice(-2), [[[LT, 'Run now']], [[LT, 'Run later']]]);
      t.eq([r.outcomes(again), RIBBON_OWED.size], [[[LT, FR, 'error']], 0]);
      t.ok(/^Saved, but someone else was changing this button's text at the same time — check it: the English text of “Run”.*It now reads English “Run later”, French “Lancer le test”\./.test(again[0].message!), again[0].message);

      // The same, but the put-back of the third English can't run: said on the change, and owed.
      const B = server();
      const b = rig(B);
      const bl = await b.slots();
      B.beforeImport = () => {
        B.beforeImport = undefined;
        publishBy(B, LT, EN, 'Run now');
      };
      B.afterImport = () => (B.deadlocks = 9);
      const bch = b.change(bl.get(LT)!, FR, 'Lancer le test');
      await b.save([bch]);
      B.deadlocks = 0;
      afterReadOnce(B, 3, () => publishBy(B, LT, EN, 'Run later'));
      B.afterImport = () => (B.deadlocks = 9); // Try again's first put-back runs; the next one doesn't
      const bagain = await b.save([bch]);
      t.eq([B.pub.get(LT)![EN], b.outcomes(bagain)], ['Run now', [[LT, FR, 'error']]]);
      t.ok(/^Saved, but someone else published “Run later” as the English text of this label at the same moment, and this save put back “Run now”; putting theirs back failed \(Dataverse is busy/.test(bagain[0].message!), bagain[0].message);
      t.eq(RIBBON_OWED.get('t')?.map((m) => (m as { theirs: string }).theirs), ['Run later']);
      B.afterImport = undefined;
      B.deadlocks = 0;
      await b.save([bch]);
      t.eq([B.pub.get(LT)![EN], RIBBON_OWED.size], ['Run later', 0]);
    }),
  );

  t.test("ribbon writer: what an earlier save owes on a label a managed solution defines by now is never put back, nor owed again; that label's change is refused with MANAGED and says theirs can't be restored, the scope's other change is saved", () =>
    fast(async () => {
      const S = server();
      const r = rig(S);
      const sl = await r.slots();
      S.beforeImport = () => {
        S.beforeImport = undefined;
        publishBy(S, LT, EN, 'Run now');
      };
      S.afterImport = () => (S.deadlocks = 9); // the put-back of their English never runs: owed
      const ch = r.change(sl.get(LT)!, FR, 'Lancer le test');
      await r.save([ch]);
      t.eq([S.pub.get(LT)![EN], RIBBON_OWED.get('t')?.length], ['Run', 1]);
      S.afterImport = undefined;
      S.deadlocks = 0;
      // A managed solution now defines that label too (its unmanaged row stays).
      S.managed.set(LT, { [EN]: 'Run (ISV)', [FR]: 'Lancer (ISV)' });
      const n = S.files.length;
      const again = await r.save([ch, r.change(sl.get(TT)!, FR, 'Le lancer 2')]);
      t.eq(r.outcomes(again), [[LT, FR, 'error'], [TT, FR, 'saved']]);
      t.ok(again[0].message!.startsWith(`${MANAGED} Someone else's “Run now” (the English text of this label) that an earlier save put back can't be restored here: it now comes from a managed solution`), again[0].message);
      t.eq(rowsOf(S).slice(n), [[[TT, 'Run it', 'Le lancer 2']]], 'only the other label imported: theirs never written back');
      t.eq([S.pub.get(LT)![EN], RIBBON_OWED.size], ['Run', 0]);
    }),
  );

  t.test("ribbon writer: a save stopped right after its put-back of what an earlier save owed never says only that nothing was changed: their text lost meanwhile, or the put-back's moment, is said", () =>
    fast(async () => {
      const S = server();
      const r = rig(S);
      const sl = await r.slots();
      S.beforeImport = () => {
        S.beforeImport = undefined;
        publishBy(S, LT, EN, 'Run now');
      };
      S.afterImport = () => (S.deadlocks = 9); // the put-back of their English never runs: owed
      await r.save([r.change(sl.get(LT)!, FR, 'Lancer le test')]);
      t.eq([S.pub.get(LT)![EN], RIBBON_OWED.get('t')?.length], ['Run', 1]);
      S.deadlocks = 0;
      // The next save of the table (a German text of the same button) puts theirs back first; English B is published while
      // that runs, and its own put-back can't run; Stop is pressed meanwhile.
      const stop = new AbortController();
      afterReadOnce(S, 3, () => publishBy(S, LT, EN, 'English B'));
      S.afterImport = () => {
        S.deadlocks = 9;
        stop.abort();
      };
      const res = await r.save([r.change(sl.get(LT)!, DE, 'Starten')], { signal: stop.signal });
      t.eq([S.pub.get(LT)![EN], r.outcomes(res)], ['Run now', [[LT, DE, 'skipped']]]);
      t.ok(/^Cancelled before the import: this change was not saved\. Also, someone else published “English B” as the English text of this label at the same moment, and this save put back “Run now”; putting theirs back failed \(Dataverse is busy/.test(res[0].message!), res[0].message);
      t.eq(RIBBON_OWED.get('t')?.map((m) => (m as { theirs: string }).theirs), ['English B']);

      // The put-back goes through and Stop is pressed: the change is not saved, and the label is to be checked.
      const stop2 = new AbortController();
      S.afterImport = () => stop2.abort();
      S.deadlocks = 0;
      const res2 = await r.save([r.change(sl.get(LT)!, DE, 'Starten')], { signal: stop2.signal });
      t.eq([S.pub.get(LT)![EN], r.outcomes(res2), RIBBON_OWED.size], ['English B', [[LT, DE, 'skipped']], 0]);
      t.ok(/^Cancelled before the import: this change was not saved\. Also, someone else was changing this button's text at the same time — check it: the English text of “Run”.*It now reads English “English B”/.test(res2[0].message!), res2[0].message);
    }),
  );

  t.test('ribbon writer: a put-back whose publish fails: what was published while it ran is owed with it; Try again shows the newest English, not the put-back', async () => {
    const S = server();
    const r = rig(S);
    const sl = await r.slots();
    S.beforeImport = () => {
      S.beforeImport = undefined;
      publishBy(S, LT, EN, 'English A');
    };
    afterReadOnce(S, 2, () => publishBy(S, LT, EN, 'English B'));
    S.failPublish = new Set([3]); // the put-back's publish
    const ch = r.change(sl.get(LT)!, FR, 'My French');
    const res = await r.save([ch]);
    t.eq([S.pub.get(LT)![EN], S.pending.get(LT)![EN]], ['English B', 'English A'], 'the put-back of A lies unpublished over B');
    t.eq(r.outcomes(res), [[LT, FR, 'error']]);
    t.ok(/someone else published “English B” as the English text of this label at the same moment, and this save put back “English A”; putting theirs back failed \(it was imported but not published/.test(res[0].message!), res[0].message);
    const again = await r.save([ch]);
    t.eq(S.pub.get(LT), { [EN]: 'English B', [FR]: 'My French' });
    t.eq([r.outcomes(again), RIBBON_OWED.size], [[[LT, FR, 'error']], 0]);
    t.ok(/check it: the English text of “Run”.*It now reads English “English B”/.test(again[0].message!), again[0].message);
  });

  t.test('ribbon writer: a put-back import whose answer is lost while English B is published: B stays, and nothing is plainly saved', () =>
    fast(async () => {
      const S = server();
      const r = rig(S);
      const sl = await r.slots();
      S.beforeImport = () => {
        S.beforeImport = undefined;
        publishBy(S, LT, EN, 'English A');
      };
      // The put-back's read, then B, then its import: applied, but its answer is lost (the job still says Succeeded).
      afterReadOnce(S, 2, () => {
        publishBy(S, LT, EN, 'English B');
        S.loseAnswer = true;
      });
      const res = await r.save([r.change(sl.get(LT)!, FR, 'My French')]);
      t.eq(S.pub.get(LT), { [EN]: 'English B', [FR]: 'My French' });
      t.eq(r.outcomes(res), [[LT, FR, 'error']]);
      t.ok(/^Saved, but someone else was changing this button's text at the same time — check it.*It now reads English “English B”/.test(res[0].message!), res[0].message);

      // Lost before anything was applied, with no job to read: B shows; the put-back may still run, so it is never saved.
      const B = server();
      const b = rig(B);
      const bl = await b.slots();
      B.beforeImport = () => {
        B.beforeImport = undefined;
        publishBy(B, LT, EN, 'English A');
      };
      afterReadOnce(B, 2, () => {
        publishBy(B, LT, EN, 'English B');
        B.loseBefore = 1;
      });
      const res2 = await b.save([b.change(bl.get(LT)!, FR, 'My French')]);
      t.eq(B.pub.get(LT), { [EN]: 'English B', [FR]: 'My French' });
      t.eq(b.outcomes(res2), [[LT, FR, 'error']]);
      t.ok(/check it.*It now reads English “English B”.* An import that put theirs back did not answer and may still be running: check it again in a minute\. The temporary solution "dxt_ribbon_t_\w+" was kept because its import may still be running/.test(res2[0].message!), res2[0].message);
    }),
  );

  t.test('ribbon writer: a put-back of their French whose answer is lost and that lands late, after English B was published: the conflict is never bare, and names the English it may have written over', async () => {
    const S = server();
    const r = rig(S);
    const sl = await r.slots();
    S.beforeImport = () => {
      S.beforeImport = undefined;
      publishBy(S, LT, FR, 'Lancer (collègue)');
    };
    // The put-back's own read; its import goes unanswered (no job to read) and lands only after the read right after it,
    // once English B is published: it carries the English it read, and no read ever shows B.
    afterReadOnce(S, 2, () => {
      S.lostNoJob = 'late';
      afterReadOnce(S, 2, () => {
        publishBy(S, LT, EN, 'English B');
        S.deferred!();
      });
    });
    const res = await r.save([r.change(sl.get(LT)!, FR, 'Lancer le test')]);
    t.eq(S.pub.get(LT), { [EN]: 'Run', [FR]: 'Lancer (collègue)' }, 'what no read can see: the late put-back wrote the English it read over B');
    t.eq(r.outcomes(res), [[LT, FR, 'error']], 'never a bare conflict: the review shows a conflict without its message');
    t.ok(
      /^Someone else published this text at the same moment\. Theirs was put back: choose which one to keep\. Also, someone else was changing this button's text at the same time — check it: the English text of “Run” \(new\.t\.Btn\.LabelText\)\. It now reads English “Run”, French “Lancer \(collègue\)”\. An import that put theirs back did not answer and may still be running: check it again in a minute\./.test(res[0].message!),
      res[0].message,
    );
  });

  t.test('ribbon writer: a put-back import whose answer is lost (no job to read) is never taken as finished because a later put-back import answered: the temporary solution is kept', async () => {
    const S = server();
    const r = rig(S);
    const sl = await r.slots();
    S.beforeImport = () => {
      S.beforeImport = undefined;
      publishBy(S, LT, EN, 'English A');
    };
    // Right after the put-back's own read, English B; that put-back (A) then lands over B, unanswered, with no job logged.
    afterReadOnce(S, 2, () => {
      publishBy(S, LT, EN, 'English B');
      S.lostNoJob = 'now';
    });
    const res = await r.save([r.change(sl.get(LT)!, FR, 'My French')]);
    t.eq(S.pub.get(LT), { [EN]: 'English B', [FR]: 'My French' }, 'B put back by the next put-back');
    t.eq(rowsOf(S).slice(1), [[[LT, 'English A']], [[LT, 'English B']]]);
    t.eq(r.outcomes(res), [[LT, FR, 'error']]);
    t.ok(/may still be running: check it again in a minute\. The temporary solution "dxt_ribbon_t_\w+" was kept because its import may still be running/.test(res[0].message!), res[0].message);
    t.eq(S.solutions.size, 1, 'kept');
  });

  t.test("ribbon writer: without the read right after a put-back import, a change published at that moment can't be ruled out: the French change says so", () =>
    fast(async () => {
      const S = server();
      const r = rig(S);
      const sl = await r.slots();
      S.beforeImport = () => {
        S.beforeImport = undefined;
        publishBy(S, LT, EN, 'English A');
      };
      // The reads: before publishing, before the import, right after it, the put-back's, then right after the put-back (twice).
      const before = S.reads;
      S.failReads = new Set([before + 5, before + 6]);
      const res = await r.save([r.change(sl.get(LT)!, FR, 'My French')]);
      t.eq(S.pub.get(LT), { [EN]: 'English A', [FR]: 'My French' });
      t.eq(r.outcomes(res), [[LT, FR, 'error']]);
      t.ok(/^Saved, but someone else was changing this button's text at the same time — check it/.test(res[0].message!), res[0].message);
      t.ok(/could not be read right after putting theirs back, so another change at that moment can't be ruled out/.test(res[0].message!), res[0].message);
    }),
  );

  t.test("ribbon writer: stale temporary solutions are deleted only when this user made them more than an hour ago, never another maker's", async () => {
    const S = server();
    const r = rig(S);
    const sl = await r.slots();
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const recent = new Date(Date.now() - 600_000).toISOString();
    const OTHER = '0a1b2c3d-0000-4000-8000-00000000000b';
    // Answered whatever the filter asks: the writer checks each row again.
    S.stale = [
      { solutionid: 'mine-old', uniquename: 'dxt_ribbon_t_1', ismanaged: false, createdon: old, _createdby_value: ME },
      { solutionid: 'mine-new', uniquename: 'dxt_ribbon_t_2', ismanaged: false, createdon: recent, _createdby_value: ME },
      { solutionid: 'theirs-old', uniquename: 'dxt_ribbon_t_3', ismanaged: false, createdon: old, _createdby_value: OTHER },
      { solutionid: 'managed-old', uniquename: 'dxt_ribbon_t_4', ismanaged: true, createdon: old, _createdby_value: ME },
      { solutionid: 'other-name', uniquename: 'contoso_tools', ismanaged: false, createdon: old, _createdby_value: ME },
    ];
    await r.save([r.change(sl.get(LT)!, FR, 'Lancer le test')]);
    t.eq(S.calls.filter((c) => c.startsWith('DELETE')), ['DELETE solutions(sol1)', 'DELETE solutions(mine-old)']);
    t.ok(S.staleAsked.length === 1 && S.staleAsked[0].includes(`_createdby_value eq ${ME}`) && S.staleAsked[0].includes('ismanaged eq false'), S.staleAsked[0]);
  });

  t.test('ribbon popup: a LocLabel other buttons also show says so before saving; an application ribbon label says every table', () => {
    const lab = (scope: string, id: string, text: string): Slot =>
      ({ key: `ribbon|${scope}|${id}|Label`, kind: 'ribbon', prop: 'Label', entity: scope === '_app' ? '' : scope, comp: `ribbon|${scope}|${id}`, group: `ribbon|${scope}`, title: text, path: ['Account', 'Command bar (classic)'], sub: id, labels: { [EN]: text }, readOnly: '', baseRequired: true, max: 0, order: 0, ref: { entity: scope, locLabelId: id, managed: false } }) as Slot;
    const store = new Store();
    store.add([lab('account', 'x.Run', 'Run'), lab('account', 'x.Tip', 'Run it'), lab('account', 'y.Go', 'Go'), lab('_app', 'z.Export', 'Export')]);
    const app = { store, ctx: { base: EN, user: EN, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] }, prefs: { target: FR, shown: [], showNames: false, dock: 'right' } } as unknown as AppApi;
    useRibbonControls(
      app,
      new Map([
        [
          'account',
          new Map([
            ['x.Button', { id: 'x.Button', labelText: '$LocLabels:x.Run', toolTipTitle: '$LocLabels:x.Tip' }],
            ['x.Button2', { id: 'x.Button2', labelText: '$LocLabels:x.Run', toolTipTitle: '$LocLabels:x.Tip' }],
            ['x.Button3', { id: 'x.Button3', labelText: '$LocLabels:y.Go', alt: '$LocLabels:x.Run' }],
            ['y.Button', { id: 'y.Button', labelText: '$LocLabels:y.Go' }],
          ]),
        ],
      ]),
    );
    const on = (control: string, comp: string): Anchor => ({ el: { closest: () => ({ getAttribute: () => `account|NoRelationship|Form|${control}-Large` }) } as unknown as Element, comp, kind: 'ribbon', key: `${comp}|Label`, role: 'command' });
    const notes = (comp: string, a?: Anchor) => describe(app, comp, a).blocks.map((b) => [b.heading, b.note ?? '']);
    // Clicked on one of the buttons: the others that show it (its label on one, its accessibility text on another).
    t.eq(notes('ribbon|account|x.Run', on('x.Button', 'ribbon|account|x.Run')), [['Label', 'also on 2 other buttons'], ['Tooltip title', 'also on 1 other button']]);
    // From the list (no button): how many show it.
    t.eq(notes('ribbon|account|x.Run'), [['Label', 'on 3 buttons'], ['Tooltip title', 'on 2 buttons']]);
    t.eq(notes('ribbon|account|y.Go', on('y.Button', 'ribbon|account|y.Go')), [['Label', 'also on 1 other button']]);
    // A label one button alone shows has no note.
    useRibbonControls(app, new Map([['account', new Map([['y.Button', { id: 'y.Button', labelText: '$LocLabels:y.Go' }]])]]));
    t.eq(notes('ribbon|account|y.Go', on('y.Button', 'ribbon|account|y.Go')), [['Label', '']]);
    t.eq(notes('ribbon|account|y.Go'), [['Label', '']]);
    t.eq(notes('ribbon|_app|z.Export'), [['Label', "every table's command bar"]]);
  });
}
