import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXPORT_SETTINGS, LOCAL, SESSION, type HistoryEntry, type JobState, type QueueItem, type StatusSnapshot } from '@/shared';
import { MOCK_ACCOUNT, MOCK_SCENARIOS, MOCK_TARGETS, createMockPlatform, sampleOwnSettings, type MockPlatform, type MockScenario } from '@/ui/platform/mock';
import type { StorageArea, StorageChanges } from '@/ui/platform/types';

const ACCOUNT = MOCK_ACCOUNT.id;
const queueOf = (platform: MockPlatform): QueueItem[] => (platform.read('local', LOCAL.queue(ACCOUNT)) as QueueItem[] | undefined) ?? [];
const historyOf = (platform: MockPlatform): HistoryEntry[] => (platform.read('local', LOCAL.history(ACCOUNT)) as HistoryEntry[] | undefined) ?? [];
const jobOf = (platform: MockPlatform): JobState | null => (platform.read('session', SESSION.job) as JobState | null | undefined) ?? null;
const status = async (platform: MockPlatform): Promise<StatusSnapshot> => {
  const response = await platform.sendMessage({ to: 'bg', type: 'status/get' });
  if (!response.ok) throw new Error('status/get failed');
  return response.data;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('scenarios (neutral sample data only)', () => {
  it('every scenario builds', async () => {
    for (const scenario of MOCK_SCENARIOS) {
      const platform = createMockPlatform({ scenario });
      expect((await status(platform)).discordTabs, scenario).toBeGreaterThanOrEqual(0);
      platform.dispose();
    }
  });

  it('idle: a list with an item that has settings of its own and a failed one, a history, no job', async () => {
    const platform = createMockPlatform({ scenario: 'idle' });
    const snapshot = await status(platform);
    expect(snapshot.account).toMatchObject({ username: 'sample_user', globalName: 'Sample User' });
    expect(snapshot.job).toBeNull();
    const queue = queueOf(platform);
    expect(queue.length).toBeGreaterThanOrEqual(4);
    expect(queue.filter((item) => item.settings !== null)).toHaveLength(1);
    expect(queue.some((item) => item.lastResult?.status === 'failed')).toBe(true);
    expect(historyOf(platform).map((entry) => entry.status)).toEqual(['done', 'partial', 'failed']);
    expect(platform.read('local', LOCAL.settings)).toMatchObject({ consentAt: expect.any(Number) });
  });

  it('running: a job in progress whose items are the list', async () => {
    const platform = createMockPlatform({ scenario: 'running' });
    const job = (await status(platform)).job!;
    expect(job.state).toBe('running');
    expect(job.items.map((item) => item.status)).toEqual(['done', 'running', 'waiting', 'waiting']);
    expect(job.items[1]).toMatchObject({ phase: 'messages', fetched: 120, expected: 200 });
  });

  it('consent: no consent given yet', () => {
    expect(createMockPlatform({ scenario: 'consent' }).read('local', LOCAL.settings)).toMatchObject({ consentAt: null });
  });

  it('no-discord / checking: no account, with or without a Discord tab', async () => {
    const none = await status(createMockPlatform({ scenario: 'no-discord' }));
    expect(none).toMatchObject({ account: null, discordTabs: 0 });
    expect(none.lastAccount).not.toBeNull();
    expect(await status(createMockPlatform({ scenario: 'checking' }))).toMatchObject({ account: null, discordTabs: 1 });
  });

  it('unhealthy: the buttons could not be added', async () => {
    expect((await status(createMockPlatform({ scenario: 'unhealthy' }))).health).toMatchObject({ ok: false, reason: expect.any(String) });
  });

  it('uses neutral names only: every name in the sample data is one of a short allow-list, and the ids are made up', () => {
    const NEUTRAL = new Set([
      'Sample Server',
      'Study Group',
      'Book Club',
      'Sample User',
      'sample_user',
      'Alex',
      'general',
      'announcements',
      'questions',
      'weekend plans',
      // the queue tree (5th change): channels and the categories they sit in
      'welcome',
      'rules',
      'resources',
      'chat',
      'music',
      'old-news',
      'math',
      'physics',
      'reading',
      'reviews',
      'Study',
      'Lounge',
      'Archive',
      'Courses',
      'Books',
    ]);
    const names = new Set<string>();
    const ids = new Set<string>();
    for (const scenario of MOCK_SCENARIOS) {
      const platform = createMockPlatform({ scenario });
      const queue = (platform.read('local', LOCAL.queue(ACCOUNT)) ?? []) as QueueItem[];
      const history = (platform.read('local', LOCAL.history(ACCOUNT)) ?? []) as HistoryEntry[];
      for (const { target } of [...queue, ...history]) {
        for (const name of [target.guildName, target.channelName, target.parentName]) if (typeof name === 'string') names.add(name);
        ids.add(target.channelId);
        if (target.guildId !== null) ids.add(target.guildId);
      }
      const account = platform.read('local', LOCAL.lastAccount) as { id: string; username: string; globalName: string | null };
      names.add(account.username);
      if (account.globalName !== null) names.add(account.globalName);
      ids.add(account.id);
    }
    expect([...names].filter((name) => !NEUTRAL.has(name))).toEqual([]);
    // made-up ids: 1000000000000000NN (account), 2000... (servers), 3000... (chats)
    for (const id of ids) expect(id).toMatch(/^[123]0{12}\d{5}$/);
  });
});

describe('the fake chrome.storage', () => {
  it('refuses to read the authentication keys', async () => {
    const platform = createMockPlatform();
    await expect(platform.getStorage('session', [SESSION.token])).rejects.toThrow();
    await expect(platform.getStorage('session', [SESSION.tokenCapturedAt])).rejects.toThrow();
    await expect(platform.getStorage('local', [LOCAL.classCache])).rejects.toThrow();
  });

  it('hands out copies: changing a result never changes what is stored', async () => {
    const platform = createMockPlatform();
    const first = await platform.getStorage('local', [LOCAL.queue(ACCOUNT)]);
    (first[LOCAL.queue(ACCOUNT)] as QueueItem[]).length = 0;
    expect(queueOf(platform).length).toBeGreaterThan(0);
    const settings = platform.read('local', LOCAL.settings) as { common: { count: number } };
    settings.common.count = 1;
    expect((platform.read('local', LOCAL.settings) as { common: { count: number } }).common.count).toBe(200);
  });

  it('only returns the keys that exist', async () => {
    const platform = createMockPlatform();
    expect(await platform.getStorage('local', [LOCAL.settings, LOCAL.history('999')])).toEqual({ [LOCAL.settings]: expect.any(Object) });
  });

  it('notifies listeners of a write (asynchronously, with old and new value) until they unsubscribe', async () => {
    const platform = createMockPlatform();
    const seen: Array<[StorageArea, StorageChanges]> = [];
    const stop = platform.onStorageChanged((area, changes) => seen.push([area, changes]));
    platform.write('session', { [SESSION.job]: null });
    expect(seen).toHaveLength(0); // like chrome.storage: after the call returned
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe('session');
    expect(seen[0][1][SESSION.job]).toMatchObject({ newValue: null });
    stop();
    platform.write('session', { [SESSION.job]: null });
    await Promise.resolve();
    expect(seen).toHaveLength(1);
  });

  it('a write of undefined removes the key', async () => {
    const platform = createMockPlatform();
    platform.write('local', { [LOCAL.theme]: undefined });
    expect(platform.read('local', LOCAL.theme)).toBeUndefined();
  });

  it('listeners never see the keys the popup may not read', async () => {
    const platform = createMockPlatform();
    const seen: string[] = [];
    platform.onStorageChanged((_area, changes) => seen.push(...Object.keys(changes)));
    platform.write('session', { [SESSION.token]: 'secret', [SESSION.tokenCapturedAt]: 1 });
    await Promise.resolve();
    expect(seen).toEqual([]);
  });
});

describe('the fake background worker: every message of docs/PLAN.md §5.3', () => {
  it('settings/patch merges, replaces `common` as a whole, and notifies', async () => {
    const platform = createMockPlatform();
    const seen: string[] = [];
    platform.onStorageChanged((_area, changes) => seen.push(...Object.keys(changes)));
    const own = { ...DEFAULT_EXPORT_SETTINGS, content: { ...DEFAULT_EXPORT_SETTINGS.content }, count: 5, format: 'csv' as const };
    expect(await platform.sendMessage({ to: 'bg', type: 'settings/patch', patch: { common: own, zipAll: true } })).toEqual({ ok: true, data: undefined });
    expect(platform.read('local', LOCAL.settings)).toMatchObject({ common: own, zipAll: true, showButtons: true });
    await Promise.resolve();
    expect(seen).toContain(LOCAL.settings);
  });

  it('queue/upsert replaces an item in place or appends a new one; queue/remove and queue/clear', async () => {
    const platform = createMockPlatform({ scenario: 'idle' });
    const [first] = queueOf(platform);
    const before = queueOf(platform).length;
    await platform.sendMessage({ to: 'bg', type: 'queue/upsert', item: { ...first, settings: sampleOwnSettings() } });
    expect(queueOf(platform)).toHaveLength(before);
    expect(queueOf(platform)[0].settings).toEqual(sampleOwnSettings());
    await platform.sendMessage({ to: 'bg', type: 'queue/upsert', item: { key: '999', target: { ...first.target, channelId: '999' }, settings: null, addedAt: 1 } });
    expect(queueOf(platform)).toHaveLength(before + 1);
    await platform.sendMessage({ to: 'bg', type: 'queue/remove', key: '999' });
    expect(queueOf(platform)).toHaveLength(before);
    await platform.sendMessage({ to: 'bg', type: 'queue/clear' });
    expect(queueOf(platform)).toEqual([]);
  });

  it('queue/toggle adds with settings null, and removes on the second call (what the content script does)', async () => {
    const platform = createMockPlatform({ scenario: 'empty' });
    expect(await platform.sendMessage({ to: 'bg', type: 'queue/toggle', target: MOCK_TARGETS.general })).toEqual({ ok: true, data: { queued: true } });
    expect(queueOf(platform)).toMatchObject([{ key: MOCK_TARGETS.general.channelId, settings: null }]);
    expect(await platform.sendMessage({ to: 'bg', type: 'queue/toggle', target: MOCK_TARGETS.general })).toEqual({ ok: true, data: { queued: false } });
    expect(queueOf(platform)).toEqual([]);
  });

  it('queue messages without an account are refused', async () => {
    const platform = createMockPlatform({ scenario: 'no-discord' });
    platform.write('local', { [LOCAL.lastAccount]: undefined });
    expect(await platform.sendMessage({ to: 'bg', type: 'queue/clear' })).toEqual({ ok: false, error: 'no-account' });
  });

  describe('job/start', () => {
    it('starts every item of the list ("all") or the ones with the given keys', async () => {
      const platform = createMockPlatform({ scenario: 'idle' });
      const keys = queueOf(platform).map((item) => item.key);
      const response = await platform.sendMessage({ to: 'bg', type: 'job/start', keys: [keys[1], keys[0], 'unknown'] });
      expect(response.ok).toBe(true);
      expect(jobOf(platform)?.items.map((item) => item.key)).toEqual(keys.slice(0, 2)); // the order of the list, unknown keys ignored
      const platform2 = createMockPlatform({ scenario: 'idle' });
      await platform2.sendMessage({ to: 'bg', type: 'job/start', keys: 'all' });
      expect(jobOf(platform2)?.items).toHaveLength(keys.length);
    });

    it('answers with the job id and a running job whose items wait', async () => {
      const platform = createMockPlatform({ scenario: 'idle' });
      const response = await platform.sendMessage({ to: 'bg', type: 'job/start', keys: 'all' });
      expect(response).toMatchObject({ ok: true, data: { jobId: expect.any(String) } });
      expect(jobOf(platform)).toMatchObject({ state: 'running', accountId: ACCOUNT, finishedAt: null, zip: false });
      expect(jobOf(platform)?.items.every((item) => item.status === 'waiting')).toBe(true);
    });

    it('the expected count of an item is its EFFECTIVE count (own settings, else the common ones)', async () => {
      const platform = createMockPlatform({ scenario: 'idle' });
      await platform.sendMessage({ to: 'bg', type: 'job/start', keys: 'all' });
      const items = jobOf(platform)!.items;
      expect(items[0].expected).toBe(200); // follows the common settings
      expect(items[1].expected).toBeNull(); // own settings: "전체"
    });

    it('zip is on for the "one ZIP" setting with more than one item', async () => {
      const platform = createMockPlatform({ scenario: 'idle' });
      await platform.sendMessage({ to: 'bg', type: 'settings/patch', patch: { zipAll: true } });
      await platform.sendMessage({ to: 'bg', type: 'job/start', keys: 'all' });
      expect(jobOf(platform)?.zip).toBe(true);
    });

    it('refuses: no account, no consent, a job already running, nothing to download', async () => {
      const noAccount = createMockPlatform({ scenario: 'no-discord' });
      expect(await noAccount.sendMessage({ to: 'bg', type: 'job/start', keys: 'all' })).toEqual({ ok: false, error: 'no-account' });
      const noConsent = createMockPlatform({ scenario: 'consent' });
      expect(await noConsent.sendMessage({ to: 'bg', type: 'job/start', keys: 'all' })).toEqual({ ok: false, error: 'no-consent' });
      const busy = createMockPlatform({ scenario: 'running' });
      expect(await busy.sendMessage({ to: 'bg', type: 'job/start', keys: 'all' })).toEqual({ ok: false, error: 'busy' });
      const empty = createMockPlatform({ scenario: 'empty' });
      expect(await empty.sendMessage({ to: 'bg', type: 'job/start', keys: 'all' })).toEqual({ ok: false, error: 'empty' });
      const unknownKey = createMockPlatform({ scenario: 'idle' });
      expect(await unknownKey.sendMessage({ to: 'bg', type: 'job/start', keys: ['nope'] })).toEqual({ ok: false, error: 'empty' });
    });
  });

  it('job/cancel stops the job: unfinished items become cancelled and keep a note in the list', async () => {
    const platform = createMockPlatform({ scenario: 'running' });
    expect(await platform.sendMessage({ to: 'bg', type: 'job/cancel' })).toEqual({ ok: true, data: undefined });
    const job = jobOf(platform)!;
    expect(job.state).toBe('cancelled');
    expect(job.finishedAt).not.toBeNull();
    expect(job.items.map((item) => item.status)).toEqual(['done', 'cancelled', 'cancelled', 'cancelled']);
    expect(queueOf(platform).filter((item) => item.lastResult?.status === 'cancelled').length).toBeGreaterThan(0);
    // another cancel with nothing running is fine
    expect(await platform.sendMessage({ to: 'bg', type: 'job/cancel' })).toEqual({ ok: true, data: undefined });
  });

  it('history/rerun starts a job for the entry, history/clear empties the history', async () => {
    const platform = createMockPlatform({ scenario: 'idle' });
    const [entry] = historyOf(platform);
    expect(await platform.sendMessage({ to: 'bg', type: 'history/rerun', id: entry.id })).toMatchObject({ ok: true, data: { jobId: expect.any(String) } });
    expect(jobOf(platform)?.items).toMatchObject([{ key: entry.target.channelId }]);
    expect(await platform.sendMessage({ to: 'bg', type: 'history/rerun', id: entry.id })).toEqual({ ok: false, error: 'busy' });
    await platform.sendMessage({ to: 'bg', type: 'history/clear' });
    expect(historyOf(platform)).toEqual([]);
    const other = createMockPlatform({ scenario: 'idle' });
    expect(await other.sendMessage({ to: 'bg', type: 'history/rerun', id: 'no-such-entry' })).toEqual({ ok: false, error: 'invalid' });
  });

  it('downloads/show, discord/open and inject/health are accepted; discord/open makes a tab known', async () => {
    const platform = createMockPlatform({ scenario: 'no-discord' });
    expect(await platform.sendMessage({ to: 'bg', type: 'downloads/show', downloadId: 3 })).toEqual({ ok: true, data: undefined });
    expect(await platform.sendMessage({ to: 'bg', type: 'downloads/show', downloadId: null })).toEqual({ ok: true, data: undefined });
    expect((await status(platform)).discordTabs).toBe(0);
    await platform.sendMessage({ to: 'bg', type: 'discord/open' });
    expect((await status(platform)).discordTabs).toBe(1);
    await platform.sendMessage({ to: 'bg', type: 'inject/health', health: { ok: false, reason: 'x', checkedAt: 1, url: 'u' } });
    expect((await status(platform)).health).toMatchObject({ ok: false, reason: 'x' });
  });

  it('queue/addCategory, queue/addGuild and queue/groupInfo are answered (the mock adds and removes nothing; 4th change: `removed` is part of the answer)', async () => {
    const platform = createMockPlatform();
    expect(await platform.sendMessage({ to: 'bg', type: 'queue/addCategory', guildId: '1', guildName: 'S', categoryId: '2', categoryName: 'C' })).toEqual({
      ok: true,
      data: { added: 0, skipped: 0, removed: 0 },
    });
    expect(await platform.sendMessage({ to: 'bg', type: 'queue/addGuild', guildId: '1', guildName: 'S' })).toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 0 } });
    expect(await platform.sendMessage({ to: 'bg', type: 'queue/groupInfo', guildId: '1', guildName: 'S' })).toEqual({ ok: true, data: undefined });
  });

  it('failNext answers the next message of that type with the error, once', async () => {
    const platform = createMockPlatform();
    platform.failNext('queue/clear', 'busy', 'try later');
    expect(await platform.sendMessage({ to: 'bg', type: 'queue/clear' })).toEqual({ ok: false, error: 'busy', message: 'try later' });
    expect(await platform.sendMessage({ to: 'bg', type: 'queue/clear' })).toEqual({ ok: true, data: undefined });
    expect(queueOf(platform)).toEqual([]); // the second one worked, the first did nothing
  });

  it('keeps a log of what was sent (a copy: later changes of the message do not rewrite it)', async () => {
    const platform = createMockPlatform();
    const message = { to: 'bg' as const, type: 'job/start' as const, keys: ['1'] };
    await platform.sendMessage(message);
    message.keys.push('2');
    expect(platform.sent).toEqual([{ to: 'bg', type: 'job/start', keys: ['1'] }]);
  });
});

