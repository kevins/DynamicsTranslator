// Unit tests for the describe area (popup content, looks, list groups). register() is called by tools/dev/unit.ts.
import { MANAGED, type Kind, type Prop, type Slot } from '../../../src/core/model';
import { Store } from '../../../src/core/store';
import { actionFor, BUILTIN_NOTE, describe, FIELD_NOTES, hasSteps, inTransient, listAction, navIdOf, TABLE_COMMAND_NOTE, TABLE_COMMAND_WHY, useRibbonControls } from '../../../src/inspector/describe';
import { inert } from '../../../src/inspector/overlay';
import { isBuiltin } from '../../../src/inspector/scan';
import { loadFormXml } from '../../../src/providers/formxml';
import { groupOf, look, pageTitle, relatedKeys } from '../../../src/inspector/status';
import type { Anchor, CalloutModel, Role } from '../../../src/inspector/types';
import type { AppApi } from '../../../src/ui/types';
import type { Kit } from './kit';

const EN = 1033;
const FR = 1036;

/** A slot as the loaders make them (`key = ${comp}|${prop}`). */
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
  baseRequired: prop !== 'Description',
  max: 0,
  order: 0,
  ref: {},
  ...o,
});

const FORM = ['Account', 'Information (Main form)'];
const cell = (id: string, labels: Record<number, string>, where: string[], ref: Record<string, unknown>, order: number): Slot =>
  S('field', `field|f1|${id}`, 'Label', labels, { path: [...FORM, ...where], ref: { formId: 'f1', elId: id, formType: 2, area: 'body', ...ref }, order, group: 'formxml|f1' });

/** An account main form with one column placed three times, a status reason field, a sub-grid and a tab. */
function fixture(): Slot[] {
  return [
    S('form', 'form|f1', 'Name', { [EN]: 'Information', [FR]: 'Informations' }, { path: ['Account'] }),
    S('form', 'form|f1', 'Description', { [EN]: 'The main form.' }, { path: ['Account'] }),
    S('entity', 'entity|account', 'DisplayName', { [EN]: 'Account', [FR]: 'Compte' }, { path: ['Account'], ref: { entity: 'account' } }),
    S('entity', 'entity|account', 'DisplayCollectionName', { [EN]: 'Accounts', [FR]: 'Comptes' }, { path: ['Account'], ref: { entity: 'account' } }),
    S('entity', 'entity|account', 'Description', { [EN]: 'A business.' }, { path: ['Account'], ref: { entity: 'account' } }),
    S('attribute', 'attribute|account.name', 'DisplayName', { [EN]: 'Account Name', [FR]: 'Nom du compte' }, { path: ['Account', 'Columns'], ref: { entity: 'account', attribute: 'name' } }),
    S('attribute', 'attribute|account.name', 'Description', { [EN]: 'Type the company or business name.' }, { path: ['Account', 'Columns'], ref: { entity: 'account', attribute: 'name' } }),
    S('attribute', 'attribute|account.statuscode', 'DisplayName', { [EN]: 'Status Reason', [FR]: 'Raison du statut' }, { ref: { entity: 'account', attribute: 'statuscode' } }),
    S('attribute', 'attribute|account.statuscode', 'Description', {}, { ref: { entity: 'account', attribute: 'statuscode' } }),
    cell('c2', { [EN]: 'Account Name', [FR]: 'Nom du compte' }, ['Header'], { area: 'header', controlId: 'header_name', datafield: 'name' }, 0),
    cell('c1', { [EN]: 'Account Name', [FR]: 'Nom du compte' }, ['Summary', 'Account information'], { controlId: 'name', datafield: 'name', tabName: 'SUMMARY', sectionName: 'ACCOUNT_INFO' }, 1),
    cell('c3', { [EN]: 'Account Name' }, ['Details', 'Address'], { controlId: 'name', datafield: 'name', tabName: 'DETAILS', sectionName: 'ADDRESS' }, 2),
    cell('c4', { [EN]: 'Status Reason', [FR]: 'Raison du statut' }, ['Summary', 'Account information'], { controlId: 'statuscode', datafield: 'statuscode' }, 3),
    cell('c5', { [EN]: 'Contacts' }, ['Summary', 'Contacts'], { controlId: 'Contacts' }, 4),
    S('status', 'status|account.statuscode|1', 'Label', { [EN]: 'Active', [FR]: 'Actif' }, { path: ['Account', 'Status Reason (statuscode)', 'Choices'], ref: { entity: 'account', attribute: 'statuscode', value: 1 }, order: 0 }),
    S('status', 'status|account.statuscode|1', 'Description', {}, { ref: { entity: 'account', attribute: 'statuscode', value: 1 }, order: 0 }),
    S('status', 'status|account.statuscode|2', 'Label', { [EN]: 'Inactive' }, { path: ['Account', 'Status Reason (statuscode)', 'Choices'], ref: { entity: 'account', attribute: 'statuscode', value: 2 }, order: 1 }),
    S('tab', 'tab|f1|t1', 'Label', { [EN]: 'Summary' }, { path: FORM, ref: { formId: 'f1', tabName: 'SUMMARY', partial: true }, group: 'formxml|f1' }),
    S('section', 'section|f1|s1', 'Label', { [EN]: 'Account information', [FR]: 'Account information' }, { path: [...FORM, 'Summary'], ref: { formId: 'f1' }, group: 'formxml|f1' }),
    S('command', 'command|b1', 'Label', { [EN]: 'Approve', [FR]: 'Approuver' }, { path: ['Account'] }),
    S('command', 'command|b1', 'ToolTipTitle', { [EN]: 'Approve the account' }, { path: ['Account'] }),
    S('command', 'command|b1', 'ToolTipDescription', { [EN]: 'Marks the account as approved.' }, { path: ['Account'] }),
    S('command', 'command|b1', 'Alt', { [EN]: 'Approve' }, { path: ['Account'] }),
    S('command', 'command|b1', 'Title', { [EN]: 'Approvals' }, { path: ['Account'] }),
  ];
}

const PREFS = { target: FR, shown: [], showNames: false, dock: 'right' };
function mkApp(slots: Slot[] = fixture(), prefs: Record<string, unknown> = {}, user = EN): AppApi {
  const store = new Store();
  store.add(slots);
  const ctx = { base: EN, user, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] };
  return { store, ctx, prefs: { ...PREFS, ...prefs } } as unknown as AppApi;
}
/** An anchor without a page element (describe only reads the element of classic buttons). */
const anchor = (app: AppApi, key: string, role: Role, focus?: string): Anchor => {
  const s = app.store.get(key)!;
  return { el: {} as Element, comp: s.comp, kind: s.kind, key, role, ...(focus ? { focus } : {}) };
};
const heads = (m: CalloutModel) => m.blocks.map((b) => [b.key, b.heading]);
/** A field popup's Form label block (its first: before Tooltip and Column name). */
const formLabel = (m: CalloutModel) => m.blocks.find((b) => b.heading === 'Form label')!;
/** The model's fields: nothing of the v2 popup (where, more, alt, altHint, scope, help) is left. */
const fields = (m: CalloutModel) => Object.keys(m).sort();

