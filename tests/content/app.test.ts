// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToBackground } from '@/shared/messages';
import { CHECK_PATH, DOWNLOAD_PATH } from '@/content/inject/icons';
import { LOCAL } from '@/shared/storageKeys';
import { ACCOUNT, boot, type Booted } from './helpers/app';
import {
  GUILD,
  ID,
  allButtons,
  byKey,
  categoryRow,
  channelRow,
  dmRow,
  mount,
  nonRows,
  setPage,
  sidebar,
  threadRow,
} from './helpers/fixtures';

let ctx: Booted | null = null;

const SERVER_TITLE = '(8) Discord | #general | Server One';

/** categoryA > general (+ thread), random; categoryB > lounge (voice); plus two DMs. */
const pageHtml = (): string =>
  sidebar(
    nonRows(),
    channelRow({ id: ID.forum, name: 'welcome' }), // before any category
    categoryRow({ id: ID.categoryA, name: 'Category A' }),
    channelRow({ id: ID.general, name: 'general', threads: [threadRow({ id: ID.thread, name: 'Thread A' })] }),
    channelRow({ id: ID.random, name: 'random' }),
    categoryRow({ id: ID.categoryB, name: 'Category B' }),
    channelRow({ id: ID.voice, name: 'lounge', voice: true }),
  ) +
  dmRow({ id: ID.dm, name: 'Alex' }) +
  dmRow({ id: ID.groupDm, name: 'Sam, Kim, Lee', group: true, position: 12 });

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

const toastEl = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-dce="toast"]');
const toastText = (): string | undefined => toastEl()?.textContent ?? undefined;
const ownNodes = (): Element[] => Array.from(document.querySelectorAll('[data-dce]'));

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

/** A background worker that toggles like the real one: answers with the new state. */
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

describe('with the real animation-frame scheduler and the real MutationObserver (smoke test)', () => {
  /** Polls (real time) until `condition` holds; a frame takes ~16 ms, the timer safety net 250 ms. */
  async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  it('buttons appear on their own, also for rows Discord adds later, and go when the buttons are switched off', async () => {
    ctx = await boot({ html: pageHtml(), realFrames: true });
    await until(() => allButtons().length === 9);
    expect(allButtons()).toHaveLength(9);

    document.querySelector('ul')!.insertAdjacentHTML('beforeend', channelRow({ id: '200000000000000060', name: 'later' }));
    await until(() => byKey('200000000000000060') !== null);
    expect(byKey('200000000000000060')).not.toBeNull();

    ctx.chrome.set({ [LOCAL.settings]: { showButtons: false } });
    await until(() => ownNodes().length === 0);
    expect(ownNodes()).toEqual([]);
  });
});

