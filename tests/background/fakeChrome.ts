/**
 * A reusable fake of the `chrome.*` APIs the background worker and the offscreen host use, for tests that run in node.
 *
 *  - `fake.chrome` is the SERVICE WORKER's `chrome` global: `vi.stubGlobal('chrome', fake.chrome)`, then import the code.
 *  - Storage (`local`, `session`) keeps JSON-like copies (structuredClone), fires `chrome.storage.onChanged` (asynchronously,
 *    like Chrome, and only for values that really changed) and is shared by every context.
 *  - Messaging follows Chrome's rules: `runtime.sendMessage` from one context reaches the `onMessage` listeners of every OTHER
 *    extension context (not content scripts); the first `sendResponse` wins; a listener must return true to answer later;
 *    with no listener anywhere the call rejects. Create other contexts with `fake.createPage(...)` (popup, offscreen document,
 *    content script of a tab, extension page in a tab): each has its own `runtime`, and the worker sees the right `sender`.
 *  - `offscreen.createDocument` / `closeDocument` / `runtime.getContexts` model the single offscreen document; hook
 *    `this.offscreen.onCreate` to boot an engine in it.
 *  - Downloads, notifications, the action badge, tabs and windows record what the code does to them; `complete()`, `interrupt()`,
 *    `click()` and friends fire the matching events.
 * Everything is plain data on `fake` so tests can assert on it and seed it.
 */
import { vi } from 'vitest';

export const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const EXTENSION_URL = `chrome-extension://${EXTENSION_ID}/`;

type AnyListener = (...args: any[]) => unknown;

export class FakeEvent<L extends AnyListener = AnyListener> {
  readonly listeners: L[] = [];
  /** The extra arguments of each `addListener` call (webRequest: filter, extraInfoSpec). */
  readonly extras: unknown[][] = [];

  addListener = (listener: L, ...extra: unknown[]): void => {
    this.listeners.push(listener);
    this.extras.push(extra);
  };

  removeListener = (listener: L): void => {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
      this.extras.splice(index, 1);
    }
  };

  hasListener = (listener: L): boolean => this.listeners.includes(listener);
  hasListeners = (): boolean => this.listeners.length > 0;

  /** Test helper: calls every listener, returns what they returned. */
  dispatch = (...args: Parameters<L>): unknown[] => [...this.listeners].map((listener) => listener(...args));
}

type Change = { oldValue?: unknown; newValue?: unknown };

export class FakeStorageArea {
  private readonly data = new Map<string, unknown>();

  constructor(
    private readonly area: 'local' | 'session',
    private readonly emit: (changes: Record<string, Change>, area: string) => void,
  ) {}

  readonly get = vi.fn(async (keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> => {
    const out: Record<string, unknown> = {};
    if (keys === undefined || keys === null) {
      for (const [key, value] of this.data) out[key] = structuredClone(value);
    } else if (typeof keys === 'string') {
      if (this.data.has(keys)) out[keys] = structuredClone(this.data.get(keys));
    } else if (Array.isArray(keys)) {
      for (const key of keys) if (this.data.has(key)) out[key] = structuredClone(this.data.get(key));
    } else {
      for (const [key, fallback] of Object.entries(keys)) out[key] = structuredClone(this.data.has(key) ? this.data.get(key) : fallback);
    }
    return out;
  });

  readonly set = vi.fn(async (items: Record<string, unknown>): Promise<void> => {
    const changes: Record<string, Change> = {};
    for (const [key, value] of Object.entries(items)) {
      const next = structuredClone(value);
      const had = this.data.has(key);
      const previous = this.data.get(key);
      if (had && JSON.stringify(previous) === JSON.stringify(next)) continue;
      this.data.set(key, next);
      changes[key] = had ? { oldValue: previous, newValue: structuredClone(next) } : { newValue: structuredClone(next) };
    }
    this.notify(changes);
  });

  readonly remove = vi.fn(async (keys: string | string[]): Promise<void> => {
    const changes: Record<string, Change> = {};
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (!this.data.has(key)) continue;
      changes[key] = { oldValue: this.data.get(key) };
      this.data.delete(key);
    }
    this.notify(changes);
  });

