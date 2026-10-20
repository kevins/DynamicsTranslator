// Unit tests for which CSV files get their export apostrophes removed (src/io/workbook.ts CSV_KEY): our CSV export
// says it is ours in its Key header, and only such a file (or Excel's copy of it, as CSV or as a
// workbook) is unguarded; every other CSV keeps its text as written. A keyed CSV without that header may be an export
// of ours from before it: a cell that differs from the label only by the apostrophe our export put in front is never
// staged (it is reported), so an old export can't add apostrophes to translations. An import never stages a label of a
// managed solution's component either.
import { MANAGED } from '../../../src/core/model';
import { Store } from '../../../src/core/store';
import { CSV_KEY, createIo } from '../../../src/io/workbook';
import { writeXlsx } from '../../../src/io/xlsx';
import type { Kit } from './kit';

const KEYS = 'Type,Table,Component,Property,1033,1036';
type Row = { values: Record<number, string> };

export function register(t: Kit): void {
  const { test, eq, ok } = t;
  const csv = (lines: string[], name = 'labels.csv') => new File([lines.join('\r\n')], name);
  const values = async (f: File) => ((await createIo().parse(f)).rows as Row[]).map((r) => r.values[1036]);
  const key = (i: number) => `attribute|account.a${i}|DisplayName`;

  test('csv mark: our export heads its Key column with the marker and round-trips every formula-like start, whatever apostrophes it has', async () => {
    const texts: string[] = ['plain', "'quoted'", 'x=1'];
    for (const p of ['=', '+', '-', '@', '\t']) for (let n = 0; n < 4; n++) texts.push(`${"'".repeat(n)}${p}Total`);
    const slots = texts.map((v, i) => t.slot('attribute', key(i), { 1033: 'Name', 1036: v }));
    const io = createIo();
    const blob = io.exportCsv(slots, [1033, 1036]);
    const text = (await blob.text()).replace(/^﻿/, ''); // the BOM, when the decoder keeps it
    ok(text.startsWith(`${CSV_KEY},${KEYS}\r\n`), text.slice(0, 80));
    const back = new Map(((await createIo().parse(new File([blob], 'labels.csv'))).rows as Array<Row & { id: Record<string, string> }>).map((r) => [r.id.Key, r.values[1036]]));
    eq(texts.map((_, i) => back.get(key(i))), texts);
  });

  test("csv mark: Excel's copy of our export keeps the marker: saved as CSV (semicolons, apostrophes kept or dropped) or as a workbook, it is unguarded the same way", async () => {
    const head = `${CSV_KEY};${KEYS.replace(/,/g, ';')}`;
    eq(await values(csv([head, `${key(0)};;account;;;Name;'=Nom`, `${key(1)};;account;;;X;=Nom`, `${key(2)};;account;;;Y;''+1`])), ['=Nom', '=Nom', "'+1"]);
    const sheet = { name: 'labels', rows: [[CSV_KEY, ...KEYS.split(',')], [key(0), null, 'account', null, null, 'Name', "'=Nom"], [key(1), null, 'account', null, null, 'Y', "''+1"]] };
    const book = new File([await writeXlsx([sheet])], 'labels.xlsx');
    const parsed = await createIo().parse(book);
    eq([(parsed.rows as Row[]).map((r) => r.values[1036]), (parsed.rows as Array<{ id: Record<string, string> }>).map((r) => r.id.Key)], [['=Nom', "'+1"], [key(0), key(1)]]);
  });

  test('csv mark: a keyed CSV from elsewhere (no marker) keeps its text literally, apostrophes included', async () => {
    eq(await values(csv([`Key,${KEYS}`, `${key(0)},,account,,,Name,'=literal`, `${key(1)},,account,,,X,'@home`, `${key(2)},,account,,,Y,''-x`])), ["'=literal", "'@home", "''-x"]);
    eq(await values(csv([`key,${KEYS}`, `${key(0)},,account,,,Name,'+1`])), ["'+1"], 'the header in any case');
  });

  test('csv mark: an unmarked keyed CSV (an export of ours from before the marker) never stages the export apostrophe alone; other cells are staged literally; our marked export stages nothing for it', async () => {
    const slots = () => {
      const store = new Store();
      store.add([t.slot('attribute', key(0), { 1033: 'Name', 1036: '=Nom' }), t.slot('attribute', key(1), { 1033: 'X', 1036: '-- None --' }), t.slot('attribute', key(2), { 1033: 'Y', 1036: 'Total' })]);
      return store;
    };
    const lines = (head: string) => [head, `${key(0)},,account,,,Name,'=Nom`, `${key(1)},,account,,,X,'-- None --`, `${key(2)},,account,,,Y,'=Somme`];
    const io = createIo();
    const old = slots();
    const r = io.apply(await io.parse(csv(lines(`Key,${KEYS}`))), old);
    eq([r.staged, r.unchanged, r.skipped.map((s) => [s.key, s.values[1036]])], [1, 3, [[key(0), "'=Nom"], [key(1), "'-- None --"]]]);
    ok(r.skipped.every((s) => /older CSV exports of the translator/.test(s.reason)), r.skipped[0]?.reason);
    eq(old.changes().map((c) => [c.slot.key, c.after]), [[key(2), "'=Somme"]], 'the text that is not the label with an apostrophe is staged as written');
    const own = slots();
    const m = io.apply(await io.parse(csv(lines(`${CSV_KEY},${KEYS}`))), own);
    eq([m.staged, m.unchanged, m.skipped.length, own.changes().map((c) => c.after)], [1, 5, 0, ['=Somme']]);
  });

  test("csv mark: an older export of ours saved by Excel as a workbook (a keyed sheet, no marker, no Translator sheet) never stages the export apostrophe alone either; our own workbook's keyed sheet is read literally", async () => {
    const slots = () => {
      const store = new Store();
      store.add([t.slot('attribute', key(0), { 1033: 'X', 1036: '-- None --' }), t.slot('attribute', key(1), { 1033: 'Y', 1036: 'Total' })]);
      return store;
    };
    const rows = [['Key', ...KEYS.split(',')], [key(0), null, 'account', null, null, 'X', "'-- None --"], [key(1), null, 'account', null, null, 'Y', "'=Somme"]];
    const io = createIo();
    const copy = slots();
    const r = io.apply(await io.parse(new File([await writeXlsx([{ name: 'labels', rows }])], 'labels.xlsx')), copy);
    eq([r.staged, r.skipped.map((s) => [s.key, s.values[1036]]), copy.changes().map((c) => c.after)], [1, [[key(0), "'-- None --"]], ["'=Somme"]]);
    ok(/older CSV exports of the translator/.test(r.skipped[0]?.reason || ''), r.skipped[0]?.reason);
    const book = slots();
    const own = io.apply(await io.parse(new File([await writeXlsx([{ name: 'Other', rows }, { name: 'Translator', rows: [['Dynamics Translator', 'Translation workbook']] }])], 'book.xlsx')), book);
    eq([own.staged, own.skipped.length, book.changes().map((c) => c.after)], [2, 0, ["'-- None --", "'=Somme"]]);
  });

  test('csv mark: an Easy Translator sheet saved as CSV is read literally, as before', async () => {
    eq(await values(csv(['Attribute Id,Entity Logical Name,Attribute Logical Name,Type,1033,1036', "{a},account,name,DisplayName,Name,'=Nom"])), ["'=Nom"]);
  });

  test("import: a label of a managed solution's component is skipped with the managed reason and never staged, also one that slipped through as editable; the file's other rows are staged", async () => {
    const store = new Store();
    store.add([{ ...t.slot('attribute', key(0), { 1033: 'Name', 1036: 'Nom' }), ref: { managed: true } }, t.slot('attribute', key(1), { 1033: 'X', 1036: 'X fr' })]);
    const io = createIo();
    const file = () => csv([`${CSV_KEY},${KEYS}`, `${key(0)},,account,,,Name,Nom 2`, `${key(1)},,account,,,X,X 2`]);
    const r = io.apply(await io.parse(file()), store);
    eq([r.staged, r.skipped.map((s) => [s.key, s.values[1036], s.reason])], [1, [[key(0), 'Nom 2', `Read-only: ${MANAGED}`]]]);
    eq(store.changes().map((c) => [c.slot.key, c.after]), [[key(1), 'X 2']]);
    // Its read-only reason taken away after it was loaded: still skipped with the managed reason.
    store.get(key(0))!.readOnly = '';
    const r2 = io.apply(await io.parse(file()), store);
    eq([r2.skipped.map((s) => s.reason), store.isEdited(key(0))], [[`Read-only: ${MANAGED}`], false]);
  });
}
