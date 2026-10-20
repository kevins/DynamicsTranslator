// Contracts of the Workbench rebuilt as the XrmToolBox Easy Translator bookmarklet workbook:
// a Setup screen ("Export options"), then one Excel-like sheet per type with key columns and one column per
// language, sheet tabs at the bottom, and Save and Publish. Design: docs/ARCHITECTURE.md §5.5.

import type { Kind, Lcid, Slot } from '../core/model';
import type { Store } from '../core/store';
import type { Scope } from '../providers/types';

// ---- Sheets (workbench/sheets.ts) ----

/** A key column of a sheet (the old UI's id / logical-name columns). */
export interface KeyCol {
  /** Stable; the remembered width is stored under `${sheet.id}:${col.id}`. */
  id: string;
  /** Header text, e.g. 'Attribute Logical Name'. */
  name: string;
  /** Default width (px). */
  w: number;
  /** GUID-like column: monospace, 11px, grey, ellipsis, full value as tooltip. */
  mono?: boolean;
  /** Stays visible in a narrow grid (< 720px). */
  keep?: boolean;
  get(s: Slot, x: SheetCtx): string;
}

export interface SheetCtx {
  store: Store;
  /** Display name of a table (logical name when unknown). */
  tableName(e: string): string;
}

export interface SheetDef {
  /** 'entities', 'attributes', … */
  id: string;
  /** Tab text = Excel sheet name ('Entities', 'Forms Fields', …). */
  name: string;
  kinds: Kind[];
  /** Further restricts the kinds (e.g. N:N vs 1:N relationships). */
  match?(s: Slot): boolean;
  cols: KeyCol[];
  /** Type column text (default: the slot's prop, e.g. 'DisplayName'; Attributes show 'Description (tooltip)'). */
  type?(s: Slot): string;
  /** One line shown in the empty state / help for this sheet. */
  help?: string;
}

export type LabelMode = 'both' | 'names' | 'descriptions';
export type RowsMode = 'all' | 'same' | 'sameOrBlank' | 'blank' | 'pending' | 'problems';

/** A checkbox of the Setup screen and the kinds it loads. */
export interface SetupOpt {
  id: string;
  label: string;
  kinds: Kind[];
  /** Needs at least one checked entity (entity-related options). */
  needsTable: boolean;
  /** Checked by default. */
  def: boolean;
}

// ---- State (workbench/scope.ts: loadState / saveState, localStorage `dxt:wb2:<org>`) ----

export interface WbState {
  source: 'all' | 'solution';
  sol: string;
  solName: string;
  /** Checked entity logical names. */
  tables: string[];
  /**
   * The load source whose entity list they were checked in (scope.ts listKey: 'all', or 'solution|<id>'). Missing in
   * state saved before it was kept: they then belong to the remembered source.
   */
  tablesFor?: string;
  /** SetupOpt id -> checked. */
  opts: Record<string, boolean>;
  labelMode: LabelMode;
  rows: RowsMode;
  /** Include read-only labels (from managed solutions or not customizable). */
  ro: boolean;
  /** Remembered column widths: `${sheet}:${col}` for key columns, `l<lcid>` for languages. */
  widths: Record<string, number>;
  /** Active sheet id. */
  sheet: string;
  /** Setup screen shown (vs the workbook). */
  setup: boolean;
}

// ---- Setup screen (workbench/scope.ts: createSetup) ----

export interface SetupApi {
  el: HTMLElement;
  /** Loads the entity list and solutions (once). */
  init(): Promise<void>;
  /** Display name of a loaded table ('' when unknown). */
  tableName(logical: string): string;
  /** The scope to extract, or the error text to show ("Select at least one entity…"). */
  scope(): Scope | string;
  /** Re-reads state shown in the Setup screen (e.g. the language prefs changed from the title bar). */
  sync(): void;
  destroy(): void;
}

// ---- Grid (workbench/grid.ts: createGrid) ----

export interface GridApi {
  el: HTMLElement;
  /** Columns of a sheet: '#', its key columns, Type, then one column per language (base first). */
  setSheet(sheetId: string, cols: KeyCol[], typeText: (s: Slot) => string, langs: Lcid[], target: Lcid): void;
  /** Rows to show; the active cell stays on the same slot when it is still there. */
  setRows(rows: Slot[]): void;
  /** Re-renders the visible rows (after edits or status changes). */
  refresh(): void;
  /** Scrolls to, selects and (with `flash`) briefly highlights a slot's cell; false when the slot is not in the rows. */
  reveal(key: string, lcid?: Lcid, flash?: boolean): boolean;
  /** The active cell's slot key and language, for remembering the cursor per sheet. */
  cursor(): { key: string; lcid: Lcid } | null;
  focus(): void;
  /** Commits an open cell editor. */
  commit(): void;
  destroy(): void;
}

export interface GridOptions {
  /** Column widths (mutated on resize), see WbState.widths. */
  widths: Record<string, number>;
  onWidths(): void;
  /** Selection summary ('' for a single cell). */
  onSel(text: string): void;
  /** Values of key columns (table display names). */
  ctx: SheetCtx;
  /**
   * Reads again the form labels whose read failed (the message bar's Read again). The notice of a "Not loaded" cell
   * offers it where that read would bring the cell (grid.ts rereadable); without it the notice has no button.
   */
  readAgain?(): void;
}
