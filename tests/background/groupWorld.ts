/**
 * A small made-up world for the tests of group settings (5th change): two servers, three categories, a list with channels that
 * have settings of their own and channels that follow their group, the groups the worker would have recorded and group settings
 * for most of them. Neutral names, made-up ids. Used by groupSettings.test.ts and jobs.groupSettings.test.ts.
 */
import type { ChatTarget, ExportSettings, GroupInfo, QueueItem } from '@/shared';
import { GUILD_ID, dmTarget, exportSettings, guildTarget, queueItem } from './helpers';

export const OTHER_GUILD = '200000000000000002';
export const CAT_A = '300000000000000011';
export const CAT_B = '300000000000000012';
export const CAT_X = '300000000000000021'; // a category of the other server

export const CH = {
  loose: '430000000000000001', // in the server, in no category
  a1: '430000000000000002', // category A
  a2: '430000000000000003', // category A
  b1: '430000000000000004', // category B
  thread: '430000000000000005', // a thread of a1: sits directly under the server
  x1: '430000000000000006', // the other server, its category X
} as const;
export type Name = keyof typeof CH;

export const S = {
  guild: exportSettings({ count: 22, format: 'txt' }),
  catA: exportSettings({ count: 11, format: 'md' }),
  catB: exportSettings({ count: 12, format: 'xlsx' }),
  otherGuild: exportSettings({ count: 66, format: 'json' }),
  catX: exportSettings({ count: 77, format: 'csv' }),
  fresh: exportSettings({ count: 33, format: 'csv', htmlTheme: 'light', includeAttachments: true }),
  own: (count: number) => exportSettings({ count }),
};

export function target(name: Name): ChatTarget {
  switch (name) {
    case 'a1':
    case 'a2':
      return guildTarget(CH[name], { channelName: name, parentId: CAT_A, parentName: 'Alpha' });
    case 'b1':
      return guildTarget(CH.b1, { channelName: 'b1', parentId: CAT_B, parentName: 'Beta' });
    case 'loose':
      return guildTarget(CH.loose, { channelName: 'loose', parentId: null });
    case 'thread':
      return guildTarget(CH.thread, { kind: 'thread', channelName: 'thread', parentId: CH.a1, channelType: 11 });
    case 'x1':
      return guildTarget(CH.x1, { guildId: OTHER_GUILD, guildName: 'Other Server', channelName: 'x1', parentId: CAT_X });
  }
}

export const item = (name: Name, overrides: Partial<QueueItem> = {}): QueueItem =>
  queueItem(target(name), { addedAt: 1_700_000_000_000 + Object.keys(CH).indexOf(name), ...overrides });

/** The list the tests start from: some channels have settings of their own, some do not. */
export const ITEMS: QueueItem[] = [
  item('loose'),
  item('a1', { settings: S.own(1), lastResult: { status: 'failed', message: 'forbidden', at: 9 } }),
  item('a2'),
  item('b1', { settings: S.own(2) }),
  item('thread', { settings: S.own(3) }),
  item('x1', { settings: S.own(4) }),
  queueItem(dmTarget(), { settings: S.own(5), addedAt: 1_700_000_000_100 }),
];

export const group = (kind: GroupInfo['kind'], guildId: string, channelIds: string[]): GroupInfo => ({
  kind,
  guildId,
  channelIds,
  updatedAt: 1_700_000_000_000,
  name: kind === 'guild' ? 'Server' : 'Category',
});

/** What `LOCAL.groups` says about the world (the thread is in no list: only channels of types 0, 5, 15, 16 are). */
export const GROUPS: Record<string, GroupInfo> = {
  [GUILD_ID]: group('guild', GUILD_ID, [CH.loose, CH.a1, CH.a2, CH.b1]),
  [CAT_A]: group('category', GUILD_ID, [CH.a1, CH.a2]),
  [CAT_B]: group('category', GUILD_ID, [CH.b1]),
  [OTHER_GUILD]: group('guild', OTHER_GUILD, [CH.x1]),
  [CAT_X]: group('category', OTHER_GUILD, [CH.x1]),
};

/** `LOCAL.groupSettings`: every server and category of the world has settings. */
export const GROUP_SETTINGS: Record<string, ExportSettings> = {
  [GUILD_ID]: S.guild,
  [CAT_A]: S.catA,
  [CAT_B]: S.catB,
  [OTHER_GUILD]: S.otherGuild,
  [CAT_X]: S.catX,
};
