// Unit tests for the overlay (inspector/overlay.ts) against a tiny fake DOM: what is taken over, what reaches the
// page, Alt, pause and stop, and the marks one frame draws (text line boxes only, hover, open popup, flash,
// read-only, cut under the page's popups). The geometry rules themselves are covered by overlay.ts's pure-helper tests.
// The fake globals are installed for each test and removed after it, so other test files never see them.
import type { Anchor, Look, OverlayHooks, Pill } from '../../../src/inspector/types';
import type { Kit } from './kit';
import css from '../../../src/inspector/overlay.css';

type L = (e: unknown) => void;

/** The next node up: the parent element, else the parent node (a shadow root), else a shadow root's host. */
const up = (n: FakeNode): FakeNode | null => n.parentElement ?? n.parentNode ?? (n as unknown as { host?: FakeEl }).host ?? null;

class FakeNode {
  parentElement: FakeEl | null = null;
  /** Set only for the children of a shadow root (their parentElement is null, as in the DOM). */
  parentNode: FakeNode | null = null;
  children: FakeEl[] = [];
  get isConnected(): boolean {
    for (let n: FakeNode | null = this; n; n = up(n)) if (n === dom.doc) return true;
    return false;
  }
  append(...cs: unknown[]): void {
    for (const c of cs) if (c instanceof FakeEl) this.appendChild(c);
  }
  appendChild(c: FakeEl): FakeEl {
    c.remove();
    c.parentElement = this as unknown as FakeEl;
    this.children.push(c);
    return c;
  }
  contains(n: unknown): boolean {
    for (let x = n as FakeEl | null; x; x = x.parentElement) if (x === (this as unknown)) return true;
    return false;
  }
}
export class FakeEl extends FakeNode {
  style: Record<string, string> = {};
  className = '';
  hidden = false;
  type = '';
  isContentEditable = false;
  attrs: Record<string, string> = {};
  /** Border box (left, top, right, bottom); visibility (display/visibility/opacity) of this element alone. */
  rect: [number, number, number, number] = [0, 0, 0, 0];
  vis = true;
  cs: Record<string, string> = {};
  nodeValue: string | null = null;
  /** A text node's client rects (one per line). */
  rects: Array<{ left: number; top: number; right: number; bottom: number }> = [];
  shadowRoot: FakeNode | null = null;
  classList = { toggle: (c: string, on: boolean) => void (this.className = on ? `${this.className} ${c}` : this.className.replace(` ${c}`, '')) };
  constructor(public tagName: string) {
    super();
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  attachShadow(): FakeNode {
    const r = new FakeNode();
    (r as unknown as { host: FakeEl }).host = this;
    this.shadowRoot = r;
    return r;
  }
  checkVisibility(): boolean {
    for (let n: FakeEl | null = this; n; n = n.parentElement) if (!n.vis) return false;
    return true;
  }
  get clientWidth() {
    return this.rect[2] - this.rect[0];
  }
  get clientHeight() {
    return this.rect[3] - this.rect[1];
  }
  get offsetWidth() {
    return this.rect[2] - this.rect[0];
  }
  clientLeft = 0;
  clientTop = 0;
  remove(): void {
    const p = this.parentElement;
    if (p) p.children = p.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  /** A tag name, an id (`#x`) and attributes (`[k]`, `[k="v"]`, `[k^="v"]`, `[k$="v"]`), alone or compound (`button[k][j="v"]`). */
  matches(sel: string): boolean {
    return sel.split(',').some((s) => {
      const m = /^([a-z][a-z0-9-]*)?(?:#([\w-]+))?((?:\[[^\]]+\])*)$/i.exec(s.trim());
      if (!m || (!m[1] && !m[2] && !m[3])) return false;
      const [, tag, id, attrs] = m;
      if (tag && tag.toLowerCase() !== this.tagName.toLowerCase()) return false;
      if (id && this.attrs.id !== id) return false;
      return (attrs.match(/\[[^\]]+\]/g) || []).every((a) => {
        const [, k, op, want] = /^\[([\w-]+)(?:([\^$]?=)"([^"]*)")?\]$/.exec(a) || [];
        const v = k ? this.attrs[k] : undefined;
        return v !== undefined && (want === undefined || (op === '^=' ? v.startsWith(want) : op === '$=' ? v.endsWith(want) : v === want));
      });
    });
  }
  getBoundingClientRect() {
    const [left, top, right, bottom] = this.checkVisibility() ? this.rect : [0, 0, 0, 0];
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }
  querySelector(): null {
    return null;
  }
  /** By tag name only. */
  closest(sel: string): FakeEl | null {
    for (let n: FakeEl | null = this; n; n = n.parentElement) if (n.tagName.toLowerCase() === sel) return n;
    return null;
  }
  /** A canvas measures 8 px per character. */
  getContext(): unknown {
    return this.tagName === 'CANVAS' ? { font: '', measureText: (t: string) => ({ width: t.length * 8 }) } : null;
  }
  addEventListener(): void {}
}

export const dom = {
  doc: null as unknown as FakeEl,
  listeners: [] as Array<{ type: string; fn: L; capture: boolean }>,
  raf: null as null | (() => void),
  layers: [] as FakeEl[],
  /** What querySelectorAll finds for the overlay's portal roots (PORTALS). */
  portals: [] as FakeEl[],
  hit: null as FakeEl | null,
};
const text = (v: string, rects: Array<[number, number, number, number]> = []) => {
  const t = new FakeEl('#TEXT');
  t.nodeValue = v;
  t.rects = rects.map(([left, top, right, bottom]) => ({ left, top, right, bottom }));
  return t;
};
function* walk(n: FakeEl): Generator<FakeEl> {
  for (const c of n.children) {
    if (c.tagName === '#TEXT') yield c;
    yield* walk(c);
  }
}

const GLOBALS = ['document', 'addEventListener', 'removeEventListener', 'MutationObserver', 'CSSStyleSheet', 'requestAnimationFrame', 'cancelAnimationFrame', 'visualViewport', 'innerWidth', 'innerHeight', 'devicePixelRatio', 'getComputedStyle', 'window', 'Element', 'HTMLElement', 'DOMRect', 'NodeFilter'];

export function install(): () => void {
  const saved = GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  const html = new FakeEl('HTML');
  const body = new FakeEl('BODY');
  html.appendChild(body);
  dom.doc = html;
  dom.listeners = [];
  const cap = (o: unknown) => (typeof o === 'boolean' ? o : !!(o as { capture?: boolean } | undefined)?.capture);
  const g = globalThis as Record<string, unknown>;
  const set = (k: string, v: unknown) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  set('document', {
    documentElement: html,
    body,
    adoptedStyleSheets: [],
    createElement: (t: string) => new FakeEl(t.toUpperCase()),
    createTextNode: () => new FakeEl('#TEXT'),
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: (s: string) => (s.includes('__fluentPortalMountNode') ? dom.portals : dom.layers),
    elementFromPoint: () => dom.hit,
    createRange: () => {
      let n: FakeEl | null = null;
      let part: [number, number] | null = null;
      return {
        selectNodeContents: (x: FakeEl) => void ((n = x), (part = null)),
        setStart: (x: FakeEl, o: number) => void ((n = x), (part = [o, o])),
        setEnd: (_x: FakeEl, o: number) => void (part = [part ? part[0] : 0, o]),
        // A text node in a hidden element has no boxes. Part of a one-line text: 8 px per character from its start.
        getClientRects: () => {
          if (!n || !n.parentElement?.checkVisibility()) return [];
          if (!part || !n.rects.length) return n.rects;
          const { left, top, bottom } = n.rects[0];
          return [{ left: left + part[0] * 8, top, right: left + part[1] * 8, bottom }];
        },
      };
    },
    createTreeWalker: (root: FakeEl) => {
      const it = walk(root);
      return { nextNode: () => it.next().value ?? null };
    },
  });
  set('addEventListener', (type: string, fn: L, o?: unknown) => dom.listeners.push({ type, fn, capture: cap(o) }));
  set('removeEventListener', (type: string, fn: L, o?: unknown) => {
    dom.listeners = dom.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === cap(o)));
  });
  set(
    'MutationObserver',
    class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
  set(
    'CSSStyleSheet',
    class {
      text = '';
      replaceSync(t: string) {
        this.text = t;
      }
    },
  );
  dom.raf = null;
  dom.layers = [];
  dom.portals = [];
  dom.hit = null;
  set('requestAnimationFrame', (cb: () => void) => ((dom.raf = cb), 1));
  set('cancelAnimationFrame', () => {});
  set('visualViewport', undefined);
  set('innerWidth', 1000);
  set('innerHeight', 800);
  set('devicePixelRatio', 1);
  set('getComputedStyle', (el: FakeEl) => ({ overflowX: 'visible', overflowY: 'visible', position: 'static', display: 'block', ...el.cs }));
  set('window', g);
  set('Element', FakeEl);
  set('HTMLElement', FakeEl);
  set(
    'DOMRect',
    class {
      constructor(
        public x: number,
        public y: number,
        public width: number,
        public height: number,
      ) {}
    },
  );
  set('NodeFilter', { SHOW_TEXT: 4 });
  return () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete g[k];
    }
  };
}

interface Ev {
  type: string;
  isTrusted: boolean;
  button: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  detail: number;
  key: string;
  relatedTarget: unknown;
  prevented: boolean;
  stopped: boolean;
  composedPath(): unknown[];
  preventDefault(): void;
  stopImmediatePropagation(): void;
}
/** Dispatches an event to the window listeners (capture first, as on window), stopping where one stops it. */
function fire(type: string, target: FakeEl, o: Partial<Ev> = {}): Ev {
  const path: unknown[] = [];
  for (let n: FakeNode | null = target; n; n = up(n)) path.push(n);
  const e: Ev = {
    type,
    isTrusted: true,
    button: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    detail: type === 'click' || type === 'dblclick' ? 1 : 0,
    key: '',
    relatedTarget: target,
    prevented: false,
    stopped: false,
    composedPath: () => path,
    preventDefault() {
      this.prevented = true;
    },
    stopImmediatePropagation() {
      this.stopped = true;
    },
    ...o,
  };
  for (const l of [...dom.listeners].sort((a, b) => Number(b.capture) - Number(a.capture))) {
    if (l.type !== type) continue;
    l.fn(e);
    if (e.stopped) break;
  }
  return e;
}
const CLICK = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
const clickOn = (t: FakeEl, o: Partial<Ev> = {}) => CLICK.map((k) => fire(k, t, o));
/** Where a pointer event happens (viewport). */
const at = (x: number, y: number) => ({ clientX: x, clientY: y }) as Partial<Ev>;
const CURSOR = '*{cursor:pointer!important}';

