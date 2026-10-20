// The owner's rule for a metadata component's description (core/model.ts keepsEmpty): a non-base translation emptied
// there (or left only spaces) is saved EMPTY, whatever the base-language text is, so that language's users see no
// tooltip or description (LIVE-FINDINGS 32). Names keep the stand-in rule, classic ribbon tooltips too, a record's
// description is removed. Here: the pure rule, the saver and the journal, Undo, the real metadata writers against a fake
// Dataverse (only '' for that language, every other one as it is), the loader (a stored '' kept for descriptions only),
// the store and the looks (stored empty = translated, missing = missing), the popup's and the editor card's words, the
// Workbench's cells and filters. register() is called by tools/dev/unit.ts.
import { addHistory, readHistory } from '../../../src/core/history';
import type { BatchPart, PartResult } from '../../../src/core/http';
import { toLabels } from '../../../src/core/labels';
import { canClear, CANT_CLEAR_TEXT, keepsEmpty, noneText, PublishSet, refusedBlank, savedEmptyText, savesEmpty, standIn, storedEmpty, type Change, type ChangeResult, type Kind, type Labels, type Lcid, type Prop, type Slot, type TextOf } from '../../../src/core/model';
import { undoChange, withStandIns } from '../../../src/core/saver';
import { Store } from '../../../src/core/store';
import { slotLook } from '../../../src/inspector/mode';
import { look } from '../../../src/inspector/status';
import { CSV_KEY, createIo } from '../../../src/io/workbook';
import { loadTables, metadataWriters } from '../../../src/providers/metadata';
import { becomes, isMissing, placeholderOf, problem } from '../../../src/ui/callout';
import { planPublish, undoRows } from '../../../src/ui/review';
import type { AppApi, HistoryItem } from '../../../src/ui/types';
import { blankEdit, clearing, edLook, EMPTY, langCell, missing, problem as rowProblem } from '../../../src/workbench/grid';
import { rowsTest } from '../../../src/workbench/sheets';
import type { Kit } from './kit';
import { fast } from './lang';
import { rig, type Rig } from './savepath';

const EN = 1033;
const FR = 1036;
const DE = 1031;
const ID = '5e5e5e5e-0000-4000-8000-00000000005e';
const TIP = 'attribute|acc.name|Description';
const NAME = 'attribute|acc.name|DisplayName';

/** A slot as the loaders make them (`key = ${comp}|${prop}`). */
const S = (kind: Kind, comp: string, prop: Prop, labels: Labels, o: Partial<Slot> = {}): Slot => ({
  key: `${comp}|${prop}`,
  kind,
  prop,
  entity: 'acc',
  comp,
  group: comp,
  title: labels[EN] || comp,
  path: [],
  sub: '',
  labels,
  readOnly: '',
  baseRequired: prop !== 'Description',
  max: 0,
  order: 0,
  ref: {},
  ...o,
});
/** Texts by `key#lcid`; a key left out is not loaded. */
const texts = (m: Record<string, string>): TextOf => (k, l) => m[`${k}#${l}`];
const lab = (l: Labels) => ({ LocalizedLabels: Object.entries(l).map(([k, v]) => ({ Label: v, LanguageCode: Number(k) })) });
const part = (status: number, data: unknown = null, error?: string): PartResult => ({ ok: status > 0 && status < 300, status, data, error, code: '', headers: {} });
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/**
 * A component on a fake Dataverse: `db` holds its labels by property (and, for options, the other options' too). A
 * read answers `view()`; a write (in a $batch behind a read, as the writers send it) merges each language it carries
 * into `db` (MergeLabels), and is recorded. The solution layers can't be read here (404): the writers go on without them.
 */
function fake(view: () => any, apply: (body: any) => void) {
  const writes: Array<{ method: string; url: string; body: any }> = [];
  const http = {
    get: async (url: string) => {
      if (url.startsWith('msdyn_componentlayers')) throw new Error('404');
      return copy(view());
    },
    batch: async (parts: BatchPart[], o: { stop?: boolean } = {}) => {
      const out: PartResult[] = [];
      for (const p of parts) {
        if (p.method === 'GET') {
          if (p.url.startsWith('msdyn_componentlayers')) {
            out.push(part(404, null, 'Not found.'));
            if (o.stop) break;
          } else out.push(part(200, copy(view())));
          continue;
        }
        writes.push({ method: p.method, url: p.url.replace(/\?.*$/, ''), body: copy(p.body) });
        apply(p.body);
        out.push(part(204));
      }
      while (out.length < parts.length) out.push(part(0, null, 'Dataverse sent no answer for this part of the request.'));
      return out;
    },
  };
  const ctx = { http, base: EN, user: FR, orgId: `empty-${Math.random()}`, langs: [EN, FR, DE].map((l) => ({ lcid: l, name: String(l), isBase: l === EN })) };
  return { ctx, writes };
}
/** Merges a Label of a write into `into` (MergeLabels: each language it carries replaces that language). */
const merge = (into: Labels, label: any) => {
  for (const l of label?.LocalizedLabels || []) into[l.LanguageCode] = l.Label;
};
const opts = () => ({ signal: new AbortController().signal, publish: new PublishSet(), progress() {}, force: new Set<string>(), lang: null as never, allowPublish: true });
const writerOf = (k: Kind) => metadataWriters.find((w) => w.kinds.includes(k))!;
const change = (slot: Slot, lcid: Lcid, after: string, before = slot.labels[lcid] ?? ''): Change => ({ slot, lcid, before, after });
/** The languages of a Label sent, as { lcid: text }. */
const sent = (label: any): Labels => toLabels(label);

