// Classic ribbon command labels (kind 'ribbon', prop Label).
//
// Read: `ribbondiffs` rows of type LocalizedLabel hold every <LocLabel> of every solution layer with all
// languages (verified live). Write: Dataverse has no API for RibbonDiffXml, but a translation import
// (`ImportTranslation`) writes LocLabel titles: a small CrmTranslations.xml with one row per edited LocLabel,
// naming a temporary solution that holds only the table (or the application ribbon). It changes nothing but
// the titles that differ from the published ones and keeps everything else of the ribbon, pending work
// included (LIVE-FINDINGS 72–77). About 20 s per table, against 1–2 minutes for the solution import used before.
//
// A translation can't be removed (canClear): an import with an empty cell keeps the existing title
// (LIVE-FINDINGS 39, 69), so an emptied translation is refused.
//
// An import takes no If-Match and must carry the base-language text as read (finding 73). The published titles are
// read again right after it, before this save publishes: a cell someone else published since the read the file was
// built from is written back with a second import once this save is published (an import skips a cell equal to the
// published title, finding 74); their text in an edited language makes that change a conflict, never silently replaced.
// That second import is watched the same way, every cell it carries (the base cell too): read right before and right after
// it, so a text published while it runs is put back by the next one (at most three). No read sees the seconds an import
// runs, so a label one of them wrote is never reported plainly saved: the change says to check it, with its texts now.

import type { Ctx } from '../core/context';
import { DvError, abortError, guid, isAbort, pause, q, turnedAway } from '../core/http';
import { pick } from '../core/labels';
import { lcidName } from '../core/lcid';
import { CANT_CLEAR_TEXT, MANAGED, PublishSet, canClear, isManaged, slotKey, type Change, type ChangeResult, type Labels, type Lcid, type Slot } from '../core/model';
import { isLockError, publishXml } from '../core/publish';
import { blank, parseXml, presentLabels, readLabels, xmlAttr } from '../core/xml';
import { bytesToB64, utf8, zip } from '../core/zip';
import { changeId, check, type Loader, type LoadOptions, type RibbonControl, type Writer } from './types';

/** `on`: run the write pipeline up to, not including, the import. `last` then holds the translation file it would have imported. */
export const RIBBON_DRY_RUN: { on: boolean; last?: { entity: string; xml: string; file: string } } = { on: false };

const APP = '_app';

interface Diff {
  /** Every Title as stored, '' included; slots get presentLabels() of it. */
  labels: Labels;
  /**
   * A managed solution defines this label (a managed row has its Id), also where an unmanaged row of it wins for the
   * texts: the label comes from that solution, so it is never written here (more unmanaged layer on top of it).
   */
  managed: boolean;
  rank: number;
  order: number;
}
type Diffs = Map<string, Diff>;
interface Sol {
  id: string;
  name: string;
}

const where = (e: string) => (e === APP ? 'entity eq null' : `entity eq '${q(e)}'`);
const soft = (x: unknown) => {
  if (isAbort(x)) throw x;
  return null;
};
const fail = (change: Change, message: string): ChangeResult => ({ change, outcome: 'error', message });
const unexpected = () => new Error('The command bar has an unexpected format, so nothing was saved.');

// ---- Reading ----

// RetrieveUnpublishedMultiple also returns diffs an import has staged but not published yet.
let noUnpublished = false;
async function diffRows(ctx: Ctx, qs: string, signal: AbortSignal | undefined, latest: boolean): Promise<any[]> {
  if (latest && !noUnpublished) {
    try {
      return await ctx.http.all(`ribbondiffs/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()${qs}`, { signal });
    } catch (x) {
      // Only a definite "not supported" answer falls back: a throttled, expired or failed call must not
      // silently turn the unpublished-work guard into a published-only query.
      if (!(x instanceof DvError) || ![400, 404, 405, 501].includes(x.status)) throw x;
      noUnpublished = true;
    }
  }
  return ctx.http.all(`ribbondiffs${qs}`, { signal });
}

/**
 * LocLabels per scope ('_app' = application ribbon), one per Id; an unmanaged row wins over managed ones for the texts,
 * and any managed row of the Id makes it managed.
 */
async function readDiffs(ctx: Ctx, entities: string[], signal?: AbortSignal, latest = false): Promise<Map<string, Diffs>> {
  const out = new Map<string, Diffs>(entities.map((e) => [e, new Map()]));
  const chunks: string[][] = [];
  for (let i = 0; i < entities.length; i += 25) chunks.push(entities.slice(i, i + 25));
  const sel = `?$select=diffid,entity,rdx,ismanaged,difftype${latest ? ',componentstate' : ''}&$filter=difftype eq 3 and `;
  let order = 0;
  for (const rows of await Promise.all(chunks.map((c) => diffRows(ctx, `${sel}(${c.map(where).join(' or ')})`, signal, latest)))) {
    for (const r of rows) {
      const m = out.get(r.entity ? String(r.entity).toLowerCase() : APP);
      if (!m || r.componentstate >= 2) continue; // 2/3 = deleted
      let el: Element | undefined;
      try {
        const d = parseXml(r.rdx || '', 'ribbon label');
        el = d.documentElement.tagName === 'LocLabel' ? d.documentElement : d.getElementsByTagName('LocLabel')[0];
      } catch {
        continue;
      }
      const id = el?.getAttribute('Id') || r.diffid;
      if (!el || !id) continue;
      const managed = !!r.ismanaged;
      const rank = (managed ? 0 : 2) + (r.componentstate === 1 ? 1 : 0);
      const prev = m.get(id);
      // The unmanaged layer of a managed solution's label (someone customized it) still has that solution under it.
      if (!prev || rank > prev.rank) m.set(id, { labels: readLabels(el, 'Titles', 'Title', 'languagecode', 'description'), managed: managed || !!prev?.managed, rank, order: prev?.order ?? order++ });
      else if (managed) prev.managed = true;
    }
  }
  return out;
}

const latestDiffs = async (ctx: Ctx, e: string, signal?: AbortSignal): Promise<Diffs> => (await readDiffs(ctx, [e], signal, true)).get(e) ?? new Map();

async function tableNames(ctx: Ctx, list: string[], signal: AbortSignal): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const chunks: string[][] = [];
  for (let i = 0; i < list.length; i += 25) chunks.push(list.slice(i, i + 25));
  const pages = await Promise.all(
    chunks.map((c) => ctx.http.all(`EntityDefinitions?$select=LogicalName,DisplayName&$filter=${c.map((e) => `LogicalName eq '${q(e)}'`).join(' or ')}`, { signal }).catch(soft)),
  );
  for (const r of pages.flatMap((p) => p || [])) m.set(r.LogicalName, r.DisplayName?.UserLocalizedLabel?.Label || r.LogicalName);
  return m;
}

