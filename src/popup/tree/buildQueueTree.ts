import {
  belongsToGroup,
  categoryIdOf,
  isGroupComplete,
  resolveEffectiveSettings,
  type ChatTarget,
  type ExportSettings,
  type GroupInfo,
  type GroupMap,
  type GroupSettingsMap,
  type HistoryEntry,
  type ItemProgress,
  type JobState,
  type QueueItem,
  type SettingsSource,
} from '@/shared';
import { discordCdnUrl, formatTargetLabel } from '@/ui/format/summary';
import { groupOverrides, type GroupOverrides } from '@/ui/groups/overrides';
import { failedStatusOf, overallProgress } from '../progress';

/*
 * The queue tree of docs/PLAN.md §7.2a as a pure function: the items of the download list, what the background recorded about
 * servers and categories (`LOCAL.groups`), the settings of those groups (`LOCAL.groupSettings`), the groups that are open and
 * the running job go in; a render model comes out. No React, no storage, no i18n (the names it falls back to are passed in).
 *
 *   top level   server group | one-line server | DM | a chat without a server
 *   server      category group | one-line category | uncategorised channel
 *   category    channel
 *
 * Which server / category a chat belongs to, which settings it runs with and when a group counts as "the whole server" all come
 * from the shared helpers of src/shared/groups.ts, the same ones the background worker uses.
 */

/** The most channel names the collapsed server line lists before it ends with "…". */
export const MAX_SUBTITLE_NAMES = 3;

/** Where the chats of a group get their settings from when they have none of their own (an item's own settings are never a group's). */
export type GroupSettingsSource = Exclude<SettingsSource, 'item'>;

/** Names to show when neither the recorded group information nor the chats themselves know one. */
export interface TreeNames {
  guild: string;
  category: string;
}

export interface BuildQueueTreeInput {
  /** The download list of the account, in stored order. */
  items: readonly QueueItem[];
  /** `LOCAL.groups`: names, icons, sidebar order and the "whole server / category" check. May be empty or stale. */
  groups: GroupMap;
  /** `LOCAL.groupSettings`: the settings of servers and categories. */
  groupSettings: GroupSettingsMap;
  /** The common settings (what a chat follows when nothing above it has settings). */
  common: ExportSettings;
  /** Ids of the groups that are open (`LOCAL.uiExpanded`). Everything else is collapsed. */
  expanded: readonly string[] | ReadonlySet<string>;
  /** The job: every chat shows its row of it; group lines show the progress of their chats while it runs or is paused. */
  job?: (Pick<JobState, 'state' | 'items'> & Partial<Pick<JobState, 'startedAt'>>) | null;
  /**
   * `LOCAL.history`: the background takes a chat out of the list the moment it is done, so a running job's finished chats are
   * only known from here. They keep counting for the group they were in (so "1/4" does not become "0/3"); see `finishedChatsOf`.
   */
  history?: readonly HistoryEntry[];
  fallbackNames?: Partial<TreeNames>;
}

export interface GroupProgress {
  finished: number;
  total: number;
  /** 0..1, or null when nothing is known. */
  ratio: number | null;
}

/** One group a one-line row stands for ("예시서버 › #채널": the server). */
export interface PathPart {
  kind: 'guild' | 'category';
  name: string;
  /** Servers only: a validated `https://cdn.discordapp.com/...` URL, else null (the first letter is shown instead). */
  iconUrl: string | null;
}

/** A chat of the list: a channel, thread or forum of a server, a DM, or a chat without a server. */
export interface ChannelRowModel {
  type: 'channel' | 'dm';
  key: string;
  item: QueueItem;
  /** 0 = top level, 1 = below a server (or a one-line category), 2 = below a category. */
  depth: 0 | 1 | 2;
  /** What the row says: "#general", "#general > weekend plans" (a thread), the name of a DM. */
  name: string;
  /** The same with the server in front (the name of the buttons): "Sample Server > #general". */
  fullLabel: string;
  /** Compressed rows only: the group the line stands for (a server, or a category), shown in front of the name. Empty for a plain row. */
  path: PathPart[];
  /** The tooltip: the whole path ("Sample Server › Study › #general") for a compressed row, the full label otherwise. */
  tooltip: string;
  /** What the chat is exported with, and where that comes from (item > category > server > common). */
  settings: ExportSettings;
  source: SettingsSource;
  /** The chat's row of the running job. */
  progress: ItemProgress | undefined;
}

