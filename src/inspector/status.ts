// Looks, list groups and page helpers of translation mode. Pure functions over app.store, app.ctx and app.prefs
// (no DOM), shared by the controller (mode.ts), the list (pagelist.ts) and the popup content (describe.ts).

import { guid } from '../core/http';
import { lcidName } from '../core/lcid';
import { MANAGED, namesFirst, PROP_NAMES, type Kind, type Lcid, type Prop, type Slot } from '../core/model';
import { fold } from '../core/search';
import type { Store } from '../core/store';
import { notLoaded } from '../ui/editor';
import type { AppApi } from '../ui/types';
import { columnOf } from './column';
import { fallbackOf, navSource } from './fallback';
import type { Place, Target } from './reveal';
import type { GroupFn, Look, LookFn, PageGroup, PageItem } from './types';

/** Property order of a component's slots (the editor card's order). */
const PROPS = Object.keys(PROP_NAMES) as Prop[];
/** Which slot of a component is its label (the same ranking as the page index in scan.ts). */
const PRIO: Prop[] = ['Label', 'DisplayName', 'Name', 'Title', 'DisplayCollectionName'];
const rank = (s: Slot): number => {
  const i = PRIO.indexOf(s.prop);
  return i < 0 ? 9 : i;
};

/** The slots of a component in property order (`slot.key = ${comp}|${prop}`, ARCHITECTURE §3). */
function slotsOf(store: Store, comp: string): Slot[] {
  const out: Slot[] = [];
  for (const p of PROPS) {
    const s = store.get(`${comp}|${p}`);
    if (s) out.push(s);
  }
  return out;
}

/** The slot shown as the component's label: Label, else DisplayName, Name, Title, DisplayCollectionName. */
export function mainSlot(store: Store, comp: string): Slot | undefined {
  let m: Slot | undefined;
  for (const s of slotsOf(store, comp)) if (!m || rank(s) < rank(m)) m = s;
  return m;
}

/** The text a slot shows on the page: the user's language, else the base language, else its title. */
export const textOf = (app: AppApi, s: Slot): string => s.labels[app.ctx.user] || s.labels[app.ctx.base] || s.title || '';

/** Text of a slot by key, or `fallback` when it is not loaded. */
function nameOf(app: AppApi, key: string, fallback = ''): string {
  const s = app.store.get(key);
  return (s && textOf(app, s)) || fallback;
}

/** A table's display name in the user's language (its logical name until the table is loaded). */
const tableName = (app: AppApi, entity: string): string => nameOf(app, `entity|${entity}|DisplayName`, entity);

