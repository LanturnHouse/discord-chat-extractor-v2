/**
 * jsdom fixtures built from docs/PLAN.md §4 (the live-verified structure of Discord's sidebars) with NEUTRAL names and ids.
 * Class names keep Discord's `stem_hash` / `stem__hash` shape so the stem matching of the adapter is exercised for real.
 */

export const GUILD = '100000000000000001';
/** A second server, for tests that switch servers. */
export const GUILD_TWO = '100000000000000002';

export const ID = {
  general: '200000000000000001',
  random: '200000000000000002',
  voice: '200000000000000003',
  thread: '200000000000000004',
  forum: '200000000000000005',
  categoryA: '300000000000000001',
  categoryB: '300000000000000002',
  dm: '400000000000000001',
  groupDm: '400000000000000002',
  newFriendDm: '400000000000000003',
  userHash: 'a1b2c3d4e5f60718',
} as const;

export const CHANNEL_ICON_CLASS = 'iconItem_c69b6d iconBase_c69b6d iconNoChannelInfo_c69b6d';
export const CHANNEL_SVG_CLASS = 'actionIcon_c69b6d';
export const DM_CLOSE_CLASS = 'closeButton__972a0 reducedClickTarget__972a0';
export const DM_CLOSE_SVG_CLASS = 'closeIcon__972a0';
/** Our own class on every row button: it forces the button visible without hover (PLAN §2 "버튼 표시"). */
export const FORCE_CLASS = 'dce-always';
/** What a mirrored button's className looks like: Discord's classes, then ours. */
export const mirrored = (nativeClass: string): string => `${nativeClass} ${FORCE_CLASS}`;

const SVG = (cls: string, size = 16): string =>
  `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h18v18H3z"></path></svg>`;

/** The native "invite" icon of a channel row, wrapped like Discord does it (`span > div.iconItem`) + the hidden label. */
export function nativeChannelIcon(label = 'Invite to channel'): string {
  return (
    `<span><div class="${CHANNEL_ICON_CLASS}" role="button" tabindex="0" aria-label="${label}">${SVG(CHANNEL_SVG_CLASS)}</div></span>` +
    `<span class="hiddenVisually_b18fe2">${label}</span>`
  );
}

export interface ChannelRowOptions {
  id: string;
  name: string;
  guildId?: string;
  selected?: boolean;
  /** HTML put into `children__2ea32` (default: the native invite icon; '' = an empty container). */
  icons?: string;
  /** false = the row has no `children_` container at all. */
  container?: boolean;
  /** Nested thread rows (`li > ul[role=group]`). */
  threads?: string[];
  /** Omit the `href` (voice / stage rows are `a` without href, role=button). */
  voice?: boolean;
}

/** A text / voice channel row (PLAN §4 "채널 행"). */
export function channelRow(o: ChannelRowOptions): string {
  const guild = o.guildId ?? GUILD;
  const selected = o.selected ? ' selected_c69b6d' : '';
  const wrapperSelected = o.selected ? ' selectedChannel_c69b6d modeSelected__2ea32' : '';
  const icons = o.icons ?? nativeChannelIcon();
  const children = o.container === false ? '' : `<div class="children__2ea32" style="display:flex">${icons}</div>`;
  const link = o.voice
    ? `<a class="link__2ea32" role="button" tabindex="-1" data-list-item-id="channels___${o.id}" aria-label="${o.name} (voice channel)">`
    : `<a class="link__2ea32" role="link" tabindex="-1" data-list-item-id="channels___${o.id}" href="/channels/${guild}/${o.id}" aria-label="${o.name} (text channel)">`;
  const threads = o.threads?.length ? `<ul role="group">${o.threads.join('')}</ul>` : '';
  return (
    `<li class="containerDefault_c69b6d${selected}" data-dnd-name="${o.name}">` +
    `<div class="iconVisibility_c69b6d wrapper__2ea32${wrapperSelected}"><div>` +
    link +
    `<div class="linkTop__2ea32">` +
    `<div class="iconContainer__2ea32" role="img" aria-label="Text icon"><svg class="icon__2ea32" width="24" height="24"></svg></div>` +
    `<span class="hiddenVisually_b18fe2">Text</span>` +
    `<div class="name__2ea32 overflow_b0dfc2"><span>${o.name}</span></div>` +
    `<span style="display:none"></span>` +
    children +
    `</div></a></div></div>` +
    threads +
    `</li>`
  );
}

