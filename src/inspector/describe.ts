// Popup content per component (ARCHITECTURE §5.4, Popup): a kind word, the title, and the texts that can
// be translated from the clicked label (one block per text, shown in every shown language by the popup), the
// choices of a choice column and the other copies of a field placed more than once. Nothing else: no "where",
// no scope sentences, no help texts, no "More texts". Pure: reads app.store, app.ctx and app.prefs. The anchor's
// element is only read, never changed: to tell which classic button was clicked, whether a tab is the one shown,
// whether a label is in a menu, whether a stage's flyout is open and whether an item of a selector's list is the
// current one.

import { isManaged, namesFirst, PROP_NAMES, type Kind, type Prop, type Slot } from '../core/model';
import type { RibbonControl } from '../providers/types';
import type { IconName } from '../ui/dom';
import { langName, notLoaded, shownLangs } from '../ui/editor';
import type { AppApi } from '../ui/types';
import { columnOf } from './column';
import { navSource } from './fallback';
import { isBuiltin } from './scan';
import { mainSlot, textOf } from './status';
import type { Action, Anchor, Block, CalloutModel, DescribeFn, ListKind } from './types';

/** The kind word of the popup header (the per-kind code refines some: sub-grid, button group, navigation entry). */
const KIND_LABEL: Record<Kind, string> = {
  entity: 'Table',
  attribute: 'Column',
  relationship: 'Menu item',
  option: 'Choice',
  globaloptionset: 'Choice',
  globaloption: 'Choice',
  boolean: 'Choice',
  state: 'Choice',
  status: 'Choice',
  view: 'View',
  chart: 'Chart',
  form: 'Form',
  tab: 'Tab',
  section: 'Section',
  field: 'Field',
  navitem: 'Menu item',
  dashboard: 'Dashboard',
  dtab: 'Tab',
  dsection: 'Section',
  dfield: 'Component',
  app: 'App',
  area: 'Menu area',
  group: 'Menu group',
  subarea: 'Menu item',
  bpf: 'Process',
  stage: 'Stage',
  step: 'Step',
  ribbon: 'Button',
  command: 'Button',
  envvar: 'Environment variable',
  customapi: 'Custom API',
};

/** The editor's kind icons (widgets.ts kindIcon), kept here so this module stays free of widget code. */
const ICONS: Record<Kind, IconName> = {
  entity: 'entity',
  attribute: 'field',
  relationship: 'link',
  option: 'choice',
  globaloptionset: 'choice',
  globaloption: 'choice',
  boolean: 'choice',
  state: 'choice',
  status: 'choice',
  view: 'view',
  chart: 'chart',
  form: 'form',
  tab: 'form',
  section: 'form',
  field: 'field',
  navitem: 'nav',
  dashboard: 'dash',
  dtab: 'dash',
  dsection: 'dash',
  dfield: 'dash',
  app: 'app',
  area: 'nav',
  group: 'nav',
  subarea: 'nav',
  bpf: 'flow',
  stage: 'flow',
  step: 'flow',
  ribbon: 'command',
  command: 'command',
  envvar: 'bolt',
  customapi: 'bolt',
};

/** Multi-line inputs (descriptions and tooltips: the editor's LONG set). */
const LONG = new Set<Prop>(['Description', 'ToolTipDescription', 'Hint']);
/** Choice kinds of one column (global choices are matched through `ref.usedBy`). */
const OPTS = new Set<Kind>(['option', 'status', 'state', 'boolean']);
/** Form cell controls whose kind can be named by their `ref.classid` (the control's classid in the form XML). */
const CLASSES: Record<string, string> = {
  'e7a81278-8635-4d9e-8d4d-59480b391c5b': 'Sub-grid',
  '5c5600e0-1d6e-4205-a272-be80da87fd42': 'Quick view',
  '06375649-c143-495e-a496-c962e5b4488e': 'Timeline',
};

const byOrder = (a: Slot, b: Slot): number => a.order - b.order || a.key.localeCompare(b.key);

// ---- blocks ----

