import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  DEFAULT_APP_SETTINGS,
  LOCAL,
  SESSION,
  categoryIdOf,
  type AccountInfo,
  type AppSettings,
  type BgError,
  type BgResponse,
  type ExportSettings,
  type GroupMap,
  type GroupSettingsMap,
  type HistoryEntry,
  type InjectHealth,
  type JobState,
  type QueueItem,
  type ThemeTokens,
} from '@/shared';
import {
  latestHealth,
  normalizeAccount,
  normalizeExpanded,
  normalizeGroupSettings,
  normalizeGroups,
  normalizeHistory,
  normalizeJob,
  normalizeQueue,
  normalizeSettings,
  normalizeStatus,
  normalizeTheme,
} from '@/ui/platform/normalize';
import type { Platform, StorageArea, StorageChanges } from '@/ui/platform/types';
import { assessDownloadRisk, type DownloadRisk } from './downloadRisk';

/** An error to show inline: the answer of the background worker, or a failure to reach it at all. */
export interface Notice {
  code: BgError | 'connection';
  /** The background worker's own wording, when it sent one. */
  message?: string;
  /** Changes with every notice, so an identical one is announced again. */
  seq: number;
}

/** The safety question that is open: which start it belongs to (where it is drawn) and what is waiting for the answer. */
export interface RiskPrompt {
  /** Where the question is shown (`RiskConfirm`'s `anchor`: the footer, a group line or a chat row). */
  anchor: string;
  /** What [계속 받기] starts: the keys the original start action sent. */
  keys: string[] | 'all';
  risk: DownloadRisk;
  /** The list, the group settings and the common settings as they were when the question opened: when they change, the question closes. */
  fingerprint: string;
}

export interface PopupState {
  /** The first read of settings, account and job finished (nothing is shown before: no flash of the consent screen). */
  loaded: boolean;
  /** The list of the account has been read. */
  queueLoaded: boolean;
  /** `status/get` has answered at least once (the "no Discord tab" banner needs it). */
  statusLoaded: boolean;
  /** The last `status/get` could not be delivered. */
  connectionLost: boolean;

  settings: AppSettings;
  theme: ThemeTokens | null;
  /** The account behind the current login (null = not known yet). */
  account: AccountInfo | null;
  lastAccount: AccountInfo | null;
  discordTabs: number;
  health: InjectHealth | null;
  job: JobState | null;
  queue: QueueItem[];
  /** `LOCAL.groups`: names, icons, sidebar order and the viewable channels of the servers and categories (the queue tree). */
  groups: GroupMap;
  /** `LOCAL.groupSettings`: the settings of servers and categories. */
  groupSettings: GroupSettingsMap;
  /** `LOCAL.uiExpanded`: the ids of the tree groups that are open. */
  expanded: string[];
  history: HistoryEntry[];

  notice: Notice | null;
  /** [취소] was pressed and the job has not stopped yet. */
  cancelling: boolean;
  /** The job that ended while the popup was open (a one-time summary); null once dismissed or when a new job starts. */
  justFinished: JobState | null;
  /** The safety question before a big download; only one is open at a time. It closes when the list changes or a job starts. */
  riskPrompt: RiskPrompt | null;
}

export interface PopupActions {
  /** Reads the storage, follows its changes and polls `status/get`. Returns the function that stops all of it. */
  start: () => () => void;
  refreshStatus: () => Promise<void>;
  dismissNotice: () => void;
  dismissFinished: () => void;

