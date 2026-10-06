import { hasExtensionRuntime } from './chrome';

export { ChromePlatform, SHORTCUTS_URL, hasExtensionRuntime } from './chrome';
export { assertReadableKeys, assertWritableKeys, isReadableKey, isWritableKey, readableChanges } from './guard';
export * from './normalize';
export type { BgDataOf, BgResponseData, Platform, ShortcutInfo, StorageArea, StorageChange, StorageChanges, StorageListener } from './types';

/** `?mock=1` in the page URL asks for the in-memory mock platform. */
export function isMockRequested(search: string = typeof location === 'undefined' ? '' : location.search): boolean {
  return new URLSearchParams(search).get('mock') === '1';
}

/**
 * Should the popup run against the in-memory mock (inspect it in a normal browser tab, `popup.html?mock=1`)? Yes when asked
 * to, and whenever there is no extension runtime to talk to.
 */
export function shouldUseMock(search?: string): boolean {
  return isMockRequested(search) || !hasExtensionRuntime();
}
