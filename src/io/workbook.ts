// Workbook and CSV import/export (IoApi).
//
// The sheets up to "Dashboards Fields" reproduce the XrmToolBox Easy Translator layout exactly (sheet
// names, headers, column order, {B} ids, LCID headers as text), so files move freely between the two
// tools. Kinds Easy Translator lacks get sheets of their own after those, a slot that fits no sheet goes
// to "Other" by slot key, and a final "Translator" sheet marks our files (our CSV: its Key header, CSV_KEY).
// Missing translations are empty cells (empty text in the choice sheets, see Spec.b); on import, empty cells
// never clear a label, and a cell holding an Excel error (a failed formula) is reported, never staged.
// A file that gives one label two different texts in a language (two rows, from a merge or an edit) stages neither:
// which one is meant is not known, so both are reported. Two columns for one language refuse the file. An id matches
// its label exactly, else ignoring case only when that finds one label (classic ribbon ids can differ only in case).
// Importing only stages edits, it never saves.

import type { Ctx } from '../core/context';
import { isLogicalName } from '../core/http';
import { KIND_NAMES, MANAGED, PROP_NAMES, isManaged, type Kind, type Lcid, type Prop, type Slot } from '../core/model';
import type { Store } from '../core/store';
import { normId } from '../core/xml';
import type { ImportResult, IoApi, ParsedImport } from '../ui/types';
import { parseCsv, toCsv, unguard } from './csv';
import { colName, readXlsx, writeXlsx, type Cell, type Sheet } from './xlsx';

type Get = (col: string) => string;
interface Ex {
  /** First non-empty label (in export language order) of an exported slot; '' when absent. */
  nm(key: string): string;
  ref(key: string): any;
  form(s: Slot, q: string[]): Cell;
}
interface Ix {
  find(key: string): string;
  opt(e: string, a: string, v: string, p: Prop): string;
  nn(id: string, name: string, entity: string): string;
}
interface Spec {
  /** Sheet name. */
  n: string;
  /** Identifier columns before the language columns ('Type' last when `t` is set). */
  c: string[];
  /** Slot kinds exported to this sheet. */
  k: Kind[];
  /** Type column vocabulary; without it the sheet holds 'Label' only. */
  t?: Prop[];
  /**
   * Missing translations are '' instead of no cell: Easy Translator's choice importers stop at the first
   * missing cell (OptionSets, Global OptionSets) or crash on it (Booleans), but skip empty text.
   */
  b?: 1;
  /** Identifier cells of a slot (q = slot.comp split on '|'), or null when it does not belong here. */
  o(s: Slot, q: string[], x: Ex): Cell[] | null;
  /** Slot key of an imported row ('' when it cannot be built). */
  m(g: Get, p: Prop, ix: Ix): string;
}
/** One imported row (ParsedImport.rows). spec -1 = keyed row ("Other" sheet or our CSV). */
interface Raw {
  sheet: string;
  row: number;
  spec: number;
  id: Record<string, string>;
  values: Record<number, string>;
  prop: Prop;
  reason: string;
  /** A keyed CSV that doesn't say it is ours (CSV_KEY): read literally, but never staged where only a guard apostrophe differs. */
  lit?: 1;
}

const ENT = 'Entity Logical Name';
const INFO = 'Translator';
const KEYC = ['Key', 'Type', 'Table', 'Component', 'Property'];
/**
 * The Key column's header in our CSV export, which marks the file as ours: only such a file comes from toCsv, whose
 * apostrophe before text starting like a formula is its own (removed again on import). Excel keeps it as the text
 * of a header cell; Easy Translator reads no CSV.
 */
export const CSV_KEY = 'Key (Dynamics Translator CSV)';
const LABEL: Prop[] = ['Label'];
const NAME: Prop[] = ['Name', 'Description'];
const LBL: Prop[] = ['Label', 'Description'];
const RANK = 'DisplayName DisplayCollectionName Label Name Title ToolTipTitle ToolTipDescription Alt Description Hint'.split(' ');
// Easy Translator's names for savedquery.querytype and systemform.type (informational columns).
const VIEW: Record<number, string> = { 0: 'Public view', 1: 'Advanced Search view', 2: 'Associated view', 4: 'Quick Find Search view', 64: 'Lookup view' };
const FORM: Record<number, string> = { 2: 'Main', 6: 'Quick View Form', 7: 'Quick Create', 11: 'Card', 12: 'Main - Interactive experience' };

