// The tiny server behind `npm run dev` (scripts/dev.mjs starts it next to `vite build --watch`):  node scripts/dev-server.mjs
//   GET http://localhost:5858/build-id   a short hash that changes whenever a rebuild of dist/ has finished
// The development build of the service worker (src/background/devReload.ts) polls it and reloads the extension when it
// changes. The id is a hash of the mtimes and sizes of manifest.json, background.js, content.js and the two pages.
// Chrome reads dist/ again when it reloads an unpacked extension, and a half-written dist/ leaves the extension dead. So the
// server answers 503 ("building") until every one of those files exists and is non-empty AND the newest of them has been
// quiet for SETTLE_MS; only then does it answer 200 with the id. A git merge rewrites many files and causes several rebuilds
// in a row: there is no id until the burst is over (the worker treats a 503 between two sightings as "start over").
// The server also exits by itself once the process that started it is gone, so a hard-killed `npm run dev` does not leave it
// (and port 5858) behind.
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEV_SERVER_PORT = 5858;
/** The files whose change means "reload the extension". All of them must exist and be non-empty before a build is announced. */
export const TRACKED_FILES = ['manifest.json', 'background.js', 'content.js', 'popup.html', 'offscreen.html'];
/** A build counts as finished once nothing in it has changed for this long. */
export const SETTLE_MS = 1500;
/** How often the server checks that the process that started it is still there. */
export const PARENT_CHECK_MS = 2000;

/** `{ complete: false }` while a tracked file is missing or empty, otherwise the id and the newest modification time. */
export function snapshotBuild(distDir) {
  const parts = [];
  let newestMtimeMs = 0;
  for (const name of TRACKED_FILES) {
    let stat;
    try {
      stat = statSync(join(distDir, name));
    } catch {
      return { complete: false };
    }
    // A file that is being (re)written is truncated first and filled afterwards: empty means "not there yet".
    if (!stat.isFile() || stat.size === 0) return { complete: false };
    parts.push(`${name}:${Math.round(stat.mtimeMs)}:${stat.size}`);
    newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
  }
  const id = createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 12);
  return { complete: true, id, newestMtimeMs };
}

/**
 * () => the current build id, or null while there is none to announce: before the first build, while a rebuild is being
 * written (a tracked file is missing or empty) and until the newest file is `settleMs` old. null is answered as 503.
 */
export function createBuildIdProvider({ distDir = join(ROOT, 'dist'), settleMs = SETTLE_MS, now = Date.now } = {}) {
  return () => {
    const snapshot = snapshotBuild(distDir);
    return snapshot.complete && now() - snapshot.newestMtimeMs >= settleMs ? snapshot.id : null;
  };
}

/** The (not yet listening) HTTP server. `getBuildId` is injectable for tests. */
export function createDevServer({ getBuildId = createBuildIdProvider() } = {}) {
  return createServer((request, response) => {
    const headers = {
      'Access-Control-Allow-Origin': '*', // the extension fetches it cross-origin
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Cache-Control': 'no-store',
    };
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'OPTIONS') {
      response.writeHead(204, headers).end();
    } else if (request.method === 'GET' && pathname === '/build-id') {
      const id = getBuildId();
      response.writeHead(id ? 200 : 503, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }).end(id ?? 'building');
    } else {
      response.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
    }
  });
}

/** Listens on loopback only (the id is harmless, but there is no reason to offer it to the network). Pass port 0 for any free port. */
export function startDevServer({ port = DEV_SERVER_PORT, host = '127.0.0.1', ...options } = {}) {
  const server = createDevServer(options);
  return new Promise((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolveListening(server);
    });
  });
}

/**
 * Calls `onGone` once, and stops checking, when the process `ppid` (default: the parent of this process, read now) no longer
 * exists. `npm run dev` (scripts/dev.mjs) starts this server as a child, and a hard kill (a closed terminal, `taskkill /f`, a
 * crash) does not stop its children: the orphan would keep serving a stale build id on :5858. `kill` is `process.kill`;
 * signal 0 only tests for existence and throws when there is no such process (EPERM = it exists, we may just not signal it).
 * Returns a function that ends the watch. The timer is unref'd: the watch alone never keeps a process alive.
 */
export function watchParent({
  onGone,
  ppid = process.ppid,
  intervalMs = PARENT_CHECK_MS,
  kill = (pid, signal) => process.kill(pid, signal),
}) {
  if (!Number.isInteger(ppid) || ppid <= 0) return () => {};
  const timer = setInterval(() => {
    try {
      kill(ppid, 0);
    } catch (error) {
      if (error?.code === 'EPERM') return;
      clearInterval(timer);
      onGone();
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDevServer().then(
    (server) => {
      console.log(`serving the build id on http://localhost:${server.address().port}/build-id (dist: ${join(ROOT, 'dist')})`);
      watchParent({ onGone: () => process.exit(0) });
    },
    (error) => {
      console.error(
        error.code === 'EADDRINUSE'
          ? `port ${DEV_SERVER_PORT} is already in use - is another "npm run dev" running?`
          : `could not start the dev server: ${error.message}`,
      );
      process.exit(1);
    },
  );
}
