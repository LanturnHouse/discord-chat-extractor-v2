// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PopupRoot } from '@/popup/PopupRoot';
import { SESSION, type JobState } from '@/shared';
import { MOCK_ACCOUNT, createMockPlatform, sampleRunningJob } from '@/ui/platform/mock';
import { button, renderPopup, sentMessages, settle } from './helpers';

afterEach(() => {
  cleanup(); // vitest globals are off, so testing-library cannot register its own cleanup
  vi.useRealTimers();
});

const banners = (): HTMLElement | null => document.querySelector('.dce-banners');

describe('banners (docs/PLAN.md §7.2)', () => {
  it('a logged-in account with a healthy page: no banner at all', async () => {
    await renderPopup();
    expect(banners()).toBeNull();
  });

  it('no Discord tab and no account: says so, with [디스코드 열기]', async () => {
    await renderPopup({ scenario: 'no-discord' });
    const banner = within(banners()!);
    expect(banner.getByText('열려 있는 디스코드 탭이 없어요. 디스코드를 열고 로그인해 주세요.')).toBeTruthy();
    expect(banner.getByRole('button', { name: '디스코드 열기' })).toBeTruthy();
    expect(banners()!.querySelector('[role="status"]')).not.toBeNull();
  });

  it('[디스코드 열기] sends discord/open, and the banner turns into "계정 확인 중…" once a tab exists', async () => {
    const { platform } = await renderPopup({ scenario: 'no-discord' });
    fireEvent.click(button('디스코드 열기'));
    await settle();
    expect(sentMessages(platform, 'discord/open')).toEqual([{ to: 'bg', type: 'discord/open' }]);
    expect(screen.queryByRole('button', { name: '디스코드 열기' })).toBeNull();
    expect(within(banners()!).getByText('계정 확인 중…')).toBeTruthy();
  });

  it('a failure to open Discord is shown inline', async () => {
    await renderPopup({ scenario: 'no-discord', prepare: (platform) => platform.failNext('discord/open', 'unknown', 'no window') });
    fireEvent.click(button('디스코드 열기'));
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('(no window)');
    expect(screen.getByRole('button', { name: '디스코드 열기' })).toBeTruthy();
  });

  it('a Discord tab but no account yet: "계정 확인 중…", no button', async () => {
    await renderPopup({ scenario: 'checking' });
    const banner = within(banners()!);
    expect(banner.getByText('계정 확인 중…')).toBeTruthy();
    expect(banner.getByText('디스코드 탭에서 로그인한 계정을 확인하고 있어요.')).toBeTruthy();
    expect(banner.queryByRole('button')).toBeNull();
    expect(banners()!.querySelector('.dce-icon-spin')).not.toBeNull();
  });

  it('the banner goes away by itself when the account becomes known', async () => {
    const { platform } = await renderPopup({ scenario: 'checking' });
    expect(banners()).not.toBeNull();
    await act(async () => {
      platform.write('session', { [SESSION.account]: { ...MOCK_ACCOUNT } });
    });
    await settle();
    expect(banners()).toBeNull();
  });

  it('a Discord tab whose login expired (a job ended with an auth error): asks to reload the tab', async () => {
    const expired: JobState = {
      ...sampleRunningJob(Date.now()),
      state: 'failed',
      finishedAt: Date.now(),
      items: [{ key: '1', label: 'x', status: 'failed', phase: null, fetched: 0, expected: 10, error: { kind: 'auth', message: '' }, files: [] }],
    };
    await renderPopup({
      scenario: 'checking',
      prepare: (platform) => platform.write('session', { [SESSION.job]: expired }),
    });
    expect(within(banners()!).getByText('디스코드 로그인 정보가 만료됐어요. 디스코드 탭을 새로고침한 뒤 다시 시도해 주세요.')).toBeTruthy();
    expect(screen.queryByText('계정 확인 중…')).toBeNull();
  });

  it('the buttons could not be put on the Discord page: a warning with the reason', async () => {
    await renderPopup({ scenario: 'unhealthy' });
    const banner = within(banners()!);
    expect(banner.getByText(/디스코드 화면에 버튼을 붙이지 못했어요/)).toBeTruthy();
    expect(banner.getByText('(channel list not found)')).toBeTruthy();
    expect(banners()!.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('the page warning needs a Discord tab: without one, only the "open Discord" banner shows', async () => {
    await renderPopup({
      scenario: 'no-discord',
      prepare: (platform) => platform.setHealth({ ok: false, reason: 'stale', checkedAt: 1 }),
    });
    expect(screen.queryByText(/버튼을 붙이지 못했어요/)).toBeNull();
    expect(screen.getByRole('button', { name: '디스코드 열기' })).toBeTruthy();
  });

  it('shows nothing about Discord before the background has answered (no wrong "no tab" flash)', async () => {
    const platform = createMockPlatform({ scenario: 'no-discord' });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = platform.sendMessage.bind(platform);
    platform.sendMessage = (async (message) => {
      if (message.type === 'status/get') await gate;
      return send(message);
    }) as typeof platform.sendMessage;
    render(<PopupRoot platform={platform} pollMs={600_000} />);
    await settle();
    await settle();
    expect(screen.getByText('Sample User')).toBeTruthy(); // the screen is there...
    expect(banners()).toBeNull(); // ...but it does not claim there is no tab yet
    await act(async () => {
      release();
      await gate;
    });
    await settle();
    expect(banners()).not.toBeNull();
  });

  it('a background worker that does not answer: an error banner, gone when it answers again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const platform = createMockPlatform({ scenario: 'idle' });
    const send = platform.sendMessage.bind(platform);
    let down = true;
    platform.sendMessage = (async (message) => {
      if (message.type === 'status/get' && down) return { ok: false, error: 'unknown', message: 'Could not establish connection' };
      return send(message);
    }) as typeof platform.sendMessage;
    render(<PopupRoot platform={platform} pollMs={2000} />);
    await settle();
    await settle();
    expect(within(banners()!).getByText('확장 프로그램의 백그라운드와 연결하지 못했어요. 팝업을 닫고 다시 열어 보세요.')).toBeTruthy();
    down = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await settle();
    expect(banners()).toBeNull();
  });

  it('is in English when the language is English', async () => {
    await renderPopup({ scenario: 'no-discord', settings: { language: 'en' } });
    expect(screen.getByText('No Discord tab is open. Open Discord and log in.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Discord' })).toBeTruthy();
    cleanup();
    await renderPopup({ scenario: 'checking', settings: { language: 'en' } });
    expect(screen.getByText('Checking the account…')).toBeTruthy();
    cleanup();
    await renderPopup({ scenario: 'unhealthy', settings: { language: 'en' } });
    expect(screen.getByText(/The buttons could not be added to the Discord page/)).toBeTruthy();
  });

  it('banners are live regions: a status for information, an alert for a problem', async () => {
    await renderPopup({ scenario: 'no-discord' });
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    cleanup();
    await renderPopup({ scenario: 'unhealthy' });
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });
});
