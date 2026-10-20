// Translation mode: the controller behind the bar, the popups and "All labels on this page". It keeps the page
// index and anchors current as the user works in Dynamics (navigation, form switches, tabs, re-renders), marks
// them through the overlay and opens one popup at a time next to the clicked label. Typing in a popup only stages
// edits in the store; the bar's "Review and publish" saves and publishes them. It never changes Dynamics' DOM:
// the user's own-language staged text is shown in place through preview.ts only.

import { pageInfo } from '../core/context';
import { guid } from '../core/http';
import type { Kind, Lcid, Slot } from '../core/model';
import type { Store } from '../core/store';
import { openCallout } from '../ui/callout';
import { debounce } from '../ui/dom';
import { notLoaded } from '../ui/editor';
import type { AppApi } from '../ui/types';
import { modalOpen } from '../ui/widgets';
import { describe, inTransient, navIdOf, useRibbonControls } from './describe';
import { focusOpener, openList, switchTo, type ListFx } from './lists';
import { Overlay } from './overlay';
import { formOf, PageLoader } from './pageload';
import { choiceColumn, choiceNote, choiceSet, fieldPills, fieldsAround, type ChoiceNote } from './pill';
import { Preview } from './preview';
import {
  backStep,
  backTo,
  bodyPlace,
  formShows,
  goAgain,
  goTo,
  headerOpen,
  NOTHING,
  NOWHERE,
  openHeader,
  openStage,
  pageDialog,
  placeholder,
  placeOf,
  revealOf,
  routeTo,
  selectedTab,
  spotOf,
  stageFlyout,
  targetOf,
  TRIP_WAIT,
  tripStep,
  type Back,
  type Place,
  type Reveal,
  type RevealCtx,
  type Spot,
  type Trip,
} from './reveal';
import { buildIndex, isBuiltin, ofProcess, paneOf, Scanner, type PageIndex } from './scan';
import { awayTitle, groupOf, isPending, look, pageTitle, readOnlyLook, WORKBENCH } from './status';
import type { Action, Anchor, Callout, CalloutHost, CalloutModel, CreatePageMode, Look, OverlayHooks, PageGroup, PageItem, PageMode, PageNote, Switch } from './types';

type Ev = 'items' | 'page' | 'alt' | 'loading';
interface OpenOpts {
  from?: Element;
  focus?: string;
  lcid?: Lcid;
}
/** The open popup. */
interface Cur {
  comp: string;
  /** The slot it was opened for: the clicked element's, the one asked for (`focus`), else the component's label. */
  want: string;
  /** The label it points at; null = docked above the bar (hidden label, or the label went away). */
  a: Anchor | null;
  /** Placement only, while `a` is null: a label shown next to it (the field of a column, a table's plural name). */
  near: Anchor | null;
  /** The last label it pointed at, to find it again when Dynamics re-renders it. */
  was: Anchor | null;
  /** Where that label was last seen (the nearest copy wins when it comes back). */
  at: DOMRect | null;
  /** The label was last seen in a menu or flyout (describe.ts TRANSIENT), which closes when the popup is used. */
  menu: boolean;
  /** The list row it was opened from (placement fallback while the label is not visible). */
  row: Element | null;
  /** The list sheet's box while the popup points at its row (rowAnchor): the popup opens beside it. */
  by: DOMRect | null;
  c: Callout | null;
  /** The model's secondary action (runAction), as last described. */
  action: Action | '';
  /** The label the popup's content and action were last described for: `a`, else `was` then. */
  subject: Anchor | null;
  /** Where on the page its label was when it was opened (or moved to it): what a change typed in it remembers. */
  spot: Spot;
  /** The texts it edits (slot keys), as last described: callout.ts snapshots and stages these. */
  keys: ReadonlySet<string>;
  off: () => void;
  closed: boolean;
}

/** A find gone to another page: the component, how it was asked for, and where it goes (reveal.ts tripStep). */
interface Going extends Trip {
  comp: string;
  o: OpenOpts;
}

/** Where a change was made in translation mode: the page, and the place on it (reveal.ts Spot). */
export interface Staged {
  page: Place;
  spot: Spot;
}

/** The open popup as notePlaces sees it: its component, the texts it edits, where its label was. */
export interface OpenSpot {
  comp: string;
  keys: ReadonlySet<string>;
  spot: Spot;
}

/**
 * Where a change staged now was made (`key`, of component `comp`): the page shown in translation mode (`page`, null
 * when not on one or paused), for a label of that page (`onPage`) or a text the open popup edits (`open`, its label of
 * that page): at the popup's place when it edits that text, else where its own label shows now (`spot`). Null anywhere
 * else, and for a text the open popup doesn't edit whose label isn't on the page (an older step redone with Ctrl+Y
 * while a popup is open): it was never changed here.
 */
export function stagedAt(key: string, comp: string, page: Place | null, open: OpenSpot | null, onPage: (comp: string) => boolean, spot: () => Spot): Staged | null {
  const edits = !!open && open.keys.has(key);
  if (!page || !(onPage(comp) || (edits && onPage(open!.comp)))) return null;
  return { page, spot: edits ? open!.spot : spot() };
}

/** The texts a popup's content edits: its blocks, their copies on the form, its choices (as callout.ts keysOf). */
export const modelKeys = (m: Pick<CalloutModel, 'blocks' | 'choices'>): Set<string> =>
  new Set([...m.blocks.map((b) => b.key), ...m.blocks.flatMap((b) => b.also?.keys || []), ...(m.choices?.keys || [])]);

/**
 * How long a label may take to render after opening what hides it (a form tab, the header's flyout, a process stage) or
 * after its place was brought into view (Dynamics draws a tab's fields as they come into view).
 */
const REVEAL_WAIT = 2500;
/** How often a find gone to another page looks at the page. */
const TRIP_EVERY = 200;
const CHOICES = new Set<Kind>(['option', 'status', 'state', 'boolean']);

// ---- pure helpers (unit tested in tools/dev/tests/mode.ts) ----

/**
 * The anchors of a component that show the slot the popup is for: `want` first, then its label (`main`).
 * Another one (a table's plural name on a sitemap entry, when the table's name was asked for) would describe
 * a different text: it may only place the popup (see `near`), never decide what it edits.
 */
export function showing(as: readonly Anchor[], want: string, main: string): Anchor[] {
  const out = as.filter((a) => a.key === want);
  if (main !== want) for (const a of as) if (a.key === main) out.push(a);
  return out;
}

/**
 * The label to point at again after Dynamics re-rendered the page: the same element, else a copy showing the
 * same slot in the same role, else one showing the same slot (the best `rank`, e.g. the nearest, wins); with no
 * earlier label, one showing the slot the popup is for. Null when none: never a label of another slot.
 */
export function again(as: readonly Anchor[], old: Anchor | null, want: string, main: string, rank: (a: Anchor) => number = () => 0): Anchor | null {
  const best = (l: Anchor[]): Anchor | null => {
    let r: Anchor | null = null;
    let v = Infinity;
    for (const a of l) {
      const n = rank(a);
      if (!r || n < v) (r = a), (v = n);
    }
    return r;
  };
  if (!old) return best(showing(as, want, main));
  return as.find((a) => a.el === old.el && a.key === old.key) || best(as.filter((a) => a.key === old.key && a.role === old.role)) || best(as.filter((a) => a.key === old.key));
}

/**
 * The page table's column a component is about (a column, or one of its choices), lower case; '' when none.
 * The popup of such a text sits next to the field that shows the column, when the text itself isn't shown.
 */
export function columnOn(s: Slot | undefined, entity: string): string {
  const r = s?.ref || {};
  const e = entity.toLowerCase();
  if (!s || !e) return '';
  if (s.kind === 'attribute' || CHOICES.has(s.kind)) return String(r.entity || s.entity || '').toLowerCase() === e ? String(r.attribute || '').toLowerCase() : '';
  if (s.kind === 'globaloption') {
    for (const u of Array.isArray(r.usedBy) ? r.usedBy : []) {
      const [t, a] = String(u).toLowerCase().split('.');
      if (t === e && a) return a;
    }
  }
  return '';
}

