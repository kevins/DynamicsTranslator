// Central state: loaded slots, pending edits (with undo/redo), per-cell save status.
// Views subscribe with `store.on(fn)` and re-render what changed.

import { isManaged, keepsEmpty, MANAGED, notLoaded, savesEmpty, standIn, type Change, type ChangeResult, type Labels, type Lcid, type Outcome, type Slot, type StandIn } from './model';

export type StoreEvent =
  | { type: 'slots' } // slots added, removed or refreshed
  | { type: 'edit'; key: string; lcid: Lcid } // one cell changed (also fired for undo/redo/revert)
  | { type: 'edits' } // many cells changed at once (bulk fill, import, commit)
  | { type: 'status' } // save status changed
  | { type: 'busy'; busy: boolean; label?: string };

export interface CellStatus {
  outcome: Outcome;
  message?: string;
  /** Value now on the server, for conflicts. */
  server?: string;
}

interface Op {
  key: string;
  lcid: Lcid;
  from: string | undefined; // previous pending edit (undefined = none)
  to: string | undefined;
  // Bases of the `from` and `to` edits (see Store.bases), so undo/redo bring an edit back measured
  // against the server text it was made on, not whatever a reload brought since (null: no label there, see bases).
  fromBase?: string | null;
  toBase?: string | null;
}

const cell = (key: string, lcid: Lcid) => `${key}#${lcid}`;

/**
 * Records a value that is now on the server, exactly as the loaders would (core/xml presentLabels): a
 * label stored as '' counts as missing, any other text (spaces included) is kept as it is, because the
 * writers compare `before` with the stored text. Exceptions: slots with `ref.partial === true` use
 * "language present in labels" to mean "loaded" (ui/editor notLoaded), so there '' is kept to mark the
 * language as known; a metadata description keeps '' as a text of its own, stored empty (model.ts keepsEmpty: that
 * language's users see none), apart from a missing language (providers/metadata.ts loads it so).
 */
function setServer(slot: Slot, lcid: Lcid, value: string): void {
  if (value !== '' || slot.ref?.partial === true || keepsEmpty(slot)) slot.labels[lcid] = value;
  else delete slot.labels[lcid];
}

export class Store {
  readonly slots = new Map<string, Slot>();
  /** Pending edits: slot key -> lcid -> new text. */
  readonly edits = new Map<string, Map<Lcid, string>>();
  readonly status = new Map<string, CellStatus>();
  busy = false;
  /**
   * Base of each pending edit (`key#lcid`): the server text the user was looking at when they made it. It is
   * the edit's Change.before and survives slot refreshes, so a reload that brings another maker's newer text
   * under a staged edit makes the writer's fresh-read compare report a conflict instead of overwriting it.
   * Set when the edit is created, kept while it is edited again, moved to the new server text only by a save of this
   * cell or Keep mine, removed with the edit. null where the language had no label at all on a label that keeps a ''
   * stored apart from none (model.ts keepsEmpty, baseOf): '' to the writers, with Change.beforeMissing, so a '' someone
   * else stored there since is a change under the edit (moved()) and a conflict at save.
   */
  private bases = new Map<string, string | null>();
  /**
   * How recent each server text is, on the store's clock (tick()): the tick of the load each slot came from (`loadedAt`,
   * by key), and of a text a cell got since (`cellAt`, `key#lcid`: a save's result, a text read again, a conflict
   * resolved). A load answered after a newer text came in (it started before) never puts its older text back (add()).
   */
  private clock = 0;
  private loadedAt = new Map<string, number>();
  private cellAt = new Map<string, number>();
  private undoStack: Op[][] = [];
  private redoStack: Op[][] = [];
  private batch: Op[] | null = null;
  private subs = new Set<(e: StoreEvent) => void>();

