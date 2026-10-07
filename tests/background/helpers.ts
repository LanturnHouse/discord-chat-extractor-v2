/**
 * Shared test helpers for the background worker and the offscreen host: waiting for async chains, builders for the shared data
 * types, a fake Discord API behind `fetch`, booting the worker against a `FakeBrowser`, and wiring the offscreen host (with
 * the stub engine or any `EngineRunner`) into the fake's offscreen document.
 *
 * Fixtures use neutral names and made-up ids; the token below is not a real one.
 */
import { vi } from 'vitest';
import { LOCAL, SESSION } from '@/shared';
import type {
  AccountInfo,
  AppSettings,
  ChatTarget,
  EngineJob,
  ExportSettings,
  HistoryEntry,
  ItemProgress,
  JobState,
  QueueItem,
} from '@/shared';
import { startOffscreenHost } from '@/offscreen/host';
import type { HostDeps, OffscreenHost } from '@/offscreen/host';
import type { EngineIO, EngineRunner } from '@/offscreen/runner';
import { createStubRunner } from '@/offscreen/stubEngine';
import { EXTENSION_URL, FakeBrowser } from './fakeChrome';
import type { FakePage } from './fakeChrome';

export const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'Gabcde', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.'); // fake value, built from parts so secret scanners do not mistake it for a real token
export const OTHER_TOKEN = ['ODc2NTQzMjEwOTg3NjU0MzIx', 'Gxyzab', 'zyxwvutsrqponmlkjihgfedcba9876543210'].join('.'); // fake value, built from parts so secret scanners do not mistake it for a real token

export const ACCOUNT_ID = '100000000000000001';
export const OTHER_ACCOUNT_ID = '100000000000000002';
export const GUILD_ID = '200000000000000001';
export const CATEGORY_ID = '300000000000000001';
export const CHANNEL_A = '400000000000000001';
export const CHANNEL_B = '400000000000000002';
export const CHANNEL_C = '400000000000000003';
export const DM_CHANNEL = '500000000000000001';

export const DISCORD_URL = 'https://discord.com/channels/@me';

// ---- waiting ---------------------------------------------------------------------------------------------------------------

/** Lets pending promise chains and microtasks run (works with and without fake timers). Real timers are NOT advanced. */
export async function settle(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise<void>((resolve) => setImmediate(resolve)); // not setTimeout(0): Windows rounds that up to ~15 ms
  }
}

/**
 * Waits until `predicate` returns something truthy and returns it; throws when it never does. With fake timers every round just
 * lets promises run (time does not move); with real timers the first rounds yield cheaply and later ones sleep 2 ms, so code
 * that waits for a real `setTimeout` (the stub engine's pauses) gets a fair chance: up to a few seconds in all.
 */
