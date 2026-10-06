import { isAbortError } from './client';
import type { DiscordClient } from './client';
import { REFRESH_URLS_BATCH_SIZE } from './constants';
import { throwIfAborted } from './rateLimit';

/** Signed CDN URLs older than this should be refreshed before they are downloaded (docs/PLAN.md §6.5); they expire after 24 hours. */
export const URL_REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;

/** Hosts whose attachment URLs `POST /attachments/refresh-urls` can re-sign. Nothing else is ever sent to Discord. */
const REFRESHABLE_HOSTS: ReadonlySet<string> = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** An https URL on Discord's attachment CDN: the only kind the refresh endpoint is asked about. */
export function isRefreshableUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  const parsed = parse(url);
  return parsed !== null && parsed.protocol === 'https:' && REFRESHABLE_HOSTS.has(parsed.hostname.toLowerCase());
}

/** Seconds since the epoch from a hex query parameter (`ex`, `is`), or null. */
function hexSeconds(value: string | null): number | null {
  if (value === null || !/^[0-9a-f]{1,12}$/i.test(value)) return null;
  return parseInt(value, 16);
}

/**
 * Should a signed CDN URL be refreshed before it is used at `nowMs`? Discord signs attachment URLs with an issue time (`is`)
 * and an expiry (`ex`), both hex unix seconds: the URL is stale when it was issued more than `maxAgeMs` ago, or has expired
 * already. A URL without those parameters (or not a URL at all) is never stale: nothing is known about it.
 */
export function isAttachmentUrlStale(url: string, nowMs: number, maxAgeMs: number = URL_REFRESH_AFTER_MS): boolean {
  const parsed = parse(url);
  if (parsed === null) return false;
  const issued = hexSeconds(parsed.searchParams.get('is'));
  if (issued !== null && nowMs - issued * 1000 > maxAgeMs) return true;
  const expires = hexSeconds(parsed.searchParams.get('ex'));
  return expires !== null && expires * 1000 <= nowMs;
}

export interface RefreshUrlsOptions {
  signal?: AbortSignal;
}

/**
 * Fresh signed URLs for expiring CDN attachment URLs: `POST /api/v9/attachments/refresh-urls` with `{ attachment_urls }`, in
 * batches of at most 50. Returns `Map<original, refreshed>`; a URL Discord did not answer for (or that is not a CDN URL, which
 * is never sent) is simply absent, so callers use `map.get(url) ?? url`.
 *
 * Best effort: a failed batch ends the refresh and the result holds what was refreshed before it (the failure itself is
 * reported the usual way, e.g. through the client's `onAuthError`). Only a cancelled `signal` rejects.
 */
export async function refreshAttachmentUrls(
  client: DiscordClient,
  urls: readonly string[],
  opts: RefreshUrlsOptions = {},
): Promise<Map<string, string>> {
  const { signal } = opts;
  const refreshed = new Map<string, string>();
  const wanted = [...new Set(urls.filter((url) => isRefreshableUrl(url)))];

  for (let from = 0; from < wanted.length; from += REFRESH_URLS_BATCH_SIZE) {
    throwIfAborted(signal);
    const batch = wanted.slice(from, from + REFRESH_URLS_BATCH_SIZE);
    const asked = new Set(batch);
    try {
      for (const { original, refreshed: fresh } of await client.refreshAttachmentUrls(batch, signal)) {
        // The answer is only trusted as far as it stays on Discord's CDN: a URL that points elsewhere is never handed out.
        if (asked.has(original) && isRefreshableUrl(fresh)) refreshed.set(original, fresh);
      }
    } catch (e) {
      if (isAbortError(e) || signal?.aborted === true) throw e;
      break;
    }
  }
  return refreshed;
}
