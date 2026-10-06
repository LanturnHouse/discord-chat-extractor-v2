/**
 * Names and icons of the groups (5th change, docs/PLAN.md §5.1 `GroupInfo.name` / `iconUrl`, §7.2a): whenever `queue/groupInfo`,
 * `queue/addGuild` or `queue/addCategory` writes `LOCAL.groups`, the server entry also gets the server's name and its icon URL
 * (`https://cdn.discordapp.com/icons/<guildId>/<hash>.png?size=64`, null without an icon) and every category entry its name. A
 * reload that cannot say one of them keeps what was recorded before. The lists of channels and the permission math have their tests
 * in groups.test.ts and guild.test.ts. Fixtures use neutral names and made-up ids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { LOCAL } from '@/shared';
import type { GroupInfo } from '@/shared';
import { guildIconUrl } from '@/background/guild';
import { isDiscordCdnUrl } from '@/background/validate';
import { createFakeBrowser } from './fakeChrome';
import type { FakeBrowser, FakePage } from './fakeChrome';
import { ACCOUNT_ID, GUILD_ID, OTHER_ACCOUNT_ID, bootLoggedIn, seedGuildAccess } from './helpers';
import type { FakeDiscordApi } from './helpers';

let fake: FakeBrowser;
let content: FakePage;
let popup: FakePage;
let api: FakeDiscordApi;
let warn: MockInstance<typeof console.warn>;

beforeEach(async () => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  fake = createFakeBrowser();
  ({ popup, api } = await bootLoggedIn(fake));
  content = fake.createContentScript(7, `https://discord.com/channels/${GUILD_ID}/430000000000000001`);
  setWorld();
});

afterEach(() => {
  warn.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const CAT_STUDY = '300000000000000011';
const CAT_CHAT = '300000000000000012';
const CAT_BLANK = '300000000000000013';
const HASH = 'abcdef0123456789abcdef0123456789';
const iconUrl = (hash: string, guildId = GUILD_ID) => `https://cdn.discordapp.com/icons/${guildId}/${hash}.png?size=64`;

const channel = (id: string, type: number, name: unknown, parentId: string | null, position: number) => ({ id, type, name, parent_id: parentId, position, permission_overwrites: [] });
const defaultChannels = (): unknown[] => [
  channel(CAT_STUDY, 4, 'Study', null, 0),
  channel('430000000000000001', 0, 'notes', CAT_STUDY, 1),
  channel(CAT_CHAT, 4, 'Chat', null, 1),
  channel('430000000000000002', 0, 'lounge', CAT_CHAT, 1),
  channel('430000000000000003', 0, 'rules', null, 0),
];

/** The channel list and the guild object of the world; `guild` overrides fields of the guild object (`name`, `icon`, ...). */
function setWorld(guild: Record<string, unknown> = {}, channels: unknown[] = defaultChannels()): void {
  api.guildChannels.set(GUILD_ID, channels);
  seedGuildAccess(api);
  api.guilds.set(GUILD_ID, { id: GUILD_ID, name: 'Test Server', owner_id: OTHER_ACCOUNT_ID, roles: api.guildRoles.get(GUILD_ID), ...guild });
}

const PATH = {
  channels: `/api/v9/guilds/${GUILD_ID}/channels`,
  roles: `/api/v9/guilds/${GUILD_ID}/roles`,
  guild: `/api/v9/guilds/${GUILD_ID}`,
  member: `/api/v9/users/@me/guilds/${GUILD_ID}/member`,
  memberAtMe: `/api/v9/guilds/${GUILD_ID}/members/@me`,
};

const groupInfo = (overrides: Record<string, unknown> = {}, from: FakePage = content) =>
  from.send({ to: 'bg', type: 'queue/groupInfo', guildId: GUILD_ID, guildName: 'Page Name', ...overrides });
const addGuild = (overrides: Record<string, unknown> = {}, from: FakePage = content) =>
  from.send({ to: 'bg', type: 'queue/addGuild', guildId: GUILD_ID, guildName: 'Page Name', ...overrides });
const addCategory = (overrides: Record<string, unknown> = {}, from: FakePage = content) =>
  from.send({ to: 'bg', type: 'queue/addCategory', guildId: GUILD_ID, guildName: 'Page Name', categoryId: CAT_STUDY, categoryName: 'Page Category', ...overrides });

