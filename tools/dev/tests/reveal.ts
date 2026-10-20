// Unit tests for finding a label from "All labels on this page" (inspector/reveal.ts): what to open so the page renders
// it, the form API's visibility, the tab shown, and the stage and header flyout openers (on the fake DOM); for a change
// made on another page, the page it was made on, the way there, Dynamics' navigation calls and the find's steps while
// it goes; then the place on that page (its form tab or related view, the flyout its label was in) and the steps that
// bring it back.
import type { Kit } from './kit';
import { El } from './fakedom';
import { guid } from '../../../src/core/http';
import type { Kind, Slot } from '../../../src/core/model';
import type { Back, BackNow, FormQuery, Place, Reveal, RevealCtx, Spot, Target, Trip } from '../../../src/inspector/reveal';

const reveal = () => import('../../../src/inspector/reveal');

const F = '0f1e2d3c-4b5a-4968-8776-655443322110';
const Q = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const W = '919e14d1-0000-4000-8000-0000000000b2';
const S = '7e2f1c3d-1111-4222-8333-444455556666';

export function register(t: Kit): void {
  const mk = (kind: Kind, ref: Record<string, unknown>): Slot => ({ ...t.slot(kind), ref }) as Slot;
  const ctx = (o: Partial<RevealCtx> = {}): RevealCtx => ({ record: true, formId: F, bpfId: W, tab: 'summary', shows: () => true, quickHost: () => undefined, cellOf: () => undefined, ...o });
  const field = (o: Record<string, unknown> = {}) => mk('field', { formId: F, area: 'body', tabName: 'details', sectionName: 's1', controlId: 'fax', ...o });
  /** Clicks on a fake element are counted. */
  const clickable = (e: El): { el: El; n: () => number } => {
    let n = 0;
    Object.assign(e, { click: () => n++ });
    return { el: e, n: () => n };
  };

  t.test('reveal: a field or a section on another tab opens that tab', async () => {
    const { revealOf } = await reveal();
    t.eq(revealOf(field(), ctx()), { by: 'tab', name: 'details' });
    t.eq(revealOf(field({ tabName: 'SUMMARY' }), ctx()), { by: 'render' }, 'on the tab shown (any case) and not drawn yet: its place is brought into view');
    t.eq(revealOf(field({ tabName: 'SUMMARY' }), ctx({ shows: (q) => (q.ctl ? false : true) })), { by: 'none' }, 'on the tab shown, hidden by the form');
    t.eq(revealOf(mk('section', { formId: F, area: 'body', tabName: 'details', sectionName: 's1' }), ctx()), { by: 'tab', name: 'details' });
    t.eq(revealOf(mk('tab', { formId: F, area: 'body', tabName: 'details' }), ctx()), { by: 'none' }, "never for a tab's own row");
    t.eq(revealOf(field(), ctx({ record: false })), { by: 'none' });
    t.eq(revealOf(field({ formId: `{${F.toUpperCase()}}` }), ctx()), { by: 'tab', name: 'details' }, 'form ids compare as guids');
    t.eq(revealOf(field(), ctx({ tab: '' })), { by: 'tab', name: 'details' }, 'no tab known as shown (an associated view)');
  });

  t.test("reveal: a field Dynamics hasn't drawn yet: its place on the page form (its section's placeholder, its container once drawn, else the section), never a side pane's or a grid's", async () => {
    const { bodyPlace, placeholder } = await reveal();
    t.eq(bodyPlace(field(), ctx()), { section: 's1', ctl: 'fax' });
    t.eq(bodyPlace(mk('section', { formId: F, area: 'body', tabName: 'details', sectionName: 's1' }), ctx()), { section: 's1' });
    t.eq(bodyPlace(mk('field', { formId: F, area: 'header', controlId: 'header_x' }), ctx()), null, 'the header');
    t.eq(bodyPlace(mk('tab', { formId: F, area: 'body', tabName: 'details' }), ctx()), null);
    // As UCI renders an undrawn field (live 2026-10-17): an empty div with the control's name in its section.
    const spot = new El('div', { 'data-id': 'fax' });
    const sec = new El('section', { 'data-id': 's1' }).add(new El('div').add(spot));
    const pane = new El('div', { 'data-id': 'pane-container-1' }).add(new El('section', { 'data-id': 's1' }).add(new El('div', { 'data-id': 'fax' })));
    const grid = new El('div').add(new El('div', { 'data-id': 'fax', class: 'wj-cell wj-header' }));
    const body = new El('body').add(pane, grid, sec);
    t.ok(placeholder({ section: 's1', ctl: 'fax' }, body as unknown as ParentNode) === (spot as unknown as Element), 'the placeholder in its section');
    const drawn = new El('div', { 'data-id': 'fax-FieldSectionItemContainer' });
    const body2 = new El('body').add(new El('section', { 'data-id': 's1' }).add(drawn));
    t.ok(placeholder({ section: 's1', ctl: 'fax' }, body2 as unknown as ParentNode) === (drawn as unknown as Element), 'its container once drawn');
    t.ok(placeholder({ section: 's1', ctl: 'other' }, body as unknown as ParentNode) === (sec as unknown as Element), 'no such field there: its section');
    t.eq(placeholder({ section: 's9', ctl: 'fax' }, new El('body').add(grid) as unknown as ParentNode), null, "a grid cell named like the column is never the field's place");
    t.eq(placeholder({ section: 's1', ctl: 'fa"x' }, body as unknown as ParentNode) === (sec as unknown as Element), true, 'a name that is not plain is not used in a selector');
  });

  t.test('reveal: the form hides it → nothing to open', async () => {
    const { revealOf } = await reveal();
    for (const hidden of ['tab', 'section', 'ctl'] as const) {
      const shows = (q: FormQuery) => (q[hidden] ? false : true);
      t.eq(revealOf(field(), ctx({ shows })), { by: 'none' }, hidden);
    }
    t.eq(revealOf(field(), ctx({ shows: () => undefined })), { by: 'tab', name: 'details' }, "the form API can't tell (cold boot)");
    const asked: FormQuery[] = [];
    const shows = (q: FormQuery) => (asked.push(q), true);
    revealOf(field(), ctx({ shows }));
    revealOf(mk('section', { formId: F, area: 'body', tabName: 'details', sectionName: 's1' }), ctx({ shows }));
    t.eq(asked, [{ tab: 'details', section: 's1', ctl: 'fax' }, { tab: 'details', section: 's1' }]);
  });

  t.test('reveal: a header field opens the header flyout unless it is hidden', async () => {
    const { revealOf } = await reveal();
    const head = mk('field', { formId: F, area: 'header', controlId: 'header_revenue' });
    t.eq(revealOf(head, ctx()), { by: 'header' });
    const asked: FormQuery[] = [];
    revealOf(head, ctx({ shows: (q) => (asked.push(q), undefined) }));
    t.eq(asked, [{ ctl: 'header_revenue' }]);
    t.eq(revealOf(head, ctx({ shows: () => false })), { by: 'none' });
    t.eq(revealOf(mk('field', { formId: F, area: 'footer', controlId: 'f1' }), ctx()), { by: 'none' }, 'footer');
    t.eq(revealOf(mk('navitem', { formId: F, area: 'nav', tabName: 'details' }), ctx()), { by: 'none' }, 'a related menu item: never its menu');
  });

  t.test('reveal: a process step opens its stage', async () => {
    const { revealOf } = await reveal();
    t.eq(revealOf(mk('step', { workflowId: `{${W.toUpperCase()}}`, stageId: S.toUpperCase() }), ctx()), { by: 'stage', stageId: guid(S) });
    t.eq(revealOf(mk('step', { workflowId: Q, stageId: S }), ctx()), { by: 'none' }, 'another process');
    t.eq(revealOf(mk('step', { workflowId: W }), ctx()), { by: 'none' }, 'no stage known');
    t.eq(revealOf(mk('step', { workflowId: W, stageId: S }), ctx({ bpfId: '' })), { by: 'none' }, 'no active process');
    t.eq(revealOf(mk('stage', { workflowId: W, labelId: S }), ctx()), { by: 'none' }, 'a stage chip is in the bar');
  });

  t.test('reveal: a quick view field goes to the tab of its quick view control; a side pane field to nothing', async () => {
    const { revealOf } = await reveal();
    const inner = mk('field', { formId: Q.toUpperCase(), formType: 6, area: 'body', tabName: 'general', sectionName: 'qs', controlId: 'name' });
    const host = mk('field', { formId: F, area: 'body', tabName: 'details', sectionName: 's2', controlId: 'qv_contact', quickForms: [Q] });
    const ids: string[] = [];
    const asked: FormQuery[] = [];
    const c = ctx({ quickHost: (id) => (ids.push(id), id === Q ? host : undefined), shows: (q) => (asked.push(q), true) });
    t.eq(revealOf(inner, c), { by: 'tab', name: 'details' });
    t.eq(ids, [Q], 'asked by the guid');
    t.eq(asked, [{ tab: 'details', section: 's2', ctl: 'qv_contact' }], "the host's tab, section and control");
    t.eq(revealOf(inner, ctx()), { by: 'none' }, 'no host: a side pane form');
    t.eq(revealOf(mk('section', { formId: Q, area: 'body', tabName: 'general', sectionName: 'qs' }), c), { by: 'none' }, "a quick view's section");
    t.eq(revealOf(inner, ctx({ quickHost: () => mk('field', { formId: F, area: 'header', controlId: 'header_qv' }) })), { by: 'none' }, 'a quick view in the header');
  });

  t.test("reveal: a composite column's sub-field (an address's street) goes to the tab of its composite control's cell", async () => {
    const { revealOf } = await reveal();
    const part = { ...mk('attribute', { entity: 'account', attribute: 'address1_line2' }), comp: 'attribute|account.address1_line2' } as Slot;
    const host = mk('field', { formId: F, area: 'body', tabName: 'SUMMARY', sectionName: 'ADDRESS', controlId: 'address1_composite' });
    const asked: string[] = [];
    const qs: FormQuery[] = [];
    const c = ctx({ tab: 'details', cellOf: (comp) => (asked.push(comp), host), shows: (q) => (qs.push(q), true) });
    t.eq(revealOf(part, c), { by: 'tab', name: 'SUMMARY' });
    t.eq(asked, ['attribute|account.address1_line2']);
    t.eq(qs, [{ tab: 'SUMMARY', section: 'ADDRESS', ctl: 'address1_composite' }], "the composite cell's tab, section and control");
    t.eq(revealOf(part, ctx({ tab: 'details' })), { by: 'none' }, 'not seen on the page form: no cell to go to');
    t.eq(revealOf(part, ctx({ tab: 'details', cellOf: () => host, shows: () => false })), { by: 'none' }, 'the form hides it');
    t.eq(revealOf(part, ctx({ tab: 'summary', cellOf: () => host })), { by: 'render' }, 'on the tab shown: its composite control brought into view');
    const head = mk('field', { formId: F, area: 'header', controlId: 'header_address1_composite' });
    t.eq(revealOf(part, ctx({ cellOf: () => head })), { by: 'header' }, 'in the header');
  });

  t.test('reveal: formShows reads the tab, the section and every copy of a control', async () => {
    const { formShows } = await reveal();
    const ctl = (name: string, section: string, visible: boolean) => ({ getName: () => name, getParent: () => ({ getName: () => section }), getVisible: () => visible });
    const tabs: Record<string, unknown> = { details: { getVisible: () => true, sections: { get: (n: string) => ({ getVisible: () => n !== 'hid' }) } }, gone: { getVisible: () => false, sections: { get: () => null } } };
    const xrm = (cs: unknown[]) => ({ Page: { ui: { tabs: { get: (n: string) => tabs[n] ?? null }, controls: { get: () => cs } } } });
    const q = { tab: 'details', section: 's1', ctl: 'fax' };
    t.eq(formShows(xrm([ctl('fax', 's1', false), ctl('fax1', 's1', true)]), q), true, 'a copy shows');
    t.eq(formShows(xrm([ctl('fax', 's1', false), ctl('fax1', 's1', false)]), q), false);
    t.eq(formShows(xrm([ctl('fax', 's1', false), ctl('faxnumber', 's1', true)]), q), false, 'another control whose name starts the same');
    t.eq(formShows(xrm([ctl('FAX', 'S1', false)]), q), false, 'names in any case');
    t.eq(formShows(xrm([ctl('fax', 's2', true)]), q), undefined, 'a control of another section is not this one');
    t.eq(formShows(xrm([ctl('fax', 's1', true)]), { ...q, section: 'hid' }), false, 'hidden section');
    t.eq(formShows(xrm([]), { tab: 'gone' }), false, 'hidden tab');
    t.eq(formShows(xrm([]), { tab: 'nope' }), undefined, 'unknown tab');
    t.eq(formShows(xrm([]), { tab: 'details', section: 's1' }), true);
    t.eq(formShows({ get Page(): never { throw new Error('form being replaced'); } }, q), undefined);
    t.eq(formShows(undefined, q), undefined);
    t.eq(formShows(xrm([ctl('header_x', 'header', true)]), { ctl: 'header_x' }), true);
    t.eq(formShows(xrm([ctl('header_x', 'header', false)]), { ctl: 'header_x' }), false);
  });

  t.test('reveal: the tab shown now', async () => {
    const { selectedTab } = await reveal();
    const tab = () => new El('li', { role: 'tab', 'aria-selected': 'true', 'data-id': 'tablist-general' });
    const other = new El('li', { role: 'tab', 'aria-selected': 'false', 'data-id': 'tablist-details' });
    t.eq(selectedTab(new El('div').add(other, tab()) as unknown as ParentNode), 'general');
    t.eq(selectedTab(new El('div').add(new El('div', { 'data-id': 'pane-container-1' }).add(tab())) as unknown as ParentNode), '', "a side pane's tab");
    t.eq(selectedTab(new El('div').add(other) as unknown as ParentNode), '');
  });

  t.test("reveal: a stage opens by its chip's button only while its flyout is closed", async () => {
    const { openStage } = await reveal();
    const page = () => {
      const b = clickable(new El('button'));
      const chip = new El('li', { id: `MscrmControls.Containers.ProcessBreadCrumb-processHeaderStage_${S}` }).add(b.el);
      return { root: new El('div').add(chip), b };
    };
    const p1 = page();
    t.eq(openStage(S, p1.root as unknown as ParentNode), true);
    t.eq(p1.b.n(), 1);
    const p2 = page();
    t.eq(openStage(S.toUpperCase(), p2.root as unknown as ParentNode), true, 'the id in any case');
    t.eq(p2.b.n(), 1);
    const p3 = page();
    p3.root.add(new El('div', { id: `MscrmControls.Containers.ProcessBreadCrumb-processHeaderStageFlyoutContainer_${S}` }));
    t.eq(openStage(S, p3.root as unknown as ParentNode), false, 'open already: a click would close it');
    t.eq(p3.b.n(), 0);
    t.eq(openStage(S, new El('div') as unknown as ParentNode), false, 'no chip');
    t.eq(openStage('x"],body', page().root as unknown as ParentNode), false, 'not a stage id');
    // A flyout element kept in the page while closed (hidden) doesn't count as open.
    const p4 = page();
    const hid = new El('div', { id: `MscrmControls.Containers.ProcessBreadCrumb-processHeaderStageFlyoutContainer_${S}` });
    Object.assign(hid, { checkVisibility: () => false });
    p4.root.add(hid);
    t.eq(openStage(S, p4.root as unknown as ParentNode), true, 'hidden: closed');
    t.eq(p4.b.n(), 1);
  });

  t.test('reveal: stageFlyout is the stage flyout while it shows', async () => {
    const { stageFlyout } = await reveal();
    const fly = new El('div', { id: `MscrmControls.Containers.ProcessBreadCrumb-processHeaderStageFlyoutContainer_${S}` });
    const root = new El('div').add(fly) as unknown as ParentNode;
    t.ok(stageFlyout(S, root) === (fly as unknown), 'shown');
    t.ok(stageFlyout(S.toUpperCase(), root) === (fly as unknown), 'the id in any case');
    Object.assign(fly, { checkVisibility: () => false });
    t.eq(stageFlyout(S, root), null, 'hidden');
    t.eq(stageFlyout('x"],body', root), null, 'not a stage id');
    t.eq(stageFlyout(W, root), null, 'another stage');
  });

  t.test('reveal: the header flyout opens by its expand button only while it is closed', async () => {
    const { openHeader } = await reveal();
    const btn = (expanded: string) => clickable(new El('button', { 'data-id': 'headerFieldsExpandButton', 'aria-expanded': expanded }));
    const b1 = btn('false');
    t.eq(openHeader(new El('div').add(b1.el) as unknown as ParentNode), true);
    t.eq(b1.n(), 1);
    const b2 = btn('true');
    t.eq(openHeader(new El('div').add(b2.el) as unknown as ParentNode), false);
    t.eq(b2.n(), 0);
    const b3 = btn('false');
    t.eq(openHeader(new El('div').add(b3.el, new El('div', { id: 'headerFieldsFlyout', 'data-id': 'headerFieldsFlyout' })) as unknown as ParentNode), false, 'open already');
    t.eq(b3.n(), 0);
    const b4 = btn('false');
    t.eq(openHeader(new El('div').add(new El('div', { 'data-id': 'pane-container-1' }).add(b4.el)) as unknown as ParentNode), false, "a side pane's header");
    t.eq(b4.n(), 0);
    t.eq(openHeader(new El('div') as unknown as ParentNode), false, 'none');
  });

  // ---- labels on other pages ----

  const G = '11111111-2222-4333-8444-555566667777';
  const R1 = 'c0000000-0000-4000-8000-000000000001';
  const R2 = 'c0000000-0000-4000-8000-000000000002';
  const V = 'b0000000-0000-4000-8000-00000000000a';
  const D = 'd0000000-0000-4000-8000-00000000000d';
  const rec = (entity: string, formId: string, recordId = ''): Place => ({ type: 'entityrecord', entity, recordId, formId, viewId: '', viewType: '', dashboardId: '' });
  const listP = (entity: string, viewId: string): Place => ({ type: 'entitylist', entity, recordId: '', formId: '', viewId, viewType: 'savedquery', dashboardId: '' });
  const dashP = (id: string): Place => ({ type: 'dashboard', entity: '', recordId: '', formId: id, viewId: '', viewType: '', dashboardId: id });
  const toForm = (entity: string, formId: string, recordId = ''): Target => ({ to: 'form', entity, formId, recordId });

  t.test('reveal: a change lives exactly on the page it was made on in translation mode; one made anywhere else has no page to go to', async () => {
    const { targetOf } = await reveal();
    t.eq(targetOf(rec('contact', G, R1)), toForm('contact', G, R1), 'that form of that record');
    t.eq(targetOf(rec('contact', G)), toForm('contact', G), "made on a new record's form: that form, never another record of the table");
    t.eq(targetOf(listP('account', V)), { to: 'list', entity: 'account', viewId: V, viewType: 'savedquery' });
    const personal: Place = { ...listP('account', V), viewType: 'userquery' };
    t.eq(targetOf(personal), { to: 'list', entity: 'account', viewId: V, viewType: 'userquery' }, 'a personal view');
    t.eq(targetOf(dashP(D)), { to: 'dashboard', dashboardId: D });
    const apps: Place = { type: 'apps', entity: '', recordId: '', formId: '', viewId: '', viewType: '', dashboardId: '' };
    t.eq(targetOf(apps), null, 'the app navigation: no page of its own');
    t.eq(targetOf(rec('', G, R1)), null, 'a record page that names no table');
    // Not made on a page (the Workbench, an import, the editor): nowhere, whatever its slot names (a form cell, a quick
    // view, a dashboard, a view).
    t.eq([targetOf(null), targetOf(undefined)], [null, null]);
  });

  // ---- the place on its page ----

  const spot = (o: Partial<Spot> = {}): Spot => ({ tab: '', nav: '', header: false, stage: '', ...o });
  /** A label inside `outer` (outermost first). */
  const inside = (...outer: El[]): El => {
    const l = new El('label');
    outer.reduceRight<El>((inner, e) => (e.add(inner), e), l);
    return l;
  };

  t.test("reveal: where a label was when it changed: the form tab or the related view shown, the header's or a stage's flyout it was in", async () => {
    const { flyoutOf, spotOf, NOWHERE } = await reveal();
    const head = inside(new El('div', { id: '__fluentPortalMountNode' }), new El('div', { id: 'headerFieldsFlyout', 'data-id': 'headerFieldsFlyout' }), new El('section'));
    t.eq(flyoutOf(head as unknown as Element), { header: true, stage: '' }, "the header's flyout");
    const step = inside(
      new El('div', { id: `MscrmControls.Containers.ProcessBreadCrumb-processHeaderStageFlyoutContainer_${S.toUpperCase()}` }),
      new El('div', { id: `MscrmControls.Containers.ProcessBreadCrumb-processHeaderStageFlyout_${S.toUpperCase()}` }),
    );
    t.eq(flyoutOf(step as unknown as Element), { header: false, stage: S }, "a stage's flyout, its id in any case");
    t.eq(flyoutOf(inside(new El('section', { 'data-id': 's1' })) as unknown as Element), { header: false, stage: '' }, 'on the form');
    t.eq(flyoutOf(inside(new El('div', { 'data-id': 'pane-container-1' }), new El('div', { 'data-id': 'headerFieldsFlyout' })) as unknown as Element), { header: false, stage: '' }, "a side pane's");
    t.eq(flyoutOf(null), { header: false, stage: '' }, 'no label shown');
    const names = new Set(['t:details', 't:navigation_tab', 'n:custom_rel']);
    const known = (k: string) => names.has(k);
    t.eq(spotOf('details', known, null), spot({ tab: 'details' }), 'a form tab');
    t.eq(spotOf('SUMMARY_TAB', known, null), spot({ tab: 'SUMMARY_TAB' }), 'a tab the index has no name for: a form tab');
    t.eq(spotOf('nav_msa_contact_managingpartner', known, null), spot({ nav: 'nav_msa_contact_managingpartner' }), 'an associated view: its tab is the nav id (LIVE-FINDINGS 88)');
    t.eq(spotOf('navConnections', known, null), spot({ nav: 'navConnections' }));
    t.eq(spotOf('custom_rel', known, null), spot({ nav: 'custom_rel' }), 'a related menu item the form XML lists');
    t.eq(spotOf('navigation_tab', known, null), spot({ tab: 'navigation_tab' }), 'a form tab named like a nav id');
    t.eq(spotOf('details', known, head as unknown as Element), spot({ tab: 'details', header: true }));
    t.eq(spotOf('', known, null), NOWHERE, 'no tab shown');
  });

  t.test('reveal: bringing a place back opens its tab or related view first, then its flyout once that shows, each once', async () => {
    const { backTo, backStep, BACK_PART, BACK_SETTLE, BACK_WAIT } = await reveal();
    const none = { header: false, stage: false };
    t.eq(backTo(spot({ tab: 'details' }), 'general', none), { by: 'tab', name: 'details' });
    t.eq(backTo(spot({ nav: 'nav_x' }), 'general', none), { by: 'nav', id: 'nav_x' });
    t.eq(backTo(spot({ tab: 'details', header: true }), 'DETAILS', none), { by: 'header' }, 'the tab shows (any case): its flyout');
    t.eq(backTo(spot({ stage: S }), '', none), { by: 'stage', stageId: S });
    t.eq(backTo(spot({ tab: 'details', header: true }), 'details', { header: true, stage: false }), { by: 'none' }, 'all of it shows');
    const T0 = 1000;
    const back = (s: Spot): Back => ({ left: s, t0: T0, done: new Set(), at: 0, since: 0 });
    const n = (o: Partial<BackNow> = {}): BackNow => ({ tab: 'summary', header: false, stage: false, found: false, ready: true, ...o });
    const opener = (ok = true) => {
      const log: string[] = [];
      return { log, open: (r: Reveal) => (log.push(r.by === 'tab' ? `tab ${r.name}` : r.by === 'nav' ? `nav ${r.id}` : r.by), ok) };
    };
    // A column header changed in an associated view: that related view again, then its header once drawn.
    const b1 = back(spot({ nav: 'nav_x' }));
    const o1 = opener();
    t.eq(backStep(b1, n(), T0, o1.open), 'wait');
    t.eq(backStep(b1, n(), T0 + 100, o1.open), 'wait', 'opened, not shown yet');
    t.eq(o1.log, ['nav nav_x'], 'once');
    t.eq(backStep(b1, n({ tab: 'nav_x', ready: false }), T0 + 400, o1.open), 'wait', 'its grid loading');
    t.eq(backStep(b1, n({ tab: 'nav_x', found: true }), T0 + 600, o1.open), 'find');
    // A label of the header's flyout on a tab: the tab, then the flyout, then the label.
    const b2 = back(spot({ tab: 'details', header: true }));
    const o2 = opener();
    t.eq(backStep(b2, n({ found: true }), T0, o2.open), 'wait', 'a label that shows elsewhere waits for its place');
    t.eq(o2.log, ['tab details']);
    t.eq(backStep(b2, n({ tab: 'details' }), T0 + 100, o2.open), 'wait');
    t.eq(o2.log, ['tab details', 'header'], 'the flyout once the tab shows');
    t.eq(backStep(b2, n({ tab: 'details' }), T0 + 200, o2.open), 'wait');
    t.eq(backStep(b2, n({ tab: 'details', header: true, found: true }), T0 + 300, o2.open), 'find');
    t.eq(o2.log, ['tab details', 'header'], 'never a second click (it would close the flyout)');
    // The place shows, the label isn't drawn: looked for once the page's loads have been in for BACK_SETTLE.
    const b3 = back(spot({ tab: 'details' }));
    const o3 = opener();
    backStep(b3, n(), T0, o3.open);
    t.eq(backStep(b3, n({ tab: 'details' }), T0 + 100, o3.open), 'wait');
    t.eq(backStep(b3, n({ tab: 'details', ready: false }), T0 + 500, o3.open), 'wait');
    t.eq(backStep(b3, n({ tab: 'details' }), T0 + 600, o3.open), 'wait');
    t.eq(backStep(b3, n({ tab: 'details' }), T0 + 600 + BACK_SETTLE - 1, o3.open), 'wait');
    t.eq(backStep(b3, n({ tab: 'details' }), T0 + 600 + BACK_SETTLE, o3.open), 'find');
    // A part that can't be opened (no such related view, no such stage chip) is left out at once.
    const b4 = back(spot({ nav: 'nav_gone', stage: S }));
    const o4 = opener(false);
    t.eq(backStep(b4, n({ found: true }), T0, o4.open), 'find');
    t.eq([o4.log, b4.left], [['nav nav_gone', 'stage'], spot()]);
    // One that never shows is left out after BACK_PART; a flyout that closed again is never clicked twice.
    const b5 = back(spot({ tab: 'details', header: true }));
    const o5 = opener();
    backStep(b5, n(), T0, o5.open);
    t.eq(backStep(b5, n(), T0 + BACK_PART - 1, o5.open), 'wait');
    t.eq(backStep(b5, n(), T0 + BACK_PART, o5.open), 'wait', 'without its tab: the flyout');
    t.eq(o5.log, ['tab details', 'header']);
    t.eq(backStep(b5, n({ header: true }), T0 + BACK_PART + 100, o5.open), 'wait');
    t.eq(backStep(b5, n({ header: false }), T0 + BACK_PART + 200, o5.open), 'wait', 'it closed again');
    t.eq(o5.log, ['tab details', 'header']);
    t.eq(backStep(b5, n({ found: true }), T0 + 2 * BACK_PART, o5.open), 'find');
    // The deadline: looked for anyway.
    const b6 = back(spot({ nav: 'nav_x' }));
    const o6 = opener();
    backStep(b6, n(), T0, o6.open);
    t.eq(backStep(b6, n(), T0 + BACK_WAIT, o6.open), 'find');
  });

  t.test('reveal: the way to a label: here, another form of this record, another record or table, a list, a dashboard', async () => {
    const { routeTo } = await reveal();
    const F2 = F;
    t.eq(routeTo(toForm('contact', G, R1), rec('contact', G, R1)), { by: 'here' }, 'the same form on the same record');
    t.eq(routeTo(toForm('contact', G, R1), rec('contact', F2, R1)), { by: 'switch', entity: 'contact', recordId: R1, formId: G }, 'only the form differs');
    t.eq(routeTo(toForm('contact', G), rec('Contact', F2, R2)), { by: 'switch', entity: 'contact', recordId: R2, formId: G }, 'no record named: this record, another form');
    t.eq(routeTo(toForm('contact', G), rec('contact', G, R2)), { by: 'here' });
    t.eq(routeTo(toForm('contact', G, R1), rec('contact', G, R2)), { by: 'open', entity: 'contact', recordId: R1, formId: G }, 'another record');
    t.eq(routeTo(toForm('contact', G, R1), rec('account', F2, R2)), { by: 'open', entity: 'contact', recordId: R1, formId: G }, 'another table');
    t.eq(routeTo(toForm('contact', G), listP('account', V)), { by: 'open', entity: 'contact', recordId: '', formId: G }, "no record known: a new record's form");
    t.eq(routeTo(toForm('contact', G, R1), null), { by: 'open', entity: 'contact', recordId: R1, formId: G });
    const list: Target = { to: 'list', entity: 'account', viewId: V, viewType: 'savedquery' };
    t.eq(routeTo(list, listP('account', V)), { by: 'here' });
    t.eq(routeTo(list, listP('account', Q)), { by: 'list', entity: 'account', viewId: V, viewType: 'savedquery' }, 'another view');
    t.eq(routeTo(list, rec('account', F2, R1)), { by: 'list', entity: 'account', viewId: V, viewType: 'savedquery' });
    t.eq(routeTo({ to: 'dashboard', dashboardId: D }, dashP(D)), { by: 'here' });
    t.eq(routeTo({ to: 'dashboard', dashboardId: D }, dashP(Q)), { by: 'dashboard', dashboardId: D });
  });

  t.test("reveal: goTo uses Dynamics' navigation of the page: the form selector for another form of the record, openForm, navigateTo", async () => {
    const { goTo } = await reveal();
    const calls: unknown[] = [];
    const xrm = (items: Array<{ id: string }> | null, fail = false) => ({
      Page: { ui: { formSelector: { items: { get: () => (items ? items.map((i) => ({ getId: () => i.id, navigate: () => void calls.push(['navigate', i.id]) })) : (() => { throw new Error('no form'); })()) } } } },
      Navigation: {
        openForm: (o: unknown) => (calls.push(['openForm', o]), fail ? Promise.reject(new Error('cancelled')) : Promise.resolve()),
        navigateTo: (o: unknown) => (calls.push(['navigateTo', o]), Promise.resolve()),
      },
    });
    const sw = { by: 'switch', entity: 'contact', recordId: R1, formId: G } as const;
    t.eq(goTo(xrm([{ id: F }, { id: `{${G.toUpperCase()}}` }]), sw), true);
    t.eq(calls.splice(0), [['navigate', `{${G.toUpperCase()}}`]], "the form selector's item, the record kept");
    // The selector lists the record's forms without it: the user can't open it in this app (openForm would show this
    // form again, and the find would wait for nothing).
    t.eq(goTo(xrm([{ id: F }]), sw), false);
    t.eq(calls.splice(0), [], 'not in the selector: no navigation');
    t.eq(goTo(xrm([]), sw), true);
    t.eq(calls.splice(0), [['openForm', { entityName: 'contact', entityId: R1, formId: G }]], 'a selector listing nothing (a cold form API): openForm on this record');
    t.eq(goTo(xrm(null), { ...sw, recordId: '' }), true);
    t.eq(calls.splice(0), [['openForm', { entityName: 'contact', formId: G }]], "no selector, a new record's form");
    goTo(xrm(null), { by: 'open', entity: 'contact', recordId: R1, formId: G });
    goTo(xrm(null), { by: 'open', entity: 'contact', recordId: '', formId: '' });
    goTo(xrm(null), { by: 'list', entity: 'account', viewId: V, viewType: 'savedquery' });
    goTo(xrm(null), { by: 'list', entity: 'account', viewId: '', viewType: '' });
    goTo(xrm(null), { by: 'dashboard', dashboardId: D });
    t.eq(calls.splice(0), [
      ['openForm', { entityName: 'contact', entityId: R1, formId: G }],
      ['openForm', { entityName: 'contact' }],
      ['navigateTo', { pageType: 'entitylist', entityName: 'account', viewId: V, viewType: 'savedquery' }],
      ['navigateTo', { pageType: 'entitylist', entityName: 'account' }],
      ['navigateTo', { pageType: 'dashboard', dashboardId: D }],
    ]);
    t.eq(goTo({}, { by: 'open', entity: 'contact', recordId: R1, formId: G }), false, 'no navigation API');
    t.eq(goTo(null, { by: 'dashboard', dashboardId: D }), false);
    t.eq(goTo(xrm(null), { by: 'here' }), false, 'here: nothing to do');
    let refused = 0;
    t.eq(goTo(xrm(null, true), { by: 'open', entity: 'contact', recordId: R1, formId: G }, () => refused++), true);
    await new Promise((r) => setTimeout(r, 0));
    t.eq(refused, 1, 'a refused navigation says so');
    // The form selector's navigate() too, when it answers with a promise that rejects.
    const sel = { Page: { ui: { formSelector: { items: { get: () => [{ getId: () => G, navigate: () => Promise.reject(new Error('cancelled')) }] } } } } };
    t.eq(goTo(sel, sw, () => refused++), true);
    await new Promise((r) => setTimeout(r, 0));
    t.eq(refused, 2);
  });

  t.test('reveal: a second click on a row whose find is on its way goes again only once the user kept the page it left and Dynamics asks nothing', async () => {
    const { goAgain, pageDialog, TRIP_AGAIN, TRIP_WAIT } = await reveal();
    const trip: Trip = { target: toForm('contact', G, R1), from: 'A', until: 5000 + TRIP_WAIT, since: 0 };
    t.eq(goAgain(trip, 'A', false, 5000 + TRIP_AGAIN - 1), false, 'a double click: it goes once');
    t.eq(goAgain(trip, 'A', false, 5000 + TRIP_AGAIN), true, 'still on the page it left, nothing asked: the user said no to the unsaved-changes question');
    t.eq(goAgain(trip, 'A', true, 9000), false, 'Dynamics is asking (its dialog is open)');
    t.eq(goAgain(trip, 'B', false, 9000), false, 'on its way');
    // Dynamics' modal dialogs on the page; ours are in our own shadow root.
    const page = (attrs: Record<string, string>, visible = true) => {
      const d = new El('div', attrs);
      Object.assign(d, { checkVisibility: () => visible });
      return new El('div').add(d) as unknown as ParentNode;
    };
    t.eq(pageDialog(page({ role: 'dialog', 'aria-modal': 'true' })), true);
    t.eq(pageDialog(page({ role: 'alertdialog' })), true);
    t.eq(pageDialog(page({ role: 'dialog', 'aria-modal': 'true' }, false)), false, 'hidden');
    t.eq(pageDialog(page({ role: 'dialog' })), false, 'not modal (a flyout)');
    t.eq(pageDialog({} as ParentNode), false, 'no document');
  });

  t.test('reveal: a find gone to another page waits there for the page, then finds; it gives up elsewhere or after the deadline', async () => {
    const { tripStep, arrived, toward, TRIP_SETTLE, TRIP_OTHER, TRIP_WAIT } = await reveal();
    const from = rec('account', F, R2);
    const target = toForm('contact', G, R1);
    const trip = (): Trip => ({ target, from: 'A', until: TRIP_WAIT, since: 0 });
    const n = (place: Place | null, sig: string, o: { ready?: boolean; found?: boolean } = {}) => ({ place, sig, ready: !!o.ready, found: !!o.found });
    // Still on the page it left (Dynamics may be asking about unsaved changes): it waits, then gives up.
    const t1 = trip();
    t.eq(tripStep(t1, n(from, 'A', { ready: true }), 100), 'wait');
    t.eq(tripStep(t1, n(from, 'A', { ready: true }), TRIP_WAIT), 'cancel', 'deadline');
    // On the way (the record known before its form), then there; the label shows: found.
    const t2 = trip();
    t.eq(tripStep(t2, n(rec('contact', '', R1), 'B'), 100), 'wait');
    t.eq(tripStep(t2, n(null, ''), 200), 'wait', 'no page yet');
    t.eq(tripStep(t2, n({ ...from, type: 'other', entity: '' }, 'C'), 300), 'wait', "a page that doesn't say what it is yet");
    t.eq(tripStep(t2, n(rec('contact', G, R1), 'D'), 400), 'wait', 'its loads still running');
    t.eq(tripStep(t2, n(rec('contact', G, R1), 'D', { found: true }), 500), 'find');
    // There and ready, the label not anchored (another tab, hidden): looked for after TRIP_SETTLE.
    const t3 = trip();
    t.eq(tripStep(t3, n(rec('contact', G, R1), 'D', { ready: true }), 1000), 'wait');
    t.eq(tripStep(t3, n(rec('contact', G, R1), 'D', { ready: true }), 1000 + TRIP_SETTLE - 1), 'wait');
    t.eq(tripStep(t3, n(rec('contact', G, R1), 'D', { ready: true }), 1000 + TRIP_SETTLE), 'find');
    // There, never ready (a load that hangs): found at the deadline anyway.
    t.eq(tripStep(trip(), n(rec('contact', G, R1), 'D'), TRIP_WAIT), 'find');
    // Another page than the target: the user went elsewhere.
    t.eq(tripStep(trip(), n(listP('lead', V), 'E'), 100), 'cancel');
    t.eq(tripStep(trip(), n(rec('contact', G, R2), 'E'), 100), 'cancel', 'another record');
    t.eq(tripStep(trip(), n(rec('account', F, R1), 'E'), 100), 'cancel', 'another table');
    // Dynamics opened another form of the record (the target form isn't available): after TRIP_OTHER, found there.
    const t4 = trip();
    t.eq(tripStep(t4, n(rec('contact', F, R1), 'F', { ready: true }), 1000), 'wait');
    t.eq(tripStep(t4, n(rec('contact', F, R1), 'F', { ready: true }), 1000 + TRIP_OTHER), 'find');
    const t5: Trip = { target: toForm('account', G, R2), from: 'A', until: TRIP_WAIT, since: 0 };
    t.eq(tripStep(t5, n(from, 'A', { ready: true }), 1000 + TRIP_OTHER), 'wait', "the page it left is no answer (its unsaved-changes prompt may be open)");
    t.eq(tripStep(trip(), n(rec('contact', F, R1), 'F'), TRIP_WAIT), 'cancel', 'another form never ready: given up');
    // The other kinds of target.
    const list: Target = { to: 'list', entity: 'account', viewId: V, viewType: 'savedquery' };
    t.eq([arrived(list, listP('account', V)), arrived(list, listP('account', Q)), toward(list, listP('account', Q)), toward(list, listP('lead', V))], [true, false, true, false]);
    const dash: Target = { to: 'dashboard', dashboardId: D };
    t.eq([arrived(dash, dashP(D)), arrived(dash, dashP(Q)), toward(dash, { ...dashP(''), dashboardId: '' }), toward(dash, dashP(Q))], [true, false, true, false]);
    t.eq([arrived(toForm('contact', G), rec('contact', G, R2)), arrived(toForm('contact', G), rec('contact', F, R2))], [true, false], "a new record's form: any record of the table with that form");
  });
}
