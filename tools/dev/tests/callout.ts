// Unit tests for the popup (ui/callout.ts): its pure helpers (Undo snapshot, placeholders, amber, blocking
// problems, the duplicates checkbox, placement) and, against a tiny fake DOM, the popup itself: plain inputs
// for every shown language, staging, Done / Enter / Esc / click outside, Undo changes, Ctrl+Z / Ctrl+Y, the copies
// checkbox and the choices; also where the editor card (ui/editor.ts) puts the focus first. The fake globals are
// installed for each DOM test and removed after it.
import { MANAGED, MANAGED_OPEN, type Lcid, type Prop, type Slot } from '../../../src/core/model';
import { createSaver } from '../../../src/core/saver';
import { Store } from '../../../src/core/store';
import { BUILTIN_NOTE, describe } from '../../../src/inspector/describe';
import { Preview } from '../../../src/inspector/preview';
import type { Anchor } from '../../../src/inspector/scan';
import type { Callout, CalloutModel } from '../../../src/inspector/types';
import { alsoText, becomes, changedCells, focusKeys, isMissing, openCallout, placeCallout, placeholderOf, problem, restore, rowLangs, settle, shows, snapshot, writeAlso, type Box } from '../../../src/ui/callout';
import { createEditor } from '../../../src/ui/editor';
import type { AppApi } from '../../../src/ui/types';
import { bindUndo } from '../../../src/ui/undo';
import { El, withDom as withPage } from './fakedom';
import type { Kit } from './kit';

const EN = 1033;
const FR = 1036;
const DE = 1031;

const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height, right: left + width, bottom: top + height });

/** A slot as the loaders make them (`key = ${comp}|${prop}`). */
const S = (kind: Slot['kind'], comp: string, prop: Prop, labels: Record<number, string>, o: Partial<Slot> = {}): Slot => ({
  key: `${comp}|${prop}`,
  kind,
  prop,
  entity: 'acc',
  comp,
  group: comp,
  title: labels[EN] || '',
  path: [],
  sub: '',
  labels,
  readOnly: '',
  baseRequired: prop !== 'Description',
  max: 0,
  order: 0,
  ref: {},
  ...o,
});
const L1 = 'field|f|c1|Label';
const L2 = 'field|f|c2|Label';
const TIP = 'attribute|acc.name|Description';
const COL = 'attribute|acc.name|DisplayName';
const O1 = 'option|acc.kind|1|Label';
const O2 = 'option|acc.kind|2|Label';
/** A field placed twice on a form, its column (name and tooltip) and two choices. */
function fixture(): Store {
  const s = new Store();
  const cell = (id: string, labels: Record<number, string>, order: number) =>
    S('field', `field|f|${id}`, 'Label', labels, { ref: { formId: 'f', datafield: 'name', controlId: id === 'c1' ? 'name' : 'name1' }, order, max: 50 });
  s.add([
    cell('c1', { [EN]: 'Name', [FR]: 'Nom' }, 0),
    cell('c2', { [EN]: 'Name', [FR]: 'Nom' }, 1),
    S('attribute', 'attribute|acc.name', 'DisplayName', { [EN]: 'Name', [FR]: 'Nom' }, { ref: { entity: 'acc', attribute: 'name' } }),
    S('attribute', 'attribute|acc.name', 'Description', { [EN]: 'Type the name.' }, { ref: { entity: 'acc', attribute: 'name' } }),
    S('option', 'option|acc.kind|1', 'Label', { [EN]: 'Small', [FR]: 'Petit' }, { order: 0 }),
    S('option', 'option|acc.kind|2', 'Label', { [EN]: 'Large' }, { order: 1 }),
  ]);
  return s;
}
const fieldModel = (o: Partial<CalloutModel> = {}, also?: { keys: string[]; on: boolean }): CalloutModel => ({
  comp: 'field|f|c1',
  title: 'Name',
  kind: 'Field',
  icon: 'field',
  blocks: [{ key: L1, heading: 'Form label', long: false, ...(also ? { also } : {}) }, { key: TIP, heading: 'Tooltip', long: true }],
  loading: false,
  ...o,
});
/** A form field's blocks as describe() gives them (inspector/describe.ts field()): Column name, Tooltip, Form label. */
const FIELD_BLOCKS: CalloutModel['blocks'] = [
  { key: COL, heading: 'Column name', long: false },
  { key: TIP, heading: 'Tooltip', long: true },
  { key: L1, heading: 'Form label', long: false },
];
/** A main form's body cell of the name column as the loader makes it (sparse, never base-required: providers/formxml.ts). */
const MAIN = { formId: 'f', elId: 'c1', formType: 2, area: 'body', tag: 'cell', controlId: 'name', datafield: 'name', sparse: true };
/**
 * The name field of a main form, a save posting its Form label only where it changes it (providers/formxml.ts SPARSE): its
 * own label English "Full name", French "Nom" (`labels`), the column's names English "Name", French "Nom V4", its tooltip.
 */
function mainForm(labels: Record<number, string> = { [EN]: 'Full name', [FR]: 'Nom' }): Store {
  const s = new Store();
  s.add([
    S('field', 'field|f|c1', 'Label', labels, { baseRequired: false, ref: MAIN }),
    S('attribute', 'attribute|acc.name', 'DisplayName', { [EN]: 'Name', [FR]: 'Nom V4' }, { ref: { entity: 'acc', attribute: 'name' } }),
    S('attribute', 'attribute|acc.name', 'Description', { [EN]: 'Primary name' }, { ref: { entity: 'acc', attribute: 'name' } }),
  ]);
  return s;
}

// ---- a tiny DOM: just what the popup and its widgets use (the Publish dialog tests in savepath.ts use it too) ----

type Fn = (e: Ev) => void;
export interface Ev {
  type: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  timeStamp: number;
  defaultPrevented: boolean;
  composedPath(): unknown[];
  preventDefault(): void;
  /** Clicks: 1, 2 for the second click of a double-click, 0 from the keyboard. */
  detail?: number;
  target?: unknown;
  /** Keys: the physical key ('KeyZ'). */
  code?: string;
  /** beforeinput / input. */
  inputType?: string;
}

