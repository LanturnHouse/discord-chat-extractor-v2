/**
 * The download engine in individual-file mode (src/offscreen/engine): every chat becomes its own file(s), one chat after the other;
 * what each chat's verdict is (done / partial / failed), what the history entries and the incremental marker say, and that a chat
 * that fails never stops the job (docs/PLAN.md §6.1, §6.3, §6.7).
 */
import { describe, expect, it } from 'vitest';
import { DiscordApiError } from '@/lib';
import { ACCOUNT_ID, CHATS, FOLDER, NAMES, NOW, blobsOf, callsOf, chatTarget, chatWorld, createHarness, exportSettings, finishedOf, itemDones, jobOf, lastSnapshot, messageIdAt, msg, outputOf, resultOf, rowOf, runJob, scriptedExport, statusesOf, urlsOf } from './kit';
import type { FakeWorld } from './kit';

const FILE = (n: number): string => `${FOLDER}/Test Guild - ${NAMES[n]} (2026-10-06).json`;

describe('individual files: the plain run', () => {
  it('saves one file per chat, named by the library, under the folder of the job, and ends the job done', async () => {
    const harness = createHarness();
    const calls = await runJob(harness, jobOf());
    expect(blobsOf(calls).map((save) => save.filename)).toEqual([FILE(0), FILE(1), FILE(2)]);
    expect(blobsOf(calls).map((save) => save.itemKey)).toEqual([...CHATS]);
    expect(blobsOf(calls).every((save) => save.jobId === 'job-1' && save.blob.type === 'application/json')).toBe(true);
    expect(statusesOf(calls)).toEqual(['done', 'done', 'done']);
    expect(finishedOf(calls)).toEqual(['done']);
    expect(calls.at(-1)).toEqual({ call: 'finished', jobId: 'job-1', state: 'done' });
  });

  it('the files hold the messages of the chat (oldest first)', async () => {
    const harness = createHarness();
    const calls = await runJob(harness, jobOf([1]));
    const document = JSON.parse(await blobsOf(calls)[0].blob.text()) as { messages: Array<{ content: string }> };
    expect(document.messages.map((message) => message.content)).toEqual(['beta 0', 'beta 1', 'beta 2']);
  });

  it('hands the job settings to the library: folder name, date in the file name, format', async () => {
    const harness = createHarness();
    const calls = await runJob(harness, jobOf([0], { format: 'txt' }, { app: { folderName: 'My Backups', dateInFileName: false } }));
    expect(blobsOf(calls)[0].filename).toBe('My Backups/Test Guild - alpha.txt');
    expect(blobsOf(calls)[0].blob.type).toBe('text/plain;charset=utf-8');
  });

  it('uses the time zone and the locale of the job (the day of the export and the language of the file)', async () => {
    // 2026-10-06 20:00 UTC is already the 7th in Seoul
    const late = Date.UTC(2026, 9, 6, 20, 0, 0);
    const harness = createHarness({ deps: { now: () => late } });
    const calls = await runJob(harness, jobOf([0], { format: 'txt' }, { timeZone: 'Asia/Seoul', locale: 'ko' }));
    expect(blobsOf(calls)[0].filename).toBe(`${FOLDER}/Test Guild - alpha (2026-10-07).txt`);
    expect(await blobsOf(calls)[0].blob.text()).toContain('채널');
    const utc = createHarness({ deps: { now: () => late } });
    const utcCalls = await runJob(utc, jobOf([0], { format: 'txt' }, { timeZone: 'UTC', locale: 'en' }));
    expect(blobsOf(utcCalls)[0].filename).toBe(`${FOLDER}/Test Guild - alpha (2026-10-06).txt`);
  });

  it('waits a random 2 - 4 s between two chats and never before the first or after the last', async () => {
    const draws = [0, 0.5, 0.999999];
    let next = 0;
    const harness = createHarness({ deps: { random: () => draws[next++ % draws.length] } });
    await runJob(harness, jobOf());
    expect(harness.sleeps).toEqual([2000, 3000]);
    const single = createHarness();
    await runJob(single, jobOf([0]));
    expect(single.sleeps).toEqual([]);
  });

  it('exports the chats strictly one after the other', async () => {
    const harness = createHarness();
    await runJob(harness, jobOf());
    const channels = harness.client.calls('getMessages').map((call) => call.id);
    expect(channels).toEqual([CHATS[0], CHATS[1], CHATS[2]]);
  });

  it('a job without chats is simply done', async () => {
    const harness = createHarness();
    const calls = await runJob(harness, jobOf([]));
    expect(calls.map((entry) => entry.call)).toEqual(['progress', 'progress', 'finished']);
    expect(finishedOf(calls)).toEqual(['done']);
    expect(harness.sleeps).toEqual([]);
  });

  it('builds one Discord client for the job and gives it the authorization of the job', async () => {
    const harness = createHarness();
    await runJob(harness, jobOf());
    expect(harness.clientOptions).toHaveLength(1);
    expect(await harness.clientOptions[0].getAuthorization()).toBe(jobOf().authorization);
  });
});