/** A server or category line with the chats below it. */
export interface GroupNodeModel {
  type: 'group';
  kind: 'guild' | 'category';
  /** Server id or category id: the key of `LOCAL.groups`, `LOCAL.groupSettings` and `LOCAL.uiExpanded`. */
  id: string;
  guildId: string;
  depth: 0 | 1;
  name: string;
  iconUrl: string | null;
  expanded: boolean;
  /** The queued chats below the group, in the order they are shown (what ▶ starts and ✕ takes out). */
  keys: string[];
  /** How many chats are queued below the group. */
  count: number;
  /** Every viewable channel of the group is queued: the chip says "전체 N개" instead of "N개". */
  complete: boolean;
  /** The group has settings of its own. */
  hasOwnSettings: boolean;
  /** Where the chats below follow: its own settings, else (category) the server's, else the common ones. */
  settingsSource: GroupSettingsSource;
  /** How many chats below have settings of their own ("개별 N"). */
  overrideCount: number;
  /**
   * How many chats below did not finish and are still in the list with a [재시도] (failed, partial, cancelled): a collapsed group
   * must not hide them. Counted like the chat rows do (docs/PLAN.md §7.2: the job's row, else the note the last attempt left).
   */
  failedCount: number;
  /** A collapsed server lists a few channel names under its name. */
  subtitle: { names: string[]; more: boolean } | null;
  /** The progress of the chats below while a job runs, else null. */
  progress: GroupProgress | null;
  children: TreeRowModel[];
}

export type TreeRowModel = GroupNodeModel | ChannelRowModel;

export interface QueueTreeModel {
  rows: TreeRowModel[];
  /** The number of chats in the list. */
  count: number;
}

// --- helpers ---------------------------------------------------------------------------------------------------------

type SortKey = readonly number[];
interface Entry {
  row: TreeRowModel;
  sort: SortKey;
}

const isDmKind = (kind: ChatTarget['kind']): boolean => kind === 'dm' || kind === 'group-dm';
const clean = (value: string | null | undefined): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
const toSet = (ids: readonly string[] | ReadonlySet<string>): ReadonlySet<string> => (ids instanceof Set ? ids : new Set(ids as readonly string[]));
type JobInput = NonNullable<BuildQueueTreeInput['job']>;
const isActive = (job: BuildQueueTreeInput['job']): job is JobInput => job != null && (job.state === 'running' || job.state === 'paused');

/**
 * The chats of the running (or paused) job that are already out of the list. The background removes a chat from the queue as soon
 * as it is done, but writes it to the history in the same step: a `done` entry of this job (finished after it started, a chat the
 * job has a row for, nothing in the list under that key any more) is such a chat. They are returned as list items (`settings`
 * unknown, `addedAt` = when they finished) so the shared helpers can say which server and category they were in. At most one
 * per chat; none when there is no active job.
 */
export function finishedChatsOf(history: readonly HistoryEntry[], job: BuildQueueTreeInput['job'], queuedKeys: ReadonlySet<string>): QueueItem[] {
  if (!isActive(job)) return [];
  const inJob = new Set(job.items.map((row) => row.key));
  const seen = new Set<string>();
  const chats: QueueItem[] = [];
  for (const entry of history) {
    const key = entry.target.channelId;
    if (entry.status !== 'done' || entry.finishedAt < (job.startedAt ?? 0)) continue;
    if (!inJob.has(key) || queuedKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    chats.push({ key, target: entry.target, settings: null, addedAt: entry.finishedAt });
  }
  return chats;
}

/** Lexicographic; `Infinity` (unknown position) sorts last and two of them are equal. */
function compareKeys(a: SortKey, b: SortKey): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index] ?? Infinity;
    const right = b[index] ?? Infinity;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

