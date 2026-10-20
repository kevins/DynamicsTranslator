// Sitemap area / group / subarea titles and descriptions (sitemapxml), plus the app → sitemap lookup.
//
// Sitemap labels are inline for every language (<Titles><Title LCID Title/></Titles>; verified live,
// LIVE-FINDINGS 13), unlike form tab labels. Each write is still read back, and a language Dataverse
// dropped is written once more while the user's UI language is that language (as form tabs need).
//
// Clearing a translation removes that language's <Title>/<Description> element (and the container once it
// is empty), so the item falls back to the base-language text.
//
// Nothing guards the unpublished sitemap against someone else's save between the writer's read and its PATCH:
// If-Match is checked against the published row. So the PATCH goes in one $batch between two reads of the unpublished
// sitemap (a $batch runs its parts in order): a save that landed since the writer's read shows in the first one, and
// their sitemap is written back with only these labels on it (providers/repair.ts). The batch is sent without
// continue-on-error, so a first read that fails stops it before the PATCH.

import type { Ctx } from '../core/context';
import { DvError, abortError, guid, isAbort, isGuid, mayHaveRun, partError, pause, q, turnedAway, type BatchPart, type PartResult } from '../core/http';
import { pick } from '../core/labels';
import { lcidName } from '../core/lcid';
import { MANAGED, baseNameFirst, isManaged, type Change, type ChangeResult, type Kind, type Lcid, type Prop, type Slot } from '../core/model';
import { assertOnlyChanged, blank, canon, kid, kids, parseXml, presentLabels, readLabels, removeLabel, serializeXml, upsertLabel } from '../core/xml';
import { Unsent, olderVersion, settle, type DocOps, type Sent } from './repair';
import { changeId, check, type Loader, type LoadOptions, type SaveOptions, type Writer } from './types';

const KINDS: Kind[] = ['area', 'group', 'subarea'];
const TAG: Partial<Record<Kind, string>> = { area: 'Area', group: 'Group', subarea: 'SubArea' };
const BOX: Partial<Record<string, string>> = { Title: 'Titles', Description: 'Descriptions' };
const SYS = "Microsoft's own text, already shown in every installed language. To use your own name, set a title in the app designer.";
const SYS_TIP = "Microsoft's own text, already shown in every installed language. To use your own, set a title in the app designer first.";
/** A placeholder's description: what it shows without a title of its own is not known, so it waits for one. */
const NAME_FIRST = 'Name this item first: its description can be translated here once it has a title.';
/** Read-only reasons the Workbench leaves out unless asked for read-only labels: nothing to translate here at all. */
const HIDDEN = new Set([SYS, SYS_TIP, NAME_FIRST, MANAGED]);
/**
 * The app designer's placeholders (`ResourceId="SitemapDesigner.NewGroup"` on an item never named; LIVE-FINDINGS 99):
 * "New Group" in English, "Nouveau groupe" in French. Unlike Microsoft's own labels (`Area_Sales`), nothing names the
 * item, so it can be named here.
 */
const DESIGNER = /^SitemapDesigner\./;
/** What a placeholder's title calls the item until it has a name. */
const NOUN: Partial<Record<Kind, string>> = { area: 'area', group: 'group', subarea: 'menu item' };
const DROPPED = 'Dataverse did not keep this label. Reload the sitemap to see what is saved.';
const KEPT = 'Dataverse did not remove this translation. Reload the sitemap to see what is saved.';
const GONE = 'This sitemap no longer exists. Reload to see the current app.';

/** App names by sitemap id, remembered by appSitemapId so loadSitemap can put the app in the path. */
const appNames = new Map<string, string>();

/** { lcid: text } of an element's Titles or Descriptions (item tag and text attribute share the prop's name). */
const labels = (el: Element, prop: Prop) => readLabels(el, BOX[prop]!, prop, 'LCID', prop);

/**
 * The sitemap record with its unpublished XML, so nobody's unpublished sitemap work is lost. Only loaders
 * may fall back to the published GET: writing that back would discard other makers' unpublished changes.
 */