describe('individual files: history entries and the incremental marker', () => {
  it('reports every chat with an entry of its own: account, target, settings, status, count, files with download ids', async () => {
    const harness = createHarness();
    harness.setNow(NOW + 5000);
    const calls = await runJob(harness, jobOf([0, 2]));
    const entries = callsOf(calls, 'itemDone');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      call: 'itemDone',
      jobId: 'job-1',
      entry: {
        id: 'entry-1',
        accountId: ACCOUNT_ID,
        target: chatTarget(0),
        settings: exportSettings({ count: null, format: 'json' }),
        finishedAt: NOW + 5000,
        status: 'done',
        messageCount: 3,
        files: [{ filename: FILE(0), downloadId: blobsOf(calls)[0].downloadId }],
        error: null,
      },
      lastMessageId: messageIdAt(2),
    });
    expect(entries[1].entry).toMatchObject({ id: 'entry-2', status: 'done', target: chatTarget(2), files: [{ filename: FILE(2), downloadId: blobsOf(calls)[1].downloadId }] });
  });

  it('uses the account of the job and the settings the chat was run with (a chat with its own settings keeps them)', async () => {
    const harness = createHarness();
    const job = jobOf([0, 1], {}, { accountId: '100000000000000009' });
    job.items[1] = { ...job.items[1], settings: exportSettings({ count: 2, format: 'txt' }) };
    const calls = await runJob(harness, job);
    const [first, second] = itemDones(calls);
    expect(first.accountId).toBe('100000000000000009');
    expect(second.accountId).toBe('100000000000000009');
    expect(second.settings).toEqual(exportSettings({ count: 2, format: 'txt' }));
    expect(second.messageCount).toBe(2);
    expect(second.files[0].filename).toBe(`${FOLDER}/Test Guild - beta (2026-10-06).txt`);
  });

  it('sends the newest message id of a done chat; an entry arrives before the next chat starts', async () => {
    const harness = createHarness();
    const calls = await runJob(harness, jobOf([0, 1]));
    const order = calls.flatMap((entry) => (entry.call === 'itemDone' ? [`done:${entry.entry.target.channelId}`] : entry.call === 'saveBlob' ? [`save:${entry.itemKey}`] : []));
    expect(order).toEqual([`save:${CHATS[0]}`, `done:${CHATS[0]}`, `save:${CHATS[1]}`, `done:${CHATS[1]}`]);
    expect(callsOf(calls, 'itemDone').map((entry) => entry.lastMessageId)).toEqual([messageIdAt(2), messageIdAt(2)]);
  });

  it('incremental: passes the marker of the chat to the library and exports only what is newer', async () => {
    const harness = createHarness();
    const job = jobOf([0], { incremental: true }, { lastExported: { [CHATS[0]]: messageIdAt(0) } });
    const calls = await runJob(harness, job);
    const document = JSON.parse(await blobsOf(calls)[0].blob.text()) as { messages: Array<{ content: string }> };
    expect(document.messages.map((message) => message.content)).toEqual(['alpha 1', 'alpha 2']);
    expect(callsOf(calls, 'itemDone')[0]).toMatchObject({ lastMessageId: messageIdAt(2), entry: { status: 'done', messageCount: 2 } });
    // the walk stopped at the marker: only the first page was asked for, and it was asked "before" nothing
    expect(harness.client.calls('getMessages')).toHaveLength(1);
  });

  it('incremental off: the marker is ignored', async () => {
    const harness = createHarness();
    const calls = await runJob(harness, jobOf([0], { incremental: false }, { lastExported: { [CHATS[0]]: messageIdAt(1) } }));
    expect(itemDones(calls)[0].messageCount).toBe(3);
  });

  it('incremental with nothing new: done, no file, and a null marker (the stored one stays)', async () => {
    const harness = createHarness();
    const calls = await runJob(harness, jobOf([0], { incremental: true }, { lastExported: { [CHATS[0]]: messageIdAt(2) } }));
    expect(blobsOf(calls)).toEqual([]);
    expect(callsOf(calls, 'itemDone')[0]).toMatchObject({ lastMessageId: null, entry: { status: 'done', messageCount: 0, files: [], error: null } });
    expect(statusesOf(calls)).toEqual(['done']);
  });

  it('incremental uses the marker of its own chat only', async () => {
    const harness = createHarness();
    const job = jobOf([0, 1], { incremental: true }, { lastExported: { [CHATS[1]]: messageIdAt(1) } });
    const calls = await runJob(harness, job);
    expect(itemDones(calls).map((entry) => entry.messageCount)).toEqual([3, 1]);
  });
});

