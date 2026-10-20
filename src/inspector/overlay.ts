// The on-page layer of translation mode: a tinted box that hugs the text of every translatable label (one per
// line of text, never around a container), a stronger border and a pencil badge on the label whose text is under the
// pointer, and the always-on interception that turns a click on a label's text into "translate this" while everything
// else on the page keeps working (ARCHITECTURE §5.4). Only the text is the label, with the pencil drawn after it: beside
// it, a click in the label's zone reaches the page (a field label's container, a section header), except where it acts
// (a zone that is a button, a tab, a link, a menu item…, or lies in one), where it does nothing at all, so missing the
// text of "Delete" never deletes. What only opens or closes part of the navigation (a group under its header, the area
// switcher's list) is harmless: beside a group's title the group opens or closes. So is a button that opens one of the
// lists the page is switched with (the areas, the record's forms, a grid's views), and in such a list, picking an item:
// the user opened it to pick from it (lists.ts). Text that can't be translated here
// (built-in or read-only) is marked grey, and its popup says why. Labels not loaded get nothing: no mark, no hover, no
// pointer, and their clicks reach the page. Marks lie under the page's popups: the part of one that a flyout, a
// dropdown, a menu, a tooltip or a side pane covers is cut away.
//
// It lives in its own shadow root on <html>, outside React's trees, and never touches Dynamics' DOM: the
// pointer cursor over a label's text is an adopted document sheet, emptied on leave and removed on stop. Positions
// update in animation frames that do every layout read before any write, skip labels outside the viewport and
// write only what moved, so hundreds of labels stay smooth.
//
// A form field whose choices changed gets a pill after its value or label ("1 choice changed", pill.ts), inside its
// field and clear of every other mark; where its text doesn't fit, its count alone ("2"). Like the marks it takes no
// events (the page under it keeps its hover and the wheel): the pointer is found on it by position, its clicks and
// hover are its label's, and its full text shows next to it while it is pointed at.

import { h } from '../ui/dom';
import { ITEM, LIST, OPENER } from './lists';
import css from './overlay.css';
import type { Anchor, Look, OverlayApi, OverlayHooks, Part, Pill, Role } from './types';

/** [left, top, width, height] in viewport pixels. */
export type Box = [number, number, number, number];
/** A visible area: left, top, right, bottom. */
export interface Clip {
  l: number;
  t: number;
  r: number;
  b: number;
}
interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
/** What clipping leaves of an element: `c` = cut by every clipping ancestor, `hard` = by the viewport and the scrolling ones only. */
interface Clips {
  c: Clip;
  hard: Clip;
}
/** A clipping element and whether it scrolls (its edges are hard: text past them is scrolled out of view). */
type ClipEl = [Element, boolean];

/** Who owns the current primary-button gesture, and the label the last click opened. */
export interface Gesture {
  /**
   * A label (the gesture is taken over), false (taken over on no label: beside the text of a label that acts), null
   * (the page's) or undefined (none seen).
   */
  g: Anchor | null | false | undefined;
  /**
   * Who owned the gesture the last click ended, for the double-click that follows it (undefined: none since the last
   * pointerdown): it is judged with its clicks, never on its own position.
   */
  end: Anchor | null | false | undefined;
  last: Anchor | null;
}

interface Rec {
  a: Anchor;
  /** Carries the look and state classes; its children are the marks (one per text line) and the pencil badge. */
  g: HTMLElement;
  marks: HTMLElement[];
  /** The pencil badge, made the first time the label is hovered or active. */
  pen: HTMLElement | null;
  look: Look | '';
  /** Frame that last measured it (0 = never, or measured before a pause). */
  f: number;
  /** Visible zone rect from the last frame; null = off-screen, clipped, hidden or wholly covered. */
  zone: Box | null;
  /** The text's marks from the last frame. */
  boxes: Box[];
  /** Each mark's clip-path, parallel to `boxes`: what popups over the label hide of it ('' or none = nothing). */
  masks: string[];
  /** The text node that showed last frame, when it is not `a.text` (grids render a hidden copy too). */
  tx: Text | null;
  /**
   * The last frame found its text visible (scrolled partly out still counts). False: its zone shows but its text
   * doesn't (a collapsed site map's icon, an icon-only button): the label then takes no clicks, nothing is drawn.
   */
  vis: boolean;
}

/** A pill and where the last frame drew it. */
interface PillRec {
  p: Pill;
  el: HTMLElement;
  /** The label it was drawn after (its clicks are that label's); null = not drawn. */
  host: Anchor | null;
  box: Box | null;
  /** Drawn as its count alone: its text didn't fit. */
  short: boolean;
}

/**
 * The only events taken over, and only for gestures that start on a label's text or beside the text of a label that
 * acts. Wheel, scroll and keys pass.
 */
const INTERCEPT = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick'];
/** Touch events of a gesture a label owns are stopped too, never canceled (scrolling keeps working). */
const TOUCH = ['touchstart', 'touchend'];
const WATCH: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['data-id', 'data-name', 'data-text', 'aria-label', 'title', 'aria-selected', 'aria-expanded', 'hidden'],
};
/** Hosts whose open shadow roots hold labels: the header strip; observed too. */
const SHADOW_HOSTS = 'uci-header-control-list';
const PASSIVE = { capture: true, passive: true };
/**
 * Layers that cover labels: a modal hides everything outside it, a popup or a side pane (Xrm.App.sidePanes, which
 * can lie over the page, LIVE-FINDINGS 58) hides the labels under it.
 */
const LAYERS = '[aria-modal="true"],[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],.ms-Callout-main,.ms-Panel-main,.fui-PopoverSurface,[data-id^="pane-container-"]';
/**
 * Roots whose content floats over the page, whatever its role (Fluent v8 layers, Fluent v9 portals, and the mount node
 * that holds the header fields flyout, LIVE-FINDINGS 86): what they paint covers the labels under it.
 */
const PORTALS = '#__fluentPortalMountNode,.ms-Layer,[data-portal-node]';
/** Children of <html> and <body> that never hold another tool's panel. */
const NOT_PANEL = /^(HEAD|BODY|SCRIPT|STYLE|LINK|META|NOSCRIPT|TEMPLATE|TITLE|BASE)$/i;
/** Replaced elements: they paint their content without a background of their own (another tool's panel in an iframe). */
const REPLACED = /^(IFRAME|IMG|CANVAS|VIDEO|OBJECT|EMBED)$/i;
/** Elements looked at in portals per frame (each root its share, twice this at most in all), and how deep. */
const MAX_VISITS = 64;
const MAX_DEPTH = 8;
/** A computed background colour that paints nothing: transparent, or alpha 0 (rgba(…, 0), or color(… / 0) and the like). */
const CLEAR = /^(transparent|rgba\([^)]*,\s*0(\.0+)?\))$|\/\s*0(\.0+)?\)$/;
const CURSOR = '*{cursor:pointer!important}';
const VIS = { checkOpacity: true, checkVisibilityCSS: true };
const MAX_LINES = 6;
/** Room around the text inside a mark. */
const PAD_X = 2;
const PAD_Y = 1;
/** Size of the pencil badge. */
const PEN = 14;
/** The pill (overlay.css .pill): its height, side padding (its count alone: .is-n), font, and its gap after the label's mark. */
const PILL_H = 16;
const PILL_PAD = 6;
const PILL_PAD_N = 4;
const FONTS = '"Segoe UI","Segoe UI Web (West European)",-apple-system,BlinkMacSystemFont,Roboto,"Helvetica Neue",sans-serif';
const PILL_FONT = `600 11px ${FONTS}`;
const PILL_GAP = 4;
/** The pill's tooltip (overlay.css .tip): height, side padding, font. */
const TIP_H = 20;
const TIP_PAD = 8;
const TIP_FONT = `400 12px ${FONTS}`;
/** A required "*" or a business-recommended "+" after a field label's text. */
const MARKER = /^[*+]$/;
/** How far after a label's text its required marker can start. */
const MARKER_GAP = 12;
/** Form controls: a container holding one is not a label's own column (columnOf), a label zone holding one acts (pointed). */
const CONTROLS = 'input,select,textarea,button,[role="combobox"],[role="listbox"],[role="switch"],[role="checkbox"],[role="radiogroup"]';
/** How far a text line may stick out of a tight clipping parent (ascent/descent) and still count as shown. */
const SLACK = 4;
/** Hit tests per frame for labels in a popup, the modal or a portal that another popup may lie over. */
const MAX_HITS = 48;
/** A popup leaves a mark only a piece at least this many px wide and high; a thinner sliver of it is not drawn. */
const MIN_SHOW = 4;
/** How far a mark's ring and outline reach past its box (overlay.css box-shadow, outline): cut away with it where a popup lies. */
const RING = 4;
/** How long a label found from the list pulses: three .6 s rings (overlay.css dxt-pl). */
const PULSE_MS = 1800;
const MEANT = /[\p{L}\p{N}]/u;
/** Inside a label zone these keep working as usual: typing in a text box, resizing a grid column. */
const PASS = 'textarea,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],[role="separator"],.ag-header-cell-resize';
const TEXTY = /^(text|search|email|url|tel|number|password|date|datetime-local|month|time|week)$/i;
/** How far past a mark (itself PAD_X × PAD_Y around the text) the pointer still counts as on the label's text. */
const SLOP = 2;
/**
 * What runs a command, follows a link or changes a value when clicked. A click beside a label's text in a zone that is
 * one of these, holds one under the pointer or lies inside one (a view selector's text in its button) is swallowed
 * without opening anything: it never runs what the page would (a text box in a zone is PASS, checked first, so `input`
 * here is a checkbox, a radio button and the like).
 */
const ACTS ='a[href],button,input,select,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="treeitem"],[role="columnheader"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"]';
/**
 * Labels whose whole zone acts whatever its markup: a tab, a navigation item, a command, a process stage chip, a grid
 * column header (it sorts), an option of a list. In the navigation, a zone where all that acts only opens or closes
 * (TOGGLE: a group's title in its header, the area switcher) does not; nor does a list's button (OPENER) or an item of
 * a list the page is switched with (lists.ts).
 */
const ACTIVE: ReadonlySet<Role> = new Set<Role>(['tab', 'nav', 'command', 'stage', 'header', 'option']);
/** An entry of a tree, and the list of entries a tree entry holds under it (Recent's and Pinned's records). */
const TREEITEM = '[role="treeitem"]';
const SUBTREE = '[role="group"]';
/**
 * The app's navigation on the left (the site map): its container and its tree of entries (Home, Recent, Pinned, the
 * groups and their items).
 */
