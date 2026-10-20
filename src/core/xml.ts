// XML helpers for editing labels inside formxml / sitemapxml / RibbonDiffXml.
// Every edit (adding, changing or removing a language's label) is checked with `assertOnlyChanged`:
// the document before and after the edit must be identical once the label elements being edited are
// ignored. If anything else changed, the save is aborted before it reaches the server.

export function parseXml(xml: string, what = 'XML'): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`The ${what} returned by Dataverse could not be read.`);
  return doc;
}

export function serializeXml(doc: Document): string {
  return new XMLSerializer().serializeToString(doc);
}

/** Lower-cases a GUID and removes braces, for comparing ids written in different styles. */
export const normId = (s: string | null | undefined): string => String(s ?? '').replace(/[{}]/g, '').trim().toLowerCase();

/** Direct child elements with the given tag name (case-sensitive). */
export const kids = (el: Element, tag: string): Element[] => Array.from(el.children).filter((c) => c.tagName === tag);
export const kid = (el: Element, tag: string): Element | undefined => Array.from(el.children).find((c) => c.tagName === tag);

/**
 * Canonical text of a document for comparison: attributes sorted, whitespace-only text dropped,
 * elements for which `skip` returns true left out, and containers left empty (no attributes, no
 * children) by that removal left out as well.
 */
export function canon(node: Element, skip: (el: Element) => boolean): string {
  let out = '';
  const walk = (el: Element): string => {
    if (skip(el)) return '';
    let inner = '';
    let hadChildren = false;
    for (const c of Array.from(el.childNodes)) {
      if (c.nodeType === 1) {
        hadChildren = true;
        inner += walk(c as Element);
      } else if (c.nodeType === 3 || c.nodeType === 4) {
        const t = (c.nodeValue || '').trim();
        if (t) inner += t.replace(/[<&]/g, (m) => (m === '<' ? '&lt;' : '&amp;'));
      }
    }
    const attrs = Array.from(el.attributes)
      .map((a) => `${a.name}="${a.value}"`)
      .sort()
      .join(' ');
    if (hadChildren && !inner && !attrs) return '';
    return `<${el.tagName}${attrs ? ' ' + attrs : ''}>${inner}</${el.tagName}>`;
  };
  out = walk(node);
  return out;
}

/** Throws when `after` differs from `before` anywhere outside elements matched by `skip`. */
export function assertOnlyChanged(before: Document, after: Document, skip: (el: Element) => boolean): void {
  const a = canon(before.documentElement, skip);
  const b = canon(after.documentElement, skip);
  if (a !== b) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    console.warn('[translator] safety check diff near:', a.slice(Math.max(0, i - 120), i + 120), '\n---\n', b.slice(Math.max(0, i - 120), i + 120));
    throw new Error('Safety check failed: the change would have modified more than the translated labels, so nothing was saved.');
  }
}

/**
 * Upserts a language entry inside a label container, e.g.
 *   form:    <labels><label description="..." languagecode="1036"/></labels>
 *   sitemap: <Titles><Title LCID="1036" Title="..."/></Titles>
 *   ribbon:  <Titles><Title description="..." languagecode="1036"/></Titles>
 * The container is created as the first child of `owner` when missing. Other languages are never touched.
 */
export function upsertLabel(
  doc: Document,
  owner: Element,
  o: { container: string; item: string; lcidAttr: string; textAttr: string; lcid: number; text: string; insertBefore?: Element | null },
): void {
  let box = kid(owner, o.container);
  if (!box) {
    box = doc.createElement(o.container);
    owner.insertBefore(box, o.insertBefore !== undefined ? o.insertBefore : owner.firstElementChild);
  }
  let item = kids(box, o.item).find((x) => x.getAttribute(o.lcidAttr) === String(o.lcid));
  if (!item) {
    item = doc.createElement(o.item);
    // Attribute order mirrors what Dataverse writes.
    if (o.container === 'labels') {
      item.setAttribute(o.textAttr, o.text);
      item.setAttribute(o.lcidAttr, String(o.lcid));
    } else {
      item.setAttribute(o.lcidAttr, String(o.lcid));
      item.setAttribute(o.textAttr, o.text);
    }
    box.appendChild(item);
  } else {
    item.setAttribute(o.textAttr, o.text);
  }
}

/**
 * Removes one language's entry from a label container: the counterpart of upsertLabel, used when a
 * translation is cleared so that language falls back to the base text. Every entry of that language goes
 * (a duplicate left behind would keep the translation alive). The container stays, even when it ends up
 * empty; callers decide whether an empty container means something. Returns whether anything was removed.
 */
export function removeLabel(owner: Element, o: { container: string; item: string; lcidAttr: string; lcid: number }): boolean {
  const box = kid(owner, o.container);
  if (!box) return false;
  const hits = kids(box, o.item).filter((x) => x.getAttribute(o.lcidAttr) === String(o.lcid));
  for (const x of hits) {
    // Drop the indentation in front of the entry too, so a pretty-printed document stays tidy.
    const ws = x.previousSibling;
    if (ws && ws.nodeType === 3 && !(ws.nodeValue || '').trim()) box.removeChild(ws);
    box.removeChild(x);
  }
  return hits.length > 0;
}

/** Reads all languages of a label container into { lcid: text }. */
export function readLabels(owner: Element, container: string, item: string, lcidAttr: string, textAttr: string): Record<number, string> {
  const out: Record<number, string> = {};
  const box = kid(owner, container);
  if (!box) return out;
  for (const l of kids(box, item)) {
    const lcid = Number(l.getAttribute(lcidAttr));
    if (lcid) out[lcid] = l.getAttribute(textAttr) ?? '';
  }
  return out;
}

/**
 * Labels as loaders hand them to the UI: a language stored as '' counts as missing (it is left out), the
 * same as a language with no label at all (ARCHITECTURE §4, "Clearing a translation").
 */
export function presentLabels(labels: Record<number, string>): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [lcid, text] of Object.entries(labels)) if (text !== '') out[Number(lcid)] = text;
  return out;
}

/**
 * For conflict checks: a missing label, '' and only spaces all mean "no text in that language". The store
 * keeps '' for a cleared or blank label while a document may hold no element, an empty one or spaces.
 */
export const blank = (s: string | undefined): string => (s && s.trim() ? s : '');

/** Escapes text for an XML attribute value written by hand (string splicing). */
export const xmlAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\r/g, '&#xD;').replace(/\n/g, '&#xA;').replace(/\t/g, '&#x9;');
