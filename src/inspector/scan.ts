// Maps what Dynamics renders to translator components. The DOM only says *where* a label is; *which*
// label it is comes from names (control, tab, section, sitemap and command ids) and form API values joined
// with loaded slots, with a match against the known label texts as the fallback.
// Nothing in the page is ever changed here.
//
// Every anchor is bound to the slot it shows (`key`: a table's plural name, an option's label), says what a
// click on it does (`role`), which element takes that click (`zone`, never an input of a field) and which
// text node is underlined (`text`, and `part` of it when one text shows several labels). Elements of another
// form are never mapped onto the page form, and a field never stands in for its column while the form's own
// labels are unknown: dialogs and quick create are left alone, while quick views and side panes map to their
// own forms, which the DOM names (LIVE-FINDINGS 56, 58), never through the page's form API.

import { guid } from '../core/http';
import type { Kind, Lcid, Prop, Slot } from '../core/model';
import type { Store } from '../core/store';
import type { RibbonControl } from '../providers/types';
import { columnOf } from './column';
import { menuRelationship, navSource } from './fallback';
import { ITEM, itemSwitch, kindOf, LIST, OPENER, selectorSwitch } from './lists';
import { isModern, WANT_FORM, WANT_FORM_NAME, WANT_NAMES, WANT_QUICK, WANT_RELATED, WANT_TABLE, WANT_VIEW, WANT_VIEW_NAME, type PageLoader } from './pageload';
import { formIdOf, linkedColumn, linkedHeader, lpGrid, lpQuickForm, namePart, queryLinks, relatedTable, splitValues, valueParts, type Link } from './parts';

import type { Anchor, Part, Role, Switch } from './types';
export type { Anchor } from './types';

/** One form's labels as the scanner looks them up: the page's own, a side pane's or a quick view's. */
export interface FormIx {
  id: string;
  /** The form's table ('' while unknown). */
  entity: string;
  /** Control id (lower case) -> its cells in form order (copies of a field can share one id, see fieldOf). */
  fields: Map<string, Slot[]>;
  /** Column (lower case) -> the cells that place it, in form order. */
  cells: Map<string, Slot[]>;
  /** 't:<tab>' 's:<section>' (lower case) -> label slot (the first one wins). */
  names: Map<string, Slot>;
}

/** What finding a form cell needs: a form's cells by control id and by column. */
export type FormCells = Pick<FormIx, 'fields' | 'cells'>;

/** The form API of the form a control is on, as far as placing it goes: Xrm.Page, a quick view control. */
export interface CtlApi {
  getControl(name: string): any;
}

export interface PageIndex {
  store: Store;
  xrm: any;
  entity: string;
  /** The page is a list (its main grid shows the page table). */
  list: boolean;
  /** comp -> its slots, and the slot that is shown as its label. */
  comps: Map<string, Slot[]>;
  main: Map<string, Slot>;
  /** Components that belong to the page, rendered right now or not (other tabs, other sitemap areas...). */
  universe: Set<string>;
  /**
   * 't:<tab>' 's:<section>' 'n:<nav item>' 'st:<BPF stage id>' 'sp:<BPF step id>' 'p:<BPF step field>' 'ar:'/'gr:'/'sa:<sitemap
   * id>' (lower case) -> label slot (the first one wins).
   */
  names: Map<string, Slot>;
  /**
   * 'gr:'/'sa:<resource name>' (lower case) -> the one item of that kind without titles that shows that resource, for an
   * entry the page names by its resource instead of its Id (`sitemap-sitemapAreaGroup-NewGroup`, LIVE-FINDINGS 99). Left
   * out when another item of that kind could show that resource too: one without titles, or without a title in the
   * user's language.
   */
  unnamed: Map<string, Slot>;
  /**
   * 'gr:'/'sa:<resource name>' (lower case) -> every item of that kind with that resource. A data-id naming one of them
   * may name it by its resource, so where it is also another item's Id, that Id holds only with its text (another).
   */
  resources: Map<string, Slot[]>;
  /** Normalized titles (every language) of every item of the app's sitemap, texts two items share included. */
  navTexts: Set<string>;
  /** Form control id (lower case) -> its cells in form order: a field placed more than once shares one id (see fieldOf). */
  fields: Map<string, Slot[]>;
  /** Column (lower case) -> the form cells that place it, in form order. */
  cells: Map<string, Slot[]>;
  /** Normalized label text (every language) -> slot, for elements without a usable id. Texts two components share are left out. */
  text: Record<'stage' | 'section' | 'area' | 'group' | 'subarea' | 'entity', Map<string, Slot>>;
  /** 'entity.attribute' (lower case) -> its choice option slots (labels), for every loaded table. */
  opts: Map<string, Slot[]>;
  form?: Slot;
  view?: Slot;
  app?: Slot;
  /** The name of the record's active business process flow (the workflow record, records.ts). */
  bpf?: Slot;
  cmd: Map<string, string>;
  ribbon: Map<string, Map<string, RibbonControl>>;
  /** The page form's own labels are loaded: only then may a control without a cell stand for its column. */
  formReady: boolean;
  /** A record page whose form API is live: a control it does not know belongs to another form. */
  formApi: boolean;
  /** A record page, and the form (or dashboard) the index's cells, tabs and sections come from ('' when unknown). */
  record: boolean;
  formId: string;
  /**
   * The form API shows another table or form than this index was built for (a form switch or a navigation the
   * page tracker hasn't caught up with yet): nothing form-scoped is mapped until the index is rebuilt. Set by the
   * Scanner at the start of every scan.
   */
  stale: boolean;
  /** The user's and the base language: a value shows the user's label, else the base one. */
  user: Lcid;
  base: Lcid;
  /** Normalized texts of a slot in every language. */
  labels(s: Slot): Set<string>;
  /** Every loaded form by id (lower case), the page's own included: side panes and quick views show other forms. */
  forms: Map<string, FormIx>;
  /** The linked tables of grid views by alias, per view id (PageLoader.queries). */
  queries: ReadonlyMap<string, ReadonlyMap<string, Link>>;
  /** The table each grid view's query reads, per view id (PageLoader.viewTables). */
  viewTables: ReadonlyMap<string, string>;
  /** What the scanner asked for whose load failed (PageLoader.gaveUp): asked again only on Try again. */
  gaveUp: ReadonlySet<string>;
  /**
   * The related menu's items the form XML doesn't list: nav id (lower case) -> the text the item shows, a
   * relationship's menu label or the related table's plural name (relatedMenu, LIVE-FINDINGS 63).
   */
  related: Map<string, Slot>;
}

export const norm = (s: string | null | undefined): string => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

const PRIO: Prop[] = ['Label', 'DisplayName', 'Name', 'Title', 'DisplayCollectionName'];
export const rank = (s: Slot): number => {
  const i = PRIO.indexOf(s.prop);
  return i < 0 ? 9 : i;
};
const CHOICE = new Set<Kind>(['option', 'status', 'state', 'boolean']);
const FORM_KINDS = new Set<Kind>(['field', 'dfield', 'tab', 'dtab', 'section', 'dsection', 'navitem']);
/** Attribute metadata types whose values are option labels. */
const CHOICE_TYPE = /(Picklist|Status|State|Boolean)AttributeMetadata$/;

const tryGet = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn() ?? fallback;
  } catch {
    return fallback;
  }
};

/** Indexes the store for the current page. Cheap enough to rebuild whenever slots change. */
export function buildIndex(store: Store, ld: PageLoader, xrm: any): PageIndex {
  const p = ld.page;
  const ctx = ld.app?.ctx;
  const cache = new Map<Slot, Set<string>>();
  const x: PageIndex = {
    store,
    xrm,
    entity: p?.entity || '',
    list: p?.info.type === 'entitylist',
    comps: new Map(),
    main: new Map(),
    universe: new Set(),
    names: new Map(),
    unnamed: new Map(),
    resources: new Map(),
    navTexts: new Set(),
    fields: new Map(),
    cells: new Map(),
    text: { stage: new Map(), section: new Map(), area: new Map(), group: new Map(), subarea: new Map(), entity: new Map() },
    opts: new Map(),
    cmd: ld.cmd,
    ribbon: ld.ribbon,
    formReady: false,
    formApi: false,
    record: p?.info.type === 'entityrecord',
    formId: guid(p?.formId || ''),
    stale: false,
    user: ctx?.user ?? 0,
    base: ctx?.base ?? 0,
    labels(s) {
      let c = cache.get(s);
      if (!c) cache.set(s, (c = new Set(Object.values(s.labels).map(norm).filter(Boolean))));
      return c;
    },
    forms: new Map(),
    queries: ld.queries ?? new Map(),
    viewTables: ld.viewTables ?? new Map(),
    gaveUp: ld.gaveUp ?? new Set(),
    related: new Map(),
  };
  for (const s of store.slots.values()) {
    const a = x.comps.get(s.comp);
    if (a) a.push(s);
    else x.comps.set(s.comp, [s]);
    const m = x.main.get(s.comp);
    if (!m || rank(s) < rank(m)) x.main.set(s.comp, s);
  }
  // Every loaded form's cells, tabs and sections (record forms only: dashboards never show in a pane or a quick view).
  const push = (m: Map<string, Slot[]>, id: unknown, s: Slot) => {
    if (!id) return;
    const k = String(id).toLowerCase();
    const a = m.get(k);
    if (a) a.push(s);
    else m.set(k, [s]);
  };
  for (const s of x.main.values()) {
    const r = s.ref || {};
    if ((s.kind !== 'field' && s.kind !== 'tab' && s.kind !== 'section') || !r.formId) continue;
    const id = guid(r.formId);
    let f = x.forms.get(id);
    if (!f) x.forms.set(id, (f = { id, entity: '', fields: new Map(), cells: new Map(), names: new Map() }));
    f.entity ||= String(s.entity || '').toLowerCase();
    if (s.kind === 'field') {
      push(f.fields, r.controlId, s);
      push(f.cells, r.datafield, s);
    } else {
      const k = `${s.kind === 'tab' ? 't' : 's'}:${s.kind === 'tab' ? r.tabName : r.sectionName}`.toLowerCase();
      if ((s.kind === 'tab' ? r.tabName : r.sectionName) && !f.names.has(k)) f.names.set(k, s);
    }
  }
  for (const f of x.forms.values()) for (const m of [f.fields, f.cells]) for (const a of m.values()) a.sort((p, q) => p.order - q.order);
  if (!p) return x;

  const { entity: e, formId: f, bpfId: b } = p;
  const sm = ld.sitemapId;
  const U = x.universe;
  // The first slot with a name keeps it: a later duplicate (a read-only copy of a sitemap entry, the same
  // column as a step of another stage) never takes it over.
  const name = (k: string, id: unknown, s: Slot) => {
    const key = `${k}:${id}`.toLowerCase();
    if (id && !x.names.has(key)) x.names.set(key, s);
  };
  // A text two components share says nothing about which one is shown: it is dropped (after every add).
  const shared: Array<[Map<string, Slot>, string]> = [];
  const addText = (m: Map<string, Slot>, s: Slot) =>
    x.labels(s).forEach((t) => {
      const o = m.get(t);
      if (!o) m.set(t, s);
      else if (o.comp !== s.comp) shared.push([m, t]);
    });
  for (const c of [`entity|${e}`, `form|${f}`, `dashboard|${f}`, `view|${p.viewId}`, `app|${ld.appId}`, `bpf|${b}`]) if (x.main.has(c)) U.add(c);
  x.form = x.main.get(`form|${f}`) || x.main.get(`dashboard|${f}`);
  x.view = x.main.get(`view|${p.viewId}`);
  x.app = x.main.get(`app|${ld.appId}`);
  x.bpf = b ? x.main.get(`bpf|${b}`) : undefined;
  for (const s of x.comps.get(`entity|${e}`) || []) if (s.prop !== 'Description') addText(x.text.entity, s);

  const attrs = new Set<string>(); // 'entity.attr' of the fields on the form
  const res = x.resources;
  for (const s of x.main.values()) {
    const r = s.ref || {};
    const k = s.kind;
    if (FORM_KINDS.has(k)) {
      if (!f || r.formId !== f) continue;
      U.add(s.comp);
      x.formReady = true;
      if (k.endsWith('field')) {
        const add = (m: Map<string, Slot[]>, id: unknown) => {
          if (!id) return;
          const key = String(id).toLowerCase();
          const a = m.get(key);
          if (a) a.push(s);
          else m.set(key, [s]);
        };
        add(x.fields, r.controlId);
        add(x.cells, r.datafield);
        if (r.datafield) attrs.add(`${e}.${r.datafield}`.toLowerCase());
      } else if (k.endsWith('tab')) name('t', r.tabName, s);
      else if (k.endsWith('section')) {
        name('s', r.sectionName, s);
        addText(x.text.section, s);
      } else name('n', r.elId, s);
    } else if (k === 'stage' || k === 'step') {
      if (!b || r.workflowId !== b) continue;
      U.add(s.comp);
      if (k === 'stage') {
        addText(x.text.stage, s);
        name('st', r.labelId, s);
      } else {
        name('sp', r.labelId, s);
        if (!r.attribute) continue;
        // A column can be a step of several stages; the stage shown on the page decides (see ctlSlot).
        name('p', r.attribute, s);
        name('p', `${r.attribute}|${r.stageId}`, s);
      }
    } else if (k === 'area' || k === 'group' || k === 'subarea') {
      if (!sm || r.sitemapId !== sm) continue;
      // A subarea showing its table's plural name lists as that table once its names are loaded (the sitemap rule
      // anchors that text), else as its own read-only row (what it anchors once their read failed).
      const pe = pluralOf(s);
      U.add(pe && store.get(`entity|${pe}|DisplayCollectionName`) ? `entity|${pe}` : s.comp);
      name(k === 'area' ? 'ar' : k === 'group' ? 'gr' : 'sa', r.id, s);
      addText(x.text[k], s);
      x.labels(s).forEach((t) => x.navTexts.add(t));
      if (r.resource && k !== 'area') push(res, `${k === 'group' ? 'gr' : 'sa'}:${r.resource}`, s);
    }
  }
  for (const [m, t] of shared) m.delete(t);
  // Only provably safe: one item without titles names that resource, and every other one shows a title of its own in
  // the user's language (an item with no title there may show the resource's text too).
  for (const [k, a] of res) {
    const bare = a.filter((s) => s.ref.unnamed);
    if (bare.length === 1 && a.every((s) => s === bare[0] || !!(s.labels[x.user] || '').trim())) x.unnamed.set(k, bare[0]);
  }
  if (x.record) x.related = relatedMenu(x.main.values(), e, (k) => store.get(k));
  // Choices of every loaded table (grid cells of sub-grids and lists show them); those of the fields on
  // the form belong to the page too.
  const opt = (k: string, s: Slot) => {
    const key = k.toLowerCase();
    const a = x.opts.get(key);
    if (a) a.push(s);
    else x.opts.set(key, [s]);
    if (attrs.has(key)) U.add(s.comp);
  };
  for (const s of x.main.values()) {
    const r = s.ref || {};
    if (s.kind === 'attribute' && attrs.has(`${r.entity}.${r.attribute}`.toLowerCase())) U.add(s.comp);
    else if (CHOICE.has(s.kind)) opt(`${r.entity}.${r.attribute}`, s);
    else if (s.kind === 'globaloption') for (const u of r.usedBy || []) opt(u, s);
  }
  for (const m of [x.fields, x.cells]) for (const a of m.values()) a.sort((p, q) => p.order - q.order);
  for (const a of x.opts.values()) a.sort((p, q) => p.order - q.order);
  x.formApi =
    p.info.type === 'entityrecord' &&
    tryGet(() => typeof xrm.Page.getControl === 'function' && xrm.Page.ui.controls.get().length > 0 && String(xrm.Page.data.entity.getEntityName()) === e, false);
  return x;
}