class FNode {
  parentNode: FEl | null = null;
  get parentElement(): FEl | null {
    return this.parentNode;
  }
  get isConnected(): boolean {
    for (let n: FNode | null = this; n; n = n.parentNode) if ((n as FEl).connected) return true;
    return false;
  }
  getRootNode(): FNode {
    let n: FNode = this;
    while (n.parentNode) n = n.parentNode;
    return n;
  }
  remove(): void {
    const p = this.parentNode;
    if (p) p.childNodes = p.childNodes.filter((c) => c !== this);
    this.parentNode = null;
  }
  replaceWith(n: FNode): void {
    const p = this.parentNode;
    if (!p) return;
    n.remove();
    p.childNodes = p.childNodes.map((c) => (c === this ? n : c));
    n.parentNode = p;
    this.parentNode = null;
  }
  get textContent(): string {
    return '';
  }
}
export class FText extends FNode {
  constructor(public data: string) {
    super();
  }
  override get textContent(): string {
    return this.data;
  }
}
export class FEl extends FNode {
  childNodes: FNode[] = [];
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  className = '';
  hidden = false;
  disabled = false;
  readOnly = false;
  checked = false;
  value = '';
  type = '';
  placeholder = '';
  spellcheck = false;
  title = '';
  selected = false;
  tabIndex: number;
  selectionStart = 0;
  selectionEnd = 0;
  scrollTop = 0;
  scrollHeight = 0;
  scrollWidth = 0;
  clientHeight = 0;
  clientWidth = 0;
  offsetHeight = 0;
  offsetWidth = 0;
  shadowRoot = null;
  /** The (shadow) root: always connected, holds the focus. */
  connected = false;
  activeElement: FEl | null = null;
  host: FEl | null = null;
  ls: Array<{ type: string; fn: Fn }> = [];
  /** `dataset.x` is the `data-x` attribute (one-word keys). */
  readonly dataset: Record<string, string> = new Proxy({} as Record<string, string>, {
    get: (_, k) => this.attrs[`data-${String(k)}`],
    set: (_, k, v) => ((this.attrs[`data-${String(k)}`] = String(v)), true),
  });
  constructor(public tagName: string) {
    super();
    this.tabIndex = /^(INPUT|BUTTON|TEXTAREA)$/.test(tagName) ? 0 : -1;
  }
  get id(): string {
    return this.attrs.id ?? '';
  }
  get children(): FEl[] {
    return this.childNodes.filter((c): c is FEl => c instanceof FEl);
  }
  get firstElementChild(): FEl | null {
    return this.children[0] ?? null;
  }
  get classList() {
    const has = (c: string) => this.className.split(/\s+/).includes(c);
    const set = (c: string, on: boolean) => {
      const cs = this.className.split(/\s+/).filter((x) => x && x !== c);
      this.className = (on ? [...cs, c] : cs).join(' ');
    };
    return { contains: has, add: (c: string) => set(c, true), remove: (c: string) => set(c, false), toggle: (c: string, on = !has(c)) => (set(c, on), on) };
  }
  override get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  override set textContent(v: string) {
    this.replaceChildren(new FText(v));
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k: string): void {
    delete this.attrs[k];
  }
  appendChild(c: FNode): FNode {
    // A DocumentFragment (document.createDocumentFragment) hands over its children.
    if (c instanceof FEl && c.tagName === '#FRAGMENT') {
      for (const x of [...c.childNodes]) this.appendChild(x);
      return c;
    }
    c.remove();
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  append(...cs: Array<FNode | string>): void {
    for (const c of cs) this.appendChild(typeof c === 'string' ? new FText(c) : c);
  }
  prepend(c: FNode): void {
    c.remove();
    c.parentNode = this;
    this.childNodes.unshift(c);
  }
  replaceChildren(...cs: FNode[]): void {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    for (const c of cs) this.appendChild(c);
  }
  contains(n: unknown): boolean {
    for (let x = n as FNode | null; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  addEventListener(type: string, fn: Fn): void {
    this.ls.push({ type, fn });
  }
  removeEventListener(type: string, fn: Fn): void {
    this.ls = this.ls.filter((l) => !(l.type === type && l.fn === fn));
  }
  focus(): void {
    const r = this.getRootNode() as FEl;
    if (r.connected) r.activeElement = this;
  }
  scrollIntoView(): void {}
  setSelectionRange(a: number, b: number): void {
    this.selectionStart = a;
    this.selectionEnd = b;
  }
  setRangeText(t: string, a: number, b: number): void {
    this.value = this.value.slice(0, a) + t + this.value.slice(b);
    this.selectionStart = this.selectionEnd = a + t.length;
  }
  dispatchEvent(e: { type: string }): boolean {
    fire(this, e.type, e as Partial<Ev>);
    return true;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  elementFromPoint(): null {
    return null;
  }
  matches(sel: string): boolean {
    return sel.split(',').some((part) => {
      const m = /^([a-z][a-z0-9-]*)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/.exec(part.trim());
      if (!m) return false;
      if (m[1] && m[1].toUpperCase() !== this.tagName) return false;
      if (m[2] && !m[2].slice(1).split('.').every((c) => this.classList.contains(c))) return false;
      for (const a of m[3].match(/\[[^\]]+\]/g) || []) {
        const [, k, op, v] = /^\[([\w-]+)(?:(\^?=)"?([^"]*)"?)?\]$/.exec(a) || [];
        const got = this.getAttribute(k);
        if (got === null || (op === '=' && got !== v) || (op === '^=' && !got.startsWith(v))) return false;
      }
      return true;
    });
  }
  /** Compound selectors, a comma list of them, and descendant chains ('.co-f .btn.primary'). */
  querySelectorAll(sel: string): FEl[] {
    const chains = sel.split(',').map((p) => p.trim().split(/\s+/));
    const fits = (c: FEl) =>
      chains.some((ch) => {
        if (!c.matches(ch[ch.length - 1])) return false;
        let i = ch.length - 2;
        for (let a = c.parentNode; a && i >= 0; a = a.parentNode) if (a.matches(ch[i])) i--;
        return i < 0;
      });
    const out: FEl[] = [];
    const walk = (n: FEl) => {
      for (const c of n.children) {
        if (fits(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): FEl | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

export const dom = { root: null as unknown as FEl, layer: null as unknown as FEl, doc: [] as Array<{ type: string; fn: Fn }> };
const GLOBALS = ['document', 'HTMLElement', 'HTMLTextAreaElement', 'DOMRect', 'InputEvent', 'requestAnimationFrame', 'addEventListener', 'removeEventListener', 'innerWidth', 'innerHeight'];

export function install(): () => void {
  const saved = GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  const set = (k: string, v: unknown) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  dom.root = new FEl('#ROOT');
  dom.root.connected = true;
  dom.root.host = new FEl('DIV');
  dom.layer = new FEl('DIV');
  dom.root.appendChild(dom.layer);
  dom.doc = [];
  set('document', {
    body: new FEl('BODY'),
    activeElement: null,
    createElement: (t: string) => new FEl(t.toUpperCase()),
    createElementNS: (_: string, t: string) => new FEl(t.toUpperCase()),
    createTextNode: (v: string) => new FText(v),
    createDocumentFragment: () => new FEl('#FRAGMENT'),
    addEventListener: (type: string, fn: Fn) => dom.doc.push({ type, fn }),
    removeEventListener: (type: string, fn: Fn) => (dom.doc = dom.doc.filter((l) => !(l.type === type && l.fn === fn))),
  });
  set('HTMLElement', FEl);
  // The editor card tells a textarea apart by its class: none here (it grows by itself).
  set('HTMLTextAreaElement', class {});
  set('DOMRect', class {
    constructor(public left: number, public top: number, public width: number, public height: number) {}
  });
  set('InputEvent', class {
    constructor(public type: string, o: object = {}) {
      Object.assign(this, o);
    }
  });
  set('requestAnimationFrame', () => 1);
  set('addEventListener', () => {});
  set('removeEventListener', () => {});
  set('innerWidth', 1000);
  set('innerHeight', 800);
  return () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
}

/** Dispatches an event from `target` up through its ancestors (bubbling). */
export function fire(target: FEl, type: string, o: Partial<Ev> = {}): Ev {
  const path: FNode[] = [];
  for (let n: FNode | null = target; n; n = n.parentNode) path.push(n);
  const e: Ev = {
    type,
    key: '',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    timeStamp: performance.now() + 1000,
    defaultPrevented: false,
    composedPath: () => path,
    preventDefault() {
      e.defaultPrevented = true;
    },
    ...o,
  };
  for (const n of path) if (n instanceof FEl) for (const l of [...n.ls]) if (l.type === type) l.fn(e);
  return e;
}

/** Types `text` at the caret as a keyboard does: beforeinput, the change, input (the events ui/undo.ts records). */
export function typeIn(i: FEl, text: string): void {
  for (const ch of text) {
    fire(i, 'beforeinput', { inputType: 'insertText' });
    const s = i.selectionStart;
    i.value = i.value.slice(0, s) + ch + i.value.slice(i.selectionEnd);
    i.selectionStart = i.selectionEnd = s + ch.length;
    fire(i, 'input', { inputType: 'insertText' });
  }
}
/** bindUndo on the fake app layer, as app.ts installs it (translation mode's page keys aside); returns the uninstaller. */
const undoOn = (store: Store) => bindUndo(dom.layer as never, { store, dialog: () => false, page: () => false }, { win: new FEl('#WINDOW') as never, doc: document as never });

interface Env {
  store: Store;
  app: AppApi;
  co: Callout;
  el: FEl;
  closed: number;
  acted: number;
  /** The input of a cell. */
  inp(key: string, l: Lcid): FEl;
  /** Types a whole new value into a cell's input. */
  type(key: string, l: Lcid, v: string): void;
  keys(): string[];
  focused(): FEl | null;
  /** The footer's buttons and links that are shown. */
  foot(): string[];
}

function open(
  store: Store,
  model: CalloutModel | (() => CalloutModel),
  o: { focusKey?: string; focusLcid?: Lcid; prefs?: Record<string, unknown>; user?: Lcid; rect?: () => Box | null; beside?: () => Box | null; act?: (env: Env) => boolean; refocus?: () => boolean } = {},
): Env {
  const app = {
    store,
    ctx: { base: EN, user: o.user ?? EN, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }, { lcid: DE, name: 'German', isBase: false }] },
    prefs: { target: FR, shown: [], showNames: false, dock: 'right', ...o.prefs },
    adoptStyles() {},
    root: dom.root,
    layer: dom.layer,
    toast() {},
  } as unknown as AppApi;
  const env = {} as Env;
  env.closed = 0;
  env.acted = 0;
  env.store = store;
  env.app = app;
  env.co = openCallout(app, {
    model: () => (typeof model === 'function' ? model() : model),
    rect: () => (o.rect?.() ?? null) as DOMRect | null,
    ...(o.beside ? { beside: o.beside as () => DOMRect | null } : {}),
    focusKey: o.focusKey,
    focusLcid: o.focusLcid,
    action: () => (env.acted++, o.act ? o.act(env) : true),
    close: () => void env.closed++,
    ...(o.refocus ? { refocus: o.refocus } : {}),
  });
  env.el = env.co.el as unknown as FEl;
  env.inp = (key, l) => env.el.querySelectorAll('[data-k]').find((x) => x.getAttribute('data-k') === `${key}#${l}`)!;
  env.type = (key, l, v) => {
    const i = env.inp(key, l);
    i.value = v;
    fire(i, 'input');
  };
  env.keys = () => env.el.querySelectorAll('[data-k]').map((x) => x.getAttribute('data-k')!);
  env.focused = () => dom.root.activeElement;
  env.foot = () => env.el.querySelector('.co-f')!.querySelectorAll('button').filter((b) => !b.hidden).map((b) => b.textContent);
  return env;
}
/** Runs a test body with the fake DOM installed. */
const withDom = (fn: () => void) => () => {
  const off = install();
  try {
    fn();
  } finally {
    off();
  }
};

export function register(t: Kit): void {
  const { test, eq, ok } = t;

  // ---- Undo changes: snapshot and restore ----
  test('callout: Undo changes restores every cell exactly (earlier staged edits kept, new ones dropped) in one undo step', () => {
    const s = fixture();
    s.set(L1, FR, 'Pending'); // staged before the popup opened
    const snap = snapshot(s, [L1, L2], [EN, FR]);
    eq(snap.get(`${L1}#1036`), { key: L1, lcid: FR, value: 'Pending', pending: 'Pending', base: 'Nom' });
    eq(snap.get(`${L2}#1036`), { key: L2, lcid: FR, value: 'Nom', pending: undefined });
    s.set(L1, FR, 'Typed');
    s.set(L2, FR, 'Nom 2');
    s.set(L1, EN, 'Name!');
    eq(changedCells(s, snap.values()), [`${L1}#1033`, `${L1}#1036`, `${L2}#1036`]);
    let events = 0;
    const off = s.on(() => events++);
    eq(restore(s, snap.values()), 3);
    off();
    eq(events, 1, 'one store event');
    eq(s.value(L1, FR), 'Pending');
    ok(s.isEdited(L1, FR), 'the earlier staged edit is still staged');
    ok(!s.isEdited(L2) && !s.isEdited(L1, EN), 'new edits dropped');
    eq(changedCells(s, snap.values()), []);
    s.undo(); // one step brings the typed values back
    eq([s.value(L1, FR), s.value(L2, FR), s.value(L1, EN)], ['Typed', 'Nom 2', 'Name!']);
  });
  test('callout: Undo changes brings an edit back on its own base, so a reload that moved the server text is still a conflict', () => {
    const s = fixture();
    s.set(L1, FR, 'Mine'); // staged on 'Nom'
    const snap = snapshot(s, [L1], [FR]);
    eq(snap.get(`${L1}#1036`)!.base, 'Nom');
    s.add([{ ...s.get(L1)!, labels: { [EN]: 'Name', [FR]: 'Theirs' } }]); // another maker's text, reloaded
    eq(s.before(L1, FR), 'Nom', 'the reload keeps the base');
    s.set(L1, FR, 'Theirs'); // typed to the server text: the edit and its base are dropped
    ok(!s.isEdited(L1, FR));
    s.set(L1, FR, 'Other'); // a new edit, measured against 'Theirs'
    eq(s.before(L1, FR), 'Theirs');
    eq(restore(s, snap.values()), 1);
    eq(s.value(L1, FR), 'Mine');
    eq(s.before(L1, FR), 'Nom', 'the recorded edit comes back on its recorded base');
    ok(s.moved(L1, FR), 'its server text moved: saving it is a conflict');
    eq(s.changes().map((c) => [c.before, c.after]), [['Nom', 'Mine']]);
    s.revert(L1, FR);
    eq(restore(s, snap.values()), 1, 'also after a revert');
    eq(s.before(L1, FR), 'Nom');
  });
  test("callout: Undo changes brings back an edit made where a tooltip had no text at all in its language as made on none, so a '' someone stored there since is still a conflict at save, cleared and typed again or not; one made over a '' stored then stays measured against it", () => {
    const s = fixture();
    s.set(TIP, FR, 'Brouillon'); // staged where the tooltip had no French at all
    const snap = snapshot(s, [TIP], [FR]);
    eq(snap.get(`${TIP}#1036`)!.base, null);
    s.add([{ ...s.get(TIP)!, labels: { [EN]: 'Type the name.', [FR]: '' } }]); // someone saved it empty: reloaded
    ok(s.moved(TIP, FR));
    const now = () => [s.value(TIP, FR), s.moved(TIP, FR), s.changes().map((c) => [c.before, c.after, c.beforeMissing ?? null])];
    for (const retyped of [false, true]) {
      s.set(TIP, FR, ''); // cleared in the popup: the edit and its base are gone
      if (retyped) s.set(TIP, FR, 'Autre');
      eq(restore(s, snap.values()), 1);
      eq(now(), ['Brouillon', true, [['', 'Brouillon', true]]], retyped ? 'cleared, typed again' : 'cleared');
    }
    // Made over the '' stored: brought back measured against it, which nothing changed since.
    s.revert(TIP, FR);
    s.set(TIP, FR, 'Mien');
    const over = snapshot(s, [TIP], [FR]);
    eq(over.get(`${TIP}#1036`)!.base, '');
    s.set(TIP, FR, '');
    eq(restore(s, over.values()), 1);
    eq(now(), ['Mien', false, [['', 'Mien', null]]]);
  });
  test('callout: server values that change underneath are not changes made here; a cell shown later keeps its first state', () => {
    const s = fixture();
    const snap = snapshot(s, [L1, 'zz'], [FR]);
    eq([...snap.keys()], [`${L1}#1036`], 'unknown keys skipped');
    s.add([{ ...s.get(L1)!, labels: { [EN]: 'Name', [FR]: 'Nom (server)' } }]);
    eq(changedCells(s, snap.values()), [], 'a reload is not typed here');
    eq(restore(s, snap.values()), 0);
    s.set(L1, FR, 'X');
    snapshot(s, [L1, L2], [FR], snap);
    eq(snap.get(`${L1}#1036`)!.value, 'Nom', 'first state kept');
    eq([...snap.keys()], [`${L1}#1036`, `${L2}#1036`]);
  });

  // ---- rows, placeholders, amber, problems ----
  test('callout: rows are the base language, then the target, then the other shown languages', () => {
    eq(rowLangs([EN, DE, FR, 1040], EN, FR, []), [EN, FR]);
    eq(rowLangs([EN, DE, FR, 1040], EN, FR, [1040, DE, FR]), [EN, FR, DE, 1040]);
    eq(rowLangs([EN, FR], EN, EN, [FR]), [EN, FR], 'translating into the base language');
  });
  test('callout: an empty input shows what users of that language see now, or "No French tooltip"', () => {
    const s = fixture();
    const f = { ...s.get(L1)!, labels: { [EN]: 'Priority form EN only' } };
    s.add([f]);
    eq(shows(s, f, FR, EN), 'Nom', "a field label falls back to the column's French name (LIVE-FINDINGS 42)");
    eq(placeholderOf(s, f, FR, EN, 'Label', 'French'), 'Shows “Nom”');
    // No German column name: the column's English name, as Dynamics shows it and as an emptied label is saved
    // (model.ts standIn), not the form label's own English text.
    eq(placeholderOf(s, f, DE, EN, 'Label', 'German'), 'Shows “Name”', "no German column name: the column's English name");
    s.add([{ ...s.get(COL)!, labels: {} }]);
    eq(placeholderOf(s, f, DE, EN, 'Label', 'German'), 'Shows “Priority form EN only”', 'a column with no name at all: the base text');
    s.add([{ ...s.get(COL)!, labels: { [EN]: 'Name', [FR]: 'Nom' } }]);
    s.add([{ ...f, labels: {} }]);
    eq(placeholderOf(s, s.get(L1)!, EN, EN, 'Label', 'English'), 'Shows “Name”', 'no label of its own: the column name');
    const v = S('view', 'view|v', 'Name', { [EN]: 'Active accounts' });
    s.add([v, S('view', 'view|w', 'Name', {})]);
    eq(placeholderOf(s, v, FR, EN, 'Name', 'French'), 'Shows “Active accounts”');
    eq(placeholderOf(s, s.get('view|w|Name')!, FR, EN, 'Name', 'French'), '');
    // A column's tooltip with no French one: French users see the English one (LIVE-FINDINGS 32), which it says. Stored
    // empty, they see none: "No French tooltip" (model.ts storedEmpty). The base language keeps its own words.
    eq(placeholderOf(s, s.get(TIP)!, FR, EN, 'Tooltip', 'French'), 'Shows “Type the name.”');
    s.add([{ ...s.get(TIP)!, labels: { [EN]: 'Type the name.', [FR]: '' } }]);
    eq(placeholderOf(s, s.get(TIP)!, FR, EN, 'Tooltip', 'French'), 'No French tooltip');
    eq(placeholderOf(s, s.get(TIP)!, EN, EN, 'Tooltip', 'English'), 'No English tooltip');
    // No English tooltip either: nothing shows, so none.
    s.add([{ ...s.get(TIP)!, labels: {} }]);
    eq(placeholderOf(s, s.get(TIP)!, FR, EN, 'Tooltip', 'French'), 'No French tooltip');
    // A view's description (a record's, removed when emptied): the words it had.
    s.add([S('view', 'view|v', 'Description', { [EN]: 'All active accounts' })]);
    eq(placeholderOf(s, s.get('view|v|Description')!, FR, EN, 'Description', 'French'), 'No French description');
  });
  test("preview: a form label shows what the popup says: emptied where Dataverse can't remove it, its stand-in (the column's French name, else its English name); with no French text of its own, its column's name, else the column's English name, never the form label's English text", () => {
    const s = fixture();
    s.add([{ ...s.get(L1)!, labels: { [EN]: 'Customer', [FR]: 'Client' } }, { ...s.get(L2)!, labels: { [EN]: 'Customer' } }, { ...s.get(COL)!, labels: { [EN]: 'Account Name', [FR]: 'Nom du compte' } }]);
    const app = { store: s, ctx: { base: EN, user: FR } } as unknown as AppApi;
    const p = new Preview(app, (fn) => fn());
    const label = (text: string) => Object.assign(new El('label', {}, text), { isConnected: true });
    // The page in French: the first copy shows its own French label, the second its column's English name (no
    // French label of its own, and the column has none yet).
    const one = label('Client');
    const two = label('Account Name');
    const page = new El('div').add(one, two);
    s.add([{ ...s.get(COL)!, labels: { [EN]: 'Account Name' } }]);
    const apply = () => withPage(page, () => p.apply([{ key: L1, el: one }, { key: L2, el: two }] as unknown as Anchor[]));
    s.set(COL, FR, 'Nom du compte');
    s.set(L1, FR, '');
    apply();
    eq([one.node.nodeValue, two.node.nodeValue], ['Nom du compte', 'Nom du compte'], "the column's French name as staged, in both");
    eq(becomes(s, s.get(L1)!, FR, EN), "Becomes “Nom du compte”: Dataverse can't remove a translation here, so French gets the column's French name.");
    // The column's French name emptied too: its English name, as the popup says, never the label's own “Customer”.
    s.set(COL, FR, '');
    apply();
    eq([one.node.nodeValue, two.node.nodeValue, becomes(s, s.get(L1)!, FR, EN)], ['Account Name', 'Account Name', "Becomes “Account Name”: Dataverse can't remove a translation here, so French gets the column's English name."]);
    eq([shows(s, s.get(L2)!, FR, EN), placeholderOf(s, s.get(L2)!, FR, EN, 'Label', 'French')], ['Account Name', 'Shows “Account Name”'], 'the popup and the page name the same text');
  });
  test("preview: a form label the page shows with another text than the one loaded (published, while a text saved since isn't) changes as it is typed: the text its node showed when the label was found (Anchor.orig) is swapped too, only on that label's own nodes, and put back by restore(); without it, as before, nothing is swapped", () => {
    // Loaded: "Full name" (the unpublished text); the page shows the published "Request title".
    const s = mainForm();
    const p = new Preview({ store: s, ctx: { base: EN, user: EN } } as unknown as AppApi, (fn) => fn());
    const el = Object.assign(new El('label', {}, 'Request title'), { isConnected: true });
    const other = Object.assign(new El('span', {}, 'Request title'), { isConnected: true });
    const page = new El('div').add(el, other);
    const apply = (orig?: string) => withPage(page, () => p.apply([{ key: L1, el, text: el.node, ...(orig ? { orig } : {}) }] as unknown as Anchor[]));
    s.set(L1, EN, 'Request titles');
    apply();
    eq(el.node.nodeValue, 'Request title', 'without the text it showed: not swapped');
    apply('Request title');
    eq([el.node.nodeValue, other.node.nodeValue], ['Request titles', 'Request title'], "typed: swapped, never another label's node");
    s.set(L1, EN, 'Request titles 2');
    apply('Request title');
    eq(el.node.nodeValue, 'Request titles 2', 'typed on');
    p.restore();
    eq(el.node.nodeValue, 'Request title', 'put back');
  });
  test("preview: a related menu item whose node shows none of its own texts (a built-in item the form renames in English only shows the language pack's French text, LIVE-FINDINGS 63, 80) is never swapped, whatever is staged; one that shows its own title changes as it is typed and is put back once undone, and by restore(), as before", () => {
    const s = new Store();
    const nav = (id: string, labels: Record<number, string>, relationship: string) =>
      S('navitem', `navitem|f|${id}`, 'Label', labels, { baseRequired: false, ref: { formId: 'f', elId: id, area: 'nav', relationship } });
    const audit = nav('navaudit', { [EN]: 'Audit Trail' }, 'hardcoded_{B7196B13-6B9D-42CD-BD58-B19A3953126F}navAudit');
    const contacts = nav('nav_contacts', { [EN]: 'Contacts', [FR]: 'Contacts (FR)' }, 'contact_customer_accounts');
    s.add([audit, contacts]);
    const p = new Preview({ store: s, ctx: { base: EN, user: FR } } as unknown as AppApi, (fn) => fn());
    const node = (text: string) => Object.assign(new El('span', {}, text), { isConnected: true });
    const [a, c] = [node('Historique d’audit'), node('Contacts (FR)')];
    const page = new El('div').add(a, c);
    // As the scanner anchors them: each with the text its node showed when found (Anchor.orig).
    const apply = () => withPage(page, () => p.apply([{ key: audit.key, el: a, text: a.node, orig: 'Historique d’audit' }, { key: contacts.key, el: c, text: c.node, orig: 'Contacts (FR)' }] as unknown as Anchor[]));
    const shown = () => [a.node.nodeValue, c.node.nodeValue];
    s.set(contacts.key, FR, 'Contacts liés');
    apply();
    eq(shown(), ['Historique d’audit', 'Contacts liés'], 'a French edit staged: the item showing its own title is swapped, never the language-pack text');
    s.revert(contacts.key, FR);
    apply();
    eq(shown(), ['Historique d’audit', 'Contacts (FR)'], 'undone: put back');
    s.set(contacts.key, FR, 'Contacts 2');
    s.set(audit.key, EN, 'Audit');
    apply();
    eq(shown(), ['Historique d’audit', 'Contacts 2'], 'its English title edited: the French page text is still not its own');
    p.restore();
    eq(shown(), ['Historique d’audit', 'Contacts (FR)'], 'restored');
  });
  test('preview: an emptied form label of a main form shows its column\'s name on the page, in the base language too', () => {
    const page = (user: Lcid, text: string) => {
      const s = mainForm();
      const p = new Preview({ store: s, ctx: { base: EN, user } } as unknown as AppApi, (fn) => fn());
      const el = Object.assign(new El('label', {}, text), { isConnected: true });
      return { s, el, apply: () => withPage(new El('div').add(el), () => p.apply([{ key: L1, el }] as unknown as Anchor[])) };
    };
    // English: its own label "Full name" emptied shows the column's English name through its column fallback (nothing
    // stands in for the base language), as the popup's placeholder says.
    const en = page(EN, 'Full name');
    en.s.set(L1, EN, '');
    en.apply();
    eq([en.el.node.nodeValue, placeholderOf(en.s, en.s.get(L1)!, EN, EN, 'Form label', 'English')], ['Name', 'Shows “Name”']);
    // The column renamed in the same edits: the name as staged, which the label then follows.
    en.s.set(COL, EN, 'Account name');
    en.apply();
    eq(en.el.node.nodeValue, 'Account name');
    // French: the column's French name; with none, its English name.
    const fr = page(FR, 'Nom');
    fr.s.set(L1, FR, '');
    fr.apply();
    eq(fr.el.node.nodeValue, 'Nom V4');
    fr.s.set(COL, FR, '');
    fr.apply();
    eq(fr.el.node.nodeValue, 'Name');
  });
  test("preview: spaces alone typed in a label show what it shows emptied (saved, they are a blank), never the page's text: a main form's field label its column's name, a view's French name its English one", () => {
    for (const [user, text, emptied] of [
      [FR, 'Nom', 'Nom V4'],
      [EN, 'Full name', 'Name'],
    ] as const) {
      const s = mainForm();
      const p = new Preview({ store: s, ctx: { base: EN, user } } as unknown as AppApi, (fn) => fn());
      const el = Object.assign(new El('label', {}, text), { isConnected: true });
      const apply = () => withPage(new El('div').add(el), () => p.apply([{ key: L1, el }] as unknown as Anchor[]));
      s.set(L1, user, '   ');
      apply();
      eq(el.node.nodeValue, emptied, `spaces, ${user}`);
      s.set(L1, user, '');
      apply();
      eq(el.node.nodeValue, emptied, `emptied, ${user}`);
      s.set(L1, user, '  Nouveau  ');
      apply();
      eq(el.node.nodeValue, 'Nouveau', `a text between spaces, ${user}`);
    }
    // A record's label: emptied, its French text is removed and the page shows its English one.
    const s = new Store();
    s.add([S('view', 'view|v', 'Name', { [EN]: 'Active accounts', [FR]: 'Comptes actifs' })]);
    const p = new Preview({ store: s, ctx: { base: EN, user: FR } } as unknown as AppApi, (fn) => fn());
    const el = Object.assign(new El('span', {}, 'Comptes actifs'), { isConnected: true });
    s.set('view|v|Name', FR, '   ');
    withPage(new El('div').add(el), () => p.apply([{ key: 'view|v|Name', el }] as unknown as Anchor[]));
    eq(el.node.nodeValue, 'Active accounts');
  });
  test('callout: amber only where the translation is empty and the base text is not (a cell worded like its column is translated)', () => {
    const s = fixture();
    const slot = () => s.get(L2)!;
    s.add([{ ...slot(), labels: { [EN]: 'Name' } }]);
    ok(!isMissing(s, slot(), FR, EN), "worded like the column: French users see the column's French name");
    s.add([{ ...s.get(COL)!, labels: { [EN]: 'Name' } }]);
    ok(isMissing(s, slot(), FR, EN), 'the column has no French name either: French users see English');
    s.add([{ ...slot(), labels: { [EN]: 'Customer name' } }]);
    ok(isMissing(s, slot(), FR, EN), 'worded differently: still to translate');
    ok(!isMissing(s, slot(), EN, EN), 'never the base language');
    s.set(L2, FR, 'Nom du client');
    ok(!isMissing(s, slot(), FR, EN));
    ok(!isMissing(s, s.get(O2)!, EN, EN) && isMissing(s, s.get(O2)!, FR, EN));
    ok(!isMissing(s, { ...s.get(O2)!, readOnly: 'Managed' }, FR, EN), 'read-only: no amber');
  });
  test('callout: blocking problems only, in three words', () => {
    const s = fixture();
    const p = (k: string, l: Lcid) => problem(s, s.get(k)!, l, EN);
    eq(p(L1, FR), '', 'not changed');
    s.set(L1, FR, '');
    eq(p(L1, FR), '', "a field label translation Dataverse can't remove: saved as its column's French name, no problem");
    s.set(L1, FR, 'x'.repeat(51));
    eq(p(L1, FR), 'Too long (max 50)');
    s.set(L1, EN, ' ');
    eq(p(L1, EN), "Can't be empty", 'the base label is required');
    s.set(TIP, EN, '');
    eq(p(TIP, EN), '', 'a description may be empty');
    s.set(O2, FR, '  ');
    eq(p(O2, FR), "Can't be empty", 'only spaces would be stored and show blank');
    const v = S('view', 'view|v', 'Name', { [EN]: 'Active', [FR]: 'Actifs' });
    s.add([v]);
    s.set(v.key, FR, '');
    eq(p(v.key, FR), '', 'removing a translation that can be removed is fine');
    s.add([{ ...s.get(L2)!, readOnly: '' }]);
    s.set(L2, FR, 'Nom 2');
    s.add([{ ...s.get(L2)!, readOnly: 'Managed' }]);
    eq(p(L2, FR), 'Read-only');
  });
  test("callout: a translation emptied where Dataverse can't remove it becomes its stand-in, said under its input: a form field label its column's name in that language (else its English name), anything else its English text; refused only where none is known", () => {
    const s = fixture();
    const b = (k: string, l: Lcid) => becomes(s, s.get(k)!, l, EN);
    eq([b(L1, FR), b(O1, FR)], ['', ''], 'not changed');
    s.set(L1, FR, '');
    s.set(O1, FR, ' ');
    // Worded like its column's French name already: saving it changes nothing, and it says so.
    eq(b(L1, FR), "Already the column's French name: Dataverse can't remove a translation here, so nothing changes.");
    eq(b(O1, FR), "Becomes “Small”: Dataverse can't remove a translation here, so French gets the English text.", 'only spaces count as emptied');
    eq([problem(s, s.get(L1)!, FR, EN), problem(s, s.get(O1)!, FR, EN)], ['', '']);
    // The texts as staged: the column's French name typed in the popup too, or emptied too (then its English name).
    s.set(COL, FR, 'Nom du compte');
    eq(b(L1, FR), "Becomes “Nom du compte”: Dataverse can't remove a translation here, so French gets the column's French name.");
    s.set(COL, FR, '');
    eq(b(L1, FR), "Becomes “Name”: Dataverse can't remove a translation here, so French gets the column's English name.");
    eq(b(COL, FR), "Becomes “Name”: Dataverse can't remove a translation here, so French gets the English text.", 'the column name itself: its English text');
    s.set(O1, EN, 'Tiny');
    eq(b(O1, FR), "Becomes “Tiny”: Dataverse can't remove a translation here, so French gets the English text.", 'the English text as staged');
    // The base language keeps its own rules: nothing stands in for it.
    s.set(O1, EN, '');
    eq([b(O1, EN), problem(s, s.get(O1)!, EN, EN)], ['', "Can't be empty"]);
    // Nothing known to stand in: the English text empty, the column's names not loaded. Refused, saying why.
    eq([b(O1, FR), problem(s, s.get(O1)!, FR, EN)], ['', "Dataverse can't remove this translation, and its English text is empty: type the text instead."]);
    s.slots.delete(COL);
    eq([b(L1, FR), problem(s, s.get(L1)!, FR, EN)], ['', "Dataverse can't remove this translation, and its column's names aren't loaded: load its table's columns to put the column's name in its place, or type the text."]);
    // A translation Dataverse can remove is removed, as before; the base language, read-only and unchanged texts say nothing.
    const v = S('view', 'view|v', 'Name', { [EN]: 'Active', [FR]: 'Actifs' });
    s.add([v]);
    s.set(v.key, FR, '');
    eq([b(v.key, FR), problem(s, v, FR, EN)], ['', '']);
  });
  test('callout: the copies checkbox writes the same text to the copies, never to a read-only or not-loaded one', () => {
    const s = fixture();
    s.add([S('field', 'field|f|c3', 'Label', { [EN]: 'Name' }, { readOnly: 'Managed' }), S('field', 'field|f|c4', 'Label', { [EN]: 'Name' }, { ref: { partial: [EN] } })]);
    writeAlso(s, [L2, 'field|f|c3|Label', 'field|f|c4|Label', 'nope'], FR, 'Nom 2', EN);
    eq([s.value(L2, FR), s.isEdited('field|f|c3|Label'), s.isEdited('field|f|c4|Label')], ['Nom 2', false, false]);
    eq([alsoText(1), alsoText(3)], ['Also change the other copy of this field on this form', 'Also change the 3 other copies of this field on this form']);
  });
  test('callout: the copies checkbox never writes a copy on a form from a managed solution, even one that slipped through as editable', () => {
    const s = fixture();
    const copy = S('field', 'field|f|c3', 'Label', { [EN]: 'Name' }, { ref: { formId: 'f', datafield: 'name', controlId: 'name2', managed: true } });
    s.add([copy]);
    eq(s.get(copy.key)!.readOnly, MANAGED, 'read-only as the store takes it');
    writeAlso(s, [L2, copy.key], FR, 'Nom 2', EN);
    eq([s.value(L2, FR), s.isEdited(copy.key)], ['Nom 2', false]);
    // Its slot's reason taken away (a slot made elsewhere): still never staged.
    s.slots.set(copy.key, { ...copy, readOnly: '' });
    writeAlso(s, [copy.key], FR, 'Nom 3', EN);
    s.set(copy.key, FR, 'Nom 3');
    eq(s.isEdited(copy.key), false);
  });

  // ---- the popup ----
  test(
    'callout: one plain input per shown language, the base language first and editable; no suggestions, no device translation, no Edit link',
    withDom(() => {
      const e = open(fixture(), fieldModel());
      eq(e.keys(), [`${L1}#1033`, `${L1}#1036`, `${TIP}#1033`, `${TIP}#1036`]);
      const base = e.inp(L1, EN);
      eq([base.tagName, base.disabled, base.value, base.getAttribute('aria-label')], ['INPUT', false, 'Name', 'Form label, English']);
      eq(e.inp(TIP, FR).tagName, 'TEXTAREA', 'a tooltip is multi-line');
      eq(e.foot(), ['Done'], 'Undo changes only once something changed');
      e.type(L1, EN, 'Full name');
      eq([e.store.value(L1, EN), e.store.isEdited(L1, EN)], ['Full name', true], 'typing in English stages it');
      const text = e.el.textContent;
      for (const no of ['Translate on device', 'Used', 'Edit', 'Save', 'Cancel', 'Not loaded', 'Changes this', 'More texts', 'Preview', ' of '])
        ok(!text.includes(no), `no "${no}"`);
      for (const cls of ['sugs', 'sg', 'co-mt', 'co-sc', 'co-help', 'co-nav', 'co-q', 'note']) eq(e.el.querySelectorAll('.' + cls).length, 0, cls);
      eq(e.el.querySelector('.co-k')!.textContent, 'Field');
      eq(e.el.querySelector('.co-t')!.textContent, 'Name');
      eq(e.foot(), ['Undo changes', 'Done']);
      // The other shown languages come after the target.
      const g = open(fixture(), fieldModel(), { prefs: { shown: [DE] } });
      eq(g.keys().slice(0, 3), [`${L1}#1033`, `${L1}#1036`, `${L1}#1031`]);
    }),
  );

  test(
    'callout: the clicked text in the language the page is shown in has the focus (not the target language), the caret at the end of its text; else the first input that takes typing; focusKey / focusLcid win; Tab order unchanged',
    withDom(() => {
      const doc = document as unknown as { documentElement?: { lang: string } };
      const at = (e: Env) => [e.focused()?.getAttribute('data-k'), e.focused()?.selectionStart, e.focused()?.selectionEnd];
      // The page in English (its <html lang>), translating to French: the English text, not the French one.
      doc.documentElement = { lang: 'en-US' };
      eq(at(open(fixture(), fieldModel())), [`${L1}#1033`, 4, 4], 'English: “Name|”');
      // The page in French: the French text. <html lang> says what is on screen, also while the page context still says
      // English (the language changed elsewhere, LIVE-FINDINGS 78).
      doc.documentElement = { lang: 'fr-FR' };
      eq(at(open(fixture(), fieldModel())), [`${L1}#1036`, 3, 3], 'French: “Nom|”');
      // No <html lang>: the user's Dynamics language.
      doc.documentElement = { lang: '' };
      eq(at(open(fixture(), fieldModel(), { user: FR })), [`${L1}#1036`, 3, 3]);
      eq(at(open(fixture(), fieldModel())), [`${L1}#1033`, 4, 4]);
      // The page in French, the label's French text not loaded (disabled): the first input that takes typing, the
      // clicked label's English one, never the tooltip's French one below it.
      doc.documentElement = { lang: 'fr' };
      const partial = fixture();
      partial.add([{ ...partial.get(L1)!, ref: { ...partial.get(L1)!.ref, partial: [EN] } }]);
      const p = open(partial, fieldModel());
      eq([p.inp(L1, FR).disabled, at(p)], [true, [`${L1}#1033`, 4, 4]]);
      // A language the popup doesn't show (German, not among the shown languages): the first input that takes typing.
      doc.documentElement = { lang: 'de-DE' };
      eq(at(open(fixture(), fieldModel()))[0], `${L1}#1033`);
      eq(at(open(fixture(), fieldModel(), { prefs: { shown: [DE] } }))[0], `${L1}#1031`, 'shown: German');
      // A choice opened on its value: that option, in the page's language; one the choice list has no column for (only
      // base and target), the target's.
      doc.documentElement = { lang: 'fr-FR' };
      eq(at(open(fixture(), fieldModel({ choices: { keys: [O1, O2], open: false } }), { focusKey: O2 }))[0], `${O2}#1036`);
      doc.documentElement = { lang: 'de-DE' };
      eq(at(open(fixture(), fieldModel({ choices: { keys: [O1, O2], open: false } }), { focusKey: O2, prefs: { shown: [DE] } }))[0], `${O2}#1036`);
      // Asked for (the list's cell of a language, Fix in Recent publishes): that one, whatever the page shows.
      doc.documentElement = { lang: 'fr-FR' };
      const f = open(fixture(), fieldModel(), { focusKey: TIP, focusLcid: EN });
      eq(f.focused()?.getAttribute('data-k'), `${TIP}#1033`);
      // Tab order is the inputs' order, wherever the focus started: past the last control, the first input.
      const e = open(fixture(), fieldModel());
      eq(at(e)[0], `${L1}#1036`);
      const done = e.el.querySelector('.co-f .btn.primary')!;
      done.focus();
      ok(fire(done, 'keydown', { key: 'Tab' }).defaultPrevented);
      eq(e.focused()?.getAttribute('data-k'), `${L1}#1033`);
    }),
  );

  test('callout: in a field popup the column name takes the focus first, whether or not the form has a label of its own; the form label next, never the tooltip', () => {
    const s = fixture();
    const blocks = [
      { key: COL, heading: 'Column name', long: false },
      { key: TIP, heading: 'Tooltip', long: true },
      { key: L1, heading: 'Form label', long: false },
    ];
    eq(focusKeys(s, blocks), [COL, L1], 'the form has its own label');
    s.add([{ ...s.get(L1)!, labels: { [EN]: 'Name' } }]);
    eq(focusKeys(s, blocks), [COL, L1], 'no French label (the page shows the column name in its place): the same');
    s.set(L1, FR, 'Nom du client');
    eq(focusKeys(s, blocks), [COL, L1], 'one staged: the same');
    s.revert(L1);
    s.add([{ ...s.get(L1)!, ref: { ...s.get(L1)!.ref, partial: [EN] } }]);
    eq(focusKeys(s, blocks), [COL, L1], 'its French not read: the same');
    eq(focusKeys(s, blocks.slice(1)), [], 'no column name block: the first block, as in any other popup');
    eq(focusKeys(s, [{ key: TIP, heading: 'Tooltip', long: true }]), []);
  });

  test(
    "callout: a field popup shows Column name, Tooltip, then Form label with what it means; the focus goes to the column name in the page's language, to the form label only where the column name is read-only",
    withDom(() => {
      const doc = document as unknown as { documentElement?: { lang: string } };
      const ctx = { base: EN, user: EN, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }, { lcid: DE, name: 'German', isBase: false }] };
      const popup = (s: Store, lang: string) => {
        doc.documentElement = { lang };
        const app = { store: s, ctx, prefs: { target: FR, shown: [], showNames: false, dock: 'right' } } as unknown as AppApi;
        return open(s, () => describe(app, 'field|f|c1'));
      };
      const at = (e: Env) => e.focused()?.getAttribute('data-k');
      const e = popup(fixture(), 'en-US');
      eq(e.el.querySelectorAll('.co-bh').map((x) => x.textContent), [
        'Column name · everywhere: views, search and forms without a form label',
        'Tooltip · everywhere',
        'Form label · this form only, shown instead of the column name',
      ]);
      eq(e.keys(), [`${COL}#1033`, `${COL}#1036`, `${TIP}#1033`, `${TIP}#1036`, `${L1}#1033`, `${L1}#1036`]);
      eq(e.inp(L1, FR).getAttribute('aria-label'), 'Form label, French');
      ok(e.el.querySelector('.co-also'), 'the copies checkbox stays with the form label');
      // The column's name in the page's language, whether or not the form has a label of its own.
      eq(at(e), `${COL}#1033`);
      eq(at(popup(fixture(), 'fr-FR')), `${COL}#1036`);
      // No French label of its own (the page shows the column's French name in its place): the column name all the same;
      // the form label's placeholder says what shows.
      const noFr = fixture();
      noFr.add([{ ...noFr.get(L1)!, labels: { [EN]: 'Name' } }]);
      const c = popup(noFr, 'fr-FR');
      eq([at(c), c.inp(L1, FR).placeholder], [`${COL}#1036`, 'Shows “Nom”']);
      // After Undo changes (typed in the form label), back to the column name.
      c.type(L1, FR, 'Nom du client');
      fire(c.el.querySelector('.co-f .link')!, 'click');
      eq(at(c), `${COL}#1036`);
      // A language the popup doesn't show (German): the column name's first input that takes typing.
      eq(at(popup(noFr, 'de-DE')), `${COL}#1033`);
      // The form from a managed solution (its labels read-only) on a column that can be typed in: the column name, in the
      // page's language; the form label has the lock line.
      const mf = fixture();
      for (const k of [L1, L2]) mf.add([{ ...mf.get(k)!, ref: { ...mf.get(k)!.ref, managed: true } }]);
      const m = popup(mf, 'fr-FR');
      eq([at(m), m.inp(L1, FR).disabled, m.inp(COL, FR).disabled], [`${COL}#1036`, true, false]);
      eq(m.el.querySelectorAll('.co-ro').map((x) => x.textContent), [MANAGED.replace(/\.$/, '')]);
      eq(at(popup(mf, 'en-US')), `${COL}#1033`);
      // The column's name read-only (a managed column): the form's own label, the text the page shows, never the
      // tooltip between them; the lock line on the name.
      const ro = fixture();
      ro.add([{ ...ro.get(L1)!, labels: { [EN]: 'Name' } }, { ...ro.get(COL)!, readOnly: 'Managed and not customizable.' }]);
      const r = popup(ro, 'fr-FR');
      eq([at(r), r.inp(COL, FR).disabled, r.inp(TIP, FR).disabled], [`${L1}#1036`, true, false]);
      eq(r.el.querySelectorAll('.co-ro').map((x) => x.textContent), ['Managed and not customizable']);
      // ... and the form label not read in French: its English one, which takes typing.
      const roEn = fixture();
      roEn.add([{ ...roEn.get(L1)!, ref: { ...roEn.get(L1)!.ref, partial: [EN] } }, { ...roEn.get(COL)!, readOnly: 'Managed and not customizable.' }]);
      eq(at(popup(roEn, 'fr-FR')), `${L1}#1033`);
      // Asked for (a list cell of a language): that one wins.
      eq(at(open(noFr, () => describe({ store: noFr, ctx, prefs: { target: FR, shown: [], showNames: false, dock: 'right' } } as unknown as AppApi, 'field|f|c1'), { focusKey: TIP, focusLcid: FR })), `${TIP}#1036`);
    }),
  );

  test(
    "editor card: the input in the language the page is shown in has the focus (not the target language), the caret at the end of its text; a language asked for wins",
    withDom(() => {
      const doc = document as unknown as { documentElement?: { lang: string } };
      const card = (lang: string, l?: Lcid, o: { user?: Lcid; focusLcid?: Lcid } = {}) => {
        doc.documentElement = { lang };
        const store = fixture();
        const app = {
          store,
          ctx: { base: EN, user: o.user ?? EN, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }, { lcid: DE, name: 'German', isBase: false }] },
          prefs: { target: FR, shown: [], showNames: false, dock: 'right' },
          root: dom.root,
          layer: dom.layer,
          adoptStyles() {},
          toast() {},
          status() {},
        } as unknown as AppApi;
        const ed = createEditor(app, 'field|f|c1', { focusLcid: o.focusLcid });
        dom.layer.appendChild(ed.el as unknown as FEl);
        ed.focus(l);
        const f = dom.root.activeElement;
        ed.destroy();
        return [f?.getAttribute('data-k'), f?.selectionStart, f?.selectionEnd];
      };
      eq(card('en-US'), [`${L1}#1033`, 4, 4], 'English: “Name|”');
      eq(card('fr-FR'), [`${L1}#1036`, 3, 3], 'French: “Nom|”');
      eq(card('', undefined, { user: FR }), [`${L1}#1036`, 3, 3], "no <html lang>: the user's Dynamics language");
      eq(card('fr-FR', EN), [`${L1}#1033`, 4, 4], 'asked for');
      eq(card('fr-FR', undefined, { focusLcid: EN }), [`${L1}#1033`, 4, 4], 'opened for a language');
      eq(card('de-DE')[0], `${L1}#1033`, 'German, not shown: the first editable input');
    }),
  );

  test(
    "editor card: a translation emptied where Dataverse can't remove it is staged (green) with a note saying what it becomes; with nothing to stand in for it, red with the reason",
    withDom(() => {
      const store = fixture();
      const app = {
        store,
        ctx: { base: EN, user: EN, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] },
        prefs: { target: FR, shown: [], showNames: false, dock: 'right' },
        root: dom.root,
        layer: dom.layer,
        adoptStyles() {},
        toast() {},
        status() {},
        saver: { validate: () => [] },
      } as unknown as AppApi;
      const ed = createEditor(app, 'field|f|c1');
      dom.layer.appendChild(ed.el as unknown as FEl);
      const el = ed.el as unknown as FEl;
      const inp = (k: string, l: Lcid) => el.querySelectorAll('.ti').find((x) => x.getAttribute('data-k') === `${k}#${l}`)!;
      const look = (k: string, l: Lcid) => {
        const f = inp(k, l).parentElement!;
        const m = f.querySelector('.emm')!;
        return [f.parentElement!.dataset.s, m.className, m.textContent, inp(k, l).getAttribute('aria-invalid')];
      };
      store.add([{ ...store.get(COL)!, labels: { [EN]: 'Name', [FR]: 'Nom du compte' } }]);
      store.set(L1, FR, '');
      eq(look(L1, FR), ['edit', 'emm n', "Becomes “Nom du compte”: Dataverse can't remove a translation here, so French gets the column's French name.", null]);
      // No "Shows …" placeholder next to it: the note says what the page will show.
      eq(inp(L1, FR).placeholder, '');
      // Worded like its column's French name already: nothing changes, and it says so.
      store.add([{ ...store.get(COL)!, labels: { [EN]: 'Name', [FR]: 'Nom' } }]);
      store.emit({ type: 'edits' });
      eq(look(L1, FR), ['edit', 'emm n', "Already the column's French name: Dataverse can't remove a translation here, so nothing changes.", null]);
      // Its column not loaded: nothing to stand in for it, and what loads it.
      store.slots.delete(COL);
      store.emit({ type: 'edits' });
      eq(look(L1, FR), ['err', 'emm e', "Dataverse can't remove this translation, and its column's names aren't loaded: load its table's columns to put the column's name in its place, or type the text.", 'true']);
      ed.destroy();
    }),
  );

  test(
    'callout: a French tooltip emptied is saved empty (model.ts savesEmpty): staged (blue, never red), the line under it says so, "No French tooltip"; one stored empty is translated (no amber), one missing shows the English one (amber)',
    withDom(() => {
      // Stored empty: French users see none, which it says; translated.
      const s = fixture();
      s.add([{ ...s.get(TIP)!, labels: { [EN]: 'Type the name.', [FR]: '' } }]);
      const e = open(s, fieldModel());
      const v = (k: string, l: Lcid) => e.inp(k, l).parentElement!;
      eq([e.inp(TIP, FR).placeholder, v(TIP, FR).className, v(TIP, FR).querySelector('.co-m')!.hidden], ['No French tooltip', 'co-v', true]);
      // Missing: French users see the English one; amber.
      const m = open(fixture(), fieldModel());
      eq([m.inp(TIP, FR).placeholder, m.inp(TIP, FR).parentElement!.className], ['Shows “Type the name.”', 'co-v is-miss']);
      // Emptied: staged, a muted line saying what saving does, whatever its English text.
      const x = fixture();
      x.add([{ ...x.get(TIP)!, labels: { [FR]: 'Tapez le nom.' } }]);
      const r = open(x, fieldModel());
      r.type(TIP, FR, '');
      const hint = r.inp(TIP, FR).parentElement!.querySelector('.co-m')!;
      eq([r.inp(TIP, FR).parentElement!.className, hint.hidden, hint.className, hint.textContent], ['co-v is-edit', false, 'co-m is-note', 'Saved empty: French users see no tooltip.']);
      eq([r.inp(TIP, FR).getAttribute('aria-invalid'), r.inp(TIP, FR).placeholder, problem(x, x.get(TIP)!, FR, EN)], [null, 'No French tooltip', '']);
      // A text again: nothing to say.
      r.type(TIP, FR, 'Nom');
      ok(r.inp(TIP, FR).parentElement!.querySelector('.co-m')!.hidden, 'a text');
    }),
  );

  test(
    'editor card: a French tooltip emptied is staged (green) with a note that it is saved empty and "No French tooltip"; stored empty, no dot and the same placeholder; missing, amber and the English one',
    withDom(() => {
      const store = fixture();
      store.add([{ ...store.get(TIP)!, labels: { [EN]: 'Type the name.', [FR]: 'Tapez le nom.' } }]);
      const app = {
        store,
        ctx: { base: EN, user: EN, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] },
        prefs: { target: FR, shown: [], showNames: false, dock: 'right' },
        root: dom.root,
        layer: dom.layer,
        adoptStyles() {},
        toast() {},
        status() {},
        saver: { validate: () => [] },
      } as unknown as AppApi;
      const ed = createEditor(app, 'attribute|acc.name');
      dom.layer.appendChild(ed.el as unknown as FEl);
      const el = ed.el as unknown as FEl;
      const inp = (k: string, l: Lcid) => el.querySelectorAll('.ti').find((x) => x.getAttribute('data-k') === `${k}#${l}`)!;
      const look = (k: string, l: Lcid) => {
        const f = inp(k, l).parentElement!;
        const m = f.querySelector('.emm')!;
        return [f.parentElement!.dataset.s, m.className, m.textContent, inp(k, l).placeholder];
      };
      store.set(TIP, FR, '');
      eq(look(TIP, FR), ['edit', 'emm n', 'Saved empty: French users see no tooltip.', 'No French tooltip']);
      // Saved: stored empty, translated (no amber dot).
      store.commit([{ change: { slot: store.get(TIP)!, lcid: FR, before: 'Tapez le nom.', after: '' }, outcome: 'saved' }]);
      store.status.clear();
      store.emit({ type: 'status' });
      eq(look(TIP, FR), ['', 'emm', '', 'No French tooltip']);
      // Missing: amber, and the English one it shows.
      store.add([{ ...store.get(TIP)!, labels: { [EN]: 'Type the name.' } }]);
      store.emit({ type: 'edits' });
      eq(look(TIP, FR), ['miss', 'emm', '', 'Shows “Type the name.”']);
      ed.destroy();
    }),
  );

