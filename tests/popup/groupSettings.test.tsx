// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_SETTINGS, LOCAL, type ExportSettings, type QueueItem } from '@/shared';
import { MOCK_ACCOUNT, MOCK_CATEGORIES, MOCK_GUILDS, TREE_TARGETS } from '@/ui/platform/mock';
import { button, groupRows, renderPopup, row, sentMessages, settle } from './helpers';

afterEach(cleanup); // vitest globals are off, so testing-library cannot register its own cleanup

const S1 = MOCK_GUILDS.sample.id;
const S2 = MOCK_GUILDS.study.id;
const STUDY = MOCK_CATEGORIES.study.id;
const COURSES = MOCK_CATEGORIES.courses.id;
const LOUNGE = MOCK_CATEGORIES.lounge.id;
const ARCHIVE = MOCK_CATEGORIES.archive.id;
const T = TREE_TARGETS;
const ACCOUNT = MOCK_ACCOUNT.id;
const key = (target: { channelId: string }): string => target.channelId;

const line = (id: string): HTMLElement => {
  const li = groupRows().find((candidate) => candidate.dataset.groupId === id);
  if (li === undefined) throw new Error(`no group line for ${id}`);
  return li.querySelector('.dce-group') as HTMLElement;
};
const badgesOf = (element: HTMLElement): string[] => Array.from(element.querySelectorAll('.dce-badge')).map((badge) => badge.textContent ?? '');
const settingsOf = (platform: Awaited<ReturnType<typeof renderPopup>>['platform']): Record<string, ExportSettings> =>
  (platform.read('local', LOCAL.groupSettings(ACCOUNT)) as Record<string, ExportSettings> | undefined) ?? {};
const queueOf = (platform: Awaited<ReturnType<typeof renderPopup>>['platform']): QueueItem[] => platform.read('local', LOCAL.queue(ACCOUNT)) as QueueItem[];
const itemOf = (platform: Awaited<ReturnType<typeof renderPopup>>['platform'], target: { channelId: string }): QueueItem => queueOf(platform).find((item) => item.key === key(target))!;

const openGroup = async (id: string, name: string): Promise<void> => {
  fireEvent.click(within(line(id)).getByRole('button', { name: `${name} 설정` }));
  await settle();
};
const countInput = (): HTMLInputElement => screen.getByRole('spinbutton', { name: '내보낼 메시지 개수' }) as HTMLInputElement;
const radio = (name: string | RegExp): HTMLElement => screen.getByRole('radio', { name });
const defaults = (patch: Partial<ExportSettings> = {}): ExportSettings => ({ ...DEFAULT_EXPORT_SETTINGS, content: { ...DEFAULT_EXPORT_SETTINGS.content }, ...patch });
const notice = (): HTMLElement | null => document.querySelector('[data-group-overrides]');

/** The tree scenario with the groups that the tests open already open. */
const tree = (options: Parameters<typeof renderPopup>[0] = {}) => renderPopup({ scenario: 'tree', expanded: [S1, STUDY, S2], ...options });

