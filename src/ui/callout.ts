// The popup: a small Fluent dialog next to a label on the page (ARCHITECTURE §5.4, Popup). It shows the
// texts of one component (a field's form label, tooltip and column name, a column's name, its choices…) with one
// plain input per shown language, the base language first. Every keystroke is staged in the store: nothing is
// saved here, the bar's "Review and publish" saves and publishes every staged change at once. Done, Enter, Esc and
// a click outside close it and keep the text; "Undo changes" puts back what the texts were when it opened. It
// never writes to Dataverse and never touches the Dynamics DOM: it lives in the app layer of our shadow root.

import { isRtl, lcidName, lcidTag } from '../core/lcid';
import { canClear, isManaged, keepsEmpty, namesFirst, noneText, noStandIn, savedEmptyText, savesEmpty, stays, type Lcid, type Slot } from '../core/model';
import type { Store } from '../core/store';
import { shownLanguage } from '../core/uilang';
import { columnOf } from '../inspector/column';
import { navSource } from '../inspector/fallback';
import { choiceNote, choicesNote } from '../inspector/pill';
import type { Block, CalloutModel, OpenCallout } from '../inspector/types';
import css from './callout.css';
import { h, icon, put, rafThrottle } from './dom';
import { becomesText, langName, notLoaded } from './editor';
import { whenEmpty } from './undo';
import { active, btn, ibtn, link, modalOpen, pushLayer, spinner, tooltip } from './widgets';

/** Viewport margin around the popup. */
const M = 8;
/** Distance from the label: an 8 px gap plus the beak (a 12 px square turned 45°, about 8.5 px deep). */
const OFF = 16;
/** Gap between a docked popup and the bar. */
const BAR_GAP = 12;
/** Room under (or over) the label below which the popup may cover the label (very small windows only). */
const MIN_ROOM = 160;
/**
 * A popup already below (or above) its label stays on that side while it lacks at most this much room there (its body
 * scrolls that much), and, while it fits on neither side, until the other side has this much more room.
 */
const STICK = 48;
/** Frames in a row an opening popup's place must hold before it shows (settle). */
const STEADY = 2;
/** The longest an opening popup stays hidden (ms): then it shows wherever it is. */
const WAIT_MAX = 300;
/** A multi-line text grows from 1 to 4 lines (20 px lines, 10 px padding, 2 px border). */
const MAX_H = 92;
const FS = typeof CSS !== 'undefined' && !!CSS.supports?.('field-sizing', 'content');
/** Our own layers in the app root: a pointer down in a menu, a dialog or a toast is not "outside". */
const LAYERS = ['pop', 'scrim', 'tip', 'toast', 'toasts'];
let ids = 0;

// ---- pure helpers (unit tested in tools/dev/tests/callout.ts) ----

/** The id of a cell, the same as providers/types changeId() of a change to it, and an input's `data-k`. */
export const cellId = (key: string, lcid: Lcid): string => `${key}#${lcid}`;

/** One cell (slot key × language) as it was when the popup opened. */
export interface Snap {
  key: string;
  lcid: Lcid;
  /** The value shown then: the pending edit, else the server value. */
  value: string;
  /** The pending edit then; undefined when there was none. */
  pending: string | undefined;
  /**
   * That edit's base (Store.before): the server text it was made on. Undo brings the edit back measured against
   * it, so a reload that brought another maker's text meanwhile is still a conflict at save, never overwritten.
   */
  base?: string;
}

/** Records every cell of `keys` × `langs` that is not recorded yet (a cell shown later keeps its first state). */
export function snapshot(store: Store, keys: Iterable<string>, langs: Lcid[], into = new Map<string, Snap>()): Map<string, Snap> {
  for (const key of keys) {
    if (!store.get(key)) continue;
    const e = store.edits.get(key);
    for (const lcid of langs) {
      const id = cellId(key, lcid);
      if (into.has(id)) continue;
      const pending = e?.has(lcid) ? e.get(lcid) : undefined;
      into.set(id, { key, lcid, value: store.value(key, lcid), pending, base: pending === undefined ? undefined : store.before(key, lcid) });
    }
  }
  return into;
}

/**
 * "Undo changes": puts every recorded cell back as it was (one undo step, one store event): its earlier staged
 * edit with its own base, or none. Returns how many cells changed.
 */
export function restore(store: Store, snaps: Iterable<Snap>): number {
  let n = 0;
  const now = (s: Snap) => store.edits.get(s.key)?.get(s.lcid);
  const based = (s: Snap) => s.base === undefined || store.before(s.key, s.lcid) === s.base;
  store.group(() => {
    for (const s of snaps) {
      const was = now(s);
      if (was === s.pending && (was === undefined || based(s))) continue;
      // An edit made here after the recorded one was dropped has a base of its own (the server text then):
      // drop it first, so the recorded edit comes back on the recorded base (Store.set keeps an existing base).
      if (s.pending === undefined || (was !== undefined && !based(s))) store.revert(s.key, s.lcid);
      if (s.pending !== undefined) store.set(s.key, s.lcid, s.pending, s.base); // equal to a value published meanwhile: no edit, which is right
      if (now(s) !== was) n++;
    }
  });
  return n;
}

/**
 * Whether a cell was changed while the popup was open: its staged edit is not the recorded one. Server values
 * that move underneath (the other languages of a form loading, a reload of the slots) are not changes made here.
 */
export function changedHere(store: Store, s: Snap): boolean {
  const p = store.edits.get(s.key)?.get(s.lcid);
  if (p === s.pending) return false;
  // The recorded edit is gone: typed back to the server value (a change: Undo brings the edit back), or
  // matched by a reload (the same text now on the server: nothing changed).
  return p !== undefined || store.value(s.key, s.lcid) !== s.value;
}

/** Cells changed while the popup was open (see changedHere): "Undo changes" shows while there are some. */
export function changedCells(store: Store, snaps: Iterable<Snap>): string[] {
  const out: string[] = [];
  for (const s of snaps) if (changedHere(store, s)) out.push(cellId(s.key, s.lcid));
  return out;
}

/**
 * Trims the texts changed while the popup was open: spaces and line breaks at either end are never meant (an
 * Enter typed into a tooltip once saved "text\n"). Line breaks inside a text stay. Returns how many were trimmed.
 */
