// Finding a label for "All labels on this page" (and the Publish dialog's Fix): what to open so the page renders it —
// its form tab, the header's flyout, its process stage — when that changes nothing but the view. Never a menu (More
// tabs, the related menu, the command overflow close as soon as the popup takes the focus) and never anything on the
// record. A change made on a page in translation mode is found where it was made: the page it was made on, how to get
// there with Dynamics' own navigation, when the page shown has become that page (mode.ts goFind), then the place on it
// (its form tab or related view, the flyout its label was in; mode.ts goBack).

import type { PageInfo } from '../core/context';
import { guid } from '../core/http';
import type { Slot } from '../core/model';
import { closestDeep, flyoutStage, paneOf } from './scan';

/**
 * What to open so the page renders a label. `render`: a field or section of the tab shown that Dynamics hasn't drawn
 * yet (it draws a tab's fields as they come into view, LIVE-FINDINGS 96): its place is brought into view. `nav`: a
 * related view (an associated grid opened from the Related menu), by its nav id (only to go back to where a change was
 * made, backStep).
 */
export type Reveal = { by: 'none' } | { by: 'tab'; name: string } | { by: 'render' } | { by: 'header' } | { by: 'stage'; stageId: string } | { by: 'nav'; id: string };
export const NOTHING: Reveal = { by: 'none' };

/** What revealOf needs of the page (mode.ts revealCtx). */
export interface RevealCtx {
  /** A record page whose index is current (not stale). */
  record: boolean;
  /** The page form's id (guid()). */
  formId: string;
  /** The record's active process (guid(), '' none). */
  bpfId: string;
  /** The form tab shown now (selectedTab), '' unknown. */
  tab: string;
  /** formShows on the page's form API. */
  shows(q: FormQuery): boolean | undefined;
  /** The page form's quick view control cell that shows quick view form `id` (lower case). */
  quickHost(id: string): Slot | undefined;
  /** The page form's cell that shows a composite column's sub-field (an address's street; `comp`: the column's). */
  cellOf(comp: string): Slot | undefined;
}

/** A tab, a section of it, a control (in that section) of the page form, by their names in the form XML. */
export interface FormQuery {
  tab?: string;
  section?: string;
  ctl?: string;
}

/**
 * What to open so the page renders a label it doesn't render now. A process step: its stage's flyout (the active
 * process's only). A form field or section of the page form (a quick view field: its quick view control's, a composite
 * column's sub-field: its composite control's) on another tab: that tab, unless the form hides the tab, the section or
 * the control. A header field: the header's flyout, unless the form hides it. Anything else (a tab's own label, which is
 * in the tab bar or in "More tabs", navigation, choices, commands, footer fields, a side pane's fields), and a label on
 * the tab shown (hidden there): nothing.
 */
export function revealOf(m: Slot, c: RevealCtx): Reveal {
  if (!c.record) return NOTHING;
  if (m.kind === 'step') {
    const r = m.ref || {};
    return c.bpfId && guid(r.workflowId) === c.bpfId && r.stageId ? { by: 'stage', stageId: guid(r.stageId) } : NOTHING;
  }
  // A composite column's sub-field (Street 1 of an address) shows in its composite control's cell.
  let mm = m;
  if (m.kind === 'attribute') {
    const c0 = c.cellOf(m.comp);
    if (!c0) return NOTHING;
    mm = c0;
  }
  if (mm.kind !== 'field' && mm.kind !== 'section') return NOTHING;
  const r = mm.ref || {};
  // A quick view form's field shows where the page form's quick view control is; a side pane's form has none.
  const cell = guid(r.formId) === c.formId ? mm : mm.kind === 'field' ? c.quickHost(guid(r.formId)) : undefined;
  if (!cell) return NOTHING;
  const h = cell.ref || {};
  if (h.area === 'header') return cell === mm && h.controlId && c.shows({ ctl: String(h.controlId) }) !== false ? { by: 'header' } : NOTHING;
  if (h.area !== 'body' || !h.tabName) return NOTHING;
  const tab = String(h.tabName);
  const q: FormQuery = { tab, section: String(h.sectionName || ''), ...(cell.kind === 'field' && h.controlId ? { ctl: String(h.controlId) } : {}) };
  if (c.shows(q) === false) return NOTHING;
  // On the tab shown and not drawn yet: Dynamics draws it once it comes into view.
  return tab.toLowerCase() === c.tab.toLowerCase() ? { by: 'render' } : { by: 'tab', name: tab };
}

