// Decides what the page the user is looking at shows and loads exactly those components into the
// store, several loads in parallel so the page fills in progressively. Each load is keyed and runs
// once per session (a failed one again on Try again); components another view already loaded are not read again.
// Everything the page shows is loaded up front, nothing waits for a click. A record form is always read in every
// language (tab and section labels through the automatic language switch, no prompt); a read that misses a
// language counts as failed (Try again reads it again). The form and the page's table go first, side by side
// (both languages, columns with their descriptions and choices): sub-grid tables, command bar labels, the
// business process flow and the app's navigation start once they are in. Grids show column names and choice
// values: the list's table and every sub-grid's table are loaded with their columns and choices, also when a
// sub-grid only shows up later (the scanner asks for its table).
//
// What a record page costs (two languages; timings from LIVE-FINDINGS 49 and 52). At once, 8 reads,
// exactly the read gate's 8 slots: the form in the user's language ($batch [probe, RetrieveUnpublishedMultiple]),
// the table's display name, and the table (entity with its columns, 5 choice reads). Once the form is read, its
// other language ($batch [switch, probe, read, switch back], on the write gate) and a read-back of the user's
// language. The form and the table are complete after ~0.6 s on a small form, ~3 s on a 340-cell one. Then ~3
// requests for the form name, 6 per sub-grid table, ~4 for the process, ~6 for the app and its navigation and
// 3–5 for the command bar: 30–40 in all, done about a second after the form.

import { pageInfo, type PageInfo } from '../core/context';
import { guid, isAbort } from '../core/http';
import { lcidName } from '../core/lcid';
import type { Kind, Slot } from '../core/model';
import { mergeStored } from '../providers/bpf';
import type { FormRef, LoadOptions, RibbonControl } from '../providers/types';
import type { AppApi } from '../ui/types';
import { navKnown } from './fallback';
import { queryLinks, queryTable, type Link } from './parts';
import type { PageGroup } from './types';

export interface Page {
  info: PageInfo;
  /** Identity of the page; a change means the user navigated. */
  sig: string;
  entity: string;
  /** Form of a record page, or the dashboard id ('' when unknown). */
  formId: string;
  /** System view of a list page ('' for personal views, which are not translatable). */
  viewId: string;
  /** Active business process flow of a record page. */
  bpfId: string;
}

/**
 * What the page shows of a table: its names, column names and tooltips, choice values. Never its relationships:
 * nothing in translation mode shows their labels (the scanner maps the Related menu to the form's navigation
 * items), and their three expansions (hundreds of relationships on a system table) would only slow down the
 * page table's read, which the popups wait for.
 */
const VALUES = new Set<Kind>(['entity', 'attribute', 'option', 'status', 'state', 'boolean', 'globaloption']);

/** Modern commands (appaction) use their name, "Label!<32 hex>", as the button id. */
export const isModern = (ctl: string): boolean => /![0-9a-f]{32}$/i.test(ctl);

/** Prefix of a table request in Scanner.want / request() ('#' is never part of a table's logical name). */
export const WANT_TABLE = '#table|';
/** A form the page shows besides its own, in a side pane: every label, every language (WANT_FORM + form id). */
export const WANT_FORM = '#form|';
/** A quick view's form: its field labels (WANT_QUICK + form id). */
export const WANT_QUICK = '#quick|';
/** The query of a grid's view, for its linked-table columns and the table it reads (WANT_VIEW + view id). */
export const WANT_VIEW = '#view|';
/** A view a view selector shows besides the list page's own, for its name (WANT_VIEW_NAME + view id). */
export const WANT_VIEW_NAME = '#viewname|';
/** A form the form selector's list shows besides the page's own, for its name (WANT_FORM_NAME + form id). */
export const WANT_FORM_NAME = '#formname|';
/** A table's relationships, for the related menu of its form (WANT_RELATED + table). */
export const WANT_RELATED = '#related|';
/**
 * A table's names only (display and plural name): a navigation entry shows its plural name, a built-in command's text can
 * hold either (WANT_NAMES + table).
 */
export const WANT_NAMES = '#names|';
const GUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

/** Form API control types that show a grid of another table (getControlType). */
export const isGridType = (t: string): boolean => /^(subgrid|editablegrid|customsubgrid)(:|$)/i.test(t);

