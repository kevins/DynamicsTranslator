// Shows freshly published labels, and a newly chosen Dynamics language, at once (ARCHITECTURE §5.3): clears every client
// cache that holds labels or the user's language and reloads the page without its warm boot. A plain reload is not
// enough, nor is deleting CacheStorage (LevelUp's clear): UCI boots from a persisted state, from a UserContext its
// service worker serves stale while it revalidates, and from copies the service worker and the state SharedWorker
// keep across reloads (LIVE-FINDINGS 50, 78, 82), and from the browser's HTTP cache (LIVE-FINDINGS 84). The purge,
// in order:
//   0. every label metadata request the service worker cached, fetched again past the HTTP cache (reprime);
//   1. the service worker's own purge commands (it answers none);
//   2. every CacheStorage cache but the code caches (main.aspx included: it carries the boot settings);
//   3. clearState to the uci-state-persistence SharedWorker (it outlives a reload while another Dynamics tab is open);
//   4. the localStorage keys of the warm boot, cached command bars and controls, and the UI strings;
//   5. the metadata stores of the org's IndexedDB (never offline records, never the database itself);
//   6. sessionStorage;
// then the same page is loaded again with flags=FCB.PersistReduxStore=false,FCB.PersistReduxStoreV2=false, so
// main.aspx boots from the server instead of a persisted state. Code caches stay (the next boot still loads its
// scripts locally), and so does every `dxt:` key (undo journal, prefs, the language repair marker).
// Before reloading the translator stores what was published (dxt:verify:<orgId>), so the next start can say when
// the page doesn't show it yet (app.ts; a page that shows it says nothing).
// Cache names, keys, worker commands and flags are UCI internals: every step is wrapped in try/catch and raced
// against a timeout, and the reload always happens. If a future build ignores all of it, the worst case is a plain
// reload.

import { recordDirty } from '../core/context';
import type { Kind, Lcid } from '../core/model';
import { plural } from './dom';
import type { ConfirmOptions, ToastKind } from './types';

/** One published text the next start checks on the page. */
export interface VerifyItem {
  comp: string;
  kind: Kind;
  key: string;
  lcid: Lcid;
  /** The text now on the server ('' = the translation was removed). */
  text: string;
}
export interface VerifyEntry {
  at: number;
  items: VerifyItem[];
}

export const verifyKey = (orgId: string): string => `dxt:verify:${orgId}`;
/** An older entry is ignored: the page has been reloaded for other reasons since. */
export const VERIFY_MAX_AGE = 3_600_000;

/**
 * CacheStorage caches that hold code, not labels (the four seen live, LIVE-FINDINGS 82). Everything else goes, an
 * allowlist: `mainaspx`, the `gcm_…` label and boot caches, `DATA_…`, `https://uci-state/…`, unknown future caches.
 */
export const KEEP_CACHES = /^(CDN_Resources|clientsdk|WebResources|sw-feature-status)/;
/**
 * localStorage keys of UCI's warm boot (`uci-state-hint`, `uci-state*`), cached command bars (`Form:<table>`), cached
 * controls (`ActualControls/<form>/…`), the UI strings of the language it booted in (`UCI_RESOURCE_STRINGS`, no
 * language in its key) and the process bar's cache (`Microsoft.Crm.BusinessProcessClientCache`, seen in other tools'
 * clears). A `dxt:` key never matches.
 */
export const dropKey = (k: string): boolean => /^(uci-state|Form:|ActualControls\/|UCI_RESOURCE_STRINGS|Microsoft\.Crm\.BusinessProcessClientCache)/.test(k);
/**
 * The service worker's purge commands (`postMessage({name})`, LIVE-FINDINGS 82), in the order sent: the cached boot
 * answer (UserContext: the language, and the metadata versions that pick the label cache) and the user settings
 * first, then the label metadata, the cached data and main.aspx. UCI's own sign-out sends PurgeGcmCache and
 * PurgeDataCache. PurgeWebResourceCache and PurgeCache are left out: by their names they drop code too, which holds
 * no labels.
 */