/**
 * Where a label's field or section sits on the page form's body (its section and control names; a composite column's
 * sub-field: its composite control, a quick view field: its quick view control), to bring a part of a tab Dynamics
 * hasn't drawn yet into view; null for anything else.
 */
export function bodyPlace(m: Slot, c: RevealCtx): FormQuery | null {
  const mm = m.kind === 'attribute' ? c.cellOf(m.comp) : m;
  if (!mm || (mm.kind !== 'field' && mm.kind !== 'section')) return null;
  const r = mm.ref || {};
  const cell = guid(r.formId) === c.formId ? mm : mm.kind === 'field' ? c.quickHost(guid(r.formId)) : undefined;
  const h = cell?.ref || {};
  if (!cell || h.area !== 'body') return null;
  return { section: String(h.sectionName || ''), ...(cell.kind === 'field' && h.controlId ? { ctl: String(h.controlId) } : {}) };
}

/** Names used in an attribute selector as they are (form XML control and section names are word characters). */
const PLAIN = /^[\w.-]+$/;

/**
 * The page form's element for a field Dynamics hasn't drawn yet: its place in its section (`div[data-id="<control>"]`,
 * empty until the field comes into view, LIVE-FINDINGS 96) or its container once drawn, else the section itself; never
 * a side pane's. Null when the page has neither.
 */
export function placeholder(q: FormQuery, root: ParentNode = document): Element | null {
  const ctl = q.ctl && PLAIN.test(q.ctl) ? q.ctl : '';
  const sec = q.section && PLAIN.test(q.section) ? q.section : '';
  const page = (sel: string, in_: ParentNode = root): Element | null => [...in_.querySelectorAll(sel)].find((el) => !paneOf(el)) ?? null;
  const section = sec ? page(`section[data-id="${sec}"]`) : null;
  if (ctl) {
    // Inside its section only: grids elsewhere use column names as data-ids too.
    const el = section ? page(`[data-id="${ctl}"],[data-id="${ctl}-FieldSectionItemContainer"]`, section) : page(`[data-id="${ctl}-FieldSectionItemContainer"]`);
    if (el) return el;
  }
  return section;
}

/**
 * Whether the page form shows a tab, a section of it, a control (in that section): getVisible of the form API, where
 * every copy of a control counts (`<id>`, `<id>1`…, LIVE-FINDINGS 41). Undefined when it can't tell (cold boot, a form
 * being replaced, a quick view's control, which isn't in ui.controls).
 */
export function formShows(xrm: any, q: FormQuery): boolean | undefined {
  try {
    const ui = xrm.Page.ui;
    if (q.tab) {
      const t = ui.tabs.get(q.tab);
      if (!t) return undefined;
      if (t.getVisible() === false) return false;
      const s = q.section ? t.sections.get(q.section) : null;
      if (s && s.getVisible() === false) return false;
    }
    if (!q.ctl) return true;
    const id = q.ctl.toLowerCase();
    const sec = (q.section || '').toLowerCase();
    const cs = (ui.controls.get() as any[]).filter((c) => {
      const n = String(c.getName()).toLowerCase();
      return (n === id || (n.startsWith(id) && /^\d+$/.test(n.slice(id.length)))) && (!sec || String(c.getParent()?.getName() ?? '').toLowerCase() === sec);
    });
    return cs.length ? cs.some((c) => c.getVisible() !== false) : undefined;
  } catch {
    return undefined;
  }
}

/** The page form's tab shown now (its name), '' when none is marked selected. A side pane's tabs don't count. */
export function selectedTab(root: ParentNode = document): string {
  for (const el of root.querySelectorAll('li[role="tab"][aria-selected="true"][data-id^="tablist-"]')) if (!paneOf(el)) return (el.getAttribute('data-id') || '').slice(8);
  return '';
}

/**
 * A process stage's flyout (`…processHeaderStageFlyoutContainer_<stage id>`, LIVE-FINDINGS 64) while it shows: its
 * fields are on the page, and a click on the stage's chip would close it. Null when it is closed or hidden.
 */
export function stageFlyout(stageId: string, root: ParentNode = document): Element | null {
  if (!/^[\da-f-]{36}$/i.test(stageId)) return null;
  const f = root.querySelector(`[id$="processHeaderStageFlyoutContainer_${stageId}" i]`);
  return f && (!f.checkVisibility || f.checkVisibility()) ? f : null;
}

