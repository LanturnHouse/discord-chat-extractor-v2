/**
 * Group settings (5th change, docs/PLAN.md §2, §5.3, §5.5, §7.2a): `queue/setGroupSettings` (the popup's gear on a server or
 * category row), `queue/removeMany` (the ✕ of a group row) and the pruning that keeps `LOCAL.groupSettings(accountId)` from outliving
 * the channels of its groups on every path that takes an item out of the list. The settings an item runs with at job start are in
 * jobs.groupSettings.test.ts; who may send the two messages is in router.test.ts. Fixtures use neutral names and made-up ids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL, resolveEffectiveSettings } from '@/shared';
import type { ExportSettings, GroupInfo, QueueItem } from '@/shared';
import { createFakeBrowser } from './fakeChrome';
import type { FakeBrowser, FakePage } from './fakeChrome';
import { CAT_A, CAT_B, CAT_X, CH, GROUPS, GROUP_SETTINGS, ITEMS, OTHER_GUILD, S, group, item, target } from './groupWorld';
import type { Name } from './groupWorld';
import {
  ACCOUNT_ID,
  GUILD_ID,
  OTHER_ACCOUNT_ID,
  TOKEN,
  bootLoggedIn,
  bootWorker,
  dmTarget,
  exportSettings,
  guildTarget,
  installFakeDiscordApi,
  queueItem,
  seedGuildAccess,
  settle,
  storedQueue,
} from './helpers';
import type { FakeDiscordApi } from './helpers';

let fake: FakeBrowser;
let popup: FakePage;
let content: FakePage;
let api: FakeDiscordApi;

beforeEach(async () => {
  fake = createFakeBrowser();
  ({ popup, api } = await bootLoggedIn(fake));
  content = fake.createContentScript(7, `https://discord.com/channels/${GUILD_ID}/430000000000000002`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---- helpers (the world itself is in groupWorld.ts) ---------------------------------------------------------------------------------


function seedWorld(options: { items?: QueueItem[]; groups?: Record<string, GroupInfo>; groupSettings?: Record<string, ExportSettings>; accountId?: string } = {}): void {
  const accountId = options.accountId ?? ACCOUNT_ID;
  fake.local.seed({
    [LOCAL.queue(accountId)]: options.items ?? ITEMS,
    [LOCAL.groups(accountId)]: options.groups ?? GROUPS,
    [LOCAL.groupSettings(accountId)]: options.groupSettings ?? GROUP_SETTINGS,
  });
}

/** `items` with the `settings` of the listed channels replaced. */
const withSettings = (items: QueueItem[], changes: Record<string, ExportSettings | null>): QueueItem[] =>
  items.map((stored) => (stored.key in changes ? { ...stored, settings: changes[stored.key] } : stored));
const withoutKeys = (items: QueueItem[], ...keys: string[]): QueueItem[] => items.filter((stored) => !keys.includes(stored.key));
const without = (settings: Record<string, ExportSettings>, ...ids: string[]) => Object.fromEntries(Object.entries(settings).filter(([id]) => !ids.includes(id)));

const storedSettings = (accountId = ACCOUNT_ID) => fake.local.peek<Record<string, ExportSettings>>(LOCAL.groupSettings(accountId));
const keys = () => storedQueue(fake).map((stored) => stored.key);
/** What the last `chrome.storage.local.set` calls wrote, as lists of keys. */
const writes = () => fake.local.set.mock.calls.map(([written]) => Object.keys(written as Record<string, unknown>).sort());

const setServer = (settings: unknown, overrides: Record<string, unknown> = {}, from: FakePage = popup) =>
  from.send({ to: 'bg', type: 'queue/setGroupSettings', kind: 'guild', guildId: GUILD_ID, groupId: GUILD_ID, settings, ...overrides });
const setCategory = (groupId: string, settings: unknown, overrides: Record<string, unknown> = {}, from: FakePage = popup) =>
  from.send({ to: 'bg', type: 'queue/setGroupSettings', kind: 'category', guildId: GUILD_ID, groupId, settings, ...overrides });
const removeMany = (keysToRemove: unknown, from: FakePage = popup) => from.send({ to: 'bg', type: 'queue/removeMany', keys: keysToRemove });
const remove = (key: string, from: FakePage = popup) => from.send({ to: 'bg', type: 'queue/remove', key });
const toggle = (name: Name, from: FakePage = content) => from.send({ to: 'bg', type: 'queue/toggle', target: target(name) });

// ---- queue/setGroupSettings: a server -------------------------------------------------------------------------------------------

