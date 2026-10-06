/**
 * What the content script knows about the extension's state, read from `chrome.storage.local` (never from the session
 * storage, which a content script cannot read): the two settings it reacts to, the last confirmed account, that account's
 * queue (as a set of keys), that account's group lists (which channels a category / server has, for the check marks of the
 * category and server buttons) and the learned class names. The background worker is the only writer of all of it except
 * `classCache`; the page updates the queue optimistically after a click and `storage.onChanged` confirms it.
 */
import { DEFAULT_APP_SETTINGS } from '@/shared/defaults';
import { LOCAL } from '@/shared/storageKeys';
import { TIMING } from './config';
import { sameClassCache, sanitizeClassCache, type ClassCacheData } from './inject/classCache';
import { readLocal } from './platform';

export interface ContentSettings {
  showButtons: boolean;
  language: 'auto' | 'ko' | 'en';
}

export type StoreEvent = 'settings' | 'queue' | 'groups' | 'account' | 'classCache';

/** A group button's check state as the worker's answer gave it, and the timer that ends it (an idle page must not keep it). */
interface GroupOverride {
  checked: boolean;
  until: number;
  timer: ReturnType<typeof setTimeout>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The settings value -> what we use; a missing or malformed value gives the defaults of docs/PLAN.md §5.4. */
export function parseSettings(value: unknown): ContentSettings {
  const o = isRecord(value) ? value : {};
  const d = DEFAULT_APP_SETTINGS;
  return {
    showButtons: typeof o.showButtons === 'boolean' ? o.showButtons : d.showButtons,
    language: o.language === 'ko' || o.language === 'en' || o.language === 'auto' ? o.language : d.language,
  };
}

/** `LOCAL.lastAccount` -> the account id, or null. */
export function parseAccountId(value: unknown): string | null {
  return isRecord(value) && typeof value.id === 'string' && value.id !== '' ? value.id : null;
}

/** `LOCAL.queue(accountId)` -> the set of queued keys. */
export function parseQueue(value: unknown): Set<string> {
  const keys = new Set<string>();
  if (!Array.isArray(value)) return keys;
  for (const item of value) {
    if (isRecord(item) && typeof item.key === 'string' && item.key !== '') keys.add(item.key);
  }
  return keys;
}

/**
 * `LOCAL.groups(accountId)` (`Record<groupId, GroupInfo>`) -> the channel ids of each group. A group whose list is malformed (not
 * an array, or an entry that is no id) is left out altogether: "every channel is queued" must never be decided from half a list.
 */
export function parseGroups(value: unknown): ReadonlyMap<string, readonly string[]> {
  const groups = new Map<string, readonly string[]>();
  if (!isRecord(value) || Array.isArray(value)) return groups;
  for (const [groupId, info] of Object.entries(value)) {
    if (groupId === '' || !isRecord(info) || !Array.isArray(info.channelIds)) continue;
    const ids = info.channelIds;
    if (ids.every((id): id is string => typeof id === 'string' && id !== '')) groups.set(groupId, ids as string[]);
  }
  return groups;
}

const sameSettings = (a: ContentSettings, b: ContentSettings): boolean =>
  a.showButtons === b.showButtons && a.language === b.language;

type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;

export class ContentStore {
  settings: ContentSettings = parseSettings(undefined);
  accountId: string | null = null;
  classCache: ClassCacheData = {};
  private queued: ReadonlySet<string> = new Set();
  private groups: ReadonlyMap<string, readonly string[]> = new Map();
  /**
   * The check state a category / server button got from the worker's ANSWER, until the storage says the same (or this takes too
   * long): the answer comes before the storage events, and the icon should not wait for them. Each one has a timer: when it runs
   * out, the answer is dropped and a 'groups' event makes the buttons read the storage again, even on a page where nothing else
   * happens.
   */
  private readonly overrides = new Map<string, GroupOverride>();
  private readonly listeners = new Set<(event: StoreEvent) => void>();
  private disposed = false;
  /** While the first read is in flight, change events are held back and replayed after it (the newest word must win). */
  private loading = false;
  private held: [StorageChanges, string][] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  on(listener: (event: StoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isQueued(key: string): boolean {
    return this.queued.has(key);
  }

  queuedCount(): number {
    return this.queued.size;
  }

  /** From storage alone: the group exists, has at least one channel, and every one of them is queued. */
  private groupCheckedInStorage(groupId: string): boolean {
    const channelIds = this.groups.get(groupId);
    return channelIds !== undefined && channelIds.length > 0 && channelIds.every((id) => this.queued.has(id));
  }

  /** Is every channel of the category (or server) `groupId` in the download list? (the check mark of its button) */
  isGroupChecked(groupId: string): boolean {
    const stored = this.groupCheckedInStorage(groupId);
    const override = this.overrides.get(groupId);
    if (!override) return stored;
    if (stored === override.checked || this.now() >= override.until) {
      this.dropOverride(groupId); // the storage caught up (or never will: it is the truth)
      return stored;
    }
    return override.checked;
  }

  /** The storage changed: an answer that the storage now agrees with is not needed any more (a later change must show). */
  private settleOverrides(): void {
    for (const [groupId, override] of Array.from(this.overrides)) {
      if (this.groupCheckedInStorage(groupId) === override.checked) this.dropOverride(groupId);
    }
  }

  private dropOverride(groupId: string): void {
    const override = this.overrides.get(groupId);
    if (!override) return;
    clearTimeout(override.timer);
    this.overrides.delete(groupId);
  }

  private clearOverrides(): void {
    for (const override of this.overrides.values()) clearTimeout(override.timer);
    this.overrides.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.clearOverrides();
    this.listeners.clear();
  }

  private emit(event: StoreEvent): void {
    if (this.disposed) return;
    for (const listener of Array.from(this.listeners)) listener(event);
  }

  /** Initial read (settings, last account, class cache, then that account's queue and groups). Never throws. */
  async load(): Promise<void> {
    this.loading = true;
    try {
      const base = await readLocal([LOCAL.settings, LOCAL.lastAccount, LOCAL.classCache]);
      if (this.disposed) return;
      this.settings = parseSettings(base[LOCAL.settings]);
      this.accountId = parseAccountId(base[LOCAL.lastAccount]);
      this.classCache = sanitizeClassCache(base[LOCAL.classCache]);
      await this.loadAccountData();
    } finally {
      this.loading = false;
    }
    const held = this.held;
    this.held = [];
    for (const [changes, area] of held) this.applyChanges(changes, area);
  }

  private async loadAccountData(): Promise<void> {
    const accountId = this.accountId;
    if (!accountId) {
      this.queued = new Set();
      this.groups = new Map();
      return;
    }
    const stored = await readLocal([LOCAL.queue(accountId), LOCAL.groups(accountId)]);
    if (this.disposed || accountId !== this.accountId) return; // the account changed while reading
    this.queued = parseQueue(stored[LOCAL.queue(accountId)]);
    this.groups = parseGroups(stored[LOCAL.groups(accountId)]);
    this.emit('queue');
  }

  /** `chrome.storage.onChanged` (only the `local` area matters). */
  applyChanges(changes: StorageChanges, area: string): void {
    if (area !== 'local' || this.disposed) return;
    if (this.loading) {
      this.held.push([changes, area]);
      return;
    }

    const settings = changes[LOCAL.settings];
    if (settings) {
      const next = parseSettings(settings.newValue);
      if (!sameSettings(next, this.settings)) {
        this.settings = next;
        this.emit('settings');
      }
    }

    const account = changes[LOCAL.lastAccount];
    if (account) {
      const id = parseAccountId(account.newValue);
      if (id !== this.accountId) {
        this.accountId = id;
        this.queued = new Set(); // nothing is queued, and no group is known, for an account we have not read yet
        this.groups = new Map();
        this.clearOverrides();
        this.emit('account');
        this.emit('queue');
        void this.loadAccountData();
      }
    }

    if (this.accountId) {
      const queue = changes[LOCAL.queue(this.accountId)];
      if (queue) {
        this.queued = parseQueue(queue.newValue);
        this.settleOverrides();
        this.emit('queue');
      }
      const groups = changes[LOCAL.groups(this.accountId)];
      if (groups) {
        this.groups = parseGroups(groups.newValue);
        this.settleOverrides();
        this.emit('groups');
      }
    }

    const cache = changes[LOCAL.classCache];
    if (cache) {
      const next = sanitizeClassCache(cache.newValue);
      if (!sameClassCache(next, this.classCache)) {
        this.classCache = next;
        this.emit('classCache');
      }
    }
  }

  /** The answer of `queue/toggle`, applied before the storage event arrives so the icon changes at once. */
  setQueued(key: string, queued: boolean): void {
    if (this.queued.has(key) === queued) return;
    const next = new Set(this.queued);
    if (queued) next.add(key);
    else next.delete(key);
    this.queued = next;
    this.emit('queue');
  }

  /**
   * The answer of `queue/addCategory` / `queue/addGuild` (everything was added: checked; everything was removed: unchecked),
   * applied before the storage events arrive. It gives way as soon as the storage says the same, or after a few seconds: then a
   * 'groups' event tells the buttons to read the storage (the truth) again, without waiting for anything else to happen.
   */
  setGroupChecked(groupId: string, checked: boolean): void {
    if (this.disposed) return;
    this.dropOverride(groupId);
    const override: GroupOverride = {
      checked,
      until: this.now() + TIMING.groupOverrideMs,
      timer: setTimeout(() => {
        if (this.overrides.get(groupId) !== override) return; // replaced or settled in the meantime
        this.overrides.delete(groupId);
        this.emit('groups');
      }, TIMING.groupOverrideMs),
    };
    this.overrides.set(groupId, override);
    this.emit('groups');
  }
}