describe('the settings screen of a server or category (docs/PLAN.md §7.2a)', () => {
  it('a server: "서버 설정 · 이름", "채널 N개에 적용돼요", the focus on the title', async () => {
    await tree();
    await openGroup(S1, 'Sample Server');
    const heading = screen.getByRole('heading', { level: 1, name: '서버 설정 · Sample Server' });
    expect(heading).toBeTruthy();
    expect(document.querySelector('.dce-viewheader__subtitle')?.textContent).toBe('채널 7개에 적용돼요');
    expect(document.activeElement).toBe(heading);
    expect(document.querySelector('.dce-view--main')).toBeNull();
  });

  it('a category: "카테고리 설정 · 이름" and the number of ITS chats', async () => {
    await tree();
    await openGroup(STUDY, 'Study');
    expect(screen.getByRole('heading', { level: 1, name: '카테고리 설정 · Study' })).toBeTruthy();
    expect(document.querySelector('.dce-viewheader__subtitle')?.textContent).toBe('채널 3개에 적용돼요');
  });

  it('is the panel of a chat\'s own settings: the same fields, no language and no ZIP option', async () => {
    await tree();
    await openGroup(S1, 'Sample Server');
    expect(document.querySelector('[data-variant="item"]')).not.toBeNull();
    expect(screen.getByRole('radiogroup', { name: '형식' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: '메시지 개수' })).toBeTruthy();
    expect(screen.getByLabelText('시작일')).toBeTruthy();
    expect(screen.getByRole('button', { name: '더보기' })).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: '언어' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'ZIP 하나로 받기' })).toBeNull();
  });

  describe('is filled with what the chats of the group follow now', () => {
    it('a server without settings of its own: the common settings', async () => {
      await tree();
      await openGroup(S1, 'Sample Server');
      expect(radio(/^HTML/).getAttribute('aria-checked')).toBe('true');
      expect(countInput().value).toBe('200');
      expect(screen.getByText('저장하면 지금 담겨 있는 채널과 앞으로 담는 채널이 모두 이 설정을 따라가요.')).toBeTruthy();
    });

    it('a server with settings of its own: those', async () => {
      await tree();
      await openGroup(S2, 'Study Group');
      expect(radio(/^Markdown/).getAttribute('aria-checked')).toBe('true');
      expect(countInput().value).toBe('50');
      expect((screen.getByRole('checkbox', { name: '첨부파일 함께 저장' }) as HTMLInputElement).checked).toBe(true);
      expect(screen.getByText('따로 정한 설정을 쓰고 있어요. 저장하면 아래 채널 전부에 한 번에 적용돼요.')).toBeTruthy();
    });

    it('a category without settings of its own: its server\'s', async () => {
      await tree();
      await openGroup(COURSES, 'Courses');
      expect(radio(/^Markdown/).getAttribute('aria-checked')).toBe('true');
      expect(countInput().value).toBe('50');
    });

    it('a category with settings of its own: those', async () => {
      await renderPopup({
        scenario: 'tree',
        expanded: [S2],
        prepare: (mock) => mock.write('local', { [LOCAL.groupSettings(ACCOUNT)]: { ...settingsOfRaw(mock), [COURSES]: defaults({ count: 7, format: 'csv' }) } }),
      });
      await openGroup(COURSES, 'Courses');
      expect(radio(/^CSV/).getAttribute('aria-checked')).toBe('true');
      expect(countInput().value).toBe('7');
    });

    it('the common settings it started from are not replaced while the editor is open', async () => {
      const { platform } = await tree();
      await openGroup(S1, 'Sample Server');
      await act(async () => {
        await platform.sendMessage({ to: 'bg', type: 'settings/patch', patch: { common: defaults({ count: 5 }) } });
      });
      await settle();
      expect(countInput().value).toBe('200');
    });
  });

  describe('"아래 개별 설정 M개가 이 설정으로 바뀌어요" before saving', () => {
    it('a server: the chats below that have settings of their own', async () => {
      await tree();
      await openGroup(S1, 'Sample Server');
      expect(notice()?.textContent).toBe('아래 개별 설정 1개가 이 설정으로 바뀌어요'); // "questions"
      expect(notice()?.getAttribute('role')).toBe('status');
    });

    it('a server: the settings of its categories count too', async () => {
      await renderPopup({
        scenario: 'tree',
        expanded: [S1],
        prepare: (mock) => mock.write('local', { [LOCAL.groupSettings(ACCOUNT)]: { ...settingsOfRaw(mock), [STUDY]: defaults({ count: 3 }), [LOUNGE]: defaults({ count: 4 }) } }),
      });
      await openGroup(S1, 'Sample Server');
      expect(notice()?.textContent).toBe('아래 개별 설정 3개가 이 설정으로 바뀌어요'); // questions + two categories
    });

    it('a category: only the chats in it', async () => {
      await tree();
      await openGroup(STUDY, 'Study');
      expect(notice()?.textContent).toBe('아래 개별 설정 1개가 이 설정으로 바뀌어요');
      fireEvent.click(button('뒤로'));
      await settle();
      await openGroup(COURSES, 'Courses');
      expect(notice()?.textContent).toBe('아래 개별 설정 1개가 이 설정으로 바뀌어요'); // math
    });

    it('nothing below has settings of its own: no notice', async () => {
      await renderPopup({ scenario: 'tree', expanded: [S1] });
      await openGroup(ARCHIVE, 'Archive');
      expect(notice()).toBeNull();
      expect(screen.queryByText(/아래 개별 설정/)).toBeNull();
    });

    it('follows the state while the screen is open', async () => {
      const { platform } = await tree();
      await openGroup(S1, 'Sample Server');
      expect(notice()?.textContent).toContain('1개');
      const queue = queueOf(platform).map((item) => (item.key === key(T.general) ? { ...item, settings: defaults({ count: 9 }) } : item));
      await act(async () => {
        platform.write('local', { [LOCAL.queue(ACCOUNT)]: queue });
      });
      await settle();
      expect(notice()?.textContent).toBe('아래 개별 설정 2개가 이 설정으로 바뀌어요');
      await act(async () => {
        platform.write('local', { [LOCAL.queue(ACCOUNT)]: queue.map((item) => ({ ...item, settings: null })) });
      });
      await settle();
      expect(notice()).toBeNull();
    });

    it('English, singular and plural', async () => {
      await tree({ settings: { language: 'en' } });
      fireEvent.click(within(line(S1)).getByRole('button', { name: 'Settings of Sample Server' }));
      await settle();
      expect(notice()?.textContent).toBe('1 setting of chats below will be replaced by these');
      expect(document.querySelector('.dce-viewheader__subtitle')?.textContent).toBe('Applies to 7 chats');
      expect(screen.getByRole('heading', { level: 1, name: 'Server settings · Sample Server' })).toBeTruthy();
    });
  });
});

