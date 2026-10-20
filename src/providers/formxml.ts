// Form and dashboard XML labels: tabs, sections, fields (body, header, footer, tab header/footer
// cells) and navigation items.
//
// Verified platform behavior (ARCHITECTURE §4.3): tab and section labels live in a per-UI-language
// store, so language L is read and written only while the user's UI language is L (LangSession).
// Cell and navigation labels are stored inline for every language, so one read and one write cover
// all of them without switching.
//
// Every request for form XML goes through LangSession (`hold` → `batch`), also in the user's own language:
// the answer carries tab and section labels in whatever UI language is current, so it must never run inside
// a switch window, and the probe in the batch proves which language it was answered in (LIVE-FINDINGS 49).
//
// Writing a form (one LangSession hold for all its languages, user's own language first):
//   * user's language: one batch [RetrieveUnpublished, published etag] → conflict check → one batch
//     [RetrieveUnpublished (probe), PATCH with every cell and navigation change (all languages) + this language's
//     tabs and sections, RetrieveUnpublished (verify)]  (one PATCH can carry all of that);
//   * each other language L with tab/section changes: the same two batches with the UI language switched to L
//     around them inside each batch (LIVE-FINDINGS 49).
// The If-Match etag is the PUBLISHED one (LIVE-FINDINGS 22, 47): it only catches a publish in between, so the
// fresh read right before each write, compared with what the user started from, is the real guard. Nothing guards
// the unpublished form from that read to the PATCH (finding 47: two PATCHes with the same etag both pass): the probe,
// the whole form read in the write batch right before the PATCH, shows a save someone else made in between, which this
// PATCH replaced. Their form is then written back with only these labels on it (providers/repair.ts); a label they
// changed too keeps their text and is a conflict. A write Dataverse turned away unrun (throttled, or the customization
// lock) is never resent: the pass starts again from a fresh read. Another language's pass holds the switch window
// across its read, its write and any repair (LangHold.window).
// A label already as asked ('unchanged') may be an earlier write whose answer was lost: the form is published
// when its unpublished version differs from the published one.
//
// Clearing a translation (ARCHITECTURE §4): a navigation item title is removed by deleting its
// <Title LCID=L> element. Tab, section and cell (field, dashboard component) labels cannot be removed:
// a form update without the label, or with it empty, keeps it (LIVE-FINDINGS 37), so clearing one is
// refused before anything is written.

import type { Ctx } from '../core/context';
import { DvError, abortError, guid, isAbort, mayHaveRun, partError, pause, q, turnedAway, type BatchPart, type PartResult } from '../core/http';
import { pick, toLabels } from '../core/labels';
import { LangSession, type LangBatch, type LangHold } from '../core/langsession';
import { lcidName } from '../core/lcid';
import { CANT_CLEAR_TEXT, MANAGED, canClear, isManaged, type Change, type ChangeResult, type Kind, type Labels, type Lcid, type Outcome, type Slot } from '../core/model';
import { assertOnlyChanged, blank, canon, kid, normId, parseXml, presentLabels, readLabels, removeLabel, serializeXml, upsertLabel } from '../core/xml';
import { olderVersion, settle, type DocOps } from './repair';
import { changeId, check, type FormRef, type LoadOptions, type Loader, type SaveOptions, type Writer } from './types';

const TYPES: Record<number, string> = {
  0: 'Dashboard',
  2: 'Main form',
  6: 'Quick view form',
  7: 'Quick create form',
  10: 'Interactive dashboard',
  11: 'Card form',
  12: 'Main interactive form',
};
/** Kinds stored per UI language (see above). */
const PER = new Set<Kind>(['tab', 'section', 'dtab', 'dsection']);
/** The user-language read also brings what a FormRef holds, so callers need no separate form lookup. */
const SEL = 'formid,formxml,iscustomizable,ismanaged,name,type,objecttypecode,versionnumber';
const UNPUB = 'systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=';
const isGuid = (s: string) => /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/.test(s);
const isDash = (type: number) => type === 0 || type === 10;
/** A tab's or section's name as the page and the form API know it: one without a name is called "{<its id>}". */
const pageName = (e: Element | undefined): string | undefined => {
  if (!e) return undefined;
  const id = (e.getAttribute('id') || '').replace(/[{}]/g, '').toLowerCase();
  return e.getAttribute('name') || (id ? `{${id}}` : undefined);
};
const chunks = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

interface Item {
  kind: Kind;
  el: Element;
  id: string;
  area: string;
  /** Enclosing tab / section (the element itself for tabs / sections). */
  tab?: Element;
  sec?: Element;
  /** Breadcrumb segment for elements outside sections ("Header", "Tab footer", "Navigation"). */
  zone?: string;
}
type Where = Omit<Item, 'kind' | 'el' | 'id'>;

type Shape = readonly [container: string, item: string, lcidAttr: string, textAttr: string];
const LAB: Shape = ['labels', 'label', 'languagecode', 'description'];
const NAV: Shape = ['Titles', 'Title', 'LCID', 'Text'];
const shape = (it: Item) => (it.kind === 'navitem' ? NAV : LAB);
const labelsOf = (it: Item): Labels => readLabels(it.el, ...shape(it));

/** Translatable elements of a form document, in document order. */
function collect(doc: Document, dash: boolean): Item[] {
  const out: Item[] = [];
  const k = (b: string) => ((dash ? 'd' : '') + b) as Kind;
  const add = (kind: Kind, el: Element, w: Where, id = normId(el.getAttribute('id'))) => {
    if (id) out.push({ kind, el, id, ...w });
  };
  const walk = (el: Element, w: Where): void => {
    for (const c of Array.from(el.children)) {
      const t = c.tagName;
      if (t === 'tab' && el.tagName === 'tabs') {
        const v = { area: 'body', tab: c };
        add(k('tab'), c, v);
        walk(c, v);
      } else if (t === 'section' && el.tagName === 'sections' && w.tab) {
        const v = { ...w, sec: c };
        add(k('section'), c, v);
        walk(c, v);
      } else if (t === 'cell') {
        // Spacers have no control and show no label.
        if (el.tagName === 'row' && c.getAttribute('userspacer') !== 'true' && kid(c, 'control')) add(k('field'), c, w);
      } else if (t !== 'labels') walk(c, t === 'tabheader' || t === 'tabfooter' ? { ...w, zone: 'Tab ' + t.slice(3) } : w);
    }
  };
  for (const c of Array.from(doc.documentElement.children)) {
    const t = c.tagName;
    if (t === 'tabs') walk(c, { area: 'body' });
    else if (t === 'header' || t === 'footer') walk(c, { area: t, zone: t === 'header' ? 'Header' : 'Footer' });
    else if (t === 'Navigation' && !dash)
      for (const n of Array.from(kid(c, 'NavBar')?.children || [])) {
        const id = n.getAttribute('Id')?.trim();
        if (id && kid(n, 'Titles')) add('navitem', n, { area: 'nav', zone: 'Navigation' }, id);
      }
  }
  return out;
}

