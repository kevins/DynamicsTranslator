// "Select labels to export": the texts a selection of labels brings (what each one's popup shows: a field's Form label,
// Column name, Tooltip and choice values, a tab's or a button's label…) and the dialog that downloads them as the
// Workbench does (Excel → Download), Easy Translator compatible, so the file can be edited and imported back there.
// Selection mode itself (a click selects, a box dragged over the page selects what it covers) is inspector/mode.ts's
// and the overlay's.

import type { Lcid, Slot } from '../core/model';
import type { Store } from '../core/store';
import { h, plural } from '../ui/dom';
import { langName } from '../ui/editor';
import type { AppApi } from '../ui/types';
import { errMsg } from '../ui/widgets';
import { describe } from './describe';
import type { Anchor, CalloutModel, Selected } from './types';

/** What a text of a selected label is, for the dialog's Include boxes. */
export type Part = 'label' | 'name' | 'tip' | 'choice' | 'other';

/** The Include boxes, in this order (only those the selection has show). */
export const PARTS: ReadonlyArray<readonly [Part, string]> = [
  ['label', 'Form labels'],
  ['name', 'Column names'],
  ['tip', 'Tooltips'],
  ['choice', 'Choice values'],
  ['other', 'Other labels'],
];

/**
 * The labels selected, by component (a label shown twice, or a field's label and its value, is selected once), in the
 * order selected: each with the slot of the text clicked and the page it was on.
 */
export class Chosen {
  private m = new Map<string, Selected>();
  get size(): number {
    return this.m.size;
  }
  has(comp: string): boolean {
    return this.m.has(comp);
  }
  /** Selects the label, or unselects it (a click): true when it is selected now. */
  toggle(a: Pick<Anchor, 'comp' | 'key'>, page: string): boolean {
    if (this.m.delete(a.comp)) return false;
    this.m.set(a.comp, { comp: a.comp, key: a.key, page });
    return true;
  }
  /** Selects each label not selected yet (a box let go, Select all), never unselecting one: how many were added. */
  add(as: Iterable<Pick<Anchor, 'comp' | 'key'>>, page: string): number {
    let n = 0;
    for (const a of as)
      if (!this.m.has(a.comp)) {
        this.m.set(a.comp, { comp: a.comp, key: a.key, page });
        n++;
      }
    return n;
  }
  clear(): void {
    this.m.clear();
  }
  list(): Selected[] {
    return [...this.m.values()];
  }
}

/** A popup block's text by its heading (describe.ts): a field's three, everything else (Label, Name, Description…) is "other". */
export const partOf = (heading: string): Part => (heading === 'Form label' ? 'label' : heading === 'Column name' ? 'name' : heading === 'Tooltip' ? 'tip' : 'other');

/**
 * The texts a selection brings, slot key -> part, each once: what each label's popup shows (its blocks, its column's
 * choice values), read now, so texts loaded since it was selected count. The text clicked counts where the popup lists it
 * under no block of its own (describe adds one for it only from the label itself). Only slots in the store.
 */
export function selectedTexts(app: AppApi, sel: readonly Selected[], model: (app: AppApi, comp: string) => CalloutModel = describe): Map<string, Part> {
  const out = new Map<string, Part>();
  const add = (k: string, p: Part) => {
    if (!out.has(k) && app.store.get(k)) out.set(k, p);
  };
  for (const s of sel) {
    let m: CalloutModel;
    try {
      m = model(app, s.comp);
    } catch (e) {
      if (__DEV__) console.error('[translator] selection', e);
      continue;
    }
    for (const b of m.blocks) add(b.key, partOf(b.heading));
    for (const k of m.choices?.keys ?? []) add(k, 'choice');
    add(s.key, 'other');
  }
  return out;
}

/** The bar's text while selecting. */
export const selectingText = (n: number): string => `Click or drag over the labels you want · ${n.toLocaleString()} selected`;

/** The dialog's line under its title: how many labels, on how many pages. */
export function selectionLine(sel: readonly Selected[]): string {
  const pages = new Set(sel.map((s) => s.page)).size;
  return `${plural(sel.length, 'label')} on ${plural(Math.max(1, pages), 'page')}`;
}

/** The slots as a download carries them: with their pending edits (Workbench › Excel does the same). */
export const withEdits = (store: Store, list: Slot[]): Slot[] =>
  list.map((s) => {
    const e = store.edits.get(s.key);
    return e ? { ...s, labels: { ...s.labels, ...Object.fromEntries(e) } } : s;
  });

