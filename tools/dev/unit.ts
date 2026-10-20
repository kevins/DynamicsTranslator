// Offline unit tests for the pure modules (bundled and run in Node by tools/test.mjs).
// The live end-to-end suite (tools/e2e-suite.js) covers the providers against a real org.
import * as labels from '../../src/core/labels';
import * as xml from '../../src/core/xml';
import * as zipm from '../../src/core/zip';
import * as csv from '../../src/io/csv';
import * as xlsx from '../../src/io/xlsx';
import * as lcid from '../../src/core/lcid';
import { Store } from '../../src/core/store';
import { canClear, noStandIn, standIn, standInSays, standInsSaid, standInSources, standInTag, standInText, type Change, type Slot, type TextOf } from '../../src/core/model';
import { saveText, withStandIns } from '../../src/core/saver';
import type { HistoryItem } from '../../src/ui/types';
import { fieldOf } from '../../src/inspector/scan';
import { register as scanTests } from './tests/scan';
import { register as describeTests } from './tests/describe';
import { register as calloutTests } from './tests/callout';
import { register as sheetsTests } from './tests/sheets';
import { register as gridTests } from './tests/grid';
import { register as workbookTests } from './tests/workbook';
import { register as modeTests } from './tests/mode';
import { register as overlayTests } from './tests/overlay';
import { register as overlayDomTests } from './tests/overlay-dom';
import { register as savePathTests } from './tests/savepath';
import { register as langTests } from './tests/lang';
import { register as storeTests } from './tests/store';
import { register as coldloadTests } from './tests/coldload';
import { register as partsTests } from './tests/parts';
import { register as panesTests } from './tests/panes';
import { register as ribbonTests } from './tests/ribbon';
import { register as pillTests } from './tests/pill';
import { register as navMenuTests } from './tests/navmenu';
import { register as layersTests } from './tests/layers';
import { register as bpfTests } from './tests/bpf';
import { register as docWritesTests } from './tests/docwrites';
import { register as docRaceTests } from './tests/docrace';
import { register as contextTests } from './tests/context';
import { register as undoTests } from './tests/undo';
import { register as pageListTests } from './tests/pagelist';
import { register as revealTests } from './tests/reveal';
import { register as unmarkedTests } from './tests/unmarked';
import { register as recordsTests } from './tests/records';
import { register as metaRaceTests } from './tests/metarace';
import { register as gridEditTests } from './tests/gridedit';
import { register as bulkTests } from './tests/bulk';
import { register as fileIoTests } from './tests/fileio';
import { register as journalTests } from './tests/journal';
import { register as devServerTests } from './tests/devserver';
import { register as langDoubtTests } from './tests/langdoubt';
import { register as pubScopeTests } from './tests/pubscope';
import { register as csvMarkTests } from './tests/csvmark';
import { register as recentTests } from './tests/recent';
import { register as lockReasonsTests } from './tests/lockreasons';
import { register as placeholdersTests } from './tests/placeholders';
import { register as stateDefaultTests } from './tests/statedefault';
import { register as procNameTests } from './tests/procname';
import { register as hardeningTests } from './tests/hardening';
import { register as emptyDescTests } from './tests/emptydesc';

