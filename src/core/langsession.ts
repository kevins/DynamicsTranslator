// Switches the signed-in user's Dynamics UI language for a moment, safely.
//
// Why: Dataverse returns and stores form/dashboard tab and section labels only in the caller's UI language
// (LIVE-FINDINGS 8, 9), so language L is read and written while the user's UI language is L.
//
// How (LIVE-FINDINGS 49): the switch, the work and the switch back travel in ONE $batch
//   [GET uilanguageid, PATCH uilanguageid = L, probe, ...work, PATCH uilanguageid = original]
// sent with `Prefer: odata.continue-on-error` (Http.batch always adds it), so Dataverse runs the switch back
// itself even when a part in the middle fails, the network drops after sending or the tab closes. Without it
// the batch stops at the first failing part and the user stays switched (LIVE-FINDINGS 49). Around that:
//   * Every UI-language-sensitive operation of the page runs under one lock (`hold`): these batches, and the
//     reads and writes of form XML in the user's own language (they get tab and section labels in whatever
//     language is current). The lock is an in-tab queue plus the cross-tab Web Lock `dxt:lang:<org>:<user>`,
//     so no switch of this or another translator tab overlaps another one, or a user-language read.
//   * A second lock, `dxt:langwin:<org>:<user>`, covers only the switch windows themselves: held exclusively
//     from before a switch is sent until its switch back is known to have run, and shared by `quiet()`
//     (UpdateOptionValue, which sends only some languages of a label), so such a write never runs while the
//     user is switched, yet does not wait for the user-language form work of a hold.
//   * The original language and the one switched to go into the repair marker before the switch is sent. A switch
//     back that failed inside the batch is repaired at once, before the window closes; once the hold's work is done
//     the language is read again (no-store) and set back if it is not the original, and only then is the marker
//     cleared. A marker left by a run that could not finish is repaired by `recover()` at the next start, only
//     while the user is still in the language it switched to (otherwise the switch finished on the server and the
//     language was changed since), and never silently when that was long ago (markerSays).
//   * A switching batch is never aborted (an aborted fetch says nothing about whether, or when, the server runs
//     it). When its answer is lost (network failure, gateway or server error) it is in doubt (`doubtful`): it may not
//     have run yet, or be running now. The language is not touched, and the lock and the window stay held (here and in
//     every other tab), until it is known to have ended: its switch seen, then the original twice (its switch back,
//     its last part), or LOST_MS after it was sent, when Dataverse can no longer run it. Setting it back earlier could
//     land between the batch's switch and its work, which would then run in the wrong language; releasing earlier could
//     let other work run inside its switch (LIVE-FINDINGS 62). A caller may stop waiting (Stop); the session goes on.
//     The marker says until when (`until`, written before the batch is sent), so a translator started again after a
//     reload, in this tab or another, waits it out too (`calm`).
//   * A probe in the same batch (systemuser's UserLocalizedLabel follows the caller's UI language), right after
//     the switch, proves Dataverse answered the work in L. Callers discard reads that are not proven.
//   * What goes back is the user's own language: the one the page started in, unless the language was changed
//     outside the translator since. A marker left by a switch that never finished (another tab closed in the
//     middle of one) names it and is repaired before any switch; otherwise the leading GET of a switching
//     batch, taken under the lock, tells it.
// Only `uilanguageid` changes (never the locale or the help language).

import type { Ctx } from './context';
import { DvError, abortError, isAbort, turnedAway, type BatchPart, type PartResult } from './http';
import { lcidName } from './lcid';
import type { Lcid } from './model';
import { langLock, markerKey, windowLock } from './uilang';

// The marker and the locks are named in core/uilang.ts.
const KEY = (ctx: Ctx) => markerKey(ctx.orgId, ctx.userId);
const LOCK = (ctx: Ctx) => langLock(ctx.orgId, ctx.userId);
const WINDOW = (ctx: Ctx) => windowLock(ctx.orgId, ctx.userId);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const us = (ctx: Ctx) => `usersettingscollection(${ctx.userId})`;
/**
 * Proves which language Dataverse answers in: systemuser's UserLocalizedLabel follows the caller's UI language
 * (the same probe the previous switcher confirmed every switch with).
 */
export const PROBE: BatchPart = { method: 'GET', url: "EntityDefinitions(LogicalName='systemuser')?$select=DisplayName", headers: { Consistency: 'Strong' } };

/** True when a probe answer shows Dataverse answering in `lcid`. */
export function probeSays(r: PartResult | undefined, lcid: Lcid, base: Lcid): boolean {
  if (!r?.ok) return false;
  const got = Number(r.data?.DisplayName?.UserLocalizedLabel?.LanguageCode);
  if (got === lcid) return true;
  // A language without a label for this table falls back to the base language; that answer counts only when
  // the label truly has no entry for lcid.
  const has = (r.data?.DisplayName?.LocalizedLabels || []).some((l: any) => Number(l?.LanguageCode) === lcid);
  return !has && got === base;
}

