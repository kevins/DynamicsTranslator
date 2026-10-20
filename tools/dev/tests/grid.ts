// Unit tests for the workbook grid's pure parts (owned by the grid area). register() is called by tools/dev/unit.ts.
// The grid itself needs a DOM (layout, pointer and clipboard events) and is checked live; what a key on a cell shows
// runs on the fake DOM of tools/dev/tests/callout.ts, as in gridedit.ts.
import type { Lcid, Slot } from '../../../src/core/model';
import { Store } from '../../../src/core/store';
import { PUB_ONLY } from '../../../src/providers/formxml';
import type { AppApi } from '../../../src/ui/types';
import {
  blankEdit,
  blocked,
  blockedWhy,
  buildCols,
  changedTip,
  clearing,
  createGrid,
  edLook,
  extent,
  fromSheet,
  headerCell,
  keyMismatch,
  keyNorm,
  langCell,
  missing,
  noteSaved,
  oneCell,
  orderLangs,
  parseTsv,
  problem,
  REMOVED,
  rereadable,
  rowState,
  sameAsBase,
  sameClip,
  standInTip,
  textOf,
  toTsv,
  tsvCell,
  typeTip,
  UNREAD,
  unreadTip,
} from '../../../src/workbench/grid';
import type { GridApi, KeyCol } from '../../../src/workbench/types';
import { dom, FEl, fire, install } from './callout';
import type { Kit } from './kit';

const EN = 1033;
const FR = 1036;
const DE = 1031;

type Action = { label: string; run: () => void };

/**
 * The grid on the fake DOM with one row (English base, French target, the French cell active): Enter pressed there,
 * the toasts it showed. `readAgain`: the Workbench's Read again (GridOptions.readAgain); none when left out.
 */
function enterOn(slot: Slot, readAgain?: () => void): Array<{ text: string; act?: Action }> {
  const off = install();
  const g = globalThis as Record<string, unknown>;
  const idDesc = Object.getOwnPropertyDescriptor(FEl.prototype, 'id')!;
  const doc = document as unknown as { createElement(t: string): FEl };
  const make = doc.createElement;
  // What the grid needs beyond the popup's fake DOM: element ids it sets, CSS variables, a ResizeObserver.
  Object.defineProperty(FEl.prototype, 'id', { get: idDesc.get, set(this: FEl, v: string) { this.attrs.id = String(v); }, configurable: true });
  doc.createElement = (t: string) => Object.assign(make(t), { style: { setProperty() {}, removeProperty() {} } });
  g.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  let grid: GridApi | undefined;
  const toasts: Array<{ text: string; act?: Action }> = [];
  try {
    const store = new Store();
    store.add([slot]);
    const app = {
      store,
      ctx: { base: EN, user: EN, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] },
      prefs: { target: FR, shown: [], showNames: false },
      adoptStyles() {},
      toast: (text: string, _kind: string, act?: Action) => toasts.push({ text, act }),
      root: dom.root,
      layer: dom.layer,
    } as unknown as AppApi;
    grid = createGrid(app, { widths: {}, onWidths() {}, onSel() {}, ctx: { store, tableName: () => 'Account' }, readAgain });
    dom.layer.append(grid.el as unknown as FEl);
    grid.setSheet('tabs', [], () => 'Label', [EN, FR], FR);
    grid.setRows([slot]);
    fire(grid.el as unknown as FEl, 'keydown', { key: 'Enter' });
    return toasts;
  } finally {
    grid?.destroy();
    Object.defineProperty(FEl.prototype, 'id', idDesc);
    doc.createElement = make;
    delete g.ResizeObserver;
    off();
  }
}