/**
 * Global choice slots list the columns that use them (`ref.usedBy`), but one table load knows only its own
 * columns: a later load (a sub-grid's table) would drop the page table's columns from the list, and with them
 * the page's link from those columns to the choice. Keeps the union.
 */
export function mergeUsedBy(slots: Slot[], get: (key: string) => Slot | undefined): Slot[] {
  return slots.map((s) => {
    if (s.kind !== 'globaloption' && s.kind !== 'globaloptionset') return s;
    const old: unknown = get(s.key)?.ref?.usedBy;
    const now: unknown = s.ref?.usedBy;
    if (!Array.isArray(old) || !old.length || !Array.isArray(now)) return s;
    const all = [...new Set([...now, ...old])];
    return all.length === now.length ? s : { ...s, ref: { ...s.ref, usedBy: all } };
  });
}

/**
 * A load that got only part of what the page needs: its slots are kept, and it counts as failed (Try again). `quiet`:
 * what is missing isn't there to read (a table not in the org), so the bar says nothing.
 */
class Incomplete extends Error {
  constructor(
    readonly slots: Slot[],
    message: string,
    readonly quiet = false,
  ) {
    super(message);
  }
}

const tryGet = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn() ?? fallback;
  } catch {
    return fallback; // Xrm parts are missing while UCI navigates or on pages without a form
  }
};

/**
 * The form a record page shows: pageInfo's (the form selector, else the page context or the URL), except that a
 * user with a single form has no current item and sees that one whatever the URL names. '' when unknown.
 */
export function formOf(xrm: any, info: PageInfo): string {
  if (info.type !== 'entityrecord') return '';
  const ent = tryGet(() => String(xrm.Page.data.entity.getEntityName()), '');
  if (ent && ent !== info.entity) return ''; // Xrm.Page still holds the previous form
  if (ent && !tryGet(() => xrm.Page.ui.formSelector.getCurrentItem()?.getId(), '')) {
    // Only once the form API shows this table: while UCI navigates it can still list the previous table's single
    // form (the next poll picks the right one up).
    const one = tryGet(() => {
      const it = xrm.Page.ui.formSelector.items.get();
      return it.length === 1 ? String(it[0].getId()) : '';
    }, '');
    if (one) return guid(one);
  }
  return info.formId;
}

export class PageLoader {
  page: Page | null = null;
  appId = '';
  sitemapId = '';
  readonly forms = new Map<string, FormRef>();
  /** Groups of "All labels on this page" with loads running, with the number of loads. */
  readonly busy = new Map<PageGroup, number>();
  /** Failed loads: key -> friendly message. */
  readonly errors = new Map<string, string>();
  /** appaction.name (lower case) -> command comp. */
  readonly cmd = new Map<string, string>();
  /** Composed classic ribbon controls per table. */
  readonly ribbon = new Map<string, Map<string, RibbonControl>>();
  /** The linked tables of grid views by alias, per view id (an empty map: the view has none, or is gone). */
  readonly queries = new Map<string, Map<string, Link>>();
  /** The table each grid view's query reads ('' when it has none or is gone), per view id: an associated grid's table must be it (scan.ts gridTable). */
  readonly viewTables = new Map<string, string>();
  /**
   * The process the page showed until the user switched to another one on the same record, set by the sync() that
   * saw the switch (its name, stages and steps leave "All labels", inspector/mode.ts navigate); '' otherwise.
   */
  switchedFrom = '';
  private jobs = new Map<string, Promise<void>>();
  private running = new Set<string>();
  private asked = new Set<string>();
  private want = new Set<string>();
  /** Requests whose load failed; asked again only on retry() (never in a loop). */
  private failed = new Set<string>();
  private timer = 0;
  private ac = new AbortController();
  /**
   * Settles when the page's form and table loads have finished (they never reject). Every GET shares one
   * first-in-first-out gate (core/http), so sub-grid tables and command bar labels queued first would hold
   * the form labels back: those loads wait for this (see later()). Waiting for the whole form read also keeps
   * them out of its language switch window, where a read that names things in the caller's language (table
   * names of the command bar and of the form name load) would get the other language.
   */
  private head: Promise<unknown> = Promise.resolve();

  constructor(
    readonly app: AppApi,
    private readonly changed: () => void,
  ) {}

