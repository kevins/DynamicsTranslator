// Shared widgets for the shell and the views. They render into the app layer (the `.app` element in
// the shadow root, registered with setLayer) and build all text with DOM nodes, so Dataverse labels
// can never become markup. Menus, popovers, dialogs and sheets join one layer stack, so Escape always
// closes the topmost one first.

import { isAbort } from '../core/http';
import type { Kind } from '../core/model';
import { h, icon, put, type Child, type IconName } from './dom';
import type { ConfirmOptions, ToastKind } from './types';

let L: HTMLElement;
/** The toast stack; null before setLayer() and after teardownLayer(), when toasts are dropped. */
let tbox: HTMLElement | null = null;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Registers the app layer that dialogs, menus, popovers, tooltips and toasts render into; returns the toast stack. */
export function setLayer(el: HTMLElement): HTMLElement {
  L = el;
  const box = h('div', { class: 'toasts', role: 'region', 'aria-label': 'Notifications', 'aria-live': 'polite' });
  el.append(box);
  tbox = box;
  return box;
}

/** The focused element inside the (shadow) root that contains `n`. */
export const active = (n: Node): Element | null => (n.getRootNode() as Document | ShadowRoot).activeElement;

export function frag(...n: Array<Node | null | false | undefined>): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const x of n) if (x) f.append(x);
  return f;
}

/** A user-facing message for any thrown value. */
export function errMsg(e: unknown): string {
  if (isAbort(e)) return 'Stopped.';
  const m = (e instanceof Error ? e.message : typeof e === 'string' ? e : '') || 'Something went wrong.';
  if (/0x80071151|Cannot start another/i.test(m)) return 'Dataverse is busy with another customization. Your edits are still pending; try again in a minute.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Could not reach Dataverse. Check your connection; your edits are still pending.';
  return m;
}

// ---- layer stack ----

interface Layer {
  el: HTMLElement;
  close(): void;
}
const stack: Layer[] = [];

/** Registers an open layer; returns the function that unregisters it. */
export function pushLayer(el: HTMLElement, close: () => void): () => void {
  const t = { el, close };
  stack.push(t);
  return () => {
    const i = stack.indexOf(t);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Closes the topmost visible layer. Returns false when nothing was open. */
export function closeTop(): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    const t = stack[i];
    if (!t.el.isConnected) stack.splice(i, 1);
    else if (!t.el.hidden) {
      t.close();
      return true;
    }
  }
  return false;
}

export const modalOpen = (): boolean => stack.some((t) => t.el.classList.contains('scrim') && t.el.isConnected);

/** Closes every layer (menus, popovers, dialogs, sheets) and the tooltip. */
export function closeAll(): void {
  for (const t of stack.splice(0).reverse()) {
    try {
      t.close();
    } catch {
      /* already gone */
    }
    t.el.remove();
  }
  hideTip();
}

/**
 * Used when the app is torn down: closes every layer and removes the toasts with their timers. Toasts
 * raised afterwards (e.g. by a load that the teardown just stopped) are dropped, so no timer outlives it.
 */
export function teardownLayer(): void {
  closeAll();
  for (const t of toastTimers) clearTimeout(t);
  toastTimers.clear();
  tbox?.replaceChildren();
  tbox = null;
}

// ---- positioning ----

/** Positions an absolutely positioned layer element next to an anchor, flipping and clamping to the viewport. */
export function place(el: HTMLElement, anchor: Element | DOMRect, o: { end?: boolean; above?: boolean; gap?: number } = {}): void {
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
  const g = o.gap ?? 4;
  const W = L.clientWidth;
  const H = L.clientHeight;
  el.style.maxHeight = '';
  const w = el.offsetWidth;
  const hh = el.offsetHeight;
  const below = H - r.bottom - g - 8;
  const above = r.top - g - 8;
  const up = o.above ? above >= hh || above > below : below < hh && above > below;
  const room = Math.max(80, up ? above : below);
  if (hh > room) el.style.maxHeight = room + 'px';
  el.style.top = (up ? Math.max(8, r.top - g - Math.min(hh, room)) : r.bottom + g) + 'px';
  el.style.left = Math.max(8, Math.min(o.end ? r.right - w : r.left, W - w - 8)) + 'px';
}

// ---- popovers and menus ----

export interface Pop {
  el: HTMLElement;
  close(): void;
}
const openPops = new WeakMap<Element, Pop>();

/**
 * Opens a popover under `anchor`. Clicking the same anchor again closes it (and returns null).
 * Closes on outside pointerdown and Escape; focus returns to the anchor when it was inside.
 */
