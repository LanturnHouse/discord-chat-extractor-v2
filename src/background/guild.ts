/**
 * The channels of one guild that the CURRENT account may read: the data behind the category button (`queue/addCategory`), the
 * server button (`queue/addGuild`) and the group information the content script asks for (`queue/groupInfo`, written to
 * `LOCAL.groups` by groups.ts) (docs/PLAN.md §2, §3, §5.3).
 *
 * Loading, all direct GETs on the background allow-list (docs/PLAN.md §8), made through `apiGet`:
 *  1. `guilds/{id}/channels`: required. A failure ends the operation, and a 401 removes the dead authorization, as everywhere.
 *  2. then together: `guilds/{id}/roles`; `guilds/{id}` (the owner id and the name; its `roles` stand in for a failed roles
 *     request); the account's own member, `users/@me/guilds/{id}/member` and, when that fails, `guilds/{id}/members/@me`.
 *     Only request 1 can say the authorization is dead (the member endpoint is meant for OAuth tokens and may answer 401 for
 *     a perfectly good one): these four just answer "unavailable", whatever the status.
 * The same load also yields what names the groups in the popup's queue tree (5th change): the guild's name and icon (the 64 px png
 * URL, `guildIconUrl`) from request 2, and the name of every category from request 1. A guild object that could not be loaded
 * leaves name and icon unknown (not "none"), so groups.ts keeps what an earlier load recorded.
 * Every endpoint is requested at most once per operation. A complete result is kept for 60 s per account and guild, so a
 * category click right after a server click (or the other way round) costs no request; a load that is already running is shared.
 *
 * The permission math is the v1 library's, nothing is re-implemented here: `resolveChannelAccess` (src/lib/discord/permissions.ts)
 * gives owner / ADMINISTRATOR bypass, @everyone, role overwrites and the member's own overwrite, and a channel is kept when it has
 * VIEW_CHANNEL and READ_MESSAGE_HISTORY. "Category sync" needs no code either: Discord copies a category's overwrites into the
 * channels that follow it, so every channel's own `permission_overwrites` already are its effective ones (v1 reads only those).
 * `buildGuildTree` (src/lib/discord/tree.ts) gives the order of Discord's sidebar: channels without a category first, then the
 * categories by position, and inside each group by position and id.
 *
 * Without usable roles or member data nothing can be said about permissions: every channel of the right type is kept (the
 * behaviour before this filter existed) and a warning is logged. The warning never contains the authorization.
 */
import type { AccountInfo, BgResponse, ChatKind } from '@/shared';
import type { MyMember } from '@/lib/discord/client';
import type { ChannelNode } from '@/lib/discord/model';
import { resolveChannelAccess } from '@/lib/discord/permissions';
import { buildGuildTree, chatKindOf } from '@/lib/discord/tree';
import { ChannelType } from '@/lib/discord/types';
import type { Channel, PermissionOverwrite, Role } from '@/lib/discord/types';
import { revokeToken } from './account';
import { apiGet } from './discordApi';
import type { ApiResult } from './discordApi';
import { fail } from './response';
import { describeError, isNumericId, isRecord } from './util';
import { MAX_NAME_LENGTH, cleanText } from './validate';

/** How long a complete load is reused. */
export const GUILD_CACHE_TTL_MS = 60_000;
const MAX_CACHED_GUILDS = 6;

/** Channel types that can be exported and are listed by the category and server buttons: text, announcement, forum, media. */
const EXPORTABLE_TYPES: ReadonlySet<number> = new Set<number>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

/** One channel the account may read, ready to become a queue target. */
export interface GuildChannel {
  id: string;
  /** Discord's channel type: 0 text, 5 announcement, 15 forum, 16 media. */
  type: number;
  /** 'forum' for 15 and 16, else 'guild-channel'. */
  kind: ChatKind;
  /** As Discord sent it: `validateTarget` cleans it when the channel is queued. */
  name: string;
  /** The channel's category id (`parent_id`), or null. */
  parentId: string | null;
  /** The category's name when the category is in the channel list. */
  parentName: string | null;
}

export interface GuildChannels {
  /** The guild's own name (`guilds/{id}`), when that could be loaded. */
  guildName: string | null;
  /**
   * The guild's icon as the 64 px png CDN URL the popup shows (`guildIconUrl`); null = the guild has no icon. Absent = unknown
   * (the guild object could not be loaded): a recorded icon must then be kept, not erased.
   */
  iconUrl?: string | null;
  /** The readable, exportable channels in the order of Discord's sidebar. */
  channels: GuildChannel[];
  /** The id of every category of the guild (type 4), also one without a readable channel, each once. */
  categoryIds: string[];
  /** The cleaned name of every category in `categoryIds` that has a usable one. Absent = no names known. */
  categoryNames?: Readonly<Record<string, string>>;
}

/** A Discord image hash (32 hex characters, `a_` in front of an animated one): letters, digits and underscores only. */
const ICON_HASH = /^[A-Za-z0-9_]{1,64}$/;

