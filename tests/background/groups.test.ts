/**
 * The group buttons of the 4th change (docs/PLAN.md §2 "추가 UX 규칙", §3, §5.1 `GroupInfo`, §5.2 `LOCAL.groups`, §5.3):
 *  - `queue/addCategory` and `queue/addGuild` are TOGGLES over the readable channels of the group and answer
 *    `{ added, skipped, removed }`;
 *  - every load of a guild records its groups (the guild itself and every category) in `LOCAL.groups(accountId)`;
 *  - `queue/groupInfo` does that without touching the list.
 * The permission math and the request pattern have their tests in guild.test.ts; fixtures use neutral names and made-up ids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { LOCAL, SESSION, isApiGetPathAllowed } from '@/shared';
import type { GroupInfo } from '@/shared';
import { buildGuildGroups } from '@/background/groups';
import { READ_MESSAGE_HISTORY, VIEW_CHANNEL } from '@/lib/discord/permissions';
import { createFakeBrowser } from './fakeChrome';
import type { FakeBrowser, FakePage } from './fakeChrome';
import {
  ACCOUNT_ID,
  DM_CHANNEL,
  GUILD_ID,
  OTHER_ACCOUNT_ID,
  OTHER_TOKEN,
  TOKEN,
  bootLoggedIn,
  bootWorker,
  dmTarget,
  exportSettings,
  guildTarget,
  installFakeDiscordApi,
  queueItem,
  seedGuildAccess,
  seedQueue,
  settle,
  storedQueue,
  userPayload,
  waitFor,
} from './helpers';
import type { FakeDiscordApi } from './helpers';

let fake: FakeBrowser;
let popup: FakePage;
let content: FakePage;
let api: FakeDiscordApi;
let warn: MockInstance<typeof console.warn>;

beforeEach(async () => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  fake = createFakeBrowser();
  ({ popup, api } = await bootLoggedIn(fake));
  content = fake.createContentScript(7, `https://discord.com/channels/${GUILD_ID}/400000000000000001`);
  setWorld();
});

afterEach(() => {
  warn.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---- the server -----------------------------------------------------------------------------------------------------------------

const OTHER_GUILD = '200000000000000002';

/** Channel ids by name. */
const ID = {
  rules: '430000000000000001',
  news: '430000000000000002',
  notes: '430000000000000003',
  questions: '430000000000000004',
  draft: '430000000000000005', // hidden, in Study
  voice: '430000000000000006', // not exportable, in Study
  lounge: '430000000000000007',
  gallery: '430000000000000008',
  vault: '430000000000000009', // hidden, in Locked
} as const;
type ChannelName = keyof typeof ID;

const CAT = {
  study: '300000000000000011',
  chat: '300000000000000012',
  empty: '300000000000000013', // no channel at all
  locked: '300000000000000014', // channels, but none the account may read
} as const;

const denyEveryone = [{ id: GUILD_ID, type: 0, allow: '0', deny: String(VIEW_CHANNEL) }];
const raw = (id: string, type: number, name: string, parentId: string | null, position: number, hidden = false) => ({
  id,
  type,
  name,
  parent_id: parentId,
  position,
  permission_overwrites: hidden ? denyEveryone : [],
});

/** What `GET guilds/{id}/channels` answers; the order of the answer means nothing. */
const serverChannels = (): unknown[] => [
  raw(CAT.locked, 4, 'Locked', null, 3),
  raw(ID.vault, 0, 'vault', CAT.locked, 1, true),
  raw(ID.gallery, 16, 'gallery', CAT.chat, 2),
  raw(CAT.study, 4, 'Study', null, 0),
  raw(ID.draft, 0, 'draft', CAT.study, 3, true),
  raw(ID.questions, 15, 'questions', CAT.study, 2),
  raw(ID.rules, 0, 'rules', null, 1),
  raw(CAT.empty, 4, 'Empty', null, 2),
  raw(ID.voice, 2, 'voice', CAT.study, 4),
  raw(CAT.chat, 4, 'Chat', null, 1),
  raw(ID.lounge, 0, 'lounge', CAT.chat, 1),
  raw(ID.notes, 0, 'notes', CAT.study, 1),
  raw(ID.news, 5, 'news', null, 2),
];

/** The readable channels in the order of the sidebar: loose channels, then category by category. */
const SERVER: ChannelName[] = ['rules', 'news', 'notes', 'questions', 'lounge', 'gallery'];

function setWorld(channels: unknown[] = serverChannels(), guildId = GUILD_ID): void {
  api.guildChannels.set(guildId, channels);
  seedGuildAccess(api, guildId);
}

const ids = (names: readonly ChannelName[]): string[] => names.map((name) => ID[name]);
/** A list item of the channel `name` of the server. */
const item = (name: ChannelName, overrides: Parameters<typeof queueItem>[1] = {}) => queueItem(guildTarget(ID[name], { channelName: name }), overrides);

// ---- the messages ---------------------------------------------------------------------------------------------------------------

const addGuild = (overrides: Record<string, unknown> = {}, from: FakePage = content) =>
  from.send({ to: 'bg', type: 'queue/addGuild', guildId: GUILD_ID, guildName: 'Test Server', ...overrides });
const addCategory = (categoryId: string = CAT.study, overrides: Record<string, unknown> = {}, from: FakePage = content) =>
  from.send({ to: 'bg', type: 'queue/addCategory', guildId: GUILD_ID, guildName: 'Test Server', categoryId, categoryName: 'Category', ...overrides });
const groupInfo = (overrides: Record<string, unknown> = {}, from: FakePage = content) =>
  from.send({ to: 'bg', type: 'queue/groupInfo', guildId: GUILD_ID, guildName: 'Test Server', ...overrides });

