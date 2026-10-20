// Localizable record columns: view, chart, form and dashboard names, apps, BPF names, modern
// commands, environment variables and custom APIs. Read with RetrieveLocLabels (every language,
// unpublished included), written with SetLocLabels. SetLocLabels merges by language (finding 21) and
// an empty label deletes that language (finding 33), so clearing a translation sends '' for it and
// expects the language to be gone afterwards. Every write sends only the edited languages, checked against
// a read made immediately before it; one Dataverse turned away unrun (throttled, or the customization lock)
// is tried again from a new read, never resent. The base language can never be blank.
//
// SetLocLabels takes no If-Match, so the write goes in one $batch between two reads of the label (Dataverse runs
// the parts in order): the first shows exactly what the write replaced, so a text someone else saved after the
// writer's own read is put back and reported as a conflict, never silently overwritten.

import { batchGet } from '../core/batch';
import type { Ctx } from '../core/context';
import { DvError, guid, isAbort, mayHaveRun, partError, pause, q, turnedAway, type BatchPart, type PartResult } from '../core/http';
import { pick, toLabels, type Label } from '../core/labels';
import { lcidName } from '../core/lcid';
import { KIND_NAMES, MANAGED, PROP_NAMES, isManaged, slotKey, type Change, type ChangeResult, type Kind, type Labels, type Outcome, type Prop, type Slot } from '../core/model';
import { changeId, check, type CommandInfo, type FormRef, type LoadOptions, type Loader, type ServerTexts, type SolutionInfo, type Writer } from './types';

type RecKind = 'view' | 'chart' | 'form' | 'dashboard' | 'app' | 'bpf' | 'command' | 'envvar' | 'customapi';

interface Def {
  table: string;
  set: string;
  pk: string;
  /** Columns read when listing. */
  sel: string;
  /** Column holding the related table's logical name. */
  ent?: string;
  /** Server-side filter used when listing. */
  filter?: string;
  /** [prop, column, max length (0 = unknown)] */
  props: Array<[Prop, string, number]>;
}

/** `slot.ref` of every slot made here. */
interface Ref {
  id: string;
  table: string;
  entitySet: string;
  column: string;
  entity: string;
  /** querytype (views), form type (forms, dashboards), location (commands). */
  type?: number;
  managed: boolean;
  /** appmoduleid of an app-scoped command. */
  app?: string;
}

const named = (max: number, desc = 2000): Def['props'] => [
  ['Name', 'name', max],
  ['Description', 'description', desc],
];
const form = (filter: string): Def => ({
  table: 'systemform',
  set: 'systemforms',
  pk: 'formid',
  sel: 'formid,name,type,objecttypecode,iscustomizable,ismanaged',
  ent: 'objecttypecode',
  filter,
  props: named(100),
});

