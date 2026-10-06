import type { BgResponse, ToBackground } from '@/shared';
import { assertReadableKeys, assertWritableKeys, readableChanges } from './guard';
import { asBgResponse } from './normalize';
import type { BgDataOf, Platform, ShortcutInfo, StorageArea, StorageChanges, StorageListener } from './types';

/** The chrome://extensions page where the user assigns the extension's keyboard shortcuts. */
export const SHORTCUTS_URL = 'chrome://extensions/shortcuts';

/** True inside a real extension page (a normal tab, a dev server or a test has no `chrome.runtime.id`). */
export function hasExtensionRuntime(): boolean {
  try {
    return typeof chrome !== 'undefined' && typeof chrome.runtime?.id === 'string' && chrome.runtime.id !== '' && chrome.storage !== undefined;
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'Message could not be delivered';
}

/** The real extension: `chrome` is read lazily on every call, so the object can be created before the page is fully set up. */
export class ChromePlatform implements Platform {
  readonly kind = 'chrome' as const;

  async getStorage(area: StorageArea, keys: readonly string[]): Promise<Record<string, unknown>> {
    assertReadableKeys(area, keys);
    if (keys.length === 0) return {};
    const storage = chrome.storage[area];
    if (storage === undefined) return {};
    return (await storage.get([...keys])) as Record<string, unknown>;
  }

  async setStorage(area: StorageArea, items: Readonly<Record<string, unknown>>): Promise<void> {
    assertWritableKeys(area, items);
    if (Object.keys(items).length === 0) return;
    await chrome.storage[area]?.set({ ...items });
  }

  onStorageChanged(listener: StorageListener): () => void {
    const wrapped = (changes: StorageChanges, areaName: string): void => {
      if (areaName !== 'local' && areaName !== 'session') return;
      const allowed = readableChanges(areaName, changes);
      if (Object.keys(allowed).length > 0) listener(areaName, allowed);
    };
    chrome.storage.onChanged.addListener(wrapped);
    return () => chrome.storage.onChanged.removeListener(wrapped);
  }

  async sendMessage<M extends ToBackground>(message: M): Promise<BgResponse<BgDataOf<M>>> {
    try {
      return asBgResponse<BgDataOf<M>>(await chrome.runtime.sendMessage(message));
    } catch (error) {
      return { ok: false, error: 'unknown', message: describeError(error) };
    }
  }

  async getShortcuts(): Promise<ShortcutInfo[]> {
    try {
      const commands = await chrome.commands.getAll();
      return commands.flatMap((command) =>
        typeof command.name === 'string'
          ? [{ name: command.name, description: command.description ?? '', shortcut: command.shortcut ?? '' }]
          : [],
      );
    } catch {
      return [];
    }
  }

  async openShortcutSettings(): Promise<void> {
    await chrome.tabs.create({ url: SHORTCUTS_URL });
  }

  getUiLanguage(): string {
    try {
      return chrome.i18n.getUILanguage();
    } catch {
      return '';
    }
  }
}
