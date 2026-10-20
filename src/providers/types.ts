// Contracts between the save orchestrator / loaders and the component providers.

import type { Ctx } from '../core/context';
import type { LangSession } from '../core/langsession';
import type { Change, ChangeResult, Kind, Labels, Lcid, PublishSet, Slot } from '../core/model';

/**
 * Lanes decide how the saver schedules writes:
 *  - 'metadata': table/column/choice/relationship writes. Dataverse allows one customization
 *    operation at a time org-wide ("Cannot start another [EntityCustomization]"), so these run
 *    strictly one after another.
 *  - 'records': SetLocLabels on localizable columns (views, charts, form names, apps, commands...).
 *    Independent, run a few in parallel.
 *  - 'xml': formxml / dashboard XML edits; tab and section labels need the user's UI language switched
 *    (LangSession). One form at a time (one hold per form, every language), alongside the metadata lane.
 *  - 'doc': other whole-document edits (sitemap XML, BPF definitions). Run one after another.
 *  - 'ribbon': classic ribbon labels via a translation import (~20 s per table). Run last, one at a time.
 */
export type Lane = 'metadata' | 'records' | 'xml' | 'doc' | 'ribbon';

export interface SaveOptions {
  signal: AbortSignal;
  /** Components that need publishing; writers add to it. */
  publish: PublishSet;
  /** Short status text for the progress UI, e.g. "Saving Account › Main form". */
  progress: (msg: string) => void;
  /** Change ids (`${slot.key}#${lcid}`) the user chose to write even though the server value changed. */
  force: Set<string>;
  /**
   * The changes a write of this save may have saved, by change id: writers add each one a write was sent for that
   * Dataverse did not refuse, answered (2xx, whatever the read after it shows) or with its answer lost (core/http.ts
   * mayHaveRun: no answer, a gateway or server error, a 503 without Retry-After, a batch part with no answer). Never one
   * not sent (a read before it failed, a check refused it, Stop) nor one turned away unrun or refused (4xx): a later save
   * that finds such a change already as asked has found someone else's text, never this write (core/saver.ts `tried`).
   */
  ran?: Set<string>;
  /** UI-language switcher for the 'xml' lane. */
  lang: LangSession;
  /**
   * False when the user chose "save without publishing". Writers that can only work safely by publishing
   * (classic ribbon: exports contain only the published ribbon) must refuse instead.
   */
  allowPublish: boolean;
}

export interface ReadOptions {
  signal: AbortSignal;
  /** Form tab and section labels in another language are read while the UI language is switched to it. */
  lang: LangSession;
}

/** The text of each change on the server now ('' when that language has none), or why it couldn't be read, by change id. */
export type ServerTexts = Map<string, string | Error>;

export interface Writer {
  kinds: Kind[];
  lane: Lane;
  /**
   * The server text of these changes now (one `slot.group`), read as save() reads it right before writing and
   * writing nothing: what Recent publishes › Undo shows before it undoes anything. Rejects when the read fails.
   */
  read?(ctx: Ctx, changes: Change[], o: ReadOptions): Promise<ServerTexts>;
  /**
   * Saves changes that all share one `slot.group` (one server object). A writer must:
   *  1. read the CURRENT server state right before writing (never reuse what was loaded earlier);
   *  2. for each change, compare the server value with `change.before`. If it differs and is not
   *     already `change.after`, and the change id is not in `force`, return outcome 'conflict'
   *     with `server` set, and do not write that language;
   *  3. write only the languages that changed, never re-sending other languages;
   *  4. verify by reading back, and report 'error' for anything that did not stick;
   *  5. add what needs publishing to `o.publish`: after a write, also one that may have run although it failed,
   *     and for a change found 'unchanged' that may not be published yet (an earlier write whose answer was lost);
   *  6. never resend a write built from a read: one Dataverse turned away unrun is tried again from a new read;
   *  7. add to `o.ran` each change a write was sent for that ran or may have run, before throwing too.
   * Throwing is allowed for unexpected failures; the saver then marks every change of the group as 'error'.
   */
  save(ctx: Ctx, changes: Change[], o: SaveOptions): Promise<ChangeResult[]>;
}

/** What the workbench asks loaders for. */
export interface Scope {
  /** Table logical names. */
  entities: string[];
  kinds: Set<Kind>;
  /** Restricts solution-aware components (global choices, dashboards, apps, sitemaps, BPFs, commands) to a solution. */
  solutionId?: string;
  /** Include read-only labels (from managed solutions or not customizable; shown read-only). Default false. */
  includeReadOnly?: boolean;
  /** Load every global choice of the environment (the Workbench's "Global OptionSets"), not only those of the tables. */
  allGlobals?: boolean;
}

export interface LoadOptions {
  signal: AbortSignal;
  progress: (msg: string, done?: number, total?: number) => void;
  /** Present when the loader may switch the UI language to read per-language labels (forms, dashboards). */
  lang?: LangSession;
}

export type Loader = (ctx: Ctx, scope: Scope, o: LoadOptions) => Promise<Slot[]>;

// ---- Lookup results shared with the UI ----

