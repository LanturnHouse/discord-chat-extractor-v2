// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RISK_MAX_CHATS } from '@/popup/downloadRisk';
import { createPopupStore, type PopupStore } from '@/popup/store';
import { DEFAULT_EXPORT_SETTINGS, LOCAL, SESSION, type HistoryEntry, type QueueItem } from '@/shared';
import { MOCK_ACCOUNT, MOCK_CATEGORIES, MOCK_GUILDS, MOCK_TARGETS, TREE_TARGETS, createMockPlatform, sampleRunningJob, type MockPlatform, type MockScenario } from '@/ui/platform/mock';
import { declOf } from '../ui/cssCascade';
import { button, groupRows, renderPopup, row, sentMessages, settle } from './helpers';

afterEach(() => {
  cleanup(); // vitest globals are off, so testing-library cannot register its own cleanup
  vi.restoreAllMocks();
});

/*
 * The safety question before a big download (Discord can limit an account that makes a lot of automated requests): the start
 * buttons of the footer, of a server / category line and of a chat ask first when the start is big, and send `job/start` only
 * after [계속 받기]. The scenario `risk` is the sample list of 12 chats: "#questions" asks for 25,000 messages with its threads,
 * "Book Club › #reading" reads everything with no start date.
 */

const S1 = MOCK_GUILDS.sample.id; // Sample Server: 7 chats in the list
const S2 = MOCK_GUILDS.study.id; // Study Group: 3 small chats
const STUDY = MOCK_CATEGORIES.study.id; // a category of Sample Server: "#questions" is in it
const T = TREE_TARGETS;
const ACCOUNT = MOCK_ACCOUNT.id;
const key = (target: { channelId: string }): string => target.channelId;
const SAMPLE_KEYS = [T.welcome, T.general, T.questions, T.resources, T.chat, T.oldNews, T.weekend].map(key);
const STUDY_KEYS = [T.announcements, T.math, T.physics].map(key);

const QUESTION = (count: number): string => `채팅 ${count}개를 한 번에 받으려고 해요. 대량 다운로드는 디스코드 계정이 제한될 위험이 커져요.`;
const MANY_CHATS = '채팅이 많아요 (10개 초과)';
const UNBOUNDED = '기간·개수 제한 없이 전체 메시지를 받는 채팅이 있어요';
const MANY_MESSAGES = (estimate: string): string => `요청하는 메시지가 매우 많아요 (약 ${estimate}개)`;
const THREADS = '스레드 포함은 요청이 크게 늘어요';

const risk = (options: Parameters<typeof renderPopup>[0] = {}) => renderPopup({ scenario: 'risk', ...options });
const panels = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.dce-confirm'));
const panel = (): HTMLElement => {
  const found = panels();
  if (found.length !== 1) throw new Error(`${found.length} confirmations on screen`);
  return found[0];
};
const reasonsOf = (element: HTMLElement): string[] => Array.from(element.querySelectorAll('.dce-confirm__details li')).map((li) => li.textContent ?? '');
const line = (id: string): HTMLElement => {
  const li = groupRows().find((candidate) => candidate.dataset.groupId === id);
  if (li === undefined) throw new Error(`no group line for ${id}`);
  return li.querySelector('.dce-group') as HTMLElement;
};
const startGroup = (id: string, name: string): void => {
  fireEvent.click(within(line(id)).getByRole('button', { name: `${name} 채널 다운로드` }));
};
const footerStart = (): HTMLElement => button(/전체 다운로드/);
const startCount = (platform: MockPlatform): number => sentMessages(platform, 'job/start').length;
const chatRowsCount = (): number => document.querySelectorAll('li[data-key]').length;
const writeQueue = (mock: MockPlatform, queue: QueueItem[]): void => {
  mock.write('local', { [LOCAL.queue(ACCOUNT)]: queue });
};

