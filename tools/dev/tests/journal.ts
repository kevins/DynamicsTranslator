// The undo journal (core/history.ts, Recent publishes): kept per org and user, for 90 days, in localStorage.
import { addHistory, markPublished, markUndone, readHistory } from '../../../src/core/history';
import type { HistoryEntry, HistoryItem } from '../../../src/ui/types';
import type { Kit } from './kit';

const DAY = 86_400_000;

/** Runs `fn` with an in-memory localStorage (Node has none); `mem` is what it stores. */
async function withStorage(fn: (mem: Map<string, string>) => unknown, storage?: object): Promise<void> {
  const g = globalThis as { localStorage?: unknown };
  const had = Object.getOwnPropertyDescriptor(g, 'localStorage');
  const mem = new Map<string, string>();
  const value = storage ?? { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) };
  Object.defineProperty(g, 'localStorage', { configurable: true, value });
  try {
    await fn(mem);
  } finally {
    if (had) Object.defineProperty(g, 'localStorage', had);
    else delete g.localStorage;
  }
}

/** Web Locks (navigator.locks) as a browser has them, granted in request order, only when the test says (grant()). */
function fakeLocks(refuse = false) {
  const queue: Array<() => void> = [];
  const names: string[] = [];
  const locks = {
    request(name: string, fn: () => unknown): Promise<unknown> {
      names.push(name);
      if (refuse) return Promise.reject(new Error('SecurityError: the lock was refused'));
      return new Promise((resolve, reject) =>
        queue.push(() => {
          try {
            resolve(fn());
          } catch (e) {
            reject(e);
          }
        }),
      );
    },
  };
  return { locks, names, grant: () => void queue.splice(0).forEach((go) => go()) };
}

/** Runs `fn` with `locks` as navigator.locks (Node has none). */
async function withLocks(locks: object, fn: () => unknown): Promise<void> {
  const g = globalThis as { navigator?: Record<string, unknown> };
  const nav = g.navigator;
  const had = nav && Object.getOwnPropertyDescriptor(nav, 'locks');
  if (nav) Object.defineProperty(nav, 'locks', { configurable: true, value: locks });
  else g.navigator = { locks };
  try {
    await fn();
  } finally {
    if (!nav) delete g.navigator;
    else if (had) Object.defineProperty(nav, 'locks', had);
    else delete nav.locks;
  }
}

/** A save of the French name of Account Name, `before` → `after`, made at `at`. */
const save = (id: string, at: number, before = 'Nom', after = 'Nom du compte'): HistoryEntry => ({
  id,
  at,
  published: true,
  items: [{ key: 'attribute|account.name|DisplayName', comp: 'attribute|account.name', kind: 'attribute', lcid: 1036, title: 'Account Name', before, after }],
});
const ids = (l: HistoryEntry[]) => l.map((e) => e.id);
/** Everything the storage holds, as one string. */
const dump = (mem: Map<string, string>) => [...mem.entries()].join('\n');

