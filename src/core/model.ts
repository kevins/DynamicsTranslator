// The data model shared by every part of the translator.
//
// A Slot is one translatable piece of text (for example the display name of a column,
// the label of a form tab or the title of a sitemap area). Its `labels` hold the value
// for each language exactly as it was on the server when it was loaded; pending edits
// live in the Store, never in the slot, so the original is always available for
// conflict checks and undo.

import { columnOf } from './column';
import { lcidName } from './lcid';

export type Lcid = number;
/** Label text per language. A missing key means "no label in that language". */
export type Labels = Record<number, string>;

export type Kind =
  // table metadata
  | 'entity' | 'attribute' | 'relationship' | 'option' | 'globaloptionset' | 'globaloption' | 'boolean' | 'state' | 'status'
  // record-based components (labels stored as localized columns or in XML)
  | 'view' | 'chart' | 'form' | 'tab' | 'section' | 'field' | 'navitem'
  | 'dashboard' | 'dtab' | 'dsection' | 'dfield'
  | 'app' | 'area' | 'group' | 'subarea'
  | 'bpf' | 'stage' | 'step'
  | 'ribbon' | 'command'
  // other localizable records
  | 'envvar' | 'customapi';

/** Which text of the component a slot holds. */
export type Prop = 'DisplayName' | 'DisplayCollectionName' | 'Description' | 'Label' | 'Name' | 'Title' | 'ToolTipTitle' | 'ToolTipDescription' | 'Alt' | 'Hint';

export interface Slot {
  /** Globally unique, stable across reloads: `${kind}|${component id}|${prop}`. */
  key: string;
  kind: Kind;
  prop: Prop;
  /** Logical name of the table the component belongs to ('' when none, e.g. global choices, sitemap). */
  entity: string;
  /** Identity of the component; slots with the same `comp` are edited together in one card. */
  comp: string;
  /**
   * Save group; changes with the same group are written in a single server operation
   * (one metadata PUT, one form XML update, one sitemap update...).
   */
  group: string;
  /** Component name in the user's language. */
  title: string;
  /** Breadcrumb from the outermost container, e.g. ["Account", "Account main form", "Summary"]. */
  path: string[];
  /** Secondary identifier shown in grey, e.g. the logical or schema name. */
  sub: string;
  /** Server values when loaded. */
  labels: Labels;
  /** Empty when editable, otherwise the reason it is read-only. */
  readOnly: string;
  /** True when the base language label must not be blank (most metadata labels). */
  baseRequired: boolean;
  /** Maximum length accepted by Dataverse; 0 when unknown. */
  max: number;
  /** Sort order inside the component type (document order on forms, option order in choices...). */
  order: number;
  /** Provider-private locator (ids, XML node ids, attribute types...). */
  ref: any;
}

export interface Language {
  lcid: Lcid;
  name: string;
  isBase: boolean;
}

/** One language of one slot that the user changed. */
export interface Change {
  slot: Slot;
  lcid: Lcid;
  /**
   * Value the user started from: the server text the edit was made on (the store's remembered base, Store.before),
   * not whatever a reload brought since. The writers compare it with a fresh read and report a conflict when they differ.
   */
  before: string;
  /** Value to write. */
  after: string;
  /**
   * Set when `after` stands in for an emptied translation Dataverse can't remove (standIn, applied by the saver before
   * its checks and the writers): where that text comes from, and the blank text the staged edit held (`typed`), so the
   * store drops that edit once the stand-in is saved.
   */
  standIn?: { from: StandInFrom; typed: string };
  /**
   * An Undo that puts back no translation at all (the publish added this one where there was none: its journal item has
   * `before` '' without `empty`, core/saver.ts undoChange). Emptied where it would be saved empty (savesEmpty), it gets
   * its stand-in instead, as any translation Dataverse can't remove: that language's users see again what they saw. One
   * whose stand-in is an empty base text is saved empty after all (core/saver.ts withStandIns drops the mark): they saw
   * no text there, which '' gives them.
   */
  untranslated?: true;
  /**
   * The edit was made where its language had no label at all (`before` '' for none), on a label that keeps a '' stored
   * there apart from none (keepsEmpty, Store.changes): a '' found there at save is someone else's text (a description
   * they saved empty since), a conflict like any other (providers/metadata.ts compare).
   */
  beforeMissing?: true;
}

