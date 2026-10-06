/**
 * The content script's controller: wires the store, the injector, the interaction handlers, the toast and tooltip, theme
 * capture, health reports and the shortcut together, reacts to settings, and tears everything down quietly when the
 * extension context goes away (docs/PLAN.md §3, §7.1, §7.4).
 *
 * Nothing here is global: `createApp()` can run several times (tests). The real entry (index.ts) runs it once.
 */
import type { ThemeTokens } from '@/shared/types';
import { LOCAL } from '@/shared/storageKeys';
import { Actions } from './actions';
import { KEY_ATTR, TIMING } from './config';
import { debug } from './debug';
import { findGuildHeaders, guildNameFor } from './dom/header';
import { currentGuildId } from './dom/page';
import { categoryRequest, buildTarget, guildRequest, type GuildRequest } from './dom/target';
import { findRowForButton, hasSidebarRows, type Row } from './dom/rows';
import { GroupInfoReporter } from './groupInfo';
import { HealthReporter } from './health';
import { resolveLang, strings as allStrings, type Lang, type Strings } from './i18n';
import { ClassCache, type ClassCacheData } from './inject/classCache';
import { isGuildButton } from './inject/guildButton';
import { Injector, type Scheduler } from './inject/injector';
import { installInteraction } from './inject/interaction';
import { browserUiLanguage, postToBackground, runtimeAlive, sendToBackground, writeLocal } from './platform';
import { toggleCurrentChat } from './shortcut';
import { ContentStore } from './state';
import { ThemeWatcher } from './theme';
import { Overlay } from './ui/overlay';
import { Toast } from './ui/toast';
import { Tooltip } from './ui/tooltip';

export interface AppOptions {
  doc?: Document;
  /** Replaces the frame scheduler of the injector (tests). */
  schedule?: Scheduler;
  /** How often an idle page checks that the extension is still alive (default 10 s). */
  aliveCheckMs?: number;
}

