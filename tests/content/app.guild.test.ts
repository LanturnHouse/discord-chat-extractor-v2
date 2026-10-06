// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToBackground } from '@/shared/messages';
import { LOCAL } from '@/shared/storageKeys';
import { CHECK_PATH, DOWNLOAD_PATH } from '@/content/inject/icons';
import { ACCOUNT, boot, type Booted } from './helpers/app';
import {
  GUILD,
  GUILD_TWO,
  ID,
  INVITE_CLASS,
  byKey,
  channelRow,
  guildButtons,
  guildHeader,
  guildSidebar,
  setPage,
} from './helpers/fixtures';

// The server button of the guild header, end to end: what a click / Enter / Space sends and shows (PLAN §3 "서버", §7.1).

let ctx: Booted | null = null;

const SERVER_TITLE = 'Discord | #general | Server One';

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  document.documentElement.className = '';
  document.documentElement.removeAttribute('lang');
  setPage(`/channels/${GUILD}/${ID.general}`, SERVER_TITLE);
});

afterEach(() => {
  ctx?.app.destroy();
  ctx = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const page = (header: string = guildHeader()): string =>
  guildSidebar(header, channelRow({ id: ID.general, name: 'general' }), channelRow({ id: ID.random, name: 'random' }));

const button = (): HTMLElement => guildButtons()[0]!;
const toastEl = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-dce="toast"]');
const toastText = (): string | undefined => toastEl()?.textContent ?? undefined;
const ownNodes = (): Element[] => Array.from(document.querySelectorAll('[data-dce]'));
const tooltip = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-dce="tooltip"]');
const nativeInvite = (): HTMLElement => document.querySelector<HTMLElement>(`.${INVITE_CLASS}:not([data-dce])`)!;

const POINTER_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick'] as const;

