// Unit tests for the records writer (SetLocLabels on localizable record columns: view, form, app names…), on a fake
// Dataverse that merges labels by language as the real one does (LIVE-FINDINGS 21, 33) and runs a $batch's parts in
// order (a failed part stops a batch sent without continue-on-error, finding 49). register() is called by
// tools/dev/unit.ts.
import { DvError, Http, type BatchPart, type PartResult } from '../../../src/core/http';
import { MANAGED, PublishSet, type Change, type ChangeResult, type Kind, type Lcid, type Slot } from '../../../src/core/model';
import { loadRecords, loadRecordsScope, recordsWriter } from '../../../src/providers/records';
import type { Kit } from './kit';
import { fast } from './lang';

/**
 * A $batch for a fake whose get, post, patch and put stand for single requests (looked up at each call): its parts
 * through them in order, a DvError thrown by one as that part's failed answer; with `stop`, the parts after a failed one
 * get no answer (status 0). A lost answer (status 0) loses the whole batch's answer, after the parts ran, as live.
 */
export function batchOf(http: Record<string, any>, peek?: (url: string) => unknown) {
  return async (parts: BatchPart[], o: { once?: boolean; stop?: boolean; signal?: AbortSignal } = {}): Promise<PartResult[]> => {
    const out: PartResult[] = [];
    let lost: DvError | null = null;
    for (const p of parts) {
      const opts = { headers: p.headers, once: o.once, signal: o.signal };
      try {
        const m = p.method === 'GET' ? 'get' : p.method === 'POST' ? 'post' : p.method === 'PATCH' ? 'patch' : p.method === 'PUT' ? 'put' : 'del';
        // `peek`: the reads of a batch answered from the server as it is, apart from the reads a test counts or makes lag.
        const data = m === 'get' && peek ? await peek(p.url) : m === 'get' || m === 'del' ? await http[m](p.url, opts) : await http[m](p.url, p.body, opts);
        const id = (data as { headers?: { get?(n: string): string | null } } | null)?.headers?.get?.('x-ms-service-request-id');
        out.push({ ok: true, status: p.method === 'GET' ? 200 : 204, data: data ?? null, headers: id ? { 'x-ms-service-request-id': id } : {} });
      } catch (e) {
        const x = e instanceof DvError ? e : new DvError(String((e as Error)?.message || e), 500);
        if (!x.status) {
          lost = x;
          out.push({ ok: true, status: 204, data: null, headers: {} });
          continue;
        }
        out.push({ ok: false, status: x.status, data: null, error: x.message, code: x.code, headers: x.requestId ? { 'x-ms-service-request-id': x.requestId } : {} });
        if (o.stop) break;
      }
    }
    if (lost) throw lost;
    while (out.length < parts.length) out.push({ ok: false, status: 0, data: null, error: 'Dataverse sent no answer for this part of the request.', headers: {} });
    return out;
  };
}

const EN = 1033;
const FR = 1036;
const DE = 1031;

type Sent = Array<{ Label: string; LanguageCode: number }>;

/**
 * A view name on a fake Dataverse: RetrieveLocLabels answers the labels stored; SetLocLabels changes only the
 * languages it is sent ('' removes one). Writes go in a $batch [read, SetLocLabels, read]. `meanwhile` runs once when
 * the next batch arrives, before its first read (another maker saving after the writer's own read); `afterWrite` once
 * right after the next SetLocLabels (someone saving after it). `failRead`: the status of the next batch's first read
 * (a failed part stops the batch). `replace`: the next SetLocLabels replaces the whole set instead of merging.
 * `unreadable`: the next batch's first read answers something unreadable (status 0) and the batch goes on. `managed`: what
 * the record's ismanaged reads as, or the status that read fails with (the writer asks once right before its first write;
 * `managedReads` counts it).
 */
