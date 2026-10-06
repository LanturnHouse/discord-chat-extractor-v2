import { act, render, screen, type RenderResult } from '@testing-library/react';
import { LOCAL, SESSION, type AppSettings, type ExportSettings, type ToBackground } from '@/shared';
import { PopupRoot } from '@/popup/PopupRoot';
import { createMockPlatform, MOCK_ACCOUNT, MOCK_GUILDS, type MockOptions, type MockPlatform } from '@/ui/platform/mock';
import { normalizeSettings } from '@/ui/platform/normalize';

export interface PopupHarness extends RenderResult {
  platform: MockPlatform;
}

/** Lets pending promises and microtasks (the mock answers on them) finish, inside `act`. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export interface RenderOptions extends MockOptions {
  pollMs?: number;
  /** Written into the settings before the popup opens. */
  settings?: Partial<AppSettings>;
  /** Change the platform before the popup opens (extra data, failures...). */
  prepare?: (platform: MockPlatform) => void;
  /**
   * The ids of the tree groups that are open when the popup starts (`LOCAL.uiExpanded`). The default opens "Sample Server", so the
   * chats of the sample data are all on screen; pass `[]` to see the tree as a first start shows it (everything collapsed).
   */
  expanded?: readonly string[];
}

/** The popup on a fresh mock platform (default scenario 'idle': five items, three history entries, no job), fully loaded. */
export async function renderPopup(options: RenderOptions = {}): Promise<PopupHarness> {
  const { pollMs = 600_000, settings, prepare, expanded = [MOCK_GUILDS.sample.id], ...mock } = options;
  const platform = createMockPlatform({ scenario: 'idle', ...mock });
  if (expanded.length > 0) platform.write('local', { [LOCAL.uiExpanded]: [...expanded] });
  if (settings !== undefined) platform.write('local', { [LOCAL.settings]: { ...normalizeSettings(platform.read('local', LOCAL.settings)), ...settings } });
  prepare?.(platform);
  const result = render(<PopupRoot platform={platform} pollMs={pollMs} />);
  await settle();
  await settle();
  return Object.assign(result, { platform });
}

/** The messages the popup sent (without the `status/get` poll). */
export function sentMessages(platform: MockPlatform, type?: ToBackground['type']): ToBackground[] {
  return platform.sent.filter((message) => message.type !== 'status/get' && (type === undefined || message.type === type));
}

export const storedSettings = (platform: MockPlatform): AppSettings => normalizeSettings(platform.read('local', LOCAL.settings));
export const storedCommon = (platform: MockPlatform): ExportSettings => storedSettings(platform).common;
export const storedQueue = (platform: MockPlatform): unknown => platform.read('local', LOCAL.queue(MOCK_ACCOUNT.id));
export const storedJob = (platform: MockPlatform): unknown => platform.read('session', SESSION.job);

/** The visible text of the whole popup. */
export const popupText = (): string => document.body.textContent ?? '';

export const button = (name: string | RegExp): HTMLElement => screen.getByRole('button', { name });

/** The `li` of a chat by what its label says: the text of the row ("#general", "Study Group › #questions") or its tooltip ("Sample Server > #general"). */
export function row(label: string): HTMLElement {
  const matches = Array.from(document.querySelectorAll<HTMLElement>('li[data-key]')).filter((li) => {
    const element = li.querySelector('.dce-row__label');
    return element !== null && (element.textContent === label || element.getAttribute('title') === label);
  });
  if (matches.length !== 1) throw new Error(`${matches.length} rows for ${label}`);
  return matches[0];
}

/** Every chat row on screen (not the group lines). */
export const chatRows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('li[data-key]'));

/** The group lines on screen (`li` of a server or category). */
export const groupRows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('li[data-group-id]'));
