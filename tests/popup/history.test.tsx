// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXPORT_SETTINGS, LOCAL, SESSION, type HistoryEntry, type JobState } from '@/shared';
import { MOCK_ACCOUNT, MOCK_TARGETS } from '@/ui/platform/mock';
import { button, renderPopup, sentMessages, settle } from './helpers';

afterEach(() => {
  cleanup(); // vitest globals are off, so testing-library cannot register its own cleanup
  vi.restoreAllMocks();
});

const openHistory = async (): Promise<void> => {
  fireEvent.click(button('기록'));
  await settle();
};
const entryRow = (label: string): HTMLElement => {
  const li = screen.getByText(label, { selector: '.dce-history__label' }).closest('li');
  if (li === null) throw new Error(`no history row for ${label}`);
  return li;
};
const GENERAL = 'Sample Server > #general';

function entry(id: string, patch: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    accountId: MOCK_ACCOUNT.id,
    target: { ...MOCK_TARGETS.general },
    settings: { ...DEFAULT_EXPORT_SETTINGS, content: { ...DEFAULT_EXPORT_SETTINGS.content } },
    finishedAt: Date.UTC(2026, 9, 6, 6, 4, 0),
    status: 'done',
    messageCount: 10,
    files: [{ filename: `Discord Export/${id}.html`, downloadId: 1 }],
    error: null,
    ...patch,
  };
}

describe('the download history (docs/PLAN.md §2 #16)', () => {
  it('opens as a screen of its own, newest first, with the name, time, number of messages and status of each entry', async () => {
    await renderPopup();
    await openHistory();
    expect(screen.getByRole('heading', { level: 1, name: '다운로드 기록' })).toBeTruthy();
    const labels = Array.from(document.querySelectorAll('.dce-history__label')).map((element) => element.textContent);
    expect(labels).toEqual([GENERAL, 'Alex', 'Study Group > #questions']);
    expect(screen.getByRole('list', { name: '다운로드 기록 목록' }).querySelectorAll('li')).toHaveLength(3);
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: '다운로드 기록' }));

    const general = entryRow(GENERAL);
    expect(within(general).getByText('완료')).toBeTruthy();
    expect(within(general).getByText('메시지 200개')).toBeTruthy();
    expect(general.querySelector('time')?.textContent).not.toBe('');
    const alex = entryRow('Alex');
    expect(within(alex).getByText('일부 저장')).toBeTruthy();
    expect(within(alex).getByText('메시지 1,284개')).toBeTruthy();
    const questions = entryRow('Study Group > #questions');
    expect(within(questions).getByText('실패')).toBeTruthy();
    expect(within(questions).getByText('메시지 0개')).toBeTruthy();
  });

  it('sorts by the time it finished, whatever order it is stored in', async () => {
    const { platform } = await renderPopup();
    await act(async () => {
      platform.write('local', {
        [LOCAL.history(MOCK_ACCOUNT.id)]: [
          entry('old', { finishedAt: 1_000, target: { ...MOCK_TARGETS.dm, channelName: 'Oldest' } }),
          entry('new', { finishedAt: 3_000, target: { ...MOCK_TARGETS.dm, channelName: 'Newest' } }),
          entry('mid', { finishedAt: 2_000, target: { ...MOCK_TARGETS.dm, channelName: 'Middle' } }),
        ],
      });
    });
    await openHistory();
    expect(Array.from(document.querySelectorAll('.dce-history__label')).map((element) => element.textContent)).toEqual(['Newest', 'Middle', 'Oldest']);
  });

  it('shows the time in the language and the time zone of the settings', async () => {
    const { platform } = await renderPopup({ settings: { timeZone: 'UTC' } });
    await act(async () => {
      platform.write('local', { [LOCAL.history(MOCK_ACCOUNT.id)]: [entry('a')] });
    });
    await openHistory();
    const time = document.querySelector('time') as HTMLElement;
    expect(time.getAttribute('datetime')).toBe('2026-10-06T06:04:00.000Z');
    expect(time.textContent).toContain('2026. 10. 6.');
    expect(time.textContent).toContain('6:04');
    expect(time.textContent).toContain('오전');
    cleanup();

    const korea = await renderPopup({ settings: { timeZone: 'Asia/Seoul' } });
    await act(async () => {
      korea.platform.write('local', { [LOCAL.history(MOCK_ACCOUNT.id)]: [entry('a')] });
    });
    await openHistory();
    expect((document.querySelector('time') as HTMLElement).textContent).toContain('3:04'); // 06:04 UTC = 15:04 KST
    expect((document.querySelector('time') as HTMLElement).textContent).toContain('오후');
  });

  it('shows what settings the file was saved with, and what went wrong', async () => {
    await renderPopup();
    await openHistory();
    expect(entryRow(GENERAL).querySelector('.dce-history__summary')?.textContent).toBe('200개 · HTML · 기간 없음');
    expect(entryRow('Alex').querySelector('.dce-history__summary')?.textContent).toBe('200개 · MD · 기간 없음');
    expect(entryRow('Study Group > #questions').querySelector('.dce-history__summary')?.textContent).toBe('200개 · JSON · 기간 없음 · 스레드');
    expect(entryRow(GENERAL).querySelector('.dce-history__error')).toBeNull();
    expect(entryRow('Alex').querySelector('.dce-history__error')?.textContent).toBe('Discord가 요청을 제한해서 일부만 저장했어요.');
    expect(entryRow('Study Group > #questions').querySelector('.dce-history__error')?.textContent).toBe('이 채널을 볼 권한이 없어요.');
  });

  it('an empty history says so, and there is nothing to clear', async () => {
    await renderPopup({ prepare: (platform) => platform.write('local', { [LOCAL.history(MOCK_ACCOUNT.id)]: [] }) });
    await openHistory();
    expect(screen.getByText('아직 받은 기록이 없어요.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: '다운로드 기록 목록' })).toBeNull();
    expect((button('기록 지우기') as HTMLButtonElement).disabled).toBe(true);
  });

  it('follows the history while it is open: a finished download appears at the top', async () => {
    const { platform } = await renderPopup();
    await openHistory();
    await act(async () => {
      platform.write('local', {
        [LOCAL.history(MOCK_ACCOUNT.id)]: [entry('fresh', { finishedAt: Date.now(), target: { ...MOCK_TARGETS.dm, channelName: 'Fresh' } }), ...(platform.read('local', LOCAL.history(MOCK_ACCOUNT.id)) as HistoryEntry[])],
      });
    });
    await settle();
    expect(document.querySelector('.dce-history__label')?.textContent).toBe('Fresh');
  });

  it('the back arrow and Escape return to the list, the focus is on [기록] again', async () => {
    await renderPopup();
    await openHistory();
    fireEvent.click(button('뒤로'));
    await settle();
    expect(document.activeElement).toBe(button('기록'));
    await openHistory();
    fireEvent.keyDown(document, { key: 'Escape' });
    await settle();
    expect(screen.getByRole('button', { name: '설정' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: '다운로드 기록' })).toBeNull();
  });
});