const nz = (v: unknown): Cell => (v === undefined || v === null || v === '' ? null : typeof v === 'number' ? v : String(v));
const B = (id: unknown): Cell => (id ? `{${normId(String(id))}}` : null);
const str = (v: Cell | undefined): string => (v === null || v === undefined ? '' : String(v));
const cmp = <T extends string | number>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);
const rest = (q: string[]) => q.slice(2).join('|');
const ea = (q: string[]): string[] => {
  const [e, a = ''] = q[1].split('.');
  return [e, a];
};
const rec = (kind: string, col: string) => (g: Get, p: Prop) => `${kind}|${normId(g(col))}|${p}`;
const opt = (g: Get, p: Prop, ix: Ix) => ix.opt(g(ENT), g('Attribute Logical Name'), g('Value'), p);
/** "a", "a and b", "a, b and c"; past five, the first four and how many more. */
const and = (xs: string[]): string => {
  if (xs.length > 5) xs = [...xs.slice(0, 4), `${xs.length - 4} more`];
  return xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs.join('');
};

// Forms (d = '') and dashboards (d = 'd': kinds dtab/dsection/dfield, no table column) share a layout.
function xmlSheets(p: string, d: string): Spec[] {
  const fc = [...(d ? [] : [ENT]), 'Form Name', 'Form Unique Id', 'Form Id'];
  // formidunique is not loaded; Easy Translator only requires the column to be filled.
  const head = (s: Slot, q: string[], x: Ex): Cell[] => [B(rest(q)), ...(d ? [] : [s.entity]), x.form(s, q), B(q[1]), B(q[1])];
  // Easy Translator writes the tab and section labels here and skips field rows without them, so
  // header/footer cells get the area. Paths are [table (or "Dashboards"), form, tab, section].
  const tab = (s: Slot) => nz(s.path[2] || s.ref?.tabName || s.ref?.area);
  const sec = (s: Slot) => nz(s.path[3] || s.ref?.sectionName || s.ref?.area);
  const m = (k: string, col: string) => (g: Get) => `${d}${k}|${normId(g('Form Id'))}|${normId(g(col))}|Label`;
  return [
    { n: `${p} Tabs`, c: ['Tab Id', ...fc], k: [`${d}tab` as Kind], o: head, m: m('tab', 'Tab Id') },
    { n: `${p} Sections`, c: ['Section Id', ...fc, 'Tab Name'], k: [`${d}section` as Kind], o: (s, q, x) => [...head(s, q, x), tab(s)], m: m('section', 'Section Id') },
    {
      n: `${p} Fields`,
      c: ['Label Id', ...fc, 'Tab Name', 'Section Name', 'Attribute', ...(d ? [] : ['Display name'])],
      k: [`${d}field` as Kind],
      o: (s, q, x) => [...head(s, q, x), tab(s), sec(s), nz(s.ref?.controlId), x.nm(`attribute|${s.entity}.${s.ref?.datafield}|DisplayName`) || nz(s.title || s.ref?.controlId)],
      m: m('field', 'Label Id'),
    },
  ];
}

const LV = ['Area', 'Group', 'SubArea'];
const sitemapSheets = LV.map(
  (lv, i): Spec => ({
    n: `SiteMap ${lv}s`,
    c: ['SiteMap Name', 'SiteMap Id', ...LV.slice(0, i + 1).map((l) => `${l} Id`), 'Type'],
    k: [lv.toLowerCase() as Kind],
    t: ['Title', 'Description'],
    // Easy Translator finds groups and subareas through their parents (ref.areaId / ref.groupId) and
    // skips rows where those are empty; our importer only needs the element's own id. Items without a
    // unique Id (comp suffixed "|#n") go to "Other": Easy Translator aborts its import on an unknown Id.
    o: (s, q) => (q.length > 3 ? null : [nz(s.ref?.sitemapName || s.path[0]) ?? normId(q[1]), normId(q[1]), ...[s.ref?.areaId, s.ref?.groupId].slice(0, i), q[2]]),
    m: (g, p) => `${lv.toLowerCase()}|${normId(g('SiteMap Id'))}|${g(`${lv} Id`)}|${p}`,
  }),
);

const bpfSheet = (lv: string): Spec => ({
  n: `BPF ${lv}s`,
  c: ['Process Id', ENT, 'Process Name', `${lv} Id`, 'Attribute'].slice(0, lv === 'Step' ? 5 : 4),
  k: [lv.toLowerCase() as Kind],
  o: (s, q, x) => [B(q[1]), nz(s.entity), x.nm(`bpf|${q[1]}|Name`) || nz(s.path[0]), B(rest(q)), nz(s.ref?.attribute)],
  m: (g) => `${lv.toLowerCase()}|${normId(g('Process Id'))}|${normId(g(`${lv} Id`))}|Label`,
});

