// Unit tests for the "N choices changed" pills (inspector/pill.ts): counting and wording, the column a field label
// or a value shows, and which fields get a pill (one per copy, after the value else the label; none in grids,
// dropdown lists, column headers or for read-only fields). The overlay's drawing of them is in overlay-dom.ts.
import type { Kind, Prop, Slot } from '../../../src/core/model';
import { Store } from '../../../src/core/store';
import { choiceColumn, choiceNote, choiceSet, choicesNote, fieldPills, fieldsAround, pillText, pillTitle, type PillHooks } from '../../../src/inspector/pill';
import type { Anchor, Role } from '../../../src/inspector/types';
import { El } from './fakedom';
import type { Kit } from './kit';

const EN = 1033;
const FR = 1036;
const LANGS = [EN, FR];

const S = (kind: Kind, comp: string, prop: Prop, labels: Record<number, string>, o: Partial<Slot> = {}): Slot => ({
  key: `${comp}|${prop}`,
  kind,
  prop,
  entity: 'account',
  comp,
  group: comp,
  title: labels[EN] || '',
  path: [],
  sub: '',
  labels,
  readOnly: '',
  baseRequired: true,
  max: 0,
  order: 0,
  ref: {},
  ...o,
});
const opt = (kind: Kind, comp: string, labels: Record<number, string>, ref: Record<string, unknown>, order: number, o: Partial<Slot> = {}) =>
  S(kind, comp, 'Label', labels, { ref, order, ...o });
const cell = (id: string, datafield: string, o: Partial<Slot> = {}) =>
  S('field', `field|f1|${id}`, 'Label', { [EN]: id }, { ref: { formId: 'f1', controlId: datafield || id, ...(datafield ? { datafield } : {}) }, ...o });

/** "Format du document": a local choice; Industry: a global one; a Yes/No; a status reason. */
function fixture(): Store {
  const s = new Store();
  const fmt = { entity: 'account', attribute: 'contoso_format' };
  s.add([
    opt('option', 'option|account.contoso_format|1', { [EN]: 'Email', [FR]: 'Courrier électronique' }, { ...fmt, value: 1 }, 0),
    S('option', 'option|account.contoso_format|1', 'Description', { [EN]: 'Sent by email' }, { ref: { ...fmt, value: 1 } }),
    opt('option', 'option|account.contoso_format|2', { [EN]: 'Paper' }, { ...fmt, value: 2 }, 1),
    opt('option', 'option|account.contoso_format|3', { [EN]: 'Fax', [FR]: 'Télécopie' }, { ...fmt, value: 3 }, 2),
    opt('globaloption', 'globaloption|industry|1', { [EN]: 'Accounting' }, { name: 'industry', value: 1, usedBy: ['Account.IndustryCode', 'lead.industrycode'] }, 0, { entity: '' }),
    opt('globaloption', 'globaloption|industry|2', { [EN]: 'Agriculture' }, { name: 'industry', value: 2, usedBy: ['Account.IndustryCode', 'lead.industrycode'] }, 1, { entity: '' }),
    opt('boolean', 'boolean|account.donotemail|0', { [EN]: 'Allow' }, { entity: 'account', attribute: 'donotemail', value: 0 }, 0),
    opt('boolean', 'boolean|account.donotemail|1', { [EN]: 'Do Not Allow' }, { entity: 'account', attribute: 'donotemail', value: 1 }, 1),
    opt('status', 'status|account.statuscode|1', { [EN]: 'Active' }, { entity: 'account', attribute: 'statuscode', value: 1 }, 0),
    cell('c1', 'contoso_format'),
    cell('c2', 'contoso_format'),
    cell('c3', 'industrycode'),
    cell('c4', 'donotemail'),
    cell('c5', 'contoso_format', { readOnly: 'Managed and not customizable.' }),
    cell('grid', ''),
    S('step', 'step|p1|s1', 'Label', { [EN]: 'Format' }, { ref: { attribute: 'contoso_format' } }),
  ]);
  return s;
}

