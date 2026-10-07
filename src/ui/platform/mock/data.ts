import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_EXPORT_SETTINGS,
  LOCAL,
  SESSION,
  type AccountInfo,
  type AppSettings,
  type ChatTarget,
  type ExportSettings,
  type HistoryEntry,
  type InjectHealth,
  type ItemProgress,
  type JobState,
  type QueueItem,
  type ThemeTokens,
} from '@/shared';
import { formatTargetLabel } from '../../format/summary';
import type { ShortcutInfo } from '../types';
import { riskQueue, runningGroups, treeGroupSettings, treeGroups, treeQueue } from './tree';

/*
 * Sample data of the in-memory mock platform (docs/PLAN.md §10: fixtures use neutral names, never a real server, person or
 * account). Everything is created fresh by a function, so one scenario can never leak into the next. Free text that the
 * background worker or the engine would write (failure messages) is in Korean, the product's default language.
 */

export type MockScenario =
  | 'running' // a download is in progress (the default of the preview); the group rows show the progress of what is inside
  | 'tree' // the queue tree: servers, categories, compressed lines, a server with settings of its own, a DM, a few overrides
  | 'risk' // the tree with 12 chats, one that reads everything and one with 25,000 messages and threads: the start buttons ask first
  | 'idle' // a list with an own-settings item and a failed one, no job
  | 'empty' // nothing in the list
  | 'consent' // first run: the notice is shown
  | 'no-discord' // no Discord tab, no account
  | 'checking' // a Discord tab is open, the account is not known yet
  | 'unhealthy'; // the buttons could not be put on the Discord page

export const MOCK_SCENARIOS: readonly MockScenario[] = ['running', 'tree', 'risk', 'idle', 'empty', 'consent', 'no-discord', 'checking', 'unhealthy'];

