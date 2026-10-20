// The Workbench, rebuilt as the XrmToolBox Easy Translator bookmarklet workbook: a Setup screen
// ("Export options": tables, what to export, languages), then one Excel-like sheet per type of label with
// its key columns and one column per language, sheet tabs at the bottom, a "pending changes" navigator,
// Excel import/export, bulk tools and Save and Publish. There is no sidebar: every edit happens in the grid.
// Saving always goes through the review dialog and the saver (validate → fresh read and conflict check →
// write only the changed languages → read back → publish → history); the outcome lands in the message bar
// and on the cells (check mark when verified, red when not).

import { isAbort } from '../core/http';
import { lcidName } from '../core/lcid';
import type { Kind, Lcid, Slot } from '../core/model';
import { hit, terms } from '../core/search';
import { navKnown, navListed } from '../inspector/fallback';
import { formNote, mergeReads, type FormNote } from '../providers/formxml';
import type { Scope } from '../providers/types';
import { debounce, h, icon, plural, put, rafThrottle, type IconName } from '../ui/dom';
import { compSlots, langName } from '../ui/editor';
import type { AppApi, ImportRow, SaveReport, View } from '../ui/types';
import { btn, emptyState, errMsg, ibtn, link, menu, popover, skeleton, spinner, tooltip, type MenuItem, type Pop } from '../ui/widgets';
import { clearing, createGrid } from './grid';
import { createSetup, listKey, loadState, saveState, waitsForList } from './scope';
import { inLabelMode, rowsLabel, rowsTest, searchText, SHEETS, sheetOf, sortSlots } from './sheets';
import { openTool, TOOLS } from './tools';
import type { GridOptions, LabelMode, RowsMode, SheetCtx, SheetDef, WbState } from './types';
import css from './workbench.css';

// ---- pure helpers (unit-tested in tools/dev/tests/workbook.ts) ----

/** Kinds whose `slot.entity` is always the table they were loaded for (so a table filter applies to them). */
const OWN = new Set<Kind>(['entity', 'attribute', 'option', 'boolean', 'state', 'status', 'form', 'tab', 'section', 'field', 'navitem', 'view', 'chart']);

/** What the last "Extract translations" asked for. */
export interface Extracted {
  kinds: Set<Kind>;
  ents: Set<string>;
  /** Read-only labels were asked for. */
  ro: boolean;
}

/**
 * Whether a slot belongs in the workbook: everything in the store before the first extraction (e.g. what
 * translation mode loaded), afterwards what the extraction covers. A slot with a pending edit (or one a
 * "Fix" link pointed at) is always in, so every unsaved change stays reachable and gets saved.
 */
export const inBook = (s: Slot, x: Extracted | null, edited: boolean, pinned = false): boolean =>
  edited || pinned || !x || (x.kinds.has(s.kind) && (!OWN.has(s.kind) || x.ents.has(s.entity)) && (x.ro || !s.readOnly));

/**
 * What the message bar says when an extraction brought nothing. Without read-only labels the loaders leave out every
 * label from a managed solution, so a managed solution or a system table often has nothing else: said, never a bare
 * "nothing".
 */
export const nothingExtracted = (ro: boolean): string =>
  ro
    ? 'No labels were extracted. Choose other tables or options, then select Extract translations again.'
    : 'No labels to translate were extracted. Read-only labels (from managed solutions or not customizable) are left out unless “Include read-only labels” is selected. Choose other tables or options, then select Extract translations again.';

/**
 * The first line of an import's Skipped rows dialog (`n` rows of `file`). A row is listed when it matched no label, and
 * also for the languages of a matched row that were not imported (an Excel error, conflicting duplicates, a read-only
 * label…) while its others were: each says why.
 */
export const skippedIntro = (n: number, file: string): string => `${plural(n, 'row')} of ${file} ${n === 1 ? 'was' : 'were'} not imported, or not in full:`;

/** The workbook: sheet id → rows in sheet order (only non-empty sheets, in tab order), and each row's place. */
export interface Book {
  by: Map<string, Slot[]>;
  /** slot key → [sheet index in SHEETS, row index in its sheet]. */
  place: Map<string, [number, number]>;
  total: number;
}
/**
 * Sorts the slots that belong in the workbook (inBook) onto their sheets. The label options (Both / Only
 * Names / Only Descriptions) never hide a row with a pending edit.
 */
export function bookOf(slots: Iterable<Slot>, edited: (key: string) => boolean, x: Extracted | null, mode: LabelMode, pinned: ReadonlySet<string> = new Set()): Book {
  const m = new Map<string, Slot[]>();
  for (const s of slots) {
    const ed = edited(s.key),
      pin = pinned.has(s.key);
    if (!inBook(s, x, ed, pin) || (!ed && !pin && !inLabelMode(s, mode))) continue;
    const id = sheetOf(s).id,
      a = m.get(id);
    if (a) a.push(s);
    else m.set(id, [s]);
  }
  const b: Book = { by: new Map(), place: new Map(), total: 0 };
  SHEETS.forEach((d, si) => {
    const a = m.get(d.id);
    if (!a?.length) return;
    const sorted = sortSlots(a);
    b.by.set(d.id, sorted);
    sorted.forEach((s, i) => b.place.set(s.key, [si, i]));
    b.total += sorted.length;
  });
  return b;
}

/**
 * Language columns: base, target, the other shown languages in the org's order, plus every language that
 * holds a pending edit (so the navigator never points at a hidden cell).
 */
export function columnLangs(org: readonly Lcid[], base: Lcid, target: Lcid, shown: readonly Lcid[], pending: ReadonlySet<Lcid>): Lcid[] {
  return [base, ...(target !== base ? [target] : []), ...org.filter((l) => l !== base && l !== target && (shown.includes(l) || pending.has(l)))];
}

/** Where a pending change sits: sheet (tab order), row (sheet order), language column; then key and lcid. */
export interface Loc {
  s: number;
  r: number;
  l: number;
  key: string;
  lcid: Lcid;
}
export const cmpLoc = (a: Loc, b: Loc): number => a.s - b.s || a.r - b.r || a.l - b.l || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || a.lcid - b.lcid;

/** Pending cells in workbook order; cells whose slot is not in the workbook (`where` → undefined) are left out. */
export function pendingLocs(cells: Iterable<readonly [string, Lcid]>, where: (key: string) => readonly [number, number] | undefined, col: (l: Lcid) => number): Loc[] {
  const out: Loc[] = [];
  for (const [key, lcid] of cells) {
    const p = where(key);
    if (p) out.push({ s: p[0], r: p[1], l: col(lcid), key, lcid });
  }
  return out.sort(cmpLoc);
}

/**
 * The next (dir 1) or previous (-1) location from `ref`, wrapping around; -1 when there is none. `ref` is
 * where the user is (the grid's cursor or the last change visited); it need not be a pending cell itself.
 */
export function navStep(locs: readonly Loc[], ref: Loc | null, dir: 1 | -1): number {
  const n = locs.length;
  if (!n) return -1;
  if (!ref) return dir > 0 ? 0 : n - 1;
  let p = 0;
  while (p < n && cmpLoc(locs[p], ref) < 0) p++;
  if (p < n && cmpLoc(locs[p], ref) === 0) return (p + dir + n) % n;
  return dir > 0 ? p % n : (p - 1 + n) % n;
}

/** The sheet to show: the current one while it has rows, else the first one (in tab order) that has. */
export const pickSheet = (cur: string, order: readonly string[], has: (id: string) => boolean): string => (has(cur) ? cur : order.find(has) ?? cur);

/** Rows per sheet, for the tab labels. */
export const tabCounts = (shown: ReadonlyMap<string, readonly Slot[]>): Map<string, number> => new Map([...shown].map(([id, a]) => [id, a.length]));

