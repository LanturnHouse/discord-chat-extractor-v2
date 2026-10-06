import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_SETTINGS,
  belongsToGroup,
  categoryIdOf,
  isGroupComplete,
  pruneGroupSettings,
  resolveEffectiveSettings,
  type ChatTarget,
  type ExportSettings,
  type GroupInfo,
  type QueueItem,
} from '@/shared';

const GUILD = '100';
const CAT_A = '200';
const CAT_B = '201';

function item(key: string, over: Partial<ChatTarget> = {}, settings: ExportSettings | null = null): QueueItem {
  return {
    key,
    target: { kind: 'guild-channel', channelId: key, guildId: GUILD, guildName: 'Server', channelName: `c${key}`, ...over },
    settings,
    addedAt: 1,
  };
}
const group = (kind: GroupInfo['kind'], channelIds: string[], guildId = GUILD): GroupInfo => ({ kind, guildId, channelIds, updatedAt: 1 });
const groups = {
  [GUILD]: group('guild', ['1', '2', '3', '4']),
  [CAT_A]: group('category', ['1', '2']),
  [CAT_B]: group('category', ['3']),
};
const with5: ExportSettings = { ...DEFAULT_EXPORT_SETTINGS, count: 5 };
const with7: ExportSettings = { ...DEFAULT_EXPORT_SETTINGS, count: 7 };
const with9: ExportSettings = { ...DEFAULT_EXPORT_SETTINGS, count: 9 };
const common: ExportSettings = { ...DEFAULT_EXPORT_SETTINGS, count: 200 };

describe('categoryIdOf', () => {
  it('finds the category from the recorded groups', () => {
    expect(categoryIdOf(item('1'), groups)).toBe(CAT_A);
    expect(categoryIdOf(item('3'), groups)).toBe(CAT_B);
  });
  it('is null for a channel without a category, a DM and an unknown channel', () => {
    expect(categoryIdOf(item('4'), groups)).toBeNull();
    expect(categoryIdOf(item('9'), groups)).toBeNull();
    expect(categoryIdOf(item('5', { kind: 'dm', guildId: null }), groups)).toBeNull();
  });
  it('ignores a category recorded for another server', () => {
    const other = { [CAT_A]: group('category', ['1'], '999') };
    expect(categoryIdOf(item('1'), other)).toBeNull();
  });
  it('falls back to the target parentId only for plain channels and forums', () => {
    expect(categoryIdOf(item('9', { parentId: CAT_B }), {})).toBe(CAT_B);
    expect(categoryIdOf(item('9', { kind: 'forum', parentId: CAT_B }), {})).toBe(CAT_B);
    expect(categoryIdOf(item('9', { kind: 'thread', parentId: '77' }), {})).toBeNull();
    expect(categoryIdOf(item('9', { parentId: '' }), {})).toBeNull();
  });
  it('prefers the recorded groups over a stale parentId', () => {
    expect(categoryIdOf(item('1', { parentId: CAT_B }), groups)).toBe(CAT_A);
  });
});

describe('belongsToGroup', () => {
  it('matches the server by guild id and the category by recorded membership', () => {
    expect(belongsToGroup(item('1'), 'guild', GUILD, groups)).toBe(true);
    expect(belongsToGroup(item('1'), 'guild', '999', groups)).toBe(false);
    expect(belongsToGroup(item('1'), 'category', CAT_A, groups)).toBe(true);
    expect(belongsToGroup(item('1'), 'category', CAT_B, groups)).toBe(false);
    expect(belongsToGroup(item('5', { kind: 'dm', guildId: null }), 'guild', GUILD, groups)).toBe(false);
  });
});

describe('resolveEffectiveSettings', () => {
  it('prefers item > category > server > common and names the source', () => {
    const gs = { [GUILD]: with7, [CAT_A]: with9 };
    expect(resolveEffectiveSettings(item('1', {}, with5), common, gs, groups)).toMatchObject({ source: 'item', settings: { count: 5 } });
    expect(resolveEffectiveSettings(item('1'), common, gs, groups)).toMatchObject({ source: 'category', settings: { count: 9 } });
    expect(resolveEffectiveSettings(item('3'), common, gs, groups)).toMatchObject({ source: 'guild', settings: { count: 7 } });
    expect(resolveEffectiveSettings(item('4'), common, {}, groups)).toMatchObject({ source: 'common', settings: { count: 200 } });
  });
  it('DMs only follow item and common settings', () => {
    const dm = item('5', { kind: 'dm', guildId: null });
    expect(resolveEffectiveSettings(dm, common, { [GUILD]: with7 }, groups).source).toBe('common');
  });
  it('returns deep copies, never the stored objects', () => {
    const gs = { [GUILD]: with7 };
    const out = resolveEffectiveSettings(item('4'), common, gs, groups).settings;
    out.content.includeBots = false;
    out.count = 1;
    expect(gs[GUILD]!.count).toBe(7);
    expect(gs[GUILD]!.content.includeBots).toBe(true);
    const own = resolveEffectiveSettings(item('4', {}, with5), common, {}, groups).settings;
    own.count = 2;
    expect(with5.count).toBe(5);
    const fromCommon = resolveEffectiveSettings(item('4'), common, {}, groups).settings;
    fromCommon.count = 3;
    expect(common.count).toBe(200);
  });
});

describe('pruneGroupSettings', () => {
  it('drops settings of groups without any queued channel', () => {
    const gs = { [GUILD]: with7, [CAT_A]: with9, [CAT_B]: with5, '999': with5 };
    const out = pruneGroupSettings(gs, [item('1'), item('4')], groups);
    expect(Object.keys(out).sort()).toEqual([GUILD, CAT_A].sort());
  });
  it('returns the same object when nothing changes and an empty one for an empty queue', () => {
    const gs = { [GUILD]: with7, [CAT_A]: with9 };
    expect(pruneGroupSettings(gs, [item('1')], groups)).toBe(gs);
    expect(pruneGroupSettings(gs, [], groups)).toEqual({});
  });
});

describe('isGroupComplete', () => {
  it('needs at least one channel and every channel queued', () => {
    expect(isGroupComplete(groups[CAT_A], new Set(['1', '2']))).toBe(true);
    expect(isGroupComplete(groups[CAT_A], new Set(['1']))).toBe(false);
    expect(isGroupComplete(group('category', []), new Set(['1']))).toBe(false);
    expect(isGroupComplete(undefined, new Set(['1']))).toBe(false);
    expect(isGroupComplete(null, new Set())).toBe(false);
  });
});
