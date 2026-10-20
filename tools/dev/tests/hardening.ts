// Unit tests for the checks that keep text from a file, the page's address or the browser's storage from changing what a
// request asks for: logical names and ids before they go into a URL (core/http isLogicalName, isGuid; io/workbook import,
// providers.loadScope, core/context pageInfo, the metadata, sitemap and process loaders), control characters in a $batch
// part (core/http buildBatch), and the label caches Refresh sends again (ui/refresh pageEnv). register() is called by
// tools/dev/unit.ts.
import { pageInfo } from '../../../src/core/context';
import { DvError, Http, buildBatch, isGuid, isLogicalName } from '../../../src/core/http';
import { createIo } from '../../../src/io/workbook';
import { loadBpfLabels } from '../../../src/providers/bpf';
import { providers } from '../../../src/providers/index';
import { loadTables } from '../../../src/providers/metadata';
import { appSitemapId, loadSitemap } from '../../../src/providers/sitemap';
import { pageEnv, sameOrigin } from '../../../src/ui/refresh';
import type { Kit } from './kit';

const EN = 1033;
const ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const API = 'https://org.test/api/data/v9.2/';
const label = (t: string) => ({ LocalizedLabels: [{ Label: t, LanguageCode: EN }], UserLocalizedLabel: { Label: t, LanguageCode: EN } });

/** A Dataverse that answers every table read with `answer(url)` and records every URL asked for. */
function fakeCtx(answer: (url: string) => unknown = (u) => ({ LogicalName: /LogicalName='(\w+)'/.exec(u)?.[1], MetadataId: ID, DisplayName: label('Account'), DisplayCollectionName: label('Accounts'), Description: label('') })) {
  const urls: string[] = [];
  const http = {
    api: API,
    get: async (u: string) => (urls.push(u), answer(u)),
    all: async (u: string) => (urls.push(u), []),
    post: async (u: string) => (urls.push(u), {}),
    batch: async (parts: Array<{ url: string }>) => (urls.push(...parts.map((p) => p.url)), []),
  };
  const ctx = { http, origin: 'https://org.test', org: 'org', orgId: 'o', userId: 'u', base: EN, user: EN, langs: [{ lcid: EN, name: 'English', isBase: true }], version: '9.2', xrm: null };
  return { ctx: ctx as never, urls };
}
const opts = () => ({ signal: new AbortController().signal, progress: () => {} });