function fire(el: Element, type: string, init: KeyboardEventInit & MouseEventInit = {}): Event {
  const event = type.startsWith('key')
    ? new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
    : type.startsWith('mouse') || type.startsWith('pointer') || type === 'click' || type === 'dblclick' || type === 'auxclick'
      ? new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })
      : new Event(type, { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
}

const click = (el: Element): Event => fire(el, 'click');

/** Records every event of `types` that reaches `el`, in the capture and the bubble phase. */
function spy(el: EventTarget, types: readonly string[], label = ''): { calls: string[] } {
  const result = { calls: [] as string[] };
  for (const type of types) {
    el.addEventListener(type, () => result.calls.push(`${label}${type}:bubble`));
    el.addEventListener(type, () => result.calls.push(`${label}${type}:capture`), true);
  }
  return result;
}

/** A background worker that answers `queue/addGuild` with `added` channels (and everything else with an error). */
const adds =
  (added: number, skipped = 0) =>
  (message: ToBackground): unknown =>
    message.type === 'queue/addGuild' ? { ok: true, data: { added, skipped, removed: 0 } } : { ok: false, error: 'invalid' };

/** The same worker, taking `removed` channels out of the list (every channel was in it). */
const removes =
  (removed: number) =>
  (message: ToBackground): unknown =>
    message.type === 'queue/addGuild' ? { ok: true, data: { added: 0, skipped: 0, removed } } : { ok: false, error: 'invalid' };

describe('what a click sends: queue/addGuild', () => {
  it('the guild from the address bar and the name from the header, nothing else', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(adds(3));
    click(button());
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/addGuild')).toEqual([
      { to: 'bg', type: 'queue/addGuild', guildId: GUILD, guildName: 'Server One' },
    ]);
    expect(ctx.chrome.sentOf('queue/toggle')).toEqual([]);
    expect(ctx.chrome.sentOf('queue/addCategory')).toEqual([]);
  });

  it('the name is the header`s text, trimmed; the title is the fallback; null when nothing says', async () => {
    ctx = await boot({ html: page(guildHeader({ name: '  Header   Name ' })) });
    ctx.chrome.respond(adds(1));
    click(button());
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/addGuild')[0]!.guildName).toBe('Header Name');
    ctx.app.destroy();

    document.body.innerHTML = '';
    ctx = await boot({ html: page(guildHeader({ name: null })) }); // no h2: the last | segment of the tab title
    ctx.chrome.respond(adds(1));
    click(button());
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/addGuild')[0]!.guildName).toBe('Server One');
    ctx.app.destroy();

    document.body.innerHTML = '';
    setPage(`/channels/${GUILD}/${ID.general}`, 'Discord');
    ctx = await boot({ html: page(guildHeader({ name: null })) });
    ctx.chrome.respond(adds(1));
    click(button());
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/addGuild')[0]).toEqual({ to: 'bg', type: 'queue/addGuild', guildId: GUILD, guildName: null });
  });

  it('is read at click time: after a server switch the same header (and button) acts on the new server', async () => {
    ctx = await boot({ html: page(guildHeader({ name: 'Server One' })) });
    ctx.chrome.respond(adds(1));
    const before = button();
    setPage(`/channels/${GUILD_TWO}/${ID.random}`, 'Discord | #random | Server Two');
    document.querySelector('h2')!.textContent = 'Server Two';
    click(before); // no pass has run yet: the address bar is the truth
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/addGuild')).toEqual([
      { to: 'bg', type: 'queue/addGuild', guildId: GUILD_TWO, guildName: 'Server Two' },
    ]);
  });

  it('a button left over after the server was left sends nothing and says something went wrong', async () => {
    ctx = await boot({ html: page() });
    setPage(`/channels/@me/${ID.dm}`, 'Discord | @Alex'); // the header is still there, no pass has run yet
    click(button());
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/addGuild')).toEqual([]);
    expect(toastText()).toBe('문제가 생겼어요. 잠시 후 다시 시도해 주세요');
    expect(toastEl()?.getAttribute('data-kind')).toBe('error');
  });

  it('is a toggle with a check state: the icon turns into a check from the answer, the next click (removed) turns it back', async () => {
    ctx = await boot({ html: page() });
    expect(button().querySelector('path')!.getAttribute('d')).toBe(DOWNLOAD_PATH);
    expect(button().getAttribute('data-dce-state')).toBe('idle');
    ctx.chrome.respond(adds(4));
    click(button());
    await ctx.settle();
    expect(button().querySelector('path')!.getAttribute('d')).toBe(CHECK_PATH);
    expect(button().getAttribute('data-dce-state')).toBe('queued');
    expect(button().getAttribute('aria-label')).toBe('이 서버 채널 전부 빼기');
    ctx.chrome.respond(removes(4));
    click(button());
    await ctx.settle();
    expect(button().querySelector('path')!.getAttribute('d')).toBe(DOWNLOAD_PATH);
    expect(button().getAttribute('data-dce-state')).toBe('idle');
    expect(button().getAttribute('aria-label')).toBe('이 서버 채널 전부 추가');
    expect(ctx.chrome.sentOf('queue/addGuild')).toHaveLength(2);
  });

  it('works for a header without an invite button (our own look) just the same', async () => {
    ctx = await boot({ html: page(guildHeader({ invite: false })) });
    ctx.chrome.respond(adds(2));
    click(button());
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/addGuild')).toHaveLength(1);
    expect(toastText()).toBe('채널 2개를 추가했어요');
  });

  it('only the message types of the plan leave the page, and storage is written as before', async () => {
    vi.useFakeTimers();
    ctx = await boot({ html: page() });
    ctx.chrome.respond((message) =>
      message.type === 'queue/addGuild' ? { ok: true, data: { added: 1, skipped: 0, removed: 0 } } : { ok: true, data: { queued: true } },
    );
    click(byKey(ID.general)!);
    click(button());
    await vi.advanceTimersByTimeAsync(3000);
    expect(new Set(ctx.chrome.sent.map((m) => m.type))).toEqual(new Set(['queue/toggle', 'queue/addGuild', 'queue/groupInfo', 'inject/health']));
    const keys = new Set(ctx.chrome.writes.flatMap((write) => Object.keys(write)));
    expect(Array.from(keys).sort()).toEqual([LOCAL.classCache, LOCAL.theme].sort());
  });
});