const SPECS: Spec[] = [
  {
    n: 'Entities',
    c: ['Entity Id', ENT, 'Type'],
    k: ['entity'],
    t: ['DisplayName', 'DisplayCollectionName', 'Description'],
    o: (s, q) => [B(s.ref?.metadataId), q[1]],
    m: (g, p) => `entity|${g(ENT)}|${p}`,
  },
  {
    n: 'Attributes',
    c: ['Attribute Id', ENT, 'Attribute Logical Name', 'Type'],
    k: ['attribute'],
    t: ['DisplayName', 'Description'],
    o: (s, q) => [B(s.ref?.metadataId), ...ea(q)],
    m: (g, p) => `attribute|${g(ENT)}.${g('Attribute Logical Name')}|${p}`,
  },
  {
    n: 'Relationships',
    c: ['Entity', 'Relationship Id', 'Relationship Name', 'Relationship entity'],
    k: ['relationship'],
    o: (s, q) => (q.length > 2 ? null : [nz(s.ref?.referenced), B(s.ref?.metadataId), q[1], nz(s.ref?.referencing)]),
    m: (g) => `relationship|${g('Relationship Name')}|Label`,
  },
  // One row per N:N side. Easy Translator cannot address the second side of a self-referential
  // relationship, so that one goes to "Other".
  {
    n: 'RelationshipsNN',
    c: ['Entity', 'Relationship Id', 'Relationship Intersect Entity'],
    k: ['relationship'],
    o: ({ ref: r }, q) => (q.length < 3 || (q[2] === '2' && r?.entity1 === r?.entity2) ? null : [nz(q[2] === '2' ? r?.entity2 : r?.entity1), B(r?.metadataId), r?.intersect || q[1]]),
    m: (g, _, ix) => ix.nn(g('Relationship Id'), g('Relationship Intersect Entity'), g('Entity')),
  },
  // The global choice's own name and description are rows without a Value (Easy Translator skips them).
  {
    n: 'Global OptionSets',
    c: ['OptionSet Id', 'OptionSet Name', 'Value', 'Type'],
    k: ['globaloptionset', 'globaloption'],
    t: ['Label', 'Description', 'DisplayName'],
    b: 1,
    o: (s, q, x) => [B(q[2] === undefined ? s.ref?.metadataId : (x.ref(`globaloptionset|${q[1]}|DisplayName`)?.metadataId ?? s.ref?.setId)) ?? q[1], q[1], q[2] === undefined ? null : +q[2]],
    m: (g, p) => (g('Value') ? `globaloption|${g('OptionSet Name')}|${+g('Value')}|${p}` : `globaloptionset|${g('OptionSet Name')}|${p}`),
  },
  {
    n: 'OptionSets',
    c: ['Attribute Id', ENT, 'Attribute Logical Name', 'Attribute Type', 'Value', 'Type'],
    k: ['option', 'state', 'status'],
    t: LBL,
    b: 1,
    o: (s, q) => [B(s.ref?.attributeMetadataId), ...ea(q), s.kind === 'option' ? 'Picklist' : s.kind === 'state' ? 'State' : 'Status', +q[2]],
    m: opt,
  },
  {
    n: 'Booleans',
    c: ['Attribute Id', ENT, 'Attribute Logical Name', 'Value', 'Type'],
    k: ['boolean'],
    t: LBL,
    b: 1,
    o: (s, q) => [B(s.ref?.attributeMetadataId), ...ea(q), +q[2]],
    m: opt,
  },
  { n: 'Views', c: ['View Id', ENT, 'ViewType', 'Type'], k: ['view'], t: NAME, o: (s, q) => [B(q[1]), s.entity, nz(VIEW[s.ref?.type] ?? s.ref?.type)], m: rec('view', 'View Id') },
  { n: 'Charts', c: ['Chart Id', ENT, 'Type'], k: ['chart'], t: NAME, o: (s, q) => [B(q[1]), s.entity], m: rec('chart', 'Chart Id') },
  {
    n: 'Forms',
    c: ['Form Unique Id', 'Form Id', ENT, 'Form Type', 'Type'],
    k: ['form'],
    t: NAME,
    o: (s, q) => [B(q[1]), B(q[1]), s.entity, nz(FORM[s.ref?.type] ?? s.ref?.type)],
    m: rec('form', 'Form Id'),
  },
  ...xmlSheets('Forms', ''),
  ...sitemapSheets,
  { n: 'Dashboards', c: ['Form Unique Id', 'Form Id', 'Type'], k: ['dashboard'], t: NAME, o: (_, q) => [B(q[1]), B(q[1])], m: rec('dashboard', 'Form Id') },
  ...xmlSheets('Dashboards', 'd'),
  // Kinds Easy Translator does not cover.
  {
    n: 'Form Navigation',
    c: ['Item Id', ENT, 'Form Name', 'Form Id'],
    k: ['navitem'],
    o: (s, q, x) => [rest(q), s.entity, x.form(s, q), B(q[1])],
    m: (g) => `navitem|${normId(g('Form Id'))}|${g('Item Id')}|Label`,
  },
  { n: 'Apps', c: ['App Id', 'Unique Name', 'Type'], k: ['app'], t: NAME, o: (s, q) => [B(q[1]), nz(s.sub)], m: rec('app', 'App Id') },
  { n: 'Business Process Flows', c: ['Process Id', ENT, 'Type'], k: ['bpf'], t: NAME, o: (s, q) => [B(q[1]), nz(s.entity)], m: rec('bpf', 'Process Id') },
  bpfSheet('Stage'),
  bpfSheet('Step'),
  {
    n: 'Commands',
    c: ['Command Id', 'Location', ENT, 'Type'],
    k: ['command'],
    t: ['Label', 'ToolTipTitle', 'ToolTipDescription', 'Alt', 'Title'],
    o: (s, q) => [B(q[1]), nz(s.sub), nz(s.entity)],
    m: rec('command', 'Command Id'),
  },
  { n: 'Ribbon Labels', c: [ENT, 'LocLabel Id'], k: ['ribbon'], o: (_, q) => [q[1], rest(q)], m: (g) => `ribbon|${g(ENT)}|${g('LocLabel Id')}|Label` },
  {
    n: 'Environment Variables',
    c: ['Variable Id', 'Schema Name', 'Type'],
    k: ['envvar'],
    t: ['DisplayName', 'Description', 'Hint'],
    o: (s, q) => [B(q[1]), nz(s.sub)],
    m: rec('envvar', 'Variable Id'),
  },
  { n: 'Custom APIs', c: ['Custom API Id', 'Unique Name', 'Type'], k: ['customapi'], t: ['DisplayName', 'Description'], o: (s, q) => [B(q[1]), nz(s.sub)], m: rec('customapi', 'Custom API Id') },
];