function mk(s: Slot | undefined, heading: string, long?: boolean): Block[] {
  return s ? [{ key: s.key, heading, long: long ?? LONG.has(s.prop) }] : [];
}

/** Text compared loosely (spaces and case), for "the same label". */
const loose = (v: string): string => v.replace(/\s+/g, ' ').trim().toLowerCase();

/** The column name slot of a column's form cell (what the cell shows where it has no label, LIVE-FINDINGS 42). */
const nameSlot = (app: AppApi, s: Slot): Slot | undefined => {
  const c = columnOf(s);
  return c ? app.store.get(`attribute|${c.entity}.${c.attr}|DisplayName`) : undefined;
};

/**
 * The base-language text a form cell shows: its own label, else the column's name (LIVE-FINDINGS 42); null
 * when that can't be known (the base language was not read).
 */
function cellBase(app: AppApi, s: Slot): string | null {
  const b = app.ctx.base;
  if (notLoaded(s, b)) return null;
  const own = app.store.value(s.key, b);
  if (own.trim()) return loose(own);
  const dn = nameSlot(app, s);
  return dn ? loose(app.store.value(dn.key, b)) : null;
}

/** What a form cell shows in language `l`: its own text, else the column's name in that language. */
function cellText(app: AppApi, s: Slot, l: number): string {
  const own = app.store.value(s.key, l);
  if (own.trim()) return own;
  const dn = nameSlot(app, s);
  return dn && !notLoaded(dn, l) ? app.store.value(dn.key, l) : '';
}

/**
 * The other copies of a field placed more than once on the same form: the cells of that form that show the same
 * column with the same base-language wording. A copy worded differently (the same column placed as "Client" and
 * as "Billing client") is a different label and is never changed from here. The checkbox starts ticked when every
 * copy shows the same text as this cell in every shown language (a cell without a label of its own shows the
 * column's name, LIVE-FINDINGS 42), unticked otherwise.
 */
function duplicates(app: AppApi, m: Slot): Block['also'] {
  const { store } = app;
  const r = m.ref || {};
  const col = columnOf(m);
  const t = app.prefs.target;
  if (!col || !r.formId) return undefined;
  const mb = cellBase(app, m);
  const others: Slot[] = [];
  for (const s of store.slots.values()) {
    if (s.kind !== m.kind || s.prop !== 'Label' || s.key === m.key || s.ref?.formId !== r.formId || s.readOnly || isManaged(s) || notLoaded(s, t)) continue;
    if (columnOf(s)?.attr !== col.attr) continue;
    const sb = cellBase(app, s);
    if (mb !== null && sb !== null && sb !== mb) continue;
    others.push(s);
  }
  if (!others.length) return undefined;
  others.sort(byOrder);
  const langs = shownLangs(app);
  const on = others.every((s) => langs.every((l) => notLoaded(s, l) || notLoaded(m, l) || cellText(app, s, l) === cellText(app, m, l)));
  return { keys: others.map((s) => s.key), on };
}

/** The columns sharing a global choice (`ref.usedBy`: 'entity.attr'), as far as the loaded metadata tells. */
const sharedBy = (s: Slot): number => (Array.isArray(s.ref?.usedBy) ? s.ref.usedBy.length : 0);

/** The choices of a column (option labels in option order), for a field, a step or a column header. */
function choicesOf(app: AppApi, entity: string, attr: string, focus?: string): CalloutModel['choices'] {
  const col = `${entity}.${attr}`.toLowerCase();
  const local: Slot[] = [];
  const glob: Slot[] = [];
  for (const s of app.store.slots.values()) {
    if (s.prop !== 'Label') continue;
    const r = s.ref || {};
    if (OPTS.has(s.kind)) {
      if (`${r.entity}.${r.attribute}`.toLowerCase() === col) local.push(s);
    } else if (s.kind === 'globaloption' && Array.isArray(r.usedBy) && r.usedBy.some((u: string) => String(u).toLowerCase() === col)) glob.push(s);
  }
  const list = (local.length ? local : glob).sort(byOrder);
  if (!list.length) return undefined;
  const keys = list.map((s) => s.key);
  const f = focus && keys.includes(focus) ? focus : undefined;
  return { keys, open: !!f, ...(f ? { focus: f } : {}), ...(local.length ? {} : { shared: sharedBy(list[0]) }) };
}

