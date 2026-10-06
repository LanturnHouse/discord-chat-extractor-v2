// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToBackground } from '@/shared/messages';
import { CHECK_PATH, DOWNLOAD_PATH } from '@/content/inject/icons';
import { LOCAL } from '@/shared/storageKeys';
import { ACCOUNT, boot, groupsValue, type Booted } from './helpers/app';
import {
  GUILD,
  GUILD_TWO,
  ID,
  allButtons,
  byKey,
  categoryRow,
  channelRow,
  dmRow,
  guildButtons,
  guildHeader,
  guildSidebar,
  setPage,
  sidebar,
} from './helpers/fixtures';

// The category and server buttons as toggles with a check state, and the group info the page asks the worker for
// (PLAN §2 "추가 UX 규칙", §3 "그룹 정보", §7.1).

let ctx: Booted | null = null;

const SERVER_TITLE = 'Discord | #general | Server One';
const OTHER_ACCOUNT = '600000000000000009';

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

/** Server header + category A (general, random) + category B (a voice channel). */
const page = (): string =>
  guildSidebar(
    guildHeader(),
    categoryRow({ id: ID.categoryA, name: 'Category A' }),
    channelRow({ id: ID.general, name: 'general' }),
    channelRow({ id: ID.random, name: 'random' }),
    categoryRow({ id: ID.categoryB, name: 'Category B' }),
    channelRow({ id: ID.voice, name: 'lounge', voice: true }),
  );

const CHANNELS_A = [ID.general, ID.random];
const toastEl = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-dce="toast"]');
const toastText = (): string | undefined => toastEl()?.textContent ?? undefined;
const click = (el: Element): void => void el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
const stateOf = (id: string): string | null => byKey(id)!.getAttribute('data-dce-state');
const iconOf = (button: HTMLElement): string | null => button.querySelector('path')!.getAttribute('d');
const guildButton = (): HTMLElement => guildButtons()[0]!;

type Counts = { added: number; skipped: number; removed: number };
/** A worker that answers the group requests with `counts` (the others with an error). */
const answers =
  (counts: Counts) =>
  (message: ToBackground): unknown =>
    message.type === 'queue/addCategory' || message.type === 'queue/addGuild' ? { ok: true, data: counts } : { ok: false, error: 'invalid' };

describe('the check matrix of a category button: checked iff the group exists, has a channel, and every channel is in the list', () => {
  const cases: [string, string[], Record<string, string[]> | undefined, boolean][] = [
    ['no group is known at all', CHANNELS_A, undefined, false],
    ['a group for another category only', CHANNELS_A, { [ID.categoryB]: [ID.voice] }, false],
    ['the group is empty', CHANNELS_A, { [ID.categoryA]: [] }, false],
    ['partial: one channel is missing from the list', [ID.general], { [ID.categoryA]: CHANNELS_A }, false],
    ['partial: none is in the list', [], { [ID.categoryA]: CHANNELS_A }, false],
    ['complete', CHANNELS_A, { [ID.categoryA]: CHANNELS_A }, true],
    ['complete, and the list holds other chats too', [...CHANNELS_A, ID.voice, ID.dm], { [ID.categoryA]: CHANNELS_A }, true],
    ['one channel only, in the list', [ID.general], { [ID.categoryA]: [ID.general] }, true],
    ['a channel of the group is in the list only as the category id itself', [ID.categoryA], { [ID.categoryA]: [ID.general] }, false],
  ];

  it.each(cases)('%s', async (_name, queue, groups, expected) => {
    ctx = await boot({ html: page(), queue, groups });
    expect(stateOf(ID.categoryA)).toBe(expected ? 'queued' : 'idle');
    expect(iconOf(byKey(ID.categoryA)!)).toBe(expected ? CHECK_PATH : DOWNLOAD_PATH);
    expect(byKey(ID.categoryA)!.getAttribute('aria-label')).toBe(expected ? '이 카테고리 채널 전부 빼기' : '이 카테고리 채널 전부 추가');
  });

  it('every category has its own state, and the server its own', async () => {
    ctx = await boot({
      html: page(),
      queue: [...CHANNELS_A],
      groups: { [ID.categoryA]: CHANNELS_A, [ID.categoryB]: [ID.voice], [GUILD]: [...CHANNELS_A, ID.voice] },
    });
    expect(stateOf(ID.categoryA)).toBe('queued');
    expect(stateOf(ID.categoryB)).toBe('idle');
    expect(guildButton().getAttribute('data-dce-state')).toBe('idle');
  });

  it('a malformed groups value in storage does no harm: nothing is checked', async () => {
    ctx = await boot({ html: page(), queue: CHANNELS_A, rawGroups: { [ID.categoryA]: { channelIds: 'oops' }, [GUILD]: 5 } });
    expect(stateOf(ID.categoryA)).toBe('idle');
    expect(guildButton().getAttribute('data-dce-state')).toBe('idle');
  });

  it('without any known account nothing is checked', async () => {
    ctx = await boot({ html: page(), account: false });
    expect(allButtons().every((b) => b.getAttribute('data-dce-state') === 'idle')).toBe(true);
    expect(guildButton().getAttribute('data-dce-state')).toBe('idle');
  });
});

