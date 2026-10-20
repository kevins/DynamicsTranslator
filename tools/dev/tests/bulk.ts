// Unit tests for the Workbench's bulk tools (src/workbench/tools.ts) on the tiny DOM of callout.ts: the cells a
// tool changes are the ones its preview showed. register() is called by tools/dev/unit.ts.
import { resolveObjectURL } from 'node:buffer';
import { Worker as Thread } from 'node:worker_threads';
import { Store } from '../../../src/core/store';
import type { Slot } from '../../../src/core/model';
import type { AppApi } from '../../../src/ui/types';
import { FIND_LIMIT, heavyRegex } from '../../../src/workbench/regex';
import { FIND_BUDGET, openTool, riskyRegex, SEARCHING_AFTER, type ToolId } from '../../../src/workbench/tools';
import { dom, FEl, fire, install } from './callout';
import type { Kit } from './kit';

const FR = 1036;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Waits until `c()` is true; fails after `ms`. */
const until = async (c: () => boolean, ms = 3000) => {
  const end = performance.now() + ms;
  while (!c()) {
    if (performance.now() > end) throw new Error('timed out waiting');
    await wait(10);
  }
};

/** What the worker's code needs from a Web Worker's global scope, on a Node.js thread. */
const PRELUDE =
  "const { parentPort } = require('node:worker_threads'); globalThis.self = globalThis; self.postMessage = (d) => parentPort.postMessage(d); parentPort.on('message', (data) => self.onmessage && self.onmessage({ data }));\n";

/**
 * Installs a Web Worker (Node.js has none) that runs a blob: address on a thread, as the page's would; counts the
 * workers started and stopped, and the searches sent (`lag` holds each one back that long). 'throw': the constructor throws, as under a policy without blob: in worker-src;
 * 'error': the worker fails to load (an error event before it runs).
 */
const workers = (fail?: 'throw' | 'error') => {
  const was = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const seen = { started: 0, stopped: 0, searches: 0 };
  /** How long each search waits before it reaches its worker: a search that takes that long, whatever it is. */
  const lag = { ms: 0 };
  class W {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: { preventDefault(): void }) => void) | null = null;
    private t: Promise<Thread | null>;
    constructor(url: string) {
      if (fail === 'throw') throw new Error("Refused to create a worker: it violates the page's Content Security Policy");
      seen.started++;
      this.t = resolveObjectURL(url)!
        .text()
        .then((code) => {
          if (fail === 'error') {
            this.onerror?.({ preventDefault() {} });
            return null;
          }
          const th = new Thread(PRELUDE + code, { eval: true });
          th.unref();
          th.on('message', (data) => this.onmessage?.({ data }));
          return th;
        });
    }
    postMessage(d: unknown) {
      seen.searches++;
      const ms = lag.ms;
      void this.t.then((th) => (ms ? setTimeout(() => th?.postMessage(d), ms) : th?.postMessage(d)));
    }
    terminate() {
      seen.stopped++;
      void this.t.then((th) => th?.terminate());
    }
  }
  Object.defineProperty(globalThis, 'Worker', { value: W, configurable: true, writable: true });
  return {
    seen,
    lag,
    off: () => (was ? Object.defineProperty(globalThis, 'Worker', was) : delete (globalThis as Record<string, unknown>).Worker),
  };
};

/** The audit's label and expression: 28 letters a and an exclamation mark, ten a* in a row. */
const ADJACENT = '^a*a*a*a*a*a*a*a*a*a*$';
/** What Find and replace says when the background search was stopped after FIND_LIMIT. */
const SLOW =
  'This search took too long, so it was stopped and nothing will change. Write the regular expression more simply, with fewer repeats in a row that can match the same text (such as .*.*).';

