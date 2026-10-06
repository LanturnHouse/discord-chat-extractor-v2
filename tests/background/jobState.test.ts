import { describe, expect, it } from 'vitest';
import type { ItemProgress, JobState } from '@/shared';
import { buildJobState, finalizeJob, formatLabel, hasFailures, summarizeJob } from '@/background/jobState';
import { ACCOUNT_ID, CHANNEL_A, CHANNEL_B, CHANNEL_C, DM_CHANNEL, dmTarget, exportSettings, guildTarget } from './helpers';

const progress = (key: string, overrides: Partial<ItemProgress> = {}): ItemProgress => ({
  key,
  label: `label ${key}`,
  status: 'waiting',
  phase: null,
  fetched: 0,
  expected: 200,
  error: null,
  files: [],
  ...overrides,
});

const job = (items: ItemProgress[], overrides: Partial<JobState> = {}): JobState => ({
  jobId: 'j',
  accountId: ACCOUNT_ID,
  startedAt: 100,
  finishedAt: null,
  state: 'running',
  pausedReason: null,
  zip: false,
  items,
  ...overrides,
});

describe('formatLabel', () => {
  it('is "<guild> > #<channel>" for a guild chat and just the name for a DM or group DM', () => {
    expect(formatLabel(guildTarget(CHANNEL_A, { guildName: 'Test Server', channelName: 'general' }))).toBe('Test Server > #general');
    expect(formatLabel(dmTarget(DM_CHANNEL, { channelName: 'Friend' }))).toBe('Friend');
    expect(formatLabel(dmTarget(DM_CHANNEL, { kind: 'group-dm', channelName: 'Study group' }))).toBe('Study group');
  });

  it('falls back to "#<channel>" when the guild name is not known (threads and forums included)', () => {
    expect(formatLabel(guildTarget(CHANNEL_A, { guildName: null, channelName: 'general' }))).toBe('#general');
    expect(formatLabel(guildTarget(CHANNEL_A, { kind: 'thread', guildName: 'S', channelName: 'a thread' }))).toBe('S > #a thread');
    expect(formatLabel(guildTarget(CHANNEL_A, { kind: 'forum', guildName: 'S', channelName: 'questions' }))).toBe('S > #questions');
  });
});

describe('buildJobState', () => {
  it('starts every item waiting, with the message limit of its effective settings as the expected count', () => {
    const state = buildJobState({
      jobId: 'job-1',
      accountId: ACCOUNT_ID,
      zip: true,
      now: 42,
      items: [
        { key: CHANNEL_A, target: guildTarget(CHANNEL_A), settings: exportSettings({ count: 50 }) },
        { key: DM_CHANNEL, target: dmTarget(), settings: exportSettings({ count: null }) },
      ],
    });
    expect(state).toEqual({
      jobId: 'job-1',
      accountId: ACCOUNT_ID,
      startedAt: 42,
      finishedAt: null,
      state: 'running',
      pausedReason: null,
      zip: true,
      items: [
        { key: CHANNEL_A, label: 'Test Server > #general', status: 'waiting', phase: null, fetched: 0, expected: 50, error: null, files: [] },
        { key: DM_CHANNEL, label: 'Friend', status: 'waiting', phase: null, fetched: 0, expected: null, error: null, files: [] },
      ],
    });
  });
});

