// @vitest-environment jsdom
/**
 * A checked button (`data-dce-state="queued"`: the chat / category / server is in the download list) shows a cross instead of
 * the check mark while the pointer is on it or it has keyboard focus ("a click takes it out"). That is CSS only, and jsdom cannot
 * evaluate `:hover`, so these tests build the real buttons (the code that the page runs), force the pseudo-classes with the
 * small cascade in helpers/cascade.ts and ask which glyph is drawn, with a stand-in for Discord's own hover-only rules in the page.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { FRESH_ATTR } from '@/content/config';
import type { NativeIcon, RowKind } from '@/content/dom/rows';
import { applyState, createButton, identifyButton, planStyle } from '@/content/inject/button';
import { ClassCache } from '@/content/inject/classCache';
import { GuildButtons } from '@/content/inject/guildButton';
import { CHECK_PATH, DOWNLOAD_PATH, REMOVE_PATH, currentIcon } from '@/content/inject/icons';
import css from '@/content/styles.css?inline';
import { focusVisible, hover, isRendered, displayOf, parseSheets, press, rest, type CascadeRule } from '../helpers/cascade';
import {
  CHANNEL_ICON_CLASS,
  CHANNEL_SVG_CLASS,
  DM_CLOSE_CLASS,
  DM_CLOSE_SVG_CLASS,
  GUILD,
  ID,
  guildButtons,
  guildHeader,
  guildSidebar,
} from '../helpers/fixtures';

/** What Discord's own stylesheet does to the classes we mirror: the icons are hidden until the row is hovered (we are never in a hovered row here). */
const DISCORD_CSS = `
.iconItem_c69b6d, .closeButton__972a0 { display: none; }
.wrapper__2ea32:hover .iconItem_c69b6d, .wrapper__2ea32:hover .closeButton__972a0 { display: flex; }
.actionIcon_c69b6d, .closeIcon__972a0 { width: 16px; height: 16px; }
.inviteButton_f37cb1 { display: flex; width: 32px; height: 32px; }
`;

/** The page's rules: Discord's first, ours appended last (the `<style id="dce-style">` goes to the end of the head). */
const rules: CascadeRule[] = parseSheets(DISCORD_CSS, css);

interface Subject {
  button: HTMLElement;
  /** Checks / unchecks it the way the page does (the state attribute, the label, the state glyph). */
  set(queued: boolean): void;
}

const LEARNED = { channelIcon: CHANNEL_ICON_CLASS, channelSvg: CHANNEL_SVG_CLASS, dmButton: DM_CLOSE_CLASS, dmSvg: DM_CLOSE_SVG_CLASS };

function nativeIcon(kind: RowKind): NativeIcon {
  const dm = kind === 'dm';
  return {
    button: document.createElement('div'),
    buttonClass: dm ? DM_CLOSE_CLASS : CHANNEL_ICON_CLASS,
    svgClass: dm ? DM_CLOSE_SVG_CLASS : CHANNEL_SVG_CLASS,
    svgSize: 16,
    inner: dm ? { className: null } : null,
  };
}

function rowSubject(kind: RowKind, look: 'native' | 'cache' | 'fallback', queued: boolean): Subject {
  const cache = new ClassCache(look === 'cache' ? LEARNED : {});
  const style = planStyle(kind, look === 'native' ? nativeIcon(kind) : null, cache);
  expect(style.source).toBe(look); // the case is the look it says it is
  const button = createButton(document, style);
  identifyButton(button, ID.general, kind);
  const set = (value: boolean): void => applyState(button, { queued: value, label: value ? 'remove' : 'add' });
  set(queued);
  document.body.appendChild(button);
  return { button, set };
}

function guildSubject(look: 'native' | 'fallback', queued: boolean): Subject {
  document.body.innerHTML = guildSidebar(guildHeader({ invite: look === 'native' }));
  let checked = queued;
  const buttons = new GuildButtons(document, { guildId: () => GUILD, checked: () => checked, label: (c) => (c ? 'remove' : 'add'), busy: () => false });
  expect(buttons.ensure()).toBe(true);
  const button = guildButtons()[0]!;
  expect(button.getAttribute('data-dce-src')).toBe(look);
  return {
    button,
    set(value) {
      checked = value;
      buttons.sync();
    },
  };
}

interface Case {
  name: string;
  make(queued: boolean): Subject;
}

