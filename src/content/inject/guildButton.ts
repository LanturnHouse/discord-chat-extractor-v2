/**
 * The server button of the guild header (docs/PLAN.md §2 "서버 버튼", §4 "서버 이름 헤더", §7.1): one `span > div` per server
 * header, right before the native invite button's wrapper (= left of the person+ icon), visible all the time.
 *
 * The header content is `display:flex; justify-content:space-between; gap:4px`: with three children (server menu, ours, invite)
 * ours would float in the MIDDLE. Our wrapper therefore has `margin-left:auto` (an auto margin takes the free space before
 * `space-between` does), which glues it to the invite button with Discord's own gap; without an invite button it is last, and the
 * same margin pushes it to the right edge.
 *
 * The button is a toggle with a check state (PLAN §2 "서버 버튼"): the download arrow while some channel of the server is not in
 * the list, a check mark while all of them are (`GuildButtonState.checked`).
 *
 * The same rules as the row buttons (inject/injector.ts): `ensure` looks at the real DOM on every pass and never trusts a memory
 * of what it did, only OUR nodes are inserted / moved / removed, and the look is mirrored from Discord's own element by class
 * name. The div gets the invite button's className (size, colour and hover rules come with it), the svg is ours: 20 px,
 * `currentColor`. A header without an invite button (an account that cannot invite) gets the button at the end of
 * `headerContent_*`, drawn by our own CSS (`.dce-guild-btn`, styles.css).
 *
 * The button knows no guild: the address bar says which server it acts on, read at click time (dom/target.ts `guildRequest`).
 */
import { GUILD_BUTTON_SELECTOR, GUILD_WRAP_SELECTOR, KEY_ATTR, OWN, OWN_VALUE, SRC_ATTR, STATE_ATTR } from '../config';
import { findGuildHeaders, type GuildHeader } from '../dom/header';
import { normalizeClass } from '../dom/rows';
import { setAttr, setClassAttr } from './button';
import { createIconSvg, setIcon } from './icons';

/** The server icon of Discord's header is 20 px (inside a 32 px button). */
export const GUILD_ICON_SIZE = 20;

/** Classes of the fallback look (no native invite button to copy): everything about them is in styles.css. */
export const FALLBACK_GUILD_BUTTON_CLASS = 'dce-guild-btn';
export const FALLBACK_GUILD_SVG_CLASS = 'dce-guild-icon';

export interface GuildButtonState {
  /** The server of the address bar, or null outside a guild (the DM home has no server header: nothing is put there). */
  guildId(): string | null;
  /** Is every channel of the server `guildId` in the download list? (check mark instead of the download arrow) */
  checked(guildId: string): boolean;
  /** The tooltip and aria-label for the given state, in the language of the page. */
  label(checked: boolean): string;
  /** A request of the server button is in flight (it is shown as busy and ignores clicks). */
  busy(): boolean;
  /** The button was brought to this check state (the owner keeps the "just added" mark of it, inject/fresh.ts). */
  applied?(button: HTMLElement, checked: boolean): void;
}

/** Is `el` our server button? */
export function isGuildButton(el: Element): boolean {
  return el.matches(GUILD_BUTTON_SELECTOR);
}

/** Removes every server button of ours from the page (leftovers of an earlier run, or all of them on teardown). */
export function removeGuildButtons(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll(`${GUILD_WRAP_SELECTOR}, ${GUILD_BUTTON_SELECTOR}`))) el.remove();
}

/** `span > div > svg`, not yet in the page: idle download arrow, no look applied. */
function createGuildButton(doc: Document): HTMLElement {
  const wrap = doc.createElement('span');
  wrap.setAttribute(OWN, OWN_VALUE.guildWrap);
  wrap.style.marginLeft = 'auto'; // right up against the invite button (styles.css has the same rule for a page that drops this)
  const button = doc.createElement('div');
  button.setAttribute(OWN, OWN_VALUE.guildButton);
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', '0');
  button.setAttribute('draggable', 'false');
  button.appendChild(createIconSvg(doc, 'download', GUILD_ICON_SIZE));
  wrap.appendChild(button);
  return wrap;
}

/** A wrapper that still holds exactly our button with its svg (someone may have emptied or filled it). */
function wellFormed(wrap: HTMLElement): boolean {
  const button = wrap.firstElementChild;
  return wrap.childElementCount === 1 && button !== null && isGuildButton(button) && button.querySelector('svg') !== null;
}

