/**
 * What the worker does with the messages of the offscreen engine (docs/PLAN.md §5.3, §6.3, §6.7): progress (throttled), item
 * results (history, incremental marker, list bookkeeping), the end of a job, cancelling, authorization errors. The engine
 * is played by the test through `engine.io`; the messages travel through the real offscreen host and the real router.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL, SESSION } from '@/shared';
import type { HistoryEntry, JobState, QueueItem } from '@/shared';
import { createFakeBrowser } from './fakeChrome';
import type { FakeBrowser, FakePage } from './fakeChrome';
import {
  ACCOUNT_ID,
  CHANNEL_A,
  CHANNEL_B,
  CHANNEL_C,
  DM_CHANNEL,
  OTHER_TOKEN,
  TOKEN,
  bootLoggedIn,
  dmTarget,
  exportSettings,
  guildTarget,
  historyEntry,
  installEngine,
  queueItem,
  scriptedEngine,
  seedConsent,
  seedQueue,
  settle,
  snapshot,
  startJobWith,
  storedQueue,
  userPayload,
  waitFor,
} from './helpers';
import type { EngineHarness, FakeDiscordApi, ScriptedEngine } from './helpers';

let fake: FakeBrowser;
let popup: FakePage;
let api: FakeDiscordApi;
let engine: ScriptedEngine;
let harness: EngineHarness;
let jobId: string;

const A = guildTarget(CHANNEL_A, { channelName: 'general' });
const B = guildTarget(CHANNEL_B, { channelName: 'random' });
const D = dmTarget(DM_CHANNEL);

const storedJob = () => fake.session.peek<JobState>(SESSION.job) as JobState;
const history = () => fake.local.peek<HistoryEntry[]>(LOCAL.history(ACCOUNT_ID)) ?? [];
const markers = () => fake.local.peek<Record<string, string>>(LOCAL.lastExported(ACCOUNT_ID)) ?? {};
const alert = () => fake.session.peek<{ alert: boolean }>('dce.bg.state')?.alert;
const item = (key: string) => storedQueue(fake).find((candidate) => candidate.key === key) as QueueItem;
const sendEngine = (message: Record<string, unknown>) => harness.page!.send({ to: 'bg', ...message });

/** Starts a job over the items A, B and D with the scripted engine. */
async function startThree(): Promise<void> {
  seedConsent(fake, { language: 'en' });
  seedQueue(fake, [queueItem(A), queueItem(B), queueItem(D)]);
  jobId = await startJobWith(popup, engine);
}