const DEFS: Record<RecKind, Def> = {
  view: {
    table: 'savedquery',
    set: 'savedqueries',
    pk: 'savedqueryid',
    sel: 'savedqueryid,name,querytype,returnedtypecode,iscustomizable,ismanaged',
    ent: 'returnedtypecode',
    // Offline filters, the field-translation export view and the internal email/workflow/Outlook templates never show in the app.
    filter: 'querytype ne 16 and querytype ne 2048 and querytype ne 8192 and querytype ne 65536 and querytype ne 131072',
    props: named(200),
  },
  chart: {
    table: 'savedqueryvisualization',
    set: 'savedqueryvisualizations',
    pk: 'savedqueryvisualizationid',
    sel: 'savedqueryvisualizationid,name,primaryentitytypecode,iscustomizable,ismanaged',
    ent: 'primaryentitytypecode',
    props: named(200),
  },
  form: form('type eq 2 or type eq 6 or type eq 7 or type eq 11 or type eq 12'),
  dashboard: form('type eq 0 or type eq 10'),
  app: { table: 'appmodule', set: 'appmodules', pk: 'appmoduleid', sel: 'appmoduleid,appmoduleidunique,name,uniquename,ismanaged', props: named(100) },
  bpf: {
    table: 'workflow',
    set: 'workflows',
    pk: 'workflowid',
    sel: 'workflowid,name,uniquename,primaryentity,iscustomizable,ismanaged',
    ent: 'primaryentity',
    filter: 'category eq 4 and type eq 1',
    props: named(100, 0),
  },
  command: {
    table: 'appaction',
    set: 'appactions',
    pk: 'appactionid',
    sel: 'appactionid,name,uniquename,location,contextvalue,_appmoduleid_value,type,iscustomizable,ismanaged',
    ent: 'contextvalue',
    props: [
      ['Label', 'buttonlabeltext', 256],
      ['ToolTipTitle', 'buttontooltiptitle', 256],
      ['ToolTipDescription', 'buttontooltipdescription', 500],
      ['Alt', 'buttonaccessibilitytext', 256],
      ['Title', 'grouptitle', 256],
    ],
  },
  envvar: {
    table: 'environmentvariabledefinition',
    set: 'environmentvariabledefinitions',
    pk: 'environmentvariabledefinitionid',
    sel: 'environmentvariabledefinitionid,schemaname,displayname,iscustomizable,ismanaged',
    props: [
      ['DisplayName', 'displayname', 100],
      ['Description', 'description', 2000],
      ['Hint', 'hint', 2000],
    ],
  },
  customapi: {
    table: 'customapi',
    set: 'customapis',
    pk: 'customapiid',
    sel: 'customapiid,uniquename,displayname,boundentitylogicalname,iscustomizable,ismanaged',
    ent: 'boundentitylogicalname',
    props: [
      ['DisplayName', 'displayname', 100],
      ['Description', 'description', 300],
    ],
  },
};
const KINDS = Object.keys(DEFS) as RecKind[];
/** Kinds narrowed by the scope's solution; views, charts and forms follow the scope's tables instead. */
const SOLUTION_AWARE = new Set<Kind>(['dashboard', 'app', 'bpf', 'command', 'envvar', 'customapi']);

const QUERY_TYPES: Record<number, string> = {
  0: 'Public view',
  1: 'Advanced find view',
  2: 'Associated view',
  4: 'Quick find view',
  8: 'Reporting view',
  64: 'Lookup view',
  128: 'Appointment book view',
  256: 'Outlook filter',
  512: 'Address book filter',
  1024: 'Main application view',
  4096: 'Dialog view',
  16384: 'Custom view',
};
const FORM_TYPES: Record<number, string> = {
  0: 'Dashboard',
  2: 'Main form',
  6: 'Quick view form',
  7: 'Quick create form',
  10: 'Interactive dashboard',
  11: 'Card form',
  12: 'Main form (interactive)',
};
const LOCATIONS = ['Form', 'Main grid', 'Subgrid', 'Associated grid', 'Quick form', 'Global header', 'Dashboard'];

const chunks = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const or = (col: string, vals: string[]) => vals.map((v) => `${col} eq ${v}`).join(' or ');
const str = (v: string) => `'${encodeURIComponent(q(v))}'`;
const isGuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
const locPath = (ctx: Ctx, set: string, id: string, column: string) =>
  ctx.http.fn('RetrieveLocLabels', { EntityMoniker: { '@odata.id': `${set}(${id})` }, AttributeName: column, IncludeUnpublished: true });
// A record from a managed solution is read-only, whatever its managed properties allow: a translation would be an
// unmanaged layer on top of it (MANAGED). Managed properties only bind managed layers, so an unmanaged record stays
// editable in its own org.
const locked = (r: any) => r?.ismanaged === true;
const why = (e: unknown) => {
  const m = (e as Error)?.message || String(e);
  return /0x80071151|Cannot start another/i.test(m) ? 'Dataverse is busy with another customization. Your edits are still pending — try Save again in a minute.' : m;
};

/** Ends a server message with a full stop so more text can follow it. */
const sentence = (m: string): string => (/[.!?]$/.test(m.trim()) ? m.trim() : `${m.trim()}.`);

/** Labels as loaded: a label stored as '' is treated as missing (it is not a translation). */
function stored(label: Label | null | undefined): Labels {
  const out = toLabels(label);
  for (const l of Object.keys(out)) if (out[Number(l)] === '') delete out[Number(l)];
  return out;
}

// ---- Lookups ----

