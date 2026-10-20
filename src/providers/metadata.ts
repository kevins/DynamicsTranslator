// Table metadata labels: tables, columns, choice options (local, global, status, Yes/No) and
// relationship menu labels.
//
// Writes follow what was verified live: a metadata PUT carries every language currently on the
// server for each edited Label (a PUT holding only the changed language also overwrites the base
// language), in a sparse body sent with MSCRM.MergeLabels; UpdateOptionValue sends only the changed
// languages with MergeLabels: true (verified); UpdateStateValue sends every language of each label it
// carries, like a PUT. Both actions leave out the property that was not edited (verified, findings 35
// and 36). Every writer re-reads with Consistency: Strong right before writing (conflict check) and
// right after (verification). A write Dataverse turned away unrun (the customization lock, throttling) is
// tried again from a new read, never resent as built from the earlier one. Metadata takes no If-Match, so the
// write goes in a $batch behind a read of the component and, for tables, columns and global choices, its solution
// layers: a text someone else saved after the writer's read, which the write sent back as read, is written back
// from the layers (theirs in the edited language makes the change a conflict), or said where only the metadata
// read saw it (race()). UpdateStateValue also carries the state's default status reason as read: one someone else set
// before the write is put back (keepDefault).
//
// A metadata translation can't be removed (findings 31, 32): a blank non-base change is refused with
// an error and never written, while the rest of its group saves normally; a description's (model.ts keepsEmpty) is
// written as '' instead, with every other language as it is, and stored empty (finding 32). Loaders treat a stored ''
// label as missing, but for a description, where it is kept as stored empty.

import { batchGet } from '../core/batch';
import type { Ctx } from '../core/context';
import { DvError, abortError, guid, isAbort, isLogicalName, mayHaveRun, partError, pause, q, turnedAway, type BatchPart } from '../core/http';
import { fromChanges, mergeInto, pick, stripAnnotations, toLabels } from '../core/labels';
import type { Label } from '../core/labels';
import { lcidName } from '../core/lcid';
import { CANT_CLEAR_TEXT, KIND_NAMES, MANAGED, PROP_NAMES, isManaged, keepsEmpty, savesEmpty } from '../core/model';
import { friendly } from '../core/saver';
import type { Change, ChangeResult, Kind, Labels, Prop, Slot } from '../core/model';
import { layersPath, parseLayers, readLayers } from './layers';
import type { LayerKind, Layers } from './layers';
import { check } from './types';
import type { LoadOptions, Loader, SaveOptions, TableInfo, Writer } from './types';
import { logWrite } from './writelog';
import type { WriteAttempt, WriteItem } from './writelog';

const T = 'Microsoft.Dynamics.CRM.';
const STRONG = { Consistency: 'Strong', 'If-None-Match': 'null' };
const META = new Set<Kind>(['entity', 'attribute', 'option', 'status', 'state', 'boolean', 'globaloptionset', 'globaloption', 'relationship']);
const MENUS = ['AssociatedMenuConfiguration', 'Entity1AssociatedMenuConfiguration', 'Entity2AssociatedMenuConfiguration'];
const ATTR = 'LogicalName,DisplayName,Description,AttributeType,AttributeTypeName,AttributeOf,IsCustomizable,IsRenameable,IsManaged,IsCustomAttribute,IsValidForForm,IsLogical';
const REL1 = 'SchemaName,ReferencedEntity,ReferencingEntity,AssociatedMenuConfiguration,IsCustomizable,IsManaged';
const RELN = 'SchemaName,IntersectEntityName,Entity1LogicalName,Entity2LogicalName,Entity1AssociatedMenuConfiguration,Entity2AssociatedMenuConfiguration,IsCustomizable,IsManaged';
const GLOBAL = 'Global choices';
/**
 * UpdateStateValue takes a Description (in $metadata and verified live, finding 36); should an org's
 * action ever reject it, this is the result for the description edits, and the label edits still save.
 */
const STATE_DESCRIPTION = "This Dataverse version can't translate the description of a Status option, only its label. Undo this edit.";

const entityPath = (e: string) => `EntityDefinitions(LogicalName='${q(e)}')`;
const attrPath = (e: string, a: string) => `${entityPath(e)}/Attributes(LogicalName='${q(a)}')`;

/** What a read-only reason calls the component whose managed properties lock its labels. */
export type LockNoun = 'table' | 'column' | 'choice column' | 'relationship' | 'global choice';

/**
 * Why a component's labels can't be changed here ('' = they can): never those of one from a managed solution (MANAGED,
 * whatever its managed properties allow: a translation would be an unmanaged layer on top of it); an unmanaged one
 * whose IsCustomizable managed property is off is marked so in this environment.
 */
export function notCustomizable(x: any, noun: LockNoun, managed = !!x?.IsManaged): string {
  if (managed) return MANAGED;
  if (x?.IsCustomizable?.Value !== false) return '';
  return `This ${noun} is marked as not customizable (its “Allow customizations” managed property is off), so its labels can't be changed here.`;
}

/**
 * Why a table's or column's names can't be changed here ('' = they can). A system one whose renaming Microsoft locks
 * for good (CanBeChanged false) shows Microsoft's own text (the language packs): said so, as before, also where it is
 * managed (the grey built-in look). Otherwise notCustomizable(), then its IsRenameable managed property: locked for good
 * by its solution, or turned off only (CanBeChanged true), when it can be turned back on.
 */
export function notRenameable(x: any, noun: 'table' | 'column', custom: boolean, managed = !!x?.IsManaged): string {
  const names = noun === 'table' ? 'its names' : 'its name';
  const can = x?.IsRenameable?.Value === false ? x.IsRenameable.CanBeChanged : undefined;
  if (can === false && !custom && x?.IsCustomizable?.Value !== false)
    return `Microsoft locks renaming of this ${noun}: ${names} can't be changed, in any language. Dynamics shows Microsoft's own text for ${noun === 'table' ? 'them' : 'it'} (the language pack).`;
  const why = notCustomizable(x, noun, managed);
  if (why || x?.IsRenameable?.Value !== false) return why;
  if (can === false) return `The solution this ${noun} comes from locks renaming it: ${names} can't be changed, in any language.`;
  return can === true
    ? `Renaming is turned off for this ${noun} (its “Display name can be modified” managed property). Turn it on in the ${noun}'s managed properties to translate it here.`
    : `Renaming is turned off for this ${noun}, so ${names} can't be changed here.`;
}
/** Options of a choice (Options) or of a Yes/No set (False, True). */
const opts = (s: any): any[] => s?.Options || [s?.FalseOption, s?.TrueOption].filter(Boolean);

/**
 * Labels as loaded. Dataverse keeps a label saved as '' (shown to that language's users as a blank label,
 * finding 32); the translator treats it as missing, so it shows as untranslated and can be filled in. A description
 * (`keep`, model.ts keepsEmpty) keeps it as a text of its own: stored empty on purpose, so that language's users see
 * none, apart from a missing language, which shows the base text (model.ts storedEmpty).
 */
function stored(label: Label | null | undefined, keep = false): Labels {
  const out = toLabels(label);
  if (!keep) for (const l of Object.keys(out)) if (out[Number(l)] === '') delete out[Number(l)];
  return out;
}

type Base = Omit<Slot, 'key' | 'prop' | 'labels' | 'baseRequired' | 'max'>;
const mk = (kind: Kind, comp: string, entity: string, title: string, path: string[], sub: string, readOnly: string, order: number, ref: any, group = comp): Base => ({
  kind,
  comp,
  group,
  entity,
  title,
  path,
  sub,
  readOnly,
  order,
  ref,
});
const slot = (b: Base, prop: Prop, label: Label | null | undefined, readOnly = b.readOnly): Slot => ({
  ...b,
  key: `${b.comp}|${prop}`,
  prop,
  labels: stored(label, keepsEmpty({ kind: b.kind, prop })),
  readOnly,
  baseRequired: prop !== 'Description',
  max: 0,
});

// ---- Lookups ----

export async function listTables(ctx: Ctx, signal?: AbortSignal): Promise<TableInfo[]> {
  const rows = await ctx.http.all(
    'EntityDefinitions?$select=LogicalName,SchemaName,DisplayName,DisplayCollectionName,IsCustomizable,IsRenameable,IsManaged,IsCustomEntity,IsIntersect,IsActivity,ObjectTypeCode&$filter=IsIntersect eq false',
    { signal },
  );
  const name = (t: TableInfo) => pick(t.displayName, ctx.user, ctx.base) || t.logicalName;
  return rows
    .map(
      (r): TableInfo => ({
        logicalName: r.LogicalName,
        schemaName: r.SchemaName,
        metadataId: guid(r.MetadataId),
        displayName: stored(r.DisplayName),
        collectionName: stored(r.DisplayCollectionName),
        customizable: !!r.IsCustomizable?.Value,
        renameable: !!r.IsRenameable?.Value,
        managed: !!r.IsManaged,
        custom: !!r.IsCustomEntity,
        activity: !!r.IsActivity,
        otc: Number(r.ObjectTypeCode) || 0,
      }),
    )
    .sort((a, b) => name(a).localeCompare(name(b)));
}

/** Object ids (lower-case) of a solution's components of one type (1 table, 9 global choice). */
async function components(ctx: Ctx, solutionId: string, type: number, signal?: AbortSignal): Promise<Set<string>> {
  const rows = await ctx.http.all(`solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${guid(solutionId)} and componenttype eq ${type}`, { signal });
  return new Set(rows.map((r) => guid(r.objectid)));
}

export async function solutionTables(ctx: Ctx, solutionId: string, signal?: AbortSignal): Promise<string[]> {
  const [ids, all] = await Promise.all([
    components(ctx, solutionId, 1, signal),
    ctx.http.all('EntityDefinitions?$select=LogicalName&$filter=IsIntersect eq false', { signal }),
  ]);
  return all.filter((e) => ids.has(guid(e.MetadataId))).map((e) => e.LogicalName as string);
}

// ---- Loading ----

/**
 * Columns that are never shown as labels (AttributeOf children, internal types, virtual helpers) are
 * dropped; noise columns (keys, row versions, yomi, _base, rollup helpers, unnamed or form-less
 * logical columns) are kept only when `all` is set.
 */
function keepAttr(a: any, names: Set<string>, all: boolean): boolean {
  const n: string = a.LogicalName;
  const t: string = a.AttributeType || '';
  if (a.AttributeOf || !t || /^(CalendarRules|ManagedProperty|EntityName)$/.test(t)) return false;
  // File and Image columns are Virtual too, but they are real columns with visible names.
  if (t === 'Virtual' && !/^(MultiSelectPicklist|File|Image)Type$/.test(a.AttributeTypeName?.Value)) return false;
  if (all) return true;
  const m = /^(.+)_(state|date)$/.exec(n);
  return !(
    /^(BigInt|Uniqueidentifier)$/.test(t) ||
    n.includes('yomi') ||
    (a.IsLogical && !a.IsValidForForm) ||
    (n.endsWith('_base') && names.has(n.slice(0, -5))) ||
    (m && names.has(m[1]) && names.has(`${m[1]}_${m[2] === 'state' ? 'date' : 'state'}`)) ||
    !pick(toLabels(a.DisplayName))
  );
}

interface GlobalSet {
  set: any;
  usedBy: string[];
}

/**
 * Every global choice in the org, as Easy Translator listed them: the names in one request, then each set
 * with its options (the same per-set read as the solution path below), many per $batch request. A set
 * that is gone by then (404) is skipped; any other read failure is reported, never silently dropped.
 */
async function everyGlobalSet(ctx: Ctx, sets: Map<string, GlobalSet>, o: LoadOptions): Promise<void> {
  const { http } = ctx;
  const { signal } = o;
  o.progress('Finding global choices');
  const list = await http.all('GlobalOptionSetDefinitions?$select=MetadataId,Name', { signal });
  const ids = [...new Set(list.filter((s) => s?.Name && s.MetadataId && !sets.has(s.Name)).map((s) => guid(s.MetadataId)))];
  if (!ids.length) return;
  const path = (id: string) => `GlobalOptionSetDefinitions(${id})`;
  const res = await batchGet(http, ids.map(path), signal, (n, t) => o.progress('Reading global choices', n, t));
  const failed: Array<[string, string]> = [];
  const keep = (s: any) => {
    if (s?.Name && !sets.has(s.Name)) sets.set(s.Name, { set: s, usedBy: [] });
  };
  for (const [i, r] of res.entries()) {
    if (r.ok) keep(r.data);
    else if (r.status !== 404) failed.push([ids[i], r.error || `HTTP ${r.status}`]);
  }
  // A $batch part the service refused is read on its own once more before it counts as failed.
  const errors: string[] = [];
  await Promise.all(
    failed.map(async ([id, first]) => {
      try {
        keep(await http.get(path(id), { signal }));
      } catch (e) {
        if (isAbort(e)) throw e;
        if (e instanceof DvError && e.status === 404) return;
        errors.push((e as Error)?.message || first);
      }
    }),
  );
  if (signal.aborted) throw abortError();
  if (errors.length && errors.length === ids.length) throw new Error(`Could not read the global choices: ${errors[0]}`);
  if (errors.length) o.progress(`Loaded with problems. ${errors.length} of ${ids.length} global choices could not be read: ${errors[0]}`);
}