describe('queue/setGroupSettings: a server', () => {
  it('stores the settings, gives the server\'s channels back to them (their own settings go) and deletes the settings of the server\'s categories', async () => {
    seedWorld();
    // overrides cleared: a1, b1 and the thread (3); category settings deleted: A and B (2)
    await expect(setServer(S.fresh)).resolves.toEqual({ ok: true, data: { cleared: 5 } });
    expect(storedSettings()).toEqual({ [GUILD_ID]: S.fresh, [OTHER_GUILD]: S.otherGuild, [CAT_X]: S.catX });
    expect(storedQueue(fake)).toEqual(withSettings(ITEMS, { [CH.a1]: null, [CH.b1]: null, [CH.thread]: null }));
  });

  it('touches nothing outside the server: the other server\'s channels and group settings, and a DM', async () => {
    seedWorld();
    await setServer(S.fresh);
    const stored = storedQueue(fake);
    expect(stored.find((candidate) => candidate.key === CH.x1)?.settings).toEqual(S.own(4));
    expect(stored.find((candidate) => candidate.target.kind === 'dm')?.settings).toEqual(S.own(5));
    expect(storedSettings()?.[OTHER_GUILD]).toEqual(S.otherGuild);
    expect(storedSettings()?.[CAT_X]).toEqual(S.catX);
  });

  it('changes only the settings of the items: key, target, order, addedAt and lastResult stay', async () => {
    seedWorld();
    await setServer(S.fresh);
    const after = storedQueue(fake);
    expect(after.map((stored) => stored.key)).toEqual(ITEMS.map((stored) => stored.key));
    for (const [index, stored] of after.entries()) expect({ ...stored, settings: null }).toEqual({ ...ITEMS[index], settings: null });
    expect(after[1].lastResult).toEqual({ status: 'failed', message: 'forbidden', at: 9 });
  });

  it('an item that follows the common settings stays that way (nothing to clear), and replacing the server\'s own settings is not counted', async () => {
    seedWorld({ items: [item('loose'), item('a2')] });
    await expect(setServer(S.fresh)).resolves.toEqual({ ok: true, data: { cleared: 2 } }); // only the two category settings
    expect(storedSettings()?.[GUILD_ID]).toEqual(S.fresh);
    await expect(setServer(S.own(9))).resolves.toEqual({ ok: true, data: { cleared: 0 } }); // the server's previous settings are replaced, not "cleared"
    expect(storedSettings()?.[GUILD_ID]).toEqual(S.own(9));
  });

  it('the category settings of the server go even when the groups record does not know the categories (the items name them)', async () => {
    seedWorld({ groups: {} });
    await expect(setServer(S.fresh)).resolves.toEqual({ ok: true, data: { cleared: 5 } });
    expect(storedSettings()).toEqual({ [GUILD_ID]: S.fresh, [OTHER_GUILD]: S.otherGuild, [CAT_X]: S.catX });
  });

  it('stores a copy that holds only the known fields', async () => {
    seedWorld();
    const message = { ...exportSettings({ count: 5 }), junk: 'x', content: { ...exportSettings().content, junk: 1 } };
    await expect(setServer(message)).resolves.toMatchObject({ ok: true });
    expect(storedSettings()?.[GUILD_ID]).toEqual(exportSettings({ count: 5 }));
  });

  it('is ONE storage write holding the queue and the group settings, and no write of the groups', async () => {
    seedWorld();
    fake.local.set.mockClear();
    await setServer(S.fresh);
    expect(writes()).toEqual([[LOCAL.groupSettings(ACCOUNT_ID), LOCAL.queue(ACCOUNT_ID)].sort()]);
  });

  it('writes nothing when nothing changes (the same settings again, no overrides below)', async () => {
    seedWorld({ items: [item('loose'), item('a2')], groupSettings: { [GUILD_ID]: S.fresh } });
    fake.local.set.mockClear();
    await expect(setServer(S.fresh)).resolves.toEqual({ ok: true, data: { cleared: 0 } });
    expect(fake.local.set).not.toHaveBeenCalled();
  });

  it('the settings of a server are always the server\'s: a thread (it sits under no category) is one of its channels', async () => {
    seedWorld({ items: [item('thread', { settings: S.own(3) })], groupSettings: {} });
    await expect(setServer(S.fresh)).resolves.toEqual({ ok: true, data: { cleared: 1 } });
    expect(storedQueue(fake)[0].settings).toBeNull();
  });

  it('works for the account of the session only: the other account\'s list and group settings are never touched', async () => {
    seedWorld();
    seedWorld({ accountId: OTHER_ACCOUNT_ID });
    await setServer(S.fresh);
    expect(storedQueue(fake, OTHER_ACCOUNT_ID)).toEqual(ITEMS);
    expect(storedSettings(OTHER_ACCOUNT_ID)).toEqual(GROUP_SETTINGS);
  });
});

// ---- queue/setGroupSettings: a category -----------------------------------------------------------------------------------------

describe('queue/setGroupSettings: a category', () => {
  it('stores the settings for the category and gives its channels back to them; everything else stays, the server\'s settings too', async () => {
    seedWorld();
    await expect(setCategory(CAT_A, S.fresh)).resolves.toEqual({ ok: true, data: { cleared: 1 } }); // a1 had its own
    expect(storedSettings()).toEqual({ ...GROUP_SETTINGS, [CAT_A]: S.fresh });
    expect(storedQueue(fake)).toEqual(withSettings(ITEMS, { [CH.a1]: null }));
  });

  it('is replaced when the category has settings already, and the count is only about overrides', async () => {
    seedWorld({ items: [item('a1', { settings: S.own(1) }), item('a2', { settings: S.own(2) }), item('b1', { settings: S.own(3) })] });
    await expect(setCategory(CAT_A, S.fresh)).resolves.toEqual({ ok: true, data: { cleared: 2 } });
    expect(storedSettings()?.[CAT_A]).toEqual(S.fresh);
    expect(storedQueue(fake).map((stored) => stored.settings)).toEqual([null, null, S.own(3)]);
  });

  it('the channels of other categories, loose channels and threads keep their settings', async () => {
    seedWorld();
    await setCategory(CAT_B, S.fresh);
    expect(storedQueue(fake)).toEqual(withSettings(ITEMS, { [CH.b1]: null }));
    expect(storedSettings()?.[CAT_A]).toEqual(S.catA);
    expect(storedSettings()?.[CAT_B]).toEqual(S.fresh);
  });

  it('a channel belongs to the category by the recorded groups, and by its target\'s parentId when the groups do not know it', async () => {
    seedWorld({ groups: {}, groupSettings: {} });
    await expect(setCategory(CAT_A, S.fresh)).resolves.toEqual({ ok: true, data: { cleared: 1 } });
    expect(storedQueue(fake)).toEqual(withSettings(ITEMS, { [CH.a1]: null }));
    expect(storedSettings()).toEqual({ [CAT_A]: S.fresh });
  });

  it('the recorded groups win over the target: a channel that moved to another category follows its new one', async () => {
    const moved = item('a1', { settings: S.own(1) }); // its target still says category A ...
    seedWorld({ items: [moved, item('b1')], groups: { ...GROUPS, [CAT_A]: group('category', GUILD_ID, []), [CAT_B]: group('category', GUILD_ID, [CH.b1, CH.a1]) } });
    await expect(setCategory(CAT_B, S.fresh)).resolves.toEqual({ ok: true, data: { cleared: 1 } }); // ... but the server says B
    expect(storedQueue(fake)[0].settings).toBeNull();
    await expect(setCategory(CAT_A, S.fresh)).resolves.toEqual({ ok: false, error: 'empty' }); // nobody is in A any more
  });

  it('a thread is not in a category (its parentId is a channel): a category\'s settings never reach it', async () => {
    seedWorld();
    await setCategory(CAT_A, S.fresh);
    expect(storedQueue(fake).find((stored) => stored.key === CH.thread)?.settings).toEqual(S.own(3));
  });

  it('is ONE storage write holding the queue and the group settings', async () => {
    seedWorld();
    fake.local.set.mockClear();
    await setCategory(CAT_A, S.fresh);
    expect(writes()).toEqual([[LOCAL.groupSettings(ACCOUNT_ID), LOCAL.queue(ACCOUNT_ID)].sort()]);
  });

  it('writes the settings alone when no item has settings of its own', async () => {
    seedWorld({ items: [item('a1'), item('a2')], groupSettings: {} });
    fake.local.set.mockClear();
    await expect(setCategory(CAT_A, S.fresh)).resolves.toEqual({ ok: true, data: { cleared: 0 } });
    expect(writes()).toEqual([[LOCAL.groupSettings(ACCOUNT_ID)]]);
  });
});

