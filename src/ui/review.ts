// The Publish dialog (ARCHITECTURE §5.3), used by the bar, Ctrl+S and the Workbench: every staged change, grouped per
// component text ("title · what · where") with a word diff per language and Undo; blocked changes in red (skipped,
// they stay staged); one sentence about others' unpublished work, and one naming everything else the publish
// publishes, with what can't be checked (scopeText). Publish runs one save (always publishing),
// checks, and in translation mode refreshes the page (app.refreshPage, ui/refresh.ts). Failures stay in the
// dialog: Try again, Keep mine / Use theirs, Publish again, Refresh anyway. Also "Recent publishes": each publish opens
// to show what it changed in the same rows (changeGroup), Undo first shows what it will do to each label, read from the
// server, and Publish for a save whose publish failed or whose forms stayed unpublished (so it is never stranded).

import { markPublished } from '../core/history';
import { guid, isAbort } from '../core/http';
import { lcidShort } from '../core/lcid';
import { canClear, keepsEmpty, KIND_NAMES, PROP_NAMES, PublishSet, refusedBlank, savedEmptyText, savesEmpty, standIn, standInsSaid, standInTag, standInWhat, type Change, type ChangeResult, type Kind, type Lcid, type Outcome, type Prop, type Slot, type StandIn, type TextOf } from '../core/model';
import { isLockError, PartialPublishError, publishXml } from '../core/publish';
import { friendly, undoChange } from '../core/saver';
import type { Store } from '../core/store';
import { cellTitle } from '../inspector/describe';
import { changeId, type ServerTexts } from '../providers/types';
import { writeDetails, writesOf } from '../providers/writelog';
import { h, icon, plural, put, type IconName } from './dom';
import { langName } from './editor';
import type { AppApi, HistoryEntry, HistoryItem, Issue, PendingWork, Prepared, SaveReport, SaveRunOptions } from './types';
import { active, badge, bar, btn, emptyState, errMsg, frag, link, modal, modalOpen, note, spinner } from './widgets';

/** The dialog's own rules (on top of the shared .rv/.pl/.pr/.iss/.cf/.wd classes of styles.css). */
const CSS =
  '.pd-sub{margin:-8px 0 0;color:var(--fg3)}' +
  '.pd-g{border:1px solid var(--s2);border-radius:8px;flex:none}' +
  '.pd-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 6px;padding:8px 12px;background:var(--bg2);border-radius:8px 8px 0 0;font-size:12px;color:var(--fg3)}' +
  '.pd-h b{font-size:14px;font-weight:600;color:var(--fg1);overflow-wrap:anywhere}' +
  '.pd-r{display:grid;grid-template-columns:minmax(56px,max-content) minmax(0,1fr) auto;align-items:baseline;gap:2px 12px;padding:8px 12px;border-top:1px solid var(--s3)}' +
  '.pd-r.is-bad{background:var(--red-bg)}' +
  '.pd-r.is-amb{background:var(--amber-bg)}' +
  // Nothing happens to it (already as before, can't be removed, not loaded): its texts recede.
  '.pd-r.is-off .wd{color:var(--fg3)}' +
  '.pd-r:last-child{border-radius:0 0 8px 8px}' +
  '.pd-ok{color:var(--green)}' +
  // Recent publishes: each publish opens in place to show its rows.
  '.pd-he{border-bottom:1px solid var(--s3)}' +
  '.pd-he:last-child{border-bottom:0}' +
  '.pd-he>.hr{border-bottom:0}' +
  '.pd-hh{flex:1;min-width:0;margin:0;font:inherit}' +
  '.pd-ht{display:flex;align-items:flex-start;gap:8px;width:100%;padding:0;border:0;background:none;text-align:left;cursor:pointer}' +
  '.pd-ht>svg{flex:none;margin-top:2px;color:var(--fg3);transition:transform .1s}' +
  '.pd-ht[aria-expanded=true]>svg{transform:rotate(90deg)}' +
  '.pd-ht:hover b{text-decoration:underline}' +
  '.pd-hd{display:flex;flex-direction:column;gap:8px;padding:0 4px 12px 28px}' +
  // Why a publish has no Undo (it only named sitemap items): under its line, as its details are.
  '.pd-nu{margin:-4px 0 0;padding:0 4px 12px 28px;font-size:12px;line-height:16px;color:var(--fg3)}' +
  '@media (prefers-reduced-motion:reduce){.pd-ht>svg{transition:none}}' +
  // The Undo question: its list, and the choice to undo a label changed since.
  '.pd-ul{display:flex;flex-direction:column;gap:12px}' +
  '.pd-r .chk{font-size:12px}' +
  '.pd-l{font-size:12px;color:var(--fg3)}' +
  '.pd-r>.iss,.pd-r>.cf,.pd-r>.pd-n{grid-column:2/4;margin-top:0}' +
  '.pd-n{font-size:12px;line-height:16px;color:var(--fg3)}' +
  // How the labels are saved (language switch, ribbon import): under the subtitle, each once.
  '.pd-gn{margin-top:-12px}' +
  // What else publishing publishes: next to Publish, so it is read before it. The check's sentence, then the scope.
  '.pd-o{flex:1 1 240px;margin:0;font-size:12px;line-height:16px;color:var(--fg2)}' +
  '.pd-ow{flex:1 1 240px;display:flex;flex-direction:column;gap:4px;min-width:0}' +
  '.pd-ow>.pd-o{flex:none}' +
  '.pd-sc{margin:0;font-size:12px;line-height:16px;color:var(--fg3)}' +
  '.pd-o .spin{color:var(--brand)}' +
  // The steps never shrink to a scrolling box next to a long list (a short window would hide a step).
  '.pd-st{flex:none}' +
  '.pd-st .spin{color:var(--brand)}' +
  // A step's counter and what it does now: one muted line after its label (.pr .pt cuts it with an ellipsis).
  '.pd-st .pt small{margin-left:8px;font-variant-numeric:tabular-nums}' +
  '.pd-done{color:var(--fg1)}';

/** Groups rendered per list; huge bulk publishes show a count for the rest (they are still all published). */
const CAP = 300;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const tableName = (app: AppApi, e: string) => app.store.get(`entity|${e}|DisplayName`)?.title || e;
const and = (a: string[]) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
/** Kinds whose labels live in a form (or dashboard) definition: their `path[1]` is the form's name. */
const FORMISH = /^(field|tab|section|navitem|dtab|dsection|dfield)$/;

// ---- pure helpers (exported for tools/dev/tests/savepath.ts) ----

const WORD: Record<Kind, string> = {
  entity: 'Table',
  attribute: 'Column',
  relationship: 'Menu item', // the label of a related table's entry in the record's menu, as the popup says
  option: 'Choice',
  globaloptionset: 'Choice',
  globaloption: 'Choice',
  boolean: 'Choice',
  state: 'Choice',
  status: 'Choice',
  view: 'View',
  chart: 'Chart',
  form: 'Form',
  tab: 'Tab',
  section: 'Section',
  field: 'Form label', // a form cell's own label, as the field popup calls it
  navitem: 'Menu item',
  dashboard: 'Dashboard',
  dtab: 'Tab',
  dsection: 'Section',
  dfield: 'Component',
  app: 'App',
  area: 'Menu area',
  group: 'Menu group',
  subarea: 'Menu item',
  bpf: 'Process',
  stage: 'Stage',
  step: 'Step',
  ribbon: 'Button',
  command: 'Button',
  envvar: 'Environment variable',
  customapi: 'Custom API',
};
/** Kinds whose Name / DisplayName is "<kind> name" (a field's or a tab's is its label). */
const NAMED = new Set<Kind>(['view', 'chart', 'form', 'dashboard', 'app', 'bpf', 'envvar', 'customapi']);
const lower = (p: Prop) => (PROP_NAMES[p] || p).toLowerCase();

/** The "what" of a row header: Form label, Tooltip (everywhere), Column name (everywhere), Tab, Choice, Button… */
export function whatOf(s: Pick<Slot, 'kind' | 'prop'>): string {
  if (s.kind === 'attribute')
    // One per column (finding 43): the tooltip on every form, the name in views, search and on forms whose cell has no
    // label of its own. "(everywhere)", as the field popup says; never "(all forms)", which a cell's own label overrides.
    return s.prop === 'Description' ? 'Tooltip (everywhere)' : s.prop === 'DisplayName' ? 'Column name (everywhere)' : `Column ${lower(s.prop)}`;
  if (s.kind === 'entity') return s.prop === 'DisplayName' ? 'Table name' : s.prop === 'DisplayCollectionName' ? 'Plural name' : `Table ${lower(s.prop)}`;
  const w = WORD[s.kind] || KIND_NAMES[s.kind]?.[0] || s.kind;
  if (s.prop === 'Label' || s.prop === 'Title') return w;
  if (s.prop === 'Name' || s.prop === 'DisplayName') return NAMED.has(s.kind) ? `${w} name` : w;
  if (s.prop === 'ToolTipDescription') return `${w} tooltip`;
  return `${w} ${lower(s.prop)}`;
}

/**
 * The title of a row header, as the popup's: a form cell without a label of its own in the user's language shows
 * its column's name (LIVE-FINDINGS 42), never its control's technical name.
 */
export function titleOf(app: AppApi, s: Slot): string {
  return cellTitle(app, s) || s.title || s.sub || s.comp;
}

/**
 * The "where" of a row header: where the label is, as the names the user sees ('' for a label that is a place of its
 * own: a table, an app). A form label's form, tab and section ("Account (Main form) › Summary › Details"), a
 * navigation item's app, area and group, a process step's process and stage, a choice's table and column, a global
 * choice option's choice, a column's, view's, relationship's or button's table. Recent publishes keeps it (HistoryItem).
 */
export function whereOf(s: Slot): string {
  const p = s.path;
  if (FORMISH.test(s.kind)) return p.slice(1).join(' › ');
  if (/^(area|group|subarea|stage|step)$/.test(s.kind)) return p.join(' › ');
  // [table, "Industry (industrycode)", "Choices"]: the column as the form names it.
  if (/^(option|status|state|boolean)$/.test(s.kind)) return [p[0], String(p[1] || '').replace(/\s*\([^()]*\)$/, '')].filter(Boolean).join(' › ');
  if (s.kind === 'globaloption') return p[1] || '';
  if (/^(attribute|relationship|view|chart|form|bpf|command|ribbon)$/.test(s.kind)) return p[0] || '';
  return '';
}

/**
 * "Publishing Account also publishes 2 other unpublished changes on it." ('' when there are none). `saved`: the
 * changes are saved already (Recent publishes), so the forms, views and charts they edit are unpublished because of
 * them: those are left out (whether they hold more than this save can't be told).
 */
export function othersText(app: AppApi, found: PendingWork[], saved = false): string {
  const ws = found.map((w) => (saved ? { ...w, items: w.items.filter((i) => !i.mine) } : w)).filter((w) => w.items.length);
  if (!ws.length) return '';
  const n = ws.reduce((a, w) => a + w.items.length, 0);
  return `Publishing ${and(ws.map((w) => tableName(app, w.entity)))} also publishes ${plural(n, 'other unpublished change')} on ${ws.length > 1 ? 'them' : 'it'}.`;
}

/** How long Publish waits for the check of others' work before saying it couldn't check (a request has no time limit). */
const CHECK_MS = 15000;

/**
 * What publishing these changes also publishes, said before it starts (README "No surprise publishing"): the
 * unpublished forms, views and charts on their tables (othersText), or that they couldn't be checked, so there may
 * be some. '' when there is nothing to say, or the check was stopped. Never rejects. `saved`: see othersText.
 */