const sidebarIndex = (info: GroupInfo | undefined): ReadonlyMap<string, number> => new Map((info?.channelIds ?? []).map((id, index) => [id, index]));

/** What a chat is called under its server: "#general", "#general > weekend plans" for a thread, the name of a DM. */
export function channelNameOf(target: ChatTarget): string {
  const name = clean(target.channelName) ?? target.channelId;
  if (isDmKind(target.kind)) return name;
  if (target.kind === 'thread') {
    const parent = clean(target.parentName);
    return parent === null ? name : `#${parent} > ${name}`;
  }
  return `#${name}`;
}

interface Context {
  groups: GroupMap;
  groupSettings: GroupSettingsMap;
  common: ExportSettings;
  expanded: ReadonlySet<string>;
  names: TreeNames;
  queuedKeys: ReadonlySet<string>;
  /** Position of every item in the input list: the last tie-break, so the order never depends on the sort algorithm. */
  order: ReadonlyMap<string, number>;
  /** The rows of the job (running or just ended): a chat shows its own, whatever state the job is in. */
  progress: ReadonlyMap<string, ItemProgress>;
  /** The job is running or paused: only then do the group lines show the progress of what is inside. */
  jobActive: boolean;
  /** The job rows of the chats that finished and left the list, by the id of every server and category they were in (see `finishedChatsOf`). */
  finished: ReadonlyMap<string, ItemProgress[]>;
}

const DEFAULT_NAMES: TreeNames = { guild: 'Server', category: 'Category' };

function infoOf(groups: GroupMap, id: string, kind: GroupInfo['kind']): GroupInfo | undefined {
  const info = groups[id];
  return info !== undefined && info.kind === kind ? info : undefined;
}

/** Name of a server: what the background recorded, else what the chats say, else the fallback. */
function guildNameOf(groups: GroupMap, guildId: string, items: readonly QueueItem[], names: TreeNames): string {
  for (const candidate of [infoOf(groups, guildId, 'guild')?.name, ...items.map((item) => item.target.guildName)]) {
    const name = clean(candidate);
    if (name !== null) return name;
  }
  return names.guild;
}

/** Name of a category: what the background recorded, else the parent name of the channels in it (never a thread's: that is a channel), else the fallback. */
function categoryNameOf(groups: GroupMap, categoryId: string, items: readonly QueueItem[], names: TreeNames): string {
  const own = items.filter((item) => item.target.kind !== 'thread').map((item) => item.target.parentName);
  for (const candidate of [infoOf(groups, categoryId, 'category')?.name, ...own]) {
    const name = clean(candidate);
    if (name !== null) return name;
  }
  return names.category;
}

function channelRow(ctx: Context, item: QueueItem, depth: 0 | 1 | 2, path: PathPart[], trail: string[]): ChannelRowModel {
  const { settings, source } = resolveEffectiveSettings(item, ctx.common, ctx.groupSettings, ctx.groups);
  const name = channelNameOf(item.target);
  const fullLabel = formatTargetLabel(item.target);
  return {
    type: isDmKind(item.target.kind) ? 'dm' : 'channel',
    key: item.key,
    item,
    depth,
    name,
    fullLabel,
    path,
    tooltip: path.length === 0 ? fullLabel : [...trail, name].join(' › '),
    settings,
    source,
    progress: ctx.progress.get(item.key),
  };
}

function channelsOf(rows: readonly TreeRowModel[]): ChannelRowModel[] {
  return rows.flatMap((row) => (row.type === 'group' ? channelsOf(row.children) : [row]));
}

/**
 * The progress of the job inside one group: the rows of the chats that are in the list now plus those of the chats of the group
 * that finished and left it, so the total stays the same while the chats finish one after the other. A group none of whose
 * remaining chats takes part in the job has none.
 */
