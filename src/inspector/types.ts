// Contracts of the in-page translation mode (every module of the page track codes against these).
// The user clicks a highlighted label on the page and translates it in a small popup next to it. Edits are
// staged; one "Review and publish" saves, publishes and refreshes. Design: docs/ARCHITECTURE.md §5.4.

import type { Kind, Lcid, Slot } from '../core/model';
import type { IconName } from '../ui/dom';
import type { AppApi } from '../ui/types';

/** What clicking a label does in translation mode. */
export type Role = 'label' | 'tab' | 'nav' | 'command' | 'stage' | 'header' | 'value' | 'option';

/**
 * How a label is marked on the page: a tinted box around its text only.
 * ok = translated, missing = empty in the target language, edited = staged change (not published yet),
 * error = a publish attempt failed for it, builtin = Microsoft's built-in text (a language pack's, already in every
 * installed language: grey, its popup says so), ro = can't be translated here (grey and dotted like builtin, its popup
 * gives the reason), na = not loaded / unknown (no mark).
 */
export type Look = 'ok' | 'missing' | 'edited' | 'error' | 'builtin' | 'ro' | 'na';

/** A translatable label found on the page. */
export interface Anchor {
  /** Element showing the label: the mark is drawn around its text. */
  el: Element;
  comp: string;
  kind: Kind;
  /** Key of the slot whose text is shown (e.g. a table's plural name on a sitemap entry). */
  key: string;
  /** Larger element that belongs to this label (field container, section…). Never drawn and never a click zone. */
  hit?: Element;
  /**
   * The element that holds the label for clicks and hover (default `el`): a pointer is on the label only on its text;
   * beside the text, a click in the zone reaches the page, or does nothing where the zone acts (a button, a tab, a
   * link…). Never contains inputs, except the closed choice and Yes/No controls of a value anchor, whose whole control
   * is the zone.
   */
  zone?: Element;
  role: Role;
  /** The label's own text node: the mark hugs its line boxes (falls back to a Range over `el`'s contents). */
  text?: Text;
  /**
   * What `text` showed when the label was found, never a staged text the preview swapped in (Preview.textOf): a
   * related menu item's popup tells what the page shows by it.
   */
  orig?: string;
  /**
   * Only these characters of `text` are the label: a text node that shows several labels (the values of a
   * multi-select, the two names of a linked-table column header). Its anchors share `el` and `zone`; a click in the
   * zone goes to the part under the pointer, none between or past them.
   */
  part?: Part;
  /** Slot key to focus in the popup (e.g. the option a grid cell shows). */
  focus?: string;
  /**
   * The button that opens one of the lists the page is switched with (the areas, the record's forms, a grid's views:
   * lists.ts), or an item of such a list: what its popup's Change… or Open needs, captured when the label is found.
   */
  sw?: Switch;
}

/** The lists the page is switched with (lists.ts): the app's areas, the record's forms, a grid's views. */
export type ListKind = 'area' | 'form' | 'view';

/**
 * A selector's own label (`id` ''), or an item of the list it opens. Open is pressed once that list has closed, its items
 * gone with it: what switching needs is kept here, never read from the item's element then.
 */
export interface Switch {
  list: ListKind;
  /** An item's area, form or view id, as its element names it; '' on the button that opens the list. */
  id: string;
  /** The button that opens the list: the selector's own, or (an item's) the one that had its list open; null when unknown. */
  opener: Element | null;
  /** Selectors that find that button and the item again once Dynamics rendered them anew ('' where none is needed). */
  find: string;
  item: string;
}

/** A run of characters of one text node: [start, end), and the text they held when it was found. */
export interface Part {
  start: number;
  end: number;
  text: string;
}

/**
 * "2 choices changed": drawn after a form field whose column has choices with a change that isn't published (one
 * per field copy, inspector/pill.ts fieldPills). The field may show another value, or none: nothing else on the
 * page says a choice of it changed.
 */
export interface Pill {
  /**
   * Where it goes, first that shows wins: just right of the text of the field's value, else of its label. A click
   * on it is a click on that label.
   */
  at: Anchor[];
  /**
   * The field's container (its label's `hit`: a form cell, the header strip's item, a process step): the pill stays
   * inside it, so it never runs onto the next field.
   */
  field: Element;
  text: string;
  /** How many: all a pill shows where its text doesn't fit ("2", its text in the tooltip). */
  n: number;
  /** Its tooltip: "1 choice of this field changed, not published yet". */
  title: string;
  /** Green like an edited mark; red when one of them failed to publish. */
  tone: 'edited' | 'error';
}

// ---- Overlay (inspector/overlay.ts implements OverlayApi) ----

export interface OverlayHooks {
  /** How an anchor is marked right now. */
  look(a: Anchor): Look;
  /** The pills to draw, read with the looks (paint), never per frame. */
  pills?(): Pill[];
  /** A click on a label's text (or F2 in its zone) while translation mode is on and Alt is not held. */
  open(a: Anchor): void;
  /** The page changed: added or changed nodes, and whether nodes were removed. */
  mutated(roots: Node[], removed: boolean): void;
  /** Our own hosts (app layer): events inside them are never intercepted, and they are never scanned. */
  ours(): Node[];
  /** Alt pressed or released: while it is held the page works as usual. */
  alt?(held: boolean): void;
}

