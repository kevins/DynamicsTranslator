// Unit tests for what a form save posts (providers/formxml.ts): on a main form a column's cell carries only the languages
// the save changes and no labels where it changes none (LIVE-FINDINGS 103, 104), the safety check of such a write
// (assertSent), and the check after it, which writes back a label Dataverse dropped (nothingElse); an emptied field label
// saved as 1.0.0 saves it, through the real saver, and its Undo; the check after publishing and Publish again (LIVE-FINDINGS
// 117, 118). They run on formFake, a form on a fake Dataverse that keeps a column cell's labels per label key the way the
// test org does; the form tests of docwrites.ts and docrace.ts run on it too. register() is called by tools/dev/unit.ts.
import { columnCell } from '../../../src/core/column';
import { addHistory, readHistory } from '../../../src/core/history';
import { DvError, isAbort, turnedAway, type BatchPart, type PartResult } from '../../../src/core/http';
import { isLockError } from '../../../src/core/publish';
import { becomes, placeholderOf } from '../../../src/ui/callout';
import { lcidName } from '../../../src/core/lcid';
import { behindText, droppedBack, droppedLeft, PublishSet, type Change, type ChangeResult, type Lcid, type Slot } from '../../../src/core/model';
import { createSaver } from '../../../src/core/saver';
import { Store } from '../../../src/core/store';
import { canon, kid, kids, normId, parseXml, readLabels, removeLabel, serializeXml, upsertLabel } from '../../../src/core/xml';
import { assertSent, carryOwnLabels, formXmlWriter, knownOwnLabels, loadFormXml, MARK, postable, rewrite } from '../../../src/providers/formxml';
import { RACE_THEIRS, raceText } from '../../../src/providers/repair';
import { CHANGED, changeId, type SaveOptions, type Writer } from '../../../src/providers/types';
import { checkRepaired, keepOwnLabels, publishAgain, unpublishedForms } from '../../../src/ui/review';
import type { AppApi, HistoryEntry } from '../../../src/ui/types';
import type { Kit } from './kit';
import { fast } from './lang';

const EN = 1033;
const FR = 1036;
const DE = 1031;
const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
/** The form every fake holds (docwrites.ts and docrace.ts use the same id). */
export const FORM = '5e07410a-0000-4000-8000-000000000071';
const SUBGRID = 'e7a81278-8635-4d9e-8d4d-59480b391c5b';

// ---- the fake ----

/** A form on a fake Dataverse, as formFake() builds it: what a test reads, sets or arms. */
export interface FormFake {
  /** The unpublished form as RetrieveUnpublished answers it in `ui`: column cells' labels composed (stored, else filled in). Set: someone saves this whole XML (a designer save: F2 applies, the version moves on). */
  xml: string;
  ui: Lcid;
  /** Unpublished and published versionnumber, published etag (If-Match is compared with it, LIVE-FINDINGS 22). */
  v: number;
  vpub: number;
  etag: string;
  /** Label rows by key (normId of labelid, else of id) → language → text. Orphans stay. */
  rows: Map<string, Map<Lcid, string>>;
  /** Column names by datafieldname, latest unpublished (rename()). */
  cols: Map<string, Record<number, string>>;
  /** What a read fills in where a column has no name in a language: nothing, or its base name (the default, as core/model.ts columnNames takes a read to fill it in, LIVE-FINDINGS 42). */
  noName: 'none' | 'base';
  /** Every batch as "METHOD path" parts; every formxml a PATCH that ran posted, as sent. */
  batches: string[][];
  patches: string[];
  /** Once, when a batch that writes arrives, before its parts (docwrites' name). */
  between?: () => void;
  /** Once, at a moment of a write batch: 'batch', 'patch' (right before the PATCH), 'back' (right after it); 'read': when a batch that only reads arrives. */
  at: Record<string, (() => void) | undefined>;
  /** The next write batch's probe answers this status, or this older copy (a read that lags). */
  probe?: number;
  stale?: { xml: string; ver: number };
  /** Rewrites the definition every RetrieveUnpublished part answers with: one the fake can't compose (a column cell's language twice, a label without a language). */
  raw?: (xml: string) => string;
  /** The form comes from a managed solution (`ismanaged`); it has no unpublished definition (RetrieveUnpublished answers 404, the published read gives the form: the loader's published fallback). */
  managed?: boolean;
  published?: boolean;
  /** The next batches that write run, then their answer is lost; the status every PATCH part gets (0: runs, no answer; 403, 412 refuse it; 429 turns it away unrun). */
  lose: number;
  patch?: number;
  /** Dataverse breaking the keep rule: a PATCH drops the rows a column cell's key holds in each language the cell leaves out, every one for a cell posted without labels (true: every cell; a set: these keys). */
  violate: boolean | Set<string>;
  /** Label rows (`${key}#${lcid}`) and column names (`${datafieldname}#${lcid}`) the next publish leaves out: from then on they are `stuck`. */
  stick: Set<string>;
  /**
   * Label rows no publish takes until a PATCH stores another text in them (LIVE-FINDINGS 117), the versions equal all the
   * same; column names no publish takes until a rename stores another name (118).
   */
  stuck: Set<string>;
}