export function popover(anchor: HTMLElement, content: Node, o: { cls?: string; end?: boolean; label?: string; onClose?: () => void } = {}): Pop | null {
  const prev = openPops.get(anchor);
  if (prev) {
    prev.close();
    return null;
  }
  const el = h('div', { class: 'pop ' + (o.cls || ''), 'aria-label': o.label }, content);
  L.append(el);
  place(el, anchor, { end: o.end });
  anchor.setAttribute('aria-expanded', 'true');
  let done = false;
  const down = (e: Event) => {
    const p = e.composedPath();
    if (!p.includes(el) && !p.includes(anchor)) close();
  };
  const close = () => {
    if (done) return;
    done = true;
    const had = el.contains(active(el));
    document.removeEventListener('pointerdown', down, true);
    off();
    el.remove();
    anchor.setAttribute('aria-expanded', 'false');
    openPops.delete(anchor);
    if (had) anchor.focus();
    o.onClose?.();
  };
  document.addEventListener('pointerdown', down, true);
  const off = pushLayer(el, close);
  const p = { el, close };
  openPops.set(anchor, p);
  return p;
}

export type MenuItem =
  | '-'
  | { head: string }
  | { label: string; hint?: string; icon?: IconName; checked?: boolean; radio?: boolean; disabled?: boolean; danger?: boolean; keep?: boolean; run?(): void };

/** A keyboard-navigable menu under `anchor`. Items with `keep` toggle `checked` in place and leave the menu open. */
export function menu(anchor: HTMLElement, items: MenuItem[], o: { end?: boolean } = {}): Pop | null {
  const box = h('div', { role: 'menu' });
  const p = popover(anchor, box, { cls: 'menu', end: o.end });
  if (!p) return null;
  for (const it of items) {
    if (it === '-') box.append(h('div', { class: 'msep', role: 'separator' }));
    else if ('head' in it) box.append(h('div', { class: 'mh' }, it.head));
    else {
      const ck = h('span', { class: 'ck' });
      const b = h(
        'button',
        {
          class: 'mi' + (it.danger ? ' danger' : ''),
          type: 'button',
          role: it.checked === undefined ? 'menuitem' : it.radio ? 'menuitemradio' : 'menuitemcheckbox',
          disabled: it.disabled,
          tabIndex: -1,
          on: {
            click: () => {
              if (it.keep) {
                it.checked = !it.checked;
                sync();
              } else p.close();
              it.run?.();
            },
          },
        },
        ck,
        it.icon && icon(it.icon),
        h('span', { class: 'tx' }, it.label, it.hint && h('small', null, it.hint)),
      );
      const sync = () => {
        put(ck, it.checked ? icon('check') : '');
        b.setAttribute('aria-checked', String(!!it.checked));
      };
      if (it.checked !== undefined) sync();
      box.append(b);
    }
  }
  const btns = () => [...box.querySelectorAll<HTMLButtonElement>('.mi:not(:disabled)')];
  box.addEventListener('keydown', (e) => {
    const bs = btns();
    const i = bs.indexOf(active(box) as HTMLButtonElement);
    const j = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? (i < 0 ? -1 : i - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? -1 : null;
    if (e.key === 'Tab') p.close();
    if (j === null || !bs.length) return;
    e.preventDefault();
    bs[(j + bs.length) % bs.length].focus();
  });
  place(p.el, anchor, { end: o.end });
  (box.querySelector<HTMLElement>('[role=menuitemradio][aria-checked=true]') || btns()[0])?.focus();
  return p;
}

// ---- tooltip ----

let tipEl: HTMLElement | null = null;
let tipT: ReturnType<typeof setTimeout> | undefined;
let tipW: ReturnType<typeof setInterval> | undefined;
export function hideTip(): void {
  clearTimeout(tipT);
  clearInterval(tipW);
  tipEl?.remove();
  tipEl = null;
}
/** A delayed hover/focus tooltip. `text` may be a function for dynamic text ('' shows nothing). */
export function tooltip(el: HTMLElement, text: string | (() => string)): void {
  const show = (e: Event) => {
    if (e.type === 'focusin' && !el.matches(':focus-visible')) return;
    clearTimeout(tipT);
    tipT = setTimeout(() => {
      const s = typeof text === 'function' ? text() : text;
      if (!s || !el.isConnected) return;
      hideTip();
      tipEl = h('div', { class: 'tip', role: 'tooltip' }, s);
      L.append(tipEl);
      place(tipEl, el, { above: true, gap: 6 });
      // A re-render can remove the anchor under the pointer; it then never gets pointerleave.
      tipW = setInterval(() => el.isConnected || hideTip(), 300);
    }, 450);
  };
  el.addEventListener('pointerenter', show);
  el.addEventListener('focusin', show);
  for (const ev of ['pointerleave', 'focusout', 'pointerdown', 'keydown']) el.addEventListener(ev, hideTip);
}

// ---- dialogs ----

const FOC = 'button,input,textarea,select,a[href],[tabindex]:not([tabindex="-1"])';
const focusables = (el: Element) => [...el.querySelectorAll<HTMLElement>(FOC)].filter((x) => !(x as HTMLButtonElement).disabled && x.offsetParent !== null);

/**
 * Opens a modal dialog and resolves when it closes. `build` returns the dialog content (usually a
 * `.dlg-body` and a `.dlg-actions`) and receives close() and the dialog element (to retitle or swap
 * content). `canClose` can veto Escape, the scrim and the close button (e.g. while saving).
 * An element with `data-af` gets the initial focus.
 */
export function modal<T = void>(
  title: string,
  build: (close: (v?: T) => void, dlg: HTMLElement) => Node,
  o: { wide?: boolean; canClose?: () => boolean } = {},
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const back = active(L) as HTMLElement | null;
    const id = 'd' + Math.random().toString(36).slice(2, 9);
    const dlg = h('div', { class: 'dialog' + (o.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id, tabIndex: -1 });
    const scrim = h('div', { class: 'scrim' }, dlg);
    let done = false;
    const close = (v?: T) => {
      if (done) return;
      done = true;
      off();
      scrim.remove();
      hideTip();
      if (back?.isConnected) back.focus();
      resolve(v);
    };
    const tryClose = () => {
      if (!o.canClose || o.canClose()) close();
    };
    const off = pushLayer(scrim, tryClose);
    // A click on the scrim closes, but not the second click of the double-click (or the click right after the
    // shortcut) that opened the dialog: the scrim appears under the pointer, and the dialog would close at once.
    const born = performance.now();
    let downOut = false;
    scrim.addEventListener('pointerdown', (e) => (downOut = e.target === scrim && performance.now() - born > 300));
    scrim.addEventListener('click', (e) => downOut && e.detail < 2 && e.target === scrim && tryClose());
    dlg.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = focusables(dlg);
      if (!f.length) return;
      const i = f.indexOf(active(dlg) as HTMLElement);
      if (e.shiftKey ? i <= 0 : i === f.length - 1) {
        e.preventDefault();
        f[e.shiftKey ? f.length - 1 : 0].focus();
      }
    });
    dlg.append(h('div', { class: 'dlg-h' }, h('h3', { id }, title), ibtn('close', 'Close', tryClose)));
    try {
      dlg.append(build(close, dlg));
    } catch (e) {
      // Reject (a throw here would be swallowed by the executor) so callers can report it.
      done = true;
      off();
      return reject(e);
    }
    if (done) return;
    L.append(scrim);
    requestAnimationFrame(() => (dlg.querySelector<HTMLElement>('[data-af]') || dlg).focus());
  });
}

