/**
 * The progress the engine reports (src/offscreen/engine/progress.ts, docs/PLAN.md §5.3, §7.2): the rows and their labels, which
 * phase a chat is in, how many messages it has of how many it should, and that a change of count alone is not sent more than four
 * times a second while a change of phase or status always is.
 */
import { describe, expect, it } from 'vitest';
import { DiscordApiError } from '@/lib';
import type { ChatTarget, JobState } from '@/shared';
import { JobProgress, MAX_LISTED_FILES, labelOf } from '@/offscreen/engine/progress';
import type { ItemOutcome } from '@/offscreen/engine/types';
import { CHATS, NOW, appSettings, callsOf, chatTarget, chatWorld, createHarness, createIo, engineJob, exportSettings, jobOf, runJob, snapshots } from './kit';
import { dmTarget, guildTarget } from '../../background/helpers';

function createProgress(chats = 3, count: number | null = 200, zip = false) {
  const { io, calls } = createIo();
  let now = NOW;
  const job = engineJob({
    items: Array.from({ length: chats }, (_, n) => ({ key: CHATS[n], target: chatTarget(n), settings: exportSettings({ count }) })),
    settings: appSettings({ zipAll: zip }),
  });
  const progress = new JobProgress(job, io, () => now, 250);
  const sent = (): JobState[] => callsOf(calls, 'progress').map((entry) => entry.job);
  return { progress, sent, advance: (ms: number) => void (now += ms) };
}

const outcome = (overrides: Partial<ItemOutcome> = {}): ItemOutcome => ({ status: 'done', messageCount: 3, lastMessageId: '1', files: [], error: null, inArchive: false, ...overrides });

describe('labels', () => {
  const target = (overrides: Partial<ChatTarget>): ChatTarget => ({ ...guildTarget(), ...overrides });

  it('"<server> > #<channel>" for a server chat, the name alone for a DM or a group DM', () => {
    expect(labelOf(target({ guildName: 'Test Guild', channelName: 'alpha' }))).toBe('Test Guild > #alpha');
    expect(labelOf(dmTarget())).toBe('Friend');
    expect(labelOf({ ...dmTarget(), kind: 'group-dm', channelName: 'Board games' })).toBe('Board games');
  });

  it('"#<channel>" for a server chat whose server name is not known', () => {
    expect(labelOf(target({ guildName: null, channelName: 'alpha' }))).toBe('#alpha');
  });
});

describe('the first snapshot', () => {
  it('is a full state with every chat waiting, its label, the number of messages it should have and nothing else', async () => {
    const { progress, sent } = createProgress(2, 50, true);
    await progress.start();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toEqual({
      jobId: 'job-1',
      accountId: '100000000000000001',
      startedAt: NOW,
      finishedAt: null,
      state: 'running',
      pausedReason: null,
      zip: true,
      items: [
        { key: CHATS[0], label: 'Test Guild > #alpha', status: 'waiting', phase: null, fetched: 0, expected: 50, error: null, files: [] },
        { key: CHATS[1], label: 'Test Guild > #beta', status: 'waiting', phase: null, fetched: 0, expected: 50, error: null, files: [] },
      ],
    });
  });

  it('has no expected count for a chat without a message limit', async () => {
    const { progress, sent } = createProgress(1, null);
    await progress.start();
    expect(sent()[0].items[0].expected).toBeNull();
  });
});

