// Minimal .xlsx (SpreadsheetML) reader and writer on top of core/zip.ts.
// The writer emits inline strings, so no shared-string table is needed; the reader accepts what
// Excel, EPPlus (Easy Translator) and LibreOffice write: shared strings, inline strings, rich text
// runs, numbers, booleans and cached formula results. A cell holding an Excel error (a formula that failed: #N/A,
// #DIV/0!, …) is listed apart (Sheet.errors), so an import never takes its text for a translation; two rows or two cells
// at one address are a damaged file, not a choice between them, and so is a cell whose address names another row.

import { fromUtf8, openZip, utf8, zip, type ZipFile } from '../core/zip';

export type Cell = string | number | null;
export interface Sheet {
  name: string;
  /** readXlsx returns sparse arrays: a row or cell the file does not hold is a hole (undefined). */
  rows: Cell[][];
  /**
   * readXlsx: the cells holding an Excel error (t="e": #N/A, #DIV/0!, #VALUE!, …), as [row, column] indexes of `rows`,
   * where they hold the error as Excel shows it. That text is not the cell's value: it is never imported as one.
   */
  errors?: Array<[number, number]>;
}
export interface XlsxOptions {
  headerStyle?: boolean;
  freezeHeader?: boolean;
  /** Column widths (characters) per sheet name; computed from the content when absent. */
  colWidths?: Record<string, number[]>;
}

const OX = 'http://schemas.openxmlformats.org/';
const MAIN = OX + 'spreadsheetml/2006/main';
const REL = OX + 'officeDocument/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// Characters XML 1.0 cannot carry are dropped. "_xHHHH_" is Excel's escape syntax, so a literal one
// is protected, and CR is written that way because XML parsers turn CRLF into LF.
const esc = (s: string): string =>
  s
    .replace(/[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/_(?=x[\dA-Fa-f]{4}_)/g, '_x005F_')
    .replace(/[&<>"\r]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\r': '_x000D_' })[c] as string);
const unesc = (s: string): string => s.replace(/_x([\dA-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

export const colName = (i: number): string => (i >= 26 ? colName(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));
function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.toUpperCase()) {
    const k = ch.charCodeAt(0) - 64;
    if (k < 1 || k > 26) break;
    n = n * 26 + k;
  }
  return n - 1;
}

/** Excel sheet names: at most 31 characters, none of : \ / ? * [ ], unique ignoring case, not "History". */
function sheetNames(list: string[]): string[] {
  const used = new Set<string>();
  return list.map((n) => {
    const base = n.replace(/[:\\/?*[\]\x00-\x1f]/g, ' ').slice(0, 31).replace(/^[' ]+|[' ]+$/g, '') || 'Sheet';
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()) || name.toLowerCase() === 'history'; i++) name = `${base.slice(0, 28 - String(i).length)} (${i})`;
    used.add(name.toLowerCase());
    return name;
  });
}

function sheetXml(rows: Cell[][], o: XlsxOptions, widths: number[] | undefined, first: boolean): string {
  const out: string[] = [];
  rows.forEach((row, r) => {
    let cells = '';
    // null = no cell; '' = an empty text cell (some importers treat the two differently).
    row.forEach((v, c) => {
      if (v === null || v === undefined) return;
      const at = `<c r="${colName(c)}${r + 1}"${r === 0 && o.headerStyle ? ' s="1"' : ''}`;
      cells +=
        typeof v === 'number' && Number.isFinite(v)
          ? `${at}><v>${v}</v></c>`
          : `${at} t="inlineStr"><is><t xml:space="preserve">${esc(String(v).slice(0, 32767))}</t></is></c>`;
    });
    if (cells) out.push(`<row r="${r + 1}">${cells}</row>`);
  });
  if (!widths) {
    widths = [];
    for (const row of rows.slice(0, 300)) row.forEach((v, c) => (widths![c] = Math.max(widths![c] || 10, Math.min(60, String(v ?? '').length + 2))));
  }
  const pane = o.freezeHeader ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : '';
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w || 10}" customWidth="1"/>`).join('')}</cols>` : '';
  return `${DECL}<worksheet xmlns="${MAIN}"><sheetViews><sheetView workbookViewId="0"${first ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${out.join('')}</sheetData></worksheet>`;
}

const rel = (id: number, type: string, target: string) => `<Relationship Id="rId${id}" Type="${REL}/${type}" Target="${target}"/>`;
const rels = (body: string) => `${DECL}<Relationships xmlns="${OX}package/2006/relationships">${body}</Relationships>`;
// Style 1 = header: bold on a light blue fill.
const STYLES =
  `${DECL}<styleSheet xmlns="${MAIN}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>` +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

export async function writeXlsx(sheets: Sheet[], o: XlsxOptions = {}): Promise<Blob> {
  if (!sheets.length) sheets = [{ name: 'Sheet1', rows: [] }];
  const names = sheetNames(sheets.map((s) => s.name));
  const parts: Array<[string, string]> = [
    [
      '[Content_Types].xml',
      `${DECL}<Types xmlns="${OX}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="${CT}sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="${CT}styles+xml"/>` +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CT}worksheet+xml"/>`).join('') +
        '</Types>',
    ],
    ['_rels/.rels', rels(rel(1, 'officeDocument', 'xl/workbook.xml'))],
    [
      'xl/workbook.xml',
      `${DECL}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>${names.map((s, i) => `<sheet name="${esc(s)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    ],
    ['xl/_rels/workbook.xml.rels', rels(sheets.map((_, i) => rel(i + 1, 'worksheet', `worksheets/sheet${i + 1}.xml`)).join('') + rel(sheets.length + 1, 'styles', 'styles.xml'))],
    ['xl/styles.xml', STYLES],
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows, o, o.colWidths?.[s.name], i === 0)]),
  ];
  const bytes = await zip(parts.map(([name, xml]) => ({ name, data: utf8(xml) })));
  return new Blob([bytes], { type: CT + 'sheet' });
}