export type Outcome = 'saved' | 'unchanged' | 'conflict' | 'error' | 'skipped';
export interface ChangeResult {
  change: Change;
  outcome: Outcome;
  /** For conflicts: the value now on the server. */
  server?: string;
  message?: string;
  /**
   * Found already as asked ('unchanged', a text other than the one the edit was made on), and nothing says this saver ever
   * sent it (core/saver.ts: no earlier attempt whose answer was lost): someone else's text. Not journaled as this
   * publish's change, so its Undo never puts back what this run didn't write.
   */
  found?: true;
}

/** Components that must be published after a save. */
export class PublishSet {
  entities = new Set<string>();
  optionsets = new Set<string>();
  sitemaps = new Set<string>();
  dashboards = new Set<string>();
  appmodules = new Set<string>();
  ribbons = false;
  /**
   * Business process flows whose name was written (workflow id → its name, shown while it is updated). Not published:
   * Dataverse serves the app a compiled copy of a process that only an update of the process itself rebuilds
   * (LIVE-FINDINGS 83), so the saver updates each one after the publish (publish.ts rebuildProcess). `empty` leaves
   * them out: it says whether PublishXml has anything to do.
   */
  processes = new Map<string, string>();
  get empty(): boolean {
    return !this.entities.size && !this.optionsets.size && !this.sitemaps.size && !this.dashboards.size && !this.appmodules.size && !this.ribbons;
  }
}

/** Human names for kinds, singular and plural. */
export const KIND_NAMES: Record<Kind, [string, string]> = {
  entity: ['Table', 'Tables'],
  attribute: ['Column', 'Columns'],
  relationship: ['Relationship', 'Relationships'],
  option: ['Choice option', 'Choice options'],
  globaloptionset: ['Global choice', 'Global choices'],
  globaloption: ['Global choice option', 'Global choice options'],
  boolean: ['Yes/No option', 'Yes/No options'],
  state: ['Status option', 'Status options'],
  status: ['Status reason', 'Status reasons'],
  view: ['View', 'Views'],
  chart: ['Chart', 'Charts'],
  form: ['Form', 'Forms'],
  tab: ['Form tab', 'Form tabs'],
  section: ['Form section', 'Form sections'],
  field: ['Form field', 'Form fields'],
  navitem: ['Form navigation item', 'Form navigation items'],
  dashboard: ['Dashboard', 'Dashboards'],
  dtab: ['Dashboard tab', 'Dashboard tabs'],
  dsection: ['Dashboard section', 'Dashboard sections'],
  dfield: ['Dashboard component', 'Dashboard components'],
  app: ['App', 'Apps'],
  area: ['Sitemap area', 'Sitemap areas'],
  group: ['Sitemap group', 'Sitemap groups'],
  subarea: ['Sitemap subarea', 'Sitemap subareas'],
  bpf: ['Business process flow', 'Business process flows'],
  stage: ['Process stage', 'Process stages'],
  step: ['Process step', 'Process steps'],
  ribbon: ['Command button (classic)', 'Command buttons (classic)'],
  command: ['Command button', 'Command buttons'],
  envvar: ['Environment variable', 'Environment variables'],
  customapi: ['Custom API', 'Custom APIs'],
};

export const PROP_NAMES: Record<Prop, string> = {
  DisplayName: 'Display name',
  DisplayCollectionName: 'Plural name',
  Description: 'Description',
  Label: 'Label',
  Name: 'Name',
  Title: 'Title',
  ToolTipTitle: 'Tooltip title',
  ToolTipDescription: 'Tooltip description',
  Alt: 'Accessibility text',
  Hint: 'Hint',
};

export const slotKey = (kind: Kind, id: string, prop: Prop): string => `${kind}|${id}|${prop}`;

/**
 * Why a label of a component that comes from a managed solution is read-only, whatever its managed properties allow:
 * any change to it here would be an unmanaged customization layered on top of the solution's component, which this
 * tool never makes: such texts are translated in the environment where the solution is developed. Every loader, writer,
 * the saver and the store give these same words.
 */
