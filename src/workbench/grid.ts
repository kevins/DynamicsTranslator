// The workbook grid, laid out like the Easy Translator sheets: a row number, the sheet's key columns, Type,
// then one "<Language> Label" column per shown language (base first, then the target).
// Only the rows in view (plus overscan) exist in the DOM. They are pooled and positioned with translateY,
// and column widths are CSS variables, so resizing a column never touches the rows.
// Language cells edit in place (click, Enter, F2 or typing). Key and Type cells are text: Enter, F2,
// double-click or typing there edits the row's target-language cell, and copy takes them along, so a
// developer can paste ids into Excel. Nothing here writes to Dataverse: edits go to the store, and the
// review (app.saver) saves, verifies and publishes them.

import { isRtl, lcidName, lcidTag } from '../core/lcid';
import { canClear, noStandIn, PROP_NAMES, savedEmptyText, savesEmpty, savesEmptyText, standIn, standInSays, standInsSaid, standInText, type Lcid, type Slot, type StandInFrom, type TextOf } from '../core/model';
import { onlySpaces } from '../core/saver';
import type { CellStatus, Store } from '../core/store';
import { navKnown } from '../inspector/fallback';
import { standsIn } from '../inspector/status';
import { formNote } from '../providers/formxml';
import { h, icon, plural, put, rafThrottle } from '../ui/dom';
import { isRemoval, langName, notLoaded, WILL_REMOVE } from '../ui/editor';
import type { AppApi } from '../ui/types';
import { insertText, resetUndo, whenEmpty } from '../ui/undo';
import { active, btn, popover, type Pop } from '../ui/widgets';
import css from './grid.css';
import type { GridApi, GridOptions, KeyCol } from './types';

const RH = 52; // row height, matches .g-r / .g-c in grid.css
const HH = 36; // header height
const GW = 46; // row-number column
const OVER = 8;
/** Vertical padding of the cell editor (.g-ed in grid.css), the line height being 18px. */
const ED_PAD = 5;
/** Grid width (px) below which language columns are capped to the room next to the pinned columns. */
const COMPACT = 720;
const TYPE_W = 110;
const LANG_W = 260;
/** Room (px) a language column needs beside the pinned key columns; with less, only the row number stays pinned. */
const ROOM = 220;
/** How long a revealed cell shows its ring (.is-fl in grid.css fades it out over this second). */
const FLASH_MS = 1000;

/** Shown where an emptied translation will be removed on save; the editor's wording. */
export const REMOVED = WILL_REMOVE;
/**
 * Why a blank translation can't be saved (see blankEdit), in the saver's words (core/saver.ts check()): it is on the
 * server, Dataverse can't remove it and it has no stand-in (model.ts noStandIn says why), or only spaces were typed
 * where there is none.
 */
export const blockedWhy = (s: Slot, l: Lcid, base: Lcid, before: string, after: string, text: TextOf): string =>
  before !== '' ? noStandIn(s, l, standIn(s, l, base, before, after, text)) : onlySpaces(l, base);
/**
 * The tooltip of a cell (and of its open editor) whose emptied translation Dataverse can't remove is saved as its
 * stand-in (blankEdit 'standin'): "Becomes “Project site” when you save: Dataverse can't remove a translation here, so
 * French gets the English text."; one that is its text already (model.ts StandIn same), as the popup says it: "Already
 * the English text: Dataverse can't remove a translation here, so nothing changes."
 */
export const standInTip = (s: Slot, l: Lcid, base: Lcid, before: string, after: string, text: TextOf): string => {
  const x = standIn(s, l, base, before, after, text);
  if (!x?.text) return '';
  if (x.same) return standInSays(s, l, base, x);
  return `Becomes “${x.text.trim()}” when you save: ${standInText(s, l, base, x.from)} Was “${before}”.`;
};

/**
 * Shown on a cell whose language was not read (a form label whose language this load did not read, see
 * notLoaded in ui/editor; unreadTip says why when a read failed): its text is unknown, not empty, so it is neither
 * missing nor editable here (that could only end in a conflict, or hide a label nobody has seen). The language
 * switch needs no consent, so a new extraction reads it.
 */
export const UNREAD = 'Not loaded: form tab and section labels in other languages are read by switching your Dynamics language for a moment. Select Extract translations again to read them.';
/**
 * The tooltip of a cell whose language was not read: why its form's read failed in that language (the reason the
 * loader put on the slot, providers/formxml.ts ref.unread), with what reads it (Extract translations is always there;
 * the message bar offers Read again only until its next message); why no read can bring it (ref.unreadable); else
 * UNREAD. `button`: for the cell's notice that carries a Read again of its own (open), which it points to instead.
 */
export function unreadTip(s: Slot, l: Lcid, o: { button?: boolean } = {}): string {
  const why: unknown = s.ref?.unread?.[l];
  const never: unknown = s.ref?.unreadable;
  const sentence = (t: string) => t.trim().replace(/([^.!?])$/, '$1.');
  if (typeof why === 'string' && why) {
    const then = o.button ? 'Select Read again to try once more, or Extract translations again.' : 'Select Extract translations again to read it, or Read again where the message bar offers it.';
    return `Not loaded: this form could not be read in ${lcidName(l)}, even when tried again. ${sentence(why)} ${then}`;
  }
  if (typeof never === 'string' && never) return `Not loaded in ${lcidName(l)}. ${sentence(never)}`;
  return UNREAD;
}
/**
 * A Read again (GridOptions.readAgain) would bring this not-loaded cell: its form's read failed in that language, so
 * the read asks for it (formNote, as the Workbench's Read again gathers it). Not where no read can (ref.unreadable),
 * nor for a language the load was not asked to read: only a new extraction reads that.
 */
export const rereadable = (s: Slot, l: Lcid): boolean => !s.ref?.unreadable && !!formNote([s])?.langs.includes(l);

/**
 * The base language has text but `l` has none (pending edits included). A language not loaded is unknown, not
 * missing. Nor is a form label whose fallback stands for it there, as on the page's marks (inspector/status
 * standsIn): a form cell worded like its column shows the column's name, a related menu item worded like its
 * relationship's text shows that text (LIVE-FINDINGS 42, 80). A related menu item whose relationship's text isn't
 * loaded yet (workbench.ts navSources) is unknown, not missing: Fill missing would hide the text that shows.
 */
export const missing = (st: Store, s: Slot, l: Lcid, base: Lcid): boolean =>
  l !== base &&
  !s.readOnly &&
  !st.value(s.key, l).trim() &&
  !!st.value(s.key, base).trim() &&
  !notLoaded(s, l) &&
  // A description stored (or saved) empty on purpose is translated: its users see none (model.ts storedEmpty).
  !st.emptyOnPurpose(s.key, l, base) &&
  navKnown((k) => st.get(k), s) &&
  !standsIn(st, s, l, base);
/** Same text as the base language: probably never translated. */
export const sameAsBase = (st: Store, s: Slot, l: Lcid, base: Lcid): boolean => {
  const v = st.value(s.key, l);
  return l !== base && !!v && v === st.value(s.key, base);
};
/** A language of the slot ended in a save conflict or error. */
export const failed = (st: Store, s: Slot, langs: Lcid[]): boolean =>
  langs.some((l) => {
    const o = st.cellStatus(s.key, l)?.outcome;
    return o === 'conflict' || o === 'error';
  });
/** What saving a blank non-base translation does (blankEdit). */
export type Blank = '' | 'remove' | 'standin' | 'empty' | 'blocked';
/**
 * What saving `after` over the server text `before` does when it leaves a non-base translation blank (empty
 * or only spaces). Mirrors the saver's rules (core/saver.ts withStandIns and check()), so the grid, the bulk tools and
 * the inspector mark exactly what the review will write or block. `text` reads the other texts the stand-in is made of
 * (model.ts TextOf: the store's, pending edits included).
 * - 'remove': the translation on the server is removed; users of that language see the base text again.
 * - 'standin': Dataverse can't remove this kind of label (canClear), so it is saved as its stand-in (model.ts standIn:
 *   the text that language shows without a translation, the base text or a form cell's column name).
 * - 'empty': a metadata description, saved empty (model.ts savesEmpty), also only spaces where there is none: users of
 *   that language then see no tooltip or description there.
 * - 'blocked': refused: Dataverse can't remove it and it has no stand-in (an empty base text, its column's names not
 *   loaded), or only spaces were typed where there is none (stored, they would show a blank label, LIVE-FINDINGS 32).
 *   The user has to type a text instead.
 * - '': anything else; spaces where a removable translation never existed change nothing.
 */
export const blankEdit = (s: Slot, l: Lcid, base: Lcid, before: string, after: string, text: TextOf): Blank =>
  l === base || s.readOnly || after === before || after.trim()
    ? ''
    : savesEmpty(s, l, base)
      ? 'empty'
      : !canClear(s, l)
        ? standIn(s, l, base, before, after, text)?.text
          ? 'standin'
          : 'blocked'
        : isRemoval(base, l, before, after)
          ? 'remove'
          : '';
