import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { avatarUrl, guildIconUrl } from '@/lib/discord/cdn';
import { DiscordApiError } from '@/lib/discord/client';
import type { DiscordClient } from '@/lib/discord/client';
import type { MockDiscordClient } from '@/lib/discord/mock';
import { createMockClient, MOCK_IDS, MOCK_ME, MOCK_NOW_MS } from '@/lib/discord/mock';
import { compareSnowflakes, snowflakeToTimestamp } from '@/lib/discord/snowflake';
import { ChannelType, MessageType } from '@/lib/discord/types';
import type { Channel, Message, Snowflake, User } from '@/lib/discord/types';

/** Real snowflakes are 15-21 digit decimal strings; the fixtures must look like that to exercise the id handling. */
const isSnowflake = (value: unknown): boolean => typeof value === 'string' && /^\d{15,21}$/.test(value);

// permissions.ts and tree.ts belong to other modules: load them lazily so a problem there fails only the tests that use them.
const loadPermissions = () => import('@/lib/discord/permissions');
const loadTree = () => import('@/lib/discord/tree');

const MINUTE = 60_000;
const DAY = 86_400_000;

function fresh(latencyMs = 0): MockDiscordClient {
  return createMockClient({ latencyMs });
}

/** Whole history oldest -> newest, walking backwards with `before` (what the UI does). */
async function pageBack(client: DiscordClient, channelId: Snowflake): Promise<Message[]> {
  const chunks: Message[][] = [];
  let before: Snowflake | undefined;
  for (;;) {
    const page = await client.getMessages(channelId, before === undefined ? { limit: 100 } : { before, limit: 100 });
    if (page.length === 0) break;
    chunks.unshift([...page].reverse());
    before = page[page.length - 1].id;
  }
  return chunks.flat();
}

/** Whole history oldest -> newest, walking forwards with `after` (what the exporter does). */
async function pageForward(client: DiscordClient, channelId: Snowflake): Promise<Message[]> {
  const out: Message[] = [];
  let after: Snowflake = '0';
  for (;;) {
    const page = await client.getMessages(channelId, { after, limit: 100 });
    if (page.length === 0) break;
    out.push(...[...page].reverse());
    after = page[0].id;
  }
  return out;
}

async function rejection(promise: Promise<unknown>): Promise<DiscordApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DiscordApiError);
    return error as DiscordApiError;
  }
  throw new Error('expected the promise to reject');
}

function flattenIds(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenIds);
  if (value && typeof value === 'object') return Object.values(value).flatMap(flattenIds);
  return [];
}

function decodeSvg(dataUri: string): string {
  const match = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)$/.exec(dataUri);
  if (!match) throw new Error(`not an svg data uri: ${dataUri.slice(0, 40)}`);
  return Buffer.from(match[1], 'base64').toString('utf8');
}

// ---------------------------------------------------------------------------------------------------------------------

describe('client basics', () => {
  it('is a mock client and identifies the demo user', async () => {
    const client = fresh();
    expect(client.kind).toBe('mock');
    expect(await client.getMe()).toEqual(MOCK_ME);
    expect(MOCK_ME.avatar).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(isSnowflake(MOCK_ME.id)).toBe(true);
  });

  it('returns copies: mutating a result never changes later results', async () => {
    const client = fresh();
    const first = await client.getMessages(MOCK_IDS.generalChannel, { limit: 5 });
    const snapshot = JSON.stringify(first);
    first[0].content = 'MUTATED';
    first[0].author.username = 'mutated';
    first.reverse();
    (await client.getGuilds())[0].name = 'MUTATED';
    expect(JSON.stringify(await client.getMessages(MOCK_IDS.generalChannel, { limit: 5 }))).toBe(snapshot);
    expect((await client.getGuilds())[0].name).not.toBe('MUTATED');
  });
});

describe('guilds', () => {
  let guilds: Awaited<ReturnType<MockDiscordClient['getGuilds']>>;
  beforeAll(async () => {
    guilds = await fresh().getGuilds();
  });

  it('lists nine guilds with the requested kinds of names', () => {
    expect(guilds).toHaveLength(9);
    const names = guilds.map((g) => g.name);
    expect(names[0]).toBe('개발자 라운지');
    expect(names).toContain('A/B:C*?');
    expect(names).toContain('CON');
    expect(names.some((n) => /^[\u{1F300}-\u{1FAFF}]/u.test(n))).toBe(true);
    expect(names.some((n) => n.length >= 100)).toBe(true);
    expect(names.some((n) => n.includes('<script>'))).toBe(true);
    expect(names.some((n) => /[\u0600-\u06ff]/.test(n))).toBe(true);
    expect(new Set(guilds.map((g) => g.id)).size).toBe(9);
    expect(guilds.map((g) => g.id)[0]).toBe(MOCK_IDS.bigGuild);
  });

  it('mixes data-URI SVG icons with null icons that the CDN helper passes through', () => {
    const withIcon = guilds.filter((g) => g.icon !== null);
    expect(withIcon.length).toBeGreaterThanOrEqual(4);
    expect(guilds.filter((g) => g.icon === null).length).toBeGreaterThanOrEqual(2);
    for (const g of withIcon) {
      expect(g.icon).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(guildIconUrl(g.id, g.icon)).toBe(g.icon);
    }
    expect(guildIconUrl(guilds[2].id, guilds[2].icon)).toBeNull();
  });

  it('never lets markup from a hostile guild name into the generated SVG', () => {
    const hostile = guilds.find((g) => g.id === MOCK_IDS.hostileNameGuild);
    expect(hostile?.name).toContain('<script>');
    const svg = decodeSvg(hostile?.icon ?? '');
    expect(svg).not.toContain('<b');
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('alert');
  });

  it('has an owned guild with full permissions and member guilds with base permissions', () => {
    expect(guilds.find((g) => g.id === MOCK_IDS.englishGuild)?.owner).toBe(true);
    const big = guilds.find((g) => g.id === MOCK_IDS.bigGuild);
    expect(big?.owner).toBe(false);
    expect(BigInt(big?.permissions ?? '0') & (1n << 10n)).not.toBe(0n); // VIEW_CHANNEL
  });
});