function server(labels: Record<number, string>) {
  const srv: Record<number, string> = { ...labels };
  const sent: Sent[] = [];
  const S = { srv, sent, gets: 0, meanwhile: null as null | (() => void), afterWrite: null as null | (() => void), failRead: 0, replace: 0, unreadable: false, refuse: new Set<number>(), writes: 0, managed: false as boolean | number, managedReads: 0 };
  const read = () => ({ Label: { LocalizedLabels: Object.entries(S.srv).map(([l, v]) => ({ Label: v, LanguageCode: Number(l) })) } });
  const setLoc = (body: { Labels: Sent }) => {
    sent.push(body.Labels);
    if (S.replace > 0) {
      S.replace--;
      for (const k of Object.keys(S.srv)) delete S.srv[Number(k)];
    }
    for (const l of body.Labels) if (l.Label) S.srv[l.LanguageCode] = l.Label;
    else delete S.srv[l.LanguageCode];
  };
  const part = (status: number, data: unknown = null, error?: string): PartResult => ({ ok: status > 0 && status < 300, status, data, error, code: '', headers: {} });
  const http = {
    fn: () => 'RetrieveLocLabels(savedqueries(v1),name)',
    get: async (u: string) => {
      if (!u.endsWith('?$select=ismanaged')) return S.gets++, read();
      S.managedReads++;
      if (typeof S.managed === 'number') throw new DvError('The record could not be read.', S.managed);
      return { ismanaged: S.managed };
    },
    batch: async (parts: BatchPart[], o: { stop?: boolean } = {}) => {
      const m = S.meanwhile;
      S.meanwhile = null;
      m?.();
      const out: PartResult[] = [];
      for (const [i, p] of parts.entries()) {
        if (p.method === 'GET') {
          if (i === 0 && S.failRead) {
            out.push(part(S.failRead, null, S.failRead === 503 ? 'Dataverse is busy.' : 'The record could not be read.'));
            S.failRead = 0;
            if (o.stop) break;
            continue;
          }
          if (i === 0 && S.unreadable) {
            S.unreadable = false;
            out.push(part(0, null, 'Dataverse sent an unreadable answer.'));
            continue;
          }
          out.push(part(200, read()));
        } else {
          if (S.refuse.has(++S.writes)) {
            out.push(part(400, null, 'The label could not be saved.'));
            if (o.stop) break;
            continue;
          }
          setLoc(p.body as { Labels: Sent });
          out.push(part(204));
          const a = S.afterWrite;
          S.afterWrite = null;
          a?.();
        }
      }
      while (out.length < parts.length) out.push(part(0, null, 'Dataverse sent no answer for this part of the request.'));
      return out;
    },
  };
  return { S, ctx: { http, base: EN, user: FR, langs: [] } as never };
}

const writeOpts = () => ({ signal: new AbortController().signal, publish: new PublishSet(), progress() {}, force: new Set<string>(), lang: null as never, allowPublish: true });