describe('clicking a channel button: queue/toggle', () => {
  it('sends the target of a text channel (category as parent, guild name from the tab title) and flips the icon from the answer', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(toggleResponder());
    const button = byKey(ID.general)!;
    click(button);
    await ctx.settle();

    expect(ctx.chrome.sentOf('queue/toggle')).toEqual([
      {
        to: 'bg',
        type: 'queue/toggle',
        target: {
          kind: 'guild-channel',
          channelId: ID.general,
          guildId: GUILD,
          guildName: 'Server One',
          channelName: 'general',
          parentId: ID.categoryA,
          parentName: 'Category A',
        },
      },
    ]);
    // the answer is applied at once: the stored queue (the worker's job) has not changed in this test
    expect(ctx.chrome.storage.get(LOCAL.queue(ACCOUNT.id))).toEqual([]);
    expect(button.getAttribute('data-dce-state')).toBe('queued');
    expect(button.getAttribute('aria-label')).toBe('다운로드 목록에서 빼기');
    expect(toastText()).toBe('다운로드 목록에 추가했어요 · 공통 설정');
    expect(toastEl()?.getAttribute('data-kind')).toBe('success');
  });

  it('a second click removes it again (toggle) with the other toast', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(toggleResponder());
    const button = byKey(ID.random)!;
    click(button);
    await ctx.settle();
    click(button);
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')).toHaveLength(2);
    expect(button.getAttribute('data-dce-state')).toBe('idle');
    expect(button.getAttribute('aria-label')).toBe('다운로드 목록에 추가');
    expect(toastText()).toBe('목록에서 뺐어요');
  });

  it('a channel before any category has no parent in its target', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(toggleResponder());
    click(byKey(ID.forum)!);
    await ctx.settle();
    const target = ctx.chrome.sentOf('queue/toggle')[0]!.target;
    expect(target).toEqual({ kind: 'guild-channel', channelId: ID.forum, guildId: GUILD, guildName: 'Server One', channelName: 'welcome' });
    expect('parentId' in target).toBe(false);
  });

  it('a voice row (no href) takes the guild from the address bar and its category from above', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(toggleResponder());
    click(byKey(ID.voice)!);
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')[0]!.target).toEqual({
      kind: 'guild-channel',
      channelId: ID.voice,
      guildId: GUILD,
      guildName: 'Server One',
      channelName: 'lounge',
      parentId: ID.categoryB,
      parentName: 'Category B',
    });
  });

  it('a thread is kind "thread" with its parent channel (not the category) as parent', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(toggleResponder());
    click(byKey(ID.thread)!);
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')[0]!.target).toEqual({
      kind: 'thread',
      channelId: ID.thread,
      guildId: GUILD,
      guildName: 'Server One',
      channelName: 'Thread A',
      parentId: ID.general,
      parentName: 'general',
    });
  });

  it('a DM is kind "dm" without guild, with its display name and avatar', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(toggleResponder());
    click(byKey(ID.dm)!);
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')[0]!.target).toEqual({
      kind: 'dm',
      channelId: ID.dm,
      guildId: null,
      guildName: null,
      channelName: 'Alex',
      iconUrl: `https://cdn.discordapp.com/avatars/${ID.userHash}/${ID.userHash}.webp?size=64`,
    });
  });

  it('a DM without an avatar sends iconUrl null', async () => {
    ctx = await boot({ html: dmRow({ id: ID.dm, name: 'Alex', avatar: null }) });
    ctx.chrome.respond(toggleResponder());
    click(byKey(ID.dm)!);
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')[0]!.target).toMatchObject({ kind: 'dm', iconUrl: null });
  });

  it('the target is read from the page at click time (a renamed channel is sent under its new name)', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(toggleResponder());
    const row = byKey(ID.random)!.closest('li')!;
    row.setAttribute('data-dnd-name', 'random-2');
    click(byKey(ID.random)!);
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')[0]!.target.channelName).toBe('random-2');
  });

  it('a second click while the first is still being answered is ignored (no add + remove race)', async () => {
    ctx = await boot({ html: pageHtml() });
    let release: (value: unknown) => void = () => undefined;
    ctx.chrome.respond(() => new Promise((resolve) => (release = resolve)));
    const button = byKey(ID.general)!;
    click(button);
    click(button);
    click(button);
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')).toHaveLength(1);
    release({ ok: true, data: { queued: true } });
    await ctx.settle();
    expect(button.getAttribute('data-dce-state')).toBe('queued');
    ctx.chrome.respond(toggleResponder([ID.general]));
    click(button); // free again
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')).toHaveLength(2);
  });

  it('other rows can be clicked while one request is pending', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(() => new Promise(() => undefined)); // never answered
    click(byKey(ID.general)!);
    click(byKey(ID.random)!);
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle').map((m) => m.target.channelId)).toEqual([ID.general, ID.random]);
  });
});

describe('answers that are not a success', () => {
  const cases: [string, unknown, string, string][] = [
    ['no-account', { ok: false, error: 'no-account' }, '디스코드 계정을 확인하는 중이에요. 잠시 후 다시 눌러 주세요', 'info'],
    ['no-consent', { ok: false, error: 'no-consent' }, '확장 프로그램 아이콘을 눌러 안내를 먼저 확인해 주세요', 'info'],
    ['busy', { ok: false, error: 'busy' }, '다른 작업을 처리하는 중이에요. 잠시 후 다시 눌러 주세요', 'info'],
    ['http', { ok: false, error: 'http', message: 'secret details' }, '디스코드에서 정보를 가져오지 못했어요. 잠시 후 다시 시도해 주세요', 'error'],
    ['unknown', { ok: false, error: 'unknown' }, '문제가 생겼어요. 잠시 후 다시 시도해 주세요', 'error'],
    ['invalid', { ok: false, error: 'invalid' }, '문제가 생겼어요. 잠시 후 다시 시도해 주세요', 'error'],
    ['forbidden-path', { ok: false, error: 'forbidden-path' }, '문제가 생겼어요. 잠시 후 다시 시도해 주세요', 'error'],
    ['no answer at all', undefined, '확장 프로그램과 연결하지 못했어요. 디스코드를 새로고침해 주세요', 'error'],
    ['a malformed answer', 'nonsense', '확장 프로그램과 연결하지 못했어요. 디스코드를 새로고침해 주세요', 'error'],
    ['success without data', { ok: true }, '문제가 생겼어요. 잠시 후 다시 시도해 주세요', 'error'],
  ];

  it.each(cases)('%s -> a toast, and the icon stays as it was', async (_name, answer, text, kind) => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(() => answer);
    const button = byKey(ID.general)!;
    click(button);
    await ctx.settle();
    expect(toastText()).toBe(text);
    expect(toastEl()?.getAttribute('data-kind')).toBe(kind);
    expect(button.getAttribute('data-dce-state')).toBe('idle');
  });

  it('never shows the background worker`s own message text', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(() => ({ ok: false, error: 'http', message: 'HTTP 403 for /api/v9/guilds/1/channels' }));
    click(byKey(ID.categoryA)!);
    await ctx.settle();
    expect(toastText()).not.toContain('403');
    expect(toastText()).not.toContain('/api');
  });

  it('a button can be used again after an error', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(() => ({ ok: false, error: 'no-account' }));
    const button = byKey(ID.general)!;
    click(button);
    await ctx.settle();
    ctx.chrome.respond(toggleResponder());
    click(button);
    await ctx.settle();
    expect(button.getAttribute('data-dce-state')).toBe('queued');
  });
});

