// What a metadata write sends back besides the labels it edits, against a fake Dataverse that runs a $batch's parts in
// order (src/providers/metadata.ts Probe, keepDefault, request()). UpdateStateValue carries the state's default status
// reason as flowOnce read it (a label sent alone could reset it): one someone else set between that read and the write
// is put back and said, never plainly saved. And the solution layers, the witness that can't
// lag, asked again when they failed for a moment, so someone else's text the write sent back is written back rather than
// only said. register() is called by tools/dev/unit.ts.
import type { BatchPart, PartResult } from '../../../src/core/http';
import { toLabels } from '../../../src/core/labels';
import { PublishSet, type Change, type ChangeResult, type Labels, type Slot } from '../../../src/core/model';
import { metadataWriters } from '../../../src/providers/metadata';
import type { Kit } from './kit';
import { fast } from './lang';

const EN = 1033;
const FR = 1036;
const DE = 1031;
const OPEN = 1;
const WAITING = 100000000;
const HOLD = 100000001;
const ID = '7a1f2a3b-1111-4222-8333-944455556666';

const lab = (l: Labels) => ({ LocalizedLabels: Object.entries(l).map(([k, v]) => ({ Label: v, LanguageCode: Number(k) })) });
const part = (status: number, data: unknown = null, error?: string): PartResult => ({ ok: status > 0 && status < 300, status, data, error, code: '', headers: {} });
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));

interface State {
  Label: Labels;
  Description: Labels;
  DefaultStatus: number;
}

/**
 * State 0 (Active) of a table's statecode on a fake Dataverse: `db` is the database. Reads answer it (`stale`, when set,
 * answers the reads in write batches instead: a read lagging behind). UpdateStateValue merges the languages it carries
 * and sets DefaultStatusCode when it has one. `meanwhile` runs once when the next write batch arrives, before its read
 * (someone saving after the writer's read); `afterWrite` once right after the next UpdateStateValue; `fail` the status
 * the action answers in those write batches (1 = the first), nothing applied.
 */
function rig(db: State) {
  const st = {
    db,
    stale: null as State | null,
    meanwhile: null as null | (() => void),
    afterWrite: null as null | (() => void),
    fail: new Map<number, number>(),
    actions: [] as any[],
    batches: [] as string[][],
    said: [] as string[],
  };
  const view = (v: State) => ({
    LogicalName: 'statecode',
    IsCustomizable: { Value: true },
    IsManaged: false,
    OptionSet: {
      Options: [
        { Value: 0, Label: lab(v.Label), Description: lab(v.Description), DefaultStatus: v.DefaultStatus },
        { Value: 1, Label: lab({ [EN]: 'Inactive', [FR]: 'Inactif' }), Description: lab({}), DefaultStatus: 2 },
      ],
    },
  });
  // The status reasons (statuscode), whose names the messages give.
  const reasons = {
    LogicalName: 'statuscode',
    OptionSet: {
      Options: [
        { Value: OPEN, State: 0, Label: lab({ [EN]: 'Open', [FR]: 'Ouvert' }) },
        { Value: WAITING, State: 0, Label: lab({ [EN]: 'Waiting', [FR]: 'En attente' }) },
        { Value: HOLD, State: 0, Label: lab({ [EN]: 'On hold', [FR]: 'En pause' }) },
        { Value: 2, State: 1, Label: lab({ [EN]: 'Closed', [FR]: 'Fermé' }) },
      ],
    },
  };
  const apply = (body: any) => {
    st.actions.push(copy(body));
    for (const p of ['Label', 'Description'] as const) for (const l of body[p]?.LocalizedLabels || []) db[p][l.LanguageCode] = l.Label;
    if (body.DefaultStatusCode != null) db.DefaultStatus = body.DefaultStatusCode;
  };
  const http = {
    get: async (url: string) => (url.includes('StatusAttributeMetadata') ? copy(reasons) : view(db)),
    post: async () => {
      throw new Error('every write goes in a batch behind a read');
    },
    batch: async (parts: BatchPart[], o: { stop?: boolean } = {}) => {
      st.batches.push(parts.map((p) => `${p.method} ${p.url.replace(/\?.*$/, '').replace(/\(.*$/, '')}`));
      const m = st.meanwhile;
      st.meanwhile = null;
      m?.();
      const out: PartResult[] = [];
      for (const p of parts) {
        if (p.method === 'GET') {
          out.push(part(200, view(st.stale ?? db)));
          continue;
        }
        const f = st.fail.get(st.batches.length);
        if (f) {
          out.push(part(f, null, f === 429 ? 'Throttled.' : 'The action failed.'));
          if (o.stop) break;
          continue;
        }
        apply(p.body);
        out.push(part(204));
        const a = st.afterWrite;
        st.afterWrite = null;
        a?.();
      }
      while (out.length < parts.length) out.push(part(0, null, 'Dataverse sent no answer for this part of the request.'));
      return out;
    },
  };
  const group = `state|t|${Math.random()}`;
  const ctx = { http, base: EN, user: FR, orgId: `state-${group}`, langs: [EN, FR, DE].map((l) => ({ lcid: l, name: String(l), isBase: l === EN })) };
  const slot = (prop: 'Label' | 'Description') =>
    ({
      key: `${group}|${prop}`,
      kind: 'state',
      prop,
      entity: 'cr_audit',
      comp: group,
      group,
      title: 'Active',
      path: [],
      sub: '',
      labels: { ...db[prop] },
      readOnly: '',
      baseRequired: prop !== 'Description',
      max: 0,
      order: 0,
      ref: { entity: 'cr_audit', attribute: 'statecode', value: 0, cast: 'State' },
    }) as unknown as Slot;
  const w = metadataWriters.find((x) => x.kinds.includes('state'))!;
  const save = (cs: Change[]): Promise<ChangeResult[]> =>
    w.save(ctx as never, cs, { signal: new AbortController().signal, publish: new PublishSet(), progress: (m: string) => void st.said.push(m), force: new Set<string>(), lang: null as never, allowPublish: true });
  return Object.assign(st, { slot, save });
}