export const MANAGED = 'From a managed solution: a translation here would add an unmanaged layer on top of it. Translate it where its solution is developed.';

/**
 * Whether a slot's component comes from a managed solution: `ref.managed`, which every loader sets from the component's
 * own ismanaged / IsManaged (a form's or dashboard's for its tabs, sections, cells and navigation items, a sitemap's
 * for its items, a process's for its stages and steps). Such a label is never staged, saved or undone.
 */
export const isManaged = (s: Slot): boolean => s.ref?.managed === true;

/**
 * Whether a non-base translation can be removed (saving '' or only whitespace removes it, so users of that
 * language see the base text again). Verified live (LIVE-FINDINGS 31, 37, 39): Dataverse merges these labels
 * per language, so a write can add or change a language but never delete one — metadata labels (MergeLabels
 * false keeps them; '' is stored and shown as a blank label), form tab/section and field (cell) labels (a
 * form update without the label, or with it empty, keeps it in any UI language; dashboard cells assumed the
 * same), and classic ribbon titles (solution and translation imports keep them). Everything else can: SetLocLabels ''
 * deletes, and navigation item and sitemap labels are removed with their element (findings 33, 38). With `l`, also
 * false for a process stage or step translation (stays). Where it is false, an emptied translation is written as its
 * stand-in instead (standIn), so the page looks as it would without one; a metadata description's is saved empty
 * (savesEmpty).
 */
export const canClear = (s: Slot, l?: Lcid): boolean => !NO_CLEAR.has(s.kind) && !stays(s, l);
const NO_CLEAR = new Set<Kind>(['entity', 'attribute', 'relationship', 'option', 'globaloptionset', 'globaloption', 'boolean', 'state', 'status', 'tab', 'section', 'dtab', 'dsection', 'field', 'dfield', 'ribbon']);
/** Table metadata, whose labels Dataverse stores per language, a '' as a blank label (LIVE-FINDINGS 31, 32). */
const METADATA = new Set<Kind>(['entity', 'attribute', 'relationship', 'option', 'globaloptionset', 'globaloption', 'boolean', 'state', 'status']);

/**
 * A metadata component's description: a column's tooltip, a table's description, a choice option's, a status's or
 * status reason's, a Yes/No option's, a global choice's and its options' (a relationship has none). The owner's rule for
 * them: a non-base translation emptied there (or left only spaces) is saved empty, whatever the base-language text is,
 * so that language's users see no tooltip or description there (LIVE-FINDINGS 32: '' is stored and shown as a blank
 * label; a missing language shows the base text). No stand-in, no refusal (savesEmpty). A '' stored there is loaded
 * and kept as a text of its own (providers/metadata.ts, core/store.ts), apart from a missing language: storedEmpty.
 * Names and labels keep the stand-in rule (standIn), as do form and dashboard labels and classic ribbon tooltips (an
 * import can't store an empty title, findings 39, 69); a record's description (a view's, a chart's, a process's) is
 * removed (canClear).
 */
export const keepsEmpty = (s: Pick<Slot, 'kind' | 'prop'>): boolean => s.prop === 'Description' && METADATA.has(s.kind);

/**
 * Whether emptying the `l` translation of `s` saves it empty (keepsEmpty): never in the base language (its own rules),
 * nor for an Undo that puts back no translation at all (`untranslated`, Change.untranslated), which gets its stand-in.
 */
export const savesEmpty = (s: Pick<Slot, 'kind' | 'prop'>, l: Lcid, base: Lcid, untranslated?: boolean): boolean => l !== base && !untranslated && keepsEmpty(s);

/**
 * A translation stored empty on the server (savesEmpty, loaded or saved as ''): that language's users see no tooltip or
 * description there, on purpose. It counts as translated (the page's marks, the popup, the Workbench); a missing one
 * (never translated) shows the base text and counts as missing.
 */
export const storedEmpty = (s: Slot, l: Lcid, base: Lcid): boolean => savesEmpty(s, l, base) && s.labels[l] === '';