// ---- pure helpers (exported for tests) ----

/**
 * The option a value text shows. Dynamics shows the user's label, else the base one: a unique match there
 * wins; otherwise a unique match in any language (a preview may be on). Two options with that text: none.
 */
export function optionByText(list: Slot[], text: string, user: Lcid, base: Lcid): Slot | undefined {
  const t = norm(text);
  if (!t || !list.length) return undefined;
  // undefined = no match, null = more than one component matches.
  const one = (ok: (s: Slot) => boolean): Slot | null | undefined => {
    let r: Slot | undefined;
    for (const s of list)
      if (ok(s)) {
        if (r && r.comp !== s.comp) return null;
        r = s;
      }
    return r;
  };
  const shown = one((s) => norm(s.labels[user] || s.labels[base]) === t);
  if (shown !== undefined) return shown ?? undefined;
  return one((s) => Object.values(s.labels).some((l) => norm(l) === t)) ?? undefined;
}

/** The option of a form API value (number, Yes/No boolean); none when no single option has it. */
export function optionByValue(list: Slot[], v: unknown): Slot | undefined {
  if (v === null || v === undefined || v === '' || Array.isArray(v)) return undefined;
  const n = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v);
  if (!Number.isFinite(n)) return undefined;
  const hit = list.filter((s) => s.ref?.value !== undefined && s.ref?.value !== null && Number(s.ref.value) === n);
  return hit.length === 1 ? hit[0] : undefined;
}

/**
 * Column of a grid header/cell key ('_x_value' lookups → 'x'); '' for linked-table columns ('alias.col', see linkedColumn), blanks
 * and the grid's own columns (the Power Apps grid's selection '__row_status' and navigation 'PlaceHolder').
 */
export function colKey(k: string | null | undefined): string {
  const c = String(k || '')
    .trim()
    .toLowerCase();
  if (!c || c.includes('.') || c.startsWith('__') || c === 'placeholder' || !/^[a-z0-9_]+$/.test(c)) return '';
  const m = /^_(.+)_value$/.exec(c);
  return m ? m[1] : c;
}

/** Control name of a field control part ('<ctl>.fieldControl-…'); '' when it is not one. */
export function ctlOf(dataId: string | null | undefined): string {
  const d = String(dataId || '');
  const i = d.indexOf('.fieldControl');
  return i > 0 ? d.slice(0, i) : '';
}

/** Which part of a form a control is in, from its name. */
const areaOf = (ctl: string): string => (ctl.startsWith('header_') ? 'header' : ctl.startsWith('footer_') ? 'footer' : 'body');
/** The runtime name of a copy is its cell's control id, plus the copy number for the 2nd and later copies. */
const isCopyOf = (cell: Slot, k: string): boolean => {
  const id = String(cell.ref?.controlId || '').toLowerCase();
  return !!id && (k === id || (k.startsWith(id) && /^\d+$/.test(k.slice(id.length))));
};

/** Where the page shows a form control: the names of the section and the tab around it ('' parts unknown). */
export interface Place {
  tab?: string;
  section?: string;
}

/**
 * The section and tab a page element sits in, from the DOM alone (`section[data-id=<section>]`,
 * `[role=tabpanel][data-id=tabpanel-<tab>]`): after a cold boot the form API may know neither
 * (LIVE-FINDINGS 51). Header and footer controls are in no section.
 */
export function placeOf(el: Element): Place {
  const s = el.closest('section[data-id]')?.getAttribute('data-id') || '';
  const t = el.closest('[role="tabpanel"][data-id^="tabpanel-"]')?.getAttribute('data-id') || '';
  return { ...(s ? { section: s } : {}), ...(t ? { tab: t.slice(9) } : {}) };
}

const known = (at: Place | null | undefined): at is Place => !!at && !!(at.tab || at.section);
const sameName = (a: unknown, b: string): boolean => String(a ?? '').toLowerCase() === b.toLowerCase();
/** The cell is where the page shows its control, as far as the DOM tells. */
const isAt = (s: Slot, at: Place): boolean => (!at.tab || sameName(s.ref?.tabName, at.tab)) && (!at.section || sameName(s.ref?.sectionName, at.section));

/**
 * The form cell of a page control. Copies of a field placed more than once on a form can share one control id
 * in the form XML; Dynamics names them <id>, <id>1, <id>2… in form order (LIVE-FINDINGS 41). The form API knows
 * each control's column, section and tab, which identify its cell exactly, so it decides first; only without it
 * does the name pick the copy. When the form API knows the column but the form XML can't place the control
 * unambiguously (a copy without a cell, unpublished moves), the answer is "unknown", never a guess.
 *
 * `at`: where the page shows the control (placeOf its field container). A cold boot can leave the form API
 * without controls, or with controls but no tabs (LIVE-FINDINGS 51): on a record page the DOM's section and tab
 * then stand in for the API's, and a cell named like the control but placed elsewhere is never taken.
 */
export function fieldOf(x: PageIndex, ctl: string, at?: Place): Slot | undefined {
  return fieldIn(x, { getControl: (n) => x.xrm.Page.getControl(n) }, ctl, at, x.record && !x.formApi);
}

/**
 * fieldOf for any form (`f`): the page's, a side pane's or a quick view's. `api`: that form's own API (the page's
 * Xrm.Page, a quick view control on the page form), null when it has none (a side pane's form: Xrm.Page is the page's,
 * LIVE-FINDINGS 58). `cold`: no form API to place controls, so where the DOM shows one (`at`) must agree with its cell.
 */
export function fieldIn(f: FormCells, api: CtlApi | null, ctl: string, at: Place | undefined, cold: boolean): Slot | undefined {
  const k = ctl.toLowerCase();
  let col = '';
  try {
    const c = api?.getControl(ctl); // no form API (a side pane's form): straight to the name
    const a = c.getAttribute();
    col = String(a.getName()).toLowerCase();
    const sec = c.getParent?.();
    // Controls without their section and tab (the tab tree is empty after a cold boot): the page shows where.
    const dom = !sec && known(at) && areaOf(k) === 'body' ? at : null;
    const sn = sec?.getName?.() || dom?.section || undefined;
    const tn = sec?.getParent?.()?.getName?.() || dom?.tab || undefined;
    // A quick view's control can be bound to a column of the same name: only cells named like the control count.
    const all = (f.cells.get(col) || []).filter((s) => isCopyOf(s, k));
    // Header and footer cells have no section or tab, like the API reports for their controls.
    const cells = all.filter((s) => s.ref.sectionName === sn && s.ref.tabName === tn);
    if (cells.length === 1) return cells[0];
    // The column's other controls in the same part of the form (BPF step controls are not form cells).
    const peers = (): string[] =>
      a.controls
        .get()
        .map((o: any) => String(o.getName()).toLowerCase())
        .filter((n: string) => areaOf(n) === areaOf(k) && !n.startsWith('header_process_'));
    if (cells.length > 1) {
      // Several copies in one place: the control id when it is their own, else their order among the column's controls.
      const same = cells.filter((s) => String(s.ref.controlId || '').toLowerCase() === k);
      if (same.length === 1) return same[0];
      const here: string[] = a.controls
        .get()
        .filter((o: any) => (o.getParent?.()?.getName?.() || undefined) === sn)
        .map((o: any) => String(o.getName()).toLowerCase())
        .filter((n: string) => areaOf(n) === areaOf(k) && !n.startsWith('header_process_'));
      const i = here.indexOf(k);
      // One control per cell, or the order says nothing.
      if (i < 0 || here.length !== cells.length) return undefined;
      // Copies sharing one control id are numbered in form XML order (LIVE-FINDINGS 41): that order must agree.
      const ids = new Set(cells.map((s) => String(s.ref.controlId || '').toLowerCase()));
      if (ids.size === 1) {
        const [id] = ids;
        const num = (n: string): number => (n === id ? 0 : n.startsWith(id) && /^\d+$/.test(n.slice(id.length)) ? Number(n.slice(id.length)) : NaN);
        const nums = here.map(num);
        if (nums.some(Number.isNaN) || [...nums].sort((p, q) => p - q).indexOf(nums[i]) !== i) return undefined;
      }
      return cells[i];
    }
    if (all.length) {
      // The API places the control where the form XML has no copy (a maker moved it and didn't publish):
      // only a column placed once in that part of the form, with one control there, is still certain.
      const there = all.filter((s) => (s.ref.area || 'body') === areaOf(k));
      return there.length === 1 && peers().length === 1 ? there[0] : undefined;
    }
    if ((f.cells.get(col) || []).length) return undefined; // the column is on the form, under other names
  } catch {
    /* no form API, an unbound control (sub-grid, web resource) or not a control of the page form */
  }
  // By name. Without a form API that places controls (a cold boot, a side pane's form), the cell must also be where
  // the page shows the control: a copy elsewhere is never taken for it.
  const where = cold && known(at) ? at : null;
  const fits = (s: Slot | undefined) => (s && (!col || !s.ref?.datafield || String(s.ref.datafield).toLowerCase() === col) ? s : undefined);
  /**
   * `named`: the copy the name points at; with a place it must be there (the page and the form XML agree, else
   * nothing). Without one (a number Dynamics shifted), the only copy there other than the first (which keeps the
   * plain id) wins.
   */
  const pick = (copies: Slot[], named: Slot | undefined): Slot | undefined => {
    if (!where) return fits(named);
    if (named) return isAt(named, where) ? fits(named) : undefined;
    const here = copies.slice(1).filter((s) => isAt(s, where));
    return here.length === 1 ? fits(here[0]) : undefined;
  };
  const own = f.fields.get(k);
  if (own?.length) return pick(own, own[0]); // the first copy keeps the plain id
  // <id><n> is copy n of a field whose copies share <id>; ids can end in digits themselves (emailaddress1), so
  // every split is tried, shortest number first, and must point at an existing copy.
  let only: Slot | undefined;
  let found = 0;
  for (let i = k.length - 1; i > 0 && k[i] >= '0' && k[i] <= '9'; i--) {
    const id = k.slice(0, i);
    const copies = f.fields.get(id);
    const n = Number(k.slice(i));
    if (!copies || copies.length < 2 || n < 1 || String(n) !== k.slice(i)) continue;
    // Dynamics skips the names other controls of the form already have (e.g. the 2nd copy of contoso_client is
    // contoso_client5): once one of <id>1…<id><n> is taken, the number no longer says which copy it is.
    let named: Slot | undefined = n < copies.length ? copies[n] : undefined;
    for (let m = 1; m <= n && named; m++) if (f.fields.has(id + m)) named = undefined;
    if (named) return pick(copies, named);
    // Only where the page shows it can tell then, and only when no other split of the name places a copy there.
    const p = where ? pick(copies, undefined) : undefined;
    if (p && p !== only) (only = p), found++;
  }
  return found === 1 ? only : undefined;
}

/** Column of a page form control, used when the form has no label for it. */
function column(x: PageIndex, ctl: string): Slot | undefined {
  let a = '';
  try {
    a = x.xrm.Page.getControl(ctl).getAttribute().getName();
  } catch {
    return undefined; // not a control of the page form, or unbound
  }
  // The control is named after its column (a copy adds a number). Quick view constituents
  // ("<qv>_<qv>_<table>_<column>") belong to another table: skip them.
  const c0 = ctl.replace(/^(header_|footer_)/, '').toLowerCase();
  const col = String(a || '').toLowerCase();
  return col && c0.startsWith(col) && /^\d*$/.test(c0.slice(col.length)) ? x.main.get(`attribute|${x.entity}.${col}`) : undefined;
}

/**
 * Label slot of a form control: business process step, form cell, else its column. The column only stands in
 * once the page form's labels are loaded and the form has no cell for that column: before that (loading,
 * failed, unknown form), or for a column the form places, an edit of the column's name would not change what
 * the user is looking at. `at`: where the page shows the control (see fieldOf).
 */
export function ctlSlot(x: PageIndex, ctl: string, at?: Place): Slot | undefined {
  const st = ctl.startsWith('header_process_') && ctl.slice(15);
  if (!st) {
    const cell = fieldOf(x, ctl, at);
    if (cell || !x.formReady) return cell;
    const col = column(x, ctl);
    return col && !x.cells.has(String(col.ref?.attribute || '').toLowerCase()) ? col : undefined;
  }
  let stage = '';
  try {
    stage = guid(x.xrm.Page.data.process.getSelectedStage().getId());
  } catch {
    /* no process API: first step with that column */
  }
  // The column from the form API; only without it does the name tell (a second control of a step adds a number,
  // but a column can end in digits too: contoso_themelevel2 is never a copy of contoso_themelevel).
  let col = '';
  try {
    col = String(x.xrm.Page.getControl(ctl).getAttribute().getName() || '');
  } catch {
    /* no form API */
  }
  for (const a of col ? [col] : [st, st.replace(/\d+$/, '')]) {
    const s = byName(x, `p:${a}|${stage}`) || byName(x, 'p:' + a);
    if (s) return s;
  }
  return undefined;
}

const byName = (x: PageIndex, k: string): Slot | undefined => x.names.get(k.toLowerCase());

/**
 * The table whose plural name a sitemap subarea shows (one without titles of its own that opens a table and names no
 * system label, providers/sitemap.ts `ref.plural`), lower case; '' for any other slot.
 */
const pluralOf = (s: Slot): string => (s.kind === 'subarea' && s.ref?.plural ? String(s.ref.entity || '').toLowerCase() : '');

/**
 * The related menu's items that come from the page table's relationships rather than the form XML (LIVE-FINDINGS 63),
 * by nav id (lower case) -> the slot whose text the item shows. UCI names such an item `nav_<relationship schema name>`
 * (`…1` / `…2` for the two sides of a relationship of a table to itself), the activities item `navActivities` and the
 * SharePoint documents item `navSPDocuments` (a customer form's XML pairs it with `…_SharePointDocuments`). A
 * 1:N relationship's menu shows on the referenced table's form; an N:N relationship's Entity1 menu shows on Entity2's
 * form, listing Entity1 records, and the other way round (seen live on both kinds, LIVE-FINDINGS 63). An item shows its
 * menu's label (UseLabel) or the plural name of the table it lists (UseCollectionName); a menu that isn't shown, or
 * whose text isn't loaded, maps to nothing.
 */
