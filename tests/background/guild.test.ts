/**
 * `queue/addGuild` (the server button) and the permission filter it shares with `queue/addCategory` (docs/PLAN.md §2, §3, §5.3):
 * which channels are added and in which order, who may read what, what happens when the permission data cannot be loaded, and
 * which requests are made (every endpoint at most once per operation, a complete answer reused for 60 s).
 *
 * The permission math itself belongs to the v1 library and has its own tests (tests/lib/discord/permissions.test.ts); what is
 * pinned here is the wiring: the guild id is the @everyone role, the account id is the member overwrite, the owner comes from the
 * guild object, the member's roles from either member endpoint, the roles from the roles endpoint or else the guild object.
 * Fixtures use neutral names and made-up ids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { SESSION, isApiGetPathAllowed } from '@/shared';
import { ADMINISTRATOR, READ_MESSAGE_HISTORY, VIEW_CHANNEL } from '@/lib/discord/permissions';
import { createFakeBrowser } from './fakeChrome';
import type { FakeBrowser, FakePage } from './fakeChrome';
import {
  ACCOUNT_ID,
  CATEGORY_ID,
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
});

afterEach(() => {
  warn.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---- fixtures ------------------------------------------------------------------------------------------------------------------

const EVERYONE = GUILD_ID; // the @everyone role has the id of the guild
const ROLE_MEMBER = '600000000000000001';
const ROLE_ADMIN = '600000000000000002';
const ROLE_OTHER = '600000000000000003';
const READ = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
const bits = (value: bigint): string => value.toString();

const role = (id: string, permissions: bigint) => ({ id, name: `role ${id}`, permissions: bits(permissions), position: 1, color: 0, managed: false });
const overwrite = (id: string, type: 0 | 1, allow: bigint, deny: bigint) => ({ id, type, allow: bits(allow), deny: bits(deny) });

let counter = 0;
/** A channel as `GET guilds/{id}/channels` sends it. */
const channel = (name: string, type = 0, extra: Record<string, unknown> = {}) => ({
  id: String(410000000000000000n + BigInt(++counter)),
  type,
  name,
  parent_id: null,
  position: 0,
  permission_overwrites: [],
  nsfw: false,
  ...extra,
});
const category = (name: string, extra: Record<string, unknown> = {}) => channel(name, 4, extra);

interface World {
  channels: unknown[];
  /** The guild's roles; default: @everyone may read. */
  roles?: unknown[];
  /** The roles of the account (the member record). */
  memberRoles?: string[];
  /** The account owns the guild. */
  owner?: boolean;
}

/** Fills every endpoint the worker asks for. */
function setWorld({ channels, roles = [role(EVERYONE, READ)], memberRoles = [], owner = false }: World): void {
  api.guildChannels.set(GUILD_ID, channels);
  api.guildRoles.set(GUILD_ID, roles);
  api.guilds.set(GUILD_ID, { id: GUILD_ID, name: 'Server From Discord', owner_id: owner ? ACCOUNT_ID : OTHER_ACCOUNT_ID, roles });
  api.members.set(GUILD_ID, { user: { id: ACCOUNT_ID }, nick: null, roles: memberRoles });
}

const addGuild = (overrides: Record<string, unknown> = {}, from: FakePage = content) =>
  from.send({ to: 'bg', type: 'queue/addGuild', guildId: GUILD_ID, guildName: 'Test Server', ...overrides });
const addCategory = (overrides: Record<string, unknown> = {}, from: FakePage = content) =>
  from.send({ to: 'bg', type: 'queue/addCategory', guildId: GUILD_ID, guildName: 'Test Server', categoryId: CATEGORY_ID, categoryName: 'Study', ...overrides });

const names = (accountId = ACCOUNT_ID) => storedQueue(fake, accountId).map((item) => item.target.channelName);

const PATH = {
  channels: `/api/v9/guilds/${GUILD_ID}/channels`,
  roles: `/api/v9/guilds/${GUILD_ID}/roles`,
  guild: `/api/v9/guilds/${GUILD_ID}`,
  member: `/api/v9/users/@me/guilds/${GUILD_ID}/member`,
  memberAtMe: `/api/v9/guilds/${GUILD_ID}/members/@me`,
};
const ALL_PATHS = [PATH.channels, PATH.roles, PATH.guild, PATH.member];
/** The guild requests made so far, as paths (the account check `users/@me` is not one of them). */
const guildRequests = () => api.calls.map((call) => call.url.replace('https://discord.com', '')).filter((path) => path.includes('/guilds/'));
const warnings = () => warn.mock.calls.map((args) => args.join(' '));

// ---- the channels --------------------------------------------------------------------------------------------------------------