export const SW_PURGE = ['PurgeUserContextGcmCacheEntry', 'PurgeUserSettingsCollectionDataCacheEntry', 'PurgeGcmCache', 'PurgeDataCache', 'PurgeMainAspxCache'];
/**
 * Stores of the org's IndexedDB (named by its origin) that hold metadata the client reads again: the user context,
 * table and column metadata, apps, version stamps, navigation and personalization, and `temp…` ones. Offline data
 * (entityrecord, list, offlinedatabaseinformation, sessionstate…) never matches.
 */
export const metaStore = (n: string): boolean =>
  /^(usercontext|entitymetadata|attributemetadata|applicationmetadata|metadataversionstamp|navigationdata|userpersonalization)$/i.test(n) || /^temp/i.test(n);
/** main.aspx's feature flags that turn its warm boot from a persisted state off (`flags=FCB.<name>=true|false`). */
export const FRESH_FLAGS: Record<string, boolean> = { 'FCB.PersistReduxStore': false, 'FCB.PersistReduxStoreV2': false };

/** Label metadata caches of the service worker that answer by metadata version (`gcm_<umv+mv>_…`, not `gcm_no_version_…`). */
export const LABEL_CACHE = /^gcm_\d/;
/** Request headers the browser sets itself (fetch refuses or ignores them): never copied into a replayed request. */
const OWN_HEADER = /^(sec-|user-agent$|cookie$|host$|content-length$|connection$|origin$|referer$)/i;

/** True when `url` is an address of the site `origin` (false for one that can't be read). */
export const sameOrigin = (url: string, origin: string): boolean => {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
};

/** A request UCI made for label metadata, as its service worker cached it. */
export interface LabelRequest {
  url: string;
  headers: Record<string, string>;
}

/** The part of a MessagePort the purge uses (the uci-state persistence SharedWorker). */
export interface WorkerPort {
  postMessage(m: unknown): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
  start?(): void;
}

/** Where the service worker's commands go: the page's controller, else its registration's active worker. */
export interface SwTarget {
  postMessage(m: unknown): void;
}

/** Where the purge works; injectable for tests. A missing or null part is skipped. */
export interface PurgeEnv {
  caches?: Pick<CacheStorage, 'keys' | 'delete'> | null;
  local?: Pick<Storage, 'length' | 'key' | 'removeItem'> | null;
  session?: Pick<Storage, 'clear'> | null;
  /** The uci-state persistence worker's port; null when there is none. */
  port?: (() => WorkerPort | null) | null;
  /** UCI's service worker; null when the page has none. */
  sw?: (() => SwTarget | null | Promise<SwTarget | null>) | null;
  /** The org's IndexedDB: the factory and the database's name (the page's origin). */
  idb?: { factory: Pick<IDBFactory, 'open'>; name: string } | null;
  /** The label metadata requests to fetch again past the browser's HTTP cache (see reprime), and how; null skips it. */
  labels?: {
    requests(): Promise<LabelRequest[]>;
    fetch(url: string, init: RequestInit): Promise<{ ok: boolean; arrayBuffer(): Promise<unknown> }>;
  } | null;
}

export interface PurgeReport {
  /** Service worker commands sent. */
  sw: string[];
  /** Cache names deleted (or being deleted when the time ran out). */
  caches: string[];
  /** localStorage keys removed. */
  keys: string[];
  worker: 'cleared' | 'timeout' | 'none' | 'failed';
  /** IndexedDB metadata stores cleared. */
  stores: string[];
  idb: 'cleared' | 'timeout' | 'none' | 'failed';
  session: boolean;
  /** Label metadata requests fetched again (reprime): answered, failed, and not sent before its time ran out. */
  primed: { ok: number; failed: number; skipped: number };
}