// ---- Export ----

const vals = (s: Slot, langs: Lcid[], blank: Cell = null): Cell[] => langs.map((l) => s.labels[l] || blank);
const keyRow = (s: Slot): Cell[] => [s.key, KIND_NAMES[s.kind]?.[0] ?? s.kind, nz(s.entity), nz([...s.path, s.title].filter(Boolean).join(' › ')), PROP_NAMES[s.prop] ?? s.prop];

/** Table, then container (comp without its last segment), then natural order, then property. */
function sorted(slots: Slot[]): Slot[] {
  return slots
    .map((s) => ({ s, p: s.comp.slice(0, s.comp.lastIndexOf('|')), r: RANK.indexOf(s.prop) }))
    .sort((a, b) => cmp(a.s.entity || '', b.s.entity || '') || cmp(a.p, b.p) || cmp(a.s.order || 0, b.s.order || 0) || cmp(a.s.comp, b.s.comp) || a.r - b.r)
    .map((d) => d.s);
}

function layout(slots: Slot[], langs: Lcid[]): Sheet[] {
  const byKey = new Map(slots.map((s) => [s.key, s]));
  const nm = (k: string): string => {
    const s = byKey.get(k);
    for (const l of langs) if (s?.labels[l]) return s.labels[l];
    return '';
  };
  const x: Ex = {
    nm,
    ref: (k) => byKey.get(k)?.ref,
    form: (s, q) => nm(`${s.kind[0] === 'd' ? 'dashboard' : 'form'}|${q[1]}|Name`) || nz(s.path[1]) || B(q[1]),
  };
  const lc = langs.map(String);
  const out: Sheet[] = SPECS.map((sp) => ({ name: sp.n, rows: [[...sp.c, ...lc]] }));
  const other: Sheet = { name: 'Other', rows: [[...KEYC, ...lc]] };
  for (const s of sorted(slots)) {
    const q = s.comp.split('|');
    let row: Cell[] | null = null;
    for (let i = 0; i < SPECS.length && !row; i++) {
      const sp = SPECS[i];
      if (!sp.k.includes(s.kind) || !(sp.t || LABEL).includes(s.prop)) continue;
      let ids: Cell[] | null;
      try {
        ids = sp.o(s, q, x);
      } catch {
        ids = null; // unexpected ref shape: the slot still goes out through "Other"
      }
      const n = sp.c.length - (sp.t ? 1 : 0);
      // Missing ids stay empty cells (never ''), so Easy Translator skips such rows instead of failing on them.
      if (ids) out[i].rows.push((row = [...Object.assign(new Array<Cell>(n).fill(null), ids.slice(0, n).map(nz)), ...(sp.t ? [s.prop] : []), ...vals(s, langs, sp.b ? '' : null)]));
    }
    if (!row) other.rows.push([...keyRow(s), ...vals(s, langs)]);
  }
  return [...out, other].filter((sh) => sh.rows.length > 1);
}

// ---- Import ----

