// Dev-only static server for dist/, so a signed-in Dynamics tab can load fresh builds while testing.
// Binds to 127.0.0.1 only and serves only files inside dist/ (tools/dev/devserver.mjs).
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDir } from './dev/devserver.mjs';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const port = Number(process.argv[2] || 8765);
createServer(serveDir(dist)).listen(port, '127.0.0.1', () => console.log('serving', dist, 'on', port));