  /** Reads the page again. When it changed, starts loading what it shows and returns true. */
  sync(): boolean {
    const xrm = this.app.ctx.xrm;
    const info = pageInfo(xrm);
    const rec = info.type === 'entityrecord';
    if (rec) info.formId = formOf(xrm, info);
    const bpf = rec ? guid(tryGet(() => xrm.Page.data.process.getActiveProcess()?.getId(), '')) : '';
    const sig = [info.type, info.entity, info.recordId, info.formId, info.viewId, info.dashboardId].join('|');
    const p = this.page;
    this.switchedFrom = '';
    if (p && p.sig === sig) {
      if (p.bpfId !== bpf) {
        // The user switched process.
        this.switchedFrom = p.bpfId;
        p.bpfId = bpf;
        this.start();
      }
      return false;
    }
    this.page = {
      info,
      sig,
      entity: info.entity,
      formId: rec ? info.formId : info.type === 'dashboard' ? info.dashboardId : '',
      viewId: info.viewType === 'userquery' ? '' : info.viewId,
      bpfId: bpf,
    };
    this.start();
    return true;
  }

  /** Starts every load the page needs that has not run yet (failed loads run again). */
  start(): void {
    const p = this.page;
    if (!p) return;
    const { ctx, providers: pv } = this.app;
    const { entity: e, formId: id, info } = p;
    const rec = !!e && info.type === 'entityrecord';
    // The form chain and the page's table first, in that order: every GET shares one first-in-
    // first-out gate, so whatever is queued first is read first. A list page has neither, so its grid's table
    // loads right away.
    if (id && info.type === 'entityrecord') this.form(id, 'form');
    if (id && info.type === 'dashboard') this.form(id, 'dashboard');
    // The page table's columns and choices, unless a list of it read them already (or is reading them).
    if (rec && !this.jobs.has(`t:${e}`) && !this.jobs.has(`g:${e}`) && this.fresh(`state|${e}.`))
      this.run(`t:${e}`, ['Table and views', 'Choices'], 'the table and its columns', () => pv.loadTables(ctx, [e], VALUES, this.o()));
    this.head = Promise.all([rec ? this.jobs.get(`t:${e}`) : undefined, id ? this.jobs.get(`x:${id}`) : undefined]);
    // Then, behind them (later()): sub-grid tables, the list's view name, the process, the app and its navigation;
    // command bar labels as soon as the scanner sees the buttons. The form's related menu items in the store
    // (another view read the form, or this one before) ask for their relationships here: its read is skipped then,
    // and Try again asks again after a failed load.
    if (rec && id) this.navRelated(this.app.store.slots.values(), `navitem|${id}|`);
    if (rec) this.subgrids();
    else if (e && info.type === 'entitylist') this.tables([e]); // column headers and the choice values in rows
    if (p.viewId && info.type === 'entitylist') this.records('view', p.viewId, 'the view name');
    // The process: its name (the process header shows it) and its stages and steps, each a load of its own, so a
    // failed one says so and Try again reads it again. On a record, stages and steps loaded without the names
    // Dynamics keeps (process()) are read again: by another view, or by this one before (a new record, now saved).
    if (p.bpfId) this.records('bpf', p.bpfId, 'the process name');
    const record = rec ? info.recordId : '';
    const bk = `b:${p.bpfId}`;
    const unread = !!p.bpfId && !!record && this.unstored(p.bpfId, e);
    if (unread && !this.running.has(bk)) this.jobs.delete(bk);
    if (p.bpfId && (this.fresh(`stage|${p.bpfId}|`) || unread)) this.run(bk, ['Process'], 'the business process flow', this.later((since) => this.process(p.bpfId, e, record, since)));
    this.loadApp();
    this.changed();
  }