describe('the check state follows the storage (both buttons)', () => {
  it('a channel added / removed elsewhere (popup, another tab) flips the check at once', async () => {
    ctx = await boot({ html: page(), queue: [ID.general], groups: { [ID.categoryA]: CHANNELS_A, [GUILD]: CHANNELS_A } });
    expect(stateOf(ID.categoryA)).toBe('idle');
    expect(guildButton().getAttribute('data-dce-state')).toBe('idle');
    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: CHANNELS_A.map((key) => ({ key })) });
    await ctx.settle();
    expect(stateOf(ID.categoryA)).toBe('queued');
    expect(guildButton().getAttribute('data-dce-state')).toBe('queued');
    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [{ key: ID.random }] });
    await ctx.settle();
    expect(stateOf(ID.categoryA)).toBe('idle');
    expect(guildButton().getAttribute('data-dce-state')).toBe('idle');
  });

  it('the worker records a group (queue/groupInfo, or with the answer of a click): the check appears', async () => {
    ctx = await boot({ html: page(), queue: CHANNELS_A });
    expect(stateOf(ID.categoryA)).toBe('idle'); // the queue is full, but no group is known
    ctx.chrome.set({ [LOCAL.groups(ACCOUNT.id)]: groupsValue({ [ID.categoryA]: CHANNELS_A, [GUILD]: CHANNELS_A }) });
    await ctx.settle();
    expect(stateOf(ID.categoryA)).toBe('queued');
    expect(guildButton().getAttribute('data-dce-state')).toBe('queued');
    ctx.chrome.set({ [LOCAL.groups(ACCOUNT.id)]: groupsValue({ [ID.categoryA]: [...CHANNELS_A, ID.forum], [GUILD]: CHANNELS_A }) }); // a new channel
    await ctx.settle();
    expect(stateOf(ID.categoryA)).toBe('idle');
    expect(guildButton().getAttribute('data-dce-state')).toBe('queued');
  });

  it('another account`s groups are not ours', async () => {
    ctx = await boot({ html: page(), queue: CHANNELS_A });
    ctx.chrome.set({ [LOCAL.groups(OTHER_ACCOUNT)]: groupsValue({ [ID.categoryA]: CHANNELS_A }) });
    await ctx.settle();
    expect(stateOf(ID.categoryA)).toBe('idle');
  });

  it('account switch: the buttons show the state of the new account, and of the old one again when it comes back', async () => {
    ctx = await boot({
      html: page(),
      queue: CHANNELS_A,
      groups: { [ID.categoryA]: CHANNELS_A, [GUILD]: CHANNELS_A },
      stored: {
        [LOCAL.queue(OTHER_ACCOUNT)]: [{ key: ID.general }],
        [LOCAL.groups(OTHER_ACCOUNT)]: groupsValue({ [ID.categoryA]: CHANNELS_A, [GUILD]: CHANNELS_A }),
      },
    });
    expect(stateOf(ID.categoryA)).toBe('queued');
    expect(guildButton().getAttribute('data-dce-state')).toBe('queued');

    ctx.chrome.set({ [LOCAL.lastAccount]: { ...ACCOUNT, id: OTHER_ACCOUNT } });
    await ctx.settle();
    expect(stateOf(ID.categoryA)).toBe('idle'); // the other account has only one of the two channels
    expect(guildButton().getAttribute('data-dce-state')).toBe('idle');

    ctx.chrome.set({ [LOCAL.queue(OTHER_ACCOUNT)]: CHANNELS_A.map((key) => ({ key })) });
    await ctx.settle();
    expect(stateOf(ID.categoryA)).toBe('queued');

    ctx.chrome.set({ [LOCAL.lastAccount]: ACCOUNT });
    await ctx.settle();
    expect(stateOf(ID.categoryA)).toBe('queued'); // the first account is complete as well
    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [] });
    await ctx.settle();
    expect(stateOf(ID.categoryA)).toBe('idle');
  });

  it('an account without groups and queue yet: nothing is checked, and a click is still possible', async () => {
    ctx = await boot({ html: page(), queue: CHANNELS_A, groups: { [ID.categoryA]: CHANNELS_A } });
    ctx.chrome.set({ [LOCAL.lastAccount]: { ...ACCOUNT, id: OTHER_ACCOUNT } });
    await ctx.settle();
    expect(stateOf(ID.categoryA)).toBe('idle');
  });
});

