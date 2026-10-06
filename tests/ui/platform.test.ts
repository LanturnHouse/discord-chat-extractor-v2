import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL, SESSION } from '@/shared';
import {
  ChromePlatform,
  SHORTCUTS_URL,
  assertReadableKeys,
  assertWritableKeys,
  hasExtensionRuntime,
  isMockRequested,
  isReadableKey,
  isWritableKey,
  readableChanges,
  shouldUseMock,
} from '@/ui/platform';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the popup never reads the authentication value (docs/PLAN.md §5.2, §8)', () => {
  it('SESSION.token and SESSION.tokenCapturedAt are not readable, in either area', () => {
    for (const area of ['local', 'session'] as const) {
      expect(isReadableKey(area, SESSION.token), `${area} token`).toBe(false);
      expect(isReadableKey(area, SESSION.tokenCapturedAt), `${area} capture time`).toBe(false);
    }
  });

  it('the keys the popup does use are readable', () => {
    for (const key of [LOCAL.settings, LOCAL.lastAccount, LOCAL.theme, LOCAL.queue('123'), LOCAL.history('123')]) expect(isReadableKey('local', key), key).toBe(true);
    for (const key of [SESSION.account, SESSION.job, SESSION.injectHealth]) expect(isReadableKey('session', key), key).toBe(true);
  });

  it('the tree keys of the 5th change are readable: the groups and their settings of an account, and the open groups', () => {
    for (const key of [LOCAL.groups('123'), LOCAL.groupSettings('123'), LOCAL.uiExpanded]) expect(isReadableKey('local', key), key).toBe(true);
    expect(isReadableKey('local', LOCAL.groups(''))).toBe(false); // a prefix without an account id
    expect(isReadableKey('local', LOCAL.groupSettings(''))).toBe(false);
    expect(isReadableKey('session', LOCAL.groups('123'))).toBe(false);
    expect(isReadableKey('session', LOCAL.uiExpanded)).toBe(false);
  });

  it('nothing else is readable: it is an allow-list, not a block-list', () => {
    expect(isReadableKey('local', LOCAL.lastExported('1'))).toBe(false);
    expect(isReadableKey('local', LOCAL.classCache)).toBe(false);
    expect(isReadableKey('local', 'dce.queue.')).toBe(false); // a prefix without an account id
    expect(isReadableKey('local', 'dce.history.')).toBe(false);
    expect(isReadableKey('local', 'dce.anything')).toBe(false);
    expect(isReadableKey('local', SESSION.job)).toBe(false); // a session key asked from the wrong area
    expect(isReadableKey('session', LOCAL.settings)).toBe(false);
    expect(isReadableKey('session', LOCAL.queue('1'))).toBe(false);
    expect(isReadableKey('session', 'something')).toBe(false);
  });

  it('assertReadableKeys throws for any forbidden key, naming the key and never a value', () => {
    expect(() => assertReadableKeys('session', [SESSION.account, SESSION.token])).toThrow(/dce\.token/);
    expect(() => assertReadableKeys('session', [SESSION.tokenCapturedAt])).toThrow(/session/);
    expect(() => assertReadableKeys('local', [LOCAL.settings, LOCAL.queue('1')])).not.toThrow();
    expect(() => assertReadableKeys('local', [])).not.toThrow();
  });

  it('readableChanges removes the keys the popup may not see', () => {
    const changes = readableChanges('session', {
      [SESSION.token]: { newValue: 'secret-value' },
      [SESSION.tokenCapturedAt]: { newValue: 1 },
      [SESSION.job]: { newValue: null },
    });
    expect(Object.keys(changes)).toEqual([SESSION.job]);
    expect(JSON.stringify(changes)).not.toContain('secret-value');
  });
});

