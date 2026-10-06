import type { Channel, GuildSummary, Message, Role, Snowflake, User } from './types';

export type DiscordErrorKind =
  | 'auth' // 401: authorization value missing / expired
  | 'forbidden' // 403 whose Discord JSON error code says "no access" (50001 Missing Access, 50013 Missing Permissions, 50009).
  | 'not-found' // 404, or Discord error code 10003 (Unknown Channel)
  | 'blocked' // 400 / 403 without a JSON error body (Cloudflare / anti-abuse page). Retried after 30 / 60 / 120 s, then reported.
  | 'rate-limited' // 429 and retries exhausted, or a wait longer than we are willing to sit through
  | 'network' // fetch threw (offline, DNS, ...)
  | 'server' // 5xx after retries
  | 'aborted' // AbortSignal fired
  | 'not-allowed' // the request is not on the transport allow-list: refused locally, nothing was sent
  | 'unknown';

export class DiscordApiError extends Error {
  readonly kind: DiscordErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  /** Discord's own JSON error code (e.g. 50001), when the response body carried one. */
  readonly code?: number;

  constructor(
    kind: DiscordErrorKind,
    message: string,
    opts: { status?: number; retryAfterMs?: number; code?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    // A cancelled request looks like any other cancelled web API call to callers that only check `error.name`.
    this.name = kind === 'aborted' ? 'AbortError' : 'DiscordApiError';
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.code = opts.code;
  }
}

/** True for every way a cancelled operation can surface: our aborted `DiscordApiError` and the platform's `AbortError`. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof DiscordApiError) return error.kind === 'aborted';
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

export interface GetMessagesOptions {
  /** Return messages older than this id (exclusive). */
  before?: Snowflake;
  /** Return messages newer than this id (exclusive). */
  after?: Snowflake;
  /** 1..100 (Discord hard limit). Default 50 server-side; we always pass it explicitly. */
  limit?: number;
}

export interface MyMember {
  roles: Snowflake[];
  /** Guild-level communication/timeouts etc. are ignored. */
  user?: User;
}

/** One page of `GET /channels/{id}/threads/search` (25 threads per page, most recently active first). */
export interface ThreadSearchQuery {
  /** `true` lists archived threads, `false` the active ones. */
  archived: boolean;
  /** Offset of the first thread; Discord answers offsets up to 9975. */
  offset: number;
}

export type ThreadSearchPage =
  | { status: 'ready'; threads: Channel[]; hasMore: boolean }
  /** HTTP 202: Discord has not indexed the channel yet. Ask again after `retryAfterMs`. */
  | { status: 'indexing'; retryAfterMs: number | null };

export interface RefreshedUrl {
  original: string;
  refreshed: string;
}

/**
 * The ONLY door to Discord data. `LiveDiscordClient` (real API over an injectable `HttpTransport`) and the mock client
 * (tests / demo) implement it. Every method accepts an AbortSignal and rejects with `DiscordApiError` (never a raw fetch
 * error); a cancelled call rejects with an error whose `kind` is 'aborted' (and `name` 'AbortError').
 */
export interface DiscordClient {
  readonly kind: 'live' | 'mock';

  /** `GET /users/@me` */
  getMe(signal?: AbortSignal): Promise<User>;
  /** `GET /channels/{id}`: type, name, `parent_id`, `guild_id`, topic; recipients for DMs. */
  getChannel(channelId: Snowflake, signal?: AbortSignal): Promise<Channel>;
  /** `GET /guilds/{id}`: the guild's name and icon (other fields are present but not relied on). */
  getGuild(guildId: Snowflake, signal?: AbortSignal): Promise<GuildSummary>;
  /** `GET /guilds/{id}/channels` — categories + channels, metadata only. */
  getGuildChannels(guildId: Snowflake, signal?: AbortSignal): Promise<Channel[]>;
  /** `GET /guilds/{id}/roles` — role names for `@role` mentions. */
  getGuildRoles(guildId: Snowflake, signal?: AbortSignal): Promise<Role[]>;
  /** The current user's member object in the guild (role ids). Not needed by exports; used for permission checks. */
  getMyMember(guildId: Snowflake, signal?: AbortSignal): Promise<MyMember>;
  /**
   * One raw page, exactly like the API: at most 100 messages, **newest first**.
   * (`after` pages are also returned newest-first within the page.)
   */
  getMessages(channelId: Snowflake, opts?: GetMessagesOptions, signal?: AbortSignal): Promise<Message[]>;
  /**
   * One page of the thread search of a channel (forum / media posts, or the threads of a text channel).
   * Prefer `listThreads`, which pages through both archived states and waits out an index that is not ready.
   */
  searchThreads(channelId: Snowflake, query: ThreadSearchQuery, signal?: AbortSignal): Promise<ThreadSearchPage>;
  /**
   * `POST /attachments/refresh-urls` for ONE batch of at most 50 CDN URLs. Prefer `refreshAttachmentUrls`, which batches.
   * Urls Discord does not answer for are simply missing from the result.
   */
  refreshAttachmentUrls(urls: readonly string[], signal?: AbortSignal): Promise<RefreshedUrl[]>;
}
