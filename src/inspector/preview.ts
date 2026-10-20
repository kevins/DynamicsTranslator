// Shows the page with the user's pending edits in their own language, by swapping the text of
// anchored labels in place. Only the nodeValue of existing text nodes that show the label changes; the
// originals are kept so everything can be put back, and a node Dynamics re-rendered since is left alone.

import type { Lcid } from '../core/model';
import type { Store } from '../core/store';
import type { AppApi } from '../ui/types';
import { fallbackOf } from './fallback';
import { norm, type Anchor } from './scan';

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
    if (!this.orig.size && !hasEdits(store, L)) return; // nothing to show or to undo
    if (this.orig.size > 400) for (const t of this.orig.keys()) if (!t.isConnected) this.forget(t);
    this.quiet(() => {
      for (const a of anchors) {
        const s = store.get(a.key);
        // A part of a text that shows several labels (multi-select values, a linked header): the text is left as it is.
        if (!s || !a.el.isConnected || a.part) continue;
        // Dynamics shows the user's language, or the base language when that label is missing. A form field label
        // missing in a language shows the column's name in it first, else the column's base-language name
        // (LIVE-FINDINGS 42), a related menu item its relationship's text (LIVE-FINDINGS 80). An emptied translation
        // Dataverse can't remove shows what saving writes in its place (model.ts standIn, as the popup says).
        const fb = fallbackOf((k) => store.get(k), s);
        const ck = fb?.key || '';
        const col = (l: Lcid) => (ck && !store.value(a.key, l).trim() ? store.value(ck, l) : '');
        const colBase = fb?.kind === 'attribute' && !store.value(a.key, L).trim() ? store.value(ck, ctx.base) : '';
        const shown = new Set(
          [s.labels[ctx.user], ck && !s.labels[ctx.user] ? store.original(ck, ctx.user) || (fb?.kind === 'attribute' ? store.original(ck, ctx.base) : '') : '', s.labels[ctx.base]]
            .map((x) => norm(x || ''))
            .filter(Boolean),
        );
        const stand = L === ctx.base ? undefined : store.standIn(a.key, L, ctx.base);
        const want = (store.value(a.key, L) || stand?.text || col(L) || colBase || store.value(a.key, ctx.base)).trim();
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