/** Every option of an option's column (or of its global set), the option itself included, in option order. */
function siblings(app: AppApi, m: Slot): Slot[] {
  const r = m.ref || {};
  const out: Slot[] = [];
  for (const s of app.store.slots.values())
    if (s.kind === m.kind && s.prop === 'Label' && (m.kind === 'globaloption' ? s.ref?.name === r.name : s.ref?.entity === r.entity && s.ref?.attribute === r.attribute)) out.push(s);
  return out.sort(byOrder);
}

// ---- classic buttons: their tooltip LocLabels ----

type Controls = Map<string, Map<string, RibbonControl>>;
const ribbons = new WeakMap<AppApi, Controls>();

/**
 * Gives describe() the composed classic ribbon controls per table (the page loader's `ribbon` map, which it keeps
 * filling), so a classic button's popup also offers its tooltip LocLabels. Call once when translation mode starts.
 */
export function useRibbonControls(app: AppApi, controls: Controls): void {
  ribbons.set(app, controls);
}

const token = (v: string | undefined): string | undefined => /^\$LocLabels:(.+)$/.exec(v || '')?.[1];

/** The command bar button id of an anchor ('<table>|…|<control>'), read from the page. */
function buttonId(a: Anchor | undefined): string {
  for (const el of [a?.zone, a?.el])
    try {
      const d = (el as Element | undefined)?.closest?.('[data-id*="|"]')?.getAttribute('data-id');
      if (d) return d;
    } catch {
      /* not an element (tests) */
    }
  return '';
}

/**
 * Where else a classic LocLabel shows, said before it is saved (one save changes it everywhere): every table's command
 * bar for an application ribbon label; for a table's label, the other buttons of that table whose label, tooltip or
 * accessibility text names it ('' when none, or the buttons aren't known yet).
 */
function sharedNote(app: AppApi, s: Slot | undefined, a: Anchor | undefined): string {
  const r = s?.ref;
  if (!r?.locLabelId) return '';
  if (r.entity === '_app') return "every table's command bar";
  const cs = ribbons.get(app)?.get(r.entity);
  if (!cs) return '';
  const self = buttonId(a).split('|').pop()?.replace(/-(Large|Medium|Small)$/, '') || '';
  const users = new Set<string>();
  for (const c of cs.values()) if ([c.labelText, c.toolTipTitle, c.toolTipDescription, c.alt].some((v) => token(v) === r.locLabelId)) users.add(c.id);
  const others = [...users].filter((id) => id !== self).length;
  if (self && users.has(self)) return others ? `also on ${others} other button${others === 1 ? '' : 's'}` : '';
  return users.size > 1 ? `on ${users.size} buttons` : '';
}

/** Tooltip title / text LocLabels of the classic button whose label is `m`, when they can be known. */
function ribbonTips(app: AppApi, m: Slot, a: Anchor | undefined): { tip?: Slot; desc?: Slot } {
  const { store } = app;
  const r = m.ref || {};
  const id: string = r.locLabelId || '';
  const seg = buttonId(a).split('|');
  // A LocLabel is looked up as the scanner looks up the label: the button's table first, then the application ribbon.
  const scopes = [...new Set([seg.length >= 4 ? seg[0] : '', r.entity, '_app'].filter(Boolean))];
  const find = (lid: string | undefined): Slot | undefined => {
    if (!lid || lid === id) return undefined;
    for (const e of scopes) {
      const s = store.get(`ribbon|${e}|${lid}|Label`);
      if (s) return s;
    }
    return undefined;
  };
  const map = ribbons.get(app);
  let ctl: RibbonControl | undefined;
  if (map) {
    if (seg.length >= 4) {
      const c = map.get(seg[0])?.get(seg[seg.length - 1].replace(/-(Large|Medium|Small)$/, ''));
      if (c && token(c.labelText) === id) ctl = c;
    }
    if (!ctl) {
      // Opened from the list: the controls showing this label, if they all have the same tooltips.
      const cands: RibbonControl[] = [];
      for (const [e, cs] of map) if (r.entity === '_app' || e === r.entity) for (const c of cs.values()) if (token(c.labelText) === id) cands.push(c);
      const sig = (c: RibbonControl) => [c.toolTipTitle, c.toolTipDescription].join('\n');
      if (cands.length && cands.every((c) => sig(c) === sig(cands[0]))) ctl = cands[0];
    }
  }
  if (ctl) return { tip: find(token(ctl.toolTipTitle)), desc: find(token(ctl.toolTipDescription)) };
  // Without the control: the Ribbon Workbench naming (<button>.LabelText → <button>.ToolTipTitle…), only when those exist.
  const base = /^(.*)\.LabelText$/.exec(id)?.[1];
  return base ? { tip: find(`${base}.ToolTipTitle`), desc: find(`${base}.ToolTipDescription`) } : {};
}

