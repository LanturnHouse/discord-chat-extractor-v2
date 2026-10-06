import { isTransportRequestAllowed } from '@/shared/allowlist';
import { API_BASE_PATH } from '@/shared/defaults';
import { API_MESSAGE_LIMIT, REFRESH_URLS_BATCH_SIZE, THREAD_SEARCH_MAX_OFFSET, THREAD_SEARCH_PAGE_SIZE } from './constants';
import { DiscordApiError } from './client';
import type {
  DiscordClient,
  DiscordErrorKind,
  GetMessagesOptions,
  MyMember,
  RefreshedUrl,
  ThreadSearchPage,
  ThreadSearchQuery,
} from './client';
import {
  BLOCKED_RETRY_WAITS_MS,
  DEFAULT_PAGE_GAP,
  MAX_RATE_LIMIT_RETRIES,
  MAX_RATE_LIMIT_WAIT_MS,
  MAX_TRANSIENT_RETRIES,
  Pacer,
  RateLimiter,
  SerialQueue,
  abortableSleep,
  abortedError,
  backoffDelayMs,
  parseRateLimitHeaders,
  parseRetryAfter,
  throwIfAborted,
} from './rateLimit';
import type { GapRange } from './rateLimit';
import { createFetchTransport, describePath } from './transport';
import type { HttpTransport, TransportResponse } from './transport';
import type { Channel, GuildSummary, Message, Role, Snowflake, User } from './types';

const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_ERROR_DETAIL_LENGTH = 200;
/** Discord's `code` for "Index not yet available. Try again later" (HTTP 202 from the thread search). */
const INDEX_NOT_READY_CODE = 110000;
/** Discord error codes behind a 403 that really mean "this account may not read that" (Missing Access, Missing Permissions, verification level). */
const NO_ACCESS_CODES: ReadonlySet<number> = new Set([50001, 50013, 50009]);
/** "Unknown Channel": reported as `not-found` whatever the HTTP status. */
const UNKNOWN_CHANNEL_CODE = 10003;
/** A wait shorter than this is not worth telling anybody about. */
const PAUSE_NOTICE_MIN_MS = 2_000;
const AUTHORIZATION_PATTERN = /^[\x21-\x7e]+$/;
const ID_PATTERN = /^\d{1,25}$/;

/** Why the client is standing still (`LiveDiscordClientOptions.onPause`). */
export interface PauseEvent {
  /** `rate-limit`: Discord (or its CDN) asked us to wait. `blocked`: a block page was answered; the request is retried after the wait. */
  reason: 'rate-limit' | 'blocked';
  waitMs: number;
  /** Epoch ms (of the injected clock) at which the wait ends. */
  resumeAt: number;
}

export interface LiveDiscordClientOptions {
  /**
   * The raw `Authorization` value. Resolved before every attempt (retries included) so a refreshed value is picked up.
   * It is never logged, stored or put into an error message.
   */
  getAuthorization: () => Promise<string | null> | string | null;
  /**
   * Called when Discord rejects the authorization value (HTTP 401), at most once per distinct value, with the value that was
   * actually sent for the failing request: the stored value may have been replaced since, and only the rejected one should be discarded.
   */
  onAuthError?: (usedAuthorization: string) => void;
  /** How a request travels. Default: `createFetchTransport()` (fetch to https://discord.com). */
  transport?: HttpTransport;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Jitter source, returns [0, 1). */
  random?: () => number;
  /** Clock for rate-limit bookkeeping (epoch ms). */
  now?: () => number;
  /** Pause between two consecutive paged requests (message pages, thread-search pages, URL refresh batches). Default `DEFAULT_PAGE_GAP` (0.7 - 1.5 s). */
  pageGap?: GapRange;
  /** The client is about to wait out a rate limit / block page for `event.waitMs`. Only waits of two seconds or more are announced. */
  onPause?: (event: PauseEvent) => void;
  /** The wait announced through `onPause` is over (or was aborted). */
  onResume?: () => void;
}