describe('finalizeJob', () => {
  it('stores the final state and time, and clears the pause', () => {
    const { job: closed } = finalizeJob(job([progress(CHANNEL_A, { status: 'done' })], { state: 'paused', pausedReason: 'rate-limit' }), 'done', 999);
    expect(closed).toMatchObject({ state: 'done', finishedAt: 999, pausedReason: null });
  });

  it('keeps finished items as they are', () => {
    const items = [progress(CHANNEL_A, { status: 'done', fetched: 9 }), progress(CHANNEL_B, { status: 'partial', fetched: 3 }), progress(CHANNEL_C, { status: 'failed', error: { kind: 'forbidden', message: 'no' } })];
    expect(finalizeJob(job(items), 'done', 1).job.items).toEqual(items);
  });

  it('closes unfinished items as cancelled when the job was cancelled, as failed/interrupted otherwise', () => {
    const items = [progress(CHANNEL_A, { status: 'running', phase: 'messages', fetched: 4 }), progress(CHANNEL_B, { status: 'waiting' }), progress(CHANNEL_C, { status: 'paused' })];
    const cancelled = finalizeJob(job(items), 'cancelled', 1).job.items;
    expect(cancelled.map((item) => item.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(cancelled[0]).toMatchObject({ phase: null, fetched: 4, error: { kind: 'cancelled' } });
    for (const final of ['failed', 'done'] as const) {
      const failed = finalizeJob(job(items), final, 1).job.items;
      expect(failed.map((item) => item.status)).toEqual(['failed', 'failed', 'failed']);
      expect(failed.every((item) => item.error?.kind === 'interrupted' && item.phase === null)).toBe(true);
    }
  });

  it('marks (queue hints) only items that were attempted: in flight, or reported failed / partial / cancelled by the engine', () => {
    const items = [
      progress(CHANNEL_A, { status: 'done' }),
      progress(CHANNEL_B, { status: 'failed', error: { kind: 'network', message: 'timeout' } }),
      progress(CHANNEL_C, { status: 'partial' }),
      progress('4', { status: 'cancelled' }),
      progress('5', { status: 'running' }),
      progress('6', { status: 'paused' }),
      progress('7', { status: 'waiting' }),
    ];
    const { marks } = finalizeJob(job(items), 'cancelled', 77);
    expect(marks.map((mark) => [mark.key, mark.status])).toEqual([
      [CHANNEL_B, 'failed'],
      [CHANNEL_C, 'partial'],
      ['4', 'cancelled'],
      ['5', 'cancelled'],
      ['6', 'cancelled'],
    ]);
    expect(marks.every((mark) => mark.at === 77)).toBe(true);
    expect(marks[0].message).toBe('timeout');
    expect(marks[1].message).toBe('partial'); // no error text: the status stands in
  });

  it('does not change the job it was given', () => {
    const original = job([progress(CHANNEL_A, { status: 'running' })]);
    const before = JSON.stringify(original);
    finalizeJob(original, 'failed', 5);
    expect(JSON.stringify(original)).toBe(before);
  });
});

describe('hasFailures and summarizeJob', () => {
  it('a failed or partial item, or a failed job, is a failure; a cancellation alone is not', () => {
    expect(hasFailures(job([progress(CHANNEL_A, { status: 'done' })], { state: 'done' }))).toBe(false);
    expect(hasFailures(job([progress(CHANNEL_A, { status: 'failed' })], { state: 'done' }))).toBe(true);
    expect(hasFailures(job([progress(CHANNEL_A, { status: 'partial' })], { state: 'done' }))).toBe(true);
    expect(hasFailures(job([progress(CHANNEL_A, { status: 'cancelled' })], { state: 'cancelled' }))).toBe(false);
    expect(hasFailures(job([progress(CHANNEL_A, { status: 'done' })], { state: 'failed' }))).toBe(true);
  });

  it('summarizeJob counts the chats that produced a file (done or partial), their messages, and the failures', () => {
    expect(
      summarizeJob(
        job([
          progress(CHANNEL_A, { status: 'done', fetched: 100 }),
          progress(CHANNEL_B, { status: 'partial', fetched: 20 }),
          progress(CHANNEL_C, { status: 'failed', fetched: 5 }),
          progress('4', { status: 'cancelled', fetched: 7 }),
          progress('5', { status: 'done', fetched: 0 }),
        ]),
      ),
    ).toEqual({ chats: 3, messages: 120, failures: 2 });
  });
});