/** The stored group settings of a mock platform before the popup opens. */
function settingsOfRaw(mock: { read(area: 'local' | 'session', key: string): unknown }): Record<string, unknown> {
  return (mock.read('local', LOCAL.groupSettings(ACCOUNT)) as Record<string, unknown> | undefined) ?? {};
}

describe('[저장]: queue/setGroupSettings with the settings', () => {
  it('a server: sends kind, guild id, group id and the settings; the group says "서버 설정", the chats below lose their own', async () => {
    const { platform } = await tree();
    await openGroup(S1, 'Sample Server');
    fireEvent.change(countInput(), { target: { value: '25' } });
    fireEvent.click(radio(/^CSV/));
    fireEvent.click(button('저장'));
    await settle();

    expect(sentMessages(platform, 'queue/setGroupSettings')).toEqual([
      { to: 'bg', type: 'queue/setGroupSettings', kind: 'guild', guildId: S1, groupId: S1, settings: defaults({ count: 25, format: 'csv' }) },
    ]);
    // back on the main screen
    expect(screen.queryByRole('heading', { level: 1, name: /서버 설정/ })).toBeNull();
    expect(settingsOf(platform)[S1]).toEqual(defaults({ count: 25, format: 'csv' }));
    expect(itemOf(platform, T.questions).settings).toBeNull();
    expect(badgesOf(line(S1))).toEqual(['서버 설정', '미완료 1']); // no "개별 N" any more (the failed chat still is a failed chat)
    expect(badgesOf(row('Sample Server > #general'))).toEqual(['서버 설정']);
    expect(badgesOf(row('Sample Server > #questions'))).toEqual(['서버 설정']);
    expect(row('Sample Server > #questions').querySelector('.dce-row__summary')?.textContent).toBe('25개 · CSV · 기간 없음');
    // another server is not touched
    expect(itemOf(platform, T.math).settings).not.toBeNull();
    expect(settingsOf(platform)[S2]).toBeDefined();
  });

  it('a category: kind "category" with the server\'s id and the category\'s id', async () => {
    const { platform } = await tree();
    await openGroup(STUDY, 'Study');
    fireEvent.click(radio(/^TXT/));
    fireEvent.click(button('저장'));
    await settle();
    expect(sentMessages(platform, 'queue/setGroupSettings')).toEqual([
      { to: 'bg', type: 'queue/setGroupSettings', kind: 'category', guildId: S1, groupId: STUDY, settings: defaults({ format: 'txt' }) },
    ]);
    expect(badgesOf(line(STUDY))).toEqual(['카테고리 설정']);
    expect(badgesOf(row('Sample Server > #resources'))).toEqual(['카테고리 설정']);
    expect(badgesOf(row('Sample Server > #questions'))).toEqual(['카테고리 설정']); // its own settings were replaced
  });

  it('the dates and every kind of setting travel with it', async () => {
    const { platform } = await tree();
    await openGroup(S1, 'Sample Server');
    fireEvent.click(radio('전체'));
    fireEvent.change(screen.getByLabelText('시작일'), { target: { value: '2026-02-01' } });
    fireEvent.click(screen.getByRole('button', { name: '더보기' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '첨부파일 함께 저장' }));
    fireEvent.click(button('저장'));
    await settle();
    expect(sentMessages(platform, 'queue/setGroupSettings')[0]).toMatchObject({
      settings: defaults({ count: null, from: new Date(2026, 1, 1, 0, 0, 0, 0).toISOString(), includeAttachments: true }),
    });
  });

  it('nothing changed and nothing below to replace: nothing is sent', async () => {
    const { platform } = await renderPopup({ scenario: 'tree', expanded: [S1] });
    await openGroup(ARCHIVE, 'Archive');
    fireEvent.click(button('저장'));
    await settle();
    expect(sentMessages(platform, 'queue/setGroupSettings')).toEqual([]);
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull(); // back on the main screen
    expect(settingsOf(platform)[ARCHIVE]).toBeUndefined(); // the chats keep following what is above
  });

  it('nothing changed but chats below have their own settings: saving still replaces them (the notice said so)', async () => {
    const { platform } = await tree();
    await openGroup(S1, 'Sample Server');
    fireEvent.click(button('저장'));
    await settle();
    expect(sentMessages(platform, 'queue/setGroupSettings')).toEqual([
      { to: 'bg', type: 'queue/setGroupSettings', kind: 'guild', guildId: S1, groupId: S1, settings: defaults() },
    ]);
    expect(itemOf(platform, T.questions).settings).toBeNull();
  });

  it('changing something and changing it back with nothing below is no change', async () => {
    const { platform } = await renderPopup({ scenario: 'tree', expanded: [S1] });
    await openGroup(ARCHIVE, 'Archive');
    fireEvent.click(radio(/^CSV/));
    fireEvent.click(radio(/^HTML/));
    fireEvent.click(button('저장'));
    await settle();
    expect(sentMessages(platform, 'queue/setGroupSettings')).toEqual([]);
  });

  it('a bad value blocks saving, with the reason', async () => {
    const { platform } = await tree();
    await openGroup(S1, 'Sample Server');
    fireEvent.change(countInput(), { target: { value: '0' } });
    const save = button('저장') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('title')).toBe('올바르지 않은 값이 있어요');
    fireEvent.click(save);
    await settle();
    expect(sentMessages(platform, 'queue/setGroupSettings')).toEqual([]);
  });

  it('a refusal keeps the screen open with the message, the draft stays, and saving can be tried again', async () => {
    const { platform } = await tree({ prepare: (mock) => mock.failNext('queue/setGroupSettings', 'unknown', 'storage is full') });
    await openGroup(S1, 'Sample Server');
    fireEvent.click(radio(/^TXT/));
    fireEvent.click(button('저장'));
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: '서버 설정 · Sample Server' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('(storage is full)');
    expect(radio(/^TXT/).getAttribute('aria-checked')).toBe('true');
    expect((button('저장') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button('저장'));
    await settle();
    expect(screen.queryByRole('heading', { level: 1, name: '서버 설정 · Sample Server' })).toBeNull();
    expect(settingsOf(platform)[S1]).toEqual(defaults({ format: 'txt' }));
  });
});

