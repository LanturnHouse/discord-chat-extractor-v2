/**
 * The download engine in ZIP mode (docs/PLAN.md §6.3, §6.6): one archive for the whole job, saved last; the chats that are in it are
 * reported to the history only once the archive is saved (a chat counts as saved when its data is on disk); an archive that
 * cannot be saved fails its chats; a job that stops early saves what it has as a partial archive; a full ZIP fails the chat.
 */
import { describe, expect, it } from 'vitest';
import { DiscordApiError } from '@/lib';
import {
  CHATS,
  FOLDER,
  attachmentOf,
  blobsOf,
  callsOf,
  chatWorld,
  createHarness,
  decode,
  finishedOf,
  itemDones,
  jobOf,
  lastSnapshot,
  messageIdAt,
  resultOf,
  rowOf,
  runJob,
  scriptedExport,
  snapshots,
  statusesOf,
  unzip,
  urlsOf,
} from './kit';
import type { Call } from './kit';
import type { EngineJob } from '@/shared';

const ARCHIVE = `${FOLDER}/Discord Export 2026-10-06 2100.zip`;
const PARTIAL_ARCHIVE = `${FOLDER}/Discord Export 2026-10-06 2100 (partial).zip`;
const ENTRY = (name: string): string => `Test Guild/Text Channels/${name}.json`;

const zipJob = (chats: readonly number[] = [0, 1, 2], settings = {}, app = {}): EngineJob => jobOf(chats, settings, { app: { zipAll: true, ...app } });
const archiveOf = (calls: readonly Call[]): Promise<Record<string, Uint8Array>> => unzip(blobsOf(calls).at(-1)!.blob);

describe('ZIP: the archive', () => {
  it('puts every chat into one archive, saved once, last, as "<folder>/Discord Export <date> <time>.zip"', async () => {
    const harness = createHarness();
    const calls = await runJob(harness, zipJob());
    expect(blobsOf(calls)).toHaveLength(1);
    const [archive] = blobsOf(calls);
    expect(archive).toMatchObject({ jobId: 'job-1', itemKey: null, filename: ARCHIVE });
    expect(archive.blob.type).toBe('application/zip');
    expect(Object.keys(await archiveOf(calls)).sort()).toEqual([ENTRY('alpha'), ENTRY('beta'), ENTRY('gamma')]);
    expect(finishedOf(calls)).toEqual(['done']);
    expect(calls.at(-1)).toEqual({ call: 'finished', jobId: 'job-1', state: 'done' });
  });

  it('the entries hold the files of the chats', async () => {
    const harness = createHarness();
    const calls = await runJob(harness, zipJob([1]));
    const entries = await archiveOf(calls);
    const document = JSON.parse(decode(entries[ENTRY('beta')])) as { messages: Array<{ content: string }> };
    expect(document.messages.map((message) => message.content)).toEqual(['beta 0', 'beta 1', 'beta 2']);
  });

  it('one chat alone is a ZIP as well when the setting says so', async () => {
    const harness = createHarness();
    const calls = await runJob(harness, zipJob([0]));
    expect(blobsOf(calls).map((save) => save.filename)).toEqual([ARCHIVE]);
  });

  it('is named in the zone and the folder of the job', async () => {
    const harness = createHarness();
    const calls = await runJob(harness, zipJob([0], {}, { folderName: 'Backups/Discord' }));
    expect(blobsOf(calls)[0].filename).toBe('Backups/Discord/Discord Export 2026-10-06 2100.zip');
    const utc = createHarness();
    const utcCalls = await runJob(utc, { ...zipJob([0]), timeZone: 'UTC' });
    expect(blobsOf(utcCalls)[0].filename).toBe(`${FOLDER}/Discord Export 2026-10-06 1200.zip`);
  });

  it('takes the time of the name when the archive is saved (the end of the job)', async () => {
    const harness = createHarness({ deps: { sleep: async () => harness.setNow(harness.fake.calls.length > 0 ? Date.UTC(2026, 9, 6, 13, 30, 0) : Date.UTC(2026, 9, 6, 12, 0, 0)) } });
    const calls = await runJob(harness, zipJob([0, 1]));
    expect(blobsOf(calls)[0].filename).toBe(`${FOLDER}/Discord Export 2026-10-06 2230.zip`);
  });

  it('nothing is saved before the last chat is done', async () => {
    const harness = createHarness();
    const calls = await runJob(harness, zipJob());
    const firstSave = calls.findIndex((entry) => entry.call === 'saveBlob');
    const lastProgressBefore = snapshots(calls.slice(0, firstSave)).at(-1)!;
    expect(lastProgressBefore.items.map((row) => row.status)).toEqual(['done', 'done', 'done']);
    expect(calls.slice(0, firstSave).some((entry) => entry.call === 'itemDone')).toBe(false);
  });

  it('shares the entry paths between the chats of the job: two chats of the same name stay two entries', async () => {
    const world = chatWorld();
    world.channels = world.channels.map((entry) => (entry.id === CHATS[1] ? { ...entry, name: 'alpha' } : entry));
    const harness = createHarness({ world });
    const calls = await runJob(harness, zipJob([0, 1]));
    expect(Object.keys(await archiveOf(calls)).sort()).toEqual([ENTRY('alpha'), `Test Guild/Text Channels/alpha [${CHATS[1]}].json`].sort());
  });

  it('asks the library for links that are relative to the place of the file inside the archive', async () => {
    const world = chatWorld([{ attachments: [['11', 'cat.png', Math.floor(Date.UTC(2026, 9, 6, 11, 59) / 1000)]] }]);
    const harness = createHarness({ world });
    const calls = await runJob(harness, zipJob([0], { includeAttachments: true }));
    const entries = await archiveOf(calls);
    const document = JSON.parse(decode(entries[ENTRY('alpha')])) as { messages: Array<{ attachments: Array<{ local_path?: string }> }> };
    expect(document.messages[0].attachments[0].local_path).toBe('alpha_files/11_cat.png');
    expect(entries['Test Guild/Text Channels/alpha_files/11_cat.png']).toBeInstanceOf(Uint8Array);
  });
});

