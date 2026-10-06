// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PopupRoot } from '@/popup/PopupRoot';
import { LOCAL, SESSION, type ErrorKind, type ItemPhase, type ItemProgress, type JobState, type QueueItem } from '@/shared';
import { MOCK_ACCOUNT, MOCK_TARGETS, createMockPlatform } from '@/ui/platform/mock';
import { button, chatRows, renderPopup, row, sentMessages, settle } from './helpers';

afterEach(cleanup); // vitest globals are off, so testing-library cannot register its own cleanup

const GENERAL = 'Sample Server > #general';
const KEYS = { general: MOCK_TARGETS.general.channelId, announcements: MOCK_TARGETS.announcements.channelId, dm: MOCK_TARGETS.dm.channelId, questions: MOCK_TARGETS.questions.channelId, thread: MOCK_TARGETS.thread.channelId };

function progress(key: string, patch: Partial<ItemProgress> = {}): ItemProgress {
  return { key, label: key, status: 'waiting', phase: null, fetched: 0, expected: 200, error: null, files: [], ...patch };
}
/** The id of the job of the 'running' scenario: a job that ENDS is the same job (same id) with a final state. */
const RUNNING_ID = 'mock-job-1';
function job(items: ItemProgress[], patch: Partial<JobState> = {}): JobState {
  return { jobId: RUNNING_ID, accountId: MOCK_ACCOUNT.id, startedAt: Date.now() - 5000, finishedAt: null, state: 'running', pausedReason: null, zip: false, items, ...patch };
}
const writeJob = async (platform: Awaited<ReturnType<typeof renderPopup>>['platform'], next: JobState | null): Promise<void> => {
  await act(async () => {
    platform.write('session', { [SESSION.job]: next });
  });
  await settle();
};