export async function listSolutions(ctx: Ctx, signal?: AbortSignal): Promise<SolutionInfo[]> {
  const rows = await ctx.http.all(
    "solutions?$select=solutionid,uniquename,friendlyname,ismanaged,version&$expand=publisherid($select=friendlyname)&$filter=isvisible eq true and uniquename ne 'Default' and uniquename ne 'Active'",
    { signal },
  );
  return rows
    .map((r) => ({ id: guid(r.solutionid), uniqueName: r.uniquename, name: r.friendlyname || r.uniquename, managed: !!r.ismanaged, version: r.version || '', publisher: r.publisherid?.friendlyname || '' }))
    .sort((a, b) => +a.managed - +b.managed || a.name.localeCompare(b.name));
}

/**
 * Modern commands by appaction.name. Editing a table or global command in the designer makes an
 * app-scoped copy with the same name, so per name the narrowest scope wins: this app > this table > global.
 */
export async function findCommands(ctx: Ctx, names: string[], appId: string, entity: string, signal?: AbortSignal): Promise<CommandInfo[]> {
  const app = guid(appId);
  const pages = await Promise.all(
    chunks([...new Set(names.filter(Boolean))], 20).map((c) =>
      ctx.http.all(`appactions?$select=appactionid,name,location,contextvalue,_appmoduleid_value,context&$filter=${or('name', c.map(str))}`, { signal }),
    ),
  );
  const rank = (r: any) => {
    const a = guid(r._appmoduleid_value);
    if (a) return a === app ? 3 : 0;
    if (r.context === 1 || r.contextvalue) return r.contextvalue === entity ? 2 : 0;
    return 1;
  };
  const best = new Map<string, [number, any]>();
  for (const r of pages.flat()) {
    const k = rank(r);
    if (k > (best.get(r.name)?.[0] ?? 0)) best.set(r.name, [k, r]);
  }
  return [...best.values()].map(([, r]) => ({ id: guid(r.appactionid), name: r.name, location: r.location ?? -1, entity: r.contextvalue || '', appId: guid(r._appmoduleid_value) }));
}

export async function getForm(ctx: Ctx, formId: string, signal?: AbortSignal): Promise<FormRef | null> {
  const id = guid(formId);
  if (!isGuid(id)) return null;
  try {
    const r = await ctx.http.get(`systemforms(${id})?$select=formid,name,type,objecttypecode`, { signal });
    return { formId: guid(r.formid), entity: r.objecttypecode || 'none', name: r.name || '', type: Number(r.type) };
  } catch (e) {
    if (e instanceof DvError && e.status === 404) return null;
    throw e;
  }
}

/**
 * The query (fetch XML) of a system or personal view, '' when it has none or is gone: a grid's linked-table columns
 * are named by their alias in it (LIVE-FINDINGS 57).
 */
export async function viewQuery(ctx: Ctx, viewId: string, signal?: AbortSignal): Promise<string> {
  const id = guid(viewId);
  if (!isGuid(id)) return '';
  for (const set of ['savedqueries', 'userqueries'])
    try {
      return String((await ctx.http.get(`${set}(${id})?$select=fetchxml`, { signal })).fetchxml || '');
    } catch (e) {
      if (!(e instanceof DvError && e.status === 404)) throw e;
    }
  return '';
}

// ---- Loading ----

/** Records by id (inspector). Unknown ids are ignored; records from a managed solution come back read-only. */
export async function loadRecords(ctx: Ctx, kind: Kind, ids: string[], o: LoadOptions): Promise<Slot[]> {
  const d = DEFS[kind as RecKind];
  if (!d) throw new Error(`${KIND_NAMES[kind]?.[1] || kind} are not record labels.`);
  const want = [...new Set(ids.map(guid))].filter(isGuid);
  const pages = await Promise.all(chunks(want, 50).map((c) => ctx.http.all(`${d.set}?$select=${d.sel}&$filter=${or(d.pk, c)}`, { signal: o.signal })));
  return build(ctx, pages.flat().map((r) => [kind as RecKind, r]), o);
}

