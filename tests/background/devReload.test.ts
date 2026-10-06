import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILD_ID_KEY,
  BUILD_ID_URL,
  CONFIRM_DELAY_MS,
  LAST_RELOAD_AT_KEY,
  MAX_POLL_INTERVAL_MS,
  MIN_RELOAD_INTERVAL_MS,
  POLL_INTERVAL_MS,
  RELOAD_TABS_KEY,
  checkBuild,
  createBuildWatch,
  fetchBuildId,
  reloadPendingTabs,
  runDevReload,
  startDevReload,
  type DevReloadEnv,
} from '@/background/devReload';
import { SETTLE_MS, TRACKED_FILES, createBuildIdProvider } from '../../scripts/dev-server.mjs';
import { createFakeBrowser } from './fakeChrome';
import { settle } from './helpers';

const ID_A = 'aaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbb';
const ID_C = 'cccccccccccc';
const ID_D = 'dddddddddddd';
/** Where the fake clock starts (tests that read the time use fake timers, which also fake `Date`). */
const T0 = 1_700_000_000_000;

/** A fake platform: a dev server whose answer the test controls, an in-memory chrome.storage.local, and call recorders. */
function createEnv(openTabs: number[] = [11, 12]) {
  const store = new Map<string, unknown>();
  const server: { id: string | null; status: number } = { id: ID_A, status: 200 }; // id null = connection refused
  const reloadedTabs: number[] = [];
  let extensionReloads = 0;
  const env: DevReloadEnv = {
    fetch: vi.fn(async () => {
      if (server.id === null) throw new TypeError('Failed to fetch');
      return new Response(server.status === 200 ? server.id : 'building', { status: server.status });
    }),
    storage: {
      get: vi.fn(async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {})),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      }),
      remove: vi.fn(async (key: string) => {
        store.delete(key);
      }),
    },
    queryDiscordTabIds: vi.fn(async () => openTabs),
    reloadTab: vi.fn(async (tabId: number) => {
      reloadedTabs.push(tabId);
    }),
    reloadExtension: vi.fn(() => {
      extensionReloads++;
    }),
  };
  return { env, store, server, reloadedTabs, extensionReloads: () => extensionReloads };
}

type TestServer = ReturnType<typeof createEnv>['server'];

describe('the numbers of the reload protocol', () => {
  it('confirms a build after 2.5 s, keeps 20 s between reloads and stores the time under dce.dev.lastReloadAt', () => {
    expect(CONFIRM_DELAY_MS).toBe(2500);
    expect(MIN_RELOAD_INTERVAL_MS).toBe(20_000);
    expect(LAST_RELOAD_AT_KEY).toBe('dce.dev.lastReloadAt');
  });

  it('keeps every storage key in the dce.dev. namespace (npm run verify flags it in a production build)', () => {
    for (const key of [BUILD_ID_KEY, RELOAD_TABS_KEY, LAST_RELOAD_AT_KEY]) expect(key.startsWith('dce.dev.')).toBe(true);
  });
});

describe('fetchBuildId', () => {
  it('returns the id the dev server sends (trimmed) and asks for the right URL without caching', async () => {
    const { env, server } = createEnv();
    server.id = `  ${ID_A}\n`;
    expect(await fetchBuildId(env)).toBe(ID_A);
    expect(env.fetch).toHaveBeenCalledWith(BUILD_ID_URL, expect.objectContaining({ cache: 'no-store' }));
    expect(BUILD_ID_URL).toBe('http://localhost:5858/build-id');
  });

  it('is null while the server is down, still building (503) or answering with something that is not an id', async () => {
    const down = createEnv();
    down.server.id = null;
    expect(await fetchBuildId(down.env)).toBeNull();

    const building = createEnv();
    building.server.status = 503;
    expect(await fetchBuildId(building.env)).toBeNull();

    for (const body of ['', '<html>captive portal</html>', 'ZZZZZZZZZZZZ', 'abc', 'a'.repeat(65)]) {
      const junk = createEnv();
      junk.server.id = body;
      expect(await fetchBuildId(junk.env)).toBeNull();
    }
  });

  it('accepts HTTP 200 only, even when a body that looks like an id comes with another status', async () => {
    const env = createEnv().env;
    for (const status of [201, 203, 206]) {
      env.fetch = async () => new Response(ID_A, { status });
      expect(await fetchBuildId(env)).toBeNull();
    }
    env.fetch = async () => new Response(ID_A, { status: 200 });
    expect(await fetchBuildId(env)).toBe(ID_A);
  });

  it('never throws, whatever fetch does', async () => {
    const env = createEnv().env;
    env.fetch = () => {
      throw new Error('sync failure');
    };
    expect(await fetchBuildId(env)).toBeNull();
  });
});