/** The forms a quick view control shows (its `<QuickForms>` parameter holds an escaped `<QuickFormIds>` list); undefined for other controls. */
function quickViewForms(ctl: Element | undefined): string[] | undefined {
  const p = ctl && kid(ctl, 'parameters');
  const ids = ((p && kid(p, 'QuickForms')?.textContent) || '').match(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/gi);
  return ids?.length ? [...new Set(ids.map((s) => s.toLowerCase()))] : undefined;
}

/** comp -> element (first occurrence wins, as on load). */
function index(doc: Document, formId: string, dash: boolean): Map<string, Item> {
  const m = new Map<string, Item>();
  for (const it of collect(doc, dash)) {
    const comp = `${it.kind}|${formId}|${it.id}`;
    if (!m.has(comp)) m.set(comp, it);
  }
  return m;
}

/** One form's unpublished definition (+ @odata.etag); the published one has the caller's language only. */
const unpubOne = (id: string, sel: string): BatchPart => ({ method: 'GET', url: `systemforms(${id})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=${sel}` });
const notIn = (L: Lcid) => new DvError(`Dynamics did not answer in ${lcidName(L)}, so its form labels were not used. Try again.`, 0, 'langswitch');
const notSaved = (L: Lcid) => new DvError(`Dynamics did not answer in ${lcidName(L)}, so nothing was saved in that language. Try again.`, 0, 'langswitch');

// Why a form could not be read in a language (`ref.unread`). The message bar gathers them for many forms and
// languages (workbench.ts unreadLine), so they name neither the form nor the language.
/** A form a read in some language was not in an answer that came back. */
const NOT_RETURNED = 'Dynamics did not return the form in that language.';
const UNREADABLE = 'The form definition returned by Dataverse could not be read.';
/**
 * Why the cells and navigation items of a form read through its published fallback (`ref.unreadable`) are known in the
 * user's language only: reading that published definition in another language gives a cell without a label there the
 * column's name, as if it were its label (LIVE-FINDINGS 52). Reading again does not change it.
 */
export const PUB_ONLY = "This form has no unpublished definition in Dynamics, and its published one can't show the form's own field labels in other languages.";
/**
 * Why every label of a form read through its published fallback is read-only: a translation is only ever written over
 * a form's unpublished definition (writing a published one back could lose other makers' work), and Dynamics returns
 * none for this one, so a save could only fail.
 */
export const NO_UNPUB = "Dynamics returns no unpublished definition of this form, and translations are only written over that definition, so this form's labels can't be changed here.";
const msgOf = (e: unknown) => (e instanceof Error && e.message) || String(e);
const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

/** Forms read in one language: their rows by form id, and the forms whose own read failed with why (a form gone is in neither). */
interface Read {
  rows: Map<string, any>;
  bad: Map<string, Error>;
}
const putRead = (into: Read, r: Read) => {
  for (const [k, v] of r.rows) into.rows.set(k, v), into.bad.delete(k);
  for (const [k, v] of r.bad) if (!into.rows.has(k)) into.bad.set(k, v);
};

/**
 * Unpublished definitions of forms read while the UI language is `L` (tabs and sections come in it), keyed by
 * form id. One $batch per 40 forms through LangSession; forms the bulk call did not return are read one by one.
 * Only the user's own language (`published`) may fall back to the published definition, marked `_pub`: it
 * carries the caller's language only, cells included, so it is never written back. Throws when Dataverse did
 * not answer in `L` or a batch failed as a whole; a form whose own read failed is in `bad` (the load reads it
 * again, then reports it), and one gone (404) is simply missing.
 */
async function readForms(lang: LangSession, L: Lcid, ids: string[], sel: string, signal: AbortSignal, published: boolean): Promise<Read> {
  const out: Read = { rows: new Map(), bad: new Map() };
  const send = (parts: BatchPart[]): Promise<PartResult[]> =>
    lang.hold((h) => h.batch(L, parts, signal), signal).then((b) => {
      if (!b.inLang) throw notIn(L);
      return b.results;
    });
  for (const part of chunks(ids, 40)) {
    const [r] = await send([{ method: 'GET', url: `${UNPUB}${sel}&$filter=${part.map((id) => 'formid eq ' + id).join(' or ')}` }]);
    if (r.ok) for (const row of r.data?.value || []) out.rows.set(guid(row.formid), row);
  }
  // Whatever the bulk call did not return (everything, when it failed) is read form by form.
  for (const part of chunks(ids.filter((id) => !out.rows.has(id)), 10)) {
    const per = published ? 2 : 1;
    const rs = await send(part.flatMap((id) => [unpubOne(id, sel), ...(published ? [{ method: 'GET', url: `systemforms(${id})?$select=${sel}` } as BatchPart] : [])]));
    part.forEach((id, i) => {
      const [u, p] = rs.slice(i * per, i * per + per);
      if (u.ok) out.rows.set(id, u.data);
      else if (p?.ok && u.status === 404) out.rows.set(id, { ...p.data, _pub: 1 });
      else {
        // Gone (404 both ways) is left out; anything else is reported with the form.
        const bad = [u, p].find((x) => x && !x.ok && x.status !== 404);
        if (bad) out.bad.set(id, partError(bad));
      }
    });
  }
  return out;
}

/**
 * Forms read once more after a failed read, `read` waiting for the language lock afresh: all together, then, should
 * that fail as a whole too, one form at a time, so one form Dataverse can't answer for no longer keeps the others
 * out. One at a time stops after three forms in a row failed: the cause is then not one form, and the rest would fail
 * the same way (they keep that error). What still could not be read is in `bad`.
 */
async function again(ids: string[], read: (ids: string[]) => Promise<Read>): Promise<Read> {
  const out: Read = { rows: new Map(), bad: new Map() };
  if (!ids.length) return out;
  try {
    putRead(out, await read(ids));
    return out;
  } catch (e) {
    if (isAbort(e)) throw e;
    if (ids.length === 1) return out.bad.set(ids[0], asError(e)), out;
  }
  let row = 0;
  let last: Error | undefined;
  for (const id of ids) {
    if (row >= 3 && last) {
      out.bad.set(id, last);
      continue;
    }
    try {
      putRead(out, await read([id]));
      row = 0;
    } catch (e) {
      if (isAbort(e)) throw e;
      out.bad.set(id, (last = asError(e)));
      row++;
    }
  }
  return out;
}