// ---- the secondary action ----

/** An attribute of a label's element ('' when it can't be read: not an element, in tests). */
const attrOf = (el: Element, name: string): string => {
  try {
    return el.getAttribute(name) || '';
  } catch {
    return '';
  }
};

/** The whole text node a label shows (all of it, also where the label is a part of it), spaces collapsed. */
const pageText = (a: Anchor): string => (a.text?.nodeValue || a.el.textContent || '').replace(/\s+/g, ' ').trim();

/** Menus and flyouts: they close as soon as the popup takes the focus or a click, and the labels in them go with them. */
export const TRANSIENT = '[role="menu"],[role="menuitem"],[role="menuitemradio"],[role="dialog"],[data-id="headerFieldsFlyout"],[data-lp-id="sitemap-area-switcher-flyout"]';

/** The label is in a menu or flyout (TRANSIENT). */
export function inTransient(el: Element): boolean {
  try {
    return !!el.closest(TRANSIENT);
  } catch {
    return false;
  }
}

/**
 * The nav id of a related menu item (`data-id="form-tab-relatedEntity-<nav id>"`, LIVE-FINDINGS 63), or of the tab of
 * the view one opened (`tablist-<nav id>`, also as a "More tabs" item); '' for any other element. Nav ids start with
 * "nav" (navConnections, nav_<relationship>): a form tab's name is never read as one.
 */
export const navIdOf = (el: Element): string => /^(?:form-tab-relatedEntity-|tablist-(?=nav))(.+)$/i.exec(attrOf(el, 'data-id'))?.[1] ?? '';

/** The action of a selector's own label (lists.ts): its list. */
const CHANGE: Record<ListKind, Action> = { area: 'Change area', form: 'Change form', view: 'Change view' };

/**
 * The action a label of the lists the page is switched with gets (lists.ts), in place of its kind's: on a selector's
 * own button, Change area / form / view (its list); on an item of its list, Open, unless it is the current one
 * (aria-checked) or its id is unknown. Never for the same name shown elsewhere (no `sw`): undefined, the kind's stays.
 */
export function listAction(a: Anchor): Action | null | undefined {
  const sw = a.sw;
  if (!sw) return undefined;
  if (!sw.id) return CHANGE[sw.list];
  return attrOf(a.zone ?? a.el, 'aria-checked') === 'true' ? null : 'Open';
}

/**
 * The secondary action of the clicked label, only where pressing it does something (mode.ts runAction): a tab gets
 * Show tab unless it is the one shown. Open is dropped for the tab of a related view that is shown, and for a label in
 * a menu or flyout, which closes as soon as the popup is used, unless it opens a related view (the navigation API
 * needs no element) or switches to an item of a selector's list (its area, form or view, captured with it: lists.ts).
 */
export function actionFor(action: Action | undefined, a: Anchor): Action | undefined {
  const shown = attrOf(a.el, 'aria-selected') === 'true';
  if (a.role === 'tab') return shown ? undefined : 'Show tab';
  if (action !== 'Open' || a.sw?.id) return action;
  const id = navIdOf(a.el);
  return (id && shown) || (!id && inTransient(a.zone ?? a.el)) ? undefined : action;
}