describe('category buttons: queue/addCategory', () => {
  it('sends the category and the guild, and tells how many channels were added', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond((message) => (message.type === 'queue/addCategory' ? { ok: true, data: { added: 5, skipped: 2 } } : { ok: false, error: 'invalid' }));
    click(byKey(ID.categoryA)!);
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/addCategory')).toEqual([
      { to: 'bg', type: 'queue/addCategory', guildId: GUILD, guildName: 'Server One', categoryId: ID.categoryA, categoryName: 'Category A' },
    ]);
    expect(ctx.chrome.sentOf('queue/toggle')).toEqual([]);
    expect(toastText()).toBe('채널 5개를 추가했어요');
    expect(toastEl()?.getAttribute('data-kind')).toBe('success');
  });

  it('is a toggle with a check state: the icon turns into a check from the answer (no storage event needed), the next click takes it off', async () => {
    ctx = await boot({ html: pageHtml() });
    const button = byKey(ID.categoryA)!;
    expect(button.getAttribute('data-dce-state')).toBe('idle');
    ctx.chrome.respond(() => ({ ok: true, data: { added: 3, skipped: 0, removed: 0 } }));
    click(button);
    await ctx.settle();
    expect(button.getAttribute('data-dce-state')).toBe('queued');
    expect(button.getAttribute('aria-label')).toBe('이 카테고리 채널 전부 빼기');
    expect(button.querySelector('path')?.getAttribute('d')).toBe(CHECK_PATH);
    ctx.chrome.respond(() => ({ ok: true, data: { added: 0, skipped: 0, removed: 3 } }));
    click(button);
    await ctx.settle();
    expect(button.getAttribute('data-dce-state')).toBe('idle');
    expect(button.getAttribute('aria-label')).toBe('이 카테고리 채널 전부 추가');
    expect(button.querySelector('path')?.getAttribute('d')).toBe(DOWNLOAD_PATH);
    expect(ctx.chrome.sentOf('queue/addCategory')).toHaveLength(2);
  });

  it('channels were removed: how many (success), and the other categories are not touched', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(() => ({ ok: true, data: { added: 0, skipped: 0, removed: 4 } }));
    click(byKey(ID.categoryA)!);
    await ctx.settle();
    expect(toastText()).toBe('채널 4개를 목록에서 뺐어요');
    expect(toastEl()?.getAttribute('data-kind')).toBe('success');
    expect(byKey(ID.categoryB)!.getAttribute('data-dce-state')).toBe('idle');
  });

  it('an answer without `removed` (an older worker) counts as 0: it is an add', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(() => ({ ok: true, data: { added: 2, skipped: 1 } }));
    click(byKey(ID.categoryA)!);
    await ctx.settle();
    expect(toastText()).toBe('채널 2개를 추가했어요');
    expect(byKey(ID.categoryA)!.getAttribute('data-dce-state')).toBe('queued');
  });

  it('nothing to add and nothing to remove is said so (and is not an error); the state stays', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(() => ({ ok: true, data: { added: 0, skipped: 4, removed: 0 } }));
    click(byKey(ID.categoryA)!);
    await ctx.settle();
    expect(toastText()).toBe('추가할 새 채널이 없어요');
    expect(toastEl()?.getAttribute('data-kind')).toBe('info');
    expect(byKey(ID.categoryA)!.getAttribute('data-dce-state')).toBe('idle');
  });

  it('an empty category (the worker says so) gets its own text', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(() => ({ ok: false, error: 'empty' }));
    click(byKey(ID.categoryA)!);
    await ctx.settle();
    expect(toastText()).toBe('이 카테고리에는 담을 채널이 없어요');
  });

  it('English: one channel / many channels, added and removed', async () => {
    document.documentElement.lang = 'en';
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(() => ({ ok: true, data: { added: 1, skipped: 0, removed: 0 } }));
    click(byKey(ID.categoryA)!);
    await ctx.settle();
    expect(toastText()).toBe('Added 1 channel');
    ctx.chrome.respond(() => ({ ok: true, data: { added: 3, skipped: 0, removed: 0 } }));
    click(byKey(ID.categoryA)!);
    await ctx.settle();
    expect(toastText()).toBe('Added 3 channels');
    ctx.chrome.respond(() => ({ ok: true, data: { added: 0, skipped: 0, removed: 1 } }));
    click(byKey(ID.categoryA)!);
    await ctx.settle();
    expect(toastText()).toBe('Removed 1 channel from the list');
    ctx.chrome.respond(() => ({ ok: true, data: { added: 0, skipped: 0, removed: 3 } }));
    click(byKey(ID.categoryA)!);
    await ctx.settle();
    expect(toastText()).toBe('Removed 3 channels from the list');
  });
});

