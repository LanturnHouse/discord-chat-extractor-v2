import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings, type GroupInfo, type QueueItem } from '@/shared';
import { groupOverrides } from '@/ui/groups/overrides';

const own: ExportSettings = { ...DEFAULT_EXPORT_SETTINGS, count: 5 };
const group = (kind: GroupInfo['kind'], guildId: string, channelIds: string[]): GroupInfo => ({ kind, guildId, channelIds, updatedAt: 1 });
const item = (key: string, guildId: string | null, settings: ExportSettings | null = null, parentId: string | null = null): QueueItem => ({
  key,
  target: { kind: guildId === null ? 'dm' : 'guild-channel', channelId: key, guildId, guildName: null, channelName: key, parentId },
  settings,
  addedAt: 1,
});

describe('groupOverrides: what a save on a server or category replaces', () => {
  const groups = { g1: group('guild', 'g1', ['1', '2', '3']), c1: group('category', 'g1', ['1', '2']), c2: group('category', 'g1', ['3']), c9: group('category', 'g2', ['9']) };
  const items = [item('1', 'g1', own), item('2', 'g1'), item('3', 'g1', own), item('9', 'g2', own), item('d', null, own)];

  it('a server: the own settings of its chats (other servers and DMs excluded) and the settings of its categories', () => {
    const result = groupOverrides('guild', 'g1', items, groups, { c1: own, c2: own, c9: own, g1: own });
    expect(result.itemKeys).toEqual(['1', '3']);
    expect(result.categoryIds.sort()).toEqual(['c1', 'c2']); // not c9 (another server), not the server itself
  });

  it("a server's category settings are found through its chats too, when the groups do not know the category", () => {
    const result = groupOverrides('guild', 'g1', [item('1', 'g1', null, 'cx')], {}, { cx: own });
    expect(result).toEqual({ itemKeys: [], categoryIds: ['cx'] });
  });

  it('categories without settings do not count', () => {
    expect(groupOverrides('guild', 'g1', items, groups, {}).categoryIds).toEqual([]);
  });

  it('a category: the own settings of the chats in it only; never category settings', () => {
    expect(groupOverrides('category', 'c1', items, groups, { c1: own, c2: own })).toEqual({ itemKeys: ['1'], categoryIds: [] });
    expect(groupOverrides('category', 'c2', items, groups, {})).toEqual({ itemKeys: ['3'], categoryIds: [] });
  });

  it('nothing below: nothing to replace', () => {
    expect(groupOverrides('guild', 'nope', items, groups, {})).toEqual({ itemKeys: [], categoryIds: [] });
    expect(groupOverrides('category', 'nope', items, groups, {})).toEqual({ itemKeys: [], categoryIds: [] });
    expect(groupOverrides('guild', 'g1', [], groups, { c1: own }).itemKeys).toEqual([]);
  });
});
