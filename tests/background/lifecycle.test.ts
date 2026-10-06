/**
 * Worker start-up (docs/PLAN.md §6.3): a job that says "running" while its offscreen document is gone is closed as failed with
 * its unfinished items interrupted; nothing else is disturbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL, SESSION } from '@/shared';
import type { ItemProgress, JobState } from '@/shared';
import { createFakeBrowser } from './fakeChrome';
import type { FakeBrowser } from './fakeChrome';
import {
  ACCOUNT_ID,
  CHANNEL_A,
  CHANNEL_B,
  CHANNEL_C,
  DM_CHANNEL,
  TOKEN,
  bootWorker,
  dmTarget,
  guildTarget,
  installEngine,
  installFakeDiscordApi,
  queueItem,
  scriptedEngine,
  seedConsent,
  seedQueue,
  settle,
  startJobWith,
  storedQueue,
  userPayload,
  waitFor,
} from './helpers';
import type { FakeDiscordApi } from './helpers';

let fake: FakeBrowser;
let api: FakeDiscordApi;

const item = (key: string, status: ItemProgress['status'], extra: Partial<ItemProgress> = {}): ItemProgress => ({
  key,
  label: `label ${key}`,
  status,
  phase: status === 'running' ? 'messages' : null,
  fetched: 0,
  expected: 200,
  error: null,
  files: [],
  ...extra,
});

const runningJob = (overrides: Partial<JobState> = {}): JobState => ({
  jobId: 'stale-job',
  accountId: ACCOUNT_ID,
  startedAt: 1_700_000_000_000,
  finishedAt: null,
  state: 'running',
  pausedReason: null,
  zip: false,
  items: [item(CHANNEL_A, 'done', { fetched: 20, files: ['a.html'] }), item(CHANNEL_B, 'running', { fetched: 7 }), item(DM_CHANNEL, 'waiting')],
  ...overrides,
});

const storedJob = () => fake.session.peek<JobState>(SESSION.job) as JobState;

beforeEach(() => {
  fake = createFakeBrowser();
  api = installFakeDiscordApi();
  api.users.set(TOKEN, userPayload(ACCOUNT_ID));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a job whose engine is gone', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
  });

  async function boot(job: JobState | null = runningJob()): Promise<void> {
    if (job) fake.session.seed({ [SESSION.job]: job });
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A)), queueItem(guildTarget(CHANNEL_B)), queueItem(dmTarget())]);
    await bootWorker(fake);
  }

  it('is marked failed with finishedAt, and its unfinished items interrupted', async () => {
    await boot();
    expect(storedJob()).toMatchObject({ jobId: 'stale-job', state: 'failed', finishedAt: 1_760_000_000_000, pausedReason: null });
    expect(storedJob().items[0]).toEqual(item(CHANNEL_A, 'done', { fetched: 20, files: ['a.html'] })); // finished before: untouched
    expect(storedJob().items[1]).toMatchObject({ key: CHANNEL_B, status: 'failed', phase: null, fetched: 7, error: { kind: 'interrupted' } });
    expect(storedJob().items[2]).toMatchObject({ key: DM_CHANNEL, status: 'failed', error: { kind: 'interrupted' } });
    expect(storedJob().items[1].error?.message).toEqual(expect.any(String));
  });

  it('also when it was paused for a rate limit', async () => {
    await boot(runningJob({ state: 'paused', pausedReason: 'rate-limit' }));
    expect(storedJob()).toMatchObject({ state: 'failed', pausedReason: null });
  });

  it('raises the failure flag (red "!") so the user notices', async () => {
    await boot();
    await waitFor(() => fake.badge.text === '!');
    expect(fake.session.peek<{ alert: boolean }>('dce.bg.state')?.alert).toBe(true);
  });

  it('gives the chats that were in flight a retry hint and leaves the others alone', async () => {
    await boot();
    const queue = storedQueue(fake);
    expect(queue.find((candidate) => candidate.key === CHANNEL_B)?.lastResult).toMatchObject({ status: 'failed', at: 1_760_000_000_000 });
    expect(queue.find((candidate) => candidate.key === CHANNEL_A)?.lastResult).toBeUndefined(); // it was done (its own itemDone handled the list)
    expect(queue.find((candidate) => candidate.key === DM_CHANNEL)?.lastResult).toBeUndefined(); // never started
    expect(queue).toHaveLength(3);
  });

  it('does not notify (nobody is waiting for it), does not touch history or markers', async () => {
    await boot();
    await settle();
    expect(fake.notifications.created).toEqual([]);
    expect(fake.local.has(LOCAL.history(ACCOUNT_ID))).toBe(false);
    expect(fake.local.has(LOCAL.lastExported(ACCOUNT_ID))).toBe(false);
  });

  it('is done before the first message is handled: a popup that asks at once never sees "running"', async () => {
    fake.session.seed({ [SESSION.job]: runningJob() });
    // hold the worker's FIRST read of the job (the recovery's) so the recovery cannot finish yet
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = fake.session.get.getMockImplementation()!;
    let held = false;
    fake.session.get.mockImplementation(async (keys) => {
      if (keys === SESSION.job && !held) {
        held = true;
        await gate;
      }
      return original(keys);
    });
    vi.resetModules();
    vi.stubGlobal('chrome', fake.chrome);
    await import('@/background/index'); // the worker has only just started
    const popup = fake.createPage({ kind: 'popup' });
    const answered = vi.fn();
    const pending = popup.send({ to: 'bg', type: 'status/get' }).then((value) => {
      answered();
      return value as { data: { job: JobState } };
    });
    await settle();
    expect(answered).not.toHaveBeenCalled(); // it waits for the start-up recovery
    release();
    const response = await pending;
    expect(response.data.job.state).toBe('failed');
  });

  it('does not block the next job: a new start works', async () => {
    await boot();
    fake.captureToken(TOKEN);
    await waitFor(() => fake.session.peek(SESSION.account));
    const engine = scriptedEngine();
    installEngine(fake, { runner: engine.runner });
    seedConsent(fake);
    const popup = fake.createPage({ kind: 'popup' });
    const jobId = await startJobWith(popup, engine);
    expect(jobId).not.toBe('stale-job');
  });

  it('leaves the list alone when the stale job was a re-run from the history', async () => {
    fake.session.seed({ 'dce.bg.state': { jobId: 'stale-job', source: 'history', lastDownloadId: null, blobs: {}, alert: false } });
    await boot();
    expect(storedJob().state).toBe('failed');
    expect(storedQueue(fake).every((candidate) => candidate.lastResult === undefined)).toBe(true);
  });
});

describe('a job that is fine', () => {
  async function boot(job: JobState | null, offscreen = false): Promise<void> {
    if (job) fake.session.seed({ [SESSION.job]: job });
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A))]);
    if (offscreen) {
      fake.offscreen.open = true;
      fake.createPage({ kind: 'offscreen' });
    }
    await bootWorker(fake);
    await settle();
  }

  it('keeps a running job whose offscreen document exists', async () => {
    const job = runningJob();
    await boot(job, true);
    expect(storedJob()).toEqual(job);
    expect(fake.offscreen.closeCalls).toBe(0);
  });

  it('keeps a paused job whose offscreen document exists', async () => {
    const job = runningJob({ state: 'paused', pausedReason: 'rate-limit' });
    await boot(job, true);
    expect(storedJob()).toEqual(job);
  });

  it.each(['done', 'cancelled', 'failed'] as const)('does not touch a %s job', async (state) => {
    const job = runningJob({ state, finishedAt: 5 });
    await boot(job);
    expect(storedJob()).toEqual(job);
    expect(storedQueue(fake)[0].lastResult).toBeUndefined();
  });

  it('is fine with no job at all', async () => {
    await boot(null);
    expect(fake.session.has(SESSION.job)).toBe(false);
  });

  it('closes a stray offscreen document when no job runs and nothing is pending', async () => {
    await boot(null, true);
    await waitFor(() => !fake.offscreen.open);
  });
});

describe('start-up events', () => {
  it('onStartup and onInstalled are registered (they wake the worker so the badge and the recovery run after a browser start)', async () => {
    await bootWorker(fake);
    expect(fake.onStartup.listeners).toHaveLength(1);
    expect(fake.onInstalled.listeners).toHaveLength(1);
  });

  it('they re-run nothing that already ran: the recovery happens once per worker lifetime', async () => {
    fake.session.seed({ [SESSION.job]: runningJob() });
    await bootWorker(fake);
    const writes = fake.session.set.mock.calls.length;
    fake.onStartup.dispatch();
    fake.onInstalled.dispatch({ reason: 'update' });
    await settle();
    expect(fake.session.set.mock.calls.length).toBe(writes);
  });

  it('the badge is set at start (a browser restart leaves it blank)', async () => {
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A)), queueItem(guildTarget(CHANNEL_B)), queueItem(guildTarget(CHANNEL_C))]);
    fake.session.seed({
      [SESSION.account]: { id: ACCOUNT_ID, username: 'tester', globalName: null, avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png' },
      [SESSION.token]: TOKEN,
    });
    await bootWorker(fake);
    await waitFor(() => fake.badge.text === '3');
  });
});
