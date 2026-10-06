/**
 * Validation and normalisation of everything the background worker accepts from outside: messages of the content script, the
 * popup and the offscreen engine, and the values it reads back from `chrome.storage`.
 *
 * Two flavours, both pure (no chrome.* access):
 *  - `validate*` is STRICT: it checks an incoming message and returns a fresh object holding only the known fields, or a
 *    reason it was refused (the router turns that into `{ ok: false, error: 'invalid' }`);
 *  - `normalize*` is LENIENT: it reads stored data (older versions, hand edits) and repairs it field by field, so one bad
 *    value never takes the rest down with it.
 */
import { DEFAULT_APP_SETTINGS, DEFAULT_EXPORT_SETTINGS, EXPORT_FORMATS } from '@/shared';
import type {
  AppSettings,
  ChatKind,
  ChatTarget,
  ErrorKind,
  ExportFormat,
  ExportSettings,
  GroupInfo,
  HistoryEntry,
  ItemPhase,
  ItemProgress,
  ItemStatus,
  JobState,
  QueueItem,
} from '@/shared';
import { isNumericId, isRecord } from './util';

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string };
const good = <T>(value: T): Checked<T> => ({ ok: true, value });
const bad = (message: string): Checked<never> => ({ ok: false, message });

export const MAX_NAME_LENGTH = 100;
export const MAX_COUNT = 1_000_000;
export const MAX_FOLDER_NAME_LENGTH = 60;
export const MAX_HISTORY_ENTRIES = 200;
/** Files kept per history entry (the main file comes first, attachments after it). */
export const MAX_HISTORY_FILES = 100;
/** Strings longer than this are refused before anything is done with them. */
const MAX_RAW_TEXT = 1000;
const MAX_FILENAME_LENGTH = 400;
const MAX_MESSAGE_LENGTH = 300;

// ---- text ---------------------------------------------------------------------------------------------------------------

/** C0/C1 control characters and DEL. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/** Zero-width and bidi-control characters: invisible, and RLO-style ones can make a name read backwards. */
const INVISIBLE = /[​⁠﻿؜‎‏‪-‮⁦-⁩]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const codePoints = (text: string): number => Array.from(text).length;

/**
 * Text from an untrusted message: control and bidi characters dropped, whitespace collapsed, at most `max` code points.
 * `null` = not a string, absurdly long, or longer than `max` after cleaning.
 */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length > MAX_RAW_TEXT) return null;
  const text = value.replace(CONTROL, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return codePoints(text) <= max ? text : null;
}

function truncate(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('');
}

// ---- file and folder names ----------------------------------------------------------------------------------------------

/** Windows-forbidden characters (which include both path separators) plus control characters. */
const FOLDER_FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g;
/** Windows device names; the superscript digits are reserved too on current Windows. */
const RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])$/i;

const trimDotsAndSpaces = (text: string): string => text.replace(/^[. ]+|[. ]+$/g, '');

/**
 * Turns the text of the "folder name" setting into one safe path segment (docs/PLAN.md §6.6): forbidden characters and
 * separators become `_`, invisible characters go, `%` becomes `_`, no leading/trailing dots or spaces, a reserved device
 * name gets a `_` in front, at most 60 characters. Returns '' when nothing usable is left.
 */
export function sanitizeFolderName(raw: string): string {
  let text = raw
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .replace(FOLDER_FORBIDDEN, '_')
    .replace(/%/g, '_')
    .replace(LONE_SURROGATE, '_');
  text = trimDotsAndSpaces(text);
  if (text === '') return '';
  // Windows treats "CON", "con.txt" and "CON.anything" alike: the check looks at the part before the first dot.
  const dot = text.indexOf('.');
  const base = dot === -1 ? text : text.slice(0, dot);
  if (RESERVED_DEVICE.test(base.trimEnd())) text = `_${text}`;
  return trimDotsAndSpaces(truncate(text, MAX_FOLDER_NAME_LENGTH));
}