  /** Optimistic by default: the settings change on screen at once and are rolled back from storage if the background refuses. */
  patchSettings: (patch: Partial<AppSettings>, options?: { optimistic?: boolean }) => Promise<boolean>;
  startJob: (keys: string[] | 'all') => Promise<boolean>;
  /**
   * The start buttons: starts `keys` at once when that is an ordinary download, otherwise opens the safety question at `anchor`
   * (`assessDownloadRisk`) and starts nothing. Resolves to whether a job was started.
   */
  requestStart: (keys: string[] | 'all', anchor: string) => Promise<boolean>;
  /** [계속 받기]: closes the safety question and starts what it was opened for. */
  confirmRisk: () => Promise<boolean>;
  /** [취소], Esc: closes the safety question, nothing starts. */
  dismissRisk: () => void;
  cancelJob: () => Promise<boolean>;
  saveItem: (item: QueueItem) => Promise<boolean>;
  removeItem: (key: string) => Promise<boolean>;
  /** A server / category ✕: takes these chats out of the list (`queue/removeMany`). */
  removeMany: (keys: string[]) => Promise<boolean>;
  /** A server / category ⚙: saves the settings of the group, or `null` to take the group's own settings away (`queue/setGroupSettings`). */
  saveGroupSettings: (kind: 'guild' | 'category', guildId: string, groupId: string, settings: ExportSettings | null) => Promise<boolean>;
  /** Opens or closes a group of the tree; the choice is kept in `LOCAL.uiExpanded`. */
  toggleGroup: (id: string) => void;
  clearQueue: () => Promise<boolean>;
  rerunHistory: (id: string) => Promise<boolean>;
  clearHistory: () => Promise<boolean>;
  showDownload: (downloadId: number | null) => Promise<boolean>;
  openDiscord: () => Promise<boolean>;
}

export type PopupStore = StoreApi<PopupState & PopupActions>;

export interface PopupStoreOptions {
  /** How often `status/get` is repeated while the popup is open (docs/PLAN.md §7.2: 2 s). */
  pollMs?: number;
}

export const POLL_MS = 2000;

export const isJobActive = (job: JobState | null): job is JobState => job !== null && (job.state === 'running' || job.state === 'paused');

