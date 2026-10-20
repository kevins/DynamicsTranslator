// Find and replace's regular expressions (tools.ts). JavaScript can't stop a search once it started, and some
// expressions take minutes on a label of a few dozen letters (^a*a*a*a*a*a*$ tries every way to split it). So they
// search in a Web Worker the dialog stops after FIND_LIMIT (searcher); on a page whose policy allows no worker, only
// an expression that can't keep the page busy (heavyRegex) searches on the page.

/** How long (ms) a search in the background may take before it is stopped. The page stays usable meanwhile. */
export const FIND_LIMIT = 1500;

/**
 * What a background search answers: the texts it changes (by index), or 'slow' (stopped after FIND_LIMIT), 'failed'
 * (the search threw), 'stopped' (a newer search or the dialog's closing replaced it), 'unavailable' (the worker never
 * ran, as on a page whose policy blocks it as it loads: the page searches instead, after heavyRegex).
 */
export type Found = { changed: Map<number, string> } | 'slow' | 'failed' | 'stopped' | 'unavailable';

export interface Searcher {
  /**
   * Replaces `re` with `rep` in each of `texts`, as String.replace does, in the background; null at once when no
   * worker can start on this page.
   */
  run(re: RegExp, rep: string, texts: string[]): Promise<Found> | null;
  /** Stops the search running, if any, and frees the worker (the dialog closed). */
  close(): void;
}

/** The worker: says it runs, then answers each search with the texts it changes. Plain ES5, as it is not bundled. */
const CODE =
  'self.onmessage=function(e){var d=e.data,o=[];try{var r=new RegExp(d.src,d.flags);for(var k=0;k<d.texts.length;k++){var v=d.texts[k],n=v.replace(r,d.rep);if(n!==v)o.push([k,n])}self.postMessage({id:d.id,out:o})}catch(x){self.postMessage({id:d.id,failed:String(x)})}};self.postMessage({ready:1});';

/** The Worker constructor that could not run a search here (the page's policy forbids blob: workers): not tried again. */
let refused: unknown = null;

/** Whether searches may run in the background: false without workers, or once one could not start on this page. */
export const canSearchAside = (): boolean => typeof Worker === 'function' && refused !== Worker;

/**
 * One worker per dialog, started at its first search. A search still running when the next one comes is stopped
 * with its worker (it can't take another before it ends); so is one that runs longer than `limit`, counted from when
 * the worker runs. A worker that can't be created (run gives null), fails to load or doesn't run within `limit`
 * ('unavailable') is not tried again on this page.
 */
export function searcher(limit = FIND_LIMIT): Searcher {
  let url = '',
    w: Worker | null = null,
    ready = false,
    id = 0,
    timer: ReturnType<typeof setTimeout> | undefined,
    job: ((f: Found) => void) | null = null;
  const settle = (f: Found) => {
    const j = job;
    job = null;
    clearTimeout(timer);
    j?.(f);
  };
  const stop = () => {
    clearTimeout(timer);
    w?.terminate();
    w = null;
    ready = false;
  };
  /** Stops the worker and answers `f` once it ran, or 'unavailable' (and no worker again) when it never did. */
  const fail = (f: Found) => {
    const ran = ready;
    stop();
    if (!ran) refused = Worker;
    settle(ran ? f : 'unavailable');
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => fail('slow'), limit);
  };
  const start = (): Worker | null => {
    try {
      url ||= URL.createObjectURL(new Blob([CODE], { type: 'text/javascript' }));
      const x = new Worker(url);
      x.onmessage = (e: MessageEvent) => {
        const d = e.data as { ready?: 1; id?: number; out?: Array<[number, string]> };
        if (x !== w) return;
        if (d.ready) {
          ready = true;
          if (job) arm(); // the time counts from when the worker runs
        } else if (d.id === id && job) settle(d.out ? { changed: new Map(d.out) } : 'failed');
      };
      x.onerror = (e: Event) => {
        e.preventDefault?.();
        if (x === w) fail('failed');
      };
      return x;
    } catch {
      // A policy without blob: in worker-src (or Trusted Types) throws here.
      refused = Worker;
      return null;
    }
  };
  return {
    run(re, rep, texts) {
      if (job) {
        stop();
        settle('stopped');
      }
      w ||= start();
      if (!w) return null;
      const p = new Promise<Found>((r) => (job = r));
      w.postMessage({ id: ++id, src: re.source, flags: re.flags, rep, texts });
      arm();
      return p;
    },
    close() {
      stop();
      settle('stopped');
      if (url) URL.revokeObjectURL(url);
      url = '';
    },
  };
}

