import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentStore, parseAccountId, parseGroups, parseQueue, parseSettings, type StoreEvent } from '@/content/state';
import { DEFAULT_APP_SETTINGS } from '@/shared/defaults';
import { LOCAL } from '@/shared/storageKeys';
import { installChrome } from './helpers/chromeMock';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A stored `GroupInfo` (PLAN §5.1) holding `channelIds`. */
const group = (channelIds: unknown, kind: 'category' | 'guild' = 'category'): unknown => ({ kind, guildId: '1', channelIds, updatedAt: 1 });

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('parseSettings', () => {
  it('missing or malformed settings mean the defaults of PLAN §5.4', () => {
    const defaults = {
      showButtons: DEFAULT_APP_SETTINGS.showButtons,
      language: DEFAULT_APP_SETTINGS.language,
    };
    expect(defaults).toEqual({ showButtons: true, language: 'auto' });
    for (const value of [undefined, null, 5, 'x', [], {}]) expect(parseSettings(value)).toEqual(defaults);
  });

  it('takes the two fields it reacts to, ignoring wrong types', () => {
    expect(parseSettings({ showButtons: false, language: 'en' })).toEqual({ showButtons: false, language: 'en' });
    expect(parseSettings({ showButtons: 'no', language: 'fr' })).toEqual({ showButtons: true, language: 'auto' });
    expect(parseSettings({ language: 'ko', common: { count: 5 }, zipAll: true })).toMatchObject({ language: 'ko' });
  });

  it('option #17 is retired: showQueuedIndicator is not read at all', () => {
    expect(parseSettings({ showQueuedIndicator: true })).toEqual({ showButtons: true, language: 'auto' });
    expect('showQueuedIndicator' in parseSettings({ showQueuedIndicator: true })).toBe(false);
  });
});

describe('parseAccountId / parseQueue', () => {
  it('account id from LOCAL.lastAccount', () => {
    expect(parseAccountId({ id: '500000000000000001', username: 'x' })).toBe('500000000000000001');
    for (const value of [null, undefined, {}, { id: 5 }, { id: '' }, 'x']) expect(parseAccountId(value)).toBeNull();
  });

  it('queue keys from LOCAL.queue(accountId); sloppy items are skipped', () => {
    expect(parseQueue([{ key: 'a' }, { key: 'b', target: {} }])).toEqual(new Set(['a', 'b']));
    expect(parseQueue([null, 1, { key: 2 }, { key: '' }, { key: 'c' }, 'd'])).toEqual(new Set(['c']));
    expect(parseQueue(undefined)).toEqual(new Set());
    expect(parseQueue({ key: 'a' })).toEqual(new Set());
  });
});

describe('parseGroups (LOCAL.groups(accountId): Record<groupId, GroupInfo>)', () => {
  it('group id -> its channel ids', () => {
    const parsed = parseGroups({ '10': group(['a', 'b']), '20': group(['c'], 'guild') });
    expect(Array.from(parsed.entries())).toEqual([
      ['10', ['a', 'b']],
      ['20', ['c']],
    ]);
  });

  it('an empty list is a group (it is simply never checked)', () => {
    expect(parseGroups({ '10': group([]) }).get('10')).toEqual([]);
  });

  it('anything that is not a record gives no groups', () => {
    for (const value of [undefined, null, 5, 'x', [], [{ channelIds: ['a'] }]]) expect(parseGroups(value).size).toBe(0);
  });

  it('a group whose list is malformed is left out altogether (never decided from half a list)', () => {
    const parsed = parseGroups({
      ok: group(['a']),
      noList: { kind: 'category', guildId: '1', updatedAt: 1 },
      notAnArray: group('a'),
      badEntry: group(['a', 5]),
      emptyEntry: group(['a', '']),
      nullInfo: null,
      '': group(['z']),
    });
    expect(Array.from(parsed.keys())).toEqual(['ok']);
  });
});