export async function othersNote(app: AppApi, cs: Change[], signal?: AbortSignal, ms = CHECK_MS, saved = false): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error('The check took too long.')), ms)));
    return othersText(app, await Promise.race([app.saver.pendingWork(cs, signal), late]), saved);
  } catch {
    if (signal?.aborted) return '';
    let ents: string[] = [];
    try {
      ents = [...app.saver.publishTargets(cs).entities].filter((e) => e && e !== '_app' && e !== 'none');
    } catch {
      /* named generically */
    }
    return `Couldn't check ${and(ents.map((e) => tableName(app, e))) || 'these tables'} for other unpublished changes: publishing ${ents.length === 1 ? 'it' : 'them'} also publishes any there are.`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The whole of what publishing these changes publishes besides them, said before it starts, with what can't be
 * checked: PublishXml publishes everything unpublished on each component it names, and othersNote reads only the
 * forms, views and charts of the tables. A table's columns, choices, relationships and classic command bar, an app's
 * navigation, dashboards, apps, global choices and the command bar of every table have no unpublished read. Classic
 * command labels publish their table (or the application ribbon) before they are imported (ribbon.ts), so that is said
 * too. '' when nothing
 * is published.
 */
export function scopeText(app: AppApi, cs: readonly Change[]): string {
  let t: PublishSet;
  try {
    t = app.saver.publishTargets(cs as Change[]);
  } catch {
    return '';
  }
  const tables = [...t.entities].filter((e) => e && e !== '_app' && e !== 'none');
  /** Names by the id PublishXml gets, so each component is said once. */
  const named = new Map<string, string>();
  const add = (key: string, set: Set<string>, name: string) => {
    if (key && set.has(key) && !named.has(key)) named.set(key, name);
  };
  const id = (v: unknown) => (v ? guid(String(v)) : '');
  const first = new Set<string>();
  /** The application ribbon is published before its import too (ribbon.ts publishScope). */
  let appFirst = false;
  for (const { slot: s } of cs) {
    if (s.readOnly) continue;
    const r = s.ref || {};
    if (/^(area|group|subarea)$/.test(s.kind)) add(id(r.sitemapId), t.sitemaps, `${s.path[0] || 'the app'} (navigation)`);
    else if (s.kind === 'app') add(id(r.id), t.appmodules, `${s.title || 'the app'} (app)`);
    else if (s.kind === 'dashboard') add(id(r.id), t.dashboards, `${s.title || 'the dashboard'} (dashboard)`);
    else if (/^d(tab|section|field)$/.test(s.kind)) add(id(r.formId), t.dashboards, `${s.path[1] || 'the dashboard'} (dashboard)`);
    else if (s.kind === 'globaloptionset') add(String(r.name || ''), t.optionsets, `${s.title || r.name} (choice)`);
    else if (s.kind === 'globaloption') add(String(r.name || ''), t.optionsets, `${s.path[1] || r.name} (choice)`);
    else if (s.kind === 'ribbon' && r.entity === '_app') appFirst ||= t.ribbons;
    else if (s.kind === 'ribbon' && t.entities.has(r.entity || s.entity)) first.add(tableName(app, r.entity || s.entity));
  }
  const items = [...tables.map((e) => `${tableName(app, e)} (table)`), ...named.values()];
  if (t.ribbons || t.entities.has('_app')) items.push('the command bar of every table');
  if (!items.length) return '';
  const list = items.length <= 4 ? items.join(', ') : `${items.slice(0, 3).join(', ')} and ${items.length - 3} more`;
  const tail = tables.length ? `the translator can only check ${items.length > 1 ? "a table's" : 'its'} forms, views and charts` : `the translator can't check ${items.length > 1 ? 'those' : 'it'}`;
  const pub = [...first, ...(appFirst ? ['the command bar of every table'] : [])];
  const who = and(pub);
  const pre = pub.length ? ` ${who.charAt(0).toUpperCase()}${who.slice(1)} ${pub.length > 1 ? 'are' : 'is'} published first, before ${pub.length > 1 ? 'their' : 'its'} classic command labels are saved.` : '';
  return `Publishing also publishes anything else not yet published on: ${list}; ${tail}.${pre}`;
}

/**
 * The short reason a change can't be published (the popup's words): "Can't be empty", "Too long (max N)", "Read-only";
 * a translation emptied where Dataverse can't remove it and that has no stand-in says why (the saver's message,
 * model.ts noStandIn).
 */
function shortWhy(c: Change, message: string, base: Lcid): string {
  if (c.slot.readOnly) return 'Read-only';
  if (!c.after.trim()) return c.lcid !== base && c.before !== '' && !canClear(c.slot, c.lcid) && message ? message : "Can't be empty";
  if (c.slot.max > 0 && c.after.length > c.slot.max) return `Too long (max ${c.slot.max})`;
  return message;
}

/**
 * The changes as a save of exactly these (`cs`: those it sends) writes them, by change id: an emptied translation
 * Dataverse can't remove as its stand-in, measured by the texts that save leaves on the server (SaverApi.prepare), any
 * other as it is.
 */
export function asWritten(app: AppApi, cs: readonly Change[]): Map<string, Change> {
  let written: Change[] = [...cs];
  try {
    written = app.saver.prepare([...cs]).written;
  } catch {
    /* shown as staged; the saver says what it does with them */
  }
  return new Map(written.map((c) => [changeId(c), c] as const));
}

/**
 * The quiet note of a row whose text is a stand-in (a change written as it, `w`): "English text: Dataverse can't remove
 * a translation"; one that is its text already: "Already the English text: nothing changes".
 */
const standInNote = (app: AppApi, s: Slot | undefined, l: Lcid, w: Pick<Change, 'before' | 'after' | 'standIn'> | undefined): HTMLElement | null => {
  const from = w?.standIn?.from;
  if (!s || !from) return null;
  return rowNote('note', bareText(w!.after) === bareText(w!.before) ? `Already ${standInWhat(from, l, app.ctx.base)}: nothing changes` : standInTag(s, l, app.ctx.base, from));
};
/** Only spaces counts as no text, as the writers compare texts. */
const bareText = (t: string) => (t.trim() ? t : '');
/**
 * The quiet note of a row whose text is saved empty (a metadata description emptied, model.ts savesEmpty; its texts
 * read "<old> → (empty)"), in the popup's words: "Saved empty: French users see no tooltip."
 */
const emptyNote = (app: AppApi, c: Pick<Change, 'slot' | 'lcid' | 'after' | 'untranslated'> | undefined): HTMLElement | null =>
  c && !c.after.trim() && savesEmpty(c.slot, c.lcid, app.ctx.base, c.untranslated) ? rowNote('note', savedEmptyText(c.slot, langName(app, c.lcid))) : null;
/** The old side of a row saved empty where its language had no translation at all, when what it showed isn't known. */
const NO_TRANSLATION = '(no translation)';
/**
 * The old side of a Publish dialog row saved empty (emptyNote) where its language had no translation at all
 * (Change.beforeMissing): what that language's users see there until then, the base text (LIVE-FINDINGS 32), as the
 * popup's placeholder says it ("Shows “Type the name.”"), or NO_TRANSLATION where that is empty too. Never "(empty)": the
 * row would read "(empty) → (empty)", as if nothing changed. undefined for any other row (ChangeRow.blankBefore).
 */
const missingSide = (app: AppApi, c: Change, w: Pick<Change, 'slot' | 'lcid' | 'after' | 'untranslated'>): string | undefined => {
  if (!c.beforeMissing || w.after.trim() || !savesEmpty(w.slot, w.lcid, app.ctx.base, w.untranslated)) return undefined;
  const t = app.store.text(c.slot.key, app.ctx.base, true)?.trim();
  return t ? `Shows “${t}”` : NO_TRANSLATION;
};

export interface Plan {
  /** The changes Publish writes. */
  send: Change[];
  /** The others, by change id: the short reason ('' for a conflict waiting for Keep mine / Use theirs). They stay staged. */
  blocked: Map<string, string>;
  /** The saver's warnings about the changes Publish writes, by change id: said on their rows (they are published all the same). */
  warns: Map<string, string[]>;
  /** Its warnings about how such labels are saved (language switch, ribbon import), each once. */
  notes: string[];
  /** Each change Publish writes as the save writes it (asWritten of `send`): an emptied translation Dataverse can't remove as its stand-in. */
  written: Map<string, Change>;
}
/**
 * Splits the staged changes into those Publish writes and those it skips (blocking problems, open conflicts). The checks
 * measure the changes it can write (an open conflict is never one), and each is shown as a save of those it writes
 * leaves it (`written`): a stand-in is never made of a staged text that isn't published with it.
 */
export function planPublish(app: AppApi, changes: Change[]): Plan {
  const open = (c: Change) => app.store.cellStatus(c.slot.key, c.lcid)?.outcome !== 'conflict';
  let issues: Issue[] = [];
  try {
    issues = app.saver.validate(changes.filter(open));
  } catch {
    issues = []; // the saver validates again and reports them as failed rows
  }
  const errs = new Map<string, string>();
  for (const i of issues) if (i.level === 'error' && !errs.has(changeId(i.change))) errs.set(changeId(i.change), i.message);
  const blocked = new Map<string, string>();
  for (const c of changes) {
    const id = changeId(c);
    if (!open(c)) blocked.set(id, '');
    else if (c.slot.readOnly || errs.has(id)) blocked.set(id, shortWhy(c, errs.get(id) || '', app.ctx.base));
  }
  const warns = new Map<string, string[]>();
  const notes = new Set<string>();
  for (const i of issues) {
    const id = changeId(i.change);
    if (i.level !== 'warn' || blocked.has(id)) continue;
    if (i.general) notes.add(i.message);
    else warns.set(id, [...(warns.get(id) ?? []), i.message]);
  }
  const send = changes.filter((c) => !blocked.has(changeId(c)));
  return { send, blocked, warns, notes: [...notes], written: asWritten(app, send) };
}

/**
 * What Try again writes, as staged now: the changes that failed or were stopped (never a blank Dataverse refuses
 * every time) and conflicts resolved with Keep mine. Conflicts still open and changes undone since are left out.
 */
export function retryable(app: AppApi, results: readonly ChangeResult[]): Change[] {
  const ids = new Set<string>();
  for (const r of results) if (r.outcome === 'conflict' || ((r.outcome === 'error' || r.outcome === 'skipped') && !refusedBlank(r, app.ctx.base))) ids.add(changeId(r.change));
  return app.store.changes().filter((c) => ids.has(changeId(c)) && app.store.cellStatus(c.slot.key, c.lcid)?.outcome !== 'conflict');
}

/** Publishes what these saved changes need (Publish again) and marks their journal entries published. */
export async function publishAgain(app: AppApi, saved: Change[], historyIds: string[], signal?: AbortSignal, onRetry?: (m: string) => void): Promise<void> {
  const set = app.saver.publishTargets(saved);
  if (!set.empty) await publishXml(app.ctx, set, signal, onRetry);
  await markPublished(app.ctx, historyIds);
}

/** What the forms check after publishing found, by form name. */
export interface FormsCheck {
  /** Forms whose unpublished version is still newer: not published. */
  left: string[];
  /** Forms it couldn't read (a read failed, or showed no version): whether they are published is not known. */
  unread: string[];
}

/**
 * The forms among these saved changes that are still unpublished after publishing: their unpublished
 * versionnumber differs from the published one (both are equal once PublishXml has run). One cheap
 * GET pair per form, asked again once after `wait` ms. A form that can't be read is `unread`, never taken for
 * published. Never rejects.
 */
export async function unpublishedForms(app: AppApi, saved: readonly Change[], signal?: AbortSignal, wait = 1000): Promise<FormsCheck> {
  const forms = new Map<string, string>();
  for (const { slot: s } of saved) if (FORMISH.test(s.kind) && s.ref?.formId) forms.set(guid(s.ref.formId), s.path[1] || 'A form');
  const differs = async (id: string) => {
    const [pub, un] = await Promise.all([
      app.ctx.http.get(`systemforms(${id})?$select=versionnumber`, { signal }),
      app.ctx.http.get(`systemforms(${id})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=versionnumber`, { signal }),
    ]);
    if (pub?.versionnumber == null || un?.versionnumber == null) throw new Error('No version number.');
    return String(pub.versionnumber) !== String(un.versionnumber);
  };
  const ids = [...forms.keys()];
  const found = await Promise.all(
    ids.map(async (id) => {
      try {
        if (!(await differs(id))) return 'ok';
        await sleep(wait);
        return (await differs(id)) ? 'left' : 'ok';
      } catch {
        return 'unread';
      }
    }),
  );
  const named = (x: string) => [...new Set(ids.filter((_, i) => found[i] === x).map((id) => forms.get(id)!))];
  return { left: named('left'), unread: named('unread') };
}

/** Names for "Publishing …": the tables, apps, dashboards and global choices these changes publish, and the processes updated. */
function publishNames(app: AppApi, cs: readonly Change[], t: PublishSet): string {
  const names = new Set<string>();
  for (const e of t.entities) if (e && e !== '_app' && e !== 'none') names.add(tableName(app, e));
  for (const p of t.processes.values()) names.add(p || 'the process');
  for (const { slot: s } of cs) {
    if (/^(area|group|subarea)$/.test(s.kind)) names.add(s.path[0] || 'the app navigation');
    else if (s.kind === 'app') names.add(s.title || 'the app');
    else if (s.kind === 'dashboard') names.add(s.title || 'the dashboard');
    else if (/^d(tab|section|field)$/.test(s.kind)) names.add(s.path[1] || 'the dashboard');
    else if (s.kind === 'globaloptionset') names.add(s.title || 'a global choice');
    else if (s.kind === 'globaloption') names.add(s.path[1] || 'a global choice');
  }
  if (t.ribbons || t.entities.has('_app')) names.add('the command bar');
  const a = [...names].filter(Boolean);
  return a.length <= 3 ? and(a) : `${a.slice(0, 3).join(', ')} and ${a.length - 3} more`;
}

/** The reason of a failed publish, without the saver's "Your translations are saved" (the dialog says "Saved, but…"). */
function why(m: string): string {
  if (/Dataverse is busy/i.test(m)) return 'Dataverse is busy with another customization. Try again in a few minutes.';
  if (/cancel/i.test(m)) return 'Publishing was cancelled.';
  return m.replace(/^Your translations are saved(, but publishing failed: |\. )/, '');
}
const pubFail = (e: unknown): string =>
  isAbort(e) ? 'Publishing was cancelled.' : e instanceof PartialPublishError ? e.message : isLockError(e) ? why('Dataverse is busy') : friendly(e);
/** Forms the check after publishing couldn't read: "Couldn't check whether Main form is published. <how> it and check again." */
const unreadText = (forms: string[], how: string): string =>
  `Couldn't check whether ${and(forms)} ${forms.length === 1 ? 'is' : 'are'} published. ${how} ${forms.length === 1 ? 'it' : 'them'} and check again.`;

/**
 * Word-level diff: removed words struck in red on the left, added words in green on the right. A blank side shows
 * `blankA` / `blankB` instead.
 */
function diff(a: string, b: string, blankA = '(empty)', blankB = '(empty)'): HTMLElement {
  const A = a.split(/(\s+)/);
  const B = b.split(/(\s+)/);
  const ka: boolean[] = [];
  const kb: boolean[] = [];
  const n = A.length;
  const m = B.length;
  if (n * m <= 40000) {
    const T = new Uint16Array((n + 1) * (m + 1));
    const at = (i: number, j: number) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) T[at(i, j)] = A[i] === B[j] ? T[at(i + 1, j + 1)] + 1 : Math.max(T[at(i + 1, j)], T[at(i, j + 1)]);
    for (let i = 0, j = 0; i < n && j < m; ) {
      if (A[i] === B[j]) ka[i++] = kb[j++] = true;
      else if (T[at(i + 1, j)] >= T[at(i, j + 1)]) i++;
      else j++;
    }
  }
  const side = (W: string[], keep: boolean[], tag: 'del' | 'ins', cls: string, blank: string) => {
    if (!W.join('').trim()) return h('em', null, blank);
    const s = h('span', { class: cls });
    for (let i = 0; i < W.length; ) {
      const k = !!keep[i];
      let t = '';
      while (i < W.length && !!keep[i] === k) t += W[i++];
      s.append(k || !t.trim() ? t : h(tag, null, t));
    }
    return s;
  };
  return h('div', { class: 'wd' }, side(A, ka, 'del', 'wd-a', blankA), h('span', { class: 'arr', 'aria-label': 'becomes' }, '→'), side(B, kb, 'ins', 'wd-b', blankB));
}