const keys = (accountId = ACCOUNT_ID): string[] => storedQueue(fake, accountId).map((stored) => stored.key);
const storedGroups = (accountId = ACCOUNT_ID): Record<string, GroupInfo> => fake.local.peek<Record<string, GroupInfo>>(LOCAL.groups(accountId)) ?? {};
const guildRequests = (): string[] => api.calls.map((call) => call.url.replace('https://discord.com', '')).filter((path) => path.includes('/guilds/'));
const PATH = {
  channels: `/api/v9/guilds/${GUILD_ID}/channels`,
  roles: `/api/v9/guilds/${GUILD_ID}/roles`,
  guild: `/api/v9/guilds/${GUILD_ID}`,
  member: `/api/v9/users/@me/guilds/${GUILD_ID}/member`,
  memberAtMe: `/api/v9/guilds/${GUILD_ID}/members/@me`,
};
const ALL_PATHS = [PATH.channels, PATH.roles, PATH.guild, PATH.member];

/** The groups of the server above, as they are expected to be stored. */
const expectedGroups = (updatedAt: number): Record<string, GroupInfo> => ({
  [GUILD_ID]: { kind: 'guild', guildId: GUILD_ID, channelIds: ids(SERVER), updatedAt, name: 'Test Server', iconUrl: null },
  [CAT.study]: { kind: 'category', guildId: GUILD_ID, channelIds: ids(['notes', 'questions']), updatedAt, name: 'Study' },
  [CAT.chat]: { kind: 'category', guildId: GUILD_ID, channelIds: ids(['lounge', 'gallery']), updatedAt, name: 'Chat' },
  [CAT.empty]: { kind: 'category', guildId: GUILD_ID, channelIds: [], updatedAt, name: 'Empty' },
  [CAT.locked]: { kind: 'category', guildId: GUILD_ID, channelIds: [], updatedAt, name: 'Locked' },
});

// ---- the toggle -----------------------------------------------------------------------------------------------------------------

interface Button {
  label: string;
  click: (from?: FakePage) => Promise<any>;
  /** The readable channels the button works on, in the order of the sidebar. */
  group: ChannelName[];
  /** Channels of the server that are not part of it (readable or not): a click never touches them. */
  outsiders: ChannelName[];
}

const BUTTONS: Button[] = [
  { label: 'server button (queue/addGuild)', click: (from) => addGuild({}, from), group: SERVER, outsiders: ['draft', 'vault'] },
  { label: 'category button (queue/addCategory)', click: (from) => addCategory(CAT.study, {}, from), group: ['notes', 'questions'], outsiders: ['rules', 'news', 'lounge', 'gallery', 'draft', 'vault'] },
];

describe.each(BUTTONS)('the toggle: $label', ({ click, group, outsiders }) => {
  const n = group.length;

  it('nothing is in the list: adds the whole group in the order of the sidebar, with settings null', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    await expect(click()).resolves.toEqual({ ok: true, data: { added: n, skipped: 0, removed: 0 } });
    expect(keys()).toEqual(ids(group));
    expect(storedQueue(fake).every((stored) => stored.settings === null && stored.addedAt === 1_760_000_000_000)).toBe(true);
  });

  it('some of the group is in the list: adds only the missing channels, skips the others and leaves them as they are', async () => {
    const own = item(group[1], { settings: exportSettings({ format: 'csv' }), addedAt: 5, lastResult: { status: 'failed', message: 'x', at: 6 } });
    seedQueue(fake, [queueItem(dmTarget()), own]);
    await expect(click()).resolves.toEqual({ ok: true, data: { added: n - 1, skipped: 1, removed: 0 } });
    expect(keys()).toEqual([DM_CHANNEL, ids(group)[1], ...ids(group).filter((id) => id !== ids(group)[1])]);
    expect(storedQueue(fake)[1]).toEqual(own);
  });

  it('all but one are in the list: the missing one is added (a toggle never removes while anything is missing)', async () => {
    seedQueue(fake, group.slice(1).map((name) => item(name)));
    await expect(click()).resolves.toEqual({ ok: true, data: { added: 1, skipped: n - 1, removed: 0 } });
    expect(keys()).toEqual([...ids(group.slice(1)), ids(group)[0]]);
  });

  it('every channel of the group is in the list: exactly those leave it, whatever their settings', async () => {
    seedQueue(fake, [
      item(group[0], { settings: exportSettings({ count: 5 }), lastResult: { status: 'partial', message: 'm', at: 3 } }),
      ...group.slice(1).map((name) => item(name)),
    ]);
    await expect(click()).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: n } });
    expect(storedQueue(fake)).toEqual([]);
  });

  it('touches nothing else: other chats, other channels, the order and the settings of what stays', async () => {
    const elsewhere = queueItem(guildTarget('600000000000000001', { guildId: OTHER_GUILD, guildName: 'Other Server', channelName: 'elsewhere' }), { settings: exportSettings({ format: 'md' }) });
    const stays = [queueItem(dmTarget()), ...outsiders.map((name) => item(name, { addedAt: 7 })), elsewhere];
    // the group's items are scattered between the others
    const list = [stays[0], item(group[0]), ...stays.slice(1, -1), ...group.slice(1).map((name) => item(name)), stays[stays.length - 1]];
    seedQueue(fake, list);
    await expect(click()).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: n } });
    expect(storedQueue(fake)).toEqual(stays);
  });

  it('a channel the account may not read does not count: the readable ones all being in the list is enough, and a hidden one in the list stays', async () => {
    seedQueue(fake, [item('vault'), ...group.map((name) => item(name)), item('draft')]);
    await expect(click()).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: n } });
    expect(keys()).toEqual(ids(['vault', 'draft']));
  });

  it('a hidden channel in the list does not make up for a missing readable one', async () => {
    seedQueue(fake, [item('draft'), item('vault'), ...group.slice(1).map((name) => item(name))]);
    await expect(click()).resolves.toEqual({ ok: true, data: { added: 1, skipped: n - 1, removed: 0 } });
    expect(keys()).toContain(ids(group)[0]);
    expect(keys()).toContain(ID.draft);
  });

  it('is a real toggle: in, out, in, out', async () => {
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push((await click()).data);
    expect(results).toEqual([
      { added: n, skipped: 0, removed: 0 },
      { added: 0, skipped: 0, removed: n },
      { added: n, skipped: 0, removed: 0 },
      { added: 0, skipped: 0, removed: n },
    ]);
    expect(keys()).toEqual([]);
  });

  it('works the same for the popup', async () => {
    await expect(click(popup)).resolves.toEqual({ ok: true, data: { added: n, skipped: 0, removed: 0 } });
    await expect(click(popup)).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: n } });
  });

  it('every account has its own list: the other account\'s list is never touched', async () => {
    seedQueue(fake, group.map((name) => item(name)), OTHER_ACCOUNT_ID);
    await expect(click()).resolves.toEqual({ ok: true, data: { added: n, skipped: 0, removed: 0 } }); // not in HIS list yet
    expect(keys(OTHER_ACCOUNT_ID)).toEqual(ids(group));
    await expect(click()).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: n } });
    expect(keys(OTHER_ACCOUNT_ID)).toEqual(ids(group));

    // the other account is a plain member as well (seedGuildAccess made it the owner of the guild)
    api.guilds.set(GUILD_ID, { id: GUILD_ID, name: 'Test Server', owner_id: '100000000000000099', roles: api.guildRoles.get(GUILD_ID) });
    api.users.set(OTHER_TOKEN, userPayload(OTHER_ACCOUNT_ID));
    fake.captureToken(OTHER_TOKEN);
    await waitFor(() => (fake.session.peek(SESSION.account) as { id: string } | null)?.id === OTHER_ACCOUNT_ID);
    await expect(click()).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: n } }); // all of them are in the list of this account
    expect(keys(OTHER_ACCOUNT_ID)).toEqual([]);
    expect(keys(ACCOUNT_ID)).toEqual([]);
  });

  it('two clicks at once are applied one after the other: one adds, the other removes, and nothing is lost', async () => {
    const answers = await Promise.all([click(content), click(popup)]);
    expect(answers.map((answer) => answer.data).sort((a, b) => b.added - a.added)).toEqual([
      { added: n, skipped: 0, removed: 0 },
      { added: 0, skipped: 0, removed: n },
    ]);
    expect(keys()).toEqual([]);
    // an odd number of clicks at once leaves the group in
    await Promise.all([click(content), click(popup), click(content)]);
    expect(keys()).toEqual(ids(group));
  });
});

