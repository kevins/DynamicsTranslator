// Unit tests for undo and redo in the translator (ui/undo.ts): each text box's own history (typing runs, script
// changes, IME, the context menu, re-rendered boxes, the grid's cell editor), the keys, and Ctrl+Z / Ctrl+Y outside text
// boxes: the staged edits in the translator and, in translation mode, on the page unless the focus is in a control that
// keeps the keys (ownsKeys). The DOM parts run against the popup tests' fake DOM.
import { Store } from '../../../src/core/store';
import { bindUndo, insertText, kindOf, ownsKeys, resetUndo, TextUndo, undoKey, whenEmpty, type TextState, type UndoHost } from '../../../src/ui/undo';
import { dom, FEl, fire, install, typeIn, type Ev } from './callout';
import type { Kit } from './kit';

const FR = 1036;
const at = (v: string, s = v.length, e = s): TextState => ({ v, s, e });

export function register(t: Kit): void {
  const { test, eq, ok } = t;

  // ---- one box's history ----
  test('undo: a typing run is one step; Ctrl+Z brings back the text and the caret where it began', () => {
    const u = new TextUndo();
    u.record(at(''), at('a'), 'type');
    u.record(at('a'), at('ab'), 'type');
    eq(u.undo(at('ab')), at(''));
    eq(u.undo(at('')), null, 'nothing left');
    eq(u.redo(at('')), at('ab'));
    eq(u.redo(at('ab')), null);
  });
  test('undo: a moved caret, another kind of edit, a paste or typing over a selection starts a new step', () => {
    /** How many Ctrl+Z the recorded edits take, from the last text. */
    const steps = (last: string, ...edits: Array<[TextState, TextState, 'type' | 'delete' | 'other']>) => {
      const u = new TextUndo();
      for (const [b, a, k] of edits) u.record(b, a, k);
      let n = 0;
      for (let now = u.undo(at(last)); now; now = u.undo(now)) n++;
      return n;
    };
    eq(steps('axbc', [at('ab'), at('abc'), 'type'], [at('abc', 1), at('axbc', 2), 'type']), 2, 'caret moved');
    eq(steps('ab', [at('ab'), at('abc'), 'type'], [at('abc'), at('ab'), 'delete']), 2, 'typing then deleting');
    eq(steps('abcXY', [at('ab'), at('abc'), 'type'], [at('abc'), at('abcXY'), 'other']), 2, 'a paste');
    eq(steps('abXY', [at('ab'), at('abX'), 'other'], [at('abX'), at('abXY'), 'other']), 2, 'two pastes');
    eq(steps('x', [at('ab'), at('abc'), 'type'], [at('abc', 0, 3), at('x'), 'type']), 2, 'typing over a selection');
    eq(steps('a', [at('abc'), at('ab'), 'delete'], [at('ab'), at('a'), 'delete']), 1, 'a run of Backspace is one step');
  });
  test('undo: a change made by a script since is undone first', () => {
    const u = new TextUndo();
    u.record(at(''), at('abc'), 'type');
    // "Undo changes" (or a reload) set the text back to '' meanwhile.
    eq(u.undo(at('')), at('abc'));
    eq(u.undo(at('abc')), at(''));
    eq(u.redo(at('')), at('abc'));
    eq(u.redo(at('abc')), at(''));
  });
  test('undo: a new edit clears redo; redo stops when the text changed since the undo', () => {
    const u = new TextUndo();
    u.record(at(''), at('a'), 'type');
    eq(u.undo(at('a')), at(''));
    u.record(at(''), at('b'), 'type');
    eq(u.redo(at('b')), null, 'a new edit');
    eq(u.undo(at('b')), at(''));
    eq(u.redo(at('changed')), null, 'the text changed since the undo');
    eq(u.redo(at('')), null, 'and the redo is gone');
  });
  test('undo: at most 100 steps are kept', () => {
    const u = new TextUndo();
    for (let i = 0; i < 120; i++) u.record(at(String(i)), at(String(i + 1)), 'other');
    let n = 0;
    let last: TextState | null = at('120');
    for (let now = u.undo(last); now; now = u.undo(now)) (n++, (last = now));
    eq([n, last?.v], [100, '20']);
  });
  test('undo: empty() is true only before anything was recorded', () => {
    const u = new TextUndo();
    ok(u.empty());
    u.record(at('a'), at('a'), 'type');
    ok(u.empty(), 'no text change, no step');
    u.record(at(''), at('a'), 'type');
    ok(!u.empty());
    u.undo(at('a'));
    ok(!u.empty(), 'undone: still a history (redo)');
  });
  test('undo: kindOf', () => {
    eq(['insertText', 'insertCompositionText', 'insertLineBreak'].map(kindOf), ['type', 'type', 'type']);
    eq(['deleteContentBackward', 'deleteWordBackward'].map(kindOf), ['delete', 'delete']);
    eq(['insertFromPaste', 'deleteByCut', 'insertReplacementText', ''].map(kindOf), ['other', 'other', 'other', 'other']);
  });
  test('undo: keys', () => {
    const k = (o: Partial<Parameters<typeof undoKey>[0]>) => undoKey({ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...o });
    eq([k({ key: 'z', ctrlKey: true }), k({ key: 'Z', ctrlKey: true, shiftKey: true }), k({ key: 'y', ctrlKey: true }), k({ key: 'y', ctrlKey: true, shiftKey: true }), k({ key: 'z', metaKey: true })], ['undo', 'redo', 'redo', '', 'undo']);
    eq([k({ key: 'z', ctrlKey: true, altKey: true }), k({ key: 'z' }), k({ key: 'z', ctrlKey: true, isComposing: true }), k({ key: 's', ctrlKey: true })], ['', '', '', ''], 'AltGr, no Ctrl, composing, another letter');
    eq(k({ key: 'я', code: 'KeyZ', ctrlKey: true }), 'undo', 'a keyboard without Latin letters: the Z key');
    eq(k({ key: 'w', code: 'KeyZ', ctrlKey: true }), '', 'AZERTY: Ctrl+W is not undo');
    eq(k({ key: 'z', code: 'KeyW', ctrlKey: true }), 'undo', 'AZERTY: the key labelled Z');
    // Only a letter of a script without Latin letters goes by its place: another key there is not undo or redo.
    eq(k({ key: 'à', code: 'KeyZ', ctrlKey: true }), '', 'BÉPO: Ctrl+à');
    eq(k({ key: 'Dead', code: 'KeyY', ctrlKey: true }), '', 'BÉPO: the dead key ^');
    eq(k({ key: ';', code: 'KeyZ', ctrlKey: true }), '', 'Dvorak: Ctrl+;');
    eq(k({ key: 'ζ', code: 'KeyZ', ctrlKey: true }), 'undo', 'Greek');
  });

  // ---- in the app layer (fake DOM) ----
  const A = 'attribute|x|Label';
  type Host = UndoHost & { dlg: boolean; on: boolean };
  type Doc = { activeElement: unknown; body: FEl; documentElement: FEl };
  /** The fake DOM, a store with one staged edit, and bindUndo on the layer (`box` adds an element to it); cleaned up after. */
  const withUndo =
    (fn: (o: { store: Store; host: Host; win: FEl; doc: Doc; off: () => void; box: (tag?: string, o?: Partial<FEl>) => FEl }) => unknown) =>
    async () => {
      const remove = install();
      try {
        const store = new Store();
        store.add([t.slot('attribute', A)]);
        store.set(A, FR, 'Nom 2');
        const host: Host = { store, dlg: false, on: true, dialog: () => host.dlg, page: () => host.on };
        const body = new FEl('BODY');
        const doc: Doc = { activeElement: body, body, documentElement: new FEl('HTML') };
        const win = new FEl('#WINDOW');
        const off = bindUndo(dom.layer as never, host, { win: win as never, doc: doc as never });
        const box = (tag = 'INPUT', o: Partial<FEl> = {}) => {
          const b = Object.assign(new FEl(tag), o);
          dom.layer.appendChild(b);
          return b;
        };
        await fn({ store, host, win, doc, off, box });
        off();
      } finally {
        remove();
      }
    };
  const ctrl = (key: string, o: Partial<Ev> = {}): Partial<Ev> => ({ key, ctrlKey: true, ...o });
  /** The inputType of every input event `i` gets from now on (what its listeners are told). */
  const inputs = (i: FEl) => {
    const seen: string[] = [];
    i.addEventListener('input', (e) => seen.push(e.inputType || ''));
    return seen;
  };

  test(
    "undo: Ctrl+Z in a text box undoes its typing, never the browser's, and tells its listeners",
    withUndo(({ store, box }) => {
      const i = box();
      i.focus();
      typeIn(i, 'abc');
      const seen = inputs(i);
      const z = fire(i, 'keydown', ctrl('z'));
      ok(z.defaultPrevented, "the browser's undo is cancelled");
      eq([i.value, i.selectionStart, i.selectionEnd], ['', 0, 0]);
      const y = fire(i, 'keydown', ctrl('y'));
      ok(y.defaultPrevented);
      eq([i.value, i.selectionStart, i.selectionEnd], ['abc', 3, 3]);
      fire(i, 'keydown', ctrl('z'));
      fire(i, 'keydown', ctrl('Z', { shiftKey: true }));
      eq(i.value, 'abc', 'Ctrl+Shift+Z redoes too');
      eq(seen, ['historyUndo', 'historyRedo', 'historyUndo', 'historyRedo']);
      eq(store.value(A, FR), 'Nom 2', 'the staged edits are not touched from a text box');
    }),
  );
  test(
    "undo: with nothing to undo Ctrl+Z is still kept from the browser, and the box's whenEmpty runs",
    withUndo(({ store, box }) => {
      const i = box('TEXTAREA', { value: 'Nom' });
      i.focus();
      const calls: string[] = [];
      whenEmpty(i as never, (u) => void calls.push(u));
      ok(fire(i, 'keydown', ctrl('z')).defaultPrevented);
      ok(fire(i, 'keydown', ctrl('y')).defaultPrevented);
      eq([i.value, calls, store.value(A, FR)], ['Nom', ['undo', 'redo'], 'Nom 2'], 'nothing else changes');
      i.selectionStart = i.selectionEnd = 3;
      typeIn(i, 'x');
      fire(i, 'keydown', ctrl('z'));
      fire(i, 'keydown', ctrl('z'));
      eq([i.value, calls.length], ['Nom', 2], 'something was typed in it: Ctrl+Z stays in the box');
    }),
  );
  test(
    'undo: a whenEmpty text: Ctrl+Z in a box with nothing typed shows it as one step, Ctrl+Y brings the text back',
    withUndo(({ box }) => {
      const i = box('INPUT', { value: 'Nom 2', selectionStart: 5, selectionEnd: 5 });
      i.focus();
      const seen = inputs(i);
      const asked: string[] = [];
      whenEmpty(i as never, (u) => (asked.push(u), u === 'undo' ? 'Nom' : undefined));
      ok(fire(i, 'keydown', ctrl('y')).defaultPrevented);
      eq([i.value, asked], ['Nom 2', ['redo']], 'nothing to redo');
      ok(fire(i, 'keydown', ctrl('z')).defaultPrevented);
      eq([i.value, i.selectionStart, i.selectionEnd], ['Nom', 0, 3], 'the text it replaces, selected');
      fire(i, 'keydown', ctrl('z'));
      eq([i.value, asked], ['Nom', ['redo', 'undo']], 'asked once: the history has that step now');
      fire(i, 'keydown', ctrl('y'));
      eq([i.value, i.selectionStart], ['Nom 2', 5]);
      eq(seen, ['historyUndo', 'historyRedo'], 'its listeners are told (the popup stages it)');
      const j = box('INPUT', { value: 'Nom' });
      j.focus();
      whenEmpty(j as never, () => 'Nom');
      fire(j, 'keydown', ctrl('z'));
      eq(j.value, 'Nom', 'the same text: no step');
    }),
  );
  test(
    "undo: the context menu's Undo reaching another box (the page's last step is there) undoes the focused box",
    withUndo(({ box }) => {
      const b = box();
      b.focus();
      typeIn(b, 'bb');
      const a = box();
      a.focus();
      typeIn(a, 'aa');
      ok(fire(b, 'beforeinput', { inputType: 'historyUndo' }).defaultPrevented);
      eq([a.value, b.value], ['', 'bb']);
      ok(fire(b, 'beforeinput', { inputType: 'historyRedo' }).defaultPrevented);
      eq([a.value, b.value], ['aa', 'bb']);
    }),
  );
  test(
    "undo: the context menu's Undo (beforeinput historyUndo) runs ours; one reaching a box while none of ours has the focus changes nothing",
    withUndo(({ box }) => {
      const other = box();
      other.focus();
      typeIn(other, 'zz');
      const i = box();
      i.focus();
      typeIn(i, 'ab');
      ok(fire(i, 'beforeinput', { inputType: 'historyUndo' }).defaultPrevented);
      eq(i.value, '');
      ok(fire(i, 'beforeinput', { inputType: 'historyRedo' }).defaultPrevented);
      eq(i.value, 'ab');
      // Ctrl+Z in a Dynamics field reaching our box through the page's undo stack: the focus is outside our root.
      dom.root.activeElement = null;
      ok(fire(other, 'beforeinput', { inputType: 'historyUndo' }).defaultPrevented);
      eq([other.value, i.value], ['zz', 'ab']);
    }),
  );
  test(
    'undo: an IME composition is one step',
    withUndo(({ box }) => {
      const i = box();
      i.focus();
      fire(i, 'compositionstart');
      for (const v of ['に', '日本']) {
        fire(i, 'beforeinput', { inputType: 'insertCompositionText', isComposing: true });
        i.value = v;
        i.selectionStart = i.selectionEnd = v.length;
        fire(i, 'input', { inputType: 'insertCompositionText', isComposing: true });
      }
      fire(i, 'compositionend');
      fire(i, 'keydown', ctrl('z'));
      eq(i.value, '', 'not the half-composed text');
      fire(i, 'keydown', ctrl('y'));
      eq(i.value, '日本');
    }),
  );
  test(
    'undo: insertText and resetUndo are steps (the cell editor: typing into a cell, Alt+Enter, a cleaned paste)',
    withUndo(({ box }) => {
      const i = box('TEXTAREA', { value: 'x', selectionStart: 1, selectionEnd: 1 });
      i.focus();
      const seen = inputs(i);
      resetUndo(i as never, 'Old');
      fire(i, 'keydown', ctrl('z'));
      eq([i.value, i.selectionStart, i.selectionEnd], ['Old', 0, 3], 'the replaced text comes back, selected');
      fire(i, 'keydown', ctrl('y'));
      eq(i.value, 'x');
      resetUndo(i as never, 'Old');
      i.selectionStart = i.selectionEnd = 1;
      typeIn(i, 'y');
      insertText(i as never, '\n', 'insertLineBreak');
      insertText(i as never, 'Z');
      eq([i.value, i.selectionStart], ['xy\nZ', 4]);
      eq(seen.slice(-2), ['insertLineBreak', 'insertFromPaste'], 'its listeners are told (the grid grows, the Workbench knows it is typing)');
      fire(i, 'keydown', ctrl('z'));
      eq(i.value, 'xy\n', 'the paste is its own step');
      fire(i, 'keydown', ctrl('z'));
      eq(i.value, 'Old', 'Alt+Enter joined the typing');
      resetUndo(i as never);
      fire(i, 'keydown', ctrl('z'));
      eq(i.value, 'Old', 'another cell: a new, empty history');
    }),
  );
  test(
    'undo: a box that a re-render replaces keeps its history inside a data-us scope, not outside one',
    withUndo(({ box }) => {
      /** The same cell's input, rendered again (the popup's and the editor card's inputs carry data-k). */
      const cellInput = (value = '') => {
        const b = new FEl('INPUT');
        b.setAttribute('data-k', 'k#1036');
        return Object.assign(b, { value, selectionStart: value.length, selectionEnd: value.length });
      };
      const scope = box('DIV');
      scope.setAttribute('data-us', '');
      const a = cellInput();
      scope.appendChild(a);
      a.focus();
      typeIn(a, 'ab');
      const b = cellInput('ab');
      a.replaceWith(b);
      b.focus();
      fire(b, 'keydown', ctrl('z'));
      eq(b.value, '', 'inside the scope');
      const c = cellInput();
      dom.layer.appendChild(c);
      c.focus();
      typeIn(c, 'cd');
      const d = cellInput('cd');
      c.replaceWith(d);
      d.focus();
      fire(d, 'keydown', ctrl('z'));
      eq(d.value, 'cd', 'outside a scope a new box starts empty');
    }),
  );
  test(
    'undo: read-only and disabled boxes and selects are left alone; the browser undo never runs there either',
    withUndo(({ store, box }) => {
      for (const b of [box('INPUT', { value: 'r', readOnly: true }), box('TEXTAREA', { value: 'r', disabled: true }), box('SELECT', { value: 'r' })]) {
        b.focus();
        ok(fire(b, 'keydown', ctrl('z')).defaultPrevented, b.tagName);
        fire(b, 'beforeinput', { inputType: 'historyUndo' });
        eq([b.value, store.value(A, FR)], ['r', 'Nom 2'], b.tagName);
      }
    }),
  );

  // ---- outside text boxes: the staged edits ----
  test(
    'undo: outside text boxes Ctrl+Z / Ctrl+Y undo and redo the staged edits (the popup\'s buttons, the bar, the list, a checkbox)',
    withUndo(({ store, host, box }) => {
      const events: string[] = [];
      store.on((e) => events.push(e.type === 'edit' ? `${e.key}#${e.lcid}` : e.type));
      for (const b of [box('BUTTON'), box('INPUT', { type: 'checkbox' }), box('DIV')]) {
        b.focus();
        const z = fire(b, 'keydown', ctrl('z'));
        ok(z.defaultPrevented, "never the browser's undo");
        eq([store.isEdited(A, FR), store.value(A, FR)], [false, 'Nom'], b.tagName + ' undo');
        fire(b, 'keydown', ctrl('y'));
        eq(store.value(A, FR), 'Nom 2', b.tagName + ' redo');
        fire(b, 'keydown', ctrl('z'));
        fire(b, 'keydown', ctrl('z', { shiftKey: true }));
        eq(store.value(A, FR), 'Nom 2', b.tagName + ' Ctrl+Shift+Z');
      }
      ok(events.length > 0 && events.every((e) => e === `${A}#${FR}`), 'one edit event per step, which the popup, the marks and the bar follow');
      const b = box('BUTTON');
      host.dlg = true;
      ok(fire(b, 'keydown', ctrl('z')).defaultPrevented, 'in a dialog: cancelled');
      eq(store.value(A, FR), 'Nom 2', 'in a dialog: nothing happens');
      host.dlg = false;
      store.setBusy(true);
      fire(b, 'keydown', ctrl('z'));
      eq(store.value(A, FR), 'Nom 2', 'not while a save runs');
      store.setBusy(false);
      ok(!fire(b, 'keydown', ctrl('s')).defaultPrevented, 'other keys pass');
    }),
  );
  test(
    'undo: on the page, Ctrl+Z / Ctrl+Y undo the staged edits with the focus on the page itself; never in the Workbench, a dialog or a save, nor with nothing to undo',
    withUndo(async ({ store, host, win, doc, off }) => {
      const { slotLook } = await import('../../../src/inspector/mode');
      const app = { store, ctx: { base: 1033, user: 1033, langs: [{ lcid: 1033, name: 'English', isBase: true }, { lcid: FR, name: 'French', isBase: false }] }, prefs: { target: FR } } as never;
      const look = () => slotLook(app, store.get(A)!);
      eq(look(), 'edited');
      // After a popup closed the focus is on the body.
      const z = fire(win, 'keydown', ctrl('z'));
      ok(z.defaultPrevented, "the browser's undo would revert a Dynamics field");
      eq([store.isEdited(A, FR), look()], [false, 'ok'], 'undone: the mark is no longer green');
      ok(fire(win, 'keydown', ctrl('y')).defaultPrevented);
      eq([store.value(A, FR), look()], ['Nom 2', 'edited']);
      for (const a of [doc.documentElement, null]) {
        doc.activeElement = a;
        fire(win, 'keydown', ctrl('z'));
        fire(win, 'keydown', ctrl('z', { shiftKey: true }));
        eq(store.value(A, FR), 'Nom 2', `focus ${a ? 'html' : 'none'}: undone and redone`);
      }
      // A Dynamics field keeps its own undo (every kind of focus: the tests below).
      doc.activeElement = new FEl('INPUT');
      ok(!fire(win, 'keydown', ctrl('z')).defaultPrevented, 'a field');
      eq(store.value(A, FR), 'Nom 2', 'a field');
      doc.activeElement = doc.body;
      const pass = (why: string) => {
        ok(!fire(win, 'keydown', ctrl('z')).defaultPrevented, why);
        eq(store.value(A, FR), 'Nom 2', why);
      };
      host.on = false;
      pass('the Workbench is open');
      host.on = true;
      host.dlg = true;
      pass('a dialog is open');
      host.dlg = false;
      store.setBusy(true);
      pass('a save runs');
      store.setBusy(false);
      ok(fire(win, 'keydown', { ...ctrl('z'), defaultPrevented: true }).defaultPrevented && store.value(A, FR) === 'Nom 2', 'taken by the page already');
      fire(win, 'keydown', ctrl('z'));
      eq(store.value(A, FR), 'Nom', 'undone');
      ok(!fire(win, 'keydown', ctrl('z')).defaultPrevented, 'nothing left to undo: the page keeps the key');
      ok(fire(win, 'keydown', ctrl('y')).defaultPrevented);
      off();
      ok(!fire(win, 'keydown', ctrl('z')).defaultPrevented && store.value(A, FR) === 'Nom 2', 'gone with the app');
    }),
  );

  // ---- which focus keeps Ctrl+Z / Ctrl+Y for itself (ownsKeys) ----
  /** An element with the attributes `attrs` and the properties `props` (an input's type, isContentEditable). */
  const el = (tag: string, attrs: Record<string, string> = {}, props: object = {}): FEl => {
    const x = Object.assign(new FEl(tag), props);
    for (const [k, v] of Object.entries(attrs)) x.setAttribute(k, v);
    return x;
  };
  const input = (type: string, props: object = {}) => el('INPUT', {}, { type, ...props });
  /** `parent` with `kids` appended. */
  const inside = (parent: FEl, ...kids: FEl[]): FEl => {
    for (const k of kids) parent.appendChild(k);
    return parent;
  };
  /** `host` with an open shadow root holding `kids`. As in a browser its top children have no parent element: the way up is the host. */
  const shadow = (host: FEl, ...kids: FEl[]): FEl => {
    const sr = new FEl('#SHADOW');
    sr.connected = true; // focus() inside it sets its activeElement
    sr.host = host;
    (host as unknown as { shadowRoot: FEl }).shadowRoot = sr;
    for (const k of kids) {
      sr.appendChild(k);
      Object.defineProperty(k, 'parentElement', { value: null });
    }
    return host;
  };
  type Case = [name: string, focus: FEl];
  /** The cases whose ownsKeys() is not `want`. */
  const wrong = (want: boolean, cases: Case[]) => cases.filter(([, x]) => ownsKeys(x as never) !== want).map(([n]) => n);
  const flyoutClose = () => el('BUTTON', { id: 'MscrmControls.Containers.ProcessStageControl-stageContentClose' });

  test('undo: ownsKeys: a control that takes typing or a value keeps the keys', () => {
    const typed = ['', 'text', 'search', 'email', 'url', 'tel', 'number', 'password', 'date', 'time', 'datetime-local', 'month', 'week'];
    eq(
      wrong(true, [
        ...typed.map((ty): Case => [`input type=${ty || '(none)'}`, input(ty)]),
        ['a read-only input', input('text', { readOnly: true })],
        ['textarea', el('TEXTAREA')],
        ['select', el('SELECT')],
        ['contenteditable', el('DIV', { contenteditable: '' }, { isContentEditable: true })],
        ['contenteditable=plaintext-only', el('DIV', { contenteditable: 'plaintext-only' }, { isContentEditable: true })],
        ['an element inside editable content', el('SPAN', {}, { isContentEditable: true })],
        ...['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider'].map((r): Case => [`role=${r}`, el('DIV', { role: r })]),
        ['a dropdown: a button with role=combobox', el('BUTTON', { role: 'combobox' })],
        ['role=TextBox', el('DIV', { role: 'TextBox' })],
        ['role=" combobox listbox": its first token', el('DIV', { role: ' combobox listbox' })],
      ]),
      [],
    );
  });
  test('undo: ownsKeys: a button, a link, a tab, a menu item, a checkbox, a range or a plain element has no undo of its own', () => {
    const untyped = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'];
    const roles = ['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'listbox', 'checkbox', 'switch', 'radio', 'treeitem', 'row', 'grid', 'gridcell', 'dialog'];
    const lookupSearch = el('BUTTON');
    inside(el('DIV'), input('text'), lookupSearch);
    eq(
      wrong(false, [
        ...untyped.map((ty): Case => [`input type=${ty}`, input(ty)]),
        ["the BPF stage flyout's close button", flyoutClose()],
        ['a link', el('A', { href: '#' })],
        ['a tab', el('LI', { role: 'tab' })],
        ...roles.map((r): Case => [`role=${r}`, el('DIV', { role: r })]),
        ['role="button textbox": its first token', el('DIV', { role: 'button textbox' })],
        ['contenteditable=false', el('DIV', { contenteditable: 'false' }, { isContentEditable: false })],
        ...['DIV', 'SPAN', 'LABEL', 'H1', 'BODY', 'HTML', 'svg'].map((tag): Case => [tag, el(tag)]),
        ["a form lookup's search button, next to its input", lookupSearch],
      ]),
      [],
    );
  });
  test("undo: ownsKeys: anything in a grid cell whose editor is open keeps the keys; a cell without one doesn't", () => {
    const cell = (...kids: FEl[]) => inside(el('DIV', { role: 'gridcell' }), ...kids);
    const search = el('BUTTON');
    const deep = el('SPAN');
    const lookup = cell(inside(el('DIV'), input('text'), inside(el('DIV'), search, deep)));
    const inShadow = el('BUTTON');
    cell(input('text'), shadow(el('X-LOOKUP'), inShadow));
    const editors: Case[] = [
      ['a number input', input('number')],
      ['a date input', input('date')],
      ['a textarea', el('TEXTAREA')],
      ['a select', el('SELECT')],
      ['a combobox', el('DIV', { role: 'combobox' })],
      ['editable content', el('DIV', { contenteditable: '' }, { isContentEditable: true })],
    ];
    eq(
      wrong(true, [
        ["a lookup cell's editor: the cell", lookup],
        ['its search button', search],
        ['an element deep inside it', deep],
        ['a button in a shadow root in the cell', inShadow],
        ...editors.map(([n, ed]): Case => [`a cell holding ${n}`, cell(ed)]),
        ['role=GridCell', inside(el('DIV', { role: 'GridCell' }), input('text'))],
      ]),
      [],
    );
    const rowButton = el('BUTTON');
    const nextCell = el('BUTTON');
    inside(el('DIV', { role: 'row' }), cell(input('text')), rowButton, cell(nextCell));
    eq(
      wrong(false, [
        ['an empty cell', cell()],
        ["a cell holding the row's checkbox", cell(input('checkbox'))],
        ["a cell holding the record's link", cell(el('A'))],
        ['a cell holding a hidden input', cell(input('hidden'))],
        ['a cell holding content made not editable', cell(el('DIV', { contenteditable: 'false' }, { isContentEditable: false }))],
        ['a cell holding a button', cell(el('DIV', { role: 'button' }))],
        ['a button of the row, outside the cell with the editor', rowButton],
        ['a button in the next cell', nextCell],
      ]),
      [],
    );
  });
  test(
    "undo: on the page, Ctrl+Z / Ctrl+Y undo the staged edits wherever the focus is but in a control that keeps them (after Done: the BPF flyout's close button)",
    withUndo(({ store, doc, win }) => {
      const B = 'attribute|y|Label';
      store.add([t.slot('attribute', B)]);
      store.set(B, FR, 'Prénom');
      store.undo();
      /** Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z with the focus on `x` are taken: the staged edits are undone and redone. */
      const taken = (n: string, x: FEl | null) => {
        doc.activeElement = x;
        ok(fire(win, 'keydown', ctrl('z')).defaultPrevented, n);
        eq([store.value(A, FR), store.value(B, FR)], ['Nom', 'Nom'], n + ': undone');
        ok(fire(win, 'keydown', ctrl('y')).defaultPrevented, n);
        ok(fire(win, 'keydown', ctrl('Z', { shiftKey: true })).defaultPrevented, n);
        eq([store.value(A, FR), store.value(B, FR)], ['Nom 2', 'Prénom'], n + ': redone');
        store.undo();
      };
      /** With the focus on `x` the keys are left to the page: nothing is cancelled, nothing undone or redone. */
      const left = (n: string, x: FEl | null) => {
        doc.activeElement = x;
        for (const [k, o] of [['Ctrl+Z', ctrl('z')], ['Ctrl+Y', ctrl('y')], ['Ctrl+Shift+Z', ctrl('Z', { shiftKey: true })]] as const)
          ok(!fire(win, 'keydown', o).defaultPrevented, `${n}: ${k}`);
        eq([store.value(A, FR), store.value(B, FR)], ['Nom 2', 'Nom'], n);
      };
      taken("the BPF stage flyout's close button", flyoutClose());
      taken('a link', el('A'));
      taken('a tab', el('LI', { role: 'tab' }));
      taken('a menu item', el('DIV', { role: 'menuitem' }));
      taken('a plain element', el('DIV'));
      taken('a checkbox', input('checkbox'));
      taken('a range', input('range'));
      taken('a grid cell without an editor', el('DIV', { role: 'gridcell' }));
      taken('the body', doc.body);
      taken('nothing', null);
      left('a text field', input('text'));
      left('a number field', input('number'));
      left('a date field', input('date'));
      left('a textarea', el('TEXTAREA'));
      left('a select', el('SELECT'));
      left('editable content', el('DIV', { contenteditable: 'true' }, { isContentEditable: true }));
      left('a combobox', el('DIV', { role: 'combobox' }));
      left('a spin button', el('DIV', { role: 'spinbutton' }));
      left('a slider', el('DIV', { role: 'slider' }));
      const search = el('BUTTON');
      inside(el('DIV', { role: 'gridcell' }), input('text'), search);
      left("the search button of a grid cell's lookup editor", search);

      // Through open shadow roots, to the element focused inside them.
      const fi = input('text');
      const field = shadow(el('X-FIELD'), fi);
      fi.focus();
      left('an input in a shadow root', field);
      const deep = input('text');
      const inner = shadow(el('X-INNER'), deep);
      const outer = shadow(el('X-OUTER'), inner);
      inner.focus();
      deep.focus();
      left('an input two shadow roots down', outer);
      const sb = el('BUTTON');
      const host = shadow(el('X-BUTTON'), sb);
      sb.focus();
      taken('a button in a shadow root', host);
      taken('a host with nothing focused in its shadow root', shadow(el('X-PANEL'), el('BUTTON')));
      left('a closed shadow root: its host as it presents itself', el('X-EDITOR', { role: 'textbox' }));
    }),
  );
  test(
    'undo: in the translator, a control that keeps the keys (a combobox, editable content) gets nothing; the browser undo never runs there',
    withUndo(({ store, box }) => {
      const combo = box('DIV');
      combo.setAttribute('role', 'combobox');
      const editable = Object.assign(box('DIV'), { isContentEditable: true });
      for (const [n, b] of [['a combobox', combo], ['editable content', editable]] as const) {
        b.focus();
        ok(fire(b, 'keydown', ctrl('z')).defaultPrevented, n);
        eq(store.value(A, FR), 'Nom 2', n + ': not undone');
        store.undo();
        ok(fire(b, 'keydown', ctrl('y')).defaultPrevented, n);
        eq(store.value(A, FR), 'Nom', n + ': not redone');
        store.redo();
      }
    }),
  );
}