/**
 * The message bar's words for form labels that could not be read, even when tried again (formNote): how many forms,
 * in which languages, then why in a sentence of its own (the first reason, which names neither the form nor the
 * language; the cells' tooltips give each one). `name` names a language.
 */
export function unreadLine(n: FormNote, name: (l: Lcid) => string): string {
  const ls = n.langs.map(name),
    list = ls.length > 1 ? `${ls.slice(0, -1).join(', ')} and ${ls[ls.length - 1]}` : ls[0] ?? '',
    why = (n.why[0] ?? '').trim().replace(/[.\s]+$/, ''),
    more = n.why.length > 1 ? ` (and ${plural(n.why.length - 1, 'other reason')}: see the cells' tooltips)` : '';
  return `The ${list} labels of ${plural(n.forms.length, 'form')} could not be read, even when tried again.${why ? ` ${why}${more}.` : ''} Their cells show “Not loaded” until they are read.`;
}

/**
 * The grid's options in the Workbench: its column widths (`persist` keeps them), the selection summary (`onSel`), and
 * the message bar's Read again (`reread`), which a "Not loaded" cell's notice offers where it would bring the cell.
 */
export function gridOptions(st: Pick<WbState, 'widths'>, ctx: SheetCtx, persist: () => void, onSel: (text: string) => void, reread: () => unknown): GridOptions {
  return { widths: st.widths, onWidths: persist, onSel, ctx, readAgain: () => void reread() };
}