export interface PurgeOptions {
  /** The most the whole purge waits (ms); the reload follows whatever is still running. */
  total?: number;
  /** The most it waits for the state worker's answer (ms). */
  worker?: number;
  /** The least it gives the service worker to act on its commands before the reload (ms; it answers none). */
  sw?: number;
  /** The most the label metadata requests take to fetch again (ms); the rest is skipped. */
  prime?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const quietly = <T>(fn: () => T): T | null => {
  try {
    return fn();
  } catch {
    return null;
  }
};

/** The page's own caches, storage, workers and IndexedDB. */
export function pageEnv(win: Window = window): PurgeEnv {
  return {
    caches: quietly(() => win.caches) ?? null,
    local: quietly(() => win.localStorage),
    session: quietly(() => win.sessionStorage),
    port: () => {
      const w = (win as unknown as { __uciStatePersistenceWorker?: { port?: WorkerPort } }).__uciStatePersistenceWorker;
      if (w?.port) return w.port;
      if (typeof SharedWorker === 'undefined') return null;
      // Same script and name as UCI's: connects to the running worker of this org (LIVE-FINDINGS 82).
      return new SharedWorker('/uclient/scripts/statepersistenceworker.js', { name: 'uci-state-persistence' }).port;
    },
    sw: async () => {
      const c = win.navigator?.serviceWorker;
      if (!c) return null;
      // No controller after a hard reload (Shift+F5): the worker is still registered for the page.
      return c.controller ?? (await c.getRegistration())?.active ?? null;
    },
    idb: quietly(() => (win.indexedDB ? { factory: win.indexedDB, name: win.location.origin } : null)),
    labels: win.caches
      ? {
          requests: async () => {
            const out: LabelRequest[] = [];
            for (const n of (await win.caches.keys()).filter((k) => LABEL_CACHE.test(k)))
              for (const r of await (await win.caches.open(n)).keys()) {
                // UCI caches its own requests to this site; anything else in there is not sent again, to anywhere.
                if (!sameOrigin(r.url, win.location.origin)) continue;
                const headers: Record<string, string> = {};
                r.headers.forEach((v, k) => void (OWN_HEADER.test(k) || (headers[k] = v)));
                out.push({ url: r.url, headers });
              }
            return out;
          },
          fetch: (url, init) => win.fetch(url, init),
        }
      : null,
  };
}

/**
 * Fetches every label metadata request the service worker cached once more, past the browser's HTTP cache. UCI's
 * `GetClientMetadata` answers carry `Cache-Control: max-age=31536000`, and their URLs name only the metadata versions
 * (`umv`, `mv`), never the language (LIVE-FINDINGS 84): after a language switch with no publish in between the next
 * boot asks for the same URLs, and the HTTP cache, which no script can clear, answers them in the previous language
 * (two switches in a row stayed in the first one's language). Sent with their own headers, `cache: 'reload'` and
 * `x-ms-sw-skipcache` (the service worker lets those through), they put the server's answer in the user's language
 * now in the HTTP cache. Eight at a time; whatever isn't sent within `ms` is skipped. Runs before the service worker's
 * commands, which delete the list it reads.
 */
async function reprime(labels: NonNullable<PurgeEnv['labels']>, ms: number): Promise<PurgeReport['primed']> {
  const rep = { ok: 0, failed: 0, skipped: 0 };
  const seen = new Set<string>();
  const queue = (await labels.requests()).filter((r) => !seen.has(r.url) && seen.add(r.url));
  const end = Date.now() + ms;
  const one = async (r: LabelRequest) => {
    try {
      const res = await labels.fetch(r.url, { headers: { ...r.headers, 'x-ms-sw-skipcache': '1' }, cache: 'reload', credentials: 'same-origin' });
      await res.arrayBuffer(); // the HTTP cache keeps an answer once its body is read
      if (res.ok) rep.ok++;
      else rep.failed++;
    } catch {
      rep.failed++;
    }
  };
  const lane = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) await one(r);
  };
  await Promise.race([Promise.all(Array.from({ length: 8 }, lane)), sleep(Math.max(0, end - Date.now()))]);
  rep.skipped = queue.length;
  queue.length = 0;
  return rep;
}