/** The native invite button's class names (and its svg's, if it has one), else our own CSS. Idempotent. */
function applyLook(button: HTMLElement, invite: HTMLElement | null): void {
  const svg = button.querySelector('svg')!;
  const mirrored = invite ? normalizeClass(invite.getAttribute('class')) : null;
  if (mirrored) {
    setClassAttr(button, mirrored);
    setAttr(button, SRC_ATTR, 'native');
    setClassAttr(svg, normalizeClass(invite!.querySelector('svg')?.getAttribute('class')) ?? '');
  } else {
    setClassAttr(button, FALLBACK_GUILD_BUTTON_CLASS);
    setAttr(button, SRC_ATTR, 'fallback');
    setClassAttr(svg, FALLBACK_GUILD_SVG_CLASS);
  }
}

/** Icon (arrow / check mark), label and busy flag. */
function applyGuildState(button: HTMLElement, guildId: string | null, state: GuildButtonState): void {
  const checked = guildId !== null && state.checked(guildId);
  setAttr(button, STATE_ATTR, checked ? 'queued' : 'idle');
  setAttr(button, 'aria-label', state.label(checked));
  const svg = button.querySelector('svg');
  if (svg) setIcon(svg, checked ? 'check' : 'download');
  if (state.busy()) setAttr(button, 'aria-busy', 'true');
  else if (button.hasAttribute('aria-busy')) button.removeAttribute('aria-busy');
  state.applied?.(button, checked);
}

/** Right before the invite button's wrapper; without an invite button, last in `headerContent_*`. Only our wrapper moves. */
function place(wrap: HTMLElement, { content, slot }: GuildHeader): void {
  if (slot) {
    if (wrap.parentElement !== content || wrap.nextElementSibling !== slot) content.insertBefore(wrap, slot);
  } else if (wrap.parentElement !== content || content.lastElementChild !== wrap) {
    content.appendChild(wrap);
  }
}

export class GuildButtons {
  /**
   * The wrappers this instance put into the page, so that an ordinary pass can tell "something of ours is left behind" without
   * searching the whole document (a pass runs for every burst of mutations). Whether a header HAS a button is always read from
   * the page, never from here.
   */
  private readonly placed = new Set<HTMLElement>();

  constructor(
    private readonly doc: Document,
    private readonly state: GuildButtonState,
  ) {}

  /**
   * Idempotent: afterwards every server header of the page has exactly one button of ours, in the right place, with the right
   * look and state, and none of ours is anywhere else (a header that went away or no longer looks like one, a page that is not
   * inside a guild). Returns whether the page shows a server header (inside a guild): the page is looking at a server.
   */
  ensure(): boolean {
    const guildId = this.state.guildId();
    const kept = new Set<HTMLElement>();
    if (guildId) {
      for (const found of findGuildHeaders(this.doc)) kept.add(this.ensureIn(found, guildId));
    }
    for (const wrap of Array.from(this.placed)) {
      if (kept.has(wrap)) continue;
      wrap.remove();
      this.placed.delete(wrap);
    }
    return kept.size > 0;
  }

  private ensureIn(found: GuildHeader, guildId: string): HTMLElement {
    const mine = Array.from(found.header.querySelectorAll<HTMLElement>(GUILD_WRAP_SELECTOR));
    const wrap = mine.find(wellFormed) ?? createGuildButton(this.doc);
    for (const extra of mine) {
      if (extra === wrap) continue;
      extra.remove(); // a copy, or a wrapper somebody emptied
      this.placed.delete(extra);
    }
    this.placed.add(wrap);
    const button = wrap.firstElementChild as HTMLElement;
    applyLook(button, found.invite);
    place(wrap, found);
    setAttr(button, KEY_ATTR, guildId);
    applyGuildState(button, guildId, this.state);
    return wrap;
  }

  /** Re-applies icon, label and busy flag to the buttons in the page (the list, a group, the language or a request changed). */
  sync(): void {
    const guildId = this.state.guildId();
    for (const button of Array.from(this.doc.querySelectorAll<HTMLElement>(GUILD_BUTTON_SELECTOR))) {
      applyGuildState(button, guildId, this.state);
    }
  }

  /** The page was cleaned elsewhere (`removeGuildButtons`): forget what was placed. */
  forget(): void {
    this.placed.clear();
  }
}