/** The header row names our CSV export's Key column (CSV_KEY): it is then called Key, as in any keyed sheet. */
function mine(grid: Cell[][]): boolean {
  const head = grid[0] || [];
  const i = Array.from(head, (h) => str(h).trim().toLowerCase()).indexOf(CSV_KEY.toLowerCase());
  if (i < 0) return false;
  head[i] = 'Key';
  return true;
}

async function parse(file: File): Promise<ParsedImport> {
  const rows: Raw[] = [];
  const languages = new Set<Lcid>();
  const entities = new Set<string>();
  const kinds = new Set<Kind>();
  let known = false;
  let ours = false;
  /** A row of a global choice (the Global OptionSets sheet, or a Key naming one). */
  let globals = false;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const csv = !(bytes[0] === 0x50 && bytes[1] === 0x4b) && !/\.xls[xm]?$/i.test(file.name);

  /** `errs`: the sheet's cells holding an Excel error (Sheet.errors). */
  const read = (sheet: string, grid: Cell[][], si: number, lit = false, errs: Sheet['errors'] = []) => {
    known = true;
    const sp = SPECS[si] as Spec | undefined;
    const cols = sp ? sp.c : KEYC;
    // Sheets read from a workbook are sparse (io/xlsx.ts): an empty header cell is a hole, which this fills.
    const head = Array.from(grid[0] || [], (h) => str(h).trim());
    const lc: Array<[number, Lcid]> = [];
    head.forEach((h, i) => /^\d{4,5}$/.test(h) && lc.push([i, +h]));
    // Two columns for one language: which one holds the translation is not known, and either could silently win.
    for (const [i, l] of lc) {
      const j = lc.find(([, m]) => m === l)![0];
      if (j !== i)
        throw new Error(`${csv ? 'The file' : `Sheet "${sheet}"`} has two columns for language ${l} (${colName(j)} and ${colName(i)}). Keep one of them, then import again.`);
    }
    for (const [, l] of lc) languages.add(l);
    const failed = new Set(errs.map(([r, c]) => `${r}:${c}`));
    // Columns by header text; Easy Translator sheets fall back to the column position (its importer is positional).
    const at = cols.map((c, i) => {
      const j = head.findIndex((h) => h.toLowerCase() === c.toLowerCase());
      return j >= 0 || !sp || lc.some(([k]) => k === i) ? j : i;
    });
    for (let r = 1; r < grid.length; r++) {
      const cells = grid[r] || [];
      const values: Record<number, string> = {};
      // An Excel error (#N/A, #DIV/0!, … a formula that failed) is not a translation: reported, never staged.
      const excel: Array<[Lcid, string]> = [];
      for (const [c, l] of lc) {
        if (failed.has(`${r}:${c}`)) excel.push([l, str(cells[c])]);
        else if (str(cells[c])) values[l] = str(cells[c]);
      }
      if (excel.length) {
        const [ls, es] = [excel.map((x) => String(x[0])), excel.map((x) => x[1])];
        const reason =
          excel.length === 1
            ? `Not imported: column ${ls[0]} holds the Excel error ${es[0]}, not a translation. Correct the cell, then import again`
            : `Not imported: columns ${and(ls)} hold Excel errors (${es.join(', ')}), not translations. Correct the cells, then import again`;
        rows.push({ sheet, row: r + 1, spec: si, id: {}, values: Object.fromEntries(excel), prop: 'Label', reason });
      }
      if (!Object.keys(values).length) continue; // no translations on this row: nothing to stage
      const id: Record<string, string> = {};
      cols.forEach((c, i) => (id[c] = at[i] < 0 ? '' : str(cells[at[i]]).trim()));
      const t = id.Type?.toLowerCase();
      const prop = sp?.t ? sp.t.find((p) => p.toLowerCase() === t || PROP_NAMES[p].toLowerCase() === t) : 'Label';
      const e = (id[ENT] || id.Entity || id.Table || '').toLowerCase();
      const table = !!e && e[0] !== '_' && e !== 'none';
      // The table is read by its name (core/http isLogicalName): a cell that isn't a logical name is never loaded.
      const bad = table && !isLogicalName(e) ? `Not a table's logical name: "${e.slice(0, 80)}"` : '';
      rows.push({ sheet, row: r + 1, spec: si, id, values, prop: prop || 'Label', reason: bad || (prop ? '' : `Unknown Type "${id.Type}"`), ...(lit ? { lit: 1 as const } : {}) });
      if (table && !bad) entities.add(e);
      const k = (sp ? sp.k : [id.Key.split('|')[0]]) as Kind[];
      for (const kind of k) if (Object.hasOwn(KIND_NAMES, kind)) kinds.add(kind);
      if (k.includes('globaloptionset') || k.includes('globaloption')) globals = true;
      // Choice columns may be bound to a global choice in this environment.
      if (sp?.m === opt) kinds.add('globaloption');
    }
  };

  if (csv) {
    // UTF-8 (with or without BOM), UTF-16 ("Unicode Text" from Excel), else ANSI ("CSV (Comma delimited)").
    let text: string;
    try {
      text = new TextDecoder(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : 'utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder('windows-1252').decode(bytes);
    }
    const grid = parseCsv(text, false);
    const head = (grid[0] || []).map((h) => h.trim().toLowerCase());
    const own = mine(grid);
    // Ours has a Key column; otherwise the Easy Translator sheet whose columns it has (the most specific one;
    // legacy "Forms Fields" lack "Display name" and would otherwise pass for "Dashboards Fields").
    let si = own || head.includes('key') ? -1 : -2;
    if (si === -2)
      SPECS.forEach((sp, i) => {
        if (sp.c.every((c) => c === 'Display name' || head.includes(c.toLowerCase())) && (si < 0 || sp.c.length > SPECS[si].c.length)) si = i;
      });
    if (si === -2) throw new Error('This CSV file has no "Key" column and does not match an Easy Translator sheet, so it cannot be imported.');
    // Only our export (its Key header says so) comes from toCsv, which puts an apostrophe before text that starts like a
    // formula. In any other CSV (another tool's, a sheet saved by Excel, or an export of ours from before that header)
    // a leading apostrophe is text; a keyed one, which may be such an older export, never stages that apostrophe alone.
    read(si >= 0 ? SPECS[si].n : file.name, own ? grid.map((r) => r.map(unguard)) : grid, si, !own && si < 0);
  } else {
    const sheets = await readXlsx(file);
    // Our workbook has its Translator sheet. A keyed sheet of any other workbook may be an older CSV export of ours that
    // Excel saved as a workbook, apostrophes kept: like that CSV, it never stages the export's apostrophe alone (lit).
    const book = sheets.some((sh) => sh.name === INFO);
    for (const sh of sheets) {
      if (sh.name === INFO) {
        ours = true;
        continue;
      }
      const si = SPECS.findIndex((sp) => sp.n === sh.name);
      // Our CSV export saved as a workbook by Excel keeps its header and its apostrophes.
      const own = si < 0 && mine(sh.rows);
      if (si >= 0 || own || (sh.rows[0] || []).some((h) => str(h).trim().toLowerCase() === 'key'))
        read(sh.name, own ? sh.rows.map((r) => Array.from(r, (c) => (typeof c === 'string' ? unguard(c) : c))) : sh.rows, si, !own && si < 0 && !book, sh.errors);
      else if (sh.rows.length > 1) rows.push({ sheet: sh.name, row: 1, spec: -1, id: {}, values: {}, prop: 'Label', reason: 'Unknown sheet (ignored)' });
    }
  }
  if (!known) throw new Error('Nothing to import: the file has no sheets in the Easy Translator or Translator layout.');
  return {
    format: csv ? 'csv' : ours ? 'translator' : 'easy-translator',
    fileName: file.name,
    languages: [...languages],
    rows,
    // A Global OptionSets sheet can list global choices none of the file's tables use: load every global choice
    // (as the Workbench's Global OptionSets option does), else their rows would be skipped as not matched. Read-only
    // labels too (a managed solution's, most of a system table's): loaded, their rows are skipped with the reason
    // (apply), never as "No matching component"; the Workbench still shows them only when read-only labels were asked for.
    scope: { entities: [...entities], kinds, allGlobals: globals, includeReadOnly: true },
  };
}

/** An id that matches no loaded label exactly and several of them ignoring case (`keys`): which one is meant is not known. */
class Ambiguous extends Error {
  constructor(readonly keys: string[]) {
    super('ambiguous');
  }
}

/**
 * Why row `r` is skipped when its id matches several labels only ignoring case (`keys`), in the row's own terms: on a
 * sheet, the column whose text matches a part of each key only ignoring case and each label's text there (the
 * LocLabel Id, not the key behind it); in a keyed file (or when no one column tells them apart), the keys, as its Key
 * column holds them.
 */
function ambiguous(r: Raw, keys: string[]): string {
  let what = 'id',
    ids = keys;
  if (r.spec >= 0) {
    const parts = keys.map((k) => k.split('|'));
    const same = (p: string, v: string) => p.toLowerCase() === v.toLowerCase();
    const cols = SPECS[r.spec].c.filter((c) => r.id[c] && parts.some((ps) => ps.some((p) => p !== r.id[c] && same(p, r.id[c]))));
    const each = cols.length === 1 ? parts.map((ps) => ps.find((p) => same(p, r.id[cols[0]])) ?? '') : [];
    if (each.length && each.every(Boolean) && new Set(each).size === keys.length) [what, ids] = [cols[0], each];
  }
  return `Not imported: the ${what} matches more than one label when case is ignored (${and(ids)}), and none exactly. Write it exactly as the one it is for, then import again`;
}

function indexStore(store: Store): Ix {
  const lower = new Map<string, string>();
  /** Lowercase key → the loaded keys spelled that way but for case, when there are several (classic ribbon ids can be). */
  const cased = new Map<string, string[]>();
  const usedBy = new Map<string, string>();
  const rel = new Map<string, Slot[]>();
  const put = (k: string, s: Slot) => k && rel.set(k, [...(rel.get(k) || []), s]);
  for (const [k, s] of store.slots) {
    const f = k.toLowerCase();
    const had = lower.get(f);
    if (had === undefined) lower.set(f, k);
    else (cased.get(f) ?? cased.set(f, [had]).get(f)!).push(k);
    const q = s.comp.split('|');
    if (s.kind === 'globaloption') for (const u of s.ref?.usedBy || []) usedBy.set(String(u).toLowerCase(), q[1]);
    if (s.kind === 'relationship' && q.length > 2) {
      put(normId(s.ref?.metadataId), s);
      put(String(s.ref?.intersect || q[1]).toLowerCase(), s);
    }
  }
  // Exact key first; ids typed by hand or by other tools may differ in case. Ignoring case, a key must match one label
  // only: of several, the one taken would be whichever loaded last.
  const find = (k: string) => {
    if (store.slots.has(k)) return k;
    const f = k.toLowerCase();
    const several = cased.get(f);
    if (several) throw new Ambiguous([...several].sort(cmp));
    return lower.get(f) || '';
  };
  return {
    find,
    opt(e, a, v, p) {
      if (!v || Number.isNaN(+v)) return '';
      for (const k of ['option', 'status', 'state', 'boolean']) {
        const f = find(`${k}|${e}.${a}|${+v}|${p}`);
        if (f) return f;
      }
      const set = usedBy.get(`${e}.${a}`.toLowerCase());
      return set ? find(`globaloption|${set}|${+v}|${p}`) : '';
    },
    nn(id, name, entity) {
      const e = entity.toLowerCase();
      const hit = [...(rel.get(normId(id)) || []), ...(rel.get(name.toLowerCase()) || [])]
        .sort((a, b) => cmp(a.comp, b.comp)) // side 1 first, as Easy Translator does for self-referential ones
        .find((s) => String(s.comp.endsWith('|2') ? s.ref?.entity2 : s.ref?.entity1).toLowerCase() === e);
      return hit ? hit.key : '';
    },
  };
}

/**
 * Stages the values of `parsed.languages` only, so the caller can drop languages first. With `inst`
 * (provisioned languages) values in other languages are skipped instead of staged for a failing save.
 */
function apply(parsed: ParsedImport, store: Store, inst?: Set<Lcid>): ImportResult {
  const res: ImportResult = { staged: 0, unchanged: 0, skipped: [] };
  const use = new Set(parsed.languages);
  const ix = indexStore(store);
  const rows = parsed.rows as Raw[];
  /** Row index → why its id names no label for sure (it matches several only ignoring case). */
  const unsure = new Map<number, string>();
  const keys = rows.map((r, i) => {
    if (r.reason) return '';
    try {
      return ix.find(r.spec < 0 ? r.id.Key : SPECS[r.spec].m((c) => r.id[c] || '', r.prop, ix));
    } catch (e) {
      if (e instanceof Ambiguous) unsure.set(i, ambiguous(r, e.keys));
      return '';
    }
  });
  // Rows giving one label a text in the same language, found before anything is staged: the same text counts once (its
  // first row); different texts stage none of them, whichever row comes last, and each such row is reported with the others.
  const by = new Map<string, number[]>();
  rows.forEach((r, i) => {
    if (!store.get(keys[i])) return;
    for (const l of Object.keys(r.values)) {
      if (!use.has(+l)) continue;
      const k = `${keys[i]}\n${l}`;
      (by.get(k) ?? by.set(k, []).get(k)!).push(i);
    }
  });
  /** Row index → language → why it is not staged ('' = the same text as an earlier row: not reported). */
  const drop = new Map<number, Map<Lcid, string>>();
  for (const [k, list] of by) {
    if (list.length < 2) continue;
    const l = +k.slice(k.lastIndexOf('\n') + 1);
    const same = list.every((i) => rows[i].values[l] === rows[list[0]].values[l]);
    for (const i of same ? list.slice(1) : list) {
      const others = list.filter((j) => j !== i);
      const near = others.filter((j) => rows[j].sheet === rows[i].sheet).map((j) => String(rows[j].row));
      const far = others.filter((j) => rows[j].sheet !== rows[i].sheet).map((j) => `row ${rows[j].row} of ${rows[j].sheet}`);
      const at = and([...(near.length ? [`${near.length > 1 ? 'rows' : 'row'} ${and(near)}`] : []), ...far]);
      const why = same ? '' : `Not imported: the file has different texts for this label in column ${l} (here and on ${at}). Keep one, then import again`;
      (drop.get(i) ?? drop.set(i, new Map()).get(i)!).set(l, why);
    }
  }
  store.group(() => {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const skip = (key: string, ls: Lcid[] | null, reason: string) =>
        res.skipped.push({ sheet: r.sheet, row: r.row, key, values: ls ? Object.fromEntries(ls.map((l) => [l, r.values[l]])) : r.values, reason });
      if (r.reason || unsure.has(i)) {
        skip('', null, r.reason || unsure.get(i)!);
        continue;
      }
      const key = keys[i];
      const slot = store.get(key);
      if (!slot) {
        skip(key, null, 'No matching component in this environment');
        continue;
      }
      const dup = drop.get(i);
      const langs = Object.keys(r.values).map(Number).filter((l) => use.has(l) && !dup?.has(l));
      const off = langs.filter((l) => inst && !inst.has(l));
      // Tab and section labels loaded without the language switch are unknown (not empty) in other
      // languages (ref.partial, see ui/editor notLoaded): staging there would only produce conflicts.
      const p = slot.ref?.partial;
      const unk = langs.filter((l) => !off.includes(l) && !!p && (Array.isArray(p) ? !p.includes(l) : !(l in slot.labels)));
      const ok = langs.filter((l) => !off.includes(l) && !unk.includes(l));
      const diff = ok.filter((l) => store.value(key, l) !== r.values[l]);
      // Only an apostrophe in front differs: what our CSV export put before = + - @ until its Key header said it was ours.
      const guard = r.lit ? diff.filter((l) => unguard(r.values[l]) === store.value(key, l)) : [];
      const put = diff.filter((l) => !guard.includes(l));
      res.unchanged += ok.length - diff.length;
      // A read-only label (one from a managed solution included, whatever its slot says) is skipped with the reason.
      const ro = slot.readOnly || (isManaged(slot) ? MANAGED : '');
      if (ro) {
        if (put.length) skip(key, put, `Read-only: ${ro}`);
      } else
        for (const l of put) {
          store.set(key, l, r.values[l]);
          res.staged++;
        }
      if (guard.length) skip(key, guard, "Not changed: the only difference is an apostrophe in front, which older CSV exports of the translator added before =, +, - and @. Type it in the translator if the text needs it");
      if (unk.length) skip(key, unk, 'This language could not be read for form tabs and sections. Load again, then import again');
      if (off.length && !ok.length && !unk.length) skip(key, off, 'Language not installed in this environment');
      for (const [l, why] of dup || []) if (why) skip(key, [l], why);
    }
  });
  return res;
}