beforeEach(async () => {
  fake = createFakeBrowser();
  ({ popup, api } = await bootLoggedIn(fake));
  engine = scriptedEngine();
  harness = installEngine(fake, { runner: engine.runner });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('engine/itemDone: history, incremental marker, list (docs/PLAN.md §6.7)', () => {
  beforeEach(startThree);

  it('a done item goes to the history, advances the marker to its newest message and leaves the list', async () => {
    await engine.io!.itemDone(jobId, historyEntry(A, { messageCount: 25 }), '900000000000000050');
    expect(history()).toEqual([historyEntry(A, { messageCount: 25 })]);
    expect(markers()).toEqual({ [CHANNEL_A]: '900000000000000050' });
    expect(storedQueue(fake).map((candidate) => candidate.key)).toEqual([CHANNEL_B, DM_CHANNEL]);
  });

  it('the marker never goes backwards (an export of an older date range must not repeat messages next time)', async () => {
    fake.local.seed({ [LOCAL.lastExported(ACCOUNT_ID)]: { [CHANNEL_A]: '900000000000000100', [CHANNEL_B]: '5' } });
    await engine.io!.itemDone(jobId, historyEntry(A), '900000000000000050');
    expect(markers()).toEqual({ [CHANNEL_A]: '900000000000000100', [CHANNEL_B]: '5' });
    await engine.io!.itemDone(jobId, historyEntry(B, { id: 'b' }), '6');
    expect(markers()).toEqual({ [CHANNEL_A]: '900000000000000100', [CHANNEL_B]: '6' });
  });

  it('compares ids as numbers (9 < 10)', async () => {
    fake.local.seed({ [LOCAL.lastExported(ACCOUNT_ID)]: { [CHANNEL_A]: '9' } });
    await engine.io!.itemDone(jobId, historyEntry(A), '10');
    expect(markers()[CHANNEL_A]).toBe('10');
  });

  it('a done item without a newest message id (nothing exported) keeps the marker but still leaves the list', async () => {
    fake.local.seed({ [LOCAL.lastExported(ACCOUNT_ID)]: { [CHANNEL_A]: '77' } });
    await engine.io!.itemDone(jobId, historyEntry(A, { messageCount: 0 }), null);
    expect(markers()).toEqual({ [CHANNEL_A]: '77' });
    expect(storedQueue(fake).map((candidate) => candidate.key)).not.toContain(CHANNEL_A);
  });

  it('a partial item is recorded but does NOT move the marker, and stays in the list with a retry hint', async () => {
    await engine.io!.itemDone(jobId, historyEntry(A, { status: 'partial', error: 'rate limited, saved what we had', finishedAt: 1234 }), '900000000000000050');
    expect(history()[0]).toMatchObject({ status: 'partial', error: 'rate limited, saved what we had' });
    expect(markers()).toEqual({});
    expect(item(CHANNEL_A).lastResult).toEqual({ status: 'partial', message: 'rate limited, saved what we had', at: 1234 });
    expect(storedQueue(fake)).toHaveLength(3);
  });

  it('a failed item is recorded, keeps the marker, stays in the list with its reason', async () => {
    await engine.io!.itemDone(jobId, historyEntry(B, { status: 'failed', error: 'no access to this channel', messageCount: 0, files: [], finishedAt: 99 }), null);
    expect(history()[0]).toMatchObject({ status: 'failed', error: 'no access to this channel' });
    expect(markers()).toEqual({});
    expect(item(CHANNEL_B).lastResult).toEqual({ status: 'failed', message: 'no access to this channel', at: 99 });
  });

  it('a failure without a message still gets a hint', async () => {
    await engine.io!.itemDone(jobId, historyEntry(B, { status: 'failed', error: null }), null);
    expect(item(CHANNEL_B).lastResult?.message).toBe('failed');
  });

  it('an item the user cancelled gets the hint "cancelled" even when its entry says failed', async () => {
    await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'cancelled', error: { kind: 'cancelled', message: 'Cancelled.' } } }));
    await engine.io!.itemDone(jobId, historyEntry(A, { status: 'failed', error: 'cancelled' }), null);
    expect(item(CHANNEL_A).lastResult?.status).toBe('cancelled');
  });

  it('puts the newest entry first, replaces an entry with the same id and keeps at most 200', async () => {
    await engine.io!.itemDone(jobId, historyEntry(A, { id: 'one', finishedAt: 1 }), '10');
    await engine.io!.itemDone(jobId, historyEntry(B, { id: 'two', finishedAt: 2 }), '20');
    await engine.io!.itemDone(jobId, historyEntry(D, { id: 'three', finishedAt: 3, status: 'failed', error: 'x' }), null);
    expect(history().map((entry) => entry.id)).toEqual(['three', 'two', 'one']);
    await engine.io!.itemDone(jobId, historyEntry(B, { id: 'one', finishedAt: 4, messageCount: 99 }), '30'); // same id: replaced, and now first
    expect(history().map((entry) => entry.id)).toEqual(['one', 'three', 'two']);
    expect(history()[0].messageCount).toBe(99);

    fake.local.seed({ [LOCAL.history(ACCOUNT_ID)]: Array.from({ length: 200 }, (_, index) => historyEntry(A, { id: `old-${index}` })) });
    await engine.io!.itemDone(jobId, historyEntry(D, { id: 'newest', status: 'failed', error: 'x' }), null);
    expect(history()).toHaveLength(200);
    expect(history()[0].id).toBe('newest');
    expect(history()[199].id).toBe('old-198');
  });

  it('is idempotent: the same message twice leaves one entry and one marker', async () => {
    await engine.io!.itemDone(jobId, historyEntry(A), '500');
    await engine.io!.itemDone(jobId, historyEntry(A), '500');
    expect(history()).toHaveLength(1);
    expect(markers()).toEqual({ [CHANNEL_A]: '500' });
  });

  it('does all of it in one storage write per item', async () => {
    fake.local.set.mockClear();
    await engine.io!.itemDone(jobId, historyEntry(A), '500');
    expect(fake.local.set).toHaveBeenCalledTimes(1);
    expect(Object.keys(fake.local.set.mock.calls[0][0] as object).sort()).toEqual([LOCAL.history(ACCOUNT_ID), LOCAL.lastExported(ACCOUNT_ID), LOCAL.queue(ACCOUNT_ID)].sort());
  });

  it('keeps what the engine sends clean: the stored entry has only the contract fields', async () => {
    await engine.io!.itemDone(jobId, { ...historyEntry(A), authorization: TOKEN, extra: 1 } as HistoryEntry, '5');
    expect(Object.keys(history()[0]).sort()).toEqual(['accountId', 'error', 'files', 'finishedAt', 'id', 'messageCount', 'settings', 'status', 'target']);
    expect(JSON.stringify(fake.local.dump())).not.toContain(TOKEN);
  });

  describe('refused entries change nothing', () => {
    const before = () => JSON.stringify(fake.local.dump());
    const good = () => ({ to: 'bg', type: 'engine/itemDone', jobId, entry: historyEntry(A), lastMessageId: '5' });

    it.each([
      ['another job', () => ({ ...good(), jobId: 'some-other-job' })],
      ['no job id', () => ({ ...good(), jobId: undefined })],
      ['another account\'s entry', () => ({ ...good(), entry: historyEntry(A, { accountId: '100000000000000999' }) })],
      ['a chat that is not part of the job', () => ({ ...good(), entry: historyEntry(guildTarget(CHANNEL_C)) })],
      ['a malformed entry', () => ({ ...good(), entry: { id: 'x' } })],
      ['a status that cannot be an item result', () => ({ ...good(), entry: historyEntry(A, { status: 'cancelled' as never }) })],
      ['no entry', () => ({ ...good(), entry: undefined })],
    ])('%s', async (_label, build) => {
      const snapshotBefore = before();
      const response = (await harness.page!.send(build())) as { ok: boolean; error?: string };
      expect(response).toMatchObject({ ok: false, error: 'invalid' });
      expect(before()).toBe(snapshotBefore);
    });

    it('a bad lastMessageId is treated as none (the entry itself is fine)', async () => {
      await sendEngine({ ...good(), lastMessageId: 'not-an-id' });
      expect(history()).toHaveLength(1);
      expect(markers()).toEqual({});
    });
  });
});

