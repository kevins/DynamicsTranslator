// The three lists the page is switched with: the app's areas (the area switcher at the bottom of the navigation), the
// record's forms (the form selector in its header) and a grid's views (its view selector). Their buttons only open the
// list, and picking from the list is what the user opened it for: beside a label's text both reach the page in
// translation mode (overlay.ts effect). Every item of an open list is marked like any other label (scan.ts), so the
// list shows what can be translated. A selector's popup offers Change area / form / view (its list), an item's popup
// Open (switches to it). By the time Open is pressed the list has closed and its items are gone: a form is switched
// through the form API (the page form's, so only from the list its own selector opened), an area or a view from its
// list, opened again by its button.
//
// Live markup (current UCI, 2026-10-20): the area switcher `button#areaSwitcherId`, its list a portal under body,
// `[data-lp-id="sitemap-area-switcher-flyout"] li[role=menuitemradio][data-id="areaswitcherflyout-<area id>"]`; the form
// selector `button[data-id="form-selector"]`, its list a Fluent v9 portal, `[data-id="form-selector-flyout"]
// div[role=menuitemradio][data-value="<form id>"]`; a list page's view selector `button[data-id="ViewSelector_<view id>"]`,
// its list a Fluent v8 portal, `[data-id="ViewSelector_<current view id>-flyout"] button[role=menuitemradio][data-value=
// "<view id>"]`, then Microsoft's own "Manage and share views" (a menuitem, no view). The current item is
// aria-checked="true". Their aria-labels are localised: never read.

import { guid, isGuid } from '../core/http';
import type { ListKind, Switch } from './types';

const AREA_OPENER = '#areaSwitcherId';
const FORM_OPENER = '[data-id="form-selector"]';
/** The buttons that open the lists (a view selector's: only one that says it opens a popup). */
export const OPENER = `${AREA_OPENER},${FORM_OPENER},button[data-id^="ViewSelector_"][aria-haspopup]`;
const AREAS = '[data-lp-id="sitemap-area-switcher-flyout"]';
const FORMS = '[data-id="form-selector-flyout"]';
const FLYOUT = '-flyout';
/** The lists, open: the areas, the forms, a view selector's views (`<its button's data-id>-flyout`). */
export const LIST = `${AREAS},${FORMS},[data-id^="ViewSelector_"][data-id$="${FLYOUT}"]`;
/** An item of one: an area, a form, a view. */
export const ITEM = '[role="menuitemradio"]';
/** An area item's data-id: this, then the area's id. */
const AREA_ITEM = 'areaswitcherflyout-';

/** How long a list opened again may take to show the item Open switches to, and how often it is looked for. */
export const PICK_WAIT = 3000;
const PICK_EVERY = 100;