const NAVIGATION = '[data-id="navbar-container"],[role="tree"]';
/** In it too: its entries (`sitemap-entity-…`, `sitemap-sitemapAreaGroup-…`) and the area switcher below them. */
const SITEMAP = `${NAVIGATION},[data-id^="sitemap-"],#areaSwitcherId`;
/**
 * In the navigation, what only opens or closes something: an entry or a header that expands (aria-expanded: a group,
 * Recent, Pinned, the button that collapses the whole navigation) and the area switcher (it opens the list of areas).
 * Never a link, never the navigation itself.
 */
const TOGGLE = '[aria-expanded],#areaSwitcherId';
const LINK = 'a[href],[role="link"]';

const norm = (s: string | null): string => (s || '').replace(/\s+/g, ' ').trim();

/**
 * Looks that leave a label alone: no mark, no hover, no pointer, and its clicks reach the page (not loaded; '' = not
 * painted yet). Read-only text is marked grey like built-in text: its popup says why.
 */
export const inert = (l: Look | ''): boolean => l === 'na' || l === '';

/** The part of a rect inside a clip, or null when less than 2 px is left either way. */
export function isect(r: Edges, c: Clip): Box | null {
  const l = Math.max(r.left, c.l);
  const t = Math.max(r.top, c.t);
  const rr = Math.min(r.right, c.r);
  const b = Math.min(r.bottom, c.b);
  return rr - l < 2 || b - t < 2 ? null : [l, t, rr - l, b - t];
}

/**
 * The marks of a label's text: its client rects merged per line (top first), each cut to the clip sideways (an
 * ellipsis, a grid scrolled sideways), padded PAD_X × PAD_Y, kept inside `hard` and snapped to device pixels. A
 * line cut off at the top or bottom gets none. `hard` is the area of the scrolling containers: a line partly
 * scrolled out of it gets none either (no box over a sticky header, a footer or a scroll bar), unless that area
 * is barely taller than the line (a tight wrapper that happens to scroll, where text always sticks out a little).
 */
export function marks(rects: ArrayLike<Edges>, c: Clip, dpr = 1, max = MAX_LINES, hard?: Clip): Box[] {
  const rows: Edges[] = [];
  for (let i = 0; i < rects.length; i++) {
    const q = rects[i];
    if (q.right - q.left < 1 || q.bottom - q.top < 1) continue;
    const mid = (q.top + q.bottom) / 2;
    const row = rows.find((w) => Math.abs((w.top + w.bottom) / 2 - mid) < Math.min(w.bottom - w.top, q.bottom - q.top) / 2);
    if (!row) rows.push({ left: q.left, top: q.top, right: q.right, bottom: q.bottom });
    else {
      row.left = Math.min(row.left, q.left);
      row.top = Math.min(row.top, q.top);
      row.right = Math.max(row.right, q.right);
      row.bottom = Math.max(row.bottom, q.bottom);
    }
  }
  rows.sort((x, y) => x.top - y.top);
  const px = (v: number) => Math.round(v * dpr) / dpr;
  const out: Box[] = [];
  /** The previous line's text bottom and box: lines that touch share the gap between them instead of overlapping. */
  let above = -Infinity;
  let prev: Box | null = null;
  for (const w of rows) {
    if (w.top < c.t - SLACK || w.bottom > c.b + SLACK) continue;
    let l = Math.max(w.left, c.l);
    let r = Math.min(w.right, c.r);
    if (r - l < 2) continue;
    l -= PAD_X;
    r += PAD_X;
    let t = w.top - PAD_Y;
    let b = w.bottom + PAD_Y;
    if (hard) {
      if (hard.b - hard.t >= 2 * (w.bottom - w.top)) {
        if (w.top < hard.t - 1 || w.bottom > hard.b + 1) continue;
        t = Math.max(t, hard.t);
        b = Math.min(b, hard.b);
      }
      l = Math.max(l, hard.l);
      r = Math.min(r, hard.r);
    }
    l = px(l);
    t = px(t);
    if (prev && t < prev[1] + prev[3]) {
      const mid = px((above + w.top) / 2);
      prev[3] = Math.max(mid - prev[1], 1);
      t = Math.max(t, mid);
    }
    out.push((prev = [l, t, px(r) - l, px(b) - t]));
    above = w.bottom;
    if (out.length >= max) break;
  }
  return out;
}

/** Where the pencil badge of a hovered label goes: just right of its last mark and centred on it, inside `view`. */
export function badgeBox(b: Box, view: Clip, dpr = 1): Box {
  const px = (v: number) => Math.round(v * dpr) / dpr;
  let x = b[0] + b[2] + 2;
  if (x + PEN > view.r) x = b[0] + b[2] - PEN; // no room on the right: over the mark's end
  const y = Math.min(Math.max(b[1] + (b[3] - PEN) / 2, view.t), view.b - PEN);
  return [px(Math.max(x, view.l)), px(y), PEN, PEN];
}

/**
 * Where a pill `w` wide goes: just right of a label's last mark `b`, centred on it; null when it doesn't fit inside
 * `clip` (the viewport, the scrolling containers around the label and its field). It never covers the label's text.
 */
export function pillBox(b: Box, w: number, clip: Clip, dpr = 1): Box | null {
  const px = (v: number) => Math.round(v * dpr) / dpr;
  const x = b[0] + b[2] + PILL_GAP;
  const y = b[1] + (b[3] - PILL_H) / 2;
  return x < clip.l || x + w > clip.r || y < clip.t || y + PILL_H > clip.b ? null : [px(x), px(y), w, PILL_H];
}

/**
 * True when the event happened on something inside the label zone that keeps working: a text box (never
 * a checkbox, a switch or a select, which would change the record) or a grid column's resize handle.
 */
export function passes(path: ArrayLike<EventTarget>, zone: Element): boolean {
  for (let i = 0; i < path.length; i++) {
    const n = path[i] as Element;
    if (n === zone) return false;
    if (!n || typeof n.matches !== 'function') continue;
    if (typing(n)) return true;
  }
  return false;
}

/** A text box: a click on it types, it changes nothing. */
const typing = (n: Element): boolean => (n.tagName === 'INPUT' && TEXTY.test((n as HTMLInputElement).type || 'text')) || n.matches(PASS);

/**
 * True when the event happened on something that acts (ACTS) anywhere from its target up: in a label zone, the zone
 * itself or around it (a view selector's text in its button, an item's text in a menu item). A <label> acts when the
 * control it is for does: the browser clicks that control (`for=`, outside the label), and a checkbox or a switch would
 * change the record. A click beside a label's text there is swallowed rather than let through. What only opens or
 * closes part of the navigation, opens a list to pick from or picks from it does not count (effect).
 */
export const acts = (path: ArrayLike<EventTarget>): boolean => effect(path) === 'acts';

/** What a click does (effect). */
export type Effect = 'acts' | 'toggle' | 'pick' | '';
/** A click beside a label's text that the page gets all the same (effect): it opens or closes something, or picks from a list the user opened. */
export const harmless = (e: Effect | undefined): boolean => e === 'toggle' || e === 'pick';

/**
 * What a click on this path does, from its target up: 'acts' when something there runs a command, follows a link,
 * navigates or changes a value (acts); 'toggle' when all that acts there only opens or closes part of the app's
 * navigation (TOGGLE: a group under its header, Recent, Pinned, the list of areas) or opens a list the page is switched
 * with (OPENER: the area switcher, the form selector, a view selector); 'pick' when it picks an item of such a list
 * (ITEM in LIST: an area, a form, a view), which is what the user opened it for; '' when nothing acts. Both are harmless:
 * beside a label's text the page gets the click, as without the translator. A tree entry around a toggle is the entry it
 * opens (a group's, its header inside it), never an item that navigates: those lie in the group's list, under no toggle.
 * The site map's items and every other menu (a command's) stay 'acts'.
 */
export function effect(path: ArrayLike<EventTarget>): Effect {
  const el = (n: unknown): n is Element => !!n && typeof (n as Element).matches === 'function';
  // The outermost element of the navigation on the path: only what lies in it can be a toggle.
  let top = path.length - 1;
  for (; top >= 0; top--) if (el(path[top]) && (path[top] as Element).matches(SITEMAP)) break;
  // The innermost list to pick from on the path (-1: none): only its items pick.
  let list = -1;
  for (let i = 0; i < path.length && list < 0; i++) if (el(path[i]) && (path[i] as Element).matches(LIST)) list = i;
  let toggle = false;
  let pick = false;
  for (let i = 0; i < path.length; i++) {
    const n = path[i];
    if (!el(n)) continue;
    if ((i <= top && n.matches(TOGGLE) && !n.matches(LINK) && !n.matches(NAVIGATION)) || n.matches(OPENER)) {
      toggle = true;
      continue;
    }
    if (i < list && n.matches(ITEM)) {
      pick = true;
      continue;
    }
    if (n.matches(ACTS)) {
      if (toggle && n.matches(TREEITEM)) continue;
      return 'acts';
    }
    const c = n.tagName === 'LABEL' ? (n as HTMLLabelElement).control : null;
    if (c && c.matches(ACTS) && !typing(c)) return 'acts';
  }
  return pick ? 'pick' : toggle ? 'toggle' : '';
}

/**
 * True when the event target lies in another entry of a tree nested in the zone, or in the list of entries a tree
 * entry holds (Recent and Pinned list their records inside their own entry): those are not the zone's, and an entry
 * that is not marked gets its clicks.
 */
export function nested(path: ArrayLike<EventTarget>, zone: Element): boolean {
  const tree = typeof zone.matches === 'function' && zone.matches(TREEITEM);
  for (let i = 0; i < path.length; i++) {
    const n = path[i] as Element;
    if (n === zone) return false;
    if (n && typeof n.matches === 'function' && (n.matches(TREEITEM) || (tree && n.matches(SUBTREE)))) return true;
  }
  return false;
}

/**
 * One trusted pointer event of a gesture: whether it is swallowed and which label opens. `here` is the label
 * under the event (null outside labels, with Alt, for other buttons and in our own hosts; false beside the text of a
 * label that acts: taken over, nothing opens). A whole gesture belongs either to the translator or to the page,
 * decided when it starts, so Dynamics never sees half of one: a drag that starts on a label and ends elsewhere stays
 * ours, and the other way round. A double-click goes with the clicks it follows: the click before it ended the gesture,
 * and its own position (the second release, a little off the text) would hand the page a lone dblclick.
 */
