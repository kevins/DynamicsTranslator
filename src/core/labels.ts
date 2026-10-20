// Helpers for the Dataverse Label / LocalizedLabel shapes.

import type { Labels, Lcid } from './model';

export interface LocalizedLabel {
  Label: string;
  LanguageCode: number;
  [k: string]: unknown;
}
export interface Label {
  LocalizedLabels?: LocalizedLabel[];
  UserLocalizedLabel?: LocalizedLabel | null;
  [k: string]: unknown;
}

/** Label -> { lcid: text } (all languages present on the server). */
export function toLabels(label: Label | null | undefined): Labels {
  const out: Labels = {};
  for (const l of label?.LocalizedLabels || []) if (l && l.LanguageCode) out[l.LanguageCode] = l.Label ?? '';
  return out;
}

/** A Label containing only the given languages (for MergeLabels writes). */
export function fromChanges(changes: Array<{ lcid: Lcid; text: string }>): Label {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.Label',
    LocalizedLabels: changes.map((c) => ({ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: c.text, LanguageCode: c.lcid })),
  };
}

/**
 * Upserts languages into an existing Label object (used on full-definition PUT bodies).
 * Other languages are left exactly as they were; UserLocalizedLabel is removed because it is read-only.
 */
export function mergeInto(label: Label | null | undefined, changes: Array<{ lcid: Lcid; text: string }>): Label {
  const out: Label = { ...(label || {}), LocalizedLabels: [...(label?.LocalizedLabels || [])].map((l) => ({ ...l })) };
  delete out.UserLocalizedLabel;
  for (const c of changes) {
    const hit = out.LocalizedLabels!.find((l) => l.LanguageCode === c.lcid);
    if (hit) hit.Label = c.text;
    else out.LocalizedLabels!.push({ '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: c.text, LanguageCode: c.lcid } as LocalizedLabel);
  }
  return out;
}

/** The label in a preferred language, falling back to the base language, then any. */
export function pick(labels: Labels, ...prefer: Lcid[]): string {
  for (const l of prefer) if (labels[l]) return labels[l];
  for (const k in labels) if (labels[k]) return labels[k];
  return '';
}

/**
 * Removes OData annotations recursively, for PUT bodies built from GET results. `@odata.type` is kept
 * (it tells Dataverse which derived metadata type an object is); everything else carrying an `@` goes:
 * instance annotations (`@odata.etag`, `@odata.context`, `@Microsoft.Dynamics.CRM.…`) and property
 * annotations (`Name@OData.Community.Display.V1.FormattedValue`, `Value@odata.type`).
 */
export function stripAnnotations<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripAnnotations) as unknown as T;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k !== '@odata.type' && k.includes('@')) continue;
      o[k] = stripAnnotations(x);
    }
    return o as T;
  }
  return v;
}
