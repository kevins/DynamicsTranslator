// What tools/serve.mjs answers: the files of one folder (dist/), readable by Dynamics pages only. Every request gets an
// answer, a malformed one too: nothing a request carries can stop the server. Only requests addressed to this machine
// (Host 127.0.0.1, localhost or [::1]) are served, so a page whose own name was pointed at 127.0.0.1 (DNS rebinding)
// reads nothing; only GET and HEAD (and the CORS preflight) are answered.
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

/**
 * The file of `root` the request path `url` names, or null when it leads out of `root`: `..` through an encoded separator
 * (`%2f`, and `%5c` on Windows), or into a sibling folder whose name starts like it (`dist-private` next to `dist`).
 * Throws a URIError for a malformed escape (`/bad%`).
 */
export function fileIn(root, url) {
  const file = join(root, decodeURIComponent(new URL(url, 'http://x').pathname));
  const rel = relative(root, file);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : file;
}

/**
 * The origin allowed to read the answer: a Dynamics page's (`https://<org>.crm.dynamics.com`), else null. Any other page
 * gets no CORS header at all, an opaque origin (`Origin: null`: sandboxed frames, data: URLs) or a plain http one neither.
 */
export function corsOrigin(origin) {
  try {
    const u = new URL(origin);
    return origin && u.protocol === 'https:' && /\.dynamics\.com$/.test(u.hostname) ? origin : null;
  } catch {
    return null;
  }
}

/** True when the request is addressed to this machine by name: 127.0.0.1, localhost or [::1], any port. */
export function localHost(host) {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(host || ''));
}

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8' };

/** The request handler serving the files of `root`: 400 for a malformed path, 403 for one outside `root`, 404 for no file. */
export function serveDir(root) {
  return async (req, res) => {
    const origin = corsOrigin(req.headers.origin);
    const h = {
      // A Dynamics page may read the answers, and reach this private address from its public one; no other page may.
      ...(origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Private-Network': 'true' } : {}),
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Cache-Control': 'no-store',
    };
    if (!localHost(req.headers.host)) {
      res.writeHead(403, h);
      return res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      res.writeHead(405, { ...h, Allow: 'GET, HEAD, OPTIONS' });
      return res.end();
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, h);
      return res.end();
    }
    let file;
    try {
      file = fileIn(root, req.url);
    } catch {
      res.writeHead(400, h);
      return res.end('bad request');
    }
    if (!file) {
      res.writeHead(403, h);
      return res.end();
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { ...h, 'Content-Type': TYPES[file.slice(file.lastIndexOf('.'))] || 'text/plain; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404, h);
      res.end('not found');
    }
  };
}
