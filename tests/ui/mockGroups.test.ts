import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXPORT_SETTINGS, LOCAL, SESSION, type ExportSettings, type GroupInfo, type JobState, type QueueItem } from '@/shared';
import { MOCK_ACCOUNT, MOCK_CATEGORIES, MOCK_GUILDS, MOCK_SCENARIOS, TREE_TARGETS, createMockPlatform, type MockPlatform } from '@/ui/platform/mock';

/*
 * The 5th change in the fake background worker (docs/PLAN.md §5.3, §7.2a): queue/setGroupSettings, queue/removeMany, the
 * pruning of emptied groups on every path that takes chats out of the list, effective settings by group, and the sample
 * scenarios of the queue tree.
 */

const ACCOUNT = MOCK_ACCOUNT.id;
const queueOf = (platform: MockPlatform): QueueItem[] => (platform.read('local', LOCAL.queue(ACCOUNT)) as QueueItem[] | undefined) ?? [];
const settingsOf = (platform: MockPlatform): Record<string, ExportSettings> => (platform.read('local', LOCAL.groupSettings(ACCOUNT)) as Record<string, ExportSettings> | undefined) ?? {};
const groupsOf = (platform: MockPlatform): Record<string, GroupInfo> => (platform.read('local', LOCAL.groups(ACCOUNT)) as Record<string, GroupInfo> | undefined) ?? {};
const jobOf = (platform: MockPlatform): JobState | null => (platform.read('session', SESSION.job) as JobState | null | undefined) ?? null;
const keyOf = (target: { channelId: string }): string => target.channelId;
const itemOf = (platform: MockPlatform, key: string): QueueItem | undefined => queueOf(platform).find((item) => item.key === key);

const withCount = (count: number): ExportSettings => ({ ...DEFAULT_EXPORT_SETTINGS, content: { ...DEFAULT_EXPORT_SETTINGS.content }, count });
const T = TREE_TARGETS;
const S1 = MOCK_GUILDS.sample.id;
const S2 = MOCK_GUILDS.study.id;
const S3 = MOCK_GUILDS.book.id;