/**
 * The tooltip of a cell stored empty (Store.emptyOnPurpose), in the popup's words: "Saved empty: French users see no
 * tooltip."; with `was`, of a pending edit that empties it (blankEdit 'empty'), in the words of the stand-in's tooltip
 * (standInTip): "Saved empty when you save: French users then see no tooltip. Was “Tapez le nom.”."
 */
export const emptyTip = (s: Slot, l: Lcid, was?: string): string =>
  was === undefined ? savedEmptyText(s, lcidName(l)) : `${savesEmptyText(s, lcidName(l))} ${was ? `Was “${was}”.` : 'It was blank.'}`;
/** What a cell saved empty (or to be) shows, muted (data-to, see .is-em in grid.css): an intentionally empty translation. */
export const EMPTY = '(empty)';
/** The store's texts as a stand-in reads them (model.ts TextOf). */
export const textOf = (st: Store): TextOf => (k, l) => st.text(k, l);
/** blankEdit() for the pending edit of a cell ('' when the cell has none). */
export const clearing = (st: Store, s: Slot, l: Lcid, base: Lcid): Blank =>
  st.isEdited(s.key, l) ? blankEdit(s, l, base, st.original(s.key, l), st.value(s.key, l), textOf(st)) : '';
/** Some language of the slot was left blank where Dataverse can't save that (see blankEdit). */
export const blocked = (st: Store, s: Slot, base: Lcid): boolean => {
  const e = st.edits.get(s.key);
  if (e) for (const l of e.keys()) if (clearing(st, s, l, base) === 'blocked') return true;
  return false;
};
/**
 * The slot needs attention before it can be saved: a save conflict or error, or a blocked blank translation.
 * Runs for every row when counting and filtering, so the per-language status lookups are skipped while no
 * save status exists at all.
 */
export const problem = (st: Store, s: Slot, langs: Lcid[], base: Lcid): boolean => (st.status.size > 0 && failed(st, s, langs)) || blocked(st, s, base);

// ---- clipboard (Excel's tab-separated text) ----

/**
 * Parses tab-separated text the way Excel puts it on the clipboard: a cell that starts with a quote and whose
 * closing quote ends the cell may hold tabs, newlines and doubled quotes (""). Any other quote is literal text,
 * so `"Premium" plan` pasted from elsewhere keeps its quotes. One trailing line break (Excel adds it) is ignored.
 */
export function parseTsv(t: string): string[][] {
  t = t.replace(/\r\n?/g, '\n');
  if (t.endsWith('\n')) t = t.slice(0, -1);
  const out: string[][] = [];
  const n = t.length;
  let row: string[] = [];
  for (let i = 0; ; ) {
    let v = '';
    let end = -1;
    if (t[i] === '"') {
      let j = i + 1;
      let q = '';
      while (j < n) {
        if (t[j] !== '"') q += t[j++];
        else if (t[j + 1] === '"') (q += '"'), (j += 2);
        else break;
      }
      // Quoted only when the closing quote ends the cell; otherwise the quote is part of the text.
      if (j < n && (j + 1 === n || t[j + 1] === '\t' || t[j + 1] === '\n')) (v = q), (end = j + 1);
    }
    if (end < 0) {
      end = i;
      while (end < n && t[end] !== '\t' && t[end] !== '\n') end++;
      v = t.slice(i, end);
    }
    row.push(v);
    if (end >= n) break;
    if (t[end] === '\n') out.push(row), (row = []);
    i = end + 1;
  }
  out.push(row);
  return out;
}
/** One cell for the clipboard: quoted when it holds a tab, a line break, or starts with a quote (so parseTsv and Excel read it back as it is). */
export const tsvCell = (v: string): string => (/[\t\n\r]/.test(v) || v.startsWith('"') ? `"${v.replace(/"/g, '""')}"` : v);
/** Rows of cells as Excel-compatible tab-separated text; several rows end with a line break, as Excel's do. */
export const toTsv = (rows: string[][]): string => rows.map((r) => r.map(tsvCell).join('\t')).join('\r\n') + (rows.length > 1 ? '\r\n' : '');
/**
 * Whether clipboard text that parses to several cells (`d`) was copied from a spreadsheet: it has columns, it
 * comes with an HTML table (Excel, Excel Online, Google Sheets, LibreOffice), or it is what this grid copied
 * last (`own`). Several lines of text from a document or a plain-text file do not, even with a trailing line
 * break (Word adds one after a paragraph), and belong in the one cell being edited, never on the rows below.
 */
export const fromSheet = (d: string[][], html: string, own = false): boolean => d.some((r) => r.length > 1) || /<table/i.test(html) || (own && d.length > 1);
/** Same clipboard text, whatever line breaks the system put in. */
export const sameClip = (a: string, b: string): boolean => !!a && a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n');
/**
 * Text pasted into an open cell editor when it is a single cell (`d` = parseTsv(t)): a spreadsheet's cell
 * (`sheet`: HTML table or this grid's own copy) loses its quoting and the line break Excel adds; any other text
 * is kept as it is but for one trailing line break, so a label quoted in a document ("Beta") keeps its quotes.
 */
export const oneCell = (t: string, d: string[][], sheet: boolean): string => (sheet ? d[0][0] : t.replace(/(\r\n?|\n)$/, ''));

/** Rows and columns a pasted block spans up to its last cell with text (blank rows and columns after it don't count). */
export function extent(d: string[][]): [number, number] {
  let h = 0,
    w = 0;
  d.forEach((r, i) =>
    r.forEach((v, j) => {
      if (v.trim()) (h = Math.max(h, i + 1)), (w = Math.max(w, j + 1));
    }),
  );
  return [h, w];
}
/**
 * The first cell of a pasted block's first row that is a column header (`isHead(j, v)` for the grid column j
 * it would land on), as [grid column, text]; null when there is none. Pasting a copied header row would put
 * "French Label" into the first row and every translation one row too low.
 */
export function headerCell(d: string[][], c0: number, nCols: number, isHead: (j: number, v: string) => boolean): [number, string] | null {
  const r = d[0] || [];
  for (let k = 0; k < r.length && c0 + k < nCols; k++) {
    const v = r[k].trim();
    if (v && isHead(c0 + k, v)) return [c0 + k, v];
  }
  return null;
}
/** Key-cell text compared for a paste: case, spaces and GUID braces ({…}, as in Easy Translator files) don't matter. */
export const keyNorm = (v: string): string => v.trim().replace(/^\{([^{}]*)\}$/, '$1').toLowerCase();

/**
 * A pasted block whose key or Type cells disagree with the rows it would land on: the first such cell, or
 * null. Pasting rows sorted differently (or from another sheet) would put translations on the wrong labels,
 * so the grid refuses such a paste. Blank pasted cells are not compared.
 */
export function keyMismatch(
  d: string[][],
  r0: number,
  c0: number,
  r1: number,
  c1: number,
  isKey: (j: number) => boolean,
  same: (i: number, j: number, pasted: string) => boolean,
): { i: number; j: number; v: string } | null {
  for (let i = r0; i <= r1; i++)
    for (let j = c0; j <= c1; j++) {
      if (!isKey(j)) continue;
      const v = (d[i - r0]?.[j - c0] ?? '').trim();
      if (v && !same(i, j, v)) return { i, j, v };
    }
  return null;
}

// ---- columns ----

/** A grid column: one of the sheet's key columns, Type, or a language. */
export interface Col {
  /** The key column's id, 'type', or 'l<lcid>'. */
  id: string;
  /** Key of the remembered width: `${sheet}:${id}` for key columns and Type, `l<lcid>` for languages (shared by every sheet). */
  wk: string;
  name: string;
  /** Default width. */
  def: number;
  /** Current width (remembered, else the default). */
  w: number;
  /** Narrowest width when resizing. */
  min: number;
  /** Language of the column; 0 for key columns and Type. */
  l: Lcid;
  key?: KeyCol;
  mono: boolean;
  keep: boolean;
}

/** Shown languages in column order: base, target, then the others in their given order. */
export const orderLangs = (langs: Lcid[], base: Lcid, target: Lcid): Lcid[] => [...new Set([base, target, ...langs])].filter((l) => langs.includes(l));

/** Columns of a sheet after the row number: its key columns, Type, then the languages ("French Label"). */
export function buildCols(sheetId: string, keys: KeyCol[], langs: Lcid[], base: Lcid, target: Lcid, name: (l: Lcid) => string): Col[] {
  return [
    ...keys.map((k): Col => ({ id: k.id, wk: `${sheetId}:${k.id}`, name: k.name, def: k.w, w: k.w, min: 60, l: 0, key: k, mono: !!k.mono, keep: !!k.keep })),
    { id: 'type', wk: `${sheetId}:type`, name: 'Type', def: TYPE_W, w: TYPE_W, min: 60, l: 0, mono: false, keep: false },
    ...orderLangs(langs, base, target).map((l): Col => ({ id: 'l' + l, wk: 'l' + l, name: `${name(l)} Label`, def: LANG_W, w: LANG_W, min: 140, l, mono: false, keep: false })),
  ];
}

