// "All labels on this page": a quiet side sheet listing every label of the page, including the ones not on
// screen (other tabs, hidden fields, other stages), then the changes staged on other pages. Rows find their label on
// the page (inspector/reveal.ts), a change going back first to exactly where it was made (its page, its tab or related
// view, its flyout), and open its popup; nothing is edited here. Its groups collapse by their band; dragged by its
// header it floats over the page (to uncover what it hid), and its pin docks it on the right again (prefs.list).

import { isRtl, lcidTag } from '../core/lcid';
import { KIND_NAMES, type Kind, type Lcid, type Slot } from '../core/model';
import { hit, terms } from '../core/search';
import type { Store } from '../core/store';
import { debounce, h, icon, put, rafThrottle, type Child } from '../ui/dom';
import { langName } from '../ui/editor';
import type { AppApi } from '../ui/types';
import { emptyState, ibtn, link, note, pushLayer, skeleton, tooltip } from '../ui/widgets';
import { columnOf } from './column';
import css from './pagelist.css';
import { GROUPS, isPending, lookText, searchText, standsIn } from './status';
import type { Look, OpenPageList, PageItem } from './types';

/** all = every label, todo = not translated into the target language, changed = staged (or a publish failed for it). */
export type ListFilter = 'all' | 'todo' | 'changed';

/** Rows rendered at once under "Not on screen right now" before "Show all". */
export const HID_CAP = 300;
/**
 * The short kind on a row, where its group doesn't say what it is: a Related menu item and a process step said so only
 * by the place caption over them, which the list no longer shows.
 */
const KINDS: Partial<Record<Kind, string>> = {
  tab: 'Tab', dtab: 'Tab', section: 'Section', dsection: 'Section', entity: 'Table', attribute: 'Column', view: 'View', chart: 'Chart', form: 'Form',
  dashboard: 'Dashboard', app: 'App', area: 'Area', group: 'Group', bpf: 'Process', stage: 'Stage', step: 'Step', globaloptionset: 'Global choice',
  envvar: 'Environment variable', customapi: 'Custom API', navitem: 'Related', relationship: 'Related',
};
/** Row state classes (the target-language line's color). */
const CLS: Partial<Record<Look, string>> = { missing: 'is-miss', edited: 'is-chg', error: 'is-bad', ro: 'is-ro', builtin: 'is-na', na: 'is-na' };
/** The list's line for failed loads (the details are in its tooltip); the bar says the same. */
const LOAD_PROBLEM = "Couldn't load some labels.";
/** The group of the changes staged on other pages (PageItem.away), after the page's own labels. */
export const AWAY = 'Changed on other pages';
/** The key of a group inside "Not on screen right now": collapsed apart from the page's group of that name. */
export const HID_KEY = 'hid/';
let seq = 0;

/** Groups the user collapsed outside searches, by key, for the whole session: every list opened on this app. */
const SHUT = new WeakMap<AppApi, Set<string>>();

/** The least gap between a floating sheet and the viewport's edges. */
const EDGE = 8;
/** A floating sheet: the docked width, and 640 high where the viewport leaves 16 px above and below. */
const FLOAT_W = 360;
const FLOAT_H = 640;
/** A place in [0, 1], else `d` (prefs may hold anything). */
const frac = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : d);

/**
 * The box of a floating sheet in a W×H viewport, at its place (`p`: fractions of the room around it, like the bar's
 * prefs.bar): always inside the viewport, however small it gets.
 */
export function floatBox(W: number, H: number, p?: { x?: unknown; y?: unknown }): { left: number; top: number; width: number; height: number } {
  const width = Math.max(0, Math.min(FLOAT_W, W - 2 * EDGE));
  const height = Math.max(0, Math.min(FLOAT_H, H - 32));
  return {
    left: Math.round(EDGE + frac(p?.x, 0) * Math.max(0, W - width - 2 * EDGE)),
    top: Math.round(EDGE + frac(p?.y, 0) * Math.max(0, H - height - 2 * EDGE)),
    width,
    height,
  };
}