describe('the toast', () => {
  it('stays 2.5 seconds, then fades out and leaves the page; nothing of ours is left but the buttons and the style', async () => {
    vi.useFakeTimers();
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(toggleResponder());
    click(byKey(ID.general)!);
    await ctx.settle();
    expect(toastEl()?.getAttribute('data-visible')).toBe('true');
    expect(toastEl()?.getAttribute('role')).toBe('status');
    await vi.advanceTimersByTimeAsync(2499);
    expect(toastEl()?.getAttribute('data-visible')).toBe('true');
    await vi.advanceTimersByTimeAsync(1);
    expect(toastEl()?.getAttribute('data-visible')).toBe('false');
    await vi.advanceTimersByTimeAsync(300);
    expect(toastEl()).toBeNull();
    expect(document.getElementById('dce-style')).not.toBeNull(); // the buttons are still on
  });

  it('a newer toast replaces the one on screen and restarts the 2.5 s', async () => {
    vi.useFakeTimers();
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(toggleResponder());
    click(byKey(ID.general)!);
    await ctx.settle();
    await vi.advanceTimersByTimeAsync(2000);
    click(byKey(ID.random)!);
    await ctx.settle();
    expect(document.querySelectorAll('[data-dce="toast"]')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000); // 4 s after the first, 2 s after the second
    expect(toastEl()?.getAttribute('data-visible')).toBe('true');
    await vi.advanceTimersByTimeAsync(600);
    expect(toastEl()?.getAttribute('data-visible')).toBe('false');
  });

  it('is in the Discord look: bottom centre, polite status, an icon and the text', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(toggleResponder());
    click(byKey(ID.general)!);
    await ctx.settle();
    const toast = toastEl()!;
    expect(toast.getAttribute('aria-live')).toBe('polite');
    expect(toast.className).toBe('dce-toast');
    expect(toast.querySelector('svg')).not.toBeNull();
    expect(toast.parentElement?.id).toBe('dce-root');
    expect(toast.parentElement?.parentElement).toBe(document.body);
  });

  it('English when the page is English; an explicit language setting wins over the page', async () => {
    document.documentElement.lang = 'en-US';
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(toggleResponder());
    click(byKey(ID.general)!);
    await ctx.settle();
    expect(toastText()).toBe('Added to the download list · common settings');
    click(byKey(ID.general)!);
    await ctx.settle();
    expect(toastText()).toBe('Removed from the list');
    ctx.app.destroy();

    document.body.innerHTML = '';
    ctx = await boot({ html: pageHtml(), settings: { language: 'ko' } });
    ctx.chrome.respond(toggleResponder());
    click(byKey(ID.general)!);
    await ctx.settle();
    expect(toastText()).toBe('다운로드 목록에 추가했어요 · 공통 설정');
  });

  it('the no-account text is the one of the plan, in both languages', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(() => ({ ok: false, error: 'no-account' }));
    click(byKey(ID.general)!);
    await ctx.settle();
    expect(toastText()).toBe('디스코드 계정을 확인하는 중이에요. 잠시 후 다시 눌러 주세요');
    ctx.chrome.set({ [LOCAL.settings]: { language: 'en' } });
    await ctx.settle();
    click(byKey(ID.general)!);
    await ctx.settle();
    expect(toastText()).toBe('Checking your Discord account. Try again in a moment');
  });
});