export const loadRecordsScope: Loader = async (ctx, scope, o) => {
  const kinds = KINDS.filter((k) => scope.kinds.has(k));
  if (!kinds.length) return [];
  // Duplicates across request chunks would produce duplicate slot keys.
  const ents = [...new Set(scope.entities)];
  const sol =
    scope.solutionId && kinds.some((k) => SOLUTION_AWARE.has(k))
      ? new Set((await ctx.http.all(`solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${guid(scope.solutionId)}`, { signal: o.signal })).map((r) => guid(r.objectid)))
      : null;
  o.progress(`Loading ${kinds.map((k) => KIND_NAMES[k][1].toLowerCase()).join(', ')}`);
  // One failing kind (missing table, no read privilege) must not hide the others.
  const errors: string[] = [];
  const lists = await Promise.all(
    kinds.map(async (kind): Promise<Array<[RecKind, any]>> => {
      const d = DEFS[kind];
      const aware = SOLUTION_AWARE.has(kind);
      // Views, charts and forms follow the scope's tables; so do BPFs and commands unless a solution narrows them.
      const by = !aware || (!sol && (kind === 'bpf' || kind === 'command') && ents.length) ? ents : null;
      if (by && !by.length) return [];
      const url = (extra?: string) => `${d.set}?$select=${d.sel}` + (d.filter || extra ? `&$filter=${[d.filter, extra].filter(Boolean).map((f) => `(${f})`).join(' and ')}` : '');
      try {
        const rows = by
          ? (await Promise.all(chunks(by, 20).map((c) => ctx.http.all(url(or(d.ent!, c.map(str))), { signal: o.signal })))).flat()
          : await ctx.http.all(url(), { signal: o.signal });
        // Solution components are matched by id, so new component type codes need no mapping (apps may be listed by either id).
        return rows
          .filter((r) => (scope.includeReadOnly || !locked(r)) && (!aware || !sol || [d.pk, 'appmoduleidunique'].some((k) => sol.has(guid(r[k])))))
          .map((r) => [kind, r]);
      } catch (e) {
        if (isAbort(e)) throw e;
        errors.push(`${KIND_NAMES[kind][1]}: ${why(e)}`);
        return [];
      }
    }),
  );
  if (errors.length === kinds.length) throw new Error(`Could not load ${errors.join('; ')}`);
  const slots = await build(ctx, lists.flat(), o);
  if (errors.length) o.progress(`Loaded with problems. ${errors.join('; ')}`);
  return slots;
};

/** Reads every label of the given records (one batched RetrieveLocLabels per column) and makes the slots. */
async function build(ctx: Ctx, items: Array<[RecKind, any]>, o: LoadOptions): Promise<Slot[]> {
  const recs = items
    .map(([kind, row]) => {
      const d = DEFS[kind];
      const e = d.ent ? row[d.ent] : '';
      const type: number | undefined = kind === 'view' ? row.querytype : kind === 'command' ? row.location : kind === 'form' || kind === 'dashboard' ? row.type : undefined;
      // Command groups have only a title; buttons have a label, tooltip and accessibility text.
      const props = kind === 'command' ? (row.type === 3 ? d.props.slice(4) : d.props.slice(0, 4)) : d.props;
      const name = String((kind === 'command' ? String(row.name || '').split('!')[0] : row.name || row.displayname) || row.schemaname || row.uniquename || '');
      return { kind, row, d, id: guid(row[d.pk]), ent: e && e !== 'none' ? String(e) : '', type, props, name };
    })
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.ent.localeCompare(b.ent) || (a.type ?? 0) - (b.type ?? 0) || a.name.localeCompare(b.name));
  if (!recs.length) return [];

  const paths = recs.flatMap((r) => r.props.map(([, col]) => locPath(ctx, r.d.set, r.id, col)));
  const [res, tables] = await Promise.all([
    batchGet<{ Label?: Label }>(ctx.http, paths, o.signal, (n, t) => o.progress('Reading translations', n, t)),
    tableNames(ctx, [...new Set(recs.map((r) => r.ent).filter(Boolean))], o.signal),
  ]);
  // Nothing readable at all is a systemic problem (session, permissions), not a per-record one.
  if (res.every((x) => !x.ok)) throw new DvError(`Could not read the translations: ${res[0].error || 'unknown error'}`, res[0].status);

  let k = 0;
  return recs.flatMap((r, i) => {
    const got = r.props.map(() => res[k++]);
    const labels = got.map((x): Labels => (x.ok ? stored(x.data?.Label) : {}));
    const { kind, row } = r;
    const sub =
      kind === 'view'
        ? QUERY_TYPES[row.querytype] ?? `View type ${row.querytype}`
        : kind === 'form' || kind === 'dashboard'
          ? FORM_TYPES[row.type] ?? ''
          : kind === 'command'
            ? `${row.type === 3 ? 'Group' : 'Button'} · ${LOCATIONS[row.location] ?? 'Command bar'}${row._appmoduleid_value ? ' · this app only' : ''}`
            : row.uniquename || row.schemaname || '';
    const base = {
      kind,
      entity: r.ent,
      comp: `${kind}|${r.id}`,
      group: `${kind}|${r.id}`,
      title: pick(labels[0], ctx.user, ctx.base) || r.name || r.id,
      path: r.ent ? [tables.get(r.ent) || r.ent] : [],
      sub,
    };
    const lock = locked(row) ? MANAGED : '';
    return r.props.map(
      ([prop, column, max], j): Slot => ({
        ...base,
        key: slotKey(kind, r.id, prop),
        prop,
        labels: labels[j],
        readOnly: lock || (got[j].ok ? '' : `Could not read its translations: ${got[j].error}`),
        // SetLocLabels is never sent with an empty base-language label, so it can't be cleared here.
        baseRequired: true,
        max,
        order: i * 8 + j,
        ref: { id: r.id, table: r.d.table, entitySet: r.d.set, column, entity: r.ent, type: r.type, managed: !!row.ismanaged, app: guid(row._appmoduleid_value) || undefined } satisfies Ref,
      }),
    );
  });
}