/** The place of a floating sheet dragged to `left`, `top` in a W×H viewport, kept inside it (fractions, 3 decimals). */
export function floatPlace(W: number, H: number, left: number, top: number): { x: number; y: number } {
  const b = floatBox(W, H);
  const fw = W - b.width - 2 * EDGE;
  const fh = H - b.height - 2 * EDGE;
  const r = (v: number, room: number) => (room > 0 ? Math.round(frac(v / room, 0) * 1000) / 1000 : 0);
  return { x: r(left - EDGE, fw), y: r(top - EDGE, fh) };
}

/** Whether an item passes the filter. */
export const passes = (i: PageItem, f: ListFilter): boolean => f === 'all' || (f === 'todo' ? i.look === 'missing' : isPending(i.look));

/**
 * The target-language line of a row: the target text (green when changed, red when a publish failed for it), or
 * "Not translated" / "Read-only" / "Built-in" when there is none to show. A changed or failed row without a target
 * text (its tooltip or column name changed, or its text emptied) says "Changed" / "Couldn't be published".
 */
export function rowState(lk: Look, target: string): { text: string; cls: string } {
  const none = (lk === 'edited' || lk === 'error') && !target.trim();
  return {
    text: lk === 'missing' ? 'Not translated' : lk === 'ro' ? 'Read-only' : lk === 'builtin' ? 'Built-in' : none ? (lk === 'edited' ? 'Changed' : "Couldn't be published") : target,
    cls: CLS[lk] ?? '',
  };
}

/**
 * The base-language text of a row: the label, else (a form cell without a label of its own) the column's name,
 * which is what the form shows there (LIVE-FINDINGS 42), else the title.
 */
export function baseText(store: Store, base: Lcid, m: Slot, comp: string): string {
  const own = store.value(m.key, base);
  if (own) return own;
  const c = m.kind === 'field' ? columnOf(m) : null;
  const col = c ? store.get(`attribute|${c.entity}.${c.attr}|DisplayName`) : undefined;
  return (col && (store.value(col.key, base) || col.title)) || m.title || m.sub || comp;
}

/**
 * The place a row is in (its texts as the user sees them), which keeps the rows of one place together, is read to
 * screen readers and found by the search (the row's tooltip has its whole breadcrumb): a form cell's "Tab › Section"
 * (a quick view's cells with the quick view first), Header, Footer; a section's own "Tab › Section"; Related for the
 * related menu's items; a choice's column; a process step's stage; a navigation item's group. '' for a label that is
 * a place of its own (a tab, a stage, a table, a command…).
 */
export function whereOf(s: Slot): string {
  const r = s.ref || {};
  const p = s.path;
  // [table, form, tab, section]: a quick view form's cells show on other forms, so they say which quick view.
  const inForm = (): string[] => p.slice(r.formType === 6 ? 1 : 2);
  switch (s.kind) {
    case 'field':
    case 'dfield':
      return r.area === 'header' ? 'Header' : r.area === 'footer' ? 'Footer' : inForm().join(' › ');
    case 'section':
    case 'dsection':
      return [...inForm(), s.title].join(' › ');
    case 'navitem':
    case 'relationship':
      return 'Related';
    case 'option':
    case 'status':
    case 'state':
    case 'boolean':
      // "Industry (industrycode)": the column's name as the form shows it.
      return String(p[1] || '').replace(/\s*\([^()]*\)$/, '');
    case 'globaloption':
    case 'step':
      return p[1] || '';
    case 'subarea':
      return p[2] || '';
    case 'attribute':
    case 'view':
    case 'chart':
      // Their table ([table, 'Columns'], [table]): an associated grid's and an address's columns are of other tables.
      return p[0] || '';
    default:
      return '';
  }
}

/** The language of a row's text line (the screen reader's voice, right-to-left scripts); null for our own words, which inherit. */
function langOf(e: HTMLElement, l: Lcid | null): void {
  const tag = l === null ? '' : lcidTag(l);
  if (tag) e.setAttribute('lang', tag);
  else e.removeAttribute('lang');
  if (l !== null) e.setAttribute('dir', isRtl(l) ? 'rtl' : 'auto');
  else e.removeAttribute('dir');
}

