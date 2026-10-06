import type { MyMember } from './client';
import { ChannelType } from './types';
import type { Channel, PermissionOverwrite, Role, Snowflake } from './types';

/** Permission bits we care about (https://discord.com/developers/docs/topics/permissions). */
export const ADMINISTRATOR = 1n << 3n;
export const VIEW_CHANNEL = 1n << 10n;
export const READ_MESSAGE_HISTORY = 1n << 16n;
export const CONNECT = 1n << 20n;

/** Every permission bit (Discord defines fewer than 64 today). */
const ALL_PERMISSIONS = (1n << 64n) - 1n;

export interface GuildPermissionInfo {
  owner?: boolean;
  /** `permissions` of the guild entry in `GET /users/@me/guilds`: the user's guild-wide permissions as computed by Discord. */
  permissions?: string;
}

const THREAD_TYPES: ReadonlySet<number> = new Set([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);

function parseBits(value: string | undefined): bigint {
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function applyOverwrite(permissions: bigint, overwrite: PermissionOverwrite | undefined): bigint {
  if (!overwrite) return permissions;
  return (permissions & ~parseBits(overwrite.deny)) | parseBits(overwrite.allow);
}

/**
 * Guild-wide permissions of the current user (before channel overwrites):
 * owner / ADMINISTRATOR => everything; otherwise the OR of @everyone and the member's roles.
 * Discord's own figure from the guild list is OR-ed in so a missing or incomplete role list can only err on the side of "visible".
 */
export function computeBasePermissions(guildId: Snowflake, guild: GuildPermissionInfo, roles: Role[], member: MyMember): bigint {
  if (guild.owner === true) return ALL_PERMISSIONS;

  const memberRoles = new Set(member.roles);
  let permissions = parseBits(guild.permissions);
  for (const role of roles) {
    if (role.id === guildId || memberRoles.has(role.id)) permissions |= parseBits(role.permissions);
  }
  return (permissions & ADMINISTRATOR) === ADMINISTRATOR ? ALL_PERMISSIONS : permissions;
}

/** Standard Discord algorithm: @everyone overwrite, then all role overwrites together (denies first, then allows), then the member overwrite. */
export function computeChannelPermissions(base: bigint, channel: Channel, guildId: Snowflake, member: MyMember, userId: Snowflake): bigint {
  if ((base & ADMINISTRATOR) === ADMINISTRATOR) return ALL_PERMISSIONS;

  const overwrites = channel.permission_overwrites ?? [];
  let permissions = base;

  permissions = applyOverwrite(permissions, overwrites.find((o) => o.type === 0 && o.id === guildId));

  const memberRoles = new Set(member.roles);
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (o.type !== 0 || o.id === guildId || !memberRoles.has(o.id)) continue;
    allow |= parseBits(o.allow);
    deny |= parseBits(o.deny);
  }
  permissions = (permissions & ~deny) | allow;

  return applyOverwrite(permissions, overwrites.find((o) => o.type === 1 && o.id === userId));
}

export interface ResolveChannelAccessArgs {
  guildId: Snowflake;
  userId: Snowflake;
  guild: GuildPermissionInfo;
  roles: Role[];
  member: MyMember;
  channels: Channel[];
  threads?: Channel[];
}

/**
 * Permission bits needed to read a channel's messages. Categories only need VIEW_CHANNEL (they hold no messages).
 * Voice channels also need CONNECT: Discord's "Get Channel Messages" documents that for the text chat of a voice channel.
 * Stage channels are deliberately not held to it: the docs name voice channels only, and wrongly locking a readable
 * channel (it could not be selected for export) costs more than a channel that is shown open and then answers 403.
 */
function readBitsFor(type: number): bigint {
  if (type === ChannelType.GuildCategory) return VIEW_CHANNEL;
  if (type === ChannelType.GuildVoice) return VIEW_CHANNEL | READ_MESSAGE_HISTORY | CONNECT;
  return VIEW_CHANNEL | READ_MESSAGE_HISTORY;
}

/**
 * Best-effort "can the user read this?" for every channel and thread (see `readBitsFor` for what each kind needs).
 * Threads inherit the verdict of their parent channel; a thread whose parent is unknown is left out (=> unknown).
 */
export function resolveChannelAccess(args: ResolveChannelAccessArgs): Record<Snowflake, boolean> {
  const { guildId, userId, guild, roles, member, channels, threads = [] } = args;
  const base = computeBasePermissions(guildId, guild, roles, member);
  const access: Record<Snowflake, boolean> = {};

  for (const channel of channels) {
    if (THREAD_TYPES.has(channel.type)) continue;
    const permissions = computeChannelPermissions(base, channel, guildId, member, userId);
    const needed = readBitsFor(channel.type);
    access[channel.id] = (permissions & needed) === needed;
  }

  for (const thread of [...channels.filter((c) => THREAD_TYPES.has(c.type)), ...threads]) {
    const parentAccess = thread.parent_id ? access[thread.parent_id] : undefined;
    if (parentAccess !== undefined) access[thread.id] = parentAccess;
  }
  return access;
}
