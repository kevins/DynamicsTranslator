// Someone else saving between a metadata writer's read and its write (src/providers/metadata.ts Probe, race(), putBack()),
// on a fake Dataverse that runs a $batch's parts in order and stops at a failed one when sent without continue-on-error
// (LIVE-FINDINGS 49). A PUT carries every language of the labels it writes as read (finding 2), so what someone saved
// in another language after that read is put back by it: the solution layers read in the write's batch say what it was,
// and it is written back. register() is called by tools/dev/unit.ts.
import { DvError, type BatchPart, type PartResult } from '../../../src/core/http';
import { toLabels } from '../../../src/core/labels';
import { PublishSet, type Change, type ChangeResult, type Labels, type Slot } from '../../../src/core/model';
import { metadataWriters } from '../../../src/providers/metadata';
import { changeId } from '../../../src/providers/types';
import type { Kit } from './kit';
import { fast } from './lang';

const EN = 1033;
const FR = 1036;
const DE = 1031;
const ID = '5e1f2a3b-1111-4222-8333-944455556666';

const lab = (l: Labels) => ({ LocalizedLabels: Object.entries(l).map(([k, v]) => ({ Label: v, LanguageCode: Number(k) })) });
const part = (status: number, data: unknown = null, error?: string): PartResult => ({ ok: status > 0 && status < 300, status, data, error, code: '', headers: {} });

type Props = Record<string, Labels>;

/**
 * A component on a fake Dataverse: `db` is the database. Reads answer it (`stale`, when set, answers the plain reads
 * instead: a read lagging behind); the layers answer it as one Active layer (an unmanaged component), unless refused.
 * `meanwhile` runs once when the next write batch arrives, before its reads (someone saving after the writer's read);
 * `failRead`: the status of the next batch's first read; `refuseWrite`: the status every write part is refused with
 * (nothing applied). `apply` applies a write's body to `db`. `ran` is the saves' SaveOptions.ran.
 */
