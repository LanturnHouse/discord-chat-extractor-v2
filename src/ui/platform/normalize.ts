import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_EXPORT_SETTINGS,
  EXPORT_FORMATS,
  type AccountInfo,
  type AppSettings,
  type BgError,
  type BgResponse,
  type ChatKind,
  type ChatTarget,
  type ErrorKind,
  type ExportSettings,
  type GroupInfo,
  type GroupMap,
  type GroupSettingsMap,
  type HistoryEntry,
  type InjectHealth,
  type ItemPhase,
  type ItemProgress,
  type ItemStatus,
  type JobState,
  type QueueItem,
  type StatusSnapshot,
  type ThemeTokens,
} from '@/shared';

/*
 * Everything the popup reads from chrome.storage or from a background response goes through these functions first. Stored
 * data may come from an older build, from the content script, or be edited by hand; a malformed value must never blank the
 * popup. Each function returns a complete, well-typed value (or null / skips the bad entry) and never throws.
 */

export const MAX_COUNT = 1_000_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const asString = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);
const asBoolean = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
const asFiniteNumber = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const asNullableString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | null => allowed.find((item) => item === value) ?? null;

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_COUNT;
}

/** A complete `ExportSettings`: every field is checked on its own and falls back to `fallback` (the defaults), never to a shared object. */
export function normalizeExportSettings(raw: unknown, fallback: ExportSettings = DEFAULT_EXPORT_SETTINGS): ExportSettings {
  const source = isRecord(raw) ? raw : {};
  const content = isRecord(source.content) ? source.content : {};
  const defaults = fallback.content;
  return {
    count: source.count === null ? null : validCount(source.count) ? source.count : fallback.count,
    from: 'from' in source ? isoOrNull(source.from) : fallback.from,
    to: 'to' in source ? isoOrNull(source.to) : fallback.to,
    format: oneOf(source.format, EXPORT_FORMATS) ?? fallback.format,
    htmlTheme: oneOf(source.htmlTheme, ['dark', 'light'] as const) ?? fallback.htmlTheme,
    includeAttachments: asBoolean(source.includeAttachments, fallback.includeAttachments),
    includeThreads: asBoolean(source.includeThreads, fallback.includeThreads),
    incremental: asBoolean(source.incremental, fallback.incremental),
    content: {
      includeBots: asBoolean(content.includeBots, defaults.includeBots),
      includeSystem: asBoolean(content.includeSystem, defaults.includeSystem),
      includeReactions: asBoolean(content.includeReactions, defaults.includeReactions),
      includeEmbeds: asBoolean(content.includeEmbeds, defaults.includeEmbeds),
    },
  };
}

/** `AppSettings` from whatever is stored under `dce.settings` (nothing = the defaults). */
export function normalizeSettings(raw: unknown): AppSettings {
  const source = isRecord(raw) ? raw : {};
  const defaults = DEFAULT_APP_SETTINGS;
  const timeZone = typeof source.timeZone === 'string' && source.timeZone.trim() !== '' ? source.timeZone : defaults.timeZone;
  return {
    common: normalizeExportSettings(source.common),
    showButtons: asBoolean(source.showButtons, defaults.showButtons),
    showQueuedIndicator: asBoolean(source.showQueuedIndicator, defaults.showQueuedIndicator),
    zipAll: asBoolean(source.zipAll, defaults.zipAll),
    folderName: asString(source.folderName, defaults.folderName),
    dateInFileName: asBoolean(source.dateInFileName, defaults.dateInFileName),
    timeZone,
    notifyOnComplete: asBoolean(source.notifyOnComplete, defaults.notifyOnComplete),
    language: oneOf(source.language, ['auto', 'ko', 'en'] as const) ?? defaults.language,
    consentAt: typeof source.consentAt === 'number' && Number.isFinite(source.consentAt) ? source.consentAt : null,
  };
}

/**
 * `LOCAL.groups(account)`: what the background recorded about servers and categories (docs/PLAN.md §5.1 `GroupInfo`). A
 * malformed group (wrong kind, no server id, no channel list) is skipped, a malformed channel id inside a good one is dropped;
 * name and icon are optional. Never throws, and always returns a fresh object.
 */
export function normalizeGroups(raw: unknown): GroupMap {
  if (!isRecord(raw)) return {};
  const entries: Array<[string, GroupInfo]> = [];
  for (const [id, value] of Object.entries(raw)) {
    if (id === '' || !isRecord(value)) continue;
    const kind = oneOf(value.kind, ['category', 'guild'] as const);
    if (kind === null || typeof value.guildId !== 'string' || value.guildId === '' || !Array.isArray(value.channelIds)) continue;
    const info: GroupInfo = {
      kind,
      guildId: value.guildId,
      channelIds: (value.channelIds as unknown[]).filter((channelId): channelId is string => typeof channelId === 'string' && channelId !== ''),
      updatedAt: asFiniteNumber(value.updatedAt, 0),
    };
    if ('name' in value) info.name = asNullableString(value.name);
    if ('iconUrl' in value) info.iconUrl = asNullableString(value.iconUrl);
    entries.push([id, info]);
  }
  return Object.fromEntries(entries);
}

