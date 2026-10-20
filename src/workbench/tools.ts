// Bulk tools. Each works on the rows the active sheet shows × one language (find/replace and trim may also
// take every shown language), previews what will change, and applies it as one undo step.

import { lcidName } from '../core/lcid';
import { PROP_NAMES, standIn, standInsSaid, type Lcid, type Slot, type StandInFrom, type TextOf } from '../core/model';
import { debounce, h, plural, put, type IconName } from '../ui/dom';
import { notLoaded } from '../ui/editor';
import type { AppApi } from '../ui/types';
import { active } from '../ui/widgets';
import { blankEdit, clearing, missing, type Blank } from './grid';
import { canSearchAside, heavyRegex, searcher } from './regex';

export type ToolId = 'base' | 'find' | 'trim';
export const TOOLS: Array<[ToolId, IconName, string, string]> = [
  ['base', 'copy', 'Copy base language into empty cells', 'For names that stay the same in every language'],
  ['find', 'search', 'Find and replace', 'Match case, whole word or regular expression'],
  ['trim', 'edit', 'Trim spaces', 'Remove leading, trailing and repeated spaces'],
];

type Edit = [Slot, Lcid, string];

/**
 * How long (ms) Find and replace may plan on the page before it stops, which nothing can interrupt: plain text, and
 * regular expressions where no worker can search in the background (regex.ts).
 */
export const FIND_BUDGET = 400;

/**
 * How long (ms) a search in the background may take before the dialog says "Searching…": a quicker answer replaces the
 * preview at once, without "Searching…" and a greyed Change flashing (and a screen reader saying it) after each pause
 * in typing.
 */
export const SEARCHING_AFTER = 200;

/**
 * Why a regular expression could freeze the page, or '': JavaScript tries every way a repeat can split a text before it
 * gives up on a label, and nothing can stop one search once it started (^(a+)+$ on a label of 30 letters takes
 * minutes). Refused: a group repeated more than once (anything but ? or {0,1}) that
 * - holds a repeat or an optional part of its own, at any depth: (a+)+, (\w*\s)*, (ab?)+, (x{1,3}){2};
 * - holds a choice inside it, or is a choice whose alternatives don't each start with their own plain (or escaped)
 *   character: (a|ab)+, (\w|_)*, (Mr|Mrs)+, (x(a|b))+. (foo|bar)+ and ( |\t)+ are fine.
 * Fixed counts (a{2}, (ab){3}) and everything outside a repeated group keep working. `src` is a pattern RegExp accepts;
 * `i`: case doesn't matter; `u`: the u flag is on (\u{…} and \p{…} are one character).
 */