/** The short kind after a row's text, only where its group doesn't say it ("Summary · Tab"). */
export const rowKind = (k: Kind): string => KINDS[k] ?? '';

/** Values of a column or a global choice: rows that read alike ("Allow", "Active") from one column to the next. */
const OF_CHOICE = new Set<Kind>(['option', 'status', 'state', 'boolean', 'globaloption']);
/**
 * The grey tag after a row's text: a choice value's column or global choice (its place, which no caption over the
 * rows says any more: without it "Allow" of one column looks like "Allow" of the next), else its kind.
 */
export const rowTag = (s: Slot): string => (OF_CHOICE.has(s.kind) && whereOf(s)) || rowKind(s.kind);

/**
 * The run a row is listed in (cluster): its place, and for a process stage or a navigation group its own name, so
 * that it heads its steps or sub-areas the way a section heads its fields.
 */
export const runOf = (s: Slot): string => (s.kind === 'stage' || s.kind === 'group' ? s.title : whereOf(s));

/**
 * Rows of one place together (only the changes staged on other pages are headed by their page): those without a
 * place first, then each place in the order it first comes (page order), every run keeping its order.
 */
export function cluster<T>(its: readonly T[], where: (i: T) => string): Array<{ where: string; items: T[] }> {
  const by = new Map<string, T[]>([['', []]]);
  for (const i of its) {
    const w = where(i);
    const a = by.get(w);
    if (a) a.push(i);
    else by.set(w, [i]);
  }
  return [...by].filter(([, a]) => a.length).map(([w, items]) => ({ where: w, items }));
}

interface Row {
  el: HTMLElement;
  /** Line 1: the base-language text and the kind. */
  b: HTMLElement;
  k: HTMLElement;
  /** Line 2: the target-language text, or its state. */
  t: HTMLElement;
  /** Its tooltip: both texts in full, the kind and breadcrumb (where it is), the technical name, what the colour means. */
  tip: string;
}

/** Before a group's key in `rov`: its band takes Tab into the list (a component's key never has it). */
const BAND = '\u0001';