export async function loadRibbonLabels(ctx: Ctx, entities: string[], o: LoadOptions): Promise<Slot[]> {
  const list = [...new Set(entities.map((e) => e.toLowerCase()))];
  if (!list.length) return [];
  o.progress('Loading classic command bar labels…');
  const [diffs, names] = await Promise.all([readDiffs(ctx, list, o.signal), tableNames(ctx, list.filter((e) => e !== APP), o.signal)]);
  const slots: Slot[] = [];
  for (const [e, m] of diffs)
    for (const [id, d] of m)
      slots.push({
        key: slotKey('ribbon', `${e}|${id}`, 'Label'),
        kind: 'ribbon',
        prop: 'Label',
        entity: e === APP ? '' : e,
        comp: `ribbon|${e}|${id}`,
        group: `ribbon|${e}`,
        title: pick(d.labels, ctx.user, ctx.base) || id,
        path: [e === APP ? 'All tables' : names.get(e) || e, 'Command bar (classic)'],
        sub: id,
        labels: presentLabels(d.labels), // a Title stored as '' counts as missing
        readOnly: d.managed ? MANAGED : '',
        baseRequired: true,
        max: 0,
        order: d.order,
        ref: { entity: e, locLabelId: id, managed: d.managed },
      });
  return slots;
}

export const loadRibbonScope: Loader = async (ctx, scope, o) =>
  scope.kinds.has('ribbon') ? (await loadRibbonLabels(ctx, [...scope.entities, APP], o)).filter((s) => !s.readOnly || scope.includeReadOnly) : [];

const controls = new Map<string, Promise<Map<string, RibbonControl>>>();

/**
 * Customizable command bar controls of a table (and of the application ribbon) by Id; label attributes hold
 * tokens such as `$LocLabels:Id`. Cached per table.
 *
 * Read from the CustomAction rows of ribbondiffs (difftype 0), which hold every custom or overridden button
 * of every layer and load in milliseconds. The composed ribbon (RetrieveEntityRibbon) took ~32 s live and
 * only adds Microsoft's own buttons, whose `$Resources:` labels come from language packs and cannot be
 * translated anyway.
 */
export function ribbonControls(ctx: Ctx, entity: string, signal?: AbortSignal): Promise<Map<string, RibbonControl>> {
  let p = controls.get(entity);
  if (!p) {
    controls.set(entity, (p = fetchControls(ctx, entity, signal)));
    p.catch(() => controls.delete(entity));
  }
  return p;
}

async function fetchControls(ctx: Ctx, entity: string, signal?: AbortSignal): Promise<Map<string, RibbonControl>> {
  const scope = entity === APP ? 'entity eq null' : `(entity eq '${q(entity)}' or entity eq null)`;
  const rows = await ctx.http.all(`ribbondiffs?$select=rdx,entity&$filter=difftype eq 0 and ${scope}`, { signal });
  const map = new Map<string, RibbonControl>();
  for (const r of rows) {
    let doc: Document;
    try {
      doc = parseXml(String(r.rdx || ''), 'command bar');
    } catch {
      continue; // one unreadable diff must not hide the others
    }
    for (const el of Array.from(doc.querySelectorAll('[Id]'))) {
      // Application ribbon buttons use {!EntityLogicalName} in their ids; the page shows the real table.
      const id = el.getAttribute('Id')!.replace(/\{!EntityLogicalName\}/g, entity);
      const a = (n: string) => el.getAttribute(n)?.replace(/\{!EntityLogicalName\}/g, entity) ?? undefined;
      if (!['LabelText', 'Alt', 'ToolTipTitle', 'ToolTipDescription'].some((n) => el.hasAttribute(n))) continue;
      // The table's own definition wins over an application-wide one with the same id.
      if (map.has(id) && r.entity == null) continue;
      map.set(id, { id, command: a('Command'), labelText: a('LabelText'), toolTipTitle: a('ToolTipTitle'), toolTipDescription: a('ToolTipDescription'), alt: a('Alt') });
    }
  }
  return map;
}


// ---- Writing: translation import ----

/** A non-base translation saved empty (or as only spaces): a removal, which no import can do. */
const clears = (base: number, c: Change): boolean => c.lcid !== base && !c.after.trim();

/**
 * check() with blank values treated alike, so a Title stored as '' or as spaces is no conflict for a user who
 * saw no text (the store keeps '' for a blank label). `labels` are the Titles as stored.
 */
function compare(c: Change, labels: Labels, force: Set<string>): ChangeResult | null {
  const stored: string | undefined = labels[c.lcid];
  const r = check({ ...c, before: blank(c.before) }, blank(stored), force);
  return r && { ...r, change: c, ...(r.outcome === 'conflict' ? { server: stored ?? '' } : {}) };
}

function classify(ctx: Ctx, cs: Change[], server: Diffs, force: Set<string>, out: ChangeResult[]): Change[] {
  return cs.filter((c) => {
    const d = server.get(c.slot.ref.locLabelId);
    let r: ChangeResult | null;
    if (!d) r = fail(c, 'This label no longer exists on the server. Reload and try again.');
    // A translation file names a label by the ribboncustomization row of its layer; only the unmanaged one is written, and
    // never for a label a managed solution defines (as read now, or as loaded), even one with an unmanaged row already:
    // that would be an unmanaged layer on it.
    else if (d.managed || isManaged(c.slot)) r = fail(c, MANAGED);
    else if (c.lcid === ctx.base && !c.after.trim()) r = fail(c, `The ${lcidName(ctx.base)} label can't be blank: it is the base language.`);
    else if (/[\0-\x08\x0b\x0c\x0e-\x1f]/.test(c.after)) r = fail(c, 'The text contains control characters that a command label cannot store. Remove them and save again.');
    // Refused before any import; the saver already blocks it, this is the writer's own guard.
    else if (!canClear(c.slot) && clears(ctx.base, c)) r = fail(c, CANT_CLEAR_TEXT);
    else r = compare(c, d.labels, force);
    if (r) out.push(r);
    return !r;
  });
}

/**
 * Refuses the changes of a label that would have no base-language text: its row would carry an empty base cell,
 * and the import skips such a row whole without saying so (LIVE-FINDINGS 73).
 */
function needBase(ctx: Ctx, cs: Change[], server: Diffs, out: ChangeResult[]): Change[] {
  const has = (id: string) => !!blank(cs.find((c) => c.slot.ref.locLabelId === id && c.lcid === ctx.base)?.after ?? server.get(id)?.labels[ctx.base]);
  return cs.filter((c) => {
    if (has(c.slot.ref.locLabelId)) return true;
    out.push(fail(c, `This label has no ${lcidName(ctx.base)} text, which Dataverse needs to save a translation of it. Add the ${lcidName(ctx.base)} text too.`));
    return false;
  });
}

