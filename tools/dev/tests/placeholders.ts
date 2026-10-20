// Unit tests for sitemap items the app designer never named (providers/sitemap.ts `ref.placeholder`, LIVE-FINDINGS 99):
// "Nouveau groupe" above "Catégories" in the app "Model Driven 2". Loaded editable with a base-language title required,
// refused in another language alone (saver, popup, writer), amber on the page with a popup that says what naming it
// does; found on the page by its resource name (`sitemap-sitemapAreaGroup-NewGroup`) only where that can't be another
// item. Microsoft's own labels (`Group_Customers`) stay read-only, and nothing of a sitemap from a managed solution is
// ever named. The write itself: docwrites.ts. register() is called by tools/dev/unit.ts.
import { baseNameFirst, MANAGED, type Change, type Kind, type Slot } from '../../../src/core/model';
import { createSaver } from '../../../src/core/saver';
import { Store } from '../../../src/core/store';
import { describe, unnamedNote } from '../../../src/inspector/describe';
import type { PageLoader } from '../../../src/inspector/pageload';
import { buildIndex, Scanner } from '../../../src/inspector/scan';
import { look } from '../../../src/inspector/status';
import type { Anchor } from '../../../src/inspector/types';
import { loadSitemap, loadSitemapsScope } from '../../../src/providers/sitemap';
import { isMissing, problem } from '../../../src/ui/callout';
import type { AppApi } from '../../../src/ui/types';
import { El, withDom } from './fakedom';
import type { Kit } from './kit';

const EN = 1033;
const FR = 1036;
const SM = 'bbbbbbbb-0000-4000-8000-000000000095';
const APP_UID = 'aaaaaaaa-0000-4000-8000-000000000095';

const SYS = "Microsoft's own text, already shown in every installed language. To use your own name, set a title in the app designer.";
const SYS_TIP = "Microsoft's own text, already shown in every installed language. To use your own, set a title in the app designer first.";
const NAME_FIRST = 'Name this item first: its description can be translated here once it has a title.';

/** "Model Driven 2" as its sitemap reads: an area named in English, then `groups`. */
const app = (groups: string) =>
  `<SiteMap IntroducedVersion="7.0.0.0"><Area Id="area_ab12" ResourceId="SitemapDesigner.NewTitle" DescriptionResourceId="SitemapDesigner.NewTitle" ShowGroups="true" IntroducedVersion="7.0.0.0"><Titles><Title LCID="1033" Title="Area1"/></Titles>${groups}</Area></SiteMap>`;
/** A group the app designer made: its placeholder resource, Titles once named. */
const group = (id: string, titles = '', inner = '') =>
  `<Group Id="${id}" ResourceId="SitemapDesigner.NewGroup" DescriptionResourceId="SitemapDesigner.NewGroup" IntroducedVersion="7.0.0.0" IsProfile="false" ToolTipResourseId="SitemapDesigner.Unknown">${titles}${inner}</Group>`;
const titled = (en: string, fr = '') => `<Titles><Title LCID="1033" Title="${en}"/>${fr ? `<Title LCID="1036" Title="${fr}"/>` : ''}</Titles>`;
const CATEGORY = '<SubArea Id="subarea_c4" Entity="category" Client="All,Outlook,OutlookLaptopClient,OutlookWorkstationClient,Web" AvailableOffline="true" PassParams="false"/>';