describe('main guild structure', () => {
  const client = fresh();
  let channels: Channel[];
  let threads: Channel[];
  const byId = new Map<Snowflake, Channel>();

  beforeAll(async () => {
    channels = await client.getGuildChannels(MOCK_IDS.bigGuild);
    threads = await client.getActiveThreads(MOCK_IDS.bigGuild);
    for (const c of channels) byId.set(c.id, c);
  });

  it('has about sixty channels of every guild type', () => {
    expect(channels.length).toBeGreaterThanOrEqual(55);
    expect(channels.length).toBeLessThanOrEqual(70);
    for (const type of [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory, ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildForum]) {
      expect(channels.some((c) => c.type === type), `type ${type}`).toBe(true);
    }
    expect(channels.every((c) => c.guild_id === MOCK_IDS.bigGuild)).toBe(true);
    expect(channels.some((c) => c.type >= 10 && c.type <= 12)).toBe(false); // threads are not listed here
    expect(new Set(channels.map((c) => c.id)).size).toBe(channels.length);
  });

  it('has uncategorized channels and at least six categories incl. an empty and a voice-only one', () => {
    const categories = channels.filter((c) => c.type === ChannelType.GuildCategory);
    expect(categories.length).toBeGreaterThanOrEqual(6);
    expect(channels.filter((c) => c.type !== ChannelType.GuildCategory && !c.parent_id).length).toBeGreaterThanOrEqual(3);

    const children = (categoryId: Snowflake): Channel[] => channels.filter((c) => c.parent_id === categoryId);
    expect(byId.get(MOCK_IDS.emptyCategory)?.type).toBe(ChannelType.GuildCategory);
    expect(children(MOCK_IDS.emptyCategory)).toHaveLength(0);
    const voiceOnly = children(MOCK_IDS.voiceOnlyCategory);
    expect(voiceOnly.length).toBeGreaterThanOrEqual(3);
    expect(voiceOnly.every((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice)).toBe(true);
  });

  it('refers only to existing categories as parents', () => {
    for (const c of channels) {
      if (c.parent_id) expect(byId.get(c.parent_id)?.type, c.name ?? '').toBe(ChannelType.GuildCategory);
    }
  });

  it('lists channels in shuffled order with positions that must be sorted by the consumer', () => {
    const positions = channels.map((c) => c.position ?? 0);
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).not.toEqual(sorted);
    const categoryPositions = channels.filter((c) => c.type === ChannelType.GuildCategory).map((c) => c.position);
    expect(new Set(categoryPositions).size).toBe(categoryPositions.length);
  });

  it('places a voice channel before the text channels by position (sidebar must still sort text first)', () => {
    const inGeneral = channels.filter((c) => c.parent_id === MOCK_IDS.generalCategory);
    const voice = inGeneral.find((c) => c.type === ChannelType.GuildVoice);
    const lowestText = Math.min(...inGeneral.filter((c) => c.type === ChannelType.GuildText).map((c) => c.position ?? 0));
    expect(voice).toBeDefined();
    expect(voice?.position ?? 99).toBeLessThan(lowestText);
  });

  it('serves a forum with several active threads and further threads under normal channels', () => {
    expect(byId.get(MOCK_IDS.forumChannel)?.type).toBe(ChannelType.GuildForum);
    const forumPosts = threads.filter((t) => t.parent_id === MOCK_IDS.forumChannel);
    expect(forumPosts.map((t) => t.id).sort()).toEqual([...MOCK_IDS.forumThreads].sort());
    for (const t of threads) {
      expect(t.type === ChannelType.PublicThread || t.type === ChannelType.AnnouncementThread).toBe(true);
      expect(t.thread_metadata?.archived).toBe(false);
      expect(t.guild_id).toBe(MOCK_IDS.bigGuild);
      expect(t.parent_id && byId.has(t.parent_id)).toBe(true);
      expect(t.message_count).toBeGreaterThan(0);
    }
    expect(threads.filter((t) => t.parent_id === MOCK_IDS.generalChannel).map((t) => t.id).sort()).toEqual([MOCK_IDS.generalThread, MOCK_IDS.generalThread2].sort());
    expect(threads.find((t) => t.id === MOCK_IDS.announcementThread)?.type).toBe(ChannelType.AnnouncementThread);
    expect(threads.some((t) => (t.name?.length ?? 0) > 80)).toBe(true);
  });

  it('serves no threads for guilds that have none', async () => {
    expect(await client.getActiveThreads(MOCK_IDS.emojiGuild)).toEqual([]);
  });

  it('works with the sidebar tree builder', async () => {
    const roles = await client.getGuildRoles(MOCK_IDS.bigGuild);
    const member = await client.getMyMember(MOCK_IDS.bigGuild);
    const guild = (await client.getGuilds()).find((g) => g.id === MOCK_IDS.bigGuild);
    const { resolveChannelAccess } = await loadPermissions();
    const { buildGuildTree } = await loadTree();
    const access = resolveChannelAccess({ guildId: MOCK_IDS.bigGuild, userId: MOCK_ME.id, guild: guild ?? {}, roles, member, channels, threads });
    const tree = buildGuildTree(MOCK_IDS.bigGuild, channels, threads, access);

    expect(tree.uncategorized.length).toBeGreaterThanOrEqual(3);
    const positions = tree.categories.map((c) => c.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(tree.categories.find((c) => c.id === MOCK_IDS.emptyCategory)?.channels).toEqual([]);
    const general = tree.categories.find((c) => c.id === MOCK_IDS.generalCategory);
    expect(general?.channels.at(-1)?.kind).toBe('voice');
    expect(tree.threadsByParent[MOCK_IDS.forumChannel]).toHaveLength(5);
    expect(tree.byId[MOCK_IDS.hiddenChannel]?.canView).toBe(false);
    expect(tree.byId[MOCK_IDS.forbiddenChannel]?.canView).toBe(true);
  });
});

describe('permissions are consistent with the roles and overwrites that are served', () => {
  const client = fresh();
  let channels: Channel[];
  let access: Record<Snowflake, boolean>;

  beforeAll(async () => {
    const [guilds, roles, member, threads] = await Promise.all([
      client.getGuilds(),
      client.getGuildRoles(MOCK_IDS.bigGuild),
      client.getMyMember(MOCK_IDS.bigGuild),
      client.getActiveThreads(MOCK_IDS.bigGuild),
    ]);
    channels = await client.getGuildChannels(MOCK_IDS.bigGuild);
    const { resolveChannelAccess } = await loadPermissions();
    access = resolveChannelAccess({
      guildId: MOCK_IDS.bigGuild,
      userId: MOCK_ME.id,
      guild: guilds.find((g) => g.id === MOCK_IDS.bigGuild) ?? {},
      roles,
      member,
      channels,
      threads,
    });
  });

  it('serves roles incl. @everyone (same id as the guild) and a member that holds Member + Developer', async () => {
    const roles = await client.getGuildRoles(MOCK_IDS.bigGuild);
    expect(roles.find((r) => r.id === MOCK_IDS.bigGuild)?.name).toBe('@everyone');
    expect(roles.map((r) => r.id)).toEqual(expect.arrayContaining(Object.values(MOCK_IDS.roles)));
    const member = await client.getMyMember(MOCK_IDS.bigGuild);
    expect([...member.roles].sort()).toEqual([MOCK_IDS.roles.member, MOCK_IDS.roles.developer].sort());
    expect(member.user).toEqual(MOCK_ME);
  });

  it('hides the channels whose overwrites deny the user', () => {
    expect(access[MOCK_IDS.hiddenChannel]).toBe(false);
    expect(access[MOCK_IDS.hiddenCategory]).toBe(false);
    expect(access[MOCK_IDS.memberDeniedChannel]).toBe(false);
  });

  it('shows channels that are re-allowed through a role, a member overwrite, or conflicting role overwrites', () => {
    expect(access[MOCK_IDS.roleOverwriteChannel]).toBe(true);
    expect(access[MOCK_IDS.memberOverwriteChannel]).toBe(true);
    expect(access[MOCK_IDS.conflictingOverwriteChannel]).toBe(true);
  });

  it('shows ordinary channels, including the one that is visible on paper but answers 403', () => {
    expect(access[MOCK_IDS.generalChannel]).toBe(true);
    expect(access[MOCK_IDS.forumChannel]).toBe(true);
    expect(access[MOCK_IDS.forbiddenChannel]).toBe(true);
    for (const threadId of MOCK_IDS.forumThreads) expect(access[threadId]).toBe(true);
  });

  it('answers getMessages with 403 exactly where the permission maths hides a channel (plus the forbidden one)', async () => {
    const readable = channels.filter((c) => [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(c.type as 0 | 5 | 2 | 13));
    const denied: Snowflake[] = [];
    for (const c of readable) {
      try {
        await client.getMessages(c.id, { limit: 1 });
      } catch (error) {
        expect((error as DiscordApiError).kind).toBe('forbidden');
        denied.push(c.id);
      }
    }
    const hiddenByMaths = readable.filter((c) => access[c.id] === false).map((c) => c.id);
    expect(denied.sort()).toEqual([...hiddenByMaths, MOCK_IDS.forbiddenChannel].sort());
  });

  it('shows every channel to the owner of the guild', async () => {
    const [guilds, roles, member, list] = await Promise.all([
      client.getGuilds(),
      client.getGuildRoles(MOCK_IDS.englishGuild),
      client.getMyMember(MOCK_IDS.englishGuild),
      client.getGuildChannels(MOCK_IDS.englishGuild),
    ]);
    const { resolveChannelAccess } = await loadPermissions();
    const result = resolveChannelAccess({
      guildId: MOCK_IDS.englishGuild,
      userId: MOCK_ME.id,
      guild: guilds.find((g) => g.id === MOCK_IDS.englishGuild) ?? {},
      roles,
      member,
      channels: list,
    });
    expect(Object.values(result).every(Boolean)).toBe(true);
    expect(Object.keys(result)).toHaveLength(list.length);
  });
});

describe('getMessages conformance', () => {
  const client = fresh();
  let general: Message[]; // ascending
  beforeAll(async () => {
    general = await pageBack(client, MOCK_IDS.generalChannel);
  });

  it('returns newest first and defaults to 50 messages', async () => {
    const page = await client.getMessages(MOCK_IDS.generalChannel);
    expect(page).toHaveLength(50);
    for (let i = 1; i < page.length; i++) expect(compareSnowflakes(page[i - 1].id, page[i].id)).toBe(1);
    expect(page[0].id).toBe(general[general.length - 1].id);
  });

  it('clamps the limit to 1..100', async () => {
    const get = (limit: number): Promise<Message[]> => client.getMessages(MOCK_IDS.generalChannel, { limit });
    expect(await get(500)).toHaveLength(100);
    expect(await get(100)).toHaveLength(100);
    expect(await get(1)).toHaveLength(1);
    expect(await get(0)).toHaveLength(1);
    expect(await get(-7)).toHaveLength(1);
    expect(await get(3.9)).toHaveLength(3);
    expect(await get(Number.NaN)).toHaveLength(50);
  });

  it('`before` returns the newest messages older than the cursor', async () => {
    const cursor = general[1000].id;
    const page = await client.getMessages(MOCK_IDS.generalChannel, { before: cursor, limit: 100 });
    expect(page.map((m) => m.id)).toEqual(general.slice(900, 1000).reverse().map((m) => m.id));
  });

  it('`after` returns the OLDEST messages newer than the cursor, still newest first within the page', async () => {
    const cursor = general[1000].id;
    const page = await client.getMessages(MOCK_IDS.generalChannel, { after: cursor, limit: 100 });
    expect(page.map((m) => m.id)).toEqual(general.slice(1001, 1101).reverse().map((m) => m.id));
    // A small limit must not jump to the newest end of the channel.
    const small = await client.getMessages(MOCK_IDS.generalChannel, { after: cursor, limit: 3 });
    expect(small.map((m) => m.id)).toEqual(general.slice(1001, 1004).reverse().map((m) => m.id));
  });

  it('treats `after: "0"` as "from the very beginning"', async () => {
    const page = await client.getMessages(MOCK_IDS.generalChannel, { after: '0', limit: 100 });
    expect(page.map((m) => m.id)).toEqual(general.slice(0, 100).reverse().map((m) => m.id));
  });

  it('bounds the window with both cursors', async () => {
    const page = await client.getMessages(MOCK_IDS.generalChannel, { after: general[10].id, before: general[15].id, limit: 100 });
    expect(page.map((m) => m.id)).toEqual(general.slice(11, 15).reverse().map((m) => m.id));
  });

  it('returns an empty page beyond either end and excludes the cursor itself', async () => {
    expect(await client.getMessages(MOCK_IDS.generalChannel, { before: general[0].id })).toEqual([]);
    expect(await client.getMessages(MOCK_IDS.generalChannel, { after: general[general.length - 1].id })).toEqual([]);
    expect(await client.getMessages(MOCK_IDS.generalChannel, { before: '1' })).toEqual([]);
    const page = await client.getMessages(MOCK_IDS.generalChannel, { before: general[500].id, limit: 100 });
    expect(page.some((m) => m.id === general[500].id)).toBe(false);
  });

  it('rejects malformed cursors with a 400-style error', async () => {
    const error = await rejection(client.getMessages(MOCK_IDS.generalChannel, { before: 'not-a-number' }));
    expect(error.status).toBe(400);
    expect(error.kind).toBe('unknown');
  });

  it('paging backwards and forwards both reconstruct whole channels without duplicates or gaps', async () => {
    const ids = [
      MOCK_IDS.generalChannel,
      MOCK_IDS.showcaseChannel,
      MOCK_IDS.edge199Channel,
      MOCK_IDS.edge200Channel,
      MOCK_IDS.edge201Channel,
      MOCK_IDS.edge400Channel,
      MOCK_IDS.edge401Channel,
      MOCK_IDS.forumThreads[0],
      MOCK_IDS.generalThread2,
      MOCK_IDS.dmFriend,
      MOCK_IDS.groupDmNamed,
      MOCK_IDS.announcementChannel,
    ];
    for (const id of ids) {
      const back = await pageBack(client, id);
      const forward = await pageForward(client, id);
      expect(back.length, id).toBeGreaterThan(0);
      expect(new Set(back.map((m) => m.id)).size, `${id} duplicates`).toBe(back.length);
      expect(forward.map((m) => m.id), id).toEqual(back.map((m) => m.id));
      for (let i = 1; i < back.length; i++) expect(compareSnowflakes(back[i - 1].id, back[i].id)).toBe(-1);
      expect(forward[forward.length - 1], id).toEqual(back[back.length - 1]);
    }
  });

  it('has exactly 199 / 200 / 201 / 400 / 401 messages in the edge channels and none in the empty channel', async () => {
    const counts = new Map<Snowflake, number>();
    for (const id of [MOCK_IDS.edge199Channel, MOCK_IDS.edge200Channel, MOCK_IDS.edge201Channel, MOCK_IDS.edge400Channel, MOCK_IDS.edge401Channel]) {
      counts.set(id, (await pageBack(client, id)).length);
    }
    expect([...counts.values()]).toEqual([199, 200, 201, 400, 401]);
    expect(await client.getMessages(MOCK_IDS.emptyChannel, { limit: 100 })).toEqual([]);
    expect(await client.getMessages(MOCK_IDS.emptyChannel, { after: '0' })).toEqual([]);
  });

  it('serves page boundaries exactly: a 200-message channel ends with a full page followed by an empty one', async () => {
    const first = await client.getMessages(MOCK_IDS.edge200Channel, { limit: 100 });
    const second = await client.getMessages(MOCK_IDS.edge200Channel, { before: first[99].id, limit: 100 });
    const third = await client.getMessages(MOCK_IDS.edge200Channel, { before: second[99].id, limit: 100 });
    expect([first.length, second.length, third.length]).toEqual([100, 100, 0]);
  });

  it('makes the general channel big and about eight months long, ending at the fixed world time', () => {
    expect(general.length).toBeGreaterThanOrEqual(2600);
    const newest = Date.parse(general[general.length - 1].timestamp);
    const oldest = Date.parse(general[0].timestamp);
    expect(MOCK_NOW_MS - newest).toBeLessThan(MINUTE);
    expect(newest).toBeLessThanOrEqual(MOCK_NOW_MS);
    expect(newest - oldest).toBeGreaterThan(230 * DAY);
    expect(newest - oldest).toBeLessThan(260 * DAY);
    expect(general[general.length - 1].timestamp.startsWith('2026-10-05T12:00')).toBe(true);
  });

  it('stamps every message with the time encoded in its snowflake', () => {
    for (const m of general) {
      expect(Date.parse(m.timestamp)).toBe(snowflakeToTimestamp(m.id));
      expect(isSnowflake(m.id)).toBe(true);
      expect(m.channel_id).toBe(MOCK_IDS.generalChannel);
    }
  });

  it('fails like the real API', async () => {
    const forbidden = [MOCK_IDS.forbiddenChannel, MOCK_IDS.hiddenChannel, MOCK_IDS.memberDeniedChannel];
    for (const id of forbidden) {
      const error = await rejection(client.getMessages(id));
      expect(error.kind).toBe('forbidden');
      expect(error.status).toBe(403);
    }
    const missing = await rejection(client.getMessages(MOCK_IDS.unknownChannel));
    expect(missing.kind).toBe('not-found');
    expect(missing.status).toBe(404);
    expect((await rejection(client.getMessages('abc'))).kind).toBe('not-found');

    // Categories and forums have no messages.
    expect((await rejection(client.getMessages(MOCK_IDS.emptyCategory))).status).toBe(400);
    expect((await rejection(client.getMessages(MOCK_IDS.forumChannel))).status).toBe(400);

    for (const call of [
      () => client.getGuildChannels(MOCK_IDS.unknownGuild),
      () => client.getActiveThreads(MOCK_IDS.unknownGuild),
      () => client.getGuildRoles(MOCK_IDS.unknownGuild),
      () => client.getMyMember(MOCK_IDS.unknownGuild),
    ]) {
      expect((await rejection(call())).kind).toBe('not-found');
    }
  });
});

describe('determinism', () => {
  it('two clients produce byte-identical data', async () => {
    const a = fresh();
    const b = fresh();
    const snapshot = async (client: MockDiscordClient): Promise<string> => {
      const guilds = await client.getGuilds();
      const parts: unknown[] = [await client.getMe(), guilds, await client.getDmChannels()];
      for (const g of guilds) parts.push(await client.getGuildChannels(g.id), await client.getActiveThreads(g.id), await client.getGuildRoles(g.id), await client.getMyMember(g.id));
      for (const id of [MOCK_IDS.generalChannel, MOCK_IDS.showcaseChannel, MOCK_IDS.dmFriend, MOCK_IDS.groupDmNamed, MOCK_IDS.forumThreads[1]]) {
        parts.push(await pageBack(client, id));
      }
      return JSON.stringify(parts);
    };
    const [first, second] = [await snapshot(a), await snapshot(b)];
    expect(first.length).toBeGreaterThan(1_000_000);
    expect(second).toBe(first);
  });

  it('does not depend on the order in which channels are read', async () => {
    const a = fresh();
    const b = fresh();
    const g1 = await pageBack(a, MOCK_IDS.generalChannel);
    const s1 = await pageBack(a, MOCK_IDS.showcaseChannel);
    const s2 = await pageBack(b, MOCK_IDS.showcaseChannel);
    await b.getMessages(MOCK_IDS.dmFriend);
    const g2 = await pageBack(b, MOCK_IDS.generalChannel);
    expect(JSON.stringify(g2)).toBe(JSON.stringify(g1));
    expect(JSON.stringify(s2)).toBe(JSON.stringify(s1));
  });

  it('keeps well-known ids and the ends of the biggest channel fixed (no engine-dependent maths)', async () => {
    const client = fresh();
    expect(MOCK_ME.id).toBe('955383222554643433');
    expect(MOCK_IDS.bigGuild).toBe('918427056316849954');
    expect(MOCK_IDS.generalChannel).toBe('1326825835456338361');
    const [newest] = await client.getMessages(MOCK_IDS.generalChannel, { limit: 1 });
    const [oldest] = await client.getMessages(MOCK_IDS.generalChannel, { after: '0', limit: 1 });
    expect(newest.id).toBe('1556637076687194750');
    expect(newest.timestamp).toBe('2026-10-05T12:00:00.000Z');
    expect(oldest.id).toBe('1467852049715855360');
    expect(oldest.timestamp).toBe('2026-02-02T12:00:00.024Z');
  });

  it('keeps ids and ordering stable across calls on the same client', async () => {
    const client = fresh();
    const first = await client.getMessages(MOCK_IDS.generalChannel, { limit: 100 });
    const second = await client.getMessages(MOCK_IDS.generalChannel, { limit: 100 });
    expect(second).toEqual(first);
  });
});

describe('latency and abort', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('simulates 120 ms per call by default', async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    let done = false;
    const pending = client.getMe().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(119);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });

  it('honours a custom latency', async () => {
    vi.useFakeTimers();
    const client = createMockClient({ latencyMs: 500 });
    let done = false;
    const pending = client.getGuilds().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });

  it('rejects with kind "aborted" when the signal fires during the latency and clears the timer', async () => {
    vi.useFakeTimers();
    const client = createMockClient({ latencyMs: 1000 });
    const controller = new AbortController();
    const pending = client.getMessages(MOCK_IDS.generalChannel, { limit: 10 }, controller.signal);
    const outcome = rejection(pending);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    const error = await outcome;
    expect(error.kind).toBe('aborted');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects immediately when the signal is already aborted, for every method', async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    const controller = new AbortController();
    controller.abort();
    const { signal } = controller;
    const calls: Promise<unknown>[] = [
      client.getMe(signal),
      client.getGuilds(signal),
      client.getGuildChannels(MOCK_IDS.bigGuild, signal),
      client.getActiveThreads(MOCK_IDS.bigGuild, signal),
      client.getGuildRoles(MOCK_IDS.bigGuild, signal),
      client.getMyMember(MOCK_IDS.bigGuild, signal),
      client.getDmChannels(signal),
      client.getMessages(MOCK_IDS.generalChannel, {}, signal),
    ];
    for (const call of calls) expect((await rejection(call)).kind).toBe('aborted');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses no timers at all with latencyMs 0', async () => {
    vi.useFakeTimers();
    const client = createMockClient({ latencyMs: 0 });
    await client.getMe();
    await client.getMessages(MOCK_IDS.generalChannel, { limit: 5 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('works with a live signal that is never aborted', async () => {
    const client = createMockClient({ latencyMs: 1 });
    const controller = new AbortController();
    expect((await client.getMessages(MOCK_IDS.edge199Channel, { limit: 5 }, controller.signal)).length).toBe(5);
  });
});

describe('direct messages', () => {
  const client = fresh();
  let dms: Channel[];
  beforeAll(async () => {
    dms = await client.getDmChannels();
  });

  it('lists about thirty DMs and three group DMs in shuffled order', () => {
    const oneToOne = dms.filter((c) => c.type === ChannelType.DM);
    const groups = dms.filter((c) => c.type === ChannelType.GroupDM);
    expect(oneToOne).toHaveLength(30);
    expect(groups).toHaveLength(3);
    expect(new Set(dms.map((c) => c.id)).size).toBe(33);
    for (const c of oneToOne) expect(c.recipients).toHaveLength(1);
    expect(dms.map((c) => c.last_message_id ?? '')).not.toEqual([...dms.map((c) => c.last_message_id ?? '')].sort((a, b) => compareSnowflakes(b, a)));
  });

  it('mixes Korean / English names, default avatars and data-URI SVG avatars', () => {
    const friends = dms.filter((c) => c.type === ChannelType.DM).map((c) => (c.recipients as User[])[0]);
    expect(friends.some((u) => /[\uac00-\ud7af]/.test(u.global_name ?? ''))).toBe(true);
    expect(friends.some((u) => /^[A-Za-z ]+$/.test(u.global_name ?? ''))).toBe(true);
    const defaults = friends.filter((u) => u.avatar === null);
    expect(defaults.length).toBeGreaterThanOrEqual(3);
    for (const u of defaults) expect(avatarUrl(u)).toMatch(/embed\/avatars\/\d\.png$/);
    const withSvg = friends.filter((u) => u.avatar !== null);
    expect(withSvg.length).toBeGreaterThanOrEqual(10);
    for (const u of withSvg) expect(avatarUrl(u)).toBe(u.avatar);
    expect(friends.some((u) => u.global_name === null && u.discriminator !== '0')).toBe(true);
  });

  it('has a named group DM with an icon and unnamed group DMs of different sizes', async () => {
    const named = dms.find((c) => c.id === MOCK_IDS.groupDmNamed);
    const unnamed = dms.find((c) => c.id === MOCK_IDS.groupDmUnnamed);
    const large = dms.find((c) => c.id === MOCK_IDS.groupDmLarge);
    expect(named?.name).toBeTruthy();
    expect(named?.icon).toMatch(/^data:image\/svg\+xml/);
    expect(unnamed?.name).toBeNull();
    expect(large?.name).toBeNull();
    expect(large?.recipients).toHaveLength(8);
    const { buildDmNodes } = await loadTree();
    const nodes = buildDmNodes(dms);
    expect(nodes.find((n) => n.id === MOCK_IDS.groupDmLarge)?.name.length).toBeGreaterThan(30);
  });

  it('has an empty DM and sorts DMs by recent activity', async () => {
    const { buildDmNodes } = await loadTree();
    const empty = dms.find((c) => c.id === MOCK_IDS.dmEmpty);
    expect(empty?.last_message_id ?? null).toBeNull();
    const nodes = buildDmNodes(dms);
    expect(nodes[nodes.length - 1].id).toBe(MOCK_IDS.dmEmpty);
    expect(nodes[0].lastMessageId).not.toBeNull();
  });

  it('contains call system messages in the busy DM and recipient events in the named group DM', async () => {
    const dm = await pageBack(client, MOCK_IDS.dmFriend);
    expect(dm.length).toBe(400);
    const calls = dm.filter((m) => m.type === MessageType.Call);
    expect(calls.length).toBeGreaterThan(3);
    expect(calls.some((m) => m.call?.participants.length === 2 && m.call.ended_timestamp)).toBe(true);
    expect(calls.some((m) => m.call?.participants.length === 1)).toBe(true);
    expect(calls.some((m) => m.call?.ended_timestamp === null)).toBe(true);
    expect(dm.every((m) => m.author.id === MOCK_ME.id || m.author.id === (dms.find((c) => c.id === MOCK_IDS.dmFriend)?.recipients as User[])[0].id)).toBe(true);

    const group = await pageBack(client, MOCK_IDS.groupDmNamed);
    const types = new Set(group.map((m) => m.type));
    for (const t of [MessageType.RecipientAdd, MessageType.RecipientRemove, MessageType.ChannelNameChange, MessageType.ChannelIconChange]) expect(types.has(t), `type ${t}`).toBe(true);
  });
});

describe('generated pictures', () => {
  it('are well-formed SVG data URIs containing only drawing elements', async () => {
    const client = fresh();
    const uris = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === 'string' && value.startsWith('data:')) uris.add(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect(await client.getGuilds());
    collect(await client.getDmChannels());
    collect(await pageBack(client, MOCK_IDS.showcaseChannel));
    expect(uris.size).toBeGreaterThan(20);

    const allowed = new Set(['svg', 'defs', 'linearGradient', 'stop', 'rect', 'text', 'circle', 'polygon']);
    for (const uri of uris) {
      const svg = decodeSvg(uri);
      expect(svg.startsWith('<svg ')).toBe(true);
      expect(svg.endsWith('</svg>')).toBe(true);
      for (const [, tag] of svg.matchAll(/<\/?([A-Za-z]+)/g)) expect(allowed.has(tag), `${tag} in ${svg.slice(0, 80)}`).toBe(true);
      expect(svg).not.toMatch(/on\w+=|<script|javascript:/i);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// whole-world sanity

describe('structural sanity of the whole world', () => {
  const client = fresh();
  const histories = new Map<Snowflake, Message[]>();
  const channelsById = new Map<Snowflake, Channel>();
  const guildOfChannel = new Map<Snowflake, Snowflake>();
  const rolesByGuild = new Map<Snowflake, Set<Snowflake>>();
  const channelIdsByGuild = new Map<Snowflake, Set<Snowflake>>();
  let guildIds: Snowflake[];

  beforeAll(async () => {
    const guilds = await client.getGuilds();
    guildIds = guilds.map((g) => g.id);
    for (const g of guilds) {
      const [channels, threads, roles] = await Promise.all([client.getGuildChannels(g.id), client.getActiveThreads(g.id), client.getGuildRoles(g.id)]);
      rolesByGuild.set(g.id, new Set(roles.map((r) => r.id)));
      channelIdsByGuild.set(g.id, new Set([...channels, ...threads].map((c) => c.id)));
      for (const c of [...channels, ...threads]) {
        channelsById.set(c.id, c);
        guildOfChannel.set(c.id, g.id);
      }
    }
    for (const c of await client.getDmChannels()) channelsById.set(c.id, c);
    for (const c of channelsById.values()) {
      try {
        histories.set(c.id, await pageBack(client, c.id));
      } catch (error) {
        expect((error as DiscordApiError).kind === 'forbidden' || (error as DiscordApiError).status === 400).toBe(true);
      }
    }
  });

  it('read most channels, including every DM and thread', () => {
    expect(channelsById.size).toBeGreaterThan(130);
    expect(histories.size).toBeGreaterThan(110);
    const total = [...histories.values()].reduce((sum, h) => sum + h.length, 0);
    expect(total).toBeGreaterThan(9000);
    for (const c of channelsById.values()) {
      if (c.type === ChannelType.DM || c.type === ChannelType.GroupDM || c.type === ChannelType.PublicThread) expect(histories.has(c.id), c.name ?? c.id).toBe(true);
    }
  });

  it('uses unique snowflake ids for every guild, channel, thread, DM, role and user', async () => {
    const seen = new Set<Snowflake>();
    const add = (id: Snowflake, what: string): void => {
      expect(isSnowflake(id), `${what} ${id}`).toBe(true);
      expect(seen.has(id), `${what} ${id} is not unique`).toBe(false);
      seen.add(id);
    };
    for (const id of guildIds) add(id, 'guild');
    for (const c of channelsById.values()) add(c.id, 'channel');
    // @everyone shares the id of its guild, every other role must be new.
    for (const [guildId, roles] of rolesByGuild) for (const id of roles) if (id !== guildId) add(id, 'role');

    const users = new Map<Snowflake, string>();
    const addUser = (u: User): void => {
      const shape = JSON.stringify(u);
      expect(users.get(u.id) ?? shape, `user ${u.id} has two shapes`).toBe(shape);
      users.set(u.id, shape);
    };
    addUser(MOCK_ME);
    for (const c of channelsById.values()) c.recipients?.forEach(addUser);
    for (const history of histories.values()) {
      for (const m of history) {
        addUser(m.author);
        m.mentions.forEach(addUser);
        if (m.referenced_message) addUser(m.referenced_message.author);
      }
    }
    for (const id of users.keys()) expect(isSnowflake(id)).toBe(true);
    for (const id of users.keys()) expect(guildIds.includes(id) || [...channelsById.keys()].includes(id)).toBe(false);
    expect(users.size).toBeGreaterThan(30);
  });

  it('gives every message a unique id inside its channel and across the whole world', () => {
    const everything = new Set<Snowflake>();
    for (const [channelId, history] of histories) {
      for (const m of history) {
        expect(m.channel_id).toBe(channelId);
        expect(everything.has(m.id), `duplicate message id ${m.id}`).toBe(false);
        everything.add(m.id);
      }
    }
  });

  it('keeps every parent, recipient list and thread parent resolvable', () => {
    for (const c of channelsById.values()) {
      if (c.type === ChannelType.DM) expect(c.recipients).toHaveLength(1);
      if (c.type === ChannelType.GroupDM) expect((c.recipients ?? []).length).toBeGreaterThanOrEqual(2);
      if (c.guild_id) {
        expect(guildIds).toContain(c.guild_id);
        if (c.parent_id) expect(channelsById.get(c.parent_id)?.guild_id).toBe(c.guild_id);
      }
    }
  });

  it('reports last_message_id = id of the newest message (null for empty channels)', () => {
    for (const c of channelsById.values()) {
      const history = histories.get(c.id);
      if (!history) continue;
      const expected = history.length > 0 ? history[history.length - 1].id : null;
      expect(c.last_message_id ?? null, c.name ?? c.id).toBe(expected);
    }
  });

  it('keeps messages ordered in time and not after the world clock', () => {
    for (const history of histories.values()) {
      for (let i = 0; i < history.length; i++) {
        const m = history[i];
        const ts = Date.parse(m.timestamp);
        expect(ts).toBeLessThanOrEqual(MOCK_NOW_MS);
        expect(ts).toBe(snowflakeToTimestamp(m.id));
        if (i > 0) expect(ts - Date.parse(history[i - 1].timestamp)).toBeGreaterThanOrEqual(1000);
        if (m.edited_timestamp) expect(Date.parse(m.edited_timestamp)).toBeGreaterThan(ts);
      }
    }
  });

  it('references real messages (or null) in replies and pins', () => {
    let replies = 0;
    let orphaned = 0;
    for (const [channelId, history] of histories) {
      const ids = new Set(history.map((m) => m.id));
      const guildId = guildOfChannel.get(channelId);
      for (const m of history) {
        if (m.type === MessageType.Reply) {
          replies++;
          expect(m.message_reference?.message_id, 'reply without reference').toBeTruthy();
          expect(m.message_reference?.channel_id).toBe(channelId);
          if (guildId) expect(m.message_reference?.guild_id).toBe(guildId);
          if (m.referenced_message === null) {
            orphaned++;
            expect(ids.has(m.message_reference?.message_id ?? ''), 'deleted original must not exist').toBe(false);
          } else {
            const ref = m.referenced_message;
            expect(ref, 'referenced_message missing').toBeDefined();
            expect(ids.has(ref?.id ?? '')).toBe(true);
            expect(ref?.id).toBe(m.message_reference?.message_id);
            expect(compareSnowflakes(ref?.id ?? '', m.id)).toBe(-1);
            expect(ref?.channel_id).toBe(channelId);
            expect(ref?.referenced_message).toBeUndefined();
          }
        } else {
          expect(m.referenced_message).toBeUndefined();
        }
        if (m.type === MessageType.ChannelPinnedMessage) {
          const target = history.find((x) => x.id === m.message_reference?.message_id);
          expect(target?.pinned, 'pin target must be marked pinned').toBe(true);
          expect(m.content).toBe('');
        }
        if (m.type === MessageType.ThreadCreated) {
          expect(channelsById.get(m.message_reference?.channel_id ?? '')?.parent_id).toBe(channelId);
          expect(m.content).toBe(channelsById.get(m.message_reference?.channel_id ?? '')?.name);
        }
      }
    }
    expect(replies).toBeGreaterThan(300);
    expect(orphaned).toBeGreaterThan(5);
  });

  it('resolves every mention in the content to mentions[], mention_roles or a real channel', () => {
    let users = 0;
    let roles = 0;
    let channels = 0;
    for (const [channelId, history] of histories) {
      const guildId = guildOfChannel.get(channelId);
      for (const m of history) {
        // Mention syntax inside code is plain text on Discord (the markdown samples contain such a decoy on purpose).
        const prose = m.content.replace(/```[\s\S]*?```|`[^`\n]*`/g, '');
        for (const [, id] of prose.matchAll(/<@!?(\d+)>/g)) {
          users++;
          expect(m.mentions.map((u) => u.id), `user mention in ${m.id}`).toContain(id);
        }
        for (const [, id] of prose.matchAll(/<@&(\d+)>/g)) {
          roles++;
          expect(m.mention_roles).toContain(id);
          expect(guildId && rolesByGuild.get(guildId)?.has(id), `role ${id}`).toBe(true);
        }
        for (const [, id] of prose.matchAll(/<#(\d+)>/g)) {
          channels++;
          expect(guildId && channelIdsByGuild.get(guildId)?.has(id), `channel ${id}`).toBe(true);
        }
        for (const id of m.mention_roles) expect(guildId && rolesByGuild.get(guildId)?.has(id), `mention_roles ${id}`).toBe(true);
        if (/(^|\s)@(everyone|here)\b/.test(m.content) && m.type === MessageType.Default) expect(m.mention_everyone).toBe(true);
        if (m.mention_everyone) expect(/@(everyone|here)\b/.test(m.content)).toBe(true);
        for (const u of m.mentions) expect(u.username).toBeTruthy();
      }
    }
    expect(users).toBeGreaterThan(50);
    expect(roles).toBeGreaterThan(5);
    expect(channels).toBeGreaterThan(5);
  });

  it('only uses valid ids for custom emoji and stickers, with consistent reaction data', () => {
    let custom = 0;
    for (const history of histories.values()) {
      for (const m of history) {
        for (const [, id] of m.content.matchAll(/<a?:\w+:(\d+)>/g)) {
          custom++;
          expect(isSnowflake(id)).toBe(true);
        }
        for (const r of m.reactions ?? []) {
          expect(r.count).toBeGreaterThan(0);
          expect(typeof r.me).toBe('boolean');
          if (r.emoji.id !== null) expect(isSnowflake(r.emoji.id)).toBe(true);
          else expect(r.emoji.name).toBeTruthy();
        }
        const reactionKeys = (m.reactions ?? []).map((r) => `${r.emoji.id}|${r.emoji.name}`);
        expect(new Set(reactionKeys).size).toBe(reactionKeys.length);
        for (const s of m.sticker_items ?? []) expect(isSnowflake(s.id)).toBe(true);
      }
    }
    expect(custom).toBeGreaterThan(10);
  });

  it('keeps attachments and embeds well-formed', () => {
    let images = 0;
    for (const history of histories.values()) {
      for (const m of history) {
        expect(new Set(m.attachments.map((a) => a.id)).size).toBe(m.attachments.length);
        for (const a of m.attachments) {
          expect(isSnowflake(a.id)).toBe(true);
          expect(a.filename.length).toBeGreaterThan(0);
          expect(a.size).toBeGreaterThanOrEqual(0);
          expect(a.url).toMatch(/^(data:image\/svg\+xml;base64,|https:\/\/cdn\.discordapp\.com\/attachments\/)/);
          if (a.content_type?.startsWith('image/')) {
            images++;
            expect(a.width).toBeGreaterThan(0);
            expect(a.height).toBeGreaterThan(0);
            expect(a.url.startsWith('data:')).toBe(true);
          }
        }
        for (const e of m.embeds) {
          for (const media of [e.image, e.thumbnail, e.video]) {
            if (media?.proxy_url) expect(media.proxy_url).toMatch(/^(data:image\/svg\+xml;base64,|https:\/\/)/);
          }
        }
      }
    }
    expect(images).toBeGreaterThan(50);
  });

  it('is JSON-safe (no undefined fields) and within the 2,000-character limit', () => {
    for (const history of histories.values()) {
      for (const m of history) {
        for (const [key, value] of Object.entries(m)) expect(value, `${key} of ${m.id}`).not.toBeUndefined();
        expect(m.content.length).toBeLessThanOrEqual(2000);
      }
    }
  });

  it('answers every MOCK_IDS entry from the generated world, and no unknown id', () => {
    const known = new Set<Snowflake>([...guildIds, ...channelsById.keys()]);
    for (const roles of rolesByGuild.values()) for (const id of roles) known.add(id);
    const { unknownChannel, unknownGuild, roles, ...rest } = MOCK_IDS;
    for (const id of flattenIds(rest)) expect(known.has(id), `MOCK_IDS id ${id}`).toBe(true);
    for (const id of flattenIds(roles)) expect(known.has(id), `role ${id}`).toBe(true);
    expect(known.has(unknownChannel)).toBe(false);
    expect(known.has(unknownGuild)).toBe(false);
    expect(isSnowflake(unknownChannel)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// corpus coverage

describe('message corpus', () => {
  const client = fresh();
  let showcase: Message[];
  let general: Message[];

  beforeAll(async () => {
    showcase = await pageBack(client, MOCK_IDS.showcaseChannel);
    general = await pageBack(client, MOCK_IDS.generalChannel);
  });

  const text = (m: Message): string => m.content;
  const features: [string, (m: Message) => boolean][] = [
    ['plain text', (m) => m.type === 0 && /^[\p{L}\p{N} .,!?'"]+$/u.test(text(m))],
    ['long multi-paragraph text', (m) => text(m).includes('\n\n') && text(m).length > 500],
    ['text close to the 2,000-char limit', (m) => text(m).length >= 1900],
    ['Korean + English + emoji', (m) => /[\uac00-\ud7af]/.test(text(m)) && /[A-Za-z]/.test(text(m)) && /\p{Extended_Pictographic}/u.test(text(m))],
    ['RTL text', (m) => /[\u0590-\u06ff]/.test(text(m))],
    ['zero-width characters', (m) => /[\u200b\u200c\u200d\ufeff]/.test(text(m))],
    ['markdown: bold', (m) => /\*\*[^*]+\*\*/.test(text(m))],
    ['markdown: italic', (m) => /(^|[^*])\*[^*\s][^*]*\*(?!\*)/.test(text(m))],
    ['markdown: underline', (m) => /__[^_]+__/.test(text(m))],
    ['markdown: strikethrough', (m) => /~~[^~]+~~/.test(text(m))],
    ['markdown: spoiler', (m) => /\|\|[^|]+\|\|/.test(text(m))],
    ['markdown: inline code', (m) => /(^|[^`])`[^`\n]+`/.test(text(m))],
    ['markdown: fenced code with language', (m) => /```[a-z]+\n/.test(text(m))],
    ['markdown: fenced code without language', (m) => /```\n/.test(text(m))],
    ['markdown: quote', (m) => /^> .+/m.test(text(m))],
    ['markdown: multi-line quote', (m) => /^> .+\n> .+/m.test(text(m)) && /^>>> /m.test(text(showcase.find((x) => /^>>> /m.test(text(x))) ?? m))],
    ['markdown: headings', (m) => /^#{1,3} \S/m.test(text(m))],
    ['markdown: subtext', (m) => /^-# \S/m.test(text(m))],
    ['markdown: bullet list', (m) => /^- .+\n- .+/m.test(text(m))],
    ['markdown: ordered list', (m) => /^1\. .+\n2\. /m.test(text(m))],
    ['markdown: masked link', (m) => /\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(text(m))],
    ['markdown: bare link', (m) => /(^|\s)https?:\/\/\S+/.test(text(m))],
    ['markdown: nested formatting', (m) => /\*\*\*.+\*\*\*/.test(text(m))],
    ['markdown: escapes', (m) => /\\\*/.test(text(m))],
    ['user mention', (m) => /<@!?\d+>/.test(text(m)) && m.mentions.length > 0],
    ['legacy nickname mention', (m) => /<@!\d+>/.test(text(m))],
    ['role mention', (m) => /<@&\d+>/.test(text(m)) && m.mention_roles.length > 0],
    ['channel mention', (m) => /<#\d+>/.test(text(m))],
    ['@everyone mention', (m) => text(m).includes('@everyone') && m.mention_everyone === true],
    ['@here mention', (m) => text(m).includes('@here') && m.mention_everyone === true],
    ['custom emoji', (m) => /<:\w+:\d+>/.test(text(m))],
    ['animated custom emoji', (m) => /<a:\w+:\d+>/.test(text(m))],
    ['timestamp tag', (m) => /<t:\d+:R>/.test(text(m))],
    ['reply', (m) => m.type === MessageType.Reply && m.referenced_message != null],
    ['reply to a deleted message', (m) => m.type === MessageType.Reply && m.referenced_message === null],
    ['edited message', (m) => m.edited_timestamp !== null],
    ['image attachment (data-URI SVG with size)', (m) => m.attachments.some((a) => a.content_type === 'image/png' && a.url.startsWith('data:image/svg+xml') && a.width === 1280 && a.height === 720)],
    ['multiple images', (m) => m.attachments.filter((a) => a.content_type?.startsWith('image/')).length >= 4],
    ['video attachment', (m) => m.attachments.some((a) => a.content_type === 'video/mp4')],
    ['audio attachment', (m) => m.attachments.some((a) => a.content_type === 'audio/mpeg')],
    ['voice message', (m) => ((m.flags ?? 0) & 8192) !== 0 && m.attachments.some((a) => a.waveform && a.duration_secs)],
    ['pdf attachment', (m) => m.attachments.some((a) => a.content_type === 'application/pdf')],
    ['zip attachment', (m) => m.attachments.some((a) => a.content_type === 'application/zip')],
    ['SPOILER_ image', (m) => m.attachments.some((a) => a.filename.startsWith('SPOILER_'))],
    ['hostile attachment names', (m) => m.attachments.some((a) => /^CON\./.test(a.filename)) && m.attachments.some((a) => a.filename.includes('..\\'))],
    ['attachment-only message', (m) => m.content === '' && m.attachments.length > 0],
    ['link-preview embed with thumbnail and provider', (m) => m.embeds.some((e) => e.type === 'article' && e.thumbnail?.proxy_url && e.provider?.name)],
    ['rich embed with every part', (m) => m.embeds.some((e) => e.type === 'rich' && e.color !== undefined && e.author && (e.fields?.length ?? 0) >= 3 && e.footer && e.timestamp && e.thumbnail && e.image)],
    ['image embed', (m) => m.embeds.some((e) => e.type === 'image')],
    ['video embed', (m) => m.embeds.some((e) => e.type === 'video' && e.video?.url)],
    ['gifv embed', (m) => m.embeds.some((e) => e.type === 'gifv')],
    ['text-only embed', (m) => m.embeds.some((e) => e.type === 'link' && !e.thumbnail)],
    ['unicode reaction', (m) => (m.reactions ?? []).some((r) => r.emoji.id === null)],
    ['custom reaction', (m) => (m.reactions ?? []).some((r) => r.emoji.id !== null)],
    ['reaction by me', (m) => (m.reactions ?? []).some((r) => r.me === true)],
    ['sticker (png)', (m) => (m.sticker_items ?? []).some((s) => s.format_type === 1)],
    ['sticker (lottie)', (m) => (m.sticker_items ?? []).some((s) => s.format_type === 3)],
    ['sticker (gif)', (m) => (m.sticker_items ?? []).some((s) => s.format_type === 4)],
    ['system: user join (7)', (m) => m.type === MessageType.UserJoin],
    ['system: pin (6)', (m) => m.type === MessageType.ChannelPinnedMessage],
    ['system: boost (8)', (m) => m.type === MessageType.GuildBoost],
    ['system: thread created (18)', (m) => m.type === MessageType.ThreadCreated],
    ['bot message', (m) => m.author.bot === true && m.webhook_id === undefined],
    ['slash-command response', (m) => m.type === MessageType.ChatInputCommand && m.interaction !== undefined],
    ['webhook message', (m) => m.webhook_id !== undefined && m.webhook_id === m.author.id],
    ['poll', (m) => m.poll !== undefined && m.poll.answers.length >= 3],
    ['finalized poll', (m) => m.poll?.results?.is_finalized === true],
    ['forwarded message', (m) => m.message_reference?.type === 1 && (m.message_snapshots?.length ?? 0) === 1 && m.content === ''],
    ['formula-injection content (=)', (m) => text(m).startsWith('=')],
    ['formula-injection content (+)', (m) => text(m).startsWith('+')],
    ['formula-injection content (-)', (m) => text(m).startsWith('-')],
    ['formula-injection content (@)', (m) => text(m).startsWith('@')],
    ['tab-led content', (m) => text(m).startsWith('\t')],
    ['formula-like author name', (m) => (m.author.global_name ?? '').startsWith('=')],
    ['HTML / script injection text', (m) => text(m).includes('<script>')],
    ['unsafe link scheme', (m) => text(m).includes('javascript:')],
    ['XML-invalid control characters', (m) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text(m))],
    ['author without display name', (m) => m.author.global_name === null],
    ['author with a very long display name', (m) => (m.author.global_name ?? '').length > 60],
    ['author with emoji display name', (m) => /\p{Extended_Pictographic}/u.test(m.author.global_name ?? '')],
  ];

  it.each(features)('showcase contains: %s', (_name, predicate) => {
    expect(showcase.some(predicate)).toBe(true);
  });

  it('showcase groups authors: runs within and beyond seven minutes', () => {
    let within = 0;
    let beyond = 0;
    for (let i = 1; i < showcase.length; i++) {
      if (showcase[i].author.id !== showcase[i - 1].author.id) continue;
      const gap = Date.parse(showcase[i].timestamp) - Date.parse(showcase[i - 1].timestamp);
      if (gap < 7 * MINUTE) within++;
      else if (gap < 8 * MINUTE) beyond++; // the hand-timed 7m01s case
    }
    expect(within).toBeGreaterThan(2);
    expect(beyond).toBeGreaterThanOrEqual(1);
  });

  it('showcase and general cross day boundaries and contain multi-month silences', () => {
    for (const history of [showcase, general]) {
      const gaps: number[] = [];
      let dayChanges = 0;
      for (let i = 1; i < history.length; i++) {
        gaps.push(Date.parse(history[i].timestamp) - Date.parse(history[i - 1].timestamp));
        if (history[i].timestamp.slice(0, 10) !== history[i - 1].timestamp.slice(0, 10)) dayChanges++;
      }
      expect(Math.max(...gaps)).toBeGreaterThan(60 * DAY);
      expect(dayChanges).toBeGreaterThan(5);
    }
  });

  it('general mixes day-to-day activity: bursts, long runs by one author and >7-minute pauses', () => {
    let sameAuthorWithin = 0;
    let sameAuthorBeyond = 0;
    for (let i = 1; i < general.length; i++) {
      if (general[i].author.id !== general[i - 1].author.id) continue;
      const gap = Date.parse(general[i].timestamp) - Date.parse(general[i - 1].timestamp);
      if (gap < 7 * MINUTE) sameAuthorWithin++;
      else sameAuthorBeyond++;
    }
    expect(sameAuthorWithin).toBeGreaterThan(300);
    expect(sameAuthorBeyond).toBeGreaterThan(20);
  });

  it.each<[string, (m: Message) => boolean]>([
    ['replies', (m) => m.type === MessageType.Reply && m.referenced_message != null],
    ['deleted-original replies', (m) => m.type === MessageType.Reply && m.referenced_message === null],
    ['edits', (m) => m.edited_timestamp !== null],
    ['image attachments', (m) => m.attachments.some((a) => a.width !== undefined && a.width !== null)],
    ['reactions with me', (m) => (m.reactions ?? []).some((r) => r.me)],
    ['embeds', (m) => m.embeds.length > 0],
    ['join messages', (m) => m.type === MessageType.UserJoin],
    ['pin messages', (m) => m.type === MessageType.ChannelPinnedMessage],
    ['boost messages', (m) => m.type === MessageType.GuildBoost],
    ['thread-created messages', (m) => m.type === MessageType.ThreadCreated],
    ['bot messages', (m) => m.author.bot === true],
    ['polls', (m) => m.poll !== undefined],
    ['forwards', (m) => (m.message_snapshots?.length ?? 0) > 0],
    ['fenced code', (m) => m.content.includes('```')],
    ['custom emoji', (m) => /<a?:\w+:\d+>/.test(m.content)],
    ['mentions', (m) => m.mentions.length > 0],
  ])('the 2,600-message channel also contains: %s', (_name, predicate) => {
    expect(general.filter(predicate).length).toBeGreaterThanOrEqual(3);
  });
});

describe('the calls the extension engine makes: getChannel, getGuild, searchThreads, refreshAttachmentUrls', () => {
  it('getChannel returns the channel object with its type, name, parent and guild', async () => {
    const client = fresh();
    const channel = await client.getChannel(MOCK_IDS.generalChannel);
    expect(channel).toMatchObject({ id: MOCK_IDS.generalChannel, type: ChannelType.GuildText, name: 'general', guild_id: MOCK_IDS.bigGuild, parent_id: MOCK_IDS.generalCategory });
    expect((await client.getChannel(MOCK_IDS.generalCategory)).type).toBe(ChannelType.GuildCategory);
    expect((await client.getChannel(MOCK_IDS.forumChannel)).type).toBe(ChannelType.GuildForum);
    expect((await client.getChannel(MOCK_IDS.generalThread)).type).toBe(ChannelType.PublicThread);
  });

  it('getChannel serves DMs with their recipients', async () => {
    const client = fresh();
    const dm = await client.getChannel(MOCK_IDS.dmFriend);
    expect(dm.type).toBe(ChannelType.DM);
    expect(dm.guild_id).toBeUndefined();
    expect(dm.recipients).toHaveLength(1);
    const group = await client.getChannel(MOCK_IDS.groupDmNamed);
    expect(group.type).toBe(ChannelType.GroupDM);
    expect(group.recipients!.length).toBeGreaterThan(1);
  });

  it('getChannel answers 403 / 404 like the real endpoint and hands out copies', async () => {
    const client = fresh();
    await expect(client.getChannel(MOCK_IDS.hiddenChannel)).rejects.toMatchObject({ kind: 'forbidden', status: 403, code: 50001 });
    await expect(client.getChannel(MOCK_IDS.forbiddenChannel)).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(client.getChannel(MOCK_IDS.unknownChannel)).rejects.toMatchObject({ kind: 'not-found', status: 404 });
    const channel = await client.getChannel(MOCK_IDS.generalChannel);
    channel.name = 'MUTATED';
    expect((await client.getChannel(MOCK_IDS.generalChannel)).name).toBe('general');
  });

  it('getGuild returns the guild summary (name and icon), 404 for an unknown guild, and a copy', async () => {
    const client = fresh();
    const guild = await client.getGuild(MOCK_IDS.bigGuild);
    expect(guild).toMatchObject({ id: MOCK_IDS.bigGuild, name: '개발자 라운지' });
    expect(guild.icon).not.toBeNull();
    guild.name = 'MUTATED';
    expect((await client.getGuild(MOCK_IDS.bigGuild)).name).toBe('개발자 라운지');
    await expect(client.getGuild(MOCK_IDS.unknownGuild)).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('searchThreads lists the threads of a channel, 25 per page, with has_more', async () => {
    const client = fresh();
    const forum = await client.searchThreads(MOCK_IDS.forumChannel, { archived: false, offset: 0 });
    expect(forum.status).toBe('ready');
    if (forum.status !== 'ready') return;
    expect(forum.threads.map((t) => t.id).sort()).toEqual([...MOCK_IDS.forumThreads].sort());
    expect(forum.hasMore).toBe(false);
    // most recently active first
    const lastIds = forum.threads.map((t) => t.last_message_id ?? t.id);
    expect(lastIds).toEqual([...lastIds].sort((a, b) => compareSnowflakes(b, a)));
    const beyond = await client.searchThreads(MOCK_IDS.forumChannel, { archived: false, offset: 25 });
    expect(beyond).toEqual({ status: 'ready', threads: [], hasMore: false });
  });

  it('searchThreads: archived threads do not exist in the demo world, other channels have none', async () => {
    const client = fresh();
    expect(await client.searchThreads(MOCK_IDS.forumChannel, { archived: true, offset: 0 })).toEqual({ status: 'ready', threads: [], hasMore: false });
    expect(await client.searchThreads(MOCK_IDS.edge200Channel, { archived: false, offset: 0 })).toEqual({ status: 'ready', threads: [], hasMore: false });
    const general = await client.searchThreads(MOCK_IDS.generalChannel, { archived: false, offset: 0 });
    expect(general.status === 'ready' && general.threads.map((t) => t.id).sort()).toEqual([MOCK_IDS.generalThread, MOCK_IDS.generalThread2].sort());
  });

  it('searchThreads answers 403 / 404 and honours the abort signal', async () => {
    const client = fresh();
    await expect(client.searchThreads(MOCK_IDS.hiddenChannel, { archived: false, offset: 0 })).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(client.searchThreads(MOCK_IDS.unknownChannel, { archived: false, offset: 0 })).rejects.toMatchObject({ kind: 'not-found' });
    const controller = new AbortController();
    controller.abort();
    await expect(client.searchThreads(MOCK_IDS.forumChannel, { archived: false, offset: 0 }, controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('every active thread of the world is found through the search of its parent', async () => {
    const client = fresh();
    const world = await client.getGuilds();
    for (const guild of world) {
      const found = new Set<string>();
      for (const channel of await client.getGuildChannels(guild.id)) {
        const page = await client.searchThreads(channel.id, { archived: false, offset: 0 }).catch(() => null);
        if (page?.status === 'ready') for (const thread of page.threads) found.add(thread.id);
      }
      expect([...found].sort()).toEqual((await client.getActiveThreads(guild.id)).map((t) => t.id).sort());
    }
  });
});
