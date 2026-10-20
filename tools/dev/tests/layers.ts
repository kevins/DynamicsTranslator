// The layer check of metadata saves (src/providers/layers.ts and its use in src/providers/metadata.ts): the solution layers
// that msdyn_componentlayers reads from the database tell a write Dataverse applied, while the metadata reads still show
// the text from before it (LIVE-FINDINGS 66), from one it did not apply. Then the write log behind "Copy details".
import { DvError } from '../../../src/core/http';
import { PublishSet, type Change, type ChangeResult, type Labels, type Slot } from '../../../src/core/model';
import { parseLayers, readLayers, type LayerKind } from '../../../src/providers/layers';
import { metadataWriters } from '../../../src/providers/metadata';
import { logWrite, writeDetails, writesOf } from '../../../src/providers/writelog';
import type { Kit } from './kit';
import { fast } from './lang';
import { batchOf } from './records';

const EN = 1033;
const FR = 1036;
const DE = 1031;
const ID = '0b9f3c3e-1111-4222-8333-944455556666';
const OLD = 'Nom de l’équipes';
const NEW = "Nom de l'équipe";

const lab = (l: Labels) => ({ LocalizedLabels: Object.entries(l).map(([k, v]) => ({ Label: v, LanguageCode: Number(k) })) });
/** One msdyn_componentlayers row as Dataverse answers it: msdyn_changes holds each label as a JSON string. */
const row = (name: string, order: number, labels: Record<string, Labels>, modifiedon = '') => ({
  msdyn_solutionname: name,
  msdyn_order: order,
  msdyn_changes: JSON.stringify({
    Attributes: [
      ...(modifiedon ? [{ Key: 'modifiedon', Value: modifiedon }] : []),
      { Key: 'logicalname', Value: 'name' },
      ...Object.entries(labels).map(([k, l]) => ({
        Key: `${k} - LocalizedLabel`,
        Value: JSON.stringify({ LocalizedLabels: Object.fromEntries(Object.entries(l).map(([lc, t]) => [lc, { LocalizedLabel: t, Description: '', ComponentState: 0 }])) }),
      })),
    ],
  }),
});

type Props = Record<string, Labels>;
const copy = (p: Props): Props => JSON.parse(JSON.stringify(p));

/**
 * A table, column or global choice on a fake Dataverse. `db` is the database; a metadata read answers `stale` instead while
 * it is set (the user's Edge: the text from before a write, for many seconds). The layers always answer the database: a
 * System layer with the first state, the Active layer with every language changed since (a managed component), unless
 * `layers` says otherwise. `queue`: states the next metadata reads answer, one each. `modes`: what the next writes do
 * ('ok' applies, 'drop' answers 204 and applies nothing, 'late' answers 204 and applies 3 s later, 'trap' also writes the
 * text into English, finding 2); past the list, 'ok'.
 */