describe('the queue as the storage says it', () => {
  it('icons follow chrome.storage.onChanged of the last account`s queue', async () => {
    ctx = await boot({ html: pageHtml(), queue: [ID.general] });
    expect(byKey(ID.general)!.getAttribute('data-dce-state')).toBe('queued');
    expect(byKey(ID.random)!.getAttribute('data-dce-state')).toBe('idle');
    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [{ key: ID.random }, { key: ID.dm }] });
    await ctx.settle();
    expect(byKey(ID.general)!.getAttribute('data-dce-state')).toBe('idle');
    expect(byKey(ID.random)!.getAttribute('data-dce-state')).toBe('queued');
    expect(byKey(ID.dm)!.getAttribute('data-dce-state')).toBe('queued');
    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [] });
    await ctx.settle();
    expect(allButtons().filter((b) => b.getAttribute('data-dce-state') === 'queued')).toEqual([]);
  });

  it('a removal from the popup is shown on the page (the list item was deleted)', async () => {
    ctx = await boot({ html: pageHtml(), queue: [ID.general, ID.random] });
    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [{ key: ID.random }] });
    await ctx.settle();
    expect(byKey(ID.general)!.getAttribute('data-dce-state')).toBe('idle');
    expect(byKey(ID.random)!.getAttribute('data-dce-state')).toBe('queued');
  });

  it('another account`s queue is not ours; switching the account re-reads the right one', async () => {
    ctx = await boot({ html: pageHtml(), queue: [ID.general] });
    ctx.chrome.set({ 'dce.queue.600000000000000009': [{ key: ID.random }] });
    await ctx.settle();
    expect(byKey(ID.random)!.getAttribute('data-dce-state')).toBe('idle');
    ctx.chrome.set({
      [LOCAL.lastAccount]: { ...ACCOUNT, id: '600000000000000009' },
    });
    await ctx.settle();
    expect(byKey(ID.general)!.getAttribute('data-dce-state')).toBe('idle');
    expect(byKey(ID.random)!.getAttribute('data-dce-state')).toBe('queued');
  });

  it('without any known account nothing is queued, and a click still reaches the worker (which says no-account)', async () => {
    ctx = await boot({ html: pageHtml(), account: false });
    expect(allButtons().every((b) => b.getAttribute('data-dce-state') === 'idle')).toBe(true);
    ctx.chrome.respond(() => ({ ok: false, error: 'no-account' }));
    click(byKey(ID.general)!);
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')).toHaveLength(1);
    expect(toastText()).toContain('계정을 확인');
  });

  it('a sloppy queue value in storage does no harm', async () => {
    ctx = await boot({ html: pageHtml(), rawQueue: [null, 5, { key: 7 }, { key: '' }, { key: ID.random }, 'x'] });
    expect(byKey(ID.random)!.getAttribute('data-dce-state')).toBe('queued');
    expect(byKey(ID.general)!.getAttribute('data-dce-state')).toBe('idle');
  });

  it('only the local area counts', async () => {
    ctx = await boot({ html: pageHtml(), queue: [ID.general] });
    ctx.chrome.changed({ [LOCAL.queue(ACCOUNT.id)]: { newValue: [] } }, 'session');
    await ctx.settle();
    expect(byKey(ID.general)!.getAttribute('data-dce-state')).toBe('queued');
  });
});

describe('option #17 (showQueuedIndicator) is retired: every button is always visible', () => {
  const forceClassed = (): string[] => allButtons().filter((b) => b.classList.contains('dce-always')).map((b) => b.getAttribute('data-dce-key')!);

  it('the setting is ignored whatever it says: every button carries the force class, queued or not', async () => {
    for (const settings of [undefined, { showQueuedIndicator: true }, { showQueuedIndicator: false }]) {
      document.body.innerHTML = '';
      ctx = await boot({ html: pageHtml(), queue: [ID.general, ID.dm], settings });
      expect(allButtons().length).toBeGreaterThan(0);
      expect(forceClassed()).toHaveLength(allButtons().length);
      expect(allButtons().some((b) => b.hasAttribute('data-dce-force'))).toBe(false);
      ctx.app.destroy();
    }
  });

  it('switching the old setting while the page is open changes nothing', async () => {
    ctx = await boot({ html: pageHtml(), queue: [ID.general] });
    const before = document.body.innerHTML;
    ctx.chrome.set({ [LOCAL.settings]: { showQueuedIndicator: true } });
    await ctx.settle();
    ctx.chrome.set({ [LOCAL.settings]: { showQueuedIndicator: false } });
    await ctx.settle();
    expect(document.body.innerHTML).toBe(before);
    expect(forceClassed()).toHaveLength(allButtons().length);
  });

  it('a click that queues a row (or removes it) does not change how it is shown: still always visible', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(toggleResponder());
    click(byKey(ID.random)!);
    await ctx.settle();
    expect(byKey(ID.random)!.getAttribute('data-dce-state')).toBe('queued');
    expect(byKey(ID.random)!.classList.contains('dce-always')).toBe(true);
    click(byKey(ID.random)!);
    await ctx.settle();
    expect(byKey(ID.random)!.classList.contains('dce-always')).toBe(true);
  });

  it('the stylesheet is put back when the page drops it', async () => {
    ctx = await boot({ html: pageHtml() });
    document.getElementById('dce-style')!.remove();
    ctx.app.injector.requestFullScan();
    await ctx.frame();
    expect(document.getElementById('dce-style')).not.toBeNull();
    expect(document.querySelectorAll('#dce-style')).toHaveLength(1);
  });

  it('the stylesheet keeps the buttons visible with !important (and a DM button as flex), whatever Discord`s hover rules say', async () => {
    ctx = await boot({ html: pageHtml() });
    const css = document.getElementById('dce-style')!.textContent!;
    expect(css).toMatch(/\.dce-always\s*\{[^}]*display:\s*block\s*!important/);
    expect(css).toMatch(/\.dce-always\[data-dce-kind="dm"\]\s*\{[^}]*display:\s*flex\s*!important/);
  });
});