/**
 * Whether a process stage has steps, the fields its flyout shows (a click on a stage without steps opens an empty
 * flyout). A step the loaded definition doesn't place in a stage (read from the xaml only) counts for every stage.
 */
export function hasSteps(slots: Iterable<Slot>, stage: Slot): boolean {
  const r = stage.ref || {};
  for (const s of slots) if (s.kind === 'step' && s.ref?.workflowId === r.workflowId && (!s.ref?.stageId || s.ref.stageId === r.labelId)) return true;
  return false;
}

// ---- per kind ----

function fill(app: AppApi, md: CalloutModel, m: Slot, a: Anchor | undefined): void {
  const { store } = app;
  const r = m.ref || {};
  const own = (p: Prop) => store.get(`${m.comp}|${p}`);
  const nav = a?.role === 'nav';
  switch (m.kind) {
    case 'field':
    case 'dfield':
      return field(app, md, m, a);

    case 'tab':
    case 'dtab':
    case 'section':
    case 'dsection':
      md.blocks = mk(m, 'Label');
      return;

    case 'navitem':
    case 'relationship':
      md.blocks = mk(m, 'Label');
      if (m.kind === 'navitem') menuItem(app, md, m, a);
      if (nav) md.action = 'Open';
      return;

    case 'option':
    case 'status':
    case 'state':
    case 'boolean':
    case 'globaloption': {
      // A choice value: the title is the option, and every option of its column is in "Choices", open, the clicked
      // one focused and highlighted. Its label is that row, never a second input above the list.
      const all = siblings(app, m);
      md.choices = { keys: all.map((s) => s.key), open: true, focus: m.key, ...(m.kind === 'globaloption' ? { shared: sharedBy(m) } : {}) };
      return;
    }

    case 'globaloptionset': {
      md.blocks = mk(own('DisplayName'), 'Name');
      const opts = [...store.slots.values()].filter((s) => s.kind === 'globaloption' && s.prop === 'Label' && s.ref?.name === r.name).sort(byOrder);
      if (opts.length) md.choices = { keys: opts.map((s) => s.key), open: false, shared: sharedBy(opts[0]) };
      return;
    }

    case 'attribute': {
      // A column (header in a view or sub-grid): its name and tooltip, and its choices.
      md.blocks = [...mk(own('DisplayName'), 'Column name'), ...mk(own('Description'), 'Tooltip')];
      const ch = choicesOf(app, r.entity || m.entity, r.attribute, a?.focus);
      if (ch) md.choices = ch;
      return;
    }

    case 'entity': {
      const dc = own('DisplayCollectionName');
      if (nav && dc && a?.key === dc.key) {
        // A navigation entry without titles of its own shows the table's plural name.
        md.kind = 'Menu item';
        md.blocks = mk(dc, 'Plural name');
        md.action = 'Open';
        return;
      }
      const dn = own('DisplayName');
      md.blocks = [...mk(dn, 'Name'), ...mk(dc, 'Plural name')];
      if (a?.role === 'command') {
        // A built-in command whose text holds the table's name (scan.ts command): the button as the page shows it, and
        // why the table's names are what to translate there. Names that are read-only (a managed solution's table, most
        // of them) are never said to be translated here: the lock line says why not.
        md.kind = 'Button';
        md.icon = 'command';
        md.title = pageText(a) || md.title;
        md.note = [dn, dc].some((s) => s && !s.readOnly) ? TABLE_COMMAND_NOTE : TABLE_COMMAND_WHY;
      }
      return;
    }

    case 'view':
    case 'chart':
    case 'form':
    case 'dashboard':
    case 'app':
    case 'bpf':
      md.blocks = mk(own('Name'), 'Name');
      return;

    case 'area':
    case 'group':
    case 'subarea': {
      const t = own('Title');
      md.blocks = mk(t, 'Title');
      if (nav && m.kind !== 'group') md.action = 'Open';
      // The app designer's placeholder ("New Group"): until it has a name, the title is what the page shows, and the
      // popup says what naming it does.
      if (t && namesFirst(t) && !t.readOnly && !Object.values(t.labels).some((v) => v.trim())) {
        md.note = unnamedNote(m.kind, langName(app, app.ctx.base));
        // Never a staged name the preview swapped in.
        const page = a && a.comp === m.comp ? (a.orig || '').replace(/\s+/g, ' ').trim() || pageText(a) : '';
        if (page) md.title = md.blocks[0].pageText = page;
      }
      return;
    }

    case 'stage':
      md.blocks = mk(m, 'Label');
      // Only where the click opens a flyout with something in it. Its flyout open already is checked when it is pressed
      // (mode.ts runAction): the popup can stay open while the flyout opens or closes.
      if (a?.role === 'stage' && hasSteps(store.slots.values(), m)) md.action = 'Show stage';
      return;

    case 'step': {
      // A process step shows a column: its label, the column's tooltip, and its choices (a choice column).
      const c = columnOf(m);
      md.blocks = [...mk(m, 'Label'), ...(c ? mk(store.get(`attribute|${c.entity}.${c.attr}|Description`), 'Tooltip') : [])];
      const ch = c && choicesOf(app, c.entity, c.attr, a?.focus);
      if (ch) md.choices = ch;
      return;
    }

    case 'command': {
      if (!own('Label')) {
        md.kind = 'Button group';
        md.blocks = mk(own('Title'), 'Label');
        return;
      }
      md.blocks = [...mk(own('Label'), 'Label'), ...mk(own('ToolTipTitle'), 'Tooltip title'), ...mk(own('ToolTipDescription'), 'Tooltip text')];
      return;
    }

    case 'ribbon': {
      const t = ribbonTips(app, m, a);
      md.blocks = [...mk(m, 'Label'), ...mk(t.tip, 'Tooltip title'), ...mk(t.desc, 'Tooltip text', true)].map((b) => {
        const note = sharedNote(app, app.store.get(b.key), a);
        return note ? { ...b, note } : b;
      });
      return;
    }

    case 'envvar':
    case 'customapi':
      md.blocks = [...mk(own('DisplayName'), 'Name'), ...mk(own('Description'), 'Description'), ...mk(own('Hint'), 'Hint')];
      return;
  }
}