/** Two-button confirmation. Danger dialogs focus the safe button first. */
export function confirm(o: ConfirmOptions): Promise<boolean> {
  return modal<boolean>(o.title, (close) => {
    const ok = btn(o.ok, () => close(true), o.danger ? 'danger' : 'primary');
    const no = btn(o.cancel || 'Cancel', () => close(false));
    (o.danger ? no : ok).dataset.af = '';
    return frag(h('div', { class: 'dlg-body' }, typeof o.body === 'string' ? h('p', null, o.body) : o.body), h('div', { class: 'dlg-actions' }, ok, no));
  }).then((v) => !!v);
}

// ---- toasts ----

const TI: Record<ToastKind, IconName> = { info: 'info', ok: 'okc', warn: 'warn', error: 'error' };
/** Pending toast timers, cleared by teardownLayer() so none outlives the app. */
const toastTimers = new Set<ReturnType<typeof setTimeout>>();
const later = (fn: () => void, ms: number) => {
  const t = setTimeout(() => {
    toastTimers.delete(t);
    fn();
  }, ms);
  toastTimers.add(t);
  return t;
};

/** A transient notification above the footer; pauses while hovered. */
export function toast(message: string, kind: ToastKind = 'info', action?: { label: string; run: () => void }): void {
  const box = tbox;
  if (!box) return;
  let t: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(t);
    if (t !== undefined) toastTimers.delete(t);
  };
  const bye = () => {
    stop();
    if (!el.isConnected || el.classList.contains('out')) return;
    el.classList.add('out');
    later(() => el.remove(), reduced() ? 0 : 150);
  };
  const el = h(
    'div',
    { class: 'toast ' + kind, role: kind === 'error' ? 'alert' : 'status' },
    h('span', { class: 'ic' }, icon(TI[kind])),
    h('div', { class: 'txt' }, message, action && h('button', { class: 'link act', type: 'button', on: { click: () => (bye(), action.run()) } }, action.label)),
    h('button', { class: 'x', type: 'button', 'aria-label': 'Dismiss', on: { click: bye } }, icon('close')),
  );
  const arm = () => {
    stop();
    t = later(bye, kind === 'error' ? 10000 : action || kind === 'warn' ? 8000 : 5000);
  };
  el.addEventListener('pointerenter', stop);
  el.addEventListener('pointerleave', arm);
  box.append(el);
  while (box.children.length > 4) box.firstElementChild!.remove();
  arm();
}