async function load(ctx: Ctx, entities: string[], kinds: Set<Kind>, o: LoadOptions, all: boolean, solutionId?: string, everyGlobal = false): Promise<Slot[]> {
  const { http } = ctx;
  const signal = o.signal;
  const name = (l: Label | null | undefined, fallback: string) => pick(toLabels(l), ctx.user, ctx.base) || fallback;
  const glob = kinds.has('globaloption') || kinds.has('globaloptionset');
  const rel = kinds.has('relationship');
  const casts = [
    ...(kinds.has('option') || glob ? ['Picklist', 'MultiSelectPicklist'] : []),
    ...(kinds.has('boolean') || glob ? ['Boolean'] : []),
    ...(kinds.has('status') ? ['Status'] : []),
    ...(kinds.has('state') ? ['State'] : []),
  ];
  const sets = new Map<string, GlobalSet>();
  const rels = new Map<string, any>();
  /** Loaded tables: logical name -> [display name, plural name]. */
  const tables = new Map<string, [string, string]>();

  const table = async (e: string): Promise<Slot[]> => {
    const tp = entityPath(e);
    const exp = [
      kinds.has('attribute') && `Attributes($select=${ATTR})`,
      rel && `OneToManyRelationships($select=${REL1})`,
      rel && `ManyToOneRelationships($select=${REL1})`,
      rel && `ManyToManyRelationships($select=${RELN})`,
    ].filter(Boolean);
    const [ent, ...typed] = await Promise.all([
      http.get(`${tp}?$select=LogicalName,DisplayName,DisplayCollectionName,Description,IsCustomizable,IsRenameable,IsManaged,IsCustomEntity${exp.length ? '&$expand=' + exp.join(',') : ''}`, { signal }),
      ...casts.map((c) =>
        http.all(
          `${tp}/Attributes/${T}${c}AttributeMetadata?$select=LogicalName,DisplayName,AttributeOf,IsCustomizable,IsManaged` +
            `&$expand=OptionSet($select=Name,IsGlobal,IsCustomizable,IsManaged,DisplayName,Description,${c === 'Boolean' ? 'TrueOption,FalseOption' : 'Options'})`,
          { signal },
        ),
      ),
    ]);
    // Every ref keeps the name asked for, which later writes use: it must be the table Dataverse answered with.
    if (ent?.LogicalName !== undefined && String(ent.LogicalName).toLowerCase() !== e) throw new DvError(`Dataverse answered with another table (${ent.LogicalName}).`, 0, 'table-name');
    const tt = name(ent.DisplayName, e);
    tables.set(e, [tt, name(ent.DisplayCollectionName, tt)]);
    const out: Slot[] = [];

    if (kinds.has('entity')) {
      const ref = { entity: e, metadataId: guid(ent.MetadataId), managed: !!ent.IsManaged, custom: !!ent.IsCustomEntity };
      const b = mk('entity', `entity|${e}`, e, tt, [tt], e, notCustomizable(ent, 'table'), 0, ref);
      const names = notRenameable(ent, 'table', ref.custom);
      out.push(slot(b, 'DisplayName', ent.DisplayName, names), slot(b, 'DisplayCollectionName', ent.DisplayCollectionName, names), slot(b, 'Description', ent.Description));
    }

    if (ent.Attributes) {
      const names = new Set<string>(ent.Attributes.map((a: any) => a.LogicalName));
      ent.Attributes.filter((a: any) => keepAttr(a, names, all))
        .map((a: any) => ({ a, t: name(a.DisplayName, a.LogicalName) }))
        .sort((x: any, y: any) => x.t.localeCompare(y.t))
        .forEach(({ a, t }: any, i: number) => {
          const n: string = a.LogicalName;
          const ref = { entity: e, attribute: n, metadataId: guid(a.MetadataId), odataType: String(a['@odata.type'] || '').replace('#', ''), managed: !!a.IsManaged, custom: !!a.IsCustomAttribute };
          const b = mk('attribute', `attribute|${e}.${n}`, e, t, [tt, 'Columns'], n, notCustomizable(a, 'column'), i, ref);
          out.push(slot(b, 'DisplayName', a.DisplayName, notRenameable(a, 'column', ref.custom)), slot(b, 'Description', a.Description));
        });
    }

    typed.forEach((list: any[], i) => {
      const cast = casts[i];
      const kind: Kind = cast === 'Boolean' ? 'boolean' : cast === 'Status' ? 'status' : cast === 'State' ? 'state' : 'option';
      for (const a of list) {
        const os = a.OptionSet;
        const n: string = a.LogicalName;
        if (a.AttributeOf || !os) continue;
        if (os.IsGlobal) {
          // Global sets become globaloption slots once per set, never per-column copies.
          if (!glob) continue;
          let g = sets.get(os.Name);
          if (!g) sets.set(os.Name, (g = { set: os, usedBy: [] }));
          g.usedBy.push(`${e}.${n}`);
          continue;
        }
        if (!kinds.has(kind)) continue;
        const path = [tt, `${name(a.DisplayName, n)} (${n})`, 'Choices'];
        // Its options belong to the column and its own choice: either one from a managed solution makes them read-only.
        const managed = !!a.IsManaged || !!os.IsManaged;
        opts(os).forEach((op, j) => {
          const v = Number(op.Value);
          const ref = { entity: e, attribute: n, value: v, attributeMetadataId: guid(a.MetadataId), optionMetadataId: guid(op.MetadataId), cast, managed };
          const b = mk(kind, `${kind}|${e}.${n}|${v}`, e, name(op.Label, String(v)), path, String(v), notCustomizable(a, 'choice column', managed), j, ref);
          out.push(slot(b, 'Label', op.Label), slot(b, 'Description', op.Description));
        });
      }
    });

    for (const r of [...(ent.OneToManyRelationships || []), ...(ent.ManyToOneRelationships || [])]) if (!rels.has(r.SchemaName)) rels.set(r.SchemaName, { ...r, type: 'OneToMany' });
    for (const r of ent.ManyToManyRelationships || []) if (!rels.has(r.SchemaName)) rels.set(r.SchemaName, { ...r, type: 'ManyToMany' });
    return out;
  };

  let done = 0;
  // A name that isn't a logical name (a file's cell, the page's address) is skipped like a table this org doesn't have.
  const unique = [...new Set(entities.map((e) => e.toLowerCase()))].filter(isLogicalName);
  const per = await Promise.all(
    unique.map(async (e) => {
      try {
        return await table(e);
      } catch (err) {
        if (isAbort(err) || !(err instanceof DvError)) throw err;
        if (err.status === 404) return []; // not in this org (e.g. named in an imported workbook): skip, don't fail the rest
        throw new DvError(`Could not read the table "${e}". ${err.message}`, err.status, err.code, err.url);
      } finally {
        o.progress('Reading table metadata', ++done, unique.length);
      }
    }),
  );
  const out = per.flat();

  // Relationship menus: 1:N has one (on the referenced table), N:N one per side.
  const sides: Array<{ r: any; side: 0 | 1 | 2; owner: string; other: string; m: any; t: string }> = [];
  for (const r of rels.values()) {
    const list: Array<[0 | 1 | 2, string, string, any]> =
      r.type === 'OneToMany'
        ? [[0, r.ReferencedEntity, r.ReferencingEntity, r.AssociatedMenuConfiguration]]
        : [
            [1, r.Entity1LogicalName, r.Entity2LogicalName, r.Entity1AssociatedMenuConfiguration],
            [2, r.Entity2LogicalName, r.Entity1LogicalName, r.Entity2AssociatedMenuConfiguration],
          ];
    for (const [side, owner, other, m] of list) {
      const plural = tables.get(other)?.[1] || other;
      sides.push({ r, side, owner, other, m, t: /^(UseLabel|1)$/.test(String(m?.Behavior)) ? name(m?.Label, plural) : plural });
    }
  }
  sides
    .sort((x, y) => x.t.localeCompare(y.t))
    .forEach(({ r, side, owner, other, m, t }, i) => {
      const beh = String(m?.Behavior);
      const ro =
        notCustomizable(r, 'relationship') || (/^(UseLabel|1)$/.test(beh) ? '' : /^(DoNotDisplay|2)$/.test(beh) ? 'Not shown in the related menu' : "Uses the related table's plural name");
      const group = `relationship|${r.SchemaName}`;
      const ref = {
        schemaName: r.SchemaName,
        metadataId: guid(r.MetadataId),
        type: r.type,
        side: side || undefined,
        entity1: r.Entity1LogicalName,
        entity2: r.Entity2LogicalName,
        intersect: r.IntersectEntityName, // Easy Translator's N:N sheet addresses relationships by it
        referenced: r.ReferencedEntity,
        referencing: r.ReferencingEntity,
        // What the related menu shows: this label (UseLabel), the related table's plural name, or nothing (inspector/scan.ts).
        menu: /^(UseLabel|1)$/.test(beh) ? 'label' : /^(DoNotDisplay|2)$/.test(beh) ? 'none' : 'plural',
        managed: !!r.IsManaged,
      };
      const sub = side ? `${r.SchemaName} (${owner} → ${other})` : r.SchemaName;
      out.push(slot(mk('relationship', side ? `${group}|${side}` : group, owner, t, [tables.get(owner)?.[0] || owner, 'Relationships'], sub, ro, i, ref, group), 'Label', m?.Label));
    });

  // Global choices that belong to the solution are listed even when no loaded table uses them.
  if (solutionId && glob) {
    const ids = await components(ctx, solutionId, 9, signal);
    for (const g of sets.values()) ids.delete(guid(g.set.MetadataId));
    await Promise.all(
      [...ids].map(async (id) => {
        const s = await http.get(`GlobalOptionSetDefinitions(${id})`, { signal }).catch((err) => {
          if (err instanceof DvError && err.status === 404) return null; // removed set still listed in the solution
          throw err;
        });
        if (s?.Name && !sets.has(s.Name)) sets.set(s.Name, { set: s, usedBy: [] });
      }),
    );
  }
  // Every global choice in the org ("Global OptionSets" outside a solution, or nothing else to find them through).
  if (everyGlobal && glob)
    try {
      await everyGlobalSet(ctx, sets, o);
    } catch (e) {
      // The tables' labels and the global choices they use are already read: keep them and say what is missing.
      if (isAbort(e) || signal.aborted || (!out.length && !sets.size)) throw e;
      o.progress(`Loaded with problems. The other global choices could not be read: ${(e as Error)?.message || String(e)}`);
    }
  [...sets]
    .map(([n, g]) => ({ n, g, t: name(g.set.DisplayName, n) }))
    .sort((x, y) => x.t.localeCompare(y.t))
    .forEach(({ n, g, t }, i) => {
      const s = g.set;
      const ro = notCustomizable(s, 'global choice');
      const boolean = !!s.TrueOption;
      if (kinds.has('globaloptionset')) {
        const b = mk('globaloptionset', `globaloptionset|${n}`, '', t, [GLOBAL], n, ro, i, { name: n, metadataId: guid(s.MetadataId), boolean, usedBy: g.usedBy, managed: !!s.IsManaged });
        out.push(slot(b, 'DisplayName', s.DisplayName), slot(b, 'Description', s.Description));
      }
      if (kinds.has('globaloption'))
        opts(s).forEach((op, j) => {
          const v = Number(op.Value);
          const ref = { name: n, value: v, optionMetadataId: guid(op.MetadataId), setId: guid(s.MetadataId), usedBy: g.usedBy, boolean, managed: !!s.IsManaged };
          const b = mk('globaloption', `globaloption|${n}|${v}`, '', name(op.Label, String(v)), [GLOBAL, t], String(v), ro, j, ref);
          out.push(slot(b, 'Label', op.Label), slot(b, 'Description', op.Description));
        });
    });

  return all ? out : out.filter((s) => !s.readOnly);
}

/** Metadata slots of the given kinds for these tables, read-only ones included (shown locked). */
export function loadTables(ctx: Ctx, entities: string[], kinds: Set<Kind>, o: LoadOptions): Promise<Slot[]> {
  return load(ctx, entities, kinds, o, true);
}

export const loadMetadataScope: Loader = (ctx, scope, o) => {
  const kinds = new Set([...scope.kinds].filter((k) => META.has(k)));
  // Global choices are found through the scope's tables or solution; with neither, every global choice is listed.
  const everyGlobal = !scope.solutionId && (!!scope.allGlobals || !scope.entities.some(Boolean));
  return kinds.size ? load(ctx, scope.entities, kinds, o, !!scope.includeReadOnly, scope.solutionId, everyGlobal) : Promise.resolve([]);
};

// ---- Writing ----

