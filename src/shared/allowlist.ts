/**
 * Request allow-lists (docs/PLAN.md §8) and the pure helpers that apply them:
 *  - the HTTP transport layer of the engine's API client (offscreen document) checks EVERY request with
 *    `isTransportRequestAllowed` before the `Authorization` value is attached to it;
 *  - the background worker's own direct GETs (account check, channel / guild name lookups, the guild channel list behind a
 *    category button) check the path with `isApiGetPathAllowed`, a narrower list, and only ever GET. The content script and
 *    the popup make no API calls at all: they only send messages to the background worker.
 *
 * Paths are `/api/v9/...` only, relative to the Discord origin. Absolute URLs, `//host` paths, other API versions,
 * encoded slashes, dot segments, fragments and anything outside printable ASCII never match.
 */

/**
 * Paths the transport may request: own account, own member record per guild, channel + its messages / thread search /
 * public archived threads, guild + its channels / roles / own member, and the attachment URL refresher. The query string
 * is free-form. Methods are checked separately (`isTransportRequestAllowed`).
 */
export const TRANSPORT_ALLOWLIST: readonly RegExp[] = /* @__PURE__ */ Object.freeze([
  /^\/api\/v9\/(users\/@me|users\/@me\/guilds\/\d+\/member|channels\/\d+(\/messages|\/threads\/search|\/threads\/archived\/public)?|guilds\/\d+(\/channels|\/roles|\/members\/@me)?|attachments\/refresh-urls)(\?.*)?$/,
]);

/**
 * Paths the background worker may GET itself (docs/PLAN.md §8): own account, a channel, a guild and a guild's channel list.
 * A narrower subset of the transport list.
 */
export const API_GET_ALLOWLIST: readonly RegExp[] = /* @__PURE__ */ Object.freeze([
  /^\/api\/v9\/(users\/@me|users\/@me\/guilds\/\d+\/member|channels\/\d+|guilds\/\d+|guilds\/\d+\/(channels|roles|members\/@me))(\?.*)?$/,
]);

/** The only path (without a query string) that may be POSTed to. */
const POST_PATH = '/api/v9/attachments/refresh-urls';
const MAX_PATH_LENGTH = 2048;
/** Printable ASCII without space: rejects control characters (CR/LF/NUL/TAB), whitespace, DEL and non-ASCII. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/** Fail closed on anything that is not a plain request path, before any regex runs. `#` and `\` are never part of one. */
function isPlainPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length <= MAX_PATH_LENGTH &&
    PRINTABLE_ASCII.test(path) &&
    !path.includes('#') &&
    !path.includes('\\')
  );
}

function matchesAny(patterns: readonly RegExp[], path: string): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

/**
 * May the transport send `method path`? GET is allowed on every allow-listed path; POST only on exactly
 * `/api/v9/attachments/refresh-urls` (no query string); every other method is refused. The method is compared
 * case-sensitively on purpose (the contract uses upper-case `'GET' | 'POST'`).
 */
export function isTransportRequestAllowed(method: string, path: string): boolean {
  if (!isPlainPath(path) || !matchesAny(TRANSPORT_ALLOWLIST, path)) return false;
  if (method === 'GET') return true;
  return method === 'POST' && path === POST_PATH;
}

/** May the background worker's own direct GET request `path`? (GET only, narrower list than the transport.) */
export function isApiGetPathAllowed(path: string): boolean {
  return isPlainPath(path) && matchesAny(API_GET_ALLOWLIST, path);
}
