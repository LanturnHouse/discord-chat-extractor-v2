import type { ChatTarget, ExportSettings, GroupInfo, QueueItem } from '@/shared';
import { DEFAULT_EXPORT_SETTINGS } from '@/shared';

/*
 * Sample data for the queue tree (docs/PLAN.md §7.2a): servers, categories, uncategorised channels, a complete category, a
 * server that compresses to one line, a server with settings of its own, a DM and a few channels with settings of their own.
 * Neutral names and made-up ids only (docs/PLAN.md §10).
 */

const mockId = (prefix: 1 | 2 | 3 | 4, n: number): string => `${prefix}${'0'.repeat(12)}${String(n).padStart(5, '0')}`;

/** The servers of the sample data (the first two also own the chats of the older scenarios). */
export const MOCK_GUILDS = {
  sample: { id: mockId(2, 1), name: 'Sample Server' },
  study: { id: mockId(2, 2), name: 'Study Group' },
  book: { id: mockId(2, 3), name: 'Book Club' },
} as const;

/** The categories of the sample data. */
export const MOCK_CATEGORIES = {
  study: { id: mockId(4, 1), name: 'Study' },
  lounge: { id: mockId(4, 2), name: 'Lounge' },
  archive: { id: mockId(4, 3), name: 'Archive' },
  courses: { id: mockId(4, 4), name: 'Courses' },
  books: { id: mockId(4, 5), name: 'Books' },
} as const;

type Guild = (typeof MOCK_GUILDS)[keyof typeof MOCK_GUILDS];
type Category = (typeof MOCK_CATEGORIES)[keyof typeof MOCK_CATEGORIES];

function channel(n: number, guild: Guild, name: string, category: Category | null = null): ChatTarget {
  return {
    kind: 'guild-channel',
    channelId: mockId(3, n),
    guildId: guild.id,
    guildName: guild.name,
    channelName: name,
    parentId: category?.id ?? null,
    parentName: category?.name ?? null,
  };
}

/** The chats of the `tree` scenario (ids 3...0011 and up), by name. */
export const TREE_TARGETS = {
  welcome: channel(11, MOCK_GUILDS.sample, 'welcome'),
  rules: channel(12, MOCK_GUILDS.sample, 'rules'),
  general: channel(1, MOCK_GUILDS.sample, 'general', MOCK_CATEGORIES.study),
  questions: channel(13, MOCK_GUILDS.sample, 'questions', MOCK_CATEGORIES.study),
  resources: channel(14, MOCK_GUILDS.sample, 'resources', MOCK_CATEGORIES.study),
  chat: channel(15, MOCK_GUILDS.sample, 'chat', MOCK_CATEGORIES.lounge),
  music: channel(16, MOCK_GUILDS.sample, 'music', MOCK_CATEGORIES.lounge),
  oldNews: channel(17, MOCK_GUILDS.sample, 'old-news', MOCK_CATEGORIES.archive),
  weekend: {
    kind: 'thread',
    channelId: mockId(3, 5),
    guildId: MOCK_GUILDS.sample.id,
    guildName: MOCK_GUILDS.sample.name,
    channelName: 'weekend plans',
    parentId: mockId(3, 1),
    parentName: 'general',
  } satisfies ChatTarget,
  announcements: channel(21, MOCK_GUILDS.study, 'announcements'),
  math: channel(22, MOCK_GUILDS.study, 'math', MOCK_CATEGORIES.courses),
  physics: channel(23, MOCK_GUILDS.study, 'physics', MOCK_CATEGORIES.courses),
  reading: channel(31, MOCK_GUILDS.book, 'reading', MOCK_CATEGORIES.books),
  reviews: channel(32, MOCK_GUILDS.book, 'reviews', MOCK_CATEGORIES.books),
  dm: { kind: 'dm', channelId: mockId(3, 3), guildId: null, guildName: null, channelName: 'Alex' } satisfies ChatTarget,
} as const;

const settingsWith = (patch: Partial<ExportSettings>): ExportSettings => ({ ...DEFAULT_EXPORT_SETTINGS, content: { ...DEFAULT_EXPORT_SETTINGS.content }, ...patch });

function entry(target: ChatTarget, addedAt: number, settings: ExportSettings | null = null, extra: Partial<QueueItem> = {}): QueueItem {
  return { key: target.channelId, target: { ...target }, settings, addedAt, ...extra };
}