const LOCK = /cannot start another|0x80071151|customizationlock|another \[/i;
const CANCELLED = 'Cancelled before saving';
/**
 * Verified live: one language of a metadata label can't be deleted through the Web API (MergeLabels false
 * keeps it, finding 31) and '' is stored and shown to that language's users as a blank label (finding 32).
 */

/** Why a change can't be written at all, decided before any server call ('' = it can be written). */
function refusal(ctx: Ctx, c: Change): string {
  // Loaded from a managed solution: never an unmanaged layer on it (the read before the write checks again, guard()).
  if (isManaged(c.slot)) return MANAGED;
  if (c.after.trim()) return '';
  // A description's translation emptied is saved empty, '' with every other language as it is (model.ts savesEmpty);
  // any other is the saver's to write as its stand-in, so one blank here is refused.
  if (c.lcid !== ctx.base) return savesEmpty(c.slot, c.lcid, ctx.base, c.untranslated) ? '' : CANT_CLEAR_TEXT;
  // A blank base-language description is a real value ('' is stored, finding 34); names and labels are not.
  return c.slot.baseRequired ? `The ${lcidName(ctx.base)} text can't be blank: it is the base language.` : '';
}

/**
 * The text written for a change: only a blank base-language description, or a description's translation saved empty
 * (refusal()), gets here blank, sent as ''.
 */
const text = (c: Change): string => (c.after.trim() ? c.after : '');

/** A missing label, '' and whitespace only all mean "no text in that language". */
const blank = (s: string | undefined): string => (s && s.trim() ? s : '');

/**
 * check() with blank values treated alike (Dataverse keeps '' labels). Only a blank description gets here blank
 * (refusal()): over a description of only spaces it is still written (as ''), not reported as already done while the
 * spaces stay on the server; so is a translation saved empty (`empty`, model.ts savesEmpty) where the language has no
 * label at all (`server` undefined): that one shows the base text until '' is stored there. An edit made where its
 * language had no label at all (Change.beforeMissing) that finds one stored empty there is a conflict: someone saved it
 * empty since (that language's users see no text there now, on purpose), never written over unseen.
 */
function compare(c: Change, server: string | undefined, force: Set<string>, empty = false): ChangeResult | null {
  if (c.beforeMissing && server === '' && c.after.trim() && !force.has(idOf(c))) return { change: c, outcome: 'conflict', server: '', message: 'Someone changed this label after you loaded it.' };
  const r = check({ ...c, before: blank(c.before), after: blank(c.after) }, blank(server), force);
  if (r?.outcome === 'unchanged' && !c.after.trim() && ((server ?? '') !== '' || (empty && server === undefined))) return null;
  return r && { ...r, change: c, ...(r.outcome === 'conflict' ? { server: server ?? '' } : {}) };
}

/** A failed read after the write: the server's own message (friendly() would wrongly say the edits are still pending). */
const problem = (e: unknown): string =>
  e instanceof DvError && LOCK.test(`${e.message} ${e.code}`)
    ? 'Dataverse is busy with another customization. Your edits are still pending; try Save again in a minute.'
    : (e as Error)?.message || String(e);

/** A 400 saying an action has no such parameter (the OData wording for an unknown parameter in the payload). */
const unknownParameter = (e: unknown, name: string): boolean =>
  e instanceof DvError && e.status === 400 && e.message.includes(`'${name}'`) && /not a valid parameter/i.test(e.message);

const edits = (cs: Change[]) => cs.map((c) => ({ lcid: c.lcid, text: text(c) }));

/** The complete Label (every language now on the server) with the changed languages replaced. */
function merged(label: Label | null | undefined, cs: Change[]): Label {
  return {
    '@odata.type': T + 'Label',
    LocalizedLabels: mergeInto(label, edits(cs)).LocalizedLabels!.map((l) => ({ ...stripAnnotations(l), '@odata.type': T + 'LocalizedLabel' })),
  };
}

/** Edited Label properties of a sparse PUT body. */
function props(cur: any, todo: Change[]): Record<string, Label> {
  const out: Record<string, Label> = {};
  for (const c of todo) out[c.slot.prop] ??= merged(cur[c.slot.prop], todo.filter((x) => x.slot.prop === c.slot.prop));
  return out;
}

// Every write is sent `once`: Http never resends it, flow() reads again first. Each request goes in the write's log entry
// (writelog.ts): what was sent, Dataverse's status and request id. flowOnce's writes go in a $batch behind reads (Probe).
const put = (ctx: Ctx, url: string, body: unknown) => sent(ctx, 'PUT', url, () => request(ctx, 'PUT', url, body, { 'MSCRM.MergeLabels': 'true' }));
const action = (ctx: Ctx, name: string, body: unknown) => sent(ctx, 'POST', name, () => request(ctx, 'POST', name, body));

/**
 * The reads a write batch makes right before its write, for the write flowOnce is making (set around write()): the
 * component as its metadata read gives it (`url`) and, for a table, column or global choice, its solution layers (`db`).
 * Dataverse runs the parts of a batch in order (verified live), so they show the component as the write found it: a save
 * someone else made after flowOnce's read is seen there (race()). The layers come from the database and never lag
 * (LIVE-FINDINGS 81); the metadata read can (finding 66).
 */
interface Probe {
  url: string;
  db: string;
  kind?: LayerKind;
  /** What the last write batch's reads showed: undefined before one ran, null when that read failed. */
  read?: any;
  layers?: Layers | null;
  /** The metadata read is behind one of this page's earlier writes (lags(), decided before this write is recorded). */
  behind?: boolean;
  /**
   * This page's earlier writes the metadata read is not past (past()), with the texts they replaced: one of those in the
   * read is the read lagging behind that write, not someone else's (decided before this write is recorded).
   */
  stale?: Array<{ c: Change; text: string; olds: Set<string> }>;
  /** The save's Stop, which ends a wait before asking the layers again (request()); nothing has been written then. */
  signal?: AbortSignal;
}
const PROBE = new WeakMap<Ctx, Probe>();
/** Layer kinds this user can't read (refused, no such table, bad request): write batches leave that read out. */
const NO_DB = new WeakMap<Ctx, Set<LayerKind>>();

/** A write batch whose read before the write failed: Dataverse stopped there, nothing was written. */
const unrun = (e: unknown): boolean => e instanceof DvError && e.code === 'unrun';
/** Nothing written, and worth another try from a new read: turned away, or a read before the write that failed on the server's side. */
const tryAgain = (e: unknown): boolean => turnedAway(e) || (unrun(e) && ((e as DvError).status >= 500 || !(e as DvError).status));
/** mayHaveRun(), except for a write a failed read stopped before it was sent. */
const ran = (e: unknown): boolean => mayHaveRun(e) && !unrun(e);

/**
 * Sends one write: with flowOnce's Probe, in one $batch after its reads, sent `once` and without continue-on-error, so a
 * failed read stops the batch before the write (unrun). Layers this user can't read are left out and the batch is sent
 * again at once without them (nothing was written: the batch stopped at that read). Layers that failed otherwise (429,
 * 5xx) are asked again after 1 and 2 s first: they are the witness that can't lag, so what someone else saved there is
 * written back (race()); without them it can only be said.
 */
async function request(ctx: Ctx, method: 'PUT' | 'POST', url: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; headers: { get(n: string): string | null } }> {
  const pr = PROBE.get(ctx);
  if (!pr) return method === 'PUT' ? ctx.http.put(url, body, { headers, once: true, withHeaders: true }) : ctx.http.post(url, body, { once: true, withHeaders: true });
  let skip = false;
  for (let flaky = 0; ; ) {
    const db = !skip && pr.db && pr.kind && !NO_DB.get(ctx)?.has(pr.kind) ? pr.db : '';
    const parts: BatchPart[] = [{ method: 'GET', url: pr.url, headers: STRONG }, ...(db ? [{ method: 'GET', url: db } as BatchPart] : []), { method, url, body, headers }];
    const res = await ctx.http.batch(parts, { once: true, stop: true });
    const [p, l] = res;
    const w = res[parts.length - 1];
    pr.read = p.ok ? p.data : null;
    pr.layers = db && l.ok ? parseLayers(l.data?.value, pr.kind!) : null;
    // The part's own answer, with its request id for the write log ("Copy details").
    const failed = () => new DvError(partError(w).message, w.status, w.code || '', url, w.headers['x-ms-service-request-id'] || '');
    if (w.ok) return { status: w.status, headers: { get: (n) => w.headers[n.toLowerCase()] ?? null } };
    if (w.status) throw failed();
    if (!p.ok && p.status) throw new DvError(`Could not read the current labels right before saving, so nothing was saved: ${sentence(p.error || `HTTP ${p.status}`)}`, p.status, 'unrun');
    if (db && !l.ok && l.status) {
      if ([400, 403, 404].includes(l.status)) NO_DB.set(ctx, (NO_DB.get(ctx) ?? new Set()).add(pr.kind!));
      else if (flaky < 2) {
        await pause(1000 << flaky++, pr.signal);
        continue;
      }
      skip = true;
      continue;
    }
    throw failed(); // no answer for the write: it may have run
  }
}

/** The log entry of the write each instance is making now (flowOnce): metadata saves run one at a time (alone()). */
const SENDING = new WeakMap<Ctx, WriteAttempt>();
async function sent(ctx: Ctx, method: string, url: string, send: () => Promise<any>): Promise<void> {
  const calls = SENDING.get(ctx)?.calls;
  const req = `${method} ${url}`;
  try {
    const r = await send();
    calls?.push({ req, status: typeof r?.status === 'number' ? `HTTP ${r.status}` : 'OK', requestId: String(r?.headers?.get?.('x-ms-service-request-id') || '') });
  } catch (e) {
    const status = e instanceof DvError ? `${e.status ? `HTTP ${e.status}` : 'no answer'}: ${e.message}` : `failed: ${(e as Error)?.message || String(e)}`;
    calls?.push({ req, status, requestId: e instanceof DvError ? e.requestId : '' });
    throw e;
  }
}

/**
 * The managed properties as read right before a write: the load's reasons (a property changed since). A component the
 * load or that read shows from a managed solution (a local choice's column or its own choice) is refused with MANAGED,
 * so nothing slipped through ever writes an unmanaged layer on it. The writers' reads leave out IsCustomEntity /
 * IsCustomAttribute, which the slot remembers from its load.
 */
const guard =
  (noun: LockNoun) =>
  (cur: any, c: Change): string => {
    const managed = cur?.IsManaged === true || cur?.OptionSet?.IsManaged === true || !!c.slot.ref?.managed;
    return (noun === 'table' || noun === 'column') && c.slot.prop !== 'Description'
      ? notRenameable(cur, noun, !!c.slot.ref?.custom, managed)
      : notCustomizable(cur, noun, managed);
  };

/** Ends a server message with a full stop so more text can follow it. */
const sentence = (m: string): string => (/[.!?]$/.test(m.trim()) ? m.trim() : `${m.trim()}.`);

/** Languages whose text differs between two reads of a label ('' and missing count as the same). */
function moved(before: Label | null | undefined, after: Label | null | undefined): number[] {
  const a = toLabels(before);
  const b = toLabels(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)].map(Number))].filter((l) => (a[l] ?? '') !== (b[l] ?? ''));
}

/**
 * True when language `l` of a label (`is` picks this page's writes of that label) moved from `a` to `b` only because the
 * read before the write is behind one of those writes (MINE): `a` is a text it replaced, `b` its text. That is this page's
 * own write catching up, not someone else's change. Never the other way: the read after shows the write, so it is past
 * that earlier write, and a text from before it there was put back since (Dataverse writing the wrong language, finding 2).
 */
type Ours = (is: (c: Change) => boolean, l: number, a: string | undefined, b: string | undefined) => boolean;
/** What flow() checks besides the edited labels after a write built from `cur`: '' when nothing else moved by `now`. */
type Untouched = (cur: any, now: any, todo: Change[], ours: Ours) => string;

/**
 * Post-write check for flow(): the label properties of the component that this write did not edit must
 * read back exactly as before. Returns '' when they did, else a message saying what moved.
 */
const keep =
  (get: (x: any, p: Prop) => Label | null | undefined, list: Prop[]): Untouched =>
  (cur, now, todo, ours) => {
    const what: string[] = [];
    for (const p of list) {
      if (todo.some((c) => c.slot.prop === p)) continue;
      const before = toLabels(get(cur, p));
      const after = toLabels(get(now, p));
      for (const l of moved(get(cur, p), get(now, p)))
        if (!ours((c) => c.slot.prop === p, l, before[l], after[l])) what.push(`the ${lcidName(l)} ${PROP_NAMES[p].toLowerCase()} to "${after[l] ?? ''}"`);
    }
    return what.length ? `Saved, but Dataverse also changed ${what.join(', ')}. Check it.` : '';
  };

/**
 * The common write pipeline: refusals that need no server call → fresh strong read → conflict check per
 * change → one write with the remaining changes → strong re-read. A write turned away unrun (another
 * customization holds the org-wide lock, or throttling) starts again from a new read after 2, 4, 8 and 16 s, so
 * it never carries a read from before the wait. A change counts as saved only when its language reads back as
 * written, no other language of the same label moved and `untouched` (when given) finds nothing else of the
 * component changed. `write` may return results for changes it ended up not sending (Dataverse refused part of
 * the request); only the rest is verified. `back` says what `write` sends back as read. `target` adds the component to
 * the publish set: after a write, also one that may have run although it failed, and for a label already as asked (it
 * may be an earlier write whose answer was lost, still unpublished). Metadata saves run one at a time across this page's
 * tabs (alone()). `layer` (tables, columns, global choices): the kind of the component among the solution layers, which
 * the database answers itself (byLayers).
 */
async function flow(
  ctx: Ctx,
  changes: Change[],
  o: SaveOptions,
  url: string,
  label: LabelOf,
  allowed: (cur: any, c: Change) => string,
  target: (cur: any) => void,
  write: (cur: any, todo: Change[]) => Promise<ChangeResult[] | void>,
  back: Back,
  untouched?: Untouched,
  layer?: LayerKind,
): Promise<ChangeResult[]> {
  // A write Dataverse answered (204) but whose text still reads exactly as before it: first read again for a while,
  // because a read right after a write can be answered from a metadata cache that has not caught up yet (the user's
  // Edge got the old text for many seconds, while the write had been applied and was later published, LIVE-FINDINGS
  // 66). Only a text still old after that is written again, from a new read (finding 62: a write can also really be
  // dropped), and read again the same way; one that new read shows as written gets verify()'s answer for the first
  // write. A text that moved to anything else meanwhile is a conflict, as always. With `layer`, the solution layers are
  // asked first, right after each write: a write they show made is saved at once, whatever the metadata reads still
  // show; and after the last round they say whether Dataverse applied it at all. So is an edit back (an Undo) that the
  // first read shows as written: that read can't show it made (verify's `probe`), and one they show undone is written again.
  for (const c of changes) {
    ATTS.delete(c);
    NOTE.delete(c);
  }
  const rounds = async (): Promise<ChangeResult[]> => {
    let todo = changes;
    const done: ChangeResult[] = [];
    /** From the second round on: the write each change was sent in before (see flowOnce). */
    let prev: Written | undefined;
    for (let i = 0; ; i++) {
      let rs: ChangeResult[];
      try {
        rs = await flowOnce(ctx, todo, o, url, label, allowed, target, write, back, untouched, prev, layer);
      } catch (e) {
        if (!i) throw e; // nothing written yet: the saver words the error for the whole group
        // A later round failed unexpectedly: the results already found stand.
        return [...done, ...todo.map((change) => retried(e, change))];
      }
      let lost = rs.filter((r) => LOST.has(r));
      // (Also after Stop: an edit back the layers are not asked about gets verify()'s answer from its first read, see byLayers.)
      if (lost.length && layer) lost = await byLayers(ctx, url, label, untouched, lost, layer, o.signal, false);
      if (lost.length && !o.signal.aborted) lost = await settle(ctx, url, label, untouched, lost, o, i >= LOST_TRIES - 1);
      const end = !lost.length || i >= LOST_TRIES - 1 || o.signal.aborted;
      if (end && lost.length && layer && !o.signal.aborted) lost = await byLayers(ctx, url, label, untouched, lost, layer, o.signal, true);
      if (end) {
        for (const r of lost)
          r.message = o.signal.aborted
            ? STOPPED
            : LOST.get(r)!.past || LOST.get(r)!.held
              ? r.message
              : `${r.message}, ${SETTLE_S} seconds after writing it ${i + 1 === 1 ? 'once' : `${i + 1} times`}. Dataverse accepted the change but doesn't show it yet: try again in a minute.`;
        return [...done, ...rs];
      }
      done.push(...rs.filter((r) => !LOST.has(r)));
      prev = new Map(lost.map((r) => [r.change, LOST.get(r)!]));
      todo = lost.map((r) => r.change);
    }
  };
  let entered = false;
  try {
    const out = (await alone(ctx, o.signal, () => ((entered = true), rounds()))).map(noted);
    for (const r of out) for (const it of itemsOf(r.change)) it.outcome = r.message ? `${r.outcome}: ${r.message}` : r.outcome;
    return out;
  } catch (e) {
    for (const c of changes) for (const it of itemsOf(c)) it.outcome = `failed: ${(e as Error)?.message || String(e)}`;
    if (entered || !isAbort(e)) throw e;
    // Cancelled while another tab saved: nothing was sent.
    return changes.map((change): ChangeResult => {
      const why = refusal(ctx, change);
      return why ? { change, outcome: 'error', message: why } : { change, outcome: 'skipped', message: CANCELLED };
    });
  }
}

/** What alone() needs of Web Locks (navigator.locks). */
interface Locks {
  request(name: string, options: { signal?: AbortSignal }, fn: () => Promise<unknown>): Promise<unknown>;
}
/**
 * Runs `fn`, one metadata save (its reads, writes and checks, see flow()), alone among this page's tabs on the org (a tab
 * runs them one at a time already, saver.ts): another tab's save never runs in between, so neither builds a write from a
 * read taken before the other's write was in the record (MINE), nor takes the other's write for someone else's change (two
 * customization writes at once would also meet Dataverse's lock, finding 4). Without Web Locks, or when the browser
 * refuses the lock itself, at once (flowOnce still merges the stored record again after every read).
 */
async function alone<T>(ctx: Ctx, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks;
  if (typeof locks?.request !== 'function') return fn();
  let ran = false;
  try {
    return (await locks.request(`dxt:meta:${ctx.orgId}`, { signal }, () => ((ran = true), fn()))) as T;
  } catch (e) {
    if (ran || isAbort(e) || signal.aborted) throw e;
    return fn();
  }
}

/**
 * A change written and accepted (204) but not confirmed when Stop was pressed. Never "Cancelled before saving" nor
 * "reload" (a reload drops the edit, and nothing publishes or journals the change): the Publish dialog's Try again
 * finds it already as asked, publishes and journals it.
 */
const STOPPED = 'Stopped before Dataverse confirmed it. Dataverse accepted the change: Try again publishes it once Dataverse shows it.';

/** Why a call failed, in a few words for a sentence that says itself what to do next. */
const reason = (e: unknown): string =>
  turnedAway(e) ? 'Dataverse was busy' : e instanceof DvError && e.code === 'network' ? 'Dataverse could not be reached' : ((e as Error)?.message || String(e)).trim().replace(/[.!?]+$/, '');

/**
 * The result of a change written once before and accepted (204) whose next round could not finish: the read before
 * writing again, the lock or the write itself failed (`e`), it was cancelled, or its read still showed this page's last
 * save as not made yet (`e` null, see flowOnce). Worded around Try again, as STOPPED.
 */
const retried = (e: unknown, change: Change): ChangeResult => ({
  change,
  outcome: 'error',
  message: isAbort(e)
    ? STOPPED
    : `Dataverse accepted this change once but hasn't confirmed it yet${e ? `, and checking again failed (${reason(e)})` : ''}. Try again: it publishes the change once Dataverse shows it, or writes it again.`,
});

/**
 * Reads the component again (strong consistency) after 1, 2, 4 and 8 s while some changes are still not shown written (see
 * verify). A change a read shows as written gets the full check of verify() against that read, with the read before its
 * write: saved, or what else moved. One whose text moved to anything else stays unconfirmed, so the next round's read
 * before writing calls it a conflict; in the `last` round it gets verify()'s answer too. One a read past its write still
 * shows as before it (Lost.past) is not waited for: no read can show it. Returns the ones still unconfirmed.
 */