// ---- rows of changes: the Publish dialog's, also Recent publishes' and Undo's ----

/** One language of one label in a list of changes, as plain data: staged, journaled or about to be undone. */
export interface ChangeRow {
  /** The language, named as the dialog names it (langName). */
  lang: string;
  /** The text it replaces and the text it becomes (a word diff; a blank side reads "(empty)"). */
  before: string;
  after: string;
  /** What a blank `before` reads instead of "(empty)" (missingSide: a language that had no translation at all). */
  blankBefore?: string;
  /** '' plain, 'bad' red (skipped or failed), 'amb' amber (asks for a choice), 'off' muted (nothing happens to it). */
  tone?: '' | 'bad' | 'amb' | 'off';
  /** Its last column: Undo, Copy details, a choice. */
  end?: Node | null;
  /** Lines under its texts (rowNote, the conflict box). */
  notes?: Array<Node | null | false | undefined>;
}

/** A label's rows under its header "title · what · where". */
export interface ChangeGroup {
  title: string;
  /** Form label, Tooltip (everywhere), Tab… (whatOf). */
  what: string;
  /** Where it is (whereOf), or where its copies are; '' for nowhere in particular. */
  where: string;
  rows: ChangeRow[];
}

/** A group as the Publish dialog shows it; its header is a heading of `level` (the dialog's title is 3). */
export function changeGroup(g: ChangeGroup, level = 4): HTMLElement {
  const rest = [g.what, g.where].filter(Boolean);
  return h('div', { class: 'pd-g' },
    h('div', { class: 'pd-h', role: 'heading', 'aria-level': String(level) }, h('b', null, g.title), rest.length ? h('span', null, rest.map((t) => '· ' + t).join(' ')) : null),
    g.rows.map((r) => h('div', { class: 'pd-r' + (r.tone ? ' is-' + r.tone : '') }, h('span', { class: 'pd-l' }, r.lang), diff(r.before, r.after, r.blankBefore), r.end ?? h('span'), r.notes ?? null)),
  );
}

/** A line under a row's texts: a problem, a warning, a note, or what went through (ok). */
export const rowNote = (tone: 'error' | 'warn' | 'note' | 'ok', text: string): HTMLElement =>
  h('div', { class: 'iss ' + (tone === 'ok' ? 'pd-ok' : tone) }, icon(tone === 'ok' ? 'check' : tone === 'note' ? 'info' : tone), h('span', null, text));

/** A Publish dialog group's header: its label's title, what and where; the copies of a field say their places. */
function header(app: AppApi, cg: Change[][]): Omit<ChangeGroup, 'rows'> {
  const s = cg[0][0].slot;
  const head = { title: titleOf(app, s), what: whatOf(s) };
  if (cg.length < 2) return { ...head, where: whereOf(s) };
  const places = placesOf(cg);
  return { ...head, where: [s.path[1], `${cg.length} places${places.length ? ` (${places.join(', ')})` : ''}`].filter(Boolean).join(' · ') };
}

/** A journaled label's property: its key's last part. */
const propOf = (key: string) => key.slice(key.lastIndexOf('|') + 1) as Prop;
const itemId = (it: HistoryItem) => `${it.key}#${it.lcid}`;

/**
 * A journal entry's labels grouped as the Publish dialog grouped them: one group per label under the title and place
 * it showed (an entry journaled before places were kept shows its title and what only), and the same edit of every
 * copy of a field on a form as one group with their places (mergeCopies). `row` makes a language's row from that
 * language's item of each copy; `sig` keeps copies apart that must not share a row (an Undo state, an outcome).
 */
export function entryGroups(items: readonly HistoryItem[], row: (copies: HistoryItem[]) => ChangeRow, sig: (it: HistoryItem) => string = () => ''): ChangeGroup[] {
  const labels = new Map<string, HistoryItem[]>();
  for (const it of items) {
    const g = labels.get(it.key);
    if (g) g.push(it);
    else labels.set(it.key, [it]);
  }
  const out: HistoryItem[][][] = [];
  const copies = new Map<string, HistoryItem[][][]>();
  for (const its of labels.values()) {
    const it = its[0];
    // A form cell: same form (its id and name), title and texts. The Publish dialog matches the column too, not kept here.
    const k = it.kind === 'field' ? JSON.stringify([it.key.split('|')[1], it.title, propOf(it.key), (it.where ?? '').split(' › ')[0], its.map((x) => [x.lcid, x.before, x.after, sig(x)].join('\n')).sort()]) : '';
    const at = k ? copies.get(k) : undefined;
    if (at) at[0].push(its);
    else {
      const e: HistoryItem[][][] = [[its]];
      if (k) copies.set(k, e);
      out.push(e[0]);
    }
  }
  return out.map((cg) => {
    const it = cg[0][0];
    const head = { title: it.title, what: whatOf({ kind: it.kind, prop: propOf(it.key) }) };
    if (cg.length < 2) return { ...head, where: it.where ?? '', rows: cg[0].map((x) => row([x])) };
    const parts = cg.map((its) => (its[0].where ?? '').split(' › '));
    const places = [...new Set(parts.map((p) => p[1] || p[2] || '').filter(Boolean))];
    return {
      ...head,
      where: [parts[0][0], `${cg.length} places${places.length ? ` (${places.join(', ')})` : ''}`].filter(Boolean).join(' · '),
      rows: cg[0].map((x) => row(cg.map((its) => its.find((y) => y.lcid === x.lcid) ?? x))),
    };
  });
}

/** Changes grouped per slot (one header per component text), groups with a problem first, in staging order. */
function grouped(cs: readonly Change[], bad: (c: Change) => boolean): Change[][] {
  const m = new Map<string, Change[]>();
  for (const c of cs) {
    const g = m.get(c.slot.key);
    if (g) g.push(c);
    else m.set(c.slot.key, [c]);
  }
  const gs = [...m.values()];
  return [...gs.filter((g) => g.some(bad)), ...gs.filter((g) => !g.some(bad))];
}

/**
 * The same edit made to every copy of one field on one form (the popup's "Also change the other copies"): one entry
 * with the places listed, instead of one identical row per copy. Only clean groups merge: a copy with a problem, a
 * conflict or other text keeps its own row.
 */
export function mergeCopies(gs: Change[][], clean: (g: Change[]) => boolean): Change[][][] {
  const out: Change[][][] = [];
  const by = new Map<string, Change[][][]>();
  const sig = (g: Change[]) => g.map((c) => `${c.lcid}${c.before}${c.after}`).sort().join('');
  for (const g of gs) {
    const s = g[0].slot;
    const df = s.kind === 'field' && s.ref?.datafield && s.ref?.formId ? `${s.ref.formId}|${s.ref.datafield}|${s.prop}|${sig(g)}` : '';
    if (!df || !clean(g)) {
      out.push([g]);
      continue;
    }
    const at = by.get(df);
    if (at) at[0].push(g);
    else {
      const e: Change[][][] = [[g]];
      by.set(df, e);
      out.push(e[0]);
    }
  }
  return out;
}

/** Where the copies of a field are: their tabs (else sections), in form order, without repeats. */
export function placesOf(copies: Change[][]): string[] {
  return [...new Set(copies.map((g) => g[0].slot.path[2] || g[0].slot.path[3] || '').filter(Boolean))];
}

// ---- the Publish dialog ----

/** Lower-case kind names: the suffix of the metadata writer's "Saving Nom (column)". */
const KINDS = Object.values(KIND_NAMES).map(([one]) => one.toLowerCase());

/**
 * A progress message of the saver (or of PublishXml's retries) as the running step shows it after its counter: the
 * item's title only ("Saving Nom (column)" → "Nom"), a wait in lower case ("waiting for Dataverse to confirm Nom"), a
 * retry in short ("Dataverse is busy, trying again in 10 s"); '' for the bare "Saving…" between writes. `wait`: worth
 * announcing (a wait or a retry; never each item).
 */
export function progressNote(message: string): { text: string; wait: boolean } {
  const s = message.trim().replace(/(…|\.\.\.)$/, '');
  const busy = /^Dataverse is busy\b.*?(\d+) seconds?$/.exec(s);
  if (busy) return { text: `Dataverse is busy, trying again in ${busy[1]} s`, wait: true };
  if (/^Apps could not be published with the rest\b/.test(s)) return { text: 'trying again without the apps', wait: true };
  if (/^Waiting for /.test(s)) return { text: 'w' + s.slice(1), wait: true };
  const wait = /Dataverse is busy|trying again/.test(s);
  const kind = KINDS.find((k) => s.endsWith(` (${k})`));
  // The records writer's "Saving view “Active accounts” › Name" (a metadata title may hold “…” too: its kind goes first).
  const quoted = kind ? null : /^Saving [^“”›]+ “(.+)” › [^“”›]+$/.exec(s);
  if (quoted) return { text: quoted[1], wait };
  return { text: (kind ? s.slice(0, -kind.length - 3) : s).replace(/^(Saving|Undoing|Publishing)( |$)/, ''), wait };
}

type StepState = 'wait' | 'run' | 'ok' | 'bad';
interface Step {
  el: HTMLElement;
  /** The state, and what follows the label when given: a counter ("3 of 4") or a result ("1 of 4 needs attention"). */
  set(s: StepState, detail?: string): void;
  /** A progress message of the running step, after its counter (progressNote; the full sentence on hover). '' clears it. */
  now(message: string): void;
}
/**
 * One row of a run's steps, the same height all along: what the step does now stays on its line. Becoming the running
 * step or waiting for Dataverse, it says so in `live`, the run's one polite live region (visually hidden).
 */
function step(text: string, live?: HTMLElement): Step {
  const mk = h('span', { class: 'ps w' });
  const dt = h('small');
  const el = h('div', { class: 'pr' }, mk, h('span', { class: 'pt' }, text, dt));
  let state: StepState = 'wait';
  let count = '';
  let item = '';
  const say = (m: string) => {
    if (live && live.textContent !== m) live.textContent = m;
  };
  const show = () => (dt.textContent = [count, item].filter(Boolean).join(' · '));
  return {
    el,
    set(s, d) {
      mk.className = 'ps ' + (s === 'wait' ? 'w' : s === 'ok' ? 'ok' : s === 'bad' ? 'bad' : '');
      put(mk, s === 'run' ? spinner() : s === 'ok' ? icon('check') : s === 'bad' ? icon('error') : '');
      if (s === 'run') el.setAttribute('aria-current', 'step');
      else el.removeAttribute('aria-current');
      if (s === 'run' && state !== 'run') say(text);
      if (s !== 'run') item = el.title = ''; // what it was doing is over
      state = s;
      if (d !== undefined) count = d;
      show();
    },
    now(m) {
      const n = progressNote(m);
      item = n.text;
      el.title = n.text ? m.trim() : '';
      if (n.wait) say(m.trim());
      show();
    },
  };
}

/**
 * Stop for a running save, publish or undo. It shows where the button that started the run was, so it never takes
 * the focus (the progress is announced) and ignores clicks during its first moments and the second click of a
 * double-click: a confident double-click on Publish must not cancel the publish it started.
 */
function stopButton(ac: AbortController): HTMLButtonElement {
  const t0 = performance.now();
  const b = btn('Stop', (e) => {
    if (e.detail > 1 || performance.now() - t0 < 600) return;
    ac.abort();
    b.disabled = true;
    b.textContent = 'Stopping…';
  });
  return b;
}

interface Progress {
  list: HTMLElement;
  /** The run's one polite live region: step changes and waits, never each item (it takes no space). */
  live: HTMLElement;
  save: Step | null;
  pub: Step | null;
  chk: Step;
  ref: Step | null;
}

/**
 * Opens the Publish dialog for every staged change (or those matching `filter`). Resolves when it closes, with the
 * report of the last save it ran (undefined if none); in translation mode the page may be reloading by then.
 */