/**
 * The repair marker: the user's own language, the one a switch went to (absent in markers of older versions), when,
 * and, while a request of that switch is sent and not answered, `until` when it may still run on the server.
 */
export interface Marker {
  lcid: Lcid;
  to?: Lcid;
  at: number;
  until?: number;
}

/** How long a marker counts as a switch in progress; an older one is never acted on without asking. */
export const MARKER_AGE = 10 * 60 * 1000;

/**
 * How long after it was sent a request whose answer was lost may still run on the server. Dataverse ends a request it
 * has not finished within 2 minutes (its request timeout, the limit long Web API calls run into), so one sent at t has
 * run, or never will, by t + 2 min; 30 s more covers the time before the server starts that clock (gateway,
 * connection). Microsoft's limit, not measured live.
 */
export const LOST_MS = 150_000;

/** What a save says while a request whose answer was lost may still run (doubtful). */
export const WAITING = 'Waiting to be sure an earlier request finished before saving more…';

/**
 * What a marker means, given the language Dataverse has now: 'wait' while a request of that switch may still run
 * (`until`: nothing is repaired or cleared before it can't); 'clear' when there is nothing to repair (already back,
 * or the switch finished on the server and the language was changed since); 'repair' when the user is still in the
 * language it switched to, recently; 'ask' when that was long ago (the user may have chosen that language since, in
 * Personalization settings).
 */
export function markerSays(m: Marker, now: Lcid, at = Date.now()): 'clear' | 'repair' | 'ask' | 'wait' {
  if (m.until !== undefined && at < m.until) return 'wait';
  if (now === m.lcid || (m.to !== undefined && now !== m.to)) return 'clear';
  return at - m.at < MARKER_AGE ? 'repair' : 'ask';
}

/**
 * Dataverse answered the request as a whole (turned it away, refused it, sent an unreadable batch answer): it has
 * ended, run or not. Otherwise (a network failure, a gateway or server error) only its answer may be lost.
 */
const answered = (e: unknown): boolean => e instanceof DvError && (turnedAway(e) || (e.status > 0 && e.status < 500) || e.code === 'batch');

/** `p`, or an AbortError as soon as `signal` aborts (`p` goes on without the caller). */
function waitFor<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(abortError());
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    void p.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

type LockMode = 'exclusive' | 'shared';

/** What LangSession needs from the browser (tests pass their own). */
export interface LangEnv {
  /** Web Locks (navigator.locks); null: the in-tab locks only. */
  locks?: { request(name: string, options: { signal?: AbortSignal; mode?: LockMode }, fn: () => Promise<unknown>): Promise<unknown> } | null;
  /** Where the repair marker lives (localStorage). */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** Waits between attempts to put the language back (tests pass a quick one). */
  sleep?: (ms: number) => Promise<unknown>;
  /** The clock (tests pass their own). */
  now?: () => number;
}

function defaultEnv(): LangEnv {
  let storage: LangEnv['storage'] = null;
  try {
    storage = localStorage;
  } catch {
    /* storage blocked: the batch restores server-side anyway */
  }
  const nav = typeof navigator === 'undefined' ? null : (navigator as Navigator & { locks?: LangEnv['locks'] });
  return { locks: nav?.locks && typeof nav.locks.request === 'function' ? nav.locks : null, storage };
}

/** In-tab readers-writer lock, granted in request order (a waiting exclusive request holds back later shared ones). */
class RwLock {
  /** Holders: the number of shared ones, or -1 for an exclusive one. */
  private n = 0;
  private q: Array<{ x: boolean; go: () => void }> = [];
  async run<T>(x: boolean, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw abortError();
    if (this.q.length || !this.fits(x))
      await new Promise<void>((go, no) => {
        const w = { x, go: () => (signal?.removeEventListener('abort', drop), go()) };
        // Stopped while it waits: it leaves the queue, and those behind it may go.
        const drop = () => {
          this.q.splice(this.q.indexOf(w), 1);
          this.grant();
          no(abortError());
        };
        this.q.push(w);
        signal?.addEventListener('abort', drop, { once: true });
      });
    else this.take(x);
    try {
      return await fn();
    } finally {
      this.n = this.n < 0 ? 0 : this.n - 1;
      this.grant();
    }
  }
  private grant(): void {
    while (this.q.length && this.fits(this.q[0].x)) {
      const w = this.q.shift()!;
      this.take(w.x);
      w.go();
    }
  }
  private fits(x: boolean): boolean {
    return x ? this.n === 0 : this.n >= 0;
  }
  private take(x: boolean): void {
    this.n = x ? -1 : this.n + 1;
  }
}