describe('engine/progress', () => {
  beforeEach(async () => {
    await startThree();
  });

  it('puts the engine\'s item states into SESSION.job and keeps what the worker created', async () => {
    await engine.io!.progress({
      ...snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'running', phase: 'messages', fetched: 40, expected: 200, files: ['x.html'] } }),
      accountId: 'someone else',
      startedAt: 12345,
      zip: true,
    });
    await waitFor(() => storedJob().items[0].status === 'running');
    const job = storedJob();
    expect(job).toMatchObject({ jobId, accountId: ACCOUNT_ID, state: 'running', zip: false, finishedAt: null });
    expect(job.startedAt).not.toBe(12345);
    expect(job.items[0]).toMatchObject({ key: CHANNEL_A, label: 'Test Server > #general', status: 'running', phase: 'messages', fetched: 40, expected: 200, files: ['x.html'] });
    expect(job.items[1]).toMatchObject({ key: CHANNEL_B, status: 'waiting' });
  });

  it('shows a rate-limit pause as paused / rate-limit and the resume as running', async () => {
    await engine.io!.progress(snapshot(engine.jobs[0], {}, { state: 'paused', pausedReason: 'rate-limit' }));
    await waitFor(() => storedJob().state === 'paused');
    expect(storedJob().pausedReason).toBe('rate-limit');
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(300);
    await engine.io!.progress(snapshot(engine.jobs[0]));
    await vi.advanceTimersByTimeAsync(300);
    expect(storedJob()).toMatchObject({ state: 'running', pausedReason: null });
  });

  it('writes at most 4 times a second: the first snapshot at once, later ones coalesced, the newest wins', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const jobWrites = () => fake.session.set.mock.calls.filter(([items]) => SESSION.job in (items as object)).length;
    await settle();
    const baseline = jobWrites();

    for (let fetched = 1; fetched <= 20; fetched += 1) void engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'running', fetched } }));
    await settle();
    expect(jobWrites() - baseline).toBe(1); // the leading write
    expect(storedJob().items[0].fetched).toBe(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(jobWrites() - baseline).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(jobWrites() - baseline).toBe(2); // the trailing write
    expect(storedJob().items[0].fetched).toBe(20);

    // a quiet second later: one more snapshot goes out immediately again
    await vi.advanceTimersByTimeAsync(1000);
    await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'running', fetched: 21 } }));
    await settle();
    expect(jobWrites() - baseline).toBe(3);
    expect(storedJob().items[0].fetched).toBe(21);
  });

  it('a snapshot of another job does not push out the newest one of this job that is waiting for the throttle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000_000);
    await settle();
    await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'running', fetched: 1 } })); // the leading write
    await settle();
    void engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'running', fetched: 5 } })); // waits for the throttle
    await settle();
    await sendEngine({ type: 'engine/progress', job: { ...snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'failed' } }), jobId: 'other-job' } });
    await vi.advanceTimersByTimeAsync(300);
    expect(storedJob().items[0]).toMatchObject({ status: 'running', fetched: 5 });
  });

  it('over a long burst it stays at 4 writes per second', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    const jobWrites = () => fake.session.set.mock.calls.filter(([items]) => SESSION.job in (items as object)).length;
    await settle();
    const baseline = jobWrites();
    for (let tick = 0; tick < 100; tick += 1) {
      void engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'running', fetched: tick } }));
      await vi.advanceTimersByTimeAsync(20); // 50 snapshots per second for 2 seconds
    }
    await vi.advanceTimersByTimeAsync(300);
    const writes = jobWrites() - baseline;
    expect(writes).toBeGreaterThanOrEqual(7);
    expect(writes).toBeLessThanOrEqual(9); // 2 s x 4/s (+ the leading and trailing write)
    expect(storedJob().items[0].fetched).toBe(99);
  });

  it('ignores snapshots of another job and junk', async () => {
    const stored = JSON.stringify(storedJob());
    await sendEngine({ type: 'engine/progress', job: { ...snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'failed' } }), jobId: 'other-job' } });
    await sendEngine({ type: 'engine/progress', job: 'junk' });
    await sendEngine({ type: 'engine/progress' });
    await settle();
    expect(JSON.stringify(storedJob())).toBe(stored);
  });

  it('a finished item cannot come back, and unknown items are not added', async () => {
    await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'done', fetched: 10 } }));
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(300);
    await engine.io!.progress({ ...snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'running' } }), items: [...snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'running' } }).items, { ...snapshot(engine.jobs[0]).items[0], key: '999' }] });
    await vi.advanceTimersByTimeAsync(300);
    expect(storedJob().items.map((candidate) => [candidate.key, candidate.status])).toEqual([
      [CHANNEL_A, 'done'],
      [CHANNEL_B, 'waiting'],
      [DM_CHANNEL, 'waiting'],
    ]);
  });

  it('is acknowledged at once (the engine is never held up by storage)', async () => {
    const response = await sendEngine({ type: 'engine/progress', job: snapshot(engine.jobs[0]) });
    expect(response).toEqual({ ok: true });
  });

  it('keepalive is acknowledged and changes nothing', async () => {
    const stored = JSON.stringify(fake.session.dump());
    await expect(sendEngine({ type: 'engine/keepalive', jobId })).resolves.toEqual({ ok: true });
    expect(JSON.stringify(fake.session.dump())).toBe(stored);
  });
});

