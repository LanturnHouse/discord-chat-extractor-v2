/**
 * Group helpers (docs/PLAN.md §5.5, 5th change): which server / category a queue item belongs to and which settings it runs
 * with (item > category > server > common). Pure functions shared by the background worker (job start, group settings,
 * pruning) and the popup (queue tree), so both sides apply exactly the same rules. CONTRACT: owned by the main agent.
 */
import type { ExportSettings, GroupInfo, QueueItem, SettingsSource } from './types.ts';

/** `LOCAL.groups(account)`: group id (server id or category id) → what the background recorded about it. */
export type GroupMap = Readonly<Record<string, GroupInfo>>;
/** `LOCAL.groupSettings(account)`: group id (server id or category id) → the settings its channels follow. */
export type GroupSettingsMap = Readonly<Record<string, ExportSettings>>;

type ItemRef = Pick<QueueItem, 'key' | 'target'>;

/**
 * The category a queued channel sits in, or null (DM, no category, unknown). The recorded groups win (they are refreshed
 * whenever the server is seen); the target's own `parentId` is trusted only for plain channels and forums, because a thread's
 * `parentId` is its parent channel, not a category.
 */
export function categoryIdOf(item: ItemRef, groups: GroupMap): string | null {
  const { guildId, kind, parentId } = item.target;
  if (guildId === null || guildId === undefined) return null;
  for (const [id, group] of Object.entries(groups)) {
    if (group.kind === 'category' && group.guildId === guildId && group.channelIds.includes(item.key)) return id;
  }
  if ((kind === 'guild-channel' || kind === 'forum') && typeof parentId === 'string' && parentId !== '') return parentId;
  return null;
}

/** Whether `item` belongs to the server (`kind` "guild", `groupId` = server id) or category (`kind` "category") group. */
export function belongsToGroup(item: ItemRef, kind: 'guild' | 'category', groupId: string, groups: GroupMap): boolean {
  if (kind === 'guild') return item.target.guildId === groupId;
  return categoryIdOf(item, groups) === groupId;
}

/** The settings an export of `item` runs with and where they come from. Always a fresh deep copy. */
export function resolveEffectiveSettings(
  item: Pick<QueueItem, 'key' | 'target' | 'settings'>,
  common: ExportSettings,
  groupSettings: GroupSettingsMap,
  groups: GroupMap,
): { settings: ExportSettings; source: SettingsSource } {
  if (item.settings) return { settings: structuredClone(item.settings), source: 'item' };
  const categoryId = categoryIdOf(item, groups);
  const category = categoryId === null ? undefined : groupSettings[categoryId];
  if (category) return { settings: structuredClone(category), source: 'category' };
  const guildId = item.target.guildId;
  const guild = guildId === null || guildId === undefined ? undefined : groupSettings[guildId];
  if (guild) return { settings: structuredClone(guild), source: 'guild' };
  return { settings: structuredClone(common), source: 'common' };
}

/**
 * `groupSettings` without the entries of groups that have no queued channel left (a group that was emptied must not bring its
 * old settings back when someone adds a channel to it later). Returns the same object when nothing changed.
 */
export function pruneGroupSettings(
  groupSettings: GroupSettingsMap,
  items: readonly ItemRef[],
  groups: GroupMap,
): GroupSettingsMap {
  const used = new Set<string>();
  for (const item of items) {
    if (item.target.guildId) used.add(item.target.guildId);
    const category = categoryIdOf(item, groups);
    if (category !== null) used.add(category);
  }
  const ids = Object.keys(groupSettings);
  if (ids.every((id) => used.has(id))) return groupSettings;
  return Object.fromEntries(Object.entries(groupSettings).filter(([id]) => used.has(id)));
}

/** True when the group lists at least one viewable channel and every one of them is queued ("the whole server / category"). */
export function isGroupComplete(group: Pick<GroupInfo, 'channelIds'> | null | undefined, queuedKeys: ReadonlySet<string>): boolean {
  return !!group && group.channelIds.length > 0 && group.channelIds.every((id) => queuedKeys.has(id));
}