/** What a metadata description is to its users (keepsEmpty): a column's shows as its tooltip on forms. */
const emptyWhat = (s: Pick<Slot, 'kind'>): string => (s.kind === 'attribute' ? 'tooltip' : 'description');

/**
 * The placeholder of a translation saved or stored empty (savesEmpty, storedEmpty): "No French tooltip", "No French
 * description". `lang`: the language's name as the view names it.
 */
export const noneText = (s: Pick<Slot, 'kind'>, lang: string): string => `No ${lang} ${emptyWhat(s)}`;

/**
 * What saving an emptied translation does where it is saved empty (savesEmpty), in the line under its input (the popup,
 * the editor card), the Workbench's tooltip and the Publish dialog's quiet note: "Saved empty: French users see no
 * tooltip." `lang`: the language's name as the view names it.
 */
export const savedEmptyText = (s: Pick<Slot, 'kind'>, lang: string): string => `Saved empty: ${lang} users see no ${emptyWhat(s)}.`;

/**
 * savedEmptyText for an edit not saved yet, beside "Was …" (the Workbench's tooltip of a pending cell, in the words of
 * its stand-in's "Becomes “X” when you save"): "Saved empty when you save: French users then see no tooltip."
 */
export const savesEmptyText = (s: Pick<Slot, 'kind'>, lang: string): string => `Saved empty when you save: ${lang} users then see no ${emptyWhat(s)}.`;

/**
 * A process stage or step text the definition has no label for in `l`, filled from the names Dynamics keeps once
 * stored (`ref.stored`, providers/bpf.ts; LIVE-FINDINGS 83, 85): what the page shows there, and what a save of it is
 * measured against.
 */
export const keeps = (s: Slot, l?: Lcid): boolean => l !== undefined && Array.isArray(s.ref?.stored) && s.ref.stored.includes(l);

/**
 * A process stage or step translation loaded in `l` (a non-base language: callers check the base text apart, it is
 * required), in the definition or only kept (keeps): once Dynamics has stored one, removing its StepLabel never
 * deletes it and the page goes on showing it (LIVE-FINDINGS 83). It can be replaced, not removed. Where none is
 * loaded there is nothing to remove: only spaces typed there change nothing, as for any removable label.
 */
export const stays = (s: Slot, l?: Lcid): boolean => l !== undefined && (s.kind === 'stage' || s.kind === 'step') && (s.labels[l] ?? '') !== '';

/**
 * A title that gets its base-language text before any other: an app designer's placeholder in the sitemap, loaded
 * without a title in any language (providers/sitemap.ts `ref.placeholder`). A title only in another language would
 * leave the base language's users, and every language without its own, on a text nobody chose.
 */
export const namesFirst = (s: Slot): boolean => s.ref?.placeholder === true && s.prop === 'Title';

/** Why a title in another language alone is refused where namesFirst() (saver, popup and writer). */
export const baseNameFirst = (base: Lcid): string =>
  `Name it in ${lcidName(base)} too: languages without a name of their own show the ${lcidName(base)} one.`;

/**
 * Why an emptied translation of a component where canClear() is false is refused by the writers, their last guard: the
 * saver never sends them one (it writes its stand-in, or refuses it with noStandIn), but a metadata description's,
 * which is saved empty (savesEmpty).
 */
export const CANT_CLEAR_TEXT = "Dataverse can't remove a translation from this component. Type the text instead, or undo this edit.";

/** CANT_CLEAR_TEXT, or for a stage or step translation (stays()) why that one can't be removed (the process writer's guard). */
export const cantClearText = (s: Slot, l?: Lcid): string =>
  stays(s, l) ? `Dynamics keeps a ${s.kind}'s translation once it is stored: type the text you want instead.` : CANT_CLEAR_TEXT;

/**
 * True when this language's label was not read (form tab/section labels loaded without a language switch carry
 * `ref.partial`; their missing languages are unknown rather than empty). ui/editor.ts re-exports it.
 */
export function notLoaded(s: Slot, l: Lcid): boolean {
  const p = s.ref?.partial;
  return !!p && (Array.isArray(p) ? !p.includes(l) : !(l in s.labels));
}

