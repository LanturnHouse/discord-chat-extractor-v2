/**
 * Typed access to `chrome.storage` for the background worker, the ONLY writer of the extension's data (docs/PLAN.md §3, §5.2).
 * Values are read through the lenient normalisers of validate.ts, so a damaged or outdated record never breaks a handler.
 *
 * Message handlers are async and interleave at every `await`, so each read-modify-write goes through a mutex. LOCK ORDER (never
 * take them the other way round): `jobLock` (jobs.ts) -> `offscreenLock` (offscreen.ts) -> `sessionLock` / `storageLock`.
 * Network calls and other long waits happen OUTSIDE the storage locks.
 */
import { LOCAL, SESSION, pruneGroupSettings } from '@/shared';
import type { AccountInfo, AppSettings, ExportSettings, GroupInfo, HistoryEntry, JobState, QueueItem } from '@/shared';
import { createMutex, isNumericId, isRecord, maxId } from './util';
import {
  MAX_HISTORY_ENTRIES,
  normalizeGroupSettings,
  normalizeGroups,
  normalizeHistory,
  normalizeJob,
  normalizeLastExported,
  normalizeQueue,
  normalizeSettings,
} from './validate';

/**
 * Serialises every change of `SESSION.job` (start, progress, finish, interrupt) and the start-up checks around it. The
 * outermost lock: a job start holds it while it creates the offscreen document.
 */
export const jobLock = createMutex();
/** Serialises read-modify-write of `chrome.storage.local` (settings, queues, history, incremental markers). */
export const storageLock = createMutex();
/** Serialises read-modify-write of the small `chrome.storage.session` records (inject health, the worker's private state). */
export const sessionLock = createMutex();

export async function getLocal(key: string): Promise<unknown> {
  return (await chrome.storage.local.get(key))[key];
}

export async function getSession(key: string): Promise<unknown> {
  return (await chrome.storage.session.get(key))[key];
}

// ---- session: authorization, account, job ---------------------------------------------------------------------------------

/** The captured authorization value, or null. It stays inside the worker (and, per job, the engine): never log or forward it. */
export async function readToken(): Promise<string | null> {
  const value = await getSession(SESSION.token);
  return typeof value === 'string' && value !== '' ? value : null;
}

function parseAccount(raw: unknown): AccountInfo | null {
  if (!isRecord(raw)) return null;
  const { id, username, globalName, avatarUrl } = raw;
  if (!isNumericId(id) || typeof username !== 'string' || typeof avatarUrl !== 'string') return null;
  if (globalName !== null && typeof globalName !== 'string') return null;
  return { id, username, globalName, avatarUrl };
}

/** The account the current authorization belongs to (verified through `users/@me`), or null. */
export async function readAccount(): Promise<AccountInfo | null> {
  return parseAccount(await getSession(SESSION.account));
}

export async function readLastAccount(): Promise<AccountInfo | null> {
  return parseAccount(await getLocal(LOCAL.lastAccount));
}

const sameAccount = (a: AccountInfo | null, b: AccountInfo): boolean =>
  a !== null && a.id === b.id && a.username === b.username && a.globalName === b.globalName && a.avatarUrl === b.avatarUrl;

/** Serialises the two writes of `writeAccount` (a leaf lock: nothing else is taken while it is held). */
const accountLock = createMutex();

/**
 * Stores the verified account (`SESSION.account`) and remembers it as the last one (`LOCAL.lastAccount`); null only clears the
 * former.
 *
 * `onlyIfToken` makes it conditional, checked INSIDE the lock so it cannot be overtaken: the account is written only while the
 * stored authorization is still `onlyIfToken` (a string), or while there is none (`null`). A verdict for an old value, or the
 * clearing after a removal, therefore never overwrites what a newer capture has set. Returns whether it wrote.
 */
export function writeAccount(account: AccountInfo | null, onlyIfToken?: string | null): Promise<boolean> {
  return accountLock.run(async () => {
    if (onlyIfToken !== undefined && (await readToken()) !== onlyIfToken) return false;
    await chrome.storage.session.set({ [SESSION.account]: account });
    if (account !== null && !sameAccount(parseAccount(await getLocal(LOCAL.lastAccount)), account)) {
      await chrome.storage.local.set({ [LOCAL.lastAccount]: account });
    }
    return true;
  });
}