describe('the toast', () => {
  it('channels were added: how many (success)', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(adds(5, 2));
    click(button());
    await ctx.settle();
    expect(toastText()).toBe('채널 5개를 추가했어요');
    expect(toastEl()?.getAttribute('data-kind')).toBe('success');
  });

  it('channels were removed (every channel was in the list): how many (success)', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(removes(7));
    click(button());
    await ctx.settle();
    expect(toastText()).toBe('채널 7개를 목록에서 뺐어요');
    expect(toastEl()?.getAttribute('data-kind')).toBe('success');
  });

  it('nothing to add (everything is in the list already): said so, and not an error (info)', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(adds(0, 9));
    click(button());
    await ctx.settle();
    expect(toastText()).toBe('추가할 채널이 없어요 (이미 모두 목록에 있어요)');
    expect(toastEl()?.getAttribute('data-kind')).toBe('info');
  });

  it('English: one channel / many channels / nothing', async () => {
    document.documentElement.lang = 'en';
    ctx = await boot({ html: page() });
    ctx.chrome.respond(adds(1));
    click(button());
    await ctx.settle();
    expect(toastText()).toBe('Added 1 channel');
    ctx.chrome.respond(adds(12));
    click(button());
    await ctx.settle();
    expect(toastText()).toBe('Added 12 channels');
    ctx.chrome.respond(removes(1));
    click(button());
    await ctx.settle();
    expect(toastText()).toBe('Removed 1 channel from the list');
    ctx.chrome.respond(removes(12));
    click(button());
    await ctx.settle();
    expect(toastText()).toBe('Removed 12 channels from the list');
    ctx.chrome.respond(adds(0));
    click(button());
    await ctx.settle();
    expect(toastText()).toBe('Nothing to add (every channel is already in the list)');
    expect(toastEl()?.getAttribute('data-kind')).toBe('info');
  });

  it('an explicit language setting wins over the page language', async () => {
    document.documentElement.lang = 'en';
    ctx = await boot({ html: page(), settings: { language: 'ko' } });
    ctx.chrome.respond(adds(0));
    click(button());
    await ctx.settle();
    expect(toastText()).toBe('추가할 채널이 없어요 (이미 모두 목록에 있어요)');
  });

  const errors: [string, unknown, string, string][] = [
    ['no-account', { ok: false, error: 'no-account' }, '디스코드 계정을 확인하는 중이에요. 잠시 후 다시 눌러 주세요', 'info'],
    ['no-consent', { ok: false, error: 'no-consent' }, '확장 프로그램 아이콘을 눌러 안내를 먼저 확인해 주세요', 'info'],
    ['busy', { ok: false, error: 'busy' }, '다른 작업을 처리하는 중이에요. 잠시 후 다시 눌러 주세요', 'info'],
    ['empty (a server has no channel to add)', { ok: false, error: 'empty' }, '이 서버에는 담을 채널이 없어요', 'info'],
    ['http', { ok: false, error: 'http', message: 'secret details' }, '디스코드에서 정보를 가져오지 못했어요. 잠시 후 다시 시도해 주세요', 'error'],
    ['unknown', { ok: false, error: 'unknown' }, '문제가 생겼어요. 잠시 후 다시 시도해 주세요', 'error'],
    ['invalid', { ok: false, error: 'invalid' }, '문제가 생겼어요. 잠시 후 다시 시도해 주세요', 'error'],
    ['forbidden-path', { ok: false, error: 'forbidden-path' }, '문제가 생겼어요. 잠시 후 다시 시도해 주세요', 'error'],
    ['no answer at all', undefined, '확장 프로그램과 연결하지 못했어요. 디스코드를 새로고침해 주세요', 'error'],
    ['a malformed answer', 'nonsense', '확장 프로그램과 연결하지 못했어요. 디스코드를 새로고침해 주세요', 'error'],
    ['success without data', { ok: true }, '문제가 생겼어요. 잠시 후 다시 시도해 주세요', 'error'],
    ['success with a count that is no number', { ok: true, data: { added: 'many', skipped: 0 } }, '문제가 생겼어요. 잠시 후 다시 시도해 주세요', 'error'],
    ['success with a count that is not finite', { ok: true, data: { added: Number.NaN, skipped: 0 } }, '문제가 생겼어요. 잠시 후 다시 시도해 주세요', 'error'],
  ];

  it.each(errors)('%s -> the existing error toast', async (_name, answer, text, kind) => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(() => answer);
    click(button());
    await ctx.settle();
    expect(toastText()).toBe(text);
    expect(toastEl()?.getAttribute('data-kind')).toBe(kind);
  });

  it('the guild text for `empty` is English too; the category button keeps its own text for the same answer', async () => {
    document.documentElement.lang = 'en';
    ctx = await boot({ html: page() });
    ctx.chrome.respond(() => ({ ok: false, error: 'empty' }));
    click(button());
    await ctx.settle();
    expect(toastText()).toBe('This server has no channels to add');
  });

  it('never shows the background worker`s own message text', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(() => ({ ok: false, error: 'http', message: 'HTTP 403 for /api/v9/guilds/1/channels' }));
    click(button());
    await ctx.settle();
    expect(toastText()).not.toContain('403');
    expect(toastText()).not.toContain('/api');
  });

  it('stays 2.5 seconds like every toast', async () => {
    vi.useFakeTimers();
    ctx = await boot({ html: page() });
    ctx.chrome.respond(adds(1));
    click(button());
    await ctx.settle();
    expect(toastEl()?.getAttribute('data-visible')).toBe('true');
    await vi.advanceTimersByTimeAsync(2500);
    expect(toastEl()?.getAttribute('data-visible')).toBe('false');
  });
});