describe('progress of a running download (docs/PLAN.md §7.2)', () => {
  it('the running item has a progress bar, a phase, and "120 / 200개"', async () => {
    await renderPopup({ scenario: 'running' });
    const bar = within(row(GENERAL)).getByRole('progressbar', { name: `${GENERAL} 진행률` });
    expect(bar.getAttribute('aria-valuenow')).toBe('60');
    expect(bar.getAttribute('aria-valuetext')).toBe('120 / 200개');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('60%');
    expect(within(row(GENERAL)).getByText('메시지 가져오는 중')).toBeTruthy();
    expect(within(row(GENERAL)).getByText('120 / 200개')).toBeTruthy();
  });

  it('waiting items say "대기 중" without a bar; chats that are not part of the job show nothing', async () => {
    await renderPopup({ scenario: 'running' });
    expect(within(row('Alex')).getByText('대기 중')).toBeTruthy();
    expect(within(row('Alex')).queryByRole('progressbar')).toBeNull();
    expect(row('Study Group › #questions').querySelector('.dce-row__progress')).toBeNull();
  });

  it('shows every phase in words', async () => {
    const { platform } = await renderPopup({ scenario: 'running' });
    const phases: Array<[ItemPhase, string]> = [
      ['resolving', '채팅 정보 확인 중'],
      ['messages', '메시지 가져오는 중'],
      ['threads', '스레드 찾는 중'],
      ['attachments', '첨부파일 받는 중'],
      ['writing', '파일 만드는 중'],
      ['saving', '저장하는 중'],
    ];
    for (const [phase, text] of phases) {
      await writeJob(platform, job([progress(KEYS.general, { status: 'running', phase, fetched: 10 })]));
      expect(within(row(GENERAL)).getByText(text), phase).toBeTruthy();
    }
  });

  it('a running item without a phase just says "진행 중"', async () => {
    const { platform } = await renderPopup({ scenario: 'running' });
    await writeJob(platform, job([progress(KEYS.general, { status: 'running', phase: null, fetched: 10 })]));
    expect(within(row(GENERAL)).getByText('진행 중')).toBeTruthy();
  });

  it('an unknown total (no limit) is an animated bar without a value, and the count of messages so far', async () => {
    const { platform } = await renderPopup({ scenario: 'running' });
    await writeJob(platform, job([progress(KEYS.general, { status: 'running', phase: 'messages', fetched: 7, expected: null })]));
    const bar = within(row(GENERAL)).getByRole('progressbar');
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    expect(bar.hasAttribute('data-indeterminate')).toBe(true);
    expect(within(row(GENERAL)).getByText('7개')).toBeTruthy();
  });

  it('follows the job while it runs: new numbers replace the old ones', async () => {
    const { platform } = await renderPopup({ scenario: 'running' });
    await writeJob(platform, job([progress(KEYS.general, { status: 'running', phase: 'messages', fetched: 160, expected: 200 })]));
    expect(within(row(GENERAL)).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('80');
    expect(within(row(GENERAL)).getByText('160 / 200개')).toBeTruthy();
  });

  it('a paused item (rate limit) says so, in the warning colour', async () => {
    const { platform } = await renderPopup({ scenario: 'running' });
    await writeJob(platform, job([progress(KEYS.general, { status: 'paused', phase: 'messages', fetched: 50 })], { state: 'paused', pausedReason: 'rate-limit' }));
    expect(within(row(GENERAL)).getByText('잠시 멈춤')).toBeTruthy();
    expect(within(row(GENERAL)).getByRole('progressbar').className).toContain('dce-progress--warning');
    expect(screen.getByText('디스코드 요청 제한 때문에 잠시 쉬고 있어요. 곧 이어서 받아요.')).toBeTruthy();
    expect(button('취소')).toBeTruthy(); // a paused job can still be cancelled
  });

  it('English', async () => {
    await renderPopup({ scenario: 'running', settings: { language: 'en' } });
    expect(within(row(GENERAL)).getByText('Fetching messages')).toBeTruthy();
    expect(within(row(GENERAL)).getByText('120 / 200')).toBeTruthy();
    expect(within(row('Alex')).getByText('Waiting')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Overall progress' })).toBeTruthy();
    expect(button('Cancel')).toBeTruthy();
  });
});

describe('the overall progress and [취소] replace the download button', () => {
  it('shows finished/total and the percentage, counting a running item with its own fraction', async () => {
    await renderPopup({ scenario: 'running' });
    // 4 items: 1 done + 120/200 of the running one = 1.6 of 4
    expect(screen.getByText('1/4 · 40%')).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: '전체 진행률' });
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
    expect(bar.getAttribute('aria-valuetext')).toBe('1/4 · 40%');
    expect(screen.queryByRole('button', { name: /전체 다운로드/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '목록 비우기' })).toBeNull();
  });

  it('every kind of finished item counts as finished', async () => {
    const { platform } = await renderPopup({ scenario: 'running' });
    await writeJob(
      platform,
      job([
        progress('a', { status: 'done' }),
        progress('b', { status: 'partial' }),
        progress('c', { status: 'failed' }),
        progress('d', { status: 'cancelled' }),
        progress('e', { status: 'waiting' }),
      ]),
    );
    expect(screen.getByText('4/5 · 80%')).toBeTruthy();
  });

  it('[취소] sends job/cancel and turns into "취소하는 중…" (off) until the job has stopped', async () => {
    const platform = createMockPlatform({ scenario: 'running' });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = platform.sendMessage.bind(platform);
    const cancels: unknown[] = [];
    platform.sendMessage = (async (message) => {
      if (message.type === 'job/cancel') {
        cancels.push(message);
        await gate;
      }
      return send(message);
    }) as typeof platform.sendMessage;
    render(<PopupRoot platform={platform} pollMs={600_000} />);
    await settle();
    await settle();
    fireEvent.click(button('취소'));
    await settle();
    expect(cancels).toEqual([{ to: 'bg', type: 'job/cancel' }]);
    const cancelling = button('취소하는 중…') as HTMLButtonElement;
    expect(cancelling.disabled).toBe(true);
    fireEvent.click(cancelling);
    expect(cancels).toHaveLength(1); // not twice
    await act(async () => {
      release();
      await gate;
    });
    await settle();
    await settle();
    // the job is over: the download button is back and the chats that were stopped can be retried
    expect(screen.getByRole('button', { name: /전체 다운로드/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /취소하는 중/ })).toBeNull();
  });

  it('after a cancel the unfinished chats stay in the list as "취소됨", each with [재시도]', async () => {
    await renderPopup({ scenario: 'running' });
    fireEvent.click(button('취소'));
    await settle();
    await settle();
    const failure = row(GENERAL).querySelector('.dce-row__failure') as HTMLElement;
    expect(failure.textContent).toContain('취소됨');
    expect(failure.textContent).toContain('취소했어요.');
    expect(within(failure).getByRole('button', { name: `${GENERAL} 다시 시도` })).toBeTruthy();
    expect(row('Alex').querySelector('.dce-row__failure')).not.toBeNull();
  });
});

