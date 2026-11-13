// Form and dashboard XML labels: tabs, sections, fields (body, header, footer, tab header/footer
// cells) and navigation items.
//
// Verified platform behavior (ARCHITECTURE §4.3): tab and section labels live in a per-UI-language
// store, so language L is read and written only while the user's UI language is L (LangSession). So do
// the labels of cells whose control is bound to no column (a timeline, a web resource, an iframe…), sub-grids
// aside (LIVE-FINDINGS 102). The labels of cells bound to a column, of sub-grids and of navigation items come with
// every language in any UI language (a column's cell's stored per label key, LIVE-FINDINGS 104), so one read covers all
// of them without switching, and so does one write, which on a main form posts a column's cell only with what it
// changes (SPARSE).
//
// Every request for form XML goes through LangSession (`hold` → `batch`), also in the user's own language:
// the answer carries tab and section labels in whatever UI language is current, so it must never run inside
// a switch window, and the probe in the batch proves which language it was answered in (LIVE-FINDINGS 49).
//
// Writing a form (one LangSession hold for all its languages, user's own language first):
//   * user's language: one batch [RetrieveUnpublished, published etag] → conflict check → one batch
//     [RetrieveUnpublished (probe), PATCH with this language's changes (every change of an every-language label, all
//     languages, + this language's per-language labels): on a main form (SPARSE) a column's cell carries only the
//     languages the save changes and none where it changes nothing (LIVE-FINDINGS 103, 104: a read fills in each
//     column's name, and a label posted back as read would be stored as the form's own); every other element as read,
//     RetrieveUnpublished (verify)] (one PATCH can carry all of that), then the check that nothing it left out moved
//     (nothingElse);
//   * each other language L with changes of per-language labels: the same two batches with the UI language switched
//     to L around them inside each batch (LIVE-FINDINGS 49), and the same check.
// The If-Match etag is the PUBLISHED one (LIVE-FINDINGS 22, 47): it only catches a publish in between, so the
// fresh read right before each write, compared with what the user started from, is the real guard. A fresh read older
// than a version of the form this page already saw lags behind it (LIVE-FINDINGS 66): it is read again, and nothing is
// written from one still behind (NEWEST), as each pass and each save posts the form as read. Nothing guards
// the unpublished form from that read to the PATCH (finding 47: two PATCHes with the same etag both pass): the probe,
// the whole form read in the write batch right before the PATCH, shows a save someone else made in between, which this
// PATCH replaced. Their form is then written back with only these labels on it and, on a sparse form, their text of a
// label we both changed posted explicitly (providers/repair.ts `theirs`); a label they changed too keeps their text and
// is a conflict. A write Dataverse turned away unrun (throttled, or the customization lock) is never resent: the pass
// starts again from a fresh read. Another language's pass holds the switch window across its read, its write and any
// repair (LangHold.window).
// A label already as asked ('unchanged') may be an earlier write whose answer was lost: the form is published
// when its unpublished version differs from the published one.
//
// A field label saved but missing from the published form while its versions agree takes no publish, nor the same text
// written again (LIVE-FINDINGS 117): Publish again writes it with MARK after it, publishes, writes it as it is and
// publishes again (writeAgain).
//
// Clearing a translation (ARCHITECTURE §4): a navigation item title is removed by deleting its <Title LCID=L> element
// (LIVE-FINDINGS 38). Tab, section and cell (field, dashboard component) labels can't be removed: a form update without
// the label, or with it empty, keeps it (LIVE-FINDINGS 37, 104), so the saver writes its stand-in, and a blank one is
// refused here. A cell keeps its label key (105), except where a clear frees it of its last label of its own
// (Change.standIn.follow): it then goes on a new key with no label, so that it follows its column in every language.

import { columnCell } from '../core/column';
import type { Ctx } from '../core/context';
import { DvError, abortError, guid, isAbort, mayHaveRun, partError, pause, q, turnedAway, type BatchPart, type PartResult } from '../core/http';
import { pick, toLabels } from '../core/labels';
import { LangSession, type LangBatch, type LangHold } from '../core/langsession';
import { lcidName } from '../core/lcid';
import { CANT_CLEAR_TEXT, MANAGED, behindText, canClear, droppedBack, droppedLeft, managedHeld, managedReadOnly, perLanguage, type Change, type ChangeResult, type Kind, type Labels, type Lcid, type Outcome, type Slot } from '../core/model';
import { PartialPublishError, isLockError } from '../core/publish';
import { assertOnlyChanged, blank, canon, kid, kids, normId, parseXml, presentLabels, readLabels, removeLabel, serializeXml, upsertLabel } from '../core/xml';
import { LABEL_CACHE } from '../ui/refresh';
import { olderVersion, raceText, settle, type DocOps } from './repair';
import { CHANGED, changeId, check, type CellOwn, type FormWrite, type FormRef, type LoadOptions, type Loader, type OwnCopy, type SaveOptions, type Writer } from './types';

const TYPES: Record<number, string> = {
  0: 'Dashboard',
  2: 'Main form',
  6: 'Quick view form',
  7: 'Quick create form',
  10: 'Interactive dashboard',
  11: 'Card form',
  12: 'Main interactive form',
};
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

/**
 * The forms whose saves post a column's cell without labels where they change none, and only the languages they
 * change where they do (LIVE-FINDINGS 104): by systemform type, the zones checked live. Dataverse keeps a label a PATCH
 * leaves out, so nothing else is written, and no column's name a read fills in (103) is ever stored as the form's own
 * label (109). Every other form type, zone and element goes out as read, as before. Widened only after a live check of
 * that type or zone (docs/developer-guide.md, "Checking a form type live").
 */
const SPARSE: ReadonlyMap<number, ReadonlySet<string>> = new Map([[2, new Set(['body', 'header'])]]);
/** Where a cell is, as SPARSE names it: 'body', 'header', 'footer', or 'tab' for a tab's header or footer. */
const zoneOf = (it: Item): string => (it.zone?.startsWith('Tab ') ? 'tab' : it.area);
/** A column's own cell (core/column.ts columnCell) in a zone SPARSE lists for the form's type. */
function sparseCell(it: Item, type: number): boolean {
  if (it.kind !== 'field' || !SPARSE.get(type)?.has(zoneOf(it))) return false;
  const ctl = kid(it.el, 'control');
  return !!ctl && columnCell({ datafield: ctl.getAttribute('datafieldname'), controlId: ctl.getAttribute('id') });
}
/** A form's name as the save tells it (model.ts droppedBack, droppedLeft): its slots' path without the type suffix, as ui/editor.ts strips it. */
const formName = (s0: Slot): string => String(s0.path[1] || '').replace(/ \([^()]*\)$/, '');
/** The column a cell's control is bound to (its datafieldname, lower-cased as SaveOptions.column takes it). */
const datafield = (it: Item): string => (kid(it.el, 'control')?.getAttribute('datafieldname') || '').toLowerCase();
/** A cell's label key (LIVE-FINDINGS 104): its labelid, else its id. */
const keyOf = (it: Item): string => normId(it.el.getAttribute('labelid')) || it.id;

/**
 * What Publish again's repair writes after a label's text first, a zero-width space no one sees (rewrite, LIVE-FINDINGS
 * 117): a publish takes a label whose text a write changed, then the text as it is.
 */
export const MARK = '\u200b';
/** A text without the MARK the repair's first write put after it. */
const unmarked = (t: string): string => (t.endsWith(MARK) ? t.slice(0, -MARK.length) : t);

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

/**
 * A control's Name from the form designer (its `<UClientUniqueName>` parameter); undefined when it has none. The timeline
 * shows it as its heading, one text for every language: Dynamics keeps one Name for all languages (LIVE-FINDINGS 101).
 */
function uniqueName(ctl: Element | undefined): string | undefined {
  const p = ctl && kid(ctl, 'parameters');
  return (p && kid(p, 'UClientUniqueName')?.textContent?.trim()) || undefined;
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
 * Per-language labels of a page's forms in another language, the quick way (LIVE-FINDINGS 52, 102): a form whose
 * published versionnumber equals that of the unpublished definition just read (`rows`) has no unpublished
 * change, so its published definition read in `L` carries exactly the per-language labels in `L` the unpublished one
 * would, at ~0.1 s a form against ~1.1 s for RetrieveUnpublished on a large form. Only those may be taken from it: a
 * published cell bound to a column with no label in the reading language comes with the column's name instead,
 * which would look like a translation (seen live on a 340-cell form). Forms that changed, have unpublished changes
 * or could not be read are left out: the caller reads those the exact way. The published version of each form read
 * goes into `pubVersion`, theirs too.
 */
async function quickOther(lang: LangSession, L: Lcid, ids: string[], rows: Map<string, any>, pubVersion: Map<string, string>, signal: AbortSignal): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const want = ids.filter((id) => rows.get(id)?.versionnumber != null && !rows.get(id)._pub);
  if (!want.length || want.length > QUICK_MAX) return out;
  try {
    const b = await lang.hold((h) => h.batch(L, pubParts(want), signal), signal);
    if (b.inLang)
      want.forEach((id, i) => {
        const r = b.results[i];
        if (r?.ok && r.data?.versionnumber != null) pubVersion.set(id, String(r.data.versionnumber));
        if (r?.ok && r.data?.formxml && String(r.data.versionnumber) === String(rows.get(id).versionnumber)) out.set(id, r.data);
      });
  } catch (e) {
    if (isAbort(e)) throw e; // anything else: the exact read decides
  }
  return out;
}

/**
 * Forms read in another language `L`, for their per-language labels (the only ones taken from them, perLanguage). A
 * form the user's language read through its published fallback (`_pub` in `rows`: RetrieveUnpublished does not find
 * it) is read the same way in `L`: its published definition carries its tabs and sections in `L` (its cells can't be
 * used, LIVE-FINDINGS 52). The others come the quick way when they have no unpublished change, else the exact way (the
 * quick read puts their published versions in `pubVersion`). Throws when Dataverse did not answer in `L` or a batch failed
 * as a whole.
 */