/**
 * Where the stand-in of an emptied translation comes from (standIn): the label's own base-language text ('base'), or
 * a form cell's column name in that language ('column'), else in the base language ('columnBase').
 */
export type StandInFrom = 'base' | 'column' | 'columnBase';

/** A label's text in a language as standIn() reads it ('' for none); undefined while the label, or that language of it, isn't loaded. */
export type TextOf = (key: string, l: Lcid) => string | undefined;

/** What an emptied translation Dataverse can't remove is written as (standIn). */
export interface StandIn {
  /** The text written in its place; '' when it isn't known, and `why` says why (the change is then refused). */
  text: string;
  from: StandInFrom;
  /** Why it isn't known, as the end of a sentence (noStandIn): "its English text is empty". */
  why?: string;
  /**
   * It isn't known only because a text it is made of isn't loaded (its column's names, a tab's or section's base text
   * read without a language switch): loading that text gives it, so the change is held back, never refused for good.
   */
  unloaded?: true;
  /** It is the text it replaces already (only spaces count as no text): writing it changes nothing. */
  same?: true;
}

/** Only spaces count as no text, as the writers compare texts. */
const bare = (t: string): string => (t.trim() ? t : '');

/**
 * The owner's rule for a non-base translation emptied (or left only spaces) where Dataverse can't remove it (canClear
 * false): it is written as its stand-in, the text that language shows where the label has no translation of its own,
 * so the page looks as it would without one. A form or dashboard cell that shows a column: the column's name in that
 * language, else its base-language name (LIVE-FINDINGS 42: a cell without a label in the user's language shows its
 * column's name in that language); anything else, a process stage or step translation Dynamics keeps (stays) included:
 * the label's own base-language text. `text` reads the texts as they will be on the server after the write: the changes
 * the save or undo writes, else the server's (core/saver.ts saveText), never a pending edit it doesn't write. A stand-in
 * that isn't known (the column's names not loaded, an empty base text) comes back with `why` instead, and the change is
 * refused (held back, `unloaded`, where loading a text gives it). One that is the text it replaces already says so
 * (`same`): nothing is written. Undefined where the rule doesn't apply: the base language (its own rules), a translation
 * Dataverse can remove (removed, as before), a metadata description (saved empty, savesEmpty; not for an Undo that puts
 * back no translation, `untranslated`: Change.untranslated), a text that isn't blank, and no translation to empty
 * (`before` ''; only spaces there are refused, core/saver.ts onlySpaces; but for such an Undo, where '' is a description
 * the publish stored empty: its users saw the base text before it). The saver, the popup, the editor card, the page
 * preview, the Publish and Undo dialogs and the Workbench all use this one rule.
 */
export function standIn(s: Slot, l: Lcid, base: Lcid, before: string, after: string, text: TextOf, untranslated?: boolean): StandIn | undefined {
  if (l === base || after.trim() || (before === '' && !untranslated) || canClear(s, l) || savesEmpty(s, l, base, untranslated)) return undefined;
  const got = (x: StandIn): StandIn => (bare(x.text) === bare(before) ? { ...x, same: true } : x);
  const k = columnKey(s);
  if (k) {
    const own = text(k, l);
    const b = text(k, base);
    if (own === undefined || b === undefined) return { text: '', from: 'column', why: "its column's names aren't loaded", unloaded: true };
    if (own.trim()) return got({ text: own, from: 'column' });
    return b.trim() ? got({ text: b, from: 'columnBase' }) : { text: '', from: 'columnBase', why: `its column has no ${lcidName(base)} name` };
  }
  const b = text(s.key, base);
  if (b === undefined) return { text: '', from: 'base', why: `its ${lcidName(base)} text isn't loaded`, unloaded: true };
  return b.trim() ? got({ text: b, from: 'base' }) : { text: '', from: 'base', why: `its ${lcidName(base)} text is empty` };
}

/** The column's DisplayName slot whose name a form or dashboard cell's label stands in for (standIn); '' for any other label. */
const columnKey = (s: Slot): string => {
  const c = (s.kind === 'field' || s.kind === 'dfield') && s.prop === 'Label' ? columnOf(s) : null;
  return c ? `attribute|${c.entity}.${c.attr}|DisplayName` : '';
};

