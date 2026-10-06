/**
 * A small scriptable `DiscordClient` for the tests of `exportChat` and the engine-style loops around it: a hand-made world
 * (one guild or none, any channels, any messages, thread search results) with the same paging rules as the real API and
 * the demo client, a log of every call, and a hook that makes chosen calls fail. Nothing here sleeps or touches a network.
 */
import { DiscordApiError } from '../../../src/lib/discord/client';
import type { DiscordClient, GetMessagesOptions, ThreadSearchPage, ThreadSearchQuery } from '../../../src/lib/discord/client';
import { compareSnowflakes, timestampToSnowflake } from '../../../src/lib/discord/snowflake';
import type { Channel, GuildSummary, Message, Role, Snowflake, User } from '../../../src/lib/discord/types';

export const GUILD_ID = '700000000000000001';
export const ALICE: User = { id: '1000', username: 'alice', global_name: 'Alice' };
export const BOB: User = { id: '2000', username: 'bob', global_name: 'Bob' };
export const BOT: User = { id: '4000', username: 'helper', bot: true };

/** Real, ordered snowflakes: 2026-10-01 00:00:00 UTC plus `minutes` (the low bits carry `n`). */
export const DAY0 = Date.UTC(2026, 9, 1);
export function idAt(minutes: number, n = 0): Snowflake {
  return (BigInt(timestampToSnowflake(DAY0 + minutes * 60_000)) + BigInt(n)).toString();
}

export function msg(minutes: number, content: string, extra: Partial<Message> = {}, channelId: Snowflake = '800000000000000001'): Message {
  return {
    id: idAt(minutes),
    channel_id: channelId,
    author: ALICE,
    content,
    timestamp: new Date(DAY0 + minutes * 60_000).toISOString(),
    edited_timestamp: null,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    type: 0,
    ...extra,
  };
}

export interface FakeWorld {
  guild?: GuildSummary;
  roles?: Role[];
  /** Every channel the client can be asked about: guild channels (categories included), threads, DMs. */
  channels: Channel[];
  /** Messages per channel id, in any order. */
  messages?: Record<Snowflake, Message[]>;
  /** What the thread search of a channel lists (active ones, then those with `thread_metadata.archived`). */
  threads?: Record<Snowflake, Channel[]>;
}

/** Which call is being made: the method, the channel / guild it is about and how many such calls came before. */
export interface FakeCall {
  method: 'getChannel' | 'getGuild' | 'getGuildChannels' | 'getGuildRoles' | 'getMessages' | 'searchThreads';
  id: Snowflake;
  /** 0-based count of earlier calls of this method for this id. */
  n: number;
  options?: GetMessagesOptions | ThreadSearchQuery;
}

export interface FakeClient extends DiscordClient {
  /** Every call, in order, as `method:id` (messages also with their cursor: `getMessages:id:before=...`). */
  readonly log: string[];
  /** The calls of one method. */
  calls(method: FakeCall['method']): FakeCall[];
}

export type Failure = DiscordApiError | Error | undefined;

export function fakeClient(world: FakeWorld, fail: (call: FakeCall) => Failure | Promise<Failure> = () => undefined): FakeClient {
  const log: string[] = [];
  const calls: FakeCall[] = [];
  const counts = new Map<string, number>();
  const byId = new Map(world.channels.map((channel) => [channel.id, channel]));

  async function enter(method: FakeCall['method'], id: Snowflake, signal: AbortSignal | undefined, options?: FakeCall['options']): Promise<void> {
    const key = `${method}:${id}`;
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    const call: FakeCall = { method, id, n, options };
    calls.push(call);
    const cursor = options !== undefined && 'before' in options && options.before !== undefined ? `:before=${options.before}` : '';
    log.push(`${key}${cursor}`);
    if (signal?.aborted) throw new DiscordApiError('aborted', 'The request was aborted');
    const failure = await fail(call);
    if (failure !== undefined) throw failure;
  }

  const client: FakeClient = {
    kind: 'mock',
    log,
    calls: (method) => calls.filter((call) => call.method === method),

    async getMe(): Promise<User> {
      return ALICE;
    },
    async getChannel(channelId, signal) {
      await enter('getChannel', channelId, signal);
      const channel = byId.get(channelId);
      if (channel === undefined) throw new DiscordApiError('not-found', 'Unknown Channel', { status: 404, code: 10003 });
      return structuredClone(channel);
    },
    async getGuild(guildId, signal) {
      await enter('getGuild', guildId, signal);
      if (world.guild === undefined || world.guild.id !== guildId) throw new DiscordApiError('not-found', 'Unknown Guild', { status: 404 });
      return structuredClone(world.guild);
    },
    async getGuildChannels(guildId, signal) {
      await enter('getGuildChannels', guildId, signal);
      return structuredClone(world.channels.filter((channel) => channel.guild_id === guildId));
    },
    async getGuildRoles(guildId, signal) {
      await enter('getGuildRoles', guildId, signal);
      return structuredClone(world.roles ?? []);
    },
    async getMyMember() {
      return { roles: [] };
    },
    async getMessages(channelId, options: GetMessagesOptions = {}, signal) {
      await enter('getMessages', channelId, signal, options);
      const all = [...(world.messages?.[channelId] ?? [])].sort((a, b) => compareSnowflakes(a.id, b.id));
      const limit = Math.min(100, Math.max(1, options.limit ?? 50));
      let window = all;
      if (options.before !== undefined) window = window.filter((m) => compareSnowflakes(m.id, options.before as string) < 0);
      if (options.after !== undefined) window = window.filter((m) => compareSnowflakes(m.id, options.after as string) > 0);
      const page = options.after !== undefined ? window.slice(0, limit) : window.slice(Math.max(0, window.length - limit));
      return structuredClone(page).reverse();
    },
    async searchThreads(channelId, query: ThreadSearchQuery, signal): Promise<ThreadSearchPage> {
      await enter('searchThreads', channelId, signal, query);
      const all = (world.threads?.[channelId] ?? []).filter((thread) => (thread.thread_metadata?.archived === true) === query.archived);
      const threads = all.slice(query.offset, query.offset + 25);
      return { status: 'ready', threads: structuredClone(threads), hasMore: query.offset + 25 < all.length };
    },
    async refreshAttachmentUrls(urls) {
      return urls.map((original) => ({ original, refreshed: `${original}&refreshed=1` }));
    },
  };
  return client;
}

// --- a ready-made world -------------------------------------------------------------------------------------------------

export const CATEGORY_ID = '800000000000000010';
export const TEXT_ID = '800000000000000001';
export const FORUM_ID = '800000000000000002';
export const NEWS_ID = '800000000000000003';
export const DM_ID = '800000000000000004';

export const GUILD: GuildSummary = { id: GUILD_ID, name: 'Test Guild', icon: null };

export function channel(id: Snowflake, type: number, extra: Partial<Channel> = {}): Channel {
  return { id, type, guild_id: GUILD_ID, ...extra };
}

export function thread(id: Snowflake, parentId: Snowflake, name: string, extra: Partial<Channel> = {}): Channel {
  return { id, type: 11, guild_id: GUILD_ID, parent_id: parentId, name, ...extra };
}