describe('[폴더 열기]: downloads/show with the first file\'s downloadId', () => {
  it('sends that id', async () => {
    const { platform } = await renderPopup();
    await openHistory();
    fireEvent.click(within(entryRow(GENERAL)).getByRole('button', { name: `${GENERAL} 폴더 열기` }));
    await settle();
    fireEvent.click(within(entryRow('Alex')).getByRole('button', { name: 'Alex 폴더 열기' }));
    await settle();
    expect(sentMessages(platform, 'downloads/show')).toEqual([
      { to: 'bg', type: 'downloads/show', downloadId: 11 },
      { to: 'bg', type: 'downloads/show', downloadId: 12 },
    ]);
  });

  it('with several files it is the first one; an unknown id (null) opens the default download folder', async () => {
    const { platform } = await renderPopup();
    await act(async () => {
      platform.write('local', {
        [LOCAL.history(MOCK_ACCOUNT.id)]: [
          entry('two', { target: { ...MOCK_TARGETS.dm, channelName: 'Two' }, files: [{ filename: 'a.html', downloadId: 5 }, { filename: 'b.html', downloadId: 6 }] }),
          entry('none', { target: { ...MOCK_TARGETS.dm, channelName: 'None', channelId: '9' }, files: [{ filename: 'a.html', downloadId: null }, { filename: 'b.html', downloadId: 7 }], finishedAt: 1 }),
        ],
      });
    });
    await openHistory();
    fireEvent.click(within(entryRow('Two')).getByRole('button', { name: 'Two 폴더 열기' }));
    fireEvent.click(within(entryRow('None')).getByRole('button', { name: 'None 폴더 열기' }));
    await settle();
    expect(sentMessages(platform, 'downloads/show')).toEqual([
      { to: 'bg', type: 'downloads/show', downloadId: 5 },
      { to: 'bg', type: 'downloads/show', downloadId: null },
    ]);
  });

  it('an entry without a file has no folder button (nothing was saved)', async () => {
    await renderPopup();
    await openHistory();
    expect(within(entryRow('Study Group > #questions')).queryByRole('button', { name: /폴더 열기/ })).toBeNull();
    expect(within(entryRow('Study Group > #questions')).getByRole('button', { name: /다시 받기/ })).toBeTruthy();
  });
});

