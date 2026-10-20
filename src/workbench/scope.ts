// Setup screen of the Workbench ("Export options"), rebuilt as the XrmToolBox Easy Translator
// bookmarklet: an "Entities options" card (load source, solution, filter, the entity list) next to the
// option boxes (Global Options, Languages, Entity related options, Label options). It only decides what
// to extract; the Workbench's "Extract translations" button runs scope(). Choices are remembered per org.

import { isAbort } from '../core/http';
import { pick } from '../core/labels';
import type { Lcid } from '../core/model';
import { fold, hit, terms } from '../core/search';
import type { Scope, SolutionInfo, TableInfo } from '../providers/types';
import { debounce, h, plural, put } from '../ui/dom';
import { langName } from '../ui/editor';
import type { AppApi } from '../ui/types';
import { tooltip } from '../ui/widgets';
import css from './setup.css';
import { kindsOf, ROWS_MODES, rowsLabel, SETUP_GROUPS } from './sheets';
import type { LabelMode, RowsMode, SetupApi, SetupOpt, WbState } from './types';

export type { WbState };
export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- remembered state ----

const KEY = (org: string) => `dxt:wb2:${org}`;
const LABEL_MODES: LabelMode[] = ['both', 'names', 'descriptions'];
const OPTS = [...SETUP_GROUPS.entity, ...SETUP_GROUPS.global];

const defaults = (): WbState => ({
  source: 'all',
  sol: '',
  solName: '',
  tables: [],
  opts: Object.fromEntries(OPTS.map((o) => [o.id, o.def])),
  labelMode: 'both',
  rows: 'all',
  ro: false,
  widths: {},
  sheet: '',
  setup: true,
});

/** The Workbench state of an org (localStorage `dxt:wb2:<org>`); anything missing or malformed gets its default. */
export function loadState(org: string): WbState {
  const d = defaults();
  let s: Record<string, unknown> = {};
  try {
    const v = JSON.parse(localStorage.getItem(KEY(org)) || '{}');
    if (v && typeof v === 'object' && !Array.isArray(v)) s = v;
  } catch {
    /* storage blocked or corrupt: defaults */
  }
  const str = (k: 'sol' | 'solName' | 'sheet' | 'tablesFor') => {
    if (typeof s[k] === 'string') d[k] = s[k] as string;
  };
  str('sol');
  str('solName');
  str('sheet');
  str('tablesFor');
  if (s.source === 'all' || s.source === 'solution') d.source = s.source;
  if (Array.isArray(s.tables)) d.tables = [...new Set(s.tables.filter((t): t is string => typeof t === 'string' && !!t))];
  if (s.opts && typeof s.opts === 'object') for (const o of OPTS) if (typeof (s.opts as Record<string, unknown>)[o.id] === 'boolean') d.opts[o.id] = (s.opts as Record<string, boolean>)[o.id];
  if (LABEL_MODES.includes(s.labelMode as LabelMode)) d.labelMode = s.labelMode as LabelMode;
  if (ROWS_MODES.includes(s.rows as RowsMode)) d.rows = s.rows as RowsMode;
  if (typeof s.ro === 'boolean') d.ro = s.ro;
  if (typeof s.setup === 'boolean') d.setup = s.setup;
  if (s.widths && typeof s.widths === 'object')
    for (const [k, v] of Object.entries(s.widths as Record<string, unknown>)) if (typeof v === 'number' && isFinite(v) && v > 0) d.widths[k] = v;
  return d;
}

export function saveState(org: string, st: WbState): void {
  try {
    localStorage.setItem(KEY(org), JSON.stringify(st));
  } catch {
    /* storage full or blocked: choices are simply not remembered */
  }
}

/** The entity list of the Setup screen: not listed yet (or failed), loading, listed but empty, or showing tables. */
export type EntityList = 'none' | 'loading' | 'empty' | 'shown';

const WAIT = 'Wait for ';
/** A scopeOf answer that only asks to wait for the entity list to load: no error (the message bar says it as information). */
export const waitsForList = (msg: string): boolean => msg.startsWith(WAIT);

/** The load source an entity list belongs to (WbState.tablesFor): 'all', or 'solution|<id>'. */
export const listKey = (st: Pick<WbState, 'source' | 'sol'>): string => (st.source === 'solution' ? `solution|${st.sol}` : 'all');