export async function waitFor<T>(predicate: () => T | Promise<T>, rounds = 500): Promise<NonNullable<T>> {
  for (let round = 0; round < rounds; round += 1) {
    const value = await predicate();
    if (value) return value as NonNullable<T>;
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else if (round < 30) await new Promise<void>((resolve) => setImmediate(resolve));
    else await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('waitFor: the condition never became true');
}

// ---- data builders ---------------------------------------------------------------------------------------------------------

export function guildTarget(channelId = CHANNEL_A, overrides: Partial<ChatTarget> = {}): ChatTarget {
  return { kind: 'guild-channel', channelId, guildId: GUILD_ID, guildName: 'Test Server', channelName: 'general', ...overrides };
}

export function dmTarget(channelId = DM_CHANNEL, overrides: Partial<ChatTarget> = {}): ChatTarget {
  return { kind: 'dm', channelId, guildId: null, guildName: null, channelName: 'Friend', ...overrides };
}

export function exportSettings(overrides: Partial<ExportSettings> = {}): ExportSettings {
  return {
    count: 200,
    from: null,
    to: null,
    format: 'html',
    htmlTheme: 'dark',
    includeAttachments: false,
    includeThreads: false,
    incremental: false,
    content: { includeBots: true, includeSystem: true, includeReactions: true, includeEmbeds: true },
    ...overrides,
  };
}

export function queueItem(target: ChatTarget = guildTarget(), overrides: Partial<QueueItem> = {}): QueueItem {
  return { key: target.channelId, target, settings: null, addedAt: 1_700_000_000_000, ...overrides };
}

export function accountInfo(id = ACCOUNT_ID, overrides: Partial<AccountInfo> = {}): AccountInfo {
  return { id, username: 'tester', globalName: 'Tester', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png', ...overrides };
}

// ---- fake Discord API behind fetch -----------------------------------------------------------------------------------------

export interface FakeApiCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
}

export interface FakeDiscordApi {
  calls: FakeApiCall[];
  /** `users/@me` answers by authorization value. A token that is not here gets a 401. */
  users: Map<string, Record<string, unknown>>;
  /** `guilds/{id}/channels` answers by guild id. */
  guildChannels: Map<string, unknown>;
  /** `guilds/{id}/roles` answers by guild id. */
  guildRoles: Map<string, unknown>;
  /** `guilds/{id}` (the guild object) answers by guild id. */
  guilds: Map<string, unknown>;
  /** `users/@me/guilds/{id}/member` (the account's own member) answers by guild id. */
  members: Map<string, unknown>;
  /** `guilds/{id}/members/@me` answers by guild id: the fallback of the endpoint above. */
  membersAtMe: Map<string, unknown>;
  /**
   * Forces a status (or a network error) for ONE path, written like the code requests it, without the origin
   * (`/api/v9/guilds/1/roles`). Beats the answers above; every other path keeps answering normally.
   */
  pathFailures: Map<string, number | 'network'>;
  /** Forces this status for every request (e.g. 429, 500); 'network' makes fetch reject. */
  force: number | 'network' | null;
  /** Holds every answer until released (to test overlapping calls). */
  gate: Promise<void> | null;
}

/** Replaces `fetch` with a fake of the endpoints the worker uses. Remember `vi.unstubAllGlobals()` in afterEach. */
export function installFakeDiscordApi(): FakeDiscordApi {
  const api: FakeDiscordApi = {
    calls: [],
    users: new Map(),
    guildChannels: new Map(),
    guildRoles: new Map(),
    guilds: new Map(),
    members: new Map(),
    membersAtMe: new Map(),
    pathFailures: new Map(),
    force: null,
    gate: null,
  };
  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  /** The guild endpoints: path -> where the answer for the guild id in it lives (anything not stored there is a 404). */
  const guildAnswers: Array<[RegExp, Map<string, unknown>]> = [
    [/^\/api\/v9\/guilds\/(\d+)\/channels$/, api.guildChannels],
    [/^\/api\/v9\/guilds\/(\d+)\/roles$/, api.guildRoles],
    [/^\/api\/v9\/guilds\/(\d+)\/members\/@me$/, api.membersAtMe],
    [/^\/api\/v9\/guilds\/(\d+)$/, api.guilds],
    [/^\/api\/v9\/users\/@me\/guilds\/(\d+)\/member$/, api.members],
  ];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      api.calls.push({ url, method: init?.method, headers, credentials: init?.credentials });
      if (api.gate) await api.gate;
      if (api.force === 'network') throw new TypeError('Failed to fetch');
      if (api.force !== null) return respond(api.force, { message: 'forced' });
      const path = url.replace('https://discord.com', '');
      const failure = api.pathFailures.get(path);
      if (failure === 'network') throw new TypeError('Failed to fetch');
      if (failure !== undefined) return respond(failure, { message: 'forced', code: 0 });
      // every endpoint needs an authorization Discord knows
      const user = api.users.get(headers.Authorization);
      if (!user) return respond(401, { message: '401: Unauthorized', code: 0 });
      if (path === '/api/v9/users/@me') return respond(200, user);
      for (const [pattern, answers] of guildAnswers) {
        const match = pattern.exec(path);
        if (!match) continue;
        return answers.has(match[1]) ? respond(200, answers.get(match[1])) : respond(404, { message: 'Unknown Guild' });
      }
      return respond(404, { message: 'not found' });
    }),
  );
  return api;
}