/**
 * The look of one slot shown on the page that is not its component's main label (e.g. a table's plural name
 * on a sitemap entry): the component's look describes its main label, this one describes what the user sees.
 * The same priorities as a component's look (status.ts): error > edited > ro > na > missing > ok.
 */
export function slotLook(app: Pick<AppApi, 'store' | 'ctx' | 'prefs'>, s: Slot): Look {
  const { store, ctx, prefs } = app;
  if (s.readOnly) return readOnlyLook(app, s);
  const base = ctx.base;
  let edited = false;
  for (const { lcid: l } of ctx.langs) {
    const o = store.cellStatus(s.key, l)?.outcome;
    if (o === 'error' || o === 'conflict') return 'error';
    // A blank Dataverse would refuse is a staged change too until a publish rejects it (the popup says why).
    if (store.isEdited(s.key, l)) edited = true;
  }
  if (edited) return 'edited';
  const t = prefs.target;
  if (t === base) return 'ok';
  if (notLoaded(s, t)) return 'na';
  // A description stored empty on purpose (model.ts storedEmpty) is translated: its users see none, as chosen.
  return store.value(s.key, base).trim() && !store.value(s.key, t).trim() && !store.emptyOnPurpose(s.key, t, base) ? 'missing' : 'ok';
}

/** Switches the record form to a tab (Dynamics' own API: no click, nothing on the record changes). */
export function focusTab(xrm: any, name: string): boolean {
  if (!name) return false;
  try {
    const t = xrm?.Page?.ui?.tabs?.get?.(name);
    if (!t) return false;
    t.setFocus();
    return true;
  } catch {
    return false; // not a record form (dashboard), or the form is being replaced
  }
}

/**
 * Opens a related menu item's view (Dynamics' navigation API by the item's nav id, LIVE-FINDINGS 87). It needs no
 * element: the related menu that showed the item closes as soon as the popup is used.
 */
export function focusNav(xrm: any, id: string): boolean {
  if (!id) return false;
  try {
    const n = xrm?.Page?.ui?.navigation?.items?.get?.(id);
    if (!n) return false;
    n.setFocus();
    return true;
  } catch {
    return false; // not a record form, or the form is being replaced
  }
}

/** What the popup's secondary action can do on the page (the controller's effects); each says whether it could. */
export interface ActFx {
  /** Opens a related menu item's view through the form's navigation API (`id`: its nav id). */
  nav(a: Anchor, id: string): boolean;
  /** Shows the tab (the tab API, else a click on it). */
  tab(a: Anchor): boolean;
  /** Clicks the label for Dynamics, while it is on the page. */
  click(a: Anchor): boolean;
  /** Shows a process stage's flyout: a click on its chip, unless the flyout is open already (the click would close it). */
  stage(a: Anchor): boolean;
  /** Opens the list a selector's button opens (lists.ts openList). */
  list(sw: Switch): boolean;
  /** Switches to an item of such a list, which has closed by now (lists.ts switchTo). */
  pick(sw: Switch): boolean;
}

/**
 * The popup's secondary action on a label (describe.ts actionFor offers it). Open: an item of a selector's list switches
 * to it (lists.ts), a related view through the navigation API, else a click like the user's (a sitemap entry, the
 * Related tab's menu); Show stage: a click on the stage chip (its flyout); Show tab: the tab; Change area / form / view:
 * the selector's list. Only navigation items, selectors, stages and tabs are acted on, never a command, a value or an
 * option. True when it acted.
 */
export function runAction(action: Action | '', a: Anchor, fx: ActFx): boolean {
  switch (action) {
    case 'Open': {
      if (a.role !== 'nav') return false;
      if (a.sw) return !!a.sw.id && fx.pick(a.sw);
      const id = navIdOf(a.el);
      return (!!id && fx.nav(a, id)) || fx.click(a);
    }
    case 'Change area':
    case 'Change form':
    case 'Change view':
      return !!a.sw && !a.sw.id && `Change ${a.sw.list}` === action && fx.list(a.sw);
    case 'Show stage':
      return a.role === 'stage' && fx.stage(a);
    case 'Show tab':
      return a.role === 'tab' && fx.tab(a);
    default:
      return false;
  }
}

/** What finds a page element by a selector (lists.ts): the document's first. */
const pageFind = (sel: string): Element | null => document.querySelector(sel);

/**
 * Change area / form / view and an item's Open on the page (runAction's ActFx.list and pick, lists.ts): the page form's
 * API, the document, a click like the user's, timers that do nothing once translation mode has stopped (`live`), and a
 * warning toast when it couldn't be done.
 */
export function listActs(app: Pick<AppApi, 'ctx' | 'toast'>, live: () => boolean): Pick<ActFx, 'list' | 'pick'> {
  const fx: ListFx = {
    get xrm() {
      return app.ctx.xrm;
    },
    find: pageFind,
    click: (el) => (el as HTMLElement).click(),
    later: (fn, ms) => void setTimeout(() => live() && fn(), ms),
    now: () => Date.now(),
    fail: (m) => app.toast(m, 'warn'),
  };
  return { list: (sw: Switch) => openList(sw, fx), pick: (sw: Switch) => switchTo(sw, fx) };
}

/**
 * Where a popup points while its label isn't shown: a label near it (the field of a column), else, when its label left
 * with the menu or flyout that showed it (`fled`: it closed as the popup took the focus or a click), where that label
 * was last seen, so the popup stays put rather than jumping to the bar. Null: docked above the bar.
 */
export function restRect(near: DOMRect | null, fled: boolean, at: DOMRect | null): DOMRect | null {
  return near ?? (fled ? at : null);
}

/**
 * Where a popup opened from a list row points while its label `r` isn't shown or the list sheet covers it: the row,
 * with the sheet's box (`by`: the popup opens beside it, never over the list). Null: at the label. Covered means under
 * the sheet's box, docked on the right or floating where it was dragged (it was dragged to uncover the label); a row
 * outside a sheet only hides what is past the viewport's right edge (`W`).
 */
export function rowAnchor(r: DOMRect | null, row: Element, W: number): { at: DOMRect; by: DOMRect | null } | null {
  const s = row.closest('.pgl')?.getBoundingClientRect() ?? null;
  const covered = !r || (s ? r.right > s.left && r.left < s.right && r.bottom > s.top && r.top < s.bottom : r.right > W);
  return covered ? { at: row.getBoundingClientRect(), by: s } : null;
}

// ---- cold boot (LIVE-FINDINGS 51) ----

/**
 * A record form as a cold boot can leave it: after a cache purge and reload (ui/refresh.ts) the form renders, but
 * Xrm.Page.ui often has no controls (sometimes no tabs either) for good, so labels can't be tied to their form
 * cells through the form API. Opening the same record again (Xrm.Navigation.openForm) rebuilds it in ~0.3 s.
 */
export interface ColdForm {
  /** The page form shows labels (field labels or tabs): it has rendered. */
  rendered: boolean;
  /** Xrm.Page.ui.controls / tabs getLength(); NaN when there is no form API at all. */
  controls: number;
  tabs: number;
  /** Unsaved changes on the record; null when that can't be told. */
  dirty: boolean | null;
  entity: string;
  /** The record ('' on a create form). */
  id: string;
  formId: string;
}

/**
 * What to do about the form API at start: 'none' (it is complete, or the form hasn't rendered yet), 'reopen' (open
 * the same record and form again), 'skip' (it is empty but reopening could lose unsaved changes, or there is no
 * record: the scan stays on the DOM and fieldOf refuses what it can't place). A form the page doesn't name (no
 * form id in the URL or the page context) is opened as Dynamics opened it: with the table's last-used form.
 */
export function coldStep(f: ColdForm): 'none' | 'reopen' | 'skip' {
  if (!f.rendered || (f.controls !== 0 && f.tabs !== 0)) return 'none';
  return f.dirty === false && f.entity && f.id ? 'reopen' : 'skip';
}

