// What a form label shows in a language it has no text of its own in (owner: describe-status): a form cell shows
// its column's name (LIVE-FINDINGS 42), a related menu item of the form XML its relationship's text (LIVE-FINDINGS
// 80). Lookups by slot key only, and no import but column.ts, so the editor card (ui/editor.ts), which status.ts
// imports, and the Workbench can use it without an import cycle.

import type { Slot } from '../core/model';
import { columnOf } from './column';

type Get = (key: string) => Slot | undefined;

const low = (v: unknown): string => String(v || '').toLowerCase();

/**
 * The relationship a related menu item of the form XML lists (`RelationshipName`, its schema name); '' for any
 * other slot and for Microsoft's built-in items a form renames (`hardcoded_{<fixed guid>}nav<Name>`, LIVE-FINDINGS
 * 63), which show language-pack text where they have no title.
 */
export function menuRelationship(s: Slot): string {
  const r = String((s.kind === 'navitem' && s.ref?.relationship) || '');
  return /^hardcoded_/i.test(r) ? '' : r;
}

/**
 * The text a related menu item of the form XML shows in a language its titles lack (LIVE-FINDINGS 80): its
 * relationship's menu label (`AssociatedMenuConfiguration.Behavior` UseLabel), else the plural name of the table
 * it lists (UseCollectionName). The side of an N:N relationship is the one whose menu shows on this table's form
 * (scan.ts relatedMenu, LIVE-FINDINGS 63). Undefined for a menu that isn't shown, a built-in item, and while the
 * relationship or the table isn't loaded (pageload.ts related()).
 */
export function navSource(get: Get, s: Slot): Slot | undefined {
  const n = navMenu(get, s);
  if (!n) return undefined;
  const menu = n.rel.ref?.menu;
  return menu === 'label' ? n.rel : menu === 'plural' && n.listed ? get(`entity|${n.listed}|DisplayCollectionName`) : undefined;
}

/** The relationship menu a related menu item of the form XML shows, and the table it lists (navSource). */
function navMenu(get: Get, s: Slot): { rel: Slot; listed: string } | undefined {
  const name = s.prop === 'Label' ? menuRelationship(s) : '';
  if (!name) return undefined;
  const e = low(s.entity);
  const rel = get(`relationship|${name}|Label`);
  // 1:N: its menu shows on the referenced table's form and lists the referencing table.
  if (rel) return low(rel.ref?.referenced) === e ? { rel, listed: low(rel.ref?.referencing) } : undefined;
  // N:N: Entity1's menu shows on Entity2's form, listing Entity1 records, and the other way round. A relationship
  // of a table to itself has two items, crossed: `nav_<schema>1` shows Entity2's menu, `nav_<schema>2` Entity1's.
  const sides = [get(`relationship|${name}|1|Label`), get(`relationship|${name}|2|Label`)];
  const any = sides[0] || sides[1];
  if (!any) return undefined;
  const [e1, e2] = [low(any.ref?.entity1), low(any.ref?.entity2)];
  const id = low(s.ref?.elId);
  const nav = low(`nav_${name}`);
  const side = e1 === e2 ? (id === nav + '1' ? 2 : id === nav + '2' ? 1 : 0) : e === e2 ? 1 : e === e1 ? 2 : 0;
  const r = side ? sides[side - 1] : undefined;
  return r && { rel: r, listed: side === 1 ? e1 : e2 };
}

/**
 * The table whose plural name a related menu item of the form XML shows where it has no title (UseCollectionName),
 * once its relationship is loaded; '' otherwise. What to read for it besides its table's relationships.
 */
export function navListed(get: Get, s: Slot): string {
  const n = navMenu(get, s);
  return n?.rel.ref?.menu === 'plural' ? n.listed : '';
}

/**
 * Whether what a label shows where it has no text of its own can be told: always, except for a related menu item of
 * the form XML whose relationship (and, for UseCollectionName, the listed table's plural name) isn't loaded yet.
 */
export function navKnown(get: Get, s: Slot): boolean {
  const name = s.prop === 'Label' ? menuRelationship(s) : '';
  if (!name) return true;
  if (!get(`relationship|${name}|Label`) && !get(`relationship|${name}|1|Label`) && !get(`relationship|${name}|2|Label`)) return false;
  const t = navListed(get, s);
  return !t || !!get(`entity|${t}|DisplayCollectionName`);
}

/**
 * The slot whose text a label shows where it has none of its own: a form cell's column name, a related menu item's
 * relationship text (navSource); undefined for anything else, or while that slot isn't loaded.
 */
export function fallbackOf(get: Get, s: Slot): Slot | undefined {
  if (s.prop !== 'Label') return undefined;
  if (s.kind === 'field') {
    const c = columnOf(s);
    return c ? get(`attribute|${c.entity}.${c.attr}|DisplayName`) : undefined;
  }
  return navSource(get, s);
}
