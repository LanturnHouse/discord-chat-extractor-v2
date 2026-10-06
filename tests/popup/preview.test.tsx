// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPreview } from '@/popup/preview/renderPreview';
import { MOCK_SCENARIOS } from '@/ui/platform/mock';
import { settle } from './helpers';

let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  container.id = 'root';
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  cleanup(); // vitest globals are off, so testing-library cannot register its own cleanup
  document.body.classList.remove('dce-preview');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('style');
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function preview(search: string): Promise<void> {
  window.history.replaceState({}, '', `/popup.html${search}`);
  root = createRoot(container);
  act(() => renderPreview(root!));
  await settle();
  await settle();
}

describe('popup.html?mock=1: the popup on the in-memory mock, for a normal browser tab', () => {
  it('renders the popup with sample data inside a frame, next to the preview controls', async () => {
    await preview('?mock=1');
    expect(document.body.classList.contains('dce-preview')).toBe(true);
    const frame = container.querySelector('.dce-preview__frame') as HTMLElement;
    expect(frame).not.toBeNull();
    expect(frame.textContent).toContain('Sample User');
    expect(screen.getByRole('complementary', { name: 'Mock preview controls' })).toBeTruthy();
  });

  it('starts with a download in progress (the sample "running" scenario), which keeps going by itself', async () => {
    await preview('?mock=1');
    expect(screen.getByRole('progressbar', { name: '전체 진행률' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('progressbar', { name: '전체 진행률' }).getAttribute('aria-valuenow')).not.toBe('40'), { timeout: 5000 });
  });

  it('?scenario= picks the starting scenario; every scenario can be started', async () => {
    for (const scenario of MOCK_SCENARIOS) {
      await preview(`?mock=1&scenario=${scenario}`);
      expect((screen.getByLabelText('Scenario') as HTMLSelectElement).value).toBe(scenario);
      act(() => root?.unmount());
      root = null;
      cleanup();
      container.replaceChildren();
    }
  });

  it('an unknown scenario falls back to the default', async () => {
    await preview('?mock=1&scenario=nope');
    expect((screen.getByLabelText('Scenario') as HTMLSelectElement).value).toBe('running');
  });

  it('the scenario selector reloads the sample data', async () => {
    await preview('?mock=1&scenario=idle');
    expect(screen.queryByRole('progressbar', { name: '전체 진행률' })).toBeNull();
    expect(screen.getByRole('button', { name: /전체 다운로드/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Scenario'), { target: { value: 'consent' } });
    await settle();
    await settle();
    expect(screen.getByRole('button', { name: '동의하고 시작' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Scenario'), { target: { value: 'no-discord' } });
    await settle();
    // the number of Discord tabs is only known to `status/get`: the preview polls it twice a second
    await waitFor(() => expect(screen.getByRole('button', { name: '디스코드 열기' })).toBeTruthy(), { timeout: 3000 });
  });

  it('the theme selector changes the theme the popup applies, the language selector its language', async () => {
    await preview('?mock=1&scenario=idle');
    expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'light' } });
    await settle();
    expect(document.documentElement.dataset.theme).toBe('light');
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'en' } });
    await settle();
    expect(screen.getByRole('button', { name: 'History' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'ko' } });
    await settle();
    expect(screen.getByRole('button', { name: '기록' })).toBeTruthy();
  });

  it('lists the messages the popup sent (without the status poll)', async () => {
    await preview('?mock=1&scenario=idle');
    fireEvent.click(screen.getByRole('switch', { name: '디스코드에 버튼 표시' }));
    await settle();
    await waitFor(() => expect(container.querySelector('.dce-preview__log')?.textContent).toContain('settings/patch {"showButtons":false}'), { timeout: 3000 });
    expect(container.querySelector('.dce-preview__log')?.textContent).not.toContain('status/get');
  });

  it('every action works on the mock: start a download from the list and watch it', async () => {
    await preview('?mock=1&scenario=idle');
    fireEvent.click(screen.getByRole('button', { name: 'Alex 다운로드' }));
    await settle();
    await settle();
    expect(screen.getByRole('progressbar', { name: '전체 진행률' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '취소' })).toBeTruthy();
  });
});

describe('the queue tree in the preview (docs/PLAN.md §7.2a): popup.html?mock=1&scenario=tree', () => {
  const groupIds = (): string[] => Array.from(container.querySelectorAll<HTMLElement>('li[data-group-id]')).map((li) => li.dataset.groupId ?? '');

  it('starts with the tree collapsed: two server lines, a DM, a one-line server', async () => {
    await preview('?mock=1&scenario=tree');
    expect(groupIds()).toEqual(['200000000000000001', '200000000000000002']);
    expect(container.querySelectorAll('li[data-key]')).toHaveLength(2); // the DM and "Book Club › #reading"
    expect(screen.getByRole('button', { name: 'Sample Server', expanded: false })).toBeTruthy();
    expect(container.textContent).toContain('Book Club');
    expect((screen.getByLabelText('Scenario') as HTMLSelectElement).value).toBe('tree');
  });

  it('opens a group on a click and keeps the choice while the preview runs', async () => {
    await preview('?mock=1&scenario=tree');
    fireEvent.click(screen.getByRole('button', { name: 'Sample Server', expanded: false }));
    await settle();
    expect(screen.getByRole('button', { name: 'Sample Server', expanded: true })).toBeTruthy();
    expect(container.querySelectorAll('li[data-key]').length).toBeGreaterThan(2);
  });

  it('a group\'s settings can be saved, and the message shows up in the list of messages sent', async () => {
    await preview('?mock=1&scenario=tree');
    fireEvent.click(screen.getByRole('button', { name: 'Study Group 설정' }));
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: '서버 설정 · Study Group' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /^JSON/ }));
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await settle();
    await waitFor(() => expect(container.querySelector('.dce-preview__log')?.textContent).toContain('queue/setGroupSettings guild 200000000000000002 settings=own'), { timeout: 3000 });
  });

  it('removing a group lists queue/removeMany; the running scenario aggregates progress on the server line', async () => {
    await preview('?mock=1&scenario=running');
    expect(screen.getByRole('progressbar', { name: 'Sample Server 진행률' })).toBeTruthy();
    act(() => root?.unmount());
    root = null;
    cleanup();
    container.replaceChildren();
    await preview('?mock=1&scenario=tree');
    fireEvent.click(screen.getByRole('button', { name: 'Study Group 채널 목록에서 빼기' }));
    fireEvent.click(screen.getByRole('button', { name: '빼기' }));
    await settle();
    await waitFor(() => expect(container.querySelector('.dce-preview__log')?.textContent).toContain('queue/removeMany ['), { timeout: 3000 });
    expect(groupIds()).toEqual(['200000000000000001']);
  });
});

