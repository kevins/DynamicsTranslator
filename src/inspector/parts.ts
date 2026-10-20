// Pure helpers for labels that share one text node or belong to another form or table than the page's (unit tested
// in tools/dev/tests/parts.ts): the values of a multi-select choice ("Rouge, Bleu"), the two names of a linked-table
// column header ("Nom lié (Test lié)"), the tables a grid's query reads, and which form a field container, a quick
// view or a grid belongs to, as the DOM tells (LIVE-FINDINGS 54–58, 88).

import type { Slot } from '../core/model';
import { parseXml } from '../core/xml';
import type { Part } from './types';

const lower = (s: string): string => s.toLocaleLowerCase();
const GUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

/** The part of `raw` from `start` to `end`. */
const part = (raw: string, start: number, end: number): Part => ({ start, end, text: raw.slice(start, end) });

// ---- multi-select values ----

/** A label piece of a multi-select text and the option it names. */
export interface ValuePart {
  part: Part;
  slot: Slot;
}

/** Characters that join multi-select values: "Rouge, Vert" (LIVE-FINDINGS 55) or "Rouge; Vert". */
const SEP = /[,;]/;

/**
 * The option labels a multi-select text shows, one part each, in order (LIVE-FINDINGS 54, 55). Values are joined by
 * ", " or "; ", and a label can hold a comma itself ("Yes, maybe"), so the text is split only where every piece is a
 * label of one of `list`'s options, and only when exactly one such split exists. `pick` names the option a piece shows
 * (optionByText: the user's language first); a piece two options show is left out. Null when the text is no such list
 * (a single value, record data, an ambiguous split).
 */
export function splitValues(raw: string, list: readonly Slot[], pick: (text: string) => Slot | undefined): ValuePart[] | null {
  const texts = [...new Set(list.flatMap((s) => Object.values(s.labels).map((l) => lower(String(l || '').trim()))))].filter(Boolean);
  const L = lower(raw);
  const n = L.length;
  const skip = (i: number): number => {
    while (i < n && /\s/.test(L[i])) i++;
    return i;
  };
  // ways(i): how many splits read the rest from a value starting at i (counted up to 2), and the first one's pieces.
  const memo = new Map<number, { ways: number; pieces: Array<[number, number]> }>();
  const ways = (i: number): { ways: number; pieces: Array<[number, number]> } => {
    const m = memo.get(i);
    if (m) return m;
    let w = 0;
    let pieces: Array<[number, number]> = [];
    for (const t of texts) {
      if (w > 1) break;
      if (!L.startsWith(t, i)) continue;
      const j = i + t.length;
      const k = skip(j);
      if (k === n) {
        if (!w) pieces = [[i, j]];
        w++;
      } else if (SEP.test(L[k])) {
        const next = skip(k + 1);
        if (next >= n) continue;
        const r = ways(next);
        if (r.ways && !w) pieces = [[i, j], ...r.pieces];
        w += r.ways;
      }
    }
    const out = { ways: Math.min(w, 2), pieces };
    memo.set(i, out);
    return out;
  };
  const r = ways(skip(0));
  if (r.ways !== 1 || r.pieces.length < 2) return null;
  const out: ValuePart[] = [];
  for (const [s, e] of r.pieces) {
    const slot = pick(raw.slice(s, e));
    if (slot) out.push({ part: part(raw, s, e), slot });
  }
  return out;
}

/**
 * Where each selected value shows in a multi-select control's text (LIVE-FINDINGS 54): `values` in the order the
 * control lists them (its chips), each with the text its chip shows, found one after the other with nothing but
 * separators between them. Null when the text says anything else.
 */
export function valueParts(raw: string, values: readonly string[]): Part[] | null {
  const out: Part[] = [];
  let at = 0;
  for (const v of values) {
    const t = v.trim();
    if (!t) return null;
    const i = lower(raw).indexOf(lower(t), at);
    const gap = i < 0 ? '' : raw.slice(at, i);
    if (i < 0 || !(out.length ? /^\s*[,;]\s*$/ : /^\s*$/).test(gap)) return null;
    out.push(part(raw, i, i + t.length));
    at = i + t.length;
  }
  return out.length && /^\s*$/.test(raw.slice(at)) ? out : null;
}