/** "830 ms" under a second, else "8.2 seconds" (the old workbook's wording). */
export const took = (ms: number): string => (ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} seconds`);

export type Tone = 'info' | 'ok' | 'err';
const were = (n: number) => (n === 1 ? 'was' : 'were');
const isAre = (n: number) => (n === 1 ? 'is' : 'are');

export interface LineOpts {
  /** Pending changes left in the store once the review dialog closed. */
  left?: number;
}

/**
 * The message bar line after the review dialog closes, from the report of the last save it ran.
 * `problems`: cells are marked with a problem (Rows › Save problems lists them); `pending`: changes are
 * still not saved although this report does not count them (e.g. conflicts left by the first save when
 * the dialog's Retry saved only the failed changes), so the line never claims everything is saved.
 */
export function saveLine(r: SaveReport, o: LineOpts = {}): { text: string; tone: Tone; problems: boolean; pending: boolean } {
  const bad = r.errors + r.conflicts,
    ok = r.saved + r.unchanged,
    parts: string[] = [];
  let tone: Tone = 'ok';
  if (!bad && !r.skipped) {
    if (r.saved) parts.push(`Saved ${plural(r.saved, 'change')}${r.published ? ' and published them' : ''} in ${took(r.ms)}. Every change was read back from Dataverse and matches.`);
    if (r.unchanged)
      parts.push(
        r.saved
          ? `${plural(r.unchanged, 'other change')} ${were(r.unchanged)} already up to date.`
          : `Nothing needed saving: ${plural(r.unchanged, 'change')} already ${r.unchanged === 1 ? 'matches' : 'match'} Dataverse.`,
      );
  } else {
    tone = 'err';
    parts.push(`Saved ${ok.toLocaleString()} of ${plural(r.results.length || ok + bad + r.skipped, 'change')}.`);
    const why = [r.errors && `${r.errors.toLocaleString()} could not be saved`, r.conflicts && `${r.conflicts.toLocaleString()} ${were(r.conflicts)} changed by someone else`]
      .filter(Boolean)
      .join(' and ');
    // Both error and conflict cells carry a "!" mark (grid.css).
    if (why) parts.push(`${why.charAt(0).toUpperCase()}${why.slice(1)}: ${bad === 1 ? 'it is' : 'they are'} marked with ! in the grid. Rows › Save problems lists ${bad === 1 ? 'it' : 'them'}.`);
    if (r.skipped) parts.push(`${plural(r.skipped, 'change')} ${were(r.skipped)} not saved and ${isAre(r.skipped)} still pending.`);
  }
  if (r.saved && !r.published && !r.publishError) parts.push('They show in Dynamics after the next publish.');
  if (r.publishError) (parts.push(r.publishError), (tone = 'err'));
  if (r.warning) (parts.push(r.warning), (tone = 'err'));
  if (r.notice) parts.push(r.notice);
  // Errors, conflicts and skipped changes keep their pending edit (store.commit); anything else still pending
  // was not part of this save.
  const other = (o.left ?? 0) - bad - r.skipped;
  if (other > 0) {
    parts.push(`${plural(other, parts.length ? 'other change' : 'change')} ${isAre(other)} not saved yet: Rows › Pending changes lists ${other === 1 ? 'it' : 'them'}.`);
    tone = 'err';
  }
  return { text: parts.join(' ') || 'Nothing was saved.', tone: parts.length ? tone : 'info', problems: bad > 0, pending: other > 0 };
}

/**
 * What to clear so a row the navigator (or a "Fix" link) goes to is shown: the Rows choice, "Filter rows", or
 * neither when the row passes both but is missing from the last filter result (e.g. an undo made it pending
 * again after Rows › Pending changes ran); re-filtering is then enough. `listed`: it is in the shown rows.
 */
export const unhide = (listed: boolean, rowsOk: boolean, textOk: boolean): { rows: boolean; text: boolean; refilter: boolean } =>
  listed ? { rows: false, text: false, refilter: false } : { rows: !rowsOk, text: !textOk, refilter: true };

/** The slot a "Fix" link (comp + language) means: one with a problem there, else one edited there, else the first. */
export function fixSlot(list: readonly Slot[], l: Lcid | undefined, bad: (s: Slot) => boolean, edited: (s: Slot) => boolean): Slot | undefined {
  if (l === undefined) return list[0];
  return list.find(bad) ?? list.find(edited) ?? list[0];
}

/**
 * Related menu items of the forms show their relationship's text in a language they have no title in (LIVE-FINDINGS
 * 80): their tables' relationships, then the plural names of the tables those items list, are read behind the
 * extraction (as translation mode reads them, inspector/pageload.ts related()), so the grid's missing marks and Fill
 * missing agree with the page. Only slots the store lacks are added, read-only ones too: the workbook shows only
 * what was extracted (inBook). Until they are in, such an item is unknown, never missing (grid.ts missing()).
 */
export async function navSources(app: Pick<AppApi, 'store' | 'ctx' | 'providers'>, signal: AbortSignal): Promise<void> {
  const { store, ctx, providers: pv } = app;
  const get = (k: string) => store.get(k);
  const o = { signal, progress: () => {} };
  const items: Slot[] = [];
  for (const s of store.slots.values()) if (!navKnown(get, s) && ctx.langs.some(({ lcid }) => !(s.labels[lcid] || '').trim())) items.push(s);
  const add = (slots: Slot[]) => {
    const fresh = slots.filter((s) => !store.get(s.key));
    if (fresh.length) store.add(fresh);
  };
  // An item whose relationship is in names the table it lists; the others need their table's relationships first.
  const tables = new Set(items.filter((s) => !navListed(get, s)).map((s) => s.entity.toLowerCase()));
  if (tables.size) add(await pv.loadTables(ctx, [...tables], new Set<Kind>(['relationship']), o));
  const listed = new Set(items.map((s) => navListed(get, s)).filter((t) => t && !get(`entity|${t}|DisplayCollectionName`)));
  if (listed.size) add(await pv.loadTables(ctx, [...listed], new Set<Kind>(['entity']), o));
}

// ---- the view ----

const IDLE = 'Load entities, choose export options, then extract translations.';
/** The save button: saving always publishes (the Publish dialog, app.review()). */
const SAVE = 'Save and Publish';
const ROWS: Array<RowsMode | '-'> = ['all', 'same', 'sameOrBlank', 'blank', '-', 'pending', 'problems'];
/** The cell looks of grid.css (langCell), in the words a first-time translator needs. */
const LEGEND: Array<[string, string]> = [
  ['c-chg', 'Changed, not saved yet'],
  ['c-ok', 'Saved: read back from Dataverse, and it matches'],
  ['c-mi', 'No translation yet'],
  ['c-bad', "Not saved: the save failed, or a blank Dataverse can't save. Hover the cell for the reason."],
  ['c-cf', 'Changed by someone else since it was loaded. Click the cell to choose which text to keep.'],
  ['c-ro', 'Read-only, or a language that was not loaded'],
];
const KEYS: Array<[string[], string]> = [
  [['Arrow keys'], 'Move between cells'],
  [['Enter'], 'Keep the edit and move down'],
  [['Tab'], 'Keep the edit and move right'],
  [['Esc'], 'Cancel the edit'],
  [['Ctrl+C', 'Ctrl+V'], 'Copy and paste, also to and from Excel'],
  [['Ctrl+D'], 'Fill down'],
  [['Ctrl+Z', 'Ctrl+Y'], 'Undo and redo (while you type in a cell: what you typed)'],
  [['Ctrl+S'], 'Save and publish (you review the changes first)'],
];

interface Tab {
  b: HTMLButtonElement;
  t: Text;
  dot: HTMLElement;
}

export function createWorkbench(app: AppApi): View {
  app.adoptStyles(css);
  const { store, ctx } = app,
    base = ctx.base,
    org = ctx.langs.map((l) => l.lcid),
    st: WbState = loadState(ctx.orgId),
    persist = () => saveState(ctx.orgId, st),
    DEF = new Map(SHEETS.map((d) => [d.id, d] as const)),
    SI = new Map(SHEETS.map((d, i) => [d.id, i] as const)),
    ORDER = SHEETS.map((d) => d.id);

  let loaded: Extracted | null = null;
  /** Slots a "Fix" link revealed although they were not extracted. */
  const pinned = new Set<string>();
  /** Every row of the workbook: sheet id → slots in sheet order. */
  let by = new Map<string, Slot[]>();
  /** slot key → [sheet index, row index in `by`]. */
  let place = new Map<string, [number, number]>();
  let total = 0;
  /** Rows that pass the Rows and "Filter rows" filters, per sheet. */
  let shown = new Map<string, Slot[]>();
  /** The active sheet's shown rows (what the grid has). */
  let rows: Slot[] = [];
  let langs: Lcid[] = [base];
  let target = base;
  let q: string[] = [];
  /** Folded search text per slot key (dropped when the slot's values change). */
  const texts = new Map<string, string>();
  /** Cursor per sheet, restored when the user comes back to it. */
  const mem = new Map<string, { key: string; lcid: Lcid }>();
  let sheetId = st.sheet;
  let colsKey = '';
  let active = false;
  let stale = true;
  let loading = false;
  let destroyed = false;
  let setupShown = true;
  let ac: AbortController | null = null;
  let navRef: Loc | null = null;
  let pop: Pop | null = null;
  let lastLabel = st.labelMode;
  let lastRows = st.rows;
  let stateKey = '-';
  /** Languages shown because they held pending edits; they stay (with their check marks) until the user picks languages. */
  const sticky = new Set<Lcid>();
  /** Set once everything below exists: the grid and Setup may call back while they are being created. */
  let ready = false;
  /** Extract's line asking to wait for the entity list (scope.ts waitsForList), while it is up. */
  let waitLine = '';

  const cnt = h('span', { class: 'wb-cnt' });
  const seli = h('span', { class: 'wb-seli' });
  const sctx: SheetCtx = { store, tableName: (e) => (ready && setup.tableName(e)) || e };
  // A "Not loaded" cell's notice offers the message bar's Read again (defined below, run only once clicked).
  const grid = createGrid(app, gridOptions(st, sctx, persist, (t) => (seli.textContent = t), () => reread()));
  // Setup edits `st` in place and calls this: the label options and the Rows choice also shape the workbook.
  const fromSetup = () => {
    persist();
    if (!ready) return;
    // The entity list Extract was waiting for is in: its wait line goes.
    if (waitLine && st.tablesFor === listKey(st)) {
      if (mText.textContent === waitLine) say(IDLE);
      waitLine = '';
    }
    if (rowsSel.value !== st.rows) rowsSel.value = st.rows;
    if (!active) return void (stale = true);
    if (st.labelMode !== lastLabel) {
      lastLabel = st.labelMode;
      lastRows = st.rows;
      full();
    } else if (st.rows !== lastRows) {
      lastRows = st.rows;
      filterAll();
      apply();
    }
  };
  const setup = createSetup(app, st, fromSetup, () => void extract());

  const textOf = (s: Slot, d: SheetDef) => {
    let t = texts.get(s.key);
    if (t === undefined) texts.set(s.key, (t = searchText(s, d, sctx, store)));
    return t;
  };
  /** Column order of a language for the navigator; -1 (before every language) for a key column. */
  const colOf = (l: Lcid) => {
    const i = langs.indexOf(l);
    return i >= 0 ? i : org.includes(l) ? langs.length + org.indexOf(l) : -1;
  };

  // ---- index and filters ----
  const rebuild = () => {
    stale = false;
    ({ by, place, total } = bookOf(store.slots.values(), (k) => store.isEdited(k), loaded, st.labelMode, pinned));
    texts.clear();
  };
  /** The Rows choice in effect: comparing languages needs a target other than the base language. */
  const rowsMode = (): RowsMode => (target === base && (st.rows === 'same' || st.rows === 'sameOrBlank' || st.rows === 'blank') ? 'all' : st.rows);
  const filterAll = () => {
    const test = rowsTest(rowsMode(), store, base, target, langs);
    shown = new Map();
    for (const [id, list] of by) {
      const d = DEF.get(id)!;
      shown.set(id, list.filter((s) => test(s) && (!q.length || hit(textOf(s, d), q))));
    }
  };
  const setCols = () => {
    const d = DEF.get(sheetId);
    if (!d) return;
    const k = `${d.id}|${langs.join()}|${target}`;
    if (k === colsKey) return;
    colsKey = k;
    grid.setSheet(d.id, d.cols, (s) => (d.type ? d.type(s) : s.prop), langs, target);
  };
  /** Hands the active sheet's rows to the grid and redraws what depends on them. */
  const apply = () => {
    rows = shown.get(sheetId) ?? [];
    grid.setRows(rows);
    drawTabs();
    drawState();
    drawCount();
    live();
  };
  /** Rebuilds everything from the store (after an extraction, an import, new slots, other label options). */
  const full = () => {
    rebuild();
    sheetId = st.sheet = pickSheet(sheetId, ORDER, (id) => by.has(id));
    syncToggle();
    setCols();
    filterAll();
    apply();
  };
  const later = rafThrottle(() => active && full());

  // ---- languages (prefs; the title bar's language menu and Setup's Languages box change them) ----
  const syncLangs = (): boolean => {
    const p = app.prefs,
      t = org.includes(p.target) ? p.target : base;
    for (const e of store.edits.values()) for (const l of e.keys()) sticky.add(l);
    const ls = columnLangs(org, base, t, p.shown, sticky);
    if (t === target && ls.join() === langs.join()) return false;
    target = t;
    langs = ls;
    drawRowsSel();
    return true;
  };
  const relang = () => {
    if (!syncLangs()) return;
    setCols();
    filterAll();
    apply();
  };

  // ---- message bar ----
  const mIcon = h('span', { class: 'wb-mic' });
  const mText = h('span', { class: 'wb-mt' });
  const mActs = h('span', { class: 'wb-ma' });
  const mLive = h('div', { class: 'wb-ml', role: 'status', 'aria-live': 'polite' }, mIcon, mText, mActs);
  const toggleB = btn('', () => screen(!setupShown, true), 'sm wb-tgl');
  const msgEl = h('div', { class: 'wb-msg is-info' }, mLive, toggleB);
  let spinning = false;
  const say = (text: string, tone: Tone = 'info', acts: Array<[string, () => void]> = [], busy = false) => {
    msgEl.classList.toggle('is-info', tone === 'info');
    msgEl.classList.toggle('is-ok', tone === 'ok');
    msgEl.classList.toggle('is-err', tone === 'err');
    // Progress updates keep the same spinner (replacing it would restart its animation).
    if (!busy || !spinning) put(mIcon, busy ? spinner() : icon(tone === 'ok' ? 'okc' : tone === 'err' ? 'error' : 'info'));
    spinning = busy;
    mText.textContent = text;
    put(mActs, acts.map(([l, run]) => link(l, run)));
    // While busy, screen readers get the final line instead of every progress step.
    mLive.setAttribute('aria-busy', String(busy));
  };
  const syncToggle = () => {
    toggleB.textContent = setupShown ? 'View spreadsheet' : 'Export options';
    toggleB.hidden = setupShown && !total;
  };

  // ---- header ----
  const headBtn = (ic: IconName, label: string | HTMLElement, run: () => void, cls = '', caret = false) => {
    const t = typeof label === 'string' ? h('span', { class: 'wb-bt' }, label) : label;
    const b = h('button', { class: 'btn wb-hb ' + cls, type: 'button', on: { click: run } }, icon(ic), t, caret && icon('chevron', 12));
    // In a narrow window only the icon shows (workbench.css); the text then stays the accessible name.
    tooltip(b, () => (t.offsetWidth <= 1 ? t.textContent || '' : ''));
    return b;
  };
  const extractB = headBtn('download', 'Extract translations', () => void extract());
  const excelB = headBtn('table', 'Excel', () => excelMenu(), '', true);
  excelB.setAttribute('aria-haspopup', 'menu');
  excelB.setAttribute('aria-expanded', 'false');
  const saveB = headBtn('save', SAVE, () => void save(), 'primary');
  saveB.setAttribute('aria-keyshortcuts', 'Control+S');
  const head = h('div', { class: 'wb-head' }, h('h2', null, 'Translation workbook'), extractB, excelB, saveB);

  // ---- workbook top bar ----
  const filter = h('input', { type: 'search', placeholder: 'Filter rows', 'aria-label': 'Filter rows on every sheet' });
  const refilterSoon = debounce(() => {
    const t = terms(filter.value);
    if (t.join(' ') === q.join(' ')) return;
    q = t;
    filterAll();
    apply();
  }, 150);
  filter.addEventListener('input', refilterSoon);
  // Esc in a search box clears it ('search' fires; 'input' does not in every browser).
  filter.addEventListener('search', refilterSoon);
  filter.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    // Apply what was typed right away (the debounce may not have run yet), then move into the rows.
    refilterSoon.cancel();
    const t = terms(filter.value);
    if (t.join(' ') !== q.join(' ')) {
      q = t;
      filterAll();
      apply();
    }
    if (rows.length) grid.focus();
  });
  const rowsSel = h('select', { class: 'sel wb-rows', 'aria-label': 'Rows', on: { change: () => setRowsMode(rowsSel.value as RowsMode) } });
  const drawRowsSel = () => {
    const bn = langName(app, base),
      tn = langName(app, target),
      cmp = target !== base;
    // Pending changes and Save problems are about saving, not text: a separator sets them apart (as in Setup).
    put(
      rowsSel,
      ROWS.map((m) => (m === '-' ? h('hr') : h('option', { value: m, disabled: !cmp && (m === 'same' || m === 'sameOrBlank' || m === 'blank') }, rowsLabel(m, bn, tn)))),
    );
    rowsSel.value = st.rows;
  };
  const toolsB: HTMLButtonElement = h('button', { class: 'btn wb-tb', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', on: { click: () => toolsMenu() } }, icon('bolt'), h('span', { class: 'wb-bt' }, 'Tools'), icon('chevron', 12));
  tooltip(toolsB, 'Bulk tools for the rows shown on this sheet');
  const undoB = ibtn('undo', 'Undo (Ctrl+Z)', () => store.undo());
  const redoB = ibtn('redo', 'Redo (Ctrl+Y)', () => store.redo());
  const helpB: HTMLButtonElement = h('button', { class: 'btn subtle icon wb-qm', type: 'button', 'aria-label': 'Colors and keys', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', on: { click: () => help() } }, '?');
  tooltip(helpB, 'Colors and keys');
  const upB = ibtn('up', 'Previous pending change', () => go(-1), '');
  const midB: HTMLButtonElement = h('button', { class: 'btn wb-pc', type: 'button', on: { click: () => go(1) } });
  tooltip(midB, 'Go to the next pending change');
  const downB = ibtn('down', 'Next pending change', () => go(1), '');
  const top = h(
    'div',
    { class: 'wb-top' },
    h('div', { class: 'input wb-q' }, icon('search'), filter),
    rowsSel,
    cnt,
    seli,
    h('span', { class: 'wb-sp' }),
    toolsB,
    undoB,
    redoB,
    helpB,
    h('div', { class: 'wb-nav', role: 'group', 'aria-label': 'Pending changes' }, upB, midB, downB),
  );

  // ---- grid area, empty states, sheet tabs ----
  const empty = h('div', { class: 'wb-empty', hidden: true });
  const panel = h('div', { class: 'wb-grid', role: 'tabpanel', id: 'wb-panel' }, grid.el, empty);
  // A cell editor holds typed text that reaches the store only when it is committed (Enter, Tab, leaving the
  // cell). Save stays usable meanwhile, as in the old workbook, so the very first translation can be saved
  // straight from the cell: save() commits it first.
  let typing = false;
  const typed = (on: boolean) => {
    if (typing !== on) (typing = on), live();
  };
  panel.addEventListener('input', (e) => e.target instanceof HTMLTextAreaElement && typed(true));
  // Leaving the editor, or Esc (it removes the editor and focuses the grid), ends it.
  panel.addEventListener('focusout', (e) => e.target instanceof HTMLTextAreaElement && typed(false));
  panel.addEventListener('focusin', (e) => !(e.target instanceof HTMLTextAreaElement) && typed(false));
  const strip = h('div', { class: 'wb-tabs', role: 'tablist', 'aria-label': 'Sheets' });
  // The mouse wheel scrolls the sheet tabs sideways, besides their scrollbar.
  strip.addEventListener(
    'wheel',
    (e) => {
      if (e.deltaX || e.shiftKey || strip.scrollWidth <= strip.clientWidth) return;
      strip.scrollLeft += e.deltaY;
      e.preventDefault();
    },
    { passive: false },
  );
  const tabs = new Map<string, Tab>();
  for (const d of SHEETS) {
    const t = document.createTextNode(d.name);
    const dot = h('i', { class: 'wb-dot', hidden: true, title: 'Has pending changes' }, h('span', { class: 'vh' }, ', has pending changes'));
    const b = h('button', { class: 'wb-tab', type: 'button', role: 'tab', id: `wb-tab-${d.id}`, 'aria-controls': 'wb-panel', 'aria-selected': 'false', tabIndex: -1, hidden: true, on: { click: () => selectSheet(d.id) } }, t, dot);
    tabs.set(d.id, { b, t, dot });
    strip.append(b);
  }
  strip.addEventListener('keydown', (e) => {
    const vis = ORDER.filter((id) => by.has(id)),
      i = vis.indexOf(sheetId),
      j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? vis.length - 1 : null;
    if (j === null || !vis.length) return;
    e.preventDefault();
    const id = vis[(j + vis.length) % vis.length];
    selectSheet(id);
    tabs.get(id)?.b.focus();
  });
  const drawTabs = () => {
    const counts = tabCounts(shown);
    for (const d of SHEETS) {
      const x = tabs.get(d.id)!,
        has = by.has(d.id);
      x.b.hidden = !has;
      if (!has) continue;
      const n = counts.get(d.id) ?? 0,
        on = d.id === sheetId;
      x.t.textContent = `${d.name} (${n.toLocaleString()})`;
      // Filtered to nothing: still listed (counts are match counts), but dimmed.
      x.b.classList.toggle('is-zero', n === 0);
      x.b.classList.toggle('is-on', on);
      x.b.setAttribute('aria-selected', String(on));
      x.b.tabIndex = on ? 0 : -1;
    }
    panel.setAttribute('aria-labelledby', `wb-tab-${sheetId}`);
  };
  /** Keeps the active tab in view without scrolling anything but the strip. */
  const showTab = () => {
    const b = tabs.get(sheetId)?.b;
    if (!b || b.hidden) return;
    const l = b.offsetLeft,
      r = l + b.offsetWidth;
    if (l < strip.scrollLeft) strip.scrollLeft = l - 8;
    else if (r > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = r - strip.clientWidth + 8;
  };
  const drawState = () => {
    const s = !total ? (loading ? 'busy' : 'none') : rows.length ? '' : 'nomatch';
    grid.el.hidden = !!s;
    empty.hidden = !s;
    const key = s === 'nomatch' ? `${s}|${sheetId}|${[...shown.values()].map((a) => a.length).join()}` : s;
    if (key === stateKey) return;
    stateKey = key;
    if (s === 'busy') put(empty, skeleton(8));
    else if (s === 'none') put(empty, emptyState('table', 'Nothing extracted yet', 'Extract translations to populate the workbook tabs.', [btn('Export options', () => screen(true, true), 'primary')]));
    else if (s === 'nomatch') {
      const other = SHEETS.find((d) => d.id !== sheetId && shown.get(d.id)?.length);
      put(
        empty,
        emptyState(
          'filter',
          'No rows match',
          other ? 'Other sheets have rows that match: see the counts on the tabs.' : 'No rows on any sheet match the filter.',
          [btn('Clear filter', () => clearFilters()), other ? btn(`Show ${other.name}`, () => selectSheet(other.id)) : null].filter((x): x is HTMLButtonElement => !!x),
        ),
      );
    } else put(empty);
  };
  const drawCount = () => {
    const all = by.get(sheetId)?.length ?? 0;
    cnt.textContent = all && (q.length || rowsMode() !== 'all') ? `${rows.length.toLocaleString()} of ${plural(all, 'row')}` : '';
  };
  const selectSheet = (id: string, restore = true) => {
    if (!by.has(id)) return;
    const moved = id !== sheetId;
    if (moved) {
      const c = grid.cursor();
      if (c) mem.set(sheetId, c);
      sheetId = st.sheet = id;
      persist();
    }
    setCols();
    apply();
    showTab();
    const m = moved && restore ? mem.get(id) : undefined;
    if (m) grid.reveal(m.key, m.lcid);
  };

  // ---- screens: Setup ("Export options") or the workbook ----
  const setupBox = h('div', { class: 'wb-setup' }, setup.el);
  const book = h('div', { class: 'wb-book' }, top, panel, strip);
  /** `user`: the user chose this screen (remembered); otherwise it is only what can be shown now. */
  const screen = (on: boolean, user = false) => {
    if (on && !setupShown) grid.commit();
    setupShown = on;
    if (user) (st.setup = on), persist();
    setupBox.hidden = !on;
    book.hidden = on;
    syncToggle();
    if (!on) {
      grid.refresh();
      showTab();
    }
  };
  const setRowsMode = (m: RowsMode, jump = false) => {
    st.rows = lastRows = m;
    rowsSel.value = m;
    persist();
    setup.sync();
    if (setupShown) screen(false, true);
    filterAll();
    if (jump && !shown.get(sheetId)?.length) {
      const f = SHEETS.find((d) => shown.get(d.id)?.length);
      if (f) return selectSheet(f.id);
    }
    apply();
  };
  const clearFilters = () => {
    refilterSoon.cancel();
    q = [];
    filter.value = '';
    setRowsMode('all');
  };

  // ---- live state: pending count, buttons, tab dots (on every store change) ----
  const live = rafThrottle(() => {
    const n = store.pendingCount(),
      busy = store.busy;
    midB.textContent = n ? plural(n, 'pending change') : 'No pending changes';
    midB.classList.toggle('is-has', n > 0);
    upB.disabled = downB.disabled = midB.disabled = !n;
    saveB.disabled = busy || loading || (!n && !typing);
    extractB.disabled = busy || loading;
    undoB.disabled = busy || !store.canUndo();
    redoB.disabled = busy || !store.canRedo();
    const dots = new Set<number>();
    for (const k of store.edits.keys()) {
      const p = place.get(k);
      if (p) dots.add(p[0]);
    }
    SHEETS.forEach((d, i) => (tabs.get(d.id)!.dot.hidden = !dots.has(i)));
  });

  // ---- revealing a slot: switch to its sheet and clear the filters that hide it ----
  // Rows are matched by key: a reload replaces the slot objects (store.add) before the workbook is rebuilt.
  const reveal = (s0: Slot, lcid: Lcid | undefined, flash: boolean): { r: number; note: string } => {
    const s = store.get(s0.key) ?? s0,
      k = s.key;
    let note = '';
    if (!place.has(k)) {
      pinned.add(k);
      full();
    }
    const id = SHEETS[place.get(k)?.[0] ?? -1]?.id ?? sheetOf(s).id,
      d = DEF.get(id);
    if (setupShown) screen(false, true);
    const u = unhide(!!shown.get(id)?.some((x) => x.key === k), rowsTest(rowsMode(), store, base, target, langs)(s), !q.length || !d || hit(textOf(s, d), q));
    if (u.rows) {
      st.rows = lastRows = 'all';
      rowsSel.value = 'all';
      persist();
      setup.sync();
      note += ' Rows is now set to All rows so that it shows.';
    }
    if (u.text) {
      refilterSoon.cancel();
      q = [];
      filter.value = '';
      note += ' Filter rows was cleared so that it shows.';
    }
    if (u.refilter) filterAll();
    if (id !== sheetId) selectSheet(id, false);
    else if (u.refilter) apply();
    grid.reveal(k, lcid ?? target, flash);
    return { r: rows.findIndex((x) => x.key === k) + 1, note };
  };

  // ---- pending navigator: ↑ / N pending changes / ↓ ----
  const go = (dir: 1 | -1) => {
    grid.commit();
    // An edit made outside the workbook (e.g. on the page, or restored by undo) joins it first.
    for (const k of store.edits.keys())
      if (!place.has(k) && store.slots.has(k)) {
        full();
        break;
      }
    if (syncLangs()) setCols(), filterAll(), apply();
    const cells: Array<[string, Lcid]> = [];
    for (const [k, e] of store.edits) for (const l of e.keys()) cells.push([k, l]);
    const L = pendingLocs(cells, (k) => place.get(k), colOf);
    if (!L.length) return say('No pending translation changes.', 'info');
    // From the grid's cursor when it is on this sheet, else from the change visited last.
    let ref = navRef;
    const c = setupShown ? null : grid.cursor(),
      p = c && place.get(c.key);
    if (c && p && p[0] === SI.get(sheetId)) ref = { s: p[0], r: p[1], l: colOf(c.lcid), key: c.key, lcid: c.lcid };
    const i = navStep(L, ref, dir),
      x = (navRef = L[i]),
      s = store.get(x.key);
    if (!s) return;
    const { r, note } = reveal(s, x.lcid, true);
    say(`Pending change ${i + 1} of ${L.length}: ${DEF.get(sheetId)?.name ?? ''} row ${r}, ${langName(app, x.lcid)} Label.${note}`, 'info');
  };

  /** A button that disabled itself (Extract while loading, Save with nothing left) loses the focus: put it back. */
  const keepFocus = (to: () => HTMLElement | { focus(): void }) =>
    requestAnimationFrame(() => {
      const a = app.root.activeElement as HTMLButtonElement | null;
      if (!destroyed && active && (!a || a.disabled)) to().focus();
    });

  // ---- Extract translations ----
  /** Behind an extraction or import that read forms: what their related menu items show (navSources), quietly. */
  const bg = new AbortController();
  const navLoad = (sc: Scope) => {
    if (sc.kinds.has('navitem'))
      navSources(app, bg.signal).catch((e) => {
        if (__DEV__ && !isAbort(e)) console.error('[translator]', e);
      });
  };
  const extract = async () => {
    if (loading) return;
    if (store.busy) return say('Wait for the save to finish, then extract translations.', 'info');
    grid.commit();
    let sc: Scope | string;
    try {
      sc = setup.scope();
    } catch (e) {
      sc = errMsg(e);
    }
    if (typeof sc === 'string') {
      screen(true, true);
      // Waiting for the entity list is no error; its line goes once the list is in (fromSetup).
      const wait = waitsForList(sc);
      waitLine = wait ? sc : '';
      return say(sc, wait ? 'info' : 'err');
    }
    const scope = sc,
      kept = store.pendingCount(),
      ctl = (ac = new AbortController()),
      stop: [string, () => void] = ['Stop', () => ctl.abort()],
      t0 = performance.now();
    let warn = '',
      n = 0;
    loading = true;
    live();
    drawState();
    say('Extracting translations…', 'info', [stop], true);
    try {
      n = await app.load(scope, {
        signal: ctl.signal,
        onProgress: (m, d, t) => {
          if (ctl.signal.aborted || destroyed) return;
          // Partial failures: the rows that did load are kept; the message stays for the final line.
          if (/^Loaded with problems|could not be loaded/i.test(m)) warn = m;
          else say(t ? `${m} ${(d ?? 0).toLocaleString()} of ${t.toLocaleString()}` : m, 'info', [stop], true);
        },
        // A failed or stopped load says so in the result line instead of "nothing extracted".
        onError: (m) => (warn = m),
      });
    } catch (e) {
      if (!isAbort(e)) warn ||= errMsg(e); // app.load reports its own failures; this is a safety net
    } finally {
      loading = false;
      if (ac === ctl) ac = null;
    }
    if (destroyed) return;
    live();
    if (ctl.signal.aborted || !n) {
      drawState();
      keepFocus(() => extractB);
      if (ctl.signal.aborted) return say('Extraction stopped. Nothing new was loaded.', 'info');
      return say(warn || nothingExtracted(!!scope.includeReadOnly), 'err');
    }
    loaded = { kinds: new Set(scope.kinds), ents: new Set(scope.entities), ro: !!scope.includeReadOnly };
    navLoad(scope);
    refilterSoon.cancel();
    q = [];
    filter.value = '';
    full();
    if (!total) {
      screen(true);
      keepFocus(() => extractB);
      return say('None of the extracted labels can be shown with these options (label options, read-only labels). Change them, then extract again.', 'err');
    }
    screen(false, true);
    // A Rows choice (remembered from an earlier session) may hide every row of this sheet: show one that has rows.
    if (!rows.length) {
      const f = ORDER.find((id) => shown.get(id)?.length);
      if (f) selectSheet(f, false);
    }
    let vis = 0;
    for (const a of shown.values()) vis += a.length;
    const hid = vis < total ? ` Rows is set to “${rowsLabel(rowsMode(), langName(app, base), langName(app, target))}”: ${vis.toLocaleString()} of them ${vis === 1 ? 'is' : 'are'} shown.` : '';
    // Edits that now equal the server value were dropped by the reload (store.add); the rest are kept.
    const k = kept && store.pendingCount();
    // Form labels a language could not be read for, even when the loader tried again: said, with Read again.
    const note = unread();
    const acts: Array<[string, () => void]> = hid ? [['Show all rows', () => setRowsMode('all')]] : [];
    if (note) acts.push(readAgain);
    say(
      `Extracted ${plural(total, 'row')} in ${took(performance.now() - t0)}.${hid}${k ? ` Your ${plural(k, 'pending change')} ${k === 1 ? 'is' : 'are'} kept.` : ''}${warn ? ` ${warn}` : ''}${note ? ` ${unreadLine(note, (l) => langName(app, l))}` : ''}`,
      warn || note ? 'err' : 'ok',
      acts,
    );
    grid.focus();
  };

  // ---- form labels not read: Read again reads only those forms, in only those languages ----
  /** The workbook's form labels whose read failed (formNote), languages in the org's order. */
  const unread = (): FormNote | null => {
    const n = formNote(allRows());
    if (n) n.langs.sort((a, b) => org.indexOf(a) - org.indexOf(b));
    return n;
  };
  const reread = async () => {
    if (loading) return;
    if (store.busy) return say('Wait for the save to finish, then read the form labels again.', 'info');
    const note = unread();
    if (!note) return say('Every form label of the workbook is loaded.', 'ok');
    grid.commit();
    const ctl = (ac = new AbortController()),
      stop: [string, () => void] = ['Stop', () => ctl.abort()],
      n = note.forms.length;
    let warn = '';
    loading = true;
    live();
    say(`Reading ${plural(n, 'form')} again…`, 'info', [stop], true);
    try {
      // Read as of now: a save or page load that lands while it reads is newer, and keeps its text (store.add since).
      const since = store.tick();
      const slots = await app.providers.loadFormXml(ctx, note.forms, note.langs, {
        signal: ctl.signal,
        lang: app.lang,
        progress: (m, d, t) => {
          if (ctl.signal.aborted || destroyed) return;
          if (/^Loaded with problems/.test(m)) warn = m;
          else say(t ? `${m} ${(d ?? 0).toLocaleString()} of ${t.toLocaleString()}` : m, 'info', [stop], true);
        },
      });
      // The languages read before keep what was read then (only the missing ones were asked for); edits stay.
      if (slots.length) store.add(mergeReads(slots, (k) => store.get(k), org), since);
    } catch (e) {
      if (!isAbort(e)) warn = errMsg(e);
    } finally {
      loading = false;
      if (ac === ctl) ac = null;
    }
    if (destroyed) return;
    live();
    if (ctl.signal.aborted) return say('Stopped. Nothing new was read.', 'info');
    full();
    const left = unread();
    if (left) say(`${unreadLine(left, (l) => langName(app, l))}${warn ? ` ${warn}` : ''}`, 'err', [readAgain]);
    else say(`Read ${plural(n, 'form')} again: ${n === 1 ? 'it is' : 'they are'} now loaded in every language.${warn ? ` ${warn}` : ''}`, warn ? 'err' : 'ok');
  };
  const readAgain: [string, () => void] = ['Read again', () => void reread()];

  // ---- Save and Publish ----
  /** Rows › Save problems or Pending changes, with "Filter rows" cleared so none of them is hidden. */
  const showRows = (m: RowsMode) => {
    refilterSoon.cancel();
    q = [];
    filter.value = '';
    setRowsMode(m, true);
  };
  const save = async () => {
    grid.commit();
    // A save while labels load could miss edits the load is about to bring back; app.review() itself waits for
    // saves started on the page and refuses a second save.
    if (loading) return say('Wait for the labels to finish loading, then save.', 'info');
    if (!store.pendingCount()) return say('No pending translation changes to save.', 'info');
    // The review dialog validates, warns about others' unpublished work, saves, verifies and publishes.
    const rep = await app.review();
    if (destroyed) return;
    live();
    if (!rep) return;
    let stuck = false;
    for (const v of store.status.values()) if (v.outcome === 'conflict' || v.outcome === 'error') stuck = true;
    const r = saveLine(rep, { left: store.pendingCount() });
    say(r.text, r.tone, r.problems || (r.pending && stuck) ? [['Show problems', () => showRows('problems')]] : r.pending ? [['Show pending changes', () => showRows('pending')]] : []);
    keepFocus(() => (setupShown ? toggleB : grid));
  };

  // ---- Excel: download and import ----
  const allRows = () => ORDER.flatMap((id) => by.get(id) ?? []);
  /** Downloads carry the pending edits, so a file can be shared before saving. */
  const withEdits = (list: Slot[]) =>
    list.map((s) => {
      const e = store.edits.get(s.key);
      return e ? { ...s, labels: { ...s.labels, ...Object.fromEntries(e) } } : s;
    });
  const download = (b: Blob, name: string) => {
    const u = URL.createObjectURL(b),
      a = h('a', { href: u, download: name, hidden: true });
    el.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  };
  const exp = async (k: 'book' | 'sheet' | 'csv') => {
    grid.commit();
    const list = k === 'sheet' ? rows : allRows();
    if (!list.length) return say('Nothing to download yet. Extract translations first.', 'info');
    const name = `Translations ${ctx.org}${k === 'sheet' ? ` ${DEF.get(sheetId)?.name ?? ''}` : ''} ${new Date().toISOString().slice(0, 10)}.${k === 'csv' ? 'csv' : 'xlsx'}`;
    say('Preparing the file…', 'info', [], true);
    try {
      const slots = withEdits(list);
      download(k === 'csv' ? app.io.exportCsv(slots, langs) : await app.io.exportWorkbook(slots, langs, name), name);
      const n = store.pendingCount();
      say(`Downloaded ${name}: ${plural(list.length, 'row')} in ${plural(langs.length, 'language')}.${n ? ' Pending changes are in the file; they are not saved yet.' : ''}`, 'ok');
    } catch (e) {
      say(`The download failed: ${errMsg(e)}`, 'err');
    }
  };
  const skippedRows = (list: ImportRow[], file: string) =>
    void app.modal(
      'Skipped rows',
      (close) => {
        const fr = document.createDocumentFragment();
        fr.append(
          h(
            'div',
            { class: 'dlg-body wb-tool' },
            h('p', null, skippedIntro(list.length, file)),
            h(
              'div',
              { class: 'wb-pl' },
              list.slice(0, 500).map((r) => h('div', null, h('small', null, `${r.sheet} · row ${r.row}`), r.reason || 'Not matched')),
              list.length > 500 && h('small', { class: 'wb-more' }, `…and ${(list.length - 500).toLocaleString()} more`),
            ),
          ),
          h('div', { class: 'dlg-actions' }, h('button', { class: 'btn primary', type: 'button', 'data-af': true, on: { click: () => close() } }, 'Close')),
        );
        return fr;
      },
      { wide: true },
    );
  const imp = async (file: File) => {
    grid.commit();
    if (loading || store.busy) return;
    const ctl = (ac = new AbortController()),
      stop: [string, () => void] = ['Stop', () => ctl.abort()];
    loading = true;
    live();
    say(`Reading ${file.name}…`, 'info', [], true);
    // A failed (or partly failed) load leaves rows of the file unmatched: the result line says why.
    let lerr = '';
    try {
      const p = await app.io.parse(file),
        // Languages that are not provisioned here can't be saved; io.apply stages only p.languages.
        drop = p.languages.filter((l) => !org.includes(l));
      p.languages = p.languages.filter((l) => org.includes(l));
      if (!p.languages.length) throw new Error(`it has no columns for the languages of this environment (${ctx.langs.map((x) => x.name).join(', ')}).`);
      if (p.scope.kinds.size) {
        say(`Loading the labels named in ${file.name}…`, 'info', [stop], true);
        await app.load(p.scope, {
          signal: ctl.signal,
          onProgress: (m, d, t) => {
            if (ctl.signal.aborted || destroyed) return;
            if (/^Loaded with problems|could not be loaded/i.test(m)) lerr = m;
            else say(t ? `${m} ${(d ?? 0).toLocaleString()} of ${t.toLocaleString()}` : m, 'info', [stop], true);
          },
          onError: (m) => (lerr = m),
        });
        if (ctl.signal.aborted) return say(`Import of ${file.name} stopped. Nothing was staged.`, 'info');
        // The file's scope loads read-only labels too (only to skip their rows with the reason): loaded.ro is kept, so
        // they show only where the extraction asked for read-only labels.
        if (loaded) {
          for (const k of p.scope.kinds) loaded.kinds.add(k);
          for (const e of p.scope.entities) loaded.ents.add(e);
        }
        navLoad(p.scope);
      }
      // Which cells the file stages (io.apply does it in one store.group: one undo step).
      const before = new Map([...store.edits].map(([k, e]) => [k, new Map(e)] as const));
      const r = app.io.apply(p, store),
        sk = r.skipped.length,
        add = p.languages.filter((l) => !app.prefs.shown.includes(l) && l !== base);
      if (add.length) app.savePrefs({ shown: [...app.prefs.shown, ...add] });
      syncLangs();
      full();
      // Form labels a language could not be read for: their rows were skipped (the cell says why), Read again reads them.
      const unreadNote = p.scope.kinds.size ? unread() : null;
      const dropped =
        (drop.length ? ` Columns for languages not installed here were ignored: ${drop.map(lcidName).join(', ')}.` : '') +
        (lerr ? ` ${lerr}` : '') +
        (unreadNote ? ` ${unreadLine(unreadNote, (l) => langName(app, l))}` : '');
      const acts: Array<[string, () => void]> = sk ? [['Show skipped rows', () => skippedRows(r.skipped, file.name)]] : [];
      if (unreadNote) acts.push(readAgain);
      if (r.staged) {
        // Show the first staged cell, in workbook order.
        const cells: Array<[string, Lcid]> = [];
        for (const [k, e] of store.edits) for (const [l, v] of e) if (before.get(k)?.get(l) !== v) cells.push([k, l]);
        const first = pendingLocs(cells, (k) => place.get(k), colOf)[0],
          s = first && store.get(first.key);
        let note = '';
        if (s) ({ note } = reveal(s, first.lcid, true));
        else screen(false, true);
        say(`${plural(r.staged, 'change')} staged from ${file.name}${sk ? ` (${plural(sk, 'row')} skipped)` : ''}. Nothing is saved until you select ${SAVE}.${note}${dropped}`, lerr || unreadNote ? 'err' : 'ok', acts);
        grid.focus();
      } else
        say(
          `No changes in ${file.name}${r.unchanged ? `: ${plural(r.unchanged, 'cell')} already ${r.unchanged === 1 ? 'matches' : 'match'}` : ''}${sk ? `${r.unchanged ? ',' : ':'} ${plural(sk, 'row')} skipped` : ''}.${dropped}`,
          sk || drop.length || lerr || unreadNote ? 'err' : 'info',
          acts,
        );
    } catch (e) {
      say(isAbort(e) ? `Import of ${file.name} stopped. Nothing was staged.` : `Couldn't import ${file.name}: ${errMsg(e)}`, isAbort(e) ? 'info' : 'err');
    } finally {
      loading = false;
      if (ac === ctl) ac = null;
      live();
      drawState();
    }
  };
  const fileIn: HTMLInputElement = h('input', {
    type: 'file',
    accept: '.xlsx,.csv',
    hidden: true,
    on: {
      change: () => {
        const file = fileIn.files?.[0];
        fileIn.value = '';
        if (file) void imp(file);
      },
    },
  });
  const excelMenu = () => {
    const sheet = DEF.get(sheetId),
      ls = `${plural(langs.length, 'language')}`,
      none = total ? '' : 'Extract translations first';
    pop = menu(excelB, [
      { label: 'Download workbook (.xlsx)', icon: 'download', hint: none || `Every sheet, ${plural(total, 'row')}, ${ls}. Easy Translator compatible`, disabled: !total, run: () => void exp('book') },
      {
        label: 'Download this sheet (.xlsx)',
        icon: 'download',
        hint: none || `${sheet?.name ?? 'This sheet'}: the ${plural(rows.length, 'row')} shown, ${ls}`,
        disabled: !rows.length,
        run: () => void exp('sheet'),
      },
      { label: 'Download CSV (.csv)', icon: 'download', hint: none || `Every sheet, ${plural(total, 'row')}, ${ls}`, disabled: !total, run: () => void exp('csv') },
      '-',
      {
        label: 'Import workbook or CSV…',
        icon: 'upload',
        hint: loading ? 'Wait for the current load to finish' : 'Easy Translator or this tool’s workbook, or a CSV file. Changes are staged, not saved',
        disabled: loading || store.busy,
        run: () => fileIn.click(),
      },
    ]);
  };
  const toolsMenu = () => {
    const sheet = DEF.get(sheetId);
    const items: MenuItem[] = [{ head: rows.length ? `${sheet?.name ?? 'This sheet'}: ${plural(rows.length, 'row')} shown` : 'No rows shown on this sheet' }];
    for (const [id, ic, t, sub] of TOOLS) {
      const why = rows.length ? '' : 'Nothing to work on';
      items.push({ label: t, icon: ic, hint: why || sub, disabled: !!why, run: () => (grid.commit(), openTool(app, id, rows, langs, target)) });
    }
    pop = menu(toolsB, items);
  };
  const help = () => {
    const d = DEF.get(sheetId);
    pop = popover(
      helpB,
      h(
        'div',
        { class: 'wb-help' },
        d?.help && h('p', { class: 'wb-hs' }, h('b', null, `${d.name}: `), d.help),
        h('div', { class: 'wb-ph' }, 'Colors'),
        h('div', { class: 'wb-lg' }, LEGEND.map(([c, t]) => h('div', null, h('i', { class: 'wb-sw ' + c, 'aria-hidden': 'true' }, c === 'c-ok' ? icon('check', 12) : c === 'c-mi' ? '—' : c === 'c-bad' ? '!' : c === 'c-cf' ? '?' : null), h('span', null, t)))),
        h('div', { class: 'wb-ph' }, 'Keys'),
        h('p', { class: 'wb-hs' }, 'Click a cell to edit it.'),
        h('div', { class: 'wb-keys' }, KEYS.map(([ks, t]) => [h('span', null, ks.map((k, i) => [i ? ' ' : '', h('kbd', null, k)])), h('span', null, t)])),
      ),
      { cls: 'wb-pop', label: 'Colors and keys' },
    );
  };

  // ---- layout ----
  const main = h('div', { class: 'wb-main' }, msgEl, setupBox, book);
  const el = h('div', { class: 'wb' }, head, main, fileIn);
  // Ctrl+S here runs Save and Publish with the result line in the message bar (the app's handler sees the
  // event as handled); Ctrl+F filters rows. The app also sends Ctrl+F pressed in the title bar as 'dxt-search'.
  el.addEventListener('keydown', (e) => {
    if (e.isComposing || e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = (e.key || '').toLowerCase();
    if (k === 's') e.preventDefault(), void save();
    else if (k === 'f') e.preventDefault(), find();
  });
  const find = () => {
    if (setupShown) {
      if (!total) return say('Extract translations first: Filter rows then finds rows on every sheet.', 'info');
      screen(false, true);
    }
    filter.focus();
    filter.select();
  };
  el.addEventListener('dxt-search', find);
  // Ctrl+S pressed outside the workbook (the title bar) arrives from the app as 'dxt-save'.
  el.addEventListener('dxt-save', () => void save());
  const onPrefs = (e: Event) => {
    const p = (e as CustomEvent<Partial<{ shown: unknown; target: unknown }>>).detail || {};
    if ('shown' in p || 'target' in p) sticky.clear();
    if (!active) return void (stale = true);
    setup.sync();
    relang();
    grid.refresh();
  };
  app.root.host.addEventListener('dxt-prefs', onPrefs);

  const off = store.on((e) => {
    if (e.type === 'busy') return live();
    if (!active) return void (stale = true);
    if (e.type === 'slots') return later();
    if (e.type === 'edit') {
      texts.delete(e.key);
      if (store.isEdited(e.key) && !place.has(e.key) && store.slots.has(e.key)) later();
      if (!langs.includes(e.lcid) && store.isEdited(e.key, e.lcid)) relang();
    } else if (e.type === 'edits') {
      texts.clear();
      for (const k of store.edits.keys())
        if (!place.has(k) && store.slots.has(k)) {
          later();
          break;
        }
      relang();
    }
    // Rows are not re-filtered while editing: a row never vanishes under the cursor.
    grid.refresh();
    live();
  });

  ready = true;
  syncLangs();
  drawRowsSel();
  say(IDLE);
  screen(true);

  return {
    el,
    footer: false,
    activate() {
      active = true;
      // Table display names arrive with the entity list: "Filter rows" finds rows by them from then on.
      setup.init().then(
        () => texts.clear(),
        (e) => say(errMsg(e), 'err'),
      );
      setup.sync();
      const changed = syncLangs();
      if (stale) full();
      else if (changed) setCols(), filterAll(), apply();
      else grid.refresh(), live();
      screen(st.setup || !total);
    },
    deactivate() {
      active = false;
      grid.commit();
      pop?.close();
      pop = null;
    },
    destroy() {
      destroyed = true;
      off();
      app.root.host.removeEventListener('dxt-prefs', onPrefs);
      refilterSoon.cancel();
      ac?.abort();
      bg.abort();
      pop?.close();
      grid.destroy();
      setup.destroy();
      el.remove();
    },
    edit(comp, l) {
      const list = compSlots(store, comp);
      if (!list.length) return false;
      grid.commit();
      // The cell a review "Fix" link points at (it names the component and the language, not the property): a
      // conflict, a failed save or a blank Dataverse refuses there first, then an edit there.
      const s = fixSlot(
        list,
        l,
        (x) => {
          const o = store.cellStatus(x.key, l!)?.outcome;
          return o === 'conflict' || o === 'error' || clearing(store, x, l!, base) === 'blocked';
        },
        (x) => store.isEdited(x.key, l!),
      )!;
      if (l !== undefined && !langs.includes(l) && org.includes(l)) {
        app.savePrefs({ shown: [...app.prefs.shown, l] });
        relang();
      }
      const { note } = reveal(s, l, true);
      if (note) say(note.trim(), 'info');
      grid.focus();
      return true;
    },
  };
}