  readonly clear = vi.fn(async (): Promise<void> => {
    await this.remove([...this.data.keys()]);
  });

  private notify(changes: Record<string, Change>): void {
    if (Object.keys(changes).length > 0) queueMicrotask(() => this.emit(changes, this.area));
  }

  // ---- test helpers (no events, no call counting) ----
  /** Puts values in without firing `onChanged`. */
  seed(items: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(items)) this.data.set(key, structuredClone(value));
  }

  /** The stored value of `key` (a copy), `undefined` when absent. */
  peek<T = unknown>(key: string): T | undefined {
    return this.data.has(key) ? (structuredClone(this.data.get(key)) as T) : undefined;
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  keys(): string[] {
    return [...this.data.keys()];
  }

  /** Everything stored (a copy). */
  dump(): Record<string, unknown> {
    return Object.fromEntries([...this.data].map(([key, value]) => [key, structuredClone(value)]));
  }
}

export interface FakeTab {
  id: number;
  url?: string;
  windowId: number;
  active: boolean;
}

export interface FakeDownloadItem {
  id: number;
  url: string;
  filename: string;
  state: 'in_progress' | 'complete' | 'interrupted';
  byExtensionId: string;
  options: { url: string; filename?: string; conflictAction?: string; saveAs?: boolean };
}

type MessageListener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => unknown;

interface Context {
  kind: 'worker' | 'page' | 'content';
  url: string;
  tab?: { id: number; url: string; windowId: number; active: boolean };
  onMessage: FakeEvent<MessageListener>;
}

/** A context other than the service worker: a popup, the offscreen document, a content script, an extension page in a tab. */
export interface FakePage {
  readonly url: string;
  readonly runtime: {
    id: string;
    getURL(path: string): string;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: FakeEvent<MessageListener>;
  };
  /** Sends `message` to the worker (and the other extension pages) and resolves with the answer. */
  send(message: unknown): Promise<any>;
  /** The context goes away (popup closed, tab closed, document closed). */
  close(): void;
}

export interface CreatePageOptions {
  /** `popup` (default), `offscreen`, `extension-tab` (an extension page opened in a tab) or `content` (a content script). */
  kind?: 'popup' | 'offscreen' | 'extension-tab' | 'content';
  /** Content scripts: the page URL. Extension pages: the file name, e.g. 'popup.html'. */
  url?: string;
  tabId?: number;
}

const MATCH_ESCAPE = /[.+?^${}()|[\]\\]/g;

/** Chrome match pattern (`https://discord.com/*`) against a URL. */
export function matchesPattern(pattern: string, url: string): boolean {
  return new RegExp(`^${pattern.replace(MATCH_ESCAPE, '\\$&').replace(/\*/g, '.*')}$`).test(url);
}

export class FakeBrowser {
  // ---- storage ----
  readonly storageChanged = new FakeEvent<(changes: Record<string, Change>, area: string) => void>();
  readonly local = new FakeStorageArea('local', (changes, area) => this.storageChanged.dispatch(changes, area));
  readonly session = new FakeStorageArea('session', (changes, area) => this.storageChanged.dispatch(changes, area));

  // ---- events of the worker's chrome ----
  readonly onMessage = new FakeEvent<MessageListener>();
  readonly onStartup = new FakeEvent<() => void>();
  readonly onInstalled = new FakeEvent<(details: unknown) => void>();
  readonly onBeforeSendHeaders = new FakeEvent<(details: unknown) => unknown>();
  readonly onTabRemoved = new FakeEvent<(tabId: number) => void>();
  readonly onCommand = new FakeEvent<(command: string, tab?: unknown) => void>();
  readonly onDownloadChanged = new FakeEvent<(delta: unknown) => void>();
  readonly onNotificationClicked = new FakeEvent<(id: string) => void>();
  readonly onNotificationButtonClicked = new FakeEvent<(id: string, buttonIndex: number) => void>();
  readonly onNotificationClosed = new FakeEvent<(id: string, byUser: boolean) => void>();