describe('ContentStore', () => {
  it('reads settings, the last account, its queue, its groups and the class cache', async () => {
    installChrome({
      [LOCAL.settings]: { showButtons: false, language: 'ko' },
      [LOCAL.lastAccount]: { id: '7', username: 'u' },
      [LOCAL.queue('7')]: [{ key: 'a' }, { key: 'b' }],
      [LOCAL.queue('8')]: [{ key: 'other' }],
      [LOCAL.groups('7')]: { g1: group(['a', 'b']), g2: group(['a', 'z']) },
      [LOCAL.groups('8')]: { g3: group(['other']) },
      [LOCAL.classCache]: { dmButton: 'closeButton__1 x' },
    });
    const store = new ContentStore();
    await store.load();
    expect(store.settings).toEqual({ showButtons: false, language: 'ko' });
    expect(store.accountId).toBe('7');
    expect([store.isQueued('a'), store.isQueued('b'), store.isQueued('other')]).toEqual([true, true, false]);
    expect([store.isGroupChecked('g1'), store.isGroupChecked('g2'), store.isGroupChecked('g3')]).toEqual([true, false, false]);
    expect(store.classCache).toEqual({ dmButton: 'closeButton__1 x' });
  });

  it('empty storage: defaults, no account, nothing queued, no group checked', async () => {
    installChrome();
    const store = new ContentStore();
    await store.load();
    expect(store.settings).toEqual(parseSettings(undefined));
    expect(store.accountId).toBeNull();
    expect(store.queuedCount()).toBe(0);
    expect(store.isGroupChecked('anything')).toBe(false);
  });

  it('a failing storage read is not an error', async () => {
    const mock = installChrome();
    mock.invalidate();
    const store = new ContentStore();
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.settings).toEqual(parseSettings(undefined));
  });

  it('tells what changed, and only for the local area', async () => {
    installChrome({ [LOCAL.lastAccount]: { id: '7' }, [LOCAL.queue('7')]: [] });
    const store = new ContentStore();
    await store.load();
    const events: StoreEvent[] = [];
    store.on((event) => events.push(event));

    store.applyChanges({ [LOCAL.settings]: { newValue: { language: 'en' } } }, 'sync');
    expect(events).toEqual([]);

    store.applyChanges({ [LOCAL.settings]: { newValue: { language: 'en' } } }, 'local');
    expect(events).toEqual(['settings']);
    store.applyChanges({ [LOCAL.settings]: { newValue: { language: 'en', zipAll: true } } }, 'local'); // nothing we use changed
    expect(events).toEqual(['settings']);

    store.applyChanges({ [LOCAL.queue('7')]: { newValue: [{ key: 'z' }] } }, 'local');
    expect(events).toEqual(['settings', 'queue']);
    expect(store.isQueued('z')).toBe(true);

    store.applyChanges({ [LOCAL.queue('99')]: { newValue: [{ key: 'q' }] } }, 'local'); // some other account
    expect(events).toEqual(['settings', 'queue']);
    expect(store.isQueued('q')).toBe(false);

    store.applyChanges({ [LOCAL.groups('7')]: { newValue: { g: group(['z']) } } }, 'local');
    expect(events).toEqual(['settings', 'queue', 'groups']);
    expect(store.isGroupChecked('g')).toBe(true);

    store.applyChanges({ [LOCAL.groups('99')]: { newValue: { other: group(['z']) } } }, 'local'); // some other account
    store.applyChanges({ [LOCAL.groups('7')]: { newValue: { g: group(['z']) } } }, 'session');
    expect(events).toEqual(['settings', 'queue', 'groups']);
    expect(store.isGroupChecked('other')).toBe(false);

    store.applyChanges({ [LOCAL.classCache]: { newValue: { channelIcon: 'iconItem_abc' } } }, 'local');
    expect(events).toEqual(['settings', 'queue', 'groups', 'classCache']);
    expect(store.classCache).toEqual({ channelIcon: 'iconItem_abc' });
  });

  it('a change that arrives while the first read is still in flight wins over the (older) data of that read', async () => {
    installChrome({ [LOCAL.settings]: { showButtons: true }, [LOCAL.lastAccount]: { id: '7' }, [LOCAL.queue('7')]: [{ key: 'a' }] });
    const store = new ContentStore();
    const events: StoreEvent[] = [];
    store.on((event) => events.push(event));
    const loading = store.load();
    store.applyChanges({ [LOCAL.settings]: { newValue: { showButtons: false } } }, 'local'); // before the read finished
    store.applyChanges({ [LOCAL.queue('7')]: { newValue: [{ key: 'b' }] } }, 'local');
    store.applyChanges({ [LOCAL.groups('7')]: { newValue: { g: group(['b']) } } }, 'local');
    expect(store.settings.showButtons).toBe(true); // held back, not applied to half-loaded state
    await loading;
    expect(store.settings.showButtons).toBe(false);
    expect([store.isQueued('a'), store.isQueued('b')]).toEqual([false, true]);
    expect(store.isGroupChecked('g')).toBe(true);
    expect(events).toContain('settings');
  });

  it('a removed settings key falls back to the defaults', async () => {
    installChrome({ [LOCAL.settings]: { showButtons: false } });
    const store = new ContentStore();
    await store.load();
    expect(store.settings.showButtons).toBe(false);
    store.applyChanges({ [LOCAL.settings]: { oldValue: { showButtons: false } } }, 'local');
    expect(store.settings.showButtons).toBe(true);
  });

  it('switching the account clears the queue and the groups and reads the new ones', async () => {
    const mock = installChrome({
      [LOCAL.lastAccount]: { id: '7' },
      [LOCAL.queue('7')]: [{ key: 'a' }],
      [LOCAL.queue('8')]: [{ key: 'b' }],
      [LOCAL.groups('7')]: { g: group(['a']) },
      [LOCAL.groups('8')]: { h: group(['b']) },
    });
    const store = new ContentStore();
    await store.load();
    expect(store.isGroupChecked('g')).toBe(true);
    const events: StoreEvent[] = [];
    store.on((event) => events.push(event));
    mock.storage.set(LOCAL.lastAccount, { id: '8' });
    store.applyChanges({ [LOCAL.lastAccount]: { newValue: { id: '8' } } }, 'local');
    expect(store.accountId).toBe('8');
    expect(store.isQueued('a')).toBe(false);
    expect(store.isGroupChecked('g')).toBe(false); // the old account's groups are gone at once
    expect(events).toEqual(['account', 'queue']);
    await settle();
    expect(store.isQueued('b')).toBe(true);
    expect(store.isGroupChecked('h')).toBe(true);
    expect(store.isGroupChecked('g')).toBe(false);
  });

  it('an account that goes away leaves nothing checked', async () => {
    installChrome({ [LOCAL.lastAccount]: { id: '7' }, [LOCAL.queue('7')]: [{ key: 'a' }], [LOCAL.groups('7')]: { g: group(['a']) } });
    const store = new ContentStore();
    await store.load();
    store.applyChanges({ [LOCAL.lastAccount]: { newValue: null } }, 'local');
    await settle();
    expect(store.accountId).toBeNull();
    expect(store.isGroupChecked('g')).toBe(false);
    expect(store.queuedCount()).toBe(0);
  });

  it('setQueued is the optimistic update of a click: it tells once and ignores repeats', async () => {
    installChrome();
    const store = new ContentStore();
    await store.load();
    const events: StoreEvent[] = [];
    store.on((event) => events.push(event));
    store.setQueued('k', true);
    store.setQueued('k', true);
    expect(store.isQueued('k')).toBe(true);
    store.setQueued('k', false);
    expect(store.isQueued('k')).toBe(false);
    expect(events).toEqual(['queue', 'queue']);
  });

  it('a disposed store is silent', async () => {
    installChrome();
    const store = new ContentStore();
    await store.load();
    const events: StoreEvent[] = [];
    store.on((event) => events.push(event));
    store.dispose();
    store.setQueued('k', true);
    store.setGroupChecked('g', true);
    store.applyChanges({ [LOCAL.settings]: { newValue: { showButtons: false } } }, 'local');
    expect(events).toEqual([]);
  });
});