/**
 * Opens a process stage's flyout (its steps): a click on its chip's button, only while that flyout is closed (a second
 * click closes it). False when the page shows no such chip.
 */
export function openStage(stageId: string, root: ParentNode = document): boolean {
  if (!/^[\da-f-]{36}$/i.test(stageId)) return false;
  const chip = [...root.querySelectorAll(`li[id$="processHeaderStage_${stageId}" i]`)].find((el) => !paneOf(el));
  if (!chip || stageFlyout(stageId, root)) return false;
  (chip.querySelector<HTMLElement>('button') ?? (chip as HTMLElement)).click();
  return true;
}

/** The header strip's expand button (the chevron after its fields). */
const HEADER_BUTTON = '[data-id="headerFieldsExpandButton"],button[id$="headerFieldsExpandButton"]';

/** Matches in `root` and in the open shadow roots of the header strip (`uci-header-control-list`) in it. */
function deep(root: ParentNode, sel: string): Element[] {
  const out = [...root.querySelectorAll(sel)];
  for (const h of root.querySelectorAll('uci-header-control-list')) if (h.shadowRoot) out.push(...h.shadowRoot.querySelectorAll(sel));
  return out;
}

/** The header's flyout (LIVE-FINDINGS 86). */
const HEADER_FLYOUT = '[data-id="headerFieldsFlyout"]';

/** The header's flyout is open. */
export const headerOpen = (root: ParentNode = document): boolean => !!root.querySelector(HEADER_FLYOUT);

/** Opens the header's flyout (the header fields that don't fit in the strip): a click on its expand button, only while it is closed. */
export function openHeader(root: ParentNode = document): boolean {
  if (headerOpen(root)) return false;
  const b = deep(root, HEADER_BUTTON).find((el) => !paneOf(el));
  if (!b || b.getAttribute('aria-expanded') === 'true') return false;
  (b as HTMLElement).click();
  return true;
}

// ---- labels on other pages ----

/** A page of the app as the page tracker knows it (PageLoader.page): where a label was staged, or the page shown. */
export type Place = Pick<PageInfo, 'type' | 'entity' | 'recordId' | 'formId' | 'viewId' | 'viewType' | 'dashboardId'>;

/** A page's place (`i`: PageLoader.page.info, whose formId is the form shown, formOf). */
export const placeOf = (i: PageInfo): Place => ({ type: i.type, entity: i.entity, recordId: i.recordId, formId: i.formId, viewId: i.viewId, viewType: i.viewType, dashboardId: i.dashboardId });

/** The page a label lives on: a form of a record (`recordId` '': a new record's), a list with its view, a dashboard. */
export type Target =
  | { to: 'form'; entity: string; formId: string; recordId: string }
  | { to: 'list'; entity: string; viewId: string; viewType: PageInfo['viewType'] }
  | { to: 'dashboard'; dashboardId: string };

/**
 * Where a change lives, to find it from another page: the page it was made on in translation mode (`staged`), exactly:
 * that form of that record (a new record's form when it was made on one), that list with that view, that dashboard.
 * Null for a change made anywhere else (the Workbench, an import, the editor, a page of no record, list or dashboard):
 * nowhere to go, it opens next to its row or in the editor.
 */
export function targetOf(staged: Place | null | undefined): Target | null {
  const p = staged;
  if (p?.type === 'entityrecord' && p.entity) return { to: 'form', entity: p.entity, formId: p.formId, recordId: p.recordId };
  if (p?.type === 'entitylist' && p.entity) return { to: 'list', entity: p.entity, viewId: p.viewId, viewType: p.viewType };
  if (p?.type === 'dashboard' && p.dashboardId) return { to: 'dashboard', dashboardId: p.dashboardId };
  return null;
}

// ---- the place on its page ----

/** Where on its page a change was made in translation mode, to go back to exactly there (mode.ts goBack). */
export interface Spot {
  /** The record form's tab shown then ('' none known, not a record page, or a related view was shown). */
  tab: string;
  /** The related view shown then instead (an associated grid opened from the Related menu, LIVE-FINDINGS 88): its nav id. */
  nav: string;
  /** Its label was in the header's flyout. */
  header: boolean;
  /** Its label was in a process stage's flyout: that stage's id ('' none). */
  stage: string;
}
export const NOWHERE: Spot = { tab: '', nav: '', header: false, stage: '' };

