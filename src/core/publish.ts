// Targeted publishing. Never PublishAllXml: that would publish every maker's unpublished work in
// the org. One PublishXml call carries everything a save touched. Business process flows are never
// published: one whose name was saved is updated instead (rebuildProcess).

import type { Ctx } from './context';
import { DvError, abortError, guid, partError, pause, turnedAway, type BatchPart, type PartResult } from './http';
import { toLabels } from './labels';
import type { LangSession } from './langsession';
import { lcidName } from './lcid';
import { MANAGED, PublishSet, isManaged, type Change, type Labels, type Lcid } from './model';
import { xmlAttr } from './xml';

/**
 * Dataverse runs one customization operation at a time; others fail with 0x80071151 "Cannot start
 * another [X]" / "…because there is another [Import] running". A bare "another" would also match
 * unrelated errors and turn them into pointless retries and a misleading "busy" message.
 */
export const isLockError = (e: unknown): boolean =>
  e instanceof DvError && (e.status === 429 || /Cannot start|0x80071151|CustomizationLock|another \[/i.test(`${e.message} ${e.code}`));

/**
 * Thrown when everything was published except the apps (the server rejected <appmodules>), so callers
 * can say "published, except…" instead of "publishing failed".
 */
export class PartialPublishError extends Error {}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const stop = () => (clearTimeout(t), reject(abortError()));
    const t = setTimeout(() => (signal?.removeEventListener('abort', stop), resolve()), ms);
    signal?.addEventListener('abort', stop, { once: true });
  });

const list = (box: string, tag: string, items: Iterable<string>, fmt: (s: string) => string): string => {
  const inner = [...items].map((i) => `<${tag}>${fmt(i)}</${tag}>`).join('');
  return inner ? `<${box}>${inner}</${box}>` : '';
};
const braced = (id: string) => `{${guid(id)}}`;

/** ParameterXml in schema order; '' when there is nothing to publish. */
function parameterXml(set: PublishSet, apps: boolean): string {
  const ents = [...set.entities].filter((e) => e && e !== 'none' && e !== '_app');
  const body =
    list('entities', 'entity', ents, xmlAttr) +
    (set.ribbons || set.entities.has('_app') ? '<ribbons><ribbon></ribbon></ribbons>' : '') +
    list('dashboards', 'dashboard', set.dashboards, braced) +
    list('optionsets', 'optionset', set.optionsets, xmlAttr) +
    list('sitemaps', 'sitemap', set.sitemaps, braced) +
    (apps ? list('appmodules', 'appmodule', set.appmodules, braced) : '');
  return body && `<importexportxml>${body}</importexportxml>`;
}

/**
 * Publishes the set with one PublishXml call. Customization-lock errors are retried after 5, 10, 20
 * and 40 s; when the server rejects the <appmodules> element it is retried once without it.
 * The signal is checked before each attempt and during waits, but an attempt already sent is not
 * aborted, so the caller learns whether it really finished. When the rest was published without the
 * apps, it still throws, so apps are never reported as published when they were not.
 */
export async function publishXml(ctx: Ctx, set: PublishSet, signal?: AbortSignal, onRetry?: (msg: string) => void): Promise<void> {
  let apps = set.appmodules.size > 0;
  let rejected = '';
  for (let waits = 0; ; ) {
    const xml = parameterXml(set, apps);
    if (!xml) return;
    if (signal?.aborted) throw abortError();
    try {
      await ctx.http.post('PublishXml', { ParameterXml: xml });
    } catch (e) {
      if (isLockError(e) && waits < 4) {
        const s = 5 * 2 ** waits++;
        onRetry?.(`Dataverse is busy with another customization. Publishing again in ${s} seconds…`);
        await sleep(s * 1000, signal);
        continue;
      }
      // <appmodules> is not in the published schema; a server that rejects it answers 400/500. Never
      // retry a network failure or a gateway timeout: the publish may still be running on the server.
      if (apps && e instanceof DvError && (e.status === 400 || e.status === 500) && !isLockError(e) && parameterXml(set, false)) {
        apps = false;
        rejected = e.message.slice(0, 200);
        onRetry?.('Apps could not be published with the rest; publishing the other components.');
        continue;
      }
      throw e;
    }
    if (rejected)
      throw new PartialPublishError(`Everything except the app was published (Dataverse answered: ${rejected}). Publish the app in Power Apps to show its new labels.`);
    return;
  }
}

