// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_SETTINGS, LOCAL, type ExportSettings, type QueueItem } from '@/shared';
import { endOfDayIso, startOfDayIso } from '@/ui/format/dates';
import { MOCK_ACCOUNT, MOCK_TARGETS, sampleOwnSettings } from '@/ui/platform/mock';
import { button, renderPopup, row, sentMessages, settle, storedCommon, storedQueue } from './helpers';

afterEach(cleanup); // vitest globals are off, so testing-library cannot register its own cleanup

const GENERAL = 'Sample Server > #general';
const ANNOUNCEMENTS = 'Sample Server > #announcements';
const KEYS = { general: MOCK_TARGETS.general.channelId, announcements: MOCK_TARGETS.announcements.channelId, questions: MOCK_TARGETS.questions.channelId };

/** The gear of the row with this label; the names of its buttons spell the path with ">" ("Study Group > #questions"). */
const openEditor = async (label: string): Promise<void> => {
  fireEvent.click(within(row(label)).getByRole('button', { name: `${label.replace(' › ', ' > ')} 설정` }));
  await settle();
};
const countInput = (): HTMLInputElement => screen.getByRole('spinbutton', { name: '내보낼 메시지 개수' }) as HTMLInputElement;
const dateInput = (label: '시작일' | '종료일'): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement;
const radio = (name: string | RegExp): HTMLElement => screen.getByRole('radio', { name });
const queue = (platform: Parameters<typeof storedQueue>[0]): QueueItem[] => storedQueue(platform) as QueueItem[];
const itemOf = (platform: Parameters<typeof storedQueue>[0], key: string): QueueItem => queue(platform).find((item) => item.key === key)!;

const defaults = (patch: Partial<ExportSettings> = {}): ExportSettings => ({ ...DEFAULT_EXPORT_SETTINGS, content: { ...DEFAULT_EXPORT_SETTINGS.content }, ...patch });

