// Unit tests for the related menu items of the form XML in a language they have no title in (LIVE-FINDINGS 80):
// the relationship text they show there, their look, placeholders and popup, and what the page loader reads for
// them. Data modelled on a customer's user form "Main Form de Contoso" (systemuser), French UI. register() is called by
// tools/dev/unit.ts.
import type { Kind, Prop, Slot } from '../../../src/core/model';
import { Store } from '../../../src/core/store';
import { describe, NAV_NOTES } from '../../../src/inspector/describe';
import { fallbackOf, menuRelationship, navKnown, navListed, navSource } from '../../../src/inspector/fallback';
import { rowState } from '../../../src/inspector/pagelist';
import { PageLoader, WANT_RELATED } from '../../../src/inspector/pageload';
import { look, relatedKeys, standsIn } from '../../../src/inspector/status';
import type { Anchor } from '../../../src/inspector/types';
import { loadFormXml } from '../../../src/providers/formxml';
import { isMissing, placeholderOf, shows } from '../../../src/ui/callout';
import type { AppApi } from '../../../src/ui/types';
import { missing } from '../../../src/workbench/grid';
import { inBook, navSources } from '../../../src/workbench/workbench';
import type { Kit } from './kit';

const EN = 1033;
const FR = 1036;
const FORM = 'f741147c-0000-4000-8000-000000000001';

/** A slot as the loaders make them (`key = ${comp}|${prop}`). */
const S = (kind: Kind, comp: string, prop: Prop, labels: Record<number, string>, o: Partial<Slot> = {}): Slot => ({
  key: `${comp}|${prop}`,
  kind,
  prop,
  entity: 'systemuser',
  comp,
  group: comp,
  title: labels[EN] || '',
  path: [],
  sub: '',
  labels,
  readOnly: '',
  baseRequired: false,
  max: 0,
  order: 0,
  ref: {},
  ...o,
});

// The form XML's items (`NavBarByRelationshipItem RelationshipName=… Id=…`, a 1033 title only) and their relationships.
const FLOW = 'contoso_flowjobsummary_User_systemuser';
const DONE = 'contoso_contoso_tasking_completedby_systemuser';
const ASSIGNED = 'contoso_contoso_tasking_assignedto_systemuser';
const SHARE = 'contoso_sharewith_User_systemuser';
/** A built-in item the form renames (one fixed GUID for every built-in item, LIVE-FINDINGS 63). */
const AUDIT = 'hardcoded_{B7196B13-6B9D-42CD-BD58-B19A3953126F}navAudit';

const navId = (rel: string): string => (rel.startsWith('hardcoded_') ? rel.slice(rel.indexOf('}') + 1) : `nav_${rel}`);
const comp = (rel: string): string => `navitem|${FORM}|${navId(rel)}`;
const key = (rel: string): string => `${comp(rel)}|Label`;
const item = (rel: string, labels: Record<number, string>): Slot =>
  S('navitem', comp(rel), 'Label', labels, { group: `formxml|${FORM}`, ref: { formId: FORM, elId: navId(rel), area: 'nav', relationship: rel } });
/** A 1:N relationship whose menu shows on the user form (systemuser is the referenced table). */
const oneToMany = (schema: string, referencing: string, menu: 'label' | 'plural' | 'none', labels: Record<number, string> = {}, referenced = 'systemuser'): Slot =>
  S('relationship', `relationship|${schema}`, 'Label', labels, {
    readOnly: menu === 'label' ? '' : menu === 'none' ? 'Not shown in the related menu' : "Uses the related table's plural name",
    ref: { schemaName: schema, type: 'OneToMany', referenced, referencing, menu },
  });
/** One side's menu of an N:N relationship. */
const manyToMany = (schema: string, e1: string, e2: string, side: 1 | 2, menu: 'label' | 'plural', labels: Record<number, string>): Slot =>
  S('relationship', `relationship|${schema}|${side}`, 'Label', labels, { ref: { schemaName: schema, type: 'ManyToMany', side, entity1: e1, entity2: e2, menu } });
const plural = (table: string, labels: Record<number, string>): Slot => S('entity', `entity|${table}`, 'DisplayCollectionName', labels, { entity: table, ref: { entity: table } });
const PLURAL_FLOW = 'entity|contoso_flowjobsummary|DisplayCollectionName';
const PLURAL_TASK = 'entity|contoso_tasking|DisplayCollectionName';