describe('checkBuild', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A worker that already runs build A (its baseline is stored), so a different id is a new build; with its in-memory watch. */
  async function runningA(openTabs?: number[]) {
    const test = createEnv(openTabs);
    const watch = createBuildWatch();
    expect(await checkBuild(test.env, watch)).toBe('baseline');
    return { ...test, watch };
  }

  it('remembers the first id it ever sees and does not reload (baseline)', async () => {
    const { env, store, extensionReloads } = createEnv();
    expect(await checkBuild(env, createBuildWatch())).toBe('baseline');
    expect(store.get(BUILD_ID_KEY)).toBe(ID_A);
    expect(store.has(RELOAD_TABS_KEY)).toBe(false);
    expect(store.has(LAST_RELOAD_AT_KEY)).toBe(false);
    expect(extensionReloads()).toBe(0);
  });

  it('does nothing while the id stays the same', async () => {
    const { env, watch, extensionReloads } = await runningA();
    expect(await checkBuild(env, watch)).toBe('unchanged');
    expect(await checkBuild(env, watch)).toBe('unchanged');
    expect(extensionReloads()).toBe(0);
    expect(env.queryDiscordTabIds).not.toHaveBeenCalled();
  });

  it('does not act on a new id at once: it becomes the candidate, nothing is stored, queried or reloaded', async () => {
    const { env, store, server, watch, extensionReloads } = await runningA();
    server.id = ID_B;
    expect(await checkBuild(env, watch)).toBe('pending');
    expect(watch.candidate).toEqual({ id: ID_B, since: T0 });
    expect(store.get(BUILD_ID_KEY)).toBe(ID_A);
    expect(store.has(RELOAD_TABS_KEY)).toBe(false);
    expect(store.has(LAST_RELOAD_AT_KEY)).toBe(false);
    expect(env.queryDiscordTabIds).not.toHaveBeenCalled();
    expect(extensionReloads()).toBe(0);
  });

  it('reloads once the same new id is served again 2.5 s after it was first seen, not a millisecond earlier', async () => {
    const { env, store, server, watch, extensionReloads } = await runningA([5, 9]);
    server.id = ID_B;
    expect(await checkBuild(env, watch)).toBe('pending');
    vi.advanceTimersByTime(CONFIRM_DELAY_MS - 1);
    expect(await checkBuild(env, watch)).toBe('pending');
    expect(extensionReloads()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(await checkBuild(env, watch)).toBe('reload');
    expect(extensionReloads()).toBe(1);
    expect(store.get(RELOAD_TABS_KEY)).toEqual([5, 9]);
    expect(store.get(BUILD_ID_KEY)).toBe(ID_B);
    expect(store.get(LAST_RELOAD_AT_KEY)).toBe(T0 + CONFIRM_DELAY_MS);
    expect(watch.candidate).toBeNull();
    // the restarted worker sees the same id and must not reload again
    expect(await checkBuild(env, createBuildWatch())).toBe('unchanged');
    expect(extensionReloads()).toBe(1);
  });

  it('counts the 2.5 s from the FIRST sighting: more sightings in between do not restart it', async () => {
    const { env, server, watch, extensionReloads } = await runningA();
    server.id = ID_B;
    expect(await checkBuild(env, watch)).toBe('pending');
    for (const sinceFirst of [1000, 2000]) {
      vi.setSystemTime(T0 + sinceFirst);
      expect(await checkBuild(env, watch)).toBe('pending');
      expect(watch.candidate).toEqual({ id: ID_B, since: T0 });
    }
    vi.setSystemTime(T0 + CONFIRM_DELAY_MS);
    expect(await checkBuild(env, watch)).toBe('reload');
    expect(extensionReloads()).toBe(1);
  });

  const misses: Array<[string, (server: TestServer) => void]> = [
    [
      'a 503 (dist/ is being written)',
      (server) => {
        server.status = 503;
      },
    ],
    [
      'a refused connection (the server is gone)',
      (server) => {
        server.id = null;
      },
    ],
    [
      'an answer that is not an id',
      (server) => {
        server.id = '<html>captive portal</html>';
      },
    ],
  ];
  it.each(misses)('%s between the two sightings starts the check over', async (_name, miss) => {
    const { env, server, watch, extensionReloads } = await runningA();
    server.id = ID_B;
    expect(await checkBuild(env, watch)).toBe('pending');
    vi.advanceTimersByTime(CONFIRM_DELAY_MS);
    miss(server);
    expect(await checkBuild(env, watch)).toBe('offline');
    expect(watch.candidate).toBeNull();
    server.id = ID_B; // the same id again, but it counts as a first sighting
    server.status = 200;
    expect(await checkBuild(env, watch)).toBe('pending');
    expect(extensionReloads()).toBe(0);
    vi.advanceTimersByTime(CONFIRM_DELAY_MS - 1);
    expect(await checkBuild(env, watch)).toBe('pending');
    vi.advanceTimersByTime(1);
    expect(await checkBuild(env, watch)).toBe('reload');
    expect(extensionReloads()).toBe(1);
  });

  it('a different id between the two sightings starts the check over with the new id (the old one is never reloaded)', async () => {
    const { env, store, server, watch, extensionReloads } = await runningA();
    server.id = ID_B;
    expect(await checkBuild(env, watch)).toBe('pending');
    vi.advanceTimersByTime(CONFIRM_DELAY_MS);
    server.id = ID_C;
    expect(await checkBuild(env, watch)).toBe('pending');
    expect(watch.candidate).toEqual({ id: ID_C, since: T0 + CONFIRM_DELAY_MS });
    expect(extensionReloads()).toBe(0);
    vi.advanceTimersByTime(CONFIRM_DELAY_MS);
    expect(await checkBuild(env, watch)).toBe('reload');
    expect(store.get(BUILD_ID_KEY)).toBe(ID_C);
    expect(extensionReloads()).toBe(1);
  });

  it('the id going back to the one this worker runs drops the candidate', async () => {
    const { env, server, watch, extensionReloads } = await runningA();
    server.id = ID_B;
    expect(await checkBuild(env, watch)).toBe('pending');
    server.id = ID_A;
    expect(await checkBuild(env, watch)).toBe('unchanged');
    expect(watch.candidate).toBeNull();
    vi.advanceTimersByTime(CONFIRM_DELAY_MS);
    server.id = ID_B;
    expect(await checkBuild(env, watch)).toBe('pending'); // not 'reload': B was dropped in between
    expect(extensionReloads()).toBe(0);
  });

  it('stores the new id, the open Discord tabs and the reload time in ONE write, before it reloads the extension', async () => {
    const { env, store, server, watch } = await runningA();
    server.id = ID_B;
    await checkBuild(env, watch);
    vi.advanceTimersByTime(CONFIRM_DELAY_MS);
    const order: string[] = [];
    vi.mocked(env.queryDiscordTabIds).mockImplementation(async () => {
      order.push('tabs');
      return [5, 9];
    });
    vi.mocked(env.storage.set).mockImplementation(async (items) => {
      order.push(`set ${Object.keys(items).sort().join(' ')}`);
      for (const [key, value] of Object.entries(items)) store.set(key, value);
    });
    vi.mocked(env.reloadExtension).mockImplementation(() => order.push('reload'));
    expect(await checkBuild(env, watch)).toBe('reload');
    // the id survives the reload (so there is no reload loop); with one write it is all stored or, when it fails, nothing is
    expect(order).toEqual(['tabs', `set ${[BUILD_ID_KEY, LAST_RELOAD_AT_KEY, RELOAD_TABS_KEY].sort().join(' ')}`, 'reload']);
  });

  it('is silent while the dev server is down: nothing is stored, nothing reloads', async () => {
    const { env, store, server, watch, extensionReloads } = await runningA();
    server.id = null;
    expect(await checkBuild(env, watch)).toBe('offline');
    server.status = 503;
    server.id = ID_B;
    expect(await checkBuild(env, watch)).toBe('offline');
    expect(store.get(BUILD_ID_KEY)).toBe(ID_A);
    expect(store.has(LAST_RELOAD_AT_KEY)).toBe(false);
    expect(extensionReloads()).toBe(0);
  });

  describe('at least 20 s between two reloads', () => {
    /** Runs a check with the clock at T0 + `ms`. */
    const at = (test: Awaited<ReturnType<typeof runningA>>, ms: number) => {
      vi.setSystemTime(T0 + ms);
      return checkBuild(test.env, test.watch);
    };

    it('defers a confirmed build until 20 s after the last reload, and reloads exactly then', async () => {
      const test = await runningA();
      const { env, store, server, watch, extensionReloads } = test;
      store.set(LAST_RELOAD_AT_KEY, T0 - 5000); // reloaded 5 s ago
      server.id = ID_B;
      expect(await at(test, 0)).toBe('pending');
      expect(await at(test, CONFIRM_DELAY_MS)).toBe('deferred');
      expect(watch.reloadAt).toBe(T0 - 5000 + MIN_RELOAD_INTERVAL_MS);
      expect(extensionReloads()).toBe(0);
      expect(store.get(BUILD_ID_KEY)).toBe(ID_A); // still the old id: the reload is yet to come
      expect(env.queryDiscordTabIds).not.toHaveBeenCalled();

      expect(await at(test, MIN_RELOAD_INTERVAL_MS - 5000 - 1)).toBe('deferred'); // up to the last millisecond
      expect(extensionReloads()).toBe(0);
      expect(await at(test, MIN_RELOAD_INTERVAL_MS - 5000)).toBe('reload');
      expect(extensionReloads()).toBe(1);
      expect(store.get(LAST_RELOAD_AT_KEY)).toBe(T0 + MIN_RELOAD_INTERVAL_MS - 5000);
      expect(store.get(BUILD_ID_KEY)).toBe(ID_B);
    });

    it('coalesces builds that arrive during the wait into ONE reload with the newest id', async () => {
      const test = await runningA();
      const { store, server, extensionReloads } = test;
      store.set(LAST_RELOAD_AT_KEY, T0); // the extension was just reloaded
      server.id = ID_B;
      expect(await at(test, 1000)).toBe('pending');
      expect(await at(test, 3500)).toBe('deferred');
      server.id = ID_C;
      expect(await at(test, 6000)).toBe('pending'); // another build: the check starts over, the wait is not extended
      expect(await at(test, 8500)).toBe('deferred');
      server.id = ID_D;
      expect(await at(test, 12_000)).toBe('pending');
      expect(await at(test, MIN_RELOAD_INTERVAL_MS - 1)).toBe('deferred');
      expect(extensionReloads()).toBe(0);
      expect(await at(test, MIN_RELOAD_INTERVAL_MS)).toBe('reload');
      expect(extensionReloads()).toBe(1);
      expect(store.get(BUILD_ID_KEY)).toBe(ID_D); // B and C were never reloaded
      expect(store.get(LAST_RELOAD_AT_KEY)).toBe(T0 + MIN_RELOAD_INTERVAL_MS);
    });

    it('a build that is not confirmed yet when the interval is over delays the reload until it is, and no longer', async () => {
      const test = await runningA();
      const { store, server, extensionReloads } = test;
      store.set(LAST_RELOAD_AT_KEY, T0);
      server.id = ID_B;
      expect(await at(test, 5000)).toBe('pending');
      expect(await at(test, 7500)).toBe('deferred');
      server.id = ID_C;
      expect(await at(test, MIN_RELOAD_INTERVAL_MS - 1000)).toBe('pending');
      expect(await at(test, MIN_RELOAD_INTERVAL_MS)).toBe('pending'); // the interval is over, C is only 1 s old
      expect(await at(test, MIN_RELOAD_INTERVAL_MS + CONFIRM_DELAY_MS - 1001)).toBe('pending');
      expect(extensionReloads()).toBe(0);
      expect(await at(test, MIN_RELOAD_INTERVAL_MS + CONFIRM_DELAY_MS - 1000)).toBe('reload');
      expect(store.get(BUILD_ID_KEY)).toBe(ID_C);
    });

    it('a miss while a confirmed reload waits starts the check over (the wait itself does not restart)', async () => {
      const test = await runningA();
      const { store, server, watch, extensionReloads } = test;
      store.set(LAST_RELOAD_AT_KEY, T0);
      server.id = ID_B;
      await at(test, 1000);
      expect(await at(test, 3500)).toBe('deferred');
      server.status = 503;
      expect(await at(test, 10_000)).toBe('offline');
      expect(watch.candidate).toBeNull();
      server.status = 200;
      expect(await at(test, 11_000)).toBe('pending');
      expect(await at(test, 13_500)).toBe('deferred');
      expect(await at(test, MIN_RELOAD_INTERVAL_MS)).toBe('reload'); // still 20 s after the last reload, not after the miss
      expect(extensionReloads()).toBe(1);
    });

    it('never lets a junk or future reload time block for good (nothing stored yet, a garbled value, the clock set back)', async () => {
      for (const junk of [undefined, 'yesterday', NaN, null, {}, T0 + 24 * 3_600_000]) {
        const test = await runningA();
        if (junk !== undefined) test.store.set(LAST_RELOAD_AT_KEY, junk);
        test.server.id = ID_B;
        expect(await at(test, 0)).toBe('pending');
        expect(await at(test, CONFIRM_DELAY_MS), String(junk)).toBe('reload');
        expect(test.extensionReloads()).toBe(1);
        expect(test.store.get(LAST_RELOAD_AT_KEY)).toBe(T0 + CONFIRM_DELAY_MS); // repaired by the reload
      }
    });
  });
});

