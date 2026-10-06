/**
 * Names and timings shared by the content script's modules. Nothing here depends on Discord's markup (that is
 * dom/selectors.ts); everything here describes OUR nodes.
 */

/** Marker attribute on every node the content script inserts into the page (the value says what it is). */
export const OWN = 'data-dce';
export const OWN_SELECTOR = `[${OWN}]`;
export const OWN_VALUE = {
  button: 'row-btn',
  /** The server-wide button of the guild header (`span > div`: `guildWrap` is the span, `guildButton` the div). */
  guildButton: 'guild-btn',
  guildWrap: 'guild-wrap',
  root: 'root',
  style: 'style',
  tooltip: 'tooltip',
  toast: 'toast',
} as const;
/** Selector of our row buttons (also what `ensure` looks for: the marker attribute is the source of truth, not a cache). */
export const BUTTON_SELECTOR = `[${OWN}="${OWN_VALUE.button}"]`;
/** The server button and the `span` it sits in (the guild header, docs/PLAN.md §4). */
export const GUILD_BUTTON_SELECTOR = `[${OWN}="${OWN_VALUE.guildButton}"]`;
export const GUILD_WRAP_SELECTOR = `[${OWN}="${OWN_VALUE.guildWrap}"]`;
/** Every button of ours a person can click: what the capture-phase handlers recognise. */
export const CLICKABLE_SELECTOR = `${BUTTON_SELECTOR}, ${GUILD_BUTTON_SELECTOR}`;

/** Row id of a button (channel / thread / DM id, or the category id for a category button; the guild id on the server button). */
export const KEY_ATTR = 'data-dce-key';
/** `RowKind` of the row a button belongs to (channel, voice, thread, category, dm). */
export const KIND_ATTR = 'data-dce-kind';
/** `idle` | `queued`. */
export const STATE_ATTR = 'data-dce-state';
/** Where the button's look comes from: `native` (mirrored from a neighbour), `cache` (learned earlier), `fallback` (our CSS). */
export const SRC_ATTR = 'data-dce-src';
/**
 * Our own class on every row button (docs/PLAN.md §2 "버튼 표시"): it forces the button to be visible (`display:block !important`,
 * `flex` for a DM), so Discord's hover-only rules (`iconItem_*`, `closeButton_*` are `display:none` until the row is hovered)
 * can never hide it. The mirrored native classes keep everything else (size, colour, hover, selected).
 */
export const FORCE_CLASS = 'dce-always';

/**
 * Which glyph a `path` inside our button svg is (the svg holds both, see inject/icons.ts): `state` = the download arrow / check mark
 * that the state attribute decides, `remove` = the cross that styles.css shows INSTEAD of the check mark while a checked button is
 * hovered or keyboard-focused ("a click takes it out of the list"). Only ours: the marker is not `data-dce` itself, so nothing
 * that looks for our nodes (`OWN_SELECTOR`) sees it.
 */
export const GLYPH_ATTR = 'data-dce-glyph';
export const GLYPH_VALUE = { state: 'state', remove: 'remove' } as const;

/**
 * Present on a button that became checked because of the user's own click (inject/fresh.ts) while the pointer is still on it:
 * styles.css does not swap the check mark for the cross as long as it is there, so the confirmation is seen. Only ever on our button.
 */
export const FRESH_ATTR = 'data-dce-fresh';

export const STYLE_ID = 'dce-style';
export const ROOT_ID = 'dce-root';

export const TIMING = {
  /** PLAN §7.1: the toast stays 2.5 s. */
  toastMs: 2500,
  /** Fade-out time before the toast node is removed. */
  toastFadeMs: 200,
  /** Rows without any icon container for this long = report an injection failure (PLAN §4 health). */
  healthFailMs: 10_000,
  /** The same health state is not sent again before this. */
  healthRepeatMs: 300_000,
  /** `queue/groupInfo` for the same server is not sent again before this (per page; PLAN §2 "그룹 정보"). */
  groupInfoMs: 300_000,
  /**
   * A `queue/groupInfo` the worker answered `no-account` (it does not know the account yet, although the page may) is tried again
   * after this, instead of waiting out the whole 5 minutes: the account the worker confirms later is often the one the page
   * already had, so no storage event says "an account is known now".
   */
  groupInfoRetryMs: 20_000,
  /** At most this many of those short retries per server and 5-minute window (a worker that never gets an account is not hammered). */
  groupInfoRetries: 6,
  /** A group button's answer-based check state yields to the stored one after this at the latest (state.ts). */
  groupOverrideMs: 10_000,
  /** The "just added" mark of a button (`FRESH_ATTR`) goes after this at the latest, whatever the pointer did (inject/fresh.ts). */
  freshMs: 8_000,
  /** A click whose request never reports back stops counting as "awaiting its result" after this. */
  freshAwaitMs: 30_000,
  /** After the request is answered, a state that the storage confirms a moment later still counts as that click's result. */
  freshGraceMs: 1_500,
  themeDebounceMs: 400,
  classCacheDebounceMs: 1_000,
  /** How often an idle page checks that the extension (its `chrome.runtime.id`) is still alive. */
  aliveCheckMs: 10_000,
  /** `requestAnimationFrame` does not run in a hidden tab: a timer flushes the queue anyway so it cannot grow. */
  flushFallbackMs: 250,
} as const;

/** More pending nodes than this = forget them and rescan the whole page once (bounded memory in a busy hidden tab). */
export const MAX_PENDING_NODES = 2000;