/** Tooltip of a Type cell: the property's name, plus where Dynamics shows it when that answers a common question. */
export function typeTip(s: Slot): string {
  const p = PROP_NAMES[s.prop] || s.prop;
  const k = s.kind;
  let help = '';
  if (k === 'attribute' && s.prop === 'Description') help = "Shown as the field's tooltip on forms (the text you see when you hover over a field label).";
  else if (k === 'attribute' && s.prop === 'DisplayName') help = "The column's name: list column headers, Advanced Find, and form labels unless the form overrides them (see Forms Fields).";
  else if (k === 'field' && s.prop === 'Label')
    help = 'The label of this field on this form only. The same column can be on a form several times (header, tabs, quick view); each copy is its own row (Control Id).';
  else if ((k === 'option' || k === 'status' || k === 'state' || k === 'boolean' || k === 'globaloption') && s.prop === 'Label') help = 'Labels of choice values. These are what list cells show for a choice column.';
  if (k === 'field' && /label hidden/i.test(s.sub)) help += (help ? ' ' : '') + 'This label is hidden on the form.';
  return help ? `${p}. ${help}` : p;
}

// ---- cell and row states ----

const quote = (v: string | undefined) => (v === undefined ? 'unknown' : v.trim() ? `“${v}”` : 'blank');

/**
 * The text each saved cell held on the server right after its save (Store.commit records `{outcome:'saved'}`
 * without it), so the check mark goes as soon as a later extraction brings another text (someone else changed
 * it). Filled by noteSaved() on every save; a status that carries `server` itself does not need it.
 */
const savedText = new WeakMap<CellStatus, string>();
/** Records the server text of every saved cell not seen yet; call right after Store.commit (the grid does, on its events). */
export function noteSaved(st: Store): void {
  for (const [k, cs] of st.status) {
    if (cs.outcome !== 'saved' || cs.server !== undefined || savedText.has(cs)) continue;
    const i = k.lastIndexOf('#');
    savedText.set(cs, st.original(k.slice(0, i), Number(k.slice(i + 1))));
  }
}

/** Tooltip of a cell with a pending edit, and of the cell editor once its text differs: the text it replaces. */
export const changedTip = (orig: string): string => `Changed, not saved yet. ${orig ? `Was “${orig}”.` : 'It was blank.'}`;

/** Look of a language cell: state classes (is-*), tooltip, the old text of a pending removal, the text of a stand-in. */
export interface CellLook {
  cls: string;
  tip: string;
  was: string;
  /** What an emptied translation Dataverse can't remove is saved as (blankEdit 'standin'), shown muted in the cell. */
  to: string;
}
/**
 * The state of a language cell (§3.3 of the design): read-only, conflict, save error, not loaded, a blank
 * Dataverse refuses, a pending removal, a pending edit, saved and verified, missing. Pure (store reads only).
 */
export function langCell(st: Store, s: Slot, l: Lcid, base: Lcid): CellLook {
  const v = st.value(s.key, l);
  const orig = st.original(s.key, l);
  const ed = st.isEdited(s.key, l);
  const cs: CellStatus | undefined = st.cellStatus(s.key, l);
  // Unknown text (see UNREAD); a pending edit there still shows, so it can be reviewed or reverted.
  const nl = notLoaded(s, l) && !ed;
  const clr = clearing(st, s, l, base);
  let cls = '';
  let tip = '';
  let was = '';
  let to = '';
  // A cell that turned read-only after it was edited (a later extraction found it locked): its change can't be
  // saved. Rows › Pending changes and the review dialog list it too.
  if (s.readOnly) (cls = ' is-ro'), (tip = ed ? `Changed, but this label is read-only now (${s.readOnly.replace(/[.\s]+$/, '')}), so the change can't be saved. Undo it or discard it in Review & save.` : s.readOnly);
  else if (cs?.outcome === 'conflict')
    (cls = ' is-cf'),
      (tip = `Changed on the server by someone else since you loaded it. Server: ${quote(cs.server)}.${ed ? ` Yours: ${quote(v)}.` : ''} Click the cell or press Enter to choose which to keep.`);
  else if (cs?.outcome === 'error') (cls = ' is-er'), (tip = (cs.message || 'Not saved.') + (cs.server !== undefined ? ` Value on the server: ${quote(cs.server)}.` : ''));
  else if (nl) (cls = ' is-ro is-nl'), (tip = unreadTip(s, l));
  // is-sp: only spaces where there is no translation, which needs its own in-cell hint.
  else if (clr === 'blocked') (cls = orig ? ' is-er is-nc' : ' is-er is-nc is-sp'), (tip = blockedWhy(s, l, base, orig, v, textOf(st)));
  else if (clr === 'standin') {
    // Dataverse can't remove it: saved as its stand-in, which the cell shows muted (data-to, see .is-si in grid.css).
    cls = ' is-ed is-si';
    to = standIn(s, l, base, orig, v, textOf(st))?.text.trim() ?? '';
    tip = standInTip(s, l, base, orig, v, textOf(st));
  } else if (clr === 'empty') {
    // A metadata description emptied: saved empty, shown as an intentionally empty translation (see .is-em in grid.css).
    cls = ' is-ed is-em';
    to = EMPTY;
    tip = (cs?.message ? `Not saved: ${cs.message.replace(/[.!?]?$/, '.')} ` : '') + emptyTip(s, l, orig);
  } else if (clr === 'remove') {
    // The old text shows struck through in the cell (data-was, see .is-rm in grid.css).
    cls = ' is-ed is-rm';
    was = orig;
    const bv = st.value(s.key, base).trim();
    tip = `Will be removed when you save (was “${orig}”). Users of ${lcidName(l)} will then see ${bv ? `the ${lcidName(base)} text` : `no text (the ${lcidName(base)} text is empty too)`}.`;
  } else if (ed)
    // A skipped change (e.g. a stopped save) says why next to the usual text.
    (cls = ' is-ed'), (tip = (cs?.message ? `Not saved: ${cs.message.replace(/[.!?]?$/, '.')} ` : '') + changedTip(orig));
  // The check only stays while the server still holds the saved text (a later extraction may bring someone
  // else's change): the text the status carries, else the one noteSaved() recorded right after the save.
  else if (cs?.outcome === 'saved') {
    const at = cs.server ?? savedText.get(cs);
    if (at === undefined || at === orig) (cls = ' is-sv'), (tip = 'Saved and verified on the server.');
  }
  // A description stored empty on purpose (model.ts storedEmpty) is translated: muted "(empty)" (saved just now: with
  // the check), never missing.
  if (!s.readOnly && !ed && !nl && cs?.outcome !== 'conflict' && cs?.outcome !== 'error' && st.emptyOnPurpose(s.key, l, base)) (cls += ' is-em'), (to = EMPTY), (tip ||= emptyTip(s, l));
  // An emptied translation is not "missing" (it was there): it is either a removal or an error.
  if (!clr && !nl && cs?.outcome !== 'conflict' && missing(st, s, l, base)) (cls += ' is-mi'), (tip ||= `Missing in ${lcidName(l)}.`);
  // Two lines show; the rest is in the tooltip.
  if (!tip && v.length > 60) tip = v;
  return { cls, tip, was, to };
}

/**
 * The open cell editor's look while typing: the look its cell will have once the text is committed (commit() and
 * langCell), so the cell turns green at the first character instead of after Enter. ' is-ed' when the text differs
 * from the server text; ' is-nc' where the commit refuses it (a required base text left blank) or Dataverse would
 * (blankEdit 'blocked'); ' is-over' past the slot's maximum. An emptied translation saved as its stand-in (blankEdit
 * 'standin') is green and says what it becomes; one saved empty (blankEdit 'empty'), that it is. `now`: the cell's
 * value when the editor opened. `text`: the store's texts (textOf). `cs`: the cell's status, which committing its text
 * unchanged keeps: red with its error, a skipped change's reason.
 */
export function edLook(s: Slot | undefined, l: Lcid, base: Lcid, server: string, now: string, v: string, baseName: string, text: TextOf, cs?: CellStatus): { cls: string; tip: string } {
  const max = s?.max ?? 0,
    over = max > 0 && v.length > max,
    clr = s ? blankEdit(s, l, base, server, v, text) : '',
    req = l === base && !!s?.baseRequired && !v.trim() && v !== now,
    same = v === now;
  if (same && cs?.outcome === 'error')
    return { cls: (over ? ' is-over' : '') + ' is-nc', tip: (cs.message || 'Not saved.') + (cs.server !== undefined ? ` Value on the server: ${quote(cs.server)}.` : '') };
  const skipped = same && cs?.message ? `Not saved: ${cs.message.replace(/[.!?]?$/, '.')} ` : '';
  return {
    cls: (over ? ' is-over' : '') + (clr === 'blocked' || req ? ' is-nc' : v !== server ? ' is-ed' : ''),
    tip: over
      ? `Too long: ${v.length} of ${max} characters`
      : s && clr === 'blocked'
        ? blockedWhy(s, l, base, server, v, text)
        : req
          ? `The ${baseName} label can't be blank.`
          : clr === 'remove'
            ? REMOVED
            : s && clr === 'standin'
              ? standInTip(s, l, base, server, v, text)
              : s && clr === 'empty'
                ? skipped + emptyTip(s, l, server)
                : v !== server
                  ? skipped + changedTip(server)
                  : '',
  };
}