export function register(t: Kit): void {
  const { test, eq, ok } = t;
  const overlay = () => import('../../../src/inspector/overlay');

  /**
   * A page: body > section > label (the zone, 10..200 × 100..124) > span > its text "Nom" (marked 8..52 × 103..121); a
   * text box in the field; a Yes/No value whose zone (10..200 × 140..164) holds its switch (10..40) and its text "Oui"
   * (marked 48..82 × 143..161); our app host. One frame has measured the labels. ON, BESIDE (in the label's zone, right
   * of its text), OUI and SWITCH are pointer positions.
   */
  async function setup() {
    const undo = install();
    const body = dom.doc.children[0];
    const box = (tag: string, rect: [number, number, number, number]) => Object.assign(new FakeEl(tag), { rect });
    const sec = box('SECTION', [0, 90, 800, 200]);
    const label = box('LABEL', [10, 100, 200, 124]);
    const span = box('SPAN', [10, 104, 50, 120]);
    const input = box('INPUT', [300, 100, 600, 124]);
    input.type = 'text';
    const check = box('INPUT', [10, 144, 40, 160]);
    check.type = 'checkbox';
    const yes = box('SPAN', [50, 144, 80, 160]);
    const toggle = box('DIV', [10, 140, 200, 164]);
    const app = new FakeEl('DXT-TRANSLATOR');
    const inApp = new FakeEl('BUTTON');
    body.append(sec);
    sec.append(label, input, toggle);
    label.append(span);
    span.append(text('Nom', [[10, 104, 50, 120]]));
    toggle.append(check, yes);
    yes.append(text('Oui', [[50, 144, 80, 160]]));
    dom.doc.append(app);
    (app.attachShadow() as unknown as FakeNode).append(inApp);
    // The shadow child's parent chain ends at the shadow root, whose host is the app element.
    const a = { el: label, comp: 'field|f|1', kind: 'field', key: 'k', role: 'label' } as unknown as Anchor;
    const v = { el: toggle, comp: 'option|e.a|1', kind: 'option', key: 'o', role: 'value' } as unknown as Anchor;
    const opened: string[] = [];
    const alts: boolean[] = [];
    const hooks: OverlayHooks = { look: () => 'ok', open: (x) => opened.push(x.comp), mutated() {}, ours: () => [app as unknown as Node], alt: (h) => alts.push(h) };
    const { Overlay } = await overlay();
    const ov = new Overlay(hooks);
    ov.start();
    ov.sync([a, v]);
    dom.raf!();
    const sheet = () => (document.adoptedStyleSheets as unknown as Array<{ text: string }>)[0];
    return { undo, ov, a, label, span, input, check, yes, toggle, inApp, sec, opened, alts, sheet, ON: at(30, 112), BESIDE: at(150, 112), OUI: at(60, 152), SWITCH: at(25, 152) };
  }

  test('overlay dom: the parts of one text get a mark each; a click opens the part under the pointer, nothing between or past them', async () => {
    const undo = install();
    try {
      // A multi-select's values in one text (LIVE-FINDINGS 54): "Rouge, Bleu" in a row much wider than the text.
      const div = new FakeEl('DIV');
      div.rect = [100, 100, 600, 124];
      const t = text('Rouge, Bleu', [[100, 102, 188, 120]]);
      dom.doc.children[0].append(div);
      div.append(t);
      const part = (start: number, end: number, txt: string) => ({ start, end, text: txt });
      const r = { el: div, text: t, part: part(0, 5, 'Rouge'), comp: 'option|e.m|1', kind: 'option', key: 'r', role: 'value' } as unknown as Anchor;
      const b = { el: div, text: t, part: part(7, 11, 'Bleu'), comp: 'option|e.m|2', kind: 'option', key: 'b', role: 'value' } as unknown as Anchor;
      const opened: string[] = [];
      const { Overlay } = await overlay();
      const ov = new Overlay({ look: () => 'ok', open: (x) => opened.push(x.comp), mutated() {}, ours: () => [] });
      ov.start();
      ov.sync([r, b]);
      // Not measured yet (just synced after a re-render): nothing tells which value a point is on, the page gets it.
      ok(clickOn(div, at(160, 110)).every((e) => !e.prevented && !e.stopped), 'before its first frame');
      eq(opened, []);
      dom.raf?.();
      const recs = (ov as unknown as { recs: Map<Anchor, { boxes: number[][] }> }).recs;
      eq([recs.get(r)!.boxes, recs.get(b)!.boxes], [[[98, 101, 44, 20]], [[154, 101, 36, 20]]], 'each part hugs its own characters');
      const on = (x: number) => clickOn(div, at(x, 110));
      ok(on(160).every((e) => e.prevented && e.stopped));
      on(110);
      eq(opened, ['option|e.m|2', 'option|e.m|1']);
      // On the ", " between the two values, and right of every value in the row: no part is meant, the page gets it.
      for (const x of [148, 560]) ok(on(x).every((e) => !e.prevented && !e.stopped), `at ${x}`);
      eq(opened, ['option|e.m|2', 'option|e.m|1']);
      // The pointer follows the parts inside the one element: the cursor on each value, none between them.
      const sheet = () => (document.adoptedStyleSheets as unknown as Array<{ text: string }>)[0].text;
      fire('pointerover', div, at(110, 110));
      eq(sheet(), CURSOR);
      fire('pointermove', div, at(148, 110));
      eq(sheet(), '', 'between the values');
      fire('pointermove', div, at(160, 110));
      eq(sheet(), CURSOR);
      const box = ov.rectOf(b)! as unknown as { x: number; width: number };
      eq([box.x, box.width], [154, 36], 'the popup goes next to the part, not the row');
      // Dynamics re-rendered the text: no mark until the rescan finds the values again.
      t.nodeValue = 'Vert, Bleu';
      ov.invalidate(1);
      dom.raf?.();
      eq([recs.get(r)!.boxes, recs.get(b)!.boxes], [[], []]);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: a click on a label is taken over and opens it; Dynamics sees none of it', async () => {
    const s = await setup();
    try {
      const evs = clickOn(s.span, s.ON);
      ok(evs.every((e) => e.prevented && e.stopped), 'every event of the gesture is swallowed');
      eq(s.opened, ['field|f|1']);
    } finally {
      s.ov.stop();
      s.undo();
    }
  });

  test("overlay dom: beside a field label's text, in its container, a click reaches the page and opens nothing", async () => {
    const s = await setup();
    try {
      ok(clickOn(s.label, s.BESIDE).every((e) => !e.prevented && !e.stopped), 'not taken over');
      ok(!fire('dblclick', s.label, { ...s.BESIDE, detail: 2 }).prevented, 'nor its double-click');
      fire('pointerdown', s.label, s.BESIDE);
      ok(!fire('touchstart', s.label, s.BESIDE).stopped, 'nor its touch events');
      fire('click', s.label, s.BESIDE);
      eq(s.opened, []);
      // Within 2 px past its mark (8..52), still the text.
      ok(clickOn(s.label, at(53, 112)).every((e) => e.prevented));
      ok(clickOn(s.label, at(55, 112)).every((e) => !e.prevented));
      eq(s.opened, ['field|f|1']);
    } finally {
      s.ov.stop();
      s.undo();
    }
  });

  test('overlay dom: a Yes/No switch inside a value zone never toggles: beside the text a click does nothing, on it it opens the value; a text box in a zone keeps working', async () => {
    const s = await setup();
    try {
      ok(clickOn(s.check, s.SWITCH).every((e) => e.prevented && e.stopped), 'the checkbox click is canceled (no toggle)');
      eq(s.opened, [], 'beside the text: nothing opens');
      // The control's own space beside both (its whole control is the zone): nothing either.
      Object.assign(s.toggle, { querySelector: () => s.check });
      ok(clickOn(s.toggle, at(150, 152)).every((e) => e.prevented && e.stopped), 'the container of the switch');
      eq(s.opened, []);
      ok(clickOn(s.yes, s.OUI).every((e) => e.prevented && e.stopped));
      eq(s.opened, ['option|e.a|1']);
      // A text input placed inside a zone (should never happen) still gets its clicks, even where the label's text is.
      s.label.append(s.input);
      ok(clickOn(s.input, s.ON).every((e) => !e.prevented && !e.stopped), 'the text box keeps working');
      eq(s.opened, ['option|e.a|1']);
    } finally {
      s.ov.stop();
      s.undo();
    }
  });

  test('overlay dom: everything else reaches the page: inputs, other buttons, Alt, keyboard and synthetic clicks', async () => {
    const s = await setup();
    try {
      ok(clickOn(s.input).every((e) => !e.prevented && !e.stopped), 'an input outside the label');
      ok(clickOn(s.span, { ...s.ON, button: 2 }).every((e) => !e.prevented), 'right button');
      ok(clickOn(s.span, { ...s.ON, altKey: true }).every((e) => !e.prevented), 'Alt+click');
      ok(clickOn(s.check, { ...s.SWITCH, altKey: true }).every((e) => !e.prevented && !e.stopped), 'Alt+click on the switch beside its text');
      ok(!fire('click', s.span, { ...s.ON, detail: 0 }).prevented, 'Enter / screen reader activation');
      ok(clickOn(s.span, { ...s.ON, isTrusted: false }).every((e) => !e.prevented), 'synthetic (our own "Open")');
      eq(s.opened, []);
    } finally {
      s.ov.stop();
      s.undo();
    }
  });

  test('overlay dom: our own hosts are never touched, even at the end of a gesture that started on a label', async () => {
    const s = await setup();
    try {
      ok(clickOn(s.inApp).every((e) => !e.prevented && !e.stopped), 'a click in the callout');
      fire('pointerdown', s.span, s.ON);
      const up = fire('pointerup', s.inApp);
      const click = fire('click', s.inApp);
      ok(!up.prevented && !up.stopped && !click.prevented && !click.stopped, 'released over the bar');
      eq(s.opened, []);
    } finally {
      s.ov.stop();
      s.undo();
    }
  });

  test('overlay dom: touch events of a label gesture are stopped, never canceled', async () => {
    const s = await setup();
    try {
      fire('pointerdown', s.span, s.ON);
      const ts = fire('touchstart', s.span, s.ON);
      ok(ts.stopped && !ts.prevented, 'stopped, scrolling keeps working');
      fire('click', s.span, s.ON);
      // Beside the text of a switch: the gesture is swallowed, its touch events too.
      fire('pointerdown', s.check, s.SWITCH);
      const tc = fire('touchstart', s.check, s.SWITCH);
      ok(tc.stopped && !tc.prevented, 'beside the text of a control');
      fire('click', s.check, s.SWITCH);
      fire('pointerdown', s.input);
      ok(!fire('touchstart', s.input).stopped, 'a page gesture keeps its touch events');
    } finally {
      s.ov.stop();
      s.undo();
    }
  });

  test('overlay dom: Alt is released by keyup, blur, a key or a pointer move without it', async () => {
    const s = await setup();
    try {
      fire('keydown', s.input, { key: 'Alt', altKey: true });
      fire('keyup', s.input, { key: 'Alt' });
      fire('keydown', s.input, { key: 'Alt', altKey: true });
      fire('blur', s.input);
      fire('keydown', s.input, { key: 'Alt', altKey: true });
      fire('pointermove', s.input, { altKey: true });
      fire('pointermove', s.input, { altKey: false }); // the keyup went to a frame
      fire('keydown', s.input, { key: 'Alt', altKey: true });
      fire('keydown', s.input, { key: 'a', altKey: false });
      eq(s.alts, [true, false, true, false, true, false, true, false]);
      ok(!dom.listeners.some((l) => l.type === 'pointermove'), 'no move listener while Alt is up');
      fire('keydown', s.inApp, { key: 'Alt', altKey: true });
      eq(s.alts.length, 8, 'Alt in our own hosts (Alt+Down in a callout) does not count');
    } finally {
      s.ov.stop();
      s.undo();
    }
  });

  test("overlay dom: hover sets the pointer cursor only over a label's text, never the rest of its zone", async () => {
    const s = await setup();
    try {
      fire('pointerover', s.span, s.ON);
      eq(s.sheet().text, CURSOR);
      fire('pointerover', s.input);
      eq(s.sheet().text, '');
      fire('pointerover', s.label, s.BESIDE);
      eq(s.sheet().text, '', "in the label's container, beside its text");
      ok(dom.listeners.some((l) => l.type === 'pointermove'), 'its moves are followed');
      fire('pointermove', s.label, s.ON);
      eq(s.sheet().text, CURSOR, 'onto the text inside the same element (no pointerover)');
      fire('pointermove', s.label, s.BESIDE);
      eq(s.sheet().text, '', 'off it again');
      fire('pointerover', s.span, s.ON);
      fire('pointerout', s.span, { relatedTarget: null });
      eq(s.sheet().text, '', 'left the window');
      ok(!dom.listeners.some((l) => l.type === 'pointermove'), 'no move listener outside a zone');
      s.label.append(s.input);
      fire('pointerover', s.input, s.ON);
      eq(s.sheet().text, '', 'a text box inside a zone keeps its own cursor');
    } finally {
      s.ov.stop();
      s.undo();
    }
  });

  test('overlay dom: F2 opens the focused label, never from a text box', async () => {
    const s = await setup();
    try {
      ok(fire('keydown', s.span, { key: 'F2' }).prevented);
      eq(s.opened, ['field|f|1']);
      ok(!fire('keydown', s.input, { key: 'F2' }).prevented, 'in an input');
      ok(fire('keydown', s.sec, { key: 'F2' }).prevented === false, 'a section with two labels in it: ambiguous');
      eq(s.opened, ['field|f|1']);
    } finally {
      s.ov.stop();
      s.undo();
    }
  });

  test('overlay dom: pause lets the page work; resuming finds the label under the pointer', async () => {
    const s = await setup();
    try {
      fire('pointerover', s.span, s.ON);
      s.ov.pause(true);
      eq(s.sheet().text, '', 'no pointer cursor while paused');
      ok(clickOn(s.span, s.ON).every((e) => !e.prevented), 'clicks reach the page');
      fire('pointerover', s.input); // moved while the Workbench was open
      s.ov.pause(false);
      eq(s.sheet().text, '', 'not over a label any more');
      fire('pointerover', s.span, s.ON);
      s.ov.pause(true);
      s.ov.pause(false);
      eq(s.sheet().text, CURSOR, 'still over the label');
      s.ov.pause(true);
      fire('pointerover', s.label, s.BESIDE);
      s.ov.pause(false);
      eq(s.sheet().text, '', 'moved beside its text while paused');
    } finally {
      s.ov.stop();
      s.undo();
    }
  });

  test('overlay dom: stop removes every listener, the cursor sheet and the layer; a restart is not paused', async () => {
    const s = await setup();
    try {
      fire('pointerover', s.span, s.ON);
      fire('keydown', s.input, { key: 'Alt', altKey: true });
      s.ov.pause(true);
      s.ov.stop();
      eq(dom.listeners.length, 0, 'listeners left: ' + dom.listeners.map((l) => l.type).join());
      eq((document.adoptedStyleSheets as unknown[]).length, 0, 'cursor sheet removed');
      eq(dom.doc.children.filter((c) => c.tagName === 'DIV').length, 0, 'layer removed');
      s.ov.start();
      s.ov.sync([s.a]);
      eq((document.adoptedStyleSheets as unknown as Array<{ text: string }>)[0].text, '', 'restarted with an empty cursor sheet');
      ok(clickOn(s.span, s.ON).every((e) => e.prevented), 'paused before the stop, not paused after the restart');
    } finally {
      s.ov.stop();
      s.undo();
    }
  });

  // ---- marks (one frame run by hand) ----

  const plain: OverlayHooks = { look: () => 'missing', open() {}, mutated() {}, ours: () => [] };
  const parts = () => {
    const host = dom.doc.children.find((c) => c.shadowRoot)!;
    const wrap = host.shadowRoot!.children[1];
    return { wrap, groups: wrap.children[0].children };
  };
  /** The marks drawn: [transform, width, height] of each visible one. */
  const segments = () => parts().groups.flatMap((g) => g.children.filter((i) => i.tagName === 'I' && !i.hidden).map((i) => [i.style.transform, i.style.width, i.style.height]));
  /** The clip-path of each visible mark ('' = not cut), in the order of segments(). */
  const clips = () => parts().groups.flatMap((g) => g.children.filter((i) => i.tagName === 'I' && !i.hidden).map((i) => i.style.clipPath ?? ''));
  /** The pencil badges shown: their positions. */
  const badges = () => parts().groups.flatMap((g) => g.children.filter((i) => i.tagName === 'B' && !i.hidden).map((i) => i.style.transform));
  const classes = () => parts().groups.map((g) => g.className);
  const box = (r: unknown) => {
    const d = r as { x: number; y: number; width: number; height: number } | null;
    return d && [d.x, d.y, d.width, d.height];
  };
  const el = (tag: string, rect: [number, number, number, number], cs: Record<string, string> = {}, ...kids: FakeEl[]) => {
    const e = new FakeEl(tag);
    e.rect = rect;
    e.cs = cs;
    e.append(...kids);
    return e;
  };

  test('overlay dom: a mark per line box of the label text; nothing for the field container or the rest of the label', async () => {
    const undo = install();
    try {
      // A field label as tall as its row and wider than its text, wrapping on two lines, in its field container.
      const t1 = text('Rédacteur principal du dossier', [[10, 205, 170, 221], [10, 225, 90, 241]]);
      const label = el('LABEL', [10, 200, 186, 260], {}, el('SPAN', [10, 205, 170, 241], {}, t1));
      const field = el('DIV', [0, 190, 500, 280], {}, label);
      dom.doc.children[0].append(field);
      const a = { el: label, hit: field, text: t1, comp: 'field|f|1', kind: 'field', key: 'k', role: 'label' } as unknown as Anchor;
      const { Overlay } = await overlay();
      const ov = new Overlay(plain);
      ov.start();
      ov.sync([a]);
      dom.raf!();
      eq(segments(), [
        ['translate(8px,204px)', '164px', '18px'],
        ['translate(8px,224px)', '84px', '18px'],
      ]);
      eq(classes(), ['g is-missing']);
      ov.flash('field|f|1');
      dom.raf!();
      eq(segments().length, 2, 'the list hover emphasises the same text boxes, never the container');
      eq(classes(), ['g is-missing is-fl']);
      eq(badges(), [], 'no badge for a list hover');
      eq(box(ov.rectOf(a)), [10, 200, 176, 60], 'the popup still points at the whole label');
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: the record header title is marked on its text only, never on the header or the element around it', async () => {
    const undo = install();
    try {
      // The table name under the record title: a wide element holding the text directly, no text node in the anchor.
      const blank = text(' ', [[20, 60, 24, 90]]);
      const t1 = text('Demande de service', [[24, 64, 160, 82]]);
      const name = el('DIV', [20, 60, 980, 90], {}, blank, t1);
      const header = el('DIV', [0, 0, 1000, 120], {}, el('H1', [20, 10, 400, 50], {}, text('Panne réseau', [[20, 14, 150, 46]])), name);
      dom.doc.children[0].append(header);
      const a = { el: name, hit: header, comp: 'entity|incident', kind: 'entity', key: 'entity|incident|DisplayName', role: 'label' } as unknown as Anchor;
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok' });
      ov.start();
      ov.sync([a]);
      dom.raf!();
      eq(segments(), [['translate(22px,63px)', '140px', '20px']], 'the first text with letters, hugged');
      fire('pointerover', t1, at(60, 72));
      dom.raf!();
      eq(classes(), ['g is-ok is-hv']);
      eq(segments(), [['translate(22px,63px)', '140px', '20px']], 'hover changes the border, not the box');
      eq(badges(), ['translate(164px,66px)'], 'pencil just right of the text, centred on the line');
      ov.flash('entity|incident');
      dom.raf!();
      eq(segments().length, 1, 'flashing never draws the header');
      // Text that overflows its element is kept inside it.
      t1.rects = [{ left: 24, top: 64, right: 1100, bottom: 82 }];
      ov.invalidate(1);
      dom.raf!();
      eq(segments(), [['translate(22px,63px)', '960px', '20px']]);
      // No text at all: nothing is drawn (never the element's box).
      t1.nodeValue = '';
      ov.sync([]);
      ov.sync([a]);
      dom.raf!();
      eq(segments(), []);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: not-loaded labels get no mark, no hover, no pointer, their clicks reach the page; a read-only one is grey, takes the pointer and opens its popup', async () => {
    const undo = install();
    try {
      const body = dom.doc.children[0];
      const mk = (comp: string, y: number) => {
        const t1 = text(comp, [[10, y + 2, 60, y + 18]]);
        const label = el('LABEL', [10, y, 200, y + 20], {}, t1);
        body.append(label);
        return { t1, a: { el: label, text: t1, comp, kind: 'field', key: comp, role: 'label' } as unknown as Anchor };
      };
      const ro = mk('ro', 100);
      const na = mk('na', 200);
      const live = mk('live', 300);
      const opened: string[] = [];
      const looks: Record<string, Look> = { ro: 'ro', na: 'na', live: 'edited' };
      const { Overlay } = await overlay();
      const ov = new Overlay({ look: (x) => looks[x.comp], open: (x) => opened.push(x.comp), mutated() {}, ours: () => [] });
      ov.start();
      ov.sync([ro.a, na.a, live.a]);
      dom.raf!();
      eq(segments(), [['translate(8px,101px)', '54px', '18px'], ['translate(8px,301px)', '54px', '18px']], 'the read-only label is marked (grey), the not-loaded one is not');
      const sheet = () => (document.adoptedStyleSheets as unknown as Array<{ text: string }>)[0].text;
      // Read-only: its popup says why it can't be translated here.
      fire('pointerover', ro.t1, at(30, 110));
      dom.raf!();
      eq(sheet(), CURSOR, 'ro: the pointer');
      ok(classes().includes('g is-ro is-hv'), 'ro: hovered');
      ok(clickOn(ro.t1, at(30, 110)).every((e) => e.prevented), 'ro: the click opens its popup');
      eq(opened, ['ro']);
      fire('pointerover', na.t1, at(30, 210));
      dom.raf!();
      eq(sheet(), '', 'na: no pointer');
      ok(!classes().some((c) => c.includes('is-hv')), 'na: no hover');
      ok(clickOn(na.t1, at(30, 210)).every((e) => !e.prevented && !e.stopped), 'na: the click reaches the page');
      ok(!fire('keydown', na.t1, { key: 'F2' }).prevented, 'na: F2 too');
      eq(opened, ['ro']);
      ok(clickOn(live.t1, at(30, 310)).every((e) => e.prevented), 'the translatable one is taken over');
      eq(opened, ['ro', 'live']);
      // A label that is no longer loaded while hovered loses its hover and pointer at once.
      fire('pointerover', live.t1, at(30, 310));
      eq(sheet(), CURSOR);
      looks.live = 'na';
      ov.paint();
      dom.raf!();
      eq(sheet(), '');
      eq(segments(), [['translate(8px,101px)', '54px', '18px']]);
      eq(classes(), ['g is-ro', 'g is-na', 'g is-na']);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: hover and the open popup show the strong look and the pencil; flash; hidden while paused', async () => {
    const undo = install();
    try {
      const body = dom.doc.children[0];
      const tx = text('Titre', [[10, 102, 60, 118]]);
      const ty = text('Statut', [[10, 202, 70, 218]]);
      const lx = el('LABEL', [10, 100, 200, 120], {}, tx);
      const ly = el('LABEL', [10, 200, 200, 220], {}, ty);
      const input = el('INPUT', [300, 100, 600, 130]);
      body.append(lx, ly, input);
      const x = { el: lx, text: tx, comp: 'x', kind: 'field', key: 'x', role: 'label' } as unknown as Anchor;
      const y = { el: ly, text: ty, comp: 'y', kind: 'field', key: 'y', role: 'label' } as unknown as Anchor;
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: (a) => (a.comp === 'x' ? 'ok' : 'error') });
      ov.start();
      ov.sync([x, y]);
      ov.active('x');
      dom.raf!();
      eq(classes(), ['g is-ok is-act', 'g is-error']);
      eq(badges(), ['translate(64px,103px)'], 'the open popup keeps the hover look on its label');
      fire('pointerover', ty, at(30, 210));
      dom.raf!();
      eq(classes(), ['g is-ok is-act', 'g is-error is-hv']);
      eq(badges(), ['translate(64px,103px)', 'translate(74px,203px)']);
      fire('pointerover', input);
      dom.raf!();
      eq(classes(), ['g is-ok is-act', 'g is-error']);
      ov.active(null);
      ov.flash('y');
      dom.raf!();
      eq(classes(), ['g is-ok', 'g is-error is-fl']);
      eq(badges(), []);
      ov.pause(true);
      ok(parts().wrap.hidden, 'hidden while the Workbench is open');
      ov.pause(false);
      ok(!parts().wrap.hidden);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: a label found from the list pulses until cleared; never an unmarked one', async () => {
    const undo = install();
    // The pulse's timer, watched: none may be left running.
    const g = globalThis as unknown as { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
    const { setTimeout: st, clearTimeout: ct } = g;
    const timers = new Set<unknown>();
    g.setTimeout = ((fn: () => void, ms?: number) => {
      const id = st(() => (timers.delete(id), fn()), ms);
      timers.add(id);
      return id;
    }) as typeof setTimeout;
    g.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => (timers.delete(id), ct(id))) as typeof clearTimeout;
    try {
      const body = dom.doc.children[0];
      const tx = text('Titre', [[10, 102, 60, 118]]);
      const ty = text('Statut', [[10, 202, 70, 218]]);
      const tz = text('Créé le', [[10, 302, 70, 318]]);
      const lx = el('LABEL', [10, 100, 200, 120], {}, tx);
      const ly = el('LABEL', [10, 200, 200, 220], {}, ty);
      const lz = el('LABEL', [10, 300, 200, 320], {}, tz);
      body.append(lx, ly, lz);
      const x = { el: lx, text: tx, comp: 'x', kind: 'field', key: 'x', role: 'label' } as unknown as Anchor;
      const y = { el: ly, text: ty, comp: 'y', kind: 'field', key: 'y', role: 'label' } as unknown as Anchor;
      const z = { el: lz, text: tz, comp: 'z', kind: 'field', key: 'z', role: 'label' } as unknown as Anchor;
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: (a) => (a.comp === 'x' ? 'ok' : a.comp === 'y' ? 'error' : 'na') });
      ov.start();
      ov.sync([x, y, z]);
      ov.pulse(x);
      dom.raf!();
      eq(classes(), ['g is-ok is-pl', 'g is-error', 'g is-na']);
      eq(timers.size, 1, 'it ends by itself');
      ov.active('x', x);
      dom.raf!();
      eq(classes()[0], 'g is-ok is-act is-pl', 'with its popup open');
      ov.pulse(null);
      dom.raf!();
      eq(classes()[0], 'g is-ok is-act');
      eq(timers.size, 0);
      ov.pulse(z);
      dom.raf!();
      eq(classes()[2], 'g is-na', 'a label without a mark (not loaded) has nothing to pulse');
      ov.pulse(x);
      ov.stop();
      eq(timers.size, 0, 'stop ends it');
      ov.start();
      ov.sync([x, y, z]);
      dom.raf!();
      ok(!classes().some((c) => c.includes('is-pl')), 'not after a restart');
      ov.pulse(y);
      ov.pause(true);
      eq(timers.size, 0, 'pause ends it');
      ov.pause(false);
      dom.raf!();
      ok(!classes().some((c) => c.includes('is-pl')));
      ov.stop();
    } finally {
      g.setTimeout = st;
      g.clearTimeout = ct;
      undo();
    }
  });

  test('overlay dom: a grid header whose anchor text is the hidden copy is marked on the visible copy', async () => {
    const undo = install();
    try {
      const t1 = text('Statut', [[110, 110, 170, 126]]);
      const t2 = text('Statut', [[110, 110, 170, 126]]);
      const hidden = el('SPAN', [0, 0, 0, 0], {}, t1);
      hidden.vis = false;
      const shown = el('SPAN', [110, 110, 170, 126], {}, t2);
      const cell = el('DIV', [100, 100, 260, 140], { overflowX: 'hidden', overflowY: 'hidden' }, hidden, shown);
      dom.doc.children[0].append(el('DIV', [0, 100, 1000, 700], { overflowY: 'auto' }, cell));
      const a = { el: hidden, zone: cell, text: t1, comp: 'attribute|e.statuscode', kind: 'attribute', key: 'k', role: 'header' } as unknown as Anchor;
      const { Overlay } = await overlay();
      const ov = new Overlay(plain);
      ov.start();
      ov.sync([a]);
      dom.raf!();
      eq(segments(), [['translate(108px,109px)', '64px', '18px']], 'marked on the visible copy');
      eq(box(ov.rectOf(a)), [100, 100, 160, 40], 'the popup points at the header cell');
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: a mark never spills out of the scroll container; a label partly scrolled out has none but stays clickable', async () => {
    const undo = install();
    try {
      const t1 = text('Client', [[10, 690, 80, 707]]);
      const label = el('LABEL', [10, 680, 200, 700], {}, t1);
      dom.doc.children[0].append(el('DIV', [0, 100, 1000, 700], { overflowY: 'auto' }, label));
      const a = { el: label, text: t1, comp: 'field|f|1', kind: 'field', key: 'k', role: 'label' } as unknown as Anchor;
      const { Overlay } = await overlay();
      const ov = new Overlay(plain);
      ov.start();
      ov.sync([a]);
      dom.raf!();
      eq(segments(), [], 'no mark over the footer');
      eq(box(ov.rectOf(a)), [10, 680, 190, 20], 'its zone still shows');
      t1.rects = [{ left: 10, top: 682, right: 80, bottom: 699 }];
      ov.invalidate(1);
      dom.raf!();
      eq(segments(), [['translate(8px,681px)', '74px', '19px']], 'at the edge: drawn, kept inside');
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: the open popup emphasises the label it points at, never the other labels of its component', async () => {
    const undo = install();
    try {
      // "Actif" in two rows of a list: one component (the option), two labels.
      const t1 = text('Actif', [[10, 102, 50, 118]]);
      const t2 = text('Actif', [[10, 202, 50, 218]]);
      const c1 = el('DIV', [10, 100, 200, 120], {}, t1);
      const c2 = el('DIV', [10, 200, 200, 220], {}, t2);
      dom.doc.children[0].append(c1, c2);
      const comp = 'status|e.statuscode|1';
      const a = { el: c1, text: t1, comp, kind: 'status', key: 'k', role: 'value' } as unknown as Anchor;
      const b = { el: c2, text: t2, comp, kind: 'status', key: 'k', role: 'value' } as unknown as Anchor;
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok' });
      ov.start();
      ov.sync([a, b]);
      const look = (...x: Parameters<typeof ov.active>) => {
        ov.active(...x);
        dom.raf!();
        return [classes(), badges().length];
      };
      eq(look(comp, a), [['g is-ok is-act', 'g is-ok'], 1], 'the clicked cell only');
      eq(look(comp, b), [['g is-ok', 'g is-ok is-act'], 1], 'moved to the other row');
      eq(look(comp, null), [['g is-ok', 'g is-ok'], 0], 'docked: no label');
      eq(look(comp), [['g is-ok is-act', 'g is-ok is-act'], 2], 'the component only (the contract call): every label');
      eq(look(null), [['g is-ok', 'g is-ok'], 0]);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: a closed native select is marked on the text it shows; its click opens the popup', async () => {
    const undo = install();
    try {
      const sel = (rect: [number, number, number, number], shows: string) => {
        const s = el('SELECT', rect, { borderLeftWidth: '1px', borderTopWidth: '1px', borderRightWidth: '1px', borderBottomWidth: '1px', paddingLeft: '8px', paddingTop: '5px', paddingRight: '28px', paddingBottom: '5px', fontSize: '14px', fontStyle: 'normal', fontWeight: '400', fontFamily: 'Segoe UI', direction: 'ltr' });
        // The options of a closed select are not laid out: their texts have no boxes.
        s.append(el('OPTION', [0, 0, 0, 0], {}, text('Actif')), el('OPTION', [0, 0, 0, 0], {}, text('Inactif')));
        Object.assign(s, { selectedOptions: shows ? [{ text: shows }] : [] });
        dom.doc.children[0].append(s);
        return s;
      };
      const s1 = sel([100, 100, 300, 132], 'Actif');
      const s2 = sel([100, 200, 300, 232], '');
      const opened: string[] = [];
      const a = { el: s1, comp: 'status|e.statuscode|1', kind: 'status', key: 'k', role: 'value' } as unknown as Anchor;
      const b = { el: s2, comp: 'status|e.statuscode|2', kind: 'status', key: 'k2', role: 'value' } as unknown as Anchor;
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok', open: (x) => opened.push(x.comp) });
      ov.start();
      ov.sync([a, b]);
      dom.raf!();
      // Content box 109..271 × 106..126; "Actif" is 40 px wide (the select's font), one 18 px line centred in it.
      eq(segments(), [['translate(107px,106px)', '44px', '20px']]);
      ok(clickOn(s1, at(120, 116)).every((e) => e.prevented), 'taken over');
      eq(opened, ['status|e.statuscode|1']);
      // Beside its text, on the rest of the control: it never opens its list, nor the popup.
      ok(clickOn(s1, at(250, 116)).every((e) => e.prevented && e.stopped), 'swallowed');
      eq(opened, ['status|e.statuscode|1']);
      ok(clickOn(s2, at(120, 216)).every((e) => !e.prevented), 'nothing shown, nothing marked: the select works as usual');
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: a label whose text is hidden or cut off is left alone: no mark, no pointer, its clicks reach the page', async () => {
    const undo = install();
    try {
      const body = dom.doc.children[0];
      // A collapsed site map: the entry shows its icon, its title is hidden...
      const t1 = text('Comptes', [[60, 110, 120, 126]]);
      const span = el('SPAN', [60, 108, 120, 128], {}, t1);
      span.vis = false;
      const e1 = el('DIV', [0, 100, 48, 140], {}, el('I', [12, 108, 36, 132]), span);
      // ...or it is there, cut off by the narrow entry.
      const t2 = text('Contacts', [[60, 160, 120, 176]]);
      const e2 = el('DIV', [0, 150, 48, 190], { overflowX: 'hidden', overflowY: 'hidden' }, el('SPAN', [60, 158, 120, 178], {}, t2));
      body.append(e1, e2);
      const opened: string[] = [];
      const a = { el: e1, text: t1, comp: 'subarea|s|1', kind: 'subarea', key: 'k1', role: 'nav' } as unknown as Anchor;
      const b = { el: e2, text: t2, comp: 'subarea|s|2', kind: 'subarea', key: 'k2', role: 'nav' } as unknown as Anchor;
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok', open: (x) => opened.push(x.comp) });
      ov.start();
      ov.sync([a, b]);
      dom.raf!();
      eq(segments(), []);
      const sheet = () => (document.adoptedStyleSheets as unknown as Array<{ text: string }>)[0].text;
      for (const e of [e1, e2]) {
        ok(clickOn(e).every((x) => !x.prevented && !x.stopped), 'the click reaches the page');
        fire('pointerover', e);
        eq(sheet(), '', 'no pointer');
        ok(!fire('keydown', e, { key: 'F2' }).prevented, 'F2 neither');
      }
      eq(opened, []);
      // Expanded: the title shows, is marked and is taken over again.
      span.vis = true;
      ov.invalidate(1);
      dom.raf!();
      eq(segments().length, 1);
      ok(clickOn(e1, at(80, 118)).every((x) => x.prevented));
      eq(opened, ['subarea|s|1']);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: a label in an open shadow root (the header strip) is clipped by the containers around its host', async () => {
    const undo = install();
    try {
      const host = el('DIV', [0, 600, 1000, 720]);
      dom.doc.children[0].append(el('DIV', [0, 100, 1000, 700], { overflowY: 'auto' }, host));
      const root = host.attachShadow();
      const t1 = text('Priorité', [[10, 690, 80, 707]]);
      const label = el('SPAN', [10, 688, 90, 709], {}, t1);
      root.append(label);
      // As in the DOM: a shadow root's child has no parent element, the root is its parent node.
      label.parentElement = null;
      label.parentNode = root;
      const a = { el: label, text: t1, comp: 'field|f|header_prioritycode', kind: 'field', key: 'k', role: 'label' } as unknown as Anchor;
      const { Overlay } = await overlay();
      const opened: string[] = [];
      const ov = new Overlay({ ...plain, open: (x) => opened.push(x.comp) });
      ov.start();
      ov.sync([a]);
      dom.raf!();
      eq(segments(), [], 'no mark past the scroll container of the host');
      eq(box(ov.rectOf(a)), [10, 688, 80, 12], 'its zone is cut there too');
      ok(clickOn(t1).every((e) => e.prevented), 'partly shown: clickable');
      eq(opened, ['field|f|header_prioritycode']);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: with a modal open, labels of a dropdown opened from it show; labels behind it do not', async () => {
    const undo = install();
    try {
      const body = dom.doc.children[0];
      const t1 = text('Actif', [[310, 305, 360, 321]]);
      const option = el('DIV', [300, 300, 500, 330], {}, t1);
      const listbox = el('DIV', [300, 300, 500, 450], {}, option);
      listbox.attrs.role = 'listbox';
      const modal = el('DIV', [200, 100, 800, 600], {});
      modal.attrs['aria-modal'] = 'true';
      const t2 = text('Nom', [[20, 20, 60, 36]]);
      const behind = el('LABEL', [20, 20, 120, 40], {}, t2);
      body.append(behind, modal, listbox);
      dom.layers = [modal, listbox];
      dom.hit = option;
      const a = { el: option, text: t1, comp: 'option|e.a|1', kind: 'option', key: 'o', role: 'option' } as unknown as Anchor;
      const b = { el: behind, text: t2, comp: 'field|f|1', kind: 'field', key: 'k', role: 'label' } as unknown as Anchor;
      const { Overlay } = await overlay();
      const ov = new Overlay(plain);
      ov.start();
      ov.sync([a, b]);
      dom.raf!();
      eq(box(ov.rectOf(a)), [300, 300, 200, 30], 'the option shows');
      eq(ov.rectOf(b), null, 'the label behind the modal does not');
      eq(segments(), [['translate(308px,304px)', '54px', '18px']]);
      eq(clips(), [''], 'the list holds it: not cut');
      ov.stop();
    } finally {
      undo();
    }
  });

  // ---- popups of the page over the marks ----

  /** A label of the page: a LABEL at `rect` holding its text, one line at `at`. */
  const field = (comp: string, rect: [number, number, number, number], v: string, at: [number, number, number, number]) => {
    const t = text(v, [at]);
    const l = el('LABEL', rect, {}, t);
    return { l, t, a: { el: l, text: t, comp, kind: 'field', key: comp, role: 'label' } as unknown as Anchor };
  };
  const WHITE = { backgroundColor: 'rgb(255, 255, 255)' };
  /** A portal root without a box of its own holding `kids`: Dynamics' mount node, else a Fluent portal. */
  const portal = (mount: boolean, ...kids: FakeEl[]) => {
    const p = el('DIV', [0, 0, 0, 0], {}, ...kids);
    if (mount) p.attrs.id = '__fluentPortalMountNode';
    else p.attrs['data-portal-node'] = 'true';
    return p;
  };

  test('overlay dom: a flyout in a portal (no popup role) lies over the marks under it: cut where it lies, gone where nothing is left; its own labels keep theirs', async () => {
    const undo = install();
    try {
      const under = field('field|f|stage', [320, 148, 400, 168], 'Étape 1', [320, 150, 380, 166]);
      const half = field('field|f|primary', [320, 290, 460, 310], 'Contact principal', [320, 292, 440, 308]);
      const beside = field('field|f|web', [720, 148, 800, 168], 'Site Web', [720, 150, 790, 166]);
      const own = field('field|f|header_revenue', [320, 118, 600, 138], 'Chiffre', [320, 120, 440, 136]);
      // The header fields flyout (LIVE-FINDINGS 86): a white card in the mount node, without a popup role.
      const card = el('DIV', [300, 100, 700, 300], WHITE, own.l);
      const root = portal(true, el('DIV', [0, 0, 0, 0], {}, card));
      dom.doc.children[0].append(under.l, half.l, beside.l, root);
      dom.portals = [root];
      const opened: string[] = [];
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, open: (x) => opened.push(x.comp) });
      ov.start();
      ov.sync([under.a, half.a, beside.a, own.a]);
      dom.raf!();
      eq(segments(), [['translate(318px,291px)', '124px', '18px'], ['translate(718px,149px)', '74px', '18px'], ['translate(318px,119px)', '124px', '18px']]);
      eq(clips(), ['path("M-4 9h132v13h-132z")', '', ''], 'cut where the card lies, its ring too; the flyout\'s own label is not');
      eq(ov.rectOf(under.a), null, 'nothing of it shows');
      eq(box(ov.rectOf(half.a)), [320, 290, 140, 20], 'partly shown: the popup can still point at it');
      ok(clickOn(own.t, at(350, 128)).every((e) => e.prevented), 'the flyout\'s own label is taken over');
      eq(opened, ['field|f|header_revenue']);
      // Closed: every mark of the page is whole again.
      card.vis = false;
      ov.invalidate(1);
      dom.raf!();
      eq(segments(), [['translate(318px,149px)', '64px', '18px'], ['translate(318px,291px)', '124px', '18px'], ['translate(718px,149px)', '74px', '18px']]);
      eq(clips(), ['', '', '']);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: in a portal, hidden, transparent and window-sized wrappers are looked through; only what paints covers', async () => {
    const undo = install();
    try {
      const menu = el('DIV', [100, 100, 300, 200], { boxShadow: '0 8px 16px rgba(0, 0, 0, 0.14)' });
      const hidden = el('DIV', [400, 100, 600, 200], WHITE);
      hidden.vis = false;
      const root = portal(
        false,
        el('DIV', [0, 0, 1000, 800], { backgroundColor: 'rgba(0, 0, 0, 0.4)' }, menu), // a dimming backdrop
        hidden,
        el('DIV', [650, 100, 900, 200], { backgroundColor: 'rgba(0, 0, 0, 0)' }),
        el('DIV', [100, 500, 300, 600], { backgroundColor: 'rgb(0, 0, 0)' }), // black, opaque
        el('DIV', [650, 300, 900, 380], { backgroundColor: 'color(srgb 1 1 1 / 0)' }),
      );
      const ls = [[150, 140], [450, 140], [700, 140], [150, 400], [150, 540], [700, 340]].map(([x, y], i) => field(`field|f|${i}`, [x, y - 2, x + 100, y + 18], 'Nom', [x, y, x + 50, y + 16]));
      dom.doc.children[0].append(...ls.map((f) => f.l), root);
      dom.portals = [root];
      const { Overlay } = await overlay();
      const ov = new Overlay(plain);
      ov.start();
      ov.sync(ls.map((f) => f.a));
      dom.raf!();
      eq(segments(), [['translate(448px,139px)', '54px', '18px'], ['translate(698px,139px)', '54px', '18px'], ['translate(148px,399px)', '54px', '18px'], ['translate(698px,339px)', '54px', '18px']], 'none under the menu or the black box');
      eq(clips(), ['', '', '', '']);
      ov.stop();
    } finally {
      undo();
    }
  });

  test("overlay dom: another tool's panel (a bookmarklet's, in a shadow root on <html>) hides the marks under it while it is on top, gaps between its cards included; ours never does", async () => {
    const undo = install();
    try {
      const under = field('field|f|under', [740, 300, 840, 320], 'Nom', [740, 302, 800, 318]);
      const outside = field('field|f|outside', [300, 298, 400, 318], 'Nom', [300, 300, 360, 316]);
      dom.doc.children[0].append(under.l, outside.l);
      // The panel: as high as the window, dark, with a card in it; the label lies in the gap below the card.
      const host = el('DIV', [0, 0, 0, 0]);
      const root = host.attachShadow();
      const panel = el('DIV', [700, 0, 1000, 800], { backgroundColor: 'rgb(32, 32, 32)' }, el('DIV', [720, 100, 980, 200], { backgroundColor: 'rgb(48, 48, 48)' }));
      root.append(panel);
      panel.parentElement = null;
      panel.parentNode = root;
      // The translator's own host on <html> paints too, but is never another tool's panel.
      const ours = el('DXT-TRANSLATOR', [0, 0, 400, 800], WHITE);
      const { Overlay } = await overlay();
      const ov = new Overlay(plain);
      ov.start();
      dom.doc.append(host, ours); // after the overlay's own host (parts() takes the first shadow host on <html>)
      ov.sync([under.a, outside.a]);
      dom.hit = host; // a hit test in the panel finds its host (the DOM retargets out of the shadow root)
      dom.raf!();
      eq(segments(), [['translate(298px,299px)', '64px', '18px']], 'gone under the panel; the one beside it stays');
      eq(ov.rectOf(under.a), null, 'nothing of it shows');
      // The panel lies under the page (a hit test finds the page there): every mark shows.
      dom.hit = under.l;
      ov.invalidate(1);
      dom.raf!();
      eq(segments(), [['translate(738px,301px)', '64px', '18px'], ['translate(298px,299px)', '64px', '18px']]);
      // Closed: the same.
      host.remove();
      dom.hit = host;
      ov.invalidate(1);
      dom.raf!();
      eq(segments().length, 2);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: a label inside a popup is under another one only where a hit test finds it: a dropdown over the header flyout', async () => {
    const undo = install();
    try {
      const ltop = field('field|f|header_revenue', [320, 118, 600, 138], 'Chiffre', [320, 120, 400, 136]);
      const lfl = field('field|f|header_owner', [320, 248, 600, 268], 'Propriétaire', [320, 250, 420, 266]);
      const option = el('DIV', [310, 240, 600, 270]);
      const r1 = portal(true, el('DIV', [300, 100, 700, 300], WHITE, ltop.l, lfl.l));
      const r2 = portal(false, el('DIV', [300, 230, 620, 400], WHITE, option));
      dom.doc.children[0].append(r1, r2);
      dom.portals = [r1, r2];
      dom.hit = option;
      const { Overlay } = await overlay();
      const ov = new Overlay(plain);
      ov.start();
      ov.sync([ltop.a, lfl.a]);
      dom.raf!();
      eq(segments(), [['translate(318px,119px)', '84px', '18px']], 'the dropdown lies over the owner label');
      dom.hit = lfl.l;
      ov.invalidate(1);
      dom.raf!();
      eq(segments(), [['translate(318px,119px)', '84px', '18px'], ['translate(318px,249px)', '104px', '18px']], 'the flyout lies over the dropdown: both marked');
      eq(clips(), ['', '']);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: with a modal open, a flyout left open behind it never shows its labels; a dropdown opened over the modal does', async () => {
    const undo = install();
    try {
      const body = dom.doc.children[0];
      const modal = el('DIV', [200, 100, 800, 600], WHITE);
      modal.attrs['aria-modal'] = 'true';
      // The header fields flyout, still open in the mount node (no role), with a label of its own.
      const own = field('field|f|header_revenue', [320, 118, 600, 138], 'Chiffre', [320, 120, 440, 136]);
      const root = portal(true, el('DIV', [0, 0, 0, 0], {}, el('DIV', [300, 110, 700, 300], WHITE, own.l)));
      body.append(modal, root);
      dom.layers = [modal];
      dom.portals = [root];
      dom.hit = modal; // the modal lies over the flyout
      const { Overlay } = await overlay();
      const ov = new Overlay(plain);
      ov.start();
      ov.sync([own.a]);
      dom.raf!();
      eq([segments(), ov.rectOf(own.a)], [[], null], 'behind the modal: no mark, no place for a popup');
      // A dropdown opened from the modal, in a portal over it: its option is marked, the flyout's label still isn't.
      const opt = field('option|e.a|1', [320, 400, 500, 420], 'Actif', [320, 402, 370, 418]);
      const r2 = portal(false, el('DIV', [300, 390, 520, 500], WHITE, opt.l));
      body.append(r2);
      dom.portals = [root, r2];
      dom.hit = opt.l;
      ov.stop(); // (the fake page reports no mutation: the portals are found again on start)
      ov.start();
      ov.sync([own.a, opt.a]);
      dom.raf!();
      eq(segments(), [['translate(318px,401px)', '54px', '18px']]);
      eq(ov.rectOf(own.a), null);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: an option of a dropdown opened over the header flyout gets its pencil (it floats over the flyout)', async () => {
    const undo = install();
    try {
      const r1 = portal(true, el('DIV', [300, 100, 700, 300], WHITE));
      const opt = field('option|e.a|1', [310, 240, 600, 270], 'Actif', [320, 248, 370, 264]);
      const r2 = portal(false, el('DIV', [300, 230, 620, 400], WHITE, opt.l));
      dom.doc.children[0].append(r1, r2);
      dom.portals = [r1, r2];
      dom.hit = opt.l;
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok' });
      ov.start();
      ov.sync([opt.a]);
      fire('pointerover', opt.t, at(330, 256));
      dom.raf!();
      eq([classes(), segments(), clips()], [['g is-ok is-hv'], [['translate(318px,247px)', '54px', '18px']], ['']]);
      eq(badges().length, 1, 'the flyout under it does not hide the pencil');
      // The flyout over the dropdown there: the pencil is not drawn on it.
      dom.hit = r1.children[0];
      ov.invalidate(1);
      dom.raf!();
      eq(badges(), []);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: a newer portal with many elements never keeps an older one\'s flyout from covering the marks', async () => {
    const undo = install();
    try {
      const under = field('field|f|stage', [320, 148, 400, 168], 'Étape 1', [320, 150, 380, 166]);
      const older = portal(true, el('DIV', [0, 0, 0, 0], {}, el('DIV', [300, 100, 700, 300], WHITE)));
      // A transparent full-height layer of 70 transparent rows (a virtualized list kept in its own portal).
      const rows = Array.from({ length: 70 }, (_, i) => el('DIV', [0, i * 10, 1000, i * 10 + 10]));
      const newer = portal(false, el('DIV', [0, 0, 1000, 800], {}, ...rows));
      dom.doc.children[0].append(under.l, older, newer);
      dom.portals = [older, newer];
      const { Overlay } = await overlay();
      const ov = new Overlay(plain);
      ov.start();
      ov.sync([under.a]);
      dom.raf!();
      eq([segments(), ov.rectOf(under.a)], [[], null], 'under the flyout card: covered');
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: on a narrow window a flyout card nearly as wide as the window still covers the marks under it', async () => {
    const undo = install();
    try {
      Object.defineProperty(globalThis, 'innerWidth', { value: 600, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'innerHeight', { value: 400, configurable: true, writable: true });
      const under = field('field|f|stage', [100, 148, 200, 168], 'Étape 1', [100, 150, 160, 166]);
      const below = field('field|f|web', [100, 348, 200, 368], 'Site Web', [100, 350, 170, 366]);
      // 580 px of a 600 px window, transparent inside: the card itself is what covers.
      const card = el('DIV', [10, 100, 590, 300], WHITE, el('DIV', [10, 100, 590, 300], {}, el('DIV', [20, 110, 580, 140])));
      const root = portal(true, card);
      dom.doc.children[0].append(under.l, below.l, root);
      dom.portals = [root];
      const { Overlay } = await overlay();
      const ov = new Overlay(plain);
      ov.start();
      ov.sync([under.a, below.a]);
      dom.raf!();
      eq([segments(), clips()], [[['translate(98px,349px)', '74px', '18px']], ['']], 'only the label below the card');
      eq(ov.rectOf(under.a), null);
      // A painted element in it is what covers then: the card's own space around it is not.
      card.children[0].children[0].cs = WHITE;
      ov.invalidate(1);
      dom.raf!();
      eq(segments(), [['translate(98px,149px)', '64px', '18px'], ['translate(98px,349px)', '74px', '18px']]);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay css: in forced colors the label found from the list is not pulsed (the ring would keep its colour)', () => {
    const fc = /@media \(forced-colors:active\)\{([^\n]*)\}/.exec(css)?.[1] || '';
    ok(/\.g\.is-pl>i\{animation:none\}/.test(fc), fc);
  });

  test('overlay dom: the pencil is never drawn over a popup; a mark next to one has its ring cut at its edge', async () => {
    const undo = install();
    try {
      const x = field('x', [10, 100, 62, 120], 'Titre', [10, 102, 60, 118]);
      const pop = el('DIV', [65, 90, 300, 200], WHITE);
      const root = portal(true, pop);
      dom.doc.children[0].append(x.l, root);
      dom.portals = [root];
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok' });
      ov.start();
      ov.sync([x.a]);
      fire('pointerover', x.t, at(30, 110));
      dom.raf!();
      eq(classes(), ['g is-ok is-hv']);
      eq(badges(), [], 'the pencil (64..78) would lie on the popup (65..)');
      eq(clips(), ['path("M-4 -4h61v26h-61z")']);
      pop.rect = [400, 90, 600, 200];
      ov.invalidate(1);
      dom.raf!();
      eq(badges(), ['translate(64px,103px)']);
      eq(clips(), ['']);
      ov.stop();
    } finally {
      undo();
    }
  });

  test("overlay dom: the marks lie just under the translator's own layer (2147483646): its popup, list sheet and bar are drawn over them", async () => {
    const undo = install();
    try {
      const { Overlay } = await overlay();
      const ov = new Overlay(plain);
      ov.start();
      const host = dom.doc.children.find((c) => c.shadowRoot)!.style.cssText;
      ok(/z-index:2147483645;/.test(host) && /pointer-events:none/.test(host), host);
      ov.stop();
    } finally {
      undo();
    }
  });

  // ---- only the text is the label ----

  test('overlay dom: beside the text of a label that acts (a button, a tab, a collapse button around a header) a click is swallowed and opens nothing; on the text it opens; Alt+click is the page\'s', async () => {
    const undo = install();
    try {
      const body = dom.doc.children[0];
      // A command button: its whole button is the zone.
      const bt = text('Supprimer', [[310, 104, 390, 120]]);
      const btn = el('BUTTON', [300, 96, 420, 128], {}, bt);
      const del = { el: btn, text: bt, comp: 'command|del', kind: 'command', key: 'command|del|Label', role: 'command' } as unknown as Anchor;
      // A form tab: an LI without button markup, its role says it acts.
      const tt = text('Résumé', [[510, 104, 560, 120]]);
      const li = el('LI', [500, 96, 600, 128], {}, tt);
      const tab = { el: li, text: tt, comp: 'tab|f|t1', kind: 'tab', key: 'tab|f|t1|Label', role: 'tab' } as unknown as Anchor;
      // A section header (a plain label) whose text sits in a collapse button inside its zone.
      const ht = text('Général', [[20, 204, 80, 220]]);
      const tog = el('DIV', [10, 200, 400, 224], {}, ht);
      tog.attrs.role = 'button';
      const hd = el('H2', [10, 200, 400, 224], {}, tog);
      const sec = { el: hd, text: ht, comp: 'section|f|s1', kind: 'section', key: 'section|f|s1|Label', role: 'label' } as unknown as Anchor;
      body.append(btn, li, hd);
      const opened: string[] = [];
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok', open: (x) => opened.push(x.comp) });
      ov.start();
      ov.sync([del, tab, sec]);
      dom.raf!();
      const swallowed = (evs: Ev[]) => evs.every((e) => e.prevented && e.stopped);
      ok(swallowed(clickOn(btn, at(410, 112))), '"Supprimer": right of its text, in the button');
      ok(swallowed(clickOn(btn, at(350, 126))), 'under its text');
      ok(fire('dblclick', btn, { ...at(410, 112), detail: 2 }).prevented, 'its double-click');
      ok(swallowed(clickOn(li, at(590, 112))), 'the tab');
      ok(swallowed(clickOn(tog, at(300, 212))), 'the collapse button');
      eq(opened, [], 'nothing opens beside the text');
      // Nor is anything hovered there.
      const sheet = () => (document.adoptedStyleSheets as unknown as Array<{ text: string }>)[0].text;
      fire('pointerover', btn, at(410, 112));
      dom.raf!();
      eq([classes(), sheet()], [['g is-ok', 'g is-ok', 'g is-ok'], '']);
      // On their text: their popups.
      ok(swallowed(clickOn(btn, at(350, 112))));
      ok(swallowed(clickOn(li, at(530, 112))));
      ok(swallowed(clickOn(tog, at(40, 212))));
      eq(opened, ['command|del', 'tab|f|t1', 'section|f|s1']);
      // Alt+click: the page's action, beside the text and on it.
      for (const [t, x, y] of [[btn, 410, 112], [btn, 350, 112], [li, 590, 112], [tog, 300, 212]] as const) ok(clickOn(t, { ...at(x, y), altKey: true }).every((e) => !e.prevented && !e.stopped), `Alt at ${x},${y}`);
      eq(opened.length, 3);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: the hover ring, the pencil and the pointer cursor follow the text, never the rest of the zone; text that moves under a still pointer is found', async () => {
    const undo = install();
    try {
      // "Titre" in a label much wider than it (its mark: 8..62 × 103..121, its pencil 64..78 × 105..119).
      const f = field('field|f|1', [10, 100, 200, 124], 'Titre', [10, 104, 60, 120]);
      dom.doc.children[0].append(f.l);
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok' });
      ov.start();
      ov.sync([f.a]);
      dom.raf!();
      const sheet = () => (document.adoptedStyleSheets as unknown as Array<{ text: string }>)[0].text;
      const now = () => (dom.raf!(), [classes(), badges().length, sheet()]);
      const none = [['g is-ok'], 0, ''];
      const hv = [['g is-ok is-hv'], 1, CURSOR];
      fire('pointerover', f.l, at(150, 112));
      eq(now(), none, 'in the label, right of its text');
      fire('pointermove', f.l, at(70, 112));
      eq(now(), none, 'where its pencil would be: none is drawn');
      fire('pointermove', f.l, at(40, 112));
      eq(now(), hv, 'onto the text without entering another element');
      fire('pointermove', f.l, at(63, 112));
      eq(now(), hv, 'within 2 px of its mark');
      fire('pointermove', f.l, at(80, 112));
      eq(now(), none, 'off it');
      // The text moves under the still pointer (a layout change, a scroll): the next frame finds it, and loses it.
      f.t.rects = [{ left: 50, top: 104, right: 100, bottom: 120 }];
      ov.invalidate(1);
      eq(now(), hv, 'moved under the pointer');
      f.t.rects = [{ left: 120, top: 104, right: 170, bottom: 120 }];
      ov.invalidate(1);
      eq(now(), none, 'moved away');
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: a label without a mark this frame keeps its whole zone (not measured yet, or its text partly scrolled out); once marked, only its text', async () => {
    const undo = install();
    try {
      // Its text sticks out of the scroll container (100..700): no mark.
      const t1 = text('Client', [[10, 690, 80, 707]]);
      const label = el('LABEL', [10, 680, 200, 700], {}, t1);
      dom.doc.children[0].append(el('DIV', [0, 100, 1000, 700], { overflowY: 'auto' }, label));
      const a = { el: label, text: t1, comp: 'field|f|1', kind: 'field', key: 'k', role: 'label' } as unknown as Anchor;
      const opened: string[] = [];
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, open: (x) => opened.push(x.comp) });
      ov.start();
      ov.sync([a]);
      const sheet = () => (document.adoptedStyleSheets as unknown as Array<{ text: string }>)[0].text;
      ok(clickOn(label, at(150, 690)).every((e) => e.prevented), 'not measured yet: its zone');
      dom.raf!();
      eq(segments(), [], 'no mark');
      ok(clickOn(label, at(150, 690)).every((e) => e.prevented), 'beside its text: still its zone');
      eq(opened, ['field|f|1', 'field|f|1']);
      fire('pointerover', label, at(150, 690));
      eq(sheet(), CURSOR, 'the pointer over its zone');
      // Scrolled into view: marked, and only its text is the label now.
      t1.rects = [{ left: 10, top: 682, right: 80, bottom: 699 }];
      ov.invalidate(1);
      dom.raf!();
      eq(segments().length, 1);
      eq(sheet(), '', 'the pointer beside its text: no cursor any more');
      ok(clickOn(label, at(150, 690)).every((e) => !e.prevented && !e.stopped), 'beside its text: the page');
      ok(clickOn(label, at(40, 690)).every((e) => e.prevented), 'on it: its popup');
      eq(opened, ['field|f|1', 'field|f|1', 'field|f|1']);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: every role whose whole zone acts (navigation item, process stage, sorting column header, option, tab, command) swallows a click beside its text without any markup', async () => {
    const undo = install();
    try {
      const body = dom.doc.children[0];
      // Each zone is a plain DIV or LI, no role attribute, no control in it: only the label's role says it acts.
      const made = (['nav', 'stage', 'header', 'option', 'tab', 'command'] as const).map((role, i) => {
        const y = 100 + i * 40;
        const t = text(role, [[20, y + 4, 60, y + 20]]);
        const z = el(i % 2 ? 'LI' : 'DIV', [10, y, 300, y + 24], {}, t);
        body.append(z);
        return { z, y, a: { el: z, text: t, comp: `${role}|1`, kind: 'subarea', key: `${role}|1|Label`, role } as unknown as Anchor };
      });
      const opened: string[] = [];
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok', open: (x) => opened.push(x.comp) });
      ov.start();
      ov.sync(made.map((m) => m.a));
      dom.raf!();
      const sheet = () => (document.adoptedStyleSheets as unknown as Array<{ text: string }>)[0].text;
      for (const { z, y, a } of made) {
        ok(clickOn(z, at(200, y + 12)).every((e) => e.prevented && e.stopped), `${a.role}: beside its text`);
        fire('pointerover', z, at(200, y + 12));
        dom.raf!();
        eq([classes().some((c) => c.includes('is-hv')), sheet()], [false, ''], `${a.role}: no hover there`);
      }
      eq(opened, [], 'nothing opens beside the text');
      for (const { z, y, a } of made) ok(clickOn(z, at(40, y + 12)).every((e) => e.prevented && e.stopped), `${a.role}: on its text`);
      eq(opened, made.map((m) => m.a.comp));
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: beside the text of a label inside something that acts (a view selector in its button, a menu item), a click is swallowed and opens nothing', async () => {
    const undo = install();
    try {
      const body = dom.doc.children[0];
      // A list's view selector: div[role=button] > span (the zone, a stretched flex item much wider than its text).
      const vt = text('Comptes actifs', [[110, 104, 210, 120]]);
      const vspan = el('SPAN', [106, 100, 260, 124], {}, vt);
      const vs = el('DIV', [100, 96, 280, 128], {}, vspan);
      vs.attrs.role = 'button';
      const view = { el: vspan, text: vt, comp: 'view|v1', kind: 'view', key: 'view|v1|Name', role: 'label' } as unknown as Anchor;
      // An item of the list of dashboards: li[role=menuitem] > span filling its row.
      const dt = text('Tableau de bord', [[110, 204, 230, 220]]);
      const dspan = el('SPAN', [106, 200, 380, 224], {}, dt);
      const item = el('LI', [100, 196, 400, 228], {}, dspan);
      item.attrs.role = 'menuitem';
      const dash = { el: dspan, text: dt, comp: 'dashboard|d1', kind: 'dashboard', key: 'dashboard|d1|Name', role: 'label' } as unknown as Anchor;
      body.append(vs, item);
      const opened: string[] = [];
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok', open: (x) => opened.push(x.comp) });
      ov.start();
      ov.sync([view, dash]);
      dom.raf!();
      ok(clickOn(vspan, at(240, 112)).every((e) => e.prevented && e.stopped), 'right of the view name, in its span: the view menu does not open');
      ok(clickOn(dspan, at(300, 212)).every((e) => e.prevented && e.stopped), 'right of the dashboard name: it does not switch');
      eq(opened, []);
      ok(clickOn(vspan, at(150, 112)).every((e) => e.prevented && e.stopped));
      ok(clickOn(dspan, at(150, 212)).every((e) => e.prevented && e.stopped));
      eq(opened, ['view|v1', 'dashboard|d1']);
      ok(clickOn(vspan, { ...at(240, 112), altKey: true }).every((e) => !e.prevented && !e.stopped), 'Alt+click: the page');
      ov.stop();
    } finally {
      undo();
    }
  });

  test("overlay dom: beside the text of a <label> for a checkbox, a click is swallowed (the browser would toggle it); for a text box it reaches the page", async () => {
    const s = await setup();
    try {
      Object.assign(s.label, { control: s.check });
      ok(clickOn(s.label, s.BESIDE).every((e) => e.prevented && e.stopped), 'the Yes/No value does not flip');
      eq(s.opened, []);
      ok(clickOn(s.span, s.ON).every((e) => e.prevented && e.stopped), 'on its text: its popup');
      eq(s.opened, ['field|f|1']);
      Object.assign(s.label, { control: s.input });
      ok(clickOn(s.label, s.BESIDE).every((e) => !e.prevented && !e.stopped), 'a text box: focusing it changes nothing');
    } finally {
      s.ov.stop();
      s.undo();
    }
  });

  test('overlay dom: the parts of a sorting column header, none marked yet: a click anywhere on it is swallowed, never sorts, opens nothing', async () => {
    const undo = install();
    try {
      // A linked table's column "Nom complet (Contact principal)": two names in one text, one zone (the header cell).
      const t = text('Nom complet (Contact principal)', [[100, 102, 348, 120]]);
      const hdr = el('DIV', [90, 96, 420, 128], {}, t);
      dom.doc.children[0].append(hdr);
      const part = (start: number, end: number, txt: string) => ({ start, end, text: txt });
      const p1 = { el: hdr, text: t, part: part(0, 11, 'Nom complet'), comp: 'attribute|contact.fullname', kind: 'attribute', key: 'p1', role: 'header' } as unknown as Anchor;
      const p2 = { el: hdr, text: t, part: part(13, 30, 'Contact principal'), comp: 'attribute|account.primarycontactid', kind: 'attribute', key: 'p2', role: 'header' } as unknown as Anchor;
      const opened: string[] = [];
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok', open: (x) => opened.push(x.comp) });
      ov.start();
      ov.sync([p1, p2]);
      ok(clickOn(hdr, at(150, 110)).every((e) => e.prevented && e.stopped), 'on its text');
      ok(clickOn(hdr, at(400, 110)).every((e) => e.prevented && e.stopped), 'beside it');
      eq(opened, []);
      // Measured: each name opens its own.
      dom.raf!();
      clickOn(hdr, at(110, 110));
      clickOn(hdr, at(250, 110));
      eq(opened, ['attribute|contact.fullname', 'attribute|account.primarycontactid']);
      ov.stop();
    } finally {
      undo();
    }
  });

  test("overlay dom: a record listed under Recent is not Recent's: its clicks reach the page; Recent's own row still acts unless it says it expands (below)", async () => {
    const undo = install();
    try {
      // li[role=treeitem] Recent > its text, and ul[role=group] > li[role=treeitem] > the record's name (never marked).
      const rt = text('Récent', [[30, 104, 80, 120]]);
      const nt = text('DXT BPF Test', [[50, 134, 150, 150]]);
      const name = el('SPAN', [50, 134, 150, 150], {}, nt);
      const rec = el('LI', [40, 130, 300, 154], {}, name);
      rec.attrs.role = 'treeitem';
      const group = el('UL', [40, 128, 300, 180], {}, rec);
      group.attrs.role = 'group';
      const recent = el('LI', [0, 96, 300, 180], {}, el('SPAN', [30, 104, 80, 120], {}, rt), group);
      recent.attrs.role = 'treeitem';
      dom.doc.children[0].append(recent);
      const a = { el: recent, text: rt, comp: 'builtin|nav|recent', kind: 'subarea', key: 'builtin|nav|recent|Label', role: 'nav' } as unknown as Anchor;
      const opened: string[] = [];
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'builtin', open: (x) => opened.push(x.comp) });
      ov.start();
      ov.sync([a]);
      dom.raf!();
      ok(clickOn(name, at(100, 142)).every((e) => !e.prevented && !e.stopped), 'on the record: it opens');
      ok(clickOn(rec, at(250, 142)).every((e) => !e.prevented && !e.stopped), 'beside its name, in its row');
      const sheet = () => (document.adoptedStyleSheets as unknown as Array<{ text: string }>)[0].text;
      fire('pointerover', name, at(100, 142));
      eq(sheet(), '', 'no pointer over it');
      eq(opened, []);
      ok(clickOn(recent, at(200, 112)).every((e) => e.prevented && e.stopped), "beside Recent's text, in its own row (no aria-expanded: it may open a page): nothing");
      eq(opened, []);
      ok(clickOn(recent, at(50, 112)).every((e) => e.prevented && e.stopped));
      eq(opened, ['builtin|nav|recent']);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: in the navigation a click beside a group\'s title (its chevron, its header) reaches the page and the group opens or closes; on the title its popup; a near miss on an item that opens a page is still swallowed', async () => {
    const undo = install();
    try {
      const set = (e: FakeEl, attrs: Record<string, string>) => (Object.assign(e.attrs, attrs), e);
      // div[data-id=navbar-container] > the button that collapses it, and ul[role=tree] > li[role=treeitem][aria-expanded]
      // (the group "Livraison") > its header (the title's span, the zone, holding the chevron) and ul[role=group] >
      // li[role=treeitem] (the item "Projets", which opens its list).
      const gt = text('Livraison', [[16, 56, 80, 72]]);
      const chevron = el('I', [196, 56, 212, 72]);
      const title = set(el('SPAN', [12, 52, 216, 76], {}, gt, chevron), { 'data-id': 'sitemap-sitemapAreaGroup-Delivery' });
      const header = el('DIV', [0, 48, 220, 80], {}, title);
      const it = text('Projets', [[40, 88, 90, 104]]);
      const item = set(el('LI', [0, 84, 220, 112], {}, el('SPAN', [40, 88, 90, 104], {}, it)), { role: 'treeitem', 'data-id': 'sitemap-entity-new_project' });
      const items = set(el('UL', [0, 80, 220, 200], {}, item), { role: 'group' });
      const group = set(el('LI', [0, 48, 220, 200], {}, header, items), { role: 'treeitem', 'aria-expanded': 'true' });
      // Recent: an entry that expands to list the records last opened.
      const rt = text('Récent', [[40, 212, 90, 228]]);
      const recent = set(el('LI', [0, 208, 220, 232], {}, el('SPAN', [40, 212, 90, 228], {}, rt), el('I', [196, 212, 212, 228])), {
        role: 'treeitem',
        'aria-expanded': 'false',
        'data-id': 'sitemap-entity-Recent_00000000-0000-0000-0000-000000000000',
      });
      const tree = set(el('UL', [0, 48, 220, 600], {}, group, recent), { role: 'tree' });
      const burger = set(el('BUTTON', [8, 8, 40, 40], {}, el('I', [16, 16, 32, 32])), { 'aria-expanded': 'true', 'aria-label': 'Plan de site' });
      const nav = set(el('DIV', [0, 0, 220, 700], {}, burger, tree), { 'data-id': 'navbar-container' });
      // The area switcher below it: a button showing the area ("Ventes") and a chevron; it opens the list of areas.
      const st = text('Ventes', [[48, 752, 100, 768]]);
      const swChevron = el('I', [196, 752, 212, 768]);
      const sw = set(el('BUTTON', [0, 740, 220, 780], {}, el('SPAN', [48, 752, 100, 768], {}, st), swChevron), { id: 'areaSwitcherId', 'aria-haspopup': 'true' });
      dom.doc.children[0].append(nav, sw);
      const nav$ = (e: FakeEl, t: FakeEl, comp: string, kind: string) => ({ el: e, text: t, comp, kind, key: `${comp}|Title`, role: 'nav' }) as unknown as Anchor;
      const grp = nav$(title, gt, 'group|sm|g1', 'group');
      const itm = nav$(item, it, 'subarea|sm|s1', 'subarea');
      const rec = nav$(recent, rt, 'builtin|nav|recent', 'subarea');
      const area = nav$(sw, st, 'area|sm|a1', 'area');
      const opened: string[] = [];
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok', open: (x) => opened.push(x.comp) });
      ov.start();
      ov.sync([grp, itm, rec, area]);
      dom.raf!();
      const page = (evs: Ev[]) => evs.every((e) => !e.prevented && !e.stopped);
      const swallowed = (evs: Ev[]) => evs.every((e) => e.prevented && e.stopped);
      ok(page(clickOn(chevron, at(204, 64))), "the group's chevron: the group closes");
      ok(page(clickOn(title, at(150, 64))), 'beside its title, in its span');
      ok(page(clickOn(header, at(204, 78))), 'its header under the chevron');
      ok(!fire('dblclick', title, { ...at(150, 64), detail: 2 }).prevented, 'its double-click too');
      ok(page(clickOn(recent, at(150, 220))), "beside Recent's text: it opens");
      ok(page(clickOn(sw, at(150, 760))) && page(clickOn(swChevron, at(204, 760))), 'the area switcher beside its text: the list of areas opens');
      ok(page(clickOn(burger, at(24, 24))), 'the button that collapses the navigation');
      eq(opened, [], 'nothing opens there');
      const sheet = () => (document.adoptedStyleSheets as unknown as Array<{ text: string }>)[0].text;
      fire('pointerover', title, at(150, 64));
      dom.raf!();
      eq([classes().some((c) => c.includes('is-hv')), sheet()], [false, ''], 'no hover, no pointer beside the title');
      // An item that opens a page: a near miss beside its text still does nothing.
      ok(swallowed(clickOn(item, at(150, 98))), "beside the item's text, in its row: its list does not open");
      eq(opened, []);
      // On their texts: their popups.
      ok(swallowed(clickOn(title, at(40, 64))));
      ok(swallowed(clickOn(item, at(60, 96))));
      ok(swallowed(clickOn(recent, at(60, 220))));
      ok(swallowed(clickOn(sw, at(70, 760))));
      eq(opened, ['group|sm|g1', 'subarea|sm|s1', 'builtin|nav|recent', 'area|sm|a1']);
      // Collapsed, the group is the same toggle.
      group.attrs['aria-expanded'] = 'false';
      ok(page(clickOn(chevron, at(204, 64))), 'the chevron of a closed group: it opens');
      ov.stop();
    } finally {
      undo();
    }
  });

  test("overlay dom: the form and view selectors open their lists beside their text, and in the lists (areas, forms, views) a click beside an item's text picks it; on a text its popup; a command's menu still swallows a near miss", async () => {
    const undo = install();
    try {
      const set = (e: FakeEl, attrs: Record<string, string>) => (Object.assign(e.attrs, attrs), e);
      const V1 = 'c0976d89-355d-4954-acfc-ade8835cbf4c';
      const V2 = '6b3e6539-38ab-406f-9aaa-192e75e9d23c';
      // The form selector in the record's header (live): its name a bare text node, then its chevron.
      const ft = text('Compte', [[20, 24, 70, 40]]);
      const fChevron = el('SPAN', [76, 24, 92, 40], {}, el('SVG', [76, 24, 92, 40]));
      const formSel = set(el('BUTTON', [12, 20, 100, 44], {}, ft, fChevron), { 'data-id': 'form-selector', role: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
      // A list page's view selector: its name in a label span, then a chevron, in the button.
      const vt = text('Projets actifs', [[20, 64, 130, 84]]);
      const vLabel = el('SPAN', [20, 64, 130, 84], {}, vt);
      const vChevron = el('I', [140, 66, 156, 82]);
      const viewSel = set(el('BUTTON', [12, 60, 164, 88], {}, el('SPAN', [12, 60, 164, 88], {}, el('SPAN', [20, 64, 130, 84], {}, vLabel), vChevron)), {
        id: `ViewSelector_0_${V1}`,
        'data-id': `ViewSelector_${V1}`,
        'aria-haspopup': 'true',
        'aria-expanded': 'true',
      });
      // Its list, open (a Fluent v8 portal): a view, then Microsoft's own "Manage and share views".
      const it2 = text('Projets inactifs', [[40, 124, 150, 140]]);
      const view2 = set(el('BUTTON', [10, 120, 300, 144], {}, el('SPAN', [10, 120, 300, 144], {}, el('I', [14, 124, 30, 140]), el('LABEL', [40, 124, 150, 140], {}, it2))), { role: 'menuitemradio', 'data-value': V2, 'aria-checked': 'false' });
      const manage = set(el('BUTTON', [10, 150, 300, 174], {}, el('SPAN', [10, 150, 300, 174], {}, el('LABEL', [40, 154, 200, 170], {}, text('Gérer et partager les vues', [[40, 154, 200, 170]])))), { role: 'menuitem' });
      const views = set(el('DIV', [10, 110, 300, 180], {}, set(el('DIV', [10, 110, 300, 180], {}, set(el('UL', [10, 110, 300, 180], {}, el('LI', [10, 120, 300, 144], {}, view2), el('LI', [10, 150, 300, 174], {}, manage)), { role: 'menu' })), { role: 'dialog' })), {
        'data-id': `ViewSelector_${V1}-flyout`,
      });
      // The list of areas (a portal under body) and the list of forms (a Fluent v9 portal).
      const at2 = text('Paramètres', [[440, 124, 520, 140]]);
      const area2 = set(el('LI', [420, 120, 700, 144], {}, el('SPAN', [424, 124, 436, 140]), el('SPAN', [440, 124, 520, 140], {}, at2)), { role: 'menuitemradio', 'data-id': 'areaswitcherflyout-dxt_area2', 'aria-checked': 'false' });
      const areas = set(el('DIV', [420, 110, 700, 180], {}, set(el('UL', [420, 110, 700, 180], {}, area2), { role: 'menu' })), { 'data-lp-id': 'sitemap-area-switcher-flyout', role: 'presentation' });
      const fo2 = text('Informations', [[440, 224, 530, 240]]);
      const form2 = set(el('DIV', [420, 220, 700, 244], {}, el('SPAN', [424, 224, 436, 240]), el('SPAN', [440, 224, 530, 240], {}, fo2)), { role: 'menuitemradio', name: 'form', 'data-value': 'b053a39a-041a-4356-acef-ddf00182762b', 'aria-checked': 'false' });
      const forms = set(el('DIV', [420, 210, 700, 280], {}, set(el('DIV', [420, 210, 700, 280], {}, form2), { role: 'menu' })), { 'data-id': 'form-selector-flyout', role: 'presentation' });
      // A command's menu (a flyout of the command bar) with a radio item: a near miss there still does nothing.
      const ct = text('Par date', [[440, 324, 500, 340]]);
      const cmdItem = set(el('DIV', [420, 320, 700, 344], {}, el('SPAN', [440, 324, 500, 340], {}, ct)), { role: 'menuitemradio' });
      const cmdMenu = set(el('DIV', [420, 310, 700, 380], {}, set(el('DIV', [420, 310, 700, 380], {}, cmdItem), { role: 'menu' })), { 'data-id': 'CommandBar' });
      dom.doc.children[0].append(formSel, el('H1', [12, 60, 164, 88], {}, viewSel), views, areas, forms, cmdMenu);
      const A = (e: FakeEl, t: FakeEl, comp: string, role: string, zone?: FakeEl) => ({ el: e, text: t, comp, kind: comp.split('|')[0], key: `${comp}|Name`, role, ...(zone ? { zone } : {}) }) as unknown as Anchor;
      const fA = A(formSel, ft, 'form|f1', 'label');
      const vA = A(vLabel, vt, `view|${V1}`, 'label', viewSel);
      const v2A = A(it2.parentElement!, it2, `view|${V2}`, 'nav', view2);
      const a2A = A(at2.parentElement!, at2, 'area|sm|dxt_area2', 'nav', area2);
      const f2A = A(fo2.parentElement!, fo2, 'form|f2', 'nav', form2);
      const cA = A(ct.parentElement!, ct, 'ribbon|e|c', 'command', cmdItem);
      const opened: string[] = [];
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok', open: (x) => opened.push(x.comp) });
      ov.start();
      ov.sync([fA, vA, v2A, a2A, f2A, cA]);
      dom.raf!();
      const page = (evs: Ev[]) => evs.every((e) => !e.prevented && !e.stopped);
      const swallowed = (evs: Ev[]) => evs.every((e) => e.prevented && e.stopped);
      // The selectors: beside the text (the chevron, the padding) the list opens.
      ok(page(clickOn(fChevron.children[0], at(84, 32))) && page(clickOn(fChevron, at(84, 32))), "the form selector's chevron");
      ok(page(clickOn(formSel, at(96, 42))), "the form selector's padding");
      ok(page(clickOn(vChevron, at(148, 74))), "the view selector's chevron");
      ok(page(clickOn(viewSel, at(160, 86))), "the view selector's padding");
      // The lists: beside an item's text the item is picked.
      ok(page(clickOn(view2, at(250, 132))), 'beside a view');
      ok(page(clickOn(area2, at(650, 132))), 'beside an area');
      ok(page(clickOn(form2, at(650, 232))), 'beside a form');
      ok(page(clickOn(manage, at(250, 162))), '"Manage and share views" (no label): as without the translator');
      eq(opened, [], 'nothing opens there');
      // A command's menu: a near miss does nothing.
      ok(swallowed(clickOn(cmdItem, at(650, 332))), "beside a command's menu item");
      eq(opened, []);
      // On their texts: their popups, never the page's.
      ok(swallowed(clickOn(formSel, at(40, 32))));
      ok(swallowed(clickOn(vLabel, at(60, 74))));
      ok(swallowed(clickOn(it2.parentElement!, at(80, 132))));
      ok(swallowed(clickOn(at2.parentElement!, at(470, 132))));
      ok(swallowed(clickOn(fo2.parentElement!, at(470, 232))));
      ok(swallowed(clickOn(ct.parentElement!, at(470, 332))));
      eq(opened, ['form|f1', `view|${V1}`, `view|${V2}`, 'area|sm|dxt_area2', 'form|f2', 'ribbon|e|c']);
      ov.stop();
    } finally {
      undo();
    }
  });

  test("overlay dom: a selector's own name gets no pencil, which would lie over its chevron: hovered first, a click on the chevron still opens the list; an item of its list keeps its pencil", async () => {
    const undo = install();
    try {
      const set = (e: FakeEl, attrs: Record<string, string>) => (Object.assign(e.attrs, attrs), e);
      const V1 = 'c0976d89-355d-4954-acfc-ade8835cbf4c';
      const F2 = 'b053a39a-041a-4356-acef-ddf00182762b';
      // The form selector (Fluent v9): its name 20..70, the chevron 74..94 (a 4 px margin, a 20 px icon), right where a
      // pencil after the name's mark would go (74..88).
      const ft = text('Compte', [[20, 24, 70, 40]]);
      const fChevron = el('SPAN', [74, 22, 94, 42], {}, el('SVG', [74, 22, 94, 42]));
      const formSel = set(el('BUTTON', [12, 20, 100, 44], {}, ft, fChevron), { 'data-id': 'form-selector', role: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
      // A list page's view selector (Fluent v8): its label ends at 130, the chevron 138..150 (the pencil's place: 134..148).
      const vt = text('Projets actifs', [[20, 64, 130, 84]]);
      const vLabel = el('SPAN', [20, 64, 130, 84], {}, vt);
      const vChevron = el('I', [138, 66, 150, 82]);
      const viewSel = set(el('BUTTON', [12, 60, 164, 88], {}, el('SPAN', [12, 60, 164, 88], {}, el('SPAN', [20, 64, 130, 84], {}, vLabel), vChevron)), {
        'data-id': `ViewSelector_${V1}`,
        'aria-haspopup': 'true',
        'aria-expanded': 'false',
      });
      // An item of the list of forms (its text 440..530: its pencil at 534..548).
      const fo2 = text('Informations', [[440, 224, 530, 240]]);
      const form2 = set(el('DIV', [420, 220, 700, 244], {}, el('SPAN', [440, 224, 530, 240], {}, fo2)), { role: 'menuitemradio', 'data-value': F2, 'aria-checked': 'false' });
      const forms = set(el('DIV', [420, 210, 700, 280], {}, set(el('DIV', [420, 210, 700, 280], {}, form2), { role: 'menu' })), { 'data-id': 'form-selector-flyout', role: 'presentation' });
      dom.doc.children[0].append(formSel, el('H1', [12, 60, 164, 88], {}, viewSel), forms);
      const sw = (list: 'form' | 'view', id: string, opener: FakeEl) => ({ list, id, opener, find: '', item: '' });
      const A = (e: FakeEl, t: FakeEl, comp: string, role: string, s: ReturnType<typeof sw>, zone?: FakeEl) => ({ el: e, text: t, comp, kind: comp.split('|')[0], key: `${comp}|Name`, role, sw: s, ...(zone ? { zone } : {}) }) as unknown as Anchor;
      const fA = A(formSel, ft, 'form|f1', 'label', sw('form', '', formSel));
      const vA = A(vLabel, vt, `view|${V1}`, 'label', sw('view', '', viewSel), viewSel);
      const f2A = A(fo2.parentElement!, fo2, 'form|f2', 'nav', sw('form', F2, formSel), form2);
      const opened: string[] = [];
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok', open: (x) => opened.push(x.comp) });
      ov.start();
      ov.sync([fA, vA, f2A]);
      dom.raf!();
      const page = (evs: Ev[]) => evs.every((e) => !e.prevented && !e.stopped);
      const hv = () => classes().filter((c) => c.includes('is-hv')).length;
      // The form selector: its name hovered (the ring, no pencil), then the chevron, clicked.
      fire('pointerover', formSel, at(40, 32));
      dom.raf!();
      eq([hv(), badges()], [1, []], 'its name: the hover ring, no pencil');
      fire('pointermove', fChevron, at(80, 32));
      dom.raf!();
      ok(page(clickOn(fChevron, at(80, 32))), 'its chevron: the list of forms opens');
      // The view selector, the same way.
      fire('pointerover', vLabel, at(60, 74));
      dom.raf!();
      eq([hv(), badges()], [1, []]);
      fire('pointermove', vChevron, at(142, 74));
      dom.raf!();
      ok(page(clickOn(vChevron, at(142, 74))), 'its chevron: the list of views opens');
      eq(opened, [], 'no popup');
      // An item of the list: its pencil after its name, which opens its popup like the name.
      fire('pointerover', form2, at(470, 232));
      dom.raf!();
      eq(badges(), ['translate(534px,225px)']);
      fire('pointermove', form2, at(540, 232));
      dom.raf!();
      ok(clickOn(form2, at(540, 232)).every((e) => e.prevented && e.stopped));
      eq(opened, ['form|f2']);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: a label inside another: beside the inner text a click is the inner zone\'s (an acting one does nothing), the outer text wins where it is, an outer label not measured is no guess', async () => {
    const undo = install();
    try {
      // A section header (H2, a plain label: "Général", marked 18..82) holding an add button that is a command (a DIV
      // without button markup: only its role says it acts) whose box reaches over the end of "Général"; "Ajouter" is
      // marked 108..172.
      const gt = text('Général', [[20, 204, 80, 220]]);
      const gspan = el('SPAN', [20, 204, 80, 220], {}, gt);
      const ad = text('Ajouter', [[110, 204, 170, 220]]);
      const add = el('DIV', [70, 200, 200, 224], {}, ad);
      const h2 = el('H2', [10, 196, 800, 228], {}, gspan, add);
      dom.doc.children[0].append(h2);
      const sec = { el: h2, text: gt, comp: 'section|f|s1', kind: 'section', key: 'section|f|s1|Label', role: 'label' } as unknown as Anchor;
      const cmd = { el: add, text: ad, comp: 'command|add', kind: 'ribbon', key: 'command|add|Label', role: 'command' } as unknown as Anchor;
      const opened: string[] = [];
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok', open: (x) => opened.push(x.comp) });
      ov.start();
      ov.sync([cmd, sec]);
      dom.raf!();
      const swallowed = (evs: Ev[]) => evs.every((e) => e.prevented && e.stopped);
      ok(swallowed(clickOn(add, at(190, 212))), 'in the button beside "Ajouter" (and off "Général"): the command does not run');
      eq(opened, []);
      ok(clickOn(h2, at(600, 212)).every((e) => !e.prevented && !e.stopped), 'in the header beside both: the page');
      ok(swallowed(clickOn(add, at(130, 212))));
      ok(swallowed(clickOn(gspan, at(40, 212))));
      ok(swallowed(clickOn(add, at(76, 212))), 'on "Général" where the button lies over it');
      eq(opened, ['command|add', 'section|f|s1', 'section|f|s1']);
      // The header synced since the last frame (not measured yet): beside "Ajouter" it is no guess, the button still does
      // nothing; in the header itself, its whole zone.
      ov.sync([cmd]);
      dom.raf!();
      ov.sync([cmd, sec]);
      ok(swallowed(clickOn(add, at(190, 212))), 'not the header, not the command');
      eq(opened.length, 3);
      ok(swallowed(clickOn(h2, at(600, 212))), 'the header, not measured: its zone');
      eq(opened, ['command|add', 'section|f|s1', 'section|f|s1', 'section|f|s1']);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: the pencil is part of its label: the hover holds on it and a click on it opens the label; past it, it goes', async () => {
    const undo = install();
    try {
      // "Titre" in a label much wider than it, marked 8..62 × 103..121: its pencil goes at 64..78 × 105..119 once hovered.
      const f = field('field|f|1', [10, 100, 200, 124], 'Titre', [10, 104, 60, 120]);
      dom.doc.children[0].append(f.l);
      const opened: string[] = [];
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok', open: (x) => opened.push(x.comp) });
      ov.start();
      ov.sync([f.a]);
      dom.raf!();
      const sheet = () => (document.adoptedStyleSheets as unknown as Array<{ text: string }>)[0].text;
      fire('pointerover', f.l, at(40, 112));
      dom.raf!();
      eq(badges(), ['translate(64px,105px)']);
      fire('pointermove', f.l, at(70, 112));
      dom.raf!();
      eq([classes(), badges(), sheet()], [['g is-ok is-hv'], ['translate(64px,105px)'], CURSOR], 'on the pencil');
      ok(clickOn(f.l, at(70, 112)).every((e) => e.prevented && e.stopped));
      eq(opened, ['field|f|1']);
      fire('pointermove', f.l, at(80, 112));
      dom.raf!();
      eq([classes(), badges(), sheet()], [['g is-ok'], [], ''], 'past it');
      ok(clickOn(f.l, at(70, 112)).every((e) => !e.prevented && !e.stopped), 'where it was: the page');
      eq(opened, ['field|f|1']);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: a click pressed on the text and released a little beside it, in its zone, opens the label; released out of its zone, nothing', async () => {
    const s = await setup();
    try {
      fire('pointerdown', s.span, s.ON);
      fire('mousedown', s.span, s.ON);
      // 3 px past the slop of "Nom" (8..52): the click goes to the label, the element around both.
      const rel = ['pointerup', 'mouseup', 'click'].map((k) => fire(k, s.label, at(57, 113)));
      ok(rel.every((e) => e.prevented && e.stopped));
      eq(s.opened, ['field|f|1']);
      ok(fire('dblclick', s.label, { ...at(57, 113), detail: 2 }).prevented, 'its double-click too');
      fire('pointerdown', s.span, s.ON);
      const out = ['pointerup', 'click'].map((k) => fire(k, s.sec, at(300, 95)));
      ok(out.every((e) => e.prevented && e.stopped), 'dragged out of its zone: still not the page');
      eq(s.opened, ['field|f|1'], 'nothing opens');
      // A press beside the text released on it is the page's, as it started.
      fire('pointerdown', s.label, s.BESIDE);
      ok(!fire('click', s.label, s.ON).prevented);
      eq(s.opened, ['field|f|1']);
    } finally {
      s.ov.stop();
      s.undo();
    }
  });

  // ---- pills: "1 choice changed" after a choice field ----

  /**
   * "Format du document" showing "Courrier électronique" (the value control is the value's zone), in its field container.
   * The label's mark is 8..156 × 103..121, the value's 328..492 × 107..125; a full pill is 141 px wide (16 characters,
   * 8 px each, 6 px padding each side), its count alone 17 px.
   */
  function choiceField() {
    const body = dom.doc.children[0];
    const tl = text('Format du document', [[10, 104, 154, 120]]);
    const label = el('LABEL', [10, 100, 200, 124], {}, tl);
    const tv = text('Courrier électronique', [[330, 108, 490, 124]]);
    const span = el('SPAN', [330, 108, 490, 124], {}, tv);
    const ctl = el('DIV', [320, 100, 700, 132], {}, span);
    const field = el('DIV', [0, 90, 800, 140], {}, label, ctl);
    const input = el('INPUT', [0, 600, 100, 620]);
    body.append(field, input);
    const la = { el: label, hit: field, text: tl, comp: 'field|f|c1', kind: 'field', key: 'field|f|c1|Label', role: 'label' } as unknown as Anchor;
    const va = { el: span, zone: ctl, text: tv, comp: 'option|e.fmt|1', kind: 'option', key: 'option|e.fmt|1|Label', role: 'value', focus: 'option|e.fmt|1|Label' } as unknown as Anchor;
    const pill: Pill = { at: [va, la], field: field as unknown as Element, text: '1 choice changed', n: 1, title: '1 choice of this field changed, not published yet', tone: 'edited' };
    return { la, va, label, span, ctl, field, input, pill };
  }
  /** The pill elements (their own layer, after the marks'). */
  const pillEls = () => parts().wrap.children[1].children;
  /** The pill's tooltip (after the pill layer). */
  const tipEl = () => parts().wrap.children[2];
  /** A property the overlay sets that the fake element doesn't declare (textContent, title). */
  const prop = (e: FakeEl, k: string) => (e as unknown as Record<string, unknown>)[k];
  /** The pills shown: [transform, width, text]. */
  const shownPills = () => pillEls().filter((p) => !p.hidden).map((p) => [p.style.transform, p.style.width, prop(p, 'textContent')]);
  const resize = (w: number) => Object.defineProperty(globalThis, 'innerWidth', { value: w, configurable: true, writable: true });

  test('overlay dom: a pill just right of the value a choice field shows; a click on it opens that value; the pencil goes after it', async () => {
    const undo = install();
    try {
      const f = choiceField();
      let pills = [f.pill];
      const opened: string[] = [];
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok', pills: () => pills, open: (x) => opened.push(x.comp) });
      ov.start();
      ov.sync([f.la, f.va]);
      dom.raf!();
      // 4 px after the value's mark, centred on it, inside the control.
      eq(shownPills(), [['translate(496px,108px)', '141px', '1 choice changed']]);
      const pe = pillEls()[0];
      eq([pe.className, prop(pe, 'title'), pe.attrs['aria-label'], pe.style.height], ['pill is-edited', '1 choice of this field changed, not published yet', '1 choice of this field changed, not published yet', '16px']);
      eq(segments().length, 2, 'the label and the value keep their own marks');
      // It takes no events (the page under it keeps its hover and the wheel), like the whole layer.
      ok(!/pointer-events:\s*auto/.test(css) && /\.W\{[^}]*pointer-events:none/.test(css), 'no part of the layer takes the pointer');
      // A click where it is drawn (on the control under it) is a click on the value it follows.
      ok(clickOn(f.ctl, at(560, 115)).every((e) => e.prevented && e.stopped), 'taken over');
      eq(opened, ['option|e.fmt|1']);
      // Pointing at it hovers the value: the pointer, the strong look, the pencil after the pill, and its full text above it.
      fire('pointerover', f.ctl, at(560, 115));
      dom.raf!();
      eq((document.adoptedStyleSheets as unknown as Array<{ text: string }>)[0].text, CURSOR);
      eq(classes(), ['g is-ok', 'g is-ok is-hv']);
      eq(badges(), ['translate(639px,109px)'], 'right of the pill, never over it');
      const tw = `${f.pill.title.length * 8 + 17}px`;
      eq([tipEl().hidden, prop(tipEl(), 'textContent'), tipEl().style.transform, tipEl().style.width], [false, f.pill.title, 'translate(496px,84px)', tw]);
      // Off the pill, still on the control but beside the value's text: nothing is hovered, the tooltip goes.
      fire('pointermove', f.ctl, at(690, 115));
      dom.raf!();
      eq([classes(), badges(), tipEl().hidden], [['g is-ok', 'g is-ok'], [], true]);
      // On the value's text: the value.
      fire('pointermove', f.ctl, at(400, 115));
      dom.raf!();
      eq([classes()[1], tipEl().hidden], ['g is-ok is-hv', true]);
      // The count follows the store (read with the looks, at paint): two now, one of them failed to publish.
      pills = [{ ...f.pill, text: '2 choices not published', n: 2, title: "2 choices of this field changed, not published yet; 1 couldn't be published", tone: 'error' }];
      ov.paint();
      dom.raf!();
      eq(shownPills(), [['translate(496px,108px)', '197px', '2 choices not published']]);
      eq(pe.className, 'pill is-error', 'the same element, red');
      // Published or undone: gone.
      pills = [];
      ov.paint();
      dom.raf!();
      eq(pillEls().length, 0);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: without a value shown the pill follows the label; a click or a hover there is the label\'s, outside its zone too', async () => {
    const undo = install();
    try {
      const f = choiceField();
      const opened: string[] = [];
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok', pills: () => [f.pill], open: (x) => opened.push(x.comp) });
      ov.start();
      ov.sync([f.la, f.va]);
      f.ctl.vis = false; // the value control is not rendered
      dom.raf!();
      // Past the label element's right edge (200), before the control's place (320).
      eq(shownPills(), [['translate(160px,104px)', '141px', '1 choice changed']]);
      ok(clickOn(f.field, at(250, 112)).every((e) => e.prevented), 'taken over outside the label zone too');
      eq(opened, ['field|f|c1'], "the field label's popup");
      ok(clickOn(f.field, at(250, 135)).every((e) => !e.prevented), 'next to it: the page');
      // Moving onto it inside one page element (no pointerover): followed, the label is hovered.
      fire('pointerover', f.field, at(250, 135));
      fire('pointermove', f.field, at(250, 112));
      dom.raf!();
      eq([classes(), tipEl().hidden], [['g is-ok is-hv', 'g is-ok'], false]);
      fire('pointermove', f.field, at(250, 135));
      dom.raf!();
      eq([classes(), tipEl().hidden], [['g is-ok', 'g is-ok'], true]);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: where its text does not fit the pill shows its count; after the label it never covers the value control', async () => {
    const undo = install();
    try {
      const f = choiceField();
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok', pills: () => [f.pill] });
      ov.start();
      ov.sync([f.la, f.va]);
      // A window too narrow for the text after the value: its count, its text in the tooltip.
      resize(600);
      dom.raf!();
      eq(shownPills(), [['translate(496px,108px)', '17px', '1']]);
      eq([pillEls()[0].className, prop(pillEls()[0], 'title')], ['pill is-edited is-n', '1 choice of this field changed, not published yet']);
      fire('pointerover', f.ctl, at(500, 115));
      dom.raf!();
      eq([tipEl().hidden, prop(tipEl(), 'textContent')], [false, '1 choice of this field changed, not published yet']);
      // No room after the value at all: after the label, clear of the control.
      resize(505);
      ov.invalidate(1);
      dom.raf!();
      eq(shownPills(), [['translate(160px,104px)', '141px', '1 choice changed']]);
      // A control that starts close to the label: the text would cover it, its count fits.
      f.ctl.rect = [250, 100, 700, 132];
      ov.invalidate(1);
      dom.raf!();
      eq(shownPills(), [['translate(160px,104px)', '17px', '1']]);
      // No room anywhere: none (it never covers a text or a control).
      resize(170);
      ov.invalidate(1);
      dom.raf!();
      eq(shownPills(), []);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: an empty field (no value anchor): after its label the pill stays in the label\'s column, never over the control', async () => {
    const undo = install();
    try {
      // Label-left: the label column ends at 230, where the empty control ("---", no anchor) starts.
      const tl = text('Format du document', [[10, 104, 154, 120]]);
      const label = el('LABEL', [10, 100, 200, 124], {}, tl);
      const col = el('DIV', [0, 90, 230, 140], {}, label);
      const ctl = el('DIV', [230, 100, 700, 132], {}, el('SPAN', [240, 108, 264, 124], {}, text('---', [[240, 108, 264, 124]])));
      const field = el('DIV', [0, 90, 800, 140], {}, col, ctl);
      dom.doc.children[0].append(field);
      const la = { el: label, hit: field, text: tl, comp: 'field|f|c1', kind: 'field', key: 'field|f|c1|Label', role: 'label' } as unknown as Anchor;
      const pill: Pill = { at: [la], field: field as unknown as Element, text: '1 choice changed', n: 1, title: '1 choice of this field changed, not published yet', tone: 'edited' };
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok', pills: () => [pill] });
      ov.start();
      ov.sync([la]);
      dom.raf!();
      eq(shownPills(), [['translate(160px,104px)', '17px', '1']], 'its count: its text would run over "---"');
      // A wider label column: its text.
      col.rect = [0, 90, 320, 140];
      ov.invalidate(1);
      dom.raf!();
      eq(shownPills(), [['translate(160px,104px)', '141px', '1 choice changed']]);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: a pill stays inside its field and never covers another label\'s mark', async () => {
    const undo = install();
    try {
      const f = choiceField();
      // A two-column section: the field ends at 560, the next column's label starts at 570.
      f.field.rect = [0, 90, 560, 140];
      const nt = text('Statut', [[570, 104, 618, 120]]);
      const next = el('LABEL', [570, 100, 760, 124], {}, nt);
      dom.doc.children[0].append(el('DIV', [560, 90, 1000, 140], {}, next));
      const nb = { el: next, text: nt, comp: 'field|f|c2', kind: 'field', key: 'field|f|c2|Label', role: 'label' } as unknown as Anchor;
      const { Overlay } = await overlay();
      const opened: string[] = [];
      const ov = new Overlay({ ...plain, look: () => 'ok', pills: () => [f.pill], open: (x) => opened.push(x.comp) });
      ov.start();
      ov.sync([f.la, f.va, nb]);
      dom.raf!();
      eq(shownPills(), [['translate(496px,108px)', '17px', '1']], 'its count, never past the field onto the next column');
      clickOn(next, at(590, 112));
      eq(opened, ['field|f|c2'], 'the next label keeps its clicks');
      // Another label's text just after the value, inside the field: after the label instead.
      f.field.rect = [0, 90, 800, 140];
      nt.rects = [{ left: 500, top: 108, right: 548, bottom: 124 }];
      next.rect = [498, 104, 560, 128];
      ov.invalidate(1);
      dom.raf!();
      eq(shownPills(), [['translate(160px,104px)', '141px', '1 choice changed']]);
      // Its container shows nothing (display:contents): the window and the scroll containers alone bound it.
      f.field.rect = [0, 0, 0, 0];
      f.ctl.vis = false;
      ov.invalidate(1);
      dom.raf!();
      eq(shownPills(), [['translate(160px,104px)', '141px', '1 choice changed']]);
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: after the label of a required field the pill starts past its asterisk', async () => {
    const undo = install();
    try {
      const f = choiceField();
      f.label.append(el('SPAN', [158, 104, 166, 120], {}, text('*', [[158, 104, 166, 120]])));
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok', pills: () => [f.pill] });
      ov.start();
      ov.sync([f.la, f.va]);
      f.ctl.vis = false;
      dom.raf!();
      eq(shownPills(), [['translate(172px,104px)', '141px', '1 choice changed']], 'the asterisk (158..166) stays visible');
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: a multi-select\'s pill follows its last chip whole, never over the chip\'s ✕', async () => {
    const undo = install();
    try {
      const f = choiceField();
      // Edit mode (the pointer over the control): chips with a ✕ each, the text of the values hidden.
      const chip = (x: number, label: string, key: string) => {
        const t = text(label, [[x + 6, 108, x + 6 + label.length * 8, 124]]);
        const s = el('SPAN', [x + 6, 108, x + 6 + label.length * 8, 124], {}, t);
        const li = el('LI', [x, 104, x + 76, 128], {}, s, el('BUTTON', [x + 56, 106, x + 72, 126]));
        return { li, a: { el: s, zone: li, text: t, comp: key.slice(0, -6), kind: 'option', key, role: 'value', focus: key } as unknown as Anchor };
      };
      const c1 = chip(324, 'Rouge', 'option|e.m|1|Label');
      const c2 = chip(404, 'Bleu', 'option|e.m|2|Label');
      f.ctl.append(el('UL', [324, 104, 700, 128], {}, c1.li, c2.li));
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok', pills: () => [{ ...f.pill, at: [c2.a, c1.a, f.la] }] });
      ov.start();
      ov.sync([f.la, c1.a, c2.a]);
      dom.raf!();
      eq(shownPills(), [['translate(484px,108px)', '141px', '1 choice changed']], 'after the chip (404..480), not after its text (410..442)');
      ov.stop();
    } finally {
      undo();
    }
  });

  test('overlay dom: no pill while Alt is held (the page works as usual), none for a not-loaded label; stop removes it', async () => {
    const undo = install();
    try {
      const f = choiceField();
      const opened: string[] = [];
      const looks: Record<string, Look> = { 'field|f|c1': 'ok', 'option|e.fmt|1': 'ok' };
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: (a) => looks[a.comp], pills: () => [f.pill], open: (x) => opened.push(x.comp) });
      ov.start();
      ov.sync([f.la, f.va]);
      dom.raf!();
      const pe = pillEls()[0];
      fire('keydown', f.input, { key: 'Alt', altKey: true });
      dom.raf!();
      ok(pe.hidden, 'hidden while Alt is held');
      ok(clickOn(f.ctl, { ...at(560, 115), altKey: true }).every((e) => !e.prevented && !e.stopped), 'Alt+click is never taken');
      fire('keyup', f.input, { key: 'Alt' });
      dom.raf!();
      ok(!pe.hidden, 'back after Alt');
      // A read-only label (grey) keeps its pill: its choices can still be translated.
      looks['field|f|c1'] = 'ro';
      ov.paint();
      dom.raf!();
      eq([classes()[0], shownPills().length], ['g is-ro', 1]);
      looks['option|e.fmt|1'] = 'na';
      ov.paint();
      dom.raf!();
      eq(shownPills().map((p) => p[0]), ['translate(160px,104px)'], 'its value not loaded: after the label');
      // A not-loaded value and label (no mark, clicks reach the page): nothing to follow.
      looks['field|f|c1'] = looks['option|e.fmt|1'] = 'na';
      ov.paint();
      dom.raf!();
      eq(shownPills(), []);
      ok(clickOn(f.ctl, at(560, 115)).every((e) => !e.prevented), 'where it was: the page');
      eq(opened, []);
      const layer = parts().wrap.children[1];
      const tip = tipEl();
      ov.stop();
      eq([layer.children.length, tip.hidden], [0, true], 'removed');
    } finally {
      undo();
    }
  });

  test('overlay dom: a dropdown list over the place after the value: the pill follows the label instead, never inside the list', async () => {
    const undo = install();
    try {
      const f = choiceField();
      const body = dom.doc.children[0];
      const option = el('DIV', [450, 140, 700, 170], {}, text('Papier', [[460, 146, 510, 162]]));
      const listbox = el('DIV', [450, 100, 700, 300], {}, option);
      listbox.attrs.role = 'listbox';
      body.append(listbox);
      dom.layers = [listbox];
      dom.hit = option;
      const { Overlay } = await overlay();
      const ov = new Overlay({ ...plain, look: () => 'ok', pills: () => [f.pill] });
      ov.start();
      ov.sync([f.la, f.va]);
      dom.raf!();
      eq(shownPills(), [['translate(160px,104px)', '141px', '1 choice changed']]);
      eq(clips(), ['', 'path("M-4 -4h126v26h-126z")'], 'the value under the list is cut at its edge, the label is not');
      ov.stop();
    } finally {
      undo();
    }
  });
}