/** Asks the state worker to drop its in-memory copy of the persisted state; resolves on its answer or after `ms`. */
function clearWorker(port: WorkerPort, ms: number): Promise<'cleared' | 'timeout'> {
  return new Promise((resolve) => {
    const id = 'dxt-' + Math.random().toString(36).slice(2, 10);
    const on = (e: MessageEvent) => {
      const d = e?.data;
      if (d && d.type === 'clearStateResult' && d.requestId === id) done('cleared');
    };
    const t = setTimeout(() => done('timeout'), ms);
    function done(v: 'cleared' | 'timeout') {
      clearTimeout(t);
      quietly(() => port.removeEventListener('message', on));
      resolve(v);
    }
    port.addEventListener('message', on);
    port.start?.();
    port.postMessage({ type: 'clearState', requestId: id }); // no cacheKey: every app
  });
}

/**
 * Empties the metadata stores (metaStore) of the database `name`, never another store and never the database
 * itself. Resolves with the stores cleared, or null when there is no such database: opening one that doesn't exist
 * would create it, so its creation is aborted.
 */
function clearDb(f: Pick<IDBFactory, 'open'>, name: string): Promise<string[] | null> {
  return new Promise((resolve, reject) => {
    let created = false;
    const req = f.open(name);
    req.onupgradeneeded = () => {
      created = true;
      quietly(() => req.transaction?.abort());
    };
    req.onerror = () => (created ? resolve(null) : reject(req.error));
    req.onsuccess = () => {
      const db = req.result;
      const close = () => quietly(() => db.close());
      const names = Array.from(db.objectStoreNames).filter(metaStore);
      if (!names.length) {
        close();
        return resolve([]);
      }
      try {
        const tx = db.transaction(names, 'readwrite');
        for (const n of names) tx.objectStore(n).clear();
        tx.oncomplete = () => (close(), resolve(names));
        tx.onerror = tx.onabort = () => (close(), reject(tx.error));
      } catch (e) {
        close();
        reject(e);
      }
    };
  });
}

/**
 * Removes the cached labels and language (see the header): the service worker's commands and the localStorage keys
 * first, then, raced against `total` ms, every non-code CacheStorage cache, the state worker's memory (≤ `worker`
 * ms) and the IndexedDB metadata stores, while the service worker gets at least `sw` ms; then sessionStorage. Each
 * step is on its own: one failing or hanging never stops the others.
 */