describe('[전체 다운로드]: a big start asks first', () => {
  it('nothing is sent; the question sits above the buttons with the number of chats and every reason', async () => {
    const { platform } = await risk();
    fireEvent.click(footerStart());
    await settle();
    expect(startCount(platform)).toBe(0);
    expect(sentMessages(platform)).toEqual([]);
    const question = screen.getByRole('group', { name: QUESTION(12) });
    expect(question.closest('footer')).not.toBeNull();
    expect(within(question).getByText(QUESTION(12))).toBeTruthy();
    expect(reasonsOf(question)).toEqual([MANY_CHATS, UNBOUNDED, MANY_MESSAGES('26,520'), THREADS]);
    expect(within(question).getByRole('button', { name: '계속 받기' })).toBeTruthy();
    expect(within(question).getByRole('button', { name: '취소' })).toBeTruthy();
  });

  it('[계속 받기] sends the original start: job/start "all", once; the question is gone and the download shows', async () => {
    const { platform } = await risk();
    fireEvent.click(footerStart());
    fireEvent.click(button('계속 받기'));
    await settle();
    await settle();
    expect(sentMessages(platform, 'job/start')).toEqual([{ to: 'bg', type: 'job/start', keys: 'all' }]);
    expect(panels()).toHaveLength(0);
    expect(screen.getAllByRole('progressbar', { name: '전체 진행률' })).toHaveLength(1);
  });

  it('[취소] sends nothing and gives the focus back to the download button', async () => {
    const { platform } = await risk();
    fireEvent.click(footerStart());
    fireEvent.click(button('취소'));
    await settle();
    expect(panels()).toHaveLength(0);
    expect(sentMessages(platform)).toEqual([]);
    expect(document.activeElement).toBe(footerStart());
    expect(chatRowsCount()).toBeGreaterThan(0); // the list is untouched
  });

  it('Escape does the same as [취소]', async () => {
    const { platform } = await risk();
    fireEvent.click(footerStart());
    fireEvent.keyDown(button('계속 받기'), { key: 'Escape' });
    await settle();
    expect(panels()).toHaveLength(0);
    expect(sentMessages(platform)).toEqual([]);
    expect(document.activeElement).toBe(footerStart());
  });

  it('only more than 10 chats is "many chats": the 12 of the tree are a big start, 10 are not', async () => {
    // 12 chats that all stay within the limits: the only reason is the number of chats
    const first = await renderPopup({ scenario: 'tree' });
    fireEvent.click(footerStart());
    expect(reasonsOf(panel())).toEqual([MANY_CHATS]);
    expect(RISK_MAX_CHATS).toBe(10);
    expect(startCount(first.platform)).toBe(0);
    cleanup();

    const second = await renderPopup({
      scenario: 'tree',
      prepare: (platform) => {
        const queue = platform.read('local', LOCAL.queue(ACCOUNT)) as QueueItem[];
        platform.write('local', { [LOCAL.queue(ACCOUNT)]: queue.slice(0, 10) });
      },
    });
    fireEvent.click(footerStart());
    await settle();
    expect(panels()).toHaveLength(0);
    expect(sentMessages(second.platform, 'job/start')).toEqual([{ to: 'bg', type: 'job/start', keys: 'all' }]);
  });

  it('an ordinary list starts at once, without a question', async () => {
    const { platform } = await renderPopup({ scenario: 'idle' });
    fireEvent.click(footerStart());
    await settle();
    expect(panels()).toHaveLength(0);
    expect(sentMessages(platform, 'job/start')).toEqual([{ to: 'bg', type: 'job/start', keys: 'all' }]);
  });

  it('a double click on the button shows one question and starts nothing', async () => {
    const { platform } = await risk();
    fireEvent.click(footerStart());
    fireEvent.click(footerStart());
    await settle();
    expect(panels()).toHaveLength(1);
    expect(startCount(platform)).toBe(0);
  });

  it('[계속 받기] twice (a double click) starts once', async () => {
    const { platform } = await risk();
    fireEvent.click(footerStart());
    const proceed = button('계속 받기');
    fireEvent.click(proceed);
    fireEvent.click(proceed);
    await settle();
    expect(startCount(platform)).toBe(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a refusal of the worker after [계속 받기] is shown inline as usual', async () => {
    const { platform } = await risk({ prepare: (mock) => mock.failNext('job/start', 'busy') });
    fireEvent.click(footerStart());
    fireEvent.click(button('계속 받기'));
    await settle();
    expect(startCount(platform)).toBe(1);
    expect(panels()).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toContain('이미 다운로드가 진행 중이에요');
  });
});

describe('the ▶ of a server line: the chats of that server only', () => {
  it('Sample Server (7 chats, 25,000 messages with threads): the question is on its line, with its own reasons', async () => {
    const { platform } = await risk();
    startGroup(S1, 'Sample Server');
    await settle();
    expect(startCount(platform)).toBe(0);
    const question = panel();
    expect(question.closest('li[data-group-id]')?.getAttribute('data-group-id')).toBe(S1);
    expect(question.closest('footer')).toBeNull();
    expect(question.getAttribute('aria-label')).toBe(QUESTION(7));
    expect(reasonsOf(question)).toEqual([MANY_MESSAGES('26,200'), THREADS]);
  });

  it('[계속 받기] sends job/start with exactly the keys of that server, once', async () => {
    const { platform } = await risk();
    startGroup(S1, 'Sample Server');
    fireEvent.click(button('계속 받기'));
    await settle();
    const sent = sentMessages(platform, 'job/start');
    expect(sent).toHaveLength(1);
    const message = sent[0] as { keys: string[] };
    expect([...message.keys].sort()).toEqual([...SAMPLE_KEYS].sort());
    expect(panels()).toHaveLength(0);
  });

  it('[취소] and Escape send nothing and put the focus back on the ▶ of the line', async () => {
    const { platform } = await risk();
    const play = (): HTMLElement => within(line(S1)).getByRole('button', { name: 'Sample Server 채널 다운로드' });
    startGroup(S1, 'Sample Server');
    fireEvent.click(button('취소'));
    expect(panels()).toHaveLength(0);
    expect(document.activeElement).toBe(play());
    startGroup(S1, 'Sample Server');
    fireEvent.keyDown(button('계속 받기'), { key: 'Escape' });
    expect(panels()).toHaveLength(0);
    expect(document.activeElement).toBe(play());
    expect(sentMessages(platform)).toEqual([]);
  });

  it('a server whose chats are all small starts at once', async () => {
    const { platform } = await risk();
    startGroup(S2, 'Study Group');
    await settle();
    expect(panels()).toHaveLength(0);
    const sent = sentMessages(platform, 'job/start');
    expect(sent).toHaveLength(1);
    expect([...(sent[0] as { keys: string[] }).keys].sort()).toEqual([...STUDY_KEYS].sort());
  });
});

describe('the ▶ of one chat: only "everything, no start date" is a reason', () => {
  it('"Book Club › #reading" reads every message: its row asks, with that one reason and one chat', async () => {
    const { platform } = await risk();
    const reading = row('Book Club › #reading');
    fireEvent.click(within(reading).getByRole('button', { name: 'Book Club > #reading 다운로드' }));
    await settle();
    expect(startCount(platform)).toBe(0);
    const question = within(reading).getByRole('group', { name: QUESTION(1) });
    expect(reasonsOf(question)).toEqual([UNBOUNDED]);
    expect(document.activeElement).toBe(within(question).getByRole('button', { name: '계속 받기' }));
    fireEvent.click(within(question).getByRole('button', { name: '계속 받기' }));
    await settle();
    expect(sentMessages(platform, 'job/start')).toEqual([{ to: 'bg', type: 'job/start', keys: [key(T.reading)] }]);
  });

  it('cancelling puts the focus back on the ▶ of the row', async () => {
    const { platform } = await risk();
    const reading = row('Book Club › #reading');
    const play = within(reading).getByRole('button', { name: 'Book Club > #reading 다운로드' });
    fireEvent.click(play);
    fireEvent.click(within(reading).getByRole('button', { name: '취소' }));
    expect(panels()).toHaveLength(0);
    expect(document.activeElement).toBe(play);
    expect(sentMessages(platform)).toEqual([]);
  });

  it('a chat with 25,000 messages and threads is not a reason by itself: it starts at once', async () => {
    const { platform } = await risk({ expanded: [S1, STUDY] });
    fireEvent.click(within(row('#questions')).getByRole('button', { name: /다운로드$/ }));
    await settle();
    expect(panels()).toHaveLength(0);
    expect(sentMessages(platform, 'job/start')).toEqual([{ to: 'bg', type: 'job/start', keys: [key(T.questions)] }]);
  });

  it('an ordinary chat starts at once', async () => {
    const { platform } = await risk();
    fireEvent.click(within(row('#welcome')).getByRole('button', { name: /다운로드$/ }));
    await settle();
    expect(panels()).toHaveLength(0);
    expect(sentMessages(platform, 'job/start')).toEqual([{ to: 'bg', type: 'job/start', keys: [key(T.welcome)] }]);
  });

  it('[재시도] of a failed chat goes through the same check', async () => {
    const { platform } = await risk({
      prepare: (mock) => {
        const queue = mock.read('local', LOCAL.queue(ACCOUNT)) as QueueItem[];
        writeQueue(mock, queue.map((item) => (item.key === key(T.reading) ? { ...item, lastResult: { status: 'failed' as const, message: '실패', at: 1 } } : item)));
      },
    });
    fireEvent.click(within(row('Book Club › #reading')).getByRole('button', { name: 'Book Club > #reading 다시 시도' }));
    await settle();
    expect(startCount(platform)).toBe(0);
    expect(reasonsOf(panel())).toEqual([UNBOUNDED]);
  });
});

describe('only one question is open at a time', () => {
  it('a second start button takes the question over: the footer one closes when a server line asks', async () => {
    await risk();
    fireEvent.click(footerStart());
    expect(panels()).toHaveLength(1);
    startGroup(S1, 'Sample Server');
    expect(panels()).toHaveLength(1);
    expect(panel().closest('li[data-group-id]')?.getAttribute('data-group-id')).toBe(S1);
    fireEvent.click(footerStart());
    expect(panels()).toHaveLength(1);
    expect(panel().closest('footer')).not.toBeNull();
  });

  it('it also closes the other confirmations ([목록 비우기], ✕ of a server) and they close it', async () => {
    await risk();
    fireEvent.click(footerStart());
    fireEvent.click(button('목록 비우기'));
    expect(panels()).toHaveLength(1);
    expect(panel().getAttribute('aria-label')).toBe('목록을 모두 비울까요?');
    fireEvent.click(footerStart());
    expect(panels()).toHaveLength(1);
    expect(panel().getAttribute('aria-label')).toBe(QUESTION(12));

    startGroup(S1, 'Sample Server');
    fireEvent.click(within(line(S1)).getByRole('button', { name: 'Sample Server 채널 목록에서 빼기' }));
    expect(panels()).toHaveLength(1);
    expect(panel().getAttribute('aria-label')).toBe('채널 7개를 목록에서 뺄까요?');
    startGroup(S1, 'Sample Server');
    expect(panels()).toHaveLength(1);
    expect(panel().getAttribute('aria-label')).toBe(QUESTION(7));
  });
});

describe('the question closes by itself', () => {
  it('when the list changes (a chat is added or taken out, here from Discord)', async () => {
    const { platform } = await risk();
    fireEvent.click(footerStart());
    const queue = platform.read('local', LOCAL.queue(ACCOUNT)) as QueueItem[];
    act(() => writeQueue(platform, queue.slice(1)));
    await settle();
    expect(panels()).toHaveLength(0);
    expect(startCount(platform)).toBe(0);
  });

  it('when the list is written again with the same content, it stays', async () => {
    const { platform } = await risk();
    fireEvent.click(footerStart());
    const queue = platform.read('local', LOCAL.queue(ACCOUNT)) as QueueItem[];
    act(() => writeQueue(platform, queue));
    await settle();
    expect(panels()).toHaveLength(1);
  });

  it('when the settings of a server or the common settings change', async () => {
    const { platform } = await risk();
    fireEvent.click(footerStart());
    act(() => platform.write('local', { [LOCAL.groupSettings(ACCOUNT)]: { [S2]: { ...DEFAULT_EXPORT_SETTINGS, count: 5 } } }));
    await settle();
    expect(panels()).toHaveLength(0);
  });

  it('when a download starts (here from another place)', async () => {
    const { platform } = await risk();
    fireEvent.click(footerStart());
    act(() => platform.write('session', { [SESSION.job]: sampleRunningJob(Date.now()) }));
    await settle();
    await settle();
    expect(panels()).toHaveLength(0);
    expect(screen.getByRole('button', { name: '취소' })).toBeTruthy(); // the footer of a running download
  });

  it('when another screen is opened', async () => {
    await risk();
    fireEvent.click(footerStart());
    fireEvent.click(button('기록'));
    await settle();
    fireEvent.click(button('뒤로'));
    await settle();
    expect(panels()).toHaveLength(0);
    expect(screen.getByRole('button', { name: /전체 다운로드/ })).toBeTruthy();
  });

  it('an unrelated change (the history, another setting) leaves it open', async () => {
    const { platform } = await risk();
    fireEvent.click(footerStart());
    fireEvent.click(screen.getByRole('switch', { name: '디스코드에 버튼 표시' }));
    await settle();
    act(() => platform.write('local', { [LOCAL.history(ACCOUNT)]: [] }));
    await settle();
    expect(panels()).toHaveLength(1);
  });
});

describe('keyboard', () => {
  it('the focus moves to [계속 받기]; Tab leads on to [취소]; both are real buttons (Enter and Space work)', async () => {
    await risk();
    fireEvent.click(footerStart());
    const proceed = button('계속 받기') as HTMLButtonElement;
    const cancel = button('취소') as HTMLButtonElement;
    expect(document.activeElement).toBe(proceed);
    expect(proceed.tagName).toBe('BUTTON');
    expect(proceed.type).toBe('button');
    expect(cancel.tagName).toBe('BUTTON');
    // document order = tab order: [계속 받기] first, then [취소]
    expect(proceed.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(proceed.tabIndex).toBe(0);
    expect(cancel.tabIndex).toBe(0);
  });

  it('the question is a labelled group whose reasons are its description', async () => {
    await risk();
    fireEvent.click(footerStart());
    const question = screen.getByRole('group', { name: QUESTION(12) });
    const describedBy = question.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    const list = document.getElementById(describedBy ?? '');
    expect(list?.tagName).toBe('UL');
    expect(list?.querySelectorAll('li')).toHaveLength(4);
  });

  it('Escape inside the question closes only the question, not the screen behind it', async () => {
    await risk();
    fireEvent.click(footerStart());
    fireEvent.keyDown(button('취소'), { key: 'Escape' });
    expect(panels()).toHaveLength(0);
    expect(screen.getByRole('button', { name: '기록' })).toBeTruthy(); // still the main screen
  });

  it('never window.confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { platform } = await risk();
    fireEvent.click(footerStart());
    expect(confirm).not.toHaveBeenCalled();
    expect(startCount(platform)).toBe(0);
  });
});

describe('English', () => {
  it('the question, the reasons and the buttons in English', async () => {
    const { platform } = await risk({ settings: { language: 'en' } });
    fireEvent.click(button(/Download all/));
    const question = screen.getByRole('group', {
      name: 'You are about to download 12 chats at once. Large downloads make it much more likely that Discord limits your account.',
    });
    expect(reasonsOf(question)).toEqual([
      'Many chats (more than 10)',
      'Some chats download every message, with no period or count limit',
      'A very large number of messages is requested (about 26,520)',
      'Including threads multiplies the number of requests',
    ]);
    expect(document.activeElement).toBe(within(question).getByRole('button', { name: 'Download anyway' }));
    fireEvent.click(within(question).getByRole('button', { name: 'Cancel' }));
    expect(startCount(platform)).toBe(0);
    expect(panels()).toHaveLength(0);
  });

  it('one chat: "1 chat", one reason', async () => {
    const { platform } = await risk({ settings: { language: 'en' } });
    fireEvent.click(within(row('Book Club › #reading')).getByRole('button', { name: 'Download Book Club > #reading' }));
    const question = screen.getByRole('group', { name: 'You are about to download 1 chat at once. Large downloads make it much more likely that Discord limits your account.' });
    expect(reasonsOf(question)).toEqual(['Some chats download every message, with no period or count limit']);
    fireEvent.click(within(question).getByRole('button', { name: 'Download anyway' }));
    await settle();
    expect(sentMessages(platform, 'job/start')).toEqual([{ to: 'bg', type: 'job/start', keys: [key(T.reading)] }]);
  });
});

describe('the download history is never asked about (it is always one chat)', () => {
  it('[다시 받기] starts at once, even for a chat that was saved with every message', async () => {
    const entry: HistoryEntry = {
      id: 'unbounded-1',
      accountId: ACCOUNT,
      target: { ...MOCK_TARGETS.general },
      settings: { ...DEFAULT_EXPORT_SETTINGS, count: null, from: null, content: { ...DEFAULT_EXPORT_SETTINGS.content } },
      finishedAt: Date.now(),
      status: 'done',
      messageCount: 90_000,
      files: [],
      error: null,
    };
    const { platform } = await renderPopup({ prepare: (mock) => mock.write('local', { [LOCAL.history(ACCOUNT)]: [entry] }) });
    fireEvent.click(button('기록'));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Sample Server > #general 다시 받기' }));
    await settle();
    expect(panels()).toHaveLength(0);
    expect(sentMessages(platform, 'history/rerun')).toEqual([{ to: 'bg', type: 'history/rerun', id: 'unbounded-1' }]);
  });
});

describe('the store: requestStart / confirmRisk / dismissRisk', () => {
  const stops: Array<() => void> = [];
  afterEach(() => {
    while (stops.length > 0) stops.pop()?.();
  });
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  async function started(scenario: MockScenario): Promise<{ platform: MockPlatform; store: PopupStore }> {
    const platform = createMockPlatform({ scenario });
    const store = createPopupStore(platform, { pollMs: 600_000 });
    stops.push(store.getState().start());
    await flush();
    return { platform, store };
  }

  it('an ordinary start is sent at once and opens no question', async () => {
    const { platform, store } = await started('idle');
    expect(await store.getState().requestStart('all', 'footer')).toBe(true);
    expect(store.getState().riskPrompt).toBeNull();
    expect(sentMessages(platform, 'job/start')).toEqual([{ to: 'bg', type: 'job/start', keys: 'all' }]);
  });

  it('a big start opens the question with the anchor, the original keys and the assessment, and sends nothing', async () => {
    const { platform, store } = await started('risk');
    expect(await store.getState().requestStart('all', 'footer')).toBe(false);
    expect(store.getState().riskPrompt).toMatchObject({
      anchor: 'footer',
      keys: 'all',
      risk: { risky: true, chats: 12, reasons: ['many-chats', 'unbounded', 'many-messages', 'threads'], messageEstimate: 26_520 },
    });
    expect(sentMessages(platform)).toEqual([]);
  });

  it('keys that are not in the list are judged on what is there (nothing: not risky, the worker answers "empty")', async () => {
    const { platform, store } = await started('risk');
    await store.getState().requestStart(['no-such-key'], 'chat:no-such-key');
    expect(store.getState().riskPrompt).toBeNull();
    expect(sentMessages(platform, 'job/start')).toEqual([{ to: 'bg', type: 'job/start', keys: ['no-such-key'] }]);
  });

  it('confirmRisk closes the question and starts what it was opened for; dismissRisk starts nothing', async () => {
    const { platform, store } = await started('risk');
    const keys = [key(T.reading)];
    await store.getState().requestStart(keys, 'chat:x');
    keys.push('changed-afterwards'); // the question keeps its own copy of the keys
    store.getState().dismissRisk();
    expect(store.getState().riskPrompt).toBeNull();
    expect(await store.getState().confirmRisk()).toBe(false); // nothing is open
    expect(sentMessages(platform)).toEqual([]);

    await store.getState().requestStart([key(T.reading)], 'chat:x');
    expect(await store.getState().confirmRisk()).toBe(true);
    expect(store.getState().riskPrompt).toBeNull();
    expect(sentMessages(platform, 'job/start')).toEqual([{ to: 'bg', type: 'job/start', keys: [key(T.reading)] }]);
  });

  it('the question goes when the list changes or a job is running, not when something unrelated changes', async () => {
    const { platform, store } = await started('risk');
    await store.getState().requestStart('all', 'footer');
    platform.write('local', { [LOCAL.history(ACCOUNT)]: [] });
    await flush();
    expect(store.getState().riskPrompt).not.toBeNull();
    const queue = platform.read('local', LOCAL.queue(ACCOUNT)) as QueueItem[];
    platform.write('local', { [LOCAL.queue(ACCOUNT)]: queue.slice(2) });
    await flush();
    expect(store.getState().riskPrompt).toBeNull();

    await store.getState().requestStart('all', 'footer');
    expect(store.getState().riskPrompt).not.toBeNull();
    platform.write('session', { [SESSION.job]: sampleRunningJob(Date.now()) });
    await flush();
    expect(store.getState().riskPrompt).toBeNull();
  });

  it('a new question replaces the old one', async () => {
    const { store } = await started('risk');
    await store.getState().requestStart('all', 'footer');
    await store.getState().requestStart(SAMPLE_KEYS, 'group:x');
    expect(store.getState().riskPrompt).toMatchObject({ anchor: 'group:x', risk: { chats: 7 } });
  });
});

describe('the stylesheet of the question', () => {
  it('the question and the list of reasons take a whole line each; the reasons are small and muted', () => {
    expect(declOf('.dce-confirm--detailed > .dce-confirm__text', 'flex')).toBe('1 1 100%');
    expect(declOf('.dce-confirm--detailed > .dce-confirm__details', 'flex')).toBe('1 1 100%');
    expect(declOf('.dce-confirm--detailed > .dce-confirm__details', 'min-width')).toBe('0');
    expect(declOf('.dce-confirm__details', 'color')).toBe('var(--dce-text-muted)');
    expect(declOf('.dce-confirm__details', 'margin')).toBe('0');
  });
});