function groupProgress(ctx: Context, id: string, keys: readonly string[]): GroupProgress | null {
  if (!ctx.jobActive) return null;
  const live = keys.flatMap((key) => ctx.progress.get(key) ?? []);
  if (live.length === 0) return null;
  return overallProgress({ items: [...live, ...(ctx.finished.get(id) ?? [])] });
}

/** A group that lost chats to the running job and still has chats in it: it keeps its line (and its progress) instead of shrinking to one chat's line. */
function keepsLineForJob(ctx: Context, id: string, members: readonly QueueItem[]): boolean {
  return ctx.jobActive && ctx.finished.has(id) && members.some((item) => ctx.progress.has(item.key));
}

interface GroupParts {
  kind: 'guild' | 'category';
  id: string;
  guildId: string;
  depth: 0 | 1;
  name: string;
  iconUrl: string | null;
  complete: boolean;
  hasOwnSettings: boolean;
  settingsSource: GroupSettingsSource;
  members: readonly QueueItem[];
  children: TreeRowModel[];
}

function groupNode(ctx: Context, parts: GroupParts): GroupNodeModel {
  const channels = channelsOf(parts.children);
  const keys = channels.map((row) => row.key);
  const expanded = ctx.expanded.has(parts.id);
  return {
    type: 'group',
    kind: parts.kind,
    id: parts.id,
    guildId: parts.guildId,
    depth: parts.depth,
    name: parts.name,
    iconUrl: parts.iconUrl,
    expanded,
    keys,
    count: keys.length,
    complete: parts.complete,
    hasOwnSettings: parts.hasOwnSettings,
    settingsSource: parts.settingsSource,
    overrideCount: parts.members.filter((item) => item.settings !== null).length,
    failedCount: channels.filter((row) => failedStatusOf(row.item, row.progress, ctx.jobActive) !== null).length,
    subtitle:
      parts.kind === 'guild' && !expanded && channels.length > 0
        ? { names: channels.slice(0, MAX_SUBTITLE_NAMES).map((row) => row.name), more: channels.length > MAX_SUBTITLE_NAMES }
        : null,
    progress: groupProgress(ctx, parts.id, keys),
    children: parts.children,
  };
}

/** The smallest of `values` (`Infinity` for none). A loop, not `Math.min(...values)`: a long list must not become a long argument list. */
function smallest(values: Iterable<number>): number {
  let min = Infinity;
  for (const value of values) if (value < min) min = value;
  return min;
}

/** The earliest `addedAt` of `items`, and the earliest position in the list as the tie-break. */
const earliest = (ctx: Context, items: readonly QueueItem[]): SortKey => [
  smallest(items.map((item) => item.addedAt)),
  smallest(items.map((item) => ctx.order.get(item.key) ?? 0)),
];

/** A category inside a server: a group line, or - when it holds one chat only and nothing else needs the line - the chat with the category in front. */
function buildCategory(
  ctx: Context,
  categoryId: string,
  guildId: string,
  guildName: string,
  guildHasSettings: boolean,
  members: readonly QueueItem[],
  guildSidebar: ReadonlyMap<string, number>,
): Entry {
  const info = infoOf(ctx.groups, categoryId, 'category');
  const name = categoryNameOf(ctx.groups, categoryId, members, ctx.names);
  const hasOwnSettings = ctx.groupSettings[categoryId] !== undefined;
  const complete = isGroupComplete(info, ctx.queuedKeys);
  const categorySidebar = sidebarIndex(info);
  const keyOf = (item: QueueItem): SortKey => [
    guildSidebar.get(item.key) ?? Infinity,
    categorySidebar.get(item.key) ?? Infinity,
    item.addedAt,
    ctx.order.get(item.key) ?? 0,
  ];
  const sort: SortKey = [smallest(members.map((item) => guildSidebar.get(item.key) ?? Infinity)), ...earliest(ctx, members)];

  if (members.length === 1 && !complete && !hasOwnSettings && !keepsLineForJob(ctx, categoryId, members)) {
    const row = channelRow(ctx, members[0], 1, [{ kind: 'category', name, iconUrl: null }], [guildName, name]);
    return { row, sort };
  }

  const children = members
    .map((item): Entry => ({ row: channelRow(ctx, item, 2, [], [guildName, name]), sort: keyOf(item) }))
    .sort((a, b) => compareKeys(a.sort, b.sort))
    .map((entry) => entry.row);
  const node = groupNode(ctx, {
    kind: 'category',
    id: categoryId,
    guildId,
    depth: 1,
    name,
    iconUrl: null,
    complete,
    hasOwnSettings,
    settingsSource: hasOwnSettings ? 'category' : guildHasSettings ? 'guild' : 'common',
    members,
    children,
  });
  return { row: node, sort };
}