// ---- queue/setGroupSettings: settings null --------------------------------------------------------------------------------------

describe('queue/setGroupSettings: settings null (back to the level above)', () => {
  it('a server: takes only the server\'s own settings away; the overrides of the channels and the category settings stay', async () => {
    seedWorld();
    await expect(setServer(null)).resolves.toEqual({ ok: true, data: { cleared: 0 } });
    expect(storedSettings()).toEqual(without(GROUP_SETTINGS, GUILD_ID));
    expect(storedQueue(fake)).toEqual(ITEMS);
  });

  it('a category: takes only that category\'s settings away', async () => {
    seedWorld();
    await expect(setCategory(CAT_A, null)).resolves.toEqual({ ok: true, data: { cleared: 0 } });
    expect(storedSettings()).toEqual(without(GROUP_SETTINGS, CAT_A));
    expect(storedQueue(fake)).toEqual(ITEMS);
  });

  it('a group that has no settings: fine, nothing is written', async () => {
    seedWorld({ groupSettings: { [CAT_B]: S.catB } });
    fake.local.set.mockClear();
    await expect(setServer(null)).resolves.toEqual({ ok: true, data: { cleared: 0 } });
    await expect(setCategory(CAT_A, null)).resolves.toEqual({ ok: true, data: { cleared: 0 } });
    expect(fake.local.set).not.toHaveBeenCalled();
  });

  it('a group without a queued channel is not an error here: its leftover settings are cleaned up (with every other orphan)', async () => {
    seedWorld({ items: [item('loose')], groupSettings: { [GUILD_ID]: S.guild, [CAT_A]: S.catA, [OTHER_GUILD]: S.otherGuild } });
    await expect(setCategory(CAT_A, null)).resolves.toEqual({ ok: true, data: { cleared: 0 } });
    expect(storedSettings()).toEqual({ [GUILD_ID]: S.guild }); // category A and the other server have no channel left in the list
  });

  it('is ONE storage write holding only the group settings', async () => {
    seedWorld();
    fake.local.set.mockClear();
    await setServer(null);
    expect(writes()).toEqual([[LOCAL.groupSettings(ACCOUNT_ID)]]);
  });

  it('the settings set again after a revert start from nothing: the channels follow them, the old overrides are gone for good', async () => {
    seedWorld();
    await setServer(S.fresh);
    await setServer(null);
    expect(storedSettings()).toEqual({ [OTHER_GUILD]: S.otherGuild, [CAT_X]: S.catX });
    expect(storedQueue(fake).filter((stored) => stored.target.guildId === GUILD_ID).every((stored) => stored.settings === null)).toBe(true);
  });
});

// ---- queue/setGroupSettings: an empty group -------------------------------------------------------------------------------------

describe('queue/setGroupSettings: a group with no queued channel', () => {
  it.each([
    ['a server without any channel in the list', () => setServer(S.fresh, { guildId: '200000000000000009', groupId: '200000000000000009' })],
    ['a category without any channel in the list', () => setCategory('300000000000000099', S.fresh)],
  ])('%s: "empty", and nothing is written', async (_label, send) => {
    seedWorld();
    fake.local.set.mockClear();
    await expect(send()).resolves.toEqual({ ok: false, error: 'empty' });
    expect(fake.local.set).not.toHaveBeenCalled();
    expect(storedQueue(fake)).toEqual(ITEMS);
    expect(storedSettings()).toEqual(GROUP_SETTINGS);
  });

  it('an empty list: "empty" for a server and for a category', async () => {
    await expect(setServer(S.fresh)).resolves.toEqual({ ok: false, error: 'empty' });
    await expect(setCategory(CAT_A, S.fresh)).resolves.toEqual({ ok: false, error: 'empty' });
    expect(fake.local.has(LOCAL.groupSettings(ACCOUNT_ID))).toBe(false);
  });

  it('the channels of another server do not count', async () => {
    seedWorld({ items: [item('x1')] });
    await expect(setServer(S.fresh)).resolves.toEqual({ ok: false, error: 'empty' });
    await expect(setServer(S.fresh, { guildId: OTHER_GUILD, groupId: OTHER_GUILD })).resolves.toMatchObject({ ok: true });
  });

  it('a DM is in no group', async () => {
    seedWorld({ items: [queueItem(dmTarget(), { settings: S.own(5) })] });
    await expect(setServer(S.fresh)).resolves.toEqual({ ok: false, error: 'empty' });
    expect(storedQueue(fake)[0].settings).toEqual(S.own(5));
  });

  it('the category of a channel that is gone from the list is empty again', async () => {
    seedWorld({ items: [item('a1'), item('a2')] });
    await removeMany([CH.a1, CH.a2]);
    await expect(setCategory(CAT_A, S.fresh)).resolves.toEqual({ ok: false, error: 'empty' });
  });
});

// ---- queue/setGroupSettings: validation, accounts, concurrency ----------------------------------------------------------------