describe('reloadPendingTabs (worker start)', () => {
  it('reloads exactly the tabs left behind and clears the key', async () => {
    const { env, store, reloadedTabs } = createEnv();
    store.set(RELOAD_TABS_KEY, [3, 4]);
    await reloadPendingTabs(env);
    expect(reloadedTabs).toEqual([3, 4]);
    expect(store.has(RELOAD_TABS_KEY)).toBe(false);
    await reloadPendingTabs(env); // a second worker start must not reload them again
    expect(reloadedTabs).toEqual([3, 4]);
  });

  it('clears the key BEFORE reloading, even if a reload fails', async () => {
    const { env, store } = createEnv();
    store.set(RELOAD_TABS_KEY, [3, 4]);
    vi.mocked(env.reloadTab).mockImplementation(async () => {
      expect(store.has(RELOAD_TABS_KEY)).toBe(false);
      throw new Error('No tab with id');
    });
    await expect(reloadPendingTabs(env)).resolves.toBeUndefined();
    expect(env.reloadTab).toHaveBeenCalledTimes(2); // one failure does not stop the others
  });

  it('ignores junk in storage and does nothing when there is nothing to do', async () => {
    const { env, store, reloadedTabs } = createEnv();
    await reloadPendingTabs(env);
    expect(env.storage.remove).not.toHaveBeenCalled();
    store.set(RELOAD_TABS_KEY, 'nope');
    await reloadPendingTabs(env);
    store.set(RELOAD_TABS_KEY, [1, '2', null, 3.5, 4]);
    await reloadPendingTabs(env);
    expect(reloadedTabs).toEqual([1, 4]);
  });
});