/** One $batch run in a language. */
export interface LangBatch {
  /** True when the probe proved Dataverse ran the parts in the asked language. */
  inLang: boolean;
  /** One result per part given, in order (the switch, probe and switch-back parts are left out). */
  results: PartResult[];
}

/** What a hold's callback can do while it has the language lock. */
export interface LangHold {
  /**
   * Sends `parts` in one $batch that runs while the UI language is `lcid`: switched to it and back around the
   * parts when it is not the user's current language, otherwise only probed. A batch of reads that is not proven
   * to be in `lcid` is tried once more after reading the user's language again. A batch with writes is sent
   * without the signal: once sent, the write and its check always finish; it is never sent again either, not
   * even when throttled (the caller reads again first). A batch that switches is never aborted: the signal is
   * looked at before it is sent and after it is answered. The batches of one hold are sent one after another
   * (await each). Nothing is sent while a switching batch whose answer was lost may still run (doubtful): the
   * signal ends that wait (AbortError); a batch whose own answer was lost throws its error once that is over or
   * the signal aborts.
   */
  batch(lcid: Lcid, parts: BatchPart[], signal?: AbortSignal): Promise<LangBatch>;
  /**
   * Runs `fn` with the switch window held across all its batches: no quiet() job runs between a read and the
   * write built from it, so the write never waits for one. `fn` only sends batches of this hold. It starts once no
   * switch in doubt may still run (the hold's signal ends that wait), and the window stays held while one may.
   */
  window<T>(fn: () => Promise<T>): Promise<T>;
}

const sessions = new WeakMap<Ctx, LangSession>();

export class LangSession {
  /** The user's own UI language: what every switch goes back to. */
  private orig: Lcid;
  /** A switch was sent and the language has not been confirmed back (read again) since. */
  private dirty = false;
  /** The last check could not put the language back (the next hold tries again before doing anything). */
  private stuck = false;
  /** Language of the last switch (shown while stuck). */
  private last: Lcid | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly win = new RwLock();
  private readonly env: LangEnv;
  private onHide = () => this.restoreOnUnload();
  /** Language `run()` switched to (the keepalive restore applies only then). */
  private running: Lcid | null = null;
  /** A hold's `window()` holds the switch window: its batches do not take it again. */
  private inWin = false;
  /** A switch whose answer was lost may still run: everything language-sensitive waits for `done` (doubtful). */
  private doubt: { done: Promise<void> } | null = null;
  /** Told when such a wait starts (true) and ends (false). */
  private readonly waits = new Set<(waiting: boolean) => void>();

  constructor(
    private readonly ctx: Ctx,
    /**
     * Called with the temporary language while `run()` keeps the user switched, or while the language could not
     * be switched back; null once it is back. The quick switches of `hold().batch` do not call it (the server
     * switches back within the same request).
     */
    private readonly onChange: (lcid: Lcid | null) => void = () => {},
    env?: LangEnv,
  ) {
    this.orig = ctx.user;
    this.env = env ?? defaultEnv();
    if (!sessions.has(ctx)) sessions.set(ctx, this);
  }

  /** The page's session for this context (the first one created), so every reader shares one queue. */
  static of(ctx: Ctx): LangSession | undefined {
    return sessions.get(ctx);
  }

  /** True while a switch is in flight or not yet confirmed back, or the language could not be switched back. */
  get active(): boolean {
    return this.dirty || this.stuck || !!this.doubt;
  }

  /** True while a switch whose answer was lost may still run on the server: nothing language-sensitive starts (doubtful). */
  get waiting(): boolean {
    return !!this.doubt;
  }

  /** Calls `fn(true)` when such a wait starts (at once when one runs) and `fn(false)` when it ends; returns the unsubscribe. */
  onWait(fn: (waiting: boolean) => void): () => void {
    this.waits.add(fn);
    if (this.doubt) fn(true);
    return () => void this.waits.delete(fn);
  }

