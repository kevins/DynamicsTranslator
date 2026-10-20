// Save orchestration: stand-ins for emptied translations Dataverse can't remove (model.ts standIn) → validate →
// write each group through its provider, scheduled by lane (a stand-in made of a text another group writes: once that
// is saved) → check the UI language is back → commit to the store → undo journal → one targeted publish, once every
// write has finished (LIVE-FINDINGS 48: a write during PublishXml slows it down 5× and gets published half-way)
// → an update of each business process flow whose name was written (LIVE-FINDINGS 83).

import { changeId, check as compare, type Lane, type SaveOptions, type ServerTexts, type Writer } from '../providers/types';
import type { HistoryEntry, HistoryItem, Issue, PendingWork, Prepared, PrepareOptions, SaveReport, SaveRunOptions, SaverApi } from '../ui/types';
import type { Ctx } from './context';
import { addHistory, markPublished, markUndone, readHistory } from './history';
import { DvError, guid, isAbort, q } from './http';
import { WAITING, type LangSession } from './langsession';
import { lcidName } from './lcid';
import { baseNameFirst, canClear, isManaged, keepsEmpty, MANAGED, namesFirst, noStandIn, PublishSet, refusedBlank, savesEmpty, sourceMoved, sourceUnread, sourceUnsaved, standIn, standInSources, storedEmpty, type Change, type ChangeResult, type Kind, type Lcid, type Outcome, type Prop, type Slot, type TextOf } from './model';
import { isLockError, PartialPublishError, publishTargets, publishXml, rebuildProcess } from './publish';
import type { Store } from './store';

/** What a run is for: saving pending edits, or undoing a past save (some messages are worded for it). */
type Purpose = 'save' | 'undo';

const CANCELLED = 'Cancelled before saving';
/** Form/dashboard tab and section labels: written while the UI language is theirs (see formxml.ts). */
const SWITCHES = /^d?(tab|section)$/;
/** Metadata kinds written with UpdateOptionValue / UpdateStateValue (only the changed languages are sent). */
const OPTIONS = /^(option|status|state|boolean|globaloption)$/;
const placeholders = (t: string) => (t.match(/\{\d+\}/g) || []).length;
const safe = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    console.error('[translator]', e);
  }
};
/** How the journal names a label (SaveRunOptions.describe); one that throws never costs the journal entry. */
const named = (s: Slot, o: SaveRunOptions): { title: string; where: string } => {
  try {
    if (o.describe) return o.describe(s);
  } catch (e) {
    console.error('[translator]', e);
  }
  return { title: s.title, where: '' };
};

/**
 * Why only spaces can't be saved where a translation Dataverse can't remove does not exist yet: they would be
 * stored and shown as a blank label instead of the base text (finding 32). Also the grid's hint for such a cell.
 */
export const onlySpaces = (lcid: Lcid, base: Lcid): string =>
  `Only spaces: ${lcidName(lcid)} users would see a blank label instead of the ${lcidName(base)} text. Type the text, or undo this edit.`;

/** Only spaces counts as no text, as the writers compare texts. */
const bare = (t: string): string => (t.trim() ? t : '');

/**
 * The texts a save or an undo measures stand-ins by (model.ts standIn): each label's text as the run leaves it on the
 * server, the changes it writes (`sent`: an undo's are the entry's own earlier texts) first, else the server's as last
 * read (`now`, by change id: the Undo question's reads) or loaded. Never a pending edit the run doesn't write, nor one
 * it holds back: the stand-in is what the page shows once the run is over.
 */
export const saveText = (store: Pick<Store, 'text'>, sent: readonly Change[], now?: ServerTexts): TextOf => {
  const next = new Map(sent.map((c) => [changeId(c), c.after] as const));
  return (k, l) => {
    const id = `${k}#${l}`;
    const read = now?.get(id);
    const loaded = store.text(k, l, true);
    return next.get(id) ?? (typeof read === 'string' && loaded !== undefined ? read : loaded);
  };
};

/**
 * The changes as they are written: a non-base translation emptied where Dataverse can't remove it becomes its stand-in
 * (model.ts standIn), marked with Change.standIn, so no writer ever sees it blank, but for a metadata description, which
 * is saved empty (model.ts savesEmpty). An Undo back to no translation of such a description (Change.untranslated)
 * whose stand-in is its base text, empty as the run leaves it, is saved empty after all: that language's users saw no
 * text there before the publish, which '' gives them again (passed on without the mark). Every other change, and one
 * whose stand-in isn't known (check() refuses it, saying why), is passed on as the same object.
 */
export function withStandIns(changes: readonly Change[], base: Lcid, text: TextOf): Change[] {
  return changes.map((c) => {
    if (c.standIn || c.slot.readOnly || isManaged(c.slot)) return c;
    const x = standIn(c.slot, c.lcid, base, c.before, c.after, text, c.untranslated);
    if (x?.text) return { ...c, after: x.text, standIn: { from: x.from, typed: c.after } };
    if (x && c.untranslated && !x.unloaded && keepsEmpty(c.slot)) {
      const { untranslated: _, ...none } = c;
      return none;
    }
    return c;
  });
}

/**
 * The change an Undo makes of a journaled label (undo(), the Undo question): back to the text it had before the publish
 * (`before`), measured against the text the publish wrote (bare(): entries recorded before it was applied may hold the
 * typed spaces of a removal). A metadata description the publish translated where it had no translation (`before` ''
 * and not `empty`; entries journaled before such texts were kept apart can't tell, and count so) goes back to no
 * translation: Dataverse can't remove one, so it gets its stand-in as before (Change.untranslated), never saved empty,
 * and that language's users see what they saw before. One stored empty before (`empty`) is saved empty again.
 */
