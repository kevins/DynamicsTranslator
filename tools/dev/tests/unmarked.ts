// Unit tests for labels that had no mark at all (LIVE-FINDINGS 90): the sub-fields of a composite column
// (address, full name), the timeline's title, "Form assist", Home / Recent / Pinned, a subarea that shows its table's
// plural name (read on demand), a built-in related menu item before its form is known, and texts that name nothing
// (messages, statuses, counts, placeholders), which stay unmarked. A fake DOM (fakedom.ts) and a fake form API.
import { MANAGED, type Slot } from '../../../src/core/model';
import { Store } from '../../../src/core/store';
import { BUILTIN_NOTE, describe } from '../../../src/inspector/describe';
import { PageLoader, WANT_FORM, WANT_FORM_NAME, WANT_NAMES, WANT_TABLE, WANT_VIEW_NAME } from '../../../src/inspector/pageload';
import { buildIndex, Scanner } from '../../../src/inspector/scan';
import { look } from '../../../src/inspector/status';
import type { Anchor } from '../../../src/inspector/types';
import type { AppApi } from '../../../src/ui/types';
import { El, withDom } from './fakedom';
import type { Kit } from './kit';

const EN = 1033;
const FR = 1036;
/** The account main form (the page). */
const FORM = '8448b78f-8f42-454e-8e2a-f8196b0419af';
/** Another form: a contact form in a side pane, or a form the page doesn't show. */
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000001';
const SM = 'bbbbbbbb-0000-4000-8000-000000000001';
const TIMELINE = '{06375649-C143-495E-A496-C962E5B4488E}';
const PLURAL_REASON = "Shows the table's plural name — translate the table instead";

// ---- the page as UCI renders it (LIVE-FINDINGS 90: 2026-10-16, account "DXT BPF Test", French UI) ----

/** A field container: its element id names its form (`id-<form id>-<n>-<control>-…`). */
const field = (ctl: string, label: string, form = FORM): El =>
  new El('div', { 'data-id': `${ctl}-FieldSectionItemContainer`, id: `id-${form}-3-${ctl}-FieldSectionItemContainer` }).add(
    new El('div').add(new El('label', { id: `id-${form}-3-${ctl}-field-label` }, label)),
  );
/** A sub-field of the address composite column. */
const sub = (col: string, text: string, form = FORM): El => field(`address1_composite_compositionLinkControl_${col}`, text, form);
const section = (name: string, ...kids: El[]): El => new El('section', { 'data-id': name }).add(...kids);
const pane = (...kids: El[]): El => new El('div', { 'data-id': 'pane-container-x' }).add(new El('div', { 'data-id': 'editFormRoot' }).add(...kids));
const quickCreate = (...kids: El[]): El => new El('div', { 'data-id': 'quickCreateRoot' }).add(...kids);
const navEntry = (id: string, text: string, ...kids: El[]): El => new El('li', { role: 'treeitem', 'data-id': `sitemap-entity-${id}` }).add(new El('span', {}, text), ...kids);

// ---- the lists the page is switched with (lists.ts), as UCI renders them (live 2026-10-20, French UI) ----

/** The area switcher at the bottom of the navigation: the area's initials, its title, a chevron. */
const areaSwitcher = (text: string, open = false): El =>
  new El('button', { id: 'areaSwitcherId', 'data-id': 'sitemap-areaSwitcher-expand-btn', 'aria-haspopup': 'true', 'aria-expanded': String(open), type: 'button' }).add(
    new El('span', { role: 'presentation' }, 'ZT'),
    new El('span', {}, text),
    new El('span', { class: 'symbolFont AreaSwitcher-symbol' }),
  );
/** An area of its list (no data-id: an older build's item, known by its text only). */
const areaItem = (id: string, text: string, on = false): El =>
  new El('li', { role: 'menuitemradio', 'aria-checked': String(on), title: text, ...(id ? { 'data-id': `areaswitcherflyout-${id}`, 'data-lp-id': `sitemap-areaswitcherflyout-${id}` } : {}) }).add(
    new El('span').add(...(on ? [new El('span', { class: 'symbolFont CheckMark-symbol' })] : [])),
    new El('span', { class: 'text' }, text),
  );
/** The list of areas, open: a portal under body. */
const areaList = (...items: El[]): El =>
  new El('div', { id: '__flyoutRootNode', 'data-id': '__flyoutRootNode' }).add(
    new El('div').add(new El('div', { 'data-lp-id': 'sitemap-area-switcher-flyout', role: 'presentation' }).add(new El('span', { role: 'presentation' }, 'Changer de zone'), new El('ul', { role: 'menu', 'aria-label': 'Changer de zone' }).add(...items))),
  );
/** The form selector in the record's header: the form's name a bare text node, then its chevron (`open`: its list is). */
const formSelector = (text: string, open = false): El =>
  new El('button', { id: '0', 'data-id': 'form-selector', role: 'button', 'aria-haspopup': 'menu', 'aria-expanded': String(open), 'aria-label': `Organisation, ${text}` }, text).add(
    new El('span', { class: 'fui-MenuButton__menuIcon' }).add(new El('svg')),
  );
/** A form of its list: `data-text` its name as Dynamics has it, `text` what it shows. */
const formItem = (id: string, data: string, text: string, on = false): El =>
  new El('div', { role: 'menuitemradio', name: 'form', 'data-id': 'form-selector-item-form-selector-0', 'data-text': data, 'data-value': id, 'aria-checked': String(on) }).add(new El('span').add(new El('svg')), new El('span', {}, text));
/** The list of forms, open: a Fluent v9 portal. */
const formList = (...items: El[]): El =>
  new El('div', { id: '__fluentPortalMountNode', role: 'presentation' }).add(new El('div', { 'data-id': 'form-selector-flyout', role: 'presentation', class: 'fui-MenuPopover' }).add(new El('div', { role: 'menu', class: 'fui-MenuList' }).add(...items)));
/** A list page's view selector: its name in a label span, a screen reader text, its chevron. */
const viewSelector = (id: string, text: string, open = false): El =>
  new El('h1').add(
    new El('button', { type: 'button', 'aria-label': text, 'data-id': `ViewSelector_${id}`, id: `ViewSelector_0_${id}`, 'aria-haspopup': 'true', 'aria-expanded': String(open), ...(open ? { 'aria-controls': 'id__5-menu' } : {}) }).add(
      new El('span', { class: 'ms-Button-flexContainer' }).add(
        new El('span', { class: 'ms-Button-textContainer' }).add(new El('span', { class: 'ms-Button-label', id: 'id__5' }, text)),
        new El('span', { class: 'ms-Button-screenReaderText', id: 'id__7' }, 'Ouvrir la fenêtre contextuelle pour changer de vue.'),
        new El('i', { 'data-icon-name': 'ChevronDown' }),
      ),
    ),
  );