describe('only one request at a time: further clicks while it is in flight are ignored', () => {
  it('clicks, Enter and Space on the busy button send nothing more; the button looks busy meanwhile; free again after the answer', async () => {
    ctx = await boot({ html: page() });
    let release: (value: unknown) => void = () => undefined;
    ctx.chrome.respond(() => new Promise((resolve) => (release = resolve)));
    click(button());
    await ctx.settle();
    expect(button().getAttribute('aria-busy')).toBe('true');
    click(button());
    click(button());
    fire(button(), 'keydown', { key: 'Enter' });
    fire(button(), 'keydown', { key: ' ' });
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/addGuild')).toHaveLength(1);

    release({ ok: true, data: { added: 2, skipped: 0 } });
    await ctx.settle();
    expect(button().hasAttribute('aria-busy')).toBe(false);
    expect(toastText()).toBe('채널 2개를 추가했어요');

    ctx.chrome.respond(adds(0));
    click(button());
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/addGuild')).toHaveLength(2);
    expect(toastText()).toBe('추가할 채널이 없어요 (이미 모두 목록에 있어요)');
  });

  it('a click on the busy button is still swallowed (it must never reach the server menu), only not acted on', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(() => new Promise(() => undefined)); // never answered
    click(button());
    await ctx.settle();
    expect(click(button()).defaultPrevented).toBe(true);
  });

  it('a header that Discord re-creates while the request is in flight: the new button is busy too and ignores clicks', async () => {
    ctx = await boot({ html: page() });
    let release: (value: unknown) => void = () => undefined;
    ctx.chrome.respond(() => new Promise((resolve) => (release = resolve)));
    click(button());
    await ctx.settle();

    const holder = document.createElement('div');
    holder.innerHTML = guildHeader();
    document.querySelector('header')!.replaceWith(holder.firstElementChild!);
    await ctx.frame();
    expect(guildButtons()).toHaveLength(1);
    expect(button().getAttribute('aria-busy')).toBe('true');
    click(button());
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/addGuild')).toHaveLength(1);

    release({ ok: true, data: { added: 1, skipped: 0 } });
    await ctx.settle();
    expect(button().hasAttribute('aria-busy')).toBe(false);
  });

  it('is released after every kind of answer: an error, no answer at all', async () => {
    ctx = await boot({ html: page() });
    for (const answer of [{ ok: false, error: 'no-account' }, undefined, 'nonsense', { ok: true }]) {
      ctx.chrome.respond(() => answer);
      const before = ctx.chrome.sentOf('queue/addGuild').length;
      click(button());
      await ctx.settle();
      expect(ctx.chrome.sentOf('queue/addGuild')).toHaveLength(before + 1);
      expect(button().hasAttribute('aria-busy')).toBe(false);
    }
  });

  it('a request of the server button does not hold back the row buttons, and the other way round', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(() => new Promise(() => undefined)); // nothing is ever answered
    click(button());
    click(byKey(ID.general)!);
    click(byKey(ID.random)!);
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/addGuild')).toHaveLength(1);
    expect(ctx.chrome.sentOf('queue/toggle').map((m) => m.target.channelId)).toEqual([ID.general, ID.random]);
  });
});