export interface OverlayApi {
  start(): void;
  /** Removes everything from the page (also used by destroy). */
  stop(): void;
  /** Shows these anchors (marks of anchors that are still there are kept). */
  sync(anchors: Anchor[]): void;
  /** Re-reads every anchor's look. */
  paint(): void;
  /** Emphasises a component's label marks (hover in the list); '' clears. */
  flash(comp: string): void;
  /** Pulses one label's mark for a moment (found from the list); null stops it. */
  pulse(a: Anchor | null): void;
  /**
   * The component whose popup is open; null clears. `a` = the clicked label: only its mark keeps the hover look
   * (other labels of the same component stay as they are).
   */
  active(comp: string | null, a?: Anchor | null): void;
  /** The anchor's zone rect from the last frame (viewport coordinates), null when not visible. */
  rectOf(a: Anchor): DOMRect | null;
  /** Called after each position update (popups follow their label). Returns an unsubscribe function. */
  onFrame(fn: () => void): () => void;
  /** Runs `fn` (DOM changes of our own) without the mutation observer reporting it. */
  quiet(fn: () => void): void;
  /** Hides the marks and stops intercepting clicks (the Workbench window is open); false resumes. */
  pause(on: boolean): void;
  /** Re-measures for the next `n` frames. */
  invalidate(n?: number): void;
}

// ---- Page mode (inspector/mode.ts: createPageMode) ----

/** Groups of the "All labels on this page" list, in display order. */
export type PageGroup = 'Form' | 'Choices' | 'Command bar' | 'Navigation' | 'Process' | 'Table and views';

export interface PageItem {
  comp: string;
  /** The slot shown as the component's label. */
  main: Slot;
  group: PageGroup;
  /** Rendered on the page right now (else: another tab, hidden field, other stage…). */
  visible: boolean;
  look: Look;
  /**
   * A change staged elsewhere, whose label isn't on this one: the page it was made on in translation mode, in words
   * ("Contact · Main form"), or "Workbench" when it wasn't made on a page (the Workbench, an import, the editor): a click
   * on that one navigates nowhere, it opens in the editor. The list shows these after the page's own labels, under
   * "Changed on other pages".
   */
  away?: string;
}

export interface PageNote {
  tone: 'info' | 'warn' | 'error';
  text: string;
  action?: string;
  run?(): void;
}

export interface PageMode {
  /** Starts translation mode: overlay, page loads (every language, no prompt), interception. */
  start(): void;
  /** Leaves translation mode (overlay removed). */
  stop(): void;
  destroy(): void;
  /** True while the Workbench window is open: marks hidden, no interception. */
  pause(on: boolean): void;
  /**
   * Finds the component's label on the page (scrolled into view, or its form tab, the header's flyout or its process
   * stage opened), pulses it and opens its popup next to it; next to the list row (`from`) or docked when the page
   * can't show it. A change made on a page in translation mode is found exactly where it was made: Dynamics' navigation
   * goes to that page first when it is another one, then its form tab or related view and the flyout its label was in
   * are opened again (reveal.ts targetOf, routeTo, backStep). False when it is not on this page and wasn't made on a
   * page (the app's editor opens it instead).
   */
  open(comp: string, o?: { from?: Element; focus?: string; lcid?: Lcid }): boolean;
  /** Closes the open popup (if any). */
  close(): void;
  /** Stops a find that open() is still waiting on (its label not shown yet, or the page it went to not there yet): no popup opens for it. */
  cancelFind(): void;
  /** The page's labels, then the changes staged on other pages (`away`). */
  items(): PageItem[];
  /** all = the list's rows, missing = empty in the target language, pending = staged changes in the store. */
  counts(): { all: number; missing: number; pending: number };
  /** Page loads still running. */
  loading(): boolean;
  /** Loader problems only (short, with Try again). */
  notes(): PageNote[];
  /** e.g. "Service request · Main form", '' when unknown. */
  title(): string;
  flash(comp: string): void;
  on(fn: (what: 'items' | 'page' | 'alt' | 'loading') => void): () => void;
}

// ---- Popup content (inspector/describe.ts: describe) ----

/** The popup's secondary footer button, which acts on the page (mode.ts runAction). */
export type Action = 'Open' | 'Show stage' | 'Show tab' | 'Change area' | 'Change form' | 'Change view';

/** One editable text in the popup (one slot, shown in the base and target languages). */
export interface Block {
  /** Slot key. */
  key: string;
  /** 'Label' | 'Tooltip' | 'Column name' | 'Name' | 'Plural name' | 'Description' | 'Title' … */
  heading: string;
  /** Multi-line input (auto-growing textarea). */
  long: boolean;
  /** Where a change applies, shown muted after the heading: "this form only", "everywhere"… */
  note?: string;
  /**
   * Field blocks only, when the same column is on the form more than once: the other copies' cell keys.
   * `on` = the default of the checkbox (true when every copy has the same text in every shown language now).
   */
  also?: { keys: string[]; on: boolean };
  /**
   * What the page shows for this text in the user's language where it has none there and the store can't tell
   * (a built-in related menu item a form renames shows language-pack text, LIVE-FINDINGS 80): the placeholder of
   * that language's input.
   */
  pageText?: string;
}

