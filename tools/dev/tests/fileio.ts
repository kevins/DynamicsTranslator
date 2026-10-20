// Unit tests for reading imported files (src/core/zip.ts, src/io/xlsx.ts, src/io/csv.ts, src/io/workbook.ts parse):
// damaged, oversized and unusual files are refused or read without allocating what they don't hold; what a file
// can't say for sure (an Excel error in a cell, two texts for one label, two columns for one language) is never staged.
// register() is called by tools/dev/unit.ts.
import type { Ctx } from '../../../src/core/context';
import { Store } from '../../../src/core/store';
import { openZip, unzip, utf8, zip, type ZipEntry } from '../../../src/core/zip';
import { parseCsv } from '../../../src/io/csv';
import { CSV_KEY, createIo } from '../../../src/io/workbook';
import { readXlsx, writeXlsx } from '../../../src/io/xlsx';
import { loadRibbonLabels } from '../../../src/providers/ribbon';
import type { Kit } from './kit';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const SHEET = 'xl/worksheets/sheet1.xml';

/** A workbook written by writeXlsx with its first sheet's <sheetData> replaced and `extra` entries added. */
async function book(sheetData: string, extra: ZipEntry[] = [], store = false): Promise<Uint8Array> {
  const parts = await unzip(new Uint8Array(await (await writeXlsx([{ name: 'S', rows: [['x']] }])).arrayBuffer()));
  for (const p of parts) if (p.name === SHEET) p.data = utf8(`<worksheet xmlns="${MAIN}"><sheetData>${sheetData}</sheetData></worksheet>`);
  return zip([...parts, ...extra], store);
}
const cell = (ref: string, v: string) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;

/** Where entry `name` of ZIP `z` (as zip() writes it: no comment) is: its directory record, local header and data. */
function locate(z: Uint8Array, name: string): { cd: number; lho: number; data: number; csize: number } {
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const eocd = z.length - 22;
  let p = dv.getUint32(eocd + 16, true);
  for (let k = 0; k < dv.getUint16(eocd + 10, true); k++) {
    const nlen = dv.getUint16(p + 28, true),
      lho = dv.getUint32(p + 42, true);
    if (new TextDecoder().decode(z.subarray(p + 46, p + 46 + nlen)) === name)
      return { cd: p, lho, data: lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true), csize: dv.getUint32(p + 20, true) };
    p += 46 + nlen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  throw new Error(`no ${name} in the ZIP`);
}
const dv = (z: Uint8Array) => new DataView(z.buffer, z.byteOffset, z.byteLength);
const fails = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'no error',
    (e) => String((e as Error)?.message),
  );