async function read(ctx: Ctx, id: string, signal?: AbortSignal, published = false): Promise<any> {
  // Verified live: RetrieveUnpublished does not support sitemaps (0x80040800), but the collection-bound
  // RetrieveUnpublishedMultiple does. PATCH If-Match is checked against the published row, so its etag
  // comes from the plain GET.
  const [un, pub] = await Promise.all([
    ctx.http.get(unpub(id), { signal }).then(
      (r) => r?.value?.[0] ?? null,
      (e) => {
        if (!(e instanceof DvError) || published) return null;
        throw new DvError(`The latest (unpublished) version of this sitemap could not be read, so nothing was saved (${e.message}).`, e.status, e.code, e.url);
      },
    ),
    ctx.http.get(`sitemaps(${id})${un0}`, { signal }).catch((e) => {
      if (e instanceof DvError && e.status === 404) return null;
      throw e;
    }),
  ]);
  if (!un && !published) return pub ? Promise.reject(new DvError('The latest (unpublished) version of this sitemap could not be read, so nothing was saved.', 0)) : null;
  return un ? { ...un, '@odata.etag': pub?.['@odata.etag'] ?? un['@odata.etag'] } : pub;
}
const UNPUB = 'sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=';
// Both reads say whether the sitemap is from a managed solution (ismanaged; sitemaps have no iscustomizable column).
const un0 = '?$select=sitemapid,sitemapname,sitemapnameunique,sitemapxml,ismanaged';
/** The unpublished sitemap (one row); its versionnumber tells a read that lags from a newer save (providers/repair.ts). */
const unpub = (id: string) => `${UNPUB}sitemapid,sitemapname,sitemapnameunique,sitemapxml,versionnumber,ismanaged&$filter=sitemapid eq ${id}`;

function toSlots(ctx: Ctx, id: string, rec: any, app?: string): Slot[] {
  const out: Slot[] = [];
  if (!rec?.sitemapxml) return out;
  const doc = parseXml(rec.sitemapxml, 'sitemap');
  const root = app || rec.sitemapname || 'Sitemap';
  // A sitemap from a managed solution: every item read-only (a translation would be an unmanaged layer on it), naming
  // an app designer's placeholder too; Microsoft's own texts still say so, as before.
  const managed = rec.ismanaged === true;
  const seen = new Set<string>();
  const add = (kind: Kind, el: Element, path: string[], areaId?: string, groupId?: string): string => {
    const eid = el.getAttribute('Id') || '';
    const stored = labels(el, 'Title');
    // Whether the item shows its own titles depends on the elements being there; the slot then lists only
    // the non-empty ones (a title stored as '' counts as missing).
    const named = Object.keys(stored).length > 0;
    const titles = presentLabels(stored);
    // Without Titles the item shows a Microsoft resource string, the table's plural name or a legacy attribute.
    // (DescriptionResourceId alone means nothing: the app designer puts placeholder ids on every item.)
    const res = el.getAttribute('ResourceId') || '';
    const legacy = !named && el.hasAttribute('Title');
    // The app designer's placeholder for an item never named: a title of its own replaces it (in every language, once
    // the base language has one). One with a legacy Title attribute may show that instead.
    const placeholder = !named && !legacy && DESIGNER.test(res);
    // Microsoft's own label (`Area_Sales`): read-only. Never a designer's placeholder, which is no Microsoft text.
    const sys = !named && el.hasAttribute('ResourceId') && !DESIGNER.test(res);
    const entity = (kind === 'subarea' && el.getAttribute('Entity')) || '';
    // A subarea that shows its table's plural name: the page marks that name (inspector/scan.ts). Never one with a
    // legacy Title attribute, which may be what it shows.
    const plural = !named && !el.hasAttribute('ResourceId') && !legacy && !!entity;
    let comp = `${kind}|${id}|${eid}`;
    // The writer finds items by Id, so only the first of several items sharing an Id is editable.
    const dup = !eid || seen.has(comp);
    seen.add(comp);
    if (dup) comp += `|#${out.length}`;
    const title = pick(titles, ctx.user, ctx.base) || el.getAttribute('Title') || (placeholder ? `Unnamed ${NOUN[kind]}` : '') || entity || eid;
    for (const prop of ['Title', 'Description'] as const) {
      const t = prop === 'Title';
      out.push({
        key: `${comp}|${prop}`,
        kind,
        prop,
        entity: '',
        comp,
        group: `sitemap|${id}`,
        title,
        path,
        sub: eid,
        labels: t ? titles : presentLabels(labels(el, prop)),
        readOnly:
          managed && !(sys && !dup && (t || !kid(el, 'Descriptions')))
            ? MANAGED
            : dup
              ? 'This item has no unique Id in the sitemap, so it cannot be edited safely'
              : sys && (t || !kid(el, 'Descriptions'))
                ? t
                  ? SYS
                  : SYS_TIP
                : placeholder && !t && !kid(el, 'Descriptions')
                  ? NAME_FIRST
                  : t && legacy
                    ? 'Uses a single-language title attribute; set the title in the app designer first, then translate it here'
                    : t && plural
                      ? "Shows the table's plural name — translate the table instead"
                      : '',
        baseRequired: t,
        max: 0,
        order: out.length,
        ref: {
          sitemapId: id,
          id: eid,
          entity: entity || undefined,
          areaId,
          groupId,
          managed,
          plural: plural || undefined,
          // The page names an item without titles by its resource (scan.ts `unnamedItem`): its ResourceId's last segment.
          resource: res ? res.slice(res.lastIndexOf('.') + 1) : undefined,
          unnamed: !named || undefined,
          placeholder: placeholder || undefined,
        },
      });
    }
    return title;
  };
  for (const a of Array.from(doc.getElementsByTagName('Area'))) {
    const aid = a.getAttribute('Id') || '';
    const at = add('area', a, [root]);
    for (const g of kids(a, 'Group')) {
      const gt = add('group', g, [root, at], aid);
      for (const s of kids(g, 'SubArea')) add('subarea', s, [root, at, gt], aid, g.getAttribute('Id') || '');
    }
  }
  return out;
}