describe('phases and counts', () => {
  it('starting a chat is reported at once: running, looking the chat up, nothing fetched', async () => {
    const { progress, sent } = createProgress();
    await progress.start();
    await progress.begin(1);
    expect(sent().at(-1)?.items.map((row) => [row.status, row.phase, row.fetched])).toEqual([['waiting', null, 0], ['running', 'resolving', 0], ['waiting', null, 0]]);
  });

  it('a new phase is reported at once, however soon it follows the last report', async () => {
    const { progress, sent } = createProgress();
    await progress.begin(0);
    progress.phase('messages', 100);
    progress.phase('threads', 100);
    progress.phase('writing', 100);
    progress.phase('saving');
    progress.phase('attachments');
    expect(sent().map((state) => [state.items[0].phase, state.items[0].fetched])).toEqual([
      ['resolving', 0],
      ['messages', 100],
      ['threads', 100],
      ['writing', 100],
      ['saving', 100],
      ['attachments', 100],
    ]);
  });

  it('a change of the count alone goes out at most every 250 ms; the next report carries what was skipped', async () => {
    const { progress, sent, advance } = createProgress();
    await progress.begin(0);
    progress.phase('messages', 100); // new phase: sent
    advance(100);
    progress.phase('messages', 200); // too soon
    advance(100);
    progress.phase('messages', 300); // still too soon (200 ms since the last report)
    expect(sent().map((state) => state.items[0].fetched)).toEqual([0, 100]);
    advance(50);
    progress.phase('messages', 400); // 250 ms: sent
    expect(sent().map((state) => state.items[0].fetched)).toEqual([0, 100, 400]);
    advance(10);
    progress.phase('messages', 500); // skipped...
    progress.phase('writing', 500); // ...but the phase change takes it along
    expect(sent().at(-1)?.items[0]).toMatchObject({ phase: 'writing', fetched: 500 });
  });

  it('never reports four times in a second while only the count changes', async () => {
    const { progress, sent, advance } = createProgress();
    await progress.begin(0);
    progress.phase('messages', 1);
    const before = sent().length;
    for (let n = 2; n <= 101; n += 1) {
      advance(10); // a hundred updates in one second
      progress.phase('messages', n);
    }
    expect(sent().length - before).toBeLessThanOrEqual(4);
    expect(sent().length - before).toBeGreaterThanOrEqual(3);
  });

  it('reports nothing for something that did not change', async () => {
    const { progress, sent, advance } = createProgress();
    await progress.begin(0);
    progress.phase('messages', 100);
    const count = sent().length;
    advance(1000);
    progress.phase('messages', 100);
    expect(sent()).toHaveLength(count);
  });

  it('ignores a phase when no chat is running', () => {
    const { progress, sent } = createProgress();
    progress.phase('messages', 5);
    expect(sent()).toEqual([]);
  });

  it('every snapshot stays what it was: later changes do not reach back into it', async () => {
    const { progress, sent } = createProgress(1);
    await progress.start();
    await progress.begin(0);
    progress.phase('messages', 100);
    await progress.finish(0, outcome());
    const rows = sent().map((state) => state.items[0]);
    expect(rows.map((row) => [row.status, row.phase, row.fetched])).toEqual([['waiting', null, 0], ['running', 'resolving', 0], ['running', 'messages', 100], ['done', null, 3]]);
  });
});

describe('the end of a chat', () => {
  it('done: the number of messages that are in the files, no phase, the files by name', async () => {
    const { progress, sent } = createProgress(1);
    await progress.begin(0);
    progress.phase('messages', 7);
    await progress.finish(0, outcome({ messageCount: 5, files: [{ filename: 'a/b.json', downloadId: 4 }, { filename: 'a/c.png', downloadId: 5 }] }));
    expect(sent().at(-1)?.items[0]).toEqual({ key: CHATS[0], label: 'Test Guild > #alpha', status: 'done', phase: null, fetched: 5, expected: 200, error: null, files: ['a/b.json', 'a/c.png'] });
  });

  it('failed: how far it got stays, with the reason', async () => {
    const { progress, sent } = createProgress(1);
    await progress.begin(0);
    progress.phase('messages', 7);
    await progress.finish(0, outcome({ status: 'failed', messageCount: 0, error: { kind: 'forbidden', message: 'no' } }));
    expect(sent().at(-1)?.items[0]).toMatchObject({ status: 'failed', phase: null, fetched: 7, error: { kind: 'forbidden', message: 'no' } });
  });

  it('names at most a hundred files', async () => {
    const { progress, sent } = createProgress(1);
    await progress.begin(0);
    const files = Array.from({ length: 250 }, (_, n) => ({ filename: `f/${n}.png`, downloadId: n }));
    await progress.finish(0, outcome({ files }));
    expect(MAX_LISTED_FILES).toBe(100);
    expect(sent().at(-1)?.items[0].files).toHaveLength(100);
  });

  it('cancelled: no phase, no files, the reason', async () => {
    const { progress, sent } = createProgress(1);
    await progress.begin(0);
    progress.phase('messages', 7);
    await progress.cancel(0, { kind: 'cancelled', message: 'Cancelled' });
    expect(sent().at(-1)?.items[0]).toMatchObject({ status: 'cancelled', phase: null, files: [], error: { kind: 'cancelled', message: 'Cancelled' } });
  });

  it('a row can be corrected afterwards (a chat that looked saved when its archive could not be saved)', async () => {
    const { progress, sent } = createProgress(1, 200, true);
    await progress.begin(0);
    await progress.finish(0, outcome());
    await progress.finish(0, outcome({ status: 'failed', messageCount: 0, error: { kind: 'unknown', message: 'zip' } }));
    expect(sent().at(-1)?.items[0]).toMatchObject({ status: 'failed', error: { kind: 'unknown', message: 'zip' } });
  });
});

