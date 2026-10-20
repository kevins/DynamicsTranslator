// Dataverse Web API client: same-origin fetch with the user's session cookie,
// bounded concurrency, and retries that are safe for the request type.

export class DvError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = '',
    readonly url = '',
    /** The answer's x-ms-service-request-id ('' when none): what Microsoft support asks for. */
    readonly requestId = '',
    /**
     * The answer to a write as a whole (Http.req: not a GET, not a $batch of reads), never a part's answer inside a $batch:
     * whether a 503 says the write did not run depends on it (turnedAway).
     */
    readonly write = false,
    /** The seconds the answer's Retry-After asked to wait (0 when it named none). */
    readonly retryAfter = 0,
  ) {
    super(message);
    this.name = 'DvError';
  }
}

export interface RequestOptions {
  headers?: Record<string, string>;
  body?: unknown;
  /** Raw body (e.g. multipart $batch). When set, `body` is ignored. */
  raw?: string;
  signal?: AbortSignal;
  /** Annotations to request, e.g. 'OData.Community.Display.V1.FormattedValue' or '*'. */
  annotations?: string;
  /** Page size for collection GETs. */
  maxPageSize?: number;
  /** Return headers (and the status) too: `{ data, headers, status }`. */
  withHeaders?: boolean;
  /** Return the response body as text instead of parsing it as JSON (multipart $batch answers). */
  text?: boolean;
  /**
   * A non-GET request that is safe to send twice (a $batch of reads): it gets the read slots and the read
   * retries (network failures and gateway errors too).
   */
  idempotent?: boolean;
  /**
   * Never sent again, not even when Dataverse turned it away unrun (throttled): a label or form write built from a
   * read made just before it. Its caller reads afresh before trying again, so a write never goes out minutes after
   * the read it carries (every language of a label, or a whole form definition, as read then).
   */
  once?: boolean;
  /**
   * Called right before each attempt goes out (after any wait for a slot or a throttled retry): from then on the
   * server may run it (LangSession counts a lost answer's time from there).
   */
  onSend?: () => void;
  /**
   * A $batch sent without continue-on-error: an answer that is not 2xx but holds the parts' answers (multipart) is
   * returned, not thrown, so the caller reads which part failed and whether the ones before it ran.
   */
  parts?: boolean;
}

/** One request inside a $batch. */
export interface BatchPart {
  method: Method;
  /** Relative to the Web API root, or absolute. */
  url: string;
  headers?: Record<string, string>;
  /** JSON body (PATCH, POST, PUT). */
  body?: unknown;
}

/** The answer to one $batch part. */
export interface PartResult {
  ok: boolean;
  /** HTTP status of the part; 0 when the part's answer was missing or unreadable. */
  status: number;
  /** Parsed JSON body (null for none, e.g. 204). */
  data: any;
  /** Dataverse's message and code for a failed part. */
  error?: string;
  code?: string;
  /** Part headers, lower-cased names. */
  headers: Record<string, string>;
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Counting semaphore. */
class Gate {
  private q: Array<() => void> = [];
  private n = 0;
  constructor(public max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.n >= this.max) await new Promise<void>((r) => this.q.push(r));
    this.n++;
    try {
      return await fn();
    } finally {
      this.n--;
      this.q.shift()?.();
    }
  }
}