const change = (slot: Slot, lcid: number, after: string, before = slot.labels[lcid] ?? ''): Change => ({ slot, lcid, before, after });
const fresh = (): State => ({ Label: { [EN]: 'Active', [FR]: 'Actif' }, Description: { [EN]: 'Open item' }, DefaultStatus: OPEN });
const labels = (a: any) => toLabels(a.Label);

/** A column on a fake Dataverse whose solution layers fail with `flaky` statuses (in order) before they answer. */
function column(db: Record<string, Labels>, flaky: number[]) {
  const st = { db, flaky: [...flaky], meanwhile: null as null | (() => void), writes: [] as any[], batches: [] as string[][] };
  const view = () => ({ '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata', MetadataId: ID, LogicalName: 'name', DisplayName: lab(db.DisplayName), Description: lab(db.Description), IsCustomizable: { Value: true }, IsRenameable: { Value: true } });
  const layers = () => {
    const props = Object.fromEntries(Object.entries(db).map(([p, l]) => [p, JSON.stringify({ LocalizedLabels: Object.fromEntries(Object.entries(l).map(([k, v]) => [k, { LocalizedLabel: v }])) })]));
    return { value: [{ msdyn_solutionname: 'Active', msdyn_order: 0, msdyn_changes: JSON.stringify({ Attributes: Object.entries(props).map(([p, v]) => ({ Key: `${p} - LocalizedLabel`, Value: v })) }) }] };
  };
  const http = {
    get: async (url: string) => (url.startsWith('msdyn_componentlayers') ? layers() : view()),
    batch: async (parts: BatchPart[], o: { stop?: boolean } = {}) => {
      st.batches.push(parts.map((p) => `${p.method} ${p.url.replace(/\?.*$/, '').replace(/\(.*$/, '')}`));
      const m = st.meanwhile;
      st.meanwhile = null;
      m?.();
      const out: PartResult[] = [];
      for (const p of parts) {
        if (p.method !== 'GET') {
          st.writes.push(p.body);
          for (const k of ['DisplayName', 'Description']) for (const l of (p.body as any)[k]?.LocalizedLabels || []) db[k][l.LanguageCode] = l.Label;
          out.push(part(204));
        } else if (!p.url.startsWith('msdyn_componentlayers')) out.push(part(200, view()));
        else if (st.flaky.length) {
          out.push(part(st.flaky.shift()!, null, 'Service unavailable.'));
          if (o.stop) break;
        } else out.push(part(200, layers()));
      }
      while (out.length < parts.length) out.push(part(0, null, 'Dataverse sent no answer for this part of the request.'));
      return out;
    },
  };
  const group = `attribute|t|${Math.random()}`;
  const ctx = { http, base: EN, user: FR, orgId: `col-${group}`, langs: [EN, FR, DE].map((l) => ({ lcid: l, name: String(l), isBase: l === EN })) };
  const slot = (prop: string) =>
    ({ key: `${group}|${prop}`, kind: 'attribute', prop, entity: 'team', comp: group, group, title: 'Team name', path: [], sub: '', labels: { ...db[prop] }, readOnly: '', baseRequired: prop !== 'Description', max: 0, order: 0, ref: { entity: 'team', attribute: 'name', metadataId: ID } }) as unknown as Slot;
  const w = metadataWriters.find((x) => x.kinds.includes('attribute'))!;
  const save = (cs: Change[], signal = new AbortController().signal): Promise<ChangeResult[]> =>
    w.save(ctx as never, cs, { signal, publish: new PublishSet(), progress() {}, force: new Set<string>(), lang: null as never, allowPublish: true });
  return Object.assign(st, { slot, save });
}