async function settle(
  ctx: Ctx,
  url: string,
  label: LabelOf,
  untouched: Untouched | undefined,
  lost: ChangeResult[],
  o: SaveOptions,
  last: boolean,
): Promise<ChangeResult[]> {
  const group = lost[0].change.slot.group;
  const rec = mine(ctx, url, group);
  const kept = lost.filter((r) => LOST.get(r)!.past);
  let left = lost.filter((r) => !LOST.get(r)!.past);
  for (const ms of SETTLE_WAITS) {
    if (!left.length || o.signal.aborted) break;
    o.progress(`Waiting for Dataverse to confirm ${left[0].change.slot.title}…`);
    try {
      await pause(ms, o.signal);
    } catch {
      break; // cancelled: flow() reports the rest as not confirmed
    }
    let now: any;
    try {
      now = await ctx.http.get(url, { headers: STRONG });
    } catch {
      continue; // a failed read proves nothing either way
    }
    mine(ctx, url, group);
    for (const r of left) LOST.get(r)!.now = now;
    // One verify() per write (its read before writing and the changes it sent), against this read.
    const checked = new Map<Change[], ChangeResult[]>();
    left = left.filter((r) => {
      const w = LOST.get(r)!;
      if (!checked.has(w.todo)) checked.set(w.todo, verify(w.cur, now, w.todo, label, rec, untouched, false, false, false, w.pre));
      const v = checked.get(w.todo)!.find((x) => x.change === r.change)!;
      const lv = LOST.get(v);
      if (lv?.past) {
        LOST.set(r, lv);
        r.message = v.message;
        kept.push(r);
        return false;
      }
      // (A change saved empty that `now` still shows no label for reads as before it, unset(); verify() says so too.)
      if (lv || ((textIn(now, r.change, label) !== text(r.change) || unset(now, r.change, label, ctx.base)) && !last)) return true;
      LOST.delete(r);
      r.outcome = v.outcome;
      if (v.message) r.message = v.message;
      else delete r.message;
      return false;
    });
  }
  if (left.length && __DEV__) console.warn('[translator] not confirmed after waiting', url, left.map((r) => [r.change.slot.key, r.change.lcid]));
  return [...left, ...kept];
}

/**
 * The layer check (layers.ts) of the changes in `lost`, which the metadata reads still show as before their write: the
 * database's own record of the component, with no metadata cache in front of it (LIVE-FINDINGS 66). A change whose
 * language the layers show as written was applied: it gets verify()'s full check of its write against a read made of the
 * layers (fromLayers: the other languages of its label, the labels the write did not edit), so it is saved or says what
 * else moved, with no wait, and this page's record knows it is in the database (inDb). One the layers show as before its
 * write was not applied (yet): it stays for settle() and the next round, and in the `last` round its message says so.
 * Layers that can't be read, or that show anything else there, change nothing. An edit back verify() could only take as
 * made from its first read (Lost.plain) is asked too: one the layers show as before its write stays unconfirmed, one they
 * show another text for (someone else's since) gets verify()'s check against them as one shown written does, and one they
 * can't tell (unreadable, Stop pressed, no text there) gets that first answer, as without them. Returns the changes still
 * unconfirmed.
 */
async function byLayers(ctx: Ctx, url: string, label: LabelOf, untouched: Untouched | undefined, lost: ChangeResult[], kind: LayerKind, signal: AbortSignal, last: boolean): Promise<ChangeResult[]> {
  const id = String(LOST.get(lost[0])!.cur?.MetadataId || lost[0].change.slot.ref?.metadataId || '');
  const ls = id && !signal.aborted ? await readLayers(ctx.http, kind, id, signal) : null;
  const shows = (c: Change): string | undefined => ls?.props[c.slot.prop]?.[c.lcid];
  const when = new Date(Date.now()).toISOString();
  if (id)
    for (const r of lost) {
      const c = r.change;
      const t = shows(c);
      const what = !ls ? (signal.aborted ? 'not asked (stopped)' : 'unavailable') : !ls.props[c.slot.prop] ? 'no such label' : t === undefined ? 'no text in this language' : JSON.stringify(t);
      itemsOf(c).pop()?.layers.push(`${when}: ${what}${ls?.modifiedon ? ` (Active layer modifiedon ${ls.modifiedon})` : ''}`);
    }
  const rec = mine(ctx, url, lost[0].change.slot.group);
  for (const r of lost) {
    const l = LOST.get(r)!;
    if (!l.plain) continue;
    const t = shows(r.change);
    if (t === undefined) {
      LOST.delete(r);
      r.outcome = l.plain.outcome;
      if (l.plain.message) r.message = l.plain.message;
      else delete r.message;
      confirm(rec, r.change);
    }
    // A text from before the write in the database (as read before it, or one this page's writes replaced): not made (yet).
    else if (blank(t) !== text(r.change) && (blank(t) === textIn(l.cur, r.change, label) || replaced(rec.own.get(idOf(r.change)), t))) delete l.plain;
  }
  lost = lost.filter((r) => LOST.has(r));
  if (!ls || !lost.length) return lost;
  for (const todo of new Set(lost.map((r) => LOST.get(r)!.todo))) {
    const rs = lost.filter((r) => LOST.get(r)!.todo === todo);
    const yes = rs.filter((r) => shows(r.change) !== undefined && (blank(shows(r.change)) === text(r.change) || !!LOST.get(r)!.plain));
    if (yes.length) {
      const w = LOST.get(yes[0])!;
      const made = yes.map((r) => r.change);
      const x = fromLayers(w.cur, w.now ?? w.cur, ls, todo, todo.filter((c) => !made.includes(c)));
      const vs = verify(w.cur, x, made, label, rec, untouched, true, true, false, w.pre);
      for (const r of yes) {
        const v = vs.find((y) => y.change === r.change)!;
        if (LOST.has(v)) continue; // (never: a read of the database is behind nothing, verify's `db`)
        LOST.delete(r);
        r.outcome = v.outcome;
        if (v.message) r.message = v.message;
        else delete r.message;
        if (blank(shows(r.change)) === text(r.change)) inDb(rec, r.change);
      }
    }
    if (last)
      for (const r of rs) {
        const l = LOST.get(r);
        const g = blank(shows(r.change));
        if (!l || !ls.props[r.change.slot.prop] || g === text(r.change)) continue;
        // Still a text from before the write (as read before it, or one this page's writes replaced there): not applied.
        if (g !== textIn(l.cur, r.change, label) && !replaced(rec.own.get(idOf(r.change)), g)) continue;
        r.message = notApplied(r.change, g);
        l.held = true;
      }
  }
  return lost.filter((r) => LOST.has(r));
}

/** The last round's word for a change the layers still show as before its write (byLayers): what the database holds. */
const notApplied = (c: Change, held: string): string =>
  `Dataverse answered OK but didn't apply this change: its records still show ${held ? `“${held}”` : `no ${lcidName(c.lcid)} text`}. Try again; if it keeps happening, copy the details for support.`;

/**
 * A read of the component made of the layers `ls` over `now` (the last metadata read), for byLayers: each label property
 * the layers hold, in the languages the reads `cur` and `now` have and the changes of `todo` write (one the layers lack as
 * `now` has it; one only the layers hold left out, it may be no language of this org), and the languages of the changes
 * `open` (not shown written) as read before their write, so they never count as moved. Only for writers whose labels are
 * the read's own properties (label(x, c) is x[c.slot.prop]).
 */
function fromLayers(cur: any, now: any, ls: Layers, todo: Change[], open: Change[]): any {
  const x = { ...now };
  for (const [p, have] of Object.entries(ls.props) as Array<[Prop, Labels]>) {
    const was = toLabels(cur?.[p]);
    const read = toLabels(now?.[p]);
    const langs = new Set([...Object.keys(was), ...Object.keys(read)].map(Number));
    for (const c of todo) if (c.slot.prop === p) langs.add(c.lcid);
    const out: Labels = {};
    for (const l of langs) {
      const v = open.some((c) => c.slot.prop === p && c.lcid === l) ? was[l] : l in have ? have[l] : read[l];
      if (v !== undefined) out[l] = v;
    }
    x[p] = { LocalizedLabels: Object.entries(out).map(([l, t]) => ({ Label: t, LanguageCode: Number(l) })) };
  }
  return x;
}

/**
 * A write whose changes are not all shown written yet (see flow): the read before that write and the changes it sent, so
 * settle() can check a later read the same way. `past`: that read was past the write (it showed another of its texts made)
 * and still showed this language as before it, so no wait helps: Dataverse did not keep it (or someone put it back).
 * `now`: the last read that showed it so. `held`: its message says what the database still holds there (byLayers).
 * `plain`: an edit back the first read after the write shows as written but can't show made (verify's `probe`): verify()'s
 * answer from that read, which stands when the layers can't tell (byLayers).
 */
interface Lost {
  cur: any;
  todo: Change[];
  past?: boolean;
  now?: any;
  held?: boolean;
  plain?: ChangeResult;
  pre?: Pre;
}
/**
 * The read in a write's batch, right before it (Probe), for verify(): what it shows there that the write did not send (a
 * language an option action leaves out, `langs`; a label a sparse PUT leaves out) is someone else's save, not the write's doing.
 */
interface Pre {
  x: any;
  langs: boolean;
}
const LOST = new WeakMap<ChangeResult, Lost>();
/** The Lost entry of each change written again (flow's later rounds). */
type Written = Map<Change, Lost>;
const LOST_TRIES = 2;
/** Waits between the reads that confirm a write (see settle), and before writing from a read behind this page's own write. */
const SETTLE_WAITS = [1000, 2000, 4000, 8000];
const SETTLE_S = SETTLE_WAITS.reduce((a, b) => a + b, 0) / 1000;
/** Waits before a conflict found at the read before a write is read again (see flowOnce): the start of SETTLE_WAITS. */
const CONFLICT_WAITS = SETTLE_WAITS.slice(0, 2);

/** How a writer finds a change's label in a read of its component. */
type LabelOf = (cur: any, c: Change) => Label | null | undefined;
const idOf = (c: Change): string => `${c.slot.key}#${c.lcid}`;
/** The text of `c`'s language in the read `x` (blank: none). */
const textIn = (x: any, c: Change, label: LabelOf): string => blank(toLabels(label(x, c))[c.lcid]);
/**
 * True when `c` saves its language empty (model.ts savesEmpty: '' is the text it writes) and the read `x` has no label
 * at all in that language: that language still shows the base text there, as before the write, though textIn() reads
 * it as '' too. Only a '' stored there shows the write made (toLabels keeps it; the loaders do too).
 */
const unset = (x: any, c: Change, label: LabelOf, base: number): boolean =>
  !text(c) && savesEmpty(c.slot, c.lcid, base, c.untranslated) && toLabels(label(x, c))[c.lcid] === undefined;

/**
 * This page's own writes per component (url and save group), by `key#lcid`: the text this page last wrote there, the
 * write that did, and the texts the server held there before it as far as this page knows (the ones its writes replaced,
 * the ones its reads showed there before writing) in the last MINE_MS. A read before a later write that shows one of
 * those (lags()) is behind this page's write (LIVE-FINDINGS 66), unless it shows a later write of this page made (past()):
 * what it sends back as read would undo that write, and verify() could not tell, as it compares with the same read. A read
 * that shows anything else is newer: what differs from the slot is someone else's. The record is kept in localStorage too
 * (MINE_KEY), so the page reloaded after a publish, a reopened translator and another tab know it; with the storage
 * blocked, it lasts as long as this instance.
 */
interface Own {
  c: Change;
  /** The text this page last wrote, confirmed or accepted (accepted()). */
  text: string;
  /** The write that did (seq()). */
  w: number;
  /**
   * The first of this page's writes of that text in a row: a write of it again over another text keeps it while it is the
   * same write again (the next round, Try again of one no read showed made), else it makes the text anew (accepted()).
   */
  made: number;
  /**
   * The texts from before that write, each with the write that last replaced it; `text` too when it is one of them (an
   * edit back, an Undo): a read showing it then proves nothing by itself (shown()).
   */
  olds: Olds;
  /**
   * The write (`w`) whose text the solution layers showed in the database (byLayers, inDb()) while the metadata reads
   * still showed the text from before it: a read showing that text is behind it, but writing the same text again over it
   * undoes nothing of it (behindOf()).
   */
  db?: number;
  /** When the entry last changed: the newer of two copies (this instance's, the stored one) counts. */
  at: number;
}
interface Mine {
  ctx: Ctx;
  /** The url and save group. */
  g: string;
  own: Map<string, Own>;
}
/** A stored Own: what label(cur, c) needs of its change (the slot's key, property and relationship side). */
interface Saved {
  g: string;
  key: string;
  prop: Prop;
  side?: number;
  lcid: number;
  text: string;
  w: number;
  made: number;
  olds: Olds;
  db?: number;
  at: number;
}
/**
 * Texts from before a write, each with the write that last replaced it (seq(): its time) and 1 while no read has shown
 * that write made (accepted(), confirm()): it may have been dropped (finding 62), so a write of the same text again does
 * not wait for a read showing anything but that text (lags()): it writes it again, as the same write (accepted()). Every
 * other use counts it as any such text.
 */
type Olds = Array<[string, number, 1?]>;
const MINE = new WeakMap<Ctx, Map<string, Map<string, Own>>>();
const MINE_KEY = (ctx: Ctx) => `dxt:mine:${ctx.orgId}`;
/**
 * How long a write counts in lags(): reads lagged for seconds (LIVE-FINDINGS 66). Later, a text from before it is someone
 * else's again (they may have put it back). Counted from the write, so a refusal to write (behindMsg) never comes later
 * than a minute after this page's last write of that label.
 */
const MINE_MS = 60_000;
/** True when the time (or write, seq()) `t` is less than MINE_MS away: one further in the future (the clock was put back) never counts. */
const recent = (t: number): boolean => Math.abs(Date.now() - t) < MINE_MS;
const fresh = (olds: Olds): Olds => olds.filter(([, w]) => recent(w));
/**
 * The newest write this instance made or learned of (MINE). A write's number is its time, made unique and increasing,
 * so a read showing a write made is past every earlier one (past()): metadata saves run one at a time, also across tabs
 * (alone()).
 */
let lastWrite = 0;
const seq = (): number => (lastWrite = Math.max(Date.now(), recent(lastWrite) ? lastWrite + 1 : 0));
/**
 * False while localStorage is blocked: MINE then knows only this instance's writes, so flowOnce reads again before
 * taking a conflict, a text already as asked or another language that differs from the slot as the server's.
 */
let persisted = false;
/**
 * The stored record, without the entries that have no text from before their write younger than MINE_MS and have not
 * changed for MINE_MS either ([] when the storage is blocked).
 */