describe('a download that ended while the popup was open', () => {
  it('everything went well: "다운로드를 마쳤어요" with [폴더 열기]', async () => {
    const { platform } = await renderPopup({ scenario: 'running' });
    await writeJob(platform, job([progress(KEYS.general, { status: 'done' }), progress(KEYS.dm, { status: 'done' })], { state: 'done', finishedAt: Date.now() }));
    const strip = document.querySelector('.dce-finished') as HTMLElement;
    expect(strip.textContent).toContain('다운로드를 마쳤어요');
    fireEvent.click(within(strip).getByRole('button', { name: '폴더 열기' }));
    await settle();
    expect(sentMessages(platform, 'downloads/show')).toEqual([{ to: 'bg', type: 'downloads/show', downloadId: null }]);
  });

  it('some chats did not finish: says how many', async () => {
    const { platform } = await renderPopup({ scenario: 'running' });
    await writeJob(
      platform,
      job([progress('a', { status: 'done' }), progress('b', { status: 'done' }), progress('c', { status: 'failed' }), progress('d', { status: 'partial' })], { state: 'done', finishedAt: Date.now() }),
    );
    expect(document.querySelector('.dce-finished')?.textContent).toContain('2개 완료, 2개는 끝내지 못했어요');
  });

  it('cancelled and failed jobs have their own words (and no folder button when nothing was saved)', async () => {
    const { platform } = await renderPopup({ scenario: 'running' });
    await writeJob(platform, job([progress('a', { status: 'cancelled' })], { state: 'cancelled', finishedAt: Date.now() }));
    expect(document.querySelector('.dce-finished')?.textContent).toContain('다운로드를 취소했어요');
    expect(within(document.querySelector('.dce-finished') as HTMLElement).queryByRole('button', { name: '폴더 열기' })).toBeNull();
    cleanup();
    const second = await renderPopup({ scenario: 'running' });
    await writeJob(second.platform, job([progress('a', { status: 'failed' })], { state: 'failed', finishedAt: Date.now() }));
    expect(document.querySelector('.dce-finished')?.textContent).toContain('다운로드하지 못했어요');
  });

  it('can be dismissed', async () => {
    const { platform } = await renderPopup({ scenario: 'running' });
    await writeJob(platform, job([progress('a', { status: 'done' })], { state: 'done', finishedAt: Date.now() }));
    fireEvent.click(within(document.querySelector('.dce-finished') as HTMLElement).getByRole('button', { name: '알림 닫기' }));
    expect(document.querySelector('.dce-finished')).toBeNull();
  });

  it('is gone when the next download starts', async () => {
    const { platform } = await renderPopup({ scenario: 'running' });
    await writeJob(platform, job([progress('a', { status: 'done' })], { state: 'done', finishedAt: Date.now() }));
    expect(document.querySelector('.dce-finished')).not.toBeNull();
    fireEvent.click(button(/전체 다운로드/));
    await settle();
    await settle();
    expect(document.querySelector('.dce-finished')).toBeNull();
  });

  it('is not shown for a job that was already over when the popup opened', async () => {
    await renderPopup({
      scenario: 'idle',
      prepare: (platform) => platform.write('session', { [SESSION.job]: job([progress(KEYS.general, { status: 'done' })], { state: 'done', finishedAt: Date.now() }) }),
    });
    expect(document.querySelector('.dce-finished')).toBeNull();
  });

  it('in English', async () => {
    const { platform } = await renderPopup({ scenario: 'running', settings: { language: 'en' } });
    await writeJob(platform, job([progress('a', { status: 'done' }), progress('b', { status: 'failed' })], { state: 'done', finishedAt: Date.now() }));
    expect(document.querySelector('.dce-finished')?.textContent).toContain('1 done, 1 not finished');
    expect(screen.getByRole('button', { name: 'Open folder' })).toBeTruthy();
  });
});

