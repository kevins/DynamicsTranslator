// Unit tests for cold boots (LIVE-FINDINGS 51): after the translator's cache purge and reload the form renders, but
// Xrm.Page.ui often has no controls (or no tabs) for good. Covered: the decision to open the record again
// (inspector/mode.ts coldStep, coldForm, wakeForm), fieldOf / ctlSlot with an empty form API (the DOM's section and
// tab place a control; a copy that can't be told apart gets no cell), the scan of such a page (tabs, sections and
// fields anchored from the DOM alone), and the check after a refresh, which reads what the page renders from the
// DOM (inspector/scan.ts domShown, pageShows, checkShown). No browser: fakes only.
import type { Slot } from '../../../src/core/model';
import type { Store } from '../../../src/core/store';
import { coldForm, coldStep, wakeForm, type ColdForm } from '../../../src/inspector/mode';
import type { PageLoader } from '../../../src/inspector/pageload';
import { buildIndex, checkShown, ctlSlot, domShown, fieldOf, pageShows, Scanner, type PageIndex, type Shown, type ShownField, type ShownForm, type ShownItem } from '../../../src/inspector/scan';
import { El, withDom } from './fakedom';
import type { Kit } from './kit';

const EN = 1033;
const FR = 1036;
const FORM = '01a080de-0000-4000-8000-0000000000f0';

/** A field as UCI renders it: container > div > div > div[title] > label. */
const fieldEl = (ctl: string, label: string, tip: string): El =>
  new El('div', { 'data-id': `${ctl}-FieldSectionItemContainer` }).add(
    new El('div').add(new El('div').add(new El('div', tip ? { title: tip } : {}).add(new El('label', { id: `id-1a2b-${ctl}-field-label` }, label)))),
  );
const sectionEl = (name: string, title: string, ...fields: El[]): El =>
  new El('section', { 'data-id': name }).add(new El('h2', { 'data-id': `form-sectionHeader-${name}`, title }, title), ...fields);
const tabPanel = (name: string, ...sections: El[]): El => new El('div', { role: 'tabpanel', 'data-id': `tabpanel-${name}` }).add(...sections);
const tabEl = (name: string, title: string): El => new El('li', { role: 'tab', 'data-id': `tablist-${name}`, title, 'aria-label': title }, title + title);