describe('runDevReload (the polling loop)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const fetchCount = (env: DevReloadEnv) => vi.mocked(env.fetch).mock.calls.length;

  /** Polls at 0, 1 s and 2 s: build A is the baseline, the clock is at T0 + 2 s. */
  async function startOnA() {
    const test = createEnv();
    const stop = runDevReload(test.env);
    await advance(2 * POLL_INTERVAL_MS);
    expect(test.store.get(BUILD_ID_KEY)).toBe(ID_A);
    return { ...test, stop };
  }

  it('polls right away and then once per second', async () => {
    const { env } = createEnv();
    const stop = runDevReload(env);
    await advance(0);
    expect(env.fetch).toHaveBeenCalledTimes(1);
    await advance(POLL_INTERVAL_MS);
    expect(env.fetch).toHaveBeenCalledTimes(2);
    await advance(3 * POLL_INTERVAL_MS);
    expect(env.fetch).toHaveBeenCalledTimes(5);
    stop();
  });

  it('stop() ends the polling', async () => {
    const { env } = createEnv();
    const stop = runDevReload(env);
    await advance(2 * POLL_INTERVAL_MS);
    const calls = fetchCount(env);
    stop();
    await advance(10 * POLL_INTERVAL_MS);
    expect(fetchCount(env)).toBe(calls);
  });

  it('reloads the pending tabs at start', async () => {
    const { env, store, reloadedTabs } = createEnv();
    store.set(RELOAD_TABS_KEY, [7]);
    const stop = runDevReload(env);
    await advance(0);
    expect(reloadedTabs).toEqual([7]);
    stop();
  });

  it('reloads the extension when a new build was served twice, 2.5 s apart: not earlier, and with no poll in between', async () => {
    const { env, server, store, extensionReloads, stop } = await startOnA();
    server.id = ID_B;
    await advance(POLL_INTERVAL_MS); // t = 3 s: B is seen for the first time
    expect(extensionReloads()).toBe(0);
    const fetches = fetchCount(env);
    await advance(CONFIRM_DELAY_MS - 1); // t = 5.499 s
    expect(extensionReloads()).toBe(0);
    expect(fetchCount(env)).toBe(fetches); // the confirming poll is the next poll
    await advance(1); // t = 5.5 s
    expect(fetchCount(env)).toBe(fetches + 1);
    expect(extensionReloads()).toBe(1);
    expect(store.get(BUILD_ID_KEY)).toBe(ID_B);
    expect(store.get(RELOAD_TABS_KEY)).toEqual([11, 12]);
    expect(store.get(LAST_RELOAD_AT_KEY)).toBe(Date.now());
    stop();
  });

  it('a 503 at the second sighting starts the check over: no reload until the id has been seen twice again', async () => {
    const { server, extensionReloads, stop } = await startOnA();
    server.id = ID_B;
    await advance(POLL_INTERVAL_MS); // t = 3 s: first sighting
    server.status = 503; // the next rebuild has started
    await advance(CONFIRM_DELAY_MS); // t = 5.5 s: the confirming poll gets the 503
    expect(extensionReloads()).toBe(0);
    server.status = 200; // settled again, same id
    await advance(POLL_INTERVAL_MS); // t = 6.5 s: first sighting again
    expect(extensionReloads()).toBe(0);
    await advance(CONFIRM_DELAY_MS - 1);
    expect(extensionReloads()).toBe(0);
    await advance(1); // t = 9 s
    expect(extensionReloads()).toBe(1);
    stop();
  });

  it('a different id at the second sighting starts the check over with the new id', async () => {
    const { server, store, extensionReloads, stop } = await startOnA();
    server.id = ID_B;
    await advance(POLL_INTERVAL_MS); // t = 3 s: B for the first time
    server.id = ID_C; // a newer build before B was confirmed
    await advance(CONFIRM_DELAY_MS); // t = 5.5 s: C for the first time
    expect(extensionReloads()).toBe(0);
    await advance(CONFIRM_DELAY_MS - 1);
    expect(extensionReloads()).toBe(0);
    await advance(1); // t = 8 s
    expect(extensionReloads()).toBe(1);
    expect(store.get(BUILD_ID_KEY)).toBe(ID_C);
    stop();
  });

  it('keeps two reloads 20 s apart and coalesces the builds in between into one reload, as soon as the interval is over', async () => {
    const { server, store, extensionReloads, stop } = await startOnA();
    server.id = ID_B; // build 1
    await advance(POLL_INTERVAL_MS + CONFIRM_DELAY_MS); // t = 5.5 s
    expect(extensionReloads()).toBe(1);
    const reloadedAt = Date.now();
    expect(store.get(LAST_RELOAD_AT_KEY)).toBe(reloadedAt);

    server.id = ID_C; // build 2, right after the reload
    await advance(7500); // t = 13 s: C confirmed long ago, but the last reload is too recent
    expect(extensionReloads()).toBe(1);
    server.id = ID_D; // build 3
    await advance(3000);
    expect(extensionReloads()).toBe(1);

    await advance(reloadedAt + MIN_RELOAD_INTERVAL_MS - 1 - Date.now()); // 1 ms before the interval is over
    expect(extensionReloads()).toBe(1);
    expect(store.get(BUILD_ID_KEY)).toBe(ID_B);
    await advance(1); // the interval is over: one reload for C and D together
    expect(extensionReloads()).toBe(2);
    expect(store.get(BUILD_ID_KEY)).toBe(ID_D);
    expect(store.get(LAST_RELOAD_AT_KEY)).toBe(reloadedAt + MIN_RELOAD_INTERVAL_MS);

    await advance(60_000); // nothing more to do for D
    expect(extensionReloads()).toBe(2);
    stop();
  });

  it('keeps the 20 s across a worker restart: the time of the last reload is in storage, nothing else is remembered', async () => {
    const { env, server, store, extensionReloads, stop } = await startOnA();
    server.id = ID_B;
    await advance(POLL_INTERVAL_MS + CONFIRM_DELAY_MS);
    expect(extensionReloads()).toBe(1);
    const reloadedAt = Date.now();

    stop(); // chrome.runtime.reload() ends this worker...
    server.id = ID_C; // ...a newer build lands while the next one starts...
    const stopRestarted = runDevReload(env); // ...which starts with an empty memory and the same chrome.storage.local
    await advance(10_000);
    expect(extensionReloads()).toBe(1);
    await advance(reloadedAt + MIN_RELOAD_INTERVAL_MS - 1 - Date.now());
    expect(extensionReloads()).toBe(1);
    await advance(1);
    expect(extensionReloads()).toBe(2);
    expect(store.get(BUILD_ID_KEY)).toBe(ID_C);
    stopRestarted();
  });

  it('reloads the very moment the 20 s are over, not at the next one-second poll', async () => {
    const { server, store, extensionReloads, stop } = await startOnA();
    const reloadedAt = T0 + 2300; // 300 ms ago, so the end of the interval falls between two polls
    store.set(LAST_RELOAD_AT_KEY, reloadedAt);
    server.id = ID_B;
    await advance(POLL_INTERVAL_MS + CONFIRM_DELAY_MS); // t = 5.5 s: confirmed, but the last reload is too recent
    expect(extensionReloads()).toBe(0);
    await advance(reloadedAt + MIN_RELOAD_INTERVAL_MS - 1 - Date.now());
    expect(extensionReloads()).toBe(0);
    await advance(1);
    expect(extensionReloads()).toBe(1);
    stop();
  });

  it('retries a reload whose storage write failed: nothing was stored, nothing reloaded, the check starts over', async () => {
    const { env, server, store, extensionReloads, stop } = await startOnA();
    vi.mocked(env.storage.set).mockRejectedValueOnce(new Error('storage unavailable'));
    server.id = ID_B;
    await advance(POLL_INTERVAL_MS + CONFIRM_DELAY_MS); // t = 5.5 s: confirmed, but the write fails
    expect(extensionReloads()).toBe(0);
    expect(store.get(BUILD_ID_KEY)).toBe(ID_A);
    expect(store.has(RELOAD_TABS_KEY)).toBe(false);
    expect(store.has(LAST_RELOAD_AT_KEY)).toBe(false);
    await advance(POLL_INTERVAL_MS + CONFIRM_DELAY_MS - 1); // t = 9 s - 1 ms: the new check is not done yet
    expect(extensionReloads()).toBe(0);
    await advance(1);
    expect(extensionReloads()).toBe(1);
    expect(store.get(BUILD_ID_KEY)).toBe(ID_B);
    stop();
  });

  it('backs off while the server is down (1, 2, 4, 8, 10, 10 s) and is back to 1 s once it answers', async () => {
    const { env, server } = createEnv();
    server.id = null;
    const stop = runDevReload(env);

    await advance(0);
    expect(fetchCount(env)).toBe(1);
    let expected = 1;
    for (const wait of [1000, 2000, 4000, 8000, MAX_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS]) {
      await advance(wait - 1);
      expect(fetchCount(env)).toBe(expected); // not yet
      await advance(1);
      expect(fetchCount(env)).toBe(++expected);
    }

    server.id = ID_A;
    await advance(MAX_POLL_INTERVAL_MS); // the next scheduled poll sees the server
    const afterRecovery = fetchCount(env);
    await advance(POLL_INTERVAL_MS);
    expect(fetchCount(env)).toBe(afterRecovery + 1);
    stop();
  });

  it('is silent while the server is down: no storage access, no reload, however long it lasts', async () => {
    const { env, server, store, extensionReloads } = createEnv();
    server.id = null;
    const stop = runDevReload(env);
    await advance(10 * MAX_POLL_INTERVAL_MS);
    expect(store.size).toBe(0);
    expect(extensionReloads()).toBe(0);
    expect(env.queryDiscordTabIds).not.toHaveBeenCalled();
    stop();
  });

  it('survives a storage failure and keeps polling', async () => {
    const { env } = createEnv();
    vi.mocked(env.storage.get).mockRejectedValueOnce(new Error('storage unavailable'));
    const stop = runDevReload(env);
    await advance(3 * POLL_INTERVAL_MS);
    expect(fetchCount(env)).toBeGreaterThanOrEqual(3);
    stop();
  });
});