describe('the safety question in the preview (popup.html?mock=1&scenario=risk)', () => {
  it('starts with 12 chats; [전체 다운로드] asks first, [계속 받기] starts the (mock) download', async () => {
    await preview('?mock=1&scenario=risk');
    expect((screen.getByLabelText('Scenario') as HTMLSelectElement).value).toBe('risk');
    fireEvent.click(screen.getByRole('button', { name: /전체 다운로드/ }));
    await settle();
    const question = screen.getByRole('group', { name: /^채팅 12개를 한 번에 받으려고 해요/ });
    expect(question.querySelectorAll('.dce-confirm__details li')).toHaveLength(4);
    expect(container.querySelector('.dce-preview__log')?.textContent).not.toContain('job/start');
    fireEvent.click(screen.getByRole('button', { name: '계속 받기' }));
    await settle();
    await waitFor(() => expect(container.querySelector('.dce-preview__log')?.textContent).toContain('job/start "all"'), { timeout: 3000 });
    expect(screen.getByRole('progressbar', { name: '전체 진행률' })).toBeTruthy();
  });
});

describe('the popup entry (main.tsx)', () => {
  async function load(search: string): Promise<void> {
    window.history.replaceState({}, '', `/popup.html${search}`);
    document.body.innerHTML = '<div id="root"></div>';
    await import('@/popup/main');
  }

  it('with ?mock=1 it starts the mock preview', async () => {
    await load('?mock=1&scenario=consent');
    await waitFor(() => expect(screen.getByRole('button', { name: '동의하고 시작' })).toBeTruthy(), { timeout: 3000 });
    expect(document.body.classList.contains('dce-preview')).toBe(true);
  });

  it('without an extension runtime (a normal browser tab) it starts the mock preview too', async () => {
    await load('');
    await waitFor(() => expect(screen.getByText('Sample User')).toBeTruthy(), { timeout: 3000 });
  });

  it('inside the extension it runs on the real platform and never starts the mock', async () => {
    const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
    const sendMessage = vi.fn(async (_message: unknown): Promise<unknown> => ({ ok: true, data: { account: null, lastAccount: null, discordTabs: 0, health: null, job: null } }));
    vi.stubGlobal('chrome', {
      runtime: { id: 'abcdefghijklmnopabcdefghijklmnop', sendMessage },
      storage: {
        local: { get: vi.fn(async () => ({})) },
        session: { get: vi.fn(async () => ({})) },
        onChanged: { addListener: (listener: (typeof listeners)[number]) => listeners.push(listener), removeListener: vi.fn() },
      },
      commands: { getAll: vi.fn(async () => []) },
      tabs: { create: vi.fn() },
      i18n: { getUILanguage: () => 'ko' },
    });
    await load('');
    // nothing stored: the first-run notice, from the real platform
    await waitFor(() => expect(screen.getByRole('button', { name: '동의하고 시작' })).toBeTruthy(), { timeout: 3000 });
    expect(document.body.classList.contains('dce-preview')).toBe(false);
    expect(document.querySelector('.dce-preview__controls')).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith({ to: 'bg', type: 'status/get' });
    expect(listeners).toHaveLength(1); // it listens to the storage of the extension
  });

  it('?mock=1 inside the extension (to inspect a loaded build) still gives the mock', async () => {
    vi.stubGlobal('chrome', { runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' }, storage: {} });
    await load('?mock=1&scenario=idle');
    await waitFor(() => expect(screen.getByText('Sample User')).toBeTruthy(), { timeout: 3000 });
  });
});
