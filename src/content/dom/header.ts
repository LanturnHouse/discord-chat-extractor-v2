/**
 * The DOM adapter for the server header: the bar with the server's name at the top of a guild's channel sidebar (docs/PLAN.md
 * §4 "서버 이름 헤더", live-verified 2026-10-06). Read-only: nothing here changes the page. All Discord-specific strings come
 * from ./selectors.
 *
 *   header.header_*
 *     div.headerContent_*                         (flex)
 *       div.guildDropdown_*[role=button]          the server menu: must never receive our clicks
 *         ... h2.name_*                           the server name
 *       span                                      tooltip wrapper (the "slot": our button goes right before it)
 *         div.inviteButton_*[role=button]         only with the right to invite people
 */
import { OWN } from '../config';
import { currentGuildName } from './page';
import { clean, findOwn } from './rows';
import { ATTR, ROLE_BUTTON, SELECTOR, STEM, hasStem } from './selectors';

export interface GuildHeader {
  header: HTMLElement;
  /** `headerContent_*`: where the server menu and the invite button live. */
  content: HTMLElement;
  /** The native invite button (null: this account cannot invite, so the header has none). */
  invite: HTMLElement | null;
  /** The child of `content` the invite button hangs under (its tooltip wrapper `span`, else the button itself); null without an invite. */
  slot: HTMLElement | null;
}

/** `div.inviteButton_*[role=button]`. Our own button mirrors that class name, so callers must skip our nodes (`findOwn` does). */
const isInvite = (el: Element): boolean => hasStem(el, STEM.guildInvite) && el.getAttribute(ATTR.role) === ROLE_BUTTON;

/** The child of `content` that contains `invite`. */
function slotOf(content: HTMLElement, invite: HTMLElement): HTMLElement | null {
  let slot: HTMLElement = invite;
  while (slot.parentElement && slot.parentElement !== content) slot = slot.parentElement;
  return slot.parentElement === content ? slot : null;
}

/**
 * Every server header on the page (normally one). A `header` counts when it has a `headerContent_*` that holds the server menu
 * or the invite button: other headers of Discord's UI (without either) are not ours to decorate.
 */
export function findGuildHeaders(doc: Document): GuildHeader[] {
  const found: GuildHeader[] = [];
  for (const header of Array.from(doc.querySelectorAll<HTMLElement>(SELECTOR.guildHeader))) {
    if (header.hasAttribute(OWN) || !hasStem(header, STEM.guildHeader)) continue;
    const content = findOwn(header, (el) => hasStem(el, STEM.guildHeaderContent));
    if (!content) continue;
    const invite = findOwn(content, isInvite);
    if (!invite && !findOwn(content, (el) => hasStem(el, STEM.guildMenu))) continue;
    found.push({ header, content, invite, slot: invite ? slotOf(content, invite) : null });
  }
  return found;
}

/** The server name shown in the header (`h2.name_*`), or null when there is none to read. */
export function guildNameIn(header: Element | null): string | null {
  if (!header) return null;
  const heading = findOwn(header, (el) => el.matches(SELECTOR.guildName) && hasStem(el, STEM.name));
  const name = clean(heading?.textContent).slice(0, 500);
  return name === '' ? null : name;
}

/** The server name for the background worker: the header's own, else the last `|` segment of the tab title. */
export function guildNameFor(header: Element | null, doc: Document, pathname: string): string | null {
  return guildNameIn(header) ?? currentGuildName(doc, pathname);
}