type T = { name: string; fn: () => unknown };
const tests: T[] = [];
const test = (name: string, fn: () => unknown) => tests.push({ name, fn });
const eq = (a: unknown, b: unknown, msg = '') => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg}\n  expected ${y}\n  actual   ${x}`);
};
const ok = (c: unknown, msg = 'assertion failed') => {
  if (!c) throw new Error(msg);
};
const throws = (fn: () => unknown, re?: RegExp) => {
  try {
    fn();
  } catch (e) {
    if (re && !re.test(String((e as Error)?.message))) throw new Error('threw the wrong error: ' + (e as Error)?.message);
    return;
  }
  throw new Error('expected an error');
};

// ---- labels ----
test('toLabels reads every language', () => eq(labels.toLabels({ LocalizedLabels: [{ Label: 'Name', LanguageCode: 1033 }, { Label: 'Nom', LanguageCode: 1036 }] }), { 1033: 'Name', 1036: 'Nom' }));
test('mergeInto keeps every other language and drops UserLocalizedLabel', () => {
  const src = { LocalizedLabels: [{ Label: 'Name', LanguageCode: 1033, IsManaged: false }, { Label: 'Name DE', LanguageCode: 1031 }], UserLocalizedLabel: { Label: 'Name', LanguageCode: 1033 } };
  const out = labels.mergeInto(src, [{ lcid: 1036, text: 'Nom' }, { lcid: 1031, text: 'Name (DE)' }]);
  eq(labels.toLabels(out), { 1033: 'Name', 1031: 'Name (DE)', 1036: 'Nom' });
  ok(!('UserLocalizedLabel' in out), 'UserLocalizedLabel kept');
  eq(src.LocalizedLabels[1].Label, 'Name DE', 'input mutated');
  eq((out.LocalizedLabels![0] as { IsManaged?: boolean }).IsManaged, false, 'other properties lost');
});
test('fromChanges builds a typed Label', () => {
  const l = labels.fromChanges([{ lcid: 1036, text: 'Nom' }]);
  eq(l['@odata.type'], 'Microsoft.Dynamics.CRM.Label');
  eq(l.LocalizedLabels, [{ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: 'Nom', LanguageCode: 1036 }]);
});
test('pick prefers the given languages', () => {
  eq(labels.pick({ 1033: 'A', 1036: 'B' }, 1036, 1033), 'B');
  eq(labels.pick({ 1033: 'A', 1036: '' }, 1036, 1033), 'A');
  eq(labels.pick({}, 1036), '');
});
test('stripAnnotations keeps @odata.type only', () =>
  eq(labels.stripAnnotations({ '@odata.type': 'x', '@odata.etag': 'y', 'Name@OData.Community.Display.V1.FormattedValue': 'z', A: [{ '@odata.context': 1, B: 2 }] }), { '@odata.type': 'x', A: [{ B: 2 }] }));

// ---- xml ----
const FORM = `<form><tabs><tab id="{A1}" name="t"><labels><label description="General" languagecode="1033" /></labels><columns><column width="100%"><sections><section id="{S1}"><labels><label description="Info" languagecode="1033" /></labels><rows><row><cell id="{C1}"><labels><label description="Name" languagecode="1033" /><label description="Nom" languagecode="1036" /></labels><control id="name" datafieldname="name" /></cell></row></rows></section></sections></column></columns></tab></tabs></form>`;
const isLabel = (el: Element) => el.tagName === 'label';
test('assertOnlyChanged accepts a label-only edit', () => {
  const a = xml.parseXml(FORM);
  const b = xml.parseXml(FORM);
  const cell = b.getElementsByTagName('cell')[0];
  xml.upsertLabel(b, cell, { container: 'labels', item: 'label', lcidAttr: 'languagecode', textAttr: 'description', lcid: 1031, text: 'Name DE' });
  xml.upsertLabel(b, cell, { container: 'labels', item: 'label', lcidAttr: 'languagecode', textAttr: 'description', lcid: 1036, text: 'Nom 2' });
  xml.assertOnlyChanged(a, b, isLabel);
  eq(xml.readLabels(cell, 'labels', 'label', 'languagecode', 'description'), { 1033: 'Name', 1036: 'Nom 2', 1031: 'Name DE' });
});
test('assertOnlyChanged rejects any other change', () => {
  const a = xml.parseXml(FORM);
  const b = xml.parseXml(FORM);
  b.getElementsByTagName('control')[0].setAttribute('datafieldname', 'other');
  throws(() => xml.assertOnlyChanged(a, b, isLabel), /Safety check/);
  const c = xml.parseXml(FORM);
  c.getElementsByTagName('row')[0].appendChild(c.createElement('cell'));
  throws(() => xml.assertOnlyChanged(a, c, isLabel), /Safety check/);
});
test('upsertLabel creates the container when missing', () => {
  const d = xml.parseXml('<SubArea Id="x"><Description LCID="1033" Description="d" /></SubArea>');
  xml.upsertLabel(d, d.documentElement, { container: 'Titles', item: 'Title', lcidAttr: 'LCID', textAttr: 'Title', lcid: 1036, text: 'Tous' });
  eq(xml.readLabels(d.documentElement, 'Titles', 'Title', 'LCID', 'Title'), { 1036: 'Tous' });
  ok(xml.serializeXml(d).includes('<Title LCID="1036" Title="Tous"/>') || xml.serializeXml(d).includes('<Title LCID="1036" Title="Tous" />'), xml.serializeXml(d));
});
test('removeLabel (when present) removes exactly one language', () => {
  const rm = (xml as Record<string, unknown>).removeLabel as undefined | ((...a: unknown[]) => unknown);
  if (!rm) return 'skipped: no removeLabel export';
  const a = xml.parseXml(FORM);
  const b = xml.parseXml(FORM);
  const cell = b.getElementsByTagName('cell')[0];
  rm(cell, { container: 'labels', item: 'label', lcidAttr: 'languagecode', lcid: 1036 });
  eq(xml.readLabels(cell, 'labels', 'label', 'languagecode', 'description'), { 1033: 'Name' });
  xml.assertOnlyChanged(a, b, isLabel);
});
test('normId and xmlAttr', () => {
  eq(xml.normId('{ABC-1}'), 'abc-1');
  eq(xml.xmlAttr('a&b<c>"d"\n'), 'a&amp;b&lt;c&gt;&quot;d&quot;&#xA;');
});
test('parseXml rejects broken XML', () => throws(() => xml.parseXml('<a><b></a>')));

// ---- zip ----
test('crc32 check value', () => eq(zipm.crc32(zipm.utf8('123456789')) >>> 0, 0xcbf43926));
test('zip/unzip round trip (deflate and store)', async () => {
  const big = 'Bonjour é ✓ '.repeat(5000);
  for (const store of [false, true]) {
    const z = await zipm.zip([{ name: 'a.txt', data: zipm.utf8('hello') }, { name: 'dir/b.xml', data: zipm.utf8(big) }] as never, store);
    const out = await zipm.unzip(z);
    eq(out.map((e) => e.name), ['a.txt', 'dir/b.xml']);
    eq(zipm.fromUtf8(out[1].data), big, 'content');
  }
});
test('base64 round trip', () => {
  const b = new Uint8Array(70000).map((_, i) => (i * 31) & 255);
  eq(Array.from(zipm.b64ToBytes(zipm.bytesToB64(b))).slice(0, 300), Array.from(b).slice(0, 300));
  eq(zipm.b64ToBytes(zipm.bytesToB64(b)).length, b.length);
});

// ---- csv ----
test('csv round trip with quotes, line breaks and formulas', () => {
  const rows = [['Key', '1033', '1036'], ['a|b', 'He said "hi", ok', 'ligne 1\nligne 2'], ['c', '=SUM(A1)', '-- None --'], ['d', '', '']];
  eq(csv.parseCsv(csv.toCsv(rows)), rows);
  ok(csv.toCsv([['=1+1']]).startsWith("'=1+1"), 'formula not neutralised');
});
test('csv reads semicolons and BOM', () => eq(csv.parseCsv('﻿Key;1033\r\nx;"a;b"\r\n'), [['Key', '1033'], ['x', 'a;b']]));

// ---- xlsx ----
test('xlsx round trip', async () => {
  const wide = Array.from({ length: 30 }, (_, i) => 'c' + i);
  const sheets = [
    { name: 'Entities', rows: [['Entity', 'Id', 'Type', 'English', 'Français'], ['account', 'abc', 'DisplayName', 'Account <&> "x"', 'Compte'], ['n', 5, null, '', 'é ✓ 中文']] },
    { name: 'Wide', rows: [wide] },
  ];
  const back = await xlsx.readXlsx(await xlsx.writeXlsx(sheets as never, { headerStyle: true, freezeHeader: true }));
  eq(back.map((s) => s.name), ['Entities', 'Wide']);
  const norm = (r: unknown[]) => r.map((v) => (v === null || v === undefined ? '' : String(v)));
  eq(norm(back[0].rows[1]), norm(sheets[0].rows[1]));
  eq(norm(back[0].rows[2]).filter(Boolean), ['n', '5', 'é ✓ 中文']);
  eq(norm(back[1].rows[0]), wide);
});

// ---- lcid ----
test('lcid helpers', () => {
  eq(lcid.lcidTag(1036), 'fr');
  eq(lcid.tagLcid('fr-CA'), 1036);
  ok(lcid.lcidName(1036).length > 2, 'name');
  eq(lcid.isRtl(1025), true);
  eq(lcid.isRtl(1036), false);
});

// ---- model ----
const slot = (kind: string, key = `${kind}|x|Label`, labelsIn: Record<number, string> = { 1033: 'Name', 1036: 'Nom' }): Slot =>
  ({ key, kind, prop: 'Label', entity: 'e', comp: key, group: 'g', title: 't', path: [], sub: '', labels: labelsIn, readOnly: '', baseRequired: true, max: 0, order: 0, ref: {} }) as unknown as Slot;
test('canClear: metadata, form tab/section/field and classic ribbon labels cannot be cleared', () => {
  for (const k of ['entity', 'attribute', 'relationship', 'option', 'globaloptionset', 'globaloption', 'boolean', 'state', 'status', 'tab', 'section', 'dtab', 'dsection', 'field', 'dfield', 'ribbon']) eq(canClear(slot(k)), false, k);
  for (const k of ['view', 'form', 'navitem', 'subarea', 'area', 'group', 'stage', 'step', 'bpf', 'command', 'app', 'chart', 'dashboard', 'envvar', 'customapi']) eq(canClear(slot(k)), true, k);
});
test("standIn: an emptied translation Dataverse can't remove is written as what that language shows without one: a form or dashboard cell's column name in that language, else its base-language name; anything else its base text", () => {
  const EN = 1033;
  const FR = 1036;
  /** Texts by `key#lcid`; a key left out is not loaded. */
  const texts = (m: Record<string, string>): TextOf => (k, l) => m[`${k}#${l}`];
  const cell = (kind: string, ref: object) => ({ ...slot(kind, `${kind}|f|c1|Label`, { [EN]: 'Customer', [FR]: 'Client' }), entity: 'acc', ref }) as Slot;
  const COL = 'attribute|acc.name|DisplayName';
  const col = { [`${COL}#${EN}`]: 'Account Name', [`${COL}#${FR}`]: 'Nom du compte' };
  // Metadata (and every other kind but a cell): the label's own base-language text.
  for (const k of ['entity', 'attribute', 'relationship', 'option', 'globaloptionset', 'globaloption', 'boolean', 'state', 'status', 'tab', 'section', 'dtab', 'dsection', 'ribbon']) {
    const s = slot(k);
    eq(standIn(s, FR, EN, 'Nom', '', texts({ [`${s.key}#${EN}`]: 'Name' })), { text: 'Name', from: 'base' }, k);
  }
  const attr = slot('attribute');
  const en = texts({ [`${attr.key}#${EN}`]: 'Name' });
  eq(standIn(attr, FR, EN, 'Nom', '  ', en), { text: 'Name', from: 'base' }, 'only spaces count as emptied');
  // Where the rule doesn't apply: the base language (its own rules), a text, nothing to empty, a removable translation.
  eq([standIn(attr, EN, EN, 'Name', '', en), standIn(attr, FR, EN, 'Nom', 'Nom 2', en), standIn(attr, FR, EN, '', ' ', en), standIn(slot('view'), FR, EN, 'Nom', '', en), standIn(slot('navitem'), FR, EN, 'Nom', '', en)], [undefined, undefined, undefined, undefined, undefined]);
  // Nothing known to stand in: refused, with the reason.
  eq(standIn(attr, FR, EN, 'Nom', '', texts({ [`${attr.key}#${EN}`]: ' ' })), { text: '', from: 'base', why: 'its English text is empty' });
  // Not known only because a text isn't loaded: held back (`unloaded`), not refused for good.
  eq(standIn(attr, FR, EN, 'Nom', '', texts({})), { text: '', from: 'base', why: "its English text isn't loaded", unloaded: true });
  // The text it replaces already (only spaces count as none): nothing changes.
  eq(standIn(attr, FR, EN, 'Name', '', en), { text: 'Name', from: 'base', same: true });
  // A form (or dashboard) cell that shows a column: the column's name in that language, else its base-language name.
  const f = cell('field', { formId: 'f', datafield: 'name', controlId: 'name' });
  eq(standIn(f, FR, EN, 'Client', '', texts(col)), { text: 'Nom du compte', from: 'column' });
  eq(standIn(f, FR, EN, 'Client', '', texts({ ...col, [`${COL}#${FR}`]: '' })), { text: 'Account Name', from: 'columnBase' });
  eq(standIn(cell('dfield', { formId: 'f', datafield: 'name', controlId: 'header_name' }), FR, EN, 'Client', '', texts(col)), { text: 'Nom du compte', from: 'column' }, 'a dashboard cell, a header copy');
  eq(standIn(f, FR, EN, 'Client', '', texts({})), { text: '', from: 'column', why: "its column's names aren't loaded", unloaded: true });
  eq(standIn(f, FR, EN, 'Client', '', texts({ [`${COL}#${EN}`]: 'Account Name' })), { text: '', from: 'column', why: "its column's names aren't loaded", unloaded: true }, 'its French name not loaded');
  eq(standIn(f, FR, EN, 'Account Name', '', texts({ ...col, [`${COL}#${FR}`]: '' })), { text: 'Account Name', from: 'columnBase', same: true });
  // What each is made of, which the saver reads again before writing it.
  eq([standInSources(attr, FR, EN, 'base'), standInSources(f, FR, EN, 'column'), standInSources(f, FR, EN, 'columnBase')], [
    [{ key: attr.key, lcid: EN }],
    [{ key: COL, lcid: FR }],
    [{ key: COL, lcid: FR }, { key: COL, lcid: EN }],
  ]);
  // A cell that shows no column (a sub-grid, a quick view): its own base text.
  const sub = cell('field', { formId: 'f', datafield: 'name', controlId: 'quickview1' });
  eq(standIn(sub, FR, EN, 'Client', '', texts({ ...col, [`${sub.key}#${EN}`]: 'Customer' })), { text: 'Customer', from: 'base' });
  // A process stage or step translation Dynamics keeps (stays): its own base text, never a step's column name.
  const stage = slot('stage', 'stage|w|s1|Label', { [EN]: 'Stage 1', [FR]: 'Étape 1' });
  const step = { ...slot('step', 'step|w|p1|Label', { [EN]: 'Account Name', [FR]: 'Nom' }), entity: 'acc', ref: { attribute: 'name' } } as Slot;
  eq(standIn(stage, FR, EN, 'Étape 1', '', texts({ [`${stage.key}#${EN}`]: 'Stage 1' })), { text: 'Stage 1', from: 'base' });
  eq(standIn(step, FR, EN, 'Nom', '', texts({ ...col, [`${step.key}#${EN}`]: 'Account' })), { text: 'Account', from: 'base' });
  eq(standIn(slot('stage', 'stage|w|s2|Label', { [EN]: 'Stage 2' }), FR, EN, 'x', '', texts({})), undefined, 'none loaded: nothing to remove, removable');
  // Their words.
  eq([standInText(attr, FR, EN, 'base'), standInText(f, FR, EN, 'column'), standInText(f, FR, EN, 'columnBase'), standInText(stage, FR, EN, 'base')], [
    "Dataverse can't remove a translation here, so French gets the English text.",
    "Dataverse can't remove a translation here, so French gets the column's French name.",
    "Dataverse can't remove a translation here, so French gets the column's English name.",
    "Dynamics keeps a stage's translation, so French gets the English text.",
  ]);
  eq([standInTag(attr, FR, EN, 'base'), standInTag(f, FR, EN, 'column'), standInTag(f, FR, EN, 'columnBase')], [
    "English text: Dataverse can't remove a translation",
    "The column's French name: Dataverse can't remove a translation",
    "The column's English name: Dataverse can't remove a translation",
  ]);
  eq([noStandIn(attr, FR, { why: 'its English text is empty', from: 'base' }), noStandIn(stage, FR, { why: 'its English text is empty', from: 'base' }, true)], [
    "Dataverse can't remove this translation, and its English text is empty: type the text instead.",
    "Dynamics keeps a stage's translation once it is stored, and its English text is empty, so the French text this save added stays. Change it in the editor if needed.",
  ]);
  // One unknown only because a text isn't loaded says what loads it.
  const nl = (s: Slot, undo = false) => noStandIn(s, FR, standIn(s, FR, EN, 'x', '', texts({})), undo);
  eq([nl(f), nl(attr), nl(f, true), nl(attr, true)], [
    "Dataverse can't remove this translation, and its column's names aren't loaded: load its table's columns to put the column's name in its place, or type the text.",
    "Dataverse can't remove this translation, and its English text isn't loaded: load its labels in all languages to put that text in its place, or type the text.",
    "Dataverse can't remove this translation, and its column's names aren't loaded here: load its table's columns, then undo again.",
    "Dataverse can't remove this translation, and its English text isn't loaded here: load its labels in all languages, then undo again.",
  ]);
  // What saving does, in the popup's line: becomes the stand-in, or nothing changes.
  eq([standInSays(attr, FR, EN, { text: 'Name', from: 'base' }), standInSays(attr, FR, EN, { text: 'Name', from: 'base', same: true }), standInSays(stage, FR, EN, { text: 'Stage 1', from: 'base', same: true })], [
    "Becomes “Name”: Dataverse can't remove a translation here, so French gets the English text.",
    "Already the English text: Dataverse can't remove a translation here, so nothing changes.",
    "Already the English text: Dynamics keeps a stage's translation, so nothing changes.",
  ]);
  // A count of them, in the rows' words: what they get, why they can't be removed.
  eq([standInsSaid([{ s: attr, l: FR, from: 'base' }], EN), standInsSaid([{ s: attr, l: FR, from: 'base' }, { s: f, l: FR, from: 'column' }], EN), standInsSaid([{ s: stage, l: FR, from: 'base' }], EN), standInsSaid([{ s: attr, l: FR, from: 'base' }, { s: stage, l: FR, from: 'base' }], EN)], [
    { what: 'the English text', why: "Dataverse can't remove it" },
    { what: "the English text or the column's French name", why: "Dataverse can't remove them" },
    { what: 'the English text', why: "Dynamics keeps a stage's translation" },
    { what: 'the English text', why: "they can't be removed" },
  ]);
});
test("standIn: measured by the texts as the run leaves them on the server: the changes it writes (a base text, a column's name, an undo's own earlier texts), else the server's as read or loaded, never a pending edit it doesn't write", () => {
  const EN = 1033;
  const FR = 1036;
  const st = new Store();
  const attr = { ...slot('attribute', 'attribute|acc.city|DisplayName', { [EN]: 'City', [FR]: 'Ville' }), prop: 'DisplayName' } as Slot;
  const col = { ...slot('attribute', 'attribute|acc.name|DisplayName', { [EN]: 'Account Name', [FR]: 'Nom' }), prop: 'DisplayName' } as Slot;
  const f = { ...slot('field', 'field|f|c1|Label', { [EN]: 'Customer', [FR]: 'Client' }), entity: 'acc', ref: { formId: 'f', datafield: 'name', controlId: 'name' } } as Slot;
  st.add([attr, col, f]);
  const ch = (s: Slot, l: number, after: string): Change => ({ slot: s, lcid: l, before: s.labels[l] ?? '', after });
  // A save: its base text changed in the same save, its column's French name too.
  const cs = [ch(attr, EN, 'Town'), ch(attr, FR, ''), ch(col, FR, 'Nom du compte'), ch(f, FR, '')];
  const ws = withStandIns(cs, EN, saveText(st, cs));
  eq(ws.map((c) => [c.after, c.standIn ?? null]), [['Town', null], ['Town', { from: 'base', typed: '' }], ['Nom du compte', null], ['Nom du compte', { from: 'column', typed: '' }]]);
  ok(ws[0] === cs[0] && ws[2] === cs[2], 'any other change is passed on as it is');
  eq(withStandIns(ws, EN, saveText(st, cs)), ws, 'applied once');
  // A pending edit the save doesn't write is not on the server after it: the server's text.
  st.set(col.key, FR, 'Nom 2');
  eq(withStandIns([ch(f, FR, '')], EN, saveText(st, [ch(f, FR, '')]))[0].after, 'Nom');
  // A read-only label is never written: no stand-in.
  const ro = { ...attr, key: 'attribute|acc.ro|DisplayName', readOnly: 'Managed' } as Slot;
  eq(withStandIns([ch(ro, FR, '')], EN, () => 'x')[0].after, '');
  // An undo: the texts it writes back (the entry's own `before`), else the server's, never a pending edit.
  const items = [
    { key: col.key, comp: col.comp, kind: 'attribute', lcid: FR, title: 'Name', before: '', after: 'Nom' },
    { key: f.key, comp: f.comp, kind: 'field', lcid: FR, title: 'Name', before: '', after: 'Client' },
  ] as HistoryItem[];
  const u = saveText(st, items.map((it) => ({ slot: st.get(it.key)!, lcid: it.lcid, before: it.after, after: it.before })));
  st.set(attr.key, FR, 'Ville 2');
  eq([u(col.key, FR), u(col.key, EN), u(attr.key, FR), u('attribute|acc.none|DisplayName', FR)], ['', 'Account Name', 'Ville', undefined]);
  // Texts read since the load (the Undo question's) count as the server's; never for a label not loaded.
  const read = saveText(st, [], new Map([[`${col.key}#${EN}`, 'Account'], ['attribute|acc.none|DisplayName#1036', 'X']]));
  eq([read(col.key, EN), read(col.key, FR), read('attribute|acc.none|DisplayName', FR)], ['Account', 'Nom', undefined]);
  // The column's French name goes too: the cell gets the column's English name (as the column itself does).
  eq(standIn(f, FR, EN, 'Client', '', u), { text: 'Account Name', from: 'columnBase' });
  eq(standIn(col, FR, EN, 'Nom', '', u), { text: 'Account Name', from: 'base' });
});