describe('queue/addGuild: which channels', () => {
  it('adds the text, announcement, forum and media channels, and no other kind of channel', async () => {
    setWorld({
      owner: true, // may do everything: only the type can keep a channel out
      channels: [
        channel('text', 0),
        channel('dm', 1),
        channel('voice', 2),
        channel('group dm', 3),
        category('a category', { id: CATEGORY_ID }),
        channel('news', 5),
        channel('news thread', 10),
        channel('public thread', 11),
        channel('private thread', 12),
        channel('stage', 13),
        channel('directory', 14),
        channel('forum', 15),
        channel('media', 16),
        channel('unknown kind', 99),
      ],
    });
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 4, skipped: 0, removed: 0 } });
    expect(storedQueue(fake).map((item) => [item.target.channelName, item.target.kind, item.target.channelType])).toEqual([
      ['text', 'guild-channel', 0],
      ['news', 'guild-channel', 5],
      ['forum', 'forum', 15],
      ['media', 'forum', 16],
    ]);
  });

  it('puts every channel in with settings null (it follows the common settings) and a complete target', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    const study = category('Study', { id: CATEGORY_ID, position: 1 });
    const welcome = channel('welcome');
    const questions = channel('questions', 15, { parent_id: CATEGORY_ID, position: 2 });
    const notes = channel('notes', 0, { parent_id: CATEGORY_ID, position: 1 });
    setWorld({ channels: [study, questions, notes, welcome] });
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 3, skipped: 0, removed: 0 } });
    const base = { guildId: GUILD_ID, guildName: 'Test Server' };
    expect(storedQueue(fake)).toEqual([
      { key: welcome.id, settings: null, addedAt: 1_760_000_000_000, target: { ...base, kind: 'guild-channel', channelId: welcome.id, channelName: 'welcome', channelType: 0, parentId: null, parentName: null } },
      { key: notes.id, settings: null, addedAt: 1_760_000_000_000, target: { ...base, kind: 'guild-channel', channelId: notes.id, channelName: 'notes', channelType: 0, parentId: CATEGORY_ID, parentName: 'Study' } },
      { key: questions.id, settings: null, addedAt: 1_760_000_000_000, target: { ...base, kind: 'forum', channelId: questions.id, channelName: 'questions', channelType: 15, parentId: CATEGORY_ID, parentName: 'Study' } },
    ]);
  });

  it("is ordered like Discord's sidebar: channels without a category first, then category by category (position, then id)", async () => {
    const alpha = category('Alpha', { id: '300000000000000011', position: 1 });
    const beta = category('Beta', { id: '300000000000000012', position: 2 });
    setWorld({
      channels: [
        // the API's own order means nothing
        beta,
        channel('b-one', 0, { parent_id: beta.id, position: 0 }),
        channel('lobby', 0, { position: 5 }),
        alpha,
        channel('a-two', 0, { parent_id: alpha.id, position: 2 }),
        channel('a-tie-b', 0, { id: '420000000000000002', parent_id: alpha.id, position: 3 }),
        channel('rules', 15, { position: 2 }),
        channel('a-tie-a', 0, { id: '420000000000000001', parent_id: alpha.id, position: 3 }),
        channel('a-one', 5, { parent_id: alpha.id, position: 1 }),
        channel('orphan', 0, { parent_id: '300000000000000099', position: 9 }), // its category is not in the list: shown among the loose ones
        channel('b-voice', 2, { parent_id: beta.id, position: -1 }),
      ],
    });
    await addGuild();
    expect(names()).toEqual(['rules', 'lobby', 'orphan', 'a-one', 'a-two', 'a-tie-a', 'a-tie-b', 'b-one']);
  });

  it('puts the loose channels first even when a category has the smaller position', async () => {
    const early = category('Early', { id: '300000000000000021', position: 0 });
    setWorld({ channels: [early, channel('in category', 0, { parent_id: early.id, position: 0 }), channel('loose', 0, { position: 50 })] });
    await addGuild();
    expect(names()).toEqual(['loose', 'in category']);
  });

  it('some of the channels are in the list: only the missing ones are added; the others are skipped and keep their own settings', async () => {
    const rules = channel('rules');
    const general = channel('general');
    const random = channel('random');
    setWorld({ channels: [rules, general, random] });
    const own = queueItem(guildTarget(general.id, { channelName: 'general' }), {
      settings: exportSettings({ format: 'csv' }),
      addedAt: 5,
      lastResult: { status: 'failed', message: 'x', at: 6 },
    });
    seedQueue(fake, [queueItem(dmTarget()), own]);
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 2, skipped: 1, removed: 0 } });
    const stored = storedQueue(fake);
    expect(stored[0].key).toBe(DM_CHANNEL);
    expect(stored[1]).toEqual(own);
    expect(stored.slice(2).map((item) => item.target.channelName)).toEqual(['rules', 'random']);
  });

  it('is a toggle: when every readable channel is in the list, the next click takes exactly those out (the matrix is in groups.test.ts)', async () => {
    const rules = channel('rules');
    const general = channel('general');
    setWorld({ channels: [rules, general] });
    seedQueue(fake, [queueItem(dmTarget())]);
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 2, skipped: 0, removed: 0 } });
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 2 } });
    expect(storedQueue(fake).map((item) => item.key)).toEqual([DM_CHANNEL]);
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 2, skipped: 0, removed: 0 } });
  });

  it('takes the guild name from the message when it has one', async () => {
    setWorld({ channels: [channel('general')] });
    await addGuild({ guildName: 'From The Message' });
    expect(storedQueue(fake)[0].target.guildName).toBe('From The Message');
  });

  it('else from the guild object', async () => {
    setWorld({ channels: [channel('general')] });
    await addGuild({ guildName: null });
    expect(storedQueue(fake)[0].target.guildName).toBe('Server From Discord');
  });

  it('else leaves it out (the page did not know it and the guild object cannot be loaded)', async () => {
    setWorld({ channels: [channel('general')] });
    api.guilds.delete(GUILD_ID);
    await addGuild({ guildName: null });
    expect(storedQueue(fake)[0].target.guildName).toBeNull();
  });

  it('leaves out a channel without a usable name and answers with what it could add', async () => {
    setWorld({ channels: [channel('ok'), channel('   '), { ...channel('x'), name: 5 }, { ...channel('x'), name: undefined }, { ...channel('bad id'), id: 'abc' }, null, 'junk'] });
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 1, skipped: 0, removed: 0 } });
    expect(names()).toEqual(['ok']);
  });

  it('works for the popup as well', async () => {
    setWorld({ channels: [channel('general')] });
    await expect(addGuild({}, popup)).resolves.toEqual({ ok: true, data: { added: 1, skipped: 0, removed: 0 } });
  });

  it('an empty guild has nothing to add', async () => {
    setWorld({ channels: [] });
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 0 } });
    expect(storedQueue(fake)).toEqual([]);
  });

  it('an answer that is not a list is treated as an empty guild', async () => {
    setWorld({ channels: [] });
    api.guildChannels.set(GUILD_ID, { message: 'weird' });
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 0 } });
    expect(storedQueue(fake)).toEqual([]);
  });
});