describe('switching the buttons off and on (showButtons)', () => {
  it('stored as off: nothing is injected at all, not even the style', async () => {
    ctx = await boot({ html: pageHtml(), settings: { showButtons: false } });
    expect(ownNodes()).toEqual([]);
    expect(ctx.app.injector.active).toBe(false);
  });

  it('off while running: every injected node goes, the observer is disconnected; on: it starts again', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(toggleResponder());
    click(byKey(ID.general)!); // a toast on screen
    byKey(ID.random)!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); // a tooltip too
    await ctx.settle();
    expect(toastEl()).not.toBeNull();
    expect(document.querySelector('[data-dce="tooltip"]')).not.toBeNull();
    expect(ownNodes().length).toBeGreaterThan(4);

    ctx.chrome.set({ [LOCAL.settings]: { showButtons: false } });
    await ctx.settle();
    expect(ownNodes()).toEqual([]); // buttons, <style>, root, tooltip, toast
    expect(document.getElementById('dce-style')).toBeNull();
    expect(document.getElementById('dce-root')).toBeNull();
    expect(ctx.app.injector.active).toBe(false);

    // observer disconnected: new rows cause no pass and get no button
    document.querySelector('ul')!.insertAdjacentHTML('beforeend', channelRow({ id: '200000000000000042', name: 'new' }));
    await ctx.settle();
    expect(ctx.scheduler.pending).toBe(0);
    ctx.scheduler.run();
    expect(ownNodes()).toEqual([]);

    ctx.chrome.set({ [LOCAL.settings]: { showButtons: true } });
    await ctx.frame();
    expect(ctx.app.injector.active).toBe(true);
    expect(byKey('200000000000000042')).not.toBeNull(); // the row added while it was off
    expect(byKey(ID.general)).not.toBeNull();
    expect(document.getElementById('dce-style')).not.toBeNull();
    expect(allButtons().map((b) => b.getAttribute('data-dce-key'))).toEqual([
      ID.forum,
      ID.categoryA,
      ID.general,
      ID.thread,
      ID.random,
      ID.categoryB,
      ID.voice,
      '200000000000000042',
      ID.dm,
      ID.groupDm,
    ]);
  });

  it('clicking an old button handler after switching off does nothing (the buttons are gone, the events pass through)', async () => {
    ctx = await boot({ html: pageHtml() });
    const link = document.querySelector<HTMLElement>(`a[data-list-item-id$="___${ID.general}"]`)!;
    ctx.chrome.set({ [LOCAL.settings]: { showButtons: false } });
    await ctx.settle();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(ctx.chrome.sentOf('queue/toggle')).toEqual([]);
  });

  it('the shortcut still works while the buttons are off, and leaves nothing behind afterwards', async () => {
    vi.useFakeTimers();
    ctx = await boot({ html: pageHtml(), settings: { showButtons: false } });
    ctx.chrome.respond(toggleResponder());
    ctx.chrome.message({ to: 'content', type: 'shortcut/toggleCurrent' });
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')).toHaveLength(1);
    expect(toastText()).toBe('다운로드 목록에 추가했어요 · 공통 설정');
    await vi.advanceTimersByTimeAsync(3000);
    expect(ownNodes()).toEqual([]);
  });

  it('a standing health failure is cleared when the buttons are switched off', async () => {
    vi.useFakeTimers();
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general', container: false })) });
    await vi.advanceTimersByTimeAsync(10_500);
    expect(ctx.chrome.sentOf('inject/health').map((m) => m.health.ok)).toEqual([false]);
    ctx.chrome.set({ [LOCAL.settings]: { showButtons: false } });
    await ctx.settle();
    const reports = ctx.chrome.sentOf('inject/health').map((m) => [m.health.ok, m.health.reason]);
    expect(reports).toEqual([
      [false, expect.stringContaining('no-icon-container')],
      [true, 'disabled'],
    ]);
  });
});