describe('queue/setGroupSettings: validation', () => {
  const settings = (overrides: Record<string, unknown>) => ({ ...exportSettings(), ...overrides });
  const content = (overrides: Record<string, unknown>) => ({ ...exportSettings().content, ...overrides });

  it.each([
    ['kind is missing', { kind: undefined }],
    ['kind is unknown', { kind: 'channel' }],
    ['kind is not a string', { kind: 5 }],
    ['guildId is missing', { guildId: undefined }],
    ['guildId is not numeric', { guildId: 'abc' }],
    ['guildId is a number', { guildId: 200000000000000001 }],
    ['guildId is empty', { guildId: '' }],
    ['groupId is missing', { groupId: undefined }],
    ['groupId is not numeric', { groupId: 'alpha' }],
    ['groupId is a number', { groupId: 300000000000000011 }],
    ['groupId tries to leave the object', { groupId: '1/../2' }],
    ['the groupId of a server is not its guildId', { kind: 'guild', groupId: CAT_A }],
    ['settings are missing', { settings: undefined }],
    ['settings are a string', { settings: 'dark' }],
    ['settings are an array', { settings: [] }],
    ['settings are incomplete', { settings: { count: 5 } }],
    ['the count is 0', { settings: settings({ count: 0 }) }],
    ['the count is negative', { settings: settings({ count: -3 }) }],
    ['the count is 1000001', { settings: settings({ count: 1_000_001 }) }],
    ['the count is a fraction', { settings: settings({ count: 2.5 }) }],
    ['the count is a string', { settings: settings({ count: '5' }) }],
    ['the count is missing', { settings: settings({ count: undefined }) }],
    ['from is not an ISO time', { settings: settings({ from: 'yesterday' }) }],
    ['to is not an ISO time', { settings: settings({ to: 5 }) }],
    ['from is after to', { settings: settings({ from: '2026-12-31T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }) }],
    ['the format is unknown', { settings: settings({ format: 'pdf' }) }],
    ['the HTML theme is unknown', { settings: settings({ htmlTheme: 'blue' }) }],
    ['includeAttachments is not a boolean', { settings: settings({ includeAttachments: 1 }) }],
    ['includeThreads is not a boolean', { settings: settings({ includeThreads: 'yes' }) }],
    ['incremental is not a boolean', { settings: settings({ incremental: null }) }],
    ['the content options are missing', { settings: settings({ content: undefined }) }],
    ['a content option is not a boolean', { settings: settings({ content: content({ includeEmbeds: 'no' }) }) }],
    ['a content option is missing', { settings: settings({ content: content({ includeBots: undefined }) }) }],
  ])('refuses the message when %s, and writes nothing', async (_label, overrides) => {
    seedWorld();
    fake.local.set.mockClear();
    const response = await popup.send({ to: 'bg', type: 'queue/setGroupSettings', kind: 'category', guildId: GUILD_ID, groupId: CAT_A, settings: exportSettings(), ...overrides });
    expect(response).toMatchObject({ ok: false, error: 'invalid' });
    expect(response.message).toEqual(expect.any(String));
    expect(fake.local.set).not.toHaveBeenCalled();
    expect(storedQueue(fake)).toEqual(ITEMS);
    expect(storedSettings()).toEqual(GROUP_SETTINGS);
  });

  it('accepts the edges: a count of 1, of 1000000 and null (all messages), a range, every format and theme', async () => {
    seedWorld();
    for (const count of [1, 1_000_000, null]) await expect(setServer(exportSettings({ count }))).resolves.toMatchObject({ ok: true });
    await expect(setServer(exportSettings({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }))).resolves.toMatchObject({ ok: true }); // from = to is fine
    for (const format of ['html', 'txt', 'md', 'xlsx', 'csv', 'json'] as const) await expect(setServer(exportSettings({ format, htmlTheme: 'light' }))).resolves.toMatchObject({ ok: true });
  });

  it('validates before it looks at the account or the list', async () => {
    const other = createFakeBrowser();
    installFakeDiscordApi();
    await bootWorker(other);
    await expect(other.createPage({ kind: 'popup' }).send({ to: 'bg', type: 'queue/setGroupSettings', kind: 'nope', guildId: GUILD_ID, groupId: GUILD_ID, settings: null })).resolves.toMatchObject({ ok: false, error: 'invalid' });
  });

  it('never stores or returns the authorization value', async () => {
    seedWorld();
    const responses = [await setServer(S.fresh), await setServer('x'), await setServer(null)];
    for (const response of responses) expect(JSON.stringify(response)).not.toContain(TOKEN);
    expect(JSON.stringify(fake.local.dump())).not.toContain(TOKEN);
  });
});

describe('queue/setGroupSettings: no account', () => {
  it('answers "no-account" and writes nothing while no account is verified', async () => {
    const other = createFakeBrowser();
    installFakeDiscordApi();
    await bootWorker(other);
    const page = other.createPage({ kind: 'popup' });
    other.local.seed({ [LOCAL.queue(ACCOUNT_ID)]: ITEMS, [LOCAL.groups(ACCOUNT_ID)]: GROUPS });
    other.local.set.mockClear();
    await expect(page.send({ to: 'bg', type: 'queue/setGroupSettings', kind: 'guild', guildId: GUILD_ID, groupId: GUILD_ID, settings: S.fresh })).resolves.toEqual({ ok: false, error: 'no-account' });
    await expect(page.send({ to: 'bg', type: 'queue/setGroupSettings', kind: 'guild', guildId: GUILD_ID, groupId: GUILD_ID, settings: null })).resolves.toEqual({ ok: false, error: 'no-account' });
    expect(other.local.set).not.toHaveBeenCalled();
    expect(other.local.has(LOCAL.groupSettings(ACCOUNT_ID))).toBe(false);
  });
});

describe('queue/setGroupSettings: at the same time as other writers of the list', () => {
  it('toggles and group settings arriving together: no toggle is lost, and no item below a stored server setting keeps an override', async () => {
    seedWorld();
    const ids = Array.from({ length: 24 }, (_, index) => String(440000000000000100n + BigInt(index)));
    const answers = [
      ...ids.slice(0, 8).map((id) => content.send({ to: 'bg', type: 'queue/toggle', target: guildTarget(id, { channelName: `row ${id}` }) })),
      setServer(S.fresh),
      ...ids.slice(8, 16).map((id) => content.send({ to: 'bg', type: 'queue/toggle', target: guildTarget(id, { channelName: `row ${id}` }) })),
      setServer(S.own(8)),
      ...ids.slice(16).map((id) => content.send({ to: 'bg', type: 'queue/toggle', target: guildTarget(id, { channelName: `row ${id}` }) })),
    ];
    for (const answer of await Promise.all(answers)) expect(answer).toMatchObject({ ok: true });
    expect(new Set(keys())).toEqual(new Set([...ITEMS.map((stored) => stored.key), ...ids]));
    expect(storedSettings()).toEqual({ ...without(GROUP_SETTINGS, GUILD_ID, CAT_A, CAT_B), [GUILD_ID]: S.own(8) }); // the later message wins; the categories' settings are gone
    const server = storedQueue(fake).filter((stored) => stored.target.guildId === GUILD_ID);
    expect(server).toHaveLength(5 + ids.length); // loose, a1, a2, b1, the thread, and the 24 rows
    expect(server.every((stored) => stored.settings === null)).toBe(true);
    expect(storedQueue(fake).find((stored) => stored.key === CH.x1)?.settings).toEqual(S.own(4));
  });

  it('a category\'s settings and the removal of its last channels at the same time: the settings never survive it (either order)', async () => {
    for (const order of ['set first', 'remove first'] as const) {
      seedWorld({ items: [item('a1'), item('a2'), item('b1')], groupSettings: { [GUILD_ID]: S.guild, [CAT_B]: S.catB } });
      const answers = order === 'set first' ? [setCategory(CAT_A, S.fresh), removeMany([CH.a1, CH.a2])] : [removeMany([CH.a1, CH.a2]), setCategory(CAT_A, S.fresh)];
      const [first, second] = await Promise.all(answers);
      if (order === 'set first') {
        expect(first).toEqual({ ok: true, data: { cleared: 0 } });
        expect(second).toEqual({ ok: true, data: { removed: 2 } });
      } else {
        expect(first).toEqual({ ok: true, data: { removed: 2 } });
        expect(second).toEqual({ ok: false, error: 'empty' });
      }
      expect(storedSettings()).toEqual({ [GUILD_ID]: S.guild, [CAT_B]: S.catB });
      expect(keys()).toEqual([CH.b1]);
    }
  });

  it('a gear on a channel and the gear on its server at the same time: the later one wins, in either order', async () => {
    const own = item('a1', { settings: S.own(7) });
    seedWorld({ items: [item('a1'), item('a2')], groupSettings: {} });
    // the channel's own settings first, then the server's: the server's settings take them away again
    await Promise.all([popup.send({ to: 'bg', type: 'queue/upsert', item: own }), setServer(S.fresh)]);
    expect(storedQueue(fake)[0].settings).toBeNull();
    expect(storedSettings()).toEqual({ [GUILD_ID]: S.fresh });
    // the server's settings first, then the channel's own: the channel keeps its override, the server keeps its settings
    await Promise.all([setServer(S.own(8)), popup.send({ to: 'bg', type: 'queue/upsert', item: own })]);
    expect(storedQueue(fake)[0].settings).toEqual(S.own(7));
    expect(storedSettings()).toEqual({ [GUILD_ID]: S.own(8) });
  });

  it('a category setting and a server setting at once: the later one decides what is left of the earlier one', async () => {
    seedWorld({ groupSettings: {} });
    // the category first: a1's own settings go (1); then the server: b1's and the thread's own settings (2) and the category's settings (1)
    const [category, guild] = await Promise.all([setCategory(CAT_A, S.catA), setServer(S.guild)]);
    expect(category).toEqual({ ok: true, data: { cleared: 1 } });
    expect(guild).toEqual({ ok: true, data: { cleared: 3 } });
    expect(storedSettings()).toEqual({ [GUILD_ID]: S.guild });

    // the server first: a1's, b1's and the thread's own settings (3); then the category has nothing left to clear
    seedWorld({ groupSettings: {} });
    const [guildFirst, categoryLater] = await Promise.all([setServer(S.guild), setCategory(CAT_A, S.catA)]);
    expect(guildFirst).toEqual({ ok: true, data: { cleared: 3 } });
    expect(categoryLater).toEqual({ ok: true, data: { cleared: 0 } });
    expect(storedSettings()).toEqual({ [GUILD_ID]: S.guild, [CAT_A]: S.catA });
  });
});

// ---- queue/removeMany -----------------------------------------------------------------------------------------------------------

describe('queue/removeMany', () => {
  it('removes the listed channels in one step, keeps the order of the others and answers how many it removed', async () => {
    seedWorld();
    await expect(removeMany([CH.a2, CH.loose, CH.thread])).resolves.toEqual({ ok: true, data: { removed: 3 } });
    expect(keys()).toEqual([CH.a1, CH.b1, CH.x1, ITEMS[6].key]);
    expect(storedQueue(fake)).toEqual(withoutKeys(ITEMS, CH.a2, CH.loose, CH.thread));
  });

  it('ignores keys that are not in the list and counts only what really left; duplicates count once', async () => {
    seedWorld({ groupSettings: {} });
    await expect(removeMany([CH.a1, '999999999999999999', CH.a1, CH.a1])).resolves.toEqual({ ok: true, data: { removed: 1 } });
    expect(keys()).not.toContain(CH.a1);
    await expect(removeMany(['999999999999999999'])).resolves.toEqual({ ok: true, data: { removed: 0 } });
  });

  it('an empty list of keys removes nothing and writes nothing', async () => {
    seedWorld();
    fake.local.set.mockClear();
    await expect(removeMany([])).resolves.toEqual({ ok: true, data: { removed: 0 } });
    expect(fake.local.set).not.toHaveBeenCalled();
  });

  it('can empty the list, and then no group setting is left either', async () => {
    seedWorld();
    await expect(removeMany(ITEMS.map((stored) => stored.key))).resolves.toEqual({ ok: true, data: { removed: ITEMS.length } });
    expect(storedQueue(fake)).toEqual([]);
    expect(storedSettings()).toEqual({});
  });

  it('works on the list of the current account only', async () => {
    seedWorld();
    seedWorld({ accountId: OTHER_ACCOUNT_ID });
    await removeMany([CH.a1]);
    expect(storedQueue(fake, OTHER_ACCOUNT_ID)).toEqual(ITEMS);
    expect(storedSettings(OTHER_ACCOUNT_ID)).toEqual(GROUP_SETTINGS);
  });

  it('accepts exactly 5000 keys and refuses 5001', async () => {
    seedWorld();
    const many = Array.from({ length: 5000 }, (_, index) => String(450000000000000000n + BigInt(index)));
    await expect(removeMany(many)).resolves.toEqual({ ok: true, data: { removed: 0 } });
    fake.local.set.mockClear();
    await expect(removeMany([...many, CH.a1])).resolves.toMatchObject({ ok: false, error: 'invalid' });
    expect(keys()).toContain(CH.a1);
    expect(fake.local.set).not.toHaveBeenCalled();
  });

  it.each([
    ['no keys', undefined],
    ['null', null],
    ['a string', CH.a1],
    ['a number', 5],
    ['an object', { 0: CH.a1, length: 1 }],
    ['a key that is not numeric', [CH.a1, 'abc']],
    ['a key that is a number', [430000000000000002]],
    ['a key that is null', [null]],
    ['an empty key', ['']],
    ['a nested array', [[CH.a1]]],
    ['a key of 21 digits', ['1'.repeat(21)]],
  ])('refuses %s, and removes nothing (not even the valid keys next to a bad one)', async (_label, keysToRemove) => {
    seedWorld();
    fake.local.set.mockClear();
    const response = await removeMany(keysToRemove);
    expect(response).toMatchObject({ ok: false, error: 'invalid' });
    expect(response.message).toEqual(expect.any(String));
    expect(fake.local.set).not.toHaveBeenCalled();
    expect(storedQueue(fake)).toEqual(ITEMS);
  });

  it('answers "no-account" without an account', async () => {
    const other = createFakeBrowser();
    installFakeDiscordApi();
    await bootWorker(other);
    await expect(other.createPage({ kind: 'popup' }).send({ to: 'bg', type: 'queue/removeMany', keys: [CH.a1] })).resolves.toEqual({ ok: false, error: 'no-account' });
  });

  it('two removals at once lose nothing and count every item exactly once', async () => {
    seedWorld();
    const answers = await Promise.all([removeMany([CH.a1, CH.a2, CH.loose]), removeMany([CH.a2, CH.b1, CH.loose]), toggle('x1')]);
    const removed = answers.slice(0, 2).map((answer) => answer.data.removed);
    expect(removed[0] + removed[1]).toBe(4); // a1, a2, loose, b1: each counted by one of the two
    expect(keys()).toEqual([CH.thread, ITEMS[6].key]);
  });
});

// ---- the pruning ----------------------------------------------------------------------------------------------------------------

describe('group settings never outlive the last queued channel of their group', () => {
  beforeEach(() => seedWorld());

  it('queue/remove: a group keeps its settings while any channel is left, and loses them with the last one', async () => {
    await remove(CH.a1);
    expect(storedSettings()).toEqual(GROUP_SETTINGS); // a2 is still in category A
    await remove(CH.a2);
    expect(storedSettings()).toEqual(without(GROUP_SETTINGS, CAT_A)); // category A is empty; the server still has channels
    await remove(CH.thread);
    await remove(CH.loose);
    expect(storedSettings()).toEqual(without(GROUP_SETTINGS, CAT_A)); // b1 keeps the server and category B
    await remove(CH.b1);
    expect(storedSettings()).toEqual({ [OTHER_GUILD]: S.otherGuild, [CAT_X]: S.catX }); // the server is empty: its settings and B's are gone
    await remove(CH.x1);
    expect(storedSettings()).toEqual({});
    expect(storedQueue(fake).map((stored) => stored.target.kind)).toEqual(['dm']);
  });

  it('removes in the same storage write as the item', async () => {
    fake.local.set.mockClear();
    await removeMany([CH.a1, CH.a2]);
    expect(writes()).toEqual([[LOCAL.groupSettings(ACCOUNT_ID), LOCAL.queue(ACCOUNT_ID)].sort()]);
  });

  it('queue/removeMany: every group that is left without a channel loses its settings, the others keep them', async () => {
    await removeMany([CH.a1, CH.a2, CH.x1]);
    expect(storedSettings()).toEqual(without(GROUP_SETTINGS, CAT_A, OTHER_GUILD, CAT_X));
  });

  it('queue/clear: drops all group settings of the account, also when the list was empty already; other accounts keep theirs', async () => {
    seedWorld({ accountId: OTHER_ACCOUNT_ID });
    await expect(popup.send({ to: 'bg', type: 'queue/clear' })).resolves.toEqual({ ok: true });
    expect(storedQueue(fake)).toEqual([]);
    expect(storedSettings()).toEqual({});
    expect(storedQueue(fake, OTHER_ACCOUNT_ID)).toEqual(ITEMS);
    expect(storedSettings(OTHER_ACCOUNT_ID)).toEqual(GROUP_SETTINGS);

    fake.local.seed({ [LOCAL.groupSettings(ACCOUNT_ID)]: { [GUILD_ID]: S.guild } }); // a leftover next to an empty list
    await popup.send({ to: 'bg', type: 'queue/clear' });
    expect(storedSettings()).toEqual({});
  });

  it('queue/clear: the groups record and the other keys are not touched', async () => {
    await popup.send({ to: 'bg', type: 'queue/clear' });
    expect(fake.local.peek(LOCAL.groups(ACCOUNT_ID))).toEqual(GROUPS);
  });

  it('queue/toggle taking a channel out (a row button, the shortcut): the same pruning', async () => {
    await toggle('a1');
    expect(storedSettings()).toEqual(GROUP_SETTINGS);
    await toggle('a2');
    expect(storedSettings()).toEqual(without(GROUP_SETTINGS, CAT_A));
    expect(keys()).not.toContain(CH.a2);
  });

  it('queue/toggle putting a channel in changes no group setting (a new channel follows what its group has)', async () => {
    await removeMany([CH.a1, CH.a2]);
    fake.local.set.mockClear();
    await toggle('a1');
    expect(fake.local.set.mock.calls.every(([written]) => !(LOCAL.groupSettings(ACCOUNT_ID) in (written as object)))).toBe(true);
    expect(storedSettings()).toEqual(without(GROUP_SETTINGS, CAT_A)); // the category's old settings did NOT come back
  });

  it('settings of an emptied group do not come back when the group is filled again', async () => {
    await removeMany([CH.a1, CH.a2]);
    await toggle('a1');
    await toggle('a2');
    expect(storedSettings()?.[CAT_A]).toBeUndefined();
  });

  it('a channel that is not in the list, and a removal that changes nothing, prune nothing and write nothing', async () => {
    fake.local.set.mockClear();
    await remove('999999999999999999');
    await removeMany(['999999999999999999']);
    expect(fake.local.set).not.toHaveBeenCalled();
  });

  describe('the category and server buttons (queue/addCategory, queue/addGuild)', () => {
    const channel = (id: string, type: number, name: string, parentId: string | null, position: number) => ({ id, type, name, parent_id: parentId, position, permission_overwrites: [] });
    const addCategory = (categoryId: string) =>
      content.send({ to: 'bg', type: 'queue/addCategory', guildId: GUILD_ID, guildName: 'Test Server', categoryId, categoryName: 'Category' });
    const addGuild = () => content.send({ to: 'bg', type: 'queue/addGuild', guildId: GUILD_ID, guildName: 'Test Server' });

    beforeEach(() => {
      api.guildChannels.set(GUILD_ID, [
        channel(CAT_A, 4, 'Alpha', null, 0),
        channel(CH.a1, 0, 'a1', CAT_A, 1),
        channel(CH.a2, 0, 'a2', CAT_A, 2),
        channel(CAT_B, 4, 'Beta', null, 1),
        channel(CH.b1, 0, 'b1', CAT_B, 1),
        channel(CH.loose, 0, 'loose', null, 0),
      ]);
      seedGuildAccess(api);
      seedWorld({
        items: [item('loose'), item('a1'), item('a2'), item('b1')],
        groupSettings: { [GUILD_ID]: S.guild, [CAT_A]: S.catA, [CAT_B]: S.catB },
      });
    });

    it('a category button that takes the whole category out: its settings go, the server\'s and the other category\'s stay', async () => {
      await expect(addCategory(CAT_A)).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 2 } });
      expect(keys()).toEqual([CH.loose, CH.b1]);
      expect(storedSettings()).toEqual({ [GUILD_ID]: S.guild, [CAT_B]: S.catB });
    });

    it('a server button that takes everything out: all of its settings go (the server\'s and its categories\')', async () => {
      await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 4 } });
      expect(storedQueue(fake)).toEqual([]);
      expect(storedSettings()).toEqual({});
    });

    it('a button that only adds prunes nothing, and what was pruned before does not come back', async () => {
      await addCategory(CAT_A); // out: category A's settings go
      await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 2, skipped: 2, removed: 0 } }); // a1, a2 are added again
      expect(keys()).toEqual([CH.loose, CH.b1, CH.a1, CH.a2]);
      expect(storedSettings()).toEqual({ [GUILD_ID]: S.guild, [CAT_B]: S.catB });
      await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 4 } });
      expect(storedSettings()).toEqual({});
    });

    it('the channels it adds follow the group settings that are there (they have settings: null)', async () => {
      await removeMany([CH.a1, CH.a2]);
      await addCategory(CAT_A);
      expect(storedQueue(fake).filter((stored) => ([CH.a1, CH.a2] as string[]).includes(stored.key)).map((stored) => stored.settings)).toEqual([null, null]);
      expect(storedSettings()).toEqual({ [GUILD_ID]: S.guild, [CAT_B]: S.catB }); // category A's settings did not come back
    });
  });

  it('is announced through storage.onChanged for both keys, once per removal', async () => {
    const changed: string[][] = [];
    fake.storageChanged.addListener((changes, area) => {
      if (area === 'local') changed.push(Object.keys(changes).sort());
    });
    await removeMany([CH.a1, CH.a2]);
    await settle();
    expect(changed).toEqual([[LOCAL.groupSettings(ACCOUNT_ID), LOCAL.queue(ACCOUNT_ID)].sort()]);
  });
});