// ---- who may read what ---------------------------------------------------------------------------------------------------------

describe('the permission filter (VIEW_CHANNEL and READ_MESSAGE_HISTORY)', () => {
  interface Case {
    overwrites?: unknown[];
    roles?: unknown[];
    memberRoles?: string[];
    owner?: boolean;
    type?: number;
  }
  const denyEveryone = overwrite(EVERYONE, 0, 0n, VIEW_CHANNEL);
  const cases: Array<[string, Case, boolean]> = [
    ['a channel without overwrites is readable for a plain member', {}, true],
    ['hidden: @everyone is denied VIEW_CHANNEL', { overwrites: [denyEveryone] }, false],
    ['no history: @everyone is denied READ_MESSAGE_HISTORY', { overwrites: [overwrite(EVERYONE, 0, 0n, READ_MESSAGE_HISTORY)] }, false],
    ['no history: the roles of the member only grant VIEW_CHANNEL', { roles: [role(EVERYONE, VIEW_CHANNEL)] }, false],
    ['no view: the roles of the member only grant READ_MESSAGE_HISTORY', { roles: [role(EVERYONE, READ_MESSAGE_HISTORY)] }, false],
    [
      'the missing bit comes from another role of the member',
      { roles: [role(EVERYONE, VIEW_CHANNEL), role(ROLE_MEMBER, READ_MESSAGE_HISTORY)], memberRoles: [ROLE_MEMBER] },
      true,
    ],
    [
      'the missing bit is granted to a role the member does not have',
      { roles: [role(EVERYONE, VIEW_CHANNEL), role(ROLE_MEMBER, READ_MESSAGE_HISTORY)], memberRoles: [] },
      false,
    ],
    ['the owner: nothing can hide a channel', { owner: true, roles: [role(EVERYONE, 0n)], overwrites: [overwrite(EVERYONE, 0, 0n, READ)] }, true],
    [
      'an ADMINISTRATOR role of the member: nothing can hide a channel',
      { roles: [role(EVERYONE, 0n), role(ROLE_ADMIN, ADMINISTRATOR)], memberRoles: [ROLE_ADMIN], overwrites: [overwrite(EVERYONE, 0, 0n, READ)] },
      true,
    ],
    [
      'an ADMINISTRATOR role the member does not have is no help',
      { roles: [role(EVERYONE, READ), role(ROLE_ADMIN, ADMINISTRATOR)], memberRoles: [], overwrites: [denyEveryone] },
      false,
    ],
    [
      '@everyone is denied, a role of the member is allowed',
      { roles: [role(EVERYONE, READ), role(ROLE_MEMBER, 0n)], memberRoles: [ROLE_MEMBER], overwrites: [denyEveryone, overwrite(ROLE_MEMBER, 0, VIEW_CHANNEL, 0n)] },
      true,
    ],
    [
      '@everyone is denied, the allowed role is not the member\'s',
      { roles: [role(EVERYONE, READ), role(ROLE_MEMBER, 0n), role(ROLE_OTHER, 0n)], memberRoles: [ROLE_MEMBER], overwrites: [denyEveryone, overwrite(ROLE_OTHER, 0, VIEW_CHANNEL, 0n)] },
      false,
    ],
    [
      'the member\'s own overwrite denies, whatever the roles allow',
      { roles: [role(EVERYONE, READ), role(ROLE_MEMBER, 0n)], memberRoles: [ROLE_MEMBER], overwrites: [overwrite(ROLE_MEMBER, 0, VIEW_CHANNEL, 0n), overwrite(ACCOUNT_ID, 1, 0n, VIEW_CHANNEL)] },
      false,
    ],
    ['the member\'s own overwrite allows, whatever @everyone is denied', { overwrites: [denyEveryone, overwrite(ACCOUNT_ID, 1, VIEW_CHANNEL, 0n)] }, true],
    ['the overwrite of somebody else does not count', { overwrites: [overwrite(OTHER_ACCOUNT_ID, 1, 0n, VIEW_CHANNEL)] }, true],
    ['the same rule for an announcement channel: hidden', { type: 5, overwrites: [denyEveryone] }, false],
    ['the same rule for a forum channel: readable', { type: 15 }, true],
    ['the same rule for a forum channel: hidden', { type: 15, overwrites: [denyEveryone] }, false],
    ['the same rule for a media channel: readable', { type: 16 }, true],
    ['the same rule for a media channel: no history', { type: 16, overwrites: [overwrite(EVERYONE, 0, 0n, READ_MESSAGE_HISTORY)] }, false],
  ];

  it.each(cases)('%s', async (_label, setup, readable) => {
    setWorld({ channels: [channel('target', setup.type ?? 0, { permission_overwrites: setup.overwrites ?? [] })], roles: setup.roles, memberRoles: setup.memberRoles, owner: setup.owner });
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: readable ? 1 : 0, skipped: 0, removed: 0 } });
    expect(names()).toEqual(readable ? ['target'] : []);
    expect(warnings()).toEqual([]); // every input was there: no fallback
  });

  it('keeps the readable channels and drops the others in one list', async () => {
    setWorld({
      channels: [
        channel('open'),
        channel('hidden', 0, { permission_overwrites: [denyEveryone] }),
        channel('allowed', 0, { permission_overwrites: [denyEveryone, overwrite(ROLE_MEMBER, 0, VIEW_CHANNEL, 0n)] }),
        channel('forum', 15),
      ],
      roles: [role(EVERYONE, READ), role(ROLE_MEMBER, 0n)],
      memberRoles: [ROLE_MEMBER],
    });
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 3, skipped: 0, removed: 0 } });
    expect(names()).toEqual(['open', 'allowed', 'forum']);
  });

  it('the same member without the role sees fewer channels', async () => {
    setWorld({
      channels: [channel('open'), channel('allowed', 0, { permission_overwrites: [denyEveryone, overwrite(ROLE_MEMBER, 0, VIEW_CHANNEL, 0n)] })],
      roles: [role(EVERYONE, READ), role(ROLE_MEMBER, 0n)],
      memberRoles: [],
    });
    await addGuild();
    expect(names()).toEqual(['open']);
  });

  it('reads malformed overwrites and roles leniently: what cannot be read is ignored', async () => {
    setWorld({
      channels: [
        channel('target', 0, {
          permission_overwrites: [null, 'x', { id: 'abc', type: 0, allow: '0', deny: '1024' }, { id: EVERYONE, type: 7, allow: '0', deny: '1024' }, { id: EVERYONE, type: 0, allow: 5, deny: 'nope' }],
        }),
      ],
      roles: [null, { id: 'abc', permissions: '8' }, { id: EVERYONE, permissions: bits(READ) }] as unknown[],
    });
    await addGuild();
    expect(names()).toEqual(['target']);
  });

  describe('category sync', () => {
    // Discord copies a category's overwrites into the channels that follow it: a synced channel carries the same
    // `permission_overwrites` as its category, and only a channel's own overwrites count (as in v1).
    const privateOverwrites = [denyEveryone, overwrite(ROLE_MEMBER, 0, VIEW_CHANNEL, 0n)];
    const roles = [role(EVERYONE, READ), role(ROLE_MEMBER, 0n)];
    const channels = () => [
      category('Private', { id: CATEGORY_ID, position: 0, permission_overwrites: privateOverwrites }),
      channel('synced one', 0, { parent_id: CATEGORY_ID, position: 1, permission_overwrites: privateOverwrites }),
      channel('synced two', 15, { parent_id: CATEGORY_ID, position: 2, permission_overwrites: privateOverwrites }),
      channel('own overwrites', 0, { parent_id: CATEGORY_ID, position: 3, permission_overwrites: [] }), // not synced: its own (empty) overwrites
    ];

    it('a child synced with its category is readable for a member of the allowed role', async () => {
      setWorld({ channels: channels(), roles, memberRoles: [ROLE_MEMBER] });
      await addGuild();
      expect(names()).toEqual(['synced one', 'synced two', 'own overwrites']);
    });

    it('and hidden for everybody else; a child that is not synced keeps its own verdict', async () => {
      setWorld({ channels: channels(), roles, memberRoles: [] });
      await addGuild();
      expect(names()).toEqual(['own overwrites']);
    });

    it('the category itself is never a chat, readable or not', async () => {
      setWorld({ channels: [category('Private', { id: CATEGORY_ID })], roles, memberRoles: [ROLE_MEMBER] });
      await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 0 } });
    });
  });
});