/** Forms a page load reads the quick way at most (the Workbench's many forms use the bulk reads). */
const QUICK_MAX = 10;
/** Published definition of forms read in the batch's language (the caller's language only, cells included). */
const pubParts = (ids: string[]): BatchPart[] => ids.map((id) => ({ method: 'GET', url: `systemforms(${id})?$select=formid,formxml,versionnumber` }));

/**
 * Tab and section labels of a page's forms in another language, the quick way (LIVE-FINDINGS 52): a form whose
 * published versionnumber equals that of the unpublished definition just read (`rows`) has no unpublished
 * change, so its published definition read in `L` carries exactly the tab and section labels the unpublished one
 * would, at ~0.1 s a form against ~1.1 s for RetrieveUnpublished on a large form. Only tabs and sections may be
 * taken from it: a published cell with no label in the reading language comes with the column's name instead,
 * which would look like a translation (seen live on a 340-cell form). Forms that changed, have unpublished changes
 * or could not be read are left out: the caller reads those the exact way.
 */
async function quickOther(lang: LangSession, L: Lcid, ids: string[], rows: Map<string, any>, signal: AbortSignal): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const want = ids.filter((id) => rows.get(id)?.versionnumber != null && !rows.get(id)._pub);
  if (!want.length || want.length > QUICK_MAX) return out;
  try {
    const b = await lang.hold((h) => h.batch(L, pubParts(want), signal), signal);
    if (b.inLang)
      want.forEach((id, i) => {
        const r = b.results[i];
        if (r?.ok && r.data?.formxml && String(r.data.versionnumber) === String(rows.get(id).versionnumber)) out.set(id, r.data);
      });
  } catch (e) {
    if (isAbort(e)) throw e; // anything else: the exact read decides
  }
  return out;
}

/**
 * Forms read in another language `L`, for their tab and section labels (the only ones taken from them). A form the
 * user's language read through its published fallback (`_pub` in `rows`: RetrieveUnpublished does not find it) is
 * read the same way in `L`: its published definition carries its tabs and sections in `L` (its cells can't be used,
 * LIVE-FINDINGS 52). The others come the quick way when they have no unpublished change, else the exact way. Throws
 * when Dataverse did not answer in `L` or a batch failed as a whole.
 */
async function readOther(lang: LangSession, L: Lcid, ids: string[], rows: Map<string, any>, signal: AbortSignal): Promise<Read> {
  const out: Read = { rows: new Map(), bad: new Map() };
  const pub = ids.filter((id) => rows.get(id)?._pub);
  for (const part of chunks(pub, 10)) {
    const b = await lang.hold((h) => h.batch(L, pubParts(part), signal), signal);
    if (!b.inLang) throw notIn(L);
    part.forEach((id, i) => {
      const r = b.results[i];
      if (r?.ok && typeof r.data?.formxml === 'string') out.rows.set(id, r.data);
      else if (r && !r.ok && r.status !== 404) out.bad.set(id, partError(r));
    });
  }
  const rest = ids.filter((id) => !rows.get(id)?._pub);
  const quick = await quickOther(lang, L, rest, rows, signal);
  for (const [k, v] of quick) out.rows.set(k, v);
  const exact = rest.filter((id) => !quick.has(id));
  if (exact.length) putRead(out, await readForms(lang, L, exact, 'formid,formxml', signal, false));
  return out;
}

/** Table display names for breadcrumbs; cosmetic, so failures fall back to logical names. */
async function tableNames(ctx: Ctx, forms: FormRef[], signal: AbortSignal): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const ents = [...new Set(forms.map((f) => f.entity))].filter((e) => e && e !== 'none');
  try {
    for (const part of chunks(ents, 40))
      for (const r of await ctx.http.all(`EntityDefinitions?$select=LogicalName,DisplayName&$filter=${part.map((e) => `LogicalName eq '${q(e)}'`).join(' or ')}`, { signal }))
        m.set(r.LogicalName, pick(toLabels(r.DisplayName), ctx.user, ctx.base));
  } catch (e) {
    if (isAbort(e)) throw e;
  }
  return m;
}

/**
 * Tab, section, field and navigation labels of forms and dashboards. Cells and navigation items come
 * with every language; tabs and sections with the user's language, plus each other language in
 * `langs` read while the UI language is switched to it (only when `o.lang` is given). A form that
 * RetrieveUnpublished does not find is read from its published definition, its tabs and sections in each of those
 * languages; its cells and navigation items are known in the user's language only (`ref.unreadable` says why: in
 * another language a cell without a label there comes with its column's name, LIVE-FINDINGS 52). Slots not known in
 * every provisioned language get `ref.partial = true`, i.e. "not loaded".
 *
 * A language is never shown as empty, or written, without having been read. After the first pass, every
 * language whose read failed (a lock wait, a lost or failed batch, a switch not proven) and every form a read did
 * not bring is read once more, each read waiting for the language lock afresh (one form at a time when a batch
 * fails as a whole). Whatever still could not be read stays partial, and `ref.unread` on its slots says why, per
 * language (formNote() gathers it for a message and a Read again). A form the user's own language could not read
 * at all is left out and reported through `o.progress` ("Loaded with problems."); the load fails only when no
 * form could be read.
 *
 * `kinds`: the kinds the caller keeps (default: every kind). Other languages are read only for the forms where a
 * kept slot needs them: tabs and sections.
 *
 * A FormRef may come with its id only (`entity: ''`, `type: NaN`, `name: ''`): the read fills them in, so a
 * caller that knows just the form id needs no separate lookup first. Passing the table when it is known lets the
 * table's display name load alongside the read.
 */