export async function purge(env: PurgeEnv, o: PurgeOptions = {}): Promise<PurgeReport> {
  const rep: PurgeReport = { sw: [], caches: [], keys: [], worker: 'none', stores: [], idb: 'none', session: false, primed: { ok: 0, failed: 0, skipped: 0 } };
  // First: the label metadata in the user's language now, into the HTTP cache (see reprime); never holds the rest.
  if (env.labels) {
    const ms = o.prime ?? 5000;
    rep.primed = (await Promise.race([reprime(env.labels, ms).catch(() => null), sleep(ms + 500).then(() => null)])) ?? rep.primed;
  }
  const sw = async () => {
    const w = await env.sw?.();
    if (!w) return;
    for (const name of SW_PURGE) if (quietly(() => (w.postMessage({ name }), true))) rep.sw.push(name);
  };
  const swDone = sw().catch(() => {});
  const total = o.total ?? 2500;
  const local = env.local;
  if (local)
    try {
      const all: string[] = [];
      for (let i = 0; i < local.length; i++) {
        const k = quietly(() => local.key(i));
        if (k) all.push(k);
      }
      for (const k of all)
        if (dropKey(k) && quietly(() => (local.removeItem(k), true))) rep.keys.push(k);
    } catch {
      /* storage blocked */
    }
  const caches = async () => {
    if (!env.caches) return;
    const names = await env.caches.keys();
    await Promise.all(
      names
        .filter((n) => !KEEP_CACHES.test(n))
        .map((n) => {
          rep.caches.push(n);
          return env.caches!.delete(n).catch(() => false);
        }),
    );
  };
  const worker = async () => {
    const port = env.port?.();
    if (!port) return;
    rep.worker = 'timeout';
    rep.worker = await clearWorker(port, o.worker ?? 1000);
  };
  const idb = async () => {
    const d = env.idb;
    if (!d) return;
    rep.idb = 'timeout';
    const got = await clearDb(d.factory, d.name);
    rep.stores = got ?? [];
    rep.idb = got ? 'cleared' : 'none';
  };
  const step = (p: () => Promise<void>, fail?: () => void) =>
    p().catch(() => {
      fail?.();
    });
  // The service worker's commands go out before the caches are touched, so it drops its copies first (finding the
  // worker takes a moment at most; one that can't be found never holds the rest).
  await Promise.race([swDone, sleep(Math.min(250, total / 4))]);
  await Promise.race([
    Promise.all([step(caches), step(worker, () => (rep.worker = 'failed')), step(idb, () => (rep.idb = 'failed')), Promise.all([swDone, sleep(Math.min(o.sw ?? 300, total))])]),
    sleep(total),
  ]);
  if (env.session)
    try {
      env.session.clear();
      rep.session = true;
    } catch {
      /* storage blocked */
    }
  return rep;
}

/**
 * `href` with these main.aspx feature flags set in its `flags` parameter (`FCB.<name>=true|false`, comma separated):
 * the flags already there stay, those named here get the value given. Their `=` and `,` are written as they are.
 */
export function withFlags(href: string, flags: Record<string, boolean>): string {
  const u = new URL(href);
  const names = new Set(Object.keys(flags).map((k) => k.toLowerCase()));
  const dec = (s: string) => quietly(() => decodeURIComponent(s.replace(/\+/g, ' '))) ?? s;
  const out: string[] = [];
  const had: string[] = [];
  let at = -1;
  for (const p of u.search.replace(/^\?/, '').split('&')) {
    if (!p) continue;
    const i = p.indexOf('=');
    if (dec(i < 0 ? p : p.slice(0, i)).toLowerCase() !== 'flags') out.push(p);
    else {
      // One flags parameter, where the first one was: a second one is merged into it.
      if (at < 0) at = out.push('') - 1;
      had.push(...dec(i < 0 ? '' : p.slice(i + 1)).split(','));
    }
  }
  const all = [
    ...had.map((f) => f.trim()).filter((f) => f && !names.has(f.split('=')[0].trim().toLowerCase())),
    ...Object.entries(flags).map(([k, b]) => `${k}=${b}`),
  ];
  const param = 'flags=' + all.map((f) => encodeURIComponent(f).replace(/%3D/gi, '=')).join(',');
  if (at < 0) out.push(param);
  else out[at] = param;
  return `${u.origin}${u.pathname}?${out.join('&')}${u.hash}`;
}

/** The page to load after a purge: the same one, booting from the server (FRESH_FLAGS) when it is main.aspx. */
export const freshUrl = (href: string): string => (quietly(() => /\/main\.aspx$/i.test(new URL(href).pathname)) ? withFlags(href, FRESH_FLAGS) : href);

/** Loads the page again (freshUrl), replacing it in the history. */
export function reloadFresh(loc: Pick<Location, 'href' | 'replace' | 'reload'> = location): void {
  const to = quietly(() => freshUrl(loc.href)) ?? loc.href;
  // The same address with a #fragment would only scroll.
  if (to === loc.href) loc.reload();
  else loc.replace(to);
}