export async function openReview(app: AppApi, filter?: (s: Slot) => boolean): Promise<SaveReport | undefined> {
  const { store } = app;
  if (store.busy) {
    app.toast('A save is already running. Wait for it to finish.', 'warn');
    return undefined;
  }
  if (!store.changes(filter).length) {
    app.toast('Nothing to publish yet', 'info');
    return undefined;
  }
  app.adoptStyles(CSS);
  // Translation mode refreshes the page after a full success; the Workbench (and the live test suite) shows Done.
  const page = app.view() === 'page' && !(__DEV__ && (app as unknown as { dev?: { noRefresh?: boolean } }).dev?.noRefresh);
  const st = { busy: false, ac: new AbortController() };
  let last: SaveReport | undefined;
  const S = {
    /** Every change saved in this dialog (or found already saved, which its run published all the same). */
    saved: [] as Change[],
    /** How many of those were found already on the server, never written by this translator (ChangeResult.found): not this publish's. */
    found: 0,
    /** Saved but not published yet (the publish failed, or the forms check found them unpublished), and their journal entries. */
    needPub: [] as Change[],
    needHist: [] as string[],
    /** Something was published (the page needs a refresh to show it). */
    published: false,
    /** Rows that failed or conflicted. */
    probs: [] as ChangeResult[],
    pubErr: '',
    /** Published, but the forms check couldn't read some forms: not known to be published (they are in needPub). */
    chkErr: '',
    warning: '',
    /** Saved, but the page may not show it yet (a process could not be updated): said, never tried again. */
    notice: '',
  };

  await modal<void>('Publish changes', (close, dlg) => {
    const h3 = dlg.querySelector('h3')!;
    const xb = dlg.querySelector<HTMLButtonElement>('.dlg-h .btn');
    const ui = h('div', { class: 'rv' });
    const busy = (b: boolean) => {
      st.busy = b;
      if (xb) xb.disabled = b;
    };
    let ctrlEnter: HTMLButtonElement | null = null;
    dlg.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return;
      e.preventDefault();
      if (ctrlEnter?.isConnected && !ctrlEnter.disabled) ctrlEnter.click();
    });
    /** Keep the keyboard in the dialog when a re-render removed the focused button (else Tab and Esc reach the page). */
    const keepFocus = (el?: HTMLElement) => {
      if (el) el.focus();
      else if (dlg.isConnected && !dlg.contains(active(dlg))) dlg.focus();
    };

    /** Short reasons of the changes the plan skipped (they stay staged), by change id. */
    const blockedWhy = new Map<string, string>();

    // ---- the list of changes ----
    /**
     * Shows the staged changes. After an Undo (or Keep mine / Use theirs) the list stays where it was scrolled and
     * the focus goes to the Undo of the row now in that place (`at`: its index), so the keyboard keeps its place.
     */
    const render = (at = -1): void => {
      st.ac.abort();
      st.ac = new AbortController();
      const signal = st.ac.signal;
      const changes = store.changes(filter);
      if (!changes.length) return close();
      // Every copy counts, as on the bar, in the progress and in Done; a merged entry says how many places it covers.
      h3.textContent = `Publish ${plural(changes.length, 'change')}`;
      const plan = planPublish(app, changes);
      const isBad = (c: Change) => plan.blocked.has(changeId(c));
      const undos = () => [...ui.querySelectorAll<HTMLElement>('[data-u]')];
      /** A row changed (undone, or its conflict resolved): the list again, with this row's place kept. */
      const after = (u: HTMLElement) => render(undos().indexOf(u));

      const row = (c: Change): ChangeRow => {
        const why = plan.blocked.get(changeId(c));
        const cs = store.cellStatus(c.slot.key, c.lcid);
        const ln = langName(app, c.lcid);
        const undo = link('Undo', (e) => {
          // The second click of a double-click would land on the row that moved up into this one's place.
          if (e.detail > 1) return;
          store.revert(c.slot.key, c.lcid);
          after(undo);
        });
        undo.dataset.u = '';
        undo.setAttribute('aria-label', `Undo the ${ln} change of ${titleOf(app, c.slot)}`);
        // An emptied translation Dataverse can't remove: the stand-in it writes, and a quiet note saying so; a metadata
        // description's, saved empty: that it is.
        const w = plan.written.get(changeId(c)) ?? c;
        return {
          lang: ln,
          before: c.before,
          after: w.after,
          blankBefore: missingSide(app, c, w),
          tone: why !== undefined ? 'bad' : '',
          end: undo,
          notes: [
            why ? rowNote('error', why) : null,
            why === undefined ? (standInNote(app, c.slot, c.lcid, w) ?? emptyNote(app, w)) : null,
            // The saver's warnings (placeholders, a removal, a global choice's other columns…): published all the same.
            ...(plan.warns.get(changeId(c)) ?? []).map((w) => rowNote('warn', w)),
            cs?.outcome === 'conflict'
              ? conflictBox(store, c, cs.server, () => after(undo))
              : // A reload brought other text under this edit (Store.moved): publishing it will stop at a conflict.
                store.moved(c.slot.key, c.lcid)
                ? rowNote('warn', 'Changed on the server since you edited it')
                : null,
          ],
        };
      };
      const clean = (g: Change[]) => g.every((c) => !isBad(c) && store.cellStatus(c.slot.key, c.lcid)?.outcome !== 'conflict' && !store.moved(c.slot.key, c.lcid));
      const gs = mergeCopies(grouped(changes, isBad), clean);
      /** One row for the same edit of every copy: its Undo reverts them all. */
      const rows = (cg: Change[][]): ChangeRow[] => (cg.length === 1 ? cg[0].map(row) : cg[0].map((c, i) => {
        const same = cg.map((g) => g.find((x) => x.lcid === c.lcid && x.after === c.after) ?? g[i]);
        const all = link('Undo', (e) => {
          if (e.detail > 1) return;
          store.group(() => same.forEach((x) => store.revert(x.slot.key, x.lcid)));
          render(undos().indexOf(all));
        });
        all.dataset.u = '';
        all.setAttribute('aria-label', `Undo the ${langName(app, c.lcid)} change of ${titleOf(app, c.slot)} in its ${cg.length} places`);
        return { ...row(c), end: all };
      }));
      const rest = gs.slice(CAP).reduce((a, cg) => a + cg.reduce((b, g) => b + g.length, 0), 0);
      // What else publishing publishes, checked while the user reads the list, said next to Publish.
      // Publish never outruns it: a click before it answers waits, and goes on by itself only when there is nothing to
      // say; else the sentence (others' work, or that it couldn't check) is read first and the next click publishes.
      const others = h('p', { class: 'pd-o', role: 'status', hidden: true });
      // The whole publish scope, with what can't be checked: shown from the start, so it never needs another click.
      const scope = plan.send.length ? scopeText(app, plan.send) : '';
      const checked = plan.send.length ? othersNote(app, plan.send, signal) : Promise.resolve('');
      /** The check's sentence once it has answered ('' for nothing to say); null while it runs. */
      let said: string | null = null;
      void checked.then((t) => {
        if (signal.aborted) return;
        said = t;
        put(others, t);
        others.hidden = !t;
      });
      let waiting = false;
      const go = () => {
        for (const [id, m] of plan.blocked) blockedWhy.set(id, m);
        void run(plan.send);
      };
      const cancel = btn('Cancel', () => close());
      const pub = btn('Publish', (e) => {
        if (e.detail > 1 || waiting) return; // a double-click publishes once
        if (said !== null) return go();
        waiting = true;
        put(others, h('span', { class: 'wait' }, spinner(), 'Checking for other unpublished changes…'));
        others.hidden = false;
        void checked.then(() => {
          waiting = false;
          if (!signal.aborted && said === '') go();
        });
      }, 'primary');
      pub.setAttribute('aria-keyshortcuts', 'Control+Enter');
      pub.disabled = !plan.send.length;
      (pub.disabled ? cancel : pub).dataset.af = '';
      ctrlEnter = pub;
      const top = ui.querySelector('.dlg-body')?.scrollTop ?? 0;
      put(ui,
        h('div', { class: 'dlg-body' },
          h('p', { class: 'pd-sub' }, page ? "They're saved and published, then the page refreshes so you see them." : "They're saved and published."),
          plan.notes.length ? h('div', { class: 'pd-gn' }, plan.notes.map((n) => h('div', { class: 'iss note' }, icon('info'), h('span', null, n)))) : null,
          gs.slice(0, CAP).map((cg) => changeGroup({ ...header(app, cg), rows: rows(cg) })),
          rest ? h('p', { class: 'quiet' }, `and ${plural(rest, 'more change')}. They're published too.`) : null,
        ),
        h('div', { class: 'dlg-actions' }, h('div', { class: 'pd-ow' }, others, scope ? h('p', { class: 'pd-sc' }, scope) : null), cancel, pub),
      );
      const body = ui.querySelector('.dlg-body');
      if (body) body.scrollTop = top;
      const us = at < 0 ? [] : undos();
      keepFocus(us[Math.min(at, us.length - 1)]);
    };

    // ---- progress ----
    const progress = (save: Change[] | null, pubSet: Change[]): Progress => {
      let t = new PublishSet();
      try {
        t = app.saver.publishTargets(pubSet);
        // A process is updated by the save that wrote its name (saver.ts step 5), never by publishing again.
        t.processes = save ? app.saver.publishTargets(save).processes : new Map();
      } catch {
        /* no publish step */
      }
      const live = h('div', { class: 'vh', 'aria-live': 'polite' });
      const p: Progress = {
        list: h('div', { class: 'pl pd-st' }),
        live,
        save: save ? step(`Saving ${plural(save.length, 'change')}`, live) : null,
        pub: t.empty && !t.processes.size ? null : step(`Publishing ${publishNames(app, pubSet, t)}`, live),
        chk: step('Checking', live),
        ref: page ? step('Refreshing the page', live) : null,
      };
      p.list.append(...[p.save, p.pub, p.chk, p.ref].filter((s): s is Step => !!s).map((s) => s.el));
      return p;
    };
    const showProgress = (p: Progress, stop: HTMLButtonElement | null) => {
      ctrlEnter = null;
      put(ui,
        h('div', { class: 'dlg-body' }, p.list, p.live),
        h('div', { class: 'dlg-actions' }, stop ? [h('span', { class: 'quiet' }, 'Stop takes effect before the next write.'), stop] : null),
      );
      // The dialog keeps the focus, never Stop: a second Enter or click meant for Publish must not cancel it.
      keepFocus();
    };

    /** Publishes what earlier runs saved but could not publish. */
    const republish = async (p: Progress, signal: AbortSignal): Promise<void> => {
      if (!S.needPub.length) return;
      S.chkErr = ''; // its forms are published and checked again
      p.pub?.set('run');
      try {
        await publishAgain(app, S.needPub, S.needHist, signal, (m) => p.pub?.now(m));
        S.published = true;
        S.needPub = [];
        S.needHist = [];
        S.pubErr = '';
        if (last) last = { ...last, published: true, publishError: undefined };
      } catch (e) {
        S.pubErr = pubFail(e);
      }
    };

    /**
     * The Checking step: what the saver verified, and that the forms really are published. Forms still unpublished,
     * or that it couldn't read (never taken for published), make their changes "saved, not published" again, journal
     * entries (`ids`) included, so Publish again (and Recent publishes › Publish once this dialog is closed) can
     * publish and check them.
     */
    const check = async (p: Progress, cs: Change[], ids: string[], signal: AbortSignal): Promise<void> => {
      p.chk.set('run');
      const { left, unread } = await unpublishedForms(app, cs, signal);
      if (left.length) S.pubErr = `${and(left)} still ${left.length === 1 ? 'has' : 'have'} unpublished changes.`;
      if (unread.length) S.chkErr = unreadText(unread, 'Publish again to publish');
      if (left.length || unread.length) {
        S.needPub.push(...cs.filter((c) => FORMISH.test(c.slot.kind)));
        S.needHist.push(...ids);
        await markPublished(app.ctx, ids, false);
        if (left.length) p.pub?.set('bad');
        p.chk.set('bad');
      } else p.chk.set('ok');
    };

    const run = async (cs: Change[]): Promise<void> => {
      // One save at a time (the saver refuses a second): a Workbench save may have started meanwhile.
      if (store.busy) return app.toast('Publishing can start once the save running now has finished. Try again in a moment.', 'warn');
      st.ac.abort(); // the others'-work check of the list
      busy(true);
      h3.textContent = `Publishing ${plural(cs.length, 'change')}`;
      const ac = new AbortController();
      const p = progress(cs, [...cs, ...S.needPub]);
      showProgress(p, stopButton(ac));
      p.save!.set('run', `0 of ${cs.length}`);
      if (!S.needPub.length) S.pubErr = '';
      let publishing = false;
      let rep: SaveReport | null = null;
      let err: unknown = null;
      // Recent publishes shows each label as this list did, so it is named before the save changes what its title is.
      const named = new Map(cs.map((c) => [c.slot.key, { title: titleOf(app, c.slot), where: whereOf(c.slot) }] as const));
      try {
        rep = await app.saver.save(cs, {
          signal: ac.signal,
          publish: true,
          describe: (s) => named.get(s.key) ?? { title: titleOf(app, s), where: whereOf(s) },
          onProgress: (x) => {
            // The saver says exactly this once everything is written, committed and journaled (saver.ts step 4).
            if (x.message === 'Publishing…') {
              publishing = true;
              p.save!.set('ok', ''); // the last write's message is over
              p.pub?.set('run');
            } else if (publishing) p.pub?.now(x.message); // "Dataverse is busy… Publishing again in 10 seconds…"
            else {
              p.save!.set('run', `${Math.min(x.done, cs.length)} of ${cs.length}`);
              // The item a write saves, or what it waits for ("Waiting for Dataverse to confirm Name…"), after the
              // counter; the bare "Saving…" between writes clears it. As Recent publishes › Undo shows it.
              p.save!.now(x.message);
            }
            // The Workbench footer and the minimized pill show it too.
            if (store.busy && x.total && !publishing) store.setBusy(true, `Saving ${x.done} of ${x.total}`);
          },
        });
      } catch (e) {
        err = e;
      }
      p.pub?.now(''); // the publish's last message is over
      const res: ChangeResult[] = rep ? rep.results : cs.map((change) => ({ change, outcome: 'error', message: errMsg(err) }));
      const ids = new Set(cs.map(changeId));
      const bad = res.filter((r) => r.outcome !== 'saved' && r.outcome !== 'unchanged');
      // A row already as asked is published (and checked) like a saved one: it may be an earlier write whose answer
      // was lost, which only this run's publish makes show (saver.ts step 4).
      const doneNow = res.filter((r) => r.outcome === 'saved' || r.outcome === 'unchanged').map((r) => r.change);
      S.probs = [...S.probs.filter((r) => !ids.has(changeId(r.change))), ...bad];
      S.saved.push(...doneNow);
      S.found += res.filter((r) => r.found).length;
      S.warning = rep?.warning || '';
      S.notice = rep?.notice || '';
      if (rep) last = rep;
      // Not "not saved": a row may say Dataverse accepted the change but doesn't show it yet.
      p.save!.set(bad.length ? 'bad' : 'ok', bad.length ? `${bad.length} of ${cs.length} ${bad.length === 1 ? 'needs' : 'need'} attention` : '');

      // The saver journals a row already as asked too when a write of that text it sent before may have run (saver.ts
      // step 3; never one it finds someone else saved, nor one only refused before, ChangeResult.found), so its entry is
      // tracked like a saved one's.
      const hist = rep?.historyId && doneNow.length ? [rep.historyId] : [];
      if (rep?.publishError) {
        S.pubErr = why(rep.publishError);
        S.needPub.push(...doneNow);
        S.needHist.push(...hist);
        p.pub?.set('bad');
      } else {
        if (rep?.published && doneNow.length) S.published = true;
        // What an earlier run saved but could not publish goes out now too, and is checked with the rest.
        const prev = { cs: S.needPub, ids: S.needHist };
        if (!ac.signal.aborted) await republish(p, ac.signal);
        const repub = S.needPub.length ? { cs: [], ids: [] } : prev;
        if (S.pubErr) p.pub?.set('bad');
        else if (S.published) p.pub?.set('ok');
        if (!S.pubErr && (doneNow.length || repub.cs.length)) await check(p, [...doneNow, ...repub.cs], [...hist, ...repub.ids], ac.signal);
        else if (!S.pubErr && !bad.length) p.chk.set('ok'); // nothing new to check: already on the server
      }
      busy(false);
      void settle(p);
    };

    /** Publish again: publishes what was saved but not published, then checks. */
    const again = async (): Promise<void> => {
      if (store.busy) return app.toast('Publishing can start once the save running now has finished. Try again in a moment.', 'warn');
      busy(true);
      h3.textContent = 'Publishing';
      const ac = new AbortController();
      const cs = S.needPub;
      const ids = S.needHist;
      const p = progress(null, cs);
      showProgress(p, null);
      // Publishing holds the org's customization lock: no other save starts meanwhile.
      store.setBusy(true, 'Publishing');
      try {
        await republish(p, ac.signal);
      } finally {
        store.setBusy(false);
      }
      if (S.pubErr) p.pub?.set('bad');
      else {
        p.pub?.set('ok');
        await check(p, cs, ids, ac.signal);
      }
      busy(false);
      void settle(p);
    };

    /** Failed and conflicting rows still staged, and the skipped (blocked) changes still staged. */
    const left = () => ({
      live: S.probs.filter((r) => store.isEdited(r.change.slot.key, r.change.lcid)),
      blocked: store.changes(filter).filter((c) => blockedWhy.has(changeId(c))),
    });

    /**
     * After a run: Done when everything went through (in translation mode the page then refreshes, unless `auto` is
     * false: the last problem was just resolved with Use theirs), else the problems. Never refreshes on a problem.
     */
    const settle = async (p: Progress, auto = true): Promise<void> => {
      const { live, blocked } = left();
      // A notice keeps the dialog open too: the page would refresh before it could be read.
      if (S.pubErr || S.chkErr || S.warning || S.notice || live.length || blocked.length) return fail(p);
      // Rows found already on the server that this translator never wrote are said apart: not published by it, nor undone with it.
      const f = Math.min(S.found, S.saved.length);
      const n = S.saved.length - f;
      const already = f ? `${plural(f, 'change')} ${f === 1 ? 'was' : 'were'} already on the server` : '';
      const said = n
        ? `Done. Published ${plural(n, 'change')}.${already ? ` ${already}, so Undo of this publish leaves ${f === 1 ? 'it' : 'them'} alone.` : ''}`
        : already
          ? `Done. ${already}: nothing was written.`
          : 'Done. Nothing needed publishing.';
      if (page && S.published && auto) {
        h3.textContent = 'Published';
        p.ref?.set('run');
        put(ui, h('div', { class: 'dlg-body' }, p.list, h('p', { class: 'pd-done', role: 'status' }, 'Done. Refreshing the page…')));
        keepFocus();
        if (await app.refreshPage().catch(() => false)) return; // the page reloads; the app (and this dialog) is gone
        if (!dlg.isConnected) return;
      }
      p.ref?.el.remove();
      h3.textContent = 'Published';
      const closeB = btn('Close', () => close(), 'primary');
      put(ui,
        h('div', { class: 'dlg-body' },
          p.list,
          h('p', { class: 'pd-done', role: 'status' }, said),
        ),
        h('div', { class: 'dlg-actions' }, S.published ? btn('Refresh page', () => void app.refreshPage()) : null, closeB),
      );
      keepFocus(closeB);
    };

    /** The problems: failed rows (with the saver's reason), conflicts, skipped blocked rows; Try again / Publish again. */
    const fail = (p: Progress): void => {
      const { live, blocked } = left();
      const byId = new Map(live.map((r) => [changeId(r.change), r] as const));
      // The rows as staged now (Keep mine rebased them on the server text).
      const now = new Map(store.changes().map((c) => [changeId(c), c] as const));
      const rows = [...live.map((r) => now.get(changeId(r.change)) ?? r.change), ...blocked.filter((c) => !byId.has(changeId(c)))];
      const retry = retryable(app, live);
      // Each as Try again would write it (it sends `retry` alone): an emptied translation Dataverse can't remove as its stand-in.
      const written = asWritten(app, retry);
      // Only a warning left (e.g. the Dynamics language could not be switched back): published, but no automatic refresh.
      h3.textContent = rows.length ? "Some changes weren't published" : S.pubErr ? 'Saved, but not published' : S.chkErr ? 'Published, but not checked' : 'Published';
      const row = (c: Change): ChangeRow => {
        const id = changeId(c);
        const r = byId.get(id);
        const cs = store.cellStatus(c.slot.key, c.lcid);
        const conflict = cs?.outcome === 'conflict';
        const msg = conflict ? '' : r ? (r.outcome === 'conflict' ? '' : r.message || "Couldn't be saved.") : blockedWhy.get(id) || '';
        const w = written.get(id) ?? c;
        return {
          lang: langName(app, c.lcid),
          before: c.before,
          after: w.after,
          blankBefore: missingSide(app, c, w),
          tone: conflict || msg ? 'bad' : '',
          // A failed metadata row: what this page sent and Dataverse answered for its component, for support.
          end: r?.outcome === 'error' && writesOf(c.slot.group).length ? copyDetails(app, w, msg) : null,
          notes: [
            msg ? rowNote('error', msg) : null,
            standInNote(app, c.slot, c.lcid, w) ?? emptyNote(app, w),
            conflict ? conflictBox(store, c, cs!.server, () => void settle(p, false)) : null,
            r?.outcome === 'conflict' && !conflict ? h('div', { class: 'pd-n' }, 'Yours is kept. Try again publishes it.') : null,
          ],
        };
      };
      const notes: Node[] = [];
      if (S.pubErr) notes.push(note('warn', `Saved, but publishing failed: ${S.pubErr}`, 'amb'));
      if (S.chkErr) notes.push(note('warn', S.chkErr, 'amb'));
      if (S.warning) notes.push(note('error', S.warning, 'bad'));
      if (S.notice) notes.push(note('warn', S.notice, 'amb'));
      // Try again also publishes what an earlier publish left unpublished (run → republish).
      const tryB = retry.length ? btn('Try again', () => void run(retryable(app, left().live)), 'primary') : null;
      const againB = (S.pubErr || S.chkErr) && S.needPub.length && !retry.length ? btn('Publish again', () => void again(), 'primary') : null;
      const first = tryB || againB;
      const closeB = btn('Close', () => close(), first ? '' : 'primary');
      const gs = grouped(rows, () => false);
      put(ui,
        h('div', { class: 'dlg-body' },
          p.list,
          notes,
          gs.slice(0, CAP).map((g) => changeGroup({ ...header(app, [g]), rows: g.map(row) })),
          gs.length > CAP ? h('p', { class: 'quiet' }, `and ${plural(gs.length - CAP, 'more')}`) : null,
        ),
        h('div', { class: 'dlg-actions' }, tryB, againB, page && S.published ? btn('Refresh anyway', () => void app.refreshPage()) : null, closeB),
      );
      keepFocus(first || closeB);
    };

    render();
    return ui;
  }, { wide: true, canClose: () => !st.busy });
  st.ac.abort();
  // Closed with saves whose publish failed (or wasn't confirmed): nothing is lost, and Recent publishes can publish them.
  if (S.needPub.length)
    app.toast(S.pubErr || !S.chkErr ? 'Your translations are saved, but not published yet. Publish them from Recent publishes.' : "Your translations are saved, but whether they're published couldn't be checked. Publish them again from Recent publishes.", 'warn', {
      label: 'Recent publishes',
      run: () => void (modalOpen() || openHistory(app)),
    });
  return last;
}