export interface ThreadRowOptions {
  id: string;
  name: string;
  /** false = no `data-dnd-name` on the `li` (the name then comes from the name element). */
  dndName?: boolean;
  container?: boolean;
}

/** A thread row: a `div[role=button]` link, `typeThread_*` wrapper, no native icons (PLAN §4 "스레드 행"). */
export function threadRow(o: ThreadRowOptions): string {
  const dnd = o.dndName === false ? '' : ` data-dnd-name="${o.name}"`;
  const children = o.container === false ? '' : `<div class="children__2ea32" style="display:flex"></div>`;
  return (
    `<li class="containerDefault_c69b6d"${dnd}>` +
    `<div class="iconVisibility_c69b6d wrapper__2ea32 typeThread_5d1e7"><div>` +
    `<div class="link__2ea32" role="button" tabindex="-1" data-list-item-id="channels___${o.id}">` +
    `<div class="linkTop__2ea32">` +
    `<div class="name__2ea32 overflow_b0dfc2"><span>${o.name}</span></div>` +
    children +
    `</div></div></div></div></li>`
  );
}

export interface CategoryRowOptions {
  id: string;
  name: string;
  /** HTML put into `children__29444` (default empty: only admins have a "create channel" button there). */
  children?: string;
}

/** A category row (PLAN §4 "카테고리 행"): `aria-expanded` sits on an element below the link. */
export function categoryRow(o: CategoryRowOptions): string {
  return (
    `<li class="containerDefault__29444" data-dnd-name="${o.name}">` +
    `<div class="iconVisibility__29444 wrapper__29444 wrapperCommon__29444 clickable__29444">` +
    `<div class="mainContent__29444" role="button" aria-label="${o.name} (category)" data-list-item-id="channels___${o.id}" tabindex="-1">` +
    `<h3 class="name__29444"><div class="overflow_b0dfc2" aria-expanded="true">${o.name}</div></h3>` +
    `<svg class="icon__29444" width="12" height="12"></svg>` +
    `</div>` +
    `<div class="children__29444">${o.children ?? ''}</div>` +
    `</div></li>`
  );
}

export interface DmRowOptions {
  id: string;
  name: string;
  /** Icons before the close button (favourite star, wave button...). */
  before?: string;
  /** false = no close button at all (a brand-new friend DM). */
  close?: boolean;
  avatar?: string | null;
  /** The numeric `uid_<n>` part of the item id (a list position, not an id). */
  position?: number;
  selected?: boolean;
  /** Group DM: aria-label says "(Group message)". */
  group?: boolean;
}

export const FAVORITE_ICON = `<div class="favoriteButton__972a0" role="button" tabindex="0" aria-label="Favorite"><svg width="16" height="16"><path d="M0 0h2v2H0z"></path></svg></div>`;
export const WAVE_ICON = `<div class="waveButton__972a0" role="button" tabindex="0" aria-label="Wave"><svg width="16" height="16"><path d="M0 0h2v2H0z"></path></svg></div>`;

/** A DM list row (PLAN §4 "DM 행"). */
export function dmRow(o: DmRowOptions): string {
  const avatar = o.avatar === undefined ? `https://cdn.discordapp.com/avatars/${ID.userHash}/${ID.userHash}.webp?size=32` : o.avatar;
  const label = o.group ? `${o.name} (Group message)` : `${o.name} (Direct message), online`;
  const close =
    o.close === false
      ? ''
      : `<div class="${DM_CLOSE_CLASS}" role="button" tabindex="0" aria-label="${o.group ? 'Leave group' : 'Close DM'}"><div>${SVG(DM_CLOSE_SVG_CLASS)}</div></div>`;
  return (
    `<li class="channel__972a0 dm__972a0 container_e45859${o.selected ? ' selected__972a0' : ''}" role="listitem">` +
    `<div class="interactive_f88cfd interactive__972a0">` +
    `<a class="link__972a0 channelNameFade__972a0" data-list-item-id="private-channels-uid_${o.position ?? 11}___${o.id}" href="/channels/@me/${o.id}" aria-label="${label}" tabindex="-1">` +
    `<div class="layout__20a53">` +
    `<div class="avatar__20a53">${avatar ? `<img src="${avatar}" alt="">` : ''}</div>` +
    `<div class="content__20a53"><div class="name__20a53"><div class="overflowTooltip_a4f">${o.name}</div></div></div>` +
    `</div></a>` +
    `<div class="iconsContainer__972a0" style="display:flex">${o.before ?? ''}${close}</div>` +
    `</div></li>`
  );
}