export function relatedMenu(slots: Iterable<Slot>, entity: string, get: (key: string) => Slot | undefined): Map<string, Slot> {
  const out = new Map<string, Slot>();
  const e = entity.toLowerCase();
  const low = (v: unknown) => String(v || '').toLowerCase();
  for (const s of slots) {
    const r = s.ref || {};
    if (s.kind !== 'relationship' || s.prop !== 'Label' || (r.menu !== 'label' && r.menu !== 'plural')) continue;
    /** The table the item lists, and its nav id on this table's form. */
    let listed = '';
    let id = '';
    if (r.type === 'OneToMany') {
      if (low(r.referenced) !== e) continue;
      listed = low(r.referencing);
      id = listed === 'activitypointer' ? 'navActivities' : listed === 'sharepointdocument' ? 'navSPDocuments' : `nav_${r.schemaName}`;
    } else {
      const [e1, e2] = [low(r.entity1), low(r.entity2)];
      const listedBy = r.side === 1 ? e1 : r.side === 2 ? e2 : '';
      const shownOn = r.side === 1 ? e2 : r.side === 2 ? e1 : '';
      if (!listedBy || shownOn !== e) continue;
      listed = listedBy;
      // To itself: '…1' shows Entity2's menu and '…2' Entity1's (seen live: the suffix names the side the item is for).
      id = e1 === e2 ? `nav_${r.schemaName}${3 - r.side}` : `nav_${r.schemaName}`;
    }
    const shown = r.menu === 'label' ? s : get(`entity|${listed}|DisplayCollectionName`);
    if (shown) out.set(id.toLowerCase(), shown);
  }
  return out;
}

// ---- DOM helpers ----

const attr = (el: Element, a: string): string => el.getAttribute(a) || '';
const MEANT = /[\p{L}\p{N}]/u;

interface Opt {
  hit?: Element;
  role?: Role;
  zone?: Element;
  text?: Text | null;
  part?: Part;
  focus?: string;
}

/** An anchor bound to the slot it shows. A slot that is not its component's label (a plural name) is focused in the callout. */
function A(x: PageIndex, el: Element | null | undefined, s: Slot | undefined, o: Opt = {}): Anchor | null {
  if (!el || !s) return null;
  const a: Anchor = { el, comp: s.comp, kind: s.kind, key: s.key, role: o.role || 'label' };
  if (o.hit) a.hit = o.hit;
  if (o.zone && o.zone !== el) a.zone = o.zone;
  if (o.text) a.text = o.text;
  if (o.part) a.part = o.part;
  const f = o.focus ?? (x.main.get(s.comp)?.key !== s.key ? s.key : undefined);
  if (f) a.focus = f;
  return a;
}

/**
 * A selector's own label (lists.ts): the button `b` that opens its list takes the click (beside the text the list opens,
 * overlay.ts effect), and its popup offers Change area / form / view.
 */
function opens(a: Anchor | null, b: Element | null | undefined): Anchor | null {
  if (!a || !b) return a;
  if (b === a.el) delete a.zone;
  else a.zone = b;
  a.sw = selectorSwitch(b);
  return a;
}

/** Components of Microsoft's built-in text (`builtin|<what>`): no slot, nothing to translate (the look 'builtin'). */
export const BUILTIN = 'builtin|';
export const isBuiltin = (comp: string): boolean => comp.startsWith(BUILTIN);
/** Built-in related menu items (`navAudit`, `navAsyncOperations`…, LIVE-FINDINGS 63); `nav_<schema>` ones are relationships. */
const BUILT_IN_NAV = /^nav[A-Z][A-Za-z]*$/;
/** Built-in item ids whose text is a relationship's (the plural name of the table they list): translatable. */
const RELATED_NAV = new Set(['navactivities', 'navspdocuments']);
/**
 * The record form's Related tab, which opens the related menu (LIVE-FINDINGS 79): language-pack text ("Association"),
 * and a tab name no form XML has (`tablist-tab_related<fixed guid>`, the same on every form).
 */
const RELATED_TAB = '[data-lp-id="form-tab-related_tab"],[id^="related_tab"],[data-id="tablist-tab_related3b554255-7717-4d17-bb7f-9936fb1e75ca"]';
/**
 * A navigation entry the page names by a resource instead of an Id: a group the app designer never named is
 * `sitemap-sitemapAreaGroup-NewGroup` (its ResourceId `SitemapDesigner.NewGroup`'s last segment, LIVE-FINDINGS 99). It is
 * that resource's one item without titles (PageIndex.unnamed), and only where the entry's single text is no title of the
 * app's sitemap: an item with a name of its own shows it and is mapped by it. Anything else: no mark, never a guess.
 */
function unnamedItem(sc: Scanner, el: Element, k: 'gr' | 'sa', name: string, cap: number): Anchor | null {
  const x = sc.x!;
  const s = name ? x.unnamed.get(`${k}:${name}`.toLowerCase()) : undefined;
  const t = s && shown(sc, el, null, cap, true);
  return t && !x.navTexts.has(norm(sc.textOf(t[1]))) ? A(x, el, s, { role: 'nav', text: t[1] }) : null;
}

/**
 * Whether a navigation entry's data-id name, an Id of `s`, is also the resource of another item of that kind, which names
 * that one's entry (LIVE-FINDINGS 99): then only the text the entry shows tells them apart (ownText).
 */
const another = (x: PageIndex, k: 'gr' | 'sa', name: string, s: Slot): boolean => (x.resources.get(`${k}:${name}`.toLowerCase()) ?? []).some((o) => o !== s);
/** Whether `root` shows one of `s`'s own texts. */
function ownText(sc: Scanner, root: Element, s: Slot, cap: number): boolean {
  const set = sc.x!.labels(s);
  const t = shown(sc, root, set, cap);
  return !!t && set.has(norm(sc.textOf(t[1])));
}

/** Home, Recent and Pinned at the top of the app's navigation (`sitemap-entity-Home_<guid>`): Microsoft's own entries. */
const NAV_HOME = /^(Home|Recent|Pinned)_[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
/** The record form's "Form assist" button, next to its tabs: its data-id (LIVE-FINDINGS 90), its id on earlier builds. */
const FORM_ASSIST = 'FormFillBar_Show_Button';
/** The record form's "Share" button, at the right of its command bar: one name for every copy (the number counts renders). */
const SHARE = /^(collaborationShareButton)_\d+$/;
/** Buttons of the record form outside any command bar, showing language-pack text: Form assist and Share. */
const FORM_BUTTONS = `button[data-id="${FORM_ASSIST}"],button[id="${FORM_ASSIST}"],button[id^="collaborationShareButton_"]`;

/**
 * A label showing Microsoft's built-in text, already in every installed language (a language pack's): marked grey,
 * its popup says there is nothing to translate. `what` names it within the page ('nav|navAsyncOperations',
 * 'command|Mscrm.Form.account.Save').
 */
function builtin(el: Element, what: string, kind: Kind, role: Role, text: Text | null | undefined): Anchor {
  const comp = BUILTIN + what;
  return { el, comp, kind, key: `${comp}|Label`, role, ...(text ? { text } : {}) };
}

/**
 * Laid out and not hidden. Grids render a header's or a value's text twice (a visible copy and a hidden one,
 * LIVE-FINDINGS 55, 91): the underline and the click zone belong to the visible one.
 */
function rendered(el: Element): boolean {
  try {
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  } catch {
    return true;
  }
}

/**
 * First text node under `root` whose normalized text passes `test` (outside `skip`): its element, the result and
 * the node. With `vis`, a rendered one is preferred (the first match when none is).
 */
function find<T>(sc: Scanner, root: Element, test: (t: string) => T | undefined | null, cap = 40, skip = '', vis = false): [Element, T, Text] | null {
  let first: [Element, T, Text] | null = null;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let i = 0, t: Node | null; i < cap && (t = w.nextNode()); i++) {
    const v = norm(sc.textOf(t as Text));
    const p = t.parentElement;
    // `skip` counts only inside `root` (a root that itself sits in such an element is still read).
    const z = skip && p ? p.closest(skip) : null;
    const r = v && p && !(z && z !== root && root.contains(z)) ? test(v) : undefined;
    if (r === undefined || r === null) continue;
    const hit: [Element, T, Text] = [p!, r, t as Text];
    if (!vis || rendered(p!)) return hit;
    first ??= hit;
  }
  return first;
}

/** The text node under `root` showing one of `texts`, else the first one with letters or digits (`only`: the only one). */
function shown(sc: Scanner, root: Element, texts: Set<string> | null, cap = 20, only = false): [Element, Text] | null {
  let first: [Element, Text] | null = null;
  let n = 0;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let i = 0, t: Text | null; i < cap && (t = w.nextNode() as Text | null); i++) {
    const v = norm(sc.textOf(t));
    const p = t.parentElement;
    if (!v || !p) continue;
    if (texts?.has(v)) return [p, t];
    if (MEANT.test(v) && !n++) first = [p, t];
  }
  return only && n > 1 ? null : first;
}

const inMap = (sc: Scanner, root: Element, m: Map<string, Slot>, o: Opt & { cap?: number; skip?: string } = {}) => {
  const r = find(sc, root, (v) => m.get(v), o.cap, o.skip);
  return r && A(sc.x!, r[0], r[1], { hit: root, ...o, text: r[2] });
};
const inSlot = (sc: Scanner, root: Element, s: Slot | undefined, cap?: number, o: Opt = {}, skip = '') => {
  if (!s) return null;
  const set = sc.x!.labels(s);
  const r = find(sc, root, (v) => (set.has(v) ? s : undefined), cap, skip);
  return r && A(sc.x!, r[0], s, { hit: root, ...o, text: r[2] });
};

/** Texts a field label can show: its own, or the column's name where the cell has none in that language (LIVE-FINDINGS 42). */
function fieldTexts(x: PageIndex, s: Slot): Set<string> {
  const own = x.labels(s);
  const df = s.kind === 'field' && s.ref?.datafield;
  // The cell's own table: a quick view's or a side pane's form can show another table than the page.
  const col = df ? x.main.get(`attribute|${s.entity || x.entity}.${String(df).toLowerCase()}`) : undefined;
  return col ? new Set([...own, ...x.labels(col)]) : own;
}

const FIELD = '-FieldSectionItemContainer';
const FIELD_SEL = `[data-id$="${FIELD}"]`;
const DIALOG = '[role="dialog"],[role="alertdialog"]';
/** Flyouts of the page form itself: header fields and the business process stage. */
const FLYOUT = '[data-id="headerFieldsFlyout"],[id*="headerFieldsFlyout" i],[id*="processHeaderStageFlyout" i],[id*="businessProcessFlowFlyout" i]';
/** Signs that a dialog holds a form of its own (a main form dialog) rather than a flyout of the page form. */
const OWN_FORM = `[data-id^="tablist-"],[data-id="form-selector"],h1[data-id="header_title"],${FIELD_SEL}:not([data-id^="header_"])`;

