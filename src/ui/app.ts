// The app controller: creates the shadow-root host, implements AppApi for the views (preferences, loading,
// editing, publishing, dialogs), and runs the two ways of working:
// * translation mode on record, list and dashboard pages: no window, only a slim bar; the user clicks a label
//   on the page and translates it in a popup next to it (inspector/mode.ts, ui/bar.ts). Edits are staged in the
//   store until "Review and publish" (ui/review.ts), which saves, publishes and refreshes the page (ui/refresh.ts);
// * the Workbench, a spreadsheet window (window chrome: title bar, optional footer, minimized pill).

import { pageInfo, type Ctx } from '../core/context';
import { guid, isAbort } from '../core/http';
import type { LangSession } from '../core/langsession';
import { lcidShort } from '../core/lcid';
import type { Lcid, Slot } from '../core/model';
import type { Store } from '../core/store';
import type { BarApi, PageListApi, PageMode } from '../inspector/types';
import { openPageList } from '../inspector/pagelist';
import { formOf } from '../inspector/pageload';
import { checkShown, domShown, pageShows, type ShownForm } from '../inspector/scan';
import { mergeStored } from '../providers/bpf';
import type { Scope } from '../providers/types';
import { NotConfirmed, setUiLanguage } from '../core/uilang';
import { createBar, dynamicsItems } from './bar';
import { h, icon, plural, put, rafThrottle } from './dom';
import { compSlots, createEditor, langName, notLoaded, type Editor } from './editor';
import { notShowing, readVerify, refreshPage, switchLanguage, verifyKey, type RefreshOptions, type VerifyItem } from './refresh';
import { openHistory, openReview } from './review';
import { createShell, type ShellState } from './shell';
import css from './styles.css';
import type { AppApi, AppDeps, HistoryEntry, LoadUiOptions, Prefs, SaveReport, SaverApi, View } from './types';
import { bindUndo } from './undo';
import { btn, closeTop, confirm, emptyState, errMsg, frag, ibtn, link, menu, modal, modalOpen, setLayer, spinner, teardownLayer, toast, tooltip } from './widgets';

type ViewId = 'page' | 'workbench';
export interface AppHandle {
  api: AppApi;
  /**
   * Tears the app down and removes everything it added to the page (also the views' overlays, listeners
   * and timers); returns false (and does nothing) while a save is running. Calling it again is a no-op.
   */
  destroy(): boolean;
  /** Shows the translator again (the bar, or the restored window). Returns false once the app was torn down. */
  show(): boolean;
  /** Wire to LangSession's onChange: shows the "language temporarily switched" notice (null hides it). */
  onLang(lcid: Lcid | null): void;
}
export interface AppHooks {
  /** Called once the app has been torn down (closed or destroyed), so a new instance can start. */
  onClosed?(): void;
}