// Namespace-agnostic lookups: strict OOXML and prefixed (x:row) documents use other names.
const all = (n: Document | Element, tag: string): Element[] => Array.from(n.getElementsByTagNameNS('*', tag));
function child(el: Element, tag: string): Element | null {
  let c = el.firstElementChild;
  while (c && c.localName !== tag) c = c.nextElementSibling;
  return c;
}
// Text of a string item: a single <t>, or rich text runs (phonetic hints in rPh excluded).
function text(el: Element): string {
  const t = el.firstElementChild;
  return unesc(
    t?.localName === 't' && !t.nextElementSibling
      ? t.textContent || ''
      : all(el, 't')
          .filter((x) => (x.parentNode as Element).localName !== 'rPh')
          .map((x) => x.textContent || '')
          .join(''),
  );
}
function normPath(p: string): string {
  const out: string[] = [];
  for (const s of p.split('/')) s === '..' ? out.pop() : s && s !== '.' && out.push(s);
  return out.join('/');
}

// What one import may unpack: more than any translation workbook holds, and a file of a few kilobytes can't make
// the tab unpack gigabytes. Only the parts the workbook uses are unpacked (pictures, for one, never are).
const MAX_UNPACKED = 512 * 2 ** 20;

export async function readXlsx(file: Blob): Promise<Sheet[]> {
  const parts = new Map<string, () => Promise<Uint8Array>>();
  let files: ZipFile[];
  try {
    files = openZip(new Uint8Array(await file.arrayBuffer()), MAX_UNPACKED);
  } catch {
    throw new Error('This file is not an Excel workbook (.xlsx). Older .xls files are not supported; save it as .xlsx or .csv and try again.');
  }
  for (const f of files) {
    const k = f.name.replace(/^\/+/, '').toLowerCase();
    // Part names ignore case: two parts with one name are a damaged file, not a choice between them.
    if (parts.has(k)) throw new Error(`The workbook is damaged (it holds ${f.name} twice).`);
    parts.set(k, f.read);
  }
  /** A part as XML; `what` names it in the error when it is damaged (a sheet by its tab's name). */
  const doc = async (path: string, what = path): Promise<Document | null> => {
    const read = parts.get(path.toLowerCase());
    if (!read) return null;
    const d = new DOMParser().parseFromString(fromUtf8(await read()), 'application/xml');
    if (d.getElementsByTagName('parsererror').length) throw new Error(`The workbook is damaged (${what} could not be read).`);
    return d;
  };
  // Relationships of a part: [id, type, resolved target path].
  const relsOf = async (path: string): Promise<Array<[string, string, string]>> => {
    const dir = path.slice(0, path.lastIndexOf('/') + 1);
    const d = await doc(`${dir}_rels/${path.slice(dir.length)}.rels`);
    return d
      ? all(d, 'Relationship').map((r) => {
          const t = r.getAttribute('Target') || '';
          return [r.getAttribute('Id') || '', r.getAttribute('Type') || '', t.startsWith('/') ? t.slice(1) : normPath(dir + t)] as [string, string, string];
        })
      : [];
  };
  const wbPath = (await relsOf('')).find((r) => r[1].endsWith('/officeDocument'))?.[2] || 'xl/workbook.xml';
  const wb = await doc(wbPath);
  if (!wb) throw new Error('This file is not an Excel workbook (.xlsx).');
  const wbRels = await relsOf(wbPath);
  const ss = wbRels.find((r) => r[1].endsWith('/sharedStrings'));
  const ssDoc = await doc(ss ? ss[2] : 'xl/sharedStrings.xml');
  const shared = ssDoc ? all(ssDoc, 'si').map(text) : [];
  const out: Sheet[] = [];
  for (const s of all(wb, 'sheet')) {
    const id = Array.from(s.attributes).find((a) => a.localName === 'id' && a.namespaceURI)?.value;
    const path = wbRels.find((r) => r[0] === id)?.[2];
    const name = s.getAttribute('name') || '';
    // The tab the owner sees, not the part (sheet7.xml): Excel keeps part numbers when tabs move. Excel's names are
    // at most 31 characters; a damaged file's can be any length.
    const what = name ? `the ${name.length > 31 ? `${name.slice(0, 31)}…` : name} sheet` : path || '';
    const d = path ? await doc(path, what) : null;
    out.push({ name, ...(d ? readSheet(d, shared, what) : { rows: [] }) });
  }
  return out;
}