/**
 * "Copy details" of a failed metadata row: this page's last writes of its component (providers/writelog.ts) as plain text
 * on the clipboard, with the org, the component and the row's message, for support. Says "Copied" for a moment.
 */
function copyDetails(app: AppApi, c: Change, message: string): HTMLButtonElement {
  const label = 'Copy details';
  const b = link(label, async (e) => {
    if (e.detail > 1) return;
    const head = [`Org: ${app.ctx.origin || app.ctx.org || ''}`, `Component: ${titleOf(app, c.slot)} · ${whatOf(c.slot)} (${c.slot.group})`, `Change: ${langName(app, c.lcid)} ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`, `Reported: ${message}`];
    const ok = await copyText(writeDetails(c.slot.group, head), b);
    b.textContent = ok ? 'Copied' : "Couldn't copy";
    setTimeout(() => (b.textContent = label), 2000);
  });
  b.setAttribute('aria-label', `Copy the details of the ${langName(app, c.lcid)} change of ${titleOf(app, c.slot)} for support`);
  return b;
}

/** Puts `text` on the clipboard: the Clipboard API, else a selected text box and execCommand('copy') (no permission, older Edge). */
async function copyText(text: string, near: HTMLElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* the fallback below */
  }
  // Next to the link, so the focus stays in the dialog.
  const box = h('textarea', { 'aria-hidden': 'true', tabIndex: -1, style: { position: 'fixed', top: '0', left: '-9999px', opacity: '0' } });
  box.value = text;
  near.after(box);
  try {
    box.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    box.remove();
    near.focus();
  }
}

/** Someone changed the text on the server after it was loaded: keep mine (published next time) or use theirs. */
function conflictBox(store: Store, c: Change, server: string | undefined, after: () => void): HTMLElement {
  const pick = (mine: boolean) => () => {
    store.resolve(c.slot.key, c.lcid, mine);
    after();
  };
  return h('div', { class: 'cf' },
    'Someone changed this on the server after you loaded it:',
    h('q', null, server || '(empty)'),
    h('div', { class: 'acts' }, btn('Keep mine', pick(true), 'sm'), btn('Use theirs', pick(false), 'sm')),
  );
}

// ---- Recent publishes (history with Undo) ----