describe('[다시 받기]: history/rerun', () => {
  it('sends the id of the entry and goes back to the list, where the download shows its progress', async () => {
    const { platform } = await renderPopup();
    await openHistory();
    fireEvent.click(within(entryRow('Alex')).getByRole('button', { name: 'Alex 다시 받기' }));
    await settle();
    await settle();
    expect(sentMessages(platform, 'history/rerun')).toEqual([{ to: 'bg', type: 'history/rerun', id: 'history-2' }]);
    expect(screen.queryByRole('heading', { level: 1, name: '다운로드 기록' })).toBeNull();
    expect(screen.getByRole('progressbar', { name: '전체 진행률' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '취소' })).toBeTruthy();
  });

  it('a refusal (a download is already running) stays on the history with the reason', async () => {
    const running: JobState = {
      jobId: 'j',
      accountId: MOCK_ACCOUNT.id,
      startedAt: 1,
      finishedAt: null,
      state: 'running',
      pausedReason: null,
      zip: false,
      items: [{ key: 'x', label: 'x', status: 'running', phase: 'messages', fetched: 1, expected: 2, error: null, files: [] }],
    };
    const { platform } = await renderPopup({ prepare: (mock) => mock.write('session', { [SESSION.job]: running }) });
    await openHistory();
    fireEvent.click(within(entryRow(GENERAL)).getByRole('button', { name: `${GENERAL} 다시 받기` }));
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: '다운로드 기록' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('이미 다운로드가 진행 중이에요');
    expect(sentMessages(platform, 'history/rerun')).toHaveLength(1);
  });

  it('a double click starts once', async () => {
    const { platform } = await renderPopup();
    await openHistory();
    const rerun = within(entryRow(GENERAL)).getByRole('button', { name: `${GENERAL} 다시 받기` });
    fireEvent.click(rerun);
    fireEvent.click(rerun);
    await settle();
    expect(sentMessages(platform, 'history/rerun')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('[기록 지우기]: history/clear, after asking', () => {
  it('asks first (inline, not window.confirm); nothing is sent until the user confirms', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { platform } = await renderPopup();
    await openHistory();
    fireEvent.click(button('기록 지우기'));
    const question = screen.getByRole('group', { name: '기록을 모두 지울까요?' });
    expect(within(question).getByRole('button', { name: '지우기' })).toBeTruthy();
    expect(document.activeElement).toBe(within(question).getByRole('button', { name: '취소' }));
    expect(sentMessages(platform)).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('[지우기] sends history/clear and the list is empty', async () => {
    const { platform } = await renderPopup();
    await openHistory();
    fireEvent.click(button('기록 지우기'));
    fireEvent.click(button('지우기'));
    await settle();
    expect(sentMessages(platform, 'history/clear')).toEqual([{ to: 'bg', type: 'history/clear' }]);
    expect(screen.getByText('아직 받은 기록이 없어요.')).toBeTruthy();
    expect(platform.read('local', LOCAL.history(MOCK_ACCOUNT.id))).toEqual([]);
    expect(screen.queryByRole('group', { name: '기록을 모두 지울까요?' })).toBeNull();
  });

  it('[취소] and Escape close only the question, not the history', async () => {
    const { platform } = await renderPopup();
    await openHistory();
    fireEvent.click(button('기록 지우기'));
    fireEvent.click(button('취소'));
    expect(screen.queryByRole('group', { name: '기록을 모두 지울까요?' })).toBeNull();
    fireEvent.click(button('기록 지우기'));
    fireEvent.keyDown(within(screen.getByRole('group', { name: '기록을 모두 지울까요?' })).getByRole('button', { name: '취소' }), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: '기록을 모두 지울까요?' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: '다운로드 기록' })).toBeTruthy(); // still on the history
    expect(sentMessages(platform)).toEqual([]);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
});

describe('English', () => {
  it('the same screen in English', async () => {
    const { platform } = await renderPopup({ settings: { language: 'en', timeZone: 'UTC' } });
    await act(async () => {
      platform.write('local', { [LOCAL.history(MOCK_ACCOUNT.id)]: [entry('a', { messageCount: 1 })] });
    });
    fireEvent.click(button('History'));
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: 'Download history' })).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('1 message')).toBeTruthy();
    expect((document.querySelector('time') as HTMLElement).textContent?.replace(/\s/g, ' ')).toBe('Oct 6, 2026, 6:04 AM');
    expect(screen.getByRole('button', { name: `Open the folder of ${GENERAL}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `Download ${GENERAL} again` })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear history' }));
    expect(screen.getByRole('group', { name: 'Clear the whole history?' })).toBeTruthy();
  });

  it('an empty history in English', async () => {
    await renderPopup({ settings: { language: 'en' }, prepare: (platform) => platform.write('local', { [LOCAL.history(MOCK_ACCOUNT.id)]: [] }) });
    fireEvent.click(button('History'));
    await settle();
    expect(screen.getByText('Nothing has been downloaded yet.')).toBeTruthy();
  });
});