export async function loadFormXml(ctx: Ctx, forms: FormRef[], langs: Lcid[], o: LoadOptions, kinds?: ReadonlySet<Kind>): Promise<Slot[]> {
  // Ids go into URLs; anything that is not a GUID (e.g. an empty id from the page) is skipped.
  const refs = [...new Map(forms.map((f) => [guid(f.formId), { ...f, formId: guid(f.formId) }])).values()].filter((f) => isGuid(f.formId));
  if (!refs.length) return [];
  const { signal } = o;
  // Every read of form XML is UI-language-sensitive, so it goes through the page's language lock even when
  // this load may not switch (no o.lang): it then reads the user's language only.
  const lang = o.lang ?? LangSession.of(ctx) ?? new LangSession(ctx);
  const ids = refs.map((f) => f.formId);
  const others = o.lang ? [...new Set(langs)].filter((l) => l !== ctx.user) : [];
  const steps = others.length + 1;
  const docIndex = (f: FormRef, r: any) => {
    try {
      return r?.formxml ? index(parseXml(r.formxml, 'form definition'), f.formId, isDash(f.type)) : null;
    } catch {
      return null; // an unreadable form is left out (and reported) rather than failing the whole load
    }
  };
  const titleOf = (e: Element) => {
    const l = readLabels(e, ...LAB);
    return l[ctx.user] || l[ctx.base] || e.getAttribute('name') || '';
  };

  o.progress('Reading form labels', 0, steps);
  const known = refs.filter((f) => f.entity);
  const readUser = (list: string[]) => readForms(lang, ctx.user, list, SEL, signal, true);
  // The user's language: a read that failed as a whole, or a form whose own read failed, is read once more.
  const first = async (): Promise<Read> => {
    let r: Read;
    try {
      r = await readUser(ids);
    } catch (e) {
      if (isAbort(e)) throw e;
      return again(ids, readUser);
    }
    if (r.bad.size) putRead(r, await again([...r.bad.keys()], readUser));
    return r;
  };
  const [tables, user] = await Promise.all([tableNames(ctx, known, signal), first()]);
  const rows = user.rows;
  // Not one form could be read: the load fails (the caller reports it).
  if (!rows.size && user.bad.size) throw user.bad.values().next().value;
  // A reference that came with the form id only is completed from the read itself.
  for (const f of refs) {
    const r = rows.get(f.formId);
    if (!r) continue;
    if (!f.entity) f.entity = r.objecttypecode || 'none';
    if (!(f.type >= 0)) f.type = Number(r.type);
    if (!f.name) f.name = r.name || '';
  }
  const late = refs.filter((f) => !known.includes(f) && rows.has(f.formId));
  if (late.length) for (const [k, v] of await tableNames(ctx, late, signal)) tables.set(k, v);

  const slots: Slot[] = [];
  /** Every slot by its comp: other languages are filled in through it. */
  const byComp = new Map<string, Slot>();
  /** Forms read through the published fallback: their cells and navigation items have the user's language only. */
  const pub = new Set<string>();
  /** Forms the user's language could not read, with why: left out, and reported. */
  const lost: Array<[FormRef, string]> = [];
  for (const f of refs) {
    const r = rows.get(f.formId);
    const idx = docIndex(f, r);
    if (!idx) {
      const e = user.bad.get(f.formId);
      if (e || r) lost.push([f, e ? msgOf(e) : UNREADABLE]); // a form gone (404 both ways) is simply not there
      continue;
    }
    if (r._pub) pub.add(f.formId);
    const table = f.entity === 'none' ? 'Dashboards' : tables.get(f.entity) || f.entity;
    const form = `${f.name} (${TYPES[f.type] || 'Form'})`;
    // A form or dashboard decides for all of its labels: one from a managed solution is read-only whatever its managed
    // properties allow (a translation would be an unmanaged layer on it), one of this environment as they say, and one
    // read through its published fallback always (nothing to write over: NO_UNPUB).
    const readOnly =
      r.ismanaged === true
        ? MANAGED
        : r.iscustomizable?.Value === false
          ? `This ${isDash(f.type) ? 'dashboard' : 'form'} is marked as not customizable (its “Allow customizations” managed property is off), so its labels can't be changed here.`
          : r._pub
            ? NO_UNPUB
            : '';
    for (const [comp, it] of idx) {
      // A label stored as '' counts as missing.
      const lab = presentLabels(labelsOf(it));
      // The published fallback has the reading language only, cells included.
      const per = PER.has(it.kind) || !!r._pub;
      const ctl = it.el.tagName === 'cell' ? kid(it.el, 'control') : undefined;
      const ctlId = ctl?.getAttribute('id') || '';
      const df = ctl?.getAttribute('datafieldname') || '';
      const name = it.el.getAttribute(it.area === 'nav' ? 'Id' : 'name') || '';
      const s: Slot = {
        key: comp + '|Label',
        kind: it.kind,
        prop: 'Label',
        entity: f.entity === 'none' ? '' : f.entity,
        comp,
        group: 'formxml|' + f.formId,
        title: lab[ctx.user] || lab[ctx.base] || ctlId || name || it.id,
        path: [table, form, ...[it.tab, it.sec].filter((e): e is Element => !!e && e !== it.el).map(titleOf), ...(it.zone ? [it.zone] : [])],
        // Hidden labels stay translatable; the note explains why they are not visible on the page.
        sub: [ctlId || name, df !== ctlId && df, it.el.getAttribute('showlabel') === 'false' && 'label hidden'].filter(Boolean).join(' · '),
        labels: per ? (ctx.user in lab ? { [ctx.user]: lab[ctx.user] } : {}) : lab,
        readOnly,
        baseRequired: false,
        max: 0,
        order: slots.length,
        ref: {
          formId: f.formId,
          elId: it.id,
          formType: f.type,
          area: it.area,
          tag: it.el.tagName,
          tabName: pageName(it.tab),
          sectionName: pageName(it.sec),
          controlId: ctlId || undefined,
          datafield: df || undefined,
          // The control's type: the popup names sub-grids and quick views by it (inspector/describe.ts).
          classid: ctl?.getAttribute('classid') || undefined,
          // A quick view control's forms: the page maps the fields it shows to their cells (LIVE-FINDINGS 56).
          quickForms: quickViewForms(ctl),
          // A related menu item's relationship (its schema name, or `hardcoded_{…}nav<Name>` for a built-in item): in a
          // language without a title of its own the item shows that relationship's text (LIVE-FINDINGS 80).
          relationship: (it.area === 'nav' && it.el.getAttribute('RelationshipName')?.trim()) || undefined,
          managed: r.ismanaged === true,
        },
      };
      slots.push(s);
      byComp.set(comp, s);
    }
  }

  /** Per form, the languages it was read in. */
  const readIn = new Map<string, Set<Lcid>>();
  /** Per form, the languages whose read failed, and why. */
  const failed = new Map<string, Map<Lcid, string>>();
  const needs = new Set<string>();
  for (const s of slots) {
    if (!readIn.has(s.ref.formId)) readIn.set(s.ref.formId, new Set([ctx.user]));
    if ((!kinds || kinds.has(s.kind)) && PER.has(s.kind)) needs.add(s.ref.formId);
  }
  // Only forms with tab or section labels need the other languages.
  const need = refs.filter((f) => needs.has(f.formId));
  /** Takes form `f` as read in `L` (row `r`); false when that read did not bring it. */
  const take = (L: Lcid, f: FormRef, r: any): boolean => {
    const idx = docIndex(f, r);
    if (!idx) return false;
    for (const [comp, it] of idx) {
      const s = byComp.get(comp);
      // Tabs and sections only: the cells of a published definition read in `L` can't be used (LIVE-FINDINGS 52).
      if (!s || !PER.has(it.kind)) continue;
      const t = labelsOf(it)[L];
      if (t) s.labels[L] = t; // '' counts as missing
    }
    readIn.get(f.formId)!.add(L);
    failed.get(f.formId)?.delete(L);
    return true;
  };
  const miss = (L: Lcid, f: FormRef, why: string) => (failed.get(f.formId) ?? failed.set(f.formId, new Map()).get(f.formId)!).set(L, why);
  /** Takes what a read in `L` brought; a form it lacks is noted with why. */
  const takeAll = (L: Lcid, fs: FormRef[], got: Read) => {
    for (const f of fs) {
      const r = got.rows.get(f.formId);
      const e = got.bad.get(f.formId);
      if (!take(L, f, r)) miss(L, f, r ? UNREADABLE : e ? msgOf(e) : NOT_RETURNED);
    }
  };
  const reader = (L: Lcid) => (list: string[]) => readOther(lang, L, list, rows, signal);
  if (need.length) {
    for (const [i, L] of others.entries()) {
      if (signal.aborted) throw abortError();
      o.progress(`Reading form labels in ${lcidName(L)}`, i + 1, steps);
      try {
        takeAll(L, need, await reader(L)(need.map((f) => f.formId)));
      } catch (e) {
        if (isAbort(e)) throw e; // that language is read once more below
        for (const f of need) miss(L, f, msgOf(e));
      }
    }
    // Once more, each read waiting for the language lock afresh: every language whose read failed, and every form a
    // read did not bring (one form at a time should a batch fail as a whole again).
    for (const L of others) {
      const left = need.filter((f) => !readIn.get(f.formId)!.has(L));
      if (!left.length) continue;
      if (signal.aborted) throw abortError();
      o.progress(`Reading form labels in ${lcidName(L)} again`);
      takeAll(L, left, await again(left.map((f) => f.formId), reader(L)));
    }
  }

  // Labels are known only in the languages actually read for their form; any other provisioned language would
  // otherwise look "missing" and invite overwriting a label nobody has seen. On a partial slot a language present in
  // `labels` means "read" (ui/editor notLoaded; Store keeps '' there), so a language that was read but has no label
  // is marked '': it is missing (editable), not "Not loaded". Cells and navigation items come with every language,
  // except those of a form read through its published fallback: the user's language only, whatever was read.
  const all = ctx.langs.map((l) => l.lcid);
  for (const s of slots) {
    const f = s.ref.formId;
    const per = PER.has(s.kind);
    if (!per && !pub.has(f)) continue;
    const got = per ? readIn.get(f)! : new Set([ctx.user]);
    if (all.every((l) => got.has(l))) continue;
    s.ref.partial = true;
    for (const l of got) if (!(l in s.labels)) s.labels[l] = '';
    // No read can bring the others: the slot says why, and none of it is asked to be read again (formNote).
    if (!per) {
      s.ref.unreadable = PUB_ONLY;
      continue;
    }
    // Why each language not read could not be (none for a language this load was not asked to read).
    const why = failed.get(f);
    const un = all.filter((l) => !got.has(l) && why?.has(l));
    if (un.length) s.ref.unread = Object.fromEntries(un.map((l) => [l, why!.get(l)!]));
  }
  if (lost.length) {
    const [f0, w0] = lost[0];
    o.progress(`Loaded with problems. The labels of ${lost.length === 1 ? `the form “${f0.name || f0.formId}”` : `${lost.length} forms`} could not be read: ${w0}`);
  }
  return slots;
}

