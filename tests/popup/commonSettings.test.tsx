// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings } from '@/shared';
import { endOfDayIso, startOfDayIso } from '@/ui/format/dates';
import { button, renderPopup, row, sentMessages, settle, storedCommon, storedSettings } from './helpers';

afterEach(cleanup); // vitest globals are off, so testing-library cannot register its own cleanup

const open = async (): Promise<void> => {
  fireEvent.click(button('공통 설정 열기'));
  await settle();
};
const countInput = (): HTMLInputElement => screen.getByRole('spinbutton', { name: '내보낼 메시지 개수' }) as HTMLInputElement;
const dateInput = (label: '시작일' | '종료일'): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement;
const radio = (name: string | RegExp): HTMLElement => screen.getByRole('radio', { name });
const defaults = (patch: Partial<ExportSettings> = {}): ExportSettings => ({ ...DEFAULT_EXPORT_SETTINGS, content: { ...DEFAULT_EXPORT_SETTINGS.content }, ...patch });
const lastPatch = (messages: ReturnType<typeof sentMessages>): Record<string, unknown> => (messages.at(-1) as { patch: Record<string, unknown> }).patch;

describe('the caret of the footer button opens the common settings (docs/PLAN.md §7.2, §7.3)', () => {
  it('as a screen of its own with the common variant of the panel: language and ZIP included', async () => {
    await renderPopup();
    await open();
    expect(screen.getByRole('heading', { level: 1, name: '공통 설정' })).toBeTruthy();
    expect(document.querySelector('[data-variant="common"]')).not.toBeNull();
    expect(screen.getByRole('radiogroup', { name: '언어' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'ZIP 하나로 받기' })).toBeTruthy();
    expect(screen.getByText('바뀐 내용은 바로 저장돼요. 따로 설정하지 않은 채팅은 모두 이 설정을 따라가요.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '저장' })).toBeNull(); // no save button: every change is saved at once
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: '공통 설정' }));
  });

  it('shows the stored common settings', async () => {
    await renderPopup({
      settings: { common: defaults({ count: 77, format: 'md', from: startOfDayIso('2026-02-03'), includeAttachments: true }), zipAll: true, language: 'ko' },
    });
    await open();
    expect(radio(/^Markdown/).getAttribute('aria-checked')).toBe('true');
    expect(countInput().value).toBe('77');
    expect(dateInput('시작일').value).toBe('2026-02-03');
    expect((screen.getByRole('checkbox', { name: '첨부파일 함께 저장' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'ZIP 하나로 받기' }) as HTMLInputElement).checked).toBe(true);
    expect(radio('한국어').getAttribute('aria-checked')).toBe('true');
  });
});

