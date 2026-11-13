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
  /**
   * A column's names as this save knows them, per language: the store's as loaded and as this save writes them
   * (core/model.ts columnNames), undefined while the column's names aren't loaded; `renamed`: the languages where this
   * save changes the name a form read fills in (its own there, else the base language's). The form writer never posts
   * one of them on someone else's behalf (a field another maker added, their text of a label both changed at once, a
   * label Dataverse dropped): read, it is the column's name filled in (LIVE-FINDINGS 103), and posted it would be stored
   * as a label of the form's own (104).
   */
  column?(entity: string, attr: string): { names: Record<number, string[]>; renamed: readonly Lcid[] } | undefined;
  /**
   * Tells the user something after the save (SaveReport), once per writer call (the form writer's is one form, so two
   * forms of the same name each keep their message): a 'notice' for labels Dataverse dropped that the save wrote back, or
   * for a temporary solution the classic command writer could not delete, a 'warning' for labels it could not put back or
   * when that write-back may have replaced a save someone else made at the same moment (providers/formxml.ts nothingElse).
   */
  warn?(message: string, level: 'warning' | 'notice'): void;
  /**
   * What the form writer knew of each form this save wrote, by form id (SaveReport.forms): the Publish dialog keeps the
   * answers of which of its field labels are its own for the version its publish makes from them (ui/review.ts
   * keepOwnLabels, LIVE-FINDINGS 114).
   */
  forms?: Map<string, FormWrite>;
  /** UI-language switcher for the 'xml' lane. */
  lang: LangSession;
  /**
   * False when the user chose "save without publishing". Writers that can only work safely by publishing
   * (classic ribbon: exports contain only the published ribbon) must refuse instead.
   */
  allowPublish: boolean;
}

/**
 * What a save left of a main form column cell's labels of their own, as the form writer posted them (LIVE-FINDINGS 104):
 * its label key (`key`), and per language it posted whether its label is the form's own there now: true, 'name' for a
 * text worded as its column's name, which the key stores only where it held a label before, and null where it isn't
 * known (its column's names not loaded, or renamed by the same save there, so the name the key compared it with isn't
 * known).
 */
export interface CellOwn {
  key: string;
  own: Record<number, true | 'name' | null>;
}