// ---- where no worker runs: the expressions that can't keep the page busy ----

/** Characters as sorted, disjoint [first, last] code point ranges. */
type Chars = Array<[number, number]>;
type Node =
  | { t: 'set'; set: Chars } // one character
  | { t: 'zero' } // ^ $ \b \B: matches no character
  | { t: 'ref' } // a backreference: the text a group matched
  | { t: 'look'; behind: boolean; alts: Term[][] }
  | { t: 'group'; alts: Term[][] };
interface Term {
  n: Node;
  min: number;
  max: number;
}

const TOP = 0x10ffff;
const ALL: Chars = [[0, TOP]];
const merge = (rs: Chars): Chars => {
  const s = [...rs].sort((a, b) => a[0] - b[0]),
    out: Chars = [];
  for (const [a, b] of s) {
    const l = out[out.length - 1];
    if (l && a <= l[1] + 1) l[1] = Math.max(l[1], b);
    else out.push([a, b]);
  }
  return out;
};
const not = (rs: Chars): Chars => {
  const out: Chars = [];
  let at = 0;
  for (const [a, b] of merge(rs)) {
    if (a > at) out.push([at, a - 1]);
    at = b + 1;
  }
  if (at <= TOP) out.push([at, TOP]);
  return out;
};
/** Whether two sets share a character. */
const meets = (a: Chars, b: Chars): boolean => {
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i][1] < b[j][0]) i++;
    else if (b[j][1] < a[i][0]) j++;
    else return true;
  }
  return false;
};
const D: Chars = [[48, 57]];
const W: Chars = [[48, 57], [65, 90], [95, 95], [97, 122]];
const S: Chars = merge([[9, 13], [32, 32], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff]]);
const DOT = not([[10, 10], [13, 13], [0x2028, 0x2029]]);

/** Counts above this are treated as unbounded: a{0,1000} can split a text nearly as many ways as a*. */
const BIG = 16;
/** How many ways the optional parts, bounded counts and choices of an expression may combine at most. */
const WAYS = 32;

/**
 * Why a regular expression (one riskyRegex in tools.ts accepts) could keep the page busy for long, or ''. Used where
 * no worker can search in the background, so it refuses what it can't prove quick, and keeps simple expressions:
 * plain text, classes, anchors, a choice of words, and repeats that a character they can't match ends (\w+ \w+) or
 * that end the expression (^Nom .*$). JavaScript backtracks: when a match fails, it tries every other way the repeats
 * could have split the text. Refused:
 * - two repeats that can match the same characters where one of them can end anywhere: what follows it can start
 *   with a character it matches too, so each place it stops is tried (a*a*, .*x.*, (.*)\1, .*\d+x);
 * - optional parts, bounded counts and choices that can combine more than WAYS ways (a?a?a?a?a?a?aaaaaa).
 * Counts above BIG are treated as unbounded. `i`: case doesn't matter; `u`: the u flag is on.
 */