describe('the sample scenarios of the queue tree', () => {
  it('every scenario builds, "tree" is one of them', () => {
    expect(MOCK_SCENARIOS).toContain('tree');
    for (const scenario of MOCK_SCENARIOS) createMockPlatform({ scenario }).dispose();
  });

  it('risk: the 12 chats of the tree, one that reads every message and one with 25,000 messages and threads', () => {
    expect(MOCK_SCENARIOS).toContain('risk');
    const now = (): number => 1_800_000_000_000; // the same clock: the groups carry the time they were recorded
    const tree = createMockPlatform({ scenario: 'tree', now });
    const risk = createMockPlatform({ scenario: 'risk', now });
    expect(queueOf(risk)).toHaveLength(12);
    expect(queueOf(risk).map((item) => item.key)).toEqual(queueOf(tree).map((item) => item.key));
    expect(itemOf(risk, keyOf(T.reading))?.settings).toMatchObject({ count: null, from: null });
    expect(itemOf(risk, keyOf(T.questions))?.settings).toMatchObject({ count: 25_000, includeThreads: true });
    // the groups and the settings of the groups are the tree's
    expect(groupsOf(risk)).toEqual(groupsOf(tree));
    expect(settingsOf(risk)).toEqual(settingsOf(tree));
  });

  it('tree: servers, categories, an uncategorised channel, a complete category, a one-chat server, a server with settings, a DM, overrides', () => {
    const platform = createMockPlatform({ scenario: 'tree' });
    const queue = queueOf(platform);
    const groups = groupsOf(platform);
    const keys = queue.map((item) => item.key);

    // three servers
    expect(new Set(queue.map((item) => item.target.guildId).filter((id) => id !== null))).toEqual(new Set([S1, S2, S3]));
    // a DM
    expect(queue.filter((item) => item.target.kind === 'dm')).toHaveLength(1);
    // an uncategorised channel and a thread under the first server
    expect(itemOf(platform, keyOf(T.welcome))?.target.parentId).toBeNull();
    expect(itemOf(platform, keyOf(T.weekend))?.target.kind).toBe('thread');
    // a complete category (every viewable channel of it is queued), a partial one, a single-channel one
    const complete = (id: string): boolean => groups[id].channelIds.every((channelId) => keys.includes(channelId));
    expect(complete(MOCK_CATEGORIES.study.id)).toBe(true);
    expect(complete(MOCK_CATEGORIES.courses.id)).toBe(true);
    expect(complete(MOCK_CATEGORIES.lounge.id)).toBe(false);
    expect(groups[MOCK_CATEGORIES.archive.id].channelIds).toHaveLength(1);
    // a server with one queued chat that is not the whole server (it compresses), and the other servers are not that either
    expect(queue.filter((item) => item.target.guildId === S3)).toHaveLength(1);
    expect(complete(S3)).toBe(false);
    // the server with settings of its own, and a few channels with settings of their own
    expect(Object.keys(settingsOf(platform))).toEqual([S2]);
    expect(queue.filter((item) => item.settings !== null).map((item) => item.key)).toEqual([keyOf(T.questions), keyOf(T.math)]);
    // an icon on the first server only, from the Discord CDN
    expect(groups[S1].iconUrl).toMatch(/^https:\/\/cdn\.discordapp\.com\//);
    expect(groups[S2].iconUrl ?? null).toBeNull();
    // every group is told by name
    for (const group of Object.values(groups)) expect(group.name).toEqual(expect.any(String));
  });

  it('running: the groups of the sample servers are recorded, so a group line can aggregate the progress of the chats inside', () => {
    const platform = createMockPlatform({ scenario: 'running' });
    const groups = groupsOf(platform);
    expect(Object.keys(groups).sort()).toEqual([S1, S2].sort());
    expect(groups[S1].kind).toBe('guild');
    const inJob = new Set(jobOf(platform)?.items.map((row) => row.key));
    const sameServer = queueOf(platform).filter((item) => item.target.guildId === S1 && inJob.has(item.key));
    expect(sameServer.length).toBeGreaterThanOrEqual(2);
  });

  it('the other scenarios have no group information (the "unknown group info" case)', () => {
    for (const scenario of ['idle', 'empty', 'consent'] as const) expect(groupsOf(createMockPlatform({ scenario }))).toEqual({});
  });
});

describe('setStorage: the one write of the popup itself', () => {
  it('stores the open groups and tells the listeners', async () => {
    const platform = createMockPlatform();
    const seen: string[] = [];
    platform.onStorageChanged((_area, changes) => seen.push(...Object.keys(changes)));
    await platform.setStorage('local', { [LOCAL.uiExpanded]: [S1, MOCK_CATEGORIES.study.id] });
    expect(platform.read('local', LOCAL.uiExpanded)).toEqual([S1, MOCK_CATEGORIES.study.id]);
    expect((await platform.getStorage('local', [LOCAL.uiExpanded]))[LOCAL.uiExpanded]).toEqual([S1, MOCK_CATEGORIES.study.id]);
    await Promise.resolve();
    expect(seen).toEqual([LOCAL.uiExpanded]);
  });

  it('refuses every other key before anything is written', async () => {
    const platform = createMockPlatform();
    await expect(platform.setStorage('local', { [LOCAL.settings]: {} })).rejects.toThrow(/dce\.settings/);
    await expect(platform.setStorage('local', { [LOCAL.queue(ACCOUNT)]: [] })).rejects.toThrow();
    await expect(platform.setStorage('local', { [LOCAL.uiExpanded]: [], [LOCAL.groupSettings(ACCOUNT)]: {} })).rejects.toThrow();
    await expect(platform.setStorage('session', { [LOCAL.uiExpanded]: [] })).rejects.toThrow();
    await expect(platform.setStorage('session', { [SESSION.token]: 'x' })).rejects.toThrow();
    expect(platform.read('local', LOCAL.uiExpanded)).toBeUndefined();
  });
});

describe('queue/setGroupSettings', () => {
  const settings = withCount(9);

  it('a server: stores the settings, clears the own settings of its chats and the settings of its categories, answers with how many', async () => {
    const platform = createMockPlatform({ scenario: 'tree' });
    const before = queueOf(platform).length;
    platform.write('local', { [LOCAL.groupSettings(ACCOUNT)]: { ...settingsOf(platform), [MOCK_CATEGORIES.study.id]: withCount(3), [MOCK_CATEGORIES.lounge.id]: withCount(4) } });
    const response = await platform.sendMessage({ to: 'bg', type: 'queue/setGroupSettings', kind: 'guild', guildId: S1, groupId: S1, settings });
    // one chat of the server has its own settings (questions) + two category settings
    expect(response).toEqual({ ok: true, data: { cleared: 3 } });
    expect(settingsOf(platform)[S1]).toEqual(settings);
    expect(settingsOf(platform)[MOCK_CATEGORIES.study.id]).toBeUndefined();
    expect(settingsOf(platform)[MOCK_CATEGORIES.lounge.id]).toBeUndefined();
    expect(itemOf(platform, keyOf(T.questions))?.settings).toBeNull();
    // another server is left alone: its settings and its chat's own settings
    expect(settingsOf(platform)[S2]).toBeDefined();
    expect(itemOf(platform, keyOf(T.math))?.settings).not.toBeNull();
    // everything else of the queue is as it was
    expect(queueOf(platform)).toHaveLength(before); // nothing was added or removed
  });

  it('a server without anything to clear answers 0', async () => {
    const platform = createMockPlatform({ scenario: 'tree' });
    expect(await platform.sendMessage({ to: 'bg', type: 'queue/setGroupSettings', kind: 'guild', guildId: S3, groupId: S3, settings })).toEqual({ ok: true, data: { cleared: 0 } });
    expect(settingsOf(platform)[S3]).toEqual(settings);
  });

  it('a category: clears the own settings of the chats in it only, keeps the settings of the server and of the other chats', async () => {
    const platform = createMockPlatform({ scenario: 'tree' });
    const response = await platform.sendMessage({ to: 'bg', type: 'queue/setGroupSettings', kind: 'category', guildId: S1, groupId: MOCK_CATEGORIES.study.id, settings });
    expect(response).toEqual({ ok: true, data: { cleared: 1 } }); // questions
    expect(settingsOf(platform)[MOCK_CATEGORIES.study.id]).toEqual(settings);
    expect(settingsOf(platform)[S2]).toBeDefined();
    expect(itemOf(platform, keyOf(T.questions))?.settings).toBeNull();
    expect(itemOf(platform, keyOf(T.math))?.settings).not.toBeNull(); // another server's chat
  });

  it('the stored settings are complete and independent of the message', async () => {
    const platform = createMockPlatform({ scenario: 'tree' });
    const partial = { count: 11, format: 'md' } as unknown as ExportSettings;
    await platform.sendMessage({ to: 'bg', type: 'queue/setGroupSettings', kind: 'guild', guildId: S3, groupId: S3, settings: partial });
    expect(settingsOf(platform)[S3]).toEqual({ ...DEFAULT_EXPORT_SETTINGS, count: 11, format: 'md', content: { ...DEFAULT_EXPORT_SETTINGS.content } });
  });

  it('settings null takes the group\'s own settings away and leaves the chats\' own settings alone', async () => {
    const platform = createMockPlatform({ scenario: 'tree' });
    const response = await platform.sendMessage({ to: 'bg', type: 'queue/setGroupSettings', kind: 'guild', guildId: S2, groupId: S2, settings: null });
    expect(response).toEqual({ ok: true, data: { cleared: 0 } });
    expect(settingsOf(platform)[S2]).toBeUndefined();
    expect(itemOf(platform, keyOf(T.math))?.settings).not.toBeNull();
  });

  it('settings null on a group that has none is fine', async () => {
    const platform = createMockPlatform({ scenario: 'tree' });
    expect(await platform.sendMessage({ to: 'bg', type: 'queue/setGroupSettings', kind: 'category', guildId: S1, groupId: MOCK_CATEGORIES.study.id, settings: null })).toEqual({ ok: true, data: { cleared: 0 } });
  });

  it('refuses a group without a queued chat ("empty"), and a request that makes no sense ("invalid")', async () => {
    const platform = createMockPlatform({ scenario: 'tree' });
    const send = (message: Record<string, unknown>) => platform.sendMessage({ to: 'bg', type: 'queue/setGroupSettings', ...message } as never);
    expect(await send({ kind: 'guild', guildId: 'nope', groupId: 'nope', settings })).toEqual({ ok: false, error: 'empty' });
    expect(await send({ kind: 'category', guildId: S1, groupId: 'nope', settings })).toEqual({ ok: false, error: 'empty' });
    expect(await send({ kind: 'category', guildId: S2, groupId: MOCK_CATEGORIES.study.id, settings })).toEqual({ ok: false, error: 'empty' }); // that category is in another server
    expect(await send({ kind: 'guild', guildId: 'nope', groupId: 'nope', settings: null })).toEqual({ ok: false, error: 'empty' });
    expect(await send({ kind: 'planet', guildId: S1, groupId: S1, settings })).toEqual({ ok: false, error: 'invalid' });
    expect(await send({ kind: 'guild', guildId: '', groupId: S1, settings })).toEqual({ ok: false, error: 'invalid' });
    expect(await send({ kind: 'guild', guildId: S1, groupId: '', settings })).toEqual({ ok: false, error: 'invalid' });
    expect(await send({ kind: 'guild', guildId: S1, groupId: S1, settings: 'loud' })).toEqual({ ok: false, error: 'invalid' });
    expect(await send({ kind: 'guild', guildId: S1, groupId: S1, settings: [1] })).toEqual({ ok: false, error: 'invalid' });
    expect(settingsOf(platform)[S1]).toBeUndefined();
  });

  it('without an account it is refused like every queue message', async () => {
    const platform = createMockPlatform({ scenario: 'no-discord' });
    platform.write('local', { [LOCAL.lastAccount]: undefined });
    expect(await platform.sendMessage({ to: 'bg', type: 'queue/setGroupSettings', kind: 'guild', guildId: S1, groupId: S1, settings })).toEqual({ ok: false, error: 'no-account' });
  });

  it('notifies the listeners of the queue and the group settings (one write)', async () => {
    const platform = createMockPlatform({ scenario: 'tree' });
    const seen: string[][] = [];
    platform.onStorageChanged((_area, changes) => seen.push(Object.keys(changes)));
    await platform.sendMessage({ to: 'bg', type: 'queue/setGroupSettings', kind: 'guild', guildId: S1, groupId: S1, settings });
    await Promise.resolve();
    expect(seen).toEqual([[LOCAL.queue(ACCOUNT), LOCAL.groupSettings(ACCOUNT)]]);
  });
});

describe('queue/removeMany and the pruning of emptied groups', () => {
  it('removes the keys, answers with how many were really in the list, ignores unknown keys', async () => {
    const platform = createMockPlatform({ scenario: 'tree' });
    const before = queueOf(platform).length;
    const keys = [keyOf(T.welcome), keyOf(T.general), 'unknown'];
    expect(await platform.sendMessage({ to: 'bg', type: 'queue/removeMany', keys })).toEqual({ ok: true, data: { removed: 2 } });
    expect(queueOf(platform)).toHaveLength(before - 2);
    expect(await platform.sendMessage({ to: 'bg', type: 'queue/removeMany', keys: [] })).toEqual({ ok: true, data: { removed: 0 } });
    expect(await platform.sendMessage({ to: 'bg', type: 'queue/removeMany', keys: ['unknown'] })).toEqual({ ok: true, data: { removed: 0 } });
  });

  it('refuses keys that are not strings, and a missing account', async () => {
    const platform = createMockPlatform({ scenario: 'tree' });
    expect(await platform.sendMessage({ to: 'bg', type: 'queue/removeMany', keys: [1] as unknown as string[] })).toEqual({ ok: false, error: 'invalid' });
    expect(await platform.sendMessage({ to: 'bg', type: 'queue/removeMany', keys: 'all' as unknown as string[] })).toEqual({ ok: false, error: 'invalid' });
    const none = createMockPlatform({ scenario: 'no-discord' });
    none.write('local', { [LOCAL.lastAccount]: undefined });
    expect(await none.sendMessage({ to: 'bg', type: 'queue/removeMany', keys: ['1'] })).toEqual({ ok: false, error: 'no-account' });
  });

  it('a group that has no queued chat left loses its settings (so they do not come back with the next chat)', async () => {
    const platform = createMockPlatform({ scenario: 'tree' });
    platform.write('local', { [LOCAL.groupSettings(ACCOUNT)]: { ...settingsOf(platform), [MOCK_CATEGORIES.courses.id]: withCount(4) } });
    const inStudyGroup = queueOf(platform).filter((item) => item.target.guildId === S2).map((item) => item.key);
    await platform.sendMessage({ to: 'bg', type: 'queue/removeMany', keys: inStudyGroup });
    expect(settingsOf(platform)).toEqual({}); // the server's and the category's
  });

  it('a group that still has a chat keeps its settings', async () => {
    const platform = createMockPlatform({ scenario: 'tree' });
    await platform.sendMessage({ to: 'bg', type: 'queue/removeMany', keys: [keyOf(T.announcements), keyOf(T.math)] });
    expect(settingsOf(platform)[S2]).toBeDefined(); // physics is still there
  });

  it('every other way out of the list prunes too: queue/remove, queue/clear, queue/toggle and a finished download', async () => {
    const remove = createMockPlatform({ scenario: 'tree' });
    for (const key of queueOf(remove).filter((item) => item.target.guildId === S2).map((item) => item.key)) await remove.sendMessage({ to: 'bg', type: 'queue/remove', key });
    expect(settingsOf(remove)).toEqual({});

    const clear = createMockPlatform({ scenario: 'tree' });
    await clear.sendMessage({ to: 'bg', type: 'queue/clear' });
    expect(settingsOf(clear)).toEqual({});

    const toggle = createMockPlatform({ scenario: 'tree' });
    for (const key of queueOf(toggle).filter((item) => item.target.guildId === S2).map((item) => item.key)) {
      const item = itemOf(toggle, key)!;
      await toggle.sendMessage({ to: 'bg', type: 'queue/toggle', target: item.target });
    }
    expect(settingsOf(toggle)).toEqual({});
  });

  it('a download that finishes takes its chat out of the list and prunes the group', async () => {
    vi.useFakeTimers();
    try {
      const platform = createMockPlatform({ scenario: 'tree', autoRun: true });
      const keys = queueOf(platform).filter((item) => item.target.guildId === S2).map((item) => item.key);
      await platform.sendMessage({ to: 'bg', type: 'job/start', keys });
      await vi.advanceTimersByTimeAsync(700 * 60);
      expect(jobOf(platform)?.state).toBe('done');
      expect(queueOf(platform).filter((item) => item.target.guildId === S2)).toEqual([]);
      expect(settingsOf(platform)[S2]).toBeUndefined();
      platform.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('job/start uses the effective settings (item > category > server > common)', () => {
  it('the expected count of a chat follows its server\'s settings, its category\'s, or its own', async () => {
    const platform = createMockPlatform({ scenario: 'tree' });
    platform.write('local', { [LOCAL.groupSettings(ACCOUNT)]: { ...settingsOf(platform), [MOCK_CATEGORIES.courses.id]: withCount(33) } });
    await platform.sendMessage({ to: 'bg', type: 'job/start', keys: [keyOf(T.announcements), keyOf(T.math), keyOf(T.physics), keyOf(T.welcome)] });
    const expected = Object.fromEntries(jobOf(platform)!.items.map((row) => [row.key, row.expected]));
    expect(expected[keyOf(T.announcements)]).toBe(50); // the server's settings (no category)
    expect(expected[keyOf(T.math)]).toBe(20); // its own
    expect(expected[keyOf(T.physics)]).toBe(33); // its category's settings win over the server's
    expect(expected[keyOf(T.welcome)]).toBe(200); // the common settings
  });

  it('the history entry of a finished chat records the effective settings', async () => {
    vi.useFakeTimers();
    try {
      const platform = createMockPlatform({ scenario: 'tree', autoRun: true });
      await platform.sendMessage({ to: 'bg', type: 'job/start', keys: [keyOf(T.announcements)] });
      await vi.advanceTimersByTimeAsync(700 * 20);
      const history = platform.read('local', LOCAL.history(ACCOUNT)) as Array<{ target: { channelId: string }; settings: ExportSettings }>;
      expect(history[0].target.channelId).toBe(keyOf(T.announcements));
      expect(history[0].settings).toMatchObject({ count: 50, format: 'md' });
      platform.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