describe('ContentStore.isGroupChecked: checked iff the group exists, has at least one channel and every one of them is queued', () => {
  async function storeWith(queue: string[], groups: Record<string, unknown> | undefined): Promise<ContentStore> {
    installChrome({
      [LOCAL.lastAccount]: { id: '7' },
      [LOCAL.queue('7')]: queue.map((key) => ({ key })),
      ...(groups ? { [LOCAL.groups('7')]: groups } : {}),
    });
    const store = new ContentStore();
    await store.load();
    return store;
  }

  it.each([
    ['no group is known for the id', ['a', 'b'], { other: group(['a', 'b']) }, false],
    ['no groups at all (never reported)', ['a', 'b'], undefined, false],
    ['the group is empty (nothing to be "all of")', ['a', 'b'], { g: group([]) }, false],
    ['partial: one channel is missing from the list', ['a'], { g: group(['a', 'b']) }, false],
    ['partial: nothing of it is in the list', [], { g: group(['a', 'b']) }, false],
    ['complete', ['a', 'b'], { g: group(['a', 'b']) }, true],
    ['complete, and the list holds more', ['a', 'b', 'c'], { g: group(['a', 'b']) }, true],
    ['one channel, queued', ['a'], { g: group(['a']) }, true],
    ['one channel, not queued', [], { g: group(['a']) }, false],
    ['the group id itself being in the list means nothing', ['g'], { g: group(['a']) }, false],
  ])('%s', async (_name, queue, groups, expected) => {
    const store = await storeWith(queue, groups);
    expect(store.isGroupChecked('g')).toBe(expected);
  });

  it('follows the storage: a channel added or removed (popup, another tab) flips the check at once', async () => {
    const store = await storeWith(['a'], { g: group(['a', 'b']) });
    expect(store.isGroupChecked('g')).toBe(false);
    store.applyChanges({ [LOCAL.queue('7')]: { newValue: [{ key: 'a' }, { key: 'b' }] } }, 'local');
    expect(store.isGroupChecked('g')).toBe(true);
    store.applyChanges({ [LOCAL.queue('7')]: { newValue: [{ key: 'b' }] } }, 'local');
    expect(store.isGroupChecked('g')).toBe(false);
  });

  it('follows the storage: the worker records a new channel list for the group', async () => {
    const store = await storeWith(['a', 'b'], { g: group(['a', 'b']) });
    expect(store.isGroupChecked('g')).toBe(true);
    store.applyChanges({ [LOCAL.groups('7')]: { newValue: { g: group(['a', 'b', 'c']) } } }, 'local'); // a new channel appeared
    expect(store.isGroupChecked('g')).toBe(false);
    store.applyChanges({ [LOCAL.groups('7')]: { newValue: undefined } }, 'local'); // groups were dropped
    expect(store.isGroupChecked('g')).toBe(false);
  });

  it('a malformed groups value does no harm', async () => {
    const store = await storeWith(['a'], { g: group('a'), h: 5 });
    expect(store.isGroupChecked('g')).toBe(false);
    expect(store.isGroupChecked('h')).toBe(false);
  });
});