export async function readJob(): Promise<JobState | null> {
  return normalizeJob(await getSession(SESSION.job));
}

export async function writeJob(job: JobState | null): Promise<void> {
  await chrome.storage.session.set({ [SESSION.job]: job });
}

export const isActiveJob = (job: JobState | null): job is JobState => job !== null && (job.state === 'running' || job.state === 'paused');

// ---- local: settings ------------------------------------------------------------------------------------------------------

/** `LOCAL.settings` deep-merged over the defaults. */
export async function readSettings(): Promise<AppSettings> {
  return normalizeSettings(await getLocal(LOCAL.settings));
}

/** Applies a validated shallow patch (`common` replaced whole) and stores the complete settings. */
export function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return storageLock.run(async () => {
    const next: AppSettings = { ...normalizeSettings(await getLocal(LOCAL.settings)), ...patch };
    await chrome.storage.local.set({ [LOCAL.settings]: next });
    return next;
  });
}

// ---- local: queue ---------------------------------------------------------------------------------------------------------

export async function readQueue(accountId: string): Promise<QueueItem[]> {
  return normalizeQueue(await getLocal(LOCAL.queue(accountId)));
}

/**
 * Everything that decides what a queue item runs with, as one consistent picture (docs/PLAN.md §5.5): the queue, the groups the
 * worker recorded (`LOCAL.groups`) and the settings of servers and categories (`LOCAL.groupSettings`).
 */
export interface QueueState {
  items: QueueItem[];
  groups: Record<string, GroupInfo>;
  groupSettings: Record<string, ExportSettings>;
}

const queueStateKeys = (accountId: string): [queue: string, groups: string, groupSettings: string] => [
  LOCAL.queue(accountId),
  LOCAL.groups(accountId),
  LOCAL.groupSettings(accountId),
];

function parseQueueState(stored: Record<string, unknown>, accountId: string): QueueState {
  const [queueKey, groupsKey, groupSettingsKey] = queueStateKeys(accountId);
  return {
    items: normalizeQueue(stored[queueKey]),
    groups: normalizeGroups(stored[groupsKey]),
    groupSettings: normalizeGroupSettings(stored[groupSettingsKey]),
  };
}

/** The account's queue, groups and group settings, read in ONE storage call (a writer never leaves them half changed). */
export async function readQueueState(accountId: string): Promise<QueueState> {
  return parseQueueState(await chrome.storage.local.get(queueStateKeys(accountId)), accountId);
}

/**
 * Runs `mutate` on the account's queue state (edit `items`, `groupSettings` and, if it must, `groups` in place) under the storage
 * lock and writes back what changed, all in ONE `chrome.storage.local.set`, so the queue and the group settings never disagree
 * for a reader and no other queue writer can slip in between. `mutate` must be synchronous: no `await` while the lock is held.
 *
 * Group settings must never outlive the last queued channel of their group (docs/PLAN.md §7.2a): whenever `mutate` takes an
 * item out of the queue OR changes the recorded groups (a re-record of a guild: a channel moved to another category, a category
 * was deleted), `pruneGroupSettings` (src/shared/groups.ts) then drops the settings of every group that has no item left, in the
 * same write.
 */
export function mutateQueueState<T>(accountId: string, mutate: (state: QueueState) => T): Promise<T> {
  return storageLock.run(async () => {
    const [queueKey, groupsKey, groupSettingsKey] = queueStateKeys(accountId);
    const state = parseQueueState(await chrome.storage.local.get([queueKey, groupsKey, groupSettingsKey]), accountId);
    const before = { items: JSON.stringify(state.items), groups: JSON.stringify(state.groups), groupSettings: JSON.stringify(state.groupSettings) };
    const keysBefore = state.items.map((item) => item.key);

    const result = mutate(state);

    const keysAfter = new Set(state.items.map((item) => item.key));
    const shrunk = keysBefore.some((key) => !keysAfter.has(key));
    if (shrunk || JSON.stringify(state.groups) !== before.groups) {
      state.groupSettings = pruneGroupSettings(state.groupSettings, state.items, state.groups) as Record<string, ExportSettings>;
    }

    const updates: Record<string, unknown> = {};
    if (JSON.stringify(state.items) !== before.items) updates[queueKey] = state.items;
    if (JSON.stringify(state.groups) !== before.groups) updates[groupsKey] = state.groups;
    if (JSON.stringify(state.groupSettings) !== before.groupSettings) updates[groupSettingsKey] = state.groupSettings;
    if (Object.keys(updates).length > 0) await chrome.storage.local.set(updates);
    return result;
  });
}