describe('ZIP: the history entries', () => {
  it('are sent after the archive is saved, in the order of the chats, each with the archive first', async () => {
    const harness = createHarness();
    const calls = await runJob(harness, zipJob());
    const saved = calls.findIndex((entry) => entry.call === 'saveBlob');
    const done = calls.flatMap((entry, index) => (entry.call === 'itemDone' ? [index] : []));
    expect(done).toHaveLength(3);
    expect(done.every((index) => index > saved)).toBe(true);
    const archive = blobsOf(calls)[0];
    const entries = itemDones(calls);
    expect(entries.map((entry) => entry.target.channelId)).toEqual([...CHATS]);
    expect(entries.map((entry) => entry.files)).toEqual([
      [{ filename: ARCHIVE, downloadId: archive.downloadId }, { filename: ENTRY('alpha'), downloadId: null }],
      [{ filename: ARCHIVE, downloadId: archive.downloadId }, { filename: ENTRY('beta'), downloadId: null }],
      [{ filename: ARCHIVE, downloadId: archive.downloadId }, { filename: ENTRY('gamma'), downloadId: null }],
    ]);
    expect(entries.every((entry) => entry.status === 'done' && entry.messageCount === 3 && entry.error === null)).toBe(true);
    expect(callsOf(calls, 'itemDone').map((entry) => entry.lastMessageId)).toEqual([messageIdAt(2), messageIdAt(2), messageIdAt(2)]);
  });

  it('a chat that failed is reported failed without files and is not in the archive; the archive is not marked partial', async () => {
    const harness = createHarness({ fail: (call) => (call.method === 'getChannel' && call.id === CHATS[1] ? new DiscordApiError('not-found', 'raw') : undefined) });
    const calls = await runJob(harness, zipJob());
    expect(blobsOf(calls)[0].filename).toBe(ARCHIVE);
    expect(Object.keys(await archiveOf(calls)).sort()).toEqual([ENTRY('alpha'), ENTRY('gamma')]);
    expect(statusesOf(calls)).toEqual(['done', 'failed', 'done']);
    expect(itemDones(calls)[1]).toMatchObject({ status: 'failed', files: [], messageCount: 0, error: 'The channel was not found. It may have been deleted' });
    expect(callsOf(calls, 'itemDone')[1].lastMessageId).toBeNull();
    expect(finishedOf(calls)).toEqual(['done']);
  });

  it('a partial chat goes into the archive under a name that says so, and is reported partial without a marker', async () => {
    const harness = createHarness({
      world: chatWorld([{}, { messages: 250 }]),
      fail: (call) => (call.method === 'getMessages' && call.id === CHATS[1] && call.n === 1 ? new DiscordApiError('server', 'raw') : undefined),
    });
    const calls = await runJob(harness, zipJob([0, 1]));
    expect(Object.keys(await archiveOf(calls)).sort()).toEqual([ENTRY('alpha'), 'Test Guild/Text Channels/beta (partial).json']);
    expect(itemDones(calls)[1]).toMatchObject({ status: 'partial', messageCount: 100, error: 'Discord has a problem on its side. Please try again in a moment' });
    expect(itemDones(calls)[1].files[0].filename).toBe(ARCHIVE);
    expect(callsOf(calls, 'itemDone')[1].lastMessageId).toBeNull();
  });

  it('saves no archive when no chat produced a file, and still reports the chats', async () => {
    const harness = createHarness({ fail: (call) => (call.method === 'getChannel' ? new DiscordApiError('forbidden', 'raw', { status: 403, code: 50001 }) : undefined) });
    const calls = await runJob(harness, zipJob([0, 1]));
    expect(blobsOf(calls)).toEqual([]);
    expect(itemDones(calls).map((entry) => [entry.status, entry.files])).toEqual([['failed', []], ['failed', []]]);
    expect(finishedOf(calls)).toEqual(['done']);
  });

  it('a chat without anything new (incremental) is done without being in the archive; the marker stays', async () => {
    const harness = createHarness();
    const calls = await runJob(harness, { ...zipJob([0, 1], { incremental: true }), lastExported: { [CHATS[0]]: messageIdAt(2) } });
    expect(Object.keys(await archiveOf(calls))).toEqual([ENTRY('beta')]);
    expect(itemDones(calls)[0]).toMatchObject({ status: 'done', messageCount: 0, files: [] });
    expect(callsOf(calls, 'itemDone')[0].lastMessageId).toBeNull();
    expect(callsOf(calls, 'itemDone')[1].lastMessageId).toBe(messageIdAt(2));
  });

  it('shows a chat done as soon as it is in the archive (the progress does not wait for the archive)', async () => {
    const harness = createHarness();
    const calls = await runJob(harness, zipJob([0, 1]));
    const firstDone = snapshots(calls).findIndex((state) => state.items[0].status === 'done');
    const archived = calls.findIndex((entry) => entry.call === 'saveBlob');
    expect(firstDone).toBeGreaterThan(-1);
    expect(calls.findIndex((entry) => entry.call === 'progress' && entry.job === snapshots(calls)[firstDone])).toBeLessThan(archived);
  });
});