/** A view of its list (`id` '': an item that names no view). */
const viewItem = (id: string, text: string, on = false): El =>
  new El('li', { role: 'presentation' }).add(
    new El('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(on), ...(id ? { 'data-value': id } : {}) }).add(
      new El('span').add(
        new El('i', { 'data-icon-name': on ? 'CheckMark' : '' }),
        new El('label', { class: 'ms-Label viewName' }, text),
        new El('div', { class: 'ms-TooltipHost', role: 'none' }).add(new El('i', { 'data-icon-name': 'Info', 'aria-label': 'Vue système. ' }), new El('div', { hidden: '', id: 'tooltipId' }, 'Vue système. ')),
      ),
    ),
  );
/** The list of views of the selector showing view `cur`, open (a Fluent v8 portal), then "Manage and share views". */
const viewList = (cur: string, ...items: El[]): El =>
  new El('div', { 'data-portal-element': 'true' }).add(
    new El('div', { 'data-id': `ViewSelector_${cur}-flyout`, tabindex: '-1' }).add(
      new El('div', { role: 'dialog', 'aria-label': 'Options d’affichage' }).add(
        new El('div', { id: 'id__5-menu' }).add(
          new El('ul', { role: 'menu', 'aria-label': 'Vues' }).add(...items),
          new El('ul', { role: 'menu', 'aria-label': 'Actions d’affichage' }).add(
            new El('li', { role: 'presentation' }).add(new El('button', { type: 'button', role: 'menuitem' }).add(new El('span').add(new El('span', { id: 'microsoftCommandIcon' }), new El('label', { class: 'ms-Label viewName' }, 'Gérer et partager les vues')))),
          ),
        ),
      ),
    ),
  );