  // ---- state ----
  uiLanguage = 'en-US';
  tabs: FakeTab[] = [];
  lastFocusedWindowId = 1;
  /** `tabs.sendMessage` calls (also those that were refused). */
  readonly tabMessages: Array<{ tabId: number; message: unknown }> = [];
  readonly tabUpdates: Array<{ tabId: number; props: unknown }> = [];
  readonly tabsCreated: Array<{ url?: string }> = [];
  readonly tabReloads: number[] = [];
  readonly windowUpdates: Array<{ windowId: number; info: unknown }> = [];
  readonly badge = { text: '', color: '' as string, textCalls: 0 };
  readonly notifications = {
    created: [] as Array<{ id: string; options: any }>,
    cleared: [] as string[],
  };
  readonly downloads = {
    items: [] as FakeDownloadItem[],
    nextId: 1,
    /** Complete every download right after it was created (a fast disk). */
    autoComplete: false,
    /** The next `download()` rejects with this error. */
    failNext: null as Error | null,
    shown: [] as number[],
    defaultFolderShown: 0,
  };
  readonly offscreen = {
    open: false,
    createCalls: 0,
    closeCalls: 0,
    lastParams: undefined as unknown,
    /** Runs when a document is created (boot the engine here); awaited before `createDocument` resolves. */
    onCreate: undefined as undefined | (() => void | Promise<void>),
    /** Runs when the document is closed. */
    onClose: undefined as undefined | (() => void),
  };

  private readonly contexts: Context[] = [];
  private readonly workerContext: Context;
  /** The service worker's `chrome` global. */
  readonly chrome: typeof chrome;

  constructor() {
    this.workerContext = { kind: 'worker', url: `${EXTENSION_URL}background.js`, onMessage: this.onMessage };
    this.contexts.push(this.workerContext);
    this.chrome = this.buildWorkerChrome();
  }

  // ---- contexts ----

  createPage(options: CreatePageOptions = {}): FakePage {
    const kind = options.kind ?? 'popup';
    const onMessage = new FakeEvent<MessageListener>();
    let context: Context;
    if (kind === 'content') {
      const tabId = options.tabId ?? 1;
      const url = options.url ?? 'https://discord.com/channels/@me';
      this.ensureTab(tabId, url);
      context = { kind: 'content', url, tab: { id: tabId, url, windowId: 1, active: true }, onMessage };
    } else {
      const file = options.url ?? (kind === 'offscreen' ? 'offscreen.html' : 'popup.html');
      const url = file.startsWith('chrome-extension://') ? file : `${EXTENSION_URL}${file}`;
      const tabId = kind === 'extension-tab' ? (options.tabId ?? 99) : undefined;
      context = { kind: 'page', url, tab: tabId === undefined ? undefined : { id: tabId, url, windowId: 1, active: true }, onMessage };
    }
    this.contexts.push(context);
    const runtime = {
      id: EXTENSION_ID,
      getURL: (path: string) => `${EXTENSION_URL}${path}`,
      sendMessage: (message: unknown) => this.deliver(context, message),
      onMessage,
    };
    return {
      url: context.url,
      runtime,
      send: (message) => runtime.sendMessage(message),
      close: () => {
        const index = this.contexts.indexOf(context);
        if (index >= 0) this.contexts.splice(index, 1);
      },
    };
  }

  /** A content script in tab `tabId` (creates the tab when it is not there yet). */
  createContentScript(tabId = 1, url = 'https://discord.com/channels/@me'): FakePage {
    return this.createPage({ kind: 'content', tabId, url });
  }

  private ensureTab(id: number, url: string): void {
    if (!this.tabs.some((tab) => tab.id === id)) this.tabs.push({ id, url, windowId: 1, active: true });
  }

  private senderOf(context: Context): chrome.runtime.MessageSender {
    const sender: chrome.runtime.MessageSender = { id: EXTENSION_ID, url: context.url };
    if (context.tab) {
      sender.tab = { ...context.tab, index: 0, pinned: false, highlighted: false, incognito: false, discarded: false, autoDiscardable: true, groupId: -1 } as chrome.tabs.Tab;
      sender.frameId = 0;
    }
    if (context.kind === 'content') sender.origin = new URL(context.url).origin;
    return sender;
  }

  /** `runtime.sendMessage` semantics: every other extension context's listeners, first answer wins. */
  private deliver(from: Context, message: unknown): Promise<unknown> {
    const sender = this.senderOf(from);
    const listeners = this.contexts.filter((context) => context !== from && context.kind !== 'content').flatMap((context) => context.onMessage.listeners);
    return this.callListeners(listeners, message, sender);
  }