/** The flyout a label (`el`, its element) is in: the header's, a process stage's; none in a side pane, or with no label. */
export function flyoutOf(el: Element | null): Pick<Spot, 'header' | 'stage'> {
  if (!el || paneOf(el)) return { header: false, stage: '' };
  const st = flyoutStage(el);
  return st ? { header: false, stage: guid(st.id) } : { header: !!closestDeep(el, HEADER_FLYOUT), stage: '' };
}

/**
 * Where a label is on its record page now: the tab shown (`tab`, selectedTab), a related view's when the page form has
 * no tab of that name and it is a nav id (`known`: the page index has that name, 't:<tab>' / 'n:<nav item>'), and the
 * flyout its element (`el`; null: it isn't shown) is in.
 */
export function spotOf(tab: string, known: (name: string) => boolean, el: Element | null): Spot {
  const t = tab.toLowerCase();
  const nav = !!t && !known(`t:${t}`) && (/^nav/.test(t) || known(`n:${t}`));
  return { tab: nav ? '' : tab, nav: nav ? tab : '', ...flyoutOf(el) };
}

/**
 * What to open next to bring a Spot back, the page showing `tab` (selectedTab) and these flyouts: its form tab or
 * related view first, then the flyout its label was in; nothing once the page shows all of it.
 */
export function backTo(s: Spot, tab: string, open: { header: boolean; stage: boolean }): Reveal {
  const want = s.nav || s.tab;
  if (want && !same(want, tab)) return s.nav ? { by: 'nav', id: s.nav } : { by: 'tab', name: s.tab };
  if (s.header && !open.header) return { by: 'header' };
  if (s.stage && !open.stage) return { by: 'stage', stageId: s.stage };
  return NOTHING;
}

/** Bringing back where a change was made, before its label is found there (mode.ts goBack). */
export interface Back {
  /** What is still to bring back (a part that can't be opened, or never shows, is left out). */
  left: Spot;
  /** When it started. */
  t0: number;
  /** The parts opened (each once: a second click would close a flyout), and when the last one was. */
  done: Set<Reveal['by']>;
  at: number;
  /** Since when the page has shown all of the place with its loads in (0: not yet). */
  since: number;
}

/** What backStep reads of the page now. */
export interface BackNow {
  /** The tab shown (selectedTab). */
  tab: string;
  /** The header's flyout, the Spot's stage flyout are open. */
  header: boolean;
  stage: boolean;
  /** The label shows. */
  found: boolean;
  /** The page's index and loads are in. */
  ready: boolean;
}

/** How long a part of a place (its tab or related view, its flyout) may take to show once opened before it is left out. */
export const BACK_PART = 2500;
/** How long the place may show with the page's loads in before its label is looked for anyway (a grid draws late). */
export const BACK_SETTLE = 1500;
/** How long bringing a place back may take before its label is looked for anyway. */
export const BACK_WAIT = 8000;

/**
 * The next step of bringing back where a change was made. Opens (`open`, Dynamics' own APIs: the form's tab, the
 * related view through the navigation API, a click on the header's or the stage's expand button) its form tab or
 * related view, then, once that shows, the flyout its label was in: each part once, and one that can't be opened or
 * doesn't show within BACK_PART is left out. 'wait': a part is on its way, or the label isn't drawn yet. 'find': the
 * place shows and so does the label, or the place has shown with the page's loads in for BACK_SETTLE, or BACK_WAIT
 * is over (the find on the page decides then: another tab, the header's flyout, its stage, a field brought into view,
 * else next to its row).
 */
export function backStep(b: Back, n: BackNow, now: number, open: (r: Reveal) => boolean): 'wait' | 'find' {
  if (now - b.t0 >= BACK_WAIT) return 'find';
  for (;;) {
    const r = backTo(b.left, n.tab, { header: n.header, stage: n.stage });
    if (r.by === 'none') break;
    if (!b.done.has(r.by)) {
      b.done.add(r.by);
      b.at = now;
      if (open(r)) return 'wait';
    } else if (now - b.at < BACK_PART) return 'wait';
    b.left = r.by === 'tab' || r.by === 'nav' ? { ...b.left, tab: '', nav: '' } : r.by === 'header' ? { ...b.left, header: false } : { ...b.left, stage: '' };
  }
  if (n.found) return 'find';
  if (!n.ready) b.since = 0;
  else if (!b.since) b.since = now;
  return b.since && now - b.since >= BACK_SETTLE ? 'find' : 'wait';
}