describe('engine/finished: the end of a job', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    await startThree();
  });

  it('stores the final state with finishedAt; items the engine reported keep their result', async () => {
    await engine.io!.progress(
      snapshot(engine.jobs[0], {
        [CHANNEL_A]: { status: 'done', fetched: 50, files: ['a.html'] },
        [CHANNEL_B]: { status: 'failed', error: { kind: 'forbidden', message: 'no access' } },
        [DM_CHANNEL]: { status: 'partial', fetched: 7, error: { kind: 'rate-limited', message: 'cut short' }, files: ['d (partial).html'] },
      }),
    );
    await engine.io!.finished(jobId, 'done');
    const job = storedJob();
    expect(job).toMatchObject({ state: 'done', finishedAt: 1_760_000_000_000, pausedReason: null });
    expect(job.items.map((candidate) => candidate.status)).toEqual(['done', 'failed', 'partial']);
    expect(job.items[0]).toMatchObject({ fetched: 50, files: ['a.html'] });
    expect(job.items[1].error).toEqual({ kind: 'forbidden', message: 'no access' });
  });

  it('flushes the engine\'s last snapshot first (it may still be waiting for the throttle)', async () => {
    await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'running', fetched: 1 } }));
    await settle();
    void engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'done', fetched: 9 } })); // queued behind the throttle
    await engine.io!.finished(jobId, 'done');
    expect(storedJob().items[0]).toMatchObject({ status: 'done', fetched: 9 });
  });

  it('closes items the engine left unfinished: failed/interrupted when the job did not end by cancellation', async () => {
    await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'done' }, [CHANNEL_B]: { status: 'running', phase: 'messages', fetched: 5 } }));
    await engine.io!.finished(jobId, 'failed');
    const job = storedJob();
    expect(job.state).toBe('failed');
    expect(job.items.map((candidate) => candidate.status)).toEqual(['done', 'failed', 'failed']);
    expect(job.items[1]).toMatchObject({ phase: null, error: { kind: 'interrupted' }, fetched: 5 });
    expect(job.items[2].error?.kind).toBe('interrupted');
  });

  it('a cancelled job: unfinished items are cancelled', async () => {
    await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'done' }, [CHANNEL_B]: { status: 'running' } }));
    await engine.io!.finished(jobId, 'cancelled');
    expect(storedJob().state).toBe('cancelled');
    expect(storedJob().items.map((candidate) => candidate.status)).toEqual(['done', 'cancelled', 'cancelled']);
    expect(storedJob().items[1].error).toEqual({ kind: 'cancelled', message: 'Cancelled.' });
  });

  it('gives the queue a retry hint for items that were really attempted (in flight, failed, partial), not for items that never started', async () => {
    await engine.io!.progress(
      snapshot(engine.jobs[0], {
        [CHANNEL_A]: { status: 'failed', error: { kind: 'forbidden', message: 'no access' } },
        [CHANNEL_B]: { status: 'running' },
      }),
    );
    await engine.io!.finished(jobId, 'cancelled');
    expect(item(CHANNEL_A).lastResult).toMatchObject({ status: 'failed', message: 'no access', at: 1_760_000_000_000 });
    expect(item(CHANNEL_B).lastResult).toMatchObject({ status: 'cancelled', message: 'Cancelled.' });
    expect(item(DM_CHANNEL).lastResult).toBeUndefined(); // never started: simply still in the list
  });

  it('does not overwrite the hint the engine\'s own itemDone gave this run', async () => {
    await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'failed', error: { kind: 'network', message: 'timeout' } } }));
    await engine.io!.itemDone(jobId, historyEntry(A, { status: 'failed', error: 'detailed reason', finishedAt: 1_760_000_000_500 }), null);
    await engine.io!.finished(jobId, 'done');
    expect(item(CHANNEL_A).lastResult).toEqual({ status: 'failed', message: 'detailed reason', at: 1_760_000_000_500 });
  });

  it('replaces an older hint from a previous run', async () => {
    seedQueue(fake, [queueItem(A, { lastResult: { status: 'failed', message: 'old', at: 5 } }), queueItem(B), queueItem(D)]);
    await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'failed', error: { kind: 'server', message: 'new reason' } } }));
    await engine.io!.finished(jobId, 'done');
    expect(item(CHANNEL_A).lastResult).toMatchObject({ message: 'new reason' });
  });

  it('is ignored for a job that is not the running one (and nothing breaks)', async () => {
    await expect(sendEngine({ type: 'engine/finished', jobId: 'other', state: 'done' })).resolves.toEqual({ ok: true });
    expect(storedJob().state).toBe('running');
    await engine.io!.finished(jobId, 'done');
    const finished = JSON.stringify(storedJob());
    await expect(sendEngine({ type: 'engine/finished', jobId, state: 'failed' })).resolves.toEqual({ ok: true }); // a second report
    expect(JSON.stringify(storedJob())).toBe(finished);
    expect(fake.notifications.created).toHaveLength(1);
  });

  it.each(['running', 'paused', 'bogus', undefined, 5])('refuses the final state %j', async (state) => {
    await expect(sendEngine({ type: 'engine/finished', jobId, state })).resolves.toMatchObject({ ok: false, error: 'invalid' });
    expect(storedJob().state).toBe('running');
  });

  it('leaves the list alone otherwise: finished items already left it through itemDone', async () => {
    await engine.io!.itemDone(jobId, historyEntry(A), '5');
    await engine.io!.finished(jobId, 'done');
    expect(storedQueue(fake).map((candidate) => candidate.key)).toEqual([CHANNEL_B, DM_CHANNEL]);
  });

  it('the failure flag: failures raise it (red "!"), a clean run or a cancellation does not', async () => {
    await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'done' }, [CHANNEL_B]: { status: 'failed' }, [DM_CHANNEL]: { status: 'done' } }));
    await engine.io!.finished(jobId, 'done');
    await settle();
    expect(alert()).toBe(true);
    expect(fake.badge).toMatchObject({ text: '!', color: '#D83C3E' });
  });

  it('a partial item counts as a failure for the flag; a cancellation and a clean run do not', async () => {
    await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'partial' } }));
    await engine.io!.finished(jobId, 'done');
    expect(alert()).toBe(true);
  });

  it('a clean run leaves no flag', async () => {
    await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'done' }, [CHANNEL_B]: { status: 'done' }, [DM_CHANNEL]: { status: 'done' } }));
    await engine.io!.finished(jobId, 'done');
    expect(alert()).toBe(false);
  });

  it('a cancelled job leaves no flag', async () => {
    await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'done' }, [CHANNEL_B]: { status: 'running' } }));
    await engine.io!.finished(jobId, 'cancelled');
    expect(alert()).toBe(false);
  });
});