const UNSAFE_PATH_CHARS = /[\\:*?"<>|\u0000-\u001f\u007f-\u009f]/;

/**
 * May `value` be handed to `chrome.downloads.download({ filename })`? A relative path with forward slashes only: not empty,
 * no absolute path (leading `/`, drive letter, UNC), no `.`/`..`/empty segment, no control characters and none of the
 * characters Windows forbids. The engine already cleans every segment (docs/PLAN.md §6.6); this is the second check.
 */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_FILENAME_LENGTH) return false;
  if (UNSAFE_PATH_CHARS.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && !/^[. ]+$/.test(segment));
}

const CDN_HOSTS: ReadonlySet<string> = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

/** An https URL on the Discord CDN (the only hosts attachments are saved from), without credentials or a custom port. */
export function isDiscordCdnUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && CDN_HOSTS.has(url.hostname) && url.port === '' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/** A blob URL made by this extension's own pages (`blob:chrome-extension://<id>/<uuid>`). */
export function isOwnBlobUrl(value: unknown, extensionId: string): value is string {
  return typeof value === 'string' && value.length <= 200 && value.startsWith(`blob:chrome-extension://${extensionId}/`);
}

// ---- chat targets -------------------------------------------------------------------------------------------------------

const CHAT_KINDS: readonly string[] = ['guild-channel', 'thread', 'forum', 'dm', 'group-dm'] satisfies ChatKind[];

export const isDirectMessageKind = (kind: ChatKind): boolean => kind === 'dm' || kind === 'group-dm';

/**
 * A chat target from the content script (or built from an API answer): numeric-string ids, `kind` from the enum, DMs without
 * a `guildId` and guild chats with one, names of at most 100 characters. The result holds only the known fields; an
 * `iconUrl` that is not on the Discord CDN is dropped instead of failing the whole target.
 */
export function validateTarget(raw: unknown): Checked<ChatTarget> {
  if (!isRecord(raw)) return bad('target must be an object');
  const { kind, channelId, guildId, guildName, channelName, parentId, parentName, channelType, iconUrl } = raw;

  if (typeof kind !== 'string' || !CHAT_KINDS.includes(kind)) return bad('target.kind is not a known chat kind');
  if (!isNumericId(channelId)) return bad('target.channelId must be a numeric string');
  if (guildId !== null && !isNumericId(guildId)) return bad('target.guildId must be a numeric string or null');
  const direct = isDirectMessageKind(kind as ChatKind);
  if (direct && guildId !== null) return bad('a direct message has no guildId');
  if (!direct && guildId === null) return bad('a guild chat needs a guildId');

  const channelLabel = cleanText(channelName, MAX_NAME_LENGTH);
  if (channelLabel === null || channelLabel === '') return bad('target.channelName must be 1..100 characters');

  const target: ChatTarget = {
    kind: kind as ChatKind,
    channelId,
    guildId: guildId as string | null,
    guildName: null,
    channelName: channelLabel,
  };

  if (guildName !== null && guildName !== undefined) {
    const text = cleanText(guildName, MAX_NAME_LENGTH);
    if (text === null) return bad('target.guildName must be at most 100 characters');
    target.guildName = text === '' ? null : text;
  }
  if (parentId !== undefined) {
    if (parentId !== null && !isNumericId(parentId)) return bad('target.parentId must be a numeric string or null');
    target.parentId = parentId;
  }
  if (parentName !== undefined) {
    if (parentName === null) target.parentName = null;
    else {
      const text = cleanText(parentName, MAX_NAME_LENGTH);
      if (text === null) return bad('target.parentName must be at most 100 characters');
      target.parentName = text === '' ? null : text;
    }
  }
  if (channelType !== undefined) {
    if (typeof channelType !== 'number' || !Number.isInteger(channelType) || channelType < 0 || channelType > 64) {
      return bad('target.channelType must be a small non-negative integer');
    }
    target.channelType = channelType;
  }
  if (iconUrl !== undefined) target.iconUrl = isDiscordCdnUrl(iconUrl) && iconUrl.length <= 500 ? iconUrl : null;
  return good(target);
}

// ---- export settings ----------------------------------------------------------------------------------------------------

const ISO_UTC = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?Z$/;

/** Epoch ms of an ISO 8601 UTC time (`2026-10-06T00:00:00.000Z`), or null when the text is not a real such time. */
function parseIsoUtc(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = ISO_UTC.exec(value);
  if (!match) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  // Date.parse rolls "2026-02-31" over into March; a real calendar time round-trips.
  return new Date(ms).toISOString().startsWith(match[1]) ? ms : null;
}

const isValidCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_COUNT;

const isExportFormat = (value: unknown): value is ExportFormat => typeof value === 'string' && (EXPORT_FORMATS as readonly string[]).includes(value);

const CONTENT_KEYS = ['includeBots', 'includeSystem', 'includeReactions', 'includeEmbeds'] as const;

/** The common settings, or an item's own settings: every field present and valid, `from` not after `to`. */
export function validateExportSettings(raw: unknown): Checked<ExportSettings> {
  if (!isRecord(raw)) return bad('settings must be an object');
  const { count, from, to, format, htmlTheme, includeAttachments, includeThreads, incremental, content } = raw;

  if (count !== null && !isValidCount(count)) return bad('count must be null or an integer between 1 and 1000000');
  const fromMs = from === null ? null : parseIsoUtc(from);
  if (from !== null && fromMs === null) return bad('from must be null or an ISO 8601 UTC time');
  const toMs = to === null ? null : parseIsoUtc(to);
  if (to !== null && toMs === null) return bad('to must be null or an ISO 8601 UTC time');
  if (fromMs !== null && toMs !== null && fromMs > toMs) return bad('from must not be after to');
  if (!isExportFormat(format)) return bad('format is not a known export format');
  if (htmlTheme !== 'dark' && htmlTheme !== 'light') return bad('htmlTheme must be "dark" or "light"');
  if (typeof includeAttachments !== 'boolean') return bad('includeAttachments must be a boolean');
  if (typeof includeThreads !== 'boolean') return bad('includeThreads must be a boolean');
  if (typeof incremental !== 'boolean') return bad('incremental must be a boolean');
  if (!isRecord(content)) return bad('content must be an object');
  for (const key of CONTENT_KEYS) if (typeof content[key] !== 'boolean') return bad(`content.${key} must be a boolean`);

  return good({
    count: count as number | null,
    from: from as string | null,
    to: to as string | null,
    format,
    htmlTheme,
    includeAttachments,
    includeThreads,
    incremental,
    content: {
      includeBots: content.includeBots as boolean,
      includeSystem: content.includeSystem as boolean,
      includeReactions: content.includeReactions as boolean,
      includeEmbeds: content.includeEmbeds as boolean,
    },
  });
}

/** Stored export settings merged over the defaults field by field; a bad field falls back to its default. */
export function normalizeExportSettings(raw: unknown): ExportSettings {
  const out = structuredClone(DEFAULT_EXPORT_SETTINGS) as ExportSettings;
  if (!isRecord(raw)) return out;
  if (raw.count === null || isValidCount(raw.count)) out.count = raw.count;
  const fromMs = raw.from === null ? null : parseIsoUtc(raw.from);
  const toMs = raw.to === null ? null : parseIsoUtc(raw.to);
  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    // contradictory range: keep the defaults (no range) rather than guess which end is right
  } else {
    if (fromMs !== null) out.from = raw.from as string;
    if (toMs !== null) out.to = raw.to as string;
  }
  if (isExportFormat(raw.format)) out.format = raw.format;
  if (raw.htmlTheme === 'dark' || raw.htmlTheme === 'light') out.htmlTheme = raw.htmlTheme;
  if (typeof raw.includeAttachments === 'boolean') out.includeAttachments = raw.includeAttachments;
  if (typeof raw.includeThreads === 'boolean') out.includeThreads = raw.includeThreads;
  if (typeof raw.incremental === 'boolean') out.incremental = raw.incremental;
  if (isRecord(raw.content)) {
    for (const key of CONTENT_KEYS) {
      const value = raw.content[key];
      if (typeof value === 'boolean') out.content[key] = value;
    }
  }
  return out;
}

// ---- app settings -------------------------------------------------------------------------------------------------------

const BOOLEAN_SETTINGS = ['showButtons', 'showQueuedIndicator', 'zipAll', 'dateInFileName', 'notifyOnComplete'] as const;
const LANGUAGES: readonly string[] = ['auto', 'ko', 'en'] satisfies AppSettings['language'][];

function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > 64) return false;
  if (value === 'auto') return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const isConsentTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * The stored app settings merged over `DEFAULT_APP_SETTINGS` (the common settings merged field by field too); a missing or
 * invalid field falls back to its default.
 */
