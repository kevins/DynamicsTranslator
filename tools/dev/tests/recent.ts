// Recent publishes (ui/review.ts): each publish opens in place to show what it changed in the Publish dialog's rows (the
// shared renderer: changeGroup, entryGroups), and Undo first shows what it will do to each label, from its text read on
// the server (saver.current, Writer.read), writing nothing until it is confirmed. On the savepath rig (the real saver and
// journal, a writer like the real ones on an in-memory server) and the popup tests' fake DOM.
import { addHistory, readHistory } from '../../../src/core/history';
import { MANAGED, PublishSet, type Change, type ChangeResult, type Lcid, type Slot } from '../../../src/core/model';
import { createSaver } from '../../../src/core/saver';
import { Store } from '../../../src/core/store';
import { metadataWriters } from '../../../src/providers/metadata';
import type { Writer } from '../../../src/providers/types';
import { h } from '../../../src/ui/dom';
import { changeGroup, entryGroups, namings, namingText, openHistory, openReview, planPublish, rowNote, titleOf, undoCount, undoRows, whereOf } from '../../../src/ui/review';
import type { AppApi, HistoryEntry, HistoryItem } from '../../../src/ui/types';
import { setLayer, teardownLayer } from '../../../src/ui/widgets';
import { dom, fire, install, type FEl } from './callout';
import type { Kit } from './kit';
import { fast } from './lang';
import { batchOf } from './records';
import { rig, type Rig } from './savepath';

const EN = 1033;
const FR = 1036;
const DE = 1031;
const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

/** Each group of a list of changes: its header, then each row as "language: texts | its notes". */
const groups = (root: FEl): string[][] =>
  root.querySelectorAll('.pd-g').map((g) => [
    g.querySelector('.pd-h')!.textContent,
    ...g.querySelectorAll('.pd-r').map((r) => [`${r.querySelector('.pd-l')!.textContent}: ${r.querySelector('.wd')!.textContent}`, ...r.querySelectorAll('.iss').map((i) => i.textContent)].join(' | ')),
  ]);

interface D {
  r: Rig;
  dlg(): FEl;
  title(): string;
  text(): string;
  /** Clicks the first button of the topmost dialog with this text. */
  click(label: string): void;
  until(what: string, cond: () => boolean): Promise<void>;
  /** The Undo question's primary button (Undo N changes, Mark as undone). */
  go(): FEl | null;
  /** Waits until the Undo question has read the labels. */
  asked(): Promise<void>;
  /** Waits until its Undo can be clicked (others' work checked too). */
  ready(): Promise<void>;
}