/**
 * What "Extract translations" loads for the Setup choices (`checked` = the checked entities), or the old tool's
 * error text. "Global OptionSets" lists every global choice of the environment, as the old tool did; in a
 * solution, the solution's global choices plus those the checked entities use. `listedFor`: the load source the
 * entities were checked in (WbState.tablesFor). Checked in another one (the load source or the solution was just
 * changed), they are not known to be this one's tables, so nothing that uses them is extracted until its list is in:
 * extracting them under a solution would load tables outside it.
 */
export function scopeOf(st: WbState, checked: readonly string[], list: EntityList, listedFor = listKey(st)): Scope | string {
  const solution = st.source === 'solution';
  if (solution && !st.sol) return 'Select a solution, then click Load Entities.';
  const kinds = kindsOf(st.opts);
  if (!kinds.size) return 'Choose at least one kind of translation to export.';
  const needs = OPTS.some((o) => o.needsTable && (st.opts[o.id] ?? o.def));
  if (listedFor !== listKey(st) && (checked.length || needs)) {
    const what = solution ? `the tables of ${st.solName || 'the solution'}` : 'the entity list';
    const it = solution ? 'this solution' : 'it';
    // A newly picked solution lists its tables unchecked (Setup list() clear): there is nothing left to extract then. A
    // switched load source keeps the checks it lists.
    const kept = checked.length > 0 && !(solution && listedFor.startsWith('solution|'));
    const then = kept ? 'extract translations' : 'check the entities to extract';
    if (list === 'loading') return `${WAIT}${what} to load, then ${then}${kept ? `: the entities checked before may not be in ${it}` : ''}.`;
    return `Couldn't read ${what}${kept ? `, so the entities checked before can't be extracted from ${it}` : ''}. Select Try again under the entity list, then ${then}.`;
  }
  if (!checked.length && needs)
    return solution && list === 'empty'
      ? `${st.solName || 'This solution'} has no tables. To extract its other components, clear Entity related options.`
      : list === 'none'
        ? 'Click Load Entities, then select at least one entity before extracting entity-related translations.'
        : 'Select at least one entity before extracting entity-related translations.';
  return {
    entities: [...checked],
    kinds,
    solutionId: solution ? st.sol : undefined,
    includeReadOnly: st.ro,
    allGlobals: !solution && kinds.has('globaloptionset'),
  };
}

// ---- Setup screen ----

/** Hover/focus help for options whose label doesn't say everything (read by screen readers as the description). */
const HINTS: Record<string, string> = {
  attribute: "Column names and descriptions. The description is the tooltip people see when they hover a field's label.",
  option: 'Labels of choice values, including status and status reason. Choices that use a global choice are on the Global OptionSets sheet.',
  boolean: 'The two labels of Yes/No columns. Yes/No columns that use a global choice are on the Global OptionSets sheet.',
  tab: 'Reading tab labels in other languages switches your Dynamics language for about a second.',
  section: 'Reading section labels in other languages switches your Dynamics language for about a second.',
  field: 'Field labels on each form. A column placed on a form several times has one row per copy.',
  relationship: 'Related-records menu labels of relationships that use their own label.',
  navitem: "Related-records items in the forms' navigation.",
  bpf: 'Names, stages and steps of business process flows.',
  command: 'Buttons of the modern command bar.',
  ribbon: 'Buttons of the classic command bar. Saving them takes about 20 seconds per table.',
  globaloptionset: 'Every global choice in the environment (in solution mode: those in the solution, plus those the checked entities use).',
  dashboard: 'Dashboard names and their tab, section and component labels.',
};

const DN_MIN = 130;
const DN_DEF = 185;
const DN_KEY = 'setup:dn';
let uid = 0;

interface Row {
  l: string;
  text: string;
  tr: HTMLTableRowElement;
  cb: HTMLInputElement;
}