/**
 * The texts a stand-in (`from`) is made of, as `key`/`lcid`: the label's own base-language text, or its column's name
 * in that language, and for one from the column's base-language name, that one too (its name in that language is
 * empty, which a later text would change). The saver reads them again before writing (core/saver.ts): a stand-in made
 * of a text that changed on the server since it was loaded is never written; one made of a text the same save writes in
 * another write (a form label of its column's new name) is written after it, and only once that text is saved.
 */
export function standInSources(s: Slot, l: Lcid, base: Lcid, from: StandInFrom): Array<{ key: string; lcid: Lcid }> {
  const k = columnKey(s);
  if (from === 'base' || !k) return [{ key: s.key, lcid: base }];
  return from === 'column' ? [{ key: k, lcid: l }] : [{ key: k, lcid: l }, { key: k, lcid: base }];
}

/** A text a stand-in is made of (standInSources), as the start of a sentence: "Its English text", "Its column's French name". */
const sourceName = (s: Slot, src: { key: string; lcid: Lcid }): string =>
  src.key === s.key ? `Its ${lcidName(src.lcid)} text` : `Its column's ${lcidName(src.lcid)} name`;

/**
 * Why a stand-in wasn't written: a text it is made of changed on the server since it was loaded (`now`), so it would
 * have been the old one (core/saver.ts). The store holds the new text from then on, so Try again measures that.
 */
export const sourceMoved = (s: Slot, src: { key: string; lcid: Lcid }, now: string): string =>
  `${sourceName(s, src)} changed on the server since it was loaded (now ${now.trim() ? `“${now.trim()}”` : 'empty'}), so nothing was written: Try again to put the new text in its place.`;

/**
 * Why a stand-in wasn't written: a text it is made of is a change of the same save (or undo) written apart from it, and
 * that one wasn't saved (core/saver.ts writes such a stand-in only once that text is on the server): the label would
 * have got a text the server doesn't have. The edit stays, and Try again writes both.
 */
export const sourceUnsaved = (s: Slot, src: { key: string; lcid: Lcid }): string =>
  `${sourceName(s, src)} wasn't saved, so nothing was written here either: Try again to save both.`;

/** Why a stand-in wasn't written: a text it is made of couldn't be read again to check it (core/saver.ts). */
export const sourceUnread = (s: Slot, src: { key: string; lcid: Lcid }, why: string): string =>
  `${sourceName(s, src)} couldn't be read to check it before writing (${why.trim().replace(/[.!]+$/, '')}), so nothing was written. Try again.`;

/** Why a translation can't be removed, as the start of a sentence. */
const unremovable = (s: Slot, l: Lcid): string => (stays(s, l) ? `Dynamics keeps a ${s.kind}'s translation` : "Dataverse can't remove a translation");
/** What a stand-in is, after "gets": "the English text", "the column's French name". */
export const standInWhat = (from: StandInFrom, l: Lcid, base: Lcid): string =>
  from === 'base' ? `the ${lcidName(base)} text` : `the column's ${lcidName(from === 'column' ? l : base)} name`;

/**
 * Why an emptied translation is written as its stand-in, in a sentence (the popup, the editor card, the Workbench):
 * "Dataverse can't remove a translation here, so French gets the English text."
 */
export const standInText = (s: Slot, l: Lcid, base: Lcid, from: StandInFrom): string =>
  `${unremovable(s, l)}${stays(s, l) ? '' : ' here'}, so ${lcidName(l)} gets ${standInWhat(from, l, base)}.`;

/**
 * What saving an emptied translation does where it has a stand-in, in the line under its input (the popup, the editor
 * card) and the Workbench's tooltip: "Becomes “Project site”: Dataverse can't remove a translation here, so French gets
 * the English text."; where that is its text already (`same`), that nothing changes: "Already the English text:
 * Dataverse can't remove a translation here, so nothing changes."
 */
export const standInSays = (s: Slot, l: Lcid, base: Lcid, x: Pick<StandIn, 'text' | 'from' | 'same'>): string =>
  x.same
    ? `Already ${standInWhat(x.from, l, base)}: ${unremovable(s, l)}${stays(s, l) ? '' : ' here'}, so nothing changes.`
    : `Becomes “${x.text.trim()}”: ${standInText(s, l, base, x.from)}`;

