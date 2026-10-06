// @vitest-environment jsdom
/**
 * The "just added" mark, end to end (inject/fresh.ts): after the click that ADDS an item the pointer is still on the button, and
 * the stylesheet's check mark -> cross swap on hover must not hide the check mark before it was seen. The button carries
 * `data-dce-fresh` from the moment it turns checked as the click's result until the pointer leaves (pointerout + mouseout) / it loses focus / 8 s pass.
 * The CSS itself is judged with the small cascade of helpers/cascade.ts (jsdom has no `:hover`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRESH_ATTR, TIMING } from '@/content/config';
import { CHECK_PATH, DOWNLOAD_PATH, REMOVE_PATH } from '@/content/inject/icons';
import css from '@/content/styles.css?inline';
import type { ToBackground } from '@/shared/messages';
import { LOCAL } from '@/shared/storageKeys';
import { ACCOUNT, boot, type Booted } from './helpers/app';
import { focusVisible, hover, isRendered, parseSheets, rest } from './helpers/cascade';
import {
  GUILD,
  ID,
  byKey,
  categoryRow,
  channelRow,
  dmRow,
  guildButtons,
  guildHeader,
  guildSidebar,
  rowOf,
  setPage,
} from './helpers/fixtures';

let ctx: Booted | null = null;

const rules = parseSheets(css);

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  document.documentElement.className = '';
  document.documentElement.removeAttribute('lang');
  setPage(`/channels/${GUILD}/${ID.general}`, 'Discord | #general | Server One');
});

afterEach(() => {
  ctx?.app.destroy();
  ctx = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const page = (): string =>
  guildSidebar(
    guildHeader(),
    categoryRow({ id: ID.categoryA, name: 'Category A' }),
    channelRow({ id: ID.general, name: 'general' }),
    channelRow({ id: ID.random, name: 'random' }),
  );

const guildButton = (): HTMLElement => guildButtons()[0]!;
const click = (el: Element): void => void el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
/**
 * The pointer moves off `el` to `to` (null = out of the window) the way real Chrome reports it to a window-level capture
 * listener (measured live): `pointerout` and `mouseout`, both bubbling. NO `mouseleave` / `pointerleave` ever reaches the window.
 */
function leave(el: Element, to: Element | null = document.body): Event[] {
  const events = (['pointerout', 'mouseout'] as const).map((type) => new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget: to }));
  for (const event of events) el.dispatchEvent(event);
  return events;
}
/** One of the two out events alone. */
const out = (type: 'pointerout' | 'mouseout', el: Element, to: Element | null): void =>
  void el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget: to }));
const blur = (el: Element): void => void el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
const isFresh = (el: Element): boolean => el.hasAttribute(FRESH_ATTR);
const stateOf = (el: Element): string | null => el.getAttribute('data-dce-state');

/** The glyphs of the button that are drawn right now. */
function shown(button: HTMLElement): string[] {
  return Array.from(button.querySelectorAll('path'))
    .filter((path) => isRendered(path, rules))
    .map((path) => path.getAttribute('data-dce-glyph') ?? '?');
}

/** A worker that toggles like the real one. */
function toggleResponder(initial: string[] = []): (message: ToBackground) => unknown {
  const queued = new Set(initial);
  return (message) => {
    if (message.type !== 'queue/toggle') return { ok: false, error: 'invalid' };
    const key = message.target.channelId;
    if (queued.has(key)) queued.delete(key);
    else queued.add(key);
    return { ok: true, data: { queued: queued.has(key) } };
  };
}

const groupAnswer =
  (added: number, removed = 0) =>
  (message: ToBackground): unknown =>
    message.type === 'queue/addCategory' || message.type === 'queue/addGuild' ? { ok: true, data: { added, skipped: 0, removed } } : { ok: false, error: 'invalid' };