export const openPageList: OpenPageList = (app, mode, o) => {
  app.adoptStyles(css);
  const { store, ctx } = app;
  let filter: ListFilter = 'all';
  /** The search's words (core/search.ts terms). */
  let q: string[] = [];
  /** "Not on screen right now" is open: the user's choice outside searches, and during one (open unless collapsed). */
  let hidOpen = false;
  let hidSearch = true;
  let hidAll = false;
  /** Every row of "Changed on other pages" is shown ("Show all"). */
  let awayAll = false;
  let closed = false;
  let notesSig: string | null = null;
  let notesTip = '';
  /** The row (its comp) or group band (BAND and its key) that takes Tab into the list (roving tabindex). */
  let rov = '';
  /**
   * Collapsed groups by key: the user's choice outside searches (kept for the session), and during one. Like "Not on
   * screen right now", a search opens every group to show its hits; one collapsed during that search stays collapsed
   * until the search is cleared, then the choice outside searches is back.
   */
  const shut = SHUT.get(app) ?? new Set<string>();
  SHUT.set(app, shut);
  let shutQ = new Set<string>();
  const isShut = (k: string): boolean => (q.length ? shutQ : shut).has(k);
  const textOf = (i: PageItem): string => baseText(store, ctx.base, i.main, i.comp);
  /** What a row shows in the target language: its text, else the text that stands for it on the page. */
  const targetOf = (i: PageItem): string => {
    const tl = app.prefs.target;
    return tl === ctx.base ? '' : store.value(i.main.key, tl) || standsIn(store, i.main, tl, ctx.base);
  };
  /** Folded search text per component; anything the list hears about (edits, loads, prefs, the page) clears it. */
  const hay = new Map<string, string>();
  const haystack = (i: PageItem): string => {
    let s = hay.get(i.comp);
    if (s === undefined) hay.set(i.comp, (s = searchText(app, i, [textOf(i), targetOf(i), whereOf(i.main), rowKind(i.main.kind), i.away || ''])));
    return s;
  };
  const rows = new Map<string, Row>();
  /** The page changed: rows the next render doesn't show are dropped then. */
  let prune = false;
  const opener = app.root.activeElement as HTMLElement | null;
  const hid = `dxt-pl${++seq}`;

  const search = h('input', {
    type: 'search',
    placeholder: 'Search labels',
    'aria-label': 'Search labels',
    on: {
      input: () => {
        const was = q.length;
        q = terms(search.value);
        // A new search shows its hits that aren't on screen too (another tab, a hidden field), and in collapsed groups.
        if (!was && q.length) {
          hidSearch = true;
          shutQ = new Set();
        }
        render();
      },
      keydown: (e: KeyboardEvent) => {
        if (e.key === 'Escape' && search.value) {
          // Like Fluent's search box: Esc clears the search first; the next Esc closes the list.
          e.preventDefault();
          e.stopPropagation();
          search.value = '';
          q = [];
          hidSearch = true;
          render();
        } else if (e.key === 'ArrowDown' && !e.altKey) {
          // The first label, not the first band: type, Down, Enter opens the first hit (Enter on a band would collapse
          // the group holding it). A band only when every group is collapsed.
          const r = listEl.querySelector<HTMLElement>('.pl-r') || shown()[0];
          if (r) {
            e.preventDefault();
            focusRow(r);
          }
        }
      },
    },
  });
  const segs = (
    [
      ['all', 'All'],
      ['todo', 'Not translated'],
      ['changed', 'Changed'],
    ] as Array<[ListFilter, string]>
  ).map(([id, label]) => {
    const n = h('span', { class: 'pl-n' });
    const b = h('button', {
      type: 'button',
      'aria-pressed': String(id === filter),
      on: {
        click: () => {
          filter = id;
          for (const s of segs) s.b.setAttribute('aria-pressed', String(s.id === id));
          render();
        },
      },
    }, label, n);
    return { id, b, n };
  });
  const notesEl = h('div', { class: 'pl-nt' });
  tooltip(notesEl, () => notesTip);
  const listEl = h('div', { class: 'pl-list', on: { keydown: onKey } });
  // Pressed while docked, like the Workbench window's (ui/app.ts dockB); the keyboard's way to float it and back.
  const pinB = ibtn('dock', 'Dock to the right', () => (floating() ? dock() : undock()), 'subtle', 20);
  const head = h('div', { class: 'pl-hd' }, h('h2', { id: hid }, 'All labels on this page'), pinB, ibtn('close', 'Close (Esc)', () => o.close(), 'subtle', 20));
  const el = h(
    'aside',
    { class: 'pgl', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': hid },
    head,
    notesEl,
    h('div', { class: 'pl-fl' }, h('div', { class: 'input' }, icon('search'), search), h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, segs.map((s) => s.b))),
    listEl,
  );
  const offLayer = pushLayer(el, () => o.close());
  const renderSoon = debounce(() => render(), 120);
  const off = mode.on((w) => {
    if (w === 'alt') return;
    hay.clear();
    if (w === 'page') {
      // Another record, form, view or dashboard: its own labels. A row it shows too keeps its element (the row of a
      // change found on its own page moves into the page's group, and its popup stays next to it).
      hidAll = awayAll = false;
      prune = true;
    }
    renderSoon();
  });

  // ---- docked on the right, or floating where it was dragged (prefs.list) ----

  /** Its place while it is dragged. */
  let live: { x: number; y: number } | null = null;
  const L = app.layer;
  const view = (): [number, number] => [L.clientWidth || innerWidth, L.clientHeight || innerHeight];
  /** The floating place in prefs, whatever they hold. */
  const placeOf = (): { x: number; y: number } => ({ x: frac(app.prefs.list?.x, 0), y: frac(app.prefs.list?.y, 0) });
  function floating(): boolean {
    return !!live || app.prefs.list?.float === true;
  }
  /**
   * Docked, the stylesheet's full-height sheet; floating, a panel at its place. The bar keeps clear of the sheet only
   * while it is docked (ui/bar.ts scanLayer), and notices its class change.
   */
  function placeSheet(): void {
    const fl = floating();
    el.classList.toggle('is-float', fl);
    pinB.setAttribute('aria-pressed', String(!fl));
    const b = fl ? floatBox(...view(), live ?? placeOf()) : null;
    Object.assign(el.style, b ? { left: b.left + 'px', top: b.top + 'px', width: b.width + 'px', height: b.height + 'px' } : { left: '', top: '', width: '', height: '' });
  }
  /** Back on the right edge (the pin, a double-click on the header); its floating place is kept for the pin. */
  function dock(): void {
    if (!floating()) return;
    app.savePrefs({ list: { float: false, ...placeOf() } });
    placeSheet();
  }
  function undock(): void {
    app.savePrefs({ list: { float: true, ...placeOf() } });
    placeSheet();
  }

  // Dragged by its header (not its buttons), like the bar by its logo: it floats from the first move on.
  let drag: { id: number; dx: number; dy: number; sx: number; sy: number; moved: boolean } | null = null;
  const onButton = (t: EventTarget | null): boolean => [...head.querySelectorAll('button')].some((b) => b.contains(t as Node));
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag || onButton(e.target)) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
    try {
      head.setPointerCapture(e.pointerId);
    } catch {
      /* moves still arrive while the pointer is over the header */
    }
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    // A click or a double-click (which docks) never floats it.
    if (!drag.moved && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 4) return;
    drag.moved = true;
    el.dataset.drag = '';
    live = floatPlace(...view(), e.clientX - drag.dx, e.clientY - drag.dy);
    placeSheet();
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const p = drag.moved ? live : null;
    drag = null;
    live = null;
    delete el.dataset.drag;
    if (p) app.savePrefs({ list: { float: true, ...p } });
    placeSheet();
  };
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) head.addEventListener(t, endDrag);
  head.addEventListener('dblclick', (e) => {
    if (!onButton(e.target)) dock();
  });
  // A smaller window: still inside it, at the same place.
  const onResize = rafThrottle(() => !closed && floating() && placeSheet());
  addEventListener('resize', onResize);
  placeSheet();

  // ---- rows ----

  function row(i: PageItem): HTMLElement {
    let r = rows.get(i.comp);
    if (!r) {
      const comp = i.comp;
      const b = h('span', { class: 'pl-b' });
      const k = h('span', { class: 'pl-k' });
      const t = h('span', { class: 'pl-t' });
      const re = h(
        'div',
        {
          class: 'pl-r',
          role: 'button',
          tabindex: '-1',
          'data-c': comp,
          on: {
            click: () => openRow(comp, re),
            pointerenter: () => mode.flash(comp),
            pointerleave: () => mode.flash(''),
            focus: () => {
              rov = comp;
              mode.flash(comp);
            },
            blur: () => mode.flash(''),
          },
        },
        h('span', { class: 'pl-a' }, b, k),
        t,
      );
      const rec: Row = { el: re, b, k, t, tip: '' };
      tooltip(re, () => rec.tip);
      rows.set(comp, (r = rec));
    }
    fill(r, i);
    return r.el;
  }

  function fill(r: Row, i: PageItem): void {
    const m = i.main;
    const tl = app.prefs.target;
    const two = tl !== ctx.base;
    const text = textOf(i);
    r.b.textContent = text;
    r.k.textContent = rowTag(m);
    // A form cell without a label in the target language shows the column's name there (LIVE-FINDINGS 42), a related
    // menu item its relationship's text (LIVE-FINDINGS 80): when that stands for the label it is its translation
    // (look 'ok'), so the row shows it.
    const target = targetOf(i);
    // With one language there is no target line, except to say a row is changed or failed to publish.
    const st = two ? rowState(i.look, target) : isPending(i.look) ? rowState(i.look, '') : { text: '', cls: '' };
    r.t.className = 'pl-t' + (st.cls ? ' ' + st.cls : '');
    r.t.hidden = !st.text;
    put(r.t, st.text); // its state is the dot before it (pagelist.css)
    langOf(r.b, ctx.base);
    langOf(r.t, st.text && st.text === target ? tl : null);
    // A grey row says why it can't be translated here (the read-only reason), the others what their colour means.
    const why = (i.look === 'ro' || i.look === 'builtin') && m.readOnly ? m.readOnly.trim().replace(/[.\s]+$/, '') : '';
    const means = why || ((two && i.look !== 'ok' && i.look !== 'na') || isPending(i.look) ? lookText(app, i.look) : '');
    r.tip = [
      two ? `${langName(app, ctx.base)}: ${text}` : text,
      two && target ? `${langName(app, tl)}: ${target}` : '',
      [KIND_NAMES[m.kind]?.[0], m.path.join(' › ')].filter(Boolean).join(' · '),
      m.sub,
      means,
    ]
      .filter(Boolean)
      .join('\n');
    // Screen readers hear its place too, which no caption over the rows says any more.
    const desc = [means, whereOf(m)].filter(Boolean).join('. ');
    if (desc) r.el.setAttribute('aria-description', desc);
    else r.el.removeAttribute('aria-description');
  }

  function openRow(comp: string, r: HTMLElement): void {
    rov = comp;
    if (!mode.open(comp, { from: r })) app.edit(comp);
  }

  /** The list's keyboard stops in order: the group bands and the rows (roving tabindex, arrow keys). */
  const shown = (): HTMLElement[] => Array.from(listEl.querySelectorAll<HTMLElement>('.pl-gb,.pl-r'));
  const bandOf = (k: string): HTMLElement | undefined => shown().find((b) => b.dataset.g === k);
  /** The stop `rov` names, when it is shown. */
  const stopOf = (k: string): HTMLElement | undefined => {
    if (k.startsWith(BAND)) return bandOf(k.slice(1));
    const r = k ? rows.get(k)?.el : undefined;
    return r?.isConnected ? r : undefined;
  };
  function focusRow(r: HTMLElement | undefined): void {
    if (!r) return;
    rov = r.dataset.g !== undefined ? BAND + r.dataset.g : r.dataset.c || '';
    for (const x of shown()) x.tabIndex = x === r ? 0 : -1;
    r.focus();
    r.scrollIntoView({ block: 'nearest' });
  }

  /** Collapses or expands a group (its band's key): during a search, for that search only. */
  function toggle(k: string): void {
    const s = q.length ? shutQ : shut;
    if (!s.delete(k)) s.add(k);
    rov = BAND + k;
    render();
    // Its band keeps the focus (render) and stays in view: collapsing a group scrolled far into brings it back.
    bandOf(k)?.scrollIntoView({ block: 'nearest' });
  }

  function onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    const band = !!t.classList?.contains('pl-gb');
    if (!band && !t.classList?.contains('pl-r')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      // A band's own click would follow on a button: this is the one.
      e.preventDefault();
      if (band) toggle(t.dataset.g || '');
      else openRow(t.dataset.c || '', t);
      return;
    }
    const all = shown();
    const i = all.indexOf(t);
    const j = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : null;
    if (j === -1 && i === 0 && !e.altKey) {
      // Up from the first band: back to the search box.
      e.preventDefault();
      search.focus();
      return;
    }
    if (j === null || j < 0 || j >= all.length) return;
    e.preventDefault();
    focusRow(all[j]);
  }

  // ---- render ----

  /**
   * A group: its band, a button with its name and count (`n`) that collapses and expands it (`key`), then while it is
   * open what `body` makes (its rows). Collapsed, the next band follows right under it.
   */
  function group(key: string, name: string, n: number, body: () => Child): Child[] {
    const open = !isShut(key);
    const b = h(
      'button',
      { class: 'pl-gb', type: 'button', tabindex: '-1', 'aria-expanded': String(open), 'data-g': key, on: { click: () => toggle(key), focus: () => (rov = BAND + key) } },
      icon('chevron'),
      h('span', { class: 'pl-gn' }, name),
      h('span', { class: 'count' }, n.toLocaleString()),
    );
    return [h('div', { class: 'pl-gh', role: 'heading', 'aria-level': '3' }, b), open && body()];
  }

  /** "Show all N" after the first HID_CAP rows of a long group (`cls` tells which). */
  const showAll = (n: number, cls: string, fn: () => void): HTMLElement =>
    h(
      'button',
      {
        class: `link pl-more ${cls}`,
        type: 'button',
        on: {
          click: () => {
            fn();
            render();
          },
        },
      },
      `Show all ${n.toLocaleString()}`,
    );

  /**
   * The page's groups in their order (keyed after `pre`), each with its rows: those of one place together, without a
   * caption (the place is in the row's tooltip and found by the search).
   */
  function groups(its: PageItem[], pre = ''): Child[] {
    return GROUPS.flatMap((g) => {
      const gi = its.filter((i) => i.group === g);
      return gi.length ? group(pre + g, g, gi.length, () => cluster(gi, (i) => runOf(i.main)).map(({ items }) => items.map(row))) : [];
    });
  }

  /** Failed loads on top: one short line with Try again, the details in its tooltip (rebuilt only when they change). */
  function renderNotes(): void {
    const ns = mode.notes();
    const sig = ns.map((n) => `${n.text}|${n.action || ''}`).join('\n');
    if (sig === notesSig) return;
    notesSig = sig;
    notesTip = ns.map((n) => n.text).join('\n');
    const retry = ns.find((n) => n.action && n.run);
    put(notesEl, ns.length ? note('error', [LOAD_PROBLEM, retry ? [' ', link(retry.action!, () => retry.run!())] : null], 'bad') : null);
  }

  function render(): void {
    renderSoon.cancel();
    if (closed) return;
    const all = mode.items();
    const n = { all: all.length, todo: 0, changed: 0 };
    for (const i of all) {
      if (passes(i, 'todo')) n.todo++;
      if (passes(i, 'changed')) n.changed++;
    }
    for (const s of segs) s.n.textContent = n[s.id].toLocaleString();
    segs[1].b.hidden = app.prefs.target === ctx.base && filter !== 'todo'; // nothing can be "not translated" with one language
    renderNotes();

    // Re-rendering replaces the list's children: keep the keyboard focus on the same row or band.
    const f = app.root.activeElement as HTMLElement | null;
    const keep = f && listEl.contains(f) ? f : null;
    const keepComp = keep?.dataset.c || '';
    const keepBand = keep?.dataset.g;
    const keepWhat = keep?.tagName === 'SUMMARY' ? 'sum' : keep?.classList.contains('pl-hm') ? 'more' : keep?.classList.contains('pl-am') ? 'away' : '';
    const pass = all.filter((i) => passes(i, filter) && (!q.length || hit(haystack(i), q)));
    const away = pass.filter((i) => i.away);
    // Under Changed every change of the page is listed with the others, under its place (a tab not shown, a hidden
    // field): a click there still finds it. Elsewhere what isn't on screen waits in its own collapsed section.
    const inline = filter === 'changed';
    const vis = pass.filter((i) => (i.visible || inline) && !i.away);
    const hidden = inline ? [] : pass.filter((i) => !i.visible && !i.away);
    const out: Child[] = groups(vis);
    // Skeleton rows while the page's labels load (only in the unfiltered list).
    const sk = mode.loading() && filter === 'all' && !q.length;
    if (sk) out.push(skeleton(vis.length ? 1 : 4));
    if (hidden.length) {
      const hidShow = q.length ? hidSearch : hidOpen;
      const d: HTMLDetailsElement = h(
        'details',
        {
          class: 'pl-hid',
          open: hidShow,
          on: {
            toggle: () => {
              if (d.open === hidShow) return;
              if (q.length) hidSearch = d.open;
              else hidOpen = d.open;
              render();
            },
          },
        },
        h('summary', null, icon('chevron'), h('span', { class: 'pl-hs' }, 'Not on screen right now (hidden fields, other tabs)'), h('span', { class: 'count' }, hidden.length.toLocaleString())),
        hidShow && [groups(hidAll ? hidden : hidden.slice(0, HID_CAP), HID_KEY), hidden.length > HID_CAP && !hidAll && showAll(hidden.length, 'pl-hm', () => (hidAll = true))],
      );
      out.push(d);
    }
    // Changes staged on other pages, each under the page it was made on (a sub-heading of the group: a click goes
    // there and finds it; one not made on a page, under "Workbench", opens in the editor).
    if (away.length) {
      const its = awayAll ? away : away.slice(0, HID_CAP);
      out.push(
        h(
          'div',
          { class: 'pl-aw' },
          group(AWAY, AWAY, away.length, () => [
            cluster(its, (i) => i.away || '').map(({ where: w, items }) => [
              w ? h('div', { class: 'pl-pg', role: 'heading', 'aria-level': '4', title: w }, icon('page'), h('span', null, w)) : null,
              items.map(row),
            ]),
            away.length > HID_CAP && !awayAll && showAll(away.length, 'pl-am', () => (awayAll = true)),
          ]),
        ),
      );
    }
    if (!vis.length && !hidden.length && !away.length && !sk) {
      const tl = langName(app, app.prefs.target);
      out.push(
        all.length
          ? filter === 'todo' && !q.length
            ? emptyState('check', 'Nothing left to translate', `Everything on this page is translated into ${tl}.`, [], 'ok')
            : filter === 'changed' && !q.length
              ? emptyState('edit', 'No changes yet', 'Labels you change show here until you publish them.')
              : emptyState('search', 'No labels match', 'Try another filter or search.')
          : mode.loading()
            ? emptyState('list', 'No translatable labels found yet', 'Labels appear as the page loads.')
            : emptyState('list', 'Nothing to translate here', 'Open a record, a list or a dashboard of an app to translate its labels.'),
      );
    }
    put(listEl, ...out);
    if (prune) {
      prune = false;
      for (const [c, r] of rows) if (!r.el.isConnected) rows.delete(c);
    }

    // Roving tabindex: one row or band takes Tab into the list (the last one used, else the first row, else band).
    const rs = shown();
    const r0 = stopOf(rov) || rs.find((x) => x.classList.contains('pl-r')) || rs[0];
    for (const r of rs) r.tabIndex = r === r0 ? 0 : -1;
    if (!keep || (keep.isConnected && app.root.activeElement === keep)) return;
    const back = keep.isConnected
      ? keep
      : keepComp
      ? rows.get(keepComp)?.el
      : keepBand !== undefined
      ? bandOf(keepBand)
      : keepWhat === 'sum'
        ? listEl.querySelector<HTMLElement>('.pl-hid>summary')
        : keepWhat === 'more'
          ? listEl.querySelectorAll<HTMLElement>('.pl-hid .pl-r')[HID_CAP]
          : keepWhat === 'away'
            ? listEl.querySelectorAll<HTMLElement>('.pl-aw .pl-r')[HID_CAP]
            : null;
    (back?.isConnected ? back : r0 || search).focus({ preventScroll: true });
  }

  render();
  requestAnimationFrame(() => !closed && search.focus());

  return {
    el,
    refresh: () => {
      hay.clear();
      render();
    },
    rowOf: (comp) => {
      const r = rows.get(comp)?.el;
      return r?.isConnected ? r : null;
    },
    close() {
      if (closed) return;
      closed = true;
      renderSoon.cancel();
      removeEventListener('resize', onResize);
      off();
      offLayer();
      mode.flash('');
      // Back to where the list was opened from (the bar's button), when focus was in the list.
      if (el.contains(app.root.activeElement) && opener?.isConnected) opener.focus();
    },
  };
};