/**
 * An element in a shadow root of its own on <html> (page styles can't reach in, and Dynamics re-rendering <body>
 * can't remove it), with this stylesheet. Built without innerHTML (ui/dom.ts).
 */
function shadowBox(tag: string, css: string): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement(tag);
  const root = host.attachShadow({ mode: 'open' });
  root.append(Object.assign(document.createElement('style'), { textContent: css }));
  document.documentElement.append(host);
  return { host, root };
}

/**
 * How long the page may still be here after the reload was asked for (ms) before it counts as kept: the navigation
 * was cancelled (a "Leave site?" prompt answered Stay). A real navigation never gets that far.
 */
const STAYED = 8000;

/** A small "Refreshing…" note at the top of the page while the purge runs; gone with the reload. */
function showNote(text: string): { set(text: string): void; remove(): void } {
  try {
    const { host, root } = shadowBox(
      'dxt-refresh-note',
      'div{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:10px;padding:8px 16px;border-radius:6px;' +
        'background:#242424;color:#fff;font:600 14px/20px "Segoe UI",system-ui,sans-serif;box-shadow:0 8px 16px rgba(0,0,0,.28);pointer-events:none}' +
        'i{width:14px;height:14px;border-radius:50%;border:2px solid #ffffff55;border-top-color:#fff;animation:r .8s linear infinite}@keyframes r{to{transform:rotate(1turn)}}',
    );
    const span = Object.assign(document.createElement('span'), { textContent: text });
    const box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.append(document.createElement('i'), span);
    root.append(box);
    return { set: (t) => void (span.textContent = t), remove: () => host.remove() };
  } catch {
    return { set() {}, remove() {} };
  }
}

/**
 * The purge and the reload, nothing else: the last step of refreshPage. Whatever the purge does (throws, hangs past
 * its time), the page is reloaded.
 */
export async function refreshNow(o: { env?: PurgeEnv; reload?(): void; purge?: PurgeOptions } = {}): Promise<PurgeReport | null> {
  let rep: PurgeReport | null = null;
  try {
    rep = await purge(o.env ?? pageEnv(), o.purge);
  } catch {
    /* reload anyway */
  }
  (o.reload ?? (() => reloadFresh()))();
  return rep;
}

export interface RefreshOptions {
  /** Xrm of the page (unsaved record changes). */
  xrm: any;
  orgId: string;
  /** What was published: the next start checks that the page shows it. */
  items: VerifyItem[];
  /** Staged changes the reload would discard (asked about first). */
  pending: number;
  confirm(o: ConfirmOptions): Promise<boolean>;
  toast(message: string, kind?: ToastKind): void;
  /** Removes the translator's beforeunload guard and destroys its UI. False when it can't now (a save runs). */
  teardown(): boolean;
  /** Puts the user's Dynamics language back (LangSession.restore), so the reload boots in it. */
  restore(): Promise<void>;
  /**
   * Runs once the questions are answered, before anything is torn down (the language switch). When it throws,
   * its message is shown and nothing is reloaded.
   */
  prepare?(): Promise<void>;
  // Tests:
  env?: PurgeEnv;
  storage?: Pick<Storage, 'setItem' | 'removeItem'> | null;
  reload?(): void;
  now?(): number;
  note?(text: string): { remove(): void };
  /** STAYED. */
  stayed?: number;
}

/**
 * The translator's refresh (ARCHITECTURE §5.3). Resolves false when nothing was reloaded (the user said Not now, a save is
 * running, or `prepare` failed); true once the reload has been asked for.
 */