describe('[상위 설정으로 되돌리기]', () => {
  it('only a group that has settings of its own has it', async () => {
    await tree();
    await openGroup(S1, 'Sample Server');
    expect(screen.queryByRole('button', { name: '상위 설정으로 되돌리기' })).toBeNull();
    fireEvent.click(button('뒤로'));
    await settle();
    await openGroup(S2, 'Study Group');
    expect(screen.getByRole('button', { name: '상위 설정으로 되돌리기' })).toBeTruthy();
  });

  it('sends settings null: the group\'s settings go, the settings of its chats stay', async () => {
    const { platform } = await tree({ expanded: [S1, STUDY, S2, COURSES] });
    await openGroup(S2, 'Study Group');
    fireEvent.click(button('상위 설정으로 되돌리기'));
    await settle();
    expect(sentMessages(platform, 'queue/setGroupSettings')).toEqual([
      { to: 'bg', type: 'queue/setGroupSettings', kind: 'guild', guildId: S2, groupId: S2, settings: null },
    ]);
    expect(settingsOf(platform)[S2]).toBeUndefined();
    expect(itemOf(platform, T.math).settings).not.toBeNull();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(badgesOf(line(S2))).toEqual(['공통 설정', '개별 1']);
    expect(badgesOf(row('Study Group > #announcements'))).toEqual(['공통 설정']);
    expect(badgesOf(row('Study Group > #math'))).toEqual(['개별 설정']);
  });

  it('reverting while the draft is invalid or edited does not send the draft', async () => {
    const { platform } = await tree();
    await openGroup(S2, 'Study Group');
    fireEvent.change(countInput(), { target: { value: '' } });
    expect((button('저장') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button('상위 설정으로 되돌리기'));
    await settle();
    expect(sentMessages(platform, 'queue/setGroupSettings')).toEqual([{ to: 'bg', type: 'queue/setGroupSettings', kind: 'guild', guildId: S2, groupId: S2, settings: null }]);
  });

  it('a category reverts to what is above it, a refusal is shown', async () => {
    const { platform } = await renderPopup({
      scenario: 'tree',
      expanded: [S2],
      prepare: (mock) => {
        mock.write('local', { [LOCAL.groupSettings(ACCOUNT)]: { ...settingsOfRaw(mock), [COURSES]: defaults({ count: 7 }) } });
        mock.failNext('queue/setGroupSettings', 'unknown');
      },
    });
    await openGroup(COURSES, 'Courses');
    fireEvent.click(button('상위 설정으로 되돌리기'));
    await settle();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: '카테고리 설정 · Courses' })).toBeTruthy();
    fireEvent.click(button('상위 설정으로 되돌리기'));
    await settle();
    expect(settingsOf(platform)[COURSES]).toBeUndefined();
    expect(settingsOf(platform)[S2]).toBeDefined();
  });

  it('is in English too', async () => {
    await tree({ settings: { language: 'en' } });
    fireEvent.click(within(line(S2)).getByRole('button', { name: 'Settings of Study Group' }));
    await settle();
    expect(screen.getByRole('button', { name: 'Reset to the settings above' })).toBeTruthy();
  });
});

