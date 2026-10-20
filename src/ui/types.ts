// Contract between the app shell (ui/app.ts) and the views (workbench, inspector) and shared widgets.

import type { Ctx } from '../core/context';
import type { LangSession } from '../core/langsession';
import type { Change, ChangeResult, Kind, Lcid, PublishSet, Slot, TextOf } from '../core/model';
import type { Store } from '../core/store';
import type { CreatePageMode } from '../inspector/types';
import type { ProvidersApi, Scope, ServerTexts } from '../providers/types';

export type ToastKind = 'info' | 'ok' | 'warn' | 'error';

export interface Prefs {
  /** Languages shown as columns / inputs (lcids). The base language is always shown. */
  shown: Lcid[];
  /** The language the user is translating into (drives "missing" highlights and filters). */
  target: Lcid;
  /** Show logical / schema names under component titles (Workbench only). */
  showNames: boolean;
  /** Docked side panel vs floating window (Workbench window). */
  dock: 'right' | 'float' | 'max';
  /** Where the page-mode bar sits (dragged position, or snapped to the top). */
  bar?: { x?: number; y?: number; top?: boolean };
  /**
   * The All labels sheet: docked on the right (the default), or floating where it was dragged (x, y: fractions of the
   * room around it, kept while it is docked again).
   */
  list?: { float?: boolean; x?: number; y?: number };
}

/** Progress of a load started by a view (the Workbench shows it in its own message bar). */
export interface LoadUiOptions {
  onProgress?(message: string, done?: number, total?: number): void;
  /** Aborts the load (the caller's Stop button). */
  signal?: AbortSignal;
  /** Called instead of the app's toast when the load failed or was stopped (the count is then 0). */
  onError?(message: string): void;
}

export interface ConfirmOptions {
  title: string;
  body: string | Node;
  ok: string;
  cancel?: string;
  danger?: boolean;
}

export interface AppApi {
  ctx: Ctx;
  store: Store;
  lang: LangSession;
  prefs: Prefs;
  /** Persists prefs (localStorage, per org) and notifies listeners. */
  savePrefs(p: Partial<Prefs>): void;
  /** The app's shadow root (dialogs, menus and popovers are created inside it). */
  root: ShadowRoot;
  /** The app layer inside the shadow root: floating page-mode UI (bar, callouts, the list sheet) is appended here. */
  layer: HTMLElement;

  toast(message: string, kind?: ToastKind, action?: { label: string; run: () => void }): void;
  confirm(o: ConfirmOptions): Promise<boolean>;
  /** Shows a generic modal; resolves when it closes. `build` returns the dialog body and receives a close() function. */
  modal<T = void>(title: string, build: (close: (v?: T) => void) => Node, o?: { wide?: boolean }): Promise<T | undefined>;

  /** Loads a scope into the store with progress UI (used by the workbench and importer); resolves with the number of labels loaded. */
  load(scope: Scope, o?: LoadUiOptions): Promise<number>;
  /** Opens the editor card for a component (`slot.comp`); `focusLcid` focuses that language's input. */
  edit(comp: string, focusLcid?: Lcid): void;
  /**
   * Opens the Publish dialog for all staged changes (or only those matching `filter`): review → save → publish
   * (always) → check, and in translation mode refresh the page when everything succeeded. Resolves with the
   * last run's report when the dialog closes (the page may already be reloading).
   */
  review(filter?: (s: Slot) => boolean): Promise<SaveReport | undefined>;
  /**
   * Clears the Dynamics client caches (targeted, keeps every `dxt:` key) and reloads the page so freshly
   * published labels show (ui/refresh.ts). Asks first when the record has unsaved changes; resolves false when
   * the user said Not now (nothing reloaded).
   */
  refreshPage(): Promise<boolean>;
  /**
   * "Show Dynamics in <language>": sets the user's Dynamics UI language for good (the translator never switches it
   * back) and refreshes the page in it, with the same questions first. Refused (false, with a toast) while a save
   * runs or the language is switched for a moment.
   */
  showDynamicsIn(lcid: Lcid): Promise<boolean>;
  /** Switches the main view: 'page' = translation mode on the page (no window), 'workbench' = the spreadsheet window. */
  show(view: 'page' | 'workbench'): void;
  /** The current view. */
  view(): 'page' | 'workbench' | null;
  /**
   * Opens the language menu ("Translate into", "Show languages") under `anchor`. The app also dispatches
   * 'dxt-prefs' on `root.host` when prefs change, and 'dxt-lang' ({detail: {lcid: Lcid | null}}) while the
   * user's Dynamics language is temporarily switched (form tab/section labels) and when it is restored.
   */
  langMenu(anchor: HTMLElement): void;
  /** Sets the footer status text ('' clears it). */
  status(text: string): void;
  /** Adds a stylesheet (minified CSS text) to the app's shadow root. Views call this once on creation. */
  adoptStyles(css: string): void;
  /**
   * Form tab and section labels in other languages need the user's UI language switched for a moment. This is
   * automatic (no prompt): always resolves true. Kept so loaders and savers have one place to ask.
   */
  askLangSwitch(): Promise<boolean>;