/** Publishes the table's ribbon (or the application ribbon), retrying while another customization runs. */
function publishScope(ctx: Ctx, e: string, signal?: AbortSignal): Promise<void> {
  const p = new PublishSet();
  if (e === APP) p.ribbons = true;
  else p.entities.add(e);
  return publishXml(ctx, p, signal);
}

/**
 * The scope's unmanaged ribboncustomization row. A translation file names a label by the row of its layer
 * (LIVE-FINDINGS 76), and only the unmanaged layer can be written.
 */
async function layerId(ctx: Ctx, e: string, signal: AbortSignal): Promise<string> {
  const rows = await ctx.http.all(`ribboncustomizations?$select=ribboncustomizationid&$filter=${where(e)} and ismanaged eq false`, { signal });
  if (rows.length !== 1 || !rows[0].ribboncustomizationid) throw unexpected();
  return guid(rows[0].ribboncustomizationid);
}

async function createSolution(ctx: Ctx, e: string, cs: Change[], signal: AbortSignal): Promise<Sol> {
  const pubs = (await ctx.http.all('publishers?$select=publisherid,uniquename,customizationprefix&$filter=isreadonly eq false', { signal })).filter((p) => !/microsoft/i.test(p.uniquename));
  const ids = cs.map((c) => String(c.slot.ref.locLabelId).toLowerCase());
  const pub =
    pubs.find((p) => p.customizationprefix && ids.some((id) => id.startsWith(`${p.customizationprefix.toLowerCase()}.`) || id.startsWith(`${p.customizationprefix.toLowerCase()}_`))) ||
    pubs.find((p) => /^defaultpublisher/i.test(p.uniquename)) ||
    pubs[0];
  if (!pub) throw new Error('No solution publisher is available for the temporary solution.');
  const name = `dxt_ribbon_${(e === APP ? 'app' : e).slice(0, 40)}_${Date.now().toString(36)}`;
  const r = await ctx.http.post(
    'solutions?$select=solutionid',
    { uniquename: name, friendlyname: 'Translator temporary ribbon translation (safe to delete)', version: '1.0.0.0', 'publisherid@odata.bind': `/publishers(${guid(pub.publisherid)})` },
    { signal, headers: { Prefer: 'return=representation' } },
  );
  return { id: guid(r.solutionid), name };
}

/**
 * Adds the table as a shell (no columns, forms or views), or the application ribbon. Rows of a translation
 * file apply only to components of the solution it names (LIVE-FINDINGS 27, 69); the application ribbon
 * refuses DoNotIncludeSubcomponents (finding 75).
 */
