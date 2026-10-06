import { isTransportRequestAllowed } from '@/shared/allowlist';
import { DISCORD_ORIGIN } from './constants';
import { DiscordApiError } from './client';
import type { HeadersLike } from './rateLimit';

/**
 * The HTTP layer of the API client, kept apart so that the offscreen engine (and the tests) decide how a request travels:
 * the default is a `fetch` to https://discord.com, a test passes a fake that answers from memory.
 *
 * A transport only moves one request and returns the raw answer. Allow-list checks, rate limits, retries, error
 * classification and redaction all live in the client.
 */
export interface TransportRequest {
  method: 'GET' | 'POST';
  /** Absolute path below the Discord origin, query string included: `/api/v9/channels/123/messages?limit=100`. */
  path: string;
  /** Always contains `Authorization` (the raw value, no prefix added by us). */
  headers: Record<string, string>;
  /** JSON text of a POST. */
  body?: string;
  signal?: AbortSignal;
}

/** What the client reads of an answer. A `fetch` `Response` satisfies it as is. */
export interface TransportResponse {
  status: number;
  headers: HeadersLike;
  text(): Promise<string>;
}

/** Sends one request. Rejects with whatever the network layer throws; the client turns that into a 'network' error. */
export type HttpTransport = (request: TransportRequest) => Promise<TransportResponse>;

/**
 * True only for URLs that really live under `baseUrl` (same origin, path below the base path).
 * A plain `startsWith` is not enough: `https://discord.com/api/v9.evil.com` starts with the base URL,
 * and `..` segments or `user@host` tricks must be resolved before comparing.
 */
export function isTrustedApiUrl(url: string, baseUrl: string): boolean {
  let target: URL;
  let base: URL;
  try {
    target = new URL(url);
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  if (target.origin !== base.origin || target.username !== '' || target.password !== '') return false;
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  return target.pathname === base.pathname || target.pathname.startsWith(basePath);
}

export interface FetchTransportOptions {
  /** Default: the global `fetch`. Always invoked as a plain function (a detached `fetch` throws "Illegal invocation"). */
  fetch?: typeof fetch;
  /** Default `https://discord.com`. The authorization value is only ever sent to URLs below `${baseUrl}/api/`. */
  baseUrl?: string;
}

/**
 * The default transport: `fetch` with `credentials: 'omit'` (no cookies ride along) and `redirect: 'error'` (the
 * authorization value never follows a redirect to another host).
 *
 * It is the last gate before the network, so it re-checks what the client already checked: the request must be on the
 * transport allow-list (`isTransportRequestAllowed`) and the resulting URL must sit below `${baseUrl}/api/`.
 */
export function createFetchTransport(opts: FetchTransportOptions = {}): HttpTransport {
  const baseUrl = (opts.baseUrl ?? DISCORD_ORIGIN).replace(/\/+$/, '');
  // Not `URL.canParse`: it needs Chrome 120 and older engines do not have it.
  try {
    new URL(baseUrl);
  } catch {
    throw new TypeError('createFetchTransport: baseUrl is not a valid URL.');
  }
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));

  return async (request) => {
    if (!isTransportRequestAllowed(request.method, request.path)) {
      throw new DiscordApiError('not-allowed', `Refusing a request that is not on the allow-list: ${request.method} ${describePath(request.path)}`);
    }
    const url = `${baseUrl}${request.path}`;
    if (!isTrustedApiUrl(url, `${baseUrl}/api`)) {
      throw new DiscordApiError('not-allowed', 'Refusing to send credentials to a URL outside the Discord API.');
    }
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      credentials: 'omit',
      redirect: 'error',
    };
    if (request.body !== undefined) init.body = request.body;
    return doFetch(url, init);
  };
}

/** A path for an error message: the query string (which may carry cursors) is cut off and the length is capped. */
export function describePath(path: string): string {
  const bare = path.split('?', 1)[0] ?? '';
  return bare.length > 120 ? `${bare.slice(0, 120)}...` : bare;
}