function readMine(ctx: Ctx): Saved[] {
  try {
    const v = JSON.parse(localStorage.getItem(MINE_KEY(ctx)) || '[]');
    persisted = true;
    return (Array.isArray(v) ? v : [])
      .filter((e) => e && typeof e.g === 'string' && typeof e.key === 'string' && typeof e.text === 'string' && Array.isArray(e.olds))
      .map((e: Saved) => ({ ...e, w: Number(e.w) || e.at, made: Number(e.made) || Number(e.w) || e.at, olds: fresh(e.olds) }))
      .filter((e) => e.olds.length || recent(e.at));
  } catch {
    persisted = false;
    return [];
  }
}
/** The record of one component: this instance's, with what the stored one has newer (another instance, another tab). */
function mine(ctx: Ctx, url: string, group: string): Mine {
  let m = MINE.get(ctx);
  if (!m) MINE.set(ctx, (m = new Map()));
  const g = `${url} ${group}`;
  let own = m.get(g);
  if (!own) m.set(g, (own = new Map()));
  for (const e of readMine(ctx)) {
    lastWrite = Math.max(lastWrite, e.w);
    const id = `${e.key}#${e.lcid}`;
    const have = own.get(id);
    if (e.g !== g || (have ? have.at > e.at : !e.olds.length)) continue;
    const c = have?.c ?? ({ slot: { key: e.key, prop: e.prop, ref: { side: e.side } }, lcid: e.lcid, before: '', after: e.text } as unknown as Change);
    own.set(id, { c, text: e.text, w: e.w, made: e.made, olds: e.olds, db: Number(e.db) || undefined, at: e.at });
  }
  return { ctx, g, own };
}
/** Sets one entry of the record, here and in the storage. */
function setOwn(rec: Mine, m: Own): void {
  const { slot, lcid } = m.c;
  const id = idOf(m.c);
  rec.own.set(id, m);
  try {
    const rest = readMine(rec.ctx).filter((e) => e.g !== rec.g || `${e.key}#${e.lcid}` !== id);
    const e: Saved = { g: rec.g, key: slot.key, prop: slot.prop, side: slot.ref?.side, lcid, text: m.text, w: m.w, made: m.made, olds: m.olds, db: m.db, at: m.at };
    localStorage.setItem(MINE_KEY(rec.ctx), JSON.stringify([...rest, e]));
  } catch {
    persisted = false; // storage blocked or full: this instance still knows it
  }
}
/**
 * The write `w` of `c`, which Dataverse accepted or which may have run although it failed, built from a read that showed
 * `was` in its language: `was` and this page's own text there before are what it replaced, and every other text this page
 * knew there (`seen`: this round's other reads, the text the edit started from, the one loaded) is from before it too,
 * keeping the write it was replaced by when the record has it. All marked (Olds) until a read shows the write made
 * (confirm()). The text written is one of them when a read showed it there before (an edit back, or a text already as
 * asked written again). `sent`: a language the write only sends back as read (Back): written too, as it was, so nothing
 * of it is marked, and over this page's own text there (of the last MINE_MS) it is still the write that made it.
 *
 * This page's own text written again over another one is the same write again (`made` stays) while no read showed it made,
 * no other write of this page came in between and the read before it shows no write of that text made (`shownMade`,
 * past()): the next round, Try again of a write that may have been dropped. Otherwise this write makes it anew, and within
 * MINE_MS of the last one that text is from before it too: it may have been there (someone put the other one back since).
 */
function accepted(rec: Mine, c: Change, was: string, seen: Iterable<string>, w: number, sent = false, shownMade = false): void {
  const m = rec.own.get(idOf(c));
  const same = sent && m?.text === text(c) && recent(m.w);
  const over = !sent && m?.text === text(c) && was !== m.text;
  const marked = over && fresh(m.olds).some(([, , a]) => a);
  const between = over && [...rec.own.values()].some((x) => x.w > m.w && x.w < w);
  const anew = over && (!marked || between || shownMade);
  const gone = new Set(same ? [] : [was, ...(m && recent(m.w) && (m.text !== text(c) || anew) ? [m.text] : [])]);
  const olds = fresh(m?.olds ?? []).filter(([x]) => !gone.has(x));
  for (const x of seen) if (!olds.some(([y]) => y === x) && !(same && x === text(c))) gone.add(x);
  if (same && !gone.size) return;
  for (const x of gone) olds.push(sent ? [x, w] : [x, w, 1]);
  setOwn(rec, same ? { ...m!, olds, at: Date.now() } : { c, text: text(c), w, made: !sent && m?.text === text(c) && !anew ? m.made : w, olds, at: Date.now() });
}
/** A read showed this page's last write of `c`'s language made (or its text already as asked): no mark any more. */
function confirm(rec: Mine, c: Change): void {
  const m = rec.own.get(idOf(c));
  if (m?.text === text(c) && m.olds.some(([, , a]) => a)) setOwn(rec, { ...m, c, olds: m.olds.map(([x, w]): [string, number] => [x, w]), at: Date.now() });
}
/** The write that last replaced `t` in `m`'s language in the last MINE_MS (0: none, or no such text). */
const since = (m: Own | undefined, t: string): number => (m && fresh(m.olds).find(([x]) => x === t)?.[1]) || 0;
/**
 * True when the read `x` is past this page's write `w`: it shows a text that a write of this page made at `w` or later put
 * there, and either no earlier state had it (as far as this page knows: what it saw there in the MINE_MS before its last
 * write of it) or the read is past the write that last replaced it before (an edit back's text, in a read that shows the
 * save it undid made). A read is one state of the component, so it is past every earlier write too: a text from before one
 * of those that it shows was put back since, it is no read behind.
 */
const past = (rec: Mine, x: any, label: LabelOf, w: number): boolean =>
  [...rec.own.values()].some((m) => {
    if (m.made < w || !recent(m.w) || textIn(x, m.c, label) !== m.text) return false;
    const s = since(m, m.text);
    return !s || (s < w && past(rec, x, label, s));
  });
/** True when the read `x` shows `c` written by this page's last write there: its text, and only a read past that write could. */
function shown(rec: Mine, x: any, c: Change, label: LabelOf): boolean {
  const s = since(rec.own.get(idOf(c)), text(c));
  return textIn(x, c, label) === text(c) && (!s || past(rec, x, label, s));
}
/** True when `t` is a text from before `m`'s write: a read showing it is behind that write, or it was put back. */
const replaced = (m: Own | undefined, t: string | undefined): boolean => !!m && blank(t) !== m.text && !!since(m, blank(t));
/**
 * True when the read `x` is behind this page's write of `m`'s language: it shows a text from before that write and no
 * write of this page made since the first of its writes of that text in a row (`made`, past()); a later one of the same
 * write again (the next round) can't be told from it, and a read past it shows a text from before it put back since. Its
 * own text never is, an edit back's either: a read behind the save it undid shows the same, but what goes back from it is
 * this page's last text there. `again`: the write to come writes `m.text` there again, so a text only that write's
 * unconfirmed predecessor replaced is no sign (Olds), nor one that the layers showed the database holds no more (db).
 */
function behindOf(rec: Mine, x: any, label: LabelOf, m: Own, again = false): boolean {
  const t = textIn(x, m.c, label);
  const old = t !== m.text && fresh(m.olds).find(([y]) => y === t);
  return !!old && !((old[2] || m.db === m.w) && again) && !past(rec, x, label, m.made);
}
/** The solution layers showed this page's last write of `c`'s language in the database (byLayers): see Own.db. */
function inDb(rec: Mine, c: Change): void {
  const m = rec.own.get(idOf(c));
  if (m?.text === text(c) && m.db !== m.w) setOwn(rec, { ...m, c, db: m.w, at: Date.now() });
}
/**
 * True when `cur` is behind one of this page's recent writes that this write sends back (`sent`, see behindOf()). `again`
 * picks those this write writes again with the same text.
 */
const lags = (rec: Mine, cur: any, label: LabelOf, sent: (m: Own) => boolean, again: (m: Own) => boolean): boolean =>
  [...rec.own.values()].some((m) => sent(m) && behindOf(rec, cur, label, m, again(m)));
/**
 * True when the read `cur` before the write of `asking` is behind a write of this page that the solution layers showed in
 * the database while the metadata reads lagged (Own.db, byLayers): a language of a label it writes (and so sends back as
 * read) that it does not write itself reads otherwise than that write's text, and the layers, asked again, still hold it.
 * Such a save returned at once, so the next one may well read during the same lag, and lags() can't tell every read behind
 * (a text it never knew there, one a write of this page made that the read shows from before, past()); the database can.
 * Asked only then: unavailable layers prove nothing.
 */
async function dbBehind(ctx: Ctx, cur: any, label: LabelOf, rec: Mine, asking: Change[], kind: LayerKind, signal: AbortSignal): Promise<boolean> {
  const ms = [...rec.own.values()].filter(
    (m) => m.db === m.w && recent(m.w) && asking.some((c) => c.slot.key === m.c.slot.key) && !asking.some((c) => idOf(c) === idOf(m.c)) && textIn(cur, m.c, label) !== m.text,
  );
  if (!ms.length) return false;
  const ls = await readLayers(ctx.http, kind, String(cur?.MetadataId || asking[0].slot.ref?.metadataId || ''), signal);
  return !!ls && ms.some((m) => {
    const t = ls.props[m.c.slot.prop]?.[m.c.lcid];
    return t !== undefined && blank(t) === m.text;
  });
}
/** Ours for the record `rec` and the read `cur` before the write: never a text `cur` shows put back since (past()). */
const ours =
  (rec: Mine, cur: any, label: LabelOf): Ours =>
  (is, l, a, b) =>
    [...rec.own.values()].some((m) => m.c.lcid === l && is(m.c) && replaced(m, a) && blank(b) === m.text && !past(rec, cur, label, m.made));
/**
 * True when a text already as asked (`cur` shows `c` written) is taken as made: this page has no write there in the last
 * MINE_MS, or its last one wrote that text and a read showed it made, or `cur` does (shown()). Otherwise it is written
 * again (the same text, no change if it is there): this page wrote another text there since (`cur` is behind that write),
 * or an edit back no read has shown made reads so in a read behind the save it undoes too (and it may have been dropped).
 */
function sure(rec: Mine, cur: any, c: Change, label: LabelOf): boolean {
  const m = rec.own.get(idOf(c));
  if (!m || !recent(m.w)) return true;
  return m.text === text(c) && (!m.olds.some(([, , a]) => a) || shown(rec, cur, c, label));
}
/**
 * What a write sends back as read besides the languages it writes, so which of this page's recent writes a read behind
 * them could undo (lags()): 'langs' nothing (UpdateOptionValue sends only the changed languages), 'labels' every language
 * of each label it edits (the metadata PUTs, UpdateStateValue), 'all' the whole definition (a relationship's PUT).
 */
type Back = 'langs' | 'labels' | 'all';
/** A read before writing still behind this page's own write after every wait (see flowOnce): nothing was written. */
const behindMsg = (s: Slot): string =>
  `Not saved: Dataverse doesn't show your last change to this ${KIND_NAMES[s.kind][0].toLowerCase()} yet, and saving now could undo it. Try again in a minute.`;

/**
 * True when a language that a write of `todo` sends back as read (one it does not edit) reads otherwise than the slot's
 * labels. Only while the storage is blocked (MINE then misses this page's writes before a reload) and for labels this
 * instance has no write of: the read may lag behind a save made before (LIVE-FINDINGS 66). Otherwise MINE tells lag
 * apart, and a slot out of date (someone else's text since the load, a language added since) costs no wait.
 */
function behind(cur: any, todo: Change[], label: LabelOf): boolean {
  return todo.some((c) => {
    const known = c.slot.labels;
    const got = toLabels(label(cur, c));
    return Object.keys({ ...known, ...got })
      .map(Number)
      .some((l) => !todo.some((x) => x.slot.key === c.slot.key && x.lcid === l) && blank(got[l]) !== blank(known[l]));
  });
}

/**
 * One round of flow(). `prev` (the later rounds) holds the write each change was sent in before: a change that now reads
 * as written gets verify()'s answer for that write, and a failure or Cancel says that write was accepted.
 */