describe('click isolation: the server menu never sees an event that starts on our button', () => {
  const events = [...POINTER_EVENTS, 'dragstart', 'keydown', 'keyup'] as const;

  it('the menu, the header, the sidebar, the body and the document get no pointer / mouse / click event, in either phase', async () => {
    ctx = await boot({ html: page() });
    const menu = document.querySelector<HTMLElement>('[class^="guildDropdown_"]')!;
    const header = document.querySelector<HTMLElement>('header')!;
    const content = document.querySelector<HTMLElement>('[class^="headerContent_"]')!;
    const spies = [
      spy(menu, events, 'menu '),
      spy(content, events, 'content '),
      spy(header, events, 'header '),
      spy(document.querySelector('nav')!, events, 'nav '),
      spy(document.body, events, 'body '),
      spy(document, events, 'doc '),
    ];
    for (const type of POINTER_EVENTS) expect(fire(button(), type).defaultPrevented, `${type} default prevented`).toBe(true);
    expect(fire(button(), 'dragstart').defaultPrevented).toBe(true);
    expect(spies.flatMap((s) => s.calls)).toEqual([]);
  });

  it('a handler of Discord on the header that would open the server menu never fires (sanity: it does for Discord`s own icon)', async () => {
    ctx = await boot({ html: page() });
    const menu = document.querySelector<HTMLElement>('[class^="guildDropdown_"]')!;
    const opened: string[] = [];
    const open = (event: Event): void => {
      opened.push(event.type);
      menu.setAttribute('aria-expanded', 'true');
    };
    for (const target of [document.querySelector('header')!, document.querySelector('[class^="headerContent_"]')!]) {
      for (const type of POINTER_EVENTS) {
        target.addEventListener(type, open);
        target.addEventListener(type, open, true);
      }
    }
    for (const type of POINTER_EVENTS) fire(button(), type);
    expect(opened).toEqual([]);
    expect(menu.getAttribute('aria-expanded')).toBe('false');

    fire(nativeInvite(), 'click'); // Discord`s own invite icon is none of our business: it reaches the handler as usual
    expect(opened.length).toBeGreaterThan(0);
  });

  it('events that start on the svg inside the button are isolated too', async () => {
    ctx = await boot({ html: page() });
    const header = document.querySelector<HTMLElement>('header')!;
    const headerSpy = spy(header, events);
    const svg = button().querySelector('svg')! as unknown as Element;
    for (const type of POINTER_EVENTS) expect(fire(svg, type).defaultPrevented, type).toBe(true);
    expect(headerSpy.calls).toEqual([]);
  });

  it('the same for a header without an invite button', async () => {
    ctx = await boot({ html: page(guildHeader({ invite: false })) });
    const headerSpy = spy(document.querySelector('header')!, events);
    for (const type of POINTER_EVENTS) fire(button(), type);
    expect(headerSpy.calls).toEqual([]);
  });

  it('the click of the server menu itself, and the native invite icon, are not touched', async () => {
    ctx = await boot({ html: page() });
    const menu = document.querySelector<HTMLElement>('[class^="guildDropdown_"]')!;
    const received = spy(menu, ['click']);
    expect(fire(menu, 'click').defaultPrevented).toBe(false);
    expect(received.calls).toContain('click:bubble');
    expect(fire(nativeInvite(), 'click').defaultPrevented).toBe(false);
    expect(ctx.chrome.sentOf('queue/addGuild')).toEqual([]);
  });

  it('draggable is off on the button itself', async () => {
    ctx = await boot({ html: page() });
    expect(button().getAttribute('draggable')).toBe('false');
  });

  it('a press on the button cancels the native drag that would follow on an ancestor, like for the rows', async () => {
    ctx = await boot({ html: page() });
    const header = document.querySelector<HTMLElement>('header')!;
    const headerSpy = spy(header, ['dragstart']);
    fire(button(), 'mousedown');
    expect(fire(header, 'dragstart').defaultPrevented).toBe(true);
    expect(headerSpy.calls).toEqual([]);
    fire(button(), 'mouseup');
    expect(fire(header, 'dragstart').defaultPrevented).toBe(false);
  });
});