/** The account whose list and history are shown: the live one, else the last one that was known. */
export function activeAccountOf(state: Pick<PopupState, 'account' | 'lastAccount'>): AccountInfo | null {
  return state.account ?? state.lastAccount;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Everything `assessDownloadRisk` reads, boiled down to a short string (a 32-bit FNV-1a hash of its JSON, so the open question does
 * not hold a copy of the whole list): the safety question is only valid for the list it was asked about.
 */
function riskFingerprint(state: Pick<PopupState, 'queue' | 'groups' | 'groupSettings' | 'settings'>): string {
  const text = JSON.stringify([state.queue, state.groups, state.groupSettings, state.settings.common]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

export function createPopupStore(platform: Platform, options: PopupStoreOptions = {}): PopupStore {
  const pollMs = options.pollMs ?? POLL_MS;
  let noticeSeq = 0;
  let pendingSettingsWrites = 0;
  let pendingExpandedWrites = 0;
  let statusInFlight = false;
  // A second click on a start button while the first request is still on its way must not become a refused "busy" request.
  let startInFlight = false;

  /** `platform.sendMessage` never rejects by contract; this makes sure a platform that does anyway cannot cause an unhandled rejection. */
  const deliver: Platform['sendMessage'] = async (message) => {
    try {
      return await platform.sendMessage(message);
    } catch (error) {
      return { ok: false, error: 'unknown', ...(error instanceof Error && error.message !== '' ? { message: error.message } : {}) };
    }
  };

  const store = createStore<PopupState & PopupActions>()((set, get) => {
    const noticeOf = (response: Extract<BgResponse<unknown>, { ok: false }>): Notice => ({
      code: response.error,
      ...(response.message === undefined ? {} : { message: response.message }),
      seq: ++noticeSeq,
    });

    /** The job changed: remember a job that ended while the popup was open, and stop "cancelling" once it is over. */
    const jobPatch = (next: JobState | null): Partial<PopupState> => {
      const previous = get().job;
      const patch: Partial<PopupState> = { job: next };
      if (isJobActive(previous) && next !== null && next.jobId === previous.jobId && !isJobActive(next)) patch.justFinished = next;
      if (isJobActive(next)) {
        patch.justFinished = null;
        patch.riskPrompt = null; // a download is running: there is nothing left to ask about
      }
      if (!isJobActive(next)) patch.cancelling = false;
      return patch;
    };

    const readAccountData = async (): Promise<void> => {
      const account = activeAccountOf(get());
      if (account === null) {
        set({ queue: [], groups: {}, groupSettings: {}, history: [], queueLoaded: true });
        return;
      }
      try {
        const stored = await platform.getStorage('local', [
          LOCAL.queue(account.id),
          LOCAL.history(account.id),
          LOCAL.groups(account.id),
          LOCAL.groupSettings(account.id),
        ]);
        if (activeAccountOf(get())?.id !== account.id) return; // the account changed meanwhile: the newer read wins
        set({
          queue: normalizeQueue(stored[LOCAL.queue(account.id)]),
          groups: normalizeGroups(stored[LOCAL.groups(account.id)]),
          groupSettings: normalizeGroupSettings(stored[LOCAL.groupSettings(account.id)]),
          history: normalizeHistory(stored[LOCAL.history(account.id)]),
          queueLoaded: true,
        });
      } catch {
        set({ queueLoaded: true });
      }
    };

    const readSettings = async (): Promise<void> => {
      try {
        const stored = await platform.getStorage('local', [LOCAL.settings]);
        if (pendingSettingsWrites === 0) set({ settings: normalizeSettings(stored[LOCAL.settings]) });
      } catch {
        // keep what is shown
      }
    };

    const readSession = async (keys: readonly string[]): Promise<Record<string, unknown>> => {
      try {
        return await platform.getStorage('session', keys);
      } catch {
        return {}; // no storage.session (or it refused): everything that lives there comes from status/get instead
      }
    };

    const readAll = async (): Promise<void> => {
      let local: Record<string, unknown> = {};
      try {
        local = await platform.getStorage('local', [LOCAL.settings, LOCAL.theme, LOCAL.lastAccount, LOCAL.uiExpanded]);
      } catch {
        // defaults below
      }
      const session = await readSession([SESSION.account, SESSION.job, SESSION.injectHealth]);
      set({
        settings: normalizeSettings(local[LOCAL.settings]),
        theme: normalizeTheme(local[LOCAL.theme]),
        lastAccount: normalizeAccount(local[LOCAL.lastAccount]),
        ...(pendingExpandedWrites === 0 ? { expanded: normalizeExpanded(local[LOCAL.uiExpanded]) } : {}),
        account: normalizeAccount(session[SESSION.account]),
        health: latestHealth(session[SESSION.injectHealth]),
        ...jobPatch(normalizeJob(session[SESSION.job])),
        loaded: true,
      });
      await readAccountData();
    };

    const onChanged = (area: StorageArea, changes: StorageChanges): void => {
      const patch: Partial<PopupState> = {};
      const before = activeAccountOf(get())?.id ?? null;
      let nextAccount = get().account;
      let nextLast = get().lastAccount;

      if (area === 'local') {
        if (LOCAL.settings in changes && pendingSettingsWrites === 0) patch.settings = normalizeSettings(changes[LOCAL.settings]?.newValue);
        if (LOCAL.theme in changes) patch.theme = normalizeTheme(changes[LOCAL.theme]?.newValue);
        if (LOCAL.uiExpanded in changes && pendingExpandedWrites === 0) patch.expanded = normalizeExpanded(changes[LOCAL.uiExpanded]?.newValue);
        if (LOCAL.lastAccount in changes) {
          nextLast = normalizeAccount(changes[LOCAL.lastAccount]?.newValue);
          patch.lastAccount = nextLast;
        }
      } else {
        if (SESSION.account in changes) {
          nextAccount = normalizeAccount(changes[SESSION.account]?.newValue);
          patch.account = nextAccount;
        }
        if (SESSION.job in changes) Object.assign(patch, jobPatch(normalizeJob(changes[SESSION.job]?.newValue)));
        if (SESSION.injectHealth in changes) patch.health = latestHealth(changes[SESSION.injectHealth]?.newValue);
      }

      const after = (nextAccount ?? nextLast)?.id ?? null;
      if (area === 'local' && after !== null && after === before) {
        if (LOCAL.queue(after) in changes) patch.queue = normalizeQueue(changes[LOCAL.queue(after)]?.newValue);
        if (LOCAL.groups(after) in changes) patch.groups = normalizeGroups(changes[LOCAL.groups(after)]?.newValue);
        if (LOCAL.groupSettings(after) in changes) patch.groupSettings = normalizeGroupSettings(changes[LOCAL.groupSettings(after)]?.newValue);
        if (LOCAL.history(after) in changes) patch.history = normalizeHistory(changes[LOCAL.history(after)]?.newValue);
      }
      if (Object.keys(patch).length > 0) set(patch);
      if (after !== before) void readAccountData();
    };

    /** Sends a message; a refusal becomes the inline notice. */
    const send = async (message: Parameters<Platform['sendMessage']>[0]): Promise<BgResponse<unknown>> => {
      set({ notice: null });
      const response = await deliver(message);
      if (!response.ok) set({ notice: noticeOf(response) });
      return response;
    };

    return {
      loaded: false,
      queueLoaded: false,
      statusLoaded: false,
      connectionLost: false,
      settings: cloneJson(DEFAULT_APP_SETTINGS),
      theme: null,
      account: null,
      lastAccount: null,
      discordTabs: 0,
      health: null,
      job: null,
      queue: [],
      groups: {},
      groupSettings: {},
      expanded: [],
      history: [],
      notice: null,
      cancelling: false,
      justFinished: null,
      riskPrompt: null,

      start() {
        let stopped = false;
        const unsubscribe = platform.onStorageChanged(onChanged);
        void readAll().then(() => {
          if (!stopped) void get().refreshStatus();
        });
        const timer = setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void get().refreshStatus();
        }, pollMs);
        return () => {
          stopped = true;
          unsubscribe();
          clearInterval(timer);
        };
      },

      async refreshStatus() {
        if (statusInFlight) return;
        statusInFlight = true;
        try {
          const response = await deliver({ to: 'bg', type: 'status/get' });
          const snapshot = response.ok ? normalizeStatus(response.data) : null;
          if (snapshot === null) {
            set({ connectionLost: true });
            return;
          }
          const before = activeAccountOf(get())?.id ?? null;
          set({
            account: snapshot.account,
            lastAccount: snapshot.lastAccount ?? get().lastAccount,
            discordTabs: snapshot.discordTabs,
            health: snapshot.health,
            ...jobPatch(snapshot.job),
            statusLoaded: true,
            connectionLost: false,
          });
          if ((activeAccountOf(get())?.id ?? null) !== before) await readAccountData();
        } finally {
          statusInFlight = false;
        }
      },

      dismissNotice: () => set({ notice: null }),
      dismissFinished: () => set({ justFinished: null }),

      async patchSettings(patch, patchOptions = {}) {
        const optimistic = patchOptions.optimistic ?? true;
        const copy = cloneJson(patch);
        set({ notice: null });
        if (optimistic) set({ settings: { ...get().settings, ...copy } });
        pendingSettingsWrites++;
        const response = await deliver({ to: 'bg', type: 'settings/patch', patch: copy });
        pendingSettingsWrites--;
        if (!response.ok) {
          set({ notice: noticeOf(response) });
          await readSettings();
          return false;
        }
        if (!optimistic) set({ settings: { ...get().settings, ...copy } });
        await readSettings();
        return true;
      },

      async startJob(keys) {
        if (startInFlight) return false;
        startInFlight = true;
        try {
          set({ justFinished: null });
          const response = await send({ to: 'bg', type: 'job/start', keys });
          if (response.ok) void get().refreshStatus();
          return response.ok;
        } finally {
          startInFlight = false;
        }
      },

      async requestStart(keys, anchor) {
        const state = get();
        const wanted = keys === 'all' ? state.queue : state.queue.filter((item) => keys.includes(item.key));
        const risk = assessDownloadRisk(wanted, state.settings.common, state.groupSettings, state.groups);
        if (!risk.risky) {
          set({ riskPrompt: null });
          return get().startJob(keys);
        }
        set({ notice: null, riskPrompt: { anchor, keys: keys === 'all' ? 'all' : [...keys], risk, fingerprint: riskFingerprint(state) } });
        return false;
      },

      async confirmRisk() {
        const prompt = get().riskPrompt;
        if (prompt === null) return false;
        set({ riskPrompt: null });
        return get().startJob(prompt.keys);
      },

      dismissRisk: () => {
        if (get().riskPrompt !== null) set({ riskPrompt: null });
      },

      async cancelJob() {
        set({ cancelling: true });
        const response = await send({ to: 'bg', type: 'job/cancel' });
        if (!response.ok) set({ cancelling: false });
        else void get().refreshStatus();
        return response.ok;
      },

      async saveItem(item) {
        const response = await send({ to: 'bg', type: 'queue/upsert', item: cloneJson(item) });
        if (response.ok) await readAccountData();
        return response.ok;
      },

      async removeItem(key) {
        const response = await send({ to: 'bg', type: 'queue/remove', key });
        if (response.ok) await readAccountData();
        return response.ok;
      },

      async removeMany(keys) {
        const response = await send({ to: 'bg', type: 'queue/removeMany', keys: [...keys] });
        if (response.ok) await readAccountData();
        return response.ok;
      },

      async saveGroupSettings(kind, guildId, groupId, settings) {
        const response = await send({ to: 'bg', type: 'queue/setGroupSettings', kind, guildId, groupId, settings: settings === null ? null : cloneJson(settings) });
        if (response.ok) await readAccountData();
        return response.ok;
      },

      toggleGroup(id) {
        const { expanded, queue, groups } = get();
        const open = !expanded.includes(id);
        // Open groups of servers and categories that have nothing in the list any more are not kept: they would only pile up.
        const known = new Set<string>([id]);
        for (const item of queue) {
          if (item.target.guildId) known.add(item.target.guildId);
          const category = categoryIdOf(item, groups);
          if (category !== null) known.add(category);
        }
        const next = (open ? [...expanded, id] : expanded.filter((entry) => entry !== id)).filter((entry) => known.has(entry));
        set({ expanded: next });
        pendingExpandedWrites++;
        // The open groups are a preference of the popup itself: the one thing it writes to storage on its own (no message, no notice).
        void Promise.resolve()
          .then(() => platform.setStorage('local', { [LOCAL.uiExpanded]: next }))
          .catch(() => undefined)
          .finally(() => {
            pendingExpandedWrites--;
          });
      },

      async clearQueue() {
        const response = await send({ to: 'bg', type: 'queue/clear' });
        if (response.ok) await readAccountData();
        return response.ok;
      },

      async rerunHistory(id) {
        if (startInFlight) return false;
        startInFlight = true;
        try {
          set({ justFinished: null });
          const response = await send({ to: 'bg', type: 'history/rerun', id });
          if (response.ok) void get().refreshStatus();
          return response.ok;
        } finally {
          startInFlight = false;
        }
      },

      async clearHistory() {
        const response = await send({ to: 'bg', type: 'history/clear' });
        if (response.ok) await readAccountData();
        return response.ok;
      },

      async showDownload(downloadId) {
        return (await send({ to: 'bg', type: 'downloads/show', downloadId })).ok;
      },

      async openDiscord() {
        const response = await send({ to: 'bg', type: 'discord/open' });
        if (response.ok) void get().refreshStatus();
        return response.ok;
      },
    };
  });

  // The question belongs to the list it was asked about: when the list, the settings it runs with or the common settings change, it goes.
  store.subscribe((state, previous) => {
    const prompt = state.riskPrompt;
    if (prompt === null || previous.riskPrompt !== prompt) return;
    if (state.queue === previous.queue && state.groups === previous.groups && state.groupSettings === previous.groupSettings && state.settings === previous.settings) return;
    if (riskFingerprint(state) !== prompt.fingerprint) store.setState({ riskPrompt: null });
  });

  return store;
}