export const undoChange = (slot: Slot, it: HistoryItem): Change => ({
  slot,
  lcid: it.lcid,
  before: bare(it.after),
  after: it.before,
  ...(it.before === '' && !it.empty && keepsEmpty(slot) ? { untranslated: true as const } : {}),
});

/** Plain-English message for an unexpected save failure. */
export function friendly(e: unknown): string {
  if (e instanceof DvError) {
    if (e.code === 'network') return 'Could not reach Dataverse. Check your connection; your edits are still pending.';
    if (e.status === 401) return 'Your Dynamics session has expired. Sign in again in another tab, then save again; your edits are kept here.';
    if (e.status === 403)
      return `You do not have permission to change this${/permission to do this/.test(e.message) ? '' : ` (${e.message.slice(0, 200)})`}. Translating needs the System Customizer or System Administrator role.`;
    if (e.status === 412) return 'Someone else changed this component while it was being saved. Reload it and try again.';
    if (isLockError(e)) return 'Dataverse is busy with another customization. Your edits are still pending; try Save again in a minute.';
  }
  if (e instanceof TypeError) return `Unexpected problem: ${e.message}`;
  return (e instanceof Error && e.message) || String(e) || 'Unexpected problem.';
}

type Job = [Writer, Change[]];
type Run = (j: Job) => Promise<void>;

const inSeq = async (jobs: Job[], run: Run): Promise<void> => {
  for (const j of jobs) await run(j);
};
const inPool = async (jobs: Job[], n: number, run: Run): Promise<void> => {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, jobs.length) }, async () => {
      while (i < jobs.length) await run(jobs[i++]);
    }),
  );
};

/**
 * The lanes that write at the same time, one promise each (LIVE-FINDINGS 44):
 *  - metadata: strictly one write at a time, as two customization writes at once fail with 429 / 0x80071151
 *    (finding 4; the metadata writers retry that lock themselves). Table, column and relationship PUTs go
 *    first, then the option actions (UpdateOptionValue / UpdateStateValue);
 *  - records (SetLocLabels): a few at once;
 *  - xml (form XML): one form at a time, alongside the metadata lane: a formxml PATCH never collided with a
 *    metadata PUT (LIVE-FINDINGS 44), so the form work hides behind the PUTs. A form's name or description
 *    (records lane) waits until that form's XML is written, so the same systemform row never gets two writes at once.
 * Every metadata and records job runs under LangSession.quiet: never while a UI-language switch window of the
 * translator is open (the xml lane's batches for other-language tab and section labels), and no switch starts
 * while one runs. Verified live (LIVE-FINDINGS 62): a column PUT that ran while the form lane had the language
 * switched was answered 204 and silently not kept, again on every retry, while the same mixed save without a
 * switch kept everything.
 * Every job reports its own results; none of these promises rejects.
 */
export function schedule(lanes: Record<Lane, Job[]>, run: Run, lang: Pick<LangSession, 'quiet'>): Array<Promise<void>> {
  const isOption = ([, cs]: Job) => OPTIONS.test(cs[0].slot.kind);
  const meta = [...lanes.metadata.filter((j) => !isOption(j)), ...lanes.metadata.filter(isOption)];
  const calm: Run = (j) => {
    // A lock the browser refused never stops the write (the in-tab locks still hold); it never runs twice.
    let ran = false;
    return lang.quiet(() => ((ran = true), run(j))).catch(() => (ran ? undefined : run(j)));
  };
  const metaRun = calm;
  const forms = new Set(lanes.xml.map(([, cs]) => guid(cs[0].slot.ref?.formId)));
  const sameRow = ([, cs]: Job) => {
    const m = /^(form|dashboard)\|(.+)$/.exec(cs[0].slot.group);
    return !!m && forms.has(guid(m[2]));
  };
  return [
    inSeq(meta, metaRun),
    inPool(lanes.records.filter((j) => !sameRow(j)), 4, calm),
    inSeq(lanes.xml, run).then(() => inPool(lanes.records.filter(sameRow), 4, calm)),
  ];
}