export function register(t: Kit): void {
  const { test, eq, ok } = t;
  const view = (labels: Record<number, string>) =>
    ({
      ...t.slot('view', 'view|v1|Name', { ...labels }),
      kind: 'view',
      prop: 'Name',
      entity: 'account',
      comp: 'view|v1',
      group: 'view|v1',
      ref: { id: 'v1', table: 'savedquery', entitySet: 'savedqueries', column: 'name', entity: 'account' },
    }) as Slot;
  const save = (ctx: never, slot: Slot, lcid: Lcid, before: string, after: string): Promise<ChangeResult[]> =>
    recordsWriter.save(ctx, [{ slot, lcid, before, after } as Change], writeOpts());
  const START = { [EN]: 'Active Accounts', [FR]: 'Comptes actifs', [DE]: 'Aktive Konten' };

  test('records: a French edit sends only French, so a German text another maker saved after the read is kept', async () => {
    const { S, ctx } = server(START);
    S.meanwhile = () => (S.srv[DE] = 'Aktive Konten (neu)');
    const res = await save(ctx, view(START), FR, 'Comptes actifs', 'Comptes ouverts');
    eq(S.sent, [[{ Label: 'Comptes ouverts', LanguageCode: FR }]], 'only the edited language');
    eq(S.srv, { [EN]: 'Active Accounts', [FR]: 'Comptes ouverts', [DE]: 'Aktive Konten (neu)' }, 'German as the other maker left it');
    // The read inside the write batch shows the German change was there before the write: it is theirs, kept, not this save's.
    eq(res[0].outcome, 'saved');
  });

  test('records: adding, changing and clearing a translation send that language alone and keep every other one', async () => {
    const { S, ctx } = server({ [EN]: 'Active Accounts', [DE]: 'Aktive Konten' });
    eq((await save(ctx, view(S.srv), FR, '', 'Comptes actifs'))[0].outcome, 'saved', 'added');
    eq((await save(ctx, view(S.srv), FR, 'Comptes actifs', 'Comptes ouverts'))[0].outcome, 'saved', 'changed');
    eq((await save(ctx, view(S.srv), FR, 'Comptes ouverts', ''))[0].outcome, 'saved', 'cleared');
    eq(S.sent, [[{ Label: 'Comptes actifs', LanguageCode: FR }], [{ Label: 'Comptes ouverts', LanguageCode: FR }], [{ Label: '', LanguageCode: FR }]]);
    eq(S.srv, { [EN]: 'Active Accounts', [DE]: 'Aktive Konten' });
    eq(S.gets, 3, 'one read before each write batch; the batch itself reads before and after the write');
  });

  test('records: a base-language edit sends the base language alone; two languages of one label go in one write', async () => {
    const { S, ctx } = server(START);
    eq((await save(ctx, view(START), EN, 'Active Accounts', 'Open Accounts'))[0].outcome, 'saved');
    const slot = view(S.srv);
    const res = await recordsWriter.save(
      ctx,
      [
        { slot, lcid: FR, before: 'Comptes actifs', after: 'Comptes ouverts' },
        { slot, lcid: DE, before: 'Aktive Konten', after: 'Offene Konten' },
      ],
      writeOpts(),
    );
    eq(res.map((r) => r.outcome), ['saved', 'saved']);
    eq(S.sent, [[{ Label: 'Open Accounts', LanguageCode: EN }], [{ Label: 'Comptes ouverts', LanguageCode: FR }, { Label: 'Offene Konten', LanguageCode: DE }]]);
    eq(S.srv, { [EN]: 'Open Accounts', [FR]: 'Comptes ouverts', [DE]: 'Offene Konten' });
  });

  test('records: a French text someone changed before the read is a conflict, nothing written', async () => {
    const { S, ctx } = server({ ...START, [FR]: 'Comptes (autre)' });
    const res = await save(ctx, view(START), FR, 'Comptes actifs', 'Comptes ouverts');
    eq([res[0].outcome, res[0].server, S.sent.length], ['conflict', 'Comptes (autre)', 0]);
  });

  test('records: a French text someone saves between the read and the write is put back and reported as a conflict, never overwritten', async () => {
    const { S, ctx } = server(START);
    S.meanwhile = () => (S.srv[FR] = 'Comptes (collègue)');
    const res = await save(ctx, view(START), FR, 'Comptes actifs', 'Comptes ouverts');
    eq([res[0].outcome, res[0].server], ['conflict', 'Comptes (collègue)']);
    eq(S.srv, { ...START, [FR]: 'Comptes (collègue)' }, 'their text is back, the other languages untouched');
    eq(S.sent, [[{ Label: 'Comptes ouverts', LanguageCode: FR }], [{ Label: 'Comptes (collègue)', LanguageCode: FR }]], 'ours, then theirs put back (that language alone)');

    // The same for the base language, and for a translation they removed (put back = removed again).
    const B = server(START);
    B.S.meanwhile = () => (B.S.srv[EN] = 'Active Accounts (theirs)');
    const rb = await save(B.ctx, view(START), EN, 'Active Accounts', 'Open Accounts');
    eq([rb[0].outcome, rb[0].server, B.S.srv[EN]], ['conflict', 'Active Accounts (theirs)', 'Active Accounts (theirs)']);
    const C = server(START);
    C.S.meanwhile = () => delete C.S.srv[FR];
    const rc = await save(C.ctx, view(START), FR, 'Comptes actifs', 'Comptes ouverts');
    eq([rc[0].outcome, rc[0].server, FR in C.S.srv], ['conflict', '', false]);
  });

  test('records: the same text saved by both at once is no conflict; a text saved again after the write is left as it is', async () => {
    const { S, ctx } = server(START);
    S.meanwhile = () => (S.srv[FR] = 'Comptes ouverts');
    eq((await save(ctx, view(START), FR, 'Comptes actifs', 'Comptes ouverts'))[0].outcome, 'saved');
    eq(S.sent.length, 1, 'nothing to put back');

    // Theirs before the write, and another text after it: the newest stays, nothing is written over it.
    const B = server(START);
    B.S.meanwhile = () => (B.S.srv[FR] = 'Comptes (1)');
    B.S.afterWrite = () => (B.S.srv[FR] = 'Comptes (2)');
    const res = await save(B.ctx, view(START), FR, 'Comptes actifs', 'Comptes ouverts');
    eq([res[0].outcome, res[0].server, B.S.srv[FR], B.S.sent.length], ['conflict', 'Comptes (2)', 'Comptes (2)', 1]);
  });

  test('records: when the read inside the write batch fails, the write is never sent; busy is tried again from a new read', () =>
    fast(async () => {
      const { S, ctx } = server(START);
      S.failRead = 404;
      const res = await save(ctx, view(START), FR, 'Comptes actifs', 'Comptes ouverts');
      eq(res[0].outcome, 'error');
      ok(/nothing was saved/.test(res[0].message!), res[0].message);
      eq([S.sent.length, S.srv[FR]], [0, 'Comptes actifs']);

      const B = server(START);
      B.S.failRead = 503;
      const rb = await save(B.ctx, view(START), FR, 'Comptes actifs', 'Comptes ouverts');
      eq([rb[0].outcome, B.S.sent.length, B.S.srv[FR], B.S.gets], ['saved', 1, 'Comptes ouverts', 2]);
    }),
  );

  test('records: SaveOptions.ran names a change whose write ran or whose answer was lost, never one whose read or write was refused (a Try again finding it as asked would take theirs for this write)', async () => {
    const id = `view|v1|Name#${FR}`;
    const attempt = async (set: (S: ReturnType<typeof server>['S'], http: Record<string, any>) => void): Promise<[string, string[]]> => {
      const { S, ctx } = server(START);
      set(S, (ctx as unknown as { http: Record<string, any> }).http);
      const o = { ...writeOpts(), ran: new Set<string>() };
      const [r] = await recordsWriter.save(ctx, [{ slot: view(START), lcid: FR, before: 'Comptes actifs', after: 'Comptes ouverts' } as Change], o);
      return [r.outcome, [...o.ran]];
    };
    eq(await attempt(() => {}), ['saved', [id]], 'saved');
    eq(
      await attempt((_, http) => {
        const get = http.get;
        http.get = async (u: string) => (u.endsWith('?$select=ismanaged') ? get(u) : Promise.reject(new DvError('You do not have permission to do this.', 403)));
      }),
      ['error', []],
      'its read of the current label refused: nothing sent',
    );
    eq(await attempt((S) => (S.failRead = 403)), ['error', []], 'the read in its batch refused: the write never ran');
    eq(await attempt((S) => S.refuse.add(1)), ['error', []], 'the write refused');
    eq(
      await attempt((_, http) => {
        const batch = http.batch;
        http.batch = async (...a: unknown[]) => {
          await batch(...a);
          throw new DvError('Could not reach Dataverse.', 0, 'network');
        };
      }),
      ['error', [id]],
      'its answer lost once it ran',
    );
  });

  test('records: a write batch Dataverse stopped at a failed part and answered with an error status as a whole is still read part by part', async () => {
    const g = globalThis as { fetch?: unknown };
    const had = g.fetch;
    const b = 'batchresponse_r';
    const answer = (...parts: string[][]) => [...parts.flatMap((p) => [`--${b}`, 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', '', ...p]), `--${b}--`, ''].join('\r\n');
    const labels = JSON.stringify({ Label: { LocalizedLabels: [{ Label: 'Active Accounts', LanguageCode: EN }, { Label: 'Comptes actifs', LanguageCode: FR }] } });
    let batch: Response | null = null;
    g.fetch = async (url: string) => (String(url).endsWith('$batch') ? batch! : new Response(labels, { status: 200 }));
    try {
      const ctx = { http: new Http('https://org.test'), base: EN, user: FR, langs: [] } as never;
      const slot = view({ [EN]: 'Active Accounts', [FR]: 'Comptes actifs' });
      // The read before the write failed: nothing written, and said so in Dataverse's words for that part.
      batch = new Response(answer(['HTTP/1.1 404 Not Found', 'Content-Type: application/json', '', '{"error":{"code":"0x80040217","message":"savedquery With Id = v1 Does Not Exist"}}']), {
        status: 404,
        headers: { 'Content-Type': `multipart/mixed; boundary=${b}` },
      });
      const res = await save(ctx, slot, FR, 'Comptes actifs', 'Comptes ouverts');
      eq([res[0].outcome, res[0].message], ['error', 'Could not read the current text right before saving, so nothing was saved: savedquery With Id = v1 Does Not Exist']);
      // The write itself refused after the read: its own message.
      batch = new Response(answer(['HTTP/1.1 200 OK', 'Content-Type: application/json', '', labels], ['HTTP/1.1 400 Bad Request', 'Content-Type: application/json', '', '{"error":{"code":"0x80040203","message":"The label is too long."}}']), {
        status: 400,
        headers: { 'Content-Type': `multipart/mixed; boundary=${b}` },
      });
      const res2 = await save(ctx, slot, FR, 'Comptes actifs', 'Comptes ouverts');
      eq([res2[0].outcome, res2[0].message], ['error', 'The label is too long.']);
    } finally {
      g.fetch = had;
    }
  });

  test('records: a write whose read before it was unreadable is never reported as plainly saved', async () => {
    const { S, ctx } = server(START);
    S.unreadable = true;
    const res = await save(ctx, view(START), FR, 'Comptes actifs', 'Comptes ouverts');
    eq([res[0].outcome, S.srv[FR]], ['error', 'Comptes ouverts']);
    ok(/can't be ruled out/.test(res[0].message!), res[0].message);
  });

  test('records: languages a write drops are written back as they were right before it; ours stays', async () => {
    const { S, ctx } = server(START);
    // As if SetLocLabels replaced the whole set once instead of merging: the languages not sent are gone.
    S.replace = 1;
    const res = await save(ctx, view(START), FR, 'Comptes actifs', 'Comptes ouverts');
    eq(res[0].outcome, 'saved');
    eq(S.srv, { ...START, [FR]: 'Comptes ouverts' });
    eq(S.sent[1], [{ Label: 'Aktive Konten', LanguageCode: DE }, { Label: 'Active Accounts', LanguageCode: EN }]);
  });

  test('records: a write Dataverse applies to another language too, every time, is reported, not called saved', async () => {
    const { S, ctx } = server(START);
    // Replacing the whole set on every write: putting the others back drops the French again.
    S.replace = 9;
    const res = await save(ctx, view(START), FR, 'Comptes actifs', 'Comptes ouverts');
    eq(res[0].outcome, 'error');
    eq(res[0].message, 'Dataverse did not keep this text. Reload and try again.');
  });

  test('records: when putting their text back fails, the change says whose text it replaced, never saved nor a conflict', async () => {
    const { S, ctx } = server(START);
    S.meanwhile = () => (S.srv[FR] = 'Comptes (collègue)');
    S.refuse = new Set([2]); // the second SetLocLabels (theirs back) is refused
    const res = await save(ctx, view(START), FR, 'Comptes actifs', 'Comptes ouverts');
    eq([res[0].outcome, S.srv[FR]], ['error', 'Comptes ouverts']);
    eq(res[0].message, 'Someone else saved “Comptes (collègue)” here at the same moment, and this save replaced it; putting theirs back failed (The label could not be saved). Check this text.');
  });

  test('records: a text a third maker saves while theirs is put back is put back in turn: the newest text stays, the change is a conflict', async () => {
    const { S, ctx } = server(START);
    // B saves between the read and the write; C between the write and the batch that puts B's text back.
    S.meanwhile = () => {
      S.srv[FR] = 'Comptes (B)';
      S.meanwhile = () => (S.srv[FR] = 'Comptes (C)');
    };
    const res = await save(ctx, view(START), FR, 'Comptes actifs', 'Comptes ouverts');
    eq([res[0].outcome, res[0].server], ['conflict', 'Comptes (C)'], res[0].message);
    eq(S.srv, { ...START, [FR]: 'Comptes (C)' }, "C's text, the newest, stays");
    eq(
      S.sent.map((x) => x.map((l) => l.Label)),
      [['Comptes ouverts'], ['Comptes (B)'], ['Comptes (C)']],
    );

    // The same in a language this save did not write (one the write dropped): C's German stays, and it is said.
    const B = server(START);
    B.S.replace = 1;
    B.S.meanwhile = () => (B.S.meanwhile = () => (B.S.srv[DE] = 'Aktive Konten (C)'));
    const rb = await save(B.ctx, view(START), FR, 'Comptes actifs', 'Comptes ouverts');
    eq([rb[0].outcome, rb[0].message], ['error', 'Saved, but the German text changed too. Reload to check it.']);
    eq(B.S.srv, { ...START, [FR]: 'Comptes ouverts', [DE]: 'Aktive Konten (C)' });
  });

  test('records: a language someone else changes right after the write is said, never put back', async () => {
    const { S, ctx } = server(START);
    S.afterWrite = () => (S.srv[DE] = 'Aktive Konten (neu)');
    const res = await save(ctx, view(START), FR, 'Comptes actifs', 'Comptes ouverts');
    eq([res[0].outcome, res[0].message], ['error', 'Saved, but the German text changed too. Reload to check it.']);
    eq([S.sent.length, S.srv[DE]], [1, 'Aktive Konten (neu)']);
  });

  // ---- a managed solution's records: read-only, never written (no unmanaged layer on them) ----

  test("records: a label of a managed solution's record is refused as loaded, before anything is read or sent", async () => {
    const { S, ctx } = server(START);
    const slot = { ...view(START), ref: { ...view(START).ref, managed: true } };
    const res = await save(ctx, slot, FR, 'Comptes actifs', 'Comptes ouverts');
    eq(res.map((r) => [r.outcome, r.message]), [['error', MANAGED]]);
    eq([S.gets, S.managedReads, S.sent, S.srv], [0, 0, [], START]);
  });

  test("records: a record read as a managed solution's right before the write is never written; one that reads as unmanaged is (asked once per record); a failed read writes nothing", async () => {
    const { S, ctx } = server(START);
    S.managed = true;
    const slot = view(START);
    const res = await recordsWriter.save(ctx, [{ slot, lcid: FR, before: 'Comptes actifs', after: 'Comptes ouverts' }, { slot, lcid: DE, before: 'Aktive Konten', after: 'Offene Konten' }] as Change[], writeOpts());
    eq(res.map((r) => [r.outcome, r.message]), [['error', MANAGED], ['error', MANAGED]]);
    eq([S.managedReads, S.gets, S.sent, S.srv], [1, 0, [], START], 'asked once; nothing read for writing, nothing sent');
    S.managed = 404;
    const res2 = await save(ctx, view(START), FR, 'Comptes actifs', 'Comptes ouverts');
    eq([res2[0].outcome, /Could not read the current text/.test(res2[0].message || ''), S.sent], ['error', true, []], res2[0].message);
    S.managed = false;
    eq((await save(ctx, view(START), FR, 'Comptes actifs', 'Comptes ouverts'))[0].outcome, 'saved');
    eq(S.sent, [[{ Label: 'Comptes ouverts', LanguageCode: FR }]]);
  });

  test('records: every kind of record from a managed solution loads read-only with the managed reason, whatever its managed properties allow; an unmanaged one stays editable, also when marked not customizable; the Workbench leaves the managed ones out unless read-only labels are asked for', async () => {
    const lab = { Label: { LocalizedLabels: [{ Label: 'Name', LanguageCode: EN }, { Label: 'Nom', LanguageCode: FR }] } };
    const sets: Record<string, [string, Kind]> = {
      savedqueries: ['savedqueryid', 'view'],
      savedqueryvisualizations: ['savedqueryvisualizationid', 'chart'],
      systemforms: ['formid', 'form'],
      appmodules: ['appmoduleid', 'app'],
      workflows: ['workflowid', 'bpf'],
      appactions: ['appactionid', 'command'],
      environmentvariabledefinitions: ['environmentvariabledefinitionid', 'envvar'],
      customapis: ['customapiid', 'customapi'],
    };
    const M = 'aaaaaaaa-0000-4000-8000-00000000000a';
    const U = 'bbbbbbbb-0000-4000-8000-00000000000b';
    const rows = (set: string) => {
      const pk = sets[set][0];
      return [
        { [pk]: M, name: 'Managed', ismanaged: true, iscustomizable: { Value: true }, type: 2, querytype: 0, location: 0, returnedtypecode: 'account', primaryentitytypecode: 'account', objecttypecode: 'account', primaryentity: 'account', contextvalue: 'account' },
        { [pk]: U, name: 'Ours', ismanaged: false, iscustomizable: { Value: false }, type: 2, querytype: 0, location: 0, returnedtypecode: 'account', primaryentitytypecode: 'account', objecttypecode: 'account', primaryentity: 'account', contextvalue: 'account' },
      ];
    };
    const http = {
      reads: { max: 4, run: () => Promise.reject(new Error('no $batch in unit tests')) },
      fn: (name: string, p: { EntityMoniker: { '@odata.id': string }; AttributeName: string }) => `${name}(${p.EntityMoniker['@odata.id']},${p.AttributeName})`,
      get: async (u: string) => (u.startsWith('RetrieveLocLabels(') ? lab : { value: [] }),
      all: async (u: string) => rows(u.slice(0, u.indexOf('?'))),
    };
    const ctx = { http, base: EN, user: FR, langs: [] } as never;
    const lo = () => ({ signal: new AbortController().signal, progress() {} });
    for (const [kind, set] of [...Object.entries(sets).map(([set, [, k]]) => [k, set] as [Kind, string]), ['dashboard', 'systemforms'] as [Kind, string]]) {
      const slots = await loadRecords(ctx, kind, [M, U], lo());
      ok(slots.length > 0, kind);
      eq(
        [...new Set(slots.map((x) => `${x.ref.id === M ? 'managed' : 'ours'}: ${x.readOnly || 'editable'} ${x.ref.managed}`))],
        [`managed: ${MANAGED} true`, 'ours: editable false'],
        kind,
      );
    }
    const kinds = new Set<Kind>(['view', 'chart', 'form', 'dashboard', 'app', 'bpf', 'command', 'envvar', 'customapi']);
    const scoped = await loadRecordsScope(ctx, { entities: ['account'], kinds }, lo());
    ok(scoped.length > 0 && scoped.every((x) => x.ref.id === U && !x.readOnly), 'only ours without read-only labels');
    const all = await loadRecordsScope(ctx, { entities: ['account'], kinds, includeReadOnly: true }, lo());
    ok(all.some((x) => x.ref.id === M && x.readOnly === MANAGED), 'the managed ones, read-only, when asked for');
  });
}
