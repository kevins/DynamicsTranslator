// Unit tests for what the scanner maps beyond the page form's own labels (LIVE-FINDINGS 54–58): a side pane's form
// (another table with the same control names), a quick view's form, a multi-select's values on a form and in grids,
// and linked-table grid columns (headers and choice values), in sub-grids and in a side pane's grid. A fake DOM
// (fakedom.ts) and a fake form API; the expected keys are the exact components a save would change.
import type { Slot } from '../../../src/core/model';
import { Store } from '../../../src/core/store';
import { PageLoader, WANT_FORM, WANT_NAMES, WANT_QUICK, WANT_RELATED, WANT_TABLE, WANT_VIEW, WANT_VIEW_NAME } from '../../../src/inspector/pageload';
import { queryLinks } from '../../../src/inspector/parts';
import { buildIndex, fieldIn, ofProcess, Scanner } from '../../../src/inspector/scan';
import type { Anchor } from '../../../src/inspector/types';
import type { RibbonControl } from '../../../src/providers/types';
import { El, withDom } from './fakedom';
import type { Kit } from './kit';

const EN = 1033;
const FR = 1036;
/** new_dxttest's main form (the page). */
const PAGE = 'f5e07410-0000-4000-8000-000000000072';
/** new_dxtlinked's main form, opened in a side pane. */
const PANE = '34f8821b-0000-4000-8000-000000000074';
/** new_dxtlinked's quick view form, shown on the page form by the quick view control 'linkedqv'. */
const QV = 'a9c89206-0000-4000-8000-000000000073';
const VIEW = 'b0618642-0000-4000-8000-000000000061';
const VIEW2 = '22d829ca-0000-4000-8000-000000000062';
const ALIAS = 'a_c0b293d602c9f111b3777ced8da4e57c';
const QVCLASS = '{5C5600E0-1D6E-4205-A272-BE80DA87FD42}';
const FETCH = `<fetch><entity name="new_dxttest"><attribute name="new_dxtmulti"/><link-entity alias="${ALIAS}" name="new_dxtlinked" to="new_linkedid" from="new_dxtlinkedid"><attribute name="new_name"/><attribute name="new_linkedkind"/></link-entity></entity></fetch>`;

// ---- the page as UCI renders it (live probes 2026-10-15) ----

/** A field container: its element id names its form (`id-<form id>-<n>-<control>-…`); a quick view's is '<qv>.<control>'. */
const field = (form: string, ctl: string, label: string, ...more: El[]): El => {
  const inner = ctl.slice(ctl.indexOf('.') + 1);
  return new El('div', { 'data-id': `${ctl}-FieldSectionItemContainer`, id: `id-${form}-1-${inner}-FieldSectionItemContainer` }).add(
    new El('div', { title: label }).add(new El('label', { id: `id-${form}-1-${inner}-field-label` }, label)),
    ...more,
  );
};
const section = (name: string, title: string, ...kids: El[]): El => new El('section', { 'data-id': name }).add(new El('h2', { title }, title), ...kids);
const panel = (name: string, ...kids: El[]): El => new El('div', { role: 'tabpanel', 'data-id': `tabpanel-${name}` }).add(...kids);
const tab = (name: string, title: string): El => new El('li', { role: 'tab', 'data-id': `tablist-${name}` }, title);
const quick = (ctl: string, host: string, ...fields: El[]): El =>
  new El('div', { 'data-control-name': ctl, 'data-id': ctl }).add(new El('div', { 'data-lp-id': `MscrmControls.Containers.QuickForm|${ctl}|new_dxttest|${host}` }).add(...fields));
/**
 * A multi-select control: hidden chips (`li[data-value]`) and, in view mode, one text with every value. Its class names
 * the control; its `data-lp-id` is rendered on some loads only (`lp`).
 */
const multi = (ctl: string, chips: Array<[number, string]>, text: string, lp = false): El =>
  new El('div', {
    'data-id': `${ctl}.fieldControl_container`,
    ...(lp ? { 'data-lp-id': `MscrmControls.MultiSelectPicklist.UpdMSPicklistControl|${ctl}.fieldControl|new_dxttest` } : { class: 'customControl MscrmControls MultiSelectPicklist.UpdMSPicklistControl' }),
  }).add(
    new El('div', { id: `${ctl}_viewmodecontainer` }).add(new El('div', { title: text }, text)),
    new El('ul').add(...chips.map(([v, t]) => new El('li', { 'data-value': String(v) }).add(new El('span', {}, t)))),
  );
/** A grid's root (its `data-lp-id`) with its column headers and one row of cells. */
const gridRoot = (lp: string, heads: Array<[string, string]>, cells: Array<[string, string]>): El =>
  new El('div', { 'data-lp-id': lp }).add(
    ...heads.map(([col, text]) => new El('div', { role: 'columnheader', 'col-id': col }).add(new El('label').add(new El('div', {}, text)))),
    new El('div', { role: 'row' }).add(...cells.map(([col, text]) => new El('div', { role: 'gridcell', 'col-id': col }).add(new El('label').add(new El('div', {}, text))))),
  );
const grid = (ctl: string, table: string, view: string, heads: Array<[string, string]>, cells: Array<[string, string]>): El =>
  new El('div', { 'data-control-name': ctl }).add(gridRoot(`Microsoft.PowerApps.PowerAppsOneGrid|${ctl}|${table}|${view}|${table}`, heads, cells));
/** new_dxtlinked's associated view, opened on the record form by the related menu item of new_dxtlinked_test. */
const VIEW3 = '00000000-0000-0000-00aa-000010001210';
const REL = 'new_dxtlinked_test';
/**
 * An associated grid (a related tab's view, LIVE-FINDINGS 88): its data-lp-id names the page's table (part 2), its view
 * and its own table (part 4); in the container UCI renders it in (`wrap`).
 */
const assoc = (heads: Array<[string, string]>, cells: Array<[string, string]>, lp = `Microsoft.PowerApps.PowerAppsOneGrid|entity_control|new_dxttest|${VIEW3}|new_dxtlinked|${REL}`, wrap = true): El =>
  wrap ? new El('div', { 'data-id': 'entity_control-pcf_grid_control_container' }).add(gridRoot(lp, heads, cells)) : gridRoot(lp, heads, cells);
const pane = (...kids: El[]): El => new El('div', { 'data-id': 'pane-container-dxt', role: 'tabpanel' }).add(new El('div', { 'data-id': 'editFormRoot' }).add(...kids));

