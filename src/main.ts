// Bookmarklet entry point. Clicking the bookmark again shows the running instance; once that instance
// was closed (✕) or torn down, the next click always starts a fresh one.

import { createCtx, findXrm } from './core/context';
import { LangSession } from './core/langsession';
import { lcidName } from './core/lcid';
import { createSaver } from './core/saver';
import { Store } from './core/store';
import { createPageMode } from './inspector/mode';
import { createIo } from './io/workbook';
import { providers } from './providers/index';
import { createApp } from './ui/app';
import { createWorkbench } from './workbench/workbench';

interface Instance {
  key: string;
  starting: boolean;
  /** When this instance started (ms), to recognise a start that never finished. */
  since: number;
  /** True while the start repairs a UI language left switched by an interrupted save (LangSession.recover). */
  recovering?: boolean;
  /** Shows the running app; false when it was torn down (an older build returns nothing). */
  show?: () => boolean | void;
  destroy?: () => boolean;
}

declare global {
  interface Window {
    __dxTranslator?: Instance;
  }
}

/** A start still running after this long is treated as stuck, and the next click starts over. */
const STUCK_MS = 30000;

/** What a click does while an instance exists. Returns true when a fresh instance should start. */
function replaces(prev: Instance, key: string): boolean {
  if (prev.starting) {
    // Never while it may still switch the user's Dynamics language back: finishing late, that would
    // change the language under a newer instance's save that switched it on purpose (form labels).
    if (prev.recovering) {
      alert('The translator is still starting: it is switching your Dynamics language back after an interrupted save. Wait a moment. If nothing happens, reload the page and click the bookmark again.');
      return false;
    }
    if (Date.now() - (prev.since || 0) < STUCK_MS) {
      alert('The translator is still starting. Wait a moment.');
      return false;
    }
    // Stuck: take over. Should that start finish after all, it sees it is no longer current and stops.
    return true;
  }
  if (prev.key === key && prev.show) {
    try {
      if (prev.show() !== false) return false;
      // Already torn down: start a fresh one.
    } catch {
      // A broken instance: tear it down and start a fresh one.
    }
  }
  let gone = true;
  try {
    gone = prev.destroy ? prev.destroy() : true;
  } catch {
    // It failed while tearing down; nothing more can be done for it.
  }
  if (!gone) alert('The translator is still saving. Wait until it has finished, then click the bookmark again.');
  return gone;
}

void (async () => {
  const key = location.host;
  const prev = window.__dxTranslator;
  if (prev) {
    if (!replaces(prev, key)) return;
    if (window.__dxTranslator === prev) delete window.__dxTranslator;
  }
  const xrm = findXrm();
  if (!xrm && !/\.(dynamics\.com|dynamics\.us|microsoftdynamics\.us|dynamics\.cn|appsplatform\.us)$/i.test(location.hostname)) {
    return alert('Open a Dynamics 365 / Power Apps model-driven app (https://<org>.crm.dynamics.com/main.aspx…), then click the bookmark again.');
  }
  const self: Instance = { key, starting: true, since: Date.now() };
  window.__dxTranslator = self;
  const current = () => window.__dxTranslator === self;
  // Dev builds expose internals for the in-page end-to-end tests (tools/e2e.js); cleared on close.
  const devWin = __DEV__ ? (window as unknown as { __dxtDev?: unknown }) : null;
  let devInfo: unknown;
  try {
    const ctx = await createCtx();
    // A newer click took over while this start was stuck: leave the page, and the user's language, to
    // that instance (it runs its own recovery).
    if (!current()) return;
    self.recovering = true;
    // A switch left long ago is undone only if the user says so: they may have chosen that language since.
    const restored = await LangSession.recover(ctx, undefined, (m, now) =>
      confirm(
        `Your Dynamics language is ${lcidName(now)}. A translator save that was interrupted earlier had switched it from ${lcidName(m.lcid)}.\n\nSwitch it back to ${lcidName(m.lcid)}? Cancel keeps ${lcidName(now)}.`,
      ),
    ).catch(() => 0);
    self.recovering = false;
    if (!current()) return;
    const store = new Store();
    // The app shows a banner while the UI language is temporarily switched; it exists only after createApp.
    let onLang: (lcid: number | null) => void = () => {};
    const lang = new LangSession(ctx, (lcid) => onLang(lcid));
    const deps = {
      providers,
      saver: () => createSaver(ctx, store, lang, providers.writerFor),
      // With the context the exported workbook names this organization and its base language, and imports
      // skip languages this environment does not have.
      io: createIo(ctx),
      views: { page: createPageMode, workbench: createWorkbench },
    };
    const app = await createApp(ctx, store, lang, deps, {
      // Closed with ✕ (or destroyed by a later click): forget this instance so the next click starts a
      // fresh one, and drop the dev handle that would keep the torn-down app in memory.
      onClosed: () => {
        if (current()) delete window.__dxTranslator;
        if (devWin && devWin.__dxtDev === devInfo) delete devWin.__dxtDev;
      },
    });
    onLang = app.onLang;
    self.show = app.show;
    self.destroy = app.destroy;
    self.starting = false;
    if (restored) app.api.toast('Your Dynamics language was restored after an interrupted save.', 'info');
    if (devWin) devWin.__dxtDev = devInfo = { ctx, store, lang, providers, app: app.api };
  } catch (e) {
    if (!current()) return; // superseded by a newer click; that instance reports its own problems
    delete window.__dxTranslator;
    alert('The translator could not start: ' + ((e as Error)?.message || e));
  }
})();
