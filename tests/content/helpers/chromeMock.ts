import { vi } from 'vitest';
import type { ToBackground } from '@/shared/messages';

type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type StorageListener = (changes: Changes, area: string) => void;
type MessageListener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => void;

export interface ChromeMock {
  /** Every message the content script sent to the background worker, in order. */
  readonly sent: ToBackground[];
  /** The contents of `chrome.storage.local`. */
  readonly storage: Map<string, unknown>;
  /** Writes to `chrome.storage.local` from "another context" and fires `onChanged` (async, like Chrome). */
  set(items: Record<string, unknown>): void;
  /** Fires `storage.onChanged` with explicit changes. */
  changed(changes: Changes, area?: string): void;
  /** What the background worker answers to a message (default: an unknown error). */
  respond(responder: (message: ToBackground) => unknown): void;
  /** Delivers a runtime message to the content script; the responses it gave synchronously are returned. */
  message(message: unknown): unknown[];
  /** The extension was reloaded: `chrome.runtime.id` is gone and every API call throws. */
  invalidate(): void;
  readonly storageListeners: number;
  readonly messageListeners: number;
  /** Every `storage.local.set` call the content script made (it may write only theme and classCache). */
  readonly writes: Record<string, unknown>[];
  /** The messages sent to the background worker of one type (e.g. `queue/toggle`). */
  sentOf<T extends ToBackground['type']>(type: T): Extract<ToBackground, { type: T }>[];
}

/** Installs a `chrome` global with just what the content script touches. Call `vi.unstubAllGlobals()` to remove it. */
export function installChrome(initial: Record<string, unknown> = {}): ChromeMock {
  const storage = new Map<string, unknown>(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
  const sent: ToBackground[] = [];
  const writes: Record<string, unknown>[] = [];
  const storageListeners = new Set<StorageListener>();
  const messageListeners = new Set<MessageListener>();
  let alive = true;
  let responder: (message: ToBackground) => unknown = () => ({ ok: false, error: 'unknown' });

  const guard = (): void => {
    if (!alive) throw new Error('Extension context invalidated.');
  };
  const emit = (changes: Changes, area = 'local'): void => {
    for (const listener of Array.from(storageListeners)) listener(changes, area);
  };

  const stub = {
    runtime: {
      get id(): string | undefined {
        return alive ? 'test-extension-id' : undefined;
      },
      sendMessage: (message: ToBackground): Promise<unknown> => {
        guard();
        sent.push(structuredClone(message));
        return Promise.resolve().then(() => responder(message));
      },
      onMessage: {
        addListener: (listener: MessageListener): void => {
          guard();
          messageListeners.add(listener);
        },
        removeListener: (listener: MessageListener): void => {
          messageListeners.delete(listener);
        },
      },
    },
    storage: {
      local: {
        get: async (keys: string[]): Promise<Record<string, unknown>> => {
          guard();
          const out: Record<string, unknown> = {};
          for (const key of keys) if (storage.has(key)) out[key] = structuredClone(storage.get(key));
          return out;
        },
        set: async (items: Record<string, unknown>): Promise<void> => {
          guard();
          writes.push(structuredClone(items));
          const changes: Changes = {};
          for (const [key, value] of Object.entries(items)) {
            changes[key] = { oldValue: storage.get(key), newValue: structuredClone(value) };
            storage.set(key, structuredClone(value));
          }
          queueMicrotask(() => emit(changes));
        },
      },
      onChanged: {
        addListener: (listener: StorageListener): void => {
          guard();
          storageListeners.add(listener);
        },
        removeListener: (listener: StorageListener): void => {
          storageListeners.delete(listener);
        },
      },
    },
    i18n: { getUILanguage: (): string => 'ko' },
  };
  vi.stubGlobal('chrome', stub);

  return {
    sent,
    storage,
    writes,
    sentOf<T extends ToBackground['type']>(type: T) {
      return sent.filter((message): message is Extract<ToBackground, { type: T }> => message.type === type);
    },
    set(items) {
      const changes: Changes = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: storage.get(key), newValue: structuredClone(value) };
        storage.set(key, structuredClone(value));
      }
      queueMicrotask(() => emit(changes));
    },
    changed: (changes, area) => emit(changes, area),
    respond(next) {
      responder = next;
    },
    message(message) {
      const responses: unknown[] = [];
      for (const listener of Array.from(messageListeners)) listener(message, {}, (response) => responses.push(response));
      return responses;
    },
    invalidate() {
      alive = false;
    },
    get storageListeners() {
      return storageListeners.size;
    },
    get messageListeners() {
      return messageListeners.size;
    },
  };
}
