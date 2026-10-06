// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appSettingsStrings } from '@/popup/strings';
import { MAX_FOLDER_NAME_LENGTH, checkFolderName } from '@/popup/views/AppSettingsView';
import { button, renderPopup, sentMessages, settle, storedSettings } from './helpers';

afterEach(() => {
  cleanup(); // vitest globals are off, so testing-library cannot register its own cleanup
  vi.restoreAllMocks();
});

const open = async (): Promise<void> => {
  fireEvent.click(button('설정'));
  await settle();
};
const folder = (): HTMLInputElement => screen.getByLabelText('폴더 이름') as HTMLInputElement;
const switchOf = (name: string): HTMLInputElement => screen.getByRole('switch', { name }) as HTMLInputElement;
const patches = (platform: Parameters<typeof sentMessages>[0]): unknown[] => sentMessages(platform, 'settings/patch').map((message) => (message as { patch: unknown }).patch);

describe('the app settings (the gear of the header; docs/PLAN.md §7.2)', () => {
  it('opens as a screen of its own with every setting of the plan', async () => {
    await renderPopup();
    await open();
    expect(screen.getByRole('heading', { level: 1, name: '설정' })).toBeTruthy();
    expect(folder().value).toBe('Discord Export');
    expect(switchOf('파일 이름에 날짜 넣기').checked).toBe(true);
    expect(screen.getByLabelText('시간대')).toBeTruthy();
    expect(switchOf('다운로드가 끝나면 알림 받기').checked).toBe(true);
    expect(screen.getByText('보고 있는 채팅 담기·빼기')).toBeTruthy();
    expect(screen.getByRole('button', { name: '변경' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '약관·위험 안내 다시 보기' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: '설정' }));
  });

  it('shows the stored values', async () => {
    await renderPopup({ settings: { folderName: 'My Backups', dateInFileName: false, notifyOnComplete: false, timeZone: 'Asia/Seoul' } });
    await open();
    expect(folder().value).toBe('My Backups');
    expect(switchOf('파일 이름에 날짜 넣기').checked).toBe(false);
    expect(switchOf('다운로드가 끝나면 알림 받기').checked).toBe(false);
    expect((screen.getByLabelText('시간대') as HTMLSelectElement).value).toBe('Asia/Seoul');
  });

  it('the back arrow and Escape return to the list; the focus is on the gear again', async () => {
    await renderPopup();
    await open();
    fireEvent.click(button('뒤로'));
    await settle();
    expect(screen.queryByRole('heading', { level: 1, name: '설정' })).toBeNull();
    expect(document.activeElement).toBe(button('설정'));
    await open();
    fireEvent.keyDown(document, { key: 'Escape' });
    await settle();
    expect(screen.getByRole('button', { name: '기록' })).toBeTruthy();
  });
});

describe('the switches are saved at once (settings/patch)', () => {
  it('date in file name and notification', async () => {
    const { platform } = await renderPopup();
    await open();
    fireEvent.click(switchOf('파일 이름에 날짜 넣기'));
    await settle();
    fireEvent.click(switchOf('다운로드가 끝나면 알림 받기'));
    await settle();
    expect(patches(platform)).toEqual([{ dateInFileName: false }, { notifyOnComplete: false }]);
    expect(storedSettings(platform)).toMatchObject({ dateInFileName: false, notifyOnComplete: false });
    expect(switchOf('다운로드가 끝나면 알림 받기').checked).toBe(false);
    fireEvent.click(switchOf('다운로드가 끝나면 알림 받기'));
    await settle();
    expect(patches(platform).at(-1)).toEqual({ notifyOnComplete: true });
  });

  it('a refused switch goes back, with the reason', async () => {
    const { platform } = await renderPopup({ prepare: (mock) => mock.failNext('settings/patch', 'unknown') });
    await open();
    fireEvent.click(switchOf('다운로드가 끝나면 알림 받기'));
    await settle();
    expect(switchOf('다운로드가 끝나면 알림 받기').checked).toBe(true);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(storedSettings(platform).notifyOnComplete).toBe(true);
  });
});

