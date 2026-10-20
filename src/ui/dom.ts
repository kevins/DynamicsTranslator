// Tiny DOM toolkit. Every piece of text that comes from Dataverse goes through
// text nodes or attribute setters, never through innerHTML, so labels such as
// `<img onerror=...>` render as plain text and cannot run script in the page.

/** Anything h() and put() accept as content: nodes, text, nested arrays; false/null/undefined are skipped. */
export type Child = Node | string | number | false | null | undefined | Child[];
type Attrs = Record<string, unknown> & {
  class?: string | false | null | undefined;
  style?: string | Partial<CSSStyleDeclaration>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (e: HTMLElementEventMap[K]) => void }>;
};

/** Creates an element. Attribute values of `false`/`null`/`undefined` are skipped, `true` sets an empty attribute. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(tag: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement;
export function h(tag: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === false || v === null || v === undefined) continue;
      if (k === 'on') {
        const on = v as Record<string, EventListener>;
        for (const ev in on) el.addEventListener(ev, on[ev]);
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(el.style, v);
      } else if (k === 'class') {
        el.className = String(v);
      } else if (k in el && (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'tabIndex' || k === 'type' || k === 'title' || k === 'placeholder' || k === 'spellcheck' || k === 'selected')) {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else {
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[] | Child): void {
  if (Array.isArray(children)) {
    for (const c of children) append(parent, c);
  } else if (children !== null && children !== undefined && children !== false) {
    parent.appendChild(typeof children === 'object' ? children : document.createTextNode(String(children)));
  }
}

/** Replaces all children of `el`. */
export function put(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

/** Escapes text for the few static templates that are built as HTML strings. */
export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

// Fluent-style 20x20 stroke icons (same drawing style as the unmanaged layers explorer).
const P = {
  globe: 'M10 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14ZM3 10h14M10 3c2 2.2 2.9 4.6 2.9 7s-.9 4.8-2.9 7c-2-2.2-2.9-4.6-2.9-7S8 5.2 10 3Z',
  close: 'M5 5l10 10M15 5 5 15',
  back: 'M12.5 4.5 7 10l5.5 5.5',
  search: 'M8.5 3.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10ZM12.2 12.2 16.5 16.5',
  download: 'M10 3v9.5M6 9l4 4 4-4M4 16.5h12',
  upload: 'M10 13.5V4M6 8l4-4 4 4M4 16.5h12',
  chevron: 'M6 8l4 4 4-4',
  right: 'M8 5.5l4.5 4.5L8 14.5',
  open: 'M11 4h5v5M16 4l-7 7M14.5 11.5v3a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 14.5V7a1.5 1.5 0 0 1 1.5-1.5h3',
  check: 'M4.5 10.5 8 14l7.5-8',
  warn: 'M10 3.5 17 16H3L10 3.5ZM10 8.5v3.5M10 14v.2',
  info: 'M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM10 9v4.5M10 6.5v.2',
  error: 'M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM7.5 7.5l5 5M12.5 7.5l-5 5',
  okc: 'M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM7 10.2l2 2 4-4.4',
  filter: 'M3.5 4.5h13l-5 6.2v4.3l-3 1.5v-5.8l-5-6.2Z',
  maximize: 'M4.5 4.5h11v11h-11Z',
  restore: 'M4.5 7.5h8v8h-8ZM7.5 7.5v-3h8v8h-3',
  minimize: 'M5 10h10',
  dock: 'M3.5 4.5h13v11h-13ZM11.5 4.5v11',
  up: 'M5 12.5l5-5 5 5',
  down: 'M5 7.5l5 5 5-5',
  copy: 'M7.5 6.5V4a.5.5 0 0 1 .5-.5h7.5a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5H13M4.5 6.5h8v10h-8Z',
  table: 'M3.5 4.5h13v11h-13ZM3.5 8.5h13M3.5 12h13M8 8.5v7',
  page: 'M3.5 4.5h13v11h-13ZM3.5 7.5h13M6 10.5h5M6 13h7.5',
  pick: 'M4 4l4.5 12 1.8-5.2L15.5 9 4 4ZM10.3 10.8l4.2 4.2',
  edit: 'M12.5 4.5l3 3L7 16H4v-3l8.5-8.5ZM11 6l3 3',
  undo: 'M7.5 5.5 4 9l3.5 3.5M4 9h8a4 4 0 0 1 0 8h-2',
  redo: 'M12.5 5.5 16 9l-3.5 3.5M16 9H8a4 4 0 0 0 0 8h2',
  save: 'M4.5 3.5h9l2 2v11h-11ZM7 3.5v4h6v-4M7 16.5v-5h6v5',
  publish: 'M10 16.5V8M6.5 11.5 10 8l3.5 3.5M4.5 4h11',
  list: 'M7.5 5.5h9M7.5 10h9M7.5 14.5h9M3.5 5.5h.5M3.5 10h.5M3.5 14.5h.5',
  form: 'M4.5 3.5h11v13h-11ZM7 7h6M7 10h6M7 13h3',
  flow: 'M3.5 7.5h4l2 2.5-2 2.5h-4l2-2.5-2-2.5ZM10.5 7.5h4l2 2.5-2 2.5h-4l2-2.5-2-2.5Z',
  command: 'M3.5 6.5h13v7h-13ZM6.5 10h7',
  nav: 'M3.5 4.5h4v11h-4ZM10 6h6.5M10 10h6.5M10 14h6.5',
  view: 'M3.5 4.5h13v11h-13ZM3.5 8h13M8 8v7.5M12.5 8v7.5',
  chart: 'M4 16.5h12.5M6 14V9.5M9.5 14V6M13 14v-5.5',
  dash: 'M3.5 3.5h5.5v6.5H3.5ZM11 3.5h5.5v3.5H11ZM11 9h5.5v7.5H11ZM3.5 12h5.5v4.5H3.5Z',
  entity: 'M3.5 5.5c0-1.1 2.9-2 6.5-2s6.5.9 6.5 2v9c0 1.1-2.9 2-6.5 2s-6.5-.9-6.5-2v-9ZM3.5 5.5c0 1.1 2.9 2 6.5 2s6.5-.9 6.5-2M3.5 10c0 1.1 2.9 2 6.5 2s6.5-.9 6.5-2',
  field: 'M3.5 7.5h13v5h-13ZM6 10h3',
  choice: 'M5 6.5h.5M5 10h.5M5 13.5h.5M8.5 6.5h7M8.5 10h7M8.5 13.5h7',
  link: 'M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.8.8M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l.8-.8',
  app: 'M4 4h5v5H4ZM11 4h5v5h-5ZM4 11h5v5H4ZM11 11h5v5h-5Z',
  more: 'M5 10h.2M10 10h.2M15 10h.2',
  keyboard: 'M2.5 5.5h15v9h-15ZM5.5 8.5h.2M8.5 8.5h.2M11.5 8.5h.2M14.5 8.5h.2M6.5 11.5h7',
  lock: 'M5.5 9h9v7.5h-9ZM7.5 9V6.5a2.5 2.5 0 0 1 5 0V9',
  history: 'M3.5 10a6.5 6.5 0 1 0 1.9-4.6M3.5 3.5v3.5H7M10 6.5V10l2.5 2',
  refresh: 'M16.5 10a6.5 6.5 0 1 1-1.9-4.6M16.5 3.5v3.5H13',
  bolt: 'M11 2.5 4.5 11H10l-1 6.5L15.5 9H10l1-6.5Z',
} as const;
export type IconName = keyof typeof P;

const SVG = 'http://www.w3.org/2000/svg';
/** Returns an SVG icon element. */
export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', size >= 20 ? '1.25' : '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', P[name]);
  svg.appendChild(p);
  return svg;
}

/** Runs `fn` at most once per animation frame. */
export function rafThrottle<A extends unknown[]>(fn: (...a: A) => void): (...a: A) => void {
  let queued = false;
  let last: A;
  return (...a: A) => {
    last = a;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...last);
    });
  };
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { cancel(): void } {
  let t: ReturnType<typeof setTimeout> | undefined;
  const d = (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

/** Plural helper: n('label', 3) -> "3 labels". */
export const plural = (n: number, one: string, many = one + 's'): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;