const rec = (xml: string, managed = false) => ({ sitemapid: SM, sitemapname: 'Model Driven 2', sitemapnameunique: 'md2', sitemapxml: xml, ismanaged: managed });
const fakeHttp = (xml: string, managed = false) => ({
  get: async (u: string) => (u.startsWith('sitemaps/') ? { value: [rec(xml, managed)] } : rec(xml, managed)),
  all: async (u: string) =>
    u.startsWith('appmodules?')
      ? [{ appmoduleid: APP_UID, appmoduleidunique: APP_UID, name: 'Model Driven 2', uniquename: 'md2' }]
      : u.startsWith('appmodulecomponents?')
        ? [{ objectid: SM, _appmoduleidunique_value: APP_UID }]
        : [],
});
const LANGS = [
  { lcid: EN, name: 'English', isBase: true },
  { lcid: FR, name: 'French', isBase: false },
];
const ctxOf = (xml: string, managed = false) => ({ http: fakeHttp(xml, managed), user: FR, base: EN, langs: LANGS }) as never;
const lo = () => ({ signal: new AbortController().signal, progress() {} });
const load = (xml: string, managed = false): Promise<Slot[]> => loadSitemap(ctxOf(xml, managed), SM, lo());

const key = (kind: Kind, id: string, prop = 'Title') => `${kind}|${SM}|${id}|${prop}`;
const PH = key('group', 'group_62c1b167');

function mkApp(slots: Slot[]): AppApi {
  const store = new Store();
  store.add(slots);
  return { store, ctx: { base: EN, user: FR, langs: LANGS }, prefs: { target: FR, shown: [], showNames: false, dock: 'right' } } as unknown as AppApi;
}

/** Scans `body` (the app's navigation) with these slots loaded, on a list page of the app: [key, text] of each anchor. */
function scan(body: El, slots: Slot[]): { list: Array<[string, string]>; anchors: Anchor[] } {
  return withDom(body, () => {
    const map = new Map(slots.map((s) => [s.key, s]));
    const store = { slots: map, get: (k: string) => map.get(k) } as unknown as Store;
    const ld = {
      page: { info: { type: 'entitylist' }, entity: 'category', formId: '', bpfId: '', viewId: '' },
      app: { ctx: { user: FR, base: EN } },
      sitemapId: SM,
      appId: '',
      cmd: new Map(),
      ribbon: new Map(),
      queries: new Map(),
      gaveUp: new Set(),
    } as unknown as PageLoader;
    const sc = new Scanner();
    sc.full(buildIndex(store, ld, {}));
    const shows = (a: Anchor) => (a.text as unknown as { nodeValue: string } | undefined)?.nodeValue ?? '';
    return { list: sc.list.map((a) => [a.key, shows(a)] as [string, string]), anchors: sc.list };
  });
}
/** A group's heading in the navigation as UCI renders it: the data-id names its resource, the id no sitemap Id. */
const heading = (dataId: string, text: string) =>
  new El('li', { role: 'treeitem' }).add(new El('span', { 'data-id': `sitemap-sitemapAreaGroup-${dataId}`, id: `sitemap-sitemapAreaGroup-group-${Math.random().toString(16).slice(2)}` }, text));
const nav = (...items: El[]) => new El('body').add(new El('ul', { role: 'tree' }).add(...items));