describe('option #17 "always show queued chats" is retired (4th change: the row buttons are always visible)', () => {
  const ko = ['담긴 채팅을 디스코드에 계속 표시', '꺼 두면 마우스를 올렸을 때만 ⤓ 버튼이 보여요.'];
  const en = ['Always show chats that are in the list', 'When off, the ⤓ button only shows on hover.'];

  it('the toggle is gone: only the two remaining switches are left on the screen, in Korean', async () => {
    await renderPopup();
    await open();
    for (const text of ko) expect(screen.queryByText(text)).toBeNull();
    expect(screen.queryByRole('switch', { name: ko[0] })).toBeNull();
    expect(screen.getAllByRole('switch')).toHaveLength(2); // the date in file names and the completion notification
    expect(document.body.textContent).not.toMatch(/계속 표시|마우스를 올렸을 때만/);
  });

  it('...and in English', async () => {
    await renderPopup({ settings: { language: 'en' } });
    fireEvent.click(button('Settings'));
    await settle();
    for (const text of en) expect(screen.queryByText(text)).toBeNull();
    expect(screen.getAllByRole('switch')).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/Always show chats|only shows on hover/);
  });

  it('the strings are gone in both languages (ko/en stay in parity)', () => {
    for (const language of ['ko', 'en'] as const) {
      const strings = appSettingsStrings[language] as Record<string, unknown>;
      expect(Object.keys(strings), language).not.toContain('showQueuedIndicator');
      expect(Object.keys(strings), language).not.toContain('showQueuedIndicatorHelp');
    }
    expect(Object.keys(appSettingsStrings.ko).sort()).toEqual(Object.keys(appSettingsStrings.en).sort());
  });

  it('the stored value is neither shown nor touched by anything on this screen', async () => {
    const { platform } = await renderPopup({ settings: { showQueuedIndicator: true } });
    await open();
    fireEvent.click(switchOf('파일 이름에 날짜 넣기'));
    fireEvent.click(switchOf('다운로드가 끝나면 알림 받기'));
    await settle();
    expect(patches(platform).every((patch) => !('showQueuedIndicator' in (patch as object)))).toBe(true);
    expect(storedSettings(platform).showQueuedIndicator).toBe(true);
  });
});

