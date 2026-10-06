import { createApp, type ContentApp } from '@/content/app';
import type { Scheduler } from '@/content/inject/injector';
import { LOCAL } from '@/shared/storageKeys';
import type { GroupInfo } from '@/shared/types';
import { installChrome, type ChromeMock } from './chromeMock';
import { GUILD, mount } from './fixtures';

/** A frame scheduler the test steers: nothing runs until `run()`. */
export interface ManualScheduler {
  schedule: Scheduler;
  /** Runs everything scheduled so far (once); returns how many callbacks ran. */
  run(): number;
  readonly pending: number;
}

export function manualScheduler(): ManualScheduler {
  let queue: (() => void)[] = [];
  return {
    schedule(run) {
      queue.push(run);
      return () => {
        queue = queue.filter((item) => item !== run);
      };
    },
    run() {
      const batch = queue;
      queue = [];
      for (const item of batch) item();
      return batch.length;
    },
    get pending() {
      return queue.length;
    },
  };
}

export const ACCOUNT = { id: '500000000000000001', username: 'tester', globalName: null, avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png' };

/** `Record<groupId, channelIds>` -> the stored `Record<groupId, GroupInfo>` of `LOCAL.groups` (PLAN §5.1). */
export function groupsValue(groups: Record<string, string[]>, guildId = GUILD): Record<string, GroupInfo> {
  const out: Record<string, GroupInfo> = {};
  for (const [id, channelIds] of Object.entries(groups)) {
    out[id] = { kind: id === guildId ? 'guild' : 'category', guildId, channelIds, updatedAt: 1_000 };
  }
  return out;
}

export interface BootOptions {
  html?: string;
  /** Extra `chrome.storage.local` contents. */
  stored?: Record<string, unknown>;
  /** Queue of the account (keys); default empty. */
  queue?: string[];
  /** The raw stored queue value (overrides `queue`; for malformed data). */
  rawQueue?: unknown;
  /**
   * Group lists of the account (`LOCAL.groups`): group id (a category id or the guild id) -> the channel ids it holds. Each group is
   * stored as a full `GroupInfo` (kind: the guild id means a server, anything else a category).
   */
  groups?: Record<string, string[]>;
  /** The raw stored groups value (overrides `groups`; for malformed data). */
  rawGroups?: unknown;
  /** Settings patch merged into the stored settings (omit to store none). */
  settings?: Record<string, unknown>;
  /** false = no stored account. */
  account?: boolean;
  /** Do not start the app (the test starts it itself). */
  noStart?: boolean;
  /** Use the real animation-frame scheduler instead of the manual one (smoke tests). */
  realFrames?: boolean;
}

export interface Booted {
  app: ContentApp;
  chrome: ChromeMock;
  scheduler: ManualScheduler;
  /** Lets MutationObserver callbacks run, then runs the scheduled frame(s) and once more for what they caused. */
  frame(): Promise<void>;
  /** Lets pending promises (storage reads, message answers) settle. */
  settle(): Promise<void>;
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Builds a page, a `chrome` mock and an app (started unless `noStart`); the first frame has already run. */
export async function boot(options: BootOptions = {}): Promise<Booted> {
  if (options.html !== undefined) mount(options.html);
  const stored: Record<string, unknown> = { ...(options.stored ?? {}) };
  if (options.account !== false) stored[LOCAL.lastAccount] = ACCOUNT;
  if (options.account !== false) {
    stored[LOCAL.queue(ACCOUNT.id)] = options.rawQueue !== undefined ? options.rawQueue : (options.queue ?? []).map((key) => ({ key }));
  }
  if (options.account !== false && (options.groups || options.rawGroups !== undefined)) {
    stored[LOCAL.groups(ACCOUNT.id)] = options.rawGroups !== undefined ? options.rawGroups : groupsValue(options.groups!);
  }
  if (options.settings) stored[LOCAL.settings] = options.settings;
  const chrome = installChrome(stored);
  const scheduler = manualScheduler();
  const app = createApp({ schedule: options.realFrames ? undefined : scheduler.schedule, aliveCheckMs: 10_000 });
  const booted: Booted = {
    app,
    chrome,
    scheduler,
    async frame() {
      await settle();
      scheduler.run();
      await settle();
      scheduler.run();
      await settle();
    },
    settle,
  };
  if (!options.noStart) {
    await app.start();
    await booted.frame();
  }
  return booted;
}
