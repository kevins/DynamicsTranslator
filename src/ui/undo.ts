// Undo and redo in the translator. In its own text boxes, Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z and the context menu's Undo act
// on what was typed in the focused box, one history per box (the menu's Redo stays greyed: the browser enables it from
// its own stack, which these keys never feed). The browser's undo is never used there: Chromium
// keeps one undo stack for the whole page, so Ctrl+Z in a box undid the page's last edit wherever it was (a box a
// re-render had replaced, a Dynamics field) and moved the focus there. Script changes meant as edits (a paste the grid
// cleans up, Alt+Enter, typing into a cell) go through insertText()/resetUndo(); any other script change is undone
// first by the next Ctrl+Z. A box with nothing typed in it yet asks its whenEmpty(): a popup reopened on a staged text
// goes back to the server text (Ctrl+Y brings the edit back), the grid's cell editor undoes the workbook's last step.
// Outside text boxes the keys undo and redo the staged edits (the Store): anywhere in the translator but a dialog, and
// in translation mode on the page unless the focus is in a control that takes typing or a value (ownsKeys()).

import type { Store } from '../core/store';

/** A text box's text and selection. */
export interface TextState {
  v: string;
  s: number;
  e: number;
}
/** How an edit joins the one before it: a run of typing, or of deleting, at the caret is one step; anything else is its own. */
export type EditKind = 'type' | 'delete' | 'other';
type Step = [before: TextState, after: TextState];
const MAX = 100; // steps kept per box
const same = (a: TextState, b: TextState): boolean => a.v === b.v && a.s === b.s && a.e === b.e;

/** The undo history of one text box. */
export class TextUndo {
  private done: Step[] = [];
  private undone: Step[] = [];
  /** The kind of the last recorded edit while its run can go on; null after an undo or a redo. */
  private run: EditKind | null = null;
  /** Records an edit from `b` to `a`. Typing (or deleting) that goes on at the caret where the last step ended joins that step. */
  record(b: TextState, a: TextState, kind: EditKind): void {
    if (b.v === a.v) return;
    const last = this.done[this.done.length - 1];
    if (last && kind !== 'other' && kind === this.run && b.s === b.e && same(last[1], b)) last[1] = a;
    else if (this.done.push([b, a]) > MAX) this.done.shift();
    this.run = kind;
    this.undone = [];
  }
  /** Nothing was recorded since the box got this history. */
  empty(): boolean {
    return !this.done.length && !this.undone.length;
  }
  /** Where Ctrl+Z goes from `now`, or null. A change made since the last step (a script set the text) is undone first. */
  undo(now: TextState): TextState | null {
    const last = this.done[this.done.length - 1];
    if (!last) return null;
    if (last[1].v !== now.v) this.done.push([last[1], now]);
    const st = this.done.pop()!;
    this.undone.push(st);
    this.run = null;
    return st[0];
  }
  /** Where Ctrl+Y goes from `now`, or null; nothing once the text changed since the undo (redo would overwrite it). */
  redo(now: TextState): TextState | null {
    const st = this.undone.pop();
    if (!st) return null;
    if (st[0].v !== now.v) {
      this.undone = [];
      return null;
    }
    this.done.push(st);
    this.run = null;
    return st[1];
  }
}

/** The kind of an edit from its InputEvent.inputType. */
export const kindOf = (t: string): EditKind =>
  /^(insertText|insertCompositionText|insertLineBreak|insertParagraph)$/.test(t) ? 'type' : /^delete(?!By)/.test(t) ? 'delete' : 'other';

type Keys = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'>;
/**
 * 'undo' for Ctrl+Z, 'redo' for Ctrl+Y and Ctrl+Shift+Z (⌘ too): by the key's letter, or its place for a letter of a
 * script without Latin letters (Cyrillic, Greek…). Another key at that place (BÉPO's à, a dead key, Dvorak's ;) is not.
 */
