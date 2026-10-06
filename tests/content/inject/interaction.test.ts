// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot, type Booted } from '../helpers/app';
import { ID, byKey, categoryRow, channelRow, dmRow, sidebar } from '../helpers/fixtures';

let ctx: Booted | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  document.documentElement.className = '';
  document.documentElement.removeAttribute('lang');
  document.title = 'Discord';
  history.pushState({}, '', '/channels/100000000000000001/200000000000000001');
});

afterEach(() => {
  ctx?.app.destroy();
  ctx = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const POINTER_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick'] as const;

interface Spy {
  calls: string[];
}

/** Records every event of `types` that reaches `el`, in the capture and the bubble phase. */
function spy(el: EventTarget, types: readonly string[], label = ''): Spy {
  const result: Spy = { calls: [] };
  for (const type of types) {
    el.addEventListener(type, () => result.calls.push(`${label}${type}:bubble`));
    el.addEventListener(type, () => result.calls.push(`${label}${type}:capture`), true);
  }
  return result;
}

function fire(el: Element, type: string, init: KeyboardEventInit & MouseEventInit = {}): Event {
  const event =
    type.startsWith('key')
      ? new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
      : type.startsWith('mouse') || type.startsWith('pointer') || type === 'click' || type === 'dblclick' || type === 'auxclick'
        ? new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })
        : new Event(type, { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
}

const pageHtml = (): string =>
  sidebar(
    channelRow({ id: ID.general, name: 'general' }),
    channelRow({ id: ID.random, name: 'random' }),
    categoryRow({ id: ID.categoryA, name: 'Category A' }),
  ) + dmRow({ id: ID.dm, name: 'Alex' }) + dmRow({ id: ID.groupDm, name: 'Sam, Kim, Lee', group: true, position: 12 });

describe('click isolation: nothing of Discord`s sees an event that starts on our button', () => {
  const channelEvents = [...POINTER_EVENTS, 'dragstart', 'keydown', 'keyup'] as const;

  it('the row link, the row and the document get no pointer / mouse / click event, in either phase', async () => {
    ctx = await boot({ html: pageHtml() });
    const link = document.querySelector<HTMLElement>(`a[data-list-item-id$="___${ID.general}"]`)!;
    const row = link.closest('li')!;
    const spies = [spy(link, channelEvents, 'link '), spy(row, channelEvents, 'li '), spy(document.body, channelEvents, 'body '), spy(document, channelEvents, 'doc ')];
    const button = byKey(ID.general)!;
    for (const type of POINTER_EVENTS) {
      const event = fire(button, type);
      expect(event.defaultPrevented, `${type} default prevented`).toBe(true);
    }
    expect(spies.flatMap((s) => s.calls)).toEqual([]);
  });

  it('events that start on the svg inside the button are isolated too', async () => {
    ctx = await boot({ html: pageHtml() });
    const link = document.querySelector<HTMLElement>(`a[data-list-item-id$="___${ID.general}"]`)!;
    const linkSpy = spy(link, channelEvents);
    const svg = byKey(ID.general)!.querySelector('svg')!;
    for (const type of POINTER_EVENTS) expect(fire(svg as unknown as Element, type).defaultPrevented, type).toBe(true);
    expect(linkSpy.calls).toEqual([]);
  });

  it('a DM: neither the row link nor the close button (group DMs: "leave group") receive anything', async () => {
    ctx = await boot({ html: pageHtml() });
    for (const id of [ID.dm, ID.groupDm]) {
      const link = document.querySelector<HTMLElement>(`a[data-list-item-id$="___${id}"]`)!;
      const row = link.closest('li')!;
      const close = row.querySelector<HTMLElement>('[class^="closeButton_"]:not([data-dce])')!;
      const spies = [spy(close, channelEvents, 'close '), spy(link, channelEvents, 'link '), spy(row, channelEvents, 'li '), spy(document.body, channelEvents, 'body ')];
      const button = byKey(id)!;
      for (const type of POINTER_EVENTS) fire(button, type);
      fire(button, 'dragstart');
      fire(button, 'keydown', { key: 'Enter' });
      fire(button, 'keydown', { key: ' ' });
      expect(spies.flatMap((s) => s.calls), `DM ${id}`).toEqual([]);
    }
  });

  it('sanity: the same events on Discord`s own close button DO reach its handlers', async () => {
    ctx = await boot({ html: pageHtml() });
    const row = document.querySelector<HTMLElement>(`a[data-list-item-id$="___${ID.groupDm}"]`)!.closest('li')!;
    const close = row.querySelector<HTMLElement>('[class^="closeButton_"]:not([data-dce])')!;
    const received = spy(close, ['click', 'mousedown']);
    fire(close, 'mousedown');
    fire(close, 'click');
    expect(received.calls.length).toBeGreaterThan(0);
    expect(fire(close, 'click').defaultPrevented).toBe(false);
  });

  it('a click on the row link or on the native invite icon is not touched', async () => {
    ctx = await boot({ html: pageHtml() });
    const link = document.querySelector<HTMLElement>(`a[data-list-item-id$="___${ID.general}"]`)!;
    const invite = link.querySelector<HTMLElement>('[class^="iconItem_"]:not([data-dce])')!;
    const linkSpy = spy(link, ['click']);
    fire(invite, 'click');
    fire(link, 'click');
    expect(linkSpy.calls).toContain('click:bubble');
    expect(ctx.chrome.sentOf('queue/toggle')).toEqual([]);
  });

  it('the link`s default navigation is cancelled (a click inside an anchor would follow the href)', async () => {
    ctx = await boot({ html: pageHtml() });
    const event = fire(byKey(ID.general)!, 'click');
    expect(event.defaultPrevented).toBe(true);
  });

  it('a native drag of the row cannot start from our button: a press on it cancels the dragstart that follows on the row', async () => {
    ctx = await boot({ html: pageHtml() });
    const link = document.querySelector<HTMLElement>(`a[data-list-item-id$="___${ID.general}"]`)!;
    const row = link.closest('li')!;
    const rowSpy = spy(row, ['dragstart']);
    fire(byKey(ID.general)!, 'mousedown');
    const started = fire(link, 'dragstart'); // the draggable ancestor is the target, not our button
    expect(started.defaultPrevented).toBe(true);
    expect(rowSpy.calls).toEqual([]);
    fire(byKey(ID.general)!, 'mouseup');
    const later = fire(link, 'dragstart'); // after the press ended, Discord's drag works again
    expect(later.defaultPrevented).toBe(false);
    expect(rowSpy.calls).toContain('dragstart:bubble');
  });

  it('a press that ends elsewhere also ends the guard', async () => {
    ctx = await boot({ html: pageHtml() });
    const link = document.querySelector<HTMLElement>(`a[data-list-item-id$="___${ID.general}"]`)!;
    fire(byKey(ID.general)!, 'pointerdown');
    fire(document.body, 'pointerup'); // released outside the button
    expect(fire(link, 'dragstart').defaultPrevented).toBe(false);
  });

  it('draggable is off on the button itself', async () => {
    ctx = await boot({ html: pageHtml() });
    expect(byKey(ID.general)!.getAttribute('draggable')).toBe('false');
    expect(fire(byKey(ID.general)!, 'dragstart').defaultPrevented).toBe(true);
  });

  it('the handlers are gone with the buttons: after teardown the same events pass through', async () => {
    ctx = await boot({ html: pageHtml() });
    const link = document.querySelector<HTMLElement>(`a[data-list-item-id$="___${ID.general}"]`)!;
    ctx.app.destroy();
    const linkSpy = spy(link, ['click']);
    expect(fire(link, 'click').defaultPrevented).toBe(false);
    expect(linkSpy.calls).toContain('click:bubble');
  });
});

describe('keyboard', () => {
  it('Enter and Space on the focused button activate it and are swallowed', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(() => ({ ok: true, data: { queued: true } }));
    const button = byKey(ID.general)!;
    const row = button.closest('li')!;
    const rowSpy = spy(row, ['keydown', 'keyup']);
    button.focus();
    expect(document.activeElement).toBe(button);

    const enter = fire(button, 'keydown', { key: 'Enter' });
    await ctx.settle();
    expect(enter.defaultPrevented).toBe(true);
    expect(ctx.chrome.sentOf('queue/toggle')).toHaveLength(1);

    const space = fire(button, 'keydown', { key: ' ' });
    fire(button, 'keyup', { key: ' ' });
    await ctx.settle();
    expect(space.defaultPrevented).toBe(true);
    expect(rowSpy.calls).toEqual([]);
  });

  it('other keys pass through untouched (Tab, arrows, letters)', async () => {
    ctx = await boot({ html: pageHtml() });
    const button = byKey(ID.general)!;
    const row = button.closest('li')!;
    const rowSpy = spy(row, ['keydown']);
    for (const key of ['Tab', 'ArrowDown', 'ArrowUp', 'a', 'Escape']) {
      expect(fire(button, 'keydown', { key }).defaultPrevented, key).toBe(false);
    }
    expect(rowSpy.calls.filter((c) => c.endsWith('bubble'))).toHaveLength(5);
    expect(ctx.chrome.sentOf('queue/toggle')).toEqual([]);
  });

  it('a held key does not toggle again and again', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(() => ({ ok: true, data: { queued: true } }));
    const button = byKey(ID.general)!;
    fire(button, 'keydown', { key: 'Enter' });
    for (let i = 0; i < 5; i++) fire(button, 'keydown', { key: 'Enter', repeat: true });
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')).toHaveLength(1);
  });

  it('keys typed elsewhere are none of our business', async () => {
    ctx = await boot({ html: pageHtml() });
    const link = document.querySelector<HTMLElement>(`a[data-list-item-id$="___${ID.general}"]`)!;
    expect(fire(link, 'keydown', { key: 'Enter' }).defaultPrevented).toBe(false);
    expect(ctx.chrome.sentOf('queue/toggle')).toEqual([]);
  });
});

