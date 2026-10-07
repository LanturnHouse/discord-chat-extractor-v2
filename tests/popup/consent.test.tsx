// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PopupRoot } from '@/popup/PopupRoot';
import { createMockPlatform } from '@/ui/platform/mock';
import { LOCAL } from '@/shared';
import { button, popupText, renderPopup, sentMessages, settle, storedSettings } from './helpers';

afterEach(() => {
  cleanup(); // vitest globals are off, so testing-library cannot register its own cleanup
  vi.useRealTimers();
});

describe('the first-run notice (docs/PLAN.md §2 #11, §7.2)', () => {
  it('is all that is shown until the user agrees: the Discord terms / account risk notice and [동의하고 시작]', async () => {
    await renderPopup({ scenario: 'consent' });
    expect(screen.getByRole('heading', { level: 1, name: '시작하기 전에 꼭 읽어 주세요' })).toBeTruthy();
    expect(screen.getByText('디스코드 이용약관과 계정 위험')).toBeTruthy();
    expect(screen.getByText(/계정이 경고를 받거나 제한·정지될 수 있어요/)).toBeTruthy();
    expect(screen.getByText('내 대화의 개인 백업용으로만 쓰세요')).toBeTruthy();
    expect(screen.getByText('로그인 토큰을 읽어요')).toBeTruthy();
    expect(screen.getByText(/크롬을 끄면 사라져요/)).toBeTruthy();
    expect(screen.getByText('채팅은 이 컴퓨터에 파일로 저장돼요')).toBeTruthy();
    expect(screen.getByText(/별도 서버로 보내거나 분석 도구를 쓰지 않아요/)).toBeTruthy();
    expect(screen.getByText('천천히, 조금씩 받아요')).toBeTruthy();
    expect(screen.getByRole('button', { name: '동의하고 시작' })).toBeTruthy();
    expect(screen.getByText('동의하기 전에는 아무것도 읽거나 다운로드하지 않아요.')).toBeTruthy();
  });

  it('nothing else is reachable: no account header, no list, no download button, no settings', async () => {
    await renderPopup({ scenario: 'consent' });
    for (const name of ['기록', '설정', /전체 다운로드/, /공통 설정 열기/]) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByRole('list', { name: '다운로드 목록' })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(popupText()).not.toContain('Sample User');
  });

  it('Escape does nothing there', async () => {
    await renderPopup({ scenario: 'consent' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('button', { name: '동의하고 시작' })).toBeTruthy();
  });

  it('[동의하고 시작] sends settings/patch { consentAt: now } and then shows the main screen', async () => {
    const before = Date.now();
    const { platform } = await renderPopup({ scenario: 'consent' });
    fireEvent.click(button('동의하고 시작'));
    await settle();
    const patches = sentMessages(platform, 'settings/patch');
    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({ to: 'bg', type: 'settings/patch', patch: { consentAt: expect.any(Number) } });
    const { consentAt } = (patches[0] as { patch: { consentAt: number } }).patch;
    expect(consentAt).toBeGreaterThanOrEqual(before);
    expect(consentAt).toBeLessThanOrEqual(Date.now());
    expect(storedSettings(platform).consentAt).toBe(consentAt);
    expect(screen.queryByRole('button', { name: '동의하고 시작' })).toBeNull();
    expect(screen.getByText('Sample User')).toBeTruthy(); // the main screen
  });

  it('the screen does not go away on a guess: while the background has not answered it stays, and the button is off', async () => {
    const platform = createMockPlatform({ scenario: 'consent' });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = platform.sendMessage.bind(platform);
    platform.sendMessage = (async (message) => {
      if (message.type === 'settings/patch') await gate;
      return send(message);
    }) as typeof platform.sendMessage;
    render(<PopupRoot platform={platform} pollMs={600_000} />);
    await settle();
    fireEvent.click(button('동의하고 시작'));
    await settle();
    expect((button('동의하고 시작') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button('동의하고 시작'));
    expect(screen.getByRole('heading', { level: 1, name: '시작하기 전에 꼭 읽어 주세요' })).toBeTruthy();
    await act(async () => {
      release();
      await gate;
    });
    await settle();
    expect(screen.queryByRole('button', { name: '동의하고 시작' })).toBeNull();
    expect(platform.sent.filter((message) => message.type === 'settings/patch')).toHaveLength(1);
  });

  it('a refusal keeps the notice and says why, inline', async () => {
    const { platform } = await renderPopup({ scenario: 'consent', prepare: (mock) => mock.failNext('settings/patch', 'unknown', 'storage is full') });
    fireEvent.click(button('동의하고 시작'));
    await settle();
    expect(screen.getByRole('button', { name: '동의하고 시작' })).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('문제가 생겼어요. 다시 시도해 주세요.');
    expect(alert.textContent).toContain('(storage is full)');
    expect(storedSettings(platform).consentAt).toBeNull();
    // and the user can try again
    fireEvent.click(button('동의하고 시작'));
    await settle();
    expect(screen.queryByRole('button', { name: '동의하고 시작' })).toBeNull();
  });

  it('is shown in English when the language is English', async () => {
    await renderPopup({ scenario: 'consent', settings: { language: 'en' } });
    expect(screen.getByRole('heading', { level: 1, name: 'Please read this before you start' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Agree and start' })).toBeTruthy();
    expect(screen.getByText('Discord Terms of Service and account risk')).toBeTruthy();
  });

  it('does not flash before the first read of storage, and never appears for a user who agreed', async () => {
    const platform = createMockPlatform({ scenario: 'idle' });
    render(<PopupRoot platform={platform} pollMs={600_000} />);
    // before storage was read: a quiet loading state, not the notice
    expect(screen.getByRole('status').textContent).toContain('불러오는 중');
    expect(screen.queryByRole('button', { name: '동의하고 시작' })).toBeNull();
    await settle();
    await settle();
    expect(screen.queryByRole('button', { name: '동의하고 시작' })).toBeNull();
    expect(screen.getByText('Sample User')).toBeTruthy();
  });

  it('an old consent time (any number) counts: nothing asks again', async () => {
    await renderPopup({ settings: { consentAt: 1 } });
    expect(screen.queryByRole('button', { name: '동의하고 시작' })).toBeNull();
  });

  it('a stored value that is not a number does not count as consent', async () => {
    const { platform } = await renderPopup({
      scenario: 'idle',
      prepare: (mock) => mock.write('local', { [LOCAL.settings]: { ...storedSettings(mock), consentAt: 'yes' } }),
    });
    expect(platform.read('local', LOCAL.settings)).toMatchObject({ consentAt: 'yes' });
    expect(screen.getByRole('button', { name: '동의하고 시작' })).toBeTruthy();
  });
});