describe('pauses and the end of the job', () => {
  it('a pause shows on the job and on the chat that runs; a resume takes both back', async () => {
    const { progress, sent } = createProgress();
    await progress.begin(1);
    progress.pause();
    expect(sent().at(-1)).toMatchObject({ state: 'paused', pausedReason: 'rate-limit' });
    expect(sent().at(-1)?.items.map((row) => row.status)).toEqual(['waiting', 'paused', 'waiting']);
    progress.resume();
    expect(sent().at(-1)).toMatchObject({ state: 'running', pausedReason: null });
    expect(sent().at(-1)?.items.map((row) => row.status)).toEqual(['waiting', 'running', 'waiting']);
  });

  it('a pause without a running chat pauses the job only', () => {
    const { progress, sent } = createProgress();
    progress.pause();
    expect(sent().at(-1)).toMatchObject({ state: 'paused' });
    expect(sent().at(-1)?.items.map((row) => row.status)).toEqual(['waiting', 'waiting', 'waiting']);
  });

  it('failFrom closes the chats that never ran and leaves the others as they ended', async () => {
    const { progress, sent } = createProgress();
    await progress.begin(0);
    await progress.finish(0, outcome());
    await progress.begin(1);
    await progress.failFrom(1, { kind: 'auth', message: 'login' });
    expect(sent().at(-1)?.items.map((row) => [row.status, row.error?.kind ?? null])).toEqual([['done', null], ['failed', 'auth'], ['failed', 'auth']]);
  });

  it('complete stamps the end of the job and clears a pause', async () => {
    const { progress, sent, advance } = createProgress();
    progress.pause();
    advance(1234);
    await progress.complete('cancelled');
    expect(sent().at(-1)).toMatchObject({ state: 'cancelled', pausedReason: null, finishedAt: NOW + 1234 });
  });
});

describe('in a whole job', () => {
  it('a chat goes through resolving, messages, writing and saving, then ends done', async () => {
    const harness = createHarness();
    const calls = await runJob(harness, jobOf([0]));
    const phases = snapshots(calls).map((state) => state.items[0].phase);
    expect(phases.filter((phase, index) => phase !== phases[index - 1])).toEqual([null, 'resolving', 'messages', 'writing', 'saving', null]);
    expect(snapshots(calls).at(-1)?.items[0]).toMatchObject({ status: 'done', fetched: 3, expected: null });
  });

  it('a chat with threads shows the thread phase once the chat itself is read, then the messages of its threads', async () => {
    const world = chatWorld();
    const thread = { id: '800000000000000999', type: 11, guild_id: world.guild?.id, parent_id: CHATS[0], name: 'Side talk', last_message_id: '800000000000000999' };
    world.channels.push(thread);
    world.threads = { [CHATS[0]]: [thread] };
    const harness = createHarness({ world });
    const calls = await runJob(harness, jobOf([0], { includeThreads: true }));
    const phases = snapshots(calls).map((state) => state.items[0].phase);
    expect(phases.filter((phase, index) => phase !== phases[index - 1])).toEqual([null, 'resolving', 'messages', 'threads', 'messages', 'writing', 'saving', null]);
  });

  it('the count follows the pages and the expected count is the message limit', async () => {
    const harness = createHarness({ world: chatWorld([{ messages: 250 }]) });
    const calls = await runJob(harness, jobOf([0], { count: 250 }));
    const counts = snapshots(calls).map((state) => state.items[0].fetched);
    expect(Math.max(...counts)).toBe(250);
    expect(snapshots(calls)[0].items[0].expected).toBe(250);
  });

  it('with a clock that does not move only the phase changes are sent; with a slow one every page is', async () => {
    const pages = chatWorld([{ messages: 1000 }]);
    const frozen: ReturnType<typeof createHarness> = createHarness({ world: pages, fail: () => undefined });
    const frozenCalls = await runJob(frozen, jobOf([0]));
    const messages = (calls: ReturnType<typeof snapshots>) => calls.filter((state) => state.items[0].phase === 'messages').map((state) => state.items[0].fetched);
    expect(messages(snapshots(frozenCalls))).toEqual([100]); // the new phase, with the first page; the other pages were too close

    const slow: ReturnType<typeof createHarness> = createHarness({
      world: pages,
      fail: (call) => {
        if (call.method === 'getMessages') slow.setNow(NOW + (call.n + 1) * 300);
        return undefined;
      },
    });
    expect(messages(snapshots(await runJob(slow, jobOf([0]))))).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);

    const middling: ReturnType<typeof createHarness> = createHarness({
      world: pages,
      fail: (call) => {
        if (call.method === 'getMessages') middling.setNow(NOW + (call.n + 1) * 100);
        return undefined;
      },
    });
    expect(messages(snapshots(await runJob(middling, jobOf([0]))))).toEqual([100, 400, 700, 1000]);
  });

  it('keeps the pace given in the options', async () => {
    const harness: ReturnType<typeof createHarness> = createHarness({
      world: chatWorld([{ messages: 300 }]),
      deps: { progressIntervalMs: 0 },
    });
    const calls = await runJob(harness, jobOf([0]));
    const counts = snapshots(calls).filter((state) => state.items[0].phase === 'messages').map((state) => state.items[0].fetched);
    expect(counts).toEqual([100, 200, 300]);
  });

  it('a chat that fails right away still shows it was looked up first', async () => {
    const harness = createHarness({ fail: (call) => (call.method === 'getChannel' ? new DiscordApiError('not-found', 'raw') : undefined) });
    const calls = await runJob(harness, jobOf([0]));
    const phases = snapshots(calls).map((state) => state.items[0].phase);
    expect(phases).toContain('resolving');
    expect(snapshots(calls).at(-1)?.items[0]).toMatchObject({ status: 'failed', phase: null });
  });
});
