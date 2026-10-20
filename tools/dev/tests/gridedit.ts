// The Workbench grid's cell editor, driven on the fake DOM of tools/dev/tests/callout.ts: what it stages when the rows
// are refreshed under an open editor (a page or Workbench load replaced the slot with newer server text).
// register() is called by tools/dev/unit.ts.
import { PublishSet, type Slot } from '../../../src/core/model';
import { Store } from '../../../src/core/store';
import { recordsWriter } from '../../../src/providers/records';
import type { AppApi } from '../../../src/ui/types';
import { createGrid } from '../../../src/workbench/grid';
import type { GridApi } from '../../../src/workbench/types';
import { dom, FEl, fire, install } from './callout';
import type { Kit } from './kit';

const EN = 1033;
const FR = 1036;

interface G {
  store: Store;
  grid: GridApi;
  /** Opens the active cell's editor (F2), as the user does; returns it. */
  open(): FEl;
  /** Replaces the slot with one holding `labels` (what a reload does: store.add, then the Workbench's setRows). */
  reload(labels: Record<number, string>): void;
}

/** The grid on the fake DOM, one view name (English "Active Accounts", French "Comptes actifs"), French column active. */
function withGrid(fn: (g: G) => unknown): () => Promise<unknown> {
  return async () => {
    const off = install();
    const g = globalThis as Record<string, unknown>;
    const idDesc = Object.getOwnPropertyDescriptor(FEl.prototype, 'id')!;
    const doc = document as unknown as { createElement(t: string): FEl };
    const make = doc.createElement;
    // What the grid needs beyond the popup's fake DOM: element ids it sets, CSS variables, a ResizeObserver.
    Object.defineProperty(FEl.prototype, 'id', { get: idDesc.get, set(this: FEl, v: string) { this.attrs.id = String(v); }, configurable: true });
    doc.createElement = (t: string) => Object.assign(make(t), { style: { setProperty() {}, removeProperty() {} } });
    g.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    let grid: GridApi | undefined;
    try {
      const store = new Store();
      const slot = {
        key: 'view|v1|Name',
        kind: 'view',
        prop: 'Name',
        entity: 'account',
        comp: 'view|v1',
        group: 'view|v1',
        title: 'Active Accounts',
        path: ['Account'],
        sub: '',
        labels: { [EN]: 'Active Accounts', [FR]: 'Comptes actifs' },
        readOnly: '',
        baseRequired: true,
        max: 0,
        order: 0,
        ref: { id: 'v1', table: 'savedquery', entitySet: 'savedqueries', column: 'name', entity: 'account' },
      } as unknown as Slot;
      store.add([slot]);
      const app = {
        store,
        ctx: { base: EN, user: EN, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] },
        prefs: { target: FR, shown: [], showNames: false },
        adoptStyles() {},
        toast() {},
        root: dom.root,
        layer: dom.layer,
      } as unknown as AppApi;
      grid = createGrid(app, { widths: {}, onWidths() {}, onSel() {}, ctx: { store, tableName: () => 'Account' } });
      dom.layer.append(grid.el as unknown as FEl);
      grid.setSheet('views', [], () => 'Name', [EN, FR], FR);
      grid.setRows([slot]);
      const G: G = {
        store,
        grid,
        open() {
          fire(grid!.el as unknown as FEl, 'keydown', { key: 'F2' });
          return dom.layer.querySelector('textarea')!;
        },
        reload(labels) {
          const fresh = { ...store.get(slot.key)!, labels: { ...labels } };
          store.add([fresh]);
          grid!.setRows([fresh]);
        },
      };
      return await fn(G);
    } finally {
      grid?.destroy();
      Object.defineProperty(FEl.prototype, 'id', idDesc);
      doc.createElement = make;
      delete g.ResizeObserver;
      off();
    }
  };
}

const DE = 1031;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface R {
  store: Store;
  grid: GridApi;
  /** What the grid said (app.toast), in order. */
  toasts: string[];
  /** Presses a key on the grid. */
  key(key: string, o?: { ctrl?: boolean; shift?: boolean }): void;
  /** Fires a clipboard event on the grid; `text` is what a paste brings. Returns what a copy or cut put there. */
  clip(type: 'copy' | 'cut' | 'paste', text?: string): string;
  /** Shows other languages, as the language menu does (the Workbench sets the sheet's columns again). */
  langs(ls: number[], target: number): void;
}