describe('the toggle: groups with nothing to work on', () => {
  it('a category without any channel: all zeros, the list is untouched', async () => {
    seedQueue(fake, [item('rules')]);
    await expect(addCategory(CAT.empty)).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 0 } });
    expect(keys()).toEqual([ID.rules]);
  });

  it('a click that changes nothing does not write the list', async () => {
    await expect(addCategory(CAT.empty)).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 0 } });
    expect(fake.local.has(LOCAL.queue(ACCOUNT_ID))).toBe(false);
  });

  it('a category whose channels the account may not read: all zeros, and a hidden channel in the list stays', async () => {
    seedQueue(fake, [item('vault')]);
    await expect(addCategory(CAT.locked)).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 0 } });
    expect(keys()).toEqual([ID.vault]);
  });

  it('a category that is not in the guild at all: all zeros', async () => {
    await expect(addCategory('300000000000000099')).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 0 } });
    expect(fake.local.has(LOCAL.queue(ACCOUNT_ID))).toBe(false);
  });

  it('a server without a readable channel: all zeros', async () => {
    setWorld([raw(CAT.locked, 4, 'Locked', null, 0), raw(ID.vault, 0, 'vault', CAT.locked, 1, true), raw(ID.voice, 2, 'voice', null, 2)]);
    seedQueue(fake, [item('vault')]);
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 0 } });
    expect(keys()).toEqual([ID.vault]);
  });

  it('an empty server: all zeros', async () => {
    setWorld([]);
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 0 } });
  });

  it('a group that has one channel without a usable name never counts as fully in the list: it adds what it can, again and again', async () => {
    setWorld([raw(CAT.study, 4, 'Study', null, 0), raw(ID.notes, 0, 'notes', CAT.study, 1), raw(ID.questions, 0, '   ', CAT.study, 2)]);
    await expect(addCategory(CAT.study)).resolves.toEqual({ ok: true, data: { added: 1, skipped: 0, removed: 0 } });
    await expect(addCategory(CAT.study)).resolves.toEqual({ ok: true, data: { added: 0, skipped: 1, removed: 0 } });
    expect(keys()).toEqual([ID.notes]);
  });
});

describe('the toggle across the buttons', () => {
  it('the category button inside a full server: takes out only its own children; the server button then adds them back', async () => {
    await addGuild();
    expect(keys()).toEqual(ids(SERVER));
    await expect(addCategory(CAT.study)).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 2 } });
    expect(keys()).toEqual(ids(['rules', 'news', 'lounge', 'gallery']));
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 2, skipped: 4, removed: 0 } });
    expect(keys()).toEqual(ids(['rules', 'news', 'lounge', 'gallery', 'notes', 'questions']));
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 6 } });
    expect(keys()).toEqual([]);
  });

  it('the groups say what the buttons will do: a group whose channels are all in the list is the one that is removed', async () => {
    await addGuild();
    const groups = storedGroups();
    const inList = (group: GroupInfo) => group.channelIds.length > 0 && group.channelIds.every((id) => keys().includes(id));
    expect(Object.values(groups).map(inList)).toEqual(Object.keys(groups).map((groupId) => groupId === GUILD_ID || groupId === CAT.study || groupId === CAT.chat));
    const { data } = await addCategory(CAT.chat);
    expect(data).toEqual({ added: 0, skipped: 0, removed: groups[CAT.chat].channelIds.length });
    expect(inList(groups[GUILD_ID])).toBe(false); // the server button is now an "add" button again
    expect(await addGuild()).toEqual({ ok: true, data: { added: 2, skipped: 4, removed: 0 } });
  });
});