export function tidy(store: Store, snaps: Iterable<Snap>): number {
  let n = 0;
  store.group(() => {
    for (const s of snaps) {
      const p = store.edits.get(s.key)?.get(s.lcid);
      if (p === undefined || p === s.pending) continue;
      const t = p.trim();
      if (t !== p) store.set(s.key, s.lcid, t), n++;
    }
  });
  return n;
}

/** Languages of the rows: the base language first, then the target, then the other shown languages (org order). */
export function rowLangs(all: readonly Lcid[], base: Lcid, target: Lcid, shown: readonly Lcid[]): Lcid[] {
  const out = [base];
  if (target !== base) out.push(target);
  for (const l of all) if (l !== base && l !== target && shown.includes(l)) out.push(l);
  return out;
}

/**
 * The slot a label falls back to where it has no text of its own: a form field label's column name (LIVE-FINDINGS
 * 42), and with `store`, a related menu item's relationship text (LIVE-FINDINGS 80). '' when there is none.
 */
export const fallbackKey = (s: Slot, store?: Pick<Store, 'get'>): string => {
  if (s.kind === 'field' && s.prop === 'Label') {
    const c = columnOf(s);
    return c ? `attribute|${c.entity}.${c.attr}|DisplayName` : '';
  }
  return (store && navSource((k) => store.get(k), s)?.key) || '';
};

/**
 * The blocks that take the focus first, best first, in a form field's popup (Form label, Tooltip, Column name: a
 * column's form cell, inspector/describe.ts): the form's label, the text the page shows (or shows the column's name in
 * its place while empty), then the column's name, which takes it only where the form's label can't be typed in
 * (read-only: a managed form's). [] in any other popup, whose first block takes it.
 */
export function focusKeys(store: Pick<Store, 'get'>, blocks: readonly Block[]): string[] {
  for (const b of blocks) {
    const s = store.get(b.key);
    if (s?.kind !== 'field' || s.prop !== 'Label') continue;
    const ck = fallbackKey(s);
    return ck && blocks.some((x) => x.key === ck) ? [s.key, ck] : [];
  }
  return [];
}

const loose = (v: string): string => v.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * What users of language `l` see where this text is empty: a form field label shows the column's name in their
 * language, else the column's base-language name (LIVE-FINDINGS 42; the stand-in's rule, model.ts standIn), a related
 * menu item its relationship's text (LIVE-FINDINGS 80), a process stage or step translation the name Dynamics keeps
 * (model.ts stays: the loaded one, emptied or not), anything else (and a label whose fallback has no text in it) the
 * base text. '' when nothing shows.
 */
export function shows(store: Store, s: Slot, l: Lcid, base: Lcid): string {
  const kept = l !== base && stays(s, l) ? store.original(s.key, l).trim() : '';
  if (kept) return kept;
  const ck = fallbackKey(s, store);
  const col = ck && store.get(ck) ? ck : '';
  const v = col ? store.value(col, l).trim() : '';
  if (v || l === base) return v;
  const colBase = col && store.get(col)?.kind === 'attribute' ? store.value(col, base).trim() : '';
  return colBase || store.value(s.key, base).trim() || (col ? store.value(col, base).trim() : '');
}

/**
 * Placeholder of an empty input: "No French tooltip", else what users of that language see now ("Shows “Priorité”").
 * `page`: what the page shows there, where the store can't tell (a built-in related menu item's language-pack text).
 * An emptied translation saved as its stand-in has none: the line under the input says what it becomes (becomes()).
 * A metadata description's translation (model.ts keepsEmpty) says "No French tooltip" ("No French description") only
 * where its users see none: stored empty, or emptied here and saved so (Store.emptyOnPurpose), or with no base text
 * either; a missing one shows the base text to them, which it says.
 */
export function placeholderOf(store: Store, s: Slot, l: Lcid, base: Lcid, heading: string, lang: string, page = ''): string {
  if (l !== base && !s.readOnly && store.standIn(s.key, l, base)?.text) return '';
  if (l !== base && keepsEmpty(s)) {
    const v = store.emptyOnPurpose(s.key, l, base) ? '' : shows(store, s, l, base);
    return v ? `Shows “${v}”` : noneText(s, lang);
  }
  if (/tooltip|description|hint/i.test(heading)) return `No ${lang} ${heading.trim().toLowerCase()}`;
  const v = page.trim() || shows(store, s, l, base);
  return v ? `Shows “${v}”` : '';
}

/**
 * Amber: a translation that is empty while the base text is not, the rule of the page's marks (inspector/status
 * look). A form cell worded like its column shows the column's name, which is its translation already; so does a
 * related menu item worded like its relationship's text.
 */
export function isMissing(store: Store, s: Slot, l: Lcid, base: Lcid): boolean {
  // A description stored empty on purpose (model.ts storedEmpty: its users see none) is translated, never missing.
  if (store.emptyOnPurpose(s.key, l, base)) return false;
  // An item with no name yet (an app designer's placeholder) misses one in every language, the base one included.
  if (namesFirst(s) && !s.readOnly && !notLoaded(s, l) && !store.value(s.key, base).trim()) return !store.value(s.key, l).trim();
  if (l === base || s.readOnly || notLoaded(s, l) || notLoaded(s, base) || store.value(s.key, l).trim()) return false;
  const bv = store.value(s.key, base);
  if (!bv.trim()) return false;
  const ck = fallbackKey(s, store);
  const col = ck ? store.get(ck) : undefined;
  return !(col && !notLoaded(col, l) && store.original(ck, l).trim() && loose(bv) === loose(store.original(ck, base)));
}

/**
 * A staged text the save would refuse (the saver's blocking checks, in a few words): "Can't be empty" (a required base
 * text, or only spaces where there is no translation Dataverse could remove: they would be stored and show blank), a
 * translation emptied where Dataverse can't remove it and that has no stand-in (model.ts standIn, noStandIn: "Dataverse
 * can't remove this translation, and its English text is empty: type the text instead."), "Name it in English too" (a
 * placeholder's first title, model.ts namesFirst), "Too long (max N)" or "Read-only". '' when there is none, and always
 * for a text that is not changed. An emptied translation that has a stand-in is no problem, nor is a metadata
 * description's, saved empty (model.ts savesEmpty): becomes() says what it is saved as.
 */