describe('a re-recorded guild prunes the group settings that lost their last channel (queue/groupInfo, addCategory, addGuild)', () => {
  const channel = (id: string, type: number, name: string, parentId: string | null, position: number) => ({ id, type, name, parent_id: parentId, position, permission_overwrites: [] });
  const A3 = '430000000000000009'; // a channel of category A that nobody queued
  const groupInfo = () => content.send({ to: 'bg', type: 'queue/groupInfo', guildId: GUILD_ID, guildName: 'Test Server' });
  const addCategory = (categoryId: string) =>
    content.send({ to: 'bg', type: 'queue/addCategory', guildId: GUILD_ID, guildName: 'Test Server', categoryId, categoryName: 'Alpha' });
  const addGuild = () => content.send({ to: 'bg', type: 'queue/addGuild', guildId: GUILD_ID, guildName: 'Test Server' });
  const storedGroups = () => fake.local.peek<Record<string, GroupInfo>>(LOCAL.groups(ACCOUNT_ID));
  const sourceOf = (key: string) => {
    const stored = storedQueue(fake).find((candidate) => candidate.key === key);
    if (stored === undefined) throw new Error(`${key} is not in the list`);
    return resolveEffectiveSettings(stored, exportSettings(), storedSettings() ?? {}, storedGroups() ?? {}).source;
  };

  /** On Discord a1 moved from category A to category B; a2 and the new a3 are the readable channels of A that are not queued. */
  const worldAfterTheMove = (): void => {
    api.guildChannels.set(GUILD_ID, [
      channel(CAT_A, 4, 'Alpha', null, 0),
      channel(CH.a2, 0, 'a2', CAT_A, 1),
      channel(A3, 0, 'a3', CAT_A, 2),
      channel(CAT_B, 4, 'Beta', null, 1),
      channel(CH.a1, 0, 'a1', CAT_B, 1),
      channel(CH.b1, 0, 'b1', CAT_B, 2),
      channel(CH.loose, 0, 'loose', null, 0),
    ]);
    seedGuildAccess(api);
  };

  beforeEach(() => {
    worldAfterTheMove();
    // category A has one queued channel (a1) and settings; the recorded groups still say a1 is in A
    seedWorld({ items: [item('loose'), item('a1'), item('b1'), item('x1')], groupSettings: GROUP_SETTINGS });
  });

  it('the only queued channel of a category moved away: the category\'s settings go in the same write as the new groups', async () => {
    fake.local.set.mockClear();
    await expect(groupInfo()).resolves.toEqual({ ok: true });
    expect(storedGroups()?.[CAT_B].channelIds).toContain(CH.a1);
    expect(storedSettings()).toEqual(without(GROUP_SETTINGS, CAT_A)); // the server's, B's and the other server's stay
    expect(writes()).toEqual([[LOCAL.groupSettings(ACCOUNT_ID), LOCAL.groups(ACCOUNT_ID)].sort()]); // one write; the queue is untouched
    expect(storedQueue(fake).map((stored) => stored.key)).toEqual([CH.loose, CH.a1, CH.b1, CH.x1]);
  });

  it('a channel added to that category afterwards follows the server\'s settings, not the category\'s old ones', async () => {
    await groupInfo();
    await expect(addCategory(CAT_A)).resolves.toEqual({ ok: true, data: { added: 2, skipped: 0, removed: 0 } });
    expect(keys()).toEqual([CH.loose, CH.a1, CH.b1, CH.x1, CH.a2, A3]);
    expect(sourceOf(CH.a2)).toBe('guild');
    expect(sourceOf(A3)).toBe('guild');
    expect(storedSettings()?.[CAT_A]).toBeUndefined();
  });

  it('the settings of the whole server are counted without the orphan: the notice before saving matches `cleared`', async () => {
    seedWorld({ items: [item('loose'), item('a1', { settings: S.own(1) }), item('b1'), item('x1')], groupSettings: GROUP_SETTINGS });
    await groupInfo();
    // below the server: a1 has settings of its own (1) and category B has settings (1); category A's orphan is gone already, so it is not counted
    await expect(setServer(S.fresh)).resolves.toEqual({ ok: true, data: { cleared: 2 } });
    expect(storedSettings()?.[CAT_A]).toBeUndefined();
    expect(storedSettings()?.[GUILD_ID]).toEqual(S.fresh);
  });

  it('the category and server buttons re-record the guild too, and prune with it: what they add afterwards follows the server', async () => {
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 2, skipped: 3, removed: 0 } }); // a2 and a3 are new; loose, a1 and b1 were in
    expect(storedSettings()).toEqual(without(GROUP_SETTINGS, CAT_A)); // pruned in the record step, before the new channels were added
    expect(sourceOf(CH.a2)).toBe('guild');
    expect(sourceOf(A3)).toBe('guild');
  });

  it('a re-record in which every group still has a queued channel writes the groups only', async () => {
    seedWorld({ items: [item('loose'), item('a1'), item('a2'), item('b1'), item('x1')], groupSettings: GROUP_SETTINGS });
    api.guildChannels.set(GUILD_ID, [
      channel(CAT_A, 4, 'Alpha', null, 0),
      channel(CH.a1, 0, 'a1', CAT_A, 1),
      channel(CH.a2, 0, 'a2', CAT_A, 2),
      channel(CAT_B, 4, 'Beta', null, 1),
      channel(CH.b1, 0, 'b1', CAT_B, 1),
      channel(CH.loose, 0, 'loose', null, 0),
    ]);
    fake.local.set.mockClear();
    await groupInfo();
    expect(writes()).toEqual([[LOCAL.groups(ACCOUNT_ID)]]);
    expect(storedSettings()).toEqual(GROUP_SETTINGS);
  });

  it('only the settings of groups with no queued channel go: the other server\'s stay', async () => {
    await groupInfo();
    expect(storedSettings()?.[OTHER_GUILD]).toEqual(S.otherGuild);
    expect(storedSettings()?.[CAT_X]).toEqual(S.catX);
  });

  it('a load that could not check permissions (the fallback) lists every category, so no category with a queued channel loses its settings', async () => {
    const kept = without(GROUP_SETTINGS, OTHER_GUILD, CAT_X);
    seedWorld({ items: [item('loose'), item('a1'), item('a2'), item('b1')], groupSettings: kept });
    api.guildChannels.set(GUILD_ID, [
      channel(CAT_A, 4, 'Alpha', null, 0),
      channel(CH.a1, 0, 'a1', CAT_A, 1),
      channel(CH.a2, 0, 'a2', CAT_A, 2),
      channel(CAT_B, 4, 'Beta', null, 1),
      channel(CH.b1, 0, 'b1', CAT_B, 1),
    ]);
    api.members.delete(GUILD_ID);
    api.membersAtMe.delete(GUILD_ID);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(groupInfo()).resolves.toEqual({ ok: true });
    } finally {
      warn.mockRestore();
    }
    expect(storedSettings()).toEqual(kept);
  });
});

describe('when storage fails', () => {
  it('a setGroupSettings that cannot be stored is answered with "unknown" (no secret in it), changes nothing, and the next one works', async () => {
    seedWorld();
    fake.local.set.mockRejectedValueOnce(new Error(`QUOTA_BYTES quota exceeded while storing ${TOKEN}`));
    const response = await setServer(S.fresh);
    expect(response).toMatchObject({ ok: false, error: 'unknown' });
    expect(JSON.stringify(response)).not.toContain(TOKEN);
    expect(storedQueue(fake)).toEqual(ITEMS);
    expect(storedSettings()).toEqual(GROUP_SETTINGS);
    await expect(setServer(S.fresh)).resolves.toMatchObject({ ok: true });
  });
});