export function register(t: Kit): void {
  const { test, eq, ok } = t;

  // ---- the decision: open the record again, or not ----

  const cold = (o: Partial<ColdForm> = {}): ColdForm => ({ rendered: true, controls: 0, tabs: 0, dirty: false, entity: 'new_dxttest', id: 'rec-1', formId: FORM, ...o });

  test('coldStep: an empty form API is rebuilt only on a rendered, unchanged record', () => {
    eq(coldStep(cold()), 'reopen', 'no controls, no tabs');
    eq(coldStep(cold({ controls: 0, tabs: 1 })), 'reopen', 'no controls (6 of 7 purge boots)');
    eq(coldStep(cold({ controls: 257, tabs: 0 })), 'reopen', 'controls without tabs (Contoso after a clear)');
    eq(coldStep(cold({ controls: 3, tabs: 1 })), 'none', 'complete: nothing to do');
    eq(coldStep(cold({ controls: NaN, tabs: NaN })), 'none', 'no form API at all: not a cold form');
    eq(coldStep(cold({ rendered: false })), 'none', 'not drawn yet (looked at again later)');
    eq(coldStep(cold({ dirty: true })), 'skip', 'unsaved changes: never opened again');
    eq(coldStep(cold({ dirty: null })), 'skip', "can't tell whether it is dirty");
    eq(coldStep(cold({ id: '' })), 'skip', 'a create form (no record)');
    eq(coldStep(cold({ entity: '' })), 'skip', 'no table');
    eq(coldStep(cold({ formId: '' })), 'reopen', 'no form named: opened as Dynamics opened it (the loads then learn the form)');
  });

  /** A form API: getLength()s, dirty, and openForm, which fills the controls after `after` ms of the fake clock. */
  const api = (o: { controls?: number; tabs?: number; dirty?: boolean | null; after?: number; fills?: boolean; entityDirty?: boolean } = {}) => {
    const st = { controls: o.controls ?? 0, tabs: o.tabs ?? 0, dirty: o.dirty ?? false, now: 0, opened: [] as unknown[], log: [] as string[], at: Infinity };
    const xrm = {
      Page: {
        ui: { controls: { getLength: () => (st.now >= st.at ? 3 : st.controls) }, tabs: { getLength: () => (st.now >= st.at ? 1 : st.tabs) } },
        data:
          o.entityDirty === undefined
            ? { getIsDirty: () => st.dirty, entity: {} }
            : { entity: { getIsDirty: () => o.entityDirty } },
      },
      Navigation: {
        openForm: (opts: unknown) => {
          st.opened.push(opts);
          st.log.push('openForm');
          if (o.fills !== false) st.at = st.now + (o.after ?? 300);
          return Promise.resolve({ savedEntityReference: [] });
        },
      },
    };
    const sleep = async (ms: number) => {
      st.now += ms;
    };
    return { st, xrm, sleep, now: () => st.now };
  };

  test('coldForm reads the page: rendered labels, the form API counts, dirty (data, else its entity)', () => {
    const page = { entity: 'new_dxttest', formId: FORM, info: { type: 'entityrecord', recordId: 'rec-1' } };
    const root = (hit: boolean) => ({ querySelector: () => (hit ? {} : null) }) as unknown as Document;
    const a = api({ controls: 0, tabs: 1 });
    eq(coldForm(a.xrm, page, root(true)), { rendered: true, controls: 0, tabs: 1, dirty: false, entity: 'new_dxttest', id: 'rec-1', formId: FORM });
    eq(coldForm(a.xrm, page, root(false)).rendered, false, 'no field label or tab drawn yet');
    eq(coldForm(a.xrm, { ...page, info: { ...page.info, type: 'entitylist' } }, root(true)).rendered, false, 'not a record page');
    eq(coldForm(api({ entityDirty: true }).xrm, page, root(true)).dirty, true, 'Xrm.Page.data.entity.getIsDirty');
    const none = coldForm({}, page, root(true));
    ok(Number.isNaN(none.controls) && Number.isNaN(none.tabs) && none.dirty === null, 'no form API');
    eq(coldStep(none), 'none');
  });

  test('wakeForm: dirty never opens the form; non-empty does nothing', async () => {
    const d = api({ dirty: true });
    eq(await wakeForm(d.xrm, cold({ dirty: true }), { sleep: d.sleep, now: d.now }), false);
    eq(d.st.opened.length, 0, 'no openForm');
    const full = api({ controls: 3, tabs: 1 });
    eq(await wakeForm(full.xrm, cold({ controls: 3, tabs: 1 }), { sleep: full.sleep, now: full.now }), false, 'nothing to repair');
    eq(full.st.opened.length, 0);
  });

  test('wakeForm: an empty form API: openForm for the same record and form, then the scan once it has controls', async () => {
    const a = api({ after: 300 });
    const f = cold();
    const p = wakeForm(a.xrm, f, { sleep: a.sleep, now: a.now }).then((ok) => {
      // The controller scans here: the form API is complete by then.
      a.st.log.push(`scan ${ok} ${a.xrm.Page.ui.controls.getLength()}`);
      return ok;
    });
    eq(await p, true);
    eq(a.st.opened, [{ entityName: 'new_dxttest', entityId: 'rec-1', formId: FORM }]);
    eq(a.st.log, ['openForm', 'scan true 3']);
    // It waited for the form being built first (settle, 500 ms), then ~300 ms for the reopened form.
    ok(a.st.now >= 800 && a.st.now <= 900, `timing ${a.st.now}`);
    const b = api();
    eq(await wakeForm(b.xrm, cold({ formId: '' }), { sleep: b.sleep, now: b.now }), true);
    eq(b.st.opened, [{ entityName: 'new_dxttest', entityId: 'rec-1' }], 'no form id: none is passed');
  });

  test('wakeForm: a form that fills on its own (a navigation in the app) is not opened again', async () => {
    const a = api();
    a.st.at = 200; // the form API fills after 200 ms without help
    eq(await wakeForm(a.xrm, cold(), { sleep: a.sleep, now: a.now }), true);
    eq(a.st.opened.length, 0);
  });

  test('wakeForm: typed into the record while it waited: not opened; still empty after 3 s: gives up', async () => {
    const a = api();
    const sleep = async (ms: number) => {
      a.st.now += ms;
      if (a.st.now >= 300) a.st.dirty = true;
    };
    eq(await wakeForm(a.xrm, cold(), { sleep, now: a.now }), false);
    eq(a.st.opened.length, 0, 'dirty now: no openForm');
    const b = api({ fills: false });
    eq(await wakeForm(b.xrm, cold(), { sleep: b.sleep, now: b.now }), false, 'still empty');
    eq(b.st.opened.length, 1);
    ok(b.st.now >= 3500 && b.st.now <= 3600, `≤ 3 s after the settle wait (${b.st.now})`);
    const c = api();
    c.xrm.Navigation.openForm = () => {
      throw new Error('no navigation API');
    };
    eq(await wakeForm(c.xrm, cold(), { sleep: c.sleep, now: c.now }), false, 'openForm throws');
  });

  test('wakeForm: gone to another record or form while it waited: the one it was for is never opened again', async () => {
    const a = api();
    let here = true;
    const sleep = async (ms: number) => {
      a.st.now += ms;
      if (a.st.now >= 300) here = false; // a lookup clicked: record B loads, its form API still empty and not dirty
    };
    eq(await wakeForm(a.xrm, cold(), { sleep, now: a.now, still: () => here }), false);
    eq(a.st.opened.length, 0, 'no openForm: the user stays on B');
    const b = api();
    const gone = () => {
      throw new Error('Xrm.Page is being replaced');
    };
    eq(await wakeForm(b.xrm, cold(), { sleep: b.sleep, now: b.now, still: gone }), false, 'a check that fails counts as gone');
    eq(b.st.opened.length, 0);
    const c = api();
    eq(await wakeForm(c.xrm, cold(), { sleep: c.sleep, now: c.now, still: () => true }), true, 'still there: opened as before');
    eq(c.st.opened.length, 1);
  });

  // ---- fieldOf / ctlSlot with an empty form API ----

  const cell = (n: number, id: string, field: string, tab?: string, section?: string, area = 'body'): Slot =>
    ({ ...t.slot('field', `field|${FORM}|cell${n}|Label`), comp: `field|${FORM}|cell${n}`, entity: 'e', order: n, ref: { formId: FORM, controlId: id, datafield: field, tabName: tab, sectionName: section, area } }) as Slot;

  /**
   * A record page index whose form API is empty after a cold boot: getControl() gives null for every control
   * (`tabless`: the controls are there, but without their section and tab, Contoso after a clear).
   */
  const page = (cells: Slot[], o: { tabless?: Record<string, string>; main?: Map<string, Slot> } = {}): PageIndex => {
    const fields = new Map<string, Slot[]>();
    const cols = new Map<string, Slot[]>();
    for (const s of cells)
      for (const [m, k] of [
        [fields, s.ref.controlId],
        [cols, s.ref.datafield],
      ] as const)
        if (k) m.set(k.toLowerCase(), [...(m.get(k.toLowerCase()) || []), s]);
    const tl = o.tabless;
    const attr = (col: string) => ({ getName: () => col, controls: { get: () => Object.keys(tl || {}).filter((n) => tl![n] === col).map(control) } });
    const control = (name: string) => (tl?.[name] ? { getName: () => name, getParent: () => undefined, getAttribute: () => attr(tl[name]) } : null);
    const xrm = { Page: { getControl: control, ui: { controls: { get: () => [] } } } };
    return { fields, cells: cols, xrm, entity: 'e', main: o.main ?? new Map(), names: new Map(), formReady: true, record: true, formApi: !!tl } as unknown as PageIndex;
  };

  test('fieldOf, empty form API: a unique control maps to its cell where the page shows it, never elsewhere', () => {
    const cs = [cell(1, 'name', 'name', 'general', 's1'), cell(2, 'phone', 'phone', 'general', 's2')];
    const x = page(cs);
    eq(fieldOf(x, 'name', { tab: 'general', section: 's1' })?.order, 1, 'unique, placed where the form XML says');
    eq(fieldOf(x, 'Name', { tab: 'GENERAL', section: 'S1' })?.order, 1, 'names compare in any case');
    eq(fieldOf(x, 'name', { tab: 'general' })?.order, 1, 'only the tab known');
    eq(fieldOf(x, 'name', { tab: 'general', section: 's2' }), undefined, 'shown in another section (a side pane, an unpublished move): no cell');
    eq(fieldOf(x, 'name')?.order, 1, 'no place known (header strip): the name');
    eq(fieldOf(x, 'nosuch', { tab: 'general', section: 's1' }), undefined);
  });

  test('fieldOf, empty form API: copies sharing one control id map when their name and their place agree', () => {
    // A column placed three times, the same id in every cell (LIVE-FINDINGS 41), one copy per section.
    const cs = [cell(1, 'owner', 'owner', 'memo', 'client'), cell(2, 'owner', 'owner', 'reco', 'r1'), cell(3, 'owner', 'owner', 'general', 'g1')];
    const x = page(cs);
    eq(
      [
        ['owner', 'memo', 'client'],
        ['owner1', 'reco', 'r1'],
        ['owner2', 'general', 'g1'],
      ].map(([n, tab, section]) => fieldOf(x, n, { tab, section })?.order),
      [1, 2, 3],
    );
    // The page shows 'owner1' where the form XML has the first copy (an unpublished reorder): they disagree, no cell.
    eq(fieldOf(x, 'owner1', { tab: 'memo', section: 'client' }), undefined);
    eq(fieldOf(x, 'owner', { tab: 'other', section: 'x' }), undefined, 'no copy there');
  });

  test('fieldOf, empty form API: an ambiguous copy gets no cell, never a wrong one', () => {
    // Two copies in one section: the place can't tell them apart; the name decides only when it points at one there.
    const two = [cell(1, 'name', 'name', 't', 's'), cell(2, 'name', 'name', 't', 's'), cell(3, 'name', 'name', 't', 'other')];
    const x = page(two);
    eq(fieldOf(x, 'name', { tab: 't', section: 's' })?.order, 1, 'the plain id is the first copy, which is there');
    eq(fieldOf(x, 'name1', { tab: 't', section: 's' })?.order, 2);
    eq(fieldOf(x, 'name2', { tab: 't', section: 's' }), undefined, 'copy 2 is in another section: not one of these');
    // Names the form already uses push the copies' numbers up (Contoso: contoso_client5 is the 2nd copy): unknown.
    const shifted = [cell(1, 'client', 'client', 't', 'a'), cell(2, 'client1', 'client1', 't', 'a'), cell(3, 'client', 'client', 't', 'b'), cell(4, 'client', 'client', 't', 'c')];
    const y = page(shifted);
    eq(fieldOf(y, 'client2'), undefined, 'by number: client1 is taken, so client2 is not copy 2');
    eq(fieldOf(y, 'client2', { tab: 't', section: 'b' })?.order, 3, 'the only copy where the page shows it');
    eq(fieldOf(y, 'client5', { tab: 't', section: 'c' })?.order, 4, 'numbers past the copy count too (Contoso: 5, 6, 7)');
    eq(fieldOf(y, 'client2', { tab: 't', section: 'a' }), undefined, 'the only copy in a is the first, named client: never a numbered control');
    eq(fieldOf(y, 'client1', { tab: 't', section: 'a' })?.order, 2, 'a control with its own id');
    eq(fieldOf(y, 'client01'), undefined, 'never a padded number');
  });

  test('ctlSlot, empty form API: never the column (the form API would have to say the control is bound to it)', () => {
    const col = { ...t.slot('attribute', 'attribute|e.extra|DisplayName'), comp: 'attribute|e.extra', ref: { entity: 'e', attribute: 'extra' } } as Slot;
    const x = page([cell(1, 'name', 'name', 't', 's')], { main: new Map([[col.comp, col]]) });
    eq(ctlSlot(x, 'extra', { tab: 't', section: 's' }), undefined, 'a control the form XML has no cell for');
    eq(ctlSlot(x, 'name', { tab: 't', section: 's' })?.order, 1);
  });

  test('fieldOf, controls without tabs (getParent empty after a clear): the DOM gives the section and tab', () => {
    const cs = [cell(1, 'title', 'title', 'memo', 'm1'), cell(2, 'title', 'title', 'general', 'g1')];
    const x = page(cs, { tabless: { title: 'title', title1: 'title' } });
    eq(fieldOf(x, 'title', { tab: 'memo', section: 'm1' })?.order, 1);
    eq(fieldOf(x, 'title1', { tab: 'general', section: 'g1' })?.order, 2);
    eq(fieldOf(x, 'title1'), undefined, 'nothing tells which copy: unknown');
  });

  // ---- the check after a refresh: what the page renders ----

  const S = (kind: Slot['kind'], key: string, prop: Slot['prop'], ref: Record<string, unknown>, entity = 'e'): Slot => ({ ...t.slot(kind, key), kind, prop, entity, comp: key.split('|').slice(0, -1).join('|'), ref }) as Slot;
  const cName = cell(1, 'name', 'name', 'general', 's1');
  const cOwner1 = cell(2, 'owner', 'owner', 'general', 's1');
  const cOwner2 = cell(3, 'owner', 'owner', 'details', 'd1');
  const slots = [
    cName,
    cOwner1,
    cOwner2,
    S('attribute', 'attribute|e.name|Description', 'Description', { entity: 'e', attribute: 'name' }),
    S('tab', `tab|${FORM}|t1|Label`, 'Label', { formId: FORM, tabName: 'general' }),
    S('section', `section|${FORM}|s1|Label`, 'Label', { formId: FORM, sectionName: 's1' }),
    S('tab', 'tab|other-form|t1|Label', 'Label', { formId: 'other-form', tabName: 'general' }),
    S('entity', 'entity|e|DisplayName', 'DisplayName', { entity: 'e' }),
  ];
  const by = new Map(slots.map((s) => [s.key, s]));
  const form: ShownForm = { user: FR, formId: FORM, get: (k) => by.get(k), cells: [cName, cOwner1, cOwner2] };
  const item = (key: string, text: string, lcid = FR): ShownItem => ({ kind: by.get(key)!.kind, key, lcid, text });
  /** A page: rendered field labels, tab and section titles. */
  const shown = (fields: ShownField[], tabs: Record<string, string> = {}, sections: Record<string, string> = {}): Shown => ({
    fields: (ctls) => fields.filter((f) => ctls.includes(f.ctl)),
    tab: (n) => tabs[n],
    section: (n) => sections[n],
  });
  const at = (tab: string, section: string) => ({ tab, section });

  test('pageShows: field labels, tooltips, tab and section titles, read from the page in the user language', () => {
    const page1 = shown(
      [
        { ctl: 'name', text: 'Nom V5', tip: 'Nom V5 - Le nom principal', place: at('general', 's1') },
        { ctl: 'owner', text: 'Propriétaire *', tip: '', place: at('general', 's1') },
        { ctl: 'owner1', text: 'Responsable', tip: '', place: at('details', 'd1') },
      ],
      { general: 'Général' },
      { s1: 'Informations' },
    );
    eq(pageShows(item(cName.key, 'Nom V5'), form, page1), true, 'the field label');
    eq(pageShows(item(cName.key, 'Nom V6'), form, page1), false, 'still the old label');
    eq(pageShows(item('attribute|e.name|Description', 'Le nom principal'), form, page1), true, 'the tooltip: "<label> - <description>"');
    eq(pageShows(item('attribute|e.name|Description', 'Le nom'), form, page1), false, 'another tooltip');
    eq(pageShows(item(cOwner1.key, 'Propriétaire'), form, page1), true, 'a required field (asterisk)');
    eq(pageShows(item(cOwner2.key, 'Responsable'), form, page1), true, 'the second copy (owner1), placed in its own section');
    eq(pageShows(item(cOwner2.key, 'Propriétaire'), form, page1), false, 'the first copy shows that, not this one');
    eq(pageShows(item(`tab|${FORM}|t1|Label`, 'Général'), form, page1), true, 'tab title');
    eq(pageShows(item(`tab|${FORM}|t1|Label`, 'Généralités'), form, page1), false);
    eq(pageShows(item(`section|${FORM}|s1|Label`, 'Informations'), form, page1), true, 'section title');
  });

  test("pageShows: undefined when the page can't tell", () => {
    const page1 = shown([{ ctl: 'name', text: '', tip: '', place: at('general', 's1') }], {}, {});
    eq(pageShows(item(cName.key, 'Nom'), form, page1), undefined, 'label hidden on the form (empty)');
    eq(pageShows(item(cName.key, 'Name', EN), form, page1), undefined, 'English while the page shows French');
    eq(pageShows(item(cName.key, ''), form, page1), undefined, 'a removed label shows the column name instead');
    eq(pageShows(item(`tab|${FORM}|t1|Label`, 'Général'), form, page1), undefined, 'tab not rendered ("More tabs")');
    eq(pageShows(item(`section|${FORM}|s1|Label`, 'Informations'), form, page1), undefined, 'a tab not visited yet');
    eq(pageShows(item('tab|other-form|t1|Label', 'Général'), form, shown([], { general: 'Général' })), undefined, "another form's tab of the same name");
    eq(pageShows(item('entity|e|DisplayName', 'Test'), form, page1), undefined, 'other kinds: the server text decides');
    eq(pageShows(item(cName.key, 'Nom'), { ...form, formId: '' }, page1), undefined, 'the page form is unknown');
    const elsewhere = shown([{ ctl: 'name', text: 'Nom', tip: '', place: at('other', 'x') }]);
    eq(pageShows(item(cName.key, 'Nom'), form, elsewhere), undefined, 'a control of that name elsewhere (a side pane) is not this cell');
  });

  test('checkShown: the page decides where it can tell, the freshly loaded server text elsewhere', () => {
    const items = [
      { ...item(cName.key, 'Nom V5'), comp: 'a' },
      { ...item(`tab|${FORM}|t1|Label`, 'Général'), comp: 'b' },
      { ...item('entity|e|DisplayName', 'Test'), comp: 'c' },
      { ...item('entity|e|DisplayName', 'Test EN', EN), comp: 'd' },
      { ...item('attribute|e.name|Description', 'Desc'), comp: 'e' },
    ];
    const server: Record<string, string> = { [`${cName.key}#${FR}`]: 'Nom V5', [`entity|e|DisplayName#${FR}`]: 'Test', [`entity|e|DisplayName#${EN}`]: 'Test (old)' };
    const page1 = shown([{ ctl: 'name', text: 'Nom V4', tip: 'Nom V4', place: at('general', 's1') }], { general: 'Général' });
    const r = checkShown(items, (k, l) => server[`${k}#${l}`], (it) => pageShows(it, form, page1));
    // The server has "Nom V5" but the page still shows "Nom V4": not showing (Refresh again). The field's tooltip
    // is only its label ("Nom V4", no " - <description>"): the published description isn't showing either.
    eq(
      [r.showing.map((i) => i.comp), r.missing.map((i) => i.comp)],
      [
        ['b', 'c'],
        ['a', 'd', 'e'],
      ],
    );
    // Neither the page nor the server text can tell: not checked.
    eq(checkShown([{ ...item(`section|${FORM}|s1|Label`, 'Infos'), comp: 'f' }], () => undefined, () => undefined), { showing: [], missing: [] });
  });

  test('domShown reads the page form: field labels with their tooltip and place, tab and section titles', () => {
    const doc = new El('body').add(
      new El('ul').add(tabEl('general', 'Général'), tabEl('details', 'Détails')),
      tabPanel('general', sectionEl('s1', 'Informations', fieldEl('name', 'Nom', 'Nom - Le nom'), fieldEl('owner', 'Propriétaire', ''))),
      // A quick create pane and a dialog hold forms of their own: never the page's.
      new El('div', { 'data-id': 'quickCreateRoot' }).add(fieldEl('name', 'Nom (quick create)', '')),
      new El('div', { role: 'dialog' }).add(fieldEl('owner', 'Propriétaire (dialog)', '')),
    );
    const s = domShown(doc as unknown as Document);
    eq(s.fields(['name', 'owner', 'missing']), [
      { ctl: 'name', text: 'Nom', tip: 'Nom - Le nom', place: { section: 's1', tab: 'general' } },
      { ctl: 'owner', text: 'Propriétaire', tip: '', place: { section: 's1', tab: 'general' } },
    ]);
    eq(s.fields(['bad"name']), [], 'never a broken selector');
    eq([s.tab('general'), s.tab('details'), s.tab('other')], ['Général', 'Détails', undefined], 'the title, not the doubled text');
    eq([s.section('s1'), s.section('s9')], ['Informations', undefined]);
    // And end to end: the label and tooltip as published.
    const f: ShownForm = { ...form, cells: [cName] };
    eq([pageShows(item(cName.key, 'Nom'), f, s), pageShows(item('attribute|e.name|Description', 'Le nom'), f, s)], [true, true]);
  });

  // ---- the scan of a cold form: what a click on a label can open ----

  test('scan, empty form API: tabs, sections and fields anchor from the DOM; a copy that can\'t be told apart gets none', () => {
    const L = (s: Slot, en: string, fr: string): Slot => ({ ...s, labels: { [EN]: en, [FR]: fr } });
    const c = (n: number, id: string, tab: string, section: string, en: string, fr: string) => L(cell(n, id, id.replace(/\d+$/, ''), tab, section), en, fr);
    const cells = [
      c(1, 'name', 'general', 's1', 'Name', 'Nom'),
      c(2, 'owner', 'general', 's1', 'Owner', 'Propriétaire'),
      c(3, 'owner', 'general', 's1', 'Manager', 'Responsable'),
      c(4, 'city', 'general', 's2', 'City', 'Ville'),
      // phone placed three times; another control already has the id phone1, so Dynamics names the 2nd and 3rd
      // copies phone2 and phone3 (or later numbers): both in s2, nothing tells which is which.
      c(5, 'phone', 'general', 's1', 'Phone', 'Téléphone'),
      c(6, 'phone', 'general', 's2', 'Phone', 'Téléphone'),
      c(7, 'phone', 'general', 's2', 'Phone', 'Téléphone'),
      c(8, 'phone1', 'details', 'd1', 'Phone 1', 'Téléphone 1'),
    ];
    const tabs = [L(S('tab', `tab|${FORM}|t1|Label`, 'Label', { formId: FORM, tabName: 'general' }), 'General', 'Général'), L(S('tab', `tab|${FORM}|t2|Label`, 'Label', { formId: FORM, tabName: 'details' }), 'Details', 'Détails')];
    const secs = [L(S('section', `section|${FORM}|s1|Label`, 'Label', { formId: FORM, sectionName: 's1' }), 'Information', 'Informations'), L(S('section', `section|${FORM}|s2|Label`, 'Label', { formId: FORM, sectionName: 's2' }), 'Address', 'Adresse')];
    const store = { slots: new Map([...cells, ...tabs, ...secs].map((s) => [s.key, s])) } as unknown as Store;
    const ld = { page: { info: { type: 'entityrecord' }, entity: 'e', formId: FORM, bpfId: '', viewId: '' }, app: { ctx: { user: FR, base: EN } }, sitemapId: '', appId: '', cmd: new Map(), ribbon: new Map() } as unknown as PageLoader;
    // After a purge reload (LIVE-FINDINGS 51): no controls, no tabs, getControl() null; the record and its table are known.
    const xrm = {
      Page: {
        getControl: () => null,
        ui: { controls: { get: () => [], getLength: () => 0 }, tabs: { get: () => [], getLength: () => 0 }, formSelector: { getCurrentItem: () => null, items: { get: () => [] } } },
        data: { entity: { getEntityName: () => 'e' } },
      },
    };
    const body = new El('body').add(
      new El('ul').add(tabEl('general', 'Général'), tabEl('details', 'Détails')),
      tabPanel(
        'general',
        sectionEl('s1', 'Informations', fieldEl('name', 'Nom', 'Nom - Le nom'), fieldEl('owner', 'Propriétaire', ''), fieldEl('owner1', 'Responsable', ''), fieldEl('phone', 'Téléphone', '')),
        sectionEl('s2', 'Adresse', fieldEl('city', 'Ville', ''), fieldEl('phone2', 'Téléphone', ''), fieldEl('phone3', 'Téléphone', '')),
      ),
    );
    const list = withDom(body, () => {
      const x = buildIndex(store, ld, xrm);
      ok(!x.formApi && x.formReady, 'the form API is empty, the form labels are loaded');
      const sc = new Scanner();
      sc.full(x);
      return sc.list.map((a) => [a.role, a.key, (a.el as unknown as El).tagName]);
    });
    eq(list, [
      ['tab', `tab|${FORM}|t1|Label`, 'LI'],
      ['tab', `tab|${FORM}|t2|Label`, 'LI'],
      ['label', `section|${FORM}|s1|Label`, 'H2'],
      ['label', cells[0].key, 'LABEL'],
      ['label', cells[1].key, 'LABEL'],
      ['label', cells[2].key, 'LABEL'], // owner1: the 2nd copy of owner, which is there
      ['label', cells[4].key, 'LABEL'], // phone: the first copy keeps the plain id
      ['label', `section|${FORM}|s2|Label`, 'H2'],
      ['label', cells[3].key, 'LABEL'],
      // phone2 and phone3: no anchor, so no popup that could edit the other copy.
    ]);
  });
}