/**
 * The CDN URL of a guild icon for the popup: always a 64 px png, also for an animated (`a_...`) hash, which Discord serves as a
 * still png on request. null when `hash` is not a usable hash (null, not a string, or characters that could change the URL).
 */
export function guildIconUrl(guildId: string, hash: unknown): string | null {
  if (typeof hash !== 'string' || !ICON_HASH.test(hash)) return null;
  return `https://cdn.discordapp.com/icons/${guildId}/${hash}.png?size=64`;
}

export type LoadedGuild = { ok: true; value: GuildChannels } | { ok: false; response: BgResponse<never> };

type Loaded = LoadedGuild & { cacheable?: boolean };
type ApiFailure = Exclude<ApiResult, { ok: true }>;

function describeFailure(result: ApiFailure): string {
  switch (result.kind) {
    case 'forbidden-path':
      return 'path not allowed';
    case 'unauthorized':
      return 'HTTP 401';
    case 'http':
      return `HTTP ${result.status}`;
    case 'network':
      return 'network error';
  }
}

function apiFailure(result: ApiFailure): BgResponse<never> {
  switch (result.kind) {
    case 'forbidden-path':
      return fail('forbidden-path');
    case 'unauthorized':
      return fail('no-account');
    case 'http':
      return fail('http', `HTTP ${result.status}`);
    case 'network':
      return fail('http', 'network error');
  }
}

/** Always a warning without the authorization: the text is built from ids and statuses only, and run through the redaction anyway. */
function warn(message: string): void {
  console.warn(describeError(`[dce] ${message}`, 500));
}

// ---- reading Discord's answers (untrusted shapes: keep only what the permission code needs) -------------------------------------

const bitString = (value: unknown): string => {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : '0';
};

function parseOverwrites(raw: unknown): PermissionOverwrite[] {
  if (!Array.isArray(raw)) return [];
  const overwrites: PermissionOverwrite[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || !isNumericId(entry.id) || (entry.type !== 0 && entry.type !== 1)) continue;
    overwrites.push({ id: entry.id, type: entry.type, allow: bitString(entry.allow), deny: bitString(entry.deny) });
  }
  return overwrites;
}

function parseChannels(data: unknown): Channel[] {
  if (!Array.isArray(data)) return [];
  const channels: Channel[] = [];
  for (const raw of data) {
    if (!isRecord(raw) || !isNumericId(raw.id) || typeof raw.type !== 'number') continue;
    const channel: Channel = { id: raw.id, type: raw.type, permission_overwrites: parseOverwrites(raw.permission_overwrites) };
    if (typeof raw.name === 'string') channel.name = raw.name;
    if (isNumericId(raw.parent_id)) channel.parent_id = raw.parent_id;
    if (typeof raw.position === 'number' && Number.isFinite(raw.position)) channel.position = raw.position;
    channels.push(channel);
  }
  return channels;
}

/** The role list, or null when the answer is not one. */
function parseRoles(data: unknown): Role[] | null {
  if (!Array.isArray(data)) return null;
  const roles: Role[] = [];
  for (const raw of data) {
    if (!isRecord(raw) || !isNumericId(raw.id)) continue;
    roles.push({
      id: raw.id,
      name: typeof raw.name === 'string' ? raw.name : '',
      permissions: bitString(raw.permissions),
      position: typeof raw.position === 'number' ? raw.position : 0,
    });
  }
  return roles;
}

function parseMember(data: unknown): MyMember | null {
  if (!isRecord(data)) return null;
  return { roles: Array.isArray(data.roles) ? data.roles.filter(isNumericId) : [] };
}

interface GuildInfo {
  name: string | null;
  /** The raw `icon` hash (not yet checked), or null. */
  icon: unknown;
  ownerId: string | null;
  roles: Role[] | null;
}

function parseGuild(data: unknown): GuildInfo | null {
  if (!isRecord(data)) return null;
  const name = typeof data.name === 'string' ? cleanText(data.name, MAX_NAME_LENGTH) : null;
  return {
    name: name === null || name === '' ? null : name,
    icon: data.icon,
    ownerId: isNumericId(data.owner_id) ? data.owner_id : null,
    roles: parseRoles(data.roles),
  };
}

// ---- loading -------------------------------------------------------------------------------------------------------------------

interface MemberAnswer {
  member: MyMember | null;
  /** Why each endpoint did not deliver (statuses only), when none did. */
  failures: string[];
}

/** The account's own member record: `users/@me/guilds/{id}/member`, and only when that does not deliver, `guilds/{id}/members/@me`. */
async function fetchMember(guildId: string, token: string): Promise<MemberAnswer> {
  const failures: string[] = [];
  for (const path of [`/api/v9/users/@me/guilds/${guildId}/member`, `/api/v9/guilds/${guildId}/members/@me`]) {
    const answer = await apiGet(path, token);
    const member = answer.ok ? parseMember(answer.data) : null;
    if (member !== null) return { member, failures: [] };
    failures.push(answer.ok ? 'unexpected answer' : describeFailure(answer));
  }
  return { member: null, failures };
}

