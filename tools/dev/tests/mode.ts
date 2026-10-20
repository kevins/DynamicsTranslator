// Unit tests for translation mode's controller (inspector/mode.ts), the page list (inspector/pagelist.ts) and the
// bar's hint (ui/bar.ts): the pure helpers (label clicks, counts, notes, slot looks, re-anchoring, tab switching, list
// rows), and the controller itself on the overlay tests' fake page for finding a label from the list, also one staged on
// another page (going there, then finding it). The modules are imported lazily so a problem in one of their imports
// shows up as a failed test here.
import type { Kit } from './kit';
import { Store } from '../../../src/core/store';
import type { Slot } from '../../../src/core/model';
import type { Anchor, Look, PageItem, PageMode, Role, Switch } from '../../../src/inspector/types';
import type { AppApi } from '../../../src/ui/types';
import { El, withDom } from './fakedom';

const mode = () => import('../../../src/inspector/mode');
const list = () => import('../../../src/inspector/pagelist');
const bar = () => import('../../../src/ui/bar');

export function register(t: Kit): void {
  const item = (comp: string, look: Look, visible = true): PageItem => ({ comp, main: t.slot('field', `${comp}|Label`), group: 'Form', visible, look });
  const ctx = { base: 1033, user: 1033, langs: [{ lcid: 1033, name: 'English', isBase: true }, { lcid: 1036, name: 'French', isBase: false }] };
  const anchor = (key: string, role: Role = 'label', el: object = {}): Anchor => ({ el: el as Element, comp: key.split('|').slice(0, -1).join('|'), kind: 'entity', key, role });
  /** Records what a label click does (ClickFx). */
  const fx = () => {
    const log: string[] = [];
    return { log, move: (a: Anchor) => void log.push(`move ${a.key}`), open: (a: Anchor) => void log.push(`open ${a.key}`) };
  };
  /** Records what the popup's secondary action does (ActFx); each effect succeeds unless told otherwise. */
  const afx = (o: { nav?: boolean; tab?: boolean; click?: boolean; stage?: boolean; list?: boolean; pick?: boolean } = {}) => {
    const log: string[] = [];
    const click = (a: Anchor) => (log.push(`click ${a.key}`), o.click ?? true);
    return {
      log,
      nav: (_: Anchor, id: string) => (log.push(`nav ${id}`), o.nav ?? true),
      tab: (a: Anchor) => (log.push(`tab ${a.key}`), o.tab ?? true),
      click,
      // `stage`: its flyout is open already (no click), as mode.ts's actFx.stage.
      stage: (a: Anchor) => (o.stage ? (log.push(`open ${a.key}`), true) : click(a)),
      list: (sw: Switch) => (log.push(`list ${sw.list}`), o.list ?? true),
      pick: (sw: Switch) => (log.push(`pick ${sw.list} ${sw.id}`), o.pick ?? true),
    };
  };
  /** A page element with these attributes (`getAttribute` is all the action code reads). */
  const elWith = (attrs: Record<string, string>) => ({ getAttribute: (k: string) => attrs[k] ?? null });

  t.test('mode: a tab click only opens its popup (its Show tab switches)', async () => {
    const { clickLabel } = await mode();
    const tab = anchor('tab|f|t1|Label', 'tab');
    const f1 = fx();
    clickLabel(tab, null, f1);
    t.eq(f1.log, ['open tab|f|t1|Label']);
    // Another label's popup is open, with something typed in it: nothing blocks the click (the text stays staged).
    const f2 = fx();
    clickLabel(tab, { comp: 'field|f|c1', a: anchor('field|f|c1|Label'), want: 'field|f|c1|Label' }, f2);
    t.eq(f2.log, ['open tab|f|t1|Label']);
    // Its own popup is open: it stays, and moves to the clicked copy (e.g. in "More tabs").
    const f3 = fx();
    clickLabel(tab, { comp: tab.comp, a: anchor('tab|f|t1|Label', 'tab'), want: tab.key }, f3);
    t.eq(f3.log, ['move tab|f|t1|Label']);
  });

  t.test('mode: navigation, commands, stages, column headers and values open their popup instead of acting', async () => {
    const { clickLabel } = await mode();
    for (const role of ['nav', 'tab', 'command', 'stage', 'header', 'value', 'option', 'label'] as Role[]) {
      const f = fx();
      clickLabel(anchor('entity|account|DisplayName', role), null, f);
      t.eq(f.log, ['open entity|account|DisplayName'], role);
    }
    // The same text in another role is another place of the open popup's text only when the role matches.
    const f = fx();
    const now = { comp: 'entity|account', a: anchor('entity|account|DisplayName', 'header'), want: 'entity|account|DisplayName' };
    clickLabel(anchor('entity|account|DisplayName', 'nav'), now, f);
    t.eq(f.log, ['open entity|account|DisplayName']);
    // A docked popup (opened from the list) moves to a label showing the text it was opened for.
    const g = fx();
    clickLabel(anchor('entity|account|DisplayName', 'nav'), { ...now, a: null }, g);
    t.eq(g.log, ['move entity|account|DisplayName']);
  });

  t.test('mode: the pending count is every staged change in the store', async () => {
    const { countLabels } = await mode();
    const s = new Store();
    s.add([t.slot('field', 'a|Label'), t.slot('field', 'b|Label'), t.slot('attribute', 'w|Description')]);
    s.set('a|Label', 1036, 'A fr');
    s.set('a|Label', 1033, 'A en');
    s.set('b|Label', 1036, 'B fr');
    // Staged in the Workbench, not on this page: one Publish publishes it too.
    s.set('w|Description', 1036, 'Infobulle');
    const its = [item('a', 'edited'), item('b', 'edited'), item('c', 'missing'), item('d', 'ok', false)];
    t.eq(countLabels(its, s), { all: 4, missing: 1, pending: 4 });
    s.revert('a|Label');
    t.eq(countLabels(its, s).pending, 2, 'undone in a popup');
    s.set('b|Label', 1036, 'Nom');
    t.eq(countLabels(its, s).pending, 1, 'typed back to the published text: no change');
    t.eq(countLabels([], new Store()), { all: 0, missing: 0, pending: 0 });
  });

  t.test('mode: notes are the failed loads only, each with Try again', async () => {
    const { loadNotes } = await mode();
    t.eq(loadNotes([], () => {}), [], 'nothing failed: no note (no partial-language note, no hint)');
    let n = 0;
    const ns = loadNotes(['Could not load the form labels. Timeout', 'Could not load the form labels. Timeout', 'Could not load the app. 403'], () => n++);
    t.eq(ns.map((x) => [x.tone, x.text, x.action]), [
      ['error', 'Could not load the form labels. Timeout', 'Try again'],
      ['error', 'Could not load the app. 403', 'Try again'],
    ]);
    ns[1].run?.();
    t.eq(n, 1);
  });

  t.test("mode: a popup opened from the list shows the slot asked for, never another text of it", async () => {
    const { showing } = await mode();
    const name = anchor('entity|account|DisplayName');
    const plural = anchor('entity|account|DisplayCollectionName', 'nav');
    // The sitemap entry shows the table's plural name: it never stands for the table's name.
    t.eq(showing([plural, name], 'entity|account|DisplayName', 'entity|account|DisplayName'), [name]);
    t.eq(showing([plural], 'entity|account|DisplayName', 'entity|account|DisplayName'), [], 'only the plural is on screen: none');
    // Asked for the plural name: that one first, then the name.
    t.eq(showing([name, plural], 'entity|account|DisplayCollectionName', 'entity|account|DisplayName'), [plural, name]);
  });

  t.test('mode: after a re-render the popup finds its label again, never a label of another text', async () => {
    const { again } = await mode();
    const el = {};
    const old = anchor('entity|account|DisplayName', 'label', el);
    const sameEl = anchor('entity|account|DisplayName', 'label', el);
    const copy1 = anchor('entity|account|DisplayName', 'label');
    const copy2 = anchor('entity|account|DisplayName', 'label');
    const other = anchor('entity|account|DisplayCollectionName', 'nav');
    const K = 'entity|account|DisplayName';
    t.ok(again([copy1, sameEl, other], old, K, K) === sameEl, 'the same element');
    const rank = (a: Anchor) => (a === copy2 ? 1 : 5);
    t.ok(again([copy1, copy2, other], old, K, K, rank) === copy2, 'the nearest copy of the same text and role');
    const asHeader = anchor(K, 'header');
    t.ok(again([other, asHeader], old, K, K) === asHeader, 'the same text in another role');
    t.eq(again([other], old, K, K), null, 'another text of the component: none (it stays docked)');
    t.eq(again([], old, K, K), null);
    // Docked from the start (opened from the list): the first label showing what it is about.
    t.ok(again([other, copy1], null, K, K) === copy1);
    t.eq(again([other], null, K, K), null);
  });

  t.test("mode: a column or a choice of the page table is placed next to the field showing the column", async () => {
    const { columnOn } = await mode();
    const s = (kind: string, ref: Record<string, unknown>) => ({ ...t.slot(kind, `${kind}|k|Label`), entity: 'contoso_servicerequest', ref }) as Slot;
    t.eq(columnOn(s('attribute', { entity: 'contoso_servicerequest', attribute: 'contoso_Client' }), 'contoso_servicerequest'), 'contoso_client');
    t.eq(columnOn(s('status', { entity: 'contoso_servicerequest', attribute: 'statuscode', value: 1 }), 'contoso_servicerequest'), 'statuscode');
    t.eq(columnOn(s('globaloption', { usedBy: ['contact.x', 'contoso_servicerequest.contoso_urgency'] }), 'contoso_servicerequest'), 'contoso_urgency');
    t.eq(columnOn(s('attribute', { entity: 'contoso_tasking', attribute: 'contoso_status' }), 'contoso_servicerequest'), '', 'a sub-grid table column');
    t.eq(columnOn(s('field', { datafield: 'contoso_client' }), 'contoso_servicerequest'), '', 'a field is placed by its own label');
    t.eq(columnOn(undefined, 'contoso_servicerequest'), '');
    t.eq(columnOn(s('attribute', { entity: 'a', attribute: 'b' }), ''), '', 'no page table (dashboard)');
  });

  t.test("mode: a label showing another slot (a table's plural name) gets that slot's look", async () => {
    const { slotLook } = await mode();
    const s = new Store();
    const pl = { ...t.slot('entity', 'entity|account|DisplayCollectionName', { 1033: 'Accounts' }), prop: 'DisplayCollectionName' } as Slot;
    s.add([pl]);
    const app = { store: s, ctx, prefs: { target: 1036 } } as never;
    const k = pl.key;
    t.eq(slotLook(app, s.get(k)!), 'missing', 'the main label may be translated, the plural is not');
    s.set(k, 1036, 'Comptes');
    t.eq(slotLook(app, s.get(k)!), 'edited', 'staged, not published');
    s.revert(k, 1036);
    s.add([{ ...pl, labels: { 1033: 'Accounts', 1036: 'Comptes' } }]);
    t.eq(slotLook(app, s.get(k)!), 'ok');
    // A publish attempt failed for it (the store keeps the cell's status while it holds that text).
    s.status.set(`${k}#1036`, { outcome: 'error', message: 'Too long' });
    t.eq(slotLook(app, s.get(k)!), 'error');
    s.status.clear();
    // Emptying a metadata translation (Dataverse keeps it): staged like any change, and published as its English text
    // (model.ts standIn; the popup says what it becomes), as status.look does.
    s.set(k, 1036, '');
    t.eq(slotLook(app, s.get(k)!), 'edited');
    t.eq(slotLook(app, { ...s.get(k)!, readOnly: 'Not renameable' }), 'ro');
    s.revert(k, 1036);
    t.eq(slotLook({ store: s, ctx, prefs: { target: 1033 } } as never, s.get(k)!), 'ok', 'translating into the base language');
  });

  t.test('mode: switching form tabs uses the form API and never throws', async () => {
    const { focusTab } = await mode();
    const seen: string[] = [];
    const xrm = { Page: { ui: { tabs: { get: (n: string) => (n === 'general' ? { setFocus: () => seen.push(n) } : null) } } } };
    t.eq(focusTab(xrm, 'general'), true);
    t.eq(seen, ['general']);
    t.eq(focusTab(xrm, 'other'), false, 'no such tab');
    t.eq(focusTab(xrm, ''), false);
    t.eq(focusTab({ Page: { ui: { tabs: { get: () => ({ setFocus: () => { throw new Error('gone'); } }) } } } }, 'x'), false, 'form being replaced');
    t.eq(focusTab(undefined, 'x'), false, 'dashboard (no form)');
  });

  t.test('mode: opening a related menu item uses the navigation API and never throws', async () => {
    const { focusNav } = await mode();
    const seen: string[] = [];
    const xrm = { Page: { ui: { navigation: { items: { get: (n: string) => (n === 'navConnections' ? { setFocus: () => seen.push(n) } : null) } } } } };
    t.eq(focusNav(xrm, 'navConnections'), true);
    t.eq(seen, ['navConnections']);
    t.eq(focusNav(xrm, 'navAudit'), false, 'no such item');
    t.eq(focusNav(xrm, ''), false);
    t.eq(focusNav({ Page: { ui: { navigation: { items: { get: () => ({ setFocus: () => { throw new Error('gone'); } }) } } } } }, 'x'), false, 'form being replaced');
    t.eq(focusNav(undefined, 'navConnections'), false, 'no form');
  });

  t.test("mode: the popup's secondary action: Open through the navigation API, else a click; Show stage and Show tab; never on another role", async () => {
    const { runAction } = await mode();
    // A related menu item, gone with its menu (detached): its nav id still opens its view.
    const item = anchor('builtin|nav|navConnections|Label', 'nav', elWith({ 'data-id': 'form-tab-relatedEntity-navConnections' }));
    const f1 = afx();
    t.eq(runAction('Open', item, f1), true);
    t.eq(f1.log, ['nav navConnections']);
    // The navigation API can't (not a record form): a click like the user's.
    const f2 = afx({ nav: false });
    t.eq(runAction('Open', item, f2), true);
    t.eq(f2.log, ['nav navConnections', 'click builtin|nav|navConnections|Label']);
    t.eq(runAction('Open', item, afx({ nav: false, click: false })), false, 'nothing could be done: the popup stays open');
    // The tab of the view an item opened: the same nav id.
    const tabOfView = anchor('builtin|nav|navConnections|Label', 'nav', elWith({ 'data-id': 'tablist-navConnections' }));
    const f3 = afx();
    runAction('Open', tabOfView, f3);
    t.eq(f3.log, ['nav navConnections']);
    // A sitemap entry and the Related tab: a click (the Related tab's data-id is no nav id).
    const f4 = afx();
    t.eq(runAction('Open', anchor('subarea|sm|x|Title', 'nav'), f4), true);
    t.eq(f4.log, ['click subarea|sm|x|Title']);
    const f5 = afx();
    runAction('Open', anchor('builtin|tab|related|Label', 'nav', elWith({ 'data-id': 'tablist-tab_related3b554255-7717-4d17-bb7f-9936fb1e75ca' })), f5);
    t.eq(f5.log, ['click builtin|tab|related|Label']);
    // Never on a command, a value or a stage.
    for (const role of ['stage', 'command', 'value'] as Role[]) {
      const f = afx();
      t.eq([runAction('Open', anchor('command|b1|Label', role), f), f.log], [false, []], role);
    }
    const f6 = afx();
    t.eq(runAction('Show stage', anchor('stage|w|st|Label', 'stage'), f6), true);
    t.eq(f6.log, ['click stage|w|st|Label']);
    // Its flyout opened since the popup did: done, without the click that would close it.
    const f6b = afx({ stage: true });
    t.eq(runAction('Show stage', anchor('stage|w|st|Label', 'stage'), f6b), true);
    t.eq(f6b.log, ['open stage|w|st|Label']);
    t.eq(runAction('Show stage', anchor('stage|w|st|Label', 'stage'), afx({ click: false })), false, 'no chip to click: the popup says so');
    t.eq(runAction('Show stage', anchor('stage|w|st|Label', 'nav'), afx()), false);
    const f7 = afx();
    t.eq(runAction('Show tab', anchor('tab|f|t1|Label', 'tab'), f7), true);
    t.eq(f7.log, ['tab tab|f|t1|Label']);
    t.eq(runAction('Show tab', anchor('section|f|s1|Label', 'label'), afx()), false);
    t.eq(runAction('', anchor('tab|f|t1|Label', 'tab'), afx()), false);
  });

  t.test("mode: the popup's Change area / form / view opens its selector's list; Open on an item of such a list switches to it, never by a click on the item gone with its list", async () => {
    const { runAction } = await mode();
    const sw = (list: Switch['list'], id = ''): Switch => ({ list, id, opener: null, find: '', item: '' });
    const at = (key: string, role: Role, s: Switch) => ({ ...anchor(key, role), sw: s });
    for (const list of ['area', 'form', 'view'] as const) {
      const f = afx();
      t.eq([runAction(`Change ${list}`, at('area|sm|a|Title', 'label', sw(list)), f), f.log], [true, [`list ${list}`]], list);
    }
    t.eq(runAction('Change area', at('area|sm|a|Title', 'nav', sw('area')), afx({ list: false })), false, 'no button to open it with: the popup says so');
    // Never on another selector's list, an item, or a label of no selector.
    const f1 = afx();
    t.eq([runAction('Change form', at('area|sm|a|Title', 'nav', sw('area')), f1), runAction('Change area', at('area|sm|a|Title', 'nav', sw('area', 'a')), f1), runAction('Change view', anchor('view|v|Name'), f1), f1.log], [false, false, false, []]);
    // Open on an item: switches (lists.ts), never the click on the label that a sitemap entry gets.
    const f2 = afx();
    t.eq([runAction('Open', at('form|f2|Name', 'nav', sw('form', 'f2')), f2), f2.log], [true, ['pick form f2']]);
    const f3 = afx({ pick: false });
    t.eq([runAction('Open', at('view|v2|Name', 'nav', sw('view', 'v2')), f3), f3.log], [false, ['pick view v2']], 'nothing could be started: the popup stays open');
    const f4 = afx();
    t.eq([runAction('Open', at('area|sm|a|Title', 'nav', sw('area')), f4), f4.log], [false, []], "the switcher's own label: no Open");
  });

  t.test('mode: switching from a closed list: a form through the form API; an area or a view by opening its list again and clicking the item once it shows, else a toast', async () => {
    const { openList, switchTo, PICK_WAIT, NOT_SHOWN } = await import('../../../src/inspector/lists');
    /** A page element: attributes, connected or not, in an open list or not. */
    const node = (attrs: Record<string, string>, o: { gone?: boolean; inList?: boolean } = {}) =>
      ({ isConnected: !o.gone, getAttribute: (k: string) => attrs[k] ?? null, closest: () => (o.inList === false ? null : {}) }) as unknown as Element;
    /** The page as ListFx: what `find` finds by selector (a function: what shows by now), timers run by hand. */
    const page = (found: Record<string, Element | ((n: number) => Element | null)>, forms: Array<{ getId(): string; navigate(): void }> = []) => {
      const log: string[] = [];
      let t0 = 0;
      const q: Array<[number, () => void]> = [];
      const name = (el: Element) => el.getAttribute('data-id') || el.getAttribute('data-value') || '?';
      const fx = {
        xrm: { Page: { ui: { formSelector: { items: { get: (id?: string) => (id === undefined ? forms : (forms.find((f) => f.getId() === id) ?? null)) } } } } },
        find: (sel: string) => {
          const f = found[sel];
          return typeof f === 'function' ? f(t0) : (f ?? null);
        },
        click: (el: Element) => void log.push(`click ${name(el)}`),
        later: (fn: () => void, ms: number) => void q.push([t0 + ms, fn]),
        now: () => t0,
        fail: (m: string) => void log.push(`toast ${m}`),
      };
      /** Runs the timers due until `until` ms. */
      const run = (until: number) => {
        for (let i = 0; i < 1000 && q.length; i++) {
          q.sort((a, b) => a[0] - b[0]);
          if (q[0][0] > until) break;
          const [at, fn] = q.shift()!;
          t0 = at;
          fn();
        }
        t0 = until;
      };
      return { fx, log, run };
    };
    // A form: the form API (by its id; ids come in capitals and with braces), once the popup has closed.
    const navigated: string[] = [];
    const forms = ['{8448B78F-8F42-454E-8E2A-F8196B0419AF}', '{B053A39A-041A-4356-ACEF-DDF00182762B}'].map((id) => ({ getId: () => id, navigate: () => void navigated.push(id) }));
    const p1 = page({}, forms);
    const F2 = 'b053a39a-041a-4356-acef-ddf00182762b';
    t.eq(switchTo({ list: 'form', id: F2, opener: null, find: '', item: '' }, p1.fx), true);
    t.eq(navigated, [], 'not while the popup is still open');
    p1.run(0);
    t.eq(navigated, ['{B053A39A-041A-4356-ACEF-DDF00182762B}']);
    t.eq(switchTo({ list: 'form', id: '0d2b9c11-0000-4000-8000-000000000009', opener: null, find: '', item: '' }, page({}, forms).fx), false, 'a form the page has not: nothing to do');
    t.eq(switchTo({ list: 'form', id: F2, opener: null, find: '', item: '' }, { ...p1.fx, xrm: {} }), false, 'no form API');
    // An area: the switcher is clicked again (the one kept with the item while it is on the page), then the item.
    const AREA = '[role="menuitemradio"][data-id="areaswitcherflyout-dxt_area2"]';
    const sw = node({ 'data-id': 'sitemap-areaSwitcher-expand-btn', 'aria-expanded': 'false' });
    const item = node({ 'data-id': 'areaswitcherflyout-dxt_area2' });
    const p2 = page({ [AREA]: (n) => (n >= 200 ? item : null) });
    t.eq(switchTo({ list: 'area', id: 'dxt_area2', opener: sw, find: '#areaSwitcherId', item: AREA }, p2.fx), true);
    t.eq(p2.log, [], 'not while the popup is still open');
    p2.run(150);
    t.eq(p2.log, ['click sitemap-areaSwitcher-expand-btn'], 'the list opens; its item is not there yet');
    p2.run(1000);
    t.eq(p2.log, ['click sitemap-areaSwitcher-expand-btn', 'click areaswitcherflyout-dxt_area2']);
    // Rendered anew since: found again by its selector. Its list open already: no click on it (that would close it).
    const again = node({ 'data-id': 'sitemap-areaSwitcher-expand-btn', 'aria-expanded': 'true' });
    const p3 = page({ '#areaSwitcherId': again, [AREA]: item });
    t.eq(switchTo({ list: 'area', id: 'dxt_area2', opener: node({}, { gone: true }), find: '#areaSwitcherId', item: AREA }, p3.fx), true);
    p3.run(0);
    t.eq(p3.log, ['click areaswitcherflyout-dxt_area2']);
    t.eq(switchTo({ list: 'area', id: 'dxt_area2', opener: null, find: '#areaSwitcherId', item: AREA }, page({}).fx), false, 'no switcher on the page: the popup says so');
    // A view whose item never shows (or only outside any list): the user is told, nothing else is clicked.
    const V2 = '6b3e6539-38ab-406f-9aaa-192e75e9d23c';
    const VIEW = `[role="menuitemradio"][data-value="${V2}"]`;
    const btn = node({ 'data-id': 'ViewSelector_c0976d89-355d-4954-acfc-ade8835cbf4c', 'aria-expanded': 'false' });
    const p4 = page({ [VIEW]: node({ 'data-value': V2 }, { inList: false }) });
    t.eq(switchTo({ list: 'view', id: V2, opener: btn, find: 'button[data-id="ViewSelector_c0976d89-355d-4954-acfc-ade8835cbf4c"]', item: VIEW }, p4.fx), true);
    p4.run(PICK_WAIT - 100);
    t.eq(p4.log, ['click ViewSelector_c0976d89-355d-4954-acfc-ade8835cbf4c'], 'still looking');
    p4.run(PICK_WAIT + 500);
    t.eq(p4.log, ['click ViewSelector_c0976d89-355d-4954-acfc-ade8835cbf4c', `toast ${NOT_SHOWN.view}`]);
    // The view's item shows: clicked.
    const p5 = page({ [VIEW]: node({ 'data-value': V2 }) });
    switchTo({ list: 'view', id: V2, opener: btn, find: '', item: VIEW }, p5.fx);
    p5.run(0);
    t.eq(p5.log, ['click ViewSelector_c0976d89-355d-4954-acfc-ade8835cbf4c', `click ${V2}`]);
    t.eq(switchTo({ list: 'view', id: '', opener: btn, find: '', item: '' }, page({}).fx), false, "a selector's own label switches to nothing");
    // Change …: a click on the selector's button once the popup has closed, never while its list is open.
    const p6 = page({});
    t.eq(openList({ list: 'form', id: '', opener: node({ 'data-id': 'form-selector', 'aria-expanded': 'false' }), find: '[data-id="form-selector"]', item: '' }, p6.fx), true);
    t.eq(p6.log, []);
    p6.run(0);
    t.eq(p6.log, ['click form-selector']);
    const p7 = page({});
    t.eq(openList({ list: 'view', id: '', opener: node({ 'data-id': 'ViewSelector_x', 'aria-expanded': 'true' }), find: '', item: '' }, p7.fx), true);
    p7.run(0);
    t.eq(p7.log, [], 'its list is open already');
    t.eq(openList({ list: 'area', id: '', opener: node({}, { gone: true }), find: '#areaSwitcherId', item: '' }, page({}).fx), false, 'gone, and not found again');
  });

  t.test("mode: Change … and Open on the page (listActs): the selector's button found in the document and clicked a tick later, a form through the page's form API, a warning toast when it couldn't be done, nothing once translation mode stopped", async () => {
    const { listActs } = await mode();
    const g = globalThis as Record<string, unknown>;
    const had = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const log: string[] = [];
    const button = { isConnected: true, getAttribute: (k: string) => (k === 'aria-expanded' ? 'false' : null), click: () => void log.push('click') };
    Object.defineProperty(globalThis, 'document', { value: { querySelector: (s: string) => (s === '[data-id="form-selector"]' ? button : null) }, configurable: true, writable: true });
    const tick = () => new Promise((r) => setTimeout(r, 5));
    try {
      const F2 = 'b053a39a-041a-4356-acef-ddf00182762b';
      let broken = false;
      const form = {
        getId: () => `{${F2.toUpperCase()}}`,
        navigate: () => {
          if (broken) throw new Error('busy');
          log.push('navigate');
        },
      };
      const toasts: string[] = [];
      let live = true;
      const app = { ctx: { ...ctx, xrm: { Page: { ui: { formSelector: { items: { get: (id?: string) => (id === undefined ? [form] : null) } } } } } }, toast: (m: string, k: string) => void toasts.push(`${k} ${m}`) } as unknown as AppApi;
      const acts = listActs(app, () => live);
      const own: Switch = { list: 'form', id: '', opener: null, find: '[data-id="form-selector"]', item: '' };
      t.eq([acts.list(own), log], [true, []], 'Change form: not while the popup is open');
      await tick();
      t.eq(log, ['click'], "the page's button, found by its selector");
      const f2: Switch = { list: 'form', id: F2, opener: null, find: '[data-id="form-selector"]', item: '' };
      t.eq(acts.pick(f2), true);
      await tick();
      t.eq(log, ['click', 'navigate'], 'Open: the form API');
      broken = true;
      acts.pick(f2);
      await tick();
      t.eq(toasts, [`warn ${(await import('../../../src/inspector/lists')).NOT_SHOWN.form}`], 'the form API refused: a warning toast');
      // Translation mode stopped before the tick: nothing reaches the page.
      broken = false;
      acts.list(own);
      acts.pick(f2);
      live = false;
      await tick();
      t.eq([log, toasts.length], [['click', 'navigate'], 1]);
    } finally {
      if (had) Object.defineProperty(globalThis, 'document', had);
      else delete g.document;
    }
  });

  t.test("mode: the keyboard goes back to the button of the list an item's popup came from (focusOpener): the one kept with it, else found again", async () => {
    const { focusOpener } = await import('../../../src/inspector/lists');
    const focused: string[] = [];
    const btn = (name: string, connected = true) => ({ isConnected: connected, focus: (o: { preventScroll?: boolean }) => void focused.push(`${name}${o?.preventScroll ? '' : ' (scrolled)'}`) }) as unknown as Element;
    const found = btn('found');
    const find = (s: string) => (s === '#areaSwitcherId' ? found : null);
    t.eq(focusOpener({ list: 'area', id: 'a2', opener: btn('kept'), find: '#areaSwitcherId', item: '' }, { find }), true);
    t.eq(focusOpener({ list: 'area', id: 'a2', opener: btn('gone', false), find: '#areaSwitcherId', item: '' }, { find }), true);
    t.eq(focused, ['kept', 'found'], 'never scrolled to');
    t.eq(focusOpener({ list: 'view', id: 'v2', opener: null, find: 'button[data-id="ViewSelector_x"]', item: '' }, { find }), false, 'not on the page');
    t.eq(focusOpener(undefined, { find }), false, 'a label of no list');
  });

  t.test('mode: a popup whose label left with its menu stays where the label was; one never anchored docks', async () => {
    const { restRect } = await mode();
    const at = { left: 10, top: 20 } as DOMRect;
    const near = { left: 300, top: 40 } as DOMRect;
    t.ok(restRect(near, true, at) === near, 'a label near it wins');
    t.ok(restRect(null, true, at) === at, 'the menu closed as the popup was used: where its label was');
    t.eq(restRect(null, false, at), null, 'scrolled away or hidden: docked, as before');
    t.eq(restRect(null, true, null), null, 'opened from the list');
  });

  t.test('mode: opened from a list row, the popup points at its label unless the sheet covers it, docked or floating where it was dragged; else at the row, beside the sheet', async () => {
    const { rowAnchor } = await mode();
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;
    /** A row of a sheet at `sheet` (null: a row outside a sheet), in a 1366 × 650 window. */
    const rowIn = (sheet: DOMRect | null) => {
      const at = sheet ? rect(sheet.left + 1, sheet.top + 200, sheet.width - 2, 44) : rect(0, 0, 100, 20);
      const el = { getBoundingClientRect: () => sheet! };
      return { at, row: { closest: (sel: string) => (sel === '.pgl' && sheet ? el : null), getBoundingClientRect: () => at } as unknown as Element };
    };
    const status = rect(1000, 300, 200, 24); // Status, on the right of the form
    const docked = rowIn(rect(1006, 0, 360, 650));
    t.eq(rowAnchor(status, docked.row, 1366), { at: docked.at, by: rect(1006, 0, 360, 650) }, 'docked over it: the row, beside the sheet');
    t.eq(rowAnchor(rect(200, 300, 120, 24), docked.row, 1366), null, 'docked, a label left of it: the label');
    // Dragged to the left edge (pagelist.ts floatBox: 8, 8) to uncover Status.
    const left = rowIn(rect(8, 8, 360, 618));
    t.eq(rowAnchor(status, left.row, 1366), null, 'floating at the left: Status, which it no longer covers');
    t.eq(rowAnchor(rect(100, 300, 120, 24), left.row, 1366), { at: left.at, by: rect(8, 8, 360, 618) }, 'a label under it: the row');
    t.eq(rowAnchor(rect(360, 300, 120, 24), left.row, 1366)?.at, left.at, 'partly under it');
    t.eq(rowAnchor(rect(100, 630, 120, 24), left.row, 1366), null, 'below it: the label');
    t.eq(rowAnchor(null, left.row, 1366), { at: left.at, by: rect(8, 8, 360, 618) }, 'no label shown: the row');
    // A row outside a sheet: only what is past the window's right edge counts as hidden.
    const loose = rowIn(null);
    t.eq([rowAnchor(status, loose.row, 1366), rowAnchor(rect(1300, 300, 120, 24), loose.row, 1366)], [null, { at: loose.at, by: null }]);
  });

  t.test('bar: the hint names the target language and the grey marks of text that can\'t be translated here, and leaves orange out with one language', async () => {
    const { hintText } = await bar();
    t.eq(hintText('French'), "Click any highlighted text to translate it. Orange = no French yet, green = changed, not published yet, grey = can't be translated here. Hold Alt to click normally.");
    t.eq(hintText(null), "Click any highlighted text to translate it. Green = changed, not published yet, grey = can't be translated here. Hold Alt to click normally.");
  });

  t.test('bar: it keeps right of the left navigation, and never covers the area switcher at its foot', async () => {
    const { barSpan, clearOf } = await bar();
    const nav = { left: 0, top: 48, right: 200, bottom: 940 };
    t.eq(barSpan(1320, null, nav), [200, 1320], 'right of the navigation');
    t.eq(barSpan(1320, 900, nav), [200, 900], 'and left of the All labels sheet');
    t.eq(barSpan(1320, null, { ...nav, right: 48 }), [48, 1320], 'a collapsed navigation');
    t.eq(barSpan(1320, null, null), [0, 1320], 'no navigation on the page');
    t.eq(barSpan(640, null, nav), [0, 640], 'too narrow beside it: the whole width');
    t.eq(barSpan(1320, null, { ...nav, left: 400, right: 600 }), [0, 1320], 'not at the left edge: not the navigation');
    const sw = { left: 0, top: 899, right: 199, bottom: 941 };
    t.eq(clearOf(876, 48, 141, 1040, sw), 843, 'over the switcher: raised above it');
    t.eq(clearOf(876, 48, 208, 1040, sw), 876, 'beside it: unchanged');
    t.eq(clearOf(300, 48, 0, 600, sw), 300, 'above it: unchanged');
    t.eq(clearOf(876, 48, 141, 1040, null), 876, 'no switcher');
    const { navWith } = await bar();
    const rail = { left: 0, top: 48, right: 48, bottom: 940 };
    const areas = { left: 0, top: 795, right: 200, bottom: 900 };
    t.eq(barSpan(1320, null, navWith(rail, areas)), [200, 1320], 'the open list of areas, wider than a collapsed navigation');
    t.eq(navWith(rail, null), rail, 'the list closed');
    t.eq(navWith(null, areas), null, 'no navigation');
    t.eq(navWith(rail, { ...areas, left: 400, right: 600 }), rail, 'a list elsewhere is not the switcher\'s');
  });

  t.test('page list: filters and row states', async () => {
    const { passes, rowState } = await list();
    t.eq(['missing', 'edited', 'error', 'ok', 'ro', 'na'].map((l) => passes(item('a', l as Look), 'changed')), [false, true, true, false, false, false]);
    t.eq(['missing', 'edited', 'ok'].map((l) => passes(item('a', l as Look), 'todo')), [true, false, false]);
    t.ok(passes(item('a', 'ro'), 'all'));
    t.eq(rowState('missing', ''), { text: 'Not translated', cls: 'is-miss' });
    t.eq(rowState('edited', 'Nom'), { text: 'Nom', cls: 'is-chg' }, 'the staged text, marked as changed');
    t.eq(rowState('error', 'Nom'), { text: 'Nom', cls: 'is-bad' });
    t.eq(rowState('ro', 'Nom'), { text: 'Read-only', cls: 'is-ro' });
    t.eq(rowState('builtin', 'Vérifier l’accès'), { text: 'Built-in', cls: 'is-na' }, 'read-only and in every language: grey, no lock');
    t.eq(rowState('ok', 'Nom'), { text: 'Nom', cls: '' });
    t.eq(rowState('na', ''), { text: '', cls: 'is-na' });
  });

  t.test('page list: a cell without a label of its own shows the column name', async () => {
    const { baseText } = await list();
    const s = new Store();
    const cell = (id: string, labels: Record<number, string>, ref: Record<string, unknown>, path: string[]) =>
      ({ ...t.slot('field', `field|f|${id}|Label`, labels), comp: `field|f|${id}`, entity: 'contoso_servicerequest', title: id, path, ref }) as Slot;
    const c1 = cell('c1', { 1033: 'Client' }, { area: 'body', datafield: 'contoso_client' }, ['Service request', 'Main (Main form)', 'General', 'Request']);
    const c3 = cell('c3', {}, { area: 'body', datafield: 'contoso_title' }, ['Service request', 'Main (Main form)', 'Details', 'Writing']);
    const col = { ...t.slot('attribute', 'attribute|contoso_servicerequest.contoso_title|DisplayName', { 1033: 'Title', 1036: 'Titre' }), comp: 'attribute|contoso_servicerequest.contoso_title', title: 'Title' } as Slot;
    s.add([c1, c3, col]);
    t.eq(baseText(s, 1033, c1, c1.comp), 'Client');
    t.eq(baseText(s, 1033, c3, c3.comp), 'Title', 'no label of its own: the column name the form shows');
  });

  t.test('mode: a find waiting for a label on another tab stops on cancelFind (the list closed): no popup opens after', async () => {
    const { install, dom } = await import('./overlay-dom');
    const { createPageMode } = await mode();
    const undo = install();
    const g = globalThis as Record<string, unknown>;
    const hadLoc = Object.getOwnPropertyDescriptor(globalThis, 'location');
    const F = '0f1e2d3c-4b5a-4968-8776-655443322110';
    const url = `https://org.crm.dynamics.com/main.aspx?pagetype=entityrecord&etn=account&id=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee&formid=${F}`;
    Object.defineProperty(globalThis, 'location', { value: { href: url, search: url.slice(url.indexOf('?')) }, configurable: true, writable: true });
    // The find's deadline is Date.now() + 1.5 s: moved forward instead of waited for.
    const realNow = Date.now;
    let skew = 0;
    Date.now = () => realNow() + skew;
    let m: PageMode | null = null;
    try {
      const store = new Store();
      const cell = { ...t.slot('field', `field|${F}|c1|Label`, { 1033: 'Fax', 1036: 'Télécopie' }), comp: `field|${F}|c1`, entity: 'account', ref: { formId: F, area: 'body', tabName: 'details', sectionName: 's1', controlId: 'fax', datafield: 'fax' } } as Slot;
      store.add([cell]);
      const focused: string[] = [];
      const xrm = { Page: { ui: { tabs: { get: (n: string) => ({ setFocus: () => focused.push(n) }) } } } };
      // A popup that opens adopts its styles first (ui/callout.ts); one that can't be built falls back to the editor.
      const popups: string[] = [];
      const app = {
        store,
        ctx: { ...ctx, xrm },
        prefs: { target: 1036, shown: [] },
        root: { host: { addEventListener() {}, removeEventListener() {} }, activeElement: null },
        lang: {},
        providers: new Proxy({}, { get: () => async () => [] }),
        adoptStyles: () => void popups.push('popup'),
        edit: (c: string) => void popups.push(`editor ${c}`),
      } as unknown as AppApi;
      m = createPageMode(app);
      m.start();
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      /** Runs the frames asked for (the fake keeps the last one asked). */
      const frames = () => {
        for (let i = 0; i < 6 && dom.raf; i++) {
          const f = dom.raf;
          dom.raf = null;
          f();
        }
      };
      const find = async (cancel: 'waiting' | 'landing' | null) => {
        skew = 0;
        t.ok(m!.open(cell.comp), 'a find');
        if (cancel === 'waiting') m!.cancelFind();
        skew = 5000; // its wait is over: the next poll lands
        await wait(250);
        if (cancel === 'landing') m!.cancelFind(); // landed, the page not measured again yet
        frames();
      };
      await find('waiting');
      t.eq([focused, popups], [['details'], []], 'its tab opened; cancelled while waiting: no popup');
      await find('landing');
      t.eq(popups, [], 'cancelled before it landed: none either');
      await find(null);
      t.ok(popups.length > 0, 'not cancelled: it opens once the wait is over');
    } finally {
      m?.destroy();
      await new Promise((r) => setTimeout(r, 20));
      Date.now = realNow;
      if (hadLoc) Object.defineProperty(globalThis, 'location', hadLoc);
      else delete g.location;
      undo();
    }
  });

  t.test('mode: created on a Store that already holds changes (made before the mode, as in the Workbench): it starts, and lists them under Workbench', async () => {
    const { install } = await import('./overlay-dom');
    const { createPageMode } = await mode();
    const undo = install();
    const g = globalThis as Record<string, unknown>;
    const hadLoc = Object.getOwnPropertyDescriptor(globalThis, 'location');
    const url = 'https://org.crm.dynamics.com/main.aspx?pagetype=entitylist&etn=account';
    Object.defineProperty(globalThis, 'location', { value: { href: url, search: url.slice(url.indexOf('?')) }, configurable: true, writable: true });
    let m: PageMode | null = null;
    try {
      const store = new Store();
      const col = { ...t.slot('attribute', 'attribute|lead.subject|DisplayName', { 1033: 'Topic', 1036: 'Sujet' }), comp: 'attribute|lead.subject', entity: 'lead', ref: { entity: 'lead', attribute: 'subject' } } as Slot;
      store.add([col]);
      store.set(col.key, 1036, 'Objet');
      const app = {
        store,
        ctx: { ...ctx, xrm: {} },
        prefs: { target: 1036, shown: [] },
        root: { host: { addEventListener() {}, removeEventListener() {} }, activeElement: null },
        lang: {},
        providers: new Proxy({}, { get: () => async () => [] }),
        adoptStyles() {},
        edit() {},
      } as unknown as AppApi;
      m = createPageMode(app);
      m.start();
      t.eq(m.items().map((i) => [i.comp, i.away]), [[col.comp, 'Workbench']], 'made before the mode: no page');
    } finally {
      m?.destroy();
      await new Promise((r) => setTimeout(r, 20));
      if (hadLoc) Object.defineProperty(globalThis, 'location', hadLoc);
      else delete g.location;
      undo();
    }
  });

  t.test("mode: a change staged while a popup is open takes the popup's place only when the popup edits that text; another one (an older step redone with Ctrl+Y) goes by its own label", async () => {
    const { stagedAt, modelKeys } = await mode();
    const page = { type: 'entityrecord', entity: 'account', recordId: 'r1', formId: 'f1', viewId: '', viewType: '', dashboardId: '' } as const;
    const spot = (o: Record<string, unknown> = {}) => ({ tab: '', nav: '', header: false, stage: '', ...o });
    const keys = modelKeys({
      blocks: [
        { key: 'field|f1|fax|Label', heading: 'Label', long: false, also: { keys: ['field|f1|fax1|Label'], on: true } },
        { key: 'attribute|account.fax|DisplayName', heading: 'Column name', long: false },
      ],
      choices: { keys: ['option|account.x|1|Label'], open: false },
    });
    t.eq([...keys], ['field|f1|fax|Label', 'attribute|account.fax|DisplayName', 'field|f1|fax1|Label', 'option|account.x|1|Label'], 'its blocks, their copies on the form, its choices');
    const open = { comp: 'field|f1|fax', keys, spot: spot({ nav: 'nav_x' }) };
    const own = () => spot({ tab: 'summary' });
    const here = (...cs: string[]) => (c: string) => cs.includes(c);
    t.eq(stagedAt('attribute|account.fax|DisplayName', 'attribute|account.fax', page, open, here('field|f1|fax'), own), { page, spot: spot({ nav: 'nav_x' }) }, "a text the popup edits with its label: the popup's place");
    t.eq(stagedAt('field|f1|fax1|Label', 'field|f1|fax1', page, open, here('field|f1|fax', 'field|f1|fax1'), own), { page, spot: spot({ nav: 'nav_x' }) }, "a copy it writes too: the popup's place");
    // Redone while the popup is open: a change of another page is not made here; one of this page goes by its own label.
    t.eq(stagedAt('field|f9|x|Label', 'field|f9|x', page, open, here('field|f1|fax'), own), null, 'of another page: none (it was never changed here)');
    t.eq(stagedAt('field|f1|y|Label', 'field|f1|y', page, open, here('field|f1|fax', 'field|f1|y'), own), { page, spot: spot({ tab: 'summary' }) }, 'of this page: where its own label is');
    t.eq(stagedAt('attribute|account.fax|DisplayName', 'attribute|account.fax', null, open, here('field|f1|fax'), own), null, 'paused or not on a page');
    t.eq(stagedAt('field|f1|y|Label', 'field|f1|y', page, null, here('field|f1|y'), own), { page, spot: spot({ tab: 'summary' }) }, 'no popup: where its label is');
  });

  // ---- a label of another page ----

  /**
   * The controller on the fake page, the page named by the URL only (no page context): `go` shows another page; the
   * page's navigation API records what it is asked to do (and does nothing), the form selector lists `forms`. The tab
   * shown is `page.tab` (the tab bar's selected `tablist-<name>`); a tab or a related view the form API is asked to
   * show becomes the one shown, as in Dynamics.
   */
  const onOtherPages = async (fn: (k: {
    m: PageMode;
    store: Store;
    go(page: string): void;
    /** Starts the mode again on this page (the tracker sees it at once). */
    restart(page: string): void;
    navs: unknown[];
    popups: string[];
    focused: string[];
    /** Related views opened through the navigation API (their nav ids). */
    views: string[];
    page: { tab: string };
    /** The record's forms the form selector lists (ids as Dynamics gives them); the test may change it. */
    forms: string[];
    /** Lets the find's timers run (`ms` real time), the clock `skew` ms ahead. */
    after(ms: number, skew?: number): Promise<void>;
  }) => Promise<void>) => {
    const { install, dom, FakeEl } = await import('./overlay-dom');
    const { createPageMode } = await mode();
    const undo = install();
    const page = { tab: '' };
    const doc = document as unknown as { querySelectorAll(s: string): unknown[] };
    const all = doc.querySelectorAll;
    doc.querySelectorAll = (s: string) => {
      if (!s.startsWith('li[role="tab"][aria-selected="true"]')) return all(s);
      const li = new FakeEl('LI');
      li.setAttribute('data-id', `tablist-${page.tab}`);
      return page.tab ? [li] : [];
    };
    const g = globalThis as Record<string, unknown>;
    const hadLoc = Object.getOwnPropertyDescriptor(globalThis, 'location');
    const realNow = Date.now;
    let skew = 0;
    Date.now = () => realNow() + skew;
    let m: PageMode | null = null;
    try {
      const go = (q: string) => {
        const url = `https://org.crm.dynamics.com/main.aspx?${q}`;
        Object.defineProperty(globalThis, 'location', { value: { href: url, search: url.slice(url.indexOf('?')) }, configurable: true, writable: true });
      };
      const store = new Store();
      const navs: unknown[] = [];
      const focused: string[] = [];
      const views: string[] = [];
      const popups: string[] = [];
      const forms = [OF, `{${OG.toUpperCase()}}`];
      const show = (log: string[], n: string) => void (log.push(n), (page.tab = n));
      const xrm = {
        Page: {
          ui: {
            tabs: { get: (n: string) => ({ setFocus: () => show(focused, n) }) },
            navigation: { items: { get: (n: string) => ({ setFocus: () => show(views, n) }) } },
            formSelector: { items: { get: () => forms.map((id) => ({ getId: () => id, navigate: () => void navs.push(['switch', id]) })) } },
          },
        },
        Navigation: {
          openForm: (o: unknown) => (navs.push(['openForm', o]), Promise.resolve()),
          navigateTo: (o: unknown) => (navs.push(['navigateTo', o]), Promise.resolve()),
        },
      };
      const app = {
        store,
        ctx: { ...ctx, xrm },
        prefs: { target: 1036, shown: [] },
        root: { host: { addEventListener() {}, removeEventListener() {} }, activeElement: null },
        lang: {},
        providers: new Proxy({}, { get: () => async () => [] }),
        adoptStyles: () => void popups.push('popup'),
        edit: (c: string) => void popups.push(`editor ${c}`),
      } as unknown as AppApi;
      m = createPageMode(app);
      const mm = m;
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      await fn({
        m: mm,
        store,
        go,
        restart(q) {
          mm.stop();
          go(q);
          mm.start();
        },
        navs,
        popups,
        focused,
        views,
        page,
        forms,
        async after(ms, sk) {
          if (sk !== undefined) skew = sk;
          await wait(ms);
          // The frames the find asks for once it landed (the fake keeps the last one asked).
          for (let i = 0; i < 6 && dom.raf; i++) {
            const f = dom.raf;
            dom.raf = null;
            f();
          }
        },
      });
    } finally {
      m?.destroy();
      await new Promise((r) => setTimeout(r, 20));
      Date.now = realNow;
      if (hadLoc) Object.defineProperty(globalThis, 'location', hadLoc);
      else delete g.location;
      undo();
    }
  };
  const OF = '0f1e2d3c-4b5a-4968-8776-655443322110';
  const OG = '11111111-2222-4333-8444-555566667777';
  const A1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const C1 = 'c0000000-0000-4000-8000-000000000001';
  const pageOf = (etn: string, id: string, formid: string) => `pagetype=entityrecord&etn=${etn}&id=${id}&formid=${formid}`;
  /** A form cell on tab "details" of form `form` of table `entity`. */
  const cellAt = (entity: string, form: string, id: string, labels: Record<number, string>): Slot =>
    ({ ...t.slot('field', `field|${form}|${id}|Label`, labels), comp: `field|${form}|${id}`, entity, path: [entity === 'contact' ? 'Contact' : 'Account', 'Contoso Main Form (Main form)', 'Details', 'S1'], ref: { formId: form, formType: 2, area: 'body', tabName: 'details', sectionName: 's1', controlId: id, datafield: id } }) as Slot;

  t.test('mode: a label on this page is found here and never navigates; one changed on another form of this record switches the form, once, then is found on the tab it was changed on', () =>
    onOtherPages(async ({ m, store, go, restart, navs, popups, focused, page, after }) => {
      const here = cellAt('account', OF, 'fax', { 1033: 'Fax', 1036: 'Télécopie' });
      const other = cellAt('account', OG, 'phone', { 1033: 'Phone', 1036: 'Téléphone' });
      store.add([here, other]);
      // Changed on the account's other form, its Details tab shown.
      go(pageOf('account', A1, OG));
      page.tab = 'details';
      m.start();
      store.set(other.key, 1036, 'Téléphone 2');
      restart(pageOf('account', A1, OF));
      page.tab = 'general';
      t.ok(m.open(here.comp), 'found here');
      m.cancelFind();
      t.eq([navs, focused.splice(0)], [[], ['details']], 'its tab opened; never a navigation for a label of this page');
      t.ok(m.open(other.comp), 'another form of the account: it goes there');
      t.eq(navs, [['switch', `{${OG.toUpperCase()}}`]], "the form selector's item: the record stays");
      t.ok(m.open(other.comp), 'clicked again while it goes');
      t.eq(navs.length, 1, 'never twice');
      t.eq(popups, [], 'nothing opens before it is there');
      // There (on its first tab): its loads are in, its form never says it rendered (no DOM): it is looked for at the deadline.
      go(pageOf('account', A1, OG));
      page.tab = 'general';
      await after(250);
      t.eq(popups, [], 'there, the page not ready yet');
      await after(250, 25000);
      t.eq(focused, ['details'], "back on the tab it was changed on, through the new page's form API");
      await after(250, 60000);
      t.eq([popups, navs.length], [['popup', `editor ${other.comp}`], 1], "its popup opens there (the fake page can't build it: the editor stands in); no other navigation");
      await after(450, 90000);
      t.eq(navs.length, 1, 'never again from where it arrived');
    }),
  );

  t.test("mode: a change staged on another table's record is listed under that page, and found on it through openForm; another row, closing the list, another page and the deadline cancel it", () =>
    onOtherPages(async ({ m, store, go, restart, navs, popups, after }) => {
      const contact = cellAt('contact', OG, 'mobile', { 1033: 'Mobile', 1036: 'Portable' });
      const account = cellAt('account', OF, 'fax', { 1033: 'Fax', 1036: 'Télécopie' });
      const name = { ...t.slot('entity', 'entity|contact|DisplayName', { 1033: 'Contact' }), comp: 'entity|contact' } as Slot;
      store.add([contact, account, name]);
      // Staged on the contact's form, then the user went to an account.
      go(pageOf('contact', C1, OG));
      m.start();
      store.set(contact.key, 1036, 'Portable 2');
      restart(pageOf('account', A1, OF));
      const away = m.items().filter((i) => i.away);
      t.eq(away.map((i) => [i.comp, i.away, i.look, i.visible]), [[contact.comp, 'Contact · Contoso Main Form', 'edited', false]]);
      t.ok(m.counts().all >= 2, 'counted in the list');
      const open = { entityName: 'contact', entityId: C1, formId: OG };
      // Closing the list cancels it.
      t.ok(m.open(contact.comp));
      t.eq(navs, [['openForm', open]], 'the record it was staged on, the form it was on');
      m.cancelFind();
      go(pageOf('contact', C1, OG));
      await after(250, 30000);
      await after(250, 60000);
      t.eq([popups, navs.length], [[], 1], 'cancelled: nothing opens there');
      // Another row (a label of this page) cancels it.
      restart(pageOf('account', A1, OF));
      t.ok(m.open(contact.comp));
      t.ok(m.open(account.comp), 'another row');
      m.cancelFind(); // that row's own find
      go(pageOf('contact', C1, OG));
      await after(250, 90000);
      await after(250, 120000);
      t.eq([popups, navs.length], [[], 2]);
      // The user goes to another page than the target meanwhile.
      restart(pageOf('account', A1, OF));
      await after(0, 0);
      t.ok(m.open(contact.comp));
      go('pagetype=entitylist&etn=lead');
      await after(250);
      go(pageOf('contact', C1, OG));
      await after(250, 30000);
      await after(250, 60000);
      t.eq([popups, navs.length], [[], 3], 'gone elsewhere: given up');
      // Still on the page it left at the deadline (an unsaved-changes prompt left open): given up.
      restart(pageOf('account', A1, OF));
      await after(0, 0);
      t.ok(m.open(contact.comp));
      await after(250, 25000);
      go(pageOf('contact', C1, OG));
      await after(250, 60000);
      t.eq([popups, navs.length], [[], 4], 'the deadline');
      // Not cancelled: found there.
      restart(pageOf('account', A1, OF));
      await after(0, 0);
      t.ok(m.open(contact.comp));
      go(pageOf('contact', C1, OG));
      await after(250, 25000);
      await after(250, 60000);
      t.eq([popups, navs.length], [['popup', `editor ${contact.comp}`], 5], "its popup opens on the page it lives on (the editor stands in on the fake page)");
      t.eq(m.items().filter((i) => i.away), [], 'on its page it is one of the page’s labels');
    }),
  );

  t.test('mode: a change with no page to go to stays listed (Workbench) and opens nothing by itself', () =>
    onOtherPages(async ({ m, store, go, navs, popups }) => {
      const col = { ...t.slot('attribute', 'attribute|lead.subject|DisplayName', { 1033: 'Topic', 1036: 'Sujet' }), comp: 'attribute|lead.subject', entity: 'lead', ref: { entity: 'lead', attribute: 'subject' } } as Slot;
      store.add([col]);
      store.set(col.key, 1036, 'Objet'); // made before translation mode started: no page
      go(pageOf('account', A1, OF));
      m.start();
      t.eq(m.items().map((i) => [i.comp, i.away]), [[col.comp, 'Workbench']]);
      t.eq(m.open(col.comp), false, "nowhere to go: the app's editor opens instead");
      t.eq([navs, popups], [[], []]);
      // Changed in that editor, on this page (no popup open): it belongs to no page either.
      const tip = { ...col, key: 'attribute|lead.subject|Description', prop: 'Description' } as Slot;
      store.add([tip]);
      store.set(tip.key, 1036, 'Le sujet');
      t.eq(m.items().map((i) => [i.comp, i.away]), [[col.comp, 'Workbench']]);
      t.eq(m.open(col.comp), false);
      t.eq(navs, []);
    }),
  );

  t.test('mode: a row with no page cancels a find gone to another page; a click right after the user went to another page is decided on that page', () =>
    onOtherPages(async ({ m, store, go, restart, navs, popups, after }) => {
      const contact = cellAt('contact', OG, 'mobile', { 1033: 'Mobile', 1036: 'Portable' });
      const col = { ...t.slot('attribute', 'attribute|lead.subject|DisplayName', { 1033: 'Topic', 1036: 'Sujet' }), comp: 'attribute|lead.subject', entity: 'lead', ref: { entity: 'lead', attribute: 'subject' } } as Slot;
      store.add([contact, col]);
      store.set(col.key, 1036, 'Objet'); // before translation mode started: no page
      go(pageOf('contact', C1, OG));
      m.start();
      store.set(contact.key, 1036, 'Portable 2');
      restart(pageOf('account', A1, OF));
      t.ok(m.open(contact.comp));
      t.eq(navs.length, 1);
      // Then a row with no page (the app's editor opens for it): the find gone to the contact stops.
      t.eq(m.open(col.comp), false);
      go(pageOf('contact', C1, OG));
      await after(250, 30000);
      await after(250, 60000);
      t.eq([popups, navs.length], [[], 1], 'nothing opens on the contact, over the editor');
      // The user has just gone to the contact (the page tracker's tick hasn't seen it yet): the label is on this page.
      restart(pageOf('account', A1, OF));
      await after(0, 0);
      go(pageOf('contact', C1, OG));
      t.ok(m.open(contact.comp));
      m.cancelFind();
      t.eq(navs.length, 1, 'found here: no openForm from the page before');
    }),
  );

  t.test("mode: a form the user can't open here opens next to its row at once; a second click goes again once the user kept the page it left, never while Dynamics asks; our own dialog stops the find", () =>
    onOtherPages(async ({ m, store, go, restart, navs, popups, forms, after }) => {
      const { dom, FakeEl } = await import('./overlay-dom');
      const { pushLayer } = await import('../../../src/ui/widgets');
      const OH = '22222222-3333-4444-8555-666677778888';
      const pager = cellAt('account', OH, 'pager', { 1033: 'Pager', 1036: 'Bip' });
      const contact = cellAt('contact', OG, 'mobile', { 1033: 'Mobile', 1036: 'Portable' });
      store.add([pager, contact]);
      go(pageOf('account', A1, OH));
      m.start();
      store.set(pager.key, 1036, 'Bip 2'); // on the account's third form
      restart(pageOf('contact', C1, OG));
      store.set(contact.key, 1036, 'Portable 2');
      restart(pageOf('account', A1, OF));
      // The account's form selector lists only the form shown: the other form isn't in this app for the user.
      forms.splice(0, forms.length, OF);
      t.ok(m.open(pager.comp));
      t.eq([navs, popups.splice(0)], [[], ['popup', `editor ${pager.comp}`]], 'no navigation (openForm would show this form again): its popup at once (the editor stands in)');
      // Clicked twice: it goes once.
      t.ok(m.open(contact.comp));
      t.ok(m.open(contact.comp));
      t.eq(navs.length, 1, 'a double click');
      // Dynamics asks about unsaved changes (its dialog on the page): a click a while later doesn't ask again.
      const ask = new FakeEl('DIV');
      ask.setAttribute('aria-modal', 'true');
      dom.layers.push(ask);
      await after(250, 1500);
      t.ok(m.open(contact.comp));
      t.eq(navs.length, 1, 'while Dynamics asks');
      // The user said no and stays (its promise never rejected): a click goes again.
      dom.layers.length = 0;
      t.ok(m.open(contact.comp));
      t.eq(navs.length, 2, 'after the user kept the page it left');
      // One of our dialogs opens (the Publish dialog) while it goes: nothing opens over it.
      const off = pushLayer({ classList: { contains: (c: string) => c === 'scrim' }, isConnected: true } as unknown as HTMLElement, () => {});
      try {
        await after(250, 2000);
        go(pageOf('contact', C1, OG));
        await after(250, 30000);
        await after(250, 60000);
      } finally {
        off();
      }
      t.eq([popups, navs.length], [[], 2], 'given up');
    }),
  );

  t.test('mode: a change not made on a page never navigates, whatever page its slot names (a form of the record, a quick view shown here): listed under Workbench, it opens in the editor', () =>
    onOtherPages(async ({ m, store, go, restart, navs, popups, after }) => {
      const Q = '33333333-4444-4555-8666-777788889999';
      const other = cellAt('account', OG, 'phone', { 1033: 'Phone', 1036: 'Téléphone' });
      store.add([{ ...t.slot('entity', 'entity|account|DisplayName', { 1033: 'Account' }), comp: 'entity|account' } as Slot]);
      const qv = { ...cellAt('contact', Q, 'q_phone', { 1033: 'Phone', 1036: 'Téléphone' }), ref: { formId: Q, formType: 6, area: 'body', tabName: 'general', sectionName: 'qs', controlId: 'q_phone', datafield: 'telephone1' } } as Slot;
      const host = { ...cellAt('account', OF, 'qv_contact', { 1033: 'Primary contact', 1036: 'Contact principal' }), ref: { formId: OF, formType: 2, area: 'body', tabName: 'details', sectionName: 's1', controlId: 'qv_contact', quickForms: [Q] } } as Slot;
      store.add([other, qv, host]);
      store.set(other.key, 1036, 'Tél. 2'); // in the Workbench
      store.set(qv.key, 1036, 'Tél.');
      go(pageOf('account', A1, OF));
      m.start();
      await after(100);
      t.eq(m.items().filter((i) => i.away).map((i) => [i.comp, i.away]), [[other.comp, 'Workbench'], [qv.comp, 'Workbench']]);
      t.eq([m.open(other.comp), m.open(qv.comp)], [false, false], "nowhere to go: the app's editor opens instead");
      await after(250, 30000);
      t.eq([navs, popups], [[], []]);
      // Changed again on its own page in translation mode: that page is where it was changed now.
      restart(pageOf('account', A1, OG));
      store.set(other.key, 1036, 'Tél. 3');
      restart(pageOf('account', A1, OF));
      t.eq(m.items().find((i) => i.comp === other.comp)?.away, 'Account · Contoso Main Form');
      t.ok(m.open(other.comp));
      t.eq(navs, [['switch', `{${OG.toUpperCase()}}`]]);
      m.cancelFind();
    }),
  );

  /** A column of the account table: a cell on the form shows it, so it belongs to the account's page. */
  const accountColumn = (): Slot =>
    ({ ...t.slot('attribute', 'attribute|account.fax|DisplayName', { 1033: 'Fax', 1036: 'Télécopie' }), comp: 'attribute|account.fax', entity: 'account', path: ['Account', 'Columns'], ref: { entity: 'account', attribute: 'fax' } }) as Slot;

  t.test("mode: a column header changed in an associated view (Related › Sub-Accounts): back from another page, the record opens, then that related view, then the header is found in it; on the record itself, its row opens that view again", () =>
    onOtherPages(async ({ m, store, go, restart, navs, popups, focused, views, page, after }) => {
      const col = accountColumn();
      store.add([cellAt('account', OF, 'fax', { 1033: 'Fax', 1036: 'Télécopie' }), col]);
      // The live bug: the record's Summary tab came back, never the associated view, so the header was never found.
      go(pageOf('account', A1, OF));
      page.tab = 'nav_account_parent_account'; // its tab is the nav id (LIVE-FINDINGS 88)
      m.start();
      store.set(col.key, 1036, 'Télécopie 2');
      restart(pageOf('contact', C1, OG));
      page.tab = 'general';
      t.eq(m.items().find((i) => i.comp === col.comp)?.away, 'account', 'under the page it was changed on');
      t.ok(m.open(col.comp));
      t.eq(navs, [['openForm', { entityName: 'account', entityId: A1, formId: OF }]], 'the record and form it was changed on');
      go(pageOf('account', A1, OF));
      page.tab = 'summary'; // Dynamics opens the record on its first tab
      await after(250, 25000);
      t.eq([views, focused], [['nav_account_parent_account'], []], 'its related view opened again (navigation API), no form tab');
      t.eq(popups, [], 'its grid not drawn yet: waited for');
      await after(250, 60000);
      t.eq(popups, ['popup', `editor ${col.comp}`], 'then looked for there (the editor stands in on the fake page)');
      // On the record, the Summary tab shown again: a click on its row opens the related view, never navigates.
      page.tab = 'summary';
      t.ok(m.open(col.comp));
      t.eq([views, navs.length], [['nav_account_parent_account', 'nav_account_parent_account'], 1]);
      m.cancelFind();
      // Shown already: nothing to open again.
      t.ok(m.open(col.comp));
      t.eq(views.length, 2);
      m.cancelFind();
    }),
  );

  t.test("mode: a column renamed where it showed (a related view's header on one form), then looked for from another form of the record that lists the column without showing it: back to the form and related view it was changed in, not a find here", () =>
    onOtherPages(async ({ m, store, go, restart, navs, views, page, after }) => {
      // Live 2026-10-17: a header renamed in an associated view, then looked for from a form that only lists its column.
      const col = accountColumn();
      // The other form has a field on that column with a label of its own: the column is listed there, never shown.
      store.add([cellAt('account', OF, 'fax', { 1033: 'Fax', 1036: 'Télécopie' }), cellAt('account', OG, 'fax', { 1033: 'Fax number', 1036: 'Numéro de télécopie' }), col]);
      go(pageOf('account', A1, OF));
      page.tab = 'nav_account_parent_account';
      m.start();
      store.set(col.key, 1036, 'Télécopie 2');
      restart(pageOf('account', A1, OG));
      page.tab = 'details';
      t.eq(m.items().filter((i) => i.comp === col.comp).map((i) => !!i.away), [true], 'its column is of this page too, but it is listed under the page it was changed on, once');
      t.ok(m.open(col.comp));
      t.eq(navs, [['switch', OF]], 'goes back: the form it was changed on, the record stays');
      go(pageOf('account', A1, OF));
      page.tab = 'summary';
      await after(250, 25000);
      t.eq(views, ['nav_account_parent_account'], 'then the related view it was changed in');
      m.cancelFind();
    }),
  );

  t.test("mode: a change a reload dropped (the same text came from the server) and made again on another page goes back to where it was made again, never to the first page", () =>
    onOtherPages(async ({ m, store, go, restart, navs, page }) => {
      const col = accountColumn();
      store.add([cellAt('account', OF, 'fax', { 1033: 'Fax', 1036: 'Télécopie' }), cellAt('account', OG, 'fax', { 1033: 'Fax', 1036: 'Télécopie' }), col]);
      go(pageOf('account', A1, OF));
      page.tab = 'details';
      m.start();
      store.set(col.key, 1036, 'Télécopie 2');
      // Someone published the same text meanwhile: a reload drops the change (a 'slots' event, no edit event).
      store.add([{ ...col, labels: { 1033: 'Fax', 1036: 'Télécopie 2' } }]);
      t.eq(store.isEdited(col.key), false);
      // Changed again, on the account's other form.
      restart(pageOf('account', A1, OG));
      page.tab = 'general';
      store.set(col.key, 1036, 'Télécopie 3');
      restart(pageOf('contact', C1, OG));
      t.ok(m.open(col.comp));
      t.eq(navs, [['openForm', { entityName: 'account', entityId: A1, formId: OG }]], 'the form it was changed on the second time');
      m.cancelFind();
      // Published, then changed again on the first form: there. Undone, then changed again on the other: there.
      store.commit([{ change: { slot: store.get(col.key)!, lcid: 1036, before: 'Télécopie 2', after: 'Télécopie 3' }, outcome: 'saved' }]);
      restart(pageOf('account', A1, OF));
      store.set(col.key, 1036, 'Télécopie 4');
      restart(pageOf('contact', C1, OG));
      m.open(col.comp);
      m.cancelFind();
      store.revert(col.key);
      restart(pageOf('account', A1, OG));
      store.set(col.key, 1036, 'Télécopie 5');
      restart(pageOf('contact', C1, OG));
      m.open(col.comp);
      m.cancelFind();
      t.eq(navs.slice(1).map((n) => (n as [string, { formId: string }])[1].formId), [OF, OG], 'published, undone: forgotten');
    }),
  );

  t.test('mode: on another record of the form a change was made on, its label is of this page: never a navigation, but the related view it was changed in opens again when the label isn\'t shown', () =>
    onOtherPages(async ({ m, store, go, restart, navs, views, page, after }) => {
      const A2 = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002';
      const col = accountColumn();
      store.add([cellAt('account', OF, 'fax', { 1033: 'Fax', 1036: 'Télécopie' }), col]);
      go(pageOf('account', A1, OF));
      page.tab = 'nav_account_parent_account';
      m.start();
      store.set(col.key, 1036, 'Télécopie 2');
      restart(pageOf('account', A2, OF));
      page.tab = 'summary';
      t.eq(m.items().find((i) => i.comp === col.comp)?.away, undefined, 'one of the page’s labels');
      t.ok(m.open(col.comp));
      t.eq([navs, views], [[], ['nav_account_parent_account']], 'the same related view, on this record');
      await after(250, 60000);
      t.eq(navs, []);
    }),
  );

  t.test('mode: a change made on a form tab is found on that tab again: on this page after the user switched tabs, and back from another page; one made on a list page goes back to its view', () =>
    onOtherPages(async ({ m, store, go, restart, navs, popups, focused, views, page, after }) => {
      const col = accountColumn();
      const lead = { ...t.slot('entity', 'entity|lead|DisplayName', { 1033: 'Lead', 1036: 'Prospect' }), comp: 'entity|lead' } as Slot;
      store.add([cellAt('account', OF, 'fax', { 1033: 'Fax', 1036: 'Télécopie' }), col, lead]);
      // A sub-grid on the Details tab shows the column: changed there, then the user went back to Summary.
      go(pageOf('account', A1, OF));
      page.tab = 'details';
      m.start();
      store.set(col.key, 1036, 'Télécopie 2');
      page.tab = 'summary';
      t.ok(m.open(col.comp));
      t.eq([focused, navs], [['details'], []], 'its tab again (a column has no tab of its own to find)');
      m.cancelFind();
      // From another page: the record, then that tab.
      restart(pageOf('contact', C1, OG));
      t.ok(m.open(col.comp));
      go(pageOf('account', A1, OF));
      page.tab = 'summary';
      await after(250, 25000);
      t.eq([focused, views], [['details', 'details'], []]);
      await after(250, 60000);
      t.eq(popups, ['popup', `editor ${col.comp}`]);
      // A change made on a list (the table's name): its list with its view, nothing else to bring back.
      const V = 'b0000000-0000-4000-8000-00000000000a';
      restart(`pagetype=entitylist&etn=lead&viewid=${V}&viewtype=1039`);
      page.tab = '';
      await after(0, 0);
      store.set(lead.key, 1036, 'Piste');
      restart(pageOf('account', A1, OF));
      t.ok(m.open(lead.comp));
      t.eq(navs.slice(-1), [['navigateTo', { pageType: 'entitylist', entityName: 'lead', viewId: V, viewType: 'savedquery' }]]);
      m.cancelFind();
    }),
  );

  // ---- a label of the next page, drawn before the page tracker saw the navigation ----

  const VW = 'b0000000-0000-4000-8000-00000000000b';
  /** A list grid's root as UCI renders it (`lp`: its data-lp-id, '' for none) with one column header. */
  const listGrid = (lp: string, col: string, text: string): El =>
    new El('div', lp ? { 'data-lp-id': lp } : {}).add(new El('div', { role: 'columnheader', 'col-id': col }).add(new El('label').add(new El('div', {}, text))));
  const lpOf = (table: string) => `Microsoft.PowerApps.PowerAppsOneGrid|entity_control|${table}|${VW}|${table}`;
  const column = (entity: string, attr: string, en: string, fr: string): Slot =>
    ({ ...t.slot('attribute', `attribute|${entity}.${attr}|DisplayName`, { 1033: en, 1036: fr }), prop: 'DisplayName', comp: `attribute|${entity}.${attr}`, entity, ref: { entity, attribute: attr, odataType: 'Microsoft.Dynamics.CRM.StringAttributeMetadata' } }) as Slot;

  t.test('mode: a clicked label is taken again from a new scan by its element, role and part; none when the new scan does not mark it', async () => {
    const { sameLabel } = await mode();
    const el = {} as Element;
    const old: Anchor = { ...anchor('attribute|new_alpha.description|DisplayName', 'header', el) };
    const now: Anchor = { ...anchor('attribute|new_beta.description|DisplayName', 'header', el) };
    t.eq(sameLabel(old, [anchor('x|y|Label', 'header'), now]), now, "the next page's column, on the same header");
    t.eq(sameLabel(old, [anchor('x|y|Label', 'header'), { ...now, role: 'label' }]), null, 'another role');
    const part = (start: number, end: number) => ({ start, end, text: 'x' });
    const p1: Anchor = { ...old, part: part(0, 4) };
    t.eq(sameLabel(p1, [{ ...now, part: part(5, 9) }, { ...now, part: part(0, 4) }])?.part, part(0, 4), 'the same part of a text that shows two');
    t.eq(sameLabel(old, []), null);
  });

  t.test("mode: on a list page, a grid naming another table (the next page's, before the index follows) maps none of its headers to the index's table; its own table's and an unnamed grid's do", async () => {
    const { buildIndex, Scanner } = await import('../../../src/inspector/scan');
    const alpha = column('new_alpha', 'description', 'Description', 'Description du compte');
    const map = new Map([alpha, column('new_beta', 'description', 'Description', 'Description du contact')].map((s) => [s.key, s]));
    const store = { slots: map, get: (k: string) => map.get(k) } as unknown as Store;
    const ld = { page: { info: { type: 'entitylist' }, entity: 'new_alpha', formId: '', bpfId: '', viewId: VW }, app: { ctx: { user: 1033, base: 1033 } }, sitemapId: '', appId: '', cmd: new Map(), ribbon: new Map(), queries: new Map(), viewTables: new Map(), gaveUp: new Set() };
    const keys = (lp: string) => {
      const body = new El('body').add(listGrid(lp, 'description', 'Description'));
      return withDom(body, () => {
        const sc = new Scanner();
        sc.full(buildIndex(store, ld as never, {}));
        return sc.list.map((a) => a.key);
      });
    };
    t.eq(keys(lpOf('new_alpha')), [alpha.key]);
    t.eq(keys(''), [alpha.key], 'a grid that names no table: the page table');
    t.eq(keys(lpOf('new_beta')), [], "the next page's grid");
    t.eq(keys(`Microsoft.PowerApps.PowerAppsOneGrid|entity_control|new_alpha|${VW}|new_beta`), [alpha.key], 'the page table in one of its two parts');
  });

  t.test("mode: a label the next page drew before the page tracker saw the navigation opens that page's popup, or none, never the previous table's column; a click on a page that didn't change opens as before", async () => {
    const { install } = await import('./overlay-dom');
    const { Overlay } = await import('../../../src/inspector/overlay');
    const { createPageMode } = await mode();
    const undo = install();
    /** The scanner's page: fakedom elements that know whether they are in it, as update() asks. */
    let body: El = new El('body');
    const inPage = (e: El | null): boolean => {
      while (e?.parentElement) e = e.parentElement;
      return e === body;
    };
    const props: Array<[string, PropertyDescriptor]> = [
      ['nodeType', { get: () => 1, configurable: true }],
      ['isConnected', { get(this: El) { return inPage(this); }, configurable: true }],
      ['firstElementChild', { get(this: El) { return this.children[0] ?? null; }, configurable: true }],
    ];
    for (const [k, d] of props) Object.defineProperty(El.prototype, k, d);
    const doc = document as unknown as Record<string, unknown>;
    const fake = { querySelectorAll: doc.querySelectorAll as (s: string) => unknown[], createTreeWalker: doc.createTreeWalker as (r: unknown) => unknown };
    doc.querySelectorAll = (s: string) => (s.includes('__fluentPortalMountNode') ? fake.querySelectorAll(s) : body.querySelectorAll(s));
    doc.querySelector = (s: string) => body.querySelector(s);
    doc.createTreeWalker = (root: unknown) => {
      if (!(root instanceof El)) return fake.createTreeWalker(root);
      const nodes: unknown[] = [];
      const walk = (e: El) => {
        if (e.text) nodes.push(e.node);
        e.children.forEach(walk);
      };
      walk(root);
      let i = 0;
      return { nextNode: () => nodes[i++] ?? null };
    };
    // The overlay as the controller drives it, and what the scan hands it.
    const proto = Overlay.prototype as unknown as { start(): void; sync(list: Anchor[]): void };
    const real = { start: proto.start, sync: proto.sync };
    let hooks: { open(a: Anchor): void; mutated(roots: Node[], removed: boolean): void } | null = null;
    let marked: Anchor[] = [];
    proto.start = function (this: { o: typeof hooks }) {
      hooks = this.o;
      return real.start.call(this);
    };
    proto.sync = function (list: Anchor[]) {
      marked = list;
      return real.sync.call(this, list);
    };
    const g = globalThis as Record<string, unknown>;
    const hadLoc = Object.getOwnPropertyDescriptor(globalThis, 'location');
    let m: PageMode | null = null;
    try {
      let table = 'new_alpha';
      const go = (etn: string) => {
        table = etn;
        const url = `https://org.crm.dynamics.com/main.aspx?pagetype=entitylist&etn=${etn}&viewid=${VW}`;
        Object.defineProperty(globalThis, 'location', { value: { href: url, search: url.slice(url.indexOf('?')) }, configurable: true, writable: true });
      };
      go('new_alpha');
      const xrm = { Utility: { getPageContext: () => ({ input: { pageType: 'entitylist', entityName: table, viewId: VW, viewType: 'savedquery' } }) } };
      const store = new Store();
      const alpha = column('new_alpha', 'description', 'Description', 'Description du compte');
      const beta = column('new_beta', 'description', 'Description', 'Description du contact');
      const alphaOnly = column('new_alpha', 'new_code', 'Code', 'Code du compte');
      store.add([alpha, beta, alphaOnly]);
      const popups: string[] = [];
      const app = {
        store,
        ctx: { ...ctx, xrm },
        prefs: { target: 1036, shown: [] },
        root: { host: { addEventListener() {}, removeEventListener() {} }, activeElement: null },
        lang: {},
        providers: new Proxy({}, { get: () => async () => [] }),
        adoptStyles() {},
        // The popup can't be built on this fake page: the app's editor opens for the component instead (mode.ts fallback).
        edit: (c: string) => void popups.push(c),
      } as unknown as AppApi;
      const show = (...grids: Array<[string, string, string]>) => {
        body = new El('body').add(...grids.map(([lp, col, text]) => listGrid(lp, col, text)));
        return body.children;
      };
      const header = (el: unknown) => marked.find((a) => a.role === 'header' && (el as El).contains(a.el as unknown as El)) ?? null;
      let grid = show([lpOf('new_alpha'), 'description', 'Description']);
      m = createPageMode(app);
      m.start();
      t.ok(hooks, 'the overlay started');
      // A click on a page that didn't change.
      hooks!.open(header(grid[0])!);
      t.eq(popups, [alpha.comp], "the page's own column");

      // The next list renders (its grid names no table) before the tracker's debounce: the scan matched its header against
      // the previous index.
      go('new_beta');
      grid = show(['', 'description', 'Description']);
      hooks!.mutated(grid as unknown as Node[], true);
      t.eq(header(grid[0])?.comp, alpha.comp, 'scanned against the previous index');
      hooks!.open(header(grid[0])!);
      t.eq(popups, [alpha.comp, beta.comp], "clicked: the page is read first, and its label is the new page's column");

      // A header only the previous table has a column for: the new page's scan doesn't mark it, so nothing opens.
      go('new_alpha');
      grid = show(['', 'description', 'Description']);
      m.stop();
      m.start();
      go('new_beta');
      grid = show(['', 'new_code', 'Code']);
      hooks!.mutated(grid as unknown as Node[], true);
      t.eq(header(grid[0])?.comp, alphaOnly.comp, 'scanned against the previous index');
      hooks!.open(header(grid[0])!);
      t.eq([popups.length, header(grid[0])], [2, null], 'nothing opens; the label is not marked any more');

      // A next grid that names its table is not taken for the previous table's at all.
      go('new_alpha');
      grid = show([lpOf('new_alpha'), 'description', 'Description']);
      m.stop();
      m.start();
      go('new_beta');
      grid = show([lpOf('new_beta'), 'description', 'Description']);
      hooks!.mutated(grid as unknown as Node[], true);
      t.eq(header(grid[0]), null, "the next page's grid: not marked until the index follows");
      t.eq(store.changes(), [], 'nothing staged anywhere');
    } finally {
      m?.destroy();
      await new Promise((r) => setTimeout(r, 20));
      proto.start = real.start;
      proto.sync = real.sync;
      for (const [k] of props) delete (El.prototype as unknown as Record<string, unknown>)[k];
      if (hadLoc) Object.defineProperty(globalThis, 'location', hadLoc);
      else delete g.location;
      undo();
    }
  });
}
