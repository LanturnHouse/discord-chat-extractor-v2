import { timestampToSnowflake } from '../snowflake';
import type { Snowflake } from '../types';
import { hashString } from './prng';

/** Fixed "now" of the demo world: the newest message of the busiest channel is stamped about this time. */
export const WORLD_NOW_MS = Date.UTC(2026, 9, 5, 12, 0, 0);

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Real snowflake: `timestamp << 22 | worker << 12 | sequence`. Ordering and time maths therefore work like with Discord ids.
 * `timestampToSnowflake` leaves the low 22 bits zero, so adding the worker/sequence bits cannot disturb the time part.
 */
export function mintId(ms: number, sequence: number, worker: number): Snowflake {
  const low = (BigInt(worker & 0x3ff) << 12n) | BigInt(sequence & 0xfff);
  return (BigInt(timestampToSnowflake(ms)) + low).toString();
}

type IdNamespace = 'user' | 'guild' | 'channel' | 'thread' | 'role' | 'emoji' | 'sticker' | 'webhook';

/** Creation-time windows per entity kind; channels predate every message, threads start within the message window. */
const WINDOWS: Record<IdNamespace, readonly [number, number]> = {
  user: [Date.UTC(2017, 0, 1), Date.UTC(2024, 11, 31)],
  guild: [Date.UTC(2019, 0, 1), Date.UTC(2024, 5, 30)],
  channel: [Date.UTC(2024, 6, 1), Date.UTC(2025, 11, 31)],
  thread: [Date.UTC(2026, 2, 1), Date.UTC(2026, 8, 20)],
  role: [Date.UTC(2019, 0, 1), Date.UTC(2024, 5, 30)],
  emoji: [Date.UTC(2023, 0, 1), Date.UTC(2025, 5, 30)],
  sticker: [Date.UTC(2023, 0, 1), Date.UTC(2025, 5, 30)],
  webhook: [Date.UTC(2024, 0, 1), Date.UTC(2025, 5, 30)],
};

/**
 * Stable id for a (namespace, key) pair. Pure function of its arguments, so ids exist before any world is built
 * (that is what lets `MOCK_IDS` be a plain constant) and never change between runs.
 */
export function keyId(ns: IdNamespace, key: string): Snowflake {
  const [from, to] = WINDOWS[ns];
  const h1 = hashString(`${ns}:${key}:time`);
  const h2 = hashString(`${ns}:${key}:low`);
  return mintId(from + Math.floor((h1 / 4294967296) * (to - from)), h2, h2 >>> 12);
}

export const userId = (key: string): Snowflake => keyId('user', key);
export const guildId = (guildKey: string): Snowflake => keyId('guild', guildKey);
export const channelId = (guildKey: string, key: string): Snowflake => keyId('channel', `${guildKey}/${key}`);
export const threadId = (guildKey: string, key: string): Snowflake => keyId('thread', `${guildKey}/${key}`);
export const dmId = (key: string): Snowflake => keyId('channel', `dm/${key}`);
/** `@everyone` shares the id of its guild, like on Discord. */
export const roleId = (guildKey: string, key: string): Snowflake => (key === 'everyone' ? guildId(guildKey) : keyId('role', `${guildKey}/${key}`));

/** Worker bits for message ids of one channel: unrelated channels get different low bits. Stays below 1000, ids with 1000+ are reserved for synthetic ones. */
function workerOf(seedKey: string): number {
  return hashString(`worker:${seedKey}`) % 1000;
}

/** Id of message number `index` (0-based, ascending) stamped at `ts`. */
export function messageId(seedKey: string, ts: number, index: number): Snowflake {
  return mintId(ts, index, workerOf(seedKey));
}

/** Ids that cannot collide with any real message id of a channel (worker >= 1000). */
export function syntheticId(ts: number, sequence: number): Snowflake {
  return mintId(ts, sequence, 1000 + (sequence % 20));
}

export const isoOf = (ms: number): string => new Date(ms).toISOString();

/** Ids that are valid snowflakes but never exist in the demo world (for 404 tests). */
const UNKNOWN_ID = mintId(Date.UTC(2025, 0, 1), 1, 1023);
const UNKNOWN_GUILD_ID = mintId(Date.UTC(2025, 0, 2), 2, 1023);

/**
 * Ids worth knowing for tests, verification scripts and the demo. Every value is checked against the generated
 * world by the test suite, so a typo here fails loudly.
 */