describe('individual files: partial and failed chats', () => {
  /** The second page of a chat fails: a chat of 250 messages has 100 + 100 + 50 and only the first page is reached. */
  const partialWorld = (): FakeWorld => chatWorld([{ messages: 3 }, { messages: 250 }, { messages: 3 }]);
  const failSecondPage = (id: string, kind: DiscordApiError['kind'] = 'network') => (call: { method: string; id: string; n: number }) =>
    call.method === 'getMessages' && call.id === id && call.n === 1 ? new DiscordApiError(kind, 'raw problem') : undefined;

  it('saves what was reached under a name that says so, and reports partial with the reason and no marker', async () => {
    const harness = createHarness({ world: partialWorld(), fail: failSecondPage(CHATS[1]) });
    const calls = await runJob(harness, jobOf());
    expect(blobsOf(calls).map((save) => save.filename)).toEqual([FILE(0), `${FOLDER}/Test Guild - beta (2026-10-06) (partial).json`, FILE(2)]);
    expect(statusesOf(calls)).toEqual(['done', 'partial', 'done']);
    const [, partial] = callsOf(calls, 'itemDone');
    expect(partial.lastMessageId).toBeNull();
    expect(partial.entry).toMatchObject({ status: 'partial', messageCount: 100, error: 'Could not connect to the network' });
    expect(rowOf(calls, CHATS[1])).toMatchObject({ status: 'partial', error: { kind: 'network', message: 'Could not connect to the network' } });
    expect(finishedOf(calls)).toEqual(['done']);
  });

  it('a chat that fails before any message is failed (no file) and the job goes on with the next chat', async () => {
    const harness = createHarness({ fail: (call) => (call.method === 'getChannel' && call.id === CHATS[0] ? new DiscordApiError('forbidden', 'raw', { status: 403, code: 50001 }) : undefined) });
    const calls = await runJob(harness, jobOf());
    expect(blobsOf(calls).map((save) => save.itemKey)).toEqual([CHATS[1], CHATS[2]]);
    expect(statusesOf(calls)).toEqual(['failed', 'done', 'done']);
    const [failed] = callsOf(calls, 'itemDone');
    expect(failed).toMatchObject({ lastMessageId: null, entry: { status: 'failed', messageCount: 0, files: [], error: "You don't have permission to view this channel", target: chatTarget(0) } });
    expect(rowOf(calls, CHATS[0]).error).toEqual({ kind: 'forbidden', message: "You don't have permission to view this channel" });
    expect(harness.sleeps).toHaveLength(2); // the pause between chats is kept after a failure
    expect(finishedOf(calls)).toEqual(['done']);
  });

  it('says the same in Korean when the job asks for it', async () => {
    const harness = createHarness({ fail: (call) => (call.method === 'getChannel' ? new DiscordApiError('forbidden', 'raw', { status: 403, code: 50001 }) : undefined) });
    const calls = await runJob(harness, jobOf([0], {}, { locale: 'ko' }));
    expect(rowOf(calls, CHATS[0]).error).toEqual({ kind: 'forbidden', message: '이 채널을 볼 권한이 없어요' });
    expect(itemDones(calls)[0].error).toBe('이 채널을 볼 권한이 없어요');
  });

  it.each([
    ['not-found', '채널을 찾을 수 없어요. 삭제됐을 수 있어요'],
    ['blocked', '디스코드가 요청을 막았어요. 잠시 뒤에 다시 시도해 주세요'],
    ['rate-limited', '디스코드가 요청을 제한했어요. 잠시 뒤에 다시 시도해 주세요'],
    ['network', '네트워크에 연결하지 못했어요'],
    ['server', '디스코드 서버에 문제가 있어요. 잠시 뒤에 다시 시도해 주세요'],
  ] as const)('a %s failure is described in Korean for the user', async (kind, message) => {
    const harness = createHarness({ fail: (call) => (call.method === 'getChannel' ? new DiscordApiError(kind, 'raw') : undefined) });
    const calls = await runJob(harness, jobOf([0], {}, { locale: 'ko' }));
    expect(rowOf(calls, CHATS[0]).error).toEqual({ kind, message });
  });

  it('keeps the library sentence for an unknown kind of failure (it already is in the language of the job)', async () => {
    const harness = createHarness({ fail: (call) => (call.method === 'getChannel' ? new DiscordApiError('unknown', 'Discord returned something odd') : undefined) });
    const calls = await runJob(harness, jobOf([0]));
    expect(rowOf(calls, CHATS[0]).error).toEqual({ kind: 'unknown', message: 'Discord returned something odd' });
  });

  it('every chat can fail: the job is still done, with every chat reported failed', async () => {
    const harness = createHarness({ fail: (call) => (call.method === 'getChannel' ? new DiscordApiError('not-found', 'raw') : undefined) });
    const calls = await runJob(harness, jobOf());
    expect(statusesOf(calls)).toEqual(['failed', 'failed', 'failed']);
    expect(itemDones(calls).map((entry) => entry.status)).toEqual(['failed', 'failed', 'failed']);
    expect(finishedOf(calls)).toEqual(['done']);
  });

  it('a problem of the threads is a partial chat whose reason says so, the chat itself is saved', async () => {
    const world = chatWorld();
    const thread = { id: msg(5, '').id, type: 11, guild_id: world.guild?.id, parent_id: CHATS[0], name: 'Side talk', last_message_id: msg(6, '').id };
    world.channels.push(thread);
    world.threads = { [CHATS[0]]: [thread] };
    world.messages = { ...world.messages, [thread.id]: [msg(6, 'in the thread', {}, thread.id)] };
    const harness = createHarness({ world, fail: (call) => (call.method === 'getMessages' && call.id === thread.id ? new DiscordApiError('forbidden', 'raw', { status: 403, code: 50001 }) : undefined) });
    const calls = await runJob(harness, jobOf([0], { includeThreads: true }));
    expect(blobsOf(calls).map((save) => save.filename)).toEqual([FILE(0)]);
    expect(rowOf(calls, CHATS[0])).toMatchObject({ status: 'partial', error: { kind: 'forbidden', message: "Threads: You don't have permission to view this channel" } });
    expect(callsOf(calls, 'itemDone')[0].lastMessageId).toBeNull();
  });

  it('turns an exception nobody expected into a failed chat and goes on', async () => {
    let calls = 0;
    const harness = createHarness({
      deps: {
        exportChat: async (...args) => {
          calls += 1;
          if (calls === 1) throw new TypeError('something in the writer broke');
          const { exportChat } = await import('@/lib');
          return exportChat(...args);
        },
      },
    });
    const done = await runJob(harness, jobOf([0, 1]));
    expect(statusesOf(done)).toEqual(['failed', 'done']);
    expect(rowOf(done, CHATS[0]).error).toEqual({ kind: 'unknown', message: 'something in the writer broke' });
    expect(itemDones(done)[0]).toMatchObject({ status: 'failed', error: 'something in the writer broke' });
  });
});