async function addRoot(ctx: Ctx, e: string, layer: string, sol: Sol, signal: AbortSignal): Promise<void> {
  const app = e === APP;
  const id = app ? layer : guid((await ctx.http.get(`EntityDefinitions(LogicalName='${q(e)}')?$select=MetadataId`, { signal })).MetadataId);
  if (!id) throw new Error('The command bar definition could not be found.');
  await ctx.http.post('AddSolutionComponent', { ComponentId: id, ComponentType: app ? 50 : 1, SolutionUniqueName: sol.name, AddRequiredComponents: false, DoNotIncludeSubcomponents: !app }, { signal });
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/octet-stream" /></Types>';

/**
 * CrmTranslations.xml for ImportTranslation (LIVE-FINDINGS 15, 72): the Information sheet the import
 * validates (organization id, export time, base language, solution), an empty Display Strings sheet, and one
 * Localized Labels row per LocLabel. Columns: the base language, then every other language of the rows.
 * A row whose base cell is empty is skipped whole (finding 73), so every row must carry its base text; a
 * text equal to the published title changes nothing, and an empty cell keeps the title.
 */
export function translationXml(o: { orgId: string; base: Lcid; solution: string; layer: string; rows: Array<[string, Labels]>; when: Date }): string {
  const langs = [o.base, ...[...new Set(o.rows.flatMap(([, l]) => Object.keys(l).map(Number)))].filter((l) => l !== o.base).sort((a, b) => a - b)];
  const cell = (v: string, type = 'String') => `<Cell><Data ss:Type="${type}">${xmlAttr(v)}</Data></Cell>`;
  const row = (cells: string[]) => `<Row>${cells.join('')}</Row>`;
  const heads = (...names: string[]) => row([...names.map((n) => cell(n)), ...langs.map((l) => cell(String(l), 'Number'))]);
  const info = [
    ['Organization ID:', o.orgId],
    ['Exported on:', o.when.toISOString().slice(0, 19), 'DateTime'],
    ['Base language name:', lcidName(o.base)],
    ['Base language ID:', String(o.base), 'Number'],
    ['Solution Name:', o.solution],
  ].map(([k, v, t]) => row([cell(k), cell(v, t)]));
  const body = o.rows.map(([id, l]) => {
    if (!l[o.base]?.trim()) throw new Error(`The label "${id}" has no ${lcidName(o.base)} text, which Dataverse requires. Nothing was saved.`);
    return row([cell('RibbonCustomization'), cell(o.layer), cell(id), ...langs.map((x) => cell(l[x] ?? ''))]);
  });
  const sheet = (name: string, rows: string[]) => `<Worksheet ss:Name="${name}" ss:Id="${name}"><Table>${rows.join('')}</Table></Worksheet>`;
  return (
    '<?xml version="1.0" encoding="utf-8"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    sheet('Information', info) +
    sheet('Display Strings', [heads('Entity name', 'Display String Key')]) +
    sheet('Localized Labels', [heads('Entity name', 'Object ID', 'Object Column Name'), ...body]) +
    '</Workbook>'
  );
}

/**
 * The translation file for the changes, and the titles each edited LocLabel should have afterwards. Each row
 * holds the edited languages and the base text (the edit, else the base title just read; equal to the published
 * one, it changes nothing). Languages a row doesn't edit stay empty, which keeps them.
 */
async function buildFile(ctx: Ctx, sol: Sol, layer: string, todo: Change[], server: Diffs, e: string): Promise<{ file: string; want: Map<string, Labels>; sent: Map<string, Labels> }> {
  const edits = new Map<string, Labels>();
  for (const c of todo) {
    const id: string = c.slot.ref.locLabelId;
    edits.set(id, { ...edits.get(id), [c.lcid]: c.after });
  }
  const want = new Map<string, Labels>();
  const rows: Array<[string, Labels]> = [];
  for (const [id, t] of edits) {
    const stored = server.get(id)?.labels ?? {};
    want.set(id, { ...stored, ...t });
    rows.push([id, { [ctx.base]: stored[ctx.base] ?? '', ...t }]);
  }
  return { file: await pack(ctx, sol, layer, rows, e), want, sent: new Map(rows) };
}

/** The zipped translation file of `rows` (LocLabel Id → the cells it writes, the base one included). */
async function pack(ctx: Ctx, sol: Sol, layer: string, rows: Array<[string, Labels]>, e: string): Promise<string> {
  const xml = translationXml({ orgId: ctx.orgId, base: ctx.base, solution: sol.name, layer, rows, when: new Date() });
  const file = bytesToB64(await zip([{ name: 'CrmTranslations.xml', data: utf8(xml) }, { name: '[Content_Types].xml', data: utf8(CONTENT_TYPES) }]));
  if (RIBBON_DRY_RUN.on) {
    RIBBON_DRY_RUN.last = { entity: e, xml, file };
    if (__DEV__) console.info('[translator] ribbon dry run', RIBBON_DRY_RUN.last);
  }
  return file;
}

/**
 * A cell of an imported file whose published title moved between the read the file was built from and the read right
 * after the import: someone else published `theirs` meanwhile. Before the import ran, the import wrote this save's cell
 * (`sent`, the old base text when the base was not edited) over it in the unpublished ribbon; after it, theirs is what
 * the publish shows. `lcid`'s change of this save, if any, is `c`.
 */
interface Moved {
  id: string;
  lcid: Lcid;
  sent: string;
  theirs: string;
  c?: Change;
}

/** The cells of `sent` (LocLabel Id → cells) whose published title reads otherwise in `after` than in `server`. */
function movedCells(todo: Change[], sent: Map<string, Labels>, server: Diffs, after: Diffs): Moved[] {
  const out: Moved[] = [];
  for (const [id, cells] of sent) {
    const now = after.get(id)?.labels;
    if (!now) continue; // gone from the command bar: the check after publishing says so
    for (const [l, v] of Object.entries(cells)) {
      const lcid = Number(l);
      const was = blank(server.get(id)?.labels[lcid]);
      if (blank(now[lcid]) !== was) out.push({ id, lcid, sent: v, theirs: blank(now[lcid]), c: todo.find((c) => c.slot.ref.locLabelId === id && c.lcid === lcid) });
    }
  }
  return out;
}

/** The import job's outcome as Dataverse logged it ('' when there is no readable job). */
async function jobStatus(ctx: Ctx, job: string): Promise<{ status: string; code: string }> {
  try {
    const { data } = await ctx.http.get(`importjobs(${job})?$select=data`);
    const tag = (n: string) => new RegExp(`<${n}>([^<]*)</${n}>`).exec(String(data || ''))?.[1]?.trim() || '';
    return { status: tag('status'), code: tag('errorcode') };
  } catch {
    return { status: '', code: '' };
  }
}

/**
 * How an import ended. 'ran': it ran (its rows are checked after publishing). 'no': it did not run and changed
 * nothing; `again` when Dataverse was only busy (another import holds the table: a deadlock, finding 77, or a
 * customization lock), so it may be tried again from a fresh read. 'maybe': its answer was lost, it may have run.
 */
type Ended = { ran: 'ran' } | { ran: 'no'; error: unknown; again: boolean } | { ran: 'maybe'; why: string };

const busyError = (x: unknown) => isLockError(x) || (x instanceof DvError && (x.status === 503 || /deadlock|Sql Number: 1205\b/i.test(x.message)));

/**
 * Imports the file (synchronously, ~8 s). `st.busy` stays true while it, or an earlier import of this save, may still be
 * running on the server. Sent `once`: the file carries the base-language text as just read, so one Dataverse turned away
 * (throttled) is never resent by Http seconds later; it ends 'no' with `again`, and the writer builds the next one from
 * a new read.
 */
async function runImport(ctx: Ctx, file: string, st: { busy: boolean }): Promise<Ended> {
  const job = crypto.randomUUID();
  // One whose answer was lost says nothing of when it ends; a later one that answers doesn't either.
  const was = st.busy;
  st.busy = true;
  try {
    await ctx.http.post('ImportTranslation', { TranslationFile: file, ImportJobId: job }, { once: true });
  } catch (x) {
    const s = await jobStatus(ctx, job);
    // After a gateway or network error the import may still be running on the server.
    st.busy = was || (!(turnedAway(x) || (x instanceof DvError && x.status > 0 && x.status < 502)) && s.status !== 'Failed' && s.status !== 'Succeeded');
    if (s.status === 'Succeeded') return { ran: 'ran' }; // only the answer was lost
    // A refused file (a 4xx answer), one turned away unrun (throttled) or a failed job applied nothing (LIVE-FINDINGS 72, 77).
    if (s.status === 'Failed' || turnedAway(x) || (x instanceof DvError && x.status > 0 && x.status < 500)) return { ran: 'no', error: x, again: busyError(x) || turnedAway(x) };
    return { ran: 'maybe', why: (x as Error)?.message || String(x) };
  }
  const s = await jobStatus(ctx, job);
  st.busy = was;
  if (s.status === 'Failed') return { ran: 'no', error: new Error(`Dataverse reported the translation import as failed${s.code ? ` (${s.code})` : ''}. Nothing was changed.`), again: false };
  return { ran: 'ran' };
}

/**
 * Deletes the temporary solution (only the container; its components stay). Right after an import or
 * publish the customization lock can still be held, and DELETE then fails with 429 / "Cannot start
 * another" (verified live, LIVE-FINDINGS 20), so busy answers are retried after 2, 4, 8 and 16 s.
 * Returns false when the solution is still there.
 */
async function deleteSolution(ctx: Ctx, sol: Sol, say: (m: string) => void): Promise<boolean> {
  for (const wait of [2, 4, 8, 16, 0]) {
    try {
      await ctx.http.del(`solutions(${sol.id})`);
      return true;
    } catch (x) {
      if (x instanceof DvError && x.status === 404) return true; // already gone
      if (!wait || !isLockError(x)) return false;
      say(`cleaning up (Dataverse is busy, trying again in ${wait} s)`);
      await pause(wait * 1000);
    }
  }
  return false;
}

/**
 * Removes temporary solutions this user's interrupted runs left behind (only the containers; components stay): created
 * by this user more than an hour ago. Never another maker's, whose import may still be running.
 */
async function dropStale(ctx: Ctx): Promise<void> {
  const me = guid(ctx.userId);
  if (!/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(me)) return;
  const old = new Date(Date.now() - 3_600_000).toISOString();
  // ismanaged eq false is essential: deleting a managed solution would uninstall its components.
  const rows = await ctx.http.all(
    `solutions?$select=solutionid,uniquename,ismanaged,createdon,_createdby_value&$filter=startswith(uniquename,'dxt_ribbon_') and ismanaged eq false and _createdby_value eq ${me} and createdon lt ${old}`,
  );
  // Checked again on each row: a filter answered loosely must never delete anyone else's solution.
  for (const s of rows)
    if (guid(s._createdby_value) === me && s.ismanaged === false && String(s.uniquename || '').startsWith('dxt_ribbon_') && Date.parse(s.createdon) < Date.parse(old))
      await ctx.http.del(`solutions(${guid(s.solutionid)})`).catch(() => {});
}

const friendly = (x: unknown) => {
  const m = (x as Error)?.message || String(x);
  return busyError(x) || /Cannot start|0x80071151|another \[/i.test(m)
    ? 'Dataverse is busy with another customization. Nothing was changed and your edits are still pending — try Save again in a minute.'
    : x instanceof DvError && x.status === 403
      ? `${m} Saving classic command labels needs permission to create solutions and import translations (System Customizer role).`
      : m;
};

/** Why something failed, in a few words for a sentence that goes on. */
const short = (x: unknown): string => ((x as Error)?.message || String(x)).trim().replace(/[.!?]+$/, '');

/** Waits before the 2nd and 3rd try of an import Dataverse was too busy to run. */
const RETRY_WAITS = [5, 10];

/**
 * What became of a cell someone else published meanwhile (see Moved): theirs shows (`wrote`: written back by an import, not
 * confirmed by a read yet), a third text does, or it was not put back.
 */
type Fate = { is: 'theirs'; text: string; wrote?: boolean } | { is: 'third'; text: string } | { is: 'failed'; why: string; never?: boolean };
/** Not put back, and never owed (OWED): no later save may write it either. */
const never = (f: Fate | undefined): boolean => f?.is === 'failed' && !!f.never;
const cellKey = (id: string, l: Lcid): string => `${id}#${l}`;
/** `cells` with one entry per cell, the last one (the newest text someone else published there). */
const latest = (cells: Moved[]): Moved[] => [...new Map(cells.map((m) => [cellKey(m.id, m.lcid), m])).values()];

/**
 * Cells of a scope still to put back after an import whose publish failed (see Moved): the import wrote this save's text
 * over theirs in the unpublished command bar, and only a publish lets an import write theirs again. The next save of that
 * scope (Try again) puts them back right after its first publish.
 */
const OWED = new Map<string, Moved[]>();
/** OWED, for tests. */
export const RIBBON_OWED: Map<string, unknown[]> = OWED;

/** Put-back imports of one putBack, at most: someone else may publish again during each. */
const PUT_BACKS = 3;

/** What the put-back imports of one putBack did. */
interface Back {
  /** Each cell's end, by cellKey: the cells asked for, and those someone else published while a put-back ran. */
  fate: Map<string, Fate>;
  /** Cells someone else published while a put-back import ran (the read right after it shows otherwise than the one before). */
  raced: Moved[];
  /** Labels a put-back import wrote (or may have), with the languages of someone else's text it dealt with there. */
  wrote: Map<string, Set<Lcid>>;
  /** Labels whose read right after a put-back import failed: a change published at that moment can't be ruled out. */
  unseen: Set<string>;
  /** Labels of a put-back import whose answer was lost: it may still be running. */
  lost: Set<string>;
  /** The command bar as last read, after the last put-back's publish (null when that read failed). */
  now: Diffs | null;
}

/**
 * Puts back what someone else published meanwhile (`cells`), now that this save's titles are published: an import skips
 * a cell equal to the published title (LIVE-FINDINGS 74), so theirs can be written over this save's text only once that is
 * the published one. Read right before the import, like every write: a cell that already shows theirs needs nothing, one
 * that shows a third text is left as it is, and one of a label a managed solution defines is never written (nor owed).
 * Then read right after it, and published. Like the first import, it carries the base text as read and takes no If-Match:
 * a cell of it that the read after it shows otherwise was published by someone else while it ran, perhaps before it wrote
 * over it, so it is put back the same way by the next put-back (whose read also checks this one's), PUT_BACKS in all.
 * Never cancellable: their text is never left replaced.
 */
async function putBack(ctx: Ctx, e: string, sol: Sol, layer: string, cells: Moved[], st: { busy: boolean }, say: (m: string) => void): Promise<Back> {
  const back: Back = { fate: new Map(), raced: [], wrote: new Map(), unseen: new Set(), lost: new Set(), now: null };
  const set = (m: Moved, f: Fate) => back.fate.set(cellKey(m.id, m.lcid), f);
  const failAll = (ms: Moved[], why: string) => {
    for (const m of ms) set(m, { is: 'failed', why });
  };
  let todo = cells;
  /** The cells the last put-back wrote, which the next read checks, and whether its answer was lost. */
  let wrote: Moved[] = [];
  let lost = false;
  for (let round = 0, attempt = 0; ; ) {
    let pre: Diffs;
    try {
      pre = back.now = await latestDiffs(ctx, e);
    } catch (x) {
      // What the last one wrote is checked by the save's own read; the rest is owed.
      back.now = null;
      failAll(todo, `the command bar could not be read (${short(x)})`);
      return back;
    }
    const shows = (m: Moved) => blank(pre.get(m.id)?.labels[m.lcid]);
    for (const m of wrote) {
      if (todo.some((x) => x.id === m.id && x.lcid === m.lcid)) continue; // published over again meanwhile: below
      const now = shows(m);
      set(m, now === m.theirs ? { is: 'theirs', text: now } : now !== blank(m.sent) ? { is: 'third', text: now } : { is: 'failed', why: lost ? 'the import did not answer, and Dataverse does not show it' : 'Dataverse does not show it' });
    }
    const rows = new Map<string, Labels>();
    const writing: Moved[] = [];
    for (const m of todo) {
      const now = shows(m);
      if (now === m.theirs) set(m, { is: 'theirs', text: now });
      else if (now !== blank(m.sent)) set(m, { is: 'third', text: now });
      else if (!m.theirs) set(m, { is: 'failed', why: "an import can't remove a command label text" });
      // A managed solution defines it as read right before this import: writing theirs back would add to the unmanaged
      // layer on top of that solution's label, which nothing here does.
      else if (pre.get(m.id)?.managed) set(m, { is: 'failed', why: 'it now comes from a managed solution, and a write would add an unmanaged layer on top of it', never: true });
      else {
        rows.set(m.id, { ...rows.get(m.id), [m.lcid]: m.theirs });
        writing.push(m);
      }
    }
    // Every row carries its base text, or the import skips it whole (LIVE-FINDINGS 73).
    for (const [id, cells] of rows) {
      const b = cells[ctx.base] || blank(pre.get(id)?.labels[ctx.base]);
      if (b) rows.set(id, { ...cells, [ctx.base]: b });
      else {
        rows.delete(id);
        failAll(writing.filter((m) => m.id === id), `the label has no ${lcidName(ctx.base)} text`);
      }
    }
    const sending = writing.filter((m) => rows.has(m.id));
    if (!sending.length) return back;
    if (round >= PUT_BACKS) {
      failAll(sending, 'someone else kept changing it at the same time');
      return back;
    }
    say('putting back a change someone else published meanwhile');
    const r = await runImport(ctx, await pack(ctx, sol, layer, [...rows], e), st);
    if (r.ran === 'no') {
      const wait = RETRY_WAITS[attempt++];
      if (r.again && wait !== undefined) {
        await pause(wait * 1000);
        continue; // from a new read
      }
      failAll(sending, short(friendly(r.error)));
      return back;
    }
    round++;
    attempt = 0;
    lost = r.ran === 'maybe';
    for (const id of rows.keys()) {
      back.wrote.set(id, new Set([...(back.wrote.get(id) ?? []), ...sending.filter((m) => m.id === id).map((m) => m.lcid)]));
      if (lost) back.lost.add(id);
    }
    // Right after it, before publishing (ribbondiffs show only published titles), as after the first import.
    say('checking for changes published meanwhile');
    const post = await latestDiffs(ctx, e)
      .catch(() => pause(1000).then(() => latestDiffs(ctx, e)))
      .catch(() => null);
    const raced: Moved[] = [];
    for (const [id, row] of rows) {
      if (!post) back.unseen.add(id);
      const now = post?.get(id)?.labels;
      if (!now) continue; // gone from the command bar: the check after publishing says so
      for (const [l, v] of Object.entries(row)) {
        const lcid = Number(l);
        const is = blank(now[lcid]);
        // Showing what it sent: someone else's publish published this import, nothing of theirs moved.
        if (is !== blank(pre.get(id)?.labels[lcid]) && is !== blank(v)) raced.push({ id, lcid, sent: v, theirs: is });
      }
    }
    for (const m of raced) back.wrote.get(m.id)!.add(m.lcid);
    back.raced.push(...raced);
    say('publishing');
    try {
      await publishScope(ctx, e);
    } catch (x) {
      // What it wrote over theirs stays unpublished: owed, and put back after the next save's first publish.
      failAll([...sending, ...raced], `it was imported but not published (${short(x)})`);
      return back;
    }
    for (const m of sending) set(m, { is: 'theirs', text: m.theirs, wrote: true });
    wrote = sending;
    todo = raced;
  }
}

/** Why someone else's text was not put back. */
const whyNot = (f: Fate | undefined): string => (f?.is === 'failed' ? f.why : 'Dataverse does not show it');

/** Someone else's text in a language beside the change's that this save wrote over and could not put back. */
const lostBeside = (m: Moved, f: Fate | undefined): string =>
  `someone else published “${m.theirs}” as the ${lcidName(m.lcid)} text of this label at the same moment, and this save put back “${m.sent}”; putting theirs back failed (${whyNot(f)}). Check this label in every language.`;

/** A cell someone else published meanwhile, as the result of the change it belongs to or the one it sits beside says it. */
function racedResult(c: Change, m: Moved, f: Fate | undefined, got: Labels): ChangeResult {
  if (m.lcid !== c.lcid) return fail(c, `Saved, but ${lostBeside(m, f)}`);
  // Not put back: whatever shows now, this save's text lies over theirs (published, or to be by the next publish).
  if (f?.is !== 'failed') {
    if (got[c.lcid] === m.theirs) return { change: c, outcome: 'conflict', server: m.theirs, message: 'Someone else published this text at the same moment. Theirs was put back: choose which one to keep.' };
    if (f?.is === 'third' || (got[c.lcid] !== c.after && got[c.lcid] !== m.sent)) return { change: c, outcome: 'conflict', server: got[c.lcid] ?? '', message: 'Someone else published this text at the same moment.' };
  }
  return fail(c, `Someone else published “${m.theirs}” here at the same moment, and this save replaced it; putting theirs back failed (${whyNot(f)}). Check this label.`);
}

/** “Run” (its Id), or the Id alone for a label without text of its own. */
const named = (c: Change): string => {
  const id: string = c.slot.ref.locLabelId;
  return c.slot.title && c.slot.title !== id ? `“${c.slot.title}” (${id})` : id;
};

/** A label's texts in `d`, in the environment's language order, for a message. */
function reads(ctx: Ctx, id: string, d: Diffs | null): string {
  const l = d?.get(id)?.labels;
  const t = ctx.langs.filter((x) => blank(l?.[x.lcid])).map((x) => `${x.name} “${l![x.lcid]}”`);
  return t.length ? `It now reads ${t.join(', ')}.` : 'Reload to see what it reads now.';
}

/** The languages, for a message: "English", "English and French". */
const langList = (ls: Iterable<Lcid>): string => [...ls].map(lcidName).join(' and ');

export const ribbonWriter: Writer = {
  kinds: ['ribbon'],
  lane: 'ribbon',
  async read(ctx, changes, o) {
    const server = await latestDiffs(ctx, changes[0].slot.ref.entity, o.signal);
    return new Map(
      changes.map((c): [string, string | Error] => {
        const d = server.get(c.slot.ref.locLabelId);
        return [changeId(c), d ? (d.labels[c.lcid] ?? '') : new Error('This label no longer exists on the server.')];
      }),
    );
  },
  async save(ctx, changes, o) {
    if (!changes.length) return [];
    const e: string = changes[0].slot.ref.entity;
    const where = changes[0].slot.path[0] || e;
    const say = (m: string) => o.progress(`Command bar (classic) · ${where}: ${m}`);
    const out: ChangeResult[] = [];
    // busy: an import may still be running on the server; imported: one ran (or may have); sol: the temporary solution.
    const st: { busy: boolean; imported: boolean; sol?: Sol } = { busy: false, imported: false };
    let todo = changes;
    /** The cells of the file someone else published meanwhile (the read right after the import). */
    let moved: Moved[] = [];
    /** Cells an earlier save of this scope still had to put back (OWED) that this one could not put back either (with why). */
    let owing: Array<Moved & { f?: Fate }> = [];
    /** Cells someone else published while that put-back ran, not put back either (each with why). */
    let gone: Array<{ m: Moved; f: Fate | undefined }> = [];
    /** What this save's put-backs did, and the command bar as last read after them. */
    const backs: Back[] = [];
    let last: Diffs | null = null;
    /** The read right after the import failed: a change published meanwhile can't be ruled out. */
    let unchecked = false;

    const work = async (): Promise<ChangeResult[]> => {
      say('checking the current labels');
      todo = classify(ctx, todo, await latestDiffs(ctx, e, o.signal), o.force, out);
      // What an earlier save of this scope owes (OWED) needs a publish and an import, even with nothing else to write.
      if (!todo.length && !(OWED.has(e) && o.allowPublish)) return out;
      // Verified live: ribbondiffs show only the PUBLISHED ribbon, and an import writes over a pending title of
      // the same language (LIVE-FINDINGS 26, 74). So the table's ribbon is published first, and the conflict
      // check below sees what anyone has pending; without permission to publish, nothing is saved.
      if (!o.allowPublish)
        return [...out, ...todo.map((c) => fail(c, 'Classic command labels can only be saved with publishing turned on: Dataverse shows only the published command bar, so saving without publishing could overwrite unpublished command bar changes.'))];
      say('publishing pending command bar changes');
      await publishScope(ctx, e, o.signal);
      say('creating a temporary solution');
      const layer = await layerId(ctx, e, o.signal);
      const sol = (st.sol = await createSolution(ctx, e, todo, o.signal));
      await addRoot(ctx, e, layer, sol, o.signal);
      // What an earlier save of this scope could not put back (its publish failed): now that the publish above has
      // published its import, before anything is read for this one.
      const owed = OWED.get(e);
      if (owed) {
        OWED.delete(e);
        const b = await putBack(ctx, e, sol, layer, owed, st, say);
        backs.push(b);
        last = b.now;
        const done = latest([...owed, ...b.raced]);
        const failed = done.filter((m) => b.fate.get(cellKey(m.id, m.lcid))?.is === 'failed');
        const owe = failed.filter((m) => !never(b.fate.get(cellKey(m.id, m.lcid))));
        if (owe.length) OWED.set(e, owe);
        owing = failed.filter((m) => owed.includes(m)).map((m) => ({ ...m, f: b.fate.get(cellKey(m.id, m.lcid)) }));
        gone = failed.filter((m) => !owed.includes(m)).map((m) => ({ m, f: b.fate.get(cellKey(m.id, m.lcid)) }));
        // A change found already as asked in a cell put back now no longer is: it is checked again from the next read.
        const recheck = out.filter((r) => r.outcome === 'unchanged' && done.some((m) => m.id === r.change.slot.ref.locLabelId && m.lcid === r.change.lcid));
        if (recheck.length) {
          out.splice(0, out.length, ...out.filter((r) => !recheck.includes(r)));
          todo = [...todo, ...recheck.map((r) => r.change)];
        }
      }
      let want = new Map<string, Labels>();
      let sent = new Map<string, Labels>();
      let server: Diffs = new Map();
      let lost = '';
      for (let attempt = 0; ; attempt++) {
        // Read right before every import: a retry is built from a new read, never resent.
        say('checking the current labels');
        server = await latestDiffs(ctx, e, o.signal);
        todo = needBase(ctx, classify(ctx, todo, server, o.force, out), server, out);
        if (!todo.length) return out;
        say('preparing the labels');
        const built = await buildFile(ctx, sol, layer, todo, server, e);
        want = built.want;
        sent = built.sent;
        if (RIBBON_DRY_RUN.on) {
          for (const c of todo) out.push({ change: c, outcome: 'skipped', message: 'Dry run: stopped before the import. Nothing was changed.' });
          return out;
        }
        if (o.signal.aborted) throw abortError();
        say('importing (usually 10–20 s)');
        const r = await runImport(ctx, built.file, st);
        if (r.ran === 'ran') break;
        if (r.ran === 'maybe') {
          lost = r.why;
          break;
        }
        const wait = RETRY_WAITS[attempt];
        if (!r.again || wait === undefined) throw r.error;
        say(`Dataverse is busy with another import, trying again in ${wait} s`);
        await pause(wait * 1000, o.signal);
      }
      st.imported = true;
      // It ran, or may have (its answer lost): a later save finding these labels as asked may be finding it (SaveOptions.ran).
      for (const c of todo) o.ran?.add(changeId(c));
      // Right after the import, before this save's publish: ribbondiffs show only published titles (finding 26), so a
      // cell of the file that reads otherwise than in the read it was built from was published by someone else meanwhile.
      // The import takes no If-Match and carries the base text as read (finding 73): if theirs came before it ran, it
      // wrote this save's cell over theirs, so theirs is put back once this save is published.
      say('checking for changes published meanwhile');
      const after = await latestDiffs(ctx, e)
        .catch(() => pause(1000).then(() => latestDiffs(ctx, e)))
        .catch(() => null);
      if (after) moved = movedCells(todo, sent, server, after);
      unchecked = !after;
      // Imported ribbon labels become visible (to users and to ribbondiffs) only once published.
      say('publishing');
      await publishScope(ctx, e);
      const back = moved.length ? await putBack(ctx, e, sol, layer, moved, st, say) : null;
      if (back) backs.push(back);
      say('verifying');
      const now = await latestDiffs(ctx, e).catch(() => null);
      last = now ?? back?.now ?? last;
      const fate = (m: Moved) => back?.fate.get(cellKey(m.id, m.lcid));
      // Someone else's text in a cell of the import or of a put-back, the newest per cell.
      const cells = latest([...moved, ...(back?.raced ?? [])]);
      // What could not be put back now is tried again by the next save of this scope, right after its first publish: also a
      // cell the read after it still shows with this save's text over theirs (a put-back import whose answer was lost).
      const left = cells.filter((m) => {
        const f = fate(m);
        return (f?.is === 'failed' && !never(f)) || (f?.is === 'theirs' && !!f.wrote && !!now && blank(now.get(m.id)?.labels[m.lcid]) === blank(m.sent));
      });
      if (left.length) OWED.set(e, latest([...(OWED.get(e) ?? []), ...left]));
      for (const c of todo) {
        const id: string = c.slot.ref.locLabelId;
        const got = now?.get(id)?.labels;
        // Each language this save edits is checked on its own change; the others must read as published right after the
        // import (as read before it without that read), with what someone else published meanwhile put back.
        const edited = (l: Lcid) => todo.some((x) => x.slot.ref.locLabelId === id && x.lcid === l);
        const exp: Labels = { ...(after?.get(id)?.labels ?? want.get(id) ?? {}) };
        const mine = cells.find((m) => m.id === id && m.lcid === c.lcid && m.theirs !== c.after);
        const beside = cells.filter((m) => m.id === id && !edited(m.lcid));
        for (const m of beside) {
          const f = fate(m);
          exp[m.lcid] = f && f.is !== 'failed' ? f.text : m.theirs;
        }
        // One not put back lies under this save's text whatever shows now (an unpublished put-back over a newer one too).
        const missed = got && beside.find((m) => fate(m)?.is === 'failed' || (got[m.lcid] ?? '') !== (exp[m.lcid] ?? ''));
        const other = got && ctx.langs.find((l) => !edited(l.lcid) && (got[l.lcid] ?? '') !== (exp[l.lcid] ?? ''));
        const raced = got && mine ? racedResult(c, mine, fate(mine), got) : null;
        out.push(
          !now
            ? fail(c, 'The import finished, but the result could not be checked. Reload to check it.')
            : !got
              ? fail(c, 'The import finished, but this label is no longer on the command bar. Reload to check it.')
              : raced
                ? // Their text here never hides theirs lost beside it.
                  missed
                  ? fail(c, `${raced.message} Also, ${lostBeside(missed, fate(missed))}`)
                  : raced
                : got[c.lcid] !== c.after
                  ? fail(c, lost ? `The import did not answer (${lost}), and Dataverse does not show this text. Reload in a minute to check it.` : 'The import finished, but Dataverse does not show this text yet. Publish, then reload to check it.')
                  : missed
                    ? racedResult(c, missed, fate(missed), got)
                    : other
                      ? fail(c, `The import also changed the ${other.name} text of this label. Check this label in every language.`)
                      : !after
                        ? fail(c, "Saved, but the command bar could not be read right after the import, so a change someone else published at the same moment can't be ruled out. Check this label in every language.")
                        : { change: c, outcome: 'saved' },
        );
      }
      return out;
    };

    let results: ChangeResult[];
    try {
      results = await work();
    } catch (x) {
      // Cancellation is honored only before the import starts (or between tries of one that did not run).
      const stop = isAbort(x);
      // The import's publish failed: what it wrote stays unpublished, and what it wrote over someone else's text is put
      // back by the next save of this scope (OWED).
      const replaced = moved.filter((m) => m.theirs !== blank(m.sent));
      if (st.imported && replaced.length) OWED.set(e, [...(OWED.get(e) ?? []), ...replaced]);
      const why = (c: Change): string => {
        if (!st.imported) return friendly(x);
        const id: string = c.slot.ref.locLabelId;
        const theirs = replaced.filter((m) => m.id === id);
        return (
          `The ${lcidName(c.lcid)} text was imported but not published (${short(x)}): users see the old text until ${where}'s command bar is published. Try again to publish it.` +
          (theirs.length
            ? ` Someone else published ${theirs.map((m) => `“${m.theirs}” as the ${lcidName(m.lcid)} text`).join(' and ')} at the same moment, which this save may have put back: Try again puts theirs back after publishing; publishing ${where} another way would show the old text.`
            : '') +
          (unchecked ? " The command bar could not be read right after the import, so a change someone else published at the same moment can't be ruled out: check this label in every language once it is published." : '')
        );
      };
      // Stopped after a put-back import on its label (the one an earlier save owed): that label did change.
      const cancelled = (c: Change): string =>
        backs.some((b) => b.wrote.has(c.slot.ref.locLabelId)) ? 'Cancelled before the import: this change was not saved.' : 'Cancelled before the import. Nothing was changed.';
      results = [...out, ...todo.map((c): ChangeResult => (stop ? { change: c, outcome: 'skipped', message: cancelled(c) } : fail(c, why(c))))];
    }
    /** A cancelled change keeps its outcome; what a put-back left on its label is said after it. */
    const also = (r: ChangeResult, text: string): ChangeResult => ({ ...r, message: `${r.message} Also, ${text}` });
    // Someone else's text an earlier save of a label put back and this one could not restore either: never plain saved.
    results = results.map((r) => {
      const m = owing.find((x) => x.id === r.change.slot.ref.locLabelId);
      if (!m || r.outcome === 'conflict') return r;
      // One a managed solution now defines is never put back, so no Try again.
      const text = never(m.f)
        ? `Someone else's “${m.theirs}” (the ${lcidName(m.lcid)} text of this label) that an earlier save put back can't be restored here: ${whyNot(m.f)}.`
        : `Someone else's “${m.theirs}” (the ${lcidName(m.lcid)} text of this label) that an earlier save put back is still to be restored: it could not be put back this time either. Try again.`;
      if (r.outcome === 'skipped') return also(r, text.charAt(0).toLowerCase() + text.slice(1));
      return fail(r.change, `${r.outcome === 'error' && r.message ? `${r.message} ` : ''}${text}`);
    });
    // Someone else's text published while that put-back ran and not put back: said on every change of the label.
    results = results.map((r) => {
      const g = gone.find((x) => x.m.id === r.change.slot.ref.locLabelId);
      if (!g) return r;
      if (r.outcome === 'skipped') return also(r, lostBeside(g.m, g.f));
      return fail(r.change, r.message ? `${r.message} Also, ${lostBeside(g.m, g.f)}` : `Saved, but ${lostBeside(g.m, g.f)}`);
    });
    // A put-back import runs for seconds no read can see into (pending work, a change landing as it runs): a label one
    // wrote is never plainly saved or up to date, and a conflict there never hides another language someone else changed
    // meanwhile (the review shows a conflict without its message).
    results = results.map((r) => {
      const id: string = r.change.slot.ref.locLabelId;
      const wrote = backs.flatMap((b) => [...(b.wrote.get(id) ?? [])]);
      if (!wrote.length) return r;
      const unseen = backs.some((b) => b.unseen.has(id));
      // Unanswered, it may land after every read, writing what it carries over a change published meanwhile.
      const lost = backs.some((b) => b.lost.has(id));
      const conflict = r.outcome === 'conflict';
      // A cancelled change already told above what was lost on its label gets no second note.
      const stopped = r.outcome === 'skipped' && !owing.some((m) => m.id === id) && !gone.some((g) => g.m.id === id);
      if (!(r.outcome === 'saved' || r.outcome === 'unchanged' || stopped || (conflict && (unseen || lost || backs.some((b) => b.raced.some((m) => m.id === id && m.lcid !== r.change.lcid))))))
        return r;
      // Its row carried the base text as read: a change to that one can't be ruled out either.
      const langs = new Set<Lcid>([...(unseen || lost ? [ctx.base] : []), ...wrote]);
      const others = [...langs].filter((l) => !conflict || l !== r.change.lcid);
      const note =
        `someone else was changing this button's text at the same time — check it: the ${langList(others.length ? others : langs)} text of ${named(r.change)}. ${reads(ctx, id, last)}` +
        (unseen ? " The command bar could not be read right after putting theirs back, so another change at that moment can't be ruled out." : '') +
        (lost ? ' An import that put theirs back did not answer and may still be running: check it again in a minute.' : '');
      if (stopped) return also(r, note);
      return fail(r.change, conflict ? `${r.message} Also, ${note}` : `Saved, but ${note}`);
    });

    // Cleanup runs whatever happened above, and is not cancellable: a leftover solution is reported.
    const sol = st.sol;
    if (sol) {
      say('cleaning up');
      const note = st.busy
        ? `The temporary solution "${sol.name}" was kept because its import may still be running. Deleting it removes only the solution, not the table or its command bar; the translator also removes it automatically during one of your classic command saves an hour or more from now.`
        : (await deleteSolution(ctx, sol, say))
          ? ''
          : `The temporary solution "${sol.name}" could not be deleted. Deleting it removes only the solution, not the table or its command bar: delete it from Solutions in Power Apps, or let the translator remove it automatically during one of your classic command saves an hour or more from now.`;
      await dropStale(ctx).catch(() => {});
      if (note) results = results.map((r) => ({ ...r, message: r.message ? `${r.message} ${note}` : note }));
    }
    return results;
  },
};