export function undoKey(e: Keys): 'undo' | 'redo' | '' {
  if (e.isComposing || e.altKey || !(e.ctrlKey || e.metaKey)) return ''; // Alt: AltGr types characters
  const ch = e.key || '';
  const k = /^[a-z]$/i.test(ch) ? ch.toLowerCase() : /^\p{L}$/u.test(ch) && !/\p{Script=Latin}/u.test(ch) ? (e.code === 'KeyZ' ? 'z' : e.code === 'KeyY' ? 'y' : '') : '';
  return k === 'z' ? (e.shiftKey ? 'redo' : 'undo') : k === 'y' && !e.shiftKey ? 'redo' : '';
}

type Box = HTMLInputElement | HTMLTextAreaElement;
const NOT_TEXT = /^(checkbox|radio|button|submit|reset|range|color|file|hidden|image)$/;
const holdsText = (t: Element): boolean => t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !NOT_TEXT.test((t as HTMLInputElement).type));
/** Our text boxes: textareas and inputs that hold text, not read-only or disabled. */
const isBox = (n: unknown): n is Box => {
  const t = n as Box | null;
  return !!t?.tagName && holdsText(t) && !t.readOnly && !t.disabled;
};
/** An element's role: the first token of its role attribute, the one browsers take. */
const roleOf = (t: Element): string => (t.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
const EDIT_ROLES = /^(textbox|searchbox|combobox|spinbutton|slider)$/;
/**
 * Takes typing or a value: an input that holds text (number, date and time too, read-only too), a textarea, a select,
 * editable content, or a control with the role of one. Not a checkbox, a radio button or a range (see ownsKeys).
 */
const edits = (t: Element): boolean => holdsText(t) || t.tagName === 'SELECT' || !!(t as HTMLElement).isContentEditable || EDIT_ROLES.test(roleOf(t));
/** `n`'s parent, or the host of the shadow root it is at the top of. */
const up = (n: Element): Element | null => n.parentElement ?? (n.parentNode as ShadowRoot | null)?.host ?? null;
/**
 * The focused element `t` keeps Ctrl+Z and Ctrl+Y for itself: a control that takes typing or a value, or anything in a
 * grid cell whose editor is open (the cell, a lookup's or a date's button). A button, a link, a tab, a menu item, a
 * checkbox, a range or a plain element has no undo of its own: there Chromium's would revert the page's last edit,
 * wherever it was.
 */
export function ownsKeys(t: Element): boolean {
  if (edits(t)) return true;
  for (let n: Element | null = t; n; n = up(n))
    if (roleOf(n) === 'gridcell') return [...n.querySelectorAll('input,textarea,select,[contenteditable],[role]')].some(edits);
  return false;
}
const stateOf = (t: Box): TextState => ({ v: t.value, s: t.selectionStart ?? t.value.length, e: t.selectionEnd ?? t.value.length });
const focused = (t: Box): boolean => (t.getRootNode() as Document | ShadowRoot).activeElement === t;
/** The focused element `a`, or the one focused inside it through open shadow roots. */
const deepest = (a: Element | null): Element | null => {
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
};
/** The focused element in `n`'s root, through open shadow roots. */
const deepActive = (n: Node): Element | null => deepest((n.getRootNode() as Document | ShadowRoot).activeElement);

const hist = new WeakMap<Box, TextUndo>();
/** Histories of the boxes inside a `data-us` element by their data-k: the box a re-render puts in place goes on with the old one's. */
const scoped = new WeakMap<Element, Map<string, TextUndo>>();
/** The state before the edit under way (beforeinput, insertText()), and at compositionstart (a whole composition is one step). */
const pre = new WeakMap<Box, TextState>();
const comp = new WeakMap<Box, TextState>();
const fallback = new WeakMap<Box, (u: 'undo' | 'redo') => string | void>();
let applying = false;

function historyOf(t: Box): TextUndo {
  let u = hist.get(t);
  if (u) return u;
  const k = t.getAttribute('data-k');
  let sc: Element | null = null;
  for (let n = k ? t.parentElement : null; n && !sc; n = n.parentElement) if (n.getAttribute('data-us') !== null) sc = n;
  if (sc && k) {
    let m = scoped.get(sc);
    if (!m) scoped.set(sc, (m = new Map()));
    u = m.get(k);
    if (!u) m.set(k, (u = new TextUndo()));
  } else u = new TextUndo();
  hist.set(t, u);
  return u;
}
/** Shows a state of the history and tells the box's listeners, as the browser's own undo would. */
function show(t: Box, s: TextState, inputType: string): void {
  t.value = s.v;
  try {
    t.setSelectionRange(s.s, s.e);
  } catch {
    /* a box without a selection */
  }
  applying = true;
  try {
    t.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
  } finally {
    applying = false;
  }
}
function step(t: Box, u: 'undo' | 'redo'): void {
  const h = historyOf(t);
  const now = stateOf(t);
  let to = u === 'undo' ? h.undo(now) : h.redo(now);
  if (!to && h.empty()) {
    const from = fallback.get(t)?.(u);
    // A box with nothing typed in it yet goes back to the text it replaces (its cell's server text); Ctrl+Y brings the edit back.
    if (typeof from === 'string' && from !== now.v) {
      h.record({ v: from, s: 0, e: from.length }, now, 'other');
      to = h.undo(now);
    }
  }
  if (to) show(t, to, u === 'undo' ? 'historyUndo' : 'historyRedo');
}

/** What bindUndo needs from the app. */
export interface UndoHost {
  /** The staged edits, which Ctrl+Z and Ctrl+Y undo and redo outside text boxes. */
  store: Pick<Store, 'busy' | 'undo' | 'redo' | 'canUndo' | 'canRedo'>;
  /** A dialog is open: outside its text boxes the keys do nothing. */
  dialog(): boolean;
  /** Translation mode is on: on the page the keys undo and redo the staged edits unless a control there keeps them. */
  page(): boolean;
}
/** Where the page's keys arrive and what has its focus (tests pass their own). */
export interface PageKeys {
  win: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  doc: Pick<Document, 'activeElement'>;
}

/**
 * Takes Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z in the app layer and, in translation mode, on the page; returns the
 * uninstaller. The text boxes' histories are kept in the capture phase, ahead of the views' own keys; the keys
 * outside text boxes are handled after the views' (bubble phase), so a view could still take them first.
 */
export function bindUndo(layer: HTMLElement, host: UndoHost, pg: PageKeys = { win: window, doc: document }): () => void {
  const box = (e: Event): Box | null => {
    const t = e.composedPath()[0];
    return isBox(t) ? t : null;
  };
  const storeStep = (u: 'undo' | 'redo'): void => {
    if (host.store.busy) return; // a save is writing the staged edits
    if (u === 'redo') host.store.redo();
    else host.store.undo();
  };
  const capture: Array<[string, (e: Event) => void]> = [
    ['keydown', (e) => {
      const t = box(e);
      const u = t && undoKey(e as KeyboardEvent);
      if (!t || !u) return;
      e.preventDefault(); // never the browser's undo, whose stack is the whole page's
      step(t, u);
    }],
    ['beforeinput', (e) => {
      const t = box(e);
      if (!t) return;
      const it = (e as InputEvent).inputType;
      if (it === 'historyUndo' || it === 'historyRedo') {
        // The context menu's Undo. Chromium sends it to the box that holds the page's last undo step, which need not be the
        // focused one: the focused box steps back. Cancelled, the browser's step stays in place, so while a box of ours
        // with typed steps stays on the page (the hidden Workbench's filter, the sheet's search), Ctrl+Z in a Dynamics
        // field can't reach that field's older steps (a known limit). The menu's Redo stays greyed: our keys never feed
        // the browser's stack (Ctrl+Y and Ctrl+Shift+Z work).
        e.preventDefault();
        const f = focused(t) ? t : deepActive(layer);
        if (f && isBox(f) && layer.contains(f)) step(f, it === 'historyUndo' ? 'undo' : 'redo');
      } else if (!comp.has(t)) pre.set(t, stateOf(t));
    }],
    ['input', (e) => {
      const t = box(e);
      if (!t || applying || (e as InputEvent).isComposing || comp.has(t)) return;
      const b = pre.get(t);
      pre.delete(t);
      if (b) historyOf(t).record(b, stateOf(t), kindOf((e as InputEvent).inputType || ''));
    }],
    ['compositionstart', (e) => {
      const t = box(e);
      if (t) comp.set(t, stateOf(t));
    }],
    ['compositionend', (e) => {
      const t = box(e);
      const b = t && comp.get(t);
      if (!t || !b) return;
      comp.delete(t);
      pre.delete(t);
      historyOf(t).record(b, stateOf(t), 'type');
    }],
  ];
  // Outside text boxes, in the translator: never the browser's undo either. A control that keeps the keys but has no
  // history of ours (a select, a read-only box) and a dialog get nothing; anywhere else the staged edits are undone.
  const ours = (e: Event): void => {
    const u = undoKey(e as KeyboardEvent);
    if (!u || e.defaultPrevented) return;
    e.preventDefault();
    if (!host.dialog() && !ownsKeys(e.composedPath()[0] as Element)) storeStep(u);
  };
  // On the page (keys in the translator stop at its host): with a step to take, wherever the focus is (the body, the
  // Dynamics button Done gave it back to, a link, a tab) but in a control that keeps the keys, a Dynamics field or a
  // grid cell's editor, which is left alone with its own undo.
  const onPage = (e: Event): void => {
    const u = undoKey(e as KeyboardEvent);
    if (!u || e.defaultPrevented || !host.page() || host.dialog() || host.store.busy) return;
    const a = deepest(pg.doc.activeElement);
    if (a && ownsKeys(a)) return;
    if (!(u === 'redo' ? host.store.canRedo() : host.store.canUndo())) return;
    e.preventDefault();
    storeStep(u);
  };
  for (const [k, f] of capture) layer.addEventListener(k, f, true);
  layer.addEventListener('keydown', ours);
  pg.win.addEventListener('keydown', onPage);
  return () => {
    for (const [k, f] of capture) layer.removeEventListener(k, f, true);
    layer.removeEventListener('keydown', ours);
    pg.win.removeEventListener('keydown', onPage);
  };
}

/** A new history for `t` (the grid's one cell editor, opened on another cell). `from`: the text that typing into the cell replaced; the first Ctrl+Z brings it back, selected. */
export function resetUndo(t: Box, from?: string): void {
  const u = new TextUndo();
  hist.set(t, u);
  pre.delete(t);
  comp.delete(t);
  if (from !== undefined) u.record({ v: from, s: 0, e: from.length }, stateOf(t), 'type');
}
/** Replaces the selection of `t` with `text` as one undoable edit (a paste the grid cleans up, Alt+Enter) and tells its listeners. */
export function insertText(t: Box, text: string, inputType = 'insertFromPaste'): void {
  const b = stateOf(t);
  t.setRangeText(text, b.s, b.e, 'end');
  pre.set(t, b);
  t.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
}
/**
 * What Ctrl+Z and Ctrl+Y do in `t` while nothing was typed in it since its history began: the grid's cell editor runs
 * the workbook's undo; a popup or editor card input opened on a staged text returns the text it replaces (the server
 * text), which Ctrl+Z then shows as one step of its own.
 */
export function whenEmpty(t: Box, fn: (u: 'undo' | 'redo') => string | void): void {
  fallback.set(t, fn);
}