/** A server: a group line with its categories and channels, or - when it holds one chat only and nothing else needs the line - the chat with the server in front. */
function buildGuild(ctx: Context, guildId: string, items: readonly QueueItem[]): Entry {
  const info = infoOf(ctx.groups, guildId, 'guild');
  const name = guildNameOf(ctx.groups, guildId, items, ctx.names);
  const iconUrl = discordCdnUrl(info?.iconUrl);
  const hasOwnSettings = ctx.groupSettings[guildId] !== undefined;
  const complete = isGroupComplete(info, ctx.queuedKeys);
  const sidebar = sidebarIndex(info);
  const top = earliest(ctx, items);

  if (items.length === 1 && !complete && !hasOwnSettings && !keepsLineForJob(ctx, guildId, items)) {
    const only = items[0];
    const categoryId = categoryIdOf(only, ctx.groups);
    // A category with settings of its own keeps its line: it is the only place to edit them.
    if (categoryId === null || ctx.groupSettings[categoryId] === undefined) {
      const trail = categoryId === null ? [name] : [name, categoryNameOf(ctx.groups, categoryId, items, ctx.names)];
      return { row: channelRow(ctx, only, 0, [{ kind: 'guild', name, iconUrl }], trail), sort: top };
    }
  }

  const buckets = new Map<string | null, QueueItem[]>();
  for (const item of items) {
    const categoryId = categoryIdOf(item, ctx.groups);
    const bucket = buckets.get(categoryId);
    if (bucket === undefined) buckets.set(categoryId, [item]);
    else bucket.push(item);
  }
  const entries: Entry[] = [];
  for (const [categoryId, members] of buckets) {
    if (categoryId === null) {
      for (const item of members) {
        entries.push({ row: channelRow(ctx, item, 1, [], [name]), sort: [sidebar.get(item.key) ?? Infinity, item.addedAt, ctx.order.get(item.key) ?? 0] });
      }
    } else {
      entries.push(buildCategory(ctx, categoryId, guildId, name, hasOwnSettings, members, sidebar));
    }
  }
  entries.sort((a, b) => compareKeys(a.sort, b.sort));
  const node = groupNode(ctx, {
    kind: 'guild',
    id: guildId,
    guildId,
    depth: 0,
    name,
    iconUrl,
    complete,
    hasOwnSettings,
    settingsSource: hasOwnSettings ? 'guild' : 'common',
    members: items,
    children: entries.map((entry) => entry.row),
  });
  return { row: node, sort: top };
}

/**
 * The render model of the download list. Servers and DMs are the top level, ordered by the earliest `addedAt` of what is inside;
 * below a server the sidebar order of `LOCAL.groups` decides (`addedAt` where it knows nothing). A server or category that holds
 * ONE queued chat, is not "whole" and has no settings of its own is not a group line: its chat is shown in one line with the
 * server or category in front (`서버 › #채널`). A server whose only chat sits in a category with settings of its own stays a group
 * (so that category's line, the only place its settings can be edited, is not hidden).
 */
