// Unit tests for a language switch whose answer was lost (core/langsession.ts `doubtful`): the
// switching batch may not have run yet, or be running, so nothing language-sensitive runs (writes, new switch
// windows, quiet() jobs, in this tab or another) until it is seen to end or can no longer run (LOST_MS); a caller
// can stop waiting, the session can't; the marker carries `until` across a reload. Dataverse is a small fake on a
// fake clock: what it runs late is scheduled on that clock, which moves only while the session waits.
import { DvError, Http, type BatchPart, type PartResult } from '../../../src/core/http';
import { LangSession, LOST_MS, markerSays, PROBE, WAITING, type LangEnv } from '../../../src/core/langsession';
import type { Lcid } from '../../../src/core/model';
import { createSaver } from '../../../src/core/saver';
import { Store } from '../../../src/core/store';
import { markerKey } from '../../../src/core/uilang';
import type { Writer } from '../../../src/providers/types';
import type { Kit } from './kit';

const EN = 1033;
const FR = 1036;
const DE = 1031;
const MARK = markerKey('o', 'u');
// setImmediate: a wait of 150 s on the fake clock is a few hundred turns, never clamped like nested timers.
const tick = () => new Promise<void>((r) => setImmediate(r));
const lostError = () => new DvError('Could not reach Dataverse (network error).', 0, 'network');

function world(ui: Lcid = FR) {
  const W = {
    ui,
    clock: 0,
    /** What the server ran: "<time> ui <lcid>" for a language change, "<time> <method> <url> in <lcid>" for work. */
    log: [] as string[],
    /** Work parts: [url, the language it ran in, when]. */
    ran: [] as Array<[string, Lcid, number]>,
    events: [] as Array<{ at: number; run: () => void }>,
    /** The next switching batches lose their answer; `plan` says what the server does with them. */
    lose: 0,
    plan: null as null | ((parts: BatchPart[]) => void),
    /** How long Http holds a batch whose answer is lost before it really sends it (a write slot, throttled answers retried). */
    delay: 0,
    /** The next plain PATCHes of the language lose their answer; `patchPlan` says what the server does with them. */
    losePatch: 0,
    patchPlan: null as null | ((body: unknown) => void),
    /** While set, the session's waits stop moving the clock (the test looks at it in the middle). */
    gate: null as Promise<void> | null,
    storage: new Map<string, string>(),
    http: null as any,
  };
  const ok = (data: unknown = null, status = 200): PartResult => ({ ok: true, status, data, headers: {} });
  const exec = (p: BatchPart): PartResult => {
    if (p.url.startsWith('usersettingscollection(u)')) {
      if (p.method === 'GET') return ok({ uilanguageid: W.ui });
      W.ui = (p.body as { uilanguageid: Lcid }).uilanguageid;
      W.log.push(`${W.clock} ui ${W.ui}`);
      return ok(null, 204);
    }
    if (p.url === PROBE.url) return ok({ DisplayName: { LocalizedLabels: [{ Label: 'User', LanguageCode: EN }, { Label: 'Utilisateur', LanguageCode: FR }], UserLocalizedLabel: { Label: '?', LanguageCode: W.ui } } });
    W.ran.push([p.url, W.ui, W.clock]);
    W.log.push(`${W.clock} ${p.method} ${p.url} in ${W.ui}`);
    return ok(null, 204);
  };
  W.http = {
    api: 'https://org.test/api/data/v9.2/',
    stats: { requests: 0, failures: 0, ms: 0 },
    async get(url: string) {
      await tick();
      return exec({ method: 'GET', url }).data;
    },
    async patch(url: string, body: unknown, o?: { onSend?: () => void }) {
      await tick();
      o?.onSend?.();
      if (W.losePatch > 0 && url.startsWith('usersettings')) {
        W.losePatch--;
        W.patchPlan?.(body);
        throw lostError();
      }
      exec({ method: 'PATCH', url, body });
      return {};
    },
    async all() {
      return [];
    },
    async post() {
      return {};
    },
    async batch(parts: BatchPart[], o?: { onSend?: () => void }) {
      await tick();
      if (parts[0]?.url.startsWith('usersettings') && W.lose > 0) {
        W.lose--;
        if (W.delay) advance(W.delay);
        o?.onSend?.();
        W.plan?.(parts);
        throw lostError();
      }
      o?.onSend?.();
      return parts.map(exec);
    },
  };
  /** Moves the clock on, running what the server does meanwhile. */
  const advance = (ms: number) => {
    const to = W.clock + ms;
    for (;;) {
      W.events.sort((a, b) => a.at - b.at);
      const e = W.events[0];
      if (!e || e.at > to) break;
      W.events.shift();
      W.clock = Math.max(W.clock, e.at);
      e.run();
    }
    W.clock = to;
  };
  /** At `at`, the server runs these parts like a $batch, each `step` ms after the one before (`skip`: parts it fails). */
  const later = (parts: BatchPart[], at: number, step = 0, skip: number[] = []) =>
    parts.forEach((p, i) => W.events.push({ at: at + i * step, run: () => void (skip.includes(i) ? W.log.push(`${W.clock} part ${i} failed`) : exec(p)) }));
  const at = (t: number, run: () => void) => W.events.push({ at: t, run });
  const storage = { getItem: (k: string) => W.storage.get(k) ?? null, setItem: (k: string, v: string) => void W.storage.set(k, v), removeItem: (k: string) => void W.storage.delete(k) };
  const locks = memLocks();
  const env: LangEnv = {
    storage,
    locks,
    now: () => W.clock,
    sleep: async (ms: number) => {
      while (W.gate) await W.gate;
      advance(ms);
      await tick();
    },
  };
  const ctx = { http: W.http, xrm: null, origin: 'https://org.test', org: 'org', orgId: 'o', envType: '', userId: 'u', base: EN, user: ui, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }], version: '9.2' };
  /** A session: this tab's first, or another tab's (its own context, the same server, storage and Web Locks). */
  const session = (onChange: (l: Lcid | null) => void = () => {}) => new LangSession({ ...ctx } as never, onChange, env);
  const marker = () => JSON.parse(W.storage.get(MARK) || 'null') as { lcid: Lcid; to: Lcid; until?: number } | null;
  return { W, env, ctx, session, later, at, marker, advance };
}