/** A process step's field in its stage's flyout: `fieldSectionItem_<n>_<step id>` (LIVE-FINDINGS 64). */
const STEP_CTL = /^fieldSectionItem_\d+_([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i;
/** A sub-field of a composite column (an address, a full name): `<composite control>_compositionLinkControl_<column>`. */
const COMPOSITE = /^\w+?_compositionLinkControl_([a-z0-9_]+)$/i;
/** A control's title in its own action bar: `action_bar_header_title<control id>` (the timeline's "Timeline"). */
const ACTION_TITLE = 'action_bar_header_title';
/** A process stage's open flyout: `…processHeaderStageFlyout_<stage id>` (inside `…processHeaderStageFlyoutContainer_<stage id>`). */
const STAGE_FLYOUT = /processHeaderStageFlyout(?:Container)?_([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i;
/** The stage flyout's own labels (LIVE-FINDINGS 92): `<STAGE_LABEL>flyoutStageName` its title, `<STAGE_LABEL>Next Stage`… */
const STAGE_LABEL = 'MscrmControls.Containers.ProcessStageControl-';
/** The stage flyout's buttons, by their label's id (language-pack text). */
const STAGE_BUTTONS = new Set(['Next Stage', 'Previous Stage', 'Set Active', 'Close', 'Finish']);

/** The open stage flyout an element is in, and the stage its id names (STAGE_FLYOUT); null outside one. */
export function flyoutStage(el: Element): { fly: Element; id: string } | null {
  const sel = '[id*="processHeaderStageFlyout" i]';
  for (let f = el.closest(sel); f; f = f.parentElement?.closest(sel) ?? null) {
    const id = STAGE_FLYOUT.exec(f.id)?.[1];
    if (id) return { fly: f, id };
  }
  return null;
}

/** A field container's own label element: `<ctl>-field-label`, or `id-<form id>-<n>-<ctl>-field-label`. */
const labelOf = (c: Element, ctl: string): Element | undefined =>
  Array.from(c.querySelectorAll('label[id$="field-label"]')).find((l) => l.id === `${ctl}-field-label` || l.id.endsWith(`-${ctl}-field-label`));
/** A side pane (Xrm.App.sidePanes, LIVE-FINDINGS 58). */
const PANE = '[data-id^="pane-container-"]';
/** A quick view control (LIVE-FINDINGS 56). */
const QUICK = '[data-lp-id^="MscrmControls.Containers.QuickForm|"]';

/** The closest element matching `sel` around `el`, also outside the open shadow root `el` is in (the header strip). */
export function closestDeep(el: Element, sel: string): Element | null {
  for (let n: Element | null = el, i = 0; n && i < 4; i++) {
    const hit = n.closest(sel);
    if (hit) return hit;
    const r = n.getRootNode?.() as ShadowRoot | Document | undefined;
    n = r && 'host' in r ? r.host : null;
  }
  return null;
}

/** The side pane an element is in, null when it is on the page itself. */
export const paneOf = (el: Element): Element | null => closestDeep(el, PANE);

/**
 * True when an element is in the quick create pane or a dialog (main form dialogs, lookups). Header and process
 * fields open in flyouts (dialogs too) that belong to the page form; they count unless the dialog holds a form of
 * its own.
 */
function away(el: Element, ctl = ''): boolean {
  if (el.closest('[data-id="quickCreateRoot"]')) return true;
  const dlg = el.closest(DIALOG);
  return !!dlg && !(ctl.startsWith('header_') && (el.closest(FLYOUT) || !dlg.querySelector(OWN_FORM)));
}

/** True when an element shows another form than the page's: quick create, a dialog (see away), a side pane. */
function otherForm(el: Element, ctl = ''): boolean {
  return away(el, ctl) || !!paneOf(el);
}

/**
 * True when an element is not part of the page's own form: the quick create pane, a dialog or a side pane (see
 * otherForm), or a control the page's form API doesn't know (other sessions).
 */
function foreign(x: PageIndex, el: Element, ctl = ''): boolean {
  if (x.stale || otherForm(el, ctl)) return true;
  if (ctl && x.formApi)
    try {
      if (!x.xrm.Page.getControl(ctl)) return true;
    } catch {
      /* the form API is busy: the other checks decide */
    }
  return false;
}

/**
 * True when the form API now shows another table or form than the index was built for. UCI swaps the form
 * (form selector, record of another table) before the page tracker notices (up to a second later); until the
 * index is rebuilt, the new form's controls, tabs and sections would be matched by name against the old form's
 * cells, and an edit would go to the wrong form.
 */
export function formMoved(x: PageIndex): boolean {
  if (!x.record || !x.formId) return false;
  const P = x.xrm?.Page;
  const ent = tryGet(() => String(P.data.entity.getEntityName() || ''), '').toLowerCase();
  if (ent && ent !== x.entity.toLowerCase()) return true;
  // No current item: the user has a single form, which is the one shown.
  const cur = tryGet(() => {
    const fs = P.ui.formSelector;
    const it = fs.getCurrentItem();
    if (it) return String(it.getId() || '');
    const all = fs.items.get();
    return all.length === 1 ? String(all[0].getId() || '') : '';
  }, '');
  return !!cur && guid(cur) !== x.formId;
}

/** Elements inside a quick view control (its sections, its sub-grids) belong to the quick view's form, never to the page form. */
function inQuickView(x: PageIndex, el: Element): boolean {
  if (el.parentElement?.closest(QUICK)) return true;
  for (let q = el.parentElement?.closest('[data-control-name]'), i = 0; q && i < 6; q = q.parentElement?.closest('[data-control-name]'), i++) {
    const c = q;
    if (tryGet(() => /^quickform/i.test(String(x.xrm.Page.getControl(attr(c, 'data-control-name'))?.getControlType?.() || '')), false)) return true;
  }
  return false;
}

/** The column a form control is bound to, with its value from the form API ('has'); null when unknown. */
export function ctlColumn(x: PageIndex, ctl: string): { col: string; value?: unknown; has: boolean } | null {
  try {
    const a = x.xrm.Page.getControl(ctl).getAttribute();
    const col = String(a.getName()).toLowerCase();
    // Only a control of the page record's own column counts: a quick view's control (or a process step of
    // another table) can show a column of the same name, e.g. statuscode, whose options belong to its table.
    const own = x.xrm.Page.getAttribute(col);
    if (!own || !own.controls.get().some((o: any) => String(o.getName()).toLowerCase() === ctl.toLowerCase())) return null;
    return { col, value: a.getValue(), has: true };
  } catch {
    const df = ctl.startsWith('header_process_') ? '' : fieldOf(x, ctl)?.ref?.datafield;
    return df ? { col: String(df).toLowerCase(), has: false } : null;
  }
}

// ---- which form a control is on: the page's, a side pane's, a quick view's ----

/** The form a control is on, as far as finding its cell goes (formAt). */
interface FormAt {
  /** That form's cells: the index itself for the page's form. */
  f: FormCells;
  /** Its form API: Xrm.Page for the page's form, the quick view control for a quick view on it; null in a side pane. */
  api: CtlApi | null;
  /** No form API places controls: the DOM's section and tab must agree with a cell (fieldIn). */
  cold: boolean;
  /** The control's name in that form (a quick view's field without the quick view's name). */
  ctl: string;
  /** The form's table. */
  entity: string;
  /** The page's own form (its form API, process steps and columns apply, see ctlSlot). */
  page: boolean;
}

const FIELD_ID = '[id^="id-"][data-id$="-FieldSectionItemContainer"]';

/**
 * The form a side pane element is on: the form id every field container of its form root carries (`id-<form id>-…`,
 * LIVE-FINDINGS 58), '' when they don't agree or none is rendered yet. Quick view fields and process steps are not
 * the form's own.
 */
function paneForm(el: Element): string {
  const root = closestDeep(el, '[data-id="editFormRoot"]');
  if (!root || !paneOf(root)) return '';
  const ids = new Set<string>();
  for (const c of Array.from(root.querySelectorAll(FIELD_ID)).slice(0, 40)) {
    const d = attr(c, 'data-id');
    if (d.includes('.') || d.startsWith('header_process_')) continue;
    const f = formIdOf(c.id);
    if (f) ids.add(f);
  }
  return ids.size === 1 ? [...ids][0] : '';
}

/**
 * Which form the control `ctl` (its name on the page) of element `el` is on, and its name there:
 *  * '<quick view>.<control>': a quick view's field (LIVE-FINDINGS 56). The field container's id names the quick view's
 *    form, which must be one the quick view control lists in its host form's XML; the host form is named by the quick
 *    view's `data-lp-id`. Only a quick view on the page's own form has a form API (Xrm.Page.ui.quickForms).
 *  * in a side pane (LIVE-FINDINGS 58): the pane's form, which the DOM names, without a form API (Xrm.Page is the page's).
 *  * else the page's own form.
 * Null when that form is not loaded yet (it is asked for), or the DOM doesn't tell.
 */
function formAt(sc: Scanner, el: Element, ctl: string): FormAt | null {
  const x = sc.x!;
  const pane = paneOf(el);
  const box = closestDeep(el, FIELD_ID);
  const dot = ctl.indexOf('.');
  if (dot > 0) {
    const qv = ctl.slice(0, dot);
    const inner = ctl.slice(dot + 1);
    const fid = formIdOf(box?.id);
    const host = lpQuickForm(closestDeep(el, QUICK)?.getAttribute('data-lp-id'));
    if (!fid || !host || host.control.toLowerCase() !== qv.toLowerCase()) return null;
    const hf = x.forms.get(host.host);
    // The host is a side pane's form that isn't loaded yet (the page's own loads anyway).
    if (!hf) {
      if (pane) sc.want.add(WANT_FORM + host.host);
      return null;
    }
    if (!(hf.fields.get(qv.toLowerCase()) || []).some((s) => Array.isArray(s.ref?.quickForms) && s.ref.quickForms.includes(fid))) return null;
    const f = x.forms.get(fid);
    if (!f) {
      sc.want.add(WANT_QUICK + fid);
      return null;
    }
    const api = !pane && host.host === x.formId && x.formApi ? tryGet<CtlApi | null>(() => x.xrm.Page.ui.quickForms.get(qv) || null, null) : null;
    return { f, api, cold: false, ctl: inner, entity: f.entity, page: false };
  }
  if (pane) {
    const fid = formIdOf(box?.id) || paneForm(el);
    if (!fid) return null;
    const f = x.forms.get(fid);
    if (!f) {
      sc.want.add(WANT_FORM + fid);
      return null;
    }
    return { f, api: null, cold: true, ctl, entity: f.entity, page: false };
  }
  return { f: x, api: { getControl: (n) => x.xrm.Page.getControl(n) }, cold: x.record && !x.formApi, ctl, entity: x.entity, page: true };
}

/**
 * True when a page field container names another form than the page's (`id-<form id>-…`): a form shown in a way not
 * recognized as a dialog or a pane is never mapped onto the page's form. Process step controls are the process's.
 */
function wrongForm(x: PageIndex, box: Element, ctl: string): boolean {
  const f = formIdOf(box.id);
  return !!f && !!x.formId && f !== x.formId && !ctl.startsWith('header_process_');
}

/** The form cell of a control on a form other than the page's (formAt). */
const cellAt = (at: FormAt, el: Element): Slot | undefined => fieldIn(at.f, at.api, at.ctl, at.cold ? placeOf(el) : undefined, at.cold);

/**
 * A sub-field of a composite column (an address's street and city, a full name's first and last name) is no form cell:
 * Dynamics names its control `<composite control>_compositionLinkControl_<column>` and labels it with that column's
 * display name on every form (live, account: `address1_composite_compositionLinkControl_address1_line1` shows
 * address1_line1's "Address" / "Adresse"). It is that column's name only when its label shows one of the column's texts
 * and, where a form API knows the control, the control is bound to that very column: never the first text, never a
 * cell of the form.
 */
function compositePart(sc: Scanner, c: Element, at: FormAt, col: string): Anchor | null {
  const x = sc.x!;
  if (at.page && (foreign(x, c, at.ctl) || wrongForm(x, c, at.ctl))) return null;
  const bound = tryGet(() => String(at.api?.getControl(at.ctl)?.getAttribute()?.getName() || ''), '').toLowerCase();
  if (bound && bound !== col) return null;
  const s = at.entity ? x.main.get(`attribute|${at.entity}.${col}`) : undefined;
  if (!s) {
    sc.wantTable(at.entity); // its table's columns aren't loaded yet (a side pane's or a quick view's table)
    return null;
  }
  const lab = labelOf(c, at.ctl);
  const ls = x.labels(s);
  const t = lab && find(sc, lab, (v) => (ls.has(v) ? s : undefined), 8);
  if (!t) return null;
  // On the page form: its composite control's cell is where it shows (another tab, reveal.ts).
  if (at.page) sc.parts.set(s.comp, at.ctl.replace(/_compositionLinkControl_.*$/i, '').toLowerCase());
  return A(x, lab, s, { hit: c, zone: lab, text: t[2] });
}

/**
 * The table and column of a form control on any form (the page's, a side pane's, a quick view's), with its value
 * when a form API has it (`has`); null when unknown. On the page's own form: ctlColumn.
 */
function ctlInfo(sc: Scanner, el: Element, ctl: string): { entity: string; col: string; value?: unknown; has: boolean } | null {
  const x = sc.x!;
  if (away(el, ctl)) return null;
  const at = formAt(sc, el, ctl);
  if (!at) return null;
  if (at.page) {
    const cv = foreign(x, el, ctl) ? null : ctlColumn(x, ctl);
    return cv && { entity: x.entity, ...cv };
  }
  if (at.api)
    try {
      const a = at.api.getControl(at.ctl).getAttribute();
      return { entity: at.entity, col: String(a.getName()).toLowerCase(), value: a.getValue(), has: true };
    } catch {
      /* no such control: its cell tells */
    }
  // A cell whose control shows its column (not a quick view or a sub-grid bound to a lookup).
  const s = cellAt(at, el);
  const c = s ? columnOf(s) : null;
  return c ? { entity: c.entity.toLowerCase(), col: c.attr, has: false } : null;
}

/** The label slot of a header field: the page form's (ctlSlot), or the cell of a side pane's form. */
function headerSlot(sc: Scanner, el: Element, ctl: string): Slot | undefined {
  const x = sc.x!;
  if (away(el, ctl)) return undefined;
  if (!paneOf(el)) return foreign(x, el, ctl) ? undefined : ctlSlot(x, ctl);
  const at = ctl.startsWith('header_process_') ? null : formAt(sc, el, ctl);
  return at && !at.page ? cellAt(at, el) : undefined;
}

/** A tab or a section ('t:<tab>', 's:<section>') of the form an element is on: the page's own, or a side pane's. */
function named(sc: Scanner, el: Element, key: string): Slot | undefined {
  const x = sc.x!;
  if (away(el)) return undefined;
  if (!paneOf(el)) return foreign(x, el) ? undefined : byName(x, key);
  const fid = paneForm(el);
  const f = fid ? x.forms.get(fid) : undefined;
  if (fid && !f) sc.want.add(WANT_FORM + fid);
  return f?.names.get(key.toLowerCase());
}

/** The tabs of the form an element is on are loaded (see named): a name it doesn't find is none of that form's. */
function tabsKnown(sc: Scanner, el: Element): boolean {
  const x = sc.x!;
  if (away(el)) return false;
  if (!paneOf(el)) return !foreign(x, el) && x.formReady;
  const fid = paneForm(el);
  return !!fid && x.forms.has(fid);
}

/** The option a closed choice control shows: by its form API value, checked against the text; else by the text. */
function formValue(sc: Scanner, root: Element, list: Slot[], cv: { value?: unknown; has: boolean }): [Element, Slot, Text | undefined] | null {
  const x = sc.x!;
  const byText = (v: string) => optionByText(list, v, x.user, x.base);
  if (root.tagName === 'SELECT') {
    const o = (root as HTMLSelectElement).selectedOptions?.[0];
    const t = o ? byText(o.text) : undefined;
    const s = cv.has ? optionByValue(list, cv.value) : t;
    return s && (!t || t === s) ? [root, s, undefined] : null;
  }
  if (!cv.has) {
    const r = find(sc, root, byText, 12);
    return r && [r[0], r[1], r[2]];
  }
  const s = optionByValue(list, cv.value);
  if (!s) return null;
  const mine = x.labels(s);
  const r = find(sc, root, (v) => (mine.has(v) ? s : undefined), 12);
  if (r) return [r[0], s, r[2]];
  // The text names another option: the control and its value disagree, so nothing is anchored.
  if (find(sc, root, byText, 12)) return null;
  // Its label changed since the page showed it (just saved): the control's only text is still the value.
  const t = shown(sc, root, null, 12, true);
  return t && [t[0], s, t[1]];
}

// ---- rules: selector -> resolver ----

/** A rule finds the label an element shows, or several (the parts of one text: multi-select values, linked headers). */
type Rule = [string, (el: Element, sc: Scanner) => Anchor | Array<Anchor | null> | null];
const HEADER = '[role="columnheader"][col-id],[role="columnheader"][data-item-key]';
/**
 * A column header of the classic read-only grid (`MscrmControls.Grid.GridControl`, Wijmo; live 2026-10-17 in the
 * Connections associated view, LIVE-FINDINGS 91): the header cell shown, `div.wj-cell.wj-header#<grid>-<column>` in
 * `.wj-colheaders`, its column in its data-id (no col-id). Its `[role=columnheader]` twins are an invisible copy
 * (opacity 0) for screen readers that names no column.
 */
const CLASSIC_HEADER = '[class*="wj-header"][data-id]';
/** Its header button: `Grid<grid id>_headerButton<column>`. The selection column (`btnheaderselectcolumn`) has none. */
const HEADER_BUTTON = /^(Grid[\da-f{}-]+)_headerButton([a-z0-9_]+(?:\.[a-z0-9_]+)?)$/i;
const CELL = '[role="gridcell"][col-id],[role="gridcell"][data-item-key],[role="gridcell"][data-automation-key]';
/**
 * Closed choice controls of a form: option set (button or select), status reason, Yes/No toggle or checkbox. The
 * live-probed ids end exactly so (`<ctl>.fieldControl-option-set-select`, `<ctl>.fieldControl-toggle-container`),
 * which keeps a portaled list whose id merely contains them (a dropdown's listbox) from becoming a value control.
 */
const VALUE = '[data-id$=".fieldControl-option-set-select"],[data-id*=".fieldControl-pickliststatus-comboBox"],[data-id$=".fieldControl-toggle-container"],[data-id*=".fieldControl-checkbox-container"]';
/**
 * A multi-select control (LIVE-FINDINGS 54): `data-id="<ctl>.fieldControl_container"` with the control's class
 * (`MultiSelectPicklist.UpdMSPicklistControl`); its `data-lp-id` is not always rendered.
 */
const MULTI = '[data-id$=".fieldControl_container"][class*="MultiSelectPicklist."],[data-lp-id^="MscrmControls.MultiSelectPicklist."]';
const GRID_ROOT = '[data-control-name],[data-id$="_control_container"]';
/** A grid's root, whose `data-lp-id` names its control, tables and view (parts.ts lpGrid): Power Apps grids, the classic one. */
const GRID_LP = '[data-lp-id*="Grid|"],[data-lp-id*="GridControl|"]';
/** Parts of a control or section that show other labels or record data: a container's own label is never read there. */
const INNER = `${FIELD_SEL},[role="columnheader"],[role="gridcell"],[role="row"]`;
/** The list of a flyout (a view selector's views, a command's menu). */
const LISTS = '[role="menu"],[role="listbox"]';
/** A view selector, or a part of one. */
const VIEW_SELECTOR = '[id*="viewselector" i],[data-id*="viewselector" i]';
/** A view selector's ids carry its view's id: ViewSelector_<view id>, ViewSelector_<n>_<view id>_<guid>_text (LIVE-FINDINGS 88). */
const VIEW_SEL = /^ViewSelector_(?:\d+_)?([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})(?:_|$)/i;
/** A command bar (form, list, sub-grid, associated grid). */
const CMD_BAR = '[data-lp-id^="commandbar-"],[data-id="CommandBar"],[id="CommandBar"]';
/** A plain control id, as Dynamics' own bar buttons have (ShowChartPane); custom classic ones are dotted, modern ones carry '!'. */
const PLAIN_CTL = /^[A-Za-z][A-Za-z0-9]*$/;
/** A button at the top of a command bar, never an item of a flyout (those can list records: reports, templates, flows). */
const onBar = (el: Element): boolean => !!el.closest(CMD_BAR) && !el.closest(LISTS);
/** The table a command bar is for: `commandbar-<bar>:<table>` (`commandbar-SubGridAssociated:contact`, LIVE-FINDINGS 89). */
const BAR_TABLE = /^commandbar-\w+:([a-z0-9_]+)$/i;
/** The table a Microsoft command is for: `Mscrm.SubGrid.<table>.…`, `Mscrm.Form.<table>.…`, `Mscrm.HomepageGrid.<table>.…`. */
const CMD_TABLE = /^Mscrm\.(?:SubGrid|Form|HomepageGrid)\.([a-z0-9_]+)\./i;
/** A ribbon label UCI builds around its table's display name, or (Plural) its plural name: `{0}` is that name. */
const NAME_LABEL = /^\$Resources\(Entity(Plural)?DisplayName\):/i;
/**
 * Microsoft's commands whose labels are such (NAME_LABEL): New and Add Existing ("New Person", "Add Existing Person"),
 * Export ("Export People"). Any other built-in command's text is the language pack's alone, even where one of its words
 * is its table's name ("Resolve Case" of cases, "Email a Link" of emails, "Show Chart" of a table named Chart).
 */
const NAMED_CMD = /^Mscrm\.(?:SubGrid|Form|HomepageGrid)\.[a-z0-9_]+\.(?:\w+\.)*(?:AddNew|AddExisting|Export)/i;

/**
 * The view a view selector element shows: the view id its own element id (or one of its two nearest ancestors') carries,
 * and the view of the grid it heads (the nearest ancestor holding exactly one grid, its data-lp-id, which follows a view
 * switch, LIVE-FINDINGS 57); both must agree when both are known. An item of a list of views: the ids inside the list
 * only (the list's own may name the view shown). '' when unknown.
 */
export function selectorView(el: Element): string {
  const list = el.closest(LISTS);
  let own = '';
  for (let n: Element | null = el, i = 0; n && n !== list && i < 3 && !own; n = n.parentElement, i++) own = (VIEW_SEL.exec(n.id || '')?.[1] || '').toLowerCase();
  if (list) return own;
  let grid = '';
  for (let n: Element | null = el, i = 0; n && i < 8; n = n.parentElement, i++) {
    const gs = n.matches(GRID_LP) ? [n] : Array.from(n.querySelectorAll(GRID_LP));
    if (gs.length > 1) break; // several grids: which one it heads is unknown
    if (gs.length) {
      grid = lpGrid(gs[0].getAttribute('data-lp-id'))?.view || '';
      break;
    }
  }
  return own && grid && own !== grid ? '' : own || grid;
}

/**
 * True when a grid element is not to be mapped: in quick create or a dialog, or on the page while its form is being
 * replaced (formMoved). A side pane's grid counts: its table comes from the grid itself (Scanner.gridTable).
 */
const gridAway = (x: PageIndex, el: Element): boolean => away(el) || (x.stale && !paneOf(el));

/** The text a column shows in the user's language: its name there, else the base one (normalized; empty when it has none). */
const userText = (x: PageIndex, s: Slot): Set<string> => new Set([norm(s.labels[x.user] || s.labels[x.base])].filter(Boolean));

/**
 * A linked-table column header ('<alias>.<column>', LIVE-FINDINGS 57): the related column's name and, in brackets,
 * the lookup's name, each its own part of the one text. The alias is resolved through the grid's query. `strict`: a part
 * only where it is that name in the user's language (gridHeader).
 */
function linkedHeaders(sc: Scanner, el: Element, key: string, strict = false): Array<Anchor | null> | null {
  const x = sc.x!;
  const ln = linkedColumn(key, sc.gridLinks(el));
  if (!ln) return null;
  const s = x.main.get(`attribute|${ln.entity}.${ln.attr}`);
  const lk = ln.to ? x.main.get(`attribute|${ln.parent}.${ln.to}`) : undefined;
  if (!s) sc.wantTable(ln.entity);
  if (ln.to && !lk) sc.wantTable(ln.parent);
  const t = s && find(sc, el, (v) => MEANT.test(v) || undefined, 12, '', true);
  if (!s || !t) return null;
  const p = linkedHeader(sc.textOf(t[2]), x.labels(s), lk ? x.labels(lk) : new Set());
  const ok = (q: Part | undefined, z: Slot | undefined): z is Slot => !!q && !!z && (!strict || userText(x, z).has(norm(q.text)));
  const o = { role: 'header' as const, hit: el, zone: el, text: t[2] };
  return [ok(p.col, s) ? A(x, t[0], s, { ...o, part: p.col }) : null, ok(p.look, lk) ? A(x, t[0], lk, { ...o, part: p.look }) : null];
}

/**
 * A grid column header (`key`: its column, or '<alias>.<column>' for a linked table's): that column's name, of the table
 * the grid shows (Scanner.gridTable). The header text is underlined (its visible copy: the grid renders it twice); the
 * whole header cell takes the click (Alt+click sorts as usual). `strict` (the classic grid, whose column comes from an
 * element id rather than the grid's column key): only where the text is what that column shows in the user's language; a
 * Power Apps grid's header is its col-id's column, whatever text a cache still shows.
 */
function gridHeader(sc: Scanner, el: Element, key: string, strict = false): Anchor | Array<Anchor | null> | null {
  const x = sc.x!;
  if (gridAway(x, el)) return null;
  const e = sc.gridTable(el);
  if (!e) return null;
  const col = colKey(key);
  if (!col) return linkedHeaders(sc, el, key, strict);
  const s = x.main.get(`attribute|${e}.${col}`);
  if (!s) {
    sc.wantTable(e); // a sub-grid of a table that isn't loaded yet
    return null;
  }
  const ls = strict ? userText(x, s) : x.labels(s);
  const t = find(sc, el, (v) => ls.has(v) || undefined, 12, '', true) || (strict ? null : find(sc, el, (v) => MEANT.test(v) || undefined, 12, '', true));
  if (strict && !t) return null;
  return A(x, t ? t[0] : el, s, { role: 'header', hit: el, zone: el, text: t?.[2] });
}

/**
 * The column a classic grid header names (CLASSIC_HEADER): its data-id, when its id (`<grid>-<column>`) and its one header
 * button (HEADER_BUTTON) name that same column; '' for the selection column (no header button) and anything else.
 */
function classicColumn(head: Element): string {
  if (!head.closest('[class*="wj-colheaders"]')) return '';
  const bs = Array.from(head.querySelectorAll('[id*="_headerButton"]'));
  const m = bs.length === 1 ? HEADER_BUTTON.exec(bs[0].id) : null;
  if (!m) return '';
  const col = m[2].toLowerCase();
  return attr(head, 'data-id').toLowerCase() === col && head.id.toLowerCase() === `${m[1]}-${m[2]}`.toLowerCase() ? col : '';
}

/**
 * The table a built-in command is for, as its control id (`ctl`), its button's data-id (`ent`, its first part) and its
 * command bar say: '' when none says, null when they disagree (a command of another table is never offered as this one's).
 */
function commandTable(el: Element, ctl: string, ent: string): string | null {
  const bar = BAR_TABLE.exec(el.closest(CMD_BAR)?.getAttribute('data-lp-id') || '')?.[1];
  const ts = new Set([CMD_TABLE.exec(ctl)?.[1], ent, bar].filter((t): t is string => !!t).map((t) => t.toLowerCase()));
  return ts.size > 1 ? null : ([...ts][0] ?? '');
}

/**
 * The names of its table a built-in command's text is built around: the one its label names, where its label is known
 * (`lab`, a customization's: NAME_LABEL; any other label is the language pack's text alone), else either for a command
 * of the kinds whose labels name one (NAMED_CMD); none for any other command.
 */
function namedBy(ctl: string, lab: string): Prop[] {
  if (!lab) return NAMED_CMD.test(ctl) ? ['DisplayName', 'DisplayCollectionName'] : [];
  const m = NAME_LABEL.exec(lab);
  return m ? [m[1] ? 'DisplayCollectionName' : 'DisplayName'] : [];
}

/**
 * A built-in command (`ctl`; `t` its text, `lab` its label where a customization of its table gives one): Microsoft's
 * text, grey. Unless the language pack builds that text around its table's display or plural name (namedBy), as shown
 * in the user's language ("New Person", "Add Existing Person", "Export People"): that name is then a part of the text,
 * anchored to the table's slot (the button takes the click), so translating it changes the button. The table's names
 * are read on demand; meanwhile such a command has no mark (never a passing grey one), grey once that read failed.
 * `ent`: the table its data-id names ('' without one).
 */
function command(sc: Scanner, el: Element, ctl: string, ent: string, t: [Element, Text] | null | undefined, lab = ''): Anchor | null {
  const x = sc.x!;
  const props = t ? namedBy(ctl, lab) : [];
  const e = props.length ? commandTable(el, ctl, ent) : null;
  if (e && t) {
    const dc = x.store.get(`entity|${e}|DisplayCollectionName`);
    if (!dc && !x.gaveUp.has(WANT_NAMES + e)) {
      sc.want.add(WANT_NAMES + e);
      return null;
    }
    const names = props.map((p) => x.store.get(`entity|${e}|${p}`));
    const at = namePart(sc.textOf(t[1]), names.map((s) => (s ? s.labels[x.user] || s.labels[x.base] || '' : '')));
    const s = at && names[at.i];
    if (s) return A(x, t[0], s, { role: 'command', hit: el, zone: el, text: t[1], part: at.part });
  }
  return builtin(el, `command|${ctl}`, 'ribbon', 'command', t?.[1]);
}

/**
 * A related menu item of the page form by its nav id (LIVE-FINDINGS 63), wherever the page shows it: in the related menu
 * (`form-tab-relatedEntity-<nav id>`) or as the tab of the view it opened (`tablist-<nav id>`, LIVE-FINDINGS 88). One
 * mapping for both, so they are one label: the form XML's entry (navitem), a built-in item (Microsoft's text), else the
 * page table's relationship whose text it shows. Role 'nav': a click opens the popup, Open shows the item's view. The
 * caller has made sure `el` is the page form's (foreign).
 */
function relatedItem(sc: Scanner, el: Element, id: string): Anchor | null {
  const x = sc.x!;
  // An item the form XML lists, with titles of its own. Where it has none in the user's language it shows its
  // relationship's text (LIVE-FINDINGS 80): the table's relationships are loaded for it, as for the items below.
  const s = byName(x, 'n:' + id);
  if (s) {
    const src = navSource((k) => x.store.slots.get(k), s);
    if (!src && menuRelationship(s)) sc.want.add(WANT_RELATED + (s.entity || x.entity));
    const t = shown(sc, el, src ? new Set([...x.labels(s), ...x.labels(src)]) : x.labels(s), 8)?.[1];
    const a = A(x, el, s, { role: 'nav', text: t });
    if (a && t) a.orig = sc.textOf(t);
    return a;
  }
  // A built-in item the form XML doesn't list (Background Processes, Audit History…): Microsoft's text. Only once the
  // form's own entries are known: a form can list (and rename) one (navAudit, LIVE-FINDINGS 63).
  if (BUILT_IN_NAV.test(id) && !RELATED_NAV.has(id.toLowerCase())) return x.formReady ? builtin(el, `nav|${id}`, 'navitem', 'nav', shown(sc, el, null, 8)?.[1]) : null;
  // Else one of the page table's relationships (LIVE-FINDINGS 63), as long as the item shows that very text: the
  // relationship's menu label, or the plural name of the table it lists.
  const r = x.related.get(id.toLowerCase());
  if (!r) {
    sc.want.add(WANT_RELATED + x.entity);
    return null;
  }
  const ls = x.labels(r);
  const t = shown(sc, el, ls, 8);
  return t && ls.has(norm(sc.textOf(t[1]))) ? A(x, el, r, { role: 'nav', text: t[1] }) : null;
}

const RULES: Rule[] = [
  [
    FIELD_SEL,
    (c, sc) => {
      const x = sc.x!;
      const ctl = attr(c, 'data-id').slice(0, -FIELD.length);
      const step = STEP_CTL.exec(ctl)?.[1];
      if (step) {
        // A step of the page's process, in its stage's flyout (a dialog of the page form): the step its container names.
        const s = x.stale || paneOf(c) || !c.closest(FLYOUT) ? undefined : byName(x, 'sp:' + step);
        const lab = s && c.querySelector('label[id$="-field-label"]');
        const t = lab && shown(sc, lab, x.labels(s), 8);
        return t ? A(x, lab, s, { hit: c, zone: lab, text: t[1] }) : null;
      }
      const at = away(c, ctl) ? null : formAt(sc, c, ctl);
      if (!at) return null;
      // A composite column's sub-field (an address's street, a full name's first name) is no form cell: its column's name.
      const part = COMPOSITE.exec(at.ctl)?.[1];
      if (part) return compositePart(sc, c, at, part.toLowerCase());
      // The page's own form through its form API; a quick view's or a side pane's form through its own cells.
      const s = at.page ? (foreign(x, c, ctl) || wrongForm(x, c, ctl) ? undefined : ctlSlot(x, ctl, placeOf(c))) : cellAt(at, c);
      if (!s) return null;
      const texts = fieldTexts(x, s);
      // The label element is the click zone: the container holds the input, which keeps working.
      const lab = labelOf(c, at.ctl);
      if (lab) {
        // A label hidden on the form renders an empty label element (live probes): nothing on the page shows it,
        // so it gets no anchor (the list still has the field). It is anchored once its text renders.
        const t = shown(sc, lab, texts, 8);
        return t ? A(x, lab, s, { hit: c, zone: lab, text: t[1] }) : null;
      }
      const r = find(sc, c, (v) => (texts.has(v) ? s : undefined), 20);
      return r && A(x, r[0], s, { hit: c, text: r[2] });
    },
  ],
  // Header fields shown without a field container (collapsed header).
  [
    '[data-id^="header_"]',
    (el, sc) => {
      const x = sc.x!;
      const ctl = attr(el, 'data-id');
      if (!/^header_\w+$/.test(ctl) || el.closest(FIELD_SEL) || el.querySelector(FIELD_SEL)) return null;
      const s = headerSlot(sc, el, ctl);
      if (!s) return null;
      const texts = fieldTexts(x, s);
      const r = find(sc, el, (v) => (texts.has(v) ? s : undefined), 12);
      return r && A(x, r[0], s, { hit: el, text: r[2] });
    },
  ],
  // Header fields in the header strip, next to the record title: items in the open shadow root of
  // `uci-header-control-list`, each with its label in a `[slot=label]` child.
  [
    'uci-header-control-list-item[data-name^="header_"]',
    (el, sc) => {
      const x = sc.x!;
      const ctl = attr(el, 'data-name');
      const s = /^header_\w+$/.test(ctl) ? headerSlot(sc, el, ctl) : undefined;
      const lab = s && el.querySelector('[slot="label"]');
      const t = lab && shown(sc, lab, fieldTexts(x, s), 8);
      return t ? A(x, lab, s, { hit: el, zone: lab, text: t[1] }) : null;
    },
  ],
  // Sub-grids, quick views, web resources: their label is a heading inside the control.
  [
    '[data-control-name]',
    (c, sc) => {
      const x = sc.x!;
      const ctl = attr(c, 'data-control-name');
      const at = away(c, ctl) ? null : formAt(sc, c, ctl);
      const s = !at ? undefined : at.page ? (foreign(x, c, ctl) ? undefined : fieldOf(x, ctl, placeOf(c))) : cellAt(at, c);
      // Its title; never a field or a grid header inside it that reads the same (a title hidden on the form).
      return inSlot(sc, c, s, 30, {}, INNER);
    },
  ],
  // A control's title in its own action bar (`action_bar_header_title<control id>`, live: the timeline's "Chronologie" on
  // the account form): the label of its form cell. The form API doesn't know the timeline (getControl('notescontrol') is
  // null), so the id in the title's own id names the cell: the only cell of its form with that control id, and one that
  // shows no column (a field's label is its container's).
  [
    `[id^="${ACTION_TITLE}"]`,
    (el, sc) => {
      const x = sc.x!;
      const ctl = el.id.slice(ACTION_TITLE.length).toLowerCase();
      if (!ctl || away(el) || inQuickView(x, el)) return null;
      let f: FormCells | undefined;
      if (paneOf(el)) {
        const fid = paneForm(el);
        f = fid ? x.forms.get(fid) : undefined;
        if (fid && !f) sc.want.add(WANT_FORM + fid);
      } else if (!foreign(x, el)) {
        const box = closestDeep(el, FIELD_ID);
        if (!box || !wrongForm(x, box, ctl)) f = x;
      }
      const cells = f?.fields.get(ctl) || [];
      const s = cells.length === 1 && !columnOf(cells[0]) ? cells[0] : undefined;
      // Its label's text, else its only text, but only for a cell without a label in the user's language (it shows a
      // default then): a title worded otherwise is not that label.
      const ls = s ? x.labels(s) : null;
      const t = s && shown(sc, el, ls, 6, true);
      const ok = t && (ls!.has(norm(sc.textOf(t[1]))) || !(s!.labels[x.user] || '').trim());
      return ok ? A(x, t[0], s!, { hit: el, zone: el, text: t[1] }) : null;
    },
  ],
  [
    // A tab, or one that didn't fit, in the "More tabs" menu (a menu item with the same data-id).
    'li[data-id^="tablist-"],[role="menuitem"][data-id^="tablist-"]',
    (el, sc) => {
      const x = sc.x!;
      const name = attr(el, 'data-id').slice(8);
      const s = named(sc, el, 't:' + name);
      // The tab itself is the anchor (its data-id and aria-selected say which tab is shown).
      if (s) return A(x, el, s, { role: 'tab', text: shown(sc, el, x.labels(s), 8)?.[1] });
      // Anything else only once its form is known to have no tab of that name.
      if (!tabsKnown(sc, el)) return null;
      // The Related tab: Microsoft's text. Like a related menu item, a click opens its popup only (Open, or Alt+click,
      // opens the menu).
      if (el.matches(RELATED_TAB)) return builtin(el, 'tab|related', 'tab', 'nav', shown(sc, el, null, 8)?.[1]);
      // The view a related menu item opened, shown as a tab of its own (`tablist-<nav id>`, LIVE-FINDINGS 88): that item's
      // text, mapped like the item. The page's form only (a side pane's related menu isn't loaded).
      return !paneOf(el) && (/^nav/i.test(name) || !!byName(x, 'n:' + name)) ? relatedItem(sc, el, name) : null;
    },
  ],
  [
    'section[data-id]',
    (el, sc) => {
      const x = sc.x!;
      if (inQuickView(x, el)) return null;
      const s = named(sc, el, 's:' + attr(el, 'data-id'));
      // The section's own heading: never the title of a sub-grid, quick view or field inside it. A section label
      // hidden on the form often reads like the sub-grid it holds ("Contacts"); that title is the sub-grid's.
      const own = `${INNER},[data-control-name]`;
      const mine = (n: Element) => {
        const z = n.closest(own);
        return n.closest('section') === el && !(z && z !== el && el.contains(z));
      };
      const hd = Array.from(el.querySelectorAll('h2,h3,[role="heading"]')).find(mine);
      // When the id is not the section name, match the heading text (the page's own form only), but never inside a
      // quick view.
      if (!s) return hd && !foreign(x, el) && !el.closest('[data-control-name]') ? inMap(sc, hd, x.text.section, { cap: 4, hit: el, zone: hd }) : null;
      // Without a matching heading: the section's own text, never a field label, sub-grid or grid inside it (a
      // hidden section label and a field of the same name would edit the section).
      return (hd && inSlot(sc, hd, s, 4, { hit: el, zone: hd })) || inSlot(sc, el, s, 12, { hit: el }, own);
    },
  ],
  ['[data-id^="form-tab-relatedEntity-"]', (el, sc) => (foreign(sc.x!, el) ? null : relatedItem(sc, el, attr(el, 'data-id').slice(23)))],
  // The whole stage chip takes the click (not only its text).
  // A stage chip: the stage its id names (`…processHeaderStage_<stage id>`), whatever name the page still shows (UCI keeps
  // a process's names cached, LIVE-FINDINGS 64), never a stage of another process; by its name only without an id. The
  // whole chip takes the click.
  [
    'li[id*="processHeaderStage"]',
    (el, sc) => {
      const x = sc.x!;
      if (foreign(x, el)) return null;
      const id = /processHeaderStage_([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})/i.exec(el.id)?.[1];
      if (!id) return inMap(sc, el, x.text.stage, { role: 'stage', zone: el });
      const s = byName(x, 'st:' + id);
      if (!s) return null;
      const nm = el.querySelector('[id*="processHeaderStageName"]') || el;
      const t = shown(sc, nm, x.labels(s), 6);
      return A(x, t ? t[0] : nm, s, { role: 'stage', hit: el, zone: el, text: t?.[1] });
    },
  ],
  // The process's name above its stages (`…ProcessBreadCrumb-processHeaderNameLabel`, "bpf test"): the name of the
  // record's active process, whatever (cached) name the page still shows, like its stage chips (LIVE-FINDINGS 64). The
  // label has no id of its own, so the form API must name the process the index was built for (a process just
  // switched to is never mapped onto the previous one's name).
  [
    '[id$="processHeaderNameLabel"]',
    (el, sc) => {
      const x = sc.x!;
      const s = x.bpf;
      if (!s || foreign(x, el)) return null;
      const live = tryGet(() => guid(x.xrm.Page.data.process.getActiveProcess().getId()), '');
      if (live && live !== guid(s.ref?.id)) return null;
      const t = shown(sc, el, x.labels(s), 4);
      return A(x, t ? t[0] : el, s, { hit: el, zone: el, text: t?.[1] });
    },
  ],
  // An open stage flyout of the page's process (a dialog of the page form, LIVE-FINDINGS 92): its title
  // (`<STAGE_LABEL>flyoutStageName`) is the stage the flyout's id names, whatever (cached) name it shows, like its chip;
  // a plain label (it is the open flyout: nothing to show). Its buttons' labels (`<STAGE_LABEL>Next Stage`…) are
  // Microsoft's text; the button takes the click, so it never moves the process (Alt+click does). Anything else in it
  // (its close button, "Active for 50 hours") is no label.
  [
    `label[id^="${STAGE_LABEL}"]`,
    (el, sc) => {
      const x = sc.x!;
      const name = el.id.slice(STAGE_LABEL.length);
      const f = flyoutStage(el);
      if (!f || x.stale || paneOf(el) || el.closest('[data-id="quickCreateRoot"]')) return null;
      if (name === 'flyoutStageName') {
        const s = byName(x, 'st:' + f.id);
        const t = s && shown(sc, el, x.labels(s), 6);
        return t ? A(x, t[0], s, { zone: el, text: t[1] }) : null;
      }
      const t = STAGE_BUTTONS.has(name) ? shown(sc, el, null, 6) : null;
      if (!t) return null;
      const a = builtin(el, `stage|${name}`, 'ribbon', 'command', t[1]);
      const b = el.closest('button,[role="button"]');
      if (b && f.fly.contains(b)) a.zone = b;
      return a;
    },
  ],
  [
    'button[data-id*="|"],[role="menuitem"][data-id*="|"]',
    (el, sc) => {
      const x = sc.x!;
      const seg = attr(el, 'data-id').split('|');
      if (seg.length < 4) return null;
      const ent = seg[0];
      const ctl = seg[seg.length - 1].replace(/-(Large|Medium|Small)$/, '');
      let s: Slot | undefined;
      if (isModern(ctl)) {
        const c = x.cmd.get(ctl.toLowerCase());
        if (!c) sc.want.add(`${ent}|${ctl}`);
        s = c ? x.main.get(c) : undefined;
      } else {
        if (!/^[a-z0-9_]+$/i.test(ent)) return null;
        // The table's customized buttons (ribbondiffs, fast) say which ones carry a label of their own.
        const rb = x.ribbon.get(ent);
        if (!rb) {
          sc.want.add(`${ent}|${ctl}`);
          return null;
        }
        const lab = rb.get(ctl)?.labelText || '';
        const id = /^\$LocLabels:(.+)$/.exec(lab)?.[1];
        // Microsoft's own buttons nobody gave a label of their own show language-pack text: built-in (or their table's
        // name, see command). So does a label that is a $Resources token, and a button at the top of the bar with a plain
        // id no customization of its table defines (Show Chart, LIVE-FINDINGS 89).
        if (!id && (/^Mscrm\./i.test(ctl) || /^\$Resources[:(]/i.test(lab) || (!rb.has(ctl) && PLAIN_CTL.test(ctl) && onBar(el))))
          return command(sc, el, ctl, ent, shown(sc, el, null, 12), lab);
        s = id ? x.main.get(`ribbon|${ent}|${id}`) || x.main.get(`ribbon|_app|${id}`) : undefined;
      }
      return s ? A(x, el, s, { role: 'command', text: shown(sc, el, x.labels(s), 12)?.[1] }) : null;
    },
  ],
  // "Form assist" and "Share" (FORM_BUTTONS): Microsoft's text, by their fixed ids. Like a command, a click opens the popup
  // only (Alt+click uses the button); shown as an icon alone, one has no text to mark. Before the command bar's rule below:
  // every render of Share is one label.
  [
    FORM_BUTTONS,
    (el, sc) => {
      const name = [attr(el, 'data-id'), el.id].includes(FORM_ASSIST) ? FORM_ASSIST : SHARE.exec(el.id)?.[1];
      const t = !name || away(el) ? null : shown(sc, el, null, 8);
      return t ? builtin(el, `command|${name}`, 'ribbon', 'command', t[1]) : null;
    },
  ],
  // A button Dynamics adds to a command bar itself, without a ribbon id ("Show Chart", `#ShowChartPane`, on an associated
  // grid's bar, LIVE-FINDINGS 89): no customization defines it, so its text is the language pack's. Never a flyout's
  // item, never a view selector (view names are translatable).
  [
    'button[role="menuitem"]',
    (el, sc) => {
      if (attr(el, 'data-id').includes('|') || !onBar(el) || el.matches(VIEW_SELECTOR) || away(el)) return null;
      const t = shown(sc, el, null, 12);
      const id = el.id || attr(el, 'data-id');
      return t && id ? builtin(el, `command|${id}`, 'ribbon', 'command', t[1]) : null;
    },
  ],
  [
    '[data-id^="sitemap-entity-"]',
    (el, sc) => {
      const x = sc.x!;
      const id = attr(el, 'data-id').slice(15);
      // Home, Recent and Pinned themselves: Microsoft's own entries (language-pack text). An entry nested in one (a
      // pinned record) is a record's name.
      const home = NAV_HOME.exec(id);
      if (home && !el.parentElement?.closest('[data-id^="sitemap-entity-"]')) {
        const t = find(sc, el, (v) => MEANT.test(v) || undefined, 6, '[role="group"],[role="treeitem"],ul');
        return t ? builtin(el, `nav|${home[1].toLowerCase()}`, 'subarea', 'nav', t[2]) : null;
      }
      // What Recent and Pinned list under them are record and view names, not sitemap titles.
      if (/^(pinned|recent)/i.test(id)) return null;
      const s = byName(x, 'sa:' + id);
      // A subarea without titles shows its table's plural name: that slot is the anchor's (and the popup's focus), its
      // table's names read on demand, but only where the entry shows one of its texts. Nothing is marked while they load
      // (never a passing grey mark); once their read failed, or where the entry shows another text, the subarea itself,
      // read-only, says to translate the table.
      const e = s ? pluralOf(s) : '';
      const t = e ? x.store.get(`entity|${e}|DisplayCollectionName`) : undefined;
      if (e && !t) {
        sc.want.add(WANT_NAMES + e);
        if (!x.gaveUp.has(WANT_NAMES + e)) return null;
      }
      const pl = t ? shown(sc, el, x.labels(t), 12) : null;
      if (t && pl && x.labels(t).has(norm(sc.textOf(pl[1])))) return A(x, el, t, { role: 'nav', text: pl[1] });
      if (s && (!another(x, 'sa', id, s) || ownText(sc, el, s, 12))) return A(x, el, s, { role: 'nav', text: shown(sc, el, x.labels(s), 12)?.[1] });
      // Its Id is another entry's resource, and what that item shows is unknown (no title of its own, its table's plural
      // name not read): either may be this entry. No mark, never a guess.
      if (s?.ref.unnamed && !t) return null;
      return inMap(sc, el, x.text.subarea, { cap: 8, role: 'nav', zone: el }) || unnamedItem(sc, el, 'sa', id, 12);
    },
  ],
  [
    '[data-id*="sitemap-sitemapAreaGroup"]',
    (el, sc) => {
      const x = sc.x!;
      const id = attr(el, 'data-id').replace(/^.*sitemapAreaGroup-?/, '');
      const s = byName(x, 'gr:' + id);
      if (s && (!another(x, 'gr', id, s) || ownText(sc, el, s, 8))) return A(x, el, s, { role: 'nav', text: shown(sc, el, x.labels(s), 8)?.[1] });
      // Its Id is another heading's resource, and what that group shows is unknown (no title of its own): no mark.
      if (s?.ref.unnamed) return null;
      return inMap(sc, el, x.text.group, { cap: 8, role: 'nav', zone: el }) || unnamedItem(sc, el, 'gr', id, 8);
    },
  ],
  // The area switcher below the navigation: the area it shows, by its text. The button opens the list of areas: beside
  // the text that list opens, and the popup's Change area opens it (lists.ts).
  ['#areaSwitcherId', (el, sc) => opens(inMap(sc, el, sc.x!.text.area, { cap: 8, role: 'nav', zone: el }), el)],
  // An item of a list the page is switched with (lists.ts), marked like any other label so the open list shows what can
  // be translated: an area by the id its data-id names (else by its text), a form or a view by its id (loaded on demand)
  // and only where its text is that form's or view's name, never a personal view's (no savedquery: no slot, asked for
  // once). The item takes the click: beside its text it is picked (overlay.ts effect), and the popup's Open switches to
  // it once the list has closed. A form only from the list the page form's own selector opened: Open goes through the
  // page's form API, and a dialog's or a side pane's selector is another form's (its items keep their marks, no Open).
  [
    ITEM,
    (el, sc) => {
      const x = sc.x!;
      const l = el.closest(LIST);
      if (!l) return null;
      const sw = itemSwitch(el);
      const mine = sw?.list !== 'form' || (!!sw.opener && !foreign(x, sw.opener));
      const o: Opt = { role: 'nav', zone: el };
      let a: Anchor | null;
      if (kindOf(l) === 'area') {
        const s = sw ? byName(x, 'ar:' + sw.id) : undefined;
        const t = s ? shown(sc, el, x.labels(s), 8) : null;
        a = s ? A(x, t ? t[0] : el, s, { ...o, hit: el, text: t?.[1] }) : inMap(sc, el, x.text.area, { cap: 8, ...o });
      } else {
        const s = sw ? x.main.get(`${sw.list}|${sw.id}`) : undefined;
        if (sw && !s) sc.want.add((sw.list === 'form' ? WANT_FORM_NAME : WANT_VIEW_NAME) + sw.id);
        a = inSlot(sc, el, s, 8, o);
      }
      if (a && sw && mine) a.sw = sw;
      return a;
    },
  ],
  [
    '[data-id="appBreadCrumb"]',
    (el, sc) => {
      const x = sc.x!;
      const t = x.app && shown(sc, el, x.labels(x.app), 10);
      return x.app ? A(x, t ? t[0] : el, x.app, { hit: el, text: t?.[1] }) : null;
    },
  ],
  [HEADER, (el, sc) => gridHeader(sc, el, attr(el, 'col-id') || attr(el, 'data-item-key'))],
  // The classic read-only grid's header: its column by its header button, its table as a Power Apps grid's (an associated
  // view's once its view is known to read it), and only where it shows that column's name. A header with a col-id is
  // HEADER's.
  [
    CLASSIC_HEADER,
    (el, sc) => {
      const key = attr(el, 'col-id') || attr(el, 'data-item-key') ? '' : classicColumn(el);
      return key ? gridHeader(sc, el, key, true) : null;
    },
  ],
  [
    VIEW_SELECTOR,
    (el, sc) => {
      const x = sc.x!;
      // Never what holds a list of views (its flyout, `ViewSelector_<view id>-flyout`): its items are labels of their own
      // (ITEM), and the first text of the list that reads like the page's view could be any of them.
      if (away(el) || el.querySelector(LISTS)) return null;
      // The button that opens the list of views (lists.ts): it takes the click, beside the text the list opens.
      const b = el.closest(LISTS) ? null : el.closest(OPENER);
      // A list page's own view selector: the page's view (a personal view has none).
      if (x.list && !paneOf(el) && !el.closest(LISTS)) return opens(inSlot(sc, el, x.view, 10), b);
      // Any other (an associated grid's, a sub-grid's, a side pane list's, an item of the list of views): the view its ids
      // and its grid name, loaded on demand. The text must be that view's name: a personal view (no savedquery, its name
      // is the user's own) or any other text is never marked.
      const id = selectorView(el);
      const s = id ? x.main.get(`view|${id}`) : undefined;
      if (id && !s) sc.want.add(WANT_VIEW_NAME + id);
      return opens(inSlot(sc, el, s, 10), b);
    },
  ],
  // The form name: only where the text is the form's (another form's selector in a dialog is not this form). The button
  // opens the list of forms (lists.ts).
  ['[data-id="form-selector"]', (el, sc) => (foreign(sc.x!, el) ? null : opens(inSlot(sc, el, sc.x!.form, 10), el))],
  // Dashboard name (x.form is the dashboard on dashboard pages).
  ['[id*="Dashboard_Selector"]', (el, sc) => (foreign(sc.x!, el) ? null : inSlot(sc, el, sc.x!.form, 10))],
  // The table name in the form header, never inside header fields, the record title or buttons: the page's table, or
  // the table of a side pane's form.
  [
    '[data-id="entity_name_span"],[data-id*="form-header"]',
    (el, sc) => {
      const x = sc.x!;
      const skip = `${FIELD_SEL},[data-id^="header_"],h1,button`;
      if (!paneOf(el)) return foreign(x, el) ? null : inMap(sc, el, x.text.entity, { cap: 40, skip });
      if (away(el)) return null;
      const fid = paneForm(el);
      const e = fid ? x.forms.get(fid)?.entity : '';
      if (fid && e === undefined) sc.want.add(WANT_FORM + fid);
      const s = e ? x.main.get(`entity|${e}`) : undefined;
      if (e && !s) sc.wantTable(e);
      return inSlot(sc, el, s, 40, {}, skip);
    },
  ],
  [
    '[role="listbox"] [role="option"]',
    (el, sc) => {
      const x = sc.x!;
      const lb = el.closest('[role="listbox"]');
      const id = lb?.id && CSS.escape(lb.id);
      const op = (id && document.querySelector(`[aria-controls="${id}"],[aria-owns="${id}"]`)) || document.activeElement;
      const owner = op?.closest('[data-id*=".fieldControl"]');
      const ctl = ctlOf(owner?.getAttribute('data-id'));
      const ci = owner && ctl ? ctlInfo(sc, owner, ctl) : null;
      const list = ci ? x.opts.get(`${ci.entity}.${ci.col}`) : undefined;
      if (ci && !list) sc.wantTable(ci.entity);
      // A multi-select's list says each option's value (`input[value]`): that decides, checked against its text.
      const v = el.querySelector('input[type="checkbox"][value]')?.getAttribute('value');
      const byValue = list && v ? optionByValue(list, v) : undefined;
      const r = list ? find(sc, el, (t) => (byValue ? (x.labels(byValue).has(t) ? byValue : undefined) : optionByText(list, t, x.user, x.base)), 6) : null;
      // Clicking it opens the callout; the option is never selected (the record does not change).
      return r ? A(x, el, r[1], { role: 'option', text: r[2], focus: r[1].key }) : null;
    },
  ],
  // Choice, status, Yes/No and multi-select values in grid rows (lists and sub-grids), of the grid's table or of a
  // linked one. Only choice columns: every other column shows record data.
  [
    CELL,
    (el, sc) => {
      const x = sc.x!;
      const key = attr(el, 'col-id') || attr(el, 'data-item-key') || attr(el, 'data-automation-key');
      let col = colKey(key);
      if (!col && !/^[a-z0-9_]+\.[a-z0-9_]+$/i.test(key)) return null;
      let e = sc.gridTable(el);
      if (!e) return null;
      if (!col) {
        const ln = linkedColumn(key, sc.gridLinks(el));
        if (!ln) return null;
        e = ln.entity;
        col = ln.attr;
      }
      // Most cells are text columns: they are ruled out before anything else is looked at.
      const list = x.opts.get(`${e}.${col}`);
      const a = list ? undefined : x.main.get(`attribute|${e}.${col}`);
      if ((!list && a && !CHOICE_TYPE.test(String(a.ref?.odataType || ''))) || gridAway(x, el)) return null;
      if (!list) {
        sc.wantTable(e); // a choice column (or a table) whose choices aren't loaded yet
        return null;
      }
      const r = find(sc, el, (v) => optionByText(list, v, x.user, x.base), 8, '', true);
      if (r) return A(x, r[0], r[1], { role: 'value', text: r[2], focus: r[1].key });
      // Several values of a multi-select in one text (LIVE-FINDINGS 55): one part each.
      const t = find(sc, el, (v) => MEANT.test(v) || undefined, 8, '', true);
      const ps = t && splitValues(sc.textOf(t[2]), list, (v) => optionByText(list, v, x.user, x.base));
      return ps ? ps.map((p) => A(x, t[0], p.slot, { role: 'value', text: t[2], part: p.part, focus: p.slot.key })) : null;
    },
  ],
  // The value a closed choice control shows (option set, status reason, Yes/No). The whole control takes the
  // click, so it never opens or toggles (Alt+click does).
  [
    VALUE,
    (k, sc) => {
      const x = sc.x!;
      if (k.parentElement?.closest(VALUE)) return null; // a part of the same control: its outermost element is the anchor
      const ctl = ctlOf(attr(k, 'data-id'));
      const cv = ctl ? ctlInfo(sc, k, ctl) : null;
      const list = cv ? x.opts.get(`${cv.entity}.${cv.col}`) : undefined;
      // The table's choices are not loaded (another view read its columns only): asked for once.
      if (cv && !list) sc.wantTable(cv.entity);
      const r = cv && list ? formValue(sc, k, list, cv) : null;
      return r ? A(x, r[0], r[1], { role: 'value', zone: k, text: r[2], focus: r[1].key }) : null;
    },
  ],
  // A multi-select control (LIVE-FINDINGS 54): each selected value is its own option. Its chips (shown as soon as the
  // pointer is over it) and the parts of the text it shows otherwise ("Rouge, Bleu"), tied to their option by the
  // chip's value.
  [
    MULTI,
    (k, sc) => {
      const x = sc.x!;
      const ctl = ctlOf(attr(k, 'data-id'));
      const cv = ctl ? ctlInfo(sc, k, ctl) : null;
      const list = cv ? x.opts.get(`${cv.entity}.${cv.col}`) : undefined;
      if (cv && !list) sc.wantTable(cv.entity);
      if (!cv || !list) return null;
      const out: Array<Anchor | null> = [];
      const vals: Array<{ s: Slot; text: string }> = [];
      const chips = Array.from(k.querySelectorAll('li[data-value]'));
      for (const li of chips) {
        const s = optionByValue(list, li.getAttribute('data-value'));
        const t = shown(sc, li.querySelector('.msos-selected-display-item-text') || li, null, 4, true);
        const text = t ? sc.textOf(t[1]) : '';
        // The chip shows another option's label: the control and its value disagree, so nothing is anchored for it.
        const named = optionByText(list, text, x.user, x.base);
        if (!s || !t || (named && named !== s)) continue;
        // The whole chip takes the click, its ✕ included: a click never removes a value (Alt+click does).
        out.push(A(x, t[0], s, { role: 'value', zone: li, text: t[1], focus: s.key }));
        vals.push({ s, text });
      }
      const vm = k.querySelector('[id$="_viewmodecontainer"]');
      const t = vm && shown(sc, vm, null, 8, true);
      if (t && vals.length && vals.length === chips.length) {
        const ps = valueParts(sc.textOf(t[1]), vals.map((v) => v.text));
        ps?.forEach((p, i) => out.push(A(x, t[0], vals[i].s, { role: 'value', text: t[1], part: p, focus: vals[i].s.key })));
      } else if (t && !chips.length) {
        // No chips to read: the text alone, among the values the form API has when it has them.
        const vs = cv.has && Array.isArray(cv.value) ? new Set(cv.value.map(Number)) : null;
        const sel = vs ? list.filter((s) => vs.has(Number(s.ref?.value))) : list;
        const one = optionByText(sel, sc.textOf(t[1]), x.user, x.base);
        if (one) out.push(A(x, t[0], one, { role: 'value', text: t[1], focus: one.key }));
        else splitValues(sc.textOf(t[1]), sel, (v) => optionByText(sel, v, x.user, x.base))?.forEach((p) => out.push(A(x, t[0], p.slot, { role: 'value', text: t[1], part: p.part, focus: p.slot.key })));
      }
      return out;
    },
  ],
];
const ALL = RULES.map((r) => r[0]).join(',');
/** Hosts whose open shadow roots hold labels: the header strip (overlay.ts observes the same roots). */
const SHADOW = 'uci-header-control-list';

/** The elements matching `sel` in `root`, and in the open shadow roots of the SHADOW hosts in it (or of `root`). */
function deep(root: Document | Element, sel: string): Element[] {
  const out = [...root.querySelectorAll(sel)];
  const hosts = [...root.querySelectorAll(SHADOW)];
  if ('matches' in root && root.matches(SHADOW)) hosts.push(root);
  for (const h of hosts) if (h.shadowRoot) out.push(...h.shadowRoot.querySelectorAll(sel));
  return out;
}

const samePart = (a: Part | undefined, b: Part | undefined): boolean => a === b || (!!a && !!b && a.start === b.start && a.end === b.end && a.text === b.text);
const sameSw = (a: Switch | undefined, b: Switch | undefined): boolean =>
  a === b || (!!a && !!b && a.list === b.list && a.id === b.id && a.opener === b.opener && a.find === b.find && a.item === b.item);
const same = (a: Anchor, b: Anchor): boolean =>
  a.el === b.el &&
  a.key === b.key &&
  a.role === b.role &&
  a.zone === b.zone &&
  a.text === b.text &&
  a.orig === b.orig &&
  samePart(a.part, b.part) &&
  a.focus === b.focus &&
  a.hit === b.hit &&
  sameSw(a.sw, b.sw);
const sameAll = (a: readonly Anchor[], b: readonly Anchor[]): boolean => a.length === b.length && a.every((x, i) => same(x, b[i]));

/** The components of one process: its name, stages and steps (Scanner.forget after the user switched process). */
export const ofProcess =
  (id: string) =>
  (comp: string): boolean =>
    comp === `bpf|${id}` || comp.startsWith(`stage|${id}|`) || comp.startsWith(`step|${id}|`);

/** Keeps the anchors of the page up to date, rescanning only what changed. */
export class Scanner {
  x: PageIndex | null = null;
  /** Text a node had before preview swapped it. */
  textOf: (t: Text) => string = (t) => t.nodeValue || '';
  /**
   * What the page shows but the store lacks, for PageLoader.request(): command bar buttons
   * ('<table>|<control id>'), tables of grids (WANT_TABLE + '<table>'), forms of side panes and quick views
   * (WANT_FORM, WANT_QUICK + form id), grid views' queries (WANT_VIEW + view id), view selectors' views
   * (WANT_VIEW_NAME + view id), the forms of the form selector's list (WANT_FORM_NAME + form id), a table's
   * relationships (WANT_RELATED + table) and the names of a table a navigation entry or a built-in command shows
   * (WANT_NAMES + table).
   */
  readonly want = new Set<string>();
  /** Components anchored since the page opened (they stay in the list when they scroll away). */
  readonly seen = new Set<string>();
  /**
   * A composite column's sub-field seen on the page form (its attribute comp) -> the control id of the composite
   * control's cell (lower case), which is where the sub-field shows: its tab opens to find it (reveal.ts).
   */
  readonly parts = new Map<string, string>();
  /** Whether the last update() changed the set of anchors. */
  changed = false;
  /** Element -> the labels it shows (several: the parts of one text). */
  private map = new Map<Element, Anchor[]>();
  private cache: { list: Anchor[]; by: Map<string, Anchor[]> } | null = null;
  /**
   * Grid root -> its table, for the `data-lp-id` the grid had then: a grid's table never changes while its element lives
   * and names the same grid (a re-render can reuse the element for another related view, which names another table).
   */
  private grids = new WeakMap<Element, { lp: string; table: string }>();
  /** A page sub-grid's root -> its linked tables, read from its query for the view its `data-lp-id` names. */
  private queries = new WeakMap<Element, { lp: string; links: Map<string, Link> }>();

  /** Scans the whole page again (new index); anchors that did not change are kept as they were. */
  full(x: PageIndex): void {
    this.x = x;
    x.stale = formMoved(x);
    const prev = this.map;
    this.map = new Map();
    this.cache = null;
    this.grids = new WeakMap();
    this.queries = new WeakMap();
    for (const k of deep(document, ALL)) this.resolve(k, prev.get(k));
  }

  /** Rescans changed subtrees and returns the anchors found in them; `changed` says whether the set changed. */
  update(roots: Node[], removed: boolean): Anchor[] {
    this.changed = false;
    if (!this.x) return [];
    const was = this.x.stale;
    this.x.stale = formMoved(this.x);
    const keys = new Set<Element>();
    // The form changed under the index: labels still anchored to the old form's cells are dropped now.
    if (this.x.stale && !was) for (const k of this.map.keys()) if (k.isConnected) keys.add(k);
    if (removed)
      for (const [k, as] of this.map)
        if (!k.isConnected) this.drop(k);
        else if (as.some((a) => !a.el.isConnected || (a.text && !a.text.isConnected))) keys.add(k);
    for (const n of roots) {
      const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
      if (!el?.isConnected) continue;
      const up = el.closest(ALL);
      if (up) keys.add(up);
      // A choice control's value changes deep inside it; its outermost element is the one that resolves.
      for (let v = el.closest(VALUE); v; v = v.parentElement?.closest(VALUE) ?? null) if (!v.parentElement?.closest(VALUE)) keys.add(v);
      if (el.firstElementChild || el.shadowRoot) for (const k of deep(el, ALL)) keys.add(k);
    }
    const out: Anchor[] = [];
    for (const k of keys) out.push(...this.resolve(k, this.map.get(k)));
    return out;
  }

  get list(): Anchor[] {
    return this.idx().list;
  }
  of(comp: string): Anchor[] {
    return this.idx().by.get(comp) || [];
  }

  /** Forgets the components seen earlier that `drop` names (a process the user switched away from). */
  forget(drop: (comp: string) => boolean): void {
    for (const c of [...this.seen]) if (drop(c)) this.seen.delete(c);
  }

  /** Forgets everything (the user navigated to another page). */
  reset(): void {
    this.map.clear();
    this.seen.clear();
    this.parts.clear();
    this.want.clear();
    this.cache = null;
    this.grids = new WeakMap();
    this.queries = new WeakMap();
  }

  /**
   * The table a grid element (header or cell) shows: the page table for a list's main grid (unless the grid names
   * another table: the next page's, before the index follows), the sub-grid's
   * table from the form API on a record page, in a side pane (whose sub-grids the page's form API doesn't know, or
   * knows under another table, LIVE-FINDINGS 58) the table its view's query reads (the one the grid names without a
   * view, or once that read failed), and in an associated grid the table it names once its view's query reads that
   * table (relatedTable); '' when unknown (dashboard lists, a quick view's sub-grids, a side pane's or an associated
   * grid until its view's query is read).
   */
  gridTable(el: Element): string {
    const x = this.x;
    if (!x) return '';
    const first = el.closest(GRID_ROOT);
    const lp = el.closest(GRID_LP)?.getAttribute('data-lp-id') || '';
    const known = first && this.grids.get(first);
    if (known && known.lp === lp) return known.table === '-' ? '' : known.table;
    // A sub-grid inside a quick view: its name is the quick view form's, and the page form can have a sub-grid
    // of that name showing another table.
    if (first && inQuickView(x, first)) {
      this.grids.set(first, { lp, table: '-' });
      return '';
    }
    let e = '';
    if (paneOf(el)) {
      // A side pane's grid: the table its view's query reads, as for an associated grid; the table its data-lp-id
      // names without a view id, or once that query's read failed.
      const g = lpGrid(lp);
      const vt = g?.view ? x.viewTables.get(g.view) : undefined;
      if (g?.view && vt === undefined && !x.gaveUp.has(WANT_VIEW + g.view)) {
        this.want.add(WANT_VIEW + g.view);
        return ''; // not cached: asked again once the view's query is in
      }
      e = vt || g?.table || '-';
    } else if (x.record) {
      // An associated grid (a related menu item's view, LIVE-FINDINGS 88): the related table its data-lp-id names, once
      // the grid's own view is known to read that table. The page form's API doesn't know it.
      const g = lpGrid(lp);
      if (g?.control === 'entity_control') {
        const t = relatedTable(g, x.entity, x.viewTables.get(g.view));
        if (t === null) {
          this.want.add(WANT_VIEW + g.view);
          return ''; // not cached: asked again once the view's query is in
        }
        e = t || '-';
      }
    } else if (x.list) {
      // A list's grid names its table (LIVE-FINDINGS 57). One naming another table is the next page's, drawn before the
      // page tracker saw the navigation (mode.ts navSoon): the index is still the previous table's, whose column of the
      // same name it is not.
      const g = lpGrid(lp);
      if (g && g.parent !== x.entity && g.table !== x.entity) e = '-';
    }
    let named = false; // a list's main grid sits in no named control, or in 'entity_control'
    for (let n = first, i = 0; n && i < 6 && !e; n = n.parentElement?.closest(GRID_ROOT) ?? null, i++) {
      const dn = n.getAttribute('data-control-name');
      const g = dn || attr(n, 'data-id').replace(/-[^-]*_control_container$/, '');
      if (g === 'entity_control') e = x.list ? x.entity : '-';
      else if (x.list) named ||= !!dn;
      else if (g) e = tryGet(() => String(x.xrm.Page.getControl(g)?.getEntityName?.() || ''), '').toLowerCase();
    }
    if (!e && x.list && !named) e = x.entity;
    if (e === '-') e = '';
    if (e && first) this.grids.set(first, { lp, table: e });
    return e;
  }

  /**
   * The linked tables of a grid's query by alias (LIVE-FINDINGS 57): a sub-grid of the page form says its current
   * query (getFetchXml, the view the user picked included); any other grid names its view (`data-lp-id`), whose query
   * is read once (asked for). Null while unknown.
   */
  gridLinks(el: Element): ReadonlyMap<string, Link> | null {
    const x = this.x;
    if (!x) return null;
    const root = el.closest(GRID_LP);
    const lp = root?.getAttribute('data-lp-id') || '';
    const g = lpGrid(lp);
    if (!root || !g) return null;
    if (x.record && !paneOf(el) && g.control !== 'entity_control') {
      // Read once per grid and view (every linked cell of every row asks).
      const had = this.queries.get(root);
      if (had?.lp === lp) return had.links;
      const fx = tryGet(() => {
        const c = x.xrm.Page.getControl(g.control);
        return String(c?.getEntityName?.() || '').toLowerCase() === g.table ? String(c.getFetchXml?.() || '') : '';
      }, '');
      if (fx) {
        const links = queryLinks(fx);
        this.queries.set(root, { lp, links });
        return links;
      }
    }
    if (!g.view) return null;
    const q = x.queries.get(g.view);
    if (!q) this.want.add(WANT_VIEW + g.view);
    return q ?? null;
  }

  /** Asks the loader for a grid table's columns and choices. */
  wantTable(entity: string): void {
    if (entity) this.want.add(WANT_TABLE + entity);
  }

  private drop(k: Element): void {
    this.map.delete(k);
    this.cache = null;
    this.changed = true;
  }

  private resolve(k: Element, old: Anchor[] | undefined): Anchor[] {
    let got: Anchor[] = [];
    for (const [sel, fn] of RULES) {
      if (!k.matches(sel)) continue;
      const r = fn(k, this);
      got = (Array.isArray(r) ? r : [r]).filter((a): a is Anchor => !!a);
      if (got.length) break;
    }
    if (old && sameAll(old, got)) got = old;
    if (!got.length) {
      if (this.map.has(k)) this.drop(k);
      return got;
    }
    if (got !== this.map.get(k)) {
      this.map.set(k, got);
      this.cache = null;
      this.changed = true;
    }
    for (const a of got) this.seen.add(a.comp);
    return got;
  }

  /** Anchors in page order, one per element or part of a text (several rules can find the same label). */
  private idx(): { list: Anchor[]; by: Map<string, Anchor[]> } {
    if (!this.cache) {
      const list: Anchor[] = [];
      const by = new Map<string, Anchor[]>();
      const els = new Map<Element, Set<number>>();
      for (const as of this.map.values())
        for (const a of as) {
          const at = a.part ? a.part.start : -1;
          const s = els.get(a.el);
          if (s?.has(at)) continue;
          if (s) s.add(at);
          else els.set(a.el, new Set([at]));
          list.push(a);
        }
      // Incremental scans append; the list shows on-page labels in page order (the parts of a text in text order).
      list.sort((a, b) => (a.el === b.el ? (a.part?.start ?? -1) - (b.part?.start ?? -1) : (a.el.compareDocumentPosition(b.el) & 2) - 1));
      for (const a of list) {
        const b = by.get(a.comp);
        if (b) b.push(a);
        else by.set(a.comp, [a]);
      }
      this.cache = { list, by };
    }
    return this.cache;
  }
}

// ---- what the page shows (the check after a refresh, ui/app.ts) ----

/** A published text, as stored before the refresh (ui/refresh.ts VerifyItem). */
export interface ShownItem {
  kind: Kind;
  key: string;
  lcid: Lcid;
  text: string;
}

/** A field label the page renders: its text, its tooltip (the title "<label> - <description>", LIVE-FINDINGS 43) and where it is. */
export interface ShownField {
  ctl: string;
  text: string;
  tip: string;
  place: Place;
}

/**
 * What the page renders, read from the DOM only, never from the form API: a cold boot leaves its controls and
 * tabs empty (LIVE-FINDINGS 51). [] / undefined: not rendered (a tab not visited yet, tabs in "More tabs").
 */
export interface Shown {
  /** Rendered labels of these controls (field containers of the page form). */
  fields(ctls: readonly string[]): ShownField[];
  /** A tab's title. */
  tab(name: string): string | undefined;
  /** A section's title. */
  section(name: string): string | undefined;
}

const quoted = (v: string): string => v.replace(/["\\]/g, '\\$&');

/** The page's DOM as Shown (the selectors were observed live). */
export function domShown(root: Pick<Document, 'querySelectorAll'> = document): Shown {
  const all = (sel: string) => Array.from(root.querySelectorAll(sel));
  return {
    fields(ctls) {
      const out: ShownField[] = [];
      for (const ctl of new Set(ctls.flatMap((c) => [c, c.toLowerCase()]))) {
        if (!/^\w+$/.test(ctl)) continue;
        for (const c of all(`[data-id="${ctl}${FIELD}"]`)) {
          if (otherForm(c, ctl)) continue;
          const lab = Array.from(c.querySelectorAll('label[id$="field-label"]')).find((l) => l.id === `${ctl}-field-label` || l.id.endsWith(`-${ctl}-field-label`));
          if (lab) out.push({ ctl, text: lab.textContent || '', tip: lab.parentElement?.getAttribute('title') || '', place: placeOf(c) });
        }
      }
      return out;
    },
    tab(name) {
      // Its title, never its text: the tab renders it twice (a hidden sizing copy).
      const el = all(`li[role="tab"][data-id="tablist-${quoted(name)}"]`)[0];
      return el ? el.getAttribute('title') || el.getAttribute('aria-label') || '' : undefined;
    },
    section(name) {
      const el = all(`[data-id="form-sectionHeader-${quoted(name)}"]`)[0];
      return el ? el.getAttribute('title') || el.textContent || '' : undefined;
    },
  };
}

/** The page form, for pageShows. */
export interface ShownForm {
  /** The user's language: the only one the page shows. */
  user: Lcid;
  /** The record form on the page ('' when unknown: then nothing form-scoped is read from the page). */
  formId: string;
  get(key: string): Slot | undefined;
  /** That form's field cells (their control ids name the page's controls). */
  cells: readonly Slot[];
}

const words = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();

/**
 * The labels the page renders for a form cell: its control, or a numbered copy of it (copies sharing one control
 * id, LIVE-FINDINGS 41; a number another cell's control has is never one), wherever the page places the cell.
 */
function cellShown(f: ShownForm, cell: Slot, shown: Shown): ShownField[] {
  const id = String(cell.ref?.controlId || '');
  if (!id) return [];
  const ids = f.cells.map((c) => String(c.ref?.controlId || '').toLowerCase());
  const names = [id];
  if (ids.filter((c) => c === id.toLowerCase()).length > 1) for (let n = 1; n < 20; n++) if (!ids.includes(`${id}${n}`.toLowerCase())) names.push(id + n);
  return shown.fields(names).filter((x) => isAt(cell, x.place));
}

/**
 * Whether the page shows a published text: a form field label, a column's tooltip on its fields, a tab or a
 * section title of the page form. Undefined when the page can't tell: another language than the user's (the page
 * shows only that one), a removed text (the column's name or the base text shows instead), another form, not
 * rendered, a label hidden on the form, any other kind.
 */
export function pageShows(it: ShownItem, f: ShownForm, shown: Shown): boolean | undefined {
  const want = words(it.text);
  const s = f.get(it.key);
  if (it.lcid !== f.user || !want || !s || !f.formId) return undefined;
  const r = s.ref || {};
  const mine = guid(String(r.formId || '')) === f.formId;
  // Some texts show (an empty label: hidden on the form, nothing to compare): one showing it is enough.
  const any = (texts: string[], ok: (t: string) => boolean): boolean | undefined => {
    const seen = texts.map(words).filter(Boolean);
    return seen.length ? seen.some(ok) : undefined;
  };
  // A required field's label can end with its asterisk.
  const is = (t: string) => t === want || t.replace(/\s*\*$/, '') === want;
  if (s.kind === 'tab' || s.kind === 'section') {
    const name = String((s.kind === 'tab' ? r.tabName : r.sectionName) || '');
    if (!mine || !name) return undefined;
    return any([(s.kind === 'tab' ? shown.tab(name) : shown.section(name)) ?? ''], is);
  }
  if (s.kind === 'field') return mine ? any(cellShown(f, s, shown).map((x) => x.text), is) : undefined;
  if (s.kind === 'attribute' && s.prop === 'Description') {
    const cells = f.cells.filter((c) => c.kind === 'field' && sameName(c.ref?.datafield, String(r.attribute || '')) && sameName(c.entity, String(r.entity || s.entity || '')));
    return any(
      cells.flatMap((c) => cellShown(f, c, shown)).map((x) => x.tip),
      (t) => t === want || t.endsWith(` - ${want}`),
    );
  }
  return undefined;
}

/**
 * Splits published texts into those the page shows and those it doesn't: what the page renders decides wherever
 * it can tell (`shows`, pageShows), the freshly loaded server text elsewhere (`value`; undefined = not loaded
 * here, not checked).
 */
export function checkShown<T extends ShownItem>(
  items: readonly T[],
  value: (key: string, lcid: Lcid) => string | undefined,
  shows: (it: T) => boolean | undefined,
): { showing: T[]; missing: T[] } {
  const showing: T[] = [];
  const missing: T[] = [];
  for (const it of items) {
    let ok = shows(it);
    if (ok === undefined) {
      const v = value(it.key, it.lcid);
      if (v === undefined) continue;
      ok = v === it.text;
    }
    (ok ? showing : missing).push(it);
  }
  return { showing, missing };
}
