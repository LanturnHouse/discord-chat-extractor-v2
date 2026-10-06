import type { ChatKind } from '@/shared/types';
import type { ExportTarget } from '../export/types';
import { avatarUrl, channelIconUrl, defaultAvatarUrl, guildIconUrl } from './cdn';
import { READABLE_KINDS } from './model';
import type { CategoryNode, ChannelKind, ChannelNode, DmNode, DmRecipient, GuildNode, GuildTree } from './model';
import { compareSnowflakes } from './snowflake';
import { ChannelType } from './types';
import type { Channel, GuildSummary, Snowflake, User } from './types';

const GUILD_ICON_SIZE = 96;

export function channelKindOf(type: number): ChannelKind {
  switch (type) {
    case ChannelType.GuildText:
      return 'text';
    case ChannelType.DM:
      return 'dm';
    case ChannelType.GuildVoice:
      return 'voice';
    case ChannelType.GroupDM:
      return 'group-dm';
    case ChannelType.GuildCategory:
      return 'category';
    case ChannelType.GuildAnnouncement:
      return 'announcement';
    case ChannelType.AnnouncementThread:
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
      return 'thread';
    case ChannelType.GuildStageVoice:
      return 'stage';
    case ChannelType.GuildForum:
      return 'forum';
    case ChannelType.GuildMedia:
      return 'media';
    default:
      return 'other';
  }
}

/**
 * The extension's kind of chat for a Discord channel type: 1 dm, 3 group-dm, 10 / 11 / 12 thread, 15 / 16 forum (posts are the
 * content), 0 / 2 / 5 / 13 guild-channel. Null for types that hold no messages (categories, directories) or are unknown.
 */
export function chatKindOf(type: number): ChatKind | null {
  switch (type) {
    case ChannelType.DM:
      return 'dm';
    case ChannelType.GroupDM:
      return 'group-dm';
    case ChannelType.AnnouncementThread:
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
      return 'thread';
    case ChannelType.GuildForum:
    case ChannelType.GuildMedia:
      return 'forum';
    case ChannelType.GuildText:
    case ChannelType.GuildVoice:
    case ChannelType.GuildAnnouncement:
    case ChannelType.GuildStageVoice:
      return 'guild-channel';
    default:
      return null;
  }
}

export function toGuildNode(g: GuildSummary): GuildNode {
  return { id: g.id, name: g.name, iconUrl: guildIconUrl(g.id, g.icon, GUILD_ICON_SIZE), owner: g.owner === true };
}