describe('job/cancel', () => {
  beforeEach(startThree);

  it('asks the engine to stop: runner.cancel and the io signal; the job stays running until the engine reports', async () => {
    await expect(popup.send({ to: 'bg', type: 'job/cancel' })).resolves.toEqual({ ok: true });
    expect(engine.cancelled).toEqual([jobId]);
    expect(engine.io!.signal.aborted).toBe(true);
    expect(storedJob().state).toBe('running');
    await engine.io!.finished(jobId, 'cancelled');
    expect(storedJob().state).toBe('cancelled');
  });

  it('with no running job there is nothing to do', async () => {
    await engine.io!.finished(jobId, 'done');
    engine.finish();
    await expect(popup.send({ to: 'bg', type: 'job/cancel' })).resolves.toEqual({ ok: true });
    expect(engine.cancelled).toEqual([]);
  });

  it('closes the job as cancelled itself when the engine is gone', async () => {
    harness.host?.dispose();
    harness.page?.close(); // the document vanished but the job still says "running"
    harness.page = null;
    await expect(popup.send({ to: 'bg', type: 'job/cancel' })).resolves.toEqual({ ok: true });
    await waitFor(() => storedJob().state === 'cancelled');
    expect(storedJob().items.every((candidate) => candidate.status === 'cancelled')).toBe(true);
    expect(fake.notifications.created).toEqual([]);
  });
});

