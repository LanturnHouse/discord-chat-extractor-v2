/**
 * Development live reload (docs/PLAN.md §9). background/index.ts imports this behind `if (__DEV__)`, so production builds
 * do not contain it.
 *
 * `npm run dev` rebuilds dist/ on every source change and serves a hash of the build on http://localhost:5858/build-id
 * (scripts/dev-server.mjs), which answers 503 while dist/ is being written and for a moment after the last write. The worker
 * polls it every second. Chrome reads dist/ again when the extension reloads, and a reload from a half-written dist/ (a git
 * merge rewrites many files and causes several rebuilds in a row) leaves the unpacked extension dead. So a build id that differs
 * from the one this worker runs is acted on only when
 *   - it is served (HTTP 200) a second time, unchanged, CONFIRM_DELAY_MS after it was first seen: a 503, a connection error or
 *     yet another id in between starts the check over; and
 *   - at least MIN_RELOAD_INTERVAL_MS have passed since the previous reload (its time is kept in chrome.storage.local, which
 *     survives the restart): builds that arrive sooner are coalesced into ONE reload, as soon as the interval is over.
 * Then the worker stores the ids of the open Discord tabs in chrome.storage.local and reloads the extension; the freshly started
 * worker reloads those tabs (so they run the new content script) and clears the key. While the dev server is down every poll
 * fails silently and the polling backs off.
 *
 * Note: while the dev server is reachable, each poll touches chrome.storage, which also keeps the service worker alive
 * (production workers are suspended after ~30 s idle). Test suspend/resume behaviour with a production build.
 */
import { DISCORD_ORIGINS } from '@/shared/defaults';

export const DEV_SERVER_ORIGIN = 'http://localhost:5858';
export const BUILD_ID_URL = `${DEV_SERVER_ORIGIN}/build-id`;
/** chrome.storage.local: ids of the Discord tabs to reload once the restarted worker is up. Cleared before they are reloaded. */
export const RELOAD_TABS_KEY = 'dce.dev.reloadTabs';
/** chrome.storage.local: the last build id seen, so a worker restart or a reload is not mistaken for a new build. */
export const BUILD_ID_KEY = 'dce.dev.buildId';
/** chrome.storage.local: when this loop last called `chrome.runtime.reload()` (ms since the epoch); read again by the restarted worker. */
export const LAST_RELOAD_AT_KEY = 'dce.dev.lastReloadAt';
export const POLL_INTERVAL_MS = 1000;
/** With the dev server down the poll interval doubles up to this, so a stopped server does not spam the console. */
export const MAX_POLL_INTERVAL_MS = 10_000;
/** A new build id must be served again, unchanged, this long after it was first seen before the extension reloads for it. */
export const CONFIRM_DELAY_MS = 2500;
/** Two `chrome.runtime.reload()` calls are at least this far apart. */
export const MIN_RELOAD_INTERVAL_MS = 20_000;
const FETCH_TIMEOUT_MS = 800;

/** The slice of the platform this module needs; `chromeEnv()` is the real one, tests pass fakes. */
export interface DevReloadEnv {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  storage: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(key: string): Promise<void>;
  };
  /** Ids of the open Discord tabs (all three origins). */
  queryDiscordTabIds(): Promise<number[]>;
  reloadTab(tabId: number): Promise<unknown>;
  reloadExtension(): void;
  /** Milliseconds since the epoch. Defaults to `Date.now` (which fake timers also fake). */
  now?: () => number;
}

function chromeEnv(): DevReloadEnv {
  return {
    fetch: (url, init) => fetch(url, init),
    storage: chrome.storage.local,
    queryDiscordTabIds: async () => {
      const tabs = await chrome.tabs.query({ url: DISCORD_ORIGINS.map((origin) => `${origin}/*`) });
      return tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id]));
    },
    reloadTab: (tabId) => chrome.tabs.reload(tabId),
    reloadExtension: () => chrome.runtime.reload(),
  };
}

const clock = (env: Pick<DevReloadEnv, 'now'>): number => (env.now ?? Date.now)();