  test(
    "callout: a related menu item without a French title says what French users see, its relationship's text (live) or a built-in item's page text",
    withDom(() => {
      const NAV = 'navitem|f|nav_rel|Label';
      const AUD = 'navitem|f|navAudit|Label';
      const PL = 'entity|t|DisplayCollectionName';
      const s = new Store();
      s.add([
        S('navitem', 'navitem|f|nav_rel', 'Label', { [EN]: 'Things' }, { ref: { formId: 'f', elId: 'nav_rel', area: 'nav', relationship: 'rel' } }),
        S('relationship', 'relationship|rel', 'Label', {}, { readOnly: "Uses the related table's plural name", ref: { type: 'OneToMany', referenced: 'acc', referencing: 't', menu: 'plural' } }),
        S('entity', 'entity|t', 'DisplayCollectionName', { [EN]: 'Things', [FR]: 'Choses' }, { entity: 't' }),
        S('navitem', 'navitem|f|navAudit', 'Label', { [EN]: 'Audit History' }, { ref: { formId: 'f', elId: 'navAudit', area: 'nav', relationship: 'hardcoded_{B7196B13-6B9D-42CD-BD58-B19A3953126F}navAudit' } }),
      ]);
      const model = (blocks: CalloutModel['blocks']): CalloutModel => ({ comp: 'navitem|f|x', title: 'x', kind: 'Menu item', icon: 'nav', blocks, loading: false });
      const e = open(s, model([
        { key: NAV, heading: 'Label', long: false, note: 'this form only' },
        { key: PL, heading: 'Table plural name', long: false, note: 'everywhere' },
      ]), { user: FR });
      eq(e.keys(), [`${NAV}#1033`, `${NAV}#1036`, `${PL}#1033`, `${PL}#1036`]);
      eq(e.el.querySelectorAll('.co-bh').map((x) => x.textContent), ['Label · this form only', 'Table plural name · everywhere']);
      eq(e.inp(NAV, FR).placeholder, 'Shows “Choses”');
      ok(!e.inp(NAV, FR).parentElement!.classList.contains('is-miss'), "worded like the plural name: its French is the item's");
      // The plural name typed below: the item's French placeholder follows.
      e.type(PL, FR, 'Trucs');
      eq(e.inp(NAV, FR).placeholder, 'Shows “Trucs”');
      // A built-in item: the page's text, in the user's language only.
      const a = open(s, model([{ key: AUD, heading: 'Label', long: false, pageText: 'Historique d’audit' }]), { user: FR });
      eq([a.inp(AUD, FR).placeholder, a.inp(AUD, FR).parentElement!.classList.contains('is-miss')], ['Shows “Historique d’audit”', true]);
      const en = open(s, model([{ key: AUD, heading: 'Label', long: false, pageText: 'Historique d’audit' }]));
      eq(en.inp(AUD, FR).placeholder, 'Shows “Audit History”', "an English user's page says nothing about French");
    }),
  );

