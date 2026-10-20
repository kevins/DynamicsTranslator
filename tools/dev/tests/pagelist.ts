// Unit tests for "All labels on this page" (inspector/pagelist.ts): places, row kinds and clustering, row states, its
// search (core/search.ts folding, status.ts searchText), and the sheet itself on the popup tests' fake DOM: its groups
// that collapse, its group of changes staged on other pages (status.ts awayTitle names their pages), floating where it
// is dragged and docked again (and the bar, ui/bar.ts, keeping clear of it only while it is docked).
// Slots copy the shapes the providers make (formxml.ts, metadata.ts, bpf.ts, sitemap.ts paths and refs).
import type { Kit } from './kit';
import { Store } from '../../../src/core/store';
import type { Kind, Slot } from '../../../src/core/model';
import type { Look, PageItem, PageMode } from '../../../src/inspector/types';
import type { AppApi, Prefs } from '../../../src/ui/types';
import { setLayer, teardownLayer } from '../../../src/ui/widgets';
import { dom, FEl, fire, install, type Ev as FireEv } from './callout';

const list = () => import('../../../src/inspector/pagelist');
const search = () => import('../../../src/core/search');
const status = () => import('../../../src/inspector/status');

export function register(t: Kit): void {
  const T = 'Service request';
  const F = 'Main (Main form)';
  const mk = (kind: Kind, path: string[], ref: Record<string, unknown> = {}, title = 't'): Slot => ({ ...t.slot(kind), path, ref, title }) as Slot;

  t.test('page list: where a row is, in the names people see (screen readers and the search have it)', async () => {
    const { whereOf } = await list();
    t.eq(whereOf(mk('field', [T, F, 'General', 'Request'], { area: 'body' })), 'General › Request');
    t.eq(whereOf(mk('field', [T, F, 'Header'], { area: 'header' })), 'Header');
    t.eq(whereOf(mk('field', [T, F, 'Footer'], { area: 'footer' })), 'Footer');
    t.eq(whereOf(mk('field', [T, 'Card (Quick view form)', 'General', 'S'], { area: 'body', formType: 6 })), 'Card (Quick view form) › General › S', 'a quick view says which');
    t.eq(whereOf(mk('section', [T, F, 'General'], { area: 'body' }, 'Writing')), 'General › Writing', 'a section heads its own place');
    t.eq(whereOf(mk('tab', [T, F], { area: 'body' }, 'General')), '');
    t.eq(whereOf(mk('navitem', [T, F, 'Navigation'], { area: 'nav' })), 'Related');
    t.eq(whereOf(mk('relationship', [T, 'Relationships'])), 'Related');
    t.eq(whereOf(mk('option', [T, 'Industry (industrycode)', 'Choices'])), 'Industry');
    t.eq(whereOf(mk('status', [T, 'Status Reason (statuscode)', 'Choices'])), 'Status Reason');
    t.eq(whereOf(mk('globaloption', ['Global choices', 'Urgency'])), 'Urgency');
    t.eq(whereOf(mk('step', ['bpf test', 'Stage 1'])), 'Stage 1');
    t.eq(whereOf(mk('step', ['bpf test'])), '', 'a step of no known stage');
    t.eq(whereOf(mk('subarea', ['Sales Hub', 'Area', 'Test Group'])), 'Test Group');
    t.eq(whereOf(mk('attribute', ['Contact', 'Columns'])), 'Contact', "a column: its table (an associated grid's, an address's)");
    t.eq(whereOf(mk('view', ['Contact'])), 'Contact');
    t.eq(whereOf(mk('chart', ['Account'])), 'Account');
    for (const k of ['stage', 'command', 'entity', 'group', 'app'] as Kind[]) t.eq(whereOf(mk(k, ['x', 'y', 'z'])), '', k);
  });

  t.test('page list: a row says its state; a changed or failed one without a target text says so in our words', async () => {
    const { rowState } = await list();
    t.eq(rowState('edited', 'Nom 2'), { text: 'Nom 2', cls: 'is-chg' });
    t.eq(rowState('edited', ''), { text: 'Changed', cls: 'is-chg' }, 'only its tooltip or column name changed');
    t.eq(rowState('edited', '  '), { text: 'Changed', cls: 'is-chg' });
    t.eq(rowState('error', ''), { text: "Couldn't be published", cls: 'is-bad' });
    t.eq(rowState('error', 'Nom'), { text: 'Nom', cls: 'is-bad' });
    t.eq(rowState('missing', ''), { text: 'Not translated', cls: 'is-miss' });
    t.eq(rowState('ro', 'Nom'), { text: 'Read-only', cls: 'is-ro' });
    t.eq(rowState('builtin', ''), { text: 'Built-in', cls: 'is-na' });
    t.eq(rowState('ok', ''), { text: '', cls: '' });
  });

  t.test("page list: kinds only where the group doesn't say it", async () => {
    const { rowKind } = await list();
    t.eq((['tab', 'section', 'entity', 'stage', 'attribute', 'view'] as Kind[]).map(rowKind), ['Tab', 'Section', 'Table', 'Stage', 'Column', 'View']);
    // Said only by the place caption over them before: a Related menu item among a form's fields, a step among stages.
    t.eq((['navitem', 'relationship', 'step'] as Kind[]).map(rowKind), ['Related', 'Related', 'Step']);
    for (const k of ['field', 'option', 'command', 'ribbon', 'subarea', 'globaloption'] as Kind[]) t.eq(rowKind(k), '', k);
  });

  t.test("page list: a choice value's tag is its column (values of different columns read alike); a stage heads its steps, a navigation group its sub-areas", async () => {
    const { rowTag, runOf, cluster } = await list();
    // Account's "Do not allow Emails" and "Do not allow Bulk Emails": both Allow / Do Not Allow.
    t.eq(rowTag(mk('boolean', ['Account', 'Do not allow Emails (donotemail)', 'Choices'], {}, 'Allow')), 'Do not allow Emails');
    t.eq(rowTag(mk('boolean', ['Account', 'Do not allow Bulk Emails (donotbulkemail)', 'Choices'], {}, 'Allow')), 'Do not allow Bulk Emails');
    t.eq(rowTag(mk('option', [T, 'Industry (industrycode)', 'Choices'])), 'Industry');
    t.eq(rowTag(mk('status', [T, 'Status Reason (statuscode)', 'Choices'])), 'Status Reason');
    t.eq(rowTag(mk('state', [T, 'Status (statecode)', 'Choices'])), 'Status');
    t.eq(rowTag(mk('globaloption', ['Global choices', 'Urgency'])), 'Urgency');
    t.eq(rowTag(mk('option', [])), '', 'no known column: no tag');
    t.eq([rowTag(mk('step', ['bpf test', 'Stage 1'])), rowTag(mk('tab', [T, F])), rowTag(mk('field', [T, F, 'General', 'S']))], ['Step', 'Tab', ''], 'the others: their kind, as before');
    // Page order: the stages first, then their steps (bpf.ts); listed, each stage right before its steps.
    const bpf = [
      mk('stage', ['bpf test'], {}, 'Qualify'),
      mk('stage', ['bpf test'], {}, 'Develop'),
      mk('step', ['bpf test', 'Qualify'], {}, 's1'),
      mk('step', ['bpf test', 'Develop'], {}, 's2'),
      mk('step', ['bpf test', 'Qualify'], {}, 's3'),
      mk('bpf', ['bpf test'], {}, 'bpf test'),
    ];
    t.eq(cluster(bpf, runOf).flatMap((r) => r.items.map((s) => `${s.kind} ${s.title}`)), ['bpf bpf test', 'stage Qualify', 'step s1', 'step s3', 'stage Develop', 'step s2']);
    const nav = [mk('area', ['Sales Hub'], {}, 'Sales'), mk('group', ['Sales Hub', 'Sales'], {}, 'Customers'), mk('subarea', ['Sales Hub', 'Sales', 'Customers'], {}, 'Accounts'), mk('group', ['Sales Hub', 'Sales'], {}, 'Collateral'), mk('subarea', ['Sales Hub', 'Sales', 'Collateral'], {}, 'Products')];
    t.eq(cluster(nav, runOf).flatMap((r) => r.items.map((s) => s.title)), ['Sales', 'Customers', 'Accounts', 'Collateral', 'Products']);
    t.eq([runOf(nav[1]), runOf(nav[2]), runOf(mk('section', [T, F, 'General'], { area: 'body' }, 'Writing'))], ['Customers', 'Customers', 'General › Writing'], 'the rest by their place');
  });

  t.test('page list: rows of one place stay together', async () => {
    const { cluster } = await list();
    const its = [
      { n: 1, w: 'A' },
      { n: 2, w: '' },
      { n: 3, w: 'B' },
      { n: 4, w: 'A' },
      { n: 5, w: '' },
    ];
    t.eq(
      cluster(its, (i) => i.w).map((r) => [r.where, r.items.map((i) => i.n)]),
      [
        ['', [2, 5]],
        ['A', [1, 4]],
        ['B', [3]],
      ],
    );
    t.eq(cluster([], () => ''), []);
    t.eq(
      cluster([{ w: 'A' }], (i) => i.w).map((r) => r.where),
      ['A'],
      'no empty run without a heading',
    );
  });

  t.test('search: case, accents, apostrophes, ligatures, _ and dashes aside', async () => {
    const { fold, terms, hit } = await search();
    t.eq(fold('Télécopie'), 'telecopie');
    t.eq(fold('Symbole de l’action'), "symbole de l'action");
    t.eq(fold('Cœur'), 'coeur');
    t.eq(fold('ÆON'), 'aeon');
    t.eq(fold('Straße'), 'strasse');
    t.eq(fold('École_Name-x'), 'ecole name x');
    t.eq(fold('A–B'), 'a b');
    t.eq(terms('  TÉLÉ  cop '), ['tele', 'cop']);
    t.eq(terms(''), []);
    t.ok(hit(fold('Télécopie'), terms('tele')));
    t.ok(!hit(fold('Téléphone'), terms('tele cop')), 'every word must occur');
    t.ok(hit(fold('Symbole de l’action'), terms("l'action")), 'a typed apostrophe finds a typographic one');
    t.ok(hit(fold('E-mail'), terms('e mail')));
    // Letters that don't decompose, compatibility forms, invisible characters.
    const finds = (text: string, q: string) => t.ok(hit(fold(text), terms(q)), `${q} finds ${text}`);
    finds('ΟΔΟΣΗΜΑΝΣΗ', 'ΟΔΟΣ');
    finds('Οδός', 'οδος');
    finds('Kapı', 'kapi');
    finds('İstanbul', 'istanbul');
    finds('Łódź', 'lodz');
    finds('Søgeord', 'sogeord');
    finds('Đường', 'duong');
    finds('Ħamrun', 'hamrun');
    finds('ＩＤ', 'id');
    finds('ﬁchier', 'fichier');
    finds('Tele­copie', 'telecopie');
    finds('Tele​copie', 'telecopie');
    finds('Symbole de l´action', "l'action");
    t.eq(fold('مُدير'), 'مدير', 'Arabic vowel signs too');
  });

  t.test('page list: the search finds a label by any language, its names and what its row shows', async () => {
    const { searchText } = await status();
    const { terms, hit } = await search();
    const s = new Store();
    const cell = (id: string, labels: Record<number, string>, sub: string): Slot => ({ ...t.slot('field', `field|f|${id}|Label`, labels), comp: `field|f|${id}`, sub }) as Slot;
    const phone = cell('phone', { 1033: 'Phone', 1036: 'Téléphone' }, 'telephone1');
    const fax = cell('fax', { 1033: 'Fax', 1036: 'Télécopie' }, 'fax');
    s.add([phone, fax]);
    const langs = [
      { lcid: 1033, name: 'English', isBase: true },
      { lcid: 1036, name: 'French', isBase: false },
    ];
    const app = { store: s, ctx: { base: 1033, user: 1036, langs }, prefs: { target: 1036 } } as unknown as AppApi;
    const item = (m: Slot): PageItem => ({ comp: m.comp, main: m, group: 'Form', visible: true, look: 'ok' });
    const found = (q: string): string[] => [phone, fax].filter((m) => hit(searchText(app, item(m)), terms(q))).map((m) => m.comp);
    t.eq(found('tele'), [phone.comp, fax.comp], 'Téléphone and Télécopie');
    t.eq(found('telecopie'), [fax.comp]);
    t.eq(found('TELEPHONE1'), [phone.comp], 'its technical name');
    t.eq(found('fax'), [fax.comp]);
    s.set(fax.key, 1036, 'Numéro de fax');
    t.eq(found('numero'), [fax.comp], 'the staged text');
    t.eq(found('télécopie'), [fax.comp], 'and still the text on the server');
    t.ok(hit(searchText(app, item(phone), ['Titre']), terms('titre')), 'what the row shows besides');
    t.ok(!hit(searchText(app, item(phone)), terms('titre')));
  });

  // ---- the sheet (fake DOM) ----
  const EN = 1033;
  const FR = 1036;
  const DE = 1031;
  type Ev = 'items' | 'page' | 'alt' | 'loading';
  /** A form cell of column acc.<id> on tab › section. */
  const cellOf = (id: string, labels: Record<number, string>, place: [string, string], o: Partial<Slot> = {}): Slot =>
    ({ ...t.slot('field', `field|f|${id}|Label`, labels), comp: `field|f|${id}`, entity: 'acc', path: [T, F, ...place], ref: { formId: 'f', area: 'body', datafield: id, controlId: id }, ...o }) as Slot;
  /** A column's slot (`prop`: DisplayName or Description). */
  const colOf = (id: string, prop: 'DisplayName' | 'Description', labels: Record<number, string>): Slot =>
    ({ ...t.slot('attribute', `attribute|acc.${id}|${prop}`, labels), comp: `attribute|acc.${id}`, prop }) as Slot;
  /** The fake app of a sheet: its prefs as savePrefs stores them, and each savePrefs call. */
  type App = AppApi & { saved: Array<Partial<Prefs>> };
  const fakeApp = (store: Store, target: number, prefs: Partial<Prefs> = {}): App => {
    const langs = [
      { lcid: EN, name: 'English', isBase: true },
      { lcid: FR, name: 'French', isBase: false },
      { lcid: DE, name: 'German', isBase: false },
    ];
    const app = {
      store,
      ctx: { base: EN, user: EN, langs },
      prefs: { target, shown: [], ...prefs },
      saved: [] as Array<Partial<Prefs>>,
      savePrefs: (p: Partial<Prefs>) => (app.saved.push(p), Object.assign(app.prefs, p)),
      adoptStyles() {},
      root: dom.root,
      layer: dom.layer,
      edit() {},
      langMenu() {},
    };
    return app as unknown as App;
  };
  /**
   * openPageList on a stub page mode (`items`: what the page lists), on a new fake app or `o.app` (another list of the
   * same session); its rows, bands and hidden group are read off the sheet.
   */
  const sheet = async (store: Store, items: () => PageItem[], target = FR, o: { app?: App; prefs?: Partial<Prefs> } = {}) => {
    const { openPageList } = await list();
    const subs = new Set<(w: Ev) => void>();
    const opened: string[] = [];
    const mode = {
      items,
      on: (fn: (w: Ev) => void) => (subs.add(fn), () => subs.delete(fn)),
      notes: () => [],
      loading: () => false,
      open: (c: string) => (opened.push(c), true),
      flash: () => {},
    } as unknown as PageMode;
    const app = o.app ?? fakeApp(store, target, o.prefs);
    const api = openPageList(app, mode, { close() {} });
    const el = api.el as unknown as FEl;
    dom.layer.appendChild(el);
    const input = el.querySelector('input')!;
    const bands = () => el.querySelectorAll('.pl-gb');
    return {
      app,
      api,
      el,
      opened,
      emit: (w: Ev) => subs.forEach((f) => f(w)),
      search(v: string) {
        input.value = v;
        fire(input, 'input');
      },
      /** The group bands shown: their key, whether open, their text (name and count). */
      bands: () => bands().map((b) => [b.getAttribute('data-g'), b.getAttribute('aria-expanded'), b.textContent]),
      band: (key: string) => bands().find((b) => b.getAttribute('data-g') === key)!,
      /** What the list holds, in order: g:<band>, r:<row's comp>, hid (Not on screen right now), the rest by class. */
      layout: () =>
        el.querySelector('.pl-list')!.querySelectorAll('.pl-gb,.pl-r,.pl-hid,.pl-pg,.pl-ph').map((x) =>
          x.classList.contains('pl-gb') ? `g:${x.getAttribute('data-g')}` : x.classList.contains('pl-r') ? `r:${x.getAttribute('data-c')}` : x.className,
        ),
      head: () => el.querySelector('.pl-hd')!,
      pin: () => el.querySelectorAll('.pl-hd button')[0],
      focused: () => dom.root.activeElement,
      /** A row shown: its target line (null when hidden), that line's class and lang, the row's aria-description. */
      row(comp: string) {
        const r = el.querySelectorAll('.pl-r').find((x) => x.getAttribute('data-c') === comp);
        if (!r) return null;
        const tl = r.querySelector('.pl-t')!;
        return { t: tl.hidden ? null : tl.textContent, cls: tl.className, lang: tl.getAttribute('lang'), aria: r.getAttribute('aria-description') };
      },
      comps: () => el.querySelectorAll('.pl-r').map((x) => x.getAttribute('data-c')),
      hid: () => el.querySelector('.pl-hid'),
    };
  };
  const withSheet = (fn: () => Promise<void>) => async () => {
    const off = install();
    try {
      await fn();
    } finally {
      off();
    }
  };
  const it = (m: Slot, look: Look, visible = true): PageItem => ({ comp: m.comp, main: m, group: 'Form', visible, look });

  t.test(
    'page list: a changed row without a target text still shows its state; with one language a pending row does too',
    withSheet(async () => {
      const s = new Store();
      const name = cellOf('name', { [EN]: 'Name', [FR]: 'Nom' }, ['General', 'Request']);
      const tip = colOf('name', 'Description', { [EN]: 'Type it.' });
      const fax = cellOf('fax', { [EN]: 'Fax' }, ['General', 'Request']);
      s.add([name, tip, fax]);
      s.set(tip.key, FR, 'Tapez-le.'); // only the column's tooltip changed
      const looks: Record<string, Look> = { [name.comp]: 'edited', [fax.comp]: 'error' };
      const items = () => [it(name, looks[name.comp]), it(fax, looks[fax.comp])];
      const a = await sheet(s, items);
      t.eq([a.row(name.comp)?.t, a.row(name.comp)?.cls, a.row(name.comp)?.lang], ['Nom', 'pl-t is-chg', 'fr'], 'its target text, green, in its language');
      t.eq([a.row(fax.comp)?.t, a.row(fax.comp)?.cls, a.row(fax.comp)?.lang], ["Couldn't be published", 'pl-t is-bad', null], 'our words, not French');
      s.set(name.key, FR, '');
      a.api.refresh();
      t.eq([a.row(name.comp)?.t, a.row(name.comp)?.cls], ['Changed', 'pl-t is-chg'], 'emptied: still said');
      a.api.close();
      // One language: no target line, except for a changed or failed row.
      looks[fax.comp] = 'missing';
      const b = await sheet(s, items, EN);
      t.eq([b.row(name.comp)?.t, b.row(name.comp)?.cls, b.row(name.comp)?.aria], ['Changed', 'pl-t is-chg', 'Changed, not published yet. General › Request']);
      t.eq([b.row(fax.comp)?.t, b.row(fax.comp)?.aria], [null, 'General › Request'], 'nothing is "not translated" with one language: only its place');
      b.api.close();
    }),
  );

  t.test(
    'page list: a grey row says why in its tooltip and to screen readers',
    withSheet(async () => {
      const s = new Store();
      const ro = cellOf('created', { [EN]: 'Created On' }, ['General', 'Request'], { readOnly: 'Managed and not customizable.' });
      s.add([ro]);
      const a = await sheet(s, () => [it(ro, 'ro')]);
      t.eq([a.row(ro.comp)?.t, a.row(ro.comp)?.aria], ['Read-only', 'Managed and not customizable. General › Request'], 'then its place');
      a.api.close();
    }),
  );

  t.test(
    'page list: no place captions, rows of one place together; search hits not on screen show open, until collapsed',
    withSheet(async () => {
      const s = new Store();
      const a1 = cellOf('a1', { [EN]: 'Phone', [FR]: 'Téléphone' }, ['General', 'Request']);
      const a2 = cellOf('a2', { [EN]: 'Email', [FR]: 'Courriel' }, ['Details', 'More']);
      const a3 = cellOf('a3', { [EN]: 'Mobile', [FR]: 'Portable' }, ['General', 'Request']);
      const h1 = cellOf('h1', { [EN]: 'Fax', [FR]: 'Télécopie' }, ['Details', 'More']);
      const h2 = cellOf('h2', { [EN]: 'Pager', [FR]: 'Bip' }, ['Details', 'More']);
      s.add([a1, a2, a3, h1, h2]);
      const a = await sheet(s, () => [it(a1, 'ok'), it(a2, 'ok'), it(a3, 'ok'), it(h1, 'ok', false), it(h2, 'ok', false)]);
      const heads = () => a.el.querySelectorAll('.pl-ph,.pl-pg').map((x) => x.textContent);
      t.eq(heads(), [], 'no caption over the rows of a place');
      t.eq(a.comps(), [a1.comp, a3.comp, a2.comp], 'rows of one place together, in page order; the hidden group closed');
      t.eq(a.hid()?.getAttribute('open'), null);
      // A search whose hits are only off screen: the group opens to show them.
      a.search('telecopie');
      t.eq([a.comps(), a.hid()?.getAttribute('open'), heads()], [[h1.comp], '', []], 'open during a search');
      // Collapsed by the user during the search: it stays collapsed while searching.
      const d = a.hid()!;
      Object.assign(d, { open: false });
      fire(d, 'toggle');
      t.eq([a.comps(), a.hid()?.getAttribute('open')], [[], null]);
      a.search('telecop');
      t.eq(a.hid()?.getAttribute('open'), null, 'the same search, refined');
      // Cleared: back to the user's choice outside searches (collapsed); a new search opens it again.
      a.search('');
      t.eq([a.comps(), a.hid()?.getAttribute('open')], [[a1.comp, a3.comp, a2.comp], null]);
      a.search('bip');
      t.eq([a.comps(), a.hid()?.getAttribute('open')], [[h2.comp], '']);
      a.api.close();
    }),
  );

  t.test(
    "page list: the search follows staged texts and the target language's stand-in text once the mode says the items changed",
    withSheet(async () => {
      const s = new Store();
      // Worded like its column: in German it shows the column's German name.
      const fax = cellOf('fax', { [EN]: 'Fax', [FR]: 'Télécopie' }, ['General', 'Request']);
      const col = colOf('fax', 'DisplayName', { [EN]: 'Fax', [FR]: 'Télécopie', [DE]: 'Faxnummer' });
      s.add([fax, col]);
      const a = await sheet(s, () => [it(fax, s.isEdited(fax.key) ? 'edited' : 'ok')]);
      a.search('faxnummer');
      t.eq(a.comps(), [], "French: its German stand-in is not what the row shows");
      s.set(fax.key, FR, 'Numéro de fax');
      a.emit('items');
      a.search('numero');
      t.eq(a.comps(), [fax.comp], 'the staged text');
      (a.app.prefs as { target: number }).target = DE;
      a.emit('items');
      a.search('faxnummer');
      t.eq([a.comps(), a.row(fax.comp)?.t], [[fax.comp], 'Faxnummer'], 'German: the column name it shows there');
      a.api.close();
    }),
  );

  t.test(
    'page list: changes staged on other pages come last, under the page each lives on; All and Changed count them, Not translated never',
    withSheet(async () => {
      const { AWAY } = await list();
      const s = new Store();
      const a1 = cellOf('a1', { [EN]: 'Phone' }, ['General', 'Request']);
      const h1 = cellOf('h1', { [EN]: 'Fax', [FR]: 'Télécopie' }, ['Details', 'More']);
      const x1 = cellOf('x1', { [EN]: 'Email', [FR]: 'Courriel' }, ['General', 'Reach']);
      const x2 = cellOf('x2', { [EN]: 'Owner', [FR]: 'Propriétaire' }, ['General', 'Owner']);
      const x3 = cellOf('x3', { [EN]: 'Mobile', [FR]: 'Portable' }, ['General', 'Reach']);
      s.add([a1, h1, x1, x2, x3]);
      for (const x of [h1, x1, x2, x3]) s.set(x.key, FR, `${x.labels[FR]} 2`);
      const away = (m: Slot, look: Look, where: string): PageItem => ({ ...it(m, look, false), away: where });
      let items = [it(a1, 'missing'), it(h1, 'edited', false), away(x1, 'edited', 'Contact · Main form'), away(x2, 'error', 'Accounts · Active Accounts'), away(x3, 'edited', 'Contact · Main form')];
      const a = await sheet(s, () => items);
      const texts = (sel: string) => a.el.querySelectorAll(sel).map((x) => x.textContent);
      const counts = () => texts('.pl-n');
      t.eq(texts('.pl-gh'), ['Form1', 'Changed on other pages3'], 'their own group after the page’s (the hidden ones closed)');
      t.eq([texts('.pl-ph'), texts('.pl-pg')], [[], ['Contact · Main form', 'Accounts · Active Accounts']], 'no place caption in the page’s group; a heading per page, said once');
      t.eq(a.layout(), ['g:Form', `r:${a1.comp}`, 'pl-hid', `g:${AWAY}`, 'pl-pg', `r:${x1.comp}`, `r:${x3.comp}`, 'pl-pg', `r:${x2.comp}`], 'under its band');
      // Collapsed like the others: its band and count only.
      fire(a.band(AWAY), 'click');
      t.eq([a.layout(), texts('.pl-gh')], [['g:Form', `r:${a1.comp}`, 'pl-hid', `g:${AWAY}`], ['Form1', 'Changed on other pages3']]);
      fire(a.band(AWAY), 'click');
      t.eq(a.comps(), [a1.comp, x1.comp, x3.comp, x2.comp]);
      t.eq([a.row(x1.comp)?.t, a.row(x1.comp)?.cls, a.row(x2.comp)?.cls], ['Courriel 2', 'pl-t is-chg', 'pl-t is-bad'], 'like the page’s changed rows');
      t.eq(counts(), ['5', '1', '4'], 'All 5, Not translated 1, Changed 4');
      fire(a.el.querySelectorAll('.pl-r').find((r) => r.getAttribute('data-c') === x2.comp)!, 'click');
      t.eq(a.opened, [x2.comp], 'a click finds it (the mode goes to its page)');
      // Not translated: never; Changed: they and the page's changed rows.
      const seg = (n: number) => fire(a.el.querySelectorAll('.seg button')[n], 'click');
      seg(1);
      t.eq([a.comps(), texts('.pl-gh')], [[a1.comp], ['Form1']]);
      seg(2);
      t.eq([a.comps(), texts('.pl-gh')], [['field|f|h1', x1.comp, x3.comp, x2.comp], ['Form1', 'Changed on other pages3']], 'a changed row not on screen (another tab, a hidden field) is listed with the page’s, never in a closed group');
      t.eq(a.el.querySelectorAll('.pl-hid').length, 0, 'no "Not on screen right now" under Changed');
      // The search looks in the page a row lives on too.
      seg(0);
      a.search('contact');
      t.eq(a.comps(), [x1.comp, x3.comp]);
      a.search('accounts');
      t.eq([a.comps(), counts()], [[x2.comp], ['5', '1', '4']], 'the counts stay the filter’s');
      a.search('');
      // Found on its own page: the same row moves into that page's group (the popup stays next to it); rows the new
      // page doesn't show are dropped.
      const rowEl = (c: string) => a.el.querySelectorAll('.pl-r').find((r) => r.getAttribute('data-c') === c);
      const was = rowEl(x2.comp);
      items = [it(x2, 'error'), away(x1, 'edited', 'Contact · Main form')];
      a.emit('page');
      await new Promise((r) => setTimeout(r, 150));
      t.eq([a.comps(), texts('.pl-gh')], [[x2.comp, x1.comp], ['Form1', 'Changed on other pages1']]);
      t.ok(rowEl(x2.comp) === was && a.api.rowOf(x2.comp) === (was as unknown), 'the same row element');
      t.eq(a.api.rowOf(a1.comp), null, "the old page's row is gone");
      // None left elsewhere (published): no such group.
      items = [it(a1, 'missing')];
      a.emit('items');
      await new Promise((r) => setTimeout(r, 150));
      t.eq([texts('.pl-gh'), counts()], [['Form1'], ['1', '1', '0']]);
      a.api.close();
    }),
  );

  t.test(
    'page list: a long list of changes staged elsewhere (a bulk fill in the Workbench) shows the first rows, then Show all',
    withSheet(async () => {
      const { HID_CAP } = await list();
      const s = new Store();
      const cells = Array.from({ length: HID_CAP + 2 }, (_, n) => cellOf(`w${n}`, { [EN]: `Label ${n}` }, ['General', 'S']));
      s.add(cells);
      const a = await sheet(s, () => cells.map((m) => ({ ...it(m, 'edited', false), away: 'Workbench' })));
      const more = () => a.el.querySelectorAll('.pl-aw .pl-more');
      t.eq([a.comps().length, a.el.querySelectorAll('.pl-aw .pl-gh .count').map((x) => x.textContent), more().map((x) => x.textContent)], [HID_CAP, [`${HID_CAP + 2}`], [`Show all ${HID_CAP + 2}`]]);
      fire(more()[0], 'click');
      t.eq([a.comps().length, more().length], [HID_CAP + 2, 0]);
      a.api.close();
    }),
  );

  /** Sets globals (or a prototype's members) for a test; returns what puts them back. */
  const stub = (o: object, vals: Record<string, unknown>): (() => void) => {
    const had = Object.keys(vals).map((k) => [k, Object.getOwnPropertyDescriptor(o, k)] as const);
    for (const [k, v] of Object.entries(vals)) Object.defineProperty(o, k, { value: v, configurable: true, writable: true });
    return () => {
      for (const [k, d] of had)
        if (d) Object.defineProperty(o, k, d);
        else delete (o as Record<string, unknown>)[k];
    };
  };
  const optOf = (id: string, labels: Record<number, string>): Slot =>
    ({ ...t.slot('option', `option|acc.ind|${id}|Label`, labels), comp: `option|acc.ind|${id}`, path: [T, 'Industry (industrycode)', 'Choices'] }) as Slot;
  const choice = (m: Slot, look: Look): PageItem => ({ ...it(m, look), group: 'Choices' });

  t.test(
    "page list: no caption over the rows of a place: the place is in the row's tooltip, read to screen readers and found by the search; a Related menu item says so in its tag",
    withSheet(async () => {
      const s = new Store();
      const own = cellOf('owner', { [EN]: 'Owner' }, ['General', 'Request'], { path: [T, F, 'Header'], ref: { formId: 'f', area: 'header', datafield: 'owner', controlId: 'owner' } });
      const name = cellOf('name', { [EN]: 'Name' }, ['General', 'Request']);
      const nav = { ...t.slot('navitem', 'navitem|f|nav1|Label', { [EN]: 'Contacts' }), comp: 'navitem|f|nav1', path: [T, F, 'Navigation'], ref: { area: 'nav' } } as Slot;
      s.add([own, name, nav]);
      const a = await sheet(s, () => [it(name, 'ok'), it(own, 'ok'), it(nav, 'ok')]);
      t.eq(a.layout(), ['g:Form', `r:${name.comp}`, `r:${own.comp}`, `r:${nav.comp}`], 'rows only under the band, of one place together');
      const tags = () => a.el.querySelectorAll('.pl-r').map((r) => r.querySelector('.pl-k')!.textContent);
      t.eq(tags(), ['', '', 'Related']);
      t.eq([a.row(name.comp)?.aria, a.row(own.comp)?.aria, a.row(nav.comp)?.aria], ['General › Request', 'Header', 'Related']);
      a.search('header');
      t.eq(a.comps(), [own.comp]);
      a.search('related');
      t.eq(a.comps(), [nav.comp]);
      a.search('');
      // The tooltip (ui/widgets.ts tooltip, shown after 450 ms): the kind and the breadcrumb.
      const back = stub(globalThis, { Element: FEl });
      setLayer(dom.layer as unknown as HTMLElement);
      try {
        const r = a.el.querySelectorAll('.pl-r').find((x) => x.getAttribute('data-c') === own.comp)!;
        fire(r, 'pointerenter');
        await new Promise((ok) => setTimeout(ok, 480));
        t.eq(dom.layer.querySelector('.tip')?.textContent, 'English: Owner\nForm field · Service request › Main (Main form) › Header');
        fire(r, 'pointerleave');
      } finally {
        teardownLayer();
        back();
      }
      a.api.close();
    }),
  );

  t.test(
    'page list: a group collapses and expands by its band (a click, Enter, Space) for the session: across renders, filters, pages and lists',
    withSheet(async () => {
      const { HID_KEY } = await list();
      const s = new Store();
      const a1 = cellOf('a1', { [EN]: 'Phone', [FR]: 'Téléphone' }, ['General', 'Request']);
      const a2 = cellOf('a2', { [EN]: 'Email' }, ['General', 'Request']);
      const h1 = cellOf('h1', { [EN]: 'Fax' }, ['Details', 'More']);
      const o1 = optOf('1', { [EN]: 'Small' });
      s.add([a1, a2, h1, o1]);
      const items = () => [it(a1, 'ok'), it(a2, 'missing'), choice(o1, 'missing'), it(h1, 'ok', false)];
      const a = await sheet(s, items);
      t.eq(a.bands(), [['Form', 'true', 'Form2'], ['Choices', 'true', 'Choices1']], 'open at first; the name and count on each band');
      const tagOf = (x: typeof a, c: string) => x.el.querySelectorAll('.pl-r').find((r) => r.getAttribute('data-c') === c)!.querySelector('.pl-k')!.textContent;
      t.eq([tagOf(a, o1.comp), tagOf(a, a1.comp)], ['Industry', ''], "a choice value's tag: its column");
      fire(a.band('Form'), 'click');
      t.eq(a.layout(), ['g:Form', 'g:Choices', `r:${o1.comp}`, 'pl-hid'], 'collapsed: its band only, the next band right under it');
      t.eq(a.bands()[0], ['Form', 'false', 'Form2'], 'its count stays');
      a.api.refresh();
      const seg = (n: number) => fire(a.el.querySelectorAll('.seg button')[n], 'click');
      seg(1);
      t.eq([a.layout(), a.bands()[0]], [['g:Form', 'g:Choices', `r:${o1.comp}`], ['Form', 'false', 'Form1']], 'kept across renders and filters');
      seg(0);
      a.emit('page');
      await new Promise((r) => setTimeout(r, 150));
      t.eq(a.band('Form').getAttribute('aria-expanded'), 'false', 'and pages');
      // Inside "Not on screen right now" a group of the same name is another one.
      const d = a.hid()!;
      Object.assign(d, { open: true });
      fire(d, 'toggle');
      t.eq(a.layout(), ['g:Form', 'g:Choices', `r:${o1.comp}`, 'pl-hid', `g:${HID_KEY}Form`, `r:${h1.comp}`]);
      fire(a.band('Form'), 'click');
      t.eq(a.bands().map((b) => b[1]), ['true', 'true', 'true'], 'expanded again');
      fire(a.band('Choices'), 'click');
      a.api.close();
      const b = await sheet(s, items, FR, { app: a.app });
      t.eq(b.bands(), [['Form', 'true', 'Form2'], ['Choices', 'false', 'Choices1']], 'the next list of the session too');
      b.api.close();
      const c = await sheet(s, items);
      t.eq(c.bands().map((x) => x[1]), ['true', 'true'], 'not another session’s');
      // The keyboard: a band is a stop of the list's arrow keys; Enter and Space toggle it, and it keeps the focus.
      const key = (e: FEl, k: string) => fire(e, 'keydown', { key: k, target: e });
      const tabs = () => c.el.querySelectorAll('.pl-gb,.pl-r').map((x) => x.tabIndex);
      t.eq(tabs(), [-1, 0, -1, -1, -1], 'Tab into the list: its first label, not a band');
      const input = c.el.querySelector('input')!;
      key(input, 'ArrowDown');
      t.eq(c.focused()?.getAttribute('data-c'), a1.comp, 'down from the search: the first label');
      key(c.focused()!, 'ArrowUp');
      t.eq(c.focused() === c.band('Form'), true, 'up: its band');
      key(c.focused()!, 'Enter');
      t.eq([c.focused() === c.band('Form'), c.band('Form').getAttribute('aria-expanded')], [true, 'false'], 'Enter collapses it, the focus stays on its band');
      key(c.focused()!, 'ArrowDown');
      t.eq(c.focused() === c.band('Choices'), true, 'down: the next band');
      t.eq(tabs(), [-1, 0, -1], 'one stop takes Tab into the list: the one used last');
      // Kept through a render: a band that isn't the first (collapsed here), then a row (the list refreshed).
      key(c.focused()!, 'Enter');
      t.eq([c.band('Choices').getAttribute('aria-expanded'), tabs()], ['false', [-1, 0]], 'the band used last, after its group collapsed');
      key(input, 'ArrowDown');
      t.eq(c.focused() === c.band('Form'), true, 'every group collapsed: down from the search goes to the first band');
      key(c.focused()!, 'ArrowDown');
      key(c.focused()!, ' ');
      key(c.focused()!, 'ArrowDown');
      t.eq(c.focused()?.getAttribute('data-c'), o1.comp);
      c.api.refresh();
      t.eq(tabs(), [-1, -1, 0], 'the row used last, after a render');
      key(c.focused()!, 'ArrowUp');
      key(c.focused()!, 'ArrowUp');
      key(c.focused()!, ' ');
      t.eq([c.focused() === c.band('Form'), c.band('Form').getAttribute('aria-expanded')], [true, 'true'], 'Space expands it');
      key(c.focused()!, 'ArrowDown');
      t.eq(c.focused()?.getAttribute('data-c'), a1.comp, 'its first row');
      key(c.focused()!, 'ArrowUp');
      key(c.focused()!, 'ArrowUp');
      t.eq(c.focused()?.tagName, 'INPUT', 'up from the first band: the search');
      // Type, Down, Enter: the first hit opens (never its group collapsing).
      c.search('email');
      key(input, 'ArrowDown');
      key(c.focused()!, 'Enter');
      t.eq([c.opened, c.band('Form').getAttribute('aria-expanded')], [[a2.comp], 'true'], 'the search, Down, Enter opens the first hit');
      c.api.close();
    }),
  );

  t.test(
    'page list: in Process each stage heads its steps, in Choices each value says its column',
    withSheet(async () => {
      const s = new Store();
      const bp = (kind: Kind, id: string, title: string, path: string[]): Slot => ({ ...t.slot(kind, `${kind}|w|${id}|Label`, { [EN]: title }), comp: `${kind}|w|${id}`, title, path }) as Slot;
      const q = bp('stage', 'q', 'Qualify', ['Lead to Opportunity']);
      const d = bp('stage', 'd', 'Develop', ['Lead to Opportunity']);
      const s1 = bp('step', 's1', 'Contact', ['Lead to Opportunity', 'Qualify']);
      const s2 = bp('step', 's2', 'Budget', ['Lead to Opportunity', 'Develop']);
      const s3 = bp('step', 's3', 'Account', ['Lead to Opportunity', 'Qualify']);
      const bool = (id: string, col: string, text: string): Slot =>
        ({ ...t.slot('boolean', `boolean|acc.${id}|${text}|Label`, { [EN]: text }), comp: `boolean|acc.${id}|${text}`, path: ['Account', col, 'Choices'] }) as Slot;
      const e1 = bool('donotemail', 'Do not allow Emails (donotemail)', 'Allow');
      const b1 = bool('donotbulkemail', 'Do not allow Bulk Emails (donotbulkemail)', 'Allow');
      s.add([q, d, s1, s2, s3, e1, b1]);
      const proc = (m: Slot): PageItem => ({ ...it(m, 'ok'), group: 'Process' });
      const a = await sheet(s, () => [proc(q), proc(d), proc(s1), proc(s2), proc(s3), choice(e1, 'ok'), choice(b1, 'ok')]);
      t.eq(a.layout(), ['g:Choices', `r:${e1.comp}`, `r:${b1.comp}`, 'g:Process', `r:${q.comp}`, `r:${s1.comp}`, `r:${s3.comp}`, `r:${d.comp}`, `r:${s2.comp}`]);
      const tags = () => a.el.querySelectorAll('.pl-r').map((r) => `${r.querySelector('.pl-b')!.textContent} · ${r.querySelector('.pl-k')!.textContent}`);
      t.eq(tags(), ['Allow · Do not allow Emails', 'Allow · Do not allow Bulk Emails', 'Qualify · Stage', 'Contact · Step', 'Account · Step', 'Develop · Stage', 'Budget · Step']);
      a.api.close();
    }),
  );

  t.test(
    'page list: a search shows its hits in a collapsed group, unless collapsed during that search; cleared, the group is as the user left it',
    withSheet(async () => {
      const s = new Store();
      const a1 = cellOf('a1', { [EN]: 'Phone', [FR]: 'Téléphone' }, ['General', 'Request']);
      const a2 = cellOf('a2', { [EN]: 'Email' }, ['General', 'Request']);
      const o1 = optOf('1', { [EN]: 'Small' });
      s.add([a1, a2, o1]);
      const a = await sheet(s, () => [it(a1, 'ok'), it(a2, 'ok'), choice(o1, 'ok')]);
      const open = () => a.band('Form').getAttribute('aria-expanded');
      fire(a.band('Form'), 'click');
      a.search('phone');
      t.eq([a.bands(), a.comps()], [[['Form', 'true', 'Form1']], [a1.comp]], 'open with its hits, counted on its band');
      fire(a.band('Form'), 'click');
      t.eq([a.bands(), a.comps()], [[['Form', 'false', 'Form1']], []], 'collapsed during the search');
      a.search('phon');
      t.eq(open(), 'false', 'the same search, refined');
      a.search('');
      t.eq([open(), a.comps()], ['false', [o1.comp]], 'cleared: collapsed as before the search');
      fire(a.band('Form'), 'click');
      a.search('phone');
      t.eq([open(), a.comps()], ['true', [a1.comp]], 'a new search opens a group collapsed during the last one');
      fire(a.band('Form'), 'click');
      a.search('');
      t.eq(open(), 'true', 'collapsed during a search only: open as the user left it');
      a.search('tele');
      t.eq([open(), a.comps()], ['true', [a1.comp]], 'a new search');
      a.api.close();
    }),
  );

  t.test(
    'page list: dragged by its header it floats inside the window, its place in prefs; the pin and a double-click dock it; it opens again where it was',
    withSheet(async () => {
      const s = new Store();
      const a1 = cellOf('a1', { [EN]: 'Phone' }, ['General', 'Request']);
      s.add([a1]);
      const items = () => [it(a1, 'ok')];
      const a = await sheet(s, items);
      const el = a.el;
      const box = (x = a) => [x.el.classList.contains('is-float'), x.el.style.left || '', x.el.style.top || '', x.el.style.width || '', x.el.style.height || '', x.pin().getAttribute('aria-pressed')];
      const docked = [false, '', '', '', '', 'true'];
      t.eq([box(), a.pin().getAttribute('aria-label')], [docked, 'Dock to the right'], 'docked on the right at first: the pin pressed');
      // A 1000 × 800 window (the fake innerWidth and innerHeight); docked, the sheet is its right 360 px.
      let at = { left: 640, top: 0 };
      Object.assign(el, { getBoundingClientRect: () => ({ ...at, right: at.left + 360, bottom: 800, width: 360, height: 800 }) });
      const ptr = (type: string, x: number, y: number, on: FEl = a.head()) => fire(on, type, { button: 0, pointerId: 1, clientX: x, clientY: y, target: on } as unknown as Partial<FireEv>);
      // A click on the header (to bring the sheet forward, say), and a double-click, with their pointer events: docked.
      ptr('pointerdown', 700, 20);
      ptr('pointerup', 700, 20);
      t.eq([box(), a.app.saved], [docked, []], 'a click on the header never floats it');
      for (let n = 0; n < 2; n++) {
        ptr('pointerdown', 700, 20);
        ptr('pointerup', 700, 20);
      }
      fire(a.head(), 'dblclick', { target: a.head() });
      t.eq([box(), a.app.saved], [docked, []], 'nor a double-click');
      ptr('pointerdown', 700, 20);
      ptr('pointermove', 702, 21);
      t.eq(box(), docked, 'not before 4 px: a click on the header stays a click');
      ptr('pointermove', 300, 120);
      t.eq(box(), [true, '240px', '100px', '360px', '640px', 'false'], 'floating where it is dragged, min(640, 800 − 32) high');
      t.eq(a.app.saved, [], 'saved once dropped');
      ptr('pointerup', 300, 120);
      t.eq([box()[0], a.app.saved], [true, [{ list: { float: true, x: 0.372, y: 0.639 } }]]);
      // Always inside the window.
      at = { left: 240, top: 100 };
      ptr('pointerdown', 300, 120);
      ptr('pointermove', -500, -500);
      t.eq(box().slice(1, 3), ['8px', '8px'], 'not past the top left');
      ptr('pointermove', 5000, 5000);
      t.eq(box().slice(1, 3), ['632px', '152px'], 'nor the bottom right');
      ptr('pointerup', 5000, 5000);
      t.eq(a.app.prefs.list, { float: true, x: 1, y: 1 });
      // Its buttons are no handle: neither a drag nor a double-click on them.
      ptr('pointerdown', 900, 20, a.pin());
      ptr('pointermove', 100, 100, a.pin());
      ptr('pointerup', 100, 100, a.pin());
      fire(a.pin(), 'dblclick', { target: a.pin() });
      t.eq([box()[1], a.app.saved.length], ['632px', 2]);
      // A double-click on the header docks it; its floating place is kept for the pin.
      fire(a.head(), 'dblclick', { target: a.head() });
      t.eq([box(), a.app.prefs.list], [docked, { float: false, x: 1, y: 1 }], 'docked');
      fire(a.head(), 'dblclick', { target: a.head() });
      t.eq([box(), a.app.saved.length], [docked, 3], 'docked already: nothing');
      fire(a.pin(), 'click');
      t.eq([box(), a.app.prefs.list], [[true, '632px', '152px', '360px', '640px', 'false'], { float: true, x: 1, y: 1 }], 'the pin floats it there again');
      fire(a.pin(), 'click');
      t.eq([box(), a.app.prefs.list?.float], [docked, false], 'and docks it');
      fire(a.pin(), 'click');
      a.api.close();
      const b = await sheet(s, items, FR, { app: a.app });
      t.eq(box(b), [true, '632px', '152px', '360px', '640px', 'false'], 'the next list opens where the last one was');
      b.api.close();
      // And after a reload: the prefs as stored (ui/app.ts savePrefs) and read back (readPrefs) keep its place.
      const { readPrefs } = await import('../../../src/ui/app');
      const ctx = { base: EN, user: EN, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] };
      const back = readPrefs(ctx, JSON.stringify(a.app.prefs));
      t.eq([back.list, back.target], [{ float: true, x: 1, y: 1 }, FR]);
      const r = await sheet(s, items, FR, { prefs: back });
      t.eq(box(r), [true, '632px', '152px', '360px', '640px', 'false'], 'reloaded, it opens where it was');
      r.api.close();
      t.eq(readPrefs(ctx, '{"list":{"float":false,"x":0.25,"y":0.5},"bar":{"top":true}}').list, { float: false, x: 0.25, y: 0.5 }, 'docked, its floating place kept');
      for (const bad of ['{"list":"left"}', '{"list":null}', '{"list":3}', '{}', 'not json', null]) t.eq(readPrefs(ctx, bad).list, undefined, `nothing to keep: ${bad}`);
      // Prefs hold anything: only float: true floats it, at a place inside the window.
      const c = await sheet(s, items, FR, { prefs: { list: { float: 'yes', x: 3 } as never } });
      t.eq(box(c), docked);
      c.api.close();
      const d = await sheet(s, items, FR, { prefs: { list: { float: true, x: 'a', y: 9 } as never } });
      t.eq(box(d).slice(0, 3), [true, '8px', '152px']);
      d.api.close();
    }),
  );

  t.test('page list: a floating sheet is always inside the window, at the same place as the window changes', async () => {
    const { floatBox, floatPlace } = await list();
    t.eq(floatBox(1000, 800), { left: 8, top: 8, width: 360, height: 640 }, 'no place yet: the top left');
    t.eq(floatBox(1000, 800, { x: 0.5, y: 0.5 }), { left: 320, top: 80, width: 360, height: 640 });
    t.eq(floatBox(1000, 800, { x: 1, y: 1 }), { left: 632, top: 152, width: 360, height: 640 });
    t.eq(floatBox(1600, 1000, { x: 1, y: 1 }), { left: 1232, top: 352, width: 360, height: 640 }, 'a bigger window: still at its bottom right');
    t.eq(floatBox(700, 500, { x: 1, y: 1 }), { left: 332, top: 24, width: 360, height: 468 }, 'a smaller one: shorter, inside it');
    t.eq(floatBox(300, 200, { x: 1, y: 1 }), { left: 8, top: 24, width: 284, height: 168 }, 'narrower than the sheet');
    t.eq(floatBox(1000, 800, { x: 7, y: -3 }), floatBox(1000, 800, { x: 1, y: 0 }), 'a place out of range');
    t.eq(floatBox(1000, 800, { x: 'a', y: NaN }), floatBox(1000, 800), 'or not a number');
    t.eq(floatPlace(1000, 800, 240, 100), { x: 0.372, y: 0.639 });
    t.eq(floatPlace(1000, 800, -50, -50), { x: 0, y: 0 });
    t.eq(floatPlace(1000, 800, 5000, 5000), { x: 1, y: 1 });
    t.eq(floatPlace(300, 200, 100, 100), { x: 0, y: 1 }, 'no room across');
    for (const [l, tp] of [[8, 8], [240, 100], [632, 152]]) {
      const b = floatBox(1000, 800, floatPlace(1000, 800, l, tp));
      t.eq([b.left, b.top], [l, tp], 'where it was dropped');
    }
  });

  t.test(
    'page list: the bar keeps clear of the sheet only while it is docked, and lays out again when it floats or docks (its class)',
    withSheet(async () => {
      const { createBar } = await import('../../../src/ui/bar');
      const obs: Array<{ cb: () => void; seen: Map<unknown, unknown> }> = [];
      const back = [
        stub(globalThis, {
          MutationObserver: class {
            seen = new Map<unknown, unknown>();
            constructor(public cb: () => void) {
              obs.push(this);
            }
            observe(n: unknown, o: unknown) {
              this.seen.set(n, o);
            }
            disconnect() {}
          },
          requestAnimationFrame: (cb: () => void) => (cb(), 1),
        }),
        stub(FEl.prototype, { getClientRects: () => [{}] }),
        stub(document, { querySelector: () => null }),
      ];
      try {
        const s = new Store();
        const mode = { loading: () => false, notes: () => [], counts: () => ({ pending: 0 }), on: () => () => {} } as unknown as PageMode;
        const app = fakeApp(s, FR);
        const bar = createBar(app, mode, { exit() {}, list() {}, workbench() {}, publish() {}, history() {} });
        const tb = (bar.el as unknown as FEl).querySelector('.tb')!;
        dom.layer.appendChild(bar.el as unknown as FEl);
        Object.assign(dom.layer, { clientWidth: 1000, clientHeight: 800 });
        const a = await sheet(s, () => [], FR, { app });
        // Laid out as its stylesheet does: docked, the right 360 px at full height; floating, its box.
        const lay = () =>
          Object.assign(
            a.el,
            a.el.classList.contains('is-float')
              ? { offsetLeft: parseInt(a.el.style.left), offsetTop: parseInt(a.el.style.top), offsetWidth: 360, offsetHeight: parseInt(a.el.style.height) }
              : { offsetLeft: 640, offsetTop: 0, offsetWidth: 360, offsetHeight: 800 },
          );
        lay();
        obs[0].cb(); // the layer's children changed
        t.eq(tb.style.width, '608px', 'docked: left of it');
        t.eq(obs[0].seen.get(a.el), { attributes: true, attributeFilter: ['class', 'hidden'] }, 'its class is watched');
        fire(a.pin(), 'click');
        lay();
        obs[0].cb(); // its class changed
        t.eq(tb.style.width, '968px', 'floating: the whole width');
        fire(a.pin(), 'click');
        lay();
        obs[0].cb();
        t.eq(tb.style.width, '608px', 'docked again');
        a.api.close();
        bar.destroy();
      } finally {
        for (const f of back) f();
      }
    }),
  );

  t.test("page list: a change staged elsewhere is headed by the page it lives on, else the page it was staged on, else 'Workbench'", async () => {
    const { awayTitle } = await status();
    const G = '11111111-2222-4333-8444-555566667777';
    const V = 'b0000000-0000-4000-8000-00000000000a';
    const D = 'd0000000-0000-4000-8000-00000000000d';
    const A = 'a0000000-0000-4000-8000-0000000000aa';
    const s = new Store();
    const named = (key: string, en: string): Slot => ({ ...t.slot(key.split('|')[0], key, { [EN]: en }), comp: key.split('|').slice(0, -1).join('|') }) as Slot;
    s.add([named('entity|contact|DisplayName', 'Contact'), named('entity|account|DisplayCollectionName', 'Accounts'), named(`view|${V}|Name`, 'Active Accounts'), named(`dashboard|${D}|Name`, 'Sales'), named(`app|${A}|Name`, 'Sales Hub')]);
    const app = { store: s, ctx: { base: EN, user: EN, langs: [] }, prefs: { target: FR } } as unknown as AppApi;
    const cell = { ...t.slot('field', `field|${G}|c1|Label`), entity: 'contact', path: ['Contact', 'Contoso Main Form (Main form)', 'General', 'Details'], ref: { formId: G } } as Slot;
    const form = { to: 'form', entity: 'contact', formId: G, recordId: '' } as const;
    t.eq(awayTitle(app, cell, form, null), 'Contact · Contoso Main Form', "a form never shown here: named as the cell's breadcrumb names it");
    s.add([named(`form|${G}|Name`, 'Contact Main')]);
    t.eq(awayTitle(app, cell, form, null), 'Contact · Contact Main', 'its name, once loaded');
    const forms = new Map([['f2', { name: 'Card', type: 11 }]]);
    t.eq(awayTitle(app, cell, { ...form, formId: 'f2' }, null, { forms }), 'Contact · Card', "a form the page tracker knows: its own name");
    t.eq(awayTitle(app, cell, { to: 'list', entity: 'account', viewId: V, viewType: 'savedquery' }, null), 'Accounts · Active Accounts');
    t.eq(awayTitle(app, cell, { to: 'dashboard', dashboardId: D }, null), 'Sales · Dashboard');
    const apps = { type: 'apps', entity: '', recordId: '', formId: '', viewId: '', viewType: '', dashboardId: '' } as const;
    t.eq(awayTitle(app, cell, null, apps, { appId: A }), 'Sales Hub · App navigation', 'staged on the app navigation, nowhere to go');
    t.eq(awayTitle(app, cell, null, apps), 'Another page', 'a page without a name');
    t.eq(awayTitle(app, cell, null, null), 'Workbench', 'changed in the Workbench, nowhere to go');
  });
}