function stubChrome(overrides: Record<string, unknown> = {}) {
  const local = { get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, `value of ${key}`]))) };
  const session = { get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, `value of ${key}`]))) };
  const listeners = new Set<(changes: Record<string, { newValue?: unknown }>, area: string) => void>();
  const chromeStub = {
    runtime: { id: 'abcdefghijklmnopabcdefghijklmnop', sendMessage: vi.fn(async (_message?: unknown): Promise<unknown> => ({ ok: true, data: undefined })) },
    storage: {
      local,
      session,
      onChanged: {
        addListener: vi.fn((listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => listeners.add(listener)),
        removeListener: vi.fn((listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => listeners.delete(listener)),
      },
    },
    commands: { getAll: vi.fn(async () => [{ name: 'add-current-chat', description: 'Add', shortcut: 'Alt+Shift+D' }, { name: '_execute_action', shortcut: '' }]) },
    tabs: { create: vi.fn(async () => ({})) },
    i18n: { getUILanguage: vi.fn(() => 'ko') },
    ...overrides,
  };
  vi.stubGlobal('chrome', chromeStub);
  return { chrome: chromeStub, listeners, emit: (changes: Record<string, { newValue?: unknown }>, area: string) => [...listeners].forEach((listener) => listener(changes, area)) };
}

describe('ChromePlatform', () => {
  it('reads allowed keys from the right area', async () => {
    const { chrome } = stubChrome();
    const platform = new ChromePlatform();
    expect(await platform.getStorage('local', [LOCAL.settings])).toEqual({ [LOCAL.settings]: `value of ${LOCAL.settings}` });
    expect(chrome.storage.local.get).toHaveBeenCalledWith([LOCAL.settings]);
    await platform.getStorage('session', [SESSION.job, SESSION.account]);
    expect(chrome.storage.session.get).toHaveBeenCalledWith([SESSION.job, SESSION.account]);
  });

  it('refuses the token before anything is requested', async () => {
    const { chrome } = stubChrome();
    const platform = new ChromePlatform();
    await expect(platform.getStorage('session', [SESSION.token])).rejects.toThrow();
    await expect(platform.getStorage('session', [SESSION.account, SESSION.tokenCapturedAt])).rejects.toThrow();
    expect(chrome.storage.session.get).not.toHaveBeenCalled();
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it('an empty key list reads nothing', async () => {
    const { chrome } = stubChrome();
    expect(await new ChromePlatform().getStorage('local', [])).toEqual({});
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it('forwards storage changes of the two areas, without the keys the popup may not see', () => {
    const { emit } = stubChrome();
    const seen: Array<[string, string[]]> = [];
    new ChromePlatform().onStorageChanged((area, changes) => seen.push([area, Object.keys(changes)]));
    emit({ [LOCAL.settings]: { newValue: 1 }, [LOCAL.classCache]: { newValue: 2 } }, 'local');
    emit({ [SESSION.token]: { newValue: 'x' }, [SESSION.job]: { newValue: null } }, 'session');
    emit({ [SESSION.token]: { newValue: 'x' } }, 'session'); // nothing left: no call at all
    emit({ [LOCAL.settings]: { newValue: 1 } }, 'sync'); // another area
    expect(seen).toEqual([
      ['local', [LOCAL.settings]],
      ['session', [SESSION.job]],
    ]);
  });

  it('the unsubscribe function removes the listener', () => {
    const { chrome, listeners } = stubChrome();
    const stop = new ChromePlatform().onStorageChanged(() => undefined);
    expect(listeners.size).toBe(1);
    stop();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it('sendMessage returns the answer of the background worker as a BgResponse', async () => {
    const { chrome } = stubChrome();
    chrome.runtime.sendMessage.mockResolvedValueOnce({ ok: true, data: { jobId: 'j1' } });
    const platform = new ChromePlatform();
    expect(await platform.sendMessage({ to: 'bg', type: 'job/start', keys: 'all' })).toEqual({ ok: true, data: { jobId: 'j1' } });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ to: 'bg', type: 'job/start', keys: 'all' });
    chrome.runtime.sendMessage.mockResolvedValueOnce({ ok: false, error: 'busy', message: 'already running' });
    expect(await platform.sendMessage({ to: 'bg', type: 'job/start', keys: 'all' })).toEqual({ ok: false, error: 'busy', message: 'already running' });
  });

  it('sendMessage never rejects: a failure to deliver is an error response', async () => {
    const { chrome } = stubChrome();
    chrome.runtime.sendMessage.mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.'));
    const platform = new ChromePlatform();
    expect(await platform.sendMessage({ to: 'bg', type: 'status/get' })).toEqual({ ok: false, error: 'unknown', message: 'Could not establish connection. Receiving end does not exist.' });
    chrome.runtime.sendMessage.mockRejectedValueOnce('boom');
    expect(await platform.sendMessage({ to: 'bg', type: 'status/get' })).toMatchObject({ ok: false, error: 'unknown' });
  });

  it('sendMessage turns a missing or malformed answer into an error response', async () => {
    const { chrome } = stubChrome();
    const platform = new ChromePlatform();
    for (const answer of [undefined, null, 'ok', 5, { data: 1 }, { ok: 'yes' }]) {
      chrome.runtime.sendMessage.mockResolvedValueOnce(answer);
      expect(await platform.sendMessage({ to: 'bg', type: 'status/get' }), String(answer)).toMatchObject({ ok: false, error: 'unknown' });
    }
    chrome.runtime.sendMessage.mockResolvedValueOnce({ ok: false, error: 'not-a-real-error' });
    expect(await platform.sendMessage({ to: 'bg', type: 'status/get' })).toEqual({ ok: false, error: 'unknown' });
  });

  it('lists the shortcuts of chrome.commands (and none when the API fails)', async () => {
    const { chrome } = stubChrome();
    const platform = new ChromePlatform();
    expect(await platform.getShortcuts()).toEqual([
      { name: 'add-current-chat', description: 'Add', shortcut: 'Alt+Shift+D' },
      { name: '_execute_action', description: '', shortcut: '' },
    ]);
    chrome.commands.getAll.mockRejectedValueOnce(new Error('nope'));
    expect(await platform.getShortcuts()).toEqual([]);
  });

  it('opens the shortcut settings page of Chrome in a new tab', async () => {
    const { chrome } = stubChrome();
    await new ChromePlatform().openShortcutSettings();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome://extensions/shortcuts' });
    expect(SHORTCUTS_URL).toBe('chrome://extensions/shortcuts');
  });

  it('reads the UI language of the browser', () => {
    const { chrome } = stubChrome();
    expect(new ChromePlatform().getUiLanguage()).toBe('ko');
    chrome.i18n.getUILanguage.mockImplementationOnce(() => {
      throw new Error('no i18n');
    });
    expect(new ChromePlatform().getUiLanguage()).toBe('');
  });
});

describe('which platform runs', () => {
  it('?mock=1 asks for the mock', () => {
    expect(isMockRequested('?mock=1')).toBe(true);
    expect(isMockRequested('?scenario=idle&mock=1')).toBe(true);
    expect(isMockRequested('')).toBe(false);
    expect(isMockRequested('?mock=0')).toBe(false);
    expect(isMockRequested('?mock')).toBe(false);
  });

  it('there is an extension runtime only with chrome.runtime.id and chrome.storage', () => {
    expect(hasExtensionRuntime()).toBe(false); // the test environment has no chrome object
    stubChrome();
    expect(hasExtensionRuntime()).toBe(true);
    vi.stubGlobal('chrome', { runtime: {} });
    expect(hasExtensionRuntime()).toBe(false);
    vi.stubGlobal('chrome', { runtime: { id: '' }, storage: {} });
    expect(hasExtensionRuntime()).toBe(false);
  });

  it('the mock runs when asked for, and whenever there is no runtime', () => {
    expect(shouldUseMock('')).toBe(true); // no runtime
    stubChrome();
    expect(shouldUseMock('')).toBe(false);
    expect(shouldUseMock('?mock=1')).toBe(true);
  });
});

describe('the popup writes exactly one key: the open groups of the tree (docs/PLAN.md §5.2 LOCAL.uiExpanded)', () => {
  it('only that key, only in storage.local', () => {
    expect(isWritableKey('local', LOCAL.uiExpanded)).toBe(true);
    expect(isWritableKey('session', LOCAL.uiExpanded)).toBe(false);
    for (const key of [LOCAL.settings, LOCAL.queue('1'), LOCAL.history('1'), LOCAL.groups('1'), LOCAL.groupSettings('1'), LOCAL.lastExported('1'), LOCAL.lastAccount, LOCAL.theme, LOCAL.classCache, 'dce.anything']) {
      expect(isWritableKey('local', key), key).toBe(false);
    }
    for (const key of [SESSION.token, SESSION.tokenCapturedAt, SESSION.account, SESSION.job, SESSION.injectHealth]) expect(isWritableKey('session', key), key).toBe(false);
  });

  it('assertWritableKeys throws for any other key, naming the key and never a value', () => {
    expect(() => assertWritableKeys('local', { [LOCAL.uiExpanded]: ['a'] })).not.toThrow();
    expect(() => assertWritableKeys('local', {})).not.toThrow();
    expect(() => assertWritableKeys('local', { [LOCAL.uiExpanded]: [], [LOCAL.settings]: 'secret-value' })).toThrow(/dce\.settings/);
    let message = '';
    try {
      assertWritableKeys('local', { [LOCAL.settings]: 'secret-value' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('secret-value');
    expect(() => assertWritableKeys('session', { [SESSION.token]: 'x' })).toThrow(/session/);
  });

  it('ChromePlatform.setStorage writes the allowed key to storage.local', async () => {
    const { chrome } = stubChrome();
    const set = vi.fn(async (_items: Record<string, unknown>) => undefined);
    (chrome.storage.local as unknown as { set: typeof set }).set = set;
    await new ChromePlatform().setStorage('local', { [LOCAL.uiExpanded]: ['a', 'b'] });
    expect(set).toHaveBeenCalledWith({ [LOCAL.uiExpanded]: ['a', 'b'] });
  });

  it('ChromePlatform.setStorage refuses every other key before anything is written', async () => {
    const { chrome } = stubChrome();
    const localSet = vi.fn(async (_items: Record<string, unknown>) => undefined);
    const sessionSet = vi.fn(async (_items: Record<string, unknown>) => undefined);
    (chrome.storage.local as unknown as { set: typeof localSet }).set = localSet;
    (chrome.storage.session as unknown as { set: typeof sessionSet }).set = sessionSet;
    const platform = new ChromePlatform();
    await expect(platform.setStorage('local', { [LOCAL.settings]: {} })).rejects.toThrow(/dce\.settings/);
    await expect(platform.setStorage('local', { [LOCAL.uiExpanded]: [], [LOCAL.queue('1')]: [] })).rejects.toThrow();
    await expect(platform.setStorage('session', { [LOCAL.uiExpanded]: [] })).rejects.toThrow();
    await expect(platform.setStorage('session', { [SESSION.token]: 'x' })).rejects.toThrow();
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
  });

  it('ChromePlatform.setStorage with nothing to write does not call storage', async () => {
    const { chrome } = stubChrome();
    const set = vi.fn(async (_items: Record<string, unknown>) => undefined);
    (chrome.storage.local as unknown as { set: typeof set }).set = set;
    await new ChromePlatform().setStorage('local', {});
    expect(set).not.toHaveBeenCalled();
  });
});