// ---- the groups -----------------------------------------------------------------------------------------------------------------

describe('LOCAL.groups', () => {
  it('a server click stores the guild and every category: readable channels only, in the order of the sidebar, empty categories as empty lists', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    await addGuild();
    expect(storedGroups()).toEqual(expectedGroups(1_760_000_000_000));
  });

  it('a category click stores the groups of the whole guild, not only its own category', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    await addCategory(CAT.chat);
    expect(storedGroups()).toEqual(expectedGroups(1_760_000_000_000));
  });

  it('queue/groupInfo stores them too', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    await groupInfo();
    expect(storedGroups()).toEqual(expectedGroups(1_760_000_000_000));
  });

  it('the stored record holds only the contract\'s fields: a name for every group, an icon for the server group only', async () => {
    await groupInfo();
    for (const group of Object.values(storedGroups())) {
      expect(Object.keys(group).sort()).toEqual(group.kind === 'guild' ? ['channelIds', 'guildId', 'iconUrl', 'kind', 'name', 'updatedAt'] : ['channelIds', 'guildId', 'kind', 'name', 'updatedAt']);
    }
    expect(Object.keys(fake.local.dump()).filter((key) => key.startsWith('dce.groups.'))).toEqual([LOCAL.groups(ACCOUNT_ID)]);
  });

  it('lists only types 0, 5, 15 and 16: no voice or stage channel, no thread, no category', async () => {
    setWorld([
      raw(CAT.study, 4, 'Study', null, 0),
      raw(ID.notes, 0, 'notes', CAT.study, 1),
      raw(ID.news, 5, 'news', CAT.study, 2),
      raw(ID.questions, 15, 'questions', CAT.study, 3),
      raw(ID.gallery, 16, 'gallery', CAT.study, 4),
      raw(ID.voice, 2, 'voice', CAT.study, 5),
      raw(ID.lounge, 13, 'stage', CAT.study, 6),
      raw(ID.draft, 11, 'a thread', CAT.study, 7),
      raw(ID.vault, 14, 'directory', CAT.study, 8),
    ]);
    await groupInfo();
    expect(storedGroups()[CAT.study].channelIds).toEqual(ids(['notes', 'news', 'questions', 'gallery']));
    expect(storedGroups()[GUILD_ID].channelIds).toEqual(ids(['notes', 'news', 'questions', 'gallery']));
  });

  it('a hidden channel is in no list, and a channel the account may read through a role is', async () => {
    const role = '600000000000000001';
    const allow = [...denyEveryone, { id: role, type: 0, allow: String(VIEW_CHANNEL), deny: '0' }];
    setWorld([raw(CAT.study, 4, 'Study', null, 0), raw(ID.notes, 0, 'notes', CAT.study, 1), { ...raw(ID.draft, 0, 'draft', CAT.study, 2), permission_overwrites: allow }, raw(ID.vault, 0, 'vault', CAT.study, 3, true)]);
    api.members.set(GUILD_ID, { user: { id: ACCOUNT_ID }, roles: [role] });
    api.guildRoles.set(GUILD_ID, [
      { id: GUILD_ID, name: '@everyone', permissions: String(VIEW_CHANNEL | READ_MESSAGE_HISTORY), position: 0 },
      { id: role, name: 'member', permissions: '0', position: 1 },
    ]);
    await groupInfo();
    expect(storedGroups()[CAT.study].channelIds).toEqual(ids(['notes', 'draft']));
  });

  it('a channel whose category is not in the channel list is in the guild\'s list but in no category list', async () => {
    setWorld([raw(CAT.study, 4, 'Study', null, 0), raw(ID.notes, 0, 'notes', CAT.study, 1), raw(ID.rules, 0, 'rules', '300000000000000099', 2)]);
    await groupInfo();
    const groups = storedGroups();
    expect(Object.keys(groups).sort()).toEqual([CAT.study, GUILD_ID].sort());
    expect(groups[GUILD_ID].channelIds).toEqual(ids(['rules', 'notes']));
    expect(groups[CAT.study].channelIds).toEqual([ID.notes]);
  });

  it('every call replaces what is stored for the guild: a deleted category goes, a moved channel moves, the time is renewed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    await groupInfo();
    expect(Object.keys(storedGroups()).sort()).toEqual([GUILD_ID, CAT.study, CAT.chat, CAT.empty, CAT.locked].sort());

    // Study and Locked are deleted, "notes" moved into Chat, a new category "Fresh" appeared
    const fresh = '300000000000000021';
    setWorld([
      raw(CAT.chat, 4, 'Chat', null, 0),
      raw(ID.lounge, 0, 'lounge', CAT.chat, 1),
      raw(ID.notes, 0, 'notes', CAT.chat, 2),
      raw(CAT.empty, 4, 'Empty', null, 1),
      raw(fresh, 4, 'Fresh', null, 2),
      raw(ID.gallery, 16, 'gallery', fresh, 1),
    ]);
    await vi.advanceTimersByTimeAsync(60_001); // the cached answer has expired
    await groupInfo();
    expect(storedGroups()).toEqual({
      [GUILD_ID]: { kind: 'guild', guildId: GUILD_ID, channelIds: ids(['lounge', 'notes', 'gallery']), updatedAt: 1_760_000_060_001, name: 'Test Server', iconUrl: null },
      [CAT.chat]: { kind: 'category', guildId: GUILD_ID, channelIds: ids(['lounge', 'notes']), updatedAt: 1_760_000_060_001, name: 'Chat' },
      [CAT.empty]: { kind: 'category', guildId: GUILD_ID, channelIds: [], updatedAt: 1_760_000_060_001, name: 'Empty' },
      [fresh]: { kind: 'category', guildId: GUILD_ID, channelIds: [ID.gallery], updatedAt: 1_760_000_060_001, name: 'Fresh' },
    });
  });

  it('keeps the entries of the other guilds (and of the other accounts) when one guild is written', async () => {
    const otherGuildGroups: Record<string, GroupInfo> = {
      [OTHER_GUILD]: { kind: 'guild', guildId: OTHER_GUILD, channelIds: ['610000000000000001'], updatedAt: 11 },
      '300000000000000077': { kind: 'category', guildId: OTHER_GUILD, channelIds: ['610000000000000001'], updatedAt: 11 },
    };
    const otherAccountGroups: Record<string, GroupInfo> = { [GUILD_ID]: { kind: 'guild', guildId: GUILD_ID, channelIds: ['610000000000000002'], updatedAt: 12 } };
    fake.local.seed({
      [LOCAL.groups(ACCOUNT_ID)]: {
        ...otherGuildGroups,
        [GUILD_ID]: { kind: 'guild', guildId: GUILD_ID, channelIds: ['610000000000000003'], updatedAt: 13 }, // stale: replaced
        '300000000000000078': { kind: 'category', guildId: GUILD_ID, channelIds: ['610000000000000003'], updatedAt: 13 }, // stale: dropped
      },
      [LOCAL.groups(OTHER_ACCOUNT_ID)]: otherAccountGroups,
    });
    await groupInfo();
    const groups = storedGroups();
    expect(groups[OTHER_GUILD]).toEqual(otherGuildGroups[OTHER_GUILD]);
    expect(groups['300000000000000077']).toEqual(otherGuildGroups['300000000000000077']);
    expect(groups['300000000000000078']).toBeUndefined();
    expect(groups[GUILD_ID].channelIds).toEqual(ids(SERVER));
    expect(Object.keys(groups)).toHaveLength(2 + 5);
    expect(fake.local.peek(LOCAL.groups(OTHER_ACCOUNT_ID))).toEqual(otherAccountGroups);
  });

  it('two guilds side by side: each keeps its own entries', async () => {
    setWorld([raw('300000000000000051', 4, 'Elsewhere', null, 0), raw('430000000000000051', 0, 'plaza', '300000000000000051', 1)], OTHER_GUILD);
    await groupInfo();
    await groupInfo({ guildId: OTHER_GUILD, guildName: 'Other Server' });
    const groups = storedGroups();
    expect(Object.keys(groups).sort()).toEqual([GUILD_ID, CAT.study, CAT.chat, CAT.empty, CAT.locked, OTHER_GUILD, '300000000000000051'].sort());
    expect(groups[OTHER_GUILD]).toMatchObject({ kind: 'guild', guildId: OTHER_GUILD, channelIds: ['430000000000000051'] });
    expect(groups[GUILD_ID].channelIds).toEqual(ids(SERVER));
  });

  it('every account has its own record', async () => {
    await groupInfo();
    api.users.set(OTHER_TOKEN, userPayload(OTHER_ACCOUNT_ID));
    fake.captureToken(OTHER_TOKEN);
    await waitFor(() => (fake.session.peek(SESSION.account) as { id: string } | null)?.id === OTHER_ACCOUNT_ID);
    setWorld([raw(ID.rules, 0, 'rules', null, 0)]);
    await groupInfo();
    expect(storedGroups(ACCOUNT_ID)[GUILD_ID].channelIds).toEqual(ids(SERVER));
    expect(storedGroups(OTHER_ACCOUNT_ID)[GUILD_ID].channelIds).toEqual([ID.rules]);
  });

  it('a record that was damaged is repaired: what is not a group goes, valid entries of other guilds stay', async () => {
    const valid: GroupInfo = { kind: 'category', guildId: OTHER_GUILD, channelIds: ['610000000000000001'], updatedAt: 5 };
    fake.local.seed({
      [LOCAL.groups(ACCOUNT_ID)]: { junk: valid, '300000000000000088': { kind: 'bogus' }, '300000000000000089': valid, '300000000000000090': 'x' },
    });
    await groupInfo();
    expect(storedGroups()['300000000000000089']).toEqual(valid);
    expect(storedGroups().junk).toBeUndefined();
    expect(storedGroups()['300000000000000088']).toBeUndefined();
    expect(storedGroups()['300000000000000090']).toBeUndefined();
    fake.local.seed({ [LOCAL.groups(ACCOUNT_ID)]: 'not a record' });
    await groupInfo();
    expect(Object.keys(storedGroups())).toHaveLength(5);
  });

  it('is written even when the click changes nothing, and before the list changes', async () => {
    fake.local.set.mockClear();
    await addGuild();
    const written = fake.local.set.mock.calls.map(([items]) => Object.keys(items as Record<string, unknown>));
    expect(written).toEqual([[LOCAL.groups(ACCOUNT_ID)], [LOCAL.queue(ACCOUNT_ID)]]);

    setWorld([]);
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 0 } });
    expect(storedGroups()).toEqual({ [GUILD_ID]: expect.objectContaining({ kind: 'guild', channelIds: [] }) }); // the guild is empty now; its categories are gone
  });

  it('an identical record is not written again (the time did not move)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    await groupInfo();
    fake.local.set.mockClear();
    await groupInfo();
    expect(fake.local.set).not.toHaveBeenCalled();
  });

  it('is announced through storage.onChanged: one change per call', async () => {
    const changes: string[] = [];
    fake.storageChanged.addListener((changed, area) => {
      if (area === 'local' && LOCAL.groups(ACCOUNT_ID) in changed) changes.push('groups');
    });
    await groupInfo();
    await settle();
    expect(changes).toEqual(['groups']);
  });

  it('a failed load stores nothing and keeps what was stored', async () => {
    await groupInfo();
    const before = storedGroups();
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(61_000);
    api.pathFailures.set(PATH.channels, 500);
    await expect(groupInfo()).resolves.toMatchObject({ ok: false, error: 'http' });
    await expect(addGuild()).resolves.toMatchObject({ ok: false, error: 'http' });
    expect(storedGroups()).toEqual(before);
  });

  it('the permission data cannot be loaded: the groups are written from the type-only list (hidden channels included), and replaced once the data is back', async () => {
    api.pathFailures.set(PATH.member, 403);
    api.pathFailures.set(PATH.memberAtMe, 403);
    await expect(groupInfo()).resolves.toEqual({ ok: true });
    expect(warn).toHaveBeenCalledTimes(1);
    const everything: ChannelName[] = ['rules', 'news', 'notes', 'questions', 'draft', 'lounge', 'gallery', 'vault'];
    // the sidebar order again: loose first, then Study (notes, questions, draft), Chat (lounge, gallery), Locked (vault)
    expect(storedGroups()[GUILD_ID].channelIds).toEqual(ids(everything));
    expect(storedGroups()[CAT.study].channelIds).toEqual(ids(['notes', 'questions', 'draft']));
    expect(storedGroups()[CAT.locked].channelIds).toEqual([ID.vault]);
    expect(Object.keys(storedGroups()).sort()).toEqual([GUILD_ID, CAT.study, CAT.chat, CAT.empty, CAT.locked].sort());

    api.pathFailures.clear(); // Discord is fine again; the incomplete answer was not cached
    await groupInfo();
    expect(storedGroups()[GUILD_ID].channelIds).toEqual(ids(SERVER));
    expect(storedGroups()[CAT.locked].channelIds).toEqual([]);
  });

  it('the same fallback for the buttons: the groups are written, and the click works on the same list', async () => {
    api.pathFailures.set(PATH.member, 403);
    api.pathFailures.set(PATH.memberAtMe, 403);
    await expect(addCategory(CAT.study)).resolves.toEqual({ ok: true, data: { added: 3, skipped: 0, removed: 0 } });
    expect(storedGroups()[CAT.study].channelIds).toEqual(keys());
  });

  it('only a failing write of the groups is tolerated by a click: it is logged (without the authorization) and the list is still changed', async () => {
    fake.local.set.mockRejectedValueOnce(new Error(`QUOTA_BYTES quota exceeded while storing ${TOKEN}`));
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 6, skipped: 0, removed: 0 } });
    expect(keys()).toEqual(ids(SERVER));
    expect(fake.local.has(LOCAL.groups(ACCOUNT_ID))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(warn.mock.calls)).toContain('could not be stored');
  });
});