describe('a row button: the click that adds', () => {
  it('is marked fresh once it is checked; with the pointer on it the check mark stays, and after leaving and coming back the cross shows', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(toggleResponder());
    const button = byKey(ID.general)!;
    expect(isFresh(button)).toBe(false);
    click(button);
    await ctx.settle();

    expect(stateOf(button)).toBe('queued');
    expect(isFresh(button)).toBe(true);
    hover(button); // the pointer never moved
    expect(shown(button)).toEqual(['state']);
    expect(button.querySelector('path')!.getAttribute('d')).toBe(CHECK_PATH);

    leave(button);
    expect(isFresh(button)).toBe(false);
    rest(button);
    hover(button); // the next visit
    expect(shown(button)).toEqual(['remove']);
  });

  it('clicking again while it is still fresh REMOVES the item (the click handler is the same), and the mark goes with the check', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(toggleResponder());
    const button = byKey(ID.general)!;
    click(button);
    await ctx.settle();
    expect(isFresh(button)).toBe(true);

    click(button);
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')).toHaveLength(2);
    expect(stateOf(button)).toBe('idle');
    expect(isFresh(button)).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('다운로드 목록에 추가');
    hover(button);
    expect(shown(button)).toEqual(['state']);
    expect(button.querySelector('path')!.getAttribute('d')).toBe(DOWNLOAD_PATH);
  });

  it('adding again after that is fresh again (each add has its own confirmation)', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(toggleResponder());
    const button = byKey(ID.general)!;
    for (const expected of [true, false, true]) {
      click(button);
      await ctx.settle();
      expect(isFresh(button)).toBe(expected);
    }
  });

  it('the click that removes an item does not mark anything', async () => {
    ctx = await boot({ html: page(), queue: [ID.general] });
    ctx.chrome.respond(toggleResponder([ID.general]));
    const button = byKey(ID.general)!;
    click(button);
    await ctx.settle();
    expect(stateOf(button)).toBe('idle');
    expect(isFresh(button)).toBe(false);
  });

  it('a click that fails marks nothing', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(() => ({ ok: false, error: 'no-account' }));
    const button = byKey(ID.general)!;
    click(button);
    await ctx.settle();
    expect(stateOf(button)).toBe('idle');
    expect(isFresh(button)).toBe(false);
  });

  it('works when the storage event comes BEFORE the worker`s answer (the worker writes first)', async () => {
    ctx = await boot({ html: page() });
    let answer: (value: unknown) => void = () => undefined;
    ctx.chrome.respond(() => new Promise((resolve) => (answer = resolve)));
    const button = byKey(ID.general)!;
    click(button);
    await ctx.settle();
    expect(stateOf(button)).toBe('idle'); // no answer yet
    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [{ key: ID.general }] });
    await ctx.settle();
    expect(stateOf(button)).toBe('queued');
    expect(isFresh(button)).toBe(true);
    answer({ ok: true, data: { queued: true } });
    await ctx.settle();
    expect(stateOf(button)).toBe('queued');
    expect(isFresh(button)).toBe(true);
  });

  it('the pointer left before the answer came: nothing is marked (nobody is looking at the check mark under the pointer)', async () => {
    ctx = await boot({ html: page() });
    let answer: (value: unknown) => void = () => undefined;
    ctx.chrome.respond(() => new Promise((resolve) => (answer = resolve)));
    const button = byKey(ID.general)!;
    click(button);
    await ctx.settle();
    leave(button);
    answer({ ok: true, data: { queued: true } });
    await ctx.settle();
    expect(stateOf(button)).toBe('queued');
    expect(isFresh(button)).toBe(false);
  });
});

describe('a state that does not come from the user`s click on this button', () => {
  it('a storage sync alone (another tab, the popup) marks nothing, and the cross shows on hover', async () => {
    ctx = await boot({ html: page() });
    const button = byKey(ID.general)!;
    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [{ key: ID.general }] });
    await ctx.settle();
    expect(stateOf(button)).toBe('queued');
    expect(isFresh(button)).toBe(false);
    hover(button);
    expect(shown(button)).toEqual(['remove']);
  });

  it('a page that opens with the item already in the list has no mark: hover and keyboard focus show the cross', async () => {
    ctx = await boot({ html: page(), queue: [ID.general] });
    const button = byKey(ID.general)!;
    expect(isFresh(button)).toBe(false);
    hover(button);
    expect(shown(button)).toEqual(['remove']);
    rest(button);
    focusVisible(button);
    expect(shown(button)).toEqual(['remove']); // Tab focus without a click is unaffected
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(isFresh(button)).toBe(false);
  });

  it('a click on ANOTHER button does not mark this one when it turns checked from a storage sync', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(toggleResponder());
    const [clicked, other] = [byKey(ID.general)!, byKey(ID.random)!];
    click(clicked);
    await ctx.settle();
    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [{ key: ID.general }, { key: ID.random }] });
    await ctx.settle();
    expect(stateOf(other)).toBe('queued');
    expect([isFresh(clicked), isFresh(other)]).toEqual([true, false]);
  });

  it('the shortcut (no button involved) marks nothing', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(toggleResponder());
    ctx.chrome.message({ to: 'content', type: 'shortcut/toggleCurrent' });
    await ctx.settle();
    expect(stateOf(byKey(ID.general)!)).toBe('queued');
    expect(document.querySelectorAll(`[${FRESH_ATTR}]`)).toHaveLength(0);
  });
});