describe('keyboard', () => {
  it('Enter and Space on the focused button activate it and are swallowed', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(adds(1));
    const header = document.querySelector<HTMLElement>('header')!;
    const headerSpy = spy(header, ['keydown', 'keyup']);
    button().focus();
    expect(document.activeElement).toBe(button());

    const enter = fire(button(), 'keydown', { key: 'Enter' });
    await ctx.settle();
    expect(enter.defaultPrevented).toBe(true);
    expect(ctx.chrome.sentOf('queue/addGuild')).toHaveLength(1);

    const space = fire(button(), 'keydown', { key: ' ' });
    fire(button(), 'keyup', { key: ' ' });
    await ctx.settle();
    expect(space.defaultPrevented).toBe(true);
    expect(ctx.chrome.sentOf('queue/addGuild')).toHaveLength(2);
    expect(headerSpy.calls).toEqual([]);
  });

  it('other keys pass through untouched', async () => {
    ctx = await boot({ html: page() });
    const header = document.querySelector<HTMLElement>('header')!;
    const headerSpy = spy(header, ['keydown']);
    for (const key of ['Tab', 'ArrowDown', 'a', 'Escape']) expect(fire(button(), 'keydown', { key }).defaultPrevented, key).toBe(false);
    expect(headerSpy.calls.filter((c) => c.endsWith('bubble'))).toHaveLength(4);
    expect(ctx.chrome.sentOf('queue/addGuild')).toEqual([]);
  });

  it('a held key does not send again and again', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(adds(1));
    fire(button(), 'keydown', { key: 'Enter' });
    for (let i = 0; i < 5; i++) fire(button(), 'keydown', { key: 'Enter', repeat: true });
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/addGuild')).toHaveLength(1);
  });
});

describe('tooltip', () => {
  it('"이 서버 채널 전부 추가" on hover (the Discord-style bubble), gone on mouseout', async () => {
    ctx = await boot({ html: page() });
    expect(tooltip()).toBeNull();
    fire(button(), 'mouseover');
    expect(tooltip()?.getAttribute('data-visible')).toBe('true');
    expect(tooltip()?.textContent).toBe('이 서버 채널 전부 추가');
    expect(tooltip()?.getAttribute('role')).toBe('tooltip');
    expect(ctx.app.tooltip.anchoredTo).toBe(button());
    fire(button(), 'mouseout');
    expect(tooltip()?.getAttribute('data-visible')).toBe('false');
  });

  it('"이 서버 채널 전부 빼기" while every channel is in the list; a storage change while it is open updates the text', async () => {
    ctx = await boot({ html: page(), queue: [ID.general, ID.random], groups: { [GUILD]: [ID.general, ID.random] } });
    fire(button(), 'mouseover');
    expect(tooltip()?.textContent).toBe('이 서버 채널 전부 빼기');
    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [{ key: ID.general }] });
    await ctx.settle();
    expect(tooltip()?.textContent).toBe('이 서버 채널 전부 추가');
  });

  it('shows on keyboard focus too, and hides on blur', async () => {
    ctx = await boot({ html: page() });
    button().focus();
    expect(tooltip()?.getAttribute('data-visible')).toBe('true');
    expect(tooltip()?.textContent).toBe('이 서버 채널 전부 추가');
    button().blur();
    expect(tooltip()?.getAttribute('data-visible')).toBe('false');
  });

  it('English: "Add every channel in this server"; a language change while it is open updates the text', async () => {
    document.documentElement.lang = 'en-US';
    ctx = await boot({ html: page() });
    fire(button(), 'mouseover');
    expect(tooltip()?.textContent).toBe('Add every channel in this server');
    ctx.chrome.set({ [LOCAL.settings]: { language: 'ko' } });
    await ctx.settle();
    expect(tooltip()?.textContent).toBe('이 서버 채널 전부 추가');
  });

  it('the header is at the top of the window: the bubble opens below the button when there is no room above', async () => {
    ctx = await boot({ html: page() });
    const rect = (left: number, top: number, width: number, height: number): DOMRect =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this.classList.contains('dce-tooltip') ? rect(0, 0, 160, 32) : rect(200, 8, 32, 32);
    });
    fire(button(), 'mouseover');
    expect(tooltip()?.getAttribute('data-placement')).toBe('bottom');
    expect(tooltip()?.style.transform).toBe('translate(136px, 48px)'); // 216 - 80, 40 + 8
  });

  it('the tooltip is not left behind when the header goes away', async () => {
    ctx = await boot({ html: page() });
    fire(button(), 'mouseover');
    document.querySelector('header')!.remove();
    ctx.app.tooltip.refresh();
    expect(tooltip()?.getAttribute('data-visible')).toBe('false');
  });
});