describe('engine/authError', () => {
  beforeEach(startThree);

  it('removes the stored authorization when it is still the value the job used', async () => {
    await engine.io!.authError(jobId);
    expect(fake.session.has(SESSION.token)).toBe(false);
    expect(fake.session.has(SESSION.tokenCapturedAt)).toBe(false);
    await waitFor(() => fake.session.peek(SESSION.account) === null);
    expect(storedJob().state).toBe('running'); // the engine decides how the job goes on
  });

  it('leaves a NEWER capture alone', async () => {
    api.users.set(OTHER_TOKEN, userPayload('100000000000000002'));
    fake.captureToken(OTHER_TOKEN);
    await waitFor(() => fake.session.peek(SESSION.token) === OTHER_TOKEN);
    await engine.io!.authError(jobId);
    expect(fake.session.peek(SESSION.token)).toBe(OTHER_TOKEN);
  });

  it('after a worker restart (the job\'s value is not remembered) it asks Discord about the stored value instead', async () => {
    const popup2 = fake.createPage({ kind: 'popup' });
    void popup2;
    vi.resetModules();
    vi.stubGlobal('chrome', fake.chrome);
    // a second incarnation of the worker with the same storage (the first one's listeners are replaced)
    fake.onMessage.listeners.length = 0;
    fake.storageChanged.listeners.length = 0;
    fake.onBeforeSendHeaders.listeners.length = 0;
    await import('@/background/index');
    await settle();
    api.users.delete(TOKEN); // Discord has revoked it
    await engine.io!.authError(jobId);
    await waitFor(() => !fake.session.has(SESSION.token));
  });

  it('a stored value Discord still accepts is kept when the worker restarted', async () => {
    vi.resetModules();
    vi.stubGlobal('chrome', fake.chrome);
    fake.onMessage.listeners.length = 0;
    fake.storageChanged.listeners.length = 0;
    fake.onBeforeSendHeaders.listeners.length = 0;
    await import('@/background/index');
    await settle();
    await engine.io!.authError(jobId);
    await settle();
    expect(fake.session.peek(SESSION.token)).toBe(TOKEN);
  });

  it('refuses a message without a job id', async () => {
    await expect(sendEngine({ type: 'engine/authError' })).resolves.toMatchObject({ ok: false, error: 'invalid' });
  });
});