describe('the dev loop against the real build-id provider on a real dist/ (a git merge = a burst of rebuilds)', () => {
  let dist: string;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dist = mkdtempSync(join(tmpdir(), 'dce-loop-'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dist, { recursive: true, force: true });
  });

  /** What `vite build --watch` does to dist/: every tracked file is rewritten and stamped with the (fake) time. */
  function rebuild(tag: string, ageMs = 0): void {
    const seconds = (Date.now() - ageMs) / 1000;
    for (const name of TRACKED_FILES) {
      writeFileSync(join(dist, name), `${tag} ${name}`);
      utimesSync(join(dist, name), seconds, seconds);
    }
  }

  /** The dev loop wired to the real provider of scripts/dev-server.mjs (its HTTP layer is tested in devServer.test.ts). */
  function startLoop() {
    const { env, store } = createEnv();
    const provider = createBuildIdProvider({ distDir: dist, now: () => Date.now() });
    env.fetch = vi.fn(async () => {
      const id = provider();
      return new Response(id ?? 'building', { status: id === null ? 503 : 200 });
    });
    const reloads: Array<{ at: number; fromQuietDist: boolean }> = [];
    vi.mocked(env.reloadExtension).mockImplementation(() => {
      // what Chrome is about to read: a complete dist/ that nothing has touched for SETTLE_MS
      reloads.push({ at: Date.now() - T0, fromQuietDist: provider() !== null });
    });
    rebuild('initial', 60_000);
    return { stop: runDevReload(env), store, provider, reloads };
  }

  /** Plays `events` (seconds since T0 -> action) while the loop runs, for `seconds` in all. */
  async function play(events: Array<[number, () => void]>, seconds: number): Promise<void> {
    for (let ms = 0; ms < seconds * 1000; ms += 100) {
      for (const [at, action] of events) if (Math.round(at * 1000) === ms) action();
      await vi.advanceTimersByTimeAsync(100);
    }
  }

  it('reloads ONCE, after the burst is over and from a dist/ that is complete and quiet (never from a half-written one)', async () => {
    const { stop, store, provider, reloads } = startLoop();
    const truncateManifest = () => writeFileSync(join(dist, 'manifest.json'), ''); // a write has just begun
    await play(
      [
        [3.0, () => rebuild('1')],
        [3.8, () => rebuild('2')],
        // dist/ is quiet from 5.3 s on: the loop may see the id, but the confirmation is still pending when the next rebuild starts
        [7.0, truncateManifest],
        [7.4, () => rebuild('3')],
        [8.0, () => rebuild('4')],
      ],
      40,
    );
    stop();
    expect(reloads).toHaveLength(1);
    expect(reloads[0]!.fromQuietDist).toBe(true);
    expect(reloads[0]!.at).toBeGreaterThanOrEqual(8000 + SETTLE_MS + CONFIRM_DELAY_MS); // not before the last rebuild is quiet AND confirmed
    expect(reloads[0]!.at).toBeLessThan(8000 + 20_000); // and it does come
    expect(store.get(BUILD_ID_KEY)).toBe(provider()); // it reloaded for the final build
  });

  it('keeps two bursts apart by 20 s and reloads for both together, as soon as the interval is over', async () => {
    const { stop, store, provider, reloads } = startLoop();
    await play(
      [
        [3.0, () => rebuild('a1')],
        [3.8, () => rebuild('a2')],
        [12.0, () => rebuild('b1')], // the second burst starts well after the first reload...
        [12.8, () => rebuild('b2')],
        [13.6, () => rebuild('b3')],
      ],
      60,
    );
    stop();
    expect(reloads).toHaveLength(2); // ...but it is settled and confirmed long before 20 s have passed: one reload, no earlier
    expect(reloads.every((reload) => reload.fromQuietDist)).toBe(true);
    const gap = reloads[1]!.at - reloads[0]!.at;
    expect(gap).toBeGreaterThanOrEqual(MIN_RELOAD_INTERVAL_MS);
    expect(gap).toBeLessThan(MIN_RELOAD_INTERVAL_MS + POLL_INTERVAL_MS);
    expect(store.get(BUILD_ID_KEY)).toBe(provider());
    expect(store.get(LAST_RELOAD_AT_KEY)).toBe(T0 + reloads[1]!.at);
  });

  it('does nothing while dist/ stays as it is, and nothing while the build output is missing entirely', async () => {
    const { stop, reloads } = startLoop();
    await play([], 10);
    for (const name of TRACKED_FILES) rmSync(join(dist, name)); // `npm run dev` cleaning dist/ before the first build
    await play([], 15);
    stop();
    expect(reloads).toEqual([]);
  });
});