const storedGroups = (accountId = ACCOUNT_ID): Record<string, GroupInfo> => fake.local.peek<Record<string, GroupInfo>>(LOCAL.groups(accountId)) ?? {};
const server = () => storedGroups()[GUILD_ID];
/** Lets the cached load (60 s) expire so the next call asks Discord again. */
const expireCache = () => vi.advanceTimersByTimeAsync(61_000);

// ---- the server entry -----------------------------------------------------------------------------------------------------------

describe('the server entry: name', () => {
  it('is the name of the guild object, not the one the page sent', async () => {
    setWorld({ name: 'Real Name' });
    await groupInfo({ guildName: 'Page Name' });
    expect(server().name).toBe('Real Name');
  });

  it.each([
    ['no name', { name: undefined }],
    ['an empty name', { name: '' }],
    ['a blank name', { name: '   ' }],
    ['a name that is not a string', { name: 5 }],
    ['a name of 101 characters', { name: 'x'.repeat(101) }],
  ])('falls back to the name the page sent when the guild object has %s', async (_label, guild) => {
    setWorld(guild);
    await groupInfo({ guildName: 'Page Name' });
    expect(server().name).toBe('Page Name');
  });

  it('falls back to the page\'s name when the guild object cannot be loaded at all', async () => {
    api.pathFailures.set(PATH.guild, 500);
    await groupInfo({ guildName: 'Page Name' });
    expect(server().name).toBe('Page Name');
  });

  it('is null when nobody knows it (no guild object, the page sent none)', async () => {
    api.pathFailures.set(PATH.guild, 500);
    await groupInfo({ guildName: null });
    expect(server().name).toBeNull();
  });

  it('is cleaned like every name: control and bidi characters go, blanks collapse', async () => {
    setWorld({ name: '  Test‮ \u0007Server​  ' });
    await groupInfo();
    expect(server().name).toBe('Test Server');
  });

  it('every server has its own name', async () => {
    const other = '200000000000000002';
    api.guildChannels.set(other, [channel('430000000000000051', 0, 'plaza', null, 0)]);
    seedGuildAccess(api, other);
    api.guilds.set(other, { id: other, name: 'Other Server', owner_id: OTHER_ACCOUNT_ID, roles: api.guildRoles.get(other) });
    await groupInfo();
    await groupInfo({ guildId: other, guildName: 'Other Page Name' });
    expect(storedGroups()[GUILD_ID].name).toBe('Test Server');
    expect(storedGroups()[other].name).toBe('Other Server');
  });
});

