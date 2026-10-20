// Window chrome: one window that is docked to the right edge (full height, resizable by its left
// edge), floating (drag by the title bar, 8-direction resize) or maximized, plus a round pill at the
// bottom-right while minimized. Each view remembers its own layout per org in localStorage.
//
// The floating window keeps the user's *intent* (position and size, each either chosen by the user or
// automatic) and fits it to the viewport at every layout without overwriting it. So a window squeezed
// by a small browser window grows back when the browser grows again, an automatically sized window
// always follows the viewport, and a geometry stored from a small viewport never sticks.

import { h } from './dom';

export type WinMode = 'right' | 'float' | 'max';
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Floating placement as the user left it; a missing part is automatic (centred / default size). */
interface Place {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}
/** The window as laid out now (viewport pixels). */
export interface ShellState extends Rect {
  mode: WinMode;
  min: boolean;
}
/**
 * A view's default layout: its mode, and its automatic floating size, which is `w`×`h` or `fill` of
 * the viewport (default 92%), whichever is smaller.
 */
export interface ViewLayout {
  mode: WinMode;
  w: number;
  h: number;
  fill?: number;
}
export interface Shell {
  /** The `.app` layer every other layer (dialogs, menus, toasts) renders into. */
  layer: HTMLElement;
  win: HTMLElement;
  panel: HTMLElement;
  /** The minimized pill; the app fills in its content. */
  mini: HTMLButtonElement;
  readonly state: ShellState;
  /** Switches to the remembered layout of a view, or to `d` the first time. */
  use(view: string, d: ViewLayout): void;
  setMode(m: WinMode): void;
  toggleMax(): void;
  minimize(on: boolean): void;
  /** Hides the window and its minimized pill entirely (translation mode has no window); false shows them again. */
  hide(on: boolean): void;
  /** Makes `el` (the title bar) drag the window; double-click toggles maximize. */
  dragBy(el: HTMLElement): void;
  destroy(): void;
}

const MIN_W = 360;
const MIN_H = 400;
const DOCK_W = 440;
/** Share of the viewport an automatically sized floating window takes at most. */
const FILL = 0.92;
const MODES: readonly WinMode[] = ['right', 'float', 'max'];
const END = ['pointerup', 'pointercancel', 'lostpointercapture'] as const;
const vw = () => document.documentElement.clientWidth || innerWidth;
const vh = () => document.documentElement.clientHeight || innerHeight;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);

/** Keeps a floating window on screen; `loose` (while and after dragging) only keeps the title bar reachable. */
function fit(r: Rect, loose = false): Rect {
  const W = vw();
  const H = vh();
  const w = Math.round(Math.min(Math.max(r.w, Math.min(MIN_W, W)), W));
  const hh = Math.round(Math.min(Math.max(r.h, Math.min(MIN_H, H)), H));
  const x = loose ? Math.min(Math.max(r.x, 120 - w), W - 120) : Math.min(Math.max(r.x, 0), W - w);
  const y = loose ? Math.min(Math.max(r.y, 0), H - 56) : Math.min(Math.max(r.y, 0), H - hh);
  return { x: Math.round(x), y: Math.round(y), w, h: hh };
}

interface Saved {
  dock: number;
  v: Record<string, { m: WinMode; p: Place }>;
}

/**
 * Reads the remembered layouts. Version 1 stored the floating rectangle after it had been squeezed into
 * the viewport of that moment, which is exactly what must not stick: only its modes are kept.
 */
function readSaved(key: string): Saved {
  const out: Saved = { dock: DOCK_W, v: {} };
  try {
    const s = JSON.parse(localStorage.getItem(key) || 'null');
    if (!s || typeof s !== 'object') return out;
    if (num(s.dock)) out.dock = num(s.dock)!;
    for (const [view, e] of Object.entries((s.v && typeof s.v === 'object' ? s.v : {}) as Record<string, { m?: unknown; p?: Record<string, unknown> }>)) {
      if (!e || !MODES.includes(e.m as WinMode)) continue;
      const p = s.ver === 2 && e.p && typeof e.p === 'object' ? e.p : {};
      out.v[view] = { m: e.m as WinMode, p: { x: num(p.x), y: num(p.y), w: num(p.w), h: num(p.h) } };
    }
  } catch {
    /* storage blocked or corrupt: defaults */
  }
  return out;
}