/**
 * Updates a business process flow so the app shows the name just saved (LIVE-FINDINGS 83). SetLocLabels changes what
 * the Web API returns at once, but Dataverse keeps serving the app a compiled copy of the process, with the old name,
 * through every client cache clear. A PATCH of the workflow's `name` rebuilds it, and writes the label of the caller's
 * UI language: so it is sent while the UI language is the base language (LangSession.run, which does not switch when
 * it already is), with the base-language name read right before it, and no label changes. The PATCH goes in one $batch
 * between two reads of the name (a $batch runs its parts in order): a base-language name someone else saved after that
 * read is in the first one, and the PATCH replaced it, so theirs is put back the same way, in the same window (never
 * over a name saved after the PATCH) and checked. Sent once, never again (its put-back again only while Dataverse turns
 * it away); nothing is sent when that name can't be read. `olds`: the base-language names this save's own write replaced.
 * A read showing one lags behind that write (LIVE-FINDINGS 66): it is read again after 1, 2, 4 and 8 s before the window
 * (which switches the user's UI language), and nothing is sent while it still shows one (the PATCH would put the old
 * name back); a batch read showing one is nobody's save, never put back. Resolves with what the saver says ('' when all
 * is well): that race, or the languages whose name the read after it shows changed from both reads before it (none,
 * unless Dataverse wrote another one). A process from a managed solution, or one not read as unmanaged right before, is
 * never updated (it rejects): that PATCH would be an unmanaged layer on it. run() needs the exclusive switch window: never
 * call this from a quiet() job (the save lanes), it would wait for itself.
 */
export async function rebuildProcess(ctx: Ctx, lang: Pick<LangSession, 'run'>, id: string, title: string, signal?: AbortSignal, olds: readonly string[] = []): Promise<string> {
  const wf = guid(id);
  const get: BatchPart = {
    method: 'GET',
    url: ctx.http.fn('RetrieveLocLabels', { EntityMoniker: { '@odata.id': `workflows(${wf})` }, AttributeName: 'name', IncludeUnpublished: true }),
    headers: { Consistency: 'Strong' },
  };
  const read = async (s?: AbortSignal): Promise<Labels> => toLabels((await ctx.http.get(get.url, { signal: s, headers: get.headers }))?.Label);
  const labels = (r: PartResult): Labels | null => (r.ok ? toLabels(r.data?.Label) : null);
  /** [the name right before, PATCH, the name right after], without continue-on-error: a probe that fails stops it unsent ('unrun'). */
  const send = async (name: string): Promise<{ probe: Labels | null; back: Labels | null }> => {
    // Not abortable, and never sent again by Http (`once`): it carries the name as just read.
    const [p, w, b] = await ctx.http.batch([get, { method: 'PATCH', url: `workflows(${wf})`, body: { name } }, get], { once: true, stop: true });
    if (!w.ok) throw !w.status && !p.ok && p.status ? new DvError(partError(p).message, p.status, 'unrun') : partError(w);
    return { probe: labels(p), back: labels(b) };
  };
  const moved = (a: Labels, b: Labels): Lcid[] => [...new Set([...Object.keys(a), ...Object.keys(b)].map(Number))].filter((l) => (b[l] ?? '') !== (a[l] ?? ''));
  const behind = (t: string | undefined): boolean => t !== undefined && olds.includes(t);
  const late = () => new DvError(`Dataverse doesn't show the new ${lcidName(ctx.base)} name of the process yet.`, 0, 'behind');
  if (signal?.aborted) throw abortError();
  // Never a process from a managed solution: the PATCH would put an unmanaged layer on it. A process not read as
  // unmanaged is not updated (the read's failure is the saver's "may show the old name").
  const managed = (await ctx.http.get(`workflows(${wf})?$select=ismanaged`, { signal, headers: { Consistency: 'Strong' } }))?.ismanaged;
  if (managed === true) throw new DvError(`The process ${title} was not updated. ${MANAGED}`, 0, 'managed');
  if (managed !== false) throw new DvError(`The process ${title} was not updated: Dataverse did not say whether it is from a managed solution.`, 0, 'unread');
  if (olds.length)
    for (let i = 0; behind((await read(signal))[ctx.base]); i++) {
      if (i === 4) throw late();
      await pause(1000 << i, signal);
    }
  return lang.run(ctx.base, async () => {
    const before = await read(signal);
    const name = before[ctx.base];
    if (behind(name)) throw late();
    if (!name?.trim()) throw new DvError(`The process has no ${lcidName(ctx.base)} name to send.`, 0, 'noname');
    if (signal?.aborted) throw abortError();
    const s = await send(name);
    const theirs = behind(s.probe?.[ctx.base]) ? '' : (s.probe?.[ctx.base] ?? '');
    let raced = '';
    let end = s.back ?? (await read().catch(() => null));
    if (theirs.trim() && theirs !== name) {
      const base = lcidName(ctx.base);
      const lost = `Updating the process ${title} replaced its ${base} name “${theirs}”, which someone else saved at that moment, with “${name}”`;
      for (let i = 0; !raced; i++) {
        // Theirs goes back only over this update's name: one saved after it is newer still, and stays.
        const now = i ? (await read().catch(() => null))?.[ctx.base] : end?.[ctx.base];
        if (now !== undefined && !behind(now) && now !== name) {
          raced = now === theirs ? `${lost}; it reads “${theirs}” again. Check it.` : `${lost}; it now reads “${now}”, so it was left as it is. Check it.`;
          break;
        }
        try {
          const r = await send(theirs);
          end = r.back ?? (await read().catch(() => null));
          const z = r.probe?.[ctx.base];
          const third = z !== undefined && z !== name && z !== theirs && !behind(z) ? `, but putting it back replaced “${z}”, which someone else saved right then` : '';
          raced =
            end?.[ctx.base] === theirs
              ? `${lost}; theirs is back${third}. Check it.`
              : `${lost}; putting theirs back could not be confirmed${end ? ` (it reads “${end[ctx.base] ?? ''}”)` : ''}. Check its ${base} name.`;
        } catch (e) {
          // Turned away, or its first read failed on the server's side: nothing was written, so again from a new read.
          if ((turnedAway(e) || (e instanceof DvError && e.code === 'unrun' && (e.status >= 500 || !e.status))) && i < 2) {
            await pause(2000 << i);
            continue;
          }
          raced = `${lost}, and putting theirs back failed (${((e as Error)?.message || String(e)).trim().replace(/[.!?]+$/, '')}). Check its ${base} name.`;
        }
      }
    }
    // Measured from both reads before the PATCH: a name someone else saved before it (the batch's read shows it) is not
    // Dataverse's doing, nor this save's own name in a batch read behind it.
    const changed = end ? moved(before, end).filter((l) => (!s.probe || (end[l] ?? '') !== (s.probe[l] ?? '')) && !(raced && l === ctx.base)) : [];
    const other = changed.length ? `Updating the process ${title} also changed its ${changed.map(lcidName).join(' and ')} name in Dataverse. Check it and save it again.` : '';
    return [raced, other].filter(Boolean).join(' ');
  });
}