describe('teardown while it is in use', () => {
  it('the buttons switched off while a request is in flight: the button is gone, the late answer still ends in a toast that leaves nothing behind', async () => {
    vi.useFakeTimers();
    ctx = await boot({ html: page() });
    let release: (value: unknown) => void = () => undefined;
    ctx.chrome.respond(() => new Promise((resolve) => (release = resolve)));
    click(button());
    await ctx.settle();
    ctx.chrome.set({ [LOCAL.settings]: { showButtons: false } });
    await ctx.settle();
    expect(ownNodes()).toEqual([]);

    release({ ok: true, data: { added: 3, skipped: 0 } });
    await ctx.settle();
    expect(toastText()).toBe('채널 3개를 추가했어요');
    await vi.advanceTimersByTimeAsync(3000);
    expect(ownNodes()).toEqual([]);
  });

  it('switching the buttons on again during the request: the new button is busy until the answer', async () => {
    ctx = await boot({ html: page() });
    let release: (value: unknown) => void = () => undefined;
    ctx.chrome.respond(() => new Promise((resolve) => (release = resolve)));
    click(button());
    await ctx.settle();
    ctx.chrome.set({ [LOCAL.settings]: { showButtons: false } });
    await ctx.settle();
    ctx.chrome.set({ [LOCAL.settings]: { showButtons: true } });
    await ctx.frame();
    expect(button().getAttribute('aria-busy')).toBe('true');
    click(button());
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/addGuild')).toHaveLength(1);
    release({ ok: true, data: { added: 1, skipped: 0 } });
    await ctx.settle();
    expect(button().hasAttribute('aria-busy')).toBe(false);
  });

  it('the extension is reloaded while a request is in flight: no toast, no error, everything removed', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ctx = await boot({ html: page() });
    let release: (value: unknown) => void = () => undefined;
    ctx.chrome.respond(() => new Promise((resolve) => (release = resolve)));
    click(button());
    await ctx.settle();
    ctx.chrome.invalidate();
    release({ ok: true, data: { added: 1, skipped: 0 } });
    await ctx.settle();
    expect(ctx.app.destroyed).toBe(true);
    expect(ownNodes()).toEqual([]);
    expect(toastEl()).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  it('a click on an orphaned button (the extension was reloaded) is swallowed, sends nothing, and cleans up', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ctx = await boot({ html: page() });
    const orphan = button();
    ctx.chrome.invalidate();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    expect(() => orphan.dispatchEvent(event)).not.toThrow();
    await ctx.settle();
    expect(event.defaultPrevented).toBe(true);
    expect(ctx.app.destroyed).toBe(true);
    expect(ownNodes()).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });

  it('the handlers are gone with the buttons: after destroy() the same events pass through', async () => {
    ctx = await boot({ html: page() });
    const menu = document.querySelector<HTMLElement>('[class^="guildDropdown_"]')!;
    ctx.app.destroy();
    const received = spy(menu, ['click']);
    expect(fire(menu, 'click').defaultPrevented).toBe(false);
    expect(received.calls).toContain('click:bubble');
  });
});
