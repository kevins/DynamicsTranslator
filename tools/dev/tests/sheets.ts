// Unit tests for the workbook sheets (workbench/sheets.ts) and the Setup screen's state (workbench/scope.ts).
// Fixture slots copy the shapes the providers produce (docs/ARCHITECTURE.md §3 and providers/*.ts).
import type { Ctx } from '../../../src/core/context';
import { DvError } from '../../../src/core/http';
import { KIND_NAMES, PROP_NAMES, type Kind, type Prop, type Slot } from '../../../src/core/model';
import { Store } from '../../../src/core/store';
import { loadMetadataScope, loadTables } from '../../../src/providers/metadata';
import type { Scope } from '../../../src/providers/types';
import type { AppApi } from '../../../src/ui/types';
import { createSetup, listKey, loadState, saveState, scopeOf, waitsForList } from '../../../src/workbench/scope';
import { fold, inLabelMode, kindsOf, rowsLabel, rowsTest, searchText, SETUP_GROUPS, sheetOf, SHEETS, sortSlots, typeTip } from '../../../src/workbench/sheets';
import type { SheetCtx, SheetDef, WbState } from '../../../src/workbench/types';
import { dom, FEl, fire, install } from './callout';
import type { Kit } from './kit';

const FORM = '0f1e2d3c-4b5a-4968-8776-655443322110';
const SM = '11111111-2222-4333-8444-555555555555';
const WF = '919e14d1-0000-4000-8000-0000000000b2';
const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** A slot as a provider makes it: key = `${comp}|${prop}`. */
function mk(kind: Kind, comp: string, prop: Prop, o: Partial<Slot> = {}): Slot {
  return {
    key: `${comp}|${prop}`,
    kind,
    prop,
    entity: '',
    comp,
    group: comp,
    title: 't',
    path: [],
    sub: '',
    labels: { 1033: 'Name', 1036: 'Nom' },
    readOnly: '',
    baseRequired: true,
    max: 0,
    order: 0,
    ref: {},
    ...o,
  };
}

const ctx = (store: Store): SheetCtx => ({ store, tableName: (e) => (e === 'account' ? 'Account' : e) });
const row = (s: Slot, store = new Store()): Record<string, string> => {
  const d = sheetOf(s);
  const x = ctx(store);
  return Object.fromEntries([['sheet', d.name], ...d.cols.map((c) => [c.name, c.get(s, x)]), ['Type', d.type ? d.type(s) : s.prop]]);
};

// One fixture per kind (relationship: both 1:N and N:N).
const FIX: Slot[] = [
  mk('entity', 'entity|account', 'DisplayName', { entity: 'account', ref: { entity: 'account', metadataId: '70816501-edb9-4740-a16c-6a5efbc05d84' } }),
  mk('attribute', 'attribute|account.name', 'Description', { entity: 'account', ref: { entity: 'account', attribute: 'name', metadataId: ID, odataType: 'Microsoft.Dynamics.CRM.StringAttributeMetadata' } }),
  mk('relationship', 'relationship|account_contacts', 'Label', { entity: 'account', ref: { schemaName: 'account_contacts', metadataId: ID, type: 'OneToMany', referenced: 'account', referencing: 'contact' } }),
  mk('relationship', 'relationship|new_account_account|2', 'Label', {
    entity: 'account',
    group: 'relationship|new_account_account',
    ref: { schemaName: 'new_account_account', metadataId: ID, type: 'ManyToMany', side: 2, entity1: 'account', entity2: 'account', intersect: 'new_account_account' },
  }),
  mk('option', 'option|account.industrycode|1', 'Label', { entity: 'account', ref: { entity: 'account', attribute: 'industrycode', value: 1, attributeMetadataId: ID, optionMetadataId: ID, cast: 'Picklist' } }),
  mk('globaloptionset', 'globaloptionset|new_color', 'DisplayName', { ref: { name: 'new_color', metadataId: 'c0c0c0c0-0000-4000-8000-000000000001', boolean: false, usedBy: ['account.new_color'] } }),
  mk('globaloption', 'globaloption|new_color|100000000', 'Label', { ref: { name: 'new_color', value: 100000000, optionMetadataId: ID, usedBy: ['account.new_color', 'contact.new_color'] } }),
  mk('boolean', 'boolean|account.donotemail|1', 'Label', { entity: 'account', ref: { entity: 'account', attribute: 'donotemail', value: 1, attributeMetadataId: ID, cast: 'Boolean' } }),
  mk('state', 'state|account.statecode|0', 'Label', { entity: 'account', ref: { entity: 'account', attribute: 'statecode', value: 0, attributeMetadataId: ID, cast: 'State' } }),
  mk('status', 'status|account.statuscode|1', 'Label', { entity: 'account', ref: { entity: 'account', attribute: 'statuscode', value: 1, attributeMetadataId: ID, cast: 'Status' } }),
  mk('view', `view|${ID}`, 'Name', { entity: 'account', sub: 'Public view', ref: { id: ID, table: 'savedquery', entitySet: 'savedqueries', column: 'name', entity: 'account', type: 0 } }),
  mk('chart', `chart|${ID}`, 'Name', { entity: 'account', ref: { id: ID, table: 'savedqueryvisualization', column: 'name', entity: 'account' } }),
  mk('form', `form|${FORM}`, 'Name', { entity: 'account', sub: 'Main form', ref: { id: FORM, table: 'systemform', column: 'name', entity: 'account', type: 2 } }),
  mk('tab', `tab|${FORM}|${ID}`, 'Label', { entity: 'account', path: ['Account', 'Account (Main form)'], ref: { formId: FORM, elId: ID, formType: 2, area: 'body', tabName: 'SUMMARY_TAB' } }),
  mk('section', `section|${FORM}|${ID}`, 'Label', {
    entity: 'account',
    path: ['Account', 'Account (Main form)', 'Summary'],
    ref: { formId: FORM, elId: ID, formType: 2, area: 'body', tabName: 'SUMMARY_TAB', sectionName: 'ACCOUNT_INFORMATION' },
  }),
  mk('field', `field|${FORM}|${ID}`, 'Label', {
    entity: 'account',
    path: ['Account', 'Account (Main form)', 'Summary', 'Account Information'],
    ref: { formId: FORM, elId: ID, formType: 2, area: 'body', tabName: 'SUMMARY_TAB', sectionName: 'ACCOUNT_INFORMATION', controlId: 'name', datafield: 'name' },
  }),
  mk('navitem', `navitem|${FORM}|navContacts`, 'Label', { entity: 'account', path: ['Account', 'Account (Main form)', 'Navigation'], ref: { formId: FORM, elId: 'navContacts', formType: 2, area: 'nav' } }),
  mk('dashboard', `dashboard|${ID}`, 'Name', { sub: 'Interactive dashboard', ref: { id: ID, table: 'systemform', column: 'name', entity: '', type: 10 } }),
  mk('dtab', `dtab|${FORM}|${ID}`, 'Label', { path: ['Dashboards', 'Sales (Dashboard)'], ref: { formId: FORM, elId: ID, formType: 0, area: 'body', tabName: 'tab_1' } }),
  mk('dsection', `dsection|${FORM}|${ID}`, 'Label', { path: ['Dashboards', 'Sales (Dashboard)', 'Tab'], ref: { formId: FORM, elId: ID, formType: 0, area: 'body', tabName: 'tab_1', sectionName: 'sec_1' } }),
  mk('dfield', `dfield|${FORM}|${ID}`, 'Label', { path: ['Dashboards', 'Sales (Dashboard)', 'Tab', 'Section'], ref: { formId: FORM, elId: ID, formType: 0, area: 'body', tabName: 'tab_1', sectionName: 'sec_1', controlId: 'Chart1' } }),
  mk('app', `app|${ID}`, 'Name', { sub: 'msdynce_saleshub', ref: { id: ID, table: 'appmodule', column: 'name', entity: '' } }),
  mk('area', `area|${SM}|SFA`, 'Title', { group: `sitemap|${SM}`, path: ['Sales Hub'], sub: 'SFA', ref: { sitemapId: SM, id: 'SFA' } }),
  mk('group', `group|${SM}|Customers`, 'Title', { group: `sitemap|${SM}`, path: ['Sales Hub', 'Sales'], sub: 'Customers', ref: { sitemapId: SM, id: 'Customers', areaId: 'SFA' } }),
  mk('subarea', `subarea|${SM}|nav_accts`, 'Title', { group: `sitemap|${SM}`, path: ['Sales Hub', 'Sales', 'Customers'], ref: { sitemapId: SM, id: 'nav_accts', areaId: 'SFA', groupId: 'Customers', entity: 'account' } }),
  mk('bpf', `bpf|${WF}`, 'Name', { entity: 'lead', sub: 'leadtoopportunitysalesprocess', ref: { id: WF, table: 'workflow', column: 'name', entity: 'lead' } }),
  mk('stage', `stage|${WF}|${ID}`, 'Label', { entity: 'lead', group: `bpfxaml|${WF}`, path: ['Lead to Opportunity'], ref: { workflowId: WF, labelId: ID } }),
  mk('step', `step|${WF}|${FORM}`, 'Label', { entity: 'lead', group: `bpfxaml|${WF}`, path: ['Lead to Opportunity', 'Qualify'], ref: { workflowId: WF, labelId: FORM, attribute: 'firstname', stageId: ID } }),
  mk('ribbon', 'ribbon|_app|Mscrm.HomepageGrid.X.LabelText', 'Label', { group: 'ribbon|_app', ref: { entity: '_app', locLabelId: 'Mscrm.HomepageGrid.X.LabelText', managed: false } }),
  mk('command', `command|${ID}`, 'ToolTipTitle', { entity: 'account', sub: 'Button · Main grid · this app only', ref: { id: ID, table: 'appaction', entity: 'account', type: 1 } }),
  mk('envvar', `envvar|${ID}`, 'Hint', { sub: 'new_ApiUrl', ref: { id: ID, table: 'environmentvariabledefinition' } }),
  mk('customapi', `customapi|${ID}`, 'DisplayName', { entity: 'account', sub: 'new_DoThing', ref: { id: ID, table: 'customapi', entity: 'account' } }),
];