export function register(t: Kit): void {
  const alice = { orgId: 'org', userId: 'alice' } as never;
  const bob = { orgId: 'org', userId: 'bob' } as never;

  t.test('journal: another account signed in to the same browser profile never sees, publishes or undoes your saves in Recent publishes', () =>
    withStorage(async () => {
      t.ok(await addHistory(alice, save('a1', Date.now(), 'Texte interne', 'Nouveau texte')));
      t.eq(readHistory(bob), [], "Bob's Recent publishes");
      await addHistory(bob, save('b1', Date.now()));
      t.eq([ids(readHistory(alice)), ids(readHistory(bob))], [['a1'], ['b1']]);
      // What Bob's dialog does to an id never touches Alice's journal.
      await markPublished(bob, ['a1'], false);
      await markUndone(bob, 'a1');
      const [a] = readHistory(alice);
      t.eq([a.published, a.undoneAt, a.items[0].after], [true, undefined, 'Nouveau texte']);
      // Another org of the same user is another journal, as before.
      t.eq(readHistory({ orgId: 'other', userId: 'alice' } as never), []);
    }),
  );

  t.test('journal: a save older than 90 days leaves the journal and the storage, texts included; newer ones stay', () =>
    withStorage(async (mem) => {
      const now = Date.now();
      await addHistory(alice, save('recent', now - 89 * DAY));
      // Each change of the journal leaves the expired ones out as it writes it.
      await addHistory(alice, save('old', now - 91 * DAY, 'Ancien texte', 'Texte remplacé'));
      await addHistory(alice, save('epoch', 0, 'Texte de 1970', 'Autre'));
      t.eq(ids(readHistory(alice)), ['recent']);
      t.ok(!/Ancien texte|Texte remplacé|Texte de 1970/.test(dump(mem)), `still stored:\n${dump(mem)}`);
      // A journal left with nothing leaves no key behind.
      await withStorage(async (m2) => {
        await addHistory(alice, save('old', now - 100 * DAY));
        t.eq([readHistory(alice), [...m2.keys()]], [[], []]);
      });
      // One that expired while stored leaves on the next read.
      mem.set('dxt:history:org:alice', JSON.stringify([save('recent', now - 89 * DAY), save('stale', now - 95 * DAY, 'Texte expiré')]));
      t.eq(ids(readHistory(alice)), ['recent']);
      t.ok(!/Texte expiré/.test(dump(mem)), dump(mem));
    }),
  );

  t.test('journal: the journal kept per org before (shared by every account) is removed unread: nothing tells whose saves it holds, so no account that opens the translator next is shown their texts or offered their Undo', () =>
    withStorage(async (mem) => {
      const now = Date.now();
      mem.set('dxt:history:org', JSON.stringify([save('l2', now - DAY, 'Texte de Marie', 'Nouveau de Marie'), save('l1', now - 3 * DAY), save('gone', now - 200 * DAY, 'Très ancien')]));
      await addHistory(alice, save('a1', now - 2 * 3_600_000));
      t.eq(ids(readHistory(alice)), ['a1'], 'only her own saves');
      t.ok(!mem.has('dxt:history:org') && !/Texte de Marie|Très ancien/.test(dump(mem)), dump(mem));
      t.eq(readHistory(bob), [], 'nor the next account');
      // An earlier version still open in another tab writes the old key again: removed again on the next read, never merged.
      mem.set('dxt:history:org', JSON.stringify([save('l3', now - 3_600_000, 'Texte partagé')]));
      t.eq(ids(readHistory(bob)), []);
      t.eq(ids(readHistory(alice)), ['a1']);
      t.ok(!mem.has('dxt:history:org') && !/Texte partagé/.test(dump(mem)), dump(mem));
    }),
  );

  t.test("journal: two tabs of one user changing the journal at the same moment keep every change: each reads and writes it under one Web Lock (by org and user), so a list read before another tab's write is never written back over it", () =>
    withStorage(async (mem) => {
      const KEY = 'dxt:history:org:alice';
      const now = Date.now();
      const L = fakeLocks();
      await withLocks(L.locks, async () => {
        // Tab A adds its save; the lock isn't granted yet, so nothing is read or written yet.
        const a = addHistory(alice, save('a1', now - 2000));
        // Meanwhile tab B (an earlier version, without the lock) writes its own save.
        mem.set(KEY, JSON.stringify([save('b1', now - 1000)]));
        // Tab A's Publish dialog marks that one unpublished; Bob saves in his own journal (another lock).
        const p = markPublished(alice, ['b1'], false);
        const b = addHistory(bob, save('x1', now));
        t.eq(ids(JSON.parse(mem.get(KEY)!)), ['b1'], 'nothing written before the lock is granted');
        L.grant();
        t.eq([await a, await p, await b], [true, undefined, true]);
        t.eq(readHistory(alice).map((e) => [e.id, e.published]), [['a1', true], ['b1', false]], "tab B's save kept, and its mark");
        t.eq(L.names, [KEY, KEY, 'dxt:history:org:bob']);
        // Saves of both tabs asked together, and an undo: all kept, in the order asked.
        const two = [addHistory(alice, save('a2', now + 1)), addHistory(alice, save('b2', now + 2)), markUndone(alice, 'a1', 1)];
        L.grant();
        await Promise.all(two);
        t.eq(readHistory(alice).map((e) => [e.id, e.undoneAt !== undefined]), [['b2', false], ['a2', false], ['a1', true], ['b1', false]]);
      });
      // A browser that refuses the lock: the change is made at once, without it.
      await withLocks(fakeLocks(true).locks, async () => {
        t.ok(await addHistory(alice, save('a3', now + 3)));
        await markPublished(alice, ['a3'], false);
      });
      t.eq(readHistory(alice).map((e) => [e.id, e.published]).slice(0, 2), [['a3', false], ['b2', true]]);
    }),
  );

  t.test("journal: without Web Locks, another tab's save written between this tab's read of the journal and its write is kept: the journal is read again before writing, and edited again from what changed", async () => {
    const mem = new Map<string, string>();
    /** Runs once, inside the next read of the journal, after the value was read (another tab writing right then). */
    let between: (() => void) | null = null;
    const storage = {
      getItem: (k: string) => {
        const v = mem.get(k) ?? null;
        const f = between;
        between = null;
        f?.();
        return v;
      },
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
    };
    await withStorage(async () => {
      const now = Date.now();
      let b: Promise<boolean> | undefined;
      between = () => (b = addHistory(alice, save('b1', now - 1000)));
      const a = addHistory(alice, save('a1', now));
      t.eq([await a, await b], [true, true]);
      t.eq(ids(readHistory(alice)), ['a1', 'b1'], 'both saves kept');
      between = () => void markUndone(alice, 'b1');
      await markPublished(alice, ['a1'], false);
      t.eq(readHistory(alice).map((e) => [e.id, e.published, e.undoneAt !== undefined]), [['a1', false, false], ['b1', true, true]]);
    }, storage);
  });

  t.test('journal: what a label costs (its place included, which Recent publishes shows); past ~400 KB the oldest saves leave first, never the newest; one save alone may pass the budget up to its 1.5 MB ceiling, not beyond', () =>
    withStorage(async (mem) => {
      const G = '5e07410a-0000-4000-8000-000000000071';
      /** A form cell's French label, as the Publish dialog journals it: its place on the form included. */
      const cell = (i: number, text = 'Nom du compte'): HistoryItem => ({
        key: `field|${G}|${G.slice(0, -3)}${String(i).padStart(3, '0')}|Label`,
        comp: `field|${G}|${G.slice(0, -3)}${String(i).padStart(3, '0')}`,
        kind: 'field',
        lcid: 1036,
        title: 'Account Name',
        where: 'Account (Main form) › General › Details',
        before: 'Nom',
        after: text,
      });
      const column: HistoryItem = { key: 'attribute|account.name|DisplayName', comp: 'attribute|account.name', kind: 'attribute', lcid: 1036, title: 'Account Name', where: 'Account', before: 'Nom', after: 'Nom du compte' };
      // history.ts: ~200–350 characters a label with short texts; the place is a small part of it.
      const sizes = [cell(0), column].map((x) => JSON.stringify(x).length);
      t.ok(sizes[0] <= 350 && sizes[1] >= 150 && sizes[1] <= 200, `sizes ${sizes}`);
      t.ok(JSON.stringify(cell(0)).length - JSON.stringify({ ...cell(0), where: undefined }).length <= 60, 'a place costs ~50 characters');
      const KEY = 'dxt:history:org:alice';
      const at = Date.now() - 3_600_000;
      for (let s = 0; s < 50; s++) t.ok(await addHistory(alice, { id: `s${s}`, at: at + s, published: true, items: Array.from({ length: 30 }, (_, i) => cell(i)) }), `save ${s}`);
      const kept = ids(readHistory(alice));
      t.ok(mem.get(KEY)!.length <= 400_000, String(mem.get(KEY)!.length));
      t.ok(kept.length > 30 && kept.length < 50, `${kept.length} saves kept`);
      t.eq(kept, Array.from({ length: kept.length }, (_, i) => `s${49 - i}`), 'the newest, newest first');
      // A bulk import's save over the budget is kept alone; one over the ceiling is refused, and the journal stays as it was.
      const big = (id: string, n: number): HistoryEntry => ({ id, at: Date.now(), published: true, items: Array.from({ length: n }, (_, i) => cell(i, 'x'.repeat(200))) });
      t.ok(await addHistory(alice, big('bulk', 2_000)));
      t.eq([ids(readHistory(alice)), mem.get(KEY)!.length > 400_000], [['bulk'], true]);
      const before = mem.get(KEY);
      t.eq([await addHistory(alice, big('huge', 5_000)), mem.get(KEY) === before], [false, true]);
    }),
  );

  t.test("journal: a save too large to keep with the places Recent publishes shows (past the 1.5 MB ceiling, or the browser's quota) is kept without them, as before places were kept, so it can still be undone", async () => {
    const G = '5e07410a-0000-4000-8000-000000000071';
    // A form cell's key: the form's id and the cell's.
    const cell = (i: number): HistoryItem => ({
      key: `field|${G}|${G.slice(0, -4)}${String(i).padStart(4, '0')}|Label`,
      comp: `field|${G}|${G.slice(0, -4)}${String(i).padStart(4, '0')}`,
      kind: 'field',
      lcid: 1036,
      title: 'Account Name',
      where: 'Account (Main form) › General › Details',
      before: 'Nom',
      after: 'Nom du compte',
    });
    const bulk = (id: string, n: number): HistoryEntry => ({ id, at: Date.now(), published: true, items: Array.from({ length: n }, (_, i) => cell(i)) });
    const lean = (e: HistoryEntry) => JSON.stringify([{ ...e, items: e.items.map(({ where: _, ...it }) => it) }]).length;
    // 5,000 form cells of a bulk import: over the ceiling with their places, under it without.
    const big = bulk('bulk', 5_000);
    t.ok(JSON.stringify([big]).length > 1_500_000 && lean(big) < 1_500_000, `${JSON.stringify([big]).length} / ${lean(big)}`);
    await withStorage(async (mem) => {
      await addHistory(alice, save('a1', Date.now() - 3_600_000));
      t.ok(await addHistory(alice, big), 'journaled');
      const [e, ...rest] = readHistory(alice);
      t.eq([e.id, e.items.length, e.items.some((it) => 'where' in it), e.items[4_999].after, rest.length], ['bulk', 5_000, false, 'Nom du compte', 0]);
      t.ok(mem.get('dxt:history:org:alice')!.length <= 1_500_000);
    });
    // Under the ceiling, but over what the browser's storage takes: the same.
    const mem = new Map<string, string>();
    const quota = { getItem: (k: string) => mem.get(k) ?? null, removeItem: (k: string) => void mem.delete(k), setItem: (k: string, v: string) => {
      if (v.length > 1_200_000) throw new Error('QuotaExceededError');
      mem.set(k, v);
    } };
    await withStorage(async () => {
      const mid = bulk('mid', 4_000);
      t.ok(JSON.stringify([mid]).length > 1_200_000 && lean(mid) < 1_200_000);
      t.ok(await addHistory(alice, mid), 'journaled');
      t.eq(readHistory(alice).map((e) => [e.id, e.items.length, e.items.some((it) => 'where' in it)]), [['mid', 4_000, false]]);
      // A save that fits keeps its places.
      t.ok(await addHistory(alice, bulk('small', 10)));
      t.eq(readHistory(alice)[0].items[0].where, 'Account (Main form) › General › Details');
    }, quota);
  });

  t.test('journal: blocked storage reads as empty and refuses to journal; a storage without removeItem still drops expired saves from what it shows', async () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    await withStorage(async () => {
      t.eq([readHistory(alice), await addHistory(alice, save('a1', Date.now()))], [[], false]);
    }, blocked);
    const mem = new Map<string, string>();
    await withStorage(async () => {
      await addHistory(alice, save('old', Date.now() - 91 * DAY));
      await addHistory(alice, save('new', Date.now()));
      t.eq(ids(readHistory(alice)), ['new']);
    }, { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) });
  });
}