export const MOCK_IDS = {
  // Guilds (API order of `getGuilds()`)
  bigGuild: guildId('dev-lounge'),
  englishGuild: guildId('open-source-garage'),
  emojiGuild: guildId('game-night'),
  longNameGuild: guildId('long-name'),
  specialCharsGuild: guildId('special-chars'),
  reservedNameGuild: guildId('reserved-con'),
  hostileNameGuild: guildId('hostile-name'),
  rtlGuild: guildId('rtl'),
  dotsGuild: guildId('dots'),

  // Main guild: channels
  /** 2,600+ messages over ~8 months, newest at about WORLD_NOW. Two active threads. */
  generalChannel: channelId('dev-lounge', 'general'),
  /** Exactly one of every message feature (markdown, attachments, embeds, system messages, ...). */
  showcaseChannel: channelId('dev-lounge', 'showcase'),
  announcementChannel: channelId('dev-lounge', 'announcements'),
  /** Plain text channel at the top level (no category). */
  welcomeChannel: channelId('dev-lounge', 'welcome'),
  uncategorizedVoiceChannel: channelId('dev-lounge', 'lobby'),
  voiceChannel: channelId('dev-lounge', 'voice-lounge'),
  stageChannel: channelId('dev-lounge', 'stage'),
  forumChannel: channelId('dev-lounge', 'forum'),
  /** Listed and visible according to the permission maths, but `getMessages` rejects with 'forbidden'. */
  forbiddenChannel: channelId('dev-lounge', 'forbidden'),
  /** Hidden by permission overwrites (and `getMessages` rejects with 'forbidden'). */
  hiddenChannel: channelId('dev-lounge', 'mod-only'),
  /** Visible only because a role overwrite re-allows what @everyone denies. */
  roleOverwriteChannel: channelId('dev-lounge', 'devs-only'),
  /** Visible only because a member overwrite re-allows what @everyone denies. */
  memberOverwriteChannel: channelId('dev-lounge', 'secret-club'),
  /** Role overwrites deny and allow VIEW_CHANNEL at once: allow wins, so it is visible. */
  conflictingOverwriteChannel: channelId('dev-lounge', 'role-conflict'),
  /** Hidden by a member overwrite that denies the current user. */
  memberDeniedChannel: channelId('dev-lounge', 'personal-block'),
  emptyChannel: channelId('dev-lounge', 'empty'),
  edge199Channel: channelId('dev-lounge', 'edge-199'),
  edge200Channel: channelId('dev-lounge', 'edge-200'),
  edge201Channel: channelId('dev-lounge', 'edge-201'),
  edge400Channel: channelId('dev-lounge', 'edge-400'),
  edge401Channel: channelId('dev-lounge', 'edge-401'),
  /** Channels named like Windows reserved device names. */
  reservedNameChannel: channelId('dev-lounge', 'con'),
  reservedNameChannel2: channelId('dev-lounge', 'nul'),

  // Main guild: categories
  emptyCategory: channelId('dev-lounge', 'cat-archive'),
  voiceOnlyCategory: channelId('dev-lounge', 'cat-voice'),
  hiddenCategory: channelId('dev-lounge', 'cat-staff'),
  generalCategory: channelId('dev-lounge', 'cat-general'),

  // Main guild: active threads
  forumThreads: [
    threadId('dev-lounge', 'forum-ts-generics'),
    threadId('dev-lounge', 'forum-vite-chunk'),
    threadId('dev-lounge', 'forum-mv3-worker'),
    threadId('dev-lounge', 'forum-first-pr'),
    threadId('dev-lounge', 'forum-long-title'),
  ],
  /** Thread under `generalChannel`. */
  generalThread: threadId('dev-lounge', 'general-lunch-poll'),
  /** Thread under `generalChannel` with 60 messages. */
  generalThread2: threadId('dev-lounge', 'general-release-notes'),
  /** Thread under the announcement channel (type 10). */
  announcementThread: threadId('dev-lounge', 'announce-questions'),

  // DMs
  /** Busiest 1:1 DM (400 messages incl. calls, stickers, voice messages). */
  dmFriend: dmId('minjun'),
  dmFriendEnglish: dmId('alex'),
  /** Friend without an avatar (default avatar fallback). */
  dmNoAvatar: dmId('haeun'),
  /** Friend whose username uses a legacy discriminator and has no display name. */
  dmLegacyDiscriminator: dmId('legacy'),
  /** DM that exists but has no messages (`last_message_id` null). */
  dmEmpty: dmId('liam'),
  /** Named group DM with an icon (recipient add/remove, rename and icon-change system messages). */
  groupDmNamed: dmId('group-board-games'),
  groupDmUnnamed: dmId('group-trip'),
  /** Unnamed group DM with eight recipients (very long joined name). */
  groupDmLarge: dmId('group-large'),

  // Roles of the main guild
  roles: {
    everyone: roleId('dev-lounge', 'everyone'),
    member: roleId('dev-lounge', 'member'),
    developer: roleId('dev-lounge', 'developer'),
    moderator: roleId('dev-lounge', 'moderator'),
    admin: roleId('dev-lounge', 'admin'),
  },

  /** Valid snowflakes that never exist (404 tests). */
  unknownChannel: UNKNOWN_ID,
  unknownGuild: UNKNOWN_GUILD_ID,
} as const;

export type MockIds = typeof MOCK_IDS;