/** Waits `ms`; rejects with an AbortError when `signal` aborts first (its listener goes when the wait ends). */
export const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const stop = () => (clearTimeout(t), reject(abortError()));
    const t = setTimeout(() => (signal?.removeEventListener('abort', stop), resolve()), ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
const sleep = pause;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export const abortError = () => new DOMException('The operation was cancelled.', 'AbortError');
export const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/**
 * Dataverse turned the request away without running it: throttled (429, 503) or another customization holds the
 * org-wide lock (0x80071151, finding 4). A write that got this is safe to try again, from a fresh read. A write answered
 * 503 as a whole without Retry-After is not turned away: a 503 alone says nothing of what ran (a gateway gives up with
 * it while Dataverse goes on: a POST that hung ~2 min, LIVE-FINDINGS 71), so it may have run (mayHaveRun). A read's 503
 * changed nothing, and a part's is Dataverse's own answer for that part: both still are.
 */
export const turnedAway = (e: unknown): boolean =>
  e instanceof DvError &&
  (e.status === 429 || (e.status === 503 && (!e.write || e.retryAfter > 0)) || /cannot start another|0x80071151|customizationlock|another \[/i.test(`${e.message} ${e.code}`));

/**
 * A write that failed may still have run: its answer was lost (network failure, gateway or server error, a 503 that
 * named no Retry-After, an unreadable answer). Its component is then published with the rest, so a write that landed
 * shows once a later attempt finds it already there ('unchanged').
 */
export const mayHaveRun = (e: unknown): boolean => !isAbort(e) && (!(e instanceof DvError) || ((e.status === 0 || e.status >= 500) && !turnedAway(e)));

export interface HttpStats {
  requests: number;
  failures: number;
  ms: number;
}

export class Http {
  readonly api: string;
  readonly reads = new Gate(8);
  readonly writes = new Gate(4);
  readonly stats: HttpStats = { requests: 0, failures: 0, ms: 0 };

  constructor(
    readonly origin: string,
    version = '9.2',
  ) {
    this.api = `${origin.replace(/\/+$/, '')}/api/data/v${version}/`;
  }

  get<T = any>(path: string, o: RequestOptions = {}): Promise<T> {
    return this.req<T>('GET', path, o);
  }
  post<T = any>(path: string, body?: unknown, o: RequestOptions = {}): Promise<T> {
    return this.req<T>('POST', path, { ...o, body });
  }
  patch<T = any>(path: string, body: unknown, o: RequestOptions = {}): Promise<T> {
    return this.req<T>('PATCH', path, { ...o, body });
  }
  put<T = any>(path: string, body: unknown, o: RequestOptions = {}): Promise<T> {
    return this.req<T>('PUT', path, { ...o, body });
  }
  del<T = any>(path: string, o: RequestOptions = {}): Promise<T> {
    return this.req<T>('DELETE', path, o);
  }

  /**
   * Follows @odata.nextLink and returns every row. Throws when an answer isn't a collection (its `value` an array; a
   * nextLink, if any, an address of this site not followed before): one that can't be read never reads as no rows (a
   * publish's check for pending work would say there is none).
   */
  async all<T = any>(path: string, o: RequestOptions = {}): Promise<T[]> {
    const out: T[] = [];
    const seen = new Set<string>([this.url(path)]);
    let next = path;
    while (next) {
      const url = next;
      const page: unknown = await this.get(url, o);
      const rows = isRecord(page) ? page.value : undefined;
      const link = isRecord(page) ? page['@odata.nextLink'] : undefined;
      next = link == null ? '' : this.nextLink(link, seen);
      if (!Array.isArray(rows) || (link != null && !next))
        throw new DvError('Dataverse sent an answer that could not be read (not a list of rows).', 0, 'unreadable', this.url(url));
      out.push(...(rows as T[]));
    }
    return out;
  }

  /** The address a nextLink names when it is one of this site's, not followed before (`seen` keeps them); '' otherwise. */
  private nextLink(link: unknown, seen: Set<string>): string {
    if (typeof link !== 'string' || !link) return '';
    const url = this.url(link);
    let site = false;
    try {
      site = new URL(url).origin === new URL(this.api).origin;
    } catch {
      site = false;
    }
    if (!site || seen.has(url)) return '';
    seen.add(url);
    return url;
  }

  /** The address of a path: relative to the Web API root, or absolute. */
  private url(path: string): string {
    return /^https?:/i.test(path) ? path : this.api + path;
  }

  /**
   * Sends `parts` as one multipart $batch and returns one result per part, in order. Always with
   * `Prefer: odata.continue-on-error`: without it Dataverse stops at the first failing part, so a part that
   * must run whatever happens before it (LangSession's switch back of the UI language) would be skipped
   * (LIVE-FINDINGS 49). Parts run one after another on the server, in the order given. Throws only when the
   * batch as a whole failed; failed parts come back with `ok: false`. `stop`: without continue-on-error, so a
   * write placed after a read that checks it is never sent when that read fails (LIVE-FINDINGS 49); the parts
   * after a failed one come back with status 0, also when the stopped batch is answered with an error status as a whole.
   */
  async batch(parts: BatchPart[], o: { signal?: AbortSignal; idempotent?: boolean; once?: boolean; stop?: boolean; onSend?: () => void } = {}): Promise<PartResult[]> {
    const b = `batch_${crypto.randomUUID()}`;
    const r = await this.req<{ data: string; headers: Headers }>('POST', '$batch', {
      raw: buildBatch(this.api, b, parts),
      text: true,
      withHeaders: true,
      signal: o.signal,
      idempotent: o.idempotent,
      once: o.once,
      onSend: o.onSend,
      parts: o.stop,
      headers: { 'Content-Type': `multipart/mixed; boundary=${b}`, ...(o.stop ? {} : { Prefer: CONTINUE }) },
    });
    const out = parseBatch(r.data, r.headers.get('Content-Type') || '').slice(0, parts.length);
    while (out.length < parts.length) out.push({ ok: false, status: 0, data: null, error: 'Dataverse sent no answer for this part of the request.', headers: {} });
    return out;
  }

  /**
   * Sends one request. GETs are retried on throttling, gateway errors and network failures.
   * Writes are retried only when the server says it did not process them (429 / 503 with Retry-After),
   * so a write is never applied twice; a write sent `once` is not retried at all (its caller reads again first).
   *
   * Every request is sent with `cache: 'no-store'`. That is load-bearing, not hygiene: form XML (and other
   * language-sensitive answers) carry the same ETag in every UI language, so a cached GET answered 304 with
   * the body of the other language (the same trap as LIVE-FINDINGS 84). And with `x-ms-sw-skipcache: 1`, which
   * UCI's service worker checks first and then leaves the request alone, so none of its stale-while-revalidate
   * caches (usersettings and organizations on API v9.0) can answer a read (LIVE-FINDINGS 66).
   */
  async req<T = any>(method: Method, path: string, o: RequestOptions = {}): Promise<T> {
    const url = this.url(path);
    const read = method === 'GET' || !!o.idempotent;
    const gate = read ? this.reads : this.writes;
    return gate.run(async () => {
      for (let attempt = 0; ; attempt++) {
        if (o.signal?.aborted) throw abortError();
        const prefer: string[] = [];
        if (o.annotations) prefer.push(`odata.include-annotations="${o.annotations}"`);
        if (o.maxPageSize) prefer.push(`odata.maxpagesize=${o.maxPageSize}`);
        const headers: Record<string, string> = {
          Accept: 'application/json',
          'OData-MaxVersion': '4.0',
          'OData-Version': '4.0',
          'x-ms-sw-skipcache': '1',
          ...(prefer.length ? { Prefer: prefer.join(',') } : {}),
          ...(o.raw === undefined && o.body !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
          ...o.headers,
        };
        const t0 = performance.now();
        let res: Response;
        try {
          this.stats.requests++;
          o.onSend?.();
          res = await fetch(url, {
            method,
            headers,
            credentials: 'same-origin',
            cache: 'no-store',
            body: o.raw !== undefined ? o.raw : o.body !== undefined ? JSON.stringify(o.body) : undefined,
            signal: o.signal,
          });
        } catch (e) {
          this.stats.ms += performance.now() - t0;
          if (isAbort(e) || o.signal?.aborted) throw abortError();
          this.stats.failures++;
          // A failed write may or may not have reached the server, so only reads are retried.
          if (read && attempt < 3) {
            await sleep(400 * 2 ** attempt, o.signal);
            continue;
          }
          throw new DvError(`Could not reach Dataverse (${(e as Error).message || 'network error'}).`, 0, 'network', url);
        }
        this.stats.ms += performance.now() - t0;
        if (res.ok) {
          const text = res.status === 204 ? '' : await res.text();
          const data = o.text ? text : text ? JSON.parse(text) : {};
          if (o.withHeaders) return { data, headers: res.headers, status: res.status } as T;
          return data as T;
        }
        this.stats.failures++;
        // A $batch stopped at a failed part may be answered with an error status as a whole, its body still the answers
        // of the parts up to that one: those are what the caller reads (Http.batch `stop`), never one error for all.
        if (o.parts && o.text && o.withHeaders && /^multipart\/mixed/i.test(res.headers.get('Content-Type') || '')) return { data: await res.text(), headers: res.headers, status: res.status } as T;
        const retryAfter = Number(res.headers.get('Retry-After'));
        const throttled = res.status === 429 || (res.status === 503 && retryAfter > 0);
        if (((throttled && !o.once) || (read && (res.status === 502 || res.status === 504))) && attempt < 5) {
          await sleep(Math.min(30, retryAfter > 0 ? retryAfter : 2 ** attempt) * 1000, o.signal);
          continue;
        }
        throw await toError(res, url, !read, retryAfter > 0 ? retryAfter : 0);
      }
    });
  }

  /**
   * Builds a function URL with parameter aliases, e.g.
   * fn('RetrieveLocLabels', { EntityMoniker: {...}, AttributeName: 'name', IncludeUnpublished: true })
   */
  fn(name: string, params: Record<string, unknown> = {}, bound = ''): string {
    const keys = Object.keys(params);
    const sig = keys.map((k, i) => `${k}=@p${i}`).join(',');
    const qs = keys.map((k, i) => `@p${i}=${encodeURIComponent(literal(params[k]))}`).join('&');
    return `${bound ? bound + '/' : ''}${name}(${sig})${qs ? '?' + qs : ''}`;
  }
}

/** OData literal for a function parameter alias. */
function literal(v: unknown): string {
  if (typeof v === 'string') {
    if (/^Microsoft\.Dynamics\.CRM\.\w+'.*'$/.test(v)) return v; // enum literal already formatted
    return `'${v.replace(/'/g, "''")}'`;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

async function toError(res: Response, url: string, write: boolean, retryAfter: number): Promise<DvError> {
  let msg = '';
  let code = '';
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      msg = j?.error?.message || '';
      code = j?.error?.code || '';
    } catch {
      msg = t.slice(0, 300);
    }
  } catch {
    /* body unreadable */
  }
  if (res.status === 401) msg = 'Your Dynamics session has expired. Reload the page and sign in again.';
  if (res.status === 403 && !msg) msg = 'You do not have permission to do this.';
  return new DvError(msg || `Dataverse returned HTTP ${res.status}.`, res.status, code, url, res.headers.get('x-ms-service-request-id') || '', write, retryAfter);
}

// ---- $batch ----

const NL = '\r\n';
/** Every $batch the translator sends carries it (see Http.batch). */
export const CONTINUE = 'odata.continue-on-error';

/**
 * JSON with every non-ASCII character escaped (é). A $batch part has no charset of its own, so its body is
 * kept pure ASCII: the server's JSON reader turns the escapes back into exactly the typed characters.
 */
export const asciiJson = (v: unknown): string => JSON.stringify(v).replace(/[^\x00-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

/**
 * Control characters (CR and LF above all). fetch() drops or encodes them in a URL, but a $batch part's request line and
 * headers go into the body exactly as written, where a line break would start another header or end the part's head.
 */
const CTL = /[\x00-\x1f\x7f]/;

/**
 * The multipart/mixed body of a $batch (no changesets: each part runs on its own, in order). Throws, sending nothing,
 * when a part's URL or a header holds a control character: such a part would not say what it seems to.
 */
export function buildBatch(api: string, boundary: string, parts: BatchPart[]): string {
  const abs = (u: string) => (/^https?:/i.test(u) ? u : api + u);
  for (const p of parts)
    if (CTL.test(p.url) || Object.entries(p.headers || {}).some(([k, v]) => CTL.test(k) || CTL.test(String(v))))
      // 400, as a refusal: nothing was sent, so nothing may have run (mayHaveRun) and no answer is waited for.
      throw new DvError('A request was not sent: it holds a control character where none can be.', 400, 'batch-part');
  return (
    parts
      .map((p) => {
        const head = [
          `${p.method} ${abs(p.url)} HTTP/1.1`,
          'Accept: application/json',
          ...(p.body !== undefined ? ['Content-Type: application/json'] : []),
          ...Object.entries(p.headers || {}).map(([k, v]) => `${k}: ${v}`),
        ];
        return `--${boundary}${NL}Content-Type: application/http${NL}Content-Transfer-Encoding: binary${NL}${NL}${head.join(NL)}${NL}${NL}${p.body !== undefined ? asciiJson(p.body) : ''}`;
      })
      .join(NL) + `${NL}--${boundary}--${NL}`
  );
}

/** Splits a multipart/mixed $batch answer into one result per part (answers come in request order). */
export function parseBatch(text: string, contentType: string): PartResult[] {
  const b = /boundary="?([^";\s]+)/i.exec(contentType)?.[1];
  if (!b) throw new DvError('Dataverse sent an unexpected answer to a batch request.', 0, 'batch');
  const out: PartResult[] = [];
  for (const seg of text.split('--' + b)) {
    const m = /^HTTP\/\d(?:\.\d)? (\d{3})[^\r\n]*$/m.exec(seg);
    if (!m) continue; // preamble and closing delimiter
    const rest = seg.slice(m.index + m[0].length);
    const j = rest.search(/\r?\n\r?\n/);
    const headers: Record<string, string> = {};
    for (const line of (j < 0 ? rest : rest.slice(0, j)).split(/\r?\n/)) {
      const k = line.indexOf(':');
      if (k > 0) headers[line.slice(0, k).trim().toLowerCase()] = line.slice(k + 1).trim();
    }
    const raw = j < 0 ? '' : rest.slice(j).trim();
    const status = Number(m[1]);
    let data: any = null;
    try {
      if (raw) data = JSON.parse(raw);
    } catch {
      out.push({ ok: false, status: 0, data: null, error: 'Dataverse sent an unreadable answer.', headers });
      continue;
    }
    out.push(
      status < 300
        ? { ok: true, status, data, headers }
        : { ok: false, status, data, error: data?.error?.message || `Dataverse returned HTTP ${status}.`, code: data?.error?.code || '', headers },
    );
  }
  return out;
}

/** A failed $batch part as an error, for messages and isLockError(). */
export const partError = (r: PartResult): DvError => new DvError(r.error || `Dataverse returned HTTP ${r.status}.`, r.status, r.code || '');

/** Removes braces and lower-cases a GUID. */
export const guid = (s: unknown): string => String(s ?? '').replace(/[{}]/g, '').toLowerCase();

/** A GUID as guid() returns it: what an id taken from the page or a file must be before it goes into a URL. */
export const isGuid = (s: string): boolean => /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(s);

/**
 * A table's logical name: lower-case letters, digits and underscores, as Dataverse makes them. A name from a file or
 * the page that isn't one never goes into a URL, where q() alone would let `%27`, `#` or `?` change what is asked for.
 */
export const isLogicalName = (s: string): boolean => /^[a-z\d_]{1,128}$/.test(s);

/** Escapes a string for use inside an OData single-quoted literal. */
export const q = (s: string): string => s.replace(/'/g, "''");