export function normalizeSettings(raw: unknown): AppSettings {
  const out = structuredClone(DEFAULT_APP_SETTINGS) as AppSettings;
  if (!isRecord(raw)) return out;
  out.common = normalizeExportSettings(raw.common);
  for (const key of BOOLEAN_SETTINGS) {
    const value = raw[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  if (typeof raw.folderName === 'string') {
    const folder = sanitizeFolderName(raw.folderName);
    if (folder !== '') out.folderName = folder;
  }
  if (isTimeZone(raw.timeZone)) out.timeZone = raw.timeZone;
  if (typeof raw.language === 'string' && LANGUAGES.includes(raw.language)) out.language = raw.language as AppSettings['language'];
  if (raw.consentAt === null || isConsentTime(raw.consentAt)) out.consentAt = raw.consentAt;
  return out;
}

/**
 * A `settings/patch` payload: a shallow patch, `common` replaced whole. Known keys are validated (booleans, `common` as a full
 * valid `ExportSettings`, a folder name that is non-empty after sanitising and cut to 60 characters, 'auto' or an IANA time
 * zone, 'auto'/'ko'/'en', null or a finite consent time); unknown keys are ignored.
 */
export function validateSettingsPatch(raw: unknown): Checked<Partial<AppSettings>> {
  if (!isRecord(raw)) return bad('patch must be an object');
  const patch: Partial<AppSettings> = {};
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case 'common': {
        const common = validateExportSettings(value);
        if (!common.ok) return bad(`common: ${common.message}`);
        patch.common = common.value;
        break;
      }
      case 'showButtons':
      case 'showQueuedIndicator':
      case 'zipAll':
      case 'dateInFileName':
      case 'notifyOnComplete':
        if (typeof value !== 'boolean') return bad(`${key} must be a boolean`);
        patch[key] = value;
        break;
      case 'folderName': {
        const folder = typeof value === 'string' && value.length <= MAX_RAW_TEXT ? sanitizeFolderName(value) : '';
        if (folder === '') return bad('folderName must not be empty once forbidden characters are removed');
        patch.folderName = folder;
        break;
      }
      case 'timeZone':
        if (!isTimeZone(value)) return bad('timeZone must be "auto" or an IANA time zone');
        patch.timeZone = value;
        break;
      case 'language':
        if (typeof value !== 'string' || !LANGUAGES.includes(value)) return bad('language must be "auto", "ko" or "en"');
        patch.language = value as AppSettings['language'];
        break;
      case 'consentAt':
        if (value !== null && !isConsentTime(value)) return bad('consentAt must be null or a time in epoch milliseconds');
        patch.consentAt = value;
        break;
      default:
        break; // unknown keys are ignored
    }
  }
  return good(patch);
}

// ---- queue --------------------------------------------------------------------------------------------------------------

type LastResult = NonNullable<QueueItem['lastResult']>;

function validateLastResult(raw: unknown): LastResult | null {
  if (!isRecord(raw)) return null;
  const { status, message, at } = raw;
  if (status !== 'partial' && status !== 'failed' && status !== 'cancelled') return null;
  if (typeof message !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) return null;
  return { status, message: truncate(message, MAX_MESSAGE_LENGTH), at };
}

/** An item sent by the popup's gear (`queue/upsert`): the key is the channel id, `settings` null (common) or valid. */
export function validateQueueItem(raw: unknown): Checked<QueueItem> {
  if (!isRecord(raw)) return bad('item must be an object');
  const target = validateTarget(raw.target);
  if (!target.ok) return target;
  if (raw.key !== target.value.channelId) return bad('item.key must equal item.target.channelId');
  let settings: ExportSettings | null = null;
  if (raw.settings !== null) {
    const checked = validateExportSettings(raw.settings);
    if (!checked.ok) return bad(`item.settings: ${checked.message}`);
    settings = checked.value;
  }
  if (typeof raw.addedAt !== 'number' || !Number.isFinite(raw.addedAt) || raw.addedAt < 0) return bad('item.addedAt must be a time in epoch milliseconds');
  const item: QueueItem = { key: target.value.channelId, target: target.value, settings, addedAt: raw.addedAt };
  if (raw.lastResult === null) item.lastResult = null;
  else if (raw.lastResult !== undefined) {
    const lastResult = validateLastResult(raw.lastResult);
    if (lastResult === null) return bad('item.lastResult is malformed');
    item.lastResult = lastResult;
  }
  return good(item);
}

