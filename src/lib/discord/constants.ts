/**
 * Lib-local Discord constants. `src/lib` imports nothing outside itself except `@/shared` (contracts and allow-lists),
 * so the few hosts and limits the core needs live here.
 */

/** Origin of the Discord API. The authorization value is only ever sent to requests below `${DISCORD_ORIGIN}/api/`. */
export const DISCORD_ORIGIN = 'https://discord.com';
export const CDN_BASE = 'https://cdn.discordapp.com';
export const MEDIA_BASE = 'https://media.discordapp.net';

/** Hard limit of `GET /channels/{id}/messages?limit=`. */
export const API_MESSAGE_LIMIT = 100;
/** Discord answers at most 25 threads per search request. */
export const THREAD_SEARCH_PAGE_SIZE = 25;
/** Largest `offset` the thread search accepts (10,000 results minus one page). */
export const THREAD_SEARCH_MAX_OFFSET = 9975;
/** `POST /attachments/refresh-urls` takes at most this many URLs. */
export const REFRESH_URLS_BATCH_SIZE = 50;