function comp(t: Kit, kind: LayerKind, db: Props, group: string) {
  const first = copy(db);
  const keyOf = (p: string) => (kind === 'Entity' ? ({ DisplayName: 'LocalizedName', DisplayCollectionName: 'LocalizedCollectionName' } as Record<string, string>)[p] || p : p);
  const st = {
    db,
    stale: null as Props | null,
    /** What the next metadata reads answer, one each, before `stale` or the database. */
    queue: [] as Props[],
    modes: [] as string[],
    layers: 'db' as 'db' | 'forbidden' | 'missing' | 'odd',
    puts: [] as any[],
    reads: 0,
    layerUrls: [] as string[],
    said: [] as string[],
  };
  const apply = (body: any, also = false) => {
    for (const p of Object.keys(db)) for (const l of body[p]?.LocalizedLabels || []) db[p][l.LanguageCode] = l.Label;
    if (also) db.DisplayName[EN] = db.DisplayName[FR];
  };
  const layersNow = () => {
    if (st.layers === 'forbidden') throw new DvError('You do not have permission to do this.', 403);
    if (st.layers === 'missing') throw new DvError("Resource not found for the segment 'msdyn_componentlayers'.", 404);
    if (st.layers === 'odd') return { value: [{ msdyn_solutionname: 'Active', msdyn_order: 0, msdyn_changes: '<changes/>' }] };
    const active = Object.fromEntries(Object.keys(db).map((p) => [keyOf(p), Object.fromEntries(Object.entries(db[p]).filter(([l, v]) => first[p][Number(l)] !== v))]));
    const system = Object.fromEntries(Object.keys(first).map((p) => [keyOf(p), first[p]]));
    return { value: [row('System', 1, system, '2026-01-02T03:04:05'), row('Active', 0, active, '2026-10-16T18:10:25.927')] };
  };
  const view = (v: Props) => ({
    '@odata.type': `#Microsoft.Dynamics.CRM.${{ Attribute: 'StringAttributeMetadata', Entity: 'EntityMetadata', OptionSet: 'OptionSetMetadata' }[kind]}`,
    MetadataId: ID,
    LogicalName: 'name',
    Name: 'contoso_status',
    ...Object.fromEntries(Object.entries(v).map(([p, l]) => [p, lab(l)])),
    IsCustomizable: { Value: true },
    IsRenameable: { Value: true },
  });
  const http = {
    get: async (url: string) => {
      if (url.startsWith('msdyn_componentlayers')) {
        st.layerUrls.push(url);
        return layersNow();
      }
      st.reads++;
      return view(st.queue.shift() ?? st.stale ?? db);
    },
    // The reads of a write batch, right before its write (not counted in `reads` or `layerUrls`): the database as it is.
    batch: (parts: never, o: never) => batchOf(http, (url) => (url.startsWith('msdyn_componentlayers') ? layersNow() : view(db)))(parts, o),
    put: async (_url: string, body: any) => {
      st.puts.push(body);
      const mode = st.modes.shift() ?? 'ok';
      if (mode === 'ok' || mode === 'trap') apply(body, mode === 'trap');
      if (mode === 'late') setTimeout(() => apply(body), 3000);
      return { status: 204, headers: { get: (k: string) => (k === 'x-ms-service-request-id' ? `req-${st.puts.length}` : null) } };
    },
  };
  const ctx = { http, base: EN, user: FR, orgId: `layers-${group}`, langs: [EN, FR, DE].map((l) => ({ lcid: l, name: String(l), isBase: l === EN })) };
  const kindOf = kind === 'Attribute' ? 'attribute' : kind === 'Entity' ? 'entity' : 'globaloptionset';
  const ref = kind === 'Attribute' ? { entity: 'team', attribute: 'name' } : kind === 'Entity' ? { entity: 'team' } : { name: 'contoso_status', boolean: false };
  const slot = (prop: string, labels: Labels = first[prop]) =>
    ({ ...t.slot(kindOf, `${group}|${prop}`, { ...labels }), prop, entity: 'team', comp: group, group, title: 'Team name', ref, baseRequired: prop !== 'Description' }) as Slot;
  const w = metadataWriters.find((x) => x.kinds.includes(kindOf))!;
  const save = (cs: Change[]): Promise<ChangeResult[]> =>
    w.save(ctx as never, cs, { signal: new AbortController().signal, publish: new PublishSet(), progress: (m: string) => void st.said.push(m), force: new Set<string>(), lang: null as never, allowPublish: true });
  /** The waits the save announced (settle's, or before writing from a read behind this page's save). */
  const waits = () => st.said.filter((m) => /^Waiting for Dataverse/.test(m));
  return Object.assign(st, { ctx, slot, save, waits });
}
const column = (t: Kit, group: string, dn: Labels = { [EN]: 'Team name', [FR]: OLD }) => comp(t, 'Attribute', { DisplayName: { ...dn }, Description: { [EN]: 'Name of the team.' } }, group);
const fr = (s: Slot, after = NEW, before = OLD): Change => ({ slot: s, lcid: FR, before, after });