describe('when the mark goes', () => {
  it('the pointer leaves the button (Chrome`s sequence: pointerout + mouseout, no mouseleave)', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(toggleResponder());
    const button = byKey(ID.general)!;
    click(button);
    await ctx.settle();
    expect(isFresh(button)).toBe(true);
    leave(button);
    expect(isFresh(button)).toBe(false);
  });

  it('either out event alone is enough, to anywhere outside the button, or out of the window (relatedTarget null)', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(toggleResponder());
    const button = byKey(ID.general)!;
    const cases: ['pointerout' | 'mouseout', Element | null][] = [
      ['pointerout', document.body],
      ['mouseout', document.body],
      ['pointerout', null],
      ['mouseout', null],
      ['mouseout', rowOf(ID.general)], // onto the row it sits in
      ['pointerout', byKey(ID.random)!], // onto a neighbour button of ours
    ];
    for (const [type, to] of cases) {
      if (stateOf(button) === 'queued') {
        click(button); // take it out of the list again...
        await ctx.settle();
      }
      click(button); // ...and add it
      await ctx.settle();
      expect(isFresh(button), `${type} -> ${to?.tagName ?? 'null'}: marked first`).toBe(true);
      out(type, button, to);
      expect(isFresh(button), `${type} -> ${to?.tagName ?? 'null'}`).toBe(false);
    }
  });

  it('moving between the button`s own parts (button, svg, paths) is not leaving: the mark stays', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(toggleResponder());
    const button = byKey(ID.general)!;
    click(button);
    await ctx.settle();
    const svg = button.querySelector('svg')!;
    const [state, remove] = Array.from(button.querySelectorAll('path')) as Element[];
    const moves: [Element, Element][] = [
      [button, svg],
      [svg, button],
      [svg, state!],
      [state!, remove!],
      [remove!, svg],
      [state!, button],
    ];
    for (const [from, to] of moves) {
      out('pointerout', from, to);
      out('mouseout', from, to);
      expect(isFresh(button)).toBe(true);
    }
    // ...and leaving from one of those parts to the outside is leaving
    out('mouseout', svg, document.body);
    expect(isFresh(button)).toBe(false);
  });

  it('the DM wrapper (closeButton > div > svg) is part of the button too', async () => {
    ctx = await boot({ html: page() + '<nav><ul>' + dmRow({ id: ID.dm, name: 'Alex' }) + '</ul></nav>' });
    ctx.chrome.respond(toggleResponder());
    const button = byKey(ID.dm)!;
    click(button);
    await ctx.settle();
    expect(isFresh(button)).toBe(true);
    const wrapper = button.firstElementChild!;
    out('mouseout', button, wrapper);
    out('mouseout', wrapper, button.querySelector('svg'));
    expect(isFresh(button)).toBe(true);
    leave(wrapper);
    expect(isFresh(button)).toBe(false);
  });

  it('blur (focusout) of the button', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(toggleResponder());
    const button = byKey(ID.general)!;
    click(button);
    await ctx.settle();
    blur(button);
    expect(isFresh(button)).toBe(false);
  });

  it('the pointer leaving something else (the row, a neighbour button) does not end it', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(toggleResponder());
    const button = byKey(ID.general)!;
    click(button);
    await ctx.settle();
    leave(rowOf(ID.general));
    leave(byKey(ID.random)!);
    blur(byKey(ID.random)!);
    expect(isFresh(button)).toBe(true);
  });

  it('8 s later, even if no pointer event came', async () => {
    vi.useFakeTimers();
    ctx = await boot({ html: page() });
    ctx.chrome.respond(toggleResponder());
    const button = byKey(ID.general)!;
    click(button);
    await ctx.settle();
    expect(isFresh(button)).toBe(true);
    await vi.advanceTimersByTimeAsync(TIMING.freshMs - 1);
    expect(isFresh(button)).toBe(true);
    hover(button);
    expect(shown(button)).toEqual(['state']);
    await vi.advanceTimersByTimeAsync(1);
    expect(isFresh(button)).toBe(false);
    expect(shown(button)).toEqual(['remove']); // still hovered: now it says "remove"
  });

  it('the buttons are switched off: no mark and no timer is left behind', async () => {
    vi.useFakeTimers();
    ctx = await boot({ html: page() });
    ctx.chrome.respond(toggleResponder());
    click(byKey(ID.general)!);
    await ctx.settle();
    ctx.chrome.set({ [LOCAL.settings]: { showButtons: false } });
    await ctx.settle();
    expect(document.querySelectorAll('[data-dce]')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(TIMING.freshMs + 1000);
    expect(document.querySelectorAll(`[${FRESH_ATTR}]`)).toHaveLength(0);
  });
});