describe('individual files: saving', () => {
  it('a file the background refuses to save fails the chat (nothing was saved) and the job goes on', async () => {
    const harness = createHarness({ io: { failBlob: (filename) => filename === FILE(0) } });
    const calls = await runJob(harness, jobOf([0, 1]));
    expect(statusesOf(calls)).toEqual(['failed', 'done']);
    expect(itemDones(calls)[0]).toMatchObject({ status: 'failed', messageCount: 0, files: [], error: 'Could not save the file (the save was refused)' });
    expect(callsOf(calls, 'itemDone')[0].lastMessageId).toBeNull();
    expect(urlsOf(calls)).toEqual([]);
  });

  it('a chat of several files of which only some could be saved is partial: no marker, the reason, the files that were saved', async () => {
    const second = { ...outputOf(0), path: `${FOLDER}/Test Guild - alpha - post (2026-10-06).json`, zipPath: 'Test Guild/Text Channels/alpha/post.json' };
    const harness = createHarness({
      io: { failBlob: (filename) => filename === second.path },
      deps: { exportChat: scriptedExport({ [CHATS[0]]: () => resultOf(0, { outputs: [outputOf(0), second], messageCount: 6 }) }) },
    });
    const calls = await runJob(harness, jobOf([0, 1]));
    expect(statusesOf(calls)).toEqual(['partial', 'done']);
    expect(callsOf(calls, 'itemDone')[0]).toMatchObject({
      lastMessageId: null,
      entry: { status: 'partial', messageCount: 6, error: 'Could not save the file (the save was refused)', files: [{ filename: FILE(0) }] },
    });
    expect(callsOf(calls, 'itemDone')[1].lastMessageId).not.toBeNull();
  });

  it('the saved file of a chat carries the download id the background answered with', async () => {
    const harness = createHarness();
    const calls = await runJob(harness, jobOf([0, 1]));
    const ids = blobsOf(calls).map((save) => save.downloadId);
    expect(new Set(ids).size).toBe(2);
    expect(itemDones(calls).map((entry) => entry.files[0].downloadId)).toEqual(ids);
  });

  it('each snapshot is the state of one moment: later changes do not reach back into it', async () => {
    const harness = createHarness();
    const calls = await runJob(harness, jobOf([0, 1]));
    const first = callsOf(calls, 'progress')[0].job;
    expect(first.items.map((row) => row.status)).toEqual(['waiting', 'waiting']);
    expect(lastSnapshot(calls).items.map((row) => row.status)).toEqual(['done', 'done']);
  });

  it('frees the files of a chat once they are handed over: the result the library gave is empty afterwards', async () => {
    const seen: unknown[] = [];
    const harness = createHarness({
      deps: {
        exportChat: async (...args) => {
          const { exportChat } = await import('@/lib');
          const result = await exportChat(...args);
          seen.push(result);
          return result;
        },
      },
    });
    await runJob(harness, jobOf([0]));
    expect((seen[0] as { outputs: unknown[] }).outputs).toEqual([]);
  });
});