export function register(t: Kit): void {
  t.test('state default: nobody else at work: one batch (read, UpdateStateValue) carrying the default status reason as read; saved', async () => {
    const r = rig(fresh());
    const res = await r.save([change(r.slot('Label'), FR, 'Active (FR)')]);
    t.eq(res.map((x) => [x.outcome, x.message]), [['saved', undefined]]);
    t.eq(r.batches, [['GET EntityDefinitions', 'POST UpdateStateValue']]);
    t.eq(r.actions.map((a) => [labels(a), a.DefaultStatusCode, a.MergeLabels]), [[{ [EN]: 'Active', [FR]: 'Active (FR)' }, OPEN, true]]);
    t.eq(r.db.DefaultStatus, OPEN);
  });

  t.test("state default: a default status reason someone else sets between the read and the write is put back (their default, the labels just written) and said, never plainly saved; the translation stays", () =>
    fast(async () => {
      const r = rig(fresh());
      r.meanwhile = () => (r.db.DefaultStatus = WAITING);
      const res = await r.save([change(r.slot('Label'), FR, 'Active (FR)')]);
      t.eq([r.db.DefaultStatus, r.db.Label], [WAITING, { [EN]: 'Active', [FR]: 'Active (FR)' }], 'theirs and ours');
      t.eq(r.actions.map((a) => [labels(a), a.DefaultStatusCode, a.MergeLabels, 'Description' in a]), [
        [{ [EN]: 'Active', [FR]: 'Active (FR)' }, OPEN, true, false],
        [{ [EN]: 'Active', [FR]: 'Active (FR)' }, WAITING, true, false],
      ]);
      t.eq(r.batches, [['GET EntityDefinitions', 'POST UpdateStateValue'], ['GET EntityDefinitions', 'POST UpdateStateValue']], 'the put-back in a batch behind its own read too');
      t.eq(res.map((x) => [x.outcome, x.message]), [
        ['error', "Saved, but someone else set this status's default status reason to “En attente” (100000000) at the same moment, and this save set it back to “Ouvert” (1); theirs is back. Check it."],
      ]);
    }),
  );

  t.test('state default: a description edit and a label edit in one write: both carry the note; the description is not sent again', () =>
    fast(async () => {
      const r = rig(fresh());
      r.meanwhile = () => (r.db.DefaultStatus = WAITING);
      const res = await r.save([change(r.slot('Label'), FR, 'Active (FR)'), change(r.slot('Description'), FR, 'Élément ouvert')]);
      t.eq(res.map((x) => x.outcome), ['error', 'error']);
      t.ok(res.every((x) => /theirs is back\. Check it\.$/.test(x.message!)), JSON.stringify(res.map((x) => x.message)));
      t.eq([r.db.DefaultStatus, r.db.Description], [WAITING, { [EN]: 'Open item', [FR]: 'Élément ouvert' }]);
      t.eq(r.actions.map((a) => 'Description' in a), [true, false]);
    }),
  );

  t.test('state default: a description-only edit sends no default status reason, so one someone else sets meanwhile is untouched: saved', () =>
    fast(async () => {
      const r = rig(fresh());
      r.meanwhile = () => (r.db.DefaultStatus = WAITING);
      const res = await r.save([change(r.slot('Description'), FR, 'Élément ouvert')]);
      t.eq(res.map((x) => [x.outcome, x.message]), [['saved', undefined]]);
      t.eq([r.actions.length, 'DefaultStatusCode' in r.actions[0], r.db.DefaultStatus], [1, false, WAITING]);
    }),
  );

  t.test('state default: one someone else sets again right after the write is newer: left as it is, and said with both', () =>
    fast(async () => {
      const r = rig(fresh());
      r.meanwhile = () => (r.db.DefaultStatus = WAITING);
      r.afterWrite = () => (r.db.DefaultStatus = HOLD);
      const res = await r.save([change(r.slot('Label'), FR, 'Active (FR)')]);
      t.eq([r.actions.length, r.db.DefaultStatus], [1, HOLD]);
      t.eq(res[0].outcome, 'error');
      t.ok(
        res[0].message!.includes("someone else set this status's default status reason to “En attente” (100000000) at the same moment, and this save set it back to “Ouvert” (1); it now shows “En pause” (100000001), so it was left as it is"),
        res[0].message,
      );
    }),
  );

  t.test("state default: a put-back whose own read shows a third default someone saved right then says it replaced theirs", () =>
    fast(async () => {
      const r = rig(fresh());
      r.meanwhile = () => {
        r.db.DefaultStatus = WAITING;
        r.meanwhile = () => (r.db.DefaultStatus = HOLD);
      };
      const res = await r.save([change(r.slot('Label'), FR, 'Active (FR)')]);
      t.eq([r.actions.length, r.db.DefaultStatus], [2, WAITING]);
      t.eq(res[0].outcome, 'error');
      t.ok(res[0].message!.includes('theirs is back, but putting it back replaced “En pause” (100000001), which someone else saved right then'), res[0].message);
    }),
  );

  t.test('state default: a put-back Dataverse refuses says so with both values; one turned away is sent again from a new read', () =>
    fast(async () => {
      const r = rig(fresh());
      r.meanwhile = () => (r.db.DefaultStatus = WAITING);
      r.fail.set(2, 400);
      const res = await r.save([change(r.slot('Label'), FR, 'Active (FR)')]);
      t.eq([r.actions.length, r.db.DefaultStatus], [1, OPEN]);
      t.eq(res[0].outcome, 'error');
      t.ok(/and this save set it back to “Ouvert” \(1\); putting theirs back failed \(The action failed\)\. Check it\.$/.test(res[0].message!), res[0].message);

      const b = rig(fresh());
      b.meanwhile = () => (b.db.DefaultStatus = WAITING);
      b.fail.set(2, 429);
      const rb = await b.save([change(b.slot('Label'), FR, 'Active (FR)')]);
      t.eq([b.actions.length, b.db.DefaultStatus, b.batches.length], [2, WAITING, 3]);
      t.ok(/theirs is back\. Check it\.$/.test(rb[0].message!), rb[0].message);
    }),
  );

  t.test("state default: an English label someone saves between the write and putting their default back is kept: the put-back carries it, never the text from before", () =>
    fast(async () => {
      const r = rig(fresh());
      r.meanwhile = () => (r.db.DefaultStatus = WAITING);
      r.afterWrite = () => (r.db.Label[EN] = 'Live');
      const res = await r.save([change(r.slot('Label'), FR, 'Active (FR)')]);
      t.eq([r.db.DefaultStatus, r.db.Label], [WAITING, { [EN]: 'Live', [FR]: 'Active (FR)' }], 'their default, their English, our French');
      t.eq(r.actions.map((a) => [labels(a), a.DefaultStatusCode]), [
        [{ [EN]: 'Active', [FR]: 'Active (FR)' }, OPEN],
        [{ [EN]: 'Live', [FR]: 'Active (FR)' }, WAITING],
      ]);
      t.eq(res[0].outcome, 'error');
      t.ok(/theirs is back/.test(res[0].message!) && /English text to "Live"/.test(res[0].message!), res[0].message);
    }),
  );

  t.test("state default: an English label someone saves right before the put-back (seen only in its batch's read) is said with both texts, never plainly saved", () =>
    fast(async () => {
      const r = rig(fresh());
      r.meanwhile = () => {
        r.db.DefaultStatus = WAITING;
        r.meanwhile = () => (r.db.Label[EN] = 'Live');
      };
      const res = await r.save([change(r.slot('Label'), FR, 'Active (FR)')]);
      t.eq([r.db.DefaultStatus, r.actions.length], [WAITING, 2]);
      t.eq(res[0].outcome, 'error');
      t.ok(res[0].message!.includes("putting it back also put back “Active” over someone else's English text “Live”"), res[0].message);
    }),
  );

  t.test("state default: a read in the write's batch behind this page's own last save (LIVE-FINDINGS 66) is said, never written back", () =>
    fast(async () => {
      const r = rig(fresh());
      t.eq((await r.save([change(r.slot('Label'), FR, 'Active (FR)')])).map((x) => x.outcome), ['saved']);
      // The next write's batch reads a state from before that save, with another default: a read that lags, maybe.
      r.stale = { ...fresh(), DefaultStatus: WAITING };
      const res = await r.save([change(r.slot('Label'), DE, 'Aktiv', '')]);
      t.eq([r.actions.length, r.db.DefaultStatus, r.db.Label], [2, OPEN, { [EN]: 'Active', [FR]: 'Active (FR)', [DE]: 'Aktiv' }]);
      t.eq(res[0].outcome, 'error');
      t.ok(/^Saved, but Dataverse showed the default status reason “En attente” \(100000000\) right before this save, so someone else may have changed it at the same moment, and this save set it back to “Ouvert” \(1\)\. Check it\.$/.test(res[0].message!), res[0].message);
    }),
  );

  t.test('state default: a default status reason that moved by the read after the write (not in the read before it) is never called saved', () =>
    fast(async () => {
      const r = rig(fresh());
      r.afterWrite = () => (r.db.DefaultStatus = HOLD);
      const res = await r.save([change(r.slot('Label'), FR, 'Active (FR)')]);
      t.eq([r.actions.length, res[0].outcome], [1, 'error']);
      t.ok(/default status reason/.test(res[0].message!), res[0].message);
    }),
  );

  t.test('metadata layers: layers that fail for a moment (503) are asked again before the write, so a German name someone saved meanwhile is written back, not only said', () =>
    fast(async () => {
      const r = column({ DisplayName: { [EN]: 'Team name', [FR]: 'Nom', [DE]: 'Teamname' }, Description: { [EN]: 'The team.' } }, [503]);
      r.meanwhile = () => (r.db.DisplayName[DE] = 'Name des Teams');
      const res = await r.save([change(r.slot('DisplayName'), FR, "Nom de l'équipe")]);
      t.eq(r.db.DisplayName, { [EN]: 'Team name', [FR]: "Nom de l'équipe", [DE]: 'Name des Teams' }, 'theirs and ours');
      t.eq(res.map((x) => x.outcome), ['saved']);
      t.eq(r.batches.slice(0, 2), [
        ['GET EntityDefinitions', 'GET msdyn_componentlayers', 'PUT EntityDefinitions'],
        ['GET EntityDefinitions', 'GET msdyn_componentlayers', 'PUT EntityDefinitions'],
      ], 'stopped at the failed layers (nothing written), then sent again with them');
    }),
  );

  t.test('metadata layers: layers still failing after two more tries: the write goes without them (said, not written back), and the next save asks for them again', () =>
    fast(async () => {
      const r = column({ DisplayName: { [EN]: 'Team name', [FR]: 'Nom', [DE]: 'Teamname' }, Description: { [EN]: 'The team.' } }, [503, 500, 503]);
      r.meanwhile = () => (r.db.DisplayName[DE] = 'Name des Teams');
      const res = await r.save([change(r.slot('DisplayName'), FR, "Nom de l'équipe")]);
      t.eq(res[0].outcome, 'error');
      t.ok(/^Saved, but Dataverse showed the German text “Name des Teams” right before this save, so someone else may have saved it at the same moment, and this save put back “Teamname”\. Check it\.$/.test(res[0].message!), res[0].message);
      t.eq(r.batches.map((b) => b.length), [3, 3, 3, 2]);
      await r.save([change(r.slot('DisplayName'), FR, 'Nom 2', "Nom de l'équipe")]);
      t.eq(r.batches.at(-1), ['GET EntityDefinitions', 'GET msdyn_componentlayers', 'PUT EntityDefinitions']);
    }),
  );

  t.test('metadata layers: Stop while waiting to ask the layers again writes nothing', async () => {
    const r = column({ DisplayName: { [EN]: 'Team name', [FR]: 'Nom' }, Description: { [EN]: 'The team.' } }, [503]);
    const stop = new AbortController();
    const p = r.save([change(r.slot('DisplayName'), FR, "Nom de l'équipe")], stop.signal);
    await new Promise((go) => setTimeout(go, 20));
    stop.abort();
    const res = await p;
    t.eq([res.map((x) => x.outcome), r.writes.length, r.db.DisplayName[FR]], [['skipped'], 0, 'Nom']);
  });
}