/** What form loads could not read in some language (the `ref.unread` of their slots), for a message and a Read again. */
export interface FormNote {
  /** The forms, as loadFormXml takes them (the read fills in what they lack). */
  forms: FormRef[];
  /** The languages not read, in the order met. */
  langs: Lcid[];
  /** Why, each reason once. */
  why: string[];
}

/**
 * The forms and languages of `slots` whose read failed (loadFormXml `ref.unread`); null when there are none. Labels no
 * read can bring (`ref.unreadable`, a form read through its published fallback) are not among them.
 */
export function formNote(slots: Iterable<Slot>): FormNote | null {
  const forms = new Map<string, FormRef>();
  const langs = new Set<Lcid>();
  const why = new Set<string>();
  for (const s of slots) {
    const u: Record<string, string> | undefined = s.ref?.unread;
    if (!u || s.ref.partial !== true) continue;
    for (const [k, w] of Object.entries(u)) {
      const l = Number(k);
      if (l in s.labels) continue; // read since (a save, a read again)
      langs.add(l);
      why.add(w);
      if (!forms.has(s.ref.formId)) forms.set(s.ref.formId, { formId: s.ref.formId, entity: s.entity, name: '', type: s.ref.formType });
    }
  }
  return forms.size ? { forms: [...forms.values()], langs: [...langs], why: [...why] } : null;
}

/**
 * Slots of forms read again (a Read again reads only the languages that were not) merged with the ones held so far
 * (`had`, the store): a language read before and not in this read keeps the text read then, so reading some languages
 * never makes the others "not loaded" again. A slot then known in every language of `all` is complete again.
 */
export function mergeReads(fresh: Slot[], had: (key: string) => Slot | undefined, all: readonly Lcid[]): Slot[] {
  return fresh.map((s) => {
    const o = had(s.key);
    if (s.ref?.partial !== true || !o) return s;
    const labels: Labels = { ...s.labels };
    // On a partial slot the languages in `labels` are the ones read; a complete one was read in every language.
    for (const l of o.ref?.partial === true ? Object.keys(o.labels).map(Number) : all) if (!(l in labels)) labels[l] = o.labels[l] ?? '';
    const ref = { ...s.ref };
    if (all.every((l) => l in labels)) {
      // Complete: a language without a label is simply missing.
      for (const k of Object.keys(labels)) if (labels[Number(k)] === '') delete labels[Number(k)];
      delete ref.partial;
      delete ref.unread;
      delete ref.unreadable;
    } else {
      const u: Record<string, string> = { ...o.ref?.unread, ...ref.unread };
      for (const k of Object.keys(u)) if (Number(k) in labels) delete u[k];
      if (Object.keys(u).length) ref.unread = u;
      else delete ref.unread;
    }
    return { ...s, labels, ref };
  });
}