// ---- store ----
test('store: set, revert to original drops the edit, undo/redo', () => {
  const s = new Store();
  s.add([slot('attribute', 'a')]);
  s.set('a', 1036, 'Nom 2');
  eq(s.changes().map((c) => [c.before, c.after]), [['Nom', 'Nom 2']]);
  s.set('a', 1036, 'Nom');
  eq(s.changes().length, 0, 'setting back to the server value keeps an edit');
  s.set('a', 1031, 'Name DE');
  s.undo();
  eq(s.changes().length, 0, 'undo');
  s.redo();
  eq(s.value('a', 1031), 'Name DE', 'redo');
});
test('store: group is one undo step', () => {
  const s = new Store();
  s.add([slot('attribute', 'a'), slot('attribute', 'b')]);
  s.group(() => {
    s.set('a', 1036, 'x');
    s.set('b', 1036, 'y');
  });
  eq(s.pendingCount(), 2);
  s.undo();
  eq(s.pendingCount(), 0);
});
test('store: commit applies saved values, keeps conflicts', () => {
  const s = new Store();
  s.add([slot('attribute', 'a'), slot('attribute', 'b')]);
  s.set('a', 1036, 'x');
  s.set('b', 1036, 'y');
  const [ca, cb] = s.changes();
  s.commit([{ change: ca, outcome: 'saved' }, { change: cb, outcome: 'conflict', server: 'theirs' }]);
  eq(s.get('a')!.labels[1036], 'x');
  eq(s.isEdited('a', 1036), false);
  eq(s.isEdited('b', 1036), true);
  eq(s.cellStatus('b', 1036)?.outcome, 'conflict');
  s.resolve('b', 1036, false);
  eq(s.value('b', 1036), 'theirs');
});
test('store: an edit typed during the save survives commit', () => {
  const s = new Store();
  s.add([slot('attribute', 'a')]);
  s.set('a', 1036, 'x');
  const [c] = s.changes();
  s.set('a', 1036, 'xy'); // typed while the save of 'x' was running
  s.commit([{ change: c, outcome: 'saved' }]);
  eq(s.get('a')!.labels[1036], 'x', 'server value');
  eq(s.value('a', 1036), 'xy', 'newer edit lost');
  eq(s.changes().map((x) => [x.before, x.after]), [['x', 'xy']]);
});
test('store: refreshed slot drops edits equal to the server', () => {
  const s = new Store();
  s.add([slot('attribute', 'a')]);
  s.set('a', 1036, 'Nouveau');
  s.add([slot('attribute', 'a', { 1033: 'Name', 1036: 'Nouveau' })]);
  eq(s.pendingCount(), 0);
});