/** The user form's items as read live, their relationships and the plural names of the tables they list. */
function contoso(): Slot[] {
  return [
    item(FLOW, { [EN]: 'Flow Job Summaries' }),
    item(DONE, { [EN]: 'Taskings - completed by' }),
    item(ASSIGNED, { [EN]: 'Tasking - Assigned to' }),
    item(SHARE, { [EN]: 'Share withs' }),
    item(AUDIT, { [EN]: 'Audit History' }),
    oneToMany(FLOW, 'contoso_flowjobsummary', 'plural'),
    oneToMany(DONE, 'contoso_tasking', 'plural'),
    oneToMany(ASSIGNED, 'contoso_tasking', 'label', { [EN]: 'Taskings - Assigned to', [FR]: 'Tâches - Attribuées à' }),
    oneToMany(SHARE, 'contoso_sharewith', 'plural'),
    plural('contoso_flowjobsummary', { [EN]: 'Flow Job Summaries', [FR]: 'Résumés des flux de travail' }),
    plural('contoso_tasking', { [EN]: 'Taskings', [FR]: 'Tâches' }),
    plural('contoso_sharewith', { [EN]: 'Share withs' }),
  ];
}
/** Only what the form load brings: the items, before the table's relationships are in. */
const itemsOnly = (): Slot[] => contoso().filter((s) => s.kind === 'navitem');

function mkApp(slots: Slot[] = contoso(), user = FR): AppApi {
  const store = new Store();
  store.add(slots);
  const ctx = { base: EN, user, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] };
  return { store, ctx, prefs: { target: FR, shown: [], showNames: false, dock: 'right' } } as unknown as AppApi;
}
/** The item's label on the page, showing `text` (describe reads the anchor's text node only). */
const anchor = (rel: string, text: string): Anchor => ({ el: {} as Element, comp: comp(rel), kind: 'navitem', key: key(rel), role: 'nav', text: { nodeValue: text } as unknown as Text });
const ALL = [FLOW, DONE, ASSIGNED, SHARE, AUDIT];