// ---- concurrency ----------------------------------------------------------------------------------------------------------------

describe('concurrent operations', () => {
  it('guilds loaded at the same time each end up in the record: nothing is lost (even more guilds than the cache holds)', async () => {
    const guilds = Array.from({ length: 9 }, (_, index) => String(210000000000000000n + BigInt(index)));
    for (const [index, guildId] of guilds.entries()) {
      setWorld([raw(`3000000000000001${index}0`, 4, 'Category', null, 0), raw(`4300000000000001${index}0`, 0, 'plaza', `3000000000000001${index}0`, 1)], guildId);
    }
    let release!: () => void;
    api.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answers = guilds.map((guildId, index) => groupInfo({ guildId, guildName: `Server ${index}` }, index % 2 === 0 ? content : popup));
    await settle();
    release();
    for (const answer of await Promise.all(answers)) expect(answer).toEqual({ ok: true });
    const groups = storedGroups();
    expect(Object.keys(groups)).toHaveLength(guilds.length * 2);
    for (const [index, guildId] of guilds.entries()) {
      expect(groups[guildId]).toMatchObject({ kind: 'guild', guildId, channelIds: [`4300000000000001${index}0`] });
      expect(groups[`3000000000000001${index}0`]).toMatchObject({ kind: 'category', guildId, channelIds: [`4300000000000001${index}0`] });
    }
  });

  it('a server click, a category click, groupInfo calls and row toggles at once: one load, and no write is lost', async () => {
    let release!: () => void;
    api.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rowTargets = Array.from({ length: 10 }, (_, index) => guildTarget(String(440000000000000100n + BigInt(index)), { channelName: `row ${index}`, guildId: OTHER_GUILD }));
    const answers = [
      addGuild(),
      groupInfo({}, popup),
      addCategory(CAT.chat, {}, popup),
      groupInfo(),
      ...rowTargets.map((target) => content.send({ to: 'bg', type: 'queue/toggle', target })),
    ];
    await settle();
    expect(guildRequests()).toEqual([PATH.channels]); // everything waits for the one load
    release();
    for (const answer of await Promise.all(answers)) expect(answer).toMatchObject({ ok: true });
    expect(guildRequests()).toEqual(ALL_PATHS);
    expect(storedGroups()).toEqual(expectedGroups((storedGroups()[GUILD_ID] as GroupInfo).updatedAt));
    // the row toggles needed no answer from Discord and went first; then the server click put the whole server in, and the
    // category click that followed found its category in the list and took it out again
    expect(keys()).toEqual([...rowTargets.map((target) => target.channelId), ...ids(['rules', 'news', 'notes', 'questions'])]);
  });

  it('a group write and a list change never overwrite each other (they share the storage lock)', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => (index % 2 === 0 ? groupInfo() : addCategory(CAT.study))));
    for (const result of results) expect(result).toMatchObject({ ok: true });
    expect(Object.keys(storedGroups())).toHaveLength(5);
    expect(keys()).toEqual(ids(['notes', 'questions'])); // three category clicks: in, out, in
  });
});