/** The grid on the fake DOM with `slots` as its rows (English base; French, then `ls`, shown), the target column active. */
function withRows(slots: Slot[], fn: (r: R) => unknown, ls = [EN, FR]): () => Promise<unknown> {
  return async () => {
    const off = install();
    const g = globalThis as Record<string, unknown>;
    const idDesc = Object.getOwnPropertyDescriptor(FEl.prototype, 'id')!;
    const doc = document as unknown as { createElement(t: string): FEl };
    const make = doc.createElement;
    Object.defineProperty(FEl.prototype, 'id', { get: idDesc.get, set(this: FEl, v: string) { this.attrs.id = String(v); }, configurable: true });
    doc.createElement = (t: string) => Object.assign(make(t), { style: { setProperty() {}, removeProperty() {} } });
    g.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    let grid: GridApi | undefined;
    try {
      const store = new Store();
      store.add(slots);
      const toasts: string[] = [];
      const app = {
        store,
        ctx: { base: EN, user: EN, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }, { lcid: DE, name: 'German', isBase: false }] },
        prefs: { target: FR, shown: [], showNames: false },
        adoptStyles() {},
        toast: (text: string) => void toasts.push(text),
        root: dom.root,
        layer: dom.layer,
      } as unknown as AppApi;
      const gr = (grid = createGrid(app, { widths: {}, onWidths() {}, onSel() {}, ctx: { store, tableName: () => 'Account' } }));
      dom.layer.append(gr.el as unknown as FEl);
      gr.setSheet('tabs', [], () => 'Label', ls, FR);
      gr.setRows(slots);
      const el = gr.el as unknown as FEl;
      return await fn({
        store,
        grid: gr,
        toasts,
        key: (key, o = {}) => void fire(el, 'keydown', { key, ctrlKey: !!o.ctrl, shiftKey: !!o.shift, stopPropagation() {} } as never),
        clip(type, text = '') {
          let out = '';
          const clipboardData = { setData: (_: string, v: string) => void (out = v), getData: (f: string) => (f === 'text/plain' ? text : '') };
          fire(el, type, { clipboardData } as never);
          return out;
        },
        langs: (l, target) => gr.setSheet('tabs', [], () => 'Label', l, target),
      });
    } finally {
      grid?.destroy();
      Object.defineProperty(FEl.prototype, 'id', idDesc);
      doc.createElement = make;
      delete g.ResizeObserver;
      off();
    }
  };
}

/**
 * The async Clipboard API the grid falls back to when the host swallows the clipboard events: each call waits until
 * the test answers it. `text` is what readText brings; `written` what writeText was given.
 */
function fakeClipboard() {
  const was = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const pending: Array<() => void> = [];
  const c = {
    text: '',
    written: [] as string[],
    /** Answers every call made so far. */
    answer: () => pending.splice(0).forEach((f) => f()),
    restore: () => (was ? Object.defineProperty(globalThis, 'navigator', was) : delete (globalThis as Record<string, unknown>).navigator),
  };
  const later = <T>(v: () => T) => new Promise<T>((ok) => pending.push(() => ok(v())));
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { readText: () => later(() => c.text), writeText: (t: string) => (c.written.push(t), later(() => undefined)) } },
    configurable: true,
    writable: true,
  });
  return c;
}

const type = (ed: FEl, v: string) => {
  ed.value = v;
  fire(ed, 'input');
};
const writeOpts = () => ({ signal: new AbortController().signal, publish: new PublishSet(), progress() {}, force: new Set<string>(), lang: null as never, allowPublish: true });
const changes = (s: Store) => s.changes().map((c) => [c.lcid, c.before, c.after]);

