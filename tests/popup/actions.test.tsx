// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL, SESSION, type BgError, type JobState, type QueueItem } from '@/shared';
import { MOCK_ACCOUNT, MOCK_TARGETS } from '@/ui/platform/mock';
import { button, chatRows, renderPopup, row, sentMessages, settle, storedQueue } from './helpers';

afterEach(() => {
  cleanup(); // vitest globals are off, so testing-library cannot register its own cleanup
  vi.restoreAllMocks();
});

const KEYS = { general: MOCK_TARGETS.general.channelId, announcements: MOCK_TARGETS.announcements.channelId, dm: MOCK_TARGETS.dm.channelId, questions: MOCK_TARGETS.questions.channelId };

describe('every action sends the right message (docs/PLAN.md §5.3)', () => {
  it('▶ of a row: job/start with that row\'s key only', async () => {
    const { platform } = await renderPopup();
    fireEvent.click(within(row('Alex')).getByRole('button', { name: 'Alex 다운로드' }));
    await settle();
    expect(sentMessages(platform, 'job/start')).toEqual([{ to: 'bg', type: 'job/start', keys: [KEYS.dm] }]);
  });

  it('the main part of the footer button: job/start "all"', async () => {
    const { platform } = await renderPopup();
    fireEvent.click(button(/전체 다운로드/));
    await settle();
    expect(sentMessages(platform, 'job/start')).toEqual([{ to: 'bg', type: 'job/start', keys: 'all' }]);
  });

  it('✕ of a row: queue/remove with that row\'s key, and the row goes', async () => {
    const { platform } = await renderPopup();
    fireEvent.click(within(row('Alex')).getByRole('button', { name: 'Alex 목록에서 빼기' }));
    await settle();
    expect(sentMessages(platform, 'queue/remove')).toEqual([{ to: 'bg', type: 'queue/remove', key: KEYS.dm }]);
    expect(() => row('Alex')).toThrow();
    expect((storedQueue(platform) as QueueItem[]).map((item) => item.key)).not.toContain(KEYS.dm);
    expect(chatRows()).toHaveLength(4);
  });

  it('[재시도] of a failed row: job/start with that row\'s key', async () => {
    const { platform } = await renderPopup();
    fireEvent.click(within(row('Study Group › #questions')).getByRole('button', { name: 'Study Group > #questions 다시 시도' }));
    await settle();
    expect(sentMessages(platform, 'job/start')).toEqual([{ to: 'bg', type: 'job/start', keys: [KEYS.questions] }]);
  });

  it('a started download shows up at once: the job is read back and the rows show progress', async () => {
    await renderPopup();
    fireEvent.click(button(/전체 다운로드/));
    await settle();
    await settle();
    expect(screen.getAllByRole('progressbar', { name: '전체 진행률' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: '취소' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /전체 다운로드/ })).toBeNull();
  });

  it('a double click on a start button starts once: no "busy" error for the second click', async () => {
    const { platform } = await renderPopup();
    const start = within(row('Alex')).getByRole('button', { name: 'Alex 다운로드' });
    fireEvent.click(start);
    fireEvent.click(start);
    await settle();
    expect(sentMessages(platform, 'job/start')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the caret of the footer button opens the common settings (no message, it is only a screen)', async () => {
    const { platform } = await renderPopup();
    fireEvent.click(button('공통 설정 열기'));
    await settle();
    expect(sentMessages(platform)).toEqual([]);
    expect(screen.getByRole('heading', { level: 1, name: '공통 설정' })).toBeTruthy();
  });

  it('[취소] of a running download: job/cancel', async () => {
    const { platform } = await renderPopup({ scenario: 'running' });
    fireEvent.click(button('취소'));
    await settle();
    expect(sentMessages(platform, 'job/cancel')).toEqual([{ to: 'bg', type: 'job/cancel' }]);
  });
});

describe('[목록 비우기]: an inline confirmation, never window.confirm', () => {
  it('asks first; nothing is sent until the user confirms', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { platform } = await renderPopup();
    fireEvent.click(button('목록 비우기'));
    const question = screen.getByRole('group', { name: '목록을 모두 비울까요?' });
    expect(within(question).getByText('목록을 모두 비울까요?')).toBeTruthy();
    expect(within(question).getByRole('button', { name: '비우기' })).toBeTruthy();
    expect(sentMessages(platform)).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
    // the safe choice has the focus
    expect(document.activeElement).toBe(within(question).getByRole('button', { name: '취소' }));
  });

  it('[비우기] sends queue/clear and the list is empty', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { platform } = await renderPopup();
    fireEvent.click(button('목록 비우기'));
    fireEvent.click(button('비우기'));
    await settle();
    expect(sentMessages(platform, 'queue/clear')).toEqual([{ to: 'bg', type: 'queue/clear' }]);
    expect(storedQueue(platform)).toEqual([]);
    expect(screen.getByText('디스코드에서 채널이나 DM에 마우스를 올리고 ⤓ 버튼을 누르세요')).toBeTruthy();
    expect(screen.queryByRole('group', { name: '목록을 모두 비울까요?' })).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('[취소] and Escape put everything back without sending anything', async () => {
    const { platform } = await renderPopup();
    fireEvent.click(button('목록 비우기'));
    fireEvent.click(button('취소'));
    expect(screen.queryByRole('group', { name: '목록을 모두 비울까요?' })).toBeNull();
    fireEvent.click(button('목록 비우기'));
    const question = screen.getByRole('group', { name: '목록을 모두 비울까요?' });
    fireEvent.keyDown(within(question).getByRole('button', { name: '취소' }), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: '목록을 모두 비울까요?' })).toBeNull();
    expect(sentMessages(platform)).toEqual([]);
    expect(chatRows()).toHaveLength(5);
  });

  it('the button is off while the question is open (no second question on top of the first)', async () => {
    await renderPopup();
    fireEvent.click(button('목록 비우기'));
    expect((button('목록 비우기') as HTMLButtonElement).disabled).toBe(true);
  });

  it('is in English too', async () => {
    const { platform } = await renderPopup({ settings: { language: 'en' } });
    fireEvent.click(button('Clear list'));
    expect(screen.getByRole('group', { name: 'Clear the whole list?' })).toBeTruthy();
    fireEvent.click(button('Clear'));
    await settle();
    expect(storedQueue(platform)).toEqual([]);
  });
});