/** A label of an undo run: its progress mark, and its row (the journaled item, with its text when Undo read it). */
interface Item {
  id: string;
  title: string;
  lcid: number;
  sub: string;
  it: HistoryItem;
  /** Its text on the server when the Undo question read it (undefined: not read). */
  now?: string;
}
const TITLES = ['Undoing the publish', 'Publish undone', 'Undone with problems', 'Undo stopped', 'Undo failed'];
/** A progress mark's tone and icon per outcome. */
const OUT: Record<Outcome, [string, IconName]> = {
  saved: ['ok', 'check'],
  unchanged: ['', 'check'],
  conflict: ['amb', 'warn'],
  error: ['bad', 'error'],
  skipped: ['', 'info'],
};
const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const more = (n: number, what: string) => (n > 0 ? h('div', { class: 'pr quiet' }, `and ${plural(n, what)}`) : null);
/** Only spaces counts as no text, as the writers compare texts. */
const bare = (t: string) => (t.trim() ? t : '');
/**
 * A translation the publish added that the undo can't remove and that has no stand-in (`why`, model.ts standIn: where it
 * has one, the undo writes that), or a base-language text it can't blank.
 */
const staysText = (app: AppApi, l: Lcid, why = '') =>
  l === app.ctx.base ? `Stays: the ${langName(app, l)} text can't be blank` : `Stays: Dataverse can't remove it${why ? `, and ${why}` : ''}`;

/** Sitemap items, which their title names (providers/sitemap.ts), as Recent publishes calls them. */
const ITEM = new Map<Kind, [string, string]>([
  ['area', ['an area', 'areas']],
  ['group', ['a group', 'groups']],
  ['subarea', ['a menu item', 'menu items']],
]);

/**
 * The labels of a publish that named a sitemap item without a base-language title (an app designer's placeholder,
 * "New Group", model.ts namesFirst): its base-language title, and the titles it got with it in languages that had
 * none. Undo never writes them: the base-language title can't be blank again (the item can't go back to its
 * placeholder), and taking the others away alone would leave those languages on the base name, which they never
 * showed either. Ids (`key#lcid`), from the journal alone (its labels may not be loaded here).
 */
export function namings(items: readonly HistoryItem[], base: Lcid): Set<string> {
  const named = new Set(items.filter((it) => it.lcid === base && ITEM.has(it.kind) && propOf(it.key) === 'Title' && !bare(it.before) && !!bare(it.after)).map((it) => it.key));
  return new Set(items.filter((it) => named.has(it.key) && !bare(it.before)).map(itemId));
}

/** Why the labels that named sitemap items stay (namings): Recent publishes' line and the Undo question's. */
export function namingText(its: readonly HistoryItem[]): string {
  const keys = new Set(its.map((it) => it.key));
  const kinds = new Set(its.map((it) => it.kind));
  const one = keys.size === 1;
  const [a, many] = (kinds.size === 1 && ITEM.get(its[0].kind)) || ['an item', 'items'];
  return `Naming ${one ? a : `these ${many}`} can't be undone: Dynamics needs a name once ${one ? 'it has' : 'they have'} one. Rename ${one ? 'it' : 'them'} here if needed.`;
}

/** What an undo does to one label (undoRows). */
export type UndoState = 'undo' | 'same' | 'changed' | 'stays' | 'named' | 'refused' | 'unloaded' | 'unread';
export interface UndoRow {
  it: HistoryItem;
  state: UndoState;
  /** Its text on the server now ('' for none), when it was read. */
  now?: string;
  /**
   * Why it can't be undone ('stays', 'refused'), why its text couldn't be read ('unread'), or for a label that is loaded
   * but whose stand-in is made of texts that aren't ('unloaded'), what to load (absent: its component isn't loaded).
   */
  why?: string;
  /**
   * A translation the publish added that Dataverse can't remove: the stand-in the undo writes in its place (model.ts
   * standIn), so the page looks as before.
   */
  standIn?: Pick<StandIn, 'text' | 'from'>;
  /**
   * A metadata description the undo saves empty again (it was stored empty before the publish, HistoryItem.empty;
   * model.ts savesEmpty): its users see none, as before.
   */
  empty?: true;
}

/**
 * What undoing a journal entry does to each of its labels, from their texts on the server now (saver.current) and the
 * undo's own checks and comparisons (saver.ts check; the writers' compare, where only spaces is no text): 'undo' back to
 * its earlier text, or for a translation the publish added that Dataverse can't remove, to its stand-in (`standIn`);
 * 'same' already as that; 'changed' someone changed it since the publish, so the undo leaves it as it is (a conflict)
 * unless the user chooses to undo it anyway; 'stays' a translation the publish added that Dataverse can't remove and
 * that has no stand-in; 'named' it named a sitemap item (namings), which the undo never writes, nor reads; 'refused'
 * another check refuses it (read-only); 'unloaded' its component isn't loaded here, or its stand-in is made of texts
 * that aren't (`why` says what to load): skipped, the publish stays undoable; 'unread' its text couldn't be read (the
 * undo still checks it before writing). Measured as saver.undo() measures them (SaverApi.prepare, as an undo): its
 * stand-ins by the texts as the undo leaves them, the earlier texts it writes back, else the server's as just read.
 */
export function undoRows(app: AppApi, e: HistoryEntry, now: ServerTexts): UndoRow[] {
  const fixed = namings(e.items, app.ctx.base);
  // As saver.undo() builds them (undoChange): back to `before`, measured against the text the publish wrote.
  const given = e.items.map((it): Change | null => {
    if (fixed.has(itemId(it))) return null;
    const slot = app.store.get(it.key);
    return slot ? undoChange(slot, it) : null;
  });
  const loaded = given.filter((c): c is Change => !!c);
  let prep: Prepared = { written: loaded, issues: [], text: (k, l) => app.store.text(k, l, true) };
  try {
    prep = app.saver.prepare(loaded, { undo: true, now });
  } catch {
    /* the undo reports what its checks refuse */
  }
  const { text } = prep;
  const as = new Map(loaded.map((c, i) => [c, prep.written[i] ?? c] as const));
  const errs = new Map<Change, Issue>();
  for (const i of prep.issues) if (i.level === 'error' && !errs.has(i.change)) errs.set(i.change, i);
  return e.items.map((it, i): UndoRow => {
    const g = given[i];
    if (fixed.has(itemId(it))) return { it, state: 'named' };
    if (!g) return { it, state: 'unloaded' };
    const c = as.get(g) ?? g;
    const got = now.get(changeId(c));
    const err = errs.get(g);
    // Held back until what stands in for it is loaded: never "stays", never "Mark as undone".
    if (err?.unloaded && !(typeof got === 'string' && bare(got) === bare(it.before))) return { it, state: 'unloaded', ...(typeof got === 'string' ? { now: got } : {}), why: unloadedWhy(app, c) };
    const no: UndoState | null = !err ? null : refusedBlank({ change: c, outcome: 'error' }, app.ctx.base) ? 'stays' : 'refused';
    // A translation Dataverse can't remove that has no stand-in says why in a few words (its row), else the check's message.
    const why = no === 'stays' && c.lcid !== app.ctx.base ? (standIn(c.slot, c.lcid, app.ctx.base, c.before, c.after, text, c.untranslated)?.why ?? '') : err?.message;
    const read = typeof got === 'string' ? { now: got } : {};
    const sub = c.standIn ? { standIn: { text: c.after, from: c.standIn.from } } : !c.after.trim() && savesEmpty(c.slot, c.lcid, app.ctx.base, c.untranslated) ? { empty: true as const } : {};
    // Refused whatever the server holds (read-only): the undo skips it without reading it.
    if (no === 'refused') return { it, state: no, ...read, why };
    if (typeof got !== 'string') return no ? { it, state: no, why } : { it, state: 'unread', why: got?.message || 'It was not read', ...sub };
    // Already as before, but for a description the publish stored empty where it had no translation (Change.untranslated):
    // its users saw the base text, which the undo puts in its place.
    if (bare(got) === bare(it.before) && !(c.untranslated && c.standIn)) return { it, state: 'same', now: got };
    // Its stand-in is there already (someone typed that text): nothing to write.
    if (c.standIn && bare(got) === bare(c.after)) return { it, state: 'same', now: got, ...sub };
    if (no) return { it, state: no, now: got, why };
    return { it, state: bare(got) === bare(it.after) ? 'undo' : 'changed', now: got, ...sub };
  });
}

/**
 * What to load before a label can be undone whose stand-in is made of texts that aren't loaded (model.ts
 * StandIn.unloaded): "Its column's names aren't loaded here: load its table's columns, then undo again".
 */
function unloadedWhy(app: AppApi, c: Change): string {
  const x = standIn(c.slot, c.lcid, app.ctx.base, c.before, c.after, () => undefined, c.untranslated);
  return x?.from === 'base' ? `Its ${langName(app, app.ctx.base)} text isn't loaded here: load its labels in all languages, then undo again` : "Its column's names aren't loaded here: load its table's columns, then undo again";
}

/** How many labels Undo writes: those to undo, those it couldn't read, and those changed since the user chose. */
export const undoCount = (rows: readonly UndoRow[], chosen: ReadonlySet<string>): number =>
  rows.filter((r) => r.state === 'undo' || r.state === 'unread' || (r.state === 'changed' && chosen.has(itemId(r.it)))).length;