/** Stored queue: invalid items are dropped, a bad `settings` becomes null (follow the common settings), duplicates collapse. */
export function normalizeQueue(raw: unknown): QueueItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const items: QueueItem[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const target = validateTarget(entry.target);
    if (!target.ok || entry.key !== target.value.channelId || seen.has(entry.key)) continue;
    seen.add(entry.key);
    const settings = entry.settings === null ? null : validateExportSettings(entry.settings);
    const item: QueueItem = {
      key: entry.key,
      target: target.value,
      settings: settings === null ? null : settings.ok ? settings.value : null,
      addedAt: typeof entry.addedAt === 'number' && Number.isFinite(entry.addedAt) ? entry.addedAt : 0,
    };
    const lastResult = validateLastResult(entry.lastResult);
    if (lastResult !== null) item.lastResult = lastResult;
    items.push(item);
  }
  return items;
}

// ---- groups (the check state of the category and server buttons, and the names of the popup's tree) -----------------------------

/** The longest `iconUrl` a stored group may carry (a 64 px CDN icon URL is well under 150 characters). */
const MAX_ICON_URL_LENGTH = 500;

/**
 * Stored `LOCAL.groups(accountId)`, a `Record<groupId, GroupInfo>`: an entry that is not a guild or category group of a numeric
 * guild, or whose key is not a numeric id, is dropped; its channel ids keep only numeric strings (each once); a bad `updatedAt`
 * becomes 0. `name` (a cleaned text of at most 100 characters, or null) and, for a guild group only, `iconUrl` (a Discord CDN URL
 * or null) are kept when they are valid and left out when they are not (an older record has neither).
 */
export function normalizeGroups(raw: unknown): Record<string, GroupInfo> {
  const groups: Record<string, GroupInfo> = {};
  if (!isRecord(raw)) return groups;
  for (const [groupId, entry] of Object.entries(raw)) {
    if (!isNumericId(groupId) || !isRecord(entry)) continue;
    const { kind, guildId, channelIds, updatedAt, name, iconUrl } = entry;
    if ((kind !== 'guild' && kind !== 'category') || !isNumericId(guildId) || !Array.isArray(channelIds)) continue;
    const group: GroupInfo = {
      kind,
      guildId,
      channelIds: [...new Set(channelIds.filter(isNumericId))],
      updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : 0,
    };
    if (name === null) group.name = null;
    else {
      const label = cleanText(name, MAX_NAME_LENGTH);
      if (label !== null && label !== '') group.name = label;
    }
    if (kind === 'guild') {
      if (iconUrl === null) group.iconUrl = null;
      else if (isDiscordCdnUrl(iconUrl) && iconUrl.length <= MAX_ICON_URL_LENGTH) group.iconUrl = iconUrl;
    }
    groups[groupId] = group;
  }
  return groups;
}

/**
 * Stored `LOCAL.groupSettings(accountId)`, a `Record<groupId, ExportSettings>` (server id or category id -> the settings its
 * channels follow): an entry whose key is not a numeric id or whose settings are not a complete valid `ExportSettings` is
 * dropped (that group then follows the next level up, like an item whose own settings went bad).
 */
export function normalizeGroupSettings(raw: unknown): Record<string, ExportSettings> {
  const settings: Record<string, ExportSettings> = {};
  if (!isRecord(raw)) return settings;
  for (const [groupId, entry] of Object.entries(raw)) {
    if (!isNumericId(groupId)) continue;
    const checked = validateExportSettings(entry);
    if (checked.ok) settings[groupId] = checked.value;
  }
  return settings;
}

/** What `queue/setGroupSettings` asks for, validated. */
export interface GroupSettingsRequest {
  kind: 'guild' | 'category';
  guildId: string;
  groupId: string;
  /** The settings the group's channels will follow, or null = take the group's own settings away. */
  settings: ExportSettings | null;
}