// ---- linked-table column headers ----

/**
 * Where a linked-table column header shows its two names (LIVE-FINDINGS 57: "<column> (<lookup>)", one text node):
 * `col`, the related column's name, and `look`, the lookup column's name in the closing brackets. A split whose texts
 * are the known names wins (a name can hold brackets itself); without one, the last "(…)" splits them and only the
 * column's part is given (the lookup's then can't be told). `texts` are normalized (spaces, lower case).
 */
export function linkedHeader(raw: string, colTexts: ReadonlySet<string>, lookTexts: ReadonlySet<string>): { col?: Part; look?: Part } {
  const s0 = raw.length - raw.trimStart().length;
  const body = raw.trim();
  const whole = (): { col?: Part } => (body ? { col: part(raw, s0, s0 + body.length) } : {});
  if (!body.endsWith(')')) return whole();
  const key = (v: string): string => v.replace(/\s+/g, ' ').trim().toLowerCase();
  const at = (p: number) => {
    const c = body.slice(0, p).trimEnd();
    let a = p + 1;
    let b = body.length - 1;
    while (a < b && /\s/.test(body[a])) a++;
    while (b > a && /\s/.test(body[b - 1])) b--;
    return { c, a, b, colOk: colTexts.has(key(c)), lookOk: lookTexts.has(key(body.slice(a, b))) };
  };
  const opens: number[] = [];
  for (let p = body.indexOf('('); p > 0; p = body.indexOf('(', p + 1)) opens.push(p);
  if (!opens.length) return whole();
  const cands = opens.map(at);
  const best = cands.find((x) => x.colOk && x.lookOk) || cands.find((x) => x.colOk) || cands.find((x) => x.lookOk) || cands[cands.length - 1];
  if (!best.c) return {};
  return {
    col: part(raw, s0, s0 + best.c.length),
    ...(best.lookOk && best.b > best.a ? { look: part(raw, s0 + best.a, s0 + best.b) } : {}),
  };
}

/** A related table of a grid's query: `<link-entity alias name to from>`. */
export interface Link {
  /** The related table. */
  entity: string;
  /** The column of `parent` it is joined on (the lookup a header names in brackets). */
  to: string;
  /** The table it is linked from: the grid's table, or the link-entity around it. */
  parent: string;
  /** The columns it reads; null = all-attributes. */
  attrs: Set<string> | null;
}

/** The root `entity` element of a fetch XML query; null when it can't be read. */
function queryRoot(fetchxml: string): Element | null {
  try {
    return Array.from(parseXml(fetchxml, 'view query').documentElement?.children || []).find((c) => c.tagName === 'entity') ?? null;
  } catch {
    return null;
  }
}

/** The linked tables of a fetch XML query by alias (lower case); empty when it can't be read. */
export function queryLinks(fetchxml: string): Map<string, Link> {
  const out = new Map<string, Link>();
  const walk = (el: Element, parent: string): void => {
    for (const c of Array.from(el.children)) {
      if (c.tagName !== 'link-entity') continue;
      const name = lower(c.getAttribute('name') || '');
      const alias = lower(c.getAttribute('alias') || '');
      const to = lower(c.getAttribute('to') || '');
      if (name && alias && !out.has(alias)) {
        const kids = Array.from(c.children);
        const all = kids.some((k) => k.tagName === 'all-attributes');
        out.set(alias, { entity: name, to, parent, attrs: all ? null : new Set(kids.filter((k) => k.tagName === 'attribute').map((k) => lower(k.getAttribute('name') || ''))) });
      }
      if (name) walk(c, name);
    }
  };
  const root = queryRoot(fetchxml);
  if (root) walk(root, lower(root.getAttribute('name') || ''));
  return out;
}

/** The table a fetch XML query reads (its root `entity`, lower case); '' when it can't be read. */
export function queryTable(fetchxml: string): string {
  return lower(queryRoot(fetchxml)?.getAttribute('name') || '');
}

/** The linked column a grid key names ('<alias>.<column>'), when the query links that alias and reads that column. */
export function linkedColumn(key: string | null | undefined, links: ReadonlyMap<string, Link> | null | undefined): (Link & { attr: string }) | null {
  const m = /^([a-z0-9_]+)\.([a-z0-9_]+)$/.exec(lower(String(key || '').trim()));
  const l = m && links?.get(m[1]);
  return l && (!l.attrs || l.attrs.has(m[2])) ? { ...l, attr: m[2] } : null;
}