async function readOther(lang: LangSession, L: Lcid, ids: string[], rows: Map<string, any>, pubVersion: Map<string, string>, signal: AbortSignal): Promise<Read> {
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
  const quick = await quickOther(lang, L, rest, rows, pubVersion, signal);
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
 * Tab, section, field and navigation labels of forms and dashboards. Cells bound to a column, sub-grids and
 * navigation items come with every language; the per-language labels (perLanguage: tabs, sections and the other
 * cells) with the user's language, plus each other language in `langs` read while the UI language is switched to
 * it (only when `o.lang` is given). A form that RetrieveUnpublished does not find is read from its published
 * definition, its tabs and sections in each of those languages; its cells and navigation items are known in the
 * user's language only (`ref.unreadable` says why: in another language a cell without a label there comes with its
 * column's name, LIVE-FINDINGS 52). Slots not known in every provisioned language get `ref.partial = true`, i.e.
 * "not loaded".
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
    // properties allow (a translation would be an unmanaged layer on it), unless this session allows changes to managed
    // labels (Ctx.managedEdits): then, like one of this environment, as they say; one read through its published fallback
    // always (nothing to write over: NO_UNPUB). A managed one's labels keep both reasons (core/model.ts managedSlot).
    const managed = r.ismanaged === true;
    const lock =
      r.iscustomizable?.Value === false
        ? `This ${isDash(f.type) ? 'dashboard' : 'form'} is marked as not customizable (its “Allow customizations” managed property is off), so its labels can't be changed here.`
        : r._pub
          ? NO_UNPUB
          : '';
    const readOnly = managed && !ctx.managedEdits ? MANAGED : lock;
    for (const [comp, it] of idx) {
      // A label stored as '' counts as missing.
      const lab = presentLabels(labelsOf(it));
      const ctl = it.el.tagName === 'cell' ? kid(it.el, 'control') : undefined;
      const ctlId = ctl?.getAttribute('id') || '';
      const df = ctl?.getAttribute('datafieldname') || '';
      // The published fallback has the reading language only, cells included.
      const per = perLanguage({ kind: it.kind, ref: { datafield: df, classid: ctl?.getAttribute('classid') } }) || !!r._pub;
      const name = it.el.getAttribute(it.area === 'nav' ? 'Id' : 'name') || '';
      const sparse = (!managed || !!ctx.managedEdits) && !r._pub && sparseCell(it, f.type);
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
          // Its Name from the form designer: the timeline's heading where it has one (inspector/describe.ts).
          uniqueName: uniqueName(ctl),
          // A quick view control's forms: the page maps the fields it shows to their cells (LIVE-FINDINGS 56).
          quickForms: quickViewForms(ctl),
          // A related menu item's relationship (its schema name, or `hardcoded_{…}nav<Name>` for a built-in item): in a
          // language without a title of its own the item shows that relationship's text (LIVE-FINDINGS 80).
          relationship: (it.area === 'nav' && it.el.getAttribute('RelationshipName')?.trim()) || undefined,
          managed,
          // A managed form's: its reason as an unmanaged one's, and MANAGED (core/model.ts managedSlot).
          ...(managed ? { lock, held: MANAGED } : {}),
          // A main form's column cell (SPARSE): a save posts it only with what it changes (LIVE-FINDINGS 104), and which of
          // its labels are the form's own can be known (core/model.ts follows, 114).
          sparse: sparse || undefined,
          // The cell's label key when it has one of its own (`labelid`): its labels are stored under it, and
          // ExportTranslation and GetClientMetadata name them by it (LIVE-FINDINGS 106).
          labelKey: normId(it.el.getAttribute('labelid')) || undefined,
          // Such a cell's form version: which of its labels are its own is kept by it (loadOwnLabels). The version read
          // here; none where a read in another language finds the published one isn't it (below).
          formVersion: (sparse && r.versionnumber != null && String(r.versionnumber)) || undefined,
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
    if ((!kinds || kinds.has(s.kind)) && perLanguage(s)) needs.add(s.ref.formId);
  }
  // Only forms with per-language labels (tabs, sections, cells of controls bound to no column) need the other languages.
  const need = refs.filter((f) => needs.has(f.formId));
  /** Takes form `f` as read in `L` (row `r`); false when that read did not bring it. */
  const take = (L: Lcid, f: FormRef, r: any): boolean => {
    const idx = docIndex(f, r);
    if (!idx) return false;
    for (const [comp, it] of idx) {
      const s = byComp.get(comp);
      // Per-language labels only: the other cells of a published definition read in `L` can't be used (LIVE-FINDINGS 52).
      if (!s || !perLanguage(s)) continue;
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
  /** Per form, its published version as a quick read in another language brought it (quickOther). */
  const pubVersion = new Map<string, string>();
  const reader = (L: Lcid) => (list: string[]) => readOther(lang, L, list, rows, pubVersion, signal);
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
  // GetClientMetadata describes the published form: where a quick read in another language found the published version
  // isn't the one read (a change not published yet, which may be a cell's text worded as its column's name), its answer
  // tells nothing of the cells loaded, so they get no version (loadOwnLabels leaves them out) and show as loaded until the
  // form is published.
  for (const s of slots) if (s.ref.formVersion && pubVersion.has(s.ref.formId) && pubVersion.get(s.ref.formId) !== s.ref.formVersion) delete s.ref.formVersion;

  // Labels are known only in the languages actually read for their form; any other provisioned language would
  // otherwise look "missing" and invite overwriting a label nobody has seen. On a partial slot a language present in
  // `labels` means "read" (ui/editor notLoaded; Store keeps '' there), so a language that was read but has no label
  // is marked '': it is missing (editable), not "Not loaded". Every-language labels (cells bound to a column, sub-grids,
  // navigation items) come with every language, except those of a form read through its published fallback: the
  // user's language only, whatever was read.
  const all = ctx.langs.map((l) => l.lcid);
  for (const s of slots) {
    const f = s.ref.formId;
    const per = perLanguage(s);
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

/**
 * The `MetadataNames` of the part of the page's own read of a form that holds its labels (LIVE-FINDINGS 114, 115): with
 * `MetadataSubtype` Main, Dataverse leaves out what it names (the tables' metadata, the ribbons, the web resources) and
 * keeps the form and its labels.
 */
const OWN_NAMES = '{"Exclude":["entity","ribbon","webresource"]}';
/**
 * GetClientMetadata of a main form, as the page reads its labels (LIVE-FINDINGS 114): it lists, under each cell's label
 * key, only the labels the published cell stores, in the UI language it is read in. About 0.1 MB on the test form and 1 MB
 * on a large one, where the whole answer is 1.3 and 8.7 MB, with the same labels. Without the page's `x-ms-gcm-object`
 * header, which leaves a $batch part's answer empty: its metadata comes as a JSON string.
 */
const ownPart = (formId: string, entity: string): BatchPart => {
  const q = { MetadataType: 'form', MetadataSubtype: 'Main', EntityLogicalName: entity, MetadataId: formId, MetadataNames: [OWN_NAMES], GetDefault: false, DependencyDepth: 'OnDemandWithoutContext' };
  return { method: 'GET', url: `GetClientMetadata(ClientMetadataQuery=@q)?@q=${encodeURIComponent(JSON.stringify(q))}` };
};

/** A form's labels of its own in one language, as GetClientMetadata told them. */
interface Own {
  /** The published form's versionnumber the answer describes. */
  v: string;
  /** The label keys it lists a label of the cell's own for. */
  k: string[];
}

/** A GetClientMetadata answer's metadata: an object (the page's copies), or a JSON string of it (a Web API read); null when unreadable. */
function metadataOf(data: any): any {
  const m = data?.Metadata;
  if (typeof m !== 'string') return m && typeof m === 'object' ? m : null;
  try {
    return JSON.parse(m);
  } catch {
    return null;
  }
}

/** A `Labels` entry of a cell's own label in the language read: its `displayname` (a `displayname_<base>` is the base language's, LIVE-FINDINGS 114). */
const ownEntry = (e: any): boolean => String(e?.LabelColumnName).toLowerCase() === 'displayname';

/**
 * The label keys a form's GetClientMetadata metadata `md` lists a label of the cell's own for in the language it was read
 * in (ownEntry), and the published version it describes. null when it doesn't hold that form with its labels.
 */
function ownKeys(md: any, formId: string): Own | null {
  const f = Array.isArray(md?.Forms) ? md.Forms.find((x: any) => guid(x?.FormId) === formId) : null;
  if (f?.VersionNumber == null || !Array.isArray(md.Labels)) return null;
  return { v: String(f.VersionNumber), k: md.Labels.filter(ownEntry).map((e: any) => guid(e.Id)) };
}

/**
 * Where a form's labels of its own in a language are kept between page loads: the page's localStorage, which Dynamics
 * uses too, one small entry per form and language, with the time it was written (`t`; an entry of an earlier build has
 * none). Never required: storage that is blocked, full or holds something else keeps nothing, and the form is read again.
 * Kept within a budget: the entries of the OWN_FORMS forms of the org written last (pruneOwn).
 */
const OWN_KEY = (ctx: Ctx, formId: string, l: Lcid) => `dxt:own:${ctx.orgId}:${formId}:${l}`;
/** The forms of an org whose answers are kept at most, every language of a form together (about 7 KB a language on a large form, LIVE-FINDINGS 115). */
const OWN_FORMS = 100;
/**
 * Drops the answers kept (OWN_KEY) of the forms of the org written longest ago, every language of a form together, so that
 * at most `keep` forms besides `formId` keep theirs; one without its time (an earlier build's) counts as the oldest.
 * Returns how many forms besides `formId` keep theirs.
 */
function pruneOwn(ctx: Ctx, formId: string, keep: number): number {
  const pre = `dxt:own:${ctx.orgId}:`;
  const forms = new Map<string, string[]>();
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(pre)) continue;
    const f = k.slice(pre.length, k.lastIndexOf(':'));
    if (f !== formId) (forms.get(f) ?? forms.set(f, []).get(f)!).push(k);
  }
  if (forms.size <= keep) return forms.size;
  /** When a form's answers were written last: the newest time among its entries (written first in each, storeOwn). */
  const at = (ks: string[]) => Math.max(...ks.map((k) => Number(/^\{"t":(\d+)/.exec(localStorage.getItem(k) ?? '')?.[1] ?? 0)));
  const old = [...forms.values()].map((ks) => [at(ks), ks] as const).sort((a, b) => a[0] - b[0]);
  for (const [, ks] of old.slice(0, forms.size - keep)) for (const k of ks) localStorage.removeItem(k);
  return keep;
}
function storedOwn(ctx: Ctx, formId: string, l: Lcid): Own | null {
  try {
    const e = JSON.parse(localStorage.getItem(OWN_KEY(ctx, formId, l)) || 'null');
    return typeof e?.v === 'string' && Array.isArray(e.k) && e.k.every((x: unknown) => typeof x === 'string') ? e : null;
  } catch {
    return null;
  }
}
function storeOwn(ctx: Ctx, formId: string, l: Lcid, own: Own): void {
  try {
    const e = JSON.stringify({ t: Date.now(), v: own.v, k: own.k });
    let keep = pruneOwn(ctx, formId, OWN_FORMS - 1);
    for (;;)
      try {
        return localStorage.setItem(OWN_KEY(ctx, formId, l), e);
      } catch (x) {
        // Full: the answers of the form written longest ago go, one form at a time, until it fits.
        if (!keep) throw x;
        keep = pruneOwn(ctx, formId, keep - 1);
      }
  } catch {
    /* blocked or full: read again next time */
  }
}

/** How long the page's copies are looked for at most (ms, pageOwnLabels): what is found by then counts. */
const COPY_WAIT = 3000;

/**
 * The language a copy of a GetClientMetadata answer is in, as its custom controls' resource files name it (`….1036.resx`,
 * LIVE-FINDINGS 115): the copies of every language a form was shown in sit side by side, under addresses that don't name
 * it (84). Proven only by one language there: none or several, and it is not known.
 */
function copyLanguage(md: any): Lcid | null {
  const ids = new Set<number>();
  for (const m of JSON.stringify(md?.CustomControls ?? null).matchAll(/\.(\d{4,5})\.resx"/g)) ids.add(Number(m[1]));
  return ids.size === 1 ? [...ids][0] : null;
}

/** The copy of form `formId`'s answer that the cached request `r` of cache `c` holds (pageOwnLabels), or null. */
async function copyOf(c: Cache, r: Request, formId: string, entity: string): Promise<OwnCopy | null> {
  const q = JSON.parse(new URL(r.url).searchParams.get('@ClientMetadataQuery') || 'null');
  if (q?.MetadataType !== 'form' || (entity && q.EntityLogicalName && q.EntityLogicalName !== entity)) return null;
  // The parts of the page's read that hold no labels: KeepOnly the tables, the ribbons or the web resources.
  if ((Array.isArray(q.MetadataNames) ? q.MetadataNames : []).some((x: unknown) => String(x).includes('"KeepOnly"'))) return null;
  const res = await c.match(r);
  if (!res?.ok) return null;
  const md = metadataOf(await res.json());
  const own = ownKeys(md, formId);
  const l = own && copyLanguage(md);
  if (!own || !l) return null;
  const t: Record<string, string> = {};
  for (const e of md.Labels) if (ownEntry(e)) t[guid(e.Id)] = String(e.Value ?? '');
  return { form: formId, l, ...own, t };
}

/**
 * The page's own copies of a main form's GetClientMetadata answer (LIVE-FINDINGS 115): UCI reads the part of it that holds
 * the form's labels (OWN_NAMES) to draw the form, and its service worker keeps the answer in its label caches
 * (ui/refresh.ts LABEL_CACHE), so the user's language is there as the form shows, and so is every other language it was
 * shown in on this browser. Nothing is sent. Newest cache first, a cached form request that isn't one of the parts
 * without labels, whose answer holds the form with its labels, in a language its resource files prove (copyLanguage)
 * and this environment has; per language the first one found, its newest. Every step reads how UCI keeps them, which
 * may change: an answer not as expected is left out, and a failure, or COPY_WAIT, ends the search; what was found by then
 * counts. `entity`, the form's table where known, skips other tables' forms.
 */
export async function pageOwnLabels(ctx: Ctx, formId: string, entity = ''): Promise<OwnCopy[]> {
  const langs = new Set(ctx.langs.map((l) => l.lcid));
  const found = new Map<Lcid, OwnCopy>();
  const over = new AbortController();
  const done = () => over.signal.aborted || found.size === langs.size;
  const search = async () => {
    const names = (await caches.keys()).filter((n) => LABEL_CACHE.test(n)).sort((a, b) => parseInt(b.slice(4), 10) - parseInt(a.slice(4), 10));
    for (const n of names) {
      if (done()) return;
      const c = await caches.open(n);
      for (const r of await c.keys()) {
        if (done()) return;
        const copy = await copyOf(c, r, formId, entity).catch(() => null);
        if (copy && langs.has(copy.l) && !found.has(copy.l)) found.set(copy.l, copy);
      }
    }
  };
  await Promise.race([search().catch(() => {}), pause(COPY_WAIT, over.signal).catch(() => {})]);
  over.abort();
  return [...found.values()];
}

/** The main form cells of `cells` whose labels of their own can be known (a load's `ref.sparse` slots, with their form's version), by form. */
function ownForms(cells: Slot[]): Map<string, Slot[]> {
  const forms = new Map<string, Slot[]>();
  for (const s of cells) if (s.ref?.sparse && s.ref.formVersion) (forms.get(s.ref.formId) ?? forms.set(s.ref.formId, []).get(s.ref.formId)!).push(s);
  return forms;
}
/** Per form, its answer in each language kept for the version its cells were loaded at. */
function ownKept(ctx: Ctx, forms: Map<string, Slot[]>): Map<string, Map<Lcid, Own>> {
  const got = new Map<string, Map<Lcid, Own>>();
  for (const [formId, ss] of forms) {
    const g = new Map<Lcid, Own>();
    for (const { lcid } of ctx.langs) {
      const e = storedOwn(ctx, formId, lcid);
      if (e && e.v === ss[0].ref.formVersion) g.set(lcid, e);
    }
    got.set(formId, g);
  }
  return got;
}
/** What the answers `got` tell, per slot key and language. */
function ownAnswer(forms: Map<string, Slot[]>, got: Map<string, Map<Lcid, Own>>): Map<string, Record<number, boolean>> {
  const out = new Map<string, Record<number, boolean>>();
  for (const [formId, ss] of forms) {
    const g = got.get(formId)!;
    if (g.size) for (const s of ss) out.set(s.key, Object.fromEntries([...g].map(([l, o]) => [l, o.k.includes(s.ref.labelKey || s.ref.elId)])));
  }
  return out;
}

/**
 * What is known without a request of whether the main form cells `cells` have labels of their own (`ref.own`, core/model.ts
 * follows): the answers kept for their form's version (OWN_KEY), and the page's copies of that version (pageOwnLabels)
 * whose texts agree with the loaded ones: a label one lists as a cell's own is the cell's text there as loaded (a copy in
 * another language than its resource files say, or a change not published yet, differs), and a cell it lists none for
 * has the text a read `fills` in there (core/model.ts fillsIn: an answer once lacked the form's own labels, LIVE-FINDINGS
 * 113). Without `fills`, or while it can't tell (the column's names not loaded), no copy that leaves a cell out is
 * taken. A copy taken is kept as that language's answer, so loadOwnLabels reads nothing for it. Per slot key, the
 * languages known.
 */
export function knownOwnLabels(ctx: Ctx, cells: Slot[], copies: OwnCopy[] = [], fills?: (s: Slot, l: Lcid) => boolean): Map<string, Record<number, boolean>> {
  const forms = ownForms(cells);
  const got = ownKept(ctx, forms);
  for (const c of copies) {
    const ss = forms.get(c.form);
    if (!ss || c.v !== ss[0].ref.formVersion) continue;
    // Its texts agree with the loaded ones: a label it lists as a cell's own is the cell's text there as loaded, and a
    // cell it lists none for has the text a read fills in there.
    const agrees = (s: Slot) => {
      const t = c.t[s.ref.labelKey || s.ref.elId];
      return t === undefined ? !!fills?.(s, c.l) : t === s.labels[c.l];
    };
    if (!ss.every(agrees)) continue;
    const own = { v: c.v, k: c.k };
    storeOwn(ctx, c.form, c.l, own);
    got.get(c.form)!.set(c.l, own);
  }
  return ownAnswer(forms, got);
}

/**
 * Per slot key and language, whether GetClientMetadata lists a label of the cell's own there (`ref.own`, core/model.ts
 * follows), for the main form cells `cells` (a load's `ref.sparse` slots). Read once the page's loads are done
 * (inspector/pageload.ts), never in their switch window: first in the user's language, in a batch of its own without a
 * switch, one form at a time; then each other language in a switch window of its own, every form in one batch, each
 * window in a hold of its own, so a load that starts in between gets the lock first. `known` gets what is known before
 * each window, so it shows without waiting for it. An answer is kept in the browser (OWN_KEY): a form loaded at the
 * published version it describes (`ref.formVersion`; a form a load found with a change not published has none, and is
 * left out) is not read again, in any language; nor is one the page keeps a copy of (knownOwnLabels). An answer of
 * another version than the one its cells were loaded at tells nothing of them: neither taken nor kept. A
 * language is read only where some cell is `undecided` there: its text is the column's name, so only the answer tells
 * whether it follows the column (without `undecided`, every cell is). A read that fails or isn't proven to be in its
 * language leaves that language unknown, so a label there worded as its column's name shows as the user's language does
 * (core/model.ts follows) until a later load reads it.
 */
export async function loadOwnLabels(
  ctx: Ctx,
  cells: Slot[],
  signal: AbortSignal,
  known?: (own: Map<string, Record<number, boolean>>) => void,
  undecided?: (s: Slot, l: Lcid) => boolean,
): Promise<Map<string, Record<number, boolean>>> {
  const lang = LangSession.of(ctx) ?? new LangSession(ctx);
  const forms = ownForms(cells);
  /** Per form, its answer in each language: kept for the version loaded, or read now. */
  const got = ownKept(ctx, forms);
  /** Whether form `formId` (cells `ss`) is read in `l`: no answer known there, and a cell only an answer decides. */
  const needs = (formId: string, ss: Slot[], l: Lcid) => !got.get(formId)!.has(l) && (!undecided || ss.some((s) => undecided(s, l)));
  /** Takes the answer of form `formId` read in `l`, and keeps it; a failed one, or one of another version than its cells', leaves `l` unknown. */
  const take = (formId: string, l: Lcid, r: PartResult | undefined) => {
    const own = r?.ok ? ownKeys(metadataOf(r.data), formId) : null;
    if (!own || own.v !== forms.get(formId)![0].ref.formVersion) return;
    storeOwn(ctx, formId, l, own);
    got.get(formId)!.set(l, own);
  };
  for (const [formId, ss] of forms) {
    if (!needs(formId, ss, ctx.user)) continue;
    try {
      const b = await lang.hold((h) => h.batch(ctx.user, [ownPart(formId, ss[0].entity)], signal), signal);
      if (b.inLang) take(formId, ctx.user, b.results[0]);
    } catch (e) {
      if (isAbort(e)) throw e; // anything else: unknown
    }
  }
  // A switching batch is never stopped once sent, and a stop while it runs would only drop its answer (LangHold.batch),
  // which a later window would then read again. So the signal is looked at once the window is held, right before the
  // batch is sent, and the batch gets one that never aborts: a load that starts meanwhile waits for this read, never for
  // a second window, and its answer is kept.
  const never = new AbortController().signal;
  for (const L of ctx.langs.map((l) => l.lcid).filter((l) => l !== ctx.user)) {
    const need = [...forms].filter(([formId, ss]) => needs(formId, ss, L));
    if (!need.length) continue;
    known?.(ownAnswer(forms, got));
    try {
      const b = await lang.hold(
        (h) =>
          h.window(async () => {
            if (signal.aborted) throw abortError();
            return h.batch(L, need.map(([formId, ss]) => ownPart(formId, ss[0].entity)), never);
          }),
        signal,
      );
      if (b.inLang) need.forEach(([formId], i) => take(formId, L, b.results[i]));
    } catch (e) {
      if (isAbort(e)) throw e; // anything else: unknown
    }
  }
  return ownAnswer(forms, got);
}

/**
 * Keeps the answers of which field labels of main form `formId` are its own (OWN_KEY) for the published version `to` that
 * a publish of the translator's own made of version `from` (ui/review.ts keepOwnLabels), so a reload reads none of them
 * again (loadOwnLabels): in each language whose answer for `from` is kept, its label keys, and the key of each cell the
 * save posted (`cells`) where its label is the form's own there now. A text worded as its column's name is the label's
 * own only where its key held a label (LIVE-FINDINGS 104): where some language's answer lists it, or where every
 * language's is kept and none does. A language where any of it isn't known is not kept, nor is one not kept for `from`:
 * the page reads those again.
 */
export function carryOwnLabels(ctx: Ctx, formId: string, from: string, to: string, cells: readonly CellOwn[]): void {
  const kept = new Map<Lcid, Own>();
  for (const { lcid } of ctx.langs) {
    const e = storedOwn(ctx, formId, lcid);
    if (e?.v === from) kept.set(lcid, e);
  }
  const held = (k: string): boolean | null => ([...kept.values()].some((e) => e.k.includes(k)) ? true : kept.size === ctx.langs.length ? false : null);
  for (const [l, e] of kept) {
    const now = cells.map((c) => (c.own[l] === 'name' ? held(c.key) : c.own[l]));
    if (now.includes(null)) continue;
    const k = new Set(e.k);
    cells.forEach((c, i) => {
      if (now[i] === true) k.add(c.key);
      else if (now[i] === false) k.delete(c.key);
    });
    storeOwn(ctx, formId, l, { v: to, k: [...k] });
  }
}

/**
 * The labels of a form definition's field cells, by cell id (the first of a duplicated id, as a load takes it); null when
 * `xml` can't be read. A published definition read in a UI language carries that language only, with a cell's column's
 * name where it has no label of its own there (LIVE-FINDINGS 52, 103): the check after publishing reads it so
 * (ui/review.ts unpublishedForms).
 */
export function cellLabels(xml: unknown): Map<string, Labels> | null {
  if (typeof xml !== 'string') return null;
  try {
    const out = new Map<string, Labels>();
    for (const it of collect(parseXml(xml, 'form definition'), false)) if (it.kind === 'field' && !out.has(it.id)) out.set(it.id, labelsOf(it));
    return out;
  } catch {
    return null;
  }
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
    .filter((r) => (scope.includeReadOnly || ((r.ismanaged !== true || !!ctx.managedEdits) && r.iscustomizable?.Value !== false)) && !(inSolution && isDash(r.type) && !inSolution.has(guid(r.formid))))
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
 * compare() for a label its cell's last own label was emptied of (Change.standIn.follow, model.ts freesAll): its text reads
 * as its column's name either way, so only the cell's label key tells. On another key than the label was loaded on, it
 * is done already (this write's, its answer lost) where it reads as its column's name there (`names`, LIVE-FINDINGS 103),
 * else someone else gave the new key a text of their own: a conflict. On the key loaded, another text than the one it was
 * emptied of is someone else's (a conflict), and so is another text than the one loaded in any other language: a label of
 * their own there, saved since, which a new key would leave behind (104, 105), so nothing is written until a reload shows
 * it. Where the text there was and is one of its column's names, it follows its column still (renamed by this save).
 * Before all that, which of the cell's labels are its own is known only as loaded (`ref.own`, for the form's version then,
 * `ref.formVersion`), and a text can't tell (a label of its own worded as its column's name, as a form designer save
 * stores every language of a cell with one, LIVE-FINDINGS 109): only a form this save found as loaded (`form`, its
 * versions agreeing at its first read) is moved, else nothing is written until a reload reads them again.
 */
function freed(c: Change, it: Item, server: string | undefined, force: Set<string>, names: (l: Lcid) => readonly string[] | undefined, form: FormWrite | undefined): ChangeResult | null {
  if (!form || form.pending || !c.slot.ref.formVersion || form.version !== c.slot.ref.formVersion) return res(c, 'error', CHANGED);
  const plain = (l: Lcid, t: string) => !t.trim() || !!names(l)?.includes(t);
  if (keyOf(it) !== (c.slot.ref.labelKey || c.slot.ref.elId)) {
    if (plain(c.lcid, server ?? '')) return res(c, 'unchanged');
    if (!force.has(changeId(c))) return { change: c, outcome: 'conflict', server: server ?? '', message: CHANGED };
  } else {
    const got = labelsOf(it);
    for (const k of new Set([...Object.keys(got), ...Object.keys(c.slot.labels)])) {
      const l = Number(k);
      const [t, v] = [got[l] ?? '', c.slot.labels[l] ?? ''];
      if (l !== c.lcid && t !== v && !(plain(l, t) && plain(l, v))) return res(c, 'error', CHANGED);
    }
  }
  const r = check({ ...c, after: '' }, blank(server), force);
  return r && r.outcome === 'conflict' ? { ...r, change: c } : null;
}

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
/** A write the safety check of a sparse form stopped before anything was sent (assertSent), in core/xml.ts assertOnlyChanged's words. */
const UNSAFE = 'Safety check failed: the change would have modified more than the translated labels, so nothing was saved.';
/** settle()'s words for a form (repair.ts raceText): by them the check after the write tells that its own write may have replaced a save someone else made (model.ts droppedBack). */
const RACE = raceText('form', true);

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
  unpubOne(formId, 'formxml,versionnumber'),
];

/**
 * The newest unpublished version of each form this page's writes read or left (its versionnumber: every save raises it),
 * by form id, with when it was seen. A read of that form older than it, in the next LAG_MS, lags behind it (LIVE-FINDINGS
 * 66): a write built on it would put back what was saved since (the labels a write posts as read), and with the probe of
 * the write batch lagging too, nothing would tell (providers/repair.ts settle). For the passes of one save and for the
 * saves that follow in this page.
 */
const NEWEST = new WeakMap<Ctx, Map<string, { ver: unknown; at: number }>>();
/** How long a version counts (NEWEST): reads lagged for seconds (LIVE-FINDINGS 66), as providers/metadata.ts MINE_MS. */
const LAG_MS = 60_000;
/** The waits before a read that lags is read again (writePass): then nothing is written from it. */
const LAG_WAITS = [1000, 2000, 4000];
/** Notes a version of a form this page's writer read or wrote (NEWEST). */
function saw(ctx: Ctx, formId: string, ver: unknown): void {
  if (ver == null || ver === '') return;
  const m = NEWEST.get(ctx) ?? NEWEST.set(ctx, new Map()).get(ctx)!;
  const had = m.get(formId);
  if (!had || Date.now() - had.at >= LAG_MS || olderVersion(had.ver, ver)) m.set(formId, { ver, at: Date.now() });
}
/** A read of a form showing an older version than the newest this page's writer saw of it in the last LAG_MS (NEWEST). */
function lagging(ctx: Ctx, formId: string, ver: unknown): boolean {
  const had = NEWEST.get(ctx)?.get(formId);
  return !!had && Date.now() - had.at < LAG_MS && olderVersion(ver, had.ver);
}

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
 * A fresh read of a form in UI language `L` inside the writer's hold, for a write after the pass's first (a repair, a
 * write-back): never cancelled with the save, as a batch with writes never is, so it always finishes. Throws when it
 * can't be read.
 */
async function readForm(ctx: Ctx, h: LangHold, L: Lcid, formId: string): Promise<FormDoc> {
  const b = await h.batch(L, readParts(formId), new AbortController().signal);
  if (!b.inLang) throw notSaved(L);
  const d = formOf(b, b.results[0], etagOf(b.results[1]));
  if (!d) throw b.results[0].ok ? new Error('This form no longer exists.') : partError(b.results[0]);
  saw(ctx, formId, d.ver);
  return d;
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

/** What one language's pass of a form writes (formOps): its changes, the read they are built on, the form's type and table. */
interface Pass {
  type: number;
  /** The form's table (SaveOptions.column asks by it). */
  entity: string;
  /** The changes the pass writes (the compare loop's todo). */
  todo: Change[];
  /** The pass's own fresh read (B): a cell not in it was added by someone else since (build). */
  read: FormDoc;
  o: SaveOptions;
}
/** What the first build of a pass posted on a column cell, by comp, for the check after the write (nothingElse). */
interface Posted {
  /** Language → text posted; null for no <labels> at all. */
  labels: Labels | null;
  /** The languages the pass's own changes post there: holds() checks those. */
  edits: Set<Lcid>;
}
/**
 * A form's documents for settle(), with what nothingElse needs: the pass, what its first build posted, and what that
 * build leaves of each changed column cell's labels of their own (SaveOptions.forms).
 */
type FormOps = DocOps<FormDoc, string> & { sparse: boolean; pass: Pass; posted: Map<string, Posted>; owns: Map<string, CellOwn> };
/** A label a write left out that read back changed (unkept): its cell's comp, its language, its text right before the write (`t`) and right after it (`v`, undefined for none). */
interface Lost {
  comp: string;
  l: Lcid;
  t: string;
  v: string | undefined;
}

/**
 * The safety check of a write to a sparse form (LIVE-FINDINGS 104), three parts, before anything is sent: the document
 * is the read outside the labels of column cells and outside `pairs` (the other elements' edited labels, as everywhere);
 * each column cell carries exactly the labels planned for it (`expect`, by element of `after`; null: no <labels>
 * element), language by language; and every text posted on a column cell is one its inputs give (`may`), worked out apart
 * from the plan. Throws "Safety check failed: …".
 */
export function assertSent(
  before: Document,
  after: Document,
  type: number,
  dash: boolean,
  pairs: (el: Element) => boolean,
  expect: Map<Element, Labels | null>,
  may: (el: Element, l: Lcid, t: string) => boolean,
): void {
  const cells = (d: Document) => new Set(collect(d, dash).filter((it) => sparseCell(it, type)).map((it) => it.el));
  const was = cells(before);
  const now = cells(after);
  const unsafe = (why: string, el: Element) => {
    console.warn('[translator] safety check:', why, el.getAttribute('id'), readLabels(el, ...LAB));
    throw new Error(UNSAFE);
  };
  // (A) Outside the column cells' labels (a <labels> left out leaves out its <label>s too), the read.
  const cellLabels = (el: Element) => el.tagName === 'labels' && (was.has(el.parentElement as Element) || now.has(el.parentElement as Element));
  assertOnlyChanged(before, after, (el) => cellLabels(el) || pairs(el));
  // (B) Each column cell as planned: its labels in one <labels>, language by language, none twice.
  for (const el of now) if (!expect.has(el)) unsafe('a column cell nothing was planned for', el);
  for (const [el, w] of expect) {
    const [box, ...more] = kids(el, 'labels');
    const got = readLabels(el, ...LAB);
    const n = box ? kids(box, 'label').length : 0;
    if (more.length || !box !== !w || JSON.stringify(got) !== JSON.stringify(w ?? {}) || n !== Object.keys(got).length) unsafe('a column cell carries other labels than planned', el);
  }
  // (C) Every text on a column cell is one this write was given.
  for (const el of now) {
    const box = kid(el, 'labels');
    for (const x of box ? kids(box, 'label') : [])
      if (!may(el, Number(x.getAttribute('languagecode')), x.getAttribute('description') ?? '')) unsafe('a column cell carries a text this write was not given', el);
  }
}

/**
 * The texts a write to a sparse form may post on a column cell (assertSent's `may`), from the write's inputs alone, never
 * from what its build plans: the text an edit of `todo` asks for there; and, as `base` holds it and none of the cell's
 * column's names (`names`, by datafieldname; any while they aren't loaded), their text of a pair of `theirs` (a repair's
 * clash, repair.ts) and a label of a cell the pass's own read (`read`) doesn't have (someone else added it): read, one of
 * those names is the column's name filled in (LIVE-FINDINGS 103), and posted it would be stored as the cell's own label
 * (104).
 */
export function postable(base: Document, read: Document, formId: string, todo: Change[], theirs: Change[], names: (attr: string) => Record<number, string[]> | undefined): (el: Element, l: Lcid, t: string) => boolean {
  const at = index(base, formId, false);
  const had = index(read, formId, false);
  const edits = new Map(todo.map((c) => [`${c.slot.comp}#${c.lcid}`, c.after] as const));
  const clash = new Set(theirs.map((c) => `${c.slot.comp}#${c.lcid}`));
  return (el, l, t) => {
    // A sparse form is never a dashboard: its cells are fields (index).
    const comp = `field|${formId}|${normId(el.getAttribute('id'))}`;
    if (edits.get(`${comp}#${l}`) === t) return true;
    const b = at.get(comp);
    const bt = b && labelsOf(b)[l];
    if (bt === undefined || bt !== t || names(datafield(b!))?.[l]?.includes(t)) return false;
    return clash.has(`${comp}#${l}`) || !had.has(comp);
  };
}

/**
 * A form's documents for settle(), in UI language `L` inside the writer's hold, for one language's pass. On a sparse form
 * (SPARSE) a write posts a column's cell only with what the pass changes there; `posted` keeps what its first build
 * posted on each, for the check after the write (nothingElse).
 */
function formOps(ctx: Ctx, h: LangHold, L: Lcid, formId: string, dash: boolean, pass: Pass): FormOps {
  const indexes = new WeakMap<FormDoc, Map<string, Item>>();
  const idx = (d: FormDoc) => indexes.get(d) ?? indexes.set(d, index(d.doc, formId, dash)).get(d)!;
  const labelIn = (d: FormDoc, c: Change) => {
    const it = idx(d).get(c.slot.comp);
    return it && labelsOf(it);
  };
  const sparse = SPARSE.has(pass.type) && !dash;
  /** A column's cell this pass posts only with what it changes there. */
  const own = (it: Item) => sparse && sparseCell(it, pass.type);
  const posted = new Map<string, Posted>();
  const owns = new Map<string, CellOwn>();
  /** The new label key the last build gave each cell freed of its own labels (Change.standIn.follow), by comp. */
  const moved = new Map<string, string>();
  const skips = new WeakMap<FormDoc, (el: Element) => boolean>();
  /**
   * For canon(): the labels a write of this pass leaves out (LIVE-FINDINGS 104): every column cell's, but the languages it
   * edits. Someone else's label there survives the write, so it is nothing to put back, and a column's name filled in
   * there (103, renamed meanwhile) is nobody's save.
   */
  const unsent = (d: FormDoc): ((el: Element) => boolean) => {
    if (!sparse) return () => false;
    const had = skips.get(d);
    if (had) return had;
    const cells = new Set(collect(d.doc, dash).filter(own).map((it) => it.el));
    /** Per cell, the languages this pass posts there. */
    const sent = new Map<Element, Set<Lcid>>();
    for (const c of pass.todo) {
      const el = idx(d).get(c.slot.comp)?.el;
      if (el && cells.has(el)) sent.set(el, new Set([...(sent.get(el) ?? []), c.lcid]));
    }
    const skip = (el: Element): boolean => {
      const up = el.parentElement;
      if (el.tagName === 'labels') return !!up && cells.has(up) && !sent.has(up);
      const cell = el.tagName === 'label' ? up?.parentElement : null;
      return !!cell && cells.has(cell) && !sent.get(cell)?.has(Number(el.getAttribute('languagecode')));
    };
    skips.set(d, skip);
    return skip;
  };
  return {
    noun: 'form',
    publish: true,
    gone: GONE,
    dropped: (c) =>
      clears(ctx, c) ? 'Dataverse did not remove this translation. Reload the form to see what is saved.' : 'Dataverse did not keep this label. Reload the form to see what is saved.',
    read: () => readForm(ctx, h, L, formId),
    build(base, todo, theirs = []) {
      const doc = parseXml(base.xml, 'form definition');
      const now = index(doc, formId, dash);
      /** What this write posts on each column cell it changes, language → text (worked out below, then posted). */
      const plan = new Map<Element, Map<Lcid, string>>();
      const want = (it: Item): Map<Lcid, string> => plan.get(it.el) ?? plan.set(it.el, new Map()).get(it.el)!;
      /**
       * The cells freed of their last label of their own (Change.standIn.follow, model.ts freesAll), by comp: each goes on
       * a new label key with no label on it (LIVE-FINDINGS 105), so that it follows its column in every language, as a
       * field just added to the form does; nothing is posted on it, so a rename this save makes can't be stored there.
       */
      const free = new Map<string, { el: Element; key: string }>();
      for (const c of todo) {
        const it = now.get(c.slot.comp);
        if (!it) throw new Error(GONE);
        if (own(it)) {
          if (!c.standIn?.follow) want(it).set(c.lcid, c.after);
          else if (!free.has(c.slot.comp)) {
            const id = it.el.getAttribute('id') ?? '';
            const g = crypto.randomUUID();
            free.set(c.slot.comp, { el: it.el, key: id.startsWith('{') ? `{${g}}` : g });
          }
          continue;
        }
        const [container, item, lcidAttr, textAttr] = shape(it);
        if (clears(ctx, c)) removeLabel(it.el, { container, item, lcidAttr, lcid: c.lcid });
        else upsertLabel(doc, it.el, { container, item, lcidAttr, textAttr, lcid: c.lcid, text: c.after });
      }
      const was = pairs(idx(base), todo);
      const is = pairs(now, todo);
      if (!sparse) {
        assertOnlyChanged(base.doc, doc, (el) => was(el) || is(el));
        return serializeXml(doc);
      }
      const read = idx(pass.read);
      /** A cell's comp, as index() keys it. */
      const compOf = (it: Item) => `${it.kind}|${formId}|${it.id}`;
      /** The names a cell's column goes by in this save (SaveOptions.column); undefined while they aren't loaded. */
      const namesOf = (it: Item) => pass.o.column?.(pass.entity, datafield(it))?.names;
      // A label someone else changed too (a repair's clash, repair.ts): their text, which our first PATCH overwrote on the
      // same key, goes back. Not on a cell someone else gave a new label key since our read (LIVE-FINDINGS 105): the cell
      // goes out with the labelid the probe has, so the labels under their key stand as they are. Nor a text that is one of
      // its column's names: that is the name a read fills in (103), changed by a rename landing between our read and the
      // probe, nobody's save, and posted it would be stored as the cell's own label (104).
      for (const c of theirs) {
        const it = now.get(c.slot.comp);
        if (!it || !own(it)) continue;
        const r = read.get(c.slot.comp);
        const t = labelsOf(it)[c.lcid];
        if (t && (!r || keyOf(r) === keyOf(it)) && !namesOf(it)?.[c.lcid]?.includes(t)) want(it).set(c.lcid, t);
      }
      // A cell someone else added since our read: our first PATCH erased it, so it goes back with its labels as `base` has
      // them, but for an empty one and a column's name filled in there (LIVE-FINDINGS 103), which posted would be stored as
      // a label of its own (104). With its column's names not loaded, as read.
      const cells = collect(doc, dash).filter(own);
      for (const it of cells) {
        if (plan.has(it.el) || read.has(compOf(it))) continue;
        const names = namesOf(it);
        for (const [k, t] of Object.entries(labelsOf(it))) if (t && !names?.[Number(k)]?.includes(t)) want(it).set(Number(k), t);
      }
      /**
       * Whether a text this write posts on a cell is the label's own once stored (CellOwn): a text other than its column's
       * names is; one worded as one of them only where its key holds a label (LIVE-FINDINGS 104), as the answers of which
       * labels are the form's own tell ('name', carryOwnLabels). Not known while the column's names aren't loaded, nor where
       * this save renames the column in that language: which name the key compares it with isn't known.
       */
      const ownOf = (it: Item, l: Lcid, t: string): true | 'name' | null => {
        const col = pass.o.column?.(pass.entity, datafield(it));
        if (!col) return null;
        if (!col.names[l]?.includes(t)) return true;
        return col.renamed.includes(l) ? null : 'name';
      };
      // What each column cell must carry, worked out before any is touched (every occurrence, duplicate ids included): what
      // this write posts there, else no <labels> at all (Dataverse keeps every label a PATCH leaves out, LIVE-FINDINGS 104).
      const expect = new Map<Element, Labels | null>();
      const first = base === pass.read;
      for (const it of cells) {
        const w = plan.get(it.el);
        expect.set(it.el, w?.size ? Object.fromEntries(w) : null);
        if (first && w?.size) owns.set(compOf(it), { key: keyOf(it), own: Object.fromEntries([...w].map(([l, t]) => [l, ownOf(it, l, t)])) });
      }
      const [container, item, lcidAttr, textAttr] = LAB;
      for (const [el, labels] of expect) {
        const box = kid(el, container);
        if (!labels) {
          if (box) el.removeChild(box);
          continue;
        }
        // Exactly the labels planned, one per language: the container is emptied first, as a language the read gives twice
        // or a label without a language (which readLabels passes over) would otherwise go out beside them, and the safety
        // check would refuse the write.
        if (box) while (box.firstChild) box.removeChild(box.firstChild);
        for (const [k, t] of Object.entries(labels)) upsertLabel(doc, el, { container, item, lcidAttr, textAttr, lcid: Number(k), text: t });
      }
      // The first build of a pass: what it posts on each column cell, for the check after the write (nothingElse).
      if (first) for (const [comp, it] of now) if (expect.has(it.el)) posted.set(comp, { labels: expect.get(it.el) ?? null, edits: new Set(todo.filter((c) => c.slot.comp === comp).map((c) => c.lcid)) });
      // The texts posted are checked against this write's inputs, worked out apart from the plan above (postable).
      const may = postable(base.doc, pass.read.doc, formId, todo, theirs, (df) => pass.o.column?.(pass.entity, df)?.names);
      // The freed cells' new keys are this write's own change of them: the read is checked as if it had them already.
      moved.clear();
      const swaps: Array<[Element, string | null, string]> = [];
      for (const [comp, { el, key }] of free) {
        el.setAttribute('labelid', key);
        moved.set(comp, normId(key));
        const b = idx(base).get(comp);
        if (b) swaps.push([b.el, b.el.getAttribute('labelid'), key]);
      }
      for (const [el, , key] of swaps) el.setAttribute('labelid', key);
      try {
        assertSent(base.doc, doc, pass.type, dash, (el) => was(el) || is(el), expect, may);
      } finally {
        for (const [el, old] of swaps) {
          if (old === null) el.removeAttribute('labelid');
          else el.setAttribute('labelid', old);
        }
      }
      return serializeXml(doc);
    },
    async send(xml, fresh) {
      const b = await h.batch(L, writeParts(formId, xml, fresh.etag));
      const [vb, pr, vr] = b.results;
      if (!pr.ok) throw partError(pr);
      const sent = { probe: formOf(b, vb, fresh.etag), back: formOf(b, vr, fresh.etag) };
      saw(ctx, formId, sent.probe?.ver);
      saw(ctx, formId, sent.back?.ver);
      return sent;
    },
    same: (a, b) => a.xml === b.xml || canon(a.doc.documentElement, unsent(a)) === canon(b.doc.documentElement, unsent(b)),
    older: (a, b) => olderVersion(a.ver, b.ver),
    alike: (a, b, todo) => {
      const [ua, ub, pa, pb] = [unsent(a), unsent(b), pairs(idx(a), todo), pairs(idx(b), todo)];
      return canon(a.doc.documentElement, (el) => ua(el) || pa(el)) === canon(b.doc.documentElement, (el) => ub(el) || pb(el));
    },
    state: (d, c) => {
      const it = idx(d).get(c.slot.comp);
      if (!it) return null;
      const t = labelsOf(it)[c.lcid];
      // This run's own rename of the column under an edit (Change.alsoBefore) shows there as the new name, filled in
      // (LIVE-FINDINGS 103): the label as it was, nobody's change.
      return JSON.stringify((t !== undefined && t === c.alsoBefore ? c.before : t) ?? null);
    },
    text: (d, c) => labelIn(d, c)?.[c.lcid] ?? '',
    // A removed translation must be gone, not merely blank. A label freed of its own text is on the new key its write gave
    // its cell: its text reads as the column's name either way.
    holds: (d, c) => {
      const key = c.standIn?.follow ? moved.get(c.slot.comp) : undefined;
      if (key !== undefined) {
        const it = idx(d).get(c.slot.comp);
        return !!it && keyOf(it) === key;
      }
      const l = labelIn(d, c);
      return !!l && (clears(ctx, c) ? !(c.lcid in l) : (l[c.lcid] ?? '') === c.after);
    },
    sparse,
    pass,
    posted,
    owns,
  };
}

/**
 * One read-modify-write of a form in UI language `L`, inside the writer's LangSession hold: a batch reading the
 * unpublished XML (fresh, never what was loaded) and the published etag, the conflict check, then a batch with the
 * whole unpublished form (the probe), the PATCH and its read-back. In the user's own language the batches only probe
 * the language; in another one they switch to it and back around the parts. Throws Unrun when the write was turned
 * away unrun. A read older than a version of the form this page saw (NEWEST: one that lags, LIVE-FINDINGS 66) is read
 * again, and still behind after the waits nothing is written from it. A probe that is not the form just read means someone
 * else saved it in between and this PATCH replaced their definition (nothing guards the unpublished one, LIVE-FINDINGS 22,
 * 47): settle() puts it back. On a sparse form, the labels the PATCH left out are then checked (nothingElse). What the
 * save's first write of the form started from, and what each write leaves of its column cells' labels of their own, go
 * to SaveOptions.forms.
 */
async function writePass(ctx: Ctx, h: LangHold, L: Lcid, s0: Slot, cs: Change[], o: SaveOptions, retry: boolean): Promise<ChangeResult[]> {
  const { formId } = s0.ref;
  const type = Number(s0.ref.formType);
  const dash = isDash(type);
  const target = () => (dash ? o.publish.dashboards.add(formId) : o.publish.entities.add(s0.entity));
  const read = () => h.batch(L, readParts(formId), o.signal);
  /** The read shows an older version of the form than one this page's writer already saw (NEWEST): it lags. */
  const behind = (b: LangBatch) => b.inLang && b.results[0].ok && lagging(ctx, formId, b.results[0].data?.versionnumber);
  let rb = await read();
  // A read older than a version of the form this page saw, its own write above all (the pass before this one, a save a
  // moment ago), lags behind it (LIVE-FINDINGS 66): read again after 1, 2 and 4 s; still behind, nothing is written from
  // it, as a write from it would put back what that save changed.
  for (const ms of LAG_WAITS) {
    if (!behind(rb)) break;
    o.progress(`Waiting for Dataverse to show your last save of ${s0.path.slice(0, 2).join(' › ')}…`);
    await pause(ms, o.signal);
    rb = await read();
  }
  // Tab and section labels read in another language would be compared with, and written as, the wrong ones.
  if (!rb.inLang) throw notSaved(L);
  const [rr, pub] = rb.results;
  if (!rr.ok && rr.status !== 404) throw partError(rr);
  const r = rr.data;
  if (!r?.formxml) return cs.map((c) => res(c, 'error', 'This form no longer exists.'));
  // From a managed solution as read right before the write (one that slipped through as editable): never written, so
  // no unmanaged layer is ever put on it, unless this session allows changes to managed labels (Ctx.managedEdits).
  if (r.ismanaged === true && !ctx.managedEdits) return cs.map((c) => res(c, 'error', MANAGED));
  if (behind(rb)) return cs.map((c) => res(c, 'error', behindText('form')));
  saw(ctx, formId, r.versionnumber);
  const etag = etagOf(pub);
  // Never published (no published row), or changed since it was.
  const pending = !pub.ok || String(pub.data?.versionnumber ?? '') !== String(r.versionnumber ?? '');
  // What this save's first write of the form starts from (SaveOptions.forms): noted at each read until one is sent.
  let form = o.forms?.get(formId);
  if (o.forms && !form?.sent) o.forms.set(formId, (form = { pending, version: String(pub.data?.versionnumber ?? ''), sent: false, cells: new Map() }));
  const base: FormDoc = { xml: r.formxml, doc: parseXml(r.formxml, 'form definition'), etag, ver: r.versionnumber };
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
    const k = c.standIn?.follow ? freed(c, it, stored, o.force, (l) => o.column?.(s0.entity, datafield(it))?.names[l], form) : compare(c, stored, clears(ctx, c), o.force);
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
  const ops = formOps(ctx, h, L, formId, dash, { type, entity: s0.entity, todo: todo.map(([c]) => c), read: base, o });
  const xml = ops.build(base, ops.pass.todo);
  // Cancel stops before the write; once sent, the write and its check always finish (h.batch sends a batch
  // with writes without the signal).
  if (o.signal.aborted) throw abortError();
  const failed = (e: unknown) => [...out, ...todo.map(([c]) => res(c, 'error', errText(e)))];
  /** The PATCH ran or may have (SaveOptions.ran): a later run finding these labels as asked may be finding it. */
  const ran = () => {
    if (form) form.sent = true;
    todo.forEach(([c]) => o.ran?.add(changeId(c)));
  };
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
  // What this write leaves of the labels of their own of the column cells it changes (SaveOptions.forms).
  for (const [comp, c] of ops.owns) form?.cells.set(comp, c);
  const probe = formOf(wb, vb, etag);
  const back = formOf(wb, vr, etag);
  saw(ctx, formId, probe?.ver);
  saw(ctx, formId, back?.ver);
  const fixed = await settle(ops, base, ops.pass.todo, { probe, back });
  // Someone else's save landed while it wrote, or that can't be ruled out: the form is no longer this save's alone.
  if (fixed && form) form.pending = true;
  // The labels this PATCH left out, as the probe right before it had them (nothingElse), whatever settle() found: a repair
  // posts the same cells without labels, so a label Dataverse dropped shows here first. A probe older than the read lags
  // behind saves made since (LIVE-FINDINGS 66): written back, its labels would undo them, so none is checked.
  if (ops.sparse && probe && back && !ops.older(probe, base)) await nothingElse(ctx, h, L, s0, ops, probe, back, o);
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
 * The labels a write to a sparse form left out (on its column cells, every language but the ones it posts: `ops.posted`)
 * that read back otherwise than its probe had them, for the check after the write (nothingElse): `lost`, the ones a drop
 * explains, and `left`, the ones someone else may have saved over. Neither: a label left out in a language whose
 * filled-in name this save changes (a rename of its column, LIVE-FINDINGS 103), a text that is one of its column's names
 * (a name filled in, which a rename landing inside the batch changed), and the labels of a cell someone else gave a new
 * label key meanwhile (105).
 */
function unkept(ops: FormOps, probe: FormDoc, back: FormDoc, formId: string, dash: boolean): { lost: Lost[]; left: Lost[] } {
  const was = index(probe.doc, formId, dash);
  const now = index(back.doc, formId, dash);
  const lost: Lost[] = [];
  const left: Lost[] = [];
  for (const [comp, p] of ops.posted) {
    const a = was.get(comp);
    const b = now.get(comp);
    if (!a || !b || keyOf(a) !== keyOf(b)) continue;
    const col = ops.pass.o.column?.(ops.pass.entity, datafield(a));
    const got = labelsOf(b);
    for (const [k, t] of Object.entries(labelsOf(a))) {
      const l = Number(k);
      const v = got[l];
      const names = col?.names[l];
      if (!t || v === t || p.edits.has(l) || col?.renamed.includes(l) || names?.includes(t)) continue;
      // A label Dataverse dropped reads as its column's name (LIVE-FINDINGS 103), or as nothing where the column has none
      // there. Any other text may be someone else's save, or a name a rename of theirs just gave the column, and so may
      // any text while the column's names aren't loaded: said, never written over (written back, the probe's text would
      // undo their save, or store the column's old name as the cell's own label, 104).
      (v && !names?.includes(v) ? left : lost).push({ comp, l, t, v });
    }
  }
  return { lost, left };
}

/**
 * After a write to a sparse form: every label its PATCH left out must read back as the probe right before it had it
 * (LIVE-FINDINGS 104). One that doesn't, with nothing else to explain it, was dropped by Dataverse itself: its text is
 * written back at once, in a write of its own from a new read (settled like any other), and the save says so
 * (SaveOptions.warn). Never written back (unkept): a label in a language whose filled-in name this save changes (a rename
 * of its column, 103), a text that is one of its column's names (a name filled in, which a rename landing inside the batch
 * changed), a cell whose key someone else moved, and a text someone else saved there (it is not one of the column's
 * names; with the column's names not loaded no text can be told from theirs), which is said, as are the other lost labels
 * of its cell, every lost label of a cell where someone changed one after the read-back (before the write-back's read),
 * and a label that could not be put back. The write-back posts the pass's own changes of column cells again, and what it
 * leaves out is checked as the first write's labels were, but only said: nothing is written back twice.
 */
async function nothingElse(ctx: Ctx, h: LangHold, L: Lcid, s0: Slot, ops: FormOps, probe: FormDoc, back: FormDoc, o: SaveOptions): Promise<void> {
  const { formId } = s0.ref;
  const dash = isDash(Number(s0.ref.formType));
  const { lost, left } = unkept(ops, probe, back, formId, dash);
  if (!lost.length && !left.length) return;
  if (__DEV__) console.warn('[translator] labels this write did not send read back changed', lost, left);
  // The form's labels are no longer only what this save made of them (SaveOptions.forms).
  const f = o.forms?.get(formId);
  if (f) f.pending = true;
  /** The lost labels that are back. */
  const fixed = new Set<Lost>();
  /** What the write-back left out and its own batch read back changed: said, never written back again. */
  const later: Lost[] = [];
  /** settle() can't rule out that the write-back replaced a save someone else made at the same moment (RACE). */
  let raced = false;
  try {
    const F = await ops.read();
    const fi = index(F.doc, formId, dash);
    const now = index(back.doc, formId, dash);
    /** A lost label F no longer shows as the read-back did (its cell gone, its key moved, its text changed): someone's save since. */
    const since = (x: Lost) => {
      const it = fi.get(x.comp);
      return !it || keyOf(it) !== keyOf(now.get(x.comp)!) || labelsOf(it)[x.l] !== x.v;
    };
    // A cell with a text someone else may have saved (left), or with a lost label they changed since the read-back, gets
    // none of its lost labels written back, which are said instead: where Dataverse breaks the keep rule, as it just did,
    // a cell posted with some labels keeps nothing else, and their text would go. A read older than the write just made
    // (NEWEST: it lags, LIVE-FINDINGS 66) shows nothing to write back from: every lost label is said.
    const late = lagging(ctx, formId, F.ver);
    const theirs = new Set([...left, ...lost.filter((x) => late || since(x))].map((x) => x.comp));
    const puts: Change[] = [];
    const of = new Map<Change, Lost>();
    for (const x of lost) {
      if (theirs.has(x.comp)) continue;
      const c: Change = { slot: { ...s0, key: `${x.comp}|Label`, comp: x.comp, kind: 'field' }, lcid: x.l, before: x.v ?? '', after: x.t };
      puts.push(c);
      of.set(c, x);
    }
    if (puts.length) {
      // The pass's own changes of column cells go out again where F still shows them: left out of this write, they would
      // be as exposed to that break as the labels it puts back. Posted again as they are, they are stored as they are.
      const all = [...puts, ...ops.pass.todo.filter((c) => ops.posted.has(c.slot.comp) && ops.holds(F, c))];
      // Written as any pass is: its own probe shows a save landing before its PATCH, which settle() puts back.
      const w = formOps(ctx, h, L, formId, dash, { ...ops.pass, todo: all, read: F });
      const sent = await w.send(w.build(F, all), F);
      const got = await settle(w, F, all, sent);
      puts.forEach((c, i) => {
        // "Saved, but …": on the form, though this write may have replaced a save someone else made at the same moment.
        const m = got?.[i].message;
        const doubt = m === RACE.raced || m === RACE.unseen;
        raced ||= doubt;
        if (got ? got[i].outcome === 'saved' || doubt : !!sent.back && w.holds(sent.back, c)) fixed.add(of.get(c)!);
      });
      // What this write left out is checked as the first one's labels were, whatever settle() found, but only said: where
      // Dataverse breaks the keep rule each write may drop more, and nothing is written back twice.
      if (sent.probe && sent.back && !w.older(sent.probe, F)) {
        const again = unkept(w, sent.probe, sent.back, formId, dash);
        later.push(...again.lost, ...again.left);
      }
    }
  } catch {
    // Not written, or not known to be (a read or a write that failed, a safety check): nothing is back.
  }
  const form = formName(s0);
  if (fixed.size) o.warn?.(droppedBack(form, fixed.size, raced), raced ? 'warning' : 'notice');
  // Each label once, with its latest text: one the write-back left out and lost as it was right before the write-back.
  const not = new Map([...left, ...lost.filter((x) => !fixed.has(x)), ...later].map((x) => [`${x.comp}#${x.l}`, x] as const));
  if (not.size) o.warn?.(droppedLeft(form, [...not.values()].map((x) => ({ lang: lcidName(x.l), text: x.t }))), 'warning');
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

/**
 * The waits, never aborted, before Publish again's repair (rewrite) writes again a text it wrote back that Dataverse didn't
 * take (busy, a read lagging behind its write, a write refused or its answer lost): longer in all than publishXml's waits
 * for the customization lock, as each write waits for it only a little itself (writeLang, metadata.ts flow).
 */
const BACK_WAITS = [5000, 10000, 20000, 40000];
/**
 * The waits, never aborted, before the repair sends again a publish of its texts as they are where one served MARK, that
 * Dataverse turned away past publishXml's own waits for the customization lock, or that may not have got through (its
 * answer lost, a gateway or server error).
 */
const UNMARK_WAITS = [10000, 30000];

/**
 * Publish again's repair (Writer.again) of saved labels a publish didn't take (LIVE-FINDINGS 117, 118), with `write`, the
 * writer's save of a list of changes (given a signal, with it in place of the run's own): a publish takes neither those
 * labels nor the same texts written again, but takes a label whose text a write changes. So each label's text is written
 * with MARK after it (`marked`: that change of a saved one, by default made on the text saved), `publish` runs, the text is
 * written as it is, and `publish` runs again; in between the label reads with MARK, which no one sees. No MARK is left
 * where Dataverse lets the repair take it away, and none is ever left untold: once the first write may have stored one,
 * whatever it said (every result but a conflict and a change skipped, which wrote nothing: one that stored none finds the
 * text as it is), the text is written as it is with a signal that never aborts, also when the first publish fails or the
 * run is stopped, and again after each of BACK_WAITS, from a fresh read, while Dataverse doesn't take it; a label it never
 * takes is an error, which Publish again repairs. Where a publish served MARK, or may have, the texts as they are are
 * published with such a signal too (unmark: sent again after each of UNMARK_WAITS while Dataverse turns it away or it may
 * not have got through): when the publish after them is stopped (the stop, AbortError, is thrown after it), turned away or
 * not known to have got through, and when the first publish published all but the apps (PartialPublishError, thrown
 * after it; the apps fail again) or may have got through (no error once that publish does). Per label: the error of a
 * text written back that may still hold MARK; else the result of its last write, but for one whose first write was
 * neither saved nor found as asked: that one's, so what it said stays. `publish` runs once even where nothing was
 * written, as Publish again publishes.
 */
export async function rewrite(
  cs: Change[],
  publish: (signal?: AbortSignal) => Promise<void>,
  write: (list: Change[], signal?: AbortSignal) => Promise<ChangeResult[]>,
  marked = (c: Change): Change => ({ slot: c.slot, lcid: c.lcid, before: c.after, after: c.after + MARK }),
): Promise<ChangeResult[]> {
  const first = await write(cs.map(marked));
  /** The labels whose first write was saved or found as asked: MARK is on them. */
  const done = new Set(first.filter((r) => r.outcome === 'saved' || r.outcome === 'unchanged').map((r) => changeId(r.change)));
  /** The texts as they are, over the first writes that may have stored MARK, whatever they said: a conflict and a change skipped wrote nothing. */
  const tried = first.filter((r) => r.outcome !== 'conflict' && r.outcome !== 'skipped').map((r): Change => ({ ...r.change, before: r.change.after, after: unmarked(r.change.after) }));
  /** What takes MARK away again: no Stop ends it. */
  const never = new AbortController().signal;
  /**
   * Whether a text written back leaves no MARK: the text as it is is there (written, or found so), or someone else's text
   * replaced the marked one since (a conflict on another text than it: theirs, never written over).
   */
  const clean = (r: ChangeResult): boolean =>
    r.outcome === 'saved' || r.outcome === 'unchanged' || (r.outcome === 'conflict' && r.server !== undefined && r.server !== r.change.before);
  /**
   * Writes the texts as they are (`tried`), each one Dataverse didn't take again after each of BACK_WAITS. Per label, its
   * last result; one that may still hold MARK is an error.
   */
  const exact = async (): Promise<ChangeResult[]> => {
    const last = new Map<string, ChangeResult>();
    for (let todo = tried, i = 0; todo.length; i++) {
      const rs = await write(todo, never);
      for (const r of rs) last.set(changeId(r.change), r);
      todo = rs.filter((r) => !clean(r)).map((r) => r.change);
      if (!todo.length || i >= BACK_WAITS.length) break;
      await pause(BACK_WAITS[i], never);
    }
    return [...last.values()].map((r): ChangeResult => (clean(r) || r.outcome === 'error' ? r : { ...r, outcome: 'error' }));
  };
  /** Whether the texts as they are need a publish: a label was saved with MARK, or one written back wrote (or may have). */
  const wrote = (second: ChangeResult[]): boolean => done.size > 0 || second.some((r) => r.outcome === 'saved' || r.outcome === 'error');
  /** A publish worth sending again: one Dataverse turned away (the customization lock, throttling), or that may not have got through. */
  const again = (x: unknown): boolean => isLockError(x) || turnedAway(x) || mayHaveRun(x);
  /**
   * Publishes the texts as they are where a publish served MARK, or may have, no Stop ending it: sent again after each of
   * UNMARK_WAITS while Dataverse turns it away or it may not have got through. One that published all but the apps
   * published them: its PartialPublishError is returned (the apps fail again), else null.
   */
  const unmark = async (): Promise<PartialPublishError | null> => {
    for (let i = 0; ; i++)
      try {
        await publish(never);
        return null;
      } catch (x) {
        if (x instanceof PartialPublishError) return x;
        if (i >= UNMARK_WAITS.length || !again(x)) throw x;
        await pause(UNMARK_WAITS[i], never);
      }
  };
  /** Per label: the error of a text written back that may still hold MARK; else, for one MARK was saved on, its text written back's result; else its first write's. */
  const results = (second: ChangeResult[]): ChangeResult[] => {
    const firsts = new Map(first.map((r) => [changeId(r.change), r] as const));
    const backs = new Map(second.map((r) => [changeId(r.change), r] as const));
    return cs.map((c) => {
      const id = changeId(c);
      const b = backs.get(id);
      return { ...(b && (b.outcome === 'error' || done.has(id)) ? b : firsts.get(id)!), change: c };
    });
  };
  try {
    await publish();
  } catch (e) {
    // Not published (it failed, or was stopped before it ran): the texts are written as they are all the same, and its
    // error is thrown. One that published all but the apps served MARK, and one that may have got through (its answer
    // lost, a gateway or server error) may have: the texts as they are are published too (unmark). Once that publish
    // goes through after one that may have, every label is published as the repair publishes it: no error, but the apps'
    // where that publish leaves them out.
    const second = await exact();
    if (!wrote(second) || !(e instanceof PartialPublishError || mayHaveRun(e))) throw e;
    let apps: PartialPublishError | null;
    try {
      apps = await unmark();
    } catch {
      throw e;
    }
    if (e instanceof PartialPublishError) throw e;
    if (apps) throw apps;
    return results(second);
  }
  const second = await exact();
  if (wrote(second))
    try {
      await publish();
    } catch (e) {
      // Once the first publish served MARK: stopped, turned away past publishXml's waits, or not known to have got through,
      // the texts as they are are published all the same (unmark), then a stop is told.
      if (e instanceof PartialPublishError || !(isAbort(e) || again(e))) throw e;
      await unmark();
      if (isAbort(e)) throw e;
    }
  return results(second);
}

/**
 * Publish again's repair (Writer.again, LIVE-FINDINGS 117) of field labels the check after publishing found saved but
 * missing from the published form while its versions agree (ui/review.ts unpublishedForms): written again with MARK, then
 * as they are (rewrite). Each write is one of the user's language like a save's (writeLang, per form in the writer's hold:
 * a fresh read with the published etag, the conflict check, the probe and the read-back, settled and checked); `publish`
 * runs outside the hold (the caller's, under LangSession.quiet). A label that no longer shows the text saved is someone
 * else's save since, never written over (a conflict).
 */
function writeAgain(ctx: Ctx, cs: Change[], o: SaveOptions, publish: (signal?: AbortSignal) => Promise<void>): Promise<ChangeResult[]> {
  return rewrite(cs, publish, async (list, signal = o.signal) => {
    const so = signal === o.signal ? o : { ...o, signal };
    const forms = new Map<string, Change[]>();
    for (const c of list) (forms.get(c.slot.group) ?? forms.set(c.slot.group, []).get(c.slot.group)!).push(c);
    const out: ChangeResult[] = [];
    for (const g of forms.values())
      try {
        out.push(...(await o.lang.hold((h) => writeLang(ctx, h, ctx.user, g[0].slot, g, so), signal)));
      } catch (e) {
        out.push(...g.map((c) => (isAbort(e) ? res(c, 'skipped', 'Cancelled before saving.') : res(c, 'error', errText(e)))));
      }
    return out;
  });
}

/** The language of the pass a change is written in: its own for a label kept per language (perLanguage), else the user's. */
const passOf = (ctx: Ctx, c: Change): Lcid => (perLanguage(c.slot) ? c.lcid : ctx.user);

export const formXmlWriter: Writer = {
  kinds: ['tab', 'section', 'field', 'navitem', 'dtab', 'dsection', 'dfield'],
  lane: 'xml',
  pass: (ctx, c) => String(passOf(ctx, c)),
  again: writeAgain,
  async read(ctx, changes, o) {
    // The loader reads the unpublished form as save() does, per-language labels of another language in that language.
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
    // Per-language labels (tabs, sections, cells of controls bound to no column) are written per language; the others
    // (cells bound to a column, sub-grids, navigation items: every language) ride along with the user's own
    // language, which goes first.
    const passes = new Map<Lcid, Change[]>([[ctx.user, []]]);
    for (const c of changes) {
      // Loaded from a managed form or dashboard and still read-only (Ctx.managedEdits): refused before any read or
      // language switch (writePass checks again).
      if (managedHeld(c.slot, ctx.managedEdits)) {
        out.push(res(c, 'error', managedReadOnly(c.slot, ctx.managedEdits)));
        continue;
      }
      // Tab, section and field labels live in per-language stores that a form update can add to or change
      // but not remove from (canClear; LIVE-FINDINGS 37). Refused here, before any language switch; the
      // form's other changes still save. Navigation item titles are removed with their element (finding 38).
      if (!canClear(c.slot) && clears(ctx, c)) {
        out.push(res(c, 'error', CANT_CLEAR_TEXT));
        continue;
      }
      const L = passOf(ctx, c);
      let a = passes.get(L);
      if (!a) passes.set(L, (a = []));
      a.push(c);
    }
    const left = [...passes].filter(([, cs]) => cs.length);
    if (!left.length) return out;
    const fail = (cs: Change[], e: unknown) => cs.map((c) => (isAbort(e) ? res(c, 'skipped', 'Cancelled before saving.') : res(c, 'error', errText(e))));
    // One hold for the whole form: no other language-sensitive work (a page load, another form) runs between
    // its passes, and each pass reads what the one before it wrote (every PATCH posts the whole form; on a main form a
    // column's cell only with what that pass changes, SPARSE).
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