/** Workbench loader: forms of the scope's tables and (solution) dashboards. */
export const loadFormsScope: Loader = async (ctx, scope, o) => {
  const has = (...k: Kind[]) => k.some((x) => scope.kinds.has(x));
  const filters = has('tab', 'section', 'field', 'navitem')
    ? chunks(scope.entities, 40).map((p) => `(${p.map((e) => `objecttypecode eq '${q(e)}'`).join(' or ')}) and (type eq 2 or type eq 6 or type eq 7 or type eq 11 or type eq 12)`)
    : [];
  const dash = has('dtab', 'dsection', 'dfield');
  if (dash) filters.push('type eq 0 or type eq 10');
  if (!filters.length) return [];
  const { signal } = o;
  o.progress('Finding forms');
  const [rows, inSolution] = await Promise.all([
    Promise.all(filters.map((f) => ctx.http.all(`${UNPUB}formid,name,type,objecttypecode,iscustomizable,ismanaged&$filter=${f}`, { signal }))),
    dash && scope.solutionId
      ? ctx.http
          .all(`solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${guid(scope.solutionId)} and componenttype eq 60`, { signal })
          .then((a) => new Set(a.map((r) => guid(r.objectid))))
      : null,
  ]);
  const forms: FormRef[] = rows
    .flat()
    // Read-only forms (from a managed solution, or not customizable) only when read-only labels are asked for.
    .filter((r) => (scope.includeReadOnly || (r.ismanaged !== true && r.iscustomizable?.Value !== false)) && !(inSolution && isDash(r.type) && !inSolution.has(guid(r.formid))))
    .map((r) => ({ formId: guid(r.formid), entity: r.objecttypecode || 'none', name: r.name || '', type: Number(r.type) }))
    .sort((a, b) => a.entity.localeCompare(b.entity) || a.type - b.type || a.name.localeCompare(b.name));
  // Other languages cost a UI-language switch and a full re-read each: loadFormXml reads them only for the forms
  // whose kept labels need them (tabs and sections). Forms and dashboards are read separately.
  const out: Slot[] = [];
  for (const d of [false, true]) {
    const part = forms.filter((f) => isDash(f.type) === d);
    if (part.length) out.push(...(await loadFormXml(ctx, part, ctx.langs.map((l) => l.lcid), o, scope.kinds)));
  }
  // A form the listing named but RetrieveUnpublished did not find is read-only too (NO_UNPUB): asked for as above.
  return out.filter((s) => scope.kinds.has(s.kind) && (scope.includeReadOnly || s.readOnly !== NO_UNPUB));
};

const res = (change: Change, outcome: Outcome, message?: string): ChangeResult => ({ change, outcome, message });
// Errors are reported per language pass (not thrown to the saver), so permission failures need their own wording.
const errText = (e: unknown) =>
  e instanceof DvError && e.status === 403
    ? 'You do not have permission to change this form. Translating needs the System Customizer or System Administrator role.'
    : (e instanceof Error && e.message) || 'Something went wrong while saving the form labels.';
/** A non-base translation saved empty (or as only spaces) is removed, so that language shows the base text. */
const clears = (ctx: Ctx, c: Change): boolean => c.lcid !== ctx.base && !c.after.trim();

/**
 * check() with blank values treated alike, so a label stored as '' or as spaces is no conflict for a user who
 * saw no text (the store keeps '' for a cleared or blank label). `server` is undefined when the language has
 * no label element. A change is 'unchanged' only when the form already holds exactly what it asks for: for a
 * removal, no label element in that language at all (an empty one left behind is removed); otherwise that
 * exact text, where a missing label counts as '' (blanking a base label that does not exist writes nothing).
 */
function compare(c: Change, server: string | undefined, remove: boolean, force: Set<string>): ChangeResult | null {
  const r = check({ ...c, before: blank(c.before), after: remove ? '' : blank(c.after) }, blank(server), force);
  if (r?.outcome === 'unchanged' && (remove ? server !== undefined : (server ?? '') !== c.after)) return null;
  return r && { ...r, change: c, ...(r.outcome === 'conflict' ? { server: server ?? '' } : {}) };
}

const UNCHECKED = 'Sent to Dataverse, but the result could not be checked. Reload to confirm it.';
const GONE = 'This label is no longer on the form. Reload to see the current form.';

/** A pass whose write Dataverse turned away before running it: nothing was written. `results` say so, should no retry be left. */
class Unrun extends Error {
  constructor(readonly results: ChangeResult[]) {
    super('turned away');
  }
}

/** A form as read in one UI language: its XML (parsed once, never edited), the published etag a PATCH checks, and the unpublished versionnumber when read. */
interface FormDoc {
  xml: string;
  doc: Document;
  etag: string;
  ver?: unknown;
}

// PATCH checks If-Match against the PUBLISHED row (verified live: the RetrieveUnpublished etag fails with 412 once the
// form has unpublished changes), so the etag comes from a plain GET read alongside. Both bring the versionnumber: they
// differ while the form has unpublished changes. The unpublished one also says whether the form is from a managed solution.
const readParts = (formId: string): BatchPart[] => [unpubOne(formId, 'formxml,versionnumber,ismanaged'), { method: 'GET', url: `systemforms(${formId})?$select=formid,versionnumber` }];
const etagOf = (pub: PartResult): string => (pub.ok && pub.data?.['@odata.etag']) || '*';
/** The whole form right before the PATCH (the probe: a $batch runs its parts in order), the PATCH, the form right after. */
const writeParts = (formId: string, xml: string, etag: string): BatchPart[] => [
  unpubOne(formId, 'formxml,versionnumber'),
  { method: 'PATCH', url: `systemforms(${formId})`, headers: { 'If-Match': etag }, body: { formxml: xml } },
  unpubOne(formId, 'formxml'),
];

/** The form a part read; null when it could not be read, or was not proven to be read in the batch's language. */
function formOf(b: LangBatch, r: PartResult, etag: string): FormDoc | null {
  if (!b.inLang || !r.ok || typeof r.data?.formxml !== 'string') return null;
  try {
    return { xml: r.data.formxml, doc: parseXml(r.data.formxml, 'form definition'), etag, ver: r.data.versionnumber };
  } catch {
    return null;
  }
}

/**
 * For canon(): the label entries of `todo`'s label/language pairs in a document indexed as `idx`, and a label container
 * of theirs holding nothing else, so an empty <labels/> that gets its first label (tabs read in a language they have no
 * label in), or that loses its only label to a removal, is not seen as a structural change. Every other label counts,
 * the same language on another element included.
 */
function pairs(idx: Map<string, Item>, todo: Change[]): (el: Element) => boolean {
  const own = new Map<Element, Set<number>>();
  for (const c of todo) {
    const el = idx.get(c.slot.comp)?.el;
    if (el) (own.get(el) ?? own.set(el, new Set()).get(el)!).add(c.lcid);
  }
  const lcid = (el: Element) => Number(el.getAttribute(el.tagName === 'label' ? 'languagecode' : 'LCID'));
  const mine = (el: Element) => (el.tagName === 'label' || el.tagName === 'Title') && !!own.get(el.parentElement?.parentElement as Element)?.has(lcid(el));
  return (el) => mine(el) || ((el.tagName === 'labels' || el.tagName === 'Titles') && !el.attributes.length && own.has(el.parentElement as Element) && Array.from(el.children).every(mine));
}