// ---- queue/groupInfo ------------------------------------------------------------------------------------------------------------

describe('queue/groupInfo', () => {
  it('answers ok without data, stores the groups, and never touches the list', async () => {
    seedQueue(fake, [item('rules')]);
    await expect(groupInfo()).resolves.toEqual({ ok: true });
    expect(Object.keys(storedGroups())).toHaveLength(5);
    expect(storedQueue(fake)).toEqual([item('rules')]);
    fake.local.set.mockClear();
    await groupInfo();
    expect(fake.local.set.mock.calls.filter(([items]) => LOCAL.queue(ACCOUNT_ID) in (items as object))).toEqual([]);
  });

  it('does not create a list for an account that has none', async () => {
    await groupInfo();
    expect(fake.local.has(LOCAL.queue(ACCOUNT_ID))).toBe(false);
  });

  it('works for a content script and for the popup', async () => {
    await expect(groupInfo({}, content)).resolves.toEqual({ ok: true });
    await expect(groupInfo({}, popup)).resolves.toEqual({ ok: true });
  });

  it('asks for the channel list, the roles, the guild and the own member: allow-listed GETs with the stored authorization', async () => {
    const before = api.calls.length;
    await groupInfo();
    const calls = api.calls.slice(before);
    expect(calls.map((call) => call.url.replace('https://discord.com', ''))).toEqual(ALL_PATHS);
    for (const call of calls) {
      expect(isApiGetPathAllowed(call.url.replace('https://discord.com', ''))).toBe(true);
      expect(call).toMatchObject({ method: 'GET', credentials: 'omit', headers: { Authorization: TOKEN } });
    }
  });

  it('shares the 60 second cache with the buttons: no new request after a click, and the other way round', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    await addGuild();
    expect(guildRequests()).toEqual(ALL_PATHS);
    await groupInfo();
    expect(guildRequests()).toEqual(ALL_PATHS);

    await vi.advanceTimersByTimeAsync(61_000);
    await groupInfo(); // a new load
    expect(guildRequests()).toHaveLength(8);
    await addCategory(CAT.chat);
    await addGuild();
    await groupInfo();
    expect(guildRequests()).toHaveLength(8);
  });

  it('calls at the same time share one load', async () => {
    let release!: () => void;
    api.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answers = [groupInfo(), groupInfo({}, popup), groupInfo({ guildName: null }), groupInfo()];
    await settle();
    expect(guildRequests()).toEqual([PATH.channels]);
    release();
    for (const answer of await Promise.all(answers)) expect(answer).toEqual({ ok: true });
    expect(guildRequests()).toEqual(ALL_PATHS);
    expect(Object.keys(storedGroups())).toHaveLength(5);
  });

  it.each([
    ['guildId is missing', { guildId: undefined }],
    ['guildId is not numeric', { guildId: 'abc' }],
    ['guildId is a number', { guildId: 200000000000000001 }],
    ['guildId tries to leave the path', { guildId: '1/../../users/@me' }],
    ['guildId is empty', { guildId: '' }],
    ['guildName is a number', { guildName: 5 }],
    ['guildName is missing', { guildName: undefined }],
    ['guildName is too long', { guildName: 'g'.repeat(101) }],
  ])('refuses the message when %s, with no request and no change', async (_label, overrides) => {
    const calls = api.calls.length;
    await expect(groupInfo(overrides)).resolves.toMatchObject({ ok: false, error: 'invalid' });
    expect(api.calls).toHaveLength(calls);
    expect(fake.local.has(LOCAL.groups(ACCOUNT_ID))).toBe(false);
  });

  it('accepts a guild name of 100 characters and a missing one (null)', async () => {
    await expect(groupInfo({ guildName: 'g'.repeat(100) })).resolves.toEqual({ ok: true });
    await expect(groupInfo({ guildName: null })).resolves.toEqual({ ok: true });
  });

  it('answers "no-account" without any request when there is no verified account', async () => {
    const other = createFakeBrowser();
    const otherApi = installFakeDiscordApi();
    await bootWorker(other);
    const page = other.createContentScript(7, 'https://discord.com/channels/@me');
    await expect(groupInfo({}, page)).resolves.toEqual({ ok: false, error: 'no-account' });
    expect(otherApi.calls).toHaveLength(0);
    expect(other.local.keys().filter((key) => key.startsWith('dce.groups.'))).toEqual([]);
  });

  it('a token that is stored but not verified (yet) is no account either', async () => {
    const other = createFakeBrowser();
    const otherApi = installFakeDiscordApi();
    otherApi.force = 'network';
    await bootWorker(other);
    other.captureToken(TOKEN);
    await waitFor(() => other.session.has(SESSION.token));
    const page = other.createContentScript(7, 'https://discord.com/channels/@me');
    const calls = otherApi.calls.length;
    await expect(groupInfo({}, page)).resolves.toEqual({ ok: false, error: 'no-account' });
    expect(otherApi.calls).toHaveLength(calls);
  });

  it('maps a failed channel list to "http" and stores nothing; the token stays', async () => {
    api.force = 403;
    await expect(groupInfo()).resolves.toEqual({ ok: false, error: 'http', message: 'HTTP 403' });
    api.force = 'network';
    await expect(groupInfo()).resolves.toEqual({ ok: false, error: 'http', message: 'network error' });
    api.force = null;
    api.guildChannels.delete(GUILD_ID);
    await expect(groupInfo()).resolves.toEqual({ ok: false, error: 'http', message: 'HTTP 404' });
    expect(fake.local.has(LOCAL.groups(ACCOUNT_ID))).toBe(false);
    expect(fake.session.peek(SESSION.token)).toBe(TOKEN);
  });

  it('a 401 on the channel list means the token is dead: it is removed and the answer is "no-account"', async () => {
    api.users.delete(TOKEN);
    await expect(groupInfo()).resolves.toEqual({ ok: false, error: 'no-account' });
    await waitFor(() => !fake.session.has(SESSION.token));
    expect(fake.local.has(LOCAL.groups(ACCOUNT_ID))).toBe(false);
  });

  it('a groups record that cannot be written is an error for this message (its only job), without a secret; the next call works', async () => {
    fake.local.set.mockRejectedValueOnce(new Error(`QUOTA_BYTES quota exceeded while storing ${TOKEN}`));
    const response = await groupInfo();
    expect(response).toMatchObject({ ok: false, error: 'unknown' });
    expect(JSON.stringify(response)).not.toContain(TOKEN);
    await expect(groupInfo()).resolves.toEqual({ ok: true });
    expect(Object.keys(storedGroups())).toHaveLength(5);
  });

  it('never stores or returns the authorization value', async () => {
    const responses = [await groupInfo(), await groupInfo({ guildId: 'abc' })];
    for (const response of responses) expect(JSON.stringify(response)).not.toContain(TOKEN);
    expect(JSON.stringify(fake.local.dump())).not.toContain(TOKEN);
  });
});

