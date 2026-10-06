import { belongsToGroup, categoryIdOf, type GroupMap, type GroupSettingsMap, type QueueItem } from '@/shared';

/** What saving settings on a server or category replaces: the own settings of the channels below it, and (server only) the settings of its categories. */
export interface GroupOverrides {
  /** Keys of the queued channels below the group that have settings of their own. */
  itemKeys: string[];
  /** Ids of the category groups below a server that have settings of their own (always empty for a category). */
  categoryIds: string[];
}

type ItemRef = Pick<QueueItem, 'key' | 'target' | 'settings'>;

/**
 * The overrides a save on `kind` / `groupId` clears (docs/PLAN.md §7.2a): "아래 개별 설정 M개가 이 설정으로 바뀌어요" shows
 * `itemKeys.length + categoryIds.length`, and the background reports the same number as `cleared`. One function for the popup's
 * notice and for the mock background, so the two can never disagree.
 */
export function groupOverrides(
  kind: 'guild' | 'category',
  groupId: string,
  items: readonly ItemRef[],
  groups: GroupMap,
  groupSettings: GroupSettingsMap,
): GroupOverrides {
  const below = items.filter((item) => belongsToGroup(item, kind, groupId, groups));
  const itemKeys = below.filter((item) => item.settings !== null).map((item) => item.key);
  if (kind === 'category') return { itemKeys, categoryIds: [] };

  const categories = new Set<string>();
  for (const item of below) {
    const category = categoryIdOf(item, groups);
    if (category !== null) categories.add(category);
  }
  for (const [id, group] of Object.entries(groups)) {
    if (group.kind === 'category' && group.guildId === groupId) categories.add(id);
  }
  const categoryIds = [...categories].filter((id) => id !== groupId && groupSettings[id] !== undefined);
  return { itemKeys, categoryIds };
}