export interface ContentApp {
  /** Reads the stored state and starts everything that is switched on. Never rejects. */
  start(): Promise<void>;
  /** Removes every node, listener, observer and timer of the content script. Safe to call twice. */
  destroy(): void;
  readonly destroyed: boolean;
  readonly store: ContentStore;
  readonly injector: Injector;
  readonly overlay: Overlay;
  readonly toast: Toast;
  readonly tooltip: Tooltip;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export function createApp(options: AppOptions = {}): ContentApp {
  const doc = options.doc ?? document;
  const win = doc.defaultView ?? window;

  const store = new ContentStore();
  const overlay = new Overlay(doc);
  let destroyed = false;
  let started = false;
  let aliveTimer: ReturnType<typeof setInterval> | undefined;
  let cacheTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingCache: ClassCacheData | null = null;
  let stopInteraction: (() => void) | null = null;
  let stopNavigation: (() => void) | null = null;
  let watchdog: ReturnType<typeof setInterval> | undefined;

  const lang = (): Lang => resolveLang(store.settings.language, doc.documentElement.lang, browserUiLanguage());
  const strings = (): Strings => allStrings[lang()];

  // ---- class cache: learned from native icons, shared through chrome.storage.local (debounced writes) ----
  const flushClassCache = (): void => {
    if (!pendingCache || destroyed) return;
    const data = pendingCache;
    pendingCache = null;
    store.classCache = data; // so the storage echo of our own write is not mistaken for another tab's lesson
    void writeLocal({ [LOCAL.classCache]: data });
  };
  const cache = new ClassCache({}, (data) => {
    pendingCache = data;
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(flushClassCache, TIMING.classCacheDebounceMs);
  });

  // ---- pieces ----
  const health = new HealthReporter({
    send: (report) => {
      debug('health', report.ok, report.reason);
      postToBackground({ to: 'bg', type: 'inject/health', health: report });
    },
    now: () => Date.now(),
    url: () => `${location.origin}${location.pathname}`,
    hasButtons: () => injector.hasButtons(),
    hasRows: () => hasSidebarRows(doc),
  });

  const tooltip = new Tooltip(overlay, (button) => button.getAttribute('aria-label') ?? '');
  const toast = new Toast(overlay, () => {
    // The fade-out is done; with the buttons switched off nothing of ours should stay in the page.
    if (!injector.active) overlay.release();
  });

  const actions = new Actions({ store, toast, strings, isAlive: runtimeAlive, onDead: destroy });

  // Which servers the page shows: the worker keeps the group lists (check marks of the category / server buttons) fresh for them.
  const groupInfo = new GroupInfoReporter({
    now: () => Date.now(),
    hasAccount: () => store.accountId !== null,
    send: sendToBackground,
    retryDue: () => injector.requestFullScan(), // a pass that sees the server asks again (a worker that had no account yet)
  });
  /** A pass saw a server (its channel list or its header). */
  function onGuildSeen(): void {
    const pathname = win.location.pathname;
    const guildId = currentGuildId(pathname);
    if (!guildId) return;
    groupInfo.seen(guildId, () => guildNameFor(findGuildHeaders(doc)[0]?.header ?? null, doc, pathname));
  }

  const injector = new Injector({
    doc,
    cache,
    isQueued: (key) => store.isQueued(key),
    isGroupChecked: (groupId) => store.isGroupChecked(groupId),
    strings,
    guildId: () => currentGuildId(win.location.pathname),
    isGuildBusy: () => guildBusy,
    onGuildSeen,
    isAlive: runtimeAlive,
    onDead: destroy,
    onPass: (stats) => {
      overlay.ensureStyle(); // the fallback look, the forced visibility and the header margin live there: put it back if the page dropped it
      debug('pass', stats);
      health.onPass(stats);
    },
    schedule: options.schedule,
  });

  const theme = new ThemeWatcher({
    doc,
    write: (tokens: ThemeTokens) => void writeLocal({ [LOCAL.theme]: tokens }),
    onCaptured: () => {
      injector.refreshAll(); // the page language may have changed
      tooltip.refresh();
    },
  });

  // ---- clicks ----
  const busy = new WeakSet<HTMLElement>();
  /**
   * A server request is in flight. One flag for the whole page, not one per button: Discord may rebuild the header (a new button)
   * while the worker is still adding channels, and a second request then would only say "nothing to add" over the first one's toast.
   */
  let guildBusy = false;

  async function perform(row: Row): Promise<void> {
    debug('click', row.kind);
    try {
      if (row.kind === 'category') {
        const request = categoryRequest(row);
        if (request) await actions.addCategory(request);
        else toast.show('error', strings().toastError);
        return;
      }
      const target = buildTarget(row);
      if (target) await actions.toggle(target);
      else toast.show('error', strings().toastError);
    } catch {
      // never let a failed click surface as an unhandled rejection in Discord's console
    }
  }

  async function performGuild(request: GuildRequest): Promise<void> {
    debug('click', 'guild');
    guildBusy = true;
    injector.fresh.expect(request.guildId); // a check mark that comes of this click is shown before the cross may replace it
    injector.refreshAll(); // the button shows as busy
    try {
      await actions.addGuild(request);
    } catch {
      // never let a failed click surface as an unhandled rejection in Discord's console
    } finally {
      guildBusy = false;
      injector.fresh.settle(request.guildId);
      if (!destroyed) injector.refreshAll();
    }
  }

  /** The server button: toggles every channel of the server in the address bar (the worker skips what cannot be read). */
  function activateGuild(button: HTMLElement): void {
    if (guildBusy) return;
    const request = guildRequest(button, doc, win.location.pathname);
    if (request) void performGuild(request);
    else toast.show('error', strings().toastError); // not inside a server any more: a button left over from the one just visited
  }

  function activate(button: HTMLElement): void {
    if (destroyed) return;
    if (isGuildButton(button)) {
      activateGuild(button);
      return;
    }
    if (busy.has(button)) return;
    const row = findRowForButton(button);
    if (!row) {
      toast.show('error', strings().toastError);
      return;
    }
    busy.add(button);
    // The pointer is still on the button after the click: a check mark that comes of it must be seen before the cross may replace it
    // (`data-dce-fresh`, inject/fresh.ts). The key is the button's own (the row / category id).
    const key = button.getAttribute(KEY_ATTR);
    if (key) injector.fresh.expect(key);
    void perform(row).finally(() => {
      busy.delete(button);
      if (key) injector.fresh.settle(key);
    });
  }

  // ---- injection on / off ----
  function startInjection(): void {
    if (destroyed || injector.active) return;
    debug('buttons on');
    overlay.ensureStyle();
    injector.start();
    stopInteraction = installInteraction({
      win,
      isAlive: runtimeAlive,
      onDead: destroy,
      activate,
      showTooltip: (button) => tooltip.show(button),
      hideTooltip: (button) => tooltip.hide(button),
      leave: (button) => injector.fresh.release(button),
    });
    // The sidebars are watched through the DOM; these only make sure a rescan happens when the address or the tab changes.
    const rescan = (): void => injector.requestFullScan();
    const onVisible = (): void => {
      if (!doc.hidden) rescan();
    };
    const navigation = (win as unknown as { navigation?: EventTarget }).navigation;
    win.addEventListener('popstate', rescan);
    doc.addEventListener('visibilitychange', onVisible);
    navigation?.addEventListener('navigatesuccess', rescan);
    stopNavigation = () => {
      win.removeEventListener('popstate', rescan);
      doc.removeEventListener('visibilitychange', onVisible);
      navigation?.removeEventListener('navigatesuccess', rescan);
    };
    // Health watchdog: while the page shows rows but none has a button, look again every 10 s. A full scan is the only pass that
    // can tell "list items nobody recognises" apart from "nothing there yet", and incremental passes only see what Discord adds.
    watchdog = setInterval(() => {
      if (injector.active && !injector.hasButtons() && hasSidebarRows(doc)) injector.requestFullScan();
    }, TIMING.healthFailMs);
  }

  function stopInjection(report: boolean): void {
    if (injector.active) debug('buttons off');
    clearInterval(watchdog);
    stopInteraction?.();
    stopInteraction = null;
    stopNavigation?.();
    stopNavigation = null;
    tooltip.dispose();
    toast.dispose();
    injector.stop();
    overlay.release();
    if (report) health.onStopped();
  }

  function applySettings(): void {
    if (destroyed) return;
    if (store.settings.showButtons && !injector.active) startInjection();
    else if (!store.settings.showButtons && injector.active) stopInjection(true);
    else if (injector.active) {
      injector.refreshAll(); // the language changed
      tooltip.refresh();
    }
  }

  store.on((event) => {
    if (destroyed) return;
    if (event === 'settings') applySettings();
    else if (event === 'classCache') cache.replace(store.classCache);
    else {
      injector.refreshAll();
      tooltip.refresh();
      if (event === 'account' && store.accountId !== null) {
        // An account became known (or changed): servers reported without one are reported again, as soon as a pass sees them.
        groupInfo.accountKnown();
        injector.requestFullScan();
      }
    }
  });

  // ---- chrome.* listeners ----
  const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (destroyed) return;
    if (!runtimeAlive()) {
      destroy();
      return;
    }
    store.applyChanges(changes, area);
  };