describe('every change is saved at once: settings/patch with `common` as a whole', () => {
  it('a format card', async () => {
    const { platform } = await renderPopup();
    await open();
    fireEvent.click(radio(/^Excel/));
    await settle();
    const patches = sentMessages(platform, 'settings/patch');
    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({ to: 'bg', type: 'settings/patch', patch: { common: defaults({ format: 'xlsx' }) } });
    expect(storedCommon(platform)).toEqual(defaults({ format: 'xlsx' }));
    expect(radio(/^Excel/).getAttribute('aria-checked')).toBe('true');
  });

  it('the HTML theme', async () => {
    const { platform } = await renderPopup();
    await open();
    fireEvent.click(radio('라이트'));
    await settle();
    expect(lastPatch(sentMessages(platform, 'settings/patch'))).toEqual({ common: defaults({ htmlTheme: 'light' }) });
  });

  it('the count, as a number typed, a quick pick and "전체"', async () => {
    const { platform } = await renderPopup();
    await open();
    fireEvent.change(countInput(), { target: { value: '350' } });
    await settle();
    expect(lastPatch(sentMessages(platform, 'settings/patch'))).toEqual({ common: defaults({ count: 350 }) });
    fireEvent.click(within(screen.getByRole('group', { name: '빠른 선택' })).getByRole('button', { name: '1,000' }));
    await settle();
    expect(lastPatch(sentMessages(platform, 'settings/patch'))).toEqual({ common: defaults({ count: 1000 }) });
    fireEvent.click(radio('전체'));
    await settle();
    expect(lastPatch(sentMessages(platform, 'settings/patch'))).toEqual({ common: defaults({ count: null }) });
    expect(storedCommon(platform).count).toBeNull();
  });

  it('the dates, as the local start of the first day and the local end of the last day', async () => {
    const { platform } = await renderPopup();
    await open();
    fireEvent.change(dateInput('시작일'), { target: { value: '2026-03-05' } });
    fireEvent.change(dateInput('종료일'), { target: { value: '2026-03-20' } });
    await settle();
    expect(lastPatch(sentMessages(platform, 'settings/patch'))).toEqual({
      common: defaults({ from: new Date(2026, 2, 5, 0, 0, 0, 0).toISOString(), to: new Date(2026, 2, 20, 23, 59, 59, 999).toISOString() }),
    });
    expect(storedCommon(platform).to).toBe(endOfDayIso('2026-03-20'));
    fireEvent.click(screen.getByRole('button', { name: '시작일 지우기' }));
    await settle();
    expect(lastPatch(sentMessages(platform, 'settings/patch'))).toEqual({ common: defaults({ to: endOfDayIso('2026-03-20') }) });
  });

  it('the extras of "더보기"', async () => {
    const { platform } = await renderPopup();
    await open();
    fireEvent.click(screen.getByRole('button', { name: '더보기' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '첨부파일 함께 저장' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '스레드 포함' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '새 메시지만 받기' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '봇 메시지 포함' }));
    await settle();
    expect(storedCommon(platform)).toEqual(
      defaults({ includeAttachments: true, includeThreads: true, incremental: true, content: { includeBots: false, includeSystem: true, includeReactions: true, includeEmbeds: true } }),
    );
    expect(sentMessages(platform, 'settings/patch')).toHaveLength(4);
  });

  it('"ZIP 하나로 받기" is zipAll', async () => {
    const { platform } = await renderPopup();
    await open();
    fireEvent.click(screen.getByRole('checkbox', { name: 'ZIP 하나로 받기' }));
    await settle();
    expect(lastPatch(sentMessages(platform, 'settings/patch'))).toEqual({ zipAll: true });
    expect(storedSettings(platform).zipAll).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'ZIP 하나로 받기' }));
    await settle();
    expect(lastPatch(sentMessages(platform, 'settings/patch'))).toEqual({ zipAll: false });
  });

  it('the language, which also changes the app language at once', async () => {
    const { platform } = await renderPopup();
    await open();
    fireEvent.click(radio('English'));
    // the screen is English before the background has answered
    expect(screen.getByRole('heading', { level: 1, name: 'Common settings' })).toBeTruthy();
    await settle();
    expect(lastPatch(sentMessages(platform, 'settings/patch'))).toEqual({ language: 'en' });
    expect(storedSettings(platform).language).toBe('en');
    expect(screen.getByRole('radiogroup', { name: 'Language' })).toBeTruthy();
    fireEvent.click(radio('한국어'));
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: '공통 설정' })).toBeTruthy();
    expect(storedSettings(platform).language).toBe('ko');
    fireEvent.click(radio('자동'));
    await settle();
    expect(storedSettings(platform).language).toBe('auto');
  });

  it('a change keeps what was changed before: the next patch carries all of `common`', async () => {
    const { platform } = await renderPopup();
    await open();
    fireEvent.click(radio(/^CSV/));
    fireEvent.change(countInput(), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: '더보기' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '새 메시지만 받기' }));
    await settle();
    expect(lastPatch(sentMessages(platform, 'settings/patch'))).toEqual({ common: defaults({ format: 'csv', count: 12, incremental: true }) });
  });

  it('quick changes in a row (before the background answered) lose nothing', async () => {
    const { platform } = await renderPopup();
    await open();
    // no settle between the clicks
    fireEvent.click(radio(/^TXT/));
    fireEvent.click(radio(/^JSON/));
    fireEvent.click(radio(/^CSV/));
    fireEvent.change(countInput(), { target: { value: '5' } });
    await settle();
    expect(storedCommon(platform)).toEqual(defaults({ format: 'csv', count: 5 }));
    expect(radio(/^CSV/).getAttribute('aria-checked')).toBe('true');
    expect(countInput().value).toBe('5');
  });
});