  test(
    'callout: placeholders, amber and the blue tint of a changed text',
    withDom(() => {
      const s = fixture();
      s.add([{ ...s.get(L1)!, labels: { [EN]: 'Customer name' } }]);
      const e = open(s, fieldModel());
      const v = (k: string, l: Lcid) => e.inp(k, l).parentElement!;
      eq(e.inp(L1, FR).placeholder, 'Shows “Nom”');
      // No French tooltip of its own: French users see the English one, which it says.
      eq(e.inp(TIP, FR).placeholder, 'Shows “Type the name.”');
      ok(v(L1, FR).classList.contains('is-miss'), 'amber');
      e.type(L1, FR, 'Nom du client');
      ok(v(L1, FR).classList.contains('is-edit') && !v(L1, FR).classList.contains('is-miss'), 'blue tint');
      ok(v(L1, FR).querySelector('.co-m')!.hidden, 'no message for a valid text');
      // Emptied where Dataverse can't remove it: staged (blue tint, not red), and a muted line says what it becomes; no
      // "Shows …" placeholder next to it, which could name another text.
      const fx = fixture();
      fx.add([{ ...fx.get(COL)!, labels: { [EN]: 'Name', [FR]: 'Nom du compte' } }]);
      const r = open(fx, fieldModel());
      const rv = (k: string, l: Lcid) => r.inp(k, l).parentElement!;
      r.type(L1, FR, '');
      ok(rv(L1, FR).classList.contains('is-edit') && !rv(L1, FR).classList.contains('is-err'), 'staged, not red');
      const hint = rv(L1, FR).querySelector('.co-m')!;
      eq([hint.hidden, hint.className, hint.textContent], [false, 'co-m is-note', "Becomes “Nom du compte”: Dataverse can't remove a translation here, so French gets the column's French name."]);
      eq([r.inp(L1, FR).getAttribute('aria-invalid'), r.inp(L1, FR).placeholder], [null, '']);
      // Undo changes puts the translation back; emptied again, typing a text replaces the stand-in.
      fire(r.el.querySelector('.co-f .link')!, 'click');
      eq([r.inp(L1, FR).value, rv(L1, FR).querySelector('.co-m')!.hidden, r.store.isEdited(L1, FR)], ['Nom', true, false]);
      r.type(L1, FR, '');
      ok(!rv(L1, FR).querySelector('.co-m')!.hidden, 'said again');
      r.type(L1, FR, 'Nom 2');
      ok(rv(L1, FR).querySelector('.co-m')!.hidden && rv(L1, FR).classList.contains('is-edit'), 'a text: nothing to say');
      // Blocking problems: red, one short line, the counter only over the limit.
      r.type(L1, EN, ' ');
      ok(rv(L1, EN).classList.contains('is-err'), 'red');
      eq([rv(L1, EN).querySelector('.co-m')!.textContent, rv(L1, EN).querySelector('.co-m')!.className], ["Can't be empty", 'co-m']);
      eq(r.inp(L1, EN).getAttribute('aria-invalid'), 'true');
      r.type(L1, FR, 'x'.repeat(52));
      eq(rv(L1, FR).querySelector('.co-m')!.textContent, 'Too long (max 50)52 / 50');
      r.type(L1, FR, 'x'.repeat(50));
      ok(rv(L1, FR).querySelector('.co-m')!.hidden && r.inp(L1, FR).getAttribute('aria-invalid') === null, 'at the limit: nothing to say');
      eq(rv(L1, FR).querySelectorAll('.cnt').length, 0, 'no counter under the limit');
    }),
  );

  /**
   * The name field of a main form once the read behind the page's loads is in (Store.setOwn): GetClientMetadata
   * listed an English label of the cell's own, "Full name", and no French one, where the read filled in the column's
   * French name, "Nom V4" (LIVE-FINDINGS 103, 114). With `copy`, the field placed a second time, following its column in
   * both languages.
   */
  const following = (copy = false): Store => {
    const s = mainForm({ [EN]: 'Full name', [FR]: 'Nom V4' });
    s.add([{ ...s.get(L1)!, ref: { ...MAIN, own: { [EN]: true, [FR]: false } } }]);
    if (copy) s.add([S('field', 'field|f|c2', 'Label', { [EN]: 'Name', [FR]: 'Nom V4' }, { baseRequired: false, order: 1, ref: { ...MAIN, elId: 'c2', controlId: 'name1', own: { [EN]: false, [FR]: false } } })]);
    return s;
  };
  /** Types `text` at the end of an input one key at a time, as a user does (`put` sets its value and fires 'input'): what it holds after each key. */
  const keyed = (get: () => FEl, put: (v: string) => void, text: string): string[] => [...text].map((k) => (put(get().value + k), get().value));
  /** What an input holds after each key of "Nom V4 bis" typed from empty, through the column's French name. */
  const NOM_V4_BIS = ['N', 'No', 'Nom', 'Nom ', 'Nom V', 'Nom V4', 'Nom V4 ', 'Nom V4 b', 'Nom V4 bi', 'Nom V4 bis'];

  test("form label: it follows its column in a language where GetClientMetadata lists no label of the cell's own and its text as loaded is what a read fills in there, the column's name, else its English name (LIVE-FINDINGS 103, 114); not where it lists one, where the text is another, or where that read isn't known", () => {
    const s = following();
    eq([s.follows(L1, EN, EN), s.follows(L1, FR, EN)], [false, true], 'its own English label; French filled in');
    // No German name for the column: a read fills in its English name.
    s.add([{ ...s.get(L1)!, labels: { [EN]: 'Full name', [FR]: 'Nom V4', [DE]: 'Name' }, ref: { ...MAIN, own: { [EN]: true, [FR]: false, [DE]: false } } }]);
    eq(s.follows(L1, DE, EN), true, "the column's English name");
    // Whatever is typed, it is measured as loaded: a typed text, or the column renamed, changes nothing here.
    s.set(L1, FR, 'Nom propre');
    s.set(COL, FR, 'Nom V5');
    eq(s.follows(L1, FR, EN), true, 'as loaded');
    s.revert(L1);
    s.revert(COL);
    // Changed: a French text of the form's own that isn't published (GetClientMetadata reads the published form), or a
    // saved one.
    s.add([{ ...s.get(L1)!, labels: { [EN]: 'Full name', [FR]: 'Nom propre' } }]);
    eq(s.follows(L1, FR, EN), false, 'another text');
    s.add([{ ...s.get(L1)!, labels: { [EN]: 'Full name', [FR]: 'Nom V4' } }]);
    s.set(L1, FR, 'Nom propre');
    s.commit([{ change: { slot: s.get(L1)!, lcid: FR, before: 'Nom V4', after: 'Nom propre' }, outcome: 'saved' }]);
    eq(s.follows(L1, FR, EN), false, 'saved since');
    // Unknown: that language not read, or no read at all; the column's names not loaded; a read-only label.
    const u = following();
    u.add([{ ...u.get(L1)!, ref: { ...MAIN, own: { [EN]: true } } }]);
    eq(u.follows(L1, FR, EN), false, 'French not read');
    u.add([{ ...u.get(L1)!, ref: MAIN }]);
    eq(u.follows(L1, FR, EN), false, 'no read');
    const n = following();
    n.slots.delete(COL);
    eq(n.follows(L1, FR, EN), false, "the column's names not loaded");
    const r = following();
    r.add([{ ...r.get(L1)!, readOnly: MANAGED }]);
    eq(r.follows(L1, FR, EN), false, 'read-only');
  });