/** Progress, results and retry of an undo inside the Recent publishes dialog (`ui` is the swappable content). */
function undoRunner(app: AppApi, ui: HTMLElement, dlg: HTMLElement, close: () => void, setBusy: (b: boolean) => void) {
  const h3 = dlg.querySelector('h3')!;
  const xb = dlg.querySelector<HTMLButtonElement>('.dlg-h .btn');
  const busy = (b: boolean) => {
    setBusy(b);
    if (xb) xb.disabled = b;
  };
  const fix = (c: Change) => {
    const l = link('Fix', () => (close(), app.edit(c.slot.comp, c.lcid)));
    l.setAttribute('aria-label', `Fix the ${langName(app, c.lcid)} text of ${titleOf(app, c.slot)}`);
    return l;
  };
  /** A Publish is checking what else it publishes: another click waits for it. */
  let asking = false;

  /** `retry` gets the ids of the items not back yet and how many of the others Dataverse can't remove (refusedBlank). */
  type Retry = (left: Set<string>, kept: number) => void;

  async function run(exec: (o: Omit<SaveRunOptions, 'publish'>) => Promise<SaveReport>, items: Item[], retry: Retry): Promise<void> {
    if (app.store.busy) {
      app.toast('Undo can start once the save running now has finished. Try again in a moment.', 'warn');
      return;
    }
    busy(true);
    h3.textContent = TITLES[0];
    const ac = new AbortController();
    const pb = bar();
    // The steps of the Publish dialog, as steady: what is written now stays on the running step's line.
    const live = h('div', { class: 'vh', 'aria-live': 'polite' });
    const undo = step(`Undoing ${plural(items.length, 'label')}`, live);
    const pub = step('Publishing', live);
    const marks = new Map<string, HTMLElement>();
    const shown = items.slice(0, CAP);
    const stop = stopButton(ac);
    put(ui,
      h('div', { class: 'dlg-body' }, pb, h('div', { class: 'pl pd-st' }, undo.el, pub.el), live,
        h('div', { class: 'pl' },
          shown.map((it) => {
            const mk = h('span', { class: 'ps w' });
            marks.set(it.id, mk);
            return h('div', { class: 'pr' }, mk, h('span', { class: 'pt' }, it.title, h('small', null, ` · ${it.sub} · ${lcidShort(it.lcid)}`)));
          }),
          more(items.length - shown.length, 'more label'),
        ),
      ),
      h('div', { class: 'dlg-actions' }, h('span', { class: 'quiet' }, 'Stop takes effect before the next write.'), stop),
    );
    dlg.focus(); // never Stop (see stopButton); the button that started the undo is gone
    undo.set('run', `0 of ${items.length}`);
    let publishing = false;
    const got: ChangeResult[] = [];
    let rep: SaveReport | null = null;
    let err: unknown = null;
    try {
      rep = await exec({
        signal: ac.signal,
        onProgress: (p) => {
          pb.set(p.total ? p.done / p.total : null);
          if (p.message === 'Publishing…') {
            publishing = true;
            undo.set('ok', '');
            pub.set('run');
          } else if (publishing) pub.now(p.message);
          else {
            if (p.total) undo.set('run', `${Math.min(p.done, p.total)} of ${p.total}`);
            undo.now(p.message);
          }
          if (app.store.busy && p.total) app.store.setBusy(true, `Undoing ${p.done} of ${p.total}`);
        },
        onResult: (r) => {
          got.push(r);
          const mk = marks.get(changeId(r.change));
          if (mk) {
            mk.className = 'ps ' + OUT[r.outcome][0];
            put(mk, icon(OUT[r.outcome][1]));
          }
        },
      });
    } catch (e) {
      err = e;
    } finally {
      busy(false);
    }
    results(rep, err, items, got, retry, ac.signal.aborted);
  }

  /** The undo's result: what happened to each label, in the rows the Undo question showed, and Try again / Redo. */
  function results(rep: SaveReport | null, err: unknown, items: Item[], got: ChangeResult[], retry: Retry, stopped: boolean): void {
    const res = rep?.results ?? got;
    const n = (k: Outcome) => res.filter((r) => r.outcome === k).length;
    const done = new Set(res.map((r) => changeId(r.change)));
    const failed = new Set([...res.filter((r) => r.outcome === 'error' || r.outcome === 'skipped').map((r) => changeId(r.change)), ...items.filter((it) => !done.has(it.id)).map((it) => it.id)]);
    const probs = res.filter((r) => r.outcome === 'conflict' || r.outcome === 'error' || r.outcome === 'skipped');
    // A blank Dataverse refuses every time (a translation it can't remove) is not offered again.
    const never = new Set(res.filter((r) => refusedBlank(r, app.ctx.base)).map((r) => changeId(r.change)));
    const again = [...failed].filter((id) => !never.has(id)).length;
    // Try again sends only what is not back yet (conflicts included, so the publish is not marked undone over them).
    const back = new Set(res.filter((r) => r.outcome === 'saved' || r.outcome === 'unchanged').map((r) => changeId(r.change)));
    const left = new Set(items.map((it) => it.id).filter((id) => !back.has(id) && !never.has(id)));
    h3.textContent = stopped ? TITLES[3] : err && !rep ? TITLES[4] : probs.some((r) => r.outcome !== 'skipped') ? TITLES[2] : TITLES[1];

    const saved = rep?.saved ?? n('saved');
    const notes: Node[] = [];
    if (err && !isAbort(err)) notes.push(note('error', errMsg(err), 'bad'));
    if (stopped) notes.push(note('info', `Stopped. The labels written before stopping are back to their earlier text${failed.size ? `; ${plural(failed.size, 'label')} not undone yet` : ''}.`));
    if (rep?.publishError) notes.push(note('warn', rep.publishError, 'amb'));
    else if (rep?.published) notes.push(note('okc', 'The previous text is live again. Refresh the page to see it.', 'ok'));
    if (rep?.warning) notes.push(note('warn', rep.warning, 'bad'));
    if (rep?.notice) notes.push(note('warn', rep.notice, 'amb'));
    const told = new Set(res.filter((r) => (r.outcome === 'saved' || r.outcome === 'unchanged') && r.message).map((r) => r.message!));
    for (const m of told) notes.push(note('warn', m, 'amb'));

    // Each label's outcome, under the texts the Undo question showed (a conflict: the text that is there now).
    const byId = new Map(res.map((r) => [changeId(r.change), r] as const));
    const nowOf = new Map(items.map((x) => [x.id, x.now] as const));
    // Why a translation Dataverse can't remove stayed: it has no stand-in, by the texts as the undo left them.
    let text: TextOf = (k, l) => app.store.text(k, l, true);
    try {
      text = app.saver.prepare(res.map((r) => r.change), { undo: true }).text;
    } catch {
      /* said without the reason */
    }
    const row = ([it]: HistoryItem[]): ChangeRow => {
      const r = byId.get(itemId(it));
      const from = (r?.outcome === 'conflict' ? r.server : undefined) ?? nowOf.get(itemId(it)) ?? it.after;
      // A translation Dataverse can't remove went to its stand-in (the text written), with a quiet note saying so; a
      // description saved empty again, too.
      const sub = r?.change.standIn ? standInNote(app, r.change.slot, it.lcid, r.change) : emptyNote(app, r?.change);
      const base = { lang: langName(app, it.lcid), before: from, after: sub ? r!.change.after : it.before };
      const fixIt = () => (r && app.store.get(it.key) ? fix(r.change) : null);
      if (!r) return { ...base, tone: 'off', notes: [rowNote('note', 'Not undone yet')] };
      if (r.outcome === 'saved') return { ...base, notes: [rowNote('ok', 'Undone'), sub] };
      if (r.outcome === 'unchanged') return { ...base, tone: 'off', notes: [rowNote('note', 'Already as before'), sub] };
      if (r.outcome === 'conflict') return { ...base, tone: 'amb', end: fixIt(), notes: [rowNote('warn', 'Changed since this publish, so it was left as it is'), sub] };
      if (refusedBlank(r, app.ctx.base)) {
        const c = r.change;
        const why = c.lcid === app.ctx.base ? '' : (standIn(c.slot, c.lcid, app.ctx.base, c.before, c.after, text, c.untranslated)?.why ?? '');
        return { ...base, tone: 'off', notes: [rowNote('note', staysText(app, it.lcid, why))] };
      }
      if (r.outcome === 'error') return { ...base, tone: 'bad', end: fixIt(), notes: [rowNote('error', r.message || "Couldn't be undone"), sub] };
      return { ...base, tone: 'off', notes: [rowNote('note', r.message || 'Skipped')] };
    };
    const gs = entryGroups(items.map((x) => x.it), row, (it) => byId.get(itemId(it))?.outcome ?? '');
    const count = (k: number, one: string, what: string, many = what) => (k ? `${plural(k, one)} ${k === 1 ? what : many}` : '');
    const said = [
      count(saved, 'label', 'undone'),
      count(rep?.unchanged ?? n('unchanged'), 'label', 'already as before'),
      count(n('conflict'), 'label', 'changed since, left as it was', 'changed since, left as they were'),
      count(never.size, 'translation', "Dataverse can't remove"),
      count(n('error') - never.size, 'label', "couldn't be undone"),
      count(n('skipped'), 'label', 'skipped'),
      count(items.length - done.size, 'label', 'not undone yet'),
    ].filter(Boolean);

    const entry = rep?.historyId ? app.saver.history().find((x) => x.id === rep.historyId) : undefined;
    const closeB = btn('Close', () => close(), 'primary');
    put(ui,
      h('div', { class: 'dlg-body' },
        said.length ? h('p', { class: 'pd-done', role: 'status' }, `${said.join(', ')}.`) : null,
        notes,
        gs.slice(0, CAP).map((g) => changeGroup(g)),
        gs.length > CAP ? h('p', { class: 'quiet' }, `and ${plural(gs.length - CAP, 'more label')}`) : null,
      ),
      h('div', { class: 'dlg-actions' },
        again ? btn('Try again', () => retry(left, never.size)) : null,
        entry && saved ? btn('Redo', () => void undoEntry(entry)) : null,
        rep?.published && saved ? btn('Refresh page', () => void app.refreshPage()) : null,
        closeB,
      ),
    );
    closeB.focus();
  }

  /**
   * The Undo question: what undoing `e` does to each label, in the Publish dialog's rows, from its text on the server
   * now (read first, as the undo reads each label before writing it): back to its earlier text (a translation Dataverse
   * can't remove: to its stand-in, with a quiet note), already as before, changed since (left as it is unless the user
   * chooses Undo anyway), a translation Dataverse can't remove that has no stand-in, a name it gave a sitemap item
   * (namings: never read nor written), not loaded here. Nothing is written before Undo. Resolves
   * with the rows and the changed labels chosen, or undefined (Cancel).
   */
  async function ask(e: HistoryEntry, cs: Change[]): Promise<{ rows: UndoRow[]; anyway: Set<string> } | undefined> {
    const ac = new AbortController();
    try {
      return await modal<{ rows: UndoRow[]; anyway: Set<string> }>('Undo this publish?', (done) => {
        /** Ids of the labels changed since that the user chose to undo anyway. */
        const chosen = new Set<string>();
        let rows: UndoRow[] | null = null;
        /** Publishing the undo publishes others' unpublished work on the same tables too: said before Undo can run. */
        let checked = !cs.length;
        const go = btn('Undo', () => rows && done({ rows, anyway: new Set(chosen) }), 'primary');
        go.disabled = true;
        const cancel = btn('Cancel', () => done());
        cancel.dataset.af = '';
        const status = h('div', { class: 'quiet wait', role: 'status' }, spinner(), 'Reading the current text…');
        const list = h('div', { class: 'pd-ul' });
        const others = h('p', { class: 'pd-o', role: 'status', hidden: true });
        const scope = cs.length ? scopeText(app, cs) : '';
        const update = () => {
          if (!rows) return;
          const n = undoCount(rows, chosen);
          // Nothing to write, and every label is as this undo would leave it: Undo only marks the publish undone.
          const mark = !n && rows.length > 0 && rows.every((r) => r.state === 'same' || r.state === 'stays' || r.state === 'named');
          go.textContent = mark ? 'Mark as undone' : `Undo ${plural(n, 'change')}`;
          go.disabled = !checked || (!n && !mark);
        };
        const row = (copies: HistoryItem[], byId: Map<string, UndoRow>): ChangeRow => {
          const r = byId.get(itemId(copies[0]))!;
          const { it } = r;
          const ln = langName(app, it.lcid);
          // A translation Dataverse can't remove goes to its stand-in, with a quiet note saying so.
          const base = { lang: ln, before: r.now ?? it.after, after: r.standIn?.text ?? it.before };
          // One saved empty again (as it was before the publish) says so quietly too.
          const sub = r.standIn
            ? standInNote(app, app.store.get(it.key), it.lcid, { before: r.now ?? it.after, after: r.standIn.text, standIn: { from: r.standIn.from, typed: it.before } })
            : r.empty
              ? rowNote('note', savedEmptyText(it, ln))
              : null;
          switch (r.state) {
            case 'undo':
              return sub ? { ...base, notes: [sub] } : base;
            case 'same':
              return { ...base, tone: 'off', notes: [rowNote('note', 'Already as before'), sub] };
            case 'changed': {
              const box = h('input', { type: 'checkbox', 'aria-label': `Undo the ${ln} change of ${it.title} anyway${r.now ? `, replacing “${r.now}”` : ''}` });
              box.addEventListener('change', () => {
                for (const x of copies)
                  if (box.checked) chosen.add(itemId(x));
                  else chosen.delete(itemId(x));
                update();
              });
              return { ...base, tone: 'amb', end: h('label', { class: 'chk' }, box, 'Undo anyway'), notes: [rowNote('warn', 'Changed since this publish: not undone unless you choose Undo anyway'), sub] };
            }
            case 'stays':
              return { ...base, tone: 'off', notes: [rowNote('note', staysText(app, it.lcid, r.why))] };
            case 'named':
              return { ...base, tone: 'off', notes: [rowNote('note', `Stays: naming ${ITEM.get(it.kind)?.[0] || 'an item'} can't be undone`)] };
            case 'refused':
              return { ...base, tone: 'off', notes: [rowNote('error', r.why || "Can't be undone")] };
            case 'unloaded':
              return { ...base, tone: 'off', notes: [rowNote('note', r.why || "Not loaded here: open the page it's on, or load it in the Workbench, to undo it")] };
            default:
              return { ...base, notes: [rowNote('warn', `Couldn't read its current text (${(r.why || '').replace(/[.!]+$/, '')}). The undo checks it again before writing`), sub] };
          }
        };
        const show = (rs: UndoRow[]) => {
          rows = rs;
          const byId = new Map(rs.map((r) => [itemId(r.it), r] as const));
          // The labels that ask for a choice first, as the Publish dialog lists its problems first.
          const asks = new Set(rs.filter((r) => r.state === 'changed').map((r) => r.it.key));
          const order = [...e.items.filter((it) => asks.has(it.key)), ...e.items.filter((it) => !asks.has(it.key))];
          const gs = entryGroups(order, (copies) => row(copies, byId), (it) => `${byId.get(itemId(it))?.state}\n${byId.get(itemId(it))?.now ?? ''}`);
          put(list, gs.slice(0, CAP).map((g) => changeGroup(g)), gs.length > CAP ? h('p', { class: 'quiet' }, `and ${plural(gs.length - CAP, 'more label')}`) : null);
          const k = (s: UndoState) => rs.filter((r) => r.state === s).length;
          const are = (x: number) => (x === 1 ? 'is' : 'are');
          // Translations the publish added that the undo writes as their stand-in, said in the rows' words: what they get,
          // and why (model.ts standInsSaid).
          const sis = rs.flatMap((r) => {
            const s = r.state === 'undo' && r.standIn ? app.store.get(r.it.key) : undefined;
            return s ? [{ s, l: r.it.lcid, from: r.standIn!.from }] : [];
          });
          const si = sis.length && standInsSaid(sis, app.ctx.base);
          const one = sis.length === 1;
          // Labels loaded whose stand-in is made of texts that aren't (`why`), apart from those not loaded at all.
          const waits = rs.filter((r) => r.state === 'unloaded' && r.why).length;
          const gone = k('unloaded') - waits;
          const said = [
            k('changed') && `${plural(k('changed'), 'label')} changed since this publish ${are(k('changed'))} left as ${k('changed') === 1 ? 'it is' : 'they are'} unless you choose Undo anyway.`,
            si && `${plural(sis.length, 'translation')} this publish added ${one ? 'gets' : 'get'} ${si.what} in ${one ? 'its' : 'their'} place: ${si.why}.`,
            k('same') && `${plural(k('same'), 'label')} ${are(k('same'))} already as before.`,
            k('stays') && `${plural(k('stays'), 'translation')} this publish added ${k('stays') === 1 ? 'stays' : 'stay'}: Dataverse can't remove ${k('stays') === 1 ? 'it' : 'them'}.`,
            k('named') && namingText(rs.filter((r) => r.state === 'named').map((r) => r.it)),
            gone && `${plural(gone, 'label')} ${gone === 1 ? "isn't" : "aren't"} loaded here.`,
            waits && `${plural(waits, 'label')} can't be undone until the texts put in ${waits === 1 ? 'its' : 'their'} place are loaded.`,
          ].filter(Boolean);
          put(status, said.join(' '));
          status.hidden = !said.length;
          update();
        };
        void app.saver.current(cs, ac.signal).then((now) => show(undoRows(app, e, now)), (x) => {
          if (!ac.signal.aborted) show(undoRows(app, e, new Map(cs.map((c) => [changeId(c), x instanceof Error ? x : new Error(String(x))]))));
        });
        if (cs.length)
          void othersNote(app, cs, ac.signal, CHECK_MS, !e.published).then((t) => {
            checked = true;
            put(others, t);
            others.hidden = !t;
            update();
          });
        return frag(
          h('div', { class: 'dlg-body' },
            h('p', { class: 'pd-sub' }, `Each label goes back to the text it had before this publish (${when(e.at)}), and the undo is published. Nothing changes until you choose Undo.`),
            status,
            list,
          ),
          h('div', { class: 'dlg-actions' }, h('div', { class: 'pd-ow' }, others, scope ? h('p', { class: 'pd-sc' }, scope) : null), cancel, go),
        );
      }, { wide: true });
    } finally {
      ac.abort(); // a read still running when the question closes
    }
  }

  async function undoEntry(e: HistoryEntry): Promise<void> {
    if (asking) return; // a Publish is about to ask its own question
    // The labels that named a sitemap item are never written (namings): not read, not in the publish either.
    const fixed = namings(e.items, app.ctx.base);
    const mine = e.items.filter((it) => !fixed.has(itemId(it)));
    if (!mine.length) return;
    const cs: Change[] = [];
    for (const it of mine) {
      const slot = app.store.get(it.key);
      if (slot) cs.push({ slot, lcid: it.lcid, before: it.after, after: it.before });
    }
    const ok = await ask(e, cs);
    if (!ok) return;
    const now = new Map(ok.rows.map((r) => [itemId(r.it), r.now] as const));
    // A label changed since that the user chose to undo anyway is measured against the text just read, in place of the
    // one the publish wrote: a text changed again since that read is still a conflict, never overwritten.
    const rebase = (it: HistoryItem): HistoryItem => {
      const t = now.get(itemId(it));
      return ok.anyway.has(itemId(it)) && t !== undefined ? { ...it, after: t } : it;
    };
    // They stay, as the translations Dataverse can't remove do (`kept`): the publish is marked undone once the rest are back.
    const part: HistoryEntry = { ...e, items: mine.map(rebase), ...(fixed.size ? { kept: (e.kept ?? 0) + fixed.size } : {}) };
    const items = part.items.map((it): Item => ({ id: itemId(it), title: it.title, lcid: it.lcid, sub: PROP_NAMES[propOf(it.key)] || '', it, now: now.get(itemId(it)) }));
    // The undo's own journal entry (its Redo) names each label as this publish did, or as the Publish dialog would.
    const was = new Map(e.items.map((it) => [it.key, it] as const));
    const describe = (s: Slot) => ({ title: was.get(s.key)?.title ?? titleOf(app, s), where: was.get(s.key)?.where ?? whereOf(s) });
    // Try again undoes only the labels not back yet: sending the others again would only read each of them again (seconds
    // per table column) to find it already undone. The translations Dataverse can't remove are carried in `kept`, so the
    // publish is still marked undone once the rest are back.
    const go = (p: HistoryEntry, list: Item[]): void =>
      void run((o) => app.saver.undo(p, { ...o, publish: true, describe, anyway: ok.anyway }), list, (left, kept) =>
        go({ ...p, items: p.items.filter((it) => left.has(itemId(it))), kept: (p.kept ?? 0) + kept }, list.filter((it) => left.has(it.id))),
      );
    go(part, items);
  }

  /**
   * Publishes a past save whose publish failed or whose forms stayed unpublished ("Not published"): the same
   * targeted publish as the Publish dialog's Publish again, then its forms check. Its labels must be loaded (the
   * publish targets come from them): the page they are on, or the Workbench.
   */
  async function publishEntry(e: HistoryEntry): Promise<void> {
    const cs: Change[] = [];
    for (const it of e.items) {
      const slot = app.store.get(it.key);
      if (slot) cs.push({ slot, lcid: it.lcid, before: it.before, after: it.after });
    }
    if (cs.length < e.items.length) {
      app.toast("Some of these labels aren't loaded here. Open the page they are on (or load them in the Workbench), then publish again.", 'warn');
      return;
    }
    const later = () => app.toast('Publishing can start once the save running now has finished. Try again in a moment.', 'warn');
    if (app.store.busy) return later();
    if (asking) return;
    // Publishing publishes others' unpublished work on the same tables too: say so first, as the Publish dialog does,
    // also when it couldn't be checked; with nothing to say it publishes at once. This save left its own forms, views
    // and charts unpublished: they are not someone else's work (othersText `saved`).
    asking = true;
    busy(true);
    let others = '';
    try {
      others = await othersNote(app, cs, undefined, CHECK_MS, true);
    } finally {
      asking = false;
      busy(false);
    }
    // Said with the question; the Publish dialog of the save said it before it first published (or tried to).
    const scope = scopeText(app, cs);
    if (others) {
      const go = await modal<boolean>('Publish this save?', (close) =>
        frag(
          h('div', { class: 'dlg-body' }, h('p', null, `This publishes the ${plural(e.items.length, 'label')} saved ${when(e.at).replace(/\.$/, '')}.`), h('p', null, others), scope ? h('p', null, scope) : null),
          h('div', { class: 'dlg-actions' }, btn('Publish', () => close(true), 'primary'), btn('Cancel', () => close())),
        ),
      );
      if (!go) return;
      if (app.store.busy) return later();
    }
    busy(true);
    h3.textContent = 'Publishing';
    const ac = new AbortController();
    let t = new PublishSet();
    try {
      t = app.saver.publishTargets(cs);
      t.processes.clear(); // updated by the save that wrote their name, never here
    } catch {
      /* named generically */
    }
    const live = h('div', { class: 'vh', 'aria-live': 'polite' });
    const pub = step(t.empty ? 'Publishing' : `Publishing ${publishNames(app, cs, t)}`, live);
    const chk = step('Checking', live);
    const list = h('div', { class: 'pl pd-st' }, pub.el, chk.el);
    put(ui, h('div', { class: 'dlg-body' }, list, live), h('div', { class: 'dlg-actions' }));
    dlg.focus();
    pub.set('run');
    let err = '';
    let found: FormsCheck = { left: [], unread: [] };
    // Publishing holds the org's customization lock: no other save starts meanwhile.
    app.store.setBusy(true, 'Publishing');
    try {
      await publishAgain(app, cs, [e.id], ac.signal, (m) => pub.now(m));
      pub.set('ok');
      chk.set('run');
      found = await unpublishedForms(app, cs, ac.signal);
      // Still unpublished, or not known to be published: the entry stays "Not published", so this can be tried again later.
      const stays = found.left.length + found.unread.length > 0;
      if (stays) await markPublished(app.ctx, [e.id], false);
      chk.set(stays ? 'bad' : 'ok');
    } catch (x) {
      err = pubFail(x);
      pub.set('bad');
    } finally {
      app.store.setBusy(false);
      busy(false);
    }
    const { left, unread } = found;
    const ok = !err && !left.length && !unread.length;
    h3.textContent = ok ? 'Published' : err || left.length ? 'Not published yet' : 'Published, but not checked';
    const tryB = ok ? null : btn('Try again', () => void publishEntry(e), 'primary');
    const closeB = btn('Close', () => close(), ok ? 'primary' : '');
    const problem = err
      ? `Publishing failed: ${err}`
      : [left.length ? `${and(left)} still ${left.length === 1 ? 'has' : 'have'} unpublished changes.` : '', unread.length ? unreadText(unread, 'Try again to publish') : ''].filter(Boolean).join(' ');
    put(ui,
      h('div', { class: 'dlg-body' },
        list,
        ok ? h('p', { class: 'pd-done', role: 'status' }, 'Done. Refresh the page to see the changes.') : note('warn', problem, 'amb'),
      ),
      h('div', { class: 'dlg-actions' }, tryB, ok ? btn('Refresh page', () => void app.refreshPage()) : null, closeB),
    );
    (tryB || closeB).focus();
  }

  return { undoEntry, publishEntry };
}

