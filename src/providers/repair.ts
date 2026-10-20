// Someone else's save landing between a whole-document writer's read and its PATCH (form XML, sitemaps, process
// definitions): seen, and their change put back.
//
// Nothing guards these documents on the server in that moment: form and sitemap If-Match is checked against the
// published row (LIVE-FINDINGS 22, 47) and the process PATCH refuses If-Match (29). So every write batch is
// [probe, PATCH, read back], and a $batch runs its parts in order: the probe shows exactly the document the PATCH
// replaced. When that is not the document the edit was built on, someone saved in between and the PATCH erased their
// change. The writer then builds its own label/language pairs again on the probe's document and writes that from a new
// read, which must still show its own PATCH (otherwise someone saved after it too, and nothing more is written). A pair
// they changed as well keeps their text and comes back as a conflict. Only a read-back showing their document again,
// with the edits on it, is "saved"; anything less is said. A probe that could not be read gives "Saved, but … can't be
// ruled out" at most, and so does one older than the read (a lower versionnumber: a read that lags, LIVE-FINDINGS 66),
// which written back would undo the saves it lags behind. No read can show a save landing between the probe and the
// PATCH inside the same batch.

import { DvError, pause, turnedAway } from '../core/http';
import type { Change, ChangeResult } from '../core/model';

/** What one write batch saw: the document right before its PATCH and right after it (null: could not be read). */
export interface Sent<D> {
  probe: D | null;
  back: D | null;
}

/** The batch stopped at a probe Dataverse answered with an error (no continue-on-error): nothing was written. */
export class Unsent extends Error {
  constructor(readonly error: DvError) {
    super(error.message);
  }
}

/** One document kind, for settle(). `D` is a document as read; `B` what a write sends. */
export interface DocOps<D, B> {
  /** In messages: "this form", "Check the sitemap". */
  noun: 'form' | 'sitemap' | 'process';
  /** Whether a Try again also publishes it (forms and sitemaps). */
  publish: boolean;
  /** For a label no longer in the document. */
  gone: string;
  /** For a label Dataverse did not keep (or did not remove). */
  dropped(c: Change): string;
  /** A fresh read (never cancelled: a repair always finishes); throws when it can't be read. */
  read(): Promise<D>;
  /** `todo` built on `base`, only those label/language pairs (the writer's safety check runs; it throws). */
  build(base: D, todo: Change[]): B;
  /** One write batch [probe, PATCH, read back], with `fresh`'s etag where there is one. Throws the PATCH's error, or Unsent. */
  send(body: B, fresh: D): Promise<Sent<D>>;
  /** Two reads show the same document. */
  same(a: D, b: D): boolean;
  /** `a` was read from a version older than `b`'s (its versionnumber is lower): a read that lags, nobody's save. */
  older(a: D, b: D): boolean;
  /** `a` and `b` are the same outside the label/language pairs of `todo`. */
  alike(a: D, b: D, todo: Change[]): boolean;
  /** A pair's entries, comparable with ===; null when its label is gone. */
  state(d: D, c: Change): string | null;
  /** A pair's text, for a conflict. */
  text(d: D, c: Change): string;
  /** The document holds the change as asked. */
  holds(d: D, c: Change): boolean;
}

export const RACE_THEIRS = 'Someone else saved this label at the same moment. Theirs was put back: choose which one to keep.';

/** The messages of a document kind. */
export function raceText(noun: string, publish: boolean) {
  const check = `Check the ${noun}, then Try again${publish ? ' to publish it' : ''}.`;
  return {
    raced: `Saved, but someone else saved this ${noun} at the same moment, and this save may have replaced their change. ${check}`,
    unseen: `Saved, but the ${noun} right before the save could not be read, so a save someone else made at the same moment can't be ruled out. ${check}`,
    lost: `Someone else saved this ${noun} at the same moment, and this label is not in it now. Check the ${noun}, then save again.`,
    clash: `Someone else saved this label at the same moment. Check the ${noun}.`,
    unchecked: 'Sent to Dataverse, but the result could not be checked. Reload to confirm it.',
  };
}

/**
 * Whether versionnumber `a` is lower than `b`: every save of a row raises it, so a read showing a lower one than an
 * earlier read lags behind it (LIVE-FINDINGS 66). False when either is unknown.
 */
export function olderVersion(a: unknown, b: unknown): boolean {
  try {
    return a != null && b != null && a !== '' && b !== '' && BigInt(String(a)) < BigInt(String(b));
  } catch {
    return false;
  }
}