describe('the keyboard shortcut (shortcut/toggleCurrent)', () => {
  const send = (): unknown[] => ctx!.chrome.message({ to: 'content', type: 'shortcut/toggleCurrent' });

  it('toggles the chat in the address bar, with the target of its sidebar row, and shows the toast', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(toggleResponder());
    expect(send()).toEqual([{ ok: true }]);
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')).toEqual([
      {
        to: 'bg',
        type: 'queue/toggle',
        target: {
          kind: 'guild-channel',
          channelId: ID.general,
          guildId: GUILD,
          guildName: 'Server One',
          channelName: 'general',
          parentId: ID.categoryA,
          parentName: 'Category A',
        },
      },
    ]);
    expect(toastText()).toBe('다운로드 목록에 추가했어요 · 공통 설정');
    expect(byKey(ID.general)!.getAttribute('data-dce-state')).toBe('queued'); // the row`s icon follows
    send();
    await ctx.settle();
    expect(toastText()).toBe('목록에서 뺐어요');
    expect(byKey(ID.general)!.getAttribute('data-dce-state')).toBe('idle');
  });

  it('a DM: /channels/@me/<id>', async () => {
    setPage(`/channels/@me/${ID.dm}`, 'Discord | @Alex');
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(toggleResponder());
    send();
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')[0]!.target).toMatchObject({ kind: 'dm', channelId: ID.dm, guildId: null, channelName: 'Alex' });
  });

  it('a jump link in the address bar (…/<channelId>/<messageId>) still means that channel', async () => {
    setPage(`/channels/${GUILD}/${ID.random}/900000000000000001`, SERVER_TITLE);
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(toggleResponder());
    send();
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')[0]!.target).toMatchObject({ channelId: ID.random, channelName: 'random' });
  });

  it('without a sidebar row (collapsed or scrolled away): a minimal target from the address and the title', async () => {
    const unlisted = '200000000000000077';
    setPage(`/channels/${GUILD}/${unlisted}`, '(2) Discord | #hidden-room | Server One');
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(toggleResponder());
    send();
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')[0]!.target).toEqual({
      kind: 'guild-channel',
      channelId: unlisted,
      guildId: GUILD,
      guildName: 'Server One',
      channelName: 'hidden-room',
    });
  });

  it('without a row and with a title that does not name the chat, the id stands in for the name', async () => {
    const unlisted = '200000000000000078';
    setPage(`/channels/${GUILD}/${unlisted}`, 'Discord | Thread title | #hidden-room | Server One');
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(toggleResponder());
    send();
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')[0]!.target).toMatchObject({ channelId: unlisted, channelName: unlisted });
  });

  it('a DM without a row: minimal dm target', async () => {
    const unlisted = '400000000000000077';
    setPage(`/channels/@me/${unlisted}`, 'Discord | @Robin');
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(toggleResponder());
    send();
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')[0]!.target).toEqual({
      kind: 'dm',
      channelId: unlisted,
      guildId: null,
      guildName: null,
      channelName: 'Robin',
      iconUrl: null,
    });
  });

  it('no chat open (friends page, settings): a toast, nothing sent', async () => {
    setPage('/channels/@me', 'Discord | Friends');
    ctx = await boot({ html: pageHtml() });
    send();
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')).toEqual([]);
    expect(toastText()).toBe('지금 보고 있는 채팅이 없어요');
  });

  it('errors are toasts like for a click', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond(() => ({ ok: false, error: 'no-account' }));
    send();
    await ctx.settle();
    expect(toastText()).toBe('디스코드 계정을 확인하는 중이에요. 잠시 후 다시 눌러 주세요');
  });

  it('ignores messages that are not for the content script or not known', async () => {
    ctx = await boot({ html: pageHtml() });
    expect(ctx.chrome.message({ to: 'bg', type: 'shortcut/toggleCurrent' })).toEqual([]);
    expect(ctx.chrome.message({ to: 'content', type: 'something/else' })).toEqual([]);
    expect(ctx.chrome.message('toggle')).toEqual([]);
    expect(ctx.chrome.message(null)).toEqual([]);
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/toggle')).toEqual([]);
    expect(toastEl()).toBeNull();
  });
});

