// The component editor card, used by both views and by the app's editor sheet: every translatable
// property of one component with one input per shown language, status, revert and conflict
// resolution. Values live in the Store; the card refreshes cells on store events and never rebuilds an
// input while the user types in it.

import { isAbort } from '../core/http';
import { isRtl, lcidShort, lcidTag } from '../core/lcid';
import { keepsEmpty, KIND_NAMES, noneText, noStandIn, notLoaded, PROP_NAMES, savedEmptyText, standInSays, type Lcid, type Prop, type Slot, type StandIn } from '../core/model';
import type { Store } from '../core/store';
import { shownLanguage } from '../core/uilang';
import { fallbackOf } from '../inspector/fallback';
import type { FormRef } from '../providers/types';
import { h, icon, put, type IconName } from './dom';
import type { AppApi, Issue } from './types';
import { whenEmpty } from './undo';
import { active, btn, emptyState, errMsg, ibtn, kindIcon, link, menu, note, tooltip } from './widgets';

export interface Editor {
  el: HTMLElement;
  /**
   * Focuses the input of a language, the caret at the end of its text (default: the language the page is shown in,
   * else the first editable input).
   */
  focus(lcid?: Lcid): void;
  destroy(): void;
}

const PROPS = Object.keys(PROP_NAMES) as Prop[];
const LONG = new Set<Prop>(['Description', 'ToolTipDescription', 'Hint']);
const FS = typeof CSS !== 'undefined' && !!CSS.supports?.('field-sizing', 'content');
const TIPS: Record<string, string> = { edit: 'Edited, not saved yet', saved: 'Saved', miss: 'Missing in this language', conflict: 'Changed on the server since you loaded it' };

/** Inline note when an existing translation was emptied and saving will remove it. */
export const WILL_REMOVE = 'Will be removed when you save.';

/**
 * Inline note when an existing translation was emptied where Dataverse can't remove it (canClear false), so saving
 * writes its stand-in (model.ts standIn): "Becomes “Project site”: Dataverse can't remove a translation here, so
 * French gets the English text."; where that is its text already, "Already the English text: …, so nothing changes."
 * (model.ts standInSays). The popup's and the editor card's words.
 */
export const becomesText = (s: Slot, l: Lcid, base: Lcid, x: Pick<StandIn, 'text' | 'from' | 'same'>): string => standInSays(s, l, base, x);

/**
 * True when a change empties a translation that exists on the server: saving it removes that language
 * (users then see the base text) where Dataverse allows it, see canClear() in core/model.ts. A stored label
 * of only spaces counts too (it shows blank and is removed the same way), the same rule as the saver's
 * check() in core/saver.ts, so the editor, grid, inspector and review all agree with what the save does.
 */
export const isRemoval = (base: Lcid, lcid: Lcid, before: string, after: string): boolean => lcid !== base && !after.trim() && before !== '';

/** Message tone under an input: class and icon, so the tone never relies on color alone. */
const LOOK: Record<'error' | 'warn' | 'note', [string, IconName]> = { error: ['e', 'error'], warn: ['w', 'warn'], note: ['n', 'info'] };
let ids = 0;

const index = new WeakMap<Store, { dirty: boolean; m: Map<string, Slot[]> }>();
/** The slots of one component in property order (indexed once, rebuilt after the store's slot set changes). */
export function compSlots(store: Store, comp: string): Slot[] {
  let x = index.get(store);
  if (!x) {
    const y = { dirty: true, m: new Map<string, Slot[]>() };
    store.on((e) => {
      if (e.type === 'slots') y.dirty = true;
    });
    index.set(store, (x = y));
  }
  if (x.dirty) {
    x.m.clear();
    for (const s of store.slots.values()) {
      const a = x.m.get(s.comp);
      if (a) a.push(s);
      else x.m.set(s.comp, [s]);
    }
    for (const a of x.m.values()) if (a.length > 1) a.sort((p, q) => PROPS.indexOf(p.prop) - PROPS.indexOf(q.prop));
    x.dirty = false;
  }
  return x.m.get(comp) || [];
}

/** Languages to show: the base language first, then shown languages (and the target) in the org's order. */
export function shownLangs(app: AppApi): Lcid[] {
  const { base, langs } = app.ctx;
  const p = app.prefs;
  return langs.map((l) => l.lcid).filter((l) => l === base || l === p.target || p.shown.includes(l));
}