/** The texts to download: the parts kept, in the store's order of keys as selected. */
export function chosenSlots(store: Store, texts: ReadonlyMap<string, Part>, keep: ReadonlySet<Part>): Slot[] {
  const out: Slot[] = [];
  for (const [k, p] of texts) {
    const s = keep.has(p) ? store.get(k) : undefined;
    if (s) out.push(s);
  }
  return out;
}

/**
 * "Download…" while selecting: the Include boxes (only the parts the selection has), the languages (all checked), then the
 * Workbench's two downloads. A download closes the dialog and calls `done` (selection mode ends, the selection is kept).
 */
export function openDownload(app: AppApi, sel: readonly Selected[], done: () => void): void {
  const texts = selectedTexts(app, sel);
  if (!sel.length || !texts.size) return app.toast('Nothing to download yet. Select labels first.', 'info');
  const have = new Set(texts.values());
  const parts = PARTS.filter(([p]) => have.has(p));
  const langs = app.ctx.langs.map((l) => l.lcid);
  const box = (text: string): [HTMLInputElement, HTMLElement] => {
    const c = h('input', { type: 'checkbox', checked: true });
    return [c, h('label', { class: 'chk' }, c, text)];
  };
  void app.modal('Download selected labels', (close) => {
    const inc = parts.map(([p, name]) => [p, ...box(name)] as const);
    const lng = langs.map((l) => [l, ...box(langName(app, l))] as const);
    const err = h('p', { class: 'note bad', role: 'alert', hidden: true });
    const say = (t: string) => {
      err.textContent = t;
      err.hidden = !t;
    };
    let busy = false;
    const go = async (k: 'book' | 'csv') => {
      if (busy) return;
      const keep = new Set(inc.filter(([, c]) => c.checked).map(([p]) => p));
      const ls: Lcid[] = lng.filter(([, c]) => c.checked).map(([l]) => l);
      if (!keep.size) return say('Choose at least one kind of label.');
      if (!ls.length) return say('Choose at least one language.');
      const slots = chosenSlots(app.store, texts, keep);
      const name = `Translations ${app.ctx.org} ${new Date().toISOString().slice(0, 10)}.${k === 'csv' ? 'csv' : 'xlsx'}`;
      busy = true;
      say('');
      try {
        const list = withEdits(app.store, slots);
        const blob = k === 'csv' ? app.io.exportCsv(list, ls) : await app.io.exportWorkbook(list, ls, name);
        save(app, blob, name);
        const pending = slots.some((s) => app.store.edits.has(s.key));
        close();
        done();
        app.toast(`Downloaded ${name}: ${plural(slots.length, 'row')} in ${plural(ls.length, 'language')}.${pending ? ' Pending changes are in the file; they are not saved yet.' : ''}`, 'ok');
      } catch (e) {
        say(`The download failed: ${errMsg(e)}`);
      } finally {
        busy = false;
      }
    };
    const fr = document.createDocumentFragment();
    fr.append(
      h(
        'div',
        { class: 'dlg-body' },
        h('p', { class: 'quiet' }, selectionLine(sel)),
        h('p', { class: 'sx-h' }, 'Include'),
        h('div', { class: 'sx-g' }, inc.map(([, , l]) => l)),
        h('p', { class: 'sx-h' }, 'Languages'),
        h('div', { class: 'sx-g' }, lng.map(([, , l]) => l)),
        err,
        h('p', { class: 'quiet' }, 'Easy Translator compatible: edit it, then import it in the Workbench (Excel → Import workbook or CSV…).'),
      ),
      h(
        'div',
        { class: 'dlg-actions' },
        h('button', { class: 'btn primary', type: 'button', 'data-af': true, on: { click: () => void go('book') } }, 'Download workbook (.xlsx)'),
        h('button', { class: 'btn', type: 'button', on: { click: () => void go('csv') } }, 'Download CSV (.csv)'),
        h('button', { class: 'btn', type: 'button', on: { click: () => close() } }, 'Cancel'),
      ),
    );
    return fr;
  });
}

/** Hands the file to the browser (a download link clicked in the app's layer, as the Workbench's). */
function save(app: AppApi, b: Blob, name: string): void {
  const u = URL.createObjectURL(b);
  const a = h('a', { href: u, download: name, hidden: true });
  app.layer.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}