export function problem(store: Store, s: Slot, l: Lcid, base: Lcid): string {
  if (!store.isEdited(s.key, l)) return '';
  if (s.readOnly) return 'Read-only';
  const v = store.value(s.key, l);
  if (!v.trim() && (l === base ? s.baseRequired : !canClear(s, l) && !savesEmpty(s, l, base))) {
    const x = l === base ? undefined : store.standIn(s.key, l, base);
    if (!x) return "Can't be empty";
    if (!x.text) return noStandIn(s, l, x);
  }
  if (v.trim() && l !== base && namesFirst(s) && !store.value(s.key, base).trim()) return `Name it in ${lcidName(base)} too`;
  return s.max > 0 && v.length > s.max ? `Too long (max ${s.max})` : '';
}

/**
 * What a staged emptied translation Dataverse can't remove is saved as, in the line under its input (model.ts
 * standIn, the saver's rule): "Becomes “Project site”: Dataverse can't remove a translation here, so French gets the
 * English text."; a metadata description's, saved empty (model.ts savesEmpty): "Saved empty: French users see no
 * tooltip." (`lang`: the language's name as the popup names it). '' for any other text, and for one without a stand-in
 * (problem() refuses that).
 */
export function becomes(store: Store, s: Slot, l: Lcid, base: Lcid, lang = lcidName(l)): string {
  if (l === base || s.readOnly) return '';
  // Only where there is a text to empty: spaces typed where there is none are trimmed away when the popup closes (tidy),
  // so nothing would be saved.
  if (store.isEdited(s.key, l) && store.emptyOnPurpose(s.key, l, base)) return store.original(s.key, l).trim() ? savedEmptyText(s, lang) : '';
  const x = store.standIn(s.key, l, base);
  return x?.text ? becomesText(s, l, base, x) : '';
}

/**
 * "Also change the other copies": the same text for the field's other copies (never a read-only or not-loaded one, nor
 * one of a form from a managed solution).
 */
export function writeAlso(store: Store, keys: readonly string[], l: Lcid, text: string): void {
  for (const k of keys) {
    const s = store.get(k);
    if (s && !s.readOnly && !isManaged(s) && !notLoaded(s, l)) store.set(k, l, text);
  }
}

/** The duplicates checkbox's line. */
export const alsoText = (n: number): string =>
  n === 1 ? 'Also change the other copy of this field on this form' : `Also change the ${n} other copies of this field on this form`;

/** A rectangle in viewport coordinates (a DOMRect fits). */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}
export interface Placement {
  left: number;
  top: number;
  /** Height available (the body scrolls inside). */
  maxH: number;
  side: 'below' | 'above' | 'left' | 'right' | 'dock';
  /** Beak position along the edge facing the label (x from the left; y from the top for 'left' and 'right'); null hides it. */
  beak: number | null;
}

/**
 * Where the popup goes: below the label, starting at its left edge; above it when there is not enough room below
 * and there is above; else on the side with more room. Kept 8 px inside the viewport. With no label (`z` null)
 * it docks next to the bar (`dock`, else the bar's default place at the bottom centre); a label scrolled out of
 * view keeps it at the nearest viewport edge without a beak. `beside` is the box of our own UI `z` is in (a row of
 * the list sheet, docked on the right or floating where it was dragged): the popup must not cover the list, so it
 * goes to the left of that box when there is room, else to its right, its beak on `z`. `side`: where it is now, once
 * shown; below or above its label it stays there while it nearly fits (STICK), so a label that moves (a scroll) or a text
 * that grows (a message under an input) never makes it jump to the other side and back.
 */
export function placeCallout(z: Box | null, w: number, h: number, vw: number, vh: number, dock: Box | null = null, beside: Box | null = null, side: Placement['side'] | null = null): Placement {
  const clampX = (x: number) => Math.round(Math.max(M, Math.min(x, vw - w - M)));
  const cap = Math.max(0, vh - 2 * M);
  if (z && beside && z.bottom >= 0 && z.top <= vh) {
    const left = beside.left - OFF - M >= w ? beside.left - OFF - w : vw - beside.right - OFF - M >= w ? beside.right + OFF : null;
    if (left !== null) {
      const hh = Math.min(h, cap);
      const mid = z.top + z.height / 2;
      const top = Math.round(Math.max(M, Math.min(mid - 24, vh - M - hh)));
      return { left: Math.round(left), top, maxH: cap, side: left < beside.left ? 'left' : 'right', beak: Math.round(Math.max(12, Math.min(mid - top, hh - 12))) };
    }
  }
  if (z && (z.bottom < 0 || z.top > vh || z.right < 0 || z.left > vw)) {
    const hh = Math.min(h, cap);
    const top = z.bottom < 0 ? M : z.top > vh ? vh - M - hh : Math.max(M, Math.min(z.top, vh - M - hh));
    return { left: clampX(z.left), top: Math.round(top), maxH: cap, side: 'dock', beak: null };
  }
  if (!z) {
    const b = dock ?? { left: vw / 2, right: vw / 2, width: 0, top: vh - 64, bottom: vh - 16, height: 48 };
    const left = clampX(b.left + b.width / 2 - w / 2);
    if (b.top + b.height / 2 >= vh / 2) {
      const room = Math.max(0, b.top - BAR_GAP - M);
      return { left, top: Math.round(b.top - BAR_GAP - Math.min(h, room)), maxH: Math.round(room), side: 'dock', beak: null };
    }
    return { left, top: Math.round(b.bottom + BAR_GAP), maxH: Math.round(Math.max(0, vh - b.bottom - BAR_GAP - M)), side: 'dock', beak: null };
  }
  const below = vh - z.bottom - OFF - M;
  const above = z.top - OFF - M;
  // Where it fits, below first, else on the side with more room; the side it is on already gets STICK px of slack.
  const takes = (here: number, there: number, slack: number) => here + slack >= h || (there < h && here + slack >= there);
  const down = side === 'above' ? !takes(above, below, STICK) : takes(below, above, side === 'below' ? STICK : 0);
  const room = Math.min(cap, Math.max(down ? below : above, Math.min(MIN_ROOM, cap)));
  const hh = Math.min(h, room);
  const want = down ? z.bottom + OFF : z.top - OFF - hh;
  const top = Math.max(M, Math.min(want, vh - M - hh));
  const left = clampX(z.left);
  const bx = Math.max(left + 12, Math.min(z.left + Math.min(z.width / 2, 24), left + w - 12));
  // Pushed over its own label (a very small window): the beak would point at nothing.
  return { left, top: Math.round(top), maxH: Math.round(room), side: down ? 'below' : 'above', beak: Math.abs(top - want) > 1 ? null : Math.round(bx - left) };
}