/** Web Locks for the "tabs" of a test: exclusive and shared, in request order; a request whose signal aborts while it waits leaves. */
function memLocks() {
  const held = new Map<string, { x: number; s: number }>();
  const queues = new Map<string, Array<{ x: boolean; go: () => void }>>();
  const state = (n: string) => held.get(n) ?? (held.set(n, { x: 0, s: 0 }), held.get(n)!);
  const fits = (n: string, x: boolean) => (x ? state(n).x + state(n).s === 0 : state(n).x === 0);
  const take = (n: string, x: boolean) => void (x ? state(n).x++ : state(n).s++);
  const grant = (n: string, q: Array<{ x: boolean; go: () => void }>) => {
    while (q.length && fits(n, q[0].x)) {
      const w = q.shift()!;
      take(n, w.x);
      w.go();
    }
  };
  return {
    async request(name: string, o: { signal?: AbortSignal; mode?: 'shared' | 'exclusive' }, fn: () => Promise<unknown>) {
      const x = o.mode !== 'shared';
      if (o.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const q = queues.get(name) ?? (queues.set(name, []), queues.get(name)!);
      if (q.length || !fits(name, x))
        await new Promise<void>((go, fail) => {
          const drop = () => {
            q.splice(q.indexOf(w), 1);
            grant(name, q);
            fail(new DOMException('aborted', 'AbortError'));
          };
          const w = { x, go: () => (o.signal?.removeEventListener('abort', drop), go()) };
          q.push(w);
          o.signal?.addEventListener('abort', drop, { once: true });
        });
      else take(name, x);
      try {
        return await fn();
      } finally {
        const h = state(name);
        if (x) h.x--;
        else h.s--;
        grant(name, q);
      }
    },
  };
}

const write = (url: string): BatchPart[] => [{ method: 'PATCH', url, body: {} }];
const uiChanges = (log: string[]) => log.filter((l) => / ui \d+$/.test(l));
const when = (W: { ran: Array<[string, Lcid, number]> }, url: string) => W.ran.find(([u]) => u === url);

export function register(t: Kit): void {
  t.test('lang doubt: markerSays waits while a sent and unanswered switch may still run, and says what it did before once it can no longer run', () => {
    const m = { lcid: FR, to: EN, at: 0, until: LOST_MS };
    t.eq([markerSays(m, FR, 1000), markerSays(m, EN, 1000), markerSays(m, FR, LOST_MS), markerSays(m, EN, LOST_MS), markerSays({ lcid: FR, to: EN, at: 0 }, EN, 1000)], ['wait', 'wait', 'clear', 'repair', 'repair']);
    t.eq(LOST_MS, 150_000, "Dataverse's 2-minute request timeout and 30 s more");
  });

  t.test('lang doubt: a lost switching batch the server runs before its answer is lost, or 10.75 s later between two reads (never seen): nothing language-sensitive runs before it can no longer run; then the next write runs in French and the marker goes', async () => {
    for (const late of [0, 10_750]) {
      const { W, session, later, at, marker } = world();
      const lang = session();
      W.lose = 1;
      let sent = false;
      W.plan = (parts) => ((sent = true), later(parts, W.clock + late));
      const seen: Array<[number, boolean]> = [];
      for (const s of [5_000, 60_000, 149_000]) at(s, () => seen.push([s, (marker()?.until ?? 0) > s]));
      let err: unknown;
      const a = lang.hold((h) => h.batch(EN, write('x'))).catch((e) => (err = e));
      while (!sent) await tick();
      // Then: a write in the user's own language, and a column write (quiet).
      const b = lang.hold((h) => h.batch(FR, write('y')));
      let quietAt = -1;
      const c = lang.quiet(async () => void (quietAt = W.clock));
      await Promise.all([a, b, c]);
      t.ok(err instanceof DvError && err.code === 'network', String(err));
      t.eq(when(W, 'x'), ['x', EN, late], 'the lost batch ran in English');
      const y = when(W, 'y')!;
      t.eq([y[1], y[2] >= LOST_MS, quietAt >= LOST_MS], [FR, true, true], `the write and the quiet job waited until it could no longer run (late ${late}): ${W.log.join(' | ')}`);
      t.eq(seen.map(([, m]) => m), [true, true, true], 'the marker said until when, all along');
      t.eq(uiChanges(W.log), [`${late} ui ${EN}`, `${late} ui ${FR}`], 'only the batch itself changed the language: never set back by hand in the middle of it');
      t.eq([W.ui, marker(), lang.active, lang.waiting], [FR, null, false, false]);
    }
  });

  t.test('lang doubt: a lost batch seen to switch and switch back ends the wait early; the next write runs in French after its switch back', async () => {
    const { W, session, later, marker } = world();
    const lang = session();
    W.lose = 1;
    // Starts 20 s later; its parts 1 s apart, so the reads every 1.5 s see it switched.
    W.plan = (parts) => later(parts, W.clock + 20_000, 1_000);
    const a = lang.hold((h) => h.batch(EN, write('x'))).catch(() => {});
    const b = lang.hold((h) => h.batch(FR, write('y')));
    await Promise.all([a, b]);
    const [x, y] = [when(W, 'x')!, when(W, 'y')!];
    t.eq([x[1], y[1]], [EN, FR]);
    t.ok(y[2] > 24_000 && y[2] < 30_000, `after its switch back (24 s), long before LOST_MS: ${y[2]}`);
    t.eq([W.ui, marker(), lang.active], [FR, null, false]);
  });

  t.test("lang doubt: a seen switch whose switch back failed is set back only once the batch can't run any more; a third language chosen elsewhere meanwhile is kept", async () => {
    {
      const { W, session, later, marker } = world();
      const lang = session();
      W.lose = 1;
      // Its last part (the switch back) fails on the server: the user stays in English.
      W.plan = (parts) => later(parts, W.clock + 3_000, 0, [parts.length - 1]);
      const a = lang.hold((h) => h.batch(EN, write('x'))).catch(() => {});
      const b = lang.hold((h) => h.batch(FR, write('y')));
      await Promise.all([a, b]);
      const back = uiChanges(W.log);
      t.eq(back.length, 2, back.join(' | '));
      t.ok(Number(back[1].split(' ')[0]) >= LOST_MS && back[1].endsWith(`ui ${FR}`), `set back at ${back[1]}`);
      t.eq([when(W, 'y')![1], W.ui, marker()], [FR, FR, null]);
    }
    {
      const { W, session, at, marker } = world();
      const lang = session();
      W.lose = 1; // never reaches the server
      at(30_000, () => void ((W.ui = DE), W.log.push(`${W.clock} ui ${DE} (elsewhere)`)));
      await lang.hold((h) => h.batch(EN, write('x'))).catch(() => {});
      t.eq([W.ui, uiChanges(W.log), marker(), lang.active], [DE, [], null, false], 'German kept, never set back');
    }
  });

  t.test('lang doubt: Stop frees every caller at once (the batch, a queued hold, quiet, restore), nothing more is written, and the session goes on waiting until the batch can no longer run', async () => {
    const { W, session, at, marker } = world();
    const events: boolean[] = [];
    const lang = session();
    lang.onWait((w) => events.push(w));
    W.lose = 1; // never reaches the server
    const ac = new AbortController();
    let release!: () => void;
    // At 5 s the user stops; the session's clock then stands still while the test looks.
    at(5_000, () => {
      W.gate = new Promise<void>((r) => (release = r));
      ac.abort();
    });
    let err: unknown;
    let wrote = false;
    await lang
      .hold(async (h) => {
        await h.batch(EN, write('x'));
      }, ac.signal)
      .catch((e) => (err = e));
    t.ok(err instanceof DvError && err.code === 'network', `the batch's own error, once the wait was stopped: ${String(err)}`);
    t.eq([lang.waiting, W.clock < LOST_MS, (marker()?.until ?? 0) > W.clock], [true, true, true], 'still waiting, the marker kept');
    const out = await Promise.all([
      lang.hold(async () => void (wrote = true), ac.signal).then(() => 'ran', (e) => e.name),
      lang.quiet(async () => void (wrote = true), ac.signal).then(() => 'ran', (e) => e.name),
      lang.restore(ac.signal).then(() => 'done', (e) => e.name),
    ]);
    t.eq([out, wrote, events], [['AbortError', 'AbortError', 'AbortError'], false, [true]]);
    // A later caller without a stop waits for the end.
    let yAt = -1;
    const next = lang.hold((h) => h.batch(FR, write('y')).then(() => void (yAt = W.clock)));
    W.gate = null;
    release();
    await next;
    t.ok(yAt >= LOST_MS, `ran once it could no longer run: ${yAt}`);
    t.eq([events, W.ui, marker(), lang.waiting], [[true, false], FR, null, false]);
  });

  t.test("lang doubt: inside the hold whose batch was lost, its next batch and its window wait too; the hold's signal ends those waits, never the session's", async () => {
    const { W, session, at } = world();
    const lang = session();
    W.lose = 1;
    const ac = new AbortController();
    let release!: () => void;
    at(3_000, () => {
      W.gate = new Promise<void>((r) => (release = r));
      ac.abort();
    });
    const got: string[] = [];
    await lang.hold(async (h) => {
      await h.batch(EN, write('x')).catch((e) => got.push(e.code));
      await h.window(async () => void got.push('window ran')).catch((e) => got.push(e.name));
      await h.batch(FR, write('y')).catch((e) => got.push(e.name));
    }, ac.signal);
    t.eq([got, W.ran.length, lang.waiting], [['network', 'AbortError', 'AbortError'], 0, true]);
    W.gate = null;
    release();
    await lang.restore();
    t.eq([lang.waiting, W.ui], [false, FR]);
  });

  t.test('lang doubt: another tab waits too: its quiet() and its holds start only once the batch can no longer run (the window and the lock stay held)', async () => {
    const { W, session } = world();
    const a = session();
    const b = session();
    W.lose = 1;
    let sent = false;
    W.plan = () => void (sent = true);
    const first = a.hold((h) => h.batch(EN, write('x'))).catch(() => {});
    while (!sent) await tick();
    let quietAt = -1;
    const q = b.quiet(async () => void (quietAt = W.clock));
    const y = b.hold((h) => h.batch(FR, write('y')));
    await Promise.all([first, q, y]);
    t.eq([quietAt >= LOST_MS, when(W, 'y')![2] >= LOST_MS, when(W, 'y')![1]], [true, true, FR], W.log.join(' | '));
  });

  t.test('lang doubt: after a reload the marker is honoured: recover() leaves it, the new session waits it out first (holds and quiet()), a late run of the old batch never overlaps a write, then it goes', async () => {
    const { W, env, ctx, session, later, marker } = world();
    // The page was reloaded while a switch to English was in flight (sent at 0); the translator is opened again at 30 s.
    W.storage.set(MARK, JSON.stringify({ lcid: FR, to: EN, at: 0, until: LOST_MS }));
    W.clock = 30_000;
    t.eq(await LangSession.recover(ctx as never, { ...env, locks: null }), 0);
    t.ok(marker()?.until === LOST_MS, 'recover() left it');
    // The old batch reaches the server only at 60 s.
    later([{ method: 'GET', url: 'usersettingscollection(u)?$select=uilanguageid' }, { method: 'PATCH', url: 'usersettingscollection(u)', body: { uilanguageid: EN } }, ...write('x'), { method: 'PATCH', url: 'usersettingscollection(u)', body: { uilanguageid: FR } }], 60_000);
    const lang = session();
    let quietAt = -1;
    const q = lang.quiet(async () => void (quietAt = W.clock));
    const y = lang.hold((h) => h.batch(FR, write('y')));
    await Promise.all([q, y]);
    t.eq(when(W, 'x'), ['x', EN, 60_000]);
    t.eq([when(W, 'y')![1], when(W, 'y')![2] > 60_000, quietAt > 60_000], [FR, true, true], W.log.join(' | '));
    t.eq([W.ui, marker(), lang.active], [FR, null, false]);
  });

  t.test('lang doubt: reopened once the batch can no longer run, a marker left in the language it switched to is repaired at the start as before', async () => {
    const { W, env, ctx, marker } = world(EN);
    W.storage.set(MARK, JSON.stringify({ lcid: FR, to: EN, at: 0, until: LOST_MS }));
    W.clock = LOST_MS + 1;
    t.eq(await LangSession.recover(ctx as never, { ...env, locks: null }), FR);
    t.eq([W.ui, marker()], [FR, null]);
  });

  t.test("lang doubt: run()'s switch whose answer was lost and lands after the switch back is seen and set back; the lock stays until then", async () => {
    const { W, session, at, marker } = world();
    const lang = session();
    W.losePatch = 1;
    // The lost PATCH to English lands at 40 s, long after run() switched back.
    W.patchPlan = (body) => at(40_000, () => void ((W.ui = (body as { uilanguageid: Lcid }).uilanguageid), W.log.push(`${W.clock} ui ${W.ui} (late)`)));
    let err: unknown;
    let ranFn = false;
    await lang.run(EN, async () => void (ranFn = true)).catch((e) => (err = e));
    t.ok(err instanceof DvError && !ranFn, String(err));
    let mid: unknown = 'unset';
    at(39_000, () => (mid = marker()?.until));
    const y = await lang.hold((h) => h.batch(FR, write('y')));
    t.ok(y.inLang, 'proven in French');
    const fix = W.log.findIndex((l) => l.startsWith('40000 ui 1033'));
    t.ok(fix >= 0 && W.log.slice(fix + 1).some((l) => l.endsWith(`ui ${FR}`)), `set back after it landed: ${W.log.join(' | ')}`);
    t.ok(when(W, 'y')![2] > 40_000 && when(W, 'y')![1] === FR, 'the next write waited for it');
    t.eq([mid, W.ui, marker(), lang.active], [LOST_MS, FR, null, false]);
  });

  t.test('lang doubt: a save of documents only (app navigation, processes: not under quiet()) waits for a switch in doubt too, says so, then writes', async () => {
    const { W, ctx, session } = world();
    W.storage.set(MARK, JSON.stringify({ lcid: FR, to: EN, at: 0, until: LOST_MS }));
    const lang = session();
    let wroteAt = -1;
    const writer: Writer = {
      kinds: ['subarea'],
      lane: 'doc',
      async save(_ctx, cs) {
        wroteAt = W.clock;
        return cs.map((change) => ({ change, outcome: 'saved' as const }));
      },
    };
    const store = new Store();
    store.add([t.slot('subarea', 'subarea|m|s1|Title')]);
    store.set('subarea|m|s1|Title', FR, 'Tous');
    const saver = createSaver(ctx as never, store, lang, (k) => (k === 'subarea' ? writer : undefined));
    const msgs: string[] = [];
    const rep = await saver.save(store.changes(), { signal: new AbortController().signal, publish: false, onProgress: (x) => void msgs.push(x.message) });
    t.eq([rep.saved, wroteAt >= LOST_MS, msgs.includes(WAITING), W.storage.has(MARK)], [1, true, true, false], msgs.join(' | '));
  });

  t.test('lang doubt: a save says what it waits for, Stop ends it at once with nothing written, and the session goes on waiting', async () => {
    const { W, ctx, session } = world();
    // Left by a translator that was reloaded in the middle of a switch.
    W.storage.set(MARK, JSON.stringify({ lcid: FR, to: EN, at: 0, until: LOST_MS }));
    const lang = session();
    let wrote = 0;
    const writer: Writer = {
      kinds: ['attribute'],
      lane: 'metadata',
      async save(_ctx, cs) {
        wrote++;
        return cs.map((change) => ({ change, outcome: 'saved' as const }));
      },
    };
    const store = new Store();
    store.add([t.slot('attribute', 'attribute|acc.name|DisplayName')]);
    store.set('attribute|acc.name|DisplayName', FR, 'Nom 2');
    const saver = createSaver(ctx as never, store, lang, (k) => (k === 'attribute' ? writer : undefined));
    const ac = new AbortController();
    const msgs: string[] = [];
    let release!: () => void;
    const rep = await saver.save(store.changes(), {
      signal: ac.signal,
      publish: false,
      onProgress: (x) => {
        msgs.push(x.message);
        if (x.message === WAITING && !ac.signal.aborted) {
          W.gate = new Promise<void>((r) => (release = r));
          ac.abort();
        }
      },
    });
    t.ok(msgs.includes(WAITING), msgs.join(' | '));
    t.eq([rep.skipped, rep.saved, wrote, lang.waiting, W.clock < LOST_MS], [1, 0, 0, true, true]);
    W.gate = null;
    release();
    await lang.restore();
    t.eq([lang.waiting, W.storage.has(MARK)], [false, false]);
  });

  t.test('lang doubt: a switching batch Http really sends only later (a write slot, throttled answers retried) is waited out LOST_MS after that send, and the marker says so', async () => {
    const { W, session, later, at, marker } = world();
    const lang = session();
    W.lose = 1;
    // Sent at 60 s; the server starts it 100 s after that (past 150 s from when it was handed to Http), parts 1 s apart.
    W.delay = 60_000;
    W.plan = (parts) => later(parts, W.clock + 100_000, 1_000);
    let mid: unknown = 'unset';
    at(155_000, () => (mid = marker()?.until));
    const a = lang.hold((h) => h.batch(EN, write('x'))).catch(() => {});
    const b = lang.hold((h) => h.batch(FR, write('y')));
    await Promise.all([a, b]);
    const [x, y] = [when(W, 'x'), when(W, 'y')!];
    t.ok(!!x && y[2] > x[2], `the next write waited for the late batch: ${W.log.join(' | ')}`);
    t.eq([x?.[1], y[1]], [EN, FR], W.log.join(' | '));
    t.eq([mid, W.ui, marker(), lang.active], [60_000 + LOST_MS, FR, null, false]);
  });

  t.test('lang doubt: Http says when a request really goes out, again for each try after a throttled answer', async () => {
    const g = globalThis as { fetch?: unknown };
    const had = g.fetch;
    const log: string[] = [];
    let n = 0;
    g.fetch = async () => {
      log.push('fetch');
      return n++ === 0 ? new Response('', { status: 429, headers: { 'Retry-After': '0.01' } }) : new Response(null, { status: 204 });
    };
    try {
      await new Http('https://org.test').patch('usersettingscollection(u)', { uilanguageid: EN }, { onSend: () => void log.push('send') });
      t.eq(log, ['send', 'fetch', 'send', 'fetch']);
    } finally {
      g.fetch = had;
    }
  });

  t.test("lang doubt: the translator opened again while a switch is in doubt (this tab, or another) starts at once: recover() leaves the marker without waiting for the session that waits; that session's lock keeps the new one's holds back", async () => {
    const { W, env, ctx, session, marker } = world();
    const a = session();
    W.lose = 1; // never reaches the server
    let sent = false;
    W.plan = () => void (sent = true);
    let release!: () => void;
    W.gate = new Promise<void>((r) => (release = r));
    const first = a.hold((h) => h.batch(EN, write('x'))).catch(() => {});
    while (!sent) await tick();
    let got: unknown = 'waiting';
    void LangSession.recover(ctx as never, env).then((v) => (got = v));
    for (let i = 0; i < 20; i++) await tick();
    t.eq([got, a.waiting, marker()?.until], [0, true, LOST_MS]);
    const b = session();
    let yAt = -1;
    const y = b.hold((h) => h.batch(FR, write('y')).then(() => void (yAt = W.clock)));
    W.gate = null;
    release();
    await Promise.all([first, y]);
    t.ok(yAt >= LOST_MS, `the new session's first write waited: ${yAt}`);
    t.eq([W.ui, marker()], [FR, null]);
  });

  t.test('lang doubt: Stop in another tab frees its restore() while this tab waits for a switch in doubt, also when it was stopped before', async () => {
    const { W, session } = world();
    const a = session();
    const b = session();
    W.lose = 1;
    let sent = false;
    W.plan = () => void (sent = true);
    let release!: () => void;
    W.gate = new Promise<void>((r) => (release = r));
    const first = a.hold((h) => h.batch(EN, write('x'))).catch(() => {});
    while (!sent) await tick();
    const ac = new AbortController();
    const one = b.restore(ac.signal).then(() => 'done', (e) => e.name);
    for (let i = 0; i < 5; i++) await tick();
    ac.abort();
    const two = b.restore(ac.signal).then(() => 'done', (e) => e.name);
    const out = await Promise.race([Promise.all([one, two]), (async () => {
      for (let i = 0; i < 50; i++) await tick();
      return 'still waiting';
    })()]);
    t.eq([out, a.waiting], [['AbortError', 'AbortError'], true]);
    W.gate = null;
    release();
    await first;
    await b.restore();
    t.eq([a.waiting, W.ui], [false, FR]);
  });

  t.test('lang doubt: a document save whose language switch (run) lost its answer: the next document waits until that switch is known to be over, then writes', async () => {
    const { W, ctx, session, at } = world();
    const lang = session();
    W.losePatch = 1;
    // The lost PATCH to English lands at 40 s.
    W.patchPlan = (body) => at(40_000, () => void ((W.ui = (body as { uilanguageid: Lcid }).uilanguageid), W.log.push(`${W.clock} ui ${W.ui} (late)`)));
    const wrote: Array<[string, number, Lcid]> = [];
    const writer: Writer = {
      kinds: ['subarea'],
      lane: 'doc',
      async save(_ctx, cs, o) {
        const g = cs[0].slot.group;
        if (g === 'sitemap|1') {
          // A retry in English, the way sitemap.ts and bpf.ts retry a language Dataverse did not keep.
          await o.lang.run(EN, async () => void wrote.push([g, W.clock, W.ui])).catch(() => {});
          return cs.map((change) => ({ change, outcome: 'error' as const, message: 'not kept' }));
        }
        wrote.push([g, W.clock, W.ui]);
        return cs.map((change) => ({ change, outcome: 'saved' as const }));
      },
    };
    const store = new Store();
    store.add([{ ...t.slot('subarea', 'subarea|m|s1|Title'), group: 'sitemap|1' }, { ...t.slot('subarea', 'subarea|m|s2|Title'), group: 'sitemap|2' }]);
    store.set('subarea|m|s1|Title', FR, 'Tous');
    store.set('subarea|m|s2|Title', FR, 'Autres');
    const saver = createSaver(ctx as never, store, lang, (k) => (k === 'subarea' ? writer : undefined));
    await saver.save(store.changes(), { signal: new AbortController().signal, publish: false, onProgress: () => {} });
    t.eq(wrote.map(([g]) => g), ['sitemap|2'], 'the lost switch ran nothing');
    t.ok(wrote[0][1] > 40_000 && wrote[0][2] === FR, `after the late switch was seen and set back: ${JSON.stringify(wrote)} ${W.log.join(' | ')}`);
  });
}