// ---- page mapping: which form cell a page control is (LIVE-FINDINGS 41) ----
const cell = (n: number, id: string, field: string, tab?: string, section?: string): Slot =>
  ({ ...slot('field', `field|form|cell${n}|Label`), comp: `field|form|cell${n}`, order: n, ref: { controlId: id, datafield: field, tabName: tab, sectionName: section } }) as unknown as Slot;
/** A minimal page index plus a fake form API: control name -> [column, section, tab] (null: no form API). */
const page = (cells: Slot[], ctls: Record<string, [string, string?, string?]> | null) => {
  const fields = new Map<string, Slot[]>();
  const cols = new Map<string, Slot[]>();
  for (const s of cells) {
    for (const [m, k] of [[fields, s.ref.controlId], [cols, s.ref.datafield]] as const) m.set(k.toLowerCase(), [...(m.get(k.toLowerCase()) || []), s]);
  }
  const control = (name: string) => {
    const c = ctls?.[name];
    if (!c) throw new Error('no such control');
    const parent = c[1] ? { getName: () => c[1], getParent: () => ({ getName: () => c[2] }) } : null;
    return {
      getName: () => name,
      getParent: () => parent,
      getAttribute: () => ({ getName: () => c[0], controls: { get: () => Object.keys(ctls!).filter((n) => ctls![n][0] === c[0]).map(control) } }),
    };
  };
  const xrm = { Page: { getControl: (n: string) => (ctls ? control(n) : (() => { throw new Error('no form API'); })()) } };
  return { fields, cells: cols, xrm } as unknown as Parameters<typeof fieldOf>[0];
};
test('fieldOf: each copy of a field placed several times maps to its own cell', () => {
  // The user's form: one column on three tabs, every cell with the same control id.
  const cs = [cell(1, 'contoso_regionrep', 'contoso_regionrep', 'tab_memo', 'section_memo_client'), cell(2, 'contoso_regionrep', 'contoso_regionrep', 'tab_recommendation', 'tab_4_section_1'), cell(3, 'contoso_regionrep', 'contoso_regionrep', 'tab_general', 'tab_general_section_12')];
  const api = page(cs, { contoso_regionrep: ['contoso_regionrep', 'section_memo_client', 'tab_memo'], contoso_regionrep1: ['contoso_regionrep', 'tab_4_section_1', 'tab_recommendation'], contoso_regionrep2: ['contoso_regionrep', 'tab_general_section_12', 'tab_general'] });
  eq(['contoso_regionrep', 'contoso_regionrep1', 'contoso_regionrep2'].map((n) => fieldOf(api, n)?.order), [1, 2, 3], 'with the form API');
  const noApi = page(cs, null);
  eq(['contoso_regionrep', 'contoso_regionrep1', 'contoso_regionrep2', 'contoso_regionrep3'].map((n) => fieldOf(noApi, n)?.order), [1, 2, 3, undefined], 'by copy number');
});
test('fieldOf: control ids ending in digits, and two copies in one section', () => {
  const cs = [cell(1, 'emailaddress1', 'emailaddress1', 't', 's'), cell(2, 'emailaddress1', 'emailaddress1', 't', 's2'), cell(3, 'telephone1', 'telephone1', 't', 's')];
  const noApi = page(cs, null);
  eq(['emailaddress1', 'emailaddress11', 'emailaddress12', 'telephone1', 'telephone11'].map((n) => fieldOf(noApi, n)?.order), [1, 2, undefined, 3, undefined]);
  // Same section twice: the order of the column's controls in that section decides.
  const two = [cell(1, 'name', 'name', 't', 's'), cell(2, 'name', 'name', 't', 's')];
  eq(['name', 'name1'].map((n) => fieldOf(page(two, { name: ['name', 's', 't'], name1: ['name', 's', 't'] }), n)?.order), [1, 2]);
});

