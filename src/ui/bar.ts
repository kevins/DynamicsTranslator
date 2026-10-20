// The translation-mode bar: a slim floating Fluent toolbar, bottom centre by default, right of Dynamics' left
// navigation so the area switcher at its foot stays usable (barSpan, clearOf). Drag it by its logo
// (double-click the logo to put it back); the place is kept in prefs.bar as fractions of the free room, so it
// follows the viewport as it changes. Left to right: the logo, "Translator", the languages, one status text
// (loading, a load problem, the hint, or the number of staged changes), "Review and publish", "All labels",
// "Workbench", ⋯ (Recent publishes, Refresh page, Show Dynamics in <language>, the version) and ✕.

import { lcidShort } from '../core/lcid';
import type { Lcid } from '../core/model';
import { shownLanguage } from '../core/uilang';
import type { CreateBar, PageNote } from '../inspector/types';
import css from './bar.css';
import { h, icon, plural, put, rafThrottle } from './dom';
import { langName } from './editor';
import type { AppApi, Prefs } from './types';
import { active, ibtn, link, menu, spinner, tooltip, type MenuItem } from './widgets';

/** Smallest gap to the viewport edges, and the default gap above its bottom. */
const M = 8;
const GAP = 16;
const MAX_W = 1040;
/** The least room the bar keeps right of Dynamics' left navigation; with less it may sit over the navigation. */
const NAV_ROOM = 480;

/** Dynamics' left navigation (the site map, the area switcher at its foot), where it is on screen at the left. */
const NAV = '[data-id="navbar-container"]';
/** The area switcher, at the foot of the navigation. */
const SWITCHER = '#areaSwitcherContainer,#areaSwitcherId';
/** The switcher's list of areas while it is open: wider than a collapsed navigation, the bar keeps clear of it too. */
const AREAS = '[data-lp-id="sitemap-area-switcher-flyout"]';

/** A box on screen: left, top, right, bottom. */
export type Box = { left: number; top: number; right: number; bottom: number };

/**
 * The bar's horizontal room, [left, right]: left of a full-height sheet on the right (All labels), and right of
 * Dynamics' left navigation (`nav`, its box at the left edge) while that leaves NAV_ROOM, so the bar never covers the
 * area switcher at the navigation's foot.
 */
export function barSpan(W: number, sheetLeft: number | null, nav: Box | null): [number, number] {
  const hi = sheetLeft !== null && sheetLeft > 360 ? sheetLeft : W;
  const lo = nav && nav.left <= M && nav.right > 0 && nav.right < W / 2 && hi - nav.right >= NAV_ROOM ? nav.right : 0;
  return [lo, hi];
}

/**
 * The bar's top, raised above the area switcher (`sw`) when the bar would cover it: a window too narrow to keep the
 * bar right of the navigation, or a bar dragged over it.
 */
export function clearOf(top: number, h: number, left: number, w: number, sw: Box | null): number {
  if (!sw || left >= sw.right || left + w <= sw.left || top >= sw.bottom || top + h <= sw.top) return top;
  return Math.max(M, sw.top - h - M);
}

/** An element's box when it is on screen, else null. */
function boxOf(sel: string): Box | null {
  const r = document.querySelector(sel)?.getBoundingClientRect();
  return r && r.width > 0 && r.height > 0 ? r : null;
}

/** The navigation with the switcher's open list of areas, which reaches past a collapsed navigation. */
export function navWith(nav: Box | null, areas: Box | null): Box | null {
  if (!nav || !areas || areas.left > nav.right) return nav;
  return { left: nav.left, top: Math.min(nav.top, areas.top), right: Math.max(nav.right, areas.right), bottom: Math.max(nav.bottom, areas.bottom) };
}

type Tone = '' | 'busy' | 'error' | 'count';
interface Status {
  tone: Tone;
  text: string;
  /** A link after the text (Try again). */
  act?: [label: string, run: () => void];
  /** More about it, in the status's tooltip. */
  tip?: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const frac = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : d);
const safe = <T>(fn: () => T, d: T): T => {
  try {
    return fn();
  } catch (e) {
    if (__DEV__) console.error('[translator]', e);
    return d;
  }
};

/**
 * The empty-state hint: what to do, and what the colours mean (orange only when there is a language to translate
 * into; green is a change waiting for Publish; grey is text that can't be translated here: Microsoft's built-in text,
 * a read-only label, whose popup says why).
 */
