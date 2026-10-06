/** Id parsing for Discord's row links (docs/PLAN.md §4). Pure functions, no DOM access. */
import { CHANNEL_PATH, ITEM_ID } from './selectors';

export interface ChannelRef {
  /** Numeric guild id, or `@me` for a DM. */
  guildId: string;
  channelId: string;
}

/** `/channels/<guildId|@me>/<channelId>` -> its parts; anything else (extra segments, non-numeric ids) -> null. */
export function parseChannelPath(path: string): ChannelRef | null {
  const match = CHANNEL_PATH.exec(path);
  return match ? { guildId: match[1]!, channelId: match[2]! } : null;
}

/**
 * A row's `href` attribute (relative, or absolute with any origin) -> its channel, or null. Query string and fragment are
 * ignored. A missing or unparsable value gives null.
 */
export function parseChannelHref(href: string | null | undefined): ChannelRef | null {
  if (!href) return null;
  let path: string;
  try {
    path = new URL(href, 'https://discord.com').pathname;
  } catch {
    return null;
  }
  return parseChannelPath(path);
}

/** The numeric tail of a `data-list-item-id` (`..._11___987654321098765432` -> the id), or null (`channels___channels-<id>`). */
export function listItemTailId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = ITEM_ID.tail.exec(raw);
  return match ? match[1]! : null;
}

/** Guild channel list rows only: `channels___<digits>` -> the digits. */
export function guildItemId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = ITEM_ID.guild.exec(raw);
  return match ? match[1]! : null;
}