// Excel's grid: 1,048,576 rows by 16,384 columns (A to XFD).
const MAX_ROWS = 1048576;
const MAX_COLS = 16384;

/**
 * The sheet's cells as sparse arrays: one cell far down or far right must not allocate the rows and cells before it.
 * A cell is read at the whole address its reference gives (r="E3": column E, row 3), which must be inside its row: a
 * cell naming another row, a reference that is not a cell address, or one outside the grid is a damaged workbook, never
 * text put on its row's label. Rows and cells without a reference follow the previous ones. `sheet` names the sheet in
 * errors ("the Attributes sheet").
 */
function readSheet(d: Document, shared: string[], sheet: string): Pick<Sheet, 'rows' | 'errors'> {
  const rows: Cell[][] = [];
  const errors: Array<[number, number]> = [];
  const damaged = (what: string) => new Error(`The workbook is damaged (${sheet} ${what}).`);
  // What a damaged file holds there can be any length.
  const cut = (s: string) => (s.length > 20 ? `${s.slice(0, 20)}…` : s);
  const outside = (what: string, at: string) => damaged(`has a ${what} outside the sheet, at ${at}`);
  // Excel writes each row and cell once: a second one at the same address would silently replace the first. A cell is
  // always inside its own row, so its full address is unique once its row and its column within the row are.
  const twice = (what: string) => damaged(`holds ${what} twice`);
  const seen = new Set<number>();
  let r = -1;
  for (const row of all(d, 'row')) {
    const ra = row.getAttribute('r');
    if (ra && !/^\d+$/.test(ra)) throw damaged(`has a row at "${cut(ra)}", which is not a row number`);
    r = ra ? Number(ra) - 1 : r + 1;
    if (r < 0 || r >= MAX_ROWS) throw outside('row', `row ${cut(ra || String(r + 1))}`);
    if (seen.has(r)) throw twice(`row ${r + 1}`);
    seen.add(r);
    const cells: Cell[] = [];
    const at = new Set<number>();
    let c = -1;
    for (let el = row.firstElementChild; el; el = el.nextElementSibling) {
      if (el.localName !== 'c') continue;
      const ref = el.getAttribute('r');
      if (ref) {
        // Column letters, then the row number (a reference giving only the column takes its row's).
        const m = /^([A-Z]+)(\d*)$/i.exec(ref);
        if (!m) throw damaged(`has a cell at "${cut(ref)}", which is not a cell address`);
        c = m[1].length > 3 ? MAX_COLS : colIndex(m[1]);
        const n = m[2] ? Number(m[2]) : r + 1;
        if (c >= MAX_COLS || n < 1 || n > MAX_ROWS) throw outside('cell', cut(ref.toUpperCase()));
        if (n !== r + 1) throw damaged(`has cell ${colName(c)}${n} in row ${r + 1}`);
      } else if (++c >= MAX_COLS) throw outside('cell', `${colName(c)}${r + 1}`);
      if (at.has(c)) throw twice(`cell ${colName(c)}${r + 1}`);
      at.add(c);
      const t = el.getAttribute('t');
      const v = child(el, 'v')?.textContent ?? null;
      let val: Cell = null;
      if (t === 'inlineStr') {
        const is = child(el, 'is');
        val = is ? text(is) : null;
      } else if (v === null) val = null;
      else if (t === 's') val = shared[Number(v)] ?? null;
      else if (t === 'b') val = v.trim() === '1' ? 'TRUE' : 'FALSE';
      else if (t === 'str' || t === 'e' || t === 'd') val = unesc(v);
      else if (v.trim()) val = Number.isNaN(Number(v)) ? v : Number(v);
      // Formatted but empty cells and rows (e.g. a styled row 1048576) must not grow the grid.
      if (val !== null) {
        cells[c] = val;
        if (t === 'e' && v?.trim()) errors.push([r, c]);
      }
    }
    if (cells.length) rows[r] = cells;
  }
  return errors.length ? { rows, errors } : { rows };
}