// ---- buildGuildGroups -----------------------------------------------------------------------------------------------------------

describe('buildGuildGroups (pure)', () => {
  const channel = (id: string, parentId: string | null) => ({ id, type: 0, kind: 'guild-channel' as const, name: id, parentId, parentName: null });

  it('one guild entry with every channel and one category entry per category id, empty ones included', () => {
    const groups = buildGuildGroups('9', { guildName: null, channels: [channel('1', null), channel('2', '7'), channel('3', '8'), channel('4', '7')], categoryIds: ['7', '8', '6'] }, 42);
    expect(groups).toEqual({
      '9': { kind: 'guild', guildId: '9', channelIds: ['1', '2', '3', '4'], updatedAt: 42, name: null, iconUrl: null },
      '7': { kind: 'category', guildId: '9', channelIds: ['2', '4'], updatedAt: 42, name: null },
      '8': { kind: 'category', guildId: '9', channelIds: ['3'], updatedAt: 42, name: null },
      '6': { kind: 'category', guildId: '9', channelIds: [], updatedAt: 42, name: null },
    });
  });

  it('an empty guild has just its own, empty entry', () => {
    expect(buildGuildGroups('9', { guildName: null, channels: [], categoryIds: [] }, 1)).toEqual({ '9': { kind: 'guild', guildId: '9', channelIds: [], updatedAt: 1, name: null, iconUrl: null } });
  });

  it('names and icon: the guild entry gets the guild\'s name and icon, every category entry its own name', () => {
    const guild = { guildName: 'Server', iconUrl: 'https://cdn.discordapp.com/icons/9/h.png?size=64', channels: [channel('2', '7')], categoryIds: ['7', '6'], categoryNames: { '7': 'Seven' } };
    expect(buildGuildGroups('9', guild, 5)).toEqual({
      '9': { kind: 'guild', guildId: '9', channelIds: ['2'], updatedAt: 5, name: 'Server', iconUrl: 'https://cdn.discordapp.com/icons/9/h.png?size=64' },
      '7': { kind: 'category', guildId: '9', channelIds: ['2'], updatedAt: 5, name: 'Seven' },
      '6': { kind: 'category', guildId: '9', channelIds: [], updatedAt: 5, name: null }, // no name known, none recorded before
    });
  });

  it('what this load does not know is taken from the previous entries of the same id, kind and guild: names and icon', () => {
    const previous: Record<string, GroupInfo> = {
      '9': { kind: 'guild', guildId: '9', channelIds: [], updatedAt: 1, name: 'Old Server', iconUrl: 'https://cdn.discordapp.com/icons/9/old.png?size=64' },
      '7': { kind: 'category', guildId: '9', channelIds: [], updatedAt: 1, name: 'Old Seven' },
      '6': { kind: 'category', guildId: '9', channelIds: [], updatedAt: 1, name: 'Old Six' },
    };
    const partial = { guildName: null, channels: [], categoryIds: ['7', '6', '5'], categoryNames: { '6': 'New Six' } };
    expect(buildGuildGroups('9', partial, 2, previous)).toEqual({
      '9': { kind: 'guild', guildId: '9', channelIds: [], updatedAt: 2, name: 'Old Server', iconUrl: 'https://cdn.discordapp.com/icons/9/old.png?size=64' },
      '7': { kind: 'category', guildId: '9', channelIds: [], updatedAt: 2, name: 'Old Seven' }, // unknown now: kept
      '6': { kind: 'category', guildId: '9', channelIds: [], updatedAt: 2, name: 'New Six' }, // known now: replaced
      '5': { kind: 'category', guildId: '9', channelIds: [], updatedAt: 2, name: null },
    });
    // an entry of another guild, or of another kind under the same id, is not "the previous one"
    const foreign: Record<string, GroupInfo> = {
      '9': { kind: 'category', guildId: '9', channelIds: [], updatedAt: 1, name: 'A category' },
      '7': { kind: 'category', guildId: '8', channelIds: [], updatedAt: 1, name: 'Another guild' },
    };
    expect(buildGuildGroups('9', partial, 2, foreign)['9']).toMatchObject({ name: null, iconUrl: null });
    expect(buildGuildGroups('9', partial, 2, foreign)['7']).toMatchObject({ name: null });
  });

  it('a known icon of null (the server has none) replaces a recorded icon: only "unknown" keeps it', () => {
    const previous: Record<string, GroupInfo> = { '9': { kind: 'guild', guildId: '9', channelIds: [], updatedAt: 1, name: 'S', iconUrl: 'https://cdn.discordapp.com/icons/9/old.png?size=64' } };
    expect(buildGuildGroups('9', { guildName: 'S', iconUrl: null, channels: [], categoryIds: [] }, 2, previous)['9'].iconUrl).toBeNull();
    expect(buildGuildGroups('9', { guildName: 'S', channels: [], categoryIds: [] }, 2, previous)['9'].iconUrl).toBe('https://cdn.discordapp.com/icons/9/old.png?size=64');
  });
});