/** The readable exportable channels of `channels`, in sidebar order. `access` = undefined: no verdicts, every channel stays. */
function listChannels(guildId: string, channels: Channel[], access: Record<string, boolean> | undefined): GuildChannel[] {
  const tree = buildGuildTree(guildId, channels, [], access);
  const types = new Map(channels.map((channel) => [channel.id, channel.type]));
  const listed: GuildChannel[] = [];
  const add = (node: ChannelNode, parentName: string | null): void => {
    const type = types.get(node.id);
    if (type === undefined || !EXPORTABLE_TYPES.has(type) || node.canView === false) return;
    listed.push({ id: node.id, type, kind: chatKindOf(type) ?? 'guild-channel', name: node.name, parentId: node.parentId, parentName });
  };
  for (const node of tree.uncategorized) add(node, null);
  for (const category of tree.categories) {
    const name = cleanText(category.name, MAX_NAME_LENGTH);
    for (const node of category.channels) add(node, name === null || name === '' ? null : name);
  }
  return listed;
}

/** The ids of the guild's categories, each once, in the order Discord sent them (the order carries no meaning). */
function listCategoryIds(channels: Channel[]): string[] {
  return [...new Set(channels.filter((channel) => channel.type === ChannelType.GuildCategory).map((channel) => channel.id))];
}

/** The cleaned name of every category that has one (a category without a usable name is simply not in the answer). */
function listCategoryNames(channels: Channel[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const channel of channels) {
    if (channel.type !== ChannelType.GuildCategory || channel.name === undefined) continue;
    const name = cleanText(channel.name, MAX_NAME_LENGTH);
    if (name !== null && name !== '') names[channel.id] = name;
  }
  return names;
}

async function fetchGuildChannels(account: AccountInfo, token: string, guildId: string): Promise<Loaded> {
  const base = `/api/v9/guilds/${guildId}`;
  const channelList = await apiGet(`${base}/channels`, token);
  if (!channelList.ok) {
    if (channelList.kind === 'unauthorized') await revokeToken(token);
    return { ok: false, response: apiFailure(channelList) };
  }
  const channels = parseChannels(channelList.data);

  const [rolesAnswer, guildAnswer, memberAnswer] = await Promise.all([apiGet(`${base}/roles`, token), apiGet(base, token), fetchMember(guildId, token)]);
  const guild = guildAnswer.ok ? parseGuild(guildAnswer.data) : null;
  const roles = (rolesAnswer.ok ? parseRoles(rolesAnswer.data) : null) ?? guild?.roles ?? null;
  const { member } = memberAnswer;

  let access: Record<string, boolean> | undefined;
  if (roles !== null && member !== null) {
    access = resolveChannelAccess({ guildId, userId: account.id, guild: { owner: guild?.ownerId === account.id }, roles, member, channels });
    if (guild === null) {
      warn(`guild ${guildId}: the guild itself could not be loaded (${guildAnswer.ok ? 'unexpected answer' : describeFailure(guildAnswer)}); the owner check is skipped`);
    }
  } else {
    const problems: string[] = [];
    if (roles === null) problems.push(`roles: ${rolesAnswer.ok ? 'unexpected answer' : describeFailure(rolesAnswer)}`);
    if (member === null) problems.push(`member: ${memberAnswer.failures.join(', ')}`);
    warn(`guild ${guildId}: ${problems.join('; ')}; the channels are added without the permission filter`);
  }

  return {
    ok: true,
    value: {
      guildName: guild?.name ?? null,
      ...(guild === null ? {} : { iconUrl: guildIconUrl(guildId, guild.icon) }),
      channels: listChannels(guildId, channels, access),
      categoryIds: listCategoryIds(channels),
      categoryNames: listCategoryNames(channels),
    },
    cacheable: guild !== null && roles !== null && member !== null,
  };
}

interface CacheEntry {
  promise: Promise<Loaded>;
  /** Infinity while the load runs. */
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * The channels of `guildId` that `account` may read (see the top of this file). Requests nothing when a complete result is less
 * than 60 s old, and shares a load that is still running. A failed or incomplete load is not kept, so the next click asks again.
 * `token` is the account's authorization; it is used for requests only.
 */
export function loadGuildChannels(account: AccountInfo, token: string, guildId: string): Promise<LoadedGuild> {
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);

  const key = `${account.id}/${guildId}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit.promise;

  const entry: CacheEntry = { promise: fetchGuildChannels(account, token, guildId), expiresAt: Number.POSITIVE_INFINITY };
  cache.set(key, entry);
  while (cache.size > MAX_CACHED_GUILDS) cache.delete(cache.keys().next().value as string);

  const settle = (result: Loaded | null): void => {
    if (result !== null && result.ok && result.cacheable === true) entry.expiresAt = Date.now() + GUILD_CACHE_TTL_MS;
    else if (cache.get(key) === entry) cache.delete(key);
  };
  entry.promise.then(settle, () => settle(null));
  return entry.promise;
}