/**
 * A `queue/setGroupSettings` message: `kind` "guild" or "category", numeric-string ids, and `settings` either null or complete valid
 * export settings (the same checks as the common settings). A server group is identified by the server's id, so for kind "guild"
 * `groupId` must equal `guildId`.
 */
export function validateGroupSettingsRequest(raw: Record<string, unknown>): Checked<GroupSettingsRequest> {
  const { kind, guildId, groupId, settings } = raw;
  if (kind !== 'guild' && kind !== 'category') return bad('kind must be "guild" or "category"');
  if (!isNumericId(guildId)) return bad('guildId must be a numeric string');
  if (!isNumericId(groupId)) return bad('groupId must be a numeric string');
  if (kind === 'guild' && groupId !== guildId) return bad('the groupId of a server group is the guildId');
  if (settings === null) return good({ kind, guildId, groupId, settings: null });
  const checked = validateExportSettings(settings);
  if (!checked.ok) return bad(`settings: ${checked.message}`);
  return good({ kind, guildId, groupId, settings: checked.value });
}

/** The most keys one `queue/removeMany` may name. */
export const MAX_REMOVE_KEYS = 5000;

/** The `keys` of a `queue/removeMany`: an array of at most 5000 numeric-string channel ids; returned without duplicates. */
export function validateKeyList(raw: unknown): Checked<string[]> {
  if (!Array.isArray(raw)) return bad('keys must be an array');
  if (raw.length > MAX_REMOVE_KEYS) return bad(`keys must have at most ${MAX_REMOVE_KEYS} entries`);
  const keys = new Set<string>();
  for (const key of raw) {
    if (!isNumericId(key)) return bad('every key must be a numeric string');
    keys.add(key);
  }
  return good([...keys]);
}

// ---- history and incremental markers ------------------------------------------------------------------------------------

/** A history entry sent by the engine (`engine/itemDone`). Entries of the same shape that are already stored pass too. */
export function validateHistoryEntry(raw: unknown): Checked<HistoryEntry> {
  if (!isRecord(raw)) return bad('entry must be an object');
  const { id, accountId, finishedAt, status, messageCount, files, error } = raw;
  if (typeof id !== 'string' || id === '' || id.length > 100) return bad('entry.id must be a short non-empty string');
  if (!isNumericId(accountId)) return bad('entry.accountId must be a numeric string');
  const target = validateTarget(raw.target);
  if (!target.ok) return bad(`entry.${target.message}`);
  const settings = validateExportSettings(raw.settings);
  if (!settings.ok) return bad(`entry.settings: ${settings.message}`);
  if (typeof finishedAt !== 'number' || !Number.isFinite(finishedAt) || finishedAt < 0) return bad('entry.finishedAt must be a time in epoch milliseconds');
  if (status !== 'done' && status !== 'partial' && status !== 'failed') return bad('entry.status must be done, partial or failed');
  if (typeof messageCount !== 'number' || !Number.isInteger(messageCount) || messageCount < 0) return bad('entry.messageCount must be a non-negative integer');
  if (!Array.isArray(files) || files.length > 20_000) return bad('entry.files must be an array');
  if (error !== null && typeof error !== 'string') return bad('entry.error must be a string or null');

  // The history lives in storage.local (10 MB for everything): a chat with thousands of attachments keeps its first files only.
  const cleanFiles: HistoryEntry['files'] = [];
  for (const file of files) {
    if (cleanFiles.length >= MAX_HISTORY_FILES) break;
    if (!isRecord(file) || typeof file.filename !== 'string' || file.filename.length > MAX_FILENAME_LENGTH) continue;
    const downloadId = file.downloadId;
    if (downloadId !== null && !(typeof downloadId === 'number' && Number.isInteger(downloadId) && downloadId >= 0)) continue;
    cleanFiles.push({ filename: file.filename, downloadId });
  }
  return good({
    id,
    accountId,
    target: target.value,
    settings: settings.value,
    finishedAt,
    status,
    messageCount,
    files: cleanFiles,
    error: error === null ? null : truncate(error, MAX_MESSAGE_LENGTH),
  });
}

/** Stored history: invalid entries are dropped, ids are unique, newest first as stored, at most 200. */
export function normalizeHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const entries: HistoryEntry[] = [];
  for (const candidate of raw) {
    const checked = validateHistoryEntry(candidate);
    if (!checked.ok || seen.has(checked.value.id)) continue;
    seen.add(checked.value.id);
    entries.push(checked.value);
    if (entries.length >= MAX_HISTORY_ENTRIES) break;
  }
  return entries;
}

