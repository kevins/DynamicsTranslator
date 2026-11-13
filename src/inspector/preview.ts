// Shows the page with the user's pending edits in their own language, by swapping the text of
// anchored labels in place. Only the nodeValue of existing text nodes that show the label changes; the
// originals are kept so everything can be put back, and a node Dynamics re-rendered since is left alone.

import { columnKey, type Lcid } from '../core/model';
import type { Store } from '../core/store';
import type { AppApi } from '../ui/types';
import { fallbackOf } from './fallback';
import { norm, type Anchor } from './scan';

/** The kinds of a form's own labels, whose node may show their published text while another is loaded (Anchor.orig). */
const FORM_OWN = /^(field|tab|section)$/;

const hasEdits = (store: Store, lcid: Lcid): boolean => {
  for (const e of store.edits.values()) if (e.has(lcid)) return true;
  return false;
};

export class Preview {
  private orig = new Map<Text, string>();
  private mine = new Map<Text, string>();

  constructor(
    private readonly app: AppApi,
    /** Runs a page change without it coming back as a mutation (Overlay.quiet). */
    private readonly quiet: (fn: () => void) => void,
  ) {}

  /** Text a node had before preview swapped it. */
  textOf = (t: Text): string => (this.mine.get(t) === t.nodeValue && this.orig.get(t)) || t.nodeValue || '';

  /** (Re)applies the preview to these anchors. */
  apply(anchors: Iterable<Anchor>): void {
    const { store, ctx } = this.app;
    const L = ctx.user;
    // Nothing to show or to undo: no edit in the user's language, nor in the base language, whose text shows where theirs is missing.
    if (!this.orig.size && !hasEdits(store, L) && !hasEdits(store, ctx.base)) return;
    if (this.orig.size > 400) for (const t of this.orig.keys()) if (!t.isConnected) this.forget(t);
    this.quiet(() => {
      for (const a of anchors) {
        const s = store.get(a.key);
        // A part of a text that shows several labels (multi-select values, a linked header): the text is left as it is.
        if (!s || !a.el.isConnected || a.part) continue;
        // Dynamics shows the user's language, or the base language when that label is missing. A form field label
        // missing in a language shows the column's name in it first, else the column's base-language name
        // (LIVE-FINDINGS 42), a related menu item its relationship's text (LIVE-FINDINGS 80). An emptied translation
        // Dataverse can't remove shows what saving writes in its place (model.ts standIn, as the popup says). One that
        // follows its column (Store.follows) shows that name as staged while nothing is typed in it.
        const own = !store.isEdited(a.key, L) && store.follows(a.key, L, ctx.base) ? '' : store.value(a.key, L);
        const fb = fallbackOf((k) => store.get(k), s);
        const ck = fb?.key || '';
        const col = ck && !own.trim() ? store.value(ck, L) : '';
        const colBase = fb?.kind === 'attribute' && !own.trim() ? store.value(ck, ctx.base) : '';
        // The texts the label's own nodes may show: as loaded, its column's name where it has none, the base text, and, for a
        // form's own label (a field's, a tab's, a section's), the one its text showed when it was found (Anchor.orig),
        // which the page may show though another is loaded (a form label saved and not published yet shows its published
        // text). Any other label's found text may be none of its own (a related menu item's language-pack or relationship
        // text): never swapped.
        const shown = new Set(
          [s.labels[ctx.user], ck && !s.labels[ctx.user] ? store.original(ck, ctx.user) || (fb?.kind === 'attribute' ? store.original(ck, ctx.base) : '') : '', s.labels[ctx.base], FORM_OWN.test(s.kind) ? a.orig : '']
            .map((x) => norm(x || ''))
            .filter(Boolean),
        );
        const stand = L === ctx.base ? undefined : store.standIn(a.key, L, ctx.base);
        // Only a staged edit of the text it shows changes it (its own, else what shows in its place): else it shows as the
        // page has it, as the page may show another text than the one loaded (a form label saved and not published yet
        // shows its published one).
        // An edit counts only where it is in the text that shows (want's first that isn't empty): a base-language one only
        // where nothing in the user's language shows, as its column's name there shows before any base text.
        const byBase = !col.trim() && ((fb?.kind === 'attribute' && store.isEdited(ck, ctx.base)) || (!colBase.trim() && store.isEdited(a.key, ctx.base)));
        const edited = store.isEdited(a.key, L) || (!own.trim() && ((!!ck && store.isEdited(ck, L)) || byBase));
        // The first of these texts that isn't blank: spaces alone are no text (saved, they are a blank: the server then
        // holds ''), and the popup trims them as it closes. A label's own text, a column's name it shows, alike.
        const want = edited ? ([own, stand?.text, col, colBase, store.value(a.key, ctx.base)].map((x) => (x ?? '').trim()).find(Boolean) ?? '') : '';
        const w = document.createTreeWalker(a.el, NodeFilter.SHOW_TEXT);
        for (let t: Text | null; (t = w.nextNode() as Text | null); ) {
          const o = this.textOf(t);
          if (!shown.has(norm(o))) continue;
          const v = !want || want === o.trim() ? o : o.replace(o.trim(), () => want); // keep surrounding spaces
          if (t.nodeValue !== v) t.nodeValue = v;
          if (v === o) this.forget(t);
          else {
            this.orig.set(t, o);
            this.mine.set(t, v);
          }
        }
      }
    });
  }

  /**
   * The form field labels among `anchors` of the column whose name is `key` (model.ts columnKey): those with no text of
   * their own (missing, emptied, or following it) show that name as staged (apply), so they change with it as it is typed.
   */
  showing(key: string, anchors: readonly Anchor[]): Anchor[] {
    const { store } = this.app;
    if (store.get(key)?.kind !== 'attribute') return [];
    return anchors.filter((a) => {
      const s = store.get(a.key);
      return !!s && columnKey(s) === key;
    });
  }

  /** Puts every swapped text back. */
  restore(): void {
    if (!this.orig.size) return;
    this.quiet(() => {
      for (const [t, o] of this.orig) if (t.nodeValue === this.mine.get(t)) t.nodeValue = o;
    });
    this.orig.clear();
    this.mine.clear();
  }

  private forget(t: Text): void {
    this.orig.delete(t);
    this.mine.delete(t);
  }
}