/** The LangSession hold stand-in (core/langsession.ts LangHold): a batch runs its parts in its language, one after another. */
export interface FormHold {
  batch(L: Lcid, parts: BatchPart[], signal?: AbortSignal): Promise<{ inLang: boolean; results: PartResult[] }>;
  window<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Where Dataverse keeps an element's labels (LIVE-FINDINGS 102-104): a column's cell per label key ('key'); a tab, a
 * section and a cell whose control is bound to no column per UI language ('ui'); a sub-grid's and a quick view's cell
 * in the definition itself, as posted (null, as navigation titles). How a quick view's are kept is not verified live
 * (102 has them in every language, as a column's cell's): as posted is the stricter model for a label a write leaves
 * out, and no write leaves one out (a quick view cell goes out as read), so no test relies on it.
 */
function keptBy(el: Element): 'key' | 'ui' | null {
  if (el.tagName === 'tab' || el.tagName === 'section') return 'ui';
  const ctl = el.tagName === 'cell' ? kid(el, 'control') : undefined;
  if (!ctl) return null;
  const df = ctl.getAttribute('datafieldname');
  if (columnCell({ datafield: df, controlId: ctl.getAttribute('id') })) return 'key';
  return df || normId(ctl.getAttribute('classid')) === SUBGRID ? null : 'ui';
}
/** The elements of a form whose labels are kept apart from its definition. */
const keptIn = (d: Document): Array<[Element, 'key' | 'ui']> =>
  ['tab', 'section', 'cell'].flatMap((tag) =>
    Array.from(d.getElementsByTagName(tag)).flatMap((el): Array<[Element, 'key' | 'ui']> => {
      const by = keptBy(el);
      return by ? [[el, by]] : [];
    }),
  );
/** A cell's label key (LIVE-FINDINGS 104): its labelid, else its id. */
const keyOf = (el: Element) => normId(el.getAttribute('labelid')) || normId(el.getAttribute('id'));
/** Where an element's labels kept per UI language are. */
const uiOf = (el: Element) => `${el.tagName}|${normId(el.getAttribute('id'))}`;
/** A cell's column: its control's datafieldname, lower-cased. */
const dfOf = (el: Element) => (kid(el, 'control')?.getAttribute('datafieldname') || '').toLowerCase();
/** Puts one language's text into labels kept apart, by key or by element. */
const into = (m: Map<string, Map<Lcid, string>>, k: string, l: Lcid, t: string) => void (m.get(k) ?? m.set(k, new Map()).get(k)!).set(l, t);

/** A cell of a document by its id, braces and case aside. */
export const cellOf = (d: Document, id: string): Element | undefined => Array.from(d.getElementsByTagName('cell')).find((c) => normId(c.getAttribute('id')) === id);
/** Sets one language's label of a cell (someone else's edit of a document as read). */
export const relabel = (d: Document, id: string, l: Lcid, text: string) =>
  upsertLabel(d, cellOf(d, id)!, { container: 'labels', item: 'label', lcidAttr: 'languagecode', textAttr: 'description', lcid: l, text });
/** Adds a tab with an English label (another maker's change in the designer). */
export const addTab = (d: Document, id: string, name: string, en: string) => {
  const tab = d.createElement('tab');
  tab.setAttribute('id', `{${id}}`);
  tab.setAttribute('name', name);
  upsertLabel(d, tab, { container: 'labels', item: 'label', lcidAttr: 'languagecode', textAttr: 'description', lcid: EN, text: en });
  d.getElementsByTagName('tabs')[0].appendChild(tab);
};

/**
 * A form on a fake Dataverse that keeps labels the way LIVE-FINDINGS 103-105 say: a column cell's per label key, a
 * read filling in the column's name where the key holds none (in every language, an unpublished rename included); a tab's,
 * a section's and an unbound cell's per UI language; the rest in the definition, as posted. The labels of `xml` are
 * stored as they are. A batch runs its parts in its own language, as LangSession switches around them (LIVE-FINDINGS 49),
 * and goes on after a part that failed (continue-on-error). Kinder than Dataverse where no test needs otherwise: the
 * read-back part of a write batch always answers, at once and up to date (LIVE-FINDINGS 66 saw read-backs answer the
 * form as it was before the write), and every RetrieveUnpublished part answers every field whatever its $select (the
 * writer's read-back selects only formxml). A publish (publish()) makes the form as stored the published one (pubXml()),
 * but for the label rows `stick` and `stuck` hold back, as the large form of LIVE-FINDINGS 117 did, and the columns' names
 * the ones a metadata read serves (pubCol()), but for those they hold back, as on the table of 118.
 */
export function formFake(
  xml: string,
  o: { langs?: Lcid[]; ui?: Lcid; type?: number; cols?: Record<string, Record<number, string>> } = {},
): {
  F: FormFake;
  rename(df: string, l: Lcid, text: string): void;
  /** The modern form designer: reads as RetrieveUnpublished in `ui`, applies `edit`, PATCHes the whole form as read (LIVE-FINDINGS 109). */
  designerSave(edit?: (doc: Document) => void): void;
  /** A cell's labels as a read in `ui` shows them; the rows under its key now; its key. */
  label(cellId: string): Record<number, string>;
  own(cellId: string): Record<number, string>;
  key(cellId: string): string;
  /** PublishXml: the definition and its column cells' label rows become the published form's, and the columns' names the served ones, but those `stick` and `stuck` hold; both versions equal, a newer one. */
  publish(): void;
  /** The published form as `GET systemforms(id)?$select=formxml` answers it in UI language `L` (LIVE-FINDINGS 52): its column cells only, each with its published label in `L`, else its column's name filled in. */
  pubXml(L: Lcid): string;
  /** A column's names as a metadata read serves them: the published ones. */
  pubCol(df: string): Record<number, string>;
  /** The LangSession hold stand-in, the lang stand-in and a ctx. */
  h: FormHold;
  lang: never;
  ctx: never;
} {
  const langs = o.langs ?? [EN, FR];
  const base = langs[0];
  /** Labels kept per UI language, by element (uiOf) → language → text. */
  const per = new Map<string, Map<Lcid, string>>();
  /** The definition as stored: the labels kept apart emptied, their <labels> kept as positions. */
  let skel = '';
  /** The published form: its definition, and its column cells' label rows by key (publish()). */
  let pubSkel = '';
  const pubRows = new Map<string, Map<Lcid, string>>();
  /** The columns' names a metadata read serves, by datafieldname (publish()). */
  const pubCols = new Map<string, Record<number, string>>();
  const F: FormFake = {
    get xml() {
      return read(F.ui);
    },
    set xml(x: string) {
      saved(x);
    },
    ui: o.ui ?? base,
    v: 7,
    vpub: 7,
    etag: 'W/"100"',
    rows: new Map(),
    cols: new Map(Object.entries(o.cols ?? {}).map(([k, v]) => [k.toLowerCase(), { ...v }])),
    noName: 'base',
    batches: [],
    patches: [],
    at: {},
    lose: 0,
    violate: false,
    stick: new Set(),
    stuck: new Set(),
  };
  /** What a read fills in for a column in `l` where its cell's key holds no label there (LIVE-FINDINGS 42, 103). */
  const fill = (df: string, l: Lcid): string | undefined => {
    const c = F.cols.get(df);
    return c?.[l] || (F.noName === 'base' ? c?.[base] : undefined) || undefined;
  };
  /** The form as RetrieveUnpublished answers it in UI language `L`. */
  const read = (L: Lcid): string => {
    const d = parseXml(skel);
    for (const [el, by] of keptIn(d)) {
      let ls: Array<[Lcid, string]>;
      if (by === 'key') {
        const row = F.rows.get(keyOf(el));
        ls = langs.flatMap((l): Array<[Lcid, string]> => {
          const t = row?.get(l) ?? fill(dfOf(el), l);
          return t ? [[l, t]] : [];
        });
      } else {
        // The reading language's label, else the base language's, flagged as such (LIVE-FINDINGS 102).
        const s = per.get(uiOf(el));
        const t = s?.get(L);
        const b = s?.get(base);
        ls = t ? [[L, t]] : b ? [[base, b]] : [];
      }
      let box = kid(el, 'labels');
      if (!box && !ls.length) continue;
      // A cell posted without <labels> gets them back as its first child, where Dataverse puts them.
      if (!box) box = el.insertBefore(d.createElement('labels'), el.firstChild);
      for (const [l, t] of ls) {
        const x = d.createElement('label');
        x.setAttribute('description', t);
        x.setAttribute('languagecode', String(l));
        box.appendChild(x);
      }
    }
    // Labels as Dataverse writes them, `<label description="…" languagecode="…" />`: the tests' patterns read that.
    return serializeXml(d).replace(/<label ([^>]*?)\s*\/>/g, '<label $1 />');
  };
  const ok = (data: unknown = null, status = 200): PartResult => ({ ok: true, status, data, headers: {} });
  const fail = (status: number, error: string): PartResult => ({ ok: false, status, data: null, error, headers: {} });
  /** A form PATCH as Dataverse applies it in UI language `L`: null once stored, else the part's refusal. */
  const store = (formxml: string, L: Lcid): PartResult | null => {
    const d = parseXml(formxml);
    const els = keptIn(d);
    const cells = els.filter(([, by]) => by === 'key').map(([el]) => el);
    // A column cell's <label> without its text is refused, nothing stored (LIVE-FINDINGS 104).
    const textless = (el: Element) => {
      const box = kid(el, 'labels');
      return !!box && kids(box, 'label').some((x) => !x.hasAttribute('description'));
    };
    if (cells.some(textless)) return fail(400, "A label's 'description' attribute is missing.");
    // The keep rule, per label key (LIVE-FINDINGS 104): a key holding no label stores only texts other than its column's
    // name as a read fills it in, case-sensitively; one holding any stores every text posted. A language left out, '',
    // <labels/> or no <labels> keeps what is stored.
    const had = new Map(cells.map((el) => [keyOf(el), (F.rows.get(keyOf(el))?.size ?? 0) > 0] as const));
    for (const el of cells) {
      const key = keyOf(el);
      const box = kid(el, 'labels');
      const posted = box ? kids(box, 'label') : [];
      // Dataverse breaking the keep rule (`violate`): the languages the cell leaves out are dropped.
      const row = F.rows.get(key);
      if (row && (F.violate === true || (F.violate instanceof Set && F.violate.has(key)))) {
        const sent = posted.filter((x) => x.getAttribute('description')).map((x) => Number(x.getAttribute('languagecode')));
        for (const l of [...row.keys()]) if (!sent.includes(l)) row.delete(l);
      }
      for (const x of posted) {
        const l = Number(x.getAttribute('languagecode'));
        const t = x.getAttribute('description') ?? '';
        if (!l || !t || (!had.get(key) && t === fill(dfOf(el), l))) continue;
        // Another text stored frees a row no publish took (LIVE-FINDINGS 117).
        if (F.rows.get(key)?.get(l) !== t) F.stuck.delete(`${key}#${l}`);
        into(F.rows, key, l, t);
      }
    }
    // A label kept per UI language: only the one in the language the PATCH runs in, and never emptied (LIVE-FINDINGS 37).
    for (const [el, by] of els) {
      const box = by === 'ui' ? kid(el, 'labels') : undefined;
      const t = box && kids(box, 'label').find((x) => Number(x.getAttribute('languagecode')) === L)?.getAttribute('description');
      if (t) into(per, uiOf(el), L, t);
    }
    // The definition keeps the rest as posted (a navigation title left out is gone, LIVE-FINDINGS 38).
    for (const [el] of els) {
      const box = kid(el, 'labels');
      if (box) while (box.firstChild) box.removeChild(box.firstChild);
    }
    skel = serializeXml(d);
    F.v++;
    return null;
  };
  /** Someone else saves this whole XML: no If-Match, the keep rule as for any PATCH. */
  const saved = (x: string) => {
    const no = store(x, F.ui);
    if (no) throw new Error(no.error);
  };
  // The labels of the XML given are stored as they are: a column cell's under its key, the others per UI language.
  {
    const d = parseXml(xml);
    for (const [el, by] of keptIn(d)) {
      const box = kid(el, 'labels');
      if (!box) continue;
      for (const [l, t] of Object.entries(readLabels(el, 'labels', 'label', 'languagecode', 'description'))) if (t) into(by === 'key' ? F.rows : per, by === 'key' ? keyOf(el) : uiOf(el), Number(l), t);
      while (box.firstChild) box.removeChild(box.firstChild);
    }
    skel = serializeXml(d);
  }
  // Published as given.
  const publish = () => {
    for (const s of F.stick) F.stuck.add(s);
    F.stick.clear();
    pubSkel = skel;
    for (const [k, row] of F.rows) for (const [l, t] of row) if (!F.stuck.has(`${k}#${l}`)) into(pubRows, k, l, t);
    for (const [df, names] of F.cols) for (const [l, t] of Object.entries(names)) if (!F.stuck.has(`${df}#${l}`)) (pubCols.get(df) ?? pubCols.set(df, {}).get(df)!)[Number(l)] = t;
  };
  publish();
  const fire = (k: string) => {
    const f = F.at[k];
    F.at[k] = undefined;
    f?.();
  };
  const exec = (p: BatchPart, L: Lcid): PartResult => {
    const row = () => ({ formid: FORM, formxml: F.raw ? F.raw(read(L)) : read(L), name: 'Information', type: o.type ?? 2, objecttypecode: 'account', ismanaged: !!F.managed, iscustomizable: { Value: true } });
    if (p.method === 'GET' && p.url.startsWith(`systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`))
      return F.published ? fail(404, 'The form has no unpublished definition.') : ok({ ...row(), versionnumber: F.v });
    if (p.method === 'GET' && p.url.startsWith(`systemforms(${FORM})?`)) return ok({ ...(F.published ? row() : { formid: FORM }), versionnumber: F.vpub, '@odata.etag': F.etag });
    if (p.method === 'PATCH' && p.url === `systemforms(${FORM})`) {
      if (F.patch === 403) return fail(403, 'You do not have permission to do this.');
      if (F.patch === 429) return fail(429, 'Rate limit exceeded.');
      if (F.patch === 412 || p.headers?.['If-Match'] !== F.etag) return fail(412, 'The version of the existing record does not match.');
      const formxml = (p.body as { formxml: string }).formxml;
      const no = store(formxml, L);
      if (no) return no;
      F.patches.push(formxml);
      return F.patch === 0 ? fail(0, 'Dataverse sent no answer for this part of the request.') : ok(null, 204);
    }
    return fail(404, 'Resource not found for the segment.');
  };
  const h: FormHold = {
    async batch(L, parts) {
      await new Promise((r) => setTimeout(r, 0));
      F.batches.push(parts.map((p) => `${p.method} ${p.url.split('?')[0]}`));
      const writes = parts.some((p) => p.method === 'PATCH');
      if (writes) {
        const b = F.between;
        F.between = undefined;
        b?.();
        fire('batch');
      } else fire('read');
      const results = parts.map((p, i) => {
        if (writes && p.method === 'PATCH') fire('patch');
        if (writes && i === 0 && F.probe !== undefined) {
          const status = F.probe;
          F.probe = undefined;
          return fail(status, 'The probe failed.');
        }
        if (writes && i === 0 && F.stale) {
          const old = F.stale;
          F.stale = undefined;
          return ok({ formxml: old.xml, versionnumber: old.ver });
        }
        const r = exec(p, L);
        if (writes && p.method === 'PATCH') fire('back');
        return r;
      });
      if (writes && F.lose > 0) {
        F.lose--;
        throw new DvError('Could not reach Dataverse (network error).', 0, 'network');
      }
      return { inLang: true, results };
    },
    window: (fn) => fn(),
  };
  const lang = { hold: <T>(fn: (x: FormHold) => Promise<T>) => fn(h), run: <T>(_l: Lcid, fn: () => Promise<T>) => fn(), quiet: <T>(fn: () => Promise<T>) => fn(), restore: async () => {} };
  const ctx = {
    http: { all: async () => [] },
    xrm: null,
    origin: 'https://org.test',
    org: 'org',
    orgId: 'formlabels',
    envType: '',
    userId: 'u',
    base,
    user: F.ui,
    langs: langs.map((l) => ({ lcid: l, name: lcidName(l), isBase: l === base })),
    version: '9.2',
  };
  const stored = (id: string) => cellOf(parseXml(skel), id);
  return {
    F,
    rename: (df, l, text) => {
      const names = F.cols.get(df) ?? F.cols.set(df, {}).get(df)!;
      // Another name stored frees one no publish took (LIVE-FINDINGS 118).
      if (names[l] !== text) F.stuck.delete(`${df}#${l}`);
      names[l] = text;
    },
    designerSave: (edit) => {
      const d = parseXml(read(F.ui));
      edit?.(d);
      saved(serializeXml(d));
    },
    label: (id) => {
      const c = cellOf(parseXml(read(F.ui)), id);
      return c ? readLabels(c, 'labels', 'label', 'languagecode', 'description') : {};
    },
    own: (id) => {
      const c = stored(id);
      return c ? Object.fromEntries(F.rows.get(keyOf(c)) ?? []) : {};
    },
    key: (id) => {
      const c = stored(id);
      return c ? keyOf(c) : '';
    },
    publish: () => {
      publish();
      F.vpub = ++F.v;
    },
    pubXml: (L) => {
      const d = parseXml(pubSkel);
      for (const [el, by] of keptIn(d)) {
        const t = by === 'key' ? (pubRows.get(keyOf(el))?.get(L) ?? fill(dfOf(el), L)) : undefined;
        if (!t) continue;
        const x = d.createElement('label');
        x.setAttribute('description', t);
        x.setAttribute('languagecode', String(L));
        (kid(el, 'labels') ?? el.insertBefore(d.createElement('labels'), el.firstChild)).appendChild(x);
      }
      return serializeXml(d);
    },
    pubCol: (df) => ({ ...pubCols.get(df) }),
    h,
    lang: lang as never,
    ctx: ctx as never,
  };
}

// ---- a main form: two fields with labels of their own, one with English only, one following its column, and the rest ----

const L = (l: Lcid, t: string) => `<label description="${t}" languagecode="${l}" />`;
const row = (id: string, ctl: string, labels: string) => `<row><cell id="{${id}}"><labels>${labels}</labels><control ${ctl} /></cell></row>`;
const MAIN =
  `<form><tabs><tab id="{a1}" name="general"><labels>${L(EN, 'General')}${L(FR, 'Général')}</labels><columns><column width="100%"><sections>` +
  `<section id="{b1}" name="details"><labels>${L(EN, 'Details')}</labels><rows>` +
  row('c1', 'id="name" datafieldname="name"', L(EN, 'Name') + L(FR, 'Nom')) +
  row('c2', 'id="emailaddress1" datafieldname="emailaddress1"', L(EN, 'E-mail') + L(FR, 'Adresse e-mail')) +
  row('c3', 'id="telephone1" datafieldname="telephone1"', L(EN, 'Business phone')) +
  row('c7', 'id="fax" datafieldname="fax"', '') +
  row('c4', 'id="contacts" classid="{E7A81278-8635-4D9E-8D4D-59480B391C5B}"', L(EN, 'Contacts') + L(FR, 'Contacts liés')) +
  row('c5', 'id="notescontrol" classid="{06375649-C143-495E-A496-C962E5B4488E}"', L(EN, 'Timeline')) +
  row('c6', 'id="parent_details" datafieldname="parentaccountid" classid="{5C5600E0-1D6E-4205-A272-BE80DA87FD42}"', L(EN, 'Parent account') + L(FR, 'Compte parent')) +
  `</rows></section></sections></column></columns>` +
  `<tabfooter><rows>${row('t1', 'id="creditlimit" datafieldname="creditlimit"', L(EN, 'Credit limit') + L(FR, 'Limite de crédit'))}</rows></tabfooter></tab></tabs>` +
  `<header><rows>${row('h1', 'id="header_ownerid" datafieldname="ownerid"', L(EN, 'Owner'))}</rows></header>` +
  `<footer><rows>${row('f1', 'id="footer_statuscode" datafieldname="statuscode"', L(EN, 'Status') + L(FR, 'Statut'))}</rows></footer>` +
  `<Navigation><NavBar><NavBarByRelationshipItem Id="nav_contacts" RelationshipName="contact_customer_accounts"><Titles><Title LCID="1033" Text="Contacts" /><Title LCID="1036" Text="Contacts (FR)" /></Titles></NavBarByRelationshipItem></NavBar></Navigation></form>`;
/** The column cells of MAIN's body and header: the ones a main form's write posts only with what it changes (SPARSE). Its footer's (f1) and its tab footer's (t1) go out as read. */
const SPARSE_IDS = ['c1', 'c2', 'c3', 'c7', 'h1'];
/** A dashboard with a column's cell and a sub-grid. */
const DASH =
  `<form><tabs><tab id="{a1}" name="overview"><labels>${L(EN, 'Overview')}</labels><columns><column width="100%"><sections>` +
  `<section id="{b1}" name="main"><labels>${L(EN, 'Main')}</labels><rows>` +
  row('d1', 'id="name" datafieldname="name"', L(EN, 'Name') + L(FR, 'Nom')) +
  row('d2', 'id="accounts" classid="{E7A81278-8635-4D9E-8D4D-59480B391C5B}"', L(EN, 'Accounts')) +
  `</rows></section></sections></column></columns></tab></tabs></form>`;
const COLS: Record<string, Record<number, string>> = {
  name: { [EN]: 'Name', [FR]: 'Nom' },
  emailaddress1: { [EN]: 'Email', [FR]: 'Courriel' },
  telephone1: { [EN]: 'Phone', [FR]: 'Téléphone' },
  fax: { [EN]: 'Fax', [FR]: 'Télécopie' },
  ownerid: { [EN]: 'Owner', [FR]: 'Propriétaire' },
  statuscode: { [EN]: 'Status Reason', [FR]: 'Raison du statut' },
  parentaccountid: { [EN]: 'Parent Account', [FR]: 'Compte parent' },
  creditlimit: { [EN]: 'Credit Limit', [FR]: 'Limite de crédit' },
};

/** The fake's form as the page loads it (loadFormXml): its slots by element id. */
async function slotsOf(f: ReturnType<typeof formFake>, type = 2): Promise<Map<string, Slot>> {
  const slots = await loadFormXml(f.ctx, [{ formId: FORM, entity: 'account', name: 'Information', type }], [EN, FR], { signal: new AbortController().signal, progress() {}, lang: f.lang });
  return new Map(slots.map((s) => [s.ref.elId as string, s]));
}
/** A column of the table as the page loads it (its DisplayName slot), with these names. */
const column = (attr: string, labels: Record<number, string>): Slot => ({
  key: `attribute|account.${attr}|DisplayName`,
  kind: 'attribute',
  prop: 'DisplayName',
  entity: 'account',
  comp: `attribute|account.${attr}`,
  group: `attribute|account.${attr}`,
  title: labels[EN],
  path: ['account'],
  sub: attr,
  labels: { ...labels },
  readOnly: '',
  baseRequired: true,
  max: 0,
  order: 0,
  ref: { entity: 'account', attribute: attr },
});
/** The table's columns as the page loads them (their DisplayName slots): the saver then knows their names (SaveOptions.column). */
const columns = (): Slot[] => Object.entries(COLS).map(([attr, labels]) => column(attr, labels));
/** SaveOptions.column as the saver gives it with the table's columns loaded and none renamed (docrace.ts's form shows two of them). */
export const loaded: NonNullable<SaveOptions['column']> = (_entity, attr) => (COLS[attr] ? { names: { [EN]: [COLS[attr][EN]], [FR]: [COLS[attr][FR]] }, renamed: [] } : undefined);
const ch = (s: Slot, l: Lcid, after: string): Change => ({ slot: s, lcid: l, before: s.labels[l] ?? '', after });
const opts = (f: ReturnType<typeof formFake>, more: Partial<SaveOptions> = {}): SaveOptions => ({ signal: new AbortController().signal, publish: new PublishSet(), progress() {}, force: new Set<string>(), lang: f.lang, allowPublish: true, ...more });
const outcomes = (rs: ChangeResult[]) => rs.map((r) => [r.outcome, r.message ?? '']);
/** What the user is told after a save (SaveOptions.warn), in order. */
export const told = () => {
  const said: Array<[string, string]> = [];
  return { said, warn: (m: string, level: 'warning' | 'notice') => void said.push([level, m]) };
};
/** A cell's labels in a document. */
const labelsIn = (d: Document, id: string) => readLabels(cellOf(d, id)!, 'labels', 'label', 'languagecode', 'description');
/** Each batch as 'read' or 'write'. */
export const kinds = (batches: string[][]) => batches.map((b) => (b.some((p) => p.startsWith('PATCH')) ? 'write' : 'read'));
/** Adds a fax field (a copy of c7's column) with an English label of its own, as the designer adds one: its column's French name filled in. */
const addFax = (d: Document) => void cellOf(d, 'c1')!.parentElement!.parentElement!.appendChild(d.importNode(parseXml(row('c9', 'id="fax1" datafieldname="fax"', L(EN, 'Fax line') + L(FR, 'Télécopie'))).documentElement, true));
/** Sets an element's labels to exactly these ({}: an empty <labels/>; null: no <labels> at all). */
const putLabels = (d: Document, el: Element, ls: Record<number, string> | null) => {
  const old = kid(el, 'labels');
  if (old) el.removeChild(old);
  if (!ls) return;
  const box = el.insertBefore(d.createElement('labels'), el.firstChild);
  for (const [l, t] of Object.entries(ls)) {
    const x = d.createElement('label');
    x.setAttribute('description', t);
    x.setAttribute('languagecode', l);
    box.appendChild(x);
  }
};
/** Sets a cell's labels to exactly these, as putLabels. */
const setLabels = (d: Document, id: string, ls: Record<number, string> | null) => putLabels(d, cellOf(d, id)!, ls);
/** The new label key someone else gives a cell (moveKey). */
export const MOVED = '6a1f0c2e-0000-4000-8000-0000000000a1';
/** Someone else gives a cell a new label key without one language (LIVE-FINDINGS 105), as a solution import can (110): that language then follows the column. */
export const moveKey = (d: Document, id: string, l: Lcid) => {
  cellOf(d, id)!.setAttribute('labelid', `{${MOVED}}`);
  removeLabel(cellOf(d, id)!, { container: 'labels', item: 'label', lcidAttr: 'languagecode', lcid: l });
};
/** The message a call threw ('' for none). */
const thrown = (fn: () => unknown): string => {
  try {
    fn();
    return '';
  } catch (e) {
    return (e as Error).message;
  }
};
/** The write as it was before main forms posted only their changes, and still is outside SPARSE: the read with one label changed in place. */
const inPlace = (xml: string, id: string, l: Lcid, text: string): string => {
  const d = parseXml(xml);
  relabel(d, id, l, text);
  return serializeXml(d);
};

/** Runs `fn` with a working localStorage (the saver's history journal). */
async function withStorage(fn: () => Promise<void>): Promise<void> {
  const g = globalThis as { localStorage?: unknown };
  const had = Object.getOwnPropertyDescriptor(g, 'localStorage');
  const m = new Map<string, string>();
  Object.defineProperty(g, 'localStorage', { configurable: true, value: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } });
  try {
    await fn();
  } finally {
    if (had) Object.defineProperty(g, 'localStorage', had);
    else delete g.localStorage;
  }
}

/** A cell's label key in a posted XML (its labelid; '' for none). */
const keyIn = (xml: string, id: string) => normId(cellOf(parseXml(xml), id)?.getAttribute('labelid'));

/**
 * What the page knows of a main form's field labels once its check behind the loads is in (`ref.own`, LIVE-FINDINGS 114,
 * inspector/pageload.ts): per cell and language, whether its label key holds a label of its own there, as the fake's rows
 * say. On the store's slots now (a form loaded again has none, as on a page loaded again).
 */
function know(f: ReturnType<typeof formFake>, store: Store): void {
  const langs = (f.ctx as unknown as { langs: Array<{ lcid: Lcid }> }).langs.map((x) => x.lcid);
  const own = new Map<string, Record<number, boolean>>();
  for (const s of store.slots.values()) if (s.ref?.sparse) own.set(s.key, Object.fromEntries(langs.map((l) => [l, !!f.F.rows.get(s.ref.labelKey || s.ref.elId)?.has(l)])));
  store.setOwn(own);
}

/**
 * The real saver over the fake form (core/saver.ts createSaver): a Store with the form's slots as the page loads them and
 * the table's columns with the fake's names, formXmlWriter for the form's labels and, for a column's name, a writer on
 * the metadata lane like the real one: its read gives the fake's name, and its save finds the name as asked or compares
 * it with `before` (a conflict otherwise), then renames the column on the fake once `R.when()` resolves (at once by
 * default: a test times the rename against the form's batches, as the lanes run side by side, LIVE-FINDINGS 44); Publish
 * again's repair goes through its save as the real one's does (formxml.ts rewrite). Each PublishXml is kept in
 * `R.posts`. Run inside withStorage (the journal). Which field labels are the form's own is known (know), as the page
 * knows it once its check behind the loads is in.
 */