function rig(kind: 'attribute' | 'relationship' | 'option', db: Props) {
  const st = {
    db,
    stale: null as Props | null,
    meanwhile: null as null | (() => void),
    failRead: 0,
    layers: 'db' as 'db' | 'forbidden',
    /** Write batches (1 = the first) whose answer is lost (a 504) after their parts ran. */
    lose: [] as number[],
    refuseWrite: 0,
    ran: new Set<string>(),
    writes: [] as any[],
    batches: [] as string[][],
    said: [] as string[],
  };
  const menu = (l: Labels) => ({ Behavior: 'UseLabel', Group: 'Details', Order: 10000, Label: lab(l) });
  const view = (v: Props): any =>
    kind === 'attribute'
      ? { '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata', MetadataId: ID, LogicalName: 'name', DisplayName: lab(v.DisplayName), Description: lab(v.Description), IsCustomizable: { Value: true }, IsRenameable: { Value: true } }
      : kind === 'relationship'
        ? { '@odata.type': '#Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata', MetadataId: ID, SchemaName: 'acc_con', Entity1LogicalName: 'account', Entity2LogicalName: 'contact', IsCustomizable: { Value: true }, Entity1AssociatedMenuConfiguration: menu(v['1']), Entity2AssociatedMenuConfiguration: menu(v['2']) }
        : { LogicalName: 'k', IsCustomizable: { Value: true }, OptionSet: { Options: [{ Value: 1, Label: lab(v.Label), Description: lab(v.Description) }] } };
  const layersNow = () => {
    if (st.layers === 'forbidden') throw new DvError('You do not have permission to do this.', 403);
    const labels = Object.fromEntries(Object.entries(db).map(([p, l]) => [p, JSON.stringify({ LocalizedLabels: Object.fromEntries(Object.entries(l).map(([k, v]) => [k, { LocalizedLabel: v }])) })]));
    return { value: [{ msdyn_solutionname: 'Active', msdyn_order: 0, msdyn_changes: JSON.stringify({ Attributes: Object.entries(labels).map(([p, v]) => ({ Key: `${p} - LocalizedLabel`, Value: v })) }) }] };
  };
  const apply = (body: any) => {
    st.writes.push(body);
    if (kind === 'attribute') for (const p of ['DisplayName', 'Description']) for (const l of body[p]?.LocalizedLabels || []) db[p][l.LanguageCode] = l.Label;
    if (kind === 'relationship') {
      db['1'] = toLabels(body.Entity1AssociatedMenuConfiguration.Label);
      db['2'] = toLabels(body.Entity2AssociatedMenuConfiguration.Label);
    }
    if (kind === 'option') for (const p of ['Label', 'Description']) for (const l of body[p]?.LocalizedLabels || []) db[p][l.LanguageCode] = l.Label;
  };
  const http = {
    get: async (url: string) => (url.startsWith('msdyn_componentlayers') ? layersNow() : view(st.stale ?? db)),
    put: async (_u: string, body: any) => apply(body),
    post: async (_u: string, body: any) => apply(body),
    batch: async (parts: BatchPart[], o: { stop?: boolean } = {}) => {
      st.batches.push(parts.map((p) => `${p.method} ${p.url.replace(/\?.*$/, '').replace(/\(.*$/, '')}`));
      const m = st.meanwhile;
      st.meanwhile = null;
      m?.();
      const out: PartResult[] = [];
      for (const [i, p] of parts.entries()) {
        if (p.method === 'GET') {
          if (i === 0 && st.failRead) {
            out.push(part(st.failRead, null, 'Service unavailable.'));
            st.failRead = 0;
            if (o.stop) break;
            continue;
          }
          try {
            out.push(part(200, p.url.startsWith('msdyn_componentlayers') ? layersNow() : view(db)));
          } catch (e) {
            out.push(part((e as DvError).status, null, (e as Error).message));
            if (o.stop) break;
          }
        } else if (st.refuseWrite) {
          out.push(part(st.refuseWrite, null, st.refuseWrite === 429 ? 'Number of requests exceeded the limit.' : 'You do not have permission to do this.'));
          if (o.stop) break;
        } else {
          apply(p.body);
          out.push(part(204));
        }
      }
      while (out.length < parts.length) out.push(part(0, null, 'Dataverse sent no answer for this part of the request.'));
      if (st.lose.includes(st.batches.length)) throw new DvError('Gateway timeout', 504);
      return out;
    },
  };
  const group = `${kind}|race|${Math.random()}`;
  const ctx = { http, base: EN, user: FR, orgId: `race-${group}`, langs: [EN, FR, DE].map((l) => ({ lcid: l, name: String(l), isBase: l === EN })) };
  const slot = (prop: string) => {
    const s = { key: `${group}|${prop}`, kind, prop, entity: 'team', comp: group, group, title: 'Team name', path: [], sub: '', labels: { ...db[prop] }, readOnly: '', baseRequired: prop !== 'Description', max: 0, order: 0 };
    const ref = kind === 'attribute' ? { entity: 'team', attribute: 'name', metadataId: ID } : kind === 'relationship' ? { metadataId: ID, type: 'ManyToMany', side: Number(prop) } : { entity: 'team', attribute: 'k', value: 1, cast: 'Picklist' };
    return { ...s, prop: kind === 'relationship' ? 'Label' : prop, key: `${group}|${prop}`, comp: kind === 'relationship' ? `${group}|${prop}` : group, ref } as unknown as Slot;
  };
  const w = metadataWriters.find((x) => x.kinds.includes(kind))!;
  const save = (cs: Change[]): Promise<ChangeResult[]> =>
    w.save(ctx as never, cs, { signal: new AbortController().signal, publish: new PublishSet(), progress: (m: string) => void st.said.push(m), force: new Set<string>(), ran: st.ran, lang: null as never, allowPublish: true });
  return Object.assign(st, { slot, save });
}

const change = (slot: Slot, lcid: number, after: string, before = slot.labels[lcid] ?? ''): Change => ({ slot, lcid, before, after });