export function register(t: Kit): void {
  const { test, eq, ok } = t;

  test(
    "grid editor: text typed before a reload brought someone else's text stays measured against the text it was typed over, so saving it is a conflict",
    withGrid(async ({ store, open, reload }) => {
      const ed = open();
      eq(ed.value, 'Comptes actifs');
      type(ed, 'Mes comptes');
      reload({ [EN]: 'Active Accounts', [FR]: 'Comptes (autre)' });
      eq(changes(store), [[FR, 'Comptes actifs', 'Mes comptes']], 'the base is the text the editor opened on');
      eq(store.moved('view|v1|Name', FR), true, 'shown as changed on the server under the edit');
      // The real writer reads the other maker's text, which is not the edit's base: a conflict, nothing written.
      let posts = 0;
      const srv = { [EN]: 'Active Accounts', [FR]: 'Comptes (autre)' };
      const http = {
        fn: () => 'RetrieveLocLabels()',
        get: async () => ({ Label: { LocalizedLabels: Object.entries(srv).map(([l, v]) => ({ Label: v, LanguageCode: Number(l) })) } }),
        post: async () => void posts++,
      };
      const res = await recordsWriter.save({ http, base: EN, user: EN, langs: [] } as never, store.changes(), writeOpts());
      eq([res[0].outcome, res[0].server, posts], ['conflict', 'Comptes (autre)', 0]);
    }),
  );

  test(
    'grid editor: an editor left untouched stages nothing when a reload brings other text; the cell shows the new text',
    withGrid(({ store, open, reload }) => {
      open();
      reload({ [EN]: 'Active Accounts', [FR]: 'Comptes (autre)' });
      eq(changes(store), [], 'no edit putting the old text back');
      eq([store.value('view|v1|Name', FR), dom.layer.querySelector('textarea')], ['Comptes (autre)', null]);
    }),
  );

  test(
    'grid editor: with no reload, typed text is an edit of the server text; typed back to it, nothing',
    withGrid(({ store, grid, open }) => {
      type(open(), 'Mes comptes');
      grid.commit();
      eq(changes(store), [[FR, 'Comptes actifs', 'Mes comptes']]);
      type(open(), 'Comptes actifs');
      grid.commit();
      eq(changes(store), []);
    }),
  );

  test(
    'grid editor: a pending edit typed again keeps its base through a reload; one the reload made the server text is edited from that text',
    withGrid(({ store, grid, open, reload }) => {
      type(open(), 'Mes comptes');
      grid.commit();
      // A reload with other text: the edit stays on its base, typed further or not.
      type(open(), 'Mes comptes 2');
      reload({ [EN]: 'Active Accounts', [FR]: 'Comptes (autre)' });
      eq(changes(store), [[FR, 'Comptes actifs', 'Mes comptes 2']]);
      // The server now holds the very text the editor opened on (saved from another tab): the edit was dropped by the
      // reload, and what is typed now is an edit of that text, not a conflict with it.
      type(open(), 'Mes comptes 3');
      reload({ [EN]: 'Active Accounts', [FR]: 'Mes comptes 2' });
      eq(changes(store), [[FR, 'Mes comptes 2', 'Mes comptes 3']]);
    }),
  );

  // ---- Fill down (Ctrl+D) and pastes from a cell whose language was not loaded ----
  /** Form tabs: General not read in French (unknown), Details and Notes read in both. */
  const tabs = () => {
    const tab = (id: string, labels: Record<number, string>, partial: number[]) => ({ ...t.slot('tab', `tab|f1|${id}|Label`, labels), ref: { formId: 'f1', partial } }) as unknown as Slot;
    return [tab('t1', { [EN]: 'General' }, [EN]), tab('t2', { [EN]: 'Details', [FR]: 'Détails' }, [EN, FR]), tab('t3', { [EN]: 'Notes', [FR]: 'Remarques' }, [EN, FR])];
  };
  const NL = 'whose source cell is not loaded (its text is unknown, not empty)';

  test(
    'grid fill down: a source cell not loaded is never copied as empty over a translation; another language of the row still fills',
    withRows(tabs(), ({ store, toasts, key }) => {
      // French column of General, Details and Notes; Ctrl+D copies General's into the two below.
      key('ArrowDown', { shift: true });
      key('ArrowDown', { shift: true });
      key('d', { ctrl: true });
      eq([store.value('tab|f1|t2|Label', FR), store.value('tab|f1|t3|Label', FR), store.pendingCount()], ['Détails', 'Remarques', 0], 'the translations stay');
      eq(toasts, [`Skipped 2 cells ${NL}.`]);
      // English and French of General into Details: the English is known, so it fills; the French is skipped.
      key('ArrowUp', { ctrl: true });
      key('ArrowLeft', { shift: true });
      key('ArrowDown', { shift: true });
      key('d', { ctrl: true });
      eq([store.value('tab|f1|t2|Label', EN), store.value('tab|f1|t2|Label', FR)], ['General', 'Détails']);
      eq(toasts[1], `Filled 1 cell. Skipped 1 cell ${NL}.`);
    }),
  );

  test(
    'grid fill down: the cells skipped for a source not loaded are one item of the list of skipped cells, between the others',
    withRows(
      (() => {
        const [, details, notes] = tabs();
        // General known to be blank in English, not read in French; Details needs its English; Notes is read-only.
        const general = { ...t.slot('tab', 'tab|f1|t1|Label', { [EN]: '' }), ref: { formId: 'f1', partial: [EN] } } as unknown as Slot;
        return [general, { ...details, baseRequired: true }, { ...notes, readOnly: 'Managed.' }] as Slot[];
      })(),
      ({ store, toasts, key }) => {
        // English and French of General down over Details and Notes.
        key('ArrowLeft', { shift: true });
        key('ArrowDown', { shift: true });
        key('ArrowDown', { shift: true });
        key('d', { ctrl: true });
        eq(store.pendingCount(), 0);
        eq(toasts, [`Skipped 1 read-only cell, 2 cells ${NL} and 1 cell where the English label can't be blank.`]);
      },
    ),
  );

  test(
    'grid fill down: one row takes the row above, skipped when that one is not loaded; a source typed in, or known to be empty, fills as before',
    withRows(tabs(), ({ store, toasts, key }) => {
      key('ArrowDown');
      key('d', { ctrl: true });
      eq([store.value('tab|f1|t2|Label', FR), toasts], ['Détails', [`Skipped 1 cell ${NL}.`]]);
      // A text typed into the unread cell is known: it fills.
      store.set('tab|f1|t1|Label', FR, 'Général');
      key('d', { ctrl: true });
      eq(store.value('tab|f1|t2|Label', FR), 'Général');
      // Details now known to be empty in French: an ordinary empty cell, which fills (the tab gets its stand-in on save).
      store.undo();
      store.undo();
      store.set('tab|f1|t2|Label', FR, '');
      key('ArrowDown');
      key('d', { ctrl: true });
      eq([store.value('tab|f1|t3|Label', FR), store.isEdited('tab|f1|t3|Label', FR)], ['', true], 'a known empty text is copied');
    }),
  );

  test(
    "grid paste: the grid's own copy of a cell not loaded is skipped, never pasted as empty; the other cells paste",
    withRows(tabs(), ({ store, toasts, key, clip }) => {
      // Copy French of General (not loaded) and Details, then paste them on Details and Notes.
      key('ArrowDown', { shift: true });
      const copied = clip('copy');
      eq(copied, '\r\nDétails\r\n');
      key('Escape'); // Details' French cell alone
      clip('paste', copied);
      eq([store.value('tab|f1|t2|Label', FR), store.value('tab|f1|t3|Label', FR)], ['Détails', 'Détails']);
      eq(toasts, [`Pasted 1 cell. Skipped 1 cell ${NL}.`]);
      // The same text from elsewhere (a spreadsheet) is pasted as it is: an empty cell there is empty.
      store.undo();
      clip('copy');
      clip('paste', '\r\nDétails\r\n');
      eq(store.value('tab|f1|t2|Label', FR), '', 'blank from another source');
    }),
  );

  // ---- the async Clipboard API fallback answers late ----
  const views = () =>
    ['a', 'b'].map((id) => t.slot('view', `view|${id}|Name`, { [EN]: `Name ${id}`, [FR]: `Nom ${id}` }));

  test(
    'grid clipboard fallback: a cut answered after the cursor moved copies the cells it started on and clears none',
    withRows(views(), async ({ store, toasts, key }) => {
      const c = fakeClipboard();
      try {
        key('x', { ctrl: true });
        await wait(100); // no cut event came: the Clipboard API takes over
        eq(c.written, ['Nom a']);
        key('ArrowDown');
        c.answer();
        await wait(0);
        eq([store.value('view|a|Name', FR), store.value('view|b|Name', FR), store.pendingCount()], ['Nom a', 'Nom b', 0], 'neither row is cleared');
        ok(/^Copied, but nothing was cleared/.test(toasts[0]), toasts[0]);
        // Answered while the selection is unchanged: the cut cell is cleared.
        key('x', { ctrl: true });
        await wait(100);
        c.answer();
        await wait(0);
        eq([c.written[1], store.value('view|a|Name', FR), store.value('view|b|Name', FR)], ['Nom b', 'Nom a', '']);
      } finally {
        c.restore();
      }
    }),
  );

  test(
    'grid clipboard fallback: a paste answered after the cursor moved, the languages changed or the rows were sorted otherwise pastes nothing',
    withRows(views(), async ({ store, grid, toasts, key, langs }) => {
      const c = fakeClipboard();
      try {
        c.text = 'Collé';
        const late = async (between: () => void) => {
          key('v', { ctrl: true });
          await wait(100);
          between();
          c.answer();
          await wait(0);
        };
        await late(() => key('ArrowDown'));
        eq(store.pendingCount(), 0, 'cursor moved');
        ok(/^Nothing was pasted: the selection changed/.test(toasts[0]), toasts[0]);
        key('ArrowUp');
        // German shown in place of French (the language menu) while the browser reads the clipboard.
        await late(() => langs([EN, DE], DE));
        eq(store.pendingCount(), 0, 'French text never lands in German');
        langs([EN, FR], FR);
        // The rows came back in another order (a reload, a filter): the cell under the cursor is another label.
        const [a, b] = ['view|a|Name', 'view|b|Name'].map((k) => store.get(k)!);
        await late(() => grid.setRows([b, a]));
        eq(store.pendingCount(), 0, 'rows sorted otherwise');
        eq(toasts.length, 3);
        // The same rows again (a background load) and nothing moved: the paste lands where it was asked for.
        grid.setRows([a, b]);
        await late(() => grid.setRows([a, b]));
        eq([store.value('view|a|Name', FR), store.value('view|b|Name', FR)], ['Collé', 'Nom b']);
      } finally {
        c.restore();
      }
    }),
  );

  test(
    'grid clipboard fallback: rows sorted otherwise before the browser is asked to copy copy nothing; a paste answered while a cell editor is open pastes nothing',
    withRows(views(), async ({ store, grid, toasts, key }) => {
      const c = fakeClipboard();
      try {
        const [a, b] = ['view|a|Name', 'view|b|Name'].map((k) => store.get(k)!);
        // Ctrl+C, then a background load sorts the rows otherwise before the fallback runs: other labels' text is never copied.
        key('c', { ctrl: true });
        grid.setRows([b, a]);
        await wait(100);
        eq(c.written, [], 'nothing copied');
        ok(/^Nothing was copied: the rows changed/.test(toasts[0]), toasts[0]);
        key('x', { ctrl: true });
        grid.setRows([a, b]);
        await wait(100);
        eq([c.written, store.pendingCount()], [[], 0], 'nor cut');
        ok(/^Nothing was cut: the rows changed/.test(toasts[1]), toasts[1]);
        // Ctrl+V, then F2 opens the cell's editor before the browser answers: the paste never writes under it.
        c.text = 'Collé';
        key('v', { ctrl: true });
        await wait(100);
        key('F2');
        c.answer();
        await wait(0);
        eq(store.pendingCount(), 0, 'nothing staged');
        ok(/^Nothing was pasted: the selection changed/.test(toasts[2]), toasts[2]);
      } finally {
        c.restore();
      }
    }),
  );

  // ---- a metadata description emptied is saved empty (core/model.ts savesEmpty) ----
  /** Two columns' tooltips (metadata descriptions), translated in French. */
  const tips = () =>
    ['a', 'b'].map((x) => ({ ...t.slot('attribute', `attribute|acc.${x}|Description`, { [EN]: `Type ${x}.`, [FR]: `Tapez ${x}.` }), prop: 'Description', baseRequired: false }) as unknown as Slot);

  test(
    'grid Delete on several French tooltips: each is saved empty, which the toast says (their users see none there); one alone speaks for itself (its cell shows “(empty)”)',
    withRows(tips(), ({ store, toasts, key }) => {
      key('ArrowDown', { shift: true });
      key('Delete');
      eq([store.value('attribute|acc.a|Description', FR), store.value('attribute|acc.b|Description', FR)], ['', '']);
      eq(toasts, ['Cleared 2 cells. 2 emptied descriptions will be saved empty when you save: users of those languages see none there.']);
      eq(['a', 'b'].map((x) => store.emptyOnPurpose(`attribute|acc.${x}|Description`, FR, EN)), [true, true], 'done, not missing');
      store.undo();
      key('Escape');
      key('Delete');
      eq([store.pendingCount(), toasts.length], [1, 1], 'nothing more to say');
    }),
  );
}