/** `LOCAL.groupSettings(account)`: group id -> settings. An entry that is not an object is skipped; a good one is completed with defaults. */
export function normalizeGroupSettings(raw: unknown): GroupSettingsMap {
  if (!isRecord(raw)) return {};
  const entries: Array<[string, ExportSettings]> = [];
  for (const [id, value] of Object.entries(raw)) {
    if (id !== '' && isRecord(value)) entries.push([id, normalizeExportSettings(value)]);
  }
  return Object.fromEntries(entries);
}

/** `LOCAL.uiExpanded`: the ids of the tree groups that are open. Anything that is not a non-empty string is dropped, duplicates too. */
export function normalizeExpanded(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set((raw as unknown[]).filter((id): id is string => typeof id === 'string' && id !== ''))];
}

const CHAT_KINDS: readonly ChatKind[] = ['guild-channel', 'thread', 'forum', 'dm', 'group-dm'];

export function normalizeTarget(raw: unknown): ChatTarget | null {
  if (!isRecord(raw)) return null;
  const kind = oneOf(raw.kind, CHAT_KINDS);
  if (kind === null || typeof raw.channelId !== 'string' || raw.channelId === '' || typeof raw.channelName !== 'string') return null;
  const target: ChatTarget = {
    kind,
    channelId: raw.channelId,
    guildId: asNullableString(raw.guildId),
    guildName: asNullableString(raw.guildName),
    channelName: raw.channelName,
  };
  if ('parentId' in raw) target.parentId = asNullableString(raw.parentId);
  if ('parentName' in raw) target.parentName = asNullableString(raw.parentName);
  if (typeof raw.channelType === 'number' && Number.isFinite(raw.channelType)) target.channelType = raw.channelType;
  if ('iconUrl' in raw) target.iconUrl = asNullableString(raw.iconUrl);
  return target;
}

function normalizeLastResult(raw: unknown): QueueItem['lastResult'] {
  if (!isRecord(raw)) return null;
  const status = oneOf(raw.status, ['partial', 'failed', 'cancelled'] as const);
  if (status === null) return null;
  return { status, message: asString(raw.message, ''), at: asFiniteNumber(raw.at, 0) };
}

/** The valid items of a stored queue, in stored order; a malformed entry or a duplicate key is skipped. */
export function normalizeQueue(raw: unknown): QueueItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const items: QueueItem[] = [];
  for (const entry of raw as unknown[]) {
    if (!isRecord(entry)) continue;
    const target = normalizeTarget(entry.target);
    if (target === null) continue;
    const key = typeof entry.key === 'string' && entry.key !== '' ? entry.key : target.channelId;
    if (seen.has(key)) continue;
    seen.add(key);
    const item: QueueItem = {
      key,
      target,
      // `settings: null` follows the common settings; a value that is not an object is treated the same way.
      settings: isRecord(entry.settings) ? normalizeExportSettings(entry.settings) : null,
      addedAt: asFiniteNumber(entry.addedAt, 0),
    };
    const lastResult = normalizeLastResult(entry.lastResult);
    if (lastResult !== null) item.lastResult = lastResult;
    items.push(item);
  }
  return items;
}

export function normalizeHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: HistoryEntry[] = [];
  for (const entry of raw as unknown[]) {
    if (!isRecord(entry)) continue;
    const target = normalizeTarget(entry.target);
    const status = oneOf(entry.status, ['done', 'partial', 'failed'] as const);
    if (target === null || status === null || typeof entry.id !== 'string' || entry.id === '') continue;
    const files = Array.isArray(entry.files)
      ? (entry.files as unknown[]).flatMap((file) =>
          isRecord(file) && typeof file.filename === 'string'
            ? [{ filename: file.filename, downloadId: typeof file.downloadId === 'number' && Number.isFinite(file.downloadId) ? file.downloadId : null }]
            : [],
        )
      : [];
    entries.push({
      id: entry.id,
      accountId: asString(entry.accountId, ''),
      target,
      settings: normalizeExportSettings(entry.settings),
      finishedAt: asFiniteNumber(entry.finishedAt, 0),
      status,
      messageCount: Math.max(0, Math.floor(asFiniteNumber(entry.messageCount, 0))),
      files,
      error: asNullableString(entry.error),
    });
  }
  return entries;
}

const ITEM_STATUSES: readonly ItemStatus[] = ['waiting', 'running', 'paused', 'done', 'partial', 'failed', 'cancelled'];
const ITEM_PHASES: readonly ItemPhase[] = ['resolving', 'messages', 'threads', 'attachments', 'writing', 'saving'];
const ERROR_KINDS: readonly ErrorKind[] = ['auth', 'forbidden', 'not-found', 'rate-limited', 'blocked', 'network', 'server', 'cancelled', 'interrupted', 'unknown'];
const JOB_STATES: readonly JobState['state'][] = ['running', 'paused', 'done', 'cancelled', 'failed'];

