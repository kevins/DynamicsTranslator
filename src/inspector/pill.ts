// "N choices changed": a choice edited in a popup turns its own mark green only where the page shows that very
// choice (a value, an open dropdown list), so a field showing another value, or none, said nothing about it. The
// overlay draws a pill after such a field (overlay.ts), and the popup's "Choices (N)" header says how many are
// pending (ui/callout.ts). Counting and wording are pure; fieldsAround reads the page, never changes it.

import type { Kind, Lcid, Slot } from '../core/model';
import type { Store } from '../core/store';
import { columnOf } from './column';
import type { Anchor, Pill } from './types';

/** Choice kinds a field's value shows (a global choice's options are 'globaloption'). */
const VALUES = new Set<Kind>(['option', 'status', 'state', 'boolean', 'globaloption']);
/** Labels of a form field that shows a column: a form cell (main form, header, quick view) and a process step. */
const FIELDS = new Set<Kind>(['field', 'step']);
/** A choice's texts: its label, and its description (the Workbench edits that one). */
const TEXTS = ['Label', 'Description'];
/** A form field's container: the cell of a form, the header strip's item. */
const FIELD_BOX = '[data-id$="-FieldSectionItemContainer"],uci-header-control-list-item';
/** Grids: their cells show each value's own mark (an open dropdown list's choices are 'option' anchors). */
const GRIDS = '[role="grid"],[role="treegrid"],[role="row"],[role="gridcell"],[role="columnheader"]';

/** Choices of a column with a change that isn't published: how many, how many failed to publish, the first (option order). */
export interface ChoiceNote {
  n: number;
  failed: number;
  first: string;
}

/**
 * A choice's state, in the priority of the page's marks (status.ts look): 'error' (the last publish attempt
 * failed for one of its texts), 'edited' (staged), '' (neither).
 */
export function choiceState(store: Store, langs: readonly Lcid[], comp: string): 'error' | 'edited' | '' {
  let edited = false;
  for (const p of TEXTS) {
    const k = `${comp}|${p}`;
    if (!store.get(k)) continue;
    if (store.status.size)
      for (const l of langs) {
        const o = store.cellStatus(k, l)?.outcome;
        if (o === 'error' || o === 'conflict') return 'error';
      }
    if (store.isEdited(k)) edited = true;
  }
  return edited ? 'edited' : '';
}

/** The pending choices among these option label keys (in option order); null when none is. */
export function choiceNote(store: Store, langs: readonly Lcid[], keys: readonly string[]): ChoiceNote | null {
  let n = 0;
  let failed = 0;
  let first = '';
  for (const k of keys) {
    const c = store.get(k)?.comp;
    const st = c ? choiceState(store, langs, c) : '';
    if (!st) continue;
    n++;
    if (st === 'error') failed++;
    first ||= k;
  }
  return n ? { n, failed, first } : null;
}

const choices = (n: number): string => `${n} ${n === 1 ? 'choice' : 'choices'}`;

/** The pill: "1 choice changed", "3 choices changed"; "3 choices not published" when one of them failed to publish. */
export const pillText = (c: ChoiceNote): string => `${choices(c.n)} ${c.failed ? 'not published' : 'changed'}`;

/** The pill's tooltip. */
export const pillTitle = (c: ChoiceNote): string =>
  c.failed === c.n
    ? `${choices(c.n)} of this field couldn't be published`
    : `${choices(c.n)} of this field changed, not published yet${c.failed ? `; ${c.failed} couldn't be published` : ''}`;

/** The popup's note after "Choices (N)": "1 changed", "2 not published". */
export const choicesNote = (c: ChoiceNote): string => `${c.n} ${c.failed ? 'not published' : 'changed'}`;

/** A column's choices as its popup lists them: its own options, else the global choice's (describe.ts choicesOf). */
export function choiceSet(list: readonly Slot[]): Slot[] {
  const own = list.filter((s) => s.kind !== 'globaloption');
  return own.length ? own : [...list];
}

/**
 * The column ('entity.attr', lower case) a form field label or a choice value shows: the cell's or the step's, the
 * option's (a global choice: the first column using it, whose choices are the same set); '' when none.
 */
export function choiceColumn(s: Slot | undefined): string {
  if (!s) return '';
  const c = columnOf(s);
  if (c) return `${c.entity}.${c.attr}`.toLowerCase();
  const r = s.ref || {};
  if (s.kind === 'globaloption') return String((Array.isArray(r.usedBy) && r.usedBy[0]) || '').toLowerCase();
  return VALUES.has(s.kind) && r.entity && r.attribute ? `${r.entity}.${r.attribute}`.toLowerCase() : '';
}

/**
 * The form field containers around a value, innermost first (across the header strip's shadow root); none for a
 * grid cell (a list's, or a sub-grid's on the form).
 */
export function fieldsAround(a: Anchor): Element[] {
  const out: Element[] = [];
  for (let n: Element | null = a.zone ?? a.el; n; n = n.parentElement ?? ((n.parentNode as ShadowRoot | null)?.host || null)) {
    if (n.matches(FIELD_BOX)) out.push(n);
    else if (!out.length && n.matches(GRIDS)) return [];
  }
  return out;
}

export interface PillHooks {
  /** The column a field label or a choice value shows (choiceColumn); '' when none. */
  column(a: Anchor): string;
  /** That column's pending choices, counted once per store change. */
  note(col: string): ChoiceNote | null;
  /** fieldsAround. */
  fields(a: Anchor): Element[];
  /** The field label can't be translated. */
  readOnly(a: Anchor): boolean;
}

/**
 * One pill per form field (a field placed twice: one per copy) whose column has pending choices: after its
 * values (the last one first), else after its label. A field is its label's container (`hit`); a value belongs to
 * the innermost field around it that shows a column (a quick view's title is no such field), or makes one of its
 * own (a field whose label is hidden on the form). Grid cells, column headers and dropdown lists get none.
 */
export function fieldPills(anchors: readonly Anchor[], o: PillHooks): Pill[] {
  const groups = new Map<Element, { label: Anchor | null; col: string; values: Anchor[] }>();
  for (const a of anchors)
    if (a.role === 'label' && FIELDS.has(a.kind) && a.hit && !groups.has(a.hit)) groups.set(a.hit, { label: a, col: o.column(a), values: [] });
  for (const a of anchors) {
    if (a.role !== 'value' || !VALUES.has(a.kind)) continue;
    const fs = o.fields(a);
    const f = fs.find((e) => groups.get(e)?.col) ?? fs[0];
    if (!f) continue;
    const g = groups.get(f);
    if (g) g.values.push(a);
    else groups.set(f, { label: null, col: '', values: [a] });
  }
  const out: Pill[] = [];
  for (const [field, { label, col, values }] of groups) {
    if (label && o.readOnly(label)) continue;
    const c = col || (values.length ? o.column(values[0]) : '');
    const n = c ? o.note(c) : null;
    if (!n) continue;
    out.push({ at: [...values].reverse().concat(label ? [label] : []), field, text: pillText(n), n: n.n, title: pillTitle(n), tone: n.failed ? 'error' : 'edited' });
  }
  return out;
}