describe('the interaction layer around it', () => {
  it('the out events are only observed: not prevented, not stopped, they still reach the row and the page`s own listeners', async () => {
    ctx = await boot({ html: page() });
    const row = rowOf(ID.general);
    const seen: string[] = [];
    for (const target of [document.body, row]) {
      const name = target === row ? 'row' : 'body';
      for (const type of ['pointerout', 'mouseout']) {
        target.addEventListener(type, () => seen.push(`${name} ${type} bubble`));
        target.addEventListener(type, () => seen.push(`${name} ${type} capture`), true);
      }
    }
    const events = leave(byKey(ID.general)!, document.body);
    for (const event of events) expect(event.defaultPrevented, event.type).toBe(false);
    expect(seen.sort()).toEqual(
      ['body mouseout bubble', 'body mouseout capture', 'body pointerout bubble', 'body pointerout capture', 'row mouseout bubble', 'row mouseout capture', 'row pointerout bubble', 'row pointerout capture'],
    );
  });

  it('the tooltip still goes with the pointer (mouseout), and moving inside the button keeps it', async () => {
    ctx = await boot({ html: page() });
    const button = byKey(ID.general)!;
    button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    const visible = (): string | null | undefined => document.querySelector('[data-dce="tooltip"]')?.getAttribute('data-visible');
    expect(visible()).toBe('true');
    out('mouseout', button, button.querySelector('svg'));
    expect(visible()).toBe('true');
    leave(button);
    expect(visible()).toBe('false');
  });

  it('click isolation still holds: a click on the button never reaches the row, the mark or not', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(toggleResponder());
    const row = rowOf(ID.general);
    const reached: string[] = [];
    row.addEventListener('click', () => reached.push('row'));
    row.addEventListener('click', () => reached.push('row-capture'), true);
    const button = byKey(ID.general)!;
    click(button);
    await ctx.settle();
    click(button);
    await ctx.settle();
    expect(reached).toEqual([]);
  });

  it('Enter on the focused button is a click too: the result is marked, blur ends it', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(toggleResponder());
    const button = byKey(ID.general)!;
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await ctx.settle();
    expect(stateOf(button)).toBe('queued');
    expect(isFresh(button)).toBe(true);
    focusVisible(button);
    expect(shown(button)).toEqual(['state']);
    blur(button);
    expect(isFresh(button)).toBe(false);
  });

  it('only our buttons ever carry the mark', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(toggleResponder());
    click(byKey(ID.general)!);
    await ctx.settle();
    for (const el of Array.from(document.querySelectorAll(`[${FRESH_ATTR}]`))) expect(el.getAttribute('data-dce')).toBe('row-btn');
    expect(document.querySelectorAll(`[${FRESH_ATTR}]`)).toHaveLength(1);
  });
});

