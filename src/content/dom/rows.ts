/**
 * The DOM adapter: finds Discord's sidebar rows (channels, voice, threads, categories, DMs), classifies them, reads their
 * names and locates their icon container and the native icon to mirror (docs/PLAN.md §4). Read-only: nothing here changes
 * the page. All Discord-specific strings come from ./selectors.
 */
import { KEY_ATTR, OWN, OWN_SELECTOR } from '../config';
import { guildItemId, listItemTailId, parseChannelHref } from './ids';
import {
  ATTR,
  AVATAR_HOSTS,
  AVATAR_PATH,
  ITEM_ID,
  NESTED_ROW_TAGS,
  SELECTOR,
  STEM,
  hasStem,
} from './selectors';

export type RowKind = 'channel' | 'voice' | 'thread' | 'category' | 'dm';

export interface Row {
  kind: RowKind;
  /** Channel / thread / category / DM channel id. */
  id: string;
  /** Guild id from the row's own `href`; null when the row has none (callers fall back to the address bar). */
  guildId: string | null;
  /** The element carrying `data-list-item-id`. */
  link: HTMLElement;
  /** The row element (`li`). */
  root: HTMLElement;
}

/** What a row's own icon looks like (the thing our button mirrors). */
export interface NativeIcon {
  /** `div.iconItem_*` (channel rows) or `div.closeButton_*` (DM rows). */
  button: HTMLElement;
  /** Its class names, whitespace-normalised. */
  buttonClass: string | null;
  /** The class of the svg inside it (`actionIcon_*` / `closeIcon_*`). */
  svgClass: string | null;
  /** The svg's `width` attribute when it is a plain number. */
  svgSize: number | null;
  /** DM close button: the element between the button and the svg, when there is one (null = the svg is a direct child). */
  inner: { className: string | null } | null;
}

const isOwnNode = (el: Element): boolean => el.hasAttribute(OWN);
const isInsideOwnNode = (el: Element): boolean => el.closest(OWN_SELECTOR) !== null;

export function normalizeClass(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().split(/\s+/).join(' ');
  return normalized === '' ? null : normalized;
}