/** Repair writes after the first PATCH, at most. */
const ROUNDS = 3;

/**
 * After a write batch whose PATCH ran: null when its probe shows the document the edit was built on (`base`), so the
 * caller checks the read-back as before; otherwise the result of every change of `todo`, in order, once their change
 * is back (or why it could not be).
 */
export async function settle<D, B>(ops: DocOps<D, B>, base: D, todo: Change[], sent: Sent<D>): Promise<ChangeResult[] | null> {
  if (sent.probe && ops.same(sent.probe, base)) return null;
  const w = raceText(ops.noun, ops.publish);
  const err = (change: Change, message: string): ChangeResult => ({ change, outcome: 'error', message });
  const read = () => ops.read().catch(() => null);
  // A probe older than the read lags behind it: it shows no save of anyone's, and written back it would undo saves.
  const probe = sent.probe && !ops.older(sent.probe, base) ? sent.probe : null;
  if (!probe) {
    // What the PATCH replaced is unknown: saved at most when right after it the document is exactly the read with the edit.
    const v = sent.back ?? (await read());
    const as = !!v && ops.alike(v, base, todo);
    return todo.map((c) => err(c, !v ? w.unchecked : as ? (ops.holds(v, c) ? w.unseen : ops.dropped(c)) : ops.holds(v, c) ? w.raced : w.lost));
  }
  /** What the last PATCH was built on, what it replaced, what it left (as read right after), and its pairs. */
  let [B, P, V, W] = [base, probe, sent.back, todo];
  let T = todo;
  let sure: 'yes' | 'unseen' | 'no' = 'yes';
  const gone = new Set<Change>();
  const clash = new Set<Change>();
  /** The results once nothing more is written: `now` as last read, `done` when it shows their document back with the edits. */
  const finish = (now: D | null, done: boolean): ChangeResult[] =>
    todo.map((c): ChangeResult => {
      if (gone.has(c)) return err(c, ops.gone);
      if (clash.has(c)) return now && !ops.holds(now, c) ? { change: c, outcome: 'conflict', server: ops.text(now, c), message: done ? RACE_THEIRS : w.clash } : err(c, w.raced);
      if (!now) return err(c, w.unchecked);
      if (!ops.holds(now, c)) return err(c, done ? ops.dropped(c) : w.lost);
      return !done || sure === 'no' ? err(c, w.raced) : sure === 'unseen' ? err(c, w.unseen) : { change: c, outcome: 'saved' };
    });
  for (let round = 0, waits = 0; ; ) {
    // A pair they changed too keeps their text: a conflict, never ours winning. A label they removed stays removed.
    T = T.filter((c) => {
      const p = ops.state(P, c);
      if (p === null) gone.add(c);
      else if (p !== ops.state(B, c) && !ops.holds(P, c)) clash.add(c);
      else return true;
      return false;
    });
    // They made exactly these edits: the last PATCH left their document as it should be.
    if (V && ops.alike(V, P, T) && T.every((c) => ops.holds(V!, c))) return finish(V, true);
    if (round >= ROUNDS) return finish(V, false);
    const F = await read();
    // Only over our own PATCH: a document someone saved after it (or one that can't be read) gets nothing more written.
    if (!F || !(V ? ops.same(F, V) : ops.alike(F, B, W) && W.every((c) => ops.holds(F, c)))) return finish(F ?? V, false);
    let s: Sent<D>;
    try {
      s = await ops.send(ops.build(P, T), F);
    } catch (e) {
      // Not run (turned away, its probe failed, or published meanwhile: 412): the same repair from a new read.
      if ((e instanceof Unsent || turnedAway(e) || (e instanceof DvError && e.status === 412)) && waits < 3) {
        await pause(2000 << waits++);
        continue;
      }
      return finish(F, false);
    }
    round++;
    // A probe that can't be read, or lags behind the read this write was built from: what the write replaced is unknown.
    if (!s.probe || (!ops.same(s.probe, F) && ops.older(s.probe, F))) {
      if (sure === 'yes') sure = 'unseen';
      const v = s.back ?? (await read());
      return finish(v, !!v && ops.alike(v, P, T));
    }
    if (!ops.same(s.probe, F)) {
      // Another save landed before this write: it is what the next one puts back. Built on our first PATCH, it may lack
      // the change that one erased, so the end is never "saved".
      sure = 'no';
      [B, P, V, W] = [P, s.probe, s.back, T];
      continue;
    }
    const v = s.back ?? (await read());
    return finish(v, !!v && ops.alike(v, P, T));
  }
}
