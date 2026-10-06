import { DiscordApiError, isAbortError } from './client';
import type { DiscordClient, ThreadSearchPage, ThreadSearchQuery } from './client';
import { THREAD_SEARCH_MAX_OFFSET } from './constants';
import { abortableSleep, throwIfAborted } from './rateLimit';
import type { Channel, Snowflake } from './types';

/** How often one search request is repeated while Discord answers "index not yet available" (HTTP 202). */
export const MAX_INDEX_RETRIES = 5;
/** Used when a 202 does not say how long to wait. */
const INDEX_RETRY_DEFAULT_MS = 3_000;
/** A hint longer than this is not sat through (the search is optional data). */
const INDEX_RETRY_MAX_MS = 30_000;

export interface ListThreadsOptions {
  signal?: AbortSignal;
  /** Injected in tests; the default is a real, abortable timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface ThreadListResult {
  /** Active threads first, then archived ones, each group most recently active first. Unique by id; `parent_id` is always set. */
  threads: Channel[];
  /** What ended the listing early (a failed request, or an index that stayed "not ready"); null when everything was listed. */
  error: DiscordApiError | null;
  /** The listing stopped at Discord's offset limit (9,975) while it said there were more threads. */
  truncated: boolean;
}

type ReadyPage = Extract<ThreadSearchPage, { status: 'ready' }>;

function asApiError(error: unknown): DiscordApiError {
  return error instanceof DiscordApiError
    ? error
    : new DiscordApiError('unknown', error instanceof Error ? error.message : String(error), { cause: error });
}

/**
 * One page of the search, with the 202 ("index not yet available") wait built in. Returns the error instead of throwing it;
 * a cancelled `signal` still throws.
 */
async function fetchReadyPage(
  client: DiscordClient,
  channelId: Snowflake,
  query: ThreadSearchQuery,
  signal: AbortSignal | undefined,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<{ page: ReadyPage } | { error: DiscordApiError }> {
  for (let retries = 0; ; retries += 1) {
    throwIfAborted(signal);
    let page: ThreadSearchPage;
    try {
      page = await client.searchThreads(channelId, query, signal);
    } catch (e) {
      if (isAbortError(e) || signal?.aborted === true) throw e;
      return { error: asApiError(e) };
    }
    if (page.status === 'ready') return { page };
    if (retries >= MAX_INDEX_RETRIES) {
      return { error: new DiscordApiError('unknown', 'Discord has not finished indexing this channel for thread search; try again later.', { status: 202 }) };
    }
    await sleep(Math.min(page.retryAfterMs ?? INDEX_RETRY_DEFAULT_MS, INDEX_RETRY_MAX_MS), signal);
  }
}

/**
 * Every thread of a channel that its thread search lists (a forum / media channel's posts, or the threads of a text channel):
 * `GET /channels/{id}/threads/search?archived=<false|true>&sort_by=last_message_time&sort_order=desc&limit=25&offset=<n>`
 * for both archived states, following `has_more` up to Discord's offset limit (docs/PLAN.md §6.4).
 *
 * - Discord indexes a channel lazily. HTTP 202 ("index not yet available") is waited out (the response's `retry_after`) and the
 *   same request repeated, at most `MAX_INDEX_RETRIES` times.
 * - A failure never throws away what was found: the threads collected so far are returned together with the error. Only a
 *   cancelled `signal` rejects (cancellation is not a result).
 */
export async function listThreads(client: DiscordClient, channelId: Snowflake, opts: ListThreadsOptions = {}): Promise<ThreadListResult> {
  const { signal } = opts;
  const sleep = opts.sleep ?? abortableSleep;
  const threads: Channel[] = [];
  const seen = new Set<Snowflake>();
  let truncated = false;

  for (const archived of [false, true]) {
    let offset = 0;
    for (;;) {
      const outcome = await fetchReadyPage(client, channelId, { archived, offset }, signal, sleep);
      if ('error' in outcome) return { threads, error: outcome.error, truncated };

      const { page } = outcome;
      for (const thread of page.threads) {
        if (seen.has(thread.id)) continue;
        seen.add(thread.id);
        threads.push({ ...thread, parent_id: thread.parent_id ?? channelId });
      }
      // An empty page ends the walk even if `has_more` claims otherwise: the offset would never advance.
      if (!page.hasMore || page.threads.length === 0) break;
      offset += page.threads.length;
      if (offset > THREAD_SEARCH_MAX_OFFSET) {
        truncated = true;
        break;
      }
    }
  }
  return { threads, error: null, truncated };
}
