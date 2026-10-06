/**
 * Group settings and the download jobs (5th change, docs/PLAN.md §3, §5.5, §6.3, §6.7):
 *  - `job/start` fixes the settings of every item at the start with `resolveEffectiveSettings`: the item's own settings, else
 *    its category's, else its server's, else the common settings; the `EngineJob` itself keeps its shape (items carry the result);
 *  - `history/rerun` keeps using the settings of the history entry;
 *  - an item the engine finished (`engine/itemDone`, status done) leaves the list, and the settings of a server or category that
 *    has no queued channel left leave with it.
 * The engine is played by the test through `engine.io`. The world is in groupWorld.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL, SESSION } from '@/shared';
import type { ExportSettings, GroupInfo, JobState, QueueItem } from '@/shared';
import { createFakeBrowser } from './fakeChrome';
import type { FakeBrowser, FakePage } from './fakeChrome';
import { CAT_A, CAT_B, CAT_X, CH, GROUPS, GROUP_SETTINGS, ITEMS, OTHER_GUILD, S, group, item, target } from './groupWorld';
import type { Name } from './groupWorld';
import {
  ACCOUNT_ID,
  GUILD_ID,
  OTHER_ACCOUNT_ID,
  bootLoggedIn,
  dmTarget,
  exportSettings,
  guildTarget,
  historyEntry,
  installEngine,
  queueItem,
  scriptedEngine,
  seedConsent,
  startJobWith,
  storedQueue,
  waitFor,
} from './helpers';
import type { EngineHarness, ScriptedEngine } from './helpers';

let fake: FakeBrowser;
let popup: FakePage;
let engine: ScriptedEngine;
let harness: EngineHarness;

const COMMON = exportSettings({ count: 5, format: 'json', htmlTheme: 'light' });
const THIRD_GUILD = '200000000000000003';
/** A channel of a server nobody has settings for. */
const ELSEWHERE = guildTarget('430000000000000009', { guildId: THIRD_GUILD, guildName: 'Third Server', channelName: 'elsewhere', parentId: '300000000000000031' });

