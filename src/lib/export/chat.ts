import type { ChatKind, ChatTarget, ErrorKind, ExportSettings, ItemPhase } from '@/shared/types';
import { EXPORT_FORMATS } from '@/shared/types';
import { avatarUrl, channelIconUrl, guildIconUrl } from '../discord/cdn';
import { DiscordApiError, isAbortError } from '../discord/client';
import type { DiscordClient } from '../discord/client';
import { collectMessagesResult, MAX_COLLECT_COUNT } from '../discord/collect';
import { abortedError, throwIfAborted } from '../discord/rateLimit';
import { compareSnowflakes, isSnowflake, snowflakeTimeOrNull, sortByIdAsc } from '../discord/snowflake';
import { listThreads } from '../discord/threads';
import { channelKindOf, chatKindOf } from '../discord/tree';
import type { Channel, GuildSummary, Message, Role, Snowflake, User } from '../discord/types';
import { safeUrl } from '../markdown/url';
import { buildNameResolver, displayName } from '../message';
import { itemAttachmentPath, itemFilePath, itemStem, zipAttachmentPath, zipEntryPath } from './filename';
import { loadExportFormat } from './formats';
import { applyContentOptions } from './formats/content';
import type { Chunk, ExportLocale, ExportTarget, WriterOptions, WriterSummary } from './types';

/** One file the engine has to save: where (alone / inside the ZIP) and what. */
export interface ChatOutput {
  /** Path of the file when it is saved on its own, relative to the downloads folder: `<folder>/<name>.<ext>`. */
  path: string;
  /** Path of the file inside the ZIP (`Server/Category/channel.ext`, `Direct Messages/name.ext`, ...). */
  zipPath: string;
  mime: string;
  /** Text formats give a string (a `Uint8Array` only when the text is too long for one string), XLSX the bytes. */
  data: string | Uint8Array;
}

/** An attachment the export file links to: the engine downloads `url` and saves it at `path` (alone) / `zipPath` (in the ZIP). */
export interface ChatAttachment {
  id: string;
  /** The signed CDN URL as the messages carried it: fresh right after the pages were fetched, stale after a few hours. */
  url: string;
  /** The original file name. */
  filename: string;
  path: string;
  zipPath: string;
}

export interface ChatError {
  kind: ErrorKind;
  /** Localised, short, never contains the authorization value. */
  message: string;
}

export interface ExportChatResult {
  /**
   * One file per chat; a forum / media chat gives one per post, a text channel with `includeThreads` one for the channel plus one
   * per thread. Empty when there was nothing to write: an incremental export without new messages, a forum without posts, a failure
   * before any message was reached.
   */
  outputs: ChatOutput[];
  /** Messages written into the outputs (after the content options: dropped bots / system messages are not counted). */
  messageCount: number;
  /**
   * The newest message id this export reached (also messages that the content options dropped), for the next incremental export.
   * Only set when `status` is 'done': a partial or failed export must never advance the incremental marker.
   */
  lastMessageId: string | null;
  /** Empty unless `settings.includeAttachments`. */
  attachments: ChatAttachment[];
  status: 'done' | 'partial' | 'failed';
  /**
   * The first thing that went wrong; null when `status` is 'done'. A problem with the threads of a chat (or the posts of a forum)
   * starts with "Threads: " ("Posts: "; "스레드: " / "게시글: " in Korean): the chat itself may have been saved in full.
   */
  error: ChatError | null;
}