  /**
   * Runs `fn` with the language lock held. Before it starts, a language left switched by an earlier failure is
   * repaired (and nothing runs if that fails); after it, a language switched by its batches is checked and put
   * back before the lock goes to the next operation. The result is handed over as soon as `fn` finishes; the lock
   * stays while a switch whose answer was lost may still run (doubtful). A signal that aborts before `fn` starts
   * frees the caller at once (AbortError) and `fn` never runs.
   * Never call hold, run or restore from inside `fn` (the lock is not reentrant).
   */
  hold<T>(fn: (h: LangHold) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const stop = () => reject(abortError());
      signal?.addEventListener('abort', stop, { once: true });
      const job = this.queue.then(() =>
        this.locked(
          LOCK(this.ctx),
          'exclusive',
          async () => {
            if (signal?.aborted) throw abortError();
            // A switch a translator that went away left in doubt (its marker) is waited out first.
            await this.calm();
            await this.settle();
            if (signal?.aborted) throw abortError();
            signal?.removeEventListener('abort', stop); // from here on `fn` decides what a stop means
            const h: LangHold = {
              batch: (lcid, parts, s) => this.send(lcid, parts, s ?? signal),
              window: async (f) => {
                if (this.inWin) return f();
                if (this.doubt) await waitFor(this.doubt.done, signal);
                return this.excl(async () => {
                  this.inWin = true;
                  try {
                    return await f();
                  } finally {
                    this.inWin = false;
                  }
                });
              },
            };
            const r = Promise.resolve().then(() => fn(h));
            r.then(resolve, reject);
            try {
              await r;
            } catch {
              /* handed to the caller */
            } finally {
              await this.calm();
              // A failure leaves `stuck` set (and the banner up): the next hold tries again before running.
              await this.settle().catch(() => {});
            }
          },
          signal,
        ),
      );
      job.catch(reject).finally(() => signal?.removeEventListener('abort', stop));
      this.queue = job.catch(() => {});
    });
  }

  /**
   * Runs `fn` while no UI-language switch of the translator is open, in this tab or another: it waits for one
   * that is, and new ones wait until it ends. Many can run at once, alongside holds whose batches do not switch.
   * For writes that send only some languages of a label (UpdateOptionValue); those are correct in any UI language
   * (LIVE-FINDINGS 45), and this keeps the question from arising. When the language could not be switched back
   * (the banner is up) `fn` still runs: nothing of the translator is switching any more. Not while a switch whose
   * answer was lost may still run (doubtful): `fn` waits until it can't. `signal` ends any wait (AbortError, and
   * `fn` never runs).
   */
  async quiet<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (;;) {
      if (this.doubt) await waitFor(this.doubt.done, signal);
      let again = false;
      const r = await this.window(
        'shared',
        async () => {
          // In doubt here: left by a translator that went away (one still running holds the window), waited out under the lock.
          if (this.doubt || this.pending()) return void (again = true);
          return fn();
        },
        signal,
      );
      if (!again) return r as T;
      await waitFor(this.restore(), signal).catch((e) => {
        if (isAbort(e)) throw e;
      });
    }
  }

  /**
   * Runs `fn` while the user's UI language is `lcid` (old style: one switch around everything `fn` sends, for
   * the rare retries of sitemap and BPF labels). Switches back right after `fn`, with the same marker, locks and
   * check as `hold`. A switch whose answer was lost may still land after the switch back: it is watched until it
   * can't, and set back if it does (doubtful).
   */
  run<T>(lcid: Lcid, fn: () => Promise<T>): Promise<T> {
    return this.hold(async () => {
      const { http } = this.ctx;
      await this.adopt();
      const was = this.orig;
      if (was === lcid) {
        await this.confirm(lcid);
        return fn();
      }
      return this.excl(async () => {
        let until = this.clock() + LOST_MS;
        this.mark(was, lcid, until);
        this.dirty = true;
        this.last = this.running = lcid;
        // pagehide only: beforeunload also comes before a "Leave site?" prompt (the app's while a save runs), and a user
        // who stays would then go on working here in the language just set back.
        if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onHide);
        this.onChange(lcid);
        let lost = false;
        try {
          try {
            await http.patch(us(this.ctx), { uilanguageid: lcid }, { onSend: () => this.mark(was, lcid, (until = this.clock() + LOST_MS)) });
          } catch (e) {
            lost = !answered(e);
            throw e;
          } finally {
            // Answered: it is no longer on its way (one whose answer was lost is marked again below).
            if (!lost) this.mark(was, lcid);
          }
          await this.confirm(lcid);
          return await fn();
        } finally {
          this.running = null;
          if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onHide);
          await http.patch(us(this.ctx), { uilanguageid: was }).catch(() => {});
          this.onChange(null);
          // Checked before the window closes; the hold tries again when this fails.
          await this.settle().catch(() => {});
          if (lost) {
            this.dirty = true;
            this.mark(this.orig, lcid, until);
            this.doubtful(lcid, until, true, false);
          }
        }
      });
    });
  }

  /**
   * Makes sure nothing is left switched: waits for the operations in flight, then repairs a language that could
   * not be switched back. Safe to call many times; rejects when the language is still not back. `signal` ends only
   * a wait for a switch whose answer was lost (doubtful, here or in another tab); the check itself goes on without the
   * caller.
   */
  restore(signal?: AbortSignal): Promise<void> {
    const p = this.hold(async () => {});
    if (!signal) return p;
    return new Promise<void>((resolve, reject) => {
      // A switch in doubt here, or in another tab (its marker: that tab holds the lock until it can no longer run).
      const check = () => void (signal.aborted && (this.doubt || this.pending()) && reject(abortError()));
      const off = this.onWait(check);
      signal.addEventListener('abort', check, { once: true });
      check();
      void p.then(resolve, reject).finally(() => {
        off();
        signal.removeEventListener('abort', check);
      });
    });
  }

  /**
   * Makes `lcid` the user's own language for good ("Show Dynamics in", core/uilang.ts): `set` changes it on the
   * server while nothing of the translator is switched, in this tab or another (the lock and the switch window, after
   * an earlier switch is confirmed back). From then on every switch goes back to `lcid`, and the repair marker goes,
   * so nothing (this session, or recover() at the next start) puts the old language back. Nothing changes when `set`
   * throws.
   */
  adoptLanguage(lcid: Lcid, set: () => Promise<void>): Promise<void> {
    return this.hold(() =>
      this.window('exclusive', async () => {
        await set();
        this.orig = lcid;
        this.unmark();
      }),
    );
  }

  /**
   * Runs `fn` under the Web Lock `name` when the browser has Web Locks. A browser that refuses the lock itself
   * (not a cancel) leaves the in-tab locks only, rather than failing every language-sensitive operation.
   */
  private locked<T>(name: string, mode: LockMode, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const locks = this.env.locks;
    if (!locks) return fn();
    let ran = false;
    const go = () => ((ran = true), fn());
    return Promise.resolve()
      .then(() => locks.request(name, signal ? { mode, signal } : { mode }, go) as Promise<T>)
      .catch((e) => {
        if (ran || isAbort(e) || signal?.aborted) throw e;
        return fn();
      });
  }

  /** The switch window: exclusive while the user is switched, shared by `quiet()`. In-tab lock first, then the Web Lock. */
  private window<T>(mode: LockMode, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.win.run(mode === 'exclusive', () => this.locked(WINDOW(this.ctx), mode, fn, signal), signal);
  }

  /**
   * `fn` in the exclusive switch window. Its result is handed over as soon as it settles; the window stays held, in
   * this tab and every other, while a switch whose answer was lost may still run (doubtful).
   */
  private excl<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.window('exclusive', async () => {
        const r = Promise.resolve().then(fn);
        r.then(resolve, reject);
        await r.catch(() => {});
        await this.doubt?.done;
      }).catch(reject);
    });
  }

  private async send(lcid: Lcid, parts: BatchPart[], signal?: AbortSignal): Promise<LangBatch> {
    // Nothing is sent while a switch whose answer was lost may still run (doubtful); a stop ends only this wait.
    if (this.doubt) await waitFor(this.doubt.done, signal);
    const reads = parts.every((p) => p.method === 'GET');
    const b = await this.once(lcid, parts, reads ? signal : undefined, reads, signal);
    if (b.inLang || !reads) return b;
    // Not proven to be in `lcid`. The user's language may have been changed outside the translator, or left
    // switched by a tab that closed in the middle of a switch: learn it again and try once more (switching
    // around the read if needed).
    if (signal?.aborted) throw abortError();
    await this.settle();
    await this.adopt();
    return this.once(lcid, parts, signal, reads, signal);
  }

  /** `stop`: ends the caller's wait when this batch's answer is lost (the session goes on waiting, doubtful). */
  private async once(lcid: Lcid, parts: BatchPart[], signal: AbortSignal | undefined, reads: boolean, stop?: AbortSignal): Promise<LangBatch> {
    const { http, base } = this.ctx;
    // A switch left unfinished by another tab is repaired first (and names the user's language).
    if (lcid !== this.orig && !this.dirty && this.marker() !== null) await this.adopt();
    if (lcid === this.orig) {
      // A batch that does not switch must start in the user's language: confirm an earlier switch is back first.
      await this.settle();
      // Reads are sent again after a network failure or a gateway error (Http), writes never (not even throttled).
      const res = await http.batch([PROBE, ...parts], { signal, idempotent: reads, once: !reads });
      return { inLang: probeSays(res[0], lcid, base), results: res.slice(1, 1 + parts.length) };
    }
    const go = async (): Promise<LangBatch> => {
      // Cancelling stops before the switch is sent, never during it (see the header).
      if (signal?.aborted) throw abortError();
      const orig = this.orig;
      const path = us(this.ctx);
      const all: BatchPart[] = [
        { method: 'GET', url: `${path}?$select=uilanguageid` },
        { method: 'PATCH', url: path, body: { uilanguageid: lcid } },
        PROBE,
        ...parts,
        { method: 'PATCH', url: path, body: { uilanguageid: orig } },
      ];
      // The leading GET says something about the user only when nothing of ours was left switched before it (an
      // earlier batch of this hold whose switch back failed would look like a change made elsewhere).
      const clean = !this.dirty;
      // Before anything is sent: an interrupted run is repaired at the next start, and waited out there until the
      // batch can no longer run (`until`) should its answer never come. Counted again from each time Http really
      // sends it (a write slot waited for, throttled answers retried).
      let until = this.clock() + LOST_MS;
      this.mark(orig, lcid, until);
      this.dirty = true;
      this.last = lcid;
      const sent = () => this.mark(orig, lcid, (until = this.clock() + LOST_MS));
      let res: PartResult[];
      try {
        // Never sent twice (not idempotent): it may still be running on the server, and a second one would
        // overlap its switch window. Never aborted: the server may run it anyway, after the language was read back.
        res = await http.batch(all, { idempotent: false, once: !reads, onSend: sent });
      } catch (e) {
        if (answered(e)) {
          // It has ended, run or not: the language is checked as after any batch.
          this.mark(orig, lcid);
          await this.settle().catch(() => {});
        } else {
          // Its answer is lost: it may not have run yet, or be running now. The window and the lock stay until it
          // can't (doubtful); the caller may stop waiting.
          this.doubtful(lcid, until, false, false);
          await waitFor(this.doubt!.done, stop).catch(() => {});
        }
        throw e;
      }
      // Answered: it has ended.
      this.mark(orig, lcid);
      const back = res[all.length - 1].ok;
      const was = clean && res[0].ok ? Number(res[0].data?.uilanguageid) : 0;
      if (was > 0 && was !== orig) {
        // The user's language was changed outside the translator (no switch of ours or of another translator
        // tab can be in flight: the locks, and the marker check above): that is the one to put back, now.
        this.orig = was;
        this.mark(was, back ? orig : lcid);
        await this.settle().catch(() => {});
      } else if (!back) {
        // The switch back failed on the server: put it back before anything else may run in the user's name.
        await this.settle().catch(() => {});
      }
      // Cancelled while it ran: it ended (and switched back) all the same; its answer is dropped.
      if (signal?.aborted) throw abortError();
      return { inLang: probeSays(res[2], lcid, base), results: res.slice(3, 3 + parts.length) };
    };
    return this.inWin ? go() : this.excl(go);
  }

  /**
   * After a switch: reads the language again (no-store) and sets it back until it is the original; then clears
   * the marker. Throws when it can't (the marker stays for `recover()`, and the banner shows).
   */
  private async settle(): Promise<void> {
    if (!this.dirty) return;
    const want = this.orig;
    let err: unknown = null;
    for (let i = 0; i < 4; i++) {
      try {
        if ((await this.readUi()) === want) return this.back();
        if (i < 3) await this.ctx.http.patch(us(this.ctx), { uilanguageid: want });
      } catch (e) {
        err = e;
        if (i < 3) await (this.env.sleep ?? sleep)(400 * (i + 1));
      }
    }
    if (!this.stuck) {
      this.stuck = true;
      this.onChange(this.last);
    }
    const why = err instanceof Error && err.message ? ` (${err.message})` : '';
    throw new DvError(
      `Your Dynamics language could not be switched back to ${lcidName(want)}${why}. Restart the translator to repair it, or change it in Personalization settings.`,
      0,
      'langrestore',
    );
  }

  /** The language is confirmed back: the marker goes, and the banner if it was up. */
  private back(): void {
    this.dirty = false;
    this.unmark();
    if (this.stuck) {
      this.stuck = false;
      this.onChange(null);
    }
  }

  /**
   * A switch to `to` whose answer was lost (or left in doubt by a translator that went away): Dataverse may not have
   * started it yet, or be in the middle of it, until `until` (LOST_MS after it was sent; it can't run after that).
   * Setting the language back now could land between its switch and its work (which would then run in the wrong
   * language), and reads of the original language say nothing about a batch that has not started. So everything
   * language-sensitive waits (`doubt`; the window and the lock stay held by whoever holds them) while this reads the
   * language every ~1.5 s: its switch seen, then the original twice, is its switch back, its last part (`single`: one
   * PATCH with no work inside it, set back as soon as it is seen); never seen, it waits until `until`. Then the
   * language is checked as after any batch (settle), unless it was changed to a third one elsewhere meanwhile (kept).
   * `lock`: takes the exclusive window itself (nobody holds it).
   */
  private doubtful(to: Lcid, until: number, single: boolean, lock: boolean): void {
    const go = async (): Promise<void> => {
      const want = this.orig;
      let seen = false;
      let same = 0;
      for (let i = 0; this.clock() < until; i++) {
        if (i) await (this.env.sleep ?? sleep)(1500);
        const now = await this.readUi().catch(() => 0);
        seen ||= now === to;
        same = now === want ? same + 1 : 0;
        if (seen && single) break;
        if (seen && same >= 2) return this.back();
      }
      const now = await this.readUi().catch(() => 0);
      if (now > 0 && now !== want && now !== to) {
        this.orig = now;
        return this.back();
      }
      await this.settle();
    };
    let end!: () => void;
    this.doubt = { done: new Promise<void>((r) => (end = r)) };
    this.tellWait(true);
    void (lock ? this.window('exclusive', go) : go())
      .catch(() => {}) // a failed check leaves `stuck` set (and the banner up), as after any batch
      .then(() => {
        this.doubt = null;
        this.tellWait(false);
        end();
      });
  }

  /**
   * Waits while a switch whose answer was lost may still run (doubtful). One a translator that went away left in doubt
   * (its marker says until when; one still running holds the lock) is waited out here, as it would have.
   */
  private async calm(): Promise<void> {
    if (!this.doubt) {
      const m = this.marker();
      if (!m || !this.pending()) return;
      this.orig = m.lcid;
      this.dirty = true;
      this.last = m.to!;
      this.doubtful(m.to!, m.until!, false, !this.inWin);
    }
    await this.doubt?.done;
  }

  /** The marker says a request that switched the language was sent, never answered, and may still run. */
  private pending(): boolean {
    const m = this.marker();
    return !!m && m.to !== undefined && m.until !== undefined && this.clock() < m.until;
  }

  private clock(): number {
    return (this.env.now ?? Date.now)();
  }

  private tellWait(on: boolean): void {
    for (const f of this.waits)
      try {
        f(on);
      } catch {
        /* the listener's own problem */
      }
  }

  /**
   * Learns the user's own language, under the lock and with nothing of this session switched: a marker left by a
   * switch that never finished names it while the user is still in the language it switched to (and that switch
   * is repaired now; one that may still run is waited out first, calm); otherwise it is the language Dataverse has
   * (a marker that is no longer true goes, and one from long ago is never acted on here: recover() asked about it at
   * the start).
   */
  private async adopt(): Promise<void> {
    await this.calm();
    await this.settle();
    const m = this.marker();
    const now = await this.readUi();
    const say = m ? markerSays(m, now, this.clock()) : 'clear';
    if (m && say === 'repair') {
      this.orig = m.lcid;
      this.dirty = true;
      await this.settle();
    } else if (m && say === 'wait') {
      // Another tab's switch in flight, seen without Web Locks: its marker stays, and names the user's language.
      this.orig = m.lcid;
    } else {
      if (m) this.unmark();
      this.orig = now;
    }
  }

  private readUi(): Promise<Lcid> {
    return readUi(this.ctx);
  }

  /** The repair marker, or null. */
  private marker(): Marker | null {
    return readMarker(this.ctx, this.env);
  }

  /** Confirms the server now answers in `lcid` (run()'s switch is a separate request). */
  private async confirm(lcid: Lcid): Promise<void> {
    for (let i = 0; i < 8; i++) {
      const r = await this.ctx.http.get(PROBE.url, { headers: { ...PROBE.headers, 'If-None-Match': 'null' } }).then(
        (data) => ({ ok: true, status: 200, data, headers: {} }),
        () => undefined,
      );
      if (probeSays(r, lcid, this.ctx.base)) return;
      await (this.env.sleep ?? sleep)(250 * (i + 1));
    }
    throw new DvError(`Dataverse did not switch to language ${lcid} in time. Nothing was saved for that language.`, 0, 'langswitch');
  }

  /**
   * Writes the repair marker: the user's own language `lcid`, `to`, the language Dataverse is being switched to, and
   * `until`, while a request of that switch is sent and not answered.
   */
  private mark(lcid: Lcid, to: Lcid, until?: number): void {
    try {
      this.env.storage?.setItem(KEY(this.ctx), JSON.stringify(until ? { lcid, to, at: this.clock(), until } : { lcid, to, at: this.clock() }));
    } catch {
      /* storage blocked: the batch switches back server-side, and the check after it still applies */
    }
  }

  private unmark(): void {
    try {
      this.env.storage?.removeItem(KEY(this.ctx));
    } catch {
      /* ignore */
    }
  }

  /** Last-chance restore when the page goes away while run() keeps the user switched; keepalive lets it finish. */
  private restoreOnUnload(): void {
    if (this.running === null) return;
    try {
      fetch(`${this.ctx.http.api}${us(this.ctx)}`, {
        method: 'PATCH',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'OData-Version': '4.0', 'OData-MaxVersion': '4.0', 'x-ms-sw-skipcache': '1' },
        body: JSON.stringify({ uilanguageid: this.orig }),
      });
    } catch {
      /* the localStorage marker repairs it on the next start */
    }
  }

  /**
   * Repairs a language left switched by an interrupted run (tab closed, crash): only while the user is still in
   * the language it switched to (markerSays), and after asking (`ask`, which may show a dialog) when that switch
   * was long ago. Returns the restored LCID, or 0 when nothing was repaired. A marker whose request may still run
   * (sent, never answered: markerSays 'wait') is left alone: the session waits it out before anything else (calm).
   */
  static async recover(ctx: Ctx, env: LangEnv = defaultEnv(), ask: (m: Marker, now: Lcid) => boolean | Promise<boolean> = () => false): Promise<Lcid> {
    // No marker, nothing to wait for. With one, wait for the lock: the tab that set it may be in a switch
    // right now and clears it when done. Not for one whose request may still run: nothing is repaired before it can't
    // (the session waits it out under the lock, calm), and the session that holds the lock meanwhile may hold it for
    // minutes, which would keep this translator from opening.
    const m0 = readMarker(ctx, env);
    if (m0 === null || (m0.until !== undefined && (env.now ?? Date.now)() < m0.until)) return 0;
    const job = async (): Promise<Lcid> => {
      const m = readMarker(ctx, env);
      const at = (env.now ?? Date.now)();
      if (m === null || (m.until !== undefined && at < m.until)) return 0;
      let fixed = 0;
      const now = await readUi(ctx);
      const say = markerSays(m, now, at);
      if (say === 'repair' || (say === 'ask' && (await ask(m, now)))) {
        await ctx.http.patch(us(ctx), { uilanguageid: m.lcid });
        // Keep the marker (the next start tries again) unless the language is confirmed back.
        if ((await readUi(ctx)) !== m.lcid) throw new DvError(`Your Dynamics language could not be switched back to ${lcidName(m.lcid)}.`, 0, 'langrestore');
        fixed = m.lcid;
      }
      try {
        env.storage?.removeItem(KEY(ctx));
      } catch {
        /* ignore */
      }
      return fixed;
    };
    if (!env.locks) return job();
    let ran = false;
    try {
      return (await env.locks.request(LOCK(ctx), { mode: 'exclusive' }, () => ((ran = true), job()))) as Lcid;
    } catch (e) {
      // The browser refused the lock itself: repair without it.
      if (ran) throw e;
      return job();
    }
  }
}