function assertId(value: string, label: string): void {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new DiscordApiError('unknown', `Invalid ${label}: expected a numeric id.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Discord's numeric error `code` from a JSON error body (0 means "generic" and is dropped). */
function errorCodeOf(body: unknown): number | undefined {
  return isRecord(body) && typeof body.code === 'number' && Number.isInteger(body.code) && body.code !== 0 ? body.code : undefined;
}

/**
 * Error kind of a response that is neither a success nor a block page (see `kindOfBlockPage`):
 *  - 401 => auth;
 *  - 404, or Discord's "Unknown Channel" code => not-found;
 *  - 403 is only "forbidden" when Discord's own error code says the account has no access; any other 403 (an anti-abuse
 *    code such as 40333, an unknown one) says nothing about this channel's permissions => unknown.
 */
function kindOfResponse(status: number, code: number | undefined): DiscordErrorKind {
  if (status === 401) return 'auth';
  if (code === UNKNOWN_CHANNEL_CODE || status === 404) return 'not-found';
  if (status === 403) return code !== undefined && NO_ACCESS_CODES.has(code) ? 'forbidden' : 'unknown';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server';
  return 'unknown';
}

/** Discord answers every API error with a JSON `{ message, code }`; a 400 / 403 without one comes from Cloudflare or a proxy. */
function isBlockPage(status: number, errorBody: unknown): boolean {
  return (status === 400 || status === 403) && !isRecord(errorBody);
}

/** Discord's `{ message, code }` error body as a short string; '' when there is nothing useful. */
function describeErrorBody(body: unknown): string {
  if (!isRecord(body)) return '';
  const message = typeof body.message === 'string' ? body.message.replace(/\s+/g, ' ').trim() : '';
  const code = typeof body.code === 'number' && body.code !== 0 ? ` (code ${body.code})` : '';
  const text = message.length > MAX_ERROR_DETAIL_LENGTH ? `${message.slice(0, MAX_ERROR_DETAIL_LENGTH)}...` : message;
  return `${text}${code}`.trim();
}

function retryAfterMsOf(body: unknown): number | null {
  if (!isRecord(body) || typeof body.retry_after !== 'number') return null;
  return Number.isFinite(body.retry_after) && body.retry_after > 0 ? Math.ceil(body.retry_after * 1000) : null;
}

/** HTTP 202 / code 110000 and no `threads` array: Discord has not indexed the channel for search yet. */
function isIndexNotReady(status: number, body: unknown): boolean {
  if (isRecord(body) && Array.isArray(body.threads)) return false;
  return status === 202 || (isRecord(body) && body.code === INDEX_NOT_READY_CODE);
}

interface RequestSpec {
  method: 'GET' | 'POST';
  /** Path below the Discord origin, query included. */
  path: string;
  body?: string;
  /** A paged request: it waits for the configured gap after the previous paged request. */
  paced?: boolean;
  /**
   * The endpoint may not be meant for user tokens, so a 401 there says nothing about the authorization value: still
   * reported as 'auth' to the caller, but `onAuthError` is not fired, and a block page is not waited out.
   */
  softAuth?: boolean;
}

interface Answer {
  status: number;
  body: unknown;
}

function pathnameOf(path: string): string {
  const cut = path.indexOf('?');
  return cut === -1 ? path : path.slice(0, cut);
}

/** Real Discord API client: GET (plus the one allow-listed POST), strictly serial, rate-limit aware. Never logs or reports the authorization value. */
export class LiveDiscordClient implements DiscordClient {
  readonly kind = 'live' as const;

  private readonly getAuthorization: LiveDiscordClientOptions['getAuthorization'];
  private readonly onAuthError: ((used: string) => void) | undefined;
  private readonly transport: HttpTransport;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly queue = new SerialQueue();
  private readonly limiter: RateLimiter;
  private readonly pacer: Pacer;
  private readonly onPause: ((event: PauseEvent) => void) | undefined;
  private readonly onResume: (() => void) | undefined;
  /** The last authorization value reported through `onAuthError`: the same rejected value is reported once, a different one again. */
  private lastReportedAuth: string | null = null;
  /** What the most recent whole-client hold was for. */
  private holdReason: PauseEvent['reason'] = 'rate-limit';

  constructor(opts: LiveDiscordClientOptions) {
    this.getAuthorization = opts.getAuthorization;
    this.onAuthError = opts.onAuthError;
    this.transport = opts.transport ?? createFetchTransport();
    this.sleep = opts.sleep ?? abortableSleep;
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.limiter = new RateLimiter(this.now);
    this.pacer = new Pacer(this.now, this.random, opts.pageGap ?? DEFAULT_PAGE_GAP);
    this.onPause = opts.onPause;
    this.onResume = opts.onResume;
  }

  async getMe(signal?: AbortSignal): Promise<User> {
    const body = await this.get('/users/@me', undefined, signal);
    if (!isRecord(body) || typeof body.id !== 'string') throw this.unexpected('/users/@me');
    return body as unknown as User;
  }

  async getChannel(channelId: Snowflake, signal?: AbortSignal): Promise<Channel> {
    assertId(channelId, 'channel id');
    const body = await this.get(`/channels/${channelId}`, undefined, signal);
    if (!isRecord(body) || typeof body.id !== 'string') throw this.unexpected('channel');
    return body as unknown as Channel;
  }

  async getGuild(guildId: Snowflake, signal?: AbortSignal): Promise<GuildSummary> {
    assertId(guildId, 'guild id');
    const body = await this.get(`/guilds/${guildId}`, undefined, signal);
    if (!isRecord(body) || typeof body.id !== 'string') throw this.unexpected('guild');
    return body as unknown as GuildSummary;
  }

  async getGuildChannels(guildId: Snowflake, signal?: AbortSignal): Promise<Channel[]> {
    assertId(guildId, 'guild id');
    return this.expectArray(await this.get(`/guilds/${guildId}/channels`, undefined, signal), 'guild channels') as Channel[];
  }

  async getGuildRoles(guildId: Snowflake, signal?: AbortSignal): Promise<Role[]> {
    assertId(guildId, 'guild id');
    return this.expectArray(await this.get(`/guilds/${guildId}/roles`, undefined, signal), 'guild roles') as Role[];
  }

  async getMyMember(guildId: Snowflake, signal?: AbortSignal): Promise<MyMember> {
    assertId(guildId, 'guild id');
    let body: unknown;
    try {
      body = await this.get(`/users/@me/guilds/${guildId}/member`, undefined, signal, { softAuth: true });
    } catch (e) {
      // That endpoint is documented for OAuth2 tokens; fall back to the classic one for anything that looks like "not for you".
      const fallBack = e instanceof DiscordApiError && ['auth', 'forbidden', 'not-found', 'blocked', 'unknown'].includes(e.kind);
      if (!fallBack) throw e;
      body = await this.get(`/guilds/${guildId}/members/@me`, undefined, signal);
    }
    if (!isRecord(body)) throw this.unexpected('guild member');
    const roles = Array.isArray(body.roles) ? body.roles.filter((r): r is string => typeof r === 'string') : [];
    const member: MyMember = { roles };
    if (isRecord(body.user) && typeof body.user.id === 'string') member.user = body.user as unknown as User;
    return member;
  }

  async getMessages(channelId: Snowflake, opts: GetMessagesOptions = {}, signal?: AbortSignal): Promise<Message[]> {
    assertId(channelId, 'channel id');
    const query = new URLSearchParams({ limit: String(clampLimit(opts.limit)) });
    if (opts.before !== undefined) {
      assertId(opts.before, 'before id');
      query.set('before', opts.before);
    }
    if (opts.after !== undefined) {
      assertId(opts.after, 'after id');
      query.set('after', opts.after);
    }
    const body = await this.get(`/channels/${channelId}/messages`, query, signal, { paced: true });
    return this.expectArray(body, 'messages') as Message[];
  }

  /**
   * One page of `GET /channels/{id}/threads/search`. Discord indexes a channel lazily: while it has not, the search answers
   * HTTP 202 "Index not yet available" without any `threads`, which is reported as `{ status: 'indexing' }` (not as an
   * empty result) so that the caller can wait and ask again.
   */
  async searchThreads(channelId: Snowflake, query: ThreadSearchQuery, signal?: AbortSignal): Promise<ThreadSearchPage> {
    assertId(channelId, 'channel id');
    const { offset } = query;
    if (!Number.isInteger(offset) || offset < 0 || offset > THREAD_SEARCH_MAX_OFFSET) {
      throw new DiscordApiError('unknown', `Invalid thread search offset: expected an integer from 0 to ${THREAD_SEARCH_MAX_OFFSET}.`);
    }
    // Written out in this order on purpose: it is the request the official client makes.
    const path =
      `${API_BASE_PATH}/channels/${channelId}/threads/search?archived=${query.archived ? 'true' : 'false'}` +
      `&sort_by=last_message_time&sort_order=desc&limit=${THREAD_SEARCH_PAGE_SIZE}&offset=${offset}`;
    const { status, body } = await this.request({ method: 'GET', path, paced: true }, signal);
    if (isIndexNotReady(status, body)) return { status: 'indexing', retryAfterMs: retryAfterMsOf(body) };
    if (!isRecord(body) || !Array.isArray(body.threads)) throw this.unexpected('thread search');
    const threads = body.threads.filter((t): t is Channel => isRecord(t) && typeof t.id === 'string');
    return { status: 'ready', threads, hasMore: body.has_more === true };
  }

  async refreshAttachmentUrls(urls: readonly string[], signal?: AbortSignal): Promise<RefreshedUrl[]> {
    if (urls.length === 0) return [];
    if (urls.length > REFRESH_URLS_BATCH_SIZE) {
      throw new DiscordApiError('unknown', `Too many urls for one refresh request (${urls.length}, at most ${REFRESH_URLS_BATCH_SIZE}).`);
    }
    const { body } = await this.request(
      { method: 'POST', path: `${API_BASE_PATH}/attachments/refresh-urls`, body: JSON.stringify({ attachment_urls: urls }), paced: true },
      signal,
    );
    const list = isRecord(body) && Array.isArray(body.refreshed_urls) ? (body.refreshed_urls as unknown[]) : null;
    if (list === null) throw this.unexpected('attachment url refresh');
    const refreshed: RefreshedUrl[] = [];
    for (const item of list) {
      if (isRecord(item) && typeof item.original === 'string' && typeof item.refreshed === 'string') {
        refreshed.push({ original: item.original, refreshed: item.refreshed });
      }
    }
    return refreshed;
  }

  private async get(
    path: string,
    query: URLSearchParams | undefined,
    signal: AbortSignal | undefined,
    opts: { paced?: boolean; softAuth?: boolean } = {},
  ): Promise<unknown> {
    const queryText = query === undefined ? '' : `?${query.toString()}`;
    const answer = await this.request({ method: 'GET', path: `${API_BASE_PATH}${path}${queryText}`, ...opts }, signal);
    return answer.body;
  }

  private request(spec: RequestSpec, signal: AbortSignal | undefined): Promise<Answer> {
    return this.queue.run(() => this.execute(spec, signal), signal);
  }

  private expectArray(body: unknown, what: string): unknown[] {
    if (!Array.isArray(body)) throw this.unexpected(what);
    return body;
  }

  private unexpected(what: string): DiscordApiError {
    return new DiscordApiError('unknown', `Discord returned an unexpected response for ${what}.`);
  }

  private async execute(spec: RequestSpec, signal: AbortSignal | undefined): Promise<Answer> {
    const { method, path } = spec;
    // Last line of defence for the credential: nothing that is not on the allow-list is ever sent, and nothing is sent before this.
    if (!isTransportRequestAllowed(method, path)) {
      throw new DiscordApiError('not-allowed', `Refusing a request that is not on the allow-list: ${method} ${describePath(path)}`);
    }
    // Every value this call has sent: error text must never contain any of them, even if Discord (or a proxy) echoed one back.
    const used: string[] = [];
    const clean = (text: string): string => used.reduce((out, value) => out.split(value).join('[redacted]'), text);
    const fail = (
      kind: DiscordErrorKind,
      message: string,
      extra: { status?: number; retryAfterMs?: number; code?: number; cause?: unknown } = {},
    ): DiscordApiError => new DiscordApiError(kind, clean(message), extra);

    const pathname = pathnameOf(path);
    let rateLimitRetries = 0;
    let transientRetries = 0;
    let blockedRetries = 0;

    for (;;) {
      throwIfAborted(signal);
      const limitDelay = this.limiter.delayFor(pathname);
      if (limitDelay > MAX_RATE_LIMIT_WAIT_MS) {
        throw fail('rate-limited', `Discord rate limit: would have to wait ${Math.ceil(limitDelay / 1000)} s.`, { retryAfterMs: limitDelay });
      }
      if (limitDelay > 0) await this.holdFor(this.holdReason, limitDelay, signal);
      // After the wait above: the gap since the previous paged request may already have passed while we waited.
      const paceDelay = spec.paced === true ? this.pacer.delay() : 0;
      if (paceDelay > 0) await this.pause(paceDelay, signal);

      // Resolved per attempt, after any wait: a value refreshed while a 429 / back-off wait ran must be the one that is sent.
      const authorization = await this.resolveAuthorization();
      if (!used.includes(authorization)) used.push(authorization);

      const headers: Record<string, string> = { Authorization: authorization };
      if (spec.body !== undefined) headers['Content-Type'] = 'application/json';

      let res: TransportResponse;
      try {
        res = await this.transport({ method, path, headers, ...(spec.body !== undefined ? { body: spec.body } : {}), signal });
      } catch (e) {
        if (spec.paced === true) this.pacer.finished();
        if (signal?.aborted) throw abortedError();
        if (e instanceof DiscordApiError) throw e;
        if (transientRetries < MAX_TRANSIENT_RETRIES) {
          await this.pause(backoffDelayMs(transientRetries++, this.random), signal);
          continue;
        }
        throw fail('network', 'Could not reach Discord (network error).', { cause: e });
      }
      if (spec.paced === true) this.pacer.finished();

      this.limiter.recordResponse(pathname, parseRateLimitHeaders(res.headers));

      if (res.status >= 200 && res.status < 300) {
        const text = await this.readText(res, signal);
        let body: unknown;
        try {
          body = JSON.parse(text) as unknown;
        } catch (e) {
          throw fail('unknown', 'Discord returned an invalid JSON response.', { status: res.status, cause: e });
        }
        return { status: res.status, body };
      }

      // An error body that cannot be read is treated like an empty one: the status alone then decides.
      const errorBody = this.parseJson(await this.readText(res, signal, true));
      const code = errorCodeOf(errorBody);

      if (res.status === 429) {
        const retry = parseRetryAfter(res.headers, errorBody);
        // Recorded even when we give up, so the next request does not run straight into the same limit.
        this.limiter.recordRateLimited(pathname, retry.ms, retry.global);
        this.holdReason = 'rate-limit';
        if (retry.ms > MAX_RATE_LIMIT_WAIT_MS || rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
          throw fail('rate-limited', `Discord rate limit reached (retry in ${Math.ceil(retry.ms / 1000)} s).`, {
            status: 429,
            retryAfterMs: retry.ms,
            code,
          });
        }
        rateLimitRetries++;
        continue; // the wait itself happens at the top of the loop, from the limiter's state
      }

      if (res.status >= 500 && transientRetries < MAX_TRANSIENT_RETRIES) {
        await this.pause(backoffDelayMs(transientRetries++, this.random), signal);
        continue;
      }

      if (isBlockPage(res.status, errorBody)) {
        const wait = BLOCKED_RETRY_WAITS_MS[blockedRetries];
        if (wait !== undefined && spec.softAuth !== true) {
          blockedRetries++;
          // A block page is about the whole connection, not about one route: every request waits.
          this.limiter.holdAll(wait);
          this.holdReason = 'blocked';
          continue;
        }
        throw fail(
          'blocked',
          `Discord (or a proxy in front of it) refused ${method} ${describePath(path)} without an API error (HTTP ${res.status}); this looks like a temporary block, try again later.`,
          { status: res.status },
        );
      }

      const kind = kindOfResponse(res.status, code);
      if (kind === 'auth') this.reportAuthError(spec, authorization);
      const detail = describeErrorBody(errorBody);
      throw fail(kind, `Discord API error ${res.status} for ${method} ${describePath(path)}${detail ? `: ${detail}` : ''}`, { status: res.status, code });
    }
  }

  private reportAuthError(spec: RequestSpec, usedAuthorization: string): void {
    if (spec.softAuth === true || this.lastReportedAuth === usedAuthorization) return;
    this.lastReportedAuth = usedAuthorization;
    try {
      this.onAuthError?.(usedAuthorization);
    } catch {
      // A broken callback must not hide the real 'auth' error from the caller.
    }
  }

  private async resolveAuthorization(): Promise<string> {
    const raw = await this.getAuthorization();
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '') {
      throw new DiscordApiError('auth', 'No Discord authorization available. Open Discord in a browser tab and reload it.');
    }
    if (!AUTHORIZATION_PATTERN.test(value)) throw new DiscordApiError('auth', 'The Discord authorization value is malformed.');
    return value;
  }

  /** Waits out a hold; waits of two seconds or more are announced through `onPause` / `onResume`. */
  private async holdFor(reason: PauseEvent['reason'], ms: number, signal: AbortSignal | undefined): Promise<void> {
    const announce = ms >= PAUSE_NOTICE_MIN_MS;
    if (announce) {
      try {
        this.onPause?.({ reason, waitMs: ms, resumeAt: this.now() + ms });
      } catch {
        // A broken callback must not break the request.
      }
    }
    try {
      await this.pause(ms, signal);
    } finally {
      this.holdReason = 'rate-limit';
      if (announce) {
        try {
          this.onResume?.();
        } catch {
          // See above.
        }
      }
    }
  }

  private async pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
    throwIfAborted(signal);
    try {
      await this.sleep(ms, signal);
    } catch (e) {
      if (signal?.aborted) throw abortedError();
      throw new DiscordApiError('unknown', 'Waiting for Discord was interrupted.', { cause: e });
    }
    throwIfAborted(signal);
  }

  private async readText(res: TransportResponse, signal: AbortSignal | undefined, lenient = false): Promise<string> {
    try {
      return await res.text();
    } catch (e) {
      if (signal?.aborted) throw abortedError();
      if (lenient) return '';
      throw new DiscordApiError('network', 'Could not read the answer from Discord (network error).', { cause: e });
    }
  }

  /** Parsed JSON object, or `undefined` for anything else (empty / non-JSON bodies such as a Cloudflare HTML page). */
  private parseJson(text: string): unknown {
    try {
      const value = JSON.parse(text) as unknown;
      return isRecord(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
}

/** `new LiveDiscordClient(opts)` as a `DiscordClient`: the entry point of the offscreen engine. */
export function createDiscordClient(opts: LiveDiscordClientOptions): DiscordClient {
  return new LiveDiscordClient(opts);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return DEFAULT_MESSAGE_LIMIT;
  return Math.min(API_MESSAGE_LIMIT, Math.max(1, Math.floor(limit)));
}
