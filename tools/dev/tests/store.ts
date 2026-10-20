// Unit tests for store: the base of a staged edit (the server text it was made on) survives slot refreshes, so a
// reload that brings another maker's text under a pending edit is a conflict at save, never a silent overwrite; and a
// label from a managed solution is never staged. A load's answer older than a text the store got since never puts that
// text back (load ticks).
import { MANAGED } from '../../../src/core/model';
import { Store } from '../../../src/core/store';
import { PageLoader, WANT_TABLE } from '../../../src/inspector/pageload';
import { check } from '../../../src/providers/types';
import type { Kit } from './kit';

const FR = 1036;

export function register({ test, eq, ok, slot }: Kit): void {
  /** A store with one attribute slot 'a' (1036 'Nom'), and a reload of it bringing `fr` as the server's French text. */
  const rig = () => {
    const s = new Store();
    s.add([slot('attribute', 'a')]);
    const reload = (fr: string) => s.add([slot('attribute', 'a', { 1033: 'Name', 1036: fr })]);
    const pairs = () => s.changes().map((c) => [c.before, c.after]);
    return { s, reload, pairs };
  };

  test('store base: kept across a refresh that brings other server text', () => {
    const { s, reload, pairs } = rig();
    s.set('a', FR, 'Mon nom');
    reload('Nom complet');
    eq(s.value('a', FR), 'Mon nom', 'the pending edit was lost');
    eq(s.original('a', FR), 'Nom complet', 'server value');
    eq(s.before('a', FR), 'Nom', 'base');
    ok(s.moved('a', FR), 'moved() should flag the edit');
    eq(pairs(), [['Nom', 'Mon nom']], 'Change.before must be the base, not the refreshed server text');
    eq(s.pendingCount(), 1);
  });

  test('store base: an unchanged refresh keeps the edit and its base, moved() stays false', () => {
    const { s, reload, pairs } = rig();
    s.set('a', FR, 'x');
    reload('Nom');
    eq(pairs(), [['Nom', 'x']]);
    eq(s.moved('a', FR), false);
    eq(s.before('a', 1033), 'Name', 'a cell without an edit is measured against the server value');
  });

  test('store base: a second edit of the same cell keeps the first base', () => {
    const { s, reload, pairs } = rig();
    s.set('a', FR, 'a');
    reload('Theirs');
    s.set('a', FR, 'b');
    s.set('a', FR, 'bc');
    eq(pairs(), [['Nom', 'bc']]);
  });

  test('store base: typing back to the base (server unchanged) or Revert clears it', () => {
    const { s, reload, pairs } = rig();
    s.set('a', FR, 'x');
    s.set('a', FR, 'Nom');
    eq(s.pendingCount(), 0, 'typed back to the base');
    reload('Nom 2');
    s.set('a', FR, 'y');
    eq(pairs(), [['Nom 2', 'y']], 'a new edit after the revert starts from the server text now');
    s.revert('a', FR);
    eq(s.pendingCount(), 0, 'revert');
    reload('Nom 3');
    s.set('a', FR, 'z');
    eq(pairs(), [['Nom 3', 'z']], 'Revert cleared the old base');
  });

  test('store base: typing through the base while the server moved keeps the edit and its base', () => {
    const { s, reload, pairs } = rig();
    s.set('a', FR, 'Nom2');
    reload('Nom complet');
    s.set('a', FR, 'Nom'); // backspace over the typo
    eq(pairs(), [['Nom', 'Nom']], 'still pending: the server holds other text');
    s.set('a', FR, 'Nom3');
    eq(pairs(), [['Nom', 'Nom3']]);
    eq(check(s.changes()[0], 'Nom complet', new Set())?.outcome, 'conflict');
    s.set('a', FR, 'Nom complet'); // typed exactly what is on the server: nothing to write
    eq(s.pendingCount(), 0);
  });

  test('store base: a refresh that equals the edit drops it and its base', () => {
    const { s, reload, pairs } = rig();
    s.set('a', FR, 'Nouveau');
    reload('Nouveau');
    eq(s.pendingCount(), 0);
    reload('Plus récent');
    s.set('a', FR, 'Mien');
    eq(pairs(), [['Plus récent', 'Mien']]);
  });

  test('store base: commit clears it; text typed during the save is measured against the text saved', () => {
    const { s, reload, pairs } = rig();
    s.set('a', FR, 'x');
    reload('Theirs'); // e.g. the Workbench reloaded, but the save's fresh read still found 'Nom'
    const [c] = s.changes();
    eq(c.before, 'Nom');
    s.commit([{ change: c, outcome: 'saved' }]);
    eq(s.isEdited('a', FR), false);
    eq(s.original('a', FR), 'x');
    reload('Later');
    s.set('a', FR, 'y');
    eq(pairs(), [['Later', 'y']], 'commit left the old base behind');

    const t = rig();
    t.s.set('a', FR, 'x');
    const [d] = t.s.changes();
    t.s.set('a', FR, 'xy'); // typed while the save of 'x' was running
    t.s.commit([{ change: d, outcome: 'saved' }]);
    eq(t.pairs(), [['x', 'xy']]);
    t.reload('Theirs');
    eq(t.pairs(), [['x', 'xy']], 'the rebase on the saved text survives a reload');
  });

  test('store base: a refresh with other text yields a conflict at save, then Use theirs drops the edit', () => {
    const { s, reload, pairs } = rig();
    s.set('a', FR, 'Mien');
    reload('Theirs');
    const [c] = s.changes();
    ok(c.before !== 'Theirs', 'before must differ from the fresh server value');
    // The writer's fresh-read compare (providers/types check) against what the server holds now.
    const r = check(c, 'Theirs', new Set());
    eq(r?.outcome, 'conflict', 'the writer would overwrite their text');
    eq(r?.server, 'Theirs');
    s.commit([r!]);
    eq(s.isEdited('a', FR), true, 'a conflict keeps the edit');
    eq(pairs(), [['Nom', 'Mien']], 'a conflict keeps the base');
    eq(check(s.changes()[0], 'Theirs', new Set())?.outcome, 'conflict', 'Try again before resolving is still a conflict');
    s.resolve('a', FR, false);
    eq(s.value('a', FR), 'Theirs');
    eq(s.pendingCount(), 0);
    eq(s.moved('a', FR), false);
    s.set('a', FR, 'Encore');
    eq(pairs(), [['Theirs', 'Encore']], 'Use theirs cleared the base');
  });

  test('store base: Keep mine rebases on their text, so the next save writes; a newer text conflicts again', () => {
    const { s, reload, pairs } = rig();
    s.set('a', FR, 'Mien');
    reload('Theirs');
    s.commit([check(s.changes()[0], 'Theirs', new Set())!]);
    s.resolve('a', FR, true);
    eq(s.value('a', FR), 'Mien');
    eq(pairs(), [['Theirs', 'Mien']]);
    eq(s.moved('a', FR), false);
    eq(check(s.changes()[0], 'Theirs', new Set()), null, 'Try again must write after Keep mine');
    eq(check(s.changes()[0], 'Newest', new Set())?.outcome, 'conflict', 'a third maker after Keep mine');
    reload('Newest');
    eq(pairs(), [['Theirs', 'Mien']], 'Keep mine does not accept later texts');
  });

  test('store base: Keep mine when their text equals mine drops the edit', () => {
    const { s, reload } = rig();
    s.set('a', FR, 'Mien');
    reload('Theirs');
    s.commit([{ change: s.changes()[0], outcome: 'conflict', server: 'Mien' }]);
    s.resolve('a', FR, true);
    eq(s.pendingCount(), 0);
    eq(s.value('a', FR), 'Mien');
  });

  test('store base: undo and redo bring an edit back with its own base', () => {
    const { s, reload, pairs } = rig();
    s.group(() => s.set('a', FR, 'x')); // its own undo step
    s.group(() => s.set('a', FR, 'xy'));
    reload('Theirs');
    s.undo();
    eq(pairs(), [['Nom', 'x']], 'undo of the second edit');
    s.undo();
    eq(s.pendingCount(), 0, 'undo of the first edit');
    s.redo();
    eq(pairs(), [['Nom', 'x']], 'redo after a reload must not take the reloaded text as its base');
    s.redo();
    eq(pairs(), [['Nom', 'xy']]);
    // Undo of a Revert.
    s.revert('a', FR);
    eq(s.pendingCount(), 0);
    s.undo();
    eq(pairs(), [['Nom', 'xy']], 'undo of a revert');
    ok(s.moved('a', FR));
  });

  test('store base: undo brings back an edit a reload dropped (same text on the server), with its base', () => {
    const { s, reload, pairs } = rig();
    s.group(() => s.set('a', FR, 'x'));
    s.group(() => s.set('a', FR, 'y'));
    reload('y'); // someone saved the same text: the edit is dropped
    eq(s.pendingCount(), 0);
    s.undo();
    eq(pairs(), [['Nom', 'x']]);
  });

  test('store base: consecutive typing is one undo step and keeps the first base', () => {
    const { s, reload, pairs } = rig();
    s.set('a', FR, 'N');
    s.set('a', FR, 'No');
    reload('Theirs');
    s.set('a', FR, 'Non');
    eq(pairs(), [['Nom', 'Non']]);
    s.undo();
    eq(s.pendingCount(), 0, 'typing collapsed into one step');
    s.redo();
    eq(pairs(), [['Nom', 'Non']]);
  });

  test('store: typing that cancels itself (back to where it began) leaves no step', () => {
    const { s } = rig();
    let events = 0;
    s.on(() => events++);
    s.set('a', FR, 'Nom ');
    s.set('a', FR, 'Nom 2');
    s.set('a', FR, 'Nom');
    eq([s.canUndo(), s.isEdited('a', FR), events], [false, false, 3], 'nothing to undo; every change told');
    // Over an earlier edit: that edit's step is the one undone next.
    s.set('a', FR, 'a');
    const st = (s as unknown as { undoStack: Array<{ t?: number }> }).undoStack;
    st[st.length - 1].t = 0; // made a while ago: the next keystroke is a new step
    s.set('a', FR, 'ab');
    s.set('a', FR, 'a');
    eq([st.length, s.value('a', FR), s.canRedo()], [1, 'a', false]);
    s.undo();
    eq([s.isEdited('a', FR), s.canUndo()], [false, false], 'the earlier step');
    s.redo();
    eq(s.value('a', FR), 'a');
  });

  test('store base: an explicit base for a new edit (a restored snapshot) is kept, an existing edit keeps its own', () => {
    const { s, reload, pairs } = rig();
    reload('Theirs');
    s.set('a', FR, 'Mien', 'Nom');
    eq(pairs(), [['Nom', 'Mien']]);
    s.set('a', FR, 'Mien 2', 'Other');
    eq(pairs(), [['Nom', 'Mien 2']], 'the first base wins');
    s.set('a', 1033, 'Name 2');
    eq(s.changes().find((c) => c.lcid === 1033)?.before, 'Name', 'default base: the server value now');
  });

  test('store base: group of several cells, Revert all, pendingCount', () => {
    const s = new Store();
    s.add([slot('attribute', 'a'), slot('attribute', 'b')]);
    s.group(() => {
      s.set('a', FR, 'x');
      s.set('b', FR, 'y');
      s.set('b', 1033, 'Y');
    });
    eq(s.pendingCount(), 3);
    s.add([slot('attribute', 'b', { 1033: 'Theirs EN', 1036: 'Theirs FR' })]);
    const all = () => s.changes().map((c) => `${c.slot.key}#${c.lcid} ${c.before}`).sort();
    eq(all(), ['a#1036 Nom', 'b#1033 Name', 'b#1036 Nom']);
    s.revert('b');
    eq(s.pendingCount(), 1);
    s.undo();
    eq(all(), ['a#1036 Nom', 'b#1033 Name', 'b#1036 Nom'], 'undo of Revert all brings the bases back');
  });

  test('store: a label from a managed solution is read-only with the managed reason whatever its loader said, and nothing stages on it (typing, imports, fills); a reason of its own is kept; one of this environment stages as before', () => {
    const s = new Store();
    const m = { ...slot('attribute', 'm'), ref: { managed: true } };
    const own = { ...slot('attribute', 'b'), readOnly: "Microsoft locks renaming of this column: its name can't be changed, in any language.", ref: { managed: true } };
    const u = { ...slot('attribute', 'u'), ref: { managed: false } };
    s.add([m, own, u]);
    eq([s.get('m')!.readOnly, s.get('b')!.readOnly, s.get('u')!.readOnly], [MANAGED, own.readOnly, '']);
    s.group(() => {
      for (const k of ['m', 'b', 'u']) s.set(k, FR, 'Autre');
    });
    eq([s.isEdited('m'), s.isEdited('b'), s.isEdited('u')], [false, false, true]);
    // A slot changed in place after it was added (never by the loaders): still never staged.
    s.get('m')!.readOnly = '';
    s.set('m', FR, 'Autre');
    eq(s.isEdited('m'), false);
  });

  test("store: text() reads a label as a stand-in does (pending edits, or the server's text; undefined while not loaded); standIn() says what a staged emptied translation Dataverse can't remove is saved as", () => {
    const s = new Store();
    const tab = { ...slot('tab', 't', { 1033: 'General' }), ref: { partial: [1033] } };
    s.add([slot('attribute', 'a'), tab, { ...slot('view', 'v'), labels: { 1033: 'Active', 1036: 'Actifs' } }]);
    s.set('a', 1033, 'Full name');
    eq([s.text('a', 1033), s.text('a', 1033, true), s.text('t', 1033), s.text('t', FR), s.text('none', FR)], ['Full name', 'Name', 'General', undefined, undefined]);
    eq(s.standIn('a', FR, 1033), undefined, 'not edited');
    s.set('a', FR, ' ');
    eq(s.standIn('a', FR, 1033), { text: 'Full name', from: 'base' }, 'the English text as staged');
    s.set('v', FR, '');
    eq([s.standIn('v', FR, 1033), s.standIn('a', 1033, 1033)], [undefined, undefined], 'a removable translation, the base language');
  });

  test('store commit: a stand-in saved in place of an emptied translation drops the blank edit it stood in for and becomes the server text; one that failed keeps the edit and its message; text typed meanwhile stays pending', () => {
    const s = new Store();
    s.add([slot('attribute', 'a'), slot('attribute', 'b'), slot('attribute', 'c')]);
    for (const k of ['a', 'b', 'c']) s.set(k, FR, '');
    s.set('c', FR, 'Nom 3'); // typed while the save ran
    const stood = (k: string) => ({ slot: s.get(k)!, lcid: FR, before: 'Nom', after: 'Name', standIn: { from: 'base' as const, typed: '' } });
    s.commit([
      { change: stood('a'), outcome: 'saved' },
      { change: stood('b'), outcome: 'error', message: 'Could not reach Dataverse.' },
      { change: stood('c'), outcome: 'saved' },
    ]);
    eq([s.isEdited('a', FR), s.original('a', FR), s.cellStatus('a', FR)?.outcome], [false, 'Name', 'saved']);
    eq([s.value('b', FR), s.cellStatus('b', FR)?.message], ['', 'Could not reach Dataverse.']);
    eq([s.value('c', FR), s.before('c', FR), s.original('c', FR)], ['Nom 3', 'Name', 'Name']);
  });

  test("store freshness: what a load read that started before the store got a newer text (`since`, tick()) never puts its text back, nor drops an edit typed over the newer text because it matches the older; a read made later does; a save, a text read again and a conflict resolved are newer too", () => {
    const s = new Store();
    const col = (en: string, fr: string) => slot('attribute', 'a', { 1033: en, 1036: fr });
    const page = s.tick(); // a page load starts reading
    s.add([col('Name', 'Theirs')]); // the Workbench's extract, read since: someone else saved "Theirs"
    s.set('a', FR, 'Mine'); // typed over it
    s.add([col('Name', 'Mine')], page); // the page's answer, read before that
    eq([s.pendingCount(), s.value('a', FR), s.original('a', FR), s.before('a', FR), s.moved('a', FR)], [1, 'Mine', 'Theirs', 'Theirs', false], 'the edit kept, measured against the newer text');
    eq(s.changes().map((c) => check(c, 'Theirs', new Set())), [null], 'saved over the newer text, never a conflict nor already as asked');
    // A read made after both: the server holds "Mine" now, so the edit is done.
    s.add([col('Name 2', 'Mine')]);
    eq([s.pendingCount(), s.original('a', 1033), s.original('a', FR)], [0, 'Name 2', 'Mine']);
    // A save's text is newer than a read that started before it; so is a text read again (seen) and a conflict resolved.
    const before = s.tick();
    s.set('a', FR, 'Nouveau');
    s.commit([{ change: s.changes()[0], outcome: 'saved' }]);
    s.seen('a', 1033, 'Name 3');
    s.add([col('Name 2', 'Mine')], before);
    eq([s.original('a', 1033), s.original('a', FR)], ['Name 3', 'Nouveau']);
    const late = s.tick();
    s.commit([{ change: { slot: s.get('a')!, lcid: FR, before: 'Nouveau', after: 'Autre' }, outcome: 'conflict', server: 'Le leur' }]);
    s.resolve('a', FR, false);
    s.add([col('Name 3', 'Nouveau')], late);
    eq(s.original('a', FR), 'Le leur');
    // A translation a save removed stays removed under an older read that still has it.
    s.add([slot('attribute', 'r', { 1033: 'R', 1036: 'R fr' })]);
    const r0 = s.tick();
    s.set('r', FR, '');
    s.commit([{ change: s.changes()[0], outcome: 'saved' }]);
    s.add([slot('attribute', 'r', { 1033: 'R', 1036: 'R fr' })], r0);
    eq([s.original('r', FR), 1036 in s.get('r')!.labels], ['', false]);
    // A language the newer copy hadn't loaded (a tab read in the user's language only) is taken from the older read.
    const t0 = s.tick();
    s.add([{ ...slot('tab', 't', { 1033: 'General' }), ref: { partial: [1033] } }]);
    s.add([{ ...slot('tab', 't', { 1033: 'Old general', 1036: 'Général' }), ref: {} }], t0);
    eq([s.original('t', 1033), s.original('t', FR)], ['General', 'Général']);
    // Two older reads answer late, the older first: the one it turns away keeps the newer text's age, so the other,
    // started after it but still before the newer text, never puts its text back either.
    s.add([slot('attribute', 'b', { 1033: 'B', 1036: 'Old' })]);
    const a = s.tick(),
      b = s.tick();
    s.add([slot('attribute', 'b', { 1033: 'B', 1036: 'New' })]);
    s.add([slot('attribute', 'b', { 1033: 'B', 1036: 'Old A' })], a);
    s.add([slot('attribute', 'b', { 1033: 'B', 1036: 'Old B' })], b);
    eq(s.original('b', FR), 'New');
  });

  test('store freshness: a Workbench extract (or Read again, or the editor\'s read of other languages) that started before a save keeps the saved text when it answers, and an edit back to its older text stays pending', () => {
    const s = new Store();
    const col = (fr: string) => slot('attribute', 'a', { 1033: 'Name', 1036: fr });
    s.add([col('W')]);
    const extract = s.tick(); // Extract translations starts reading (app.ts load())
    // Meanwhile, back on the page, the user saves X.
    s.set('a', FR, 'X');
    s.commit([{ change: s.changes()[0], outcome: 'saved' }]);
    s.add([col('W')], extract); // the extract's answer, read before the save
    eq([s.original('a', FR), s.pendingCount()], ['X', 0], 'the saved text stays the server text');
    s.set('a', FR, 'W'); // putting the old text back is an edit to save, measured against the saved text
    eq([s.isEdited('a', FR), s.before('a', FR), s.moved('a', FR)], [true, 'X', false]);
    s.add([col('W')], extract); // even a second answer of that read leaves it pending
    eq([s.pendingCount(), s.value('a', FR), s.original('a', FR)], [1, 'W', 'X']);
  });

  test("page loads: an answer to a page read that started before the Workbench extracted a newer text never clears an edit typed over that text because the edit matches the older answer", async () => {
    const KEY = 'attribute|acc.name|DisplayName';
    const col = (fr: string) => ({ ...slot('attribute', KEY, { 1033: 'Name', 1036: fr }), entity: 'acc' });
    const calls: string[] = [];
    let answer: (v: unknown[]) => void = () => {};
    const providers = {
      loadTables: (_c: unknown, ts: string[]) => {
        calls.push(ts.join());
        return new Promise((r) => (answer = r));
      },
    };
    const store = new Store();
    const ld = new PageLoader({ ctx: { xrm: {}, user: FR, base: 1033, langs: [{ lcid: 1033 }, { lcid: FR }] }, providers, store, lang: {} } as unknown as ConstructorParameters<typeof PageLoader>[0], () => {});
    const wait = async (done: () => boolean) => {
      for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 2));
    };
    ld.request([WANT_TABLE + 'acc']); // a grid of the page shows the table: its columns are read
    await wait(() => calls.length > 0);
    eq(calls, ['acc']);
    // Meanwhile the Workbench extracts the column (someone else saved "Theirs" since), and the user types "Mine" over it.
    store.add([col('Theirs')]);
    store.set(KEY, FR, 'Mine');
    // The page's read, made before someone else's save, answers with the text from before it, which is "Mine".
    answer([col('Mine')]);
    await wait(() => ld.busy.size === 0);
    eq([store.pendingCount(), store.value(KEY, FR), store.original(KEY, FR), store.before(KEY, FR)], [1, 'Mine', 'Theirs', 'Theirs']);
    // An older answer that differs from both: the newer text stays the edit's server text too.
    const other = new PageLoader({ ctx: { xrm: {}, user: FR, base: 1033, langs: [{ lcid: 1033 }, { lcid: FR }] }, providers, store, lang: {} } as unknown as ConstructorParameters<typeof PageLoader>[0], () => {});
    other.request([WANT_TABLE + 'acc']);
    await wait(() => calls.length > 1);
    store.add([col('Theirs 2')]);
    answer([col('Old')]);
    await wait(() => other.busy.size === 0);
    eq([store.pendingCount(), store.value(KEY, FR), store.original(KEY, FR), store.before(KEY, FR)], [1, 'Mine', 'Theirs 2', 'Theirs']);
  });
}