export interface CalloutModel {
  comp: string;
  /** The label's current text (user's language, else base). */
  title: string;
  /** One muted word: 'Field', 'Tab', 'Section', 'Column', 'Choice', 'Button', 'Menu item', 'Stage', 'Table'… */
  kind: string;
  icon: IconName;
  blocks: Block[];
  /** Options of a choice / Yes/No / status column (slot keys of their labels, in option order). */
  choices?: {
    keys: string[];
    /** Number of columns sharing this (global) choice; shown as "Shared by N columns" when > 1. */
    shared?: number;
    /** Slot key to focus (the value the user clicked). */
    focus?: string;
    /** The disclosure starts open (opened from a choice value). */
    open: boolean;
  };
  /** Why nothing can be edited ('' / undefined = editable). Shown as one muted line. */
  readOnly?: string;
  /** One plain line instead of texts to translate (Microsoft's built-in text). */
  note?: string;
  /**
   * Secondary footer button, offered only where pressing it does something: 'Open' (a related menu item's view, a
   * sitemap entry, the Related tab's menu, an area, form or view of a selector's list that isn't the current one),
   * 'Show stage' (a process stage with steps whose flyout isn't open: its flyout), 'Show tab' (a tab that isn't the one
   * shown), 'Change area' / 'Change form' / 'Change view' (the label on the button that opens that list: its list).
   */
  action?: Action;
  /** Its slots are still loading. */
  loading: boolean;
}

/** Builds the popup content of a component (pure: reads app.store, app.ctx, app.prefs). */
export type DescribeFn = (app: AppApi, comp: string, a?: Anchor) => CalloutModel;

/** The look of a component on the page (inspector/status.ts: look). */
export type LookFn = (app: AppApi, comp: string) => Look;
/** The list group of a component (inspector/status.ts: groupOf). */
export type GroupFn = (s: Slot) => PageGroup;

// ---- Popup (ui/callout.ts: openCallout) ----

export interface CalloutHost {
  /** Re-read on store 'slots' events. */
  model(): CalloutModel;
  /** The label's zone rect; null = dock above the bar. */
  rect(): DOMRect | null;
  /**
   * The box of our own UI that rect() is in, read right after it (the list sheet, docked or floating, while the popup
   * points at its row): the popup goes beside it, never over it. Null or absent: rect() is on the page.
   */
  beside?(): DOMRect | null;
  /** Language input to focus first (default: the first block's, in the language the page is shown in). */
  focusLcid?: Lcid;
  /** Slot key to focus first (e.g. the option shown in a grid cell). */
  focusKey?: string;
  /**
   * The model's secondary action (Open, Show stage, Show tab, Change …): it acts on the page and closes the popup when it could.
   * False when it could do nothing (the popup stays open).
   */
  action(): boolean;
  /** The popup closed (Done, ✕, Esc, Enter, click outside). Typed text stays staged in the store. */
  close(): void;
  /**
   * The popup closed with the focus in it, and what had the focus before has left the page (an item of a selector's
   * list reached with F2: the list closed as the popup took the focus). Focuses where the keyboard goes on from (that
   * list's button); false when there is no such place.
   */
  refocus?(): boolean;
}

export interface Callout {
  el: HTMLElement;
  /** Re-places it next to its label (called every overlay frame). */
  reposition(): void;
  /** Re-renders from the host's model (slots replaced, statuses changed). */
  refresh(): void;
  destroy(): void;
}

// ---- Bar (ui/bar.ts: createBar) and list (inspector/pagelist.ts: openPageList) ----

export interface BarHooks {
  /** ✕: closes the translator (the app asks first when changes are staged). */
  exit(): void;
  /** Opens / closes "All labels on this page". */
  list(): void;
  /** Opens the Workbench (spreadsheet) window. */
  workbench(): void;
  /** Opens the Publish dialog for every staged change. */
  publish(): void;
  /** Opens "Recent publishes" (history with Undo). */
  history(): void;
}

export interface BarApi {
  el: HTMLElement;
  /** Hides the bar (Workbench window open) or shows it again. */
  hide(on: boolean): void;
  /** Pulses the bar (bookmark clicked while it is open). */
  pulse(): void;
  destroy(): void;
}

export interface PageListApi {
  el: HTMLElement;
  refresh(): void;
  rowOf(comp: string): HTMLElement | null;
  close(): void;
}

export type CreatePageMode = (app: AppApi) => PageMode;
export type OpenCallout = (app: AppApi, host: CalloutHost) => Callout;
export type CreateBar = (app: AppApi, mode: PageMode, o: BarHooks) => BarApi;
export type OpenPageList = (app: AppApi, mode: PageMode, o: { close(): void }) => PageListApi;