export const userPayload = (id = ACCOUNT_ID, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  username: 'tester',
  global_name: 'Tester',
  avatar: 'abcdef0123456789',
  ...overrides,
});

/** VIEW_CHANNEL (1 << 10) | READ_MESSAGE_HISTORY (1 << 16), as the API sends permissions: a decimal string. */
export const READ_PERMISSIONS = String((1n << 10n) | (1n << 16n));

/**
 * Gives `guildId` the answers of a guild whose plain member (the account, no extra roles, not the owner) may read everything:
 * the @everyone role (its id is the guild's) has VIEW_CHANNEL and READ_MESSAGE_HISTORY and no channel overwrites hide anything.
 * What the category and server buttons need beside the channel list (`api.guildChannels`).
 */
export function seedGuildAccess(api: FakeDiscordApi, guildId = GUILD_ID): void {
  const roles = [{ id: guildId, name: '@everyone', permissions: READ_PERMISSIONS, position: 0 }];
  api.guildRoles.set(guildId, roles);
  api.guilds.set(guildId, { id: guildId, name: 'Test Server', owner_id: OTHER_ACCOUNT_ID, roles });
  api.members.set(guildId, { user: { id: ACCOUNT_ID }, roles: [] });
}

// ---- booting ---------------------------------------------------------------------------------------------------------------

/**
 * Loads the worker (`src/background/index.ts`) as a fresh module against `fake`: every call starts with clean module state
 * (token capture, locks, throttles, the consent answer), exactly like a newly started service worker.
 */
export async function bootWorker(fake: FakeBrowser, options: { agreed?: boolean } = {}): Promise<void> {
  // The user has agreed on the first-run screen, unless the test says otherwise (`agreed: false`) or seeded settings of its own.
  if (options.agreed !== false && !fake.local.has(LOCAL.settings)) seedConsent(fake);
  vi.resetModules();
  vi.stubGlobal('chrome', fake.chrome);
  await import('@/background/index');
  await settle();
}

export interface LoggedIn {
  popup: FakePage;
  api: FakeDiscordApi;
}

/**
 * The worker is up and `TOKEN` was captured from a Discord request and verified as `ACCOUNT_ID`: `SESSION.account` is set.
 * Returns an open popup context and the fake API.
 */
export async function bootLoggedIn(fake: FakeBrowser, accountId = ACCOUNT_ID): Promise<LoggedIn> {
  const api = installFakeDiscordApi();
  api.users.set(TOKEN, userPayload(accountId));
  await bootWorker(fake);
  fake.captureToken(TOKEN);
  await waitFor(() => fake.session.peek(SESSION.account));
  return { popup: fake.createPage({ kind: 'popup' }), api };
}

export function seedConsent(fake: FakeBrowser, overrides: Partial<AppSettings> = {}): void {
  fake.local.seed({ [LOCAL.settings]: { consentAt: 1_700_000_000_000, ...overrides } });
}

export function seedQueue(fake: FakeBrowser, items: QueueItem[], accountId = ACCOUNT_ID): void {
  fake.local.seed({ [LOCAL.queue(accountId)]: items });
}

export const storedQueue = (fake: FakeBrowser, accountId = ACCOUNT_ID): QueueItem[] =>
  fake.local.peek<QueueItem[]>(LOCAL.queue(accountId)) ?? [];

// ---- the offscreen document ------------------------------------------------------------------------------------------------

export interface EngineHarness {
  runner: EngineRunner;
  host: OffscreenHost | null;
  page: FakePage | null;
  /** Object URLs the host made / was told to revoke. */
  blobUrls: string[];
  revoked: string[];
}