/** Text from the page with whitespace runs collapsed to one space and the ends trimmed. */
export function clean(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * First element in `root`'s OWN subtree (pre-order, document order) that satisfies `test`. A nested row list (`li` / `ul`
 * below `root`, e.g. a channel's threads) belongs to other rows and is not entered; our own nodes are skipped.
 */
export function findOwn(root: Element, test: (el: Element) => boolean): HTMLElement | null {
  const walk = (parent: Element): HTMLElement | null => {
    for (const child of Array.from(parent.children)) {
      if (isOwnNode(child)) continue;
      if (test(child)) return child as HTMLElement;
      if (NESTED_ROW_TAGS.includes(child.tagName)) continue;
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}

// ---- classification ---------------------------------------------------------------------------

function rowRoot(link: Element): HTMLElement {
  const li = link.closest(SELECTOR.rowRoot);
  return (li ?? link.parentElement ?? link) as HTMLElement;
}

/**
 * A category row: its link, or something inside the row, carries `aria-expanded` (PLAN §4). Measured on the live page it sits
 * below the link; looking at the whole row keeps a category from being taken for a channel if Discord moves it (a channel row
 * would then be queued under a category id), and a false positive only makes the button answer "nothing to add".
 */
function isCategoryRow(link: Element, root: Element): boolean {
  return link.hasAttribute(ATTR.ariaExpanded) || findOwn(root, (el) => el.hasAttribute(ATTR.ariaExpanded)) !== null;
}

/** Thread rows: a `typeThread_*` class on the row, or the row sits in a nested list inside another row's `li`. */
function isThreadRow(link: Element, root: Element): boolean {
  if (hasStem(link, STEM.thread) || hasStem(root, STEM.thread)) return true;
  if (findOwn(root, (el) => hasStem(el, STEM.thread))) return true;
  // The nearest `ul[role=group]` above the row, if that list itself sits inside another row's `li` (a channel's thread list).
  const group = root.parentElement?.closest(SELECTOR.nestedGroup) ?? null;
  return group !== null && group.parentElement?.closest(SELECTOR.rowRoot) != null;
}

function describeGuildItem(link: HTMLElement, raw: string): Row | null {
  const itemId = guildItemId(raw);
  if (!itemId) return null; // `channels___channels-<guildId>` and other generic rows
  const root = rowRoot(link);
  const href = link.getAttribute(ATTR.href);
  const ref = parseChannelHref(href);
  if (ref) {
    if (ref.guildId === '@me') return null;
    return { kind: 'channel', id: ref.channelId, guildId: ref.guildId, link, root };
  }
  if (href) return { kind: 'channel', id: itemId, guildId: null, link, root }; // an href this adapter does not know
  // No href: a category, a thread (`div[role=button]`) or a voice / stage channel (`a` without href).
  if (isCategoryRow(link, root)) return { kind: 'category', id: itemId, guildId: null, link, root };
  if (isThreadRow(link, root)) return { kind: 'thread', id: itemId, guildId: null, link, root };
  return { kind: 'voice', id: itemId, guildId: null, link, root };
}

function describeDmItem(link: HTMLElement, raw: string): Row | null {
  const ref = parseChannelHref(link.getAttribute(ATTR.href));
  if (ref && ref.guildId !== '@me') return null;
  const id = ref?.channelId ?? listItemTailId(raw); // the id from the href; `uid_11` in the item id is only a list position
  if (!id) return null; // friends / shop / quests rows have no numeric tail
  return { kind: 'dm', id, guildId: null, link, root: rowRoot(link) };
}

/** Classifies one `[data-list-item-id]` element as a row, or null when it is not one of ours to decorate. */
export function describeRow(link: Element): Row | null {
  if (!(link instanceof HTMLElement) || isOwnNode(link)) return null;
  const raw = link.getAttribute(ATTR.listItemId);
  if (!raw) return null;
  if (raw.startsWith(ITEM_ID.guildPrefix)) return describeGuildItem(link, raw);
  if (raw.startsWith(ITEM_ID.dmPrefix)) return describeDmItem(link, raw);
  return null;
}

/** Every row whose link is `scope` or inside it. */
export function rowsWithin(scope: Element | Document): Row[] {
  const rows: Row[] = [];
  const push = (el: Element): void => {
    const row = describeRow(el);
    if (row) rows.push(row);
  };
  if (scope instanceof Element && scope.matches(SELECTOR.listItem)) push(scope);
  for (const el of Array.from(scope.querySelectorAll(SELECTOR.listItem))) push(el);
  return rows;
}

/**
 * For markup without `li` rows: the node's parent when it holds a row link (an icon container sits next to or below its
 * row's link, one level up at most), else the node itself. One level only: this runs for every node Discord adds anywhere.
 */
function enclosingRowArea(node: Element): Element {
  const parent = node.parentElement;
  return parent && parent.querySelector(SELECTOR.listItem) ? parent : node;
}

/**
 * The rows a newly added node can have changed: rows inside it, the row it sits in, and (because Discord may rebuild only an
 * icon container) every row of the enclosing row element.
 */
export function rowsAffectedBy(node: Element): Row[] {
  const links = new Set<Element>();
  const around = node.closest(SELECTOR.listItem);
  if (around) links.add(around);
  const scope = node.closest(SELECTOR.rowRoot) ?? enclosingRowArea(node);
  if (scope.matches(SELECTOR.listItem)) links.add(scope);
  for (const el of Array.from(scope.querySelectorAll(SELECTOR.listItem))) links.add(el);
  const rows: Row[] = [];
  for (const el of links) {
    const row = describeRow(el);
    if (row) rows.push(row);
  }
  return rows;
}

/** How many guild list items the page shows by their `data-dnd-name` alone, without looking at their links (health check). */
export function countNamedRows(doc: Document): number {
  return doc.querySelectorAll(SELECTOR.namedRow).length;
}

/** Does the page show rows of Discord's sidebars: recognised ones, or at least list items that look like channel rows? */
export function hasSidebarRows(doc: Document): boolean {
  return rowsWithin(doc.body).length > 0 || countNamedRows(doc) > 0;
}

/** The first row of `el` (an `li` of the list): the row's own link comes before any nested thread rows. */
export function firstRowIn(el: Element): Row | null {
  const link = el.matches(SELECTOR.listItem) ? el : el.querySelector(SELECTOR.listItem);
  return link ? describeRow(link) : null;
}

/** The row an id belongs to (a sidebar row with an icon container wins over a bare duplicate), or null when not on screen. */
export function findRowById(doc: Document, id: string): Row | null {
  if (!/^\d+$/.test(id)) return null;
  const rows = Array.from(doc.querySelectorAll(`[${ATTR.listItemId}$="${ITEM_ID.separator}${id}"]`))
    .map((el) => describeRow(el))
    .filter((row): row is Row => row !== null && row.id === id);
  return rows.find((row) => rowContainer(row) !== null) ?? rows[0] ?? null;
}

/** The row one of our buttons sits in, found from the button's position (never from remembered state). */
export function findRowForButton(button: Element): Row | null {
  const key = button.getAttribute(KEY_ATTR);
  let scope: Element | null = button.closest(SELECTOR.rowRoot) ?? button.parentElement;
  for (let depth = 0; scope && depth < 6; depth++, scope = scope.parentElement) {
    const rows = rowsWithin(scope);
    const own = rows.find((row) => rowContainer(row)?.contains(button));
    if (own) return own;
    const byKey = key ? rows.find((row) => row.id === key) : undefined;
    if (byKey) return byKey;
  }
  return null;
}

// ---- icon container and native icon -----------------------------------------------------------

/**
 * Where a row's button lives (docs/PLAN.md §4). Our button is always the LAST child of what this returns, so the icons Discord
 * shows on hover appear to its left and it never moves:
 *  - channel / voice / thread rows -> `children_*` (inside the row link, else anywhere in the row), which holds the invite /
 *    edit icons;
 *  - DM rows -> `iconsContainer_*` (a sibling of the link), which holds the favourite / wave icons and the close button;
 *  - category rows -> the flex line `iconVisibility_*` / `wrapper_*` that holds the title AND `children_*`. `children_*` itself
 *    is `display:none` until the row is hovered, so our button sits OUTSIDE it, after it.
 * null = Discord changed this part of its markup.
 */
export function rowContainer(row: Row): HTMLElement | null {
  if (row.kind === 'dm') return findOwn(row.root, (el) => hasStem(el, STEM.dmContainer));
  const children = (): HTMLElement | null => {
    const test = (el: Element): boolean => hasStem(el, STEM.children);
    return findOwn(row.link, test) ?? findOwn(row.root, test);
  };
  if (row.kind === 'category') {
    const line = findOwn(row.root, (el) => hasStem(el, STEM.rowVisibility) || hasStem(el, STEM.rowWrapper));
    return line ?? children()?.parentElement ?? null;
  }
  return children();
}

/** First descendant of `root` (not inside one of our own nodes) that satisfies `test`. */
function findDescendant(root: Element, test: (el: Element) => boolean): HTMLElement | null {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (isInsideOwnNode(el)) continue;
    if (test(el)) return el as HTMLElement;
  }
  return null;
}

/**
 * The native icon whose look our button copies: `iconItem_*` (channel / voice rows) or `closeButton_*` (DM rows; null when this
 * DM has none, e.g. a brand-new friend). Categories have no icon of a kind that fits, so they never mirror anything.
 */
export function nativeIconIn(row: Row, container: Element): NativeIcon | null {
  if (row.kind === 'category') return null;
  const dm = row.kind === 'dm';
  const button = findDescendant(container, (el) => hasStem(el, dm ? STEM.dmClose : STEM.channelIcon));
  if (!button) return null;
  const svgStem = dm ? STEM.dmCloseSvg : STEM.channelSvg;
  const svg =
    findDescendant(button, (el) => el.tagName.toLowerCase() === 'svg' && hasStem(el, svgStem)) ??
    findDescendant(button, (el) => el.tagName.toLowerCase() === 'svg');
  const width = svg?.getAttribute('width') ?? '';
  const size = /^\d+(?:\.\d+)?$/.test(width) ? Number(width) : null;
  let inner: NativeIcon['inner'] = null;
  if (dm && svg) {
    const first = button.firstElementChild;
    if (first && first !== svg && first.tagName === 'DIV' && first.contains(svg)) {
      inner = { className: normalizeClass(first.getAttribute('class')) };
    }
  }
  return {
    button,
    buttonClass: normalizeClass(button.getAttribute('class')),
    svgClass: svg ? normalizeClass(svg.getAttribute('class')) : null,
    svgSize: size,
    inner,
  };
}

// ---- names and avatar -------------------------------------------------------------------------

/** `Alex (Direct message), online` -> `Alex`; `Name (Text channel)` -> `Name`; no parentheses -> before the first comma. */
export function nameFromLabel(label: string | null | undefined): string {
  const text = clean(label);
  if (text === '') return '';
  const paren = /^(.*?)\s*[(（][^()（）]*[)）](?:\s*,.*)?$/.exec(text);
  if (paren && paren[1]) return paren[1].trim();
  return text.split(',')[0]!.trim();
}

/**
 * The row's display name: `data-dnd-name` of its own `li`, else its name element's text, else its aria-label, else the id
 * (a target needs some name; the background worker resolves the real one through the API).
 */
export function rowName(row: Row): string {
  const own = row.kind === 'dm' ? '' : clean(row.root.getAttribute(ATTR.dndName));
  const fromElement = () => clean(findOwn(row.root, (el) => hasStem(el, STEM.name))?.textContent);
  const name = own || fromElement() || nameFromLabel(row.link.getAttribute(ATTR.ariaLabel)) || row.id;
  return name.slice(0, 500);
}

/** An https avatar / group-icon URL on Discord's CDN (resized for the popup list), or null. */
export function safeAvatarUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !AVATAR_HOSTS.includes(url.hostname) || !AVATAR_PATH.test(url.pathname)) return null;
  if (url.searchParams.has('size')) url.searchParams.set('size', '64');
  return url.toString();
}

/** A DM row's avatar URL, if the row shows one. */
export function dmAvatarUrl(row: Row): string | null {
  for (const img of Array.from(row.link.querySelectorAll(SELECTOR.image))) {
    const url = safeAvatarUrl(img.getAttribute('src'));
    if (url) return url;
  }
  return null;
}