export function register(t: Kit): void {
  const { test, eq, ok } = t;

  test('hardening: logical names and GUIDs as Dataverse writes them; anything that could change a URL is neither', () => {
    eq(['account', 'new_dxttest', 'msdyn_x2', 'a'.repeat(128)].map(isLogicalName), [true, true, true, true]);
    eq(["account')", 'account%27', 'acc ount', 'account#', 'account?x', 'Account', '', 'a'.repeat(129), 'account\r\n'].map(isLogicalName), Array(9).fill(false));
    eq([ID, ID.toUpperCase(), `{${ID}}`, `${ID})`, ''].map(isGuid), [true, false, false, false, false], 'as guid() returns them: lower case, no braces');
    eq([sameOrigin('https://org.test/api/data/v9.0/x', 'https://org.test'), sameOrigin('https://evil.example/x', 'https://org.test'), sameOrigin('not a url', 'https://org.test')], [true, false, false]);
  });

  test('hardening: a $batch part with a control character in its URL or a header is never sent (a line break would add a header to it); spaces of a $filter still go', async () => {
    const bad = [
      { method: 'PUT' as const, url: "EntityDefinitions(LogicalName='account')\r\nMSCRM.MergeLabels: false\r\nX: (" },
      { method: 'GET' as const, url: 'WhoAmI()', headers: { 'If-Match': '*\nX-Injected: 1' } },
      { method: 'GET' as const, url: 'WhoAmI()', headers: { 'X\r\nY': '1' } },
      { method: 'GET' as const, url: 'WhoAmI()\u0000' },
    ];
    for (const p of bad) {
      let err: unknown = null;
      try {
        buildBatch(API, 'b', [{ method: 'GET', url: 'WhoAmI()' }, p]);
      } catch (e) {
        err = e;
      }
      ok(err instanceof DvError && err.status === 400 && err.code === 'batch-part', `${JSON.stringify(p)}: ${err}`);
    }
    const body = buildBatch(API, 'b', [{ method: 'GET', url: "EntityDefinitions?$filter=LogicalName eq 'account'", headers: { Consistency: 'Strong' } }]);
    ok(body.includes(`GET ${API}EntityDefinitions?$filter=LogicalName eq 'account' HTTP/1.1\r\nAccept: application/json\r\nConsistency: Strong`), body);
    // Through Http.batch: refused before anything is sent, as a refusal (400: nothing ran, nothing to wait for).
    const g = globalThis as { fetch: typeof fetch };
    const real = g.fetch;
    let sent = 0;
    g.fetch = (async () => (sent++, new Response('', { status: 200 }))) as typeof fetch;
    try {
      const err = await new Http('https://org.test').batch([bad[0]]).catch((e) => e);
      eq([err instanceof DvError && err.status, sent], [400, 0]);
    } finally {
      g.fetch = real;
    }
  });

  test("hardening: an import row whose table cell isn't a logical name is skipped with the reason and never loaded; the file's other tables are", async () => {
    const rows = [
      'Key,Type,Table,Component,Property,1033,1036',
      'attribute|account.name|DisplayName,Column,account,Name,Display name,Name,Nom',
      "attribute|x.name|DisplayName,Column,\"x') or 1 eq 1 or ('x\",Name,Display name,Name,Nom",
      'attribute|x.name|DisplayName,Column,acc%27)#ount,Name,Display name,Name,Nom',
      'attribute|x.name|DisplayName,Column,ACCOUNT,Name,Display name,Name,Nom',
      'sitemap|x|Title,Sitemap,_app,Area,Title,Area,Zone',
    ];
    const p = await createIo().parse(new File([rows.join('\r\n')], 'labels.csv'));
    eq(p.scope.entities, ['account'], 'upper case is lowered as before; the others are not tables');
    const reasons = (p.rows as Array<{ row: number; reason: string }>).map((r) => [r.row, r.reason]);
    eq(reasons, [
      [2, ''],
      [3, `Not a table's logical name: "x') or 1 eq 1 or ('x"`],
      [4, 'Not a table\'s logical name: "acc%27)#ount"'],
      [5, ''],
      [6, ''],
    ]);
  });

  test('hardening: the loaders get only logical names, whatever the scope holds (a file, stored settings); a table read answered with another table is refused', async () => {
    const { ctx, urls } = fakeCtx();
    const slots = await providers.loadScope(ctx, { entities: ['account', "x%27)?$select=LogicalName#", 'acc ount'], kinds: new Set(['entity']) }, opts());
    eq([...new Set(slots.map((s) => s.entity))], ['account']);
    ok(urls.length > 0 && urls.every((u) => !/x%27|acc ount/.test(u)), urls.join('\n'));
    // Straight to the metadata loader (the page's tables): skipped like a table this org doesn't have.
    const direct = fakeCtx();
    eq((await loadTables(direct.ctx, ["account')", 'account'], new Set(['entity']), opts())).map((s) => s.entity), ['account', 'account', 'account']);
    eq(direct.urls.length, 1);
    // Every ref keeps the name asked for, which its writes use: it must be the table that answered.
    const other = fakeCtx((u) => ({ LogicalName: 'contact', MetadataId: ID, DisplayName: label('Contact'), url: u }));
    const err = await loadTables(other.ctx, ['account'], new Set(['entity']), opts()).catch((e) => e);
    ok(err instanceof DvError && /Could not read the table "account"\. Dataverse answered with another table \(contact\)/.test(err.message), String(err));
  });

  test("hardening: the page's table and ids come from its address only when they are a logical name and GUIDs; an app, sitemap or process id that isn't a GUID is never asked for", async () => {
    const g = globalThis as { location?: unknown };
    const had = g.location;
    try {
      g.location = { search: `?pagetype=entityrecord&etn=account%27)%23&id=${ID})&formid=x&appid=%7B${ID.toUpperCase()}%7D` };
      const bad = pageInfo(null);
      eq([bad.type, bad.entity, bad.recordId, bad.formId, bad.appId], ['entityrecord', '', '', '', ID]);
      g.location = { search: `?pagetype=entityrecord&etn=account&id=%7B${ID.toUpperCase()}%7D` };
      const good = pageInfo(null);
      eq([good.entity, good.recordId], ['account', ID]);
    } finally {
      g.location = had;
    }
    const { ctx, urls } = fakeCtx();
    eq(await appSitemapId(ctx, `${ID})/x?$select=name#`), null);
    const sm = await loadSitemap(ctx, 'x)?$expand=y', opts()).catch((e) => e);
    const wf = await loadBpfLabels(ctx, `${ID}')`, opts()).catch((e) => e);
    ok(sm instanceof Error && /id is not valid/.test(sm.message) && wf instanceof Error && /id is not valid/.test(wf.message), `${sm} ${wf}`);
    eq(urls, [], 'nothing asked for');
  });

  test("hardening: Refresh sends again only the label requests of this site's own address found in UCI's caches, never another site's", async () => {
    const req = (url: string, h: Record<string, string> = {}) => ({ url, headers: new Headers(h) });
    const opened: string[] = [];
    const win = {
      location: { origin: 'https://org.test' },
      caches: {
        keys: async () => ['gcm_123_x', 'CDN_Resources'],
        open: async (n: string) => (
          opened.push(n),
          { keys: async () => [req('https://org.test/api/data/v9.0/GetClientMetadata(x)', { 'x-ms-a': '1', cookie: 'c' }), req('https://evil.example/steal', { 'x-ms-a': '1' }), req('https://org.test.evil.example/x')] }
        ),
      },
      navigator: {},
    };
    const env = pageEnv(win as never);
    eq(await env.labels!.requests(), [{ url: 'https://org.test/api/data/v9.0/GetClientMetadata(x)', headers: { 'x-ms-a': '1' } }]);
    eq(opened, ['gcm_123_x']);
  });
}