/** A form's documents for settle(), in UI language `L` inside the writer's hold. */
function formOps(ctx: Ctx, h: LangHold, L: Lcid, formId: string, dash: boolean): DocOps<FormDoc, string> {
  const indexes = new WeakMap<FormDoc, Map<string, Item>>();
  const idx = (d: FormDoc) => indexes.get(d) ?? indexes.set(d, index(d.doc, formId, dash)).get(d)!;
  const labelIn = (d: FormDoc, c: Change) => {
    const it = idx(d).get(c.slot.comp);
    return it && labelsOf(it);
  };
  // A repair always finishes: its reads are not cancelled with the save (a batch with writes never is).
  const never = new AbortController().signal;
  return {
    noun: 'form',
    publish: true,
    gone: GONE,
    dropped: (c) =>
      clears(ctx, c) ? 'Dataverse did not remove this translation. Reload the form to see what is saved.' : 'Dataverse did not keep this label. Reload the form to see what is saved.',
    async read() {
      const b = await h.batch(L, readParts(formId), never);
      if (!b.inLang) throw notSaved(L);
      const d = formOf(b, b.results[0], etagOf(b.results[1]));
      if (!d) throw b.results[0].ok ? new Error('This form no longer exists.') : partError(b.results[0]);
      return d;
    },
    build(base, todo) {
      const doc = parseXml(base.xml, 'form definition');
      const now = index(doc, formId, dash);
      for (const c of todo) {
        const it = now.get(c.slot.comp);
        if (!it) throw new Error(GONE);
        const [container, item, lcidAttr, textAttr] = shape(it);
        if (clears(ctx, c)) removeLabel(it.el, { container, item, lcidAttr, lcid: c.lcid });
        else upsertLabel(doc, it.el, { container, item, lcidAttr, textAttr, lcid: c.lcid, text: c.after });
      }
      const was = pairs(idx(base), todo);
      const is = pairs(now, todo);
      assertOnlyChanged(base.doc, doc, (el) => was(el) || is(el));
      return serializeXml(doc);
    },
    async send(xml, fresh) {
      const b = await h.batch(L, writeParts(formId, xml, fresh.etag));
      const [vb, pr, vr] = b.results;
      if (!pr.ok) throw partError(pr);
      return { probe: formOf(b, vb, fresh.etag), back: formOf(b, vr, fresh.etag) };
    },
    same: (a, b) => a.xml === b.xml || canon(a.doc.documentElement, () => false) === canon(b.doc.documentElement, () => false),
    older: (a, b) => olderVersion(a.ver, b.ver),
    alike: (a, b, todo) => canon(a.doc.documentElement, pairs(idx(a), todo)) === canon(b.doc.documentElement, pairs(idx(b), todo)),
    state: (d, c) => {
      const l = labelIn(d, c);
      return l ? JSON.stringify(l[c.lcid] ?? null) : null;
    },
    text: (d, c) => labelIn(d, c)?.[c.lcid] ?? '',
    // A removed translation must be gone, not merely blank.
    holds: (d, c) => {
      const l = labelIn(d, c);
      return !!l && (clears(ctx, c) ? !(c.lcid in l) : (l[c.lcid] ?? '') === c.after);
    },
  };
}

/**
 * One read-modify-write of a form in UI language `L`, inside the writer's LangSession hold: a batch reading the
 * unpublished XML (fresh, never what was loaded) and the published etag, the conflict check, then a batch with the
 * whole unpublished form (the probe), the PATCH and its read-back. In the user's own language the batches only probe
 * the language; in another one they switch to it and back around the parts. Throws Unrun when the write was turned
 * away unrun. A probe that is not the form just read means someone else saved it in between and this PATCH replaced
 * their definition (nothing guards the unpublished one, LIVE-FINDINGS 22, 47): settle() puts it back.
 */
async function writePass(ctx: Ctx, h: LangHold, L: Lcid, s0: Slot, cs: Change[], o: SaveOptions, retry: boolean): Promise<ChangeResult[]> {
  const { formId } = s0.ref;
  const dash = isDash(s0.ref.formType);
  const target = () => (dash ? o.publish.dashboards.add(formId) : o.publish.entities.add(s0.entity));
  const rb = await h.batch(L, readParts(formId), o.signal);
  // Tab and section labels read in another language would be compared with, and written as, the wrong ones.
  if (!rb.inLang) throw notSaved(L);
  const [rr, pub] = rb.results;
  if (!rr.ok && rr.status !== 404) throw partError(rr);
  const r = rr.data;
  if (!r?.formxml) return cs.map((c) => res(c, 'error', 'This form no longer exists.'));
  // From a managed solution as read right before the write (one that slipped through as editable): never written, so
  // no unmanaged layer is ever put on it.
  if (r.ismanaged === true) return cs.map((c) => res(c, 'error', MANAGED));
  const etag = etagOf(pub);
  // Never published (no published row), or changed since it was.
  const pending = !pub.ok || String(pub.data?.versionnumber ?? '') !== String(r.versionnumber ?? '');
  const base: FormDoc = { xml: r.formxml, doc: parseXml(r.formxml, 'form definition'), etag, ver: r.versionnumber };
  const ops = formOps(ctx, h, L, formId, dash);
  const idx = index(base.doc, formId, dash);
  const out: ChangeResult[] = [];
  const todo: Array<[Change, string]> = [];
  for (const c of cs) {
    const it = idx.get(c.slot.comp);
    if (!it) {
      out.push(res(c, 'error', GONE));
      continue;
    }
    // A removal aims for no label element, whatever spaces were typed.
    const stored = labelsOf(it)[c.lcid];
    const k = compare(c, stored, clears(ctx, c), o.force);
    if (k) {
      if (k.outcome === 'conflict' && c.slot.ref.partial && !(c.lcid in c.slot.labels))
        k.message = 'The current label in this language was not loaded. Check the value now on the server, then save again.';
      out.push(k);
      continue;
    }
    todo.push([c, stored ?? '']);
  }
  // A label already as asked may be an earlier write whose answer was lost, still unpublished: published with the rest.
  if (pending && out.some((x) => x.outcome === 'unchanged')) target();
  if (!todo.length) return out;
  const xml = ops.build(base, todo.map(([c]) => c));
  // Cancel stops before the write; once sent, the write and its check always finish (h.batch sends a batch
  // with writes without the signal).
  if (o.signal.aborted) throw abortError();
  const failed = (e: unknown) => [...out, ...todo.map(([c]) => res(c, 'error', errText(e)))];
  /** The PATCH ran or may have (SaveOptions.ran): a later run finding these labels as asked may be finding it. */
  const ran = () => todo.forEach(([c]) => o.ran?.add(changeId(c)));
  let wb: LangBatch;
  try {
    wb = await h.batch(L, writeParts(formId, xml, etag));
  } catch (e) {
    // Turned away before it ran (Http never resends it): nothing was written; the caller starts again from a read.
    if (turnedAway(e)) throw new Unrun(failed(e));
    if (!mayHaveRun(e)) return failed(e);
    // Its answer was lost, so it may have been written: published with the rest, so it shows once a Try again
    // finds it there.
    ran();
    target();
    return [...out, ...todo.map(([c]) => res(c, 'error', UNCHECKED))];
  }
  const [vb, pr, vr] = wb.results;
  if (!pr.ok) {
    const e = partError(pr);
    if (turnedAway(e)) throw new Unrun(failed(e));
    // No answer for the PATCH itself: it may have run.
    if (!pr.status) ran();
    if (pr.status !== 412) return failed(e);
    if (retry) return writePass(ctx, h, L, s0, cs, o, false);
    return [...out, ...todo.map(([c, server]): ChangeResult => ({ change: c, outcome: 'conflict', server, message: 'The form was changed by someone else while saving. Check it, then save again.' }))];
  }
  ran();
  target();
  const back = formOf(wb, vr, etag);
  const fixed = await settle(ops, base, todo.map(([c]) => c), { probe: formOf(wb, vb, etag), back });
  if (fixed) return [...out, ...fixed];
  // Dataverse answers 204 even when it drops a label, so the batch read it back, in the same UI language.
  const vi = back && index(back.doc, formId, dash);
  for (const [c] of todo) {
    if (!back) out.push(res(c, 'error', UNCHECKED));
    else if (!vi?.get(c.slot.comp)) out.push(res(c, 'error', 'This label is no longer on the form after saving. Reload to see the current form.'));
    else out.push(ops.holds(back, c) ? res(c, 'saved') : res(c, 'error', ops.dropped(c)));
  }
  return out;
}

