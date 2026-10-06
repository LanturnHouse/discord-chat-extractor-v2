/** The placeholder engine (src/offscreen/stubEngine.ts): every item "fails" through the real protocol. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineJob, HistoryEntry, JobState } from '@/shared';
import type { EngineIO } from '@/offscreen/runner';
import { STUB_ERROR_MESSAGE, createStubRunner } from '@/offscreen/stubEngine';
import { ACCOUNT_ID, CHANNEL_A, CHANNEL_B, DM_CHANNEL, TOKEN, dmTarget, exportSettings, guildTarget } from '../background/helpers';

type Call =
  | { call: 'progress'; job: JobState }
  | { call: 'itemDone'; jobId: string; entry: HistoryEntry; lastMessageId: string | null }
  | { call: 'finished'; jobId: string; state: string }
  | { call: 'authError'; jobId: string };

function createIo(abort = new AbortController()) {
  const calls: Call[] = [];
  const io: EngineIO = {
    signal: abort.signal,
    progress: async (job) => void calls.push({ call: 'progress', job }),
    saveBlob: async () => {
      throw new Error('the stub saves nothing');
    },
    saveUrl: async () => {
      throw new Error('the stub saves nothing');
    },
    itemDone: async (jobId, entry, lastMessageId) => void calls.push({ call: 'itemDone', jobId, entry, lastMessageId }),
    authError: async (jobId) => void calls.push({ call: 'authError', jobId }),
    finished: async (jobId, state) => void calls.push({ call: 'finished', jobId, state }),
  };
  return { io, calls, abort };
}

const job = (keys: Array<[string, 'guild' | 'dm']> = [[CHANNEL_A, 'guild'], [DM_CHANNEL, 'dm']]): EngineJob => ({
  jobId: 'job-1',
  accountId: ACCOUNT_ID,
  authorization: TOKEN,
  items: keys.map(([key, kind]) => ({
    key,
    target: kind === 'guild' ? guildTarget(key, { channelName: `chan ${key.slice(-1)}` }) : dmTarget(key),
    settings: exportSettings({ count: kind === 'guild' ? 50 : null }),
  })),
  settings: {
    common: exportSettings(),
    showButtons: true,
    showQueuedIndicator: false,
    zipAll: true,
    folderName: 'Discord Export',
    dateInFileName: true,
    timeZone: 'auto',
    notifyOnComplete: true,
    language: 'en',
    consentAt: 1,
  },
  lastExported: {},
  locale: 'en',
  timeZone: 'UTC',
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the stub engine', () => {
  it('reports every item as failed ("unknown", "engine not implemented") and the job as done', async () => {
    const { io, calls } = createIo();
    let counter = 0;
    await createStubRunner({ now: () => 1000, newId: () => `id-${(counter += 1)}` }).run(job(), io);

    expect(STUB_ERROR_MESSAGE).toBe('engine not implemented');
    expect(calls.map((entry) => entry.call)).toEqual(['progress', 'progress', 'progress', 'itemDone', 'progress', 'progress', 'itemDone', 'progress', 'finished']);

    const itemDone = calls.filter((entry): entry is Extract<Call, { call: 'itemDone' }> => entry.call === 'itemDone');
    expect(itemDone.map((entry) => entry.entry)).toEqual([
      {
        id: 'id-1',
        accountId: ACCOUNT_ID,
        target: guildTarget(CHANNEL_A, { channelName: 'chan 1' }),
        settings: exportSettings({ count: 50 }),
        finishedAt: 1000,
        status: 'failed',
        messageCount: 0,
        files: [],
        error: 'engine not implemented',
      },
      expect.objectContaining({ id: 'id-2', status: 'failed', target: dmTarget(DM_CHANNEL), settings: exportSettings({ count: null }) }),
    ]);
    expect(itemDone.every((entry) => entry.jobId === 'job-1' && entry.lastMessageId === null)).toBe(true);
    expect(calls.at(-1)).toEqual({ call: 'finished', jobId: 'job-1', state: 'done' });
  });

  it('shows each item running (phase resolving) before it fails', async () => {
    const { io, calls } = createIo();
    await createStubRunner().run(job(), io);
    const snapshots = calls.filter((entry): entry is Extract<Call, { call: 'progress' }> => entry.call === 'progress').map((entry) => entry.job.items.map((item) => item.status));
    expect(snapshots).toEqual([
      ['waiting', 'waiting'],
      ['running', 'waiting'],
      ['failed', 'waiting'],
      ['failed', 'running'],
      ['failed', 'failed'],
      ['failed', 'failed'],
    ]);
    const running = calls.find((entry) => entry.call === 'progress' && entry.job.items[0].status === 'running') as Extract<Call, { call: 'progress' }>;
    expect(running.job.items[0].phase).toBe('resolving');
  });

  it('builds a full JobState: labels, expected counts, the ZIP flag; every snapshot is its own copy', async () => {
    const { io, calls } = createIo();
    await createStubRunner({ now: () => 5 }).run(job(), io);
    const first = (calls[0] as Extract<Call, { call: 'progress' }>).job;
    expect(first).toMatchObject({ jobId: 'job-1', accountId: ACCOUNT_ID, state: 'running', zip: true, finishedAt: null });
    expect(first.items).toEqual([
      { key: CHANNEL_A, label: 'Test Server > #chan 1', status: 'waiting', phase: null, fetched: 0, expected: 50, error: null, files: [] },
      { key: DM_CHANNEL, label: 'Friend', status: 'waiting', phase: null, fetched: 0, expected: null, error: null, files: [] },
    ]);
    // later steps did not rewrite the first snapshot
    expect(first.items.every((item) => item.status === 'waiting')).toBe(true);
    const last = (calls.filter((entry) => entry.call === 'progress').at(-1) as Extract<Call, { call: 'progress' }>).job;
    expect(last.items.map((item) => item.error)).toEqual([
      { kind: 'unknown', message: 'engine not implemented' },
      { kind: 'unknown', message: 'engine not implemented' },
    ]);
  });

  it('a job without items is simply done', async () => {
    const { io, calls } = createIo();
    await createStubRunner().run(job([]), io);
    expect(calls.map((entry) => entry.call)).toEqual(['progress', 'progress', 'finished']);
    expect(calls.at(-1)).toMatchObject({ call: 'finished', state: 'done' });
  });

  it('never sends the authorization anywhere', async () => {
    const { io, calls } = createIo();
    await createStubRunner().run(job(), io);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
  });
});

describe('cancelling the stub', () => {
  const run = async (cancelWith: 'runner' | 'signal', cancelledJob = 'job-1') => {
    vi.useFakeTimers();
    const { io, calls, abort } = createIo();
    const runner = createStubRunner({ itemDelayMs: 1000 });
    const finished = runner.run(job([[CHANNEL_A, 'guild'], [CHANNEL_B, 'guild'], [DM_CHANNEL, 'dm']]), io);
    await vi.advanceTimersByTimeAsync(1500); // the first item failed, the second is running
    if (cancelWith === 'runner') runner.cancel(cancelledJob);
    else abort.abort();
    await vi.advanceTimersByTimeAsync(5000); // long enough for the remaining items when nothing was cancelled
    await finished;
    return calls;
  };

  it('stops at the item in flight: it is cancelled, the rest wait, and the job ends cancelled', async () => {
    const calls = await run('runner');
    const last = (calls.filter((entry) => entry.call === 'progress').at(-1) as Extract<Call, { call: 'progress' }>).job;
    expect(last.items.map((item) => item.status)).toEqual(['failed', 'cancelled', 'waiting']);
    expect(last.items[1].error).toEqual({ kind: 'cancelled', message: 'Cancelled.' });
    expect(calls.at(-1)).toEqual({ call: 'finished', jobId: 'job-1', state: 'cancelled' });
  });

  it('sends an entry only for what really ended (the cancelled item gets none)', async () => {
    const calls = await run('runner');
    const itemDone = calls.filter((entry): entry is Extract<Call, { call: 'itemDone' }> => entry.call === 'itemDone');
    expect(itemDone.map((entry) => entry.entry.target.channelId)).toEqual([CHANNEL_A]);
  });

  it('the abort signal cancels as well', async () => {
    const calls = await run('signal');
    expect(calls.at(-1)).toEqual({ call: 'finished', jobId: 'job-1', state: 'cancelled' });
  });

  it('a cancel for another job changes nothing', async () => {
    const calls = await run('runner', 'some-other-job');
    expect(calls.at(-1)).toMatchObject({ call: 'finished', state: 'done' });
  });

  it('forgets the cancellation afterwards: the same job id can run again', async () => {
    vi.useFakeTimers();
    const runner = createStubRunner({ itemDelayMs: 100 });
    const first = createIo();
    const done = runner.run(job(), first.io);
    runner.cancel('job-1');
    await vi.advanceTimersByTimeAsync(500);
    await done;
    expect(first.calls.at(-1)).toMatchObject({ state: 'cancelled' });
    const second = createIo();
    const again = runner.run(job(), second.io);
    await vi.advanceTimersByTimeAsync(1000);
    await again;
    expect(second.calls.at(-1)).toMatchObject({ state: 'done' });
  });
});
