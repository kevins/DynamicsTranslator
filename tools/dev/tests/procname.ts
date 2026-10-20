// The process update after a process name is saved (src/core/publish.ts rebuildProcess, LIVE-FINDINGS 83): a PATCH of
// workflow.name with the base-language name, inside a base-language window, in one $batch between two reads of the name.
// A base-language name someone else saved between the read the PATCH is built from and the PATCH is seen in the batch's
// first read and put back; never silently replaced. A process from a managed solution is never updated.
// register() is called by tools/dev/unit.ts.
import { DvError } from '../../../src/core/http';
import { MANAGED, type Lcid } from '../../../src/core/model';
import { rebuildProcess } from '../../../src/core/publish';
import type { Kit } from './kit';
import { fast } from './lang';
import { batchOf } from './records';

const EN = 1033;
const FR = 1036;
const WF = '9a6faaaa-0000-4000-8000-0000000000b1';

/**
 * A process on a fake Dataverse: its name per language (RetrieveLocLabels), and the PATCH of workflow.name, which writes
 * the label of the caller's UI language (`ui`, the base language inside run()). `meanwhile` runs once right before the
 * next PATCH's batch (someone saving after the read the PATCH was built from); `afterPatch` once right after the next
 * PATCH; `fail` the statuses the next PATCHes answer (nothing written); `reads` what the reads answer by their number (1:
 * the first), instead of the name as it is: an older name (a read that lags) or a status (that read fails).
 */
function rig(name: Record<number, string>) {
  const st = {
    name,
    ui: FR as Lcid,
    log: [] as string[],
    meanwhile: null as null | (() => void),
    afterPatch: null as null | (() => void),
    fail: [] as number[],
    reads: new Map<number, Record<number, string> | number>(),
    n: 0,
    /** What the process's ismanaged reads as (asked once before anything else; not in the log): a boolean, or a status that read fails with. */
    managed: false as boolean | number,
  };
  const http: Record<string, any> = {
    fn: (fn: string, p: { EntityMoniker: { '@odata.id': string }; AttributeName: string }) => `${fn}(${p.EntityMoniker['@odata.id']},${p.AttributeName})`,
    get: async (u: string, o: { headers?: Record<string, string> } = {}) => {
      if (u === `workflows(${WF})?$select=ismanaged`) {
        if (typeof st.managed === 'number') throw new DvError('The read failed.', st.managed);
        return { ismanaged: st.managed };
      }
      st.log.push(`read${o.headers?.Consistency === 'Strong' ? '' : ' (not strong)'}`);
      if (u !== `RetrieveLocLabels(workflows(${WF}),name)`) throw new DvError('Resource not found for the segment.', 404);
      const v = st.reads.get(++st.n) ?? st.name;
      if (typeof v === 'number') throw new DvError('The read failed.', v);
      return { Label: { LocalizedLabels: Object.entries(v).map(([l, x]) => ({ Label: x, LanguageCode: Number(l) })) } };
    },
    patch: async (u: string, body: { name: string }, o: { once?: boolean } = {}) => {
      st.log.push(`patch "${body.name}" in ${st.ui}${o.once ? ' once' : ''}`);
      if (u !== `workflows(${WF})`) throw new DvError('Resource not found for the segment.', 404);
      const f = st.fail.shift();
      if (f) throw new DvError(f === 429 ? 'Throttled.' : 'The update was refused.', f);
      st.name[st.ui] = body.name;
      const a = st.afterPatch;
      st.afterPatch = null;
      a?.();
    },
  };
  const batch = batchOf(http);
  http.batch = async (parts: never[], o: never) => {
    st.log.push('batch');
    const m = st.meanwhile;
    st.meanwhile = null;
    m?.();
    return batch(parts, o);
  };
  const ctx = { base: EN, user: FR, http };
  const lang = {
    run: async <T>(lcid: Lcid, fn: () => Promise<T>): Promise<T> => {
      const was = st.ui;
      st.ui = lcid;
      st.log.push(`[${lcid}`);
      try {
        return await fn();
      } finally {
        st.ui = was;
        st.log.push(']');
      }
    },
  };
  return Object.assign(st, { update: (olds?: string[]) => rebuildProcess(ctx as never, lang, WF, 'Processus test', undefined, olds) });
}