export function riskyRegex(src: string, i = false, u = false): string {
  interface Group {
    /** Holds a repeat or an optional part (a quantifier whose count can vary), at any depth. */
    varies: boolean;
    /** Holds a choice (|) in a group inside it. */
    choice: boolean;
    /** Where each alternative starts. */
    alts: number[];
  }
  const NESTED =
    'This regular expression repeats a group that holds a repeat or an optional part of its own, like (a+)+ or (ab?)+, which can freeze the page on some labels. Write it without repeating the group, for example a+ instead of (a+)+.';
  const CHOICE =
    'This regular expression repeats a choice whose alternatives can match the same text, like (a|ab)+, which can freeze the page on some labels. Start each alternative with a different character, or repeat a character class such as [ab]+ instead.';
  const CTRL: Record<string, string> = { t: '\t', n: '\n', r: '\r', f: '\f', v: '\v' };
  /** The first character of an alternative when it is a plain or escaped one that is always there; else ''. */
  const head = (a: string): string => {
    const m = /^(?:\\([^\w\s]|[tnrfv])|([^\\[\](){}|.^$*+?]))(?![*?]|\{0)/.exec(a);
    const c = !m ? '' : m[2] ?? CTRL[m[1]] ?? m[1];
    return i ? c.toLowerCase() : c;
  };
  const stack: Group[] = [{ varies: false, choice: false, alts: [0] }];
  /** What a quantifier applies to: a group just closed (and where it closed), another atom, or nothing. */
  let last: { g: Group; end: number } | 'atom' | null = null;
  for (let p = 0; p < src.length; ) {
    const c = src[p];
    const top = stack[stack.length - 1];
    if (c === '\\') {
      // With the u flag, \p{L}, \u{1F600} and \k<name> are one atom; without it, \u{2} repeats a u.
      const m = (u ? /^\\(?:[pPu]\{[^}]*\}|k<[^>]*>|.)/s : /^\\./s).exec(src.slice(p));
      p += m ? m[0].length : 2;
      last = 'atom';
    } else if (c === '[') {
      // A class ends at the first ] not escaped, also right after [ ([] matches nothing in JavaScript).
      let q = p + 1;
      if (src[q] === '^') q++;
      while (q < src.length && src[q] !== ']') q += src[q] === '\\' ? 2 : 1;
      p = q + 1;
      last = 'atom';
    } else if (c === '(') {
      // The group's kind (?: ?= ?! ?<= ?<! ?<name> ?i:) is not part of its first alternative.
      p += /^\((?:\?(?:[:=!]|<[=!]|<[^>]*>|[a-zA-Z-]*:))?/.exec(src.slice(p))![0].length;
      stack.push({ varies: false, choice: false, alts: [p] });
      last = null;
    } else if (c === ')') {
      const g = stack.length > 1 ? stack.pop()! : top;
      const up = stack[stack.length - 1];
      up.varies ||= g.varies;
      up.choice ||= g.choice || g.alts.length > 1;
      last = { g, end: p++ };
    } else if (c === '|') {
      top.alts.push(++p);
      last = null;
    } else if (c === '*' || c === '+' || c === '?' || c === '{') {
      const m = c === '{' ? /^\{(\d+)(,(\d*))?\}/.exec(src.slice(p)) : null;
      if (c === '{' && !m) {
        // Not a count: a brace as a character (accepted without the u flag).
        p++;
        last = 'atom';
        continue;
      }
      const min = m ? Number(m[1]) : c === '+' ? 1 : 0;
      const max = m ? (!m[2] ? min : m[3] ? Number(m[3]) : Infinity) : c === '?' ? 1 : Infinity;
      p += m ? m[0].length : 1;
      if (src[p] === '?') p++; // lazy
      if (max > 1 && last && last !== 'atom') {
        const g = last.g;
        if (g.varies) return NESTED;
        if (g.choice) return CHOICE;
        if (g.alts.length > 1) {
          // Each alternative as written.
          const ends = [...g.alts.slice(1).map((x) => x - 1), last.end];
          const firsts = g.alts.map((x, k) => head(src.slice(x, ends[k])));
          if (firsts.some((f) => !f) || new Set(firsts).size < firsts.length) return CHOICE;
        }
      }
      if (min < max) top.varies = true;
      last = 'atom';
    } else {
      p++;
      last = 'atom';
    }
  }
  return '';
}

export function openTool(app: AppApi, id: ToolId, rows: Slot[], langs: Lcid[], target: Lcid): void {
  const { store, ctx } = app,
    base = ctx.base,
    free = id === 'find' || id === 'trim', // these may edit the base language too
    opts = free ? [0, ...langs] : langs.filter((l) => l !== base);
  if (!opts.length) return app.toast('Show a language other than the base language first: choose it in the language menu in the title bar, or under Languages in Export options.', 'info');
  let lang = target !== base && opts.includes(target) ? target : opts[0],
    edits: Edit[] = [],
    extra = '',
    close: (() => void) | null = null;

  const fi = h('input', { type: 'text', placeholder: 'Find', 'aria-label': 'Find', 'data-af': true });
  const ri = h('input', { type: 'text', placeholder: 'Replace with', 'aria-label': 'Replace with' });
  const flag = (t: string) => {
    const c = h('input', { type: 'checkbox', on: { change: () => update() } });
    return [c, h('label', { class: 'chk' }, c, t)] as const;
  };
  const [mc, mcL] = flag('Match case'),
    [ww, wwL] = flag('Whole word'),
    [rx, rxL] = flag('Regular expression');
  const sel = h(
    'select',
    { class: 'sel', 'aria-label': 'Language', on: { change: () => ((lang = Number(sel.value)), update()) } },
    opts.map((l) => h('option', { value: String(l), selected: l === lang }, l ? lcidName(l) : 'All shown languages')),
  );
  const info = h('p', { class: 'wb-ti', role: 'status' });
  const list = h('div', { class: 'wb-pl' });
  const goBtn = h('button', { class: 'btn primary', on: { click: () => go() } });

  /**
   * The texts as the planned edits leave them (model.ts TextOf): a stand-in made of a text this tool changes too (the
   * base text, a column's name) is that new text, as the save will measure it.
   */
  let text: TextOf = (k, l) => store.text(k, l);
  /**
   * What saving an edit does when it leaves a translation blank (find and replace with nothing, trim):
   * 'remove' removes it, 'standin' saves its stand-in where Dataverse can't remove it, 'blocked' is refused. The
   * grid's rule (blankEdit), so the preview counts exactly the cells the grid will mark.
   */
  const emptied = (s: Slot, l: Lcid, v: string): Blank => blankEdit(s, l, base, store.original(s.key, l), v, text);

  /** Searches for regular expressions in the background (regex.ts); stopped when the dialog closes. */
  const aside = id === 'find' ? searcher() : null;
  /** Counts the plans: an answer from the background for one a newer plan replaced, or after closing, is dropped. */
  let gen = 0,
    closed = false;

  /**
   * Computes `edits` (and `extra` notes), then calls `done` with an error when the options are not usable, or ''.
   * A regular expression searches in the background where the page allows a worker (regex.ts): `done` comes when it
   * answers, and never for a plan a newer one replaced. Everything else plans on the page, and `done` comes at once.
   */
  const plan = (done: (bad: string) => void): void => {
    const g = ++gen;
    edits = [];
    extra = '';
    let re: RegExp | null = null;
    const bg = aside !== null && rx.checked && canSearchAside();
    if (id === 'find') {
      if (!fi.value) return done('Type the text to find.');
      try {
        const src = rx.checked ? fi.value : fi.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Valid on its own, not only inside Whole word's group: in a)(?:a*a*$ the ")" closes that group, and the checks
        // below would read only the "a" of what runs.
        if (ww.checked) new RegExp(src, 'u');
        // \b only knows ASCII letters; look-arounds on \p{L} make "whole word" work for "é", "ß", "ö"...
        re = new RegExp(ww.checked ? `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])` : src, 'g' + (mc.checked ? '' : 'i') + (ww.checked ? 'u' : ''));
      } catch {
        return done('That regular expression is not valid.');
      }
      // One that could search a single label for minutes is refused before it runs (riskyRegex); so is, where it
      // would search on the page, one that could keep the page busy for long (heavyRegex).
      const risk = rx.checked ? riskyRegex(fi.value, !mc.checked, ww.checked) || (bg ? '' : heavyRegex(fi.value, !mc.checked, ww.checked)) : '';
      if (risk) return done(risk);
    }
    const cells: Array<[Slot, Lcid]> = [];
    for (const s of rows)
      if (!s.readOnly)
        for (const l of lang ? [lang] : langs)
          // A language not loaded has unknown text (the grid shows "Not loaded"): never edited in bulk.
          if (!notLoaded(s, l) || store.isEdited(s.key, l)) cells.push([s, l]);
    const keep = (s: Slot, l: Lcid, v: string, n: string | undefined) => {
      if (n !== undefined && n !== v && !(l === base && s.baseRequired && !n.trim())) edits.push([s, l, n]);
    };
    const rep = ri.value;
    if (re && bg) {
      const texts = cells.map(([s, l]) => store.value(s.key, l));
      const job = aside.run(re, rep, texts);
      // No worker can start on this page: planned again, on the page (heavyRegex first).
      if (!job) return plan(done);
      void job.then((f) => {
        if (g !== gen || closed) return;
        // The worker failed to load (the page's policy blocks it as it loads): the same.
        if (f === 'unavailable') return plan(done);
        if (f === 'slow')
          return done('This search took too long, so it was stopped and nothing will change. Write the regular expression more simply, with fewer repeats in a row that can match the same text (such as .*.*).');
        if (typeof f === 'string') return done('This search could not run, so nothing will change. Write the regular expression more simply.');
        f.changed.forEach((n, k) => keep(cells[k][0], cells[k][1], texts[k], n));
        notes();
        done('');
      });
      return;
    }
    const t0 = performance.now();
    let seen = 0;
    for (const [s, l] of cells) {
      const v = store.value(s.key, l);
      let n: string | undefined;
      if (re) n = rx.checked ? v.replace(re, rep) : v.replace(re, () => rep);
      // Only plain spaces and tabs collapse: no-break spaces are intentional (French "Nom :").
      else if (id === 'trim') n = v.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
      else if (missing(store, s, l, base)) n = store.value(s.key, base);
      // The search runs on the page between labels: one that keeps it this long would freeze it on the rest.
      if (re && (++seen, performance.now() - t0 > FIND_BUDGET)) {
        edits = [];
        return done(
          `This search took too long, so it stopped after ${plural(seen, 'label')} and nothing will change. ${
            rx.checked ? 'Write the regular expression more simply, with fewer repeats in a row that can match the same text (such as .*.*).' : 'Filter the rows first, then search again.'
          }`,
        );
      }
      keep(s, l, v, n);
    }
    notes();
    done('');
  };
  /** The notes under the plan (`extra`), and the texts as its edits leave them (`text`). */
  const notes = () => {
    const next = new Map(edits.map(([s, l, v]) => [`${s.key}#${l}`, v] as const));
    text = (k, l) => next.get(`${k}#${l}`) ?? store.text(k, l);
    let rm = 0,
      bare = 0, // removals whose base-language text is empty too: those users then see no text
      em = 0, // descriptions saved empty
      nc = 0,
      sp = 0;
    /** Emptied translations Dataverse can't remove, saved as their stand-in. */
    const sis: Array<{ s: Slot; l: Lcid; from: StandInFrom }> = [];
    for (const [s, l, v] of edits) {
      const e = emptied(s, l, v);
      if (e === 'remove') {
        rm++;
        if (!(text(s.key, base) ?? '').trim()) bare++;
      } else if (e === 'standin') {
        const x = standIn(s, l, base, store.original(s.key, l), v, text);
        if (x?.text) sis.push({ s, l, from: x.from });
      } else if (e === 'empty') em++;
      else if (e === 'blocked') store.original(s.key, l) ? nc++ : sp++;
    }
    if (rm)
      extra += ` ${plural(rm, 'translation')} will be removed when you save (users of that language then see the ${lcidName(base)} text${bare ? `, or no text where it is empty too` : ''}).`;
    // A metadata description emptied is saved empty (model.ts savesEmpty): its users see none.
    if (em) extra += ` ${plural(em, 'description')} will be saved empty when you save: users of ${em === 1 ? 'that language' : 'those languages'} see none there.`;
    // In the popup's words: why they can't be removed, and what they get (model.ts standInsSaid).
    const si = sis.length && standInsSaid(sis, base);
    if (si) {
      const one = sis.length === 1;
      extra += ` ${plural(sis.length, 'translation')} would become empty, but ${si.why}: ${one ? 'it gets' : 'they get'} ${si.what} in ${one ? 'its' : 'their'} place when you save.`;
    }
    if (nc)
      extra += ` ${plural(nc, 'translation')} would become empty, but Dataverse can't remove ${nc === 1 ? 'it' : 'them'} and there is no text to put in ${nc === 1 ? 'its' : 'their'} place: ${nc === 1 ? 'it is' : 'they are'} marked in red until you type a text.`;
    // Only spaces where there is no translation: Dataverse would store them and show a blank label.
    if (sp) extra += ` ${plural(sp, 'cell')} would hold only spaces, which Dataverse would show as a blank label: ${sp === 1 ? 'it is' : 'they are'} marked in red until you type a text.`;
  };
  /** The new value in the preview list; an emptied translation says what saving will do with it. */
  const after = (s: Slot, l: Lcid, v: string) => {
    const e = emptied(s, l, v);
    if (e === 'remove') return h('ins', null, '(translation removed)');
    if (e === 'empty') return h('ins', null, '(saved empty)');
    if (e === 'standin') {
      const x = standIn(s, l, base, store.original(s.key, l), v, text);
      return h('ins', null, x?.same ? `(already “${x.text.trim()}”: nothing changes)` : `(becomes “${x?.text.trim() ?? ''}”)`);
    }
    if (e === 'blocked')
      return h('ins', { class: 'bad' }, store.original(s.key, l) ? "(empty — Dataverse can't remove this translation, and nothing can stand in for it)" : '(only spaces — Dataverse would show a blank label)');
    return h('ins', null, v || '(empty)');
  };
  /** The plan the preview shows: what Change applies. */
  let shown: Edit[] = [];
  /** Find or Replace with changed since the last plan (typing is debounced): Change plans first. */
  let dirty = false;
  /** A search runs in the background; `next` runs once its preview shows (Change clicked meanwhile); typing or a changed option drops it. */
  let busy = false,
    next: (() => void) | null = null,
    slow: ReturnType<typeof setTimeout> | undefined;

  /**
   * Plans and shows the preview; `then` runs once it shows (Change), unless a newer plan replaced it first. A search in
   * the background leaves the preview as it is until it answers; past SEARCHING_AFTER the dialog says "Searching…"
   * instead, and Change waits for the new preview.
   */
  const update = (then?: () => void) => {
    let now = false;
    dirty = false;
    later.cancel();
    clearTimeout(slow);
    next = then ?? null;
    plan((bad) => {
      now = true;
      busy = false;
      clearTimeout(slow);
      shown = edits;
      const n = edits.length;
      info.textContent = bad || (n ? `${plural(n, 'cell')} will change.` : 'Nothing to change.') + extra;
      info.classList.toggle('bad', !!bad);
      put(
        list,
        edits.slice(0, 20).map(([s, l, v]) =>
          h('div', null, h('small', null, `${s.title} · ${PROP_NAMES[s.prop]} · ${lcidName(l)}`), h('del', null, store.value(s.key, l) || '(empty)'), ' → ', after(s, l, v)),
        ),
        n > 20 && h('small', { class: 'wb-more' }, `…and ${(n - 20).toLocaleString()} more`),
      );
      list.hidden = !n;
      list.removeAttribute('aria-busy');
      // A focused button that becomes disabled drops the focus out of the dialog, past its Tab trap: the field takes it.
      if (!n && active(goBtn) === goBtn) (id === 'find' ? fi : sel).focus();
      goBtn.disabled = !n;
      goBtn.removeAttribute('aria-disabled');
      goBtn.textContent = `Change ${plural(n, 'cell')}`;
      const t = next;
      next = null;
      t?.();
    });
    if (now) return;
    busy = true;
    list.setAttribute('aria-busy', 'true');
    slow = setTimeout(() => {
      // The preview shown is of the search before: it goes, and nothing can change until the new one shows. Change
      // keeps the focus (aria-disabled, not disabled).
      info.textContent = 'Searching…';
      info.classList.remove('bad');
      list.hidden = true;
      goBtn.textContent = 'Change';
      goBtn.setAttribute('aria-disabled', 'true');
    }, SEARCHING_AFTER);
  };

  const apply = (es: Edit[]) => {
    let n = 0,
      nc = 0,
      sp = 0,
      more = '';
    store.group(() => {
      for (const [s, l, v] of es)
        if (store.value(s.key, l) !== v) {
          store.set(s.key, l, v);
          n++;
          if (clearing(store, s, l, base) === 'blocked') store.original(s.key, l) ? nc++ : sp++;
        }
    });
    close?.();
    if (nc) more += ` Dataverse can't remove ${plural(nc, 'translation')} that became empty and there is no text to put in ${nc === 1 ? 'its' : 'their'} place (marked in red in the grid) — type the text instead, or undo.`;
    if (sp) more += ` ${plural(sp, 'cell')} now ${sp === 1 ? 'holds' : 'hold'} only spaces, which Dataverse would show as a blank label (marked in red in the grid) — type the text instead, or undo.`;
    app.toast(`${n ? plural(n, 'cell') + ' changed.' : 'No cells changed.'}${more}`, nc || sp ? 'warn' : n ? 'ok' : 'info', n ? { label: 'Undo', run: () => store.undo() } : undefined);
  };
  /**
   * Applies the plan the preview shows, at once when nothing changed since: never searched again. Text typed a moment
   * ago has no preview yet (it is debounced): it is planned now, and when that changes any cell or new text, the
   * preview shows the new plan and the next click applies it. A search in the background is compared once it
   * answered, unless the user typed meanwhile (the click is dropped); while the dialog says "Searching…" there is no
   * preview, and Change does nothing.
   */
  const go = () => {
    if (goBtn.getAttribute('aria-disabled') === 'true') return;
    const was = shown;
    const then = () => {
      if (edits.length === was.length && edits.every(([s, l, v], i) => s === was[i][0] && l === was[i][1] && v === was[i][2])) apply(edits);
    };
    if (dirty) update(then);
    else if (busy) next = then;
    else apply(was);
  };

  const body = document.createDocumentFragment();
  body.append(
    h(
      'div',
      { class: 'dlg-body wb-tool' },
      h('p', { class: 'quiet' }, `Works on the ${plural(rows.length, 'row')} shown on this sheet. Read-only rows are skipped.`),
      h('label', { class: 'wb-fld' }, 'Language', sel),
      id === 'find' && [h('div', { class: 'input' }, fi), h('div', { class: 'input' }, ri), h('div', { class: 'wb-flags' }, mcL, wwL, rxL)],
      info,
      list,
    ),
    h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', on: { click: () => close?.() } }, 'Cancel'), goBtn),
  );
  const later = debounce(() => update(), 150);
  // Typing after a click on Change while a search runs drops that click, as a changed option does (update): the dialog
  // stays open, and Change previews the new text first, as after any typing.
  const typed = () => ((dirty = true), (next = null), later());
  fi.addEventListener('input', typed);
  ri.addEventListener('input', typed);
  void app
    .modal(TOOLS.find((t) => t[0] === id)![2], (c) => ((close = () => c()), body), { wide: id === 'find' })
    .finally(() => {
      // Closed: a search still running in the background stops, and no plan runs any more.
      closed = true;
      later.cancel();
      clearTimeout(slow);
      aside?.close();
    });
  update();
}
