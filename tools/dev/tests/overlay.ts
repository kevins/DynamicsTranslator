// Unit tests for the on-page layer (inspector/overlay.ts): the pure helpers only (mark geometry and clipping, the
// pencil badge, what a popup of the page leaves of a mark, which looks are left alone, when the pointer is on a label's
// text, which clicks inside a label zone still reach the page and which ones beside its text are swallowed, what a tree
// entry lists under it, and the gesture state machine), plus the looks the marks are drawn with
// (inspector/status.ts look).
// register() is called by tools/dev/unit.ts.
import type { Kind, Prop, Slot } from '../../../src/core/model';
import { Store } from '../../../src/core/store';
import { acts, badgeBox, decide, effect, inert, isect, marks, maskOf, nested, onText, passes, shows, uncovered, type Box, type Clip, type Gesture } from '../../../src/inspector/overlay';
import { look } from '../../../src/inspector/status';
import type { Anchor } from '../../../src/inspector/types';
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
const cellOf = (id: string, labels: Record<number, string>, ref: Record<string, unknown> = {}): Slot =>
  S('field', `field|f1|${id}`, 'Label', labels, { ref: { formId: 'f1', elId: id, formType: 2, area: 'body', ...ref }, group: 'formxml|f1' });

function lookApp(extra: Slot[] = [], target = FR): AppApi {
  const store = new Store();
  store.add([
    S('attribute', 'attribute|account.name', 'DisplayName', { [EN]: 'Account Name', [FR]: 'Nom du compte' }, { ref: { entity: 'account', attribute: 'name' } }),
    S('attribute', 'attribute|account.name', 'Description', { [EN]: 'Type the company name.' }, { ref: { entity: 'account', attribute: 'name' } }),
    cellOf('c1', { [EN]: 'Account Name', [FR]: 'Nom' }, { controlId: 'name', datafield: 'name' }),
    // No French label: French users see the column's French name, which is this label's wording.
    cellOf('c2', { [EN]: 'Account Name' }, { controlId: 'name1', datafield: 'name' }),
    // No French label, worded differently from the column: to translate.
    cellOf('c3', { [EN]: 'Company' }, { controlId: 'name2', datafield: 'name' }),
    cellOf('c4', { [EN]: 'Contacts' }, { controlId: 'Contacts' }),
    S('tab', 'tab|f1|t1', 'Label', { [EN]: 'Summary' }, { ref: { formId: 'f1', partial: [EN] } }),
    S('command', 'command|b1', 'Label', { [EN]: 'Approve', [FR]: 'Approuver' }, { readOnly: 'Managed and not customizable' }),
    ...extra,
  ]);
  const ctx = { base: EN, user: EN, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] };
  return { store, ctx, prefs: { target, shown: [], showNames: false, dock: 'right' } } as unknown as AppApi;
}