async function saverRig(f: ReturnType<typeof formFake>, type = 2) {
  const cols = [...f.F.cols].map(([attr, labels]) => column(attr, labels));
  const slots = await slotsOf(f, type);
  const store = new Store();
  store.add([...slots.values(), ...cols]);
  know(f, store);
  const R = { when: (): Promise<unknown> => Promise.resolve(), posts: [] as string[] };
  const attrOf = (c: Change) => String(c.slot.ref.attribute);
  const meta: Writer = {
    kinds: ['attribute'],
    lane: 'metadata',
    read: async (_ctx, cs) => new Map(cs.map((c) => [changeId(c), f.F.cols.get(attrOf(c))?.[c.lcid] ?? ''] as const)),
    async save(_ctx, cs, o) {
      await R.when();
      return cs.map((c): ChangeResult => {
        const now = f.F.cols.get(attrOf(c))?.[c.lcid] ?? '';
        if (now === c.after) return { change: c, outcome: 'unchanged' };
        if (now !== c.before && !o.force.has(changeId(c))) return { change: c, outcome: 'conflict', server: now };
        f.rename(attrOf(c), c.lcid, c.after);
        o.publish.entities.add('account');
        return { change: c, outcome: 'saved' };
      });
    },
    again: (ctx, cs, o, publish) => rewrite(cs, publish, (list) => meta.save(ctx, list, o)),
  };
  (f.ctx as unknown as { http: Record<string, unknown> }).http.post = async (fn: string, body: { ParameterXml?: string }) => void (fn === 'PublishXml' && R.posts.push(body.ParameterXml ?? ''));
  const saver = createSaver(f.ctx, store, f.lang, (k) => (k === 'attribute' ? meta : formXmlWriter.kinds.includes(k) ? formXmlWriter : undefined));
  const opts = { signal: new AbortController().signal, publish: true, onProgress() {} };
  return {
    R,
    store,
    saver,
    /** A label of the form by its element's id, as the store has it; a column's name by the column. */
    cell: (id: string) => store.get(slots.get(id)!.key)!,
    col: (attr: string) => store.get(`attribute|account.${attr}|DisplayName`)!,
    /** Publishes these changes (the staged ones by default), as the Publish dialog does. */
    save: (cs: Change[] = store.changes()) => saver.save(cs, opts),
    /** Undoes a journal entry (the newest by default), as Recent publishes does. */
    undo: (e = readHistory(f.ctx)[0]) => saver.undo(e, opts),
  };
}

/**
 * What the Publish dialog's check, Publish again and keepOwnLabels (ui/review.ts) need of the app, over a saverRig: the
 * forms check reads the fake's versions and its published definition in the user's language, and its columns' names as
 * served (pubCol), PublishXml publishes the fake (each kept in `R.posts`), and the LangSession stand-in counts its quiet()
 * jobs: `q.inQuiet`, the publishes sent inside one.
 */
function reviewApp(f: ReturnType<typeof formFake>, r: Awaited<ReturnType<typeof saverRig>>) {
  const q = { quiet: 0, inQuiet: 0 };
  const http = (f.ctx as unknown as { http: Record<string, unknown> }).http;
  http.post = async (fn: string, body: { ParameterXml?: string }) => {
    if (fn !== 'PublishXml') return;
    r.R.posts.push(body.ParameterXml ?? '');
    if (q.quiet) q.inQuiet++;
    f.publish();
  };
  http.get = async (url: string) => {
    if (url.startsWith(`systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`)) return { versionnumber: f.F.v };
    if (url.startsWith(`systemforms(${FORM})?`)) return { formxml: f.pubXml(f.F.ui), versionnumber: f.F.vpub };
    const col = /^EntityDefinitions\(LogicalName='account'\)\/Attributes\(LogicalName='(\w+)'\)\?\$select=DisplayName,Description$/.exec(url);
    if (col) return { DisplayName: { LocalizedLabels: Object.entries(f.pubCol(col[1])).map(([l, t]) => ({ Label: t, LanguageCode: Number(l) })) }, Description: { LocalizedLabels: [] } };
    throw new DvError('Resource not found for the segment.', 404);
  };
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    q.quiet++;
    try {
      return await fn();
    } finally {
      q.quiet--;
    }
  };
  const app = { ctx: f.ctx, store: r.store, saver: r.saver, lang: { ...(f.lang as object), quiet }, providers: { carryOwnLabels } } as unknown as AppApi;
  return { app, q };
}
/** A cell's English label in the fake's published form, as the forms check reads it. */
const pubText = (f: ReturnType<typeof formFake>, id: string) => labelsIn(parseXml(f.pubXml(EN)), id)[EN];
/** Keeps the answers of which field labels are the form's own (providers/formxml.ts OWN_KEY) in `langs`, as the fake stores them, for its published version. */
const stash = (f: ReturnType<typeof formFake>, langs: Lcid[]) => {
  for (const l of langs) localStorage.setItem(`dxt:own:formlabels:${FORM}:${l}`, JSON.stringify({ v: String(f.F.vpub), k: [...f.F.rows].filter(([, row]) => row.has(l)).map(([k]) => k) }));
};
/** The answer kept for the form in `l` (OWN_KEY): its version and keys, sorted; null for none. */
const keptFor = (l: Lcid): { v: string; k: string[] } | null => {
  const e = JSON.parse(localStorage.getItem(`dxt:own:formlabels:${FORM}:${l}`) || 'null');
  return e && { v: e.v, k: [...e.k].sort() };
};

/**
 * Reads that lag (LIVE-FINDINGS 66): `now(n)` makes the next `n` batches answer their first part (a read, or a write
 * batch's probe) with the form as it was when lagged() was called, at its versionnumber then; `afterWrite(n)` the same,
 * from the first write batch that runs on.
 */
function lagged(f: ReturnType<typeof formFake>) {
  const ui = f.F.ui;
  const old = new Map<Lcid, string>();
  for (const l of [EN, FR]) {
    f.F.ui = l;
    old.set(l, f.F.xml);
  }
  f.F.ui = ui;
  const ver = f.F.v;
  let n = 0;
  let armed: number | null = null;
  const batch = f.h.batch.bind(f.h);
  f.h.batch = async (L, parts, signal) => {
    const res = await batch(L, parts, signal);
    const writes = parts.some((p) => p.method === 'PATCH');
    if (n > 0 && res.results[0]?.ok && typeof res.results[0].data?.formxml === 'string') {
      n--;
      res.results[0] = { ...res.results[0], data: { ...res.results[0].data, formxml: old.get(L), versionnumber: ver } };
    } else if (writes && armed !== null) [n, armed] = [armed, null];
    return res;
  };
  return { now: (k: number) => void (n = k), afterWrite: (k: number) => void (armed = k) };
}