describe('what is not valid is not saved', () => {
  it('a bad count or an inverted range: the alert, no message, and the stored settings stay', async () => {
    const { platform } = await renderPopup();
    await open();
    fireEvent.change(countInput(), { target: { value: '0' } });
    expect(screen.getByRole('alert').textContent).toBe('1에서 1,000,000 사이의 숫자를 입력하세요.');
    fireEvent.change(dateInput('시작일'), { target: { value: '2026-03-20' } });
    fireEvent.change(dateInput('종료일'), { target: { value: '2026-03-05' } });
    await settle();
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain('시작일이 종료일보다 늦어요.');
    expect(sentMessages(platform, 'settings/patch')).toEqual([]);
    expect(storedCommon(platform)).toEqual(defaults());
  });

  it('the settings that are valid before a field became invalid stay saved', async () => {
    const { platform } = await renderPopup();
    await open();
    fireEvent.click(radio(/^TXT/));
    fireEvent.change(countInput(), { target: { value: '' } });
    await settle();
    expect(storedCommon(platform)).toEqual(defaults({ format: 'txt' }));
  });
});

describe('the background refuses', () => {
  it('the change is taken back and the reason is shown', async () => {
    const { platform } = await renderPopup({ prepare: (mock) => mock.failNext('settings/patch', 'unknown', 'storage is full') });
    await open();
    fireEvent.click(radio(/^JSON/));
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('(storage is full)');
    expect(radio(/^HTML/).getAttribute('aria-checked')).toBe('true');
    expect(storedCommon(platform).format).toBe('html');
  });
});

describe('leaving the common settings', () => {
  it('the back arrow and Escape return to the list, the focus is on the caret again', async () => {
    await renderPopup();
    await open();
    fireEvent.click(button('뒤로'));
    await settle();
    expect(screen.queryByRole('heading', { level: 1, name: '공통 설정' })).toBeNull();
    expect(document.activeElement).toBe(button('공통 설정 열기'));
    await open();
    fireEvent.keyDown(document, { key: 'Escape' });
    await settle();
    expect(screen.getByRole('button', { name: '기록' })).toBeTruthy();
    expect(document.activeElement).toBe(button('공통 설정 열기'));
  });

  it('what was set shows on the main screen: the format chip and the summaries of the chats that follow the common settings', async () => {
    await renderPopup();
    await open();
    fireEvent.click(radio(/^Excel/));
    fireEvent.change(countInput(), { target: { value: '25' } });
    fireEvent.click(button('뒤로'));
    await settle();
    expect(button(/전체 다운로드/).querySelector('.dce-split__chip')?.textContent).toBe('XLSX');
    expect(row('Alex').querySelector('.dce-row__summary')?.textContent).toBe('25개 · XLSX · 기간 없음');
    // the chat with settings of its own is not touched
    expect(row('Sample Server > #announcements').querySelector('.dce-row__summary')?.textContent).toBe('전체 · TXT · 2026-01-01 ~ 2026-03-31 · 첨부');
  });

  it('opens with an empty list too (the options stay reachable)', async () => {
    await renderPopup({ scenario: 'empty' });
    await open();
    expect(screen.getByRole('heading', { level: 1, name: '공통 설정' })).toBeTruthy();
  });

  it('the settings panel is the one of the common settings after returning (not an old draft)', async () => {
    await renderPopup();
    await open();
    fireEvent.change(countInput(), { target: { value: '0' } });
    fireEvent.click(button('뒤로'));
    await open();
    expect(countInput().value).toBe('200');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('in English', async () => {
    await renderPopup({ settings: { language: 'en' } });
    fireEvent.click(button('Open the common settings'));
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: 'Common settings' })).toBeTruthy();
    expect(screen.getByText('Changes are saved right away. Every chat without settings of its own follows these.')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Save as one ZIP' })).toBeTruthy();
  });
});