describe('the server entry: icon', () => {
  it('is the 64 px png of the icon hash on the Discord CDN', async () => {
    setWorld({ icon: HASH });
    await groupInfo();
    expect(server().iconUrl).toBe(`https://cdn.discordapp.com/icons/${GUILD_ID}/${HASH}.png?size=64`);
    expect(isDiscordCdnUrl(server().iconUrl)).toBe(true);
  });

  it('an animated icon (a_ hash) is requested as a png too', async () => {
    setWorld({ icon: 'a_0123456789abcdef0123456789abcdef' });
    await groupInfo();
    expect(server().iconUrl).toBe(iconUrl('a_0123456789abcdef0123456789abcdef'));
    expect(server().iconUrl).not.toContain('.gif');
  });

  it.each([
    ['null', { icon: null }],
    ['missing', { icon: undefined }],
  ])('no icon: null (the field is %s)', async (_label, guild) => {
    setWorld(guild);
    await groupInfo();
    expect(server()).toMatchObject({ name: 'Test Server', iconUrl: null }); // the guild object WAS loaded: the icon is known to be absent
    expect('iconUrl' in server()).toBe(true);
  });

  it.each([
    ['a path', '../../x'],
    ['a space', 'ab cd'],
    ['an extension', 'abc.png'],
    ['a query', 'abc?size=4096'],
    ['a slash', 'abc/def'],
    ['a fragment', 'abc#x'],
    ['a backslash', 'abc\\def'],
    ['a non-ASCII letter', 'abcé'],
    ['markup', '<script>'],
    ['an empty string', ''],
    ['65 characters', 'a'.repeat(65)],
    ['a number', 5],
    ['a boolean', true],
    ['an object', { hash: HASH }],
  ])('a hash with %s is not a hash: no icon, never a URL built from it', async (_label, icon) => {
    setWorld({ icon });
    await groupInfo();
    expect(server().iconUrl).toBeNull();
    expect(JSON.stringify(fake.local.dump())).not.toMatch(/icons\/[^"]*(\.\.|<|\?size=4096)/);
  });

  it('a hash of letters, digits and underscores is accepted: 1 to 64 characters', async () => {
    for (const hash of ['a', 'A_9', 'a'.repeat(64), 'a_Z09_z']) {
      expect(guildIconUrl(GUILD_ID, hash)).toBe(iconUrl(hash));
    }
  });

  it('is built with the server\'s id, whatever the page said', async () => {
    setWorld({ icon: HASH, id: '999999999999999999' });
    await groupInfo();
    expect(server().iconUrl).toBe(iconUrl(HASH, GUILD_ID));
  });
});

describe('guildIconUrl (pure)', () => {
  it('builds the URL for a good hash and refuses everything else', () => {
    expect(guildIconUrl('5', 'abc123')).toBe('https://cdn.discordapp.com/icons/5/abc123.png?size=64');
    for (const hash of [null, undefined, '', 'a b', 'a/b', 'a.b', 'a?b', 'a&b', 'a%2e', 7, {}, [], 'x'.repeat(65)]) expect(guildIconUrl('5', hash)).toBeNull();
  });
});

// ---- the category entries --------------------------------------------------------------------------------------------------------

describe('the category entries: name', () => {
  it('every category entry has the name from the channel list', async () => {
    await groupInfo();
    expect(storedGroups()[CAT_STUDY]).toMatchObject({ kind: 'category', channelIds: ['430000000000000001'], name: 'Study' });
    expect(storedGroups()[CAT_CHAT]).toMatchObject({ kind: 'category', channelIds: ['430000000000000002'], name: 'Chat' });
  });

  it('a category without readable channels has its name too', async () => {
    setWorld({}, [channel(CAT_BLANK, 4, 'Empty', null, 0)]);
    await groupInfo();
    expect(storedGroups()[CAT_BLANK]).toMatchObject({ kind: 'category', channelIds: [], name: 'Empty' });
  });

  it('a category entry never has an icon', async () => {
    setWorld({ icon: HASH });
    await groupInfo();
    for (const [id, entry] of Object.entries(storedGroups())) if (id !== GUILD_ID) expect('iconUrl' in entry).toBe(false);
  });

  it('is cleaned, and a category without a usable name is recorded with a null name', async () => {
    setWorld({}, [
      channel(CAT_STUDY, 4, ' St‮udy\u0007 ', null, 0),
      channel(CAT_CHAT, 4, '   ', null, 1),
      channel(CAT_BLANK, 4, 5, null, 2),
      channel('300000000000000014', 4, 'x'.repeat(101), null, 3),
      { id: '300000000000000015', type: 4, position: 4, permission_overwrites: [] }, // no name at all
    ]);
    await groupInfo();
    expect(storedGroups()[CAT_STUDY].name).toBe('Study');
    for (const id of [CAT_CHAT, CAT_BLANK, '300000000000000014', '300000000000000015']) expect(storedGroups()[id]).toMatchObject({ kind: 'category', name: null });
  });

  it('the name a button sent for its category is not used: the channel list is the source', async () => {
    await addCategory({ categoryName: 'Page Category' });
    expect(storedGroups()[CAT_STUDY].name).toBe('Study');
  });
});

// ---- every writer ---------------------------------------------------------------------------------------------------------------

describe.each([
  ['queue/groupInfo', (from: FakePage) => groupInfo({}, from)],
  ['queue/addGuild', (from: FakePage) => addGuild({}, from)],
  ['queue/addCategory', (from: FakePage) => addCategory({}, from)],
])('%s records the names and the icon', (_label, send) => {
  it('for a content script and for the popup', async () => {
    setWorld({ name: 'Real Name', icon: HASH });
    for (const from of [content, popup]) {
      fake.local.seed({ [LOCAL.groups(ACCOUNT_ID)]: {} });
      await send(from);
      expect(server()).toMatchObject({ kind: 'guild', guildId: GUILD_ID, name: 'Real Name', iconUrl: iconUrl(HASH) });
      expect(storedGroups()[CAT_STUDY]).toMatchObject({ kind: 'category', guildId: GUILD_ID, name: 'Study' });
      expect(storedGroups()[CAT_CHAT]).toMatchObject({ name: 'Chat' });
    }
  });

  it('uses the name of the page when the guild object cannot be loaded', async () => {
    api.pathFailures.set(PATH.guild, 404);
    await send(content);
    expect(server().name).toBe('Page Name');
    expect(storedGroups()[CAT_STUDY].name).toBe('Study');
  });
});

// ---- a reload that lacks a value keeps the recorded one -------------------------------------------------------------------------------

describe('a reload that cannot say a name or the icon keeps the recorded value', () => {
  const recorded = (): Record<string, GroupInfo> => ({
    [GUILD_ID]: { kind: 'guild', guildId: GUILD_ID, channelIds: [], updatedAt: 1, name: 'Recorded Server', iconUrl: iconUrl('recorded0123') },
    [CAT_STUDY]: { kind: 'category', guildId: GUILD_ID, channelIds: [], updatedAt: 1, name: 'Recorded Study' },
    [CAT_CHAT]: { kind: 'category', guildId: GUILD_ID, channelIds: [], updatedAt: 1, name: 'Recorded Chat' },
  });

  beforeEach(() => fake.local.seed({ [LOCAL.groups(ACCOUNT_ID)]: recorded() }));

  it('the guild object cannot be loaded and the page sent no name: the recorded name and icon stay', async () => {
    api.pathFailures.set(PATH.guild, 500);
    await groupInfo({ guildName: null });
    expect(server()).toMatchObject({ name: 'Recorded Server', iconUrl: iconUrl('recorded0123') });
    expect(server().channelIds).toEqual(['430000000000000003', '430000000000000001', '430000000000000002']); // the rest IS refreshed
    expect(server().updatedAt).toBeGreaterThan(1);
  });

  it('the guild object cannot be loaded but the page sent a name: the page\'s name is newer than the recorded one, the icon stays', async () => {
    api.pathFailures.set(PATH.guild, 500);
    await groupInfo({ guildName: 'Page Name' });
    expect(server()).toMatchObject({ name: 'Page Name', iconUrl: iconUrl('recorded0123') });
  });

  it('a complete load replaces the recorded name and icon', async () => {
    setWorld({ name: 'Renamed', icon: 'newhash9876' });
    await groupInfo({ guildName: null });
    expect(server()).toMatchObject({ name: 'Renamed', iconUrl: iconUrl('newhash9876') });
    expect(storedGroups()[CAT_STUDY].name).toBe('Study');
    expect(storedGroups()[CAT_CHAT].name).toBe('Chat');
  });

  it('a server that really lost its icon (the guild object says null) has none any more: only "unknown" keeps it', async () => {
    setWorld({ icon: null });
    await groupInfo();
    expect(server().iconUrl).toBeNull();
  });

  it('a category without a usable name in the new list keeps its recorded name', async () => {
    setWorld({}, [channel(CAT_STUDY, 4, '   ', null, 0), channel(CAT_CHAT, 4, 'Chat Renamed', null, 1)]);
    await groupInfo();
    expect(storedGroups()[CAT_STUDY].name).toBe('Recorded Study');
    expect(storedGroups()[CAT_CHAT].name).toBe('Chat Renamed');
  });

  it('a category that is gone is gone, with its name; a new one has just the name it has', async () => {
    setWorld({}, [channel(CAT_BLANK, 4, 'Fresh', null, 0)]);
    await groupInfo();
    expect(Object.keys(storedGroups()).sort()).toEqual([GUILD_ID, CAT_BLANK].sort());
    expect(storedGroups()[CAT_BLANK].name).toBe('Fresh');
  });

  it('the recorded values of another server are never used for this one', async () => {
    const other = '200000000000000002';
    fake.local.seed({
      [LOCAL.groups(ACCOUNT_ID)]: {
        ...recorded(),
        [other]: { kind: 'guild', guildId: other, channelIds: [], updatedAt: 1, name: 'Other Recorded', iconUrl: iconUrl('other', other) },
      },
    });
    api.pathFailures.set(PATH.guild, 500);
    await groupInfo({ guildName: null });
    expect(storedGroups()[other]).toMatchObject({ name: 'Other Recorded', iconUrl: iconUrl('other', other) });
    expect(server().name).toBe('Recorded Server');
  });

  it('the recorded values of another account are never used', async () => {
    fake.local.seed({ [LOCAL.groups(ACCOUNT_ID)]: {}, [LOCAL.groups(OTHER_ACCOUNT_ID)]: recorded() });
    api.pathFailures.set(PATH.guild, 500);
    await groupInfo({ guildName: null });
    expect(server()).toMatchObject({ name: null, iconUrl: null });
  });

  it('a record from before the 5th change (no names, no icon) is filled in by the next complete load', async () => {
    fake.local.seed({ [LOCAL.groups(ACCOUNT_ID)]: { [GUILD_ID]: { kind: 'guild', guildId: GUILD_ID, channelIds: ['430000000000000003'], updatedAt: 1 } } });
    setWorld({ name: 'Real Name', icon: HASH });
    await groupInfo();
    expect(server()).toMatchObject({ name: 'Real Name', iconUrl: iconUrl(HASH) });
  });

  it('the same after a complete load that was cached: the next load, 60 seconds later, is a partial one', async () => {
    fake.local.seed({ [LOCAL.groups(ACCOUNT_ID)]: {} });
    vi.useFakeTimers();
    setWorld({ name: 'Real Name', icon: HASH });
    await groupInfo({ guildName: null });
    expect(server()).toMatchObject({ name: 'Real Name', iconUrl: iconUrl(HASH) });
    await expireCache();
    api.pathFailures.set(PATH.guild, 503);
    await groupInfo({ guildName: null });
    expect(server()).toMatchObject({ name: 'Real Name', iconUrl: iconUrl(HASH) });
    expect(storedGroups()[CAT_STUDY].name).toBe('Study');
  });
});

// ---- the fallback paths -----------------------------------------------------------------------------------------------------------

describe('the permission data cannot be loaded: the names are written all the same', () => {
  it('the member data is missing: the guild object (name, icon) and the category names are recorded; the channels are not filtered', async () => {
    setWorld({ name: 'Real Name', icon: HASH });
    api.pathFailures.set(PATH.member, 403);
    api.pathFailures.set(PATH.memberAtMe, 403);
    await expect(groupInfo({ guildName: null })).resolves.toEqual({ ok: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(server()).toMatchObject({ name: 'Real Name', iconUrl: iconUrl(HASH) });
    expect(storedGroups()[CAT_STUDY].name).toBe('Study');
    expect(storedGroups()[CAT_CHAT].name).toBe('Chat');
  });

  it('the roles are missing too: still the same', async () => {
    setWorld({ name: 'Real Name', icon: HASH, roles: undefined });
    api.pathFailures.set(PATH.roles, 500);
    api.pathFailures.set(PATH.member, 403);
    api.pathFailures.set(PATH.memberAtMe, 403);
    await groupInfo({ guildName: null });
    expect(server()).toMatchObject({ name: 'Real Name', iconUrl: iconUrl(HASH) });
  });

  it('nothing but the channel list: the category names from it, the server\'s name from the page, no icon', async () => {
    api.pathFailures.set(PATH.roles, 500);
    api.pathFailures.set(PATH.guild, 500);
    api.pathFailures.set(PATH.member, 500);
    api.pathFailures.set(PATH.memberAtMe, 500);
    await expect(addGuild({ guildName: 'Page Name' })).resolves.toMatchObject({ ok: true });
    expect(server()).toMatchObject({ name: 'Page Name', iconUrl: null });
    expect(storedGroups()[CAT_STUDY].name).toBe('Study');
  });

  it('the fallback load does not erase what a complete one recorded: the next complete load is not needed to keep it', async () => {
    fake.local.seed({ [LOCAL.groups(ACCOUNT_ID)]: {} });
    setWorld({ name: 'Real Name', icon: HASH });
    await groupInfo({ guildName: null });
    vi.useFakeTimers();
    await expireCache();
    api.pathFailures.set(PATH.guild, 500);
    api.pathFailures.set(PATH.roles, 500);
    api.pathFailures.set(PATH.member, 500);
    api.pathFailures.set(PATH.memberAtMe, 500);
    await groupInfo({ guildName: null });
    expect(server()).toMatchObject({ name: 'Real Name', iconUrl: iconUrl(HASH) });
    expect(storedGroups()[CAT_CHAT].name).toBe('Chat');
  });
});

// ---- what is stored ------------------------------------------------------------------------------------------------------------------

describe('what is stored', () => {
  it('reads back unchanged through the lenient normaliser (names and icon are valid), and an identical reload is not written again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    setWorld({ name: 'Real Name', icon: HASH });
    await groupInfo();
    const stored = storedGroups();
    fake.local.set.mockClear();
    await groupInfo();
    expect(fake.local.set).not.toHaveBeenCalled(); // nothing changed, not even the time
    expect(storedGroups()).toEqual(stored);
  });

  it('holds no secret and no URL outside the Discord CDN', async () => {
    setWorld({ name: 'Real Name', icon: HASH });
    await groupInfo();
    const text = JSON.stringify(storedGroups());
    expect(text).not.toMatch(/https?:\/\/(?!cdn\.discordapp\.com\/icons\/)/);
  });
});