export function register(t: Kit): void {
  const { test, eq, ok } = t;

  // ---- slots: three forms, the columns and choices they show ----

  let n = 0;
  const S = (kind: string, key: string, en: string, fr: string, ref: Record<string, unknown>, entity: string, prop = 'Label'): Slot =>
    ({ ...t.slot(kind, key, { [EN]: en, [FR]: fr }), kind, prop, entity, comp: key.split('|').slice(0, -1).join('|'), order: n++, ref }) as Slot;
  const cell = (form: string, id: string, ctl: string, df: string, en: string, fr: string, entity: string, place: [string, string], more: Record<string, unknown> = {}) =>
    S('field', `field|${form}|${id}|Label`, en, fr, { formId: form, elId: id, controlId: ctl, datafield: df || undefined, tabName: place[0], sectionName: place[1], area: 'body', ...more }, entity);
  const opt = (col: string, v: number, en: string, fr: string) => {
    const [entity, attribute] = col.split('.');
    return S('option', `option|${col}|${v}|Label`, en, fr, { entity, attribute, value: v }, entity);
  };
  const col = (c: string, en: string, fr: string, type = 'StringAttributeMetadata') => {
    const [entity, attribute] = c.split('.');
    return S('attribute', `attribute|${c}|DisplayName`, en, fr, { entity, attribute, odataType: `Microsoft.Dynamics.CRM.${type}` }, entity, 'DisplayName');
  };
  /** A table's display and plural name (French as given, else the English ones). */
  const names = (e: string, en: string, plural: string, fr = en, frPlural = plural) => [
    S('entity', `entity|${e}|DisplayName`, en, fr, { entity: e }, e, 'DisplayName'),
    S('entity', `entity|${e}|DisplayCollectionName`, plural, frPlural, { entity: e }, e, 'DisplayCollectionName'),
  ];
  const G: [string, string] = ['general', 's1'];
  const pageForm = [
    S('tab', `tab|${PAGE}|tp|Label`, 'General', 'Général', { formId: PAGE, tabName: 'general' }, 'new_dxttest'),
    S('section', `section|${PAGE}|sp|Label`, 'Information', 'Informations', { formId: PAGE, sectionName: 's1' }, 'new_dxttest'),
    cell(PAGE, 'c1', 'new_name', 'new_name', 'Name', 'Nom', 'new_dxttest', G),
    cell(PAGE, 'c2', 'ownerid', 'ownerid', 'Owner', 'Propriétaire', 'new_dxttest', G),
    cell(PAGE, 'c3', 'new_dxtmulti', 'new_dxtmulti', 'Colors', 'Couleurs', 'new_dxttest', G),
    cell(PAGE, 'c4', 'linkedqv', 'new_linkedid', 'Linked details', 'Détails liés', 'new_dxttest', G, { classid: QVCLASS, quickForms: [QV] }),
  ];
  const paneForm = [
    S('tab', `tab|${PANE}|tl|Label`, 'General', 'Général', { formId: PANE, tabName: 'general' }, 'new_dxtlinked'),
    S('section', `section|${PANE}|sl|Label`, 'Details', 'Détails', { formId: PANE, sectionName: 's1' }, 'new_dxtlinked'),
    cell(PANE, 'l1', 'new_name', 'new_name', 'Linked name', 'Nom lié', 'new_dxtlinked', G),
    cell(PANE, 'l2', 'ownerid', 'ownerid', 'Owner', 'Propriétaire', 'new_dxtlinked', G),
  ];
  const QP: [string, string] = ['{551d8311}', '{7202e5e0}'];
  const quickForm = [cell(QV, 'q1', 'new_name', 'new_name', 'Linked name', 'Nom lié', 'new_dxtlinked', QP), cell(QV, 'q2', 'new_linkedkind', 'new_linkedkind', 'Linked kind', 'Type lié', 'new_dxtlinked', QP)];
  const tables = [
    col('new_dxttest.new_dxtmulti', 'Colors', 'Couleurs', 'MultiSelectPicklistAttributeMetadata'),
    col('new_dxttest.new_linkedid', 'Linked test', 'Test lié', 'LookupAttributeMetadata'),
    opt('new_dxttest.new_dxtmulti', 100000000, 'Red', 'Rouge'),
    opt('new_dxttest.new_dxtmulti', 100000001, 'Blue', 'Bleu'),
    opt('new_dxttest.new_dxtmulti', 100000002, 'Green', 'Vert'),
  ];
  const linked = [
    col('new_dxtlinked.new_name', 'Linked name', 'Nom lié'),
    col('new_dxtlinked.new_linkedkind', 'Linked kind', 'Type lié', 'PicklistAttributeMetadata'),
    opt('new_dxtlinked.new_linkedkind', 100000000, 'Internal', 'Interne'),
    opt('new_dxtlinked.new_linkedkind', 100000001, 'External', 'Externe'),
  ];

  // ---- the page form's API: it knows the page's controls only (Xrm.Page stays the page's in a side pane) ----

  const place = (s: string, tb: string) => ({ getName: () => s, getParent: () => ({ getName: () => tb }) });
  const attribute = (c: string, value: unknown, names: string[], sec: ReturnType<typeof place>) => ({
    getName: () => c,
    getValue: () => value,
    controls: { get: () => names.map((nm) => ({ getName: () => nm, getParent: () => sec })) },
  });
  const pageCtl: Record<string, unknown> = { new_name: null, ownerid: null, new_dxtmulti: [100000000, 100000001] };
  const ctl = (nm: string, value: unknown, sec = place('s1', 'general')) => ({ getName: () => nm, getParent: () => sec, getAttribute: () => attribute(nm, value, [nm], sec) });
  const xrm = {
    Page: {
      getControl: (nm: string) => {
        if (nm in pageCtl) return ctl(nm, pageCtl[nm]);
        // The header's copy of new_name (header controls are in no section).
        if (nm === 'header_new_name') return { getName: () => nm, getParent: () => null, getAttribute: () => attribute('new_name', null, ['new_name', nm], place('s1', 'general')) };
        // The page's sub-grid 'children' shows new_dxttest; a side pane's grid of that name shows another table.
        if (nm === 'children') return { getName: () => nm, getEntityName: () => 'new_dxttest', getFetchXml: () => FETCH, getControlType: () => 'subgrid' };
        return null;
      },
      getAttribute: (c: string) => (c in pageCtl ? attribute(c, pageCtl[c], [c], place('s1', 'general')) : null),
      data: { entity: { getEntityName: () => 'new_dxttest' } },
      ui: {
        controls: { get: () => Object.keys(pageCtl), getLength: () => 3 },
        tabs: { get: () => [], getLength: () => 1 },
        formSelector: { getCurrentItem: () => ({ getId: () => `{${PAGE.toUpperCase()}}` }), items: { get: () => [] } },
        // The quick view on the page form: its controls are placed in its own (unnamed) section and tab.
        quickForms: { get: (q: string) => (q === 'linkedqv' ? { getControl: (nm: string) => (['new_name', 'new_linkedkind'].includes(nm) ? ctl(nm, null, place(QP[1], QP[0])) : null) } : null) },
      },
    },
  };

  /** Scans `body` with these slots loaded; the anchors as [key, text or part, in a pane], and what the scanner asked for. */
  const scan = (
    body: El,
    slots: Slot[],
    queries = new Map<string, ReturnType<typeof queryLinks>>(),
    bpfId = '',
    ribbon = new Map<string, Map<string, RibbonControl>>(),
    viewTables = new Map<string, string>(),
    gaveUp = new Set<string>(),
  ) =>
    withDom(body, () => {
      const map = new Map(slots.map((s) => [s.key, s]));
      const store = { slots: map, get: (k: string) => map.get(k) } as unknown as Store;
      const ld = { page: { info: { type: 'entityrecord' }, entity: 'new_dxttest', formId: PAGE, bpfId, viewId: '' }, app: { ctx: { user: FR, base: EN } }, sitemapId: '', appId: '', cmd: new Map(), ribbon, queries, viewTables, gaveUp } as unknown as PageLoader;
      const x = buildIndex(store, ld, xrm);
      const sc = new Scanner();
      sc.full(x);
      const inPane = (a: Anchor) => !!(a.el as unknown as El).closest('[data-id^="pane-container-"]');
      const shows = (a: Anchor) => (a.part ? `${a.part.text}@${a.part.start}` : ((a.text as unknown as { nodeValue: string } | undefined)?.nodeValue ?? ''));
      const r = { list: sc.list.map((a) => [a.key, shows(a), inPane(a)] as [string, string, boolean]), want: [...sc.want], x };
      // The anchors themselves and the scanner (not enumerable: results are compared as JSON).
      return Object.defineProperties(r, { anchors: { value: sc.list }, sc: { value: sc } }) as typeof r & { anchors: Anchor[]; sc: Scanner };
    });
  const pageDom = (...more: El[]) =>
    new El('body').add(
      new El('ul').add(tab('general', 'Général')),
      panel('general', section('s1', 'Informations', field(PAGE, 'new_name', 'Nom'), field(PAGE, 'ownerid', 'Propriétaire'), ...more)),
    );
  const paneDom = () => pane(new El('ul').add(tab('general', 'Général')), panel('general', section('s1', 'Détails', field(PANE, 'new_name', 'Nom lié'), field(PANE, 'ownerid', 'Propriétaire'))));
  const keysIn = (list: Array<[string, string, boolean]>, pane: boolean) => list.filter((a) => a[2] === pane).map((a) => a[0]);

  test('side pane: a form of another table with the same control names maps to its own cells, never the page form\'s', () => {
    const { list } = scan(pageDom().add(paneDom()), [...pageForm, ...paneForm, ...tables, ...linked]);
    eq(keysIn(list, false), [`tab|${PAGE}|tp|Label`, `section|${PAGE}|sp|Label`, `field|${PAGE}|c1|Label`, `field|${PAGE}|c2|Label`]);
    // Before (LIVE-FINDINGS 58) "Nom lié" and "Propriétaire" in the pane edited the page form's new_name and ownerid cells.
    eq(keysIn(list, true), [`tab|${PANE}|tl|Label`, `section|${PANE}|sl|Label`, `field|${PANE}|l1|Label`, `field|${PANE}|l2|Label`]);
  });

  test('a tab that did not fit is marked in the "More tabs" menu (a menu item in the flyout portal)', () => {
    const admin = S('tab', `tab|${PAGE}|ta|Label`, 'Admin', 'Administration', { formId: PAGE, tabName: 'tab_admin' }, 'new_dxttest');
    const menu = new El('div', { id: '__fluentPortalMountNode', role: 'presentation' }).add(
      new El('div', { id: 'relatedEntityContainer', 'data-id': '__flyoutRootNode', role: 'presentation' }).add(
        new El('div', { role: 'menu', 'data-id': 'relatedTabMenuList' }).add(new El('div', { role: 'menuitem', 'data-id': 'tablist-tab_admin' }).add(new El('span', {}, 'Administration'))),
      ),
    );
    const { list } = scan(pageDom().add(menu), [...pageForm, admin, ...tables]);
    eq(
      list.filter((a) => a[0].startsWith('tab|')).map((a) => [a[0], a[1]]),
      [
        [`tab|${PAGE}|tp|Label`, 'Général'],
        [`tab|${PAGE}|ta|Label`, 'Administration'],
      ],
    );
  });

  test('side pane: until its form is loaded nothing there is anchored, and its form is asked for', () => {
    const { list, want } = scan(pageDom().add(paneDom()), [...pageForm, ...tables]);
    eq(keysIn(list, true), []);
    ok(want.includes(WANT_FORM + PANE), JSON.stringify(want));
  });

  test('side pane showing the page\'s own form: its cells by where the pane shows each control', () => {
    const body = pageDom().add(pane(panel('general', section('s1', 'Informations', field(PAGE, 'new_name', 'Nom'), field(PAGE, 'ownerid', 'Propriétaire')))));
    const { list } = scan(body, [...pageForm, ...tables]);
    eq(keysIn(list, true), [`section|${PAGE}|sp|Label`, `field|${PAGE}|c1|Label`, `field|${PAGE}|c2|Label`]);
    // Shown in a section the form XML doesn't place it in (an unpublished move): unknown, never another copy.
    const moved = pageDom().add(pane(panel('general', section('s9', 'Autre', field(PAGE, 'new_name', 'Nom')))));
    eq(keysIn(scan(moved, [...pageForm, ...tables]).list, true), []);
  });

  test('fieldIn without a form API (a side pane): the DOM place and the name decide, the page\'s API is never asked', () => {
    const f = { fields: new Map([['new_name', [paneForm[2]]]]), cells: new Map([['new_name', [paneForm[2]]]]) };
    eq(fieldIn(f, null, 'new_name', { tab: 'general', section: 's1' }, true)?.key, paneForm[2].key);
    eq(fieldIn(f, null, 'new_name', { tab: 'general', section: 's2' }, true), undefined, 'elsewhere: not this cell');
    eq(fieldIn(f, null, 'ownerid', { tab: 'general', section: 's1' }, true), undefined, 'a control the form has no cell for');
  });

  test('quick view: its fields map to the quick view form\'s cells, the page field of the same name to the page form\'s', () => {
    const qv = quick('linkedqv', PAGE, field(QV, 'linkedqv.new_name', 'Nom lié'), field(QV, 'linkedqv.new_linkedkind', 'Type lié'));
    const { list } = scan(pageDom(qv), [...pageForm, ...quickForm, ...tables, ...linked]);
    eq(keysIn(list, false).filter((k) => k.startsWith('field|')), [`field|${PAGE}|c1|Label`, `field|${PAGE}|c2|Label`, `field|${QV}|q1|Label`, `field|${QV}|q2|Label`]);
    // A quick view form its control doesn't list (the DOM and the form XML disagree): nothing.
    const other = pageForm.map((s) => (s.ref.controlId === 'linkedqv' ? { ...s, ref: { ...s.ref, quickForms: ['00000000-0000-0000-0000-000000000001'] } } : s));
    eq(keysIn(scan(pageDom(qv), [...other, ...quickForm, ...tables]).list, false).filter((k) => k.includes(QV)), []);
    // Its form not loaded yet: asked for.
    const r = scan(pageDom(qv), [...pageForm, ...tables]);
    eq(keysIn(r.list, false).filter((k) => k.includes(QV)), []);
    ok(r.want.includes(WANT_QUICK + QV), JSON.stringify(r.want));
  });

  test('a field container naming another form outside a pane or a dialog is never mapped onto the page form', () => {
    const body = new El('body').add(panel('general', section('s1', 'Informations', field(PANE, 'new_name', 'Nom'))));
    eq(keysIn(scan(body, [...pageForm, ...paneForm]).list, false).filter((k) => k.startsWith('field|')), []);
  });

  test('header fields: a header strip item and a collapsed header field get their field label, the item or the field its container', () => {
    const head = cell(PAGE, 'h1', 'header_new_name', 'new_name', 'Name', 'Nom', 'new_dxttest', G, { area: 'header', tabName: undefined, sectionName: undefined });
    // The header strip: an item per field, its label in a [slot=label] child.
    const label = new El('div', { slot: 'label' }, 'Nom');
    const item = new El('uci-header-control-list-item', { 'data-name': 'header_new_name' }).add(new El('div', {}, 'Contoso'), label);
    const strip = scan(pageDom().add(new El('uci-header-control-list').add(item)), [...pageForm, head, ...tables]);
    const a = strip.anchors.find((x) => x.key === head.key);
    ok(a && (a.el as unknown as El) === label && (a.hit as unknown as El) === item && ((a.zone ?? a.el) as unknown as El) === label, JSON.stringify(strip.list));
    // A collapsed header: the field without a field container.
    const tile = new El('div', { 'data-id': 'header_new_name' }).add(new El('span', {}, 'Nom'));
    const col = scan(pageDom().add(tile), [...pageForm, head, ...tables]);
    ok((col.anchors.find((x) => x.key === head.key)?.hit as unknown as El) === tile, JSON.stringify(col.list));
    // Not a control name (a part of a control): nothing.
    const part = new El('uci-header-control-list-item', { 'data-name': 'header_new_name.fieldControl' }).add(new El('div', { slot: 'label' }, 'Nom'));
    eq(scan(pageDom().add(part), [...pageForm, head, ...tables]).list.filter((x) => x[0] === head.key), []);
  });

  test('multi-select on a form: every value is its own part of the text, tied to its option by the chip\'s value', () => {
    const body = pageDom(field(PAGE, 'new_dxtmulti', 'Couleurs', multi('new_dxtmulti', [[100000000, 'Rouge'], [100000001, 'Bleu']], 'Rouge, Bleu')));
    const { list } = scan(body, [...pageForm, ...tables]);
    eq(
      list.filter((a) => a[0].startsWith('option|')),
      [
        ['option|new_dxttest.new_dxtmulti|100000000|Label', 'Rouge@0', false],
        ['option|new_dxttest.new_dxtmulti|100000001|Label', 'Bleu@7', false],
        ['option|new_dxttest.new_dxtmulti|100000000|Label', 'Rouge', false],
        ['option|new_dxttest.new_dxtmulti|100000001|Label', 'Bleu', false],
      ],
      'the text\'s parts, then the chips',
    );
    const lp = pageDom(field(PAGE, 'new_dxtmulti', 'Couleurs', multi('new_dxtmulti', [[100000000, 'Rouge'], [100000001, 'Bleu']], 'Rouge, Bleu', true)));
    eq(scan(lp, [...pageForm, ...tables]).list.filter((a) => a[0].startsWith('option|')).length, 4, 'the control named by its data-lp-id');
    // A chip whose text is another option's label: the control and its value disagree, so that chip and the text get nothing.
    const bad = pageDom(field(PAGE, 'new_dxtmulti', 'Couleurs', multi('new_dxtmulti', [[100000000, 'Bleu'], [100000001, 'Bleu']], 'Bleu, Bleu')));
    eq(scan(bad, [...pageForm, ...tables]).list.filter((a) => a[0].startsWith('option|')), [['option|new_dxttest.new_dxtmulti|100000001|Label', 'Bleu', false]]);
  });

  test('sub-grid: multi-select values, a linked table\'s header names and its choice values (LIVE-FINDINGS 55, 57)', () => {
    const g = grid(
      'children',
      'new_dxttest',
      VIEW,
      [
        ['new_dxtmulti', 'Couleurs'],
        [`${ALIAS}.new_name`, 'Nom lié (Test lié)'],
        [`${ALIAS}.new_linkedkind`, 'Type lié (Test lié)'],
        [`${ALIAS}.createdon`, 'Créé le (Test lié)'],
      ],
      [
        ['new_dxtmulti', 'Rouge, Vert'],
        [`${ALIAS}.new_name`, 'Linked A'],
        [`${ALIAS}.new_linkedkind`, 'Interne'],
      ],
    );
    const { list } = scan(new El('body').add(g), [...pageForm, ...tables, ...linked]);
    eq(list, [
      ['attribute|new_dxttest.new_dxtmulti|DisplayName', 'Couleurs', false],
      ['attribute|new_dxtlinked.new_name|DisplayName', 'Nom lié@0', false],
      ['attribute|new_dxttest.new_linkedid|DisplayName', 'Test lié@9', false],
      ['attribute|new_dxtlinked.new_linkedkind|DisplayName', 'Type lié@0', false],
      ['attribute|new_dxttest.new_linkedid|DisplayName', 'Test lié@10', false],
      ['option|new_dxttest.new_dxtmulti|100000000|Label', 'Rouge@0', false],
      ['option|new_dxttest.new_dxtmulti|100000002|Label', 'Vert@7', false],
      ['option|new_dxtlinked.new_linkedkind|100000000|Label', 'Interne', false],
    ]);
    // The linked table not loaded yet: asked for, nothing anchored for its columns.
    const r = scan(new El('body').add(g), [...pageForm, ...tables]);
    ok(!r.list.some((a) => a[0].includes('new_dxtlinked')) && r.want.includes(WANT_TABLE + 'new_dxtlinked'), JSON.stringify(r));
  });

  test("built-in Microsoft text: system menu items without a form XML entry and Microsoft's own buttons; never what is ours to translate", () => {
    const nav = (id: string, text: string) => new El('div', { role: 'menuitem', 'data-id': `form-tab-relatedEntity-${id}` }, text);
    const btn = (ctl: string, text: string) => new El('button', { 'data-id': `new_dxttest|NoRelationship|Form|${ctl}` }, text);
    // On this form navAudit has an entry of its own (titles, as on Contoso): a normal item, translatable.
    const audit = S('navitem', `navitem|${PAGE}|navAudit|Label`, 'Audit History', '', { formId: PAGE, elId: 'navAudit' }, 'new_dxttest');
    const assign = S('ribbon', 'ribbon|new_dxttest|my.Assign.LabelText|Label', 'Assign', 'Attribuer', { entity: 'new_dxttest', locLabelId: 'my.Assign.LabelText' }, 'new_dxttest');
    const run = S('ribbon', 'ribbon|new_dxttest|new.new_dxttest.DxtButton.LabelText|Label', 'Run test', 'Lancer le test', { entity: 'new_dxttest', locLabelId: 'new.new_dxttest.DxtButton.LabelText' }, 'new_dxttest');
    const body = () =>
      new El('body').add(
        nav('navAsyncOperations', 'Processus en arrière-plan'),
        nav('navAudit', 'Audits'),
        nav('navActivities', 'Activités'),
        nav('nav_new_dxttest_self_nn1', 'Soi deux'),
        btn('Mscrm.Form.new_dxttest.Save', 'Enregistrer'),
        btn('Mscrm.Form.new_dxttest.Assign', 'Attribuer'),
        btn('new.new_dxttest.DxtButton-Large', 'Lancer le test'),
      );
    const ribbon = new Map([
      [
        'new_dxttest',
        new Map<string, RibbonControl>([
          // A Microsoft button someone gave a label of its own, and a custom button: both translatable.
          ['Mscrm.Form.new_dxttest.Assign', { id: 'Mscrm.Form.new_dxttest.Assign', labelText: '$LocLabels:my.Assign.LabelText' }],
          ['new.new_dxttest.DxtButton', { id: 'new.new_dxttest.DxtButton', labelText: '$LocLabels:new.new_dxttest.DxtButton.LabelText' }],
        ]),
      ],
    ]);
    const r = scan(body(), [...pageForm, ...names('new_dxttest', 'Test', 'Tests'), audit, assign, run], undefined, '', ribbon);
    eq(r.list.map((a) => a.slice(0, 2)), [
      ['builtin|nav|navAsyncOperations|Label', 'Processus en arrière-plan'],
      [audit.key, 'Audits'],
      ['builtin|command|Mscrm.Form.new_dxttest.Save|Label', 'Enregistrer'],
      [assign.key, 'Attribuer'],
      [run.key, 'Lancer le test'],
    ]);
    // The activities item and a relationship's item wait for the table's relationships: never built-in.
    ok(r.want.includes(WANT_RELATED + 'new_dxttest'), JSON.stringify(r.want));
    // Before the table's customized buttons are known, no button is called built-in (it may have a label of its own).
    const early = scan(body(), [...pageForm, audit, assign, run]);
    eq(early.list.filter((a) => a[0].includes('command') || a[0].startsWith('ribbon')), []);
    ok(early.want.includes('new_dxttest|Mscrm.Form.new_dxttest.Save'), JSON.stringify(early.want));
    // Its table's names don't matter to a command whose text is never built from them (Save): grey without them, and
    // they are not asked for.
    const unnamed = scan(body(), [...pageForm, audit, assign, run], undefined, '', ribbon);
    eq(unnamed.list.filter((a) => a[0].startsWith('builtin|command')).map((a) => a[0]), ['builtin|command|Mscrm.Form.new_dxttest.Save|Label']);
    ok(!unnamed.want.includes(WANT_NAMES + 'new_dxttest'), JSON.stringify(unnamed.want));
  });

  test("a related menu item the form XML lists without a French title: marked on the text it shows, its table's relationships asked for (LIVE-FINDINGS 80)", () => {
    const nav = (id: string, text: string) => new El('div', { role: 'menuitem', 'data-id': `form-tab-relatedEntity-${id}` }).add(new El('span', {}, text));
    const ID = 'nav_new_dxtlinked_test';
    const item = S('navitem', `navitem|${PAGE}|${ID}|Label`, 'Linked records', '', { formId: PAGE, elId: ID, area: 'nav', relationship: 'new_dxtlinked_test' }, 'new_dxttest');
    const audit = S('navitem', `navitem|${PAGE}|navAudit|Label`, 'Audit History', '', { formId: PAGE, elId: 'navAudit', area: 'nav', relationship: 'hardcoded_{B7196B13-6B9D-42CD-BD58-B19A3953126F}navAudit' }, 'new_dxttest');
    const body = () => new El('body').add(nav(ID, 'Éléments liés'), nav('navAudit', 'Historique d’audit'));
    const r = scan(body(), [...pageForm, item, audit]);
    eq(r.list.map((a) => a.slice(0, 2)), [[item.key, 'Éléments liés'], [audit.key, 'Historique d’audit']]);
    // The text the page shows by itself is kept on the anchor (the popup's placeholder; the preview may swap the node).
    eq(r.anchors.map((a) => a.orig), ['Éléments liés', 'Historique d’audit']);
    ok(r.want.includes(WANT_RELATED + 'new_dxttest'), JSON.stringify(r.want));
    // Its relationship and the listed table's plural name loaded: marked on the plural name's text, nothing asked for.
    const rel = S('relationship', 'relationship|new_dxtlinked_test|Label', '', '', { schemaName: 'new_dxtlinked_test', type: 'OneToMany', referenced: 'new_dxttest', referencing: 'new_dxtlinked', menu: 'plural' }, 'new_dxttest');
    const plural = S('entity', 'entity|new_dxtlinked|DisplayCollectionName', 'Linked records', 'Éléments liés', { entity: 'new_dxtlinked' }, 'new_dxtlinked', 'DisplayCollectionName');
    const r2 = scan(body(), [...pageForm, item, audit, rel, plural]);
    eq(r2.list.map((a) => a.slice(0, 2)), [[item.key, 'Éléments liés'], [audit.key, 'Historique d’audit']]);
    eq(r2.want.filter((w) => w.startsWith(WANT_RELATED)), []);
    // A built-in item alone never asks for relationships (its text is the language pack's).
    eq(scan(new El('body').add(nav('navAudit', 'Historique d’audit')), [...pageForm, audit]).want, []);
  });

  test('the Related tab is built-in Microsoft text once its form is known; a click only opens its popup; a form tab stays translatable', async () => {
    const { clickLabel } = await import('../../../src/inspector/mode');
    // As UCI renders it (live 2026-10-16, new_dxttest and account forms): its text twice (a hidden sizing copy) and a chevron.
    const REL = 'tab_related3b554255-7717-4d17-bb7f-9936fb1e75ca';
    const related = (title = 'Association') =>
      new El('li', { id: 'related_tab_0', role: 'tab', 'aria-haspopup': 'true', title, 'data-lp-id': 'form-tab-related_tab', 'data-id': `tablist-${REL}` }).add(
        new El('div', { id: 'container_related_tab_0', role: 'presentation' }, title).add(new El('span', { id: 'relatedChevronIcon_related_tab_0' })),
        new El('div', { 'aria-hidden': 'true' }, title),
      );
    const page = () => pageDom().add(new El('ul').add(related()));
    const r = scan(page(), [...pageForm, ...tables]);
    eq(r.list.filter((a) => a[0].startsWith('builtin|') || a[0].startsWith('tab|')), [
      [`tab|${PAGE}|tp|Label`, 'Général', false],
      ['builtin|tab|related|Label', 'Association', false],
    ]);
    const a = r.anchors.find((z) => z.key === 'builtin|tab|related|Label')!;
    eq([a.kind, a.role, (a.el as unknown as El).id], ['tab', 'nav', 'related_tab_0']);
    // A click opens the popup and never the related menu (Open, or Alt+click, does).
    const log: string[] = [];
    clickLabel(a, null, { move: () => void log.push('move'), open: (b) => void log.push(`open ${b.key}`) });
    eq(log, ['open builtin|tab|related|Label']);
    // The page form's labels not loaded yet: nothing (a tab of that name may be in its form XML).
    eq(scan(page(), [...tables]).list.filter((z) => z[0].startsWith('builtin|')), []);
    // A tab of that name in the form XML is the form's own: translatable.
    const own = S('tab', `tab|${PAGE}|tr|Label`, 'Association', 'Association', { formId: PAGE, tabName: REL }, 'new_dxttest');
    eq(scan(page(), [...pageForm, own, ...tables]).list.filter((z) => z[0].startsWith('builtin|') || z[0] === own.key), [[own.key, 'Association', false]]);
    // A form tab that reads like it, and the tab bar's other tabs: theirs, never built-in.
    const look = S('tab', `tab|${PAGE}|tl|Label`, 'Links', 'Association', { formId: PAGE, tabName: 'tab_links' }, 'new_dxttest');
    const both = pageDom().add(new El('ul').add(tab('tab_links', 'Association'), related()));
    eq(scan(both, [...pageForm, look, ...tables]).list.filter((z) => z[0].startsWith('builtin|') || z[0] === look.key), [
      [look.key, 'Association', false],
      ['builtin|tab|related|Label', 'Association', false],
    ]);
    // In a side pane: once the pane's form is loaded.
    const inPane = () => pageDom().add(pane(new El('ul').add(tab('general', 'Général'), related()), panel('general', section('s1', 'Détails', field(PANE, 'new_name', 'Nom lié')))));
    eq(scan(inPane(), [...pageForm, ...paneForm, ...tables, ...linked]).list.filter((z) => z[0].startsWith('builtin|')), [['builtin|tab|related|Label', 'Association', true]]);
    eq(scan(inPane(), [...pageForm, ...tables]).list.filter((z) => z[0].startsWith('builtin|')), []);
    // In quick create or a dialog: nothing.
    const qc = pageDom().add(new El('div', { 'data-id': 'quickCreateRoot' }).add(new El('ul').add(related())));
    eq(scan(qc, [...pageForm, ...tables]).list.filter((z) => z[0].startsWith('builtin|')), []);
  });

  test("process stages: the chip's id names the stage, whatever (cached) name the page still shows", () => {
    const WF = '9a6faaaa-0000-4000-8000-0000000000b1';
    const ids = ['8f912143-0000-4000-8000-000000000051', '3db789f2-0000-4000-8000-000000000053'];
    const stages = ids.map((id, i) => S('stage', `stage|${WF}|${id}|Label`, `Test${i + 1}`, '', { workflowId: WF, labelId: id, stageId: id }, 'new_dxttest'));
    const chip = (id: string, name: string) =>
      new El('li', { id: `MscrmControls.Containers.ProcessBreadCrumb-processHeaderStage_${id}` }).add(new El('div', { id: `MscrmControls.Containers.ProcessBreadCrumb-processHeaderStageName_${id}` }, name));
    // The definition says Test1 / Test2 (no French); the page still shows French names from before (LIVE-FINDINGS 64).
    // A chip naming a stage this process doesn't have is never matched by its name.
    const body = new El('body').add(new El('ul').add(chip(ids[0], 'Étape E2E'), chip(ids[1], 'Test2'), chip('00000000-0000-0000-0000-000000000009', 'Test2')));
    eq(scan(body, [...pageForm, ...stages], undefined, WF).list.filter((a) => a[0].startsWith('stage|')), [
      [stages[0].key, 'Étape E2E', false],
      [stages[1].key, 'Test2', false],
    ]);
    eq(scan(body, [...pageForm, ...stages], undefined, '').list.filter((a) => a[0].startsWith('stage|')), [], 'another process (or none) on the page: nothing');
    // A step in the stage's flyout (a dialog of the page form): the step its container names (LIVE-FINDINGS 64).
    const STEP = '4550377b-0000-4000-8000-000000000052';
    const step = S('step', `step|${WF}|${STEP}|Label`, 'Account Name', '', { workflowId: WF, labelId: STEP, attribute: 'name', stageId: ids[0] }, 'new_dxttest');
    const stepBox = (id: string, label: string) =>
      new El('div', { 'data-id': `fieldSectionItem_0_${id}-FieldSectionItemContainer`, id: 'header_process_name-header_process_name-FieldSectionItemContainer' }).add(
        new El('div', { title: label }).add(new El('label', { id: 'header_process_name-header_process_name-field-label' }, label)),
      );
    const flyout = (...kids: El[]) => new El('div', { role: 'dialog', id: `MscrmControls.Containers.ProcessStageControl-processHeaderStageFlyoutContainer_${ids[0]}` }).add(...kids);
    const withStep = new El('body').add(flyout(stepBox(STEP, 'Pas E2E'), stepBox('00000000-0000-0000-0000-000000000009', 'Other')));
    eq(scan(withStep, [...pageForm, ...stages, step], undefined, WF).list.filter((a) => a[0].startsWith('step|')), [[step.key, 'Pas E2E', false]]);
    // The same container outside the process flyout (another form's dialog) is not the page's step.
    const elsewhere = new El('body').add(new El('div', { role: 'dialog' }).add(stepBox(STEP, 'Pas E2E')));
    eq(scan(elsewhere, [...pageForm, ...stages, step], undefined, WF).list.filter((a) => a[0].startsWith('step|')), []);
  });

  test("process stage flyout: its title is the stage its id names (no Show stage: it is the open flyout), its buttons Microsoft's text; its status and close button no label", async () => {
    const { describe } = await import('../../../src/inspector/describe');
    const WF = '9a6faaaa-0000-4000-8000-0000000000b1';
    const ID = '8f912143-0000-4000-8000-000000000051';
    const P = 'MscrmControls.Containers.ProcessStageControl-';
    const stage = S('stage', `stage|${WF}|${ID}|Label`, 'Test1s', '', { workflowId: WF, labelId: ID, stageId: ID }, 'new_dxttest');
    const step = S('step', `step|${WF}|4550377b-0000-4000-8000-000000000052|Label`, 'Account Name', '', { workflowId: WF, labelId: '4550377b-0000-4000-8000-000000000052', attribute: 'name', stageId: ID }, 'new_dxttest');
    // As UCI renders it (live 2026-10-17): the dialog, the flyout inside it, the title, the status, the close and Next Stage buttons.
    const flyout = (id = ID, ...kids: El[]) =>
      new El('div', { role: 'dialog', id: `${P}processHeaderStageFlyoutContainer_${id}` }).add(
        new El('div', { id: `${P}processHeaderStageFlyout_${id}` }).add(
          new El('div', { id: `${P}stageContentHeader` }).add(new El('label', { id: `${P}flyoutStageName` }, 'Test1s'), new El('span', {}, '(Actif pour 50 heures)'), new El('button', { id: `${P}stageContentClose` })),
          ...kids,
          new El('button', { id: `${P}nextButtonContainer` }).add(new El('label', { id: `${P}Next Stage` }, 'Étape suivante')),
          new El('button', { id: `${P}otherButton` }).add(new El('label', { id: `${P}Something Else` }, 'Autre')),
        ),
      );
    const r = scan(new El('body').add(flyout()), [...pageForm, stage, step], undefined, WF);
    eq(r.list, [
      [stage.key, 'Test1s', false],
      ['builtin|stage|Next Stage|Label', 'Étape suivante', false],
    ]);
    const [title, next] = r.anchors;
    const id = (e: Element | undefined) => (e as unknown as El | undefined)?.id;
    eq([title.role, id(title.zone ?? title.el), next.role, id(next.zone)], ['label', `${P}flyoutStageName`, 'command', `${P}nextButtonContainer`]);
    // Its popup: the stage's label, and no Show stage (the flyout is open: there is nothing more to show).
    const store = new Store();
    store.add([stage, step]);
    const app = { store, ctx: { base: EN, user: FR, langs: [{ lcid: EN }, { lcid: FR }] }, prefs: { target: FR, shown: [] } } as unknown as Parameters<typeof describe>[0];
    const m = describe(app, stage.comp, title);
    eq([m.kind, m.action, m.blocks.map((b) => b.key)], ['Stage', undefined, [stage.key]]);
    // A stage of another process (or none): the title is not this one; its buttons stay Microsoft's.
    eq(scan(new El('body').add(flyout('00000000-0000-0000-0000-000000000009')), [...pageForm, stage], undefined, WF).list, [['builtin|stage|Next Stage|Label', 'Étape suivante', false]]);
    eq(scan(new El('body').add(flyout()), [...pageForm, stage], undefined, '').list.map((a) => a[0]), ['builtin|stage|Next Stage|Label']);
    // Those labels outside a stage flyout, or in a side pane: nothing.
    const loose = new El('body').add(new El('div', { role: 'dialog' }).add(new El('label', { id: `${P}flyoutStageName` }, 'Test1s'), new El('label', { id: `${P}Next Stage` }, 'Étape suivante')));
    eq(scan(loose, [...pageForm, stage], undefined, WF).list, []);
    eq(scan(new El('body').add(pane(flyout())), [...pageForm, stage], undefined, WF).list, []);
  });

  test("process name: the header's name label is the record's active process, whatever (cached) name it shows; another process never", () => {
    const WF = '9a6faaaa-0000-4000-8000-0000000000b1';
    const name = S('bpf', `bpf|${WF}|Name`, 'bpf test', '', { id: WF, table: 'workflow', entitySet: 'workflows', column: 'name', entity: 'new_dxttest' }, 'new_dxttest', 'Name');
    const desc = S('bpf', `bpf|${WF}|Description`, '', '', { id: WF, table: 'workflow', entitySet: 'workflows', column: 'description', entity: 'new_dxttest' }, 'new_dxttest', 'Description');
    // As rendered live (LIVE-FINDINGS 82): the name label next to the stage chips, its text also in its title.
    const header = (text: string) =>
      new El('div', { id: 'MscrmControls.Containers.ProcessBreadCrumb-processHeaderContainer' }).add(
        new El('div', { id: 'MscrmControls.Containers.ProcessBreadCrumb-processHeaderNameLabel', title: text }, text),
      );
    const names = (body: El, bpf = WF) => scan(body, [...pageForm, name, desc], undefined, bpf).list.filter((a) => a[0].startsWith('bpf|'));
    // The definition has no French name; the page may still show one from before (UCI keeps a process's names cached).
    eq(names(new El('body').add(header('Processus E2E'))), [[name.key, 'Processus E2E', false]]);
    eq(names(new El('body').add(header('bpf test'))), [[name.key, 'bpf test', false]]);
    eq(names(new El('body').add(header('bpf test')), ''), [], 'no active process known: nothing');
    // The form API names another process (just switched to, the index not rebuilt yet): never the old one's name.
    const data = xrm.Page.data as Record<string, unknown>;
    try {
      data.process = { getActiveProcess: () => ({ getId: () => '{00000000-0000-0000-0000-000000000009}' }) };
      eq(names(new El('body').add(header('Other process'))), []);
      data.process = { getActiveProcess: () => ({ getId: () => `{${WF.toUpperCase()}}` }) };
      eq(names(new El('body').add(header('bpf test'))), [[name.key, 'bpf test', false]]);
    } finally {
      delete data.process;
    }
    // A side pane's record shows its own process: never the page's.
    eq(names(new El('body').add(pane(header('bpf test')))), []);
    const a = scan(new El('body').add(header('bpf test')), [...pageForm, name, desc], undefined, WF).anchors.find((z) => z.comp === `bpf|${WF}`)!;
    eq([a.kind, a.role, ((a.zone ?? a.el) as unknown as El).id], ['bpf', 'label', 'MscrmControls.Containers.ProcessBreadCrumb-processHeaderNameLabel']);
  });

  test('page loads: the process name is a load of its own (also when the stages are in); a failed read says so and Try again reads it again; another process on the record loads that one, and the previous one leaves the list', async () => {
    const WF = '9a6faaaa-0000-4000-8000-0000000000b1';
    const WF2 = '00000000-0000-0000-0000-000000000009';
    const STAGE = '8f912143-0000-4000-8000-000000000051';
    const name = (id: string) => S('bpf', `bpf|${id}|Name`, 'bpf test', '', { id, table: 'workflow', entitySet: 'workflows', column: 'name', entity: 'new_dxttest' }, 'new_dxttest', 'Name');
    const stage = (id: string) => S('stage', `stage|${id}|${STAGE}|Label`, 'Test1', '', { workflowId: id, labelId: STAGE, stageId: STAGE }, 'new_dxttest');
    const calls: string[] = [];
    let fail = 0;
    const providers = {
      loadRecords: async (_c: unknown, kind: string, ids: string[]) => {
        if (kind !== 'bpf') return [];
        calls.push(`name ${ids.join()}`);
        if (fail-- > 0) throw new Error('Too many requests.');
        return ids.map(name);
      },
      loadBpf: async (_c: unknown, id: string) => (calls.push(`stages ${id}`), [stage(id)]),
      loadBpfStored: async (_c: unknown, slots: Slot[]) => ({ slots, missed: [] }),
      loadTables: async () => [],
      loadFormXml: async () => [S('tab', `tab|${PAGE}|t1|Label`, 'General', 'Général', { formId: PAGE }, 'new_dxttest')],
    };
    const mk = (store: Store, x: unknown = {}) => {
      const app = { ctx: { xrm: x, user: FR, base: EN, langs: [{ lcid: EN }, { lcid: FR }] }, providers, store, lang: {} } as unknown as ConstructorParameters<typeof PageLoader>[0];
      return new PageLoader(app, () => {});
    };
    const settle = async (ld: PageLoader) => {
      for (let i = 0; i < 100 && !calls.length; i++) await new Promise((r) => setTimeout(r, 5));
      for (let i = 0; i < 100 && ld.busy.size; i++) await new Promise((r) => setTimeout(r, 5));
    };
    const page = { info: { type: 'entityrecord' } as never, sig: 's', entity: 'new_dxttest', formId: '', viewId: '', bpfId: WF };
    // The stages are in (another view loaded them, or a version that loaded them without the name): only the name.
    const a = new Store();
    a.add([stage(WF)]);
    const ld = mk(a);
    ld.page = { ...page };
    ld.start();
    await settle(ld);
    eq([calls, [...ld.errors.values()], a.get(`bpf|${WF}|Name`)?.labels[EN]], [[`name ${WF}`], [], 'bpf test']);
    // A failed name read (throttled): the bar says so, the stages are in all the same, and Try again reads it again.
    calls.length = 0;
    fail = 1;
    const b = new Store();
    const ld2 = mk(b);
    ld2.page = { ...page };
    ld2.start();
    await settle(ld2);
    eq([calls.sort(), [...ld2.errors.values()], !!b.get(`stage|${WF}|${STAGE}|Label`), !!b.get(`bpf|${WF}|Name`)], [[`name ${WF}`, `stages ${WF}`], ['Could not load the process name. Too many requests.'], true, false]);
    calls.length = 0;
    ld2.retry();
    await settle(ld2);
    eq([calls, [...ld2.errors.values()], b.get(`bpf|${WF}|Name`)?.labels[EN]], [[`name ${WF}`], [], 'bpf test'], 'only the name again');
    // Switch Process on the same record: the new process loads, and sync() names the previous one, once.
    let active = WF;
    const sx = {
      Utility: { getPageContext: () => ({ input: { pageType: 'entityrecord', entityName: 'new_dxttest', entityId: '6f3e0a52-0000-0000-0000-000000000001' } }) },
      Page: {
        data: { entity: { getEntityName: () => 'new_dxttest' }, process: { getActiveProcess: () => ({ getId: () => `{${active.toUpperCase()}}` }) } },
        ui: { formSelector: { getCurrentItem: () => ({ getId: () => `{${PAGE.toUpperCase()}}` }), items: { get: () => [] } }, controls: { get: () => [] } },
      },
    };
    const g = globalThis as Record<string, unknown>;
    const had = g.location;
    g.location = { search: '', href: 'https://org.crm.dynamics.com/main.aspx' };
    try {
      calls.length = 0;
      const c = new Store();
      const ld3 = mk(c, sx);
      eq([ld3.sync(), ld3.switchedFrom], [true, '']);
      await settle(ld3);
      eq(calls.sort(), [`name ${WF}`, `stages ${WF}`]);
      calls.length = 0;
      active = WF2;
      eq([ld3.sync(), ld3.switchedFrom, ld3.page?.bpfId], [false, WF, WF2]);
      await settle(ld3);
      eq([calls.sort(), !!c.get(`bpf|${WF2}|Name`), !!c.get(`stage|${WF2}|${STAGE}|Label`)], [[`name ${WF2}`, `stages ${WF2}`], true, true]);
      eq([ld3.sync(), ld3.switchedFrom], [false, ''], 'said once');
    } finally {
      if (had === undefined) delete g.location;
      else g.location = had;
    }
    // What "All labels" lists of the previous process (mode.ts navigate): its name, stages and steps go, nothing else.
    const sc = new Scanner();
    for (const comp of [`bpf|${WF}`, `stage|${WF}|${STAGE}`, `step|${WF}|x`, `bpf|${WF2}`, `stage|${WF2}|${STAGE}`, `field|${PAGE}|c1`]) sc.seen.add(comp);
    sc.forget(ofProcess(WF));
    eq([...sc.seen], [`bpf|${WF2}`, `stage|${WF2}|${STAGE}`, `field|${PAGE}|c1`]);
  });

  test("page loads: on a record, a process's stages and steps go into the store once, with the names Dynamics keeps for them, read for that record through the page's language switch (LIVE-FINDINGS 85); none without a record; a language not read says so and Try again reads both again; stages another view loaded without them are read again", async () => {
    const WF = '9a6faaaa-0000-4000-8000-0000000000b1';
    const STAGE = '8f912143-0000-4000-8000-000000000051';
    const REC = '6f3e0a52-0000-0000-0000-000000000001';
    const APP = 'b0d1e2f3-0000-0000-0000-000000000002';
    const KEY = `stage|${WF}|${STAGE}|Label`;
    const stage = (stored?: number[]) => S('stage', KEY, 'Test1s', '', { workflowId: WF, labelId: STAGE, stageId: STAGE, primary: 'new_dxttest', ...(stored ? { stored } : {}) }, 'new_dxttest');
    const lang = { name: 'the language switch' };
    const calls: string[] = [];
    let miss = 0;
    let store = new Store();
    const providers = {
      loadRecords: async (_c: unknown, kind: string) => (kind === 'bpf' && calls.push('name'), []),
      loadBpf: async () => (calls.push('stages'), [stage()]),
      loadBpfStored: async (_c: unknown, slots: Slot[], page: { entity: string; record: string; app: string }, o: { lang?: unknown }) => {
        // The stages go into the store only with the names Dynamics keeps: a stage whose French name is only kept there
        // was marked as not translated meanwhile, then turned blue.
        calls.push(`kept ${page.entity} ${page.record} ${page.app || '-'} ${o.lang === lang ? 'switch' : 'no switch'} ${store.get(KEY) ? 'after' : 'before'} the stages`);
        // As providers/bpf.ts withStored: a language it misses keeps the name read before, and its place in ref.stored.
        if (miss-- > 0) return { slots: slots.map((s) => ({ ...s, ref: { ...s.ref, unread: [FR] } })), missed: [FR] };
        // As providers/bpf.ts: a read that missed nothing clears ref.unread.
        return { slots: slots.map((s) => ({ ...s, labels: { ...s.labels, [FR]: 'Étape 1 FR' }, ref: { ...s.ref, stored: [FR], unread: undefined } })), missed: [] };
      },
      loadTables: async () => [],
      appSitemapId: async () => null,
    };
    const mk = (record: string, appId = APP) => {
      const app = { ctx: { xrm: {}, user: FR, base: EN, langs: [{ lcid: EN }, { lcid: FR }] }, providers, store, lang } as unknown as ConstructorParameters<typeof PageLoader>[0];
      const ld = new PageLoader(app, () => {});
      ld.page = { info: { type: 'entityrecord', recordId: record, appId } as never, sig: 's', entity: 'new_dxttest', formId: '', viewId: '', bpfId: WF };
      return ld;
    };
    const settle = async (ld: PageLoader) => {
      for (let i = 0; i < 100 && !calls.length; i++) await new Promise((r) => setTimeout(r, 5));
      for (let i = 0; i < 100 && ld.busy.size; i++) await new Promise((r) => setTimeout(r, 5));
    };
    const ld = mk(REC);
    ld.start();
    await settle(ld);
    eq([calls.slice().sort(), [...ld.errors.values()], store.get(KEY)?.labels[FR], store.get(KEY)?.ref.stored], [['kept new_dxttest ' + REC + ' ' + APP + ' switch before the stages', 'name', 'stages'], [], 'Étape 1 FR', [FR]]);
    // No record (a new one): the definition only.
    calls.length = 0;
    store = new Store();
    const ld2 = mk('', '');
    ld2.start();
    await settle(ld2);
    eq([calls.slice().sort(), store.get(KEY)?.labels[FR], store.get(KEY)?.ref.stored], [['name', 'stages'], '', undefined]);
    // French could not be read: the bar says so, the definition's labels stay, and Try again reads both again.
    calls.length = 0;
    store = new Store();
    miss = 1;
    const ld3 = mk(REC, '');
    ld3.start();
    await settle(ld3);
    eq([calls.slice().sort(), [...ld3.errors.values()], store.get(KEY)?.labels[EN]], [[`kept new_dxttest ${REC} - switch before the stages`, 'name', 'stages'], ["Could not load the process's stage and step names in French."], 'Test1s']);
    calls.length = 0;
    ld3.retry();
    await settle(ld3);
    eq([calls.slice().sort(), [...ld3.errors.values()], store.get(KEY)?.labels[FR]], [[`kept new_dxttest ${REC} - switch after the stages`, 'stages'], [], 'Étape 1 FR'], 'the name is in: only the stages and their names again');
    // Stages another view loaded (the Workbench reads no kept names), or with a language not read: read again on a
    // record; once read, not again.
    for (const [had, want] of [
      [stage(), ['kept', 'name', 'stages']],
      [{ ...stage([]), ref: { ...stage([]).ref, unread: [FR] } }, ['kept', 'name', 'stages']],
      [stage([]), ['name']],
    ] as const) {
      calls.length = 0;
      store = new Store();
      store.add([had]);
      const l = mk(REC);
      l.start();
      await settle(l);
      eq(calls.map((c) => c.split(' ')[0]).sort(), want, JSON.stringify(had.ref));
    }
  });

  test("page loads: the names Dynamics keeps stay while the process is loaded again (they are carried into the read, and stay where it misses them); a process first loaded on a new record reads them once the record is saved, then not again on the next record; never on another table's record", async () => {
    const WF = '9a6faaaa-0000-4000-8000-0000000000b1';
    const STAGE = '8f912143-0000-4000-8000-000000000051';
    const REC = '6f3e0a52-0000-0000-0000-000000000001';
    const REC2 = '6f3e0a52-0000-0000-0000-000000000002';
    const KEY = `stage|${WF}|${STAGE}|Label`;
    const stage = (more: Record<string, unknown> = {}, fr = '') => S('stage', KEY, 'Test1s', fr, { workflowId: WF, labelId: STAGE, stageId: STAGE, primary: 'new_dxttest', ...more }, 'new_dxttest');
    const calls: string[] = [];
    let miss = 0;
    const store = new Store();
    const providers = {
      loadRecords: async (_c: unknown, kind: string) => (kind === 'bpf' && calls.push('name'), []),
      loadBpf: async () => (calls.push('stages'), [stage()]),
      loadBpfStored: async (_c: unknown, slots: Slot[], page: { entity: string; record: string }) => {
        // What the popups show while the names are read: the definition's labels, with the names read before.
        calls.push(`kept ${page.record} ${store.get(KEY)?.labels[FR] || 'none'}`);
        if (page.entity !== 'new_dxttest') return { slots, missed: [] }; // as providers/bpf.ts: not on another table's record
        // As providers/bpf.ts withStored: a language it misses keeps the name read before, and its place in ref.stored.
        if (miss-- > 0) return { slots: slots.map((s) => ({ ...s, ref: { ...s.ref, unread: [FR] } })), missed: [FR] };
        // As providers/bpf.ts: a read that missed nothing clears ref.unread.
        return { slots: slots.map((s) => ({ ...s, labels: { ...s.labels, [FR]: 'Étape 1 FR' }, ref: { ...s.ref, stored: [FR], unread: undefined } })), missed: [] };
      },
      loadTables: async () => [],
      appSitemapId: async () => null,
    };
    const app = { ctx: { xrm: {}, user: FR, base: EN, langs: [{ lcid: EN }, { lcid: FR }] }, providers, store, lang: {} } as unknown as ConstructorParameters<typeof PageLoader>[0];
    const settle = async (ld: PageLoader) => {
      for (let i = 0; i < 100 && !calls.length; i++) await new Promise((r) => setTimeout(r, 5));
      for (let i = 0; i < 100 && ld.busy.size; i++) await new Promise((r) => setTimeout(r, 5));
    };
    const at = (ld: PageLoader, record: string, entity = 'new_dxttest') =>
      (ld.page = { info: { type: 'entityrecord', recordId: record, appId: '' } as never, sig: `s${record}${entity}`, entity, formId: '', viewId: '', bpfId: WF });
    const fr = () => [store.get(KEY)?.labels[FR] ?? '', store.get(KEY)?.ref.stored, store.get(KEY)?.ref.unread];
    // A French name read before, French not read the last time: read again, the name staying meanwhile and after a miss.
    store.add([stage({ stored: [FR], unread: [FR] }, 'Étape 1 FR')]);
    const ld = new PageLoader(app, () => {});
    at(ld, REC);
    miss = 1;
    ld.start();
    await settle(ld);
    eq([calls.slice().sort(), [...ld.errors.values()], fr()], [[`kept ${REC} Étape 1 FR`, 'name', 'stages'], ["Could not load the process's stage and step names in French."], ['Étape 1 FR', [FR], [FR]]]);
    calls.length = 0;
    ld.retry();
    await settle(ld);
    eq([calls.slice().sort(), [...ld.errors.values()], fr()], [[`kept ${REC} Étape 1 FR`, 'stages'], [], ['Étape 1 FR', [FR], undefined]]);
    // A new record: the definition only. Once saved (the page is a record now), the names are read; on the next record,
    // not again.
    store.slots.clear();
    calls.length = 0;
    const nw = new PageLoader(app, () => {});
    at(nw, '');
    nw.start();
    await settle(nw);
    eq([calls.slice().sort(), fr()], [['name', 'stages'], ['', undefined, undefined]]);
    calls.length = 0;
    at(nw, REC);
    nw.start();
    await settle(nw);
    eq([calls.slice().sort(), fr()], [[`kept ${REC} none`, 'stages'], ['Étape 1 FR', [FR], undefined]]);
    calls.length = 0;
    at(nw, REC2);
    nw.start();
    await settle(nw);
    eq(calls, [], 'read once');
    // A process of another table (a later stage's record): never read there, and not loaded again on each record.
    store.slots.clear();
    calls.length = 0;
    const ot = new PageLoader(app, () => {});
    at(ot, REC, 'contact');
    ot.start();
    await settle(ot);
    eq([calls.slice().sort(), fr()], [[`kept ${REC} none`, 'name', 'stages'], ['', undefined, undefined]]);
    calls.length = 0;
    at(ot, REC2, 'contact');
    ot.start();
    await settle(ot);
    eq(calls, []);
  });

  test('page loads: a side pane\'s form in every language, a quick view\'s form for its cells, a view\'s query, each once and quietly', async () => {
    const calls: string[] = [];
    const store = new Store();
    const lang = { name: 'the language switch' };
    const providers = {
      loadFormXml: async (_c: unknown, refs: Array<{ formId: string }>, langs: number[], o: { lang?: unknown }) => {
        const id = refs[0].formId;
        calls.push(`form ${id} ${langs.join('+')} ${o.lang === lang ? 'switch' : 'no switch'}`);
        if (id === QV) throw new Error('gone');
        // The pane's form holds a quick view too: its form is read next.
        return id === PANE ? [...paneForm, cell(PANE, 'l3', 'kindqv', 'new_kindid', 'Kind', 'Type', 'new_dxtlinked', G, { quickForms: ['00000000-0000-0000-0000-0000000000a1'] })] : [];
      },
      loadTables: async (_c: unknown, t: string[]) => (calls.push(`table ${t.join()}`), []),
      viewQuery: async (_c: unknown, id: string) => (calls.push(`view ${id}`), FETCH),
    };
    const app = { ctx: { xrm: {}, user: FR, base: EN, langs: [{ lcid: EN }, { lcid: FR }] }, providers, store, lang } as unknown as ConstructorParameters<typeof PageLoader>[0];
    const ld = new PageLoader(app, () => {});
    ld.request([WANT_FORM + PANE, WANT_QUICK + QV, WANT_VIEW + VIEW, WANT_FORM + 'not-a-form']);
    ld.request([WANT_FORM + PANE, WANT_VIEW + VIEW]); // asked once
    for (let i = 0; i < 50 && (ld.busy.size || calls.length < 6); i++) await new Promise((r) => setTimeout(r, 5));
    eq(calls.sort(), [
      `form ${PANE} ${EN}+${FR} switch`,
      `form ${QV} ${EN}+${FR} no switch`,
      'form 00000000-0000-0000-0000-0000000000a1 1033+1036 no switch',
      'table new_dxtlinked',
      `view ${VIEW}`,
    ].sort());
    ok(store.get(`field|${PANE}|l1|Label`), 'the pane form\'s labels are in the store');
    eq([...(ld.queries.get(VIEW)?.keys() || [])], [ALIAS], 'the view\'s linked tables');
    eq([...ld.errors.values()], [], 'a form that could not be read says nothing on the bar');
  });

  test('a side pane\'s grid: its table and view come from the grid itself, never from the page form\'s control of that name', () => {
    // The page's 'children' shows new_dxttest; the pane's grid of the same name shows new_dxtlinked.
    const g = grid('children', 'new_dxtlinked', VIEW2, [['new_linkedkind', 'Type lié'], ['a_t.new_dxtmulti', 'Couleurs (Test)']], [['new_linkedkind', 'Externe']]);
    const links = new Map([[VIEW2, queryLinks('<fetch><entity name="new_dxtlinked"><link-entity alias="a_t" name="new_dxttest" to="new_testid" from="new_dxttestid"><attribute name="new_dxtmulti"/></link-entity></entity></fetch>')]]);
    const reads = new Map([[VIEW2, 'new_dxtlinked']]); // the table VIEW2's query reads (PageLoader.viewTables)
    const at = (el: El, views = reads, gaveUp = new Set<string>(), q = links) => scan(new El('body').add(pane(el)), [...pageForm, ...tables, ...linked], q, '', undefined, views, gaveUp);
    const all = [
      ['attribute|new_dxtlinked.new_linkedkind|DisplayName', 'Type lié', true],
      ['attribute|new_dxttest.new_dxtmulti|DisplayName', 'Couleurs@0', true],
      ['option|new_dxtlinked.new_linkedkind|100000001|Label', 'Externe', true],
    ];
    eq(at(g).list, all);
    // The view's query not read yet: nothing (its table is the query's), and it is asked for.
    const r = at(g, new Map(), undefined, new Map());
    ok(!r.list.length && r.want.includes(WANT_VIEW + VIEW2), JSON.stringify(r));
    // A grid whose data-lp-id names another table (the pane form's) than its view reads: the view's table decides.
    const wrong = new El('div', { 'data-control-name': 'children' }).add(
      gridRoot(`Microsoft.PowerApps.PowerAppsOneGrid|children|new_dxttest|${VIEW2}`, [['new_linkedkind', 'Type lié']], []),
    );
    eq(at(wrong).list, [all[0]]);
    // That read failed (given up): the table the grid names, as before.
    const head = wrong.children[0].children[0] as unknown as Element;
    eq(at(wrong, new Map(), new Set([WANT_VIEW + VIEW2])).sc.gridTable(head), 'new_dxttest');
  });

  // ---- associated views: a related menu item's view on the record form (LIVE-FINDINGS 88) ----

  /** VIEW3's query reads new_dxtlinked (PageLoader.viewTables). */
  const known = () => new Map([[VIEW3, 'new_dxtlinked']]);

  test("associated grid (a related tab): headers and choice values of the related table its data-lp-id names, once its view reads that table; never the page table's columns", () => {
    const slots = [...pageForm, col('new_dxttest.new_name', 'Name', 'Nom'), ...tables, ...linked];
    const heads: Array<[string, string]> = [
      ['new_name', 'Nom lié'],
      ['new_linkedkind', 'Type lié'],
    ];
    const cells: Array<[string, string]> = [['new_linkedkind', 'Externe']];
    const want = [
      ['attribute|new_dxtlinked.new_name|DisplayName', 'Nom lié', false],
      ['attribute|new_dxtlinked.new_linkedkind|DisplayName', 'Type lié', false],
      ['option|new_dxtlinked.new_linkedkind|100000001|Label', 'Externe', false],
    ];
    const at = (g: El, s = slots, views = known()) => scan(new El('body').add(g), s, undefined, '', undefined, views);
    eq(at(assoc(heads, cells)).list, want);
    // Its view's query not read yet: nothing, and the query is asked for (its table is checked against the grid's).
    const early = at(assoc(heads, cells), slots, new Map());
    eq(early.list, []);
    ok(early.want.includes(WANT_VIEW + VIEW3), JSON.stringify(early.want));
    eq(at(assoc(heads, cells), slots, new Map([[VIEW3, 'new_dxttest']])).list, [], 'the view reads another table');
    eq(at(assoc(heads, cells, `Microsoft.PowerApps.PowerAppsOneGrid|entity_control|account|${VIEW3}|new_dxtlinked|${REL}`)).list, [], "another page table's grid");
    // The related table's columns not loaded yet: asked for.
    const cold = at(assoc(heads, cells), [...pageForm, col('new_dxttest.new_name', 'Name', 'Nom'), ...tables]);
    eq(cold.list, []);
    ok(cold.want.includes(WANT_TABLE + 'new_dxtlinked'), JSON.stringify(cold.want));
    eq(at(assoc(heads, cells, undefined, false)).list, want, 'without the container UCI renders it in');
    // A re-render can reuse the grid's elements for another related view: its table follows the grid's data-lp-id.
    const g = assoc([['statuscode', 'Raison du statut']], []);
    const head = g.children[0].children[0] as unknown as Element;
    const z = at(g, slots, new Map([...known(), [VIEW2, 'new_dxttest']]));
    eq(z.sc.gridTable(head), 'new_dxtlinked');
    g.children[0].attrs['data-lp-id'] = `Microsoft.PowerApps.PowerAppsOneGrid|entity_control|new_dxttest|${VIEW2}|new_dxttest|new_dxttest_parent`;
    eq(z.sc.gridTable(head), 'new_dxttest', 'not the table found for the grid it showed before');
    // A side pane's associated grid: the table its data-lp-id names in part 4 (part 2 is the pane form's table).
    const inPane = pane(assoc([['new_dxtmulti', 'Couleurs']], [], `Microsoft.PowerApps.PowerAppsOneGrid|entity_control|new_dxtlinked|${VIEW2}|new_dxttest|${REL}`));
    const paneAt = (views: Map<string, string>) => scan(new El('body').add(inPane), [...pageForm, ...tables, ...linked], undefined, '', undefined, views);
    eq(paneAt(new Map([[VIEW2, 'new_dxttest']])).list, [['attribute|new_dxttest.new_dxtmulti|DisplayName', 'Couleurs', true]]);
    eq(paneAt(new Map()).list, [], 'its view not read yet');
  });

  test("classic read-only grid (an associated view such as Connections, a sub-grid): a header's column by its header button, mapped like a Power Apps grid's, only where it shows that column's name in the user's language; never the selection column", async () => {
    const { selectorView } = await import('../../../src/inspector/scan');
    const G = 'Grid3e4f5a6b-0000-4000-8000-000000000001';
    /**
     * A Wijmo header cell as UCI renders it (live 2026-10-17): the cell shown, `div.wj-cell.wj-header#<grid>-<column>` with the
     * column in its data-id, holding `div#<grid>_headerButton<column>` and the text; no col-id, no role.
     */
    const head = (c: string, text: string, i: number, id = c) =>
      new El('div', { class: 'wj-cell wj-header', id: `${G}-${id}`, 'data-id': c, title: text }).add(
        new El('div', { id: `${G}_headerButton${c}` }).add(new El('div', { class: 'ms-Stack' }).add(new El('div', { class: 'ms-StackItem headerText' }, text))),
      );
    const select = () => new El('div', { class: 'wj-cell wj-header', id: `${G}-btnheaderselectcolumn`, 'data-id': 'btnheaderselectcolumn', title: 'Selection status' });
    /** The invisible screen-reader copy of a header (role columnheader, opacity 0): names no column, never a label. */
    const twin = (text: string, i: number) => new El('div', { role: 'columnheader', class: 'wj-cell', 'aria-colindex': String(i) }).add(new El('button', {}, text));
    const classic = (lp: string, ...heads: El[]) =>
      new El('div', { 'data-lp-id': lp }).add(
        new El('div', { class: 'wj-cells' }).add(new El('div', { class: 'wj-row' }).add(twin('Sélectionner toutes les lignes', 1), twin('Nom lié', 2))),
        new El('div', { class: 'wj-colheaders' }).add(new El('div', { class: 'wj-row' }).add(...heads)),
      );
    const LP = `MscrmControls.Grid.GridControl|entity_control|new_dxttest|${VIEW3}|new_dxtlinked|${REL}`;
    const slots = [...pageForm, col('new_dxttest.new_name', 'Name', 'Nom'), ...tables, ...linked, col('new_dxtlinked.new_code', 'Code', '')];
    const at = (g: El, s = slots, views = known(), q = new Map<string, ReturnType<typeof queryLinks>>()) => scan(new El('body').add(g), s, q, '', undefined, views);
    const grid = () => classic(LP, select(), head('new_name', 'Nom lié', 2), head('new_linkedkind', 'Type lié', 3), head('new_code', 'Code', 4));
    // Its own table (part 4), once its view reads it; a column without a French name shows its base one.
    eq(at(grid()).list, [
      ['attribute|new_dxtlinked.new_name|DisplayName', 'Nom lié', false],
      ['attribute|new_dxtlinked.new_linkedkind|DisplayName', 'Type lié', false],
      ['attribute|new_dxtlinked.new_code|DisplayName', 'Code', false],
    ]);
    const a = at(grid()).anchors[0];
    eq([a.role, (a.zone as unknown as El).attrs['data-id']], ['header', 'new_name']);
    // Its view's query not read yet: nothing, the query is asked for; a view of another table, another page table: nothing.
    const early = at(grid(), slots, new Map());
    eq(early.list, []);
    ok(early.want.includes(WANT_VIEW + VIEW3), JSON.stringify(early.want));
    eq(at(grid(), slots, new Map([[VIEW3, 'new_dxttest']])).list, [], 'the view reads another table');
    eq(at(classic(`MscrmControls.Grid.GridControl|entity_control|account|${VIEW3}|new_dxtlinked|${REL}`, head('new_name', 'Nom lié', 2))).list, [], "another page table's grid");
    // Its text must be the column's name in the user's language: another language's, or another text, is not that column.
    eq(at(classic(LP, head('new_name', 'Linked name', 2), head('new_linkedkind', 'Genre', 3))).list, []);
    // The cell's id and its button name other columns, or the header has two buttons: which column is unknown.
    eq(at(classic(LP, head('new_name', 'Nom lié', 2, 'new_linkedkind'))).list, []);
    const two = head('new_name', 'Nom lié', 2);
    two.add(new El('div', { id: `${G}_headerButtonnew_linkedkind` }));
    eq(at(classic(LP, two)).list, []);
    // A linked table's column (`<alias>.<column>`): its name and the lookup's, each a part, through the view's query.
    const q = new Map([[VIEW3, queryLinks(`<fetch><entity name="new_dxtlinked"><link-entity alias="a_t" name="new_dxttest" to="new_testid" from="new_dxttestid"><attribute name="new_dxtmulti"/></link-entity></entity></fetch>`)]]);
    const testLookup = S('attribute', 'attribute|new_dxtlinked.new_testid|DisplayName', 'Test', 'Test', { entity: 'new_dxtlinked', attribute: 'new_testid' }, 'new_dxtlinked', 'DisplayName');
    eq(at(classic(LP, head('a_t.new_dxtmulti', 'Couleurs (Test)', 2)), [...slots, testLookup], known(), q).list, [
      ['attribute|new_dxttest.new_dxtmulti|DisplayName', 'Couleurs@0', false],
      ['attribute|new_dxtlinked.new_testid|DisplayName', 'Test@10', false],
    ]);
    eq(at(classic(LP, head('a_t.new_dxtmulti', 'Colors (Test)', 2)), [...slots, testLookup], known(), q).list, [['attribute|new_dxtlinked.new_testid|DisplayName', 'Test@8', false]], "its name in another language: the lookup's part only");
    // The related table not loaded: asked for.
    const cold = at(grid(), [...pageForm, ...tables]);
    eq(cold.list, []);
    ok(cold.want.includes(WANT_TABLE + 'new_dxtlinked'), JSON.stringify(cold.want));
    // In a sub-grid of the page form: the table the form API says the control shows.
    eq(scan(new El('body').add(new El('div', { 'data-control-name': 'children' }).add(classic(`MscrmControls.Grid.GridControl|children|new_dxttest|${VIEW}|new_dxttest`, head('new_dxtmulti', 'Couleurs', 2)))), [...pageForm, ...tables]).list, [
      ['attribute|new_dxttest.new_dxtmulti|DisplayName', 'Couleurs', false],
    ]);
    // A Wijmo header outside any grid the page names: nothing. The view selector above the grid finds the grid's view.
    eq(scan(new El('body').add(head('new_name', 'Nom', 2)), slots).list, []);
    const sel = new El('div', { 'data-id': 'viewSelector' }).add(new El('span', {}, 'Connexions'));
    new El('div').add(sel, classic(LP));
    eq(selectorView(sel as unknown as Element), VIEW3);
  });

  test('view selector of an associated grid or a sub-grid: the view its ids and its grid name, loaded on demand; never another text or a personal view', () => {
    const view = (id: string, en: string, fr: string) =>
      S('view', `view|${id}|Name`, en, fr, { id, table: 'savedquery', entitySet: 'savedqueries', column: 'name', entity: 'new_dxtlinked', type: 2 }, 'new_dxtlinked', 'Name');
    const NAME = view(VIEW3, 'Linked Associated View', 'Vue des éléments liés');
    const NAME2 = view(VIEW2, 'Other view', 'Autre vue');
    // As UCI renders it (LIVE-FINDINGS 88): a button with the view's id, its text in a span whose id has it too.
    const sel = (id: string, text: string) =>
      new El('div', { role: 'button', id: `ViewSelector_${id}` }).add(new El('span', { id: `ViewSelector_0_${id}_8c8f1f0e-0000-0000-0000-000000000001_text` }, text));
    const page = (...kids: El[]) => new El('body').add(new El('div').add(...kids));
    const at = (body: El, slots = [...pageForm, NAME, NAME2]) => scan(body, slots, undefined, '', undefined, known());
    eq(at(page(sel(VIEW3, 'Vue des éléments liés'), assoc([], []))).list, [[NAME.key, 'Vue des éléments liés', false]]);
    // Its name not loaded yet: asked for.
    const r = at(page(sel(VIEW3, 'Vue des éléments liés'), assoc([], [])), pageForm);
    eq(r.list, []);
    ok(r.want.includes(WANT_VIEW_NAME + VIEW3), JSON.stringify(r.want));
    eq(at(page(sel(VIEW3, 'Mes éléments'), assoc([], []))).list, [], 'another text (a personal view of the same id never has a slot)');
    eq(at(page(sel(VIEW2, 'Autre vue'), assoc([], []))).list, [], 'its ids and its grid disagree');
    eq(at(new El('body').add(sel(VIEW3, 'Vue des éléments liés'))).list, [[NAME.key, 'Vue des éléments liés', false]], 'no grid: its own ids');
    // Without ids: the view of the grid it heads, only while that is one grid.
    const plain = () => new El('div', { 'data-id': 'viewSelector' }).add(new El('span', {}, 'Vue des éléments liés'));
    eq(at(page(plain(), assoc([], []))).list, [[NAME.key, 'Vue des éléments liés', false]]);
    eq(at(page(plain(), assoc([], []), assoc([], []))).list, [], 'two grids: which one it heads is unknown');
    // The list of views: each item by its own id only, never the grid's view (nor the list's own id).
    const menu = new El('div', { role: 'menu', id: `ViewSelector_${VIEW3}_list` }).add(
      new El('div', { role: 'menuitem', id: `ViewSelector_1_${VIEW2}_x` }, 'Autre vue'),
      new El('div', { role: 'menuitem', id: 'ViewSelector_item' }, 'Vue des éléments liés'),
    );
    eq(at(page(menu, assoc([], []))).list, [[NAME2.key, 'Autre vue', false]]);
    eq(at(new El('body').add(new El('div', { 'data-id': 'quickCreateRoot' }).add(sel(VIEW3, 'Vue des éléments liés'), assoc([], [])))).list, [], 'quick create');
  });

  test('the tab of an associated view (tablist-<nav id>) maps like its related menu item; a click only opens its popup, Open finds its nav id', async () => {
    const { clickLabel } = await import('../../../src/inspector/mode');
    const { navIdOf } = await import('../../../src/inspector/describe');
    const ID = `nav_${REL}`;
    // As UCI renders it (LIVE-FINDINGS 88): the related item's text, twice (a hidden sizing copy).
    const li = (id: string, text: string) =>
      new El('li', { role: 'tab', id: `tablist-${id}`, 'data-id': `tablist-${id}`, title: text }).add(new El('div', {}, text), new El('div', { 'aria-hidden': 'true' }, text));
    const rel = S('relationship', `relationship|${REL}|Label`, 'Linked records', 'Éléments liés', { schemaName: REL, type: 'OneToMany', referenced: 'new_dxttest', referencing: 'new_dxtlinked', menu: 'label' }, 'new_dxttest');
    const bar = (...tabs: El[]) => pageDom().add(new El('ul').add(...tabs));
    const pick = (r: { list: Array<[string, string, boolean]> }, key: string) => r.list.filter((z) => z[0] === key);
    const r = scan(bar(li(ID, 'Éléments liés')), [...pageForm, rel]);
    eq(pick(r, rel.key), [[rel.key, 'Éléments liés', false]]);
    const a = r.anchors.find((z) => z.key === rel.key)!;
    eq([a.kind, a.role, navIdOf(a.el)], ['relationship', 'nav', ID]);
    const log: string[] = [];
    clickLabel(a, null, { move: () => void log.push('move'), open: (b) => void log.push(`open ${b.key}`) });
    eq(log, [`open ${rel.key}`]);
    // The form XML lists the item: its entry, as in the related menu.
    const item = S('navitem', `navitem|${PAGE}|${ID}|Label`, 'Linked records', 'Éléments liés', { formId: PAGE, elId: ID, area: 'nav', relationship: REL }, 'new_dxttest');
    eq(pick(scan(bar(li(ID, 'Éléments liés')), [...pageForm, item, rel]), item.key), [[item.key, 'Éléments liés', false]]);
    // A built-in item's view: Microsoft's text.
    eq(pick(scan(bar(li('navConnections', 'Connexions')), pageForm), 'builtin|nav|navConnections|Label'), [['builtin|nav|navConnections|Label', 'Connexions', false]]);
    // The table's relationships not loaded yet: asked for.
    const cold = scan(bar(li(ID, 'Éléments liés')), pageForm);
    eq(cold.list.filter((z) => z[0].startsWith('relationship|') || z[0].startsWith('builtin|')), []);
    ok(cold.want.includes(WANT_RELATED + 'new_dxttest'), JSON.stringify(cold.want));
    eq(pick(scan(bar(li(ID, 'Autre chose')), [...pageForm, rel]), rel.key), [], 'another text');
    eq(scan(bar(li(ID, 'Éléments liés')), [rel]).list, [], "the form's tabs not loaded: it may be a tab of the form");
    // A form tab of that name is the form's own.
    const own = S('tab', `tab|${PAGE}|tn|Label`, 'Linked', 'Éléments liés', { formId: PAGE, tabName: ID }, 'new_dxttest');
    const t = scan(bar(li(ID, 'Éléments liés')), [...pageForm, own, rel]);
    eq([pick(t, own.key), pick(t, rel.key), t.anchors.find((z) => z.key === own.key)?.role], [[[own.key, 'Éléments liés', false]], [], 'tab']);
    // In "More tabs": the same item.
    const more = new El('div', { role: 'menu' }).add(new El('div', { role: 'menuitem', 'data-id': `tablist-${ID}` }).add(new El('span', {}, 'Éléments liés')));
    eq(pick(scan(pageDom().add(more), [...pageForm, rel]), rel.key), [[rel.key, 'Éléments liés', false]]);
    // In a side pane: never (its form's related menu isn't loaded).
    const inPane = pageDom().add(pane(new El('ul').add(tab('general', 'Général'), li(ID, 'Éléments liés')), panel('general', section('s1', 'Détails', field(PANE, 'new_name', 'Nom lié')))));
    eq(pick(scan(inPane, [...pageForm, ...paneForm, rel]), rel.key), []);
  });

  test("command bar: a button Dynamics adds without a ribbon id (Show Chart) is built-in text; never a flyout's item, a button outside a command bar, or one without text", () => {
    const bar = (...kids: El[]) => new El('ul', { role: 'menubar', 'data-lp-id': 'commandbar-SubGridAssociated:new_dxtlinked' }).add(...kids.map((k) => new El('li').add(k)));
    const chart = () => new El('button', { role: 'menuitem', id: 'ShowChartPane', 'aria-label': 'Afficher graphique' }).add(new El('span', {}, 'Afficher graphique'));
    const named = [...pageForm, ...names('new_dxtlinked', 'Linked record', 'Linked records')];
    const r = scan(new El('body').add(bar(chart())), named);
    eq(r.list, [['builtin|command|ShowChartPane|Label', 'Afficher graphique', false]]);
    eq([r.anchors[0].kind, r.anchors[0].role], ['ribbon', 'command']);
    // No text of its is built from a table's names: grey at once, whether its bar's table's names are known or not, and
    // nothing is asked for them. A table named after one of its words ("Chart") changes nothing.
    const cold = scan(new El('body').add(bar(chart())), pageForm);
    eq(cold.list, r.list);
    ok(!cold.want.some((w) => w.startsWith(WANT_NAMES)), JSON.stringify(cold.want));
    eq(scan(new El('body').add(bar(chart())), [...pageForm, ...names('new_dxtlinked', 'Chart', 'Charts', 'Graphique', 'Graphiques')]).list, r.list, 'a table named Chart');
    eq(scan(new El('body').add(chart()), named).list, [], 'outside a command bar');
    eq(scan(new El('body').add(bar(new El('div', { role: 'menu' }).add(chart()))), named).list, [], "a flyout's item");
    eq(scan(new El('body').add(bar(new El('button', { role: 'menuitem', id: 'OverflowButton' }))), named).list, [], 'no text');
    eq(scan(new El('body').add(new El('div', { 'data-id': 'quickCreateRoot' }).add(bar(chart()))), named).list, [], 'quick create');
    // With a ribbon id: built-in once the table's customized buttons are known not to define it (or give it a $Resources
    // label); a literal label or a dotted id nobody defines stays unmarked, and so does a flyout's item.
    const btn = (ctl: string, text: string) => new El('button', { role: 'menuitem', 'data-id': `new_dxtlinked|OneToMany|SubGridAssociated|${ctl}` }).add(new El('span', {}, text));
    const ribbon = new Map([
      [
        'new_dxtlinked',
        new Map<string, RibbonControl>([
          ['new.Res', { id: 'new.Res', labelText: '$Resources:Ribbon.Refresh' }],
          ['new.Lit', { id: 'new.Lit', labelText: 'Literal' }],
        ]),
      ],
    ]);
    const body = () =>
      new El('body').add(
        bar(btn('ShowChartPane', 'Afficher graphique'), btn('new.Res', 'Actualiser'), btn('new.Lit', 'Literal'), btn('new.Unknown.Button', 'Autre'), new El('div', { role: 'menu' }).add(btn('ReportName', 'Mon rapport'))),
      );
    eq(scan(body(), named, undefined, '', ribbon).list.map((z) => z[0]), ['builtin|command|ShowChartPane|Label', 'builtin|command|new.Res|Label']);
    // Before the table's customized buttons are known: nothing (one may have a label of its own), and they are asked for.
    const early = scan(body(), named);
    eq(early.list, []);
    ok(early.want.includes('new_dxtlinked|ShowChartPane'), JSON.stringify(early.want));
  });

  test("command bar: a built-in command whose text holds its own table's name (New Person, Export People) marks that name, the table's slot; any other stays grey; never another table's", () => {
    const LINKED = names('new_dxtlinked', 'Linked record', 'Linked records', 'Élément lié', 'Éléments liés');
    const TEST = names('new_dxttest', 'Test', 'Tests');
    const bar = (lp: string, ...kids: El[]) => new El('ul', { role: 'menubar', 'data-lp-id': lp }).add(...kids.map((k) => new El('li').add(k)));
    const sub = (...kids: El[]) => bar('commandbar-SubGridAssociated:new_dxtlinked', ...kids);
    const btn = (ctl: string, text: string, table = 'new_dxtlinked') =>
      new El('button', { role: 'menuitem', 'data-id': `${table}|OneToMany|SubGridAssociated|${ctl}`, id: ctl }).add(new El('span', {}, text));
    const ribbon = new Map(['new_dxtlinked', 'new_dxttest'].map((t) => [t, new Map<string, RibbonControl>()]));
    const at = (body: El, slots = [...pageForm, ...LINKED, ...TEST], gaveUp = new Set<string>()) => scan(body, slots, undefined, '', ribbon, undefined, gaveUp);
    const page = () =>
      new El('body').add(
        sub(
          btn('Mscrm.SubGrid.new_dxtlinked.AddNewStandard', 'Nouveau Élément lié'),
          btn('Mscrm.SubGrid.new_dxtlinked.AddExistingStandard', 'Ajouter Élément lié existant'),
          btn('Mscrm.SubGrid.new_dxtlinked.ExportToExcel', 'Exporter éléments liés'),
          btn('Mscrm.SubGrid.new_dxtlinked.Refresh', 'Actualiser'),
        ),
      );
    const r = at(page());
    // The longest name the text holds, in any case, as a part of the text (the rest is the language pack's).
    eq(r.list, [
      ['entity|new_dxtlinked|DisplayName', 'Élément lié@8', false],
      ['entity|new_dxtlinked|DisplayName', 'Élément lié@8', false],
      ['entity|new_dxtlinked|DisplayCollectionName', 'éléments liés@9', false],
      ['builtin|command|Mscrm.SubGrid.new_dxtlinked.Refresh|Label', 'Actualiser', false],
    ]);
    const a = r.anchors[2];
    const id = (e: Element | undefined) => (e as unknown as El | undefined)?.id;
    eq([a.comp, a.role, a.focus, id(a.zone), id(a.hit)], ['entity|new_dxtlinked', 'command', 'entity|new_dxtlinked|DisplayCollectionName', 'Mscrm.SubGrid.new_dxtlinked.ExportToExcel', 'Mscrm.SubGrid.new_dxtlinked.ExportToExcel']);
    // Its names not known yet: nothing (never a passing grey mark), they are asked for; grey once their read failed. A
    // command whose text is never built from them (Refresh) is grey at once.
    const cold = at(page(), [...pageForm, ...TEST]);
    eq(cold.list, [['builtin|command|Mscrm.SubGrid.new_dxtlinked.Refresh|Label', 'Actualiser', false]]);
    ok(cold.want.includes(WANT_NAMES + 'new_dxtlinked'), JSON.stringify(cold.want));
    eq(at(page(), [...pageForm, ...TEST], new Set([WANT_NAMES + 'new_dxtlinked'])).list.map((z) => z[0]), [
      'builtin|command|Mscrm.SubGrid.new_dxtlinked.AddNewStandard|Label',
      'builtin|command|Mscrm.SubGrid.new_dxtlinked.AddExistingStandard|Label',
      'builtin|command|Mscrm.SubGrid.new_dxtlinked.ExportToExcel|Label',
      'builtin|command|Mscrm.SubGrid.new_dxtlinked.Refresh|Label',
    ]);
    // The name as shown in the user's language only: the base one where it has none, never a stale other language's.
    const enOnly = names('new_dxtlinked', 'Linked record', 'Linked records', '', '');
    eq(at(new El('body').add(sub(btn('Mscrm.SubGrid.new_dxtlinked.AddNewStandard', 'Nouveau Linked record'))), [...pageForm, ...enOnly]).list, [['entity|new_dxtlinked|DisplayName', 'Linked record@8', false]]);
    eq(at(new El('body').add(sub(btn('Mscrm.SubGrid.new_dxtlinked.AddNewStandard', 'New Linked record')))).list.map((z) => z[0]), ['builtin|command|Mscrm.SubGrid.new_dxtlinked.AddNewStandard|Label']);
    // Whole words only: "Tests" in "Contests" is no name.
    const tests = (...kids: El[]) => new El('body').add(bar('commandbar-SubGridStandard:new_dxttest', ...kids));
    const tbtn = (ctl: string, text: string) => btn(`Mscrm.SubGrid.new_dxttest.${ctl}`, text, 'new_dxttest');
    eq(at(tests(tbtn('AddNewStandard', 'Nouveau Test'), tbtn('ExportToExcel', 'Exporter Contests'))).list, [
      ['entity|new_dxttest|DisplayName', 'Test@8', false],
      ['builtin|command|Mscrm.SubGrid.new_dxttest.ExportToExcel|Label', 'Exporter Contests', false],
    ]);
    // Any other command's text is the language pack's alone, also where a word of it is its table's name ("Resolve Case",
    // a form's or a list's New): grey at once, nothing asked for.
    const form = (...kids: El[]) => new El('body').add(bar('commandbar-Form:new_dxttest', ...kids));
    const fbtn = (ctl: string, text: string) => new El('button', { role: 'menuitem', 'data-id': `new_dxttest|NoRelationship|Form|${ctl}` }).add(new El('span', {}, text));
    const fixed = [fbtn('Mscrm.Form.new_dxttest.Resolve', 'Résoudre le test'), fbtn('Mscrm.Form.new_dxttest.NewRecord', 'Nouveau Test'), fbtn('Mscrm.HomepageGrid.new_dxttest.RunReport', 'Exécuter Test')];
    const grey = ['builtin|command|Mscrm.Form.new_dxttest.Resolve|Label', 'builtin|command|Mscrm.Form.new_dxttest.NewRecord|Label', 'builtin|command|Mscrm.HomepageGrid.new_dxttest.RunReport|Label'];
    eq(at(form(...fixed)).list.map((z) => z[0]), grey);
    const unnamed = at(form(...fixed), pageForm);
    eq([unnamed.list.map((z) => z[0]), unnamed.want.filter((w) => w.startsWith(WANT_NAMES))], [grey, []], 'names not loaded');
    // Another table's command, or a command whose id, data-id and bar don't agree on its table: grey, never that table's.
    eq(at(new El('body').add(sub(btn('Mscrm.SubGrid.new_dxttest.AddNewStandard', 'Nouveau Test', 'new_dxttest')))).list.map((z) => z[0]), ['builtin|command|Mscrm.SubGrid.new_dxttest.AddNewStandard|Label']);
    eq(at(new El('body').add(sub(btn('Mscrm.SubGrid.new_dxttest.AddNewStandard', 'Nouveau Élément lié')))).list.map((z) => z[0]), ['builtin|command|Mscrm.SubGrid.new_dxttest.AddNewStandard|Label']);
    // A button Dynamics adds without a ribbon id: the language pack's text, whatever its bar's table.
    const plain = (text: string) => new El('button', { role: 'menuitem', id: 'NewRecordFromGrid' }).add(new El('span', {}, text));
    eq(at(new El('body').add(sub(plain('Nouveau Élément lié')))).list, [['builtin|command|NewRecordFromGrid|Label', 'Nouveau Élément lié', false]]);
    // A label a customization of the table gives says: built around the name it names (`$Resources(EntityDisplayName):`,
    // `$Resources(EntityPluralDisplayName):`), else the language pack's text alone (`$Resources:`), whatever the command.
    const labels = new Map([
      [
        'new_dxtlinked',
        new Map<string, RibbonControl>(
          [
            ['new.Plural', '$Resources(EntityPluralDisplayName):Ribbon.Custom.Export'],
            ['new.Single', '$Resources(EntityDisplayName):Ribbon.Custom.Show'],
            ['Mscrm.SubGrid.new_dxtlinked.AddNewStandard', '$Resources:Ribbon.Custom.New'],
          ].map(([k, l]) => [k, { id: k, labelText: l }]),
        ),
      ],
    ]);
    const custom = scan(
      new El('body').add(sub(btn('new.Plural', 'Exporter éléments liés'), btn('new.Single', 'Voir les éléments liés'), btn('Mscrm.SubGrid.new_dxtlinked.AddNewStandard', 'Nouveau Élément lié'))),
      [...pageForm, ...LINKED],
      undefined,
      '',
      labels,
    );
    eq(custom.list, [
      ['entity|new_dxtlinked|DisplayCollectionName', 'éléments liés@9', false],
      ['builtin|command|new.Single|Label', 'Voir les éléments liés', false],
      ['builtin|command|Mscrm.SubGrid.new_dxtlinked.AddNewStandard|Label', 'Nouveau Élément lié', false],
    ]);
  });

  test("page loads: the views of view selectors, one read for those asked together, and a grid view's query with the table it reads; each once; a personal view gets nothing", async () => {
    const PERSONAL = 'c0ffee00-0000-0000-0000-000000000001';
    const calls: string[] = [];
    let fail = 0;
    const providers = {
      loadRecords: async (_c: unknown, kind: string, ids: string[]) => {
        calls.push(`${kind} ${ids.join()}`);
        if (fail-- > 0) throw new Error('Too many requests.');
        // A personal view is no savedquery: no row.
        return ids
          .filter((id) => id !== PERSONAL)
          .map((id) => S('view', `view|${id}|Name`, 'Linked Associated View', 'Vue des éléments liés', { id, table: 'savedquery', entitySet: 'savedqueries', column: 'name', entity: 'new_dxtlinked', type: 2 }, 'new_dxtlinked', 'Name'));
      },
      viewQuery: async (_c: unknown, id: string) => (calls.push(`query ${id}`), '<fetch><entity name="New_DxtLinked"><attribute name="new_name"/></entity></fetch>'),
    };
    const mk = (store: Store) =>
      new PageLoader({ ctx: { xrm: {}, user: FR, base: EN, langs: [{ lcid: EN }, { lcid: FR }] }, providers, store, lang: {} } as unknown as ConstructorParameters<typeof PageLoader>[0], () => {});
    const settle = async (ld: PageLoader, n: number) => {
      for (let i = 0; i < 100 && (calls.length < n || ld.busy.size); i++) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 5));
    };
    const store = new Store();
    const ld = mk(store);
    ld.request([WANT_VIEW_NAME + VIEW3, WANT_VIEW_NAME + PERSONAL, WANT_VIEW + VIEW3]);
    ld.request([WANT_VIEW_NAME + VIEW3, WANT_VIEW_NAME + PERSONAL, WANT_VIEW + VIEW3]); // asked once
    await settle(ld, 2);
    eq(calls.slice().sort(), [`query ${VIEW3}`, `view ${VIEW3},${PERSONAL}`]);
    eq([ld.viewTables.get(VIEW3), ld.queries.get(VIEW3)?.size], ['new_dxtlinked', 0], 'the table the view reads; no linked tables');
    eq([!!store.get(`view|${VIEW3}|Name`), !!store.get(`view|${PERSONAL}|Name`), [...ld.errors.values()]], [true, false, []]);
    calls.length = 0;
    ld.request([WANT_VIEW_NAME + `{${VIEW3.toUpperCase()}}`]);
    await settle(ld, 0);
    eq(calls, [], 'in the store already');
    // A failed read says so on the bar; Try again reads it again.
    fail = 1;
    const ld2 = mk(new Store());
    ld2.request([WANT_VIEW_NAME + VIEW3]);
    await settle(ld2, 1);
    eq([calls, [...ld2.errors.values()]], [[`view ${VIEW3}`], ['Could not load the view name. Too many requests.']]);
    calls.length = 0;
    ld2.retry();
    ld2.request([WANT_VIEW_NAME + VIEW3]);
    await settle(ld2, 1);
    eq([calls, [...ld2.errors.values()]], [[`view ${VIEW3}`], []]);
  });
}