  /**
   * Requests what the page shows but the store lacks (Scanner.want): command bar buttons ('<table>|<control id>'),
   * tables of grids (WANT_TABLE + '<table>'), forms of side panes and quick views, grid views' queries and names, the
   * names of the forms in the form selector's list, a table's relationships and the names of tables the navigation shows
   * (WANT_NAMES). Each is asked for once; failed ones again after retry().
   */
  request(items: Iterable<string>): void {
    const tables: string[] = [];
    const views: string[] = [];
    const forms: string[] = [];
    const names: string[] = [];
    for (const w of items) {
      if (this.asked.has(w)) continue;
      this.asked.add(w);
      if (w.startsWith(WANT_TABLE)) tables.push(w.slice(WANT_TABLE.length));
      else if (w.startsWith(WANT_FORM_NAME)) forms.push(w);
      else if (w.startsWith(WANT_FORM)) this.shown(w.slice(WANT_FORM.length), true, w);
      else if (w.startsWith(WANT_QUICK)) this.shown(w.slice(WANT_QUICK.length), false, w);
      else if (w.startsWith(WANT_VIEW_NAME)) views.push(w);
      else if (w.startsWith(WANT_VIEW)) this.query(w.slice(WANT_VIEW.length), w);
      else if (w.startsWith(WANT_RELATED)) this.related(w.slice(WANT_RELATED.length), w);
      else if (w.startsWith(WANT_NAMES)) names.push(w.slice(WANT_NAMES.length));
      else this.want.add(w);
    }
    if (tables.length) {
      this.subgrids();
      this.tables(tables, true);
    }
    if (views.length) this.recordNames('view', WANT_VIEW_NAME, views);
    if (forms.length) this.recordNames('form', WANT_FORM_NAME, forms);
    if (names.length) this.names(names);
    if (this.want.size && !this.timer) this.timer = window.setTimeout(() => this.flushCommands(), 150);
  }

  /** Requests (Scanner.want) whose load failed: they are asked for again only after retry(). */
  get gaveUp(): ReadonlySet<string> {
    return this.failed;
  }

  /** "Try again": failed loads run again, failed command bar labels and grid tables are requested again. */
  retry(): void {
    for (const w of this.failed) this.asked.delete(w);
    this.failed.clear();
    this.errors.clear();
    this.start();
  }

  abort(): void {
    this.ac.abort();
    clearTimeout(this.timer);
  }

  private o(lang = false): LoadOptions {
    return { signal: this.ac.signal, progress: () => {}, lang: lang ? this.app.lang : undefined };
  }

  /** `fn`, run once the page's form and table loads are in (see head). */
  private later<T>(fn: (since: number) => Promise<T>): (since: number) => Promise<T> {
    return async (since) => {
      // One turn later: start() sets `head` only after starting the loads that may get here synchronously
      // (the form load asks for its sub-grids' tables). `head` never holds a load that waits for it.
      await Promise.resolve();
      await this.head;
      return fn(since);
    };
  }

  /**
   * True when nothing with this key prefix is in the store yet. With `complete`, labels loaded for the user's
   * language only (ref.partial) count as not loaded.
   */
  private fresh(prefix: string, complete = false): boolean {
    let hit = false;
    for (const s of this.app.store.slots.values())
      if (s.key.startsWith(prefix)) {
        if (!complete || s.ref?.partial) return complete;
        hit = true;
      }
    return !hit;
  }

  /**
   * `quiet`: a load the page can do without (a side pane's form, a view's linked columns): when it fails its labels
   * just stay unmarked, and the bar says nothing. `fn` gets the store's tick as the load started (Store.tick), for slots it
   * adds itself before it ends.
   */
  private run(key: string, groups: PageGroup[], what: string, fn: (since: number) => Promise<Slot[] | null>, items?: string[], quiet = false): void {
    if (this.jobs.has(key)) return;
    const bump = (d: number) => {
      for (const g of groups) {
        const n = (this.busy.get(g) || 0) + d;
        if (n > 0) this.busy.set(g, n);
        else this.busy.delete(g);
      }
    };
    bump(1);
    this.running.add(key);
    this.errors.delete(key);
    // As this load starts: a text the store gets meanwhile (the Workbench's extract, a save) is newer than what it reads,
    // which never replaces it, nor drops an edit typed over it (Store.add).
    const since = this.app.store.tick();
    this.jobs.set(
      key,
      (async () => {
        const keep = (slots: Slot[] | null) => {
          if (!slots?.length) return;
          const { store, ctx } = this.app;
          const get = (k: string) => store.get(k);
          store.add(mergeStored(ctx, mergeUsedBy(slots, get), get), since);
        };
        try {
          keep(await fn(since));
        } catch (e) {
          this.jobs.delete(key);
          items?.forEach((w) => this.failed.add(w));
          if (e instanceof Incomplete) keep(e.slots);
          if (!quiet && !(e instanceof Incomplete && e.quiet) && !isAbort(e) && !this.ac.signal.aborted) this.errors.set(key, e instanceof Incomplete ? e.message : `Could not load ${what}. ${(e as Error)?.message || e}`);
        } finally {
          this.running.delete(key);
          bump(-1);
          this.changed();
        }
      })(),
    );
    this.changed();
  }

