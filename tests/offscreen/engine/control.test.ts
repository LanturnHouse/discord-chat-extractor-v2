/**
 * How a job of the download engine ends or is interrupted (docs/PLAN.md §6.2, §6.3): a user cancel (at any point), a 401 that stops
 * the job, a rate-limit wait that pauses it, and the guarantee that `io.finished` is the last thing the background hears, once.
 */
import { describe, expect, it } from 'vitest';
import { DiscordApiError, NO_GAP, abortableSleep, createDiscordClient } from '@/lib';
import type { LiveDiscordClientOptions } from '@/lib';
import type { EngineJob } from '@/shared';
import {
  CHATS,
  FOLDER,
  NOW,
  TOKEN,
  attachmentOf,
  blobsOf,
  callsOf,
  chatWorld,
  createHarness,
  fakeTransport,
  finishedOf,
  itemDones,
  jobOf,
  lastSnapshot,
  msg,
  resultOf,
  rowOf,
  runJob,
  scriptedExport,
  snapshots,
  statusesOf,
  urlsOf,
} from './kit';
import type { Call, Harness } from './kit';

/** Whatever happened, the job ends with exactly one `finished`, the last call, and the last snapshot says the same. */
function expectProperEnd(calls: readonly Call[], state: string): void {
  expect(finishedOf(calls)).toEqual([state]);
  expect(calls.at(-1)).toMatchObject({ call: 'finished', state });
  expect(lastSnapshot(calls).state).toBe(state);
  expect(lastSnapshot(calls).finishedAt).not.toBeNull();
  const lastProgress = calls.findLastIndex((entry) => entry.call === 'progress');
  expect(lastProgress).toBe(calls.length - 2);
}

/** A world where chat 1 has three pages, so that something can happen in the middle of it. */
const longWorld = () => chatWorld([{}, { messages: 250 }, {}]);

/** `hook(call)` runs when chat `n` asks for its second page of messages. */
function duringSecondPage(n: number, hook: (harness: Harness) => void): Harness {
  const harness: Harness = createHarness({
    world: longWorld(),
    fail: (call) => {
      if (call.method === 'getMessages' && call.id === CHATS[n] && call.n === 1) hook(harness);
      return undefined;
    },
  });
  return harness;
}