describe('ZIP: the archive cannot be saved', () => {
  it('fails the chats that were in it (the data never reached the disk): no marker, a reason, the job failed', async () => {
    const harness = createHarness({ io: { failBlob: (filename) => filename.endsWith('.zip') } });
    const calls = await runJob(harness, zipJob([0, 1]));
    expect(blobsOf(calls)).toEqual([]);
    expect(statusesOf(calls)).toEqual(['failed', 'failed']);
    expect(itemDones(calls).map((entry) => [entry.status, entry.files, entry.error])).toEqual([
      ['failed', [], 'Could not save the ZIP file (the save was refused)'],
      ['failed', [], 'Could not save the ZIP file (the save was refused)'],
    ]);
    expect(callsOf(calls, 'itemDone').map((entry) => entry.lastMessageId)).toEqual([null, null]);
    expect(rowOf(calls, CHATS[0]).error).toEqual({ kind: 'unknown', message: 'Could not save the ZIP file (the save was refused)' });
    expect(finishedOf(calls)).toEqual(['failed']);
  });

  it('chats that were failed anyway keep their own reason', async () => {
    const harness = createHarness({
      io: { failBlob: () => true },
      fail: (call) => (call.method === 'getChannel' && call.id === CHATS[0] ? new DiscordApiError('forbidden', 'raw', { status: 403, code: 50001 }) : undefined),
    });
    const calls = await runJob(harness, zipJob([0, 1]));
    expect(itemDones(calls).map((entry) => entry.error)).toEqual(["You don't have permission to view this channel", 'Could not save the ZIP file (the save was refused)']);
  });
});