async function flowOnce(
  ctx: Ctx,
  changes: Change[],
  o: SaveOptions,
  url: string,
  label: LabelOf,
  allowed: (cur: any, c: Change) => string,
  target: (cur: any) => void,
  write: (cur: any, todo: Change[]) => Promise<ChangeResult[] | void>,
  back: Back,
  untouched?: Untouched,
  prev?: Written,
  layer?: LayerKind,
): Promise<ChangeResult[]> {
  const out: ChangeResult[] = [];
  // Keeps the results found so far instead of letting the saver turn the whole group into errors; when
  // there are none, the saver words the error itself. Either way the wording is the saver's (friendly()). In a later
  // round every change was written once and accepted, which retried() says.
  const stop = (e: unknown, rest: Change[]): ChangeResult[] => {
    if (!out.length && !isAbort(e) && !prev) throw e;
    return [
      ...out,
      ...rest.map((change): ChangeResult =>
        prev ? retried(e, change) : isAbort(e) ? { change, outcome: 'skipped', message: CANCELLED } : { change, outcome: 'error', message: friendly(e) },
      ),
    ];
  };

  const asked: Change[] = [];
  for (const c of changes) {
    const why = refusal(ctx, c);
    if (why) out.push({ change: c, outcome: 'error', message: why });
    else asked.push(c);
  }
  if (!asked.length) return out; // nothing to write: no server call at all

  const s = asked[0].slot;
  o.progress(`Saving ${s.title} (${KIND_NAMES[s.kind][0].toLowerCase()})`);
  const read = (signal?: AbortSignal) => ctx.http.get(url, { headers: STRONG, signal });
  const rec = mine(ctx, url, s.group);
  // This page's recent writes that this write sends back as read (Back), and always those of the languages it writes: a
  // read behind one of those makes this page's own text look like someone else's change, or the change already made.
  const sent = (m: Own) => back === 'all' || asked.some((c) => c.slot.key === m.c.slot.key && (back === 'labels' || c.lcid === m.c.lcid));
  /**
   * What this page knew there before the write, by `key#lcid` (accepted()): what the reads of this round showed in every
   * language of the labels asked, the text each edit started from, the one loaded.
   */
  const seen = new Map<string, Set<string>>();
  const saw = (id: string, t: string | undefined) => {
    let s = seen.get(id);
    if (!s) seen.set(id, (s = new Set()));
    s.add(blank(t));
  };
  for (const c of asked) {
    saw(idOf(c), c.before);
    saw(idOf(c), c.slot.labels?.[c.lcid]);
  }
  let cur: any;
  let asking: Change[] = [];
  let dropped: ChangeResult[] = [];
  let probe: Probe | undefined;
  /**
   * What a write found in its batch's read (`x`, or the layers' labels by property): texts from before the write (accepted()),
   * someone else's save since the read before it included. Its own text there is one too when someone else saved it (a read
   * showing it proves nothing of this write), never when this page's own recent write did; a text it sends back as read
   * adds nothing.
   */
  const replacedBy = (x: any, db = false) => {
    for (const c of asked)
      for (const [l, t] of Object.entries<string>(db ? (x[c.slot.prop] ?? {}) : toLabels(label(x, c)))) {
        const own = asking.find((a) => a.slot.key === c.slot.key && a.lcid === Number(l));
        const m = own && rec.own.get(idOf(own));
        const mine = !!own && blank(t) === text(own) && m?.text === text(own) && recent(m.w);
        if (!mine && (own || blank(t) !== textIn(cur, { ...c, lcid: Number(l) }, label))) saw(`${c.slot.key}#${l}`, t);
      }
  };
  // Cancelling stops before the next read or write; a write in flight is never aborted (it would still apply on
  // the server, unverified).
  for (let i = 0, again = 0; ; i++) {
    try {
      cur = await read(o.signal);
    } catch (e) {
      return stop(e, asked);
    }
    mine(ctx, url, s.group); // another tab's save meanwhile (without Web Locks, see alone())
    const found: ChangeResult[] = [];
    asking = [];
    for (const c of asked) {
      saw(idOf(c), textIn(cur, c, label));
      for (const [l, t] of Object.entries(toLabels(label(cur, c)))) saw(`${c.slot.key}#${l}`, t);
      const why = allowed(cur, c);
      const r = why ? { change: c, outcome: 'error' as const, message: why } : compare(c, toLabels(label(cur, c))[c.lcid], o.force, savesEmpty(c.slot, c.lcid, ctx.base, c.untranslated));
      // A text already as asked that this read can't show made is written again (sure()).
      if (r && (r.outcome !== 'unchanged' || sure(rec, cur, c, label))) found.push(r);
      else asking.push(c);
    }
    // A read that shows one of this page's own writes that this write sends back (`sent`: another language, a
    // relationship's other menu label, the language itself) with a text from before it (lags()) is behind it (LIVE-FINDINGS
    // 66): it is read again up to 15 s, and if still behind, nothing is written from it (it would undo that write, and
    // verify() could not tell) nor taken as the answer. A write that sends none of them back is made at once: the read can
    // only make them look moved, which verify() and keep() know (Ours). Anything else that differs is someone else's and
    // goes back as read. A text that only a write of this page not yet confirmed replaced is behind for every write but the
    // one writing that same text again: so a write really dropped (finding 62) is written again by the next round or Try
    // again. With the storage blocked (MINE incomplete) a conflict, a text already as asked and a language sent back that
    // differs from the slot (behind()) are read again after 1 and 2 s first: the read may lag behind a write made before.
    const rewrites = (m: Own) => asking.some((c) => idOf(c) === idOf(m.c) && text(c) === m.text);
    // A text already as asked is no answer from a read behind any write of this page: it may lag behind someone else's too.
    // The solution layers tell what the record can't: a read behind a write of this page that they showed made (dbBehind).
    const old =
      lags(rec, cur, label, sent, rewrites) ||
      (found.some((r) => r.outcome === 'unchanged') && lags(rec, cur, label, () => true, rewrites)) ||
      (!!layer && asking.length > 0 && (await dbBehind(ctx, cur, label, rec, asking, layer, o.signal)));
    const lag =
      old ||
      (!persisted &&
        (found.some((r) => r.outcome === 'conflict' || r.outcome === 'unchanged') ||
          (back !== 'langs' && behind(cur, asking.filter((c) => ![...rec.own.values()].some((m) => m.c.slot.key === c.slot.key)), label))));
    const waits = old ? SETTLE_WAITS : CONFLICT_WAITS;
    if (lag && again < waits.length) {
      if (old) o.progress(`Waiting for Dataverse to show your last save of ${s.title}…`);
      try {
        await pause(waits[again++], o.signal);
        i--;
        continue;
      } catch (a) {
        return stop(a, asked);
      }
    }
    if (old) return [...out, ...asked.map((change): ChangeResult => (prev ? retried(null, change) : { change, outcome: 'error', message: behindMsg(change.slot) }))];
    let err: unknown = null;
    const w = asking.length ? seq() : 0;
    if (asking.length)
      try {
        if (o.signal.aborted) throw abortError();
        SENDING.set(ctx, logged(cur, asking, label));
        // The write goes in a $batch right after a read of the component (and its layers): see Probe and race().
        probe = { url, db: layer ? layersPath(layer, String(cur?.MetadataId || asking[0].slot.ref?.metadataId || '')) : '', kind: layer, signal: o.signal };
        PROBE.set(ctx, probe);
        dropped = (await write(cur, asking)) || [];
        if (probe.read) {
          // As for the read before the write (lags()): a text only this write's unconfirmed predecessor replaced is no sign.
          const x = probe.read;
          probe.behind = lags(rec, x, label, () => true, rewrites);
          probe.stale = [...rec.own.values()]
            .filter((m) => !past(rec, x, label, m.made))
            .map((m) => ({ c: m.c, text: m.text, olds: new Set(fresh(m.olds).filter(([, , a]) => !((a || m.db === m.w) && rewrites(m))).map(([t]) => t)) }));
          replacedBy(x);
        }
        if (probe.layers) replacedBy(probe.layers.props, true);
      } catch (e) {
        err = e;
      } finally {
        SENDING.delete(ctx);
        PROBE.delete(ctx);
      }
    // Accepted, or it may have run: a later read showing its text is not behind an earlier save, and one showing a text
    // from before it may be behind it (accepted()). So for the other languages of the labels it sends back as read.
    if (asking.length && (!err || ran(err))) {
      const sentIn = asking.filter((c) => !dropped.some((r) => r.change === c));
      // So for the saver (SaveOptions.ran): a later run finding one already as asked may be finding this write.
      for (const c of sentIn) o.ran?.add(idOf(c));
      const shownMade = new Set(sentIn.filter((c) => rec.own.has(idOf(c)) && past(rec, cur, label, rec.own.get(idOf(c))!.made)));
      for (const c of sentIn) accepted(rec, c, textIn(cur, c, label), seen.get(idOf(c))!, w, false, shownMade.has(c));
      // A relationship's PUT sends every menu label back: those of the changes found already as asked or in conflict too.
      const labels = back === 'all' ? asked : back === 'labels' ? sentIn : [];
      if (labels.length)
        for (const c of labels.filter((x, j) => labels.findIndex((y) => y.slot.key === x.slot.key) === j))
          for (const [l, t] of Object.entries(toLabels(label(cur, c))))
            if (!sentIn.some((x) => x.slot.key === c.slot.key && x.lcid === Number(l)))
              accepted(rec, { ...c, lcid: Number(l), before: blank(t), after: blank(t) }, blank(t), seen.get(`${c.slot.key}#${l}`)!, w, true);
    }
    // Turned away unrun, or stopped by a read in its batch that failed: nothing was written, so again from a new read.
    if (err && i < 4 && tryAgain(err)) {
      try {
        await pause(2000 << i, o.signal);
        continue;
      } catch (a) {
        err = a;
      }
    }
    // Already as an earlier round wrote it, and this read shows that write made (sure()): it gets the check of verify().
    out.push(...found.map((r) => (r.outcome === 'unchanged' && prev?.has(r.change) ? checkWritten(prev.get(r.change)!, cur, r.change, label, rec, untouched) : r)));
    // A text already as asked confirms this page's last write there (that earlier round, or a save whose answer was lost).
    for (const r of found) if (r.outcome === 'unchanged') confirm(rec, r.change);
    if (found.some((r) => r.outcome === 'unchanged')) target(cur);
    if (!err) break;
    if (ran(err)) target(cur);
    return stop(err, asking);
  }
  if (!asking.length) return out;
  out.push(...dropped);
  const todo = asking.filter((c) => !dropped.some((r) => r.change === c));
  if (!todo.length) return out;
  target(cur);

  // Not cancellable from here on: the write happened, so its outcome must be reported.
  const raced = (now: any, rs: ChangeResult[]) => race(ctx, url, label, back, cur, now, todo, rs, probe, rec, write, layer, untouched);
  let now: any;
  try {
    now = await read();
  } catch (e) {
    return raced(null, [...out, ...todo.map((change): ChangeResult => ({ change, outcome: 'error', message: `Saved, but it could not be verified: ${sentence(problem(e))} Reload to check it.` }))]);
  }
  for (const c of todo) {
    const it = itemsOf(c).pop();
    if (it) it.read = textIn(now, c, label);
  }
  // The changes found already as asked or in conflict are in it too: the write sent their languages back as read.
  const pre = probe?.read && !probe.behind && back !== 'all' ? { x: probe.read, langs: back === 'langs' } : undefined;
  return raced(now, [...out, ...verify(cur, now, todo, label, rec, untouched, true, false, !!layer, pre)]);
}

/** Someone else's text a write replaced, as a read in its batch showed it right before the write (see race()). */
interface Hit {
  /** The change this write made in that language (own), else one of the same label. */
  c: Change;
  l: number;
  own: boolean;
  /** Their text, exactly as stored. */
  theirs: string;
  /** What this write put there instead. */
  ours: string;
  /** Seen in the solution layers (the database), so it is written back; else in the metadata read, only said. */
  db: boolean;
}
/**
 * What became of a Hit written back: theirs shows, someone saved yet another text there, or why it failed. `blind`: theirs
 * shows, but the write that put it back lost its answer, and with it the reads of its batch: a save someone made right
 * before that write can't be ruled out.
 */
type Fate = { is: 'theirs' } | { is: 'blind' } | { is: 'third'; text: string } | { is: 'failed'; why: string };
type Write = (cur: any, todo: Change[]) => Promise<ChangeResult[] | void>;

/** Conflict message of a change whose language someone else saved while it was written, theirs back on the server. */
const RACED = 'Someone else saved this text at the same moment. Theirs was put back: choose which one to keep.';
const BLIND = "Dataverse's answer to that was lost, so a save made at that moment can't be ruled out";

/**
 * What a write replaced that someone else had saved between flowOnce's read `cur` and the write, as the reads in its batch
 * show it (Probe): a language of a label it wrote, or (PUTs, UpdateStateValue) one it sent back as read. The solution layers
 * come from the database, so what they show there is written back now (theirs, every other language as the database holds
 * it, ours kept), and a change whose own language it was becomes a conflict. Without them the metadata read is the only
 * witness, and it can lag (LIVE-FINDINGS 66): what it shows is said, never written back; a text there from before one of this
 * page's own writes says nothing (the read may lag behind it), anything else does, also in a read that looks behind such a
 * write (someone may have put that text back). A read that failed leaves nothing ruled out, so no change of that label is
 * called saved.
 */
async function race(ctx: Ctx, url: string, label: LabelOf, back: Back, cur: any, now: any, todo: Change[], rs: ChangeResult[], pr: Probe | undefined, rec: Mine, write: Write, layer: LayerKind | undefined, untouched: Untouched | undefined): Promise<ChangeResult[]> {
  if (!pr || pr.read === undefined) return rs; // no write batch was sent
  // A metadata text from before one of this page's own writes that the read is not past is that read lagging, not someone
  // else's (MINE); one the read is past was put back since.
  const lagged: Ours = (is, l, _a, b) => !!pr.stale?.some((m) => m.c.lcid === l && is(m.c) && blank(b) !== m.text && m.olds.has(blank(b)));
  const readOk = pr.read !== null;
  const hits: Hit[] = [];
  const unsure = new Set<string>();
  for (const key of new Set(todo.map((c) => c.slot.key))) {
    // Also the changes of this label found already as asked (from a read that may lag) or in conflict: the write sent their
    // language back as read, so what it replaced there is checked like the edited ones.
    const cs = rs.filter((r) => r.change.slot.key === key && (todo.includes(r.change) || r.outcome === 'unchanged' || r.outcome === 'conflict')).map((r) => r.change);
    const was = toLabels(label(cur, cs[0]));
    const db = pr.layers?.props[cs[0].slot.prop];
    const seen = db ?? (readOk ? toLabels(label(pr.read, cs[0])) : null);
    if (!seen) {
      if (pr.read === null) unsure.add(key);
      continue;
    }
    const langs = back === 'langs' ? cs.map((c) => c.lcid) : [...new Set([...Object.keys(was), ...Object.keys(seen), ...cs.map((c) => String(c.lcid))].map(Number))];
    for (const l of langs) {
      if (db && !(l in db)) continue; // no layer holds it: unknown
      if (blank(seen[l]) === blank(was[l]) || (!db && lagged((x) => x.slot.key === key, l, was[l], seen[l]))) continue;
      const c = cs.find((x) => x.lcid === l);
      const ours = c && todo.includes(c) ? text(c) : blank(was[l]);
      if (blank(seen[l]) === ours) continue; // the same text: nothing replaced
      hits.push({ c: c ?? cs[0], l, own: !!c, theirs: seen[l] ?? '', ours, db: !!db });
    }
  }
  const other = back === 'all' && readOk && untouched ? untouched(cur, pr.read, todo, lagged) : '';
  if (!hits.length && !other && !unsure.size) return rs;

  const fate = new Map<Hit, Fate>();
  const fix = hits.filter((h) => h.db);
  const n = fix.length;
  if (n && layer) await putBack(ctx, url, label, cur, now, fix, fate, rec, write, layer);
  hits.push(...fix.slice(n)); // what its own writes found someone saved meanwhile
  const quote = (t: string) => (t.trim() ? `“${t}”` : 'no text');
  const why = (h: Hit) => {
    const f = fate.get(h);
    return f?.is === 'failed' ? f.why : 'Dataverse does not show it';
  };
  return rs.map((r): ChangeResult => {
    const c = r.change;
    const own = hits.find((h) => h.own && h.c === c);
    if (own) {
      const f = fate.get(own);
      if (f?.is === 'theirs') return { change: c, outcome: 'conflict', server: blank(own.theirs), message: RACED };
      if (f?.is === 'blind') return { change: c, outcome: 'conflict', server: blank(own.theirs), message: `${RACED} ${BLIND}.` };
      if (f?.is === 'third') return { change: c, outcome: 'conflict', server: f.text, message: 'Someone else saved this text at the same moment.' };
      return {
        change: c,
        outcome: 'error',
        message: own.db
          ? `Someone else saved ${quote(own.theirs)} here at the same moment, and this save replaced it; putting theirs back failed (${why(own)}). Check this text.`
          : `Dataverse showed ${quote(own.theirs)} here right before this save: someone else may have saved it at the same moment, and this save replaced it. Check this text.`,
      };
    }
    const said = hits
      .filter((h) => !h.own && h.c.slot.key === c.slot.key && fate.get(h)?.is !== 'theirs' && fate.get(h)?.is !== 'third')
      .map((h) =>
        fate.get(h)?.is === 'blind'
          ? `this save put back ${quote(h.ours)} over someone else's ${lcidName(h.l)} text ${quote(h.theirs)}; theirs is back, but ${BLIND}`
          : h.db
            ? `this save put back ${quote(h.ours)} over someone else's ${lcidName(h.l)} text ${quote(h.theirs)}, and putting theirs back failed (${why(h)})`
            : `Dataverse showed the ${lcidName(h.l)} text ${quote(h.theirs)} right before this save, so someone else may have saved it at the same moment, and this save put back ${quote(h.ours)}`,
      );
    if (other) said.push('someone else changed this relationship at the same moment, and this save may have put back what it had before');
    if (unsure.has(c.slot.key)) said.push("the label right before the save could not be read, so a save someone else made at the same moment can't be ruled out");
    // Said once the save has its answer (flow()): a change still waiting for a read that shows it keeps waiting.
    if (said.length) NOTE.set(c, [...new Set([...(NOTE.get(c) ?? []), ...said])]);
    return r;
  });
}

/** What race() found for a change besides its own language, said with its answer at the end of flow(). */
const NOTE = new WeakMap<Change, string[]>();
/** A result with what race() found for its change: never plainly saved then. */
function noted(r: ChangeResult): ChangeResult {
  const said = NOTE.get(r.change);
  if (!said || r.outcome === 'conflict') return r;
  return { change: r.change, outcome: 'error', message: r.outcome === 'error' && r.message ? `${sentence(r.message)} Also, ${said.join('; ')}.` : `Saved, but ${said.join('; ')}. Check it.` };
}

/**
 * Writes back what `hits` show someone else had saved (their texts, as the solution layers held them right before the write),
 * read from the layers again right before: a language that still holds what this write put there gets theirs, one that holds
 * theirs again needs nothing, one that holds a third text is left as it is. The PUT carries every language of each label it
 * writes as the database holds it now (finding 2), in a batch behind its own reads like any write, and this page's record
 * (MINE) learns it like its other writes. What that batch's layers show someone saved since they were read is written back
 * the same way (at most three rounds). Tried again from a new read while Dataverse turns it away; never cancelled.
 */