/** Stored `Record<channelId, messageId>`: only numeric-string pairs survive. */
export function normalizeLastExported(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(raw)) return out;
  for (const [channelId, messageId] of Object.entries(raw)) {
    if (isNumericId(channelId) && isNumericId(messageId)) out[channelId] = messageId;
  }
  return out;
}

// ---- job progress -------------------------------------------------------------------------------------------------------

const ITEM_STATUSES: readonly string[] = ['waiting', 'running', 'paused', 'done', 'partial', 'failed', 'cancelled'] satisfies ItemStatus[];
const ITEM_PHASES: readonly string[] = ['resolving', 'messages', 'threads', 'attachments', 'writing', 'saving'] satisfies ItemPhase[];
const ERROR_KINDS: readonly string[] = [
  'auth',
  'forbidden',
  'not-found',
  'rate-limited',
  'blocked',
  'network',
  'server',
  'cancelled',
  'interrupted',
  'unknown',
] satisfies ErrorKind[];

/** An item that is finished for good: it never goes back to waiting or running. */
export const isTerminalStatus = (status: ItemStatus): boolean =>
  status === 'done' || status === 'partial' || status === 'failed' || status === 'cancelled';

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

function mergeItem(stored: ItemProgress, raw: Record<string, unknown> | undefined): ItemProgress {
  if (!raw) return stored;
  const status = typeof raw.status === 'string' && ITEM_STATUSES.includes(raw.status) ? (raw.status as ItemStatus) : stored.status;
  // A finished item stays finished: a late or confused progress message cannot bring it back to life.
  if (isTerminalStatus(stored.status) && !isTerminalStatus(status)) return stored;

  const merged: ItemProgress = { ...stored, status };
  if (raw.phase === null || (typeof raw.phase === 'string' && ITEM_PHASES.includes(raw.phase))) merged.phase = raw.phase as ItemPhase | null;
  if (isCount(raw.fetched)) merged.fetched = raw.fetched;
  if (raw.expected === null || isCount(raw.expected)) merged.expected = raw.expected;
  if (raw.error === null) merged.error = null;
  else if (isRecord(raw.error) && typeof raw.error.kind === 'string' && ERROR_KINDS.includes(raw.error.kind) && typeof raw.error.message === 'string') {
    merged.error = { kind: raw.error.kind as ErrorKind, message: truncate(raw.error.message, MAX_MESSAGE_LENGTH) };
  }
  if (Array.isArray(raw.files) && raw.files.length <= 2000) {
    merged.files = raw.files.filter((file): file is string => typeof file === 'string' && file.length <= MAX_FILENAME_LENGTH);
  }
  return merged;
}

/**
 * Applies an `engine/progress` snapshot to the stored job. The worker keeps what it created itself (job id, account, start
 * time, ZIP flag, the items and their labels); from the engine it takes the running/paused state and, per item (matched by
 * key), status, phase, counts, error and files. Returns null when the snapshot belongs to another job or is not a job.
 */
export function mergeProgress(stored: JobState, incoming: unknown): JobState | null {
  if (!isRecord(incoming) || incoming.jobId !== stored.jobId || !Array.isArray(incoming.items)) return null;
  const byKey = new Map<string, Record<string, unknown>>();
  for (const raw of incoming.items) if (isRecord(raw) && typeof raw.key === 'string') byKey.set(raw.key, raw);
  const paused = incoming.state === 'paused';
  return {
    ...stored,
    state: paused ? 'paused' : 'running',
    pausedReason: paused ? 'rate-limit' : null,
    items: stored.items.map((item) => mergeItem(item, byKey.get(item.key))),
  };
}

/** A stored `JobState`, or null when it is not one (the worker is its only writer: this is a shape check, not a repair). */
export function normalizeJob(raw: unknown): JobState | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.jobId !== 'string' || typeof raw.accountId !== 'string' || !Array.isArray(raw.items)) return null;
  if (!['running', 'paused', 'done', 'cancelled', 'failed'].includes(raw.state as string)) return null;
  return raw as unknown as JobState;
}
