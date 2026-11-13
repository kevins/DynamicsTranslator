// Unit tests for "Select labels to export" (inspector/selection.ts): what a selection of labels brings (each one's popup
// texts, by kind), the bookkeeping of what is selected, the texts of the bar and the dialog, and the geometry of the box
// dragged over the page (inspector/overlay.ts). The box itself on the overlay's fake page is in overlay-dom.ts.
import type { Kit } from './kit';
import { Store } from '../../../src/core/store';
import type { Slot } from '../../../src/core/model';
import type { CalloutModel, Selected } from '../../../src/inspector/types';
import type { AppApi } from '../../../src/ui/types';

const selection = () => import('../../../src/inspector/selection');
const overlay = () => import('../../../src/inspector/overlay');

export function register(t: Kit): void {
  const { test, eq, ok } = t;
  const EN = 1033;
  const FR = 1036;
  const F = '0f1e2d3c-4b5a-4968-8776-655443322110';
  const sl = (kind: string, key: string, en: string, fr: string): Slot => t.slot(kind, key, { [EN]: en, [FR]: fr });
  const model = (comp: string, blocks: Array<[string, string]>, choices?: string[]): CalloutModel => ({
    comp,
    title: comp,
    kind: 'Field',
    icon: 'field',
    blocks: blocks.map(([key, heading]) => ({ key, heading, long: false })),
    choices: choices && { keys: choices, open: false },
    loading: false,
  });
  /** A field (its column's name and tooltip, its form label), a choice field sharing a choice with another, a tab. */
  const fax = model(`field|${F}|c1`, [
    ['attribute|account.fax|DisplayName', 'Column name'],
    ['attribute|account.fax|Description', 'Tooltip'],
    [`field|${F}|c1|Label`, 'Form label'],
  ]);
  const kind = model(
    `field|${F}|c2`,
    [
      ['attribute|account.kind|DisplayName', 'Column name'],
      ['attribute|account.kind|Description', 'Tooltip'],
      [`field|${F}|c2|Label`, 'Form label'],
    ],
    ['globaloption|kinds|1|Label', 'globaloption|kinds|2|Label'],
  );
  const other = model(`field|${F}|c3`, [[`field|${F}|c3|Label`, 'Form label']], ['globaloption|kinds|1|Label', 'globaloption|kinds|2|Label']);
  const tab = model(`tab|${F}|t1`, [[`tab|${F}|t1|Label`, 'Label']]);
  const models = new Map([fax, kind, other, tab].map((m) => [m.comp, m]));
  const store = () => {
    const s = new Store();
    s.add([
      sl('attribute', 'attribute|account.fax|DisplayName', 'Fax', 'Télécopie'),
      // The fax column's tooltip isn't loaded: nothing to download for it.
      sl('field', `field|${F}|c1|Label`, 'Fax', 'Télécopie'),
      sl('attribute', 'attribute|account.kind|DisplayName', 'Kind', 'Type'),
      sl('attribute', 'attribute|account.kind|Description', 'The kind', 'Le type'),
      sl('field', `field|${F}|c2|Label`, 'Kind', 'Type'),
      sl('field', `field|${F}|c3|Label`, 'Other kind', 'Autre type'),
      sl('globaloption', 'globaloption|kinds|1|Label', 'Customer', 'Client'),
      sl('globaloption', 'globaloption|kinds|2|Label', 'Partner', 'Partenaire'),
      sl('tab', `tab|${F}|t1|Label`, 'General', 'Général'),
      sl('entity', 'entity|account|DisplayCollectionName', 'Accounts', 'Comptes'),
    ]);
    return s;
  };
  const pick = (comp: string, key = `${comp}|Label`, page = 'Account · Main form'): Selected => ({ comp, key, page });

  test('selection: what selected labels bring is what their popups show, each text once, by kind: a field its Column name, Tooltip and Form label and its choice values, a tab its label; the text clicked where no block lists it; never a text not loaded, and a label whose popup fails to build adds nothing', async () => {
    const { partOf, selectedTexts } = await selection();
    eq(['Form label', 'Column name', 'Tooltip', 'Label', 'Name', 'Plural name', 'Description', 'Title'].map(partOf), ['label', 'name', 'tip', 'other', 'other', 'other', 'other', 'other']);
    const app = { store: store() } as unknown as AppApi;
    const describe = (_: AppApi, comp: string): CalloutModel => {
      const m = models.get(comp);
      if (!m) throw new Error('no such component');
      return m;
    };
    const got = selectedTexts(app, [pick(fax.comp), pick(kind.comp), pick(other.comp), pick(tab.comp), pick('broken'), pick('area|sm|a1', 'entity|account|DisplayCollectionName')], describe);
    eq(
      [...got],
      [
        ['attribute|account.fax|DisplayName', 'name'],
        [`field|${F}|c1|Label`, 'label'],
        ['attribute|account.kind|DisplayName', 'name'],
        ['attribute|account.kind|Description', 'tip'],
        [`field|${F}|c2|Label`, 'label'],
        ['globaloption|kinds|1|Label', 'choice'],
        ['globaloption|kinds|2|Label', 'choice'],
        [`field|${F}|c3|Label`, 'label'],
        [`tab|${F}|t1|Label`, 'other'],
      ],
      'in the order selected; a shared choice once; the broken one and the unknown text clicked on it left out',
    );
    // A label shown by a text of another component (a navigation entry showing its table's plural name): that text.
    const nav = selectedTexts(app, [pick('area|sm|a1', 'entity|account|DisplayCollectionName')], () => model('area|sm|a1', []));
    eq([...nav], [['entity|account|DisplayCollectionName', 'other']]);
  });

  test('selection: the download keeps the kinds chosen, in the order selected, with their pending edits (as the Workbench downloads them), never changing the store', async () => {
    const { chosenSlots, withEdits } = await selection();
    const st = store();
    const texts = new Map<string, 'label' | 'name' | 'tip' | 'choice' | 'other'>([
      ['attribute|account.kind|DisplayName', 'name'],
      [`field|${F}|c2|Label`, 'label'],
      ['globaloption|kinds|1|Label', 'choice'],
      ['attribute|account.kind|Description', 'tip'],
      ['nowhere|x|Label', 'label'],
    ]);
    eq(
      chosenSlots(st, texts, new Set(['label', 'choice'])).map((s) => s.key),
      [`field|${F}|c2|Label`, 'globaloption|kinds|1|Label'],
      'form labels and choice values only; a text gone from the store is skipped',
    );
    eq(chosenSlots(st, texts, new Set()).length, 0);
    st.set(`field|${F}|c2|Label`, FR, 'Genre');
    const list = withEdits(st, chosenSlots(st, texts, new Set(['label'])));
    eq([list[0].labels[FR], list[0].labels[EN], st.get(`field|${F}|c2|Label`)!.labels[FR]], ['Genre', 'Kind', 'Type'], 'the pending French text in the file; the store keeps what it read');
  });

  test('selection: the labels selected, each component once, in the order selected: a click selects or unselects, a box and Select all only add, a box drawn with Ctrl only takes away; the bar and the dialog say how many, on how many pages', async () => {
    const { Chosen, selectingText, selectionLine, PARTS } = await selection();
    const c = new Chosen();
    eq([c.toggle({ comp: 'a', key: 'a|Label' }, 'P1'), c.toggle({ comp: 'b', key: 'b|Label' }, 'P1'), c.size], [true, true, 2]);
    eq([c.toggle({ comp: 'a', key: 'a|Value' }, 'P2'), c.has('a'), c.size], [false, false, 1], 'a second click unselects, whichever text of it was clicked');
    eq(c.add([{ comp: 'b', key: 'b|Label' }, { comp: 'c', key: 'c|Label' }, { comp: 'c', key: 'c|Other' }], 'P2'), 1, 'a box over b (selected) and c twice: only c added');
    eq(c.list(), [
      { comp: 'b', key: 'b|Label', page: 'P1' },
      { comp: 'c', key: 'c|Label', page: 'P2' },
    ]);
    eq([selectionLine(c.list()), selectionLine(c.list().slice(0, 1)), selectionLine([pick('x'), pick('y'), pick('z', 'z|Label', 'Contact · Main form')])], ['2 labels on 2 pages', '1 label on 1 page', '3 labels on 2 pages']);
    eq([c.remove([{ comp: 'c' }, { comp: 'd' }, { comp: 'c' }]), c.list()], [1, [{ comp: 'b', key: 'b|Label', page: 'P1' }]], 'a box drawn with Ctrl over c (selected), d and c again: only c taken away, nothing added');
    c.clear();
    eq([c.size, c.list()], [0, []]);
    eq([selectingText(0), selectingText(1234)], ['Click or drag over the labels you want · Ctrl+drag to unselect · 0 selected', 'Click or drag over the labels you want · Ctrl+drag to unselect · 1,234 selected']);
    eq(
      PARTS.map((p) => p[1]),
      ['Form labels', 'Column names', 'Tooltips', 'Choice values', 'Other labels'],
    );
  });

  test('selection box geometry: the box between the press and the pointer, either way; a label is covered when a mark of it lies at least partly inside, never when it only touches the edge', async () => {
    const { dragBox, overlaps, BOX_MIN } = await overlay();
    eq([dragBox({ x0: 100, y0: 50, x: 20, y: 80 }), dragBox({ x0: 20, y0: 80, x: 100, y: 50 })], [
      [20, 50, 80, 30],
      [20, 50, 80, 30],
    ]);
    const b: [number, number, number, number] = [20, 50, 80, 30];
    eq(
      [
        overlaps(b, [[0, 0, 10, 10]]),
        overlaps(b, [[90, 70, 40, 10]]),
        overlaps(b, [
          [0, 0, 5, 5],
          [30, 60, 5, 5],
        ]),
        overlaps(b, [[100, 60, 5, 5]]),
        overlaps(b, [[10, 40, 10, 10]]),
        overlaps(b, []),
      ],
      [false, true, true, false, false, false],
    );
    ok(BOX_MIN >= 4 && BOX_MIN <= 10, 'a press must move a few px before it draws: less is a click');
  });

  test("selection box: never from a press on a scrollbar (past the client area of the element pressed), which is the scrollbar's drag; an element with no client box (an inline text) has none", async () => {
    const { onScrollbar } = await overlay();
    const el = (w: number, h: number) => ({ clientWidth: w, clientHeight: h }) as unknown as EventTarget;
    const on = (t: EventTarget | null, x: number, y: number) => onScrollbar({ target: t, offsetX: x, offsetY: y });
    eq([on(el(300, 200), 150, 100), on(el(300, 200), 305, 100), on(el(300, 200), 150, 204), on(el(0, 0), 40, 10), on(null, 5, 5)], [false, true, true, false, false]);
  });
}