  providers: ProvidersApi;
  saver: SaverApi;
  io: IoApi;
}

// ---- Saving ----

export interface SaveProgress {
  done: number;
  total: number;
  message: string;
}

export interface SaveReport {
  results: ChangeResult[];
  saved: number;
  unchanged: number;
  conflicts: number;
  errors: number;
  skipped: number;
  published: boolean;
  publishError?: string;
  /** Something the user must act on after the save (e.g. their Dynamics language could not be switched back). */
  warning?: string;
  /**
   * Saved, but the page may not show it yet; nothing to try again or undo (a process could not be updated after its
   * name was saved, so the page may show the old process name).
   */
  notice?: string;
  ms: number;
  historyId?: string;
}

export interface Issue {
  change: Change;
  level: 'error' | 'warn';
  message: string;
  /** A warning about how labels like this one are saved (language switch, ribbon import), worded for all of them: said once. */
  general?: boolean;
  /**
   * An error only because a text its stand-in is made of isn't loaded (model.ts StandIn.unloaded): the change is held
   * back ('skipped'), never refused for good, and loading that text lets it through.
   */
  unloaded?: boolean;
}

/** Unpublished work (by others, or anyone's earlier work on the components being translated) that a publish would also publish. */
export interface PendingWork {
  entity: string;
  /** `mine`: one of the components the changes edit (work pending on it goes live with them). */
  items: Array<{ kind: 'form' | 'view' | 'chart'; name: string; mine?: boolean }>;
}

export interface HistoryItem {
  key: string;
  comp: string;
  kind: Kind;
  lcid: Lcid;
  /** The title the Publish dialog showed over the label. */
  title: string;
  /** Where it showed the label (its row header's place, review.ts whereOf); absent when none, and in older entries. */
  where?: string;
  before: string;
  after: string;
  /**
   * `before` was a translation stored empty (a metadata description saved empty, core/model.ts storedEmpty), not no
   * translation: Undo saves it empty again. Absent where `before` is '' for no translation, and in entries journaled
   * before such texts were kept apart: Undo then gives it its stand-in (core/saver.ts undoChange).
   */
  empty?: true;
}
export interface HistoryEntry {
  id: string;
  at: number;
  items: HistoryItem[];
  published: boolean;
  /** Set once the save has been undone. */
  undoneAt?: number;
  /**
   * Translations the save added that Dataverse can't remove and that had no stand-in (model.ts standIn: where they
   * have one, the undo writes it), so they stayed when it was undone.
   */
  kept?: number;
}

export interface SaveRunOptions {
  signal: AbortSignal;
  publish: boolean;
  /** Change ids (`${key}#${lcid}`) to write despite a conflict. */
  force?: Set<string>;
  /**
   * An undo: the ids of the labels changed since the publish that the user chose to undo anyway (rebased on the text
   * read then): written like the others, so the stand-ins count their earlier texts (SaverApi.prepare).
   */
  anyway?: ReadonlySet<string>;
  onProgress(p: SaveProgress): void;
  /** Called as each change finishes, for live per-row status. */
  onResult?(r: ChangeResult): void;
  /** How the journal names a label, for Recent publishes (the Publish dialog's row header). Default: its title, no place. */
  describe?(s: Slot): { title: string; where: string };
}

/** How SaverApi.prepare measures changes: as a save of them (default) or as an undo. */
export interface PrepareOptions {
  /** As an undo (its messages are worded for it). */
  undo?: boolean;
  /** As SaveRunOptions.force and .anyway: written although changed since. */
  force?: ReadonlySet<string>;
  anyway?: ReadonlySet<string>;
  /** Texts read since the labels were loaded, by change id (the Undo question's reads): they count as the server's. */
  now?: ServerTexts;
}