/** Columns -> their options, as the page index keeps them (scan.ts buildIndex `opts`). */
function opts(store: Store): Map<string, Slot[]> {
  const m = new Map<string, Slot[]>();
  const add = (k: string, s: Slot) => m.set(k.toLowerCase(), [...(m.get(k.toLowerCase()) || []), s]);
  for (const s of store.slots.values()) {
    if (s.prop !== 'Label') continue;
    const r = s.ref || {};
    if (s.kind === 'globaloption') for (const u of r.usedBy || []) add(u, s);
    else if (['option', 'status', 'state', 'boolean'].includes(s.kind)) add(`${r.entity}.${r.attribute}`, s);
  }
  return m;
}

/** The controller's hooks (mode.ts), on a store. */
const hooks = (store: Store, ro = (a: Anchor) => !!store.get(a.key)?.readOnly): PillHooks => ({
  column: (a) => choiceColumn(store.get(a.key)),
  note: (col) => {
    const list = opts(store).get(col);
    return list ? choiceNote(store, LANGS, choiceSet(list).map((s) => s.key)) : null;
  },
  fields: fieldsAround,
  readOnly: ro,
});

const P1 = 'option|account.contoso_format|1|Label';
const P2 = 'option|account.contoso_format|2|Label';
const P3 = 'option|account.contoso_format|3|Label';
const FMT = [P1, P2, P3];