/** Sitemap id of an app: its sitemap component, else RetrieveAppComponents, else the sitemap named like the app. */
export async function appSitemapId(ctx: Ctx, appId: string, signal?: AbortSignal): Promise<string | null> {
  const id = guid(appId);
  // It goes into URL paths and a parameter alias: anything but a GUID (the page's address may hold anything) names no app.
  if (!isGuid(id)) return null;
  let err: unknown;
  const get = (url: string): Promise<any> =>
    ctx.http.get(url, { signal }).catch((e) => {
      if (isAbort(e)) throw e;
      err ??= e;
      return null;
    });
  const app = await get(`appmodules(${id})?$select=name,uniquename,appmoduleidunique`);
  let sm: any =
    app?.appmoduleidunique &&
    (await get(`appmodulecomponents?$select=objectid&$filter=componenttype eq 62 and _appmoduleidunique_value eq ${guid(app.appmoduleidunique)}`))?.value?.[0]?.objectid;
  if (!sm) {
    const r = await get(`RetrieveAppComponents(AppModuleId=@p)?@p=${id}`);
    for (const x of r?.AppComponents ?? r?.value ?? []) if ((sm = x?.sitemapid || (x?.componenttype === 62 && x.objectid))) break;
  }
  if (!sm && app?.uniquename) sm = (await get(`${UNPUB}sitemapid&$filter=sitemapnameunique eq '${q(app.uniquename)}'`))?.value?.[0]?.sitemapid;
  if (!sm) {
    if (err) throw err;
    return null;
  }
  sm = guid(sm);
  if (app?.name) appNames.set(sm, app.name);
  return sm;
}

export async function loadSitemap(ctx: Ctx, sitemapId: string, o: LoadOptions): Promise<Slot[]> {
  const id = guid(sitemapId);
  if (!isGuid(id)) throw new Error('This sitemap could not be read: its id is not valid.');
  o.progress('Loading sitemap');
  return toSlots(ctx, id, await read(ctx, id, o.signal, true), appNames.get(id));
}