/** Table display names in the user's language for breadcrumbs (logical names when unavailable). */
async function tableNames(ctx: Ctx, entities: string[], signal: AbortSignal): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  await Promise.all(
    chunks(entities, 40).map((c) =>
      ctx.http.get(`EntityDefinitions?$select=LogicalName,DisplayName&$filter=${or('LogicalName', c.map(str))}`, { signal }).then(
        (r) => {
          for (const e of r.value || []) m.set(e.LogicalName, e.DisplayName?.UserLocalizedLabel?.Label || e.LogicalName);
        },
        (e) => {
          if (isAbort(e)) throw e;
        },
      ),
    ),
  );
  return m;
}

// ---- Saving ----

const current = async (ctx: Ctx, r: Ref, signal?: AbortSignal): Promise<Labels> =>
  toLabels((await ctx.http.get(locPath(ctx, r.entitySet, r.id, r.column), { signal, headers: { Consistency: 'Strong' } })).Label);

const CANCELLED = 'Cancelled before saving.';
/** A conflict found by the read inside the write batch: the other maker's text is back on the server. */
const RACED = 'Someone else saved this text at the same moment. Theirs was put back: choose which one to keep.';

/** What one write batch did. `ran`: true, false (nothing written), or 'maybe' (its answer was lost). */
interface Sent {
  ran: boolean | 'maybe';
  error?: unknown;
  /** The read before the write failed, which stopped the batch: nothing was written. */
  unread?: boolean;
  /** Every language right before the write and right after it (null when that read could not be read). */
  before: Labels | null;
  after: Labels | null;
}

/**
 * SetLocLabels of `langs` (language → text, '' removes it) in one $batch between two reads of the label. Dataverse runs
 * the parts in order, so the first read shows the label exactly as the write found it and the last one as it left it.
 * Sent `once`, and without continue-on-error: a first read that fails stops the batch before the write.
 */
async function setLabels(ctx: Ctx, kind: RecKind, r: Ref, langs: Map<number, string>): Promise<Sent> {
  const read: BatchPart = { method: 'GET', url: locPath(ctx, r.entitySet, r.id, r.column), headers: { Consistency: 'Strong' } };
  const write: BatchPart = {
    method: 'POST',
    url: 'SetLocLabels',
    body: {
      EntityMoniker: { '@odata.type': `Microsoft.Dynamics.CRM.${r.table}`, [DEFS[kind].pk]: r.id },
      AttributeName: r.column,
      Labels: [...langs].map(([LanguageCode, Label]) => ({ Label, LanguageCode })),
    },
  };
  let res: PartResult[];
  try {
    res = await ctx.http.batch([read, write, read], { once: true, stop: true });
  } catch (e) {
    return { ran: mayHaveRun(e) ? 'maybe' : false, error: e, before: null, after: null };
  }
  const [p, w, b] = res;
  const labels = (x: PartResult): Labels | null => (x.ok ? toLabels(x.data?.Label) : null);
  if (w.ok) return { ran: true, before: labels(p), after: labels(b) };
  // A first read Dataverse answered with an error stopped the batch there (no answer for the write).
  if (!w.status && !p.ok && p.status) return { ran: false, error: partError(p), unread: true, before: null, after: null };
  const e = partError(w);
  return { ran: mayHaveRun(e) ? 'maybe' : false, error: e, before: labels(p), after: null };
}