export function register(t: Kit): void {
  const { test, eq, ok } = t;

  test('related menu item: the text it shows without a title of its own is its relationship\'s, per Behavior (LIVE-FINDINGS 80)', () => {
    const { store } = mkApp();
    const get = (k: string) => store.get(k);
    const src = (rel: string, st = store) => navSource((k) => st.get(k), st.get(key(rel))!)?.key ?? '';
    // UseCollectionName: the listed table's plural name; UseLabel: the menu label; a built-in item: none (language pack).
    eq(ALL.map((r) => src(r)), [PLURAL_FLOW, PLURAL_TASK, `relationship|${ASSIGNED}|Label`, 'entity|contoso_sharewith|DisplayCollectionName', '']);
    eq(ALL.map((r) => menuRelationship(get(key(r))!)), [FLOW, DONE, ASSIGNED, SHARE, ''], 'a hardcoded_… item is no relationship');
    eq(fallbackOf(get, get(key(FLOW))!)?.key, PLURAL_FLOW, 'fallbackOf: the same slot');
    // Not loaded yet (the form load comes first): nothing known.
    const early = mkApp(itemsOnly()).store;
    eq(ALL.map((r) => src(r, early)), ['', '', '', '', '']);
    // The relationship in, the table's plural name not yet: nothing either.
    eq(src(FLOW, mkApp(contoso().filter((s) => s.key !== PLURAL_FLOW)).store), '');
    // A menu that isn't shown, a relationship of another table: none.
    const none = mkApp([item(FLOW, { [EN]: 'Flow Job Summaries' }), oneToMany(FLOW, 'contoso_flowjobsummary', 'none'), plural('contoso_flowjobsummary', { [EN]: 'Flow Job Summaries' })]).store;
    eq(src(FLOW, none), '', 'DoNotDisplay');
    const other = mkApp([item(FLOW, { [EN]: 'Flow Job Summaries' }), oneToMany(FLOW, 'contoso_flowjobsummary', 'plural', {}, 'team'), plural('contoso_flowjobsummary', { [EN]: 'Flow Job Summaries' })]).store;
    eq(src(FLOW, other), '', "another table's menu");
  });

  test('related menu item: what it shows without a title is known once its relationship (and the listed plural name) is loaded', () => {
    const known = (st: Store) => ALL.map((r) => navKnown((k) => st.get(k), st.get(key(r))!));
    const listed = (st: Store) => ALL.map((r) => navListed((k) => st.get(k), st.get(key(r))!));
    // Nothing loaded: unknown, but a built-in item (language pack) is never waited for.
    const early = mkApp(itemsOnly()).store;
    eq(known(early), [false, false, false, false, true]);
    eq(listed(early), ['', '', '', '', '']);
    // The relationships in, the plural names not yet: UseLabel is known, UseCollectionName names the table to read.
    const rels = mkApp(contoso().filter((s) => s.kind !== 'entity')).store;
    eq(known(rels), [false, false, true, false, true]);
    eq(listed(rels), ['contoso_flowjobsummary', 'contoso_tasking', '', 'contoso_sharewith', '']);
    eq(known(mkApp().store), [true, true, true, true, true]);
    // A menu that isn't shown, a relationship of another table: known (the item's own title shows).
    const none = mkApp([item(FLOW, { [EN]: 'Flow Job Summaries' }), oneToMany(FLOW, 'contoso_flowjobsummary', 'none')]).store;
    eq(navKnown((k) => none.get(k), none.get(key(FLOW))!), true);
    // Any other label: known.
    eq(navKnown(() => undefined, plural('x', { [EN]: 'X' })), true);
  });

  test('related menu item: an N:N relationship shows the side whose menu is on this table\'s form; one to itself, crossed', () => {
    const SKILL = 'new_skill_systemuser';
    const SELF = 'new_systemuser_systemuser';
    const { store } = mkApp([
      item(SKILL, { [EN]: 'Skills' }),
      // Entity1's menu shows on Entity2's form, listing Entity1 records.
      manyToMany(SKILL, 'new_skill', 'systemuser', 1, 'plural', { [EN]: 'Skills (menu)' }),
      manyToMany(SKILL, 'new_skill', 'systemuser', 2, 'label', { [EN]: 'Users (menu)' }),
      manyToMany(SELF, 'systemuser', 'systemuser', 1, 'label', { [EN]: 'Self one' }),
      manyToMany(SELF, 'systemuser', 'systemuser', 2, 'label', { [EN]: 'Self two' }),
      plural('new_skill', { [EN]: 'Skills', [FR]: 'Compétences' }),
    ]);
    // The item's RelationshipName is the schema name; a self relationship's ids carry the 1 / 2 (live: '…1' showed Entity2's).
    const self = (n: 1 | 2): Slot => ({ ...item(SELF, { [EN]: n === 1 ? 'Mentors' : 'Mentees' }), ref: { formId: FORM, elId: `nav_${SELF}${n}`, area: 'nav', relationship: SELF } });
    const src = (s: Slot) => navSource((k) => store.get(k), s)?.key ?? '';
    eq([src(store.get(key(SKILL))!), src(self(1)), src(self(2))], ['entity|new_skill|DisplayCollectionName', `relationship|${SELF}|2|Label`, `relationship|${SELF}|1|Label`]);
  });

  test('form XML: a related menu item keeps its RelationshipName; a built-in one its hardcoded_… name', async () => {
    const id = '00000000-0000-0000-0000-0000000000f3';
    const formxml =
      '<form><tabs><tab id="{A1}" name="t"><labels><label description="General" languagecode="1033" /></labels><columns><column width="100%"><sections><section id="{S1}" name="s"><labels><label description="Info" languagecode="1033" /></labels><rows><row>' +
      '<cell id="{C1}"><labels><label description="Name" languagecode="1033" /></labels><control id="fullname" datafieldname="fullname" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" /></cell>' +
      '</row></rows></section></sections></column></columns></tab></tabs>' +
      '<Navigation><NavBar>' +
      `<NavBarByRelationshipItem RelationshipName="${FLOW}" Id="nav_${FLOW}" Sequence="10" Area="Details" Show="true"><Titles><Title LCID="1033" Text="Flow Job Summaries" /></Titles></NavBarByRelationshipItem>` +
      `<NavBarByRelationshipItem RelationshipName="${AUDIT}" Id="navAudit" Sequence="20" Area="Details"><Titles><Title LCID="1033" Text="Audit History" /></Titles></NavBarByRelationshipItem>` +
      '</NavBar></Navigation></form>';
    const row = { formid: id, formxml, iscustomizable: { Value: true }, ismanaged: false };
    const http = {
      all: async () => [],
      batch: async (parts: Array<{ url: string }>) =>
        parts.map((p) => ({ ok: true, status: 200, headers: {}, data: p.url.startsWith('systemforms') ? { value: [row] } : { DisplayName: { UserLocalizedLabel: { LanguageCode: EN } } } })),
    };
    const ctx = { base: EN, user: EN, langs: [{ lcid: EN, name: 'English', isBase: true }], http } as unknown as Parameters<typeof loadFormXml>[0];
    const slots = await loadFormXml(ctx, [{ formId: id, entity: 'systemuser', name: 'Main Form de Contoso', type: 2 }], [EN], { signal: new AbortController().signal, progress() {} });
    const nav = slots.filter((s) => s.kind === 'navitem');
    eq(nav.map((s) => [s.ref.elId, s.ref.relationship, s.labels]), [
      [`nav_${FLOW}`, FLOW, { [EN]: 'Flow Job Summaries' }],
      ['navAudit', AUDIT, { [EN]: 'Audit History' }],
    ]);
    eq(slots.find((s) => s.kind === 'field')!.ref.relationship, undefined, 'a cell has none');
  });

  test('related menu item: the placeholder says what shows, the relationship\'s text, never the English title unless that shows', () => {
    const { store: s } = mkApp();
    const ph = (rel: string, page?: string) => placeholderOf(s, s.get(key(rel))!, FR, EN, 'Label', 'French', page);
    eq(ALL.map((r) => ph(r)), ['Shows “Résumés des flux de travail”', 'Shows “Tâches”', 'Shows “Tâches - Attribuées à”', 'Shows “Share withs”', 'Shows “Audit History”']);
    // A built-in item: the page's own text, in the user's language (the popup passes it for that language only).
    eq(ph(AUDIT, 'Historique d’audit'), 'Shows “Historique d’audit”');
    // Before the relationships are in: the title, as before.
    const early = mkApp(itemsOnly()).store;
    eq(placeholderOf(early, early.get(key(FLOW))!, FR, EN, 'Label', 'French'), 'Shows “Flow Job Summaries”');
    // The base language shows its own title (the input has it); a French title of its own is the value, not a placeholder.
    eq(shows(s, s.get(key(FLOW))!, EN, EN), 'Flow Job Summaries');
    // The plural name typed in the popup: what French users will see.
    s.set(PLURAL_TASK, FR, 'Tâches Contoso');
    eq(ph(DONE), 'Shows “Tâches Contoso”');
  });

  test('related menu item: translated where its relationship\'s text stands for its title (same base text), else missing', () => {
    const app = mkApp();
    const { store } = app;
    const lk = (rel: string, a = app) => look(a, comp(rel));
    // "Flow Job Summaries" is the plural name's English: its French plural name is its translation. "Taskings -
    // completed by" is not "Taskings", "Tasking - Assigned to" not "Taskings - Assigned to"; "Share withs" has no
    // French plural name; the built-in item's language-pack text is unknown.
    eq(ALL.map((r) => lk(r)), ['ok', 'missing', 'missing', 'missing', 'missing']);
    eq(ALL.map((r) => standsIn(store, store.get(key(r))!, FR, EN)), ['Résumés des flux de travail', '', '', '', '']);
    // Worded like the menu label, spaces and case aside: translated.
    const like = mkApp(contoso().map((s) => (s.key === key(ASSIGNED) ? { ...s, labels: { [EN]: 'taskings -  Assigned to' } } : s)));
    eq([lk(ASSIGNED, like), standsIn(like.store, like.store.get(key(ASSIGNED))!, FR, EN)], ['ok', 'Tâches - Attribuées à']);
    // Before the relationships are in: missing, as before. With a French title of its own: translated.
    eq(lk(FLOW, mkApp(itemsOnly())), 'missing');
    eq(lk(DONE, mkApp(contoso().map((s) => (s.key === key(DONE) ? { ...s, labels: { [EN]: 'Taskings - completed by', [FR]: 'Tâches - complétées par' } } : s)))), 'ok');
    // The popup's amber, the Workbench's missing cell and the list's row say the same.
    const f = (r: string) => store.get(key(r))!;
    eq(ALL.map((r) => isMissing(store, f(r), FR, EN)), [false, true, true, true, true]);
    eq(ALL.map((r) => missing(store, f(r), FR, EN)), [false, true, true, true, true]);
    eq([FLOW, DONE].map((r) => rowState(lk(r), store.value(key(r), FR) || standsIn(store, f(r), FR, EN))), [
      { text: 'Résumés des flux de travail', cls: '' },
      { text: 'Not translated', cls: 'is-miss' },
    ]);
    // The plural name is edited from the item's popup: the item shows the change (green) until it is published.
    eq(relatedKeys(store, f(FLOW)), [PLURAL_FLOW]);
    store.set(PLURAL_FLOW, FR, 'Résumés');
    eq(lk(FLOW), 'edited');
  });

  test('related menu item popup: its title as the page shows it, its label (this form only) and the relationship\'s text below it', () => {
    const app = mkApp();
    const m = describe(app, comp(FLOW), anchor(FLOW, 'Résumés des flux de travail'));
    eq([m.kind, m.title, m.action], ['Menu item', 'Résumés des flux de travail', 'Open']);
    eq(m.blocks, [
      { key: key(FLOW), heading: 'Label', long: false, note: NAV_NOTES.label, pageText: 'Résumés des flux de travail' },
      { key: PLURAL_FLOW, heading: 'Table plural name', long: false, note: NAV_NOTES.plural },
    ]);
    eq([NAV_NOTES.label, NAV_NOTES.menu, NAV_NOTES.plural], ['this form only', 'every form without its own title', 'everywhere']);
    // UseLabel: the menu label, editable (the relationship slot), for every form without a title of its own.
    const a = describe(app, comp(ASSIGNED));
    eq([a.title, a.blocks[1]], ['Tâches - Attribuées à', { key: `relationship|${ASSIGNED}|Label`, heading: 'Menu label', long: false, note: NAV_NOTES.menu }]);
    eq(a.readOnly, undefined);
    // The page wins in the user's language: the same item showed its menu label on one load and the listed table's
    // plural name on a later one (LIVE-FINDINGS 80).
    const shown = describe(app, comp(ASSIGNED), anchor(ASSIGNED, 'Tâches'));
    eq([shown.title, shown.blocks[0].pageText, shown.blocks[1].heading], ['Tâches', 'Tâches', 'Menu label']);
    // No French plural name: the English shows.
    eq(describe(app, comp(SHARE)).title, 'Share withs');
    // An English user sees the item's own title.
    eq(describe(mkApp(contoso(), EN), comp(FLOW)).title, 'Flow Job Summaries');
    // Before the relationships are in: its label only, as before.
    eq(describe(mkApp(itemsOnly()), comp(FLOW)).blocks, [{ key: key(FLOW), heading: 'Label', long: false }]);
  });

  test('related menu item popup: a built-in item (hardcoded_…) has no relationship block; the page\'s text is its title and French placeholder', () => {
    const app = mkApp();
    const m = describe(app, comp(AUDIT), anchor(AUDIT, ' Historique  d’audit '));
    eq([m.kind, m.title, m.blocks], ['Menu item', 'Historique d’audit', [{ key: key(AUDIT), heading: 'Label', long: false, pageText: 'Historique d’audit' }]]);
    // An English user: its own title shows; nothing from the page.
    const en = describe(mkApp(contoso(), EN), comp(AUDIT), anchor(AUDIT, 'Audit History'));
    eq([en.title, en.blocks], ['Audit History', [{ key: key(AUDIT), heading: 'Label', long: false }]]);
    // Opened from the list (not on the page): today's title and placeholder.
    const list = describe(app, comp(AUDIT));
    eq([list.title, list.blocks], ['Audit History', [{ key: key(AUDIT), heading: 'Label', long: false }]]);
  });

  test('related menu item popup: what the page shows is its own text, never a staged one the preview swapped in', () => {
    // A French title staged for an item without a relationship text (not loaded here): the preview shows "Site web"
    // in place, but clearing the French input brings the page's "Flow Job Summaries" back. The scanner kept that.
    const app = mkApp(itemsOnly());
    app.store.set(key(FLOW), FR, 'Site web');
    const swapped = { ...anchor(FLOW, 'Site web'), orig: 'Flow Job Summaries' };
    const m = describe(app, comp(FLOW), swapped);
    eq([m.title, m.blocks], ['Flow Job Summaries', [{ key: key(FLOW), heading: 'Label', long: false, pageText: 'Flow Job Summaries' }]]);
    // A built-in item: its language-pack text, whatever was staged over it.
    const b = mkApp();
    b.store.set(key(AUDIT), FR, 'Mon historique');
    const audit = describe(b, comp(AUDIT), { ...anchor(AUDIT, 'Mon historique'), orig: 'Historique d’audit' });
    eq([audit.title, audit.blocks[0].pageText], ['Historique d’audit', 'Historique d’audit']);
  });

  test("page loads: a form listing related menu items without a title in some language reads its table's relationships, quietly, once", async () => {
    const calls: string[] = [];
    const rels = contoso().filter((s) => s.kind === 'relationship');
    const plurals = contoso().filter((s) => s.kind === 'entity');
    /** Loads the page's form (it lists `read`); `scanner`: the related menu shows such an item, the scanner asks too. */
    const load = async (read: Slot[], scanner: boolean) => {
      calls.length = 0;
      const store = new Store();
      const providers = {
        loadFormXml: async () => (calls.push('form'), read),
        loadRecords: async () => [],
        loadTables: async (_c: unknown, ts: string[], kinds: Set<string>) => {
          calls.push(`tables ${ts.join()} ${[...kinds].join()}`);
          return kinds.has('relationship') ? rels : plurals.filter((s) => ts.includes(s.entity));
        },
      };
      const ctx = { xrm: {}, user: FR, base: EN, langs: [{ lcid: EN }, { lcid: FR }] };
      const ld = new PageLoader({ ctx, providers, store, lang: {} } as unknown as ConstructorParameters<typeof PageLoader>[0], () => {});
      ld.page = { info: { type: 'entityrecord' } as never, sig: 's', entity: 'systemuser', formId: FORM, viewId: '', bpfId: '' };
      (ld as unknown as { form(id: string, kind: string): void }).form(FORM, 'form');
      for (let i = 0; i < 100 && (ld.busy.size || !calls.length); i++) await new Promise((r) => setTimeout(r, 5));
      if (scanner) ld.request([WANT_RELATED + 'systemuser']);
      for (let i = 0; i < 100 && ld.busy.size; i++) await new Promise((r) => setTimeout(r, 5));
      return { ld, app: { store, ctx, prefs: { target: FR } } as unknown as AppApi };
    };
    const READ = ['form', 'tables systemuser relationship', 'tables contoso_flowjobsummary,contoso_tasking,contoso_sharewith entity'];
    // Items with an English title only: the relationships and the plural names they show, behind the form; the
    // scanner asking for the same afterwards reads nothing again.
    const { ld, app } = await load(itemsOnly(), true);
    eq(calls, READ);
    eq([...ld.errors.values()], []);
    eq(look(app, comp(FLOW)), 'ok', 'the relationship text is in: translated');
    // Every item titled in every language: nothing more is read (unless the related menu shows an item, below).
    const titled = itemsOnly().map((s) => ({ ...s, labels: { [EN]: s.labels[EN], [FR]: `${s.labels[EN]} (FR)` } }));
    await load(titled, false);
    eq(calls, ['form']);
    await load(titled, true);
    eq(calls, READ);
  });

  test('page loads: a form already in the store (the Workbench read it) asks for its relationships too; a failed load again on Try again', async () => {
    const calls: string[] = [];
    const rels = contoso().filter((s) => s.kind === 'relationship');
    const plurals = contoso().filter((s) => s.kind === 'entity');
    // The form complete in every language: its read is skipped.
    const tab = S('tab', `tab|${FORM}|t1`, 'Label', { [EN]: 'General', [FR]: 'Général' }, { group: `formxml|${FORM}`, ref: { formId: FORM } });
    const store = new Store();
    store.add([tab, ...itemsOnly()]);
    let fail = 1;
    const providers = {
      loadFormXml: async () => (calls.push('form'), []),
      loadRecords: async () => [],
      loadTables: async (_c: unknown, ts: string[], kinds: Set<string>) => {
        if (!kinds.has('relationship') && !(kinds.size === 1 && kinds.has('entity'))) return [];
        calls.push(`tables ${ts.join()} ${[...kinds].join()}`);
        if (kinds.has('relationship') && fail-- > 0) throw new Error('Network error');
        return kinds.has('relationship') ? rels : plurals.filter((s) => ts.includes(s.entity));
      },
    };
    const ctx = { xrm: {}, user: FR, base: EN, langs: [{ lcid: EN }, { lcid: FR }] };
    const app = { store, ctx, providers, lang: {}, prefs: { target: FR } } as unknown as AppApi;
    const ld = new PageLoader(app as unknown as ConstructorParameters<typeof PageLoader>[0], () => {});
    ld.page = { info: { type: 'entityrecord' } as never, sig: 's', entity: 'systemuser', formId: FORM, viewId: '', bpfId: '' };
    const settle = async () => {
      for (let i = 0; i < 100 && !calls.length; i++) await new Promise((r) => setTimeout(r, 5));
      for (let i = 0; i < 100 && ld.busy.size; i++) await new Promise((r) => setTimeout(r, 5));
    };
    ld.start();
    await settle();
    // The relationships were asked for although the form was not read; that load failed, quietly.
    eq(calls, ['tables systemuser relationship']);
    eq([...ld.errors.values()], []);
    eq(look(app, comp(FLOW)), 'missing');
    calls.length = 0;
    ld.retry();
    await settle();
    eq(calls, ['tables systemuser relationship', 'tables contoso_flowjobsummary,contoso_tasking,contoso_sharewith entity']);
    eq(look(app, comp(FLOW)), 'ok', 'the relationship text is in: translated');
    // Everything known now: a new session on the same store reads nothing for the menu.
    calls.length = 0;
    const again = new PageLoader(app as unknown as ConstructorParameters<typeof PageLoader>[0], () => {});
    again.page = ld.page;
    again.start();
    for (let i = 0; i < 100 && again.busy.size; i++) await new Promise((r) => setTimeout(r, 5));
    eq(calls, []);
  });

  test('Workbench: a related menu item is unknown (never missing, never filled) until its relationship text is read behind the extraction', async () => {
    // The extraction read the forms (and the tasking table's plural name, in its scope); nothing else.
    const app = mkApp([...itemsOnly(), plural('contoso_tasking', { [EN]: 'Taskings', [FR]: 'Tâches' })]);
    const { store } = app;
    const f = (r: string) => store.get(key(r))!;
    // Fill missing (workbench/tools.ts) stages the base text only where missing() is true: never over the French that shows.
    eq(ALL.map((r) => missing(store, f(r), FR, EN)), [false, false, false, false, true]);
    const calls: string[] = [];
    const providers = {
      loadTables: async (_c: unknown, ts: string[], kinds: Set<string>) => {
        calls.push(`tables ${ts.join()} ${[...kinds].join()}`);
        return kinds.has('relationship') ? contoso().filter((s) => s.kind === 'relationship') : contoso().filter((s) => s.kind === 'entity' && ts.includes(s.entity));
      },
    };
    store.set(PLURAL_TASK, FR, 'Tâches Contoso');
    await navSources({ ...app, providers } as unknown as AppApi, new AbortController().signal);
    // The relationships of the forms' table, then only the plural names the store lacks.
    eq(calls, ['tables systemuser relationship', 'tables contoso_flowjobsummary,contoso_sharewith entity']);
    eq(store.value(PLURAL_TASK, FR), 'Tâches Contoso', 'a slot already in the store is kept, with its pending edit');
    // Now the Workbench says what the page says.
    eq(ALL.map((r) => missing(store, f(r), FR, EN)), [false, true, true, true, true]);
    // Read-only relationship texts are context only: an extraction of forms doesn't list them.
    const rel = store.get(`relationship|${FLOW}|Label`)!;
    eq([!!rel.readOnly, inBook(rel, { kinds: new Set(['navitem']), ents: new Set(['systemuser']), ro: false }, false)], [true, false]);
    // Nothing left to read: nothing asked.
    calls.length = 0;
    await navSources({ ...app, providers } as unknown as AppApi, new AbortController().signal);
    eq(calls, []);
  });
}
