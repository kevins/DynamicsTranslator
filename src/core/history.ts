// Undo journal: what each save changed, per org and user, newest first.
// It lives in the page's localStorage, which Dynamics itself also uses, so it stays small
// (50 saves, ~400 KB, 90 days) and every access tolerates blocked or full storage. It holds the texts each save
// replaced and wrote, as Undo needs them (it writes the old text back where the new one still is), so it is kept per
// user: another account signed in to this browser profile doesn't list or undo them. Anyone who reads the browser's
// storage itself (developer tools) still can.
// A label costs its key and component (~60–160 characters), kind, language, the title and place Recent publishes shows
// (`where`, ~50 characters on a form, left out when there is none) and both texts: ~190 characters for a column, ~320
// for a form cell with short texts, so ~400 KB holds roughly 1,200–2,000 labels; past it the oldest saves leave first.
// A single save too large to keep with its places (a bulk import past the 1.5 MB ceiling or the quota) is kept without
// them (~270 characters a form cell): Undo needs its texts, not where they showed.
// The tabs of one user share the journal, and localStorage has no locking of its own: every change of it (a save added,
// one marked published or undone, the expired ones removed) reads and writes it alone among this browser's tabs (change(),
// Web Locks), so a tab never writes back a list it read before another tab's write and drops that tab's save. One key
// with a lock rather than a key per save: the journal stays one read, its budget and order one decision, and the storage
// needs no listing of its keys (which Dynamics' own keys would crowd).

import type { HistoryEntry } from '../ui/types';
import type { Ctx } from './context';

const KEY = (ctx: Ctx) => `dxt:history:${ctx.orgId}:${ctx.userId}`;
/** The journal before it was kept per user: one for every account of the browser profile. */
const SHARED = (ctx: Ctx) => `dxt:history:${ctx.orgId}`;
const MAX = 50;
const BUDGET = 400_000;
/** Hard ceiling for a single huge save (bulk import), so the journal can never crowd out Dynamics. */
const CEILING = 1_500_000;
/** Saves older than this leave the journal, and the storage: Undo is for mistakes noticed soon. */
const MAX_AGE = 90 * 86_400_000;

function parse(raw: string | null): HistoryEntry[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((e) => e && typeof e.id === 'string' && Array.isArray(e.items)) : [];
  } catch {
    return [];
  }
}

const drop = (key: string): boolean => {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
};

/**
 * The journal kept per org before (SHARED), from an earlier version: nothing tells whose saves it holds, so they are never
 * given to whoever opens the translator next (another account signed in to this browser profile would see their texts
 * and be offered their Undo). It is removed unread: those saves can no longer be undone from the translator.
 */
function dropShared(ctx: Ctx): void {
  try {
    if (localStorage.getItem(SHARED(ctx)) !== null) localStorage.removeItem(SHARED(ctx));
  } catch {
    /* storage blocked: there is nothing to read it from either */
  }
}

/** This user's journal as stored, expired saves included; null when the storage can't be read. */
function stored(ctx: Ctx): HistoryEntry[] | null {
  try {
    return parse(localStorage.getItem(KEY(ctx)));
  } catch {
    return null;
  }
}

const unexpired = (list: HistoryEntry[]): HistoryEntry[] => {
  const now = Date.now();
  return list.filter((e) => now - e.at < MAX_AGE);
};

/** This user's saves in this org, newest first. Those older than MAX_AGE are left out, and removed from the storage. */
export function readHistory(ctx: Ctx): HistoryEntry[] {
  dropShared(ctx);
  const all = stored(ctx);
  if (!all) return [];
  const list = unexpired(all);
  // Removed as any change of the journal is made (change() leaves them out), never by writing back this read.
  if (list.length < all.length) void change(ctx, () => null);
  return list;
}

/** What change() needs of Web Locks (navigator.locks). */
interface Locks {
  request(name: string, fn: () => unknown): Promise<unknown>;
}

