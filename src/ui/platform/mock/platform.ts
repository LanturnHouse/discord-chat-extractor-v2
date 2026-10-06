import {
  LOCAL,
  SESSION,
  pruneGroupSettings,
  resolveEffectiveSettings,
  belongsToGroup,
  type AccountInfo,
  type BgError,
  type BgResponse,
  type ExportSettings,
  type GroupMap,
  type GroupSettingsMap,
  type HistoryEntry,
  type InjectHealth,
  type ItemProgress,
  type JobState,
  type QueueItem,
  type StatusSnapshot,
  type ToBackground,
} from '@/shared';
import { formatTargetLabel } from '../../format/summary';
import { groupOverrides } from '../../groups/overrides';
import { assertReadableKeys, assertWritableKeys, readableChanges } from '../guard';
import {
  isRecord,
  normalizeAccount,
  normalizeExportSettings,
  normalizeGroupSettings,
  normalizeGroups,
  normalizeHistory,
  normalizeJob,
  normalizeQueue,
  normalizeSettings,
} from '../normalize';
import type { BgDataOf, Platform, ShortcutInfo, StorageArea, StorageChange, StorageListener } from '../types';
import { MOCK_ACCOUNT, MOCK_SHORTCUTS, buildScenario, type MockInitialState, type MockScenario } from './data';

export interface MockOptions {
  scenario?: MockScenario;
  /** The clock. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Simulate the passing of time: a started download makes progress and finishes, opening Discord finds the account a moment
   * later. Off by default (tests drive the state by hand); the preview turns it on.
   */
  autoRun?: boolean;
  /** What `getUiLanguage()` returns. Defaults to 'ko'. */
  uiLanguage?: string;
}

/**
 * The in-memory mock platform: a fake `chrome.storage` (local + session, change notifications included) and a fake background
 * worker that answers every message of docs/PLAN.md §5.3 the way the real one is specified to, so the popup can be inspected
 * in a normal browser tab (`popup.html?mock=1`) and tested without Chrome. Like the real thing it serialises what it stores
 * (JSON), so the UI can never mutate the "stored" data by accident, and it refuses reads of the authentication keys.
 */
export interface MockPlatform extends Platform {
  readonly kind: 'mock';
  /** Every message the popup has sent, in order. */
  readonly sent: readonly ToBackground[];
  /** The stored value (a copy) - what a test asserts on. */
  read(area: StorageArea, key: string): unknown;
  /** Writes the way the background worker or the content script would: updates storage, then notifies the listeners (asynchronously). */
  write(area: StorageArea, items: Readonly<Record<string, unknown>>): void;
  /** What `status/get` reports besides the stored account and job. */
  setDiscordTabs(count: number): void;
  setHealth(health: InjectHealth | null): void;
  setShortcuts(shortcuts: readonly ShortcutInfo[]): void;
  /** The next message of this type is answered with this error (once). */
  failNext(type: ToBackground['type'], error: BgError, message?: string): void;
  /** Replaces everything with a scenario; listeners are told about every key that changed. */
  load(scenario: MockScenario): void;
  /** Stops the simulation timers. */
  dispose(): void;
}

const TICK_MS = 700;
const AUTO_COUNT_WHEN_ALL = 400;

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

const ok = <T>(data: T): BgResponse<T> => ({ ok: true, data });
const fail = (error: BgError, message?: string): BgResponse<never> => (message === undefined ? { ok: false, error } : { ok: false, error, message });

