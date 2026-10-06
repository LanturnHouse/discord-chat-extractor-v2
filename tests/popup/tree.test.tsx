// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PopupRoot } from '@/popup/PopupRoot';
import { DEFAULT_EXPORT_SETTINGS, LOCAL, SESSION, type GroupInfo, type HistoryEntry, type JobState, type QueueItem } from '@/shared';
import { MOCK_ACCOUNT, MOCK_CATEGORIES, MOCK_GUILDS, MOCK_TARGETS, TREE_TARGETS } from '@/ui/platform/mock';
import popupCss from '@/popup/popup.css?raw';
import { button, chatRows, groupRows, renderPopup, row, sentMessages, settle } from './helpers';

afterEach(cleanup); // vitest globals are off, so testing-library cannot register its own cleanup

const S1 = MOCK_GUILDS.sample.id;
const S2 = MOCK_GUILDS.study.id;
const S3 = MOCK_GUILDS.book.id;
const STUDY = MOCK_CATEGORIES.study.id;
const COURSES = MOCK_CATEGORIES.courses.id;
const ARCHIVE = MOCK_CATEGORIES.archive.id;
const T = TREE_TARGETS;
const key = (target: { channelId: string }): string => target.channelId;
const ICON = `https://cdn.discordapp.com/icons/${S1}/sample-icon.png?size=64`;

const group = (id: string): HTMLElement => {
  const li = groupRows().find((candidate) => candidate.dataset.groupId === id);
  if (li === undefined) throw new Error(`no group line for ${id}`);
  return li;
};
/** The line of a group without what is nested below it. */
const line = (id: string): HTMLElement => group(id).querySelector('.dce-group') as HTMLElement;
const toggleOf = (id: string): HTMLButtonElement => line(id).querySelector('.dce-group__main') as HTMLButtonElement;
const chipOf = (id: string): string => line(id).querySelector('.dce-chip')?.textContent ?? '';
/** Every badge of a line or a row, in order ("공통 설정", "개별 1"...). */
const badgesOf = (element: HTMLElement): string[] => Array.from(element.querySelectorAll('.dce-badge')).map((badge) => badge.textContent ?? '');
const subtitleOf = (id: string): string | null => line(id).querySelector('.dce-group__subtitle')?.textContent ?? null;

/** The top level of the list: group ids and chat keys, in the order they are on screen. */
const topLevel = (): string[] => Array.from(screen.getByRole('list', { name: '다운로드 목록' }).children).map((li) => (li as HTMLElement).dataset.groupId ?? `row:${(li as HTMLElement).dataset.key}`);