describe('queue/addCategory: the same filter', () => {
  const denyEveryone = overwrite(EVERYONE, 0, 0n, VIEW_CHANNEL);
  const world = (memberRoles: string[] = []) => {
    const study = category('Study', { id: CATEGORY_ID, position: 0 });
    const child = (name: string, extra: Record<string, unknown> = {}, type = 0) => channel(name, type, { parent_id: CATEGORY_ID, ...extra });
    setWorld({
      channels: [
        study,
        child('open', { position: 1 }),
        child('hidden', { position: 2, permission_overwrites: [denyEveryone] }),
        child('no history', { position: 3, permission_overwrites: [overwrite(EVERYONE, 0, 0n, READ_MESSAGE_HISTORY)] }),
        child('for role', { position: 4, permission_overwrites: [denyEveryone, overwrite(ROLE_MEMBER, 0, VIEW_CHANNEL, 0n)] }),
        child('hidden forum', { position: 5, permission_overwrites: [denyEveryone] }, 15),
        child('forum', { position: 6 }, 15),
        channel('elsewhere', 0, { parent_id: '300000000000000099', permission_overwrites: [] }),
        channel('loose'),
      ],
      roles: [role(EVERYONE, READ), role(ROLE_MEMBER, 0n)],
      memberRoles,
    });
  };

  it('adds only the children the account may read', async () => {
    world();
    await expect(addCategory()).resolves.toEqual({ ok: true, data: { added: 2, skipped: 0, removed: 0 } });
    expect(names()).toEqual(['open', 'forum']);
    expect(storedQueue(fake).every((item) => item.settings === null && item.target.parentId === CATEGORY_ID && item.target.parentName === 'Study')).toBe(true);
  });

  it('a role that may see a channel brings it in', async () => {
    world([ROLE_MEMBER]);
    await addCategory();
    expect(names()).toEqual(['open', 'for role', 'forum']);
  });

  it('skipped counts the readable children that were already in the list, not the hidden ones', async () => {
    world();
    const channels = api.guildChannels.get(GUILD_ID) as Array<{ id: string; name: string }>;
    const idOf = (name: string) => (channels.find((candidate) => candidate.name === name) as { id: string }).id;
    seedQueue(fake, [
      queueItem(guildTarget(idOf('open'), { channelName: 'open' })), // readable and queued
      queueItem(guildTarget(idOf('hidden'), { channelName: 'hidden' })), // hidden and queued: not part of this click at all
    ]);
    await expect(addCategory()).resolves.toEqual({ ok: true, data: { added: 1, skipped: 1, removed: 0 } });
    expect(names()).toEqual(['open', 'hidden', 'forum']);
  });

  it('asks for the same data as the server button, and a category click right after it costs no request', async () => {
    world();
    await addGuild();
    const requests = guildRequests().length;
    await addCategory();
    expect(guildRequests()).toHaveLength(requests);
    expect(requests).toBe(4);
  });

  it('does not use the guild object\'s name: the message decides, as before', async () => {
    world();
    await addCategory({ guildName: null });
    expect(storedQueue(fake)[0].target.guildName).toBeNull();
  });
});