describe('platform extras', () => {
  it('shortcuts, the UI language, and a settings page that opens nothing', async () => {
    const platform = createMockPlatform({ uiLanguage: 'en-US' });
    expect(platform.getUiLanguage()).toBe('en-US');
    expect(createMockPlatform().getUiLanguage()).toBe('ko');
    expect(await platform.getShortcuts()).toEqual([expect.objectContaining({ name: 'add-current-chat', shortcut: 'Alt+Shift+D' })]);
    platform.setShortcuts([{ name: 'add-current-chat', description: '', shortcut: '' }]);
    expect((await platform.getShortcuts())[0].shortcut).toBe('');
    await expect(platform.openShortcutSettings()).resolves.toBeUndefined();
  });

  it('load() replaces the data and tells the listeners about every changed key', async () => {
    const platform = createMockPlatform({ scenario: 'idle' });
    const seen: Array<[StorageArea, string[]]> = [];
    platform.onStorageChanged((area, changes) => seen.push([area, Object.keys(changes)]));
    platform.load('empty');
    await Promise.resolve();
    expect(queueOf(platform)).toEqual([]);
    expect(seen.some(([area, keys]) => area === 'local' && keys.includes(LOCAL.queue(ACCOUNT)))).toBe(true);
    platform.load('running' satisfies MockScenario);
    expect(jobOf(platform)?.state).toBe('running');
  });

  it('setDiscordTabs and setHealth change what status/get reports', async () => {
    const platform = createMockPlatform();
    platform.setDiscordTabs(3);
    platform.setHealth({ ok: false, reason: 'r', checkedAt: 5, url: 'u' });
    expect(await status(platform)).toMatchObject({ discordTabs: 3, health: { ok: false, reason: 'r' } });
    platform.setHealth(null);
    expect((await status(platform)).health).toBeNull();
  });
});