export function register(t: Kit): void {
  const { test, eq, ok } = t;

  test('placeholders as loaded: a group the app designer never named gets an editable title (base language required) and says to name it before its description; Microsoft\'s own labels stay read-only, plainly; the Workbench lists the title', async () => {
    const xml = app(
      group('group_62c1b167', '', CATEGORY) +
        '<Group Id="g_ms" ResourceId="Group_Customers"><SubArea Id="nav_accts" Entity="account" ResourceId="Homepage_Accounts"/></Group>' +
        '<Group Id="g_legacy" ResourceId="SitemapDesigner.NewGroup" Title="Old"/>',
    );
    const slots = await load(xml);
    const by = new Map(slots.map((s) => [s.key, s]));
    const p = by.get(PH)!;
    eq([p.readOnly, p.baseRequired, p.labels, p.title, p.ref.placeholder, p.ref.unnamed, p.ref.resource], ['', true, {}, 'Unnamed group', true, true, 'NewGroup']);
    eq(by.get(key('group', 'group_62c1b167', 'Description'))!.readOnly, NAME_FIRST);
    eq(by.get(key('subarea', 'subarea_c4'))!.path, ['Model Driven 2', 'Area1', 'Unnamed group'], 'its items say where they are');
    eq(by.get(key('subarea', 'subarea_c4'))!.ref.plural, true, "the table's plural name, as before");
    // The area: named, its designer resource kept (the page may name it by either).
    const a = by.get(key('area', 'area_ab12'))!;
    eq([a.readOnly, a.title, a.ref.placeholder, a.ref.unnamed, a.ref.resource], ['', 'Area1', undefined, undefined, 'NewTitle']);
    // Microsoft's own labels: read-only, a reason the user can act on.
    eq([by.get(key('group', 'g_ms'))!.readOnly, by.get(key('group', 'g_ms', 'Description'))!.readOnly, by.get(key('subarea', 'nav_accts'))!.readOnly], [SYS, SYS_TIP, SYS]);
    eq([by.get(key('subarea', 'nav_accts'))!.ref.plural, by.get(key('subarea', 'nav_accts'))!.ref.resource], [undefined, 'Homepage_Accounts']);
    // A placeholder with a legacy single-language title shows that title: its own reason, never named here.
    const lg = by.get(key('group', 'g_legacy'))!;
    eq([lg.ref.placeholder, lg.readOnly], [undefined, 'Uses a single-language title attribute; set the title in the app designer first, then translate it here']);

    // The Workbench (no read-only labels asked for): the placeholder's title, not its description nor Microsoft's labels.
    const scope = await loadSitemapsScope(ctxOf(xml), { entities: [], kinds: new Set<Kind>(['area', 'group', 'subarea']) }, lo());
    const keys = scope.map((s) => s.key);
    ok(keys.includes(PH), keys.join());
    eq(keys.filter((k) => /\|(g_ms|nav_accts)\||group_62c1b167\|Description/.test(k)), []);
  });

  test('placeholders: amber until named, in every language; a title in another language alone is refused (popup, saver) until the base language has one; named, the look is a normal one', async () => {
    const slots = await load(app(group('group_62c1b167', '', CATEGORY) + group('g_named', titled('Sales'))));
    const ap = mkApp(slots);
    const { store } = ap;
    const p = store.get(PH)!;
    const comp = p.comp;
    eq(look(ap, comp), 'missing');
    eq([isMissing(store, p, EN, EN), isMissing(store, p, FR, EN)], [true, true]);
    const saver = createSaver({ base: EN, user: FR, langs: LANGS } as never, store, {} as never, () => undefined);
    const errors = (cs: Change[]) => saver.validate(cs).filter((i) => i.level === 'error').map((i) => i.message);
    const fr: Change = { slot: p, lcid: FR, before: '', after: 'Ventes' };
    store.set(p.key, FR, 'Ventes');
    eq(problem(store, p, FR, EN), `Name it in English too`);
    eq(errors([fr]), [baseNameFirst(EN)]);
    ok(baseNameFirst(EN).startsWith('Name it in English too: '), baseNameFirst(EN));
    eq(look(ap, comp), 'edited');
    // The base language named too (in the same save, or staged): fine.
    store.set(p.key, EN, 'Sales');
    eq([problem(store, p, FR, EN), isMissing(store, p, FR, EN)], ['', false]);
    eq(errors([fr]), [], 'the English name staged');
    eq(errors([{ slot: p, lcid: EN, before: '', after: 'Sales' }, fr]), []);
    // An item with a name of its own: a translation alone is fine, as always.
    const named = store.get(key('group', 'g_named'))!;
    eq(errors([{ slot: named, lcid: FR, before: '', after: 'Ventes' }]), []);
    // Saved: Store.commit puts the texts on the slot; its look is a normal one.
    store.revert(p.key);
    p.labels[EN] = 'Sales';
    eq(look(ap, comp), 'missing', 'named in English only: the French is missing, as for any label');
    p.labels[FR] = 'Ventes';
    eq(look(ap, comp), 'ok');
  });

  test("placeholders' popup: the page's text as its title, what naming it does, the Title block; from the list its own title; Microsoft's own label says why it can't be changed", async () => {
    const slots = await load(app(group('group_62c1b167', '', CATEGORY) + '<Group Id="g_ms" ResourceId="Group_Customers"/>'));
    const ap = mkApp(slots);
    const p = ap.store.get(PH)!;
    const a: Anchor = { el: {} as Element, comp: p.comp, kind: 'group', key: p.key, role: 'nav', text: { nodeValue: 'Nouveau groupe' } as Text };
    const m = describe(ap, p.comp, a);
    eq([m.kind, m.title, m.note, m.readOnly, m.action], ['Menu group', 'Nouveau groupe', unnamedNote('group', 'English'), undefined, undefined]);
    eq(m.note, "This group has no name of its own: Dynamics shows the app designer's placeholder. Name it in each language; other languages will show the English name until you translate them.");
    eq(m.blocks, [{ key: p.key, heading: 'Title', long: false, pageText: 'Nouveau groupe' }]);
    eq([describe(ap, p.comp).title, describe(ap, p.comp).note], ['Unnamed group', m.note], 'from the list');
    p.labels[EN] = 'Sales';
    eq([describe(ap, p.comp, a).note, describe(ap, p.comp, a).title], [undefined, 'Sales'], 'named: an item like any other');
    const ms = describe(ap, `group|${SM}|g_ms`);
    eq([ms.readOnly, ms.note], [SYS.replace(/\.$/, ''), undefined]);
  });

  test("placeholders of a sitemap from a managed solution: never named here. Its title is read-only with the managed reason (no amber, no naming note), the saver and the store refuse it, the Workbench leaves it out unless read-only labels are asked for; Microsoft's own labels keep their reason", async () => {
    const xml = app(group('group_62c1b167', '', CATEGORY) + '<Group Id="g_ms" ResourceId="Group_Customers"/>');
    const slots = await load(xml, true);
    const by = new Map(slots.map((x) => [x.key, x]));
    const p = by.get(PH)!;
    eq([p.readOnly, p.ref.managed, p.ref.placeholder, by.get(key('group', 'group_62c1b167', 'Description'))!.readOnly], [MANAGED, true, true, MANAGED]);
    eq([by.get(key('group', 'g_ms'))!.readOnly, by.get(key('group', 'g_ms', 'Description'))!.readOnly, by.get(key('area', 'area_ab12'))!.readOnly], [SYS, SYS_TIP, MANAGED]);
    const ap = mkApp(slots);
    eq([look(ap, p.comp), isMissing(ap.store, p, EN, EN), isMissing(ap.store, p, FR, EN)], ['ro', false, false]);
    const a: Anchor = { el: {} as Element, comp: p.comp, kind: 'group', key: p.key, role: 'nav', text: { nodeValue: 'Nouveau groupe' } as Text };
    const m = describe(ap, p.comp, a);
    eq([m.note, m.readOnly], [undefined, MANAGED.replace(/\.$/, '')]);
    ap.store.set(p.key, EN, 'Sales');
    eq(ap.store.isEdited(p.key), false, 'nothing staged');
    const saver = createSaver({ base: EN, user: FR, langs: LANGS } as never, ap.store, {} as never, () => undefined);
    const errors = (cs: Change[]) => saver.validate(cs).filter((i) => i.level === 'error').map((i) => i.message);
    eq(errors([{ slot: p, lcid: EN, before: '', after: 'Sales' }, { slot: { ...p, readOnly: '' }, lcid: FR, before: '', after: 'Ventes' }]), [`Read-only: ${MANAGED}`, `Read-only: ${MANAGED}`]);
    // The Workbench: nothing of it unless read-only labels are asked for.
    const kinds = new Set<Kind>(['area', 'group', 'subarea']);
    eq((await loadSitemapsScope(ctxOf(xml, true), { entities: [], kinds }, lo())).length, 0);
    ok((await loadSitemapsScope(ctxOf(xml, true), { entities: [], kinds, includeReadOnly: true }, lo())).some((x) => x.key === PH && x.readOnly === MANAGED));
  });

  test('placeholders on the page: a group heading named by its resource maps to the one group without titles of that resource; never when two could show it, nor onto a text another item has', async () => {
    const one = await load(app(group('group_62c1b167', '', CATEGORY)));
    // The app of the screenshot: "Nouveau groupe", its data-id naming the resource (no Id anywhere on it).
    const r = scan(nav(heading('NewGroup', 'Nouveau groupe')), one);
    eq(r.list, [[PH, 'Nouveau groupe']]);
    eq([r.anchors[0].role, r.anchors[0].comp], ['nav', `group|${SM}|group_62c1b167`]);
    // By its Id, as before.
    eq(scan(nav(heading('group_62c1b167', 'Nouveau groupe')), one).list, [[PH, 'Nouveau groupe']]);
    // Another resource, or a text that is a title of the app's sitemap (the area's): no mark.
    eq(scan(nav(heading('NewArea', 'Nouveau groupe')), one).list, []);
    eq(scan(nav(heading('NewGroup', 'Area1')), one).list, []);
    // Two groups never named: both read "NewGroup", nothing tells them apart.
    const two = await load(app(group('group_1', '', CATEGORY) + group('group_2')));
    eq(scan(nav(heading('NewGroup', 'Nouveau groupe'), heading('NewGroup', 'Nouveau groupe')), two).list, []);
    // A named group made by the designer too (its resource kept): its heading shows its name and maps by it; the
    // placeholder maps by its resource.
    const mixed = await load(app(group('g_named', titled('Sales', 'Ventes')) + group('group_62c1b167', '', CATEGORY)));
    eq(scan(nav(heading('NewGroup', 'Ventes'), heading('NewGroup', 'Nouveau groupe')), mixed).list, [
      [key('group', 'g_named'), 'Ventes'],
      [PH, 'Nouveau groupe'],
    ]);
    // ...unless the named one has no French title: it may show the placeholder in French too, so neither is guessed.
    const enOnly = await load(app(group('g_named', titled('Sales')) + group('group_62c1b167', '', CATEGORY)));
    eq(scan(nav(heading('NewGroup', 'Nouveau groupe')), enOnly).list, []);
    // Two items sharing a title (dropped from the text map): their headings are never taken for the placeholder.
    const shared = await load(app(group('g_a', titled('Sales', 'Ventes')) + group('g_b', titled('Sales', 'Ventes')) + group('group_62c1b167')));
    eq(scan(nav(heading('NewGroup', 'Ventes')), shared).list, []);
  });

  test("placeholders on the page: a name that is one item's Id and another's resource goes by the text the entry shows, never by the Id alone", async () => {
    // A group named by hand with the Id "NewGroup" next to the placeholder: the placeholder's heading reads NewGroup too.
    const VENTES = '<Group Id="NewGroup"><Titles><Title LCID="1033" Title="Sales"/><Title LCID="1036" Title="Ventes"/></Titles></Group>';
    const NG = key('group', 'NewGroup');
    const clash = await load(app(VENTES + group('group_62c1b167', '', CATEGORY)));
    eq(scan(nav(heading('NewGroup', 'Nouveau groupe')), clash).list, [[PH, 'Nouveau groupe']]);
    eq(scan(nav(heading('NewGroup', 'Ventes'), heading('NewGroup', 'Nouveau groupe')), clash).list, [
      [NG, 'Ventes'],
      [PH, 'Nouveau groupe'],
    ]);
    // A group the designer made and the user named, its heading naming its resource: its text, not the other Id.
    const named = await load(app(VENTES + group('g_named', titled('Purchases', 'Achats'))));
    eq(scan(nav(heading('NewGroup', 'Achats')), named).list, [[key('group', 'g_named'), 'Achats']]);
    // No item of that resource: the Id maps whatever the heading shows, as before.
    eq(scan(nav(heading('NewGroup', 'Autre chose')), await load(app(VENTES))).list, [[NG, 'Autre chose']]);
    // The group of that Id has no title either: what it shows is unknown, so the heading may be either one. No mark.
    const both = await load(app('<Group Id="NewGroup"/>' + group('group_62c1b167', '', CATEGORY)));
    eq(scan(nav(heading('NewGroup', 'Nouveau groupe')), both).list, []);
    // The same for navigation entries: a subarea with the Id "NewSubArea" and a placeholder subarea.
    const subs = await load(
      app(group('g_named', titled('Sales', 'Ventes'), '<SubArea Id="NewSubArea" Url="/a"><Titles><Title LCID="1033" Title="Mine"/><Title LCID="1036" Title="Le mien"/></Titles></SubArea><SubArea Id="subarea_n" ResourceId="SitemapDesigner.NewSubArea" Url="/x"/>')),
    );
    const entry = (id: string, text: string) => new El('li', { role: 'treeitem', 'data-id': `sitemap-entity-${id}` }).add(new El('span', {}, text));
    eq(scan(nav(entry('NewSubArea', 'Nouvelle sous-zone')), subs).list, [[key('subarea', 'subarea_n'), 'Nouvelle sous-zone']]);
    eq(scan(nav(entry('NewSubArea', 'Le mien')), subs).list, [[key('subarea', 'NewSubArea'), 'Le mien']]);
    // ...and one with that Id showing its table's plural name: that name decides, never the Id alone.
    const cats: Slot = { key: 'entity|category|DisplayCollectionName', kind: 'entity', prop: 'DisplayCollectionName', entity: 'category', comp: 'entity|category', group: 'entity|category', title: 'Category', path: ['Category'], sub: 'category', labels: { [EN]: 'Categories', [FR]: 'Catégories' }, readOnly: 'locked', baseRequired: true, max: 0, order: 0, ref: { entity: 'category' } };
    const plural = [...(await load(app(group('g_named', titled('Sales', 'Ventes'), '<SubArea Id="NewSubArea" Entity="category"/><SubArea Id="subarea_n" ResourceId="SitemapDesigner.NewSubArea" Url="/x"/>')))), cats];
    eq(scan(nav(entry('NewSubArea', 'Catégories')), plural).list, [[cats.key, 'Catégories']]);
    eq(scan(nav(entry('NewSubArea', 'Nouvelle sous-zone')), plural).list, [[key('subarea', 'subarea_n'), 'Nouvelle sous-zone']]);
  });

  test('placeholders on the page: a navigation entry named by its resource maps the same way (the one subarea without titles of that resource)', async () => {
    const slots = await load(app(group('g_named', titled('Sales', 'Ventes'), '<SubArea Id="subarea_n" ResourceId="SitemapDesigner.NewSubArea" Url="/x"/><SubArea Id="subarea_m" Url="/y"><Titles><Title LCID="1033" Title="Mine"/></Titles></SubArea>')));
    const entry = (id: string, text: string) => new El('li', { role: 'treeitem', 'data-id': `sitemap-entity-${id}` }).add(new El('span', {}, text));
    eq(scan(nav(entry('NewSubArea', 'Nouvelle sous-zone')), slots).list, [[key('subarea', 'subarea_n'), 'Nouvelle sous-zone']]);
    eq(scan(nav(entry('subarea_m', 'Mine')), slots).list, [[key('subarea', 'subarea_m'), 'Mine']], 'by its Id, as before');
    eq(scan(nav(entry('NewSubArea', 'Mine')), slots).list, [[key('subarea', 'subarea_m'), 'Mine']], 'a title of its own maps by that');
  });
}