/**
 * One language's pass. A write Dataverse turned away unrun is tried again after 2, 4 and 8 s, each time from a
 * fresh read (never the earlier one). Another language's pass holds the switch window across its read and its
 * write, so the write never waits for a quiet() job (an option write retrying the customization lock) in between.
 */
async function writeLang(ctx: Ctx, h: LangHold, L: Lcid, s0: Slot, cs: Change[], o: SaveOptions): Promise<ChangeResult[]> {
  const pass = () => writePass(ctx, h, L, s0, cs, o, true);
  for (let i = 0; ; i++) {
    try {
      return await (L === ctx.user ? pass() : h.window(pass));
    } catch (e) {
      if (!(e instanceof Unrun)) throw e;
      if (i >= 3) return e.results;
      await pause(2000 << i, o.signal);
    }
  }
}

export const formXmlWriter: Writer = {
  kinds: ['tab', 'section', 'field', 'navitem', 'dtab', 'dsection', 'dfield'],
  lane: 'xml',
  async read(ctx, changes, o) {
    // The loader reads the unpublished form as save() does, tab and section labels of another language in that language.
    const ref: FormRef = { formId: changes[0].slot.ref.formId, entity: '', type: NaN, name: '' };
    const slots = await loadFormXml(ctx, [ref], [...new Set(changes.map((c) => c.lcid))], { signal: o.signal, progress() {}, lang: o.lang });
    const now = new Map(slots.map((s) => [s.key, s] as const));
    return new Map(
      changes.map((c): [string, string | Error] => {
        const s = now.get(c.slot.key);
        if (!s) return [changeId(c), new Error('This label is no longer on the form.')];
        // A partial slot lacks the languages it could not read ('' marks one read without a label).
        if (s.ref?.partial === true && !(c.lcid in s.labels)) return [changeId(c), new Error(s.ref.unread?.[c.lcid] || s.ref.unreadable || `The ${lcidName(c.lcid)} text could not be read.`)];
        return [changeId(c), s.labels[c.lcid] ?? ''];
      }),
    );
  },
  async save(ctx, changes, o) {
    const s0 = changes[0].slot;
    const out: ChangeResult[] = [];
    // Tab/section labels are written per language; cell and navigation labels (every language) ride
    // along with the user's own language, which goes first.
    const passes = new Map<Lcid, Change[]>([[ctx.user, []]]);
    for (const c of changes) {
      // Loaded from a managed form or dashboard: refused before any read or language switch (writePass checks again).
      if (isManaged(c.slot)) {
        out.push(res(c, 'error', MANAGED));
        continue;
      }
      // Tab, section and field labels live in per-language stores that a form update can add to or change
      // but not remove from (canClear; LIVE-FINDINGS 37). Refused here, before any language switch; the
      // form's other changes still save. Navigation item titles are removed with their element (finding 38).
      if (!canClear(c.slot) && clears(ctx, c)) {
        out.push(res(c, 'error', CANT_CLEAR_TEXT));
        continue;
      }
      const L = PER.has(c.slot.kind) ? c.lcid : ctx.user;
      let a = passes.get(L);
      if (!a) passes.set(L, (a = []));
      a.push(c);
    }
    const left = [...passes].filter(([, cs]) => cs.length);
    if (!left.length) return out;
    const fail = (cs: Change[], e: unknown) => cs.map((c) => (isAbort(e) ? res(c, 'skipped', 'Cancelled before saving.') : res(c, 'error', errText(e))));
    // One hold for the whole form: no other language-sensitive work (a page load, another form) runs between
    // its passes, and each pass reads what the one before it wrote (the cells go out again with every PATCH).
    const done = new Set<Lcid>();
    try {
      await o.lang.hold(async (h) => {
        for (const [L, cs] of left) {
          try {
            if (o.signal.aborted) throw abortError();
            o.progress(`Saving ${s0.path.slice(0, 2).join(' › ')}${L === ctx.user ? '' : ` (${lcidName(L)})`}`);
            out.push(...(await writeLang(ctx, h, L, s0, cs, o)));
          } catch (e) {
            // Earlier passes keep their own results; only this language's changes fail.
            out.push(...fail(cs, e));
          }
          done.add(L);
        }
      }, o.signal);
    } catch (e) {
      // The hold did not start (cancelled while waiting, or the language could not be repaired): nothing was sent.
      for (const [L, cs] of left) if (!done.has(L)) out.push(...fail(cs, e));
    }
    return out;
  },
};