export function register(t: Kit): void {
  t.test('sheets: every kind lands on its own sheet; only an unknown relationship type goes to Other', () => {
    const other = SHEETS[SHEETS.length - 1];
    t.eq(other.name, 'Other');
    t.eq(other.kinds, []);
    const kinds = Object.keys(KIND_NAMES) as Kind[];
    const seen = new Set(FIX.map((s) => s.kind));
    for (const k of kinds) t.ok(seen.has(k), `no fixture for ${k}`);
    for (const s of FIX) t.ok(sheetOf(s) !== other, `${s.kind} fell to Other`);
    for (const k of kinds) t.ok(SHEETS.some((d) => d.kinds.includes(k)), `${k} has no sheet`);
    t.eq(sheetOf(mk('relationship', 'relationship|x', 'Label', { ref: { schemaName: 'x' } })).name, 'Other', 'relationship without a type');
    t.eq(sheetOf(mk('foo' as Kind, 'foo|x', 'Label')).name, 'Other', 'unknown kind');
  });

  t.test('sheets: tab order, names and columns', () => {
    const names = SHEETS.map((d) => d.name);
    t.eq(names.slice(0, 14), ['Entities', 'Attributes', 'Relationships', 'RelationshipsNN', 'Global OptionSets', 'OptionSets', 'Booleans', 'Views', 'Charts', 'Forms', 'Forms Tabs', 'Forms Sections', 'Forms Fields', 'Form Navigation']);
    t.eq(names.slice(14, 21), ['SiteMap Areas', 'SiteMap Groups', 'SiteMap SubAreas', 'Dashboards', 'Dashboards Tabs', 'Dashboards Sections', 'Dashboards Fields']);
    t.eq(names.slice(21), ['Apps', 'Business Process Flows', 'BPF Stages', 'BPF Steps', 'Commands', 'Ribbon Labels', 'Environment Variables', 'Custom APIs', 'Other']);
    t.eq(new Set(SHEETS.map((d) => d.id)).size, SHEETS.length, 'sheet ids are unique');
    for (const d of SHEETS) {
      t.ok(d.cols.some((c) => c.keep), `${d.name} keeps no column in a narrow grid`);
      t.eq(new Set(d.cols.map((c) => c.id)).size, d.cols.length, `${d.name} column ids are unique`);
      t.ok(!!d.help, `${d.name} has no help`);
      for (const c of d.cols) if (c.mono && d.id !== 'other') t.eq(c.w, 120, `${d.name} ${c.name} width`);
    }
    // GUID columns come first, as in the old workbook (SiteMap sheets start with the sitemap's name there).
    for (const d of SHEETS.filter((x) => x.cols.some((c) => c.mono) && !x.id.startsWith('sitemap') && x.id !== 'other')) t.ok(d.cols[0].mono, `${d.name} starts with its id`);
  });

  t.test('sheets: key columns read the provider shapes', () => {
    const by = (k: Kind, i = 0) => FIX.filter((s) => s.kind === k)[i];
    t.eq(row(by('entity')), { sheet: 'Entities', 'Entity Id': '70816501-edb9-4740-a16c-6a5efbc05d84', 'Entity Logical Name': 'account', Type: 'DisplayName' });
    t.eq(row(by('attribute')), { sheet: 'Attributes', 'Attribute Id': ID, 'Entity Logical Name': 'account', 'Attribute Logical Name': 'name', Type: 'Description (tooltip)' });
    t.eq(row({ ...by('attribute'), prop: 'DisplayName' }).Type, 'DisplayName');
    t.eq(row(by('option')), { sheet: 'OptionSets', 'Attribute Id': ID, 'Entity Logical Name': 'account', 'Attribute Logical Name': 'industrycode', 'Attribute Type': 'Picklist', Value: '1', Type: 'Label' });
    t.eq(row({ ...by('option'), ref: { ...by('option').ref, cast: 'MultiSelectPicklist' } })['Attribute Type'], 'MultiSelectPicklist');
    t.eq(row(by('state'))['Attribute Type'], 'State');
    t.eq(row(by('status'))['Attribute Type'], 'Status');
    t.eq(row(by('boolean')), { sheet: 'Booleans', 'Attribute Id': ID, 'Entity Logical Name': 'account', 'Attribute Logical Name': 'donotemail', Value: '1', Type: 'Label' });
    t.eq(row(by('view')), { sheet: 'Views', 'View Id': ID, 'Entity Logical Name': 'account', ViewType: 'Public view (0)', Type: 'Name' });
    t.eq(row(by('chart')), { sheet: 'Charts', 'Chart Id': ID, 'Entity Logical Name': 'account', Type: 'Name' });
    t.eq(row(by('form')), { sheet: 'Forms', 'Form Id': FORM, 'Entity Logical Name': 'account', 'Form Type': 'Main form', Type: 'Name' });
    t.eq(row(by('tab')), { sheet: 'Forms Tabs', 'Form Id': FORM, 'Entity Logical Name': 'account', 'Form Name': 'Account (Main form)', 'Tab Name': 'SUMMARY_TAB', Type: 'Label' });
    t.eq(row(by('section')), {
      sheet: 'Forms Sections',
      'Form Id': FORM,
      'Entity Logical Name': 'account',
      'Form Name': 'Account (Main form)',
      'Tab Name': 'SUMMARY_TAB',
      'Section Name': 'ACCOUNT_INFORMATION',
      Type: 'Label',
    });
    t.eq(row(by('field')), {
      sheet: 'Forms Fields',
      'Form Id': FORM,
      'Entity Logical Name': 'account',
      'Form Name': 'Account (Main form)',
      'Tab Name': 'SUMMARY_TAB',
      'Section Name': 'ACCOUNT_INFORMATION',
      'Field Name': 'name',
      'Control Id': 'name',
      Type: 'Label',
    });
    t.eq(row(by('navitem')), { sheet: 'Form Navigation', 'Form Id': FORM, 'Entity Logical Name': 'account', 'Form Name': 'Account (Main form)', 'Item Id': 'navContacts', Type: 'Label' });
    t.eq(row(by('area')), { sheet: 'SiteMap Areas', 'SiteMap Name': 'Sales Hub', 'SiteMap Id': SM, 'Area Id': 'SFA', Type: 'Title' });
    t.eq(row(by('group')), { sheet: 'SiteMap Groups', 'SiteMap Name': 'Sales Hub', 'SiteMap Id': SM, 'Area Id': 'SFA', 'Group Id': 'Customers', Type: 'Title' });
    t.eq(row(by('subarea')), { sheet: 'SiteMap SubAreas', 'SiteMap Name': 'Sales Hub', 'SiteMap Id': SM, 'Area Id': 'SFA', 'Group Id': 'Customers', 'SubArea Id': 'nav_accts', Type: 'Title' });
    t.eq(row(by('dashboard')), { sheet: 'Dashboards', 'Dashboard Id': ID, 'Dashboard Type': 'Interactive dashboard', Type: 'Name' });
    t.eq(row(by('dtab')), { sheet: 'Dashboards Tabs', 'Dashboard Id': FORM, 'Dashboard Name': 'Sales (Dashboard)', 'Tab Name': 'tab_1', Type: 'Label' });
    t.eq(row(by('dsection'))['Section Name'], 'sec_1');
    t.eq(row(by('dfield')), { sheet: 'Dashboards Fields', 'Dashboard Id': FORM, 'Dashboard Name': 'Sales (Dashboard)', 'Tab Name': 'tab_1', 'Section Name': 'sec_1', Component: 'Chart1', Type: 'Label' });
    t.eq(row(by('app')), { sheet: 'Apps', 'App Id': ID, 'Unique Name': 'msdynce_saleshub', Type: 'Name' });
    t.eq(row(by('bpf')), { sheet: 'Business Process Flows', 'Process Id': WF, 'Entity Logical Name': 'lead', 'Unique Name': 'leadtoopportunitysalesprocess', Type: 'Name' });
    t.eq(row(by('stage')), { sheet: 'BPF Stages', 'Process Id': WF, 'Process Name': 'Lead to Opportunity', 'Entity Logical Name': 'lead', 'Stage Id': ID, Type: 'Label' });
    t.eq(row(by('step')), { sheet: 'BPF Steps', 'Process Id': WF, 'Process Name': 'Lead to Opportunity', 'Stage Name': 'Qualify', 'Step Id': FORM, Attribute: 'firstname', Type: 'Label' });
    t.eq(row(by('command')), { sheet: 'Commands', 'Command Id': ID, 'Entity Logical Name': 'account', Location: 'Button · Main grid · this app only', Type: 'ToolTipTitle' });
    t.eq(row(by('ribbon')), { sheet: 'Ribbon Labels', 'Entity Logical Name': '(application ribbon)', 'LocLabel Id': 'Mscrm.HomepageGrid.X.LabelText', Type: 'Label' });
    t.eq(row({ ...by('ribbon'), entity: 'account', ref: { entity: 'account', locLabelId: 'L' } })['Entity Logical Name'], 'account');
    t.eq(row(by('envvar')), { sheet: 'Environment Variables', 'Variable Id': ID, 'Schema Name': 'new_ApiUrl', Type: 'Hint' });
    t.eq(row(by('customapi')), { sheet: 'Custom APIs', 'Custom API Id': ID, 'Unique Name': 'new_DoThing', 'Bound Entity': 'account', Type: 'DisplayName' });
    const o = mk('foo' as Kind, 'foo|1', 'Label', { path: ['A', 'B'], title: 'C' });
    t.eq(row(o), { sheet: 'Other', Key: 'foo|1|Label', Kind: 'foo', Component: 'A › B › C', Type: 'Label' });
    // GUIDs show without braces, lower case.
    t.eq(row({ ...by('view'), ref: { ...by('view').ref, id: '{AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE}' } })['View Id'], ID);
  });

  t.test('sheets: header and footer fields name their area; tab footer fields their zone', () => {
    const f = FIX.find((s) => s.kind === 'field')!;
    const head = { ...f, path: ['Account', 'Account (Main form)', 'Header'], ref: { formId: FORM, elId: 'h1', area: 'header', controlId: 'header_name', datafield: 'name' } };
    t.eq([row(head)['Tab Name'], row(head)['Section Name'], row(head)['Field Name']], ['Header', '', 'name']);
    const foot = { ...f, path: ['Account', 'Account (Main form)', 'Summary', 'Tab footer'], ref: { formId: FORM, elId: 'f1', area: 'body', tabName: 'SUMMARY_TAB', controlId: 'notes' } };
    t.eq([row(foot)['Tab Name'], row(foot)['Section Name'], row(foot)['Field Name']], ['SUMMARY_TAB', 'Tab footer', 'notes']);
    t.ok(/hidden on the form/.test(typeTip({ ...f, sub: 'name · label hidden' })), 'hidden label tip');
    t.ok(/tooltip/.test(typeTip(FIX.find((s) => s.kind === 'attribute')!)), 'attribute description tip');
  });

  t.test('sheets: N:N rows name their side; 1:N rows use AssociatedMenuLabel', () => {
    const nn = FIX.find((s) => s.ref.type === 'ManyToMany')!;
    const one = { ...nn, comp: 'relationship|new_account_account|1', key: 'relationship|new_account_account|1|Label', ref: { ...nn.ref, side: 1 } };
    t.eq(row(nn), { sheet: 'RelationshipsNN', 'Relationship Id': ID, 'Entity Logical Name': 'account', 'Schema Name': 'new_account_account', 'Intersect Entity': 'new_account_account', Type: 'Entity2AssociatedMenuLabel' });
    t.eq(row(one).Type, 'Entity1AssociatedMenuLabel');
    t.eq(row(FIX.find((s) => s.ref.type === 'OneToMany')!), { sheet: 'Relationships', 'Relationship Id': ID, 'Entity Logical Name': 'account', 'Schema Name': 'account_contacts', Type: 'AssociatedMenuLabel' });
  });

  t.test('sheets: Global OptionSets rows: set id on value rows, blank value on the set, Used By', () => {
    const store = new Store();
    const set = FIX.find((s) => s.kind === 'globaloptionset')!;
    const op = FIX.find((s) => s.kind === 'globaloption')!;
    store.add([set, op]);
    t.eq(row(set, store), { sheet: 'Global OptionSets', 'OptionSet Id': 'c0c0c0c0-0000-4000-8000-000000000001', 'OptionSet Name': 'new_color', Value: '', 'Used By': 'account.new_color', Type: 'DisplayName' });
    t.eq(row(op, store), {
      sheet: 'Global OptionSets',
      'OptionSet Id': 'c0c0c0c0-0000-4000-8000-000000000001',
      'OptionSet Name': 'new_color',
      Value: '100000000',
      'Used By': 'account.new_color, contact.new_color',
      Type: 'Label',
    });
    // The set itself was not loaded (only its values, through a column): no id, nothing invented.
    t.eq(row(op, new Store())['OptionSet Id'], '');
  });

  t.test('sheets: two copies of one field are two rows with different Control Ids', () => {
    const f = FIX.find((s) => s.kind === 'field')!;
    const copy = (cell: string, order: number, controlId: string, area = 'body') =>
      ({ ...f, comp: `field|${FORM}|${cell}`, key: `field|${FORM}|${cell}|Label`, order, ref: { ...f.ref, elId: cell, controlId, area } }) as Slot;
    // The same control id in both cells (LIVE-FINDINGS 41): Dynamics names them name, name1 in form order.
    const store = new Store();
    const a = copy('c1', 3, 'name');
    const b = copy('c2', 9, 'name');
    const other = { ...copy('c3', 1, 'name'), ref: { ...f.ref, formId: 'another-form', elId: 'c3', controlId: 'name' } } as Slot;
    store.add([b, a, other]);
    const x = ctx(store);
    const ctl = sheetOf(a).cols.find((c) => c.name === 'Control Id')!;
    t.eq([ctl.get(a, x), ctl.get(b, x), ctl.get(other, x)], ['name', 'name1', 'name']);
    t.eq(new Set(sortSlots([b, a]).map((s) => s.key)).size, 2, 'two rows');
    t.ok(searchText(b, sheetOf(b), x, store).includes('name1'), 'the copy name is searchable');
    // Copies the designer gave their own ids keep them.
    const s2 = new Store();
    const c = copy('c1', 3, 'name');
    const d = copy('c2', 9, 'name1', 'header');
    s2.add([c, d]);
    t.eq([ctl.get(c, ctx(s2)), ctl.get(d, ctx(s2))], ['name', 'name1']);
    // A new load re-indexes; the copy of `name` skips `name1`, which is another cell's own control id.
    s2.add([copy('c4', 1, 'name')]);
    t.eq([ctl.get(s2.get(`field|${FORM}|c4|Label`)!, ctx(s2)), ctl.get(c, ctx(s2)), ctl.get(d, ctx(s2))], ['name', 'name2', 'name1']);
  });

  t.test('sheets: Control Ids never repeat another control of the form (Contoso Service request, duplicated fields)', () => {
    const f = FIX.find((s) => s.kind === 'field')!;
    // Form order: contoso_client, contoso_client1 and contoso_client2 have their own ids; then copies sharing them.
    const cells: Array<[string, string]> = [
      ['c1', 'contoso_client'],
      ['c2', 'contoso_client1'],
      ['c3', 'contoso_client2'],
      ['c4', 'contoso_client'],
      ['c5', 'contoso_client2'],
      ['c6', 'Contoso_Client'],
      ['c7', 'contoso_client2'],
      ['c8', 'Subgrid_notes'],
    ];
    const slots = cells.map(([cell, id], i) => ({ ...f, comp: `field|${FORM}|${cell}`, key: `field|${FORM}|${cell}|Label`, order: i, ref: { ...f.ref, elId: cell, controlId: id, datafield: id.startsWith('Sub') ? undefined : 'contoso_client' } }) as Slot);
    const store = new Store();
    store.add([...slots].reverse());
    const x = ctx(store);
    const ctl = sheetOf(slots[0]).cols.find((c) => c.name === 'Control Id')!;
    const got = slots.map((s) => ctl.get(s, x));
    t.eq(got, ['contoso_client', 'contoso_client1', 'contoso_client2', 'contoso_client3', 'contoso_client21', 'Contoso_Client4', 'contoso_client22', 'Subgrid_notes']);
    t.eq(new Set(got.map((g) => g.toLowerCase())).size, got.length, 'every row has its own Control Id');
    // A sub-grid cell has no column: Field Name falls back to its control id.
    t.eq(row(slots[7], store)['Field Name'], 'Subgrid_notes');
    // A slot that is not in the store (yet) shows its control id as it is.
    t.eq(ctl.get({ ...slots[3], key: 'field|x|y|Label' }, x), 'contoso_client');
  });

  t.test('sheets: sort by table, container, order, component, then property', () => {
    const e = (entity: string, comp: string, prop: Prop, order = 0, kind: Kind = 'attribute') => mk(kind, comp, prop, { entity, order });
    const slots = [
      e('contact', 'attribute|contact.a', 'DisplayName'),
      e('account', 'attribute|account.b', 'Description', 1),
      e('account', 'attribute|account.b', 'DisplayName', 1),
      e('account', 'attribute|account.a', 'Description', 0),
      e('account', 'attribute|account.a', 'DisplayName', 0),
      e('account', 'entity|account', 'Description', 0, 'entity'),
      e('account', 'entity|account', 'DisplayCollectionName', 0, 'entity'),
      e('account', 'entity|account', 'DisplayName', 0, 'entity'),
    ];
    t.eq(
      sortSlots(slots).map((s) => s.key),
      [
        'attribute|account.a|DisplayName',
        'attribute|account.a|Description',
        'attribute|account.b|DisplayName',
        'attribute|account.b|Description',
        'entity|account|DisplayName',
        'entity|account|DisplayCollectionName',
        'entity|account|Description',
        'attribute|contact.a|DisplayName',
      ],
    );
    // Form elements stay in document order inside their form.
    const f = (cell: string, order: number) => mk('field', `field|${FORM}|${cell}`, 'Label', { entity: 'account', order });
    t.eq(sortSlots([f('z', 0), f('a', 2), f('m', 1)]).map((s) => s.comp.split('|')[2]), ['z', 'm', 'a']);
    // A global choice's own rows sit right above its values.
    const set = (n: string, order: number) => [mk('globaloptionset', `globaloptionset|${n}`, 'Description', { order, ref: { name: n } }), mk('globaloptionset', `globaloptionset|${n}`, 'DisplayName', { order, ref: { name: n } })];
    const val = (n: string, v: number, order: number) => mk('globaloption', `globaloption|${n}|${v}`, 'Label', { order, ref: { name: n, value: v } });
    t.eq(
      sortSlots([val('b_set', 2, 1), ...set('b_set', 0), val('a_set', 7, 0), val('b_set', 1, 0), ...set('a_set', 1)]).map((s) => s.key),
      [
        'globaloptionset|a_set|DisplayName',
        'globaloptionset|a_set|Description',
        'globaloption|a_set|7|Label',
        'globaloptionset|b_set|DisplayName',
        'globaloptionset|b_set|Description',
        'globaloption|b_set|1|Label',
        'globaloption|b_set|2|Label',
      ],
    );
    // Sorting does not change the input.
    const input = [f('z', 1), f('a', 0)];
    sortSlots(input);
    t.eq(input.map((s) => s.order), [1, 0]);
  });

  t.test('sheets: label modes partition every property', () => {
    for (const p of Object.keys(PROP_NAMES) as Prop[]) {
      const s = mk('attribute', 'attribute|e.a', p);
      t.ok(inLabelMode(s, 'both'), `${p} in both`);
      t.ok(inLabelMode(s, 'names') !== inLabelMode(s, 'descriptions'), `${p} is in exactly one of names / descriptions`);
    }
    t.ok(inLabelMode(mk('entity', 'entity|e', 'DisplayCollectionName'), 'names'));
    t.ok(inLabelMode(mk('command', 'command|x', 'ToolTipDescription'), 'descriptions'));
    t.ok(inLabelMode(mk('envvar', 'envvar|x', 'Hint'), 'descriptions'));
  });

  t.test('sheets: Rows filter compares the target with the base, also when the base is not English', () => {
    const base = 1036;
    const target = 1033;
    const langs = [1036, 1033];
    const store = new Store();
    const s = (n: string, labels: Record<number, string>, o: Partial<Slot> = {}) => mk('view', `view|${n}`, 'Name', { labels, ...o });
    const same = s('same', { 1036: 'Compte', 1033: 'Compte' });
    const blank = s('blank', { 1036: 'Compte' });
    const spaces = s('spaces', { 1036: 'Compte', 1033: '  ' });
    const done = s('done', { 1036: 'Compte', 1033: 'Account' });
    const noBase = s('nobase', { 1033: 'Account' });
    const ro = s('ro', { 1036: 'Compte' }, { readOnly: 'Managed and not customizable' });
    // A tab label whose other languages were not read: unknown, so neither blank nor "matches or blank".
    const unread = mk('tab', `tab|${FORM}|t1`, 'Label', { labels: { 1036: 'Résumé' }, ref: { formId: FORM, elId: 't1', partial: true } });
    const all = [same, blank, spaces, done, noBase, ro, unread];
    store.add(all);
    const keys = (m: Parameters<typeof rowsTest>[0]) => all.filter(rowsTest(m, store, base, target, langs)).map((x) => x.comp.split('|')[1]);
    t.eq(keys('all').length, all.length);
    t.eq(keys('same'), ['same']);
    t.eq(keys('blank'), ['blank', 'spaces']);
    t.eq(keys('sameOrBlank'), ['same', 'blank', 'spaces']);
    t.eq(keys('pending'), []);
    // Pending edits count: the filter works on current values.
    store.set(done.key, 1033, 'Compte');
    store.set(blank.key, 1033, 'Account');
    t.eq(keys('same'), ['same', 'done']);
    t.eq(keys('blank'), ['spaces']);
    t.eq(keys('pending'), ['blank', 'done']);
    t.eq(keys('problems'), []);
    // Problems: a save error, or a translation emptied where Dataverse can't remove it and nothing stands in for it
    // (model.ts standIn: here the base text, saved in its place, until that is emptied too).
    store.status.set(`${same.key}#1033`, { outcome: 'error', message: 'x' });
    const field = mk('field', `field|${FORM}|c9`, 'Label', { labels: { 1036: 'Nom', 1033: 'Name' }, ref: { formId: FORM, elId: 'c9' } });
    store.add([field]);
    store.set(field.key, 1033, '');
    t.ok(rowsTest('problems', store, base, target, langs)(same), 'save error');
    t.ok(!rowsTest('problems', store, base, target, langs)(field), 'saved as the French base text: no problem');
    store.set(field.key, 1036, ' ');
    t.ok(rowsTest('problems', store, base, target, langs)(field), 'blocked blank');
    t.ok(!rowsTest('problems', store, base, target, langs)(done), 'no problem');
    // Read-only rows only show under All rows…
    for (const m of ['same', 'sameOrBlank', 'blank', 'pending', 'problems'] as const) t.ok(!rowsTest(m, store, base, target, langs)(ro), `read-only under ${m}`);
    // …unless they hold an edit: a row that turned read-only after it was edited (a later extraction found it
    // locked, or couldn't read it) is still pending and can't be saved, so Pending changes and Save problems list it.
    const later = s('later', { 1036: 'Compte', 1033: 'Account' });
    store.add([later]);
    store.set(later.key, 1033, 'Accounts');
    store.add([{ ...later, labels: { ...later.labels }, readOnly: 'Could not read its translations: HTTP 500' }]);
    const now = store.get(later.key)!;
    t.ok(store.isEdited(now.key) && !!now.readOnly, 'fixture: edited and read-only');
    t.ok(rowsTest('pending', store, base, target, langs)(now), 'read-only row with an edit is pending');
    t.ok(rowsTest('problems', store, base, target, langs)(now), 'read-only row with an edit is a save problem');
    t.ok(!rowsTest('same', store, base, target, langs)(now) && !rowsTest('blank', store, base, target, langs)(now), 'but not a text match');
    t.eq(store.changes().filter((c) => c.slot.readOnly).length, 1, 'the edit is in the pending total');
  });

  t.test('sheets: Rows labels', () => {
    t.eq(
      (['all', 'same', 'sameOrBlank', 'blank', 'pending', 'problems'] as const).map((m) => rowsLabel(m, 'English', 'French')),
      ['All rows', 'French matches English', 'French matches English or is blank', 'French is blank', 'Pending changes', 'Save problems'],
    );
  });

  t.test('sheets: Filter rows text covers sheet, keys, type, labels and pending edits (folded)', () => {
    const store = new Store();
    const a = FIX.find((s) => s.kind === 'attribute')!;
    const s = { ...a, labels: { 1033: 'Account Name', 1036: 'Nom du compte' }, title: 'Account Name' } as Slot;
    store.add([s]);
    store.set(s.key, 1036, 'Désignation');
    const d: SheetDef = sheetOf(s);
    const txt = searchText(s, d, ctx(store), store);
    for (const w of ['attributes', 'account', 'name', fold(ID), 'description (tooltip)', 'nom du compte', 'designation']) t.ok(txt.includes(w), `missing ${w}`);
    t.eq(fold('École_Name-x'), 'ecole name x');
  });

  t.test('sheets: Setup options load the right kinds; defaults as decided', () => {
    const labels = SETUP_GROUPS.entity.map((o) => o.label);
    t.eq(labels.slice(0, 11), [
      'Export Entity Translation',
      'Export Attributes Translation',
      'Export Picklists Option Labels Translation',
      'Export Booleans Option Labels Translation',
      'Export Views Translation',
      'Export Charts Translation',
      'Export Forms Translation',
      'Export Forms Tabs Translation',
      'Export Forms Sections Translation',
      'Export Forms Fields Translation',
      'Export Relationships that are using custom labels',
    ]);
    t.eq(SETUP_GROUPS.global.slice(0, 3).map((o) => o.label), ['Export Global OptionSets Labels Translation', 'Export SiteMap custom labels Translation', 'Export Dashboards custom labels Translation']);
    t.ok(SETUP_GROUPS.entity.every((o) => o.needsTable) && SETUP_GROUPS.global.every((o) => !o.needsTable), 'needsTable');
    const on = (ids: string[]) => Object.fromEntries([...SETUP_GROUPS.entity, ...SETUP_GROUPS.global].map((o) => [o.id, ids.includes(o.id)]));
    // Every kind can be loaded from the Setup screen.
    const every = kindsOf(on([...SETUP_GROUPS.entity, ...SETUP_GROUPS.global].map((o) => o.id)));
    for (const k of Object.keys(KIND_NAMES) as Kind[]) t.ok(every.has(k), `${k} cannot be chosen`);
    t.eq([...kindsOf(on(['option']))].sort(), ['globaloption', 'option', 'state', 'status']);
    t.eq([...kindsOf(on(['globaloptionset']))].sort(), ['globaloption', 'globaloptionset']);
    t.eq(kindsOf(on([])).size, 0);
    // Defaults: entity-related on (Forms Navigation too); BPF, commands, ribbon, sitemap, dashboards off; global choices on.
    const d = kindsOf({});
    for (const k of ['entity', 'attribute', 'option', 'boolean', 'view', 'chart', 'form', 'tab', 'section', 'field', 'relationship', 'navitem', 'globaloptionset'] as Kind[]) t.ok(d.has(k), `${k} on by default`);
    for (const k of ['bpf', 'stage', 'command', 'ribbon', 'area', 'dashboard', 'dtab'] as Kind[]) t.ok(!d.has(k), `${k} off by default`);
  });

  t.test('scope: Workbench state is remembered per org and malformed values fall back to defaults', () => {
    const was = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const mem = new Map<string, string>();
    const stub = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true });
    try {
      const d = loadState('org1');
      t.eq([d.source, d.labelMode, d.rows, d.ro, d.setup, d.tables], ['all', 'both', 'all', false, true, []]);
      t.eq(d.opts.entity, true);
      t.eq(d.opts.ribbon, false);
      d.source = 'solution';
      d.sol = ID;
      d.tables = ['account'];
      d.opts.ribbon = true;
      d.widths['attributes:attr'] = 210;
      d.rows = 'blank';
      d.tablesFor = 'all'; // Account was checked under All entities, the solution's tables not listed yet
      saveState('org1', d);
      t.ok(mem.has('dxt:wb2:org1'), 'stored under dxt:wb2:<org>');
      const back = loadState('org1');
      t.eq([back.source, back.sol, back.tables, back.opts.ribbon, back.widths['attributes:attr'], back.rows, back.tablesFor], ['solution', ID, ['account'], true, 210, 'blank', 'all']);
      t.eq(loadState('org2').source, 'all', 'other org');
      mem.set('dxt:wb2:org3', JSON.stringify({ source: 'x', rows: 'nope', labelMode: 3, tables: ['a', 5, '', 'a'], opts: { entity: 'yes', view: false }, widths: { a: -1, b: 'x', c: 90 } }));
      const bad = loadState('org3');
      t.eq([bad.source, bad.rows, bad.labelMode, bad.tables, bad.opts.entity, bad.opts.view, bad.widths], ['all', 'all', 'both', ['a'], true, false, { c: 90 }]);
      mem.set('dxt:wb2:org4', '{not json');
      t.eq(loadState('org4').source, 'all');
    } finally {
      if (was) Object.defineProperty(globalThis, 'localStorage', was);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  t.test('scope: Extract translations builds the Scope or says what is missing (old texts)', () => {
    const st = (o: Partial<WbState> = {}): WbState => ({ source: 'all', sol: '', solName: '', tables: [], opts: {}, labelMode: 'both', rows: 'all', ro: false, widths: {}, sheet: '', setup: true, ...o });
    const only = (ids: string[]) => Object.fromEntries([...SETUP_GROUPS.entity, ...SETUP_GROUPS.global].map((o) => [o.id, ids.includes(o.id)]));
    // Defaults with two tables: every global choice of the environment, as the old tool listed them.
    const sc = scopeOf(st(), ['account', 'contact'], 'shown') as Scope;
    t.ok(typeof sc === 'object', 'a scope');
    t.eq([sc.entities, sc.solutionId, sc.includeReadOnly, sc.allGlobals], [['account', 'contact'], undefined, false, true]);
    t.ok(sc.kinds.has('field') && sc.kinds.has('globaloptionset') && !sc.kinds.has('ribbon'), 'default kinds');
    t.eq((scopeOf(st({ ro: true }), ['account'], 'shown') as Scope).includeReadOnly, true);
    // Without Global OptionSets, only the global choices the tables' columns use (through Picklists / Booleans).
    const noSets = scopeOf(st({ opts: { globaloptionset: false } }), ['account'], 'shown') as Scope;
    t.eq([noSets.allGlobals, noSets.kinds.has('globaloption'), noSets.kinds.has('globaloptionset')], [false, true, false]);
    // Global-only extraction needs no entity (B26).
    const g = scopeOf(st({ opts: only(['globaloptionset', 'sitemap']) }), [], 'none') as Scope;
    t.eq([g.entities, g.allGlobals, [...g.kinds].sort()], [[], true, ['area', 'globaloption', 'globaloptionset', 'group', 'subarea']]);
    // Errors, in the old tool's words.
    t.eq(scopeOf(st(), [], 'none'), 'Click Load Entities, then select at least one entity before extracting entity-related translations.');
    t.eq(scopeOf(st(), [], 'shown'), 'Select at least one entity before extracting entity-related translations.');
    t.eq(scopeOf(st(), [], 'loading'), 'Select at least one entity before extracting entity-related translations.');
    t.eq(scopeOf(st({ opts: only([]) }), ['account'], 'shown'), 'Choose at least one kind of translation to export.');
    t.eq(scopeOf(st({ source: 'solution' }), ['account'], 'shown'), 'Select a solution, then click Load Entities.');
    // A solution: its global choices (plus those of the checked tables), never every one of the environment.
    const s = scopeOf(st({ source: 'solution', sol: ID, solName: 'Contoso' }), ['contoso_servicerequest'], 'shown') as Scope;
    t.eq([s.solutionId, s.allGlobals, s.entities], [ID, false, ['contoso_servicerequest']]);
    t.eq(scopeOf(st({ source: 'solution', sol: ID, solName: 'Contoso' }), [], 'empty'), 'Contoso has no tables. To extract its other components, clear Entity related options.');
    const sg = scopeOf(st({ source: 'solution', sol: ID, solName: 'Contoso', opts: only(['globaloptionset', 'app']) }), [], 'empty') as Scope;
    t.eq([sg.solutionId, sg.allGlobals, sg.entities], [ID, false, []]);
  });

  t.test('scope: entities checked in another load source are never extracted under a new solution until its tables are listed', () => {
    const st = (o: Partial<WbState> = {}): WbState => ({ source: 'all', sol: '', solName: '', tables: [], opts: {}, labelMode: 'both', rows: 'all', ro: false, widths: {}, sheet: '', setup: true, ...o });
    const only = (ids: string[]) => Object.fromEntries([...SETUP_GROUPS.entity, ...SETUP_GROUPS.global].map((o) => [o.id, ids.includes(o.id)]));
    const sol = st({ source: 'solution', sol: ID, solName: 'Contacts only' });
    t.eq([listKey(st()), listKey(sol), listKey(st({ sol: ID }))], ['all', `solution|${ID}`, 'all']);
    // Checked under All entities, the solution's membership read still pending, then failed.
    t.eq(scopeOf(sol, ['account'], 'loading', 'all'), 'Wait for the tables of Contacts only to load, then extract translations: the entities checked before may not be in this solution.');
    t.eq(
      scopeOf(sol, ['account'], 'none', 'all'),
      "Couldn't read the tables of Contacts only, so the entities checked before can't be extracted from this solution. Select Try again under the entity list, then extract translations.",
    );
    // Another solution was listed: a newly picked solution lists its tables unchecked, so there is nothing to extract yet.
    t.eq(scopeOf(sol, ['account'], 'loading', 'solution|another'), 'Wait for the tables of Contacts only to load, then check the entities to extract.');
    t.eq(scopeOf(sol, ['account'], 'none', 'solution|another'), "Couldn't read the tables of Contacts only. Select Try again under the entity list, then check the entities to extract.");
    // Nothing checked yet: still waits, rather than asking for an entity, and never speaks of checks made before.
    t.eq(scopeOf(sol, [], 'loading', 'all'), 'Wait for the tables of Contacts only to load, then check the entities to extract.');
    t.eq(scopeOf(sol, [], 'none', 'all'), "Couldn't read the tables of Contacts only. Select Try again under the entity list, then check the entities to extract.");
    t.eq(scopeOf(st(), [], 'loading', `solution|${ID}`), 'Wait for the entity list to load, then check the entities to extract.');
    // Only a wait is no error (the Workbench's message bar).
    t.eq([scopeOf(sol, [], 'loading', 'all'), scopeOf(sol, ['account'], 'loading', 'all'), scopeOf(sol, [], 'none', 'all'), scopeOf(st(), [], 'none')].map((m) => waitsForList(m as string)), [true, true, false, false]);
    // Listed for this solution: extracted as before.
    t.eq((scopeOf(sol, ['contact'], 'shown', `solution|${ID}`) as Scope).entities, ['contact']);
    t.eq((scopeOf(sol, ['contact'], 'loading', `solution|${ID}`) as Scope).entities, ['contact'], 'the remembered checks while the same source lists again');
    // Nothing uses the entities (global options only, none checked): no need to wait.
    t.eq((scopeOf({ ...sol, opts: only(['globaloptionset']) }, [], 'loading', 'all') as Scope).solutionId, ID);
    t.eq((scopeOf(st(), ['account'], 'loading', 'all') as Scope).entities, ['account']);
    t.eq(scopeOf(st(), ['account'], 'none', `solution|${ID}`), "Couldn't read the entity list, so the entities checked before can't be extracted from it. Select Try again under the entity list, then extract translations.");
  });

  t.test('scope: the Setup screen blocks Extract while a newly chosen solution is read, and after that read failed; its tables then decide', async () => {
    const off = install();
    const doc = document as unknown as { createElement(t: string): FEl };
    const make = doc.createElement;
    doc.createElement = (x: string) => Object.assign(make(x), { style: { setProperty() {}, removeProperty() {} } });
    Object.defineProperty(FEl.prototype, 'options', { get(this: FEl) { return this.children.filter((c) => c.tagName === 'OPTION'); }, configurable: true });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    try {
      const table = (l: string, n: string) => ({ logicalName: l, schemaName: l, metadataId: l, displayName: { 1033: n }, collectionName: {}, customizable: true, renameable: true, managed: false, custom: false, activity: false, otc: 1 });
      let read: { ok(v: string[]): void; no(e: Error): void } | null = null;
      const app = {
        ctx: { base: 1033, user: 1033, orgId: 'org', langs: [{ lcid: 1033, name: 'English', isBase: true }, { lcid: 1036, name: 'French', isBase: false }] },
        prefs: { target: 1036, shown: [1036] },
        savePrefs() {},
        adoptStyles() {},
        root: dom.root,
        providers: {
          listTables: async () => [table('account', 'Account'), table('contact', 'Contact')],
          listSolutions: async () => [{ id: ID, uniqueName: 'contacts', name: 'Contacts only', managed: false, version: '1.0', publisher: 'p' }],
          solutionTables: () => new Promise<string[]>((ok, no) => (read = { ok, no })),
        },
      } as unknown as AppApi;
      // Remembered: All entities with Account checked, and the solution chosen once before.
      const st: WbState = { source: 'all', sol: ID, solName: 'Contacts only', tables: ['account'], opts: {}, labelMode: 'both', rows: 'all', ro: false, widths: {}, sheet: '', setup: true };
      const setup = createSetup(app, st, () => {}, () => {});
      const el = setup.el as unknown as FEl;
      await setup.init();
      t.eq((setup.scope() as Scope).entities, ['account']);
      const src = el.querySelectorAll('select')[0];
      src.value = 'solution';
      fire(src, 'change');
      t.ok(read, 'the solution is being read');
      t.eq(setup.scope(), scopeOf({ ...st }, ['account'], 'loading', 'all'), 'never Account under the solution while its tables load');
      read!.no(new Error('The request timed out'));
      await tick();
      t.eq(setup.scope(), scopeOf({ ...st }, ['account'], 'none', 'all'), 'nor after that read failed');
      // Try again: Contact is the solution's only table, so Account's check is forgotten.
      fire(el.querySelectorAll('button').find((b) => b.textContent === 'Try again')!, 'click');
      read!.ok(['contact']);
      await tick();
      t.eq([st.tables, st.tablesFor], [[], `solution|${ID}`]);
      t.eq(setup.scope(), 'Select at least one entity before extracting entity-related translations.');
      const box = el.querySelectorAll('tbody input')[0];
      box.checked = true;
      fire(box, 'change');
      const sc = setup.scope() as Scope;
      t.eq([sc.entities, sc.solutionId], [['contact'], ID]);
      setup.destroy();
    } finally {
      delete (FEl.prototype as unknown as Record<string, unknown>).options;
      doc.createElement = make;
      off();
    }
  });

  t.test('scope: checks saved with the load source they were made in still wait after a reopen; saved state without it counts as made in the remembered source', async () => {
    const off = install();
    const doc = document as unknown as { createElement(t: string): FEl };
    const make = doc.createElement;
    doc.createElement = (x: string) => Object.assign(make(x), { style: { setProperty() {}, removeProperty() {} } });
    Object.defineProperty(FEl.prototype, 'options', { get(this: FEl) { return this.children.filter((c) => c.tagName === 'OPTION'); }, configurable: true });
    const was = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const mem = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }, configurable: true, writable: true });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    try {
      const table = (l: string, n: string) => ({ logicalName: l, schemaName: l, metadataId: l, displayName: { 1033: n }, collectionName: {}, customizable: true, renameable: true, managed: false, custom: false, activity: false, otc: 1 });
      type Wait<T> = { ok(v: T): void; no(e: Error): void };
      let tables: Wait<unknown[]> | null = null;
      let read: Wait<string[]> | null = null;
      const app = {
        ctx: { base: 1033, user: 1033, orgId: 'org', langs: [{ lcid: 1033, name: 'English', isBase: true }, { lcid: 1036, name: 'French', isBase: false }] },
        prefs: { target: 1036, shown: [1036] },
        savePrefs() {},
        adoptStyles() {},
        root: dom.root,
        providers: {
          listTables: () => new Promise<unknown[]>((ok, no) => (tables = { ok, no })),
          listSolutions: async () => [{ id: ID, uniqueName: 'contacts', name: 'Contacts only', managed: false, version: '1.0', publisher: 'p' }],
          solutionTables: () => new Promise<string[]>((ok, no) => (read = { ok, no })),
        },
      } as unknown as AppApi;
      const blocked = (st: WbState, list: 'loading' | 'none') => scopeOf({ ...st }, ['account'], list, 'all');
      // Account checked under All entities, then the solution chosen; closed before its tables were read.
      const base: WbState = { source: 'solution', sol: ID, solName: 'Contacts only', tables: ['account'], opts: {}, labelMode: 'both', rows: 'all', ro: false, widths: {}, sheet: '', setup: true, tablesFor: 'all' };
      saveState('org', base);
      for (const fails of [false, true]) {
        const st = loadState('org');
        const setup = createSetup(app, st, () => {}, () => {});
        const p = setup.init();
        await tick();
        tables!.ok([table('account', 'Account'), table('contact', 'Contact')]);
        await tick();
        t.ok(read, 'the solution is being read');
        t.eq(setup.scope(), blocked(st, 'loading'), 'reopened: never Account under the solution while its tables load');
        if (fails) {
          read!.no(new Error('The request timed out'));
          await p;
          t.eq(setup.scope(), blocked(st, 'none'), 'nor after that read failed');
        } else {
          read!.ok(['contact']);
          await p;
          t.eq([st.tables, st.tablesFor, setup.scope()], [[], `solution|${ID}`, 'Select at least one entity before extracting entity-related translations.'], 'its tables decide');
        }
        setup.destroy();
        tables = read = null;
      }
      // Saved before tablesFor was kept: its checks count as made in the remembered source (All entities). Switched to the
      // solution while that first list is still loading, they wait for the solution's tables all the same.
      const old: Partial<WbState> = { ...base, source: 'all' };
      delete old.tablesFor;
      mem.set('dxt:wb2:org', JSON.stringify(old));
      const st = loadState('org');
      t.eq(st.tablesFor, undefined);
      const setup = createSetup(app, st, () => {}, () => {});
      t.eq(st.tablesFor, 'all');
      void setup.init();
      await tick();
      t.ok(tables, 'the first list is loading');
      const src = (setup.el as unknown as FEl).querySelectorAll('select')[0];
      src.value = 'solution';
      fire(src, 'change');
      t.eq(setup.scope(), blocked(st, 'loading'));
      setup.destroy();
    } finally {
      if (was) Object.defineProperty(globalThis, 'localStorage', was);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
      delete (FEl.prototype as unknown as Record<string, unknown>).options;
      doc.createElement = make;
      off();
    }
  });

  t.test('metadata: Global OptionSets lists every global choice; page loads and solutions never do', async () => {
    const A = 'a0a0a0a0-0000-4000-8000-00000000000a';
    const B = 'b0b0b0b0-0000-4000-8000-00000000000b';
    const C = 'c0c0c0c0-0000-4000-8000-00000000000c';
    const lab = (en: string, fr: string) => ({ LocalizedLabels: [{ Label: en, LanguageCode: 1033 }, { Label: fr, LanguageCode: 1036 }] });
    const set = (id: string, name: string, o: Record<string, unknown> = {}) => ({
      MetadataId: id,
      Name: name,
      IsGlobal: true,
      IsCustomizable: { Value: true },
      IsManaged: false,
      DisplayName: lab(name, name + ' fr'),
      Description: lab('', ''),
      Options: [{ Value: 1, MetadataId: id, Label: lab('One', 'Un'), Description: null }],
      ...o,
    });
    const sets: Record<string, any> = { [A]: set(A, 'new_color'), [B]: set(B, 'new_size'), [C]: set(C, 'msdyn_locked', { IsManaged: true, IsCustomizable: { Value: false } }) };
    const fake = (o: { listFails?: boolean } = {}) => {
      const calls: string[] = [];
      const http = {
        api: '/api/data/v9.2/',
        reads: { max: 4, run: () => Promise.reject(new Error('no $batch in unit tests')) },
        stats: { requests: 0, failures: 0, ms: 0 },
        async get(p: string) {
          calls.push(p);
          const m = /^GlobalOptionSetDefinitions\(([\da-f-]+)\)$/.exec(p);
          if (m) {
            if (!sets[m[1]]) throw new DvError('Not found', 404);
            return sets[m[1]];
          }
          if (p.startsWith("EntityDefinitions(LogicalName='account')")) return { LogicalName: 'account', MetadataId: ID, DisplayName: lab('Account', 'Compte'), DisplayCollectionName: lab('Accounts', 'Comptes'), Description: lab('', ''), IsCustomizable: { Value: true }, IsManaged: false };
          throw new DvError(`unexpected GET ${p}`, 400);
        },
        async all(p: string) {
          calls.push(p);
          if (p === 'GlobalOptionSetDefinitions?$select=MetadataId,Name') {
            if (o.listFails) throw new DvError('Dataverse is busy.', 503);
            return [...Object.values(sets).map((s) => ({ MetadataId: s.MetadataId, Name: s.Name })), { MetadataId: 'deadbeef-0000-4000-8000-000000000000', Name: 'new_gone' }];
          }
          if (p.includes('CRM.PicklistAttributeMetadata?')) return [{ LogicalName: 'new_color', MetadataId: ID, DisplayName: lab('Color', 'Couleur'), OptionSet: { ...sets[A], Options: sets[A].Options } }];
          if (p.startsWith('solutioncomponents?')) return [{ objectid: B }];
          return [];
        },
      };
      return { calls, ctx: { http, user: 1036, base: 1033, langs: [] } as unknown as Ctx };
    };
    const progress: string[] = [];
    const lo = () => ({ signal: new AbortController().signal, progress: (m: string) => void progress.push(m) });
    const glob = new Set<Kind>(['globaloptionset', 'globaloption']);
    const keys = (slots: Slot[]) => slots.map((s) => s.key).sort();

    // Only Global OptionSets, no table: every customizable global choice; one that is gone (404) is skipped.
    let f = fake();
    let out = await loadMetadataScope(f.ctx, { entities: [], kinds: glob, allGlobals: true }, lo());
    t.eq(
      keys(out),
      [
        'globaloption|new_color|1|Description',
        'globaloption|new_color|1|Label',
        'globaloption|new_size|1|Description',
        'globaloption|new_size|1|Label',
        'globaloptionset|new_color|Description',
        'globaloptionset|new_color|DisplayName',
        'globaloptionset|new_size|Description',
        'globaloptionset|new_size|DisplayName',
      ].sort(),
    );
    t.eq(out.find((s) => s.key === 'globaloption|new_size|1|Label')?.labels, { 1033: 'One', 1036: 'Un' });
    t.ok(sheetOf(out[0]).name === 'Global OptionSets' && out.every((s) => sheetOf(s) === sheetOf(out[0])), 'all on Global OptionSets');
    // Read-only labels asked for: the managed, non-customizable set too (locked).
    out = await loadMetadataScope(fake().ctx, { entities: [], kinds: glob, allGlobals: true, includeReadOnly: true }, lo());
    t.ok(out.some((s) => s.key === 'globaloptionset|msdyn_locked|DisplayName' && !!s.readOnly), 'read-only set when asked');

    // With a table: the sets its columns use keep Used By; every other set is listed as well.
    f = fake();
    out = await loadMetadataScope(f.ctx, { entities: ['account'], kinds: new Set<Kind>(['entity', ...glob]), allGlobals: true }, lo());
    t.eq(out.find((s) => s.key === 'globaloptionset|new_color|DisplayName')?.ref.usedBy, ['account.new_color']);
    t.eq(out.find((s) => s.key === 'globaloptionset|new_size|DisplayName')?.ref.usedBy, []);
    t.ok(out.some((s) => s.key === 'entity|account|DisplayName'), 'table labels');

    // Without allGlobals (Global OptionSets unchecked), only the tables' sets: no list of every set.
    f = fake();
    out = await loadMetadataScope(f.ctx, { entities: ['account'], kinds: new Set<Kind>(['entity', 'globaloption']), allGlobals: false }, lo());
    t.ok(!f.calls.some((c) => c.startsWith('GlobalOptionSetDefinitions?')), 'no full list');
    t.eq(keys(out.filter((s) => s.kind === 'globaloption')), ['globaloption|new_color|1|Description', 'globaloption|new_color|1|Label']);

    // A solution: its sets, never the full list (allGlobals is ignored there).
    f = fake();
    out = await loadMetadataScope(f.ctx, { entities: [], kinds: glob, solutionId: ID, allGlobals: true }, lo());
    t.ok(!f.calls.some((c) => c.startsWith('GlobalOptionSetDefinitions?')), 'no full list in a solution');
    t.eq([...new Set(out.map((s) => s.ref.name))], ['new_size']);

    // Page loads (loadTables) never list every global choice.
    f = fake();
    await loadTables(f.ctx, ['account'], new Set<Kind>(['entity', ...glob]), lo());
    t.ok(!f.calls.some((c) => c.startsWith('GlobalOptionSetDefinitions?')), 'page loads stay on the table');

    // The full list failing keeps the table's labels and says so; with nothing else loaded it fails.
    progress.length = 0;
    out = await loadMetadataScope(fake({ listFails: true }).ctx, { entities: ['account'], kinds: new Set<Kind>(['entity', ...glob]), allGlobals: true }, lo());
    t.ok(out.some((s) => s.key === 'entity|account|DisplayName') && out.some((s) => s.key === 'globaloptionset|new_color|DisplayName'), 'table labels kept');
    t.ok(progress.some((m) => /^Loaded with problems\. .*Dataverse is busy/.test(m)), `reported: ${progress.join(' / ')}`);
    let failed = '';
    await loadMetadataScope(fake({ listFails: true }).ctx, { entities: [], kinds: glob, allGlobals: true }, lo()).catch((e) => (failed = String(e?.message)));
    t.ok(/Dataverse is busy/.test(failed), 'global-only extraction fails visibly');
  });
}