/**
 * Runs `mutate` on the account's queue (edit the array in place) under the storage lock and writes it back when it changed. An
 * item that leaves the queue takes the settings of an emptied server or category with it (see `mutateQueueState`).
 * `mutate` must be synchronous: no `await` while the lock is held.
 */
export function mutateQueue<T>(accountId: string, mutate: (items: QueueItem[]) => T): Promise<T> {
  return mutateQueueState(accountId, (state) => mutate(state.items));
}

export interface QueueMark {
  key: string;
  status: 'partial' | 'failed' | 'cancelled';
  message: string;
  at: number;
}

const MAX_MESSAGE_LENGTH = 300;

/**
 * Sets `lastResult` on queue items (the retry hint of the popup). An item whose `lastResult` is already from this job
 * (`at >= jobStartedAt`: the engine reported it through `engine/itemDone`) keeps it.
 */
export function markQueueResults(accountId: string, marks: readonly QueueMark[], jobStartedAt: number): Promise<void> {
  if (marks.length === 0) return Promise.resolve();
  return mutateQueue(accountId, (items) => {
    for (const mark of marks) {
      const item = items.find((candidate) => candidate.key === mark.key);
      if (!item) continue;
      if (item.lastResult && item.lastResult.at >= jobStartedAt) continue;
      item.lastResult = { status: mark.status, message: mark.message.slice(0, MAX_MESSAGE_LENGTH), at: mark.at };
    }
  });
}

// ---- local: history and incremental markers -------------------------------------------------------------------------------

export async function readHistory(accountId: string): Promise<HistoryEntry[]> {
  return normalizeHistory(await getLocal(LOCAL.history(accountId)));
}

export function clearHistory(accountId: string): Promise<void> {
  return storageLock.run(() => chrome.storage.local.set({ [LOCAL.history(accountId)]: [] }));
}

export async function readLastExported(accountId: string): Promise<Record<string, string>> {
  return normalizeLastExported(await getLocal(LOCAL.lastExported(accountId)));
}

export interface ItemResult {
  /** The engine's history entry (already validated). */
  entry: HistoryEntry;
  /** Newest message id of the export, or null (nothing exported). */
  lastMessageId: string | null;
  /** False for a job started from the history (docs: "queue untouched"): then the queue is not edited at all. */
  touchQueue: boolean;
  /** The job's progress says the user cancelled this item: its queue hint is 'cancelled' instead of 'failed'. */
  cancelled: boolean;
}

/**
 * The bookkeeping of one finished item, in ONE storage write (docs/PLAN.md §6.7):
 *  - history: the entry goes first (newest first), an entry with the same id is replaced, at most 200 are kept;
 *  - `done`: the incremental marker `lastExported[channelId]` advances to the entry's newest message id (never backwards:
 *    an export of an older date range must not make the next "new messages only" run repeat messages) and the item leaves
 *    the queue, taking the settings of a server or category it was the last item of with it (`pruneGroupSettings`);
 *  - `partial` / `failed` (or cancelled): the item stays in the queue with a `lastResult` hint; the marker is not touched.
 */