export const INVITE_CLASS = 'inviteButton_f37cb1';

export interface GuildHeaderOptions {
  /** The server name in `h2.name_*`; null = no name element at all. Default "Server One". */
  name?: string | null;
  /** false = an account without the right to invite: the header has no invite button. */
  invite?: boolean;
  /** className of the native invite button (default `inviteButton_f37cb1`). */
  inviteClass?: string;
  /** className of the invite button's svg (default none: the live markup has none). */
  inviteSvgClass?: string;
  /** false = the invite button is not wrapped in a `span`. */
  wrapper?: boolean;
}

/** The server header of PLAN §4 "서버 이름 헤더": `header > headerContent > guildDropdown + span > inviteButton`. */
export function guildHeader(o: GuildHeaderOptions = {}): string {
  const name = o.name === undefined ? 'Server One' : o.name;
  const svgClass = o.inviteSvgClass ? ` class="${o.inviteSvgClass}"` : '';
  const inviteButton =
    `<div class="${o.inviteClass ?? INVITE_CLASS}" role="button" tabindex="0" aria-label="Invite to server">` +
    `<svg${svgClass} width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h18v18H3z"></path></svg></div>`;
  const invite = o.invite === false ? '' : o.wrapper === false ? inviteButton : `<span>${inviteButton}</span>`;
  return (
    `<header class="header_f37cb1"><div class="headerContent_f37cb1 primaryInfo_f37cb1">` +
    `<div class="guildDropdown_f37cb1" role="button" tabindex="0" aria-expanded="false" aria-label="${name ?? 'Server'}, server activity">` +
    `<div class="guildBadgeAndName_f37cb1">${name === null ? '' : `<h2 class="name_f37cb1">${name}</h2>`}</div>` +
    `<div class="headerChildren_f37cb1"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M0 0h2v2H0z"></path></svg></div>` +
    `</div>${invite}</div></header>`
  );
}

/** A server's whole sidebar: `nav` > server header + the channel list. */
export function guildSidebar(header: string, ...rows: string[]): string {
  return `<nav class="container__2637a" aria-label="Server One (server)">${header}<ul aria-label="Channels" class="content_c69b6d">${rows.join('')}</ul></nav>`;
}

/** Rows that must never be decorated: the "events" button row, the generic "channels & roles" row, a chat message, friends. */
export function nonRows(): string {
  return (
    `<li class="containerDefault_c69b6d" data-dnd-name="Events"><div role="button" data-list-item-id="channels___guild-events" tabindex="-1"></div></li>` +
    `<li class="containerDefault_c69b6d"><div role="button" data-list-item-id="channels___channels-${GUILD}" tabindex="-1"></div></li>` +
    `<li class="channel__972a0" role="listitem"><a data-list-item-id="private-channels-uid_11___friends" href="/channels/@me"></a></li>` +
    `<li id="chat-messages-1" data-list-item-id="chat-messages___chat-messages-${ID.general}-900000000000000001"><div class="children__2ea32"></div></li>`
  );
}

/** The sidebar list element that holds guild rows. */
export function sidebar(...rows: string[]): string {
  return `<nav><ul aria-label="Channels" class="content_c69b6d">${rows.join('')}</ul></nav>`;
}

/** Replaces the page body with `html` and returns the body. */
export function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

/** Puts the address bar and the tab title where a viewer of `channelId` in the guild would have them. */
export function setPage(path: string, title: string): void {
  history.pushState({}, '', path);
  document.title = title;
}

export function byKey(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-dce="row-btn"][data-dce-key="${key}"]`);
}

export function allButtons(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-dce="row-btn"]'));
}

/** The server buttons (`div`) and their `span` wrappers. */
export function guildButtons(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-dce="guild-btn"]'));
}

export function guildWraps(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-dce="guild-wrap"]'));
}

/** A row `li` of the fixture by the id of its link. */
export function rowOf(id: string): HTMLElement {
  const link = document.querySelector(`[data-list-item-id$="___${id}"]`);
  const li = link?.closest('li');
  if (!li) throw new Error(`no row for ${id}`);
  return li as HTMLElement;
}