export function createSaver(ctx: Ctx, store: Store, lang: LangSession, writerFor: (k: Kind) => Writer | undefined): SaverApi {
  let running = false;
  const base = ctx.base;
  /**
   * The text the server holds once a change is saved: a blank value removes that translation (ARCHITECTURE
   * §4 "Clearing a translation"; a blank base-language description and a metadata description saved empty, model.ts
   * savesEmpty, are written as ''), leaving '' whatever spaces were typed. Undo uses it as its conflict baseline, so it
   * must not be the typed spaces. Same rule as Store.commit.
   */
  const stored = (text: string): string => (text.trim() ? text : '');
  /**
   * The texts a write of this saver may have saved although its run didn't say they were (an error, or a stop once the
   * write began), by change id, until a later run settles them: only where the writer says a write was sent for it that
   * Dataverse did not refuse (SaveOptions.ran: answered, or its answer lost). A later run that finds one already as asked
   * may be finding that write (reported as not confirmed, then Try again): it is journaled as that run's. One this saver
   * never sent, or sent only to have it refused (a read before the write failed, a 403, a check), and finds already as
   * asked is someone else's text (ChangeResult.found): never journaled as this run's, so its Undo never puts theirs back.
   */
  const tried = new Map<string, string>();

  /**
   * Errors block a change (it is never sent to Dataverse); warnings are shown on its row in the Publish dialog, and
   * the `general` ones (how labels like it are saved, the same words for each) once for all. A change with an error
   * gets only its errors: its warnings would describe a write that cannot happen. `changes` come with their stand-ins
   * (withStandIns); `text` is what those were measured by (the texts as the run leaves them, saveText), for the reason
   * one has none.
   */
  function check(changes: Change[], purpose: Purpose, text: TextOf): Issue[] {
    const out: Issue[] = [];
    const next = new Map(changes.map((c) => [changeId(c), c.after]));
    const baseName = lcidName(base);
    for (const c of changes) {
      const { slot: s, lcid, after: v } = c;
      // A component from a managed solution is read-only even where its slot slipped through as editable: saving it
      // would put an unmanaged layer on it.
      const ro = s.readOnly || (isManaged(s) ? MANAGED : '');
      if (ro) {
        out.push({ change: c, level: 'error', message: `Read-only: ${ro}` });
        continue;
      }
      const errors: string[] = [];
      const warnings: string[] = [];
      const general: string[] = [];
      const name = lcidName(lcid);
      const blank = !v.trim(); // only spaces counts as empty
      // The base-language text next to a translation, pending edits included ('' for the base language itself).
      const b = lcid === base ? '' : (next.get(`${s.key}#${base}`) ?? store.edits.get(s.key)?.get(base) ?? s.labels[base] ?? '');
      /** Held back, not refused: what stands in for it isn't loaded (model.ts StandIn.unloaded). */
      let unloaded = false;
      if (blank && lcid === base) {
        if (s.baseRequired) errors.push(`The ${name} label can't be blank: it is the base language.`);
        else if (c.before) warnings.push(`Clears the ${name} text.`);
      } else if (blank && savesEmpty(s, lcid, base, c.untranslated)) {
        // A metadata description emptied (or only spaces, a translation or not): saved empty, so that language's users
        // see none (model.ts savesEmpty). Nothing to refuse or warn about: the Publish dialog's row says so quietly.
      } else if (blank && (c.before !== '' || c.untranslated)) {
        // Removing a translation (an Undo's, Change.untranslated: one the publish stored empty too), so that language
        // falls back to the base text. Dataverse can't do that
        // for metadata, form tab/section/field or classic ribbon labels (ARCHITECTURE §4 "Clearing a translation"),
        // nor for a process stage or step translation, which Dynamics keeps once stored (model.ts stays): there it is
        // written as its stand-in (withStandIns), so one still blank here has none, and the reason is said.
        if (!canClear(s, lcid)) {
          const x = standIn(s, lcid, base, c.before, v, text, c.untranslated);
          unloaded = !!x?.unloaded;
          errors.push(noStandIn(s, lcid, x, purpose === 'undo'));
        } else
          warnings.push(
            b.trim()
              ? `Removes the ${name} translation; ${name} users will see the ${baseName} text.`
              : `Removes the ${name} translation; ${name} users will see no text, as the ${baseName} text is empty too.`,
          );
      } else if (blank && v !== '') {
        // Only spaces where there is no translation yet.
        if (!canClear(s, lcid))
          // Dataverse would store them, and a stored blank label shows as blank instead of falling back (finding 32).
          errors.push(onlySpaces(lcid, base));
        else warnings.push(`Only spaces: there is no ${name} translation to remove, so nothing changes for ${name} users.`);
      }
      if (!blank && lcid !== base && !b.trim() && namesFirst(s)) errors.push(baseNameFirst(base));
      if (s.max > 0 && v.length > s.max) errors.push(`Too long: ${v.length} characters (the limit is ${s.max}).`);
      if (!blank) {
        if (v !== v.trim()) warnings.push('Starts or ends with a space.');
        if (/ {2}/.test(v)) warnings.push('Contains two spaces in a row.');
        // A translation worded like the base text gets no warning: many labels read the same in both languages.
        if (lcid !== base && b && placeholders(v) !== placeholders(b))
          warnings.push(`Placeholders like {0} don't match: ${placeholders(v)} here, ${placeholders(b)} in the ${baseName} text.`);
      }
      if (SWITCHES.test(s.kind) && lcid !== ctx.user) general.push(`Saving ${name} tab and section labels briefly switches your Dynamics language to ${name}.`);
      if (s.kind === 'ribbon') general.push('Classic command labels are saved through a translation import (about 20 seconds per table).');
      if (s.kind === 'globaloption') {
        const n: number = s.ref?.usedBy?.length || 0;
        warnings.push(n ? `Global choice: this changes all ${n} column${n === 1 ? '' : 's'} that use it.` : 'Global choice: this changes every column that uses it.');
      }
      // Held back only while nothing else refuses it.
      if (errors.length) for (const message of errors) out.push({ change: c, level: 'error', message, ...(unloaded && errors.length === 1 ? { unloaded } : {}) });
      else {
        for (const message of warnings) out.push({ change: c, level: 'warn', message });
        for (const message of general) out.push({ change: c, level: 'warn', message, general: true });
      }
    }
    return out;
  }

  /**
   * The changes as a run of them writes them, their issues, and the texts their stand-ins are measured by: as the run
   * leaves them on the server (saveText), made of the changes it writes alone. Those are the ones nothing refuses and that
   * are measured against the text loaded (or read, `now`): one whose server text moved since it was made fails at its
   * writer (a conflict) unless it is forced or chosen anyway. The checks depend on the stand-ins (one with none is
   * refused), so this is worked out again until it holds: a base-language text, then a column's name, then a form label
   * made of it, a round each at most.
   */
  function measure(staged: readonly Change[], purpose: Purpose, o: PrepareOptions = {}): { changes: Change[]; issues: Issue[]; text: TextOf; sent: Change[] } {
    const serverOf = (c: Change): string => {
      const read = o.now?.get(changeId(c));
      return typeof read === 'string' ? read : store.original(c.slot.key, c.lcid);
    };
    const writes = (c: Change): boolean => !!o.force?.has(changeId(c)) || !!o.anyway?.has(changeId(c)) || bare(c.before) === bare(serverOf(c));
    let sent = staged.filter(writes);
    for (let round = 0; ; round++) {
      const text = saveText(store, sent, o.now);
      const changes = withStandIns(staged, base, text);
      const issues = check(changes, purpose, text);
      const at = new Map(changes.map((c, i) => [c, i] as const));
      const bad = new Set(issues.filter((i) => i.level === 'error').map((i) => at.get(i.change)));
      const next = staged.filter((c, i) => writes(c) && !bad.has(i));
      if (round >= 3 || (next.length === sent.length && next.every((c, i) => c === sent[i]))) return { changes, issues, text, sent };
      sent = next;
    }
  }

  /**
   * Reads again, before anything is written, every text the stand-ins of `cs` are made of (model.ts standInSources),
   * by their writers' reads (current()). A stand-in made of a text that changed on the server since it was loaded would
   * be the old one: it is never written. Its change fails saying so (`stale`, by change), and the store takes the new
   * text, so the next run (Try again) measures that. One that couldn't be read fails too, saying why. `expect`: each text
   * as the run measured it before writing (a change it writes: the server text that change was made on). In the same
   * reads, the label's own text of each of `same` (stand-ins that are the text they replace already, model.ts StandIn
   * same): `now`, by change (an Error when it couldn't be read), as nothing is written for one only while the server
   * still holds that text.
   */
  async function sources(
    cs: Change[],
    same: readonly Change[],
    expect: (key: string, l: Lcid) => string,
    signal: AbortSignal,
  ): Promise<{ stale: Map<Change, string>; now: Map<Change, string | Error> }> {
    const stale = new Map<Change, string>();
    const own = new Map<Change, string | Error>();
    const reads = new Map<string, Change>();
    const of = new Map<Change, Array<{ key: string; lcid: Lcid; id: string; was: string }>>();
    for (const c of cs) {
      const list = [];
      for (const src of standInSources(c.slot, c.lcid, base, c.standIn!.from)) {
        const slot = store.get(src.key);
        if (!slot) continue;
        const id = `${src.key}#${src.lcid}`;
        const was = expect(src.key, src.lcid);
        if (!reads.has(id)) reads.set(id, { slot, lcid: src.lcid, before: was, after: was });
        list.push({ ...src, id, was });
      }
      of.set(c, list);
    }
    for (const c of same) if (!reads.has(changeId(c))) reads.set(changeId(c), c);
    if (!reads.size) return { stale, now: own };
    let now: ServerTexts;
    try {
      now = await current([...reads.values()], signal);
    } catch (e) {
      if (isAbort(e) || signal.aborted) return { stale, now: own }; // stopped: the lanes skip every change as cancelled
      now = new Map([...reads.keys()].map((id) => [id, e instanceof Error ? e : new Error(String(e))] as const));
    }
    const got = (id: string) => now.get(id) ?? new Error('Dataverse did not return this label.');
    for (const [c, list] of of)
      for (const src of list) {
        const t = got(src.id);
        if (t instanceof Error) stale.set(c, sourceUnread(c.slot, src, t.message || 'It was not read'));
        else if (bare(t) !== bare(src.was)) {
          store.seen(src.key, src.lcid, t);
          stale.set(c, sourceMoved(c.slot, src, t));
        } else continue;
        break;
      }
    for (const c of same) own.set(c, got(changeId(c)));
    return { stale, now: own };
  }

  async function run(staged: Change[], o: SaveRunOptions, purpose: Purpose): Promise<SaveReport> {
    const t0 = performance.now();
    const { signal } = o;
    // 0. An emptied translation Dataverse can't remove is written as its stand-in, before the checks and the writers,
    // measured by the texts as this run leaves them (measure); the results, the store and the journal then carry the
    // text written.
    const { changes, issues, sent, text } = measure(staged, purpose, o);
    const total = changes.length;
    // The changes that replace a translation stored empty (model.ts storedEmpty), as the store had it before this run:
    // journaled so (HistoryItem.empty), so Undo saves it empty again rather than giving it its stand-in.
    const wasEmpty = new Set(changes.filter((c) => c.before === '' && storedEmpty(c.slot, c.lcid, base)).map(changeId));
    const results: ChangeResult[] = [];
    /** Each change's result so far, by change id (a stand-in made of a text this run writes waits for that one's). */
    const outcomes = new Map<string, ChangeResult>();
    const tell = (message: string) => safe(() => o.onProgress({ done: results.length, total, message }));
    const idle = purpose === 'undo' ? 'Undoing…' : 'Saving…';
    const finish = (r: ChangeResult) => {
      results.push(r);
      outcomes.set(changeId(r.change), r);
      safe(() => o.onResult?.(r));
    };

    // 1. Validate and group: one job per (writer, slot.group), queued on the writer's lane. A change with
    // a validation error is never sent; its result carries every error message, so the results list says
    // exactly why it was not saved. One held back only because what stands in for it isn't loaded is skipped: loading
    // that text lets it through (a retry, or another undo, can write it).
    const blocked = new Map<Change, string>();
    const held = new Set<Change>();
    for (const i of issues) {
      if (i.level !== 'error') continue;
      const prev = blocked.get(i.change);
      blocked.set(i.change, prev ? `${prev} ${i.message}` : i.message);
      if (i.unloaded) held.add(i.change);
    }
    // A stand-in made of a text that changed on the server since it was loaded is never written (sources()). One that is
    // the text it replaces already (model.ts StandIn same) needs no write at all, nor a publish, while the server still
    // holds that text: it is read first (sources()), and another text there is a conflict, as a writer would find it
    // (never a silent "unchanged" over someone else's newer text). One that couldn't be read goes to its writer, which
    // reads it again.
    const was = new Map(sent.map((c) => [changeId(c), c.before] as const));
    const stood = changes.filter((c) => c.standIn && !blocked.has(c) && !c.slot.readOnly && !isManaged(c.slot));
    const same = new Set(stood.filter((c) => bare(c.after) === bare(c.before)));
    const { stale, now } = stood.length
      ? await sources(stood, [...same], (k, l) => was.get(`${k}#${l}`) ?? store.original(k, l), signal)
      : { stale: new Map<Change, string>(), now: new Map<Change, string | Error>() };
    // A stand-in made of a text this run writes (`deps`: the column's new name, its English text) is that text only once
    // it is saved. Written by the same job, it is in the same write (one request: it fails with it; a text someone
    // changed since was found by sources()). Written by another job (`apart`: a form label of its column's name), its
    // job is set aside (`after`): written in a second round once the metadata, records and xml lanes have ended (a doc or
    // ribbon one after the other jobs of its lane), and a stand-in whose text wasn't saved is held back, never written
    // (ready()). One that needs no write is decided once those are known too (`wait`).
    const sentIds = new Set(sent.map(changeId));
    const byId = new Map(changes.map((c) => [changeId(c), c] as const));
    const deps = new Map<Change, Array<{ key: string; lcid: Lcid; id: string }>>();
    for (const c of stood) {
      const list = standInSources(c.slot, c.lcid, base, c.standIn!.from)
        .map((src) => ({ ...src, id: `${src.key}#${src.lcid}` }))
        .filter((src) => sentIds.has(src.id) && byId.has(src.id));
      if (list.length) deps.set(c, list);
    }
    const apart = (c: Change) =>
      (deps.get(c) ?? []).filter((src) => {
        const x = byId.get(src.id)!;
        return writerFor(x.slot.kind) !== writerFor(c.slot.kind) || x.slot.group !== c.slot.group;
      });
    /**
     * Why a stand-in made of texts this run writes can't be written now (undefined: it can): one of them (`list`) wasn't
     * saved, or the texts saved don't give the text it was measured as (measured again by them, as model.ts standIn does).
     */
    const ready = (c: Change, list: ReadonlyArray<{ key: string; lcid: Lcid; id: string }>): string | undefined => {
      for (const src of list) {
        const r = outcomes.get(src.id);
        if (r?.outcome !== 'saved' && r?.outcome !== 'unchanged') return sourceUnsaved(c.slot, src);
      }
      const confirmed = (k: string, l: Lcid): string | undefined => {
        const r = list.some((src) => src.id === `${k}#${l}`) ? outcomes.get(`${k}#${l}`) : undefined;
        return r ? stored(r.change.after) : text(k, l);
      };
      const x = standIn(c.slot, c.lcid, base, c.before, c.standIn!.typed, confirmed, c.untranslated);
      if (x?.text && bare(x.text) === bare(c.after)) return undefined;
      const src = list[0];
      return sourceMoved(c.slot, src, confirmed(src.key, src.lcid) ?? '');
    };
    const wait: Change[] = [];
    /**
     * A stand-in that needs no write, made of a text this run writes: as it is once that text is saved (unchanged), else
     * held back as one written would be. Decided once every text it is made of has its result (`all`: at the end, whatever).
     */
    const decide = (all: boolean) => {
      for (const c of [...wait]) {
        const list = deps.get(c)!;
        if (!all && list.some((src) => !outcomes.has(src.id))) continue;
        wait.splice(wait.indexOf(c), 1);
        const why = ready(c, list);
        finish(why ? { change: c, outcome: 'skipped', message: signal.aborted ? CANCELLED : why } : { change: c, outcome: 'unchanged' });
      }
    };
    const jobs: Job[] = [];
    const index = new Map<Writer, Map<string, Change[]>>();
    for (const c of changes) {
      const w = writerFor(c.slot.kind);
      const msg = blocked.get(c);
      const read = same.has(c) ? now.get(c) : undefined;
      const r = typeof read === 'string' ? compare(c, read, o.force ?? new Set()) : null;
      // Read-only (a managed solution's component included): skipped with the reason, never sent to a writer.
      if (c.slot.readOnly || isManaged(c.slot) || held.has(c)) finish({ change: c, outcome: 'skipped', message: msg });
      else if (msg) finish({ change: c, outcome: 'error', message: msg });
      else if (stale.has(c)) finish({ change: c, outcome: 'error', message: stale.get(c) });
      else if (r?.outcome === 'unchanged' && deps.has(c)) wait.push(c);
      else if (r) finish(r);
      else if (!w) finish({ change: c, outcome: 'error', message: 'Saving this kind of label is not supported yet.' });
      else {
        let groups = index.get(w);
        if (!groups) index.set(w, (groups = new Map()));
        let cs = groups.get(c.slot.group);
        if (!cs) {
          groups.set(c.slot.group, (cs = []));
          jobs.push([w, cs]);
        }
        cs.push(c);
      }
    }
    const lanes: Record<Lane, Job[]> = { metadata: [], records: [], xml: [], doc: [], ribbon: [] };
    /** The jobs with a stand-in made of a text another job writes: written once every other job has ended. */
    const after: Record<Lane, Job[]> = { metadata: [], records: [], xml: [], doc: [], ribbon: [] };
    for (const j of jobs) (j[1].some((c) => apart(c).length) ? after : lanes)[j[0].lane].push(j);

    // 2. Write. A failing group never stops the others.
    const pset = new PublishSet();
    /** The changes a write of this run may have saved (SaveOptions.ran), as the writers say. */
    const ran = new Set<string>();
    const so: SaveOptions = { signal, publish: pset, progress: tell, force: o.force ?? new Set(), ran, lang, allowPublish: o.publish };
    const runJob = async ([w, cs]: Job): Promise<void> => {
      const got = new Map<string, ChangeResult>();
      let err: unknown = null;
      const sending = !signal.aborted;
      if (sending)
        try {
          for (const r of await w.save(ctx, cs, so)) got.set(changeId(r.change), r);
        } catch (e) {
          err = e;
        }
      for (const c of cs) {
        const id = changeId(c);
        const r = got.get(id);
        let x: Omit<ChangeResult, 'change'>;
        if (r) x = r;
        else if (err && !isAbort(err)) x = { outcome: 'error', message: friendly(err) };
        else if (err) x = { outcome: 'skipped', message: 'Cancelled while saving. Reload to see whether this label was saved.' };
        else if (signal.aborted) x = { outcome: 'skipped', message: CANCELLED };
        else x = { outcome: 'error', message: 'The save did not confirm this label. Reload to check it.' };
        if (sending) {
          // Already as asked, a text other than the one the edit was made on, and no write of this saver may have put it there: not this run's.
          const asked = stored(c.after);
          if (x.outcome === 'unchanged' && c.before !== asked && tried.get(id) !== asked) x = { ...x, found: true };
          // A failure adds its text only when a write of it was sent and may have run; one refused, unread or never sent
          // adds nothing, and keeps what an earlier run's write may have saved (its answer is still unknown).
          if (x.outcome !== 'error' && x.outcome !== 'skipped') tried.delete(id);
          else if (ran.has(id)) tried.set(id, asked);
        }
        finish({ ...x, change: c });
      }
      // Advances the done count. Never this job's last message: what it waited for ("Waiting for Dataverse to confirm…") is over.
      tell(idle);
    };

    tell(idle);
    // A language switch whose answer was lost may still run on the server: every write waits for it, and says so
    // (LangSession doubtful); Stop ends the wait for this save.
    const offWait = lang.onWait?.((w) => tell(w ? WAITING : idle));
    const warnings: string[] = [];
    /** The UI language could not be switched back (said in `warnings`): nothing switches it again in this run. */
    let stuck = false;
    // Every switch of the UI language is checked and put back by LangSession itself; this waits for that and
    // repairs a language that could not be put back (and says so).
    const restore = () =>
      lang
        .restore(signal)
        .catch((e) => (isAbort(e) ? Promise.reject(e) : lang.restore(signal)))
        .catch((e) => {
          if (isAbort(e)) return; // stopped while a switch in doubt may still run: the session goes on waiting for it
          stuck = true;
          const w = `Your Dynamics language could not be switched back (${friendly(e)}). Restart the translator to repair it, or change it in Personalization settings.`;
          warnings.push(w);
          tell(w);
        });
    try {
      // Every lane has ended before anything else starts (allSettled, not all: a lane that failed must not let
      // the publish start while the others still write, LIVE-FINDINGS 48).
      const stoppable = { quiet: <T>(f: () => Promise<T>) => lang.quiet(f, signal) };
      const settled = async (ps: Array<Promise<void>>) => {
        const bad = (await Promise.allSettled(ps)).find((x): x is PromiseRejectedResult => x.status === 'rejected');
        if (bad) throw bad.reason;
      };
      await settled(schedule(lanes, runJob, stoppable));
      decide(false);
      // Then the jobs with a stand-in made of a text another job wrote, the same way: a stand-in whose text wasn't saved
      // is held back (skipped, saying so: Try again writes both), the rest of its job written.
      const gate: Run = ([w, cs]) => {
        if (!signal.aborted)
          for (const c of [...cs]) {
            const list = apart(c);
            const why = list.length ? ready(c, list) : undefined;
            if (!why) continue;
            cs.splice(cs.indexOf(c), 1);
            finish({ change: c, outcome: 'skipped', message: why });
          }
        return cs.length ? runJob([w, cs]) : Promise.resolve();
      };
      await settled(schedule(after, gate, stoppable));
      // Other documents and the ribbon imports follow, one at a time, with nothing else in flight (they
      // were never measured alongside the other lanes, and the ribbon writer publishes the table itself). Not under
      // quiet() (their retries switch the language themselves), so a switch in doubt, a page load's or another tab's,
      // is waited out first, as the lanes wait for it; and before each next one, one left by such a retry (run()).
      const docs = [...lanes.doc, ...after.doc];
      const ribbons = [...lanes.ribbon, ...after.ribbon];
      if (docs.length || ribbons.length) await lang.restore(signal).catch(() => {});
      const calmly = (j: Job) => (lang.waiting ? lang.restore(signal).catch(() => {}) : Promise.resolve()).then(() => gate(j));
      await inSeq(docs, calmly);
      await inSeq(ribbons, calmly);
      decide(true);
    } finally {
      await restore();
      offWait?.();
    }

    // 3. Commit and journal before publishing, so a slow or failed publish loses nothing.
    const order = new Map(changes.map((c, i) => [c, i]));
    results.sort((a, b) => (order.get(a.change) ?? 0) - (order.get(b.change) ?? 0));
    if (results.length) store.commit(results);
    const saved = results.filter((r) => r.outcome === 'saved');
    // Labels that need no publish (commands, process labels, environment variables...) are live as soon
    // as they are written, so a save that touched only those counts as published.
    const live = pset.empty;
    // A label a save finds already as asked, which was not that text when it was edited, is journaled too when a write of
    // that text by this saver may have run (its answer lost or not confirmed, then Try again, `tried`): that write,
    // published by this run. One it never sent, or sent only to have it refused, is someone else's text (`found`): left
    // out, so Undo of this publish never puts back what this run didn't write. The report still counts it as already as
    // asked ('unchanged').
    const mine = results.filter((r) => r.outcome === 'saved' || (purpose === 'save' && r.outcome === 'unchanged' && !r.found && r.change.before !== stored(r.change.after)));
    // Named as the Publish dialog showed it, so Recent publishes can show the same rows; a place only when there is one.
    const items: HistoryItem[] = mine.map(({ change: c }) => {
      const { title, where } = named(c.slot, o);
      return { key: c.slot.key, comp: c.slot.comp, kind: c.slot.kind, lcid: c.lcid, title, ...(where ? { where } : {}), before: c.before, after: stored(c.after), ...(wasEmpty.has(changeId(c)) ? { empty: true as const } : {}) };
    });
    const entry: HistoryEntry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), at: Date.now(), items, published: live };
    const historyId = items.length && (await addHistory(ctx, entry)) ? entry.id : undefined;
    if (items.length && !historyId)
      warnings.push(
        `This ${purpose === 'undo' ? 'undo' : 'save'} could not be added to Recent publishes (it is very large, or the browser's storage is full or blocked), so it can't be ${purpose === 'undo' ? 'reversed' : 'undone'} from the translator.`,
      );

    // 4. One targeted publish. A label already as asked ('unchanged') counts too: it may be an earlier write whose
    // answer was lost (reported as not checked), never published; its writer then put it in the publish set.
    const done = saved.length + results.filter((r) => r.outcome === 'unchanged').length;
    let published = done > 0 && live;
    let publishError: string | undefined;
    // The processes to update (step 5) are part of this phase: the Publish dialog shows them on its Publishing step. Only
    // processes whose name a writer saved, so never one from a managed solution (rebuildProcess checks that again).
    const procs = o.publish && done ? [...pset.processes] : [];
    if (o.publish && done && (!live || procs.length)) tell('Publishing…');
    if (o.publish && done && !live) {
      try {
        await publishXml(ctx, pset, signal, tell);
        published = true;
        if (historyId) await markPublished(ctx, [historyId]);
      } catch (e) {
        publishError = isAbort(e)
          ? 'Publishing was cancelled. Your translations are saved and will show after the next publish.'
          : e instanceof PartialPublishError
            ? `Your translations are saved. ${e.message}`
            : isLockError(e)
              ? 'Dataverse is busy with another customization, so nothing was published. Your translations are saved; publish again in a few minutes.'
              : `Your translations are saved, but publishing failed: ${friendly(e)}`;
      }
    }

    // 5. A process whose name was written shows it on the page only once the process itself is updated (LIVE-FINDINGS
    // 83): once each, after every write and the publish, so outside every quiet() window (rebuildProcess's switch to
    // the base language needs the exclusive window, which a save lane's quiet() job would hold it from for good).
    // Never retried, and a failure never undoes the save: the page may only show the old name for now.
    let notice: string | undefined;
    if (procs.length) {
      let stale = false;
      for (const [id, name] of procs) {
        if (stuck || signal.aborted) {
          stale = true;
          continue;
        }
        tell(`Updating the process ${name}`);
        // The base-language names this save's own writes replaced: a read showing one lags behind them.
        const olds = new Set<string>();
        for (const { change: c, outcome } of results)
          if (outcome === 'saved' && c.slot.kind === 'bpf' && c.slot.prop === 'Name' && c.lcid === base && guid(c.slot.ref?.id) === guid(id))
            for (const t of [c.before, c.slot.labels?.[base]]) if (t?.trim() && t !== stored(c.after)) olds.add(t);
        try {
          const said = await rebuildProcess(ctx, lang, id, name, signal, [...olds]);
          if (said) warnings.push(said);
        } catch (e) {
          stale = true;
          if (__DEV__ && !isAbort(e)) console.warn('[translator] process update', e);
        }
      }
      if (!stuck) await restore();
      if (stale) notice = 'Saved; the page may show the old process name until the process is updated.';
    }

    const count = (x: Outcome) => results.filter((r) => r.outcome === x).length;
    const report: SaveReport = {
      results,
      saved: saved.length,
      unchanged: count('unchanged'),
      conflicts: count('conflict'),
      errors: count('error'),
      skipped: count('skipped'),
      published,
      publishError,
      ms: Math.round(performance.now() - t0),
      historyId,
    };
    if (warnings.length) report.warning = warnings.join(' ');
    if (notice) report.notice = notice;
    if (__DEV__) console.log('[translator] save', report, ctx.http.stats);
    return report;
  }

  /** One save or undo at a time: they share the language session and the customization lock. */
  async function start(changes: Change[], o: SaveRunOptions, purpose: Purpose): Promise<SaveReport> {
    if (running) throw new Error('A save is already running. Wait for it to finish.');
    running = true;
    store.setBusy(true, purpose === 'undo' ? 'Undoing a save' : 'Saving');
    try {
      return await run(changes, o, purpose);
    } finally {
      running = false;
      store.setBusy(false);
    }
  }

  /**
   * Run before anything is written, so the components these changes edit are listed too (`mine`): work already
   * pending on them (a form a maker rearranged and did not publish) is kept by the writers and goes live with the
   * translation. Once these changes are saved, those components are unpublished because of them as well, so a caller
   * checking after the save leaves them out. A failed read rejects (the caller says it couldn't check); it never
   * reads as "nothing pending".
   */
  async function pendingWork(changes: Change[], signal?: AbortSignal): Promise<PendingWork[]> {
    const ents = [...publishTargets(changes).entities];
    const mine = new Set<string>();
    for (const { slot: s } of changes) {
      const id = s.ref?.formId || (/^(form|view|chart)$/.test(s.kind) && s.ref?.id);
      if (id) mine.add(guid(id));
    }
    const found = new Map<string, PendingWork['items']>();
    const sources = [
      ['form', 'systemforms', 'formid', 'objecttypecode'],
      ['view', 'savedqueries', 'savedqueryid', 'returnedtypecode'],
      ['chart', 'savedqueryvisualizations', 'savedqueryvisualizationid', 'primaryentitytypecode'],
    ] as const;
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < ents.length; i += 20) {
      const part = ents.slice(i, i + 20);
      for (const [kind, set, id, col] of sources) {
        const filter = part.map((e) => `${col} eq '${q(e)}'`).join(' or ');
        const url = `${set}/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=${id},name,${col}&$filter=componentstate eq 1 and (${filter})`;
        jobs.push(
          ctx.http.all(url, { signal }).then((rows) => {
            for (const r of rows) {
              const e = String(r[col] || '');
              if (!e) continue;
              let items = found.get(e);
              if (!items) found.set(e, (items = []));
              items.push({ kind, name: String(r.name || ''), ...(mine.has(guid(r[id])) ? { mine: true } : {}) });
            }
          }),
        );
      }
    }
    await Promise.all(jobs);
    return ents.filter((e) => found.has(e)).map((entity) => ({ entity, items: found.get(entity)! }));
  }

  // Slot stand-in for undo items whose component is not loaded, so they can still be reported.
  const stub = (it: HistoryItem): Slot => ({
    key: it.key,
    kind: it.kind,
    prop: it.key.slice(it.key.lastIndexOf('|') + 1) as Prop,
    entity: '',
    comp: it.comp,
    group: it.comp,
    title: it.title,
    path: [],
    sub: '',
    labels: {},
    readOnly: 'Not loaded',
    baseRequired: false,
    max: 0,
    order: 0,
    ref: null,
  });

  /**
   * Writes the "before" values of a past save back through the same pipeline and checks. A translation the
   * save added is removed where Dataverse allows it; where it does not, it is written as its stand-in (model.ts
   * standIn: what that language shows without one, measured by the texts as this undo leaves them: the earlier texts it
   * writes back, else the server's, measure(); one made of a text it writes in another write, only once that one is back,
   * run()), so the page looks as before (a metadata description too, unless it was stored empty before the save: that
   * one is saved empty again, undoChange); one without a stand-in is reported as
   * "can't remove" (outcome 'error', nothing written), and one whose stand-in only waits for a text to be loaded (its
   * column's names) is skipped, saying what to load. The entry is marked undone once every label is back at its earlier
   * text or its stand-in (written now or already there, 'unchanged') or is one of those refusals, which no retry can
   * change (counted as `kept` for Recent publishes); otherwise Undo stays available to try again. Try again passes only
   * the items not back yet, with the refusals of the runs before in `entry.kept`.
   */
  async function undo(entry: HistoryEntry, o: SaveRunOptions): Promise<SaveReport> {
    const changes: Change[] = [];
    const missing: ChangeResult[] = [];
    for (const it of entry.items) {
      const slot = store.get(it.key);
      // The value written by the save is what the server should hold now: it is the conflict baseline (undoChange).
      if (slot) changes.push(undoChange(slot, it));
      else
        missing.push({
          change: undoChange(stub(it), it),
          outcome: 'skipped',
          message: "This component isn't loaded in the translator. Open its page or load it in the Workbench, then undo again.",
        });
    }
    const rep = await start(changes, o, 'undo');
    for (const r of missing) safe(() => o.onResult?.(r));
    rep.results.push(...missing);
    rep.skipped += missing.length;
    const kept = (entry.kept ?? 0) + rep.results.filter((r) => refusedBlank(r, ctx.base)).length;
    if (!missing.length && rep.results.every((r) => r.outcome === 'saved' || r.outcome === 'unchanged' || refusedBlank(r, ctx.base))) await markUndone(ctx, entry.id, kept);
    return rep;
  }

  /**
   * Each change's text on the server now, read by its writer's read() one save group at a time (a few at once), as
   * save() reads it before writing. Nothing is written. A group whose read fails maps its changes to the error;
   * Stop (the signal) rejects.
   */
  async function current(changes: Change[], signal = new AbortController().signal): Promise<ServerTexts> {
    const out: ServerTexts = new Map();
    const jobs: Job[] = [];
    const index = new Map<Writer, Map<string, Change[]>>();
    for (const c of changes) {
      const w = writerFor(c.slot.kind);
      if (!w?.read) {
        out.set(changeId(c), new Error("This kind of label can't be read here."));
        continue;
      }
      let groups = index.get(w);
      if (!groups) index.set(w, (groups = new Map()));
      let cs = groups.get(c.slot.group);
      if (!cs) {
        groups.set(c.slot.group, (cs = []));
        jobs.push([w, cs]);
      }
      cs.push(c);
    }
    await inPool(jobs, 4, async ([w, cs]) => {
      let got: ServerTexts | null = null;
      let err: Error | null = null;
      try {
        got = await w.read!(ctx, cs, { signal, lang });
      } catch (e) {
        if (isAbort(e) || signal.aborted) throw e;
        err = e instanceof Error ? e : new Error(String(e));
      }
      for (const c of cs) out.set(changeId(c), err ?? got?.get(changeId(c)) ?? new Error('Dataverse did not return this label.'));
    });
    return out;
  }

  /** The changes as a run of them writes them, measured as it measures them (measure); each issue names the change it was given. */
  function prepare(changes: Change[], o: PrepareOptions = {}): Prepared {
    const m = measure(changes, o.undo ? 'undo' : 'save', o);
    const given = new Map(m.changes.map((w, i) => [w, changes[i]] as const));
    return { written: m.changes, issues: m.issues.map((i) => ({ ...i, change: given.get(i.change) ?? i.change })), text: m.text };
  }

  return {
    validate: (changes, o) => prepare(changes, o).issues,
    prepare,
    publishTargets,
    pendingWork,
    save: (changes, o) => start(changes, o, 'save'),
    history: () => readHistory(ctx),
    current,
    undo,
  };
}
