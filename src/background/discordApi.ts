/**
 * The background worker's own Discord API reads: the account check (`users/@me`) and what the category and server buttons need
 * (`guilds/{id}/channels`, `guilds/{id}/roles`, `guilds/{id}`, the account's own member; see guild.ts). Deliberately tiny and
 * independent of src/lib (the engine has its own HTTP transport).
 *
 * Every path must pass `isApiGetPathAllowed` (docs/PLAN.md §8: `users/@me`, `channels/{id}`, `guilds/{id}`,
 * `guilds/{id}/channels`, `guilds/{id}/roles`, `users/@me/guilds/{id}/member`, `guilds/{id}/members/@me`), the method is always
 * GET, nothing is sent but the `Authorization` header (no client-header forging), no cookies, and a redirect is an error so the
 * header can never follow a request to another host. Failures are returned as values; none of them carries the authorization
 * value.
 */
import { isApiGetPathAllowed } from '@/shared';

const API_ORIGIN = 'https://discord.com';
const REQUEST_TIMEOUT_MS = 15_000;

export type ApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; kind: 'forbidden-path' }
  | { ok: false; kind: 'unauthorized'; status: 401 }
  | { ok: false; kind: 'http'; status: number }
  | { ok: false; kind: 'network' };

/** `GET https://discord.com<path>` with `authorization` as the Authorization header. `path` is checked against the allow-list first. */
export async function apiGet(path: string, authorization: string): Promise<ApiResult> {
  if (!isApiGetPathAllowed(path)) return { ok: false, kind: 'forbidden-path' };

  let response: Response;
  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      method: 'GET',
      headers: { Authorization: authorization, Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, kind: 'network' };
  }

  if (response.status === 401) return { ok: false, kind: 'unauthorized', status: 401 };
  if (!response.ok) return { ok: false, kind: 'http', status: response.status };
  try {
    return { ok: true, status: response.status, data: await response.json() };
  } catch {
    return { ok: false, kind: 'http', status: response.status };
  }
}
