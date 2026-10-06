import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEV_SERVER_PORT,
  PARENT_CHECK_MS,
  SETTLE_MS,
  TRACKED_FILES,
  createBuildIdProvider,
  snapshotBuild,
  startDevServer,
  watchParent,
} from '../../scripts/dev-server.mjs';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dce-dev-'));
  dirs.push(dir);
  return dir;
}

/** Writes a tracked file and stamps it with an mtime (seconds since the epoch). */
function put(dist: string, name: string, content: string, mtimeSeconds: number) {
  writeFileSync(join(dist, name), content);
  utimesSync(join(dist, name), mtimeSeconds, mtimeSeconds);
}

function putAll(dist: string, mtimeSeconds: number, content = 'x') {
  for (const name of TRACKED_FILES) put(dist, name, content, mtimeSeconds);
}

describe('snapshotBuild', () => {
  it('is incomplete while any tracked file is missing', () => {
    const dist = tempDist();
    expect(snapshotBuild(dist)).toEqual({ complete: false });
    for (const name of TRACKED_FILES) {
      putAll(dist, 1000);
      expect(snapshotBuild(dist), 'all there').toMatchObject({ complete: true });
      rmSync(join(dist, name));
      expect(snapshotBuild(dist), `${name} missing`).toEqual({ complete: false });
    }
  });

  it('is incomplete while any tracked file is empty: a file being written is truncated first and filled afterwards', () => {
    const dist = tempDist();
    for (const name of TRACKED_FILES) {
      putAll(dist, 1000);
      put(dist, name, '', 1000);
      expect(snapshotBuild(dist), `${name} empty`).toEqual({ complete: false });
    }
    putAll(dist, 1000);
    expect(snapshotBuild(dist)).toMatchObject({ complete: true });
  });

  it('is incomplete when a tracked name is not a file', () => {
    const dist = tempDist();
    putAll(dist, 1000);
    rmSync(join(dist, 'popup.html'));
    mkdirSync(join(dist, 'popup.html'));
    expect(snapshotBuild(dist)).toEqual({ complete: false });
  });

  it('tracks exactly manifest.json, background.js, content.js and the two pages', () => {
    expect([...TRACKED_FILES].sort()).toEqual(['background.js', 'content.js', 'manifest.json', 'offscreen.html', 'popup.html']);
  });

  it('gives a short hex id that is stable for unchanged files and changes with an mtime or a size', () => {
    const dist = tempDist();
    putAll(dist, 1000);
    const first = snapshotBuild(dist);
    expect(first).toMatchObject({ complete: true, id: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(snapshotBuild(dist)).toEqual(first);

    put(dist, 'background.js', 'x', 2000); // same size, newer
    const touched = snapshotBuild(dist);
    expect(touched).toMatchObject({ complete: true });
    expect((touched as { id: string }).id).not.toBe((first as { id: string }).id);

    putAll(dist, 1000);
    put(dist, 'background.js', 'longer content', 1000); // same mtime, different size
    expect((snapshotBuild(dist) as { id: string }).id).not.toBe((first as { id: string }).id);
  });

  it('changes the id when manifest.json alone is rewritten', () => {
    const dist = tempDist();
    putAll(dist, 1000);
    const first = snapshotBuild(dist) as { id: string };
    put(dist, 'manifest.json', 'x', 2000);
    expect((snapshotBuild(dist) as { id: string }).id).not.toBe(first.id);
  });

  it('reports the newest modification time', () => {
    const dist = tempDist();
    putAll(dist, 1000);
    put(dist, 'popup.html', 'x', 5000);
    expect((snapshotBuild(dist) as { newestMtimeMs: number }).newestMtimeMs).toBeCloseTo(5_000_000, -1);
  });
});

describe('createBuildIdProvider', () => {
  it('waits for 1.5 s of quiet (it used to be 0.5 s)', () => {
    expect(SETTLE_MS).toBe(1500);
  });

  it('has no id before the first complete, settled build', () => {
    const dist = tempDist();
    let now = 10_000_000;
    const getId = createBuildIdProvider({ distDir: dist, now: () => now });
    expect(getId()).toBeNull(); // empty dist/
    putAll(dist, 10_000); // written "now": not settled yet
    expect(getId()).toBeNull();
    now += SETTLE_MS - 1;
    expect(getId()).toBeNull();
    now += 1;
    expect(getId()).toMatch(/^[0-9a-f]{12}$/);
  });

  it('answers null for the whole rebuild (even though an older build was settled) and the new id once it has been quiet for SETTLE_MS', () => {
    const dist = tempDist();
    let now = 100_000_000;
    const getId = createBuildIdProvider({ distDir: dist, now: () => now });
    putAll(dist, 100_000 - 10); // an old, settled build
    const before = getId();
    expect(before).toMatch(/^[0-9a-f]{12}$/);

    // a rebuild starts: dist/ is emptied...
    for (const name of TRACKED_FILES) rmSync(join(dist, name));
    expect(getId()).toBeNull();
    // ...files reappear one by one (some already new, some missing)
    put(dist, 'manifest.json', 'new', now / 1000);
    put(dist, 'background.js', 'new', now / 1000);
    expect(getId()).toBeNull();
    // all there, but written just now
    putAll(dist, now / 1000, 'new');
    expect(getId()).toBeNull();
    now += SETTLE_MS - 1;
    expect(getId()).toBeNull();
    now += 1;
    const after = getId();
    expect(after).toMatch(/^[0-9a-f]{12}$/);
    expect(after).not.toBe(before);
    expect(getId()).toBe(after);
  });

  it('never announces a half-written dist/: one empty or missing tracked file (manifest.json included) is enough, however old the rest is', () => {
    const dist = tempDist();
    const getId = createBuildIdProvider({ distDir: dist, now: () => 100_000_000 });
    for (const name of TRACKED_FILES) {
      putAll(dist, 1000); // long settled
      expect(getId()).toMatch(/^[0-9a-f]{12}$/);
      put(dist, name, '', 1000); // truncated by a write that has just begun
      expect(getId(), `${name} empty`).toBeNull();
      rmSync(join(dist, name));
      expect(getId(), `${name} missing`).toBeNull();
    }
  });

  it('settles on the newest file, not the first one written', () => {
    const dist = tempDist();
    let now = 50_000_000;
    const getId = createBuildIdProvider({ distDir: dist, now: () => now, settleMs: 500 });
    putAll(dist, 40_000);
    const settled = getId();
    expect(settled).not.toBeNull();
    put(dist, 'manifest.json', 'new', (now - 1000) / 1000); // written a second ago
    put(dist, 'content.js', 'new', (now - 100) / 1000); // written 100 ms ago: the build is still going
    expect(getId()).toBeNull();
    now += 399;
    expect(getId()).toBeNull(); // 499 ms since the newest file
    now += 1;
    const after = getId();
    expect(after).not.toBeNull();
    expect(after).not.toBe(settled);
  });
});

describe('the HTTP server', () => {
  async function start(getBuildId: () => string | null) {
    const server = await startDevServer({ port: 0, getBuildId });
    servers.push(server);
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  it('answers GET /build-id with the id, CORS open to any origin and no caching', async () => {
    const { base } = await start(() => 'abc123def456');
    const response = await fetch(`${base}/build-id`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('abc123def456');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toMatch(/^text\/plain/);
  });

  it('ignores a query string and always reflects the current id', async () => {
    let id = 'aaaaaaaaaaaa';
    const { base } = await start(() => id);
    expect(await (await fetch(`${base}/build-id?x=1`)).text()).toBe('aaaaaaaaaaaa');
    id = 'bbbbbbbbbbbb';
    expect(await (await fetch(`${base}/build-id`)).text()).toBe('bbbbbbbbbbbb');
  });

  it('answers 503 "building" (still with CORS headers) before the first finished build', async () => {
    const { base } = await start(() => null);
    const response = await fetch(`${base}/build-id`);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('building');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers 404 for everything else and 204 for CORS preflights', async () => {
    const { base } = await start(() => 'abc123def456');
    for (const path of ['/', '/build-id/', '/build', '/dist/manifest.json', '/%2e%2e/package.json']) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
    expect((await fetch(`${base}/build-id`, { method: 'POST' })).status).toBe(404);
    const preflight = await fetch(`${base}/build-id`, { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('listens on loopback only', async () => {
    const { server } = await start(() => 'abc123def456');
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('serves the id of a real dist/ through the real provider', async () => {
    const dist = tempDist();
    mkdirSync(dist, { recursive: true });
    putAll(dist, 1000); // long settled
    const { base } = await start(createBuildIdProvider({ distDir: dist }));
    const id = await (await fetch(`${base}/build-id`)).text();
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(id).toBe((snapshotBuild(dist) as { id: string }).id);
  });

  it('answers 503 for as long as a real dist/ is being rewritten or has not been quiet for 1.5 s, then 200 with the new id', async () => {
    const dist = tempDist();
    let now = 100_000_000;
    putAll(dist, 1000);
    const { base } = await start(createBuildIdProvider({ distDir: dist, now: () => now }));
    const ask = async () => {
      const response = await fetch(`${base}/build-id`);
      return { status: response.status, body: await response.text() };
    };
    const before = await ask();
    expect(before.status).toBe(200);

    for (const name of TRACKED_FILES) rmSync(join(dist, name)); // the rebuild starts by replacing the files
    expect(await ask()).toEqual({ status: 503, body: 'building' });
    put(dist, 'manifest.json', '', now / 1000); // manifest.json created, not written yet
    expect(await ask()).toEqual({ status: 503, body: 'building' });
    putAll(dist, now / 1000, 'new'); // everything written, just now
    expect(await ask()).toEqual({ status: 503, body: 'building' });
    now += SETTLE_MS - 1;
    expect((await ask()).status).toBe(503);
    now += 1;
    const after = await ask();
    expect(after.status).toBe(200);
    expect(after.body).toMatch(/^[0-9a-f]{12}$/);
    expect(after.body).not.toBe(before.body);
  });

  it('rejects with EADDRINUSE when the port is taken (a second `npm run dev`)', async () => {
    const { server } = await start(() => 'abc123def456');
    const port = (server.address() as AddressInfo).port;
    await expect(startDevServer({ port, getBuildId: () => null })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('uses port 5858 by default', () => {
    expect(DEV_SERVER_PORT).toBe(5858);
  });
});

describe('watchParent (the server leaves with its parent)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const noSuchProcess = () => Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });

  it('checks every 2 s with signal 0 and does nothing while the parent is there', () => {
    expect(PARENT_CHECK_MS).toBe(2000);
    const kill = vi.fn();
    const onGone = vi.fn();
    watchParent({ ppid: 4242, kill, onGone });
    vi.advanceTimersByTime(PARENT_CHECK_MS - 1);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(4242, 0);
    vi.advanceTimersByTime(5 * PARENT_CHECK_MS);
    expect(kill).toHaveBeenCalledTimes(6);
    expect(onGone).not.toHaveBeenCalled();
  });

  it('calls onGone once, and stops checking, as soon as the parent no longer exists', () => {
    let alive = true;
    const kill = vi.fn(() => {
      if (!alive) throw noSuchProcess();
    });
    const onGone = vi.fn();
    watchParent({ ppid: 4242, kill, onGone });
    vi.advanceTimersByTime(3 * PARENT_CHECK_MS);
    expect(onGone).not.toHaveBeenCalled();
    alive = false;
    vi.advanceTimersByTime(PARENT_CHECK_MS - 1);
    expect(onGone).not.toHaveBeenCalled(); // the next check is not due yet
    vi.advanceTimersByTime(1);
    expect(onGone).toHaveBeenCalledTimes(1);
    const checks = kill.mock.calls.length;
    vi.advanceTimersByTime(10 * PARENT_CHECK_MS);
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(checks);
  });

  it('counts any failure of the check as "gone", except EPERM (the process exists, it is just not ours to signal)', () => {
    const permission = vi.fn(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    });
    const stillThere = vi.fn();
    watchParent({ ppid: 4242, kill: permission, onGone: stillThere });
    vi.advanceTimersByTime(5 * PARENT_CHECK_MS);
    expect(permission).toHaveBeenCalledTimes(5);
    expect(stillThere).not.toHaveBeenCalled();

    const odd = vi.fn(() => {
      throw new Error('anything else');
    });
    const gone = vi.fn();
    watchParent({ ppid: 4242, kill: odd, onGone: gone });
    vi.advanceTimersByTime(PARENT_CHECK_MS);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('the returned function ends the watch', () => {
    const kill = vi.fn(() => {
      throw noSuchProcess();
    });
    const onGone = vi.fn();
    const stop = watchParent({ ppid: 4242, kill, onGone });
    vi.advanceTimersByTime(PARENT_CHECK_MS - 1);
    stop();
    vi.advanceTimersByTime(10 * PARENT_CHECK_MS);
    expect(kill).not.toHaveBeenCalled();
    expect(onGone).not.toHaveBeenCalled();
  });

  it('can check faster (intervalMs) and defaults to the parent of this process and to process.kill', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    watchParent({ intervalMs: 100, onGone: () => undefined });
    vi.advanceTimersByTime(250);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledWith(process.ppid, 0);
  });

  it('does not start for a pid that cannot be a parent (0 would mean this process group, negatives and NaN are nonsense)', () => {
    const kill = vi.fn();
    const onGone = vi.fn();
    for (const ppid of [0, -1, Number.NaN, 1.5]) watchParent({ ppid, kill, onGone });
    vi.advanceTimersByTime(10 * PARENT_CHECK_MS);
    expect(kill).not.toHaveBeenCalled();
    expect(onGone).not.toHaveBeenCalled();
  });
});

describe('the server leaves with its parent (real processes)', () => {
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  };

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) await sleep(25);
  }

  /** The first line the stream prints. */
  function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve, reject) => {
      let text = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        text += chunk;
        const end = text.indexOf('\n');
        if (end >= 0) resolve(text.slice(0, end));
      });
      stream.once('close', () => reject(new Error(`the process printed no line (only: ${JSON.stringify(text)})`)));
    });
  }

  it('a process that runs watchParent exits by itself once its parent has been killed hard (no goodbye, like a crash)', async () => {
    const devServer = pathToFileURL(fileURLToPath(new URL('../../scripts/dev-server.mjs', import.meta.url))).href;
    const watcher = [
      `import { watchParent } from ${JSON.stringify(devServer)};`,
      'watchParent({ intervalMs: 50, onGone: () => process.exit(0) });',
      'console.log(process.pid, process.ppid);',
      'setInterval(() => {}, 1000);', // the watch is unref'd: something else keeps the process up
    ].join('\n');
    // The "npm run dev": starts the watcher and then idles. The watcher is detached on purpose: on Windows libuv puts
    // every non-detached child in a job object that dies with its parent, which would end the watcher without watchParent.
    const parentSource = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(watcher)}],`,
      "  { stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true });",
      'setTimeout(() => {}, 60_000);', // idles, but never longer than a minute even if the test is aborted (the watcher then leaves too)
    ].join('\n');

    const parent = spawn(process.execPath, ['-e', parentSource], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let watcherPid: number | undefined;
    try {
      const [pid, watcherParentPid] = (await firstLine(parent.stdout)).split(' ').map(Number) as [number, number];
      watcherPid = pid;
      expect(watcherParentPid).toBe(parent.pid); // it watches the right process

      await sleep(400); // eight checks: it stays while its parent is alive
      expect(isAlive(pid)).toBe(true);

      parent.kill('SIGKILL'); // no goodbye, like a crash
      await until(() => !isAlive(pid), 15_000);
      expect(isAlive(pid)).toBe(false);
      watcherPid = undefined; // gone: never signal a pid that may have been reused since
    } finally {
      parent.kill('SIGKILL'); // through the handle, so it can only ever hit the process this test started
      if (watcherPid !== undefined) {
        try {
          process.kill(watcherPid, 'SIGKILL'); // the test failed with the watcher still running
        } catch {
          // already gone
        }
      }
    }
  }, 30_000);
});