const val = (x: Labels, l: number): string => x[l] ?? '';

/**
 * Writes back what a write replaced (`back`: language → text, '' removes it), in a batch like any write. Returns the
 * labels it left, '' or why the repair did not go through, and the languages someone saved again since the read `now`
 * (`third`, with their text): the repair replaced that too, so it is written back the same way (at most three rounds).
 */
async function repair(ctx: Ctx, kind: RecKind, r: Ref, back: Map<number, string>, now: Labels): Promise<{ after: Labels | null; error: string; third: Map<number, string> }> {
  const third = new Map<number, string>();
  for (let i = 0, round = 0; ; ) {
    const s = await setLabels(ctx, kind, r, back);
    if (s.ran === true) {
      const after = s.after ?? (await current(ctx, r).catch(() => null));
      if (!after) return { after, error: 'it could not be read back', third };
      const again = s.before ? [...back].filter(([l, t]) => val(s.before!, l) !== val(now, l) && val(s.before!, l) !== t) : [];
      for (const [l] of again) third.set(l, val(s.before!, l));
      // Theirs where this repair's text still shows (a removed base-language text can't be put back: it is required).
      const next = new Map(again.filter(([l, t]) => val(after, l) === t && (l !== ctx.base || val(s.before!, l).trim())).map(([l]) => [l, val(s.before!, l)]));
      if (!next.size) return { after, error: '', third };
      if (++round > 2) return { after, error: 'someone else is changing it right now', third };
      [back, now, i] = [next, after, 0];
      continue;
    }
    if (s.ran === false && turnedAway(s.error) && i < 3) await pause(2000 << i++);
    else return { after: null, error: why(s.error).replace(/[.!?]+$/, ''), third };
  }
}

/**
 * The results of a write that ran, from the label as the writer read it (`server`), as the write found it (`sent.before`)
 * and as it left it. A text someone else saved in a written language between that read and the write was replaced by it:
 * theirs is put back and the change is a conflict. A language the write did not send that it dropped, or filled with one
 * of the texts it sent, is put back as it was; one that moved to another text is someone's in that instant, and said.
 * Without the read before the write, a save made at that moment can't be ruled out, so nothing is called saved.
 */