describe('a user cancel', () => {
  it('stops the chat in flight at once: it is cancelled and gets no history entry; the rest never starts; the job ends cancelled', async () => {
    const harness = duringSecondPage(1, (h) => h.fake.abort.abort());
    const calls = await runJob(harness, jobOf());
    expect(statusesOf(calls)).toEqual(['done', 'cancelled', 'waiting']);
    expect(itemDones(calls).map((entry) => entry.target.channelId)).toEqual([CHATS[0]]);
    expect(rowOf(calls, CHATS[1])).toMatchObject({ status: 'cancelled', phase: null, files: [], error: { kind: 'cancelled', message: 'Cancelled' } });
    expect(harness.client.calls('getMessages').some((call) => call.id === CHATS[2])).toBe(false);
    expect(harness.sleeps).toHaveLength(1); // only the pause before chat 1
    expectProperEnd(calls, 'cancelled');
  });

  it('keeps the files of the chats that were finished, and saves nothing of the chat that was cancelled', async () => {
    const harness = duringSecondPage(1, (h) => h.fake.abort.abort());
    const calls = await runJob(harness, jobOf());
    expect(blobsOf(calls).map((save) => save.itemKey)).toEqual([CHATS[0]]);
  });

  it('is the same when the background cancels through `runner.cancel(jobId)` instead of the signal', async () => {
    const harness = duringSecondPage(1, (h) => h.runner.cancel('job-1'));
    const calls = await runJob(harness, jobOf());
    expect(statusesOf(calls)).toEqual(['done', 'cancelled', 'waiting']);
    expectProperEnd(calls, 'cancelled');
  });

  it('a cancel for another job changes nothing', async () => {
    const harness = duringSecondPage(1, (h) => h.runner.cancel('some-other-job'));
    const calls = await runJob(harness, jobOf());
    expect(statusesOf(calls)).toEqual(['done', 'done', 'done']);
    expectProperEnd(calls, 'done');
  });

  it('forgets the cancel afterwards: the same runner runs the next job normally', async () => {
    const harness = duringSecondPage(1, (h) => h.runner.cancel('job-1'));
    await runJob(harness, jobOf());
    const again = createHarness();
    again.runner.cancel('job-1'); // nothing runs: ignored
    expect(statusesOf(await runJob(again, jobOf()))).toEqual(['done', 'done', 'done']);
  });

  it('a cancel that came before the job started runs no chat at all', async () => {
    const harness = createHarness();
    harness.fake.abort.abort();
    const calls = await runJob(harness, jobOf());
    expect(harness.client.calls('getChannel')).toEqual([]);
    expect(statusesOf(calls)).toEqual(['waiting', 'waiting', 'waiting']);
    expect(itemDones(calls)).toEqual([]);
    expectProperEnd(calls, 'cancelled');
  });

  it('a cancel during the pause between two chats ends the job there', async () => {
    const harness: Harness = createHarness({
      deps: {
        sleep: (ms, signal) => {
          harness.fake.abort.abort();
          return abortableSleep(ms, signal);
        },
      },
    });
    const calls = await runJob(harness, jobOf());
    expect(statusesOf(calls)).toEqual(['done', 'waiting', 'waiting']);
    expect(itemDones(calls)).toHaveLength(1);
    expectProperEnd(calls, 'cancelled');
  });

  it('a cancel while the files are written drops the chat (individual files: nothing was handed over yet)', async () => {
    const harness: Harness = createHarness({
      deps: {
        exportChat: scriptedExport({
          [CHATS[0]]: () => {
            harness.fake.abort.abort();
            return resultOf(0);
          },
        }),
      },
    });
    const calls = await runJob(harness, jobOf([0, 1]));
    expect(blobsOf(calls)).toEqual([]);
    expect(statusesOf(calls)).toEqual(['cancelled', 'waiting']);
    expect(itemDones(calls)).toEqual([]);
    expectProperEnd(calls, 'cancelled');
  });

  it('a cancel while attachments are saved stops there: no more attachments, the chat is cancelled without an entry', async () => {
    const harness: Harness = createHarness({
      deps: { exportChat: scriptedExport({ [CHATS[0]]: () => resultOf(0, { attachments: [attachmentOf(0, '11', 'cat.png'), attachmentOf(0, '12', 'dog.png'), attachmentOf(0, '13', 'bird.png')] }) }) },
    });
    const saveUrl = harness.fake.io.saveUrl;
    harness.fake.io.saveUrl = async (...args) => {
      const id = await saveUrl(...args);
      harness.fake.abort.abort();
      return id;
    };
    const calls = await runJob(harness, jobOf([0, 1], { includeAttachments: true }));
    expect(urlsOf(calls)).toHaveLength(1);
    expect(statusesOf(calls)).toEqual(['cancelled', 'waiting']);
    expect(itemDones(calls)).toEqual([]);
    expectProperEnd(calls, 'cancelled');
  });

  it('a cancel that comes after the last chat was done changes nothing: the job is done', async () => {
    const harness = createHarness();
    const itemDone = harness.fake.io.itemDone;
    harness.fake.io.itemDone = async (jobId, entry, lastMessageId) => {
      await itemDone(jobId, entry, lastMessageId);
      if (entry.target.channelId === CHATS[2]) harness.fake.abort.abort();
    };
    const calls = await runJob(harness, jobOf());
    expect(statusesOf(calls)).toEqual(['done', 'done', 'done']);
    expectProperEnd(calls, 'done');
  });
});