export function register(t: Kit): void {
  t.test('metadata race: a German name someone saves between the read and the PUT is put back with the database\'s languages; our French is saved', () =>
    fast(async () => {
      const r = rig('attribute', { DisplayName: { [EN]: 'Team name', [FR]: 'Nom', [DE]: 'Teamname' }, Description: { [EN]: 'The team.' } });
      r.meanwhile = () => (r.db.DisplayName[DE] = 'Name des Teams');
      const res = await r.save([change(r.slot('DisplayName'), FR, "Nom de l'équipe")]);
      t.eq(res.map((x) => [x.outcome, x.message]), [['saved', undefined]]);
      t.eq(r.db.DisplayName, { [EN]: 'Team name', [FR]: "Nom de l'équipe", [DE]: 'Name des Teams' }, 'theirs and ours');
      // The PUT sent the German it read (finding 2: every language), then the German they saved went back, all languages again.
      t.eq(r.writes.map((b) => toLabels(b.DisplayName)), [
        { [EN]: 'Team name', [FR]: "Nom de l'équipe", [DE]: 'Teamname' },
        { [EN]: 'Team name', [FR]: "Nom de l'équipe", [DE]: 'Name des Teams' },
      ]);
      t.eq(r.batches[0], ['GET EntityDefinitions', 'GET msdyn_componentlayers', 'PUT EntityDefinitions'], 'the read and the layers right before the write, in its batch');
    }),
  );

  t.test('metadata race: a French name someone saves between the read and the PUT is put back and the change is a conflict; the same text from both is saved', () =>
    fast(async () => {
      const r = rig('attribute', { DisplayName: { [EN]: 'Team name', [FR]: 'Nom' }, Description: { [EN]: 'The team.' } });
      r.meanwhile = () => (r.db.DisplayName[FR] = 'Nom (collègue)');
      const res = await r.save([change(r.slot('DisplayName'), FR, "Nom de l'équipe")]);
      t.eq(res.map((x) => [x.outcome, x.server]), [['conflict', 'Nom (collègue)']]);
      t.eq(r.db.DisplayName, { [EN]: 'Team name', [FR]: 'Nom (collègue)' });
      t.eq(r.writes.length, 2);

      const b = rig('attribute', { DisplayName: { [EN]: 'Team name', [FR]: 'Nom' }, Description: { [EN]: 'The team.' } });
      b.meanwhile = () => (b.db.DisplayName[FR] = "Nom de l'équipe");
      t.eq((await b.save([change(b.slot('DisplayName'), FR, "Nom de l'équipe")])).map((x) => x.outcome), ['saved']);
      t.eq(b.writes.length, 1, 'nothing to put back');
    }),
  );

  t.test("metadata race: a put-back whose answer was lost (with the reads in its batch) is never plainly saved: a save made right before it can't be ruled out", () =>
    fast(async () => {
      const r = rig('attribute', { DisplayName: { [EN]: 'Team name', [FR]: 'Nom', [DE]: 'Teamname' }, Description: { [EN]: 'The team.' } });
      // B saves the German between the read and the PUT; C saves it again between the layers read and the PUT that puts B's back.
      r.meanwhile = () => {
        r.db.DisplayName[DE] = 'Name des Teams';
        r.meanwhile = () => (r.db.DisplayName[DE] = 'Name (C)');
      };
      r.lose = [2];
      const res = await r.save([change(r.slot('DisplayName'), FR, "Nom de l'équipe")]);
      t.eq(r.db.DisplayName[DE], 'Name des Teams', "C's German was written over, unseen: Dataverse lost the answer with the read before it");
      t.eq(res[0].outcome, 'error');
      t.ok(/^Saved, but this save put back “Teamname” over someone else's German text “Name des Teams”; theirs is back, but Dataverse's answer to that was lost, so a save made at that moment can't be ruled out. Check it.$/.test(res[0].message!), res[0].message);

      // The same in the language this save edits: a conflict, which says so too.
      const b = rig('attribute', { DisplayName: { [EN]: 'Team name', [FR]: 'Nom' }, Description: { [EN]: 'The team.' } });
      b.meanwhile = () => (b.db.DisplayName[FR] = 'Nom (collègue)');
      b.lose = [2];
      const rb = await b.save([change(b.slot('DisplayName'), FR, "Nom de l'équipe")]);
      t.eq([rb[0].outcome, rb[0].server, b.db.DisplayName[FR]], ['conflict', 'Nom (collègue)', 'Nom (collègue)']);
      t.ok(/can't be ruled out/.test(rb[0].message!), rb[0].message);
    }),
  );

  t.test("metadata writer: SaveOptions.ran names a change whose PUT ran or whose answer was lost, never one not sent (a read in its batch refused), refused (403) or turned away unrun (429): a Try again finding it as asked takes only those for this save's", () =>
    fast(async () => {
      const attempt = async (set: (r: ReturnType<typeof rig>) => void): Promise<[string, number, boolean[]]> => {
        const r = rig('attribute', { DisplayName: { [EN]: 'Team name', [FR]: 'Nom' }, Description: { [EN]: 'The team.' } });
        set(r);
        const c = change(r.slot('DisplayName'), FR, "Nom de l'équipe");
        const res = await r.save([c]).catch((e: Error): ChangeResult[] => [{ change: c, outcome: 'error', message: `thrown: ${e.message}` }]);
        return [res[0].message?.startsWith('thrown') ? 'thrown' : res[0].outcome, r.writes.length, [...r.ran].map((id) => id === changeId(c))];
      };
      t.eq(await attempt(() => {}), ['saved', 1, [true]], 'saved');
      const [lost, wrote, ran] = await attempt((r) => (r.lose = [1]));
      t.eq([wrote, ran], [1, [true]], `its answer lost once it ran (${lost})`);
      // Refused or turned away, it fails (the writer throws): nothing was written.
      for (const [status, why] of [[403, 'refused'], [429, 'turned away unrun, every time']] as const) {
        const [how, n, ids] = await attempt((r) => (r.refuseWrite = status));
        t.eq([how === 'error' || how === 'thrown', n, ids], [true, 0, []], why);
      }
      t.eq(await attempt((r) => (r.failRead = 404)), ['thrown', 0, []], 'stopped by a read in its batch: never sent');
    }),
  );

  t.test('metadata race: nobody else at work: one batch (read, layers, write), no second write', async () => {
    const r = rig('attribute', { DisplayName: { [EN]: 'Team name', [FR]: 'Nom' }, Description: { [EN]: 'The team.' } });
    const res = await r.save([change(r.slot('DisplayName'), FR, "Nom de l'équipe"), change(r.slot('Description'), FR, "L'équipe.")]);
    t.eq(res.map((x) => x.outcome), ['saved', 'saved']);
    t.eq([r.batches.length, r.writes.length], [1, 1]);
  });

  t.test('metadata race: without the layers (no rights) the read in the batch is the only witness: a German name it shows saved meanwhile is reported, never written back', () =>
    fast(async () => {
      const r = rig('attribute', { DisplayName: { [EN]: 'Team name', [FR]: 'Nom', [DE]: 'Teamname' }, Description: { [EN]: 'The team.' } });
      r.layers = 'forbidden';
      r.meanwhile = () => (r.db.DisplayName[DE] = 'Name des Teams');
      const res = await r.save([change(r.slot('DisplayName'), FR, "Nom de l'équipe")]);
      t.eq(res[0].outcome, 'error');
      t.ok(/^Saved, but Dataverse showed the German text “Name des Teams” right before this save, so someone else may have saved it at the same moment, and this save put back “Teamname”\. Check it\.$/.test(res[0].message!), res[0].message);
      t.eq([r.writes.length, r.db.DisplayName[DE]], [1, 'Teamname']);
      // The refused layers stopped the first batch before its write: sent again at once without them, and left out after.
      t.eq(r.batches.map((b) => b.length), [3, 2]);
      await r.save([change(r.slot('DisplayName'), FR, 'Nom 2', "Nom de l'équipe")]);
      t.eq(r.batches.map((b) => b.length), [3, 2, 2]);
    }),
  );

  t.test("metadata race: a read in the batch that looks behind this page's last save (a text that save replaced is back) still says what else someone saved there", () =>
    fast(async () => {
      const r = rig('attribute', { DisplayName: { [EN]: 'Team name', [FR]: 'Nom', [DE]: 'Teamname' }, Description: { [EN]: 'The team.' } });
      r.layers = 'forbidden';
      t.eq((await r.save([change(r.slot('DisplayName'), FR, 'Nom 1')])).map((x) => x.outcome), ['saved']);
      // Between the next save's read and its PUT, someone puts the French back and saves the English.
      r.meanwhile = () => {
        r.db.DisplayName[FR] = 'Nom';
        r.db.DisplayName[EN] = 'Team (theirs)';
      };
      const res = await r.save([change(r.slot('DisplayName'), DE, 'Teamname 2', 'Teamname')]);
      t.eq(res[0].outcome, 'error', 'never plainly saved');
      t.ok(/Dataverse showed the English text “Team \(theirs\)” right before this save/.test(res[0].message!), res[0].message);
    }),
  );

  t.test('metadata race: when the read in the write batch fails, the write is never sent and the save starts again from a new read', () =>
    fast(async () => {
      const r = rig('attribute', { DisplayName: { [EN]: 'Team name', [FR]: 'Nom' }, Description: { [EN]: 'The team.' } });
      r.failRead = 503;
      const res = await r.save([change(r.slot('DisplayName'), FR, "Nom de l'équipe")]);
      t.eq(res.map((x) => x.outcome), ['saved']);
      t.eq([r.batches.length, r.writes.length], [2, 1]);
      const b = rig('attribute', { DisplayName: { [EN]: 'Team name', [FR]: 'Nom' }, Description: { [EN]: 'The team.' } });
      b.failRead = 404;
      let err: unknown = null;
      await b.save([change(b.slot('DisplayName'), FR, "Nom de l'équipe")]).catch((e) => (err = e));
      t.ok(err instanceof DvError && /right before saving, so nothing was saved/.test((err as Error).message), String(err));
      t.eq(b.writes.length, 0);
    }),
  );

  t.test('metadata race: a choice option action sends only its languages: the same language saved meanwhile is reported (no layers for options), another one is never touched', () =>
    fast(async () => {
      const r = rig('option', { Label: { [EN]: 'Open', [FR]: 'Ouvert', [DE]: 'Offen' }, Description: { [EN]: 'Open item' } });
      r.meanwhile = () => (r.db.Label[DE] = 'Geöffnet');
      t.eq((await r.save([change(r.slot('Label'), FR, 'Ouverte')])).map((x) => x.outcome), ['saved']);
      t.eq(r.db.Label, { [EN]: 'Open', [FR]: 'Ouverte', [DE]: 'Geöffnet' });
      r.meanwhile = () => (r.db.Label[FR] = 'Ouvert (collègue)');
      const res = await r.save([change(r.slot('Label'), FR, 'Ouvert 3', 'Ouverte')]);
      t.eq(res[0].outcome, 'error');
      t.ok(/^Dataverse showed “Ouvert \(collègue\)” here right before this save: someone else may have saved it at the same moment, and this save replaced it\./.test(res[0].message!), res[0].message);
    }),
  );

  t.test("metadata race: a relationship PUT sends its whole definition: the other side's label someone saves meanwhile is reported, never silently put back", () =>
    fast(async () => {
      const r = rig('relationship', { '1': { [EN]: 'Contacts', [FR]: 'Contacts' }, '2': { [EN]: 'Accounts', [FR]: 'Comptes' } });
      r.meanwhile = () => (r.db['2'][FR] = 'Comptes (collègue)');
      const res = await r.save([change(r.slot('1'), FR, 'Les contacts')]);
      t.eq(res[0].outcome, 'error');
      t.ok(/someone else changed this relationship at the same moment, and this save may have put back what it had before/.test(res[0].message!), res[0].message);
    }),
  );
}