describe('tooltip', () => {
  const tooltip = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-dce="tooltip"]');

  it('shows above the button on hover with the label of its state, and goes away on mouseout', async () => {
    ctx = await boot({ html: pageHtml() });
    expect(tooltip()).toBeNull();
    const button = byKey(ID.general)!;
    fire(button, 'mouseover');
    expect(tooltip()?.getAttribute('data-visible')).toBe('true');
    expect(tooltip()?.textContent).toBe('다운로드 목록에 추가');
    expect(tooltip()?.getAttribute('role')).toBe('tooltip');
    fire(button, 'mouseout');
    expect(tooltip()?.getAttribute('data-visible')).toBe('false');
  });

  it('shows on keyboard focus too, and hides on blur', async () => {
    ctx = await boot({ html: pageHtml() });
    const button = byKey(ID.random)!;
    button.focus();
    expect(tooltip()?.getAttribute('data-visible')).toBe('true');
    button.blur();
    expect(tooltip()?.getAttribute('data-visible')).toBe('false');
  });

  it('category buttons say what they do', async () => {
    ctx = await boot({ html: pageHtml() });
    fire(byKey(ID.categoryA)!, 'mouseover');
    expect(tooltip()?.textContent).toBe('이 카테고리 채널 전부 추가');
  });

  it('the text follows the state while the bubble is open (add -> remove after the click)', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(() => ({ ok: true, data: { queued: true } }));
    const button = byKey(ID.general)!;
    fire(button, 'mouseover');
    fire(button, 'click');
    await ctx.settle();
    expect(tooltip()?.textContent).toBe('다운로드 목록에서 빼기');
    expect(tooltip()?.getAttribute('data-visible')).toBe('true');
  });

  it('moving inside the button does not flicker; leaving for another button moves the bubble', async () => {
    ctx = await boot({ html: pageHtml() });
    const first = byKey(ID.general)!;
    const second = byKey(ID.random)!;
    fire(first, 'mouseover');
    const svg = first.querySelector('svg')!;
    fire(svg as unknown as Element, 'mouseout', { relatedTarget: first }); // moved from the svg to the button itself
    expect(tooltip()?.getAttribute('data-visible')).toBe('true');
    fire(first, 'mouseout', { relatedTarget: second });
    fire(second, 'mouseover', { relatedTarget: first });
    expect(ctx.app.tooltip.anchoredTo).toBe(second);
    expect(tooltip()?.getAttribute('data-visible')).toBe('true');
  });

  it('a mouseout of a button that is not the anchor does not hide the bubble', async () => {
    ctx = await boot({ html: pageHtml() });
    fire(byKey(ID.general)!, 'mouseover');
    fire(byKey(ID.random)!, 'mouseout');
    expect(tooltip()?.getAttribute('data-visible')).toBe('true');
  });

  it('scrolling the sidebar hides it (it is fixed to the window, the button moves)', async () => {
    ctx = await boot({ html: pageHtml() });
    fire(byKey(ID.general)!, 'mouseover');
    fire(document.querySelector('ul')!, 'scroll');
    expect(tooltip()?.getAttribute('data-visible')).toBe('false');
  });

  it('disappears when its button leaves the page', async () => {
    ctx = await boot({ html: pageHtml() });
    const button = byKey(ID.random)!;
    fire(button, 'mouseover');
    button.closest('li')!.remove();
    ctx.app.tooltip.refresh();
    expect(tooltip()?.getAttribute('data-visible')).toBe('false');
  });

  describe('placement', () => {
    const rectOf = (left: number, top: number, width: number, height: number): DOMRect =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

    const stubRects = (button: DOMRect, bubble: DOMRect): void => {
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        return this.classList.contains('dce-tooltip') ? bubble : button;
      });
    };

    it('centred above the button, arrow pointing at it', async () => {
      ctx = await boot({ html: pageHtml() });
      stubRects(rectOf(300, 200, 16, 16), rectOf(0, 0, 100, 32));
      fire(byKey(ID.general)!, 'mouseover');
      expect(tooltip()?.style.transform).toBe('translate(258px, 160px)'); // 308 - 50, 200 - 32 - 8
      expect(tooltip()?.style.getPropertyValue('--dce-arrow-x')).toBe('50px');
      expect(tooltip()?.getAttribute('data-placement')).toBe('top');
    });

    it('below the button when there is no room above', async () => {
      ctx = await boot({ html: pageHtml() });
      stubRects(rectOf(300, 10, 16, 16), rectOf(0, 0, 100, 32));
      fire(byKey(ID.general)!, 'mouseover');
      expect(tooltip()?.getAttribute('data-placement')).toBe('bottom');
      expect(tooltip()?.style.transform).toBe('translate(258px, 34px)'); // 26 + 8
    });

    it('kept inside the window, the arrow still points at the button', async () => {
      ctx = await boot({ html: pageHtml() });
      stubRects(rectOf(2, 200, 16, 16), rectOf(0, 0, 100, 32));
      fire(byKey(ID.general)!, 'mouseover');
      expect(tooltip()?.style.transform).toBe('translate(4px, 160px)');
      expect(tooltip()?.style.getPropertyValue('--dce-arrow-x')).toBe('6px'); // 10 - 4
    });
  });
});