/**
 * Changes this user's journal: `edit` gets the list as stored now, expired saves left out, and returns the list to store
 * (null: it changed nothing; the expired saves still leave). Alone among this browser's tabs (a Web Lock by org and user),
 * so the list it edits is never one read before another tab's write. A tab's own changes run in the order made (a lock is
 * granted in request order). Without Web Locks, or when the browser refuses the lock, at once, so the change is made
 * before this returns; the journal is read again right before it is written, and a list that changed since (another tab
 * wrote in between) is edited again from that one, a few times at most. Resolves with whether the list was stored (true
 * when there was nothing to store); never rejects.
 */
function change(ctx: Ctx, edit: (list: HistoryEntry[]) => HistoryEntry[] | null): Promise<boolean> {
  const raw = (): string | null | undefined => {
    try {
      return localStorage.getItem(KEY(ctx));
    } catch {
      return undefined; // storage blocked
    }
  };
  const job = (): boolean => {
    for (let i = 0; ; i++) {
      const was = raw();
      if (was === undefined) return false;
      const all = parse(was);
      const list = unexpired(all);
      const next = edit(list) ?? (list.length < all.length ? list : null);
      if (!next) return true;
      if (i < 3 && raw() !== was) continue;
      return write(ctx, next);
    }
  };
  const locks = (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks;
  if (typeof locks?.request !== 'function') return Promise.resolve(job());
  let ran = false;
  try {
    return locks.request(KEY(ctx), () => ((ran = true), job())).then(
      (x) => x === true,
      () => (ran ? false : job()),
    );
  } catch {
    return Promise.resolve(job());
  }
}

/** A save without the places Recent publishes shows: what Undo needs (its rows then show title and what, as older entries do). */
const lean = (e: HistoryEntry): HistoryEntry | null =>
  e.items.some((it) => it.where !== undefined) ? { ...e, items: e.items.map(({ where: _, ...it }) => it) } : null;

/**
 * Stores the list, dropping the oldest saves to fit. The newest save is kept even when it alone exceeds the budget; one
 * too large to keep with its places (past the ceiling, or the browser's quota) is kept without them, so it can be undone.
 */
function write(ctx: Ctx, list: HistoryEntry[]): boolean {
  list = list.slice(0, MAX);
  if (!list.length) return drop(KEY(ctx));
  let s = JSON.stringify(list);
  while (s.length > BUDGET && list.length > 1) s = JSON.stringify((list = list.slice(0, -1)));
  /** The newest save alone, without its places; false when it has none to leave out. */
  const smaller = (): boolean => {
    const e = lean(list[0]);
    if (e) s = JSON.stringify((list = [e]));
    return !!e;
  };
  if (s.length > CEILING) smaller();
  if (s.length > CEILING) return false;
  for (;;) {
    try {
      localStorage.setItem(KEY(ctx), s);
      return true;
    } catch {
      // Quota exceeded (or storage blocked): make room by dropping more of the oldest saves, then the places.
      if (list.length > 1) s = JSON.stringify((list = list.slice(0, -1)));
      else if (!smaller()) return false;
    }
  }
}

/** Adds a save at the top, replacing an entry with the same id. Resolves false when it could not be stored. */
export function addHistory(ctx: Ctx, e: HistoryEntry): Promise<boolean> {
  return change(ctx, (list) => [e, ...list.filter((x) => x.id !== e.id)]);
}

/**
 * Marks saves that were published later (Publish again, Recent publishes › Publish), keeping their order; with
 * `on` false, as not published after all (the Publish dialog's forms check found their forms still unpublished).
 */
export function markPublished(ctx: Ctx, ids: Iterable<string>, on = true): Promise<void> {
  const want = new Set(ids);
  if (!want.size) return Promise.resolve();
  return change(ctx, (list) => {
    let hit = false;
    for (const e of list) if (want.has(e.id) && e.published !== on) (e.published = on), (hit = true);
    return hit ? list : null;
  }).then(() => undefined);
}

export function markUndone(ctx: Ctx, id: string, kept = 0): Promise<void> {
  return change(ctx, (list) => {
    const e = list.find((x) => x.id === id);
    if (!e) return null;
    e.undoneAt = Date.now();
    if (kept) e.kept = kept;
    return list;
  }).then(() => undefined);
}