  /**
   * A process's stages and steps; on a record (`record`, of the page's table `entity`), then the names Dynamics shows
   * for them from its own store in the languages the definition has none in (LIVE-FINDINGS 83, 85; providers/bpf.ts
   * loadBpfStored), read through the page's language switch. They go into the store once, with those names: added from
   * the definition first, a stage named in French only there showed as not translated, then turned blue. A language
   * that could not be read leaves its names out, and the load counts as failed
   * (Try again reads both again). Names an earlier read filled in stay meanwhile, and where this one misses them
   * (mergeStored, here and in run()).
   */
  private async process(id: string, entity: string, record: string, since: number): Promise<Slot[]> {
    const { ctx, providers: pv, store } = this.app;
    const slots = await pv.loadBpf(ctx, id, this.o());
    if (!record || !slots.length) return slots;
    // Added once, with the names Dynamics keeps (LIVE-FINDINGS 83, 85): added before that read, a stage whose French name
    // is only kept there was marked as not translated, then turned blue a moment later.
    const r = await pv.loadBpfStored(ctx, mergeStored(ctx, slots, (k) => store.get(k)), { entity, record, app: this.appId || this.page?.info.appId || '' }, this.o(true));
    if (r.missed.length) throw new Incomplete(r.slots, `Could not load the process's stage and step names in ${r.missed.map(lcidName).join(', ')}.`);
    return r.slots;
  }

  /**
   * The store has stages or steps of the process loaded without the names Dynamics keeps (no ref.stored, see
   * process()), or with some language of them not read (ref.unread). Only a process of the page's table `entity`:
   * on another table's record they are never read (loadBpfStored).
   */
  private unstored(id: string, entity: string): boolean {
    for (const s of this.app.store.slots.values())
      if (
        (s.kind === 'stage' || s.kind === 'step') &&
        s.ref?.workflowId === id &&
        String(s.ref.primary || '').toLowerCase() === entity.toLowerCase() &&
        (!Array.isArray(s.ref.stored) || Array.isArray(s.ref.unread))
      )
        return true;
    return false;
  }

  /** A record's names (form, dashboard, view, app, process), behind the page's form and table (see head). */
  private records(kind: Kind, id: string, what: string): void {
    const { ctx, providers: pv } = this.app;
    const group: PageGroup = kind === 'app' ? 'Navigation' : kind === 'bpf' ? 'Process' : 'Table and views';
    if (this.fresh(`${kind}|${id}|`)) this.run(`r:${kind}:${id}`, [group], what, this.later(() => pv.loadRecords(ctx, kind, [id], this.o())));
  }

  /**
   * The names of views shown in view selectors other than the list page's own (an associated grid's, a sub-grid's, a side
   * pane list's, the items of a list of views), and of the forms the form selector's list shows besides the page's own,
   * as the scanner asks for them (`prefix` + id): one read for those asked together. A personal view is no savedquery
   * and gets no slot: its name is the user's own, not a label. What the read doesn't find is never asked for again.
   */
  private recordNames(kind: 'view' | 'form', prefix: string, items: string[]): void {
    const ids = [...new Set(items.map((w) => guid(w.slice(prefix.length))))].filter((id) => GUID.test(id) && this.fresh(`${kind}|${id}|`) && !this.jobs.has(`r:${kind}:${id}`));
    if (!ids.length) return;
    const { ctx, providers: pv } = this.app;
    const what = `the ${kind} name${ids.length > 1 ? 's' : ''}`;
    // A single one takes the key of the page's own (records()): the two never read one record twice.
    this.run(`r:${kind}:${ids.join()}`, ['Table and views'], what, this.later(() => pv.loadRecords(ctx, kind, ids, this.o())), items);
  }