describe('failed, partial and cancelled chats stay in the list with the reason and [재시도] (docs/PLAN.md §6.7)', () => {
  it('a chat whose last attempt failed: the reason the engine gave', async () => {
    await renderPopup();
    const failure = row('Study Group › #questions').querySelector('.dce-row__failure') as HTMLElement;
    expect(failure.textContent).toBe('실패 · 이 채널을 볼 권한이 없어요.재시도');
    expect(within(failure).getByRole('button', { name: 'Study Group > #questions 다시 시도' })).toBeTruthy();
    expect(failure.getAttribute('data-failure')).toBe('failed');
  });

  it('partial and cancelled, with and without a message', async () => {
    const { platform } = await renderPopup({ scenario: 'empty' });
    const items: QueueItem[] = [
      { key: '1', target: { ...MOCK_TARGETS.dm, channelId: '1', channelName: 'One' }, settings: null, addedAt: 1, lastResult: { status: 'partial', message: 'Stopped by a rate limit', at: 1 } },
      { key: '2', target: { ...MOCK_TARGETS.dm, channelId: '2', channelName: 'Two' }, settings: null, addedAt: 2, lastResult: { status: 'cancelled', message: '', at: 1 } },
      { key: '3', target: { ...MOCK_TARGETS.dm, channelId: '3', channelName: 'Three' }, settings: null, addedAt: 3, lastResult: { status: 'failed', message: '   ', at: 1 } },
      { key: '4', target: { ...MOCK_TARGETS.dm, channelId: '4', channelName: 'Four' }, settings: null, addedAt: 4, lastResult: { status: 'partial', message: '', at: 1 } },
    ];
    await act(async () => {
      platform.write('local', { [LOCAL.queue(MOCK_ACCOUNT.id)]: items });
    });
    await settle();
    expect(row('One').querySelector('.dce-row__failure')?.textContent).toContain('일부만 저장됨 · Stopped by a rate limit');
    expect(row('Two').querySelector('.dce-row__failure')?.textContent).toContain('취소됨 · 취소했어요.');
    expect(row('Three').querySelector('.dce-row__failure')?.textContent).toContain('실패 · 다운로드하지 못했어요.');
    expect(row('Four').querySelector('.dce-row__failure')?.textContent).toContain('일부만 저장됨 · 일부만 저장했어요.');
  });

  it('a row that failed in the job just ended: the error kind in words when the engine gave no text', async () => {
    const { platform } = await renderPopup({ scenario: 'empty' });
    const kinds: Array<[ErrorKind, string]> = [
      ['auth', '디스코드 로그인 정보가 만료됐어요. 디스코드 탭을 새로고침해 주세요.'],
      ['forbidden', '이 채팅을 볼 권한이 없어요.'],
      ['not-found', '채팅을 찾을 수 없어요. 삭제됐을 수 있어요.'],
      ['rate-limited', '디스코드가 요청을 제한했어요. 잠시 뒤에 다시 시도해 주세요.'],
      ['blocked', '디스코드가 요청을 막았어요. 잠시 뒤에 다시 시도해 주세요.'],
      ['network', '네트워크에 연결하지 못했어요.'],
      ['server', '디스코드 서버에 문제가 있어요.'],
      ['cancelled', '취소했어요.'],
      ['interrupted', '중간에 끊겼어요. 다시 시도해 주세요.'],
      ['unknown', '알 수 없는 오류가 났어요.'],
    ];
    await act(async () => {
      platform.write('local', { [LOCAL.queue(MOCK_ACCOUNT.id)]: [{ key: 'k', target: { ...MOCK_TARGETS.dm, channelId: 'k', channelName: 'Kind' }, settings: null, addedAt: 1 }] });
    });
    for (const [kind, text] of kinds) {
      await writeJob(platform, job([progress('k', { status: 'failed', error: { kind, message: '' } })], { state: 'done', finishedAt: Date.now() }));
      expect(row('Kind').querySelector('.dce-row__failure')?.textContent, kind).toContain(text);
    }
  });

  it('the engine\'s own sentence wins over the kind', async () => {
    const { platform } = await renderPopup({ scenario: 'empty' });
    await act(async () => {
      platform.write('local', { [LOCAL.queue(MOCK_ACCOUNT.id)]: [{ key: 'k', target: { ...MOCK_TARGETS.dm, channelId: 'k', channelName: 'Kind' }, settings: null, addedAt: 1 }] });
    });
    await writeJob(platform, job([progress('k', { status: 'partial', error: { kind: 'rate-limited', message: 'Saved 120 of 200 messages' } })], { state: 'done', finishedAt: Date.now() }));
    expect(row('Kind').querySelector('.dce-row__failure')?.textContent).toContain('일부만 저장됨 · Saved 120 of 200 messages');
  });

  it('while a job runs, a chat that is not part of it keeps its failure note, with [재시도] off', async () => {
    await renderPopup({
      scenario: 'idle',
      prepare: (platform) => platform.write('session', { [SESSION.job]: job([progress(KEYS.general, { status: 'running', phase: 'messages', fetched: 1 })]) }),
    });
    const failure = row('Study Group › #questions').querySelector('.dce-row__failure') as HTMLElement;
    expect(failure.textContent).toContain('실패 · 이 채널을 볼 권한이 없어요.');
    const retry = within(failure).getByRole('button', { name: 'Study Group > #questions 다시 시도' });
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    expect(retry.getAttribute('title')).toBe('다운로드가 진행 중이에요');
  });

  it('a chat that is part of the running job shows its progress, not its old failure note', async () => {
    await renderPopup({
      scenario: 'idle',
      prepare: (platform) => platform.write('session', { [SESSION.job]: job([progress(KEYS.questions, { status: 'running', phase: 'messages', fetched: 5, expected: 10 })]) }),
    });
    expect(row('Study Group › #questions').querySelector('.dce-row__failure')).toBeNull();
    expect(within(row('Study Group › #questions')).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
  });
});

describe('chats of a running job that are not in the list (a history entry downloaded again)', () => {
  it('get a row of their own with progress and no actions', async () => {
    const { platform } = await renderPopup({ scenario: 'idle' });
    await writeJob(platform, job([progress('not-in-list', { label: 'Elsewhere > #old', status: 'running', phase: 'writing', fetched: 100, expected: 100 })]));
    const jobRow = document.querySelector('li.dce-row--job') as HTMLElement;
    expect(jobRow.querySelector('.dce-row__label')?.textContent).toBe('Elsewhere > #old');
    expect(within(jobRow).getByText('파일 만드는 중')).toBeTruthy();
    expect(within(jobRow).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    expect(within(jobRow).queryByRole('button')).toBeNull();
  });

  it('finished ones get none (they are in the history), and a chat that is in the list is one ordinary row', async () => {
    const { platform } = await renderPopup({ scenario: 'idle' });
    await writeJob(
      platform,
      job([progress('not-in-list', { label: 'Elsewhere > #old', status: 'done' }), progress(KEYS.dm, { label: 'Alex', status: 'running', phase: 'messages', fetched: 30, expected: 100 })]),
    );
    expect(document.querySelector('li.dce-row--job')).toBeNull();
    expect(chatRows().filter((li) => li.querySelector('.dce-row__label')?.textContent === 'Alex')).toHaveLength(1);
    expect(within(row('Alex')).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('30');
  });

  it('a download started from the history shows up on the main screen', async () => {
    const { platform } = await renderPopup({ scenario: 'empty' });
    fireEvent.click(button('기록'));
    fireEvent.click(screen.getAllByRole('button', { name: /다시 받기$/ })[0]);
    await settle();
    await settle();
    expect(sentMessages(platform, 'history/rerun')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '기록' })).toBeTruthy(); // back on the main screen
    expect(document.querySelector('li.dce-row--job')).not.toBeNull();
    expect(screen.getByRole('progressbar', { name: '전체 진행률' })).toBeTruthy();
  });
});
