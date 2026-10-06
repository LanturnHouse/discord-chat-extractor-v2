/**
 * Every selector, attribute name, class stem and URL pattern that depends on Discord's markup lives in this one file
 * (docs/PLAN.md §4, live-verified 2026-10-06, Korean UI). The rest of the content script asks the adapter (rows.ts, page.ts)
 * and never writes a selector of its own.
 *
 * Discord's CSS-module class names carry a build hash that changes (`iconItem_c69b6d`, `children__2ea32`): a class is
 * recognised by its STEM only (the token starts with `<stem>_`), never by the full name. aria-labels are localised, so they
 * are never used to tell row types apart (only as a last-resort name source).
 */

export const ATTR = {
  /** On the element a row's navigation hangs on: `a` (channel, DM, voice) or `div[role=button]` (thread, category). */
  listItemId: 'data-list-item-id',
  /** On a channel / category `li`: the display name, without any prefix or suffix. */
  dndName: 'data-dnd-name',
  ariaExpanded: 'aria-expanded',
  ariaLabel: 'aria-label',
  href: 'href',
  role: 'role',
} as const;

/** `role` of Discord's clickable divs (the native invite button of the server header). */
export const ROLE_BUTTON = 'button';

export const SELECTOR = {
  /** Every element a row hangs on. */
  listItem: `[${ATTR.listItemId}]`,
  /** A channel / category row of the guild list, recognised without looking at the link (health check only). */
  namedRow: `li[${ATTR.dndName}]`,
  /** The row element: an `li` (channel lists and the DM list are `ul > li`). */
  rowRoot: 'li',
  /** The list a row's `li` sits in. */
  list: 'ul',
  /** A row link that has an address. */
  hrefLink: 'a[href]',
  /** Thread rows live in a nested list inside the parent channel's `li`. */
  nestedGroup: 'ul[role="group"]',
  image: 'img',
  /** The server header at the top of a guild's channel sidebar (`header.header_*`) and the server name in it (`h2.name_*`). */
  guildHeader: 'header',
  guildName: 'h2',
} as const;

/** Tag names whose subtree belongs to ANOTHER row when found inside a row's `li` (nested thread list). */
export const NESTED_ROW_TAGS: readonly string[] = ['LI', 'UL'];

/** Class-name stems (see the file comment). */
export const STEM = {
  /** channel / voice / thread / category row: the icon container (`div.children__2ea32`). */
  children: 'children',
  /**
   * Category row (docs/PLAN.md §4 "카테고리 행"): `div.iconVisibility_*.wrapper_*` is the flex line that holds the title and the
   * `children_*` container. Our button goes at the end of that line, outside `children_*` (which is hidden until hover).
   */
  rowVisibility: 'iconVisibility',
  rowWrapper: 'wrapper',
  /** The native action icon of a channel row (`div.iconItem_c69b6d[role=button]`) and its svg (`svg.actionIcon_c69b6d`). */
  channelIcon: 'iconItem',
  channelSvg: 'actionIcon',
  /** DM row: the icon container (a sibling of the link), the close button and its svg. */
  dmContainer: 'iconsContainer',
  dmClose: 'closeButton',
  dmCloseSvg: 'closeIcon',
  /** Display-name element (`div.name__20a53` in a DM row, `div.name__2ea32` in a channel row). */
  name: 'name',
  /** A thread row carries `typeThread_*`. */
  thread: 'typeThread',
  /**
   * Server header (docs/PLAN.md §4 "서버 이름 헤더"): `header.header_*` > `div.headerContent_*` > the server menu
   * (`div.guildDropdown_*`, holds the name `h2.name_*`) + `span > div.inviteButton_*[role=button]` (only with invite rights).
   */
  guildHeader: 'header',
  guildHeaderContent: 'headerContent',
  guildMenu: 'guildDropdown',
  guildInvite: 'inviteButton',
} as const;

/** `data-list-item-id` patterns. Only a purely numeric tail is an id (`channels___channels-<guildId>` etc. are not). */
export const ITEM_ID = {
  /** Guild channel list rows: `channels___<id>`. */
  guild: /^channels___(\d+)$/,
  guildPrefix: 'channels___',
  /** DM list rows: `private-channels-uid_<n>___<channelId>` (`<n>` is a list position: never an id). */
  dmPrefix: 'private-channels',
  /** What comes right before the id. */
  separator: '___',
  /** The numeric part after the last `___`. */
  tail: /___(\d+)$/,
} as const;

/** A row's `href`: `/channels/<guildId>/<channelId>` or `/channels/@me/<channelId>`. */
export const CHANNEL_PATH = /^\/channels\/(\d+|@me)\/(\d+)$/;
/** The address of the chat being viewed (a jump link may add `/<messageId>`). */
export const CURRENT_CHAT_PATH = /^\/channels\/(\d+|@me)\/(\d+)(?:\/|$)/;
/** Any address inside a guild. */
export const GUILD_PATH = /^\/channels\/(\d+)(?:\/|$)/;

/** A DM avatar must come from these hosts and paths (the popup's CSP only allows these hosts for images anyway). */
export const AVATAR_HOSTS: readonly string[] = ['cdn.discordapp.com', 'media.discordapp.net'];
export const AVATAR_PATH = /^\/(?:avatars|embed\/avatars|channel-icons)\//;

/** `[class]` selector for tokens that start with `<stem>_` (`stem_hash` and `stem__hash`). */
export function stemSelector(stem: string): string {
  return `[class^="${stem}_"], [class*=" ${stem}_"]`;
}

/** Does one of `el`'s class tokens start with `<stem>_`? Works for HTML and SVG elements. */
export function hasStem(el: Element, stem: string): boolean {
  const classes = el.getAttribute('class');
  if (!classes) return false;
  const prefix = `${stem}_`;
  for (const token of classes.split(/\s+/)) {
    if (token.startsWith(prefix)) return true;
  }
  return false;
}
