/** Turns a row (or the address bar) into the `ChatTarget` / category request the background worker expects (PLAN §5.1, §5.3). */
import type { ChatTarget } from '@/shared/types';
import { guildNameFor } from './header';
import { parseChannelHref } from './ids';
import { currentChannelNameFromTitle, currentGuildId, currentGuildName, type CurrentChat } from './page';
import { dmAvatarUrl, firstRowIn, rowName, type Row } from './rows';
import { ATTR, SELECTOR } from './selectors';

export interface CategoryRequest {
  guildId: string;
  guildName: string | null;
  categoryId: string;
  categoryName: string;
}

export interface GuildRequest {
  guildId: string;
  guildName: string | null;
}

/** A guild id for a row without an href (voice, thread, category): the address bar, else a sibling row's href. */
function guildIdOf(row: Row): string | null {
  if (row.guildId) return row.guildId;
  const fromUrl = currentGuildId();
  if (fromUrl) return fromUrl;
  const list = row.root.closest(SELECTOR.list);
  if (!list) return null;
  for (const link of Array.from(list.querySelectorAll(SELECTOR.hrefLink))) {
    const ref = parseChannelHref(link.getAttribute(ATTR.href));
    if (ref && ref.guildId !== '@me') return ref.guildId;
  }
  return null;
}

/**
 * The category a channel belongs to: the nearest category row above it in its list (the channel list is flat), or, in a
 * nested layout, the category whose `li` holds it. Rows that are scrolled out of the virtual list are not in the DOM, so this
 * can be null - it is only a hint for the file layout.
 */
function categoryAbove(row: Row): { id: string; name: string } | null {
  for (let sibling = row.root.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
    const candidate = firstRowIn(sibling);
    if (candidate?.kind === 'category') return { id: candidate.id, name: rowName(candidate) };
  }
  const holder = row.root.parentElement?.closest(SELECTOR.rowRoot);
  const parent = holder ? firstRowIn(holder) : null;
  return parent?.kind === 'category' ? { id: parent.id, name: rowName(parent) } : null;
}

/** A thread's parent channel: the row whose `li` holds the thread's nested list. */
function parentChannelOf(row: Row): { id: string; name: string } | null {
  const holder = row.root.parentElement?.closest(SELECTOR.rowRoot);
  if (!holder) return null;
  const parent = firstRowIn(holder);
  if (!parent || parent.kind === 'category' || parent.kind === 'dm') return null;
  return { id: parent.id, name: rowName(parent) };
}

/** The `queue/toggle` target of a channel, voice, thread or DM row. Categories are not toggled: see `categoryRequest`. */
export function buildTarget(row: Row): ChatTarget | null {
  if (row.kind === 'category') return null;
  const channelName = rowName(row);
  if (row.kind === 'dm') {
    return { kind: 'dm', channelId: row.id, guildId: null, guildName: null, channelName, iconUrl: dmAvatarUrl(row) };
  }
  const guildId = guildIdOf(row);
  const target: ChatTarget = {
    kind: row.kind === 'thread' ? 'thread' : 'guild-channel',
    channelId: row.id,
    guildId,
    guildName: guildId ? currentGuildName() : null,
    channelName,
  };
  const parent = row.kind === 'thread' ? parentChannelOf(row) : categoryAbove(row);
  if (parent) {
    target.parentId = parent.id;
    target.parentName = parent.name;
  }
  return target;
}

/** The `queue/addCategory` request of a category row, or null when its guild cannot be determined. */
export function categoryRequest(row: Row): CategoryRequest | null {
  if (row.kind !== 'category') return null;
  const guildId = guildIdOf(row);
  if (!guildId) return null;
  return { guildId, guildName: currentGuildName(), categoryId: row.id, categoryName: rowName(row) };
}

/**
 * The `queue/addGuild` request of the server button in a header: the guild from the address bar (`/channels/<guildId>/...`), its
 * name from the header the button sits in, else from the tab title. null outside a guild (the DM home has no such header; a
 * button left over from the guild just visited must not send anything). Read at click time, never remembered: a header that
 * survives a server switch then still acts on the server being shown.
 */
export function guildRequest(
  button: Element,
  doc: Document = document,
  pathname: string = location.pathname,
): GuildRequest | null {
  const guildId = currentGuildId(pathname);
  if (!guildId) return null;
  return { guildId, guildName: guildNameFor(button.closest(SELECTOR.guildHeader), doc, pathname) };
}

/**
 * The target of the chat in the address bar when no sidebar row for it is on screen (collapsed category, scrolled out): the
 * names come from the tab title when it names the chat unambiguously, otherwise the id stands in and the background worker
 * resolves the real names through the API.
 */
export function minimalTarget(chat: CurrentChat): ChatTarget {
  const name = currentChannelNameFromTitle() ?? chat.channelId;
  if (chat.guildId === null) {
    return { kind: 'dm', channelId: chat.channelId, guildId: null, guildName: null, channelName: name, iconUrl: null };
  }
  return { kind: 'guild-channel', channelId: chat.channelId, guildId: chat.guildId, guildName: currentGuildName(), channelName: name };
}