export function hintText(target: string | null): string {
  return `Click any highlighted text to translate it.${target ? ` Orange = no ${target} yet,` : ''}${target ? ' green' : ' Green'} = changed, not published yet, grey = can't be translated here. Hold Alt to click normally.`;
}

/**
 * The Dynamics entries of the ⋯ menus (this bar's and the Workbench's): Refresh page (ui/refresh.ts), and "Show
 * Dynamics in" each provisioned language but the one on screen, which sets the user's language for good and
 * refreshes in it. On screen is what the page renders (`<html lang>`), not `ctx.user`: after a change made elsewhere
 * the page context already says the new language while the page still shows the old one (LIVE-FINDINGS 78), and the
 * new one must be offered.
 */
export function dynamicsItems(app: AppApi, shown = shownLanguage(app.ctx.langs.map((l) => l.lcid), app.ctx.user)): MenuItem[] {
  const others = app.ctx.langs.filter((l) => l.lcid !== shown);
  const show: MenuItem[] = others.map((l) => ({ label: langName(app, l.lcid), icon: 'globe', run: () => void app.showDynamicsIn(l.lcid) }));
  return [
    { label: 'Refresh page', icon: 'refresh', hint: 'Clear the Dynamics caches and reload', run: () => void app.refreshPage() },
    ...(show.length ? ['-' as const, { head: 'Show Dynamics in' }, ...show] : []),
  ];
}