export function decide(s: Gesture, type: string, here: Anchor | null | false, detail: number): { swallow: boolean; open: Anchor | null } {
  if ((type === 'click' || type === 'dblclick') && detail === 0) return { swallow: false, open: null }; // keyboard or screen reader activation
  if (type === 'pointerdown') s.end = undefined;
  const a = type === 'pointerdown' ? (s.g = here) : type === 'dblclick' && s.end !== undefined ? s.end : s.g !== undefined ? s.g : here;
  if (type === 'click') {
    s.end = a;
    s.g = undefined;
  } else if (type === 'dblclick') s.end = undefined;
  if (a === null) return { swallow: false, open: null };
  // Released elsewhere or beside the text, or the second click of a double-click: nothing more opens.
  if (type !== 'click' || !here || (detail > 1 && here === s.last)) return { swallow: true, open: null };
  s.last = here;
  return { swallow: true, open: here };
}

/**
 * Which of the labels sharing one zone (one label, or the parts of one text: multi-select values, a linked header's two
 * names) a pointer at `pt` is on: the one whose marks hold it (onText), else none (between two parts or past them it
 * would be a guess); the first without a point (F2). `boxes`: each label's marks from the last frame.
 */
export function pickPart(as: readonly Anchor[], boxes: (a: Anchor) => readonly Box[], pt: { x: number; y: number } | null): Anchor | null {
  if (!pt) return as[0] ?? null;
  return as.find((a) => onText(boxes(a), pt)) ?? null;
}

/** The box around boxes. */
const union = (bs: readonly Box[]): Box => {
  const l = Math.min(...bs.map((b) => b[0]));
  const t = Math.min(...bs.map((b) => b[1]));
  return [l, t, Math.max(...bs.map((b) => b[0] + b[2])) - l, Math.max(...bs.map((b) => b[1] + b[3])) - t];
};

const cut = (c: Clip, r: Clip): void => {
  c.l = Math.max(c.l, r.l);
  c.t = Math.max(c.t, r.t);
  c.r = Math.min(c.r, r.r);
  c.b = Math.min(c.b, r.b);
};

/** Whether two boxes overlap (touching edges don't). */
const meets = (a: Box, b: Box): boolean => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
/** Whether a point is in a box. */
const within = (b: Box, p: { x: number; y: number }): boolean => p.x >= b[0] && p.x < b[0] + b[2] && p.y >= b[1] && p.y < b[1] + b[3];
/** A box grown by `d` px on every side. */
const grow = (b: Box, d: number): Box => [b[0] - d, b[1] - d, b[2] + 2 * d, b[3] + 2 * d];
/** Whether a point is on one of a label's marks, or within SLOP px of one. */
export const onText = (boxes: readonly Box[], pt: { x: number; y: number }): boolean => boxes.some((b) => within(grow(b, SLOP), pt));
/** A DOMRect as a box. */
const boxOf = (r: DOMRect): Box => [r.left, r.top, r.width, r.height];

/** What is left of a box once each of `over` is cut out of it: disjoint boxes (none when it is all covered). */
export function uncovered(b: Box, over: readonly Box[]): Box[] {
  let out: Box[] = [b];
  for (const [cl, ct, cw, ch] of over) {
    const cr = cl + cw;
    const cb = ct + ch;
    out = out.flatMap((p): Box[] => {
      const [l, t, w, h] = p;
      const r = l + w;
      const bt = t + h;
      if (cl >= r || cr <= l || ct >= bt || cb <= t) return [p];
      const top = Math.max(t, ct);
      const bot = Math.min(bt, cb);
      const keep: Box[] = [];
      if (ct > t) keep.push([l, t, w, ct - t]); // above it
      if (cb < bt) keep.push([l, cb, w, bt - cb]); // below it
      if (cl > l) keep.push([l, top, cl - l, bot - top]); // beside it, left
      if (cr < r) keep.push([cr, top, r - cr, bot - top]); // beside it, right
      return keep;
    });
  }
  return out;
}

/** Whether a box shows past what lies over it: a piece at least MIN_SHOW px each way is left. */
export const shows = (b: Box, over: readonly Box[]): boolean => uncovered(b, over).some((p) => p[2] >= MIN_SHOW && p[3] >= MIN_SHOW);

/**
 * How a mark `m` shows under the popups over its label (`over`, viewport boxes, snapped to device pixels like the marks):
 * null when they leave none of it (shows); else the clip-path that cuts away what lies under them, its ring included
 * (RING px around it), in the mark's own coordinates; '' when nothing lies over the mark or its ring.
 */
export function maskOf(m: Box, over: readonly Box[], dpr = 1): string | null {
  const px = (v: number) => Math.round(v * dpr) / dpr;
  const ring = grow(m, RING);
  const cut = over.map(([l, t, w, h]): Box => [px(l), px(t), px(l + w) - px(l), px(t + h) - px(t)]).filter((c) => meets(ring, c));
  if (!cut.length) return '';
  if (!shows(m, cut)) return null;
  // Disjoint pieces: the default nonzero fill draws their union.
  const n = (v: number) => +v.toFixed(2);
  return `path("${uncovered(ring, cut)
    .map(([l, t, w, h]) => `M${n(l - m[0])} ${n(t - m[1])}h${n(w)}v${n(h)}h${n(-w)}z`)
    .join('')}")`;
}

/** Whether an element paints anything of its own: a background or a shadow (a transparent wrapper doesn't). */
function painted(el: Element): boolean {
  const s = getComputedStyle(el);
  return (s.backgroundImage || 'none') !== 'none' || (s.boxShadow || 'none') !== 'none' || !CLEAR.test(s.backgroundColor || 'transparent');
}

export class Overlay implements OverlayApi {
  private host = h('div');
  private wrap = h('div', { class: 'W', 'aria-hidden': 'true' });
  /** Marks and badges. */
  private layer = h('div', { class: 'L' });
  /** Pills, above the marks. */
  private pillLayer = h('div', { class: 'L' });
  /** The full text of the pill under the pointer (the pill takes no events: no native tooltip). */
  private tip = h('span', { class: 'ptip', hidden: true });
  private recs = new Map<Anchor, Rec>();
  private pills: PillRec[] = [];
  /** The last frame drew a pill: pointer moves are followed (a pill is found by position). */
  private drawn = false;
  /** The pill under the pointer (its tooltip shows). */
  private onPill: PillRec | null = null;
  /**
   * The pencil badges the last frame drew (hovered and active labels) and where. Each is part of its label like its text:
   * the pointer goes from the text onto it to click it, and it would vanish under the pointer otherwise.
   */
  private pens: Array<[Anchor, Box]> = [];
  /** Text widths by font and text (a canvas measure). */
  private widths = new Map<string, number>();
  /**
   * Label zones (`zone ?? el`, never `hit`), looked for walking up from an event target, the innermost first. In one,
   * the pointer is on its label only on the label's text (its marks); several labels share a zone when they are parts
   * of one text: the one whose text it is on (pickPart).
   */
  private zones = new WeakMap<Element, Anchor[]>();
  /** The pointer's last position (viewport): which label it is on depends on where it is in the zone. */
  private pt: { x: number; y: number } | null = null;
  /**
   * The pointer is in a zone whose text is marked, or on a pencil: moving onto or off that text (or off the pencil) inside
   * one element changes what is hovered.
   */
  private zoned = false;
  private moving = false;
  private clips = new WeakMap<Element, ClipEl[]>();
  /** Label zone -> its own column in its field (columnOf). */
  private cols = new WeakMap<Element, Element | null>();
  private placed = new WeakMap<HTMLElement, string>();
  private subs = new Set<() => void>();
  private range: Range | null = null;
  private mo = new MutationObserver((r) => this.take(r));
  private sheet: CSSStyleSheet | null = null;
  /** Elements matching LAYERS (null = query again: the page changed). */
  private layerEls: Element[] | null = null;
  /** Portal roots (PORTALS), outermost only (null = query again: the page changed). */
  private portalEls: Element[] | null = null;
  private raf = 0;
  private settle = 0;
  private fno = 0;
  private on = false;
  private paused = false;
  private alt = false;
  private cursor = false;
  private hover: Anchor | null = null;
  /** Path of the last pointerover, to find the hovered label again (Alt released, anchors replaced, resumed). */
  private path: EventTarget[] | null = null;
  private gs: Gesture = { g: undefined, end: undefined, last: null };
  private fl = '';
  /** The label found from the list, pulsing until `plT` ends it. */
  private pl: Anchor | null = null;
  private plT = 0;
  private act = '';
  /** The label the open popup points at (null: docked); undefined: every label of `act`. */
  private actA: Anchor | null | undefined = undefined;
  /** Set by boxesOf while a frame measures one label: a text of it shows. */
  private seen = false;
  /** Shadow roots observed besides document.body. */
  private shadows = new WeakSet<Node>();
  /** For measuring the text a closed <select> shows (null: no canvas). */
  private c2d: CanvasRenderingContext2D | null | undefined;
  private roots = new Set<Node>();
  private removed = false;
  private timer = 0;
  private tick = 0;

  constructor(private readonly o: OverlayHooks) {
    // Just below the translator's own layer (2147483646) so the bar, callouts and menus stay on top, and
    // above every Dynamics layer.
    this.host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483645;pointer-events:none;contain:strict';
    this.wrap.append(this.layer, this.pillLayer, this.tip);
    this.host.attachShadow({ mode: 'open' }).append(h('style', null, css), this.wrap);
  }

