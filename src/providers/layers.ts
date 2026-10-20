// The solution layers of a table, a column or a global choice, read from the database: Dataverse's virtual table
// msdyn_componentlayers (verified live, 2026-10-16). A metadata read right after a write can go on answering
// the text from before it for many seconds in the user's Edge (LIVE-FINDINGS 66); the layers come from the database
// itself, so they tell a write Dataverse applied (the metadata read lags) from one it did not apply.
//
//   GET msdyn_componentlayers?$filter=(msdyn_componentid eq '<MetadataId>' and msdyn_solutioncomponentname eq '<kind>')
//       &$select=msdyn_solutionname,msdyn_order,msdyn_changes                                               (~0.4 s)
//
// msdyn_changes is JSON {"Attributes":[{"Key":..,"Value":..}]}: "modifiedon" (the layer's time, server UTC without a Z)
// and one "<Prop> - LocalizedLabel" per label, whose Value is a JSON string {"LocalizedLabels":{"1036":{"LocalizedLabel":
// "Nom de l'équipe", ...}}}. The Active (unmanaged) layer of a managed component lists only the languages customized
// there, that of an unmanaged component every language; the managed layers (System, ...) list every language. The
// topmost layer that has a language holds its text: "Active" first, then by msdyn_order, highest first. Relationship
// menu labels and option labels have no such keys (nor layers of their own): they are never checked this way.

import { guid } from '../core/http';
import type { Labels, Prop } from '../core/model';

/** msdyn_solutioncomponentname of the components checked: a table, a column, a choice (global or local set). */
export type LayerKind = 'Entity' | 'Attribute' | 'OptionSet';

/** The key of each label property in a layer's msdyn_changes ("<key> - LocalizedLabel"), per kind. */
const KEYS: Record<LayerKind, Partial<Record<Prop, string>>> = {
  Entity: { DisplayName: 'LocalizedName', DisplayCollectionName: 'LocalizedCollectionName', Description: 'Description' },
  Attribute: { DisplayName: 'DisplayName', Description: 'Description' },
  OptionSet: { DisplayName: 'DisplayName', Description: 'Description' },
};

export interface Layers {
  /** The text per language of each label property a layer holds, from the topmost layer that has that language. */
  props: Partial<Record<Prop, Labels>>;
  /** When the Active layer last changed, as Dataverse gives it (server UTC, no Z); '' without an Active layer. */
  modifiedon: string;
}

/** JSON text parsed, an object as it is; undefined for anything else (or unreadable text). */
function json(v: unknown): any {
  if (typeof v !== 'string') return v && typeof v === 'object' ? v : undefined;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

/**
 * The layers of one component from the rows msdyn_componentlayers answered; null when they hold nothing readable. A label
 * property one of its layers holds in another shape is left out (unknown): a lower layer must never stand in for it.
 */
export function parseLayers(rows: unknown, kind: LayerKind): Layers | null {
  const keys = KEYS[kind];
  if (!Array.isArray(rows) || !keys) return null;
  const layers = rows
    .map((r) => ({ name: String(r?.msdyn_solutionname ?? ''), order: Number(r?.msdyn_order) || 0, attrs: json(r?.msdyn_changes)?.Attributes }))
    .filter((l): l is { name: string; order: number; attrs: any[] } => Array.isArray(l.attrs))
    .sort((a, b) => Number(b.name === 'Active') - Number(a.name === 'Active') || b.order - a.order);
  if (!layers.length) return null;
  const value = (attrs: any[], key: string): unknown => attrs.find((a) => a?.Key === key)?.Value;
  const props: Partial<Record<Prop, Labels>> = {};
  for (const [prop, key] of Object.entries(keys) as Array<[Prop, string]>) {
    const out: Labels = {};
    let held = false;
    let odd = false;
    for (const l of layers) {
      const v = value(l.attrs, `${key} - LocalizedLabel`);
      if (v === undefined || v === null) continue; // this layer holds no text of it
      const all = json(v)?.LocalizedLabels;
      if (!all || typeof all !== 'object' || Array.isArray(all)) {
        odd = true;
        break;
      }
      held = true;
      for (const [lcid, x] of Object.entries(all)) {
        const n = Number(lcid);
        const t = (x as { LocalizedLabel?: unknown } | null)?.LocalizedLabel;
        if (n > 0 && typeof t === 'string' && !(n in out)) out[n] = t;
      }
    }
    if (held && !odd) props[prop] = out;
  }
  const active = layers.find((l) => l.name === 'Active');
  const at = active && value(active.attrs, 'modifiedon');
  return { props, modifiedon: typeof at === 'string' ? at : '' };
}

/** The request that reads the layers of the component `id` (its MetadataId) of `kind`; '' for an id that is no GUID. */
export function layersPath(kind: LayerKind, id: string): string {
  const mid = guid(id);
  if (!/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(mid)) return '';
  return `msdyn_componentlayers?$filter=(msdyn_componentid eq '${mid}' and msdyn_solutioncomponentname eq '${kind}')&$select=msdyn_solutionname,msdyn_order,msdyn_changes`;
}

/**
 * The layers of the component `id` (its MetadataId) of `kind`, or null when Dataverse can't say: no rights to the table,
 * no such table in this version, another shape, a failed or cancelled read. Never an error: the save goes on without them.
 */
export async function readLayers(http: { get(path: string, o?: { signal?: AbortSignal }): Promise<any> }, kind: LayerKind, id: string, signal?: AbortSignal): Promise<Layers | null> {
  const path = layersPath(kind, id);
  if (!path) return null;
  try {
    const r = await http.get(path, { signal });
    return parseLayers(r?.value, kind);
  } catch {
    return null;
  }
}