/**
 * An opening popup shows only once it sits where it stays: laid out, filled and focused but invisible, placed again each
 * frame, it shows when its place held for STEADY frames in a row (`same`: as on the frame before). While the label it
 * opened at is gone (`lost`) it waits: an option of a dropdown list leaves with the list, which closes as the popup takes
 * the focus, and the host points the popup at the field a moment later (the page's changes are read 90 ms apart,
 * inspector/overlay.ts), so it never shows at the option first and then jumps. After WAIT_MAX ms (`waited`) it shows
 * wherever it is. Returns the frames held so far and whether it shows now.
 */
export function settle(held: number, same: boolean, lost: boolean, waited: number): { held: number; show: boolean } {
  const n = same && !lost ? held + 1 : 0;
  return { held: n, show: n >= STEADY || waited >= WAIT_MAX };
}

const grow = (t: HTMLInputElement | HTMLTextAreaElement) => {
  if (FS || t.tagName !== 'TEXTAREA' || !t.isConnected) return;
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight + 2, MAX_H) + 'px';
};
const isText = (n: unknown): n is HTMLInputElement | HTMLTextAreaElement => {
  const t = (n as Element | null)?.tagName;
  return t === 'TEXTAREA' || (t === 'INPUT' && (n as HTMLInputElement).type !== 'checkbox');
};

const EMPTY: CalloutModel = { comp: '', title: '', kind: '', icon: 'edit', blocks: [], loading: true };