export function createMockPlatform(options: MockOptions = {}): MockPlatform {
  const now = options.now ?? Date.now;
  const stores: Record<StorageArea, Map<string, unknown>> = { local: new Map(), session: new Map() };
  const listeners = new Set<StorageListener>();
  const sent: ToBackground[] = [];
  const failures = new Map<string, { error: BgError; message?: string }>();
  let discordTabs = 1;
  let health: InjectHealth | null = null;
  let shortcuts: ShortcutInfo[] = MOCK_SHORTCUTS.map((shortcut) => ({ ...shortcut }));
  let jobCounter = 1;
  let downloadCounter = 100;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  /** The chats of the running job: its progress rows only carry a key and a label. */
  const jobItems = new Map<string, { item: QueueItem; settings: ExportSettings }>();

  // --- storage -----------------------------------------------------------------------------------------------------

  const notify = (area: StorageArea, changes: Record<string, StorageChange>): void => {
    const allowed = readableChanges(area, changes);
    if (Object.keys(allowed).length === 0) return;
    queueMicrotask(() => {
      for (const listener of [...listeners]) listener(area, allowed);
    });
  };

  const write = (area: StorageArea, items: Readonly<Record<string, unknown>>): void => {
    const changes: Record<string, StorageChange> = {};
    for (const [key, value] of Object.entries(items)) {
      const oldValue = stores[area].get(key);
      if (value === undefined) stores[area].delete(key);
      else stores[area].set(key, clone(value));
      changes[key] = { oldValue: clone(oldValue), newValue: clone(value) };
    }
    notify(area, changes);
  };

  /** Replaces the whole storage. `silent` (the very first fill) tells nobody: nothing has changed for anyone yet. */
  const fill = (initial: MockInitialState, silent = false): void => {
    const changes: Record<StorageArea, Record<string, StorageChange>> = { local: {}, session: {} };
    for (const area of ['local', 'session'] as const) {
      const next = initial[area];
      const before = stores[area];
      stores[area] = new Map(Object.entries(next).map(([key, value]) => [key, clone(value)]));
      for (const key of new Set([...before.keys(), ...Object.keys(next)])) {
        changes[area][key] = { oldValue: clone(before.get(key)), newValue: clone(next[key]) };
      }
    }
    discordTabs = initial.discordTabs;
    health = initial.health === null ? null : { ...initial.health };
    if (silent) return;
    notify('local', changes.local);
    notify('session', changes.session);
  };

  // --- what the background worker knows -----------------------------------------------------------------------------

  const settings = () => normalizeSettings(stores.local.get(LOCAL.settings));
  const account = (): AccountInfo | null => normalizeAccount(stores.session.get(SESSION.account));
  const lastAccount = (): AccountInfo | null => normalizeAccount(stores.local.get(LOCAL.lastAccount));
  const job = (): JobState | null => normalizeJob(stores.session.get(SESSION.job));
  const activeAccountId = (): string | null => (account() ?? lastAccount())?.id ?? null;
  const queueOf = (id: string): QueueItem[] => normalizeQueue(stores.local.get(LOCAL.queue(id)));
  const groupsOf = (id: string): GroupMap => normalizeGroups(stores.local.get(LOCAL.groups(id)));
  const groupSettingsOf = (id: string): GroupSettingsMap => normalizeGroupSettings(stores.local.get(LOCAL.groupSettings(id)));

  /**
   * Stores a new list. Like the background worker, every path that takes chats out of the list also drops the settings of the
   * servers and categories that have no queued chat left (`pruneGroupSettings`), so an emptied group does not bring its old
   * settings back when someone adds a chat to it later.
   */
  const saveQueue = (id: string, next: QueueItem[], extra: Record<string, unknown> = {}): void => {
    const before = groupSettingsOf(id);
    const after = pruneGroupSettings(before, next, groupsOf(id));
    write('local', { [LOCAL.queue(id)]: next, ...(after === before ? {} : { [LOCAL.groupSettings(id)]: after }), ...extra });
  };
  const historyOf = (id: string): HistoryEntry[] => normalizeHistory(stores.local.get(LOCAL.history(id)));
  const isActive = (state: JobState | null): state is JobState => state !== null && (state.state === 'running' || state.state === 'paused');

  const status = (): StatusSnapshot => ({ account: account(), lastAccount: lastAccount(), discordTabs, health: health === null ? null : { ...health }, job: job() });

  /** What an export of `item` runs with: its own settings, else its category's, its server's, the common ones (docs/PLAN.md §5.5). */
  const effectiveOf = (accountId: string, item: QueueItem, common: ExportSettings): ExportSettings =>
    resolveEffectiveSettings(item, common, groupSettingsOf(accountId), groupsOf(accountId)).settings;

  const progressOf = (accountId: string, item: QueueItem, common: ExportSettings): ItemProgress => {
    const effective = effectiveOf(accountId, item, common);
    jobItems.set(item.key, { item, settings: effective });
    return { key: item.key, label: formatTargetLabel(item.target), status: 'waiting', phase: null, fetched: 0, expected: effective.count, error: null, files: [] };
  };

  const beginJob = (items: QueueItem[], accountId: string): BgResponse<{ jobId: string }> => {
    const current = settings();
    jobItems.clear();
    const state: JobState = {
      jobId: `mock-job-${jobCounter++}`,
      accountId,
      startedAt: now(),
      finishedAt: null,
      state: 'running',
      pausedReason: null,
      zip: current.zipAll && items.length > 1,
      items: items.map((item) => progressOf(accountId, item, current.common)),
    };
    write('session', { [SESSION.job]: state });
    schedule();
    return ok({ jobId: state.jobId });
  };

  const guardJob = (): BgResponse<never> | null => {
    if (account() === null) return fail('no-account');
    if (settings().consentAt === null) return fail('no-consent');
    if (isActive(job())) return fail('busy');
    return null;
  };

  // --- simulated time ----------------------------------------------------------------------------------------------

  /** A scenario that starts with a download in progress: its chats are the ones in the list. */
  const seedRunningJob = (): void => {
    jobItems.clear();
    const common = settings().common;
    for (const item of queueOf(MOCK_ACCOUNT.id)) jobItems.set(item.key, { item, settings: effectiveOf(MOCK_ACCOUNT.id, item, common) });
    schedule();
  };

  const finishItem = (state: JobState, row: ItemProgress): void => {
    const known = jobItems.get(row.key);
    const accountId = state.accountId;
    if (known === undefined) return;
    const filename = `Discord Export/${row.label.replaceAll(' > ', ' - ').replaceAll('#', '')}.${known.settings.format}`;
    row.files = [filename];
    const entry: HistoryEntry = {
      id: `history-${now()}-${row.key}`,
      accountId,
      target: known.item.target,
      settings: known.settings,
      finishedAt: now(),
      status: 'done',
      messageCount: row.fetched,
      files: [{ filename, downloadId: downloadCounter++ }],
      error: null,
    };
    saveQueue(
      accountId,
      queueOf(accountId).filter((candidate) => candidate.key !== row.key),
      { [LOCAL.history(accountId)]: [entry, ...historyOf(accountId)].slice(0, 200) },
    );
  };

  const step = (): void => {
    const state = job();
    if (!isActive(state)) return;
    const rows = state.items;
    let row = rows.find((candidate) => candidate.status === 'running');
    if (row === undefined) {
      row = rows.find((candidate) => candidate.status === 'waiting');
      if (row !== undefined) {
        row.status = 'running';
        row.phase = 'messages';
      }
    } else if (row.phase === 'messages') {
      const total = row.expected ?? AUTO_COUNT_WHEN_ALL;
      row.fetched = Math.min(total, row.fetched + 50);
      if (row.fetched >= total) row.phase = 'writing';
    } else if (row.phase === 'writing') {
      row.phase = 'saving';
    } else {
      row.status = 'done';
      finishItem(state, row);
    }
    if (rows.every((candidate) => candidate.status === 'done' || candidate.status === 'partial' || candidate.status === 'failed' || candidate.status === 'cancelled')) {
      state.state = 'done';
      state.finishedAt = now();
    }
    write('session', { [SESSION.job]: state });
    schedule();
  };

  function schedule(): void {
    if (options.autoRun !== true || timer !== null || !isActive(job())) return;
    timer = setTimeout(() => {
      timer = null;
      step();
    }, TICK_MS);
  }

  // --- messages ----------------------------------------------------------------------------------------------------

  const handle = (message: ToBackground): BgResponse<unknown> => {
    const failure = failures.get(message.type);
    if (failure !== undefined) {
      failures.delete(message.type);
      return fail(failure.error, failure.message);
    }
    switch (message.type) {
      case 'status/get':
        return ok(status());
      case 'settings/patch':
        write('local', { [LOCAL.settings]: { ...settings(), ...clone(message.patch) } });
        return ok(undefined);
      case 'queue/upsert':
      case 'queue/remove':
      case 'queue/clear':
      case 'queue/toggle': {
        const id = activeAccountId();
        if (id === null) return fail('no-account');
        const queue = queueOf(id);
        if (message.type === 'queue/clear') {
          saveQueue(id, []);
          return ok(undefined);
        }
        if (message.type === 'queue/remove') {
          saveQueue(
            id,
            queue.filter((entry) => entry.key !== message.key),
          );
          return ok(undefined);
        }
        if (message.type === 'queue/toggle') {
          const queued = queue.some((entry) => entry.key === message.target.channelId);
          const next = queued
            ? queue.filter((entry) => entry.key !== message.target.channelId)
            : [...queue, { key: message.target.channelId, target: clone(message.target), settings: null, addedAt: now() }];
          saveQueue(id, next);
          return ok({ queued: !queued });
        }
        const incoming = clone(message.item);
        const exists = queue.some((entry) => entry.key === incoming.key);
        write('local', { [LOCAL.queue(id)]: exists ? queue.map((entry) => (entry.key === incoming.key ? incoming : entry)) : [...queue, incoming] });
        return ok(undefined);
      }
      case 'queue/removeMany': {
        const id = activeAccountId();
        if (id === null) return fail('no-account');
        if (!Array.isArray(message.keys) || message.keys.some((key) => typeof key !== 'string')) return fail('invalid');
        const drop = new Set(message.keys);
        const queue = queueOf(id);
        const next = queue.filter((entry) => !drop.has(entry.key));
        saveQueue(id, next);
        return ok({ removed: queue.length - next.length });
      }
      case 'queue/setGroupSettings': {
        // docs/PLAN.md §7.2a: a server / category ⚙ saves the settings of the group, clears the own settings of the channels
        // below it (and, for a server, the settings of its categories) and reports how many it cleared; null takes the group's
        // own settings away and leaves everything below alone. A group without a queued channel is refused ("empty").
        const id = activeAccountId();
        if (id === null) return fail('no-account');
        const { kind, guildId, groupId } = message;
        if ((kind !== 'guild' && kind !== 'category') || typeof guildId !== 'string' || guildId === '' || typeof groupId !== 'string' || groupId === '') return fail('invalid');
        if (message.settings !== null && !isRecord(message.settings)) return fail('invalid');
        const queue = queueOf(id);
        const groups = groupsOf(id);
        const below = queue.filter((entry) => entry.target.guildId === guildId && belongsToGroup(entry, kind, groupId, groups));
        if (below.length === 0) return fail('empty');
        const groupSettings = { ...groupSettingsOf(id) };
        if (message.settings === null) {
          delete groupSettings[groupId];
          write('local', { [LOCAL.groupSettings(id)]: pruneGroupSettings(groupSettings, queue, groups) });
          return ok({ cleared: 0 });
        }
        const { itemKeys, categoryIds } = groupOverrides(kind, groupId, queue, groups, groupSettings);
        const cleared = new Set(itemKeys);
        for (const categoryId of categoryIds) delete groupSettings[categoryId];
        groupSettings[groupId] = normalizeExportSettings(message.settings);
        write('local', {
          [LOCAL.queue(id)]: queue.map((entry) => (cleared.has(entry.key) ? { ...entry, settings: null } : entry)),
          [LOCAL.groupSettings(id)]: pruneGroupSettings(groupSettings, queue, groups),
        });
        return ok({ cleared: itemKeys.length + categoryIds.length });
      }
      case 'queue/addCategory':
      case 'queue/addGuild':
        return ok({ added: 0, skipped: 0, removed: 0 });
      case 'queue/groupInfo':
        return ok(undefined);
      case 'job/start': {
        const refused = guardJob();
        if (refused !== null) return refused;
        const id = activeAccountId();
        if (id === null) return fail('no-account');
        const queue = queueOf(id);
        const items = message.keys === 'all' ? queue : queue.filter((entry) => message.keys.includes(entry.key));
        return items.length === 0 ? fail('empty') : beginJob(items, id);
      }
      case 'job/cancel': {
        const state = job();
        if (!isActive(state)) return ok(undefined);
        const id = state.accountId;
        const queue = queueOf(id);
        const cancelledKeys = new Set<string>();
        for (const row of state.items) {
          if (row.status === 'running' || row.status === 'waiting' || row.status === 'paused') {
            row.status = 'cancelled';
            row.error = { kind: 'cancelled', message: '' };
            cancelledKeys.add(row.key);
          }
        }
        state.state = 'cancelled';
        state.finishedAt = now();
        write('session', { [SESSION.job]: state });
        write('local', {
          [LOCAL.queue(id)]: queue.map((entry) => (cancelledKeys.has(entry.key) ? { ...entry, lastResult: { status: 'cancelled', message: '', at: now() } } : entry)),
        });
        return ok(undefined);
      }
      case 'history/rerun': {
        const refused = guardJob();
        if (refused !== null) return refused;
        const id = activeAccountId();
        const entry = id === null ? undefined : historyOf(id).find((candidate) => candidate.id === message.id);
        if (id === null || entry === undefined) return fail('invalid');
        return beginJob([{ key: entry.target.channelId, target: entry.target, settings: entry.settings, addedAt: now() }], id);
      }
      case 'history/clear': {
        const id = activeAccountId();
        if (id !== null) write('local', { [LOCAL.history(id)]: [] });
        return ok(undefined);
      }
      case 'downloads/show':
        return ok(undefined);
      case 'discord/open': {
        discordTabs = Math.max(1, discordTabs);
        if (options.autoRun === true && account() === null && openTimer === null) {
          // Opening Discord gets the account known a moment later, like the real background worker would.
          openTimer = setTimeout(() => {
            openTimer = null;
            const known = lastAccount();
            if (known !== null) write('session', { [SESSION.account]: known });
          }, 1500);
        }
        return ok(undefined);
      }
      case 'inject/health':
        health = { ...message.health };
        return ok(undefined);
    }
  };

  // --- the platform ------------------------------------------------------------------------------------------------

  const platform: MockPlatform = {
    kind: 'mock',
    sent,
    async getStorage(area, keys) {
      assertReadableKeys(area, keys);
      const result: Record<string, unknown> = {};
      for (const key of keys) if (stores[area].has(key)) result[key] = clone(stores[area].get(key));
      return result;
    },
    async setStorage(area, items) {
      assertWritableKeys(area, items);
      write(area, items);
    },
    onStorageChanged(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async sendMessage<M extends ToBackground>(message: M): Promise<BgResponse<BgDataOf<M>>> {
      sent.push(clone(message));
      await Promise.resolve();
      return handle(message) as BgResponse<BgDataOf<M>>;
    },
    async getShortcuts() {
      return shortcuts.map((shortcut) => ({ ...shortcut }));
    },
    async openShortcutSettings() {
      // Nothing to open in a normal tab: the call is only recorded by tests that spy on it.
    },
    getUiLanguage: () => options.uiLanguage ?? 'ko',
    read: (area, key) => clone(stores[area].get(key)),
    write,
    setDiscordTabs(count) {
      discordTabs = count;
    },
    setHealth(next) {
      health = next === null ? null : { ...next };
    },
    setShortcuts(next) {
      shortcuts = next.map((shortcut) => ({ ...shortcut }));
    },
    failNext(type, error, message) {
      failures.set(type, message === undefined ? { error } : { error, message });
    },
    load(scenario) {
      fill(buildScenario(scenario, now()));
      jobItems.clear();
      if (scenario === 'running') seedRunningJob();
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      if (openTimer !== null) clearTimeout(openTimer);
      timer = null;
      openTimer = null;
      listeners.clear();
    },
  };

  const scenario = options.scenario ?? 'idle';
  fill(buildScenario(scenario, now()), true);
  if (scenario === 'running') seedRunningJob();
  return platform;
}