/** Changes as a run of them writes them (SaverApi.prepare). */
export interface Prepared {
  /** Each change as it is written, in the order given: an emptied translation Dataverse can't remove as its stand-in. */
  written: Change[];
  /** Blocking errors and warnings, each for the change given (not the one written). */
  issues: Issue[];
  /** The texts the stand-ins are measured by: those the run writes, else the server's (core/saver.ts saveText). */
  text: TextOf;
}

export interface SaverApi {
  /**
   * Blocking errors (blank base label, too long, read-only, an emptied translation with no stand-in) and warnings
   * (whitespace, global choice, language switch, ribbon import), each for the change given; an emptied translation
   * Dataverse can't remove is checked as the stand-in it is saved as (core/saver.ts withStandIns), measured by the texts
   * a run of these changes leaves on the server (prepare).
   */
  validate(changes: Change[], o?: PrepareOptions): Issue[];
  /**
   * The changes as a save (or undo) of them writes them, with their issues and the texts their stand-ins are made of,
   * worked out as the run does: what the Publish dialog and the Undo question show is what the run writes.
   */
  prepare(changes: Change[], o?: PrepareOptions): Prepared;
  /** Components that would be published for these changes. */
  publishTargets(changes: Change[]): PublishSet;
  /**
   * Unpublished forms, views and charts on the tables that would be published, the ones being translated included.
   * Rejects when any of its reads fails: "none found" must never stand for "not checked".
   */
  pendingWork(changes: Change[], signal?: AbortSignal): Promise<PendingWork[]>;
  save(changes: Change[], o: SaveRunOptions): Promise<SaveReport>;
  history(): HistoryEntry[];
  /**
   * The server text of each change now, by change id, read as its writer reads right before writing; writes nothing
   * (Recent publishes › Undo shows it first). A change whose read failed, or whose writer has no read, maps to an Error.
   */
  current(changes: Change[], signal?: AbortSignal): Promise<ServerTexts>;
  /**
   * Writes the "before" values of a past save back (same safety checks); a translation it added that Dataverse can't
   * remove is written as its stand-in.
   */
  undo(entry: HistoryEntry, o: SaveRunOptions): Promise<SaveReport>;
}

// ---- Import / export ----

export interface ImportRow {
  sheet: string;
  row: number;
  /** Resolved slot key, or '' when the row could not be matched. */
  key: string;
  values: Record<number, string>;
  /** Why the row was skipped ('' when matched). */
  reason: string;
}

export interface ParsedImport {
  format: 'easy-translator' | 'translator' | 'csv';
  fileName: string;
  languages: Lcid[];
  /** Raw rows before matching (format specific). */
  rows: unknown[];
  /** What must be loaded so every row can be matched (read-only labels too, so their rows are skipped with the reason). */
  scope: Scope;
}

export interface ImportResult {
  staged: number;
  unchanged: number;
  skipped: ImportRow[];
}

export interface IoApi {
  /** Easy Translator compatible .xlsx (plus extra sheets for kinds Easy Translator lacks). Uses current values (pending edits applied). */
  exportWorkbook(slots: Slot[], langs: Lcid[], fileName: string): Promise<Blob>;
  exportCsv(slots: Slot[], langs: Lcid[]): Blob;
  /** Parses an .xlsx (Easy Translator or ours) or .csv file. */
  parse(file: File): Promise<ParsedImport>;
  /** Stages the file's values as pending edits (call after loading `parsed.scope`). Never saves. */
  apply(parsed: ParsedImport, store: Store): ImportResult;
}

/** A main view (page inspector or workbench). */
export interface View {
  el: HTMLElement;
  /** Called when the view becomes visible. */
  activate(): void;
  /** Called when the view is hidden. */
  deactivate(): void;
  destroy(): void;
  /** Opens/focuses a component's editor inside the view. Return false to let the app open its own editor sheet. */
  edit?(comp: string, focusLcid?: Lcid): boolean;
  /** Show the app footer (pending count, undo, Review & save) under this view. Default true. */
  footer?: boolean;
}

/** Factories the app receives from main.ts. */
export interface AppDeps {
  providers: ProvidersApi;
  saver: (app: AppApi) => SaverApi;
  io: IoApi;
  /** The page view is translation mode (no window); the Workbench is a window view. */
  views: { page: CreatePageMode; workbench: (app: AppApi) => View };
}