export function register(t: Kit): void {
  const { test, eq, ok } = t;

  /** Opens Find and replace (or another tool, `id`) on `slots` (French); returns its controls, the store and the toasts. */
  const findTool = (slots: Slot[], id: ToolId = 'find') => {
    const store = new Store();
    store.add(slots);
    const host = new FEl('DIV');
    // On the fake page (install), where the focus is kept.
    dom.layer?.appendChild(host);
    const toasts: string[] = [];
    let open = false;
    const app = {
      store,
      ctx: { base: 1033 },
      toast: (m: string) => void toasts.push(m),
      // Resolves when it closes, as ui/widgets.ts modal does.
      modal: (_: string, build: (close: () => void) => Node) =>
        new Promise((done) => {
          open = true;
          host.appendChild(build(() => ((open = false), done(undefined))) as unknown as FEl);
        }),
    } as unknown as AppApi;
    openTool(app, id, slots, [FR], FR);
    const input = (label: string) => host.querySelectorAll('input').find((i) => i.attrs['aria-label'] === label)!;
    const type = (i: FEl, v: string) => ((i.value = v), fire(i, 'input'));
    return {
      store,
      toasts,
      find: (v: string) => type(input('Find'), v),
      replace: (v: string) => type(input('Replace with'), v),
      go: () => fire(host.querySelector('.btn.primary')!, 'click', { detail: 1 }),
      cancel: () => fire(host.querySelectorAll('button').find((b) => b.textContent === 'Cancel')!, 'click', { detail: 1 }),
      button: () => host.querySelector('.btn.primary')!.textContent,
      goBtn: () => host.querySelector('.btn.primary')!,
      /** Whether Change can be clicked (disabled, or aria-disabled while it searches). */
      ready: () => !host.querySelector('.btn.primary')!.disabled && host.querySelector('.btn.primary')!.getAttribute('aria-disabled') !== 'true',
      /** The new texts the preview shows; none while it is hidden. */
      preview: () => (host.querySelector('.wb-pl')!.hidden ? [] : host.querySelector('.wb-pl')!.querySelectorAll('ins').map((x) => x.textContent)),
      /** Whether a search runs in the background (the preview waits for it). */
      searching: () => host.querySelector('.wb-pl')!.getAttribute('aria-busy') === 'true',
      input,
      /** The line above the preview: what will change, or why nothing can. */
      info: () => host.querySelector('.wb-ti')!.textContent,
      /** Match case, Whole word, Regular expression. */
      checks: () => host.querySelectorAll('input').filter((i) => i.attrs.type === 'checkbox' || i.type === 'checkbox'),
      isOpen: () => open,
    };
  };

  test('find and replace: Change right after typing applies what the field says, never the previous preview', async () => {
    const off = install();
    try {
      const a = t.slot('attribute', 'a', { 1033: 'Name', 1036: 'Nom' }),
        b = t.slot('attribute', 'b', { 1033: 'Last name', 1036: 'Nom de famille' });
      const w = findTool([a, b]);
      w.find('Nom');
      w.replace('Ancien');
      await wait(200); // the preview (debounced) shows "Ancien"
      eq(w.preview(), ['Ancien', 'Ancien de famille']);
      w.replace('Nouveau');
      w.go(); // before the preview of "Nouveau" ran
      eq([a.key, b.key].map((k) => w.store.value(k, FR)), ['Nom', 'Nom de famille'], 'nothing staged from a preview the field no longer says');
      ok(w.isOpen(), 'the tool stays open on the new preview');
      eq(w.preview(), ['Nouveau', 'Nouveau de famille'], 'preview updated at once');
      w.go();
      eq([a.key, b.key].map((k) => w.store.value(k, FR)), ['Nouveau', 'Nouveau de famille']);
      ok(!w.isOpen(), 'closed after the change');
      eq(w.toasts, ['2 cells changed.']);
      w.store.undo();
      eq([a.key, b.key].map((k) => w.store.value(k, FR)), ['Nom', 'Nom de famille'], 'one undo step');
      await wait(200); // the debounce was cancelled: nothing runs after the dialog closed
    } finally {
      off();
    }
  });

  test('find and replace: a new search typed just before Change previews first, a typed-and-restored one applies', async () => {
    const off = install();
    try {
      const a = t.slot('attribute', 'a', { 1033: 'Name', 1036: 'Nom' }),
        b = t.slot('attribute', 'b', { 1033: 'Phone', 1036: 'Téléphone' });
      const w = findTool([a, b]);
      w.find('Nom');
      w.replace('X');
      await wait(200);
      eq(w.button(), 'Change 1 cell');
      w.find('o'); // matches both rows now: 2 cells, never seen in the preview
      w.go();
      eq([a.key, b.key].map((k) => w.store.value(k, FR)), ['Nom', 'Téléphone'], 'nothing staged');
      eq(w.button(), 'Change 2 cells', 'the preview shows the new count');
      // Typed and changed back before the preview ran: the plan is the one shown, so Change applies it.
      w.find('Nom ');
      w.find('o');
      w.go();
      eq([a.key, b.key].map((k) => w.store.value(k, FR)), ['NXm', 'TéléphXne']);
    } finally {
      off();
    }
  });

  test('find and replace: a regular expression that could search a label for minutes is refused with the reason; ordinary ones are not', () => {
    const nested = /^This regular expression repeats a group that holds a repeat or an optional part of its own/;
    const choice = /^This regular expression repeats a choice whose alternatives can match the same text/;
    const refused: Array<[string, RegExp, boolean?]> = [
      ['^(a+)+$', nested],
      ['(a*)*', nested],
      ['(\\w*\\s)*', nested],
      ['(ab?)+', nested],
      ['(x{1,3}){2}', nested],
      ['((a+)b)*', nested],
      ['(?:a+|b)+?', nested],
      ['(a|ab)+', choice],
      ['(\\w|_)*', choice],
      ['(Mr|Mrs)+', choice],
      ['(x(a|b))+', choice],
      ['(?:a|a)+', choice],
      ['(?<w>a|a)+', choice],
      ['(?=a+)+', nested],
      ['(a|)+', choice],
      ['(A|a)+', choice, true],
    ];
    for (const [re, why, i] of refused) ok(why.test(riskyRegex(re, !!i)), `${re} is refused`);
    const fine = ['^a+$', '(\\d+)', '^(.*) \\((.*)\\)$', '(foo|bar)+', '( |\\t)+', '(\\.|,)+', '(ab){3}', 'a{2}', '(a{2})+', '\\s+$', '^(Nouveau|Nouvelle) ', 'colou?r', '[(]+', '\\(a+\\)+', '[a-z]+(?=x)', '(a+)?', '(?<n>ab)\\k<n>', '(?:foo|bar)+', '(?<w>a|b)*','{x}+', '(A|a)+'];
    for (const re of fine) eq(riskyRegex(re), '', `${re} is fine`);
    // With the u flag (Whole word), \u{…} and \p{…} are one character; without it \u{2} repeats a u.
    eq(riskyRegex('(\\p{L}\\u{1F600})+', false, true), '');
    ok(nested.test(riskyRegex('(\\u{1,2})+')), 'without u, {1,2} counts the u');
  });

  test('find and replace: ^(a+)+$ on a label of many letters is refused at once, without searching it; a simple pattern still previews', () => {
    const off = install();
    try {
      const a = t.slot('attribute', 'a', { 1033: 'A', 1036: 'a'.repeat(24) + '!' }),
        // No French yet: Find and replace leaves it alone (Copy base language is the tool that fills it).
        m = t.slot('attribute', 'm', { 1033: 'Phone', 1036: '' });
      const w = findTool([a, m]);
      w.find('^(a+)+$');
      const rx = w.checks()[2];
      rx.checked = true;
      const t0 = performance.now();
      fire(rx, 'change'); // plans at once, as the audit's trigger did
      ok(performance.now() - t0 < 200, 'no search ran');
      ok(/^This regular expression repeats a group/.test(w.info()), w.info());
      eq([w.preview(), w.button(), w.store.pendingCount()], [[], 'Change 0 cells', 0]);
      w.find('^(a+)!$');
      w.replace('b!');
      fire(rx, 'change');
      eq(w.preview(), ['b!']);
      w.go();
      eq([w.store.value(a.key, FR), w.store.value(m.key, FR), w.store.pendingCount()], ['b!', '', 1]);
    } finally {
      off();
    }
  });

  test('find and replace: Match case decides whether a choice of the same letters in another case is refused: off, ^(ab|AB)+$ repeats a choice of the same text; on, it previews', () => {
    const off = install();
    try {
      const a = t.slot('attribute', 'a', { 1033: 'A', 1036: 'abAB' });
      const w = findTool([a]);
      const [mc, , rx] = w.checks();
      w.find('^(ab|AB)+$');
      w.replace('x');
      rx.checked = true;
      fire(rx, 'change'); // Match case off (the default)
      ok(/^This regular expression repeats a choice whose alternatives can match the same text/.test(w.info()), w.info());
      eq([w.preview(), w.button()], [[], 'Change 0 cells']);
      mc.checked = true;
      fire(mc, 'change');
      eq([w.preview(), w.button()], [['x'], 'Change 1 cell']);
      w.go();
      eq(w.store.value(a.key, FR), 'x');
    } finally {
      off();
    }
  });

  test('find and replace: a search that keeps the page busy too long stops between labels, says so and changes nothing', () => {
    const off = install();
    const was = Object.getOwnPropertyDescriptor(globalThis, 'performance')!;
    try {
      const slots = Array.from({ length: 20 }, (_, i) => t.slot('attribute', `a${i}`, { 1033: 'Name', 1036: `Nom ${i}` }));
      const w = findTool(slots);
      // Each label takes "150 ms": the budget (FIND_BUDGET) is over after the third.
      let now = 0;
      Object.defineProperty(globalThis, 'performance', { value: { now: () => (now += 150) }, configurable: true });
      w.find('Nom');
      w.replace('X');
      fire(w.checks()[0], 'change'); // plans at once
      ok(/^This search took too long, so it stopped after 3 labels and nothing will change\./.test(w.info()), w.info());
      eq([w.preview(), w.store.pendingCount()], [[], 0]);
      ok(FIND_BUDGET < 450 && FIND_BUDGET > 300);
    } finally {
      Object.defineProperty(globalThis, 'performance', was);
      off();
    }
  });

  // ---- regular expressions in the background (regex.ts), and on the page where no worker runs ----

  test('where no worker runs, a regular expression that could keep the page busy is refused with the reason (heavyRegex); simple ones are not', () => {
    const repeats = /^This regular expression has two repeats that can match the same text/;
    const choices = /^This regular expression has too many optional parts or choices/;
    const refused: Array<[string, RegExp, boolean?, boolean?]> = [
      [ADJACENT, repeats],
      [ADJACENT, repeats, true],
      ['a*a*', repeats],
      ['A*a*', repeats, true],
      ['.*.*', repeats],
      ['.*x.*', repeats],
      ['^(.*) \\((.*)\\)$', repeats],
      ['.*\\w+$', repeats], // each place .* stops, \w+ searches the rest again
      ['.*\\d+x', repeats],
      ['a+.{9}b+.{9}c+', repeats],
      ['(.*)\\1', repeats],
      ['\\w{2,}\\w{2,}', repeats],
      ['\\s*.*', repeats],
      ['[^b]*a*', repeats],
      ['.{0,20}.{0,20}', repeats], // counts above 16 count as unbounded
      ['(?=.*a).*b', repeats],
      ['(?<=a+)b+a*', repeats],
      ['\\x61*a*', repeats],
      ['[\\x60-\\x62]+a+', repeats],
      ['\\u{61}*a*', repeats, false, true],
      ['(?i:A)*a*', repeats],
      ['a?a?a?a?a?a?aaaaaa', choices],
      ['x{1,16}x{1,16}', choices],
      ['a*' + '(?:|)'.repeat(40) + 'b', choices],
    ];
    for (const [re, why, i, u] of refused) ok(why.test(heavyRegex(re, !!i, !!u)), `${re} is refused`);
    const fine = [
      'Nom',
      '^a+$',
      '^(a+)!$',
      'colou?r',
      '(\\w+) (\\w+)',
      '^\\s+|\\s+$',
      '\\d+[.,]\\d+',
      '\\w+@\\w+\\.\\w+',
      '(foo|bar)+',
      '^(Nouveau|Nouvelle) ',
      '(Mr|Mrs|Ms)\\.? ',
      '(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)',
      '^Tapez .*$',
      '.*x',
      '^(.*) - ',
      '[A-Z][a-z]+',
      '\\bNom\\b',
      '^\\d{4}-\\d{2}-\\d{2}$',
      '\\d{1,3}(?:[ .]\\d{3})*',
      '(\\d+)-\\1',
      '(?<n>ab)\\k<n>',
      '[(]+',
      '\\(a+\\)+',
      'a.{0,1000}a',
    ];
    for (const re of fine) eq([heavyRegex(re), heavyRegex(re, true)], ['', ''], `${re} is fine`);
    // \p{…} counts as any character, a space too: one repeat of it is fine, two are not.
    eq(heavyRegex('^\\p{Lu}\\p{Ll}+ ', false, true), '');
    ok(repeats.test(heavyRegex('(\\p{L}+) (\\p{L}+)', false, true)));
  });

  test("where no worker runs, the audit's ^a*a*a*a*a*a*a*a*a*a*$ on 28 letters is refused at once, without searching; ^(a+)!$ still previews and changes on the page", () => {
    const off = install();
    try {
      const a = t.slot('attribute', 'a', { 1033: 'A', 1036: 'a'.repeat(28) + '!' });
      const w = findTool([a]);
      const rx = w.checks()[2];
      rx.checked = true;
      w.find(ADJACENT);
      const t0 = performance.now();
      fire(rx, 'change'); // plans at once, as the audit's trigger did
      ok(performance.now() - t0 < 200, 'no search ran');
      ok(/^This regular expression has two repeats that can match the same text/.test(w.info()), w.info());
      eq([w.preview(), w.button(), w.store.pendingCount()], [[], 'Change 0 cells', 0]);
      w.find('^(a+)!$');
      w.replace('b!');
      fire(rx, 'change');
      eq([w.preview(), w.ready()], [['b!'], true]);
      w.go();
      eq([w.store.value(a.key, FR), w.store.pendingCount()], ['b!', 1]);
    } finally {
      off();
    }
  });

  test('where no worker runs, Whole word lets no expression past heavyRegex: a)(?:a*a*a*a*a*a*a*a*a*a*$, valid only inside its group, is refused at once on 28 letters', () => {
    // Its ")" closes Whole word's (?: and the group's own ")" closes the one it opened: the checks would read "a" only.
    const BYPASS = 'a)(?:a*a*a*a*a*a*a*a*a*a*$';
    const INVALID = 'That regular expression is not valid.';
    ok(!!new RegExp(`(?<![\\p{L}\\p{N}_])(?:${BYPASS})(?![\\p{L}\\p{N}_])`, 'giu'), 'valid inside the group');
    eq([riskyRegex(BYPASS, true, true), heavyRegex(BYPASS, true, true), heavyRegex('a)b'), heavyRegex('(a)b)')], ['', INVALID, INVALID, INVALID]);
    const off = install();
    try {
      const a = t.slot('attribute', 'a', { 1033: 'A', 1036: 'a'.repeat(28) + '!' });
      const w = findTool([a]);
      const [, ww, rx] = w.checks();
      rx.checked = true;
      w.find(BYPASS);
      fire(rx, 'change'); // Regular expression alone: not valid
      eq(w.info(), INVALID);
      ww.checked = true;
      const t0 = performance.now();
      fire(ww, 'change');
      ok(performance.now() - t0 < 200, `no search ran (${Math.round(performance.now() - t0)} ms)`);
      eq([w.info(), w.preview(), w.ready(), w.store.pendingCount()], [INVALID, [], false, 0]);
      // A valid one still searches with Whole word.
      w.find('a+!?');
      w.replace('b');
      fire(ww, 'change');
      eq(w.preview(), ['b']);
    } finally {
      off();
    }
  });

  test("with a worker, the audit's ^a*a*a*a*a*a*a*a*a*a*$ searches in the background: the page stays free, the worker is stopped after FIND_LIMIT and nothing changes", async () => {
    const off = install();
    const wk = workers();
    try {
      const a = t.slot('attribute', 'a', { 1033: 'A', 1036: 'a'.repeat(28) + '!' }),
        b = t.slot('attribute', 'b', { 1033: 'Name', 1036: 'Nom (Name)' });
      const w = findTool([a, b]);
      const rx = w.checks()[2];
      // As in the audit: the expression typed (searched as plain text), then Regular expression ticked.
      w.find(ADJACENT);
      await wait(200);
      rx.checked = true;
      const t0 = performance.now();
      fire(rx, 'change');
      ok(performance.now() - t0 < 200, 'the event returns at once');
      ok(w.searching());
      await until(() => w.info() === 'Searching…');
      ok(performance.now() - t0 >= SEARCHING_AFTER - 5, 'said once it takes a moment');
      eq([w.ready(), w.button()], [false, 'Change']);
      await until(() => !w.searching(), FIND_LIMIT + 3000);
      const took = performance.now() - t0;
      ok(took >= FIND_LIMIT - 50 && took < FIND_LIMIT + 1500, `stopped after ${Math.round(took)} ms`);
      eq([w.info(), w.preview(), w.ready(), w.store.pendingCount()], [SLOW, [], false, 0]);
      eq([wk.seen.started, wk.seen.stopped], [1, 1]);
      ok(FIND_LIMIT >= 1000 && FIND_LIMIT <= 3000);
      // Two .* the page itself would refuse (heavyRegex) run in a new worker; Change applies the plan it previewed.
      w.find('^(.*) \\((.*)\\)$');
      w.replace('$2 ($1)');
      await wait(200);
      await until(() => !w.searching());
      eq([w.preview(), w.info(), w.ready()], [['Name (Nom)'], '1 cell will change.', true]);
      const searches = wk.seen.searches;
      w.go(); // nothing changed since the preview: applied at once, never searched again
      eq([w.isOpen(), w.store.value(b.key, FR), w.toasts, wk.seen.searches], [false, 'Name (Nom)', ['1 cell changed.'], searches]);
      eq(w.store.value(a.key, FR), 'a'.repeat(28) + '!');
      await wait(50);
      eq(wk.seen.stopped, wk.seen.started, 'closing stopped the worker');
      w.store.undo();
      eq(w.store.value(b.key, FR), 'Nom (Name)', 'one undo step');
    } finally {
      wk.off();
      off();
    }
  });

  test('with a worker, Change right after typing applies only what the background search previewed; while "Searching…" shows, Change does nothing; a newer search stops the one running; closing stops it too', async () => {
    const off = install();
    const wk = workers();
    try {
      const a = t.slot('attribute', 'a', { 1033: 'Name', 1036: 'Nom' }),
        b = t.slot('attribute', 'b', { 1033: 'Phone', 1036: 'Téléphone' }),
        c = t.slot('attribute', 'c', { 1033: 'A', 1036: 'a'.repeat(28) + '!' });
      const w = findTool([a, b, c]);
      const rx = w.checks()[2];
      rx.checked = true;
      w.find('o');
      w.replace('X');
      fire(rx, 'change');
      await until(() => !w.searching());
      eq(w.preview(), ['NXm', 'TéléphXne']);
      w.find('^N'); // no preview yet
      w.go();
      await until(() => !w.searching());
      eq([w.store.pendingCount(), w.isOpen(), w.preview(), w.ready()], [0, true, ['Xom'], true], 'the new plan shows; nothing staged');
      // A new search: until it answers, the preview stays as it is (nothing flashes after each pause in typing)...
      w.find('^N');
      w.replace('Y');
      fire(rx, 'change');
      eq([w.searching(), w.preview(), w.info(), w.button()], [true, ['Xom'], '1 cell will change.', 'Change 1 cell']);
      // ... and past SEARCHING_AFTER the dialog says so: the old preview and its count go, and Change does nothing.
      w.find(ADJACENT);
      fire(rx, 'change');
      await wait(SEARCHING_AFTER + 50);
      eq([w.info(), w.preview(), w.button(), w.ready(), w.goBtn().disabled], ['Searching…', [], 'Change', false, false]);
      w.go();
      eq([w.store.pendingCount(), w.isOpen()], [0, true], 'Change waits for the preview');
      // A search that would take minutes, replaced by a newer one: its worker is stopped, the new one answers at once.
      const t0 = performance.now();
      w.find('^T');
      fire(rx, 'change');
      await until(() => !w.searching());
      ok(performance.now() - t0 < FIND_LIMIT, 'the newer search did not wait for the older one');
      eq([w.preview(), w.ready(), w.store.pendingCount()], [['Yéléphone'], true, 0]);
      ok(wk.seen.stopped >= 1, 'the older worker was stopped');
      // Closing while a search runs stops its worker; its answer never shows, nor does "Searching…".
      w.find(ADJACENT);
      fire(rx, 'change');
      ok(w.searching());
      w.cancel();
      ok(!w.isOpen());
      await wait(SEARCHING_AFTER + 50);
      eq(wk.seen.stopped, wk.seen.started, 'every worker stopped');
      eq([w.store.pendingCount(), w.info()], [0, '1 cell will change.']);
    } finally {
      wk.off();
      off();
    }
  });

  test('with a worker, a click on Change while a search runs waits for it and applies it only when it is the plan shown; a quick answer never says "Searching…"; Change never drops the focus', async () => {
    const off = install();
    const wk = workers();
    try {
      const a = t.slot('attribute', 'a', { 1033: 'Name', 1036: 'Nom' }),
        b = t.slot('attribute', 'b', { 1033: 'Phone', 1036: 'Téléphone' });
      const w = findTool([a, b]);
      const rx = w.checks()[2];
      rx.checked = true;
      w.find('o');
      w.replace('X');
      fire(rx, 'change');
      await until(() => !w.searching());
      eq(w.preview(), ['NXm', 'TéléphXne']);
      // The same plan by another expression: the click made before its answer applies it once it comes.
      w.find('[o]');
      fire(rx, 'change');
      const t0 = performance.now();
      let said = false;
      w.go();
      eq([w.isOpen(), w.store.pendingCount()], [true, 0]);
      await until(() => ((said ||= w.info() === 'Searching…'), !w.isOpen()));
      eq([a.key, b.key].map((k) => w.store.value(k, FR)), ['NXm', 'TéléphXne']);
      // Answered within SEARCHING_AFTER: "Searching…" never showed.
      if (performance.now() - t0 < SEARCHING_AFTER - 20) ok(!said, 'no "Searching…" for a quick answer');

      // Typed after that click, before the answer: the click is dropped, as a changed option drops it (reaudit 07,
      // UX07-01). The dialog stays open, previews the new text, and the next click applies that.
      const q = findTool([a, b]);
      const qrx = q.checks()[2];
      qrx.checked = true;
      q.find('o');
      q.replace('X');
      fire(qrx, 'change');
      await until(() => !q.searching());
      q.find('[o]');
      fire(qrx, 'change');
      q.go();
      q.replace('Y');
      await until(() => !q.searching());
      // The answer came before the typing's preview (150 ms): the click it dropped would have applied it.
      eq([q.isOpen(), q.store.pendingCount(), q.preview()], [true, 0, ['NXm', 'TéléphXne']], 'the click is dropped');
      await until(() => q.preview()[0] === 'NYm');
      eq([q.preview(), q.store.pendingCount()], [['NYm', 'TéléphYne'], 0]);
      q.go();
      eq([q.isOpen(), [a.key, b.key].map((k) => q.store.value(k, FR))], [false, ['NYm', 'TéléphYne']]);

      // Once "Searching…" shows there is no preview: a click does nothing, even when the answer is the plan hidden.
      const g = findTool([a, b]);
      const grx = g.checks()[2];
      grx.checked = true;
      g.find('o');
      g.replace('X');
      fire(grx, 'change');
      await until(() => !g.searching());
      wk.lag.ms = SEARCHING_AFTER * 2;
      g.find('[o]');
      fire(grx, 'change');
      await until(() => g.info() === 'Searching…');
      g.go();
      await until(() => !g.searching());
      eq([g.isOpen(), g.store.pendingCount(), g.preview(), g.ready()], [true, 0, ['NXm', 'TéléphXne'], true], 'the preview shows; nothing changed');
      wk.lag.ms = 0;
      g.go();
      eq([g.isOpen(), g.store.pendingCount()], [false, 2], 'the next click applies it, at once');

      // A different plan: the click shows it, and changes nothing.
      const v = findTool([a, b]);
      const vrx = v.checks()[2];
      vrx.checked = true;
      v.find('o');
      v.replace('X');
      fire(vrx, 'change');
      await until(() => !v.searching());
      v.find('é');
      fire(vrx, 'change');
      v.go();
      await until(() => !v.searching());
      eq([v.isOpen(), v.store.pendingCount(), v.preview()], [true, 0, ['TXlXphone']]);
      v.cancel();

      // Change has the focus and the search it runs finds nothing: Change is disabled, and the focus goes to Find, not
      // out of the dialog. While it searches, Change stays enabled (and focused).
      const f = findTool([a, b]);
      const frx = f.checks()[2];
      frx.checked = true;
      f.find('o');
      fire(frx, 'change');
      await until(() => !f.searching());
      f.goBtn().focus();
      ok(dom.root.activeElement === f.goBtn());
      f.find('zzz'); // typed: Change plans first
      f.go();
      eq([f.searching(), f.goBtn().disabled, dom.root.activeElement === f.goBtn()], [true, false, true]);
      await until(() => !f.searching());
      eq([f.info(), f.ready(), f.isOpen()], ['Nothing to change.', false, true]);
      ok(dom.root.activeElement === f.input('Find'), 'the focus is on Find');
      f.cancel();
    } finally {
      wk.off();
      off();
    }
  });

  test('a page that forbids workers (the constructor throws, or the worker fails to load) gets the page search, with heavyRegex: refused at once, simple ones work', async () => {
    for (const fail of ['throw', 'error'] as const) {
      const off = install();
      const wk = workers(fail);
      try {
        const a = t.slot('attribute', 'a', { 1033: 'A', 1036: 'a'.repeat(28) + '!' });
        const w = findTool([a]);
        const rx = w.checks()[2];
        rx.checked = true;
        w.find(ADJACENT);
        fire(rx, 'change');
        // A worker that fails to load says so with an error event, a moment later; the page plans again then.
        if (fail === 'error') await until(() => !w.searching());
        ok(/^This regular expression has two repeats that can match the same text/.test(w.info()), `${fail}: ${w.info()}`);
        eq([w.preview(), w.store.pendingCount()], [[], 0]);
        // No worker is tried again on this page: the next search runs on the page at once.
        w.find('^(a+)!$');
        w.replace('b!');
        fire(rx, 'change');
        eq(w.preview(), ['b!'], fail);
        eq(wk.seen.started, fail === 'throw' ? 0 : 1, fail);
        w.go();
        eq(w.store.value(a.key, FR), 'b!', fail);
      } finally {
        wk.off();
        off();
      }
    }
  });

  test('with a worker, riskyRegex still refuses ^(a+)+$ at once, without starting one; so is an expression valid only inside Whole word\'s group; plain text and the other tools plan on the page', () => {
    const off = install();
    const wk = workers();
    try {
      const a = t.slot('attribute', 'a', { 1033: 'A', 1036: 'a'.repeat(28) + '!' });
      const w = findTool([a]);
      const [, ww, rx] = w.checks();
      rx.checked = true;
      w.find('^(a+)+$');
      fire(rx, 'change');
      ok(/^This regular expression repeats a group that holds a repeat/.test(w.info()), w.info());
      ww.checked = true;
      w.find('a)(?:a*a*a*a*a*a*a*a*a*a*$');
      fire(ww, 'change');
      eq([w.info(), w.searching()], ['That regular expression is not valid.', false]);
      ww.checked = false;
      rx.checked = false;
      w.find('!');
      w.replace('?');
      fire(rx, 'change');
      eq(w.preview(), ['a'.repeat(28) + '?']);
      eq(wk.seen.started, 0);
    } finally {
      wk.off();
      off();
    }
  });

  test("find and replace: a label of a managed solution's component is never previewed nor changed; the others are", async () => {
    const off = install();
    try {
      const m = { ...t.slot('attribute', 'm', { 1033: 'Name', 1036: 'Nom' }), ref: { managed: true } },
        u = t.slot('attribute', 'u', { 1033: 'Last name', 1036: 'Nom de famille' });
      const w = findTool([m, u]);
      w.find('Nom');
      w.replace('Ancien');
      await wait(200);
      eq([w.preview(), w.button()], [['Ancien de famille'], 'Change 1 cell']);
      w.go();
      eq([m.key, u.key].map((k) => w.store.value(k, FR)), ['Nom', 'Ancien de famille']);
      eq(w.store.isEdited(m.key), false);
    } finally {
      off();
    }
  });

  // ---- a metadata description emptied is saved empty (core/model.ts savesEmpty) ----

  /** A column's tooltip (a metadata description, core/model.ts keepsEmpty) with these labels. */
  const tooltip = (x: string, labels: Record<number, string>) => ({ ...t.slot('attribute', `attribute|acc.${x}|Description`, labels), prop: 'Description', baseRequired: false }) as Slot;

  test("find and replace with nothing on French tooltips' whole text: the preview says each is saved empty, the line above how many (their users see none); Change stages them empty", async () => {
    const off = install();
    try {
      const a = tooltip('a', { 1033: 'Type the name.', 1036: 'Tapez le nom.' }),
        b = tooltip('b', { 1033: 'Type the city.', 1036: 'Tapez la ville.' });
      const w = findTool([a, b]);
      w.find('Tapez le nom.');
      w.replace('');
      await wait(200);
      eq([w.preview(), w.info()], [['(saved empty)'], '1 cell will change. 1 description will be saved empty when you save: users of that language see none there.']);
      const rx = w.checks()[2];
      rx.checked = true;
      w.find('^Tapez .*$');
      fire(rx, 'change');
      eq([w.preview(), w.info()], [['(saved empty)', '(saved empty)'], '2 cells will change. 2 descriptions will be saved empty when you save: users of those languages see none there.']);
      w.go();
      eq([a.key, b.key].map((k) => [w.store.value(k, FR), w.store.emptyOnPurpose(k, FR, 1033)]), [['', true], ['', true]]);
      eq(w.toasts, ['2 cells changed.']);
    } finally {
      off();
    }
  });

  test('copy base language: a French tooltip stored empty on purpose is done (its users see none, as chosen), never filled with the English text; a missing one is', () => {
    const off = install();
    try {
      const stored = tooltip('s', { 1033: 'Type the name.', 1036: '' }),
        none = tooltip('n', { 1033: 'Type the city.' });
      const w = findTool([stored, none], 'base');
      eq([w.preview(), w.info()], [['Type the city.'], '1 cell will change.']);
      w.go();
      eq([w.store.value(stored.key, FR), w.store.value(none.key, FR), w.store.pendingCount()], ['', 'Type the city.', 1]);
    } finally {
      off();
    }
  });
}