async function putBack(ctx: Ctx, url: string, label: LabelOf, cur: any, now: any, hits: Hit[], fate: Map<Hit, Fate>, rec: Mine, write: Write, layer: LayerKind): Promise<void> {
  const id = String(cur?.MetadataId || hits[0].c.slot.ref?.metadataId || '');
  const failed = (hs: Hit[], why: string) => {
    for (const h of hs) fate.set(h, { is: 'failed', why });
  };
  const wrote = new Set<Hit>();
  /** Written by a write whose answer was lost: its batch's reads with it (Fate `blind`). */
  const blind = new Set<Hit>();
  let todo = hits;
  for (let round = 0, busy = 0; todo.length; ) {
    if (round >= 3) {
      failed(todo, 'someone else is changing it right now');
      break;
    }
    const dn = await readLayers(ctx.http, layer, id);
    if (!dn) {
      failed(todo, 'its solution layers could not be read');
      break;
    }
    const syn: Change[] = [];
    const sending: Hit[] = [];
    for (const h of todo) {
      const held = blank(dn.props[h.c.slot.prop]?.[h.l]);
      if (held === blank(h.theirs)) fate.set(h, { is: 'theirs' });
      else if (held !== h.ours) fate.set(h, { is: 'third', text: held });
      else {
        syn.push({ slot: h.c.slot, lcid: h.l, before: h.ours, after: h.theirs });
        sending.push(h);
      }
    }
    if (!syn.length) break;
    // Every language of each label written, as the database holds it (the metadata read for one no layer holds), theirs back.
    const sent = new Map<Prop, Labels>();
    const cur2 = { ...cur };
    for (const p of new Set(syn.map((x) => x.slot.prop))) {
      const all: Labels = { ...toLabels((now ?? cur)?.[p]), ...dn.props[p] };
      cur2[p] = { LocalizedLabels: Object.entries(all).map(([l, t]) => ({ Label: t, LanguageCode: Number(l) })) };
      sent.set(p, { ...all, ...Object.fromEntries(syn.filter((x) => x.slot.prop === p).map((x) => [x.lcid, x.after])) });
    }
    const pr: Probe = { url, db: layersPath(layer, id), kind: layer };
    let err: unknown = null;
    const w = seq();
    try {
      SENDING.set(ctx, logged(cur2, syn, label));
      PROBE.set(ctx, pr);
      await write(cur2, syn);
    } catch (e) {
      err = e;
    } finally {
      SENDING.delete(ctx);
      PROBE.delete(ctx);
    }
    if (err && busy < 2 && tryAgain(err)) {
      await pause(2000 << busy++);
      continue; // from a new read of the layers
    }
    if (err && !ran(err)) {
      failed(sending, reason(err));
      break;
    }
    for (const x of syn) accepted(rec, x, x.before, [x.before], w);
    for (const h of sending) wrote.add(h);
    if (err) for (const h of sending) blind.add(h);
    // What its batch's layers show someone saved since the layers were read, this write put back too: theirs goes back next.
    const next: Hit[] = [];
    if (pr.layers)
      for (const [p, labels] of sent)
        for (const [k, t] of Object.entries(labels)) {
          const l = Number(k);
          const b = pr.layers.props[p]?.[l];
          if (b === undefined || blank(b) === blank(dn.props[p]?.[l] ?? toLabels((now ?? cur)?.[p])[l])) continue;
          const h = sending.find((x) => x.c.slot.prop === p && x.l === l);
          if (h) fate.set(h, { is: 'third', text: blank(b) });
          next.push({ c: (h ?? sending.find((x) => x.c.slot.prop === p) ?? sending[0]).c, l, own: false, theirs: b, ours: blank(t), db: true });
        }
    hits.push(...next); // the caller reports them with the change of their label
    todo = next;
    round++;
  }
  const after = wrote.size ? await readLayers(ctx.http, layer, id) : null;
  for (const h of wrote) {
    if (fate.get(h)?.is === 'third') continue;
    const x: Change = { slot: h.c.slot, lcid: h.l, before: h.ours, after: h.theirs };
    if (after && blank(after.props[h.c.slot.prop]?.[h.l]) === blank(h.theirs)) {
      fate.set(h, blind.has(h) ? { is: 'blind' } : { is: 'theirs' });
      confirm(rec, x);
      inDb(rec, x);
    } else fate.set(h, { is: 'failed', why: after ? 'Dataverse did not keep it' : 'its solution layers could not be read' });
  }
  for (const h of hits) if (!fate.has(h)) fate.set(h, { is: 'failed', why: 'someone else is changing it right now' });
}

/** The log entries (writelog.ts) of the writes each change was sent in by this save, oldest first. */
const ATTS = new WeakMap<Change, WriteAttempt[]>();
/** The log items of a change in the writes of this save it was sent in, oldest first. */
const itemsOf = (c: Change): WriteItem[] => (ATTS.get(c) || []).map((a) => a.items.find((x) => x.id === idOf(c))!).filter(Boolean);
/** A new log entry (writelog.ts) for the write of `todo` built from the read `cur`. */
function logged(cur: any, todo: Change[], label: LabelOf): WriteAttempt {
  const s = todo[0].slot;
  const a = logWrite({
    at: Date.now(),
    group: s.group,
    title: `${s.title} (${KIND_NAMES[s.kind][0].toLowerCase()})`,
    calls: [],
    items: todo.map((c) => ({ id: idOf(c), what: `${c.slot.prop}, ${lcidName(c.lcid)} (${c.lcid})`, before: textIn(cur, c, label), wrote: text(c), layers: [] })),
  });
  for (const c of todo) ATTS.set(c, [...(ATTS.get(c) || []), a]);
  return a;
}

/** verify()'s answer for one change of the write `w`, against the read `now` that shows it as written. */
function checkWritten(w: Lost, now: any, c: Change, label: LabelOf, rec: Mine, untouched?: Untouched): ChangeResult {
  return verify(w.cur, now, w.todo, label, rec, untouched, false, false, false, w.pre).find((x) => x.change === c)!;
}

/**
 * The check after a write of `todo` built from the read `cur`, against the read `now`: each change's language reads
 * as written, no other language of its label moved and `untouched` finds nothing else of the component changed (a
 * language that only shows this page's own earlier write catching up, Ours, did not move). One write applies whole, so a
 * read that shows a text it made is past it (past()); one that shows a text from before it, or from before an earlier
 * write of this page (lags()), may be behind it: there a change that reads as written but can't show it (an edit back,
 * whose text a read behind the save it undoes shows too, shown()) proves nothing and is marked LOST (see flow), as is
 * every change that reads as before. So is such a change in any later read, but not in the `first` read after the write
 * when nothing says that read is behind: a read that can't tell is taken as it is then (a save from fresh reads takes 2).
 * Nor ever when `now` is the database's own state (`db`, fromLayers): it is behind nothing. With `probe` (a writer the
 * solution layers can check), an edit back so taken from the first read is marked LOST too, its answer kept (Lost.plain):
 * a write dropped right after a save the layers confirmed (finding 62) reads so from a cache still behind that save. A
 * change saved empty (model.ts savesEmpty) that a read shows no label at all for reads as before it (unset()), as one
 * showing its old text does: only a '' stored there shows it written.
 */
function verify(cur: any, now: any, todo: Change[], label: LabelOf, rec: Mine, untouched?: Untouched, first = false, db = false, probe = false, pre?: Pre): ChangeResult[] {
  const out: ChangeResult[] = [];
  const own = ours(rec, cur, label);
  /** `c` saved empty, and `now` still has no label in its language (unset()): still as before the write. */
  const none = (c: Change) => unset(now, c, label, rec.ctx.base);
  // What the read in the write's batch (pre) already showed was someone else's save before the write: only a move that
  // neither read explains is the write's (or Dataverse's) doing.
  const moved = untouched?.(cur, now, todo, own) || '';
  const collateral = moved && pre && !untouched!(pre.x, now, todo, own) ? '' : moved;
  /** A text from before the write in `c`'s language: as read before it, or one this page's earlier writes replaced there. */
  const before = (c: Change, g: string) => g !== text(c) && (g === textIn(cur, c, label) || replaced(rec.own.get(idOf(c)), g));
  const made = past(rec, now, label, Math.max(...todo.map((c) => rec.own.get(idOf(c))?.w ?? 0)));
  // A read past the write shows it made, the changes it shows as before too (put back since, or not kept): not dropped.
  if (made) for (const c of todo) confirm(rec, c);
  const unsure =
    !db &&
    !made &&
    (!first ||
      todo.some((c) => none(c) || before(c, textIn(now, c, label))) ||
      [...rec.own.values()].some((m) => !todo.some((c) => idOf(c) === idOf(m.c)) && behindOf(rec, now, label, m)));
  const byKey = new Map<string, Change[]>();
  for (const c of todo) byKey.set(c.slot.key, [...(byKey.get(c.slot.key) || []), c]);
  for (const list of byKey.values()) {
    const exp = toLabels(label(cur, list[0]));
    for (const c of list) exp[c.lcid] = text(c);
    const got = toLabels(label(now, list[0]));
    const odd = Object.keys({ ...exp, ...got })
      .map(Number)
      .filter(
        (l) =>
          (exp[l] ?? '') !== (got[l] ?? '') &&
          !list.some((c) => c.lcid === l) &&
          !own((x) => x.slot.key === list[0].slot.key, l, exp[l], got[l]) &&
          !(pre?.langs && (toLabels(label(pre.x, list[0]))[l] ?? '') === (got[l] ?? '')),
      );
    for (const c of list) {
      const g = blank(got[c.lcid]);
      const lang = lcidName(c.lcid);
      const lost = (message: string, past = false, plain?: ChangeResult) => {
        const r: ChangeResult = { change: c, outcome: 'error', message };
        LOST.set(r, { cur, todo, past, now, plain, pre });
        out.push(r);
      };
      const unsaved = none(c);
      const nowReads = unsaved ? `there is still no ${lang} text` : `the ${lang} text ${g ? `now reads "${g}"` : 'is now empty'}`;
      const cant = `Dataverse can't confirm the ${lang} text "${g}" yet: it was also the text before your last save of it`;
      if (unsaved || before(c, g)) lost(made ? `Dataverse did not keep this change: ${nowReads}. Reload and try again.` : g ? `Dataverse still shows the old ${lang} text "${g}"` : `Dataverse still shows no ${lang} text`, made);
      else if (g === text(c) && unsure && !shown(rec, now, c, label)) lost(cant);
      else if (g !== text(c)) out.push({ change: c, outcome: 'error', message: `Dataverse did not keep this change: ${nowReads}. Reload and try again.` });
      else {
        const r: ChangeResult = odd.length
          ? { change: c, outcome: 'error', message: `Saved, but Dataverse also changed ${odd.map((l) => `the ${lcidName(l)} text to "${got[l] ?? ''}"`).join(', ')}. Check those languages.` }
          : collateral
            ? { change: c, outcome: 'error', message: collateral }
            : { change: c, outcome: 'saved' };
        // An edit back the first read can't show made (shown()): the layers are asked first (byLayers).
        if (probe && !db && !made && since(rec.own.get(idOf(c)), g) && !shown(rec, now, c, label)) lost(cant, false, r);
        else {
          confirm(rec, c);
          out.push(r);
        }
      }
    }
  }
  return out;
}

/** What a metadata writer reads right before writing, and where a change's label is in that read. */
interface Source {
  url: string;
  label: LabelOf;
  /** Why the read shows no such label any more ('' when it does): its save refuses the change, its read() says so. */
  gone?: (cur: any) => string;
}
const ownLabel: LabelOf = (cur, c) => cur[c.slot.prop];
const entitySource = (cs: Change[]): Source => ({
  url: `${entityPath(cs[0].slot.ref.entity)}?$select=LogicalName,DisplayName,DisplayCollectionName,Description,IsRenameable,IsCustomizable,IsManaged`,
  label: ownLabel,
});
const attributeSource = (cs: Change[]): Source => ({
  url: `${attrPath(cs[0].slot.ref.entity, cs[0].slot.ref.attribute)}?$select=LogicalName,DisplayName,Description,IsRenameable,IsCustomizable,IsManaged,AttributeType,AttributeTypeName`,
  label: ownLabel,
});
const globalSetSource = (cs: Change[]): Source => ({
  url: `GlobalOptionSetDefinitions(Name='${q(cs[0].slot.ref.name)}')?$select=MetadataId,Name,DisplayName,Description,IsCustomizable,IsManaged`,
  label: ownLabel,
});
function optionSource(cs: Change[]): Source & { opt: (cur: any) => any; gone: (cur: any) => string } {
  const { kind, ref: r } = cs[0].slot;
  // ref.cast is set by this module's loader; the kind decides for refs built elsewhere.
  const cast = r.cast || ({ status: 'Status', state: 'State', boolean: 'Boolean' } as Record<string, string>)[kind] || 'Picklist';
  const url =
    kind === 'globaloption'
      ? `GlobalOptionSetDefinitions(Name='${q(r.name)}')`
      : `${attrPath(r.entity, r.attribute)}/${T}${cast}AttributeMetadata?$select=LogicalName,IsCustomizable,IsManaged&$expand=OptionSet`;
  const opt = (cur: any) => opts(cur.OptionSet || cur).find((x) => x.Value === r.value);
  return { url, label: (cur, c) => opt(cur)?.[c.slot.prop], opt, gone: (cur) => (opt(cur) ? '' : 'This choice option no longer exists. Reload to see the current options.') };
}
function relationshipSource(cs: Change[]): Source & { menu: (c: Change) => string } {
  const { metadataId: id, type } = cs[0].slot.ref;
  const menu = (c: Change) => (type === 'ManyToMany' ? `Entity${c.slot.ref.side}AssociatedMenuConfiguration` : MENUS[0]);
  return { url: `RelationshipDefinitions(${id})/${T}${type}RelationshipMetadata`, label: (cur, c) => cur[menu(c)]?.Label, menu };
}

/**
 * A metadata writer's read(): the strong read its save makes before writing, and nothing else. A read behind this page's
 * own last write of a change's language (behindOf: it shows a text from before that write, LIVE-FINDINGS 66) is read
 * again after each of SETTLE_WAITS, as flowOnce waits before writing, and never given as the text there: a publish undone
 * at once would read as already undone, which its save then writes. Still behind after the waits, that change is an Error.
 */
const reader =
  (source: (cs: Change[]) => Source): NonNullable<Writer['read']> =>
  async (ctx, changes, o) => {
    const { url, label, gone } = source(changes);
    for (let i = 0; ; i++) {
      const cur = await ctx.http.get(url, { headers: STRONG, signal: o.signal });
      const why = gone?.(cur);
      if (why) return new Map(changes.map((c): [string, Error] => [idOf(c), new Error(why)]));
      const rec = mine(ctx, url, changes[0].slot.group);
      // As flowOnce's `rewrites`: a change that writes this page's own last text there again is not held up by its predecessor.
      const late = new Set(changes.filter((c) => {
        const m = rec.own.get(idOf(c));
        return !!m && behindOf(rec, cur, label, m, m.text === text(c));
      }));
      if (late.size && i < SETTLE_WAITS.length) {
        await pause(SETTLE_WAITS[i], o.signal);
        continue;
      }
      return new Map(changes.map((c): [string, string | Error] => [idOf(c), late.has(c) ? new Error("Dataverse doesn't show your last change to it yet") : toLabels(label(cur, c))[c.lcid] ?? '']));
    }
  };