export function register(t: Kit): void {
  const { test, eq, ok } = t;

  // ---- describe: fields ----
  test('describe field: Form label (this form, instead of the column name), then Tooltip and Column name (everywhere), each saying where it applies', () => {
    const app = mkApp();
    const m = describe(app, 'field|f1|c1');
    eq([m.kind, m.title, m.icon, m.loading], ['Field', 'Account Name', 'field', false]);
    eq(m.blocks, [
      {
        key: 'field|f1|c1|Label',
        heading: 'Form label',
        long: false,
        also: { keys: ['field|f1|c2|Label', 'field|f1|c3|Label'], on: true },
        note: 'this form only, shown instead of the column name',
      },
      { key: 'attribute|account.name|Description', heading: 'Tooltip', long: true, note: 'everywhere' },
      { key: 'attribute|account.name|DisplayName', heading: 'Column name', long: false, note: 'everywhere: views, search and forms without a form label' },
    ]);
    eq(FIELD_NOTES.label, 'this form only, shown instead of the column name');
    eq(fields(m), ['blocks', 'comp', 'icon', 'kind', 'loading', 'title'], 'no where, more, alt, altHint, choices, readOnly or action');
    // Clicked on the page (the cell's label): the same order; the popup focuses the text the page shows (callout.ts).
    eq(heads(describe(app, 'field|f1|c1', anchor(app, 'field|f1|c1|Label', 'label'))), [
      ['field|f1|c1|Label', 'Form label'],
      ['attribute|account.name|Description', 'Tooltip'],
      ['attribute|account.name|DisplayName', 'Column name'],
    ]);
  });

  test('describe field: the other copies of the field on the form, and the default of the checkbox', () => {
    const app = mkApp();
    const also = () => formLabel(describe(app, 'field|f1|c1')).also!;
    // The header copy and the copy on another tab, in form order. c3 has no French label: it shows the column's
    // French name, "Nom du compte", the same text as this cell (LIVE-FINDINGS 42): on.
    eq(also(), { keys: ['field|f1|c2|Label', 'field|f1|c3|Label'], on: true });
    // A copy with another French text: off.
    app.store.set('field|f1|c3|Label', FR, 'Nom');
    eq(also().on, false);
    app.store.revert('field|f1|c3|Label');
    // Another English text (worded alike, so still a copy): off.
    app.store.set('field|f1|c3|Label', EN, 'Account name');
    eq([also().keys.length, also().on], [2, false]);
    app.store.revert('field|f1|c3|Label');
    // Typed in this cell only: the copies no longer show the same text.
    app.store.set('field|f1|c1|Label', FR, 'Nom du client');
    eq(also().on, false);
    // Typed with the copies following (the popup's checkbox ticked): the same text everywhere again.
    for (const k of ['field|f1|c2|Label', 'field|f1|c3|Label']) app.store.set(k, FR, 'Nom du client');
    eq(also().on, true);
    // Other shown languages count too.
    const de = mkApp(fixture().map((s) => (s.key === 'field|f1|c2|Label' ? { ...s, labels: { ...s.labels, 1031: 'Kontoname' } } : s)), { shown: [1031] });
    (de.ctx.langs as unknown[]).push({ lcid: 1031, name: 'German', isBase: false });
    eq(formLabel(describe(de, 'field|f1|c1')).also!.on, false, 'German differs');
    eq(formLabel(describe(mkApp(fixture().filter((s) => s.comp !== 'field|f1|c3')), 'field|f1|c1')).also!.keys, ['field|f1|c2|Label']);
    ok(!formLabel(describe(app, 'field|f1|c4')).also, 'no copies: no checkbox');
  });

  test('describe field: copies worded differently in the base language are other labels (never changed from here)', () => {
    const app = mkApp([
      ...fixture(),
      // The same column placed again as "Company" (another label), and once more with no label (shows the column name).
      cell('c8', { [EN]: 'Company' }, ['Details', 'Billing'], { controlId: 'name2', datafield: 'name' }, 8),
      cell('c9', {}, ['Details', 'Shipping'], { controlId: 'name3', datafield: 'name' }, 9),
    ]);
    eq(formLabel(describe(app, 'field|f1|c1')).also!.keys, ['field|f1|c2|Label', 'field|f1|c3|Label', 'field|f1|c9|Label'], '"Company" left out; the unlabelled copy shows "Account Name" too');
    eq(formLabel(describe(app, 'field|f1|c8')).also, undefined, '"Company" has no copy with its wording');
    // Spaces and case don't make a different label.
    const loose = mkApp(fixture().map((s) => (s.key === 'field|f1|c3|Label' ? { ...s, labels: { [EN]: ' account  name' } } : s)));
    eq(formLabel(describe(loose, 'field|f1|c1')).also!.keys, ['field|f1|c2|Label', 'field|f1|c3|Label']);
    // A read-only copy or one whose target language isn't loaded is never offered.
    const ro = mkApp(fixture().map((s) => (s.key === 'field|f1|c2|Label' ? { ...s, readOnly: 'Managed' } : s.key === 'field|f1|c3|Label' ? { ...s, ref: { ...s.ref, partial: [EN] } } : s)));
    eq(formLabel(describe(ro, 'field|f1|c1')).also, undefined);
  });

  test('describe field: a choice column lists its choices (closed, open on the clicked value)', () => {
    const app = mkApp();
    const m = describe(app, 'field|f1|c4');
    eq(m.choices, { keys: ['status|account.statuscode|1|Label', 'status|account.statuscode|2|Label'], open: false });
    const f = describe(app, 'field|f1|c4', anchor(app, 'field|f1|c4|Label', 'value', 'status|account.statuscode|2|Label'));
    eq(f.choices, { keys: ['status|account.statuscode|1|Label', 'status|account.statuscode|2|Label'], open: true, focus: 'status|account.statuscode|2|Label' });
    eq(heads(f), [['field|f1|c4|Label', 'Form label'], ['attribute|account.statuscode|Description', 'Tooltip'], ['attribute|account.statuscode|DisplayName', 'Column name']], "the field's texts keep their order");
  });

  test('describe field: a global choice says how many columns share it', () => {
    const app = mkApp([
      ...fixture(),
      S('attribute', 'attribute|account.industrycode', 'DisplayName', { [EN]: 'Industry' }, { ref: { entity: 'account', attribute: 'industrycode' } }),
      cell('c6', { [EN]: 'Industry' }, ['Details', 'Address'], { controlId: 'industrycode', datafield: 'industrycode' }, 6),
      S('globaloption', 'globaloption|industry|1', 'Label', { [EN]: 'Accounting' }, { entity: '', ref: { name: 'industry', value: 1, usedBy: ['account.industrycode', 'lead.industrycode'] }, order: 0 }),
      S('globaloption', 'globaloption|industry|2', 'Label', { [EN]: 'Agriculture' }, { entity: '', ref: { name: 'industry', value: 2, usedBy: ['account.industrycode', 'lead.industrycode'] }, order: 1 }),
    ]);
    eq(describe(app, 'field|f1|c6').choices, { keys: ['globaloption|industry|1|Label', 'globaloption|industry|2|Label'], open: false, shared: 2 });
    const v = describe(app, 'globaloption|industry|1');
    eq([v.kind, v.title, heads(v), v.choices], ['Choice', 'Accounting', [], { keys: ['globaloption|industry|1|Label', 'globaloption|industry|2|Label'], open: true, focus: 'globaloption|industry|1|Label', shared: 2 }]);
  });

  test('describe field: a sub-grid or other unbound cell has only its label', () => {
    const m = describe(mkApp(), 'field|f1|c5');
    eq(m.kind, 'Component');
    eq(heads(m), [['field|f1|c5|Label', 'Label']]);
    const grid = mkApp(fixture().map((s) => (s.key === 'field|f1|c5|Label' ? { ...s, ref: { ...s.ref, classid: '{E7A81278-8635-4D9E-8D4D-59480B391C5B}' } } : s)));
    eq(describe(grid, 'field|f1|c5').kind, 'Sub-grid');
  });

  test('describe field: the form loader keeps a control classid, so a sub-grid popup says Sub-grid', async () => {
    const id = '00000000-0000-0000-0000-0000000000f1';
    const formxml =
      '<form><tabs><tab id="{A1}" name="t"><labels><label description="General" languagecode="1033" /></labels><columns><column width="100%"><sections><section id="{S1}" name="s"><labels><label description="Info" languagecode="1033" /></labels><rows><row>' +
      '<cell id="{C1}"><labels><label description="Contacts" languagecode="1033" /></labels><control id="Contacts" classid="{E7A81278-8635-4D9E-8D4D-59480B391C5B}" /></cell>' +
      '<cell id="{C2}"><labels><label description="Account Name" languagecode="1033" /></labels><control id="name" datafieldname="name" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" /></cell>' +
      '</row></rows></section></sections></column></columns></tab></tabs></form>';
    const row = { formid: id, formxml, iscustomizable: { Value: true }, ismanaged: false };
    // Form XML is read through LangSession's $batch, the probe saying the user's language (core/langsession.ts).
    const http = {
      all: async (url: string) => (url.startsWith('systemforms') ? [row] : []),
      batch: async (parts: Array<{ url: string }>) =>
        parts.map((p) => ({ ok: true, status: 200, headers: {}, data: p.url.startsWith('systemforms') ? { value: [row] } : { DisplayName: { UserLocalizedLabel: { LanguageCode: EN } } } })),
    };
    const ctx = { base: EN, user: EN, langs: [{ lcid: EN, name: 'English', isBase: true }], http } as unknown as Parameters<typeof loadFormXml>[0];
    const slots = await loadFormXml(ctx, [{ formId: id, entity: 'account', name: 'Information', type: 2 }], [EN], { signal: new AbortController().signal, progress() {} });
    const grid = slots.find((s) => s.kind === 'field' && s.ref?.controlId === 'Contacts')!;
    eq(grid.ref?.classid, '{E7A81278-8635-4D9E-8D4D-59480B391C5B}');
    eq(describe(mkApp(slots), grid.comp).kind, 'Sub-grid');
    eq(describe(mkApp(slots), slots.find((s) => s.ref?.controlId === 'name')!.comp).kind, 'Field', 'a column cell stays a Field');
  });

  test('form XML: a quick view control lists its forms; a quick view form\'s field is its own table\'s (label + that table\'s tooltip)', async () => {
    const id = '00000000-0000-0000-0000-0000000000f2';
    const qv = 'a9c89206-0000-4000-8000-000000000073';
    const params = `<parameters><ControlMode>Edit</ControlMode><QuickForms>&lt;QuickFormIds&gt;&lt;QuickFormId entityname="new_dxtlinked"&gt;${qv.toUpperCase()}&lt;/QuickFormId&gt;&lt;/QuickFormIds&gt;</QuickForms></parameters>`;
    const formxml =
      '<form><tabs><tab id="{A1}" name="t"><labels><label description="General" languagecode="1033" /></labels><columns><column width="100%"><sections><section id="{S1}" name="s"><labels><label description="Info" languagecode="1033" /></labels><rows><row>' +
      `<cell id="{C1}"><labels><label description="Linked details" languagecode="1033" /></labels><control id="linkedqv" classid="{5C5600E0-1D6E-4205-A272-BE80DA87FD42}" datafieldname="new_linkedid">${params}</control></cell>` +
      '<cell id="{C2}"><labels><label description="Name" languagecode="1033" /></labels><control id="new_name" datafieldname="new_name" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" /></cell>' +
      '</row></rows></section></sections></column></columns></tab></tabs></form>';
    const row = { formid: id, formxml, iscustomizable: { Value: true }, ismanaged: false };
    const http = {
      all: async () => [],
      batch: async (parts: Array<{ url: string }>) =>
        parts.map((p) => ({ ok: true, status: 200, headers: {}, data: p.url.startsWith('systemforms') ? { value: [row] } : { DisplayName: { UserLocalizedLabel: { LanguageCode: EN } } } })),
    };
    const ctx = { base: EN, user: EN, langs: [{ lcid: EN, name: 'English', isBase: true }], http } as unknown as Parameters<typeof loadFormXml>[0];
    const slots = await loadFormXml(ctx, [{ formId: id, entity: 'new_dxttest', name: 'Information', type: 2 }], [EN], { signal: new AbortController().signal, progress() {} });
    const q = slots.find((s) => s.ref?.controlId === 'linkedqv')!;
    eq(q.ref.quickForms, [qv], 'its quick view forms, lower case');
    eq(slots.find((s) => s.ref?.controlId === 'new_name')!.ref.quickForms, undefined, 'other controls have none');
    eq(describe(mkApp(slots), q.comp).kind, 'Quick view');
    // A field of the quick view's form (another table): its label, and its own table's column description as the tooltip.
    const app = mkApp([
      S('field', `field|${qv}|q1`, 'Label', { [EN]: 'Linked name', [FR]: 'Nom lié' }, { entity: 'new_dxtlinked', ref: { formId: qv, elId: 'q1', formType: 6, area: 'body', controlId: 'new_name', datafield: 'new_name' }, group: `formxml|${qv}` }),
      S('attribute', 'attribute|new_dxtlinked.new_name', 'DisplayName', { [EN]: 'Linked name', [FR]: 'Nom lié' }, { entity: 'new_dxtlinked', ref: { entity: 'new_dxtlinked', attribute: 'new_name' } }),
      S('attribute', 'attribute|new_dxtlinked.new_name', 'Description', { [EN]: 'Name of the linked record' }, { entity: 'new_dxtlinked', ref: { entity: 'new_dxtlinked', attribute: 'new_name' } }),
      S('attribute', 'attribute|new_dxttest.new_name', 'Description', { [EN]: 'The page table\'s own column' }, { entity: 'new_dxttest', ref: { entity: 'new_dxttest', attribute: 'new_name' } }),
    ]);
    const m = describe(app, `field|${qv}|q1`);
    eq([m.kind, heads(m)], ['Field', [[`field|${qv}|q1|Label`, 'Form label'], ['attribute|new_dxtlinked.new_name|Description', 'Tooltip'], ['attribute|new_dxtlinked.new_name|DisplayName', 'Column name']]]);
    // Its label belongs to the quick view form, which every form embedding it shows: never "this form only".
    eq(m.blocks.map((b) => b.note), [
      'this quick view (on every form that shows it), instead of the column name',
      'everywhere',
      'everywhere: views, search and forms without a form label',
    ]);
  });

  test("describe: Microsoft's built-in text has a title and the note, no texts; a menu item keeps Open", () => {
    const app = mkApp();
    const txt = (v: string) => ({ nodeValue: v }) as unknown as Text;
    const nav = describe(app, 'builtin|nav|navAsyncOperations', { el: {} as Element, comp: 'builtin|nav|navAsyncOperations', kind: 'navitem', key: 'builtin|nav|navAsyncOperations|Label', role: 'nav', text: txt(' Processus  en arrière-plan ') });
    eq([nav.kind, nav.title, nav.blocks, nav.note, nav.action, nav.loading, nav.readOnly], ['Built-in', 'Processus en arrière-plan', [], BUILTIN_NOTE, 'Open', false, undefined]);
    // The Related tab (scan.ts RELATED_TAB): Open shows its menu.
    const rel = describe(app, 'builtin|tab|related', { el: {} as Element, comp: 'builtin|tab|related', kind: 'tab', key: 'builtin|tab|related|Label', role: 'nav', text: txt('Association') });
    eq([rel.kind, rel.title, rel.note, rel.action], ['Built-in', 'Association', BUILTIN_NOTE, 'Open']);
    const btn = describe(app, 'builtin|command|Mscrm.Save', { el: {} as Element, comp: 'builtin|command|Mscrm.Save', kind: 'ribbon', key: 'builtin|command|Mscrm.Save|Label', role: 'command', text: txt('Enregistrer') });
    eq([btn.title, btn.action, btn.note], ['Enregistrer', undefined, BUILTIN_NOTE], 'a button only opens its popup');
    ok(isBuiltin('builtin|command|Mscrm.Save') && !isBuiltin('navitem|f|navAudit') && !inert('builtin'), 'a live look: marked, hover, pointer, clicks open it');
  });

  test('describe field: a cell without a label of its own is titled with the column name', () => {
    const slots = fixture().map((s) => (s.key === 'field|f1|c1|Label' ? { ...s, labels: {}, title: 'name' } : s));
    const m = describe(mkApp(slots), 'field|f1|c1');
    eq(m.title, 'Account Name', 'the page shows the column name, not the control id');
    eq(heads(m), [['field|f1|c1|Label', 'Form label'], ['attribute|account.name|Description', 'Tooltip'], ['attribute|account.name|DisplayName', 'Column name']]);
  });

  test('describe field: the tooltip appears once the table is loaded', () => {
    const m = describe(mkApp(fixture().filter((s) => s.kind !== 'attribute')), 'field|f1|c1');
    eq(heads(m), [['field|f1|c1|Label', 'Form label']]);
    eq(m.loading, false);
  });

  test('describe field: a quick view bound to a lookup is a component, never a copy of the lookup field', () => {
    const app = mkApp([
      ...fixture(),
      S('attribute', 'attribute|account.primarycontactid', 'DisplayName', { [EN]: 'Primary Contact', [FR]: 'Contact principal' }, { ref: { entity: 'account', attribute: 'primarycontactid' } }),
      S('attribute', 'attribute|account.primarycontactid', 'Description', { [EN]: 'Choose the primary contact.' }, { ref: { entity: 'account', attribute: 'primarycontactid' } }),
      cell('c6', { [EN]: 'Primary Contact' }, ['Summary', 'Account information'], { controlId: 'primarycontactid', datafield: 'primarycontactid' }, 6),
      // The quick view control's datafieldname is its lookup; its control id is its own name.
      cell('c7', { [EN]: 'Contact details' }, ['Summary', 'Contacts'], { controlId: 'contactquickform', datafield: 'primarycontactid' }, 7),
    ]);
    const qv = describe(app, 'field|f1|c7');
    eq(qv.kind, 'Component');
    eq(qv.blocks, [{ key: 'field|f1|c7|Label', heading: 'Label', long: false }], 'no tooltip of the lookup, no copies');
    eq(describe(app, 'field|f1|c6').blocks[0].also, undefined, 'the lookup field does not offer its label to the quick view title');
    eq(relatedKeys(app.store, app.store.get('field|f1|c7|Label')!), [], "the lookup's tooltip doesn't recolor the quick view");
  });

  test('describe field: the title is what the page shows, the column name where the cell has no label (LIVE-FINDINGS 42)', () => {
    // c3 has only an English label; the column has a French name.
    eq(describe(mkApp(fixture(), {}, FR), 'field|f1|c3').title, 'Nom du compte', 'a French user sees the column name on the page');
    eq(describe(mkApp(), 'field|f1|c3').title, 'Account Name', 'an English user sees the English cell label');
    eq(describe(mkApp(fixture(), {}, FR), 'field|f1|c1').title, 'Nom du compte', 'its own French label');
    const plain = mkApp(fixture().map((s) => (s.key === 'attribute|account.name|DisplayName' ? { ...s, labels: { [EN]: 'Account Name' } } : s)), {}, FR);
    eq(describe(plain, 'field|f1|c3').title, 'Account Name', 'a column without a French name: the English cell label shows');
  });

  // ---- describe: grid headers, columns, values ----
  test('describe column header: Column name + Tooltip, its choices', () => {
    const app = mkApp();
    const m = describe(app, 'attribute|account.name', anchor(app, 'attribute|account.name|DisplayName', 'header'));
    eq([m.kind, m.title], ['Column', 'Account Name']);
    eq(m.blocks, [
      { key: 'attribute|account.name|DisplayName', heading: 'Column name', long: false },
      { key: 'attribute|account.name|Description', heading: 'Tooltip', long: true },
    ]);
    eq(fields(m), ['blocks', 'comp', 'icon', 'kind', 'loading', 'title']);
    eq(describe(app, 'attribute|account.statuscode').choices!.keys.length, 2, 'a choice column offers its choices');
    // A grid cell showing a value: its option is the one to focus.
    const v = describe(app, 'attribute|account.statuscode', anchor(app, 'attribute|account.statuscode|DisplayName', 'value', 'status|account.statuscode|1|Label'));
    eq([v.choices!.open, v.choices!.focus], [true, 'status|account.statuscode|1|Label']);
  });

  test('describe column: read-only says why in a few words', () => {
    const app = mkApp([
      ...fixture(),
      S('attribute', 'attribute|account.createdon', 'DisplayName', { [EN]: 'Created On', [FR]: 'Créé le' }, { readOnly: 'Managed and not customizable.', ref: { entity: 'account', attribute: 'createdon' } }),
      S('attribute', 'attribute|account.createdon', 'Description', { [EN]: 'Date created.' }, { readOnly: 'Managed and not customizable.', ref: { entity: 'account', attribute: 'createdon' } }),
    ]);
    const m = describe(app, 'attribute|account.createdon');
    eq(m.readOnly, 'Managed and not customizable');
    eq(fields(m), ['blocks', 'comp', 'icon', 'kind', 'loading', 'readOnly', 'title'], 'no alt link');
    ok(!describe(app, 'attribute|account.name').readOnly, 'editable column');
  });

  test('describe value: titled with the option, no Label block, every choice of its column open on the clicked one', () => {
    const app = mkApp();
    const k = 'status|account.statuscode|1|Label';
    const m = describe(app, 'status|account.statuscode|1', anchor(app, k, 'value', k));
    eq([m.title, m.kind, m.icon], ['Active', 'Choice', 'choice']);
    // The clicked option is shown once: as its row in Choices (no Label block above the list, no Description).
    eq(m.blocks, [], 'no Label block');
    // "Choices (2)": the column has two, the clicked one included (focused, its row highlighted).
    eq(m.choices, { keys: [k, 'status|account.statuscode|2|Label'], open: true, focus: k });
    ok(!m.readOnly);
    const other = describe(app, 'status|account.statuscode|2');
    eq([other.title, other.blocks, other.choices!.keys.length, other.choices!.focus, other.choices!.open], ['Inactive', [], 2, 'status|account.statuscode|2|Label', true], 'opened from the list: the same');
    // A field popup keeps its Form label, Tooltip and Column name, and a closed Choices list.
    const f = describe(app, 'field|f1|c4', anchor(app, 'field|f1|c4|Label', 'label'));
    eq([heads(f).map((b) => b[1]), f.choices!.open, f.choices!.focus], [['Form label', 'Tooltip', 'Column name'], false, undefined]);
  });

  test('describe value: a managed choice says why in one line', () => {
    const ro = (s: Slot): Slot => (s.kind === 'status' ? { ...s, readOnly: 'Managed and not customizable.' } : s);
    const m = describe(mkApp(fixture().map(ro)), 'status|account.statuscode|1');
    eq([m.blocks, m.readOnly], [[], 'Managed and not customizable']);
  });

  test('describe Yes/No, status: Choice', () => {
    const app = mkApp([
      ...fixture(),
      S('boolean', 'boolean|account.donotemail|1', 'Label', { [EN]: 'Do Not Allow' }, { ref: { entity: 'account', attribute: 'donotemail', value: 1 } }),
      S('state', 'state|account.statecode|0', 'Label', { [EN]: 'Active' }, { ref: { entity: 'account', attribute: 'statecode', value: 0 } }),
    ]);
    eq([describe(app, 'boolean|account.donotemail|1').kind, describe(app, 'state|account.statecode|0').kind], ['Choice', 'Choice']);
    // The only option loaded: still its row in Choices, never a Label block.
    const one = describe(app, 'state|account.statecode|0');
    eq([one.blocks, one.choices], [[], { keys: ['state|account.statecode|0|Label'], open: true, focus: 'state|account.statecode|0|Label' }], 'no other choices loaded');
  });

  // ---- describe: structure, table, navigation, process, commands ----
  test('describe tab and section: Label only', () => {
    const app = mkApp();
    const tab = describe(app, 'tab|f1|t1');
    eq([tab.kind, tab.title, tab.blocks], ['Tab', 'Summary', [{ key: 'tab|f1|t1|Label', heading: 'Label', long: false }]]);
    eq(fields(tab), ['blocks', 'comp', 'icon', 'kind', 'loading', 'title']);
    const sec = describe(app, 'section|f1|s1');
    eq([sec.kind, heads(sec)], ['Section', [['section|f1|s1|Label', 'Label']]]);
  });

  test('describe table: Name + Plural name (no Description); the clicked text comes first', () => {
    const app = mkApp();
    const m = describe(app, 'entity|account');
    eq([m.kind, heads(m)], ['Table', [['entity|account|DisplayName', 'Name'], ['entity|account|DisplayCollectionName', 'Plural name']]]);
    const p = describe(app, 'entity|account', anchor(app, 'entity|account|DisplayCollectionName', 'label'));
    eq(p.title, 'Accounts');
    eq(p.blocks[0].key, 'entity|account|DisplayCollectionName', 'one element, one slot: the plural it shows');
  });

  test("describe a built-in command built from its table's name: the button as shown, why, and the table's Name and Plural name (the clicked one first); it looks as that name does", () => {
    const app = mkApp(fixture(), {}, FR);
    const txt = (v: string) => ({ nodeValue: v }) as unknown as Text;
    const btn = (key: string, text: string, start: number, end: number): Anchor => ({
      ...anchor(app, key, 'command', key.endsWith('DisplayCollectionName') ? key : undefined),
      text: txt(text),
      part: { start, end, text: text.slice(start, end) },
    });
    const m = describe(app, 'entity|account', btn('entity|account|DisplayCollectionName', 'Exporter  Comptes', 10, 17));
    eq([m.kind, m.icon, m.title, m.note, m.action, heads(m)], [
      'Button',
      'command',
      'Exporter Comptes',
      TABLE_COMMAND_NOTE,
      undefined,
      [
        ['entity|account|DisplayCollectionName', 'Plural name'],
        ['entity|account|DisplayName', 'Name'],
      ],
    ]);
    eq(heads(describe(app, 'entity|account', btn('entity|account|DisplayName', 'Nouveau Compte', 8, 14))).map((h) => h[0]), ['entity|account|DisplayName', 'entity|account|DisplayCollectionName']);
    // From the list (no button): the table, as before.
    eq([describe(app, 'entity|account').kind, describe(app, 'entity|account').note], ['Table', undefined]);
    // Not Microsoft's grey text: the table's own look (translated; without a French name, missing).
    ok(!isBuiltin('entity|account'));
    eq(look(app, 'entity|account'), 'ok');
    const bare = mkApp(fixture().map((s) => (s.key === 'entity|account|DisplayName' ? { ...s, labels: { [EN]: 'Account' } } : s)), {}, FR);
    eq(look(bare, 'entity|account'), 'missing');
    // A managed solution's table (account, as most such buttons): its names read-only, and nothing says to translate
    // them here; only the plural read-only: the name still can be.
    const managed = (keys: string[]) => mkApp(fixture().map((s) => (keys.includes(s.key) ? { ...s, ref: { ...s.ref, managed: true } } : s)), {}, FR);
    const ro = describe(managed(['entity|account|DisplayName', 'entity|account|DisplayCollectionName']), 'entity|account', btn('entity|account|DisplayName', 'Nouveau Compte', 8, 14));
    eq([ro.note, ro.readOnly], [TABLE_COMMAND_WHY, MANAGED.replace(/\.$/, '')]);
    ok(!/here/.test(ro.note!), ro.note);
    const half = describe(managed(['entity|account|DisplayCollectionName']), 'entity|account', btn('entity|account|DisplayCollectionName', 'Exporter  Comptes', 10, 17));
    eq([half.note, half.readOnly], [TABLE_COMMAND_NOTE, undefined]);
  });

  test('describe: a clicked text the kind does not list gets a block of its own, first', () => {
    const app = mkApp();
    const m = describe(app, 'form|f1', anchor(app, 'form|f1|Description', 'label'));
    eq(heads(m), [['form|f1|Description', 'Description'], ['form|f1|Name', 'Name']]);
    eq(m.blocks[0].long, true);
    eq(heads(describe(app, 'form|f1')), [['form|f1|Name', 'Name']], 'from the list: the name only');
  });

  test('describe navigation entry showing a table plural name: Plural name of the table, Open', () => {
    const app = mkApp([
      ...fixture(),
      S('subarea', 'subarea|sm|acc', 'Title', {}, { entity: '', path: ['Sales Hub', 'Customers', 'Accounts'], readOnly: "Shows the table's plural name — translate the table instead", ref: { sitemapId: 'sm', id: 'acc', entity: 'account' } }),
    ]);
    const m = describe(app, 'entity|account', anchor(app, 'entity|account|DisplayCollectionName', 'nav'));
    eq([m.kind, m.action, heads(m)], ['Menu item', 'Open', [['entity|account|DisplayCollectionName', 'Plural name']]]);
    // The subarea itself (from the list): read-only, with its reason.
    const s = describe(app, 'subarea|sm|acc');
    eq([s.readOnly, s.kind], ["Shows the table's plural name — translate the table instead", 'Menu item']);
    eq(fields(s), ['blocks', 'comp', 'icon', 'kind', 'loading', 'readOnly', 'title'], 'no alt link');
  });

  test('describe sitemap entry: Title, Open only for areas and items', () => {
    const app = mkApp([
      S('subarea', 'subarea|sm|x', 'Title', { [EN]: 'Reports' }, { entity: '', path: ['Sales Hub', 'Tools', 'Insights'], ref: { sitemapId: 'sm', id: 'x' } }),
      S('subarea', 'subarea|sm|x', 'Description', {}, { entity: '', path: ['Sales Hub', 'Tools', 'Insights'], ref: { sitemapId: 'sm', id: 'x' } }),
      S('group', 'group|sm|g', 'Title', { [EN]: 'Tools' }, { entity: '', path: ['Sales Hub', 'Insights'], ref: { sitemapId: 'sm', id: 'g' } }),
    ]);
    const m = describe(app, 'subarea|sm|x', anchor(app, 'subarea|sm|x|Title', 'nav'));
    eq([m.kind, m.action, heads(m)], ['Menu item', 'Open', [['subarea|sm|x|Title', 'Title']]]);
    eq(describe(app, 'subarea|sm|x').action, undefined, 'from the list: no action');
    eq(describe(app, 'group|sm|g', anchor(app, 'group|sm|g|Title', 'nav')).action, undefined);
  });

  test('describe process stage and step (step with its column tooltip)', () => {
    const app = mkApp([
      ...fixture(),
      S('stage', 'stage|w|st', 'Label', { [EN]: 'Qualify' }, { path: ['Lead to Opportunity Sales Process'], ref: { workflowId: 'w', labelId: 'st' } }),
      S('step', 'step|w|sp', 'Label', { [EN]: 'Account' }, { path: ['Lead to Opportunity Sales Process', 'Qualify'], ref: { workflowId: 'w', labelId: 'sp', attribute: 'name', stageId: 'st' } }),
    ]);
    const st = describe(app, 'stage|w|st', anchor(app, 'stage|w|st|Label', 'stage'));
    eq([st.kind, st.action, heads(st)], ['Stage', 'Show stage', [['stage|w|st|Label', 'Label']]]);
    eq(describe(app, 'stage|w|st').action, undefined);
    const sp = describe(app, 'step|w|sp');
    eq([sp.kind, heads(sp)], ['Step', [['step|w|sp|Label', 'Label'], ['attribute|account.name|Description', 'Tooltip']]], 'no Column name');
    eq(sp.choices, undefined, 'a column without choices');
  });

  test('describe process stage: Show stage only for a stage with steps (its flyout shows fields), also while its flyout is open', () => {
    const st = (id: string) => S('stage', `stage|w|${id}`, 'Label', { [EN]: id }, { ref: { workflowId: 'w', labelId: id } });
    const sp = (id: string, stageId?: string, wf = 'w') =>
      S('step', `step|${wf}|${id}`, 'Label', { [EN]: id }, { ref: { workflowId: wf, labelId: id, ...(stageId ? { stageId } : {}) } });
    const app = mkApp([...fixture(), st('s1'), st('s2'), sp('p1', 's1'), sp('p9', 's2', 'other')]);
    const of = (a: AppApi, id: string) => describe(a, `stage|w|${id}`, anchor(a, `stage|w|${id}|Label`, 'stage'));
    eq(of(app, 's1').action, 'Show stage');
    // Only a step of another process names it: its flyout would be empty.
    ok(!('action' in of(app, 's2')), 'no action key');
    // A process read from its xaml only: its steps name no stage, so every stage may have some.
    eq(of(mkApp([...fixture(), st('s1'), st('s2'), sp('p1')]), 's2').action, 'Show stage');
    eq(hasSteps([st('s1')], st('s1')), false);
    eq(describe(app, 'stage|w|s1').action, undefined, 'from the list: no action');
    // Its flyout is open already (Alt+click): offered all the same; pressed then, it makes no click (mode.ts runAction),
    // and a flyout that opens or closes while the popup is open changes nothing here.
    const g = '0a1b2c3d-0000-4000-8000-00000000000a';
    const withG = mkApp([...fixture(), st(g), sp('p1', g)]);
    const chip = (open: boolean): Anchor => ({
      ...anchor(withG, `stage|w|${g}|Label`, 'stage'),
      el: { ownerDocument: { querySelector: (s: string) => (open && s.includes(`processHeaderStageFlyoutContainer_${g}`) ? {} : null) } } as unknown as Element,
    });
    eq(describe(withG, `stage|w|${g}`, chip(false)).action, 'Show stage');
    eq(describe(withG, `stage|w|${g}`, chip(true)).action, 'Show stage');
  });

  test('describe: the secondary action is offered only where pressing it does something', () => {
    /** A page element with these attributes, inside a menu or not. */
    const el = (attrs: Record<string, string>, inMenu = false) =>
      ({ getAttribute: (k: string) => attrs[k] ?? null, closest: (s: string) => (inMenu && s.includes('[role="menu"]') ? {} : null) }) as unknown as Element;
    const at = (key: string, role: Role, e: Element): Anchor => ({ el: e, comp: key.slice(0, key.lastIndexOf('|')), kind: 'navitem', key, role });
    const app = mkApp([
      ...fixture(),
      S('navitem', 'navitem|f1|n1', 'Label', { [EN]: 'Connections' }, { ref: { formId: 'f1', elId: 'navConnections' } }),
      S('area', 'area|sm|a', 'Title', { [EN]: 'Sales' }, { entity: '', ref: { sitemapId: 'sm', id: 'a' } }),
      S('subarea', 'subarea|sm|x', 'Title', { [EN]: 'Reports' }, { entity: '', ref: { sitemapId: 'sm', id: 'x' } }),
    ]);
    const act = (key: string, role: Role, e: Element) => describe(app, key.slice(0, key.lastIndexOf('|')), at(key, role, e)).action;
    // A related menu item closes with its menu as soon as the popup is used: Open works through the navigation API.
    eq(act('navitem|f1|n1|Label', 'nav', el({ 'data-id': 'form-tab-relatedEntity-navConnections' }, true)), 'Open');
    eq(act('builtin|nav|navConnections|Label', 'nav', el({ 'data-id': 'form-tab-relatedEntity-navConnections' }, true)), 'Open');
    // The tab of the view it opened: Open, unless that view is the one shown.
    eq(act('builtin|nav|navConnections|Label', 'nav', el({ 'data-id': 'tablist-navConnections', 'aria-selected': 'false' })), 'Open');
    eq(act('builtin|nav|navConnections|Label', 'nav', el({ 'data-id': 'tablist-navConnections', 'aria-selected': 'true' })), undefined);
    eq(act('builtin|tab|related|Label', 'nav', el({ 'data-id': 'tablist-tab_related3b554255-7717-4d17-bb7f-9936fb1e75ca', 'aria-selected': 'true' })), 'Open', 'the Related tab: Open shows its menu');
    // An area in the area switcher's flyout: no API, and the flyout closes when the popup is used.
    eq(act('area|sm|a|Title', 'nav', el({}, true)), undefined);
    // A left-nav entry stays on the page: a click opens it.
    eq(act('subarea|sm|x|Title', 'nav', el({})), 'Open');
    // Tabs: Show tab, except on the one shown.
    eq(act('tab|f1|t1|Label', 'tab', el({ 'aria-selected': 'false', 'data-id': 'tablist-SUMMARY' })), 'Show tab');
    const shown = describe(app, 'tab|f1|t1', at('tab|f1|t1|Label', 'tab', el({ 'aria-selected': 'true' })));
    ok(!('action' in shown), 'the tab shown: no action key');
    eq(act('tab|f1|t1|Label', 'tab', el({ 'data-id': 'tablist-SUMMARY' }, true)), 'Show tab', 'a "More tabs" item (its menu closes; the tab API needs no element)');
    eq(describe(app, 'tab|f1|t1').action, undefined, 'from the list');
    eq(act('section|f1|s1|Label', 'label', el({})), undefined);
    eq(act('builtin|nav|navConnections|Label', 'tab', el({ 'data-id': 'tablist-navConnections' })), 'Show tab', 'by role, whatever the text');
    // The pure parts.
    eq(actionFor('Open', at('subarea|sm|x|Title', 'nav', {} as Element)), 'Open', 'an element that is not one (tests): kept');
    eq([navIdOf({} as Element), navIdOf(el({ 'data-id': 'tablist-x' })), navIdOf(el({ 'data-id': 'tablist-tab_related3b554255-7717-4d17-bb7f-9936fb1e75ca' }))], ['', '', '']);
    eq([navIdOf(el({ 'data-id': 'form-tab-relatedEntity-nav_new_a_b' })), navIdOf(el({ 'data-id': 'tablist-navConnections' }))], ['nav_new_a_b', 'navConnections']);
    eq([inTransient(el({}, true)), inTransient({} as Element), inTransient(el({}))], [true, false, false]);
  });

  test("describe: a selector's own label opens its list (Change area / form / view), an item of its list other than the current one switches (Open); never the same name shown elsewhere", () => {
    /** An element with these attributes, inside a menu (an item of an open list) or not. */
    const el = (attrs: Record<string, string>, inMenu = false) =>
      ({ getAttribute: (k: string) => attrs[k] ?? null, closest: (s: string) => (inMenu && s.includes('[role="menu"]') ? {} : null) }) as unknown as Element;
    const app = mkApp([
      ...fixture(),
      S('area', 'area|sm|a', 'Title', { [EN]: 'Sales' }, { entity: '', ref: { sitemapId: 'sm', id: 'a' } }),
      S('form', 'form|f2', 'Name', { [EN]: 'Information' }, { ref: { id: 'f2' } }),
      S('view', 'view|v2', 'Name', { [EN]: 'Inactive Projects' }, { ref: { id: 'v2' } }),
    ]);
    const at = (key: string, role: Role, zone: Element, sw?: Anchor['sw']): Anchor => ({ el: zone, zone, comp: key.slice(0, key.lastIndexOf('|')), kind: 'area', key, role, ...(sw ? { sw } : {}) });
    const sw = (list: 'area' | 'form' | 'view', id = ''): Anchor['sw'] => ({ list, id, opener: null, find: '', item: '' });
    const act = (key: string, role: Role, zone: Element, s?: Anchor['sw']) => describe(app, key.slice(0, key.lastIndexOf('|')), at(key, role, zone, s)).action;
    // The selectors' own labels: their list (the area switcher's Open was ambiguous there).
    eq(act('area|sm|a|Title', 'nav', el({ id: 'areaSwitcherId' }), sw('area')), 'Change area');
    eq(act('form|f2|Name', 'label', el({ 'data-id': 'form-selector' }), sw('form')), 'Change form');
    eq(act('view|v2|Name', 'label', el({ 'data-id': 'ViewSelector_v2' }), sw('view')), 'Change view');
    // Items of their lists: Open, though the list closes as the popup is used (what switching needs was kept); none on
    // the current one.
    eq(act('area|sm|a|Title', 'nav', el({ 'aria-checked': 'false' }, true), sw('area', 'a')), 'Open');
    eq(act('form|f2|Name', 'nav', el({ 'aria-checked': 'false' }, true), sw('form', 'f2')), 'Open');
    eq(act('view|v2|Name', 'nav', el({ 'aria-checked': 'false' }, true), sw('view', 'v2')), 'Open');
    eq(act('view|v2|Name', 'nav', el({ 'aria-checked': 'true' }, true), sw('view', 'v2')), undefined, 'the current view');
    eq(act('area|sm|a|Title', 'nav', el({ 'aria-checked': 'true' }, true), sw('area', 'a')), undefined, 'the current area');
    // The same names elsewhere: a form's or a view's name gets no action; an area in a menu without its id none either.
    eq(act('form|f2|Name', 'label', el({})), undefined);
    eq(act('view|v2|Name', 'label', el({}, true)), undefined);
    eq(act('area|sm|a|Title', 'nav', el({}, true)), undefined);
    eq(describe(app, 'view|v2').action, undefined, 'from the list');
    // The pure parts.
    eq([listAction(at('a|x', 'nav', el({}))), listAction(at('a|x', 'nav', el({}), sw('form'))), listAction(at('a|x', 'nav', el({ 'aria-checked': 'true' }), sw('form', 'f')))], [undefined, 'Change form', null]);
    eq(actionFor('Open', at('view|v2|Name', 'nav', el({}, true), sw('view', 'v2'))), 'Open');
    eq(actionFor('Change view', at('view|v2|Name', 'label', el({}, true), sw('view'))), 'Change view');
  });

  test('describe process name (the label above the stages): a Process with its name only, never the description', () => {
    const ref = { id: 'w', table: 'workflow', entitySet: 'workflows', column: 'name', entity: 'account' };
    const app = mkApp([
      ...fixture(),
      S('bpf', 'bpf|w', 'Name', { [EN]: 'bpf test', [FR]: 'test du processus' }, { path: ['Account'], ref }),
      S('bpf', 'bpf|w', 'Description', { [EN]: 'Qualify accounts.' }, { path: ['Account'], ref: { ...ref, column: 'description' } }),
    ]);
    const m = describe(app, 'bpf|w', anchor(app, 'bpf|w|Name', 'label'));
    eq([m.kind, m.icon, m.title, heads(m)], ['Process', 'flow', 'bpf test', [['bpf|w|Name', 'Name']]]);
  });

  test('describe step: a choice column used as a step lists its choices like its field (closed, open on the clicked value)', () => {
    const app = mkApp([
      ...fixture(),
      S('step', 'step|w|ss', 'Label', { [EN]: 'Status' }, { path: ['Lead to Opportunity Sales Process', 'Qualify'], ref: { workflowId: 'w', labelId: 'ss', attribute: 'statuscode', stageId: 'st' } }),
    ]);
    const keys = ['status|account.statuscode|1|Label', 'status|account.statuscode|2|Label'];
    // Its pill (after the step label, the value being empty) opens this popup: Choices listed, so they can open.
    eq(describe(app, 'step|w|ss').choices, { keys, open: false });
    eq(describe(app, 'step|w|ss', anchor(app, 'step|w|ss|Label', 'value', keys[1])).choices, { keys, open: true, focus: keys[1] });
    eq(heads(describe(app, 'step|w|ss')), [['step|w|ss|Label', 'Label'], ['attribute|account.statuscode|Description', 'Tooltip']], 'its texts, the choices below');
  });

  test('describe modern command: Label, Tooltip title, Tooltip text (no accessibility text or group title)', () => {
    const app = mkApp();
    const m = describe(app, 'command|b1', anchor(app, 'command|b1|Label', 'command'));
    eq([m.kind, m.title, m.icon], ['Button', 'Approve', 'command']);
    eq(m.blocks.map((b) => [b.heading, b.long]), [
      ['Label', false],
      ['Tooltip title', false],
      ['Tooltip text', true],
    ]);
    eq(fields(m), ['blocks', 'comp', 'icon', 'kind', 'loading', 'title'], 'commands have no secondary action (they can be destructive)');
    const g = describe(mkApp([S('command', 'command|g1', 'Title', { [EN]: 'More' })]), 'command|g1');
    eq([g.kind, heads(g)], ['Button group', [['command|g1|Title', 'Label']]]);
  });

  test('describe: one read-only text among editable ones keeps the popup editable', () => {
    const app = mkApp(fixture().map((s) => (s.key === 'command|b1|ToolTipDescription' ? { ...s, readOnly: 'Could not read its translations: x' } : s)));
    ok(!describe(app, 'command|b1', anchor(app, 'command|b1|Label', 'command')).readOnly);
  });

  test('describe classic button: tooltip LocLabels from the ribbon controls, else the Ribbon Workbench naming', () => {
    const rb = (id: string, labels: Record<number, string>): Slot =>
      S('ribbon', `ribbon|account|${id}`, 'Label', labels, { path: ['Account', 'Command bar (classic)'], ref: { entity: 'account', locLabelId: id }, group: 'ribbon|account' });
    const slots = [...fixture(), rb('a.Lbl', { [EN]: 'Run' }), rb('a.Tip', { [EN]: 'Run it' }), rb('a.Desc', { [EN]: 'Runs the test.' }), rb('b.Btn.LabelText', { [EN]: 'Go' }), rb('b.Btn.ToolTipTitle', { [EN]: 'Go now' })];
    const app = mkApp(slots);
    useRibbonControls(app, new Map([['account', new Map([['a.Button', { id: 'a.Button', labelText: '$LocLabels:a.Lbl', toolTipTitle: '$LocLabels:a.Tip', toolTipDescription: '$LocLabels:a.Desc', alt: '$Resources:Alt' }]])]]));
    const m = describe(app, 'ribbon|account|a.Lbl');
    eq(m.kind, 'Button');
    eq(heads(m), [
      ['ribbon|account|a.Lbl|Label', 'Label'],
      ['ribbon|account|a.Tip|Label', 'Tooltip title'],
      ['ribbon|account|a.Desc|Label', 'Tooltip text'],
    ]);
    eq(m.blocks[2].long, true);
    eq(heads(describe(app, 'ribbon|account|b.Btn.LabelText')), [
      ['ribbon|account|b.Btn.LabelText|Label', 'Label'],
      ['ribbon|account|b.Btn.ToolTipTitle|Label', 'Tooltip title'],
    ]);
    eq(heads(describe(mkApp(slots), 'ribbon|account|a.Lbl')), [['ribbon|account|a.Lbl|Label', 'Label']], 'unknown control: label only');
    // An application ribbon label on a table's button: its tooltip LocLabel is looked up in the button's table first.
    const app2 = mkApp([
      ...slots,
      S('ribbon', 'ribbon|_app|c.Lbl', 'Label', { [EN]: 'Export' }, { entity: '', ref: { entity: '_app', locLabelId: 'c.Lbl' } }),
      rb('c.Tip', { [EN]: 'Export the list' }),
    ]);
    useRibbonControls(app2, new Map([['account', new Map([['c.Button', { id: 'c.Button', labelText: '$LocLabels:c.Lbl', toolTipTitle: '$LocLabels:c.Tip' }]])]]));
    const btn = { closest: () => ({ getAttribute: () => 'account|NoRelationship|Form|c.Button-Large' }) } as unknown as Element;
    const a2: Anchor = { el: btn, comp: 'ribbon|_app|c.Lbl', kind: 'ribbon', key: 'ribbon|_app|c.Lbl|Label', role: 'command' };
    eq(heads(describe(app2, 'ribbon|_app|c.Lbl', a2)), [
      ['ribbon|_app|c.Lbl|Label', 'Label'],
      ['ribbon|account|c.Tip|Label', 'Tooltip title'],
    ]);
  });

  test('describe records and the not-loaded state', () => {
    const app = mkApp([
      ...fixture(),
      S('view', 'view|v1', 'Name', { [EN]: 'Active Accounts' }, { path: ['Account'] }),
      S('view', 'view|v1', 'Description', {}, { path: ['Account'] }),
    ]);
    const v = describe(app, 'view|v1');
    eq([v.kind, heads(v)], ['View', [['view|v1|Name', 'Name']]]);
    eq(describe(app, 'form|f1').kind, 'Form');
    const n = describe(app, 'command|nope');
    eq([n.loading, n.kind, n.blocks.length, n.title], [true, 'Button', 0, '']);
  });

  // ---- looks (inspector/status.ts) ----
  test('look: ok, missing, na, ro and the base language', () => {
    const app = mkApp();
    eq(look(app, 'field|f1|c1'), 'ok');
    eq(look(app, 'section|f1|s1'), 'ok', 'the same text as English is a translation');
    eq(look(app, 'tab|f1|t1'), 'na', 'French tab label not loaded');
    eq(look(app, 'field|f1|c5'), 'missing');
    eq(look(app, 'nothing|here'), 'na');
    eq(look(mkApp(fixture(), { target: EN }), 'field|f1|c5'), 'ok', 'translating into the base language');
    const ro = mkApp(fixture().map((s) => (s.comp === 'field|f1|c5' ? { ...s, readOnly: 'Managed and not customizable' } : s)));
    eq(look(ro, 'field|f1|c5'), 'ro');
  });

  test("look: a locked form cell without a French label looks as its column's name does, which its popup lets you translate", () => {
    const lock = (id: string) => (s: Slot): Slot => (s.comp === `field|f1|${id}` ? { ...s, readOnly: 'Managed and not customizable' } : s);
    const col = (o: Partial<Slot>) => (s: Slot): Slot => (s.key === 'attribute|account.name|DisplayName' ? { ...s, ...o } : s);
    eq(look(mkApp(fixture().map(lock('c3')).map(col({ labels: { [EN]: 'Account Name' } }))), 'field|f1|c3'), 'missing', 'the column has no French name');
    eq(look(mkApp(fixture().map(lock('c3'))), 'field|f1|c3'), 'ok', "the column's French name shows");
    eq(look(mkApp(fixture().map(lock('c3')), { target: EN }), 'field|f1|c3'), 'ro', 'into the base language: its own text, locked');
    eq(look(mkApp(fixture().map(lock('c3')).map(col({ readOnly: 'Not renameable' }))), 'field|f1|c3'), 'ro', 'the column is locked too');
    eq(look(mkApp(fixture().map(lock('c3')).filter((s) => s.kind !== 'attribute')), 'field|f1|c3'), 'ro', 'the column not loaded');
    // A cell with a French label of its own keeps its own look: there in every language, built-in grey.
    eq(look(mkApp(fixture().map(lock('c1'))), 'field|f1|c1'), 'builtin');
  });

  test('look: a cell without a French label shows the French column name (LIVE-FINDINGS 42)', () => {
    const worded = cell('c10', { [EN]: 'Company name' }, ['Details', 'Billing'], { controlId: 'name1', datafield: 'name' }, 10);
    const app = mkApp([...fixture(), worded]);
    // c3 says "Account Name" like the column, whose French name "Nom du compte" is what French users see: translated.
    eq(look(app, 'field|f1|c3'), 'ok');
    // A cell worded differently shows "Nom du compte" too, which doesn't translate "Company name": still to translate.
    eq(look(app, 'field|f1|c10'), 'missing');
    const noCol = mkApp(fixture().map((s) => (s.key === 'attribute|account.name|DisplayName' ? { ...s, labels: { [EN]: 'Account Name' } } : s)));
    eq(look(noCol, 'field|f1|c3'), 'missing', 'a column without a French name: French users see English');
    eq(look(mkApp(fixture().filter((s) => s.kind !== 'attribute')), 'field|f1|c3'), 'missing', "the column's table not loaded yet");
  });

  test('look: edited (the tooltip counts for its field) and error after a failed publish', () => {
    const app = mkApp();
    app.store.set('field|f1|c3|Label', FR, 'Nom');
    eq(look(app, 'field|f1|c3'), 'edited');
    app.store.set('attribute|account.name|Description', FR, 'Tapez le nom');
    eq(look(app, 'field|f1|c1'), 'edited', 'tooltip typed, not published');
    app.store.revert('attribute|account.name|Description');
    const [c] = app.store.changes((s) => s.key === 'field|f1|c3|Label');
    app.store.commit([{ change: c, outcome: 'error', message: 'x' }]);
    eq(look(app, 'field|f1|c3'), 'error');
    app.store.set('field|f1|c1|Label', FR, 'Nom 2');
    const [c1] = app.store.changes((s) => s.key === 'field|f1|c1|Label');
    app.store.commit([{ change: c1, outcome: 'conflict', server: 'Nom (serveur)' }]);
    eq(look(app, 'field|f1|c1'), 'error', 'a conflict');
  });

  test('relatedKeys: a field and a step carry their column texts', () => {
    const app = mkApp();
    eq(relatedKeys(app.store, app.store.get('field|f1|c1|Label')!), ['attribute|account.name|Description', 'attribute|account.name|DisplayName']);
    eq(relatedKeys(app.store, app.store.get('field|f1|c5|Label')!), []);
  });

  // ---- groups, items, title ----
  test('groupOf: the list groups', () => {
    const g = (k: Kind) => groupOf(S(k, `${k}|x`, 'Label', {}));
    eq((['field', 'tab', 'section', 'navitem', 'dfield', 'relationship'] as Kind[]).map(g), ['Form', 'Form', 'Form', 'Form', 'Form', 'Form']);
    eq((['option', 'status', 'state', 'boolean', 'globaloption'] as Kind[]).map(g), ['Choices', 'Choices', 'Choices', 'Choices', 'Choices']);
    eq((['command', 'ribbon'] as Kind[]).map(g), ['Command bar', 'Command bar']);
    eq((['area', 'group', 'subarea', 'app'] as Kind[]).map(g), ['Navigation', 'Navigation', 'Navigation', 'Navigation']);
    eq((['bpf', 'stage', 'step'] as Kind[]).map(g), ['Process', 'Process', 'Process']);
    eq((['entity', 'attribute', 'view', 'chart', 'form', 'dashboard'] as Kind[]).map(g), ['Table and views', 'Table and views', 'Table and views', 'Table and views', 'Table and views', 'Table and views']);
    eq((['dtab', 'dsection', 'globaloptionset', 'envvar', 'customapi'] as Kind[]).map(g), ['Form', 'Form', 'Choices', 'Table and views', 'Table and views']);
  });

  test('look: a field, a staged command, a tab not loaded in the target language, a missing cell', () => {
    const app = mkApp();
    app.store.set('command|b1|Label', FR, 'Approuver !');
    eq(['field|f1|c1', 'command|b1', 'tab|f1|t1', 'field|f1|c5'].map((c) => look(app, c)), ['ok', 'edited', 'na', 'missing']);
  });

  test('pageTitle: record, list, dashboard, unknown', () => {
    const app = mkApp([...fixture(), S('view', 'view|v1', 'Name', { [EN]: 'Active Accounts' })]);
    eq(pageTitle(app, { info: { type: 'entityrecord' }, entity: 'account', formId: 'f1', viewId: '' }), 'Account · Information');
    eq(pageTitle(app, { info: { type: 'entitylist' }, entity: 'account', formId: '', viewId: 'v1' }), 'Accounts · Active Accounts');
    eq(pageTitle(app, { info: { type: 'dashboard' }, entity: '', formId: 'd1', viewId: '' }), 'Dashboard');
    eq(pageTitle(app, null), '');
  });
}