  const onRuntimeMessage = (message: unknown, _sender: unknown, sendResponse: (response?: unknown) => void): void => {
    if (destroyed || !isRecord(message) || message.to !== 'content') return;
    if (message.type !== 'shortcut/toggleCurrent') return;
    if (!runtimeAlive()) {
      destroy();
      return;
    }
    void toggleCurrentChat({ doc, pathname: () => location.pathname, actions, toast, strings }).catch(() => undefined);
    sendResponse({ ok: true });
  };

  // ---- lifecycle ----
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    debug('torn down');
    clearInterval(aliveTimer);
    clearTimeout(cacheTimer);
    pendingCache = null;
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      // the context is already gone
    }
    theme.stop();
    health.dispose();
    groupInfo.dispose();
    stopInjection(false);
    store.dispose();
  }

  async function start(): Promise<void> {
    if (started || destroyed) return;
    started = true;
    if (!runtimeAlive()) {
      destroy();
      return;
    }
    try {
      chrome.storage.onChanged.addListener(onStorageChanged);
      chrome.runtime.onMessage.addListener(onRuntimeMessage);
    } catch {
      destroy();
      return;
    }
    aliveTimer = setInterval(() => {
      if (!runtimeAlive()) destroy();
    }, options.aliveCheckMs ?? TIMING.aliveCheckMs);

    try {
      await store.load();
      if (destroyed) return;
      cache.replace(store.classCache);
      theme.start();
      if (store.settings.showButtons) startInjection();
    } catch (error) {
      // Nothing here is expected to throw; if it does, leave the page exactly as it was rather than half-decorated.
      debug('start failed', error);
      destroy();
    }
  }

  return {
    start,
    destroy,
    get destroyed() {
      return destroyed;
    },
    store,
    injector,
    overlay,
    toast,
    tooltip,
  };
}