export function register(t: Kit): void {
  const { test, eq, ok } = t;

  // ---- sheets: references outside Excel's grid, sparse cells ----
  test('xlsx: one cell at the last row and column is read without allocating the rows and columns before it', async () => {
    const [s] = await readXlsx(new Blob([await book(`<row r="1048576">${cell('XFD1048576', 'far')}</row>`)]));
    eq(s.rows[1048575]?.[16383], 'far');
    eq([Object.keys(s.rows).length, Object.keys(s.rows[1048575]).length], [1, 1], 'only the cell the file holds');
  });
  test('xlsx: a row or column outside the sheet is a damaged workbook', async () => {
    for (const [what, xml] of [
      ['row past 1,048,576', `<row r="1048577">${cell('A1048577', 'x')}</row>`],
      ['row 10^12', `<row r="1000000000000">${cell('A1', 'x')}</row>`],
      ['row 0', `<row r="0">${cell('A1', 'x')}</row>`],
      ['row "abc"', `<row r="abc">${cell('A1', 'x')}</row>`],
      ['row 1.5', `<row r="1.5">${cell('A1', 'x')}</row>`],
      ['column past XFD', `<row r="1">${cell('XFE1', 'x')}</row>`],
      ['column ZZZZZZ', `<row r="1">${cell('ZZZZZZ1', 'x')}</row>`],
    ])
      ok(/workbook is damaged/.test(await fails(readXlsx(new Blob([await book(xml)])))), what);
  });
  test('xlsx: rows and cells without references follow the previous ones', async () => {
    const [s] = await readXlsx(new Blob([await book(`<row r="3">${cell('B3', 'b')}<c t="inlineStr"><is><t>c</t></is></c></row><row>${cell('A4', 'a')}</row>`)]));
    eq([s.rows[2]?.[1], s.rows[2]?.[2], s.rows[3]?.[0], s.rows.length], ['b', 'c', 'a', 4]);
  });
  test('workbook import: a sheet with gaps (an empty header cell, a row far down) is read', async () => {
    const io = createIo();
    const bytes = await book(
      `<row r="1">${['Attribute Id', 'Entity Logical Name', 'Attribute Logical Name', 'Type'].map((h, i) => cell(`${'ABCD'[i]}1`, h)).join('')}${cell('F1', '1036')}</row>` +
        `<row r="500000">${cell('B500000', 'account')}${cell('C500000', 'name')}${cell('D500000', 'DisplayName')}${cell('F500000', 'Nom')}</row>`,
    );
    // The test sheet is named "S": rename it to an Easy Translator sheet.
    const parts = (await unzip(bytes)).map((p) => (p.name === 'xl/workbook.xml' ? { ...p, data: utf8(new TextDecoder().decode(p.data).replace('name="S"', 'name="Attributes"')) } : p));
    const p = await io.parse(new File([await zip(parts)], 'book.xlsx'));
    eq(
      (p.rows as Array<{ row: number; id: Record<string, string>; values: Record<number, string> }>).map((r) => [r.row, r.id['Attribute Logical Name'], r.values]),
      [[500000, 'name', { 1036: 'Nom' }]],
    );
  });

  // ---- ZIP: only the parts the workbook uses are unpacked, within a budget ----
  test('xlsx: a part the workbook does not use is never unpacked', async () => {
    // Unreadable deflate data (block type 3): unpacking it would fail the import.
    const z = await book(`<row r="1">${cell('A1', 'kept')}</row>`, [{ name: 'xl/media/padding.bin', data: new Uint8Array(1 << 20) }]);
    z[locate(z, 'xl/media/padding.bin').data] = 0xff;
    const [s] = await readXlsx(new Blob([z]));
    eq(s.rows[0], ['kept']);
  });
  test('xlsx: a part declaring more than the import may unpack is refused before it is unpacked', async () => {
    const z = await book(`<row r="1">${cell('A1', 'x')}</row>`);
    dv(z).setUint32(locate(z, SHEET).cd + 24, 0x30000000, true); // 768 MB declared
    ok(/too large/.test(await fails(readXlsx(new Blob([z])))), 'refused as too large');
  });

  test('zip: the limit counts every read together, before anything is unpacked', async () => {
    const z = await zip([{ name: 'a', data: new Uint8Array(600) }, { name: 'b', data: new Uint8Array(600) }]);
    const [a, b] = openZip(z, 1000);
    eq((await a.read()).length, 600);
    ok(/too large/.test(await fails(b.read())), 'the second read passes the limit');
    ok(/too large/.test(await fails(openZip(z, 500)[0].read())), 'one entry over the limit');
  });
  test('zip: an entry that unpacks to more than its directory declares is refused', async () => {
    const z = await zip([{ name: 'a', data: utf8('x'.repeat(100000)) }]);
    dv(z).setUint32(locate(z, 'a').cd + 24, 1000, true);
    ok(/damaged/.test(await fails(openZip(z)[0].read())));
  });
  test('zip: local headers with zero sizes (data descriptor flag) are read from the directory', async () => {
    const z = await zip([{ name: 'a.xml', data: utf8('<a>é</a>') }]);
    const h = locate(z, 'a.xml').lho;
    dv(z).setUint16(h + 6, 0x0808, true);
    for (const o of [14, 18, 22]) dv(z).setUint32(h + o, 0, true);
    eq(new TextDecoder().decode(await openZip(z)[0].read()), '<a>é</a>');
  });
  test('zip: a local header that is missing or a part that is cut short is damaged', async () => {
    const bad = async (patch: (z: Uint8Array, at: ReturnType<typeof locate>) => void) => {
      const z = await zip([{ name: 'a', data: utf8('hello world') }], true);
      patch(z, locate(z, 'a'));
      return fails(openZip(z)[0].read());
    };
    ok(/damaged/.test(await bad((z, at) => dv(z).setUint32(at.lho, 0, true))), 'no local header signature');
    ok(/damaged/.test(await bad((z, at) => dv(z).setUint32(at.cd + 42, z.length - 10, true))), 'local header past the end');
    ok(/damaged/.test(await bad((z, at) => dv(z).setUint32(at.cd + 20, z.length, true))), 'data past the end');
  });
  test('xlsx: two parts with one name (ignoring case) are a damaged workbook', async () => {
    const z = await book(`<row r="1">${cell('A1', 'x')}</row>`, [{ name: 'XL/Worksheets/Sheet1.xml', data: utf8(`<worksheet xmlns="${MAIN}"/>`) }]);
    ok(/damaged.*twice/.test(await fails(readXlsx(new Blob([z])))));
  });

  // ---- ZIP: damaged files are refused, not read as other text ----
  test('xlsx: a stored part altered without its checksum is refused', async () => {
    const z = await book(`<row r="1">${cell('A1', 'one cell')}</row>`, [], true);
    const at = locate(z, SHEET);
    const i = new TextDecoder().decode(z.subarray(at.data, at.data + at.csize)).indexOf('one cell');
    z.set(utf8('two'), at.data + i);
    ok(/damaged/.test(await fails(readXlsx(new Blob([z])))), 'refused as damaged');
  });
  test('xlsx: a deflated part whose checksum or size does not match is refused', async () => {
    for (const [what, off, v] of [
      ['checksum', 16, 0x12345678],
      ['size', 24, 3],
    ] as const) {
      const z = await book(`<row r="1">${cell('A1', 'x')}</row>`);
      dv(z).setUint32(locate(z, SHEET).cd + off, v, true);
      ok(/damaged/.test(await fails(readXlsx(new Blob([z])))), what);
    }
  });

  // ---- CSV: the apostrophe before text that starts like a formula ----
  type Row = { values: Record<number, string> };
  const csvValues = async (lines: string[]) => ((await createIo().parse(new File([lines.join('\r\n')], 'labels.csv'))).rows as Row[]).map((r) => r.values[1036]);
  test('csv import: our own export (its Key header says so) removes the apostrophe the export adds, and only that one; a keyed CSV without that header keeps every apostrophe', async () => {
    const body = ["attribute|account.name|DisplayName,,account,,,Name,'=Nom", "attribute|account.x|DisplayName,,account,,,X,''-x", "attribute|account.y|DisplayName,,account,,,Y,'Nom"];
    eq(await csvValues(['Key (Dynamics Translator CSV),Type,Table,Component,Property,1033,1036', ...body]), ['=Nom', "'-x", "'Nom"]);
    eq(await csvValues(['Key,Type,Table,Component,Property,1033,1036', ...body]), ["'=Nom", "''-x", "'Nom"]);
  });
  test('csv import: in an Easy Translator sheet saved as CSV a leading apostrophe is text', async () => {
    eq(await csvValues(['Attribute Id,Entity Logical Name,Attribute Logical Name,Type,1033,1036', "{a},account,name,DisplayName,Name,'=Nom", "{b},account,x,DisplayName,X,'+1"]), ["'=Nom", "'+1"]);
  });
  test('csv: our export and import round-trip text starting like a formula, with or without an apostrophe', async () => {
    const texts = ['=Total', "'=Total", "''+1", '-- None --', '@home', "'quoted'", 'plain'];
    const slots = texts.map((v, i) => t.slot('attribute', `attribute|account.a${i}|DisplayName`, { 1033: 'Name', 1036: v }));
    const io = createIo();
    const blob = io.exportCsv(slots, [1033, 1036]);
    eq(((await io.parse(new File([blob], 'labels.csv'))).rows as Row[]).map((r) => r.values[1036]), texts);
  });

  // ---- what a file can't say for sure is never staged ----
  const key = (i: number) => `attribute|account.a${i}|DisplayName`;
  /** A store with key(0..n-1), French "Avant". */
  const avant = (n: number) => {
    const store = new Store();
    store.add(Array.from({ length: n }, (_, i) => t.slot('attribute', key(i), { 1033: 'Name', 1036: 'Avant' })));
    return store;
  };
  /** The test workbook (book) with its sheet "S" renamed. */
  const named = async (bytes: Uint8Array, name: string) =>
    new File([await zip((await unzip(bytes)).map((p) => (p.name === 'xl/workbook.xml' ? { ...p, data: utf8(new TextDecoder().decode(p.data).replace('name="S"', `name="${name}"`)) } : p)))], 'book.xlsx');
  /** A keyed sheet row: Key in A, the language columns from F on. */
  const keyed = (r: number, k: string, cells: string) => `<row r="${r}">${cell(`A${r}`, k)}${cells}</row>`;
  const err = (ref: string, e: string) => `<c r="${ref}" t="e"><f>1/0</f><v>${e}</v></c>`;
  const changes = (store: Store) => store.changes().map((c) => [c.slot.key, c.lcid, c.after]);
  type Skip = { row: number; key: string; values: Record<number, string>; reason: string };
  const skips = (list: Skip[]) => list.map((s) => [s.row, s.key, s.values]);

  test('xlsx import: a cell holding an Excel error (#DIV/0!, #N/A, #VALUE!: a formula that failed) is reported and never staged; the text "#N/A" typed as text and a formula that worked are staged', async () => {
    const head = `<row r="1">${['Key', 'Type', 'Table', 'Component', 'Property', '1036', '1031'].map((h, i) => cell(`${'ABCDEFG'[i]}1`, h)).join('')}</row>`;
    const bytes = await book(
      head +
        keyed(2, key(0), err('F2', '#DIV/0!')) +
        keyed(3, key(1), err('F3', '#N/A') + cell('G3', 'Hallo')) +
        keyed(4, key(2), cell('F4', '#N/A')) +
        keyed(5, key(3), '<c r="F5" t="str"><f>"Bon"&amp;"jour"</f><v>Bonjour</v></c>') +
        keyed(6, key(4), err('F6', '#VALUE!') + err('G6', '#REF!')),
    );
    const [s] = await readXlsx(new Blob([bytes]));
    eq([s.errors, s.rows[1]?.[5]], [[[1, 5], [2, 5], [5, 5], [5, 6]], '#DIV/0!'], 'listed apart; the cell shows the error as Excel does');
    const store = avant(5);
    const io = createIo();
    const r = io.apply(await io.parse(await named(bytes, 'Other')), store);
    eq(changes(store), [[key(1), 1031, 'Hallo'], [key(2), 1036, '#N/A'], [key(3), 1036, 'Bonjour']]);
    eq([r.staged, skips(r.skipped)], [3, [[2, '', { 1036: '#DIV/0!' }], [3, '', { 1036: '#N/A' }], [6, '', { 1036: '#VALUE!', 1031: '#REF!' }]]]);
    eq(r.skipped[0].reason, 'Not imported: column 1036 holds the Excel error #DIV/0!, not a translation. Correct the cell, then import again');
    eq(r.skipped[2].reason, 'Not imported: columns 1036 and 1031 hold Excel errors (#VALUE!, #REF!), not translations. Correct the cells, then import again');
    // An Easy Translator sheet the same way.
    const et = await book(
      `<row r="1">${['Attribute Id', 'Entity Logical Name', 'Attribute Logical Name', 'Type', '1036'].map((h, i) => cell(`${'ABCDE'[i]}1`, h)).join('')}</row>` +
        `<row r="2">${cell('B2', 'account')}${cell('C2', 'a0')}${cell('D2', 'DisplayName')}${err('E2', '#N/A')}</row>`,
    );
    const store2 = avant(1);
    const r2 = io.apply(await io.parse(await named(et, 'Attributes')), store2);
    eq([r2.staged, skips(r2.skipped), changes(store2)], [0, [[2, '', { 1036: '#N/A' }]], []]);
  });

  test('xlsx: two rows or two cells at one address are a damaged workbook, not a choice between them', async () => {
    for (const [what, xml, says] of [
      ['row twice', `<row r="2">${cell('A2', 'first')}</row><row r="2">${cell('A2', 'last')}</row>`, 'row 2 twice'],
      ['row twice, one without a reference', `<row r="2">${cell('A2', 'a')}</row><row>${cell('A3', 'b')}</row><row r="3">${cell('A3', 'c')}</row>`, 'row 3 twice'],
      ['empty row twice', `<row r="2"/><row r="2">${cell('A2', 'x')}</row>`, 'row 2 twice'],
      ['cell twice', `<row r="1">${cell('F1', 'first')}${cell('F1', 'last')}</row>`, 'cell F1 twice'],
      ['cell twice, one without a reference', `<row r="1">${cell('A1', 'a')}<c t="inlineStr"><is><t>b</t></is></c>${cell('B1', 'c')}</row>`, 'cell B1 twice'],
    ]) {
      const e = await fails(readXlsx(new Blob([await book(xml)])));
      ok(/workbook is damaged/.test(e) && e.includes(says), `${what}: ${e}`);
    }
  });

  test('xlsx: a cell is read at the whole address it gives: one naming another row, or outside the sheet, or not an address, is a damaged workbook naming the sheet (its tab) and the address', async () => {
    const bare = (v: string) => `<c t="inlineStr"><is><t>${v}</t></is></c>`;
    for (const [what, xml, says] of [
      ['cell naming the next row', `<row r="2">${cell('A2', 'a')}${cell('E3', 'b')}</row>`, 'has cell E3 in row 2'],
      ['cell naming an earlier row', `<row r="5">${cell('B4', 'b')}</row>`, 'has cell B4 in row 5'],
      ['one full address under two rows', `<row r="2">${cell('B3', 'first')}</row><row r="3">${cell('B3', 'last')}</row>`, 'has cell B3 in row 2'],
      ['cell naming another row, in a row without a reference', `<row r="1">${cell('A1', 'a')}</row><row>${cell('A3', 'b')}</row>`, 'has cell A3 in row 2'],
      ['row number with leading zeros, compared as a number', `<row r="2">${cell('A02', 'a')}${cell('B003', 'b')}</row>`, 'has cell B3 in row 2'],
      ['cell past row 1,048,576 in a row inside the sheet', `<row r="2">${cell('B1048577', 'x')}</row>`, 'has a cell outside the sheet, at B1048577'],
      ['cell at row 0', `<row r="1">${cell('A0', 'x')}</row>`, 'has a cell outside the sheet, at A0'],
      ['cell past column XFD', `<row r="1">${cell('XFE1', 'x')}</row>`, 'has a cell outside the sheet, at XFE1'],
      ['cell with four column letters', `<row r="1">${cell('AAAA1', 'x')}</row>`, 'has a cell outside the sheet, at AAAA1'],
      ['cell without a reference past XFD', `<row r="1">${cell('XFD1', 'x')}${bare('y')}</row>`, 'has a cell outside the sheet, at XFE1'],
      ['row past 1,048,576', `<row r="1048577">${cell('A1048577', 'x')}</row>`, 'has a row outside the sheet, at row 1048577'],
      ['row 0', `<row r="0"/>`, 'has a row outside the sheet, at row 0'],
      ['row without a reference past 1,048,576', `<row r="1048576"/><row>${bare('x')}</row>`, 'has a row outside the sheet, at row 1048577'],
      ['row "1.5"', `<row r="1.5">${bare('x')}</row>`, 'has a row at "1.5", which is not a row number'],
      ['row "+2"', `<row r="+2">${bare('x')}</row>`, 'has a row at "+2", which is not a row number'],
      ['row " 2"', `<row r=" 2">${bare('x')}</row>`, 'has a row at " 2", which is not a row number'],
      ['row "0x2"', `<row r="0x2">${bare('x')}</row>`, 'has a row at "0x2", which is not a row number'],
      ['cell "3E"', `<row r="1">${cell('3E', 'x')}</row>`, 'has a cell at "3E", which is not a cell address'],
      ['cell "$A$1"', `<row r="1">${cell('$A$1', 'x')}</row>`, 'has a cell at "$A$1", which is not a cell address'],
      ['cell "R1C1"', `<row r="1">${cell('R1C1', 'x')}</row>`, 'has a cell at "R1C1", which is not a cell address'],
      ['cell "A1:B1"', `<row r="1">${cell('A1:B1', 'x')}</row>`, 'has a cell at "A1:B1", which is not a cell address'],
      ['cell "A1 "', `<row r="1">${cell('A1 ', 'x')}</row>`, 'has a cell at "A1 ", which is not a cell address'],
      ['a long reference, cut', `<row r="1">${cell('A'.repeat(30) + '!', 'x')}</row>`, `has a cell at "${'A'.repeat(20)}…", which is not a cell address`],
    ])
      eq(await fails(readXlsx(new Blob([await book(xml)]))), `The workbook is damaged (the S sheet ${says}).`, what);
    // The tab's name, not the part's (Excel keeps part numbers when tabs move); a damaged file's long name is cut;
    // a tab without a name: the part.
    const bad = await book(`<row r="2">${cell('E3', 'b')}</row>`);
    eq(await fails(readXlsx(await named(bad, 'Ribbon Labels'))), 'The workbook is damaged (the Ribbon Labels sheet has cell E3 in row 2).');
    eq(await fails(readXlsx(await named(bad, 'R'.repeat(40)))), `The workbook is damaged (the ${'R'.repeat(31)}… sheet has cell E3 in row 2).`);
    eq(await fails(readXlsx(await named(bad, ''))), `The workbook is damaged (${SHEET} has cell E3 in row 2).`);
    eq(await fails(readXlsx(await named(await book(`<row r="1">${cell('A1', '&bogus;')}</row>`), 'Attributes'))), 'The workbook is damaged (the Attributes sheet could not be read).');
    // What Excel and other tools write still reads: lowercase column letters, a reference giving only the column, none.
    const [s] = await readXlsx(new Blob([await book(`<row r="2">${cell('b2', 'b')}${cell('C', 'c')}${bare('d')}</row><row>${cell('A3', 'a')}</row>`)]));
    eq([s.rows[1]?.[1], s.rows[1]?.[2], s.rows[1]?.[3], s.rows[2]?.[0]], ['b', 'c', 'd', 'a']);
  });
  test('xlsx import: an Easy Translator row whose French cell names the next row (r="E3" inside row 2) is refused before anything is staged, not put on row 2\'s label', async () => {
    // The audit's row-address-mismatch.xlsx: its row 2 names new_dxttest.new_priority, its French cell says E3.
    const head = `<row r="1">${['Attribute Id', 'Entity Logical Name', 'Attribute Logical Name', 'Type', '1036'].map((h, i) => cell(`${'ABCDE'[i]}1`, h)).join('')}</row>`;
    const row2 = `<row r="2">${cell('B2', 'new_dxttest')}${cell('C2', 'new_priority')}${cell('D2', 'DisplayName')}`;
    const store = new Store();
    store.add([t.slot('attribute', 'attribute|new_dxttest.new_priority|DisplayName', { 1033: 'Priority', 1036: 'Priorité' })]);
    const io = createIo();
    const e = await fails(io.parse(await named(await book(`${head}${row2}${cell('E3', 'AUDIT06-ROW-MISMATCH')}</row>`), 'Attributes')).then((p) => io.apply(p, store)));
    eq(e, 'The workbook is damaged (the Attributes sheet has cell E3 in row 2).');
    eq(changes(store), []);
    // The same row with its cell at E2 stages it.
    const r = io.apply(await io.parse(await named(await book(`${head}${row2}${cell('E2', 'Priorité 2')}</row>`), 'Attributes')), store);
    eq([r.staged, changes(store)], [1, [['attribute|new_dxttest.new_priority|DisplayName', 1036, 'Priorité 2']]]);
  });

  test('import: an id matching loaded labels only ignoring case stages that label when it is the only one; when several labels differ only in case (classic ribbon ids), it stages none of them, whichever loaded first, and says why; an exact id stages its own', async () => {
    const [up, low] = ['ribbon|account|new.Button.Label|Label', 'ribbon|account|new.button.label|Label'];
    const io = createIo();
    const csvOf = (k: string) => new File([[`${CSV_KEY},Type,Table,Component,Property,1036`, `${k},,account,,,Traduit`].join('\r\n')], 'labels.csv');
    // The Ribbon Labels sheet (Easy Translator layout) names the label by table and LocLabel Id.
    const sheetOf = async (id: string, ent = 'account') => named(await book(`<row r="1">${cell('A1', 'Entity Logical Name')}${cell('B1', 'LocLabel Id')}${cell('C1', '1036')}</row><row r="2">${cell('A2', ent)}${cell('B2', id)}${cell('C2', 'Traduit')}</row>`), 'Ribbon Labels');
    // The classic ribbon loader keeps both ids.
    const http = {
      all: async (path: string) =>
        path.startsWith('EntityDefinitions')
          ? [{ LogicalName: 'account', DisplayName: { UserLocalizedLabel: { Label: 'Account' } } }]
          : ['new.Button.Label', 'new.button.label'].map((id, i) => ({
              diffid: `d${i}`,
              entity: 'account',
              ismanaged: false,
              difftype: 3,
              rdx: `<LocLabel Id="${id}"><Titles><Title languagecode="1033" description="Name ${i}"/><Title languagecode="1036" description="Avant ${i}"/></Titles></LocLabel>`,
            })),
    };
    const loaded = await loadRibbonLabels({ base: 1033, user: 1033, http } as unknown as Ctx, ['account'], { signal: new AbortController().signal, progress() {} });
    eq(loaded.map((s) => s.key), [up, low]);
    // A keyed CSV row names the label by its key; a Ribbon Labels row by its LocLabel Id, which is what it lists.
    const why = (what: string, a: string, b: string) => `Not imported: the ${what} matches more than one label when case is ignored (${a} and ${b}), and none exactly. Write it exactly as the one it is for, then import again`;
    const said = { 'labels.csv': why('id', up, low), 'book.xlsx': why('LocLabel Id', 'new.Button.Label', 'new.button.label') };
    for (const order of [loaded, [...loaded].reverse()]) {
      const fresh = () => {
        const store = new Store();
        store.add(order.map((s) => ({ ...s, labels: { ...s.labels } })));
        return store;
      };
      for (const file of [csvOf('ribbon|account|NEW.BUTTON.LABEL|Label'), await sheetOf('NEW.BUTTON.LABEL')]) {
        const store = fresh();
        const r = io.apply(await io.parse(file), store);
        eq([r.staged, changes(store), r.skipped.map((s) => [s.row, s.key, s.values, s.reason])], [0, [], [[2, '', { 1036: 'Traduit' }, said[file.name as keyof typeof said]]]], `${file.name}, ${order[0].key} loaded first`);
      }
      for (const k of [up, low])
        for (const file of [csvOf(k), await sheetOf(k.split('|')[2])]) {
          const store = fresh();
          const r = io.apply(await io.parse(file), store);
          eq([r.staged, changes(store), r.skipped], [1, [[k, 1036, 'Traduit']], []], `exact ${k} in ${file.name}, ${order[0].key} loaded first`);
        }
    }
    {
      // The table typed in another case too: no one column tells the labels apart, so the reason lists their keys.
      const store = new Store();
      store.add(loaded.map((s) => ({ ...s, labels: { ...s.labels } })));
      const r = io.apply(await io.parse(await sheetOf('NEW.BUTTON.LABEL', 'Account')), store);
      eq([r.staged, r.skipped.map((s) => s.reason)], [0, [why('id', up, low)]]);
    }
    // Only one label spelled that way: other casing still finds it.
    const store = new Store();
    store.add([{ ...loaded[0], labels: { ...loaded[0].labels } }]);
    const r = io.apply(await io.parse(csvOf('ribbon|account|NEW.BUTTON.LABEL|Label')), store);
    eq([r.staged, changes(store), r.skipped], [1, [[up, 1036, 'Traduit']], []]);
  });

  test('import: two columns for one language refuse the file, naming them, even when they agree', async () => {
    const io = createIo();
    for (const v of ['Deux', 'Un']) {
      const e = await fails(io.parse(new File([[`${CSV_KEY},Type,Table,Component,Property,1036,1033,1036`, `${key(0)},,account,,,Un,Name,${v}`].join('\r\n')], 'labels.csv')));
      eq(e, 'The file has two columns for language 1036 (F and H). Keep one of them, then import again.');
    }
    const head = `<row r="1">${['Key', 'Type', 'Table', 'Component', 'Property', '1036', '1036'].map((h, i) => cell(`${'ABCDEFG'[i]}1`, h)).join('')}</row>`;
    eq(await fails(io.parse(await named(await book(head + keyed(2, key(0), cell('F2', 'Un') + cell('G2', 'Deux'))), 'Other'))), 'Sheet "Other" has two columns for language 1036 (F and G). Keep one of them, then import again.');
  });

  test('import: rows giving one label different texts in a language stage none of them (whichever comes last) and report each with the others; the same text twice is staged once; other languages of those rows are staged', async () => {
    const store = avant(3);
    store.set(key(0), 1036, 'Brouillon'); // a pending edit the conflict must leave alone
    const lines = [
      `${CSV_KEY},Type,Table,Component,Property,1033,1036`,
      `${key(0)},,account,,,Name A,Première`,
      `${key(1)},,account,,,,Même`,
      `${key(0)},,account,,,,Deuxième`,
      `${key(1)},,account,,,,Même`,
      `${key(2)},,account,,,,Un`,
      `${key(2)},,account,,,,Un`,
      `${key(2)},,account,,,,Autre`,
    ];
    const io = createIo();
    const r = io.apply(await io.parse(new File([lines.join('\r\n')], 'labels.csv')), store);
    eq(changes(store), [[key(0), 1036, 'Brouillon'], [key(0), 1033, 'Name A'], [key(1), 1036, 'Même']]);
    eq([r.staged, r.unchanged], [2, 0], 'the repeated identical row is counted once');
    eq(skips(r.skipped), [
      [2, key(0), { 1036: 'Première' }],
      [4, key(0), { 1036: 'Deuxième' }],
      [6, key(2), { 1036: 'Un' }],
      [7, key(2), { 1036: 'Un' }],
      [8, key(2), { 1036: 'Autre' }],
    ]);
    eq(r.skipped[0].reason, 'Not imported: the file has different texts for this label in column 1036 (here and on row 4). Keep one, then import again');
    eq(r.skipped[4].reason, 'Not imported: the file has different texts for this label in column 1036 (here and on rows 6 and 7). Keep one, then import again');
    // Across sheets, the other sheet is named.
    const sheet = (rows: Array<[string, string]>) => `<row r="1">${['Key', 'Type', 'Table', 'Component', 'Property', '1036'].map((h, i) => cell(`${'ABCDEF'[i]}1`, h)).join('')}</row>` + rows.map(([k, v], i) => keyed(i + 2, k, cell(`F${i + 2}`, v))).join('');
    const parts = await unzip(await book(sheet([[key(0), 'Un']])));
    const two = await unzip(await book(sheet([[key(1), 'B'], [key(0), 'Deux']])));
    const wb = parts.find((p) => p.name === 'xl/workbook.xml')!;
    const text = new TextDecoder().decode(wb.data).replace('name="S"', 'name="Other"');
    wb.data = utf8(text.replace('</sheets>', '<sheet name="More" sheetId="9" r:id="rId9"/></sheets>'));
    const rels = parts.find((p) => p.name === 'xl/_rels/workbook.xml.rels')!;
    rels.data = utf8(new TextDecoder().decode(rels.data).replace('</Relationships>', '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/more.xml"/></Relationships>'));
    parts.push({ name: 'xl/worksheets/more.xml', data: two.find((p) => p.name === SHEET)!.data });
    const store2 = avant(2);
    const r2 = io.apply(await io.parse(new File([await zip(parts)], 'book.xlsx')), store2);
    eq([changes(store2), r2.skipped.map((s) => [s.row, s.reason])], [
      [[key(1), 1036, 'B']],
      [
        [2, 'Not imported: the file has different texts for this label in column 1036 (here and on row 3 of More). Keep one, then import again'],
        [3, 'Not imported: the file has different texts for this label in column 1036 (here and on row 2 of Other). Keep one, then import again'],
      ],
    ]);
  });

  // ---- CSV: a quoted field that never closes ----
  test('csv: a quoted field without its closing quote refuses the file, naming the line it starts on, instead of taking the rows after it into one field', async () => {
    eq(await fails(Promise.resolve().then(() => parseCsv('Key,1036\r\na,"Nouveau\r\nb,Deux\r\nc,Trois\r\n'))), 'The CSV file is damaged (the quoted text that starts on line 2 has no closing quote). Check the quotes there, then import again.');
    // Line breaks inside quotes, and LF or CR alone, count as lines.
    eq(await fails(Promise.resolve().then(() => parseCsv('Key,1036\na,"x\ny"\nb,"z'))), 'The CSV file is damaged (the quoted text that starts on line 4 has no closing quote). Check the quotes there, then import again.');
    eq(await fails(Promise.resolve().then(() => parseCsv('Key,1036\ra,b\rc,"d'))), 'The CSV file is damaged (the quoted text that starts on line 3 has no closing quote). Check the quotes there, then import again.');
    // The next quote closes it early: the text after that quote gives it away.
    eq(await fails(Promise.resolve().then(() => parseCsv('Key,1036\r\na,"Nouveau\r\nb,"Deux, trois"\r\n'))), 'The CSV file is damaged (the quoted text that starts on line 2 ends on line 3 with more text after its closing quote). Check the quotes there, then import again.');
    eq(await fails(Promise.resolve().then(() => parseCsv('Key,1036\r\na,"x"y\r\n'))), 'The CSV file is damaged (line 2 has more text after the closing quote of a quoted field). Check the quotes there, then import again.');
    // Well-formed quoting still reads: line breaks and quotes inside, spaces after the closing quote, a quote inside an unquoted field.
    eq(parseCsv('Key,1036\r\na,"ligne 1\r\nligne 2 ""x"""\r\nb,"y" ,z\r\nc,5"\r\n'), [['Key', '1036'], ['a', 'ligne 1\r\nligne 2 "x"'], ['b', 'y ', 'z'], ['c', '5"']]);
    // Through the import: nothing is staged.
    const store = avant(2);
    const io = createIo();
    const e = await fails(io.parse(new File([[`${CSV_KEY},Type,Table,Component,Property,1036`, `${key(0)},,account,,,"Nouveau`, `${key(1)},,account,,,Deux`].join('\r\n')], 'labels.csv')).then((p) => io.apply(p, store)));
    ok(/CSV file is damaged \(the quoted text that starts on line 2 has no closing quote\)/.test(e), e);
    eq(changes(store), []);
  });
}