/**
 * `ctx` is optional: org and base language fill the "Translator" info sheet, and the provisioned
 * languages (`langs`) keep imports from staging languages this environment does not have.
 */
export function createIo(ctx?: Partial<Pick<Ctx, 'org' | 'base' | 'langs'>>): IoApi {
  const inst = ctx?.langs && new Set(ctx.langs.map((l) => l.lcid));
  return {
    // Exports `slot.labels` as they are: the caller passes slots whose labels already include pending edits.
    async exportWorkbook(slots, langs, fileName) {
      const info: Cell[][] = [
        ['Dynamics Translator', 'Translation workbook'],
        ['Organization', ctx?.org || location.hostname],
        ['Base language', ctx?.base ?? null],
        ['Languages', langs.join(', ')],
        ['Exported on', new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'],
        ['Version', __VERSION__],
        ['Note', 'Empty cells mean "no translation" and never clear a label on import. The sheets up to "Dashboards Fields" use the XrmToolBox Easy Translator layout.'],
      ];
      const blob = await writeXlsx([...layout(slots, langs), { name: INFO, rows: info }], { headerStyle: true, freezeHeader: true });
      return new File([blob], /\.xlsx$/i.test(fileName) ? fileName : `${fileName || 'translations'}.xlsx`, { type: blob.type });
    },
    // Same convention as exportWorkbook. Columns: Key (headed CSV_KEY, which marks the file as ours), Type, Table,
    // Component, Property, then one per language.
    exportCsv: (slots, langs) => new Blob(['\ufeff' + toCsv([[CSV_KEY, ...KEYC.slice(1), ...langs.map(String)], ...sorted(slots).map((s) => [...keyRow(s), ...vals(s, langs)])])], { type: 'text/csv;charset=utf-8' }),
    parse,
    apply: (parsed, store) => apply(parsed, store, inst),
  };
}