describe('a click: the icon follows the answer at once, then the storage', () => {
  it('category: added -> check before any storage event; the storage then agrees and stays in charge', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(answers({ added: 2, skipped: 0, removed: 0 }));
    click(byKey(ID.categoryA)!);
    await ctx.settle();
    expect(stateOf(ID.categoryA)).toBe('queued');
    expect(toastText()).toBe('채널 2개를 추가했어요');

    // what the worker wrote: the queue first, then the group (two events)
    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: CHANNELS_A.map((key) => ({ key })) });
    await ctx.settle();
    expect(stateOf(ID.categoryA)).toBe('queued'); // no flicker back to the arrow while the group has not arrived
    ctx.chrome.set({ [LOCAL.groups(ACCOUNT.id)]: groupsValue({ [ID.categoryA]: CHANNELS_A }) });
    await ctx.settle();
    expect(stateOf(ID.categoryA)).toBe('queued');

    // and a later removal elsewhere is not hidden by the old answer
    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [{ key: ID.general }] });
    await ctx.settle();
    expect(stateOf(ID.categoryA)).toBe('idle');
  });

  it('category: removed -> the arrow before any storage event', async () => {
    ctx = await boot({ html: page(), queue: CHANNELS_A, groups: { [ID.categoryA]: CHANNELS_A } });
    expect(stateOf(ID.categoryA)).toBe('queued');
    ctx.chrome.respond(answers({ added: 0, skipped: 0, removed: 2 }));
    click(byKey(ID.categoryA)!);
    await ctx.settle();
    expect(stateOf(ID.categoryA)).toBe('idle');
    expect(toastText()).toBe('채널 2개를 목록에서 뺐어요');
    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [] });
    await ctx.settle();
    expect(stateOf(ID.categoryA)).toBe('idle');
  });

  it('server: the same, through the server button', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(answers({ added: 3, skipped: 0, removed: 0 }));
    click(guildButton());
    await ctx.settle();
    expect(guildButton().getAttribute('data-dce-state')).toBe('queued');
    expect(iconOf(guildButton())).toBe(CHECK_PATH);
    expect(toastText()).toBe('채널 3개를 추가했어요');
    ctx.chrome.respond(answers({ added: 0, skipped: 0, removed: 3 }));
    click(guildButton());
    await ctx.settle();
    expect(guildButton().getAttribute('data-dce-state')).toBe('idle');
    expect(iconOf(guildButton())).toBe(DOWNLOAD_PATH);
    expect(toastText()).toBe('채널 3개를 목록에서 뺐어요');
  });

  it('the category answer does not touch the server button, nor the other way round', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(answers({ added: 2, skipped: 0, removed: 0 }));
    click(byKey(ID.categoryA)!);
    await ctx.settle();
    expect(guildButton().getAttribute('data-dce-state')).toBe('idle');
    expect(stateOf(ID.categoryB)).toBe('idle');
    click(guildButton());
    await ctx.settle();
    expect(guildButton().getAttribute('data-dce-state')).toBe('queued');
    expect(stateOf(ID.categoryB)).toBe('idle');
  });

  it('nothing to do (0 added, 0 removed): the info text, and the state is left as it was', async () => {
    ctx = await boot({ html: page(), queue: [ID.general], groups: { [ID.categoryA]: CHANNELS_A } });
    ctx.chrome.respond(answers({ added: 0, skipped: 1, removed: 0 }));
    click(byKey(ID.categoryA)!);
    await ctx.settle();
    expect(toastText()).toBe('추가할 새 채널이 없어요');
    expect(toastEl()?.getAttribute('data-kind')).toBe('info');
    expect(stateOf(ID.categoryA)).toBe('idle');
    click(guildButton());
    await ctx.settle();
    expect(toastText()).toBe('추가할 채널이 없어요 (이미 모두 목록에 있어요)');
    expect(guildButton().getAttribute('data-dce-state')).toBe('idle');
  });

  it('an error leaves the state as it was', async () => {
    ctx = await boot({ html: page(), queue: CHANNELS_A, groups: { [ID.categoryA]: CHANNELS_A } });
    ctx.chrome.respond(() => ({ ok: false, error: 'http' }));
    click(byKey(ID.categoryA)!);
    await ctx.settle();
    expect(stateOf(ID.categoryA)).toBe('queued');
    expect(toastEl()?.getAttribute('data-kind')).toBe('error');
  });

  it('an answer the storage never confirms gives way to the storage after a few seconds', async () => {
    vi.useFakeTimers();
    ctx = await boot({ html: page() });
    ctx.chrome.respond(answers({ added: 2, skipped: 0, removed: 0 }));
    click(byKey(ID.categoryA)!);
    await ctx.settle();
    expect(stateOf(ID.categoryA)).toBe('queued');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(stateOf(ID.categoryA)).toBe('queued');
    await vi.advanceTimersByTimeAsync(1);
    // No storage event, no DOM mutation, nobody touching the buttons: the answer's own timer puts the storage's word on screen.
    expect(stateOf(ID.categoryA)).toBe('idle');
    expect(iconOf(byKey(ID.categoryA)!)).toBe(DOWNLOAD_PATH);
  });

  it('the same for the server button, on a page where nothing else happens for a minute', async () => {
    vi.useFakeTimers();
    ctx = await boot({ html: page() });
    ctx.chrome.respond(answers({ added: 3, skipped: 0, removed: 0 }));
    click(guildButton());
    await ctx.settle();
    expect(guildButton().getAttribute('data-dce-state')).toBe('queued');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(guildButton().getAttribute('data-dce-state')).toBe('idle');
    expect(iconOf(guildButton())).toBe(DOWNLOAD_PATH);
  });

  it('an answer the storage confirms stays checked once the timer would have run out', async () => {
    vi.useFakeTimers();
    ctx = await boot({ html: page() });
    ctx.chrome.respond(answers({ added: 2, skipped: 0, removed: 0 }));
    click(byKey(ID.categoryA)!);
    await ctx.settle();
    ctx.chrome.set({ [LOCAL.groups(ACCOUNT.id)]: groupsValue({ [ID.categoryA]: CHANNELS_A }), [LOCAL.queue(ACCOUNT.id)]: CHANNELS_A.map((key) => ({ key })) });
    await ctx.frame();
    expect(stateOf(ID.categoryA)).toBe('queued');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stateOf(ID.categoryA)).toBe('queued');
  });
});