export function register(t: Kit): void {
  t.test("form labels: the fake keeps labels as Dataverse does (LIVE-FINDINGS 103, 104): a column's name filled in on every read, unpublished renames included; a key with nothing stored keeps only texts other than its column's name, case-sensitively; a key holding any label keeps every text posted; a label without its text is refused (400); a language left out keeps its label; a tab's or section's label is read in the UI language, else the base one, and a PATCH stores only the one in its language, never emptying it (37, 102); a key moved keeps its old rows, which dropping the labelid brings back (105); sub-grid labels and navigation titles are kept as posted (38)", async () => {
    const f = formFake(MAIN, { cols: COLS });
    const { F } = f;
    t.eq([f.label('c3'), f.own('c3'), f.label('c7'), f.own('c7')], [{ [EN]: 'Business phone', [FR]: 'Téléphone' }, { [EN]: 'Business phone' }, { [EN]: 'Fax', [FR]: 'Télécopie' }, {}]);
    const v = F.v;
    f.rename('fax', FR, 'Télécopieur');
    t.eq([f.label('c7')[FR], F.v], ['Télécopieur', v], 'an unpublished rename shows at once, the form unchanged');
    /** The form as RetrieveUnpublished answers it in UI language `l`. */
    const readIn = async (l: Lcid): Promise<string> => (await f.h.batch(l, [{ method: 'GET', url: `systemforms(${FORM})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formxml` }])).results[0].data.formxml;
    /** A PATCH built on a read in UI language `l`, as a writer sends it in that language: its status. */
    const patch = async (edit: (d: Document) => void, l: Lcid = EN) => {
      const d = parseXml(await readIn(l));
      edit(d);
      return (await f.h.batch(l, [{ method: 'PATCH', url: `systemforms(${FORM})`, headers: { 'If-Match': F.etag }, body: { formxml: serializeXml(d) } }])).results[0].status;
    };
    t.eq(await patch((d) => setLabels(d, 'c7', { [EN]: 'Fax', [FR]: 'télécopieur' })), 204);
    t.eq([f.own('c7'), f.label('c7')], [{ [FR]: 'télécopieur' }, { [EN]: 'Fax', [FR]: 'télécopieur' }], 'a key with nothing stored: its column name left out, another case kept');
    t.eq(await patch((d) => setLabels(d, 'c3', { [EN]: 'Business phone', [FR]: 'Téléphone' })), 204);
    t.eq(f.own('c3'), { [EN]: 'Business phone', [FR]: 'Téléphone' }, 'a key holding a label: its column name kept too');
    f.rename('telephone1', FR, 'Téléphone 2');
    t.eq(f.label('c3')[FR], 'Téléphone', 'a copy: it no longer follows the column');
    const before = [F.v, f.own('c1'), F.patches.length];
    t.eq(
      await patch((d) => {
        setLabels(d, 'c1', { [EN]: 'Name 2' });
        kid(cellOf(d, 'c1')!, 'labels')!.appendChild(d.createElement('label')).setAttribute('languagecode', String(FR));
      }),
      400,
    );
    t.eq([F.v, f.own('c1'), F.patches.length], before, 'refused whole');
    const kept: Array<[string, Record<number, string> | null]> = [
      ['a language left out', { [EN]: 'Name' }],
      ['an empty text', { [EN]: 'Name', [FR]: '' }],
      ['an empty <labels/>', {}],
      ['no <labels>', null],
    ];
    for (const [what, ls] of kept) {
      t.eq(await patch((d) => setLabels(d, 'c1', ls)), 204, what);
      t.eq(f.own('c1'), { [EN]: 'Name', [FR]: 'Nom' }, what);
    }
    t.ok(F.xml.includes(`<cell id="{c1}"><labels>${L(EN, 'Name')}${L(FR, 'Nom')}</labels>`), 'posted without <labels>, read with them first: ' + F.xml);
    // A label kept per UI language (a tab's, a section's): read in that language, else the base language's, flagged as
    // such (LIVE-FINDINGS 102); a PATCH stores only the one in the language it runs in, and never empties it (37).
    const section = (d: Document) => d.getElementsByTagName('section')[0];
    const sectionIn = async (l: Lcid) => readLabels(section(parseXml(await readIn(l))), 'labels', 'label', 'languagecode', 'description');
    t.eq(await sectionIn(FR), { [EN]: 'Details' }, 'no French: the English label');
    t.eq(await patch((d) => putLabels(d, section(d), { [EN]: 'Details 2', [FR]: 'Détails' }), FR), 204);
    t.eq([await sectionIn(FR), await sectionIn(EN)], [{ [FR]: 'Détails' }, { [EN]: 'Details' }], 'a PATCH in French stores the French only');
    t.eq(await patch((d) => putLabels(d, section(d), {})), 204);
    t.eq(await sectionIn(EN), { [EN]: 'Details' }, 'never emptied');
    // A key moved (a labelid set) leaves the rows under the old one; dropping the labelid brings them back (LIVE-FINDINGS 105).
    t.eq(await patch((d) => (cellOf(d, 'c2')!.setAttribute('labelid', `{${MOVED}}`), setLabels(d, 'c2', { [EN]: 'E-mail 2' }))), 204);
    t.eq(
      [f.key('c2'), f.own('c2'), f.label('c2'), Object.fromEntries(F.rows.get('c2')!)],
      [MOVED, { [EN]: 'E-mail 2' }, { [EN]: 'E-mail 2', [FR]: 'Courriel' }, { [EN]: 'E-mail', [FR]: 'Adresse e-mail' }],
      'the new key holds what was posted; the old rows stay',
    );
    t.eq(await patch((d) => (cellOf(d, 'c2')!.removeAttribute('labelid'), setLabels(d, 'c2', null))), 204);
    t.eq([f.key('c2'), f.label('c2')], ['c2', { [EN]: 'E-mail', [FR]: 'Adresse e-mail' }], 'the labelid dropped: the labels from before');
    // A sub-grid's labels and navigation titles are kept as posted: a title left out is gone (LIVE-FINDINGS 38).
    t.eq(await patch((d) => (setLabels(d, 'c4', { [EN]: 'Contacts 2' }), d.getElementsByTagName('Titles')[0].removeChild(d.getElementsByTagName('Title')[1]))), 204);
    const now = parseXml(F.xml);
    t.eq([labelsIn(now, 'c4'), Array.from(now.getElementsByTagName('Title')).map((x) => x.getAttribute('LCID'))], [{ [EN]: 'Contacts 2' }, ['1033']]);
  });

  t.test('form labels: a main form save posts no labels for the column cells it does not change and only the edited language for the one it edits; tabs, sections, a sub-grid, a timeline, a quick view control and navigation titles go out as read', async () => {
    const f = formFake(MAIN, { cols: COLS });
    const s = await slotsOf(f);
    const read = f.F.xml;
    t.eq(outcomes(await formXmlWriter.save(f.ctx, [ch(s.get('c1')!, FR, 'Nom complet')], opts(f))), [['saved', '']]);
    t.eq(f.F.patches.length, 1);
    const sent = parseXml(f.F.patches[0]);
    const was = parseXml(read);
    t.eq(labelsIn(sent, 'c1'), { [FR]: 'Nom complet' }, 'the edited language only');
    t.eq(SPARSE_IDS.filter((id) => id !== 'c1').map((id) => !!kid(cellOf(sent, id)!, 'labels')), [false, false, false, false], 'no labels for the others');
    for (const id of ['c4', 'c5', 'c6']) t.eq(labelsIn(sent, id), labelsIn(was, id), `${id} as read`);
    const own = (el: Element) => el.tagName === 'labels' && SPARSE_IDS.includes(normId(el.parentElement?.getAttribute('id')));
    t.eq(canon(sent.documentElement, own), canon(was.documentElement, own), 'tabs, sections, navigation titles and the rest as read');
    t.eq(
      [f.label('c1')[FR], f.own('c2'), f.own('c3'), f.own('c7'), f.own('h1')],
      ['Nom complet', { [EN]: 'E-mail', [FR]: 'Adresse e-mail' }, { [EN]: 'Business phone' }, {}, { [EN]: 'Owner' }],
      'every other label as it was: nothing frozen',
    );
  });

  t.test('form labels: after a save of another label, a field with its own English label still follows a French rename; a designer save of the same form freezes it, as Dataverse does (LIVE-FINDINGS 109)', async () => {
    const f = formFake(MAIN, { cols: COLS });
    const s = await slotsOf(f);
    t.eq(outcomes(await formXmlWriter.save(f.ctx, [ch(s.get('c1')!, FR, 'Nom complet')], opts(f))), [['saved', '']]);
    f.rename('telephone1', FR, 'Téléphone 2');
    t.eq([f.label('c3'), f.own('c3')], [{ [EN]: 'Business phone', [FR]: 'Téléphone 2' }, { [EN]: 'Business phone' }], 'still follows');
    f.designerSave();
    f.rename('telephone1', FR, 'Téléphone 3');
    t.eq([f.label('c3')[FR], f.own('c3')], ['Téléphone 2', { [EN]: 'Business phone', [FR]: 'Téléphone 2' }], 'frozen by the designer save');
    f.rename('fax', FR, 'Télécopie 2');
    t.eq([f.label('c7')[FR], f.own('c7')], ['Télécopie 2', {}], 'a field with no label of its own in any language still follows');
  });

  t.test("form labels: a dashboard (never sparse), and a footer cell and a tab footer's cell of a main form, go out as read, as before", async () => {
    const d = formFake(DASH, { type: 0, cols: COLS });
    const ds = await slotsOf(d, 0);
    const dread = d.F.xml;
    t.eq(outcomes(await formXmlWriter.save(d.ctx, [ch(ds.get('d1')!, FR, 'Nom complet')], opts(d))), [['saved', '']]);
    t.eq(d.F.patches, [inPlace(dread, 'd1', FR, 'Nom complet')], 'the dashboard: byte for byte the write before');
    const f = formFake(MAIN, { cols: COLS });
    const s = await slotsOf(f);
    const read = f.F.xml;
    t.eq(outcomes(await formXmlWriter.save(f.ctx, [ch(s.get('f1')!, FR, 'Statut 2')], opts(f))), [['saved', '']]);
    const cell = (xml: string, id: string) => new XMLSerializer().serializeToString(cellOf(parseXml(xml), id)!);
    t.eq(cell(f.F.patches[0], 'f1'), cell(inPlace(read, 'f1', FR, 'Statut 2'), 'f1'), "the footer's cell: as read, its French changed in place");
    // A tab's header and footer are zones of their own, never written without labels live (SPARSE): as read too.
    t.eq([s.get('t1')!.path.at(-1), cell(f.F.patches[0], 't1')], ['Tab footer', cell(read, 't1')], "the tab footer's cell: as read, its labels in place");
    t.eq(!!kid(cellOf(parseXml(f.F.patches[0]), 'c1')!, 'labels'), false, 'the body cells as on any main form save');
  });

  t.test('form labels: the checks refuse a stray label on an untouched column cell, a wrong text, a language posted twice (even with the planned text), a second <labels> on a cell, a dropped sub-grid label or navigation title, a labelid set on a cell, and a column cell left out of the plan; nothing is sent', () => {
    const read = formFake(MAIN, { cols: COLS }).F.xml;
    const before = parseXml(read);
    /** What a save of c1's French builds: c1 with that French only, every other column cell without labels. */
    const built = () => {
      const d = parseXml(read);
      for (const id of SPARSE_IDS) setLabels(d, id, id === 'c1' ? { [FR]: 'Nom complet' } : null);
      return d;
    };
    /** The plan of that save (for the cells `planned`, every column cell by default), and the texts its inputs give (`may`); `anything` leaves the refusal to the plan alone. */
    const check = (after: Document, may: (el: Element, l: Lcid, text: string) => boolean, planned = SPARSE_IDS) => {
      const expect = new Map(planned.map((id) => [cellOf(after, id)!, id === 'c1' ? { [FR]: 'Nom complet' } : null]));
      assertSent(before, after, 2, false, () => false, expect, may);
    };
    const may = (el: Element, l: Lcid, text: string) => normId(el.getAttribute('id')) === 'c1' && l === FR && text === 'Nom complet';
    const anything = () => true;
    t.eq(thrown(() => check(built(), may)), '', 'the right copy passes');
    const spoiled: Array<[string, (d: Document) => void]> = [
      ['a stray label on an untouched column cell', (d) => setLabels(d, 'c2', { [EN]: 'E-mail' })],
      ['a wrong text', (d) => setLabels(d, 'c1', { [FR]: 'Nom complet!' })],
      ['a language posted twice, with the planned text', (d) => void kid(cellOf(d, 'c1')!, 'labels')!.appendChild(d.importNode(parseXml(L(FR, 'Nom complet')).documentElement, true))],
      ['a second <labels> on the edited cell', (d) => void cellOf(d, 'c1')!.appendChild(d.importNode(parseXml(`<labels>${L(EN, 'Name')}</labels>`).documentElement, true))],
      ['a dropped sub-grid label', (d) => void removeLabel(cellOf(d, 'c4')!, { container: 'labels', item: 'label', lcidAttr: 'languagecode', lcid: FR })],
      ['a dropped navigation title', (d) => void d.getElementsByTagName('Titles')[0].removeChild(d.getElementsByTagName('Title')[1])],
      ['a labelid set on a cell', (d) => cellOf(d, 'c2')!.setAttribute('labelid', '{6a1f0c2e-0000-4000-8000-0000000000a1}')],
    ];
    for (const [what, spoil] of spoiled) {
      const d = built();
      spoil(d);
      t.eq([may, anything].map((m) => /^Safety check failed/.test(thrown(() => check(d, m)))), [true, true], what);
    }
    // A column cell the plan has no entry for is refused whatever it carries: here a stray label on the phone field.
    const d = built();
    setLabels(d, 'c3', { [EN]: 'Business phone' });
    t.eq(/^Safety check failed/.test(thrown(() => check(d, anything, SPARSE_IDS.filter((id) => id !== 'c3')))), true, 'a column cell left out of the plan');
  });

  t.test("form labels: the writer checks its own write before sending it: a column cell the read gives a second <labels> (its column's French name in it, which posted would be stored as its label, LIVE-FINDINGS 104) stops the save before its write batch, the change an error, nothing stored", async () => {
    // The phone field (its English its own, its French following its column) with a second <labels> after its control,
    // as Dataverse never sends one: the fake keeps it in the definition as it is.
    const c3 = '<control id="telephone1" datafieldname="telephone1" />';
    const f = formFake(MAIN.replace(c3, c3 + `<labels>${L(EN, 'Business phone')}${L(FR, 'Téléphone')}</labels>`), { cols: COLS });
    const s = await slotsOf(f);
    const n = f.F.batches.length;
    const res = await formXmlWriter.save(f.ctx, [ch(s.get('c1')!, FR, 'Nom complet')], opts(f, { column: loaded }));
    t.eq([res.length, res[0].outcome, /^Safety check failed/.test(res[0].message ?? '')], [1, 'error', true], res[0].message);
    t.eq([kinds(f.F.batches.slice(n)), f.F.patches.length, f.own('c3'), f.label('c1')[FR]], [['read'], 0, { [EN]: 'Business phone' }, 'Nom']);
  });

  t.test('form labels: a column cell the read gives a language twice, or a label without a language, goes out with exactly the labels planned for it, one per language: an edit of it saves, as before, and a field someone else added with such labels is put back', async () => {
    // Dataverse keeps a column cell's labels one per language (LIVE-FINDINGS 104), so the fake composes no such cell: it
    // serves one as it is (`raw`). The name field's French twice and a label without a language.
    {
      const f = formFake(MAIN, { cols: COLS });
      f.F.raw = (x) => x.replace(L(FR, 'Nom'), L(FR, 'Nom') + L(FR, 'Nom') + '<label description="Nom" />');
      const s = await slotsOf(f);
      t.eq(outcomes(await formXmlWriter.save(f.ctx, [ch(s.get('c1')!, FR, 'Nom complet')], opts(f, { column: loaded }))), [['saved', '']]);
      const box = kid(cellOf(parseXml(f.F.patches[0]), 'c1')!, 'labels')!;
      t.eq([kids(box, 'label').length, labelsIn(parseXml(f.F.patches[0]), 'c1'), f.label('c1')], [1, { [FR]: 'Nom complet' }, { [EN]: 'Name', [FR]: 'Nom complet' }]);
    }
    // The fax field someone else added between the read and the PATCH, its English twice: put back from a new read.
    {
      const f = formFake(MAIN, { cols: COLS });
      f.F.raw = (x) => x.replace(L(EN, 'Fax line'), L(EN, 'Fax line') + L(EN, 'Fax line'));
      const s = await slotsOf(f);
      f.F.at.batch = () => f.designerSave(addFax);
      t.eq(outcomes(await formXmlWriter.save(f.ctx, [ch(s.get('c1')!, FR, 'Nom complet')], opts(f, { column: loaded }))), [['saved', '']]);
      const box = kid(cellOf(parseXml(f.F.patches[1]), 'c9')!, 'labels')!;
      t.eq([f.F.patches.length, kids(box, 'label').length, labelsIn(parseXml(f.F.patches[1]), 'c9'), f.own('c9')], [2, 1, { [EN]: 'Fax line' }, { [EN]: 'Fax line' }]);
    }
  });

  t.test("form labels: a field someone else added between the read and the PATCH is put back without its column's name stored as its label; with the column's names not loaded, as read", async () => {
    for (const names of [true, false]) {
      const f = formFake(MAIN, { cols: COLS });
      const s = await slotsOf(f);
      f.F.at.batch = () => f.designerSave(addFax);
      const res = await formXmlWriter.save(f.ctx, [ch(s.get('c1')!, FR, 'Nom complet')], opts(f, names ? { column: loaded } : {}));
      t.eq(outcomes(res), [['saved', '']]);
      t.eq(kinds(f.F.batches.slice(-4)), ['read', 'write', 'read', 'write'], 'put back from a new read');
      t.eq([f.label('c1')[FR], f.label('c9')], ['Nom complet', { [EN]: 'Fax line', [FR]: 'Télécopie' }]);
      if (names) {
        t.eq(labelsIn(parseXml(f.F.patches[1]), 'c9'), { [EN]: 'Fax line' }, "put back without its column's name");
        t.eq(f.own('c9'), { [EN]: 'Fax line' }, 'its French still follows the column');
        f.rename('fax', FR, 'Télécopie 2');
        t.eq(f.label('c9')[FR], 'Télécopie 2');
      } else {
        t.eq(labelsIn(parseXml(f.F.patches[1]), 'c9'), { [EN]: 'Fax line', [FR]: 'Télécopie' }, 'as read');
        t.eq(f.own('c9'), { [EN]: 'Fax line', [FR]: 'Télécopie' }, "its column's name stored as its French label (the key holds a label)");
      }
    }
  });

  t.test("form labels: nothing else moved: a label Dataverse dropped from a cell the save left out (violate), or in a language it left out of a cell it edits, is written back at once, in a write of its own that posts the save's own change there again, and the save says so (a notice); with nothing dropped there is no extra write and no notice", () =>
    withStorage(async () => {
      /** A save of `id`'s French through the saver, the table's columns loaded: its report and its batches. */
      const save = async (f: ReturnType<typeof formFake>, id: string, text: string) => {
        const s = await slotsOf(f);
        const st = new Store();
        st.add([...s.values(), ...columns()]);
        const saver = createSaver(f.ctx, st, f.lang, (k) => (k === 'field' ? formXmlWriter : undefined));
        const n = f.F.batches.length;
        const rep = await saver.save([ch(s.get(id)!, FR, text)], { signal: new AbortController().signal, publish: false, onProgress() {} });
        return { rep, sent: kinds(f.F.batches.slice(n)) };
      };
      for (const drop of [true, false]) {
        const f = formFake(MAIN, { cols: COLS });
        if (drop) f.F.violate = new Set([f.key('c2')]);
        const { rep, sent } = await save(f, 'c1', 'Nom complet');
        t.eq([rep.saved, rep.errors, rep.warning, f.label('c1')[FR]], [1, 0, undefined, 'Nom complet']);
        if (drop) {
          t.eq(rep.notice, droppedBack('Information', 2));
          t.eq(sent, ['read', 'write', 'read', 'write'], 'written back in a write of its own, from a new read');
          t.eq(labelsIn(parseXml(f.F.patches[1]), 'c2'), { [EN]: 'E-mail', [FR]: 'Adresse e-mail' }, 'the dropped labels posted');
          t.eq([f.label('c2'), f.own('c2')], [{ [EN]: 'E-mail', [FR]: 'Adresse e-mail' }, { [EN]: 'E-mail', [FR]: 'Adresse e-mail' }]);
        } else t.eq([rep.notice, sent], [undefined, ['read', 'write']]);
      }
      // The save edits the email field's French, and Dataverse drops its English, which the PATCH left out, and goes on
      // dropping what a write leaves out of that cell: the write-back posts the save's French again with the English.
      const f = formFake(MAIN, { cols: COLS });
      f.F.violate = new Set([f.key('c2')]);
      const { rep, sent } = await save(f, 'c2', 'Adresse 2');
      t.eq([rep.saved, rep.errors, rep.warning, rep.notice, sent], [1, 0, undefined, droppedBack('Information', 1), ['read', 'write', 'read', 'write']]);
      t.eq([labelsIn(parseXml(f.F.patches[0]), 'c2'), labelsIn(parseXml(f.F.patches[1]), 'c2')], [{ [FR]: 'Adresse 2' }, { [EN]: 'E-mail', [FR]: 'Adresse 2' }], 'its French posted, then its English written back with it');
      t.eq([f.label('c2'), f.own('c2')], [{ [EN]: 'E-mail', [FR]: 'Adresse 2' }, { [EN]: 'E-mail', [FR]: 'Adresse 2' }], "the save's French kept");
    }),
  );

  t.test("form labels: a label that changed only because this save renames its column, or whose text was one of its column's names, is never written back; one of that cell in a language the rename leaves alone is checked as any (a label Dataverse dropped there is written back)", () =>
    withStorage(async () => {
      const meta: Writer = { kinds: ['attribute'], lane: 'metadata', save: async (_ctx, cs) => cs.map((c): ChangeResult => ({ change: c, outcome: 'saved' })) };
      /** A save of the name field's French and of the phone column's French name, the rename landing inside the form's write batch. */
      const save = async (f: ReturnType<typeof formFake>, force: boolean) => {
        const s = await slotsOf(f);
        const st = new Store();
        const cols = columns();
        st.add([...s.values(), ...cols]);
        f.F.at.patch = () => f.rename('telephone1', FR, 'Téléphone 2');
        const phone = ch(cols.find((c) => c.sub === 'telephone1')!, FR, 'Téléphone 2');
        const saver = createSaver(f.ctx, st, f.lang, (k) => (k === 'field' ? formXmlWriter : k === 'attribute' ? meta : undefined));
        return saver.save([ch(s.get('c1')!, FR, 'Nom complet'), phone], { signal: new AbortController().signal, publish: false, onProgress() {}, ...(force ? { force: new Set([changeId(phone)]) } : {}) });
      };
      const f = formFake(MAIN, { cols: COLS });
      const rep = await save(f, false);
      t.eq([rep.saved, rep.notice, rep.warning, f.F.patches.length], [2, undefined, undefined, 1]);
      t.eq([f.label('c3')[FR], f.own('c3')], ['Téléphone 2', { [EN]: 'Business phone' }], 'it follows the new name: nothing frozen');
      // Someone else renamed it since the page loaded and this save's rename is kept over theirs: the label showed their
      // name, which the store never saw, so only the rename says it changed on purpose.
      const g = formFake(MAIN, { cols: COLS });
      g.rename('telephone1', FR, 'Téléphone X');
      const rep2 = await save(g, true);
      t.eq([rep2.saved, rep2.notice, rep2.warning, g.F.patches.length, g.own('c3')], [2, undefined, undefined, 1, { [EN]: 'Business phone' }]);
      // The same save while Dataverse drops the phone field's English label of its own: the rename is French only, so
      // the English is checked, and written back.
      const m = formFake(MAIN, { cols: COLS });
      m.F.violate = new Set([m.key('c3')]);
      const rep3 = await save(m, false);
      t.eq([rep3.saved, rep3.notice, rep3.warning, m.F.patches.length], [2, droppedBack('Information', 1), undefined, 2]);
      t.eq([m.label('c3'), m.own('c3')], [{ [EN]: 'Business phone', [FR]: 'Téléphone 2' }, { [EN]: 'Business phone' }], 'its English back, its French still following');
      // Someone else renames it inside the batch: the label showed one of its column's names, so it was nobody's text.
      const k = formFake(MAIN, { cols: COLS });
      const ks = await slotsOf(k);
      k.F.at.patch = () => k.rename('telephone1', FR, 'Téléphone X');
      const b = told();
      const res2 = await formXmlWriter.save(k.ctx, [ch(ks.get('c1')!, FR, 'Nom complet')], opts(k, { column: loaded, warn: b.warn }));
      t.eq([outcomes(res2), b.said, k.F.patches.length, k.label('c3')[FR], k.own('c3')], [[['saved', '']], [], 1, 'Téléphone X', { [EN]: 'Business phone' }]);
    }),
  );

  t.test("form labels: this save's rename of a column landing between the read and the probe, under a label of that column the save edits, is nobody's save: the repair never posts the new name as their text, so it is never stored as the cell's own label (LIVE-FINDINGS 103, 104), and the save's text stays", async () => {
    const f = formFake(MAIN, { cols: COLS });
    const s = await slotsOf(f);
    f.F.at.batch = () => f.rename('telephone1', FR, 'Téléphone 2');
    // The phone column's names as the saver gives them while this save renames its French (SaveOptions.column).
    const column: NonNullable<SaveOptions['column']> = (e, attr) => (attr === 'telephone1' ? { names: { [EN]: ['Phone'], [FR]: ['Téléphone', 'Téléphone 2'] }, renamed: [FR] } : loaded(e, attr));
    const res = await formXmlWriter.save(f.ctx, [ch(s.get('c3')!, FR, 'Tél. pro')], opts(f, { column }));
    t.eq(outcomes(res), [['error', raceText('form', true).raced]]);
    t.eq([f.F.patches.length, !!kid(cellOf(parseXml(f.F.patches[1]), 'c3')!, 'labels')], [2, false], 'the repair posts no label of the phone field');
    t.eq([f.label('c3')[FR], f.own('c3')], ['Tél. pro', { [EN]: 'Business phone', [FR]: 'Tél. pro' }]);
  });

  t.test("form labels: the saver gives the form writer a column's names as loaded and as the save writes them, and the languages where the name a form read fills in changes: those it renames, and with the base language's the ones without a name of their own; a column the save gives its first French name goes by its English one in French too (SaveOptions.column)", () =>
    withStorage(async () => {
      const f = formFake(MAIN, { cols: COLS });
      const s = await slotsOf(f);
      // The fax and owner columns have no French name: a read fills in their English one there (LIVE-FINDINGS 42).
      const cols = columns().map((c) => (c.sub === 'fax' || c.sub === 'ownerid' ? { ...c, labels: { [EN]: c.labels[EN] } } : c));
      const st = new Store();
      st.add([...s.values(), ...cols]);
      /** What the form writer is told while it writes (the store takes the save's results only once every write is done). */
      let seen: unknown[] = [];
      const form: Writer = {
        kinds: ['field'],
        lane: 'xml',
        save: async (_ctx, cs, o) => {
          seen = ['fax', 'telephone1', 'ownerid', 'name', 'nothere'].map((attr) => o.column?.('account', attr));
          return cs.map((c): ChangeResult => ({ change: c, outcome: 'saved' }));
        },
      };
      const meta: Writer = { kinds: ['attribute'], lane: 'metadata', save: async (_ctx, cs) => cs.map((c): ChangeResult => ({ change: c, outcome: 'saved' })) };
      const saver = createSaver(f.ctx, st, f.lang, (k) => (k === 'field' ? form : k === 'attribute' ? meta : undefined));
      const col = (attr: string) => cols.find((c) => c.sub === attr)!;
      await saver.save([ch(s.get('c1')!, FR, 'Nom complet'), ch(col('fax'), EN, 'Fax 2'), ch(col('telephone1'), FR, 'Téléphone 2'), ch(col('ownerid'), FR, 'Propriétaire')], { signal: new AbortController().signal, publish: false, onProgress() {} });
      t.eq(
        seen,
        [
          { names: { [EN]: ['Fax', 'Fax 2'], [FR]: ['Fax', 'Fax 2'] }, renamed: [EN, FR] },
          { names: { [EN]: ['Phone'], [FR]: ['Téléphone', 'Téléphone 2'] }, renamed: [FR] },
          { names: { [EN]: ['Owner'], [FR]: ['Owner', 'Propriétaire'] }, renamed: [FR] },
          { names: { [EN]: ['Name'], [FR]: ['Nom'] }, renamed: [] },
          undefined,
        ],
      );
    }),
  );

  t.test("form labels: what the check after the write tells is said once per form (SaveOptions.warn): two forms of the same name in one save each keep their own message, though the words are the same", () =>
    withStorage(async () => {
      const f = formFake(MAIN, { cols: COLS });
      const a = (await slotsOf(f)).get('c1')!;
      // The same field on another table's form of the same name: another form, so another job of the writer.
      const other = '5e07410a-0000-4000-8000-000000000072';
      const b: Slot = { ...a, key: a.key.replace(FORM, other), comp: a.comp.replace(FORM, other), group: `formxml|${other}`, entity: 'contact', path: ['contact', ...a.path.slice(1)], ref: { ...a.ref, formId: other } };
      const st = new Store();
      st.add([a, b]);
      const left = droppedLeft('Information', [{ lang: lcidName(EN), text: 'E-mail' }]);
      const back = droppedBack('Information', 2);
      // Each form's checks say the same twice (one per language pass, say): once is enough there.
      const form: Writer = {
        kinds: ['field'],
        lane: 'xml',
        save: async (_ctx, cs, o) => {
          for (const m of [left, left]) o.warn?.(m, 'warning');
          for (const m of [back, back]) o.warn?.(m, 'notice');
          return cs.map((c): ChangeResult => ({ change: c, outcome: 'saved' }));
        },
      };
      const saver = createSaver(f.ctx, st, f.lang, (k) => (k === 'field' ? form : undefined));
      const rep = await saver.save([ch(a, FR, 'Nom complet'), ch(b, FR, 'Nom 2')], { signal: new AbortController().signal, publish: false, onProgress() {} });
      t.eq([rep.saved, rep.warning, rep.notice], [2, `${left} ${left}`, `${back} ${back}`]);
    }),
  );

  t.test("form labels: the write-back is settled like any write: a save landing between its read and its PATCH is put back, never replaced; one whose probe can't be read is back, and the save says it may have replaced a save someone else made at the same moment (a warning asking for no Try again); one Dataverse refuses leaves the labels said with their texts, the save's own change saved", async () => {
    const f = formFake(MAIN, { cols: COLS });
    const s = await slotsOf(f);
    f.F.violate = new Set([f.key('c2')]);
    // Someone else adds a tab right before the write-back's write batch (the second one).
    f.F.at.back = () => void (f.F.at.batch = () => f.designerSave((d) => addTab(d, 'a2', 'theirs', 'Theirs')));
    const a = told();
    const res = await formXmlWriter.save(f.ctx, [ch(s.get('c1')!, FR, 'Nom complet')], opts(f, { column: loaded, warn: a.warn }));
    t.eq(outcomes(res), [['saved', '']]);
    t.eq(a.said, [['notice', droppedBack('Information', 2)]]);
    t.eq([f.label('c2'), f.F.xml.includes('name="theirs"'), f.F.patches.length], [{ [EN]: 'E-mail', [FR]: 'Adresse e-mail' }, true, 3], 'their tab put back with the labels written back on it');
    // The same save as the write-back's batch arrives, and its probe can't be read: the labels are back, and what the
    // write-back replaced is unknown, which the save says with them, in one warning (every change of the save is saved, so
    // the Publish dialog has no Try again to point to).
    const g = formFake(MAIN, { cols: COLS });
    const gs = await slotsOf(g);
    g.F.violate = new Set([g.key('c2')]);
    g.F.at.back = () => {
      g.F.violate = false;
      g.F.at.batch = () => {
        g.designerSave((d) => addTab(d, 'a2', 'theirs', 'Theirs'));
        g.F.probe = 500;
      };
    };
    const b = told();
    t.eq(outcomes(await formXmlWriter.save(g.ctx, [ch(gs.get('c1')!, FR, 'Nom complet')], opts(g, { column: loaded, warn: b.warn }))), [['saved', '']]);
    t.eq(b.said, [['warning', droppedBack('Information', 2, true)]]);
    t.eq([g.label('c2'), g.F.patches.length], [{ [EN]: 'E-mail', [FR]: 'Adresse e-mail' }, 2]);
    // The write-back's PATCH refused (403): nothing is back, and each label is said with its text.
    const k = formFake(MAIN, { cols: COLS });
    const ks = await slotsOf(k);
    k.F.violate = new Set([k.key('c2')]);
    k.F.at.back = () => void (k.F.patch = 403);
    const c = told();
    t.eq(outcomes(await formXmlWriter.save(k.ctx, [ch(ks.get('c1')!, FR, 'Nom complet')], opts(k, { column: loaded, warn: c.warn }))), [['saved', '']]);
    t.eq(c.said, [['warning', droppedLeft('Information', [{ lang: lcidName(EN), text: 'E-mail' }, { lang: lcidName(FR), text: 'Adresse e-mail' }])]]);
    t.eq([k.label('c2'), k.F.patches.length], [{ [EN]: 'Email', [FR]: 'Courriel' }, 1]);
  });

  t.test("form labels: the check never overwrites what someone else saved: a text that is not one of the column's names inside the batch, or a label changed or a cell's key moved before the write-back's read, is said (a warning naming the label and its text), never written back, nor is any other label that cell lost; a cell whose key someone else moved inside the batch is theirs, left alone", async () => {
    // Their French saved over ours inside the batch, right before the PATCH: said, never written back.
    {
      const f = formFake(MAIN, { cols: COLS });
      const s = await slotsOf(f);
      f.F.at.patch = () => f.designerSave((d) => relabel(d, 'c2', FR, 'Adresse 2'));
      const a = told();
      t.eq(outcomes(await formXmlWriter.save(f.ctx, [ch(s.get('c1')!, FR, 'Nom complet')], opts(f, { column: loaded, warn: a.warn }))), [['saved', '']]);
      t.eq(a.said, [['warning', droppedLeft('Information', [{ lang: lcidName(FR), text: 'Adresse e-mail' }])]]);
      t.eq([f.label('c2')[FR], f.F.patches.length], ['Adresse 2', 1]);
    }
    // They moved the cell to a new key right after the PATCH: its labels are theirs, never checked.
    {
      const f = formFake(MAIN, { cols: COLS });
      const s = await slotsOf(f);
      f.F.at.back = () => f.designerSave((d) => moveKey(d, 'c2', FR));
      const a = told();
      t.eq(outcomes(await formXmlWriter.save(f.ctx, [ch(s.get('c1')!, FR, 'Nom complet')], opts(f, { column: loaded, warn: a.warn }))), [['saved', '']]);
      t.eq([a.said, f.label('c2')[FR], f.key('c2'), f.F.patches.length], [[], 'Courriel', MOVED, 1]);
    }
    // Labels Dataverse dropped, then their move to a new key before the write-back's read: said, never written over their key.
    {
      const f = formFake(MAIN, { cols: COLS });
      const s = await slotsOf(f);
      f.F.violate = new Set([f.key('c2')]);
      f.F.at.back = () => void (f.F.at.read = () => f.designerSave((d) => moveKey(d, 'c2', FR)));
      const a = told();
      t.eq(outcomes(await formXmlWriter.save(f.ctx, [ch(s.get('c1')!, FR, 'Nom complet')], opts(f, { column: loaded, warn: a.warn }))), [['saved', '']]);
      t.eq(a.said, [['warning', droppedLeft('Information', [{ lang: lcidName(EN), text: 'E-mail' }, { lang: lcidName(FR), text: 'Adresse e-mail' }])]]);
      t.eq([f.label('c2')[FR], f.F.patches.length], ['Courriel', 1]);
    }
    // Labels Dataverse dropped, and goes on dropping what a write leaves out of that cell, then their French saved before
    // the write-back's read: the cell gets nothing written back (its English alone would cost their French), so both are
    // said, and theirs is kept.
    {
      const f = formFake(MAIN, { cols: COLS });
      const s = await slotsOf(f);
      f.F.violate = new Set([f.key('c2')]);
      f.F.at.back = () => void (f.F.at.read = () => f.designerSave((d) => relabel(d, 'c2', FR, 'Adresse 3')));
      const a = told();
      t.eq(outcomes(await formXmlWriter.save(f.ctx, [ch(s.get('c1')!, FR, 'Nom complet')], opts(f, { column: loaded, warn: a.warn }))), [['saved', '']]);
      t.eq(a.said, [['warning', droppedLeft('Information', [{ lang: lcidName(EN), text: 'E-mail' }, { lang: lcidName(FR), text: 'Adresse e-mail' }])]]);
      t.eq([f.label('c2'), f.F.patches.length], [{ [EN]: 'Email', [FR]: 'Adresse 3' }, 1]);
    }
  });

  t.test("form labels: where Dataverse goes on dropping what a write leaves out, the write-back loses nothing unsaid: a cell with a text someone else saved meanwhile gets nothing written back (here no write at all, their French kept), the save's own changes go out again, and what the write-back's own PATCH lost is said with its latest text, never written back twice", async () => {
    /** A save of the name field's French, the table's columns loaded, while someone else saves the email field's French right after its PATCH. */
    const save = async (f: ReturnType<typeof formFake>) => {
      const s = await slotsOf(f);
      f.F.at.back = () => f.designerSave((d) => relabel(d, 'c2', FR, 'Leur adresse'));
      const a = told();
      return { res: outcomes(await formXmlWriter.save(f.ctx, [ch(s.get('c1')!, FR, 'Nom complet')], opts(f, { column: loaded, warn: a.warn }))), said: a.said };
    };
    // Dataverse drops the email field's labels: its English reads back as the column's name, its French as theirs.
    const f = formFake(MAIN, { cols: COLS });
    f.F.violate = new Set([f.key('c2')]);
    t.eq(await save(f), { res: [['saved', '']], said: [['warning', droppedLeft('Information', [{ lang: lcidName(FR), text: 'Adresse e-mail' }, { lang: lcidName(EN), text: 'E-mail' }])]] });
    t.eq([f.label('c2'), f.F.patches.length], [{ [EN]: 'Email', [FR]: 'Leur adresse' }, 1]);
    // The same on the name and phone fields too: the phone field's English is written back, with the save's French of the
    // name field posted again, and the email field left out loses their French, which is said.
    const g = formFake(MAIN, { cols: COLS });
    g.F.violate = new Set([g.key('c1'), g.key('c2'), g.key('c3')]);
    t.eq(await save(g), {
      res: [['saved', '']],
      said: [
        ['notice', droppedBack('Information', 1)],
        ['warning', droppedLeft('Information', [{ lang: lcidName(FR), text: 'Leur adresse' }, { lang: lcidName(EN), text: 'E-mail' }])],
      ],
    });
    const back = parseXml(g.F.patches[1]);
    t.eq([labelsIn(back, 'c1'), labelsIn(back, 'c3'), !!kid(cellOf(back, 'c2')!, 'labels')], [{ [FR]: 'Nom complet' }, { [EN]: 'Business phone' }, false], 'the write-back');
    t.eq([g.label('c1')[FR], g.own('c3'), g.label('c2'), g.F.patches.length], ['Nom complet', { [EN]: 'Business phone' }, { [EN]: 'Email', [FR]: 'Courriel' }, 2]);
  });

  t.test("form labels: with the column's names not loaded the check writes back only a label that reads back as nothing: any text there may be someone else's save, or a name a rename of theirs just gave the column, so it is said, never written over (their French kept, a field that follows its column still follows)", async () => {
    /** A save of the name field's French, the table's columns not loaded: the outcomes and what the user is told. */
    const save = async (f: ReturnType<typeof formFake>) => {
      const s = await slotsOf(f);
      const a = told();
      return { res: outcomes(await formXmlWriter.save(f.ctx, [ch(s.get('c1')!, FR, 'Nom complet')], opts(f, { warn: a.warn }))), said: a.said };
    };
    // Dataverse drops the email field's labels: each reads back as its column's name, which can't be told from a save.
    const f = formFake(MAIN, { cols: COLS });
    f.F.violate = new Set([f.key('c2')]);
    t.eq(await save(f), { res: [['saved', '']], said: [['warning', droppedLeft('Information', [{ lang: lcidName(EN), text: 'E-mail' }, { lang: lcidName(FR), text: 'Adresse e-mail' }])]] });
    t.eq([f.label('c2'), f.F.patches.length], [{ [EN]: 'Email', [FR]: 'Courriel' }, 1]);
    // …where the column has no French name and a read fills in none there, its French reads back as nothing, which no
    // save makes: written back, on a field whose English follows its column. Beside an English label of its own, which
    // reads back as a text that may be theirs, the cell gets nothing written back: both are said.
    const email = { ...COLS, emailaddress1: { [EN]: 'Email' } };
    const g = formFake(MAIN.replace(L(EN, 'E-mail'), ''), { cols: email });
    g.F.noName = 'none';
    g.F.violate = new Set([g.key('c2')]);
    t.eq(await save(g), { res: [['saved', '']], said: [['notice', droppedBack('Information', 1)]] });
    t.eq([g.label('c2'), g.F.patches.length], [{ [EN]: 'Email', [FR]: 'Adresse e-mail' }, 2]);
    const p = formFake(MAIN, { cols: email });
    p.F.noName = 'none';
    p.F.violate = new Set([p.key('c2')]);
    t.eq(await save(p), { res: [['saved', '']], said: [['warning', droppedLeft('Information', [{ lang: lcidName(EN), text: 'E-mail' }, { lang: lcidName(FR), text: 'Adresse e-mail' }])]] });
    t.eq([p.label('c2'), p.F.patches.length], [{ [EN]: 'Email' }, 1]);
    // Their French saved right after our PATCH: kept.
    const k = formFake(MAIN, { cols: COLS });
    k.F.at.back = () => k.designerSave((d) => relabel(d, 'c2', FR, 'Adresse 2'));
    t.eq(await save(k), { res: [['saved', '']], said: [['warning', droppedLeft('Information', [{ lang: lcidName(FR), text: 'Adresse e-mail' }])]] });
    t.eq([k.label('c2')[FR], k.F.patches.length], ['Adresse 2', 1]);
    // Their rename of the fax column's French right after our PATCH: the fax field, which has no label of its own, still
    // follows its column.
    const m = formFake(MAIN, { cols: COLS });
    m.F.at.back = () => m.rename('fax', FR, 'Télécopie X');
    t.eq(await save(m), { res: [['saved', '']], said: [['warning', droppedLeft('Information', [{ lang: lcidName(FR), text: 'Télécopie' }])]] });
    t.eq([m.own('c7'), m.F.patches.length], [{}, 1]);
    m.rename('fax', FR, 'Télécopie Y');
    t.eq(m.label('c7')[FR], 'Télécopie Y');
  });

  t.test("form labels: someone else gives a cell this save edits a new label key without that language, between the read and the PATCH: the repair posts the cell with their label key and no labels, so the labels under it stand (LIVE-FINDINGS 105), and ours is a conflict showing the column's name it now follows; with the column's names not loaded too, where only their key tells their change from a text of theirs", async () => {
    for (const names of [true, false]) {
      const as = names ? "the column's names loaded" : "the column's names not loaded";
      const f = formFake(MAIN, { cols: COLS });
      const s = await slotsOf(f);
      f.F.at.batch = () => f.designerSave((d) => moveKey(d, 'c2', FR));
      const res = await formXmlWriter.save(f.ctx, [ch(s.get('c2')!, FR, 'Adresse 2')], opts(f, names ? { column: loaded } : {}));
      t.eq(res.map((r) => [r.outcome, r.server, r.message]), [['conflict', 'Courriel', RACE_THEIRS]], as);
      const repair = cellOf(parseXml(f.F.patches[1]), 'c2')!;
      t.eq([f.F.patches.length, normId(repair.getAttribute('labelid')), !!kid(repair, 'labels')], [2, MOVED, false], `their key, no labels (${as})`);
      t.eq([f.key('c2'), f.own('c2'), f.label('c2')], [MOVED, { [EN]: 'E-mail' }, { [EN]: 'E-mail', [FR]: 'Courriel' }], as);
    }
  });

  t.test("form labels: the checks refuse a posted text none of the write's inputs gives (postable, the writer's own rule): a kept text that is one of the column's names, another language's text, a text from another read; their text of a pair they changed too passes unless it is one of the column's names, and on an added field any text while the column's names aren't loaded", () => {
    // A repair's build: the probe (P) holds a field someone else added since the read (c9), which goes back without its
    // column's name; ours is c1's French.
    const f = formFake(MAIN, { cols: COLS });
    const read = parseXml(f.F.xml);
    f.designerSave(addFax);
    const probe = f.F.xml;
    const before = parseXml(probe);
    const built = () => {
      const d = parseXml(probe);
      for (const id of [...SPARSE_IDS, 'c9']) setLabels(d, id, id === 'c1' ? { [FR]: 'Nom complet' } : id === 'c9' ? { [EN]: 'Fax line' } : null);
      return d;
    };
    const pair = (id: string, before: string, after: string): Change => ({ slot: { comp: `field|${FORM}|${id}` } as Slot, lcid: FR, before, after });
    const names = (df: string) => loaded('account', df)?.names;
    /** As the writer's build makes it, from its inputs alone: the edit; on the added cell, a text the probe holds there that is none of its column's names. */
    const may = postable(before, read, FORM, [pair('c1', 'Nom', 'Nom complet')], [], names);
    const cell = (id: string) => cellOf(before, id)!;
    t.eq([may(cell('c1'), FR, 'Nom complet'), may(cell('c9'), EN, 'Fax line')], [true, true], 'the edit; the added field without its column name');
    t.eq([may(cell('c9'), FR, 'Télécopie'), may(cell('c1'), FR, 'Name'), may(cell('c2'), FR, 'Courriel'), may(cell('c2'), FR, 'Adresse e-mail')], [false, false, false, false]);
    const clashed = postable(before, read, FORM, [pair('c1', 'Nom', 'Nom complet')], [pair('c2', 'Adresse e-mail', 'Adresse 2'), pair('c3', 'Téléphone', 'Tél. pro')], names);
    t.eq([clashed(cell('c2'), FR, 'Adresse e-mail'), clashed(cell('c2'), FR, 'Adresse 2'), clashed(cell('c2'), EN, 'E-mail')], [true, false, false], 'their text of the pair they changed too, that pair only');
    t.eq(clashed(cell('c3'), FR, 'Téléphone'), false, "a clash whose text is one of the column's names: the name filled in, nobody's text");
    t.eq(postable(before, read, FORM, [], [], () => undefined)(cell('c9'), FR, 'Télécopie'), true, "the column's names not loaded: the added field as read");
    /** `expect` as the spoiled document holds it: only part (C) can refuse it. */
    const check = (after: Document) => {
      const expect = new Map([...SPARSE_IDS, 'c9'].map((id) => {
        const c = cellOf(after, id)!;
        return [c, kid(c, 'labels') ? labelsIn(after, id) : null];
      }));
      assertSent(before, after, 2, false, () => false, expect, may);
    };
    t.eq(thrown(() => check(built())), '', 'the right copy passes');
    const spoiled: Array<[string, (d: Document) => void]> = [
      ["a kept text that is one of the column's names", (d) => relabel(d, 'c9', FR, 'Télécopie')],
      ["another language's text", (d) => relabel(d, 'c1', FR, 'Name')],
      ['a text from another read', (d) => setLabels(d, 'c2', { [FR]: 'Courriel' })],
    ];
    for (const [what, spoil] of spoiled) {
      const d = built();
      spoil(d);
      t.ok(/^Safety check failed/.test(thrown(() => check(d))), what);
    }
  });

  // ---- through the loader and the real saver: renames in the same save, reads that lag, the check after publishing ----

  t.test("form labels: the loader marks a main form's body and header column cells sparse (a save posts them only with what it changes), and gives a cell its label key once it has one; a footer's, a tab footer's and a quick view control's cells, every cell of another form type, and those of a managed main form or of one read through its published fallback, are not sparse", async () => {
    const f = formFake(MAIN, { cols: COLS });
    const s = await slotsOf(f);
    t.eq(['c1', 'c7', 'h1', 'f1', 't1', 'c6', 'c4', 'a1'].map((id) => s.get(id)!.ref.sparse ?? null), [true, true, true, null, null, null, null, null]);
    f.designerSave((d) => moveKey(d, 'c2', FR));
    t.eq([(await slotsOf(f)).get('c2')!.ref.labelKey, s.get('c2')!.ref.labelKey ?? null], [MOVED, null], 'its labelid, once set (LIVE-FINDINGS 106)');
    const q = await slotsOf(formFake(MAIN, { type: 7, cols: COLS }), 7);
    t.eq([...q.values()].filter((x) => x.ref.sparse).length, 0, 'a quick create form');
    // Read-only, so nothing is staged on them anyway (MANAGED, NO_UNPUB): never sparse either.
    for (const what of ['managed', 'published'] as const) {
      const g = formFake(MAIN, { cols: COLS });
      g.F[what] = true;
      const gs = await slotsOf(g);
      t.eq([!!gs.get('c1')?.readOnly, [...gs.values()].filter((x) => x.ref.sparse).length], [true, 0], what);
    }
  });

  t.test("form labels: a quick create form and a rename of its column in one save: the form is written once the rename is saved; a field with no label of its own still follows and the old name is never stored", () =>
    withStorage(async () => {
      const f = formFake(MAIN, { type: 7, cols: COLS });
      const r = await saverRig(f, 7);
      t.eq(r.cell('c7').ref.sparse ?? null, null, 'a quick create form: every cell goes out as read (outside SPARSE)');
      // Were the form written beside the metadata lane, the rename would land between its read and its write.
      r.R.when = () => Promise.race([new Promise<void>((go) => (f.F.at.read = go)), tick(50)]);
      r.store.set(r.cell('c1').key, FR, 'Nom complet');
      r.store.set(r.col('fax').key, FR, 'Télécopie 2');
      const rep = await r.save();
      t.eq([rep.saved, rep.errors, f.F.patches.length], [2, 0, 1]);
      t.eq([f.own('c7'), f.label('c7')[FR]], [{}, 'Télécopie 2'], 'the old name never stored');
      f.rename('fax', FR, 'Télécopie 3');
      t.eq(f.label('c7')[FR], 'Télécopie 3', 'it still follows');
    }),
  );

  t.test("form labels: an edit over a label showing its column's name while the same save renames that column is no conflict, whichever write lands first, and no repair stores the new name", () =>
    withStorage(async () => {
      const timings: Array<[string, (f: ReturnType<typeof formFake>) => () => Promise<unknown>]> = [
        ['the rename first', () => () => Promise.resolve()],
        ['the form first', () => () => tick(50)],
        ["the rename between the form's read and its write", (f) => () => Promise.race([new Promise<void>((go) => (f.F.at.read = go)), tick(100)])],
      ];
      for (const [when, at] of timings) {
        const f = formFake(MAIN, { cols: COLS });
        const r = await saverRig(f);
        r.R.when = at(f);
        // The phone field's French shows its column's name (no label of its own there).
        r.store.set(r.cell('c3').key, FR, 'Tél. pro');
        r.store.set(r.col('telephone1').key, FR, 'Téléphone 2');
        const rep = await r.save();
        t.eq(rep.results.map((x) => [x.change.slot.kind, x.outcome, x.message ?? '']), [['field', 'saved', ''], ['attribute', 'saved', '']], when);
        t.eq([f.F.patches.length, f.own('c3'), f.label('c3')[FR]], [1, { [EN]: 'Business phone', [FR]: 'Tél. pro' }, 'Tél. pro'], when);
      }
    }),
  );

  t.test("form labels: a pass never writes from a read that lags behind this page's own write (LIVE-FINDINGS 66): it reads again until the read shows that write, so a label the save wrote on a cell that goes out as read (the footer's) stays; still behind after every wait, nothing is written from it and it says so; a save right after another reads again the same way", () =>
    withStorage(() =>
      fast(async () => {
        for (const [n, what] of [[1, 'the read lags'], [2, 'the read lags, and so would the probe']] as const) {
          // The footer's English and a French tab edit: the French pass reads the form as it was before the English pass
          // wrote the footer's label, which posted as read would put the text from before it back (LIVE-FINDINGS 104).
          const f = formFake(MAIN, { cols: COLS });
          const r = await saverRig(f);
          lagged(f).afterWrite(n);
          r.store.set(r.cell('f1').key, EN, 'Status 2');
          r.store.set(r.cell('a1').key, FR, 'Général 2');
          const rep = await r.save();
          t.eq([rep.saved, rep.errors, f.F.patches.length], [2, 0, 2], what);
          t.eq([labelsIn(parseXml(f.F.patches[1]), 'f1')[EN], f.label('f1')[EN]], ['Status 2', 'Status 2'], `the footer's English stays (${what})`);
        }
        {
          // Still behind after every wait: the French pass writes nothing, saying so, and the footer's English stays.
          const f = formFake(MAIN, { cols: COLS });
          const r = await saverRig(f);
          lagged(f).afterWrite(10);
          r.store.set(r.cell('f1').key, EN, 'Status 2');
          r.store.set(r.cell('a1').key, FR, 'Général 2');
          const rep = await r.save();
          t.eq(rep.results.map((x) => [x.change.slot.kind, x.outcome, x.message ?? '']), [['field', 'saved', ''], ['tab', 'error', behindText('form')]]);
          t.eq([f.F.patches.length, f.label('f1')[EN]], [1, 'Status 2']);
        }
        {
          // The English pass races someone else's save (a tab added) and puts it back; the French pass then reads the form,
          // and its probe, as the English pass's first PATCH left it, before that repair: never written from, their tab stays.
          const f = formFake(MAIN, { cols: COLS });
          const r = await saverRig(f);
          f.F.at.batch = () => f.designerSave((d) => addTab(d, 'a2', 'theirs', 'Theirs'));
          const batch = f.h.batch.bind(f.h);
          let first: PartResult | undefined;
          let writes = 0;
          let n = 0;
          f.h.batch = async (L, parts, signal) => {
            const res = await batch(L, parts, signal);
            if (n > 0 && res.results[0]?.ok) {
              n--;
              res.results[0] = first!;
            } else if (parts.some((p) => p.method === 'PATCH') && ++writes === 1) first = res.results[2];
            else if (writes === 2 && !n && first) [n, writes] = [2, 3];
            return res;
          };
          r.store.set(r.cell('f1').key, EN, 'Status 2');
          r.store.set(r.cell('a1').key, FR, 'Général 2');
          const rep = await r.save();
          t.eq([rep.saved, f.F.patches.length, f.F.xml.includes('name="theirs"'), f.label('f1')[EN]], [2, 3, true, 'Status 2'], 'behind the repair');
        }
        {
          // Someone else saves the form at the English pass's write and again right after it, which that pass's own read
          // then shows (it can't put the first back); the French pass, reading and probing the form as that write left it,
          // before their second save, never writes from it: their second save stays.
          const f = formFake(MAIN, { cols: COLS });
          const r = await saverRig(f);
          f.F.at.batch = () => f.designerSave((d) => addTab(d, 'a2', 'theirs', 'Theirs'));
          f.F.at.back = () => void (f.F.at.read = () => f.designerSave((d) => addTab(d, 'a3', 'later', 'Later')));
          const batch = f.h.batch.bind(f.h);
          let count = 0;
          let first: PartResult | undefined;
          f.h.batch = async (L, parts, signal) => {
            const res = await batch(L, parts, signal);
            if (++count === 2) first = res.results[2];
            else if (count === 4 || count === 5) res.results[0] = first!;
            return res;
          };
          r.store.set(r.cell('f1').key, EN, 'Status 2');
          r.store.set(r.cell('a1').key, FR, 'Général 2');
          const rep = await r.save();
          t.eq([rep.results.map((x) => [x.change.slot.kind, x.outcome]), f.F.xml.includes('name="later"')], [[['field', 'error'], ['tab', 'saved']], true], 'behind a read of their save');
        }
        {
          // The check after the write: a read behind the write just made (and the probe of a write-back built on it) shows
          // the phone field from before someone else gave it its English, so its label Dataverse dropped would be written
          // back over the form as it was then. Nothing is written from it: the label is said.
          const phone = 'id="telephone1" datafieldname="telephone1"';
          const f = formFake(MAIN.replace(row('c3', phone, L(EN, 'Business phone')), row('c3', phone, '')), { cols: COLS });
          const r = await saverRig(f);
          const lag = lagged(f);
          f.designerSave((d) => relabel(d, 'c3', EN, 'Business phone'));
          f.F.violate = new Set(['c3']);
          lag.afterWrite(2);
          r.store.set(r.cell('c2').key, FR, 'Adresse 2');
          const rep = await r.save();
          t.eq([rep.saved, rep.warning, f.F.patches.length], [1, droppedLeft('Information', [{ lang: lcidName(EN), text: 'Business phone' }]), 1]);
          t.eq(f.label('c2')[FR], 'Adresse 2', "the save's own change stays");
        }
        // A save right after another: its read (and its probe) lag behind the footer's English the first one wrote.
        const f = formFake(MAIN, { cols: COLS });
        const r = await saverRig(f);
        const lag = lagged(f);
        r.store.set(r.cell('f1').key, EN, 'Status 2');
        t.eq((await r.save()).saved, 1);
        lag.now(2);
        r.store.set(r.cell('c1').key, EN, 'Name 2');
        t.eq((await r.save()).saved, 1);
        t.eq([labelsIn(parseXml(f.F.patches[1]), 'f1')[EN], f.label('f1')[EN], f.own('c1')[EN]], ['Status 2', 'Status 2', 'Name 2']);
      }),
    ),
  );

  t.test("form labels: an edit of a label's own text to the name its column had as loaded, in a save whose rename of that column there fails, is saved all the same: a text of the label's own is stored on its key whichever write lands first (LIVE-FINDINGS 104), so it never waits on that rename's outcome", () =>
    withStorage(async () => {
      const f = formFake(MAIN, { cols: COLS });
      const r = await saverRig(f);
      // Renamed elsewhere since the load: this save's rename is a conflict.
      f.rename('emailaddress1', FR, 'Courriel X');
      r.store.set(r.col('emailaddress1').key, FR, 'Courriel 2');
      r.store.set(r.cell('c2').key, FR, 'Courriel');
      t.eq((await r.save()).results.map((x) => [x.change.slot.kind, x.outcome]), [['attribute', 'conflict'], ['field', 'saved']]);
      t.eq(f.own('c2'), { [EN]: 'E-mail', [FR]: 'Courriel' });
    }),
  );

  t.test("form labels: a saved field label of the user's language that a publish left out of the published form, the versions equal (LIVE-FINDINGS 117), is found by the check after publishing and named for Publish again, which writes it with MARK after it, publishes, writes it as it is and publishes again: two sparse writes of that label alone, each publish inside a quiet() job, and the check then finds it published. One someone else saved over since is never written over: Publish again only publishes, and the check leaves it to the versions", () =>
    withStorage(async () => {
      for (const theirs of [false, true]) {
        const as = theirs ? 'theirs since' : 'stuck';
        const f = formFake(MAIN, { cols: COLS });
        const r = await saverRig(f);
        const { app, q } = reviewApp(f, r);
        const c3 = r.cell('c3').key;
        f.F.stick.add(`c3#${EN}`);
        r.store.set(c3, EN, 'Business phones');
        const rep = await r.save();
        const saved = rep.results.map((x) => x.change);
        t.eq([rep.saved, rep.published, f.F.v === f.F.vpub, f.label('c3')[EN], pubText(f, 'c3')], [1, true, true, 'Business phones', 'Business phone'], `published, the versions equal, the published form without it (${as})`);
        const found = await unpublishedForms(app, saved, undefined, 0);
        t.eq([found.left, found.unread, found.missing.map(changeId), [...found.published]], [['Information (Main form)'], [], [`${c3}#${EN}`], []], as);
        if (theirs) f.designerSave((d) => relabel(d, 'c3', EN, 'Their phone'));
        const [patches, posts] = [f.F.patches.length, r.R.posts.length];
        const said = await publishAgain(app, saved, [], undefined, undefined, found.missing);
        const sent = f.F.patches.slice(patches).map((x) => [labelsIn(parseXml(x), 'c3'), keyIn(x, 'c3'), labelsIn(parseXml(x), 'c1')]);
        t.eq(sent, theirs ? [] : [[{ [EN]: 'Business phones' + MARK }, '', {}], [{ [EN]: 'Business phones' }, '', {}]], `the text with MARK, then as it is, on the cell's own key; no other label (${as})`);
        t.eq([r.R.posts.length - posts, q.inQuiet, [...said.theirs], pubText(f, 'c3')], theirs ? [1, 1, [`${c3}#${EN}`], 'Their phone'] : [2, 2, [], 'Business phones'], as);
        const after = await unpublishedForms(app, saved, undefined, 0, said.theirs);
        t.eq([after.left, after.unread, after.missing.length, [...after.published]], [[], [], 0, [[FORM, String(f.F.vpub)]]], `published (${as})`);
      }
    }),
  );

  t.test("form labels: a second save of a label a publish left out of the published form (LIVE-FINDINGS 117) finds it as asked with the versions equal, so nothing is published; the check after it still finds it missing from the published form, never published unchecked, and Publish again writes it again", () =>
    withStorage(async () => {
      const f = formFake(MAIN, { cols: COLS });
      const r = await saverRig(f);
      const { app } = reviewApp(f, r);
      const c3 = r.cell('c3').key;
      // A save of that text, published without it: the state found on the large form.
      f.designerSave((d) => relabel(d, 'c3', EN, 'Business phones'));
      f.F.stick.add(`c3#${EN}`);
      f.publish();
      r.store.set(c3, EN, 'Business phones');
      const rep = await r.save();
      t.eq([rep.results.map((x) => x.outcome), rep.published, r.R.posts.length], [['unchanged'], true, 0], 'found as asked, the versions equal: nothing to publish');
      const cs = rep.results.map((x) => x.change);
      const found = await unpublishedForms(app, cs, undefined, 0);
      t.eq([found.left, found.missing.map(changeId)], [['Information (Main form)'], [`${c3}#${EN}`]], 'not published');
      await publishAgain(app, cs, [], undefined, undefined, found.missing);
      t.eq([(await unpublishedForms(app, cs, undefined, 0)).left, pubText(f, 'c3')], [[], 'Business phones']);
    }),
  );

  t.test("form labels: one Publish again repairs a field label the published form doesn't show and a column name Dataverse doesn't serve as saved, saved in one publish (LIVE-FINDINGS 117, 118): each writer in turn, the label's two sparse writes and the column's two renames, with MARK, then as they are, a publish after each inside a quiet() job; the check then finds both published", () =>
    withStorage(async () => {
      const f = formFake(MAIN, { cols: COLS });
      const r = await saverRig(f);
      const { app, q } = reviewApp(f, r);
      const c3 = r.cell('c3').key;
      const phone = r.col('telephone1').key;
      f.F.stick.add(`c3#${EN}`);
      f.F.stick.add(`telephone1#${EN}`);
      r.store.set(c3, EN, 'Business phones');
      r.store.set(phone, EN, 'Phones');
      const rep = await r.save();
      const saved = rep.results.map((x) => x.change);
      t.eq([rep.saved, pubText(f, 'c3'), f.pubCol('telephone1')[EN]], [2, 'Business phone', 'Phone'], 'published without either');
      const found = await unpublishedForms(app, saved, undefined, 0);
      t.eq([found.left, found.missing.map(changeId)], [['Information (Main form)', 'account (table)'], [`${c3}#${EN}`, `${phone}#${EN}`]]);
      const renames: string[] = [];
      const rename = f.rename;
      f.rename = (df, l, text) => (renames.push(text), rename(df, l, text));
      const [patches, posts] = [f.F.patches.length, r.R.posts.length];
      await publishAgain(app, saved, [], undefined, undefined, found.missing);
      t.eq([f.F.patches.slice(patches).map((x) => labelsIn(parseXml(x), 'c3')[EN]), renames], [['Business phones' + MARK, 'Business phones'], ['Phones' + MARK, 'Phones']]);
      t.eq([r.R.posts.length - posts, q.inQuiet, pubText(f, 'c3'), f.pubCol('telephone1')[EN]], [4, 4, 'Business phones', 'Phones']);
      const after = await unpublishedForms(app, saved, undefined, 0);
      t.eq([after.left, after.unread, after.missing.length], [[], [], 0], 'published');
    }),
  );

  t.test("form labels: after the translator's own publish of a form with no other change, the answers of which field labels are its own are kept for its new version (keepOwnLabels, LIVE-FINDINGS 114): a text typed is its own, and so is one worded as its column's name on a key that held a label (104), so the form loaded again knows every one as it stores them, reading nothing. Nothing is kept for a form that had another change before or during the save, or a label Dataverse dropped meanwhile, nor in a language whose answer wasn't kept, nor where a key's labels aren't known", () =>
    withStorage(async () => {
      /**
       * A save of `edits` on a fresh form whose answers are kept in `langs` (but for the key `hide`, as if published
       * without its labels); `other`: another change of the form before or during it, or labels Dataverse drops.
       */
      const run = async (langs: Lcid[], edits: Array<[string, Lcid, string]>, other?: 'before' | 'during' | 'dropped', hide?: string) => {
        const f = formFake(MAIN, { cols: COLS });
        const r = await saverRig(f);
        const { app } = reviewApp(f, r);
        for (const l of [EN, FR]) localStorage.removeItem(`dxt:own:formlabels:${FORM}:${l}`);
        stash(f, langs);
        if (hide) for (const l of langs) localStorage.setItem(`dxt:own:formlabels:${FORM}:${l}`, JSON.stringify({ ...keptFor(l), k: keptFor(l)!.k.filter((k) => k !== hide) }));
        const v0 = String(f.F.vpub);
        if (other === 'before') f.designerSave();
        if (other === 'during') f.F.between = () => f.designerSave((d) => relabel(d, 'c6', EN, 'Parent'));
        if (other === 'dropped') f.F.violate = new Set(['c2']);
        for (const [id, l, text] of edits) r.store.set(r.cell(id).key, l, text);
        const rep = await r.save();
        t.ok(rep.results.every((x) => x.outcome === 'saved'), JSON.stringify(rep.results.map((x) => [x.outcome, x.message])));
        keepOwnLabels(app, rep, (await unpublishedForms(app, rep.results.map((x) => x.change), undefined, 0)).published);
        // The form loaded again: what it stores under each cell's key now, and what the kept answers say of it.
        const cells = [...(await slotsOf(f)).values()].filter((s) => s.ref.sparse);
        const stored = new Map(cells.map((s) => [s.key, Object.fromEntries([EN, FR].map((l) => [l, !!f.F.rows.get(s.ref.labelKey || s.ref.elId)?.has(l)]))]));
        return { f, rep, v0, v1: String(f.F.vpub), stored, known: knownOwnLabels(f.ctx, cells) };
      };
      // Texts typed; the column's French name typed over a French label of the email field's own, and its English name
      // over the phone field's English label of its own: both keys hold labels, so both are stored (104).
      const all = await run([EN, FR], [['c1', FR, 'Nom complet'], ['c2', FR, 'Courriel'], ['c3', EN, 'Phone'], ['h1', EN, 'Record owner']]);
      t.eq([...all.known], [...all.stored], 'every cell as the form stores it');
      const own = (id: string) => all.stored.get(`field|${FORM}|${id}|Label`);
      t.eq([own('c1'), own('c2'), own('c3'), own('c7'), own('h1')], [{ [EN]: true, [FR]: true }, { [EN]: true, [FR]: true }, { [EN]: true, [FR]: false }, { [EN]: false, [FR]: false }, { [EN]: true, [FR]: false }]);
      t.eq([keptFor(EN), keptFor(FR)], [{ v: all.v1, k: ['c1', 'c2', 'c3', 'f1', 'h1', 't1'] }, { v: all.v1, k: ['c1', 'c2', 'f1', 't1'] }], 'kept for the new version');
      for (const other of ['before', 'during', 'dropped'] as const) {
        const x = await run([EN, FR], [['c3', EN, 'Business phones']], other);
        t.eq([keptFor(EN)?.v, keptFor(FR)?.v, x.known.size, other !== 'dropped' || !!x.rep.notice?.startsWith('Dataverse dropped')], [x.v0, x.v0, 0, true], `another change ${other}: nothing kept`);
      }
      const one = await run([EN], [['c3', EN, 'Business phones'], ['c3', FR, 'Tél. pro']]);
      t.eq([keptFor(EN), keptFor(FR)], [{ v: one.v1, k: ['c1', 'c2', 'c3', 'f1', 'h1', 't1'] }, null], 'only the language kept before');
      const unknown = await run([EN], [['c2', EN, 'Email']], undefined, 'c2');
      t.eq([unknown.stored.get(`field|${FORM}|c2|Label`)?.[EN], keptFor(EN)?.v], [true, unknown.v0], "worded as its column's name on a key no kept answer lists, French not kept: whether it held a label isn't known");
    }),
  );

  t.test("form labels: the Checking step repairs once, at once (checkRepaired): a field label a publish left out of the published form and a column name not served as saved (LIVE-FINDINGS 117, 118) are written again, each writer in turn, with MARK, then as they are, a publish after each inside a quiet() job, and the check after that finds both published, so nothing is said; with nothing left out it repairs nothing", () =>
    withStorage(() =>
      fast(async () => {
        const f = formFake(MAIN, { cols: COLS });
        const r = await saverRig(f);
        const { app, q } = reviewApp(f, r);
        const c3 = r.cell('c3').key;
        f.F.stick.add(`c3#${EN}`);
        f.F.stick.add(`telephone1#${EN}`);
        r.store.set(c3, EN, 'Business phones');
        r.store.set(r.col('telephone1').key, EN, 'Phones');
        const rep = await r.save();
        const saved = rep.results.map((x) => x.change);
        t.eq([rep.saved, pubText(f, 'c3'), f.pubCol('telephone1')[EN]], [2, 'Business phone', 'Phone'], 'published without either');
        const steps: string[] = [];
        const step = { repair: () => void steps.push('repair'), now: () => {}, check: () => void steps.push('check') };
        const [patches, posts] = [f.F.patches.length, r.R.posts.length];
        const got = await checkRepaired(app, saved, [rep.historyId!], undefined, step);
        t.eq([got.repaired, got.error, got.found.left, got.found.missing.length, steps], [true, '', [], 0, ['repair', 'check']]);
        t.eq([f.F.patches.slice(patches).map((x) => labelsIn(parseXml(x), 'c3')[EN]), r.R.posts.length - posts, q.inQuiet], [['Business phones' + MARK, 'Business phones'], 4, 4]);
        t.eq([pubText(f, 'c3'), f.pubCol('telephone1')[EN]], ['Business phones', 'Phones'], 'both published');
        const done = [f.F.patches.length, r.R.posts.length];
        const again = await checkRepaired(app, saved, [], undefined, step);
        t.eq([again.repaired, again.found.left, [f.F.patches.length, r.R.posts.length], steps.length], [false, [], done, 2], 'nothing left out: no repair');
      }),
    ),
  );

  t.test("form labels: what the Checking step's repair can't publish is told as before: a label still left out after it is named for Publish again; a repair that fails keeps the first check's answer and says why; a label someone else saved over since is theirs, never written over, and the check leaves it to the versions", () =>
    withStorage(() =>
      fast(async () => {
        /** A save of the phone field's English that the next publish leaves out, through the real saver; `step.repair` runs right before the repair. */
        const saveStuck = async (repair: (f: ReturnType<typeof formFake>) => void = () => {}) => {
          const f = formFake(MAIN, { cols: COLS });
          const r = await saverRig(f);
          const { app } = reviewApp(f, r);
          f.F.stick.add(`c3#${EN}`);
          r.store.set(r.cell('c3').key, EN, 'Business phones');
          const rep = await r.save();
          const patches = f.F.patches.length;
          const got = await checkRepaired(app, rep.results.map((x) => x.change), [], undefined, { repair: () => repair(f), now: () => {}, check: () => {} });
          return { f, got, id: `${r.cell('c3').key}#${EN}`, wrote: f.F.patches.length - patches };
        };
        // Every publish leaves it out, the repair's too.
        const still = await saveStuck((f) => {
          const publish = f.publish;
          f.publish = () => (f.F.stick.add(`c3#${EN}`), publish());
        });
        t.eq([still.got.repaired, still.got.error, still.got.found.left, still.got.found.missing.map(changeId), still.wrote], [true, '', ['Information (Main form)'], [still.id], 2], 'still left out: named for Publish again');
        // The repair's first write refused.
        const failed = await saveStuck((f) => void (f.F.patch = 403));
        t.eq([failed.got.repaired, !!failed.got.error, failed.got.found.left, failed.got.found.missing.map(changeId)], [true, true, ['Information (Main form)'], [failed.id]], 'the repair failed: said, with the first answer');
        // Someone else saves their text there right before the repair: the repair only publishes.
        const theirs = await saveStuck((f) => f.designerSave((d) => relabel(d, 'c3', EN, 'Their phone')));
        t.eq([theirs.got.found.left, [...theirs.got.said.theirs], theirs.wrote, theirs.f.label('c3')[EN], pubText(theirs.f, 'c3')], [[], [theirs.id], 0, 'Their phone', 'Their phone'], 'theirs kept');
      }),
    ),
  );

  t.test("form labels: Publish again's repair never leaves MARK on a label where Dataverse lets it take it away, and never untold (formxml.ts rewrite): stopped while its first publish runs, the label is written as it is all the same and published again, as that publish served it with MARK, then the stop is told; that publish refused (403), the label is written as it is (unpublished, as after a save), then the refusal is told; that publish failing with a server error (it may have run), the label is written as it is and published again, and once that publish goes through, nothing is wrong; the answer to the MARK write lost (it ran: an error), the label is written as it is after that publish all the same and published again, then that first write's error is told; the label written back turned away by a busy Dataverse past the writer's own tries, it is written again after a wait; the publish after it turned away past PublishXml's own waits, it is sent again after a wait; the label written back never taken, it is an error after its tries, with MARK still on it, which Publish again then takes away; stopped before the repair, nothing is written", () =>
    withStorage(() =>
      fast(async () => {
        const LOCK = 'Cannot start another [Import] because there is a previous [Import] running at this moment.';
        for (const how of ['stopped', 'failed', 'server error', 'answer lost', 'turned away', 'publish turned away', 'never taken', 'stopped before'] as const) {
          const f = formFake(MAIN, { cols: COLS });
          const r = await saverRig(f);
          const { app } = reviewApp(f, r);
          f.F.stick.add(`c3#${EN}`);
          r.store.set(r.cell('c3').key, EN, 'Business phones');
          const saved = (await r.save()).results.map((x) => x.change);
          const { missing } = await unpublishedForms(app, saved, undefined, 0);
          const ac = new AbortController();
          if (how === 'stopped before') ac.abort();
          const http = (f.ctx as unknown as { http: Record<string, unknown> }).http;
          const post = http.post as (fn: string, body: unknown) => Promise<void>;
          let n = 0;
          http.post = async (fn: string, body: unknown) => {
            if (fn === 'PublishXml' && ++n === 1) {
              if (how === 'failed') throw new DvError('You do not have permission to do this.', 403);
              if (how === 'server error') throw new DvError('Generic SQL error.', 500);
              if (how === 'stopped') ac.abort(); // Stop, while PublishXml runs: it runs to its end
              // Busy from then on: every write batch turned away, four times (each of writeLang's tries), or for good.
              if (how === 'never taken') f.F.patch = 429;
              if (how === 'turned away') {
                f.F.patch = 429;
                let k = 5;
                const arm = () => (f.F.at.batch = () => (--k ? arm() : (f.F.patch = undefined)));
                arm();
              }
            }
            // The publish after the label written back: turned away five times (PublishXml's own try and its four again).
            if (fn === 'PublishXml' && how === 'publish turned away' && n >= 2 && n <= 6) throw new DvError(LOCK, 400);
            return post(fn, body);
          };
          // The repair's first write batch runs, then its answer is lost.
          if (how === 'answer lost') f.F.lose = 1;
          const [patches, posts] = [f.F.patches.length, r.R.posts.length];
          const err = await publishAgain(app, saved, [], ac.signal, undefined, missing).then(() => null, (e: unknown) => e as Error);
          const said = [f.F.patches.slice(patches).map((x) => labelsIn(parseXml(x), 'c3')[EN]), r.R.posts.length - posts, f.own('c3')[EN], pubText(f, 'c3'), isAbort(err) ? 'stopped' : (err?.message ?? null)];
          const both = ['Business phones' + MARK, 'Business phones'];
          t.eq(
            said,
            how === 'stopped'
              ? [both, 2, 'Business phones', 'Business phones', 'stopped']
              : how === 'failed'
                ? [both, 0, 'Business phones', 'Business phone', 'You do not have permission to do this.']
                : how === 'server error'
                  ? [both, 1, 'Business phones', 'Business phones', null]
                  : how === 'answer lost'
                    ? [both, 2, 'Business phones', 'Business phones', 'Sent to Dataverse, but the result could not be checked. Reload to confirm it.']
                    : how === 'turned away' || how === 'publish turned away'
                      ? [both, 2, 'Business phones', 'Business phones', null]
                      : how === 'never taken'
                        ? [['Business phones' + MARK], 2, 'Business phones' + MARK, 'Business phones' + MARK, 'Rate limit exceeded.']
                        : [[], 0, 'Business phones', 'Business phone', 'stopped'],
            how,
          );
          if (how !== 'never taken') continue;
          // Publish again, Dataverse no longer busy: the label found with MARK, written as it is and published.
          f.F.patch = undefined;
          const again = await publishAgain(app, saved, [], undefined, undefined, missing).then(() => null, (e: unknown) => e as Error);
          t.eq([f.F.patches.slice(patches).map((x) => labelsIn(parseXml(x), 'c3')[EN]), r.R.posts.length - posts, f.own('c3')[EN], pubText(f, 'c3'), again?.message ?? null], [both, 4, 'Business phones', 'Business phones', null], 'Publish again takes MARK away');
        }
      }),
    ),
  );

  t.test("form labels: Publish again's repair (formxml.ts rewrite), per label: a text written back that Dataverse didn't take is written again after each wait, also one a PATCH refused twice left marked (a conflict on the marked text), never one someone else saved over since (theirs); one never taken is an error after its last try, the one its text written back gave, also where its first write said another; one taken keeps its first write's error; a first publish turned away for good (it never ran) is not sent again, one that may have run is, and a refused one is never retried", () =>
    fast(async () => {
      const slot = { key: 'field|f|c3|Label', kind: 'field', group: 'f' } as unknown as Slot;
      const c: Change = { slot, lcid: EN, before: 'Business phone', after: 'Business phones' };
      const T = 'Business phones';
      const ok = (x: Change): ChangeResult => ({ change: x, outcome: 'saved' });
      const err = (m: string) => (x: Change): ChangeResult => ({ change: x, outcome: 'error', message: m });
      const conflict = (server: string) => (x: Change): ChangeResult => ({ change: x, outcome: 'conflict', server, message: 'The form was changed by someone else while saving. Check it, then save again.' });
      /** rewrite with these answers to its writes in turn (the last one again), and these to its publishes (null: published): its writes, its publishes, its results or what it threw. */
      const run = async (answers: Array<(x: Change) => ChangeResult>, publishes: unknown[] = []) => {
        const writes: string[] = [];
        let w = 0;
        let p = 0;
        const write = async (list: Change[]) => list.map((x) => (writes.push(x.after), answers[Math.min(w++, answers.length - 1)](x)));
        const publish = async () => {
          const e = publishes[p++];
          if (e) throw e;
        };
        const out = await rewrite([c], publish, write).then(
          (rs) => rs.map((x) => [x.outcome, x.message ?? '', x.change === c]),
          (e: Error) => e.message,
        );
        return [writes, p, out];
      };
      const lock = new DvError('Cannot start another [Import] because there is a previous [Import] running at this moment.', 400);
      t.eq(await run([ok, err('Busy.'), err('Busy.'), ok]), [[T + MARK, T, T, T], 2, [['saved', '', true]]], 'turned away twice, then taken');
      t.eq(await run([ok, conflict(T + MARK), ok]), [[T + MARK, T, T], 2, [['saved', '', true]]], 'a PATCH refused twice on the marked text: written again');
      t.eq(await run([ok, conflict('Their phones')]), [[T + MARK, T], 2, [['conflict', 'The form was changed by someone else while saving. Check it, then save again.', true]]], "someone else's text since: theirs, never written again");
      t.eq(await run([ok, err('Busy.')]), [[T + MARK, T, T, T, T, T], 2, [['error', 'Busy.', true]]], 'never taken: an error after its last try');
      t.eq(await run([ok, conflict(T + MARK)]), [[T + MARK, T, T, T, T, T], 2, [['error', 'The form was changed by someone else while saving. Check it, then save again.', true]]], 'left marked after its last try: an error, never theirs');
      t.eq(await run([err('Sent.'), err('Busy.')]), [[T + MARK, T, T, T, T, T], 2, [['error', 'Busy.', true]]], "the first write's answer lost, its text written back never taken: that one's error");
      t.eq(await run([err('Sent.'), ok]), [[T + MARK, T], 2, [['error', 'Sent.', true]]], "the first write's answer lost, its text written back taken: the first one's error stays");
      t.eq(await run([ok, ok], [lock]), [[T + MARK, T], 1, lock.message], 'a first publish turned away for good never ran: not sent again');
      t.eq(await run([ok, ok], [new DvError('Generic SQL error.', 500)]), [[T + MARK, T], 2, [['saved', '', true]]], 'a first publish that may have run: sent again, and once it goes through, published');
      t.eq(await run([ok, ok], [new DvError('Generic SQL error.', 500), new DvError('Generic SQL error.', 500), new DvError('Generic SQL error.', 500), new DvError('Generic SQL error.', 500)]), [[T + MARK, T], 4, 'Generic SQL error.'], "sent again after each wait while it may not have got through, then the first one's error");
      t.eq(await run([ok, ok], [null, new DvError('You do not have permission to do this.', 403)]), [[T + MARK, T], 2, 'You do not have permission to do this.'], 'a publish after the text written back refused: never sent again');
      t.eq(await run([ok, ok], [null, lock, lock]), [[T + MARK, T], 4, [['saved', '', true]]], 'one turned away past its waits: sent again until it goes through');
    }),
  );

  t.test("form labels: what the repair's writes told before it failed is still told (ui/review.ts publishAgain, Told): the Checking step's repair says it with its error, and Publish again keeps it for its caller", () =>
    withStorage(async () => {
      const f = formFake(MAIN, { cols: COLS });
      const r = await saverRig(f);
      const { app } = reviewApp(f, r);
      f.F.stick.add(`c3#${EN}`);
      r.store.set(r.cell('c3').key, EN, 'Business phones');
      const saved = (await r.save()).results.map((x) => x.change);
      // A write of the repair tells of a label Dataverse dropped that could not be put back, then the repair fails.
      const lost = droppedLeft('Information', [{ lang: 'French', text: 'Téléphone' }]);
      const writeAgain = async (cs: Change[], _p: unknown, _s: unknown, warn?: (m: string, level: 'warning' | 'notice') => void): Promise<ChangeResult[]> => {
        warn?.(lost, 'warning');
        return cs.map((change): ChangeResult => ({ change, outcome: 'error', message: 'Rate limit exceeded.' }));
      };
      const failing = { ...app, saver: { ...app.saver, writeAgain } } as unknown as AppApi;
      const got = await checkRepaired(failing, saved, [], undefined, { repair() {}, now() {}, check() {} });
      t.eq([got.repaired, !!got.error, got.said.warning ?? null], [true, true, lost], 'the Checking step');
      const told = { warning: [] as string[], notice: [] as string[] };
      const err = await publishAgain(failing, saved, [], undefined, undefined, got.found.missing, told).then(() => null, (e: Error) => e.message);
      t.eq([err, told.warning], ['Rate limit exceeded.', [lost]], 'Publish again');
    }),
  );

  // ---- an emptied field label, saved as 1.0.0 saves it, and its Undo ----

  t.test("form labels: an emptied French field label is saved as 1.0.0 saves it: its column's French name written as the label's own text (its stand-in), on the cell's own key, every other label as it was; a later rename leaves it as it is; its Undo writes the text from before, on the same key", () =>
    withStorage(async () => {
      const f = formFake(MAIN, { cols: COLS });
      const r = await saverRig(f);
      r.store.set(r.cell('c2').key, FR, '');
      const rep = await r.save();
      t.eq(rep.results.map((x) => [x.outcome, x.change.after, x.change.standIn?.from ?? null]), [['saved', 'Courriel', 'column']]);
      t.eq([labelsIn(parseXml(f.F.patches[0]), 'c2'), keyIn(f.F.patches[0], 'c2'), f.key('c2')], [{ [FR]: 'Courriel' }, '', 'c2'], 'its stand-in posted, on its own key');
      t.eq([f.own('c2'), f.own('c1'), f.own('c3')], [{ [EN]: 'E-mail', [FR]: 'Courriel' }, { [EN]: 'Name', [FR]: 'Nom' }, { [EN]: 'Business phone' }], "stored as the label's own; nothing else moved");
      const [saved] = readHistory(f.ctx);
      t.eq(saved.items.map((it) => [it.lcid, it.before, it.after]), [[FR, 'Adresse e-mail', 'Courriel']], 'journaled as written');
      f.rename('emailaddress1', FR, 'Courriel 2');
      t.eq(f.label('c2')[FR], 'Courriel', 'a text of its own: a rename leaves it');
      const undo = await r.undo(saved);
      t.eq(undo.results.map((x) => [x.outcome, x.change.before, x.change.after]), [['saved', 'Courriel', 'Adresse e-mail']]);
      t.eq([labelsIn(parseXml(f.F.patches[1]), 'c2'), keyIn(f.F.patches[1], 'c2'), f.own('c2'), !!readHistory(f.ctx).find((e) => e.id === saved.id)?.undoneAt], [{ [FR]: 'Adresse e-mail' }, '', { [EN]: 'E-mail', [FR]: 'Adresse e-mail' }, true], 'the text from before, on the same key');
    }),
  );

  t.test("form labels: an emptied English field label is refused as 1.0.0 refuses it: the save warns that it clears the English text, Dataverse keeps the label (LIVE-FINDINGS 104), and the change is an error saying so; nothing is journaled, the cell stays on its own key, every other label as it was", () =>
    withStorage(async () => {
      const f = formFake(MAIN, { cols: COLS });
      const r = await saverRig(f);
      r.store.set(r.cell('c2').key, EN, '');
      t.eq(r.saver.validate(r.store.changes()).map((x) => [x.level, x.message]), [['warn', 'Clears the English text.']]);
      const rep = await r.save();
      t.eq(rep.results.map((x) => [x.outcome, x.message ?? '']), [['error', 'Dataverse did not keep this label. Reload the form to see what is saved.']]);
      t.eq([f.own('c2'), f.key('c2'), f.own('c1'), readHistory(f.ctx).length], [{ [EN]: 'E-mail', [FR]: 'Adresse e-mail' }, 'c2', { [EN]: 'Name', [FR]: 'Nom' }, 0]);
    }),
  );

  t.test("form labels: a field's last label of its own emptied (model.ts freesAll), the base language's too, shows as following its column (“Shows …”, no note, no warning) and is saved by giving its cell a new label key with no label on it (LIVE-FINDINGS 105): it then follows its column in every language, a rename in the same publish and a later one included; a deadlock's victim is turned away (tried again)", () =>
    withStorage(async () => {
      const ONE =
        `<form><tabs><tab id="{a1}" name="general"><labels>${L(EN, 'General')}</labels><columns><column width="100%"><sections><section id="{b1}" name="details"><labels>${L(EN, 'Details')}</labels><rows>` +
        row('c8', 'id="fax" datafieldname="fax"', L(FR, 'Télécopie')) +
        row('c3', 'id="telephone1" datafieldname="telephone1"', L(EN, 'Business phone')) +
        `</rows></section></sections></column></columns></tab></tabs></form>`;
      const f = formFake(ONE, { cols: COLS });
      const r = await saverRig(f);
      // Fax: English follows its column, French is a copy of the column's French name stored as the form's own.
      // Phone: English is the form's own, French follows its column.
      t.eq([r.cell('c8').ref.own, r.cell('c3').ref.own], [{ [EN]: false, [FR]: true }, { [EN]: true, [FR]: false }]);
      r.store.set(r.cell('c8').key, FR, '');
      r.store.set(r.cell('c3').key, EN, '');
      const fax = r.cell('c8');
      const phone = r.cell('c3');
      t.eq(
        [placeholderOf(r.store, fax, FR, EN, 'Form label', 'French'), becomes(r.store, fax, FR, EN), placeholderOf(r.store, phone, EN, EN, 'Form label', 'English'), r.saver.validate(r.store.changes())],
        ['Shows “Télécopie”', '', 'Shows “Phone”', []],
        'shown as following, nothing said against it',
      );
      // The French column renamed in the same publish.
      r.store.set(r.col('fax').key, FR, 'Télécopieur');
      const rep = await r.save();
      t.eq(rep.results.map((x) => [x.change.slot.kind, x.change.lcid, x.outcome]).sort(), [['attribute', FR, 'saved'], ['field', EN, 'saved'], ['field', FR, 'saved']].sort());
      const sent = f.F.patches.at(-1)!;
      t.eq([labelsIn(parseXml(sent), 'c8'), labelsIn(parseXml(sent), 'c3'), keyIn(sent, 'c8') !== '' && keyIn(sent, 'c8') !== 'c8', keyIn(sent, 'c3') !== '' && keyIn(sent, 'c3') !== 'c3'], [{}, {}, true, true], 'each on a new key, no label posted');
      t.eq([f.own('c8'), f.own('c3'), f.label('c8'), f.label('c3')], [{}, {}, { [EN]: 'Fax', [FR]: 'Télécopieur' }, { [EN]: 'Phone', [FR]: 'Téléphone' }], 'both follow their column in every language');
      f.rename('fax', FR, 'Télécopieur 2');
      f.rename('telephone1', EN, 'Main phone');
      t.eq([f.label('c8')[FR], f.label('c3')[EN]], ['Télécopieur 2', 'Main phone'], 'a later rename shows on the form');
      const deadlock = new DvError('Transaction (Process ID 333) was deadlocked on lock resources with another process and has been chosen as the deadlock victim. Rerun the transaction.', 500);
      t.eq([turnedAway(deadlock), isLockError(deadlock)], [true, true], 'a deadlock is tried again');
    }),
  );

  t.test("form labels: a field's last label of its own emptied goes on a new label key only on a form as it was loaded (its versions agreeing at the save's first read), as which of its labels are its own is known only then: a form someone saved since (a label of theirs in another language, one worded as its column's name a form designer save stores, LIVE-FINDINGS 109, a new key of theirs, with a label or without) is an error saying so, nothing written, the cell on its key; a following language its column is renamed in by the same save still follows", () =>
    withStorage(async () => {
      const ONE =
        `<form><tabs><tab id="{a1}" name="general"><labels>${L(EN, 'General')}</labels><columns><column width="100%"><sections><section id="{b1}" name="details"><labels>${L(EN, 'Details')}</labels><rows>` +
        row('c8', 'id="fax" datafieldname="fax"', L(FR, 'Télécopie')) +
        row('c3', 'id="telephone1" datafieldname="telephone1"', L(EN, 'Business phone')) +
        `</rows></section></sections></column></columns></tab></tabs></form>`;
      /** The phone field (English its own, French following its column) emptied in English, then `theirs` saved by someone else in the form designer. */
      const phone = async (theirs?: (d: Document) => void) => {
        const f = formFake(ONE, { cols: COLS });
        const r = await saverRig(f);
        r.store.set(r.cell('c3').key, EN, '');
        if (theirs) f.designerSave(theirs);
        return { f, r };
      };
      {
        const { f, r } = await phone((d) => setLabels(d, 'c3', { [EN]: 'Business phone', [FR]: 'Téléphone pro' }));
        f.publish();
        const rep = await r.save();
        t.eq(rep.results.map((x) => [x.outcome, x.message ?? '']), [['error', CHANGED]], 'their French label');
        t.eq([f.key('c3'), f.own('c3')[FR], r.store.isEdited(r.cell('c3').key, EN)], ['c3', 'Téléphone pro', true], 'on its key, theirs kept, still staged');
      }
      {
        const f = formFake(MAIN, { cols: COLS });
        const r = await saverRig(f);
        r.store.set(r.cell('c2').key, EN, '');
        r.store.set(r.cell('c2').key, FR, '');
        f.designerSave((d) => setLabels(d, 'c2', { [EN]: 'E-mail', [FR]: 'Courriel pro' }));
        const rep = await r.save();
        t.eq(rep.results.map((x) => [x.change.lcid, x.outcome]).sort(), [[EN, 'error'], [FR, 'error']], 'both emptied, their French');
        t.eq([f.key('c2'), f.own('c2')[FR]], ['c2', 'Courriel pro'], 'on its key, theirs kept');
      }
      {
        const { f, r } = await phone(() => undefined);
        f.publish();
        t.eq(f.own('c3'), { [EN]: 'Business phone', [FR]: 'Téléphone' }, 'their save stored the French its column shows as its own');
        const rep = await r.save();
        t.eq(rep.results.map((x) => [x.outcome, x.message ?? '']), [['error', CHANGED]], 'their French label worded as its column');
        t.eq([f.key('c3'), f.own('c3')[FR]], ['c3', 'Téléphone'], 'on its key, theirs kept');
      }
      {
        const { f, r } = await phone((d) => moveKey(d, 'c3', FR));
        const rep = await r.save();
        t.eq(rep.results.map((x) => [x.outcome, x.message ?? '']), [['error', CHANGED]], 'their new key with their English label');
        t.eq(f.own('c3'), { [EN]: 'Business phone' }, 'theirs kept');
      }
      {
        const { r } = await phone((d) => moveKey(d, 'c3', EN));
        const rep = await r.save();
        t.eq(rep.results.map((x) => x.outcome), ['error'], 'their new key, its labels not known');
      }
      {
        const { f, r } = await phone();
        r.store.set(r.col('telephone1').key, FR, 'Téléphone 2');
        const rep = await r.save();
        t.eq(rep.results.map((x) => [x.change.slot.kind, x.outcome]).sort(), [['attribute', 'saved'], ['field', 'saved']]);
        t.eq([f.own('c3'), f.label('c3')], [{}, { [EN]: 'Phone', [FR]: 'Téléphone 2' }], 'renamed in French by the same save: follows');
      }
    }),
  );

  t.test("form labels: Undo of a save a 1.1.0 development build journaled, its items with fields this version doesn't know (`removed`, `follows`, `own`): each writes the text from before as the label's own, on the key the cell is on (one that build moved stays on its new key, LIVE-FINDINGS 105), never moving a cell", () =>
    withStorage(async () => {
      const f = formFake(MAIN, { cols: COLS });
      const r = await saverRig(f);
      // What that build left: the email field's French removed (its cell on a new key, its French following the column),
      // and the phone field's French, which followed its column, typed over.
      f.designerSave((d) => (moveKey(d, 'c2', FR), relabel(d, 'c3', FR, 'Tél. pro')));
      const item = (id: string, before: string, after: string, old: object) => ({ key: r.cell(id).key, comp: r.cell(id).comp, kind: 'field', lcid: FR, title: r.cell(id).title, before, after, ...old });
      const entry = { id: 'dev-1', at: Date.now(), published: true, items: [item('c2', 'Adresse e-mail', 'Courriel', { removed: 'column' }), item('c3', 'Téléphone', 'Tél. pro', { follows: true, own: true })] } as unknown as HistoryEntry;
      await addHistory(f.ctx, entry);
      const rep = await r.undo(entry);
      t.eq(rep.results.map((x) => [x.change.slot.ref.elId, x.outcome, x.change.before, x.change.after]), [['c2', 'saved', 'Courriel', 'Adresse e-mail'], ['c3', 'saved', 'Tél. pro', 'Téléphone']]);
      t.eq([f.F.patches.length, keyIn(f.F.patches[0], 'c2'), labelsIn(parseXml(f.F.patches[0]), 'c2'), labelsIn(parseXml(f.F.patches[0]), 'c3')], [1, MOVED, { [FR]: 'Adresse e-mail' }, { [FR]: 'Téléphone' }], 'one write, the cell on the key it is on');
      t.eq([f.key('c2'), f.own('c2'), f.own('c3'), !!readHistory(f.ctx).find((e) => e.id === entry.id)?.undoneAt], [MOVED, { [EN]: 'E-mail', [FR]: 'Adresse e-mail' }, { [EN]: 'Business phone', [FR]: 'Téléphone' }, true]);
    }),
  );
}
