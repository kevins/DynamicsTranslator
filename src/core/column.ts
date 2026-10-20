// The column a form cell shows. Pure, on the slot alone, so the save rules of core (model.ts standIn: an emptied
// field label Dataverse can't remove is written as its column's name) use it without importing the inspector;
// inspector/column.ts re-exports it for the page's and the editor card's code.

import type { Slot } from './model';

/**
 * Whether a form cell shows a column (its control is the column's own: `<column>`, a copy `<column><n>`, or
 * `header_` / `footer_` + those). A quick view control is bound to its lookup column too (datafieldname =
 * the lookup) under a name of its own: it shows a quick view form, not that column's label or tooltip.
 */
function columnCell(r: any): boolean {
  const df = String(r.datafield || '').toLowerCase();
  const id = String(r.controlId || '')
    .toLowerCase()
    .replace(/^(header_|footer_)/, '');
  return !!df && (!id || id === df || (id.startsWith(df) && /^\d+$/.test(id.slice(df.length))));
}

/**
 * The column whose tooltip (Description) and name (DisplayName) belong with a label: the datafield of a form
 * cell, the field of a business process step. Null for sub-grids, quick views, web resources and other cells
 * that don't show a column.
 */
export function columnOf(s: Slot): { entity: string; attr: string } | null {
  const r = s.ref || {};
  const attr = s.kind === 'field' || s.kind === 'dfield' ? (columnCell(r) ? r.datafield : '') : s.kind === 'step' ? r.attribute : '';
  return attr && s.entity ? { entity: s.entity, attr: String(attr).toLowerCase() } : null;
}