// ---- when the permission data cannot be loaded ---------------------------------------------------------------------------------

describe('when the roles or the member cannot be loaded', () => {
  const denyEveryone = overwrite(EVERYONE, 0, 0n, VIEW_CHANNEL);
  const world = (): void => setWorld({ channels: [channel('open'), channel('hidden', 0, { permission_overwrites: [denyEveryone] })] });

  it('(sanity) with everything loaded the hidden channel is left out and nothing is logged', async () => {
    world();
    await addGuild();
    expect(names()).toEqual(['open']);
    expect(warnings()).toEqual([]);
  });

  /** Ways the account's own member record cannot be had, with the statuses the warning names. */
  const memberFailures: Array<[string, () => void, string]> = [
    [
      'both member endpoints are forbidden',
      () => {
        api.pathFailures.set(PATH.member, 403);
        api.pathFailures.set(PATH.memberAtMe, 403);
      },
      'HTTP 403, HTTP 403',
    ],
    [
      'both member endpoints are unknown',
      () => {
        api.members.delete(GUILD_ID);
        api.membersAtMe.delete(GUILD_ID);
      },
      'HTTP 404, HTTP 404',
    ],
    [
      'both member endpoints are unreachable',
      () => {
        api.pathFailures.set(PATH.member, 'network');
        api.pathFailures.set(PATH.memberAtMe, 'network');
      },
      'network error, network error',
    ],
    [
      'one is forbidden and the other fails',
      () => {
        api.pathFailures.set(PATH.member, 403);
        api.pathFailures.set(PATH.memberAtMe, 500);
      },
      'HTTP 403, HTTP 500',
    ],
    [
      'both answer something that is no member record',
      () => {
        api.members.set(GUILD_ID, 'nope');
        api.membersAtMe.set(GUILD_ID, [1, 2]);
      },
      'unexpected answer, unexpected answer',
    ],
  ];

  describe.each(memberFailures)('%s', (_label, breakMember, described) => {
    it('falls back to the type-only list (the hidden channel stays), logs one warning, and the add still succeeds', async () => {
      world();
      breakMember();
      await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 2, skipped: 0, removed: 0 } });
      expect(names()).toEqual(['open', 'hidden']);
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain(`guild ${GUILD_ID}`);
      expect(warnings()[0]).toContain(`member: ${described}`);
      expect(warnings()[0]).toContain('without the permission filter');
    });

    it('asks each member endpoint once, and the warning (like everything logged) holds no authorization value', async () => {
      world();
      breakMember();
      await addGuild();
      expect(guildRequests()).toEqual([...ALL_PATHS, PATH.memberAtMe]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    });

    it('the same fallback for the category button', async () => {
      const study = category('Study', { id: CATEGORY_ID });
      setWorld({ channels: [study, channel('open', 0, { parent_id: CATEGORY_ID }), channel('hidden', 0, { parent_id: CATEGORY_ID, permission_overwrites: [denyEveryone] })] });
      breakMember();
      await expect(addCategory()).resolves.toEqual({ ok: true, data: { added: 2, skipped: 0, removed: 0 } });
      expect(names()).toEqual(['open', 'hidden']);
      expect(warnings()).toHaveLength(1);
    });
  });

  it('the roles cannot be loaded and the guild object has none: no filter, one warning', async () => {
    world();
    api.pathFailures.set(PATH.roles, 403);
    api.guilds.set(GUILD_ID, { id: GUILD_ID, name: 'Server From Discord', owner_id: OTHER_ACCOUNT_ID }); // and the guild object has none
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 2, skipped: 0, removed: 0 } });
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('roles: HTTP 403');
    expect(warnings()[0]).not.toContain('member:');
  });

  it('nothing at all but the channel list: no filter, one warning that names both', async () => {
    world();
    api.pathFailures.set(PATH.roles, 500);
    api.pathFailures.set(PATH.guild, 500);
    api.pathFailures.set(PATH.member, 403);
    api.pathFailures.set(PATH.memberAtMe, 403);
    await expect(addGuild({ guildName: null })).resolves.toEqual({ ok: true, data: { added: 2, skipped: 0, removed: 0 } });
    expect(storedQueue(fake)[0].target.guildName).toBeNull();
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('roles: HTTP 500');
    expect(warnings()[0]).toContain('member: HTTP 403, HTTP 403');
  });

  it('the roles endpoint fails but the guild object has the roles: they stand in, the filter works, nothing is logged', async () => {
    world();
    api.pathFailures.set(PATH.roles, 403);
    await addGuild();
    expect(names()).toEqual(['open']);
    expect(warnings()).toEqual([]);
  });

  it('the roles endpoint answers something that is no list: the guild object\'s roles stand in', async () => {
    world();
    api.guildRoles.set(GUILD_ID, { message: 'weird' });
    await addGuild();
    expect(names()).toEqual(['open']);
  });

  it('the first member endpoint is refused: the second one is used and the filter works, without a warning', async () => {
    world();
    api.membersAtMe.set(GUILD_ID, api.members.get(GUILD_ID));
    api.members.delete(GUILD_ID);
    await addGuild();
    expect(names()).toEqual(['open']);
    expect(warnings()).toEqual([]);
    expect(guildRequests()).toEqual([...ALL_PATHS, PATH.memberAtMe]);
  });

  it.each([401, 403, 404, 500, 'network'] as const)(
    'the first member endpoint fails with %s: the second one decides; a 401 there says nothing about the authorization',
    async (failure) => {
      world();
      api.membersAtMe.set(GUILD_ID, api.members.get(GUILD_ID));
      api.pathFailures.set(PATH.member, failure);
      await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 1, skipped: 0, removed: 0 } });
      expect(names()).toEqual(['open']);
      expect(warnings()).toEqual([]);
      expect(fake.session.peek(SESSION.token)).toBe(TOKEN);
      expect((fake.session.peek(SESSION.account) as { id: string }).id).toBe(ACCOUNT_ID);
    },
  );

  it('a 401 from the roles, guild or member endpoint is not a dead token either (only the channel list can say that)', async () => {
    world();
    api.pathFailures.set(PATH.roles, 401);
    api.pathFailures.set(PATH.guild, 401);
    api.pathFailures.set(PATH.member, 401);
    api.pathFailures.set(PATH.memberAtMe, 401);
    await expect(addGuild()).resolves.toMatchObject({ ok: true });
    expect(fake.session.peek(SESSION.token)).toBe(TOKEN);
    expect(warnings()).toHaveLength(1);
  });

  it('the guild object alone is missing: the filter still works, but the owner check is skipped (and logged)', async () => {
    setWorld({ channels: [channel('open'), channel('hidden', 0, { permission_overwrites: [denyEveryone] })], owner: true });
    api.pathFailures.set(PATH.guild, 404);
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 1, skipped: 0, removed: 0 } });
    expect(names()).toEqual(['open']); // an owner would see 'hidden' too, if the guild object had told us
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('owner check is skipped');
  });

  it('an incomplete answer is not kept: the next click asks again and then filters', async () => {
    world();
    api.pathFailures.set(PATH.member, 403);
    api.pathFailures.set(PATH.memberAtMe, 403);
    await addGuild();
    expect(names()).toEqual(['open', 'hidden']);
    expect(guildRequests()).toHaveLength(5);

    api.pathFailures.clear(); // Discord is fine again
    await popup.send({ to: 'bg', type: 'queue/clear' });
    await addGuild();
    expect(names()).toEqual(['open']);
    expect(guildRequests()).toHaveLength(9); // asked again, 4 more requests
    expect(warnings()).toHaveLength(1);
  });
});