  on(fn: (e: StoreEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  emit(e: StoreEvent): void {
    for (const fn of [...this.subs]) {
      try {
        fn(e);
      } catch (err) {
        console.error('[translator]', err);
      }
    }
  }

  /**
   * A tick of the store's clock, taken by a load as it starts and given to add() with what it read (`since`): a text the
   * store gets after it (another load's that started later, a save's) is newer than that read.
   */
  tick(): number {
    return ++this.clock;
  }

  /** How recent the store's server text of a cell is (tick()); 0 for none. */
  private age(key: string, lcid: Lcid): number {
    return Math.max(this.loadedAt.get(key) ?? 0, this.cellAt.get(cell(key, lcid)) ?? 0);
  }

  /**
   * Adds or refreshes slots. A refreshed slot keeps its pending edits, each still measured against
   * its base (a different server value under it is a conflict at save); an edit that now equals the
   * server value is dropped. `since`: the tick the load that read them started at (tick()), else they count as read now.
   * A language whose text the store got after that (a later load, a save) keeps that newer text: an older read never
   * puts its text back, nor drops (as saved) an edit typed over the newer one because it matches the older.
   */
  add(slots: Slot[], since?: number): void {
    const t = since ?? this.tick();
    for (let s of slots) {
      // A label from a managed solution is read-only, with the same reason everywhere, whatever its loader said (they say
      // so already): every view then shows it read-only and nothing stages it.
      if (!s.readOnly && isManaged(s)) s.readOnly = MANAGED;
      const old = this.slots.get(s.key);
      if (old) {
        let newer: Labels | null = null;
        for (const l of new Set([...Object.keys(old.labels), ...Object.keys(s.labels)].map(Number))) {
          const at = this.age(s.key, l);
          if (at <= t || notLoaded(old, l)) continue;
          newer ??= { ...s.labels };
          if (l in old.labels) newer[l] = old.labels[l];
          else delete newer[l];
          this.cellAt.set(cell(s.key, l), at);
        }
        if (newer) s = { ...s, labels: newer };
      }
      this.loadedAt.set(s.key, t);
      this.slots.set(s.key, s);
      const e = this.edits.get(s.key);
      if (e)
        for (const [l, v] of e)
          if ((s.labels[l] ?? '') === v) {
            e.delete(l);
            this.bases.delete(cell(s.key, l));
          }
      if (e && !e.size) this.edits.delete(s.key);
    }
    this.emit({ type: 'slots' });
  }

  get(key: string): Slot | undefined {
    return this.slots.get(key);
  }
  original(key: string, lcid: Lcid): string {
    return this.slots.get(key)?.labels[lcid] ?? '';
  }
  /** Current value: pending edit if any, else the server value. */
  value(key: string, lcid: Lcid): string {
    const e = this.edits.get(key);
    if (e && e.has(lcid)) return e.get(lcid) as string;
    return this.original(key, lcid);
  }
  isEdited(key: string, lcid?: Lcid): boolean {
    const e = this.edits.get(key);
    return !!e && (lcid === undefined ? e.size > 0 : e.has(lcid));
  }
  cellStatus(key: string, lcid: Lcid): CellStatus | undefined {
    return this.status.get(cell(key, lcid));
  }
  /** What the cell's change is measured against (its Change.before): the pending edit's base, else the server value. */
  before(key: string, lcid: Lcid): string {
    const b = this.isEdited(key, lcid) ? this.bases.get(cell(key, lcid)) : undefined;
    return b === null ? '' : (b ?? this.original(key, lcid));
  }
  /**
   * A pending edit whose server text changed since it was made (a reload brought other text): saving it is a conflict.
   * So is one made where its language had no label at all that now has one stored empty (bases: null).
   */
  moved(key: string, lcid: Lcid): boolean {
    if (!this.isEdited(key, lcid)) return false;
    if (this.bases.get(cell(key, lcid)) === null) return lcid in (this.slots.get(key)?.labels ?? {});
    return this.before(key, lcid) !== this.original(key, lcid);
  }
  /**
   * The base of a new edit: `b` (a text the edit was made on), else the server text now. null where that is '' for no
   * label at all on a label that keeps a '' stored apart from none (model.ts keepsEmpty): a language a label once had
   * stays (metadata labels can't be removed), so a '' given for one still missing was no label there either.
   */
  private baseOf(key: string, lcid: Lcid, b?: string | null): string | null {
    const s = this.slots.get(key);
    const t = b === undefined ? this.original(key, lcid) : b;
    return t === '' && !!s && keepsEmpty(s) && !(lcid in s.labels) ? null : t;
  }
  /**
   * A label's text as the stand-ins read it (model.ts TextOf): its current value (pending edit included), or with
   * `server` its server value; undefined while the label, or that language of it, isn't loaded.
   */
  text(key: string, lcid: Lcid, server = false): string | undefined {
    const s = this.slots.get(key);
    return !s || notLoaded(s, lcid) ? undefined : server ? this.original(key, lcid) : this.value(key, lcid);
  }
  /**
   * A server text read since the slot was loaded (one a stand-in is made of, which the saver reads again before writing
   * it, core/saver.ts): the slot's copy follows it, as a reload of that language would. A pending edit keeps its base,
   * so saving it is a conflict (moved()); one that now equals the server text is dropped, as add() does.
   */
  seen(key: string, lcid: Lcid, text: string): void {
    const s = this.slots.get(key);
    if (!s) return;
    this.cellAt.set(cell(key, lcid), this.tick());
    if ((s.labels[lcid] ?? '') === text) return;
    setServer(s, lcid, text);
    if (this.edits.get(key)?.get(lcid) === (s.labels[lcid] ?? '')) this.write(key, lcid, undefined);
    this.emit({ type: 'edit', key, lcid });
  }

  /**
   * What the pending edit of a cell is saved as when it empties a translation Dataverse can't remove (model.ts
   * standIn, the saver's rule, the texts as staged): its stand-in, or why it has none. Measured against the server text,
   * as the popup and the Workbench tell a removal. Undefined for any other cell.
   */
  standIn(key: string, lcid: Lcid, base: Lcid): StandIn | undefined {
    const s = this.slots.get(key);
    if (!s || !this.isEdited(key, lcid) || s.readOnly || isManaged(s)) return undefined;
    return standIn(s, lcid, base, this.original(key, lcid), this.value(key, lcid), (k, l) => this.text(k, l));
  }

  /**
   * A translation its language's users see empty on purpose (model.ts savesEmpty, a metadata description): stored
   * empty on the server and not changed (storedEmpty), or blank in a pending edit, which saving stores empty. It counts
   * as translated (the page's marks, the popup, the Workbench); a missing one (never translated) shows the base text.
   */
  emptyOnPurpose(key: string, lcid: Lcid, base: Lcid): boolean {
    const s = this.slots.get(key);
    if (!s || notLoaded(s, lcid) || !savesEmpty(s, lcid, base) || this.value(key, lcid).trim()) return false;
    return this.isEdited(key, lcid) || s.labels[lcid] === '';
  }

  /**
   * Sets a pending value. Setting it back to the server value removes the edit (and its base). A new edit
   * is measured against the server value now, or `base` when given (the server text it was really made
   * on, e.g. a restored snapshot); an edit typed again keeps its first base. While a reload has moved the
   * server text under an edit, typing the base text back keeps the edit pending on purpose: a cell typed
   * through it ("Nom2" → "Nom" → "Nom3") must not lose its base, and saving it is a conflict that shows
   * the user the other text.
   */
  set(key: string, lcid: Lcid, text: string, base?: string): void {
    const slot = this.slots.get(key);
    // Nothing is staged on a read-only label, nor on one from a managed solution that slipped through as editable.
    if (!slot || slot.readOnly || isManaged(slot)) return;
    const prev = this.edits.get(key)?.get(lcid);
    const server = slot.labels[lcid] ?? '';
    const next = text === server ? undefined : text;
    if (prev === next) return;
    const k = cell(key, lcid);
    const b = prev === undefined ? this.baseOf(key, lcid, base) : this.bases.has(k) ? (this.bases.get(k) as string | null) : server;
    this.apply({ key, lcid, from: prev, to: next, fromBase: prev === undefined ? undefined : b, toBase: next === undefined ? undefined : b });
  }

  /** Reverts one cell, or every language of a slot when `lcid` is omitted. */
  revert(key: string, lcid?: Lcid): void {
    const e = this.edits.get(key);
    if (!e) return;
    this.group(() => {
      for (const l of lcid === undefined ? [...e.keys()] : [lcid])
        if (e.has(l)) this.apply({ key, lcid: l, from: e.get(l), to: undefined, fromBase: this.bases.get(cell(key, l)) });
    });
  }

  /** Runs several set() calls as one undo step and one 'edits' event. */
  group(fn: () => void): void {
    if (this.batch) return fn();
    this.batch = [];
    try {
      fn();
    } finally {
      const ops = this.batch;
      this.batch = null;
      if (ops.length) {
        this.undoStack.push(ops);
        this.redoStack = [];
        this.emit({ type: 'edits' });
      }
    }
  }

  private apply(op: Op, record = true): void {
    this.write(op.key, op.lcid, op.to, op.toBase);
    this.status.delete(cell(op.key, op.lcid));
    if (!record) return;
    if (this.batch) this.batch.push(op);
    else {
      // Consecutive typing in the same cell collapses into one undo step.
      const last = this.undoStack[this.undoStack.length - 1];
      if (last && last.length === 1 && last[0].key === op.key && last[0].lcid === op.lcid && (last as Op[] & { t?: number }).t! > Date.now() - 1200) {
        last[0] = { ...last[0], to: op.to, toBase: op.toBase };
        if (last[0].from === last[0].to && last[0].fromBase === last[0].toBase) {
          // The run of typing cancelled itself (typed back to where it began): no step, so the next Ctrl+Z undoes the one before.
          this.undoStack.pop();
          this.redoStack = [];
          this.emit({ type: 'edit', key: op.key, lcid: op.lcid });
          return;
        }
      } else {
        const g = [op] as Op[] & { t?: number };
        this.undoStack.push(g);
      }
      (this.undoStack[this.undoStack.length - 1] as Op[] & { t?: number }).t = Date.now();
      if (this.undoStack.length > 500) this.undoStack.shift();
      this.redoStack = [];
      this.emit({ type: 'edit', key: op.key, lcid: op.lcid });
    }
  }

  /**
   * Sets or removes a pending edit and its base. A new edit gets `base` (else the server value now, baseOf); an edit
   * that already exists keeps its own.
   */
  private write(key: string, lcid: Lcid, v: string | undefined, base?: string | null): void {
    const k = cell(key, lcid);
    let e = this.edits.get(key);
    if (v === undefined) {
      e?.delete(lcid);
      if (e && !e.size) this.edits.delete(key);
      this.bases.delete(k);
    } else {
      if (!e) this.edits.set(key, (e = new Map()));
      if (!e.has(lcid) || !this.bases.has(k)) this.bases.set(k, this.baseOf(key, lcid, base));
      e.set(lcid, v);
    }
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  undo(): void {
    const ops = this.undoStack.pop();
    if (!ops) return;
    for (const op of [...ops].reverse()) this.write(op.key, op.lcid, op.from, op.fromBase);
    this.redoStack.push(ops);
    this.emitOps(ops);
  }
  redo(): void {
    const ops = this.redoStack.pop();
    if (!ops) return;
    for (const op of ops) this.write(op.key, op.lcid, op.to, op.toBase);
    this.undoStack.push(ops);
    this.emitOps(ops);
  }
  private emitOps(ops: Op[]): void {
    if (ops.length === 1) this.emit({ type: 'edit', key: ops[0].key, lcid: ops[0].lcid });
    else this.emit({ type: 'edits' });
  }

  /**
   * Every pending change, in slot order. `before` is the edit's base, not the server value a reload may have brought since;
   * one made where its language had no label at all on a label that keeps a '' apart from none says so (beforeMissing).
   */
  changes(filter?: (s: Slot) => boolean): Change[] {
    const out: Change[] = [];
    for (const [key, e] of this.edits) {
      const slot = this.slots.get(key);
      if (!slot || (filter && !filter(slot))) continue;
      for (const [lcid, after] of e) {
        const b = this.bases.get(cell(key, lcid));
        out.push({ slot, lcid, before: b === null ? '' : (b ?? slot.labels[lcid] ?? ''), after, ...(b === null ? { beforeMissing: true as const } : {}) });
      }
    }
    return out;
  }
  pendingCount(): number {
    let n = 0;
    for (const e of this.edits.values()) n += e.size;
    return n;
  }

  /**
   * Applies save results.
   * - saved / unchanged: `after` becomes the server value ('' when it is blank: that removed the
   *   translation). The pending edit is dropped only while the cell still holds that value (or, for a stand-in the
   *   saver wrote in place of an emptied translation, the blank text it stood in for: Change.standIn); text typed
   *   into the cell while the save was running stays pending, now measured against the value just saved.
   * - conflict: the edit (if any) stays and the cell shows the server value next to it (see resolve()),
   *   also when there is no edit (e.g. the undo of a past save), so the user sees what is on the server.
   * - error / skipped: the edit stays; the cell gets the message while it still holds the text that
   *   failed (once the user has typed something else, or there is no edit, it no longer describes it).
   */
  commit(results: ChangeResult[]): void {
    for (const r of results) {
      const { lcid, after } = r.change;
      const key = r.change.slot.key;
      const k = cell(key, lcid);
      const cur = this.edits.get(key)?.get(lcid);
      // The cell still holds the text this change was made from: the text written, or the blank one a stand-in replaced.
      const held = cur !== undefined && (cur === after || cur === r.change.standIn?.typed);
      if (r.outcome === 'saved' || r.outcome === 'unchanged') {
        // Saving a blank value removes the translation (ARCHITECTURE §4 "Clearing a translation": the
        // writers send '' or remove the label), so the server now holds '', whatever spaces were typed.
        const now = after.trim() ? after : '';
        // The slot may have been refreshed (a new object) while the save ran: update the store's copy,
        // and the one the change carries so views still holding it agree.
        const slot = this.slots.get(key);
        for (const s of new Set([slot, r.change.slot])) if (s) setServer(s, lcid, now);
        this.cellAt.set(k, this.tick()); // newer than any load still running: its answer never puts the old text back
        if (cur === undefined || held || cur === now) {
          this.write(key, lcid, undefined);
          // With the text saved: a later load that brings another text (someone else's) ends the "saved" check.
          this.status.set(k, { outcome: 'saved', server: now });
        } else {
          this.bases.set(k, now); // the newer edit was typed over the text just saved
          this.status.delete(k); // a newer edit is pending: show it as edited, not as saved
        }
      } else if (r.outcome === 'conflict' || held) {
        this.status.set(k, { outcome: r.outcome, message: r.message, server: r.server });
      } else {
        // No edit left to attach it to (e.g. the undo of a past save), or the cell changed meanwhile.
        this.status.delete(k);
      }
    }
    // Saved edits can no longer be undone locally (undo of a save goes through history), and the
    // remaining undo steps were recorded against the old server values.
    this.undoStack = [];
    this.redoStack = [];
    this.emit({ type: 'edits' });
    this.emit({ type: 'status' });
  }

  /**
   * Conflict resolution: accept the server value (drops the edit and its base) or keep mine (rebase the edit
   * on the server value, so the next save writes it over theirs; a newer server text is a conflict again).
   */
  resolve(key: string, lcid: Lcid, keepMine: boolean): void {
    const slot = this.slots.get(key);
    const k = cell(key, lcid);
    const st = this.status.get(k);
    if (!slot || !st || st.outcome !== 'conflict') return;
    setServer(slot, lcid, st.server ?? '');
    this.cellAt.set(k, this.tick());
    const mine = this.edits.get(key)?.get(lcid);
    if (!keepMine || mine === undefined || mine === (slot.labels[lcid] ?? '')) this.write(key, lcid, undefined);
    else this.bases.set(k, slot.labels[lcid] ?? '');
    this.status.delete(k);
    this.emit({ type: 'edit', key, lcid });
    this.emit({ type: 'status' });
  }

  setBusy(busy: boolean, label?: string): void {
    this.busy = busy;
    this.emit({ type: 'busy', busy, label });
  }

  /** Removes slots (and their edits) matching the predicate, e.g. when reloading a scope. */
  remove(pred: (s: Slot) => boolean): void {
    for (const [k, s] of this.slots)
      if (pred(s) && !this.edits.has(k)) {
        this.slots.delete(k);
        this.loadedAt.delete(k);
      }
    this.emit({ type: 'slots' });
  }
}