/** What the form writer knew of a form it wrote in a save (SaveOptions.forms), from that save's first write of it. */
export interface FormWrite {
  /**
   * The form had another change than this save's: its unpublished versionnumber differed from its published one at the
   * read before that write, or someone else's save landed while it wrote (providers/repair.ts settle), or Dataverse
   * dropped a label it left out (providers/formxml.ts nothingElse).
   */
  pending: boolean;
  /** Its published versionnumber at that read. */
  version: string;
  /** A write of it was sent that ran, or may have: from then on its reads show this save's own change. */
  sent: boolean;
  /** What that write left of each column cell it posted with a change, by comp (main forms, providers/formxml.ts SPARSE). */
  cells: Map<string, CellOwn>;
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
   *  3. write only the languages that changed, never re-sending other languages (a form: a column's cell posted
   *     without the labels the save doesn't change, providers/formxml.ts; the rest of the document as read);
   *  4. verify by reading back, and report 'error' for anything that did not stick;
   *  5. add what needs publishing to `o.publish`: after a write, also one that may have run although it failed,
   *     and for a change found 'unchanged' that may not be published yet (an earlier write whose answer was lost);
   *  6. never resend a write built from a read: one Dataverse turned away unrun is tried again from a new read;
   *  7. add to `o.ran` each change a write was sent for that ran or may have run, before throwing too.
   * Throwing is allowed for unexpected failures; the saver then marks every change of the group as 'error'.
   */
  save(ctx: Ctx, changes: Change[], o: SaveOptions): Promise<ChangeResult[]>;
  /**
   * Which of save()'s writes a change goes out in, where one call writes its group in several (the form writer: a pass
   * per language for labels kept per language, providers/formxml.ts). Changes in different passes are not in one write:
   * a stand-in made of a text another pass writes is written after it, once that text is saved (core/saver.ts).
   */
  pass?(ctx: Ctx, change: Change): string;
  /**
   * Publish again's repair of saved labels a publish didn't take (the form writer, LIVE-FINDINGS 117; the column writer,
   * 118): writes the texts `changes` saved again, as save() writes, calling `publish` after its writes (given a signal, it
   * publishes with that one in place of the run's); never a save of new texts. Each label's result.
   */
  again?(ctx: Ctx, changes: Change[], o: SaveOptions, publish: (signal?: AbortSignal) => Promise<void>): Promise<ChangeResult[]>;
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

/**
 * A copy of a main form's GetClientMetadata answer that the page keeps (providers/formxml.ts pageOwnLabels): the labels
 * of the form's own in one language, as the answer to the page's own read of the form lists them.
 */
export interface OwnCopy {
  /** The form it holds. */
  form: string;
  /** The language it is in, as its resource files prove it. */
  l: Lcid;
  /** The published form's versionnumber it describes. */
  v: string;
  /** The label keys it lists a label of the cell's own for. */
  k: string[];
  /** Those labels' texts, by label key. */
  t: Record<string, string>;
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
  loadFormXml(ctx: Ctx, forms: FormRef[], langs: Lcid[], o: LoadOptions, kinds?: ReadonlySet<Kind>): Promise<Slot[]>;
  /**
   * The copies of a main form's GetClientMetadata answer that the page keeps, in each language it has one in (the user's
   * as the form shows): looked for while the form is read, nothing sent. Never fails: none found is none.
   */
  pageOwnLabels(ctx: Ctx, formId: string, entity?: string): Promise<OwnCopy[]>;
  /**
   * Per slot key and language, what is known without a request of whether a main form's field label (a loadFormXml
   * `ref.sparse` slot) has a text of its own there: the answers kept for its form's version, and the page's copies
   * (pageOwnLabels) whose texts agree with the loaded ones, which are kept as answers; a cell a copy lists no label of its
   * own for must have the text a read `fills` in there.
   */
  knownOwnLabels(ctx: Ctx, cells: Slot[], copies?: OwnCopy[], fills?: (s: Slot, l: Lcid) => boolean): Map<string, Record<number, boolean>>;
  /**
   * Per slot key and language, whether a main form's field label (a loadFormXml `ref.sparse` slot) has a text of its
   * own there, as GetClientMetadata lists it (`ref.own`, core/model.ts follows): read in the user's language, then in
   * each other language in a switch window of its own, kept in the browser per published form version; a language is
   * read only while no answer is kept for that version and some label there is `undecided` (its text is the column's
   * name). `known` gets what is known before each window.
   */
  loadOwnLabels(ctx: Ctx, cells: Slot[], signal: AbortSignal, known?: (own: Map<string, Record<number, boolean>>) => void, undecided?: (s: Slot, l: Lcid) => boolean): Promise<Map<string, Record<number, boolean>>>;
  /**
   * Keeps the answers loadOwnLabels keeps for a main form at the published version `from` for the version `to` that a
   * publish of the translator's own made of it, changed as the save before it left its cells (`cells`): a reload then
   * reads none of them again.
   */
  carryOwnLabels(ctx: Ctx, formId: string, from: string, to: string, cells: readonly CellOwn[]): void;
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

/** A conflict's message: the server text is neither the one the change was made on nor one that is no conflict either (Change.alsoBefore). */
export const CHANGED = 'Someone changed this label after you loaded it.';

/** Helper for writers: classify one change against the current server value. */
export function check(c: Change, server: string, force: Set<string>): ChangeResult | null {
  if (server === c.after) return { change: c, outcome: 'unchanged' };
  if (server !== c.before && server !== c.alsoBefore && !force.has(changeId(c))) return { change: c, outcome: 'conflict', server, message: CHANGED };
  return null; // ok to write
}