  /**
   * Loads the columns and choices of tables whose grids the page shows (the list, sub-grids), once each,
   * after the page's form and table (see head). `asked`: they came from request() (a failure lets retry()
   * ask again).
   */
  private tables(names: Iterable<string>, asked = false): void {
    const { ctx, providers: pv } = this.app;
    for (const raw of names) {
      const t = String(raw || '').toLowerCase();
      if (!/^[a-z0-9_]+$/.test(t)) continue;
      const k = `g:${t}`;
      if (this.jobs.has(k) || this.jobs.has(`t:${t}`)) continue;
      // Another view may have loaded it already (columns and choices). A table the scanner asked for lacks
      // something the page shows (e.g. the Workbench loaded its columns without choices): read once anyway.
      if (!asked && !this.fresh(`attribute|${t}.`) && !this.fresh(`state|${t}.`)) continue;
      this.run(k, ['Table and views', 'Choices'], `the columns of the ${t} table`, this.later(() => pv.loadTables(ctx, [t], VALUES, this.o())), asked ? [WANT_TABLE + t] : undefined);
    }
  }

  /**
   * Tables of the record form's sub-grids (form API), so their column headers and choice values can be
   * translated. Called again once a cold form API has been rebuilt (inspector/mode.ts wake).
   */
  subgrids(): void {
    if (this.page?.info.type !== 'entityrecord') return;
    const xrm = this.app.ctx.xrm;
    const names = new Set<string>();
    const all = tryGet<unknown>(() => xrm.Page.ui.controls.get(), []);
    for (const c of Array.isArray(all) ? all : []) {
      if (!isGridType(tryGet(() => String(c.getControlType() || ''), ''))) continue;
      const e = tryGet(() => String(c.getEntityName() || ''), '');
      if (e) names.add(e.toLowerCase());
    }
    if (names.size) this.tables(names);
  }

  private form(id: string, kind: 'form' | 'dashboard'): void {
    const { ctx, providers: pv } = this.app;
    // Every language, always: tab and section labels of the other languages are read while the user's
    // Dynamics language is switched for a moment (automatic, no prompt; cells come with every language anyway).
    const all = ctx.langs.length > 1;
    this.records(kind, id, kind === 'form' ? 'the form name' : 'the dashboard name');
    this.run(`x:${id}`, ['Form'], kind === 'form' ? 'the form labels' : 'the dashboard labels', async () => {
      // Already in the store in every language: no language switch again.
      if (!this.fresh(`${kind === 'form' ? '' : 'd'}tab|${id}|`, all)) return null;
      const { store } = this.app;
      // No lookup first: the read itself says the form's table, type and name. The page's table is
      // passed, so its display name (breadcrumbs) loads alongside the read.
      const ref = this.forms.get(id) ?? { formId: id, entity: kind === 'form' ? this.page?.entity || '' : '', type: NaN, name: '' };
      const read = await pv.loadFormXml(ctx, [ref], ctx.langs.map((l) => l.lcid), this.o(all));
      if (!read.length) throw new Error(`The ${kind} was not found, or you have no access to it.`);
      if (!this.forms.has(id)) this.forms.set(id, { formId: id, entity: read[0].entity || 'none', name: '', type: Number(read[0].ref?.formType) });
      // The form API knows its sub-grids by now (or again, after a cold boot).
      this.subgrids();
      this.navRelated(read, 'navitem|');
      // Loads can finish in any order: labels known in every language are never replaced by partial ones.
      const slots = read.filter((s) => {
        const o = store.get(s.key);
        return !s.ref?.partial || !o || o.ref?.partial;
      });
      this.quickViews(read);
      // A language that couldn't be read leaves labels known in some languages only: what was read is kept, and
      // the load counts as failed, so the bar says so and Try again reads the form again (never a click on a label).
      // Not for labels no read can complete (ref.unreadable: a form without an unpublished definition, whose cells
      // are known in the user's language only): their own looks and tooltips say why, and Try again couldn't help.
      if (all && slots.some((s) => s.ref?.partial && !s.ref.unreadable)) throw new Incomplete(slots, `Could not load the ${kind} labels in every language.`);
      return slots;
    });
  }

  /**
   * A related menu item of the form XML without a title in some language shows its relationship's text there
   * (LIVE-FINDINGS 80): the table's relationships load behind the page (related()), so its looks and placeholders
   * tell what shows. Only while the store can't tell that text (navKnown); `prefix` picks the form's items.
   */
  private navRelated(slots: Iterable<Slot>, prefix: string): void {
    const { store, ctx } = this.app;
    const get = (k: string) => store.get(k);
    for (const s of slots)
      if (s.key.startsWith(prefix) && !navKnown(get, s) && ctx.langs.some(({ lcid }) => !(s.labels[lcid] || '').trim())) {
        this.request([WANT_RELATED + (s.entity || this.page?.entity || '')]);
        return; // one form, one table
      }
  }