describe('ZIP: a full archive', () => {
  it('a chat that no longer fits is failed with the reason; chats that fit are kept; the job goes on', async () => {
    const harness = createHarness({ deps: { zipLimits: { maxEntries: 2 } } });
    const calls = await runJob(harness, zipJob());
    expect(Object.keys(await archiveOf(calls)).sort()).toEqual([ENTRY('alpha'), ENTRY('beta')]);
    expect(statusesOf(calls)).toEqual(['done', 'done', 'failed']);
    expect(itemDones(calls)[2]).toMatchObject({ status: 'failed', files: [], error: 'The ZIP file holds too many files (65,535 at most). Please download fewer chats at once' });
    expect(finishedOf(calls)).toEqual(['done']);
  });

  it('says so in Korean when the job is Korean, and names the size limit when the bytes ran out', async () => {
    const harness = createHarness({ deps: { zipLimits: { maxInputBytes: 10 } } });
    const calls = await runJob(harness, { ...zipJob([0]), locale: 'ko' });
    expect(itemDones(calls)[0]).toMatchObject({ status: 'failed', error: 'ZIP 파일 하나에 담을 수 있는 크기(약 3.75GB)를 넘었어요. 한 번에 받는 채팅 수를 줄여 주세요' });
    expect(blobsOf(calls)).toEqual([]);
  });

  it('a chat whose attachments no longer fit is partial: its file is in, the reason says why the rest is not', async () => {
    const harness = createHarness({
      deps: {
        zipLimits: { maxEntries: 2 },
        exportChat: scriptedExport({ [CHATS[0]]: () => resultOf(0, { attachments: [attachmentOf(0, '11', 'cat.png'), attachmentOf(0, '12', 'dog.png'), attachmentOf(0, '13', 'bird.png')] }) }),
      },
    });
    const calls = await runJob(harness, zipJob([0], { includeAttachments: true }));
    expect(Object.keys(await archiveOf(calls)).sort()).toEqual(['Test Guild/Text Channels/alpha_files/11_cat.png', ENTRY('alpha')].sort());
    expect(itemDones(calls)[0]).toMatchObject({ status: 'partial', error: 'The ZIP file holds too many files (65,535 at most). Please download fewer chats at once' });
    expect(callsOf(calls, 'itemDone')[0].lastMessageId).toBeNull();
    expect(urlsOf(calls)).toEqual([]);
  });

  it('does not download attachments once the archive is full', async () => {
    const harness = createHarness({
      deps: {
        zipLimits: { maxEntries: 1 },
        exportChat: scriptedExport({
          [CHATS[0]]: () => resultOf(0),
          [CHATS[1]]: () => resultOf(1, { attachments: [attachmentOf(1, '11', 'cat.png')] }),
        }),
      },
    });
    const calls = await runJob(harness, zipJob([0, 1], { includeAttachments: true }));
    expect(harness.fetched).toEqual([]);
    expect(statusesOf(calls)).toEqual(['done', 'failed']);
  });
});