export function createShell(root: ShadowRoot, o: { key: string; onChange(s: ShellState): void }): Shell {
  const layer = h('div', { class: 'app' });
  const panel = h('div', { class: 'panel', tabIndex: -1 });
  const win = h('div', { class: 'win' }, panel, ...['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => h('div', { class: 'rz ' + d, 'data-d': d })));
  const mini = h('button', { class: 'mini', type: 'button', hidden: true, 'aria-label': 'Open the translator', on: { click: () => minimize(false) } });
  layer.append(win, mini);
  root.append(layer);

  const saved = readSaved(o.key);
  let view = '';
  let def: ViewLayout = { mode: 'right', w: 560, h: 760 };
  let mode: WinMode = 'right';
  let prev: WinMode = 'float';
  let place: Place = {};
  // After the user drags the window partly off-screen it stays there, until the viewport changes or
  // the layout is restored, which clamp it fully on screen again.
  let loose = false;
  let min = false;
  let gone = false;
  let box: Rect = { x: 0, y: 0, w: 0, h: 0 };

  const persist = () => {
    if (!view) return;
    saved.v[view] = { m: mode, p: { ...place } };
    try {
      localStorage.setItem(o.key, JSON.stringify({ ver: 2, dock: saved.dock, v: saved.v }));
    } catch {
      /* not remembered */
    }
  };

  /** The floating window for the current viewport: the user's placement where given, else automatic. */
  function floatRect(): Rect {
    const W = vw();
    const H = vh();
    const fill = def.fill ?? FILL;
    const w = place.w ?? Math.min(def.w, Math.round(W * fill));
    const hh = place.h ?? Math.min(def.h, Math.round(H * fill));
    return fit({ x: place.x ?? (W - w) / 2, y: place.y ?? (H - hh) / 2, w, h: hh }, loose);
  }

  const dockWidth = (W: number) => Math.round(Math.min(Math.max(saved.dock, MIN_W), Math.max(MIN_W, W - 120), W));

  function layout(): void {
    const W = vw();
    const H = vh();
    if (mode === 'max') box = { x: 0, y: 0, w: W, h: H };
    else if (mode === 'right') {
      const w = dockWidth(W);
      box = { x: W - w, y: 0, w, h: H };
    } else box = floatRect();
    win.className = 'win ' + (mode === 'right' ? 'dock' : mode);
    Object.assign(win.style, { left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px' });
    win.hidden = gone || min;
    mini.hidden = gone || !min;
    o.onChange({ ...box, mode, min });
  }

  function setMode(m: WinMode): void {
    if (m === mode) return;
    if (m === 'max') prev = mode;
    mode = m;
    loose = false;
    layout();
    persist();
  }

  function hide(on: boolean): void {
    if (on === gone) return;
    gone = on;
    layout();
  }

  function minimize(on: boolean): void {
    if (on === min) return;
    const had = win.contains(root.activeElement);
    min = on;
    layout();
    // Keep keyboard users in the app: focus moves to the pill and back.
    if (!on) panel.focus();
    else if (had) mini.focus();
  }

  // ---- drag and resize ----
  let drag: { d: string; sx: number; sy: number; g: Rect; id: number; moved: boolean; el: HTMLElement } | null = null;

  function start(e: PointerEvent, d: string): void {
    if (e.button !== 0 || drag || min) return;
    if (d === 'move' && (e.target as Element).closest('button,a,input,select,textarea')) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    drag = { d, sx: e.clientX, sy: e.clientY, g: { ...box }, id: e.pointerId, moved: false, el };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* the layer class below still keeps the events */
    }
    layer.classList.add(d === 'move' ? 'moving' : 'sizing');
    layer.style.cursor = d === 'move' ? 'move' : getComputedStyle(el).cursor;
    el.addEventListener('pointermove', move);
    for (const t of END) el.addEventListener(t, end);
  }

  function move(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) < 4) return;
      drag.moved = true;
      if (drag.d === 'move' && mode !== 'float') {
        // Tearing a docked or maximized window off: float it under the pointer at the same relative grab point.
        mode = 'float';
        loose = true;
        const w = floatRect().w;
        place = { ...place, x: Math.round(drag.sx - ((drag.sx - box.x) / Math.max(1, box.w)) * w), y: box.y };
        drag.g = floatRect();
        layout();
      }
    }
    const g = drag.g;
    const d = drag.d;
    if (d === 'move') {
      loose = true;
      const r = fit({ ...g, x: g.x + dx, y: g.y + dy }, true);
      // Moving keeps an automatic size automatic, so it still follows the viewport later.
      place = { ...place, x: r.x, y: r.y };
    } else if (mode === 'right') saved.dock = Math.round(Math.min(Math.max(g.w - dx, MIN_W), vw() - 120));
    else {
      const W = vw();
      const H = vh();
      const mw = Math.min(MIN_W, W);
      const mh = Math.min(MIN_H, H);
      const r = { ...g };
      if (d.includes('e')) r.w = Math.max(mw, Math.min(g.w + dx, W - g.x));
      if (d.includes('s')) r.h = Math.max(mh, Math.min(g.h + dy, H - g.y));
      if (d.includes('w')) {
        const x = Math.max(Math.min(0, g.x), Math.min(g.x + dx, g.x + g.w - mw));
        r.w = g.w + g.x - x;
        r.x = x;
      }
      if (d.includes('n')) {
        const y = Math.max(0, Math.min(g.y + dy, g.y + g.h - mh));
        r.h = g.h + g.y - y;
        r.y = y;
      }
      // A resized window has a size the user chose: remember all of it.
      place = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
    }
    layout();
  }

  function end(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.id) return;
    const { el, moved, d } = drag;
    drag = null;
    el.removeEventListener('pointermove', move);
    for (const t of END) el.removeEventListener(t, end);
    layer.classList.remove('moving', 'sizing');
    layer.style.cursor = '';
    if (!moved) return;
    // Snap: dropping on the right edge docks, on the top edge maximizes.
    if (d === 'move' && e.type === 'pointerup' && e.clientX >= vw() - 6) setMode('right');
    else if (d === 'move' && e.type === 'pointerup' && e.clientY <= 2) setMode('max');
    persist();
  }

  for (const rz of win.querySelectorAll<HTMLElement>('.rz')) rz.addEventListener('pointerdown', (e) => start(e, rz.dataset.d || 'e'));

  // The viewport changed: fit the window again from the user's intent (never from the last fitted box).
  const onResize = () => {
    if (drag) return;
    loose = false;
    layout();
  };
  addEventListener('resize', onResize);

  return {
    layer,
    win,
    panel,
    mini,
    get state() {
      return { ...box, mode, min };
    },
    use(v, d) {
      if (v === view) return;
      view = v;
      def = d;
      const s = saved.v[v];
      mode = s?.m ?? d.mode;
      place = s ? { ...s.p } : {};
      prev = mode === 'max' ? 'float' : mode;
      loose = false;
      layout();
    },
    setMode,
    toggleMax: () => setMode(mode === 'max' ? prev : 'max'),
    minimize,
    hide,
    dragBy(el) {
      el.addEventListener('pointerdown', (e) => start(e, 'move'));
      el.addEventListener('dblclick', (e) => {
        if (!(e.target as Element).closest('button,a,input,select,textarea')) setMode(mode === 'max' ? prev : 'max');
      });
    },
    destroy() {
      removeEventListener('resize', onResize);
      if (drag) {
        drag.el.removeEventListener('pointermove', move);
        for (const t of END) drag.el.removeEventListener(t, end);
        drag = null;
      }
      layer.remove();
    },
  };
}