export function register(t: Kit): void {
  const { test, eq, ok } = t;

  test('pill: counts the pending choices of a column, 1 or N, and says it in a few words', () => {
    const s = fixture();
    eq(choiceNote(s, LANGS, FMT), null, 'nothing staged');
    s.set(P2, FR, 'Papier');
    const one = choiceNote(s, LANGS, FMT)!;
    eq(one, { n: 1, failed: 0, first: P2 });
    eq([pillText(one), pillTitle(one), choicesNote(one)], ['1 choice changed', '1 choice of this field changed, not published yet', '1 changed']);
    // A choice's description (the Workbench edits it) makes it pending too; the first is in option order.
    s.set('option|account.contoso_format|1|Description', FR, 'Envoyé par courriel');
    const two = choiceNote(s, LANGS, FMT)!;
    eq(two, { n: 2, failed: 0, first: P1 });
    eq([pillText(two), pillTitle(two), choicesNote(two)], ['2 choices changed', '2 choices of this field changed, not published yet', '2 changed']);
    // Undone: not counted any more.
    s.revert(P2);
    s.revert('option|account.contoso_format|1|Description');
    eq(choiceNote(s, LANGS, FMT), null);
  });

  test('pill: a failed publish wins the wording (red), counted with the staged ones', () => {
    const s = fixture();
    s.set(P2, FR, 'Papier');
    s.set(P3, FR, 'Fax');
    s.status.set(`${P3}#${FR}`, { outcome: 'error', message: 'Too long' });
    const n = choiceNote(s, LANGS, FMT)!;
    eq(n, { n: 2, failed: 1, first: P2 });
    eq([pillText(n), pillTitle(n), choicesNote(n)], ['2 choices not published', "2 choices of this field changed, not published yet; 1 couldn't be published", '2 not published']);
    // A conflict is a failed publish too; one that failed alone says so.
    s.revert(P2);
    s.status.set(`${P3}#${FR}`, { outcome: 'conflict', server: 'Télécopieur' });
    const c = choiceNote(s, LANGS, FMT)!;
    eq([c.n, c.failed, pillText(c), pillTitle(c)], [1, 1, '1 choice not published', "1 choice of this field couldn't be published"]);
    // A saved cell's status is no failure.
    s.status.set(`${P3}#${FR}`, { outcome: 'saved' });
    eq(choiceNote(s, LANGS, FMT)!.failed, 0);
  });

  test('pill: the column a field, a step or a value shows; a global choice and a Yes/No count like any choice', () => {
    const s = fixture();
    const col = (k: string) => choiceColumn(s.get(k));
    eq([col('field|f1|c1|Label'), col('step|p1|s1|Label'), col(P1)], ['account.contoso_format', 'account.contoso_format', 'account.contoso_format']);
    eq(col('globaloption|industry|2|Label'), 'account.industrycode', 'a global choice: the first column using it (the same set)');
    eq([col('boolean|account.donotemail|1|Label'), col('status|account.statuscode|1|Label')], ['account.donotemail', 'account.statuscode']);
    eq([col('field|f1|grid|Label'), col('nothing')], ['', ''], 'a sub-grid cell shows no column');
    // Its choices as the popup lists them: the column's own, else the global choice's.
    const o = opts(s);
    eq(choiceSet(o.get('account.industrycode')!).map((x) => x.key), ['globaloption|industry|1|Label', 'globaloption|industry|2|Label']);
    eq(choiceSet([...o.get('account.contoso_format')!, ...o.get('account.industrycode')!]).length, 3, 'its own options win');
    s.set('globaloption|industry|2|Label', FR, 'Agriculture (FR)');
    s.set('boolean|account.donotemail|1|Label', FR, 'Ne pas autoriser');
    const h = hooks(s);
    eq([h.note('account.industrycode')?.n, h.note('lead.industrycode')?.n, h.note('account.donotemail')?.first], [1, 1, 'boolean|account.donotemail|1|Label']);
    eq(h.note('account.statuscode'), null);
  });

  test('pill: one per field copy, after its value (the last one first), else after its label', () => {
    const s = fixture();
    s.set(P2, FR, 'Papier');
    const L = (key: string, hit: El, role: Role = 'label'): Anchor => ({ el: hit, hit, comp: s.get(key)!.comp, kind: s.get(key)!.kind, key, role }) as unknown as Anchor;
    const V = (key: string, zone: El): Anchor => ({ el: zone, zone, comp: s.get(key)!.comp, kind: s.get(key)!.kind, key, role: 'value', focus: key }) as unknown as Anchor;
    const box = (id: string, ...kids: El[]) => new El('div', { 'data-id': `${id}-FieldSectionItemContainer` }).add(...kids);
    // "Format du document" shows Email; its copy on another tab shows nothing ("---": no value anchor).
    const v1 = new El('div', { 'data-id': 'contoso_format.fieldControl-option-set-select' });
    const c1 = box('contoso_format', v1);
    const c2 = box('contoso_format1');
    // A multi-select-like field showing two values; a field whose label is hidden on the form shows its value only.
    const m1 = new El('span');
    const m2 = new El('span');
    const c3 = box('other', new El('div').add(m1, m2));
    const v4 = new El('div');
    const c4 = box('hidden_label', v4);
    new El('section').add(c1, c2, c3, c4);
    const a1 = L('field|f1|c1|Label', c1);
    const a2 = L('field|f1|c2|Label', c2);
    const x1 = V(P1, v1);
    const y1 = V(P1, m1);
    const y2 = V(P3, m2);
    const z = V(P2, v4);
    const ps = fieldPills([a1, x1, a2, L('field|f1|c1|Label', c3), y1, y2, z], hooks(s));
    eq(ps.map((p) => [p.at.map((a) => (a === a1 ? 'a1' : a === x1 ? 'x1' : a === a2 ? 'a2' : a === y1 ? 'y1' : a === y2 ? 'y2' : a === z ? 'z' : 'c3')), p.text, p.tone]), [
      [['x1', 'a1'], '1 choice changed', 'edited'],
      [['a2'], '1 choice changed', 'edited'],
      [['y2', 'y1', 'c3'], '1 choice changed', 'edited'],
      [['z'], '1 choice changed', 'edited'],
    ]);
    eq(ps[0].title, '1 choice of this field changed, not published yet');
    // Each stays inside its own field container (overlay.ts): the label's, else the one around the value.
    ok([c1, c2, c3, c4].every((c, i) => ps[i].field === (c as unknown as Element)), 'its field');
    eq(ps.map((p) => p.n), [1, 1, 1, 1], 'the count it shows where its text does not fit');
    s.revert(P2);
    eq(fieldPills([a1, x1, a2], hooks(s)), [], 'undone: no pill');
  });

  test('pill: none for grids, dropdown lists, column headers, read-only fields or columns without a pending choice', () => {
    const s = fixture();
    s.set(P2, FR, 'Papier');
    s.set('globaloption|industry|1|Label', FR, 'Comptabilité');
    const A = (key: string, el: El, role: Role, o: Partial<Anchor> = {}): Anchor => ({ el, comp: s.get(key)?.comp ?? key, kind: s.get(key)?.kind ?? 'attribute', key, role, ...o }) as unknown as Anchor;
    // A list row and a sub-grid placed on the form: their cells show values of a pending column.
    const cellEl = new El('div', { role: 'gridcell' });
    new El('div', { role: 'grid' }).add(new El('div', { role: 'row' }).add(cellEl));
    const subCell = new El('div', { role: 'gridcell' });
    const sub = new El('div', { 'data-id': 'Contacts-FieldSectionItemContainer' }).add(new El('div', { role: 'grid' }).add(subCell));
    // An open dropdown list (portaled, or inside the field): its choices are 'option' anchors, each with its own mark.
    const lb = new El('div', { role: 'listbox' });
    lb.add(new El('div', { role: 'option' }));
    new El('div', { 'data-id': 'contoso_format-FieldSectionItemContainer' }).add(lb);
    // A read-only field, and a field whose column has no pending choice (or no choices).
    const ro = new El('div', { 'data-id': 'ro-FieldSectionItemContainer' });
    const yn = new El('div', { 'data-id': 'donotemail-FieldSectionItemContainer' });
    const ps = fieldPills(
      [
        A(P1, cellEl, 'value'),
        A(P1, subCell, 'value'),
        A('field|f1|grid|Label', sub, 'label', { hit: sub }),
        A('attribute|account.contoso_format|DisplayName', new El('div', { role: 'columnheader' }), 'header'),
        A(P2, lb.children[0], 'option'),
        A('field|f1|c5|Label', ro, 'label', { hit: ro }),
        A('field|f1|c4|Label', yn, 'label', { hit: yn }),
      ],
      hooks(s),
    );
    eq(ps, []);
    // The same read-only field, were it editable: a pill.
    eq(fieldPills([A('field|f1|c5|Label', ro, 'label', { hit: ro })], hooks(s, () => false)).length, 1);
    // A global choice's field and a process step get theirs.
    const ind = new El('div', { 'data-id': 'industrycode-FieldSectionItemContainer' });
    const st = new El('div', { 'data-id': 'header_process_contoso_format-FieldSectionItemContainer' });
    const both = fieldPills([A('field|f1|c3|Label', ind, 'label', { hit: ind }), A('step|p1|s1|Label', st, 'label', { hit: st })], hooks(s));
    eq(both.map((p) => p.text), ['1 choice changed', '1 choice changed']);
    ok(both[1].field === (st as unknown as Element), "the step's container (its popup lists the column's choices: describe.ts)");
  });

  test('pill: a header strip value finds its field across the shadow root; a quick view title is no field of its values', () => {
    // The header strip: the item is in the list's shadow root, the value control inside the item.
    const item = new El('uci-header-control-list-item', { 'data-name': 'header_contoso_format' });
    const value = new El('div');
    item.add(value);
    const host = new El('uci-header-control-list');
    // As in the DOM: a shadow root's child has no parent element, the root (whose host is the list) is its parent node.
    Object.assign(item, { parentNode: { host } });
    ok(fieldsAround({ el: value, zone: value } as unknown as Anchor)[0] === item, 'the item');
    // Crossing out of the shadow root: the header control list's own field container around it counts too.
    const outer = new El('div', { 'data-id': 'header_x-FieldSectionItemContainer' }).add(host);
    eq(fieldsAround({ el: value } as unknown as Anchor).length, 2);
    ok(fieldsAround({ el: value } as unknown as Anchor)[1] === outer);
    // A quick view on the form: its own cell holds the quick view's fields; their values belong to the inner field.
    const s = fixture();
    s.set(P2, FR, 'Papier');
    const v = new El('div');
    const inner = new El('div', { 'data-id': 'qv.contoso_format-FieldSectionItemContainer' }).add(v);
    const qv = new El('div', { 'data-id': 'linkedqv-FieldSectionItemContainer' }).add(inner);
    const title = { el: qv, hit: qv, comp: 'field|f1|grid', kind: 'field', key: 'field|f1|grid|Label', role: 'label' } as unknown as Anchor;
    const val = { el: v, zone: v, comp: s.get(P1)!.comp, kind: 'option', key: P1, role: 'value' } as unknown as Anchor;
    const ps = fieldPills([title, val], hooks(s));
    eq(ps.map((p) => p.at.length), [1], 'after the value, never after the quick view title');
    ok(ps[0].at[0] === val);
  });
}