  test(
    "callout: a Form label that follows its column is empty, “Shows” the column's name as its placeholder; one of the form's own shows its text; typing in the empty one is an edit of it, and emptying it again stages nothing, so its column's name is never written there as its stand-in (copies too)",
    withDom(() => {
      const e = open(following(), fieldModel({ blocks: FIELD_BLOCKS }));
      const row = (l: Lcid) => [e.inp(L1, l).value, e.inp(L1, l).placeholder, e.inp(L1, l).parentElement!.className];
      eq(row(FR), ['', 'Shows “Nom V4”', 'co-v'], 'follows: empty, not missing');
      eq(row(EN)[0], 'Full name', 'its own');
      // Typed: an edit of that label, as any.
      e.type(L1, FR, 'Nom propre');
      eq([row(FR), e.store.value(L1, FR)], [['Nom propre', 'Shows “Nom V4”', 'co-v is-edit'], 'Nom propre']);
      // Emptied again, or only spaces: nothing staged, no stand-in; empty again.
      for (const v of ['', '  ']) {
        e.type(L1, FR, 'Nom propre');
        e.type(L1, FR, v);
        eq([e.store.isEdited(L1, FR), e.store.standIn(L1, FR, EN), row(FR)], [false, undefined, ['', 'Shows “Nom V4”', 'co-v']], JSON.stringify(v));
      }
      eq(e.store.changes(), [], 'nothing to save');
      // Typed key by key through the column's name, where the edit is unstaged (Store.set): the input keeps every key, and
      // the whole text is staged.
      eq(keyed(() => e.inp(L1, FR), (v) => e.type(L1, FR, v), 'Nom V4 bis'), NOM_V4_BIS);
      eq(e.store.value(L1, FR), 'Nom V4 bis');
      e.type(L1, FR, '');
      // The column renamed here: the placeholder says the name it then shows.
      e.type(COL, FR, 'Nom V5');
      eq(row(FR), ['', 'Shows “Nom V5”', 'co-v']);
      e.type(COL, FR, 'Nom V4');
      // Its own English label emptied, French following: the cell keeps no label of its own (model.ts freesAll), so it
      // follows its column in English too, saved so (its stand-in, `follow`): "Shows" the column's English name.
      e.type(L1, EN, '');
      eq([e.store.value(L1, EN), e.store.standIn(L1, EN, EN), row(EN)], ['', { text: 'Name', from: 'column', follow: true }, ['', 'Shows “Name”', 'co-v is-edit']]);
      // The copies checkbox: both follow their column; typed, then emptied again, neither is staged.
      const c = open(following(true), fieldModel({ blocks: [{ key: L1, heading: 'Form label', long: false, also: { keys: [L2], on: true } }] }));
      c.type(L1, FR, 'Nom propre');
      eq([c.store.value(L1, FR), c.store.value(L2, FR)], ['Nom propre', 'Nom propre']);
      c.type(L1, FR, '');
      eq([c.store.isEdited(L1), c.store.isEdited(L2), c.inp(L1, FR).value], [false, false, '']);
      // A copy with a French label of its own worded as the column's name (one a whole-form save froze, LIVE-FINDINGS 109):
      // emptied again, it gets that label back too, never its stand-in.
      const frozen = following(true);
      frozen.add([{ ...frozen.get(L2)!, ref: { ...frozen.get(L2)!.ref, own: { [EN]: false, [FR]: true } } }]);
      const f = open(frozen, fieldModel({ blocks: [{ key: L1, heading: 'Form label', long: false, also: { keys: [L2], on: true } }] }));
      f.type(L1, FR, 'Nom propre');
      eq(f.store.value(L2, FR), 'Nom propre');
      f.type(L1, FR, '');
      eq([f.store.isEdited(L1), f.store.isEdited(L2), f.store.changes()], [false, false, []]);
    }),
  );