// ---- requests and the cache ----------------------------------------------------------------------------------------------------

describe('requests', () => {
  beforeEach(() => {
    setWorld({ channels: [category('Study', { id: CATEGORY_ID }), channel('general', 0, { parent_id: CATEGORY_ID }), channel('loose')] });
  });

  it('asks for the channel list, the roles, the guild and the own member, once each, GET only, with the stored authorization', async () => {
    const before = api.calls.length;
    await addGuild();
    const calls = api.calls.slice(before);
    expect(calls.map((call) => call.url.replace('https://discord.com', ''))).toEqual(ALL_PATHS);
    for (const call of calls) {
      expect(isApiGetPathAllowed(call.url.replace('https://discord.com', ''))).toBe(true);
      expect(call).toMatchObject({ method: 'GET', credentials: 'omit', headers: { Authorization: TOKEN, Accept: 'application/json' } });
      expect(Object.keys(call.headers).sort()).toEqual(['Accept', 'Authorization']);
    }
  });

  it('a failed channel list ends the operation: no other endpoint is asked for, nothing is added', async () => {
    api.pathFailures.set(PATH.channels, 500);
    await expect(addGuild()).resolves.toEqual({ ok: false, error: 'http', message: 'HTTP 500' });
    expect(guildRequests()).toEqual([PATH.channels]);
    expect(storedQueue(fake)).toEqual([]);
  });

  it('a channel list that failed is not kept: the next click asks again', async () => {
    api.pathFailures.set(PATH.channels, 500);
    await addGuild();
    api.pathFailures.delete(PATH.channels);
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 2, skipped: 0, removed: 0 } });
    expect(guildRequests()).toEqual([PATH.channels, ...ALL_PATHS]);
  });

  it('a category click right after a server click costs no request, and neither does a second server click', async () => {
    await addGuild(); // 'general' and 'loose' are in the list now
    expect(guildRequests()).toEqual(ALL_PATHS);
    await expect(addCategory()).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 1 } }); // 'general' is the whole category
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 1, skipped: 1, removed: 0 } }); // 'general' is missing again
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 2 } }); // now everything is in: all out
    expect(guildRequests()).toEqual(ALL_PATHS);
  });

  it('and the other way round: a category click first, then the server button', async () => {
    await expect(addCategory()).resolves.toEqual({ ok: true, data: { added: 1, skipped: 0, removed: 0 } });
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 1, skipped: 1, removed: 0 } });
    expect(guildRequests()).toEqual(ALL_PATHS);
    expect(names()).toEqual(['general', 'loose']);
  });

  it('answers from the cache for 60 seconds and asks again after that', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    await addGuild();
    expect(guildRequests()).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(59_000);
    await addCategory();
    expect(guildRequests()).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(2_000); // 61 s after the load
    await addCategory();
    expect(guildRequests()).toHaveLength(8);

    await vi.advanceTimersByTimeAsync(30_000); // the new answer is 30 s old
    await addGuild();
    expect(guildRequests()).toHaveLength(8);
  });

  it('what the cache holds is what Discord said: a changed channel list is seen after the 60 seconds, not before', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    await addGuild();
    api.guildChannels.set(GUILD_ID, [channel('brand new')]);
    await popup.send({ to: 'bg', type: 'queue/clear' });
    await addGuild();
    expect(names()).toEqual(['loose', 'general']); // still the old list
    await vi.advanceTimersByTimeAsync(60_001);
    await popup.send({ to: 'bg', type: 'queue/clear' });
    await addGuild();
    expect(names()).toEqual(['brand new']);
  });

  it('every guild has its own entry', async () => {
    const other = '200000000000000002';
    api.guildChannels.set(other, [channel('elsewhere')]);
    api.guildRoles.set(other, [role(other, READ)]);
    api.guilds.set(other, { id: other, name: 'Other Server', owner_id: OTHER_ACCOUNT_ID });
    api.members.set(other, { roles: [] });
    await addGuild();
    await expect(addGuild({ guildId: other, guildName: 'Other Server' })).resolves.toEqual({ ok: true, data: { added: 1, skipped: 0, removed: 0 } });
    expect(guildRequests()).toHaveLength(8);
    expect(guildRequests().filter((path) => path.includes(other))).toHaveLength(4);
  });

  it('every account has its own entry, and its own list', async () => {
    await addGuild();
    api.users.set(OTHER_TOKEN, userPayload(OTHER_ACCOUNT_ID));
    fake.captureToken(OTHER_TOKEN);
    await waitFor(() => (fake.session.peek(SESSION.account) as { id: string } | null)?.id === OTHER_ACCOUNT_ID);
    await expect(addGuild()).resolves.toEqual({ ok: true, data: { added: 2, skipped: 0, removed: 0 } });
    expect(guildRequests()).toHaveLength(8);
    expect(api.calls.filter((call) => call.headers.Authorization === OTHER_TOKEN && call.url.includes('/guilds/'))).toHaveLength(4);
    expect(names(ACCOUNT_ID)).toEqual(['loose', 'general']);
    expect(names(OTHER_ACCOUNT_ID)).toEqual(['loose', 'general']);
  });

  it('a load that is already running is shared: two clicks at once ask for each endpoint once', async () => {
    let release!: () => void;
    api.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const serverClick = addGuild();
    const categoryClick = addCategory({}, popup);
    await settle();
    expect(guildRequests()).toEqual([PATH.channels]); // the second click did not ask again
    release();
    await expect(serverClick).resolves.toMatchObject({ ok: true });
    await expect(categoryClick).resolves.toMatchObject({ ok: true });
    expect(guildRequests()).toEqual(ALL_PATHS);
    // the clicks are applied one after the other, in the order they came: the server click puts both channels in, and the
    // category click that follows finds its whole category in the list and takes it out again
    expect(names()).toEqual(['loose']);
  });

  it('every endpoint is asked for at most once per click, whatever fails', async () => {
    for (const status of [401, 403, 404, 429, 500, 'network'] as const) {
      api.pathFailures.set(PATH.roles, status);
      api.pathFailures.set(PATH.guild, status);
      api.pathFailures.set(PATH.member, status);
      api.pathFailures.set(PATH.memberAtMe, status);
      const before = guildRequests().length;
      await addGuild();
      const made = guildRequests().slice(before);
      expect(made.length).toBeLessThanOrEqual(5);
      expect(new Set(made).size).toBe(made.length);
      await popup.send({ to: 'bg', type: 'queue/clear' });
    }
  });
});