export function register(t: Kit): void {
  // ---- reading the layers ----

  t.test('layers: each label property of a column, a table and a global choice is read from its own key', () => {
    const col = parseLayers([row('Active', 0, { DisplayName: { [EN]: 'Team name', [FR]: NEW }, Description: { [EN]: 'Name of the team.' } }, '2026-10-16T18:10:25.927')], 'Attribute');
    t.eq(col, { props: { DisplayName: { [EN]: 'Team name', [FR]: NEW }, Description: { [EN]: 'Name of the team.' } }, modifiedon: '2026-10-16T18:10:25.927' });
    const table = [row('Active', 0, { LocalizedName: { [FR]: 'Équipe' }, LocalizedCollectionName: { [FR]: 'Équipes' }, Description: { [FR]: 'Les équipes' }, DisplayName: { [FR]: 'not a table key' } })];
    t.eq(parseLayers(table, 'Entity')?.props, { DisplayName: { [FR]: 'Équipe' }, DisplayCollectionName: { [FR]: 'Équipes' }, Description: { [FR]: 'Les équipes' } });
    const set = [row('Active', 0, { DisplayName: { [FR]: 'Statut' }, Description: { [FR]: 'Le statut' }, LocalizedName: { [FR]: 'not a choice key' } })];
    t.eq(parseLayers(set, 'OptionSet')?.props, { DisplayName: { [FR]: 'Statut' }, Description: { [FR]: 'Le statut' } });
    // A table read with a column's keys has no labels (and the other way round).
    t.eq(parseLayers([row('Active', 0, { DisplayName: { [FR]: 'x' } })], 'Entity'), { props: {}, modifiedon: '' });
  });

  t.test('layers: the Active layer wins over every managed one, then the highest msdyn_order; a managed component\'s Active layer lists only the languages customized', () => {
    const rows = [
      row('System', 1, { DisplayName: { [EN]: 'Team name', [FR]: 'Nom de l’équipe', [DE]: 'Teamname' }, Description: { [EN]: 'Name of the team.', [FR]: "Nom de l'équipe." } }, '2025-05-05T05:05:05'),
      row('Active', 0, { DisplayName: { [FR]: NEW } }, '2026-10-16T18:10:25.927'),
      row('ISV', 3, { DisplayName: { [EN]: 'Team', [FR]: 'Équipe ISV', [DE]: 'Team DE' } }, '2026-01-01T00:00:00'),
    ];
    t.eq(parseLayers(rows, 'Attribute'), {
      props: { DisplayName: { [DE]: 'Team DE', [EN]: 'Team', [FR]: NEW }, Description: { [EN]: 'Name of the team.', [FR]: "Nom de l'équipe." } },
      modifiedon: '2026-10-16T18:10:25.927',
    });
    // No Active layer (nothing customized): the topmost managed one, and no modifiedon.
    t.eq(parseLayers([rows[0], rows[2]], 'Attribute'), { props: { DisplayName: { [DE]: 'Team DE', [EN]: 'Team', [FR]: 'Équipe ISV' }, Description: { [EN]: 'Name of the team.', [FR]: "Nom de l'équipe." } }, modifiedon: '' });
    // An Active layer of an unmanaged component lists every language, '' included (a blank label is one).
    t.eq(parseLayers([row('Active', 0, { Description: { [EN]: '', [FR]: 'Desc' } })], 'Attribute')?.props, { Description: { [EN]: '', [FR]: 'Desc' } });
  });

  t.test('layers: an answer in another shape is no answer; a label in another shape is unknown, never taken from a lower layer', () => {
    for (const rows of [undefined, null, {}, [], [{ msdyn_solutionname: 'Active', msdyn_changes: 'not json' }], [{ msdyn_solutionname: 'Active' }], [{ msdyn_changes: JSON.stringify({ Attributes: 'x' }) }]])
      t.eq(parseLayers(rows, 'Attribute'), null, JSON.stringify(rows));
    const odd = { msdyn_solutionname: 'Active', msdyn_order: 0, msdyn_changes: JSON.stringify({ Attributes: [{ Key: 'DisplayName - LocalizedLabel', Value: JSON.stringify({ LocalizedLabels: [{ LanguageCode: FR, Label: NEW }] }) }] }) };
    t.eq(parseLayers([odd, row('System', 1, { DisplayName: { [FR]: OLD }, Description: { [EN]: 'D' } })], 'Attribute')?.props, { Description: { [EN]: 'D' } });
    // msdyn_changes and a label's Value already parsed are read the same.
    const parsed = { msdyn_solutionname: 'Active', msdyn_changes: { Attributes: [{ Key: 'DisplayName - LocalizedLabel', Value: { LocalizedLabels: { [FR]: { LocalizedLabel: NEW }, x: { LocalizedLabel: 'no language' }, [DE]: { LocalizedLabel: null } } } }] } };
    t.eq(parseLayers([parsed], 'Attribute')?.props, { DisplayName: { [FR]: NEW } });
  });

  t.test('layers: one read of msdyn_componentlayers by MetadataId and kind; no rights, no such table or a failed read is null, never an error', async () => {
    const urls: string[] = [];
    let answer: () => unknown = () => ({ value: [row('Active', 0, { DisplayName: { [FR]: NEW } })] });
    const http = { get: async (u: string) => (urls.push(u), answer()) };
    t.eq((await readLayers(http, 'Attribute', `{${ID.toUpperCase()}}`))?.props, { DisplayName: { [FR]: NEW } });
    t.eq(urls, [`msdyn_componentlayers?$filter=(msdyn_componentid eq '${ID}' and msdyn_solutioncomponentname eq 'Attribute')&$select=msdyn_solutionname,msdyn_order,msdyn_changes`]);
    t.eq([await readLayers(http, 'Entity', ''), await readLayers(http, 'Entity', "x' or 1 eq 1"), urls.length], [null, null, 1], 'no MetadataId: nothing asked');
    for (const e of [new DvError('You do not have permission to do this.', 403), new DvError('Not found', 404), new DvError('Could not reach Dataverse.', 0, 'network'), new Error('boom')]) {
      answer = () => {
        throw e;
      };
      t.eq(await readLayers(http, 'OptionSet', ID), null, e.message);
    }
    answer = () => ({ error: 'no value' });
    t.eq(await readLayers(http, 'OptionSet', ID), null);
  });

  // ---- the metadata writers ----

  t.test('layers: a write the layers show applied is saved at once, whatever the metadata reads still show: one write, no wait, not undone by the next save', () =>
    fast(async () => {
      const c = column(t, 'attribute|team.name#1');
      c.stale = copy(c.db); // every metadata read answers the text from before the write (the user's Edge)
      const dn = c.slot('DisplayName');
      const [r] = await c.save([fr(dn)]);
      t.eq([r.outcome, r.message, c.puts.length, c.reads, c.layerUrls.length, c.waits()], ['saved', undefined, 1, 2, 1, []], JSON.stringify(r));
      t.eq(c.db.DisplayName, { [EN]: 'Team name', [FR]: NEW });
      t.ok(c.layerUrls[0].includes(`msdyn_componentid eq '${ID}' and msdyn_solutioncomponentname eq 'Attribute'`), c.layerUrls[0]);
      // The same text again from a read still behind it (another tab loaded before the save): written at once, never refused.
      const [r2] = await c.save([fr(dn)]);
      t.eq([r2.outcome, c.puts.length, c.waits()], ['saved', 2, []], JSON.stringify(r2));
      // Another language of the label from a read still behind the save: it would send the old French back, so nothing is
      // written; once the reads catch up it is, with the French kept.
      const [r3] = await c.save([{ slot: c.slot('DisplayName'), lcid: EN, before: 'Team name', after: 'Team' }]);
      t.eq([r3.outcome, c.puts.length], ['error', 2], JSON.stringify(r3));
      t.ok(/^Not saved: Dataverse doesn't show your last change to this column yet/.test(r3.message || ''), r3.message);
      c.stale = null;
      const [r4] = await c.save([{ slot: c.slot('DisplayName'), lcid: EN, before: 'Team name', after: 'Team' }]);
      t.eq([r4.outcome, c.db.DisplayName], ['saved', { [EN]: 'Team', [FR]: NEW }]);
    }),
  );

  t.test("layers: the next save from a read behind a save they confirmed, which this page's record can't tell (a text it never saw there), waits for the layers' text, so it never undoes it", () =>
    fast(async () => {
      // Someone changed the French name before the page loaded; the page saves French over it.
      const c = column(t, 'attribute|team.name#1b', { [EN]: 'Team name', [FR]: 'Nom X' });
      const before = { DisplayName: { [EN]: 'Team name', [FR]: 'Nom' }, Description: { ...c.db.Description } }; // the state before theirs
      c.stale = copy(c.db);
      const [r] = await c.save([fr(c.slot('DisplayName'), 'Nom 2', 'Nom X')]);
      t.eq([r.outcome, c.puts.length, c.db.DisplayName[FR]], ['saved', 1, 'Nom 2'], JSON.stringify(r));
      // The next save, of English, reads a state from before their change too: its French "Nom" is no text this page knew.
      c.stale = null;
      c.queue = [before, before];
      const [r2] = await c.save([{ slot: c.slot('DisplayName'), lcid: EN, before: 'Team name', after: 'Team' }]);
      t.eq([r2.outcome, c.db.DisplayName, c.puts.length, c.waits().length], ['saved', { [EN]: 'Team', [FR]: 'Nom 2' }, 2, 2], JSON.stringify(r2));
    }),
  );

  t.test('layers: a table\'s plural name and a global choice\'s name are confirmed by their own layer keys', () =>
    fast(async () => {
      const e = comp(t, 'Entity', { DisplayName: { [EN]: 'Team', [FR]: 'Équipe' }, DisplayCollectionName: { [EN]: 'Teams', [FR]: 'Equipes' }, Description: { [EN]: 'Teams.' } }, 'entity|team#2');
      e.stale = copy(e.db);
      const [r] = await e.save([{ slot: e.slot('DisplayCollectionName'), lcid: FR, before: 'Equipes', after: 'Équipes' }]);
      t.eq([r.outcome, e.puts.length, e.waits(), e.layerUrls.map((u) => /'Entity'\)/.test(u))], ['saved', 1, [], [true]], JSON.stringify(r));
      const g = comp(t, 'OptionSet', { DisplayName: { [EN]: 'Status', [FR]: 'Statu' }, Description: { [EN]: 'The status.' } }, 'globaloptionset|contoso_status#2');
      g.stale = copy(g.db);
      const [r2] = await g.save([{ slot: g.slot('DisplayName'), lcid: FR, before: 'Statu', after: 'Statut' }]);
      t.eq([r2.outcome, g.puts.length, g.waits(), g.layerUrls.map((u) => /'OptionSet'\)/.test(u))], ['saved', 1, [], [true]], JSON.stringify(r2));
    }),
  );

  t.test('layers: only the edited language is confirmed by them: another language or label Dataverse changed is still reported, with no wait', () =>
    fast(async () => {
      // The base-language trap (finding 2): Dataverse wrote the French text into English too.
      const c = column(t, 'attribute|team.name#3');
      c.stale = copy(c.db);
      c.modes = ['trap'];
      const [r] = await c.save([fr(c.slot('DisplayName'))]);
      t.eq([r.outcome, c.puts.length, c.waits()], ['error', 1, []]);
      t.ok(r.message?.startsWith(`Saved, but Dataverse also changed the English text to "${NEW}"`), r.message);
      // The description changed with it (someone, or Dataverse): reported too.
      const d = column(t, 'attribute|team.name#3b');
      d.stale = copy(d.db);
      const put = d.ctx.http.put;
      d.ctx.http.put = async (u: string, body: any) => {
        const res = await put(u, body);
        d.db.Description[EN] = 'Changed';
        return res;
      };
      const [r2] = await d.save([fr(d.slot('DisplayName'))]);
      t.eq([r2.outcome, d.puts.length], ['error', 1]);
      t.ok(/^Saved, but Dataverse also changed the English description to "Changed"/.test(r2.message || ''), r2.message);
    }),
  );

  t.test("layers: a write they still show as before is written again as before, then reported by fact: Dataverse answered OK but didn't apply it", () =>
    fast(async () => {
      const c = column(t, 'attribute|team.name#4');
      c.modes = ['drop', 'drop'];
      const [r] = await c.save([fr(c.slot('DisplayName'))]);
      t.eq([r.outcome, c.puts.length, c.reads, c.layerUrls.length], ['error', 2, 12, 3], 'each round: read, write, verify, 4 reads while waiting; the layers after each write and after the last wait');
      t.eq(r.message, `Dataverse answered OK but didn't apply this change: its records still show “${OLD}”. Try again; if it keeps happening, copy the details for support.`);
      // A new translation never applied: no text there yet.
      const d = column(t, 'attribute|team.name#4b', { [EN]: 'Team name' });
      d.modes = ['drop', 'drop'];
      const [r2] = await d.save([fr(d.slot('DisplayName'), NEW, '')]);
      t.eq(r2.message, "Dataverse answered OK but didn't apply this change: its records still show no French text. Try again; if it keeps happening, copy the details for support.");
      // Applied only after the last write was checked (and the metadata reads never caught up): the last check finds it.
      const e = column(t, 'attribute|team.name#4c');
      e.stale = copy(e.db);
      e.modes = ['drop', 'late'];
      const [r3] = await e.save([fr(e.slot('DisplayName'))]);
      t.eq([r3.outcome, r3.message, e.puts.length, e.layerUrls.length], ['saved', undefined, 2, 3], JSON.stringify(r3));
    }),
  );

  t.test("layers: an Undo the first read shows as written, which that read can't show made, is asked of them: a dropped one is written again, never reported saved", () =>
    fast(async () => {
      const c = column(t, 'attribute|team.name#8');
      const dn = c.slot('DisplayName');
      const first = copy(c.db);
      c.stale = copy(c.db);
      const [r] = await c.save([fr(dn)]);
      t.eq([r.outcome, c.puts.length, c.layerUrls.length], ['saved', 1, 1], JSON.stringify(r));
      // The Undo reads fresh, Dataverse drops its write (finding 62), and the read after it, still behind the save it undoes,
      // shows the Undo's text: the layers still hold the save's, so it is written again (after settle's waits), and saved.
      c.stale = null;
      c.queue = [copy(c.db), first];
      c.modes = ['drop'];
      const [u] = await c.save([fr(dn, OLD, NEW)]);
      t.eq([u.outcome, u.message, c.db.DisplayName[FR], c.puts.length, c.layerUrls.length, c.waits().length], ['saved', undefined, OLD, 3, 3, 4], JSON.stringify(u));
      // Applied, from a read as far behind: saved by the layers at once.
      c.queue = [copy(c.db), { ...copy(first), DisplayName: { [EN]: 'Team name', [FR]: NEW } }];
      const [v] = await c.save([fr(dn, NEW, OLD)]);
      t.eq([v.outcome, c.db.DisplayName[FR], c.puts.length, c.layerUrls.length, c.waits().length], ['saved', NEW, 4, 4, 4], JSON.stringify(v));
      // Without the layers, the first read's answer stands, as before them: an Undo applied is saved with no wait.
      c.layers = 'forbidden';
      c.queue = [copy(c.db), first];
      const [w] = await c.save([fr(dn, OLD, NEW)]);
      t.eq([w.outcome, c.db.DisplayName[FR], c.puts.length, c.layerUrls.length, c.waits().length], ['saved', OLD, 5, 5, 4], JSON.stringify(w));
      // Applied, then someone else's text: the layers show theirs, which is said at once (no wait, never written over).
      c.layers = 'db';
      c.queue = [copy(c.db), { ...copy(first), DisplayName: { [EN]: 'Team name', [FR]: NEW } }];
      const put = c.ctx.http.put;
      c.ctx.http.put = async (u: string, body: any) => {
        const res = await put(u, body);
        c.db.DisplayName[FR] = 'Nom X';
        return res;
      };
      const [y] = await c.save([fr(dn, NEW, OLD)]);
      t.eq([y.outcome, y.message, c.db.DisplayName[FR], c.puts.length, c.layerUrls.length, c.waits().length], ['error', 'Dataverse did not keep this change: the French text now reads "Nom X". Reload and try again.', 'Nom X', 6, 6, 4], JSON.stringify(y));
      // A save that is no edit back, from fresh reads, never asks them.
      const d = column(t, 'attribute|team.name#8b');
      const [x] = await d.save([fr(d.slot('DisplayName'))]);
      t.eq([x.outcome, d.puts.length, d.reads, d.layerUrls.length, d.waits()], ['saved', 1, 2, 0, []], JSON.stringify(x));
    }),
  );

  t.test('layers: unavailable (no rights, no such table, another shape) changes nothing: the save goes exactly as without them', () =>
    fast(async () => {
      const run = async (layers: 'forbidden' | 'missing' | 'odd' | 'none', stale: boolean) => {
        const c = column(t, `attribute|team.name#5${layers}${stale}`);
        c.layers = layers === 'none' ? 'db' : layers;
        if (stale) c.stale = copy(c.db);
        else c.modes = ['drop', 'drop'];
        // 'none': a component without a MetadataId (layers are never asked).
        const s = c.slot('DisplayName');
        if (layers === 'none') {
          const get = c.ctx.http.get;
          c.ctx.http.get = async (u: string) => {
            const x = await get(u);
            delete x.MetadataId;
            return x;
          };
        }
        const [r] = await c.save([fr(s)]);
        return [r.outcome, r.message, c.puts.length, c.reads, c.waits().length, layers === 'none' ? 0 : c.layerUrls.length];
      };
      for (const stale of [false, true]) {
        const plain = await run('none', stale);
        t.eq(plain.slice(0, 2), ['error', `Dataverse still shows the old French text "${OLD}", 15 seconds after writing it 2 times. Dataverse accepted the change but doesn't show it yet: try again in a minute.`]);
        for (const l of ['forbidden', 'missing', 'odd'] as const) t.eq(await run(l, stale), [...plain.slice(0, 5), 3], `${l}, ${stale ? 'reads lagging' : 'write dropped'}`);
      }
    }),
  );

  t.test('layers: a choice option is never checked against them (options have no layer keys of their own)', () =>
    fast(async () => {
      const urls: string[] = [];
      const http = {
        get: async (u: string) => (
          urls.push(u),
          { LogicalName: 'k', MetadataId: ID, IsCustomizable: { Value: true }, OptionSet: { MetadataId: ID, Options: [{ Value: 1, MetadataId: ID, Label: lab({ [EN]: 'Open', [FR]: 'Ouvert' }), Description: lab({}) }] } }
        ),
        post: async () => ({ status: 204 }), // accepted, nothing applied
        batch: (parts: never, o: never) => batchOf(http)(parts, o),
      };
      const ctx = { http, base: EN, user: FR, orgId: 'layers-opt', langs: [] };
      const slot = { ...t.slot('option', 'option|t.k|1|Label', { [EN]: 'Open', [FR]: 'Ouvert' }), prop: 'Label', group: 'option|t.k|1', ref: { entity: 't', attribute: 'k', value: 1, cast: 'Picklist', optionMetadataId: ID } } as Slot;
      const w = metadataWriters.find((x) => x.kinds.includes('option'))!;
      const [r] = await w.save(ctx as never, [{ slot, lcid: FR, before: 'Ouvert', after: 'Ouverte' }], { signal: new AbortController().signal, publish: new PublishSet(), progress() {}, force: new Set<string>(), lang: null as never, allowPublish: true });
      t.ok(/^Dataverse still shows the old French text "Ouvert", 15 seconds after writing it 2 times/.test(r.message || ''), r.message);
      t.eq(urls.filter((u) => u.startsWith('msdyn_componentlayers')), []);
    }),
  );

  // ---- the write log ("Copy details") ----

  t.test('layers: every metadata write is kept for "Copy details": request and answer, the texts written and read back, each layer check, the outcome', () =>
    fast(async () => {
      const c = column(t, 'attribute|team.name#6');
      c.modes = ['drop', 'drop'];
      await c.save([fr(c.slot('DisplayName'))]);
      const list = writesOf('attribute|team.name#6');
      t.eq(list.map((a) => [a.calls.map((x) => [x.status, x.requestId]), a.items.map((i) => [i.what, i.before, i.wrote, i.read, i.layers.length])]), [
        [[['HTTP 204', 'req-1']], [['DisplayName, French (1036)', OLD, NEW, OLD, 1]]],
        [[['HTTP 204', 'req-2']], [['DisplayName, French (1036)', OLD, NEW, OLD, 2]]],
      ]);
      const text = writeDetails('attribute|team.name#6', ['Org: https://org.example']);
      for (const s of [
        'Dynamics Translator: metadata write details',
        'Org: https://org.example',
        'Writes of this component kept by this page: 2 (times in UTC)',
        "PUT EntityDefinitions(LogicalName='team')/Attributes(LogicalName='name') -> HTTP 204, x-ms-service-request-id req-2",
        `DisplayName, French (1036): before ${JSON.stringify(OLD)}, wrote ${JSON.stringify(NEW)}, read back ${JSON.stringify(OLD)}`,
        `: ${JSON.stringify(OLD)} (Active layer modifiedon 2026-10-16T18:10:25.927)`,
        "outcome: error: Dataverse answered OK but didn't apply this change",
      ])
        t.ok(text.includes(s), `${s}\nin:\n${text}`);
      // A request Dataverse failed: its status, message and request id (the saver words the error for the group).
      const d = column(t, 'attribute|team.name#6b');
      d.ctx.http.put = async () => {
        throw new DvError('Something went wrong.', 500, '0x80040216', '', 'req-x');
      };
      const err = await d.save([fr(d.slot('DisplayName'))]).then(() => null, (e: unknown) => e);
      t.ok(err instanceof DvError, String(err));
      const text2 = writeDetails('attribute|team.name#6b');
      t.ok(text2.includes('-> HTTP 500: Something went wrong., x-ms-service-request-id req-x') && text2.includes('outcome: failed: Something went wrong.'), text2);
      t.eq([writeDetails('attribute|nothing'), writesOf('attribute|nothing')], ['', []]);
    }),
  );

  t.test('layers: the write log keeps the last 30 writes of the page', () => {
    for (let i = 0; i < 35; i++) logWrite({ at: i, group: 'attribute|log#7', title: `w${i}`, calls: [], items: [] });
    t.eq(writesOf('attribute|log#7').map((a) => a.title), Array.from({ length: 30 }, (_, i) => `w${i + 5}`));
  });
}