function normalizeProgress(raw: unknown): ItemProgress | null {
  if (!isRecord(raw) || typeof raw.key !== 'string' || raw.key === '') return null;
  const error = isRecord(raw.error)
    ? { kind: oneOf(raw.error.kind, ERROR_KINDS) ?? 'unknown', message: asString(raw.error.message, '') }
    : null;
  return {
    key: raw.key,
    label: asString(raw.label, ''),
    status: oneOf(raw.status, ITEM_STATUSES) ?? 'waiting',
    phase: oneOf(raw.phase, ITEM_PHASES),
    fetched: Math.max(0, asFiniteNumber(raw.fetched, 0)),
    expected: typeof raw.expected === 'number' && Number.isFinite(raw.expected) && raw.expected > 0 ? raw.expected : null,
    error,
    files: Array.isArray(raw.files) ? (raw.files as unknown[]).filter((file): file is string => typeof file === 'string') : [],
  };
}

export function normalizeJob(raw: unknown): JobState | null {
  if (!isRecord(raw) || typeof raw.jobId !== 'string' || raw.jobId === '') return null;
  const state = oneOf(raw.state, JOB_STATES);
  if (state === null) return null;
  return {
    jobId: raw.jobId,
    accountId: asString(raw.accountId, ''),
    startedAt: asFiniteNumber(raw.startedAt, 0),
    finishedAt: typeof raw.finishedAt === 'number' && Number.isFinite(raw.finishedAt) ? raw.finishedAt : null,
    state,
    pausedReason: raw.pausedReason === 'rate-limit' ? 'rate-limit' : null,
    zip: raw.zip === true,
    items: Array.isArray(raw.items) ? (raw.items as unknown[]).flatMap((item) => normalizeProgress(item) ?? []) : [],
  };
}

export function normalizeAccount(raw: unknown): AccountInfo | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id === '' || typeof raw.username !== 'string') return null;
  return { id: raw.id, username: raw.username, globalName: asNullableString(raw.globalName), avatarUrl: asString(raw.avatarUrl, '') };
}

export function normalizeHealth(raw: unknown): InjectHealth | null {
  if (!isRecord(raw) || typeof raw.ok !== 'boolean') return null;
  return { ok: raw.ok, reason: asNullableString(raw.reason), checkedAt: asFiniteNumber(raw.checkedAt, 0), url: asString(raw.url, '') };
}

/** The most recent report of `dce.injectHealth` (`Record<tabId, InjectHealth>`). */
export function latestHealth(raw: unknown): InjectHealth | null {
  if (!isRecord(raw)) return null;
  let latest: InjectHealth | null = null;
  for (const entry of Object.values(raw)) {
    const health = normalizeHealth(entry);
    if (health !== null && (latest === null || health.checkedAt >= latest.checkedAt)) latest = health;
  }
  return latest;
}

export function normalizeTheme(raw: unknown): ThemeTokens | null {
  if (!isRecord(raw)) return null;
  const vars: Record<string, string> = {};
  if (isRecord(raw.vars)) {
    for (const [name, value] of Object.entries(raw.vars)) if (typeof value === 'string') vars[name] = value;
  }
  return {
    scheme: raw.scheme === 'light' ? 'light' : 'dark',
    themeClasses: Array.isArray(raw.themeClasses) ? (raw.themeClasses as unknown[]).filter((cls): cls is string => typeof cls === 'string') : [],
    vars,
    lang: asString(raw.lang, ''),
    capturedAt: asFiniteNumber(raw.capturedAt, 0),
  };
}

/** `status/get` data. Null when it is not a snapshot at all. */
export function normalizeStatus(raw: unknown): StatusSnapshot | null {
  if (!isRecord(raw)) return null;
  return {
    account: normalizeAccount(raw.account),
    lastAccount: normalizeAccount(raw.lastAccount),
    discordTabs: Math.max(0, Math.floor(asFiniteNumber(raw.discordTabs, 0))),
    health: normalizeHealth(raw.health),
    job: normalizeJob(raw.job),
  };
}

const BG_ERRORS: readonly BgError[] = ['no-account', 'no-consent', 'busy', 'empty', 'invalid', 'forbidden-path', 'http', 'unknown'];

/** A message response of unknown shape as a `BgResponse` (a missing or malformed answer becomes `{ ok: false, error: 'unknown' }`). */
export function asBgResponse<T>(raw: unknown): BgResponse<T> {
  if (isRecord(raw) && raw.ok === true) return { ok: true, data: raw.data as T };
  if (isRecord(raw) && raw.ok === false) {
    const error = oneOf(raw.error, BG_ERRORS) ?? 'unknown';
    return typeof raw.message === 'string' && raw.message !== '' ? { ok: false, error, message: raw.message } : { ok: false, error };
  }
  return { ok: false, error: 'unknown', message: 'No response from the background worker' };
}