/** Sitemaps of the apps in the solution (plus sitemaps added to it directly), or of every app. */
export const loadSitemapsScope: Loader = async (ctx, scope, o) => {
  if (!KINDS.some((k) => scope.kinds.has(k))) return [];
  const { http } = ctx;
  const signal = o.signal;
  o.progress('Finding app sitemaps');
  const [apps, links, sol] = await Promise.all([
    http.all('appmodules?$select=appmoduleid,appmoduleidunique,name,uniquename', { signal }),
    http.all('appmodulecomponents?$select=objectid,_appmoduleidunique_value&$filter=componenttype eq 62', { signal }),
    scope.solutionId
      ? http.all(`solutioncomponents?$select=objectid,componenttype&$filter=_solutionid_value eq ${guid(scope.solutionId)} and (componenttype eq 62 or componenttype eq 80)`, { signal })
      : null,
  ]);
  const solMaps = new Set<string>();
  const solApps = new Set<string>();
  for (const c of sol ?? []) (c.componenttype === 62 ? solMaps : solApps).add(guid(c.objectid));
  const inScope = (a: any) => !sol || solApps.has(guid(a.appmoduleid)) || solApps.has(guid(a.appmoduleidunique));
  const byUid = new Map<string, any>(apps.map((a) => [guid(a.appmoduleidunique), a]));
  // sitemap id -> app name ('' when the sitemap is not tied to a known app)
  const names = new Map<string, string>();
  const linked = new Set<any>();
  for (const l of links) {
    const a = byUid.get(guid(l._appmoduleidunique_value));
    const sm = guid(l.objectid);
    if (!a) continue;
    linked.add(a);
    if ((inScope(a) || solMaps.has(sm)) && !names.get(sm)) names.set(sm, a.name || '');
  }
  const unlinked = apps.filter((a) => inScope(a) && !linked.has(a) && a.uniquename);
  if (unlinked.length) {
    const maps = await http.all(`${UNPUB}sitemapid,sitemapnameunique`, { signal });
    for (const a of unlinked) {
      const m = maps.find((x) => x.sitemapnameunique === a.uniquename);
      if (m && !names.get(guid(m.sitemapid))) names.set(guid(m.sitemapid), a.name || '');
    }
  }
  for (const sm of solMaps) if (!names.has(sm)) names.set(sm, '');

  const ids = [...names.keys()];
  let done = 0;
  const settled = await Promise.allSettled(
    ids.map(async (id) => {
      const name = names.get(id) || appNames.get(id);
      if (name) appNames.set(id, name);
      const slots = toSlots(ctx, id, await read(ctx, id, signal, true), name);
      o.progress('Loading sitemaps', ++done, ids.length);
      return slots;
    }),
  );
  if (signal.aborted) throw abortError();
  const out: Slot[] = [];
  let failed: unknown;
  for (const s of settled) {
    if (s.status === 'fulfilled') out.push(...s.value);
    else failed ??= s.reason;
  }
  if (failed && !out.length) throw failed;
  if (failed) o.progress(`Some sitemaps could not be loaded: ${(failed as Error)?.message || failed}`);
  return out.filter((s) => scope.kinds.has(s.kind) && (scope.includeReadOnly || !HIDDEN.has(s.readOnly)));
};

const find = (doc: Document, c: Change): Element | undefined =>
  Array.from(doc.getElementsByTagName(TAG[c.slot.kind]!)).find((e) => e.getAttribute('Id') === c.slot.ref.id);
/** The language's text; missing and '' both read as ''. */
const value = (el: Element | undefined, c: Change): string => (el && labels(el, c.slot.prop)[c.lcid]) ?? '';
/** Whether the item has an entry for the language at all (an empty one included). */
const has = (el: Element, c: Change): boolean => c.lcid in labels(el, c.slot.prop);
/** A title or description saved empty (or as only spaces) is removed, so that language shows the base text. */
const removes = (c: Change): boolean => !c.after.trim();

/**
 * check() with blank values treated alike, so an entry stored as '' or as spaces is no conflict for a user who
 * saw no text (the store keeps '' for a cleared label). A change is 'unchanged' only when the item already
 * holds exactly what it asks for: for a removal, no entry in that language at all (an empty one is removed).
 * The result carries `c` itself: save() matches results to changes by identity.
 */
function compare(el: Element, c: Change, force: Set<string>): ChangeResult | null {
  const stored = labels(el, c.slot.prop)[c.lcid];
  const remove = removes(c);
  const r = check({ ...c, before: blank(c.before), after: remove ? '' : c.after }, blank(stored), force);
  if (r?.outcome === 'unchanged' && (remove ? stored !== undefined : stored !== c.after)) return null;
  return r && { ...r, change: c, ...(r.outcome === 'conflict' ? { server: stored ?? '' } : {}) };
}

const fail = (change: Change, message: string): ChangeResult => ({ change, outcome: 'error', message });
const elKey = (el: Element | null, s: string) => `${el?.tagName}|${el?.getAttribute('Id')}|${s}`;
const NO_ITEM = 'This item is no longer in the sitemap. Reload to see the current sitemap.';