/** State of a row's number cell: read-only (lock), a problem (red), a pending edit (green bar), or none. */
export function rowState(st: Store, s: Slot, langs: Lcid[], base: Lcid): ['' | 'ro' | 'er' | 'ed', string] {
  if (s.readOnly) return ['ro', s.readOnly];
  if (st.status.size > 0 && failed(st, s, langs)) return ['er', 'Not saved: a conflict or an error. The marked cell says why.'];
  if (blocked(st, s, base)) return ['er', "Dataverse can't save a translation you left blank in this row — type the text instead."];
  if (st.isEdited(s.key)) return ['ed', 'Changed, not saved yet'];
  return ['', ''];
}

type Cell = HTMLDivElement & { j: number; v: HTMLSpanElement; k?: string; t?: string };
type Gut = HTMLDivElement & { k?: string };
type Row = HTMLDivElement & { i: number; g: Gut; n: HTMLSpanElement; cs: Cell[] };
type Range = [number, number, number, number];
/** The selection when a clipboard shortcut was pressed: its range, the rows (keys) and columns (ids) it covered. */
type Snap = { at: Range; keys: string[]; ids: string[]; sheet: string; gen: number };

const cut = (v: string, n = 60) => (v.length > n ? v.slice(0, n - 1) + '…' : v);