describe('errors of the background worker are shown inline (docs/PLAN.md §7.2)', () => {
  const cases: Array<[BgError, string]> = [
    ['no-account', '디스코드 계정을 아직 확인하지 못했어요. 디스코드 탭에서 로그인한 뒤 다시 시도해 주세요.'],
    ['no-consent', '먼저 안내를 읽고 동의해 주세요.'],
    ['busy', '이미 다운로드가 진행 중이에요. 끝난 뒤에 다시 시도해 주세요.'],
    ['empty', '다운로드할 채팅이 없어요.'],
    ['invalid', '요청이 올바르지 않아요.'],
    ['forbidden-path', '이 위치에는 저장할 수 없어요. 폴더 이름을 확인해 주세요.'],
    ['http', '디스코드와 통신하지 못했어요.'],
    ['unknown', '문제가 생겼어요. 다시 시도해 주세요.'],
  ];

  it.each(cases)('%s', async (code, text) => {
    await renderPopup({ prepare: (platform) => platform.failNext('job/start', code) });
    fireEvent.click(button(/전체 다운로드/));
    await settle();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(text);
    expect(alert.querySelector('.dce-banner__detail')).toBeNull(); // no detail when the worker sent none
  });

  const english: Array<[BgError, string]> = [
    ['no-account', 'The Discord account is not known yet. Log in on a Discord tab and try again.'],
    ['no-consent', 'Read the notice and agree to it first.'],
    ['busy', 'A download is already running. Try again when it is finished.'],
    ['empty', 'There is no chat to download.'],
    ['invalid', 'The request is not valid.'],
    ['forbidden-path', 'Files cannot be saved there. Check the folder name.'],
    ['http', 'Could not talk to Discord.'],
    ['unknown', 'Something went wrong. Please try again.'],
  ];

  it.each(english)('%s (English)', async (code, text) => {
    await renderPopup({ settings: { language: 'en' }, prepare: (platform) => platform.failNext('job/start', code) });
    fireEvent.click(button(/Download all/));
    await settle();
    expect(screen.getByRole('alert').textContent).toContain(text);
  });

  it('the worker\'s own wording is added as a detail', async () => {
    await renderPopup({ prepare: (platform) => platform.failNext('job/start', 'http', 'HTTP 429') });
    fireEvent.click(button(/전체 다운로드/));
    await settle();
    expect(screen.getByRole('alert').querySelector('.dce-banner__detail')?.textContent).toBe('(HTTP 429)');
  });

  it('a real refusal of the (mock) worker: no account, because Discord is not open', async () => {
    const { platform } = await renderPopup({ scenario: 'no-discord' });
    fireEvent.click(button(/전체 다운로드/));
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('디스코드 계정을 아직 확인하지 못했어요');
    expect(sentMessages(platform, 'job/start')).toHaveLength(1);
  });

  it('a failure to reach the worker at all', async () => {
    const { platform } = await renderPopup();
    const send = platform.sendMessage.bind(platform);
    platform.sendMessage = (async (message) => (message.type === 'job/start' ? { ok: false, error: 'unknown', message: 'Receiving end does not exist' } : send(message))) as typeof platform.sendMessage;
    fireEvent.click(button(/전체 다운로드/));
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('문제가 생겼어요');
    expect(screen.getByRole('alert').textContent).toContain('(Receiving end does not exist)');
  });

  it('[알림 닫기] removes the message', async () => {
    await renderPopup({ prepare: (platform) => platform.failNext('job/start', 'busy') });
    fireEvent.click(button(/전체 다운로드/));
    await settle();
    fireEvent.click(button('알림 닫기'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the next action clears the old message, and a successful one leaves none', async () => {
    await renderPopup({ prepare: (platform) => platform.failNext('queue/remove', 'unknown') });
    fireEvent.click(within(row('Alex')).getByRole('button', { name: 'Alex 목록에서 빼기' }));
    await settle();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(row('Alex')).toBeTruthy(); // refused: still there
    fireEvent.click(within(row('Alex')).getByRole('button', { name: 'Alex 목록에서 빼기' }));
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(() => row('Alex')).toThrow();
  });

  it('a message does not follow the user to another screen', async () => {
    await renderPopup({ prepare: (platform) => platform.failNext('job/start', 'busy') });
    fireEvent.click(button(/전체 다운로드/));
    await settle();
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(button('기록'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('each refusal of a removal, a clear and a cancel is shown too', async () => {
    const { platform } = await renderPopup({ scenario: 'running' });
    platform.failNext('job/cancel', 'unknown');
    fireEvent.click(button('취소'));
    await settle();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(button('취소')).toBeTruthy(); // still running: the button is back
    expect((button('취소') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('focus', () => {
  it('after ✕ the focus moves to the next row (or the previous one at the end) instead of falling to the page', async () => {
    await renderPopup();
    const alexRemove = within(row('Alex')).getByRole('button', { name: 'Alex 목록에서 빼기' });
    alexRemove.focus();
    fireEvent.click(alexRemove);
    await settle();
    expect(document.activeElement).toBe(within(row('Study Group › #questions')).getByRole('button', { name: /목록에서 빼기$/ }));
  });

  it('removing the last row focuses the previous one', async () => {
    await renderPopup();
    const last = within(row('Study Group › #questions')).getByRole('button', { name: /목록에서 빼기$/ });
    last.focus();
    fireEvent.click(last);
    await settle();
    expect(document.activeElement).toBe(within(row('Alex')).getByRole('button', { name: /목록에서 빼기$/ }));
  });

  it('removing the only row focuses the list area', async () => {
    const { platform } = await renderPopup();
    await act(async () => {
      platform.write('local', { [LOCAL.queue(MOCK_ACCOUNT.id)]: [{ key: KEYS.dm, target: MOCK_TARGETS.dm, settings: null, addedAt: 1 }] });
    });
    await settle();
    fireEvent.click(within(row('Alex')).getByRole('button', { name: 'Alex 목록에서 빼기' }));
    await settle();
    expect(document.activeElement).toBe(document.querySelector('.dce-main__list'));
  });
});

describe('start buttons while a download runs', () => {
  it('▶ and 재시도 are unavailable (and say why); ⚙ and ✕ still work', async () => {
    const { platform } = await renderPopup({ scenario: 'running' });
    const start = within(row('Alex')).getByRole('button', { name: 'Alex 다운로드' });
    expect(start.getAttribute('aria-disabled')).toBe('true');
    expect(start.getAttribute('title')).toBe('다운로드가 진행 중이에요');
    fireEvent.click(start);
    await settle();
    expect(sentMessages(platform, 'job/start')).toEqual([]);
    expect(within(row('Alex')).getByRole('button', { name: 'Alex 설정' }).getAttribute('aria-disabled')).toBeNull();
    expect(within(row('Alex')).getByRole('button', { name: 'Alex 목록에서 빼기' }).getAttribute('aria-disabled')).toBeNull();
  });

  it('[재시도] of a row that failed in this very job is unavailable too', async () => {
    const failedJob: JobState = {
      jobId: 'j1',
      accountId: MOCK_ACCOUNT.id,
      startedAt: 1,
      finishedAt: null,
      state: 'running',
      pausedReason: null,
      zip: false,
      items: [
        { key: KEYS.dm, label: 'Alex', status: 'failed', phase: null, fetched: 0, expected: 200, error: { kind: 'forbidden', message: '' }, files: [] },
        { key: KEYS.general, label: 'g', status: 'running', phase: 'messages', fetched: 1, expected: 200, error: null, files: [] },
      ],
    };
    const { platform } = await renderPopup({ prepare: (mock) => mock.write('session', { [SESSION.job]: failedJob }) });
    const retry = within(row('Alex')).getByRole('button', { name: 'Alex 다시 시도' });
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(retry);
    await settle();
    expect(sentMessages(platform, 'job/start')).toEqual([]);
  });
});