describe('queue/groupInfo: the page tells the worker which server it shows (once per server per 5 minutes)', () => {
  const infos = (): ToBackground[] => ctx!.chrome.sentOf('queue/groupInfo');
  const rescan = async (): Promise<void> => {
    ctx!.app.injector.requestFullScan();
    await ctx!.frame();
  };

  it('is sent with the guild of the address and its name when the page shows the server', async () => {
    ctx = await boot({ html: page() });
    expect(infos()).toEqual([{ to: 'bg', type: 'queue/groupInfo', guildId: GUILD, guildName: 'Server One' }]);
  });

  it('a channel list without a header (or a header without rows) is enough, and the name comes from the title when there is no header', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    expect(infos()).toEqual([{ to: 'bg', type: 'queue/groupInfo', guildId: GUILD, guildName: 'Server One' }]);
    ctx.app.destroy();

    document.body.innerHTML = '';
    ctx = await boot({ html: guildSidebar(guildHeader({ name: 'Header Name' })) });
    expect(infos()).toEqual([{ to: 'bg', type: 'queue/groupInfo', guildId: GUILD, guildName: 'Header Name' }]);
  });

  it('the name is null when nothing says it', async () => {
    setPage(`/channels/${GUILD}/${ID.general}`, 'Discord');
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    expect(infos()).toEqual([{ to: 'bg', type: 'queue/groupInfo', guildId: GUILD, guildName: null }]);
  });

  it('at most once per 5 minutes, however many passes see the server', async () => {
    vi.useFakeTimers();
    ctx = await boot({ html: page() });
    expect(infos()).toHaveLength(1);
    for (let i = 0; i < 5; i++) await rescan();
    document.querySelector('ul')!.insertAdjacentHTML('beforeend', channelRow({ id: ID.forum, name: 'ideas' }));
    await ctx.frame();
    expect(infos()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(299_000);
    await rescan();
    expect(infos()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000); // 5 minutes
    await rescan();
    expect(infos()).toHaveLength(2);
    await rescan();
    expect(infos()).toHaveLength(2);
  });

  it('once per server: another server is reported at once, going back to the first within 5 minutes is not', async () => {
    ctx = await boot({ html: page() });
    expect(infos()).toHaveLength(1);

    setPage(`/channels/${GUILD_TWO}/${ID.random}`, 'Discord | #random | Server Two');
    document.body.innerHTML = guildSidebar(guildHeader({ name: 'Server Two' }), channelRow({ id: ID.random, name: 'random', guildId: GUILD_TWO }));
    await ctx.frame();
    expect(infos().map((m) => (m as { guildId: string }).guildId)).toEqual([GUILD, GUILD_TWO]);
    expect(infos()[1]).toEqual({ to: 'bg', type: 'queue/groupInfo', guildId: GUILD_TWO, guildName: 'Server Two' });

    setPage(`/channels/${GUILD}/${ID.general}`, SERVER_TITLE);
    document.body.innerHTML = page();
    await ctx.frame();
    expect(infos()).toHaveLength(2);
  });

  it('never for a DM or a page that is no server', async () => {
    setPage(`/channels/@me/${ID.dm}`, 'Discord | @Alex');
    ctx = await boot({ html: dmRow({ id: ID.dm, name: 'Alex' }) });
    expect(allButtons()).toHaveLength(1);
    expect(infos()).toEqual([]);
    ctx.app.destroy();

    document.body.innerHTML = '';
    setPage('/store', 'Discord | Shop');
    ctx = await boot({ html: guildSidebar(guildHeader()) });
    expect(infos()).toEqual([]);
  });

  it('never when nothing of a server is on the page (chat messages, noise)', async () => {
    ctx = await boot({ html: '<div id="chat"><ol><li data-list-item-id="chat-messages___a-b"></li></ol></div>' });
    await rescan();
    expect(infos()).toEqual([]);
  });

  it('never while the buttons are switched off, and it starts when they are switched on', async () => {
    ctx = await boot({ html: page(), settings: { showButtons: false } });
    await rescan();
    expect(infos()).toEqual([]);
    ctx.chrome.set({ [LOCAL.settings]: { showButtons: true } });
    await ctx.frame();
    expect(infos()).toHaveLength(1);
  });

  it('no account known when it was sent: it is sent again once an account becomes known, not before', async () => {
    ctx = await boot({ html: page(), account: false });
    expect(infos()).toHaveLength(1); // the worker may know the account even if the page does not: it is tried
    await rescan();
    expect(infos()).toHaveLength(1);

    ctx.chrome.set({ [LOCAL.lastAccount]: ACCOUNT });
    await ctx.frame();
    expect(infos()).toHaveLength(2);
    await rescan();
    expect(infos()).toHaveLength(2); // and then it is throttled as usual
  });

  /** Boots with `answer` as the worker`s reply from the very first message on (the first pass already sends). */
  async function bootAnswering(answer: (message: ToBackground) => unknown): Promise<Booted> {
    const booted = await boot({ html: page(), noStart: true });
    booted.chrome.respond(answer);
    await booted.app.start();
    await booted.frame();
    return booted;
  }

  it('the worker said no-account although the page knew one: it is sent again when the account changes, not before', async () => {
    ctx = await bootAnswering(() => ({ ok: false, error: 'no-account' }));
    expect(infos()).toHaveLength(1);
    await rescan(); // throttled
    expect(infos()).toHaveLength(1);
    ctx.chrome.set({ [LOCAL.lastAccount]: { ...ACCOUNT, id: OTHER_ACCOUNT } });
    await ctx.frame();
    expect(infos()).toHaveLength(2);
    await rescan();
    expect(infos()).toHaveLength(2);
  });

  it('the worker said no-account although the page knew one, and the account never changes: it is sent again soon, by itself', async () => {
    vi.useFakeTimers();
    let answered = 0;
    ctx = await bootAnswering((message) => {
      if (message.type !== 'queue/groupInfo') return { ok: false, error: 'invalid' };
      return ++answered === 1 ? { ok: false, error: 'no-account' } : { ok: true, data: undefined };
    });
    expect(infos()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(19_999);
    await ctx.frame();
    expect(infos()).toHaveLength(1);
    // LOCAL.lastAccount is never written again; nobody rescans, nothing mutates the page: the retry's own timer asks for a pass.
    await vi.advanceTimersByTimeAsync(1);
    await ctx.frame();
    expect(infos()).toHaveLength(2);
    expect(infos()[1]).toEqual({ to: 'bg', type: 'queue/groupInfo', guildId: GUILD, guildName: 'Server One' });
    await vi.advanceTimersByTimeAsync(60_000); // the second send was served: back to once per 5 minutes
    await ctx.frame();
    await rescan();
    expect(infos()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(240_000);
    await rescan();
    expect(infos()).toHaveLength(3);
  });

  it('a worker that keeps saying no-account is asked a few times, then left alone for the rest of the 5 minutes', async () => {
    vi.useFakeTimers();
    ctx = await bootAnswering(() => ({ ok: false, error: 'no-account' }));
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      await ctx.frame();
    }
    expect(infos()).toHaveLength(7);
    await rescan();
    expect(infos()).toHaveLength(7);
  });

  it('tearing the page script down cancels a pending retry', async () => {
    vi.useFakeTimers();
    ctx = await bootAnswering(() => ({ ok: false, error: 'no-account' }));
    const before = infos().length;
    ctx.app.destroy();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(infos()).toHaveLength(before);
  });

  it('a send that was served is not a reason to send again when the account changes', async () => {
    ctx = await bootAnswering(() => ({ ok: true, data: undefined }));
    expect(infos()).toHaveLength(1);
    ctx.chrome.set({ [LOCAL.lastAccount]: { ...ACCOUNT, id: OTHER_ACCOUNT } });
    await ctx.frame();
    expect(infos()).toHaveLength(1);
  });

  it.each([
    ['an error answer', () => ({ ok: false, error: 'http' })],
    ['no consent yet', () => ({ ok: false, error: 'no-consent' })],
    ['no answer', () => undefined],
    ['a malformed answer', () => 'nonsense'],
    ['a rejected send', () => Promise.reject(new Error('boom'))],
  ])('failures are silent (%s): no toast, no console error, no retry', async (_name, answer) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ctx = await bootAnswering(answer);
    await rescan();
    await rescan();
    expect(toastEl()).toBeNull();
    expect(infos()).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it('a dead extension context sends nothing and says nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ctx = await boot({ html: page() });
    const before = infos().length;
    ctx.chrome.invalidate();
    document.querySelector('ul')!.insertAdjacentHTML('beforeend', channelRow({ id: ID.forum, name: 'ideas' }));
    await ctx.frame();
    expect(ctx.app.destroyed).toBe(true);
    expect(ctx.chrome.sent.filter((m) => m.type === 'queue/groupInfo')).toHaveLength(before);
    expect(errors).not.toHaveBeenCalled();
  });

  it('the group info request does not hold back, or get mixed up with, a click', async () => {
    ctx = await boot({ html: page() });
    ctx.chrome.respond(answers({ added: 1, skipped: 0, removed: 0 }));
    click(byKey(ID.categoryA)!);
    await ctx.settle();
    expect(ctx.chrome.sentOf('queue/addCategory')).toHaveLength(1);
    expect(toastText()).toBe('채널 1개를 추가했어요');
  });
});