/**
 * "Recent publishes": past publishes in this environment, each with Undo, and Publish for those not published yet. Each
 * opens in place to show what it changed, in the Publish dialog's rows.
 */
export function openHistory(app: AppApi): void {
  app.adoptStyles(CSS);
  const st = { busy: false };
  modal<void>('Recent publishes', (close, dlg) => {
    const ui = h('div', { class: 'rv' });
    const R = undoRunner(app, ui, dlg, close, (b) => (st.busy = b));
    let list: HistoryEntry[] = [];
    try {
      list = app.saver.history();
    } catch (e) {
      app.toast(`Couldn't read the publish history: ${errMsg(e)}`, 'error');
    }
    const kept = (e: HistoryEntry) => {
      if (!e.kept) return badge('Undone');
      const b = badge(`Undone · ${e.kept} kept`);
      // The names it gave sitemap items (namings) are kept too, which the undo never writes: not Dataverse's refusal.
      const nm = namings(e.items, app.ctx.base);
      const named = Math.min(nm.size, e.kept);
      const dv = e.kept - named;
      b.title = [
        // Translations with no stand-in, and base-language texts that can't be blank (refusedBlank): both stay as written.
        dv ? `${plural(dv, 'label')} this publish wrote stayed: Dataverse can't take ${dv === 1 ? 'it' : 'them'} back. Change ${dv === 1 ? 'it' : 'them'} in the editor if needed.` : '',
        named ? namingText(e.items.filter((it) => nm.has(itemId(it)))) : '',
      ].filter(Boolean).join(' ');
      return b;
    };
    /** What a publish changed: its labels as the Publish dialog showed them, each language's text before → after. */
    const details = (e: HistoryEntry): Node[] => {
      // A description the publish saved empty (model.ts savesEmpty) says so, in the Publish dialog's words; one that had no
      // translation at all before (`before` '' and not `empty`, HistoryItem.empty) never reads "(empty) → (empty)".
      const saidEmpty = (it: HistoryItem) => !it.after && it.lcid !== app.ctx.base && keepsEmpty({ kind: it.kind, prop: propOf(it.key) });
      const gs = entryGroups(e.items, ([it]) => ({
        lang: langName(app, it.lcid),
        before: it.before,
        after: it.after,
        ...(saidEmpty(it) ? { notes: [rowNote('note', savedEmptyText(it, langName(app, it.lcid)))], ...(!it.before && !it.empty ? { blankBefore: NO_TRANSLATION } : {}) } : {}),
      }));
      return [
        ...(e.undoneAt ? [h('p', { class: 'quiet' }, `Undone ${when(e.undoneAt)}.`)] : []),
        ...gs.slice(0, CAP).map((g) => changeGroup(g, 5)),
        ...(gs.length > CAP ? [h('p', { class: 'quiet' }, `and ${plural(gs.length - CAP, 'more label')}`)] : []),
      ];
    };
    // The details' ids are unique in the shadow root the other dialogs share.
    const uid = 'pd' + Math.random().toString(36).slice(2, 8);
    const row = (e: HistoryEntry, i: number) => {
      const at = when(e.at);
      const titles = [...new Set(e.items.map((x) => x.title))];
      // A publish that only named sitemap items has nothing Undo could write (namings): no Undo, a line says why.
      const fixed = namings(e.items, app.ctx.base);
      const only = fixed.size > 0 && e.items.every((it) => fixed.has(itemId(it)));
      const undo = only ? null : btn('Undo', () => void R.undoEntry(e), 'sm');
      if (undo) {
        undo.disabled = !!e.undoneAt || !e.items.length;
        undo.setAttribute('aria-label', `Undo the publish of ${at}`);
      }
      // Saved, but its publish failed (or its forms stayed unpublished): publish it from here.
      const pub = !e.undoneAt && !e.published && e.items.length ? btn('Publish', () => void R.publishEntry(e), 'sm') : null;
      if (pub) pub.setAttribute('aria-label', `Publish the ${plural(e.items.length, 'label')} saved ${at}`);
      const panel = h('div', { class: 'pd-hd', id: `${uid}-${i}`, role: 'region', 'aria-label': `What the publish of ${at} changed`, hidden: true });
      const open = h('button', { class: 'pd-ht', type: 'button', 'aria-expanded': 'false', 'aria-controls': panel.id },
        icon('right'),
        h('span', { class: 'hr-m' }, h('b', null, at), h('small', null, `${plural(e.items.length, 'label')} · ${titles.slice(0, 3).join(', ')}${titles.length > 3 ? ` +${titles.length - 3} more` : ''}`)),
      );
      open.addEventListener('click', () => {
        const on = open.getAttribute('aria-expanded') !== 'true';
        open.setAttribute('aria-expanded', String(on));
        // Built when first opened: a bulk import's publish holds thousands of labels.
        if (on && !panel.childNodes.length) put(panel, details(e));
        panel.hidden = !on;
      });
      return h('div', { class: 'pd-he' },
        h('div', { class: 'hr' }, h('h4', { class: 'pd-hh' }, open), e.undoneAt ? kept(e) : e.published ? null : badge('Not published', 'amb'), pub, undo),
        only && !e.undoneAt ? h('p', { class: 'pd-nu' }, namingText(e.items)) : null,
        panel,
      );
    };
    put(ui,
      h('div', { class: 'dlg-body' }, list.length ? list.map(row) : emptyState('history', 'No publishes yet', 'What you publish with the translator in this environment is listed here, so you can see it and undo it.')),
      h('div', { class: 'dlg-actions' }, btn('Close', () => close(), 'primary')),
    );
    return ui;
  }, { wide: true, canClose: () => !st.busy }).catch((e) => app.toast(errMsg(e), 'error'));
}