// ---- refusals -------------------------------------------------------------------------------------------------------------------

describe('queue/addGuild: refusals', () => {
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
    await expect(addGuild(overrides)).resolves.toMatchObject({ ok: false, error: 'invalid' });
    expect(api.calls).toHaveLength(calls);
    expect(storedQueue(fake)).toEqual([]);
  });

  it('accepts a guild name of 100 characters and a missing one (null)', async () => {
    setWorld({ channels: [channel('general')] });
    await expect(addGuild({ guildName: 'g'.repeat(100) })).resolves.toMatchObject({ ok: true });
    await expect(addGuild({ guildName: null })).resolves.toMatchObject({ ok: true });
  });

  it('answers "no-account" without any request when there is no verified account', async () => {
    const other = createFakeBrowser();
    const otherApi = installFakeDiscordApi();
    await bootWorker(other);
    const page = other.createContentScript(7, 'https://discord.com/channels/@me');
    await expect(addGuild({}, page)).resolves.toEqual({ ok: false, error: 'no-account' });
    expect(otherApi.calls).toHaveLength(0);
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
    await expect(addGuild({}, page)).resolves.toEqual({ ok: false, error: 'no-account' });
    expect(otherApi.calls).toHaveLength(calls); // no guild request
  });

  it('maps a failed channel list to "http" and adds nothing; the token stays', async () => {
    setWorld({ channels: [channel('general')] });
    api.force = 403;
    await expect(addGuild()).resolves.toEqual({ ok: false, error: 'http', message: 'HTTP 403' });
    api.force = 'network';
    await expect(addGuild()).resolves.toEqual({ ok: false, error: 'http', message: 'network error' });
    api.force = null;
    api.guildChannels.delete(GUILD_ID);
    await expect(addGuild()).resolves.toEqual({ ok: false, error: 'http', message: 'HTTP 404' });
    expect(storedQueue(fake)).toEqual([]);
    expect(fake.session.peek(SESSION.token)).toBe(TOKEN);
  });

  it('a 401 on the channel list means the token is dead: it is removed (compare-and-clear) and the answer is "no-account"', async () => {
    setWorld({ channels: [channel('general')] });
    api.users.delete(TOKEN); // Discord no longer knows it
    await expect(addGuild()).resolves.toEqual({ ok: false, error: 'no-account' });
    await waitFor(() => !fake.session.has(SESSION.token));
    await waitFor(() => fake.session.peek(SESSION.account) === null);
    expect(guildRequests()).toEqual([PATH.channels]);
  });

  it('never logs or returns the authorization value', async () => {
    setWorld({ channels: [channel('general')] });
    api.pathFailures.set(PATH.member, 403);
    api.pathFailures.set(PATH.memberAtMe, 403);
    const responses = [await addGuild(), await addGuild({ guildId: 'abc' }), await addCategory()];
    for (const response of responses) expect(JSON.stringify(response)).not.toContain(TOKEN);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(fake.local.dump())).not.toContain(TOKEN);
  });
});
