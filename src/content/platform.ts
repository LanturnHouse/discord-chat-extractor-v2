/**
 * The content script's only doorway to the `chrome.*` APIs. Every call is wrapped: once the extension is reloaded or
 * updated, the old content script keeps running in the page ("context invalidated") and every `chrome.*` call throws. That
 * must end quietly (docs/PLAN.md §3), so nothing here ever throws or rejects.
 *
 * The content script makes no API calls and never reads `chrome.storage.session`: it only reads `chrome.storage.local`,
 * writes the two keys it owns (theme, classCache) and sends five message types to the background worker.
 */
import type { BgResponse, ToBackground } from '@/shared/messages';

/** Is the extension context still valid? (`chrome.runtime.id` disappears when the extension is reloaded or removed.) */
export function runtimeAlive(): boolean {
  try {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

/** Reads keys of `chrome.storage.local`; an empty object when the read fails. */
export async function readLocal(keys: string[]): Promise<Record<string, unknown>> {
  try {
    const result: unknown = await chrome.storage.local.get(keys);
    return typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Writes keys of `chrome.storage.local`; false when it failed. */
export async function writeLocal(items: Record<string, unknown>): Promise<boolean> {
  try {
    await chrome.storage.local.set(items);
    return true;
  } catch {
    return false;
  }
}

function isBgResponse<T>(value: unknown): value is BgResponse<T> {
  return typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean';
}

/** Sends one message to the background worker; null when it could not be delivered or nothing sensible came back. */
export async function sendToBackground<T = undefined>(message: ToBackground): Promise<BgResponse<T> | null> {
  try {
    const response: unknown = await chrome.runtime.sendMessage(message);
    return isBgResponse<T>(response) ? response : null;
  } catch {
    return null;
  }
}

/** Fire and forget (health reports). */
export function postToBackground(message: ToBackground): void {
  try {
    void Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => undefined);
  } catch {
    // context invalidated: nothing to tell
  }
}

/** The browser UI language, or '' when unknown. */
export function browserUiLanguage(): string {
  try {
    return chrome.i18n?.getUILanguage?.() ?? '';
  } catch {
    return '';
  }
}