const CASES: Case[] = [
  { name: 'channel row, native look (iconItem_* classes)', make: (q) => rowSubject('channel', 'native', q) },
  { name: 'channel row, learned look', make: (q) => rowSubject('channel', 'cache', q) },
  { name: 'voice row, learned look', make: (q) => rowSubject('voice', 'cache', q) },
  { name: 'voice row, our fallback .dce-row-btn', make: (q) => rowSubject('voice', 'fallback', q) },
  { name: 'thread row, learned look', make: (q) => rowSubject('thread', 'cache', q) },
  { name: 'thread row, our fallback .dce-row-btn', make: (q) => rowSubject('thread', 'fallback', q) },
  { name: 'category, learned look', make: (q) => rowSubject('category', 'cache', q) },
  { name: 'category, our fallback .dce-row-btn', make: (q) => rowSubject('category', 'fallback', q) },
  { name: 'DM, native look (closeButton_* > div > svg)', make: (q) => rowSubject('dm', 'native', q) },
  { name: 'DM, our fallback .dce-row-btn (a flex box)', make: (q) => rowSubject('dm', 'fallback', q) },
  { name: 'server button, native look (the invite button`s classes)', make: (q) => guildSubject('native', q) },
  { name: 'server button, our fallback .dce-guild-btn', make: (q) => guildSubject('fallback', q) },
];

/** The glyphs of the button that are drawn right now, by name. */
function shown(button: HTMLElement): string[] {
  return Array.from(button.querySelectorAll('path'))
    .filter((path) => isRendered(path, rules))
    .map((path) => path.getAttribute('data-dce-glyph') ?? '?');
}

/** `d` of the glyph that is drawn (exactly one is). */
function drawnPath(button: HTMLElement): string | null {
  const drawn = Array.from(button.querySelectorAll('path')).filter((path) => isRendered(path, rules));
  expect(drawn).toHaveLength(1);
  return drawn[0]!.getAttribute('d');
}