export const createBar: CreateBar = (app, mode, o) => {
  app.adoptStyles(css);
  const { ctx, store } = app;
  const L = app.layer;
  const host = app.root.host;
  const name = (l: Lcid) => langName(app, l);

  let destroyed = false;
  /** Left edge of a full-height sheet on the right (All labels), which the bar keeps clear of. */
  let sheetLeft: number | null = null;
  /** The position while dragging (fractions of the free room). */
  let live: { x: number; y: number } | null = null;
  let pulseT: ReturnType<typeof setTimeout> | undefined;
  let stKey: string | null = null;
  let statusTip = '';
  let langTip = '';

  // ---- the bar ----
  const grip = h('span', { class: 'logo tb-grip', 'aria-hidden': 'true' }, icon('globe', 18));
  // A menu of languages only when there is a choice to make (3 or more provisioned); with two languages there is
  // nothing to choose, and the popup shows both anyway, so the bar leaves it out.
  const many = ctx.langs.length >= 3;
  const langEl: HTMLElement = many
    ? h('button', { class: 'btn subtle tb-lang', type: 'button', 'aria-haspopup': 'menu', on: { click: () => app.langMenu(langEl) } })
    : h('span', { class: 'tb-lang' });
  tooltip(langEl, () => langTip);
  const stIc = h('span', { class: 'tb-ic' });
  const stTx = h('span', { class: 'tb-tx' });
  const stBox = h('span', { class: 'tb-st', role: 'status' }, stIc, stTx);
  const stA = h('span', { class: 'tb-sa' });
  const stw = h('div', { class: 'tb-stw' }, stBox, stA);
  tooltip(stBox, () => statusTip || (stTx.scrollWidth > stTx.clientWidth || stTx.scrollHeight > stTx.clientHeight ? stTx.textContent || '' : ''));
  // The full label is read by screen readers; narrow bars show "Publish".
  const pubB = h('button', { class: 'btn primary tb-pub', type: 'button', on: { click: () => publish() } },
    h('span', { class: 'tb-pl' }, 'Review and publish'), h('span', { class: 'tb-ps', 'aria-hidden': 'true' }, 'Publish'));
  const allB = h('button', { class: 'btn subtle', type: 'button', on: { click: () => o.list() } }, icon('list'), h('span', { class: 'tb-c1' }, 'All labels'));
  tooltip(allB, 'All labels on this page');
  const wbB = h('button', { class: 'btn subtle', type: 'button', on: { click: () => o.workbench() } }, icon('table'), h('span', { class: 'tb-c1' }, 'Workbench'));
  tooltip(wbB, 'Every label of a table or solution in a spreadsheet');
  const moreB = ibtn('more', 'More options', () => moreMenu(), 'subtle');
  moreB.setAttribute('aria-haspopup', 'menu');
  const exitB = ibtn('close', 'Close the translator', () => o.exit(), 'subtle');
  const bar = h('div', { class: 'tb', role: 'toolbar', 'aria-label': 'Dynamics Translator' },
    grip, h('span', { class: 'tb-title' }, 'Translator'), many && langEl, h('span', { class: 'tb-div', 'aria-hidden': 'true' }), stw, pubB, allB, wbB, moreB, exitB);
  const el = h('div', { class: 'tbx' }, bar);

  function syncLang(): void {
    const base = ctx.base;
    const t = app.prefs.target;
    const label = (nm: (l: Lcid) => string) => (t === base ? nm(base) : `${nm(base)} → ${nm(t)}`);
    langTip = t === base ? `Languages: ${name(base)}` : `Translating from ${name(base)} into ${name(t)}`;
    // Only the full names are read by screen readers; narrow bars show the codes instead.
    put(langEl, h('span', { class: 'tb-ln' }, label(name)), h('span', { class: 'tb-ls', 'aria-hidden': 'true' }, label(lcidShort)), many && icon('chevron'));
  }

  /** Review and publish: looks disabled without changes, but still answers. */
  function publish(): void {
    if (!count()) return app.toast('Nothing to publish yet', 'info');
    o.publish();
  }
  const count = (): number => safe(() => mode.counts().pending, store.pendingCount());

  // ---- what to say ----
  function status(loading: boolean, notes: PageNote[], n: number): Status {
    if (loading) return { tone: 'busy', text: 'Loading translations…' };
    const retry = notes.find((nt) => nt.action && nt.run);
    if (notes.length) return { tone: 'error', text: "Couldn't load some labels.", act: retry ? [retry.action!, () => retry.run!()] : undefined, tip: notes.map((nt) => nt.text).join('\n') };
    if (n) return { tone: 'count', text: plural(n, 'change') };
    const t = app.prefs.target;
    return { tone: '', text: hintText(t === ctx.base ? null : name(t)) };
  }

  // ---- rendering ----
  function render(): void {
    if (destroyed) return;
    const loading = safe(() => mode.loading(), false);
    const notes = safe(() => mode.notes(), [] as PageNote[]);
    const pending = count();
    const s = status(loading, notes, pending);
    statusTip = s.tip || '';
    const sk = [s.tone, s.text, s.act?.[0] || ''].join('\u0001');
    if (sk !== stKey) {
      // Only on a change: the status is a live region.
      stKey = sk;
      stw.dataset.tone = s.tone;
      const had = stw.contains(active(stw));
      put(stIc, s.tone === 'busy' ? spinner() : s.tone === 'error' ? icon('error') : null);
      // The number of changes opens the Publish dialog too.
      put(stTx, s.tone === 'count' ? h('button', { class: 'link tb-cnt', type: 'button', on: { click: () => publish() } }, s.text) : s.text);
      put(stA, s.act && link(s.act[0], s.act[1]));
      if (had && !stw.contains(active(stw))) focusBar(); // e.g. Try again was used and is gone
    }
    pubB.setAttribute('aria-disabled', String(!pending));
    rove();
    layout();
  }
  const refresh = rafThrottle(render);

  // ---- toolbar keyboard: one tab stop, arrow keys move between the items ----
  let cur: HTMLButtonElement | null = null;
  const items = () => [...bar.querySelectorAll('button')].filter((b) => !b.disabled && b.getClientRects().length > 0);
  function rove(): void {
    const its = items();
    if (!cur || !its.includes(cur)) cur = its[0] ?? null;
    for (const b of bar.querySelectorAll('button')) b.tabIndex = b === cur ? 0 : -1;
  }
  function focusBar(): void {
    rove();
    cur?.focus();
  }
  bar.addEventListener('focusin', (e) => {
    const b = (e.target as Element | null)?.closest?.('button');
    if (b && bar.contains(b) && b !== cur) {
      cur = b;
      rove();
    }
  });
  bar.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    const its = items();
    const i = its.indexOf(active(bar) as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? its.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + its.length) % its.length;
    its[j].focus();
  });

  // ---- position ----
  const span = () => barSpan(L.clientWidth, sheetLeft, navWith(boxOf(NAV), boxOf(AREAS)));

  /** The navigation being watched: it narrows and widens (its ☰ button) without a window resize. */
  let navEl: Element | null = null;
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => refresh()) : null;
  function watchNav(): void {
    const n = document.querySelector(NAV);
    if (!ro || n === navEl) return;
    if (navEl) ro.unobserve(navEl);
    navEl = n;
    if (n) ro.observe(n);
  }

  function layout(): void {
    if (destroyed || el.hidden || !el.isConnected) return;
    const W = L.clientWidth;
    const H = L.clientHeight;
    if (!W || !H) return;
    watchNav();
    const [lo, hi] = span();
    const w = Math.max(Math.min(MAX_W, hi - lo - 32), Math.min(280, W - 2 * M));
    bar.style.width = w + 'px';
    const bh = bar.offsetHeight || 48;
    const p: Prefs['bar'] = live ?? app.prefs.bar;
    const left = Math.round(lo + M + frac(p?.x, 0.5) * Math.max(0, hi - lo - w - 2 * M));
    const want = typeof p?.y === 'number' ? M + frac(p.y, 1) * Math.max(0, H - bh - 2 * M) : p?.top ? M : H - bh - GAP;
    const top = clamp(want, M, H - bh - M);
    bar.style.left = left + 'px';
    // Never over the area switcher once placed; while dragging it follows the pointer.
    bar.style.top = Math.round(live ? top : clearOf(top, bh, left, w, boxOf(SWITCHER))) + 'px';
  }

  let drag: { id: number; dx: number; dy: number; sx: number; sy: number; moved: boolean } | null = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return;
    e.preventDefault();
    const r = bar.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      /* moves still arrive while the pointer is over the grip */
    }
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 4) return;
    drag.moved = true;
    el.dataset.drag = '';
    const [lo, hi] = span();
    const fw = hi - lo - bar.offsetWidth - 2 * M;
    const fh = L.clientHeight - bar.offsetHeight - 2 * M;
    live = { x: fw > 0 ? clamp((e.clientX - drag.dx - lo - M) / fw, 0, 1) : 0.5, y: fh > 0 ? clamp((e.clientY - drag.dy - M) / fh, 0, 1) : 1 };
    layout();
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    const p = live;
    drag = null;
    live = null;
    delete el.dataset.drag;
    if (moved && p) app.savePrefs({ bar: { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 } });
  };
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) grip.addEventListener(t, endDrag);
  grip.addEventListener('dblclick', () => app.savePrefs({ bar: undefined }));

  /** Notices the "All labels" sheet, which the app layer holds next to the bar: the bar keeps clear of it. */
  function scanLayer(): void {
    const W = L.clientWidth;
    const H = L.clientHeight;
    let sl: number | null = null;
    for (const c of L.children) {
      if (c === el || !(c instanceof HTMLElement)) continue;
      // The sheet dragged off the edge (floating) or docked again changes its class, not the layer's children.
      mo.observe(c, { attributes: true, attributeFilter: ['class', 'hidden'] });
      if (c.hidden) continue;
      const w = c.offsetWidth;
      if (w > 0 && w < W * 0.6 && c.offsetTop <= 1 && c.offsetHeight >= H - 2 && c.offsetLeft + w >= W - 2) sl = Math.min(sl ?? W, c.offsetLeft);
    }
    sheetLeft = sl;
    refresh();
  }
  // Hidden (the Workbench window open, which re-classes its window as it moves): showing it again scans the layer.
  const mo = new MutationObserver(() => el.hidden || scanLayer());
  mo.observe(L, { childList: true });
  const onResize = rafThrottle(() => {
    scanLayer();
    layout();
  });

  // ---- menu ----
  function moreMenu(): void {
    menu(moreB, [{ label: 'Recent publishes', icon: 'history', run: () => o.history() }, ...dynamicsItems(app), '-', { head: `Dynamics Translator ${__VERSION__}` }], { end: true });
  }

  // ---- events ----
  const onPrefs = () => {
    syncLang();
    refresh();
  };
  host.addEventListener('dxt-prefs', onPrefs);
  addEventListener('resize', onResize);
  const offStore = store.on(() => refresh());
  const offMode = safe(() => mode.on(() => refresh()), () => {});

  syncLang();
  refresh();

  return {
    el,
    hide(on) {
      if (destroyed) return;
      el.hidden = on;
      if (!on) {
        scanLayer();
        render();
      }
    },
    pulse() {
      if (destroyed || el.hidden) return;
      render();
      bar.classList.remove('is-pulse');
      void bar.offsetWidth; // restart the animation
      bar.classList.add('is-pulse');
      clearTimeout(pulseT);
      pulseT = setTimeout(() => bar.classList.remove('is-pulse'), 1400);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(pulseT);
      offStore();
      offMode();
      mo.disconnect();
      ro?.disconnect();
      host.removeEventListener('dxt-prefs', onPrefs);
      removeEventListener('resize', onResize);
      el.remove();
    },
  };
};
