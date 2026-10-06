import type { BgResponse, StatusSnapshot, ToBackground } from '@/shared';

/**
 * The two storage areas the popup reads (docs/PLAN.md §5.2). Every write is a message to the background; the one exception is
 * `setStorage` for a UI-only preference (see ./guard.ts).
 */
export type StorageArea = 'local' | 'session';

export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}
export type StorageChanges = Readonly<Record<string, StorageChange>>;
export type StorageListener = (area: StorageArea, changes: StorageChanges) => void;

/** One entry of `chrome.commands.getAll()`. `shortcut` is '' when the command has no key assigned. */
export interface ShortcutInfo {
  name: string;
  description: string;
  shortcut: string;
}

/** The `data` of every message that answers with something (docs/PLAN.md §5.3); every other message answers `undefined`. */
export interface BgResponseData {
  'queue/toggle': { queued: boolean };
  'queue/addCategory': { added: number; skipped: number; removed: number };
  'queue/addGuild': { added: number; skipped: number; removed: number };
  'queue/setGroupSettings': { cleared: number };
  'queue/removeMany': { removed: number };
  'job/start': { jobId: string };
  'history/rerun': { jobId: string };
  'status/get': StatusSnapshot;
}
export type BgDataOf<M extends ToBackground> = M['type'] extends keyof BgResponseData ? BgResponseData[M['type']] : undefined;

/**
 * Everything the popup needs from the browser, so the UI never touches `chrome.*` directly and can run against an in-memory
 * mock in a normal browser tab (`popup.html?mock=1`) and in tests.
 */
export interface Platform {
  readonly kind: 'chrome' | 'mock';

  /**
   * Reads keys from one storage area. Only the keys the popup is meant to read are accepted (see ./guard.ts): asking for the
   * Discord authentication value or its capture time throws before anything is requested.
   */
  getStorage(area: StorageArea, keys: readonly string[]): Promise<Record<string, unknown>>;
  /**
   * Writes UI-only preferences to storage.local - only the keys of the write allow-list (see ./guard.ts: the open groups of the
   * download list tree); any other key throws before anything is written. Everything else is a message to the background.
   */
  setStorage(area: StorageArea, items: Readonly<Record<string, unknown>>): Promise<void>;
  /** Subscribes to storage changes (the keys the popup may not read are removed from `changes`). Returns the unsubscribe function. */
  onStorageChanged(listener: StorageListener): () => void;

  /** Sends a message to the background worker. Never rejects: a transport failure is an `{ ok: false }` response. */
  sendMessage<M extends ToBackground>(message: M): Promise<BgResponse<BgDataOf<M>>>;

  /** `chrome.commands.getAll()` ([] when unavailable). */
  getShortcuts(): Promise<ShortcutInfo[]>;
  /** Opens chrome://extensions/shortcuts in a new tab. */
  openShortcutSettings(): Promise<void>;
  /** `chrome.i18n.getUILanguage()`, '' when unknown. */
  getUiLanguage(): string;
}