describe('ContentStore.setGroupChecked: the icon follows the answer, then the storage', () => {
  async function loaded(now: () => number = () => 0): Promise<ContentStore> {
    installChrome({ [LOCAL.lastAccount]: { id: '7' }, [LOCAL.queue('7')]: [], [LOCAL.groups('7')]: { g: group(['a', 'b']) } });
    const store = new ContentStore(now);
    await store.load();
    return store;
  }

  it('the answer is applied at once, before any storage event, and tells once', async () => {
    const store = await loaded();
    const events: StoreEvent[] = [];
    store.on((event) => events.push(event));
    store.setGroupChecked('g', true);
    expect(store.isGroupChecked('g')).toBe(true);
    expect(events).toEqual(['groups']);
    store.setGroupChecked('g', false);
    expect(store.isGroupChecked('g')).toBe(false);
  });

  it('it works for a group the storage knows nothing about (the worker records it with the answer)', async () => {
    const store = await loaded();
    store.setGroupChecked('unknown', true);
    expect(store.isGroupChecked('unknown')).toBe(true);
  });

  it('then the storage takes over: when it says the same, the answer is dropped, and later changes show', async () => {
    const store = await loaded();
    store.setGroupChecked('g', true);
    store.applyChanges({ [LOCAL.queue('7')]: { newValue: [{ key: 'a' }] } }, 'local'); // only the queue arrived yet: still the answer
    expect(store.isGroupChecked('g')).toBe(true);
    store.applyChanges({ [LOCAL.queue('7')]: { newValue: [{ key: 'a' }, { key: 'b' }] } }, 'local'); // the storage caught up
    expect(store.isGroupChecked('g')).toBe(true);
    store.applyChanges({ [LOCAL.queue('7')]: { newValue: [{ key: 'a' }] } }, 'local'); // somebody removed one: no stale answer left
    expect(store.isGroupChecked('g')).toBe(false);
  });

  it('a removal answer is dropped the same way', async () => {
    installChrome({ [LOCAL.lastAccount]: { id: '7' }, [LOCAL.queue('7')]: [{ key: 'a' }, { key: 'b' }], [LOCAL.groups('7')]: { g: group(['a', 'b']) } });
    const store = new ContentStore();
    await store.load();
    store.setGroupChecked('g', false);
    expect(store.isGroupChecked('g')).toBe(false);
    store.applyChanges({ [LOCAL.queue('7')]: { newValue: [] } }, 'local');
    expect(store.isGroupChecked('g')).toBe(false);
    store.applyChanges({ [LOCAL.queue('7')]: { newValue: [{ key: 'a' }, { key: 'b' }] } }, 'local'); // added again elsewhere
    expect(store.isGroupChecked('g')).toBe(true);
  });

  it('an answer the storage never confirms gives way after a few seconds (the storage is the truth)', async () => {
    let now = 1_000;
    const store = await loaded(() => now);
    store.setGroupChecked('g', true);
    now += 9_999;
    expect(store.isGroupChecked('g')).toBe(true);
    now += 1;
    expect(store.isGroupChecked('g')).toBe(false); // the queue is still empty
  });

  it('the timer of an answer the storage never confirms drops it and tells the listeners, with nothing else happening', async () => {
    vi.useFakeTimers();
    const store = await loaded(() => Date.now());
    const events: StoreEvent[] = [];
    store.setGroupChecked('g', true);
    store.on((event) => events.push(event));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual(['groups']); // the buttons read the storage again now
    expect(store.isGroupChecked('g')).toBe(false); // the queue is still empty: the storage is the truth
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toEqual(['groups']); // once
  });

  it('the timer does not fire for an answer the storage already confirmed, and a newer answer gets its own full time', async () => {
    vi.useFakeTimers();
    const store = await loaded(() => Date.now());
    const events: StoreEvent[] = [];
    store.setGroupChecked('g', true);
    store.applyChanges({ [LOCAL.queue('7')]: { newValue: [{ key: 'a' }, { key: 'b' }] } }, 'local'); // the storage caught up
    expect(vi.getTimerCount()).toBe(0);
    store.setGroupChecked('g', false); // the storage says checked: this answer disagrees and waits for its timer
    await vi.advanceTimersByTimeAsync(6_000);
    store.setGroupChecked('g', false); // a newer answer restarts the clock
    store.on((event) => events.push(event));
    await vi.advanceTimersByTimeAsync(9_999); // 16 s after the first one: its timer is gone
    expect(events).toEqual([]);
    expect(store.isGroupChecked('g')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual(['groups']);
    expect(store.isGroupChecked('g')).toBe(true); // the storage is the truth again
  });

  it('dispose and an account switch cancel the timers', async () => {
    vi.useFakeTimers();
    const mock = installChrome({ [LOCAL.lastAccount]: { id: '7' }, [LOCAL.queue('7')]: [], [LOCAL.queue('8')]: [] });
    const store = new ContentStore();
    await store.load();
    store.setGroupChecked('g', true);
    store.setGroupChecked('h', true);
    expect(vi.getTimerCount()).toBe(2);
    mock.storage.set(LOCAL.lastAccount, { id: '8' });
    store.applyChanges({ [LOCAL.lastAccount]: { newValue: { id: '8' } } }, 'local');
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    store.setGroupChecked('g', true);
    expect(vi.getTimerCount()).toBe(1);
    store.dispose();
    expect(vi.getTimerCount()).toBe(0);
    store.setGroupChecked('g', true); // a disposed store starts nothing
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an account switch drops it', async () => {
    const mock = installChrome({ [LOCAL.lastAccount]: { id: '7' }, [LOCAL.queue('7')]: [], [LOCAL.queue('8')]: [] });
    const store = new ContentStore();
    await store.load();
    store.setGroupChecked('g', true);
    mock.storage.set(LOCAL.lastAccount, { id: '8' });
    store.applyChanges({ [LOCAL.lastAccount]: { newValue: { id: '8' } } }, 'local');
    await settle();
    expect(store.isGroupChecked('g')).toBe(false);
  });
});