export function heavyRegex(src: string, i = false, u = false): string {
  const REPEATS =
    "This regular expression has two repeats that can match the same text, like a*a* or .*x.*, which can freeze the page on some labels: this page does not let the search run in the background. Keep one of them, or put a character they can't match between them, as in \\w+ \\w+.";
  const WAYS_MSG =
    'This regular expression has too many optional parts or choices that can match the same text, like a?a?a?aaa, which can freeze the page on some labels: this page does not let the search run in the background. Write it with fewer of them.';
  // Inline modifiers ((?i:…), (?s:…)): case and line breaks may count anywhere.
  const mod = /\(\?[a-zA-Z-]+:/.test(src.replace(/\\./gs, ''));
  const ci = i || mod;
  const dot = mod ? ALL : DOT;
  const folded = new Map<string, Chars>();
  /**
   * Under ignore-case, every character also stands for its other cases (both sides of a comparison are folded); a
   * large set, for anything.
   */
  const fold = (rs: Chars): Chars => {
    if (!ci) return rs;
    if (rs.reduce((n, [a, b]) => n + b - a + 1, 0) > 256) return ALL;
    const key = rs.join();
    const done = folded.get(key);
    if (done) return done;
    const out: Chars = [...rs];
    for (const [a, b] of rs)
      for (let c = a; c <= b; c++) {
        const s = String.fromCodePoint(c);
        for (const v of [s.toLowerCase(), s.toUpperCase(), s.toUpperCase().toLowerCase(), s.toLowerCase().toUpperCase()]) {
          const cp = v.codePointAt(0)!;
          if (v.length === String.fromCodePoint(cp).length) out.push([cp, cp]);
        }
      }
    const r = merge(out);
    folded.set(key, r);
    return r;
  };
  const one = (c: number): Chars => [[c, c]];

  // ---- parse ----
  let p = 0;
  const cp = (): number => {
    const c = u ? src.codePointAt(p)! : src.charCodeAt(p);
    p += c > 0xffff ? 2 : 1;
    return c;
  };
  const hex = (n: number): number | null => {
    const m = new RegExp(`^[0-9a-fA-F]{${n}}`).exec(src.slice(p));
    if (!m) return null;
    p += n;
    return parseInt(m[0], 16);
  };
  /** An escape after its backslash: a set, or for \b \B (outside a class) and backreferences a node. */
  const escape = (inClass: boolean): Chars | Node => {
    const c = src[p++];
    switch (c) {
      case 'd':
        return D;
      case 'D':
        return not(D);
      case 'w':
        return W;
      case 'W':
        return not(W);
      case 's':
        return S;
      case 'S':
        return not(S);
      case 'b':
        return inClass ? one(8) : { t: 'zero' };
      case 'B':
        return inClass ? one(66) : { t: 'zero' };
      case 't':
        return one(9);
      case 'n':
        return one(10);
      case 'v':
        return one(11);
      case 'f':
        return one(12);
      case 'r':
        return one(13);
      case 'c':
        if (/[a-zA-Z]/.test(src[p] ?? '')) return one(src.charCodeAt(p++) % 32);
        // Not a control character: a backslash, then the c.
        p--;
        return one(92);
      case 'x': {
        const v = hex(2);
        return one(v ?? 120);
      }
      case 'u': {
        if (u && src[p] === '{') {
          const e = src.indexOf('}', p);
          const v = parseInt(src.slice(p + 1, e), 16);
          p = e + 1;
          return one(v);
        }
        const v = hex(4);
        return one(v ?? 117);
      }
      case 'p':
      case 'P':
        if (u && src[p] === '{') {
          p = src.indexOf('}', p) + 1;
          return ALL;
        }
        return one(c.charCodeAt(0));
      case 'k':
        if (src[p] === '<') {
          p = src.indexOf('>', p) + 1;
          return inClass ? ALL : { t: 'ref' };
        }
        return one(107);
      case '0':
        // \0, or an old octal escape (without u) such as \012.
        if (/[0-9]/.test(src[p] ?? '')) {
          while (/[0-7]/.test(src[p] ?? '')) p++;
          return ALL;
        }
        return one(0);
      default:
        if (/[1-9]/.test(c)) {
          // A backreference, or an octal escape when there is no such group: either way, any text.
          while (/[0-9]/.test(src[p] ?? '')) p++;
          return inClass ? ALL : { t: 'ref' };
        }
        p--;
        return one(cp());
    }
  };
  const klass = (): Chars => {
    const neg = src[p] === '^';
    if (neg) p++;
    const set: Chars = [];
    const atom = (): Chars => (src[p] === '\\' ? (p++, escape(true) as Chars) : one(cp()));
    // A class ends at the first ] not escaped, also right after [ ([] matches nothing, [^] anything).
    while (p < src.length && src[p] !== ']') {
      const a = atom();
      if (src[p] === '-' && src[p + 1] !== ']' && p + 1 < src.length && a.length === 1 && a[0][0] === a[0][1]) {
        const save = p++;
        const b = atom();
        if (b.length === 1 && b[0][0] === b[0][1]) set.push([a[0][0], b[0][0]]);
        else {
          // [a-\d]: a, - and the class, as written.
          p = save;
          set.push(...a);
        }
      } else set.push(...a);
    }
    p++;
    // Folded after the negation: [^a] under ignore-case matches fewer characters than that, never more.
    return fold(neg ? not(set) : merge(set));
  };
  const quant = (): { min: number; max: number } => {
    const c = src[p];
    let min = 1,
      max = 1;
    if (c === '*' || c === '+' || c === '?') {
      p++;
      [min, max] = c === '*' ? [0, Infinity] : c === '+' ? [1, Infinity] : [0, 1];
    } else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(p));
      if (!m) return { min, max };
      p += m[0].length;
      min = Number(m[1]);
      max = !m[2] ? min : m[3] ? Number(m[3]) : Infinity;
    } else return { min, max };
    if (src[p] === '?') p++; // lazy
    return { min, max };
  };
  const alts = (): Term[][] => {
    const out: Term[][] = [[]];
    while (p < src.length && src[p] !== ')') {
      if (src[p] === '|') {
        p++;
        out.push([]);
        continue;
      }
      let n: Node;
      const c = src[p];
      if (c === '(') {
        const k = /^\((?:\?(?:[:=!]|<[=!]|<[^>]*>|[a-zA-Z-]*:))?/.exec(src.slice(p))![0];
        p += k.length;
        const body = alts();
        p++; // )
        n = /^\(\?<?[=!]/.test(k) ? { t: 'look', behind: k[2] === '<', alts: body } : { t: 'group', alts: body };
      } else if (c === '[') {
        p++;
        n = { t: 'set', set: klass() };
      } else if (c === '\\') {
        p++;
        const e = escape(false);
        n = Array.isArray(e) ? { t: 'set', set: fold(e) } : e;
      } else if (c === '^' || c === '$') {
        p++;
        n = { t: 'zero' };
      } else if (c === '.') {
        p++;
        n = { t: 'set', set: dot };
      } else n = { t: 'set', set: fold(one(cp())) };
      out[out.length - 1].push({ n, ...quant() });
    }
    return out;
  };
  const tree = alts();
  // A ")" that closes no group ends the parse: what follows it would go unchecked. RegExp refuses such an expression
  // (tools.ts checks it on its own, not only inside Whole word's group), so this only keeps that from mattering.
  if (p < src.length) return 'That regular expression is not valid.';

  // ---- what each part can match ----
  const charsOf = (n: Node): Chars =>
    n.t === 'set' ? n.set : n.t === 'ref' ? ALL : n.t === 'group' ? merge(n.alts.flatMap((s) => s.flatMap((x) => charsOf(x.n)))) : [];
  /** The characters a sequence can start with, and whether it can match nothing. */
  const first = (s: Term[]): { set: Chars; empty: boolean } => {
    const set: Chars = [];
    for (const x of s) {
      if (x.n.t === 'zero' || x.n.t === 'look' || x.max === 0) continue;
      if (x.n.t === 'set') set.push(...x.n.set);
      else if (x.n.t === 'ref') return { set: ALL, empty: true };
      else {
        const f = x.n.alts.map(first);
        set.push(...f.flatMap((y) => y.set));
        if (x.min > 0 && f.every((y) => !y.empty)) return { set: merge(set), empty: false };
        continue;
      }
      if (x.min > 0) return { set: merge(set), empty: false };
    }
    return { set: merge(set), empty: true };
  };

  /**
   * What comes after the end of a sequence: the rest of the sequence holding its group, or true for the end of the
   * expression (or of a look-around, which is never tried again once it matched), false where it is not known (the
   * next round of a repeated group).
   */
  type Up = { s: Term[]; j: number; up: Up } | boolean;
  /**
   * Whether every way on from term `j` of `s` meets a character that must be there and that `a` can't match, before
   * any character `a` can match, a look-around or a backreference. Then a repeat of the characters `a` can only stop
   * where they end: anywhere else, what follows fails at once. `seen` remembers each place (one per repeat).
   */
  const clear = (a: Chars, s: Term[], j: number, up: Up, seen: Map<Term[], boolean[]>): boolean => {
    const memo = seen.get(s) ?? [];
    seen.set(s, memo);
    if (memo[j] !== undefined) return memo[j];
    memo[j] = false;
    let r: boolean | undefined;
    for (let k = j; k < s.length && r === undefined; k++) {
      const { n, min, max } = s[k];
      if (n.t === 'zero' || max === 0) continue;
      if (n.t === 'look' || n.t === 'ref') r = false;
      else if (n.t === 'set') {
        if (meets(n.set, a)) r = false;
        else if (min > 0) r = true;
      } else if (!n.alts.every((x) => clear(a, x, 0, max > 1 ? false : { s, j: k + 1, up }, seen))) r = false;
      else if (min > 0) r = true;
    }
    r ??= typeof up === 'boolean' ? up : clear(a, up.s, up.j, up.up, seen);
    return (memo[j] = r);
  };

  /** Repeats that can take more characters than BIG, and backreferences: whether each can end anywhere. */
  const long: Array<{ set: Chars; loose: boolean }> = [];
  let ways = 1;
  /** How many ways the alternatives can match at one place; collects `long` on the way. */
  const walk = (alts: Term[][], up: Up, behind: boolean): number => {
    const fs = alts.map((s) => {
      let f = 1;
      s.forEach(({ n, min, max }, j) => {
        const on: Up = { s, j: j + 1, up };
        let g = 1;
        if (n.t === 'group') g = walk(n.alts, max > 1 ? false : on, behind);
        else if (n.t === 'look') g = walk(n.alts, true, behind || n.behind);
        if (n.t === 'ref') long.push({ set: ALL, loose: min < max });
        else if (max > BIG && n.t !== 'zero' && n.t !== 'look') {
          // It ends anywhere unless a character it can't match must follow it (a look-behind reads backwards: always).
          const set = charsOf(n);
          long.push({ set, loose: min < max && (behind || !clear(set, s, j + 1, up, new Map())) });
          if (g > 1) ways = Infinity; // a repeated choice: riskyRegex refuses those already
        } else if (n.t !== 'zero') f *= Math.min(g ** max * (max - min + 1), 1e9);
      });
      return f;
    });
    const firsts = alts.map(first);
    const apart = firsts.every((x, k) => !x.empty && firsts.every((y, l) => l <= k || !meets(x.set, y.set)));
    return alts.length < 2 || apart ? Math.max(...fs) : fs.reduce((a, b) => a + b, 0);
  };
  const top = walk(tree, true, false);
  ways = Math.max(ways, top);

  const loose = long.filter((x) => x.loose);
  if (loose.length > 1 || (loose.length && long.some((x) => x !== loose[0] && meets(x.set, loose[0].set)))) return REPEATS;
  if (ways > WAYS) return WAYS_MSG;
  return '';
}