// ---- each area's own test file (tools/dev/tests/*.ts) ----
for (const reg of [scanTests, describeTests, calloutTests, sheetsTests, gridTests, workbookTests, modeTests, overlayTests, overlayDomTests, savePathTests, langTests, storeTests, coldloadTests, partsTests, panesTests, ribbonTests, pillTests, navMenuTests, layersTests, bpfTests, contextTests, undoTests, pageListTests, revealTests, unmarkedTests]) reg({ test, eq, ok, slot: (k, key, l) => slot(k, key, l) });
for (const reg of [recordsTests, gridEditTests, metaRaceTests]) reg({ test, eq, ok, slot: (k, key, l) => slot(k, key, l) });
for (const reg of [bulkTests, fileIoTests]) reg({ test, eq, ok, slot: (k, key, l) => slot(k, key, l) });
for (const reg of [journalTests, devServerTests]) reg({ test, eq, ok, slot: (k, key, l) => slot(k, key, l) });
docWritesTests({ test, eq, ok, slot: (k, key, l) => slot(k, key, l) });
docRaceTests({ test, eq, ok, slot: (k, key, l) => slot(k, key, l) });
langDoubtTests({ test, eq, ok, slot: (k, key, l) => slot(k, key, l) });
pubScopeTests({ test, eq, ok, slot: (k, key, l) => slot(k, key, l) });
csvMarkTests({ test, eq, ok, slot: (k, key, l) => slot(k, key, l) });
recentTests({ test, eq, ok, slot: (k, key, l) => slot(k, key, l) });
lockReasonsTests({ test, eq, ok, slot: (k, key, l) => slot(k, key, l) });
placeholdersTests({ test, eq, ok, slot: (k, key, l) => slot(k, key, l) });
stateDefaultTests({ test, eq, ok, slot: (k, key, l) => slot(k, key, l) });
procNameTests({ test, eq, ok, slot: (k, key, l) => slot(k, key, l) });
hardeningTests({ test, eq, ok, slot: (k, key, l) => slot(k, key, l) });
emptyDescTests({ test, eq, ok, slot: (k, key, l) => slot(k, key, l) });

export async function run(): Promise<number> {
  let fail = 0;
  for (const t of tests) {
    try {
      const r = await t.fn();
      console.log(`  ${typeof r === 'string' && r.startsWith('skipped') ? '-' : '✓'} ${t.name}${typeof r === 'string' ? ' (' + r + ')' : ''}`);
    } catch (e) {
      fail++;
      console.log(`  ✗ ${t.name}\n    ${String((e as Error)?.stack || e).split('\n').slice(0, 4).join('\n    ')}`);
    }
  }
  console.log(`${tests.length - fail}/${tests.length} passed`);
  return fail;
}