export function register(t: Kit): void {
  t.test('process update: the base-language name read, then one batch [name, PATCH name, name] in a base-language window; nothing to say', async () => {
    const r = rig({ [EN]: 'bpf test', [FR]: 'Processus test' });
    t.eq(await r.update(), '');
    t.eq(r.log, ['[1033', 'read', 'batch', 'read', 'patch "bpf test" in 1033 once', 'read', ']']);
    t.eq(r.name, { [EN]: 'bpf test', [FR]: 'Processus test' });
  });

  t.test("process update: a base-language name someone else saves between the read and the PATCH is seen in the batch's first read and put back, inside the same window; said", () =>
    fast(async () => {
      const r = rig({ [EN]: 'bpf test', [FR]: 'Processus test' });
      r.meanwhile = () => (r.name[EN] = 'BPF (Marie)');
      const said = await r.update();
      t.eq(r.name, { [EN]: 'BPF (Marie)', [FR]: 'Processus test' }, 'theirs, nothing else changed');
      t.eq(r.log.filter((x) => x.startsWith('patch')), ['patch "bpf test" in 1033 once', 'patch "BPF (Marie)" in 1033 once']);
      t.eq([r.log[0], r.log.at(-1)], ['[1033', ']'], 'both PATCHes in the base-language window');
      t.eq(said, 'Updating the process Processus test replaced its English name “BPF (Marie)”, which someone else saved at that moment, with “bpf test”; theirs is back. Check it.');
    }),
  );

  t.test('process update: putting their base-language name back is refused: said, with both names; one turned away is sent again', () =>
    fast(async () => {
      const r = rig({ [EN]: 'bpf test', [FR]: 'Processus test' });
      r.meanwhile = () => (r.name[EN] = 'BPF (Marie)');
      r.fail = [0, 400];
      const said = await r.update();
      t.eq(r.name[EN], 'bpf test');
      t.eq(said, 'Updating the process Processus test replaced its English name “BPF (Marie)”, which someone else saved at that moment, with “bpf test”, and putting theirs back failed (The update was refused). Check its English name.');

      const b = rig({ [EN]: 'bpf test', [FR]: 'Processus test' });
      b.meanwhile = () => (b.name[EN] = 'BPF (Marie)');
      b.fail = [0, 429];
      t.ok((await b.update()).endsWith('theirs is back. Check it.'));
      t.eq([b.name[EN], b.log.filter((x) => x.startsWith('patch')).length], ['BPF (Marie)', 3]);
    }),
  );

  t.test('process update: a base-language name someone saves right after the PATCH is newer: never put back over it, said', () =>
    fast(async () => {
      const r = rig({ [EN]: 'bpf test', [FR]: 'Processus test' });
      r.meanwhile = () => (r.name[EN] = 'BPF (Marie)');
      r.afterPatch = () => (r.name[EN] = 'BPF (Paul)');
      const said = await r.update();
      t.eq([r.name[EN], r.log.filter((x) => x.startsWith('patch')).length], ['BPF (Paul)', 1]);
      t.eq(said, 'Updating the process Processus test replaced its English name “BPF (Marie)”, which someone else saved at that moment, with “bpf test”; it now reads “BPF (Paul)”, so it was left as it is. Check it.');
    }),
  );

  t.test("process update: a put-back whose batch's first read shows yet another name someone saved right then says it replaced it", () =>
    fast(async () => {
      const r = rig({ [EN]: 'bpf test', [FR]: 'Processus test' });
      r.meanwhile = () => {
        r.name[EN] = 'BPF (Marie)';
        r.meanwhile = () => (r.name[EN] = 'BPF (Paul)');
      };
      const said = await r.update();
      t.eq(r.name[EN], 'BPF (Marie)');
      t.eq(said, 'Updating the process Processus test replaced its English name “BPF (Marie)”, which someone else saved at that moment, with “bpf test”; theirs is back, but putting it back replaced “BPF (Paul)”, which someone else saved right then. Check it.');
    }),
  );

  t.test('process update: the original PATCH is never sent again; one that fails throws (the saver keeps the save and says the page may show the old name)', async () => {
    const r = rig({ [EN]: 'bpf test', [FR]: 'Processus test' });
    r.fail = [500];
    let err: unknown = null;
    await r.update().catch((e) => (err = e));
    t.ok(err instanceof DvError && (err as DvError).status === 500, String(err));
    t.eq(r.log.filter((x) => x.startsWith('patch')), ['patch "bpf test" in 1033 once']);
  });

  t.test("process update: a batch read behind this save's own new English name (LIVE-FINDINGS 66) shows the name it replaced: no one else's, never put back", () =>
    fast(async () => {
      // This save wrote the English name "BPF v2" over "bpf test"; the batch's first read still shows "bpf test".
      const r = rig({ [EN]: 'BPF v2', [FR]: 'Processus test' });
      // Reads 1 and 2: before the window and in it; 3: the batch's first.
      r.reads.set(3, { [EN]: 'bpf test', [FR]: 'Processus test' });
      t.eq(await r.update(['bpf test']), '');
      t.eq(r.name, { [EN]: 'BPF v2', [FR]: 'Processus test' }, 'the new English name stays');
      t.eq(r.log.filter((x) => x.startsWith('patch')), ['patch "BPF v2" in 1033 once']);
    }),
  );

  t.test("process update: a read behind this save's own new English name is read again before the base-language window, never sent: the PATCH carries the new name", () =>
    fast(async () => {
      const r = rig({ [EN]: 'BPF v2', [FR]: 'Processus test' });
      r.reads.set(1, { [EN]: 'bpf test', [FR]: 'Processus test' });
      t.eq(await r.update(['bpf test']), '');
      t.eq(r.name[EN], 'BPF v2');
      t.eq(r.log, ['read', 'read', '[1033', 'read', 'batch', 'read', 'patch "BPF v2" in 1033 once', 'read', ']']);
    }),
  );

  t.test("process update: a read that stays behind this save's own new English name: nothing is sent and nothing switched (the saver says the page may show the old name); one in the window too", () =>
    fast(async () => {
      const r = rig({ [EN]: 'BPF v2', [FR]: 'Processus test' });
      for (let i = 1; i <= 9; i++) r.reads.set(i, { [EN]: 'bpf test', [FR]: 'Processus test' });
      let err: unknown = null;
      await r.update(['bpf test']).catch((e) => (err = e));
      t.ok(err instanceof DvError, String(err));
      t.eq([r.name[EN], r.log], ['BPF v2', ['read', 'read', 'read', 'read', 'read']]);

      const b = rig({ [EN]: 'BPF v2', [FR]: 'Processus test' });
      b.reads.set(2, { [EN]: 'bpf test', [FR]: 'Processus test' });
      err = null;
      await b.update(['bpf test']).catch((e) => (err = e));
      t.ok(err instanceof DvError, String(err));
      t.eq(b.log, ['read', '[1033', 'read', ']']);
    }),
  );

  t.test("process update: a batch read behind this save's new French name is no change of Dataverse's doing: nothing said (the read after is measured from both reads before it)", async () => {
    const r = rig({ [EN]: 'bpf test', [FR]: 'Processus FR' });
    r.reads.set(2, { [EN]: 'bpf test', [FR]: 'Processus test' });
    t.eq(await r.update(), '');
    t.eq(r.name, { [EN]: 'bpf test', [FR]: 'Processus FR' });
  });

  t.test("process update: a read after the PATCH behind this save's own new English name says nothing of a name saved after the PATCH: someone else's name it replaced still goes back", () =>
    fast(async () => {
      const r = rig({ [EN]: 'BPF v2', [FR]: 'Processus test' });
      r.meanwhile = () => (r.name[EN] = 'BPF (Marie)');
      // Reads 1 and 2 before the batch, 3 its first, 4 its last: still showing the name this save replaced.
      r.reads.set(4, { [EN]: 'bpf test', [FR]: 'Processus test' });
      const said = await r.update(['bpf test']);
      t.eq(r.name, { [EN]: 'BPF (Marie)', [FR]: 'Processus test' });
      t.eq(said, 'Updating the process Processus test replaced its English name “BPF (Marie)”, which someone else saved at that moment, with “BPF v2”; theirs is back. Check it.');
    }),
  );

  t.test('process update: a process from a managed solution is never updated (that PATCH would be an unmanaged layer on it): it rejects before anything is read, switched or sent; so does a process whose ismanaged could not be read', async () => {
    const r = rig({ [EN]: 'bpf test', [FR]: 'Processus test' });
    r.managed = true;
    const err = await r.update().then(() => null, (e: unknown) => e);
    t.ok(err instanceof DvError && err.code === 'managed' && err.message.endsWith(MANAGED), String(err));
    t.eq([r.log, r.name], [[], { [EN]: 'bpf test', [FR]: 'Processus test' }], 'nothing read, no window, no PATCH');
    const b = rig({ [EN]: 'bpf test', [FR]: 'Processus test' });
    b.managed = 503;
    const err2 = await b.update().then(() => null, (e: unknown) => e);
    t.ok(err2 instanceof DvError && err2.status === 503, String(err2));
    t.eq(b.log, []);
  });
}