const quoted = (v: string): string => v.replace(/["\\]/g, '\\$&');
const expanded = (b: Element): boolean => b.getAttribute('aria-expanded') === 'true';

/** Which list a list element (LIST) is. */
export const kindOf = (l: Element): ListKind => (l.matches(AREAS) ? 'area' : l.matches(FORMS) ? 'form' : 'view');

/** The label on a selector's own button (`b`, OPENER): its popup's Change … opens the list. */
export function selectorSwitch(b: Element): Switch {
  const list: ListKind = b.matches(AREA_OPENER) ? 'area' : b.matches(FORM_OPENER) ? 'form' : 'view';
  const find = list === 'area' ? AREA_OPENER : list === 'form' ? FORM_OPENER : `button[data-id="${quoted(b.getAttribute('data-id') || '')}"]`;
  return { list, id: '', opener: b, find, item: '' };
}

/**
 * An item of an open list (ITEM in LIST): the area its data-id names, the form or view its data-value names. A view's
 * button is the one whose data-id is its list's without "-flyout" (the one with the list open, where several have it).
 * Null when the element doesn't say which one it is.
 */
export function itemSwitch(it: Element): Switch | null {
  const l = it.closest(LIST);
  if (!l) return null;
  const list = kindOf(l);
  if (list === 'area') {
    const d = it.getAttribute('data-id') || '';
    const id = d.startsWith(AREA_ITEM) ? d.slice(AREA_ITEM.length) : '';
    return id ? { list, id, opener: document.querySelector(AREA_OPENER), find: AREA_OPENER, item: `${ITEM}[data-id="${quoted(d)}"]` } : null;
  }
  const v = it.getAttribute('data-value') || '';
  const id = guid(v);
  if (!isGuid(id)) return null;
  // The form API switches forms: no item to find again. The button is the one with the list open (the list, a portal,
  // doesn't say which opened it): only the page form's own may switch through the page's form API (scan.ts).
  if (list === 'form') return { list, id, opener: document.querySelector(`${FORM_OPENER}[aria-expanded="true"]`), find: FORM_OPENER, item: '' };
  const base = (l.getAttribute('data-id') || '').slice(0, -FLYOUT.length);
  const bs = Array.from(document.querySelectorAll(`[data-id="${quoted(base)}"]`)).filter((b) => b.matches(OPENER));
  const b = bs.find(expanded) ?? (bs.length === 1 ? bs[0] : null);
  return { list, id, opener: b, find: `button[data-id="${quoted(base)}"]`, item: `${ITEM}[data-value="${quoted(v)}"]` };
}

/** What switching needs from the page (mode.ts gives the real ones). */
export interface ListFx {
  /** The form API (Xrm). */
  xrm: any;
  /** The first element on the page a selector finds. */
  find(sel: string): Element | null;
  /** A click like the user's. */
  click(el: Element): void;
  /** Runs `fn` `ms` later. */
  later(fn: () => void, ms: number): void;
  now(): number;
  /** Tells the user it couldn't be done (the app's toast). */
  fail(message: string): void;
}

/** The button that opens a switch's list: the one found with its label while it is on the page, else found again. */
function openerOf(sw: Switch, fx: Pick<ListFx, 'find'>): Element | null {
  if (sw.opener?.isConnected) return sw.opener;
  return sw.find ? fx.find(sw.find) : null;
}

/**
 * Focuses the button that opens a switch's list: an item reached with the keyboard left with its list as its popup took
 * the focus, and the keyboard goes on from that button rather than from the top of the app. False when it isn't there.
 */
export function focusOpener(sw: Switch | undefined, fx: Pick<ListFx, 'find'>): boolean {
  const b = sw ? openerOf(sw, fx) : null;
  if (!b) return false;
  try {
    (b as HTMLElement).focus({ preventScroll: true });
    return true;
  } catch {
    return false; // not focusable
  }
}

/**
 * Opens a selector's list (its popup's Change …): a click on its button like the user's, once the popup has closed and
 * the focus is back where it was (a list that opened before would close as the focus leaves it), and never while the
 * list is open already (the click would close it). False when the button isn't there.
 */
export function openList(sw: Switch, fx: ListFx): boolean {
  const b = openerOf(sw, fx);
  if (!b) return false;
  fx.later(() => {
    if (b.isConnected && !expanded(b)) fx.click(b);
  }, 0);
  return true;
}

/** What the user is told when the list opened again never showed the item (Open). */
export const NOT_SHOWN: Record<ListKind, string> = {
  area: "Couldn't change the area: the list of areas didn't show it. Pick it from that list on the page.",
  form: "Couldn't change the form. Pick it from the list of forms on the page.",
  view: "Couldn't change the view: the list of views didn't show it. Pick it from that list on the page.",
};

/**
 * Switches to an item of a list that has closed (its popup's Open). A form through the form API, which asks about
 * unsaved changes itself; an area or a view from its list, opened again by its button, the item clicked as soon as it
 * shows (PICK_WAIT at most, else the user is told). Each waits until the popup has closed (see openList). False when
 * nothing could be started: no such form on the page's form API, no button to open the list with.
 */
export function switchTo(sw: Switch, fx: ListFx): boolean {
  if (!sw.id) return false;
  if (sw.list === 'form') {
    const f = formItem(fx.xrm, sw.id);
    if (!f) return false;
    fx.later(() => {
      try {
        f.navigate();
      } catch {
        fx.fail(NOT_SHOWN.form);
      }
    }, 0);
    return true;
  }
  const b = openerOf(sw, fx);
  if (!b) return false;
  fx.later(() => {
    if (!b.isConnected) return fx.fail(NOT_SHOWN[sw.list]);
    if (!expanded(b)) fx.click(b);
    const until = fx.now() + PICK_WAIT;
    const look = (): void => {
      const it = fx.find(sw.item);
      if (it?.closest(LIST)) return fx.click(it);
      if (fx.now() >= until) return fx.fail(NOT_SHOWN[sw.list]);
      fx.later(look, PICK_EVERY);
    };
    look();
  }, 0);
  return true;
}

/** The form selector's item of a form (Xrm.Page.ui.formSelector.items), null when the page's form API has none. */
function formItem(xrm: any, id: string): { navigate(): void } | null {
  const of = (f: any): string => {
    try {
      return guid(f?.getId?.());
    } catch {
      return '';
    }
  };
  try {
    const items = xrm.Page.ui.formSelector.items;
    // By its id; else among them all (ids come with braces or in capitals, by build).
    let one: any = null;
    try {
      one = items.get(id);
    } catch {
      /* looked for among them all */
    }
    if (one && of(one) === id) return one;
    const all: unknown = items.get();
    return (Array.isArray(all) ? all : []).find((f) => of(f) === id) ?? null;
  } catch {
    return null; // not a record form, or the form is being replaced
  }
}