function edit(doc: Document, el: Element, prop: Prop, lcid: Lcid, text: string): void {
  const box = BOX[prop]!;
  if (text.trim()) {
    // Titles must be the first child; Descriptions go before child groups, subareas and privileges.
    const before = prop === 'Title' ? undefined : (Array.from(el.children).find((x) => /^(Group|SubArea|Privilege)$/.test(x.tagName)) ?? null);
    return upsertLabel(doc, el, { container: box, item: prop, lcidAttr: 'LCID', textAttr: prop, lcid, text, insertBefore: before });
  }
  // Clearing a language removes its entry, so the item falls back to the base-language text. A container
  // left empty goes too, as if the language had never been added.
  removeLabel(el, { container: box, item: prop, lcidAttr: 'LCID', lcid });
  const b = kid(el, box);
  if (b && !b.children.length) el.removeChild(b);
}

/**
 * For canon(): the entries of `todo`'s item/property/language triples, plus an edited container that was empty
 * (`<Titles/>`). A container removed with its last entry compares equal on its own: canon() leaves out a container
 * whose children are all skipped. Every other entry counts, the same language on another item included.
 */
function ours(todo: Change[]): (x: Element) => boolean {
  const edited = new Set<string>();
  for (const c of todo) {
    const owner = `${TAG[c.slot.kind]}|${c.slot.ref.id}|`;
    edited.add(`${owner}${c.slot.prop}|${c.lcid}`).add(owner + BOX[c.slot.prop]);
  }
  return (x) => {
    const p = x.parentElement;
    return !!p && ((p.tagName === BOX[x.tagName] && edited.has(elKey(p.parentElement, `${x.tagName}|${x.getAttribute('LCID')}`))) || (!x.children.length && edited.has(elKey(p, x.tagName))));
  };
}

/** A sitemap as read: its XML (parsed once, never edited), the published etag a PATCH checks, and the unpublished versionnumber. */
interface MapDoc {
  xml: string;
  doc: Document;
  etag: string;
  ver?: unknown;
}
const mapOf = (xml: unknown, etag: string, ver?: unknown): MapDoc | null => {
  if (typeof xml !== 'string') return null;
  try {
    return { xml, doc: parseXml(xml, 'sitemap'), etag, ver };
  } catch {
    return null;
  }
};

/** `todo` written on `base`: a new sitemap, checked to differ from it in those entries only. */
function built(base: MapDoc, todo: Change[]): string {
  const doc = parseXml(base.xml, 'sitemap');
  for (const c of todo) {
    const el = find(doc, c);
    if (!el) throw new Error(NO_ITEM);
    edit(doc, el, c.slot.prop, c.lcid, c.after);
  }
  assertOnlyChanged(base.doc, doc, ours(todo));
  return serializeXml(doc);
}

/**
 * One write batch: the unpublished sitemap right before the PATCH (the probe: a $batch runs its parts in order), the
 * PATCH, the sitemap right after it. Sent `once` and without continue-on-error, so a probe Dataverse answered with an
 * error stops it before the PATCH (Unsent). Throws the PATCH's error.
 */
async function post(ctx: Ctx, id: string, xml: string, etag: string): Promise<Sent<MapDoc>> {
  const get: BatchPart = { method: 'GET', url: unpub(id) };
  // If-Match: * when there is no etag still stops a PATCH from creating a sitemap that was deleted meanwhile.
  const write: BatchPart = { method: 'PATCH', url: `sitemaps(${id})`, headers: { 'If-Match': etag || '*' }, body: { sitemapxml: xml } };
  const [now, pr, back] = await ctx.http.batch([get, write, get], { once: true, stop: true });
  if (!pr.ok) throw !pr.status && !now.ok && now.status ? new Unsent(partError(now)) : partError(pr);
  const row = (r: PartResult) => (r.ok ? mapOf(r.data?.value?.[0]?.sitemapxml, etag, r.data?.value?.[0]?.versionnumber) : null);
  return { probe: row(now), back: row(back) };
}