describe('leaving the screen', () => {
  it('[취소] sends nothing; the focus returns to the ⚙ of the group', async () => {
    const { platform } = await tree();
    await openGroup(S1, 'Sample Server');
    fireEvent.change(countInput(), { target: { value: '25' } });
    fireEvent.click(button('취소'));
    await settle();
    expect(sentMessages(platform)).toEqual([]);
    expect(document.activeElement).toBe(within(line(S1)).getByRole('button', { name: 'Sample Server 설정' }));
    expect(settingsOf(platform)[S1]).toBeUndefined();
  });

  it('the back arrow and Escape do the same', async () => {
    const { platform } = await tree();
    await openGroup(STUDY, 'Study');
    fireEvent.click(button('뒤로'));
    await settle();
    expect(document.activeElement).toBe(within(line(STUDY)).getByRole('button', { name: 'Study 설정' }));
    await openGroup(STUDY, 'Study');
    fireEvent.keyDown(document, { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(document.activeElement).toBe(within(line(STUDY)).getByRole('button', { name: 'Study 설정' }));
    expect(sentMessages(platform)).toEqual([]);
  });

  it('a draft that was abandoned does not come back: the screen starts from the stored settings', async () => {
    await tree();
    await openGroup(S1, 'Sample Server');
    fireEvent.change(countInput(), { target: { value: '25' } });
    fireEvent.click(button('취소'));
    await settle();
    await openGroup(S1, 'Sample Server');
    expect(countInput().value).toBe('200');
  });

  it('the open groups and the position of the list are as they were', async () => {
    await tree();
    await openGroup(STUDY, 'Study');
    fireEvent.click(button('취소'));
    await settle();
    expect(screen.getByRole('button', { name: 'Study', expanded: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sample Server', expanded: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Courses', expanded: false })).toBeTruthy();
  });
});

describe('a group that is not in the list any more', () => {
  it('says so, with [닫기]', async () => {
    const { platform } = await tree();
    await openGroup(S1, 'Sample Server');
    await act(async () => {
      platform.write('local', { [LOCAL.queue(ACCOUNT)]: queueOf(platform).filter((item) => item.target.guildId !== S1) });
    });
    await settle();
    expect(screen.getByText('여기에 담긴 채널이 더 이상 목록에 없어요.')).toBeTruthy();
    fireEvent.click(button('닫기'));
    await settle();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('English', async () => {
    const { platform } = await tree({ settings: { language: 'en' } });
    fireEvent.click(within(line(S1)).getByRole('button', { name: 'Settings of Sample Server' }));
    await settle();
    await act(async () => {
      platform.write('local', { [LOCAL.queue(ACCOUNT)]: [] });
    });
    await settle();
    expect(screen.getByText('The chats here are no longer in the list.')).toBeTruthy();
  });
});

describe('the editor of a chat follows the groups above it (docs/PLAN.md §7.2a)', () => {
  const openChat = async (label: string): Promise<void> => {
    fireEvent.click(within(row(label)).getByRole('button', { name: `${label} 설정` }));
    await settle();
  };
  /** Gives the chat settings of its own. */
  const withOwn = (target: { channelId: string }, settings: ExportSettings) => (mock: { read(area: 'local', key: string): unknown; write(area: 'local', items: Record<string, unknown>): void }) =>
    mock.write('local', { [LOCAL.queue(ACCOUNT)]: (mock.read('local', LOCAL.queue(ACCOUNT)) as QueueItem[]).map((item) => (item.key === key(target) ? { ...item, settings } : item)) });
  const groupSettings = (settings: Record<string, ExportSettings>) => (mock: { read(area: 'local', key: string): unknown; write(area: 'local', items: Record<string, unknown>): void }) =>
    mock.write('local', { [LOCAL.groupSettings(ACCOUNT)]: { ...((mock.read('local', LOCAL.groupSettings(ACCOUNT)) as Record<string, unknown> | undefined) ?? {}), ...settings } });

  it('a chat that follows its category: filled with the category\'s settings, no revert button, the note says so', async () => {
    await renderPopup({ scenario: 'tree', expanded: [S1, STUDY], prepare: groupSettings({ [STUDY]: defaults({ count: 7, format: 'csv' }) }) });
    await openChat('Sample Server > #general');
    expect(radio(/^CSV/).getAttribute('aria-checked')).toBe('true');
    expect(countInput().value).toBe('7');
    expect(screen.getByText('지금은 카테고리 설정을 따라가요. 여기서 저장하면 이 채팅만 다른 설정을 써요.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /되돌리기$/ })).toBeNull();
  });

  it('a chat that follows its server: filled with the server\'s settings', async () => {
    await renderPopup({ scenario: 'tree', expanded: [S2] });
    await openChat('Study Group > #announcements');
    expect(radio(/^Markdown/).getAttribute('aria-checked')).toBe('true');
    expect(countInput().value).toBe('50');
    expect(screen.getByText('지금은 서버 설정을 따라가요. 여기서 저장하면 이 채팅만 다른 설정을 써요.')).toBeTruthy();
  });

  it('the revert button is named after what the chat would follow again: 카테고리 / 서버 / 공통 설정으로 되돌리기', async () => {
    // in a category with settings
    await renderPopup({ scenario: 'tree', expanded: [S1, STUDY], prepare: groupSettings({ [STUDY]: defaults({ count: 7 }), [S1]: defaults({ count: 8 }) }) });
    await openChat('Sample Server > #questions'); // has its own settings
    expect(screen.getByRole('button', { name: '카테고리 설정으로 되돌리기' })).toBeTruthy();
    expect(screen.getByText('이 채팅만의 설정을 쓰고 있어요. 카테고리 설정을 바꿔도 이 채팅은 그대로예요.')).toBeTruthy();
    expect(screen.getByText('카테고리 설정: 7개 · HTML · 기간 없음')).toBeTruthy();
    cleanup();

    // below a server with settings (math is in a category without any)
    await renderPopup({ scenario: 'tree', expanded: [S2, COURSES] });
    await openChat('Study Group > #math');
    expect(screen.getByRole('button', { name: '서버 설정으로 되돌리기' })).toBeTruthy();
    expect(screen.getByText('이 채팅만의 설정을 쓰고 있어요. 서버 설정을 바꿔도 이 채팅은 그대로예요.')).toBeTruthy();
    expect(screen.getByText('서버 설정: 50개 · MD · 기간 없음 · 첨부')).toBeTruthy();
    cleanup();

    // with nothing above but the common settings
    await renderPopup({ scenario: 'tree', expanded: [S1, STUDY] });
    await openChat('Sample Server > #questions');
    expect(screen.getByRole('button', { name: '공통 설정으로 되돌리기' })).toBeTruthy();
    expect(screen.getByText('공통 설정: 200개 · HTML · 기간 없음')).toBeTruthy();
  });

  it('a one-line category inside a server with settings: its chat follows the server', async () => {
    await renderPopup({
      scenario: 'tree',
      expanded: [S1],
      prepare: (mock) => {
        withOwn(T.chat, defaults({ count: 3 }))(mock);
        groupSettings({ [S1]: defaults({ count: 11 }) })(mock);
      },
    });
    fireEvent.click(within(row('Lounge › #chat')).getByRole('button', { name: 'Sample Server > #chat 설정' }));
    await settle();
    expect(screen.getByRole('button', { name: '서버 설정으로 되돌리기' })).toBeTruthy();
    expect(screen.getByText('서버 설정: 11개 · HTML · 기간 없음')).toBeTruthy();
  });

  it('a category with settings of its own and one chat keeps its line, and the chat in it follows the category', async () => {
    await renderPopup({ scenario: 'tree', expanded: [MOCK_GUILDS.book.id, MOCK_CATEGORIES.books.id], prepare: groupSettings({ [MOCK_CATEGORIES.books.id]: defaults({ count: 11 }) }) });
    expect(() => row('Book Club › #reading')).toThrow(); // not compressed: the category line is where its settings are edited
    await openChat('Book Club > #reading');
    expect(countInput().value).toBe('11');
    expect(screen.getByText('지금은 카테고리 설정을 따라가요. 여기서 저장하면 이 채팅만 다른 설정을 써요.')).toBeTruthy();
  });

  it('[…으로 되돌리기] sends queue/upsert with settings null, and the chat follows the group again', async () => {
    const { platform } = await renderPopup({ scenario: 'tree', expanded: [S2, COURSES] });
    await openChat('Study Group > #math');
    fireEvent.click(button('서버 설정으로 되돌리기'));
    await settle();
    const upserts = sentMessages(platform, 'queue/upsert');
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ item: { key: key(T.math), settings: null } });
    expect(badgesOf(row('Study Group > #math'))).toEqual(['서버 설정']);
    expect(row('Study Group > #math').querySelector('.dce-row__summary')?.textContent).toBe('50개 · MD · 기간 없음 · 첨부');
  });

  it('saving without a change sends nothing: a chat that follows its category keeps following it', async () => {
    const { platform } = await renderPopup({ scenario: 'tree', expanded: [S1, STUDY], prepare: groupSettings({ [STUDY]: defaults({ count: 7 }) }) });
    await openChat('Sample Server > #general');
    fireEvent.click(button('저장'));
    await settle();
    expect(sentMessages(platform, 'queue/upsert')).toEqual([]);
    expect(itemOf(platform, T.general).settings).toBeNull();
  });

  it('saving a change gives the chat settings of its own ("개별 설정")', async () => {
    const { platform } = await renderPopup({ scenario: 'tree', expanded: [S1, STUDY], prepare: groupSettings({ [STUDY]: defaults({ count: 7 }) }) });
    await openChat('Sample Server > #general');
    fireEvent.change(countInput(), { target: { value: '9' } });
    fireEvent.click(button('저장'));
    await settle();
    expect(itemOf(platform, T.general).settings).toEqual(defaults({ count: 9 }));
    expect(badgesOf(row('Sample Server > #general'))).toEqual(['개별 설정']);
  });

  it('English labels', async () => {
    await renderPopup({ scenario: 'tree', expanded: [S1, STUDY], settings: { language: 'en' }, prepare: groupSettings({ [STUDY]: defaults({ count: 7 }) }) });
    fireEvent.click(within(row('Sample Server > #questions')).getByRole('button', { name: 'Settings of Sample Server > #questions' }));
    await settle();
    expect(screen.getByRole('button', { name: 'Reset to category settings' })).toBeTruthy();
    expect(screen.getByText('This chat has settings of its own. Changing the category settings does not affect it.')).toBeTruthy();
    expect(screen.getByText('Category settings: 7 messages · HTML · No date range')).toBeTruthy();
    cleanup();
    await renderPopup({ scenario: 'tree', expanded: [S2, COURSES], settings: { language: 'en' } });
    fireEvent.click(within(row('Study Group > #math')).getByRole('button', { name: 'Settings of Study Group > #math' }));
    await settle();
    expect(screen.getByRole('button', { name: 'Reset to server settings' })).toBeTruthy();
    fireEvent.click(button('Back'));
    await settle();
    fireEvent.click(within(row('Study Group > #physics')).getByRole('button', { name: 'Settings of Study Group > #physics' }));
    await settle();
    expect(screen.getByText('This chat follows the server settings. Saving here gives it settings of its own.')).toBeTruthy();
  });
});