/**
 * The column's name where the page shows it as a form cell's label (LIVE-FINDINGS 42: Dynamics shows the column's
 * name in a language the cell has no label in); '' when the cell's own text shows, or it isn't a column's cell.
 * The popup's title and the Publish dialog's row headers (ui/review.ts).
 */
export function cellTitle(app: AppApi, m: Slot): string {
  const c = m.kind === 'field' ? columnOf(m) : null;
  const dn = c && app.store.get(`attribute|${c.entity}.${c.attr}|DisplayName`);
  if (!c || !dn) return '';
  const user = app.ctx.user;
  const userCol = notLoaded(dn, user) ? '' : (dn.labels[user] || '').trim();
  if (!(m.labels[user] || '').trim() && userCol) return userCol;
  const own = Object.keys(m.labels).some((l) => !!m.labels[Number(l)]) || !!m.ref?.partial;
  return own ? '' : textOf(app, dn) || c.attr;
}

/** The muted scope notes of a related menu item's blocks (LIVE-FINDINGS 80). */
export const NAV_NOTES = {
  label: 'this form only',
  menu: 'every form without its own title',
  plural: 'everywhere',
};

/**
 * A related menu item of the form XML: its title on this form, then the relationship's text it shows in a language
 * it has no title in (LIVE-FINDINGS 80), the relationship's menu label (UseLabel) or the listed table's plural name
 * (UseCollectionName), so that text can be fixed where it comes from. The popup's title is what the page shows: in
 * the user's language without a title of its own, the clicked label's own text, which that language's placeholder
 * shows too (`pageText`); without one (opened from the list), the relationship's text in that language.
 */