describe('startDevReload with the real chrome.* shapes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function stubChrome() {
    const store = new Map<string, unknown>();
    const chromeStub = {
      runtime: { onInstalled: { addListener: vi.fn() }, reload: vi.fn() },
      storage: {
        local: {
          get: vi.fn(async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {})),
          set: vi.fn(async (items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items)) store.set(key, value);
          }),
          remove: vi.fn(async (key: string) => void store.delete(key)),
        },
      },
      tabs: {
        query: vi.fn(async () => [{ id: 5 }, { id: undefined }, { id: 9 }]),
        reload: vi.fn(async () => undefined),
      },
    };
    vi.stubGlobal('chrome', chromeStub);
    const answer = { id: ID_A };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(answer.id)));
    return { chromeStub, store, answer };
  }

  it('registers an onInstalled listener (so the reloaded worker starts), then reloads tabs and the extension on a new build', async () => {
    const { chromeStub, store, answer } = stubChrome();
    store.set(RELOAD_TABS_KEY, [42]);
    const stop = startDevReload();
    expect(chromeStub.runtime.onInstalled.addListener).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(0);
    expect(chromeStub.tabs.reload).toHaveBeenCalledWith(42);
    expect(store.get(BUILD_ID_KEY)).toBe(ID_A);

    answer.id = ID_B;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // first sighting: nothing yet
    expect(chromeStub.runtime.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CONFIRM_DELAY_MS); // seen again, unchanged
    expect(chromeStub.tabs.query).toHaveBeenCalledWith({
      url: ['https://discord.com/*', 'https://ptb.discord.com/*', 'https://canary.discord.com/*'],
    });
    expect(store.get(RELOAD_TABS_KEY)).toEqual([5, 9]); // tabs without an id are skipped
    expect(store.get(LAST_RELOAD_AT_KEY)).toBe(Date.now()); // the real clock: Date.now
    expect(chromeStub.runtime.reload).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('background/index.ts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.useRealTimers();
  });

  it('does not start the dev reload loop in production builds (__DEV__ false): no request to the dev server, no extra listener', async () => {
    const fake = createFakeBrowser();
    vi.resetModules();
    vi.stubGlobal('chrome', fake.chrome);
    const fetchMock = vi.fn(async () => new Response(ID_A));
    vi.stubGlobal('fetch', fetchMock);
    await import('@/background/index');
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.onInstalled.listeners).toHaveLength(1); // the worker's own start-up listener, nothing from the dev reload
    expect(fake.local.has(BUILD_ID_KEY)).toBe(false);
    expect(fake.local.has(RELOAD_TABS_KEY)).toBe(false);
    expect(fake.local.has(LAST_RELOAD_AT_KEY)).toBe(false);
  });

  it('starts the dev reload loop in development builds (__DEV__ true)', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal('__DEV__', true);
    const fake = createFakeBrowser();
    vi.stubGlobal('chrome', fake.chrome);
    const fetchMock = vi.fn(async () => new Response(ID_A));
    vi.stubGlobal('fetch', fetchMock);
    await import('@/background/index');
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.onInstalled.listeners).toHaveLength(2); // the worker's own + the dev reload's wake-up listener
    expect(fetchMock).toHaveBeenCalledWith(BUILD_ID_URL, expect.anything());
    expect(fake.local.peek(BUILD_ID_KEY)).toBe(ID_A);
  });

  it('a development worker still registers every worker listener (the dev loop is an addition)', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal('__DEV__', true);
    const fake = createFakeBrowser();
    vi.stubGlobal('chrome', fake.chrome);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(ID_A)));
    await import('@/background/index');
    expect(fake.onMessage.listeners).toHaveLength(1);
    expect(fake.onDownloadChanged.listeners).toHaveLength(1);
    expect(fake.onBeforeSendHeaders.listeners).toHaveLength(1);
  });
});