  start(): void {
    if (this.on) return;
    this.on = true;
    document.documentElement.append(this.host);
    // UCI scrolls inner containers, and scroll does not bubble: listen in the capture phase.
    addEventListener('scroll', this.move, PASSIVE);
    addEventListener('resize', this.move);
    addEventListener('transitionend', this.move, PASSIVE);
    addEventListener('animationend', this.move, PASSIVE);
    addEventListener('load', this.move, PASSIVE); // an image that loads moves the text next to it
    // Layout also changes without any event we see (a class or style change): measure again now and then.
    this.tick = window.setInterval(() => this.invalidate(1), 1000);
    visualViewport?.addEventListener('resize', this.move);
    visualViewport?.addEventListener('scroll', this.move);
    for (const t of INTERCEPT) addEventListener(t, this.onPtr, true);
    for (const t of TOUCH) addEventListener(t, this.onTouch, PASSIVE);
    addEventListener('pointerover', this.onOver, PASSIVE);
    addEventListener('pointerout', this.onOut, PASSIVE);
    addEventListener('keydown', this.onKey, true);
    addEventListener('keyup', this.onKeyUp, PASSIVE);
    addEventListener('blur', this.reset);
    document.addEventListener('visibilitychange', this.reset);
    this.mo.observe(document.body, WATCH);
    this.watchShadows();
    try {
      this.sheet ??= new CSSStyleSheet();
      this.sheet.replaceSync('');
      if (!document.adoptedStyleSheets.includes(this.sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.sheet];
    } catch {
      this.sheet = null; // no constructable stylesheets: labels work without the pointer cursor
    }
    this.layerEls = this.portalEls = null;
    this.invalidate(2);
  }

  stop(): void {
    if (!this.on) return;
    this.on = false;
    removeEventListener('scroll', this.move, true);
    removeEventListener('resize', this.move);
    removeEventListener('transitionend', this.move, true);
    removeEventListener('animationend', this.move, true);
    removeEventListener('load', this.move, true);
    clearInterval(this.tick);
    this.tick = 0;
    visualViewport?.removeEventListener('resize', this.move);
    visualViewport?.removeEventListener('scroll', this.move);
    for (const t of INTERCEPT) removeEventListener(t, this.onPtr, true);
    for (const t of TOUCH) removeEventListener(t, this.onTouch, true);
    removeEventListener('pointerover', this.onOver, true);
    removeEventListener('pointerout', this.onOut, true);
    removeEventListener('pointermove', this.onMove, true);
    this.moving = false;
    this.zoned = false;
    this.drawn = false;
    this.onPill = null;
    this.pens = [];
    this.pt = null;
    removeEventListener('keydown', this.onKey, true);
    removeEventListener('keyup', this.onKeyUp, true);
    removeEventListener('blur', this.reset);
    document.removeEventListener('visibilitychange', this.reset);
    this.mo.disconnect();
    this.shadows = new WeakSet();
    clearTimeout(this.timer);
    cancelAnimationFrame(this.raf);
    this.raf = this.timer = 0;
    this.roots.clear();
    this.removed = false;
    this.path = null;
    this.gs = { g: undefined, end: undefined, last: null };
    this.alt = false;
    this.wrap.classList.toggle('is-alt', false);
    // A later start() begins unpaused (the mode pauses it again when it has to), with nothing emphasised.
    this.paused = false;
    this.wrap.hidden = false;
    this.fl = this.act = '';
    this.actA = undefined;
    clearTimeout(this.plT);
    this.pl = null;
    this.layerEls = this.portalEls = null;
    this.cursor = false;
    if (this.sheet) {
      try {
        this.sheet.replaceSync(''); // even if it can't be removed, it no longer changes the cursor
      } catch {
        /* keep going */
      }
      try {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== this.sheet);
      } catch {
        /* already gone */
      }
    }
    this.sync([]);
    this.setPills([]);
    this.place(this.tip, null);
    this.host.remove();
  }

  sync(anchors: Anchor[]): void {
    const keep = new Set(anchors);
    for (const [a, r] of this.recs)
      if (!keep.has(a)) {
        r.g.remove();
        this.recs.delete(a);
      }
    this.zones = new WeakMap();
    this.clips = new WeakMap(); // containers change overflow (e.g. while animating): measure again
    this.cols = new WeakMap();
    for (const a of anchors) {
      const z = a.zone ?? a.el;
      const at = this.zones.get(z);
      // One label per zone, except the parts of one text.
      if (!at) this.zones.set(z, [a]);
      else if (a.part && at.every((b) => b.part)) at.push(a);
      if (!this.recs.has(a)) {
        const g = h('div', { class: 'g' });
        this.layer.append(g);
        this.recs.set(a, { a, g, marks: [], pen: null, look: '', f: 0, zone: null, boxes: [], masks: [], tx: null, vis: true });
      }
    }
    this.paint();
  }

  paint(): void {
    for (const r of this.recs.values()) {
      try {
        r.look = this.o.look(r.a);
      } catch (e) {
        if (__DEV__) console.error('[translator] look', e);
        r.look = 'na';
      }
    }
    let ps: Pill[] = [];
    try {
      ps = this.o.pills?.() ?? [];
    } catch (e) {
      if (__DEV__) console.error('[translator] pills', e);
    }
    this.setPills(ps);
    // A label that is no longer loaded is no longer hovered, and the other way round.
    this.rehover();
    this.invalidate(1);
  }

  /** Keeps one element per pill (placed, and its text written, by the next frame). */
  private setPills(ps: Pill[]): void {
    while (this.pills.length > ps.length) this.pills.pop()!.el.remove();
    ps.forEach((p, i) => {
      let r = this.pills[i];
      if (!r) {
        r = { p, el: h('span', { class: 'pill', hidden: true }), host: null, box: null, short: false };
        this.pillLayer.append(r.el);
        this.pills.push(r);
      }
      r.p = p;
      const el = r.el;
      if (el.title !== p.title) {
        el.title = p.title;
        el.setAttribute('aria-label', p.title);
      }
    });
  }

  flash(comp: string): void {
    if (comp === this.fl) return;
    this.fl = comp;
    this.invalidate(1);
  }

  pulse(a: Anchor | null): void {
    clearTimeout(this.plT);
    this.pl = a;
    if (a)
      this.plT = window.setTimeout(() => {
        this.pl = null;
        this.invalidate(1);
      }, PULSE_MS);
    this.invalidate(1);
  }

  /**
   * The component whose popup is open. With `a`, only that label keeps the hover look (the value "Active" shown in
   * every row of a list is one component: only the clicked cell is emphasised); null = docked, no label. Without
   * it (the OverlayApi call), every label of the component.
   */
  active(comp: string | null, a?: Anchor | null): void {
    const c = comp || '';
    const x = c ? a : undefined;
    if (c === this.act && x === this.actA) return;
    this.act = c;
    this.actA = x;
    this.invalidate(1);
  }

  rectOf(a: Anchor): DOMRect | null {
    if (!this.live()) return null;
    const r = this.recs.get(a);
    let b: Box | null;
    // A part of a text: its own marks (the zone is the whole text's).
    if (r?.f) b = r.zone && r.a.part && r.boxes.length ? union(r.boxes) : r.zone;
    else {
      // Not measured yet (synced since the last frame, resumed, or not shown by the overlay): measure it now.
      const view: Clip = { l: 0, t: 0, r: innerWidth, b: innerHeight };
      const cache = new Map<Element, Clip>();
      const { scope, top, pops, float } = this.scene(view);
      b = this.zoneBox(a, view, scope, cache);
      let hits = 4;
      if (b && top.length && !shows(b, this.covers(a.zone ?? a.el, [b], top, pops, float, () => hits-- > 0))) b = null;
    }
    return b ? new DOMRect(b[0], b[1], b[2], b[3]) : null;
  }

  onFrame(fn: () => void): () => void {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  }

  quiet(fn: () => void): void {
    if (!this.on) return fn();
    this.take(this.mo.takeRecords());
    try {
      fn();
    } finally {
      this.mo.takeRecords();
      this.invalidate(2); // swapped texts change width
    }
  }

  pause(on: boolean): void {
    if (on === this.paused) return;
    if (on) {
      this.setAlt(false);
      this.setHover(null);
      clearTimeout(this.plT);
      this.pl = null;
      this.pens = []; // hidden with the layer: none is pointed at on resume
    }
    this.paused = on;
    this.gs.g = this.gs.end = undefined;
    this.wrap.hidden = on;
    if (!on) {
      // Everything may have moved meanwhile: rectOf measures again until the next frame has.
      for (const r of this.recs.values()) r.f = 0;
      this.rehover();
      this.invalidate(2);
    }
  }

  invalidate(n = 2): void {
    if (n > this.settle) this.settle = n;
    if (!this.raf && this.live()) this.raf = requestAnimationFrame(this.frame);
  }

  // ---- events ----

  private live(): boolean {
    return this.on && !this.paused;
  }

  private move = () => this.invalidate(2);

  /** Events inside our own hosts are never touched. */
  private ours(path: EventTarget[]): boolean {
    if (path.includes(this.host)) return true;
    try {
      return this.o.ours().some((n) => path.includes(n));
    } catch {
      return false;
    }
  }

  /**
   * Whether a label is left alone: not loaded, not painted yet, or the last frame found none of its text
   * visible (only highlighted text is taken over: an icon whose label text is hidden works as usual).
   */
  private dead(a: Anchor): boolean {
    const r = this.recs.get(a);
    return !r || inert(r.look) || (r.f > 0 && !r.vis);
  }

  /** The pill drawn at `pt` after a live label (a pill takes no events: it is found by position); null when none is there. */
  private pillHit(pt: { x: number; y: number } | null): PillRec | null {
    if (pt) for (const p of this.pills) if (p.box && p.host && within(p.box, pt) && !this.dead(p.host)) return p;
    return null;
  }

  /**
   * The label whose zone holds the focused element (innermost first), for F2: the keyboard has no position, so the
   * whole zone counts, and in a zone of several parts of one text the first. Not-loaded ones don't count.
   */
  private zoneIn(path: EventTarget[]): Anchor | null {
    for (const n of path) {
      if (n === document.body || n === document.documentElement || n === document) break;
      const as = this.zones.get(n as Element)?.filter((a) => !this.dead(a));
      if (as?.length) return pickPart(as, (a) => this.recs.get(a)?.boxes ?? [], null);
    }
    return null;
  }