  /** The forms of a form's quick views, read right after it: their fields render with it. */
  private quickViews(slots: Slot[]): void {
    for (const s of slots) for (const id of Array.isArray(s.ref?.quickForms) ? s.ref.quickForms : []) this.shown(String(id), false);
  }

  /**
   * A form the page shows besides its own (LIVE-FINDINGS 56, 58), behind the page's form and table (see head), and
   * its table (columns, tooltips, choices). `full`: a side pane's form, which shows tabs and sections too, in every
   * language like the page's; else a quick view's, whose cells come in every language with one read (its tabs and
   * sections never show). A form that can't be read leaves its labels unmarked, without a message.
   */
  private shown(id: string, full: boolean, item?: string): void {
    const fid = guid(id);
    const key = `${full ? 'o' : 'q'}:${fid}`;
    if (!GUID.test(fid) || this.jobs.has(key) || this.jobs.has(`o:${fid}`)) return;
    const { ctx, providers: pv, store } = this.app;
    const all = full && ctx.langs.length > 1;
    const tableOf = (): string => {
      for (const s of store.slots.values()) if (s.ref?.formId === fid && s.entity) return s.entity;
      return '';
    };
    this.run(
      key,
      ['Form'],
      'the labels of a form on this page',
      this.later(async () => {
        // Already read (the page's own form in a side pane, a quick view shown twice): only its table may be missing.
        if (!this.fresh(`field|${fid}|`) && (!full || !this.fresh(`tab|${fid}|`, all))) {
          this.tables([tableOf()]);
          return null;
        }
        const read = await pv.loadFormXml(ctx, [{ formId: fid, entity: '', type: NaN, name: '' }], ctx.langs.map((l) => l.lcid), this.o(all));
        if (read[0]?.entity) this.tables([read[0].entity]);
        this.quickViews(read);
        // Labels known in every language are never replaced by partial ones (a quick view's read after a pane's).
        return read.filter((s) => {
          const o = store.get(s.key);
          return !s.ref?.partial || !o || o.ref?.partial;
        });
      }),
      item ? [item] : undefined,
      true,
    );
  }

  /**
   * The related menu of a table's form (LIVE-FINDINGS 63): the table's relationships, which name the items the form
   * XML doesn't list, and the plural names of the tables those items list. Only when the menu shows such an item.
   */
  private related(entity: string, item: string): void {
    const e = entity.toLowerCase();
    if (!/^[a-z0-9_]+$/.test(e)) return;
    const { ctx, providers: pv } = this.app;
    this.run(
      `rel:${e}`,
      ['Navigation'],
      'the related menu',
      this.later(async () => {
        const rels = await pv.loadTables(ctx, [e], new Set<Kind>(['relationship']), this.o());
        const listed = new Set<string>();
        for (const s of rels) {
          const r = s.ref || {};
          if (r.menu !== 'plural') continue;
          if (r.type === 'OneToMany' && String(r.referenced).toLowerCase() === e) listed.add(String(r.referencing).toLowerCase());
          if (r.type === 'ManyToMany') for (const t of [r.entity1, r.entity2]) listed.add(String(t).toLowerCase());
        }
        // Their plural names (another slot of the table, a Description the Workbench left, doesn't hold them).
        const names = [...listed].filter((t) => t && this.fresh(`entity|${t}|DisplayCollectionName`));
        return [...rels, ...(names.length ? await pv.loadTables(ctx, names, new Set<Kind>(['entity']), this.o()) : [])];
      }),
      [item],
      true,
    );
  }