export function register(t: Kit): void {
  const withDom = (fn: () => void) => () => {
    const off = install();
    try {
      fn();
    } finally {
      off();
    }
  };
  /** A test on the rig with the dialogs' fake DOM; the Workbench view, so nothing refreshes the page. */
  const dialog = (name: string, fn: (d: D) => Promise<void>) =>
    t.test(`recent publishes: ${name}`, async () => {
      const r = rig(t);
      const off = install();
      setLayer(dom.layer as unknown as HTMLElement);
      Object.assign(r.app, { view: () => 'workbench', refreshPage: async () => true, adoptStyles() {}, toast() {} });
      const d: D = {
        r,
        dlg: () => dom.layer.querySelectorAll('.dialog').pop()!,
        title: () => d.dlg().querySelector('h3')!.textContent,
        text: () => d.dlg().textContent,
        click(label) {
          const b = d.dlg().querySelectorAll('button').find((x) => x.textContent === label);
          t.ok(b, `no ${label} button in: ${d.text()}`);
          fire(b!, 'click', { detail: 1 });
        },
        async until(what, cond) {
          for (let i = 0; i < 400 && !cond(); i++) await tick(5);
          t.ok(cond(), `${what}; the dialog shows: ${d.title()} | ${d.text()}`);
        },
        go: () => (d.title() === 'Undo this publish?' ? d.dlg().querySelector('.dlg-actions .btn.primary') : null),
        asked: () => d.until('the Undo question has read the labels', () => !!d.go() && !d.dlg().querySelector('.dlg-body .spin') && !!d.dlg().querySelector('.pd-g')),
        ready: () => d.until('Undo can be clicked', () => !!d.go() && !d.go()!.disabled),
      };
      try {
        await fn(d);
      } finally {
        teardownLayer();
        off();
        r.done();
      }
    });
  /** Publishes the staged changes as the Publish dialog does: the journal names each label as its rows do. */
  const publish = (r: Rig) =>
    r.app.saver.save(planPublish(r.app, r.store.changes()).send, { signal: new AbortController().signal, publish: true, onProgress() {}, describe: (s) => ({ title: titleOf(r.app, s), where: whereOf(s) }) });
  /** The rig's labels, French translated: `fr` '' for none. */
  const col = (r: Rig, x: string, fr: string, o: Partial<Slot> = {}) =>
    r.add('attribute', `attribute|acc.${x}|DisplayName`, fr ? { [EN]: x.toUpperCase(), [FR]: fr } : { [EN]: x.toUpperCase() }, { title: x.toUpperCase(), prop: 'DisplayName', path: ['Account', 'Columns'], ...o }).key;

  // ---- the shared renderer ----

  t.test(
    'recent publishes: the shared row renderer, from plain data: a heading "title · what · where", each language with its old text struck through → the new one, its last column, its notes and tone',
    withDom(() => {
      const end = h('button', null, 'Undo');
      const g = changeGroup(
        {
          title: 'Name',
          what: 'Form label',
          where: 'Account (Main form) › General',
          rows: [
            { lang: 'French', before: 'Nom', after: 'Prénom', tone: 'amb', end, notes: [rowNote('warn', 'Changed since this publish')] },
            { lang: 'German', before: '', after: 'Name' },
          ],
        },
        5,
      ) as unknown as FEl;
      const head = g.querySelector('.pd-h')!;
      t.eq([g.className, head.getAttribute('role'), head.getAttribute('aria-level'), head.textContent], ['pd-g', 'heading', '5', 'Name· Form label · Account (Main form) › General']);
      const [fr, de] = g.querySelectorAll('.pd-r');
      t.eq([fr.className, fr.querySelector('.pd-l')!.textContent, fr.querySelector('.wd del')!.textContent, fr.querySelector('.wd ins')!.textContent], ['pd-r is-amb', 'French', 'Nom', 'Prénom']);
      t.ok(fr.children[2] === (end as unknown as FEl), 'its last column');
      t.eq([fr.querySelector('.iss.warn')!.textContent, de.className, de.querySelector('.wd em')!.textContent, de.children[2].tagName], ['Changed since this publish', 'pd-r', '(empty)', 'SPAN']);
      t.eq((rowNote('ok', 'Undone') as unknown as FEl).className, 'iss pd-ok');
      // No place: the header says title and what only (an entry journaled before places were kept).
      t.eq((changeGroup({ title: 'Name', what: 'Column name (everywhere)', where: '', rows: [] }) as unknown as FEl).querySelector('.pd-h')!.textContent, 'Name· Column name (everywhere)');
    }),
  );

  t.test('recent publishes: journal entries group as the Publish dialog groups: with their place, without one (older entries: title and what only), the copies of a field as one entry with their places', () => {
    const item = (o: Partial<HistoryItem>): HistoryItem => ({ key: 'attribute|acc.name|DisplayName', comp: 'attribute|acc.name', kind: 'attribute', lcid: FR, title: 'Name', before: 'Nom', after: 'Nom du compte', ...o });
    const plain = (its: HistoryItem[]) => ({ lang: String(its[0].lcid), before: its[0].before, after: its[0].after, copies: its.length });
    const head = (gs: ReturnType<typeof entryGroups>) => gs.map((g) => [g.title, g.what, g.where, g.rows.map((r) => `${r.lang}:${r.before}>${r.after}`).join(',')]);
    const cell = (id: string, where: string | undefined, o: Partial<HistoryItem> = {}) => item({ key: `field|f1|${id}|Label`, comp: `field|f1|${id}`, kind: 'field', title: 'Client', before: 'Client', after: 'Client FR', ...(where ? { where } : {}), ...o });
    t.eq(head(entryGroups([item({}), item({ lcid: DE, before: '', after: 'Name DE' }), item({ key: 'entity|acc|DisplayName', comp: 'entity|acc', kind: 'entity', title: 'Account', where: undefined })], plain)), [
      ['Name', 'Column name (everywhere)', '', '1036:Nom>Nom du compte,1031:>Name DE'],
      ['Account', 'Table name', '', '1036:Nom>Nom du compte'],
    ]);
    t.eq(head(entryGroups([item({ where: 'Account' })], plain)), [['Name', 'Column name (everywhere)', 'Account', '1036:Nom>Nom du compte']]);
    // Copies on one form: one group naming their places; another text, another form, or another label stays apart.
    const cells = [
      cell('c1', 'Account (Main form) › General › Details'),
      cell('c2', 'Account (Main form) › Memo › Notes'),
      cell('c3', 'Account (Main form) › CCM › Notes', { after: 'Autre' }),
      cell('c4', 'Account (Main form) › General', { key: 'field|f2|c4|Label' }),
    ];
    t.eq(head(entryGroups(cells, plain)), [
      ['Client', 'Form label', 'Account (Main form) · 2 places (General, Memo)', '1036:Client>Client FR'],
      ['Client', 'Form label', 'Account (Main form) › CCM › Notes', '1036:Client>Autre'],
      ['Client', 'Form label', 'Account (Main form) › General', '1036:Client>Client FR'],
    ]);
    t.eq(entryGroups(cells.slice(0, 2), plain)[0].rows.map((r) => (r as unknown as { copies: number }).copies), [2], 'the row gets every copy');
    t.eq(head(entryGroups([cell('c1', undefined), cell('c2', undefined)], plain)).map((g) => g[2]), ['2 places'], 'older entries: no places to name');
    t.eq(entryGroups(cells.slice(0, 2), plain, (it) => it.key).length, 2, '`sig` keeps copies apart');
  });

  // ---- Recent publishes: what each publish changed ----

  dialog('a publish opens in place and shows exactly what the Publish dialog showed before it: the same groups, headers, languages and texts; the journal keeps each place (none when there is none)', async (d) => {
    const { r } = d;
    const cell = (id: string, tab: string, sec: string) =>
      r.add('field', `field|f1|${id}|Label`, { [EN]: 'Client', [FR]: 'Client' }, { title: 'Client', group: 'form|f1', path: ['Account', 'Account (Main form)', tab, sec], ref: { formId: 'f1', datafield: 'client', elId: id } }).key;
    const cells = [cell('c1', 'General', 'Details'), cell('c2', 'Memo', 'Notes')];
    const name = col(r, 'name', 'Nom');
    const table = r.add('entity', 'entity|acc|DisplayName', { [EN]: 'Account' }, { title: 'Account', prop: 'DisplayName', path: ['Account'] }).key;
    r.store.group(() => cells.forEach((k) => r.store.set(k, FR, 'Client FR')));
    r.store.set(name, FR, 'Nom du compte');
    r.store.set(table, FR, 'Compte');
    r.versions.set('f1', [10, 10]);
    // An entry journaled before places were kept.
    addHistory(r.app.ctx, { id: 'old', at: Date.now() - 60_000, published: true, items: [{ key: name, comp: 'attribute|acc.name', kind: 'attribute', lcid: FR, title: 'NAME', before: 'Nom 0', after: 'Nom' }] });
    void openReview(r.app);
    const before = groups(d.dlg());
    t.eq(before, [
      ['Client· Form label · Account (Main form) · 2 places (General, Memo)', 'French: Client→Client FR'],
      ['NAME· Column name (everywhere) · Account', 'French: Nom→Nom du compte'],
      ['Account· Table name', 'French: (empty)→Compte'],
    ]);
    await tick();
    d.click('Publish');
    await d.until('published', () => d.title() === 'Published');
    d.click('Close');
    const [e] = readHistory(r.app.ctx);
    t.eq(e.items.map((i) => [i.title, i.where ?? null]), [['Client', 'Account (Main form) › General › Details'], ['Client', 'Account (Main form) › Memo › Notes'], ['NAME', 'Account'], ['Account', null]]);
    t.ok(!JSON.stringify(e.items[3]).includes('where'), 'no place: no key in the journal');

    openHistory(r.app);
    const [open, old] = d.dlg().querySelectorAll('.pd-ht');
    const panel = d.dlg().querySelector(`[id="${open.getAttribute('aria-controls')}"]`)!;
    // The summary row as before: time, count and titles, Undo; the details closed.
    t.eq([open.parentElement!.tagName, open.querySelector('small')!.textContent, open.getAttribute('aria-expanded'), panel.hidden, panel.getAttribute('role')], ['H4', '4 labels · Client, NAME, Account', 'false', true, 'region']);
    t.ok(open.parentElement!.parentElement!.querySelectorAll('button').some((b) => b.textContent === 'Undo'), 'Undo on its row');
    fire(open, 'click', { detail: 1 });
    t.eq([open.getAttribute('aria-expanded'), panel.hidden], ['true', false]);
    t.eq(groups(panel), before, 'the same rows as before publishing');
    t.eq(panel.querySelector('.pd-h')!.getAttribute('aria-level'), '5', 'headings under the publish');
    fire(open, 'click', { detail: 0 }); // from the keyboard
    t.eq([open.getAttribute('aria-expanded'), panel.hidden], ['false', true]);
    fire(old, 'click', { detail: 1 });
    t.eq(groups(d.dlg().querySelector(`[id="${old.getAttribute('aria-controls')}"]`)!), [['NAME· Column name (everywhere)', 'French: Nom 0→Nom']], 'an older entry: title and what');
  });

  // ---- Undo: what it will do, read first; nothing written before it is confirmed ----

  /**
   * One publish of six French labels, then the server since: `a` as published (undone), `b` changed by someone (left
   * alone unless chosen), `c` a translation the publish added that Dataverse can't remove (a column: the undo writes its
   * English text in its place, model.ts standIn), `s` already back, `u` no longer loaded here, `t` a translation the
   * publish added that Dataverse can't remove and nothing can stand in for (a column with no English name): it stays.
   */
  const sixLabels = async (r: Rig) => {
    const tip = r.add('attribute', 'attribute|acc.t|DisplayName', {}, { title: 'T', prop: 'DisplayName', path: ['Account', 'Columns'] }).key;
    const k = { a: col(r, 'a', 'A fr'), b: col(r, 'b', 'B fr'), c: col(r, 'c', ''), s: col(r, 's', 'S fr'), u: col(r, 'u', 'U fr'), t: tip };
    for (const [x, key] of Object.entries(k)) r.store.set(key, FR, `${x.toUpperCase()} 2`);
    await publish(r);
    r.server.set(`${k.b}#${FR}`, 'B (Marie)');
    r.server.set(`${k.s}#${FR}`, 'S fr');
    r.store.slots.delete(k.u);
    return k;
  };

  dialog('the Undo question reads each label first and says what will happen to it: back to its old text, to its stand-in (a translation Dataverse can\'t remove), changed since (not undone unless chosen), stays (Dataverse can\'t remove it and nothing stands in for it), already as before, not loaded here; nothing is written until Undo, and Cancel writes nothing', async (d) => {
    const { r } = d;
    const k = await sixLabels(r);
    const [e] = readHistory(r.app.ctx);
    const loaded = e.items.filter((it) => r.store.get(it.key)).map((it): Change => ({ slot: r.store.get(it.key)!, lcid: it.lcid, before: it.after, after: it.before }));
    const rows = undoRows(r.app, e, await r.app.saver.current(loaded));
    t.eq(rows.map((x) => [x.it.title, x.state, x.now ?? null]), [['A', 'undo', 'A 2'], ['B', 'changed', 'B (Marie)'], ['C', 'undo', 'C 2'], ['S', 'same', 'S fr'], ['U', 'unloaded', null], ['T', 'stays', 'T 2']]);
    t.eq([rows[2].standIn, rows[5].why], [{ text: 'C', from: 'base' }, 'its English text is empty'], 'C goes to its English text; T has none');
    t.eq([undoCount(rows, new Set()), undoCount(rows, new Set([`${k.b}#${FR}`]))], [2, 3]);

    const writes = r.writes.length;
    const posts = r.posts.length;
    const reads = r.reads ?? 0;
    openHistory(r.app);
    d.click('Undo');
    t.eq(d.title(), 'Undo this publish?');
    t.ok(d.text().includes('Reading the current text…'), d.text());
    await d.asked();
    t.eq(groups(d.dlg()), [
      ['B· Column name (everywhere) · Account', 'French: B (Marie)→B fr | Changed since this publish: not undone unless you choose Undo anyway'],
      ['A· Column name (everywhere) · Account', 'French: A 2→A fr'],
      ['C· Column name (everywhere) · Account', "French: C 2→C | English text: Dataverse can't remove a translation"],
      ['S· Column name (everywhere) · Account', 'French: S fr→S fr | Already as before'],
      ['U· Column name (everywhere) · Account', "French: U 2→U fr | Not loaded here: open the page it's on, or load it in the Workbench, to undo it"],
      ['T· Column name (everywhere) · Account', "French: T 2→(empty) | Stays: Dataverse can't remove it, and its English text is empty"],
    ]);
    t.ok(d.text().includes("1 label changed since this publish is left as it is unless you choose Undo anyway. 1 translation this publish added gets the English text in its place: Dataverse can't remove it. 1 label is already as before. 1 translation this publish added stays: Dataverse can't remove it. 1 label isn't loaded here."), d.text());
    await d.ready();
    t.eq(d.go()!.textContent, 'Undo 2 changes');
    t.eq([r.writes.length, r.posts.length, (r.reads ?? 0) > reads], [writes, posts, true], 'read, nothing written or published');
    d.click('Cancel');
    t.eq(d.title(), 'Recent publishes');
    await tick(20);
    t.eq([r.writes.length, r.posts.length, readHistory(r.app.ctx)[0].undoneAt, r.server.get(`${k.a}#${FR}`)], [writes, posts, undefined, 'A 2'], 'Cancel left everything as it was');
  });

  dialog("Undo N changes writes only those; the result shows each label's outcome in the same rows: undone (a translation Dataverse can't remove: to its stand-in), left as it is, stays, already as before, skipped", async (d) => {
    const { r } = d;
    const k = await sixLabels(r);
    const [e] = readHistory(r.app.ctx);
    const writes = r.writes.length;
    openHistory(r.app);
    d.click('Undo');
    await d.asked();
    await d.ready();
    fire(d.go()!, 'click', { detail: 1 });
    await d.until('undone', () => d.title() === 'Undone with problems');
    t.eq(r.writes.slice(writes).map((w) => w.ids), [[[`${k.a}#${FR}`, 'A fr']], [[`${k.c}#${FR}`, 'C']]], 'only A and C (its English text) were written');
    t.eq([k.a, k.b, k.c, k.s, k.t].map((x) => r.server.get(`${x}#${FR}`)), ['A fr', 'B (Marie)', 'C', 'S fr', 'T 2'], "Marie's text kept");
    t.eq(groups(d.dlg()), [
      ['A· Column name (everywhere) · Account', 'French: A 2→A fr | Undone'],
      ['B· Column name (everywhere) · Account', 'French: B (Marie)→B fr | Changed since this publish, so it was left as it is'],
      ['C· Column name (everywhere) · Account', "French: C 2→C | Undone | English text: Dataverse can't remove a translation"],
      ['S· Column name (everywhere) · Account', 'French: S fr→S fr | Already as before'],
      ['U· Column name (everywhere) · Account', "French: U 2→U fr | This component isn't loaded in the translator. Open its page or load it in the Workbench, then undo again."],
      ['T· Column name (everywhere) · Account', "French: T 2→(empty) | Stays: Dataverse can't remove it, and its English text is empty"],
    ]);
    t.ok(d.text().includes("2 labels undone, 1 label already as before, 1 label changed since, left as it was, 1 translation Dataverse can't remove, 1 label skipped."), d.text());
    const x = readHistory(r.app.ctx).find((y) => y.id === e.id);
    t.ok(x, 'the publish is still in the journal');
    t.eq([x!.items.length, x!.undoneAt], [6, undefined], 'not undone while a label is left');
  });

  dialog("the Undo question measures stand-ins as the undo does, by the texts it leaves on the server: a pending English text it doesn't write never stands in, so a column name with no English name stays, and Undo writes nothing for it", async (d) => {
    const { r } = d;
    const tip = r.add('attribute', 'attribute|acc.t|DisplayName', {}, { title: 'T', prop: 'DisplayName', path: ['Account', 'Columns'] }).key;
    r.store.set(tip, FR, 'T 2');
    await publish(r);
    const [e] = readHistory(r.app.ctx);
    r.store.set(tip, EN, 'Tip'); // staged since, not published
    const loaded: Change[] = [{ slot: r.store.get(tip)!, lcid: FR, before: 'T 2', after: '' }];
    const rows = undoRows(r.app, e, await r.app.saver.current(loaded));
    t.eq(rows.map((x) => [x.state, x.why ?? null, x.standIn ?? null]), [['stays', 'its English text is empty', null]], 'never "Tip", which the undo does not write');
    t.eq(undoCount(rows, new Set()), 0);
    const writes = r.writes.length;
    openHistory(r.app);
    d.click('Undo');
    await d.asked();
    t.eq(groups(d.dlg()), [['T· Column name (everywhere) · Account', "French: T 2→(empty) | Stays: Dataverse can't remove it, and its English text is empty"]]);
    await d.ready();
    t.eq(d.go()!.textContent, 'Mark as undone');
    fire(d.go()!, 'click', { detail: 1 });
    await d.until('done', () => d.title() === 'Undone with problems');
    t.ok(d.text().includes("1 translation Dataverse can't remove."), d.text());
    t.eq([r.writes.length, r.server.get(`${tip}#${FR}`), r.server.has(`${tip}#${EN}`), r.store.value(tip, EN)], [writes, 'T 2', false, 'Tip'], 'nothing written; the staged English text still staged');
    const x = readHistory(r.app.ctx).find((y) => y.id === e.id)!;
    t.eq([!!x.undoneAt, x.kept], [true, 1]);
  });

  dialog("a label whose stand-in is made of texts that aren't loaded here (its column's names) waits for them: the Undo question says what to load and never offers to mark the publish undone; Undo skips it, the publish stays undoable and Try again is offered; once the column is loaded, Try again writes the column's name", async (d) => {
    const { r } = d;
    const COL = 'attribute|acc.phone|DisplayName';
    const column = r.add('attribute', COL, { [EN]: 'Phone', [FR]: 'Téléphone' }, { title: 'Phone', prop: 'DisplayName', path: ['Account', 'Columns'] });
    const cell = r.add('field', 'field|f1|c1|Label', { [EN]: 'Main phone' }, { title: 'Main phone', path: ['Account', 'Main form', 'General'], ref: { formId: 'f1', datafield: 'phone', controlId: 'phone' } }).key;
    const a = col(r, 'a', 'A fr');
    r.store.set(cell, FR, 'Tél. principal');
    r.store.set(a, FR, 'A 2');
    await publish(r);
    const [e] = readHistory(r.app.ctx);
    // The Workbench loaded the forms alone: the column's names aren't loaded.
    r.store.slots.delete(COL);
    openHistory(r.app);
    d.click('Undo');
    await d.asked();
    const rows = groups(d.dlg());
    t.ok(rows.some((g) => g[1] === "French: Tél. principal→(empty) | Its column's names aren't loaded here: load its table's columns, then undo again"), JSON.stringify(rows));
    t.ok(d.text().includes("1 label can't be undone until the texts put in its place are loaded."), d.text());
    t.ok(!d.text().includes('stays'), 'never said to stay');
    await d.ready();
    t.eq(d.go()!.textContent, 'Undo 1 change', 'only A; never "Mark as undone"');
    fire(d.go()!, 'click', { detail: 1 });
    await d.until('undone', () => !!d.dlg().querySelectorAll('button').find((b) => b.textContent === 'Try again'));
    const after = groups(d.dlg());
    t.ok(after.some((g) => g[1] === "French: Tél. principal→(empty) | Dataverse can't remove this translation, and its column's names aren't loaded here: load its table's columns, then undo again."), JSON.stringify(after));
    t.ok(d.text().includes('1 label undone, 1 label skipped.'), d.text());
    t.ok(!d.text().includes("Dataverse can't remove,"), 'not counted as one Dataverse refuses for good');
    let x = readHistory(r.app.ctx).find((y) => y.id === e.id)!;
    t.eq([x.undoneAt, x.kept, r.server.get(`${cell}#${FR}`)], [undefined, undefined, 'Tél. principal'], 'still undoable, nothing kept, nothing written');
    // The column loaded since: Try again puts its French name in place, and the publish is undone.
    r.store.add([column]);
    d.click('Try again');
    await d.until('undone', () => d.title() === 'Publish undone');
    t.eq([r.server.get(`${cell}#${FR}`), r.server.get(`${a}#${FR}`)], ['Téléphone', 'A fr']);
    x = readHistory(r.app.ctx).find((y) => y.id === e.id)!;
    t.eq([!!x.undoneAt, x.kept], [true, undefined]);
  });

  dialog('Undo anyway on a label changed since writes the old text over the text read; one changed again after that read is still a conflict, never overwritten', async (d) => {
    const { r } = d;
    const b = col(r, 'b', 'B fr');
    r.store.set(b, FR, 'B 2');
    await publish(r);
    r.server.set(`${b}#${FR}`, 'B (Marie)');
    openHistory(r.app);
    d.click('Undo');
    await d.until('read', () => !!d.dlg().querySelector('.pd-r input'));
    await tick(10);
    t.eq([d.go()!.textContent, d.go()!.disabled], ['Undo 0 changes', true], 'nothing to undo unless chosen');
    const box = d.dlg().querySelector('.pd-r input')!;
    t.eq(box.getAttribute('aria-label'), 'Undo the French change of B anyway, replacing “B (Marie)”');
    box.checked = true;
    fire(box, 'change');
    t.eq([d.go()!.textContent, d.go()!.disabled], ['Undo 1 change', false]);
    // Someone saves it again after the question read it.
    r.server.set(`${b}#${FR}`, 'B (Paul)');
    await d.ready();
    fire(d.go()!, 'click', { detail: 1 });
    await d.until('done', () => d.title() === 'Undone with problems');
    t.eq(r.server.get(`${b}#${FR}`), 'B (Paul)', "Paul's text kept");
    t.eq(groups(d.dlg()), [['B· Column name (everywhere) · Account', 'French: B (Paul)→B fr | Changed since this publish, so it was left as it is']]);
    d.click('Close');
    // Asked again: chosen with the text as it is now, it is undone.
    openHistory(r.app);
    d.click('Undo');
    await d.until('read', () => !!d.dlg().querySelector('.pd-r input'));
    const box2 = d.dlg().querySelector('.pd-r input')!;
    box2.checked = true;
    fire(box2, 'change');
    await d.asked();
    await d.ready();
    fire(d.go()!, 'click', { detail: 1 });
    await d.until('done', () => d.title() === 'Publish undone');
    t.eq([r.server.get(`${b}#${FR}`), !!readHistory(r.app.ctx).find((x) => x.items[0]?.after === 'B 2')?.undoneAt], ['B fr', true]);
    t.eq(groups(d.dlg()), [['B· Column name (everywhere) · Account', 'French: B (Paul)→B fr | Undone']]);
  });

  dialog("Undo anyway on an English text changed since, while this page still holds the text the publish wrote: the French translation the publish added gets the English text the undo puts back", async (d) => {
    const { r } = d;
    const k = r.add('attribute', 'attribute|acc.n|DisplayName', { [EN]: 'Name' }, { title: 'N', prop: 'DisplayName', path: ['Account', 'Columns'] }).key;
    r.store.set(k, EN, 'Full name');
    r.store.set(k, FR, 'Nom');
    await publish(r);
    r.server.set(`${k}#${EN}`, 'Account name'); // someone renamed it since; not reloaded here
    openHistory(r.app);
    d.click('Undo');
    await d.until('read', () => !!d.dlg().querySelector('.pd-r input'));
    const box = d.dlg().querySelector('.pd-r input')!;
    box.checked = true;
    fire(box, 'change');
    await d.asked();
    await d.ready();
    fire(d.go()!, 'click', { detail: 1 });
    await d.until('done', () => d.title() === 'Publish undone');
    t.eq([r.server.get(`${k}#${EN}`), r.server.get(`${k}#${FR}`)], ['Name', 'Name'], 'never the stale “Full name”, nor the replaced “Account name”');
  });

  dialog("a label whose text couldn't be read: said on its row, counted in Undo, and the undo still checks it before writing", async (d) => {
    const { r } = d;
    const a = col(r, 'a', 'A fr');
    r.store.set(a, FR, 'A 2');
    await publish(r);
    r.unreadable = 'Could not reach Dataverse.';
    openHistory(r.app);
    d.click('Undo');
    await d.asked();
    t.eq(groups(d.dlg()), [['A· Column name (everywhere) · Account', "French: A 2→A fr | Couldn't read its current text (Could not reach Dataverse). The undo checks it again before writing"]]);
    t.eq(d.go()!.textContent, 'Undo 1 change');
    r.unreadable = undefined;
    await d.ready();
    fire(d.go()!, 'click', { detail: 1 });
    await d.until('done', () => d.title() === 'Publish undone');
    t.eq(r.server.get(`${a}#${FR}`), 'A fr');
  });

  dialog('every label already as before: Mark as undone writes nothing and marks the publish undone', async (d) => {
    const { r } = d;
    const a = col(r, 'a', 'A fr');
    r.store.set(a, FR, 'A 2');
    await publish(r);
    r.server.set(`${a}#${FR}`, 'A fr');
    const writes = r.writes.length;
    openHistory(r.app);
    d.click('Undo');
    await d.asked();
    t.eq(d.go()!.textContent, 'Mark as undone');
    await d.ready();
    fire(d.go()!, 'click', { detail: 1 });
    await d.until('done', () => d.title() === 'Publish undone');
    t.eq([r.writes.length, !!readHistory(r.app.ctx)[0].undoneAt], [writes, true]);
    t.eq(groups(d.dlg()), [['A· Column name (everywhere) · Account', 'French: A fr→A fr | Already as before']]);
  });

  // ---- naming an app designer's placeholder ("New Group"): never undone ----

  const G = 'group|sm1|g1|Title';
  /** A journaled label as the saver journals it (saver.ts run, step 3). */
  const jt = (kind: HistoryItem['kind'], key: string, lcid: Lcid, before: string, after: string, title = 'Unnamed group'): HistoryItem => ({ key, comp: key.slice(0, key.lastIndexOf('|')), kind, lcid, title, before, after });
  /** The group named in English and French by one publish. */
  const naming = () => [jt('group', G, EN, '', 'Sales'), jt('group', G, FR, '', 'Ventes')];
  const WHY = "Naming a group can't be undone: Dynamics needs a name once it has one. Rename it here if needed.";

  t.test('namings: the labels that named a sitemap item without a base-language title (its base title, and those it got with it where there was none), from the journal alone; never a rename, a later translation, a description or another kind', () => {
    t.eq([...namings([...naming(), jt('group', G, DE, 'Vertrieb', 'Verkauf')], EN)], [`${G}#${EN}`, `${G}#${FR}`], 'a German title it had already: an ordinary change');
    t.eq([...namings([jt('group', G, FR, '', 'Ventes')], EN)], [], 'a French name added later, the English one there already: removed by Undo, as any translation');
    t.eq([...namings([jt('group', G, EN, 'Sales', 'Revenue')], EN)], [], 'renamed: back to its old name');
    t.eq(namings([jt('area', 'area|sm1|a1|Title', EN, ' ', 'Area 1'), jt('subarea', 'subarea|sm1|s1|Title', EN, '', 'Leads')], EN).size, 2, 'an area and a menu item too (only spaces is no text)');
    t.eq(namings([jt('group', 'group|sm1|g1|Description', EN, '', 'Tip'), jt('attribute', 'attribute|acc.x|DisplayName', EN, '', 'X')], EN).size, 0, 'not a title, not a sitemap item');
    t.eq(namingText(naming()), WHY);
    t.eq(namingText([jt('group', G, EN, '', 'S'), jt('group', 'group|sm1|g2|Title', EN, '', 'T')]), "Naming these groups can't be undone: Dynamics needs a name once they have one. Rename them here if needed.");
    t.eq(namingText([jt('subarea', 'subarea|sm1|s1|Title', EN, '', 'S'), jt('area', 'area|sm1|a1|Title', EN, '', 'T')]), "Naming these items can't be undone: Dynamics needs a name once they have one. Rename them here if needed.");
    t.eq(namingText([jt('subarea', 'subarea|sm1|s1|Title', EN, '', 'S')]).slice(0, 34), "Naming a menu item can't be undone");
    // undoRows: 'named' first, whatever is loaded or read (they are never read).
    const store = new Store();
    const app = { store, ctx: { base: EN }, saver: createSaver({ base: EN, user: EN, langs: [] } as never, store, {} as never, () => undefined) } as unknown as AppApi;
    t.eq(undoRows(app, { id: 'x', at: 0, published: true, items: naming() }, new Map()).map((r) => [r.state, r.now ?? null]), [['named', null], ['named', null]]);
  });

  dialog("a publish that only named a group (the app designer's \"New Group\") offers no Undo, a line says why; one not published still offers Publish; one that changed more keeps its Undo", async (d) => {
    const { r } = d;
    const a = col(r, 'a', 'A fr');
    addHistory(r.app.ctx, { id: 'mix', at: Date.now() - 3000, published: true, items: [...naming(), jt('attribute', a, FR, 'A fr', 'A 2', 'A')] });
    addHistory(r.app.ctx, { id: 'unpub', at: Date.now() - 2000, published: false, items: naming() });
    addHistory(r.app.ctx, { id: 'named', at: Date.now() - 1000, published: true, items: naming() });
    openHistory(r.app);
    const [named, unpub, mix] = d.dlg().querySelectorAll('.pd-he');
    const buttons = (e: FEl) => e.querySelector('.hr')!.children.filter((b) => b.tagName === 'BUTTON').map((b) => b.textContent);
    t.eq([buttons(named), named.querySelector('.pd-nu')?.textContent], [[], WHY]);
    t.eq([buttons(unpub), unpub.querySelector('.pd-nu')?.textContent], [['Publish'], WHY]);
    t.eq([buttons(mix), mix.querySelector('.pd-nu')], [['Undo'], null]);
    // Its details still show what it changed.
    fire(named.querySelector('.pd-ht')!, 'click', { detail: 1 });
    t.eq(groups(named), [['Unnamed group· Menu group', 'English: (empty)→Sales', 'French: (empty)→Ventes']]);
  });

  dialog('a publish that named a group and changed other labels: the Undo question lists the naming as staying (never read, not counted); Undo, Try again and Redo never write it; the publish is undone with it kept', async (d) => {
    const { r } = d;
    const a = col(r, 'a', 'A fr');
    const b = col(r, 'b', 'B fr');
    // The group as Dynamics holds it after that publish (no writer here: a write or a read of it would fail).
    r.add('group', G, { [EN]: 'Sales', [FR]: 'Ventes' }, { prop: 'Title', title: 'Sales', ref: { placeholder: true } });
    r.server.set(`${a}#${FR}`, 'A 2');
    r.server.set(`${b}#${FR}`, 'B 2');
    addHistory(r.app.ctx, { id: 'mix', at: Date.now() - 1000, published: true, items: [...naming(), jt('attribute', a, FR, 'A fr', 'A 2', 'A'), jt('attribute', b, FR, 'B fr', 'B 2', 'B')] });
    r.failOnce.add(`${b}#${FR}`);
    const writes = r.writes.length;
    openHistory(r.app);
    d.click('Undo');
    await d.asked();
    t.eq(groups(d.dlg()), [
      ['Unnamed group· Menu group', "English: Sales→(empty) | Stays: naming a group can't be undone", "French: Ventes→(empty) | Stays: naming a group can't be undone"],
      ['A· Column name (everywhere)', 'French: A 2→A fr'],
      ['B· Column name (everywhere)', 'French: B 2→B fr'],
    ]);
    t.ok(d.text().includes(WHY), d.text());
    await d.ready();
    t.eq(d.go()!.textContent, 'Undo 2 changes', 'the naming is not counted');
    fire(d.go()!, 'click', { detail: 1 });
    await d.until('undone', () => d.title() === 'Undone with problems');
    t.eq(r.writes.slice(writes).map((w) => w.ids), [[[`${a}#${FR}`, 'A fr']]], 'only A (B failed)');
    t.ok(!/Unnamed group|Sales/.test(d.text()), `the naming is not among the labels undone: ${d.text()}`);
    d.click('Try again');
    await d.until('undone', () => d.title() === 'Publish undone');
    t.eq(r.writes.slice(writes).map((w) => w.ids), [[[`${a}#${FR}`, 'A fr']], [[`${b}#${FR}`, 'B fr']]], 'Try again: only B');
    const e = readHistory(r.app.ctx).find((x) => x.id === 'mix')!;
    t.eq([!!e.undoneAt, e.kept], [true, 2], 'undone, the naming kept');
    t.eq([r.server.get(`${G}#${EN}`), r.server.get(`${G}#${FR}`)], ['Sales', 'Ventes']);
    // Redo (the undo's own journal: B): never the naming either.
    d.click('Redo');
    await d.asked();
    await d.ready();
    fire(d.go()!, 'click', { detail: 1 });
    await d.until('redone', () => r.writes.length - writes > 2 && d.title() === 'Publish undone');
    t.eq(r.writes.slice(writes).map((w) => w.ids).slice(2), [[[`${b}#${FR}`, 'B 2']]]);
    t.eq([r.server.get(`${G}#${EN}`), r.server.get(`${G}#${FR}`)], ['Sales', 'Ventes']);
    d.click('Close');
    openHistory(r.app);
    const row = d.dlg().querySelectorAll('.pd-he').find((x) => x.textContent.includes('4 labels'))!;
    const badge = row.querySelector('.badge')!;
    t.eq([badge.textContent, badge.title], ['Undone · 2 kept', WHY], "the names kept, not translations Dataverse can't remove");
  });

  dialog("the Undone · N kept badge says why each was kept: names given to sitemap items (never undone) apart from translations Dataverse can't remove", async (d) => {
    const { r } = d;
    const a = col(r, 'a', '');
    const at = Date.now();
    const DV = "1 label this publish wrote stayed: Dataverse can't take it back. Change it in the editor if needed.";
    // Undone: the naming kept, and a French translation Dataverse refused to remove.
    addHistory(r.app.ctx, { id: 'both', at: at - 3000, published: true, undoneAt: at, kept: 3, items: [...naming(), jt('attribute', a, FR, '', 'A fr', 'A')] });
    // Undone before namings were left out: only the English name was counted (Dataverse's refusal of a blank base title).
    addHistory(r.app.ctx, { id: 'old', at: at - 2000, published: true, undoneAt: at, kept: 1, items: naming() });
    // No naming: as before.
    addHistory(r.app.ctx, { id: 'dv', at: at - 1000, published: true, undoneAt: at, kept: 1, items: [jt('attribute', a, FR, '', 'A fr', 'A')] });
    openHistory(r.app);
    const titles = d.dlg().querySelectorAll('.pd-he').map((e) => [e.querySelector('.badge')!.textContent, e.querySelector('.badge')!.title]);
    t.eq(titles, [
      ['Undone · 1 kept', DV],
      ['Undone · 1 kept', WHY],
      ['Undone · 3 kept', `${DV} ${WHY}`],
    ]);
  });

  dialog('a former placeholder renamed later (its English title had a name before that publish) is an ordinary rename: Undo is offered and puts the earlier name back; so is a non-placeholder title', async (d) => {
    const { r } = d;
    r.add('group', G, { [EN]: 'Revenue', [FR]: 'Ventes' }, { prop: 'Title', title: 'Revenue' });
    const renamed: HistoryEntry = { id: 'renamed', at: Date.now() - 1000, published: true, items: [jt('group', G, EN, 'Sales', 'Revenue', 'Sales')] };
    addHistory(r.app.ctx, { id: 'named', at: Date.now() - 2000, published: true, items: naming() });
    addHistory(r.app.ctx, renamed);
    openHistory(r.app);
    const [later, first] = d.dlg().querySelectorAll('.pd-he');
    const buttons = (e: FEl) => e.querySelector('.hr')!.children.filter((b) => b.tagName === 'BUTTON').map((b) => b.textContent);
    t.eq([buttons(later), later.querySelector('.pd-nu')], [['Undo'], null], 'the rename: Undo');
    t.eq([buttons(first), first.querySelector('.pd-nu')?.textContent], [[], WHY], 'the naming before it: none');
    t.eq(undoRows(r.app, renamed, new Map([[`${G}#${EN}`, 'Revenue']])).map((x) => x.state), ['undo'], 'back to “Sales”');
    t.eq(namings([jt('area', 'area|sm1|a1|Title', EN, 'Area', 'Zone')], EN).size, 0, 'an area renamed');
  });

  // ---- reading the server text: the saver and the writers ----

  t.test("saver.current: each save group read once by its writer's read(), writing nothing; a writer without read() or a read that fails says so per label; Stop rejects", async () => {
    const store = new Store();
    const calls: string[][] = [];
    let fail = '';
    const reader: Writer = {
      kinds: ['attribute'],
      lane: 'metadata',
      async read(_ctx, cs) {
        calls.push(cs.map((c) => `${c.slot.key}#${c.lcid}`));
        if (fail && cs[0].slot.group === fail) throw new Error('Could not reach Dataverse.');
        return new Map(cs.map((c) => [`${c.slot.key}#${c.lcid}`, `${c.slot.key} now`] as const));
      },
      save: async (): Promise<ChangeResult[]> => {
        throw new Error('nothing is written');
      },
    };
    const noRead: Writer = { kinds: ['view'], lane: 'records', save: reader.save };
    const saver = createSaver({ base: EN, user: EN } as never, store, {} as never, (k) => (k === 'attribute' ? reader : k === 'view' ? noRead : undefined));
    const s = (kind: string, key: string, group: string) => ({ ...t.slot(kind, key), group }) as Slot;
    const ch = (slot: Slot, lcid: Lcid): Change => ({ slot, lcid, before: '', after: '' });
    const a = s('attribute', 'attribute|acc.a|DisplayName', 'attribute|acc.a');
    const b = s('attribute', 'attribute|acc.b|DisplayName', 'attribute|acc.b');
    const v = s('view', 'view|v1|Name', 'view|v1');
    const got = await saver.current([ch(a, FR), ch(b, FR), ch(a, DE), ch(v, FR)]);
    t.eq(calls, [[`${a.key}#${FR}`, `${a.key}#${DE}`], [`${b.key}#${FR}`]], 'one read per save group');
    t.eq([...got].map(([id, x]) => [id, typeof x === 'string' ? x : `Error: ${x.message}`]), [
      [`${v.key}#${FR}`, "Error: This kind of label can't be read here."],
      [`${a.key}#${FR}`, `${a.key} now`],
      [`${a.key}#${DE}`, `${a.key} now`],
      [`${b.key}#${FR}`, `${b.key} now`],
    ]);
    fail = b.group;
    const got2 = await saver.current([ch(a, FR), ch(b, FR)]);
    t.eq([got2.get(`${a.key}#${FR}`), (got2.get(`${b.key}#${FR}`) as Error).message], [`${a.key} now`, 'Could not reach Dataverse.']);
    const ac = new AbortController();
    reader.read = (_ctx, _cs, o) => new Promise((_ok, no) => o.signal.addEventListener('abort', () => no(new DOMException('Aborted', 'AbortError'))));
    const stopped = saver.current([ch(a, FR)], ac.signal);
    ac.abort();
    let rejected = false;
    await stopped.catch(() => (rejected = true));
    t.ok(rejected, 'Stop rejects');
  });

  t.test("metadata writers' read(): the strong read their save makes before writing (same URL), the language's text ('' for none), nothing else sent", async () => {
    const lab = (l: Record<number, string>) => ({ LocalizedLabels: Object.entries(l).map(([k, v]) => ({ Label: v, LanguageCode: Number(k) })) });
    const sent: string[][] = [];
    const http = {
      get: async (url: string, o: { headers?: Record<string, string> }) => {
        sent.push([url, o.headers?.Consistency ?? '']);
        return url.includes('PicklistAttributeMetadata')
          ? { OptionSet: { Options: [{ Value: 1, Label: lab({ [EN]: 'Small', [FR]: 'Petit' }), Description: lab({}) }] } }
          : { DisplayName: lab({ [EN]: 'Name', [FR]: 'Nom' }), Description: lab({ [EN]: 'The name', [FR]: '' }) };
      },
    };
    const ctx = { http, base: EN, user: EN } as never;
    const o = { signal: new AbortController().signal, lang: null as never };
    const w = (k: string) => metadataWriters.find((x) => x.kinds.includes(k as never))!;
    const attr = (prop: string) => ({ ...t.slot('attribute', `attribute|acc.name|${prop}`), prop, ref: { entity: 'acc', attribute: 'name' } }) as Slot;
    const dn = attr('DisplayName');
    const desc = attr('Description');
    const got = await w('attribute').read!(ctx, [{ slot: dn, lcid: FR, before: '', after: '' }, { slot: dn, lcid: DE, before: '', after: '' }, { slot: desc, lcid: FR, before: '', after: '' }], o);
    t.eq([...got], [[`${dn.key}#${FR}`, 'Nom'], [`${dn.key}#${DE}`, ''], [`${desc.key}#${FR}`, '']]);
    const opt = { ...t.slot('option', 'option|acc.size|1|Label'), ref: { entity: 'acc', attribute: 'size', value: 1 } } as Slot;
    const got2 = await w('option').read!(ctx, [{ slot: opt, lcid: FR, before: '', after: '' }], o);
    t.eq([...got2], [[`${opt.key}#${FR}`, 'Petit']]);
    t.eq(sent, [
      ["EntityDefinitions(LogicalName='acc')/Attributes(LogicalName='name')?$select=LogicalName,DisplayName,Description,IsRenameable,IsCustomizable,IsManaged,AttributeType,AttributeTypeName", 'Strong'],
      ["EntityDefinitions(LogicalName='acc')/Attributes(LogicalName='size')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName,IsCustomizable,IsManaged&$expand=OptionSet", 'Strong'],
    ]);
    // An option deleted since: said as its save says it, never read as a text someone removed.
    const gone = { ...opt, key: 'option|acc.size|9|Label', ref: { ...opt.ref, value: 9 } } as Slot;
    const got3 = (await w('option').read!(ctx, [{ slot: gone, lcid: FR, before: '', after: '' }], o)).get(`${gone.key}#${FR}`);
    t.eq(got3 instanceof Error ? got3.message : got3, 'This choice option no longer exists. Reload to see the current options.');
  });

  t.test("metadata writers' read() right after this page's own save of a label: a read still behind that save (a metadata cache catching up, LIVE-FINDINGS 66) is read again for a while, as the save does before writing, never shown as the text from before it (the Undo question would call it already as before, then the undo writes it); still behind, it says so", () =>
    fast(async () => {
      const g = globalThis as { localStorage?: unknown };
      const had = Object.getOwnPropertyDescriptor(g, 'localStorage');
      const mem = new Map<string, string>();
      Object.defineProperty(g, 'localStorage', { configurable: true, value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) } });
      try {
        const lab = (l: Record<number, string>) => ({ LocalizedLabels: Object.entries(l).map(([k, v]) => ({ Label: v, LanguageCode: Number(k) })) });
        const srv: Record<number, string> = { [EN]: 'Name', [FR]: 'Nom' };
        /** `n` reads still answer with `old` (the text from before the last write). */
        const lag = { old: null as Record<number, string> | null, n: 0 };
        let reads = 0;
        const view = (dn: Record<number, string>) => ({ '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata', LogicalName: 'name', DisplayName: lab(dn), Description: lab({}), IsCustomizable: { Value: true }, IsRenameable: { Value: true } });
        const http = {
          get: async () => (reads++, view(lag.old && lag.n-- > 0 ? lag.old : srv)),
          batch: (parts: never, o: never) => batchOf(http, () => view(srv))(parts, o),
          put: async (_u: string, body: { DisplayName: { LocalizedLabels: Array<{ Label: string; LanguageCode: number }> } }) => {
            for (const l of body.DisplayName.LocalizedLabels) srv[l.LanguageCode] = l.Label;
          },
        };
        const ctx = { http, base: EN, user: EN, orgId: 'lagging', langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] } as never;
        const slot = { ...t.slot('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Name', [FR]: 'Nom' }), prop: 'DisplayName', entity: 'acc', group: 'attribute|acc.name', ref: { entity: 'acc', attribute: 'name' } } as Slot;
        const w = metadataWriters.find((x) => x.kinds.includes('attribute'))!;
        const so = () => ({ signal: new AbortController().signal, publish: new PublishSet(), progress() {}, force: new Set<string>(), lang: null as never, allowPublish: true });
        const ro = { signal: new AbortController().signal, lang: null as never };
        // The publish, then its undo asked at once: the next reads still answer with the text from before the publish.
        t.eq((await w.save(ctx, [{ slot, lcid: FR, before: 'Nom', after: 'Nom du compte' }], so())).map((r) => r.outcome), ['saved']);
        const back: Change = { slot, lcid: FR, before: 'Nom du compte', after: 'Nom' };
        Object.assign(lag, { old: { [EN]: 'Name', [FR]: 'Nom' }, n: 2 });
        const n0 = reads;
        t.eq([...(await w.read!(ctx, [back], ro))], [[`${slot.key}#${FR}`, 'Nom du compte']], 'read again until it shows the publish');
        t.eq(reads - n0, 3);
        // Behind for longer than the save waits: said, never taken for the text there (the undo checks it again).
        Object.assign(lag, { n: 99 });
        const late = (await w.read!(ctx, [back], ro)).get(`${slot.key}#${FR}`);
        t.ok(late instanceof Error && /doesn't show your last change/.test(late.message), String(late));
        // Once the reads catch up the undo writes it, as the question now says.
        Object.assign(lag, { n: 0 });
        t.eq((await w.save(ctx, [back], so())).map((r) => r.outcome), ['saved']);
        t.eq(srv[FR], 'Nom');
      } finally {
        if (had) Object.defineProperty(g, 'localStorage', had);
        else delete g.localStorage;
      }
    }),
  );

  t.test('undoRows: a read-only label is refused whatever the server holds; one the read did not return is unread; the rows follow the undo\'s own checks (base text, only spaces)', () => {
    const store = new Store();
    const s = (key: string, o: Partial<Slot> = {}) => ({ ...t.slot('view', key, { [EN]: 'V', [FR]: 'V fr' }), ...o }) as Slot;
    store.add([s('view|v1|Name', { readOnly: 'Managed and not customizable' }), s('view|v2|Name'), s('view|v3|Name')]);
    const app = { store, ctx: { base: EN }, saver: createSaver({ base: EN, user: EN, langs: [] } as never, store, {} as never, () => undefined) } as unknown as AppApi;
    const it = (key: string, before: string, after: string, lcid = FR): HistoryItem => ({ key, comp: key, kind: 'view', lcid, title: key, before, after });
    const e: HistoryEntry = { id: 'x', at: 0, published: true, items: [it('view|v1|Name', 'V fr', 'V 2'), it('view|v2|Name', 'V fr', 'V 2'), it('view|v3|Name', 'V0', 'V', EN), it('view|v2|Name', 'Old', '  ', DE)] };
    const rows = undoRows(app, e, new Map<string, string | Error>([['view|v1|Name#1036', 'V fr'], ['view|v3|Name#1033', 'V'], ['view|v2|Name#1031', '']]));
    t.eq(rows.map((r) => [r.state, r.why ?? '']), [
      ['refused', 'Read-only: Managed and not customizable'],
      ['unread', 'It was not read'],
      ['undo', ''],
      // Only spaces counts as no text, as the writers compare: the publish left none there, so this one is undone.
      ['undo', ''],
    ]);
  });

  t.test("Recent publishes › Undo of a publish that changed a label of a managed solution's component (made before such labels were read-only): it is refused with the managed reason and skipped, never written; the other labels are undone; the publish stays undoable", async () => {
    const r = rig(t);
    try {
      const m = r.add('attribute', 'attribute|acc.m|DisplayName', { [EN]: 'Name', [FR]: 'Nom 2' }, { ref: { managed: true } });
      const u = r.add('attribute', 'attribute|acc.u|DisplayName', { [EN]: 'Code', [FR]: 'Code 2' }, { ref: { managed: false } });
      const it = (s: Slot, before: string, after: string): HistoryItem => ({ key: s.key, comp: s.comp, kind: s.kind, lcid: FR, title: s.title, before, after });
      const e: HistoryEntry = { id: 'managed-undo', at: Date.now(), published: true, items: [it(m, 'Nom', 'Nom 2'), it(u, 'Code', 'Code 2')] };
      addHistory(r.app.ctx, e);
      // The preview: refused whatever the server holds, the reason said.
      const rows = undoRows(r.app, e, await r.app.saver.current(e.items.map((x) => ({ slot: r.store.get(x.key)!, lcid: x.lcid, before: x.after, after: x.before }))));
      t.eq(rows.map((x) => [x.state, x.why ?? '']), [['refused', `Read-only: ${MANAGED}`], ['undo', '']]);
      const rep = await r.app.saver.undo(e, { signal: new AbortController().signal, publish: true, onProgress() {} });
      t.eq(rep.results.map((x) => [x.change.slot.key, x.outcome, x.message]), [[m.key, 'skipped', `Read-only: ${MANAGED}`], [u.key, 'saved', undefined]]);
      t.eq(r.writes.map((w) => w.ids), [[[`${u.key}#${FR}`, 'Code']]], 'only the other label written');
      t.eq([r.server.get(`${m.key}#${FR}`), r.server.get(`${u.key}#${FR}`)], ['Nom 2', 'Code']);
      t.eq(readHistory(r.app.ctx).find((x) => x.id === e.id)?.undoneAt, undefined, 'still undoable: not every label is back');
    } finally {
      r.done();
    }
  });

  // ---- a French tooltip saved empty (core/model.ts savesEmpty) ----

  const tipOf = (r: Rig, x: string, labels: Record<number, string>) =>
    r.add('attribute', `attribute|acc.${x}|Description`, labels, { title: x.toUpperCase(), prop: 'Description', baseRequired: false, path: ['Account', 'Columns'] }).key;
  const SAID = 'Saved empty: French users see no tooltip.';

  dialog("a French tooltip emptied: the Publish dialog shows “old → (empty)” with a quiet note in the popup's words (no stand-in, nothing skipped); Recent publishes keeps after '' and says the same", async (d) => {
    const { r } = d;
    const tip = tipOf(r, 't', { [EN]: 'Tip', [FR]: 'Astuce' });
    r.store.set(tip, FR, '');
    void openReview(r.app);
    const rows = [['T· Tooltip (everywhere) · Account', `French: Astuce→(empty) | ${SAID}`]];
    t.eq(groups(d.dlg()), rows);
    t.eq(d.dlg().querySelector('.pd-r .iss')!.className, 'iss note', 'quiet');
    await tick();
    d.click('Publish');
    await d.until('published', () => d.title() === 'Published');
    d.click('Close');
    const [e] = readHistory(r.app.ctx);
    t.eq(e.items.map((it) => [it.before, it.after, it.empty ?? null]), [['Astuce', '', null]]);
    t.eq([r.store.get(tip)!.labels, r.store.emptyOnPurpose(tip, FR, EN)], [{ [EN]: 'Tip', [FR]: '' }, true]);
    openHistory(r.app);
    const [open] = d.dlg().querySelectorAll('.pd-ht');
    fire(open, 'click', { detail: 1 });
    t.eq(groups(d.dlg().querySelector(`[id="${open.getAttribute('aria-controls')}"]`)!), rows, 'the same rows as before publishing');
  });

  dialog("Undo of a publish that gave a French tooltip its text where it was stored empty: the question says it is saved empty again, the undo writes '' (never the English text), and its result says so", async (d) => {
    const { r } = d;
    const tip = tipOf(r, 'c', { [EN]: 'The city.', [FR]: '' });
    r.store.set(tip, FR, 'La ville.');
    await publish(r);
    t.eq(readHistory(r.app.ctx)[0].items.map((it) => [it.before, it.after, it.empty ?? null]), [['', 'La ville.', true]]);
    openHistory(r.app);
    d.click('Undo');
    await d.asked();
    t.eq(groups(d.dlg()), [['C· Tooltip (everywhere) · Account', `French: La ville.→(empty) | ${SAID}`]]);
    await d.ready();
    t.eq(d.go()!.textContent, 'Undo 1 change');
    const writes = r.writes.length;
    fire(d.go()!, 'click', { detail: 1 });
    await d.until('undone', () => d.title() === 'Publish undone');
    t.eq(r.writes.slice(writes).map((w) => w.ids), [[[`${tip}#${FR}`, '']]], "'' written, not the English text");
    t.eq(groups(d.dlg()), [['C· Tooltip (everywhere) · Account', `French: La ville.→(empty) | Undone | ${SAID}`]]);
    t.eq(r.store.emptyOnPurpose(tip, FR, EN), true, 'stored empty again');
  });

  dialog("only spaces typed where a French tooltip has none: the Publish dialog's row says what French users see until then (“Shows “Tip”” → (empty); with no English text either, “(no translation)”), never “(empty) → (empty)”; Recent publishes, “(no translation) → (empty)”; both with the quiet note", async (d) => {
    const { r } = d;
    const tip = tipOf(r, 'n', { [EN]: 'Tip' });
    const bare = tipOf(r, 'z', {});
    r.store.set(tip, FR, '  ');
    r.store.set(bare, FR, ' ');
    void openReview(r.app);
    t.eq(groups(d.dlg()), [
      ['N· Tooltip (everywhere) · Account', `French: Shows “Tip”→(empty) | ${SAID}`],
      ['Z· Tooltip (everywhere) · Account', `French: (no translation)→(empty) | ${SAID}`],
    ]);
    await tick();
    d.click('Publish');
    await d.until('published', () => d.title() === 'Published');
    d.click('Close');
    t.eq(readHistory(r.app.ctx)[0].items.map((it) => [it.before, it.after, it.empty ?? null]), [['', '', null], ['', '', null]]);
    openHistory(r.app);
    const [open] = d.dlg().querySelectorAll('.pd-ht');
    fire(open, 'click', { detail: 1 });
    t.eq(groups(d.dlg().querySelector(`[id="${open.getAttribute('aria-controls')}"]`)!), [
      ['N· Tooltip (everywhere) · Account', `French: (no translation)→(empty) | ${SAID}`],
      ['Z· Tooltip (everywhere) · Account', `French: (no translation)→(empty) | ${SAID}`],
    ]);
  });

  dialog("an emptied French tooltip whose write fails: the rows after the run keep the quiet note beside the error (Try again saves it empty), and Try again sends '' again", async (d) => {
    const { r } = d;
    const tip = tipOf(r, 'f', { [EN]: 'Tip', [FR]: 'Astuce' });
    r.store.set(tip, FR, '');
    r.failOnce.add(`${tip}#${FR}`);
    void openReview(r.app);
    await tick();
    d.click('Publish');
    await d.until('the problems', () => d.title() === "Some changes weren't published");
    t.eq(groups(d.dlg()), [['F· Tooltip (everywhere) · Account', `French: Astuce→(empty) | Could not reach Dataverse. | ${SAID}`]]);
    const writes = r.writes.length;
    d.click('Try again');
    await d.until('published', () => d.title() === 'Published');
    t.eq(r.writes.slice(writes).map((w) => w.ids), [[[`${tip}#${FR}`, '']]], "'' sent again");
    t.eq([r.server.get(`${tip}#${FR}`), r.store.emptyOnPurpose(tip, FR, EN)], ['', true]);
  });

  dialog("Undo of a publish that gave a French tooltip its first text where its English text is empty: saved empty (its users saw no text before it), never “stays”; measured by the texts the undo leaves, never a pending English text it doesn't write", async (d) => {
    const { r } = d;
    const tip = tipOf(r, 't', {});
    r.store.set(tip, FR, 'T 2');
    await publish(r);
    const [e] = readHistory(r.app.ctx);
    r.store.set(tip, EN, 'Tip'); // staged since, not published
    openHistory(r.app);
    d.click('Undo');
    await d.asked();
    t.eq(groups(d.dlg()), [['T· Tooltip (everywhere) · Account', `French: T 2→(empty) | ${SAID}`]]);
    await d.ready();
    t.eq(d.go()!.textContent, 'Undo 1 change');
    const writes = r.writes.length;
    fire(d.go()!, 'click', { detail: 1 });
    await d.until('undone', () => d.title() === 'Publish undone');
    t.eq(r.writes.slice(writes).map((w) => w.ids), [[[`${tip}#${FR}`, '']]], "'' written, never “Tip”");
    t.eq(groups(d.dlg()), [['T· Tooltip (everywhere) · Account', `French: T 2→(empty) | Undone | ${SAID}`]]);
    t.eq([r.server.get(`${tip}#${FR}`), r.store.value(tip, EN), readHistory(r.app.ctx).find((y) => y.id === e.id)!.undoneAt !== undefined], ['', 'Tip', true]);
  });
}
