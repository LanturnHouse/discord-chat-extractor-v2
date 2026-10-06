/**
 * `LOCAL.groups(accountId)`: for every guild the account looked at through the content script's buttons, which channels it may
 * read in the guild as a whole and in each of its categories (docs/PLAN.md §2, §5.1 `GroupInfo`, §5.2). The content script
 * compares these lists with the download list to decide whether the category or server button shows the check mark; it cannot
 * compute them itself (no permission data, no API calls there). The popup's queue tree reads the same record for the names and
 * the server icon of its group rows (5th change: `GroupInfo.name`, `GroupInfo.iconUrl`).
 *
 * The lists are by-products of loading the guild (guild.ts, the 60 s cache): every operation that loads it records them
 * (`queue/groupInfo`, `queue/addCategory`, `queue/addGuild`), so the check state and the click that follows are computed from the
 * same data. The record is replaced guild by guild: everything stored for the guild goes (a category that was deleted must not
 * linger), every other guild's entries stay. The one thing that does carry over from the replaced entries is what a load did
 * not say: a name or icon that this load could not find out (the guild object failed to load, a category without a usable
 * name) is kept from the previous record, so a partial or fallback load never erases what an earlier complete one recorded.
 */
import type { AccountInfo, GroupInfo } from '@/shared';
import { loadGuildChannels } from './guild';
import type { GuildChannels, LoadedGuild } from './guild';
import { mutateQueueState } from './store';
import { describeError } from './util';

/**
 * The entries of one guild: the guild itself (keyed by the guild id; every readable channel, in the order of Discord's sidebar)
 * and every category of the guild (keyed by the category id; its readable channels in that order), also a category without any
 * readable channel (an empty list: the button then has nothing to check). Pure.
 *
 * Names and icon: the guild entry carries `guild.guildName` and `guild.iconUrl` (a server without an icon: null), every category
 * entry its name from `guild.categoryNames`; `previous` (the stored entries, any guild) fills in what `guild` does not know: a
 * name that is unknown now is taken from the previous entry with the same id and kind, an unknown icon too. What is unknown
 * everywhere is null (the category entries never carry an `iconUrl`).
 */
export function buildGuildGroups(
  guildId: string,
  guild: GuildChannels,
  updatedAt: number,
  previous: Readonly<Record<string, GroupInfo>> = {},
): Record<string, GroupInfo> {
  const earlier = (groupId: string, kind: GroupInfo['kind']): GroupInfo | undefined => {
    const group = previous[groupId];
    return group !== undefined && group.kind === kind && group.guildId === guildId ? group : undefined;
  };

  const groups: Record<string, GroupInfo> = {};
  for (const categoryId of guild.categoryIds) {
    const channelIds = guild.channels.filter((channel) => channel.parentId === categoryId).map((channel) => channel.id);
    groups[categoryId] = {
      kind: 'category',
      guildId,
      channelIds,
      updatedAt,
      name: guild.categoryNames?.[categoryId] ?? earlier(categoryId, 'category')?.name ?? null,
    };
  }
  const before = earlier(guildId, 'guild');
  groups[guildId] = {
    kind: 'guild',
    guildId,
    channelIds: guild.channels.map((channel) => channel.id),
    updatedAt,
    name: guild.guildName ?? before?.name ?? null,
    iconUrl: guild.iconUrl !== undefined ? guild.iconUrl : (before?.iconUrl ?? null),
  };
  return groups;
}

/**
 * Writes the groups of `guildId` for `accountId`, replacing every entry stored for that guild and leaving the others alone. One
 * read-modify-write under the storage lock, so concurrent calls (other guilds, the same guild) cannot lose each other's entries.
 * `guildNameHint` is the server name the page showed: it names the guild entry when the guild object did not.
 *
 * The write goes through `mutateQueueState` (store.ts), which prunes the group settings against the fresh record in the same
 * storage write: a category whose last queued channel moved to another category, or that was deleted, loses its settings now, so
 * they cannot come back when a channel is added to that category later (docs/PLAN.md §7.2a). A load always lists every category
 * of the guild (`categoryIds` come from the required channel list), so a partial or fallback load does not drop a category that exists.
 */
export function recordGuildGroups(accountId: string, guildId: string, guild: GuildChannels, guildNameHint: string | null = null): Promise<void> {
  const named: GuildChannels = guild.guildName === null && guildNameHint !== null ? { ...guild, guildName: guildNameHint } : guild;
  return mutateQueueState(accountId, (state) => {
    const { groups } = state;
    const fresh = buildGuildGroups(guildId, named, Date.now(), groups);
    for (const [groupId, group] of Object.entries(groups)) if (group.guildId === guildId) delete groups[groupId];
    Object.assign(groups, fresh);
  });
}

/**
 * Loads the guild's readable channels (cached, shared while loading) and records their groups. `strict`: a failing write fails
 * the call (`queue/groupInfo`, whose only job it is). Otherwise the write is best-effort: the queue operation that asked for the
 * channels matters more than the check state, so a failure is logged (no authorization in it) and the channels are returned.
 * `guildName` is the name the page knows (null when it does not): the group's name when the guild object has none.
 */
export async function loadGuildWithGroups(
  account: AccountInfo,
  token: string,
  guildId: string,
  strict: boolean,
  guildName: string | null = null,
): Promise<LoadedGuild> {
  const loaded = await loadGuildChannels(account, token, guildId);
  if (!loaded.ok) return loaded;
  try {
    await recordGuildGroups(account.id, guildId, loaded.value, guildName);
  } catch (error) {
    if (strict) throw error;
    console.warn(describeError(`[dce] guild ${guildId}: the groups could not be stored (${describeError(error, 120)})`, 300));
  }
  return loaded;
}