/** Two texts that read the same (spaces and case aside): the same label. */
const sameText = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * What a label shows in language `l` because it has no text of its own there, when that stands for its own text:
 * a form cell's column name (LIVE-FINDINGS 42), a related menu item's relationship text (its menu label or the
 * listed table's plural name, LIVE-FINDINGS 80), when the label's base-language text is that text's base-language
 * text (as the form designer writes it). '' otherwise: no such text in `l`, or a label worded differently.
 */
export function standsIn(store: Store, s: Slot, l: Lcid, base: Lcid): string {
  const fb = fallbackOf((k) => store.get(k), s);
  if (!fb || notLoaded(s, base) || notLoaded(fb, l)) return '';
  const name = store.original(fb.key, l).trim();
  const own = store.value(s.key, base);
  return name && (!own.trim() || sameText(own, store.original(fb.key, base))) ? name : '';
}

/**
 * Keys of the texts edited together with a label, those that are loaded: a column's tooltip and name, a related
 * menu item's relationship text (its menu label or the listed table's plural name).
 */
export function relatedKeys(store: Store, s: Slot): string[] {
  const c = columnOf(s);
  if (!c) {
    const n = navSource((k) => store.get(k), s);
    return n ? [n.key] : [];
  }
  return (['Description', 'DisplayName'] as const).map((p) => `attribute|${c.entity}.${c.attr}|${p}`).filter((k) => !!store.get(k));
}

// ---- looks ----

/**
 * How a component's label is marked on the page, in priority order: error (the last publish attempt failed for
 * it: a save error or a conflict) > edited (a staged change, not published yet) > ro > na (target not loaded) >
 * missing > ok. error and edited also cover the column texts edited from the same popup (a field's tooltip and
 * column name); ro, na, missing and ok come from the main slot in the target language, except that a read-only label
 * without a target text whose stand-in (its column's name, its relationship's text) can be edited looks as that does.
 */
/**
 * The look of a read-only text: 'ro' for a managed solution's label (MANAGED: its popup says why, no unmanaged
 * layer); grey 'builtin' when it is already there in every installed language (Microsoft's own texts: a system column
 * that can't be renamed), so there is nothing to translate; else 'ro', grey too: its popup gives the reason.
 */
export function readOnlyLook(app: Pick<AppApi, 'store' | 'ctx'>, s: Slot): Look {
  // Read-only because it comes from a managed solution (no unmanaged layer): "read-only", never "built-in", even with
  // every language there; Microsoft's own locked names (their own reason) stay built-in.
  if (s.readOnly === MANAGED) return 'ro';
  return app.ctx.langs.every(({ lcid }) => !notLoaded(s, lcid) && !!app.store.value(s.key, lcid).trim()) ? 'builtin' : 'ro';
}

export const look: LookFn = (app, comp) => {
  const { store, ctx, prefs } = app;
  const own = slotsOf(store, comp);
  let m: Slot | undefined;
  for (const s of own) if (!m || rank(s) < rank(m)) m = s;
  if (!m) return 'na';
  const all = [...own];
  for (const k of relatedKeys(store, m)) all.push(store.get(k)!);

  // The store keeps a failed cell's status while it still holds the text that failed (Store.commit).
  if (store.status.size)
    for (const s of all)
      for (const { lcid } of ctx.langs) {
        const o = store.cellStatus(s.key, lcid)?.outcome;
        if (o === 'error' || o === 'conflict') return 'error';
      }
  for (const s of all) if (store.isEdited(s.key)) return 'edited';

  const t = prefs.target;
  const base = ctx.base;
  if (m.readOnly) {
    // Without a text of its own in the target language, a form cell shows its column's name there (LIVE-FINDINGS 42),
    // a related menu item its relationship's text (LIVE-FINDINGS 80): when that text can be edited (its popup offers
    // it), the label looks as that text does.
    const fb = !notLoaded(m, t) && !store.value(m.key, t).trim() ? fallbackOf((k) => store.get(k), m) : undefined;
    if (fb && !fb.readOnly) return notLoaded(fb, t) ? 'na' : t === base || store.value(fb.key, t).trim() ? 'ok' : 'missing';
    return readOnlyLook(app, m);
  }
  if (notLoaded(m, t)) return 'na';
  // An item with no name yet (an app designer's placeholder) has nothing translated, the base language included.
  if (namesFirst(m) && !store.value(m.key, base).trim() && !store.value(m.key, t).trim()) return 'missing';
  // A description stored empty on purpose (model.ts storedEmpty: its users see none) is translated, never missing.
  if (t === base || store.value(m.key, t).trim() || store.emptyOnPurpose(m.key, t, base)) return 'ok';
  // A base text that was not read (tab labels loaded in the user's language only) is unknown, not empty.
  const bv = notLoaded(m, base) ? null : store.value(m.key, base);
  // A form cell without a label in the target language shows the column's name in it (LIVE-FINDINGS 42), a related
  // menu item its relationship's text (LIVE-FINDINGS 80): when the label's wording is that text's, it is its
  // translation already, not a gap.
  return bv !== null && (!bv.trim() || standsIn(store, m, t, base)) ? 'ok' : 'missing';
};

/** Looks the list counts as changed (staged, or a publish attempt failed for it). */
export const isPending = (l: Look): boolean => l === 'edited' || l === 'error';

/** What a look means, for tooltips and screen readers. */
export function lookText(app: AppApi, l: Look): string {
  switch (l) {
    case 'missing':
      return `Not translated into ${lcidName(app.prefs.target)} yet`;
    case 'edited':
      return 'Changed, not published yet';
    case 'error':
      return "Couldn't be published";
    case 'builtin':
      return 'Built-in, already translated';
    case 'ro':
      return 'Read-only';
    case 'na':
      return 'Not loaded';
    default:
      return 'Translated';
  }
}

// ---- list groups ----

/** Groups of "All labels on this page", in display order. */
export const GROUPS: PageGroup[] = ['Form', 'Choices', 'Command bar', 'Navigation', 'Process', 'Table and views'];

const GROUP: Record<Kind, PageGroup> = {
  field: 'Form',
  dfield: 'Form',
  tab: 'Form',
  section: 'Form',
  dtab: 'Form',
  dsection: 'Form',
  navitem: 'Form',
  // A relationship's label is an item of the form's Related menu.
  relationship: 'Form',
  option: 'Choices',
  status: 'Choices',
  state: 'Choices',
  boolean: 'Choices',
  globaloption: 'Choices',
  globaloptionset: 'Choices',
  command: 'Command bar',
  ribbon: 'Command bar',
  area: 'Navigation',
  group: 'Navigation',
  subarea: 'Navigation',
  app: 'Navigation',
  bpf: 'Process',
  stage: 'Process',
  step: 'Process',
  entity: 'Table and views',
  attribute: 'Table and views',
  view: 'Table and views',
  chart: 'Table and views',
  form: 'Table and views',
  dashboard: 'Table and views',
  envvar: 'Table and views',
  customapi: 'Table and views',
};

export const groupOf: GroupFn = (s) => GROUP[s.kind] ?? 'Table and views';

// ---- the list ----

/**
 * What the list's search looks in, folded (core/search.ts): every language of the component's texts, staged and as on
 * the server, its title, technical name and breadcrumb, and what its row shows besides (`shown`: the column name of a
 * cell without a label of its own, its place heading, its kind).
 */
export function searchText(app: Pick<AppApi, 'store' | 'ctx'>, item: PageItem, shown: readonly string[] = []): string {
  const { store, ctx } = app;
  const m = item.main;
  const parts = [m.title, m.sub, ...m.path, ...shown];
  for (const s of slotsOf(store, item.comp)) for (const { lcid } of ctx.langs) parts.push(store.value(s.key, lcid), store.original(s.key, lcid));
  return fold(parts.join('\n'));
}

// ---- page title ----

/** What pageTitle needs of the page loader's page (structural, so the loader can grow). */
export interface PageLike {
  info: { type: string };
  entity: string;
  formId: string;
  viewId: string;
}

const FORM_TYPES: Record<number, string> = { 0: 'Dashboard', 2: 'Main form', 6: 'Quick view form', 7: 'Quick create form', 10: 'Dashboard', 11: 'Card form', 12: 'Main form' };

/** Forms by id with their name and type (PageLoader.forms). */
export type FormNames = { get(id: string): { name: string; type: number } | undefined };

/**
 * The page in words, e.g. "Service request · Main form" (record: table · form), "Accounts · Active accounts"
 * (list: plural · view), "Sales dashboard · Dashboard", "Sales Hub · App navigation"; '' when unknown.
 */
export function pageTitle(app: AppApi, p: PageLike | null | undefined, o: { forms?: FormNames; appId?: string } = {}): string {
  if (!p) return '';
  const join = (...a: string[]) => a.filter(Boolean).join(' · ');
  const ent = p.entity ? tableName(app, p.entity) : '';
  const t = p.info.type;
  if (t === 'entityrecord') {
    const f = o.forms?.get(p.formId);
    return join(ent, p.formId ? nameOf(app, `form|${p.formId}|Name`, f?.name || (f ? FORM_TYPES[f.type] || '' : '')) : '');
  }
  if (t === 'entitylist') return join(p.entity ? nameOf(app, `entity|${p.entity}|DisplayCollectionName`, ent) : '', p.viewId ? nameOf(app, `view|${p.viewId}|Name`) : '');
  if (t === 'dashboard') return join(p.formId ? nameOf(app, `dashboard|${p.formId}|Name`) : '', 'Dashboard');
  const a = o.appId ? nameOf(app, `app|${o.appId}|Name`) : '';
  return a ? join(a, 'App navigation') : '';
}

/** The place heading of a change that wasn't made on a page in translation mode (the Workbench, an import, the editor): nothing to go to. */
export const WORKBENCH = 'Workbench';
/** The place heading of a change staged on a page that has no name. */
export const ANOTHER_PAGE = 'Another page';
/** Kinds whose breadcrumb's second step is their form, "Name (Main form)" (formxml.ts). */
const IN_FORM = new Set<Kind>(['field', 'section', 'tab', 'navitem']);

/** A target or a place as pageTitle reads a page. */
function likeOf(t: Target | Place): PageLike {
  if (!('to' in t)) return { info: { type: t.type }, entity: t.entity, formId: t.type === 'dashboard' ? t.dashboardId : t.formId, viewId: t.viewId };
  if (t.to === 'form') return { info: { type: 'entityrecord' }, entity: t.entity, formId: t.formId, viewId: '' };
  if (t.to === 'list') return { info: { type: 'entitylist' }, entity: t.entity, formId: '', viewId: t.viewId };
  return { info: { type: 'dashboard' }, entity: '', formId: t.dashboardId, viewId: '' };
}

/**
 * The page a change staged elsewhere was made on, in words, for its place heading under "Changed on other pages": the
 * page a click goes to (`to`, reveal.ts targetOf), else the page it was staged on (`was`), as pageTitle says it
 * ("Contact · Main form", "Accounts · Active Accounts", "Sales Hub · App navigation"); a form whose name the page
 * tracker doesn't know is named as the slot's breadcrumb names it. "Workbench" for a change that wasn't made on a page
 * (nothing to go to), "Another page" for a page without a name.
 */
export function awayTitle(app: AppApi, m: Slot, to: Target | null, was: Place | null, o: { forms?: FormNames; appId?: string } = {}): string {
  const at = to ?? was;
  if (!at) return WORKBENCH;
  const p = likeOf(at);
  const hint = p.formId && IN_FORM.has(m.kind) && guid(m.ref?.formId) === p.formId ? String(m.path[1] || '').replace(/\s*\([^()]*\)$/, '') : '';
  const forms: FormNames = { get: (id) => o.forms?.get(id) ?? (hint && id === p.formId ? { name: hint, type: NaN } : undefined) };
  return pageTitle(app, p, { forms, appId: o.appId }) || (was ? ANOTHER_PAGE : WORKBENCH);
}