  private callListeners(listeners: MessageListener[], message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
    if (listeners.length === 0) return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    return new Promise((resolve) => {
      let declined = 0;
      let settled = false;
      const finish = (value: unknown): void => {
        if (settled) return;
        settled = true;
        resolve(value === undefined ? undefined : structuredClone(value));
      };
      for (const listener of listeners) {
        let answered = false;
        let keepOpen: unknown = false;
        try {
          keepOpen = listener(structuredClone(message), sender, (response?: unknown) => {
            answered = true;
            finish(response);
          });
        } catch {
          keepOpen = false;
        }
        if (keepOpen !== true && !answered) {
          declined += 1;
          if (declined === listeners.length) finish(undefined);
        }
      }
    });
  }

  // ---- convenience ----

  /** The registered `onMessage` listener of the worker, called like Chrome does; resolves with the answer. */
  sendToWorker(message: unknown, from: FakePage): Promise<unknown> {
    return from.runtime.sendMessage(message);
  }

  /** The `webRequest.onBeforeSendHeaders` event of a Discord page request that carries `token`. */
  discordRequest(token: string, initiator = 'https://discord.com'): unknown {
    return { initiator, tabId: 1, requestHeaders: [{ name: 'Authorization', value: token }] };
  }

  /** Feeds a request carrying `token` to the worker's webRequest listener (the worker must be loaded). */
  captureToken(token: string, initiator?: string): void {
    this.onBeforeSendHeaders.dispatch(this.discordRequest(token, initiator));
  }

  /** Marks `download` finished (a blob read completely) and fires the event. */
  completeDownload(id: number): void {
    this.finishDownload(id, 'complete');
  }

  interruptDownload(id: number): void {
    this.finishDownload(id, 'interrupted');
  }