const count = (fn: () => unknown): number => {
  try {
    const n = Number(fn());
    return Number.isFinite(n) ? n : NaN;
  } catch {
    return NaN;
  }
};

/** fn(), false when it throws (Xrm parts are missing while UCI navigates). */
const safely = (fn: () => boolean): boolean => {
  try {
    return fn();
  } catch {
    return false;
  }
};

/** Unsaved changes on the record (Xrm.Page.data, else its entity); null when that can't be told. */
function dirtyOf(xrm: any): boolean | null {
  try {
    const d = xrm.Page.data;
    const v = typeof d.getIsDirty === 'function' ? d.getIsDirty() : d.entity.getIsDirty();
    return typeof v === 'boolean' ? v : null;
  } catch {
    return null;
  }
}

/** Reads ColdForm from the page (`page`: the record page the loader tracks; `root`: the document). */
export function coldForm(xrm: any, page: { entity: string; formId: string; info: { type: string; recordId: string } } | null, root?: Pick<Document, 'querySelector'>): ColdForm {
  let rendered = false;
  try {
    rendered = page?.info.type === 'entityrecord' && !!(root ?? document).querySelector('[data-id$="-FieldSectionItemContainer"] label[id$="field-label"],li[role="tab"][data-id^="tablist-"]');
  } catch {
    rendered = false;
  }
  return {
    rendered,
    controls: count(() => xrm.Page.ui.controls.getLength()),
    tabs: count(() => xrm.Page.ui.tabs.getLength()),
    dirty: dirtyOf(xrm),
    entity: page?.entity || '',
    id: page?.info.recordId || '',
    formId: page?.formId || '',
  };
}

/**
 * Repairs a cold form API when coldStep says 'reopen'. A form still being built (a navigation within the app)
 * fills it on its own, so it first waits up to `settle` ms; then, if the record is still not dirty and the page is
 * still the one `f` describes (`still`: the user may have gone to another record or form meanwhile), it opens the
 * same record and form again and waits (polling, at most `wait` ms) until the form API has controls and tabs.
 * True once it has; false when nothing was done or it stayed empty.
 */
export async function wakeForm(
  xrm: any,
  f: ColdForm,
  o: { settle?: number; wait?: number; every?: number; sleep?: (ms: number) => Promise<unknown>; now?: () => number; still?: () => boolean } = {},
): Promise<boolean> {
  if (coldStep(f) !== 'reopen') return false;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const ready = () => count(() => xrm.Page.ui.controls.getLength()) > 0 && count(() => xrm.Page.ui.tabs.getLength()) > 0;
  const poll = async (ms: number): Promise<boolean> => {
    const until = now() + ms;
    for (;;) {
      if (ready()) return true;
      if (now() >= until) return false;
      await sleep(o.every ?? 100);
    }
  };
  if (await poll(o.settle ?? 500)) return true;
  // Typed into the record meanwhile: opening it again would ask to discard that, or lose it. Gone to another
  // page meanwhile (a lookup, a sub-grid row, the form selector): opening this one would take the user back.
  if (dirtyOf(xrm) !== false || (o.still && !safely(o.still))) return false;
  try {
    // Not awaited: its promise settles when the form has loaded, which the poll sees as well.
    void Promise.resolve(xrm.Navigation.openForm({ entityName: f.entity, entityId: f.id, ...(f.formId ? { formId: f.formId } : {}) })).catch(() => {});
  } catch {
    return false;
  }
  return poll(o.wait ?? 3000);
}

/** The open popup, as a click on a label sees it. */
export interface OpenNow {
  comp: string;
  /** The label it points at (null = docked). */
  a: Anchor | null;
  /** The slot it was opened for. */
  want: string;
}

/** What a click on a label can do (the controller's effects). */
export interface ClickFx {
  /** The open popup moves to this label, which shows the same text (a copy in "More tabs", another grid row). */
  move(a: Anchor): void;
  /** Opens this label's popup (the open one closes; what was typed in it stays staged). */
  open(a: Anchor): void;
}

/**
 * A click (or F2) on a marked label opens its popup, and nothing on the page acts: tabs, navigation, commands, stages,
 * column headers and values (the popup's Show tab / Open / Show stage does; Alt+click uses the page). Nothing typed
 * ever blocks it: there is no "save or cancel first".
 */
export function clickLabel(a: Anchor, now: OpenNow | null, fx: ClickFx): void {
  if (now && now.comp === a.comp && (now.a ? now.a.key === a.key && now.a.role === a.role : a.key === now.want)) fx.move(a);
  else fx.open(a);
}

/**
 * The label `a` clicked (scanned on the page before) as a new scan of the page found it: the same element and role (and
 * part of its text, for one that shows several), whatever page's index it was matched against now. Null when the new
 * scan doesn't mark it.
 */
export function sameLabel(a: Anchor, list: readonly Anchor[]): Anchor | null {
  return list.find((b) => b.el === a.el && b.role === a.role && b.part?.start === a.part?.start && b.part?.end === a.part?.end) ?? null;
}

/**
 * The counts of the bar and the list: the list's rows (the page's labels and the changes staged on other pages), those
 * missing in the target language, every staged change.
 */
export function countLabels(items: readonly PageItem[], store: Pick<Store, 'pendingCount'>): { all: number; missing: number; pending: number } {
  let missing = 0;
  for (const i of items) if (i.look === 'missing') missing++;
  // Everything staged counts, also edits of other pages or the Workbench: one Publish publishes them all.
  return { all: items.length, missing, pending: store.pendingCount() };
}

/** The page's notes: its failed loads only (one per message), each with Try again. */
export function loadNotes(errors: Iterable<string>, retry: () => void): PageNote[] {
  return [...new Set(errors)].map((text): PageNote => ({ tone: 'error', text, action: 'Try again', run: retry }));
}

// ---- the controller ----