/** The build id the dev server reports, or null when it is down, answers anything but 200 (503 while building) or sends junk. Never throws. */
export async function fetchBuildId(env: Pick<DevReloadEnv, 'fetch'>): Promise<string | null> {
  try {
    const response = await env.fetch(BUILD_ID_URL, { cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (response.status !== 200) return null;
    const id = (await response.text()).trim();
    return /^[0-9a-f]{6,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Worker start: reload the Discord tabs the previous incarnation left in storage, exactly once. */
export async function reloadPendingTabs(env: Pick<DevReloadEnv, 'storage' | 'reloadTab'>): Promise<void> {
  const pending = (await env.storage.get(RELOAD_TABS_KEY))[RELOAD_TABS_KEY];
  if (pending === undefined) return;
  await env.storage.remove(RELOAD_TABS_KEY); // first, so a failure below can never turn into a reload loop
  if (!Array.isArray(pending)) return;
  const tabIds = pending.filter((id): id is number => Number.isInteger(id));
  await Promise.all(tabIds.map((tabId) => Promise.resolve(env.reloadTab(tabId)).catch(() => undefined))); // tab closed meanwhile
}

/**
 * What one poll found:
 *  - 'offline'   the server is down, still building (503) or sent junk; a check in progress starts over
 *  - 'unchanged' the id is the one this worker runs
 *  - 'baseline'  the first build id this browser profile has seen: remembered, no reload
 *  - 'pending'   a new id that has not been served for CONFIRM_DELAY_MS yet
 *  - 'deferred'  a confirmed new id, but the last reload is less than MIN_RELOAD_INTERVAL_MS ago: waits until `watch.reloadAt`
 *  - 'reload'    the extension is being reloaded
 */
export type BuildCheck = 'offline' | 'unchanged' | 'baseline' | 'pending' | 'deferred' | 'reload';

/** What the polling loop remembers between two polls. In memory only: a restarted worker starts the check over. */
export interface BuildWatch {
  /** A build id that differs from the one this worker runs, and when it was first seen; null = nothing to confirm. */
  candidate: { id: string; since: number } | null;
  /** While a confirmed reload waits for MIN_RELOAD_INTERVAL_MS: the time (ms since the epoch) it may go ahead. */
  reloadAt: number | null;
}

export function createBuildWatch(): BuildWatch {
  return { candidate: null, reloadAt: null };
}

/** Starts the check over: nothing seen so far counts any more. */
function clearWatch(watch: BuildWatch): void {
  watch.candidate = null;
  watch.reloadAt = null;
}

/** Milliseconds until MIN_RELOAD_INTERVAL_MS have passed since `lastReloadAt`; 0 = go ahead (never reloaded, junk, or a clock set back). */
function reloadWaitMs(lastReloadAt: unknown, now: number): number {
  if (typeof lastReloadAt !== 'number' || !(lastReloadAt <= now)) return 0;
  return Math.max(0, lastReloadAt + MIN_RELOAD_INTERVAL_MS - now);
}

/**
 * One poll. A new build id is not acted on at once: it becomes the candidate ('pending') and the extension reloads only when
 * the same id is served again CONFIRM_DELAY_MS or more after it was first seen, with no miss in between, and the previous
 * reload is at least MIN_RELOAD_INTERVAL_MS old. `watch` carries the candidate from one call to the next.
 */
export async function checkBuild(env: DevReloadEnv, watch: BuildWatch = createBuildWatch()): Promise<BuildCheck> {
  const id = await fetchBuildId(env);
  if (id === null) {
    clearWatch(watch); // a 503, a refused connection or junk: whatever was seen before no longer counts as "in a row"
    return 'offline';
  }
  const previous = (await env.storage.get(BUILD_ID_KEY))[BUILD_ID_KEY];
  if (previous === id) {
    clearWatch(watch);
    return 'unchanged';
  }
  if (typeof previous !== 'string') {
    clearWatch(watch);
    await env.storage.set({ [BUILD_ID_KEY]: id });
    return 'baseline';
  }

  const now = clock(env);
  const candidate = watch.candidate?.id === id ? watch.candidate : { id, since: now }; // another id restarts the check
  watch.candidate = candidate;
  watch.reloadAt = null;
  if (now - candidate.since < CONFIRM_DELAY_MS) return 'pending';

  const lastReloadAt = (await env.storage.get(LAST_RELOAD_AT_KEY))[LAST_RELOAD_AT_KEY];
  const wait = reloadWaitMs(lastReloadAt, now);
  if (wait > 0) {
    watch.reloadAt = now + wait;
    return 'deferred';
  }

  const tabIds = await env.queryDiscordTabIds();
  // One write: the new id and the reload time survive the reload (so there is no reload loop), or nothing is stored and the next poll retries.
  await env.storage.set({ [BUILD_ID_KEY]: id, [RELOAD_TABS_KEY]: tabIds, [LAST_RELOAD_AT_KEY]: clock(env) });
  clearWatch(watch);
  env.reloadExtension();
  return 'reload';
}

/** Milliseconds until the next poll. */
function nextPollDelay(result: BuildCheck, failures: number, watch: BuildWatch, now: number): number {
  // While the server is down 1, 2, 4, 8 s ... up to MAX_POLL_INTERVAL_MS.
  if (result === 'offline') return Math.min(POLL_INTERVAL_MS * 2 ** (failures - 1), MAX_POLL_INTERVAL_MS);
  // The confirming poll comes exactly CONFIRM_DELAY_MS after the first sighting.
  if (result === 'pending' && watch.candidate !== null) return Math.max(0, watch.candidate.since + CONFIRM_DELAY_MS - now);
  // Keep watching every second while a confirmed reload waits, but wake up the moment the interval is over.
  if (result === 'deferred' && watch.reloadAt !== null) return Math.max(0, Math.min(POLL_INTERVAL_MS, watch.reloadAt - now));
  return POLL_INTERVAL_MS;
}

/** The testable core of `startDevReload`. Returns a function that stops the polling. */
export function runDevReload(env: DevReloadEnv): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0; // consecutive polls that found the dev server down
  const watch = createBuildWatch();

  void reloadPendingTabs(env).catch(() => undefined);

  const poll = async (): Promise<void> => {
    let result: BuildCheck = 'offline';
    try {
      result = await checkBuild(env, watch);
    } catch {
      clearWatch(watch); // storage or tabs hiccup: start the check over and try again on the next tick
    }
    if (stopped) return;
    failures = result === 'offline' ? failures + 1 : 0;
    timer = setTimeout(() => void poll(), nextPollDelay(result, failures, watch, clock(env)));
  };
  void poll();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** Starts the dev reload loop with the real `chrome.*` APIs. Call synchronously at the top level of the service worker. */
export function startDevReload(): () => void {
  // Chrome starts a worker to deliver `onInstalled` (it fires after chrome.runtime.reload() too); with this listener
  // registered the freshly reloaded worker is guaranteed to start and run `reloadPendingTabs` even if nothing else wakes it.
  chrome.runtime.onInstalled.addListener(() => undefined);
  return runDevReload(chromeEnv());
}