/**
 * The user's UI language as stored now. `no-store` (Http) and `If-None-Match: null` keep the browser from
 * answering from its cache; `x-ms-sw-skipcache` (Http) keeps UCI's service worker from answering from its data
 * cache (it caches usersettingscollection for API v9.0 URLs).
 */
async function readUi(ctx: Ctx): Promise<Lcid> {
  const r = await ctx.http.get(`${us(ctx)}?$select=uilanguageid`, { headers: { 'If-None-Match': 'null', 'x-ms-sw-skipcache': '1' } });
  const lcid = Number(r?.uilanguageid);
  if (!(lcid > 0)) throw new DvError('Dataverse did not say which language your Dynamics is in.', 0, 'langread');
  return lcid;
}

/**
 * The repair marker, as far as it can be true. Any script of the site can write localStorage, and a clock can be set back:
 * a language this environment doesn't have is never switched to (no marker), and an `until` no switch could have written
 * (more than LOST_MS after the marker's time, or after now) is left out, so it never holds saves back past LOST_MS.
 */
function readMarker(ctx: Ctx, env: LangEnv): Marker | null {
  try {
    const v = JSON.parse(env.storage?.getItem(KEY(ctx)) || 'null');
    if (!(v && Number(v.lcid) > 0)) return null;
    const known = (l: number) => !ctx.langs?.length || ctx.langs.some((x) => x.lcid === l);
    if (!known(Number(v.lcid)) || (Number(v.to) > 0 && !known(Number(v.to)))) return null;
    const m: Marker = { lcid: Number(v.lcid), to: Number(v.to) > 0 ? Number(v.to) : undefined, at: Number(v.at) || 0 };
    const until = Number(v.until);
    const slack = 60_000;
    if (until > 0 && until <= m.at + LOST_MS + slack && until <= (env.now ?? Date.now)() + LOST_MS + slack) m.until = until;
    return m;
  } catch {
    return null;
  }
}