/** The list of the `tree` scenario. */
export function treeQueue(now: number): QueueItem[] {
  return [
    entry(TREE_TARGETS.welcome, now - 100_000),
    entry(TREE_TARGETS.general, now - 99_000),
    entry(TREE_TARGETS.questions, now - 98_000, settingsWith({ count: 50, format: 'csv' })),
    entry(TREE_TARGETS.resources, now - 97_000),
    entry(TREE_TARGETS.chat, now - 96_000),
    entry(TREE_TARGETS.oldNews, now - 95_000, null, { lastResult: { status: 'failed', message: '이 채널을 볼 권한이 없어요.', at: now - 5_000 } }),
    entry(TREE_TARGETS.weekend, now - 94_000),
    entry(TREE_TARGETS.dm, now - 60_000),
    entry(TREE_TARGETS.reading, now - 50_000),
    entry(TREE_TARGETS.announcements, now - 40_000),
    entry(TREE_TARGETS.math, now - 39_000, settingsWith({ count: 20, format: 'md' })),
    entry(TREE_TARGETS.physics, now - 38_000),
  ];
}

/**
 * The list of the `risk` scenario: the 12 chats of the `tree` scenario, so a download of the whole list is a big one (more than 10
 * chats), and two chats that make it bigger. "Book Club › #reading" reads every message with no start date (a safety question
 * for that chat alone), "#questions" asks for 25,000 messages with its threads (the Sample Server line and the whole list ask too).
 */
export function riskQueue(now: number): QueueItem[] {
  return treeQueue(now).map((queued) => {
    if (queued.key === TREE_TARGETS.reading.channelId) return { ...queued, settings: settingsWith({ count: null }) };
    if (queued.key === TREE_TARGETS.questions.channelId) return { ...queued, settings: settingsWith({ count: 25_000, includeThreads: true }) };
    return queued;
  });
}

function guildGroup(guild: Guild, channelIds: string[], now: number, iconUrl: string | null = null): GroupInfo {
  return { kind: 'guild', guildId: guild.id, channelIds, updatedAt: now - 10_000, name: guild.name, iconUrl };
}

function categoryGroup(guild: Guild, category: Category, channelIds: string[], now: number): GroupInfo {
  return { kind: 'category', guildId: guild.id, channelIds, updatedAt: now - 10_000, name: category.name };
}

/** `LOCAL.groups` of the `tree` scenario: every viewable channel of the three servers, in sidebar order. */
export function treeGroups(now: number): Record<string, GroupInfo> {
  const t = TREE_TARGETS;
  const ids = (...targets: ChatTarget[]): string[] => targets.map((target) => target.channelId);
  return {
    // the icon does not exist: the preview shows how the first letter takes its place when an icon cannot be loaded
    [MOCK_GUILDS.sample.id]: guildGroup(
      MOCK_GUILDS.sample,
      ids(t.welcome, t.rules, t.general, t.questions, t.resources, t.chat, t.music, t.oldNews),
      now,
      `https://cdn.discordapp.com/icons/${MOCK_GUILDS.sample.id}/sample-icon.png?size=64`,
    ),
    [MOCK_CATEGORIES.study.id]: categoryGroup(MOCK_GUILDS.sample, MOCK_CATEGORIES.study, ids(t.general, t.questions, t.resources), now),
    [MOCK_CATEGORIES.lounge.id]: categoryGroup(MOCK_GUILDS.sample, MOCK_CATEGORIES.lounge, ids(t.chat, t.music), now),
    [MOCK_CATEGORIES.archive.id]: categoryGroup(MOCK_GUILDS.sample, MOCK_CATEGORIES.archive, ids(t.oldNews), now),
    [MOCK_GUILDS.study.id]: guildGroup(MOCK_GUILDS.study, ids(t.announcements, t.math, t.physics), now),
    [MOCK_CATEGORIES.courses.id]: categoryGroup(MOCK_GUILDS.study, MOCK_CATEGORIES.courses, ids(t.math, t.physics), now),
    [MOCK_GUILDS.book.id]: guildGroup(MOCK_GUILDS.book, ids(t.reading, t.reviews), now),
    [MOCK_CATEGORIES.books.id]: categoryGroup(MOCK_GUILDS.book, MOCK_CATEGORIES.books, ids(t.reading, t.reviews), now),
  };
}

/** `LOCAL.groupSettings` of the `tree` scenario: the server "Study Group" has settings of its own. */
export function treeGroupSettings(): Record<string, ExportSettings> {
  return { [MOCK_GUILDS.study.id]: settingsWith({ count: 50, format: 'md', includeAttachments: true }) };
}

/**
 * `LOCAL.groups` of the `running` scenario (the chats of the older sample data): "Sample Server" has two of its three viewable
 * channels in the list (a group row with the progress of both), "Study Group" one of two (compressed to a single line).
 */
export function runningGroups(now: number, chats: { general: ChatTarget; announcements: ChatTarget; questions: ChatTarget }): Record<string, GroupInfo> {
  return {
    [MOCK_GUILDS.sample.id]: guildGroup(MOCK_GUILDS.sample, [chats.general.channelId, chats.announcements.channelId, TREE_TARGETS.rules.channelId], now),
    [MOCK_GUILDS.study.id]: guildGroup(MOCK_GUILDS.study, [chats.questions.channelId, TREE_TARGETS.announcements.channelId], now),
  };
}