async function checked(ctx: Ctx, slot: Slot, write: Change[], server: Labels, sent: Sent): Promise<ChangeResult[]> {
  const r: Ref = slot.ref;
  const kind = slot.kind as RecKind;
  let now = sent.after;
  if (!now)
    try {
      now = await current(ctx, r);
    } catch (e) {
      return write.map((change) => ({ change, outcome: 'error', message: `Saved, but it could not be verified: ${sentence(why(e))} Reload to check it.` }));
    }
  const was = sent.before;
  const edited = (l: number) => write.some((c) => c.lcid === l);
  const ours = new Set(write.map(text).filter(Boolean));
  const raced = was ? write.filter((c) => val(was, c.lcid) !== val(server, c.lcid) && val(was, c.lcid) !== text(c)) : [];
  // Without the read before the write, every language that moved since the writer's read is reported, as before.
  const from = was ?? server;
  const moved = Object.keys({ ...from, ...now })
    .map(Number)
    .filter((l) => !edited(l) && val(now!, l) !== val(from, l));
  const back = new Map<number, string>();
  // Theirs where this write's text still shows (a removed base-language text can't be put back: it is required).
  for (const c of raced) if (val(now, c.lcid) === text(c) && (c.lcid !== ctx.base || val(was!, c.lcid).trim())) back.set(c.lcid, val(was!, c.lcid));
  if (was) for (const l of moved) if (!val(now, l).trim() || ours.has(val(now, l))) back.set(l, val(was, l));
  let end = now;
  let failed = '';
  /** Languages someone saved yet again while theirs was put back, put back in turn (repair). */
  let third = new Map<number, string>();
  if (back.size) {
    const rep = await repair(ctx, kind, r, back, now);
    failed = rep.error;
    third = rep.third;
    if (rep.after) end = rep.after;
  }
  const restored = (l: number) => !failed && back.has(l) && val(end, l) === back.get(l);
  const left = moved.filter((l) => !restored(l));
  return write.map((c): ChangeResult => {
    if (raced.includes(c)) {
      const theirs = val(was!, c.lcid);
      if (restored(c.lcid)) return { change: c, outcome: 'conflict', server: theirs, message: RACED };
      if ((!back.has(c.lcid) && val(now!, c.lcid) !== text(c)) || (!failed && third.has(c.lcid) && val(end, c.lcid) !== text(c)))
        return { change: c, outcome: 'conflict', server: val(end, c.lcid), message: 'Someone else saved this text at the same moment.' };
      return {
        change: c,
        outcome: 'error',
        message: `${theirs ? `Someone else saved “${theirs}” here` : 'Someone else removed this translation'} at the same moment, and this save replaced it${back.has(c.lcid) ? `; putting theirs back failed (${failed || 'Dataverse did not keep it'})` : ''}. Check this text.`,
      };
    }
    const want = text(c);
    if (val(end, c.lcid) !== want) return { change: c, outcome: 'error', message: want ? 'Dataverse did not keep this text. Reload and try again.' : 'Dataverse did not remove this translation. Reload and try again.' };
    if (left.length)
      return {
        change: c,
        outcome: 'error',
        message: left.some((l) => back.has(l) && (failed || !third.has(l)))
          ? `Saved, but this save also changed the ${left.map(lcidName).join(', ')} text, and putting it back failed (${failed || 'Dataverse did not keep it'}). Reload to check it.`
          : `Saved, but the ${left.map(lcidName).join(', ')} text changed too. Reload to check it.`,
      };
    if (!was) return { change: c, outcome: 'error', message: "Saved, but the text right before the save could not be read, so a save someone else made at the same moment can't be ruled out. Reload to check it." };
    return { change: c, outcome: 'saved' };
  });
}

/**
 * The text written for a change. Blank (empty or only spaces) is sent as '', which removes that language
 * (verified live, finding 33) so its users see the base-language text again.
 */
const text = (c: Change): string => (c.after.trim() ? c.after : '');

/** A missing label, '' and whitespace only all mean "no text in that language". */
const blank = (s: string | undefined): string => (s && s.trim() ? s : '');

/**
 * check() with blank values treated alike: clearing a language that is already gone is 'unchanged'. A label
 * of only spaces is a stored label (users see it blank), so clearing it is written ('' removes it) instead
 * of being reported as already done while it stays on the server.
 */
function compare(c: Change, server: string | undefined, force: Set<string>): ChangeResult | null {
  const r = check({ ...c, before: blank(c.before), after: blank(c.after) }, blank(server), force);
  if (r?.outcome === 'unchanged' && !c.after.trim() && (server ?? '') !== '') return null;
  return r && { ...r, change: c, ...(r.outcome === 'conflict' ? { server: server ?? '' } : {}) };
}