  /**
   * What a pointer over this path, at `pt`, is on in the label zones that hold the target (innermost first; not-loaded
   * labels don't count): a label when it is on its text (pickPart), or the one label of a zone whose text has no mark
   * this frame (not measured yet, or no line of it gets one: partly scrolled out of its container), whose whole zone
   * counts as before so that it stays reachable. Beside the text, zones further out are looked at for a text at the
   * point (an outer label's text over the inner zone); when none has it, false where something acts (a zone passed
   * through is a tab, a command, a navigation item…, holds a control, or a button, a link, a menu item… lies anywhere
   * from the target up: the click does nothing, never the page's command), else null (the page: a field label's
   * container, a section header, and in the navigation what only opens or closes: a group's header around its title,
   * its chevron, the area switcher; the form and view selectors' chevrons, which open their lists; an item of those
   * lists, which it picks). Null too on a text box or a resize handle in a zone, which keep working, and in the
   * entries a tree entry lists under it, which are not its own. Sets `zoned`.
   */
  private pointed(path: EventTarget[], pt: { x: number; y: number } | null): Anchor | null | false {
    let missed = false;
    let block = false;
    /** What the click does there (effect), once it is beside a text. */
    let act: Effect | undefined;
    for (const n of path) {
      if (n === document.body || n === document.documentElement || n === document) break;
      const as = this.zones.get(n as Element)?.filter((a) => !this.dead(a));
      if (!as?.length) continue;
      const z = n as Element;
      if (passes(path, z)) return null;
      if (nested(path, z)) continue;
      const marked = as.filter((a) => this.recs.get(a)?.boxes.length);
      if (marked.length) {
        this.zoned = true;
        const a = pt && pickPart(marked, (b) => this.recs.get(b)?.boxes ?? [], pt);
        if (a) return a;
      } else if (!missed && as.length === 1) return as[0];
      // Missed: beside its text. Or no mark to tell: between parts none of which is marked nothing says which one is
      // meant, and past a label whose text was missed a zone without marks would only be a guess. Either way the zone
      // still blocks when it acts.
      missed = true;
      // A zone that holds a form control is that control (a closed choice or Yes/No control, a chip with its ✕: labels
      // never hold one), so its own padding acts too. Neither counts where all that acts only opens or closes part of
      // the navigation (a group's title in its header, the area switcher), opens a list to pick from (the form or view
      // selector) or picks from one (an area, a form, a view): that happens as usual.
      act ??= effect(path);
      block ||= !harmless(act) && (as.some((b) => ACTIVE.has(b.role)) || !!z.querySelector(CONTROLS));
    }
    return missed && (block || act === 'acts') ? false : null;
  }

  /**
   * What a primary-button pointer event of type `t` is on, when translation takes it (not with Alt): a label, false
   * beside the text of one that acts (swallowed, nothing opens), null for the page (see pointed). A click released
   * beside the text, still in the zone of the label its press was on (a hand, a finger or a pen that moved a little), is
   * that label's: the text decides at the press, the zone at the release, as a drag out of it still opens nothing.
   */
  private here(m: MouseEvent, path: EventTarget[], t: string): Anchor | null | false {
    if (m.button !== 0 || m.altKey) return null;
    const a = this.hovered(path, { x: m.clientX, y: m.clientY });
    const g = this.gs.g;
    return t === 'click' && !a && g && !this.dead(g) && path.includes(g.zone ?? g.el) ? g : a;
  }

  /** Follows Alt from an event; Alt pressed inside our hosts (Alt+Down in a callout) does not count. */
  private altFrom(e: MouseEvent | KeyboardEvent, mine: boolean): void {
    if (e.altKey !== this.alt && (!e.altKey || !mine)) this.setAlt(e.altKey);
  }