export const createPageMode: CreatePageMode = (app) => {
  const { ctx, store } = app;
  let on = false;
  let paused = false;
  let destroyed = false;
  let x: PageIndex | null = null;
  let href = '';
  let prefsSig = '';
  let tick = 0;
  let waitT = 0;
  let waitId = 0;
  let cur: Cur | null = null;
  /** app.edit() asks this mode first; a comp whose popup could not open goes to the app's editor instead. */
  let bypass = '';
  let itemsCache: PageItem[] | null = null;
  const looks = new Map<string, Look>();
  /** Pending choices per column ('entity.attr'), for the pills: counted once per store change. */
  const choiceNotes = new Map<string, ChoiceNote | null>();
  const langs = ctx.langs.map((l) => l.lcid);
  let loadSig = '';
  let lastTitle = '';
  /** The form API is being rebuilt (wake): nothing is scanned meanwhile, the bar says "Loading translations…". */
  let waking = false;
  /** Pages (loader signatures) whose form API was checked for a cold boot. */
  const coldChecked = new Set<string>();
  const subs = new Set<(w: Ev) => void>();
  /**
   * Staged slot key -> where it was staged: the page and the place on it (null: not on a page in translation mode, i.e.
   * the Workbench, an import or the editor), so a change can be found again exactly there from another page or tab.
   * This session only.
   */
  const staged = new Map<string, Staged | null>();
  /** The find gone to another page, waiting for it (goFind). */
  let trip: Going | null = null;
  let tripT = 0;

  const emit = (w: Ev): void => {
    for (const f of [...subs])
      try {
        f(w);
      } catch (e) {
        if (__DEV__) console.error('[translator]', e);
      }
  };
  const emitSoon = debounce(() => emit('items'), 40);
  const refreshSoon = debounce(refresh, 60);
  const navSoon = debounce(navigate, 350);
  const loadSoon = debounce(checkLoad, 0);

  // Every language of the page's form is loaded from the start, tab and section labels included (the language
  // switch is automatic): popups never wait for a button.
  const loader = new PageLoader(app, () => {
    if (!on) return; // loads stopped by destroy() still finish: nothing to refresh then
    refreshSoon();
    loadSoon();
  });
  const scanner = new Scanner();
  const hooks: OverlayHooks = {
    look: anchorLook,
    pills: () =>
      fieldPills(scanner.list, {
        column: (a) => choiceColumn(store.get(a.key)),
        note: choicesOf,
        fields: fieldsAround,
        readOnly: (a) => !!store.get(a.key)?.readOnly,
      }),
    open: onLabel,
    mutated,
    ours: () => [app.root.host],
    alt: () => emit('alt'),
  };
  // The class, not only its OverlayApi: active() also takes the label the popup points at (marked alone).
  const overlay = new Overlay(hooks);
  const preview = new Preview(app, (fn) => overlay.quiet(fn));
  scanner.textOf = preview.textOf;

  /**
   * The component belongs to this page (shown now, or reachable: other tabs, hidden fields, its columns). Defined
   * before notePlaces() first runs, as the mode is created: a Store that already holds changes hands it to stagedAt.
   */
  const onPage = (comp: string): boolean => !!x?.main.has(comp) && (x.universe.has(comp) || scanner.seen.has(comp) || scanner.of(comp).length > 0);

  /**
   * Remembers where each new staged change was made (stagedAt): the page shown while translation mode is on and not
   * paused, for a label of that page or a text the open popup of one edits with it (a related menu item's relationship),
   * with the place on it: the open popup's for a text it edits (where its label was when it opened: the form tab or
   * related view shown, the flyout it was in), else where the label is now. None for one made in the Workbench, before
   * the mode started, in the app's editor or a docked popup for a label of no page here (one found from "Changed on other
   * pages" that didn't show). A text the open popup doesn't edit (an older step redone with Ctrl+Y) goes by its own label.
   * Forgotten once it is no longer staged (published, undone, dropped by a reload that brought the same text).
   */
  function notePlaces(): void {
    const p = on && !paused && loader.page ? placeOf(loader.page.info) : null;
    const open = cur && !cur.closed ? cur : null;
    for (const k of store.edits.keys()) {
      if (staged.has(k)) continue;
      const c = store.get(k)?.comp || '';
      staged.set(k, stagedAt(k, c, p, open, onPage, () => spotNow(scanner.of(c).find((a) => overlay.rectOf(a)) ?? null)));
    }
    for (const k of staged.keys()) if (!store.edits.has(k)) staged.delete(k);
  }
  notePlaces();

  const offStore = store.on((e) => {
    // Made in the Workbench, then changed again on a page: it is where it was changed on that page now.
    if (e.type === 'edit' && staged.get(e.key) === null) staged.delete(e.key);
    // A reload that brought the same text drops a change with only a 'slots' event: its place goes with it, or the
    // change made again elsewhere would keep the first page.
    if (e.type === 'edit' || e.type === 'edits' || e.type === 'slots') notePlaces();
    if (!on || e.type === 'busy') return;
    if (e.type === 'slots') return refreshSoon();
    if (e.type === 'edit') {
      // The user's own language shows the staged text in place while typing (the original again after Undo).
      const c = store.get(e.key)?.comp;
      if (c) preview.apply(scanner.of(c));
    } else preview.apply(scanner.list);
    repaint();
  });
  // The popup of a classic button offers its tooltip labels too: describe() reads the loader's ribbon map.
  useRibbonControls(app, loader.ribbon);

  // ---- looks and items ----

  function compLook(comp: string): Look {
    let l = looks.get(comp);
    if (!l) {
      try {
        l = look(app, comp);
      } catch (e) {
        if (__DEV__) console.error('[translator]', e);
        l = 'ok';
      }
      looks.set(comp, l);
    }
    return l;
  }

  function anchorLook(a: Anchor): Look {
    if (isBuiltin(a.comp)) return 'builtin';
    const m = x?.main.get(a.comp);
    const s = m && a.key !== m.key ? store.get(a.key) : undefined;
    return s ? slotLook(app, s) : compLook(a.comp);
  }

  /** A column's pending choices (as its popup lists them); null when none is, or it has none. */
  function choicesOf(col: string): ChoiceNote | null {
    let n = choiceNotes.get(col);
    if (n === undefined) {
      const list = x?.opts.get(col);
      choiceNotes.set(col, (n = list ? choiceNote(store, langs, choiceSet(list).map((s) => s.key)) : null));
    }
    return n;
  }

  /** Looks, items and counts are stale: re-mark the page and tell the bar and the list. */
  function repaint(): void {
    looks.clear();
    choiceNotes.clear();
    itemsCache = null;
    overlay.paint();
    emitSoon();
  }

  function items(): PageItem[] {
    if (itemsCache) return itemsCache;
    if (!x) return (itemsCache = []);
    const order = new Map<string, number>();
    scanner.list.forEach((a, i) => order.has(a.comp) || order.set(a.comp, i));
    const out: PageItem[] = [];
    // The components with a change made on a page (looked at once, not per label of the page).
    const placed = new Set<string>();
    for (const [k, p] of staged) if (p) placed.add(store.get(k)?.comp ?? '');
    for (const comp of new Set([...x.universe, ...scanner.seen, ...order.keys()])) {
      const m = x.main.get(comp);
      // A change made on another page that this page lists but doesn't show is listed (and found) where it was made.
      if (!m || (placed.has(comp) && elsewhere(comp))) continue;
      let group: PageGroup = 'Form';
      try {
        group = groupOf(m);
      } catch (e) {
        if (__DEV__) console.error('[translator]', e);
      }
      out.push({ comp, main: m, group, visible: order.has(comp), look: compLook(comp) });
    }
    // Changes whose label isn't on the page: those that live on this page anyway (a quick view without its record, a
    // sub-grid on another tab) are among its labels not on screen; the others come last, under the page each lives on.
    const { mine, away } = awayItems(new Set(out.map((i) => i.comp)));
    out.push(...mine);
    // On-page labels in page order, then the others (other tabs, hidden fields, other stages) by breadcrumb.
    const pos = (i: PageItem) => (i.visible ? order.get(i.comp)! : Infinity);
    out.sort((a, b) => pos(a) - pos(b) || a.main.path.join('\n').localeCompare(b.main.path.join('\n')) || a.main.order - b.main.order);
    out.push(...away);
    return (itemsCache = out);
  }

  /**
   * The changes staged (or failed to publish) whose label isn't on this page: `away`, for "Changed on other pages", each
   * under the page it was made on (awayTitle; "Workbench" when it wasn't made on a page: nothing to go to), by page,
   * then breadcrumb; `mine`, those made on this page (routeTo 'here'), which a click finds here.
   */
  function awayItems(here: ReadonlySet<string>): { mine: PageItem[]; away: PageItem[] } {
    const mine: PageItem[] = [];
    if (!x) return { mine, away: [] };
    const pl = loader.page ? placeOf(loader.page.info) : null;
    // comp -> the page one of its staged slots was staged on (the first one known wins).
    const comps = new Map<string, Place | null>();
    const add = (key: string): void => {
      const c = store.get(key)?.comp;
      if (c && !here.has(c) && !comps.get(c)) comps.set(c, staged.get(key)?.page ?? null);
    };
    for (const k of store.edits.keys()) add(k);
    for (const [k, st] of store.status) if (st.outcome === 'error' || st.outcome === 'conflict') add(k.slice(0, k.lastIndexOf('#')));
    const out: PageItem[] = [];
    for (const [comp, was] of comps) {
      const m = x.main.get(comp);
      if (!m || (onPage(comp) && !elsewhere(comp))) continue;
      const lk = compLook(comp);
      if (!isPending(lk)) continue;
      let group: PageGroup = 'Form';
      let away = '';
      try {
        group = groupOf(m);
        const t = targetOf(was);
        if (t && pl && routeTo(t, pl).by === 'here') {
          mine.push({ comp, main: m, group, visible: false, look: lk });
          continue;
        }
        away = awayTitle(app, m, t, was, { forms: loader.forms, appId: loader.appId });
      } catch (e) {
        if (__DEV__) console.error('[translator]', e);
      }
      out.push({ comp, main: m, group, visible: false, look: lk, away: away || WORKBENCH });
    }
    out.sort((a, b) => a.away!.localeCompare(b.away!) || a.main.path.join('\n').localeCompare(b.main.path.join('\n')) || a.main.order - b.main.order);
    return { mine, away: out };
  }

  /** Where a component's change was staged: the first of its staged slots' that is known (null: none). */
  function stagedOn(comp: string): Staged | null {
    for (const [k, p] of staged) if (p && store.get(k)?.comp === comp) return p;
    return null;
  }

  /**
   * Where on this page a component's change was made (null: it wasn't made on this page in translation mode). Another
   * record shown with the same form has the same tabs, related views and flyouts: the same place.
   */
  function spotHere(comp: string): Spot | null {
    const s = stagedOn(comp);
    const t = s && targetOf(s.page);
    const p = loader.page;
    return t && p && routeTo(t.to === 'form' ? { ...t, recordId: '' } : t, placeOf(p.info)).by === 'here' ? s.spot : null;
  }

  /**
   * A change made on another page whose label this page doesn't show: going back to where it was made beats looking for
   * it here (a column renamed through an associated view's header, then looked for from a form of its table, which
   * lists the column but shows it as a field's label at most). Shown here, it is found here.
   */
  function elsewhere(comp: string): boolean {
    const s = stagedOn(comp);
    return !!s && !!targetOf(s.page) && !spotHere(comp) && !scanner.of(comp).length;
  }

  /**
   * Where a label is on this page now, to come back to it (`a`: the label, null when it isn't shown): on a record page
   * the form tab or related view shown and the flyout the label is in (reveal.ts spotOf), else nothing.
   */
  function spotNow(a: Anchor | null): Spot {
    if (loader.page?.info.type !== 'entityrecord') return NOWHERE;
    return spotOf(selectedTab(), (k) => !!x?.names.has(k), a ? (a.zone ?? a.el) : null);
  }

  // ---- page tracking ----

  /** Rebuilds the index from the store and rescans the page (`nav`: right after the user went to another page). */
  function refresh(nav = false): void {
    refreshSoon.cancel();
    if (!on || waking) return;
    x = buildIndex(store, loader, ctx.xrm);
    choiceNotes.clear(); // counted on the new index's choices
    scanner.full(x);
    overlay.sync(scanner.list);
    preview.apply(scanner.list);
    want();
    reanchor(nav);
    repaint();
    checkLoad();
    const t = title();
    if (nav || t !== lastTitle) {
      lastTitle = t;
      emit('page');
    }
  }

  /** Called by the overlay with what changed on the page. */
  function mutated(roots: Node[], removed: boolean): void {
    if (!on || waking) return; // the form is being opened again: everything is scanned once it is back
    if (location.href !== href) {
      href = location.href;
      navSoon(); // UCI navigates without reloading
    }
    const got = scanner.update(roots, removed);
    if (scanner.changed) {
      overlay.sync(scanner.list);
      reanchor();
      itemsCache = null;
      emitSoon();
    }
    if (got.length) preview.apply(got); // also re-applies where Dynamics re-rendered a label
    want();
  }

  /**
   * Starts over when the user is on another page (record, form, view, dashboard): a new index right away (the
   * page's own, never the previous one's), then the open popup follows its label, stays (the same form on
   * another record), or closes with its page (see reanchor).
   */
  function navigate(): boolean {
    if (waking) return false;
    if (!loader.sync()) {
      // Another process on the same record: the previous one's name, stages and steps leave the list (sync() has
      // asked for a new index, which no longer holds them).
      const was = loader.switchedFrom;
      if (was) scanner.forget(ofProcess(was));
      wake(); // a form that showed its labels only after the start
      return false;
    }
    preview.restore();
    scanner.reset();
    overlay.sync([]);
    stopFind(); // a find gone to this page (trip) goes on: it waits for this page's index
    if (!wake()) refresh(true);
    return true;
  }

  /**
   * A record form whose form API is empty after a cold boot (LIVE-FINDINGS 51) is opened again once, before it is
   * scanned; its loads have started and keep running meanwhile. Checked once per page, as soon as the form shows
   * labels, and never under an open popup. True when the repair started (the scan follows it).
   */
  function wake(): boolean {
    const p = loader.page;
    if (waking || cur || !p || p.info.type !== 'entityrecord' || coldChecked.has(p.sig)) return false;
    const f = coldForm(ctx.xrm, p);
    if (!f.rendered) return false; // not drawn yet: the next tick looks again
    coldChecked.add(p.sig);
    if (coldStep(f) !== 'reopen') return false;
    waking = true;
    checkLoad(); // "Loading translations…"
    // While waking nothing follows navigation (mutated, navigate): the page must still be this record and form.
    const href0 = location.href;
    const still = (): boolean => {
      if (!on || cur || location.href !== href0) return false;
      const i = pageInfo(ctx.xrm);
      return i.type === 'entityrecord' && i.entity === f.entity && i.recordId === f.id && (!f.formId || formOf(ctx.xrm, i) === f.formId);
    };
    void wakeForm(ctx.xrm, f, { still })
      .catch(() => false)
      .then((ok) => {
        waking = false;
        if (!on) return;
        if (ok) loader.subgrids(); // the form API knows the sub-grids again
        // Dirty or still empty: the page is scanned from the DOM, and fieldOf refuses what it can't place.
        if (!navigate()) refresh(true);
      });
    return true;
  }

  /** What the page shows but the store lacks: command bar buttons, tables of grids (sub-grids, linked tables). */
  function want(): void {
    if (!scanner.want.size) return;
    const a = [...scanner.want];
    scanner.want.clear();
    loader.request(a);
  }

  /**
   * Keeps the open popup on its label when Dynamics re-renders it, and puts a docked one back next to its label
   * when that shows up (a lazily rendered field, another tab, the same form on another record). A label that went
   * away without a page change leaves it open: closing it would drop the user's place. It stays where the label was
   * when that was in a menu or flyout that closed as the popup took the focus or a click (rectFor), else it docks (a
   * grid row scrolled away). After a page change, one that doesn't belong to the new page closes; what was typed in
   * it stays staged for Publish.
   */
  function reanchor(nav = false): void {
    const st = cur;
    if (!st || st.closed) return;
    if (st.a && scanner.list.includes(st.a)) return; // never after a page change: the scanner starts over
    const main = x?.main.get(st.comp)?.key ?? st.want;
    const at = st.at;
    // The copy nearest to where the label was (one on screen, when it never was).
    const rank = (z: Anchor): number => {
      const r = overlay.rectOf(z);
      return !r ? 1e9 : at ? Math.hypot(r.left - at.left, r.top - at.top) : 0;
    };
    const had = st.a;
    const b = again(scanner.of(st.comp), st.a ?? st.was, st.want, main, rank);
    if (b) {
      st.a = st.was = b;
      st.near = null;
      overlay.active(st.comp, b);
      overlay.invalidate(2);
      // Docked until its label showed, or kept open on another page: what is typed now is staged where it is now.
      if (!had || nav) st.spot = spotNow(b);
      if (!had) st.c?.refresh(); // what it shows can depend on the label (e.g. the choice a value shows)
      return;
    }
    if (st.a) st.was = st.a;
    st.a = null;
    overlay.active(st.comp, null);
    if (!st.near || !scanner.list.includes(st.near)) st.near = nearOf(st.comp, st.want, false);
    if (nav && !onPage(st.comp)) closeCallout(st);
    else {
      if (nav) st.spot = spotNow(null); // kept open, docked, on another page of its label: that page
      overlay.invalidate(2);
    }
  }

  function checkLoad(): void {
    loadSoon.cancel();
    const s = `${loading()}|${notes()
      .map((n) => n.text)
      .join('\n')}`;
    if (s === loadSig) return;
    loadSig = s;
    emit('loading');
  }

  function syncPrefs(): void {
    const p = app.prefs;
    const sig = [p.target, p.shown.join()].join('|');
    if (sig === prefsSig) return;
    const first = !prefsSig;
    prefsSig = sig;
    repaint();
    if (!first) cur?.c?.refresh();
  }

  // ---- opening popups ----

  const isOurs = (n: Node): boolean => n.getRootNode() === app.root;
  const tabNameOf = (a: Anchor): string => store.get(a.key)?.ref?.tabName || (a.el.getAttribute('data-id') || '').replace(/^tablist-/, '');

  /**
   * Not known to be another form's tab: the tab API is the page form's, and a side pane's form may have a tab of that
   * name.
   */
  function pageTab(a: Anchor): boolean {
    const f = String(store.get(a.key)?.ref?.formId || '').toLowerCase();
    const p = (loader.page?.formId || '').toLowerCase();
    return !paneOf(a.el) && (!f || !p || f === p);
  }

  /**
   * Shows a form tab: Dynamics' tab API for the page form's tabs, else (a side pane's or a dashboard's tab, a tab list
   * a cold boot left empty) a click on the tab: `a` while it is on the page, else a copy of it in the same form that is
   * (the tab bar's for a "More tabs" item). False when neither can.
   */
  function showTab(name: string, a?: Anchor): boolean {
    if (!name) return false;
    const page = !a || pageTab(a);
    if (page && focusTab(ctx.xrm, name)) return true;
    const comp = a?.comp ?? x?.names.get(`t:${name}`.toLowerCase())?.comp ?? '';
    const t = [...(a ? [a] : []), ...scanner.of(comp)].find((z) => z.role === 'tab' && (z.zone ?? z.el).isConnected && (z === a || !paneOf(z.el) === page));
    if (!t) return false;
    clickPage(t.zone ?? t.el);
    return true;
  }

  /** The label is rendered (on screen or scrolled away), not hidden (another tab, collapsed or hidden section). */
  const rendered = (a: Anchor): boolean => a.el.isConnected && (!a.el.checkVisibility || a.el.checkVisibility({ checkVisibilityCSS: true }));

  /**
   * The best of these anchors: one the overlay shows now, else one rendered off screen (scrolled into view with
   * `scroll`: that shows the label, it changes nothing on the page), else a hidden one. `shown`: not hidden;
   * `scrolled`: it was scrolled into view just now (the overlay measures it again in the next frames).
   */
  function choose(as: readonly Anchor[], scroll: boolean): { a: Anchor | null; shown: boolean; scrolled: boolean } {
    const vis = as.find((a) => overlay.rectOf(a));
    if (vis) return { a: vis, shown: true, scrolled: false };
    const r = as.find(rendered);
    if (!r) return { a: as[0] ?? null, shown: false, scrolled: false };
    if (scroll) {
      (r.zone ?? r.el).scrollIntoView({ block: 'center', inline: 'nearest' });
      overlay.invalidate(6);
    }
    return { a: r, shown: true, scrolled: scroll };
  }

  /**
   * A label to place a popup next to when its own text isn't shown: another text of the component (the table's
   * plural name on a sitemap entry), else the field that shows the column it is about (a column's tooltip and
   * name, its choices), else that column's header in a list.
   */
  function nearOf(comp: string, want: string, scroll: boolean): Anchor | null {
    const main = x?.main.get(comp)?.key ?? want;
    const own = new Set(showing(scanner.of(comp), want, main));
    let as = scanner.of(comp).filter((a) => !own.has(a));
    const col = as.length || !x ? '' : columnOn(x.main.get(comp), x.entity);
    if (col) as = [...(x!.cells.get(col) || []).flatMap((c) => scanner.of(c.comp)), ...(comp.startsWith('attribute|') ? [] : scanner.of(`attribute|${x!.entity}.${col}`))];
    return choose(as, scroll).a;
  }

  /**
   * Where to open a component: the clicked element's anchor, else one showing the slot asked for (`want`) or
   * its label, chosen by `choose`. `near` places it when none does.
   */
  function pick(comp: string, want: string, from: Element | undefined, scroll: boolean): { a: Anchor | null; shown: boolean; scrolled: boolean; near: Anchor | null } {
    const as = scanner.of(comp);
    if (from && !isOurs(from)) {
      const hit = as.find((a) => a.el === from || a.zone === from || (a.zone ?? a.el).contains(from));
      if (hit) return { a: hit, shown: true, scrolled: false, near: null };
    }
    const c = choose(showing(as, want, x?.main.get(comp)?.key ?? want), scroll);
    return { ...c, near: c.a ? null : nearOf(comp, want, scroll) };
  }

  /** Stops a find waiting on this page for its label (after opening its tab, flyout or stage). */
  function stopFind(): void {
    clearTimeout(waitT);
    waitT = 0;
    waitId++;
  }

  /** Stops any find still waiting: on this page, or gone to another page. */
  function cancelWait(): void {
    stopFind();
    clearTimeout(tripT);
    tripT = 0;
    trip = null;
  }

  /**
   * Finds a change whose label isn't on this page on the page it was made on (reveal.ts targetOf): goes there with
   * Dynamics' navigation (routeTo, goTo), then, once that page's index and loads are in, back to where it was made on it
   * and finds it there as on any page (openComp, through the new page's index). Never navigates for a label of this page
   * or for a change that wasn't made on a page, never twice for one click (a second click on the same row while it goes
   * does nothing, unless the user kept the page it left: goAgain), never again from where it arrives. Another row (also
   * one with no page), a label clicked on the page, closing the list, the Workbench, one of our dialogs, another page
   * than the target or TRIP_WAIT cancel it. False when the change has no page to go to.
   */
  function goFind(comp: string, o: OpenOpts): boolean {
    const t = x?.main.has(comp) ? targetOf(stagedOn(comp)?.page) : null;
    if (!t) {
      cancelWait(); // another row's find, gone to its page, would open there over the editor
      closeCallout(); // the app's editor opens instead: what is typed there belongs to no page
      return false;
    }
    const p = loader.page;
    const go = routeTo(t, p ? placeOf(p.info) : null);
    // Its page is this one (a side pane's or a quick view's label not shown now): next to its row, as a hidden field.
    if (go.by === 'here') return openComp(comp, o);
    if (trip && trip.comp === comp && JSON.stringify(trip.target) === JSON.stringify(t) && !goAgain(trip, p?.sig ?? '', pageDialog(), Date.now())) return true;
    cancelWait();
    overlay.pulse(null);
    closeCallout(); // what was typed stays staged; the page it belongs to is going away
    const tr: Going = { comp, o, target: t, from: p?.sig ?? '', until: Date.now() + TRIP_WAIT, since: 0 };
    trip = tr;
    // Refused (its promise rejected, e.g. the user kept the unsaved changes): nothing opens.
    if (!goTo(ctx.xrm, go, () => trip === tr && cancelWait())) {
      trip = null;
      return openComp(comp, o); // no navigation API, or a form the user can't open here: next to its row
    }
    tripT = window.setTimeout(tripPoll, TRIP_EVERY);
    return true;
  }

  /** Looks at the page for a find gone to another page: follows the page at once, then waits, finds or gives up (tripStep). */
  function tripPoll(): void {
    tripT = 0;
    const tr = trip;
    if (!tr || !on || paused) return;
    try {
      // One of our dialogs (the Publish dialog): an edit started now would be lost by its save, as app.edit says.
      if (modalOpen()) return cancelWait();
      navigate(); // the page tracker's tick would see the new page only within a second
      if (trip !== tr) return;
      const p = loader.page;
      const step = tripStep(tr, { place: p ? placeOf(p.info) : null, sig: p?.sig ?? '', ready: tripReady(), found: scanner.of(tr.comp).length > 0 }, Date.now());
      if (step === 'wait') {
        tripT = window.setTimeout(tripPoll, TRIP_EVERY);
        return;
      }
      trip = null;
      // Its list row keeps its element on the new page (pagelist.ts): the popup opens next to it when the label doesn't show.
      if (step === 'find') openComp(tr.comp, tr.o, true);
    } catch (e) {
      if (__DEV__) console.error('[translator]', e);
      if (trip === tr) cancelWait(); // never a find left that no poll follows (a second click would wait on it)
    }
  }

  /** The page's index and loads are in (none running, not waking a cold form) and a record form has rendered. */
  function tripReady(): boolean {
    const p = loader.page;
    if (!p || !x || x.stale || loading()) return false;
    return p.info.type !== 'entityrecord' || coldForm(ctx.xrm, p).rendered;
  }

  /**
   * Opens a component asked for by the list or the Publish dialog's Fix after finding its label (reveal.ts). A change
   * made on this page in translation mode is looked for where it was made (goBack: its form tab or related view, the
   * flyout its label was in) when its label doesn't show, and after coming back from another page (`back`) whatever
   * shows. Else one the page renders is scrolled into view; one it doesn't is shown by opening what hides it (its form
   * tab, the header's flyout, its process stage) and waited for (find). The label found pulses and the popup points at
   * it; one the form hides, or that doesn't show up in time, opens next to the list row (else docked).
   */
  function openComp(comp: string, o: OpenOpts, back = false): boolean {
    cancelWait();
    overlay.pulse(null); // the label found before
    const want = o.focus || x?.main.get(comp)?.key || '';
    const p = back ? null : pick(comp, want, o.from, true);
    const s = p?.a && p.shown ? null : spotHere(comp);
    if (s && backTo(s, selectedTab(), flyouts(s)).by !== 'none') return goBack(comp, o, want, s);
    return find(comp, o, want, p ?? pick(comp, want, o.from, true));
  }

  /** Whether the flyouts a place names are open (the header's, its stage's). */
  const flyouts = (s: Spot): { header: boolean; stage: boolean } => ({ header: s.header && headerOpen(), stage: !!s.stage && !!stageFlyout(s.stage) });

  /**
   * Brings back where a change was made on this page before finding its label there (reveal.ts backStep: its form tab
   * or related view, then the flyout its label was in), looking at the page every 100 ms. Anything that stops a find
   * stops it (stopFind), and so does one of our dialogs (the Publish dialog).
   */
  function goBack(comp: string, o: OpenOpts, want: string, s: Spot): boolean {
    closeCallout(); // its label is about to be shown
    const id = ++waitId;
    const b: Back = { left: s, t0: Date.now(), done: new Set(), at: 0, since: 0 };
    const poll = (): void => {
      waitT = 0;
      if (id !== waitId || !on || paused) return;
      if (modalOpen()) return cancelWait();
      const sh = pick(comp, want, undefined, false);
      const now = { tab: selectedTab(), ...flyouts(b.left), found: !!sh.a && sh.shown, ready: !!x && !x.stale && !loading() };
      if (backStep(b, now, Date.now(), openFor) === 'wait') {
        waitT = window.setTimeout(poll, 100);
        return;
      }
      find(comp, o, want, pick(comp, want, o.from, true));
    };
    poll();
    return true;
  }

  /** Finds a label on the page as it is (`p`: what pick found): see openComp. */
  function find(comp: string, o: OpenOpts, want: string, p: ReturnType<typeof pick>): boolean {
    // Once the overlay has measured the page again: the label (found) or, when it didn't show up, the row.
    const land = (id: number): void =>
      afterPaint(id, () => {
        const b = pick(comp, want, undefined, false);
        if (b.a && b.shown) found(comp, b.a, o);
        else present(comp, b.a, o, b.near);
      });
    if (p.a && p.shown) {
      if (!p.scrolled) return found(comp, p.a, o);
      land(++waitId);
      return true;
    }
    const m = x?.main.get(comp);
    const rc = revealCtx();
    const how = m ? revealOf(m, rc) : NOTHING;
    if (how.by === 'none') return present(comp, p.a, o, p.near);
    closeCallout(); // its label is about to be shown
    // A field further down a tab is drawn only once it comes into view (LIVE-FINDINGS 96): its place is brought there,
    // on the tab shown at once, on another tab as soon as that tab has put it on the page.
    const place = m && (how.by === 'render' || how.by === 'tab') ? bodyPlace(m, rc) : null;
    let brought: Element | null = null;
    const bring = (): boolean => {
      const el = place && placeholder(place);
      if (el && el !== brought) {
        brought = el;
        el.scrollIntoView({ block: 'center' });
      }
      return !!el;
    };
    if (!(how.by === 'render' ? bring() : openFor(how))) return present(comp, p.a, o, p.near);
    const id = ++waitId;
    const until = Date.now() + REVEAL_WAIT;
    const poll = (): void => {
      waitT = 0;
      if (id !== waitId || !on || paused) return;
      const b = pick(comp, want, undefined, true);
      if (!(b.a && b.shown) && Date.now() < until) {
        bring();
        waitT = window.setTimeout(poll, 100);
        return;
      }
      // Drawing it drew the fields around it too, which moved it: it is put back in the middle.
      if (brought && b.a) (b.a.zone ?? b.a.el).scrollIntoView({ block: 'center' });
      land(id);
    };
    waitT = window.setTimeout(poll, 100);
    return true;
  }

  /** Runs `fn` once the overlay has measured the page again (two frames), unless something else was opened meanwhile. */
  function afterPaint(id: number, fn: () => void): void {
    overlay.invalidate(2);
    requestAnimationFrame(() => requestAnimationFrame(() => id === waitId && on && !paused && fn()));
  }

  /** Opens the popup at a label found for the user and pulses its mark. */
  function found(comp: string, a: Anchor, o: OpenOpts): boolean {
    present(comp, a, o);
    if (cur?.a === a) overlay.pulse(a);
    return true;
  }

  /** What reveal.ts needs of the page: the record form, its tab shown now, the active process, the form API. */
  function revealCtx(): RevealCtx {
    const p = loader.page;
    return {
      record: p?.info.type === 'entityrecord' && !!x && x.record && !x.stale,
      formId: x?.formId || '',
      bpfId: guid(p?.bpfId || ''),
      tab: selectedTab(),
      shows: (q) => formShows(ctx.xrm, q),
      quickHost: (id) => {
        for (const cells of x?.fields.values() ?? []) for (const s of cells) if (Array.isArray(s.ref?.quickForms) && s.ref.quickForms.includes(id)) return s;
        return undefined;
      },
      cellOf: (comp) => {
        const id = scanner.parts.get(comp);
        return id ? x?.fields.get(id)?.[0] : undefined;
      },
    };
  }

  /** Opens what hides a label: its form tab (Dynamics' tab API), a related view (the navigation API), the header's flyout, its process stage. */
  function openFor(r: Reveal): boolean {
    return r.by === 'tab' ? showTab(r.name) : r.by === 'nav' ? focusNav(ctx.xrm, r.id) : r.by === 'header' ? openHeader() : r.by === 'stage' ? openStage(r.stageId) : false;
  }

  /**
   * Opens the popup (the only one): anchored to `a`, else next to `near` or the list row it came from, else
   * docked above the bar. A docked one moves next to its label as soon as that is shown (reanchor).
   */
  function present(comp: string, a: Anchor | null, o: OpenOpts, near: Anchor | null = null): boolean {
    cancelWait();
    closeCallout();
    const main = x?.main.get(comp)?.key;
    const st: Cur = {
      comp,
      want: o.focus || a?.key || main || '',
      a,
      near: a ? null : near,
      was: a,
      at: null,
      menu: false,
      row: o.from && isOurs(o.from) ? o.from : null,
      by: null,
      c: null,
      action: '',
      subject: null,
      spot: spotNow(a),
      keys: new Set(),
      off: () => {},
      closed: false,
    };
    const host: CalloutHost = {
      model: () => {
        // The label it last pointed at, once that went away (a menu that closed): the content and action stay.
        const on = st.a ?? st.was;
        const m = describe(app, st.comp, on ?? undefined);
        st.action = m.action ?? '';
        st.subject = on;
        st.keys = modelKeys(m);
        return m;
      },
      rect: () => rectFor(st),
      beside: () => st.by,
      focusLcid: o.lcid,
      focusKey: o.focus ?? a?.focus ?? (a && main && a.key !== main ? a.key : undefined),
      action: () => act(st),
      // Done, ✕, Esc, Enter or a click outside: what was typed stays staged in the store.
      close: () => closeCallout(st),
      // Its label was an item of a selector's list, gone with it: the keyboard goes on from that list's button.
      refocus: () => focusOpener((st.a ?? st.was)?.sw, { find: pageFind }),
    };
    cur = st;
    try {
      st.c = openCallout(app, host);
    } catch (e) {
      if (__DEV__) console.error('[translator]', e);
      if (cur === st) cur = null;
      st.closed = true;
      fallback(comp, o.lcid);
      return true;
    }
    if (st.closed) return true; // it closed itself while opening
    // Only the label it points at keeps the hover look, never the other labels of the component.
    overlay.active(comp, st.a);
    st.off = overlay.onFrame(() => {
      if (cur === st) st.c?.reposition();
    });
    overlay.invalidate(2);
    return true;
  }

  /** The popup can't be built for this component: the app's own editor opens instead. */
  function fallback(comp: string, l?: Lcid): void {
    bypass = comp;
    try {
      app.edit(comp, l);
    } finally {
      bypass = '';
    }
  }

  function closeCallout(st: Cur | null = cur): void {
    if (!st || st.closed) return;
    st.closed = true;
    if (cur === st) cur = null;
    st.off();
    try {
      st.c?.destroy();
    } catch (e) {
      if (__DEV__) console.error('[translator]', e);
    }
    if (!cur) overlay.active(null);
  }

  /**
   * Where the popup points: its label while the overlay shows it and the list sheet's box doesn't cover it (docked or
   * floating: rowAnchor), else its list row, else a label near it (the field of a column), else where its label was
   * when that left with its menu (restRect), else docked.
   */
  function rectFor(st: Cur): DOMRect | null {
    const a = st.a;
    const r = a ? overlay.rectOf(a) : null;
    if (a && r) {
      st.at = r;
      st.menu = inTransient(a.zone ?? a.el);
    }
    st.by = null;
    const row = st.row;
    const o = row?.isConnected ? rowAnchor(r, row, innerWidth) : null;
    if (o) {
      st.by = o.by;
      return o.at;
    }
    return r ?? restRect(st.near ? overlay.rectOf(st.near) : null, !a && st.menu, st.at);
  }

  /**
   * The popup's secondary action on the label it points at, else on the one the action was offered for (gone with the
   * menu that showed it). Closes the popup once it acted (what was typed stays staged) and says so; nothing done: it
   * stays open.
   */
  function act(st: Cur): boolean {
    if (st.closed || !st.action) return false;
    for (const a of new Set([st.a, st.subject]))
      if (a && runAction(st.action, a, actFx)) {
        closeCallout(st);
        return true;
      }
    return false;
  }

  /**
   * Clicks a page element for Dynamics (only navigation items, stages and tabs: never a command, a value or an
   * option, which could change data). The overlay lets synthetic clicks through to the page.
   */
  function clickPage(z: Element): void {
    const sel = 'button,a,[role="button"],[role="link"],[role="treeitem"],[role="menuitem"],[role="tab"]';
    const t = z.matches(sel) ? z : z.querySelector(sel) || z;
    (t as HTMLElement).click();
  }

  /** Page effects of the popup's secondary action (runAction). */
  const actFx: ActFx = {
    // The navigation API is the page form's: never for an item in a side pane.
    nav: (a, id) => !paneOf(a.el) && focusNav(ctx.xrm, id),
    tab: (a) => showTab(tabNameOf(a), a),
    click: (a) => {
      const z = a.zone ?? a.el;
      if (!z.isConnected) return false;
      clickPage(z);
      return true;
    },
    // Its flyout open already (it opened since the popup did): its fields show, done without a click.
    stage: (a) => {
      const id = guid(store.get(a.key)?.ref?.labelId);
      return (!!id && !!stageFlyout(id)) || actFx.click(a);
    },
    ...listActs(app, () => on),
  };

  /** The open popup moves to another label showing its text, and keeps what is typed. */
  function moveTo(st: Cur, a: Anchor): void {
    if (st.a !== a) {
      const had = st.a;
      st.a = st.was = a;
      st.spot = spotNow(a);
      st.near = null;
      st.row = null;
      overlay.active(st.comp, a);
      overlay.invalidate(2);
      if (!had) st.c?.refresh();
    }
    st.c?.reposition();
  }

  /**
   * A click (or F2) on a label on the page. The page is read first, as open() does: UCI draws the next page's labels before
   * the page tracker sees the navigation (navSoon, the tick), and a label scanned meanwhile was matched against the
   * previous page's index (its table's column of the same name). After a page change the label is the one the new page's
   * scan found on the same element; none there: nothing opens.
   */
  function onLabel(clicked: Anchor): void {
    if (!on || paused) return;
    const a = navigate() ? sameLabel(clicked, scanner.list) : clicked;
    if (!a) return;
    const st = cur && !cur.closed ? cur : null;
    clickLabel(a, st, {
      move: (b) => st && moveTo(st, b),
      open: (b) => present(b.comp, b, {}),
    });
  }

  // ---- counts, notes ----

  /**
   * The bar reads only the pending count: the list's counts are worked out when read, since items() goes through every
   * change staged on other pages (a bulk fill in the Workbench) and the bar asks after every keystroke.
   */
  const counts = (): ReturnType<PageMode['counts']> => {
    let c: ReturnType<typeof countLabels> | null = null;
    const all = () => (c ??= countLabels(items(), store));
    return {
      get all() {
        return all().all;
      },
      get missing() {
        return all().missing;
      },
      pending: store.pendingCount(),
    };
  };

  function loading(): boolean {
    return waking || loader.busy.size > 0;
  }

  function notes(): PageNote[] {
    // A form read in only some languages is a failed load too: Try again reads it again.
    return loadNotes(loader.errors.values(), () => loader.retry());
  }

  function title(): string {
    return pageTitle(app, loader.page, { forms: loader.forms, appId: loader.appId });
  }

  // ---- lifecycle ----

  function start(): void {
    if (on || destroyed) return;
    on = true;
    href = location.href;
    overlay.start();
    if (paused) overlay.pause(true);
    app.root.host.addEventListener('dxt-prefs', syncPrefs);
    // Form switches and process changes do not always touch the URL; prefs are polled as a fallback.
    tick = window.setInterval(() => {
      syncPrefs();
      navigate();
    }, 1000);
    prefsSig = '';
    syncPrefs();
    if (!navigate()) refresh();
  }

  function stop(): void {
    if (!on) return;
    cancelWait();
    closeCallout();
    on = false;
    clearInterval(tick);
    refreshSoon.cancel();
    navSoon.cancel();
    emitSoon.cancel();
    loadSoon.cancel();
    app.root.host.removeEventListener('dxt-prefs', syncPrefs);
    overlay.stop();
    preview.restore();
  }

  const mode: PageMode = {
    start,
    stop,
    destroy() {
      if (destroyed) return;
      stop();
      destroyed = true;
      loader.abort();
      offStore();
      subs.clear();
    },
    pause(v) {
      paused = v;
      if (!on) return;
      overlay.pause(v);
      if (v) {
        cancelWait();
        closeCallout(); // what was typed stays staged (the Workbench shows it)
        overlay.flash('');
      } else {
        overlay.invalidate(2);
        repaint(); // edits and publishes made in the Workbench meanwhile
      }
    },
    open(comp, o = {}) {
      if (!on || paused || !x || comp === bypass) return false;
      // The page as it is now: a click within a second of a navigation (a form switch keeps the URL) would otherwise be
      // decided on the page before, and a find gone from there would take this one for another page and give up.
      navigate();
      // A label of this page is found here, never by navigating; a change made on another page where it was made there.
      return onPage(comp) && !elsewhere(comp) ? openComp(comp, o) : goFind(comp, o);
    },
    close: () => closeCallout(),
    cancelFind: () => cancelWait(),
    items,
    counts,
    loading,
    notes,
    title,
    flash: (comp) => overlay.flash(comp),
    on(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
  // Dev builds only: the live page suite (tools/e2e-page.js) reads what the scanner anchored and clicks it.
  if (__DEV__) Object.assign(mode, { dev: { anchors: () => scanner.list, index: () => x, loader, overlay } });
  return mode;
};