export const openCallout: OpenCallout = (app, host) => {
  app.adoptStyles(css);
  const { store, ctx } = app;
  const base = ctx.base;
  const all = ctx.langs.map((x) => x.lcid);
  const tid = `dxt-co${++ids}`;
  const born = performance.now();
  // Focus goes back where it was (a label reached with F2, a list row, the bar) when the popup closes.
  let opener: Element | null = document.activeElement;
  while (opener?.shadowRoot?.activeElement) opener = opener.shadowRoot.activeElement;
  const giveBack = (inside: boolean, lost = false) => {
    if (!inside) return;
    // Gone with the list that showed it (an item reached with F2): the host knows that list's button. Only on Done and
    // the like (`lost`), never after the secondary action, which moves on (Open switches the page).
    if (lost && opener instanceof HTMLElement && !opener.isConnected) {
      try {
        host.refocus?.();
      } catch (e) {
        if (__DEV__) console.error('[translator] refocus', e);
      }
      return;
    }
    if (!(opener instanceof HTMLElement) || !opener.isConnected || opener === document.body) return;
    // A Dynamics text field the user clicked before the label (a label click never moves the focus; F2 never opens a
    // popup from such a field): the focus stays on the page, where Ctrl+Z undoes the staged edit, not the field's typing.
    const ours = opener.getRootNode() === app.root;
    if (!ours && (opener.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(opener.tagName))) return;
    try {
      opener.focus({ preventScroll: true });
    } catch {
      /* gone or not focusable */
    }
  };
  // View state that survives re-renders.
  const st = {
    /** The Choices disclosure is open. */
    choices: false,
    /** Its default was decided (when the choices first exist). */
    choicesSet: false,
    /** The duplicates checkbox per block. */
    also: new Map<string, boolean>(),
  };
  const readModel = (fallback: CalloutModel): CalloutModel => {
    try {
      return host.model();
    } catch (e) {
      if (__DEV__) console.error('[translator] callout model', e);
      return fallback;
    }
  };
  let model = readModel(EMPTY);
  /** Every text as it was when the popup opened ("Undo changes"). */
  const snaps = new Map<string, Snap>();
  let cells = new Map<string, Array<() => void>>();
  let used: Array<Slot | undefined> = [];
  let sig = '';
  let dead = false;
  let lastPlace = '';
  /** Nothing to focus yet (labels still loading): the first input gets the focus once it is there. */
  let waitFocus = false;
  /** A pointer is pressed in the popup: it stays put until the release, so the click lands on what was pressed. */
  let pressed = false;
  /** Opening: not shown until its place holds (settle); then the side it was placed on stays while it fits. */
  let opening = true;
  let side: Placement['side'] | null = null;

  // ---- elements ----
  const kindEl = h('div', { class: 'co-k', id: tid + 'k' });
  const title = h('h2', { class: 'co-t', id: tid });
  const xB = ibtn('close', 'Close', () => done(), 'subtle sm');
  const head = h('header', { class: 'co-h' }, h('div', { class: 'co-ht' }, kindEl, title), xB);
  const content = h('div', { class: 'co-c' });
  const body = h('div', { class: 'co-b' }, content);
  const actB = btn('', () => act());
  const undoB = link('Undo changes', () => undo());
  const doneB = btn('Done', () => done(), 'primary');
  /** The secondary action could do nothing: one muted line until the next render. */
  const failL = h('div', { class: 'co-fx', hidden: true });
  const foot = h('footer', { class: 'co-f' }, failL, h('div', { class: 'co-fa' }, undoB, doneB));
  const beak = h('i', { class: 'co-beak', 'aria-hidden': 'true' });
  const live = h('span', { class: 'vh', 'aria-live': 'polite' });
  // data-us: an input a re-render replaces keeps its undo history (ui/undo.ts, by its data-k).
  const el = h('div', { class: 'co is-wait', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': `${tid}k ${tid}`, tabIndex: -1, 'data-us': true }, beak, head, body, foot, live);

  const later = rafThrottle(() => reposition());
  const announce = (t: string) => {
    // A live region ignores a text it already holds: a repeat gets a trailing no-break space.
    live.textContent = live.textContent === t ? t + String.fromCharCode(0xa0) : t;
  };
  const hasFocus = () => el.contains(active(el));
  /** What a re-render depends on besides the slots: the model and the language settings. */
  const sigOf = (m: CalloutModel): string => `${JSON.stringify(m)}|${app.prefs.target}|${app.prefs.shown.join()}`;
  const keysOf = (m: CalloutModel): string[] =>
    [...new Set([...m.blocks.map((b) => b.key), ...m.blocks.flatMap((b) => b.also?.keys || []), ...(m.choices?.keys || [])])].filter((k) => store.get(k));
  const langs = (): Lcid[] => rowLangs(all, base, app.prefs.target, app.prefs.shown);
  /** Runs `fn` when a text of `key` changes (without running it now). */
  const listen = (key: string, fn: () => void): void => {
    const a = cells.get(key);
    if (a) a.push(fn);
    else cells.set(key, [fn]);
  };
  const watch = (key: string, fn: () => void): void => {
    listen(key, fn);
    fn();
  };
  const updateAll = () => {
    for (const a of cells.values()) for (const f of a) f();
  };
  /** Not inside a hidden part of the popup. */
  const visible = (n: Element): boolean => {
    for (let x: Element | null = n; x && x !== el; x = x.parentElement) if ((x as HTMLElement).hidden) return false;
    return true;
  };
  const focusables = () =>
    [...el.querySelectorAll<HTMLElement>('input,textarea,button')].filter((x) => !(x as HTMLButtonElement).disabled && x.tabIndex >= 0 && visible(x));
  const inputs = () => [...el.querySelectorAll<HTMLElement>('.ti')].filter((x) => !(x as HTMLInputElement).disabled);
  const byKey = (id: string) => inputs().find((x) => x.getAttribute('data-k') === id);

  // ---- typing ----
  /** Stages a keystroke; with the duplicates checkbox ticked, the copies get the same text (one store event). */
  function type(s: Slot, l: Lcid, b: Block | null, v: string): void {
    const copies = b?.also && st.also.get(b.key) ? b.also.keys : null;
    if (!copies) return store.set(s.key, l, v);
    store.group(() => {
      store.set(s.key, l, v);
      writeAlso(store, copies, l, v);
    });
  }
  /** Ticked: the copies take the texts changed here since the popup opened; unticked: they go back to how they were. */
  function follow(b: Block, on: boolean): void {
    const keys = b.also?.keys || [];
    if (!on) {
      restore(store, [...snaps.values()].filter((s) => keys.includes(s.key)));
      return;
    }
    store.group(() => {
      for (const l of langs()) {
        const sn = snaps.get(cellId(b.key, l));
        if (sn && changedHere(store, sn)) writeAlso(store, keys, l, store.value(b.key, l));
      }
    });
  }

  // ---- rows ----
  function field(s: Slot, l: Lcid, o: { name: string; block?: Block; choice?: boolean }): HTMLElement {
    const id = `${tid}i${++ids}`;
    const long = !!o.block?.long;
    const n = langName(app, l);
    const unread = notLoaded(s, l);
    const inp = h(long ? 'textarea' : 'input', {
      class: 'ti',
      id,
      rows: long ? 1 : null,
      'data-k': cellId(s.key, l),
      dir: isRtl(l) ? 'rtl' : null,
      lang: lcidTag(l) || null,
      spellcheck: true,
      disabled: !!s.readOnly || unread,
      'aria-label': `${o.name}, ${n}`,
      'aria-describedby': id + 'm',
    }) as HTMLInputElement | HTMLTextAreaElement;
    // Reopened on a staged text, nothing typed yet: Ctrl+Z goes back to the server text (unstaged), Ctrl+Y brings the edit back.
    whenEmpty(inp, (u) => (u === 'undo' && store.isEdited(s.key, l) ? store.original(s.key, l) : undefined));
    inp.addEventListener('input', () => {
      type(s, l, o.block ?? null, inp.value);
      grow(inp);
    });
    const msg = h('div', { class: 'co-m', id: id + 'm', hidden: true });
    const v = h('div', { class: 'co-v' }, inp, msg);
    let said = '\u0000';
    const update = () => {
      const val = store.value(s.key, l);
      if (inp.value !== val) {
        inp.value = val;
        grow(inp);
      }
      const page = l === ctx.user ? o.block?.pageText : '';
      inp.placeholder = unread ? 'Not loaded yet' : o.choice || s.readOnly ? '' : placeholderOf(store, s, l, base, o.block?.heading || 'Label', n, page);
      const p = problem(store, s, l, base);
      // An emptied translation Dataverse can't remove: what saving writes in its place, in a muted line (and no
      // placeholder, placeholderOf: what the page shows now may not be what it becomes, a stage name Dynamics keeps); a
      // metadata description's: that it is saved empty.
      const b = p ? '' : becomes(store, s, l, base, n);
      const over = s.max > 0 && val.length > s.max;
      const key = `${p}|${b}|${over ? val.length : ''}`;
      if (key !== said) {
        said = key;
        msg.hidden = !p && !b;
        msg.className = 'co-m' + (b ? ' is-note' : '');
        // Emptied when there is nothing to say: it stays referenced by the input's aria-describedby.
        put(msg, p ? [icon('error', 12), h('span', null, p), over ? h('small', { class: 'cnt' }, `${val.length} / ${s.max}`) : null] : b ? [icon('info', 12), h('span', null, b)] : null);
        if ((p || b) && active(el) === inp) announce(p || b);
      }
      v.className = 'co-v' + (p ? ' is-err' : store.isEdited(s.key, l) ? ' is-edit' : isMissing(store, s, l, base) ? ' is-miss' : '');
      if (p) inp.setAttribute('aria-invalid', 'true');
      else inp.removeAttribute('aria-invalid');
    };
    watch(s.key, update);
    // A field label's placeholder and look follow its column's name (LIVE-FINDINGS 42), a related menu item's its
    // relationship's text (LIVE-FINDINGS 80).
    const ck = fallbackKey(s, store);
    if (ck && ck !== s.key) listen(ck, update);
    return v;
  }

  function langCell(l: Lcid, forId: string): HTMLElement {
    const n = langName(app, l);
    const c = h('label', { class: 'co-l', for: forId }, n);
    tooltip(c, () => (c.scrollWidth > c.clientWidth ? n : ''));
    return c;
  }

  /** One muted line: why a text can't be changed. */
  const roLine = (reason: string): HTMLElement => h('div', { class: 'co-ro' }, icon('lock', 12), h('span', null, reason.trim().replace(/[.\s]+$/, '')));

  function block(b: Block): HTMLElement | null {
    const s = store.get(b.key);
    if (!s) return null;
    const hid = `${tid}h${++ids}`;
    const rows = langs().map((l) => {
      const f = field(s, l, { name: b.heading, block: b });
      return h('div', { class: 'co-r' }, langCell(l, f.firstElementChild?.id || ''), f);
    });
    return h('section', { class: 'co-blk', role: 'group', 'aria-labelledby': hid },
      h('div', { class: 'co-bh', id: hid }, b.heading, b.note ? h('span', { class: 'co-bn' }, ` · ${b.note}`) : null),
      s.readOnly && !model.readOnly ? roLine(s.readOnly) : null,
      rows,
      b.also?.keys.length && !s.readOnly ? alsoBox(b) : null,
    );
  }

  /** "Also change the other copy of this field on this form". */
  function alsoBox(b: Block): HTMLElement {
    const a = b.also!;
    if (!st.also.has(b.key)) st.also.set(b.key, a.on);
    const cb = h('input', { type: 'checkbox', checked: !!st.also.get(b.key), 'data-f': `a:${b.key}` });
    cb.addEventListener('change', () => {
      st.also.set(b.key, cb.checked);
      follow(b, cb.checked);
    });
    return h('label', { class: 'co-also' }, cb, h('span', null, alsoText(a.keys.length)));
  }

  /**
   * "› Choices (5)": one compact row per option, base and target side by side. " · 1 changed" (green) or " · 1 not
   * published" (red, one failed to publish) follows while choices have a change that isn't published.
   */
  function choicesPart(c: NonNullable<CalloutModel['choices']>, keys: string[]): HTMLElement {
    const target = app.prefs.target;
    const mark = host.focusKey && keys.includes(host.focusKey) ? host.focusKey : c.focus;
    const cid = `${tid}c`;
    const open = st.choices;
    const note = h('span', { class: 'co-dn' });
    const said = () => {
      const p = choiceNote(store, all, keys);
      note.textContent = p ? ` · ${choicesNote(p)}` : '';
      note.className = 'co-dn' + (p ? (p.failed ? ' is-err' : ' is-edit') : '');
    };
    for (const k of keys) listen(k, said);
    said();
    const dis = h('button', {
      class: 'co-dis',
      type: 'button',
      'aria-expanded': String(open),
      'aria-controls': open ? cid : null,
      'data-f': 'd:c',
      on: {
        click: () => {
          st.choices = !st.choices;
          render();
        },
      },
    }, icon('right', 12), h('span', null, `Choices (${keys.length})`, note));
    if (!open) return h('div', { class: 'co-d' }, dis);
    const ls = target !== base ? [base, target] : [base];
    return h('div', { class: 'co-d' }, dis,
      h('div', { class: 'co-dc', id: cid },
        (c.shared ?? 0) > 1 ? h('div', { class: 'co-sh' }, `Shared by ${c.shared} columns`) : null,
        h('div', { class: 'co-ch' + (ls.length === 1 ? ' is-one' : '') },
          h('div', { class: 'co-chh', 'aria-hidden': 'true' }, ls.map((l) => h('span', null, langName(app, l)))),
          keys.map((k) => {
            const s = store.get(k)!;
            const name = `Choice “${store.value(k, base) || s.title}”`;
            return h('div', { class: 'co-cr' + (k === mark ? ' is-focus' : '') }, ls.map((l) => field(s, l, { name, choice: true })));
          }),
        ),
      ),
    );
  }

  // ---- render ----
  function render(): void {
    const keep = focusState();
    const sc = body.scrollTop;
    cells = new Map();
    const keys = keysOf(model);
    snapshot(store, keys, all, snaps);
    used = keys.map((k) => store.get(k));
    sig = sigOf(model);
    const c = model.choices;
    const cks = (c?.keys || []).filter((k) => store.get(k));
    if (c && cks.length && !st.choicesSet) {
      // Closed, unless it was opened from a choice value or a choice has a change that isn't published (the page
      // shows no other sign of it); decided once, the user's own choice stays after that.
      st.choicesSet = true;
      st.choices = c.open || (!!host.focusKey && cks.includes(host.focusKey)) || !!choiceNote(store, all, cks);
    }
    el.classList.toggle('is-wide', cks.length > 0);
    kindEl.textContent = model.kind;
    kindEl.hidden = !model.kind;
    title.textContent = model.title || 'Untitled';
    const parts: Array<Node | null> = [];
    if (model.loading) parts.push(h('div', { class: 'co-load', role: 'status' }, spinner(), h('span', null, 'Loading…')));
    if (model.readOnly) parts.push(roLine(model.readOnly));
    if (model.note) parts.push(h('div', { class: 'co-empty' }, model.note));
    for (const b of model.blocks) parts.push(block(b));
    if (c && cks.length) parts.push(choicesPart(c, cks));
    if (!model.loading && !parts.some(Boolean)) parts.push(h('div', { class: 'co-empty' }, 'Nothing to translate here.'));
    put(content, parts);
    // The secondary action (Open, Show stage, Show tab, Change …) is in the footer only when there is one.
    actB.textContent = model.action || '';
    if (model.action) foot.prepend(actB);
    else actB.remove();
    failL.hidden = true;
    body.scrollTop = sc;
    restoreFocus(keep);
    // Opened while its labels were loading: the first input takes the focus once it is there.
    if (waitFocus && el.isConnected && active(el) === el && inputs().length) focusInitial();
    updateFoot();
    reposition();
  }

  function updateFoot(): void {
    if (dead) return;
    const changed = changedCells(store, snaps.values()).length > 0;
    if (undoB.hidden === changed) {
      // The link is going away under the focus: the focus stays in the popup.
      if (!changed && active(el) === undoB) doneB.focus();
      undoB.hidden = !changed;
      later();
    }
  }

  // ---- focus ----
  function focusState(): { k: string | null; f: string | null; a: number | null; b: number | null } | null {
    const x = active(el);
    if (!x || !content.contains(x)) return null;
    const text = isText(x);
    return { k: x.getAttribute('data-k'), f: x.getAttribute('data-f'), a: text ? x.selectionStart : null, b: text ? x.selectionEnd : null };
  }
  function restoreFocus(keep: ReturnType<typeof focusState>): void {
    if (!keep) return;
    const n = [...content.querySelectorAll<HTMLElement>('[data-k],[data-f]')].find((x) => (keep.k && x.getAttribute('data-k') === keep.k) || (keep.f && x.getAttribute('data-f') === keep.f));
    if (!n) return;
    n.focus({ preventScroll: true });
    if (keep.a !== null && isText(n)) {
      try {
        n.setSelectionRange(keep.a, keep.b ?? keep.a);
      } catch {
        /* not a text input */
      }
    }
  }
  function reveal(n: HTMLElement): void {
    const r = n.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    if (r.top < b.top) body.scrollTop -= b.top - r.top + 8;
    else if (r.bottom > b.bottom) body.scrollTop += r.bottom - b.bottom + 8;
  }
  function focusEl(n: HTMLElement): void {
    n.focus({ preventScroll: true });
    if (isText(n)) {
      const end = n.value.length;
      try {
        n.setSelectionRange(end, end);
      } catch {
        /* not a text input */
      }
    }
    reveal(n);
  }
  /** The first choice with a change that isn't published (option order), when the popup lists choices. */
  const firstPending = (): string | undefined => {
    const ks = (model.choices?.keys || []).filter((k) => store.get(k));
    return choiceNote(store, all, ks)?.first;
  };
  /**
   * The input the host asked for, else the clicked choice in the open Choices list (a choice value's popup opened
   * from the list), else its first pending choice (not where the popup has the column's name, a form field's or a
   * column's: Choices opens by itself there all the same, the caret goes to the first text), else the first text's input in
   * the language the page is shown in (the text the user was reading: `<html lang>`, else their Dynamics language),
   * else that text's first input that takes typing, else the first input that takes typing. The first text is the first
   * block that takes typing; in a form field's popup, the form's label, else (read-only) the column's name
   * (focusKeys). The caret goes to the end of its text.
   */
  function focusInitial(): void {
    waitFocus = false;
    const target = app.prefs.target;
    const l = host.focusLcid ?? shownLanguage(all, ctx.user);
    const named = model.blocks.some((b) => {
      const s = store.get(b.key);
      return s?.kind === 'attribute' && s.prop === 'DisplayName';
    });
    const k = host.focusKey ?? (st.choices ? (model.choices?.focus ?? (named ? undefined : firstPending())) : undefined);
    const ins = inputs();
    const first = ins[0];
    const blockOf = (x: HTMLElement) => x.getAttribute('data-k')?.replace(/#\d+$/, '') || '';
    const firsts = focusKeys(store, model.blocks);
    if (!firsts.length && first) firsts.push(blockOf(first));
    let n = k ? byKey(cellId(k, l)) || byKey(cellId(k, target)) : undefined;
    // That text's input in the page's language, else its first one that takes typing.
    for (const c of firsts) n = n || byKey(cellId(c, l)) || ins.find((x) => blockOf(x) === c);
    n = n || first;
    if (n) return focusEl(n);
    el.focus({ preventScroll: true }); // nothing to type in: the dialog itself, so its title is read out
    waitFocus = !!model.loading;
  }

  // ---- actions ----
  /** Done (also ✕, Enter, Esc, a click outside): closes; what was typed stays staged. */
  function done(refocus = true): void {
    if (dead) return;
    const inside = refocus && hasFocus();
    tidy(store, snaps.values());
    destroy();
    host.close();
    giveBack(inside, true);
  }
  /**
   * The secondary action (Open, Show stage, Show tab, Change …): what was typed stays staged, trimmed as by Done; the host
   * acts and closes the popup.
   */
  function act(): void {
    if (dead) return;
    const inside = hasFocus();
    tidy(store, snaps.values());
    const acted = host.action();
    if (dead) {
      // Closed: the focus goes back as after Done, unless the action moved it (a tab the form API focused).
      const f = document.activeElement;
      if (!f || f === document.body) giveBack(inside);
    } else if (!acted) {
      const t = "Couldn't do that from here. Alt+click it on the page.";
      failL.textContent = t;
      failL.hidden = false;
      announce(t);
      later();
    }
  }
  /** "Undo changes": every text back to what it was when the popup opened. */
  function undo(): void {
    if (dead) return;
    restore(store, snaps.values());
    announce('Changes undone.');
    focusInitial();
  }

  // ---- placement ----
  function barRect(): DOMRect | null {
    // The bar is the toolbar in the app layer (ui/bar.ts); without one, the bar's default place is used.
    for (const t of app.layer.querySelectorAll<HTMLElement>('[role=toolbar]')) {
      if (el.contains(t)) continue;
      const r = t.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      // Its message row (a sibling above or below it) stays visible too.
      let top = r.top;
      let bottom = r.bottom;
      const p = t.parentElement;
      if (p && p !== app.layer)
        for (const s of p.children) {
          if (s === t || s === el || !(s instanceof HTMLElement) || s.hidden) continue;
          const q = s.getBoundingClientRect();
          if (!q.width || !q.height || q.right < r.left || q.left > r.right) continue;
          top = Math.min(top, q.top);
          bottom = Math.max(bottom, q.bottom);
        }
      return new DOMRect(r.left, top, r.width, bottom - top);
    }
    return null;
  }
  /**
   * Places the popup next to its label (placeCallout) and returns that place's key and whether it points at a label; null
   * when it can't be placed now (closed, pressed, not in the page).
   */
  function place(): { k: string; at: boolean } | null {
    if (dead || pressed || !el.isConnected) return null;
    const W = app.layer.clientWidth || innerWidth;
    const H = app.layer.clientHeight || innerHeight;
    let z: DOMRect | null = null;
    try {
      z = host.rect();
    } catch {
      z = null;
    }
    const natural = el.offsetHeight - body.clientHeight + body.scrollHeight;
    const w = el.offsetWidth;
    // An anchor in our own UI (a row of the list sheet, wherever the sheet is): beside that, not over it.
    let ours: DOMRect | null = null;
    try {
      ours = z ? host.beside?.() ?? null : null;
    } catch {
      ours = null;
    }
    // The bar stays visible: next to a label the popup uses only the room on the other side of the bar (above a
    // bar at the bottom, below a bar moved to the top).
    const bar = barRect();
    let off = 0;
    let room = H;
    if (z && bar) {
      if (bar.top + bar.height / 2 >= H / 2) room = Math.max(0, bar.top - BAR_GAP);
      else (off = bar.bottom + BAR_GAP), (room = Math.max(0, H - off));
    }
    const zz = z && off ? new DOMRect(z.left, z.top - off, z.width, z.height) : z;
    // Opening, its side is decided afresh each frame: the place it shows at is the first one seen.
    const p = placeCallout(zz, w, natural, W, room, z ? null : bar, ours, opening ? null : side);
    p.top += off;
    const k = `${p.left}|${p.top}|${p.maxH}|${p.side}|${p.beak}`;
    if (k === lastPlace) return { k, at: !!z };
    lastPlace = k;
    side = p.side;
    el.style.left = p.left + 'px';
    el.style.top = p.top + 'px';
    el.style.maxHeight = p.maxH + 'px';
    el.classList.toggle('is-below', p.side === 'below');
    el.classList.toggle('is-above', p.side === 'above');
    el.classList.toggle('is-left', p.side === 'left');
    el.classList.toggle('is-right', p.side === 'right');
    el.classList.toggle('is-dock', p.side === 'dock' || p.beak === null);
    const across = p.side === 'left' || p.side === 'right';
    beak.style.left = p.beak !== null && !across ? p.beak + 'px' : '';
    beak.style.top = p.beak !== null && across ? p.beak + 'px' : '';
    return { k, at: !!z };
  }
  function reposition(): void {
    place();
  }

  // ---- events ----
  el.addEventListener('keydown', (e) => {
    if (dead || e.isComposing) return;
    const t = e.composedPath()[0];
    if (e.key === 'Escape') {
      e.preventDefault(); // the app's Esc handler skips handled events
      done();
    } else if (e.key === 'Enter' && !e.altKey && !e.shiftKey && (e.ctrlKey || e.metaKey || isText(t))) {
      // Enter in any text box, Ctrl+Enter anywhere. A new line in a multi-line text is Shift+Enter: people press
      // Enter to finish, and a line break at the end of a tooltip would be saved with it.
      e.preventDefault();
      done();
    } else if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // The focus stays in the popup: Tab past the last control goes to the first input, Shift+Tab before the
      // first control to the last one.
      const f = focusables();
      if (!f.length) return;
      const a = active(el);
      if (!e.shiftKey && a === f[f.length - 1]) {
        e.preventDefault();
        (inputs()[0] || f[0]).focus();
      } else if (e.shiftKey && (a === f[0] || a === el)) {
        e.preventDefault();
        f[f.length - 1].focus();
      }
    }
  });

  // Light dismiss: a pointer down outside is Done (the text stays staged). Clicks on labels are taken by the
  // overlay (window capture) before they reach this, and the host opens that label's popup instead.
  const down = (e: PointerEvent) => {
    if (dead || e.timeStamp < born) return;
    const path = e.composedPath();
    if (path.includes(el)) return;
    if (modalOpen() || path.some((n) => n instanceof HTMLElement && LAYERS.some((c) => n.classList.contains(c)))) return;
    done(false); // the pointer's target takes the focus
  };
  document.addEventListener('pointerdown', down, true);
  // A press in the popup holds its place until the release (`pressed`): a label that leaves with its menu as the
  // popup is pressed must not move the button out from under the pointer.
  el.addEventListener('pointerdown', () => {
    pressed = true;
  });
  const release = () => {
    if (!pressed) return;
    pressed = false;
    later();
  };
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
  addEventListener('resize', later);
  const offLayer = pushLayer(el, () => done());

  const offStore = store.on((e) => {
    if (dead || e.type === 'busy') return;
    if (e.type === 'slots') {
      const m = readModel(model);
      const keys = keysOf(m);
      if (sigOf(m) !== sig || keys.length !== used.length || keys.some((k, i) => store.get(k) !== used[i])) {
        model = m;
        render();
      } else {
        updateAll();
        updateFoot();
      }
      return;
    }
    if (e.type === 'edit') {
      const fns = cells.get(e.key);
      if (!fns && !snaps.has(cellId(e.key, e.lcid))) return; // not a text of this popup
      fns?.forEach((f) => f());
    } else updateAll();
    updateFoot();
    later();
  });
  const onPrefs = (ev: Event) => {
    if (dead) return;
    const d = (ev as CustomEvent<Record<string, unknown> | undefined>).detail || {};
    const m = 'target' in d || 'shown' in d ? readModel(model) : null;
    if (m && sigOf(m) !== sig) {
      model = m;
      render();
    } else {
      updateAll();
      updateFoot();
    }
  };
  app.root.host.addEventListener('dxt-prefs', onPrefs);

  function destroy(): void {
    if (dead) return;
    dead = true;
    offStore();
    offLayer();
    document.removeEventListener('pointerdown', down, true);
    document.removeEventListener('pointerup', release, true);
    document.removeEventListener('pointercancel', release, true);
    removeEventListener('resize', later);
    app.root.host.removeEventListener('dxt-prefs', onPrefs);
    el.remove();
  }

  // ---- open ----
  // Laid out, filled and focused while still invisible (is-wait); it shows once its place holds (settle).
  undoB.hidden = true;
  render();
  app.layer.append(el);
  const laid = place();
  /** It opened at a label (not docked); the frames its place has held, and that place. */
  const atLabel = !!laid?.at;
  let held = 0;
  let heldAt = laid?.k ?? '';
  const tick = (): void => {
    if (dead || !opening) return;
    const at = place();
    const s = settle(held, !!at && at.k === heldAt, !at || (atLabel && !at.at), performance.now() - born);
    held = s.held;
    heldAt = at?.k ?? '';
    if (!s.show) return void requestAnimationFrame(tick);
    opening = false;
    el.classList.remove('is-wait');
  };
  focusInitial();
  requestAnimationFrame(tick);

  return {
    el,
    reposition,
    refresh() {
      if (dead) return;
      const m = readModel(model);
      if (sigOf(m) !== sig) {
        model = m;
        render();
      } else {
        updateAll();
        updateFoot();
        later();
      }
    },
    destroy,
  };
};