const KEYS: Array<[string[], string]> = [
  [['Ctrl+S'], 'Review and publish'],
  [['Ctrl+Z', 'Ctrl+Y'], 'Undo and redo (outside text boxes, which have their own undo)'],
  [['Ctrl+F'], 'Filter rows'],
  [['Alt+1'], 'Back to the page (translation mode)'],
  [['Esc'], 'Close the open menu or dialog, then minimize'],
];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Translation mode needs a page with labels (pageInfo's type): a record, a list or a dashboard. Elsewhere only the Workbench. */
export const translatesOn = (pageType: string): boolean => pageType === 'entityrecord' || pageType === 'entitylist' || pageType === 'dashboard';

/**
 * The Workbench window's ✕ on a page of `pageType`. Where there is a page to go back to (translatesOn) it goes back to
 * it, as Alt+1 does: its name says so, with the shortcut as Undo's and Redo's do, "Back to page (Alt+1)" (the bar's ✕
 * closes the translator); a Workbench opened where there is no page to translate closes the translator.
 */
export function winClose(pageType: string, to: { page: () => void; close: () => void }): HTMLButtonElement {
  const back = translatesOn(pageType);
  const b = ibtn('close', back ? 'Back to page (Alt+1)' : 'Close', () => (back ? to.page() : to.close()), 'subtle', 20);
  if (back) b.setAttribute('aria-keyshortcuts', 'Alt+1');
  return b;
}

/** Stored prefs (`json`), with only the keys Prefs has (older builds also stored autoPublish, allowLangSwitch, underlineAll…). */
export function readPrefs(ctx: Pick<Ctx, 'base' | 'user' | 'langs'>, json: string | null): Prefs {
  const all = ctx.langs.map((l) => l.lcid);
  const target = ctx.user !== ctx.base && all.includes(ctx.user) ? ctx.user : all.find((l) => l !== ctx.base) ?? ctx.base;
  let s: Partial<Prefs> = {};
  try {
    s = JSON.parse(json || '{}') || {};
  } catch {
    s = {};
  }
  const p: Prefs = {
    target: all.includes(Number(s.target)) ? Number(s.target) : target,
    shown: all,
    showNames: !!s.showNames,
    dock: s.dock === 'float' || s.dock === 'max' ? s.dock : 'right',
  };
  p.shown = Array.isArray(s.shown) ? all.filter((l) => l === ctx.base || l === p.target || s.shown!.includes(l)) : all;
  if (s.bar && typeof s.bar === 'object') p.bar = s.bar;
  // The list sheet's place (pagelist.ts checks its values): without it the sheet reopens docked after a reload.
  if (s.list && typeof s.list === 'object') p.list = s.list;
  return p;
}

/** The prefs stored under `key` (one org's). */
function loadPrefs(ctx: Ctx, key: string): Prefs {
  let json: string | null = null;
  try {
    json = localStorage.getItem(key);
  } catch {
    /* storage blocked: the defaults */
  }
  return readPrefs(ctx, json);
}

export async function createApp(ctx: Ctx, store: Store, lang: LangSession, deps: AppDeps, hooks: AppHooks = {}): Promise<AppHandle> {
  // Shadow-root host on <html>: page styles can't reach in, and Dynamics re-rendering <body> can't remove it.
  const host = document.createElement('dxt-translator');
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '2147483646', pointerEvents: 'none' });
  const root = host.attachShadow({ mode: 'open' });
  // Keep typing inside the app away from Dynamics' global shortcuts (Ctrl+S saves the record, etc.), and clicks and
  // focus away from its light-dismiss: a click in a popup opened from a business process stage's flyout closed the
  // flyout, and the popup jumped as its label went away. Our own outside-click checks listen in the capture phase.
  for (const t of ['keydown', 'keyup', 'keypress', 'copy', 'cut', 'paste', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend', 'focusin', 'focusout'])
    host.addEventListener(t, (e) => e.stopPropagation());

  const adopted = new Set<string>();
  const adoptStyles = (text: string): void => {
    if (adopted.has(text)) return;
    adopted.add(text);
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    } catch {
      root.prepend(h('style', null, text));
    }
  };
  adoptStyles(css);
  compSlots(store, ''); // index the store before views subscribe, so its listener runs first

  const PK = `dxt:prefs:${ctx.orgId}`;
  const prefs = loadPrefs(ctx, PK);
  const all = ctx.langs.map((l) => l.lcid);
  const pageType = pageInfo(ctx.xrm).type;
  const onPage = translatesOn(pageType);
  /** What this instance publishes is checked on the page after a refresh (history entries from now on). */
  const started = Date.now();

  let cur: ViewId | null = null;
  let workbench: View | null = null;
  let mode: PageMode | null = null;
  let bar: BarApi | null = null;
  let list: { api: PageListApi; off: () => void } | null = null;
  let barWatch: MutationObserver | null = null;
  let destroyed = false;
  let statusText = '';
  let statusT: ReturnType<typeof setTimeout> | undefined;
  let busyLabel = '';
  let op: { label: string; done?: number; total?: number; stop?: () => void } | null = null;
  let langNow: Lcid | null = null;
  const loads = new Set<AbortController>();

  const shell = createShell(root, { key: `dxt:win:${ctx.orgId}`, onChange: (s) => onShell(s) });
  const L = shell.layer;
  const tbox = setLayer(L);
  // Ctrl+Z / Ctrl+Y: each text box's own history, else the staged edits (also on the page in translation mode).
  const offUndo = bindUndo(L, { store, dialog: modalOpen, page: () => cur === 'page' && !destroyed });

  // ---- Workbench window: title bar ----
  // Always one row. As the window narrows (container queries in styles.css) the language names become
  // codes, the org badge shrinks to a coloured dot (its text stays in the tooltip and for screen
  // readers), and the title and then the logo are hidden. The window buttons always stay on the row.
  const env = ctx.envType;
  const envTone = env === 'Production' ? ' prod' : /^(Developer|Sandbox|Trial|Preview)$/.test(env) ? ' dev' : '';
  const orgB = h('span', { class: 'badge orgb' + envTone, title: env ? `${env} environment: ${ctx.org}` : `Environment: ${ctx.org}` },
    h('i', { class: 'dot', 'aria-hidden': 'true' }),
    h('span', { class: 'bt' }, env ? `${env} · ${ctx.org}` : ctx.org),
  );
  const langB = h('button', { class: 'btn subtle langbtn', type: 'button', 'aria-haspopup': 'menu', on: { click: () => langMenu(langB) } });
  // Only with a choice to make (3 or more languages): with two, every sheet already shows both.
  langB.hidden = ctx.langs.length < 3;
  let langTip = '';
  tooltip(langB, () => langTip);
  const moreB = ibtn('more', 'More', () => moreMenu(), 'subtle', 20);
  const dockB = ibtn('dock', 'Dock to the right', () => shell.setMode(shell.state.mode === 'right' ? 'float' : 'right'), 'subtle', 20);
  const maxB = ibtn('maximize', 'Maximize', () => shell.toggleMax(), 'subtle', 20);
  const top = h('header', { class: 'top' },
    h('div', { class: 'logo' }, icon('globe', 20)),
    h('h1', null, 'Translator'),
    orgB,
    h('div', { class: 'spacer' }),
    h('div', { class: 'tnav' }, langB),
    h('div', { class: 'tbtns' }, moreB, dockB, maxB, ibtn('minimize', 'Minimize', () => shell.minimize(true), 'subtle', 20), winClose(pageType, { page: () => show('page'), close: () => void requestClose() })),
  );
  shell.dragBy(top);

  // ---- Workbench window: stage, language banner, footer ----
  const stage = h('div', { class: 'stage' });
  const lban = h('div', { class: 'lban', role: 'status', hidden: true });
  const mspin = spinner();
  const mtext = h('span');
  const mstop = link('Stop', () => op?.stop?.());
  const msg = h('div', { class: 'msg', 'aria-live': 'polite' }, mspin, mtext, mstop);
  const fprog = h('div', { class: 'fprog', hidden: true }, h('i'));
  const pend = h('button', { class: 'pend', type: 'button', hidden: true, on: { click: () => void review() } });
  const undoB = ibtn('undo', 'Undo (Ctrl+Z)', () => store.undo(), 'subtle', 20);
  const redoB = ibtn('redo', 'Redo (Ctrl+Y)', () => store.redo(), 'subtle', 20);
  const saveB = btn(frag(icon('publish'), h('span', { class: 'lg' }, 'Review and publish'), h('span', { class: 'sh' }, 'Publish')), () => void review(), 'primary');
  saveB.setAttribute('aria-keyshortcuts', 'Control+S');
  const footer = h('footer', { class: 'bar' }, fprog, msg, pend, undoB, redoB, saveB);
  shell.panel.append(top, stage, lban, footer);
  // A language switch whose answer was lost may still run on the server: form labels wait for it (LangSession
  // doubtful). A save says it in its own progress.
  const WAIT_TEXT = 'Waiting to be sure an earlier request finished before reading or saving more form labels…';
  const offWait = lang.onWait?.((w) => {
    if (langNow !== null) return; // the switch notice is up
    lban.hidden = !w;
    if (w) put(lban, icon('globe'), h('span', null, WAIT_TEXT));
    if (w && !store.busy) toast(WAIT_TEXT, 'info');
  });
  const miniSpin = spinner();
  const miniText = h('small');
  mspin.hidden = mstop.hidden = miniSpin.hidden = true;
  shell.mini.append(h('span', { class: 'logo' }, icon('globe')), 'Translator', miniSpin, miniText);
  /** The window is only for the Workbench: hidden (with its minimized pill) in translation mode. */
  const windowShown = (on: boolean) => shell.hide(!on);

  const sync = rafThrottle(() => {
    const n = store.pendingCount();
    pend.hidden = !n;
    pend.textContent = plural(n, 'change');
    undoB.disabled = store.busy || !store.canUndo();
    redoB.disabled = store.busy || !store.canRedo();
    saveB.disabled = store.busy || !n;
    const b = busyLabel || 'Saving';
    const work = store.busy ? (b.endsWith('…') ? b : b + '…') : op ? op.label + (op.total ? ` · ${op.done ?? 0} of ${op.total}` : '') : '';
    mspin.hidden = !work;
    mtext.textContent = work || statusText;
    mstop.hidden = !op?.stop || store.busy;
    const frac = !store.busy && op?.total ? Math.min(1, (op.done ?? 0) / op.total) : null;
    fprog.hidden = !work;
    fprog.classList.toggle('ind', frac === null);
    (fprog.firstChild as HTMLElement).style.width = frac === null ? '' : frac * 100 + '%';
    miniSpin.hidden = !work;
    miniText.textContent = work || (n ? plural(n, 'change') : '');
    miniText.className = work || !n ? '' : 'p';
    shell.mini.setAttribute('aria-label', `Open the translator${n ? ` (${plural(n, 'pending change')})` : ''}`);
  });
  const syncLang = () => {
    const label = (nm: (l: Lcid) => string) => (prefs.target === ctx.base ? nm(ctx.base) : `${nm(ctx.base)} → ${nm(prefs.target)}`);
    const baseName = langName(api, ctx.base);
    langTip = prefs.target === ctx.base ? `Languages: ${baseName}` : `Translating from ${baseName} into ${langName(api, prefs.target)}`;
    // Three widths of the same label; only the full names (.ln) are read by screen readers.
    put(langB,
      icon('globe'),
      h('span', { class: 'ln' }, label((l) => langName(api, l))),
      h('span', { class: 'ls', 'aria-hidden': 'true' }, label(lcidShort)),
      h('span', { class: 'lt', 'aria-hidden': 'true' }, lcidShort(prefs.target)),
      icon('chevron'),
    );
  };

  /** The browser's own "Leave site?" prompt, only while changes are staged or a save runs. */
  const beforeUnload = (e: BeforeUnloadEvent) => {
    if (destroyed || (!store.busy && !store.pendingCount())) return;
    e.preventDefault();
    e.returnValue = '';
  };
  let guarded = false;
  const guard = () => {
    const on = !destroyed && (store.busy || store.pendingCount() > 0);
    if (on === guarded) return;
    guarded = on;
    if (on) window.addEventListener('beforeunload', beforeUnload);
    else window.removeEventListener('beforeunload', beforeUnload);
  };
  const offStore = store.on((e) => {
    if (e.type === 'busy') busyLabel = e.label || '';
    if (e.type !== 'slots' && e.type !== 'status') guard();
    sync();
  });

  /**
   * Toasts sit above the bar in translation mode (at the bottom right when the bar was moved to the top), at the
   * window's bottom-right in the Workbench.
   */
  const placeToasts = () => {
    const s = shell.state;
    if (cur !== 'workbench') {
      let top = Infinity;
      let bottom = -Infinity;
      for (const c of bar && !bar.el.hidden ? bar.el.children : [])
        if (c instanceof HTMLElement && !c.hidden) {
          const r = c.getBoundingClientRect();
          if (!r.height) continue;
          top = Math.min(top, r.top);
          bottom = Math.max(bottom, r.bottom);
        }
      const H = L.clientHeight;
      // Not measured (no bar yet, or not laid out): above the bar's default place at the bottom.
      const at = top === Infinity || !H ? 84 : top + bottom > H ? Math.max(84, Math.round(H - top + 12)) : 24;
      return void Object.assign(tbox.style, { right: '24px', bottom: at + 'px' });
    }
    const foot = workbench?.footer === false ? 16 : 76;
    Object.assign(tbox.style, s.min ? { right: '24px', bottom: '80px' } : { right: Math.max(8, L.clientWidth - s.x - s.w + 16) + 'px', bottom: Math.max(8, L.clientHeight - s.y - s.h + foot) + 'px' });
  };

  let lastMode = '';
  function onShell(s: ShellState): void {
    // Called on every pointermove while dragging: only touch the buttons when the mode changes.
    if (s.mode !== lastMode) {
      lastMode = s.mode;
      dockB.setAttribute('aria-pressed', String(s.mode === 'right'));
      put(maxB, icon(s.mode === 'max' ? 'restore' : 'maximize', 20));
      maxB.setAttribute('aria-label', s.mode === 'max' ? 'Restore down' : 'Maximize');
    }
    placeToasts();
    sync();
  }

  // ---- AppApi ----
  function savePrefs(p: Partial<Prefs>): void {
    Object.assign(prefs, p);
    if (p.shown || p.target) prefs.shown = all.filter((l) => l === ctx.base || l === prefs.target || prefs.shown.includes(l));
    try {
      localStorage.setItem(PK, JSON.stringify(prefs));
    } catch {
      /* kept for this session only */
    }
    host.dispatchEvent(new CustomEvent('dxt-prefs', { detail: { ...p } }));
    syncLang();
    sync();
  }

  function status(text: string): void {
    clearTimeout(statusT);
    statusText = text;
    sync();
  }

  async function load(scope: Scope, o: LoadUiOptions = {}): Promise<number> {
    if (destroyed) return 0;
    const ac = new AbortController();
    const outer = o.signal;
    const relay = () => ac.abort();
    if (outer?.aborted) ac.abort();
    else outer?.addEventListener('abort', relay, { once: true });
    loads.add(ac);
    const me: NonNullable<typeof op> = { label: 'Loading…', stop: () => ac.abort() };
    let warn = '';
    op = me;
    sync();
    try {
      // Its texts count as read when it starts: a save or page load that lands while it reads is newer, and keeps its text.
      const since = store.tick();
      const slots = await deps.providers.loadScope(ctx, scope, {
        signal: ac.signal,
        // Form tab and section labels in other languages switch the UI language for a moment (no prompt).
        lang: ctx.langs.length > 1 ? lang : undefined,
        progress: (m, done, total) => {
          // loadScope keeps partial results when one loader fails and reports it only as progress.
          if (/^Loaded with problems/.test(m)) warn = m;
          me.label = m;
          me.done = done;
          me.total = total;
          sync();
          try {
            o.onProgress?.(m, done, total);
          } catch (e) {
            if (__DEV__) console.error('[translator]', e);
          }
        },
      });
      // A process's stage and step names Dynamics keeps (read on a record page) stay: the Workbench reads its definition only.
      store.add(mergeStored(ctx, slots, (k) => store.get(k)), since);
      status(slots.length ? `Loaded ${plural(slots.length, 'label')}` : 'Nothing to translate in that selection.');
      statusT = setTimeout(() => status(''), 8000);
      // A caller that shows the progress itself (the Workbench's message bar) shows this warning there too.
      if (warn && !o.onProgress) toast(warn, 'warn');
      return slots.length;
    } catch (e) {
      const m = isAbort(e) ? 'Loading stopped.' : `Couldn't load everything: ${errMsg(e)}`;
      if (o.onError) o.onError(m);
      else toast(m, isAbort(e) ? 'info' : 'error');
      return 0;
    } finally {
      outer?.removeEventListener('abort', relay);
      loads.delete(ac);
      if (op === me) op = null;
      sync();
    }
  }

  /** The full editor card (every property in every shown language), in a dialog. */
  function fullEditor(comp: string, l?: Lcid): void {
    let ed: Editor | null = null;
    void modal<void>('Edit translations', (close) => {
      ed = createEditor(api, comp, { focusLcid: l, onClose: () => close() });
      requestAnimationFrame(() => ed?.focus(l));
      return h('div', { class: 'dlg-ed' }, ed.el);
    }, { wide: true }).then(() => ed?.destroy());
  }

  function edit(comp: string, l?: Lcid): void {
    // A dialog (e.g. a running publish) is in front: an edit started now would be lost by the save.
    if (modalOpen()) return;
    try {
      if (cur === 'page' && mode?.open(comp, { lcid: l })) return;
      if (cur === 'workbench' && workbench?.edit?.(comp, l)) return;
    } catch (e) {
      if (__DEV__) console.error('[translator]', e);
    }
    fullEditor(comp, l);
  }

  /** The Publish dialog: review, save, publish, check, and in translation mode refresh the page (review.ts). */
  async function review(filter?: (s: Slot) => boolean): Promise<SaveReport | undefined> {
    // Asked twice (the bar's button, then Ctrl+S), or closed meanwhile: one dialog at most.
    if (modalOpen() || destroyed) return undefined;
    return openReview(api, filter).catch((e) => {
      toast(errMsg(e), 'error');
      return undefined;
    });
  }

  // ---- refresh ----
  /** What was published since this instance started (the newest text per label), from the publish journal. */
  function publishedSince(since: number): VerifyItem[] {
    let list: HistoryEntry[] = [];
    try {
      list = api.saver.history(); // newest first
    } catch {
      list = [];
    }
    const out = new Map<string, VerifyItem>();
    for (const e of list)
      if (e.at >= since && e.published)
        for (const it of e.items) {
          const id = `${it.key}#${it.lcid}`;
          if (!out.has(id)) out.set(id, { comp: it.comp, kind: it.kind, key: it.key, lcid: it.lcid, text: it.after });
        }
    return [...out.values()];
  }
  let refreshing: Promise<boolean> | null = null;
  /** What a refresh needs; `items` = what the next start checks (default: this session's publishes). */
  const refreshOpts = (items?: VerifyItem[]): RefreshOptions => ({
    xrm: ctx.xrm,
    orgId: ctx.orgId,
    items: items ?? publishedSince(started),
    pending: store.pendingCount(),
    confirm,
    toast,
    // destroy() removes the beforeunload guard too, so the reload doesn't ask "Leave site?".
    teardown: () => destroy(),
    restore: () => lang.restore(),
  });
  /** Clears the Dynamics caches and reloads (ui/refresh.ts). One at a time. */
  function refresh(items?: VerifyItem[]): Promise<boolean> {
    if (destroyed) return Promise.resolve(false);
    return (refreshing ??= refreshPage(refreshOpts(items)).finally(() => (refreshing = null)));
  }
  /**
   * "Show Dynamics in <language>": sets the user's Dynamics language for good (core/uilang.ts), so the translator
   * never switches it back (LangSession.adoptLanguage), then refreshes the page in it. Never while a save runs or
   * the language is switched for a moment (form labels).
   */
  function showIn(l: Lcid): Promise<boolean> {
    if (destroyed) return Promise.resolve(false);
    const web = { get: (p: string, headers: Record<string, string>) => ctx.http.get(p, { headers }), patch: (p: string, b: unknown) => ctx.http.patch(p, b) };
    return (refreshing ??= switchLanguage({
      ...refreshOpts(),
      name: langName(api, l),
      busy: () =>
        store.busy
          ? 'Publishing is in progress. Switch the language once it has finished.'
          : lang.waiting
            ? 'The translator is waiting to be sure an earlier request finished. Try again in a minute or two.'
            : lang.active
              ? 'Your Dynamics language is switched for a moment while form labels are read or saved. Try again in a few seconds.'
              : '',
      // Sent but not read back: the refresh shows whatever language Dataverse has.
      adopt: () =>
        lang.adoptLanguage(l, () =>
          setUiLanguage(web, ctx.userId, l).catch((e) => {
            if (!(e instanceof NotConfirmed)) throw e;
          }),
        ),
    }).finally(() => (refreshing = null)));
  }

  /**
   * After a refresh: once translation mode has loaded the page, says when it doesn't show what was published yet
   * (with Refresh again); a page that shows it says nothing. What the page renders decides for the texts on it
   * (field labels, their tooltips, tab and section titles of this form, in the user's language, read from the DOM:
   * the form API's labels are empty after a cold boot); the freshly loaded server text for the rest.
   */
  async function verifyAfterLoad(m: PageMode): Promise<void> {
    const key = verifyKey(ctx.orgId);
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      return;
    }
    if (!raw) return;
    const entry = readVerify(raw, Date.now());
    const drop = () => {
      try {
        localStorage.removeItem(key);
      } catch {
        /* checked again next time, until it is an hour old */
      }
    };
    if (!entry?.items.length) return drop();
    const t0 = Date.now();
    await sleep(1500); // the page loads start once the page is known (a cold form API is rebuilt first)
    while (!destroyed && mode === m && m.loading() && Date.now() - t0 < 60_000) await sleep(500);
    if (destroyed || mode !== m) return;
    drop();
    const formId = formOf(ctx.xrm, pageInfo(ctx.xrm));
    const page: ShownForm = {
      user: ctx.user,
      formId,
      get: (k) => store.get(k),
      cells: formId ? [...store.slots.values()].filter((s) => s.kind === 'field' && guid(String(s.ref?.formId || '')) === formId) : [],
    };
    const shown = domShown(document);
    const r = checkShown(
      entry.items,
      (k, l) => {
        const s = store.get(k);
        // Not loaded on this page, or that language was not read (form tab/section labels): not checked.
        if (!s || notLoaded(s, l)) return undefined;
        return store.original(k, l);
      },
      (it) => pageShows(it, page, shown),
    );
    const t = notShowing(r.missing.length);
    if (t) toast(t, 'warn', { label: 'Refresh again', run: () => void refresh(r.missing) });
  }

  function closeList(): void {
    if (!list) return;
    // A row's find still waiting for its label (another tab opening) would open the popup after the list is gone.
    mode?.cancelFind();
    const l = list;
    list = null;
    l.off();
    try {
      l.api.close();
    } catch (e) {
      if (__DEV__) console.error('[translator]', e);
    }
    l.api.el.remove();
  }
  function toggleList(): void {
    if (list) return closeList();
    if (!mode) return;
    const l = openPageList(api, mode, { close: closeList });
    L.append(l.el);
    list = { api: l, off: () => {} };
  }

  /** Starts translation mode the first time the page view is shown. */
  function startPage(): void {
    if (mode) return;
    const m = (mode = deps.views.page(api));
    bar = createBar(api, m, {
      exit: () => void requestClose(),
      list: toggleList,
      workbench: () => show('workbench'),
      publish: () => void review(),
      history: () => recentPublishes(),
    });
    L.append(bar.el);
    // The bar moves (dragged, snapped to the top, resized): toasts follow.
    barWatch = new MutationObserver(rafThrottle(placeToasts));
    barWatch.observe(bar.el, { attributes: true, subtree: true, attributeFilter: ['style', 'hidden'] });
    m.start();
    void verifyAfterLoad(m).catch((e) => {
      if (__DEV__) console.error('[translator] verify', e);
    });
  }

  function show(v: ViewId): void {
    if (v === cur || destroyed) return;
    if (v === 'page' && !onPage) return toast('Open a record, a list or a dashboard to translate on the page.', 'info');
    if (v === 'workbench') {
      closeList();
      mode?.pause(true);
      bar?.hide(true);
      if (!workbench) {
        try {
          workbench = deps.views.workbench(api);
        } catch (e) {
          const el = emptyState('error', "The Workbench couldn't start", errMsg(e), [], 'bad');
          workbench = { el, activate() {}, deactivate() {}, destroy() {} };
        }
        stage.append(workbench.el);
      }
      cur = v;
      footer.hidden = workbench.footer === false;
      windowShown(true);
      // The Workbench is a wide grid: it floats large (centred, min(1280px, 92vw) × min(860px, 92vh)) unless
      // the user docked or maximized it; the shell keeps that size fitted to the viewport as it changes.
      shell.use('workbench', { mode: 'float', w: 1280, h: 860, fill: 0.92 });
      shell.minimize(false);
      workbench.el.hidden = false;
      try {
        workbench.activate();
      } catch (e) {
        toast(`The Workbench had a problem: ${errMsg(e)}`, 'error');
      }
      shell.panel.focus();
    } else {
      if (workbench && cur === 'workbench') {
        try {
          workbench.deactivate();
        } catch (e) {
          if (__DEV__) console.error('[translator]', e);
        }
        workbench.el.hidden = true;
      }
      windowShown(false);
      cur = v;
      try {
        if (mode) {
          mode.pause(false);
          bar?.hide(false);
        } else startPage();
      } catch (e) {
        toast(`Translation mode couldn't start: ${errMsg(e)}`, 'error');
      }
    }
    placeToasts();
    sync();
  }

  const api: AppApi = {
    ctx,
    store,
    lang,
    prefs,
    savePrefs,
    root,
    layer: L,
    toast,
    confirm,
    modal,
    load,
    edit,
    review,
    refreshPage: () => refresh(),
    showDynamicsIn: showIn,
    show,
    view: () => cur,
    langMenu,
    status,
    adoptStyles,
    // Form tab and section labels in other languages are read and written with a brief, automatic language switch.
    askLangSwitch: () => Promise.resolve(true),
    providers: deps.providers,
    saver: null as unknown as SaverApi,
    io: deps.io,
  };
  api.saver = deps.saver(api);
  // Dev builds only: the live suites (tools/e2e-suite.js, tools/e2e-page.js) drive translation mode through these.
  // noRefresh: a fully successful publish shows the Workbench's "Done" instead of reloading the page.
  if (__DEV__) (api as unknown as { dev: unknown }).dev = { mode: () => mode, bar: () => bar, list: () => list?.api ?? null, noRefresh: false };

  // ---- menus ----
  function langMenu(anchor: HTMLElement): void {
    const others = ctx.langs.filter((l) => !l.isBase);
    const baseName = langName(api, ctx.base);
    if (!others.length) {
      menu(anchor, [{ head: 'Languages' }, { label: `Only ${baseName} is installed`, hint: 'Add languages in the Power Platform admin center.', disabled: true }], { end: true });
      return;
    }
    menu(anchor, [
      { head: 'Translate into' },
      ...others.map((l) => ({ label: l.name, checked: prefs.target === l.lcid, radio: true, run: () => savePrefs({ target: l.lcid }) })),
      '-',
      { head: 'Show languages' },
      { label: baseName, hint: 'Base language, always shown', checked: true, disabled: true },
      ...others.map((l) => ({
        label: l.name,
        hint: l.lcid === prefs.target ? 'Target language, always shown' : undefined,
        checked: prefs.shown.includes(l.lcid),
        disabled: l.lcid === prefs.target,
        keep: true,
        run: () => savePrefs({ shown: prefs.shown.includes(l.lcid) ? prefs.shown.filter((x) => x !== l.lcid) : [...prefs.shown, l.lcid] }),
      })),
    ], { end: true });
  }

  function moreMenu(): void {
    menu(moreB, [
      { label: 'Recent publishes', icon: 'history', hint: 'See and undo past publishes', run: recentPublishes },
      { label: 'Keyboard shortcuts', icon: 'keyboard', run: shortcuts },
      ...dynamicsItems(api),
      '-',
      { head: 'Settings' },
      { label: 'Show logical names', checked: prefs.showNames, keep: true, run: () => savePrefs({ showNames: !prefs.showNames }) },
      '-',
      { head: `Dynamics Translator ${__VERSION__}` },
    ], { end: true });
  }

  function shortcuts(): void {
    void modal('Keyboard shortcuts', (close) =>
      frag(
        h('div', { class: 'dlg-body' }, h('div', { class: 'kt' }, KEYS.map(([ks, t]) => [h('span', null, ks.map((k, i) => [i ? ' ' : '', h('kbd', null, k)])), h('span', null, t)]))),
        h('div', { class: 'dlg-actions' }, btn('Close', () => close(), 'primary')),
      ),
    );
  }

  /** Recent publishes (history with Undo). */
  function recentPublishes(): void {
    if (!destroyed && !modalOpen()) openHistory(api);
  }

  // ---- closing ----
  let closing: Promise<void> | null = null;
  /** ✕ on the bar, and on the Workbench window when there is no page to go back to: one close flow at a time. */
  function requestClose(): Promise<void> {
    return (closing ??= closeFlow().finally(() => (closing = null)));
  }
  async function closeFlow(): Promise<void> {
    if (store.busy) return toast('Publishing is in progress. The translator can close when it finishes.', 'warn');
    const n = store.pendingCount();
    if (n) {
      const v = await modal<'publish' | 'discard'>('Close the translator?', (close) => {
        const pub = btn('Publish', () => close('publish'), 'primary');
        pub.dataset.af = '';
        return frag(
          h('div', { class: 'dlg-body' }, h('p', null, `You have ${plural(n, 'unpublished change')}.`)),
          h('div', { class: 'dlg-actions' }, pub, btn('Discard', () => close('discard')), btn('Keep editing', () => close())),
        );
      });
      if (!v || destroyed) return;
      if (v === 'publish') {
        await review();
        // Published in translation mode: the page is reloading. Something still staged (a problem, or Cancel): stay.
        if (destroyed || store.pendingCount()) return;
      } else store.group(() => [...store.edits.keys()].forEach((k) => store.revert(k)));
    }
    if (store.busy) return toast('Publishing is in progress. The translator can close when it finishes.', 'warn');
    // destroy() tells main.ts (hooks.onClosed), which forgets this instance so the next click on the bookmark
    // starts a fresh one.
    destroy();
  }

  function destroy(): boolean {
    if (destroyed) return true;
    if (store.busy) return false;
    destroyed = true;
    // Every step runs even if an earlier one throws: nothing may stay behind on the Dynamics page.
    const step = (what: string, fn: () => void) => {
      try {
        fn();
      } catch (e) {
        if (__DEV__) console.error(`[translator] teardown: ${what}`, e);
      }
    };
    clearTimeout(statusT);
    guarded = false;
    window.removeEventListener('beforeunload', beforeUnload);
    for (const a of loads) step('abort load', () => a.abort());
    step('page list', closeList);
    step('layers', teardownLayer);
    step('undo', offUndo);
    if (cur === 'workbench' && workbench) step('deactivate workbench', () => workbench!.deactivate());
    // Views remove their own page overlays, page listeners, observers, timers and text previews.
    if (workbench) step('destroy workbench', () => workbench!.destroy());
    if (mode) step('translation mode', () => mode!.destroy());
    step('bar watch', () => barWatch?.disconnect());
    if (bar) step('bar', () => bar!.destroy());
    step('store listener', offStore);
    step('close event', () => host.dispatchEvent(new CustomEvent('dxt-close')));
    step('window', () => shell.destroy());
    host.remove();
    step('wait notice', () => offWait?.());
    step('language', () => void lang.restore().catch(() => {}));
    step('onClosed', () => hooks.onClosed?.());
    return true;
  }

  function onLang(l: Lcid | null): void {
    langNow = l;
    lban.hidden = l === null;
    if (l !== null)
      put(lban, icon('globe'), h('span', null, `Your Dynamics language is temporarily ${langName(api, l)} while form labels are ${store.busy ? 'saved' : 'read'}. It switches back automatically.`));
    host.dispatchEvent(new CustomEvent('dxt-lang', { detail: { lcid: l } }));
  }

  // ---- keyboard (inside the app's layer) ----
  const isText = (t: EventTarget | undefined) =>
    t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && !/^(checkbox|radio|button|submit|range|color|file)$/.test(t.type)) || (t instanceof HTMLElement && t.isContentEditable);
  // Ctrl+Z / Ctrl+Y arrive handled: bindUndo (ui/undo.ts), registered on the layer before this, takes them all.
  L.addEventListener('keydown', (e) => {
    if (e.isComposing || e.defaultPrevented) return;
    const k = (e.key || '').toLowerCase(); // autofill fires keydown without a key
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
    const target = e.composedPath()[0];
    if (k === 'escape') {
      if (closeTop()) e.preventDefault();
      else if (cur === 'workbench' && !isText(target)) {
        e.preventDefault();
        shell.minimize(true);
      }
      return;
    }
    if (mod && k === 's') {
      e.preventDefault(); // never the browser's "Save page as", even while a dialog is open
      // The Workbench publishes with its own result line in its message bar (it opens the same Publish dialog).
      if (cur === 'workbench' && workbench && !modalOpen()) workbench.el.dispatchEvent(new CustomEvent('dxt-save'));
      else void review();
    } else if (modalOpen()) return;
    else if (cur === 'workbench' && mod && k === 'f') {
      e.preventDefault();
      workbench?.el.dispatchEvent(new CustomEvent('dxt-search'));
    } else if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'Digit1' || e.code === 'Digit2')) {
      e.preventDefault();
      show(e.code === 'Digit1' ? 'page' : 'workbench');
    }
  });

  // Hidden only now: hiding lays the window out and calls onShell, which uses state declared above (lastMode, sync).
  windowShown(false);
  document.documentElement.append(host);
  syncLang();
  show(onPage ? 'page' : 'workbench');
  sync();
  guard();

  return {
    api,
    destroy,
    show() {
      if (destroyed) return false;
      // Our host lives on <html>; put it back should the page ever have removed it.
      if (!host.isConnected) document.documentElement.append(host);
      if (cur === 'workbench') {
        shell.minimize(false);
        shell.panel.focus();
      } else bar?.pulse();
      if (langNow !== null) host.dispatchEvent(new CustomEvent('dxt-lang', { detail: { lcid: langNow } }));
      return true;
    },
    onLang,
  };
}