export function register(t: Kit): void {
  const { test, eq, ok } = t;
  const mk = (kind: string, labels: Record<number, string> = { [EN]: 'Name', [FR]: 'Nom' }, extra: Partial<Slot> = {}): Slot => ({ ...t.slot(kind, `${kind}|x|Label`, { ...labels }), ...extra }) as Slot;
  const storeOf = (...s: Slot[]) => {
    const st = new Store();
    st.add(s);
    return st;
  };

  // ---- clipboard ----
  test('grid: parseTsv reads Excel rows and drops the trailing line break', () => {
    eq(parseTsv('a\tb\r\nc\td\r\n'), [['a', 'b'], ['c', 'd']]);
    eq(parseTsv('abc\r\n'), [['abc']]);
    eq(parseTsv(''), [['']]);
    eq(parseTsv('a\t\r\n'), [['a', '']], 'empty last cell');
    eq(parseTsv('a\r\n\r\n'), [['a'], ['']], 'empty last row');
  });
  test('grid: parseTsv reads quoted cells with tabs, line breaks and doubled quotes', () => {
    eq(parseTsv('"x\ny"\tz'), [['x\ny', 'z']]);
    eq(parseTsv('"a\tb"\r\n"say ""hi"""'), [['a\tb'], ['say "hi"']]);
  });
  test('grid: parseTsv keeps quotes that do not wrap the whole cell', () => {
    eq(parseTsv('"Premium" plan'), [['"Premium" plan']]);
    eq(parseTsv('"Premium" plan\tx'), [['"Premium" plan', 'x']]);
    eq(parseTsv('"abc'), [['"abc']], 'unterminated quote');
    eq(parseTsv('say "hi"\tb'), [['say "hi"', 'b']]);
  });
  test('grid: toTsv quotes only what needs it and round-trips through parseTsv', () => {
    eq(tsvCell('plain'), 'plain');
    eq(tsvCell('say "hi"'), 'say "hi"');
    eq(tsvCell('"Premium" plan'), '"""Premium"" plan"');
    eq(tsvCell('a\nb'), '"a\nb"');
    const cells = [['a\tb', 'line 1\nline 2', '"quoted"'], ['', 'x "y" z', 'Nom']];
    eq(toTsv([['a', 'b'], ['c', 'd']]), 'a\tb\r\nc\td\r\n', 'several rows end with a line break, as in Excel');
    eq(toTsv([['a', 'b']]), 'a\tb');
    eq(parseTsv(toTsv(cells)), cells);
    eq(parseTsv(toTsv([['a'], ['']])), [['a'], ['']]);
    eq(parseTsv(toTsv([['"Premium" plan']])), [['"Premium" plan']]);
  });
  test('grid: fromSheet tells spreadsheet cells from lines of a document', () => {
    const f = (t: string, html = '', own = false) => fromSheet(parseTsv(t), html, own);
    ok(f('a\tb'), 'columns');
    ok(f('a\r\nb\r\n', '<html><body><table><tr><td>a</td></tr><tr><td>b</td></tr></table>'), 'one column from Excel comes with an HTML table');
    ok(f('a\r\nb\r\n', '', true), "this grid's own copy of one column");
    ok(!f('Line one\r\nLine two'), 'paragraphs of a document');
    ok(!f('Line one\r\nLine two\r\n', '<p>Line one</p><p>Line two</p>'), 'Word paragraphs end with a line break but stay in the cell');
    ok(!f('Line one\r\nLine two\r\n'), 'plain-text lines stay in the cell');
    ok(sameClip('a\r\nb\r\n', 'a\nb\n') && !sameClip('', '') && !sameClip('a', 'b'), 'line breaks do not matter');
  });
  test('grid: a single pasted cell keeps quotes typed in a document, a spreadsheet cell loses its quoting', () => {
    const one = (t: string, sheet: boolean) => oneCell(t, parseTsv(t), sheet);
    eq(one('"Beta"', false), '"Beta"', 'quoted text from a document');
    eq(one('Nom\r\n', true), 'Nom', "Excel's trailing line break");
    eq(one('Hello\r\n', false), 'Hello', "a paragraph's trailing line break");
    eq(one('"Line 1\nLine 2"\r\n', true), 'Line 1\nLine 2', 'an Excel cell with a line break');
    eq(one(toTsv([['"Premium" plan']]), true), '"Premium" plan', "this grid's own copy");
    eq(one('say "hi"', false), 'say "hi"');
  });
  test('grid: a pasted block is measured up to its last text, and a copied header row is found', () => {
    eq(extent(parseTsv('a\tb\t\r\nc\t\t\r\n\t\t\r\n')), [2, 2], 'trailing blank rows and columns');
    eq(extent(parseTsv('\r\n')), [0, 0]);
    const names = ['Attribute Logical Name', 'Type', 'English Label', 'French Label'];
    const isHead = (j: number, v: string) => keyNorm(v) === keyNorm(names[j]) || (j >= 2 && /^(1033|1036)$/.test(v));
    eq(headerCell(parseTsv('French Label\r\nNom\r\n'), 3, 4, isHead), [3, 'French Label']);
    eq(headerCell(parseTsv('1036\r\nNom\r\n'), 3, 4, isHead), [3, '1036'], 'Easy Translator files head language columns with the LCID');
    eq(headerCell(parseTsv('Attribute Logical Name\tType\r\nname\tDisplayName\r\n'), 0, 4, isHead), [0, 'Attribute Logical Name']);
    eq(headerCell(parseTsv('accountnumber\tDisplayName\tAccount Number\tNuméro'), 0, 4, isHead), null, 'data rows');
    eq(headerCell(parseTsv('Nom\tFrench Label'), 3, 4, isHead), null, 'cells past the last column are not checked');
    eq(keyNorm(' {6A1B0C2D-0000-0000-0000-000000000001} '), '6a1b0c2d-0000-0000-0000-000000000001', 'GUID braces and case');
    eq(keyNorm('AccountNumber'), 'accountnumber');
  });

  // ---- blank translations (the saver's rules) ----
  test("grid: blankEdit marks removals, stand-ins where Dataverse can't remove a translation, and blanks it refuses", () => {
    const attr = mk('attribute');
    const view = mk('view');
    const tx = textOf(storeOf(attr, view));
    eq(blankEdit(attr, FR, EN, 'Nom', '', tx), 'standin', 'emptied attribute translation: saved as its English text');
    eq(blankEdit(attr, FR, EN, 'Nom', ' ', tx), 'standin', 'only spaces count as emptied');
    eq(blankEdit(attr, FR, EN, 'Nom', '', () => ''), 'blocked', 'no English text to stand in for it');
    eq(blankEdit(attr, FR, EN, 'Nom', '', () => undefined), 'blocked', 'its English text not loaded');
    eq(blankEdit(attr, FR, EN, '', '  ', tx), 'blocked', 'only spaces where there is none');
    eq(blankEdit(view, FR, EN, 'Nom', '', tx), 'remove', 'view translations can be removed');
    eq(blankEdit(view, FR, EN, '', '  ', tx), '', 'spaces where nothing is stored change nothing');
    eq(blankEdit(attr, EN, EN, 'Name', '', tx), '', 'base language is checked elsewhere');
    eq(blankEdit(attr, FR, EN, 'Nom', 'Nom', tx), '', 'unchanged');
    eq(blankEdit(attr, FR, EN, 'Nom', 'Nouveau', tx), '', 'text');
    eq(blankEdit(mk('attribute', undefined, { readOnly: 'Managed' }), FR, EN, 'Nom', '', tx), '', 'read-only');
  });
  test('grid: clearing, blocked and problem follow the pending edit; an emptied translation with a stand-in is no problem', () => {
    const s = mk('attribute');
    const d = mk('attribute', { [FR]: 'Astuce' }, { key: 'attribute|x|Description', prop: 'Description', baseRequired: false });
    const st = storeOf(s, d);
    eq(clearing(st, s, FR, EN), '');
    ok(!problem(st, s, [EN, FR], EN));
    st.set(s.key, FR, '');
    eq(clearing(st, s, FR, EN), 'standin');
    ok(!blocked(st, s, EN) && !problem(st, s, [EN, FR], EN), 'saved as the English text');
    // Its English text emptied in the same edits: nothing to stand in for it.
    st.set(s.key, EN, '');
    eq(clearing(st, s, FR, EN), 'blocked');
    ok(blocked(st, s, EN) && problem(st, s, [EN, FR], EN));
    st.set(s.key, FR, 'Nom 2');
    eq(clearing(st, s, FR, EN), '');
    ok(!blocked(st, s, EN));
    // A column's description (its tooltip) is saved empty, whatever its English text (model.ts savesEmpty): no problem.
    st.set(d.key, FR, '');
    eq(clearing(st, d, FR, EN), 'empty');
    ok(!blocked(st, d, EN) && !problem(st, d, [EN, FR], EN), 'saved empty');
    // A name with no English text: refused, saying why.
    const n = mk('option', { [FR]: 'Petit' }, { key: 'option|x|1|Label', prop: 'Label' });
    const sn = storeOf(n);
    sn.set(n.key, FR, '');
    eq(clearing(sn, n, FR, EN), 'blocked');
    eq(blockedWhy(n, FR, EN, 'Petit', '', textOf(sn)), "Dataverse can't remove this translation, and its English text is empty: type the text instead.");
  });
  test('grid: missing and sameAsBase', () => {
    const s = mk('attribute', { [EN]: 'Name' });
    const st = storeOf(s);
    ok(missing(st, s, FR, EN), 'no French');
    ok(!missing(st, s, EN, EN), 'never the base');
    st.set(s.key, FR, 'Name');
    ok(!missing(st, s, FR, EN) && sameAsBase(st, s, FR, EN));
    const partial = mk('tab', { [EN]: 'General' }, { ref: { partial: [EN] } });
    ok(!missing(storeOf(partial), partial, FR, EN), 'a language not loaded is unknown, not missing');
  });

  // ---- columns ----
  const keys: KeyCol[] = [
    { id: 'id', name: 'Attribute Id', w: 120, mono: true, get: (s) => String(s.ref?.metadataId ?? '') },
    { id: 'attr', name: 'Attribute Logical Name', w: 160, keep: true, get: (s) => String(s.ref?.attribute ?? '') },
  ];
  test('grid: languages are ordered base, target, then the others', () => {
    eq(orderLangs([EN, DE, FR], EN, FR), [EN, FR, DE]);
    eq(orderLangs([EN, DE], EN, FR), [EN, DE], 'a target that is not shown is not added');
    eq(orderLangs([DE, EN], EN, EN), [EN, DE]);
  });
  test('grid: buildCols lays out key columns, Type, then "<Language> Label" columns with remembered-width keys', () => {
    const cols = buildCols('attributes', keys, [EN, DE, FR], EN, FR, (l) => ({ [EN]: 'English', [FR]: 'French', [DE]: 'German' })[l] ?? String(l));
    eq(cols.map((c) => c.id), ['id', 'attr', 'type', 'l1033', 'l1036', 'l1031']);
    eq(cols.map((c) => c.wk), ['attributes:id', 'attributes:attr', 'attributes:type', 'l1033', 'l1036', 'l1031']);
    eq(cols.map((c) => c.name), ['Attribute Id', 'Attribute Logical Name', 'Type', 'English Label', 'French Label', 'German Label']);
    eq(cols.map((c) => c.l), [0, 0, 0, EN, FR, DE]);
    eq(cols.map((c) => c.def), [120, 160, 110, 260, 260, 260]);
    ok(cols[0].mono && !cols[0].keep && cols[1].keep, 'mono and keep carried over');
    ok(cols[0].key === keys[0], 'getter kept');
  });
  test('grid: keyMismatch refuses a paste whose key cells land on other rows', () => {
    const shown = [
      ['x1', 'accountnumber', 'DisplayName'],
      ['x2', 'name', 'DisplayName'],
    ];
    const isKey = (j: number) => j < 3;
    const same = (i: number, j: number, v: string) => shown[i][j] === v;
    eq(keyMismatch([['x1', 'accountnumber', 'DisplayName', 'Numéro']], 0, 0, 0, 3, isKey, same), null, 'lines up');
    eq(keyMismatch([['x2', 'name', 'DisplayName', 'Nom'], ['x1', 'accountnumber', 'DisplayName', 'Numéro']], 0, 0, 1, 3, isKey, same), { i: 0, j: 0, v: 'x2' }, 'sorted differently');
    eq(keyMismatch([['', ' ', '', 'Nom']], 1, 0, 1, 3, isKey, same), null, 'blank key cells are not compared');
    eq(keyMismatch([['Nom'], ['Nom 2']], 0, 3, 1, 3, isKey, same), null, 'language columns only');
  });

  // ---- cell states ----
  test('grid: langCell shows edits with the old text, saved cells, and missing ones', () => {
    const s = mk('attribute', { [EN]: 'Name', [FR]: 'Nom' });
    const m = mk('view', { [EN]: 'Active' });
    const st = storeOf(s, m);
    eq(langCell(st, s, FR, EN).cls, '');
    st.set(s.key, FR, 'Nom 2');
    const e = langCell(st, s, FR, EN);
    eq(e.cls, ' is-ed');
    ok(e.tip.includes('Was “Nom”'), e.tip);
    st.commit([{ change: { slot: s, lcid: FR, before: 'Nom', after: 'Nom 2' }, outcome: 'saved' }]);
    eq(langCell(st, s, FR, EN).cls, ' is-sv', 'saved and verified');
    st.status.set(`${s.key}#${FR}`, { outcome: 'saved', server: 'Nom 2' });
    eq(langCell(st, s, FR, EN).cls, ' is-sv', 'saved text still on the server');
    s.labels[FR] = 'Changed by someone';
    eq(langCell(st, s, FR, EN).cls, '', 'no check once the server holds another text');
    s.labels[FR] = 'Nom 2';
    st.set(s.key, FR, 'Nom 3');
    eq(langCell(st, s, FR, EN).cls, ' is-ed', 'the check goes with the next edit');
    const mi = langCell(st, m, FR, EN);
    eq(mi.cls, ' is-mi');
    ok(mi.tip.startsWith('Missing in'), mi.tip);
  });
  test('grid: the saved check goes when a later extraction brings another text (Store.commit records no server text)', () => {
    const s = mk('attribute', { [EN]: 'Name', [FR]: 'Nom' });
    const st = storeOf(s);
    st.set(s.key, FR, 'Nom 2');
    st.commit([{ change: { slot: s, lcid: FR, before: 'Nom', after: 'Nom 2' }, outcome: 'saved' }]);
    noteSaved(st);
    eq(langCell(st, s, FR, EN).cls, ' is-sv', 'saved and verified');
    st.add([{ ...s, labels: { [EN]: 'Name', [FR]: 'Nom 2' } }]);
    noteSaved(st);
    eq(langCell(st, s, FR, EN).cls, ' is-sv', 'extracted again with the same text: the check stays');
    st.add([{ ...s, labels: { [EN]: 'Name', [FR]: 'Changé par quelqu’un' } }]);
    noteSaved(st);
    eq(langCell(st, s, FR, EN).cls, '', 'someone else changed it since: no check');
    st.set(s.key, FR, 'Nom 3');
    st.commit([{ change: { slot: st.get(s.key)!, lcid: FR, before: 'Changé par quelqu’un', after: 'Nom 3' }, outcome: 'saved' }]);
    noteSaved(st);
    eq(langCell(st, s, FR, EN).cls, ' is-sv', 'a new save gets its own check');
    // A removal saved: the server holds no text, and the check stays on the emptied cell.
    const v = mk('view', { [EN]: 'Active', [FR]: 'Actif' });
    const sv = storeOf(v);
    sv.set(v.key, FR, '');
    sv.commit([{ change: { slot: v, lcid: FR, before: 'Actif', after: '' }, outcome: 'saved' }]);
    noteSaved(sv);
    ok(langCell(sv, v, FR, EN).cls.includes('is-sv'), 'removed and verified');
  });
  test('grid: langCell marks conflicts, errors, blocked blanks and removals', () => {
    const a = mk('attribute', { [EN]: 'Name', [FR]: 'Nom' });
    const v = mk('view', { [EN]: 'Active', [FR]: 'Actif' });
    const st = storeOf(a, v);
    st.set(a.key, FR, 'Mine');
    st.commit([{ change: { slot: a, lcid: FR, before: 'Nom', after: 'Mine' }, outcome: 'conflict', server: 'Theirs' }]);
    const c = langCell(st, a, FR, EN);
    eq(c.cls, ' is-cf');
    ok(c.tip.includes('“Theirs”') && c.tip.includes('“Mine”'), c.tip);
    st.resolve(a.key, FR, true);
    eq(langCell(st, a, FR, EN).cls, ' is-ed', 'keep mine: a plain pending edit again');
    st.commit([{ change: { slot: a, lcid: FR, before: 'Theirs', after: 'Mine' }, outcome: 'error', message: 'Too long.' }]);
    const er = langCell(st, a, FR, EN);
    eq(er.cls, ' is-er');
    ok(er.tip.startsWith('Too long.'), er.tip);
    // Emptied where Dataverse can't remove it: green, its stand-in shown muted, the tooltip says why.
    st.set(a.key, FR, '');
    eq(langCell(st, a, FR, EN), {
      cls: ' is-ed is-si',
      tip: "Becomes “Name” when you save: Dataverse can't remove a translation here, so French gets the English text. Was “Theirs”.",
      was: '',
      to: 'Name',
    });
    // With no English text to stand in for it: red, refused.
    st.set(a.key, EN, ' ');
    eq(langCell(st, a, FR, EN).cls, ' is-er is-nc', 'emptied, no stand-in: refused');
    st.revert(a.key, EN);
    st.set(v.key, FR, '');
    const rm = langCell(st, v, FR, EN);
    eq(rm.cls, ' is-ed is-rm');
    eq(rm.was, 'Actif');
  });
  test("grid: a form field label emptied where Dataverse can't remove it shows the column's name in that language, else its base-language name", () => {
    const cell = mk('field', { [EN]: 'Customer', [FR]: 'Client' }, { key: 'field|f|c1|Label', entity: 'acc', ref: { formId: 'f', datafield: 'name', controlId: 'name' } });
    const col = mk('attribute', { [EN]: 'Account Name', [FR]: 'Nom du compte' }, { key: 'attribute|acc.name|DisplayName', prop: 'DisplayName' });
    const st = storeOf(cell, col);
    st.set(cell.key, FR, '');
    const lk = langCell(st, cell, FR, EN);
    eq([lk.cls, lk.to, lk.tip], [' is-ed is-si', 'Nom du compte', "Becomes “Nom du compte” when you save: Dataverse can't remove a translation here, so French gets the column's French name. Was “Client”."]);
    // The column's French name typed in the same edits counts; with none, its English name.
    st.set(col.key, FR, 'Nom');
    eq(langCell(st, cell, FR, EN).to, 'Nom');
    st.set(col.key, FR, '');
    eq(langCell(st, cell, FR, EN).to, 'Account Name');
    eq(standInTip(cell, FR, EN, 'Client', '', textOf(st)), "Becomes “Account Name” when you save: Dataverse can't remove a translation here, so French gets the column's English name. Was “Client”.");
    // Worded like its stand-in already: nothing changes, said as the popup says it.
    eq(standInTip(cell, FR, EN, 'Account Name', '', textOf(st)), "Already the column's English name: Dataverse can't remove a translation here, so nothing changes.");
    // The column not loaded: refused, saying why and what loads it.
    const alone = storeOf(cell);
    alone.set(cell.key, FR, '');
    const lc = langCell(alone, cell, FR, EN);
    eq([lc.cls, lc.tip], [' is-er is-nc', "Dataverse can't remove this translation, and its column's names aren't loaded: load its table's columns to put the column's name in its place, or type the text."]);
  });
  test('grid: langCell keeps read-only and not-loaded cells grey', () => {
    const ro = mk('attribute', undefined, { readOnly: 'Managed and not customizable' });
    const tab = mk('tab', { [EN]: 'General' }, { ref: { partial: [EN] } });
    const st = storeOf(ro, tab);
    eq(langCell(st, ro, FR, EN), { cls: ' is-ro', tip: 'Managed and not customizable', was: '', to: '' });
    const nl = langCell(st, tab, FR, EN);
    eq(nl.cls, ' is-ro is-nl');
    eq(nl.tip, UNREAD);
    // The language switch needs no consent: a new extraction is all it takes (no setting to turn on).
    ok(UNREAD.includes('Extract translations') && !UNREAD.includes('Turn on'), 'points to a new extraction');
  });
  test('grid: a cell whose form could not be read in its language says why, and points to what reads it: Extract translations (always there) or Read again', () => {
    const why = 'Dynamics did not answer in French, so its form labels were not used. Try again.';
    const tab = mk('tab', { [EN]: 'General' }, { ref: { partial: true, unread: { [FR]: why } } });
    const lost = mk('section', { [EN]: 'Details' }, { ref: { partial: true, unread: { [FR]: 'The batch failed' } } });
    const st = storeOf(tab, lost);
    const nl = langCell(st, tab, FR, EN);
    eq(nl.cls, ' is-ro is-nl', 'still not loaded: never empty, never editable');
    eq(nl.tip, `Not loaded: this form could not be read in French, even when tried again. ${why} Select Extract translations again to read it, or Read again where the message bar offers it.`);
    eq(unreadTip(tab, FR), nl.tip);
    ok(unreadTip(lost, FR).includes('The batch failed. Select Extract translations again'), 'a reason without a full stop gets one');
    eq(unreadTip(tab, DE), UNREAD, 'a language this load was not asked to read: the general wording');
    eq(unreadTip(tab, DE, { button: true }), UNREAD, 'whatever carries it');
    eq(langCell(st, tab, EN, EN).cls, '', 'a language read is a normal cell');
  });
  test('grid: a field of a form Dynamics has only a published definition of says why no read brings its other languages, and points to none', () => {
    const cell = mk('field', { [FR]: 'Nom' }, { ref: { partial: true, unreadable: PUB_ONLY } });
    const st = storeOf(cell);
    const nl = langCell(st, cell, EN, FR);
    eq(nl.cls, ' is-ro is-nl', 'not loaded: never empty, never editable');
    eq(nl.tip, `Not loaded in English. ${PUB_ONLY}`);
    ok(!/Read again|Extract translations/.test(nl.tip), 'reading again would not change it');
    eq(langCell(st, cell, FR, FR).cls, '', 'the language read is a normal cell');
  });
  test('grid: rereadable only where a Read again would bring the cell', () => {
    const why = 'The batch failed.';
    const tab = mk('tab', { [EN]: 'General' }, { ref: { partial: true, unread: { [FR]: why } } });
    ok(rereadable(tab, FR), 'its read failed in French');
    ok(!rereadable(tab, DE), 'a language the load was not asked to read: a new extraction reads it');
    ok(!rereadable(tab, EN), 'a language read');
    ok(!rereadable(mk('tab', { [EN]: 'General', [FR]: '' }, { ref: { partial: true, unread: { [FR]: why } } }), FR), 'read since (a save, a Read again)');
    ok(!rereadable(mk('field', { [EN]: 'Account Name' }, { ref: { partial: true, unreadable: PUB_ONLY } }), FR), 'no read can bring it');
    ok(!rereadable(mk('field', { [EN]: 'Account Name' }, { ref: { partial: true, unreadable: PUB_ONLY, unread: { [FR]: why } } }), FR), 'a published-only form, whatever else it says');
  });
  test('grid: Enter on a "Not loaded" cell whose read failed shows why, with a Read again that runs the Workbench\'s and that its text points to', () => {
    const why = 'Dynamics did not answer in French, so its form labels were not used. Try again.';
    const tab = mk('tab', { [EN]: 'General' }, { ref: { partial: true, unread: { [FR]: why }, formId: 'f1' } });
    let runs = 0;
    const shown = enterOn(tab, () => runs++);
    eq(shown.length, 1, 'one notice, no editor');
    eq(shown[0].text, unreadTip(tab, FR, { button: true }));
    eq(shown[0].text, `Not loaded: this form could not be read in French, even when tried again. ${why} Select Read again to try once more, or Extract translations again.`, 'it points to its own button, not the message bar');
    eq(shown[0].act?.label, 'Read again');
    shown[0].act!.run();
    eq(runs, 1, 'the Workbench reads the forms and languages still unread');
    const bare = enterOn(tab)[0];
    eq([bare.act, bare.text], [undefined, unreadTip(tab, FR)], 'no button where the Workbench gives no Read again: the tooltip text, unchanged');
  });
  test('grid: Enter on a "Not loaded" cell no read can bring, or one the load was not asked to read, shows why without Read again', () => {
    let runs = 0;
    const pub = mk('field', { [EN]: 'Account Name' }, { ref: { partial: true, unreadable: PUB_ONLY } });
    const p = enterOn(pub, () => runs++);
    eq([p.length, p[0].text, p[0].act], [1, unreadTip(pub, FR), undefined], 'published-only form');
    const tab = mk('tab', { [EN]: 'General' }, { ref: { partial: true } });
    const u = enterOn(tab, () => runs++);
    eq([u.length, u[0].text, u[0].act], [1, UNREAD, undefined], 'a new extraction reads it');
    eq(runs, 0);
  });
  // ---- the open cell editor ----
  test('grid: the cell editor turns green as soon as its text differs from the server text', () => {
    const s = mk('attribute', { [EN]: 'Name', [FR]: 'Nom' });
    const tx = textOf(storeOf(s));
    eq(edLook(s, FR, EN, 'Nom', 'Nom', 'Nom', 'English', tx), { cls: '', tip: '' });
    eq(edLook(s, FR, EN, 'Nom', 'Nom', 'Nom 2', 'English', tx), { cls: ' is-ed', tip: 'Changed, not saved yet. Was “Nom”.' });
    eq(edLook(s, FR, EN, 'Nom', 'Nom 2', 'Nom', 'English', tx).cls, '', 'a pending cell typed back to the server text');
    eq(edLook(s, FR, EN, 'Nom', 'Nom 2', 'Nom 2', 'English', tx).cls, ' is-ed', 'a pending cell opens green');
    eq(edLook(s, FR, EN, '', '', 'Nom', 'English', tx).tip, 'Changed, not saved yet. It was blank.');
    eq(changedTip('Nom'), 'Changed, not saved yet. Was “Nom”.');
  });
  test("grid: the cell editor is red where the commit or Dataverse would refuse the text, green with its stand-in where Dataverse can't remove a translation", () => {
    const a = mk('attribute', { [EN]: 'Name', [FR]: 'Nom' });
    const tx = textOf(storeOf(a));
    eq(edLook(a, FR, EN, 'Nom', 'Nom', '', 'English', tx), { cls: ' is-ed', tip: "Becomes “Name” when you save: Dataverse can't remove a translation here, so French gets the English text. Was “Nom”." }, 'an emptied column name');
    eq(edLook(a, FR, EN, 'Nom', 'Nom', '', 'English', () => ''), { cls: ' is-nc', tip: "Dataverse can't remove this translation, and its English text is empty: type the text instead." }, 'nothing to stand in for it');
    eq(edLook(a, FR, EN, '', '', '  ', 'English', tx).cls, ' is-nc', 'only spaces where there is none');
    eq(edLook(a, EN, EN, 'Name', 'Name', ' ', 'English', tx), { cls: ' is-nc', tip: "The English label can't be blank." });
    eq(edLook(mk('attribute', { [FR]: 'Nom' }), EN, EN, '', '', '', 'English', tx).cls, '', 'a base text blank on the server, unchanged');
    eq(edLook(mk('view', { [EN]: 'Active', [FR]: 'Actif' }), FR, EN, 'Actif', 'Actif', '', 'English', tx), { cls: ' is-ed', tip: REMOVED }, 'a view translation is removed');
    eq(edLook(mk('attribute', undefined, { max: 5 }), FR, EN, 'Nom', 'Nom', 'Nom long', 'English', tx), { cls: ' is-over is-ed', tip: 'Too long: 8 of 5 characters' });
  });
  test('grid: the cell editor looks the way its cell will once the text is committed', () => {
    const cases: Array<[string, Lcid, string]> = [
      ['attribute', FR, 'Nom 2'],
      ['attribute', FR, 'Nom'],
      ['attribute', FR, ''],
      ['view', FR, ''],
      ['attribute', EN, ''],
      ['attribute', EN, 'Name 2'],
    ];
    for (const [kind, l, v] of cases) {
      const s = mk(kind);
      const st = storeOf(s);
      const look = edLook(s, l, EN, st.original(s.key, l), st.value(s.key, l), v, 'English', textOf(st));
      // commit(): nothing for an unchanged text, a toast instead of the edit for a blank base text.
      const refused = l === EN && s.baseRequired && !v.trim();
      if (v !== st.value(s.key, l) && !refused) st.set(s.key, l, v);
      const cell = langCell(st, s, l, EN).cls;
      const what = `${kind} ${l} “${v}”`;
      eq(look.cls.includes('is-ed'), cell.includes('is-ed'), what + ': green');
      eq(look.cls.includes('is-nc'), cell.includes('is-nc') || refused, what + ': red');
    }
    // A cell whose save failed: opened, it stays red with its error while the text is unchanged (committing it keeps
    // the error); typing makes it a new change (commit's set() clears the status).
    const a = mk('attribute');
    const st = storeOf(a);
    st.set(a.key, FR, 'Nom trop long');
    st.status.set(`${a.key}#${FR}`, { outcome: 'error', message: 'Too long.', server: 'Nom' });
    const cs = st.cellStatus(a.key, FR);
    const err = edLook(a, FR, EN, 'Nom', 'Nom trop long', 'Nom trop long', 'English', textOf(st), cs);
    eq(err, { cls: ' is-nc', tip: 'Too long. Value on the server: “Nom”.' });
    ok(langCell(st, a, FR, EN).cls.includes('is-er'), 'the cell is red too');
    eq(edLook(a, FR, EN, 'Nom', 'Nom trop long', 'Nom court', 'English', textOf(st), cs), { cls: ' is-ed', tip: 'Changed, not saved yet. Was “Nom”.' }, 'typed: green');
    // A skipped change (a stopped save) says why, as its cell does.
    st.status.set(`${a.key}#${FR}`, { outcome: 'skipped', message: 'The save was stopped' });
    const sk = edLook(a, FR, EN, 'Nom', 'Nom trop long', 'Nom trop long', 'English', textOf(st), st.cellStatus(a.key, FR));
    eq(sk, { cls: ' is-ed', tip: langCell(st, a, FR, EN).tip });
  });

  test('grid: rowState for the row number', () => {
    const a = mk('attribute');
    const st = storeOf(a);
    eq(rowState(st, a, [EN, FR], EN)[0], '');
    st.set(a.key, FR, 'Nom 2');
    eq(rowState(st, a, [EN, FR], EN)[0], 'ed');
    st.set(a.key, FR, '');
    eq(rowState(st, a, [EN, FR], EN)[0], 'ed', 'emptied: saved as its English text');
    st.set(a.key, EN, ' ');
    eq(rowState(st, a, [EN, FR], EN)[0], 'er', 'blocked blank: no English text to stand in for it');
    eq(rowState(st, mk('view', undefined, { readOnly: 'Managed' }), [EN, FR], EN), ['ro', 'Managed']);
  });
  test('grid: Type tooltips answer where a label shows', () => {
    ok(typeTip({ ...mk('attribute'), prop: 'Description' } as Slot).includes("field's tooltip"));
    ok(typeTip({ ...mk('attribute'), prop: 'DisplayName' } as Slot).includes('column headers'));
    ok(typeTip(mk('option')).includes('choice'));
    ok(typeTip({ ...mk('field'), sub: 'name · label hidden' } as Slot).includes('hidden on the form'));
    eq(typeTip(mk('view')), 'Label');
  });
}
