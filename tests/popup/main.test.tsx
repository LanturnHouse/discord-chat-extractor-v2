// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL, SESSION, type QueueItem } from '@/shared';
import { MOCK_ACCOUNT, MOCK_TARGETS } from '@/ui/platform/mock';
import { button, chatRows, groupRows, renderPopup, row, sentMessages, settle, storedSettings } from './helpers';

afterEach(cleanup); // vitest globals are off, so testing-library cannot register its own cleanup


describe('the header', () => {
  it('shows the avatar, the display name and the @username of the account', async () => {
    await renderPopup();
    const header = document.querySelector('.dce-header') as HTMLElement;
    expect(within(header).getByText('Sample User')).toBeTruthy();
    expect(within(header).getByText('@sample_user')).toBeTruthy();
    const avatar = header.querySelector('img.dce-avatar') as HTMLImageElement;
    expect(avatar.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(avatar.getAttribute('alt')).toBe('');
  });

  it('has the history and settings icons on the right, with names', async () => {
    await renderPopup();
    const header = document.querySelector('.dce-header') as HTMLElement;
    expect(within(header).getByRole('button', { name: '기록' })).toBeTruthy();
    expect(within(header).getByRole('button', { name: '설정' })).toBeTruthy();
  });

  it('falls back to the username when there is no display name', async () => {
    await renderPopup({
      prepare: (platform) => platform.write('session', { [SESSION.account]: { ...MOCK_ACCOUNT, globalName: null } }),
    });
    const header = document.querySelector('.dce-header') as HTMLElement;
    expect(header.querySelector('.dce-header__name')?.textContent).toBe('sample_user');
  });

  it('an avatar that is not on the Discord CDN is not loaded: a lettered circle instead', async () => {
    await renderPopup({
      prepare: (platform) => platform.write('session', { [SESSION.account]: { ...MOCK_ACCOUNT, avatarUrl: 'https://tracker.example/pixel.png' } }),
    });
    const header = document.querySelector('.dce-header') as HTMLElement;
    expect(header.querySelector('img')).toBeNull();
    expect(header.querySelector('.dce-avatar--fallback')?.textContent).toBe('S');
  });

  it('while the account is not known, the last known account is shown dimmed, with a hint', async () => {
    await renderPopup({ scenario: 'no-discord' });
    const who = document.querySelector('.dce-header__who') as HTMLElement;
    expect(who.getAttribute('title')).toBe('마지막으로 확인한 계정이에요');
    expect(who.hasAttribute('data-stale')).toBe(true);
    expect(within(who).getByText('Sample User')).toBeTruthy();
  });

  it('with no account at all it says so', async () => {
    await renderPopup({
      scenario: 'no-discord',
      prepare: (platform) => platform.write('local', { [LOCAL.lastAccount]: undefined }),
    });
    expect(screen.getByText('계정을 확인하지 못했어요')).toBeTruthy();
    expect(screen.getByText('디스코드에 로그인하면 여기에 표시돼요')).toBeTruthy();
    expect(document.querySelector('.dce-avatar--fallback')).not.toBeNull();
  });
});

describe('the download list (docs/PLAN.md §7.2)', () => {
  it('lists the chats as a tree: a server line with its chats, a DM, a one-line server; ordered by the time they were added', async () => {
    await renderPopup();
    // "Sample Server" is open (renderPopup opens it): its three chats are below the server line, in the order they were added
    const labels = Array.from(document.querySelectorAll('.dce-row__label')).map((element) => element.textContent);
    expect(labels).toEqual(['#general', '#announcements', '#general > weekend plans', 'Alex', 'Study Group › #questions']);
    const list = screen.getByRole('list', { name: '다운로드 목록' });
    expect(Array.from(list.children).map((child) => child.getAttribute('data-group-id') ?? child.getAttribute('data-key'))).toEqual([
      '200000000000000001',
      MOCK_TARGETS.dm.channelId,
      MOCK_TARGETS.questions.channelId,
    ]);
    expect(chatRows()).toHaveLength(5);
    expect(groupRows()).toHaveLength(1);
    expect(within(groupRows()[0]).getByRole('button', { name: 'Sample Server', expanded: true })).toBeTruthy();
  });

  it('under every label the one-line summary of the EFFECTIVE settings', async () => {
    await renderPopup();
    expect(row('Sample Server > #general').querySelector('.dce-row__summary')?.textContent).toBe('200개 · HTML · 기간 없음');
    expect(row('Alex').querySelector('.dce-row__summary')?.textContent).toBe('200개 · HTML · 기간 없음');
    // the item with settings of its own shows ITS settings: no limit, TXT, a range, attachments
    expect(row('Sample Server > #announcements').querySelector('.dce-row__summary')?.textContent).toBe('전체 · TXT · 2026-01-01 ~ 2026-03-31 · 첨부');
  });

  it('a "공통 설정" badge for chats that follow the common settings, "개별 설정" for the one with its own', async () => {
    await renderPopup();
    const badge = (label: string): string | undefined => row(label).querySelector('.dce-badge')?.textContent ?? undefined;
    expect(badge('Sample Server > #general')).toBe('공통 설정');
    expect(badge('Alex')).toBe('공통 설정');
    expect(badge('Study Group › #questions')).toBe('공통 설정');
    expect(badge('Sample Server > #announcements')).toBe('개별 설정');
    const badges = chatRows().map((li) => li.querySelector('.dce-badge')?.textContent);
    expect(badges.filter((text) => text === '개별 설정')).toHaveLength(1);
    expect(badges.filter((text) => text === '공통 설정')).toHaveLength(4);
    expect(row('Alex').querySelector('.dce-badge')?.getAttribute('title')).toContain('공통 설정을 바꾸면 같이 바뀌어요');
  });

  it('every row has ▶, ⚙ and ✕ with the name of the chat in their accessible names', async () => {
    await renderPopup();
    const alex = within(row('Alex'));
    expect(alex.getByRole('button', { name: 'Alex 다운로드' })).toBeTruthy();
    expect(alex.getByRole('button', { name: 'Alex 설정' })).toBeTruthy();
    expect(alex.getByRole('button', { name: 'Alex 목록에서 빼기' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: / 다운로드$/ })).toHaveLength(6); // five chats + the server line
    // the server line has its own three, named after the server
    const server = within(groupRows()[0]);
    expect(server.getAllByRole('button', { name: 'Sample Server 채널 다운로드' })).toHaveLength(1);
  });

  it('the summary follows the common settings for chats that follow them, and leaves the own-settings chat alone', async () => {
    const { platform } = await renderPopup();
    const common = storedSettings(platform).common;
    await act(async () => {
      await platform.sendMessage({
        to: 'bg',
        type: 'settings/patch',
        patch: { common: { ...common, count: 50, format: 'md', includeThreads: true, from: new Date(2026, 4, 1).toISOString() } },
      });
    });
    await settle();
    expect(row('Alex').querySelector('.dce-row__summary')?.textContent).toBe('50개 · MD · 2026-05-01부터 · 스레드');
    expect(row('Sample Server > #general').querySelector('.dce-row__summary')?.textContent).toBe('50개 · MD · 2026-05-01부터 · 스레드');
    expect(row('Sample Server > #announcements').querySelector('.dce-row__summary')?.textContent).toBe('전체 · TXT · 2026-01-01 ~ 2026-03-31 · 첨부');
  });

  it('shows "새 메시지만" for an incremental chat', async () => {
    const { platform } = await renderPopup();
    const common = storedSettings(platform).common;
    await act(async () => {
      await platform.sendMessage({ to: 'bg', type: 'settings/patch', patch: { common: { ...common, incremental: true, includeAttachments: true } } });
    });
    await settle();
    expect(row('Alex').querySelector('.dce-row__summary')?.textContent).toBe('200개 · HTML · 기간 없음 · 첨부 · 새 메시지만');
  });

  it('follows the list in storage: a chat added from Discord appears, a removed one goes', async () => {
    const { platform } = await renderPopup();
    const queue = platform.read('local', LOCAL.queue(MOCK_ACCOUNT.id)) as QueueItem[];
    await act(async () => {
      platform.write('local', {
        [LOCAL.queue(MOCK_ACCOUNT.id)]: [
          ...queue.slice(1),
          { key: '777', target: { kind: 'dm', channelId: '777', guildId: null, guildName: null, channelName: 'Sam' }, settings: null, addedAt: 1 },
        ],
      });
    });
    await settle();
    expect(() => row('Sample Server > #general')).toThrow();
    expect(row('Sam')).toBeTruthy();
  });

  it('a malformed entry in storage is skipped instead of breaking the popup', async () => {
    const { platform } = await renderPopup();
    await act(async () => {
      platform.write('local', { [LOCAL.queue(MOCK_ACCOUNT.id)]: ['junk', null, { key: '1' }, { key: '2', target: { ...MOCK_TARGETS.dm, channelId: '2' }, settings: null, addedAt: 1 }] });
    });
    await settle();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Alex')).toBeTruthy();
  });

  it('a DM avatar from the Discord CDN is shown, one from anywhere else is not', async () => {
    const { platform } = await renderPopup({ scenario: 'empty' });
    await act(async () => {
      platform.write('local', {
        [LOCAL.queue(MOCK_ACCOUNT.id)]: [
          { key: '1', target: { ...MOCK_TARGETS.dm, channelId: '1', channelName: 'Cdn', iconUrl: 'https://cdn.discordapp.com/avatars/1/a.png' }, settings: null, addedAt: 1 },
          { key: '2', target: { ...MOCK_TARGETS.dm, channelId: '2', channelName: 'Other', iconUrl: 'https://tracker.example/a.png' }, settings: null, addedAt: 2 },
        ],
      });
    });
    await settle();
    expect(row('Cdn').querySelector('img.dce-row__avatar')?.getAttribute('src')).toBe('https://cdn.discordapp.com/avatars/1/a.png');
    expect(row('Other').querySelector('img')).toBeNull();
    expect(row('Other').querySelector('svg.dce-row__kind')).not.toBeNull();
  });

  it('an empty list says what to do on Discord', async () => {
    await renderPopup({ scenario: 'empty' });
    expect(screen.getByText('디스코드에서 채널이나 DM에 마우스를 올리고 ⤓ 버튼을 누르세요')).toBeTruthy();
    expect(screen.queryByRole('list', { name: '다운로드 목록' })).toBeNull();
  });

  it('is in English when the language is English', async () => {
    await renderPopup({ settings: { language: 'en' } });
    expect(row('Alex').querySelector('.dce-row__summary')?.textContent).toBe('200 messages · HTML · No date range');
    expect(row('Alex').querySelector('.dce-badge')?.textContent).toBe('Common settings');
    expect(row('Sample Server > #announcements').querySelector('.dce-badge')?.textContent).toBe('Own settings');
    expect(row('Sample Server > #announcements').querySelector('.dce-row__summary')?.textContent).toBe('All messages · TXT · 2026-01-01 – 2026-03-31 · attachments');
    expect(screen.getByRole('button', { name: 'Download Alex' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download all HTML' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Download list' })).toBeTruthy();
  });

  it('an empty list in English', async () => {
    await renderPopup({ scenario: 'empty', settings: { language: 'en' } });
    expect(screen.getByText('On Discord, hover a channel or DM and press the ⤓ button')).toBeTruthy();
  });
});

describe('the "디스코드에 버튼 표시" switch', () => {
  it('shows the setting', async () => {
    await renderPopup();
    expect((screen.getByRole('switch', { name: '디스코드에 버튼 표시' }) as HTMLInputElement).checked).toBe(true);
    cleanup();
    await renderPopup({ settings: { showButtons: false } });
    expect((screen.getByRole('switch', { name: '디스코드에 버튼 표시' }) as HTMLInputElement).checked).toBe(false);
  });

  it('turning it off sends settings/patch { showButtons: false } and switches at once', async () => {
    const { platform } = await renderPopup();
    fireEvent.click(screen.getByRole('switch', { name: '디스코드에 버튼 표시' }));
    expect((screen.getByRole('switch', { name: '디스코드에 버튼 표시' }) as HTMLInputElement).checked).toBe(false); // optimistic
    await settle();
    expect(sentMessages(platform, 'settings/patch')).toEqual([{ to: 'bg', type: 'settings/patch', patch: { showButtons: false } }]);
    expect(storedSettings(platform).showButtons).toBe(false);
    fireEvent.click(screen.getByRole('switch', { name: '디스코드에 버튼 표시' }));
    await settle();
    expect(sentMessages(platform, 'settings/patch').at(-1)).toEqual({ to: 'bg', type: 'settings/patch', patch: { showButtons: true } });
    expect(storedSettings(platform).showButtons).toBe(true);
  });

  it('goes back when the background refuses', async () => {
    const { platform } = await renderPopup({ prepare: (mock) => mock.failNext('settings/patch', 'unknown') });
    fireEvent.click(screen.getByRole('switch', { name: '디스코드에 버튼 표시' }));
    await settle();
    expect((screen.getByRole('switch', { name: '디스코드에 버튼 표시' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('문제가 생겼어요');
    expect(storedSettings(platform).showButtons).toBe(true);
  });
});

describe('the footer button label', () => {
  it('"⤓ 전체 다운로드 [HTML] ▾": the chip shows the format of the common settings', async () => {
    const { platform } = await renderPopup();
    const main = button(/전체 다운로드/);
    expect(main.querySelector('.dce-split__label')?.textContent).toBe('전체 다운로드');
    expect(main.querySelector('.dce-split__chip')?.textContent).toBe('HTML');
    expect(main.querySelector('svg')).not.toBeNull();
    expect(button('공통 설정 열기').querySelector('svg')).not.toBeNull();
    const common = storedSettings(platform).common;
    for (const [format, chip] of [['xlsx', 'XLSX'], ['md', 'MD'], ['json', 'JSON'], ['csv', 'CSV'], ['txt', 'TXT']] as const) {
      await act(async () => {
        await platform.sendMessage({ to: 'bg', type: 'settings/patch', patch: { common: { ...common, format } } });
      });
      await settle();
      expect(button(/전체 다운로드/).querySelector('.dce-split__chip')?.textContent, format).toBe(chip);
    }
  });

  it('with an empty list the main part is unavailable (and says why) but the options stay reachable', async () => {
    const { platform } = await renderPopup({ scenario: 'empty' });
    const main = button(/전체 다운로드/);
    expect(main.getAttribute('aria-disabled')).toBe('true');
    expect(main.getAttribute('title')).toBe('다운로드 목록이 비어 있어요');
    fireEvent.click(main);
    expect(sentMessages(platform, 'job/start')).toEqual([]);
    expect(button('공통 설정 열기').getAttribute('aria-disabled')).toBeNull();
    expect((button('목록 비우기') as HTMLButtonElement).disabled).toBe(true);
  });
});