/** A sitemap's documents for settle(). */
function mapOps(ctx: Ctx, id: string): DocOps<MapDoc, string> {
  return {
    noun: 'sitemap',
    publish: true,
    gone: NO_ITEM,
    dropped: (c) => (removes(c) ? KEPT : DROPPED),
    async read() {
      const r = await read(ctx, id);
      const d = r && mapOf(r.sitemapxml, r['@odata.etag'] || '', r.versionnumber);
      if (!d) throw new Error(GONE);
      return d;
    },
    build: built,
    send: (xml, fresh) => post(ctx, id, xml, fresh.etag),
    same: (a, b) => a.xml === b.xml || canon(a.doc.documentElement, () => false) === canon(b.doc.documentElement, () => false),
    older: (a, b) => olderVersion(a.ver, b.ver),
    alike: (a, b, todo) => {
      const skip = ours(todo);
      return canon(a.doc.documentElement, skip) === canon(b.doc.documentElement, skip);
    },
    state: (d, c) => {
      const el = find(d.doc, c);
      return el ? JSON.stringify(labels(el, c.slot.prop)[c.lcid] ?? null) : null;
    },
    text: (d, c) => value(find(d.doc, c), c),
    // A removed translation must be gone, not merely blank.
    holds: (d, c) => {
      const el = find(d.doc, c);
      return removes(c) ? !!el && !has(el, c) : value(el, c) === c.after;
    },
  };
}

/**
 * One read → check → edit → PATCH → verify pass; a 412 (published meanwhile) redoes it once. A PATCH Dataverse turned
 * away unrun (throttled, the customization lock, or a probe that failed and stopped the batch) is never resent as built
 * (Http sends it `once`): the pass is done again from a new read after 2, 4 and 8 s, so a sitemap someone saved
 * meanwhile is kept. A probe showing someone else's save since the read: settle() puts it back. Adds the sitemap to the
 * publish set once a PATCH went through or may have (its answer lost; it carries everyone's unpublished sitemap work
 * anyway), and for a label already as asked: it may be an earlier write whose answer was lost, never published (the
 * published sitemap is not read as such for sure, LIVE-FINDINGS 13, so it is always published then).
 */
async function write(ctx: Ctx, id: string, changes: Change[], o: SaveOptions): Promise<ChangeResult[]> {
  const ops = mapOps(ctx, id);
  // Reads after a PATCH ignore the signal: once written, report what really is on the server.
  const reread = () => ops.read().catch(() => null);
  for (let stale = 0, waits = 0; ; ) {
    const rec = await read(ctx, id, o.signal);
    if (!rec) return changes.map((c) => fail(c, GONE));
    // From a managed solution as read right before the write (one that slipped through as editable): never written, so
    // no unmanaged layer is ever put on it, and no item of it is ever named.
    if (rec.ismanaged === true) return changes.map((c) => fail(c, MANAGED));
    const base: MapDoc = { xml: rec.sitemapxml || '', doc: parseXml(rec.sitemapxml || '', 'sitemap'), etag: rec['@odata.etag'] || '', ver: rec.versionnumber };
    const out: ChangeResult[] = [];
    let todo: Change[] = [];
    for (const c of changes) {
      const el = find(base.doc, c);
      let r: ChangeResult | null;
      if (!el) r = fail(c, NO_ITEM);
      else if (removes(c) && c.lcid === ctx.base && c.slot.prop === 'Title') r = fail(c, `The ${lcidName(ctx.base)} title can't be blank: it is the base language.`);
      // A removal aims for no entry, whatever spaces were typed.
      else r = compare(el, c, o.force);
      if (r) out.push(r);
      else todo.push(c);
    }
    // An item without any title gets its first ones only with the base language's among them: a title in another
    // language alone would leave the others on a text nobody chose (an app designer's placeholder, model.ts namesFirst).
    // By kind and Id, as find() looks items up: a subarea may share a group's Id.
    const item = (c: Change) => `${c.slot.kind}|${c.slot.ref.id}`;
    const named = new Set(todo.filter((c) => c.slot.prop === 'Title' && c.lcid === ctx.base && !removes(c)).map(item));
    const alone = (c: Change) => c.slot.prop === 'Title' && c.lcid !== ctx.base && !removes(c) && !named.has(item(c)) && !Object.keys(labels(find(base.doc, c)!, 'Title')).length;
    for (const c of todo.filter(alone)) out.push(fail(c, baseNameFirst(ctx.base)));
    todo = todo.filter((c) => !alone(c));
    if (out.some((r) => r.outcome === 'unchanged')) o.publish.sitemaps.add(id);
    if (!todo.length) return out;
    const xml = built(base, todo);
    // Cancel stops before the write; once sent, the write and its check always finish (an aborted request
    // may still be applied by the server).
    if (o.signal.aborted) throw abortError();
    let sent: Sent<MapDoc>;
    try {
      sent = await post(ctx, id, xml, base.etag);
    } catch (e) {
      if ((turnedAway(e) || e instanceof Unsent) && waits < 3) {
        // Nothing of this pass was written; Stop during the wait ends it there.
        if (await pause(2000 << waits++, o.signal).then(() => false, () => true)) return [...out, ...todo.map((c): ChangeResult => ({ change: c, outcome: 'skipped', message: 'Cancelled before saving.' }))];
        continue;
      }
      if (e instanceof Unsent) return [...out, ...todo.map((c) => fail(c, `The latest (unpublished) version of this sitemap could not be read right before saving, so nothing was saved (${e.message}).`))];
      if (!(e instanceof DvError && e.status === 412)) {
        // Its answer was lost, so it may have been written: published with the rest, so it shows once a Try again finds it there.
        if (mayHaveRun(e)) {
          o.publish.sitemaps.add(id);
          for (const c of todo) o.ran?.add(changeId(c));
        }
        return [...out, ...todo.map((c) => fail(c, (e as Error).message || 'Dataverse rejected the sitemap update.'))];
      }
      if (!stale++) continue;
      const now = await reread();
      return [
        ...out,
        ...todo.map((c): ChangeResult => ({ change: c, outcome: 'conflict', server: now ? value(find(now.doc, c), c) : '', message: 'Someone else saved this sitemap at the same time.' })),
      ];
    }
    o.publish.sitemaps.add(id);
    for (const c of todo) o.ran?.add(changeId(c));
    const fixed = await settle(ops, base, todo, sent);
    if (fixed) return [...out, ...fixed];
    const now = sent.back ?? (await reread());
    return [
      ...out,
      ...todo.map((c): ChangeResult => {
        if (!now) return fail(c, 'Sent to Dataverse, but the result could not be checked. Reload the sitemap to confirm it.');
        if (ops.holds(now, c)) return { change: c, outcome: 'saved' };
        if (!removes(c)) return fail(c, DROPPED);
        // A removed translation must be gone, not merely blank.
        return !find(now.doc, c) ? fail(c, 'This item is no longer in the sitemap after saving. Reload to see the current sitemap.') : fail(c, KEPT);
      }),
    ];
  }
}