  /**
   * The names of tables the page shows by name: the app's navigation by their plural name (a subarea without titles of
   * its own), a built-in command in its text ("New Person"). Behind the page's form and table: one read for the tables
   * asked together, nothing else of them. A failed read is in the bar with Try again, and its entries and buttons are
   * grey meanwhile (inspector/scan.ts); a table not in the org only gives up.
   */
  private names(list: string[]): void {
    const plural = (t: string) => this.fresh(`entity|${t}|DisplayCollectionName`);
    const ts = [...new Set(list.map((t) => t.toLowerCase()))].filter((t) => /^[a-z0-9_]+$/.test(t) && plural(t));
    if (!ts.length) return;
    const { ctx, providers: pv } = this.app;
    this.run(
      `n:${ts.join()}`,
      ['Navigation', 'Command bar'],
      'the names of tables on this page',
      this.later(async () => {
        // A table load already running (the page's, a grid's) reads them too: only what it leaves out is read.
        await Promise.all(ts.map((t) => this.jobs.get(`t:${t}`) ?? this.jobs.get(`g:${t}`)));
        const left = ts.filter(plural);
        const read = left.length ? await pv.loadTables(ctx, left, new Set<Kind>(['entity']), this.o()) : [];
        // A table that isn't in the org reads as nothing: its entries say why, as after a failed read, and Try again
        // can't change that.
        const got = new Set(read.map((s) => s.entity));
        if (left.some((t) => !got.has(t))) throw new Incomplete(read, 'Some tables on this page were not found.', true);
        return read;
      }),
      list.filter((t) => ts.includes(t.toLowerCase())).map((t) => WANT_NAMES + t),
    );
  }

  /** The table a grid's view reads and its linked tables (its query's link-entities), once per view. */
  private query(id: string, item: string): void {
    const vid = guid(id);
    if (!GUID.test(vid)) return;
    const { ctx, providers: pv } = this.app;
    this.run(
      `v:${vid}`,
      [],
      'the columns of a view',
      this.later(async () => {
        const fx = await pv.viewQuery(ctx, vid, this.ac.signal);
        this.viewTables.set(vid, queryTable(fx));
        this.queries.set(vid, queryLinks(fx));
        return null;
      }),
      [item],
      true,
    );
  }

  private loadApp(): void {
    if (this.appId) return this.appParts();
    this.run('app', [], 'the app', async () => {
      const xrm = this.app.ctx.xrm;
      const props: any = await Promise.resolve(tryGet(() => xrm.Utility.getGlobalContext().getCurrentAppProperties(), null)).catch(() => null);
      this.appId = guid(props?.appId) || this.page?.info.appId || '';
      this.appParts();
      return null;
    });
  }

  private appParts(): void {
    const id = this.appId;
    if (!id) return;
    const { ctx, providers: pv } = this.app;
    this.records('app', id, 'the app name');
    this.run(
      `sm:${id}`,
      ['Navigation'],
      'the app navigation',
      this.later(async () => {
        const sm = (this.sitemapId = (await pv.appSitemapId(ctx, id, this.ac.signal)) || '');
        return sm && this.fresh(`area|${sm}|`) ? pv.loadSitemap(ctx, sm, this.o()) : null;
      }),
    );
  }

  private flushCommands(): void {
    this.timer = 0;
    const { ctx, providers: pv } = this.app;
    const modern: string[] = [];
    const mw: string[] = [];
    const tables = new Map<string, string[]>();
    for (const w of this.want) {
      const i = w.indexOf('|');
      const ctl = w.slice(i + 1);
      if (isModern(ctl)) modern.push(ctl), mw.push(w);
      else {
        const t = w.slice(0, i);
        tables.set(t, [...(tables.get(t) || []), w]);
      }
    }
    this.want.clear();
    if (modern.length)
      this.run(
        `m:${modern.join()}`,
        ['Command bar'],
        'the command bar labels',
        this.later(async () => {
          const found = await pv.findCommands(ctx, modern, this.appId, this.page?.entity || '', this.ac.signal);
          const slots = found.length ? await pv.loadRecords(ctx, 'command', found.map((c) => guid(c.id)), this.o()) : null;
          // Mapped only once their labels are in, so a failed load can be asked for again.
          for (const c of found) this.cmd.set(c.name.toLowerCase(), `command|${guid(c.id)}`);
          return slots;
        }),
        mw,
      );
    // Classic buttons: the composed ribbon maps a control to its $LocLabels token; labels defined on the
    // application ribbon apply to every table.
    if (tables.size) this.run('rb:_app', [], 'the command bar labels', this.later(() => pv.loadRibbonLabels(ctx, ['_app'], this.o())), [...tables.values()].flat());
    for (const [t, ws] of tables)
      this.run(
        `rb:${t}`,
        ['Command bar'],
        'the command bar labels',
        this.later(async () => {
          const [ctl, labels] = await Promise.all([pv.ribbonControls(ctx, t, this.ac.signal), pv.loadRibbonLabels(ctx, [t], this.o())]);
          this.ribbon.set(t, ctl);
          return labels;
        }),
        ws,
      );
  }
}