function menuItem(app: AppApi, md: CalloutModel, m: Slot, a: Anchor | undefined): void {
  const user = app.ctx.user;
  const src = navSource((k) => app.store.get(k), m);
  const [label] = md.blocks;
  const own = !!(m.labels[user] || '').trim();
  if (src) {
    const menu = src.kind === 'relationship';
    label.note = NAV_NOTES.label;
    md.blocks.push({ key: src.key, heading: menu ? 'Menu label' : 'Table plural name', long: false, note: menu ? NAV_NOTES.menu : NAV_NOTES.plural });
  }
  if (own) return;
  // The page's own text, never a staged one the preview swapped in (it puts the page's back when the edit is cleared).
  // In the user's language it wins over the relationship's text: the same item showed its menu label on one load and
  // the listed table's plural name on a later one (LIVE-FINDINGS 80).
  const page = a && a.key === m.key ? (a.orig || a.text?.nodeValue || a.el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  const t = page || (src ? (src.labels[user] || '').trim() : '');
  if (t) md.title = t;
  if (page) label.pageText = page;
}

/**
 * The muted scope notes of a field popup's blocks: one clause each, after the heading. Together they say what a form
 * label is: the text one form shows instead of the column's name, which shows everywhere else. An empty form label's
 * input says what shows in its place (its placeholder, ui/callout.ts placeholderOf).
 */
export const FIELD_NOTES = {
  // The form's own label: shown on this form in place of the column's name (LIVE-FINDINGS 42).
  label: 'this form only, shown instead of the column name',
  // A quick view form's cell label shows on every main form that embeds that quick view.
  quickView: 'this quick view (on every form that shows it), instead of the column name',
  tooltip: 'everywhere',
  column: 'everywhere: views, search and forms without a form label',
};
/** systemform type of a quick view form. */
const QUICK_VIEW = 6;

/**
 * A form cell. A column's cell: the form's own label (with the other copies of the field), its tooltip, then its column
 * name, always in that order (the popup focuses the form's label, what the page shows; ui/callout.ts focusKeys), and its
 * choices.
 */
function field(app: AppApi, md: CalloutModel, m: Slot, a: Anchor | undefined): void {
  const { store } = app;
  const r = m.ref || {};
  const c = m.kind === 'field' ? columnOf(m) : null;
  if (!c) {
    // Sub-grid, quick view, web resource, iframe, timeline, custom control or dashboard component: only its title.
    md.kind = CLASSES[String(r.classid || '').replace(/[{}]/g, '').toLowerCase()] || 'Component';
    md.blocks = mk(m, 'Label');
    return;
  }
  const de = store.get(`attribute|${c.entity}.${c.attr}|Description`);
  // The title is what the page shows. (What users of a language see while its label is empty is the placeholder
  // of its input in the popup.)
  const t = cellTitle(app, m);
  if (t) md.title = t;
  // Where each text applies, in a few words (by design: a field label is per form, the column's texts are not).
  // The column's own name: what views, search and every form without a label of its own for this field show.
  const name = mk(store.get(`attribute|${c.entity}.${c.attr}|DisplayName`), 'Column name').map((b) => ({ ...b, note: FIELD_NOTES.column }));
  const tip = mk(de, 'Tooltip').map((b) => ({ ...b, note: FIELD_NOTES.tooltip }));
  // The form's own label, which this form shows instead of the column's name.
  const [label] = mk(m, 'Form label');
  const also = duplicates(app, m);
  if (also) label.also = also;
  label.note = Number(r.formType) === QUICK_VIEW ? FIELD_NOTES.quickView : FIELD_NOTES.label;
  md.blocks = [label, ...tip, ...name];
  const ch = choicesOf(app, c.entity, c.attr, a?.focus);
  if (ch) md.choices = ch;
}

// ---- model ----

/**
 * The clicked text comes first (one element, one slot: the popup edits exactly what was clicked), except in a
 * column's form cell, whose texts keep their order (`keep`: Form label, Tooltip, Column name; the popup focuses the
 * form's label, ui/callout.ts focusKeys). A text of the component that its kind doesn't list (an anchor
 * showing another of its slots) gets a block of its own.
 */
function clickedFirst(app: AppApi, md: CalloutModel, key: string, keep = false): void {
  const i = md.blocks.findIndex((b) => b.key === key);
  if (i > 0 && !keep) md.blocks.unshift(...md.blocks.splice(i, 1));
  if (i >= 0) return;
  const s = app.store.get(key);
  if (s && s.comp === md.comp && !md.choices?.keys.includes(key)) md.blocks.unshift(...mk(s, PROP_NAMES[s.prop] || 'Label'));
}

/** What the popup of Microsoft's built-in text says (the look 'builtin'). */
export const BUILTIN_NOTE = "Built-in Microsoft text. It's already translated into every language installed in this environment, so there's nothing to translate here.";
/** What the popup of a sitemap item with no name of its own says (the app designer's placeholder, model.ts namesFirst). */
export const unnamedNote = (kind: Kind, base: string): string =>
  `This ${kind === 'subarea' ? 'menu item' : kind} has no name of its own: Dynamics shows the app designer's placeholder. Name it in each language; other languages will show the ${base} name until you translate them.`;
/** Why the popup of a built-in command whose text holds its table's name (scan.ts command) shows that table's names. */
export const TABLE_COMMAND_WHY = "Microsoft builds this button's text from the table's name: its other words are already translated.";
/** What that popup says where the table's names can be translated here. */
export const TABLE_COMMAND_NOTE = `${TABLE_COMMAND_WHY} Translate the table's name here; the button follows, as does every other place that shows it.`;

export const describe: DescribeFn = (app, comp, a) => {
  const { store } = app;
  // Microsoft's built-in text (scan.ts builtin): its title as the page shows it, and why there is nothing to do.
  if (isBuiltin(comp)) {
    const title = a ? pageText(a) : '';
    const action = a && actionFor(a.role === 'nav' ? 'Open' : undefined, a);
    return { comp, title, kind: 'Built-in', icon: 'info', blocks: [], note: BUILTIN_NOTE, loading: false, ...(action ? { action } : {}) };
  }
  const an = a && a.comp === comp ? a : undefined;
  const m = mainSlot(store, comp);
  // The text the clicked element shows (a table's plural name on a navigation entry), when it is this component's.
  const k = an && store.get(an.key);
  const shown = k && k.comp === comp ? k : m;
  const kind = (m?.kind || comp.slice(0, comp.indexOf('|'))) as Kind;
  const md: CalloutModel = {
    comp,
    title: shown ? textOf(app, shown) : '',
    kind: KIND_LABEL[kind] ?? '',
    icon: ICONS[kind] ?? 'edit',
    blocks: [],
    loading: !m,
  };
  if (!m) return md;
  fill(app, md, m, an);
  // A kind without its own rules; a choice's label is its row in Choices.
  if (!md.blocks.length && !md.choices?.keys.includes(m.key)) md.blocks = mk(m, 'Label');
  if (an) clickedFirst(app, md, an.key, m.kind === 'field' && !!columnOf(m));
  // Never two inputs for one text (e.g. a classic button whose tooltip uses its label's LocLabel).
  const keys = new Set<string>();
  md.blocks = md.blocks.filter((b) => !keys.has(b.key) && !!keys.add(b.key));
  // A selector's own label opens its list, an item of it switches to it (Change … / Open, not the kind's Open).
  const sw = an ? listAction(an) : undefined;
  if (sw !== undefined) md.action = sw ?? undefined;
  // Only an action that does something when pressed; none from the list (no label to act on).
  const act = an && actionFor(md.action, an);
  if (act) md.action = act;
  else delete md.action;
  // Nothing here can be edited: one short reason (the main slot's first). A choice's texts are its rows.
  const slots = (md.blocks.length ? md.blocks.map((b) => b.key) : md.choices?.keys || []).map((k) => store.get(k)).filter((s): s is Slot => !!s);
  if (slots.length && slots.every((s) => s.readOnly)) md.readOnly = (m.readOnly || slots[0].readOnly).trim().replace(/[.\s]+$/, '');
  return md;
};