export function register(t: Kit): void {
  const { test, eq, ok } = t;

  // ---- the rule ----

  test("empty descriptions: the rule: a metadata component's description translation emptied is saved empty (no stand-in, no refusal); names, classic ribbon tooltips keep their stand-in; a record's description is removed; the base language keeps its own rules", () => {
    const meta: Kind[] = ['entity', 'attribute', 'option', 'globaloptionset', 'globaloption', 'boolean', 'state', 'status'];
    const en = (s: Slot) => texts({ [`${s.key}#${EN}`]: 'Tip' });
    for (const k of meta) {
      const d = S(k, `${k}|x`, 'Description', { [EN]: 'Tip', [FR]: 'Astuce' });
      eq([keepsEmpty(d), savesEmpty(d, FR, EN), savesEmpty(d, EN, EN), canClear(d, FR)], [true, true, false, false], k);
      eq(standIn(d, FR, EN, 'Astuce', '', en(d)), undefined, `${k}: saved empty, whatever the English text`);
      eq(standIn(d, FR, EN, 'Astuce', '  ', texts({ [`${d.key}#${EN}`]: '' })), undefined, `${k}: only spaces, no English text either: saved empty`);
      // An Undo that puts back no translation at all gets its stand-in, as before (Change.untranslated).
      eq(standIn(d, FR, EN, 'Astuce', '', en(d), true), { text: 'Tip', from: 'base' }, `${k}: undo to no translation`);
      ok(!refusedBlank({ change: change(d, FR, ''), outcome: 'error' }, EN), `${k}: an error saving it empty is worth trying again`);
    }
    // Names: the stand-in, as before.
    for (const [k, p] of [['attribute', 'DisplayName'], ['entity', 'DisplayCollectionName'], ['option', 'Label'], ['relationship', 'Label'], ['globaloptionset', 'DisplayName'], ['state', 'Label']] as Array<[Kind, Prop]>) {
      const n = S(k, `${k}|x`, p, { [EN]: 'Name', [FR]: 'Nom' });
      ok(!keepsEmpty(n) && !savesEmpty(n, FR, EN), `${k} ${p}`);
      eq(standIn(n, FR, EN, 'Nom', '', texts({ [`${n.key}#${EN}`]: 'Name' })), { text: 'Name', from: 'base' }, `${k} ${p}`);
      ok(refusedBlank({ change: change(n, FR, ''), outcome: 'error' }, EN), `${k} ${p}: no stand-in, refused every time`);
    }
    // A classic ribbon tooltip: an import can't store an empty title (LIVE-FINDINGS 39, 69): its stand-in.
    const rib = S('ribbon', 'ribbon|acc|x', 'ToolTipDescription', { [EN]: 'Runs it', [FR]: 'Lance' });
    ok(!keepsEmpty(rib), 'ribbon tooltip');
    eq(standIn(rib, FR, EN, 'Lance', '', texts({ [`${rib.key}#${EN}`]: 'Runs it' })), { text: 'Runs it', from: 'base' });
    // A form label: its column's name, as before.
    const cell = S('field', 'field|f|c1', 'Label', { [EN]: 'Customer', [FR]: 'Client' }, { ref: { formId: 'f', datafield: 'name' } });
    eq(standIn(cell, FR, EN, 'Client', '', texts({ [`${NAME}#${FR}`]: 'Nom', [`${NAME}#${EN}`]: 'Name' }))?.text, 'Nom');
    // A record's description (a view's, a chart's, a process's): removed, no stand-in, not "saved empty".
    for (const k of ['view', 'chart', 'bpf'] as Kind[]) {
      const d = S(k, `${k}|x`, 'Description', { [EN]: 'Tip', [FR]: 'Astuce' });
      eq([keepsEmpty(d), canClear(d, FR), standIn(d, FR, EN, 'Astuce', '', texts({ [`${d.key}#${EN}`]: 'Tip' }))], [false, true, undefined], k);
    }
    // Stored empty: '' in that language (a text of its own), never the base language, never a missing one.
    const d = S('attribute', 'attribute|x', 'Description', { [EN]: 'Tip', [FR]: '' });
    eq([storedEmpty(d, FR, EN), storedEmpty(d, DE, EN), storedEmpty({ ...d, labels: { [EN]: '' } }, EN, EN)], [true, false, false]);
    // The words, in the language name a view gives.
    eq([noneText(d, 'French'), noneText(S('option', 'option|x|1', 'Description', {}), 'French')], ['No French tooltip', 'No French description']);
    eq([savedEmptyText(d, 'French'), savedEmptyText({ kind: 'state' }, 'German')], ['Saved empty: French users see no tooltip.', 'Saved empty: German users see no description.']);
    // As the saver writes them: the emptied description as it is (''), the name as its stand-in, an undo to none too.
    const nm = S('attribute', 'attribute|x', 'DisplayName', { [EN]: 'Name', [FR]: 'Nom' });
    const text = texts({ [`${d.key}#${EN}`]: 'Tip', [`${nm.key}#${EN}`]: 'Name' });
    const cs = [change({ ...d, labels: { [EN]: 'Tip', [FR]: 'Astuce' } }, FR, ''), change(nm, FR, ''), { ...change({ ...d, labels: { [EN]: 'Tip', [FR]: 'Astuce' } }, FR, ''), untranslated: true as const }];
    const w = withStandIns(cs, EN, text);
    eq([w[0] === cs[0], w[1].after, w[1].standIn?.from, w[2].after, w[2].standIn?.from], [true, 'Name', 'base', 'Tip', 'base']);
  });

  test('empty descriptions: the journal tells Undo a translation stored empty from none: undoChange gives the one that put back none its stand-in (untranslated), the one stored empty before none, a name never', () => {
    const d = S('attribute', 'attribute|x', 'Description', { [EN]: 'Tip', [FR]: 'Astuce' });
    const it = (o: Partial<HistoryItem>): HistoryItem => ({ key: d.key, comp: d.comp, kind: 'attribute', lcid: FR, title: 'X', before: '', after: 'Astuce', ...o });
    eq(undoChange(d, it({})), { slot: d, lcid: FR, before: 'Astuce', after: '', untranslated: true }, 'no translation before: its stand-in');
    eq(undoChange(d, it({ empty: true })), { slot: d, lcid: FR, before: 'Astuce', after: '' }, 'stored empty before: empty again');
    eq(undoChange(d, it({ before: 'Ancienne', after: '' })), { slot: d, lcid: FR, before: '', after: 'Ancienne' }, 'it emptied one: its earlier text');
    const nm = S('attribute', 'attribute|x', 'DisplayName', { [EN]: 'Name', [FR]: 'Nom' });
    eq(undoChange(nm, it({ key: nm.key, after: 'Nom', before: '  ' })), { slot: nm, lcid: FR, before: 'Nom', after: '  ' }, 'a name: the stand-in rule as ever');
    // As written (withStandIns): to its English text; with none (empty as the undo leaves it), saved empty after all
    // (its users saw no text before the publish), the mark dropped; a name with no English name keeps it (refused).
    const back = undoChange(d, it({}));
    const none = { slot: nm, lcid: FR, before: 'Nom', after: '', untranslated: true as const };
    eq(withStandIns([back], EN, texts({ [`${d.key}#${EN}`]: 'Tip' }))[0], { ...back, after: 'Tip', standIn: { from: 'base', typed: '' } });
    eq(withStandIns([back, none], EN, texts({ [`${d.key}#${EN}`]: ' ', [`${nm.key}#${EN}`]: '' })), [{ slot: d, lcid: FR, before: 'Astuce', after: '' }, none]);
    eq(withStandIns([back], EN, texts({}))[0], back, "its English text not loaded: held back, as before");
  });

  // ---- the saver, the journal and Undo (the savepath rig: the real saver and journal, a writer like the real ones) ----

  const run = (name: string, fn: (r: Rig) => Promise<void>) =>
    test(`empty descriptions: ${name}`, async () => {
      const r = rig(t);
      try {
        await fn(r);
      } finally {
        r.done();
      }
    });
  const tipOf = (r: Rig, labels: Labels) => r.add('attribute', TIP, labels, { prop: 'Description', baseRequired: false, title: 'Name' }).key;
  const o = () => ({ signal: new AbortController().signal, publish: true, onProgress() {} });

  run("Publish saves an emptied French tooltip empty, whatever its English text: written '' (no stand-in, no warning), journaled after = '', stored empty in the store (translated); a name emptied beside it still gets its stand-in", async (r) => {
    const tip = tipOf(r, { [EN]: 'Type the name.', [FR]: 'Tapez le nom.' });
    const name = r.add('attribute', NAME, { [EN]: 'Name', [FR]: 'Nom' }, { prop: 'DisplayName' }).key;
    r.store.set(tip, FR, '');
    r.store.set(name, FR, '');
    eq(r.app.saver.validate(r.store.changes()), [], 'nothing to refuse or warn about');
    const { rep, plan } = await r.publish();
    eq([plan.written.get(`${tip}#${FR}`)?.after, plan.written.get(`${tip}#${FR}`)?.standIn, plan.written.get(`${name}#${FR}`)?.after], ['', undefined, 'Name']);
    eq(rep.results.map((x) => [x.change.slot.key, x.outcome, x.change.after]), [[tip, 'saved', ''], [name, 'saved', 'Name']]);
    eq(r.writes.flatMap((w) => w.ids), [[`${tip}#${FR}`, ''], [`${name}#${FR}`, 'Name']], 'the tooltip as it is, the name as its stand-in');
    const [e] = readHistory(r.app.ctx);
    eq(e.items.map((it) => [it.key, it.before, it.after, it.empty ?? null]), [[tip, 'Tapez le nom.', '', null], [name, 'Nom', 'Name', null]]);
    // Stored empty: a text of its own (not missing), translated.
    const s = r.store.get(tip)!;
    eq([FR in s.labels, s.labels[FR], storedEmpty(s, FR, EN), r.store.emptyOnPurpose(tip, FR, EN), r.store.pendingCount()], [true, '', true, true, 0]);
    // Its English text emptied too (the base language, its own rules: it may be blank): '' as before, with its warning.
    r.store.set(tip, EN, '');
    eq(r.app.saver.validate(r.store.changes()).map((i) => [i.level, i.message]), [['warn', 'Clears the English text.']]);
  });

  run("only spaces typed where a French tooltip has none save it empty too (no refusal): '' written and stored, its users then see none; journaled as a translation it had none of (before '', not `empty`); a name there is still refused", async (r) => {
    const tip = tipOf(r, { [EN]: 'Type the name.' });
    const name = r.add('attribute', NAME, { [EN]: 'Name' }, { prop: 'DisplayName' }).key;
    eq([r.store.emptyOnPurpose(tip, FR, EN), isMissing(r.store, r.store.get(tip)!, FR, EN)], [false, true], 'missing: French users see the English one');
    r.store.set(tip, FR, '  ');
    r.store.set(name, FR, '  ');
    eq(r.app.saver.validate(r.store.changes()).map((i) => [i.change.slot.key, i.level, i.message]), [[name, 'error', 'Only spaces: French users would see a blank label instead of the English text. Type the text, or undo this edit.']]);
    eq(r.store.emptyOnPurpose(tip, FR, EN), true, 'staged: saved empty');
    const { rep } = await r.publish();
    eq(rep.results.map((x) => [x.change.slot.key, x.outcome]), [[tip, 'saved']], 'written, as the real writer does (below)');
    eq([r.writes.flatMap((w) => w.ids), r.server.has(`${tip}#${FR}`), r.server.get(`${tip}#${FR}`)], [[[`${tip}#${FR}`, '  ']], true, ''], "'' stored, not no label");
    eq([r.store.get(tip)!.labels, r.store.emptyOnPurpose(tip, FR, EN)], [{ [EN]: 'Type the name.', [FR]: '' }, true]);
    const [e] = readHistory(r.app.ctx);
    eq(e.items.map((it) => [it.key, it.before, it.after, it.empty ?? null]), [[tip, '', '', null]], 'none before: never marked stored empty, so Undo gives it its English text (below)');
  });

  run("Undo of a publish that emptied a French tooltip writes its earlier text back (an ordinary change), and says nothing more", async (r) => {
    const tip = tipOf(r, { [EN]: 'Type the name.', [FR]: 'Tapez le nom.' });
    r.store.set(tip, FR, '');
    await r.publish();
    const [e] = readHistory(r.app.ctx);
    const rows = undoRows(r.app, e, await r.app.saver.current([undoChange(r.store.get(tip)!, e.items[0])]));
    eq(rows.map((x) => [x.state, x.now, x.standIn ?? null, x.empty ?? null]), [['undo', '', null, null]]);
    const rep = await r.app.saver.undo(e, o());
    eq(rep.results.map((x) => [x.outcome, x.change.after]), [['saved', 'Tapez le nom.']]);
    eq([r.server.get(`${tip}#${FR}`), r.store.original(tip, FR), readHistory(r.app.ctx).find((x) => x.id === e.id)?.undoneAt !== undefined], ['Tapez le nom.', 'Tapez le nom.', true]);
    // Its own journal entry (Redo) knows the text it replaced was stored empty: a Redo empties it again, no stand-in.
    const [u] = readHistory(r.app.ctx);
    eq(u.items.map((it) => [it.before, it.after, it.empty ?? null]), [['', 'Tapez le nom.', true]]);
    eq(undoChange(r.store.get(tip)!, u.items[0]).untranslated, undefined);
    const redo = await r.app.saver.undo(u, o());
    eq([redo.results.map((x) => [x.outcome, x.change.after]), r.store.emptyOnPurpose(tip, FR, EN)], [[['saved', '']], true]);
  });

  run("Undo of a publish that gave a French tooltip its first text puts back none as before: its English text in its place (French users see what they saw), never saved empty; one stored empty before is saved empty again; an older entry that can't tell gets the English text", async (r) => {
    // (a) No French tooltip before.
    const tip = tipOf(r, { [EN]: 'Type the name.' });
    r.store.set(tip, FR, 'Tapez le nom.');
    await r.publish();
    let [e] = readHistory(r.app.ctx);
    eq(e.items.map((it) => [it.before, it.empty ?? null]), [['', null]], 'none before: not marked');
    let rows = undoRows(r.app, e, await r.app.saver.current([undoChange(r.store.get(tip)!, e.items[0])]));
    eq(rows.map((x) => [x.state, x.standIn ?? null, x.empty ?? null]), [['undo', { text: 'Type the name.', from: 'base' }, null]]);
    let rep = await r.app.saver.undo(e, o());
    eq(rep.results.map((x) => [x.outcome, x.change.after, x.change.standIn?.from ?? null]), [['saved', 'Type the name.', 'base']]);
    eq(r.server.get(`${tip}#${FR}`), 'Type the name.');

    // (b) Stored empty before (French users saw none): the journal says so, and Undo empties it again.
    const tip2 = r.add('attribute', 'attribute|acc.city|Description', { [EN]: 'The city.', [FR]: '' }, { prop: 'Description', baseRequired: false }).key;
    eq(r.store.emptyOnPurpose(tip2, FR, EN), true, 'loaded stored empty');
    r.store.set(tip2, FR, 'La ville.');
    await r.publish();
    [e] = readHistory(r.app.ctx);
    eq(e.items.map((it) => [it.before, it.after, it.empty ?? null]), [['', 'La ville.', true]]);
    rows = undoRows(r.app, e, await r.app.saver.current([undoChange(r.store.get(tip2)!, e.items[0])]));
    eq(rows.map((x) => [x.state, x.standIn ?? null, x.empty ?? null]), [['undo', null, true]]);
    rep = await r.app.saver.undo(e, o());
    eq(rep.results.map((x) => [x.outcome, x.change.after, x.change.standIn ?? null]), [['saved', '', null]]);
    eq([r.store.emptyOnPurpose(tip2, FR, EN), r.store.get(tip2)!.labels], [true, { [EN]: 'The city.', [FR]: '' }]);

    // (c) An entry journaled before stored-empty texts were kept apart: '' can't be told from none, so the English text.
    r.store.set(tip2, FR, 'La ville 2.');
    await r.publish();
    [e] = readHistory(r.app.ctx);
    const old = { ...e, items: e.items.map(({ empty: _, ...it }) => it) };
    rep = await r.app.saver.undo(old, o());
    eq(rep.results.map((x) => [x.outcome, x.change.after]), [['saved', 'The city.']]);
  });

  run("Undo of a publish that stored a French tooltip empty where it had none (only spaces typed), from the entry that publish journaled: its users saw the English one, which the undo puts in its place, never \"already as before\"; with no English text either, nothing showed before nor now: already as before, nothing written, the publish undone", async (r) => {
    const tip = tipOf(r, { [EN]: 'Type the name.' });
    r.store.set(tip, FR, '  ');
    await r.publish();
    const [e] = readHistory(r.app.ctx);
    eq(e.items.map((it) => [it.key, it.before, it.after, it.empty ?? null]), [[tip, '', '', null]]);
    const rows = undoRows(r.app, e, await r.app.saver.current([undoChange(r.store.get(tip)!, e.items[0])]));
    eq(rows.map((x) => [x.state, x.now ?? null, x.standIn ?? null, x.empty ?? null]), [['undo', '', { text: 'Type the name.', from: 'base' }, null]]);
    const rep = await r.app.saver.undo(e, o());
    eq([rep.results.map((x) => [x.outcome, x.change.after, x.change.standIn?.from ?? null]), r.server.get(`${tip}#${FR}`)], [[['saved', 'Type the name.', 'base']], 'Type the name.']);
    eq(readHistory(r.app.ctx).find((x) => x.id === e.id)?.undoneAt !== undefined, true, 'undone');
    // No English text either: French users saw nothing before and see nothing now (already as before): the undo saves it
    // empty, which it is already, so nothing is written, and the publish counts as undone.
    const t2 = r.add('attribute', 'attribute|acc.city|Description', {}, { prop: 'Description', baseRequired: false }).key;
    r.store.set(t2, FR, ' ');
    await r.publish();
    const [e2] = readHistory(r.app.ctx);
    eq([e2.items.map((it) => [it.key, it.before, it.after, it.empty ?? null]), r.server.get(`${t2}#${FR}`)], [[[t2, '', '', null]], '']);
    const rows2 = undoRows(r.app, e2, await r.app.saver.current([undoChange(r.store.get(t2)!, e2.items[0])]));
    eq(rows2.map((x) => [x.state, x.why ?? null]), [['same', null]]);
    const writes = r.writes.length;
    const rep2 = await r.app.saver.undo(e2, o());
    eq([rep2.results.map((x) => [x.outcome, refusedBlank(x, EN)]), r.writes.length], [[['unchanged', false]], writes]);
    const x2 = readHistory(r.app.ctx).find((x) => x.id === e2.id)!;
    eq([x2.undoneAt !== undefined, x2.kept ?? 0], [true, 0], 'undone: already as before, nothing kept');
  });

  run("Undo of a publish that gave a French tooltip its first text where its English text is empty saves it empty: its users saw no text before the publish, which '' gives them again (never \"stays\", never refused); Redo puts the text back", async (r) => {
    const tip = tipOf(r, {});
    r.store.set(tip, FR, 'Astuce');
    await r.publish();
    const [e] = readHistory(r.app.ctx);
    eq(e.items.map((it) => [it.before, it.after, it.empty ?? null]), [['', 'Astuce', null]]);
    const back = undoChange(r.store.get(tip)!, e.items[0]);
    eq([back.untranslated, r.app.saver.validate([back], { undo: true })], [true, []], 'nothing refused: the undo drops the mark (withStandIns)');
    const rows = undoRows(r.app, e, await r.app.saver.current([back]));
    eq(rows.map((x) => [x.state, x.now ?? null, x.standIn ?? null, x.empty ?? null, x.why ?? null]), [['undo', 'Astuce', null, true, null]]);
    const rep = await r.app.saver.undo(e, o());
    eq(rep.results.map((x) => [x.outcome, x.change.after, x.change.untranslated ?? null, x.change.standIn ?? null, refusedBlank(x, EN)]), [['saved', '', null, null, false]]);
    eq([r.writes.at(-1)!.ids, r.server.get(`${tip}#${FR}`), r.store.emptyOnPurpose(tip, FR, EN)], [[[`${tip}#${FR}`, '']], '', true]);
    eq(readHistory(r.app.ctx).find((x) => x.id === e.id)?.undoneAt !== undefined, true, 'undone');
    const [u] = readHistory(r.app.ctx);
    eq(u.items.map((it) => [it.before, it.after, it.empty ?? null]), [['Astuce', '', null]]);
    const redo = await r.app.saver.undo(u, o());
    eq([redo.results.map((x) => [x.outcome, x.change.after]), r.server.get(`${tip}#${FR}`)], [[['saved', 'Astuce']], 'Astuce']);
    // The stand-in is measured by the English text as the undo leaves it: a publish that gave both their first text is
    // undone to no English text either, so French users saw none before it: saved empty too, never "The city.".
    const t2 = r.add('attribute', 'attribute|acc.city|Description', {}, { prop: 'Description', baseRequired: false }).key;
    r.store.set(t2, EN, 'The city.');
    r.store.set(t2, FR, 'La ville.');
    await r.publish();
    const [e2] = readHistory(r.app.ctx);
    const rep2 = await r.app.saver.undo(e2, o());
    eq(rep2.results.map((x) => [x.change.lcid, x.outcome, x.change.after]), [[EN, 'saved', ''], [FR, 'saved', '']]);
    eq(r.store.get(t2)!.labels, { [EN]: '', [FR]: '' });
  });

  run("the Publish dialog's plan: an emptied French tooltip is sent as it is (no stand-in, nothing blocked or warned); Try again would send it again (a failure saving it empty isn't a refusal)", async (r) => {
    const tip = tipOf(r, { [EN]: '', [FR]: 'Tapez le nom.' });
    r.store.set(tip, FR, '');
    const plan = planPublish(r.app, r.store.changes());
    eq([plan.send.length, [...plan.blocked.keys()], [...plan.warns.keys()], plan.written.get(`${tip}#${FR}`)?.after], [1, [], [], '']);
    r.failOnce.add(`${tip}#${FR}`);
    const { rep } = await r.publish();
    eq([rep.results[0].outcome, refusedBlank(rep.results[0], EN)], ['error', false]);
  });

  // ---- the metadata writers: '' for that language only ----

  /** A column (attribute PUT) on the fake Dataverse; `drop`: it answers every write (204) but applies none (LIVE-FINDINGS 62). */
  const column = (db: Record<'DisplayName' | 'Description', Labels>, drop = false) => {
    const f = fake(
      () => ({ '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata', MetadataId: ID, LogicalName: 'name', DisplayName: lab(db.DisplayName), Description: lab(db.Description), IsCustomizable: { Value: true }, IsRenameable: { Value: true }, IsManaged: false }),
      (b) => {
        if (drop) return;
        merge(db.DisplayName, b.DisplayName);
        merge(db.Description, b.Description);
      },
    );
    const slot = (prop: 'DisplayName' | 'Description') => S('attribute', 'attribute|acc.name', prop, { ...db[prop] }, { ref: { entity: 'acc', attribute: 'name', metadataId: ID } });
    return { ...f, slot };
  };

  test("empty descriptions: a column's PUT carries every language of its tooltip with French '' (the complete-labels rule, so the base language is never overwritten), nothing of its name; saved, stored empty; a name emptied is refused by the writer (its last guard)", () =>
    fast(async () => {
      const db = { DisplayName: { [EN]: 'Name', [FR]: 'Nom' }, Description: { [EN]: 'Type the name.', [FR]: 'Tapez le nom.', [DE]: 'Name eingeben.' } };
      const c = column(db);
      const res = await writerOf('attribute').save(c.ctx as never, [change(c.slot('Description'), FR, '')], opts());
      eq(res.map((x) => [x.outcome, x.message ?? null]), [['saved', null]]);
      eq(c.writes.map((w) => [w.method, Object.keys(w.body).filter((k) => /Name$|Description$/.test(k) && k !== 'LogicalName'), sent(w.body.Description)]), [['PUT', ['Description'], { [EN]: 'Type the name.', [FR]: '', [DE]: 'Name eingeben.' }]]);
      eq(db.Description, { [EN]: 'Type the name.', [FR]: '', [DE]: 'Name eingeben.' }, 'French stored empty, the others as they were');
      eq(db.DisplayName, { [EN]: 'Name', [FR]: 'Nom' });
      // A name emptied never reaches Dataverse blank (the saver writes its stand-in; the writer refuses one that slipped through).
      const n = await writerOf('attribute').save(c.ctx as never, [change(c.slot('DisplayName'), FR, '')], opts());
      eq([n.map((x) => [x.outcome, x.message]), c.writes.length], [[['error', CANT_CLEAR_TEXT]], 1]);
    }),
  );

  test("empty descriptions: only spaces where a column has no French tooltip at all write French '' (stored empty: its users see none, not the English one); already stored empty, nothing is written", () =>
    fast(async () => {
      const db = { DisplayName: { [EN]: 'Name' }, Description: { [EN]: 'Type the name.' } as Labels };
      const c = column(db);
      const res = await writerOf('attribute').save(c.ctx as never, [change(c.slot('Description'), FR, '   ')], opts());
      eq(res.map((x) => x.outcome), ['saved']);
      eq([c.writes.map((w) => sent(w.body.Description)), db.Description], [[{ [EN]: 'Type the name.', [FR]: '' }], { [EN]: 'Type the name.', [FR]: '' }]);
      const again = await writerOf('attribute').save(c.ctx as never, [change(c.slot('Description'), FR, ' ', '')], opts());
      eq([again.map((x) => x.outcome), c.writes.length], [['unchanged'], 1]);
    }),
  );

  test("empty descriptions: a tooltip saved empty where a column has no French at all is never called saved while Dataverse still shows no French label (a write answered but not applied, LIVE-FINDINGS 62): written again, then not confirmed, as a text would be; the read tells a '' stored from none", () =>
    fast(async () => {
      const db = { DisplayName: { [EN]: 'Name' }, Description: { [EN]: 'Type the name.' } as Labels };
      const c = column(db, true);
      const res = await writerOf('attribute').save(c.ctx as never, [change(c.slot('Description'), FR, '   ')], opts());
      eq(res.map((x) => x.outcome), ['error']);
      ok(/^Dataverse still shows no French text, \d+ seconds after writing it 2 times\. Dataverse accepted the change but doesn't show it yet/.test(res[0].message ?? ''), res[0].message);
      eq(c.writes.map((w) => sent(w.body.Description)), [{ [EN]: 'Type the name.', [FR]: '' }, { [EN]: 'Type the name.', [FR]: '' }], 'written again once, the English text as it is');
      eq(db.Description, { [EN]: 'Type the name.' }, 'still none: French users still see the English one');
      // The same write applied: '' stored, saved.
      const ok2 = column({ DisplayName: { [EN]: 'Name' }, Description: { [EN]: 'Type the name.' } as Labels });
      eq((await writerOf('attribute').save(ok2.ctx as never, [change(ok2.slot('Description'), FR, '')], opts())).map((x) => [x.outcome, x.message ?? null]), [['saved', null]]);
    }),
  );

  test("empty descriptions: an edit made where a column had no French tooltip at all that finds one stored empty since (someone saved it empty) is a conflict, never written over: at save, and after a reload (shown changed under the edit); Keep mine writes it; only spaces there find it already as asked", () =>
    fast(async () => {
      const db = { DisplayName: { [EN]: 'Name' }, Description: { [EN]: 'Type the name.' } as Labels };
      const c = column(db);
      const store = new Store();
      store.add([c.slot('Description')]);
      store.set(TIP, FR, 'Saisissez le nom');
      eq(store.changes().map((x) => [x.before, x.beforeMissing ?? null]), [['', true]], 'made over no label at all');
      // The base survives the store's own undo and redo, and an edit given its base back ('' for one still missing).
      store.undo();
      store.redo();
      eq(store.changes().map((x) => x.beforeMissing ?? null), [true]);
      db.Description[FR] = ''; // someone else saves it empty
      const res = await writerOf('attribute').save(c.ctx as never, store.changes(), opts());
      eq(res.map((x) => [x.outcome, x.server ?? null, x.message ?? null]), [['conflict', '', 'Someone changed this label after you loaded it.']]);
      eq([c.writes.length, db.Description], [0, { [EN]: 'Type the name.', [FR]: '' }], 'nothing written: their choice stays');
      // A reload brings their '' under the edit: changed on the server since it was made (the Publish dialog says so).
      eq(store.moved(TIP, FR), false, 'not loaded yet');
      store.add([c.slot('Description')]);
      eq([store.moved(TIP, FR), store.changes().map((x) => [x.before, x.beforeMissing ?? null])], [true, [['', true]]]);
      store.commit(res);
      eq(store.cellStatus(TIP, FR), { outcome: 'conflict', message: 'Someone changed this label after you loaded it.', server: '' });
      // Keep mine: measured against their '' from now on, so the next save writes it over.
      store.resolve(TIP, FR, true);
      eq([store.moved(TIP, FR), store.changes().map((x) => [x.before, x.beforeMissing ?? null])], [false, [['', null]]]);
      const mine = await writerOf('attribute').save(c.ctx as never, store.changes(), opts());
      eq([mine.map((x) => x.outcome), db.Description], [['saved'], { [EN]: 'Type the name.', [FR]: 'Saisissez le nom' }]);
      // Only spaces typed over none, someone else's '' since: already as asked (stored empty), nothing written.
      const db2 = { DisplayName: { [EN]: 'Name' }, Description: { [EN]: 'Type the name.' } as Labels };
      const c2 = column(db2);
      const st2 = new Store();
      st2.add([c2.slot('Description')]);
      st2.set(TIP, FR, '  ');
      db2.Description[FR] = '';
      eq([(await writerOf('attribute').save(c2.ctx as never, st2.changes(), opts())).map((x) => x.outcome), c2.writes.length], [['unchanged'], 0]);
      // A name keeps '' and none alike (its loader drops a stored ''): no such mark.
      const st3 = new Store();
      st3.add([c.slot('DisplayName')]);
      st3.set(NAME, FR, 'Nom');
      eq(st3.changes().map((x) => x.beforeMissing ?? null), [null]);
      // A base given back as '' for a language still missing is no label there either (a restored snapshot).
      const st4 = new Store();
      st4.add([c2.slot('Description')]);
      st4.set(TIP, DE, 'Namen eingeben', '');
      eq(st4.changes().map((x) => [x.lcid, x.beforeMissing ?? null]), [[DE, true]]);
    }),
  );

  test("empty descriptions: a table's PUT and a global choice's PUT send French '' with every other language of the description", () =>
    fast(async () => {
      const t1 = { DisplayName: { [EN]: 'Account', [FR]: 'Compte' }, DisplayCollectionName: { [EN]: 'Accounts', [FR]: 'Comptes' }, Description: { [EN]: 'A company.', [FR]: 'Une société.' } };
      const ent = fake(
        () => ({ '@odata.type': '#Microsoft.Dynamics.CRM.EntityMetadata', MetadataId: ID, LogicalName: 'acc', DisplayName: lab(t1.DisplayName), DisplayCollectionName: lab(t1.DisplayCollectionName), Description: lab(t1.Description), IsCustomizable: { Value: true }, IsRenameable: { Value: true }, IsManaged: false }),
        (b) => merge(t1.Description, b.Description),
      );
      const es = S('entity', 'entity|acc', 'Description', { ...t1.Description }, { ref: { entity: 'acc', metadataId: ID } });
      eq((await writerOf('entity').save(ent.ctx as never, [change(es, FR, '')], opts())).map((x) => x.outcome), ['saved']);
      eq([ent.writes.map((w) => [w.method, sent(w.body.Description), 'DisplayName' in w.body]), t1.Description], [[['PUT', { [EN]: 'A company.', [FR]: '' }, false]], { [EN]: 'A company.', [FR]: '' }]);

      const g = { DisplayName: { [EN]: 'Color', [FR]: 'Couleur' }, Description: { [EN]: 'A color.', [FR]: 'Une couleur.' } };
      const gs = fake(
        () => ({ '@odata.type': '#Microsoft.Dynamics.CRM.OptionSetMetadata', MetadataId: ID, Name: 'new_color', IsGlobal: true, DisplayName: lab(g.DisplayName), Description: lab(g.Description), IsCustomizable: { Value: true }, IsManaged: false }),
        (b) => merge(g.Description, b.Description),
      );
      const ss = S('globaloptionset', 'globaloptionset|new_color', 'Description', { ...g.Description }, { entity: '', ref: { name: 'new_color', metadataId: ID } });
      eq((await writerOf('globaloptionset').save(gs.ctx as never, [change(ss, FR, '')], opts())).map((x) => x.outcome), ['saved']);
      eq([gs.writes.map((w) => [w.url, sent(w.body.Description)]), g.Description], [[[`GlobalOptionSetDefinitions(${ID})`, { [EN]: 'A color.', [FR]: '' }]], { [EN]: 'A color.', [FR]: '' }]);
    }),
  );

  /** A choice option (`kind`) on the fake Dataverse: UpdateOptionValue, or UpdateStateValue for a status. */
  const option = (kind: Kind, cast: string, label: Labels, desc: Labels) => {
    const o1 = { Value: 1, Label: label, Description: desc, DefaultStatus: 3 };
    const o2 = { Value: 2, Label: { [EN]: 'Large', [FR]: 'Grand' }, Description: { [EN]: 'Big.', [FR]: 'Gros.' }, DefaultStatus: 4 };
    const show = (x: typeof o1) => ({ Value: x.Value, Label: lab(x.Label), Description: lab(x.Description), ...(kind === 'state' ? { DefaultStatus: x.DefaultStatus } : {}) });
    const global = kind === 'globaloption';
    const set = () => (cast === 'Boolean' ? { TrueOption: show(o1), FalseOption: { ...show(o2), Value: 0 } } : { Options: [show(o1), show(o2)] });
    const f = fake(
      () => (global ? { MetadataId: ID, Name: 'new_color', IsCustomizable: { Value: true }, IsManaged: false, ...set() } : { LogicalName: 'kind', IsCustomizable: { Value: true }, IsManaged: false, OptionSet: { IsManaged: false, ...set() } }),
      (b) => {
        merge(o1.Label, b.Label);
        merge(o1.Description, b.Description);
      },
    );
    const ref = global ? { name: 'new_color', value: 1 } : { entity: 'acc', attribute: kind === 'state' ? 'statecode' : kind === 'status' ? 'statuscode' : 'kind', value: 1, cast };
    const slot = S(kind, `${kind}|acc.kind|1`, 'Description', { ...desc }, { ref });
    return { ...f, o1, o2, slot };
  };

  test("empty descriptions: UpdateOptionValue (a choice's option, a status reason, a Yes/No option, a global choice's option) sends French '' alone, no Label, MergeLabels; UpdateStateValue (a status) every language of the description with French '', no Label nor default status; the other languages and the label stay", () =>
    fast(async () => {
      for (const [kind, cast] of [['option', 'Picklist'], ['status', 'Status'], ['boolean', 'Boolean'], ['globaloption', ''], ['state', 'State']] as Array<[Kind, string]>) {
        const x = option(kind, cast, { [EN]: 'Small', [FR]: 'Petit' }, { [EN]: 'Not big.', [FR]: 'Pas gros.', [DE]: 'Nicht groß.' });
        const res = await writerOf(kind).save(x.ctx as never, [change(x.slot, FR, '')], opts());
        eq(res.map((r: ChangeResult) => [r.outcome, r.message ?? null]), [['saved', null]], kind);
        const [w] = x.writes;
        eq([w.url, 'Label' in w.body, w.body.MergeLabels, 'DefaultStatusCode' in w.body], [kind === 'state' ? 'UpdateStateValue' : 'UpdateOptionValue', false, true, false], kind);
        eq(sent(w.body.Description), kind === 'state' ? { [EN]: 'Not big.', [FR]: '', [DE]: 'Nicht groß.' } : { [FR]: '' }, kind);
        eq([x.o1.Description, x.o1.Label, x.o2.Description], [{ [EN]: 'Not big.', [FR]: '', [DE]: 'Nicht groß.' }, { [EN]: 'Small', [FR]: 'Petit' }, { [EN]: 'Big.', [FR]: 'Gros.' }], kind);
      }
    }),
  );

  // ---- the loader ----

  test("empty descriptions: the loader keeps a stored '' as present-and-empty for descriptions only (stored empty: its users see none); for names, as missing; a missing language stays missing", async () => {
    const opt = (v: number, l: Labels, d: Labels) => ({ Value: v, MetadataId: ID, Label: lab(l), Description: lab(d) });
    const account = {
      LogicalName: 'acc',
      MetadataId: ID,
      DisplayName: lab({ [EN]: 'Account', [FR]: '' }),
      DisplayCollectionName: lab({ [EN]: 'Accounts', [FR]: 'Comptes' }),
      Description: lab({ [EN]: 'A company.', [FR]: '' }),
      IsCustomizable: { Value: true },
      IsManaged: false,
      IsCustomEntity: true,
      IsRenameable: { Value: true },
      Attributes: [
        { LogicalName: 'name', MetadataId: ID, AttributeType: 'String', DisplayName: lab({ [EN]: 'Name', [FR]: '' }), Description: lab({ [EN]: 'Type the name.', [FR]: '' }), IsCustomizable: { Value: true }, IsManaged: false, IsCustomAttribute: true, IsRenameable: { Value: true }, IsValidForForm: true },
        { LogicalName: 'city', MetadataId: ID, AttributeType: 'String', DisplayName: lab({ [EN]: 'City' }), Description: lab({ [EN]: 'The city.' }), IsCustomizable: { Value: true }, IsManaged: false, IsCustomAttribute: true, IsRenameable: { Value: true }, IsValidForForm: true },
      ],
    };
    const kinds = [{ LogicalName: 'kind', IsCustomizable: { Value: true }, IsManaged: false, OptionSet: { Name: 'acc_kind', IsGlobal: false, IsManaged: false, Options: [opt(1, { [EN]: 'Small', [FR]: '' }, { [EN]: 'Not big.', [FR]: '' })] } }];
    const http = { get: async () => copy(account), all: async (u: string) => (u.includes('CRM.PicklistAttributeMetadata') ? copy(kinds) : []) };
    const slots = await loadTables({ http, user: FR, base: EN, langs: [] } as never, ['acc'], new Set<Kind>(['entity', 'attribute', 'option']), { signal: new AbortController().signal, progress() {} });
    const by = Object.fromEntries(slots.map((s) => [s.key, s.labels]));
    eq(by['entity|acc|DisplayName'], { [EN]: 'Account' }, 'a name stored empty: missing');
    eq(by['entity|acc|Description'], { [EN]: 'A company.', [FR]: '' });
    eq([by['attribute|acc.name|DisplayName'], by['attribute|acc.name|Description']], [{ [EN]: 'Name' }, { [EN]: 'Type the name.', [FR]: '' }]);
    eq(by['attribute|acc.city|Description'], { [EN]: 'The city.' }, 'none: missing');
    eq([by['option|acc.kind|1|Label'], by['option|acc.kind|1|Description']], [{ [EN]: 'Small' }, { [EN]: 'Not big.', [FR]: '' }]);
    // In the store: stored empty is translated; missing is missing.
    const st = new Store();
    st.add(slots);
    eq([st.emptyOnPurpose('attribute|acc.name|Description', FR, EN), st.emptyOnPurpose('attribute|acc.city|Description', FR, EN), st.emptyOnPurpose('attribute|acc.name|DisplayName', FR, EN)], [true, false, false]);
  });

  // ---- the store and the looks ----

  /** A store with a column's name and tooltip, `fr` the tooltip's French labels; the app the looks read. */
  const page = (fr: Labels, o: Partial<Slot> = {}) => {
    const store = new Store();
    store.add([S('attribute', 'attribute|acc.name', 'DisplayName', { [EN]: 'Name', [FR]: 'Nom' }), S('attribute', 'attribute|acc.name', 'Description', { [EN]: 'Type the name.', ...fr }, o)]);
    const app = { store, ctx: { base: EN, user: FR, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] }, prefs: { target: FR, shown: [], showNames: false, dock: 'right' } } as unknown as AppApi;
    return { store, app, tip: store.get(TIP)! };
  };

  test("empty descriptions: the store keeps a tooltip saved empty as a text of its own (a name's '' as none); the looks count it translated (the page's marks, the popup's amber, the Workbench's grid and filters), a missing one stays missing", () => {
    // The store's commit: '' stays for the tooltip, goes for a name.
    const st = new Store();
    const d = S('attribute', 'attribute|acc.name', 'Description', { [EN]: 'Type the name.', [FR]: 'Tapez le nom.' });
    const n = S('attribute', 'attribute|acc.name', 'DisplayName', { [EN]: 'Name', [FR]: 'Nom' });
    st.add([d, n]);
    st.commit([{ change: change(d, FR, ''), outcome: 'saved' }, { change: change(n, FR, ''), outcome: 'saved' }]);
    eq([st.get(d.key)!.labels, st.get(n.key)!.labels], [{ [EN]: 'Type the name.', [FR]: '' }, { [EN]: 'Name' }]);

    const empty = page({ [FR]: '' });
    const none = page({});
    // The page's marks: a component whose label is its description (its name not loaded), and the slot look.
    for (const [x, want] of [[empty, 'ok'], [none, 'missing']] as const) {
      const solo = new Store();
      solo.add([x.tip]);
      eq(look({ ...x.app, store: solo } as AppApi, 'attribute|acc.name'), want);
      eq(slotLook(x.app, x.tip), want);
      eq(isMissing(x.store, x.tip, FR, EN), want === 'missing', 'popup amber');
      eq(missing(x.store, x.tip, FR, EN), want === 'missing', 'Workbench');
    }
    // The Workbench's cells: a quiet "(empty)", its tooltip saying why; missing: the dash.
    eq(langCell(empty.store, empty.tip, FR, EN), { cls: ' is-em', tip: 'Saved empty: French users see no tooltip.', was: '', to: EMPTY });
    eq(langCell(none.store, none.tip, FR, EN), { cls: ' is-mi', tip: 'Missing in French.', was: '', to: '' });
    // Rows › "French is blank" (and "matches English or is blank"): not a tooltip stored empty.
    for (const m of ['blank', 'sameOrBlank'] as const) {
      eq([rowsTest(m, empty.store, EN, FR, [EN, FR])(empty.tip), rowsTest(m, none.store, EN, FR, [EN, FR])(none.tip)], [false, true], m);
    }
    // A choice option's description stored empty: the same.
    const os = S('option', 'option|acc.kind|1', 'Description', { [EN]: 'Not big.', [FR]: '' });
    const ost = new Store();
    ost.add([os]);
    eq([ost.emptyOnPurpose(os.key, FR, EN), langCell(ost, os, FR, EN).tip], [true, 'Saved empty: French users see no description.']);
  });

  test("empty descriptions: the Workbench: clearing a French tooltip cell saves it empty (no stand-in, no problem): green, a quiet \"(empty)\" and why; its editor says so as it is typed; the bulk rule agrees; the base language and names keep theirs", () => {
    const { store, tip } = page({ [FR]: 'Tapez le nom.' });
    const text: TextOf = (k, l) => store.text(k, l);
    eq(blankEdit(tip, FR, EN, 'Tapez le nom.', '', text), 'empty');
    eq(blankEdit(tip, FR, EN, '', '  ', text), 'empty', 'only spaces where there is none');
    eq(blankEdit(tip, EN, EN, 'Type the name.', '', text), '', 'the base language: its own rules');
    eq(blankEdit(store.get(NAME)!, FR, EN, 'Nom', '', text), 'standin', 'a name: its stand-in');
    store.set(TIP, FR, '');
    eq(clearing(store, tip, FR, EN), 'empty');
    ok(!rowProblem(store, tip, [EN, FR], EN), 'no problem to fix');
    // Pending, in the words of a stand-in's tooltip ("Becomes “X” when you save"): never "Saved empty" beside "not saved yet".
    const pending = 'Saved empty when you save: French users then see no tooltip. Was “Tapez le nom.”.';
    eq(langCell(store, tip, FR, EN), { cls: ' is-ed is-em', tip: pending, was: '', to: EMPTY });
    eq(edLook(tip, FR, EN, 'Tapez le nom.', 'Tapez le nom.', '', 'English', text), { cls: ' is-ed', tip: pending });
    eq(missing(store, tip, FR, EN), false, 'staged empty: done, not missing (Fill missing leaves it)');
    // A save that stopped before it says so first, then what saving does.
    store.commit([{ change: store.changes()[0], outcome: 'skipped', message: 'Cancelled before saving' }]);
    eq(langCell(store, tip, FR, EN).tip, `Not saved: Cancelled before saving. ${pending}`);
    // Only spaces where there is none: what it was, as a pending cell says it.
    const none = page({});
    none.store.set(TIP, FR, '  ');
    eq(langCell(none.store, none.tip, FR, EN).tip, 'Saved empty when you save: French users then see no tooltip. It was blank.');
    // Stored empty (saved): the plain words.
    const stored = page({ [FR]: '' });
    eq(langCell(stored.store, stored.tip, FR, EN).tip, 'Saved empty: French users see no tooltip.');
  });

  test('empty descriptions: an Excel or CSV import still takes an empty cell for "no change": a French tooltip the file leaves empty is never emptied', async () => {
    const store = new Store();
    store.add([S('attribute', 'attribute|acc.name', 'Description', { [EN]: 'Type the name.', [FR]: 'Tapez le nom.' })]);
    const io = createIo();
    const file = new File([[`${CSV_KEY},Type,Table,Component,Property,1033,1036`, `${TIP},,acc,,,Type the name.,`].join('\r\n')], 'labels.csv');
    const r = io.apply(await io.parse(file), store);
    eq([r.staged, store.pendingCount(), store.value(TIP, FR)], [0, 0, 'Tapez le nom.']);
  });

  test("empty descriptions: the popup's words: placeholder \"No French tooltip\" where French users see none (stored or staged empty), \"Shows “…”\" where they see the English one (missing); the line under the input while it is emptied; never a problem", () => {
    const stored = page({ [FR]: '' });
    eq(placeholderOf(stored.store, stored.tip, FR, EN, 'Tooltip', 'French'), 'No French tooltip');
    eq(becomes(stored.store, stored.tip, FR, EN, 'French'), '', 'not changed: nothing to say');
    const none = page({});
    eq(placeholderOf(none.store, none.tip, FR, EN, 'Tooltip', 'French'), 'Shows “Type the name.”');
    // Spaces typed where there is no French tooltip: the popup trims them away when it closes, so nothing is saved and the
    // line says nothing.
    none.store.set(TIP, FR, ' ');
    eq(becomes(none.store, none.tip, FR, EN, 'French'), '', 'nothing to empty');
    const x = page({ [FR]: 'Tapez le nom.' });
    x.store.set(TIP, FR, '');
    eq([placeholderOf(x.store, x.tip, FR, EN, 'Tooltip', 'Français'), becomes(x.store, x.tip, FR, EN, 'Français'), problem(x.store, x.tip, FR, EN)], ['No Français tooltip', 'Saved empty: Français users see no tooltip.', '']);
    // Its English text empty too: still saved empty, never refused.
    x.store.set(TIP, EN, '');
    eq([problem(x.store, x.tip, FR, EN), becomes(x.store, x.tip, FR, EN, 'French')], ['', 'Saved empty: French users see no tooltip.']);
    // A name emptied: its stand-in, as before.
    x.store.set(NAME, FR, '');
    eq(becomes(x.store, x.store.get(NAME)!, FR, EN, 'French'), "Becomes “Name”: Dataverse can't remove a translation here, so French gets the English text.");
  });
}