describe('simulated time (autoRun, used by the preview)', () => {
  it('a started download makes progress and finishes: items leave the list and enter the history', async () => {
    vi.useFakeTimers();
    const platform = createMockPlatform({ scenario: 'idle', autoRun: true });
    const keys = queueOf(platform).map((item) => item.key);
    const historyBefore = historyOf(platform).length;
    await platform.sendMessage({ to: 'bg', type: 'job/start', keys: [keys[0]] });
    expect(jobOf(platform)?.items[0].status).toBe('waiting');

    await vi.advanceTimersByTimeAsync(700);
    expect(jobOf(platform)?.items[0]).toMatchObject({ status: 'running', phase: 'messages', fetched: 0 });
    await vi.advanceTimersByTimeAsync(700);
    expect(jobOf(platform)?.items[0].fetched).toBe(50);

    await vi.advanceTimersByTimeAsync(700 * 20);
    const job = jobOf(platform)!;
    expect(job.state).toBe('done');
    expect(job.finishedAt).not.toBeNull();
    expect(job.items[0].status).toBe('done');
    expect(job.items[0].files).toHaveLength(1);
    expect(queueOf(platform).map((item) => item.key)).not.toContain(keys[0]);
    expect(historyOf(platform)).toHaveLength(historyBefore + 1);
    expect(historyOf(platform)[0]).toMatchObject({ status: 'done', messageCount: 200 });
    platform.dispose();
  });

  it('without autoRun nothing moves by itself', async () => {
    vi.useFakeTimers();
    const platform = createMockPlatform({ scenario: 'idle' });
    await platform.sendMessage({ to: 'bg', type: 'job/start', keys: 'all' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(jobOf(platform)?.items.every((item) => item.status === 'waiting')).toBe(true);
  });

  it('the running scenario keeps going on its own', async () => {
    vi.useFakeTimers();
    const platform = createMockPlatform({ scenario: 'running', autoRun: true });
    await vi.advanceTimersByTimeAsync(700);
    expect(jobOf(platform)?.items[1].fetched).toBe(170);
    platform.dispose();
  });

  it('dispose stops the timers', async () => {
    vi.useFakeTimers();
    const platform = createMockPlatform({ scenario: 'running', autoRun: true });
    platform.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(jobOf(platform)?.items[1].fetched).toBe(120);
  });

  it('opening Discord finds the account a moment later', async () => {
    vi.useFakeTimers();
    const platform = createMockPlatform({ scenario: 'no-discord', autoRun: true });
    await platform.sendMessage({ to: 'bg', type: 'discord/open' });
    expect((await status(platform)).account).toBeNull();
    await vi.advanceTimersByTimeAsync(1600);
    expect((await status(platform)).account).toMatchObject({ username: 'sample_user' });
    platform.dispose();
  });
});