describe('a 401', () => {
  /** Hands the options of the client to the test: `options.onAuthError` is what the live client calls on a 401. */
  function authHarness(rejectOn: (call: { method: string; id: string; n: number }) => boolean, world = longWorld()): Harness {
    let options: LiveDiscordClientOptions | undefined;
    const harness: Harness = createHarness({
      world,
      fail: (call) => {
        if (!rejectOn(call)) return undefined;
        options?.onAuthError?.('the value that was rejected');
        return new DiscordApiError('auth', 'raw 401', { status: 401 });
      },
      deps: { createClient: (opts) => ((options = opts), harness.client) },
    });
    return harness;
  }
  const onMessagesOf = (id: string, n = 0) => (call: { method: string; id: string; n: number }) => call.method === 'getMessages' && call.id === id && call.n === n;

  it('tells the background once, fails the chat it hit, fails the chats that never started with the reason, and ends the job failed', async () => {
    const harness = authHarness(onMessagesOf(CHATS[1]));
    const calls = await runJob(harness, jobOf());
    expect(callsOf(calls, 'authError')).toEqual([{ call: 'authError', jobId: 'job-1' }]);
    expect(statusesOf(calls)).toEqual(['done', 'failed', 'failed']);
    const login = { kind: 'auth', message: 'Your Discord login has expired. Please reload Discord' };
    expect(rowOf(calls, CHATS[1]).error).toEqual(login);
    expect(rowOf(calls, CHATS[2])).toMatchObject({ status: 'failed', phase: null, error: login });
    expect(harness.client.calls('getMessages').some((call) => call.id === CHATS[2])).toBe(false);
    expectProperEnd(calls, 'failed');
  });

  it('the chat it hit gets its entry (failed, with the reason); the chats that never started get none', async () => {
    const harness = authHarness(onMessagesOf(CHATS[1]));
    const calls = await runJob(harness, jobOf());
    expect(itemDones(calls).map((entry) => [entry.target.channelId, entry.status, entry.error])).toEqual([
      [CHATS[0], 'done', null],
      [CHATS[1], 'failed', 'Your Discord login has expired. Please reload Discord'],
    ]);
  });

  it('does not wait out the pause between chats once the job is over', async () => {
    const harness = authHarness(onMessagesOf(CHATS[1]));
    await runJob(harness, jobOf());
    expect(harness.sleeps).toHaveLength(1);
  });

  it('a 401 after some messages saves them as a partial chat first, then stops', async () => {
    const harness = authHarness(onMessagesOf(CHATS[1], 1));
    const calls = await runJob(harness, jobOf());
    expect(blobsOf(calls).map((save) => save.filename)).toEqual([`${FOLDER}/Test Guild - alpha (2026-10-06).json`, `${FOLDER}/Test Guild - beta (2026-10-06) (partial).json`]);
    expect(statusesOf(calls)).toEqual(['done', 'partial', 'failed']);
    expect(itemDones(calls)[1]).toMatchObject({ status: 'partial', messageCount: 100, error: 'Your Discord login has expired. Please reload Discord' });
    expect(callsOf(calls, 'itemDone')[1].lastMessageId).toBeNull();
    expectProperEnd(calls, 'failed');
  });

  it('a 401 on the very first request fails every chat the same way', async () => {
    const harness = authHarness((call) => call.method === 'getChannel');
    const calls = await runJob(harness, jobOf());
    expect(statusesOf(calls)).toEqual(['failed', 'failed', 'failed']);
    expect(itemDones(calls)).toHaveLength(1);
    expectProperEnd(calls, 'failed');
  });

  it('says it in Korean for a Korean job', async () => {
    const harness = authHarness(onMessagesOf(CHATS[0]));
    const calls = await runJob(harness, { ...jobOf(), locale: 'ko' });
    expect(rowOf(calls, CHATS[2]).error).toEqual({ kind: 'auth', message: '디스코드 로그인이 만료됐어요. 디스코드를 새로고침해 주세요' });
  });

  it('a 401 that only hit the refresh of attachment URLs still ends the job after its chat (which is saved)', async () => {
    let options: LiveDiscordClientOptions | undefined;
    const harness: Harness = createHarness({
      deps: {
        createClient: (opts) => ((options = opts), harness.client),
        exportChat: scriptedExport({ [CHATS[0]]: () => resultOf(0, { attachments: [attachmentOf(0, '11', 'cat.png', 'https://cdn.discordapp.com/attachments/1/2/11/cat.png?ex=1&is=1&hm=a')] }) }),
      },
    });
    harness.client.refreshAttachmentUrls = async () => {
      options?.onAuthError?.('rejected');
      throw new DiscordApiError('auth', 'raw 401', { status: 401 });
    };
    const calls = await runJob(harness, jobOf([0, 1], { includeAttachments: true }));
    expect(statusesOf(calls)).toEqual(['done', 'failed']);
    expect(urlsOf(calls)).toHaveLength(1); // the copy was still saved, with the URL it had
    expect(callsOf(calls, 'authError')).toHaveLength(1);
    expectProperEnd(calls, 'failed');
  });

  it('works with the real client: a 401 answer fires the callback, once, whatever the number of requests that follow', async () => {
    const { transport, requests } = fakeTransport(() => ({ status: 401, body: { message: '401: Unauthorized', code: 0 } }));
    const harness = createHarness({
      deps: { createClient: (opts) => createDiscordClient({ ...opts, transport, sleep: async () => undefined, pageGap: NO_GAP }) },
    });
    const calls = await runJob(harness, jobOf());
    expect(callsOf(calls, 'authError')).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.Authorization).toBe(TOKEN); // the one place the value goes
    expect(statusesOf(calls)).toEqual(['failed', 'failed', 'failed']);
    expectProperEnd(calls, 'failed');
  });
});

