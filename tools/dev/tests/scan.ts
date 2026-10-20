// Unit tests for the scan area (page -> component mapping and page loads). register() is called by tools/dev/unit.ts.
// DOM-free: the pure helpers, plus fieldOf/ctlSlot against a fake page index and a fake form API.
import type { Slot } from '../../../src/core/model';
import { Store } from '../../../src/core/store';
import { colKey, ctlColumn, ctlOf, ctlSlot, fieldIn, fieldOf, formMoved, optionByText, optionByValue, relatedMenu, type FormCells, type PageIndex } from '../../../src/inspector/scan';
import { splitValues } from '../../../src/inspector/parts';
import { isGridType, isModern, mergeUsedBy, PageLoader, WANT_FORM_NAME, WANT_TABLE, WANT_VIEW_NAME } from '../../../src/inspector/pageload';
import type { Kit } from './kit';

const EN = 1033;
const FR = 1036;

export function register(t: Kit): void {
  const { test, eq, ok } = t;

  /** An option label slot of column e.a with this value. */
  const opt = (v: number, labels: Record<number, string>, kind = 'option', col = 'e.a'): Slot => {
    const comp = `${kind}|${col}|${v}`;
    const [entity, attribute] = col.split('.');
    return { ...t.slot(kind, `${comp}|Label`, labels), comp, ref: { entity, attribute, value: v } } as Slot;
  };
  const keyOf = (s: Slot | undefined) => s?.comp;

  // ---- option text matching (grid cells, closed controls, open dropdowns) ----

  test('optionByText: the user language, then the base language, then any language', () => {
    const list = [opt(1, { [EN]: 'Active', [FR]: 'Actif' }), opt(2, { [EN]: 'Inactive', [FR]: 'Inactif' }), opt(3, { [EN]: 'Pending' })];
    eq(keyOf(optionByText(list, 'Actif', FR, EN)), 'option|e.a|1', 'user language');
    eq(keyOf(optionByText(list, '  ACTIF  ', FR, EN)), 'option|e.a|1', 'normalized');
    eq(keyOf(optionByText(list, 'Pending', FR, EN)), 'option|e.a|3', 'no French label: Dynamics shows the base one');
    eq(keyOf(optionByText(list, 'Inactive', FR, EN)), 'option|e.a|2', 'any language (preview on)');
    eq(optionByText(list, 'Unknown', FR, EN), undefined, 'record data is never an option');
    eq(optionByText(list, '', FR, EN), undefined, 'blank');
    eq(optionByText([], 'Actif', FR, EN), undefined, 'no options');
  });

  test('optionByText: a text two options show is refused, and what is shown wins over other languages', () => {
    const twins = [opt(1, { [EN]: 'Open', [FR]: 'Ouvert' }), opt(2, { [EN]: 'Open (other state)', [FR]: 'Ouvert' })];
    eq(optionByText(twins, 'Ouvert', FR, EN), undefined, 'two status reasons with one label');
    // F shows 'Y' in French, G has no French and shows its base 'Y': ambiguous on the page.
    eq(optionByText([opt(1, { [EN]: 'X', [FR]: 'Y' }), opt(2, { [EN]: 'Y' })], 'Y', FR, EN), undefined, 'shown twice');
    // 'Bas' is shown only by H (I shows 'Faible'), though I's English label is 'Bas' too.
    eq(keyOf(optionByText([opt(1, { [EN]: 'Low', [FR]: 'Bas' }), opt(2, { [EN]: 'Bas', [FR]: 'Faible' })], 'Bas', FR, EN)), 'option|e.a|1', 'shown first');
  });

  test('optionByValue: numbers and Yes/No booleans; nothing for blanks, arrays and duplicates', () => {
    const yesNo = [opt(0, { [EN]: 'No', [FR]: 'Non' }, 'boolean'), opt(1, { [EN]: 'Yes', [FR]: 'Oui' }, 'boolean')];
    eq(keyOf(optionByValue(yesNo, true)), 'boolean|e.a|1');
    eq(keyOf(optionByValue(yesNo, false)), 'boolean|e.a|0');
    const list = [opt(100000000, { [EN]: 'Red' }), opt(100000001, { [EN]: 'Blue' })];
    eq(keyOf(optionByValue(list, 100000001)), 'option|e.a|100000001');
    eq(keyOf(optionByValue(list, '100000000')), 'option|e.a|100000000', 'numeric text');
    for (const v of [null, undefined, '', [100000000], NaN, 'x', 5]) eq(optionByValue(list, v), undefined, String(v));
    eq(optionByValue([...list, opt(100000000, { [EN]: 'Red again' }, 'option', 'e.b')], 100000000), undefined, 'two options with that value');
  });

  test('multi-select texts: every value is its own option, split only where the split is certain', () => {
    const list = [opt(1, { [EN]: 'Red', [FR]: 'Rouge' }), opt(2, { [EN]: 'Blue', [FR]: 'Bleu' }), opt(3, { [EN]: 'Green', [FR]: 'Vert' }), opt(4, { [EN]: 'Yes, maybe', [FR]: 'Oui, peut-être' })];
    const pick = (v: string) => optionByText(list, v, FR, EN);
    const parts = (text: string) => splitValues(text, list, pick)?.map((p) => [p.part.start, p.part.end, p.part.text, p.slot.comp]) ?? null;
    eq(parts('Rouge, Vert'), [
      [0, 5, 'Rouge', 'option|e.a|1'],
      [7, 11, 'Vert', 'option|e.a|3'],
    ], 'grid cell, French UI (LIVE-FINDINGS 55)');
    eq(parts('Red; Blue ;  Green')?.map((p) => p[3]), ['option|e.a|1', 'option|e.a|2', 'option|e.a|3'], 'semicolons, any spacing, base-language labels');
    eq(parts(' Bleu, Oui, peut-être, Rouge')?.map((p) => p[2]), ['Bleu', 'Oui, peut-être', 'Rouge'], 'a label holding a comma');
    eq(parts('Rouge'), null, 'one value: the whole text is that option');
    eq(parts('Rouge, Something else'), null, 'record data, not a list of options');
    eq(parts('Rouge,'), null, 'a dangling separator');
    // "A" and "A, B" are both labels: "A, B" reads as one value or as two. Never guessed.
    const amb = [opt(1, { [EN]: 'A' }), opt(2, { [EN]: 'B' }), opt(3, { [EN]: 'A, B' })];
    eq(splitValues('A, B', amb, (v) => optionByText(amb, v, FR, EN)), null, 'two readings');
    eq(splitValues('B, A, B', amb, (v) => optionByText(amb, v, FR, EN)), null, 'two readings further on');
    // Two options showing one text: that value gets no option (never one of them), the others still do.
    const twins = [opt(1, { [EN]: 'Red' }), opt(2, { [EN]: 'Red' }), opt(3, { [EN]: 'Blue' })];
    eq(splitValues('Red, Blue', twins, (v) => optionByText(twins, v, FR, EN))?.map((p) => p.slot.comp), ['option|e.a|3']);
  });

  test('colKey and ctlOf read grid keys and control names', () => {
    eq(colKey('_parentcustomerid_value'), 'parentcustomerid', 'lookup value column');
    eq(colKey(' StatusCode '), 'statuscode');
    eq(colKey('a_0d8f.emailaddress1'), '', 'linked-table column');
    eq(colKey(''), '');
    eq(colKey(null), '');
    eq(ctlOf('header_statuscode.fieldControl-pickliststatus-comboBox'), 'header_statuscode');
    eq(ctlOf('new_paid.fieldControl-toggle-container'), 'new_paid');
    eq(ctlOf('name-FieldSectionItemContainer'), '');
    eq(ctlOf(undefined), '');
  });

  // ---- which form cell a page control is (LIVE-FINDINGS 41) ----

  const cell = (n: number, id: string, field: string, tab?: string, section?: string, area = 'body'): Slot =>
    ({ ...t.slot('field', `field|form|cell${n}|Label`), comp: `field|form|cell${n}`, order: n, ref: { controlId: id, datafield: field, tabName: tab, sectionName: section, area } }) as Slot;

  /**
   * A fake page index. ctls: control name -> [column, section, tab] (no section: header/footer); null = no form API.
   * A column written 'qv:<col>' is a quick view's: the control reports <col>, but it is bound to another record's
   * column, so the page's own attribute <col> does not list it. `vals`: column -> value (getValue).
   */
  const page = (cells: Slot[], ctls: Record<string, [string, string?, string?]> | null, more: Partial<PageIndex> = {}, vals: Record<string, unknown> = {}): PageIndex => {
    const fields = new Map<string, Slot[]>();
    const cols = new Map<string, Slot[]>();
    for (const s of cells)
      for (const [m, k] of [
        [fields, s.ref.controlId],
        [cols, s.ref.datafield],
      ] as const)
        if (k) m.set(k.toLowerCase(), [...(m.get(k.toLowerCase()) || []), s]);
    const attrs = new Map<string, object>();
    // Bound column -> its attribute ('qv:' columns get one of their own, like a quick view's record).
    const attribute = (bound: string): object => {
      const col = bound.replace(/^qv:/, '');
      return (
        attrs.get(bound) ||
        (attrs.set(bound, {
          getName: () => col,
          getValue: () => vals[col] ?? null,
          controls: { get: () => Object.keys(ctls!).filter((n) => ctls![n][0] === bound).map(control) },
        }),
        attrs.get(bound)!)
      );
    };
    const control = (name: string) => {
      const c = ctls?.[name];
      if (!c) return null; // like Xrm: a control the form doesn't have
      const parent = c[1] ? { getName: () => c[1], getParent: () => ({ getName: () => c[2] }) } : null;
      return { getName: () => name, getParent: () => parent, getAttribute: () => attribute(c[0]) };
    };
    const xrm = {
      Page: {
        getControl: (n: string) => {
          if (!ctls) throw new Error('no form API');
          return control(n);
        },
        // The page record's own columns only.
        getAttribute: (col: string) => (ctls && Object.values(ctls).some((c) => c[0] === col) ? attribute(col) : null),
        data: { process: { getSelectedStage: () => ({ getId: () => '{STAGE-2}' }) } },
      },
    };
    return { fields, cells: cols, xrm, entity: 'e', main: new Map(), names: new Map(), formReady: cells.length > 0, ...more } as unknown as PageIndex;
  };

  test('fieldOf: every copy of a field placed three times maps to its own cell (with and without the form API)', () => {
    const cs = [cell(1, 'owner', 'owner', 'tab_memo', 'client'), cell(2, 'owner', 'owner', 'tab_reco', 'tab_4_section_1'), cell(3, 'owner', 'owner', 'tab_general', 'general_12')];
    const api = page(cs, { owner: ['owner', 'client', 'tab_memo'], owner1: ['owner', 'tab_4_section_1', 'tab_reco'], owner2: ['owner', 'general_12', 'tab_general'] });
    eq(['owner', 'owner1', 'owner2'].map((n) => fieldOf(api, n)?.order), [1, 2, 3], 'form API');
    eq(['owner', 'owner1', 'owner2', 'owner3'].map((n) => fieldOf(page(cs, null), n)?.order), [1, 2, 3, undefined], 'copy number');
  });

  test('fieldOf: header and body copies, and copies in one section ordered by the form API', () => {
    const cs = [cell(1, 'header_name', 'name', undefined, undefined, 'header'), cell(2, 'name', 'name', 't', 's'), cell(3, 'name', 'name', 't', 's')];
    // The header control and a business process step control of the same column are no body copies.
    const x = page(cs, { header_name: ['name'], header_process_name: ['name'], name: ['name', 's', 't'], name1: ['name', 's', 't'] });
    eq(['header_name', 'name', 'name1'].map((n) => fieldOf(x, n)?.order), [1, 2, 3]);
  });

  test('fieldOf: a quick view field bound to a column of the same name is never the page form cell', () => {
    // The page form places emailaddress1 in t/s; the quick view's form uses the same tab and section names.
    const cs = [cell(1, 'emailaddress1', 'emailaddress1', 'tab_1', 'tab_1_section_1')];
    const x = page(cs, { emailaddress1: ['emailaddress1', 'tab_1_section_1', 'tab_1'], contactqv_contactqv_contact_emailaddress1: ['emailaddress1', 'tab_1_section_1', 'tab_1'] });
    eq(fieldOf(x, 'contactqv_contactqv_contact_emailaddress1'), undefined);
    eq(fieldOf(x, 'emailaddress1')?.order, 1);
  });

  test('fieldOf: when the form API and the form XML disagree, only a single placement is certain', () => {
    // A maker moved the field to another section without publishing: the page still shows it in s1.
    eq(fieldOf(page([cell(1, 'name', 'name', 't', 's2')], { name: ['name', 's1', 't'] }), 'name')?.order, 1, 'moved, placed once');
    // Two copies on the page, but only one cell has an id in the form XML: the plain name is the copy without a cell.
    const one = [cell(2, 'name', 'name', 't', 's2')];
    const x = page(one, { name: ['name', 's1', 't'], name1: ['name', 's2', 't'] });
    eq(fieldOf(x, 'name'), undefined, 'never the other copy');
    eq(fieldOf(x, 'name1')?.order, 2);
  });

  test('fieldOf: unbound controls (sub-grids) and dashboards map by name', () => {
    const grid = cell(1, 'Contacts', '', 't', 's');
    grid.ref.datafield = undefined;
    eq(fieldOf(page([grid], { other: ['x', 's', 't'] }), 'Contacts')?.order, 1, 'getControl gives nothing to read a column from');
    eq(fieldOf(page([grid], null), 'contacts')?.order, 1, 'no form API, any case');
  });

  test('fieldOf: the Contoso form (copies 5-7 of contoso_client, copies 21-22 of the column contoso_client2)', () => {
    // contoso_client1..4 are taken by other controls, so the copies of contoso_client are named 5, 6, 7 (live probe);
    // contoso_client2 is a column of its own, placed three times; contoso_client1 another column, placed once.
    const cs = [
      cell(1, 'contoso_client', 'contoso_client', 'tab_memo', 'memo_client'),
      cell(2, 'contoso_client1', 'contoso_client1', 'tab_memo', 'memo_client'),
      cell(3, 'contoso_client2', 'contoso_client2', 'tab_memo', 'memo_client2'),
      cell(4, 'contoso_client', 'contoso_client', 'tab_reco', 'reco_1'),
      cell(5, 'contoso_client2', 'contoso_client2', 'tab_reco', 'reco_2'),
      cell(6, 'contoso_client', 'contoso_client', 'tab_general', 'general_1'),
      cell(7, 'contoso_client2', 'contoso_client2', 'tab_general', 'general_2'),
      cell(8, 'contoso_client', 'contoso_client', 'tab_admin', 'admin_1'),
    ];
    const api = page(cs, {
      contoso_client: ['contoso_client', 'memo_client', 'tab_memo'],
      contoso_client1: ['contoso_client1', 'memo_client', 'tab_memo'],
      contoso_client2: ['contoso_client2', 'memo_client2', 'tab_memo'],
      contoso_client5: ['contoso_client', 'reco_1', 'tab_reco'],
      contoso_client21: ['contoso_client2', 'reco_2', 'tab_reco'],
      contoso_client6: ['contoso_client', 'general_1', 'tab_general'],
      contoso_client22: ['contoso_client2', 'general_2', 'tab_general'],
      contoso_client7: ['contoso_client', 'admin_1', 'tab_admin'],
    });
    const names = ['contoso_client', 'contoso_client1', 'contoso_client2', 'contoso_client5', 'contoso_client21', 'contoso_client6', 'contoso_client22', 'contoso_client7'];
    eq(names.map((n) => fieldOf(api, n)?.order), [1, 2, 3, 4, 5, 6, 7, 8], 'form API: every copy is its own cell');
    // Without the form API the name decides: 21 and 22 are copies 1 and 2 of contoso_client2; 5-7 can't be told
    // apart from copies 5-7 of a field placed 4 times, so they get no cell rather than a wrong one.
    const no = page(cs, null);
    eq(names.map((n) => fieldOf(no, n)?.order), [1, 2, 3, undefined, 5, undefined, 7, undefined], 'by name');
  });

  test('fieldOf: columns ending in digits are distinct columns, not copies (contoso_themelevel1/2/3)', () => {
    const cs = [
      cell(1, 'contoso_themelevel1', 'contoso_themelevel1', 't', 's'),
      cell(2, 'contoso_themelevel2', 'contoso_themelevel2', 't', 's'),
      cell(3, 'contoso_themelevel3', 'contoso_themelevel3', 't', 's'),
      cell(4, 'contoso_themelevel1', 'contoso_themelevel1', 't2', 's2'),
    ];
    const ctls: Record<string, [string, string?, string?]> = {
      contoso_themelevel1: ['contoso_themelevel1', 's', 't'],
      contoso_themelevel2: ['contoso_themelevel2', 's', 't'],
      contoso_themelevel3: ['contoso_themelevel3', 's', 't'],
      contoso_themelevel11: ['contoso_themelevel1', 's2', 't2'],
    };
    const names = ['contoso_themelevel1', 'contoso_themelevel2', 'contoso_themelevel3', 'contoso_themelevel11'];
    eq(names.map((n) => fieldOf(page(cs, ctls), n)?.order), [1, 2, 3, 4], 'form API');
    eq(names.map((n) => fieldOf(page(cs, null), n)?.order), [1, 2, 3, 4], 'by name');
    // contoso_themelevel2 is not in the form XML (added without publishing) while a column contoso_themelevel is
    // placed three times: the control is never taken for copy 2 of contoso_themelevel.
    const base = [cell(1, 'contoso_themelevel', 'contoso_themelevel', 't', 'a'), cell(2, 'contoso_themelevel', 'contoso_themelevel', 't', 'b'), cell(3, 'contoso_themelevel', 'contoso_themelevel', 't', 'c')];
    const added = page(base, { contoso_themelevel: ['contoso_themelevel', 'a', 't'], contoso_themelevel2: ['contoso_themelevel2', 'b', 't'] });
    eq(fieldOf(added, 'contoso_themelevel2'), undefined, 'the form API knows its column');
  });

  test('fieldOf: two copies in one section map only when the controls and the cells agree one to one', () => {
    const two = [cell(1, 'name', 'name', 't', 's'), cell(2, 'name', 'name', 't', 's')];
    // Dynamics numbers copies in form XML order; the API listing them the other way round is a contradiction.
    const rev = page(two, { name1: ['name', 's', 't'], name: ['name', 's', 't'] });
    eq(['name', 'name1'].map((n) => fieldOf(rev, n)?.order), [undefined, undefined], 'API order and copy numbers disagree');
    // The published form shows one copy in s (the other was moved there without publishing): which one is unknown.
    const one = page(two, { name: ['name', 's', 't'], name1: ['name', 's9', 't'] });
    eq(fieldOf(one, 'name'), undefined, 'one control, two cells');
  });

  // ---- label slot of a control: the column only for true orphans of a loaded form ----

  const column = (a: string): Slot => ({ ...t.slot('attribute', `attribute|e.${a}|DisplayName`), comp: `attribute|e.${a}`, prop: 'DisplayName', ref: { entity: 'e', attribute: a } }) as Slot;

  test('ctlSlot: no column while the form labels are not loaded, or when the form places the column', () => {
    const col = column('new_extra');
    const main = new Map([[col.comp, col]]);
    const ctls: Record<string, [string, string?, string?]> = { new_extra: ['new_extra', 's', 't'] };
    eq(ctlSlot(page([], ctls, { main, formReady: false }), 'new_extra'), undefined, 'form XML loading, failed or unknown');
    eq(ctlSlot(page([], ctls, { main, formReady: true }), 'new_extra')?.key, col.key, 'loaded, and the form has no cell for it');
    // The form places the column twice, but the control can't be matched to a copy: no anchor, not the column.
    const placed = [cell(1, 'new_extra', 'new_extra', 't', 's9'), cell(2, 'new_extra', 'new_extra', 't', 's8')];
    const name = column('new_extra');
    eq(ctlSlot(page(placed, ctls, { main: new Map([[name.comp, name]]) }), 'new_extra'), undefined);
  });

  test('ctlSlot: a copy of a column ending in digits (contoso_client21) never stands for the column while the form places it', () => {
    const c2 = column('contoso_client2');
    const main = new Map([[c2.comp, c2]]);
    // The form places contoso_client2 twice; the control is in a section without a cell (unpublished move).
    const placed = [cell(1, 'contoso_client2', 'contoso_client2', 't', 's1'), cell(2, 'contoso_client2', 'contoso_client2', 't', 's2')];
    const ctls: Record<string, [string, string?, string?]> = { contoso_client2: ['contoso_client2', 's1', 't'], contoso_client21: ['contoso_client2', 's3', 't'] };
    eq(ctlSlot(page(placed, ctls, { main }), 'contoso_client21'), undefined, 'placed: unknown, not the column');
    eq(ctlSlot(page(placed, ctls, { main }), 'contoso_client2')?.order, 1);
    // A loaded form that doesn't place the column at all: its copies stand for the column.
    const other = [cell(1, 'name', 'name', 't', 's1')];
    eq(ctlSlot(page(other, ctls, { main }), 'contoso_client21')?.key, c2.key, 'orphan copy');
    eq(ctlSlot(page(other, ctls, { main, formReady: false }), 'contoso_client21'), undefined, 'form labels not loaded');
    // A quick view constituent bound to a column of the same name is never the page's column.
    const qv = { contactqv_contactqv_contact_contoso_client2: ['contoso_client2', 's1', 't'] as [string, string, string] };
    eq(ctlSlot(page(other, qv, { main }), 'contactqv_contactqv_contact_contoso_client2'), undefined, 'quick view');
  });

  test('ctlSlot: a process step control maps through its column from the form API, never a shorter name', () => {
    const step = (n: number, attr: string): Slot => ({ ...t.slot('step', `step|wf|s${n}|Label`), comp: `step|wf|s${n}`, ref: { attribute: attr, stageId: 'stage-2' } }) as Slot;
    const lvl = step(1, 'contoso_themelevel');
    const lvl2 = step(2, 'contoso_themelevel2');
    const names = new Map([
      ['p:contoso_themelevel', lvl],
      ['p:contoso_themelevel|stage-2', lvl],
    ]);
    const ctls: Record<string, [string, string?, string?]> = { header_process_contoso_themelevel2: ['contoso_themelevel2'] };
    // The step of contoso_themelevel2 is not loaded: no anchor, not the step of contoso_themelevel.
    eq(ctlSlot(page([], ctls, { names }), 'header_process_contoso_themelevel2'), undefined);
    names.set('p:contoso_themelevel2|stage-2', lvl2);
    eq(ctlSlot(page([], ctls, { names }), 'header_process_contoso_themelevel2')?.comp, lvl2.comp);
  });

  test('ctlColumn: only controls of the page record own columns give values (a quick view shows another table)', () => {
    const ctls: Record<string, [string, string?, string?]> = {
      statuscode: ['statuscode', 's', 't'],
      header_statuscode: ['statuscode'],
      contactqv_contactqv_contact_statuscode: ['qv:statuscode', 's', 't'],
      contactqv_contactqv_contact_gendercode: ['qv:gendercode', 's', 't'],
    };
    const x = page([], ctls, {}, { statuscode: 1 });
    eq(ctlColumn(x, 'statuscode'), { col: 'statuscode', value: 1, has: true });
    eq(ctlColumn(x, 'header_statuscode'), { col: 'statuscode', value: 1, has: true }, 'header copy');
    eq(ctlColumn(x, 'contactqv_contactqv_contact_statuscode'), null, 'same column name, another record');
    eq(ctlColumn(x, 'contactqv_contactqv_contact_gendercode'), null, 'a column the page table does not have');
    eq(ctlColumn(x, 'nosuchcontrol'), null);
  });

  test('formMoved: the form API showing another table or form makes the index stale', () => {
    const fx = (o: { type?: string; formId?: string; entity?: string; api?: { ent?: string; cur?: string | null; items?: string[] } | null }): PageIndex => {
      const a = o.api;
      const xrm = a
        ? {
            Page: {
              data: { entity: { getEntityName: () => a.ent ?? 'e' } },
              ui: { formSelector: { getCurrentItem: () => (a.cur ? { getId: () => a.cur } : null), items: { get: () => (a.items || []).map((id) => ({ getId: () => id })) } } },
            },
          }
        : {};
      return { record: (o.type ?? 'entityrecord') === 'entityrecord', formId: o.formId ?? 'f1', entity: o.entity ?? 'e', xrm } as unknown as PageIndex;
    };
    ok(!formMoved(fx({ api: { cur: '{F1}' } })), 'same form (braces and case do not matter)');
    ok(formMoved(fx({ api: { cur: '{F2}' } })), 'form switched with the form selector');
    ok(formMoved(fx({ api: { ent: 'other', cur: '{F1}' } })), 'another table');
    ok(!formMoved(fx({ api: { cur: null, items: ['F1'] } })), 'a single form: the one shown');
    ok(formMoved(fx({ api: { cur: null, items: ['F2'] } })), 'a single form, not the one indexed');
    ok(!formMoved(fx({ api: { cur: null, items: ['F1', 'F2'] } })), 'unknown: not stale');
    ok(!formMoved(fx({ api: { ent: '', cur: null } })), 'form API not ready');
    ok(!formMoved(fx({ api: null })), 'no form API');
    ok(!formMoved(fx({ type: 'entitylist', api: { ent: 'other', cur: '{F2}' } })), 'lists have no form');
    ok(!formMoved(fx({ formId: '', api: { cur: '{F2}' } })), 'no form indexed');
  });

  test('relatedMenu: the related menu items the form XML does not list, from the page table\'s relationships (LIVE-FINDINGS 63)', () => {
    const E = 'contoso_servicerequest';
    const rel = (schemaName: string, ref: Record<string, unknown>, side?: 1 | 2): Slot => {
      const comp = side ? `relationship|${schemaName}|${side}` : `relationship|${schemaName}`;
      return { ...t.slot('relationship', `${comp}|Label`, { [EN]: String(ref.label ?? schemaName) }), comp, ref: { schemaName, side, ...ref } } as Slot;
    };
    const one = (s: string, referencing: string, menu: string, referenced = E) => rel(s, { type: 'OneToMany', referenced, referencing, menu });
    const many = (s: string, e1: string, e2: string, side: 1 | 2, menu: string, label?: string) => rel(s, { type: 'ManyToMany', entity1: e1, entity2: e2, menu, label }, side);
    const plural = (e: string, txt: string): Slot => ({ ...t.slot('entity', `entity|${e}|DisplayCollectionName`, { [EN]: txt }), comp: `entity|${e}`, prop: 'DisplayCollectionName' }) as Slot;
    const names = new Map([plural('contoso_signature', 'Signatures'), plural('activitypointer', 'Activities')].map((s) => [s.key, s]));
    const slots = [
      one('contoso_signature_ServiceRequest_contoso_servicerequest', 'contoso_signature', 'plural'),
      one('contoso_servicerequest_ActivityPointers', 'activitypointer', 'plural'),
      one('contoso_onlineform_Resulting', 'contoso_onlineform', 'label'),
      one('contoso_servicerequest_AsyncOperations', 'asyncoperation', 'none'),
      one('contoso_alternates_x', 'contoso_alternates', 'plural'), // its table's name isn't loaded
      one('account_contoso_servicerequest', 'contoso_servicerequest', 'label', 'account'), // shown on account's form
      // Shown on the service request's form (Entity2): Entity1's menu, listing geographic divisions.
      many('contoso_ServiceRequest_contoso_Region', 'contoso_region', E, 1, 'label', 'Locations'),
      many('contoso_ServiceRequest_contoso_Region', 'contoso_region', E, 2, 'label', 'Region contacts'),
      // A relationship of the table to itself: one item per side, crossed (live: '…1' showed Entity2's "Self two").
      many('contoso_SR_SR', E, E, 1, 'label', 'Associated (1)'),
      many('contoso_SR_SR', E, E, 2, 'label', 'Associated (2)'),
    ];
    const m = relatedMenu(slots, E, (k) => names.get(k));
    eq(
      [...m].map(([id, s]) => [id, s.key]),
      [
        ['nav_contoso_signature_servicerequest_contoso_servicerequest', 'entity|contoso_signature|DisplayCollectionName'],
        ['navactivities', 'entity|activitypointer|DisplayCollectionName'],
        ['nav_contoso_onlineform_resulting', 'relationship|contoso_onlineform_Resulting|Label'],
        ['nav_contoso_servicerequest_contoso_region', 'relationship|contoso_ServiceRequest_contoso_Region|1|Label'],
        ['nav_contoso_sr_sr2', 'relationship|contoso_SR_SR|1|Label'],
        ['nav_contoso_sr_sr1', 'relationship|contoso_SR_SR|2|Label'],
      ],
    );
    eq([...relatedMenu(slots, 'contoso_region', (k) => names.get(k)).values()].map((s) => s.key), ['relationship|contoso_ServiceRequest_contoso_Region|2|Label'], 'the other side\'s form');
  });

  test('colKey skips the grid columns that are not table columns', () => {
    for (const k of ['__row_status', 'PlaceHolder', 'placeholder', 'a b', 'x-y']) eq(colKey(k), '', k);
    eq(colKey('contoso_taskstatus'), 'contoso_taskstatus');
    eq(colKey('_contoso_client_value'), 'contoso_client');
  });

  test('ctlSlot: a process step is the step of the stage shown', () => {
    const step = (n: number, stage: string): Slot => ({ ...t.slot('step', `step|wf|s${n}|Label`), comp: `step|wf|s${n}`, ref: { attribute: 'name', stageId: stage } }) as Slot;
    const [a, b] = [step(1, 'stage-1'), step(2, 'stage-2')];
    const names = new Map([
      ['p:name', a],
      ['p:name|stage-1', a],
      ['p:name|stage-2', b],
    ]);
    eq(ctlSlot(page([], {}, { names }), 'header_process_name')?.comp, 'step|wf|s2', 'selected stage');
    eq(ctlSlot(page([], {}, { names }), 'header_process_name1')?.comp, 'step|wf|s2', 'a second control of the step');
  });

  // ---- page loads ----

  test('mergeUsedBy keeps the columns earlier loads found for a global choice', () => {
    const g = (usedBy: string[]): Slot => ({ ...t.slot('globaloption', 'globaloption|industry|1|Label'), ref: { name: 'industry', value: 1, usedBy } }) as Slot;
    const store = new Map([[g([]).key, g(['account.industrycode'])]]);
    const [out] = mergeUsedBy([g(['contact.industrycode'])], (k) => store.get(k));
    eq(out.ref.usedBy, ['contact.industrycode', 'account.industrycode']);
    const fresh = g(['contact.industrycode']);
    ok(mergeUsedBy([fresh], () => undefined)[0] === fresh, 'nothing loaded before: the same slot');
    ok(mergeUsedBy([fresh], () => g(['contact.industrycode']))[0] === fresh, 'nothing new: the same slot');
    const other = t.slot('attribute');
    ok(mergeUsedBy([other], () => g(['x.y']))[0] === other, 'other kinds untouched');
  });

  test('grid control types, modern command ids and table requests', () => {
    for (const s of ['subgrid', 'editablegrid', 'customsubgrid:MscrmControls.Grid.PowerAppsGridControl', 'SubGrid']) ok(isGridType(s), s);
    for (const s of ['standard', 'optionset', 'subgridx', 'quickform', '']) ok(!isGridType(s), s);
    ok(isModern('NewButton!0123456789abcdef0123456789ABCDEF'));
    ok(!isModern('Mscrm.SaveAndClosePrimary'));
    ok(WANT_TABLE.includes('#') && !/^[a-z0-9_]/.test(WANT_TABLE), 'no table name starts like a table request');
  });

  // ---- page loads ----

  /** A page loader on these fake providers, and a wait until its loads are done. */
  const loader = (providers: Record<string, unknown>, store = new Store()) => {
    const ctx = { xrm: {}, user: FR, base: EN, langs: [{ lcid: EN }, { lcid: FR }] };
    const ld = new PageLoader({ ctx, providers, store, lang: {} } as unknown as ConstructorParameters<typeof PageLoader>[0], () => {});
    const settle = async (calls: unknown[], k: number) => {
      for (let i = 0; i < 100 && (calls.length < k || ld.busy.size); i++) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 5));
    };
    return { ld, store, settle };
  };
  const FORM = '8448b78f-8f42-454e-8e2a-f8196b0419af';
  const S = (kind: string, key: string, labels: Record<number, string>, ref: Record<string, unknown>): Slot =>
    ({ ...t.slot(kind, key, labels), comp: key.slice(0, key.lastIndexOf('|')), prop: key.slice(key.lastIndexOf('|') + 1), entity: 'account', ref }) as Slot;

  test('page loads: a form whose cells no read can complete (no unpublished definition, ref.unreadable) is no failed load; one that missed a language is', async () => {
    const PUB = "This form has no unpublished definition in Dynamics, and its published one can't show the form's own field labels in other languages.";
    const tab = S('tab', `tab|${FORM}|t1|Label`, { [EN]: 'General', [FR]: 'Général' }, { formId: FORM, tabName: 'general' });
    const cell = S('field', `field|${FORM}|c1|Label`, { [FR]: 'Nom du compte' }, { formId: FORM, controlId: 'name', datafield: 'name', partial: true, unreadable: PUB });
    const load = async (read: Slot[]) => {
      const calls: string[] = [];
      const { ld, store, settle } = loader({ loadFormXml: async () => (calls.push('form'), read), loadRecords: async () => [], loadTables: async () => [] });
      ld.page = { info: { type: 'entityrecord' } as never, sig: 's', entity: 'account', formId: FORM, viewId: '', bpfId: '' };
      (ld as unknown as { form(id: string, kind: string): void }).form(FORM, 'form');
      await settle(calls, 1);
      return { errors: [...ld.errors.values()], kept: read.every((s) => !!store.get(s.key)), calls };
    };
    // Its cells are known in the user's language only, by design: their looks and tooltips say why; Try again can't help.
    eq(await load([tab, cell]), { errors: [], kept: true, calls: ['form'] });
    // A tab whose other language wasn't read (the language switch failed): failed, with Try again.
    const lost = { ...tab, labels: { [FR]: 'Général' }, ref: { ...tab.ref, partial: true } } as Slot;
    eq(await load([lost, cell]), { errors: ['Could not load the form labels in every language.'], kept: true, calls: ['form'] });
    eq((await load([tab, { ...cell, ref: { ...cell.ref, unreadable: undefined } } as Slot])).errors, ['Could not load the form labels in every language.'], 'a cell a read could complete');
  });

  test("page loads: the names of the forms in the form selector's list and of views in a list of views are read on demand, together, once; a personal view's (no savedquery) is never asked for again", async () => {
    const F2 = 'b053a39a-041a-4356-acef-ddf00182762b';
    const F3 = 'a72c7955-442b-4ea4-9499-b10cd18b4256';
    const V2 = '6b3e6539-38ab-406f-9aaa-192e75e9d23c';
    const V3 = '0d2b9c11-0000-4000-8000-000000000003';
    const calls: string[] = [];
    const named = (kind: string, id: string) => S(kind, `${kind}|${id}|Name`, { [EN]: `${kind} ${id.slice(0, 4)}` }, { id });
    const { ld, store, settle } = loader({
      // A personal view is no savedquery: the read finds nothing for it.
      loadRecords: async (_c: unknown, kind: string, ids: string[]) => (calls.push(`${kind} ${ids.join()}`), ids.filter((id) => id !== V3).map((id) => named(kind, id))),
    });
    ld.request([WANT_FORM_NAME + F2, WANT_FORM_NAME + `{${F3.toUpperCase()}}`, WANT_FORM_NAME + F2, WANT_VIEW_NAME + V2, WANT_VIEW_NAME + V3, WANT_FORM_NAME + 'not a form']);
    await settle(calls, 2);
    eq(calls.sort(), [`form ${F2},${F3}`, `view ${V2},${V3}`]);
    eq([!!store.get(`form|${F2}|Name`), !!store.get(`form|${F3}|Name`), !!store.get(`view|${V2}|Name`), !!store.get(`view|${V3}|Name`)], [true, true, true, false]);
    eq([[...ld.errors.values()], ld.gaveUp.has(WANT_VIEW_NAME + V3)], [[], false], 'found nothing: no failure to try again');
    // Asked again (every scan of the open list asks): never read again.
    ld.request([WANT_VIEW_NAME + V3, WANT_FORM_NAME + F2]);
    await settle(calls, 2);
    eq(calls.length, 2);
  });
}
