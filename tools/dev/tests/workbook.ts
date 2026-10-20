// Unit tests for the workbook area (src/workbench/workbench.ts): which slots are in the workbook, the pending
// changes navigator, "Filter rows", language columns, tab counts and the message bar's save line; and the Workbench
// window's ✕ (ui/app.ts winClose) on the fake DOM of tools/dev/tests/callout.ts.
// register() is called by tools/dev/unit.ts.
import { MANAGED, type Lcid, type Prop, type Slot } from '../../../src/core/model';
import { hit, terms } from '../../../src/core/search';
import { Store } from '../../../src/core/store';
import { SHEETS } from '../../../src/workbench/sheets';
import { bookOf, cmpLoc, columnLangs, fixSlot, gridOptions, inBook, navStep, nothingExtracted, pendingLocs, pickSheet, saveLine, skippedIntro, tabCounts, took, unhide, unreadLine, type Extracted, type Loc } from '../../../src/workbench/workbench';
import type { SheetCtx } from '../../../src/workbench/types';
import { translatesOn, winClose } from '../../../src/ui/app';
import type { SaveReport } from '../../../src/ui/types';
import { fire, install, type FEl } from './callout';
import type { Kit } from './kit';

export function register(t: Kit): void {
  const { test, eq, ok } = t;
  /** A slot of `kind` on table `entity`, with a prop and labels. */
  const mk = (kind: string, id: string, prop: Prop = 'DisplayName', entity = 'account', o: Partial<Slot> = {}): Slot => {
    const key = `${kind}|${id}|${prop}`;
    return { ...t.slot(kind, key, { 1033: `${id} ${prop}`, 1036: `${id} ${prop} FR` }), prop, entity, comp: `${kind}|${id}`, title: id, ...o };
  };
  const x = (kinds: string[], ents: string[], ro = false): Extracted => ({ kinds: new Set(kinds) as Extracted['kinds'], ents: new Set(ents), ro });
  const loc = (s: number, r: number, l: number, key = `k${s}.${r}`, lcid: Lcid = 1036): Loc => ({ s, r, l, key, lcid });

  // ---- what belongs in the workbook ----
  test('workbook: before any extraction everything in the store is shown', () => {
    ok(inBook(mk('attribute', 'a'), null, false));
    ok(inBook(mk('attribute', 'a', 'DisplayName', 'contact', { readOnly: 'Managed' }), null, false), 'read-only too');
  });
  test('workbook: an extraction shows its kinds, table-bound kinds only for its tables', () => {
    const e = x(['attribute', 'globaloption', 'relationship'], ['account']);
    ok(inBook(mk('attribute', 'a'), e, false), 'attribute of an extracted table');
    ok(!inBook(mk('attribute', 'b', 'DisplayName', 'contact'), e, false), 'attribute of another table');
    ok(!inBook(mk('view', 'v'), e, false), 'kind not extracted');
    ok(inBook(mk('globaloption', 'g', 'Label', ''), e, false), 'global choice (no table)');
    ok(inBook(mk('relationship', 'r', 'Label', 'contact'), e, false), 'relationship owned by the other table');
  });
  test('workbook: read-only labels only when asked for', () => {
    const ro = mk('attribute', 'a', 'DisplayName', 'account', { readOnly: 'Managed and not customizable' });
    ok(!inBook(ro, x(['attribute'], ['account']), false));
    ok(inBook(ro, x(['attribute'], ['account'], true), false));
  });
  test("workbook: a label of a managed solution's component is read-only in the store, so an extraction shows it only when read-only labels were asked for", () => {
    const store = new Store();
    store.add([mk('attribute', 'm', 'DisplayName', 'account', { ref: { managed: true } })]);
    const s = store.get('attribute|m|DisplayName')!;
    eq(s.readOnly, MANAGED);
    ok(!inBook(s, x(['attribute'], ['account']), false));
    ok(inBook(s, x(['attribute'], ['account'], true), false));
  });
  test('workbook: an extraction that brought nothing says, without read-only labels, that labels from managed solutions are left out and how to see them', () => {
    const off = nothingExtracted(false);
    ok(/from managed solutions or not customizable\) are left out unless “Include read-only labels” is selected/.test(off), off);
    eq(nothingExtracted(true), 'No labels were extracted. Choose other tables or options, then select Extract translations again.');
  });
  test("workbook: Skipped rows says rows weren't imported or not in full, never that each matched no label (an Excel error cell or conflicting duplicates skip only those languages of a matched row)", () => {
    eq(skippedIntro(1, 'book.xlsx'), '1 row of book.xlsx was not imported, or not in full:');
    eq(skippedIntro(3, 'book.csv'), '3 rows of book.csv were not imported, or not in full:');
  });
  test('workbook: a pending edit (or a Fix target) is always in, even outside the extraction', () => {
    const s = mk('view', 'v', 'Name', 'contact');
    const e = x(['attribute'], ['account']);
    ok(!inBook(s, e, false));
    ok(inBook(s, e, true), 'edited');
    ok(inBook(s, e, false, true), 'pinned');
  });
  test('workbook: sheets in tab order, every edited slot placed, label options never hide an edit', () => {
    const st = new Store();
    const a1 = mk('attribute', 'a1'),
      a1d = mk('attribute', 'a1', 'Description'),
      a2d = mk('attribute', 'a2', 'Description'),
      ent = mk('entity', 'account'),
      other = mk('view', 'v1', 'Name', 'contact');
    st.add([a1, a1d, a2d, ent, other]);
    st.set(a2d.key, 1036, 'Infobulle');
    st.set(other.key, 1036, 'Vue');
    const b = bookOf(st.slots.values(), (k) => st.isEdited(k), x(['entity', 'attribute'], ['account']), 'names');
    // Names only: a1's description is hidden, a2's stays because it holds a pending edit; the view (not
    // extracted, other table) is in because of its edit.
    ok(!b.place.has(a1d.key), 'unedited description hidden by Only Names');
    ok(b.place.has(a2d.key) && b.place.has(other.key), 'edited rows kept');
    eq(b.total, 4);
    const ids = [...b.by.keys()],
      order = SHEETS.map((d) => d.id);
    eq(
      ids,
      order.filter((id) => ids.includes(id)),
      'sheets in tab order',
    );
    for (const [id, rows] of b.by) rows.forEach((s, i) => eq(b.place.get(s.key), [order.indexOf(id), i], s.key));
    // Every pending change can be reached by the navigator.
    const cells: Array<[string, Lcid]> = [];
    for (const [k, e] of st.edits) for (const l of e.keys()) cells.push([k, l]);
    eq(pendingLocs(cells, (k) => b.place.get(k), () => 1).length, st.pendingCount());
  });

  // ---- pending navigator ----
  test('workbook navigator: changes in sheet, row, then language order; cells outside the workbook left out', () => {
    const where = new Map<string, [number, number]>([
      ['b', [2, 0]],
      ['a', [0, 5]],
      ['c', [0, 1]],
    ]);
    const col = (l: Lcid) => [1033, 1036, 1031].indexOf(l);
    const L = pendingLocs(
      [
        ['b', 1036],
        ['a', 1031],
        ['a', 1036],
        ['c', 1033],
        ['zz', 1036],
      ],
      (k) => where.get(k),
      col,
    );
    eq(
      L.map((l) => `${l.key}#${l.lcid}`),
      ['c#1033', 'a#1036', 'a#1031', 'b#1036'],
    );
  });
  test('workbook navigator: wraps around and starts at the first (down) or last (up) change', () => {
    const L = [loc(0, 1, 1), loc(0, 4, 1), loc(3, 0, 2)];
    eq(navStep([], null, 1), -1);
    eq(navStep(L, null, 1), 0);
    eq(navStep(L, null, -1), 2);
    eq(navStep(L, L[0], 1), 1);
    eq(navStep(L, L[2], 1), 0, 'down from the last wraps to the first');
    eq(navStep(L, L[0], -1), 2, 'up from the first wraps to the last');
    eq(navStep(L, L[1], -1), 0);
  });
  test('workbook navigator: from a cell that is not a pending change, the next or previous one around it', () => {
    const L = [loc(0, 1, 1), loc(0, 4, 1), loc(3, 0, 2)];
    eq(navStep(L, loc(0, 2, 0, 'x'), 1), 1);
    eq(navStep(L, loc(0, 2, 0, 'x'), -1), 0);
    eq(navStep(L, loc(5, 0, 0, 'x'), 1), 0, 'after the last: wraps');
    eq(navStep(L, loc(5, 0, 0, 'x'), -1), 2);
    // Same row: a cell left of the change goes to it, right of it goes on.
    eq(navStep(L, loc(0, 4, 0, 'k0.4'), 1), 1);
    eq(navStep(L, loc(0, 4, 2, 'k0.4'), 1), 2);
    ok(cmpLoc(loc(0, 1, 1), loc(0, 1, 1)) === 0);
  });

  // ---- Filter rows ----
  test('workbook filter rows: terms are folded like the search text (accents, _ and -, case)', () => {
    eq(terms('  École  Account_Number e-mail '), ['ecole', 'account', 'number', 'e', 'mail']);
    eq(terms('   '), []);
    ok(hit('ecole account number', terms('NUMBER école')));
    ok(!hit('ecole account', terms('ecole contact')), 'every term must match');
    ok(hit('anything', []), 'no terms: everything matches');
  });

  // ---- languages, sheets, tab counts ----
  test('workbook language columns: base, target, other shown languages in org order, then pending ones', () => {
    const org = [1033, 1031, 1036, 3082];
    eq(columnLangs(org, 1033, 1036, [1033, 1036], new Set()), [1033, 1036]);
    eq(columnLangs(org, 1033, 1036, [3082, 1036], new Set([1031])), [1033, 1036, 1031, 3082]);
    eq(columnLangs(org, 1033, 1033, [], new Set()), [1033], 'only the base language');
    eq(columnLangs([1036, 1033], 1036, 1033, [], new Set()), [1036, 1033], 'base other than 1033');
  });
  test('workbook: the current sheet stays while it has rows, else the first one with rows', () => {
    const order = ['entities', 'attributes', 'views'];
    eq(pickSheet('views', order, (id) => id !== 'entities'), 'views');
    eq(pickSheet('entities', order, (id) => id !== 'entities'), 'attributes');
    eq(pickSheet('gone', order, () => false), 'gone', 'nothing anywhere: unchanged');
  });
  test('workbook: tab counts are the rows each sheet shows', () => {
    const s = mk('attribute', 'a');
    eq([...tabCounts(new Map([['attributes', [s, s]], ['views', []]]))], [['attributes', 2], ['views', 0]]);
  });

  // ---- message bar ----
  test('workbook message bar: durations as in the old workbook', () => {
    eq(took(830.4), '830 ms');
    eq(took(8240), '8.2 seconds');
  });
  const rep = (o: Partial<SaveReport>): SaveReport => ({ results: [], saved: 0, unchanged: 0, conflicts: 0, errors: 0, skipped: 0, published: true, ms: 2100, ...o });
  test('workbook message bar: a clean save says it was verified and published', () => {
    const r = saveLine(rep({ saved: 3, results: new Array(3) }));
    eq(r.tone, 'ok');
    ok(/^Saved 3 changes and published them in 2\.1 seconds\. Every change was read back/.test(r.text), r.text);
    ok(!r.problems);
    const np = saveLine(rep({ saved: 1, published: false, results: new Array(1) }));
    ok(/^Saved 1 change in .*after the next publish\.$/.test(np.text), np.text);
  });
  test('workbook message bar: problems are counted, red, and point at Rows › Save problems', () => {
    const r = saveLine(rep({ saved: 3, unchanged: 1, errors: 1, conflicts: 2, results: new Array(7) }));
    eq(r.tone, 'err');
    ok(r.problems);
    ok(r.text.startsWith('Saved 4 of 7 changes. 1 could not be saved and 2 were changed by someone else: they are marked with ! in the grid.'), r.text);
    ok(r.text.includes('Save problems'), r.text);
  });
  test('workbook message bar: stopped saves, publish errors and warnings are not reported as success', () => {
    const s = saveLine(rep({ saved: 1, skipped: 2, results: new Array(3) }));
    eq(s.tone, 'err');
    ok(s.text.includes('2 changes were not saved and are still pending.'), s.text);
    const p = saveLine(rep({ saved: 2, published: false, publishError: 'Dataverse is busy.', results: new Array(2) }));
    eq(p.tone, 'err');
    ok(p.text.endsWith('Dataverse is busy.') && !p.text.includes('next publish'), p.text);
    const w = saveLine(rep({ saved: 1, warning: 'Your Dynamics language could not be switched back.', results: new Array(1) }));
    eq(w.tone, 'err');
    const u = saveLine(rep({ unchanged: 2, results: new Array(2) }));
    eq(u.tone, 'ok');
    ok(u.text.startsWith('Nothing needed saving'), u.text);
    const none = saveLine(rep({}));
    eq([none.text, none.tone], ['Nothing was saved.', 'info'], 'an empty report is not a success');
  });
  test('workbook message bar: changes still pending that the last save does not count are never reported as saved', () => {
    // The review dialog resolves with its last run: after "Retry failed changes" saved 2, a conflict of the
    // first run is still pending. The line must say so, in the error tone.
    const r = saveLine(rep({ saved: 2, results: new Array(2) }), { left: 1 });
    eq(r.tone, 'err');
    ok(r.pending && !r.problems);
    ok(r.text.startsWith('Saved 2 changes and published them') && r.text.endsWith('1 other change is not saved yet: Rows › Pending changes lists it.'), r.text);
    // Pending edits the report already counts (errors, conflicts, skipped keep their edit) are not counted twice.
    const c = saveLine(rep({ saved: 1, errors: 1, conflicts: 1, skipped: 1, results: new Array(4) }), { left: 3 });
    ok(!c.pending && !/not saved yet/.test(c.text), c.text);
    const more = saveLine(rep({ saved: 1, errors: 1, results: new Array(2) }), { left: 4 });
    ok(more.pending && more.text.includes('3 other changes are not saved yet'), more.text);
    // Nothing saved at all, yet changes remain: no "other".
    const only = saveLine(rep({}), { left: 2 });
    eq(only.tone, 'err');
    eq(only.text, '2 changes are not saved yet: Rows › Pending changes lists them.');
  });

  // ---- revealing a row ----
  test('workbook reveal: only what hides the row is cleared; a stale filter result is just re-filtered', () => {
    eq(unhide(true, false, false), { rows: false, text: false, refilter: false }, 'shown: nothing to do');
    eq(unhide(false, false, true), { rows: true, text: false, refilter: true }, 'hidden by Rows');
    eq(unhide(false, true, false), { rows: false, text: true, refilter: true }, 'hidden by Filter rows');
    eq(unhide(false, false, false), { rows: true, text: true, refilter: true });
    // Rows › Pending changes ran, the edit was reverted and the rows re-filtered, then Ctrl+Z made it pending
    // again: it passes both filters but is not in the shown rows. Re-filtering must bring it back.
    eq(unhide(false, true, true), { rows: false, text: false, refilter: true });
  });
  test('workbook Fix link: the property with the problem in that language, else the edited one', () => {
    const name = mk('attribute', 'a'),
      desc = mk('attribute', 'a', 'Description');
    const list = [name, desc];
    eq(fixSlot(list, 1036, (s) => s === desc, () => true), desc, 'the failed description, not the first edited property');
    eq(fixSlot(list, 1036, () => false, (s) => s === desc), desc, 'the edited one');
    eq(fixSlot(list, 1036, () => false, () => false), name, 'else the first');
    eq(fixSlot(list, undefined, () => true, () => true), name, 'no language: the first');
    eq(fixSlot([], 1036, () => true, () => true), undefined);
  });
  test('workbook message bar: form labels not read say how many forms, which languages, then why in a sentence of its own (the first reason only)', () => {
    const name = (l: Lcid) => ({ 1031: 'German', 1033: 'English', 1036: 'French' })[l as 1031] ?? String(l);
    const f = (formId: string) => ({ formId, entity: 'account', name: '', type: 2 });
    eq(
      unreadLine({ forms: [f('a')], langs: [1036], why: ['Dynamics did not answer in French, so its form labels were not used. Try again.'] }, name),
      'The French labels of 1 form could not be read, even when tried again. Dynamics did not answer in French, so its form labels were not used. Try again. Their cells show “Not loaded” until they are read.',
    );
    eq(
      unreadLine({ forms: [f('a'), f('b'), f('c')], langs: [1036, 1031, 1033], why: ['The batch failed.', 'Form b is broken.'] }, name),
      "The French, German and English labels of 3 forms could not be read, even when tried again. The batch failed (and 1 other reason: see the cells' tooltips). Their cells show “Not loaded” until they are read.",
    );
    // The loader's own reasons name neither the form nor the language (providers/formxml.ts), so they read well here.
    eq(
      unreadLine({ forms: [f('a'), f('b')], langs: [1036], why: ['Dynamics did not return the form in that language.'] }, name),
      'The French labels of 2 forms could not be read, even when tried again. Dynamics did not return the form in that language. Their cells show “Not loaded” until they are read.',
    );
    eq(unreadLine({ forms: [f('a')], langs: [1036], why: [] }, name), 'The French labels of 1 form could not be read, even when tried again. Their cells show “Not loaded” until they are read.');
  });
  test("workbook: the grid gets the message bar's Read again, so a \"Not loaded\" cell's notice can offer it; it runs only once clicked", () => {
    const widths = { a: 120 };
    const ctx = { store: new Store(), tableName: (e: string) => e } as SheetCtx;
    const log: string[] = [];
    const o = gridOptions({ widths }, ctx, () => void log.push('persist'), (t) => void log.push(`sel ${t}`), () => void log.push('reread'));
    ok(o.widths === widths && o.ctx === ctx, 'its widths (resized in place) and sheet context');
    eq(log, [], 'nothing runs yet');
    o.onWidths();
    o.onSel('3 cells');
    o.readAgain?.();
    eq(log, ['persist', 'sel 3 cells', 'reread']);
  });

  // ---- the window's ✕ ----
  test('workbook: the window ✕ goes back to the page wherever translation mode runs, its name and tooltip saying so with Alt+1, and closes the translator only where there is no page', () => {
    const off = install();
    try {
      // The page types translation mode runs on (pageInfo's), as the title bar passes them (translatesOn).
      const press = (type: string) => {
        const ran: string[] = [];
        const b = winClose(type, { page: () => void ran.push('page'), close: () => void ran.push('close') }) as unknown as FEl;
        fire(b, 'click', { detail: 1 });
        return [b.getAttribute('aria-label'), b.getAttribute('aria-keyshortcuts'), ran.join(), translatesOn(type)];
      };
      for (const type of ['entityrecord', 'entitylist', 'dashboard'])
        eq(press(type), ['Back to page (Alt+1)', 'Alt+1', 'page', true], `${type}: back to the page, the translator stays open; its name says where it goes`);
      for (const type of ['apps', 'other', ''])
        eq(press(type), ['Close', null, 'close', false], `${type || 'no page type'}: no page to go back to, so it closes the translator`);
    } finally {
      off();
    }
  });
}