  private finishDownload(id: number, state: 'complete' | 'interrupted'): void {
    const item = this.downloads.items.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`no download ${id}`);
    const previous = item.state;
    item.state = state;
    this.onDownloadChanged.dispatch({ id, state: { previous, current: state } });
  }

  clickNotification(id: string): void {
    this.onNotificationClicked.dispatch(id);
  }

  clickNotificationButton(id: string, buttonIndex = 0): void {
    this.onNotificationButtonClicked.dispatch(id, buttonIndex);
  }

  // ---- the worker's chrome ----

  private buildWorkerChrome(): typeof chrome {
    const runtime = {
      id: EXTENSION_ID,
      getURL: (path: string) => `${EXTENSION_URL}${path}`,
      onMessage: this.onMessage,
      onStartup: this.onStartup,
      onInstalled: this.onInstalled,
      /** `chrome.runtime.reload()` (the dev reload loop calls it). */
      reload: vi.fn(),
      sendMessage: vi.fn((message: unknown) => this.deliver(this.workerContext, message)),
      getContexts: vi.fn(async (filter: { contextTypes?: string[]; documentUrls?: string[] }) => {
        const wanted = filter.contextTypes ?? [];
        const urls = filter.documentUrls;
        const contexts: Array<{ contextType: string; documentUrl: string }> = [];
        if (this.offscreen.open && (wanted.length === 0 || wanted.includes('OFFSCREEN_DOCUMENT'))) {
          const documentUrl = `${EXTENSION_URL}offscreen.html`;
          if (urls === undefined || urls.includes(documentUrl)) contexts.push({ contextType: 'OFFSCREEN_DOCUMENT', documentUrl });
        }
        return contexts;
      }),
    };

    const storage = { local: this.local, session: this.session, onChanged: this.storageChanged };

    const tabs = {
      query: vi.fn(async (info: { url?: string | string[]; active?: boolean; lastFocusedWindow?: boolean } = {}) => {
        const patterns = info.url === undefined ? undefined : Array.isArray(info.url) ? info.url : [info.url];
        return this.tabs
          .filter((tab) => patterns === undefined || (tab.url !== undefined && patterns.some((pattern) => matchesPattern(pattern, tab.url as string))))
          .filter((tab) => info.active === undefined || tab.active === info.active)
          .filter((tab) => !info.lastFocusedWindow || tab.windowId === this.lastFocusedWindowId)
          .map((tab) => ({ ...tab }));
      }),
      sendMessage: vi.fn(async (tabId: number, message: unknown) => {
        this.tabMessages.push({ tabId, message });
        const listeners = this.contexts.filter((context) => context.kind === 'content' && context.tab?.id === tabId).flatMap((context) => context.onMessage.listeners);
        return this.callListeners(listeners, message, { id: EXTENSION_ID, url: `${EXTENSION_URL}background.js` });
      }),
      update: vi.fn(async (tabId: number, props: unknown) => {
        this.tabUpdates.push({ tabId, props });
        return this.tabs.find((tab) => tab.id === tabId);
      }),
      create: vi.fn(async (props: { url?: string }) => {
        this.tabsCreated.push(props);
        const tab: FakeTab = { id: 1000 + this.tabsCreated.length, url: props.url, windowId: 1, active: true };
        this.tabs.push(tab);
        return tab;
      }),
      reload: vi.fn(async (tabId: number) => {
        this.tabReloads.push(tabId);
      }),
      onRemoved: this.onTabRemoved,
    };

    const windows = {
      update: vi.fn(async (windowId: number, info: unknown) => {
        this.windowUpdates.push({ windowId, info });
        return { id: windowId };
      }),
    };

    const action = {
      setBadgeText: vi.fn(async ({ text }: { text: string }) => {
        this.badge.text = text;
        this.badge.textCalls += 1;
      }),
      setBadgeBackgroundColor: vi.fn(async ({ color }: { color: string }) => {
        this.badge.color = color;
      }),
      getBadgeText: vi.fn(async () => this.badge.text),
    };

    const offscreen = {
      createDocument: vi.fn(async (params: unknown) => {
        if (this.offscreen.open) throw new Error('Only a single offscreen document may be created.');
        this.offscreen.open = true;
        this.offscreen.createCalls += 1;
        this.offscreen.lastParams = params;
        await this.offscreen.onCreate?.();
      }),
      closeDocument: vi.fn(async () => {
        if (!this.offscreen.open) throw new Error('No current offscreen document.');
        this.offscreen.open = false;
        this.offscreen.closeCalls += 1;
        this.offscreen.onClose?.();
      }),
    };

    const downloads = {
      download: vi.fn(async (options: FakeDownloadItem['options']) => {
        if (this.downloads.failNext) {
          const error = this.downloads.failNext;
          this.downloads.failNext = null;
          throw error;
        }
        const id = this.downloads.nextId++;
        this.downloads.items.push({ id, url: options.url, filename: options.filename ?? '', state: 'in_progress', byExtensionId: EXTENSION_ID, options: structuredClone(options) });
        if (this.downloads.autoComplete) queueMicrotask(() => this.completeDownload(id));
        return id;
      }),
      search: vi.fn(async (query: { id?: number; state?: string }) =>
        this.downloads.items
          .filter((item) => query.id === undefined || item.id === query.id)
          .filter((item) => query.state === undefined || item.state === query.state)
          .map((item) => ({ ...item })),
      ),
      show: vi.fn((id: number) => {
        this.downloads.shown.push(id);
      }),
      showDefaultFolder: vi.fn(() => {
        this.downloads.defaultFolderShown += 1;
      }),
      onChanged: this.onDownloadChanged,
    };

    const notifications = {
      create: vi.fn(async (id: string, options: unknown) => {
        this.notifications.created.push({ id, options });
        return id;
      }),
      clear: vi.fn(async (id: string) => {
        this.notifications.cleared.push(id);
        return true;
      }),
      onClicked: this.onNotificationClicked,
      onButtonClicked: this.onNotificationButtonClicked,
      onClosed: this.onNotificationClosed,
    };

    return {
      runtime,
      storage,
      webRequest: { onBeforeSendHeaders: this.onBeforeSendHeaders },
      tabs,
      windows,
      action,
      offscreen,
      downloads,
      notifications,
      commands: { onCommand: this.onCommand },
      i18n: { getUILanguage: () => this.uiLanguage },
    } as unknown as typeof chrome;
  }
}

export function createFakeBrowser(): FakeBrowser {
  return new FakeBrowser();
}