/** Predicts what a save of these changes will publish (for the review dialog and the pending-work check). */
export function publishTargets(changes: Change[]): PublishSet {
  const p = new PublishSet();
  const add = (set: Set<string>, v: unknown, id = false) => {
    if (v && v !== 'none') set.add(id ? guid(v) : String(v));
  };
  for (const { slot: s } of changes) {
    if (s.readOnly || isManaged(s)) continue; // never saved, so never published
    const r = s.ref || {};
    switch (s.kind) {
      case 'globaloptionset':
      case 'globaloption':
        add(p.optionsets, r.name);
        break;
      case 'dashboard':
        add(p.dashboards, r.id, true);
        break;
      case 'dtab':
      case 'dsection':
      case 'dfield':
        add(p.dashboards, r.formId, true);
        break;
      case 'app':
        add(p.appmodules, r.id, true);
        break;
      case 'area':
      case 'group':
      case 'subarea':
        add(p.sitemaps, r.sitemapId, true);
        break;
      case 'relationship':
        for (const e of [r.referenced, r.referencing, r.entity1, r.entity2, s.entity]) add(p.entities, e);
        break;
      case 'ribbon':
        if (r.entity === '_app') p.ribbons = true;
        else add(p.entities, r.entity || s.entity);
        break;
      case 'bpf':
        // Not published either, but a new process name shows only once the process is updated (rebuildProcess).
        // Its description is not shown on the page; stage and step labels show after a reload (LIVE-FINDINGS 83).
        if (s.prop === 'Name' && r.id) p.processes.set(guid(r.id), s.title);
        break;
      // Workflow names, BPF labels, command labels (live immediately, verified), environment variables and
      // custom APIs need no publish.
      case 'command':
      case 'stage':
      case 'step':
      case 'envvar':
      case 'customapi':
        break;
      default:
        add(p.entities, s.entity || r.entity);
    }
  }
  return p;
}