describe('a rate-limit wait', () => {
  const pausedAt = (calls: readonly Call[]) => snapshots(calls).filter((state) => state.state === 'paused');

  it('pauses the job and its running chat while the client waits, and resumes both afterwards', async () => {
    let options: LiveDiscordClientOptions | undefined;
    const harness: Harness = createHarness({
      world: longWorld(),
      fail: (call) => {
        if (call.method === 'getMessages' && call.id === CHATS[1] && call.n === 1) {
          options?.onPause?.({ reason: 'rate-limit', waitMs: 5000, resumeAt: NOW + 5000 });
          options?.onResume?.();
        }
        return undefined;
      },
      deps: { createClient: (opts) => ((options = opts), harness.client) },
    });
    const calls = await runJob(harness, jobOf([1]));
    const paused = pausedAt(calls);
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({ state: 'paused', pausedReason: 'rate-limit' });
    expect(paused[0].items[0].status).toBe('paused');
    const after = snapshots(calls)[snapshots(calls).indexOf(paused[0]) + 1];
    expect(after).toMatchObject({ state: 'running', pausedReason: null });
    expect(after.items[0].status).toBe('running');
    expect(lastSnapshot(calls)).toMatchObject({ state: 'done', pausedReason: null });
    expect(statusesOf(calls)).toEqual(['done']);
  });

  it('a block page wait is a pause as well (the job knows one reason only)', async () => {
    let options: LiveDiscordClientOptions | undefined;
    const harness: Harness = createHarness({
      fail: (call) => {
        if (call.method === 'getChannel') {
          options?.onPause?.({ reason: 'blocked', waitMs: 30_000, resumeAt: NOW + 30_000 });
          options?.onResume?.();
        }
        return undefined;
      },
      deps: { createClient: (opts) => ((options = opts), harness.client) },
    });
    const calls = await runJob(harness, jobOf([0]));
    expect(pausedAt(calls)[0]).toMatchObject({ state: 'paused', pausedReason: 'rate-limit' });
  });

  it('works with the real client: a 429 with a wait of three seconds shows up as a pause, then the chat is saved', async () => {
    let clock = NOW;
    const observed: string[] = [];
    const channel = { id: CHATS[0], type: 1, recipients: [{ id: '1000', username: 'friend', global_name: 'Friend' }] };
    const { transport, requests } = fakeTransport((request, n) => {
      if (n === 0) return { status: 429, body: { message: 'You are being rate limited.', retry_after: 3, global: false } };
      return request.path.includes('/messages') ? { status: 200, body: [msg(2, 'hello', {}, CHATS[0]), msg(1, 'hi', {}, CHATS[0])] } : { status: 200, body: channel };
    });
    const harness: Harness = createHarness({
      deps: {
        createClient: (opts) =>
          createDiscordClient({
            ...opts,
            transport,
            now: () => clock,
            pageGap: NO_GAP,
            sleep: async (ms) => {
              observed.push(`${lastSnapshot(harness.fake.calls).state}:${lastSnapshot(harness.fake.calls).items[0].status}`);
              clock += ms;
            },
          }),
      },
    });
    const calls = await runJob(harness, jobOf([0]));
    expect(observed).toEqual(['paused:paused']); // the wait happened while the job said it was paused
    expect(requests.map((request) => request.method)).toEqual(['GET', 'GET', 'GET']); // 429, retry, messages
    expect(statusesOf(calls)).toEqual(['done']);
    expect(lastSnapshot(calls).state).toBe('done');
  });
});

describe('an engine failure', () => {
  it('something that throws outside a chat closes the job: the chat it was about to run and the rest are failed, the job failed', async () => {
    const harness = createHarness({
      deps: {
        sleep: async () => {
          throw new Error('the timer broke');
        },
      },
    });
    const calls = await runJob(harness, jobOf());
    expect(statusesOf(calls)).toEqual(['done', 'failed', 'failed']);
    expect(rowOf(calls, CHATS[1]).error).toEqual({ kind: 'unknown', message: 'the timer broke' });
    expect(rowOf(calls, CHATS[2]).error).toEqual({ kind: 'interrupted', message: 'Interrupted. Please try again' });
    expectProperEnd(calls, 'failed');
  });

  it('in ZIP mode the chats that were finished still get their archive (partial) and their entries', async () => {
    const harness = createHarness({
      deps: {
        sleep: async () => {
          throw new Error('the timer broke');
        },
      },
    });
    const calls = await runJob(harness, { ...jobOf(), settings: { ...jobOf().settings, zipAll: true } } as EngineJob);
    expect(blobsOf(calls).map((save) => save.filename)).toEqual([`${FOLDER}/Discord Export 2026-10-06 2100 (partial).zip`]);
    expect(itemDones(calls).map((entry) => entry.status)).toEqual(['done']);
    expectProperEnd(calls, 'failed');
  });

  it('a client that cannot even be built rejects (the host then closes the job as failed) after saying finished once', async () => {
    const harness = createHarness({
      deps: {
        createClient: () => {
          throw new Error('no client');
        },
      },
    });
    await expect(harness.runner.run(jobOf(), harness.fake.io)).rejects.toThrow('no client');
    expect(finishedOf(harness.fake.calls)).toEqual(['failed']);
  });
});