export function createGrid(app: AppApi, o: GridOptions): GridApi {
  app.adoptStyles(css);
  const { store } = app,
    base = app.ctx.base,
    all = app.ctx.langs.map((x) => x.lcid),
    undo = { label: 'Undo', run: () => store.undo() };
  let rows: Slot[] = [],
    cols: Col[] = [],
    sheet = '',
    typeText: (s: Slot) => string = (s) => s.prop,
    target = base,
    pool: Row[] = [],
    ar = 0, // active (cursor) cell
    ac = 0,
    br = 0, // anchor of the range
    bc = 0,
    drag = false,
    moved = false,
    x0 = 0,
    y0 = 0,
    down: [number, number] | null = null, // the cell a click started on (click-to-edit)
    edKey = '',
    edL = 0,
    edStart = '',
    // The cell's text when the editor opened, and the server text it was measured against (see commit()).
    edFrom = '',
    edBase = '',
    clip = 0,
    // Key columns marked `keep` stay in view while scrolling sideways, when there is room for a language beside them.
    pinOn = true,
    narrow = false,
    lastW = 0,
    // The active cell could not be scrolled into view while the grid was hidden.
    owed = false,
    flash: { key: string; j: number } | null = null,
    flT: ReturnType<typeof setTimeout> | undefined,
    cf: Pop | null = null,
    // What this grid last put on the clipboard: pasted into a cell editor, it goes to the grid like Excel's cells.
    copied = '',
    // Cells of that copy whose language was not loaded, as "row,column" within it: they came out blank (see paste()).
    unk = new Set<string>(),
    // Bumped by every move of the cursor or the selection and by new columns: a clipboard shortcut the browser answers
    // late (viaApi) changes cells only while it is unchanged.
    gen = 0;
  const live = new Map<number, Row>();
  // Saved cells keep their check mark only while the server holds what was saved (see noteSaved): record it
  // at every save, before anything can reload the slots.
  noteSaved(store);
  const offStore = store.on((e) => {
    if (e.type === 'edits' || e.type === 'status') noteSaved(store);
  });
  const head = h('div', { class: 'g-h', role: 'row', 'aria-rowindex': 1 });
  const body = h('div', { class: 'g-b' });
  const sc = h('div', { class: 'g-s' }, head, body);
  const el = h('div', { class: 'g', tabIndex: 0, role: 'grid', 'aria-label': 'Translations', 'aria-multiselectable': 'true' }, sc);
  let actEl: Element | undefined;
  const ed = h('textarea', { class: 'g-ed', rows: 1, spellcheck: true, 'aria-label': 'Cell text' });

  const focus = () => el.focus({ preventScroll: true });
  const rng = (): Range => [Math.min(ar, br), Math.min(ac, bc), Math.max(ar, br), Math.max(ac, bc)];
  const pinned = (j: number) => pinOn && !!cols[j]?.keep;
  const xOf = (j: number) => cols.slice(0, j).reduce((x, c) => x + c.w, GW);
  /** Width covered on the left by the row number and the pinned columns before column j. */
  const cover = (j: number) => cols.slice(0, j).reduce((x, c, k) => x + (pinned(k) ? c.w : 0), GW);
  const pos = (j: number) => ({ width: `var(--w${j})`, left: pinned(j) ? `var(--x${j})` : '' });
  /** A key column's text; a getter that does not fit the slot (rows of another sheet for a moment) shows nothing. */
  const keyText = (k: KeyCol, s: Slot) => {
    try {
      return String(k.get(s, o.ctx) ?? '');
    } catch {
      return '';
    }
  };
  const typeOf = (s: Slot) => {
    try {
      return String(typeText(s) ?? s.prop);
    } catch {
      return s.prop;
    }
  };
  /** What a cell shows (and copies). */
  const text = (s: Slot, j: number) => {
    const c = cols[j];
    return c.l ? store.value(s.key, c.l) : c.key ? keyText(c.key, s) : typeOf(s);
  };
  /** The column being translated: the target, else the first other language, else the base. -1 without languages. */
  const tcol = () => {
    let j = target !== base ? cols.findIndex((c) => c.l === target) : -1;
    if (j < 0) j = cols.findIndex((c) => c.l && c.l !== base);
    if (j < 0) j = cols.findIndex((c) => c.l);
    return j;
  };

  /** Column widths (remembered, else defaults), which key columns are pinned, and the narrow-grid caps. */
  const size = () => {
    const W = sc.clientWidth;
    if (W) narrow = W < COMPACT;
    for (const c of cols) c.w = o.widths[c.wk] || (narrow && c.id === 'type' ? 90 : c.def);
    let pw = GW;
    for (const c of cols) if (c.keep) pw += c.w;
    // 0 while hidden: keep the last decision until the grid is visible again.
    if (W) pinOn = pw > GW && W - pw >= ROOM && pw <= W * 0.6;
    // A narrow grid (docked window, small screens): a language column never gets wider than the room beside
    // the pinned columns, so the cell being translated (and its editor) is always fully in view.
    if (narrow && W) {
      const room = Math.max(160, W - (pinOn ? pw : GW) - 2);
      for (const c of cols) if (c.l && c.w > room) c.w = room;
    }
    // Room left over to the right goes to the language columns, as the old workbook's table filled its width.
    const langs = cols.filter((c) => c.l);
    const free = W - cols.reduce((x, c) => x + c.w, GW) - 1;
    if (W && free > 0 && langs.length) {
      const each = Math.floor(free / langs.length);
      langs.forEach((c, i) => (c.w += each + (i === langs.length - 1 ? free - each * langs.length : 0)));
    }
  };

  /** Moves the open cell editor over its cell (after a scroll-independent relayout). */
  const placeEd = () => {
    if (edKey && cols[ac]) Object.assign(ed.style, { left: xOf(ac) + 'px', top: ar * RH + 'px', width: cols[ac].w + 'px' });
  };

  const layout = () => {
    let x = GW,
      px = GW;
    cols.forEach((c, j) => {
      el.style.setProperty('--w' + j, c.w + 'px');
      if (pinned(j)) el.style.setProperty('--x' + j, px + 'px'), (px += c.w);
      x += c.w;
    });
    el.style.setProperty('--tw', x + 'px');
    placeEd();
  };

  const mkRow = (): Row => {
    const n = h('span');
    const r = h('div', { class: 'g-r', role: 'row' }) as Row;
    r.i = -1;
    r.n = n;
    r.g = h('div', { class: 'g-g', role: 'rowheader' }, icon('lock', 12), n) as Gut;
    r.cs = cols.map((c, j) => {
      const v = h('span', { class: 'g-v' });
      const x = h('div', { style: pos(j), role: 'gridcell', 'aria-colindex': j + 2, dir: isRtl(c.l) ? 'rtl' : null, lang: (c.l && lcidTag(c.l)) || null }, v) as Cell;
      x.j = j;
      x.v = v;
      return x;
    });
    r.append(r.g, ...r.cs);
    body.append(r);
    return r;
  };

  const headCell = (c: Col, j: number) => {
    const tg = !!c.l && c.l === target && target !== base;
    const x = h(
      'div',
      {
        class: 'g-hc' + (pinned(j) ? ' is-st' : '') + (tg ? ' is-tg' : ''),
        style: pos(j),
        role: 'columnheader',
        'aria-colindex': j + 2,
        title: c.l
          ? `${c.name} (${c.l})${c.l === base ? ', the base language' : tg ? ', the language you are translating into' : ''}. Click to select the column.`
          : c.key
            ? `${c.name}. Click to select the column.`
            : 'What the row holds, for example DisplayName or Description. Click to select the column.',
      },
      h('span', { class: 'g-hn' }, c.name),
      !!c.l && h('span', { class: 'g-hi' }, String(c.l)),
      h('span', { class: 'g-rs', 'aria-hidden': 'true', on: { pointerdown: (e) => resize(e, j) } }),
    ) as HTMLDivElement & { j: number };
    x.j = j;
    return x;
  };

  /** Header, pooled rows and widths for the current columns and layout. */
  const build = () => {
    size();
    for (const r of [...live.values(), ...pool]) r.remove();
    live.clear();
    pool = [];
    actEl = undefined;
    put(head, h('div', { class: 'g-g', role: 'columnheader', title: 'Row number. Click to select every row.' }, '#'), cols.map(headCell));
    layout();
    render(true);
  };

  const fill = (r: Row, i: number) => {
    const s = rows[i],
      [r0, c0, r1, c1] = rng(),
      multi = r0 !== r1 || c0 !== c1;
    if (r.i !== i) (r.i = i), (r.style.transform = `translateY(${i * RH}px)`), r.setAttribute('aria-rowindex', String(i + 2));
    const [g, gt] = rowState(store, s, all, base),
      gk = g + '\0' + gt + '\0' + i;
    if (r.g.k !== gk) {
      r.g.k = gk;
      r.g.className = 'g-g' + (g && ' is-' + g);
      r.g.title = gt;
      r.n.textContent = String(i + 1);
    }
    cols.forEach((c, j) => {
      const x = r.cs[j];
      let k = 'g-c',
        t: string,
        tip = '',
        was = '',
        to = '';
      if (c.l) {
        // The column being translated looks like the others; only its header title is marked (headCell).
        const lk = langCell(store, s, c.l, base);
        k += ' g-l' + lk.cls;
        t = store.value(s.key, c.l);
        tip = lk.tip;
        was = lk.was;
        to = lk.to;
      } else if (c.key) {
        t = keyText(c.key, s);
        k += ' g-k' + (c.mono ? ' g-m' : '') + (pinned(j) ? ' is-st' : '');
        // GUIDs are cut off by design (full value in the tooltip); long names may be too.
        if (t && (c.mono || t.length * 7 > c.w - 16)) tip = t;
      } else {
        t = typeOf(s);
        k += ' g-y';
        tip = typeTip(s);
      }
      if (multi && i >= r0 && i <= r1 && j >= c0 && j <= c1) k += ' is-sel';
      if (i === ar && j === ac) k += ' is-act';
      if (flash && flash.key === s.key && flash.j === j) k += ' is-fl';
      if (x.k !== k) x.className = x.k = k;
      const tt = t + '\0' + tip + '\0' + was + '\0' + to;
      if (x.t !== tt) {
        x.t = tt;
        x.title = tip;
        x.v.textContent = t;
        if (was) x.v.dataset.was = was;
        else delete x.v.dataset.was;
        if (to) x.v.dataset.to = to;
        else delete x.v.dataset.to;
      }
    });
  };

  const render = (full?: boolean) => {
    const top = sc.scrollTop,
      a = Math.max(0, Math.floor(top / RH) - OVER),
      b = Math.min(rows.length, Math.ceil((top + sc.clientHeight) / RH) + OVER);
    for (const [i, r] of live) if (i < a || i >= b) live.delete(i), (r.hidden = true), pool.push(r);
    for (let i = a; i < b; i++) {
      let r = live.get(i);
      if (r && !full) continue;
      if (!r) (r = pool.pop() || mkRow()), (r.hidden = false), live.set(i, r);
      fill(r, i);
    }
    // Screen readers follow the active cell through aria-activedescendant (cells are pooled, so the id moves).
    const cur = live.get(ar)?.cs[ac];
    if (cur !== actEl) {
      actEl?.removeAttribute('id');
      if (cur) cur.id = 'g-ac';
      actEl = cur;
      if (cur) el.setAttribute('aria-activedescendant', 'g-ac');
      else el.removeAttribute('aria-activedescendant');
    }
  };
  const closeCf = () => cf?.close();
  /** Scroll position when the conflict chooser opened (the scroll event of bringing its cell into view comes later). */
  let cfAt = '';
  const onScroll = rafThrottle(() => render());
  sc.addEventListener(
    'scroll',
    () => {
      if (cf && cfAt !== sc.scrollTop + ',' + sc.scrollLeft) closeCf(); // its cell moved away
      onScroll();
    },
    { passive: true },
  );
  const ro = new ResizeObserver(() => {
    const W = sc.clientWidth;
    if (W && cols.length && W !== lastW) {
      lastW = W;
      const was = pinOn;
      size();
      if (pinOn !== was) build();
      else layout();
    } else if (!W) lastW = 0;
    if (W && owed) (owed = false), rows.length ? show(true) : showCol(ac);
    render();
  });
  ro.observe(sc);

  /** Brings column j fully into view beside the row number and the pinned columns. */
  const showCol = (j: number) => {
    const c = cols[j];
    if (!c) return;
    const x = xOf(j),
      W = sc.clientWidth;
    if (!W) return void (owed = true);
    if (pinned(j)) {
      if (x + c.w > sc.scrollLeft + W) sc.scrollLeft = x + c.w - W;
      return;
    }
    const cv = cover(j);
    if (x < sc.scrollLeft + cv) sc.scrollLeft = x - cv;
    else if (x + c.w > sc.scrollLeft + W) sc.scrollLeft = Math.min(x - cv, x + c.w - W);
  };
  /** Scrolls the active cell into view (`center`: rows out of view land in the middle, for revealed cells). */
  const show = (center = false) => {
    const vh = sc.clientHeight - HH,
      y = ar * RH;
    // Hidden (Setup screen, another view): scroll once the grid is shown again.
    if (!sc.clientWidth) return void (owed = true);
    if (center && (y < sc.scrollTop || y + RH > sc.scrollTop + vh)) sc.scrollTop = Math.max(0, y - (vh - RH) / 2);
    else if (y < sc.scrollTop) sc.scrollTop = y;
    else if (y + RH > sc.scrollTop + vh) sc.scrollTop = y + RH - vh;
    showCol(ac);
  };
  const clamp = (v: number, n: number) => Math.max(0, Math.min(v, n - 1));
  /** Moves the cursor; `ext` keeps the anchor (range selection). */
  const go = (r: number, c: number, ext = false, scroll = true, center = false) => {
    if (!rows.length || !cols.length) return;
    gen++;
    ar = clamp(r, rows.length);
    ac = clamp(c, cols.length);
    if (!ext) (br = ar), (bc = ac);
    if (scroll) show(center);
    render(true);
    const [r0, c0, r1, c1] = rng();
    o.onSel(r0 === r1 && c0 === c1 ? '' : `${plural(r1 - r0 + 1, 'row')} × ${plural(c1 - c0 + 1, 'column')} selected`);
  };
  /** Selects whole rows from the anchor row to `i` (row-number click). */
  const selectRows = (i: number, ext: boolean) => {
    if (!ext) br = i;
    bc = cols.length - 1;
    go(i, 0, true, false);
  };

  // ---- conflicts: a small chooser next to the cell (there is no side panel) ----
  const chooser = () => {
    const s = rows[ar],
      l = cols[ac]?.l,
      st = s && l ? store.cellStatus(s.key, l) : undefined;
    if (!s || !l || st?.outcome !== 'conflict') return;
    closeCf();
    show();
    render(true);
    const anchor = live.get(ar)?.cs[ac];
    if (!anchor) return;
    const key = s.key,
      mine = store.isEdited(key, l);
    const pick = (keepMine: boolean) => {
      closeCf();
      store.resolve(key, l, keepMine);
      render(true);
      focus();
    };
    const content = h(
      'div',
      { class: 'g-cf' },
      h('p', { class: 'g-cf-t' }, icon('warn'), 'Changed on the server by someone else'),
      h('dl', null, h('dt', null, 'Server'), h('dd', null, quote(st.server)), mine && h('dt', null, 'Yours'), mine && h('dd', null, quote(store.value(key, l)))),
      mine && h('p', { class: 'g-cf-n' }, 'Keep mine saves your text over theirs the next time you save.'),
      h('div', { class: 'g-cf-a' }, btn('Use server value', () => pick(false), mine ? 'sm' : 'primary sm'), mine && btn('Keep mine', () => pick(true), 'primary sm')),
    );
    cfAt = sc.scrollTop + ',' + sc.scrollLeft;
    cf = popover(anchor, content, {
      cls: 'g-cfp',
      label: `Save conflict in ${langName(app, l)}`,
      onClose: () => {
        cf = null;
        // The popover marks its anchor expanded/collapsed; cells are pooled and move to other rows, where
        // "collapsed" would be announced on a plain cell.
        anchor.removeAttribute('aria-expanded');
        // Back to the grid unless the user moved on to something else.
        if (!active(el)) focus();
      },
    });
    // Focus the primary choice: "Keep mine" when there is an edit ("Use server value" drops it, and that has no undo).
    if (cf) cf.el.setAttribute('role', 'dialog'), cf.el.querySelector<HTMLElement>('.primary')?.focus();
  };

  // ---- cell editor ----
  const grow = () => {
    // The text stays exactly where the cell showed it (no jump when the editor opens): the cell centres one or two
    // lines in its 52px row, so the editor pads them the same way; longer texts grow it downwards.
    ed.style.padding = '';
    // Measured without the minimum height (it would count one line as two).
    ed.style.minHeight = '0';
    ed.style.height = '0';
    const lines = Math.max(1, Math.round((ed.scrollHeight - ED_PAD * 2) / 18));
    ed.style.minHeight = '';
    const pad = (RH - 4 - lines * 18) / 2;
    if (pad > ED_PAD) ed.style.padding = `${pad}px ${ED_PAD + 1}px`;
    ed.style.height = 'auto';
    ed.style.height = Math.min(240, Math.max(RH, ed.scrollHeight + 4)) + 'px';
    // Green from the first character that changes the text, red where saving will refuse it: what the cell will show.
    const look = edLook(store.get(edKey), edL, base, store.original(edKey, edL), store.value(edKey, edL), ed.value, langName(app, base), textOf(store), store.cellStatus(edKey, edL));
    ed.className = 'g-ed' + look.cls;
    ed.title = look.tip;
  };
  /**
   * Edits the active cell (`init`: typed text that replaces it). On a key or Type column it edits the row's
   * target-language cell. A conflict opens the chooser instead (typing still edits).
   */
  const open = (init?: string) => {
    const s = rows[ar];
    if (!s) return;
    if (!cols[ac]?.l) {
      const tj = tcol();
      if (tj < 0) return;
      go(ar, tj);
    }
    const l = cols[ac].l;
    if (s.readOnly) return app.toast(s.readOnly, 'info');
    if (notLoaded(s, l) && !store.isEdited(s.key, l)) {
      // The message bar's Read again goes with its next message; the cell's notice offers it again where it would help,
      // and then says so rather than sending the user to the message bar.
      const again = o.readAgain;
      const button = !!again && rereadable(s, l);
      return app.toast(unreadTip(s, l, { button }), 'info', again && button ? { label: 'Read again', run: () => again() } : undefined);
    }
    if (init === undefined && store.cellStatus(s.key, l)?.outcome === 'conflict') return chooser();
    show();
    edKey = s.key;
    edL = l;
    edFrom = store.value(s.key, l);
    edBase = store.before(s.key, l);
    ed.value = init ?? edFrom;
    edStart = init === undefined ? ed.value : '\0';
    ed.dir = isRtl(l) ? 'rtl' : 'auto';
    ed.lang = lcidTag(l); // spell-check in the cell's language
    ed.setAttribute('aria-label', `${langName(app, l)} text of ${s.title || s.key} (${PROP_NAMES[s.prop] || s.prop})`);
    placeEd();
    body.append(ed);
    ed.focus({ preventScroll: true });
    ed.setSelectionRange(ed.value.length, ed.value.length);
    // A new history for this cell; typing into the cell replaced its text, which the first Ctrl+Z brings back.
    resetUndo(ed, init === undefined ? undefined : edFrom);
    grow();
  };
  const cancel = () => {
    edKey = '';
    ed.remove();
  };
  const commit = () => {
    if (!edKey) return;
    const key = edKey,
      l = edL,
      v = ed.value,
      s = store.get(key);
    cancel();
    // A reload can replace the slot while the editor is open (setRows commits it after store.add). The text stays
    // typed over the server text the editor opened on, so saving it over someone else's newer text is a conflict,
    // and an editor left untouched never puts its old text back. Measured against the server text now only when
    // that is still what the editor opened on (a reload that brought the pending text itself dropped the edit).
    if (!s || v === edFrom || v === store.value(key, l)) return;
    if (l === base && s.baseRequired && !v.trim()) app.toast(`The ${langName(app, base)} label can't be blank.`, 'warn');
    else {
      store.set(key, l, v, store.original(key, l) === edFrom ? undefined : edBase);
      // Say it right away rather than at review time; the cell is marked as an error too.
      if (clearing(store, s, l, base) === 'blocked') app.toast(blockedWhy(s, l, base, store.original(key, l), v, textOf(store)), 'warn', undo);
    }
  };
  ed.addEventListener('blur', () => {
    // Switching to another window or tab (to copy from Excel, say) blurs the editor too, but leaves it the
    // active element. The text is kept (it counts as a pending change) and the grid takes the focus back, so a
    // paste on return lands on this cell instead of nowhere.
    const away = active(ed) === ed;
    commit();
    if (away) focus();
  });
  ed.addEventListener('input', grow);
  ed.addEventListener('keydown', (e) => {
    const k = e.key;
    if (e.isComposing) return;
    // Ctrl+S bubbles on to the app's review: commit first so this cell is part of it.
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 's') commit(), focus();
    else if (k === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      focus();
    } else if (k === 'Enter' && e.altKey) {
      e.preventDefault();
      insertText(ed, '\n', 'insertLineBreak'); // its input event grows the editor
    } else if (k === 'Enter' || k === 'Tab') {
      e.preventDefault();
      commit();
      focus();
      if (k === 'Tab') go(ar, ac + (e.shiftKey ? -1 : 1));
      else go(ar + (e.shiftKey ? -1 : 1), ac);
    }
  });
  // A click opens the editor, so cells copied from a spreadsheet and pasted right after a click are meant for
  // the grid (as when a cell is selected in Excel). Other text with line breaks (paragraphs from a document)
  // goes into this cell. A single cell from Excel loses the line break Excel adds after it.
  ed.addEventListener('paste', (e) => {
    const t = e.clipboardData?.getData('text/plain');
    if (!t) return;
    const html = e.clipboardData?.getData('text/html') || '',
      own = sameClip(copied, t),
      d = parseTsv(t);
    if (d.length === 1 && d[0].length === 1) {
      const v = oneCell(t, d, own || /<table/i.test(html));
      if (v !== t) e.preventDefault(), insertText(ed, v);
    } else if (ed.value === edStart && fromSheet(d, html, own)) {
      e.preventDefault();
      cancel();
      focus();
      paste(t);
    }
  });
  // Ctrl+Z / Ctrl+Y in an editor with nothing typed yet (a click opens one) are the workbook's, as on the grid: the
  // editor closes first, so no editor shows text the undo didn't touch.
  whenEmpty(ed, (u) => {
    if (!edKey || ed.value !== edStart || store.busy) return;
    cancel();
    focus();
    if (u === 'redo') store.redo();
    else store.undo();
  });

  // ---- range operations (one undo step each) ----
  /** The text of a cell is unknown, not empty: its language was not loaded (UNREAD) and it holds no pending edit. */
  const unread = (s: Slot, l: Lcid) => notLoaded(s, l) && !store.isEdited(s.key, l);
  /**
   * Sets the cells of a range to `fn`'s text: undefined leaves a cell as it is, null where the text it would copy is
   * not loaded (unknown, not empty: copied, it would empty a translation, which saving then removes or replaces with its
   * stand-in), which is skipped and said. `strict`: never blank a base-language cell (Delete/cut), not only the ones
   * Dataverse requires.
   */
  const each = (fn: (s: Slot, l: Lcid, i: number, j: number) => string | null | undefined, r0: number, c0: number, r1: number, c1: number, verb: string, strict = false) => {
    let n = 0,
      ro = 0,
      na = 0, // languages not loaded (UNREAD)
      un = 0, // copied from a cell whose language is not loaded
      bl = 0,
      rm = 0, // emptied translations that saving will remove
      nc = 0, // emptied translations Dataverse can't remove that have no stand-in
      sp = 0, // only spaces where Dataverse would store them as a blank label
      em = 0, // emptied descriptions, saved empty (blankEdit 'empty')
      why = ''; // the reason, when a single cell is blocked
    /** Emptied translations Dataverse can't remove, saved as their stand-in. */
    const sis: Array<{ s: Slot; l: Lcid; from: StandInFrom }> = [];
    store.group(() => {
      for (let i = r0; i <= r1 && i < rows.length; i++)
        for (let j = c0; j <= c1 && j < cols.length; j++) {
          const s = rows[i],
            l = cols[j].l,
            // Key and Type columns are never written.
            v = l ? fn(s, l, i - r0, j - c0) : undefined;
          if (v === undefined || v === store.value(s.key, l)) continue;
          if (v === null) un++;
          else if (s.readOnly) ro++;
          else if (unread(s, l)) na++;
          else if (l === base && (strict || s.baseRequired) && !v.trim()) bl++;
          else {
            store.set(s.key, l, v);
            n++;
            const c = clearing(store, s, l, base);
            if (c === 'blocked') {
              const before = store.original(s.key, l);
              if (before) nc++;
              else sp++;
              why = blockedWhy(s, l, base, before, v, textOf(store));
            } else if (c === 'remove') rm++;
            else if (c === 'empty') em++;
            else if (c === 'standin') {
              const x = store.standIn(s.key, l, base);
              if (x?.text) sis.push({ s, l, from: x.from });
            }
          }
        }
    });
    const parts = [
      ro && plural(ro, 'read-only cell'),
      na && `${plural(na, 'cell')} in a language that is not loaded (see the cell's tooltip)`,
      un && `${plural(un, 'cell')} whose source cell is not loaded (its text is unknown, not empty)`,
      bl && `${plural(bl, 'cell')} where the ${langName(app, base)} label can't be blank`,
    ].filter((x): x is string => !!x);
    const skip = parts.length > 2 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts.join(' and ');
    const say: string[] = [];
    if (n && (n > 1 || skip || nc || sp)) say.push(`${verb} ${plural(n, 'cell')}.`);
    if (skip) say.push(`Skipped ${skip}.`);
    if (nc + sp === 1) say.push(why);
    else {
      if (nc) say.push(`Dataverse can't remove ${nc.toLocaleString()} of the translations you emptied, and they have no text to put in their place (marked in red) — type the text instead, or undo.`);
      if (sp) say.push(`${plural(sp, 'cell')} now ${sp === 1 ? 'holds' : 'hold'} only spaces, which Dataverse would show as a blank label (marked in red) — type the text instead, or undo.`);
    }
    // A single removal speaks for itself (the old text shows struck through in the cell), as does a single stand-in
    // (the cell shows it).
    if (rm && n > 1) say.push(`${plural(rm, 'translation')} will be removed when you save.`);
    // So does a single description saved empty (the cell shows "(empty)").
    if (em && n > 1) say.push(`${plural(em, 'emptied description')} will be saved empty when you save: users of ${em === 1 ? 'that language' : 'those languages'} see none there.`);
    // In the popup's words: what they get, and why they can't be removed (model.ts standInsSaid).
    const si = sis.length && standInsSaid(sis, base);
    if (si && n > 1) say.push(`${plural(sis.length, 'emptied translation')} ${sis.length === 1 ? 'gets' : 'get'} ${si.what} in ${sis.length === 1 ? 'its' : 'their'} place when you save: ${si.why}.`);
    if (say.length) app.toast(say.join(' '), skip || nc || sp ? 'warn' : 'ok', n ? undo : undefined);
  };
  /**
   * Ctrl+D: the first row's texts go to the rows below it (one row selected: the row above's go to it). A language the
   * first row was not loaded in is skipped for that column: its blank stands for a text nobody has seen.
   */
  const fillDown = () => {
    const [r0, c0, r1, c1] = rng(),
      src = rows[r0 === r1 ? r0 - 1 : r0];
    if (src) each((_, l) => (unread(src, l) ? null : store.value(src.key, l)), r0 === r1 ? r0 : r0 + 1, c0, r1, c1, 'Filled');
  };
  /** Header texts of language columns in this grid and in exported files ("French Label", "1036"). */
  const langHead = (v: string) => all.some((l) => v === String(l) || v === keyNorm(`${langName(app, l)} Label`));
  /**
   * Why a pasted block (several cells) can't be pasted at r0, c0 without putting translations on other labels,
   * or '': a copied header row, more rows or columns than there is room for (the rest would be dropped, and
   * the block was laid out for other rows or columns), or key cells that don't match the rows it lands on.
   */
  const misfit = (d: string[][], r0: number, c0: number): string => {
    const hd = headerCell(d, c0, cols.length, (j, v) => keyNorm(v) === keyNorm(cols[j].name) || (!!cols[j].l && langHead(keyNorm(v))));
    if (hd)
      return `Nothing was pasted: the first row you copied holds column headers (“${cut(hd[1])}”), so every translation would land one row too low. Copy only the rows with text, then paste again.`;
    const [hh, ww] = extent(d);
    if (c0 + ww > cols.length)
      return `Nothing was pasted: you copied ${plural(ww, 'column')}, but only ${plural(cols.length - c0, 'column')} ${cols.length - c0 === 1 ? 'is' : 'are'} left from ${cols[c0].name}. Select the cell where the first copied column belongs (for example the first key column for whole rows), then paste again.`;
    if (r0 + hh > rows.length)
      return `Nothing was pasted: you copied ${plural(hh, 'row')}, but this sheet shows only ${plural(rows.length - r0, 'row')} from row ${r0 + 1}, so the rows can't line up. Check Rows and Filter rows, or use Excel › Import workbook or CSV, which matches rows by their ids.`;
    // Rows copied with their key columns must land on the same rows here, or the translations would go to other labels.
    const bad = keyMismatch(
      d,
      r0,
      c0,
      Math.min(rows.length, r0 + d.length) - 1,
      Math.min(cols.length, c0 + d.reduce((m, x) => Math.max(m, x.length), 0)) - 1,
      (j) => !cols[j].l,
      (i, j, v) => keyNorm(v) === keyNorm(text(rows[i], j)) || (!cols[j].key && keyNorm(v) === keyNorm(rows[i].prop)),
    );
    // Pasting only the language columns of those rows would put the same translations on the wrong labels, so
    // the way out is the import (or rows in this sheet's order), never "leave the keys out".
    return bad
      ? `Nothing was pasted: the rows don't line up. Row ${bad.i + 1} has ${cols[bad.j].name} “${cut(text(rows[bad.i], bad.j))}” here but “${cut(bad.v)}” in what you pasted, so the translations would go to other labels. Use Excel › Import workbook or CSV, which matches rows by their ids, or copy the rows in this sheet's order.`
      : '';
  };
  /** Pastes clipboard text on the selection, or on the range `at` (a paste the browser handed over late, see viaApi). */
  const paste = (t: string, at: Range = rng()) => {
    if (!t || !rows.length || !cols.length) return;
    const d = parseTsv(t),
      one = d.length === 1 && d[0].length === 1,
      [r0, c0, r1, c1] = at,
      er = Math.min(rows.length, one ? r1 + 1 : r0 + d.length) - 1,
      ec = Math.min(cols.length, one ? c1 + 1 : c0 + d.reduce((m, x) => Math.max(m, x.length), 0)) - 1,
      // This grid's own copy: its cells in a language that was not loaded came out blank, which is not their text.
      nl = !one && sameClip(copied, t) ? unk : null;
    const why = one ? '' : misfit(d, r0, c0);
    if (why) return app.toast(why, 'warn');
    // A cell pasted on key or Type cells only would change nothing, silently.
    if (one && !cols.slice(c0, ec + 1).some((c) => c.l))
      return app.toast("Key and Type columns say which label a row is and can't be changed. Select a cell in a language column, then paste again.", 'info');
    each((_, __, i, j) => (one ? d[0][0] : nl?.has(`${i},${j}`) ? null : d[i]?.[j]), r0, c0, er, ec, 'Pasted');
    br = r0;
    bc = c0;
    go(er, ec, true, false);
  };
  /** The text of the selection (or of the range `at`) for the clipboard; notes which of its cells were not loaded (unk). */
  const tsv = (at: Range = rng()) => {
    const [r0, c0, r1, c1] = at,
      out: string[][] = [];
    unk = new Set();
    for (let i = r0; i <= r1; i++) {
      const line: string[] = [];
      for (let j = c0; j <= c1; j++) {
        const l = cols[j].l;
        if (l && unread(rows[i], l)) unk.add(`${i - r0},${j - c0}`);
        line.push(text(rows[i], j));
      }
      out.push(line);
    }
    return toTsv(out);
  };
  const clear = (at: Range = rng()) => each(() => '', ...at, 'Cleared', true);
  const onCopy = (e: ClipboardEvent) => {
    if (e.target === ed) {
      // Nothing selected in an open editor (a click opens it): copy the cell, as Excel does for a selected cell,
      // quoted like the grid's own copies so a text with line breaks stays one cell when pasted back or in Excel.
      if (e.type === 'copy' && ed.selectionStart === ed.selectionEnd) e.preventDefault(), (unk = new Set()), e.clipboardData?.setData('text/plain', (copied = tsvCell(ed.value)));
      return;
    }
    if (!rows.length) return;
    clip++;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', (copied = tsv()));
    if (e.type === 'cut') clear();
  };
  el.addEventListener('copy', onCopy);
  el.addEventListener('cut', onCopy);
  el.addEventListener('paste', (e) => {
    if (e.target === ed) return;
    clip++;
    e.preventDefault();
    paste(e.clipboardData?.getData('text/plain') || '');
  });
  /** The selection now, for a clipboard shortcut the browser may answer late (viaApi). */
  const snap = (): Snap => {
    const at = rng();
    return { at, keys: rows.slice(at[0], at[2] + 1).map((s) => s.key), ids: cols.slice(at[1], at[3] + 1).map((c) => c.id), sheet, gen };
  };
  /** The snapshot's cells are still where they were: the same sheet, rows and columns at the same places. */
  const there = (x: Snap) => x.sheet === sheet && x.keys.every((k, i) => rows[x.at[0] + i]?.key === k) && x.ids.every((id, j) => cols[x.at[1] + j]?.id === id);
  /** ...and still the selection, with no cell editor open: a late paste or cut may change them. */
  const still = (x: Snap) => x.gen === gen && !edKey && there(x);
  // Some hosts swallow clipboard events on non-editable elements; fall back to the async Clipboard API. Its answer comes
  // later (a permission prompt can take a while), so it acts on the cells selected when the keys were pressed (`x`), and
  // changes them only while they are still the selection: a paste or a cut never lands on cells the user has moved on
  // to, nor in a language column that took the place of the one they chose.
  const viaApi = (k: string, x: Snap) => {
    const fail = () => app.toast('The browser blocked the clipboard. Allow clipboard access for this site, then try again.', 'warn');
    if (k === 'v')
      return void navigator.clipboard?.readText().then((t) => {
        if (!t) return;
        if (still(x)) paste(t, x.at);
        else app.toast('Nothing was pasted: the selection changed while the browser was reading the clipboard. Select the cells again, then paste.', 'info');
      }, fail);
    if (!there(x)) return app.toast(`Nothing was ${k === 'x' ? 'cut' : 'copied'}: the rows changed before the browser could copy them. Select the cells again, then try again.`, 'info');
    navigator.clipboard?.writeText((copied = tsv(x.at))).then(() => {
      if (k !== 'x') return;
      if (still(x)) clear(x.at);
      else app.toast('Copied, but nothing was cleared: the selection changed while the browser was copying. Select those cells again and press Delete to clear them.', 'info');
    }, fail);
  };

  // ---- keyboard ----
  el.addEventListener('keydown', (e) => {
    if (e.target === ed || !rows.length || !cols.length || e.isComposing) return;
    const k = e.key,
      m = e.ctrlKey || e.metaKey,
      pg = Math.max(1, Math.floor((sc.clientHeight - HH) / RH) - 1);
    let r = ar,
      c = ac;
    if (m && !e.altKey && k.length === 1) {
      const kk = k.toLowerCase();
      if (kk === 'a') e.preventDefault(), (br = rows.length - 1), (bc = cols.length - 1), go(0, 0, true, false);
      else if (kk === 'd') e.preventDefault(), fillDown();
      else if ('cxv'.includes(kk)) {
        const id = ++clip,
          x = snap();
        setTimeout(() => clip === id && viaApi(kk, x), 80);
      }
      return;
    }
    switch (k) {
      case 'ArrowUp':
        r = m ? 0 : r - 1;
        break;
      case 'ArrowDown':
        r = m ? rows.length - 1 : r + 1;
        break;
      case 'ArrowLeft':
        c = m ? 0 : c - 1;
        break;
      case 'ArrowRight':
        c = m ? cols.length - 1 : c + 1;
        break;
      case 'PageUp':
        r -= pg;
        break;
      case 'PageDown':
        r += pg;
        break;
      case 'Home':
        if (m) r = 0;
        c = 0;
        break;
      case 'End':
        if (m) r = rows.length - 1;
        c = cols.length - 1;
        break;
      case 'Tab':
        c += e.shiftKey ? -1 : 1;
        if (c < 0 || c >= cols.length) return; // let focus leave the grid
        e.preventDefault();
        return go(r, c);
      case 'Enter':
      case 'F2':
        e.preventDefault();
        return open();
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        return clear();
      case 'Escape':
        if (ar !== br || ac !== bc) e.preventDefault(), e.stopPropagation(), go(ar, ac);
        return;
      default:
        // Typing starts editing with that character; an IME key opens an empty editor for the composition.
        // AltGr (Ctrl+Alt on Windows) types characters such as @, € or [ on French and other keyboards.
        if ((k.length === 1 || k === 'Process') && ((!m && !e.altKey) || e.getModifierState?.('AltGraph'))) {
          if (k !== 'Process') e.preventDefault();
          open(k === 'Process' ? '' : k);
        }
        return;
    }
    e.preventDefault();
    go(r, c, e.shiftKey);
  });

  // ---- mouse: click a language cell to edit it, drag to select, Shift+click to extend ----
  const at = (e: Event): [number, number] | null => {
    const c = (e.target as Element).closest?.('.g-c') as Cell | null,
      r = c?.parentElement as Row | undefined;
    return c && r && live.get(r.i) === r ? [r.i, c.j] : null;
  };
  body.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    const g = (e.target as Element).closest?.('.g-g'),
      gr = g?.parentElement as Row | undefined;
    if (g && gr && live.get(gr.i) === gr) {
      e.preventDefault();
      commit();
      focus();
      return selectRows(gr.i, e.shiftKey);
    }
    const p = at(e);
    if (!p) return;
    e.preventDefault();
    commit();
    focus();
    drag = true;
    moved = false;
    x0 = e.clientX;
    y0 = e.clientY;
    down = e.shiftKey || e.ctrlKey || e.metaKey ? null : p;
    go(p[0], p[1], e.shiftKey);
  });
  body.addEventListener('pointermove', (e) => {
    if (!(e.buttons & 1)) drag = false;
    if (!drag) return;
    // A few pixels of jitter (or the grid scrolling the clicked cell into view) is still a click.
    if (!moved && Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) < 5) return;
    moved = true;
    const p = at(e);
    if (p && (p[0] !== ar || p[1] !== ac)) go(p[0], p[1], true);
  });
  body.addEventListener('pointerup', (e) => {
    drag = false;
    const d = down;
    down = null;
    // A click (no drag) on a language cell edits it, like the old workbook's text boxes.
    if (d && !moved && !e.button && d[0] === ar && d[1] === ac && cols[ac]?.l) open();
  });
  body.addEventListener('dblclick', (e) => {
    const p = at(e);
    if (p && !cols[p[1]].l) open(); // a key or Type cell: edit the row's target-language cell
  });
  // Header click selects the whole column (copy it, clear it, paste into it); the corner selects everything.
  head.addEventListener('pointerdown', (e) => {
    if (e.button || !rows.length) return;
    const t = e.target as Element;
    const c = t.closest('.g-hc') as (HTMLElement & { j: number }) | null;
    if (!c && !t.closest('.g-g')) return;
    e.preventDefault();
    commit();
    focus();
    br = rows.length - 1;
    bc = c ? c.j : cols.length - 1;
    go(0, c ? c.j : 0, true, false);
  });
  const resize = (e: PointerEvent, j: number) => {
    e.preventDefault();
    e.stopPropagation();
    commit();
    const t = e.target as HTMLElement,
      x0 = e.clientX,
      w0 = cols[j].w;
    t.setPointerCapture(e.pointerId);
    t.classList.add('is-on');
    const mv = (ev: PointerEvent) => {
      cols[j].w = Math.max(cols[j].min, Math.min(1000, w0 + ev.clientX - x0));
      layout();
    };
    const up = () => {
      t.removeEventListener('pointermove', mv);
      t.removeEventListener('lostpointercapture', up);
      t.classList.remove('is-on');
      o.widths[cols[j].wk] = cols[j].w;
      o.onWidths();
      // A pinned column that grew may leave too little room for a language: re-decide what stays pinned.
      const was = pinOn;
      size();
      if (pinOn !== was) build();
      else layout();
    };
    t.addEventListener('pointermove', mv);
    t.addEventListener('lostpointercapture', up);
  };

  return {
    el,
    setSheet(id, keys, tt, langs, tg) {
      commit();
      closeCf();
      const same = id === sheet,
        curId = cols[ac]?.id;
      gen++;
      sheet = id;
      typeText = tt;
      target = tg;
      cols = buildCols(id, keys, langs, base, tg, (l) => langName(app, l));
      el.setAttribute('aria-colcount', String(cols.length + 1));
      // The same sheet (languages changed) keeps the cursor's column; another sheet starts at the top, in the
      // column being translated.
      let j = same && curId ? cols.findIndex((c) => c.id === curId) : -1;
      if (j < 0) j = Math.max(0, tcol());
      ac = bc = j;
      if (!same) (ar = br = 0), (sc.scrollTop = 0), (sc.scrollLeft = 0);
      build();
      showCol(ac);
      o.onSel('');
    },
    setRows(r) {
      commit();
      closeCf();
      const key = rows[ar]?.key,
        i = key ? r.findIndex((s) => s.key === key) : -1;
      rows = r;
      body.style.height = r.length * RH + 'px';
      el.setAttribute('aria-rowcount', String(r.length + 1));
      ar = br = i < 0 ? clamp(ar, r.length) : i;
      bc = ac;
      if (flash && !r.some((s) => s.key === flash!.key)) flash = null;
      render(true);
      o.onSel('');
    },
    refresh: () => render(true),
    reveal(key, l, fl) {
      const i = rows.findIndex((s) => s.key === key);
      if (i < 0 || !cols.length) return false;
      commit();
      closeCf();
      let j = cols.findIndex((c) => c.l === (l || target));
      if (j < 0) j = Math.max(0, tcol());
      go(i, j, false, true, true);
      if (fl) {
        // Restart the animation when the same cell flashes again.
        const x = live.get(i)?.cs[j];
        if (x?.classList.contains('is-fl')) x.classList.remove('is-fl'), void x.offsetWidth, (x.k = '');
        flash = { key, j };
        clearTimeout(flT);
        flT = setTimeout(() => {
          flash = null;
          render(true);
        }, FLASH_MS);
        render(true);
      }
      return true;
    },
    cursor: () => (rows[ar] && cols[ac] ? { key: rows[ar].key, lcid: cols[ac].l || target } : null),
    focus,
    commit,
    destroy() {
      cancel();
      closeCf();
      offStore();
      clearTimeout(flT);
      ro.disconnect();
      el.remove();
    },
  };
}