function saveEntity(ctx: Ctx, changes: Change[], o: SaveOptions): Promise<ChangeResult[]> {
  const e: string = changes[0].slot.ref.entity;
  const path = entityPath(e);
  const { url, label } = entitySource(changes);
  return flow(ctx, changes, o, url, label, guard('table'), () => o.publish.entities.add(e), async (cur, todo) => {
    // One PUT per table (each costs ~6 s server-side), all edited properties together.
    await put(ctx, path, { '@odata.type': T + 'EntityMetadata', LogicalName: cur.LogicalName, ...props(cur, todo) });
  }, 'labels', keep((x, p) => x[p], ['DisplayName', 'DisplayCollectionName', 'Description']), 'Entity');
}

function saveAttribute(ctx: Ctx, changes: Change[], o: SaveOptions): Promise<ChangeResult[]> {
  const { entity: e, attribute: a, odataType } = changes[0].slot.ref;
  const path = attrPath(e, a);
  const { url, label } = attributeSource(changes);
  return flow(ctx, changes, o, url, label, guard('column'), () => o.publish.entities.add(e), async (cur, todo) => {
    // The derived type is required; OptionSet / GlobalOptionSet are never sent (options have their own actions).
    const type = String(cur['@odata.type'] || odataType || T + 'AttributeMetadata').replace('#', '');
    // LookupAttributeMetadata also stands for Owner and Customer columns: without their AttributeType Dataverse
    // takes the column for a plain Lookup and refuses the write (finding 59).
    const kind = /LookupAttributeMetadata$/.test(type) && cur.AttributeType ? { AttributeType: cur.AttributeType, AttributeTypeName: cur.AttributeTypeName } : {};
    await put(ctx, path, { '@odata.type': type, LogicalName: cur.LogicalName, ...kind, ...props(cur, todo) });
  }, 'labels', keep((x, p) => x[p], ['DisplayName', 'Description']), 'Attribute');
}

function saveGlobalSet(ctx: Ctx, changes: Change[], o: SaveOptions): Promise<ChangeResult[]> {
  const { name, boolean } = changes[0].slot.ref;
  const { url, label } = globalSetSource(changes);
  return flow(ctx, changes, o, url, label, guard('global choice'), () => o.publish.optionsets.add(name), async (cur, todo) => {
    const type = String(cur['@odata.type'] || `${T}${boolean ? 'Boolean' : ''}OptionSetMetadata`).replace('#', '');
    // Sparse, like the SDK's own "update a global option set" sample (Name, IsGlobal and the edited labels).
    // This request never changes the options themselves; those go through UpdateOptionValue.
    await put(ctx, `GlobalOptionSetDefinitions(${guid(cur.MetadataId)})`, { '@odata.type': type, Name: cur.Name, IsGlobal: true, ...props(cur, todo) });
  }, 'labels', keep((x, p) => x[p], ['DisplayName', 'Description']), 'OptionSet');
}

/** Local choice, status reason, status, Yes/No and global choice options. */
function saveOption(ctx: Ctx, changes: Change[], o: SaveOptions): Promise<ChangeResult[]> {
  const { kind, ref: r } = changes[0].slot;
  const global = kind === 'globaloption';
  const state = kind === 'state';
  const { url, label, opt, gone } = optionSource(changes);
  const kept = keep((x, p) => opt(x)?.[p], ['Label', 'Description']);
  return flow(
    ctx,
    changes,
    o,
    url,
    label,
    (cur, c) => gone(cur) || guard(global ? 'global choice' : 'choice column')(cur, c),
    () => (global ? o.publish.optionsets.add(r.name) : o.publish.entities.add(r.entity)),
    async (cur, todo) => {
      const op = opt(cur);
      const of = (p: Prop) => todo.filter((c) => c.slot.prop === p);
      const labels = of('Label');
      const descriptions = of('Description');
      const body: Record<string, unknown> = global ? { OptionSetName: r.name } : { EntityLogicalName: r.entity, AttributeLogicalName: r.attribute };
      body.Value = r.value;
      let dropped: ChangeResult[] = [];
      // Label and Description are both optional: an action without one leaves it exactly as it is, in every
      // language (verified for both actions, findings 35 and 36), so a description-only edit sends no Label.
      if (state) {
        // Like the metadata PUTs, each label UpdateStateValue carries holds every language now on the server:
        // it can't hit the base-language overwrite trap (finding 2), and under MergeLabels the unchanged
        // languages are rewritten with their own text.
        if (labels.length) body.Label = complete(op.Label, labels);
        if (descriptions.length) body.Description = complete(op.Description, descriptions);
        // Passing the current default status with a label keeps UpdateStateValue from resetting it; a
        // description-only call leaves it as it is without one (finding 36).
        if (labels.length && op.DefaultStatus != null) body.DefaultStatusCode = op.DefaultStatus;
        body.MergeLabels = true;
        const pr = PROBE.get(ctx);
        try {
          await action(ctx, 'UpdateStateValue', body);
        } catch (e) {
          // Microsoft documents Description for UpdateStateValue; if this org's action has no such parameter,
          // the request was rejected before anything was written, so the label edits are sent on their own.
          if (!descriptions.length || !unknownParameter(e, 'Description')) throw e;
          dropped = descriptions.map((change): ChangeResult => ({ change, outcome: 'error', message: STATE_DESCRIPTION }));
          if (!labels.length) return dropped;
          delete body.Description;
          await action(ctx, 'UpdateStateValue', body);
        }
        if (labels.length) await keepDefault(ctx, url, opt, label, r.entity, body, pr, todo, cur);
      } else {
        // UpdateOptionValue merges per language, so only the changed languages are sent (verified, finding 5).
        if (labels.length) body.Label = fromChanges(edits(labels));
        if (descriptions.length) body.Description = fromChanges(edits(descriptions));
        body.MergeLabels = true;
        await action(ctx, 'UpdateOptionValue', body);
      }
      return dropped;
    },
    state ? 'labels' : 'langs',
    // Whichever of Label and Description was not edited must read back unchanged; a state's default status reason too.
    state ? (cur, now, todo, ours) => kept(cur, now, todo, ours) || defaultMoved(opt(cur)?.DefaultStatus, opt(now)?.DefaultStatus) : kept,
  );
}

/** Post-write check of a state: its default status reason reads back as before the write ('' when it does or can't tell). */
const defaultMoved = (a: unknown, b: unknown): string =>
  a != null && b != null && a !== b ? `Saved, but this status's default status reason changed too (value ${a} before this save, ${b} now). Check it.` : '';

/**
 * UpdateStateValue sets the state's default status reason to the DefaultStatusCode it carries: flowOnce's read of it, as a
 * label sent without one could reset it. One someone else set after that read shows in the read in the write's batch
 * (`pr`, right before the write), and the write replaced it: theirs is put back, in a batch behind
 * a read like any write, with the labels this write just sent (no Description: left as it is, finding 36), unless a read
 * shows another default since (someone else's, newer: left as it is). A label text that read shows someone else saved
 * since the write goes back as they saved it, never the text from before; one only the put-back's own batch read shows is
 * said. Options have no solution layers, so those reads are the only witness, and they can lag (LIVE-FINDINGS 66): one
 * behind this page's own write (lags()) is said, never written back. Whatever happens is said with the write's changes
 * (NOTE), never plainly saved. Never cancelled.
 */
async function keepDefault(ctx: Ctx, url: string, opt: (x: any) => any, label: LabelOf, entity: string, body: Record<string, unknown>, pr: Probe | undefined, todo: Change[], cur: any): Promise<void> {
  const theirs: number | undefined = pr?.read ? opt(pr.read)?.DefaultStatus : undefined;
  const ours = body.DefaultStatusCode as number | undefined;
  if (theirs == null || theirs === ours) return;
  const say = (s: string) => {
    for (const c of todo) NOTE.set(c, [...new Set([...(NOTE.get(c) ?? []), s])]);
  };
  const n = await reasonNames(ctx, entity);
  const sent = ours == null ? 'this save may have reset it' : `this save set it back to ${n(ours)}`;
  // As flowOnce's `rewrites`: this write's own text again is no sign of a lagging read.
  const rec = mine(ctx, url, todo[0].slot.group);
  if (lags(rec, pr!.read, label, () => true, (m) => todo.some((c) => idOf(c) === idOf(m.c) && text(c) === m.text)))
    return say(`Dataverse showed the default status reason ${n(theirs)} right before this save, so someone else may have changed it at the same moment, and ${sent}`);
  const was = `someone else set this status's default status reason to ${n(theirs)} at the same moment, and ${sent}`;
  const read = (): Promise<any> => ctx.http.get(url, { headers: STRONG }).then((x) => opt(x), () => undefined);
  // The label as this write sent it. A text a later read shows that no read behind the write could (as sent, as read
  // before it, as in its batch, one this page's own writes replaced) is someone else's since the write.
  const key = todo.find((c) => c.slot.prop === 'Label')!.slot.key;
  const wrote = toLabels(body.Label as Label);
  const known = [wrote, toLabels(opt(cur)?.Label), toLabels(opt(pr!.read)?.Label)];
  const newer = (l: number, t: string | undefined): boolean => !!blank(t) && known.every((k) => blank(t) !== blank(k[l])) && !replaced(rec.own.get(`${key}#${l}`), blank(t));
  const quote = (t: string | undefined) => (blank(t) ? `“${t}”` : 'no text');
  for (let i = 0; ; i++) {
    const x = await read();
    const d: number | undefined = x?.DefaultStatus;
    if (d != null && d !== ours && d !== theirs) return say(`${was}; it now shows ${n(d)}, so it was left as it is`);
    const now = toLabels(x?.Label);
    const put: Labels = { ...wrote };
    for (const l of Object.keys(wrote).map(Number)) if (newer(l, now[l])) put[l] = now[l];
    const back: Record<string, unknown> = { ...body, Label: fromChanges(Object.entries(put).map(([l, t]) => ({ lcid: Number(l), text: t }))), DefaultStatusCode: theirs };
    delete back.Description;
    const p: Probe = { url, db: '' };
    let err: unknown = null;
    PROBE.set(ctx, p);
    try {
      await action(ctx, 'UpdateStateValue', back);
    } catch (e) {
      err = e;
    } finally {
      if (pr) PROBE.set(ctx, pr);
    }
    if (err && tryAgain(err) && i < 2) {
      await pause(2000 << i);
      continue;
    }
    if (err && !ran(err)) return say(`${was}; putting theirs back failed (${reason(err)})`);
    // A read right after it may still show the default from before it (LIVE-FINDINGS 66): read again for a moment.
    let v: number | undefined;
    for (const ms of [0, ...CONFLICT_WAITS]) {
      if (ms) await pause(ms);
      v = (await read())?.DefaultStatus;
      if (v != null && v !== ours) break;
    }
    const z: number | undefined = p.read ? opt(p.read)?.DefaultStatus : undefined;
    const third = z != null && z !== ours && z !== theirs ? `, but putting it back replaced ${n(z)}, which someone else saved right then` : '';
    // What its own batch read shows someone else saved in a language it sent after the read before it: replaced, said.
    const pl = p.read ? toLabels(opt(p.read)?.Label) : {};
    const over = Object.keys(put)
      .map(Number)
      .filter((l) => blank(pl[l]) !== blank(put[l]) && newer(l, pl[l]))
      .map((l) => `; putting it back also put back ${quote(put[l])} over someone else's ${lcidName(l)} text ${quote(pl[l])}`)
      .join('');
    if (v === theirs) return say(err ? `${was}; theirs is back, but Dataverse's answer to that was lost, so a save made at that moment can't be ruled out` : `${was}; theirs is back${third}${over}`);
    return say(v != null && v !== ours ? `${was}; theirs was put back, but it now shows ${n(v)}${over}` : `${was}; putting theirs back could not be confirmed${over}`);
  }
}

/** The names of a table's status reasons in the user's language, for messages: “Open” (1), or the value alone. */
async function reasonNames(ctx: Ctx, entity: string): Promise<(v: number) => string> {
  const os: any[] = await ctx.http
    .get(`${attrPath(entity, 'statuscode')}/${T}StatusAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`)
    .then((x) => opts(x?.OptionSet), () => []);
  return (v) => {
    const t = pick(toLabels(os.find((o) => o?.Value === v)?.Label), ctx.user, ctx.base);
    return t ? `“${t}” (${v})` : String(v);
  };
}

/** Every language of a label as it is now with the changed ones replaced, as plain text/language pairs for an action. */
function complete(label: Label | null | undefined, cs: Change[]): Label {
  const all = toLabels(label);
  for (const c of cs) all[c.lcid] = text(c);
  return fromChanges(Object.entries(all).map(([l, t]) => ({ lcid: Number(l), text: t })));
}

/** Relationship menu labels; N:N sides share one group, so both go out in one PUT. */
function saveRelationship(ctx: Ctx, changes: Change[], o: SaveOptions): Promise<ChangeResult[]> {
  const { metadataId: id, type } = changes[0].slot.ref;
  const t = `${T}${type}RelationshipMetadata`;
  const { url, label, menu } = relationshipSource(changes);
  return flow(ctx, changes, o, url, label, guard('relationship'), (cur) => {
    for (const e of [cur.ReferencedEntity, cur.ReferencingEntity, cur.Entity1LogicalName, cur.Entity2LogicalName]) if (e) o.publish.entities.add(e);
  }, async (cur, todo) => {
    // The full definition as just read (Microsoft's documented way to update a relationship): Behavior,
    // Group, Order, CascadeConfiguration and every other field go back exactly as they are; only the menu
    // labels change, each carrying all of its current languages (finding 2).
    const body = { ...stripAnnotations(cur), '@odata.type': t };
    for (const k of MENUS) {
      const cs = todo.filter((c) => menu(c) === k);
      if (cur[k] && (cur[k].Label || cs.length)) body[k] = { ...body[k], Label: merged(cur[k].Label, cs) };
    }
    await put(ctx, `RelationshipDefinitions(${id})`, body);
  }, 'all', (cur, now, todo, ours) => {
    // Everything sent back as read must read back the same: the menu settings, the cascade rules and the
    // menu label of an N:N side nobody edited.
    const settings = (x: any) => JSON.stringify([x.CascadeConfiguration, ...MENUS.map((k) => x[k] && { ...x[k], Label: undefined })]);
    if (settings(cur) !== settings(now)) return "Saved, but Dataverse also changed this relationship's menu or cascade settings. Check the relationship in the maker portal.";
    const other = MENUS.filter(
      (k) => cur[k] && !todo.some((c) => menu(c) === k) && moved(cur[k].Label, now[k]?.Label).some((l) => !ours((c) => menu(c) === k, l, toLabels(cur[k].Label)[l], toLabels(now[k]?.Label)[l])),
    );
    return other.length ? "Saved, but Dataverse also changed the relationship's menu label on the other table. Check it." : '';
  });
}

export const metadataWriters: Writer[] = [
  { kinds: ['entity'], lane: 'metadata', save: saveEntity, read: reader(entitySource) },
  { kinds: ['attribute'], lane: 'metadata', save: saveAttribute, read: reader(attributeSource) },
  { kinds: ['option', 'status', 'state', 'boolean', 'globaloption'], lane: 'metadata', save: saveOption, read: reader(optionSource) },
  { kinds: ['globaloptionset'], lane: 'metadata', save: saveGlobalSet, read: reader(globalSetSource) },
  { kinds: ['relationship'], lane: 'metadata', save: saveRelationship, read: reader(relationshipSource) },
];