describe('job state is never a place for secrets', () => {
  beforeEach(startThree);

  it('after a whole job nothing in storage.local or in the job holds the authorization', async () => {
    await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'done' } }));
    await engine.io!.itemDone(jobId, historyEntry(A), '5');
    await engine.io!.finished(jobId, 'done');
    expect(JSON.stringify(fake.local.dump())).not.toContain(TOKEN);
    expect(JSON.stringify(storedJob())).not.toContain(TOKEN);
    expect(JSON.stringify(fake.notifications.created)).not.toContain(TOKEN);
    const exceptToken = Object.fromEntries(Object.entries(fake.session.dump()).filter(([key]) => key !== SESSION.token));
    expect(JSON.stringify(exceptToken)).not.toContain(TOKEN);
  });
});

describe('the settings a job runs with', () => {
  it('(sanity) an item with own settings keeps them in the history entry the engine sends', async () => {
    seedConsent(fake);
    seedQueue(fake, [queueItem(A, { settings: exportSettings({ count: 7 }) })]);
    const id = await startJobWith(popup, engine);
    await engine.io!.itemDone(id, historyEntry(A, { settings: engine.jobs[0].items[0].settings }), '9');
    expect(history()[0].settings.count).toBe(7);
  });
});

describe('when storage or timing misbehaves', () => {
  it('a cancel that arrives while the job is still being started waits for the engine and then reaches it', async () => {
    vi.useFakeTimers();
    seedConsent(fake, { language: 'en' });
    seedQueue(fake, [queueItem(A), queueItem(B)]);
    const bootEngine = fake.offscreen.onCreate!;
    fake.offscreen.onCreate = () => {
      setTimeout(() => void bootEngine(), 500); // the engine takes half a second to come up
    };
    const starting = popup.send({ to: 'bg', type: 'job/start', keys: 'all' }) as Promise<{ ok: boolean; data?: { jobId: string } }>;
    await vi.advanceTimersByTimeAsync(100);
    const cancelling = popup.send({ to: 'bg', type: 'job/cancel' });
    await vi.advanceTimersByTimeAsync(100);
    expect(engine.cancelled).toEqual([]); // not yet: the engine does not exist yet
    await vi.advanceTimersByTimeAsync(600);
    const started = await starting;
    await expect(cancelling).resolves.toEqual({ ok: true });
    expect(engine.cancelled).toEqual([started.data!.jobId]); // it got the job first, then the cancel
    expect(storedJob().state).toBe('running'); // the engine, not the cancel request, ends the job
    await engine.io!.finished(started.data!.jobId, 'cancelled');
    expect(storedJob().state).toBe('cancelled');
  });

  it('a final job state that is too big for session storage is stored again without its file lists', async () => {
    await startThree();
    await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'done', fetched: 5, files: ['a.html', 'a_files/1.png'] } }));
    await settle();
    const original = fake.session.set.getMockImplementation()!;
    fake.session.set.mockImplementation(async (items: Record<string, unknown>) => {
      const job = items[SESSION.job] as JobState | undefined;
      if (job && job.state === 'done' && job.items.some((candidate) => candidate.files.length > 0)) throw new Error('QUOTA_BYTES quota exceeded');
      return original(items);
    });
    await engine.io!.finished(jobId, 'done');
    expect(storedJob().state).toBe('done');
    expect(storedJob().items[0]).toMatchObject({ status: 'done', fetched: 5, files: [] });
    await waitFor(() => fake.notifications.created.length === 1);
    await waitFor(() => !fake.offscreen.open);
  });

  it('a list that cannot be written at the end does not stop the notification, the badge or the offscreen cleanup', async () => {
    await startThree();
    await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'failed', error: { kind: 'network', message: 'timeout' } } }));
    const original = fake.local.set.getMockImplementation()!;
    fake.local.set.mockRejectedValue(new Error('QUOTA_BYTES quota exceeded'));
    await expect(sendEngine({ type: 'engine/finished', jobId, state: 'done' })).resolves.toEqual({ ok: true });
    fake.local.set.mockImplementation(original);
    expect(storedJob().state).toBe('done');
    await waitFor(() => fake.notifications.created.length === 1);
    await waitFor(() => !fake.offscreen.open);
    expect(alert()).toBe(true);
  });

  it('an itemDone that cannot be stored is reported to the engine, and the next one works (no lock is left behind)', async () => {
    await startThree();
    fake.local.set.mockImplementationOnce(async () => {
      throw new Error('QUOTA_BYTES quota exceeded');
    });
    const refused = await sendEngine({ type: 'engine/itemDone', jobId, entry: historyEntry(A), lastMessageId: '5' });
    expect(refused).toMatchObject({ ok: false, error: 'unknown' });
    expect(history()).toEqual([]);
    await engine.io!.itemDone(jobId, historyEntry(A), '5');
    expect(history()).toHaveLength(1);
  });

  it('keeps at most 100 files per history entry (a chat with thousands of attachments must not fill the storage)', async () => {
    await startThree();
    const files = Array.from({ length: 150 }, (_, index) => ({ filename: `Discord Export/x_files/${index}.png`, downloadId: index }));
    await engine.io!.itemDone(jobId, historyEntry(A, { files }), '5');
    expect(history()[0].files).toHaveLength(100);
    expect(history()[0].files[0]).toEqual(files[0]);
    expect(history()[0].files[99]).toEqual(files[99]);
  });
});