/** How to get from the page shown to a label's page (routeTo). */
export type Go =
  | { by: 'here' }
  | { by: 'switch'; entity: string; recordId: string; formId: string }
  | { by: 'open'; entity: string; recordId: string; formId: string }
  | { by: 'list'; entity: string; viewId: string; viewType: PageInfo['viewType'] }
  | { by: 'dashboard'; dashboardId: string };
const HERE: Go = { by: 'here' };
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * How to go to a label's page from the page shown (`p`). 'here': it is this page (its form on this record, or on any
 * record of its table when the target names none; its list with its view; its dashboard). 'switch': another form of
 * this record (the form selector keeps the record). 'open': another record or table (openForm, a new record's form when
 * the target names no record). 'list', 'dashboard': navigateTo.
 */
export function routeTo(t: Target, p: Place | null): Go {
  switch (t.to) {
    case 'form':
      if (p?.type === 'entityrecord' && same(p.entity, t.entity) && (!t.recordId || t.recordId === p.recordId))
        return !t.formId || t.formId === p.formId ? HERE : { by: 'switch', entity: t.entity, recordId: p.recordId, formId: t.formId };
      return { by: 'open', entity: t.entity, recordId: t.recordId, formId: t.formId };
    case 'list':
      return p?.type === 'entitylist' && same(p.entity, t.entity) && (!t.viewId || t.viewId === p.viewId) ? HERE : { by: 'list', entity: t.entity, viewId: t.viewId, viewType: t.viewType };
    case 'dashboard':
      return p?.type === 'dashboard' && p.dashboardId === t.dashboardId ? HERE : { by: 'dashboard', dashboardId: t.dashboardId };
  }
}

/**
 * Goes to a label's page with Dynamics' own navigation, on the page's Xrm (never a side pane's): another form of the
 * record through its form selector (else openForm), a record's form through openForm (a new record's form when no
 * record is known: nothing is saved unless the user saves), a list or a dashboard through navigateTo. Dynamics asks
 * first when the form has unsaved changes; this never gets around that. `failed`: the navigation was refused (its
 * promise rejected). False when the page has no such API, or the form selector lists the record's forms without the
 * target's (the user can't open that form in this app: openForm would show this form again).
 */
export function goTo(xrm: any, g: Go, failed: () => void = () => {}): boolean {
  const later = (v: unknown): void => void Promise.resolve(v).catch(failed);
  try {
    switch (g.by) {
      case 'switch': {
        let items: any[] = [];
        try {
          items = Array.from(xrm.Page.ui.formSelector.items.get() as any[]);
        } catch {
          items = []; // no form selector: openForm below
        }
        const item = items.find((i) => guid(i.getId()) === g.formId);
        if (item) {
          later(item.navigate());
          return true;
        }
        if (items.length) return false;
        later(xrm.Navigation.openForm({ entityName: g.entity, ...(g.recordId ? { entityId: g.recordId } : {}), formId: g.formId }));
        return true;
      }
      case 'open':
        later(xrm.Navigation.openForm({ entityName: g.entity, ...(g.recordId ? { entityId: g.recordId } : {}), ...(g.formId ? { formId: g.formId } : {}) }));
        return true;
      case 'list':
        later(xrm.Navigation.navigateTo({ pageType: 'entitylist', entityName: g.entity, ...(g.viewId ? { viewId: g.viewId, viewType: g.viewType || 'savedquery' } : {}) }));
        return true;
      case 'dashboard':
        later(xrm.Navigation.navigateTo({ pageType: 'dashboard', dashboardId: g.dashboardId }));
        return true;
      default:
        return false;
    }
  } catch {
    return false; // no navigation API (not a model-driven app page)
  }
}

/** The page shown is the target's: its form (on its record; any record for a new one), its list (with its view), its dashboard. */
export function arrived(t: Target, p: Place): boolean {
  switch (t.to) {
    case 'form':
      return p.type === 'entityrecord' && same(p.entity, t.entity) && (!t.recordId || p.recordId === t.recordId) && (!t.formId || p.formId === t.formId);
    case 'list':
      return p.type === 'entitylist' && same(p.entity, t.entity) && (!t.viewId || p.viewId === t.viewId);
    case 'dashboard':
      return p.type === 'dashboard' && p.dashboardId === t.dashboardId;
  }
}