export interface ExportChatContext {
  /** User cancel: `exportChat` rejects with an `AbortError` (nothing of this chat is returned). */
  signal?: AbortSignal;
  /** IANA zone, already resolved from 'auto'. Used for the timestamps in the files and for the date in the file name. */
  timeZone: string;
  locale: ExportLocale;
  /** Newest message id of the previous finished export of this chat; the lower bound when `settings.incremental`. */
  lastExportedId: string | null;
  dateInFileName: boolean;
  /** The downloads sub-folder (`AppSettings.folderName`); sanitised per segment here. */
  folderName: string;
  /**
   * Phase changes and message counts: `('resolving', 0)`, `('messages', n)` ..., `('threads', n)`, `('writing', n)`. An exception
   * thrown by the callback is ignored (it never fails the export).
   */
  onProgress?: (phase: ItemPhase, fetched: number) => void;
  /**
   * The files will go into a ZIP (`AppSettings.zipAll`): links to saved attachments inside the files are relative to the file's
   * place in the ZIP instead of its place as a single file. Default false.
   */
  zip?: boolean;
  /** Entry paths already taken in the ZIP by earlier chats of the job; `zipPath`s avoid them and are added to the set. */
  usedZipPaths?: Set<string>;
  /** Clock for the export time in the headers and the date in the names. Default `() => new Date()`. */
  now?: () => Date;
  /** Waits of the thread search (index not ready). Default: a real, abortable timer. Injected by tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------------------------------------------------

const REASONS: Record<ExportLocale, Partial<Record<ErrorKind, string>>> = {
  en: {
    auth: 'Not signed in to Discord (401).',
    forbidden: 'No access to this channel (403).',
    'not-found': 'Channel not found or deleted (404).',
    'rate-limited': 'Discord rate limit reached; try again later.',
    blocked: 'Discord (or a network filter in front of it) blocked the requests; try again later.',
    network: 'Network error while contacting Discord.',
    server: 'Discord server error; try again later.',
  },
  ko: {
    auth: 'Discord에 로그인되어 있지 않습니다 (401).',
    forbidden: '이 채널에 접근할 수 없습니다 (403).',
    'not-found': '채널을 찾을 수 없거나 삭제되었습니다 (404).',
    'rate-limited': 'Discord 요청 한도에 도달했습니다. 잠시 후 다시 시도하세요.',
    blocked: 'Discord(또는 앞단의 네트워크 필터)가 요청을 차단했습니다. 잠시 후 다시 시도하세요.',
    network: 'Discord에 연결하는 중 네트워크 오류가 발생했습니다.',
    server: 'Discord 서버 오류입니다. 잠시 후 다시 시도하세요.',
  },
};

/** Shown when Discord asked for a wait that is too long to sit through (the client refused to wait it out). */
const RATE_LIMIT_WAIT: Record<ExportLocale, (minutes: number) => string> = {
  en: (minutes) => `Discord asked us to wait ${minutes} min - try again later.`,
  ko: (minutes) => `Discord에서 ${minutes}분 동안 기다려 달라고 요청했습니다. 나중에 다시 시도하세요.`,
};

/** Put in front of a problem that concerns the threads / posts of a chat, so that "no access" is not read as "the chat itself was not saved". */
const SCOPE_LABEL: Record<ExportLocale, { threads: string; posts: string }> = {
  en: { threads: 'Threads', posts: 'Posts' },
  ko: { threads: '스레드', posts: '게시글' },
};

const NO_MESSAGES: Record<ExportLocale, string> = {
  en: 'This channel has no messages to export.',
  ko: '이 채널에는 내보낼 메시지가 없습니다.',
};

const INVALID_SETTINGS: Record<ExportLocale, (detail: string) => string> = {
  en: (detail) => `Invalid export settings: ${detail}`,
  ko: (detail) => `내보내기 설정이 올바르지 않습니다: ${detail}`,
};

/** Total on purpose: an unexpected locale value falls back to English instead of throwing in the middle of a run. */
const inLocale = <T>(table: Record<ExportLocale, T>, locale: ExportLocale): T => (locale === 'ko' ? table.ko : table.en);

const ERROR_KINDS: Record<Exclude<DiscordApiError['kind'], 'aborted'>, ErrorKind> = {
  auth: 'auth',
  forbidden: 'forbidden',
  'not-found': 'not-found',
  blocked: 'blocked',
  'rate-limited': 'rate-limited',
  network: 'network',
  server: 'server',
  'not-allowed': 'unknown',
  unknown: 'unknown',
};

/** The shared `ErrorKind` and a localised message for whatever went wrong. */
export function describeChatError(error: unknown, locale: ExportLocale): ChatError {
  if (error instanceof DiscordApiError && error.kind !== 'aborted') {
    const kind = ERROR_KINDS[error.kind];
    if (kind === 'rate-limited' && error.retryAfterMs !== undefined && error.retryAfterMs >= 60_000) {
      return { kind, message: inLocale(RATE_LIMIT_WAIT, locale)(Math.ceil(error.retryAfterMs / 60_000)) };
    }
    return { kind, message: inLocale(REASONS, locale)[kind] ?? error.message };
  }
  return { kind: 'unknown', message: error instanceof Error ? error.message : String(error) };
}

/** Failures that will hit the next request just the same: going on would only produce one more error per thread. */
function isSystemic(error: ChatError): boolean {
  return error.kind === 'auth' || error.kind === 'rate-limited' || error.kind === 'blocked' || error.kind === 'network' || error.kind === 'server';
}

/** A cancel (or any failure that happened because of one) is not a result: it is thrown to the caller as an `AbortError`. */
function rethrowAbort(error: unknown, signal: AbortSignal | undefined): void {
  if (isAbortError(error)) throw error;
  if (signal?.aborted === true) throw abortedError();
}

// ---------------------------------------------------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------------------------------------------------

interface MessageWindow {
  count: number | null;
  fromMs: number | null;
  toMs: number | null;
  /** The exclusive incremental lower bound that applies (null when not incremental or when there was no previous export). */
  afterId: Snowflake | null;
}

/** The message window the settings ask for, or what is wrong with them (a programmer / storage error, not a user error). */
function windowOf(settings: ExportSettings, ctx: ExportChatContext): MessageWindow | string {
  const { count } = settings;
  if (count !== null && !(Number.isInteger(count) && count >= 1 && count <= MAX_COLLECT_COUNT)) {
    return `the message count ${String(count)} is not an integer from 1 to ${MAX_COLLECT_COUNT}`;
  }
  if (!(EXPORT_FORMATS as readonly string[]).includes(settings.format)) return `unknown format ${String(settings.format)}`;
  const fromMs = settings.from === null ? null : Date.parse(settings.from);
  const toMs = settings.to === null ? null : Date.parse(settings.to);
  if (fromMs !== null && Number.isNaN(fromMs)) return 'the start of the range is not a date';
  if (toMs !== null && Number.isNaN(toMs)) return 'the end of the range is not a date';
  if (fromMs !== null && toMs !== null && fromMs > toMs) return 'the start of the range is later than its end';
  const afterId = settings.incremental && ctx.lastExportedId !== null && isSnowflake(ctx.lastExportedId) ? ctx.lastExportedId : null;
  return { count, fromMs, toMs, afterId };
}

// ---------------------------------------------------------------------------------------------------------------------
// channel and guild metadata
// ---------------------------------------------------------------------------------------------------------------------

interface GuildMeta {
  name: string | null;
  icon: string | null;
  /** Every channel of the guild (categories included): category names, thread parents, `#channel` mentions. */
  channels: Channel[];
  roles: Role[];
}

/**
 * Guild lookups cost three requests: they are made once per guild and client (a job) and shared by all its chats. A lookup that
 * failed for a reason that may pass (network, 5xx, rate limit, block page) is not remembered: the next chat of the guild asks again.
 */
const guildCache = new WeakMap<DiscordClient, Map<Snowflake, Promise<GuildMeta>>>();

/** Failures of an optional lookup that are worth asking again for; "forbidden" or "not found" would answer the same next time. */
const TRANSIENT_KINDS: ReadonlySet<DiscordApiError['kind']> = new Set(['network', 'server', 'rate-limited', 'blocked']);

/**
 * Runs an optional lookup: only a cancel and a rejected authorization stop the export, any other failure leaves the value out
 * (`onTransient` is told when that failure may pass).
 */
async function optional<T>(lookup: () => Promise<T>, fallback: T, signal: AbortSignal | undefined, onTransient: () => void): Promise<T> {
  try {
    return await lookup();
  } catch (error) {
    rethrowAbort(error, signal);
    if (error instanceof DiscordApiError) {
      if (error.kind === 'auth') throw error;
      if (TRANSIENT_KINDS.has(error.kind)) onTransient();
    }
    return fallback;
  }
}

function loadGuild(client: DiscordClient, guildId: Snowflake, signal: AbortSignal | undefined): Promise<GuildMeta> {
  let perClient = guildCache.get(client);
  if (perClient === undefined) {
    perClient = new Map();
    guildCache.set(client, perClient);
  }
  const cached = perClient.get(guildId);
  if (cached !== undefined) return cached;

  let transient = false;
  const noteTransient = (): void => {
    transient = true;
  };
  const loading = (async (): Promise<GuildMeta> => {
    const guild = await optional<GuildSummary | null>(() => client.getGuild(guildId, signal), null, signal, noteTransient);
    const channels = await optional<Channel[]>(() => client.getGuildChannels(guildId, signal), [], signal, noteTransient);
    const roles = await optional<Role[]>(() => client.getGuildRoles(guildId, signal), [], signal, noteTransient);
    return { name: guild?.name ?? null, icon: guild?.icon ?? null, channels, roles };
  })();
  perClient.set(guildId, loading);
  // A lookup that was cancelled or rejected, or that only half worked for a transient reason, must not be remembered.
  const forget = perClient;
  loading.then(
    () => {
      if (transient) forget.delete(guildId);
    },
    () => forget.delete(guildId),
  );
  return loading;
}

const recipientsOf = (channel: Channel): User[] =>
  Array.isArray(channel.recipients) ? channel.recipients.filter((user) => user !== null && typeof user === 'object') : [];

/** The name a chat shows: a channel's / thread's name, a DM partner's display name, or a group DM's name / member list. */
function chatNameOf(channel: Channel, fallback: string): string {
  const own = typeof channel.name === 'string' ? channel.name.trim() : '';
  if (channel.type === 1) {
    const partner = recipientsOf(channel)[0];
    return (partner === undefined ? '' : displayName(partner)) || own || fallback;
  }
  if (channel.type === 3) {
    const members = recipientsOf(channel)
      .map(displayName)
      .filter((name) => name !== '')
      .join(', ');
    return own || members || fallback;
  }
  return own || fallback;
}

/** Icon shown in the header of an HTML export: the server's, or the DM partner's / group's. Only Discord CDN URLs ever load. */
function iconOf(channel: Channel, meta: GuildMeta | null, fallback: string | null | undefined): string | null {
  const partner = recipientsOf(channel)[0];
  let icon: string | null = null;
  if (meta !== null && channel.guild_id !== undefined) icon = guildIconUrl(channel.guild_id, meta.icon);
  else if (channel.type === 3) icon = channelIconUrl(channel.id, channel.icon) ?? (partner === undefined ? null : avatarUrl(partner));
  else if (channel.type === 1) icon = partner === undefined ? null : avatarUrl(partner);
  if (icon !== null) return icon;
  const own = typeof fallback === 'string' ? safeUrl(fallback) : null;
  return own !== null && own.startsWith('https://') ? own : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// units (one output file each)
// ---------------------------------------------------------------------------------------------------------------------

interface Unit {
  target: ExportTarget;
  /** Oldest -> newest, before the content options. */
  messages: Message[];
  /** The walk was cut short by a failure: the file holds only the newest messages that were reached. */
  interrupted: boolean;
  /** A forum / media post (it goes into a folder of its forum inside a ZIP). */
  forumPost: boolean;
  /** The chat's own channel (not one of its threads): its file is written even when it is empty. */
  main: boolean;
}

/** Why a thread can be left out without asking Discord for its messages: nothing in it can be inside the window. */
function threadOutsideWindow(thread: Channel, win: MessageWindow): boolean {
  const last = typeof thread.last_message_id === 'string' && isSnowflake(thread.last_message_id) ? thread.last_message_id : null;
  if (last !== null) {
    // Discord says `last_message_id` may point at a deleted message: it is at least as new as the newest real one.
    if (win.afterId !== null && compareSnowflakes(last, win.afterId) <= 0) return true;
    const lastMs = snowflakeTimeOrNull(last);
    if (win.fromMs !== null && lastMs !== null && lastMs < win.fromMs) return true;
  }
  // Every message of a thread is newer than the thread's own id.
  const createdMs = snowflakeTimeOrNull(thread.id);
  return win.toMs !== null && createdMs !== null && createdMs > win.toMs;
}

const MAX_STRING_UNITS = 64 * 1024 * 1024;
const encoder = new TextEncoder();

/** The output chunks as one value: a string, or bytes when they are binary (XLSX) or too long for a string. */
function joinChunks(chunks: readonly Chunk[]): string | Uint8Array {
  if (chunks.length === 1 && typeof chunks[0] !== 'string') return chunks[0];
  if (chunks.every((chunk) => typeof chunk === 'string')) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (total <= MAX_STRING_UNITS) return chunks.join('');
  }
  const parts = chunks.map((chunk) => (typeof chunk === 'string' ? encoder.encode(chunk) : chunk));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const BATCH = 100;

/** The newest id of `messages` (ids that are not plain numbers are ignored), compared with `newest` so far. */
function newerId(newest: Snowflake | null, messages: readonly Message[]): Snowflake | null {
  let result = newest;
  for (const message of messages) {
    if (typeof message?.id === 'string' && isSnowflake(message.id) && (result === null || compareSnowflakes(message.id, result) > 0)) result = message.id;
  }
  return result;
}

interface AttachmentRef {
  id: string;
  url: string;
  filename: string;
}

/** The downloadable attachments of a message (those of forwarded snapshots included): an id and an http(s) URL are required. */
function attachmentsOf(message: Message): AttachmentRef[] {
  const found: AttachmentRef[] = [];
  const add = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue;
      const { id, url, filename } = item as { id?: unknown; url?: unknown; filename?: unknown };
      const safe = typeof url === 'string' ? safeUrl(url) : null;
      if (typeof id !== 'string' || id === '' || safe === null) continue;
      found.push({ id, url: safe, filename: typeof filename === 'string' ? filename : '' });
    }
  };
  add(message?.attachments);
  if (Array.isArray(message?.message_snapshots)) for (const snapshot of message.message_snapshots) add(snapshot?.message?.attachments);
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------
// exportChat
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Exports ONE chat (docs/PLAN.md §6): resolves the channel and its guild, collects the messages (`collectMessagesResult`:
 * the newest `count` inside the range, after the previous export when incremental), finds the threads when asked (forum /
 * media channels are nothing but threads; a text channel's threads with `includeThreads`), and writes one file per unit in
 * the chosen format. Nothing is saved here: the files, their paths (alone and inside a ZIP) and the attachments to download
 * come back for the engine to save.
 *
 * - `target.kind` is corrected from the channel type the API reports (1 dm, 3 group-dm, 10 / 11 / 12 thread, 15 / 16 forum).
 * - A failure after some messages were collected does not throw: the collected part is written with the partial marker in the
 *   file name and header and the result is `partial` (with the first error); with nothing collected it is `failed`. Failures that
 *   hit every request alike (401, rate limit, block page, network, 5xx) stop the remaining threads, the others do not.
 * - A user cancel (`ctx.signal`) rejects with an `AbortError`.
 * - Messages are requested strictly one after the other, paced by the client (`createDiscordClient`'s page gap).
 */
export async function exportChat(client: DiscordClient, target: ChatTarget, settings: ExportSettings, ctx: ExportChatContext): Promise<ExportChatResult> {
  throwIfAborted(ctx.signal);
  try {
    return await run(client, target, settings, ctx);
  } catch (error) {
    rethrowAbort(error, ctx.signal);
    // Whatever else escapes (a bug, an unexpected API shape) is the chat's failure, not the job's.
    return failedResult(describeChatError(error, ctx.locale));
  }
}

function failedResult(error: ChatError): ExportChatResult {
  return { outputs: [], messageCount: 0, lastMessageId: null, attachments: [], status: 'failed', error };
}

async function run(client: DiscordClient, target: ChatTarget, settings: ExportSettings, ctx: ExportChatContext): Promise<ExportChatResult> {
  const { signal, locale } = ctx;
  /** A failing observer (the engine's own progress callback) must not fail the export it observes. */
  const notify = (phase: ItemPhase, fetched: number): void => {
    try {
      ctx.onProgress?.(phase, fetched);
    } catch {
      // ignored on purpose
    }
  };
  const exportedAt = (ctx.now ?? (() => new Date()))();
  const win = windowOf(settings, ctx);
  if (typeof win === 'string') return failedResult({ kind: 'unknown', message: inLocale(INVALID_SETTINGS, locale)(win) });

  // 1. The channel and its guild --------------------------------------------------------------------------------------
  notify('resolving', 0);
  let channel: Channel;
  let meta: GuildMeta | null = null;
  try {
    channel = await client.getChannel(target.channelId, signal);
    if (chatKindOf(channel.type) === null) return failedResult({ kind: 'unknown', message: inLocale(NO_MESSAGES, locale) });
    if (typeof channel.guild_id === 'string') meta = await loadGuild(client, channel.guild_id, signal);
  } catch (error) {
    rethrowAbort(error, signal);
    return failedResult(describeChatError(error, locale));
  }
  const kind: ChatKind = chatKindOf(channel.type) ?? target.kind;

  const byId = new Map<Snowflake, Channel>((meta?.channels ?? []).map((c) => [c.id, c]));
  const guildName = meta?.name ?? target.guildName;
  const channelName = chatNameOf(channel, target.channelName);
  const parent = typeof channel.parent_id === 'string' ? byId.get(channel.parent_id) : undefined;
  /** The category: of the channel itself, or for a thread the category of its parent channel (the DOM's `parentName` is the fallback). */
  const categoryName = ((): string | null => {
    if (kind === 'dm' || kind === 'group-dm') return null;
    if (kind === 'thread') return typeof parent?.parent_id === 'string' ? (byId.get(parent.parent_id)?.name ?? null) : null;
    return parent?.name ?? target.parentName ?? null;
  })();

  const mainTarget: ExportTarget = {
    channelId: channel.id,
    kind: channelKindOf(channel.type),
    channelName,
    guildId: channel.guild_id ?? null,
    guildName: channel.guild_id === undefined ? null : guildName,
    categoryName,
    parentChannelName: kind === 'thread' ? (parent?.name ?? target.parentName ?? null) : null,
    topic: typeof channel.topic === 'string' && channel.topic !== '' ? channel.topic : null,
    iconUrl: iconOf(channel, meta, target.iconUrl),
  };

  // 2. Messages: the chat itself, then its threads --------------------------------------------------------------------
  const units: Unit[] = [];
  const state = { fetched: 0, firstError: null as ChatError | null };
  const noteError = (error: ChatError): void => {
    state.firstError ??= error;
  };

  /** Collects one unit; returns what stopped it early, if anything. */
  const collectInto = async (unitTarget: ExportTarget, flags: { forumPost: boolean; main: boolean }): Promise<ChatError | null> => {
    const base = state.fetched;
    const result = await collectMessagesResult(client, unitTarget.channelId, {
      count: win.count,
      fromMs: win.fromMs,
      toMs: win.toMs,
      afterId: win.afterId,
      signal,
      onProgress: (n) => notify('messages', base + n),
    });
    state.fetched = base + result.messages.length;
    notify('messages', state.fetched);
    units.push({ target: unitTarget, messages: result.messages, interrupted: result.failed, ...flags });
    return result.failed ? describeChatError(result.error, locale) : null;
  };

  if (kind !== 'forum') {
    const problem = await collectInto(mainTarget, { forumPost: false, main: true });
    if (problem !== null) noteError(problem);
  }

  const wantsThreads = kind === 'forum' || (kind === 'guild-channel' && settings.includeThreads && (channel.type === 0 || channel.type === 5));
  if (wantsThreads && (state.firstError === null || !isSystemic(state.firstError))) {
    notify('threads', state.fetched);
    const listing = await listThreads(client, channel.id, { signal, sleep: ctx.sleep });
    const label = inLocale(SCOPE_LABEL, locale)[kind === 'forum' ? 'posts' : 'threads'];
    const scoped = (error: ChatError): ChatError => ({ kind: error.kind, message: `${label}: ${error.message}` });
    if (listing.error !== null) noteError(scoped(describeChatError(listing.error, locale)));
    for (const thread of sortByIdAsc(listing.threads)) {
      throwIfAborted(signal);
      if (threadOutsideWindow(thread, win)) continue;
      const threadTarget: ExportTarget = {
        channelId: thread.id,
        kind: 'thread',
        channelName: typeof thread.name === 'string' && thread.name.trim() !== '' ? thread.name.trim() : thread.id,
        guildId: channel.guild_id ?? null,
        guildName,
        categoryName,
        parentChannelName: channelName,
        topic: null,
        iconUrl: mainTarget.iconUrl,
      };
      const problem = await collectInto(threadTarget, { forumPost: kind === 'forum', main: false });
      if (problem !== null) {
        noteError(scoped(problem));
        if (isSystemic(problem)) break;
      }
    }
  }

  // 3. Files ----------------------------------------------------------------------------------------------------------
  throwIfAborted(signal);
  notify('writing', state.fetched);
  const format = await loadExportFormat(settings.format);
  const names = buildNameResolver();
  names.setChannels({ ...Object.fromEntries((meta?.channels ?? []).map((c) => [c.id, c.name ?? ''])), [channel.id]: channelName });
  names.setRoles(Object.fromEntries((meta?.roles ?? []).map((role) => [role.id, role.name])));
  for (const unit of units) names.addMessages(unit.messages);

  const outputs: ChatOutput[] = [];
  const attachments: ChatAttachment[] = [];
  const usedFiles = new Set<string>();
  const usedZip = ctx.usedZipPaths ?? new Set<string>();
  let written = 0;
  let newest: Snowflake | null = null;

  /** The file stem of a unit, different (case-insensitively) from every file of this chat so far: two threads may share a title. */
  const stemFor = (unit: Unit): string => {
    const nameOptions = { locale, dateInFileName: ctx.dateInFileName, date: exportedAt, timeZone: ctx.timeZone, partial: unit.interrupted };
    const taken = (stem: string): boolean => usedFiles.has(itemFilePath(ctx.folderName, stem, format.extension).toLowerCase());
    let stem = itemStem(unit.target, format.extension, nameOptions);
    for (let n = 1; taken(stem); n += 1) {
      const suffix = n === 1 ? ` [${unit.target.channelId}]` : ` [${unit.target.channelId}] (${n})`;
      stem = itemStem({ ...unit.target, channelName: `${unit.target.channelName}${suffix}` }, format.extension, nameOptions);
    }
    usedFiles.add(itemFilePath(ctx.folderName, stem, format.extension).toLowerCase());
    return stem;
  };

  for (const unit of units) {
    // The marker covers every message that was reached, also those the content options drop.
    newest = newerId(newest, unit.messages);
    const kept = applyContentOptions(unit.messages, settings.content);
    // A thread without messages to show is not worth a file; neither is a chat without anything new, nor a failure that got nowhere.
    if (kept.length === 0 && (!unit.main || unit.interrupted || win.afterId !== null)) continue;

    const stem = stemFor(unit);
    const path = itemFilePath(ctx.folderName, stem, format.extension);
    const zipPath = zipEntryPath(unit.target, format.extension, usedZip, { forumPost: unit.forumPost, partial: unit.interrupted, locale });

    // Saved attachments: one copy per attachment id, named after the file that shows it.
    const attachmentPaths = new Map<string, string>();
    if (settings.includeAttachments) {
      for (const message of kept) {
        for (const attachment of attachmentsOf(message)) {
          if (attachmentPaths.has(attachment.id)) continue;
          const alone = itemAttachmentPath(ctx.folderName, stem, attachment.id, attachment.filename);
          const zipped = zipAttachmentPath(zipPath, attachment.id, attachment.filename);
          attachmentPaths.set(attachment.id, ctx.zip === true ? zipped.relative : alone.relative);
          attachments.push({ id: attachment.id, url: attachment.url, filename: attachment.filename, path: alone.path, zipPath: zipped.path });
        }
      }
    }

    const options: WriterOptions = {
      after: settings.from,
      before: settings.to,
      limit: settings.count,
      htmlTheme: settings.htmlTheme === 'light' ? 'light' : 'dark',
      locale,
      timeZone: ctx.timeZone,
      incremental: win.afterId !== null,
      partial: unit.interrupted,
      content: settings.content,
      ...(settings.includeAttachments ? { attachmentPaths } : {}),
    };
    const writer = format.createWriter({ target: unit.target, options, exportedAt, names });
    const chunks: Chunk[] = [...writer.start()];
    for (let from = 0; from < kept.length; from += BATCH) chunks.push(...writer.write(kept.slice(from, from + BATCH)));
    const summary: WriterSummary = {
      messageCount: kept.length,
      firstTimestamp: kept[0]?.timestamp ?? null,
      lastTimestamp: kept[kept.length - 1]?.timestamp ?? null,
    };
    chunks.push(...writer.end(summary));

    outputs.push({ path, zipPath, mime: format.mime, data: joinChunks(chunks) });
    written += kept.length;
  }

  const error = state.firstError;
  const status = error === null ? 'done' : outputs.length > 0 ? 'partial' : 'failed';
  return { outputs, messageCount: written, lastMessageId: status === 'done' ? newest : null, attachments, status, error };
}