beforeEach(async () => {
  fake = createFakeBrowser();
  ({ popup } = await bootLoggedIn(fake));
  engine = scriptedEngine();
  harness = installEngine(fake, { runner: engine.runner });
  seedConsent(fake, { language: 'en', common: COMMON });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function seedWorld(options: { items?: QueueItem[]; groups?: Record<string, GroupInfo>; groupSettings?: Record<string, ExportSettings>; accountId?: string } = {}): void {
  const accountId = options.accountId ?? ACCOUNT_ID;
  fake.local.seed({
    [LOCAL.queue(accountId)]: options.items ?? ITEMS,
    [LOCAL.groups(accountId)]: options.groups ?? GROUPS,
    [LOCAL.groupSettings(accountId)]: options.groupSettings ?? GROUP_SETTINGS,
  });
}

const storedJob = () => fake.session.peek<JobState>(SESSION.job) as JobState;
const storedSettings = (accountId = ACCOUNT_ID) => fake.local.peek<Record<string, ExportSettings>>(LOCAL.groupSettings(accountId));
const without = (settings: Record<string, ExportSettings>, ...ids: string[]) => Object.fromEntries(Object.entries(settings).filter(([id]) => !ids.includes(id)));
/** The settings the engine was given, by channel id. */
const given = (jobIndex = 0): Record<string, ExportSettings> => Object.fromEntries(engine.jobs[jobIndex].items.map((entry) => [entry.key, entry.settings]));

// ---- the settings of every item at job start --------------------------------------------------------------------------------------

describe('job/start: the effective settings of every item (item > category > server > common)', () => {
  it('each of the four sources, and a DM, in one job', async () => {
    seedWorld({
      items: [
        item('a1', { settings: S.own(1) }), // its own settings
        item('a2'), // category A's settings
        item('b1'), // category B has none: the server's settings
        item('loose'), // no category: the server's settings
        queueItem(ELSEWHERE), // a server without settings: the common settings
        queueItem(dmTarget()), // a DM: the common settings
      ],
      groupSettings: without(GROUP_SETTINGS, CAT_B),
    });
    await startJobWith(popup, engine);
    expect(given()).toEqual({
      [CH.a1]: S.own(1),
      [CH.a2]: S.catA,
      [CH.b1]: S.guild,
      [CH.loose]: S.guild,
      [ELSEWHERE.channelId]: COMMON,
      [dmTarget().channelId]: COMMON,
    });
  });

  it.each([
    [false, false, false, 'common'],
    [false, false, true, 'server'],
    [false, true, false, 'category'],
    [false, true, true, 'category'],
    [true, false, false, 'item'],
    [true, false, true, 'item'],
    [true, true, false, 'item'],
    [true, true, true, 'item'],
  ])('own settings: %s, category settings: %s, server settings: %s -> the %s settings', async (hasOwn, hasCategory, hasServer, expected) => {
    const levels = { item: S.own(1), category: S.catA, server: S.guild, common: COMMON };
    seedWorld({
      items: [item('a1', { settings: hasOwn ? levels.item : null })],
      groupSettings: { ...(hasCategory ? { [CAT_A]: S.catA } : {}), ...(hasServer ? { [GUILD_ID]: S.guild } : {}) },
    });
    await startJobWith(popup, engine);
    expect(engine.jobs[0].items[0].settings).toEqual(levels[expected as keyof typeof levels]);
  });

  it('a DM never gets a group\'s settings, whatever the group settings contain', async () => {
    seedWorld({ items: [queueItem(dmTarget(), { settings: null }), queueItem(dmTarget('500000000000000002', { kind: 'group-dm', channelName: 'Friends' }), { settings: null })], groupSettings: GROUP_SETTINGS });
    await startJobWith(popup, engine);
    expect(engine.jobs[0].items.map((entry) => entry.settings)).toEqual([COMMON, COMMON]);
  });

  it('a DM keeps its own settings', async () => {
    seedWorld({ items: [queueItem(dmTarget(), { settings: S.own(5) })] });
    await startJobWith(popup, engine);
    expect(engine.jobs[0].items[0].settings).toEqual(S.own(5));
  });

  it('a thread sits under no category (its parentId is a channel): it gets the server\'s settings, not a category\'s', async () => {
    seedWorld({ items: [item('thread')] });
    await startJobWith(popup, engine);
    expect(engine.jobs[0].items[0].settings).toEqual(S.guild);

    await engine.io!.finished(engine.jobs[0].jobId, 'done');
    engine.finish();
    await waitFor(() => storedJob()?.state === 'done');
    seedWorld({ items: [item('thread')], groupSettings: { [CAT_A]: S.catA } }); // only the category the thread's parent channel is in
    await startJobWith(popup, engine);
    expect(engine.jobs[1].items[0].settings).toEqual(COMMON);
  });

  it('a forum or an announcement channel is a channel of its category like any other', async () => {
    const forum = guildTarget('430000000000000011', { kind: 'forum', channelName: 'questions', channelType: 15, parentId: CAT_B });
    seedWorld({ items: [queueItem(forum)] });
    await startJobWith(popup, engine);
    expect(engine.jobs[0].items[0].settings).toEqual(S.catB);
  });

  it('the category comes from the recorded groups, and from the target\'s parentId when the groups do not know the channel', async () => {
    seedWorld({ items: [item('a2')], groups: {} });
    await startJobWith(popup, engine);
    expect(engine.jobs[0].items[0].settings).toEqual(S.catA);
  });

  it('the recorded groups win over the target: a channel moved to another category follows the new one', async () => {
    seedWorld({
      items: [item('a2')], // its target still says category A
      groups: { ...GROUPS, [CAT_A]: group('category', GUILD_ID, [CH.a1]), [CAT_B]: group('category', GUILD_ID, [CH.b1, CH.a2]) },
    });
    await startJobWith(popup, engine);
    expect(engine.jobs[0].items[0].settings).toEqual(S.catB);
  });

  it('only the asked keys are run, each with its own effective settings', async () => {
    seedWorld();
    await startJobWith(popup, engine, [CH.x1, CH.a2, CH.loose]);
    expect(engine.jobs[0].items.map((entry) => entry.key)).toEqual([CH.loose, CH.a2, CH.x1]); // the order of the list
    expect(given()).toEqual({ [CH.loose]: S.guild, [CH.a2]: S.catA, [CH.x1]: S.own(4) });
  });

  it('group settings of another account and invalid entries of this one are not used', async () => {
    seedWorld({ items: [item('a2'), item('loose')] });
    fake.local.seed({
      [LOCAL.groupSettings(OTHER_ACCOUNT_ID)]: { [GUILD_ID]: S.fresh, [CAT_A]: S.fresh },
      [LOCAL.groupSettings(ACCOUNT_ID)]: { [CAT_A]: { count: 5 }, [GUILD_ID]: 'junk', abc: S.fresh }, // incomplete, not an object, not an id
    });
    await startJobWith(popup, engine);
    expect(given()).toEqual({ [CH.a2]: COMMON, [CH.loose]: COMMON });
  });

  it('a job start changes nothing in the list, the groups or the group settings', async () => {
    seedWorld();
    const before = fake.local.dump();
    await startJobWith(popup, engine);
    const after = fake.local.dump();
    for (const key of [LOCAL.queue(ACCOUNT_ID), LOCAL.groups(ACCOUNT_ID), LOCAL.groupSettings(ACCOUNT_ID)]) expect(after[key]).toEqual(before[key]);
  });
});

// ---- the engine job keeps its shape ---------------------------------------------------------------------------------------------

describe('job/start: the EngineJob is unchanged', () => {
  it('has the same fields as before, and its items carry only key, target and the resolved settings', async () => {
    seedWorld();
    await startJobWith(popup, engine);
    const job = engine.jobs[0];
    expect(Object.keys(job).sort()).toEqual(['accountId', 'authorization', 'items', 'jobId', 'lastExported', 'locale', 'settings', 'timeZone']);
    for (const entry of job.items) expect(Object.keys(entry).sort()).toEqual(['key', 'settings', 'target']);
    expect(job.settings.common).toEqual(COMMON);
    expect(JSON.stringify(job)).not.toContain('groupSettings');
  });

  it('the targets are the items\' targets, untouched by the settings of their groups', async () => {
    seedWorld();
    await startJobWith(popup, engine);
    expect(engine.jobs[0].items.map((entry) => entry.target)).toEqual(ITEMS.map((stored) => stored.target));
  });
});

describe('job/start: the settings are fixed at the start', () => {
  it('changing a group\'s settings or the common settings afterwards does not reach the running job; the next job sees them', async () => {
    seedWorld({ items: [item('a2'), item('b1'), item('loose')] });
    await startJobWith(popup, engine);
    const before = given();
    expect(before).toEqual({ [CH.a2]: S.catA, [CH.b1]: S.catB, [CH.loose]: S.guild });
    expect(storedJob().items.map((entry) => entry.expected)).toEqual([11, 12, 22]);

    await popup.send({ to: 'bg', type: 'queue/setGroupSettings', kind: 'guild', guildId: GUILD_ID, groupId: GUILD_ID, settings: S.fresh });
    await popup.send({ to: 'bg', type: 'settings/patch', patch: { common: exportSettings({ count: 9 }) } });
    expect(given()).toEqual(before);
    expect(storedJob().items.map((entry) => entry.expected)).toEqual([11, 12, 22]);

    await engine.io!.finished(engine.jobs[0].jobId, 'done');
    engine.finish();
    await waitFor(() => storedJob()?.state === 'done');
    await startJobWith(popup, engine);
    expect(given(1)).toEqual({ [CH.a2]: S.fresh, [CH.b1]: S.fresh, [CH.loose]: S.fresh });
  });
});

// ---- history/rerun --------------------------------------------------------------------------------------------------------------

describe('history/rerun keeps the settings of the history entry', () => {
  it('not the group\'s settings, not the common ones; the run is never incremental', async () => {
    const own = exportSettings({ count: 50, format: 'md', includeAttachments: true, incremental: true });
    seedWorld({ items: [item('a2')] });
    fake.local.seed({ [LOCAL.history(ACCOUNT_ID)]: [historyEntry(target('a2'), { id: 'h-a2', settings: own })] });
    const response = (await popup.send({ to: 'bg', type: 'history/rerun', id: 'h-a2' })) as { ok: boolean };
    expect(response.ok).toBe(true);
    await waitFor(() => engine.jobs.length === 1);
    expect(engine.jobs[0].items).toEqual([{ key: CH.a2, target: target('a2'), settings: { ...own, incremental: false } }]);
    // and it leaves the list and the group settings alone
    expect(storedQueue(fake)).toEqual([item('a2')]);
    expect(storedSettings()).toEqual(GROUP_SETTINGS);
  });

  it('a DM entry works the same', async () => {
    fake.local.seed({ [LOCAL.history(ACCOUNT_ID)]: [historyEntry(dmTarget(), { id: 'h-dm', settings: S.own(3) })] });
    await popup.send({ to: 'bg', type: 'history/rerun', id: 'h-dm' });
    await waitFor(() => engine.jobs.length === 1);
    expect(engine.jobs[0].items[0].settings).toEqual(S.own(3));
  });
});

// ---- finished items --------------------------------------------------------------------------------------------------------------

describe('engine/itemDone: a finished item takes the settings of an emptied group with it', () => {
  const five = (): QueueItem[] => [item('loose'), item('a1'), item('a2'), item('b1'), item('x1')];
  let jobId: string;
  const done = (name: Name, overrides: Parameters<typeof historyEntry>[1] = {}) => engine.io!.itemDone(jobId, historyEntry(target(name), { id: `entry-${name}`, ...overrides }), '900000000000000050');

  beforeEach(async () => {
    seedWorld({ items: five() });
    jobId = await startJobWith(popup, engine);
    expect(engine.jobs[0].items).toHaveLength(5);
  });

  it('a done item leaves the list; its groups keep their settings while another channel of theirs is queued', async () => {
    await done('a1');
    expect(storedQueue(fake).map((stored) => stored.key)).toEqual([CH.loose, CH.a2, CH.b1, CH.x1]);
    expect(storedSettings()).toEqual(GROUP_SETTINGS); // category A still has a2, the server has more
  });

  it('the last done channel of a category takes the category\'s settings with it; the server\'s and the others stay', async () => {
    await done('a1');
    await done('a2');
    expect(storedSettings()).toEqual(without(GROUP_SETTINGS, CAT_A));
  });

  it('the last done channel of a server takes the server\'s settings and those of its categories with it', async () => {
    await done('loose');
    await done('a1');
    await done('a2');
    await done('b1');
    expect(storedSettings()).toEqual({ [OTHER_GUILD]: S.otherGuild, [CAT_X]: S.catX });
    await done('x1');
    expect(storedSettings()).toEqual({});
    expect(storedQueue(fake)).toEqual([]);
  });

  it('is ONE storage write holding the queue, the history, the marker and the group settings', async () => {
    fake.local.set.mockClear();
    await done('x1');
    const written = fake.local.set.mock.calls.map(([items]) => Object.keys(items as object).sort());
    expect(written).toEqual([[LOCAL.groupSettings(ACCOUNT_ID), LOCAL.history(ACCOUNT_ID), LOCAL.lastExported(ACCOUNT_ID), LOCAL.queue(ACCOUNT_ID)].sort()]);
  });

  it('a partial, a failed or a cancelled item stays in the list, and so do its group\'s settings', async () => {
    await done('a1');
    await done('a2', { status: 'partial', error: 'rate limited' });
    await done('b1', { status: 'failed', error: 'no access' });
    await done('x1', { status: 'failed', error: 'no access' });
    expect(storedQueue(fake).map((stored) => stored.key)).toEqual([CH.loose, CH.a2, CH.b1, CH.x1]);
    expect(storedSettings()).toEqual(GROUP_SETTINGS);
    await done('a2'); // the retry succeeds: now category A is empty
    expect(storedSettings()).toEqual(without(GROUP_SETTINGS, CAT_A));
  });

  it('what a finished item leaves behind does not come back: a channel added to the emptied group follows the common settings again', async () => {
    await done('x1');
    expect(storedSettings()?.[OTHER_GUILD]).toBeUndefined();
    await engine.io!.finished(jobId, 'done');
    engine.finish();
    await waitFor(() => storedJob()?.state === 'done');
    await popup.send({ to: 'bg', type: 'queue/toggle', target: target('x1') });
    await startJobWith(popup, engine, [CH.x1]);
    expect(engine.jobs[1].items[0].settings).toEqual(COMMON);
  });

  it('a job started from the history leaves the list and the group settings alone, also when its item is done', async () => {
    await engine.io!.finished(jobId, 'done');
    engine.finish();
    await waitFor(() => storedJob()?.state === 'done');
    fake.local.seed({ [LOCAL.history(ACCOUNT_ID)]: [historyEntry(target('x1'), { id: 'h-x1', settings: S.own(4) })] });
    await popup.send({ to: 'bg', type: 'history/rerun', id: 'h-x1' });
    await waitFor(() => engine.jobs.length === 2);
    await engine.io!.itemDone(engine.jobs[1].jobId, historyEntry(target('x1'), { id: 'h-x1-again', settings: S.own(4) }), '900000000000000060');
    expect(storedQueue(fake).map((stored) => stored.key)).toEqual(five().map((stored) => stored.key));
    expect(storedSettings()).toEqual(GROUP_SETTINGS);
  });
});
