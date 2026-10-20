// The optional dev server (tools/serve.mjs, its handler tools/dev/devserver.mjs) on a real loopback socket: it serves only
// the files of its folder, to Dynamics pages only, and keeps serving after malformed requests.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { corsOrigin, fileIn, localHost, serveDir } from '../devserver.mjs';
import type { Kit } from './kit';

interface Answer {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

/** A folder with dist/app.js and, next to dist/, dist-private/marker.txt; a server for dist/ on a free port while `fn` runs. */
async function withServer(fn: (get: (path: string, o?: { method?: string; headers?: Record<string, string> }) => Promise<Answer>, root: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dxt-serve-'));
  const root = join(dir, 'dist');
  mkdirSync(root);
  mkdirSync(join(dir, 'dist-private'));
  writeFileSync(join(root, 'app.js'), 'console.log("app")');
  writeFileSync(join(dir, 'dist-private', 'marker.txt'), 'PRIVATE MARKER');
  const server = createServer(serveDir(root));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  // The path goes out exactly as written (a browser or fetch() would resolve `..` first).
  const get = (path: string, o: { method?: string; headers?: Record<string, string> } = {}) =>
    new Promise<Answer>((ok, fail) => {
      const r = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: o.headers }, (m) => {
        let body = '';
        m.setEncoding('utf8');
        m.on('data', (c) => (body += c));
        m.on('end', () => ok({ status: m.statusCode!, body, headers: m.headers }));
      });
      r.setTimeout(5000, () => r.destroy(new Error(`no answer to ${path}`)));
      r.on('error', fail);
      r.end();
    });
  try {
    await fn(get, root);
  } finally {
    await new Promise((ok) => server.close(ok));
    rmSync(dir, { recursive: true, force: true });
  }
}

export function register(t: Kit): void {
  t.test('dev server: serves the files of dist/, never one of a sibling folder whose name starts like it, whatever the separators', () =>
    withServer(async (get, root) => {
      const app = await get('/app.js');
      t.eq([app.status, app.body, app.headers['content-type']], [200, 'console.log("app")', 'text/javascript; charset=utf-8']);
      t.eq((await get('/nothing.js')).status, 404);
      const escapes = [
        '/..%2fdist-private%2fmarker.txt',
        '/%2e%2e%2fdist-private%2fmarker.txt',
        '/..%5cdist-private%5cmarker.txt',
        '/%2e%2e%5cdist-private%5cmarker.txt',
        '/..%5c..%5cdist%5c..%5cdist-private/marker.txt',
        '/../dist-private/marker.txt',
      ];
      for (const p of escapes) {
        const a = await get(p);
        t.ok(a.status !== 200 && !a.body.includes('PRIVATE'), `${p}: ${a.status} ${a.body}`);
      }
      // On Windows a backslash is a separator too, so those are refused like the others; elsewhere they name no file.
      t.eq((await get('/..%2fdist-private%2fmarker.txt')).status, 403);
      t.eq((await get('/..%5cdist-private%5cmarker.txt')).status, process.platform === 'win32' ? 403 : 404);
      t.eq([fileIn(root, '/app.js'), fileIn(root, '/sub/../app.js'), fileIn(root, '/..%2fdist-private%2fmarker.txt')], [join(root, 'app.js'), join(root, 'app.js'), null]);
    }),
  );

  t.test('dev server: a malformed path or Origin gets an answer and the server keeps serving; only a Dynamics page may read the answers', () =>
    withServer(async (get) => {
      const alive = async (what: string) => t.eq((await get('/app.js')).status, 200, `serving after ${what}`);
      t.eq((await get('/bad%')).status, 400);
      await alive('/bad%');
      t.eq((await get('/%E0%A4%A')).status, 400);
      await alive('a cut UTF-8 escape');
      const acao = async (origin: string, method = 'GET') => {
        const a = await get('/app.js', { method, headers: { Origin: origin } });
        return [a.status, a.headers['access-control-allow-origin'] ?? null];
      };
      t.eq(await acao('https://contoso.crm.dynamics.com'), [200, 'https://contoso.crm.dynamics.com']);
      t.eq(await acao('https://contoso.crm.dynamics.com', 'OPTIONS'), [204, 'https://contoso.crm.dynamics.com']);
      // An opaque origin was answered `Access-Control-Allow-Origin: null` (or stopped the server), which lets any sandboxed frame read it.
      t.eq(await acao('null'), [200, null]);
      t.eq(await acao('null', 'OPTIONS'), [204, null]);
      t.eq(await acao('https://dynamics.com.example.org'), [200, null]);
      t.eq(await acao('https://evil.example'), [200, null]);
      t.eq(await acao('not a url'), [200, null]);
      await alive('those origins');
      t.eq([corsOrigin(undefined), corsOrigin(''), corsOrigin('null'), corsOrigin('https://x.crm.dynamics.com')], [null, null, null, 'https://x.crm.dynamics.com']);
    }),
  );

  t.test('dev server: only requests addressed to this machine are served (a rebound name gets nothing), only GET, HEAD and the preflight, private-network access only for a Dynamics page over https', () =>
    withServer(async (get) => {
      const at = async (host: string) => (await get('/app.js', { headers: { Host: host } })).status;
      t.eq(await Promise.all(['127.0.0.1:8765', 'localhost:8765', 'LOCALHOST', '[::1]:8765'].map(at)), [200, 200, 200, 200]);
      t.eq(await Promise.all(['attacker.example:8765', '127.0.0.1.attacker.example', 'localhost.attacker.example:8765', '127.0.0.1@attacker.example'].map(at)), [403, 403, 403, 403]);
      const post = await get('/app.js', { method: 'POST' });
      t.eq([post.status, post.headers.allow, post.body], [405, 'GET, HEAD, OPTIONS', '']);
      t.eq((await get('/app.js', { method: 'HEAD' })).status, 200);
      const pre = async (origin: string) => {
        const a = await get('/app.js', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Private-Network': 'true' } });
        return [a.status, a.headers['access-control-allow-origin'] ?? null, a.headers['access-control-allow-private-network'] ?? null, a.headers['access-control-allow-methods']];
      };
      t.eq(await pre('https://x.crm.dynamics.com'), [204, 'https://x.crm.dynamics.com', 'true', 'GET, OPTIONS']);
      t.eq(await pre('http://x.crm.dynamics.com'), [204, null, null, 'GET, OPTIONS'], 'plain http: not a Dynamics page');
      t.eq(await pre('https://evil.example'), [204, null, null, 'GET, OPTIONS']);
      t.eq([localHost('127.0.0.1'), localHost('127.0.0.10'), localHost(undefined)], [true, false, false]);
    }),
  );
}
