// The environment the translator runs in: the page's Xrm, read live (LIVE-FINDINGS 95) and found past frames of other
// sites, whether its record has unsaved changes (core/context recordDirty, asked about by ui/refresh refreshPage), and how
// Dataverse's answers read (core/http): a collection that isn't one, and a 503 that says nothing of what ran.
import { findXrm, liveXrm, recordDirty } from '../../../src/core/context';
import { DvError, Http, mayHaveRun, partError, turnedAway } from '../../../src/core/http';
import { refreshPage, type RefreshOptions } from '../../../src/ui/refresh';
import type { Kit } from './kit';

const API = 'https://org.test/api/data/v9.2/';

/** Runs `fn` with fetch answering `answer(url, init)`; the URLs asked for are returned with what `fn` returned. */
async function withFetch<T>(answer: (url: string, init: RequestInit) => Response, fn: () => Promise<T>): Promise<{ out: T; urls: string[] }> {
  const g = globalThis as { fetch: typeof fetch };
  const real = g.fetch;
  const urls: string[] = [];
  g.fetch = (async (url: string, init: RequestInit) => (urls.push(String(url)), answer(String(url), init))) as typeof fetch;
  try {
    return { out: await fn(), urls };
  } finally {
    g.fetch = real;
  }
}
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export function register(t: Kit): void {
  t.test("context: Xrm is the page's now (another table's form has its own); while there is none, the last one seen, never the first page's", () => {
    const g = globalThis as unknown as { window?: unknown; document?: unknown };
    const had = { window: g.window, document: g.document };
    const xrm = (name: string) => ({ name, Utility: { getGlobalContext: () => ({}) } });
    const w: { Xrm?: unknown } = {};
    g.window = w;
    g.document = { querySelectorAll: () => [] };
    try {
      const account = xrm('account');
      const contact = xrm('contact');
      w.Xrm = account;
      const now = liveXrm(account);
      t.eq(now(), account);
      w.Xrm = contact;
      t.eq(now(), contact, "the contact form's own");
      w.Xrm = undefined;
      t.eq(now(), contact, 'none for a moment: still the contact form');
      t.eq(liveXrm(null)(), null, 'no client API at all');
    } finally {
      g.window = had.window;
      g.document = had.document;
    }
  });

  t.test("context: a frame of another site (it can't be looked into) is skipped; the Xrm of a later frame of this site is found", () => {
    const g = globalThis as unknown as { window?: unknown; document?: unknown };
    const had = { window: g.window, document: g.document };
    const xrm = { Utility: { getGlobalContext: () => ({}) } };
    const foreign = {
      style: {},
      get contentWindow(): never {
        throw new DOMException('Blocked a frame with origin "https://org.test" from accessing a cross-origin frame.', 'SecurityError');
      },
    };
    const hidden = { style: { visibility: 'hidden' }, contentWindow: { Xrm: { Utility: { getGlobalContext: () => ({}) } } } };
    const mine = { style: {}, contentWindow: { Xrm: xrm } };
    g.window = {};
    try {
      g.document = { querySelectorAll: () => [foreign, hidden, mine] };
      t.eq(findXrm() === xrm, true, 'past the frame of another site and the hidden one');
      g.document = { querySelectorAll: () => [foreign] };
      t.eq(findXrm(), null, 'none to be found');
    } finally {
      g.window = had.window;
      g.document = had.document;
    }
  });

  t.test("context: a record's unsaved changes are read from its form data, else its entity; can't tell is null, never false; a page without a record has none", () => {
    const page = (data: unknown, pageType = 'entityrecord') => ({ Utility: { getPageContext: () => ({ input: { pageType } }) }, Page: { data } });
    const boom = () => {
      throw new Error('The form is being rebuilt.');
    };
    t.eq(
      [recordDirty(page({ getIsDirty: () => true })), recordDirty(page({ getIsDirty: () => false })), recordDirty(page({ entity: { getIsDirty: () => true } })), recordDirty(page({ entity: { getIsDirty: () => false } }))],
      [true, false, true, false],
      'data.getIsDirty, else data.entity.getIsDirty',
    );
    t.eq(
      [recordDirty(page({ getIsDirty: boom })), recordDirty(page({ entity: { getIsDirty: boom } })), recordDirty(page({ getIsDirty: () => undefined })), recordDirty(page({ entity: {} }))],
      [null, null, null, null],
      "a record whose state can't be read",
    );
    t.eq(recordDirty({ get Page(): never { return boom(); } }), null, 'the form API itself throws');
    t.eq(
      [recordDirty(null), recordDirty({}), recordDirty(page(null)), recordDirty(page({})), recordDirty(page({ getIsDirty: boom }, 'entitylist')), recordDirty(page({ entity: {} }, 'dashboard'))],
      [false, false, false, false, false, false],
      'no client API, no form data, form data without a record, a page of another type',
    );
  });

  t.test("refresh: a record that has unsaved changes by its entity's API, or whose state can't be read, is asked about first; Not now reloads nothing", async () => {
    const run = async (xrm: unknown, answer: boolean) => {
      const did: string[] = [];
      const asked: string[] = [];
      const o: RefreshOptions = {
        xrm,
        orgId: 'o',
        items: [],
        pending: 0,
        confirm: async (c) => (asked.push(String(c.body)), answer),
        toast: (m) => void did.push('toast: ' + m),
        teardown: () => (did.push('teardown'), true),
        restore: async () => {},
        env: {},
        storage: null,
        reload: () => void did.push('reload'),
        note: () => ({ remove() {} }),
        stayed: 1,
      };
      return [await refreshPage(o), asked, did];
    };
    const entityOnly = { Page: { data: { entity: { getIsDirty: () => true } } } };
    const throwing = {
      Page: {
        data: {
          getIsDirty: () => {
            throw new Error('busy');
          },
          entity: {},
        },
      },
    };
    const NOT_NOW = 'toast: Refresh the page later to see your changes.';
    t.eq(await run(entityOnly, false), [false, ['This record has unsaved changes. Refresh anyway and lose them?'], [NOT_NOW]]);
    t.eq(await run(throwing, false), [false, ['This record may have unsaved changes. Refresh anyway and lose them?'], [NOT_NOW]]);
    t.eq(await run(throwing, true), [true, ['This record may have unsaved changes. Refresh anyway and lose them?'], ['teardown', 'reload']], 'Refresh anyway');
    t.eq(await run({ Page: { data: { entity: { getIsDirty: () => false } } } }, false), [true, [], ['teardown', 'reload']], 'saved: nothing asked');
    t.eq(await run({ Page: { data: null } }, false), [true, [], ['teardown', 'reload']], 'a list: no record');
  });

  t.test("http: a collection answer that isn't one (no array of rows, a nextLink of another site or one followed before) throws as unreadable; {value: []} is no rows", async () => {
    const http = new Http('https://org.test');
    for (const bad of [{}, { value: null }, { value: {} }, { value: 'not a collection' }, [], 'x', null, { value: [], '@odata.nextLink': 7 }]) {
      const { out } = await withFetch(() => json(bad), () => http.all('savedqueries').catch((e) => e));
      t.ok(out instanceof DvError && out.code === 'unreadable' && /could not be read/.test(out.message) && out.url === API + 'savedqueries', `${JSON.stringify(bad)}: ${out}`);
    }
    const empty = await withFetch(() => json({ value: [] }), () => http.all('savedqueries'));
    t.eq(empty.out, []);
    // Pages: absolute nextLinks of this site are followed (every row, in order); one of another site or seen before is not.
    const pages: Record<string, unknown> = {
      [API + 'accounts']: { value: [{ id: 'one' }], '@odata.nextLink': `${API}accounts?$skiptoken=2` },
      [API + 'accounts?$skiptoken=2']: { value: [{ id: 'two' }] },
      [API + 'loop']: { value: [{ id: 'a' }], '@odata.nextLink': `${API}loop?$skiptoken=2` },
      [API + 'loop?$skiptoken=2']: { value: [{ id: 'b' }], '@odata.nextLink': `${API}loop` },
      [API + 'away']: { value: [{ id: 'a' }], '@odata.nextLink': 'https://evil.example/api/data/v9.2/away?$skiptoken=2' },
    };
    const answer = (u: string) => json(pages[u] ?? { error: { message: 'not found' } }, pages[u] ? 200 : 404);
    const ok = await withFetch(answer, () => http.all('accounts'));
    t.eq([ok.out, ok.urls], [[{ id: 'one' }, { id: 'two' }], [API + 'accounts', API + 'accounts?$skiptoken=2']]);
    for (const p of ['loop', 'away']) {
      const r = await withFetch(answer, () => http.all(p).catch((e) => e));
      t.ok(r.out instanceof DvError && r.out.code === 'unreadable', `${p}: ${r.out}`);
      t.eq(r.urls.length, p === 'loop' ? 2 : 1, `${p}: never asked again, never another site`);
    }
    // A failed read is that error, as before.
    const denied = await withFetch(() => json({ error: { message: 'Forbidden', code: '0x80040220' } }, 403), () => http.all('accounts').catch((e) => e));
    t.ok(denied.out instanceof DvError && denied.out.status === 403, String(denied.out));
  });

  t.test('http: a write answered 503 without Retry-After may have run (sent once, never turned away); with Retry-After, a 429, a read or a $batch part it was turned away unrun', async () => {
    const http = new Http('https://org.test');
    const fail = (status: number, headers: Record<string, string> = {}) => () => json({ error: { message: 'Service unavailable' } }, status, headers);
    const plain = await withFetch(fail(503), () => http.post('SetLocLabels', { x: 1 }, { once: true }).catch((e) => e));
    t.eq([plain.urls.length, plain.out instanceof DvError && plain.out.status, turnedAway(plain.out), mayHaveRun(plain.out)], [1, 503, false, true]);
    const batch = await withFetch(fail(503), () => http.batch([{ method: 'POST', url: 'SetLocLabels', body: {} }], { once: true, stop: true }).catch((e) => e));
    t.eq([batch.urls.length, turnedAway(batch.out), mayHaveRun(batch.out)], [1, false, true], 'a write $batch as a whole');
    const told = await withFetch(fail(503, { 'Retry-After': '2' }), () => http.post('SetLocLabels', { x: 1 }, { once: true }).catch((e) => e));
    t.eq([told.urls.length, told.out instanceof DvError && told.out.retryAfter, turnedAway(told.out), mayHaveRun(told.out)], [1, 2, true, false], 'Retry-After: throttled');
    const many = await withFetch(fail(429), () => http.post('SetLocLabels', { x: 1 }, { once: true }).catch((e) => e));
    t.eq([turnedAway(many.out), mayHaveRun(many.out)], [true, false], '429');
    const read = await withFetch(fail(503), () => http.get('accounts').catch((e) => e));
    t.eq([turnedAway(read.out), read.out instanceof DvError && read.out.write], [true, false], 'a read changed nothing');
    const reads = await withFetch(fail(503), () => http.batch([{ method: 'GET', url: 'accounts' }], { idempotent: true }).catch((e) => e));
    t.eq(turnedAway(reads.out), true, 'a $batch of reads');
    const part = partError({ ok: false, status: 503, data: null, error: 'Busy.', headers: {} });
    t.eq([turnedAway(part), mayHaveRun(part)], [true, false], "a part's answer is Dataverse's own");
    t.eq([turnedAway(new DvError('Cannot start another [Import] because there is a previous [Import] running.', 400, '0x80071151')), mayHaveRun(new DvError('Gateway', 502, '', '', '', true))], [true, true]);
  });
}