/**
 * The page shown may still turn into the target's while Dynamics navigates: a record of its table (the target's record,
 * or one not known yet) whatever form it shows so far, a list of its table, a dashboard not known yet, or a page that
 * doesn't say what it is yet.
 */
export function toward(t: Target, p: Place): boolean {
  if (p.type === 'other' && !p.entity) return true;
  switch (t.to) {
    case 'form':
      return p.type === 'entityrecord' && same(p.entity, t.entity) && (!t.recordId || !p.recordId || p.recordId === t.recordId);
    case 'list':
      return p.type === 'entitylist' && same(p.entity, t.entity);
    case 'dashboard':
      return p.type === 'dashboard' && (!p.dashboardId || p.dashboardId === t.dashboardId);
  }
}

/** The target's record (any record of its table for a new one) shows another form, known: the one Dynamics opened instead. */
const otherForm = (t: Target, p: Place): boolean =>
  t.to === 'form' && !!t.formId && p.type === 'entityrecord' && same(p.entity, t.entity) && (!t.recordId || p.recordId === t.recordId) && !!p.formId && p.formId !== t.formId;

/** A find that went to another page to find its label there (mode.ts goFind). */
export interface Trip {
  target: Target;
  /** Page.sig of the page it left: while that one shows, it hasn't gone yet (Dynamics may be asking about unsaved changes). */
  from: string;
  /** When it gives up (TRIP_WAIT after it set out). */
  until: number;
  /** Since when the page shown has been ready where it went (0: not yet). */
  since: number;
}

/** What tripStep reads of the page now. */
export interface TripNow {
  place: Place | null;
  /** Page.sig. */
  sig: string;
  /** The page's index and loads are in and its form has rendered. */
  ready: boolean;
  /** The label is on the page (anchored). */
  found: boolean;
}

/** How long a find waits for the page it went to. */
export const TRIP_WAIT = 20000;
/** How long after setting out a second click on the row does nothing (it goes once), even on the page it left. */
export const TRIP_AGAIN = 1000;
/** How long a ready target page may take to render the label before it is looked for there anyway. */
export const TRIP_SETTLE = 500;
/** How long the record may show another form than the target's before that counts as the one Dynamics opened instead. */
export const TRIP_OTHER = 3000;

/**
 * The next step of a find gone to another page. 'find': the target page shows and its label is on it, or the page has
 * been ready for TRIP_SETTLE (its label may be on another tab, in the header's flyout, or hidden: the find on that page
 * decides), or the deadline came while it is there; also when Dynamics opened another form of the record instead (the
 * target form isn't available to the user) and that has been ready for TRIP_OTHER. 'wait': still on the page it left
 * (an unsaved-changes prompt), or on the way. 'cancel': the user went to another page, or the deadline came first.
 */
export function tripStep(t: Trip, n: TripNow, now: number): 'wait' | 'find' | 'cancel' {
  const p = n.place;
  const there = !!p && arrived(t.target, p);
  if (there || (!!p && n.sig !== t.from && otherForm(t.target, p))) {
    if (n.found) return 'find';
    if (!n.ready) t.since = 0;
    else if (!t.since) t.since = now;
    if (t.since && now - t.since >= (there ? TRIP_SETTLE : TRIP_OTHER)) return 'find';
    return now < t.until ? 'wait' : there ? 'find' : 'cancel';
  }
  t.since = 0;
  if (now >= t.until) return 'cancel';
  return n.sig === t.from || !p || toward(t.target, p) ? 'wait' : 'cancel';
}

/**
 * A second click on the row of a find on its way goes again only when it is still on the page it left (`sig`) TRIP_AGAIN
 * after it set out and Dynamics asks nothing there (`asking`: pageDialog): the user said no to its unsaved-changes
 * question, whose navigation promise may never reject. Else it does nothing: it goes once per click.
 */
export const goAgain = (t: Trip, sig: string, asking: boolean, now: number): boolean => sig === t.from && !asking && now - (t.until - TRIP_WAIT) >= TRIP_AGAIN;

/** Dynamics shows a modal dialog on the page (its unsaved-changes question): ours are in our own shadow root. */
export function pageDialog(root: ParentNode = document): boolean {
  try {
    for (const el of root.querySelectorAll('[aria-modal="true"],[role="alertdialog"]')) if (!el.checkVisibility || el.checkVisibility()) return true;
  } catch {
    /* no document */
  }
  return false;
}