export const sitemapWriter: Writer = {
  kinds: KINDS,
  lane: 'doc',
  async read(ctx, changes, o) {
    const rec = await read(ctx, changes[0].slot.ref.sitemapId, o.signal);
    if (!rec) throw new Error(GONE);
    const doc = parseXml(rec.sitemapxml || '', 'sitemap');
    return new Map(
      changes.map((c): [string, string | Error] => {
        const el = find(doc, c);
        return [changeId(c), el ? value(el, c) : new Error(NO_ITEM)];
      }),
    );
  },
  async save(ctx, changes, o) {
    const id: string = changes[0].slot.ref.sitemapId;
    const res = new Map<Change, ChangeResult>();
    // Loaded from a managed sitemap: refused before anything is read (write() checks again on its read).
    for (const c of changes) if (isManaged(c.slot)) res.set(c, fail(c, MANAGED));
    const asked = changes.filter((c) => !res.has(c));
    if (!asked.length) return changes.map((c) => res.get(c)!);
    o.progress(`Saving sitemap ${changes[0].slot.path[0] || ''}`.trim());
    for (const r of await write(ctx, id, asked, o)) res.set(r.change, r);
    const retry = (m?: string) => m === DROPPED || m === KEPT;
    const lost = changes.filter((c) => retry(res.get(c)?.message));
    for (const lcid of new Set(lost.map((c) => c.lcid))) {
      const again = lost.filter((c) => c.lcid === lcid);
      o.progress(`Saving sitemap labels in ${lcidName(lcid)}`);
      try {
        for (const r of await o.lang.run(lcid, () => write(ctx, id, again, o))) res.set(r.change, r);
      } catch (e) {
        // Keep the results of the first pass (labels already saved still get published and journaled).
        const stop = isAbort(e);
        for (const c of again)
          res.set(c, stop ? { change: c, outcome: 'skipped', message: 'Cancelled while saving. Reload to see whether this label was saved.' } : fail(c, (e as Error).message || res.get(c)?.message || DROPPED));
        if (stop) break;
      }
    }
    return changes.map((c) => res.get(c)!);
  },
};