describe('the folder name', () => {
  it('is saved when the field is left (blur), trimmed', async () => {
    const { platform } = await renderPopup();
    await open();
    fireEvent.change(folder(), { target: { value: '  My Backups  ' } });
    expect(patches(platform)).toEqual([]); // not half-way
    fireEvent.blur(folder());
    await settle();
    expect(patches(platform)).toEqual([{ folderName: 'My Backups' }]);
    expect(storedSettings(platform).folderName).toBe('My Backups');
    expect(folder().value).toBe('My Backups');
  });

  it('is saved on Enter', async () => {
    const { platform } = await renderPopup();
    await open();
    fireEvent.change(folder(), { target: { value: 'Archive' } });
    fireEvent.keyDown(folder(), { key: 'Enter' });
    await settle();
    expect(patches(platform)).toEqual([{ folderName: 'Archive' }]);
  });

  it('is saved when the screen closes without leaving the field (once)', async () => {
    const { platform } = await renderPopup();
    await open();
    fireEvent.change(folder(), { target: { value: 'Closed Early' } });
    fireEvent.click(button('뒤로'));
    await settle();
    expect(patches(platform)).toEqual([{ folderName: 'Closed Early' }]);
    expect(storedSettings(platform).folderName).toBe('Closed Early');
  });

  it('saving twice the same name sends nothing the second time', async () => {
    const { platform } = await renderPopup();
    await open();
    fireEvent.change(folder(), { target: { value: 'Same' } });
    fireEvent.blur(folder());
    await settle();
    fireEvent.keyDown(folder(), { key: 'Enter' });
    fireEvent.blur(folder());
    fireEvent.click(button('뒤로'));
    await settle();
    expect(patches(platform)).toEqual([{ folderName: 'Same' }]);
  });

  it('an unchanged name sends nothing', async () => {
    const { platform } = await renderPopup();
    await open();
    fireEvent.blur(folder());
    fireEvent.click(button('뒤로'));
    await settle();
    expect(patches(platform)).toEqual([]);
  });

  it('an empty name, a name with characters no file system accepts, or a too long one: an alert, nothing saved', async () => {
    const { platform } = await renderPopup();
    await open();
    for (const [text, message] of [
      ['', '폴더 이름을 입력하세요.'],
      ['   ', '폴더 이름을 입력하세요.'],
      ['a/b', '폴더 이름에는 \\ / : * ? " < > | 문자를 쓸 수 없어요.'],
      ['a\\b', '폴더 이름에는 \\ / : * ? " < > | 문자를 쓸 수 없어요.'],
      ['a:b', '폴더 이름에는 \\ / : * ? " < > | 문자를 쓸 수 없어요.'],
      ['what?', '폴더 이름에는 \\ / : * ? " < > | 문자를 쓸 수 없어요.'],
      ['x'.repeat(MAX_FOLDER_NAME_LENGTH + 1), `폴더 이름은 ${MAX_FOLDER_NAME_LENGTH}자 이하로 해 주세요.`],
    ] as const) {
      fireEvent.change(folder(), { target: { value: text } });
      expect(screen.getByRole('alert').textContent, text).toBe(message);
      expect(folder().getAttribute('aria-invalid')).toBe('true');
      fireEvent.blur(folder());
    }
    fireEvent.click(button('뒤로'));
    await settle();
    expect(patches(platform)).toEqual([]);
    expect(storedSettings(platform).folderName).toBe('Discord Export');
  });

  it('a valid name after a bad one is saved, and the alert goes away', async () => {
    const { platform } = await renderPopup();
    await open();
    fireEvent.change(folder(), { target: { value: 'a/b' } });
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.change(folder(), { target: { value: 'ab' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.blur(folder());
    await settle();
    expect(patches(platform)).toEqual([{ folderName: 'ab' }]);
  });

  it('what the folder name check says', () => {
    expect(checkFolderName('Discord Export')).toBeNull();
    expect(checkFolderName('내 백업 폴더')).toBeNull();
    expect(checkFolderName('a b.c')).toBeNull();
    expect(checkFolderName(' ')).toBe('empty');
    expect(checkFolderName('a|b')).toBe('chars');
    expect(checkFolderName('a"b')).toBe('chars');
    expect(checkFolderName('a<b>')).toBe('chars');
    expect(checkFolderName('a\u0007b')).toBe('chars'); // a control character
    expect(checkFolderName('x'.repeat(MAX_FOLDER_NAME_LENGTH))).toBeNull();
    expect(checkFolderName('x'.repeat(MAX_FOLDER_NAME_LENGTH + 1))).toBe('long');
    expect(checkFolderName('가'.repeat(MAX_FOLDER_NAME_LENGTH))).toBeNull(); // counted in characters
  });
});

describe('the time zone', () => {
  it('is "auto" (the browser zone) plus every IANA zone of the browser', async () => {
    await renderPopup();
    await open();
    const select = screen.getByLabelText('시간대') as HTMLSelectElement;
    expect(select.value).toBe('auto');
    const options = Array.from(select.options).map((option) => option.value);
    expect(options[0]).toBe('auto');
    expect(select.options[0].textContent).toMatch(/^자동 \(/);
    for (const zone of ['Asia/Seoul', 'America/New_York', 'Europe/London', 'UTC']) expect(options).toContain(zone);
    expect(options.length).toBeGreaterThan(100);
    expect(new Set(options).size).toBe(options.length);
  });

  it('choosing a zone sends settings/patch { timeZone }, and "auto" again', async () => {
    const { platform } = await renderPopup();
    await open();
    fireEvent.change(screen.getByLabelText('시간대'), { target: { value: 'Asia/Seoul' } });
    await settle();
    fireEvent.change(screen.getByLabelText('시간대'), { target: { value: 'auto' } });
    await settle();
    expect(patches(platform)).toEqual([{ timeZone: 'Asia/Seoul' }, { timeZone: 'auto' }]);
    expect(storedSettings(platform).timeZone).toBe('auto');
  });

  it('a stored zone this browser does not list stays selectable', async () => {
    await renderPopup({ settings: { timeZone: 'Mars/Olympus_Mons' } });
    await open();
    const select = screen.getByLabelText('시간대') as HTMLSelectElement;
    expect(select.value).toBe('Mars/Olympus_Mons');
  });
});

describe('the keyboard shortcut (docs/PLAN.md §7.1 #15)', () => {
  it('is shown from chrome.commands, key by key', async () => {
    await renderPopup();
    await open();
    const keys = within(screen.getByRole('group', { name: '보고 있는 채팅 담기·빼기' }));
    expect(keys.getAllByText(/^(Alt|Shift|D)$/).map((key) => key.textContent)).toEqual(['Alt', 'Shift', 'D']);
    expect(document.querySelectorAll('.dce-shortcut kbd')).toHaveLength(3);
  });

  it('"설정 안 됨" when no key is assigned', async () => {
    await renderPopup({ prepare: (platform) => platform.setShortcuts([{ name: 'add-current-chat', description: '', shortcut: '' }]) });
    await open();
    expect(screen.getByText('설정 안 됨')).toBeTruthy();
    expect(document.querySelector('.dce-shortcut kbd')).toBeNull();
  });

  it('"설정 안 됨" when the command is not even known', async () => {
    await renderPopup({ prepare: (platform) => platform.setShortcuts([]) });
    await open();
    expect(screen.getByText('설정 안 됨')).toBeTruthy();
  });

  it('[변경] opens chrome://extensions/shortcuts in a new tab', async () => {
    const { platform } = await renderPopup();
    let opened = 0;
    platform.openShortcutSettings = async () => {
      opened++;
    };
    await open();
    fireEvent.click(screen.getByRole('button', { name: '변경' }));
    await settle();
    expect(opened).toBe(1);
  });
});

describe('"약관·위험 안내 다시 보기"', () => {
  it('shows the notice again, read-only, with the time the user agreed', async () => {
    await renderPopup({ settings: { consentAt: Date.UTC(2026, 9, 6, 6, 4, 0), timeZone: 'UTC' } });
    await open();
    fireEvent.click(screen.getByRole('button', { name: '약관·위험 안내 다시 보기' }));
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: '약관·위험 안내' })).toBeTruthy();
    expect(screen.getByText('디스코드 이용약관과 계정 위험')).toBeTruthy();
    expect(screen.getByText(/계정이 경고를 받거나 제한·정지될 수 있어요/)).toBeTruthy();
    expect(screen.getByText(/2026\. 10\. 6\..*에 동의했어요\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '동의하고 시작' })).toBeNull(); // it is not asked again
  });

  it('does not take the consent away: after it the app is still usable', async () => {
    const { platform } = await renderPopup();
    await open();
    fireEvent.click(screen.getByRole('button', { name: '약관·위험 안내 다시 보기' }));
    fireEvent.click(button('닫기'));
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: '설정' })).toBeTruthy(); // back on the app settings
    expect(storedSettings(platform).consentAt).not.toBeNull();
    expect(sentMessages(platform, 'settings/patch')).toEqual([]);
  });

  it('the back arrow and Escape go back one screen at a time, the focus follows', async () => {
    await renderPopup();
    await open();
    fireEvent.click(screen.getByRole('button', { name: '약관·위험 안내 다시 보기' }));
    await settle();
    fireEvent.keyDown(document, { key: 'Escape' });
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: '설정' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '약관·위험 안내 다시 보기' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('heading', { level: 1, name: '설정' })).toBeNull();
    expect(document.activeElement).toBe(button('설정'));
  });
});

describe('English', () => {
  it('the same screen in English', async () => {
    await renderPopup({ settings: { language: 'en' } });
    fireEvent.click(button('Settings'));
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(screen.getByLabelText('Folder name')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Put the date in file names' })).toBeTruthy();
    expect(screen.getByLabelText('Time zone')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Notify me when a download is done' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Read the terms and risk notice again' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'a*b' } });
    expect(screen.getByRole('alert').textContent).toBe('A folder name cannot contain \\ / : * ? " < > |');
  });
});