export const recordsWriter: Writer = {
  kinds: KINDS,
  lane: 'records',
  async read(ctx, changes, o) {
    const out: ServerTexts = new Map();
    for (const slot of new Set(changes.map((c) => c.slot))) {
      const server = await current(ctx, slot.ref, o.signal);
      for (const c of changes) if (c.slot === slot) out.set(changeId(c), server[c.lcid] ?? '');
    }
    return out;
  },
  async save(ctx, changes, o) {
    const out: ChangeResult[] = [];
    const put = (cs: Change[], outcome: Outcome, message?: string) => out.push(...cs.map((change) => ({ change, outcome, message })));
    const bySlot = new Map<Slot, Change[]>();
    for (const c of changes) bySlot.set(c.slot, [...(bySlot.get(c.slot) || []), c]);
    /** The slots that need publishing: a write was sent (or may have run), or a text is already as asked. */
    const wrote = new Set<Slot>();
    /**
     * Whether the record reads as one from a managed solution right before its first write (read once, only when a write
     * is due): one that slipped through as editable is never written, so no unmanaged layer is ever put on it.
     */
    let managedNow: Promise<boolean> | undefined;
    const fromManaged = (r: Ref) =>
      (managedNow ??= ctx.http.get(`${r.entitySet}(${guid(r.id)})?$select=ismanaged`, { signal: o.signal, headers: { Consistency: 'Strong' } }).then((x) => x?.ismanaged === true));

    // One column at a time: these are writes to the same record.
    for (const [slot, all] of bySlot) {
      const r: Ref = slot.ref;
      if (slot.readOnly) {
        put(all, 'skipped', slot.readOnly);
        continue;
      }
      if (isManaged(slot)) {
        put(all, 'error', MANAGED);
        continue;
      }
      // Every other language falls back to the base-language text, so it can never be removed.
      const cs = all.filter((c) => c.lcid !== ctx.base || c.after.trim());
      put(
        all.filter((c) => !cs.includes(c)),
        'error',
        `The ${lcidName(ctx.base)} text can't be blank: it is the base language.`,
      );
      if (!cs.length) continue;
      if (o.signal.aborted) {
        put(cs, 'skipped', CANCELLED);
        continue;
      }
      try {
        if (await fromManaged(r)) {
          put(cs, 'error', MANAGED);
          continue;
        }
      } catch (e) {
        // Not known to be unmanaged: nothing is written.
        if (isAbort(e)) put(cs, 'skipped', CANCELLED);
        else put(cs, 'error', `Could not read the current text: ${why(e)}`);
        continue;
      }
      o.progress(`Saving ${KIND_NAMES[slot.kind][0].toLowerCase()} “${slot.title}” › ${PROP_NAMES[slot.prop]}`);
      // A write turned away unrun is tried again after 2, 4 and 8 s, each time from a new read.
      for (let i = 0; ; i++) {
        let server: Labels;
        try {
          server = await current(ctx, r, o.signal);
        } catch (e) {
          if (isAbort(e)) put(cs, 'skipped', CANCELLED);
          else put(cs, 'error', `Could not read the current text: ${why(e)}`);
          break;
        }
        const hits: ChangeResult[] = [];
        const write: Change[] = [];
        for (const c of cs) {
          const hit = compare(c, server[c.lcid], o.force);
          if (hit) hits.push(hit);
          else write.push(c);
        }
        // A text already as asked may be an earlier write whose answer was lost, still unpublished.
        if (hits.some((x) => x.outcome === 'unchanged')) wrote.add(slot);
        if (!write.length) {
          out.push(...hits);
          break;
        }

        // Only the edited languages ('' removes one): SetLocLabels keeps every language it is not sent
        // (finding 21), so a language another maker saves after the read above is never written back.
        // Not abortable: once a write is sent it is always read back, so its outcome is known. Never resent by
        // Http either (`once`): it was checked against the read just made, which a later try makes again.
        const sent = await setLabels(ctx, slot.kind as RecKind, r, new Map(write.map((c) => [c.lcid, text(c)])));
        // A write that ran or may have (its answer lost) may have saved them; one refused or never sent did not.
        if (sent.ran) for (const c of write) o.ran?.add(changeId(c));
        let again = false;
        if (sent.ran === true) {
          wrote.add(slot);
          out.push(...(await checked(ctx, slot, write, server, sent)));
        } else if (sent.ran === false && turnedAway(sent.error) && i < 3) again = true;
        else {
          if (sent.ran === 'maybe') wrote.add(slot);
          put(write, 'error', sent.unread ? `Could not read the current text right before saving, so nothing was saved: ${why(sent.error)}` : why(sent.error));
        }
        if (!again) {
          out.push(...hits);
          break;
        }
        try {
          await pause(2000 << i, o.signal);
        } catch {
          out.push(...hits);
          put(write, 'skipped', CANCELLED);
          break;
        }
      }
    }

    const s = changes[0]?.slot;
    if (wrote.size && s) {
      const r: Ref = s.ref;
      if (s.kind === 'dashboard') o.publish.dashboards.add(r.id);
      else if (s.kind === 'app') o.publish.appmodules.add(r.id);
      // Command labels are live as soon as SetLocLabels returns (verified), so nothing is published for them.
      else if (r.entity && (s.kind === 'view' || s.kind === 'chart' || s.kind === 'form')) o.publish.entities.add(r.entity);
      // A process's new name shows on the page only once the process is updated (the saver does it after the
      // writes, LIVE-FINDINGS 83); its description is not shown there.
      else if (s.kind === 'bpf') for (const x of wrote) if (x.prop === 'Name') o.publish.processes.set(r.id, x.title);
    }
    return out;
  },
};