  test(
    "editor card: a Form label that follows its column is empty, “Shows” the column's name, in English too; emptying it again after typing stages nothing",
    withDom(() => {
      const store = following();
      store.add([{ ...store.get(L1)!, labels: { [EN]: 'Name', [FR]: 'Nom V4' }, ref: { ...MAIN, own: { [EN]: false, [FR]: false } } }]);
      const app = {
        store,
        ctx: { base: EN, user: EN, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] },
        prefs: { target: FR, shown: [], showNames: false, dock: 'right' },
        root: dom.root,
        layer: dom.layer,
        adoptStyles() {},
        toast() {},
        status() {},
      } as unknown as AppApi;
      app.saver = createSaver(app.ctx, store, {} as AppApi['lang'], () => undefined);
      const ed = createEditor(app, 'field|f|c1');
      dom.layer.appendChild(ed.el as unknown as FEl);
      const el = ed.el as unknown as FEl;
      const inp = (l: Lcid) => el.querySelectorAll('.ti').find((x) => x.getAttribute('data-k') === `${L1}#${l}`)!;
      const look = (l: Lcid) => [inp(l).value, inp(l).placeholder, inp(l).parentElement!.parentElement!.dataset.s];
      eq([look(EN), look(FR)], [['', 'Shows “Name”', ''], ['', 'Shows “Nom V4”', '']]);
      const typeIn = (l: Lcid, v: string) => {
        inp(l).value = v;
        fire(inp(l), 'input');
      };
      typeIn(FR, 'Nom propre');
      eq([look(FR), store.value(L1, FR)], [['Nom propre', 'Shows “Nom V4”', 'edit'], 'Nom propre']);
      typeIn(FR, '');
      eq([look(FR), store.isEdited(L1)], [['', 'Shows “Nom V4”', ''], false]);
      // Typed key by key through the column's name: the input keeps every key, and the whole text is staged.
      eq(keyed(() => inp(FR), (v) => typeIn(FR, v), 'Nom V4 bis'), NOM_V4_BIS);
      eq(store.value(L1, FR), 'Nom V4 bis');
      ed.destroy();
    }),
  );

  test(
    "callout: which labels are their own, read behind the page's loads (Store.setOwn), arrives while the popup is open: a Form label that follows its column turns empty, “Shows” its name; one of its own keeps its text; what is typed stays",
    withDom(() => {
      const s = mainForm({ [EN]: 'Full name', [FR]: 'Nom V4' });
      const e = open(s, fieldModel({ blocks: FIELD_BLOCKS }));
      const row = (l: Lcid) => [e.inp(L1, l).value, e.inp(L1, l).placeholder];
      eq([row(EN)[0], row(FR)[0]], ['Full name', 'Nom V4'], 'not known yet: as loaded');
      s.setOwn(new Map([[L1, { [EN]: true, [FR]: false }]]));
      eq([row(EN)[0], row(FR)], ['Full name', ['', 'Shows “Nom V4”']]);
      eq(s.get(L1)!.ref.own, { [EN]: true, [FR]: false });
      // Typed before it arrives: the text stays.
      const typed = mainForm({ [EN]: 'Full name', [FR]: 'Nom V4' });
      const f = open(typed, fieldModel({ blocks: FIELD_BLOCKS }));
      f.type(L1, FR, 'Nom propre');
      typed.setOwn(new Map([[L1, { [FR]: false }]]));
      eq([f.inp(L1, FR).value, typed.value(L1, FR)], ['Nom propre', 'Nom propre']);
    }),
  );

  /**
   * The name field worded as its column in English ("Name") and in French (`fr`, "Nom V4" by default), GetClientMetadata's
   * answer in English in (`en`: a label of the cell's own there), none in French yet; with `en` undefined, none at all.
   */
  const unanswered = (en: boolean | undefined, fr = 'Nom V4'): Store => {
    const s = mainForm({ [EN]: 'Name', [FR]: fr });
    s.add([{ ...s.get(L1)!, ref: { ...MAIN, ...(en === undefined ? {} : { own: { [EN]: en } }) } }]);
    return s;
  };

  test(
    "callout: a Form label in a language GetClientMetadata hasn't answered for yet, worded as the column's name there, shows as the user's language does: empty, “Shows” the name, where English follows; its text where English has one of its own; the answer, once in, decides; a text of the form's own never shows empty; typing or emptying it stages by what it shows: nothing where it shows empty, as where its own answer says it follows, else what it did before",
    withDom(() => {
      const french = (s: Store) => {
        const e = open(s, fieldModel({ blocks: FIELD_BLOCKS }));
        return [e.inp(L1, FR).value, e.inp(L1, FR).placeholder];
      };
      eq(french(unanswered(false)), ['', 'Shows “Nom V4”'], 'English follows');
      eq(french(unanswered(true))[0], 'Nom V4', 'English has its own');
      eq(french(unanswered(undefined))[0], 'Nom V4', 'nothing answered');
      eq(french(unanswered(false, 'Nom propre'))[0], 'Nom propre', "a text of the form's own");
      // Shown so: Store.follows with the user's language, as the inputs show it and stage by it; without it, nothing is known yet.
      const g = unanswered(false);
      eq([g.follows(L1, FR, EN, EN), g.follows(L1, FR, EN), g.follows(L1, EN, EN, EN)], [true, false, true]);
      // The French answer, once in, decides: a label of its own worded as the column's name (LIVE-FINDINGS 109).
      const s = unanswered(false);
      const e = open(s, fieldModel({ blocks: FIELD_BLOCKS }));
      s.setOwn(new Map([[L1, { [FR]: true }]]));
      eq(e.inp(L1, FR).value, 'Nom V4', 'its own after all');
      const t = unanswered(true);
      const f = open(t, fieldModel({ blocks: FIELD_BLOCKS }));
      t.setOwn(new Map([[L1, { [FR]: false }]]));
      eq(f.inp(L1, FR).value, '', 'following after all');
      // What each input stages, typed key by key or emptied: shown empty (English follows), what it stages where French's own
      // answer says it follows: a blank is nothing; shown with its text (English has its own), what it stages with nothing
      // answered at all.
      const follows = (): Store => {
        const s = mainForm({ [EN]: 'Name', [FR]: 'Nom V4' });
        s.add([{ ...s.get(L1)!, ref: { ...MAIN, own: { [EN]: false, [FR]: false } } }]);
        return s;
      };
      const staged = (st: Store, vs: string[]) => {
        const p = open(st, fieldModel({ blocks: FIELD_BLOCKS }));
        for (const v of vs) p.type(L1, FR, v);
        return [st.isEdited(L1, FR), st.value(L1, FR), st.standIn(L1, FR, EN)?.text ?? null, st.changes().length];
      };
      for (const vs of [[''], ['  '], ['x', ''], ['Nom V4', ''], ['Nom V4 bis', 'Nom V4'], ['Nom propre']]) {
        eq(staged(unanswered(false), vs), staged(follows(), vs), `shown empty: ${JSON.stringify(vs)}`);
        eq(staged(unanswered(true), vs), staged(unanswered(undefined), vs), `shown with its text: ${JSON.stringify(vs)}`);
      }
      eq([staged(unanswered(false), ['x', '']), staged(unanswered(true), ['x', ''])], [[false, 'Nom V4', null, 0], [true, '', 'Nom V4', 1]], 'typed, then emptied: nothing where it showed empty');
    }),
  );

  test(
    "editor card: a Form label in a language GetClientMetadata hasn't answered for yet, worded as the column's name there, shows as the user's language does: empty, “Shows” the name, where English follows",
    withDom(() => {
      const card = (store: Store) => {
        const app = {
          store,
          ctx: { base: EN, user: EN, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] },
          prefs: { target: FR, shown: [], showNames: false, dock: 'right' },
          root: dom.root,
          layer: dom.layer,
          adoptStyles() {},
          toast() {},
          status() {},
        } as unknown as AppApi;
        app.saver = createSaver(app.ctx, store, {} as AppApi['lang'], () => undefined);
        const ed = createEditor(app, 'field|f|c1');
        dom.layer.appendChild(ed.el as unknown as FEl);
        const inp = (ed.el as unknown as FEl).querySelectorAll('.ti').find((x) => x.getAttribute('data-k') === `${L1}#${FR}`)!;
        const out = [inp.value, inp.placeholder];
        ed.destroy();
        return out;
      };
      eq(card(unanswered(false)), ['', 'Shows “Nom V4”'], 'English follows');
      eq(card(unanswered(true))[0], 'Nom V4', 'English has its own');
    }),
  );

  test(
    "callout and editor card: a French user's English Form label shown empty because French follows the column (no English answer from GetClientMetadata yet), typed in then emptied, stages nothing, never an emptied English label (which Dataverse doesn't keep, LIVE-FINDINGS 104), nor on its copy with “Also change the other copies”; an English user's French label the same",
    withDom(() => {
      /** The name field placed twice, worded as its column in both languages, `own`: what GetClientMetadata answered so far. */
      const twice = (own: Record<number, boolean>): Store => {
        const s = mainForm({ [EN]: 'Name', [FR]: 'Nom V4' });
        const copy = S('field', 'field|f|c2', 'Label', { [EN]: 'Name', [FR]: 'Nom V4' }, { baseRequired: false, ref: { ...MAIN, elId: 'c2', controlId: 'name1', own } });
        s.add([{ ...s.get(L1)!, ref: { ...MAIN, own } }, copy]);
        return s;
      };
      const typed = (s: Store, l: Lcid) => [s.isEdited(L1, l), s.isEdited(L2, l), s.changes().length];
      for (const [user, l, own] of [[FR, EN, { [FR]: false }], [EN, FR, { [EN]: false }]] as const) {
        const s = twice(own);
        const e = open(s, fieldModel({}, { keys: [L2], on: true }), { user });
        eq(e.inp(L1, l).value, '', `shown empty (${l})`);
        e.type(L1, l, 'x');
        eq(typed(s, l), [true, true, 2], `typed (${l})`);
        e.type(L1, l, '');
        eq([typed(s, l), e.inp(L1, l).value], [[false, false, 0], ''], `emptied: nothing staged (${l})`);
        // The editor card: the same.
        const t = twice(own);
        const app = {
          store: t,
          ctx: { base: EN, user, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] },
          prefs: { target: FR, shown: [], showNames: false, dock: 'right' },
          root: dom.root,
          layer: dom.layer,
          adoptStyles() {},
          toast() {},
          status() {},
        } as unknown as AppApi;
        app.saver = createSaver(app.ctx, t, {} as AppApi['lang'], () => undefined);
        const ed = createEditor(app, 'field|f|c1');
        dom.layer.appendChild(ed.el as unknown as FEl);
        const inp = (ed.el as unknown as FEl).querySelectorAll('.ti').find((x) => x.getAttribute('data-k') === `${L1}#${l}`)!;
        eq(inp.value, '', `the card: shown empty (${l})`);
        for (const v of ['x', '']) {
          inp.value = v;
          fire(inp, 'input');
        }
        eq([t.isEdited(L1, l), t.changes().length], [false, 0], `the card: nothing staged (${l})`);
        ed.destroy();
      }
    }),
  );

  test("preview: a Form label that follows its column shows the column's name as staged while nothing is typed in it, the name typed in any popup (Preview.showing finds the labels that show it); one of the form's own keeps its text; undone, the page is as before", () => {
    const s = following(true);
    const label = (text: string) => Object.assign(new El('label', {}, text), { isConnected: true });
    const page = (user: Lcid, texts: [string, string]) => {
      const p = new Preview({ store: s, ctx: { base: EN, user } } as unknown as AppApi, (fn) => fn());
      const [one, two] = texts.map(label);
      const body = new El('div').add(one, two);
      const all = [{ key: L1, el: one }, { key: L2, el: two }, { key: TIP, el: label('Primary name') }] as unknown as Anchor[];
      // As translation mode does on an edit (inspector/mode.ts): the edited label's anchors, and those that show it.
      const edited = (key: string) => withPage(body, () => p.apply([...all.filter((a) => a.key === key), ...p.showing(key, all)]));
      return { p, all, edited, shown: () => [one.node.nodeValue, two.node.nodeValue] };
    };
    // French: both follow the column.
    const fr = page(FR, ['Nom V4', 'Nom V4']);
    eq([fr.p.showing(COL, fr.all).map((a) => a.key), fr.p.showing(L1, fr.all), fr.p.showing(TIP, fr.all)], [[L1, L2], [], []], 'the labels that show the name');
    s.set(COL, FR, 'Nom V5');
    fr.edited(COL);
    eq(fr.shown(), ['Nom V5', 'Nom V5'], 'as typed');
    s.set(L1, FR, 'Nom propre');
    fr.edited(L1);
    eq(fr.shown(), ['Nom propre', 'Nom V5'], 'a text typed in the label is its own');
    s.revert(L1);
    fr.edited(L1);
    s.revert(COL);
    fr.edited(COL);
    eq(fr.shown(), ['Nom V4', 'Nom V4'], 'undone');
    // English: the first has a label of its own, the copy follows the column.
    const en = page(EN, ['Full name', 'Name']);
    s.set(COL, EN, 'Account name');
    en.edited(COL);
    eq(en.shown(), ['Full name', 'Account name']);
    s.revert(COL);
    en.edited(COL);
    eq(en.shown(), ['Full name', 'Name']);
  });

  test("preview: on a French page, the French name of a column that Form labels follow typed as spaces alone: they show what they show with it emptied, the column's English name (its stand-in), never their old French text", () => {
    const s = following(true);
    const p = new Preview({ store: s, ctx: { base: EN, user: FR } } as unknown as AppApi, (fn) => fn());
    const [one, two] = ['Nom V4', 'Nom V4'].map((x) => Object.assign(new El('label', {}, x), { isConnected: true }));
    const all = [{ key: L1, el: one }, { key: L2, el: two }] as unknown as Anchor[];
    const edited = () => withPage(new El('div').add(one, two), () => p.apply(p.showing(COL, all)));
    s.set(COL, FR, '   ');
    edited();
    eq([one.node.nodeValue, two.node.nodeValue], ['Name', 'Name'], 'spaces');
    eq(becomes(s, s.get(COL)!, FR, EN), "Becomes “Name”: Dataverse can't remove a translation here, so French gets the English text.", 'what saving writes');
    s.set(COL, FR, '');
    edited();
    eq([one.node.nodeValue, two.node.nodeValue], ['Name', 'Name'], 'emptied');
    s.set(COL, FR, '  Nom V5 ');
    edited();
    eq([one.node.nodeValue, two.node.nodeValue], ['Nom V5', 'Nom V5'], 'a name between spaces');
  });

  test("preview: a form label the page shows otherwise than loaded (saved, not published yet) shows the page's text again once its edit is undone, and keeps it while another label or its column is edited (it has a text of its own)", () => {
    const s = mainForm({ [EN]: 'Saved label', [FR]: 'Nom' });
    const el = Object.assign(new El('label', {}, 'Published label'), { isConnected: true });
    const body = new El('div').add(el);
    const p = new Preview({ store: s, ctx: { base: EN, user: EN } } as unknown as AppApi, (fn) => fn());
    const all = [{ key: L1, el, orig: 'Published label' }] as unknown as Anchor[];
    const shown = (step: () => void) => (step(), withPage(body, () => p.apply(all)), el.node.nodeValue);
    eq(shown(() => s.set(L1, EN, 'Draft')), 'Draft', 'staged');
    eq(shown(() => s.revert(L1)), 'Published label', 'undone');
    eq(shown(() => s.group(() => s.set(TIP, EN, 'Other'))), 'Published label', 'another label edited');
    eq(shown(() => s.set(COL, EN, 'Account name')), 'Published label', 'its column renamed');
  });

  test('preview: on a French page, a field showing its column\'s English name (the column has no French one) shows an English rename of the column at once, with no French edit staged anywhere', () => {
    const s = new Store();
    s.add([
      S('field', 'field|f|c1', 'Label', { [EN]: 'Name', [FR]: 'Name' }, { baseRequired: false, ref: { ...MAIN, own: { [EN]: false, [FR]: false } } }),
      S('attribute', 'attribute|acc.name', 'DisplayName', { [EN]: 'Name' }, { ref: { entity: 'acc', attribute: 'name' } }),
    ]);
    const el = Object.assign(new El('label', {}, 'Name'), { isConnected: true });
    const body = new El('div').add(el);
    const p = new Preview({ store: s, ctx: { base: EN, user: FR } } as unknown as AppApi, (fn) => fn());
    s.set(COL, EN, 'Account name');
    withPage(body, () => p.apply(p.showing(COL, [{ key: L1, el }] as unknown as Anchor[])));
    eq(el.node.nodeValue, 'Account name');
  });

  test("preview: on a French page, a field that follows a column with a French name keeps the page's text (a published one) while only English is edited, its column's or its own: no English text shows there", () => {
    const s = new Store();
    s.add([
      S('field', 'field|f|c1', 'Label', { [EN]: 'Name', [FR]: 'Colonne enregistrée' }, { baseRequired: false, ref: { ...MAIN, own: { [EN]: false, [FR]: false } } }),
      S('attribute', 'attribute|acc.name', 'DisplayName', { [EN]: 'Name', [FR]: 'Colonne enregistrée' }, { ref: { entity: 'acc', attribute: 'name' } }),
    ]);
    const el = Object.assign(new El('label', {}, 'Étiquette publiée'), { isConnected: true });
    const body = new El('div').add(el);
    const p = new Preview({ store: s, ctx: { base: EN, user: FR } } as unknown as AppApi, (fn) => fn());
    const all = [{ key: L1, el, orig: 'Étiquette publiée' }] as unknown as Anchor[];
    const shown = (step: () => void) => (step(), withPage(body, () => p.apply(all)), el.node.nodeValue);
    eq(shown(() => s.set(COL, EN, 'Account name')), 'Étiquette publiée', 'its column renamed in English');
    eq(shown(() => s.set(L1, EN, 'Own name')), 'Étiquette publiée', 'its English label edited');
    eq(shown(() => s.set(COL, FR, 'Nom du compte')), 'Nom du compte', 'its column renamed in French');
    eq(shown(() => s.revert(COL)), 'Étiquette publiée', 'undone');
  });

  test(
    '“Also change the other copies” and a label that follows its column: typed in, then emptied, its copy gets the edit it had staged before back, never its loaded text',
    withDom(() => {
      const own = { [EN]: false, [FR]: false };
      const s = mainForm({ [EN]: 'Name', [FR]: 'Nom V4' });
      s.add([{ ...s.get(L1)!, ref: { ...MAIN, own } }, S('field', 'field|f|c2', 'Label', { [EN]: 'Name', [FR]: 'Nom V4' }, { baseRequired: false, ref: { ...MAIN, elId: 'c2', controlId: 'name1', own } })]);
      s.set(L2, FR, 'Nom (copie)');
      const e = open(s, fieldModel({}, { keys: [L2], on: true }), { user: FR });
      e.type(L1, FR, 'x');
      eq([s.value(L1, FR), s.value(L2, FR)], ['x', 'x'], 'typed');
      e.type(L1, FR, '');
      eq([s.isEdited(L1, FR), s.value(L2, FR), s.changes().length], [false, 'Nom (copie)', 1], 'emptied');
    }),
  );

  test(
    "callout: Microsoft's built-in text: a title and one plain line, no inputs; Done and Esc close it",
    withDom(() => {
      const model: CalloutModel = { comp: 'builtin|nav|navAsyncOperations', title: 'Processus en arrière-plan', kind: 'Built-in', icon: 'info', blocks: [], note: BUILTIN_NOTE, loading: false, action: 'Open' };
      const e = open(new Store(), model);
      eq(e.keys(), [], 'nothing to type in');
      ok(e.el.textContent.includes(BUILTIN_NOTE) && e.el.textContent.includes('Processus en arrière-plan'), e.el.textContent);
      ok(!e.el.textContent.includes('Nothing to translate here.'), 'one line, not two');
      ok(e.foot().includes('Done'), e.foot().join());
      fire(e.el, 'keydown', { key: 'Escape' });
      eq(e.closed, 1);
    }),
  );

  test(
    'callout: Esc closes and keeps the text staged',
    withDom(() => {
      const e = open(fixture(), fieldModel());
      e.type(L1, FR, 'Nom complet');
      const ev = fire(e.inp(L1, FR), 'keydown', { key: 'Escape' });
      ok(ev.defaultPrevented, "the app's Esc handler skips it");
      eq([e.closed, e.el.isConnected], [1, false]);
      eq([e.store.value(L1, FR), e.store.isEdited(L1, FR)], ['Nom complet', true]);
    }),
  );

  test(
    'callout: a click outside closes and keeps the text staged; a click inside does not',
    withDom(() => {
      const e = open(fixture(), fieldModel());
      e.type(L1, FR, 'Nom complet');
      const down = (target: FEl) => {
        const path: FNode[] = [];
        for (let n: FNode | null = target; n; n = n.parentNode) path.push(n);
        for (const l of [...dom.doc]) if (l.type === 'pointerdown') l.fn({ ...fire(new FEl('I'), 'none'), type: 'pointerdown', composedPath: () => path });
      };
      down(e.inp(TIP, EN));
      eq(e.closed, 0, 'inside');
      const toast = new FEl('DIV');
      toast.className = 'toast';
      const inToast = new FEl('BUTTON');
      toast.appendChild(inToast);
      down(inToast);
      eq(e.closed, 0, 'our own toast is not outside');
      down(new FEl('DIV'));
      eq([e.closed, e.el.isConnected, e.store.value(L1, FR)], [1, false, 'Nom complet']);
      eq(dom.doc.length, 0, 'listener removed');
    }),
  );

  test(
    'callout: Done, Enter in any text box and Ctrl+Enter close; Shift+Enter in a multi-line text is a new line',
    withDom(() => {
      const a = open(fixture(), fieldModel());
      fire(a.el.querySelector('.co-f .btn.primary')!, 'click');
      eq(a.closed, 1, 'Done');
      const b = open(fixture(), fieldModel());
      fire(b.inp(TIP, FR), 'keydown', { key: 'Enter', shiftKey: true });
      eq(b.closed, 0, 'Shift+Enter in a textarea');
      fire(b.inp(TIP, FR), 'keydown', { key: 'Enter' });
      eq(b.closed, 1, 'Enter in a textarea');
      const b2 = open(fixture(), fieldModel());
      fire(b2.inp(TIP, FR), 'keydown', { key: 'Enter', ctrlKey: true });
      eq(b2.closed, 1, 'Ctrl+Enter');
      const c = open(fixture(), fieldModel());
      c.type(L1, FR, 'Nom 2');
      const ev = fire(c.inp(L1, FR), 'keydown', { key: 'Enter' });
      eq([c.closed, ev.defaultPrevented, c.store.value(L1, FR)], [1, true, 'Nom 2']);
      const d = open(fixture(), fieldModel());
      fire(d.el.querySelector('.co-h button')!, 'click');
      eq(d.closed, 1, '✕');
    }),
  );

  test(
    'callout: closing trims spaces and line breaks at the ends of what was typed, keeps those inside and leaves other texts alone',
    withDom(() => {
      const s = fixture();
      s.set(L1, FR, ' Nom staged '); // staged before the popup opened: not this popup's text
      const e = open(s, fieldModel());
      e.type(TIP, FR, 'Ligne 1\nLigne 2\n');
      fire(e.el.querySelector('.co-f .btn.primary')!, 'click');
      eq([s.value(TIP, FR), s.value(L1, FR)], ['Ligne 1\nLigne 2', ' Nom staged ']);
      const f = open(s, fieldModel());
      f.type(L1, FR, '  Nom complet ');
      fire(f.inp(L1, FR), 'keydown', { key: 'Escape' });
      eq(s.value(L1, FR), 'Nom complet', 'Esc closes and trims too');
    }),
  );

  test(
    'callout: Undo changes shows once something changed and restores the texts as they were when it opened',
    withDom(() => {
      const e = open(fixture(), fieldModel());
      const s = e.store;
      eq(e.foot(), ['Done']);
      e.type(L1, FR, 'Nom complet');
      e.type(TIP, FR, 'Saisissez le nom.');
      eq(e.foot(), ['Undo changes', 'Done']);
      fire(e.el.querySelector('.co-f .link')!, 'click');
      eq([s.value(L1, FR), s.isEdited(L1, FR), s.isEdited(TIP, FR)], ['Nom', false, false]);
      eq([e.inp(L1, FR).value, e.inp(TIP, FR).value], ['Nom', '']);
      eq([e.foot(), e.closed], [['Done'], 0], 'still open');
      eq(e.focused()?.getAttribute('data-k'), `${L1}#1033`, 'the focus stays in the popup');
      // Typing a text back to what it was is not a change.
      e.type(L1, FR, 'X');
      e.type(L1, FR, 'Nom');
      eq(e.foot(), ['Done']);
    }),
  );

  test(
    'callout: opened again on texts staged before, Undo changes shows at once: it first puts back what was changed in it, then takes back the edits staged before (to the server text, one undo step), and the popup goes on from there; never an edit in a language it does not show',
    withDom(() => {
      const s = fixture();
      s.set(TIP, FR, 'Tapez le nom.'); // staged before, then the popup closed
      s.set(L1, DE, 'Name (DE)'); // German, not shown in the popup
      const e = open(s, fieldModel());
      eq(e.foot(), ['Undo changes', 'Done'], 'a text it shows holds a staged edit');
      // Typed in it: the first click puts back what it opened with, the earlier staged tooltip kept.
      e.type(L1, FR, 'Nom complet');
      fire(e.el.querySelector('.co-f .link')!, 'click');
      eq([s.isEdited(L1, FR), s.value(TIP, FR), e.inp(TIP, FR).value, e.foot()], [false, 'Tapez le nom.', 'Tapez le nom.', ['Undo changes', 'Done']]);
      // Nothing changed in it now: the next click takes the staged tooltip back, to the server text.
      fire(e.el.querySelector('.co-f .link')!, 'click');
      eq([s.isEdited(TIP, FR), s.value(TIP, FR), e.inp(TIP, FR).value, e.foot(), e.closed], [false, '', '', ['Done'], 0]);
      eq(s.value(L1, DE), 'Name (DE)', 'German untouched');
      eq(e.focused()?.getAttribute('data-k'), `${L1}#1033`, 'the focus stays in the popup');
      // One undo step: Ctrl+Z on the page brings the tooltip's edit back; Undo changes takes it back again.
      s.undo();
      eq([s.value(TIP, FR), e.inp(TIP, FR).value, e.foot()], ['Tapez le nom.', 'Tapez le nom.', ['Undo changes', 'Done']]);
      fire(e.el.querySelector('.co-f .link')!, 'click');
      eq([s.isEdited(TIP, FR), e.foot()], [false, ['Done']]);
      // Typing in it and closing it work as before from there: Done keeps the typed text staged.
      e.type(L1, FR, 'Nom 2');
      eq(e.foot(), ['Undo changes', 'Done']);
      fire(e.el.querySelector('.co-f .btn.primary')!, 'click');
      eq([s.value(L1, FR), e.closed], ['Nom 2', 1]);
    }),
  );

  test(
    'callout: Ctrl+Z undoes what was typed, also after a reload rendered the inputs again; Ctrl+Y redoes it',
    withDom(() => {
      const e = open(fixture(), fieldModel(), { user: FR }); // the page in French: its input has the focus
      const off = undoOn(e.store);
      const i = e.inp(L1, FR);
      typeIn(i, ' 2');
      eq([i.value, e.store.value(L1, FR)], ['Nom 2', 'Nom 2']);
      e.store.add([{ ...e.store.get(L1)! }]); // the same slot, a new object: the popup renders again
      const j = e.inp(L1, FR);
      ok(j !== i && e.focused() === j, 'a new input, with the focus');
      const z = fire(j, 'keydown', { key: 'z', ctrlKey: true });
      ok(z.defaultPrevented, "never the browser's undo");
      eq([j.value, j.selectionStart, e.store.value(L1, FR), e.store.isEdited(L1, FR)], ['Nom', 3, 'Nom', false], 'staged back, the caret where typing began');
      eq(e.foot(), ['Done'], 'nothing changed here any more');
      fire(j, 'keydown', { key: 'y', ctrlKey: true });
      eq([j.value, e.store.value(L1, FR), e.store.isEdited(L1, FR)], ['Nom 2', 'Nom 2', true], 'redone and staged again');
      ok(j.parentElement!.classList.contains('is-edit'), 'green again');
      off();
    }),
  );

  test(
    'callout: Ctrl+Z after Undo changes brings the typed text back',
    withDom(() => {
      const e = open(fixture(), fieldModel(), { user: FR });
      const off = undoOn(e.store);
      const i = e.inp(L1, FR);
      typeIn(i, ' 2');
      fire(e.el.querySelector('.co-f .link')!, 'click');
      eq([i.value, e.store.isEdited(L1, FR)], ['Nom', false]);
      fire(i, 'keydown', { key: 'z', ctrlKey: true });
      eq([i.value, e.store.value(L1, FR)], ['Nom 2', 'Nom 2'], 'the typed text');
      fire(i, 'keydown', { key: 'z', ctrlKey: true });
      eq([i.value, e.store.isEdited(L1, FR)], ['Nom', false], 'then the text before it');
      off();
    }),
  );

  test(
    'callout: Ctrl+Z / Ctrl+Y on its buttons undo and redo the last staged edit, and the popup follows',
    withDom(() => {
      const e = open(fixture(), fieldModel());
      const off = undoOn(e.store);
      e.type(L1, FR, 'Nom complet');
      const doneB = e.el.querySelector('.co-f .btn.primary')!;
      doneB.focus();
      ok(fire(doneB, 'keydown', { key: 'z', ctrlKey: true }).defaultPrevented, "never the browser's undo");
      eq([e.inp(L1, FR).value, e.store.isEdited(L1, FR), e.foot(), e.closed], ['Nom', false, ['Done'], 0]);
      ok(!e.inp(L1, FR).parentElement!.classList.contains('is-edit'), 'no longer green');
      fire(doneB, 'keydown', { key: 'y', ctrlKey: true });
      eq([e.inp(L1, FR).value, e.store.value(L1, FR), e.foot()], ['Nom complet', 'Nom complet', ['Undo changes', 'Done']]);
      ok(e.inp(L1, FR).parentElement!.classList.contains('is-edit'), 'green again');
      off();
    }),
  );

  test(
    'callout: the copies checkbox: ticked by default when the copies show the same text, and typing follows',
    withDom(() => {
      const s = fixture();
      const e = open(s, fieldModel({}, { keys: [L2], on: true }));
      const cb = e.el.querySelector('.co-also input')!;
      eq([cb.checked, e.el.querySelector('.co-also')!.textContent], [true, 'Also change the other copy of this field on this form']);
      e.type(L1, FR, 'Nom complet');
      e.type(L1, EN, 'Full name');
      eq([s.value(L2, FR), s.value(L2, EN)], ['Nom complet', 'Full name'], 'the copy follows in every language');
      e.type(TIP, FR, 'Tapez');
      eq(s.isEdited(L2, FR) && s.value(L2, FR), 'Nom complet', 'only the label block has copies');
      // Unticked: the copy goes back to how it was; typing no longer follows.
      cb.checked = false;
      fire(cb, 'change');
      eq([s.value(L2, FR), s.isEdited(L2)], ['Nom', false]);
      e.type(L1, FR, 'Nom 3');
      eq(s.value(L2, FR), 'Nom');
      // Ticked again: the copy takes what was changed here.
      cb.checked = true;
      fire(cb, 'change');
      eq([s.value(L2, FR), s.value(L2, EN)], ['Nom 3', 'Full name']);
      // Undo changes puts the copies back too.
      fire(e.el.querySelector('.co-f .link')!, 'click');
      eq([s.isEdited(L1), s.isEdited(L2)], [false, false]);
    }),
  );

  test(
    'callout: the copies checkbox unticked by default leaves the copies alone',
    withDom(() => {
      const s = fixture();
      const e = open(s, fieldModel({}, { keys: [L2], on: false }));
      eq(e.el.querySelector('.co-also input')!.checked, false);
      e.type(L1, FR, 'Nom complet');
      eq([s.value(L2, FR), s.isEdited(L2)], ['Nom', false]);
      const two = open(fixture(), fieldModel({}, { keys: [L2, 'field|f|cx|Label'], on: true }));
      eq(two.el.querySelector('.co-also')!.textContent, 'Also change the 2 other copies of this field on this form');
    }),
  );

  test(
    'callout: choices: closed by default, "Shared by N columns", base and target side by side, open on the clicked value',
    withDom(() => {
      const s = fixture();
      const m = fieldModel({ choices: { keys: [O1, O2], open: false, shared: 3 } });
      const e = open(s, m);
      const dis = e.el.querySelector('.co-dis')!;
      eq([dis.textContent, dis.getAttribute('aria-expanded'), e.keys().some((k) => k.startsWith('option'))], ['Choices (2)', 'false', false]);
      fire(dis, 'click');
      eq(e.el.querySelector('.co-sh')!.textContent, 'Shared by 3 columns');
      eq(e.keys().filter((k) => k.startsWith('option')), [`${O1}#1033`, `${O1}#1036`, `${O2}#1033`, `${O2}#1036`]);
      eq(e.inp(O2, FR).getAttribute('aria-label'), 'Choice “Large”, French');
      e.type(O2, FR, 'Grand');
      eq(s.value(O2, FR), 'Grand');
      const one = open(fixture(), fieldModel({ choices: { keys: [O1, O2], open: true, shared: 1 } }));
      eq([one.el.querySelectorAll('.co-sh').length, one.keys().length], [0, 8], 'one column: no line; open');
      const f = open(fixture(), fieldModel({ choices: { keys: [O1, O2], open: false } }), { focusKey: O2 });
      eq(f.focused()?.getAttribute('data-k'), `${O2}#1033`, 'opened on a value: that option has the focus (the page in English)');
      ok(f.inp(O2, FR).parentElement!.parentElement!.classList.contains('is-focus'));
    }),
  );

  test(
    'callout: a choice value shows the option once: no Label block, every option open, the clicked one focused and highlighted',
    withDom(() => {
      const choice: CalloutModel = { comp: 'option|acc.kind|2', title: 'Large', kind: 'Choice', icon: 'choice', blocks: [], choices: { keys: [O1, O2], open: true, focus: O2 }, loading: false };
      const e = open(fixture(), choice, { focusKey: O2 });
      eq([e.el.querySelector('.co-k')!.textContent, e.el.querySelector('.co-t')!.textContent], ['Choice', 'Large']);
      eq(e.el.querySelectorAll('.co-blk').length, 0, 'no Label block');
      eq(e.el.querySelector('.co-dis')!.getAttribute('aria-expanded'), 'true', 'Choices open');
      eq(e.keys(), [`${O1}#1033`, `${O1}#1036`, `${O2}#1033`, `${O2}#1036`], 'every option of the column, each once');
      eq(e.focused()?.getAttribute('data-k'), `${O2}#1033`, 'the clicked option has the focus');
      eq(e.el.querySelectorAll('.co-cr.is-focus').map((r) => r.querySelector('[data-k]')!.getAttribute('data-k')), [`${O2}#1033`], 'and only its row is highlighted');
      e.type(O2, FR, 'Grand');
      eq(e.store.value(O2, FR), 'Grand');
      // Opened from the list (no clicked element): the model's option takes the focus all the same.
      const d = open(fixture(), choice);
      eq(d.focused()?.getAttribute('data-k'), `${O2}#1033`);
      // A field popup: Form label and Tooltip, Choices closed.
      const fld = open(fixture(), fieldModel({ choices: { keys: [O1, O2], open: false } }));
      eq([fld.el.querySelectorAll('.co-blk').length, fld.el.querySelector('.co-dis')!.getAttribute('aria-expanded')], [2, 'false']);
      eq(fld.focused()?.getAttribute('data-k'), `${L1}#1033`, 'the label, not a choice');
    }),
  );

  test(
    'callout: pending choices: "Choices (2) · 1 changed" in green, open by itself; the caret on the column name in a field\'s popup and in a column\'s, on the first pending choice in a popup without a column name',
    withDom(() => {
      const s = fixture();
      s.set(O2, FR, 'Grand');
      const e = open(s, fieldModel({ blocks: FIELD_BLOCKS, choices: { keys: [O1, O2], open: false } }));
      const dis = e.el.querySelector('.co-dis')!;
      const note = () => e.el.querySelector('.co-dn')!;
      eq([dis.textContent, dis.getAttribute('aria-expanded'), note().className], ['Choices (2) · 1 changed', 'true', 'co-dn is-edit']);
      eq(e.focused()?.getAttribute('data-k'), `${COL}#1033`, "a field's popup: the column name, not the changed choice");
      // Staged here: the note follows at once.
      e.type(O1, FR, 'Petit 2');
      eq(note().textContent, ' · 2 changed');
      // Undo changes: back to how it opened (the earlier staged choice stays).
      fire(e.el.querySelector('.co-f .link')!, 'click');
      eq([note().textContent, s.value(O2, FR), s.isEdited(O1)], [' · 1 changed', 'Grand', false]);
      // Collapsed by the user, the header still says it.
      fire(e.el.querySelector('.co-dis')!, 'click');
      eq([e.el.querySelector('.co-dis')!.getAttribute('aria-expanded'), e.el.querySelector('.co-dis')!.textContent], ['false', 'Choices (2) · 1 changed']);
      // Nothing pending: no note, closed, the label focused.
      const n = open(fixture(), fieldModel({ choices: { keys: [O1, O2], open: false } }));
      eq([n.el.querySelector('.co-dis')!.textContent, n.el.querySelector('.co-dis')!.getAttribute('aria-expanded'), n.focused()?.getAttribute('data-k')], ['Choices (2)', 'false', `${L1}#1033`]);
      // A column's popup (a view's header): its name, not the changed choice.
      const hd = open(s, { comp: 'attribute|acc.name', title: 'Name', kind: 'Column', icon: 'field', blocks: [FIELD_BLOCKS[0], FIELD_BLOCKS[1]], choices: { keys: [O1, O2], open: false }, loading: false });
      eq([hd.focused()?.getAttribute('data-k'), hd.el.querySelector('.co-dis')!.getAttribute('aria-expanded')], [`${COL}#1033`, 'true']);
      // No column name in the popup: the changed choice, the only sign of it.
      const nn = open(s, fieldModel({ choices: { keys: [O1, O2], open: false } }));
      eq(nn.focused()?.getAttribute('data-k'), `${O2}#1033`);
      eq(nn.el.querySelectorAll('.co-cr.is-focus').length, 0, 'focused, not highlighted as a clicked value');
    }),
  );

  test(
    'callout: a choice that failed to publish: "· 1 not published" in red; a popup opened for a choice keeps that one focused',
    withDom(() => {
      const s = fixture();
      s.set(O1, FR, 'Petit (trop long)');
      s.status.set(`${O1}#${FR}`, { outcome: 'error', message: 'Too long' });
      s.set(O2, FR, 'Grand');
      const e = open(s, fieldModel({ choices: { keys: [O1, O2], open: false } }));
      eq([e.el.querySelector('.co-dis')!.textContent, e.el.querySelector('.co-dn')!.className], ['Choices (2) · 2 not published', 'co-dn is-err']);
      eq(e.focused()?.getAttribute('data-k'), `${O1}#1033`, 'no column name in the popup: the first pending one, in option order');
      // A field's popup says it the same way, its column name keeps the caret.
      const fp = open(s, fieldModel({ blocks: FIELD_BLOCKS, choices: { keys: [O1, O2], open: false } }));
      eq([fp.el.querySelector('.co-dis')!.textContent, fp.focused()?.getAttribute('data-k')], ['Choices (2) · 2 not published', `${COL}#1033`]);
      // Opened for a choice (the value the field shows, or a grid cell): that one keeps the focus.
      const v = open(s, { comp: 'option|acc.kind|2', title: 'Large', kind: 'Choice', icon: 'choice', blocks: [], choices: { keys: [O1, O2], open: true, focus: O2 }, loading: false }, { focusKey: O2 });
      eq(v.focused()?.getAttribute('data-k'), `${O2}#1033`);
      const f = open(s, fieldModel({ choices: { keys: [O1, O2], open: false } }), { focusKey: L1 });
      eq([f.focused()?.getAttribute('data-k'), f.el.querySelector('.co-dis')!.getAttribute('aria-expanded')], [`${L1}#1033`, 'true'], 'asked for the label: the label, Choices still open');
    }),
  );

  test(
    'callout: a process step of a choice column (its pill follows the step label): Choices open, "· 1 changed", the changed choice focused',
    withDom(() => {
      const s = new Store();
      const opt = (v: number, labels: Record<number, string>) => S('option', `option|acc.kind|${v}`, 'Label', labels, { order: v, ref: { entity: 'acc', attribute: 'kind', value: v } });
      s.add([S('step', 'step|w|s1', 'Label', { [EN]: 'Kind', [FR]: 'Type' }, { ref: { workflowId: 'w', labelId: 's1', attribute: 'kind' } }), opt(1, { [EN]: 'Small', [FR]: 'Petit' }), opt(2, { [EN]: 'Large' })]);
      s.set(O2, FR, 'Grand');
      const ctx = { base: EN, user: EN, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] };
      const app = { store: s, ctx, prefs: { target: FR, shown: [], showNames: false, dock: 'right' } } as unknown as AppApi;
      const e = open(s, () => describe(app, 'step|w|s1'));
      const dis = e.el.querySelector('.co-dis')!;
      eq([e.el.querySelector('.co-k')!.textContent, dis.textContent, dis.getAttribute('aria-expanded')], ['Step', 'Choices (2) · 1 changed', 'true']);
      eq(e.focused()?.getAttribute('data-k'), `${O2}#1033`, 'the changed choice, not the step label');
    }),
  );

  test(
    'callout: read-only: inputs disabled and one muted line with the reason',
    withDom(() => {
      const s = new Store();
      s.add([S('attribute', 'attribute|acc.created', 'DisplayName', { [EN]: 'Created On' }, { readOnly: 'Managed and not customizable.' })]);
      const e = open(s, { comp: 'attribute|acc.created', title: 'Created On', kind: 'Column', icon: 'field', blocks: [{ key: 'attribute|acc.created|DisplayName', heading: 'Column name', long: false }], readOnly: 'Managed and not customizable', loading: false });
      ok(e.el.querySelectorAll('.ti').every((x) => x.disabled), 'disabled');
      eq(e.el.querySelectorAll('.co-ro').map((x) => x.textContent), ['Managed and not customizable']);
      eq(e.foot(), ['Done']);
    }),
  );

  test(
    "callout: a column from a managed solution on a form of this environment: its name and tooltip are read-only, each with the lock note, while the form's own label stays editable; on a form from a managed solution nothing is editable and one line says why",
    withDom(() => {
      const s = fixture();
      const col = { entity: 'acc', attribute: 'name', managed: true };
      s.add([S('attribute', 'attribute|acc.name', 'DisplayName', { [EN]: 'Name', [FR]: 'Nom' }, { ref: col }), S('attribute', 'attribute|acc.name', 'Description', { [EN]: 'Type the name.' }, { ref: col })]);
      const ctx = { base: EN, user: EN, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] };
      const app = { store: s, ctx, prefs: { target: FR, shown: [], showNames: false, dock: 'right' } } as unknown as AppApi;
      const md = describe(app, 'field|f|c1');
      eq([md.blocks.map((b) => b.key), md.readOnly], [[COL, TIP, L1], undefined]);
      const e = open(s, md);
      eq(e.focused()?.getAttribute('data-k'), `${L1}#1033`, "the column's name read-only: the caret in the form's own label");
      eq([e.inp(L1, FR).disabled, e.inp(TIP, FR).disabled, e.inp(COL, FR).disabled], [false, true, true]);
      const why = MANAGED.replace(/\.$/, '');
      eq(e.el.querySelectorAll('.co-ro').map((x) => x.textContent), [why, why]);
      e.type(L1, FR, 'Nom complet');
      eq(s.value(L1, FR), 'Nom complet', "the form's own label is staged");
      s.set(TIP, FR, 'Tapez le nom.');
      s.set(COL, FR, 'Nom 2');
      eq([s.isEdited(TIP), s.isEdited(COL)], [false, false], 'nothing staged on the column');
      e.co.destroy();
      // The form itself from a managed solution: its cells too.
      s.revert(L1);
      for (const k of [L1, L2]) s.add([{ ...s.get(k)!, readOnly: '', ref: { ...s.get(k)!.ref, managed: true } }]);
      const all = describe(app, 'field|f|c1');
      eq(all.readOnly, why);
      const e2 = open(s, all);
      ok(e2.el.querySelectorAll('.ti').every((x) => x.disabled), 'every input disabled');
      ok(e2.focused() === e2.el, 'nothing to type in, not even the column name: the dialog itself has the focus');
      eq(e2.el.querySelectorAll('.co-ro').map((x) => x.textContent), [why], 'one line');
    }),
  );

  test(
    "callout: where this session allows changes to managed labels (Store.managedEdits), a managed column's name and tooltip its loader set up for that are editable, each with the amber line on what saving does; one still read-only (not customizable) keeps its lock line; off again, read-only with the managed reason",
    withDom(() => {
      const s = fixture();
      const NOT = "This column is marked as not customizable (its “Allow customizations” managed property is off), so its labels can't be changed here.";
      const col = { entity: 'acc', attribute: 'name', managed: true, held: MANAGED };
      s.add([S('attribute', 'attribute|acc.name', 'DisplayName', { [EN]: 'Name', [FR]: 'Nom' }, { ref: { ...col, lock: '' } }), S('attribute', 'attribute|acc.name', 'Description', { [EN]: 'Type the name.' }, { ref: { ...col, lock: NOT } })]);
      s.setManagedEdits(true);
      const ctx = { base: EN, user: EN, langs: [{ lcid: EN, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] };
      const app = { store: s, ctx, prefs: { target: FR, shown: [], showNames: false, dock: 'right' } } as unknown as AppApi;
      const e = open(s, describe(app, 'field|f|c1'));
      eq([e.inp(COL, FR).disabled, e.inp(TIP, FR).disabled, e.inp(L1, FR).disabled], [false, true, false]);
      eq(
        e.el.querySelectorAll('.co-ro').map((x) => [x.className, x.textContent]),
        [['co-ro is-warn', MANAGED_OPEN.replace(/\.$/, '')], ['co-ro', NOT.replace(/\.$/, '')]],
      );
      e.type(COL, FR, 'Nom 2');
      eq(s.value(COL, FR), 'Nom 2', 'staged');
      e.co.destroy();
      s.revert(COL);
      s.setManagedEdits(false);
      const e2 = open(s, describe(app, 'field|f|c1'));
      eq([e2.inp(COL, FR).disabled, e2.el.querySelectorAll('.co-ro').map((x) => x.textContent)], [true, [MANAGED.replace(/\.$/, ''), MANAGED.replace(/\.$/, '')]]);
    }),
  );

  test(
    "callout: the model's action is the footer's secondary button",
    withDom(() => {
      const e = open(fixture(), fieldModel({ action: 'Open' }));
      eq(e.foot(), ['Open', 'Done']);
      fire(e.el.querySelector('.co-f')!.querySelector('button')!, 'click');
      eq([e.acted, e.closed], [1, 0]);
    }),
  );

  test(
    'callout: the secondary action trims what was typed and leaves closing to the host',
    withDom(() => {
      const e = open(fixture(), fieldModel({ action: 'Show tab' }));
      e.type(L1, FR, 'Nom complet  ');
      fire(e.el.querySelector('.co-f')!.querySelector('button')!, 'click');
      eq([e.acted, e.closed, e.store.value(L1, FR)], [1, 0, 'Nom complet']);
    }),
  );

  test(
    "callout: a secondary action that could do nothing keeps the popup open and says so, until it renders again",
    withDom(() => {
      const s = fixture();
      const e = open(s, fieldModel({ action: 'Open' }), { act: () => false });
      const line = () => e.el.querySelector('.co-fx')!;
      eq([line().hidden, line().textContent], [true, '']);
      fire(e.el.querySelector('.co-f')!.querySelector('button')!, 'click');
      eq([e.acted, e.closed, e.el.isConnected], [1, 0, true]);
      eq([line().hidden, line().textContent], [false, "Couldn't do that from here. Alt+click it on the page."]);
      ok(e.el.querySelector('.vh')!.textContent.startsWith("Couldn't do that"), 'announced');
      s.add([{ ...s.get(L1)! }]); // its slots reloaded: it renders again
      eq(line().hidden, true);
    }),
  );

  test(
    'callout: Done gives the focus back to a row or button of ours, never to a Dynamics text field clicked before the label',
    withDom(() => {
      const doc = document as unknown as { activeElement: unknown; body: unknown };
      const page = new FEl('#DOC');
      page.connected = true;
      const field = new FEl('INPUT');
      page.appendChild(field);
      doc.activeElement = field;
      const a = open(fixture(), fieldModel());
      ok(a.focused()?.getAttribute('data-k') === `${L1}#1033`, 'its input has the focus');
      fire(a.el.querySelector('.co-f .btn.primary')!, 'click');
      eq([a.closed, page.activeElement], [1, null], 'the field is not focused again: Ctrl+Z on the page undoes the staged edit');
      const row = new FEl('DIV');
      row.tabIndex = 0;
      dom.layer.appendChild(row);
      doc.activeElement = row;
      const b = open(fixture(), fieldModel());
      fire(b.el.querySelector('.co-f .btn.primary')!, 'click');
      ok(dom.root.activeElement === row, 'a row of the list: focused again');
      // The secondary action closed it without moving the focus (it fell to the body): back to a page button reached with F2.
      const btnEl = new FEl('BUTTON');
      page.appendChild(btnEl);
      doc.activeElement = btnEl;
      const c = open(fixture(), fieldModel({ action: 'Show tab' }), {
        act: (env) => {
          env.co.destroy();
          doc.activeElement = doc.body;
          return true;
        },
      });
      fire(c.el.querySelector('.co-f')!.querySelector('button')!, 'click');
      ok(page.activeElement === btnEl, 'the opener is focused again');
      // One that moved the focus (the form API focused a tab) keeps it there.
      const tabEl = new FEl('BUTTON');
      page.appendChild(tabEl);
      doc.activeElement = btnEl;
      page.activeElement = null;
      const d = open(fixture(), fieldModel({ action: 'Show tab' }), {
        act: (env) => {
          env.co.destroy();
          doc.activeElement = tabEl;
          return true;
        },
      });
      fire(d.el.querySelector('.co-f')!.querySelector('button')!, 'click');
      eq(page.activeElement, null, 'not taken back');
    }),
  );

  test(
    "callout: Done after what had the focus left the page (an item of a selector's list reached with F2, the list closed as the popup took the focus): the host puts it where the keyboard goes on (the list's button); never after the secondary action",
    withDom(() => {
      const doc = document as unknown as { activeElement: unknown; body: unknown };
      const page = new FEl('#DOC');
      page.connected = true;
      const listButton = new FEl('BUTTON');
      page.appendChild(listButton);
      let refocused = 0;
      const refocus = () => (refocused++, listButton.focus(), true);
      /** A list open on the page with an item focused; the popup opens from it, then the list closes. */
      const fromItem = (o: { act?: (env: Env) => boolean } = {}) => {
        const list = new FEl('DIV');
        const item = new FEl('BUTTON');
        list.appendChild(item);
        page.appendChild(list);
        doc.activeElement = item;
        const e = open(fixture(), fieldModel({ action: 'Open' }), { refocus, ...o });
        list.remove();
        return e;
      };
      const a = fromItem();
      ok(a.focused()?.getAttribute('data-k') === `${L1}#1033`, 'its input has the focus');
      fire(a.el.querySelector('.co-f .btn.primary')!, 'click');
      eq([a.closed, refocused], [1, 1]);
      ok(page.activeElement === listButton, "the list's button");
      // Esc too.
      const b = fromItem();
      fire(b.inp(L1, EN), 'keydown', { key: 'Escape' });
      eq([b.closed, refocused], [1, 2]);
      // Open: the page moves on (it switches), the focus is left where it fell.
      page.activeElement = null;
      const c = fromItem({
        act: (env) => {
          env.co.destroy();
          doc.activeElement = doc.body;
          return true;
        },
      });
      fire(c.el.querySelector('.co-f')!.querySelector('button')!, 'click');
      eq([c.acted, refocused], [1, 2]);
      ok(page.activeElement === null, 'not focused');
      // What had the focus is still there: it gets it back, the host isn't asked.
      const row = new FEl('DIV');
      row.tabIndex = 0;
      dom.layer.appendChild(row);
      doc.activeElement = row;
      const d = open(fixture(), fieldModel(), { refocus });
      fire(d.el.querySelector('.co-f .btn.primary')!, 'click');
      ok(dom.root.activeElement === row);
      eq(refocused, 2);
    }),
  );

  test(
    'callout: reopened on a staged text, Ctrl+Z in its input goes back to the server text (unstaged); Ctrl+Y stages the edit again',
    withDom(() => {
      const s = fixture();
      s.set(L1, FR, 'Nom 2'); // staged in an earlier popup
      const e = open(s, fieldModel(), { user: FR });
      const off = undoOn(s);
      const i = e.inp(L1, FR);
      ok(e.focused() === i, 'its input (the page in French) has the focus');
      ok(fire(i, 'keydown', { key: 'z', ctrlKey: true }).defaultPrevented);
      eq([i.value, s.value(L1, FR), s.isEdited(L1, FR)], ['Nom', 'Nom', false]);
      ok(!i.parentElement!.classList.contains('is-edit'), 'no longer green');
      fire(i, 'keydown', { key: 'y', ctrlKey: true });
      eq([i.value, s.value(L1, FR), s.isEdited(L1, FR)], ['Nom 2', 'Nom 2', true]);
      ok(i.parentElement!.classList.contains('is-edit'), 'green again');
      // A text that isn't staged: nothing to go back to.
      const t = e.inp(TIP, FR);
      t.focus();
      ok(fire(t, 'keydown', { key: 'z', ctrlKey: true }).defaultPrevented);
      eq([t.value, s.isEdited(TIP, FR), s.value(L1, FR)], ['', false, 'Nom 2']);
      off();
    }),
  );

  test(
    'callout: it stays put while a pointer is pressed in it, so the click lands on the button pressed',
    withDom(() => {
      let r: Box | null = box(100, 100, 60, 20);
      const e = open(fixture(), fieldModel({ action: 'Open' }), { rect: () => r });
      const place = () => [e.el.style.left, e.el.style.top];
      const at = place();
      const release = () => {
        for (const l of [...dom.doc]) if (l.type === 'pointerup') l.fn(fire(new FEl('I'), 'none'));
      };
      // Pressing Open closed the menu its label was in: the label moved (or went), the popup doesn't, until the release.
      fire(e.el.querySelector('.co-f')!.querySelector('button')!, 'pointerdown');
      r = box(400, 300, 60, 20);
      e.co.reposition();
      eq(place(), at, 'frozen while pressed');
      release();
      e.co.reposition();
      ok(place()[0] !== at[0], 'follows its label again after the release');
      // Its label went away (docked), and something re-places it while Done is pressed: Done still closes it.
      r = null;
      e.co.reposition();
      const docked = place();
      const doneB = e.el.querySelector('.co-f .btn.primary')!;
      fire(doneB, 'pointerdown');
      r = box(100, 100, 60, 20);
      e.co.reposition();
      eq(place(), docked);
      release();
      fire(doneB, 'click');
      eq([e.closed, e.el.isConnected], [1, false]);
      eq(dom.doc.length, 0, 'listeners removed');
    }),
  );

  test(
    'callout: pointing at a row of the list sheet (host.beside), it opens beside the sheet wherever the sheet is; at a page label, as always',
    withDom(() => {
      // A 1000 × 800 window (the fake innerWidth and innerHeight).
      let at: Box = box(9, 300, 358, 44);
      let sheet: Box | null = box(8, 8, 360, 640);
      const e = open(fixture(), fieldModel(), { rect: () => at, beside: () => sheet });
      Object.assign(e.el, { offsetWidth: 400 });
      const place = () => [e.el.style.left, ['is-left', 'is-right', 'is-below', 'is-above'].filter((c) => e.el.classList.contains(c))];
      e.co.reposition();
      eq(place(), ['384px', ['is-right']], 'floating at the left edge: on its right');
      at = box(640, 300, 360, 44);
      sheet = box(640, 0, 360, 800);
      e.co.reposition();
      eq(place(), ['224px', ['is-left']], 'docked on the right: on its left');
      at = box(100, 100, 60, 20);
      sheet = null;
      e.co.reposition();
      eq(place(), ['100px', ['is-below']], 'a label on the page');
      e.co.destroy();
    }),
  );

  test(
    'callout: Tab past the last control wraps to the first input',
    withDom(() => {
      const e = open(fixture(), fieldModel());
      const done = e.el.querySelector('.co-f .btn.primary')!;
      done.focus();
      const ev = fire(done, 'keydown', { key: 'Tab' });
      ok(ev.defaultPrevented);
      eq(e.focused()?.getAttribute('data-k'), `${L1}#1033`);
      const first = e.el.querySelector('.co-h button')!;
      first.focus();
      fire(first, 'keydown', { key: 'Tab', shiftKey: true });
      ok(e.focused() === done, 'Shift+Tab before the first control: the last one');
    }),
  );

  test(
    'callout: a reload of its slots re-renders with the new texts; the snapshot keeps what was there when it opened',
    withDom(() => {
      const s = fixture();
      const e = open(s, fieldModel());
      s.add([{ ...s.get(L1)!, labels: { [EN]: 'Name', [FR]: 'Nom (serveur)' } }]);
      eq(e.inp(L1, FR).value, 'Nom (serveur)');
      eq(e.foot(), ['Done'], 'not a change made here');
      e.co.destroy();
      eq([e.el.isConnected, e.closed], [false, 0], 'destroy() by the host does not call close()');
    }),
  );

  // ---- placement ----
  test('callout: placed below-start of the label with the beak on it', () => {
    const p = placeCallout(box(100, 100, 120, 20), 400, 300, 1200, 800);
    eq(p, { left: 100, top: 136, maxH: 800 - 120 - 16 - 8, side: 'below', beak: 24 });
  });
  test('callout: flips above when there is no room below, else takes the side with more room', () => {
    const p = placeCallout(box(100, 600, 120, 20), 400, 300, 1200, 800);
    eq([p.side, p.top, p.beak !== null], ['above', 600 - 16 - 300, true]);
    const q = placeCallout(box(100, 300, 120, 20), 400, 500, 1200, 700);
    eq([q.side, q.maxH], ['below', 700 - 320 - 16 - 8]);
    const r = placeCallout(box(100, 420, 120, 20), 400, 500, 1200, 700);
    eq([r.side, r.maxH, r.top], ['above', 420 - 16 - 8, 8]);
  });
  test('callout: clamped 8 px inside the viewport, the beak stays on the callout', () => {
    const p = placeCallout(box(1150, 100, 40, 20), 400, 200, 1200, 800);
    eq(p.left, 1200 - 400 - 8);
    ok(p.beak! >= 12 && p.beak! <= 400 - 12, 'beak inside');
    eq(p.beak, 1150 + 20 - p.left);
    const n = placeCallout(box(-30, 100, 60, 20), 400, 200, 1200, 800);
    eq([n.left, n.beak], [8, 12]);
  });
  test('callout: with no label it docks above the bar (or below it when the bar is at the top)', () => {
    const d = placeCallout(null, 400, 300, 1200, 800);
    eq(d, { left: 400, top: 800 - 64 - 12 - 300, maxH: 800 - 64 - 12 - 8, side: 'dock', beak: null });
    const bar = box(300, 700, 600, 48);
    const e = placeCallout(null, 400, 300, 1200, 800, bar);
    eq([e.left, e.top], [400, 700 - 12 - 300]);
    const topBar = placeCallout(null, 400, 300, 1200, 800, box(300, 16, 600, 48));
    eq([topBar.top, topBar.maxH], [16 + 48 + 12, 800 - 64 - 12 - 8]);
  });
  test('callout: a label scrolled out of view keeps it at the nearest edge without a beak', () => {
    const up = placeCallout(box(100, -80, 120, 20), 400, 300, 1200, 800);
    eq([up.top, up.side, up.beak], [8, 'dock', null]);
    const down = placeCallout(box(100, 900, 120, 20), 400, 300, 1200, 800);
    eq(down.top, 800 - 8 - 300);
  });
  test('callout: opened from a row of the list sheet it sits to the left of the row, beak on the row', () => {
    const row = box(840, 300, 360, 36);
    const p = placeCallout(row, 400, 300, 1200, 800, null, box(840, 0, 360, 800));
    eq([p.side, p.left, p.top, p.beak], ['left', 840 - 16 - 400, 318 - 24, 24]);
    const narrow = placeCallout(box(300, 300, 360, 36), 400, 300, 700, 800, null, box(300, 0, 400, 800));
    ok(narrow.side !== 'left' && narrow.side !== 'right', 'no room on either side: below or above as usual');
  });
  test('callout: opened from a row of the sheet floating where it was dragged, it sits beside the sheet, never over the list', () => {
    // Floating at the left edge (8, 8, 360 × 640): no room on its left, so on its right, the beak on the row.
    const sheet = box(8, 8, 360, 640);
    const p = placeCallout(box(9, 300, 358, 44), 400, 300, 1200, 800, null, sheet);
    eq([p.side, p.left, p.top, p.beak], ['right', 8 + 360 + 16, 322 - 24, 24]);
    ok(p.left >= sheet.right, 'clear of the list');
    // Floating in the middle with room on its left: on its left, like docked.
    const mid = placeCallout(box(501, 120, 358, 44), 400, 300, 1200, 800, null, box(500, 100, 360, 640));
    eq([mid.side, mid.left], ['left', 500 - 16 - 400]);
    // Room on both sides: the left, as docked; too little on the left (400 px, the popup and its gaps need 424): the right.
    eq(placeCallout(box(451, 120, 358, 44), 400, 300, 1400, 800, null, box(450, 100, 360, 640)).side, 'left');
    eq(placeCallout(box(401, 120, 358, 44), 400, 300, 1200, 800, null, box(400, 100, 360, 640)).side, 'right');
    // A label on the page is placed as always, wherever the sheet is.
    eq(placeCallout(box(700, 300, 120, 20), 400, 300, 1200, 800).side, 'below');
  });
  test('callout: once shown it stays on its side while it nearly fits there (48 px short at most), and moves only where the other side takes it clearly better', () => {
    // A label at 300 in a 700 px window: 356 px of room below it, 276 above.
    const mid = box(100, 300, 120, 20);
    eq(placeCallout(mid, 400, 250, 1200, 700).side, 'below', 'fits on both sides: below');
    eq(placeCallout(mid, 400, 250, 1200, 700, null, null, 'above').side, 'above', 'shown above, where it fits: it stays');
    // Lower, at 400: 256 px below, 376 above. 280 px tall (a message line grew it): 24 px short below.
    const low = box(100, 400, 120, 20);
    eq(placeCallout(low, 400, 280, 1200, 700).side, 'above', 'opening: where it fits');
    const p = placeCallout(low, 400, 280, 1200, 700, null, null, 'below');
    eq([p.side, p.top, p.maxH, p.beak !== null], ['below', 436, 256, true], 'shown below: it stays, its body scrolls 24 px');
    eq(placeCallout(low, 400, 320, 1200, 700, null, null, 'below').side, 'above', '64 px short, and it fits above: it moves');
    // Fitting on neither side (500 px tall): the side it is on, until the other has 48 px more room.
    eq([placeCallout(box(100, 360, 120, 20), 400, 500, 1200, 700).side, placeCallout(box(100, 360, 120, 20), 400, 500, 1200, 700, null, null, 'below').side], ['above', 'below'], '40 px more above: it stays below');
    eq(placeCallout(low, 400, 500, 1200, 700, null, null, 'below').side, 'above', '120 px more above: it moves');
    eq(placeCallout(box(100, 330, 120, 20), 400, 500, 1200, 700, null, null, 'above').side, 'above', '20 px more below: it stays above');
  });
  test('callout: an opening popup shows once its place held for two frames; while the label it opened at is gone it waits, 300 ms at most', () => {
    eq(settle(0, true, false, 16), { held: 1, show: false });
    eq(settle(1, true, false, 33), { held: 2, show: true }, 'two frames in the same place');
    eq(settle(1, false, false, 33), { held: 0, show: false }, 'moved: it counts again');
    eq(settle(1, true, true, 33), { held: 0, show: false }, 'its label gone (docked meanwhile): never shown there');
    eq(settle(0, false, true, 300), { held: 0, show: true }, 'gone for good: it shows wherever it is');
  });
  test(
    'callout: opened at an option of a dropdown list it shows where it stays: never at the option (the list closes as it takes the focus) nor docked meanwhile, but at the field once the host points there',
    withDom(() => {
      const frames: Array<() => void> = [];
      Object.defineProperty(globalThis, 'requestAnimationFrame', { value: (f: () => void) => frames.push(f), configurable: true, writable: true });
      const frame = () => frames.splice(0).forEach((f) => f());
      const perf = globalThis.performance;
      const realNow = perf.now;
      // A whole number: from a fractional one, adding 299 then 1 can come to 299.99999999999994 ms waited.
      let t0 = 1000;
      perf.now = () => t0;
      try {
        const model = { comp: 'option|acc.kind|1', title: 'Small', kind: 'Choice', icon: 'edit', blocks: [], loading: false, choices: { keys: [O1, O2], open: true, focus: O1 } } as CalloutModel;
        const look = (e: Env) => [!e.el.classList.contains('is-wait'), ['is-below', 'is-above', 'is-dock'].filter((c) => e.el.classList.contains(c))];
        // A label that stays: laid out at once, shown two frames later where it was laid out (the first place shown is the last).
        const plain = open(fixture(), fieldModel(), { rect: () => box(100, 100, 60, 20) });
        const laid = [plain.el.style.left, plain.el.style.top];
        eq(look(plain), [false, ['is-below']], 'laid out, not shown yet');
        frame();
        eq(look(plain)[0], false);
        frame();
        eq([look(plain), [plain.el.style.left, plain.el.style.top]], [[true, ['is-below']], laid], 'shown where it was laid out');
        plain.co.destroy();
        // The option, in the list open under its field near the top of the 800 px window.
        let r: Box | null = box(100, 200, 120, 20);
        const e = open(fixture(), model, { rect: () => r, focusKey: O1 });
        eq([look(e), e.focused()?.getAttribute('data-k')], [[false, ['is-below']], `${O1}#1033`], 'laid out at the option and focused, not shown');
        // The list closed as the popup took the focus: no label (docked) until the host points at the field.
        r = null;
        frame();
        frame();
        frame();
        eq(look(e), [false, ['is-dock']], 'not shown docked meanwhile');
        // The field, low in the window: above it.
        r = box(100, 760, 120, 30);
        frame();
        frame();
        eq(look(e), [false, ['is-above']], 'not before its place held');
        frame();
        eq(look(e), [true, ['is-above']], 'shown at the field');
        eq(frames.length, 0, 'no frame asked for once shown');
        e.co.destroy();
        // Its label gone for good: after 300 ms it shows docked.
        r = box(100, 200, 120, 20);
        const g = open(fixture(), model, { rect: () => r, focusKey: O1 });
        r = null;
        frame();
        t0 += 299;
        frame();
        eq(look(g)[0], false);
        t0 += 1;
        frame();
        eq(look(g), [true, ['is-dock']]);
        g.co.destroy();
        // Laid out below its label, which then moves low before the popup shows: still opening, it picks its side
        // afresh (above), never keeping the side it was only laid out on (once shown, a side sticks: STICK).
        r = box(100, 200, 120, 20);
        const m = open(fixture(), model, { rect: () => r, focusKey: O1 });
        eq(look(m), [false, ['is-below']], 'laid out below');
        r = box(100, 760, 120, 30);
        frame();
        frame();
        frame();
        eq(look(m), [true, ['is-above']], 'shown above: the side chosen where it shows');
        m.co.destroy();
      } finally {
        perf.now = realNow;
      }
    }),
  );
  test('callout: a very small window lets it cover its label instead of leaving the screen', () => {
    const p = placeCallout(box(10, 100, 50, 20), 300, 500, 400, 300);
    ok(p.top >= 8 && p.top + Math.min(500, p.maxH) <= 300 - 8 + 1, 'inside');
    eq(p.beak, null);
  });
}
