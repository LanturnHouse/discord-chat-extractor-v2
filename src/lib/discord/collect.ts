import { isAbortError } from './client';
import type { DiscordClient } from './client';
import { API_MESSAGE_LIMIT } from './constants';
import { throwIfAborted } from './rateLimit';
import { compareSnowflakes, isSnowflake, normalizeSnowflake, sortByIdAsc, timestampToSnowflake } from './snowflake';
import type { Message, Snowflake } from './types';

/** Largest message count one collection accepts (the same bound as `ExportSettings.count`). */
export const MAX_COLLECT_COUNT = 1_000_000;

export interface CollectOptions {
  /** How many messages at most; the NEWEST ones inside the window are kept. null => no limit. */
  count: number | null;
  /** Inclusive lower bound of the window (unix ms). null => from the beginning of the channel. */
  fromMs: number | null;
  /** Inclusive upper bound of the window (unix ms). null => up to the newest message. */
  toMs: number | null;
  /** Incremental lower bound: only messages with a LARGER id than this (exclusive). null => none. */
  afterId: Snowflake | null;
  signal?: AbortSignal;
  /** Called after every page that added messages, with the number of messages collected so far. */
  onProgress?: (fetched: number) => void;
}

export interface CollectResult {
  /** Oldest -> newest. When `failed` these are the NEWEST messages of the window that were reached before the failure. */
  messages: Message[];
  /** True when a failed request ended the walk early (a cancelled signal never ends up here: it rejects). */
  failed: boolean;
  /** What the failed request threw (`undefined` unless `failed`). */
  error?: unknown;
}

function validate(opts: CollectOptions): void {
  const { count, fromMs, toMs, afterId } = opts;
  if (count !== null && !(Number.isInteger(count) && count >= 1 && count <= MAX_COLLECT_COUNT)) {
    throw new RangeError(`Invalid message count: ${String(count)} is not an integer from 1 to ${MAX_COLLECT_COUNT}.`);
  }
  for (const [name, value] of [['fromMs', fromMs], ['toMs', toMs]] as const) {
    if (value !== null && !Number.isFinite(value)) throw new RangeError(`Invalid ${name}: ${String(value)} is not a time.`);
  }
  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    throw new RangeError('Invalid message range: the start is later than the end.');
  }
  if (afterId !== null && !isSnowflake(afterId)) throw new RangeError('Invalid afterId: expected a numeric message id.');
}

/** The exclusive lower bound `lo` (docs/PLAN.md §6.1): max(SF(from) - 1, afterId); null when the window has no lower bound. */
function lowerBoundOf(opts: CollectOptions): Snowflake | null {
  let lo: Snowflake | null = null;
  if (opts.fromMs !== null) {
    const first = BigInt(timestampToSnowflake(opts.fromMs));
    lo = (first > 0n ? first - 1n : 0n).toString();
  }
  if (opts.afterId !== null) {
    const after = normalizeSnowflake(opts.afterId);
    if (lo === null || compareSnowflakes(after, lo) > 0) lo = after;
  }
  return lo;
}

/** The first `before` cursor: `before` is exclusive, so the first id of the NEXT millisecond keeps every message posted at `toMs`. */
function upperCursorOf(opts: CollectOptions): Snowflake | undefined {
  return opts.toMs === null ? undefined : timestampToSnowflake(opts.toMs + 1);
}

/**
 * Like `collectMessages`, but a failed request does not throw away what was collected: the walk stops and the result carries
 * the messages reached so far together with the error. A cancelled `signal` still rejects (cancellation is not a result).
 */
export async function collectMessagesResult(client: DiscordClient, channelId: Snowflake, opts: CollectOptions): Promise<CollectResult> {
  validate(opts);
  const { count, signal, onProgress } = opts;
  const lo = lowerBoundOf(opts);
  let cursor = upperCursorOf(opts);

  // Nothing can lie between a lower bound that is at or above the first cursor (or a cursor that excludes every id).
  if (cursor !== undefined && (cursor === '0' || (lo !== null && compareSnowflakes(lo, cursor) >= 0))) return { messages: [], failed: false };

  /** Newest -> oldest, strictly decreasing ids. */
  const collected: Message[] = [];
  let oldest: Snowflake | undefined;
  let failure: { error: unknown } | null = null;

  for (;;) {
    throwIfAborted(signal);
    const remaining = count === null ? Number.POSITIVE_INFINITY : count - collected.length;
    if (remaining <= 0) break;
    const limit = Math.min(API_MESSAGE_LIMIT, remaining);

    let page: Message[];
    try {
      page = await client.getMessages(channelId, cursor === undefined ? { limit } : { before: cursor, limit }, signal);
    } catch (e) {
      if (isAbortError(e)) throw e;
      failure = { error: e };
      break;
    }
    throwIfAborted(signal);
    if (!Array.isArray(page) || page.length === 0) break;

    let added = 0;
    let reachedLowerBound = false;
    // Pages are newest-first already; sorting makes the walk independent of that (and of duplicates).
    for (const message of sortByIdAsc(page.filter((m) => m !== null && typeof m === 'object' && isSnowflake(m.id))).reverse()) {
      // Not older than the cursor: the server ignored `before`. Not older than the last accepted one: a duplicate.
      if (cursor !== undefined && compareSnowflakes(message.id, cursor) >= 0) continue;
      if (oldest !== undefined && compareSnowflakes(message.id, oldest) >= 0) continue;
      if (lo !== null && compareSnowflakes(message.id, lo) <= 0) {
        reachedLowerBound = true;
        break;
      }
      // A server that returns more than `limit` must not push the export past the count that was asked for.
      if (count !== null && collected.length >= count) break;
      collected.push(message);
      oldest = message.id;
      added += 1;
    }

    if (added > 0) onProgress?.(collected.length);
    if (reachedLowerBound) break;
    // A page without anything new: the cursor did not advance, so asking again would loop forever.
    if (added === 0) break;
    // A short page is the start of the channel.
    if (page.length < limit) break;
    cursor = oldest;
  }

  const messages = collected.reverse();
  return failure === null ? { messages, failed: false } : { messages, failed: true, error: failure.error };
}

/**
 * The messages of one channel inside a window, oldest -> newest (docs/PLAN.md §6.1).
 *
 * The walk goes BACKWARDS from the newest message (or from `toMs`) with the `before` cursor, at most 100 messages per request,
 * and keeps only messages with `id > lo` where `lo = max(SF(fromMs) - 1, afterId)`. It stops when the count is reached, when a
 * message at or below `lo` shows up, when a page is empty or short (the start of the channel), or when the cursor does not
 * advance. With a count and a range the result is the newest `count` messages INSIDE the range.
 *
 * Throws what the client throws (the first failed request); use `collectMessagesResult` to keep the partial result.
 */
export async function collectMessages(client: DiscordClient, channelId: Snowflake, opts: CollectOptions): Promise<Message[]> {
  const result = await collectMessagesResult(client, channelId, opts);
  if (result.failed) throw result.error;
  return result.messages;
}