export function createSetup(app: AppApi, st: WbState, save: () => void, onExtract: () => void): SetupApi {
  app.adoptStyles(css);
  const { ctx, providers } = app;
  const id = `su${++uid}`;
  const ac = new AbortController();
  const signal = ac.signal;
  const sel = new Set(st.tables);
  const names = new Map<string, string>();
  let all: TableInfo[] | null = null;
  let sols: SolutionInfo[] | null = null;
  let solsErr = '';
  let rows: Row[] = [];
  let listing = false;
  /** The last listing finished and shows the source's tables (possibly none). */
  let filled = false;
  let tok = 0;
  let initP: Promise<void> | null = null;
  let destroyed = false;
  // Remembered checks belong to the remembered load source until its list says otherwise (state saved before
  // tablesFor was kept has none).
  st.tablesFor ??= listKey(st);

  const changed = () => {
    st.tables = [...sel];
    save();
  };

  // ---- Entities options ----
  const loadBtn = h('button', { type: 'button', class: 'btn sm', on: { click: () => void reload() } }, 'Load Entities');
  const checkBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn sm',
      on: {
        click: () => {
          // The filter text typed a moment ago decides, even before its debounce has run.
          filter.cancel();
          applyFilter();
          for (const r of rows) if (!r.tr.hidden) sel.add(r.l);
          changed();
          drawSel();
        },
      },
    },
    'Check all',
  );
  const clearBtn = h('button', { type: 'button', class: 'btn sm', on: { click: () => (sel.clear(), changed(), drawSel()) } }, 'Clear all');
  tooltip(checkBtn, 'Checks every entity the filter shows');

  const srcSel = h(
    'select',
    { class: 'sel', id: `${id}-src`, on: { change: () => setSource(srcSel.value === 'solution' ? 'solution' : 'all') } },
    h('option', { value: 'all' }, 'All entities'),
    h('option', { value: 'solution' }, 'From a solution'),
  );
  const solSel = h('select', { class: 'sel', id: `${id}-sol`, on: { change: () => pickSolution(solSel.value) } });
  const solNote = h('div', { class: 'su-fn', role: 'status' });
  const solField = h('div', { class: 'su-f' }, h('label', { for: solSel.id }, 'Solution'), solSel, solNote);

  const q = h('input', {
    type: 'search',
    placeholder: 'Filter entities',
    'aria-label': 'Filter entities',
    on: {
      keydown: (e: KeyboardEvent) => {
        if (e.key !== 'Escape' || !q.value) return;
        e.stopPropagation(); // clears the box instead of minimizing the window
        q.value = '';
        applyFilter();
      },
    },
  });
  /** Shows the rows whose display or logical name holds every word typed (core/search.ts: case, accents, '_' and '-' aside). */
  const applyFilter = () => {
    if (!rows.length) return;
    const t = terms(q.value);
    let n = 0;
    for (const r of rows) n += +!(r.tr.hidden = !hit(r.text, t));
    stNote.classList.remove('is-bad');
    stNote.hidden = n > 0;
    put(stNote, n ? '' : 'No entities match the filter.');
  };
  const filter = debounce(applyFilter, 100);
  q.addEventListener('input', () => filter());

  const col1 = h('col', { class: 'c1' });
  const tbody = h('tbody');
  const handle = h('span', {
    class: 'su-rz',
    role: 'separator',
    tabindex: 0,
    'aria-orientation': 'vertical',
    'aria-label': 'Resize the Display name column',
    'aria-valuemin': DN_MIN,
  });
  const table = h(
    'table',
    { class: 'su-t' },
    h('caption', { class: 'vh' }, 'Entities'),
    h('colgroup', null, col1, h('col')),
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Display name', handle), h('th', { scope: 'col' }, 'Logical name'))),
    tbody,
  );
  const stNote = h('div', { class: 'su-st', role: 'status' });
  const tw = h('div', { class: 'su-tw' }, table, stNote);
  const selCount = h('span', { class: 'su-n' });
  const listCount = h('span', { class: 'su-lc', 'aria-live': 'polite' });

  const width = (w: number) => {
    const max = Math.max(DN_MIN, (tw.clientWidth || 360) - DN_MIN);
    const v = Math.round(Math.min(Math.max(w, DN_MIN), max));
    table.style.setProperty('--su-c1', `${v}px`);
    handle.setAttribute('aria-valuenow', String(v));
    handle.setAttribute('aria-valuemax', String(Math.round(max)));
    return v;
  };
  const keepWidth = (w: number) => {
    st.widths[DN_KEY] = width(w);
    save();
  };
  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = Number(handle.getAttribute('aria-valuenow')) || st.widths[DN_KEY] || DN_DEF;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('is-drag');
    const move = (m: PointerEvent) => width(w0 + m.clientX - x0);
    const up = (u: PointerEvent) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.classList.remove('is-drag');
      keepWidth(w0 + u.clientX - x0);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  // A listing made while the workbook is shown measures a hidden list (width 0) and clamps the column too far:
  // fit the remembered width again whenever the list's box gets its size or changes it.
  const fit = typeof ResizeObserver === 'function' ? new ResizeObserver(() => tw.clientWidth > 0 && width(st.widths[DN_KEY] || DN_DEF)) : null;
  fit?.observe(tw);
  handle.addEventListener('keydown', (e: KeyboardEvent) => {
    const w = Number(handle.getAttribute('aria-valuenow')) || DN_DEF;
    const d = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
    if (!d) return;
    e.preventDefault();
    keepWidth(w + d);
  });

  const card = h(
    'section',
    { class: 'su-card', 'aria-labelledby': `${id}-eh` },
    h('div', { class: 'su-head' }, h('h3', { id: `${id}-eh` }, 'Entities options'), h('div', { class: 'su-acts' }, loadBtn, checkBtn, clearBtn)),
    h('div', { class: 'su-f' }, h('label', { for: srcSel.id }, 'Load source'), srcSel),
    solField,
    h('div', { class: 'input su-q' }, q),
    tw,
    h('div', { class: 'su-foot' }, selCount, listCount),
  );

  /**
   * Tables listed for the current source: named ones; managed, non-customizable ones only with read-only labels. A
   * customizable managed table stays listed: its own labels are read-only, but it can hold unmanaged columns, forms
   * and views, which can be translated.
   */
  const listable = (t: TableInfo) => !!pick(t.displayName) && (st.ro || t.customizable || !t.managed);

  const drawSel = () => {
    for (const r of rows) r.tr.classList.toggle('is-on', (r.cb.checked = sel.has(r.l)));
    selCount.textContent = `${sel.size.toLocaleString()} selected`;
    checkBtn.disabled = !rows.length;
    clearBtn.disabled = !sel.size;
  };

  const showState = (content: string | Node, bad = false) => {
    rows = [];
    filled = false;
    put(tbody);
    table.hidden = true;
    stNote.hidden = false;
    stNote.classList.toggle('is-bad', bad);
    put(stNote, content);
    listCount.textContent = '';
    drawSel();
  };
  const retry = (text: string, run: () => void) => h('span', null, `${text} `, h('button', { type: 'button', class: 'link', on: { click: run } }, 'Try again'));

  const fill = (tables: TableInfo[], what: string) => {
    const list = tables
      .filter(listable)
      .map((t) => [t.logicalName, names.get(t.logicalName) || t.logicalName] as const)
      .sort((a, b) => a[1].localeCompare(b[1]));
    rows = list.map(([l, n]) => {
      const cb = h('input', { type: 'checkbox', on: { change: () => (cb.checked ? sel.add(l) : sel.delete(l), changed(), drawSel()) } });
      const tr = h(
        'tr',
        null,
        h('td', null, h('label', { class: 'su-cl' }, cb, h('span', null, n))),
        // The logical name toggles too, like clicking the display name.
        h('td', { on: { click: () => cb.click() } }, l),
      );
      return { l, text: fold(`${n} ${l}`), tr, cb };
    });
    put(tbody, rows.map((r) => r.tr));
    filled = true;
    table.hidden = !rows.length;
    stNote.classList.remove('is-bad');
    stNote.hidden = !!rows.length;
    put(stNote, rows.length ? '' : what === 'all' ? 'No entities to list.' : `${st.solName || 'This solution'} has no tables. To extract its other components, clear Entity related options.`);
    listCount.textContent = rows.length ? (what === 'all' ? plural(rows.length, 'entity', 'entities') : `${plural(rows.length, 'table')} in ${st.solName || 'the solution'}`) : '';
    width(st.widths[DN_KEY] || DN_DEF);
    filter.cancel();
    applyFilter();
  };

  /**
   * Lists the entities of the current source: every table, or the tables of the chosen solution. `fresh` reads the
   * table list again; `clear` unchecks everything (a newly loaded solution starts unchecked, as in the old tool).
   * Otherwise remembered checks are kept for the tables that are listed.
   */
  async function list(o: { fresh?: boolean; clear?: boolean } = {}): Promise<void> {
    const t = ++tok;
    const solution = st.source === 'solution';
    listing = true;
    loadBtn.disabled = true;
    loadBtn.setAttribute('aria-busy', 'true');
    table.hidden = true;
    stNote.hidden = false;
    stNote.classList.remove('is-bad');
    put(stNote, h('div', { class: 'su-sk', 'aria-label': 'Loading entities' }, [1, 2, 3, 4, 5].map(() => h('div', { class: 'sk' }, h('i', { style: { width: '16px', height: '16px' } }), h('i', { style: { flex: '1', height: '12px' } })))));
    listCount.textContent = 'Loading entities…';
    try {
      // The full list also gives the display names (tableName) in solution mode.
      if (!all || o.fresh) {
        const ts = await providers.listTables(ctx, signal);
        for (const x of ts) names.set(x.logicalName, pick(x.displayName, ctx.user, ctx.base) || x.logicalName);
        all = ts;
      }
      if (t !== tok || destroyed) return;
      if (solution && !st.sol) {
        showState('Select a solution to list its tables.');
        return;
      }
      let tables = all;
      if (solution) {
        const inSol = new Set(await providers.solutionTables(ctx, st.sol, signal));
        tables = all.filter((x) => inSol.has(x.logicalName));
      }
      if (t !== tok || destroyed) return;
      if (o.clear) sel.clear();
      const shown = new Set(tables.filter(listable).map((x) => x.logicalName));
      // Forget checks of tables that aren't listed (removed, outside the solution, or hidden): the rest are this
      // source's tables now.
      for (const l of sel) if (!shown.has(l)) sel.delete(l);
      st.tablesFor = listKey(st);
      changed();
      fill(tables, solution ? 'solution' : 'all');
    } catch (e) {
      if (t !== tok || destroyed || isAbort(e)) return;
      if (!all) showState(retry(`Couldn't load the entities: ${errText(e)}`, () => void list({ fresh: true })), true);
      else showState(retry(`Couldn't read the tables of ${st.solName || 'the solution'}: ${errText(e)}`, () => void list(o)), true);
    } finally {
      if (t === tok && !destroyed) {
        listing = false;
        loadBtn.removeAttribute('aria-busy');
        sync();
      }
    }
  }

  const reload = () => {
    if (st.source === 'solution' && !st.sol) {
      showState('Select a solution, then click Load Entities.', true);
      solSel.focus();
      return Promise.resolve();
    }
    return list({ fresh: true, clear: st.source === 'solution' });
  };

  const setSource = (v: 'all' | 'solution') => {
    if (v === st.source) return;
    st.source = v;
    save();
    sync();
    void list();
    if (v === 'solution' && !st.sol) solSel.focus();
  };

  const pickSolution = (v: string) => {
    const s = sols?.find((x) => x.id === v);
    st.sol = s?.id || '';
    st.solName = s?.name || '';
    save();
    void list({ clear: true });
  };

  const drawSols = () => {
    const opts = [h('option', { value: '' }, 'Select a solution')];
    for (const s of sols || []) opts.push(h('option', { value: s.id, title: `${s.uniqueName} · ${s.version}${s.managed ? ' · managed' : ''}` }, s.name));
    put(solSel, opts);
    solSel.value = sols?.some((s) => s.id === st.sol) ? st.sol : '';
    put(solNote, solsErr ? retry(`Couldn't load the solutions: ${solsErr}`, () => void loadSols()) : sols ? '' : 'Loading solutions…');
    solNote.classList.toggle('is-bad', !!solsErr);
    solNote.hidden = !solNote.textContent;
  };

  async function loadSols(): Promise<void> {
    solsErr = '';
    sols = null;
    drawSols();
    sync();
    try {
      const s = await providers.listSolutions(ctx, signal);
      if (destroyed) return;
      sols = s.sort((a, b) => a.name.localeCompare(b.name));
      // A remembered solution that is gone is forgotten.
      if (st.sol && !sols.some((x) => x.id === st.sol)) {
        st.sol = '';
        st.solName = '';
        save();
        if (st.source === 'solution') void list();
      }
    } catch (e) {
      if (destroyed || isAbort(e)) return;
      solsErr = errText(e);
    }
    drawSols();
    sync();
  }

  // ---- option boxes ----
  const boxes = new Map<string, HTMLInputElement>();
  const optList = (opts: SetupOpt[], two: boolean) =>
    h(
      'div',
      { class: 'su-list' + (two ? ' su-two' : '') },
      opts.map((o) => {
        const hint = HINTS[o.id];
        const hid = `${id}-h-${o.id}`;
        const cb = h('input', { type: 'checkbox', 'aria-describedby': hint ? hid : null, on: { change: () => ((st.opts[o.id] = cb.checked), save(), sync()) } });
        boxes.set(o.id, cb);
        const lab = h('label', { class: 'su-o' }, cb, h('span', null, o.label), hint ? h('span', { id: hid, hidden: true }, hint) : null);
        if (hint) {
          tooltip(lab, hint);
          tooltip(cb, hint);
        }
        return lab;
      }),
    );
  const groupLinks: Array<[HTMLButtonElement, SetupOpt[]]> = [];
  const box = (title: string, opts: SetupOpt[], two: boolean, wide: boolean) => {
    const hid = `${id}-b${groupLinks.length}`;
    const link = h('button', {
      type: 'button',
      class: 'link',
      on: {
        click: () => {
          const on = !opts.some((o) => st.opts[o.id] ?? o.def);
          for (const o of opts) st.opts[o.id] = on;
          save();
          sync();
        },
      },
    });
    groupLinks.push([link, opts]);
    return h(
      'div',
      { class: 'su-box' + (wide ? ' su-wide' : ''), role: 'group', 'aria-labelledby': hid },
      h('div', { class: 'su-bh' }, h('h3', { id: hid }, title), link),
      optList(opts, two),
    );
  };

  // Languages: the same values as the title bar's language menu (prefs), so both stay in step.
  const others = () => ctx.langs.filter((l) => l.lcid !== ctx.base);
  const nameOf = (l: Lcid) => langName(app, l);
  // With one language besides the base, "Export all" and "Export only" show the same columns; the choice is kept here.
  let onlyPicked = false;
  const allR = h('input', { type: 'radio', name: `${id}-lang`, on: { change: () => allR.checked && ((onlyPicked = false), app.savePrefs({ shown: ctx.langs.map((l) => l.lcid) })) } });
  const onlyR = h('input', { type: 'radio', name: `${id}-lang`, on: { change: () => onlyR.checked && ((onlyPicked = true), only(Number(langSel.value))) } });
  const langSel = h('select', {
    class: 'sel',
    'aria-label': 'Language to export',
    on: { change: () => (onlyR.checked ? only(Number(langSel.value)) : app.savePrefs({ target: Number(langSel.value) })) },
  });
  const only = (l: Lcid) => {
    if (l && l !== ctx.base) app.savePrefs({ target: l, shown: [l] });
  };
  const rowsSel = h('select', { class: 'sel', id: `${id}-rows`, on: { change: () => ((st.rows = rowsSel.value as RowsMode), save()) } });
  const langBox = h(
    'div',
    { class: 'su-box', role: 'group', 'aria-labelledby': `${id}-lh` },
    h('div', { class: 'su-bh' }, h('h3', { id: `${id}-lh` }, 'Languages')),
    h(
      'div',
      { class: 'su-lg' },
      h('label', { class: 'su-o' }, allR, h('span', null, 'Export all')),
      h('div', { class: 'su-only' }, h('label', { class: 'su-o' }, onlyR, h('span', null, 'Export only')), langSel),
      h('div', { class: 'su-rows' }, h('label', { for: rowsSel.id }, 'Rows'), rowsSel),
    ),
  );

  const modeR = new Map<LabelMode, HTMLInputElement>();
  const modeRadio = (m: LabelMode, text: string) => {
    const r = h('input', { type: 'radio', name: `${id}-mode`, value: m, on: { change: () => r.checked && ((st.labelMode = m), save()) } });
    modeR.set(m, r);
    return h('label', { class: 'su-o' }, r, h('span', null, text));
  };
  const roCb = h('input', { type: 'checkbox', on: { change: () => ((st.ro = roCb.checked), save(), all && void list()) } });
  const labelBox = h(
    'div',
    { class: 'su-box su-wide', role: 'group', 'aria-labelledby': `${id}-mh` },
    h(
      'div',
      { class: 'su-lo' },
      h('h3', { id: `${id}-mh` }, 'Label options'),
      h('span', { class: 'su-lt', id: `${id}-mt` }, 'Export Name and Description'),
      h('div', { class: 'su-lo', role: 'radiogroup', 'aria-labelledby': `${id}-mt` }, modeRadio('both', 'Both'), modeRadio('names', 'Only Names'), modeRadio('descriptions', 'Only Descriptions')),
    ),
    h('label', { class: 'su-o su-ro' }, roCb, h('span', null, 'Include read-only labels (from managed solutions or not customizable)')),
  );

  const el = h(
    'section',
    {
      class: 'su',
      'aria-label': 'Export options',
      on: {
        keydown: (e: KeyboardEvent) => {
          // Ctrl+Enter extracts from anywhere in the Setup screen.
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
            e.preventDefault();
            onExtract();
          }
        },
      },
    },
    card,
    h(
      'div',
      { class: 'su-opts' },
      box('Global Options', SETUP_GROUPS.global, false, false),
      langBox,
      box('Entity related options', SETUP_GROUPS.entity, true, true),
      labelBox,
      h('p', { class: 'su-hint' }, 'When you are ready, select Extract translations (Ctrl+Enter). Nothing is saved until you select Save and Publish.'),
    ),
  );

  /** Shows the state (`st`) and the language prefs in every control. */
  function sync(): void {
    if (destroyed) return;
    srcSel.value = st.source;
    const solOpt = srcSel.options[1];
    solOpt.disabled = !sols?.length && st.source !== 'solution';
    solField.hidden = st.source !== 'solution';
    loadBtn.disabled = listing;

    for (const o of OPTS) {
      const cb = boxes.get(o.id);
      if (cb) cb.checked = st.opts[o.id] ?? o.def;
    }
    for (const [link, opts] of groupLinks) link.textContent = opts.some((o) => st.opts[o.id] ?? o.def) ? 'Clear all' : 'Check all';
    for (const [m, r] of modeR) r.checked = st.labelMode === m;
    roCb.checked = st.ro;

    const { prefs } = app;
    const os = others();
    const target = os.some((l) => l.lcid === prefs.target) ? prefs.target : os[0]?.lcid ?? ctx.base;
    put(langSel, os.map((l) => h('option', { value: String(l.lcid) }, `${l.name} Label`)));
    langSel.value = String(target);
    const allShown = os.every((l) => prefs.shown.includes(l.lcid));
    allR.checked = !os.length || (allShown && !(os.length === 1 && onlyPicked));
    onlyR.checked = !allR.checked;
    onlyR.disabled = langSel.disabled = !os.length;

    // Pending changes and Save problems are about saving, not text: a separator sets them apart where supported.
    put(rowsSel, ROWS_MODES.flatMap((m) => [m === 'pending' ? h('hr') : null, h('option', { value: m }, rowsLabel(m, nameOf(ctx.base), nameOf(target)))]));
    rowsSel.value = st.rows;
    drawSel();
  }

  const onPrefs = () => sync();
  app.root.host.addEventListener('dxt-prefs', onPrefs);

  const init = (): Promise<void> =>
    (initP ??= Promise.all([loadSols(), list()]).then(() => {
      // A failed entity list can be loaded again by a later init() (or the inline "Try again").
      if (!all) initP = null;
    }));

  // Checks made in another load source's list (the source or solution was just changed) wait for this one's.
  const scope = (): Scope | string => scopeOf(st, [...sel], listing ? 'loading' : rows.length ? 'shown' : filled ? 'empty' : 'none', st.tablesFor);

  drawSols();
  table.hidden = stNote.hidden = true;
  width(st.widths[DN_KEY] || DN_DEF);
  sync();

  return {
    el,
    init,
    tableName: (l) => names.get(l) || '',
    scope,
    sync,
    destroy() {
      destroyed = true;
      ac.abort();
      filter.cancel();
      fit?.disconnect();
      app.root.host.removeEventListener('dxt-prefs', onPrefs);
    },
  };
}