export function register(t: Kit): void {
  const { test, eq, ok } = t;
  const R = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
  const C = (l: number, tp: number, r: number, b: number): Clip => ({ l, t: tp, r, b });
  const view = C(0, 0, 1000, 800);

  // ---- geometry ----

  test('overlay: isect keeps the visible part, and nothing under 2 px', () => {
    eq(isect(R(10, 10, 110, 30), view), [10, 10, 100, 20]);
    eq(isect(R(-50, 10, 50, 30), view), [0, 10, 50, 20], 'cut at the left edge');
    eq(isect(R(10, 10, 110, 30), C(0, 0, 11, 800)), null, '1 px left');
    eq(isect(R(10, 10, 110, 30), C(200, 0, 300, 800)), null, 'outside');
  });

  test('overlay: a mark per text line box, hugging the text (2 px sideways, 1 px up and down)', () => {
    eq(marks([R(10, 10, 60, 26)], view), [[8, 9, 54, 18]], 'one line');
    eq(marks([R(10, 10, 40, 26), R(40, 11, 60, 25)], view), [[8, 9, 54, 18]], 'fragments of one line merge');
    eq(marks([R(10, 30, 50, 46), R(10, 10, 80, 26)], view), [[8, 9, 74, 18], [8, 29, 44, 18]], 'two lines, top first, each as wide as its own text');
    eq(marks([R(10, 10, 300, 26)], C(0, 0, 120, 800)), [[8, 9, 114, 18]], 'ellipsis: cut where the clipping parent ends');
    eq(marks([R(10, 10, 60, 26), R(0, 0, 0, 0)], view), [[8, 9, 54, 18]], 'empty rects are ignored');
    eq(marks([], view), [], 'hidden text has no rects, so no mark');
    eq(marks([R(10, 10, 60, 29), R(10, 29, 50, 48)], view), [[8, 9, 54, 20], [8, 29, 44, 20]], 'touching lines share the gap instead of overlapping');
    eq(marks([R(10, 10, 60, 30), R(10, 27, 50, 47)], view), [[8, 9, 54, 20], [8, 29, 44, 19]], 'lines tighter than the font: split halfway');
    const many = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => R(10, i * 20, 60, i * 20 + 16));
    eq(marks(many, view).length, 6, 'at most 6 lines');
  });

  test('overlay: a line cut off by a tight wrapper keeps its mark, one cut off more loses it', () => {
    // A label whose text sticks out of its overflow:hidden box by 3 px (line-height smaller than the font).
    eq(marks([R(10, 10, 60, 29)], C(0, 12, 1000, 26)), [[8, 9, 54, 21]], 'within the slack: the mark still hugs the whole text');
    eq(marks([R(10, 10, 60, 40)], C(0, 12, 1000, 26)), [], 'more than the slack: cut off');
    eq(marks([R(10, 2, 60, 18)], C(0, 10, 1000, 800)), [], 'top cut off');
  });

  test('overlay: marks never spill past a scrolling container (onto a sticky header, a footer or a scroll bar)', () => {
    const grid = C(0, 100, 1000, 400); // a grid body that scrolls
    eq(marks([R(10, 200, 60, 216)], grid, 1, 6, grid), [[8, 199, 54, 18]], 'inside');
    eq(marks([R(10, 383, 60, 399.5)], grid, 1, 6, grid), [[8, 382, 54, 18]], 'at the bottom edge: drawn, kept inside');
    eq(marks([R(10, 385, 60, 403)], grid, 1, 6, grid), [], 'partly scrolled out at the bottom');
    eq(marks([R(10, 97, 60, 113)], grid, 1, 6, grid), [], 'partly scrolled out at the top');
    eq(marks([R(0, 200, 60, 216)], grid, 1, 6, grid), [[0, 199, 62, 18]], 'flush with the left edge: no padding past it');
    eq(marks([R(10, 385, 60, 403)], grid, 1, 6), [[8, 384, 54, 20]], 'without a hard clip: the slack rule only');
    // A one-line wrapper that scrolls (overflow:auto on a truncated label): its text always sticks out a little.
    const tight = C(0, 12, 1000, 26);
    eq(marks([R(10, 10, 60, 29)], tight, 1, 6, tight), [[8, 9, 54, 21]], 'tight scroller: treated like a wrapper');
  });

  test('overlay: marks are snapped to device pixels', () => {
    eq(marks([R(10.3, 10, 60.6, 26.2)], view, 2), [[8.5, 9, 54, 18]], '200 %');
    eq(marks([R(10.3, 10, 60.6, 26.2)], view, 1.25), [[8, 8.8, 54.4, 18.4]], '125 %');
  });

  test('overlay: the pencil badge sits right after the last mark, centred on it, inside the window', () => {
    eq(badgeBox([100, 50, 80, 20], view), [182, 53, 14, 14]);
    eq(badgeBox([900, 50, 95, 20], view), [981, 53, 14, 14], 'no room on the right: over the end of the mark');
    eq(badgeBox([100, -4, 80, 10], view), [182, 0, 14, 14], 'kept inside the window');
  });

  // ---- popups of the page over a mark ----

  test('overlay: what a popup leaves of a box', () => {
    eq(uncovered([0, 0, 100, 20], []), [[0, 0, 100, 20]], 'nothing over it');
    eq(uncovered([0, 0, 100, 20], [[-10, 10, 200, 50]]), [[0, 0, 100, 10]], 'its lower half covered');
    eq(uncovered([0, 0, 100, 20], [[40, -5, 20, 40]]), [[0, 0, 40, 20], [60, 0, 40, 20]], 'a popup across its middle');
    eq(uncovered([10, 10, 50, 20], [[0, 0, 100, 100]]), [], 'all of it');
    eq(uncovered([0, 0, 100, 20], [[90, 15, 50, 50]]), [[0, 0, 100, 15], [0, 15, 90, 5]], 'a corner');
    eq(uncovered([0, 0, 100, 20], [[50, 0, 100, 20], [30, 10, 40, 30]]), [[0, 0, 50, 10], [0, 10, 30, 10]], 'two popups that overlap (a menu and its submenu)');
    eq(uncovered([0, 0, 100, 20], [[100, 0, 50, 20]]), [[0, 0, 100, 20]], 'touching its edge only');
  });

  test('overlay: a mark under a popup is cut where it lies, ring included; gone when a sliver is left', () => {
    const m: [number, number, number, number] = [8, 9, 54, 18];
    eq(maskOf(m, []), '', 'no popup');
    eq(maskOf(m, [[100, 0, 50, 50]]), '', 'not near it');
    eq(maskOf(m, [[64, 0, 100, 100]]), 'path("M-4 -4h60v26h-60z")', 'beside it: the ring stops at the popup\'s edge');
    eq(maskOf(m, [[0, 18, 1000, 500]]), 'path("M-4 -4h62v13h-62z")', 'its lower half covered');
    eq(maskOf(m, [[0, 12, 1000, 500]]), null, '3 px left: not drawn');
    eq(maskOf(m, [[0, 0, 1000, 500]]), null, 'all of it');
    eq(maskOf(m, [[30, 0, 10, 100]]), 'path("M-4 -4h26v26h-26zM32 -4h26v26h-26z")', 'a popup across its middle');
    eq(maskOf(m, [[0, 18.3, 1000, 500]], 2), 'path("M-4 -4h62v13.5h-62z")', 'the popup\'s edge snapped to device pixels');
  });

  test('overlay: a box shows when a piece of 4 px each way is left', () => {
    eq(shows([8, 9, 54, 18], []), true);
    eq(shows([8, 9, 54, 18], [[0, 12, 1000, 500]]), false, '3 px high');
    eq(shows([8, 9, 54, 18], [[0, 13, 1000, 500]]), true, '4 px high');
    eq(shows([8, 9, 54, 18], [[11, 0, 1000, 500]]), false, '3 px wide');
  });

  test('overlay: not loaded and unpainted labels are left alone; built-in and read-only text is marked', () => {
    eq((['ok', 'missing', 'edited', 'error', 'builtin', 'ro', 'na', ''] as const).map(inert), [false, false, false, false, false, false, true, true], 'built-in and read-only text are clickable: their popup explains them');
  });

  // ---- looks (status.ts) ----

  test('look: ok, missing, ro, builtin, na and the base language', () => {
    const app = lookApp([S('command', 'command|b2', 'Label', { [EN]: 'Reject' }, { readOnly: 'Managed and not customizable' })]);
    eq(look(app, 'field|f1|c1'), 'ok', 'translated');
    eq(look(app, 'field|f1|c4'), 'missing', 'no French label');
    eq(look(app, 'command|b1'), 'builtin', 'managed, in every language: nothing to translate');
    eq(look(app, 'command|b2'), 'ro', 'managed, French missing: it needs translating at its source');
    eq(look(app, 'tab|f1|t1'), 'na', 'French not loaded');
    eq(look(app, 'nothing|here'), 'na', 'not loaded at all');
    eq(look(lookApp([], EN), 'field|f1|c4'), 'ok', 'translating into the base language');
  });

  test('look: a cell without a French label that shows the French column name is translated (LIVE-FINDINGS 42)', () => {
    const app = lookApp();
    eq(look(app, 'field|f1|c2'), 'ok', 'worded like the column: its French name stands in');
    eq(look(app, 'field|f1|c3'), 'missing', 'worded differently: the column name does not translate it');
    const noCol = lookApp();
    noCol.store.add([S('attribute', 'attribute|account.name', 'DisplayName', { [EN]: 'Account Name' }, { ref: { entity: 'account', attribute: 'name' } })]);
    eq(look(noCol, 'field|f1|c2'), 'missing', 'a column without a French name: French users see English');
  });

  test('look: a staged change is edited (its tooltip counts too), a failed publish is error', () => {
    const app = lookApp();
    const { store } = app;
    store.set('field|f1|c4|Label', FR, 'Contacts FR');
    eq(look(app, 'field|f1|c4'), 'edited');
    store.set('attribute|account.name|Description', FR, 'Tapez le nom');
    eq(look(app, 'field|f1|c1'), 'edited', 'its tooltip changed');
    store.set('field|f1|c1|Label', FR, '');
    eq(look(app, 'field|f1|c1'), 'edited', 'a blank is a staged change until a publish refuses it');
    store.revert('field|f1|c1|Label');
    store.revert('attribute|account.name|Description');
    eq(look(app, 'field|f1|c1'), 'ok', 'undone');
    const [c4] = store.changes();
    store.commit([{ change: c4, outcome: 'error', message: 'x' }]);
    eq(look(app, 'field|f1|c4'), 'error', 'the publish attempt failed');
    store.set('field|f1|c4|Label', FR, 'Contacts 2');
    eq(look(app, 'field|f1|c4'), 'edited', 'typed again: a staged change');
    store.set('field|f1|c1|Label', FR, 'Nom 2');
    const [c1] = store.changes((s) => s.key === 'field|f1|c1|Label');
    store.commit([{ change: c1, outcome: 'conflict', server: 'Nom (serveur)' }]);
    eq(look(app, 'field|f1|c1'), 'error', 'a conflict');
    const [c4b] = store.changes((s) => s.key === 'field|f1|c4|Label');
    store.commit([{ change: c4b, outcome: 'saved' }]);
    eq(look(app, 'field|f1|c4'), 'ok', 'published: nothing pending, no saved look');
  });

  // ---- what inside a zone keeps working ----

  const el = (tagName: string, sel: string[] = [], type?: string) => ({ tagName, type, matches: (s: string) => sel.some((x) => s.split(',').includes(x)) }) as unknown as Element;
  test('overlay: inside a label zone only text boxes and column resize handles keep working', () => {
    const zone = el('DIV');
    const win = {} as EventTarget;
    eq(passes([el('SPAN'), zone, el('BODY'), win], zone), false, 'the label text');
    eq(passes([zone, win], zone), false, 'the zone itself');
    eq(passes([el('INPUT', [], 'text'), zone], zone), true, 'a text box');
    eq(passes([el('INPUT', [], 'search'), el('DIV'), zone], zone), true, 'a search box in a wrapper');
    eq(passes([el('TEXTAREA', ['textarea']), zone], zone), true, 'a text area');
    eq(passes([el('SPAN'), el('DIV', ['[contenteditable="true"]']), zone], zone), true, 'rich text');
    eq(passes([el('INPUT', [], 'checkbox'), zone], zone), false, 'a Yes/No switch would change the record');
    eq(passes([el('INPUT', [], 'radio'), zone], zone), false, 'a radio button too');
    eq(passes([el('SELECT'), zone], zone), false, 'a choice list too');
    eq(passes([el('DIV', ['.ag-header-cell-resize']), zone], zone), true, 'a grid column resize handle');
    eq(passes([el('DIV', ['[role="separator"]']), zone], zone), true, 'a separator');
    eq(passes([el('INPUT', [], 'text'), el('DIV'), zone].slice(1), zone), false, 'only between the target and the zone');
    eq(passes([zone, el('INPUT', [], 'text')], zone), false, 'a text box around the zone does not count');
  });

  // ---- only the text is the label ----

  test("overlay: the pointer is on a label's text on one of its marks, or within 2 px of one", () => {
    // Two lines: 8..62 × 103..121 and 8..38 × 123..141 (the marks already pad the text by 2 × 1 px).
    const m: Box[] = [
      [8, 103, 54, 18],
      [8, 123, 30, 18],
    ];
    const on = (x: number, y: number) => onText(m, { x, y });
    eq([on(30, 112), on(30, 130), on(63, 112), on(64, 112), on(6, 112), on(5, 112), on(30, 101), on(30, 100)], [true, true, true, false, true, false, true, false]);
    eq(on(50, 132), false, 'right of the shorter second line: beside the text');
    eq(onText([], { x: 30, y: 112 }), false, 'no marks');
  });

  test('overlay: beside the text, what acts from the target up (in the zone, the zone itself or around it) makes the click swallowed', () => {
    const zone = el('DIV');
    const win = {} as EventTarget;
    eq(acts([el('SPAN'), zone, el('SECTION'), el('BODY'), el('HTML'), win]), false, "a field label's container: passive");
    const btn = el('BUTTON', ['button']);
    eq(acts([el('SPAN'), btn, el('BODY')]), true, 'a command button: the zone itself');
    eq(acts([el('SPAN'), el('DIV', ['[role="button"]']), zone]), true, "a collapse button around a section header's text");
    eq(acts([el('INPUT', ['input'], 'checkbox'), zone]), true, 'a Yes/No switch in a value zone');
    for (const r of ['tab', 'menuitem', 'option', 'treeitem', 'columnheader', 'link']) eq(acts([el('LI', [`[role="${r}"]`])]), true, r);
    eq(acts([el('A', ['a[href]']), zone]), true, 'a link');
    eq(acts([zone, el('DIV', ['[role="button"]']), el('BODY')]), true, "a button around the zone counts too (a view selector's text in its button)");
    eq(acts([zone, el('DIV', ['[role="menuitem"]']), el('UL')]), true, 'a menu item around it');
  });

  test('overlay: a <label> acts when the control it is for does (the browser clicks it): a checkbox, a switch, a button; never a text box', () => {
    const lab = (control: Element | null) => Object.assign(el('LABEL'), { control }) as unknown as Element;
    eq(acts([lab(el('INPUT', ['input'], 'checkbox')), el('BODY')]), true, 'a Yes/No checkbox');
    eq(acts([el('SPAN'), lab(el('BUTTON', ['button', '[role="switch"]'])), el('BODY')]), true, 'a switch button');
    eq(acts([lab(el('SELECT', ['select']))]), true, 'a choice list');
    eq(acts([lab(el('INPUT', ['input'], 'text'))]), false, 'a text box: the click only focuses it');
    eq(acts([lab(el('INPUT', ['input'], 'email'))]), false, 'an email box');
    eq(acts([lab(el('TEXTAREA', ['textarea']))]), false, 'a text area');
    eq(acts([lab(null)]), false, 'for nothing');
  });

  test('overlay: in the navigation, what only opens or closes (a group under its header, its chevron, Recent, the area switcher) is harmless; what navigates still acts', () => {
    const win = {} as EventTarget;
    // The site map: div[data-id=navbar-container] > ul[role=tree] > li[role=treeitem][aria-expanded] (a group) > its header
    // (the title's span, the chevron) and ul[role=group] > li[role=treeitem] (an item that opens a page).
    const nav = el('DIV', ['[data-id="navbar-container"]']);
    const tree = el('UL', ['[role="tree"]']);
    const group = el('LI', ['[role="treeitem"]', '[aria-expanded]']);
    const header = el('DIV');
    const title = el('SPAN', ['[data-id^="sitemap-"]']);
    const items = el('UL', ['[role="group"]']);
    const item = el('LI', ['[role="treeitem"]', '[data-id^="sitemap-"]']);
    const up = [tree, nav, el('BODY'), win];
    eq(effect([title, header, group, ...up]), 'toggle', "beside the group's title, in its header");
    eq(effect([el('I'), header, group, ...up]), 'toggle', 'its chevron');
    eq(acts([title, header, group, ...up]), false);
    // The header is the button that expands, the entry around it has no state of its own: still the group's.
    const plainGroup = el('LI', ['[role="treeitem"]']);
    eq(effect([el('I'), el('BUTTON', ['button', '[aria-expanded]']), plainGroup, ...up]), 'toggle', 'a header button with aria-expanded');
    eq(effect([el('SPAN'), el('DIV', ['[role="button"]', '[aria-expanded]']), plainGroup, ...up]), 'toggle', 'a header with role=button');
    eq(effect([el('SPAN'), item, items, group, ...up]), 'acts', 'an item of the group: it opens a page');
    eq(effect([item, items, group, ...up]), 'acts', 'its row');
    eq(effect([el('SPAN'), el('LI', ['[role="treeitem"]', '[data-id^="sitemap-"]', '[aria-expanded]']), ...up]), 'toggle', 'Recent and Pinned: they expand');
    eq(effect([el('SPAN'), el('LI', ['[role="treeitem"]', '[data-id^="sitemap-"]']), ...up]), 'acts', 'Home: it opens a page');
    // The area switcher at the bottom of the navigation opens the list of areas; an area of that list (live: its UL in
    // the flyout, a portal under body) is picked.
    eq(effect([el('SPAN'), el('BUTTON', ['button', '#areaSwitcherId']), el('DIV'), el('BODY'), win]), 'toggle', 'the area switcher');
    const flyout = el('DIV', ['[data-lp-id="sitemap-area-switcher-flyout"]']);
    eq(effect([el('SPAN'), el('LI', ['[role="menuitemradio"]']), el('UL', ['[role="menu"]']), flyout, el('DIV'), el('DIV', ['#__flyoutRootNode']), el('BODY'), win]), 'pick', 'an area of its list');
    // The button that collapses the whole navigation (no label of its own).
    eq(effect([el('I'), el('BUTTON', ['button', '[aria-expanded]']), nav, el('BODY'), win]), 'toggle', 'the button that collapses the navigation');
    // Never a link, never what lies outside the navigation, never the navigation itself.
    eq(effect([el('SPAN'), el('A', ['a[href]', '[aria-expanded]']), group, ...up]), 'acts', 'a link that expands');
    eq(effect([el('SPAN'), el('DIV', ['[role="button"]', '[aria-expanded]']), el('SECTION'), el('BODY'), win]), 'acts', "a form section's collapse button");
    eq(effect([el('SPAN'), el('BUTTON', ['button', '[aria-expanded]']), el('DIV', ['[role="menubar"]']), el('BODY'), win]), 'acts', "a command's menu button");
    eq(effect([el('SPAN'), el('DIV'), el('UL', ['[role="tree"]', '[aria-expanded]']), el('BODY'), win]), '', 'a tree that says it is expanded is no toggle');
    eq(effect([el('SPAN'), el('DIV'), nav, el('DIV', ['[aria-expanded]']), win]), '', 'a wrapper around the navigation that expands: not in it');
    eq(effect([title, header, el('DIV'), el('BODY'), win]), '', 'nothing acts');
  });

  test('overlay: the buttons that open the lists the page is switched with are harmless, and so is picking from those lists; every other menu still acts', () => {
    const win = {} as EventTarget;
    const up = [el('DIV'), el('BODY'), win];
    // The form selector (live: button[data-id=form-selector] > the form's name, then its chevron's span > svg).
    const formSel = el('BUTTON', ['button', '[data-id="form-selector"]', '[aria-expanded]']);
    eq(effect([el('SVG'), el('SPAN'), formSel, ...up]), 'toggle', "the form selector's chevron: the list of forms opens");
    eq(effect([formSel, ...up]), 'toggle', 'its padding');
    // A list page's view selector (live: h1 > button[data-id=ViewSelector_<view id>][aria-haspopup] > spans > i chevron).
    const viewSel = el('BUTTON', ['button', 'button[data-id^="ViewSelector_"][aria-haspopup]', '[aria-expanded]']);
    eq(effect([el('I'), el('SPAN'), viewSel, el('H1'), ...up]), 'toggle', "a view selector's chevron: the list of views opens");
    eq(effect([el('SPAN'), el('DIV', ['[role="button"]']), el('DIV', ['[id*="viewselector" i]']), ...up]), 'acts', 'a button that says nothing of a popup still acts');
    // Their lists: an item picks (beside its text the page gets the click).
    const areas = el('DIV', ['[data-lp-id="sitemap-area-switcher-flyout"]']);
    const area = el('LI', ['[role="menuitemradio"]']);
    eq(effect([el('SPAN'), area, el('UL', ['[role="menu"]']), areas, el('DIV'), el('BODY'), win]), 'pick', 'an area');
    const forms = el('DIV', ['[data-id="form-selector-flyout"]']);
    eq(effect([el('SPAN'), el('DIV', ['[role="menuitemradio"]']), el('DIV', ['[role="menu"]']), forms, ...up]), 'pick', 'a form');
    const views = el('DIV', ['[data-id^="ViewSelector_"][data-id$="-flyout"]']);
    const viewItem = el('BUTTON', ['button', '[role="menuitemradio"]']);
    const inViews = [el('LI'), el('UL', ['[role="menu"]']), el('DIV', ['[role="dialog"]']), views, ...up];
    eq(effect([el('LABEL'), el('SPAN'), viewItem, ...inViews]), 'pick', 'a view');
    eq(effect([el('I'), el('DIV'), el('SPAN'), viewItem, ...inViews]), 'pick', "a view's info icon, in its item");
    eq(acts([el('LABEL'), el('SPAN'), viewItem, ...inViews]), false);
    // Microsoft's own command under the views, a command's menu, a radio item outside these lists: they act.
    eq(effect([el('LABEL'), el('SPAN'), el('BUTTON', ['button', '[role="menuitem"]']), ...inViews]), 'acts', '"Manage and share views"');
    eq(effect([el('SPAN'), el('DIV', ['[role="menuitemradio"]']), el('DIV', ['[role="menu"]']), el('DIV', ['[data-id="CommandBar"]']), ...up]), 'acts', "a command bar menu's radio item");
    eq(effect([el('SPAN'), el('LI', ['[role="menuitemradio"]']), el('UL', ['[role="menu"]']), el('BODY'), win]), 'acts', 'a radio item of no such list');
    // Anything else that acts on the way still does: a link in an item, a menu item around one.
    eq(effect([el('SPAN'), el('A', ['a[href]']), area, el('UL', ['[role="menu"]']), areas, el('BODY'), win]), 'acts', 'a link in an item');
    eq(effect([el('SPAN'), area, el('UL', ['[role="menu"]']), el('DIV', ['[role="menuitem"]']), areas, el('BODY'), win]), 'acts', 'a menu item between an item and its list');
  });

  test('overlay: the entries a tree entry lists under it are not its own; anything else in a zone is', () => {
    const recent = el('LI', ['[role="treeitem"]']);
    const group = el('UL', ['[role="group"]']);
    const record = el('LI', ['[role="treeitem"]']);
    eq(nested([el('SPAN'), record, group, recent, el('BODY')], recent), true, 'a record under Recent');
    eq(nested([record, group, recent], recent), true, 'its row itself');
    eq(nested([group, recent], recent), true, 'the list between the records');
    eq(nested([el('SPAN'), recent, el('UL')], recent), false, "Recent's own row");
    const li = el('LI');
    eq(nested([el('SPAN'), el('DIV', ['[role="group"]']), li], li), false, 'a group in a zone that is no tree entry (a split button) is its own');
    eq(nested([el('SPAN'), el('DIV'), recent, group, el('LI', ['[role="treeitem"]'])], recent), false, 'only between the target and the zone');
  });

  // ---- gestures ----

  const A = { comp: 'a' } as Anchor;
  const B = { comp: 'b' } as Anchor;
  const run = (s: Gesture, evs: Array<[string, Anchor | null | false, number?]>) => evs.map(([type, here, detail = 1]) => decide(s, type, here, detail)).map((d) => (d.open ? `open:${d.open.comp}` : d.swallow ? 'x' : '-'));
  const fresh = (): Gesture => ({ g: undefined, end: undefined, last: null });

  test('overlay: a click on a label is swallowed whole and opens it once', () => {
    const s = fresh();
    eq(run(s, [['pointerdown', A], ['mousedown', A], ['pointerup', A], ['mouseup', A], ['click', A]]), ['x', 'x', 'x', 'x', 'open:a']);
    eq(s.g, undefined, 'the gesture ended');
  });

  test('overlay: a gesture belongs to where it started', () => {
    eq(run(fresh(), [['pointerdown', A], ['pointerup', null], ['mouseup', null], ['click', null]]), ['x', 'x', 'x', 'x'], 'from a label to elsewhere: Dynamics sees none of it, nothing opens');
    eq(run(fresh(), [['pointerdown', A], ['pointerup', B], ['click', null]]), ['x', 'x', 'x'], 'from one label to another: nothing opens');
    eq(run(fresh(), [['pointerdown', null], ['pointerup', A], ['mouseup', A], ['click', A]]), ['-', '-', '-', '-'], 'from the page onto a label: the page keeps it');
    eq(run(fresh(), [['pointerdown', null], ['click', A]]), ['-', '-'], 'with Alt, another button or in our hosts, here is null at pointerdown');
  });

  test('overlay: beside the text of a label that acts, the gesture is swallowed whole and opens nothing', () => {
    const s = fresh();
    eq(run(s, [['pointerdown', false], ['mousedown', false], ['pointerup', false], ['mouseup', false], ['click', false], ['dblclick', false, 2]]), ['x', 'x', 'x', 'x', 'x', 'x']);
    eq(s.g, undefined, 'the gesture ended');
    eq(run(fresh(), [['pointerdown', A], ['pointerup', false], ['click', false]]), ['x', 'x', 'x'], 'from the text to beside it: nothing opens');
    eq(run(fresh(), [['pointerdown', false], ['pointerup', null], ['click', null]]), ['x', 'x', 'x'], 'released off the label: still swallowed');
    eq(run(fresh(), [['pointerdown', null], ['pointerup', false], ['click', false]]), ['-', '-', '-'], 'a gesture of the page stays the page\'s');
    eq(run(fresh(), [['click', false, 0]]), ['-'], 'keyboard activation reaches the page');
  });

  test('overlay: a double-click goes with the clicks it follows, never on its own position', () => {
    eq(run(fresh(), [['pointerdown', A], ['pointerup', null], ['click', null, 2], ['dblclick', null, 2]]), ['x', 'x', 'x', 'x'], 'the second release drifted off the text: the page sees none of it');
    eq(run(fresh(), [['pointerdown', false], ['click', false, 2], ['dblclick', A, 2]]), ['x', 'x', 'x'], 'beside the text of a button: still swallowed');
    eq(run(fresh(), [['pointerdown', null], ['click', null, 2], ['dblclick', A, 2]]), ['-', '-', '-'], "a page gesture's double-click is the page's, even over a label");
    const s = fresh();
    eq(run(s, [['pointerdown', A], ['click', A, 1], ['pointerdown', A], ['click', A, 2], ['dblclick', A, 2]]), ['x', 'open:a', 'x', 'x', 'x']);
    eq(s.end, undefined, 'used once');
    eq(run(s, [['dblclick', null, 2]]), ['-'], 'a later lone double-click (its clicks went to a frame) decides alone');
    eq(run(fresh(), [['pointerdown', null], ['click', null], ['pointerdown', A], ['dblclick', null, 2]]), ['-', '-', 'x', 'x'], 'a press since the last click: its gesture');
  });

  test('overlay: keyboard and screen reader clicks reach the page', () => {
    const s = fresh();
    eq(run(s, [['click', A, 0], ['dblclick', A, 0]]), ['-', '-']);
    eq(s.g, undefined, 'no gesture started');
  });

  test('overlay: the second click of a double-click does not open the label again', () => {
    const s = fresh();
    eq(run(s, [['pointerdown', A], ['click', A, 1], ['pointerdown', A], ['click', A, 2], ['dblclick', A, 2]]), ['x', 'open:a', 'x', 'x', 'x']);
    eq(run(s, [['pointerdown', A], ['click', A, 1]]), ['x', 'open:a'], 'a later single click opens it again');
    eq(run(s, [['pointerdown', B], ['click', B, 2]]), ['x', 'open:b'], 'a quick click on another label opens that one');
  });

  test('overlay: without a pointerdown (it went to a frame, or before the start) the event decides alone', () => {
    eq(run(fresh(), [['mouseup', A], ['click', A]]), ['x', 'open:a']);
    eq(run(fresh(), [['mouseup', null], ['click', null]]), ['-', '-']);
    ok(decide(fresh(), 'pointerup', null, 1).swallow === false);
  });
}