// ---- which form, which grid (the DOM's own ids) ----

/** The form a field container belongs to: its element id is `id-<form id>-<n>-<control>-…` (LIVE-FINDINGS 56, 58). */
export function formIdOf(elementId: string | null | undefined): string {
  const m = /^id-([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})-\d+-/i.exec(String(elementId || ''));
  return m ? m[1].toLowerCase() : '';
}

/** What a grid root's `data-lp-id` says (lpGrid). */
export interface LpGrid {
  control: string;
  /** The table whose rows it shows: part 4, else part 2. */
  table: string;
  /** Its view ('' when not told). */
  view: string;
  /** Part 2: the table of the page or form the grid is on (a list's main grid: its own table). */
  parent: string;
}

/**
 * A grid root's `data-lp-id` ("Microsoft.PowerApps.PowerAppsOneGrid|<control>|<page or form table>|<view id>|<grid
 * table>|<relationship>", LIVE-FINDINGS 57, 88; the classic read-only grid's "MscrmControls.Grid.GridControl|…" has the
 * same parts, LIVE-FINDINGS 91): its control, tables and view ('' when not told). Null for anything that is not a grid.
 */
export function lpGrid(lp: string | null | undefined): LpGrid | null {
  const seg = String(lp || '').split('|');
  if (seg.length < 3 || !/Grid(Control)?$/i.test(seg[0])) return null;
  const parent = lower(seg[2]);
  if (!/^[a-z0-9_]+$/.test(parent)) return null;
  const view = lower(seg[3] || '').replace(/[{}]/g, '');
  // Part 4 is the grid's own table (an associated grid's related table, LIVE-FINDINGS 88); part 2 the page's or form's.
  const own = lower(seg[4] || '');
  return { control: seg[1], table: /^[a-z0-9_]+$/.test(own) ? own : parent, view: GUID.test(view) ? view : '', parent };
}

/**
 * The table an associated grid shows (a related menu item's view on the record form, LIVE-FINDINGS 88): the related
 * table its data-lp-id names (part 4), taken only when part 2 is the record's table (`entity`) and the grid's own view
 * reads that table (`viewTable`, from the view's query). Null while that query isn't read; '' when they disagree or the
 * grid doesn't say.
 */
export function relatedTable(g: Pick<LpGrid, 'table' | 'parent' | 'view'>, entity: string, viewTable: string | undefined): string | null {
  if (!g.view || !g.table || g.parent !== lower(entity)) return '';
  if (viewTable === undefined) return null;
  return viewTable === g.table ? g.table : '';
}

// ---- built-in commands named after their table ----

const WORD = /[\p{L}\p{N}]/u;

/**
 * Where a built-in command's text shows one of its table's names ("New Person", "Export People": the language pack's
 * words around the table's display or plural name): the longest of `names` found as a whole word, in any case, and its
 * index in `names` (of two as long, the first: a table whose two names read the same). Null when it shows none of them.
 */
export function namePart(raw: string, names: readonly string[]): { part: Part; i: number } | null {
  let best: { part: Part; i: number } | null = null;
  for (let i = 0; i < names.length; i++) {
    const name = lower(names[i].trim());
    if (!name || (best && best.part.text.length >= name.length)) continue;
    for (let s = 0; s + name.length <= raw.length; s++) {
      const e = s + name.length;
      if (lower(raw.slice(s, e)) === name && !WORD.test(raw[s - 1] || '') && !WORD.test(raw[e] || '')) {
        best = { part: part(raw, s, e), i };
        break;
      }
    }
  }
  return best;
}

/** A quick view's `data-lp-id` ("MscrmControls.Containers.QuickForm|<control>|<host table>|<host form id>"). */
export function lpQuickForm(lp: string | null | undefined): { control: string; host: string } | null {
  const seg = String(lp || '').split('|');
  if (seg.length < 4 || seg[0] !== 'MscrmControls.Containers.QuickForm') return null;
  const host = lower(seg[3]).replace(/[{}]/g, '');
  return seg[1] && GUID.test(host) ? { control: seg[1], host } : null;
}