  private onPtr = (e: Event): void => {
    const m = e as MouseEvent;
    const t = e.type;
    if (t === 'pointerup') this.invalidate(10); // things move after clicks (tabs, flyouts, sections)
    if (!this.live() || !e.isTrusted) return; // synthetic clicks (our own "Open" actions) reach the page
    const path = m.composedPath();
    const mine = this.ours(path);
    this.altFrom(m, mine);
    const d = decide(this.gs, t, mine ? null : this.here(m, path, t), m.detail);
    // Our own hosts always get their events, even at the end of a gesture that started on a label.
    if (!d.swallow || mine) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!d.open) return;
    try {
      this.o.open(d.open);
    } catch (err) {
      if (__DEV__) console.error('[translator] open', err);
    }
  };

  /**
   * Touch events of a gesture the translator took over (on a label's text, or beside the text of one that acts):
   * Dynamics' touch handlers (taps that sort or open) never see them.
   */
  private onTouch = (e: Event): void => {
    const g = this.gs.g;
    if (this.live() && e.isTrusted && g !== undefined && g !== null) e.stopImmediatePropagation();
  };

  private onOver = (e: PointerEvent): void => {
    if (!this.on) return;
    const path = e.composedPath();
    // Also while paused, so the label under the pointer is known on resume.
    this.path = path;
    this.pt = { x: e.clientX, y: e.clientY };
    if (!this.live()) return;
    this.altFrom(e, this.ours(path));
    this.setHover(this.alt ? null : this.hovered(path, this.pt) || null);
  };

  /**
   * What a pointer over this path, at `pt`, is on (pointed): a label's text, false beside the text of a label that acts,
   * null for the page. A pill on the page stands for the label it follows, wherever it lies, and so does a drawn pencil
   * where no text is. In a zone whose text is marked, or on a pencil, pointer moves are followed (onMove) until it
   * leaves: going onto the text or off it fires no pointerover.
   */
  private hovered(path: EventTarget[], pt: { x: number; y: number } | null): Anchor | null | false {
    this.zoned = false;
    const hit = this.pillHit(pt);
    const p = hit && !this.ours(path) ? hit : null;
    if (p !== this.onPill) {
      this.onPill = p; // its tooltip shows, or goes
      this.invalidate(1);
    }
    const a = p ? p.host : this.pointed(path, pt);
    const on = a ? null : this.penHit(pt);
    const pen = on && !this.ours(path) ? on : null;
    if (pen) this.zoned = true;
    this.follow();
    return pen ?? a;
  }

  /** The live label whose pencil the last frame drew at `pt` (a pencil takes no events: it is found by position). */
  private penHit(pt: { x: number; y: number } | null): Anchor | null {
    if (pt) for (const [a, b] of this.pens) if (within(b, pt) && !this.dead(a)) return a;
    return null;
  }

  /**
   * Listens to pointer moves only while they matter: Alt is held, the pointer is in a zone whose text is marked, or
   * pills are drawn (pointed at by position, without an event of their own).
   */
  private follow(): void {
    const want = this.alt || this.zoned || this.drawn;
    if (want === this.moving) return;
    this.moving = want;
    if (want) addEventListener('pointermove', this.onMove, PASSIVE);
    else removeEventListener('pointermove', this.onMove, true);
  }

  private onOut = (e: PointerEvent): void => {
    if (e.relatedTarget) return;
    this.path = null; // left the window (or went into a frame)
    this.zoned = false;
    this.follow();
    this.setHover(null);
  };

  /**
   * Only listened to while Alt is held (a move without Alt is its release: its keyup went to a frame or the browser),
   * the pointer is in a zone whose text is marked (whether it is on that text changes as it moves) or pills are drawn
   * (the pointer goes onto one without entering another element).
   */
  private onMove = (e: PointerEvent): void => {
    this.pt = { x: e.clientX, y: e.clientY };
    if (this.alt && !e.altKey) this.setAlt(false);
    else if ((this.zoned || this.drawn) && !this.alt && this.live() && this.path) this.setHover(this.hovered(this.path, this.pt) || null);
  };

  private onKey = (e: KeyboardEvent): void => {
    if (!this.live()) return;
    if (e.key === 'Alt') {
      if (!this.ours(e.composedPath())) this.setAlt(true);
      return;
    }
    if (this.alt && !e.altKey) this.setAlt(false); // its release was missed
    // F2 ("rename") translates the focused label: a tab, a button or a navigation item reached with Tab.
    if (e.key !== 'F2' || e.altKey || e.ctrlKey || e.metaKey || e.repeat || !e.isTrusted) return;
    const path = e.composedPath();
    const t = path[0];
    if (!(t instanceof Element) || this.ours(path)) return;
    if (t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && TEXTY.test((t as HTMLInputElement).type)))) return;
    const a = this.zoneIn(path) ?? this.within(t);
    if (!a) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    try {
      this.o.open(a);
    } catch (err) {
      if (__DEV__) console.error('[translator] open', err);
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (this.alt && (e.key === 'Alt' || !e.altKey)) this.setAlt(false);
  };

  /** The window lost focus or the tab was hidden: Alt's release may never arrive. */
  private reset = (): void => {
    this.setAlt(false);
    this.gs.g = this.gs.end = undefined;
  };

  /** The one label inside a focused element (e.g. a button around the label's text); null when there are several. */
  private within(t: Element): Anchor | null {
    if (t === document.body || t === document.documentElement) return null;
    let found: Anchor | null = null;
    for (const a of this.recs.keys()) {
      if (this.dead(a) || !t.contains(a.zone ?? a.el)) continue;
      if (found && found.comp !== a.comp) return null;
      found ??= a;
    }
    return found;
  }

  private setAlt(held: boolean): void {
    if (held === this.alt) return;
    this.alt = held;
    this.follow();
    this.wrap.classList.toggle('is-alt', held);
    if (held) this.setHover(null);
    else this.rehover();
    this.invalidate(1);
    try {
      this.o.alt?.(held);
    } catch (e) {
      if (__DEV__) console.error('[translator] alt', e);
    }
  }

  private setHover(a: Anchor | null): void {
    if (a === this.hover) return;
    this.hover = a;
    this.setCursor(!!a);
    this.invalidate(1);
  }

  /** The label under the pointer, from its last path and position: none while Alt is held or once that element is gone. */
  private under(): Anchor | null {
    const p = this.path;
    const n = p?.[0] as Node | undefined;
    return (this.live() && !this.alt && p && n?.isConnected && this.hovered(p, this.pt)) || null;
  }

  /** Finds the hovered label again from the last pointer position. */
  private rehover(): void {
    this.setHover(this.under());
  }

  private setCursor(on: boolean): void {
    if (on === this.cursor) return;
    this.cursor = on;
    try {
      this.sheet?.replaceSync(on ? CURSOR : '');
    } catch {
      /* no pointer cursor */
    }
  }

  private take(recs: MutationRecord[]): void {
    if (!recs.length) return;
    for (const r of recs) {
      if (r.type !== 'childList') this.roots.add(r.target);
      else {
        r.addedNodes.forEach((n) => this.roots.add(n));
        if (r.removedNodes.length) this.removed = true;
      }
    }
    this.layerEls = this.portalEls = null;
    this.invalidate(10);
    if (!this.timer)
      this.timer = window.setTimeout(() => {
        this.timer = 0;
        const roots = [...this.roots];
        const rm = this.removed;
        this.roots.clear();
        this.removed = false;
        this.watchShadows(); // a header strip rendered meanwhile
        this.o.mutated(roots, rm);
      }, 90);
  }

  /** Observes the open shadow roots that hold labels: the page's observer doesn't see inside them. */
  private watchShadows(): void {
    for (const el of document.querySelectorAll(SHADOW_HOSTS)) {
      const r = el.shadowRoot;
      if (!r || this.shadows.has(r)) continue;
      this.shadows.add(r);
      this.mo.observe(r, WATCH);
    }
  }

  // ---- frame: every read, then every write ----

  private frame = (): void => {
    this.raf = 0;
    if (!this.live()) return;
    const n = ++this.fno;
    const view: Clip = { l: 0, t: 0, r: innerWidth, b: innerHeight };
    const dpr = devicePixelRatio || 1;
    const cache = new Map<Element, Clip>();
    const { scope, top, pops, float } = this.scene(view);
    let hits = MAX_HITS;
    for (const r of this.recs.values()) {
      r.f = n;
      r.zone = null;
      r.boxes = [];
      r.masks = [];
      r.vis = true;
      const a = r.a;
      const z = a.zone ?? a.el;
      const box = this.zoneBox(a, view, scope, cache);
      if (!box) continue;
      let boxes: Box[] = [];
      let vis = true;
      if (!inert(r.look)) {
        this.seen = false;
        boxes = this.textBoxes(r, z, view, cache, dpr);
        vis = this.seen;
      }
      // What lies over a label is decided on its text (a wide heading or a multi-select's row can reach under a side
      // pane or a popup while its text doesn't), and only that part of its marks is cut away: they lie under the page's
      // popups.
      const over = top.length ? this.covers(z, boxes.length ? boxes : [box], top, pops, float, () => hits-- > 0) : [];
      if (over.length) {
        const keep: Box[] = [];
        const cut: string[] = [];
        for (const b of boxes) {
          const m = maskOf(b, over, dpr);
          if (m === null) continue;
          keep.push(b);
          cut.push(m);
        }
        if (boxes.length ? !keep.length : !shows(box, over)) continue; // nothing of it is left
        boxes = keep;
        r.masks = cut;
      }
      r.zone = box;
      r.boxes = boxes;
      r.vis = vis;
    }
    // Pills go after the text measured above, clear of every mark; a label's pencil goes after its pill.
    const after = new Map<Anchor, Box>();
    if (this.pills.length) {
      const drawn: Array<[Anchor, Box]> = [];
      for (const r of this.recs.values()) for (const b of r.boxes) drawn.push([r.a, b]);
      for (const p of this.pills) {
        this.pillAt(p, view, cache, dpr, top, drawn);
        if (p.host && p.box) after.set(p.host, p.box);
      }
    }
    const any = this.pills.some((p) => !!p.box);
    if (any !== this.drawn) {
      this.drawn = any;
      this.follow();
    }
    // A pencil is after its label's last mark, or after its pill. None on a selector's own label (lists.ts): it would lie
    // over the chevron, which opens the list, and take its click (the hover ring says the name can be clicked).
    const penAt = (r: Rec): Box | null =>
      inert(r.look) || !r.boxes.length || (r.a.sw && !r.a.sw.id) ? null : badgeBox(after.get(r.a) ?? r.boxes[r.boxes.length - 1], view, dpr);
    // The pencils drawn last frame follow their text, so that a pointer resting on one keeps its label hovered below.
    this.pens = this.pens.flatMap(([a]): Array<[Anchor, Box]> => {
      const r = this.recs.get(a);
      const b = r && penAt(r);
      return b ? [[a, b]] : [];
    });
    // The text moved under a pointer that didn't (a scroll, a layout change: no pointer event says so), or the hovered
    // label's text went away (it is left alone now): the label under the pointer is found again on this frame's marks.
    // Its pointer cursor is written with the marks.
    this.hover = this.under();
    // Where the pencil of a hovered or active label can go, read here: like a pill, never over a popup that doesn't hold
    // the label, except one the label itself floats over (an option of a dropdown opened from the header flyout).
    const penOk = new Map<Rec, boolean>();
    const pens: Array<[Anchor, Box]> = [];
    for (const r of this.recs.values()) {
      const act = !!this.act && r.a.comp === this.act && (this.actA === undefined || r.a === this.actA);
      if (r.a !== this.hover && !act) continue;
      const b = penAt(r);
      if (!b) continue;
      const ok = !top.length || !this.covers(r.a.zone ?? r.a.el, [b], top, pops, float, () => hits-- > 0).length;
      penOk.set(r, ok);
      if (ok) pens.push([r.a, b]);
    }
    this.pens = pens;
    // Write phase.
    this.setCursor(!!this.hover);
    for (const r of this.recs.values()) {
      const live = !inert(r.look);
      const hv = live && r.a === this.hover;
      const act = live && !!this.act && r.a.comp === this.act && (this.actA === undefined || r.a === this.actA);
      const fl = live && !!this.fl && r.a.comp === this.fl;
      const pl = live && r.a === this.pl;
      this.draw(r, `g is-${r.look || 'na'}${hv ? ' is-hv' : ''}${act ? ' is-act' : ''}${fl ? ' is-fl' : ''}${pl ? ' is-pl' : ''}`, hv || act, view, dpr, penOk.get(r) ?? false, after.get(r.a));
    }
    for (const p of this.pills) this.drawPill(p);
    this.drawTip(view, dpr);
    for (const fn of this.subs)
      try {
        fn();
      } catch (e) {
        if (__DEV__) console.error('[translator] overlay frame', e);
      }
    if (--this.settle > 0 && !this.raf) this.raf = requestAnimationFrame(this.frame);
  };

  /**
   * The open layers: `scope` = where labels can show while a modal is open (the topmost visible modal, the popups on
   * top, such as a dropdown opened from the modal and rendered outside it, and what portals paint over the modal, found
   * by a hit test: a flyout left open behind the modal is not); `top` = the popups drawn on top of the page; `pops` =
   * every visible popup; `float` = the places where a label floats over the page itself (the modal and the portal roots).
   */
  private scene(view: Clip): { scope: Element[] | null; top: [Element, DOMRect][]; pops: [Element, DOMRect][]; float: Element[] } {
    this.layerEls ??= [...document.querySelectorAll(LAYERS)];
    if (!this.portalEls) {
      const ps = [...document.querySelectorAll(PORTALS)];
      this.portalEls = ps.filter((p) => !ps.some((q) => q !== p && q.contains(p)));
    }
    let modal: Element | null = null;
    const pops: [Element, DOMRect][] = [];
    for (const p of this.layerEls) {
      if (!p.isConnected) continue;
      const r = p.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || (p.checkVisibility && !p.checkVisibility(VIS))) continue;
      if (p.getAttribute('aria-modal') === 'true') modal = p;
      else pops.push([p, r]);
    }
    const lay = this.onTop(pops, view);
    // What portals paint is on top of the page wherever it is, whatever its role (the header fields flyout has none), and
    // so is what another tool puts on the page (another bookmarklet's panel) where a hit test finds it on top.
    const other = this.panels(this.portalEls);
    const fl = this.floats(view, [...this.portalEls, ...other], new Set(other)).filter((f) => !pops.some(([q]) => q === f[0]));
    pops.push(...fl);
    const top = [...lay, ...fl];
    // With a modal open only what lies over it widens where labels show: one hit test at the centre of each float. Not
    // against `pops`: the floats are in it, and the modal's own painted surface can be one of them.
    const m = modal;
    const over = m
      ? fl.filter(([f, r]) => {
          if (m.contains(f)) return false;
          const b = isect(r, view);
          if (!b) return false;
          const hit = document.elementFromPoint(b[0] + b[2] / 2, b[1] + b[3] / 2);
          return !hit || !document.body.contains(hit) || f.contains(hit) || lay.some(([q]) => q.contains(hit));
        })
      : [];
    return { scope: m ? [m, ...lay.map(([p]) => p), ...over.map(([p]) => p)] : null, top, pops, float: m ? [m, ...this.portalEls] : this.portalEls };
  }

  /**
   * What portals paint now (newest root first): in each, the outermost elements that show on screen and paint a
   * background or a shadow (a flyout, a callout, a dropdown, a tooltip). Wrappers without a box, transparent ones,
   * hidden ones and the window-sized layers Fluent puts popups in (as wide and as high as the window) are looked through.
   * A painted element as wide or as high as the window only (a flyout on a narrow window) is looked into first, and
   * counts itself when nothing in it does. Breadth first, MAX_DEPTH levels deep, each root with its own share of the
   * visits (MAX_VISITS among them, at least 16 each, twice MAX_VISITS in all): a large newer portal never hides an older
   * one's flyout. Paint, not a hit test: a tooltip that takes no pointer events still lies over the page, and a
   * transparent wrapper that takes them doesn't.
   * Another tool's panel (`panels`) is not Dynamics' and keeps no rule of its portals: there the outermost painted
   * element that is not as large as the window counts as a whole (a side panel as high as the window, gaps between its
   * cards included), a frame or an image counts as painted, and it covers only where a hit test at its centre finds it
   * on top of the page (one that lies under the page, or takes no pointer events, leaves the marks as they are).
   * Shadow roots are looked into (a bookmarklet often draws its panel in one).
   */
  private floats(view: Clip, all: readonly Element[], other: ReadonlySet<Element>): [Element, DOMRect][] {
    const out: [Element, DOMRect][] = [];
    const w = view.r - view.l;
    const ht = view.b - view.t;
    const roots = all.filter((p) => p.isConnected);
    const share = Math.max(16, Math.ceil(MAX_VISITS / Math.max(1, roots.length)));
    let total = 2 * MAX_VISITS;
    /** A painted element as wide or as high as the window, whose subtree is looked into first. */
    type Wide = { el: Element; r: DOMRect; up: Wide | null; found: boolean };
    const found = (x: Wide | null): void => {
      for (; x && !x.found; x = x.up) x.found = true;
    };
    for (let i = roots.length - 1; i >= 0 && total > 0; i--) {
      const root = roots[i];
      const tool = other.has(root);
      let left = Math.min(share, total);
      const wides: Wide[] = [];
      const queue: Array<[Element, number, Wide | null]> = [[root, 0, null]];
      for (let k = 0; k < queue.length && left > 0; k++) {
        const [el, depth, wd] = queue[k];
        left--;
        total--;
        // Not rendered, or opacity 0: nothing in it shows. A display:contents wrapper has no box of its own: look inside.
        if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true }) && getComputedStyle(el).display !== 'contents') continue;
        const r = el.getBoundingClientRect();
        const wideW = r.width >= 0.9 * w;
        const wideH = r.height >= 0.9 * ht;
        let up = wd;
        const b = isect(r, view);
        if (b && !(wideW && wideH) && (!el.checkVisibility || el.checkVisibility(VIS)) && (painted(el) || (tool && REPLACED.test(el.tagName)))) {
          if (tool) {
            // Another tool's panel: as a whole, where it is on top of the page.
            const hit = document.elementFromPoint(b[0] + b[2] / 2, b[1] + b[3] / 2);
            if (hit && (root === hit || root.contains(hit) || el.contains(hit))) out.push([el, r]);
            continue;
          }
          if (!wideW && !wideH) {
            out.push([el, r]);
            found(wd);
            continue;
          }
          wides.push((up = { el, r, up: wd, found: false }));
        }
        if (depth >= MAX_DEPTH) continue;
        const kids = el.shadowRoot ? [...el.children, ...el.shadowRoot.children] : el.children;
        for (let j = kids.length - 1; j >= 0 && queue.length - k - 1 < left; j--) queue.push([kids[j], depth + 1, up]);
      }
      // Innermost first: a wide element with nothing painted in it is what covers.
      for (let j = wides.length - 1; j >= 0; j--)
        if (!wides[j].found) {
          out.push([wides[j].el, wides[j].r]);
          found(wides[j].up);
        }
    }
    return out;
  }

  /**
   * What other tools put on the page (another bookmarklet's panel): the children of <html> and <body> that hold none of
   * the labels, are no portal root and are not the translator's own (its hosts are dxt-* elements, and this overlay's).
   * Dynamics' own page holds the labels, so it is never one of them. Read every frame: a panel comes and goes as it likes.
   */
  private panels(portals: readonly Element[]): Element[] {
    const html = document.documentElement;
    const body = document.body;
    // The child of <html> or <body> each label is in, through the shadow roots that hold some (the header strip).
    const held = new Set<Element>();
    for (const a of this.recs.keys()) {
      let n: Element | null = a.zone ?? a.el;
      while (n) {
        const p: Element | null = n.parentElement ?? ((n.parentNode as ShadowRoot | null)?.host ?? null);
        if (!p || p === body || p === html) break;
        n = p;
      }
      if (n) held.add(n);
    }
    const out: Element[] = [];
    for (const p of [html, body]) {
      if (!p) continue;
      for (const el of p.children) {
        if (el === this.host || NOT_PANEL.test(el.tagName) || /^dxt-/i.test(el.tagName) || portals.includes(el) || held.has(el)) continue;
        out.push(el);
      }
    }
    return out;
  }

  /** Popups drawn on top of the page: one hit test at the centre of each (our own hosts there count as on top). */
  private onTop(pops: [Element, DOMRect][], view: Clip): [Element, DOMRect][] {
    return pops.filter(([, r]) => {
      const b = isect(r, view);
      if (!b) return false;
      const hit = document.elementFromPoint(b[0] + b[2] / 2, b[1] + b[3] / 2);
      return !hit || !document.body.contains(hit) || pops.some(([q]) => q.contains(hit));
    });
  }

  /**
   * The popups on top drawn over a label, as viewport boxes: each one that meets its `boxes` (its marks with their ring,
   * or its zone) and neither holds the label nor lies inside it. A label that floats itself (in another popup, the modal
   * or a portal: a dropdown opened from the header flyout lies over the flyout's labels, a painted backdrop under them
   * doesn't) is under one only where a hit test where they meet finds that one, while `budget` allows.
   */
  private covers(z: Element, boxes: readonly Box[], top: [Element, DOMRect][], pops: [Element, DOMRect][], float: Element[], budget: () => boolean): Box[] {
    const out: Box[] = [];
    for (const [p, pr] of top) {
      const q = boxOf(pr);
      const b = boxes.find((m) => meets(grow(m, RING), q));
      if (!b || p.contains(z) || z.contains(p)) continue;
      if (pops.some(([o]) => o !== p && o.contains(z)) || float.some((o) => o.contains(z))) {
        const g = grow(b, RING);
        const c = isect({ left: g[0], top: g[1], right: g[0] + g[2], bottom: g[1] + g[3] }, { l: pr.left, t: pr.top, r: pr.right, b: pr.bottom });
        if (!c || !budget()) continue;
        const hit = document.elementFromPoint(c[0] + c[2] / 2, c[1] + c[3] / 2);
        if (!hit || !p.contains(hit)) continue;
      }
      out.push(q);
    }
    return out;
  }

  /**
   * The visible part of a label's zone; null when off-screen, outside the open modal, hidden or clipped away.
   * The zone decides, not `el`: a grid header's `el` can be the hidden copy of its text.
   */
  private zoneBox(a: Anchor, view: Clip, scope: Element[] | null, cache: Map<Element, Clip>): Box | null {
    const z = a.zone ?? a.el;
    if (!z.isConnected || (scope && !scope.some((s) => s.contains(z)))) return null;
    const r = z.getBoundingClientRect();
    // Off-screen: nothing else is read.
    if (r.right <= view.l || r.bottom <= view.t || r.left >= view.r || r.top >= view.b) return null;
    if (z.checkVisibility && !z.checkVisibility(VIS)) return null;
    return isect(r, this.clipFor(z, view, cache).c);
  }

  /**
   * The marks of a label: the line boxes of its text, on the copy of the text that shows (the Power Apps grid
   * renders every header and value twice, once hidden). Without a text node: the first text with letters or
   * digits inside `el`, kept inside `el`. Never the box of an element: nothing is drawn when no text shows.
   */
  private textBoxes(r: Rec, z: Element, view: Clip, cache: Map<Element, Clip>, dpr: number): Box[] {
    const a = r.a;
    // A closed native choice control: the text it shows is its selected option's, which has no box of its own.
    const sel = [a.el, z].find((e): e is HTMLSelectElement => e.tagName === 'SELECT');
    if (sel) return this.selectBoxes(sel, view, cache, dpr) ?? [];
    const own = a.text?.isConnected && z.contains(a.text) ? a.text : null;
    // The header title, the table name and other large elements: only their text, never past the element.
    const keep = !a.text && a.el.isConnected ? a.el : null;
    if (r.tx && r.tx !== own && r.tx.isConnected && z.contains(r.tx)) {
      const l = this.boxesOf(r.tx, z, view, cache, dpr, keep, a.part);
      if (l) return l;
    }
    r.tx = null;
    if (own) {
      const l = this.boxesOf(own, z, view, cache, dpr, null, a.part);
      if (l) return l;
    }
    // Another copy of the same text in the zone; without a text node, the first text with letters in `el`.
    const ref = a.text ? norm(a.text.nodeValue) : '';
    const root = keep ?? (a.el.isConnected && !z.contains(a.el) ? a.el : z);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let i = 0, t = w.nextNode() as Text | null; t && i < 60 && seen < 4; i++, t = w.nextNode() as Text | null) {
      if (t === own) continue;
      const v = norm(t.nodeValue);
      if (ref ? v !== ref : !MEANT.test(v)) continue;
      seen++;
      const l = this.boxesOf(t, z, view, cache, dpr, keep, a.part);
      if (l) {
        r.tx = t;
        return l;
      }
    }
    return [];
  }

  /**
   * The marks of one text node, or of `part` of it (kept inside `keep` when given), or null when it doesn't show
   * (hidden, clipped away, or the part's characters are no longer there). Sets `seen` when a line of it is inside
   * what clipping leaves, even one too cut to get a mark.
   */
  private boxesOf(t: Text, z: Element, view: Clip, cache: Map<Element, Clip>, dpr: number, keep: Element | null, part?: Part): Box[] | null {
    const p = t.parentElement;
    if (!p) return null;
    // An option's text (a status reason control wrapping a native select): the select shows it.
    if (p.tagName === 'OPTION' || p.tagName === 'OPTGROUP') {
      const s = p.closest('select');
      return s ? this.selectBoxes(s, view, cache, dpr) : null;
    }
    if (p !== z && p.checkVisibility && !p.checkVisibility(VIS)) return null;
    const range = (this.range ??= document.createRange());
    if (!part) range.selectNodeContents(t);
    else {
      // Dynamics re-rendered the text since it was scanned: nothing until the rescan.
      if ((t.nodeValue || '').slice(part.start, part.end) !== part.text) return null;
      range.setStart(t, part.start);
      range.setEnd(t, part.end);
    }
    const { c, hard } = this.clipFor(p, view, cache);
    if (keep) {
      const e = keep.getBoundingClientRect();
      // A display:contents element has no box of its own: nothing to keep the text inside.
      if (e.width >= 1 && e.height >= 1) cut(c, { l: e.left, t: e.top, r: e.right, b: e.bottom });
    }
    const rects = range.getClientRects();
    for (let i = 0; i < rects.length && !this.seen; i++) if (isect(rects[i], c)) this.seen = true;
    const out = marks(rects, c, dpr, MAX_LINES, hard);
    return out.length ? out : null;
  }

  /**
   * The mark of a closed native <select>: the text of its selected option, which is not laid out (a closed
   * select's options have no boxes). Measured in the select's font, at the start of its content box, one line
   * high and centred in it, never past it; null when no option with text is selected or it is clipped away.
   */
  private selectBoxes(s: HTMLSelectElement, view: Clip, cache: Map<Element, Clip>, dpr: number): Box[] | null {
    const o = s.selectedOptions?.[0] ?? s.options?.[s.selectedIndex];
    const text = norm(o?.text ?? '');
    if (!MEANT.test(text)) return null;
    const cs = getComputedStyle(s);
    const px = (v: string) => parseFloat(v) || 0;
    const b = s.getBoundingClientRect();
    const box: Clip = {
      l: b.left + px(cs.borderLeftWidth) + px(cs.paddingLeft),
      t: b.top + px(cs.borderTopWidth) + px(cs.paddingTop),
      r: b.right - px(cs.borderRightWidth) - px(cs.paddingRight),
      b: b.bottom - px(cs.borderBottomWidth) - px(cs.paddingBottom),
    };
    if (box.r - box.l < 2 || box.b - box.t < 2) return null;
    const size = px(cs.fontSize) || 14;
    const w = Math.min(box.r - box.l, this.measure(text, `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`) ?? text.length * size * 0.55);
    const lh = Math.min(box.b - box.t, Math.round(size * 1.3));
    const top = box.t + (box.b - box.t - lh) / 2;
    const left = cs.direction === 'rtl' ? box.r - w : box.l;
    const line = { left, top, right: left + w, bottom: top + lh };
    const { c, hard } = this.clipFor(s, view, cache);
    cut(c, box);
    if (isect(line, c)) this.seen = true;
    const out = marks([line], c, dpr, 1, hard);
    return out.length ? out : null;
  }

  /**
   * Places a pill after the text of the first of its labels that shows (the field's value, else its label): in full
   * where there is room, else its count alone. Always inside its field and the scrolling containers around it, never
   * over another label's mark or under an open popup of the page, and after the label never over the field's value
   * control. None when nothing fits, and none while Alt is held (the page works as usual). `drawn`: this frame's marks.
   */
  private pillAt(p: PillRec, view: Clip, cache: Map<Element, Clip>, dpr: number, top: [Element, DOMRect][], drawn: ReadonlyArray<[Anchor, Box]>): void {
    p.host = p.box = null;
    p.short = false;
    const f = p.p.field;
    if (this.alt || !f.isConnected) return;
    const fr = f.getBoundingClientRect();
    // A display:contents container has no box of its own: nothing to keep the pill inside.
    const room = fr.width >= 1 && fr.height >= 1 ? this.inner(f) : null;
    // The value controls shown: a choice control is its value's zone.
    const values: Box[] = [];
    for (const a of p.p.at) {
      const z = a.role === 'value' ? this.recs.get(a)?.zone : null;
      if (z) values.push(z);
    }
    for (const a of p.p.at) {
      const r = this.recs.get(a);
      if (!r?.zone || !r.vis || !r.boxes.length || inert(r.look)) continue;
      const z = a.zone ?? a.el;
      // The containers around the label clip it, not the label itself: a pill may lie past a value's text box.
      const clip = { ...this.clipFor(z.parentElement ?? z, view, cache).hard };
      if (room) cut(clip, room);
      // After a label, inside the label's own column: never over a control, even an empty one ("---", no value anchor).
      const col = a.role === 'value' ? null : this.columnOf(z, f);
      const cb = col?.getBoundingClientRect();
      if (col && cb && cb.width >= 1 && cb.height >= 1) cut(clip, this.inner(col));
      const end = this.endOf(r, f);
      const free = (b: Box): boolean =>
        !top.some(([q, qr]) => !q.contains(z) && isect({ left: b[0], top: b[1], right: b[0] + b[2], bottom: b[1] + b[3] }, { l: qr.left, t: qr.top, r: qr.right, b: qr.bottom })) &&
        !drawn.some(([o, m]) => o !== a && meets(b, m)) &&
        (a.role === 'value' || !values.some((v) => meets(b, v)));
      for (const short of [false, true]) {
        const b = pillBox(end, this.pillWidth(short ? String(p.p.n) : p.p.text, short), clip, dpr);
        if (!b || !free(b)) continue;
        p.host = a;
        p.box = b;
        p.short = short;
        return;
      }
    }
  }

  /**
   * A label's own part of its field: its outermost container inside the field that holds no form control (the label
   * column of a label-left form); null when there is none (the label is the field's child). Kept until the next sync.
   */
  private columnOf(z: Element, field: Element): Element | null {
    let c = this.cols.get(z);
    if (c === undefined) {
      c = null;
      for (let n = z.parentElement; n && n !== field && field.contains(n) && !n.querySelector(CONTROLS); n = n.parentElement) c = n;
      this.cols.set(z, c);
    }
    return c;
  }

  /**
   * What a pill follows: a multi-select's chip whole, its ✕ included (a value whose zone is a list item); a value's last
   * line of text; a label's last line, past the required "*" or recommended "+" the form draws right after it.
   */
  private endOf(r: Rec, field: Element): Box {
    const a = r.a;
    const last = r.boxes[r.boxes.length - 1];
    if (a.role === 'value') return r.zone && a.zone && a.zone !== a.el && a.zone.tagName === 'LI' ? r.zone : last;
    const own = r.tx ?? a.text;
    if (!own?.isConnected) return last;
    // The first text with letters, digits or a marker after the label's own text, in the field.
    const w = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
    let past = false;
    for (let i = 0, t = w.nextNode() as Text | null; t && i < 80; i++, t = w.nextNode() as Text | null) {
      if (!past) {
        past = t === own;
        continue;
      }
      const v = norm(t.nodeValue);
      if (!v) continue;
      if (!MARKER.test(v)) return last;
      const range = (this.range ??= document.createRange());
      range.selectNodeContents(t);
      const rs = range.getClientRects();
      let right = last[0] + last[2];
      for (let j = 0; j < rs.length; j++) {
        const q = rs[j];
        const mid = (q.top + q.bottom) / 2;
        // On the last line, just after the text.
        if (mid >= last[1] && mid <= last[1] + last[3] && q.left >= right - PAD_X - 1 && q.left <= right + MARKER_GAP) right = Math.max(right, q.right + PAD_X);
      }
      return [last[0], last[1], right - last[0], last[3]];
    }
    return last;
  }

  /** A pill's width: its text with its padding, or its count alone (at least as wide as it is high). */
  private pillWidth(text: string, short = false): number {
    const t = this.width(text, PILL_FONT);
    return short ? Math.max(PILL_H, t + 2 * PILL_PAD_N + 1) : t + 2 * PILL_PAD + 1;
  }

  /** A text's width in a CSS font (a canvas measure, kept), or about 6.5 px per character without a canvas. */
  private width(text: string, font: string): number {
    const k = `${font}|${text}`;
    let w = this.widths.get(k);
    if (w === undefined) this.widths.set(k, (w = Math.ceil(this.measure(text, font) ?? text.length * 6.5)));
    return w;
  }

  /** Writes a pill: its place, and its text in full or its count alone. */
  private drawPill(p: PillRec): void {
    const el = p.el;
    const cls = `pill is-${p.p.tone}${p.short ? ' is-n' : ''}`;
    if (el.className !== cls) el.className = cls;
    const t = p.short ? String(p.p.n) : p.p.text;
    if (el.textContent !== t) el.textContent = t;
    this.place(el, p.box);
  }

  /** The tooltip of the pill under the pointer: its full text, just above it (below it at the top), inside the window. */
  private drawTip(view: Clip, dpr: number): void {
    const p = this.onPill;
    const b = p && this.pills.includes(p) && p.host === this.hover ? p.box : null;
    if (!p || !b) return this.place(this.tip, null);
    const t = p.p.title;
    if (this.tip.textContent !== t) this.tip.textContent = t;
    const px = (v: number) => Math.round(v * dpr) / dpr;
    const w = Math.min(this.width(t, TIP_FONT) + 2 * TIP_PAD + 1, view.r - view.l - 8);
    const x = Math.max(view.l + 4, Math.min(b[0], view.r - 4 - w));
    const y = b[1] - 4 - TIP_H >= view.t ? b[1] - 4 - TIP_H : b[1] + b[3] + 4;
    this.place(this.tip, [px(x), px(y), w, TIP_H]);
  }

  /** The width of a text in a CSS font (a canvas measure); undefined without a canvas. */
  private measure(text: string, font: string): number | undefined {
    if (this.c2d === undefined)
      try {
        this.c2d = document.createElement('canvas').getContext('2d');
      } catch {
        this.c2d = null;
      }
    if (!this.c2d) return undefined;
    this.c2d.font = font;
    return this.c2d.measureText(text).width;
  }

  /** The viewport cut by the element's own overflow and that of its clipping containers (their padding boxes: borders and scroll bars hide content). */
  private clipFor(el: Element, view: Clip, cache: Map<Element, Clip>): Clips {
    const c = { ...view };
    const hard = { ...view };
    for (const [p, scrolls] of this.clipOf(el)) {
      let r = cache.get(p);
      if (!r) cache.set(p, (r = this.inner(p)));
      cut(c, r);
      if (scrolls) cut(hard, r);
    }
    return { c, hard };
  }

  /** An element's padding box in viewport pixels (its border box when transformed or without a box of its own). */
  private inner(p: Element): Clip {
    const b = p.getBoundingClientRect();
    const ow = (p as HTMLElement).offsetWidth;
    if ((!p.clientWidth && !p.clientHeight) || (ow !== undefined && Math.abs(ow - b.width) > 1)) return { l: b.left, t: b.top, r: b.right, b: b.bottom };
    const l = b.left + p.clientLeft;
    const t = b.top + p.clientTop;
    return { l, t, r: l + p.clientWidth, b: t + p.clientHeight };
  }

  /**
   * The element itself when it clips, then its clipping ancestors (a fixed element ends the chain), each with
   * whether it scrolls. Cached per element, so labels in the same containers share the style reads.
   */
  private clipOf(el: Element): ClipEl[] {
    let c = this.clips.get(el);
    if (!c) {
      c = [];
      if (el !== document.body && el !== document.documentElement) {
        const s = getComputedStyle(el);
        const x = s.overflowX;
        const y = s.overflowY;
        // Overflow does not apply to inline boxes and display:contents elements.
        if ((x !== 'visible' || y !== 'visible') && s.display !== 'inline' && s.display !== 'contents') c.push([el, /^(auto|scroll)$/.test(x) || /^(auto|scroll)$/.test(y)]);
        // A label in an open shadow root (the header strip) is clipped by the containers around its host too.
        const p = el.parentElement ?? ((el.parentNode as ShadowRoot | null)?.host || null);
        if (p && s.position !== 'fixed') c = c.concat(this.clipOf(p));
      }
      this.clips.set(el, c);
    }
    return c;
  }

  /**
   * Writes a label's classes, its marks (cut where a popup lies over them) and, when hovered or active, the pencil badge
   * at the end of its last line (after `tail`, its pill, when it has one), where `penOk` (frame read it: no popup there).
   */
  private draw(r: Rec, cls: string, pen: boolean, view: Clip, dpr: number, penOk: boolean, tail?: Box): void {
    if (r.g.className !== cls) r.g.className = cls;
    const n = r.boxes.length;
    while (r.marks.length < n) {
      const m = h('i', { hidden: true });
      r.g.append(m);
      r.marks.push(m);
    }
    for (let i = 0; i < r.marks.length; i++) this.place(r.marks[i], i < n ? r.boxes[i] : null, r.masks[i]);
    const last = pen && n ? (tail ?? r.boxes[n - 1]) : null;
    if (last && !r.pen) r.g.append((r.pen = h('b', { class: 'pn', hidden: true })));
    if (!r.pen) return;
    const b = last && badgeBox(last, view, dpr);
    // Like a pill, never over a popup that doesn't hold the label: a cut circle would read as a glitch.
    this.place(r.pen, b && penOk ? b : null);
  }

  /** Shows an element at a box (hidden without one), cut by `mask` (a clip-path, '' = none). */
  private place(el: HTMLElement, b: Box | null, mask = ''): void {
    const k = b ? `${b.join()}|${mask}` : '';
    if (this.placed.get(el) === k) return;
    this.placed.set(el, k);
    el.hidden = !b;
    if (!b) return;
    const s = el.style;
    s.transform = `translate(${b[0]}px,${b[1]}px)`;
    s.width = `${b[2]}px`;
    s.height = `${b[3]}px`;
    s.clipPath = mask;
  }
}