describe('the queue tree: every kind of row (docs/PLAN.md §7.2a)', () => {
  it('first start: servers are collapsed lines, a DM is a flat row, a server with one chat is one line; ordered by the earliest chat', async () => {
    await renderPopup({ scenario: 'tree', expanded: [] });
    expect(topLevel()).toEqual([S1, `row:${key(T.dm)}`, `row:${key(T.reading)}`, S2]);
    expect(chatRows().map((li) => li.dataset.key)).toEqual([key(T.dm), key(T.reading)]); // nothing else is drawn while the groups are closed
    expect(toggleOf(S1).getAttribute('aria-expanded')).toBe('false');
    expect(toggleOf(S2).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list', { name: 'Sample Server' })).toBeNull();
  });

  it('a server line: name, the number of chats, the settings badge, "개별 N", and a few channel names under it', async () => {
    await renderPopup({ scenario: 'tree', expanded: [] });
    expect(line(S1).querySelector('.dce-group__name')?.textContent).toBe('Sample Server');
    expect(chipOf(S1)).toBe('7개'); // 7 of its 8 viewable channels (the thread counts as a chat)
    expect(badgesOf(line(S1))).toEqual(['공통 설정', '개별 1', '미완료 1']); // old-news failed last time
    expect(subtitleOf(S1)).toBe('#welcome, #general, #questions …'); // sidebar order, first three
    expect(line(S1).querySelector('.dce-chip')?.getAttribute('title')).toBe('목록에 담긴 채널 7개');
    expect(line(S1).querySelector('[title="따로 설정한 채널이 1개 있어요"]')).not.toBeNull();
  });

  it('a whole server says "전체 N개", a server with settings of its own says "서버 설정"', async () => {
    await renderPopup({ scenario: 'tree', expanded: [] });
    expect(chipOf(S2)).toBe('전체 3개');
    expect(line(S2).querySelector('.dce-chip')?.getAttribute('title')).toBe('볼 수 있는 채널을 모두 담았어요 (3개)');
    expect(badgesOf(line(S2))).toEqual(['서버 설정', '개별 1']);
    expect(subtitleOf(S2)).toBe('#announcements, #math, #physics'); // all of them: no ellipsis
  });

  it('a collapsed category line has no channel names; a server that is open has none either', async () => {
    await renderPopup({ scenario: 'tree', expanded: [S1] });
    expect(subtitleOf(S1)).toBeNull();
    expect(subtitleOf(STUDY)).toBeNull();
  });

  it('a server with one queued chat is one line: "[서버 아이콘] 서버 › #채널", the full path in the tooltip, the actions are the chat\'s', async () => {
    await renderPopup({ scenario: 'tree', expanded: [] });
    const reading = row('Book Club › #reading');
    expect(reading.querySelector('.dce-row__label')?.getAttribute('title')).toBe('Book Club › Books › #reading'); // the category is left out of the line, not of the tooltip
    expect(reading.querySelector('.dce-row__crumb-name')?.textContent).toBe('Book Club');
    expect(reading.querySelector('.dce-row__name')?.textContent).toBe('#reading');
    expect(reading.querySelector('.dce-server-icon--fallback')?.textContent).toBe('B');
    expect(reading.getAttribute('data-compressed')).toBe('guild');
    expect(reading.getAttribute('data-depth')).toBe('0');
    expect(badgesOf(reading)).toEqual(['공통 설정']);
    expect(within(reading).getByRole('button', { name: 'Book Club > #reading 다운로드' })).toBeTruthy();
    expect(within(reading).getByRole('button', { name: 'Book Club > #reading 설정' })).toBeTruthy();
    expect(within(reading).getByRole('button', { name: 'Book Club > #reading 목록에서 빼기' })).toBeTruthy();
    expect(groupRows().find((li) => li.dataset.groupId === S3)).toBeUndefined();
  });

  it('a DM is a flat row with the avatar glyph, no path and no group', async () => {
    await renderPopup({ scenario: 'tree', expanded: [] });
    const alex = row('Alex');
    expect(alex.getAttribute('data-depth')).toBe('0');
    expect(alex.getAttribute('data-compressed')).toBeNull();
    expect(alex.querySelector('.dce-row__crumb')).toBeNull();
    expect(alex.querySelector('svg.dce-row__kind')).not.toBeNull();
  });

  it('opening the first server shows its categories and chats in sidebar order, a level in', async () => {
    await renderPopup({ scenario: 'tree', expanded: [S1] });
    const list = screen.getByRole('list', { name: 'Sample Server' });
    const children = Array.from(list.children).map((li) => (li as HTMLElement).dataset.groupId ?? `row:${(li as HTMLElement).dataset.key}`);
    expect(children).toEqual([
      `row:${key(T.welcome)}`, // not in a category, first in the sidebar
      STUDY, // "Study": a whole category (3 of 3)
      `row:${key(T.chat)}`, // "Lounge": one of its two channels: compressed to "Lounge › #chat"
      ARCHIVE, // "Archive": its only channel, so a whole category
      `row:${key(T.weekend)}`, // a thread: below the server, after everything with a place in the sidebar
    ]);
    expect(row('#welcome').getAttribute('data-depth')).toBe('1');
    expect(line(STUDY).getAttribute('style')).toContain('--dce-depth: 1');
    expect(list.getAttribute('style')).toContain('--dce-depth: 1');
  });

  it('a category: folder icon, "전체 N개" when whole, its own badge and "개별 N"; its chats are two levels in', async () => {
    await renderPopup({ scenario: 'tree', expanded: [S1, STUDY] });
    expect(line(STUDY).querySelector('.dce-group__name')?.textContent).toBe('Study');
    expect(line(STUDY).querySelector('svg.dce-row__kind')).not.toBeNull(); // the folder
    expect(line(STUDY).querySelector('.dce-server-icon')).toBeNull();
    expect(chipOf(STUDY)).toBe('전체 3개');
    expect(badgesOf(line(STUDY))).toEqual(['공통 설정', '개별 1']);
    const inside = within(screen.getByRole('list', { name: 'Study' }));
    expect(inside.getAllByRole('listitem').map((li) => li.querySelector('.dce-row__label')?.textContent)).toEqual(['#general', '#questions', '#resources']);
    for (const li of chatRows().filter((candidate) => [key(T.general), key(T.questions), key(T.resources)].includes(candidate.dataset.key ?? ''))) {
      expect(li.getAttribute('data-depth')).toBe('2');
    }
  });

  it('a category with one queued chat out of several is one line "[폴더] 카테고리 › #채널" below the server', async () => {
    await renderPopup({ scenario: 'tree', expanded: [S1] });
    const lounge = row('Lounge › #chat');
    expect(lounge.getAttribute('data-compressed')).toBe('category');
    expect(lounge.getAttribute('data-depth')).toBe('1');
    expect(lounge.querySelector('svg.dce-row__kind')).not.toBeNull();
    expect(lounge.querySelector('.dce-server-icon')).toBeNull();
    expect(lounge.querySelector('.dce-row__label')?.getAttribute('title')).toBe('Sample Server › Lounge › #chat');
  });

  it('a whole category with ONE channel keeps its line ("전체 1개"), and a failed chat inside shows its note', async () => {
    await renderPopup({ scenario: 'tree', expanded: [S1, ARCHIVE] });
    expect(chipOf(ARCHIVE)).toBe('전체 1개');
    const failed = row('Sample Server > #old-news');
    expect(failed.querySelector('.dce-row__failure')?.textContent).toContain('실패 · 이 채널을 볼 권한이 없어요.');
  });

  it('a thread is named with its parent below the server', async () => {
    await renderPopup({ scenario: 'tree', expanded: [S1] });
    const thread = row('Sample Server > #general > weekend plans');
    expect(thread.querySelector('.dce-row__label')?.textContent).toBe('#general > weekend plans');
    expect(thread.getAttribute('data-depth')).toBe('1');
  });

  it('settings badges say where the settings of a chat come from: 개별 / 카테고리 / 서버 / 공통', async () => {
    const { platform } = await renderPopup({ scenario: 'tree', expanded: [S1, STUDY, S2, COURSES] });
    const badge = (label: string): string[] => badgesOf(row(label));
    expect(badge('Sample Server > #questions')).toEqual(['개별 설정']);
    expect(badge('Sample Server > #general')).toEqual(['공통 설정']);
    expect(badge('Study Group > #announcements')).toEqual(['서버 설정']);
    expect(badge('Study Group > #math')).toEqual(['개별 설정']);
    expect(badge('Study Group > #physics')).toEqual(['서버 설정']);
    // a category of its own settings: its chats say "카테고리 설정"
    const current = platform.read('local', LOCAL.groupSettings(MOCK_ACCOUNT.id)) as Record<string, unknown>;
    await act(async () => {
      platform.write('local', { [LOCAL.groupSettings(MOCK_ACCOUNT.id)]: { ...current, [COURSES]: { count: 7 } } });
    });
    await settle();
    expect(badge('Study Group > #physics')).toEqual(['카테고리 설정']);
    expect(badge('Study Group > #announcements')).toEqual(['서버 설정']);
    expect(badgesOf(line(COURSES))).toEqual(['카테고리 설정', '개별 1']);
    expect(badgesOf(line(S2))).toEqual(['서버 설정', '개별 1']);
  });

  it('a category without settings of its own shows what its chats really follow: the server\'s settings', async () => {
    await renderPopup({ scenario: 'tree', expanded: [S2] });
    expect(badgesOf(line(COURSES))).toEqual(['서버 설정', '개별 1']);
  });

  it('the summary of a chat is its EFFECTIVE settings (the server\'s here)', async () => {
    await renderPopup({ scenario: 'tree', expanded: [S2, COURSES] });
    expect(row('Study Group > #physics').querySelector('.dce-row__summary')?.textContent).toBe('50개 · MD · 기간 없음 · 첨부');
    expect(row('Study Group > #math').querySelector('.dce-row__summary')?.textContent).toBe('20개 · MD · 기간 없음');
  });

  it('a group with settings of its own keeps its line even with one chat; without them it becomes one line again', async () => {
    const { platform } = await renderPopup({
      scenario: 'tree',
      expanded: [],
      prepare: (mock) => {
        const queue = (mock.read('local', LOCAL.queue(MOCK_ACCOUNT.id)) as QueueItem[]).filter((item) => item.target.guildId !== S1 || item.key === key(T.welcome));
        mock.write('local', { [LOCAL.queue(MOCK_ACCOUNT.id)]: queue, [LOCAL.groupSettings(MOCK_ACCOUNT.id)]: { [S1]: { count: 9 } } });
      },
    });
    expect(chipOf(S1)).toBe('1개');
    expect(badgesOf(line(S1))).toEqual(['서버 설정']);
    await act(async () => {
      platform.write('local', { [LOCAL.groupSettings(MOCK_ACCOUNT.id)]: {} });
    });
    await settle();
    expect(groupRows().find((li) => li.dataset.groupId === S1)).toBeUndefined();
    expect(row('Sample Server › #welcome')).toBeTruthy();
  });

  it('follows the list live: taking chats out turns a group into one line, adding one turns it back', async () => {
    const { platform } = await renderPopup();
    expect(groupRows()).toHaveLength(1); // "Sample Server": 3 chats
    fireEvent.click(within(row('Sample Server > #announcements')).getByRole('button', { name: /목록에서 빼기$/ }));
    await settle();
    fireEvent.click(within(row('Sample Server > #general > weekend plans')).getByRole('button', { name: /목록에서 빼기$/ }));
    await settle();
    expect(groupRows()).toHaveLength(0);
    expect(row('Sample Server › #general')).toBeTruthy();
    await act(async () => {
      await platform.sendMessage({ to: 'bg', type: 'queue/toggle', target: { kind: 'guild-channel', channelId: 'new', guildId: S1, guildName: 'Sample Server', channelName: 'extra' } });
    });
    await settle();
    expect(groupRows()).toHaveLength(1);
  });
});

describe('server icons', () => {
  it('a CDN icon is an <img> that is lazy and sends no referrer; the other servers show their first letter', async () => {
    await renderPopup({ scenario: 'tree', expanded: [] });
    const icon = line(S1).querySelector('img.dce-server-icon') as HTMLImageElement;
    expect(icon.getAttribute('src')).toBe(ICON);
    expect(icon.getAttribute('loading')).toBe('lazy');
    expect(icon.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(icon.getAttribute('alt')).toBe('');
    expect(line(S2).querySelector('img')).toBeNull();
    expect(line(S2).querySelector('.dce-server-icon--fallback')?.textContent).toBe('S');
  });

  it('an icon that cannot be loaded becomes the lettered circle', async () => {
    await renderPopup({ scenario: 'tree', expanded: [] });
    fireEvent.error(line(S1).querySelector('img.dce-server-icon') as HTMLImageElement);
    await settle();
    expect(line(S1).querySelector('img')).toBeNull();
    expect(line(S1).querySelector('.dce-server-icon--fallback')?.textContent).toBe('S');
  });

  it('only https://cdn.discordapp.com addresses are rendered', async () => {
    const withIcon = (iconUrl: string | null) => async (): Promise<void> => {
      await renderPopup({
        scenario: 'tree',
        expanded: [],
        prepare: (mock) => {
          const groups = mock.read('local', LOCAL.groups(MOCK_ACCOUNT.id)) as Record<string, GroupInfo>;
          mock.write('local', { [LOCAL.groups(MOCK_ACCOUNT.id)]: { ...groups, [S1]: { ...groups[S1], iconUrl } } });
        },
      });
    };
    for (const bad of ['http://cdn.discordapp.com/icons/1/a.png', 'https://tracker.example/pixel.png', 'https://media.discordapp.net/icons/1/a.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)']) {
      await withIcon(bad)();
      expect(line(S1).querySelector('img'), bad).toBeNull();
      expect(line(S1).querySelector('.dce-server-icon--fallback')).not.toBeNull();
      cleanup();
    }
    await withIcon(null)();
    expect(line(S1).querySelector('img')).toBeNull();
  });

  it('a new icon after a failed one is tried again', async () => {
    const { platform } = await renderPopup({ scenario: 'tree', expanded: [] });
    fireEvent.error(line(S1).querySelector('img.dce-server-icon') as HTMLImageElement);
    await settle();
    expect(line(S1).querySelector('img')).toBeNull();
    const groups = platform.read('local', LOCAL.groups(MOCK_ACCOUNT.id)) as Record<string, GroupInfo>;
    await act(async () => {
      platform.write('local', { [LOCAL.groups(MOCK_ACCOUNT.id)]: { ...groups, [S1]: { ...groups[S1], iconUrl: `https://cdn.discordapp.com/icons/${S1}/fresh.png?size=64` } } });
    });
    await settle();
    expect(line(S1).querySelector('img')?.getAttribute('src')).toContain('fresh.png');
  });
});

describe('opening and closing groups', () => {
  it('a click on the line toggles it: ▸ becomes ▾ (aria-expanded) and the chats appear and go', async () => {
    await renderPopup({ scenario: 'tree', expanded: [] });
    const toggle = toggleOf(S1);
    expect(screen.queryByText('#welcome')).toBeNull();
    fireEvent.click(toggle);
    await settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(screen.getByRole('list', { name: 'Sample Server' }).id);
    expect(row('#welcome')).toBeTruthy();
    expect(group(S1).querySelector('.dce-group')?.hasAttribute('data-expanded')).toBe(true);
    fireEvent.click(toggle);
    await settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
    expect(() => row('#welcome')).toThrow();
  });

  it('a category opens inside an open server independently', async () => {
    await renderPopup({ scenario: 'tree', expanded: [S1] });
    fireEvent.click(toggleOf(STUDY));
    await settle();
    expect(chatRows().map((li) => li.dataset.key)).toEqual(expect.arrayContaining([key(T.general), key(T.questions), key(T.resources)]));
    expect(toggleOf(ARCHIVE).getAttribute('aria-expanded')).toBe('false');
  });

  it('closing a server keeps what was open inside it (it is there again when the server opens)', async () => {
    await renderPopup({ scenario: 'tree', expanded: [S1, STUDY] });
    fireEvent.click(toggleOf(S1));
    await settle();
    fireEvent.click(toggleOf(S1));
    await settle();
    expect(toggleOf(STUDY).getAttribute('aria-expanded')).toBe('true');
  });

  it('the toggle is a real button (Enter and Space work natively), named after the group, and keeps the focus when it is pressed', async () => {
    await renderPopup({ scenario: 'tree', expanded: [] });
    const toggle = toggleOf(S1);
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('type')).toBe('button');
    expect(screen.getByRole('button', { name: 'Sample Server', expanded: false })).toBe(toggle);
    toggle.focus();
    fireEvent.click(toggle);
    await settle();
    expect(document.activeElement).toBe(toggleOf(S1)); // not re-created: the focus stays
    expect(screen.getByRole('button', { name: 'Sample Server', expanded: true })).toBe(toggle);
  });

  it('the toggle is named by the group and described by what the line says (count, settings, overrides)', async () => {
    await renderPopup({ scenario: 'tree', expanded: [] });
    const described = (toggleOf(S1).getAttribute('aria-describedby') ?? '').split(' ');
    expect(described).toHaveLength(2);
    const text = described.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(text).toContain('7개');
    expect(text).toContain('공통 설정');
    expect(text).toContain('개별 1');
  });

  it('keyboard focus is visible on the toggle and on the actions (a ring, not hidden by the scrolling list)', () => {
    expect(popupCss).toMatch(/\.dce-group__main:focus-visible\s*\{[^}]*outline-offset:\s*-2px/);
  });

  it('every choice is kept in LOCAL.uiExpanded, and a new popup opens the same groups', async () => {
    const { platform, unmount } = await renderPopup({ scenario: 'tree', expanded: [] });
    fireEvent.click(toggleOf(S1));
    await settle();
    fireEvent.click(toggleOf(STUDY));
    await settle();
    expect(platform.read('local', LOCAL.uiExpanded)).toEqual([S1, STUDY]);
    expect(sentMessages(platform)).toEqual([]); // no message to the background for it
    unmount();
    render(<PopupRoot platform={platform} pollMs={600_000} />);
    await settle();
    await settle();
    expect(toggleOf(S1).getAttribute('aria-expanded')).toBe('true');
    expect(toggleOf(STUDY).getAttribute('aria-expanded')).toBe('true');
    expect(toggleOf(S2).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggleOf(S1));
    await settle();
    expect(platform.read('local', LOCAL.uiExpanded)).toEqual([STUDY]);
  });

  it('a malformed LOCAL.uiExpanded opens nothing', async () => {
    for (const junk of ['x', 5, { a: 1 }, [1, null, {}]]) {
      await renderPopup({ scenario: 'tree', expanded: [], prepare: (mock) => mock.write('local', { [LOCAL.uiExpanded]: junk }) });
      expect(toggleOf(S1).getAttribute('aria-expanded'), JSON.stringify(junk)).toBe('false');
      cleanup();
    }
  });

  it('another window that opens a group is followed', async () => {
    const { platform } = await renderPopup({ scenario: 'tree', expanded: [] });
    await act(async () => {
      platform.write('local', { [LOCAL.uiExpanded]: [S2] });
    });
    await settle();
    expect(toggleOf(S2).getAttribute('aria-expanded')).toBe('true');
  });
});

describe('the actions of a group line (docs/PLAN.md §7.2a)', () => {
  const S1_KEYS = [T.welcome, T.general, T.questions, T.resources, T.chat, T.oldNews, T.weekend].map(key);

  it('every line has ▶ ⚙ ✕ named after the group', async () => {
    await renderPopup({ scenario: 'tree', expanded: [] });
    const actions = within(line(S1));
    expect(actions.getByRole('button', { name: 'Sample Server 채널 다운로드' })).toBeTruthy();
    expect(actions.getByRole('button', { name: 'Sample Server 설정' })).toBeTruthy();
    expect(actions.getByRole('button', { name: 'Sample Server 채널 목록에서 빼기' })).toBeTruthy();
  });

  it('▶ of a server: job/start with the keys of its chats, in the order they are shown', async () => {
    const { platform } = await renderPopup({ scenario: 'tree', expanded: [] });
    fireEvent.click(within(line(S1)).getByRole('button', { name: 'Sample Server 채널 다운로드' }));
    await settle();
    expect(sentMessages(platform, 'job/start')).toEqual([{ to: 'bg', type: 'job/start', keys: S1_KEYS }]);
  });

  it('▶ of a category: only the chats of that category', async () => {
    const { platform } = await renderPopup({ scenario: 'tree', expanded: [S1] });
    fireEvent.click(within(line(STUDY)).getByRole('button', { name: 'Study 채널 다운로드' }));
    await settle();
    expect(sentMessages(platform, 'job/start')).toEqual([{ to: 'bg', type: 'job/start', keys: [key(T.general), key(T.questions), key(T.resources)] }]);
  });

  it('▶ of a one-line row is the chat\'s own: job/start with its key only', async () => {
    const category = await renderPopup({ scenario: 'tree', expanded: [S1] });
    fireEvent.click(within(row('Lounge › #chat')).getByRole('button', { name: 'Sample Server > #chat 다운로드' }));
    await settle();
    expect(sentMessages(category.platform, 'job/start')).toEqual([{ to: 'bg', type: 'job/start', keys: [key(T.chat)] }]);
    cleanup();
    const server = await renderPopup({ scenario: 'tree', expanded: [] });
    fireEvent.click(within(row('Book Club › #reading')).getByRole('button', { name: 'Book Club > #reading 다운로드' }));
    await settle();
    expect(sentMessages(server.platform, 'job/start')).toEqual([{ to: 'bg', type: 'job/start', keys: [key(T.reading)] }]);
  });

  it('⚙ and ✕ of a one-line row are the chat\'s too: its own settings screen, queue/remove (not removeMany)', async () => {
    const { platform } = await renderPopup({ scenario: 'tree', expanded: [] });
    fireEvent.click(within(row('Book Club › #reading')).getByRole('button', { name: 'Book Club > #reading 목록에서 빼기' }));
    await settle();
    expect(sentMessages(platform, 'queue/remove')).toEqual([{ to: 'bg', type: 'queue/remove', key: key(T.reading) }]);
    expect(sentMessages(platform, 'queue/removeMany')).toEqual([]);
    cleanup();
    await renderPopup({ scenario: 'tree', expanded: [] });
    fireEvent.click(within(row('Book Club › #reading')).getByRole('button', { name: 'Book Club > #reading 설정' }));
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: '채팅 설정' })).toBeTruthy();
    expect(document.querySelector('.dce-viewheader__subtitle')?.textContent).toBe('Book Club > #reading');
  });

  it('⚙ of a server opens its settings screen; of a category its own', async () => {
    await renderPopup({ scenario: 'tree', expanded: [S1] });
    fireEvent.click(within(line(S1)).getByRole('button', { name: 'Sample Server 설정' }));
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: '서버 설정 · Sample Server' })).toBeTruthy();
    fireEvent.click(button('뒤로'));
    await settle();
    fireEvent.click(within(line(STUDY)).getByRole('button', { name: 'Study 설정' }));
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: '카테고리 설정 · Study' })).toBeTruthy();
  });

  it('✕ asks first ("채널 N개를 목록에서 뺄까요?"); nothing is sent until the user confirms, and the focus is on the safe choice', async () => {
    const { platform } = await renderPopup({ scenario: 'tree', expanded: [] });
    fireEvent.click(within(line(S1)).getByRole('button', { name: 'Sample Server 채널 목록에서 빼기' }));
    const question = within(group(S1)).getByRole('group', { name: '채널 7개를 목록에서 뺄까요?' });
    expect(within(question).getByText('채널 7개를 목록에서 뺄까요?')).toBeTruthy();
    expect(within(question).getByRole('button', { name: '빼기' })).toBeTruthy();
    expect(document.activeElement).toBe(within(question).getByRole('button', { name: '취소' }));
    expect(sentMessages(platform)).toEqual([]);
    expect((within(line(S1)).getByRole('button', { name: 'Sample Server 채널 목록에서 빼기' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('[취소] and Escape put everything back, send nothing, and give the focus back to ✕', async () => {
    const { platform } = await renderPopup({ scenario: 'tree', expanded: [] });
    const remove = (): HTMLElement => within(line(S1)).getByRole('button', { name: 'Sample Server 채널 목록에서 빼기' });
    fireEvent.click(remove());
    fireEvent.click(within(group(S1)).getByRole('button', { name: '취소' }));
    await settle();
    expect(within(group(S1)).queryByRole('group', { name: '채널 7개를 목록에서 뺄까요?' })).toBeNull();
    expect(document.activeElement).toBe(remove());
    fireEvent.click(remove());
    fireEvent.keyDown(within(group(S1)).getByRole('button', { name: '취소' }), { key: 'Escape' });
    await settle();
    expect(within(group(S1)).queryByRole('group', { name: '채널 7개를 목록에서 뺄까요?' })).toBeNull();
    expect(sentMessages(platform)).toEqual([]);
    expect(chipOf(S1)).toBe('7개');
  });

  it('[빼기]: queue/removeMany with the keys of the group, and the group is gone', async () => {
    const { platform } = await renderPopup({ scenario: 'tree', expanded: [] });
    fireEvent.click(within(line(S1)).getByRole('button', { name: 'Sample Server 채널 목록에서 빼기' }));
    fireEvent.click(within(group(S1)).getByRole('button', { name: '빼기' }));
    await settle();
    expect(sentMessages(platform, 'queue/removeMany')).toEqual([{ to: 'bg', type: 'queue/removeMany', keys: S1_KEYS }]);
    expect(groupRows().find((li) => li.dataset.groupId === S1)).toBeUndefined();
    const stored = platform.read('local', LOCAL.queue(MOCK_ACCOUNT.id)) as QueueItem[];
    expect(stored.every((item) => item.target.guildId !== S1)).toBe(true);
    expect(topLevel()).toEqual([`row:${key(T.dm)}`, `row:${key(T.reading)}`, S2]);
  });

  it('✕ of a category takes out its chats only; the server line stays with the rest', async () => {
    const { platform } = await renderPopup({ scenario: 'tree', expanded: [S1] });
    fireEvent.click(within(line(STUDY)).getByRole('button', { name: 'Study 채널 목록에서 빼기' }));
    expect(within(group(STUDY)).getByRole('group', { name: '채널 3개를 목록에서 뺄까요?' })).toBeTruthy();
    fireEvent.click(within(group(STUDY)).getByRole('button', { name: '빼기' }));
    await settle();
    expect(sentMessages(platform, 'queue/removeMany')).toEqual([{ to: 'bg', type: 'queue/removeMany', keys: [key(T.general), key(T.questions), key(T.resources)] }]);
    expect(chipOf(S1)).toBe('4개');
  });

  it('a refusal keeps the list and shows the message; the question is closed', async () => {
    const { platform } = await renderPopup({ scenario: 'tree', expanded: [], prepare: (mock) => mock.failNext('queue/removeMany', 'unknown', 'storage is full') });
    fireEvent.click(within(line(S1)).getByRole('button', { name: 'Sample Server 채널 목록에서 빼기' }));
    fireEvent.click(within(group(S1)).getByRole('button', { name: '빼기' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('(storage is full)');
    expect(chipOf(S1)).toBe('7개');
    expect(platform.read('local', LOCAL.queue(MOCK_ACCOUNT.id))).toHaveLength(12);
  });

  it('after a group is removed the focus goes to the ✕ of the next row, else of the previous one', async () => {
    await renderPopup({ scenario: 'tree', expanded: [] });
    const remove = within(line(S1)).getByRole('button', { name: 'Sample Server 채널 목록에서 빼기' });
    remove.focus();
    fireEvent.click(remove);
    fireEvent.click(within(group(S1)).getByRole('button', { name: '빼기' }));
    await settle();
    expect(document.activeElement).toBe(within(row('Alex')).getByRole('button', { name: /목록에서 빼기$/ }));
  });

  it('removing the last group puts the focus on the previous row\'s ✕', async () => {
    await renderPopup({ scenario: 'tree', expanded: [] });
    const remove = within(line(S2)).getByRole('button', { name: 'Study Group 채널 목록에서 빼기' });
    remove.focus();
    fireEvent.click(remove);
    fireEvent.click(within(group(S2)).getByRole('button', { name: '빼기' }));
    await settle();
    expect(document.activeElement).toBe(within(row('Book Club › #reading')).getByRole('button', { name: /목록에서 빼기$/ }));
  });

  it('removing the children of an open group does not count them as neighbours', async () => {
    await renderPopup({ scenario: 'tree', expanded: [S1, STUDY] });
    const remove = within(line(STUDY)).getByRole('button', { name: 'Study 채널 목록에서 빼기' });
    remove.focus();
    fireEvent.click(remove);
    fireEvent.click(within(group(STUDY)).getByRole('button', { name: '빼기' }));
    await settle();
    // the next row after the category is the one-line "Lounge › #chat"
    expect(document.activeElement).toBe(within(row('Lounge › #chat')).getByRole('button', { name: /목록에서 빼기$/ }));
  });

  it('while a download runs ▶ of a group is off (and says why); ⚙ and ✕ still work', async () => {
    const { platform } = await renderPopup({ scenario: 'running', expanded: [] });
    const start = within(line(S1)).getByRole('button', { name: 'Sample Server 채널 다운로드' });
    expect(start.getAttribute('aria-disabled')).toBe('true');
    expect(start.getAttribute('title')).toBe('다운로드가 진행 중이에요');
    fireEvent.click(start);
    await settle();
    expect(sentMessages(platform, 'job/start')).toEqual([]);
    expect(within(line(S1)).getByRole('button', { name: 'Sample Server 설정' }).getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(within(line(S1)).getByRole('button', { name: 'Sample Server 채널 목록에서 빼기' }));
    expect(within(group(S1)).getByRole('group', { name: /뺄까요/ })).toBeTruthy();
  });
});

describe('progress of a running download on the group lines', () => {
  it('a group line shows the progress of the chats inside it: finished/total and a bar, a chat that is done and gone from the list included', async () => {
    await renderPopup({ scenario: 'running', expanded: [] });
    // "Sample Server": the thread is done (already out of the list: only the history knows it), general running (120 of 200), announcements waiting
    const progress = line(S1).querySelector('.dce-group__progress') as HTMLElement;
    const bar = within(progress).getByRole('progressbar', { name: 'Sample Server 진행률' });
    expect(bar.getAttribute('aria-valuenow')).toBe('53'); // (1 + 0.6 + 0) / 3
    expect(bar.getAttribute('aria-valuetext')).toBe('1/3');
    expect(within(progress).getByText('1/3')).toBeTruthy();
  });

  it('the chats inside show their own progress when the group is open, and the one-line rows theirs', async () => {
    await renderPopup({ scenario: 'running', expanded: [S1] });
    expect(within(row('Sample Server > #general')).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('60');
    expect(within(row('Alex')).getByText('대기 중')).toBeTruthy();
    expect(row('Study Group › #questions').querySelector('.dce-row__progress')).toBeNull(); // not part of the job
  });

  /** What the background does when a chat is done: it leaves the list and enters the history (one write), and the job row says "done". */
  async function finishLikeTheBackground(platform: Awaited<ReturnType<typeof renderPopup>>['platform'], target: { channelId: string }): Promise<void> {
    const job = platform.read('session', SESSION.job) as JobState;
    const queue = platform.read('local', LOCAL.queue(MOCK_ACCOUNT.id)) as QueueItem[];
    const history = platform.read('local', LOCAL.history(MOCK_ACCOUNT.id)) as HistoryEntry[];
    const done = queue.find((item) => item.key === target.channelId);
    if (done === undefined) throw new Error('not in the list');
    const entry: HistoryEntry = {
      id: `history-done-${target.channelId}`,
      accountId: MOCK_ACCOUNT.id,
      target: done.target,
      settings: DEFAULT_EXPORT_SETTINGS,
      finishedAt: job.startedAt + 30_000,
      status: 'done',
      messageCount: 200,
      files: [],
      error: null,
    };
    await act(async () => {
      platform.write('local', { [LOCAL.queue(MOCK_ACCOUNT.id)]: queue.filter((item) => item.key !== target.channelId), [LOCAL.history(MOCK_ACCOUNT.id)]: [entry, ...history] });
      platform.write('session', {
        [SESSION.job]: { ...job, items: job.items.map((item) => (item.key === target.channelId ? { ...item, status: 'done' as const, phase: 'saving' as const, fetched: 200 } : item)) },
      });
    });
    await settle();
  }

  it('follows the job the way the background runs it: a chat that is done leaves the list, the group still counts it (the bar never falls back)', async () => {
    const { platform } = await renderPopup({ scenario: 'running', expanded: [] });
    await finishLikeTheBackground(platform, MOCK_TARGETS.general);
    expect(chipOf(S1)).toBe('1개'); // only "announcements" is left in the list ...
    const bar = within(line(S1)).getByRole('progressbar', { name: 'Sample Server 진행률' });
    expect(bar.getAttribute('aria-valuetext')).toBe('2/3'); // ... and the group still says: 2 of its 3 chats are done
    expect(bar.getAttribute('aria-valuenow')).toBe('67');
  });

  it('a group that lost chats to the running job does not shrink to the line of its last chat: the aggregate stays', async () => {
    const { platform } = await renderPopup({ scenario: 'running', expanded: [S1] });
    await finishLikeTheBackground(platform, MOCK_TARGETS.general);
    expect(groupRows().some((li) => li.dataset.groupId === S1)).toBe(true); // one chat left, but not one line "Sample Server › #announcements"
    expect(() => row('Sample Server › #announcements')).toThrow();
    expect(row('Sample Server > #announcements').getAttribute('data-depth')).toBe('1');
    expect(within(line(S1)).getByRole('progressbar', { name: 'Sample Server 진행률' })).toBeTruthy();
  });

  it('no job, no group progress; an ended job leaves none on the group lines either', async () => {
    await renderPopup({ scenario: 'tree', expanded: [] });
    expect(document.querySelector('.dce-group__progress')).toBeNull();
    cleanup();
    const { platform } = await renderPopup({ scenario: 'running', expanded: [] });
    const job = platform.read('session', SESSION.job) as JobState;
    await act(async () => {
      platform.write('session', { [SESSION.job]: { ...job, state: 'done', finishedAt: Date.now() } });
    });
    await settle();
    expect(document.querySelector('.dce-group__progress')).toBeNull();
  });
});

describe('failures are visible on a collapsed group', () => {
  it('a server or category line says how many of its chats did not finish; one without failures says nothing', async () => {
    await renderPopup({ scenario: 'tree', expanded: [S1] });
    // "old-news" (Archive, a whole category of one chat) failed last time
    expect(badgesOf(line(S1))).toContain('미완료 1');
    expect(badgesOf(line(ARCHIVE))).toEqual(['공통 설정', '미완료 1']);
    expect(line(S1).querySelector('[title="끝까지 받지 못한 채널이 1개 있어요. 펼쳐서 다시 시도할 수 있어요"]')?.textContent).toBe('미완료 1');
    expect(line(S1).querySelector('.dce-badge--danger')?.textContent).toBe('미완료 1');
    expect(badgesOf(line(STUDY)).join()).not.toContain('미완료');
    expect(badgesOf(line(S2)).join()).not.toContain('미완료');
  });

  it('opening the group shows the reason and [재시도] of the failed chat', async () => {
    await renderPopup({ scenario: 'tree', expanded: [] });
    expect(line(S1).textContent).toContain('미완료 1');
    fireEvent.click(toggleOf(S1));
    fireEvent.click(toggleOf(ARCHIVE));
    const failed = row('Sample Server > #old-news');
    expect(failed.querySelector('.dce-row__failure')?.textContent).toContain('이 채널을 볼 권한이 없어요.');
    expect(within(failed).getByRole('button', { name: 'Sample Server > #old-news 다시 시도' })).toBeTruthy();
  });

  it('a chat that is part of the running job shows its progress, not the old failure: the chip goes away, and comes back if it fails again', async () => {
    const { platform } = await renderPopup({ scenario: 'tree', expanded: [] });
    expect(badgesOf(line(S1))).toContain('미완료 1');
    const old = { key: key(T.oldNews), label: 'Sample Server > #old-news', status: 'running' as const, phase: 'messages' as const, fetched: 5, expected: 50, error: null, files: [] };
    const job: JobState = { jobId: 'j', accountId: MOCK_ACCOUNT.id, startedAt: Date.now() - 1000, finishedAt: null, state: 'running', pausedReason: null, zip: false, items: [old] };
    await act(async () => {
      platform.write('session', { [SESSION.job]: job });
    });
    await settle();
    expect(badgesOf(line(S1)).join()).not.toContain('미완료');
    await act(async () => {
      platform.write('session', { [SESSION.job]: { ...job, state: 'done', finishedAt: Date.now(), items: [{ ...old, status: 'failed', error: { kind: 'network', message: 'offline' } }] } });
    });
    await settle();
    expect(badgesOf(line(S1))).toContain('미완료 1'); // it failed again
  });
});

describe('English', () => {
  it('the lines, chips, badges and actions', async () => {
    await renderPopup({ scenario: 'tree', expanded: [], settings: { language: 'en' } });
    expect(chipOf(S1)).toBe('7 chats');
    expect(chipOf(S2)).toBe('All 3');
    expect(badgesOf(line(S1))).toEqual(['Common settings', '1 own', '1 unfinished']);
    expect(badgesOf(line(S2))).toEqual(['Server settings', '1 own']);
    expect(within(line(S1)).getByRole('button', { name: 'Download the chats of Sample Server' })).toBeTruthy();
    expect(within(line(S1)).getByRole('button', { name: 'Settings of Sample Server' })).toBeTruthy();
    fireEvent.click(within(line(S1)).getByRole('button', { name: 'Remove the chats of Sample Server from the list' }));
    expect(within(group(S1)).getByRole('group', { name: 'Remove 7 chats from the list?' })).toBeTruthy();
    expect(within(group(S1)).getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it('the badges of the chats', async () => {
    await renderPopup({ scenario: 'tree', expanded: [S1, STUDY, S2, COURSES], settings: { language: 'en' } });
    expect(badgesOf(row('Study Group > #physics'))).toEqual(['Server settings']);
    expect(badgesOf(row('Sample Server > #questions'))).toEqual(['Own settings']);
    expect(badgesOf(row('Sample Server > #general'))).toEqual(['Common settings']);
  });
});

describe('unknown group information', () => {
  it('without LOCAL.groups the tree still works: names from the chats, no icon, never "전체", ordered by the time they were added', async () => {
    await renderPopup({ expanded: [] });
    // the "idle" scenario records no groups: "Sample Server" (3 chats), "Study Group" (one forum), a DM
    expect(topLevel().map((id) => (id.startsWith('row:') ? 'row' : id))).toEqual([S1, 'row', 'row']);
    expect(line(S1).querySelector('.dce-group__name')?.textContent).toBe('Sample Server');
    expect(chipOf(S1)).toBe('3개');
    expect(line(S1).querySelector('.dce-server-icon--fallback')?.textContent).toBe('S');
  });

  it('no name anywhere: the fallback "서버" / "카테고리"', async () => {
    await renderPopup({
      scenario: 'empty',
      expanded: [],
      prepare: (mock) => {
        const target = (n: string) => ({ kind: 'guild-channel' as const, channelId: n, guildId: 'nameless', guildName: null, channelName: `c${n}`, parentId: null, parentName: null });
        mock.write('local', {
          [LOCAL.queue(MOCK_ACCOUNT.id)]: [1, 2].map((n) => ({ key: `${n}`, target: target(`${n}`), settings: null, addedAt: n })),
        });
      },
    });
    expect(line('nameless').querySelector('.dce-group__name')?.textContent).toBe('서버');
  });
});