/** What a layout engine would see of the button: its display, its svg's display and size. Must not change with the pointer. */
function geometry(button: HTMLElement): string {
  const svg = button.querySelector('svg')!;
  return [displayOf(button, rules), displayOf(svg, rules), svg.getAttribute('width'), svg.getAttribute('height'), svg.getAttribute('viewBox')].join('|');
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe.each(CASES)('$name', ({ make }) => {
  it('checked, nobody on it: the check mark is drawn, not the cross', () => {
    const { button } = make(true);
    expect(button.getAttribute('data-dce-state')).toBe('queued');
    expect(shown(button)).toEqual(['state']);
    expect(drawnPath(button)).toBe(CHECK_PATH);
  });

  it('checked + hovered: the cross wins over the check mark (and only the cross is drawn)', () => {
    const { button } = make(true);
    hover(button);
    expect(shown(button)).toEqual(['remove']);
    expect(drawnPath(button)).toBe(REMOVE_PATH);
  });

  it('checked + keyboard focus (:focus-visible): the same', () => {
    const { button } = make(true);
    focusVisible(button);
    expect(shown(button)).toEqual(['remove']);
  });

  it('checked + hovered + pressed: still the cross', () => {
    const { button } = make(true);
    hover(button);
    press(button);
    expect(shown(button)).toEqual(['remove']);
  });

  it('checked but just added by the user`s click (data-dce-fresh): hovered or focused, the check mark stays; without the mark the cross shows', () => {
    const { button } = make(true);
    button.setAttribute(FRESH_ATTR, '');
    hover(button);
    expect(shown(button)).toEqual(['state']);
    expect(drawnPath(button)).toBe(CHECK_PATH);
    focusVisible(button);
    press(button);
    expect(shown(button)).toEqual(['state']);
    button.removeAttribute(FRESH_ATTR); // the pointer left (or the timeout ran out) and came back: the mark is gone
    expect(shown(button)).toEqual(['remove']);
    expect(drawnPath(button)).toBe(REMOVE_PATH);
  });

  it('the fresh mark changes nothing about size or display, and on an unchecked button it changes nothing at all', () => {
    const { button, set } = make(true);
    const resting = geometry(button);
    button.setAttribute(FRESH_ATTR, '');
    hover(button);
    expect(geometry(button)).toBe(resting);
    set(false); // (the script drops the mark when the button turns unchecked; this stale one must not matter either)
    expect(shown(button)).toEqual(['state']);
    expect(drawnPath(button)).toBe(DOWNLOAD_PATH);
    expect(geometry(button)).toBe(resting);
  });

  it('leaving the hover restores the check mark', () => {
    const { button } = make(true);
    hover(button);
    expect(shown(button)).toEqual(['remove']);
    rest(button);
    expect(shown(button)).toEqual(['state']);
    expect(drawnPath(button)).toBe(CHECK_PATH);
  });

  it('the icon API keeps reporting the STATE icon while the cross is shown', () => {
    const { button } = make(true);
    hover(button);
    expect(currentIcon(button)).toBe('check');
    expect(button.querySelector('path')!.getAttribute('d')).toBe(CHECK_PATH); // the first path is still the state glyph
    expect(button.getAttribute('data-dce-state')).toBe('queued');
  });

  it('not checked: never the cross, whatever the pointer or the focus does (the arrow stays)', () => {
    const { button } = make(false);
    expect(button.getAttribute('data-dce-state')).toBe('idle');
    for (const force of [() => undefined, () => hover(button), () => focusVisible(button), () => press(button)]) {
      force();
      expect(shown(button)).toEqual(['state']);
      expect(drawnPath(button)).toBe(DOWNLOAD_PATH);
    }
    rest(button);
    hover(button);
    focusVisible(button);
    press(button);
    expect(shown(button)).toEqual(['state']); // all of them together
    expect(currentIcon(button)).toBe('download');
  });

  it('the click that removes it, with the pointer still on the button: the cross gives way to the arrow at once', () => {
    const { button, set } = make(true);
    hover(button);
    expect(drawnPath(button)).toBe(REMOVE_PATH);
    set(false);
    expect(button.getAttribute('data-dce-state')).toBe('idle');
    expect(drawnPath(button)).toBe(DOWNLOAD_PATH);
    set(true); // and checking it again under the pointer shows the cross
    expect(drawnPath(button)).toBe(REMOVE_PATH);
  });

  it('the button and its svg keep display and size in every state (no flicker, no jump)', () => {
    const { button, set } = make(true);
    const resting = geometry(button);
    hover(button);
    expect(geometry(button)).toBe(resting);
    focusVisible(button);
    expect(geometry(button)).toBe(resting);
    rest(button);
    set(false);
    expect(geometry(button)).toBe(resting);
    hover(button);
    expect(geometry(button)).toBe(resting);
  });

  it('the button stays drawn (Discord hides the mirrored classes until the row is hovered; our forcing rules win), in every state', () => {
    const { button } = make(true);
    expect(isRendered(button, rules)).toBe(true);
    hover(button);
    expect(isRendered(button, rules)).toBe(true);
    rest(button);
    focusVisible(button);
    expect(isRendered(button, rules)).toBe(true);
  });

  it('nothing is written inline: showing and hiding the glyphs is the stylesheet`s job alone', () => {
    const { button } = make(true);
    for (const el of [button, ...Array.from(button.querySelectorAll('*'))]) {
      expect(el.hasAttribute('style'), el.tagName).toBe(false);
      if (el.tagName.toLowerCase() === 'path') expect(el.hasAttribute('display'), 'path').toBe(false);
    }
  });
});

describe('what the rules do and do not reach', () => {
  it('a button whose state is not set yet (a fresh one, before the first pass) never swaps', () => {
    const style = planStyle('channel', null, new ClassCache({}));
    const button = createButton(document, style);
    document.body.appendChild(button);
    expect(button.hasAttribute('data-dce-state')).toBe(false);
    hover(button);
    focusVisible(button);
    expect(shown(button)).toEqual(['state']);
  });

  it('only OUR buttons are affected: a Discord element with an svg of its own, hovered, is left alone', () => {
    document.body.innerHTML = '<div class="iconItem_c69b6d" role="button"><svg width="16" height="16"><path d="M0 0h2v2H0z"></path></svg></div>';
    const native = document.querySelector<HTMLElement>('.iconItem_c69b6d')!;
    hover(native);
    focusVisible(native);
    const path = native.querySelector('path')!;
    expect(displayOf(path, rules)).toBe('inline'); // nothing declares anything for it
    expect(path.hasAttribute('data-dce-glyph')).toBe(false);
  });

  it('an unrelated hovered ancestor (the row) does not reveal the cross of a checked button: the pointer has to be on the button`s own :hover', () => {
    const { button } = rowSubject('channel', 'native', true);
    const row = document.createElement('div');
    row.className = 'wrapper__2ea32';
    document.body.appendChild(row);
    row.appendChild(button);
    // `hover()` marks the button and its ancestors; marking ONLY the row (a sibling of the icon, say) must not do it.
    row.setAttribute('data-t-hover', '');
    expect(shown(button)).toEqual(['state']);
    hover(button);
    expect(shown(button)).toEqual(['remove']);
  });
});
