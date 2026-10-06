/** What the address bar and the tab title say about the chat being viewed (docs/PLAN.md §4). */
import { CURRENT_CHAT_PATH, GUILD_PATH } from './selectors';

export interface CurrentChat {
  /** null for a DM / group DM (`/channels/@me/<id>`). */
  guildId: string | null;
  channelId: string;
}

/** `/channels/<guildId|@me>/<channelId>[/...]` -> the chat being viewed, or null (friends page, settings, ...). */
export function parseChatPath(pathname: string): CurrentChat | null {
  const match = CURRENT_CHAT_PATH.exec(pathname);
  if (!match) return null;
  return { guildId: match[1] === '@me' ? null : match[1]!, channelId: match[2]! };
}

/** Numeric guild id of the current address (`/channels/<guildId>/...`), or null outside a guild. */
export function currentGuildId(pathname: string = location.pathname): string | null {
  const match = GUILD_PATH.exec(pathname);
  return match ? match[1]! : null;
}

/** `(8) Discord | #general | Server` -> ['(8) Discord', '#general', 'Server']. */
export function titleSegments(title: string): string[] {
  return title
    .split('|')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part !== '');
}

/**
 * The guild's name: the last `|` segment of `document.title` (e.g. `(8) Discord | #general | Server` -> `Server`), only on
 * a guild page and only when the title has more than one segment. The background worker corrects it through the API.
 */
export function currentGuildName(doc: Document = document, pathname: string = location.pathname): string | null {
  if (!currentGuildId(pathname)) return null;
  const segments = titleSegments(doc.title);
  if (segments.length < 2) return null;
  const last = segments[segments.length - 1]!;
  if (last.startsWith('@') || last.startsWith('#')) return null;
  return last;
}

/**
 * Best-effort channel name from the title, only for the two shapes known to be unambiguous: `Discord | #general | Server`
 * (-> `general`) and `Discord | @Alex` (-> `Alex`). Anything else (a thread or forum post adds a segment) gives null rather
 * than the name of the wrong chat.
 */
export function currentChannelNameFromTitle(doc: Document = document): string | null {
  const segments = titleSegments(doc.title);
  const chat = segments.length === 3 ? segments[1]! : segments.length === 2 ? segments[1]! : '';
  const wanted = segments.length === 3 ? '#' : '@';
  if (!chat.startsWith(wanted)) return null;
  const name = chat.slice(1).trim();
  return name === '' ? null : name;
}