describe('category and server buttons', () => {
  it('the category button: marked when the click checks it, not when the click unchecks it', async () => {
    ctx = await boot({ html: page() });
    const button = byKey(ID.categoryA)!;
    ctx.chrome.respond(groupAnswer(2));
    click(button);
    await ctx.settle();
    expect(stateOf(button)).toBe('queued');
    expect(isFresh(button)).toBe(true);
    hover(button);
    expect(shown(button)).toEqual(['state']);
    leave(button);
    rest(button);
    hover(button);
    expect(shown(button)).toEqual(['remove']);

    ctx.chrome.respond(groupAnswer(0, 2));
    click(button);
    await ctx.settle();
    expect(stateOf(button)).toBe('idle');
    expect(isFresh(button)).toBe(false);
  });

  it('the category button checked by a storage sync (its channels added elsewhere) is not marked', async () => {
    ctx = await boot({ html: page(), groups: { [ID.categoryA]: [ID.general, ID.random] } });
    const button = byKey(ID.categoryA)!;
    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [{ key: ID.general }, { key: ID.random }] });
    await ctx.settle();
    expect(stateOf(button)).toBe('queued');
    expect(isFresh(button)).toBe(false);
  });

  it('the server button: marked when the click checks it, the cross after the pointer comes back, clicking while fresh unchecks it', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(groupAnswer(3));
    click(guildButton());
    await ctx.settle();
    expect(stateOf(guildButton())).toBe('queued');
    expect(isFresh(guildButton())).toBe(true);
    expect(guildButton().hasAttribute('aria-busy')).toBe(false);
    hover(guildButton());
    expect(shown(guildButton())).toEqual(['state']);
    leave(guildButton());
    rest(guildButton());
    hover(guildButton());
    expect(shown(guildButton())).toEqual(['remove']);
    expect(guildButton().querySelector('path')!.getAttribute('d')).toBe(CHECK_PATH);
    expect(guildButton().querySelector('path[data-dce-glyph="remove"]')!.getAttribute('d')).toBe(REMOVE_PATH);

    // again, while fresh: removes
    ctx.chrome.respond(groupAnswer(0, 3));
    click(guildButton());
    await ctx.settle();
    expect(stateOf(guildButton())).toBe('idle');
    expect(isFresh(guildButton())).toBe(false);
  });

  it('the server button: a state from a storage sync alone is not marked', async () => {
    ctx = await boot({ html: page(), groups: { [GUILD]: [ID.general] } });
    expect(stateOf(guildButton())).toBe('idle');
    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [{ key: ID.general }] });
    await ctx.settle();
    expect(stateOf(guildButton())).toBe('queued');
    expect(isFresh(guildButton())).toBe(false);
  });

  it('the server button: the mark ends when the pointer leaves, on blur and after 8 s', async () => {
    vi.useFakeTimers();
    ctx = await boot({ html: page() });
    ctx.chrome.respond(groupAnswer(3));
    click(guildButton());
    await ctx.settle();
    expect(isFresh(guildButton())).toBe(true);
    leave(guildButton());
    expect(isFresh(guildButton())).toBe(false);

    ctx.chrome.respond(groupAnswer(0, 3));
    click(guildButton());
    await ctx.settle();
    ctx.chrome.respond(groupAnswer(3));
    click(guildButton());
    await ctx.settle();
    expect(isFresh(guildButton())).toBe(true);
    blur(guildButton());
    expect(isFresh(guildButton())).toBe(false);

    ctx.chrome.respond(groupAnswer(0, 3));
    click(guildButton());
    await ctx.settle();
    ctx.chrome.respond(groupAnswer(3));
    click(guildButton());
    await ctx.settle();
    expect(isFresh(guildButton())).toBe(true);
    await vi.advanceTimersByTimeAsync(TIMING.freshMs);
    expect(isFresh(guildButton())).toBe(false);
  });

  it('the server button re-created by Discord during the request still gets the result marked (the key is the server)', async () => {
    ctx = await boot({ html: page() });
    let answer: (value: unknown) => void = () => undefined;
    ctx.chrome.respond(() => new Promise((resolve) => (answer = resolve)));
    click(guildButton());
    await ctx.settle();
    expect(guildButton().getAttribute('aria-busy')).toBe('true');
    // Discord rebuilds the sidebar (a new header, a new button of ours) while the worker is still adding channels
    document.body.innerHTML = page();
    ctx.app.injector.requestFullScan();
    await ctx.frame();
    answer({ ok: true, data: { added: 3, skipped: 0, removed: 0 } });
    await ctx.settle();
    expect(guildButtons()).toHaveLength(1);
    expect(stateOf(guildButton())).toBe('queued');
    expect(isFresh(guildButton())).toBe(true);
  });
});