export interface TableInfo {
  logicalName: string;
  schemaName: string;
  metadataId: string;
  displayName: Labels;
  collectionName: Labels;
  customizable: boolean;
  renameable: boolean;
  managed: boolean;
  custom: boolean;
  activity: boolean;
  otc: number;
}

export interface SolutionInfo {
  id: string;
  uniqueName: string;
  name: string;
  managed: boolean;
  version: string;
  publisher: string;
}

export interface FormRef {
  formId: string;
  /** Table logical name ('none' for dashboards). */
  entity: string;
  name: string;
  /** systemform.type (0 dashboard, 2 main, 6 quick view, 7 quick create, 10 interactive dashboard, 11 card, 12 main interactive). */
  type: number;
}

/** A classic ribbon control in the composed ribbon (label attributes hold tokens like `$LocLabels:Id`). */
export interface RibbonControl {
  id: string;
  command?: string;
  labelText?: string;
  toolTipTitle?: string;
  toolTipDescription?: string;
  alt?: string;
}

/** The record page a process shows on: what GetClientMetadata needs to answer with the names the page shows. */
export interface ProcessPage {
  /** The page's table. */
  entity: string;
  /** The page's record id. */
  record: string;
  /** The app id ('' when unknown). */
  app: string;
}

/** A modern command (appaction) row. */
export interface CommandInfo {
  id: string;
  /** appaction.name; the 4th segment of the command bar button data-id. */
  name: string;
  location: number;
  entity: string;
  appId: string;
}

/** Every provider function the UI may call. Implemented in providers/*.ts and assembled in providers/index.ts. */
export interface ProvidersApi {
  /** Loads everything a scope asks for (fan-out to every loader) and returns the slots. */
  loadScope(ctx: Ctx, scope: Scope, o: LoadOptions): Promise<Slot[]>;
  writerFor(kind: Kind): Writer | undefined;

  listTables(ctx: Ctx, signal?: AbortSignal): Promise<TableInfo[]>;
  listSolutions(ctx: Ctx, signal?: AbortSignal): Promise<SolutionInfo[]>;
  /** Logical names of the tables in a solution. */
  solutionTables(ctx: Ctx, solutionId: string, signal?: AbortSignal): Promise<string[]>;

  /** Table metadata for specific tables/kinds (entity, attribute, option, status, state, boolean, globaloption(set), relationship). */
  loadTables(ctx: Ctx, entities: string[], kinds: Set<Kind>, o: LoadOptions): Promise<Slot[]>;
  /** Localizable-column records by id: kind is view | chart | form | dashboard | app | bpf | command | envvar | customapi. */
  loadRecords(ctx: Ctx, kind: Kind, ids: string[], o: LoadOptions): Promise<Slot[]>;
  /** Modern commands by appaction.name (button data-id), best match for the app/table. */
  findCommands(ctx: Ctx, names: string[], appId: string, entity: string, signal?: AbortSignal): Promise<CommandInfo[]>;
  /** Form / dashboard XML labels for the given languages (non-user languages need o.lang). */
  loadFormXml(ctx: Ctx, forms: FormRef[], langs: Lcid[], o: LoadOptions): Promise<Slot[]>;
  /** Form reference by id (type, table, name). */
  getForm(ctx: Ctx, formId: string, signal?: AbortSignal): Promise<FormRef | null>;
  /** The fetch XML of a system or personal view ('' when it has none or is gone). */
  viewQuery(ctx: Ctx, viewId: string, signal?: AbortSignal): Promise<string>;
  /** Sitemap id of an app (null when the app has none). */
  appSitemapId(ctx: Ctx, appId: string, signal?: AbortSignal): Promise<string | null>;
  loadSitemap(ctx: Ctx, sitemapId: string, o: LoadOptions): Promise<Slot[]>;
  /** BPF stage and step labels (its name and description are 'bpf' record slots: loadRecords). */
  loadBpf(ctx: Ctx, workflowId: string, o: LoadOptions): Promise<Slot[]>;
  /**
   * The stage and step names Dynamics shows from its own store in the languages a process's definition has none in
   * (LIVE-FINDINGS 83, 85), read for the page's record: loadBpf's `slots` with them filled in, and the languages that
   * could not be read.
   */
  loadBpfStored(ctx: Ctx, slots: Slot[], page: ProcessPage, o: LoadOptions): Promise<{ slots: Slot[]; missed: Lcid[] }>;
  /** Classic ribbon LocLabels of tables ('_app' = application ribbon). */
  loadRibbonLabels(ctx: Ctx, entities: string[], o: LoadOptions): Promise<Slot[]>;
  /** Composed ribbon controls of a table, keyed by control Id. */
  ribbonControls(ctx: Ctx, entity: string, signal?: AbortSignal): Promise<Map<string, RibbonControl>>;
}

/** Id used for force/conflict bookkeeping. */
export const changeId = (c: Change): string => `${c.slot.key}#${c.lcid}`;

/** Helper for writers: classify one change against the current server value. */
export function check(c: Change, server: string, force: Set<string>): ChangeResult | null {
  if (server === c.after) return { change: c, outcome: 'unchanged' };
  if (server !== c.before && !force.has(changeId(c))) return { change: c, outcome: 'conflict', server, message: 'Someone changed this label after you loaded it.' };
  return null; // ok to write
}