export async function refreshPage(o: RefreshOptions): Promise<boolean> {
  if (o.pending > 0) {
    const n = o.pending;
    const go = await o.confirm({
      title: 'Refresh the page?',
      body: `You have ${plural(n, 'unpublished change')}. Refreshing the page discards ${n === 1 ? 'it' : 'them'}.`,
      ok: 'Refresh anyway',
      cancel: 'Not now',
      danger: true,
    });
    if (!go) return false;
  }
  // Asked also when Dynamics can't tell (null): the reload would lose whatever the record has unsaved.
  const dirty = recordDirty(o.xrm);
  if (dirty !== false) {
    const body = dirty ? 'This record has unsaved changes. Refresh anyway and lose them?' : 'This record may have unsaved changes. Refresh anyway and lose them?';
    const go = await o.confirm({ title: 'Refresh the page?', body, ok: 'Refresh anyway', cancel: 'Not now', danger: true });
    if (!go) {
      o.toast('Refresh the page later to see your changes.', 'info');
      return false;
    }
  }
  if (o.prepare)
    try {
      await o.prepare();
    } catch (e) {
      o.toast((e as Error)?.message || String(e), 'error');
      return false;
    }
  if (!o.teardown()) {
    o.toast('Saving is in progress. Refresh the page once it has finished.', 'warn');
    return false;
  }
  const note = (o.note ?? showNote)('Refreshing the page…');
  // The save already restored it; this waits for a language switch a page load may have had running.
  await Promise.race([o.restore().catch(() => {}), sleep(3000)]);
  const storage = o.storage === undefined ? quietly(() => localStorage) : o.storage;
  try {
    if (o.items.length) storage?.setItem(verifyKey(o.orgId), JSON.stringify({ at: (o.now ?? Date.now)(), items: o.items } satisfies VerifyEntry));
    else storage?.removeItem(verifyKey(o.orgId));
  } catch {
    /* no check after the reload */
  }
  try {
    const rep = await refreshNow({ env: o.env, reload: o.reload });
    if (__DEV__) console.log('[translator] refresh', rep);
  } catch (e) {
    note.remove();
    throw e;
  }
  // Still here after a while: the navigation was cancelled (UCI's "Leave site?" answered Stay), so the note goes.
  setTimeout(() => note.remove(), o.stayed ?? STAYED);
  return true;
}

export interface SwitchOptions extends Omit<RefreshOptions, 'prepare'> {
  /** The language's name ("French"). */
  name: string;
  /** Why the language can't be switched now (a save runs, or a language switch window is open); '' when it can. */
  busy(): string;
  /**
   * Sets the user's Dynamics language and makes it the one the translator keeps (LangSession.adoptLanguage around
   * core/uilang setUiLanguage). Throws when it couldn't.
   */
  adopt(): Promise<void>;
}

/**
 * "Show Dynamics in <language>": switches the user's Dynamics UI language for good, then refreshes the page in it
 * (refreshPage, with the same questions first). Refused while a save or a language switch runs.
 */
export async function switchLanguage(o: SwitchOptions): Promise<boolean> {
  const why = o.busy();
  if (why) {
    o.toast(why, 'warn');
    return false;
  }
  return refreshPage({
    ...o,
    prepare: async () => {
      o.toast(`Switching Dynamics to ${o.name}…`, 'info');
      await o.adopt();
    },
  });
}

/** Reads the entry stored before a refresh; null when there is none, it is broken or older than an hour. */
export function readVerify(raw: string | null, now: number): VerifyEntry | null {
  if (!raw) return null;
  try {
    const e = JSON.parse(raw) as VerifyEntry;
    if (!e || !Array.isArray(e.items) || !(now - Number(e.at) < VERIFY_MAX_AGE) || Number(e.at) > now + 60_000) return null;
    return { at: Number(e.at), items: e.items.filter((i) => i && typeof i.key === 'string' && typeof i.text === 'string' && Number.isFinite(i.lcid)) };
  } catch {
    return null;
  }
}

/**
 * What the next start says once it has checked the page (app.ts verifyAfterLoad): how many published texts the page
 * doesn't show yet; '' when it shows them all (no message: the page itself shows the changes).
 */
export const notShowing = (missing: number): string => (missing > 0 ? `${plural(missing, 'change')} ${missing === 1 ? "isn't" : "aren't"} showing yet` : '');