/**
 * Several emptied translations written as their stand-ins, in a few words for a count of them (the Undo question, the
 * Workbench's paste and bulk tools): what they get, "the English text or the column's French name", and why, "Dataverse
 * can't remove them", "Dynamics keeps a stage's translation", else "they can't be removed".
 */
export function standInsSaid(xs: ReadonlyArray<{ s: Slot; l: Lcid; from: StandInFrom }>, base: Lcid): { what: string; why: string } {
  const what = [...new Set(xs.map((x) => standInWhat(x.from, x.l, base)))];
  const kept = new Set(xs.map((x) => (stays(x.s, x.l) ? x.s.kind : '')));
  const one = xs.length === 1;
  const why =
    kept.size > 1 ? `${one ? 'it' : 'they'} can't be removed` : kept.has('') ? `Dataverse can't remove ${one ? 'it' : 'them'}` : `Dynamics keeps a ${[...kept][0]}'s translation`;
  return { what: what.length > 1 ? `${what.slice(0, -1).join(', ')} or ${what[what.length - 1]}` : (what[0] ?? ''), why };
}

/**
 * The same in a few words, the quiet note of a row of the Publish and Undo dialogs: "English text: Dataverse can't remove
 * a translation", "The column's French name: Dataverse can't remove a translation".
 */
export const standInTag = (s: Slot, l: Lcid, base: Lcid, from: StandInFrom): string =>
  `${from === 'base' ? `${lcidName(base)} text` : `The column's ${lcidName(from === 'column' ? l : base)} name`}: ${unremovable(s, l)}`;

/**
 * What loads the text a stand-in is made of, where it isn't known only because that isn't loaded (StandIn.unloaded):
 * a form cell's column names, or a tab's or section's base text (read without a language switch).
 */
const loadWhat = (from: StandInFrom): string => (from === 'base' ? 'load its labels in all languages' : "load its table's columns");

/**
 * Why an emptied translation Dataverse can't remove is refused: it has no stand-in (standIn `why`; none given: no
 * reason). The saver's error, the popup's and the Workbench's: "Dataverse can't remove this translation, and its English
 * text is empty: type the text instead." One unknown only because a text isn't loaded says what loads it: "…, and its
 * column's names aren't loaded: load its table's columns to put the column's name in its place, or type the text."
 * `undo`: worded for the undo of the save that added it, which then stays, or waits for that text.
 */
export const noStandIn = (s: Slot, l: Lcid, x: Pick<StandIn, 'why' | 'unloaded' | 'from'> | undefined, undo = false): string => {
  const lead = stays(s, l) ? `Dynamics keeps a ${s.kind}'s translation once it is stored` : "Dataverse can't remove this translation";
  const and = x?.why ? `, and ${x.why}` : '';
  if (x?.unloaded)
    return undo
      ? `${lead}${and} here: ${loadWhat(x.from)}, then undo again.`
      : `${lead}${and}: ${loadWhat(x.from)} to put ${x.from === 'base' ? 'that text' : "the column's name"} in its place, or type the text.`;
  return undo ? `${lead}${and}, so the ${lcidName(l)} text this save added stays. Change it in the editor if needed.` : `${lead}${and}: type the text instead.`;
};

/**
 * A blank value Dataverse refuses every time (the saver and every writer block it the same way): removing a
 * translation that can't be removed and has no stand-in (where it has one, the saver writes that instead), or blanking
 * a required base-language label. Retrying can't help. One whose stand-in only waits for a text to be loaded isn't one:
 * the saver holds it back ('skipped'), and loading that text gives it. Nor is one saved empty (savesEmpty): Dataverse
 * takes it, so an error there is worth trying again.
 */
export const refusedBlank = ({ outcome, change: c }: ChangeResult, base: Lcid): boolean =>
  outcome === 'error' && !c.after.trim() && (c.lcid === base ? c.slot.baseRequired : !canClear(c.slot, c.lcid) && !savesEmpty(c.slot, c.lcid, base, c.untranslated));