describe('the item editor (the gear of a row)', () => {
  it('is a screen of its own: "채팅 설정" for that chat', async () => {
    await renderPopup();
    await openEditor(GENERAL);
    expect(screen.getByRole('heading', { level: 1, name: '채팅 설정' })).toBeTruthy();
    expect(document.querySelector('.dce-viewheader__subtitle')?.textContent).toBe(GENERAL);
    expect(document.querySelector('.dce-view--main')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: '채팅 설정' }));
  });

  it('has the fields of the common settings panel, but no language and no ZIP option', async () => {
    await renderPopup();
    await openEditor(GENERAL);
    expect(document.querySelector('[data-variant="item"]')).not.toBeNull();
    expect(screen.getByRole('radiogroup', { name: '형식' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: '메시지 개수' })).toBeTruthy();
    expect(screen.getByLabelText('시작일')).toBeTruthy();
    expect(screen.getByLabelText('종료일')).toBeTruthy();
    expect(screen.getByRole('button', { name: '더보기' })).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: '언어' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'ZIP 하나로 받기' })).toBeNull();
  });

  it('a chat that follows the common settings starts with the common settings filled in', async () => {
    const { platform } = await renderPopup();
    await openEditor(GENERAL);
    const common = storedCommon(platform);
    expect(radio(/^HTML/).getAttribute('aria-checked')).toBe('true');
    expect(countInput().value).toBe(String(common.count));
    expect(dateInput('시작일').value).toBe('');
    expect(screen.getByText('지금은 공통 설정을 따라가요. 여기서 저장하면 이 채팅만 다른 설정을 써요.')).toBeTruthy();
    expect(screen.queryByText(/^공통 설정: /)).toBeNull();
  });

  it('a chat with settings of its own starts with ITS settings filled in', async () => {
    await renderPopup();
    await openEditor(ANNOUNCEMENTS);
    expect(radio(/^TXT/).getAttribute('aria-checked')).toBe('true');
    expect(radio('전체').getAttribute('aria-checked')).toBe('true'); // no limit
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(dateInput('시작일').value).toBe('2026-01-01');
    expect(dateInput('종료일').value).toBe('2026-03-31');
    // the "더보기" section starts open: something in it differs from the defaults
    expect((screen.getByRole('checkbox', { name: '첨부파일 함께 저장' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: '봇 메시지 포함' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: '반응 포함' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: '임베드 포함' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('이 채팅만의 설정을 쓰고 있어요. 공통 설정을 바꿔도 이 채팅은 그대로예요.')).toBeTruthy();
    expect(screen.getByText('공통 설정: 200개 · HTML · 기간 없음')).toBeTruthy();
  });

  it('the HTML theme row is there for HTML only', async () => {
    await renderPopup();
    await openEditor(GENERAL);
    expect(screen.getByRole('radiogroup', { name: 'HTML 테마' })).toBeTruthy();
    fireEvent.click(radio(/^CSV/));
    expect(screen.queryByRole('radiogroup', { name: 'HTML 테마' })).toBeNull();
  });
});

describe('[저장]: queue/upsert with the settings', () => {
  it('sends the whole item with the edited settings, and the row becomes "개별 설정" with the new summary', async () => {
    const { platform } = await renderPopup();
    const before = itemOf(platform, KEYS.general);
    await openEditor(GENERAL);
    fireEvent.change(countInput(), { target: { value: '50' } });
    fireEvent.click(radio(/^CSV/));
    fireEvent.click(button('저장'));
    await settle();

    const upserts = sentMessages(platform, 'queue/upsert');
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toEqual({
      to: 'bg',
      type: 'queue/upsert',
      item: { key: KEYS.general, target: before.target, settings: defaults({ count: 50, format: 'csv' }), addedAt: before.addedAt },
    });
    // back on the main screen, where the row shows the new state
    expect(screen.queryByRole('heading', { level: 1, name: '채팅 설정' })).toBeNull();
    expect(row(GENERAL).querySelector('.dce-badge')?.textContent).toBe('개별 설정');
    expect(row(GENERAL).querySelector('.dce-row__summary')?.textContent).toBe('50개 · CSV · 기간 없음');
    expect(itemOf(platform, KEYS.general).settings).toEqual(defaults({ count: 50, format: 'csv' }));
    // the chat stays where it was in the list
    expect(queue(platform).map((item) => item.key)[0]).toBe(KEYS.general);
  });

  it('the dates are the local start of the first day and the local end of the last day', async () => {
    const { platform } = await renderPopup();
    await openEditor(GENERAL);
    fireEvent.change(dateInput('시작일'), { target: { value: '2026-02-01' } });
    fireEvent.change(dateInput('종료일'), { target: { value: '2026-02-28' } });
    fireEvent.click(button('저장'));
    await settle();
    const saved = itemOf(platform, KEYS.general).settings!;
    expect(saved.from).toBe(startOfDayIso('2026-02-01'));
    expect(saved.to).toBe(endOfDayIso('2026-02-28'));
    expect(saved.from).toBe(new Date(2026, 1, 1, 0, 0, 0, 0).toISOString());
    expect(saved.to).toBe(new Date(2026, 1, 28, 23, 59, 59, 999).toISOString());
    expect(row(GENERAL).querySelector('.dce-row__summary')?.textContent).toBe('200개 · HTML · 2026-02-01 ~ 2026-02-28');
  });

  it('every kind of setting travels: format, theme, count / all, range, attachments, threads, new only, content', async () => {
    const { platform } = await renderPopup();
    await openEditor(GENERAL);
    fireEvent.click(radio(/^Excel/));
    fireEvent.click(radio('전체'));
    fireEvent.change(dateInput('시작일'), { target: { value: '2026-01-10' } });
    fireEvent.click(screen.getByRole('button', { name: '더보기' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '첨부파일 함께 저장' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '스레드 포함' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '새 메시지만 받기' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '임베드 포함' }));
    fireEvent.click(button('저장'));
    await settle();
    expect(itemOf(platform, KEYS.general).settings).toEqual({
      count: null,
      from: startOfDayIso('2026-01-10'),
      to: null,
      format: 'xlsx',
      htmlTheme: 'dark',
      includeAttachments: true,
      includeThreads: true,
      incremental: true,
      content: { includeBots: true, includeSystem: true, includeReactions: true, includeEmbeds: false },
    });
  });

  it('the light HTML theme is saved too', async () => {
    const { platform } = await renderPopup();
    await openEditor(GENERAL);
    fireEvent.click(radio('라이트'));
    fireEvent.click(button('저장'));
    await settle();
    expect(itemOf(platform, KEYS.general).settings).toMatchObject({ format: 'html', htmlTheme: 'light' });
  });

  it('saving without a change sends nothing: a chat nobody touched keeps following the common settings', async () => {
    const { platform } = await renderPopup();
    await openEditor(GENERAL);
    fireEvent.click(button('저장'));
    await settle();
    expect(sentMessages(platform, 'queue/upsert')).toEqual([]);
    expect(screen.queryByRole('heading', { level: 1, name: '채팅 설정' })).toBeNull();
    expect(itemOf(platform, KEYS.general).settings).toBeNull();
    expect(row(GENERAL).querySelector('.dce-badge')?.textContent).toBe('공통 설정');
  });

  it('changing something and changing it back is no change', async () => {
    const { platform } = await renderPopup();
    await openEditor(GENERAL);
    fireEvent.click(radio(/^TXT/));
    fireEvent.click(radio(/^HTML/));
    fireEvent.click(button('저장'));
    await settle();
    expect(sentMessages(platform, 'queue/upsert')).toEqual([]);
  });

  it('a chat that already has its own settings saves them again when they change', async () => {
    const { platform } = await renderPopup();
    await openEditor(ANNOUNCEMENTS);
    fireEvent.click(radio(/^JSON/));
    fireEvent.click(button('저장'));
    await settle();
    expect(itemOf(platform, KEYS.announcements).settings).toEqual({ ...sampleOwnSettings(), format: 'json' });
    expect(row(ANNOUNCEMENTS).querySelector('.dce-row__summary')?.textContent).toBe('전체 · JSON · 2026-01-01 ~ 2026-03-31 · 첨부');
  });

  it('keeps what else the item carries (a note about the last failure)', async () => {
    const { platform } = await renderPopup();
    const before = itemOf(platform, KEYS.questions);
    await openEditor('Study Group › #questions');
    fireEvent.click(radio(/^TXT/));
    fireEvent.click(button('저장'));
    await settle();
    expect(sentMessages(platform, 'queue/upsert')[0]).toMatchObject({ item: { key: KEYS.questions, lastResult: before.lastResult } });
  });

  it('a refusal keeps the editor open with the message, and saving can be tried again', async () => {
    const { platform } = await renderPopup({ prepare: (mock) => mock.failNext('queue/upsert', 'unknown', 'storage is full') });
    await openEditor(GENERAL);
    fireEvent.click(radio(/^TXT/));
    fireEvent.click(button('저장'));
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: '채팅 설정' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('(storage is full)');
    expect(radio(/^TXT/).getAttribute('aria-checked')).toBe('true'); // the draft is still there
    expect((button('저장') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button('저장'));
    await settle();
    expect(screen.queryByRole('heading', { level: 1, name: '채팅 설정' })).toBeNull();
    expect(itemOf(platform, KEYS.general).settings).toMatchObject({ format: 'txt' });
  });
});

describe('validation blocks saving (docs/PLAN.md §7.3)', () => {
  it('a bad count: the message, and [저장] is off with a reason', async () => {
    const { platform } = await renderPopup();
    await openEditor(GENERAL);
    fireEvent.change(countInput(), { target: { value: '0' } });
    expect(screen.getByRole('alert').textContent).toBe('1에서 1,000,000 사이의 숫자를 입력하세요.');
    const save = button('저장') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('title')).toBe('올바르지 않은 값이 있어요');
    fireEvent.click(save);
    await settle();
    expect(sentMessages(platform, 'queue/upsert')).toEqual([]);
    fireEvent.change(countInput(), { target: { value: '30' } });
    expect((button('저장') as HTMLButtonElement).disabled).toBe(false);
    expect(button('저장').hasAttribute('title')).toBe(false);
  });

  it('a start date after the end date', async () => {
    await renderPopup();
    await openEditor(GENERAL);
    fireEvent.change(dateInput('시작일'), { target: { value: '2026-03-20' } });
    fireEvent.change(dateInput('종료일'), { target: { value: '2026-03-05' } });
    expect(screen.getByRole('alert').textContent).toBe('시작일이 종료일보다 늦어요.');
    expect((button('저장') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '시작일 지우기' }));
    expect((button('저장') as HTMLButtonElement).disabled).toBe(false);
  });

  it('1 and 1,000,000 are fine', async () => {
    const { platform } = await renderPopup();
    await openEditor(GENERAL);
    fireEvent.change(countInput(), { target: { value: '1000000' } });
    expect((button('저장') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button('저장'));
    await settle();
    expect(itemOf(platform, KEYS.general).settings?.count).toBe(1_000_000);
  });
});

describe('[공통 설정으로 되돌리기]', () => {
  it('only a chat that has settings of its own has it', async () => {
    await renderPopup();
    await openEditor(GENERAL);
    expect(screen.queryByRole('button', { name: '공통 설정으로 되돌리기' })).toBeNull();
    fireEvent.click(button('취소'));
    await openEditor(ANNOUNCEMENTS);
    expect(screen.getByRole('button', { name: '공통 설정으로 되돌리기' })).toBeTruthy();
  });

  it('sends queue/upsert with settings: null, and the chat follows the common settings again', async () => {
    const { platform } = await renderPopup();
    const before = itemOf(platform, KEYS.announcements);
    await openEditor(ANNOUNCEMENTS);
    fireEvent.click(button('공통 설정으로 되돌리기'));
    await settle();
    const upserts = sentMessages(platform, 'queue/upsert');
    expect(upserts).toEqual([{ to: 'bg', type: 'queue/upsert', item: { key: KEYS.announcements, target: before.target, settings: null, addedAt: before.addedAt } }]);
    expect(screen.queryByRole('heading', { level: 1, name: '채팅 설정' })).toBeNull();
    expect(row(ANNOUNCEMENTS).querySelector('.dce-badge')?.textContent).toBe('공통 설정');
    expect(row(ANNOUNCEMENTS).querySelector('.dce-row__summary')?.textContent).toBe('200개 · HTML · 기간 없음');
    expect(itemOf(platform, KEYS.announcements).settings).toBeNull();
  });

  it('reverting works while the draft is invalid or edited: it does not send the draft', async () => {
    const { platform } = await renderPopup();
    await openEditor(ANNOUNCEMENTS);
    fireEvent.click(radio(/^JSON/));
    fireEvent.click(screen.getByRole('radio', { name: '개수 지정' }));
    fireEvent.change(countInput(), { target: { value: '0' } });
    fireEvent.click(button('공통 설정으로 되돌리기'));
    await settle();
    expect(sentMessages(platform, 'queue/upsert')).toEqual([expect.objectContaining({ item: expect.objectContaining({ settings: null }) })]);
  });
});

describe('[취소] and leaving the editor', () => {
  it('[취소] sends nothing and the chat is as it was', async () => {
    const { platform } = await renderPopup();
    await openEditor(GENERAL);
    fireEvent.click(radio(/^CSV/));
    fireEvent.change(countInput(), { target: { value: '5' } });
    fireEvent.click(button('취소'));
    await settle();
    expect(sentMessages(platform)).toEqual([]);
    expect(screen.queryByRole('heading', { level: 1, name: '채팅 설정' })).toBeNull();
    expect(row(GENERAL).querySelector('.dce-badge')?.textContent).toBe('공통 설정');
    expect(itemOf(platform, KEYS.general).settings).toBeNull();
  });

  it('the back arrow and Escape do the same as [취소], and the focus returns to the gear that was pressed', async () => {
    const { platform } = await renderPopup();
    await openEditor(GENERAL);
    fireEvent.click(radio(/^CSV/));
    fireEvent.click(button('뒤로'));
    await settle();
    expect(document.activeElement).toBe(within(row(GENERAL)).getByRole('button', { name: `${GENERAL} 설정` }));
    await openEditor('Alex');
    fireEvent.keyDown(document, { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('heading', { level: 1, name: '채팅 설정' })).toBeNull();
    expect(document.activeElement).toBe(within(row('Alex')).getByRole('button', { name: 'Alex 설정' }));
    expect(sentMessages(platform)).toEqual([]);
  });

  it('opening the editor again starts from the stored settings, not from an abandoned draft', async () => {
    await renderPopup();
    await openEditor(GENERAL);
    fireEvent.click(radio(/^CSV/));
    fireEvent.click(button('취소'));
    await openEditor(GENERAL);
    expect(radio(/^HTML/).getAttribute('aria-checked')).toBe('true');
  });

  it('the main list is where it was (scroll position kept in the list area)', async () => {
    await renderPopup();
    const list = document.querySelector('.dce-main__list') as HTMLElement;
    list.scrollTop = 40;
    fireEvent.scroll(list);
    await openEditor('Alex');
    fireEvent.click(button('취소'));
    await settle();
    expect((document.querySelector('.dce-main__list') as HTMLElement).scrollTop).toBe(40);
  });
});

describe('while the editor is open', () => {
  it('a change of the common settings does not disturb the draft', async () => {
    const { platform } = await renderPopup();
    await openEditor(GENERAL);
    fireEvent.change(countInput(), { target: { value: '33' } });
    await act(async () => {
      await platform.sendMessage({ to: 'bg', type: 'settings/patch', patch: { common: { ...storedCommon(platform), count: 999, format: 'json' } } });
    });
    await settle();
    expect(countInput().value).toBe('33');
    expect(radio(/^HTML/).getAttribute('aria-checked')).toBe('true');
  });

  it('a chat that disappears from the list (it was downloaded, or removed from Discord) says so', async () => {
    const { platform } = await renderPopup();
    await openEditor(GENERAL);
    await act(async () => {
      platform.write('local', { [LOCAL.queue(MOCK_ACCOUNT.id)]: queue(platform).filter((item) => item.key !== KEYS.general) });
    });
    await settle();
    expect(screen.getByText('이 채팅은 더 이상 목록에 없어요.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '저장' })).toBeNull();
    fireEvent.click(button('닫기'));
    await settle();
    expect(screen.getByRole('button', { name: '기록' })).toBeTruthy();
  });
});

describe('English', () => {
  it('the same editor in English', async () => {
    await renderPopup({ settings: { language: 'en' } });
    fireEvent.click(within(row(ANNOUNCEMENTS)).getByRole('button', { name: `Settings of ${ANNOUNCEMENTS}` }));
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: 'Chat settings' })).toBeTruthy();
    expect(screen.getByText('This chat has settings of its own. Changing the common settings does not affect it.')).toBeTruthy();
    expect(screen.getByText('Common settings: 200 messages · HTML · No date range')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset to common settings' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset to common settings' }));
    await settle();
    expect(row(ANNOUNCEMENTS).querySelector('.dce-badge')?.textContent).toBe('Common settings');
  });
});