describe('only what the plan allows leaves the content script', () => {
  it('messages: queue/toggle, queue/addCategory, queue/groupInfo, inject/health; storage writes: theme and classCache', async () => {
    vi.useFakeTimers();
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.respond((message) => (message.type === 'queue/addCategory' ? { ok: true, data: { added: 1, skipped: 0, removed: 0 } } : { ok: true, data: { queued: true } }));
    click(byKey(ID.general)!);
    click(byKey(ID.categoryA)!);
    click(byKey(ID.dm)!);
    ctx.chrome.message({ to: 'content', type: 'shortcut/toggleCurrent' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(new Set(ctx.chrome.sent.map((m) => m.type))).toEqual(new Set(['queue/toggle', 'queue/addCategory', 'queue/groupInfo', 'inject/health']));
    const keys = new Set(ctx.chrome.writes.flatMap((write) => Object.keys(write)));
    expect(Array.from(keys).sort()).toEqual([LOCAL.classCache, LOCAL.theme].sort());
  });
});

describe('the extension is reloaded or removed (context invalidated)', () => {
  it('the next pass tears everything down silently', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ctx = await boot({ html: pageHtml() });
    expect(allButtons().length).toBeGreaterThan(0);
    ctx.chrome.invalidate();
    document.querySelector('ul')!.insertAdjacentHTML('beforeend', channelRow({ id: '200000000000000050', name: 'late' }));
    await ctx.frame();
    expect(ctx.app.destroyed).toBe(true);
    expect(ownNodes()).toEqual([]);
    expect(ctx.chrome.storageListeners).toBe(0);
    expect(ctx.chrome.messageListeners).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });

  it('an idle page notices it with the periodic check', async () => {
    vi.useFakeTimers();
    ctx = await boot({ html: pageHtml() });
    ctx.chrome.invalidate();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(ctx.app.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ctx.app.destroyed).toBe(true);
    expect(ownNodes()).toEqual([]);
  });

  it('a click on an orphaned button is swallowed (not a navigation), without errors, and cleans up', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ctx = await boot({ html: pageHtml() });
    const button = byKey(ID.general)!;
    ctx.chrome.invalidate();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    expect(() => button.dispatchEvent(event)).not.toThrow();
    await ctx.settle();
    expect(event.defaultPrevented).toBe(true);
    expect(ctx.app.destroyed).toBe(true);
    expect(ownNodes()).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
  });

  it('dying while a request is in flight: no toast, no error, everything removed', async () => {
    ctx = await boot({ html: pageHtml() });
    let release: (value: unknown) => void = () => undefined;
    ctx.chrome.respond(() => new Promise((resolve) => (release = resolve)));
    click(byKey(ID.general)!);
    await ctx.settle();
    ctx.chrome.invalidate();
    release({ ok: true, data: { queued: true } });
    await ctx.settle();
    expect(ctx.app.destroyed).toBe(true);
    expect(ownNodes()).toEqual([]);
  });

  it('a storage event after the context died only cleans up', async () => {
    ctx = await boot({ html: pageHtml(), queue: [ID.general] });
    ctx.chrome.invalidate();
    ctx.chrome.changed({ [LOCAL.queue(ACCOUNT.id)]: { newValue: [] } });
    expect(ctx.app.destroyed).toBe(true);
    expect(ownNodes()).toEqual([]);
  });

  it('starting in an already dead context does nothing', async () => {
    mount(pageHtml());
    ctx = await boot({ noStart: true });
    ctx.chrome.invalidate();
    await ctx.app.start();
    expect(ctx.app.destroyed).toBe(true);
    expect(ownNodes()).toEqual([]);
  });

  it('an unexpected error while starting leaves the page exactly as it was (no half-decorated sidebar, no rejection)', async () => {
    mount(pageHtml());
    const before = document.body.innerHTML;
    ctx = await boot({ noStart: true });
    vi.stubGlobal(
      'MutationObserver',
      class {
        constructor() {
          throw new Error('boom');
        }
      },
    );
    await expect(ctx.app.start()).resolves.toBeUndefined();
    expect(ctx.app.destroyed).toBe(true);
    expect(document.body.innerHTML).toBe(before);
    expect(ctx.chrome.storageListeners).toBe(0);
  });

  it('destroy() is safe to call again, and nothing runs after it', async () => {
    ctx = await boot({ html: pageHtml() });
    ctx.app.destroy();
    expect(() => ctx!.app.destroy()).not.toThrow();
    document.querySelector('ul')!.insertAdjacentHTML('beforeend', channelRow({ id: '200000000000000051', name: 'later' }));
    await ctx.frame();
    expect(ownNodes()).toEqual([]);
    expect(ctx.chrome.storageListeners).toBe(0);
  });
});