export function register(t: Kit): void {
  const { test, eq, ok } = t;

  let n = 0;
  const S = (kind: string, key: string, labels: Record<number, string>, ref: Record<string, unknown>, entity = 'account', o: Partial<Slot> = {}): Slot =>
    ({ ...t.slot(kind, key, labels), kind, prop: key.slice(key.lastIndexOf('|') + 1), entity, comp: key.slice(0, key.lastIndexOf('|')), order: n++, ref, ...o }) as Slot;
  const L = (en: string, fr: string) => ({ [EN]: en, [FR]: fr });
  const cell = (id: string, ctl: string, df: string, labels: Record<number, string>, place: [string, string], more: Record<string, unknown> = {}, form = FORM, entity = 'account') =>
    S('field', `field|${form}|${id}|Label`, labels, { formId: form, elId: id, controlId: ctl, datafield: df || undefined, tabName: place[0], sectionName: place[1], area: 'body', ...more }, entity);
  const col = (c: string, labels: Record<number, string>) => {
    const [entity, attribute] = c.split('.');
    return S('attribute', `attribute|${c}|DisplayName`, labels, { entity, attribute, odataType: 'Microsoft.Dynamics.CRM.StringAttributeMetadata' }, entity);
  };
  const ADDR: [string, string] = ['SUMMARY_TAB', 'address'];
  const form = [
    S('tab', `tab|${FORM}|t1|Label`, L('Summary', 'Résumé'), { formId: FORM, tabName: 'SUMMARY_TAB' }),
    cell('c1', 'name', 'name', L('Account Name', 'Nom du compte'), ADDR),
    cell('c2', 'address1_composite', 'address1_composite', L('Address 1', 'Adresse 1'), ADDR),
  ];
  const timeline = cell('c3', 'notescontrol', '', L('Timeline', 'Chronologie'), ['SUMMARY_TAB', 'timeline'], { classid: TIMELINE });
  const columns = [
    col('account.name', L('Account Name', 'Nom du compte')),
    col('account.address1_line1', L('Address', 'Adresse')),
    col('account.address1_line2', L('Address 1: Street 2', 'Adresse 1 : Rue 2')),
    col('account.address1_city', L('City', 'Ville')),
  ];

  // ---- the page form's API: the sub-fields are controls bound to their columns; the timeline is unknown to it ----

  const SUB = 'address1_composite_compositionLinkControl_';
  const bound: Record<string, string> = { name: 'name', [`${SUB}address1_line1`]: 'address1_line1', [`${SUB}address1_line2`]: 'address1_line2', [`${SUB}address1_city`]: 'address1_city' };
  const sec = { getName: () => 'address', getParent: () => ({ getName: () => 'SUMMARY_TAB' }) };
  const xrm = {
    Page: {
      getControl: (nm: string) => {
        const c = bound[nm];
        if (!c) return null;
        return { getName: () => nm, getParent: () => sec, getAttribute: () => ({ getName: () => c, controls: { get: () => Object.keys(bound).filter((k) => bound[k] === c).map((k) => ({ getName: () => k, getParent: () => sec })) } }) };
      },
      data: { entity: { getEntityName: () => 'account' } },
      ui: {
        controls: { get: () => Object.keys(bound) },
        formSelector: { getCurrentItem: () => ({ getId: () => `{${FORM.toUpperCase()}}` }), items: { get: () => [] } },
      },
    },
  };

  /**
   * Scans `body` with these slots loaded; the anchors as [key, text, in a pane], what the scanner asked for, the index.
   * `page`: another page than the account form (a list).
   */
  const scan = (body: El, slots: Slot[], gaveUp: Iterable<string> = [], page: Record<string, unknown> = {}) =>
    withDom(body, () => {
      const map = new Map(slots.map((s) => [s.key, s]));
      const store = { slots: map, get: (k: string) => map.get(k) } as unknown as Store;
      const ld = {
        page: { info: { type: 'entityrecord' }, entity: 'account', formId: FORM, bpfId: '', viewId: '', ...page },
        app: { ctx: { user: FR, base: EN } },
        sitemapId: SM,
        appId: '',
        cmd: new Map(),
        ribbon: new Map(),
        queries: new Map(),
        gaveUp: new Set(gaveUp),
      } as unknown as PageLoader;
      const x = buildIndex(store, ld, xrm);
      const sc = new Scanner();
      sc.full(x);
      const inPane = (a: Anchor) => !!(a.el as unknown as El).closest('[data-id^="pane-container-"]');
      const shows = (a: Anchor) => (a.text as unknown as { nodeValue: string } | undefined)?.nodeValue ?? '';
      const r = { list: sc.list.map((a) => [a.key, shows(a), inPane(a)] as [string, string, boolean]), want: [...sc.want], x };
      return Object.defineProperties(r, { anchors: { value: sc.list }, parts: { value: sc.parts } }) as typeof r & { anchors: Anchor[]; parts: Map<string, string> };
    });
  const mkApp = (slots: Slot[]): AppApi => {
    const store = new Store();
    store.add(slots);
    const ctx = { base: EN, user: FR, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] };
    return { store, ctx, prefs: { target: FR, shown: [], showNames: false, dock: 'right' } } as unknown as AppApi;
  };
  const click = async (a: Anchor): Promise<string[]> => {
    const { clickLabel } = await import('../../../src/inspector/mode');
    const log: string[] = [];
    clickLabel(a, null, { move: () => void log.push('move'), open: (b) => void log.push(`open ${b.key}`) });
    return log;
  };

  test("composite sub-fields (address, full name): each label is its column's display name, only when it shows that text and the form API binds it to that column", () => {
    const addr = (...subs: El[]) => new El('body').add(section('address', field('name', 'Nom du compte'), ...subs));
    const all = () => [sub('address1_line1', 'Adresse'), sub('address1_line2', 'Adresse 1 : Rue 2'), sub('address1_city', 'Ville')];
    const r = scan(addr(...all()), [...form, ...columns]);
    eq(r.list, [
      [`field|${FORM}|c1|Label`, 'Nom du compte', false],
      ['attribute|account.address1_line1|DisplayName', 'Adresse', false],
      ['attribute|account.address1_line2|DisplayName', 'Adresse 1 : Rue 2', false],
      ['attribute|account.address1_city|DisplayName', 'Ville', false],
    ]);
    // Where each shows on the page form: its composite control's cell, whose tab opens to find it (reveal.ts).
    eq([...r.parts], ['address1_line1', 'address1_line2', 'address1_city'].map((c) => [`attribute|account.${c}`, 'address1_composite']));
    const a = r.anchors[1];
    const box = (e: Element | undefined) => (e as unknown as El | undefined)?.id;
    eq([a.role, a.focus, box(a.el), box(a.zone ?? a.el), box(a.hit)], [
      'label',
      undefined,
      `id-${FORM}-3-${SUB}address1_line1-field-label`,
      `id-${FORM}-3-${SUB}address1_line1-field-label`,
      `id-${FORM}-3-${SUB}address1_line1-FieldSectionItemContainer`,
    ]);
    // Never the first text: a label showing anything else than the column's names is not marked.
    eq(scan(addr(sub('address1_line1', 'Rue')), [...form, ...columns]).list.slice(1), []);
    // The form API binds the control to another column: not this one.
    bound[`${SUB}address1_line1`] = 'address1_line2';
    try {
      eq(scan(addr(sub('address1_line1', 'Adresse')), [...form, ...columns]).list.slice(1), []);
    } finally {
      bound[`${SUB}address1_line1`] = 'address1_line1';
    }
    // The columns not loaded yet: nothing, and the table is asked for.
    const cold = scan(addr(...all()), form);
    eq(cold.list.slice(1), []);
    ok(cold.want.includes(WANT_TABLE + 'account'), JSON.stringify(cold.want));
    // Another form's container, or quick create: never mapped onto the page's columns.
    eq(scan(addr(sub('address1_line1', 'Adresse', OTHER)), [...form, ...columns]).list.slice(1), []);
    eq(scan(new El('body').add(quickCreate(sub('address1_line1', 'Adresse'))), [...form, ...columns]).list, []);
    // A cell of the form for that very column (Street) never takes the sub-field over.
    const street = cell('c9', 'address1_line1', 'address1_line1', L('Street', 'Rue'), ['SUMMARY_TAB', 'other']);
    eq(scan(addr(sub('address1_line1', 'Adresse')), [...form, street, ...columns]).list.slice(1), [['attribute|account.address1_line1|DisplayName', 'Adresse', false]]);
    // A contact's full name in a side pane: its form names its table, whose columns are loaded with it.
    const first = field('fullname_compositionLinkControl_firstname', 'Prénom', OTHER);
    const paneForm = [cell('p1', 'fullname', 'fullname', L('Full Name', 'Nom complet'), ['general', 's1'], {}, OTHER, 'contact')];
    const firstName = col('contact.firstname', L('First Name', 'Prénom'));
    const inPane = scan(new El('body').add(pane(first)), [...form, ...paneForm, firstName]);
    eq(inPane.list, [['attribute|contact.firstname|DisplayName', 'Prénom', true]]);
    eq(inPane.parts.size, 0, "a side pane's sub-field is not on the page form");
    const away = scan(new El('body').add(pane(field('fullname_compositionLinkControl_firstname', 'Prénom', OTHER))), [...form, firstName]);
    eq(away.list, []);
    ok(away.want.includes(WANT_FORM + OTHER), JSON.stringify(away.want));
  });

  test("timeline: its title is its form cell's label, found by the control id in the title's id (the form API doesn't know the timeline)", () => {
    const title = (id = 'action_bar_header_titlenotescontrol', ...texts: string[]) => new El('h3', { id }).add(...(texts.length ? texts : ['Chronologie']).map((x) => new El('span', {}, x)));
    const wrapped = (h: El, f = FORM) => new El('body').add(section('timeline', new El('div', { 'data-id': 'notescontrol-FieldSectionItemContainer', id: `id-${f}-9-notescontrol-FieldSectionItemContainer` }).add(h)));
    const slots = [...form, timeline, ...columns];
    const r = scan(wrapped(title()), slots);
    eq(r.list, [[timeline.key, 'Chronologie', false]]);
    eq(r.anchors[0].role, 'label');
    eq(scan(new El('body').add(section('timeline', title())), slots).list, [[timeline.key, 'Chronologie', false]], 'without the field container');
    eq(scan(wrapped(title()), columns).list, [], 'the form not loaded');
    eq(scan(wrapped(title('action_bar_header_titlename', 'Nom du compte')), slots).list, [], "a column's control: its label is its container's");
    eq(scan(wrapped(title('action_bar_header_titlenothing')), slots).list, [], 'no cell of that id');
    eq(scan(wrapped(title(), OTHER), slots).list, [], 'another form');
    eq(scan(new El('body').add(quickCreate(title())), slots).list, [], 'quick create');
    // In a side pane: the cell of the pane's form, once that is loaded (it is asked for).
    const inPane = () => new El('body').add(pane(new El('div', { 'data-id': 'notescontrol-FieldSectionItemContainer', id: `id-${OTHER}-9-notescontrol-FieldSectionItemContainer` }).add(title())));
    const cold = scan(inPane(), slots);
    eq(cold.list, []);
    ok(cold.want.includes(WANT_FORM + OTHER), JSON.stringify(cold.want));
    const paneTimeline = cell('p3', 'notescontrol', '', L('Timeline', 'Chronologie'), ['general', 'timeline'], { classid: TIMELINE }, OTHER, 'contact');
    eq(scan(inPane(), [...slots, paneTimeline]).list, [[paneTimeline.key, 'Chronologie', true]]);
    const twice = cell('c4', 'notescontrol', '', L('Notes', 'Notes'), ['SUMMARY_TAB', 'other'], { classid: TIMELINE });
    eq(scan(wrapped(title()), [...slots, twice]).list, [], 'two cells of that id: which one is unknown');
    eq(scan(wrapped(title(undefined, 'Activités', 'Notes')), slots).list, [], 'two texts, neither its label');
    // Its only text worded otherwise: its label only for a cell without one in the user's language (a default shows then).
    const kb = (labels: Record<number, string>) => [...form, cell('c3', 'notescontrol', '', labels, ['SUMMARY_TAB', 'timeline'], { classid: TIMELINE }), ...columns];
    eq(scan(wrapped(title(undefined, 'Base de connaissances')), kb(L('Knowledge', 'Articles'))).list, [], 'labelled “Articles” in French: another text');
    eq(scan(wrapped(title(undefined, 'Base de connaissances')), kb({ [EN]: 'Knowledge' })).list, [[timeline.key, 'Base de connaissances', false]], 'no French label');
    eq(scan(wrapped(title(undefined, 'Chronologie')), kb(L('Timeline', 'Chronologie'))).list, [[timeline.key, 'Chronologie', false]], 'its own label');
    // Its popup: a timeline, its label alone.
    const m = describe(mkApp(slots), timeline.comp, r.anchors[0]);
    eq([m.kind, m.blocks.map((b) => [b.key, b.heading])], ['Timeline', [[timeline.key, 'Label']]]);
  });

  test('Form assist is built-in Microsoft text; a click only opens its popup', async () => {
    const assist = (...kids: El[]) => new El('button', { id: 'FormFillBar_Show_Button' }).add(...kids);
    const r = scan(new El('body').add(assist(new El('span', {}, 'Assistant de formulaires'))), form);
    eq(r.list, [['builtin|command|FormFillBar_Show_Button|Label', 'Assistant de formulaires', false]]);
    const a = r.anchors[0];
    eq([a.kind, a.role], ['ribbon', 'command']);
    eq(await click(a), ['open builtin|command|FormFillBar_Show_Button|Label']);
    eq(scan(new El('body').add(assist(new El('span', { class: 'symbolFont' }))), form).list, [], 'an icon alone: nothing to mark');
    eq(scan(new El('body').add(quickCreate(assist(new El('span', {}, 'Assistant de formulaires')))), form).list, [], 'quick create');
    const m = describe(mkApp(form), a.comp, a);
    eq([m.kind, m.title, m.note, m.action, m.blocks], ['Built-in', 'Assistant de formulaires', BUILTIN_NOTE, undefined, []]);
    // As UCI renders it now (live 2026-10-17): a data-id and no id; the same label.
    const now = new El('button', { type: 'button', class: 'fui-Button', 'data-id': 'FormFillBar_Show_Button' }, 'Assistant de formulaires');
    eq(scan(new El('body').add(now), form).list, [['builtin|command|FormFillBar_Show_Button|Label', 'Assistant de formulaires', false]]);
  });

  test('Share next to the command bar is built-in Microsoft text: every render one label; only its own id', () => {
    const share = (id: string, ...kids: El[]) => new El('button', { id }).add(...kids);
    const r = scan(new El('body').add(share('collaborationShareButton_0', new El('span', {}, 'Partager')), share('collaborationShareButton_12', new El('span', {}, 'Partager'))), form);
    eq(r.list, [
      ['builtin|command|collaborationShareButton|Label', 'Partager', false],
      ['builtin|command|collaborationShareButton|Label', 'Partager', false],
    ]);
    eq([r.anchors[0].kind, r.anchors[0].role], ['ribbon', 'command']);
    eq(scan(new El('body').add(share('collaborationShareButton_x', new El('span', {}, 'Partager'))), form).list, [], 'not its id');
    eq(scan(new El('body').add(share('collaborationShareButton_0', new El('span', { class: 'symbolFont' }))), form).list, [], 'an icon alone');
    eq(scan(new El('body').add(quickCreate(share('collaborationShareButton_0', new El('span', {}, 'Partager')))), form).list, [], 'quick create');
  });

  test("navigation: Home, Recent and Pinned are Microsoft's entries (grey); what Recent and Pinned list is never marked", () => {
    const G = '0000-4000-8000-000000000001';
    const tree = () =>
      new El('body').add(
        new El('ul', { role: 'tree' }).add(
          navEntry(`Home_8E2112DC-${G}`, 'Page d’accueil'),
          navEntry(`Recent_1A318AE1-${G}`, 'Récent', new El('ul', { role: 'group' }).add(navEntry(`Recent_1A318AE1-${G}_aaaa`, 'DXT BPF Test'))),
          // A pinned record nested under Pinned: its id looks like Pinned's own, its text is the record's name.
          navEntry(`Pinned_25F78F30-${G}`, 'Épinglé', new El('ul', { role: 'group' }).add(navEntry(`Pinned_0B0C0D0E-${G}`, 'DXT BPF Test'))),
        ),
      );
    // A subarea titled like Home never takes it over.
    const home2 = S('subarea', `subarea|${SM}|home2|Title`, L('Home', 'Page d’accueil'), { sitemapId: SM, id: 'home2' }, '');
    const r = scan(tree(), [...form, home2]);
    eq(r.list, [
      ['builtin|nav|home|Label', 'Page d’accueil', false],
      ['builtin|nav|recent|Label', 'Récent', false],
      ['builtin|nav|pinned|Label', 'Épinglé', false],
    ]);
    eq(r.anchors.map((a) => [a.kind, a.role]), [['subarea', 'nav'], ['subarea', 'nav'], ['subarea', 'nav']]);
    const m = describe(mkApp(form), 'builtin|nav|recent', r.anchors[1]);
    eq([m.kind, m.action], ['Built-in', 'Open']);
  });

  test("navigation: a subarea without titles shows its table's plural name, read on demand: no mark while it loads, grey once that failed; listed as its table once its names are in, else as itself", () => {
    const dxt = [
      S('subarea', `subarea|${SM}|dxt_sub|Title`, {}, { sitemapId: SM, id: 'dxt_sub', entity: 'new_dxttest', plural: true }, '', { readOnly: PLURAL_REASON }),
      S('subarea', `subarea|${SM}|dxt_sub|Description`, {}, { sitemapId: SM, id: 'dxt_sub', entity: 'new_dxttest', plural: true }, ''),
      S('subarea', `subarea|${SM}|all|Title`, L('All Tests', 'Tous les tests'), { sitemapId: SM, id: 'all' }, ''),
    ];
    const names = [
      S('entity', 'entity|new_dxttest|DisplayName', L('Translator Test', 'Test du traducteur'), { entity: 'new_dxttest' }, 'new_dxttest'),
      S('entity', 'entity|new_dxttest|DisplayCollectionName', L('Translator Tests', 'Tests du traducteur'), { entity: 'new_dxttest' }, 'new_dxttest'),
    ];
    const nav = () => new El('body').add(new El('ul', { role: 'tree' }).add(navEntry('dxt_sub', 'Tests du traducteur'), navEntry('all', 'Tous les tests')));
    const ALL = [`subarea|${SM}|all|Title`, 'Tous les tests', false];
    // Its table's names not loaded: no mark at all (never a passing grey one), and they are asked for.
    const r = scan(nav(), [...form, ...dxt]);
    eq(r.list, [ALL]);
    ok(r.want.includes(WANT_NAMES + 'new_dxttest'), JSON.stringify(r.want));
    // Not rendered (another area), "All labels" lists it all the same: as its own read-only row until its table's names are in.
    eq([r.x.universe.has(`subarea|${SM}|dxt_sub`), r.x.universe.has(`subarea|${SM}|all`), r.x.universe.has('entity|new_dxttest')], [true, true, false]);
    // Their read failed: the subarea itself, read-only (grey), its popup saying to translate the table.
    const failed = scan(nav(), [...form, ...dxt], [WANT_NAMES + 'new_dxttest']);
    eq(failed.list, [[`subarea|${SM}|dxt_sub|Title`, 'Tests du traducteur', false], ALL]);
    const app = mkApp([...form, ...dxt]);
    eq(look(app, `subarea|${SM}|dxt_sub`), 'ro');
    eq(describe(app, `subarea|${SM}|dxt_sub`, failed.anchors[0]).readOnly, PLURAL_REASON.replace(/[.\s]+$/, ''));
    // Loaded: the plural name, focused in the popup; nothing asked for.
    const loaded = scan(nav(), [...form, ...dxt, ...names]);
    eq(loaded.list, [['entity|new_dxttest|DisplayCollectionName', 'Tests du traducteur', false], ALL]);
    const a = loaded.anchors[0];
    eq([a.comp, a.focus, a.role], ['entity|new_dxttest', 'entity|new_dxttest|DisplayCollectionName', 'nav']);
    eq(loaded.want.filter((w) => w.startsWith(WANT_NAMES)), []);
    eq([loaded.x.universe.has('entity|new_dxttest'), loaded.x.universe.has(`subarea|${SM}|dxt_sub`)], [true, false], 'listed as its table, once');
    const off = scan(new El('body'), [...form, ...dxt, ...names]);
    eq([off.x.universe.has('entity|new_dxttest'), off.x.universe.has(`subarea|${SM}|dxt_sub`)], [true, false], 'not rendered: the same');
    // Its names loaded, but the entry shows another text (a name the page still caches, a title of its own): never the
    // table's name, the subarea itself (read-only). Its base-language plural name is that name.
    const other = scan(new El('body').add(new El('ul', { role: 'tree' }).add(navEntry('dxt_sub', 'Mes essais'))), [...form, ...dxt, ...names]);
    eq(other.list, [[`subarea|${SM}|dxt_sub|Title`, 'Mes essais', false]]);
    eq(scan(new El('body').add(new El('ul', { role: 'tree' }).add(navEntry('dxt_sub', 'Translator Tests'))), [...form, ...dxt, ...names]).list, [['entity|new_dxttest|DisplayCollectionName', 'Translator Tests', false]]);
    // A subarea showing a system label (ResourceId) is that label: grey right away, its table's names never asked for.
    const sys = [S('subarea', `subarea|${SM}|nav_accts|Title`, {}, { sitemapId: SM, id: 'nav_accts', entity: 'account' }, '', { readOnly: "System label (shown from Microsoft's language pack)" })];
    const s = scan(new El('body').add(navEntry('nav_accts', 'Comptes')), [...form, ...sys]);
    eq(s.list, [[`subarea|${SM}|nav_accts|Title`, 'Comptes', false]]);
    eq([s.want.filter((w) => w.startsWith(WANT_NAMES)), s.x.universe.has(`subarea|${SM}|nav_accts`)], [[], true]);
  });

  test("page loads: a navigation entry's table names are read once and alone; a failed read gives up until Try again and says so, a table not found quietly", async () => {
    const calls: string[] = [];
    let fail = 1;
    const plural = (e: string) => [
      S('entity', `entity|${e}|DisplayName`, L('Translator Test', 'Test du traducteur'), { entity: e }, e),
      S('entity', `entity|${e}|DisplayCollectionName`, L('Translator Tests', 'Tests du traducteur'), { entity: e }, e),
    ];
    const providers = {
      loadTables: async (_c: unknown, ts: string[], kinds: Set<string>) => {
        calls.push(`${ts.join()} ${[...kinds].join()}`);
        if (fail-- > 0) throw new Error('Network error');
        return ts.filter((e) => e !== 'gone').flatMap(plural);
      },
    };
    const mk = (store = new Store()) => new PageLoader({ ctx: { xrm: {}, user: FR, base: EN, langs: [{ lcid: EN }, { lcid: FR }] }, providers, store, lang: {} } as unknown as ConstructorParameters<typeof PageLoader>[0], () => {});
    const settle = async (ld: PageLoader, k: number) => {
      for (let i = 0; i < 100 && (calls.length < k || ld.busy.size); i++) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 5));
    };
    const W = WANT_NAMES + 'new_dxttest';
    const store = new Store();
    const ld = mk(store);
    ld.request([W, W, WANT_NAMES + 'Bad name!']);
    await settle(ld, 1);
    eq(calls, ['new_dxttest entity'], 'its names only, once');
    eq([[...ld.errors.values()], !!store.get('entity|new_dxttest|DisplayCollectionName'), ld.gaveUp.has(W)], [['Could not load the names of tables on this page. Network error'], false, true], 'failed: the bar says so, with Try again');
    ld.request([W]);
    await settle(ld, 1);
    eq(calls.length, 1, 'not asked again before Try again');
    ld.retry();
    ld.request([W]);
    await settle(ld, 2);
    eq([calls.length, !!store.get('entity|new_dxttest|DisplayCollectionName'), ld.gaveUp.has(W)], [2, true, false]);
    // Already in the store: nothing read.
    calls.length = 0;
    const again = mk(store);
    again.request([W]);
    await settle(again, 0);
    eq(calls, []);
    // A table being read for a grid reads its names too: never twice.
    const grid = mk();
    grid.request([WANT_TABLE + 'new_dxttest', W]);
    await settle(grid, 1);
    eq(calls, ['new_dxttest entity,attribute,option,status,state,boolean,globaloption']);
    // A table that isn't in the org: given up, quietly.
    calls.length = 0;
    const gone = mk();
    gone.request([WANT_NAMES + 'gone']);
    await settle(gone, 1);
    eq([calls, [...gone.errors.values()], gone.gaveUp.has(WANT_NAMES + 'gone')], [['gone entity'], [], true]);
    // Another slot of the table in the store (a Description the Workbench left): its names are still read.
    calls.length = 0;
    const part = new Store();
    part.add([S('entity', 'entity|new_x|Description', L('A table.', 'Une table.'), { entity: 'new_x' }, 'new_x')]);
    const px = mk(part);
    px.request([WANT_NAMES + 'new_x']);
    await settle(px, 1);
    eq([calls, !!part.get('entity|new_x|DisplayCollectionName')], [['new_x entity'], true]);
  });

  test("sitemap provider: ref.plural marks only a subarea that shows its table's plural name (an Entity, no titles, no system label, no legacy title)", async () => {
    const { loadSitemap } = await import('../../../src/providers/sitemap');
    const xml =
      '<SiteMap><Area Id="a"><Titles><Title LCID="1033" Title="Area"/></Titles><Group Id="g"><Titles><Title LCID="1033" Title="Group"/></Titles>' +
      '<SubArea Id="dxt_sub" Entity="new_dxttest"/>' +
      '<SubArea Id="titled" Entity="new_dxttest"><Titles><Title LCID="1033" Title="Tests"/></Titles></SubArea>' +
      '<SubArea Id="nav_accts" Entity="account" ResourceId="Homepage_Accounts"/>' +
      '<SubArea Id="web" Url="/x"><Titles><Title LCID="1033" Title="Web"/></Titles></SubArea>' +
      '<SubArea Id="legacy" Entity="new_dxttest" Title="My Tests"/>' +
      '</Group></Area></SiteMap>';
    const load = async (locked: boolean) => {
      // Sitemaps have no iscustomizable column: only ismanaged says whether one is read-only, and both reads ask for it.
      const rec = { sitemapid: SM, sitemapname: 'App', sitemapxml: xml, ismanaged: locked };
      const urls: string[] = [];
      const ctx = { user: FR, base: EN, http: { get: async (url: string) => (urls.push(url), url.startsWith('sitemaps/') ? { value: [rec] } : rec) } };
      const slots = await loadSitemap(ctx as never, SM, { progress: () => {} } as never);
      t.ok(urls.length === 2 && urls.every((u) => u.includes('ismanaged') && !u.includes('iscustomizable')), urls.join(' | '));
      return slots.filter((s) => s.kind === 'subarea' && s.prop === 'Title');
    };
    const plural = async (locked: boolean) => Object.fromEntries((await load(locked)).map((s) => [String(s.ref?.id), !!s.ref?.plural]));
    eq(await plural(false), { dxt_sub: true, titled: false, nav_accts: false, web: false, legacy: false });
    // A sitemap from a managed solution: every item read-only with the managed reason, but Microsoft's own label keeps
    // its own (its language pack); the page still shows the plural name.
    eq(await plural(true), { dxt_sub: true, titled: false, nav_accts: false, web: false, legacy: false });
    const managed = Object.fromEntries((await load(true)).map((s) => [String(s.ref?.id), [s.readOnly === MANAGED ? 'managed' : s.readOnly, s.ref?.managed]]));
    eq(managed, {
      dxt_sub: ['managed', true],
      titled: ['managed', true],
      nav_accts: ["Microsoft's own text, already shown in every installed language. To use your own name, set a title in the app designer.", true],
      web: ['managed', true],
      legacy: ['managed', true],
    });
    // Each says why it can't be translated here: the legacy title its own reason, never the plural name's.
    const why = Object.fromEntries((await load(false)).map((s) => [String(s.ref?.id), s.readOnly]));
    eq([why.dxt_sub, why.legacy], [PLURAL_REASON, 'Uses a single-language title attribute; set the title in the app designer first, then translate it here']);
  });

  test('a built-in related menu item is marked only once the form is known (a form can list and rename one)', () => {
    const item = () => new El('body').add(new El('div', { role: 'menuitem', 'data-id': 'form-tab-relatedEntity-navConnections' }).add(new El('span', {}, 'Connexions')));
    eq(scan(item(), columns).list, [], 'the form not loaded yet');
    eq(scan(item(), [...form, ...columns]).list, [['builtin|nav|navConnections|Label', 'Connexions', false]]);
  });

  test('texts that name nothing stay unmarked: messages, statuses, counts, placeholders, empty states', () => {
    const body = new El('body').add(
      new El('div', {}, '- Enregistré'),
      new El('span', {}, 'Actif pour 47 heures'),
      new El('input', { placeholder: 'Saisir une note…' }),
      new El('div', {}, 'Aucune donnée disponible'),
      new El('span', {}, '0 - 0 sur 0'),
      new El('div', { role: 'columnheader' }).add(new El('span', {}, 'Sélectionner tout')),
      new El('div', { role: 'heading' }, 'Nous n’avons rien trouvé à afficher ici'),
    );
    eq(scan(body, [...form, timeline, ...columns]).list, []);
  });

  // ---- the lists the page is switched with: areas, forms, views (lists.ts) ----

  const areas = [
    S('area', `area|${SM}|dxt_area|Title`, L('Translator Area', 'Zone du traducteur'), { sitemapId: SM, id: 'dxt_area' }, ''),
    S('area', `area|${SM}|dxt_area2|Title`, L('Settings', 'Paramètres'), { sitemapId: SM, id: 'dxt_area2' }, ''),
  ];
  const F2 = 'b053a39a-041a-4356-acef-ddf00182762b';
  const F3 = 'b52d996f-2be5-ed11-8848-0022483dd850';
  const F4 = 'a72c7955-442b-4ea4-9499-b10cd18b4256';
  const formName = (id: string, labels: Record<number, string>) => S('form', `form|${id}|Name`, labels, { id, table: 'systemform', entitySet: 'systemforms', column: 'name', entity: 'account', type: 2 });
  const forms = [formName(FORM, L('Account', 'Compte')), formName(F2, L('Information', 'Informations')), formName(F3, L('Fabrikam Organization', 'Organisation Fabrikam'))];
  const V1 = 'c0976d89-355d-4954-acfc-ade8835cbf4c';
  const V2 = '6b3e6539-38ab-406f-9aaa-192e75e9d23c';
  /** A personal view (userquery): no savedquery, so no slot ever. */
  const V3 = '0d2b9c11-0000-4000-8000-000000000003';
  const V4 = '0d2b9c11-0000-4000-8000-000000000004';
  const viewName = (id: string, labels: Record<number, string>) => S('view', `view|${id}|Name`, labels, { id, table: 'savedquery', entitySet: 'savedqueries', column: 'name', entity: 'new_project', type: 0 }, 'new_project');
  const views = [viewName(V1, L('Active Projects', 'Projets actifs')), viewName(V2, L('Inactive Projects', 'Projets inactifs')), viewName(V4, L('All Projects', 'Tous les projets'))];
  const LIST_PAGE = { info: { type: 'entitylist' }, entity: 'new_project', formId: '', viewId: V1 };
  /** An anchor's switch, without the button (compared by itself). */
  const swOf = (a: Anchor | undefined) => a?.sw && { list: a.sw.list, id: a.sw.id, find: a.sw.find, item: a.sw.item };

  test('the area switcher and its open list: each area marked, by the id its item names (its text the fallback); the switcher opens the list (Change area), an area other than the current one switches (Open)', () => {
    const sw = areaSwitcher('Zone du traducteur', true);
    const cur = areaItem('dxt_area', 'Zone du traducteur', true);
    const other = areaItem('dxt_area2', 'Paramètres');
    const old = areaItem('', 'Paramètres');
    const body = new El('body').add(new El('div', { 'data-id': 'navbar-container' }).add(new El('div', { id: 'areaSwitcherContainer', role: 'presentation' }).add(sw)), areaList(cur, other, old));
    const r = scan(body, [...form, ...areas]);
    eq(r.list, [
      [`area|${SM}|dxt_area|Title`, 'Zone du traducteur', false],
      [`area|${SM}|dxt_area|Title`, 'Zone du traducteur', false],
      [`area|${SM}|dxt_area2|Title`, 'Paramètres', false],
      [`area|${SM}|dxt_area2|Title`, 'Paramètres', false],
    ]);
    const [own, a1, a2, a3] = r.anchors;
    // The switcher: its button takes the click, and its popup opens the list.
    ok(own.zone === (sw as unknown) && own.sw?.opener === (sw as unknown));
    eq([own.role, swOf(own)], ['nav', { list: 'area', id: '', find: '#areaSwitcherId', item: '' }]);
    // The areas: the item takes the click; what Open needs is kept with them (the button, how to find the item again).
    ok(a2.zone === (other as unknown) && a2.sw?.opener === (sw as unknown));
    eq([a2.role, swOf(a2)], ['nav', { list: 'area', id: 'dxt_area2', find: '#areaSwitcherId', item: '[role="menuitemradio"][data-id="areaswitcherflyout-dxt_area2"]' }]);
    eq(swOf(a1)?.id, 'dxt_area');
    eq(a3.sw, undefined, 'an item without an id: by its text, without Open');
    // In any language it has a title in; another text with an id the store doesn't know: by that text.
    const en = scan(new El('body').add(areaList(areaItem('dxt_area2', 'Settings'), areaItem('dxt_other', 'Paramètres'))), [...form, ...areas]);
    eq(en.list, [
      [`area|${SM}|dxt_area2|Title`, 'Settings', false],
      [`area|${SM}|dxt_area2|Title`, 'Paramètres', false],
    ]);
    // Two areas titled alike: their text is no one's (the index drops a text two areas share), only their ids tell them apart.
    const twin = S('area', `area|${SM}|dxt_area3|Title`, L('Settings', 'Paramètres'), { sitemapId: SM, id: 'dxt_area3' }, '');
    const twins = scan(new El('body').add(areaList(areaItem('dxt_area2', 'Paramètres'), areaItem('dxt_area3', 'Paramètres'))), [...form, ...areas, twin]);
    eq(twins.list, [
      [`area|${SM}|dxt_area2|Title`, 'Paramètres', false],
      [`area|${SM}|dxt_area3|Title`, 'Paramètres', false],
    ]);
    eq(scan(new El('body').add(areaList(areaItem('', 'Paramètres'))), [...form, ...areas, twin]).list, [], 'without an id: no guess');
    // The popups: Change area on the switcher; Open on an area that isn't the current one, none on the current one.
    const app = mkApp([...form, ...areas]);
    eq([own, a1, a2, a3].map((a) => describe(app, a.comp, a).action), ['Change area', undefined, 'Open', undefined]);
  });

  test("the form selector and its open list: each form marked by its id where it shows that form's name (loaded on demand); the selector opens the list (Change form), another form switches (Open)", () => {
    const sel = formSelector('Compte', true);
    const items = [formItem(FORM, 'Account', 'Compte', true), formItem(F2, 'Information', 'Informations'), formItem(F3, 'Fabrikam Organization', 'Contoso Organization'), formItem(F4, 'Account for Interactive experience', 'Compte pour l’expérience interactive')];
    const r = scan(new El('body').add(sel, formList(...items)), [...form, ...forms]);
    eq(r.list, [
      [`form|${FORM}|Name`, 'Compte', false],
      [`form|${FORM}|Name`, 'Compte', false],
      [`form|${F2}|Name`, 'Informations', false],
    ]);
    // A form whose text is no name of it (another text, a stale cache) is not marked; one not loaded is asked for, once.
    eq(r.want.filter((w) => w.startsWith(WANT_FORM_NAME)), [WANT_FORM_NAME + F4]);
    const [own, f1, f2] = r.anchors;
    ok(own.zone === undefined && own.el === (sel as unknown), 'its name is its own text: the button is the label and its zone');
    eq(swOf(own), { list: 'form', id: '', find: '[data-id="form-selector"]', item: '' });
    ok(f2.zone === (items[1] as unknown));
    // The form API switches it; the button that has the list open is kept (the keyboard goes back to it).
    eq([f2.role, swOf(f2)], ['nav', { list: 'form', id: F2, find: '[data-id="form-selector"]', item: '' }]);
    ok(f2.sw?.opener === (sel as unknown), "the page form's own selector");
    const app = mkApp([...form, ...forms]);
    eq([own, f1, f2].map((a) => describe(app, a.comp, a).action), ['Change form', undefined, 'Open']);
    // The same name shown elsewhere (no selector, no list): no Change form.
    eq(describe(app, `form|${FORM}`, { ...own, sw: undefined, zone: undefined }).action, undefined);
  });

  test("a list of forms another form's selector opened (a main form dialog's, a side pane's): its forms keep their marks, but none switches (Open would go to the page form behind)", () => {
    const list = () => formList(formItem(FORM, 'Account', 'Compte', true), formItem(F2, 'Information', 'Informations'));
    const app = mkApp([...form, ...forms]);
    const actions = (r: { anchors: Anchor[] }) => r.anchors.map((a) => [a.key, a.sw?.id, describe(app, a.comp, a).action]);
    const marked = [
      [`form|${FORM}|Name`, undefined, undefined],
      [`form|${F2}|Name`, undefined, undefined],
    ];
    // A main form dialog over the record (navigateTo, target 2): its own form, its own selector with the list open; the
    // page's selector closed behind it. The list is a portal under body: nothing in it says which selector opened it.
    const dialog = new El('div', { role: 'dialog' }).add(new El('div', { 'data-id': 'tablist-SUMMARY_TAB' }), formSelector('Compte', true));
    const inDialog = scan(new El('body').add(formSelector('Compte'), dialog, list()), [...form, ...forms]);
    eq(inDialog.anchors.filter((a) => a.sw && !a.sw.id).length, 1, "the page's selector keeps its Change form; the dialog's is not marked");
    eq(actions({ anchors: inDialog.anchors.filter((a) => !a.sw || a.sw.id) }), marked);
    // A side pane's form selector, its list open.
    eq(actions(scan(new El('body').add(pane(formSelector('Compte', true)), list()), [...form, ...forms])), marked);
    // No selector says its list is open (it re-rendered, or none is on the page): no Open either.
    eq(actions(scan(new El('body').add(formSelector('Compte'), list()), [...form, ...forms])).slice(1), marked);
  });

  test('a list page\'s view selector and its open list: each view marked by its id where it shows that view\'s name; never a personal view, "Manage and share views", or the list as a whole', () => {
    const sel = viewSelector(V1, 'Projets actifs', true);
    const list = viewList(V1, viewItem(V1, 'Projets actifs', true), viewItem(V2, 'Projets inactifs'), viewItem(V3, 'Mes projets'), viewItem(V4, 'Projets récents'));
    const r = scan(new El('body').add(sel, list), [...views], [], LIST_PAGE);
    eq(r.list, [
      [`view|${V1}|Name`, 'Projets actifs', false],
      [`view|${V1}|Name`, 'Projets actifs', false],
      [`view|${V2}|Name`, 'Projets inactifs', false],
    ]);
    // The personal view has no name to load: asked for once like any view (its read finds nothing), never marked.
    eq(r.want.filter((w) => w.startsWith(WANT_VIEW_NAME)), [WANT_VIEW_NAME + V3]);
    const button = sel.children[0];
    const [own, v1, v2] = r.anchors;
    ok(own.zone === (button as unknown) && own.sw?.opener === (button as unknown), 'the button takes the click, beside the text the list opens');
    eq(swOf(own), { list: 'view', id: '', find: `button[data-id="ViewSelector_${V1}"]`, item: '' });
    ok(v2.sw?.opener === (button as unknown), 'the button that has the list open');
    eq([v2.role, swOf(v2)], ['nav', { list: 'view', id: V2, find: `button[data-id="ViewSelector_${V1}"]`, item: `[role="menuitemradio"][data-value="${V2}"]` }]);
    ok(r.anchors.every((a) => !(a.hit as unknown as El | undefined)?.matches?.('[data-id$="-flyout"]')), 'nothing is anchored to the list itself');
    // Its current view without an id: the list's first text that reads like the page's view is not marked through the list.
    eq(scan(new El('body').add(viewList(V1, viewItem('', 'Projets actifs', true))), views, [], LIST_PAGE).list, []);
    const app = mkApp(views);
    eq([own, v1, v2].map((a) => describe(app, a.comp, a).action), ['Change view', undefined, 'Open']);
  });

  test("a view selector off the list page (a sub-grid's, an associated grid's) with the live button: the view its id names, its button takes the click and opens its list (Change view)", () => {
    const sel = viewSelector(V2, 'Projets inactifs');
    const r = scan(new El('body').add(sel), [...form, ...views]);
    eq(r.list, [[`view|${V2}|Name`, 'Projets inactifs', false]]);
    const [a] = r.anchors;
    const button = sel.children[0];
    ok(a.zone === (button as unknown) && a.sw?.opener === (button as unknown), 'the button, beside the text the list opens');
    eq(swOf(a), { list: 'view', id: '', find: `button[data-id="ViewSelector_${V2}"]`, item: '' });
    eq(describe(mkApp([...form, ...views]), a.comp, a).action, 'Change view');
  });
}
