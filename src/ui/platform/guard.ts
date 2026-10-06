import { LOCAL, SESSION } from '@/shared';
import type { StorageArea, StorageChanges } from './types';

/*
 * The popup is a trusted extension page and could read all of chrome.storage.session, but docs/PLAN.md §5.2 / §8 say it never
 * reads the Discord authentication value (SESSION.token) or its capture time (SESSION.tokenCapturedAt). Instead of trusting
 * every call site, the platform only accepts an allow-list of keys: whatever is not on it is refused before it is requested,
 * and removed from change notifications.
 */

const LOCAL_KEYS: ReadonlySet<string> = new Set([LOCAL.settings, LOCAL.lastAccount, LOCAL.theme, LOCAL.uiExpanded]);
const LOCAL_PREFIXES: readonly string[] = [LOCAL.queue(''), LOCAL.history(''), LOCAL.groups(''), LOCAL.groupSettings('')];
const SESSION_KEYS: ReadonlySet<string> = new Set([SESSION.account, SESSION.job, SESSION.injectHealth]);

/** May the popup read `key` from `area`? */
export function isReadableKey(area: StorageArea, key: string): boolean {
  if (area === 'session') return SESSION_KEYS.has(key);
  if (LOCAL_KEYS.has(key)) return true;
  return LOCAL_PREFIXES.some((prefix) => key.startsWith(prefix) && key.length > prefix.length);
}

/** Throws when any of `keys` is not a key the popup may read. The message names the key, never a stored value. */
export function assertReadableKeys(area: StorageArea, keys: readonly string[]): void {
  for (const key of keys) {
    if (typeof key !== 'string' || !isReadableKey(area, key)) {
      throw new Error(`The popup may not read storage.${area} key "${String(key)}"`);
    }
  }
}

/** `changes` without the keys the popup may not read. */
export function readableChanges(area: StorageArea, changes: StorageChanges): StorageChanges {
  const kept: Record<string, StorageChanges[string]> = {};
  for (const [key, change] of Object.entries(changes)) {
    if (isReadableKey(area, key)) kept[key] = change;
  }
  return kept;
}

/*
 * Writing: every storage write belongs to the background worker (docs/PLAN.md §5.2) and reaches it as a message. The single
 * exception is a UI-only preference of the popup itself - which groups of the download list tree are open - so the write
 * allow-list has exactly that one key, in storage.local. Nothing in storage.session is ever written.
 */
const WRITABLE_LOCAL_KEYS: ReadonlySet<string> = new Set([LOCAL.uiExpanded]);

/** May the popup write `key` to `area`? */
export function isWritableKey(area: StorageArea, key: string): boolean {
  return area === 'local' && WRITABLE_LOCAL_KEYS.has(key);
}

/** Throws when any key of `items` is not one the popup may write. The message names the key, never a value. */
export function assertWritableKeys(area: StorageArea, items: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(items)) {
    if (!isWritableKey(area, key)) throw new Error(`The popup may not write storage.${area} key "${key}"`);
  }
}
