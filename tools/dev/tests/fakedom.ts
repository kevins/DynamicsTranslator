// A tiny DOM for the scanner's unit tests (coldload.ts, panes.ts): elements with attributes, their own text node,
// parents, closest(), contains() and attribute selectors, and a `document` with a text tree walker. No browser.

export class El {
  parentElement: El | null = null;
  children: El[] = [];
  constructor(
    public tagName: string,
    public attrs: Record<string, string> = {},
    public text = '',
  ) {
    this.tagName = tagName.toUpperCase();
  }
  get id(): string {
    return this.attrs.id ?? '';
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  add(...cs: El[]): this {
    for (const c of cs) {
      c.parentElement = this;
      this.children.push(c);
    }
    return this;
  }
  /**
   * Compound selectors of a tag, an id (#x) and attribute tests ([a], [a="v"], [a^="v"], [a$="v"], [a*="v"], each with an
   * optional ` i` flag), comma lists; anything else never matches.
   */
  matches(sel: string): boolean {
    return sel.split(',').some((p) => {
      const m = /^([a-z][a-z0-9-]*)?(?:#([\w-]+))?((?:\[[^\]]+\])*)$/i.exec(p.trim());
      if (!m || (!m[1] && !m[2] && !m[3])) return false;
      const [, tag, id, attrs] = m;
      if (tag && tag.toUpperCase() !== this.tagName) return false;
      if (id && id !== this.id) return false;
      for (const a of attrs.match(/\[[^\]]+\]/g) || []) {
        const [, k, op, v0, flag] = /^\[([\w-]+)(?:([\^$*]?=)"([^"]*)"(\s+i)?)?\]$/.exec(a) || [];
        const raw = k ? this.getAttribute(k) : null;
        const got = raw !== null && flag ? raw.toLowerCase() : raw;
        const v = flag ? v0.toLowerCase() : v0;
        if (got === null || (op === '=' && got !== v) || (op === '^=' && !got.startsWith(v)) || (op === '$=' && !got.endsWith(v)) || (op === '*=' && !got.includes(v))) return false;
      }
      return true;
    });
  }
  contains(o: El | null): boolean {
    for (let e: El | null = o; e; e = e.parentElement) if (e === this) return true;
    return false;
  }
  closest(sel: string): El | null {
    for (let e: El | null = this; e; e = e.parentElement) if (e.matches(sel)) return e;
    return null;
  }
  querySelectorAll(sel: string): El[] {
    const out: El[] = [];
    const walk = (e: El) => {
      for (const c of e.children) {
        if (c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): El | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  private tn: { nodeType: number; nodeValue: string; parentElement: El } | null = null;
  /** Its own text as a text node (read before its children's, as textContent reads it). */
  get node(): { nodeType: number; nodeValue: string; parentElement: El } {
    return (this.tn ??= { nodeType: 3, nodeValue: this.text, parentElement: this });
  }
  /** DOCUMENT_POSITION_FOLLOWING (4) or PRECEDING (2) within the tree both are in. */
  compareDocumentPosition(o: El): number {
    let top: El = this;
    while (top.parentElement) top = top.parentElement;
    const order: El[] = [];
    const walk = (e: El) => {
      order.push(e);
      e.children.forEach(walk);
    };
    walk(top);
    const a = order.indexOf(this);
    const b = order.indexOf(o);
    return b > a ? 4 : b < a ? 2 : 0;
  }
}

/** Runs `fn` with `document` (selectors, text tree walker) and NodeFilter standing in for the browser's: the scanner's. */
export function withDom<T>(body: El, fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const had = { document: g.document, NodeFilter: g.NodeFilter };
  g.NodeFilter = { SHOW_TEXT: 4 };
  g.document = {
    activeElement: null,
    querySelectorAll: (s: string) => body.querySelectorAll(s),
    querySelector: (s: string) => body.querySelector(s),
    createTreeWalker: (root: El) => {
      const nodes: unknown[] = [];
      const walk = (e: El) => {
        if (e.text) nodes.push(e.node);
        e.children.forEach(walk);
      };
      walk(root);
      let i = 0;
      return { nextNode: () => nodes[i++] ?? null };
    },
  };
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(had))
      if (v === undefined) delete g[k];
      else g[k] = v;
  }
}