/** A flat coloured circle with initials, as a data URI (the popup is never allowed to load anything else for a sample). */
export function placeholderAvatar(initials: string, color: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
    `<circle cx="32" cy="32" r="32" fill="${color}"/>` +
    `<text x="32" y="41" text-anchor="middle" font-family="sans-serif" font-size="26" font-weight="700" fill="#ffffff">${initials}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export const MOCK_ACCOUNT: AccountInfo = Object.freeze({
  id: '100000000000000001',
  username: 'sample_user',
  globalName: 'Sample User',
  avatarUrl: placeholderAvatar('SU', '#5865f2'),
});

export const MOCK_SHORTCUTS: readonly ShortcutInfo[] = Object.freeze([
  { name: 'add-current-chat', description: 'Add or remove the chat you are viewing in the download list', shortcut: 'Alt+Shift+D' },
]);

const GUILD_ID = '200000000000000001';

function channel(id: string, name: string): ChatTarget {
  return { kind: 'guild-channel', channelId: id, guildId: GUILD_ID, guildName: 'Sample Server', channelName: name, parentId: null, parentName: null };
}

export const MOCK_TARGETS = {
  general: channel('300000000000000001', 'general'),
  announcements: channel('300000000000000002', 'announcements'),
  dm: { kind: 'dm', channelId: '300000000000000003', guildId: null, guildName: null, channelName: 'Alex' } satisfies ChatTarget,
  questions: {
    kind: 'forum',
    channelId: '300000000000000004',
    guildId: '200000000000000002',
    guildName: 'Study Group',
    channelName: 'questions',
    parentId: null,
    parentName: null,
  } satisfies ChatTarget,
  thread: {
    kind: 'thread',
    channelId: '300000000000000005',
    guildId: GUILD_ID,
    guildName: 'Sample Server',
    channelName: 'weekend plans',
    parentId: '300000000000000001',
    parentName: 'general',
  } satisfies ChatTarget,
} as const;

/** An own-settings example: everything differs from the defaults. */
export function sampleOwnSettings(): ExportSettings {
  return {
    count: null,
    from: new Date(2026, 0, 1, 0, 0, 0, 0).toISOString(),
    to: new Date(2026, 2, 31, 23, 59, 59, 999).toISOString(),
    format: 'txt',
    htmlTheme: 'dark',
    includeAttachments: true,
    includeThreads: false,
    incremental: false,
    content: { includeBots: false, includeSystem: true, includeReactions: false, includeEmbeds: true },
  };
}

function item(target: ChatTarget, addedAt: number, settings: ExportSettings | null = null, extra: Partial<QueueItem> = {}): QueueItem {
  return { key: target.channelId, target: { ...target }, settings, addedAt, ...extra };
}

/** The list of the sample account: three that follow the common settings and one with settings of its own. */
export function sampleQueue(now: number): QueueItem[] {
  return [
    item(MOCK_TARGETS.general, now - 50_000),
    item(MOCK_TARGETS.announcements, now - 40_000, sampleOwnSettings()),
    item(MOCK_TARGETS.dm, now - 30_000),
  ];
}

/** The same list plus a chat that failed last time and a thread. */
export function sampleQueueWithFailure(now: number): QueueItem[] {
  return [
    ...sampleQueue(now),
    item(MOCK_TARGETS.questions, now - 20_000, null, {
      lastResult: { status: 'failed', message: '이 채널을 볼 권한이 없어요.', at: now - 5_000 },
    }),
    item(MOCK_TARGETS.thread, now - 10_000),
  ];
}

export function sampleHistory(now: number, accountId: string = MOCK_ACCOUNT.id): HistoryEntry[] {
  const settings = copySettings(DEFAULT_EXPORT_SETTINGS);
  return [
    {
      id: 'history-3',
      accountId,
      target: { ...MOCK_TARGETS.general },
      settings,
      finishedAt: now - 3_600_000,
      status: 'done',
      messageCount: 200,
      files: [{ filename: 'Discord Export/Sample Server - general (2026-10-06).html', downloadId: 11 }],
      error: null,
    },
    {
      id: 'history-2',
      accountId,
      target: { ...MOCK_TARGETS.dm },
      settings: { ...settings, format: 'md' },
      finishedAt: now - 86_400_000,
      status: 'partial',
      messageCount: 1_284,
      files: [{ filename: 'Discord Export/DM - Alex (2026-10-05) (부분).md', downloadId: 12 }],
      error: 'Discord가 요청을 제한해서 일부만 저장했어요.',
    },
    {
      id: 'history-1',
      accountId,
      target: { ...MOCK_TARGETS.questions },
      settings: { ...settings, format: 'json', includeThreads: true },
      finishedAt: now - 172_800_000,
      status: 'failed',
      messageCount: 0,
      files: [],
      error: '이 채널을 볼 권한이 없어요.',
    },
  ];
}

function copySettings(settings: ExportSettings): ExportSettings {
  return { ...settings, content: { ...settings.content } };
}

function progress(target: ChatTarget, patch: Partial<ItemProgress> = {}): ItemProgress {
  return { key: target.channelId, label: formatTargetLabel(target), status: 'waiting', phase: null, fetched: 0, expected: 200, error: null, files: [], ...patch };
}

/** A download in progress: one chat already done (and gone from the list), one running, two waiting. */
export function sampleRunningJob(now: number, accountId: string = MOCK_ACCOUNT.id): JobState {
  return {
    jobId: 'mock-job-1',
    accountId,
    startedAt: now - 45_000,
    finishedAt: null,
    state: 'running',
    pausedReason: null,
    zip: false,
    items: [
      progress(MOCK_TARGETS.thread, { status: 'done', phase: 'saving', fetched: 85, expected: 200, files: ['Discord Export/Sample Server - general - weekend plans (2026-10-06).html'] }),
      progress(MOCK_TARGETS.general, { status: 'running', phase: 'messages', fetched: 120, expected: 200 }),
      progress(MOCK_TARGETS.announcements, { expected: null }),
      progress(MOCK_TARGETS.dm),
    ],
  };
}

/**
 * What the background wrote when the first chat of the running job was done: a history entry (the chat itself is gone from the
 * list). The popup finds the chat's server again from it, so the group line of "Sample Server" keeps counting it (1/3, not 0/2).
 */
function finishedThreadEntry(now: number, accountId: string): HistoryEntry {
  const filename = 'Discord Export/Sample Server - general - weekend plans (2026-10-06).html';
  return {
    id: 'history-running-1',
    accountId,
    target: { ...MOCK_TARGETS.thread },
    settings: copySettings(DEFAULT_EXPORT_SETTINGS),
    finishedAt: now - 20_000,
    status: 'done',
    messageCount: 85,
    files: [{ filename, downloadId: 10 }],
    error: null,
  };
}

/** A theme record as the content script stores it. `vars` is empty here, so the popup shows its built-in palette for `scheme`. */
export function sampleTheme(scheme: 'dark' | 'light', now: number, lang: string = 'ko'): ThemeTokens {
  return {
    scheme,
    themeClasses: scheme === 'dark' ? ['theme-dark', 'theme-midnight'] : ['theme-light'],
    vars: {},
    lang,
    capturedAt: now,
  };
}

export function sampleSettings(patch: Partial<AppSettings> = {}): AppSettings {
  return { ...copyAppSettings(), ...patch };
}

function copyAppSettings(): AppSettings {
  return { ...DEFAULT_APP_SETTINGS, common: copySettings(DEFAULT_APP_SETTINGS.common) };
}

export interface MockInitialState {
  local: Record<string, unknown>;
  session: Record<string, unknown>;
  discordTabs: number;
  health: InjectHealth | null;
}

/** The storage contents of a scenario (what the background worker and the content script would have written by then). */
export function buildScenario(scenario: MockScenario, now: number): MockInitialState {
  const account = MOCK_ACCOUNT.id;
  const consented = sampleSettings({ consentAt: now - 86_400_000 });
  const healthy: InjectHealth = { ok: true, reason: null, checkedAt: now - 2_000 };
  const base: MockInitialState = {
    local: {
      [LOCAL.settings]: consented,
      [LOCAL.lastAccount]: { ...MOCK_ACCOUNT },
      [LOCAL.queue(account)]: sampleQueueWithFailure(now),
      [LOCAL.history(account)]: sampleHistory(now),
      [LOCAL.theme]: sampleTheme('dark', now),
    },
    session: { [SESSION.account]: { ...MOCK_ACCOUNT }, [SESSION.job]: null },
    discordTabs: 1,
    health: healthy,
  };
  switch (scenario) {
    case 'running':
      base.local[LOCAL.queue(account)] = [...sampleQueue(now), item(MOCK_TARGETS.questions, now - 20_000)];
      base.local[LOCAL.groups(account)] = runningGroups(now, MOCK_TARGETS);
      base.local[LOCAL.history(account)] = [finishedThreadEntry(now, account), ...sampleHistory(now, account)];
      base.session[SESSION.job] = sampleRunningJob(now);
      break;
    case 'tree':
      base.local[LOCAL.queue(account)] = treeQueue(now);
      base.local[LOCAL.groups(account)] = treeGroups(now);
      base.local[LOCAL.groupSettings(account)] = treeGroupSettings();
      break;
    case 'risk':
      base.local[LOCAL.queue(account)] = riskQueue(now);
      base.local[LOCAL.groups(account)] = treeGroups(now);
      base.local[LOCAL.groupSettings(account)] = treeGroupSettings();
      break;
    case 'idle':
      break;
    case 'empty':
      base.local[LOCAL.queue(account)] = [];
      break;
    case 'consent':
      base.local[LOCAL.settings] = sampleSettings({ consentAt: null });
      base.local[LOCAL.queue(account)] = [];
      base.local[LOCAL.history(account)] = [];
      break;
    case 'no-discord':
      base.session[SESSION.account] = null;
      base.discordTabs = 0;
      base.health = null;
      break;
    case 'checking':
      base.session[SESSION.account] = null;
      base.health = null;
      break;
    case 'unhealthy':
      base.health = { ok: false, reason: 'channel list not found', checkedAt: now - 1_000 };
      break;
  }
  return base;
}