/**
 * Wires the real offscreen host into the fake's offscreen document: creating the document starts the host (which says
 * `engine/ready`), closing it disposes the host. `runner` defaults to the stub engine.
 */
export function installEngine(fake: FakeBrowser, options: { runner?: EngineRunner; host?: Partial<HostDeps> } = {}): EngineHarness {
  const harness: EngineHarness = { runner: options.runner ?? createStubRunner(), host: null, page: null, blobUrls: [], revoked: [] };
  fake.offscreen.onCreate = () => {
    harness.page = fake.createPage({ kind: 'offscreen' });
    harness.host = startOffscreenHost({
      runtime: harness.page.runtime,
      runner: harness.runner,
      createObjectURL: () => {
        const url = `blob:${EXTENSION_URL}${crypto.randomUUID()}`;
        harness.blobUrls.push(url);
        return url;
      },
      revokeObjectURL: (url) => {
        harness.revoked.push(url);
      },
      ...options.host,
    });
  };
  fake.offscreen.onClose = () => {
    harness.host?.dispose();
    harness.page?.close();
    harness.host = null;
    harness.page = null;
  };
  return harness;
}

// ---- a scripted engine -----------------------------------------------------------------------------------------------------

export interface ScriptedEngine {
  runner: EngineRunner;
  /** Every job the engine was given. */
  jobs: EngineJob[];
  /** The io of the running job: drive it from the test (`io.progress`, `io.itemDone`, `io.finished`, ...). */
  io: EngineIO | null;
  /** Job ids `cancel()` was called with. */
  cancelled: string[];
  /** Lets `run()` return (call after `io.finished`). */
  finish(): void;
}

/** An `EngineRunner` that does nothing by itself: the test plays the engine through `engine.io`. */
export function scriptedEngine(): ScriptedEngine {
  const engine: ScriptedEngine = {
    jobs: [],
    io: null,
    cancelled: [],
    finish: () => undefined,
    runner: {
      run(job, io) {
        engine.jobs.push(job);
        engine.io = io;
        return new Promise<void>((resolve) => {
          engine.finish = resolve;
        });
      },
      cancel(jobId) {
        engine.cancelled.push(jobId);
      },
    },
  };
  return engine;
}

/** A history entry as the engine would report it for `target`. */
export function historyEntry(target: ChatTarget, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: `entry-${target.channelId}`,
    accountId: ACCOUNT_ID,
    target,
    settings: exportSettings(),
    finishedAt: 1_700_000_100_000,
    status: 'done',
    messageCount: 10,
    files: [{ filename: 'Discord Export/a.html', downloadId: 1 }],
    error: null,
    ...overrides,
  };
}

/** A `JobState` snapshot of `job` the way an engine reports progress: every item gets its fields from `items` (default: waiting). */
export function snapshot(job: EngineJob, items: Record<string, Partial<ItemProgress>> = {}, overrides: Partial<JobState> = {}): JobState {
  return {
    jobId: job.jobId,
    accountId: job.accountId,
    startedAt: 0,
    finishedAt: null,
    state: 'running',
    pausedReason: null,
    zip: job.settings.zipAll,
    items: job.items.map(
      (item): ItemProgress => ({
        key: item.key,
        label: item.target.channelName,
        status: 'waiting',
        phase: null,
        fetched: 0,
        expected: item.settings.count,
        error: null,
        files: [],
        ...items[item.key],
      }),
    ),
    ...overrides,
  };
}

/** Starts a job from the popup and waits until the engine got it. Returns the job id. */
export async function startJobWith(popup: FakePage, engine: ScriptedEngine, keys: string[] | 'all' = 'all'): Promise<string> {
  const response = (await popup.send({ to: 'bg', type: 'job/start', keys })) as { ok: boolean; data?: { jobId: string } };
  if (!response.ok || !response.data) throw new Error(`job/start failed: ${JSON.stringify(response)}`);
  const { jobId } = response.data;
  await waitFor(() => engine.io !== null && engine.jobs.some((job) => job.jobId === jobId));
  return jobId;
}