describe('ZIP: a job that stops early saves what it has', () => {
  /** Cancels while chat `n` is walking its second page (a chat of 250 messages has three). */
  function cancelDuring(n: number): ReturnType<typeof createHarness> {
    const harness: ReturnType<typeof createHarness> = createHarness({
      world: chatWorld([{}, { messages: 250 }, {}]),
      fail: (call) => {
        if (call.method === 'getMessages' && call.id === CHATS[n] && call.n === 1) harness.fake.abort.abort();
        return undefined;
      },
    });
    return harness;
  }

  it('a cancel saves the chats that were finished as a partial archive, drops the chat in flight and ends the job cancelled', async () => {
    const harness = cancelDuring(1);
    const calls = await runJob(harness, zipJob());
    expect(blobsOf(calls)).toHaveLength(1);
    expect(blobsOf(calls)[0].filename).toBe(PARTIAL_ARCHIVE);
    expect(Object.keys(await archiveOf(calls))).toEqual([ENTRY('alpha')]);
    expect(statusesOf(calls)).toEqual(['done', 'cancelled', 'waiting']);
    expect(itemDones(calls).map((entry) => entry.target.channelId)).toEqual([CHATS[0]]); // the cancelled chat gets no entry
    expect(itemDones(calls)[0].files[0]).toEqual({ filename: PARTIAL_ARCHIVE, downloadId: blobsOf(calls)[0].downloadId });
    expect(finishedOf(calls)).toEqual(['cancelled']);
    expect(calls.at(-1)).toEqual({ call: 'finished', jobId: 'job-1', state: 'cancelled' });
  });

  it('the archive is saved before the job is reported finished (the background still takes saves until then)', async () => {
    const harness = cancelDuring(1);
    const calls = await runJob(harness, zipJob());
    const order = calls.flatMap((entry) => (entry.call === 'saveBlob' || entry.call === 'itemDone' || entry.call === 'finished' ? [entry.call] : []));
    expect(order).toEqual(['saveBlob', 'itemDone', 'finished']);
  });

  it('a cancel while the files of a chat are written drops that chat: nothing of it gets into the archive', async () => {
    const harness: ReturnType<typeof createHarness> = createHarness({
      deps: {
        exportChat: scriptedExport({
          [CHATS[1]]: () => {
            harness.fake.abort.abort();
            return resultOf(1);
          },
        }),
      },
    });
    const calls = await runJob(harness, zipJob());
    expect(blobsOf(calls)[0].filename).toBe(PARTIAL_ARCHIVE);
    expect(Object.keys(await archiveOf(calls))).toEqual([ENTRY('alpha')]);
    expect(statusesOf(calls)).toEqual(['done', 'cancelled', 'waiting']);
    expect(itemDones(calls).map((entry) => entry.target.channelId)).toEqual([CHATS[0]]);
  });

  it('a cancel while the attachments of a chat are fetched drops that chat: its file is not in the archive either', async () => {
    const harness: ReturnType<typeof createHarness> = createHarness({
      cdn: () => {
        harness.fake.abort.abort();
        return new Uint8Array([1]);
      },
      deps: {
        exportChat: scriptedExport({ [CHATS[1]]: () => resultOf(1, { attachments: [attachmentOf(1, '11', 'cat.png'), attachmentOf(1, '12', 'dog.png')] }) }),
      },
    });
    const calls = await runJob(harness, zipJob([0, 1], { includeAttachments: true }));
    expect(blobsOf(calls)[0].filename).toBe(PARTIAL_ARCHIVE);
    expect(Object.keys(await archiveOf(calls))).toEqual([ENTRY('alpha')]);
    expect(harness.fetched).toHaveLength(1);
    expect(statusesOf(calls)).toEqual(['done', 'cancelled']);
  });

  it('a cancel before any chat is finished saves nothing', async () => {
    const harness = cancelDuring(0);
    harness.fake.abort.abort();
    const calls = await runJob(harness, zipJob());
    expect(blobsOf(calls)).toEqual([]);
    expect(itemDones(calls)).toEqual([]);
    expect(finishedOf(calls)).toEqual(['cancelled']);
  });

  it('a 401 stops the job after its chat: what was finished is saved as a partial archive, the rest is failed, the job failed', async () => {
    let options: { onAuthError?: (value: string) => void } | undefined;
    const harness = createHarness({
      fail: (call) => {
        if (call.method === 'getMessages' && call.id === CHATS[1]) {
          options?.onAuthError?.('rejected');
          return new DiscordApiError('auth', 'raw 401', { status: 401 });
        }
        return undefined;
      },
      deps: { createClient: (opts) => ((options = opts), harness.client) },
    });
    const calls = await runJob(harness, zipJob());
    expect(blobsOf(calls).map((save) => save.filename)).toEqual([PARTIAL_ARCHIVE]);
    expect(Object.keys(await archiveOf(calls))).toEqual([ENTRY('alpha')]);
    expect(statusesOf(calls)).toEqual(['done', 'failed', 'failed']);
    expect(rowOf(calls, CHATS[2]).error).toEqual({ kind: 'auth', message: 'Your Discord login has expired. Please reload Discord' });
    expect(itemDones(calls).map((entry) => [entry.target.channelId, entry.status])).toEqual([[CHATS[0], 'done'], [CHATS[1], 'failed']]);
    expect(callsOf(calls, 'authError')).toHaveLength(1);
    expect(finishedOf(calls)).toEqual(['failed']);
    expect(lastSnapshot(calls).state).toBe('failed');
  });
});