export function recordItemResult(accountId: string, { entry, lastMessageId, touchQueue, cancelled }: ItemResult): Promise<void> {
  return storageLock.run(async () => {
    const [queueKey, groupsKey, groupSettingsKey] = queueStateKeys(accountId);
    const historyKey = LOCAL.history(accountId);
    const markerKey = LOCAL.lastExported(accountId);
    const stored = await chrome.storage.local.get([queueKey, groupsKey, groupSettingsKey, historyKey, markerKey]);
    const channelId = entry.target.channelId;
    const updates: Record<string, unknown> = {};

    const history = normalizeHistory(stored[historyKey]).filter((existing) => existing.id !== entry.id);
    updates[historyKey] = [entry, ...history].slice(0, MAX_HISTORY_ENTRIES);

    if (entry.status === 'done' && lastMessageId !== null) {
      const markers = normalizeLastExported(stored[markerKey]);
      markers[channelId] = maxId(markers[channelId], lastMessageId) ?? lastMessageId;
      updates[markerKey] = markers;
    }

    if (touchQueue) {
      const queue = normalizeQueue(stored[queueKey]);
      if (entry.status === 'done') {
        const rest = queue.filter((item) => item.key !== channelId);
        if (rest.length !== queue.length) {
          updates[queueKey] = rest;
          // the item is gone: so are the settings of a server or category that has no queued channel left
          const groupSettings = normalizeGroupSettings(stored[groupSettingsKey]);
          const kept = pruneGroupSettings(groupSettings, rest, normalizeGroups(stored[groupsKey]));
          if (kept !== groupSettings) updates[groupSettingsKey] = kept;
        }
      } else {
        const item = queue.find((candidate) => candidate.key === channelId);
        if (item) {
          item.lastResult = {
            status: cancelled ? 'cancelled' : entry.status,
            message: (entry.error ?? entry.status).slice(0, MAX_MESSAGE_LENGTH),
            at: entry.finishedAt,
          };
          updates[queueKey] = queue;
        }
      }
    }

    await chrome.storage.local.set(updates);
  });
}

// ---- session: the worker's private state ----------------------------------------------------------------------------------

/** chrome.storage.session key of `BgState`. Private to the worker (not part of the §5.2 contract; the popup does not read it). */
export const BG_STATE_KEY = 'dce.bg.state';

/**
 * What the worker must remember across its own restarts (an MV3 worker is suspended after ~30 s without events) and nothing
 * more. No secrets: blob URLs are `blob:chrome-extension://<id>/<uuid>`.
 */
export interface BgState {
  /** The job the fields below belong to. */
  jobId: string | null;
  /** 'history' for a re-run from the history: such a job leaves the queue untouched. */
  source: 'queue' | 'history';
  /** Chrome's id of the newest file the job saved (the notification's "open folder" shows it). */
  lastDownloadId: number | null;
  /** Downloads that read an offscreen blob URL and have not finished: downloadId (as string) -> blob URL to revoke. */
  blobs: Record<string, string>;
  /** A job ended with failures and the popup has not been opened since (red `!` badge). */
  alert: boolean;
}

const emptyBgState = (): BgState => ({ jobId: null, source: 'queue', lastDownloadId: null, blobs: {}, alert: false });

function parseBgState(raw: unknown): BgState {
  const state = emptyBgState();
  if (!isRecord(raw)) return state;
  if (typeof raw.jobId === 'string') state.jobId = raw.jobId;
  if (raw.source === 'history') state.source = 'history';
  if (typeof raw.lastDownloadId === 'number' && Number.isInteger(raw.lastDownloadId) && raw.lastDownloadId >= 0) state.lastDownloadId = raw.lastDownloadId;
  if (isRecord(raw.blobs)) {
    for (const [id, url] of Object.entries(raw.blobs)) if (/^\d+$/.test(id) && typeof url === 'string') state.blobs[id] = url;
  }
  if (raw.alert === true) state.alert = true;
  return state;
}

export async function readBgState(): Promise<BgState> {
  return parseBgState(await getSession(BG_STATE_KEY));
}

/** Edits the private state in place under the session lock (synchronously: no `await` inside `update`). */
export function updateBgState<T>(update: (state: BgState) => T): Promise<T> {
  return sessionLock.run(async () => {
    const state = parseBgState(await getSession(BG_STATE_KEY));
    const before = JSON.stringify(state);
    const result = update(state);
    if (JSON.stringify(state) !== before) await chrome.storage.session.set({ [BG_STATE_KEY]: state });
    return result;
  });
}