function uniqueById<T extends { id: Snowflake }>(items: readonly T[]): T[] {
  const seen = new Set<Snowflake>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function toNode(channel: Channel, kind: ChannelKind, guildId: Snowflake, access: Record<string, boolean> | undefined): ChannelNode {
  const node: ChannelNode = {
    id: channel.id,
    guildId: channel.guild_id ?? guildId,
    kind,
    name: channel.name ?? '',
    parentId: channel.parent_id ?? null,
    position: channel.position ?? 0,
    topic: channel.topic ?? null,
    nsfw: channel.nsfw === true,
    canView: access?.[channel.id] ?? null,
  };
  if (kind === 'thread') node.archived = channel.thread_metadata?.archived === true;
  return node;
}

/** Discord's sidebar puts voice-like channels (voice, stage) below every other channel of the same group. */
function groupRank(kind: ChannelKind): number {
  return kind === 'voice' || kind === 'stage' ? 1 : 0;
}

function compareChannelNodes(a: ChannelNode, b: ChannelNode): number {
  return groupRank(a.kind) - groupRank(b.kind) || a.position - b.position || compareSnowflakes(a.id, b.id);
}

/**
 * Raw channels (+ optional active threads and permission verdicts) -> sidebar tree, ordered like Discord's sidebar:
 * uncategorized channels first, then categories (position, id); within a group text-like channels before voice/stage.
 * Channels the user cannot see keep their node with `canView: false` (the UI shows them locked).
 */
export function buildGuildTree(guildId: Snowflake, channels: Channel[], threads: Channel[] = [], access?: Record<string, boolean>): GuildTree {
  const byId: Record<Snowflake, ChannelNode> = {};
  const categoryChannels: Channel[] = [];
  const childrenOf = new Map<Snowflake, ChannelNode[]>();
  const loose: ChannelNode[] = [];

  const uniqueChannels = uniqueById(channels);
  for (const channel of uniqueChannels) if (channelKindOf(channel.type) === 'category') categoryChannels.push(channel);
  const categoryIds = new Set(categoryChannels.map((c) => c.id));

  for (const channel of uniqueChannels) {
    const kind = channelKindOf(channel.type);
    if (kind === 'category' || kind === 'thread' || kind === 'dm' || kind === 'group-dm') continue;
    const node = toNode(channel, kind, guildId, access);
    byId[node.id] = node;
    // A channel whose category is missing from the list would otherwise vanish, so it is shown as uncategorized.
    if (node.parentId !== null && categoryIds.has(node.parentId)) {
      const siblings = childrenOf.get(node.parentId);
      if (siblings) siblings.push(node);
      else childrenOf.set(node.parentId, [node]);
    } else {
      loose.push(node);
    }
  }

  const categories: CategoryNode[] = [];
  for (const category of categoryChannels) {
    const children = (childrenOf.get(category.id) ?? []).sort(compareChannelNodes);
    if (children.length === 0 && access?.[category.id] === false) continue;
    categories.push({ id: category.id, name: category.name ?? '', position: category.position ?? 0, channels: children });
  }
  categories.sort((a, b) => a.position - b.position || compareSnowflakes(a.id, b.id));

  const threadsByParent: Record<Snowflake, ChannelNode[]> = {};
  const threadNodes = uniqueById(threads)
    .map((thread) => toNode(thread, 'thread', guildId, access))
    .sort((a, b) => compareSnowflakes(b.id, a.id));
  for (const node of threadNodes) {
    byId[node.id] = node;
    if (node.parentId === null) continue;
    (threadsByParent[node.parentId] ??= []).push(node);
  }

  return { guildId, uncategorized: loose.sort(compareChannelNodes), categories, threadsByParent, byId };
}

function displayName(user: Pick<User, 'global_name' | 'username'>): string {
  return user.global_name?.trim() ? user.global_name : user.username;
}

function toRecipient(user: User): DmRecipient {
  return { id: user.id, name: displayName(user), username: user.username, avatarUrl: avatarUrl(user) };
}

function compareDms(a: DmNode, b: DmNode): number {
  if (a.lastMessageId !== b.lastMessageId) {
    if (a.lastMessageId === null) return 1;
    if (b.lastMessageId === null) return -1;
    return compareSnowflakes(b.lastMessageId, a.lastMessageId);
  }
  return compareSnowflakes(b.id, a.id);
}

/** DM + group DM channels -> list nodes, most recent conversation first (channels without messages last). */
export function buildDmNodes(channels: Channel[]): DmNode[] {
  const nodes: DmNode[] = [];
  for (const channel of uniqueById(channels)) {
    if (channel.type !== ChannelType.DM && channel.type !== ChannelType.GroupDM) continue;
    const recipients = (channel.recipients ?? []).map(toRecipient);
    const first = recipients[0];
    const lastMessageId = channel.last_message_id ?? null;

    if (channel.type === ChannelType.DM) {
      nodes.push({
        id: channel.id,
        kind: 'dm',
        name: first?.name ?? (channel.name?.trim() || 'Unknown user'),
        iconUrl: first?.avatarUrl ?? defaultAvatarUrl(channel.id),
        recipients,
        lastMessageId,
      });
    } else {
      nodes.push({
        id: channel.id,
        kind: 'group-dm',
        name: channel.name?.trim() || recipients.map((r) => r.name).join(', ') || 'Group DM',
        iconUrl: channelIconUrl(channel.id, channel.icon) ?? first?.avatarUrl ?? defaultAvatarUrl(channel.id),
        recipients,
        lastMessageId,
      });
    }
  }
  return nodes.sort(compareDms);
}

function categoryNameOf(tree: GuildTree, categoryId: Snowflake | null): string | null {
  if (categoryId === null) return null;
  return tree.categories.find((c) => c.id === categoryId)?.name ?? null;
}

export function makeGuildExportTarget(node: ChannelNode, guild: GuildNode, tree: GuildTree): ExportTarget {
  const parent = node.kind === 'thread' && node.parentId !== null ? tree.byId[node.parentId] : undefined;
  // Threads live in their parent's category.
  const categoryId = node.kind === 'thread' ? (parent?.parentId ?? null) : node.parentId;
  return {
    channelId: node.id,
    kind: node.kind,
    channelName: node.name,
    guildId: guild.id,
    guildName: guild.name,
    categoryName: categoryNameOf(tree, categoryId),
    parentChannelName: parent?.name ?? null,
    topic: node.topic,
    iconUrl: guild.iconUrl,
  };
}

export function makeDmExportTarget(dm: DmNode): ExportTarget {
  return {
    channelId: dm.id,
    kind: dm.kind,
    channelName: dm.name,
    guildId: null,
    guildName: null,
    categoryName: null,
    parentChannelName: null,
    topic: null,
    iconUrl: dm.iconUrl,
  };
}

export function isExportable(node: ChannelNode): boolean {
  return READABLE_KINDS.has(node.kind) && node.canView !== false;
}
