// Many small GETs in few round trips: multipart/mixed $batch requests of up to 100 parts.
// Dataverse runs the parts of one batch one after another, so the work is spread over the read
// slots; any part the batch could not answer (throttled, unreadable, batch failed) is sent on its
// own through Http.get, which has the retry logic.

import { DvError, Http, abortError, isAbort } from './http';

export interface BatchResult<T = any> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

const NL = '\r\n';
const again = (r?: BatchResult) => !r || [0, 429, 502, 503, 504].includes(r.status);

/** GETs `paths` (relative to the Web API root, or absolute) and returns one result per path, in input order. */
export async function batchGet<T = any>(
  http: Http,
  paths: string[],
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<Array<BatchResult<T>>> {
  const size = Math.min(100, Math.max(10, Math.ceil(paths.length / http.reads.max)));
  const jobs: Array<Promise<Array<BatchResult<T>>>> = [];
  let done = 0;
  for (let i = 0; i < paths.length; i += size) {
    const part = paths.slice(i, i + size);
    jobs.push(chunk<T>(http, part, signal).then((r) => (onProgress?.((done += part.length), paths.length), r)));
  }
  return (await Promise.all(jobs)).flat();
}

async function chunk<T>(http: Http, paths: string[], signal?: AbortSignal): Promise<Array<BatchResult<T>>> {
  let res: Array<BatchResult<T>> = [];
  if (paths.length > 1) {
    try {
      res = await send<T>(http, paths, signal);
    } catch (e) {
      if (isAbort(e) || signal?.aborted) throw abortError();
      // An expired session would fail every single request the same way.
      if (e instanceof DvError && e.status === 401) return paths.map(() => ({ ok: false, status: 401, error: 'Your Dynamics session has expired. Reload the page and sign in again.' }));
      if (__DEV__) console.warn('[translator] $batch failed; sending the requests one by one', e);
    }
  }
  return Promise.all(paths.map((p, i) => (again(res[i]) ? one<T>(http, p, signal) : res[i])));
}

async function one<T>(http: Http, path: string, signal?: AbortSignal): Promise<BatchResult<T>> {
  try {
    return { ok: true, status: 200, data: await http.get<T>(path, { signal }) };
  } catch (e) {
    if (isAbort(e) || signal?.aborted) throw abortError();
    return { ok: false, status: e instanceof DvError ? e.status : 0, error: (e as Error)?.message || String(e) };
  }
}

function send<T>(http: Http, paths: string[], signal?: AbortSignal): Promise<Array<BatchResult<T>>> {
  const b = `batch_${crypto.randomUUID()}`;
  const body =
    paths
      .map((p) => `--${b}${NL}Content-Type: application/http${NL}Content-Transfer-Encoding: binary${NL}${NL}GET ${/^https?:/i.test(p) ? p : http.api + p} HTTP/1.1${NL}Accept: application/json${NL}${NL}`)
      .join(NL) + `${NL}--${b}--${NL}`;
  return http.reads.run(async () => {
    if (signal?.aborted) throw abortError();
    const t0 = performance.now();
    http.stats.requests++;
    try {
      const r = await fetch(http.api + '$batch', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
        body,
        headers: {
          Accept: 'application/json',
          'OData-MaxVersion': '4.0',
          'OData-Version': '4.0',
          'Content-Type': `multipart/mixed; boundary=${b}`,
          // Without it the batch stops at the first failing part.
          Prefer: 'odata.continue-on-error',
        },
      });
      if (!r.ok) throw new DvError(`$batch returned HTTP ${r.status}.`, r.status);
      return parse<T>(await r.text(), r.headers.get('Content-Type') || '');
    } catch (e) {
      http.stats.failures++;
      throw e;
    } finally {
      http.stats.ms += performance.now() - t0;
    }
  });
}

/** Splits a multipart/mixed response into one result per part (responses come in request order). */
function parse<T>(text: string, type: string): Array<BatchResult<T>> {
  const b = /boundary="?([^";]+)/i.exec(type)?.[1];
  if (!b) throw new Error('Unexpected $batch response.');
  const out: Array<BatchResult<T>> = [];
  for (const seg of text.split('--' + b)) {
    const m = /^HTTP\/\d\.\d (\d{3})/m.exec(seg);
    if (!m) continue; // preamble and closing delimiter
    const rest = seg.slice(m.index);
    const j = rest.search(/\r?\n\r?\n/);
    const raw = j < 0 ? '' : rest.slice(j).trim();
    const status = Number(m[1]);
    let data: any = {};
    try {
      if (raw) data = JSON.parse(raw);
    } catch {
      out.push({ ok: false, status: 0 }); // unreadable: retried on its own
      continue;
    }
    out.push(status < 300 ? { ok: true, status, data } : { ok: false, status, error: data?.error?.message || `Dataverse returned HTTP ${status}.` });
  }
  return out;
}