// ---- small building blocks ----

export const btn = (label: string | Node, run: (e: MouseEvent) => void, cls = ''): HTMLButtonElement =>
  h('button', { class: 'btn ' + cls, type: 'button', on: { click: run } }, label);

export const link = (label: string, run: (e: MouseEvent) => void): HTMLButtonElement => h('button', { class: 'link', type: 'button', on: { click: run } }, label);

/** Icon-only button with an accessible name and a tooltip that follows aria-label changes. */
export function ibtn(name: IconName, label: string, run: (e: MouseEvent) => void, cls = 'subtle', size = 16): HTMLButtonElement {
  const b = h('button', { class: 'btn icon ' + cls, type: 'button', 'aria-label': label, on: { click: run } }, icon(name, size));
  tooltip(b, () => b.getAttribute('aria-label') || '');
  return b;
}

/** Inline note: neutral, 'bad' (red), 'amb' (amber), 'ok' (green) or 'info' (brand). */
export const note = (ic: IconName, content: Child, tone = ''): HTMLElement =>
  h('div', { class: 'note ' + tone }, icon(ic), h('div', null, content));

export const badge = (text: string, tone = ''): HTMLElement => h('span', { class: 'badge ' + tone }, text);

export const spinner = (): HTMLElement => h('span', { class: 'spin', role: 'progressbar', 'aria-label': 'Working' });

/** Filter pill (`.fp`): bold key, grey value, chevron. `set(value, on)` updates it. */
export function pill(k: string, v = '', o: { on?: boolean; caret?: boolean; run?: (e: MouseEvent) => void } = {}): HTMLButtonElement & { set(v: string, on?: boolean): void } {
  const vs = h('span', { class: 'v' });
  const b = Object.assign(
    h('button', { class: 'fp', type: 'button', 'aria-haspopup': o.caret === false ? null : 'true', on: { click: (e) => o.run?.(e) } }, h('span', { class: 'k' }, k), vs, o.caret !== false && icon('chevron')),
    {
      set(val: string, on = !!val) {
        vs.textContent = val;
        vs.hidden = !val;
        b.classList.toggle('on', on);
      },
    },
  );
  b.set(v, o.on);
  return b;
}

/** Shimmering placeholder rows (`.sk`) while something loads. */
export function skeleton(rows = 6): DocumentFragment {
  const f = document.createDocumentFragment();
  for (let i = 0; i < rows; i++) {
    const w = 38 + ((i * 29) % 44);
    f.append(
      h('div', { class: 'sk', 'aria-hidden': 'true' },
        h('i', { style: { width: '20px', height: '20px', flex: 'none' } }),
        h('div', { style: { flex: '1' } }, h('i', { style: { width: w + '%', height: '12px' } }), h('i', { class: 'ln2', style: { width: Math.round(w * 0.6) + '%', height: '10px' } })),
      ),
    );
  }
  return f;
}

export function emptyState(ic: IconName, title: string, text?: string | Node, actions?: Node[], tone = ''): HTMLElement {
  return h('div', { class: 'empty' }, h('div', { class: 'ic ' + tone }, icon(ic, 24)), h('b', null, title), text ? h('div', null, text) : null, actions?.length ? h('div', { class: 'acts' }, actions) : null);
}

/** Progress bar (`.pbar`); set(null) shows an indeterminate bar. */
export function bar(): HTMLElement & { set(f: number | null): void } {
  const i = h('i');
  const el = Object.assign(h('div', { class: 'pbar ind', role: 'progressbar', 'aria-label': 'Progress' }, i), {
    set(f: number | null) {
      el.classList.toggle('ind', f === null);
      i.style.width = f === null ? '' : Math.round(Math.max(0, Math.min(1, f)) * 100) + '%';
      if (f === null) el.removeAttribute('aria-valuenow');
      else el.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    },
  });
  return el;
}

const KI: Record<Kind, IconName> = {
  entity: 'entity', attribute: 'field', relationship: 'link', option: 'choice', globaloptionset: 'choice', globaloption: 'choice',
  boolean: 'choice', state: 'choice', status: 'choice', view: 'view', chart: 'chart', form: 'form', tab: 'form', section: 'form',
  field: 'field', navitem: 'nav', dashboard: 'dash', dtab: 'dash', dsection: 'dash', dfield: 'dash', app: 'app', area: 'nav',
  group: 'nav', subarea: 'nav', bpf: 'flow', stage: 'flow', step: 'flow', ribbon: 'command', command: 'command', envvar: 'bolt',
  customapi: 'bolt',
};
export const kindIcon = (k: Kind): IconName => KI[k] || 'edit';