export const langName = (app: AppApi, l: Lcid): string => app.ctx.langs.find((x) => x.lcid === l)?.name || lcidShort(l);

/** Language chip: short code (the full name shows in wide containers and in the tooltip); base dark, target brand. */
export function langChip(app: AppApi, l: Lcid): HTMLElement {
  const base = l === app.ctx.base;
  const n = langName(app, l);
  const c = h('span', { class: 'lc' + (base ? ' b' : l === app.prefs.target ? ' t' : '') }, h('b', null, lcidShort(l)), h('span', { class: 'nm' }, n), base ? h('small', null, 'base') : null);
  tooltip(c, base ? `${n} (base language)` : n);
  return c;
}

/**
 * True when this language's label was not read (form tab/section labels loaded without a language
 * switch carry `ref.partial`; their missing languages are unknown rather than empty). In core/model.ts, where the
 * save rules read it too.
 */
export { notLoaded };

const grow = (t: HTMLInputElement | HTMLTextAreaElement) => {
  if (FS || !(t instanceof HTMLTextAreaElement) || !t.isConnected) return;
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight + 2, 220) + 'px';
};

export function createEditor(app: AppApi, comp: string, o: { focusLcid?: Lcid; onClose?: () => void } = {}): Editor {
  const { store, ctx } = app;
  const base = ctx.base;
  // data-us: an input a re-render replaces keeps its undo history (ui/undo.ts, by its data-k).
  const el = h('section', { class: 'ed', 'data-us': true });
  // One polite live region per card (re-attached by render) for the announcements of row().
  const live = h('span', { class: 'vh', 'aria-live': 'polite' });
  const ac = new AbortController();
  let cells = new Map<string, Array<() => void>>();
  let cur: Slot[] = [];

  const watch = (key: string, fn: () => void) => {
    const a = cells.get(key);
    if (a) a.push(fn);
    else cells.set(key, [fn]);
    fn();
  };
  const refreshAll = () => {
    for (const a of cells.values()) for (const f of a) f();
  };

  /** A blocking problem only (blank base label, too long, read-only), as the popup: no warnings (ARCHITECTURE §5.4). */
  const issueFor = (s: Slot, l: Lcid, v: string): Issue | undefined => {
    try {
      return app.saver.validate([{ slot: s, lcid: l, before: s.labels[l] ?? '', after: v }]).find((i) => i.level === 'error');
    } catch {
      return undefined;
    }
  };

  /**
   * Reads the other languages of a form whose tab/section labels are known in the user's language only (a
   * language read failed). The language switch needs no consent: the labels are simply read again.
   */
  async function loadLangs(s: Slot): Promise<void> {
    const r = s.ref || {};
    const name = store.get(`form|${r.formId}|Name`)?.title || store.get(`dashboard|${r.formId}|Name`)?.title || String(s.path[1] || '').replace(/ \([^()]*\)$/, '');
    const form: FormRef = { formId: r.formId, entity: s.entity || 'none', name, type: Number(r.formType) || 0 };
    app.status('Loading form labels in every language…');
    try {
      // Read as of now: a text the store gets while it reads (a save, another load) is newer and stays.
      const since = store.tick();
      const slots = await app.providers.loadFormXml(ctx, [form], ctx.langs.map((x) => x.lcid), { signal: ac.signal, lang: app.lang, progress: (m) => app.status(m) });
      store.add(slots, since);
    } catch (e) {
      if (!isAbort(e)) app.toast(`Couldn't load the other languages: ${errMsg(e)}`, 'error');
    } finally {
      app.status('');
    }
  }

  function row(s: Slot, l: Lcid): HTMLElement {
    const isBase = l === base;
    const long = LONG.has(s.prop);
    const inp = h(long ? 'textarea' : 'input', {
      class: 'ti',
      rows: long ? 1 : null,
      'data-k': `${s.key}#${l}`,
      dir: isRtl(l) ? 'rtl' : null,
      lang: lcidTag(l) || null,
      spellcheck: true,
      'aria-label': `${PROP_NAMES[s.prop]}, ${langName(app, l)}`,
    }) as HTMLInputElement | HTMLTextAreaElement;
    if (s.max) inp.maxLength = s.max;
    // A staged text with nothing typed in it yet: Ctrl+Z goes back to the server text, Ctrl+Y brings the edit back.
    whenEmpty(inp, (u) => (u === 'undo' && store.isEdited(s.key, l) ? store.original(s.key, l) : undefined));
    inp.addEventListener('input', () => {
      store.set(s.key, l, inp.value);
      grow(inp);
    });

    let tip = '';
    const id = `dxt-e${++ids}`;
    const st = h('span', { class: 'st', id: id + 's' });
    tooltip(st, () => tip);
    // The message under the input describes it (aria-describedby); removal hints and errors are also
    // announced as they appear (see `live`). The character counter is not part of the description.
    const msg = h('span', { class: 'emm', id: id + 'm' });
    const cnt = h('small', { class: 'cnt', hidden: true });
    const em = h('div', { class: 'em' }, msg, cnt);
    inp.setAttribute('aria-describedby', id + 'm');
    let said = '';
    const cf = h('div', { class: 'cf', hidden: true });
    // Revert hides itself; the focus moves to the input so the keyboard stays in the card.
    const rev = ibtn('undo', 'Revert', () => {
      store.revert(s.key, l);
      if (!inp.disabled) inp.focus();
    }, 'subtle sm');
    const r = h('div', { class: 'er' + (isBase ? ' base' : '') + (l === app.prefs.target && !isBase ? ' tgt' : '') },
      langChip(app, l),
      h('div', { class: 'ef' }, inp, cf, em),
      h('div', { class: 'ea' }, st, rev),
    );

    // An empty input says what users of that language see now, in the popup's words (ui/callout.ts
    // placeholderOf): a form field label shows the column's name in that language, else its base-language name
    // (LIVE-FINDINGS 42; the stand-in's rule, model.ts standIn), a related menu item its relationship's text
    // (LIVE-FINDINGS 80), anything else the base text; a long text "No French description" (a metadata description:
    // only where its users see none). A relationship's text can load later: it is looked up again on each update. Where
    // saving writes a stand-in, the line under the input says what it becomes instead (and where it saves a description
    // empty, that it does).
    const fallback = () => (isBase ? undefined : fallbackOf((k) => store.get(k), s));
    const colKey = fallback()?.key || '';
    const showsNow = (bv: string): string => {
      // A metadata description (model.ts keepsEmpty): "No French tooltip" only where its users see none (stored or saved
      // empty, Store.emptyOnPurpose, or no base text either); a missing one shows them the base text, as the popup says.
      if (keepsEmpty(s)) return !store.emptyOnPurpose(s.key, l, base) && bv.trim() ? `Shows “${bv.trim()}”` : noneText(s, langName(app, l));
      if (LONG.has(s.prop)) return `No ${langName(app, l)} ${PROP_NAMES[s.prop].toLowerCase()}`;
      const col = fallback();
      const own = col && !notLoaded(col, l) ? store.value(col.key, l).trim() : '';
      const colBase = col?.kind === 'attribute' && !notLoaded(col, base) ? store.value(col.key, base).trim() : '';
      const v = own || colBase || bv.trim();
      return v ? `Shows “${v}”` : '';
    };
    const updateCell = (): void => {
      const nl = notLoaded(s, l);
      const ro = !!s.readOnly;
      const v = store.value(s.key, l);
      const bv = store.value(s.key, base);
      const edited = store.isEdited(s.key, l);
      const cs = store.cellStatus(s.key, l);
      if (inp.value !== v) {
        inp.value = v;
        grow(inp);
      }
      inp.disabled = ro || nl;
      // Emptying a translation that exists on the server asks to remove it; where Dataverse can't, saving writes its
      // stand-in (model.ts standIn), and only one without a stand-in is refused. A metadata description's is saved empty
      // (model.ts savesEmpty), also only spaces where there is none: said in the stand-in's place.
      const empty = edited && !ro && !nl && !isBase && store.emptyOnPurpose(s.key, l, base) ? savedEmptyText(s, langName(app, l)) : '';
      const removing = edited && !ro && !nl && isRemoval(base, l, store.original(s.key, l), v);
      const x = removing && !empty ? store.standIn(s.key, l, base) : undefined;
      const stuck = !!x && !x.text;
      const stand = empty || (x?.text ? becomesText(s, l, base, x) : '');
      inp.placeholder = nl
        ? 'Not loaded'
        : ro
          ? ''
          : isBase
            ? s.baseRequired ? 'Required' : ''
            : stuck
              ? "Can't be removed — type the text instead"
              : stand && !empty
                ? ''
                : showsNow(bv);
      inp.classList.toggle('same', !isBase && !!v && v === bv);
      // "Missing" means it needs translating: empty here while the base language has text, but for a description
      // stored empty on purpose (model.ts storedEmpty), which is translated.
      const miss = !ro && !nl && !v.trim() && (isBase ? s.baseRequired : !!bv.trim() && !store.emptyOnPurpose(s.key, l, base));
      // What to tell the user about this cell, most important first. A removal replaces the saver's
      // generic "clears the text" warning with what will actually happen.
      const issue = edited && !removing ? issueFor(s, l, v) : undefined;
      const say: { level: 'error' | 'warn' | 'note'; text: string } | null =
        cs?.outcome === 'error' && cs.message ? { level: 'error', text: cs.message }
        : stuck ? { level: 'error', text: noStandIn(s, l, x) }
        : stand ? { level: 'note', text: stand }
        : removing ? { level: 'note', text: WILL_REMOVE }
        : issue ? { level: issue.level, text: issue.message }
        : null;
      // A validation error blocks saving: show it in red like a failed save, not only as text.
      const invalid = edited && (stuck || issue?.level === 'error');
      const tone = cs?.outcome === 'error' ? 'err' : cs?.outcome === 'conflict' ? 'conflict' : invalid ? 'err' : edited ? 'edit' : cs?.outcome === 'saved' ? 'saved' : miss ? 'miss' : '';
      tip = tone === 'err' ? say?.text || "Couldn't save" : tone === 'edit' && (removing || empty) ? stand || WILL_REMOVE : TIPS[tone] || '';
      if (invalid) inp.setAttribute('aria-invalid', 'true');
      else inp.removeAttribute('aria-invalid');
      // The dot's meaning is announced too, not only shown by color.
      if (tip) {
        st.setAttribute('role', 'img');
        st.setAttribute('aria-label', tip);
      } else {
        st.removeAttribute('role');
        st.removeAttribute('aria-label');
      }
      if (st.className !== 'st ' + tone) {
        st.className = 'st ' + tone;
        put(st, tone === 'saved' ? icon('check') : tone === 'err' ? icon('error') : tone === 'conflict' ? icon('warn') : '');
      }
      r.dataset.s = tone;
      rev.hidden = !edited;
      cf.hidden = cs?.outcome !== 'conflict';
      if (!cf.hidden)
        put(cf, 'Someone changed this on the server after you loaded it:', h('q', null, cs?.server || '(empty)'),
          h('div', { class: 'acts' }, btn('Keep mine', () => store.resolve(s.key, l, true), 'sm'), btn('Use theirs', () => store.resolve(s.key, l, false), 'sm')));
      const key = nl ? 'nl' : say ? `${say.level}:${say.text}` : '';
      const changed = key !== said;
      said = key;
      // Announce a removal hint or a blocking error once, when it appears for the input being edited.
      // Warnings (e.g. a trailing space at each word typed) are only described, never read out.
      // Screen readers ignore a live region set to the text it already holds (the same hint on the next
      // input), so a repeat gets a trailing no-break space to count as new.
      if (changed && say && say.level !== 'warn' && active(el) === inp) live.textContent = live.textContent === say.text ? say.text + '\u00a0' : say.text;
      if (changed) {
        msg.className = 'emm' + (!nl && say ? ' ' + LOOK[say.level][0] : '');
        put(msg,
          nl
            ? h('span', null, 'Not loaded for this language. ', link('Load all languages', () => void loadLangs(s)))
            : say
              ? [icon(LOOK[say.level][1], 14), h('span', null, say.text)]
              : null,
        );
      }
      const counting = s.max > 0 && v.length >= s.max * 0.8;
      cnt.hidden = !counting;
      if (counting) {
        cnt.textContent = `${v.length} / ${s.max}`;
        cnt.classList.toggle('over', v.length > s.max);
      }
      em.classList.toggle('on', !!key || counting);
    };
    watch(s.key, updateCell);
    if (colKey) {
      // Follows the column's name (or the relationship's text) too, without running now.
      const a = cells.get(colKey);
      if (a) a.push(updateCell);
      else cells.set(colKey, [updateCell]);
    }
    return r;
  }

  function full(slots: Slot[]): void {
    const s0 = slots[0];
    const langs = shownLangs(app);
    const edited = () => slots.some((s) => store.isEdited(s.key));
    /**
     * The Publish dialog for this component's changes. The card is shown in a dialog of its own (app.ts
     * fullEditor), and app.review() opens nothing while a dialog is open: this one closes first.
     */
    const publish = () => {
      o.onClose?.(); // closes at once (widgets.ts modal)
      void app.review((s) => s.comp === comp);
    };
    const more = ibtn('more', 'More actions', () =>
      menu(more, [
        { label: 'Review and publish this component', icon: 'publish', disabled: !edited(), run: publish },
        { label: 'Revert all changes', icon: 'undo', disabled: !edited(), run: () => store.group(() => slots.forEach((s) => store.revert(s.key))) },
      ], { end: true }));
    // Read-only texts say why in one line; nothing else (no managed or global choice notes, ARCHITECTURE §5.4, Popup).
    const notes: Node[] = [...new Set(slots.map((s) => s.readOnly).filter(Boolean))].map((r) => note('lock', r));
    el.setAttribute('aria-label', `Translations of ${s0.title || s0.sub}`);
    put(el,
      h('header', { class: 'ed-h' },
        h('div', { class: 'ki' }, icon(kindIcon(s0.kind), 20)),
        h('div', { class: 'ed-t' },
          h('div', { class: 'ed-k' }, KIND_NAMES[s0.kind]?.[0] || s0.kind),
          h('h2', null, s0.title || s0.sub || 'Untitled'),
          s0.path.length ? h('div', { class: 'crumb' }, s0.path.map((p, i) => (i ? [icon('right', 12), p] : p))) : null,
          app.prefs.showNames && s0.sub ? h('code', { class: 'lnm' }, s0.sub) : null,
        ),
        more,
        o.onClose ? ibtn('close', 'Close', o.onClose) : null,
      ),
      h('div', { class: 'ed-b' },
        notes.length ? h('div', { class: 'ed-n' }, notes) : null,
        slots.map((s) => h('div', { class: 'eb', role: 'group', 'aria-label': PROP_NAMES[s.prop] }, h('div', { class: 'eb-h' }, PROP_NAMES[s.prop]), langs.map((l) => row(s, l)))),
      ),
    );
  }

  function render(): void {
    cur = compSlots(store, comp);
    cells = new Map();
    if (!cur.length) put(el, emptyState('info', 'Not loaded', 'This component is not in the loaded data. Load it again to edit it.'));
    else full(cur);
    el.append(live);
    if (!FS) requestAnimationFrame(() => el.querySelectorAll('textarea').forEach(grow));
  }

  /** Rebuilds after the slots or the language settings changed, keeping the caret where it was. */
  function rerender(): void {
    const a = active(el) as HTMLInputElement | null;
    const k = a && el.contains(a) ? a.dataset.k : undefined;
    const pos = k ? a!.selectionStart : null;
    render();
    const n = k ? [...el.querySelectorAll<HTMLInputElement>('.ti')].find((x) => x.dataset.k === k) : undefined;
    if (n && !n.disabled) {
      n.focus();
      if (pos !== null) n.setSelectionRange(pos, pos);
    }
  }

  const off = store.on((e) => {
    if (e.type === 'edit') cells.get(e.key)?.forEach((f) => f());
    else if (e.type === 'edits' || e.type === 'status') refreshAll();
    else if (e.type === 'slots') {
      const n = compSlots(store, comp);
      if (n.length !== cur.length || n.some((s, i) => s !== cur[i])) rerender();
      else refreshAll();
    }
  });
  const onPrefs = (e: Event) => {
    const d = (e as CustomEvent<Record<string, unknown>>).detail;
    if (!d || 'shown' in d || 'target' in d || 'showNames' in d) rerender();
  };
  app.root.host.addEventListener('dxt-prefs', onPrefs);
  render();

  return {
    el,
    focus(l) {
      // As the popup: the language the page is shown in, the text the user was reading (ui/callout.ts focusInitial).
      const want = '#' + (l ?? o.focusLcid ?? shownLanguage(ctx.langs.map((x) => x.lcid), ctx.user));
      const ins = [...el.querySelectorAll<HTMLInputElement>('.ti')].filter((x) => !x.disabled);
      const t = ins.find((x) => x.dataset.k?.endsWith(want)) || ins[0];
      if (t) {
        t.focus();
        try {
          t.setSelectionRange(t.value.length, t.value.length);
        } catch {
          /* not a text input */
        }
        t.scrollIntoView({ block: 'nearest' });
      }
    },
    destroy() {
      off();
      ac.abort();
      app.root.host.removeEventListener('dxt-prefs', onPrefs);
    },
  };
}