export function buildQueueTree(input: BuildQueueTreeInput): QueueTreeModel {
  const { items } = input;
  const job = input.job ?? null;
  const queuedKeys = new Set(items.map((item) => item.key));
  const progress = new Map((job?.items ?? []).map((row): [string, ItemProgress] => [row.key, row]));
  const finished = new Map<string, ItemProgress[]>();
  for (const chat of finishedChatsOf(input.history ?? [], job, queuedKeys)) {
    const row = progress.get(chat.key);
    if (row === undefined) continue;
    for (const id of [chat.target.guildId, categoryIdOf(chat, input.groups)]) {
      if (typeof id !== 'string' || id === '') continue;
      const rows = finished.get(id);
      if (rows === undefined) finished.set(id, [row]);
      else rows.push(row);
    }
  }
  const ctx: Context = {
    groups: input.groups,
    groupSettings: input.groupSettings,
    common: input.common,
    expanded: toSet(input.expanded),
    names: { ...DEFAULT_NAMES, ...input.fallbackNames },
    queuedKeys,
    order: new Map(items.map((item, index) => [item.key, index])),
    progress,
    jobActive: isActive(job),
    finished,
  };

  const flat: QueueItem[] = [];
  const byGuild = new Map<string, QueueItem[]>();
  for (const item of items) {
    const guildId = item.target.guildId;
    if (isDmKind(item.target.kind) || typeof guildId !== 'string' || guildId === '') {
      flat.push(item);
      continue;
    }
    const list = byGuild.get(guildId);
    if (list === undefined) byGuild.set(guildId, [item]);
    else list.push(item);
  }

  const entries: Entry[] = flat.map((item) => ({ row: channelRow(ctx, item, 0, [], []), sort: earliest(ctx, [item]) }));
  for (const [guildId, list] of byGuild) entries.push(buildGuild(ctx, guildId, list));
  entries.sort((a, b) => compareKeys(a.sort, b.sort));
  return { rows: entries.map((entry) => entry.row), count: items.length };
}

// --- one group, without the tree ----------------------------------------------------------------------------------------

export interface DescribeGroupInput {
  items: readonly QueueItem[];
  groups: GroupMap;
  groupSettings: GroupSettingsMap;
  common: ExportSettings;
  fallbackNames?: Partial<TreeNames>;
}

/** What the group settings screen needs to know about one server or category. */
export interface GroupDescription {
  kind: 'guild' | 'category';
  id: string;
  guildId: string;
  name: string;
  /** The queued chats in the group, in list order ("채널 N개에 적용돼요"). */
  keys: string[];
  /** The group's own settings (null = it follows what is above it). */
  ownSettings: ExportSettings | null;
  /** What its chats follow now: its own settings, else (category) the server's, else the common ones. */
  effective: ExportSettings;
  /** What saving settings here replaces; "아래 개별 설정 M개" is `itemKeys.length + categoryIds.length`. */
  overrides: GroupOverrides;
}

/** The server / category `id` as the settings screen shows it, computed from the current state; null when no queued chat belongs to it. */
export function describeGroup(kind: 'guild' | 'category', id: string, input: DescribeGroupInput): GroupDescription | null {
  const { groups, groupSettings } = input;
  const names = { ...DEFAULT_NAMES, ...input.fallbackNames };
  const members = input.items.filter((item) => !isDmKind(item.target.kind) && belongsToGroup(item, kind, id, groups));
  if (members.length === 0) return null;
  const guildId = members[0].target.guildId ?? '';
  const own = groupSettings[id];
  const inherited = kind === 'category' ? groupSettings[guildId] : undefined;
  return {
    kind,
    id,
    guildId,
    name: kind === 'guild' ? guildNameOf(groups, id, members, names) : categoryNameOf(groups, id, members, names),
    keys: members.map((item) => item.key),
    ownSettings: own === undefined ? null : structuredClone(own),
    effective: structuredClone(own ?? inherited ?? input.common),
    overrides: groupOverrides(kind, id, input.items, groups, groupSettings),
  };
}
