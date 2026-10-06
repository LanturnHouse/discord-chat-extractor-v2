/**
 * Attachments in both modes of the download engine (docs/PLAN.md §6.5): one copy per path, saved after the file that shows them,
 * stale signed URLs refreshed first, a copy that cannot be saved never fails the chat. Individual-file mode hands the CDN URL to
 * the background (`io.saveUrl`); ZIP mode fetches the bytes itself and adds them to the archive.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CHATS,
  FOLDER,
  FRESH_SECONDS,
  STALE_SECONDS,
  attachmentOf,
  blobsOf,
  callsOf,
  chatWorld,
  createHarness,
  decode,
  itemDones,
  jobOf,
  resultOf,
  rowOf,
  runJob,
  scriptedExport,
  signedUrl,
  snapshots,
  statusesOf,
  unzip,
  urlsOf,
} from './kit';

const FILES = `${FOLDER}/Test Guild - alpha (2026-10-06)_files`;
const FRESH_CAT = signedUrl('11', 'cat.png', FRESH_SECONDS);
const STALE_DOG = signedUrl('12', 'dog.png', STALE_SECONDS);
const WITH_ATTACHMENTS = { includeAttachments: true } as const;

/** Chat 0 with a fresh and a stale attachment on its first message, exported by the real library. */
const worldWithAttachments = () => chatWorld([{ attachments: [['11', 'cat.png', FRESH_SECONDS], ['12', 'dog.png', STALE_SECONDS]] }]);

describe('individual files: attachments', () => {
  it('saves nothing but the chat when attachments are not asked for', async () => {
    const harness = createHarness({ world: worldWithAttachments() });
    const calls = await runJob(harness, jobOf([0]));
    expect(urlsOf(calls)).toEqual([]);
    expect(harness.client.calls('getMessages')).toHaveLength(1);
  });

  it('hands every attachment to the background after the chat file, one by one, at the path the file links to', async () => {
    const harness = createHarness({ world: worldWithAttachments() });
    const calls = await runJob(harness, jobOf([0], WITH_ATTACHMENTS));
    const order = calls.flatMap((entry) => (entry.call === 'saveBlob' ? [`blob:${entry.filename}`] : entry.call === 'saveUrl' ? [`url:${entry.filename}`] : []));
    expect(order).toEqual([
      `blob:${FOLDER}/Test Guild - alpha (2026-10-06).json`,
      `url:${FILES}/11_cat.png`,
      `url:${FILES}/12_dog.png`,
    ]);
    expect(urlsOf(calls).every((save) => save.jobId === 'job-1' && save.itemKey === CHATS[0])).toBe(true);
    const document = JSON.parse(await blobsOf(calls)[0].blob.text()) as { messages: Array<{ attachments: Array<{ id: string; local_path?: string }> }> };
    expect(document.messages[0].attachments.map((attachment) => attachment.local_path)).toEqual(['Test Guild - alpha (2026-10-06)_files/11_cat.png', 'Test Guild - alpha (2026-10-06)_files/12_dog.png']);
  });

  it('lists the saved copies in the history entry after the chat file, each with its download id', async () => {
    const harness = createHarness({ world: worldWithAttachments() });
    const calls = await runJob(harness, jobOf([0], WITH_ATTACHMENTS));
    const [entry] = itemDones(calls);
    expect(entry.status).toBe('done');
    expect(entry.error).toBeNull();
    expect(entry.files).toEqual([
      { filename: `${FOLDER}/Test Guild - alpha (2026-10-06).json`, downloadId: blobsOf(calls)[0].downloadId },
      { filename: `${FILES}/11_cat.png`, downloadId: urlsOf(calls)[0].downloadId },
      { filename: `${FILES}/12_dog.png`, downloadId: urlsOf(calls)[1].downloadId },
    ]);
    expect(rowOf(calls, CHATS[0]).files).toEqual(entry.files.map((file) => file.filename));
  });

  it('shows the phase of the attachments while they are saved', async () => {
    const harness = createHarness({ world: worldWithAttachments() });
    const calls = await runJob(harness, jobOf([0], WITH_ATTACHMENTS));
    const phases = snapshots(calls).map((state) => state.items[0].phase);
    expect(phases).toContain('attachments');
    expect(phases.indexOf('saving')).toBeLessThan(phases.indexOf('attachments'));
    expect(phases.at(-1)).toBeNull();
  });

  it('refreshes the signed URLs that are older than six hours first, and only those', async () => {
    const harness = createHarness({ world: worldWithAttachments() });
    const refresh = vi.spyOn(harness.client, 'refreshAttachmentUrls');
    const calls = await runJob(harness, jobOf([0], WITH_ATTACHMENTS));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][0]).toEqual([STALE_DOG]);
    expect(urlsOf(calls).map((save) => save.url)).toEqual([FRESH_CAT, `${STALE_DOG}&refreshed=1`]);
  });

  it('does not ask Discord for anything when no URL is stale', async () => {
    const harness = createHarness({ world: chatWorld([{ attachments: [['11', 'cat.png', FRESH_SECONDS]] }]) });
    const refresh = vi.spyOn(harness.client, 'refreshAttachmentUrls');
    const calls = await runJob(harness, jobOf([0], WITH_ATTACHMENTS));
    expect(refresh).not.toHaveBeenCalled();
    expect(urlsOf(calls).map((save) => save.url)).toEqual([FRESH_CAT]);
  });

  it('uses the stale URL itself when Discord does not answer for it', async () => {
    const harness = createHarness({ world: worldWithAttachments() });
    vi.spyOn(harness.client, 'refreshAttachmentUrls').mockResolvedValue([]);
    const calls = await runJob(harness, jobOf([0], WITH_ATTACHMENTS));
    expect(urlsOf(calls).map((save) => save.url)).toEqual([FRESH_CAT, STALE_DOG]);
  });

  it('keeps one copy per path: attachments that would be saved to the same place are saved once', async () => {
    const same = attachmentOf(0, '11', 'cat.png');
    const harness = createHarness({
      deps: { exportChat: scriptedExport({ [CHATS[0]]: () => resultOf(0, { attachments: [same, { ...same, url: signedUrl('11', 'cat.png', FRESH_SECONDS - 5) }, attachmentOf(0, '12', 'dog.png')] }) }) },
    });
    const calls = await runJob(harness, jobOf([0], WITH_ATTACHMENTS));
    expect(urlsOf(calls).map((save) => save.filename)).toEqual([`${FILES}/11_cat.png`, `${FILES}/12_dog.png`]);
    expect(urlsOf(calls)[0].url).toBe(same.url);
  });

  it('a chat with a great many attachments names only the first hundred files in its entry; all of them are saved', async () => {
    const many = Array.from({ length: 120 }, (_, n) => attachmentOf(0, String(1000 + n), `f${n}.png`));
    const harness = createHarness({ deps: { exportChat: scriptedExport({ [CHATS[0]]: () => resultOf(0, { attachments: many }) }) } });
    const calls = await runJob(harness, jobOf([0], WITH_ATTACHMENTS));
    expect(urlsOf(calls)).toHaveLength(120);
    const [entry] = itemDones(calls);
    expect(entry.files).toHaveLength(100);
    expect(entry.files[0].filename).toBe(`${FOLDER}/Test Guild - alpha (2026-10-06).json`);
    expect(rowOf(calls, CHATS[0]).files).toHaveLength(100);
  });

  it('a copy the background refuses to save is a note on the chat, which stays done (and keeps its marker)', async () => {
    const harness = createHarness({ world: worldWithAttachments(), io: { failUrl: (filename) => filename.endsWith('11_cat.png') } });
    const calls = await runJob(harness, jobOf([0], WITH_ATTACHMENTS));
    expect(urlsOf(calls).map((save) => save.filename)).toEqual([`${FILES}/12_dog.png`]); // the other one was still saved
    const [done] = callsOf(calls, 'itemDone');
    expect(done.entry).toMatchObject({ status: 'done', error: '1 attachment could not be saved' });
    expect(done.entry.files.map((file) => file.filename)).toEqual([`${FOLDER}/Test Guild - alpha (2026-10-06).json`, `${FILES}/12_dog.png`]);
    expect(done.lastMessageId).not.toBeNull();
    expect(statusesOf(calls)).toEqual(['done']);
    expect(rowOf(calls, CHATS[0]).error).toEqual({ kind: 'unknown', message: '1 attachment could not be saved' });
  });

  it('counts the copies that could not be saved, in the language of the job', async () => {
    const harness = createHarness({ world: worldWithAttachments(), io: { failUrl: () => true } });
    const calls = await runJob(harness, jobOf([0], WITH_ATTACHMENTS, { locale: 'ko' }));
    expect(itemDones(calls)[0]).toMatchObject({ status: 'done', error: '첨부파일 2개를 저장하지 못했어요' });
    const english = createHarness({ world: worldWithAttachments(), io: { failUrl: () => true } });
    expect(itemDones(await runJob(english, jobOf([0], WITH_ATTACHMENTS)))[0].error).toBe('2 attachments could not be saved');
  });

  it('never hands anything that is not on the Discord CDN to the background (it counts as a copy that could not be saved)', async () => {
    const harness = createHarness({
      deps: { exportChat: scriptedExport({ [CHATS[0]]: () => resultOf(0, { attachments: [attachmentOf(0, '11', 'cat.png', 'https://example.com/cat.png'), attachmentOf(0, '12', 'dog.png')] }) }) },
    });
    const calls = await runJob(harness, jobOf([0], WITH_ATTACHMENTS));
    expect(urlsOf(calls).map((save) => save.filename)).toEqual([`${FILES}/12_dog.png`]);
    expect(itemDones(calls)[0]).toMatchObject({ status: 'done', error: '1 attachment could not be saved' });
  });

  it('saves no attachments when the chat file itself could not be saved (nothing for them to belong to)', async () => {
    const harness = createHarness({ world: worldWithAttachments(), io: { failBlob: () => true } });
    const calls = await runJob(harness, jobOf([0], WITH_ATTACHMENTS));
    expect(urlsOf(calls)).toEqual([]);
    expect(itemDones(calls)[0]).toMatchObject({ status: 'failed', files: [] });
  });

  it('a partial chat still gets the copies of the attachments it names', async () => {
    const harness = createHarness({
      deps: { exportChat: scriptedExport({ [CHATS[0]]: () => resultOf(0, { status: 'partial', lastMessageId: null, error: { kind: 'network', message: 'raw' }, attachments: [attachmentOf(0, '11', 'cat.png')] }) }) },
    });
    const calls = await runJob(harness, jobOf([0], WITH_ATTACHMENTS));
    expect(urlsOf(calls)).toHaveLength(1);
    expect(itemDones(calls)[0]).toMatchObject({ status: 'partial', error: 'Could not connect to the network' });
    expect(itemDones(calls)[0].files).toHaveLength(2);
  });

  it('a chat without attachments is happy with the setting on', async () => {
    const harness = createHarness();
    const refresh = vi.spyOn(harness.client, 'refreshAttachmentUrls');
    const calls = await runJob(harness, jobOf([0, 1], WITH_ATTACHMENTS));
    expect(urlsOf(calls)).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
    expect(statusesOf(calls)).toEqual(['done', 'done']);
  });
});

describe('ZIP: attachments', () => {
  const zipJob = (chats: readonly number[] = [0], settings = WITH_ATTACHMENTS) => jobOf(chats, settings, { app: { zipAll: true } });
  const archiveOf = async (calls: Awaited<ReturnType<typeof runJob>>) => unzip(blobsOf(calls).at(-1)!.blob);
  const ENTRY = 'Test Guild/Text Channels/alpha_files';

  it('fetches the bytes from the CDN without credentials and adds them next to the chat file in the archive', async () => {
    const harness = createHarness({ world: worldWithAttachments(), cdn: (url) => new TextEncoder().encode(`bytes of ${url.includes('/11/') ? 'cat' : 'dog'}`) });
    const calls = await runJob(harness, zipJob());
    const entries = await archiveOf(calls);
    expect(Object.keys(entries).sort()).toEqual([`${ENTRY}/11_cat.png`, `${ENTRY}/12_dog.png`, 'Test Guild/Text Channels/alpha.json'].sort());
    expect(decode(entries[`${ENTRY}/11_cat.png`])).toBe('bytes of cat');
    expect(decode(entries[`${ENTRY}/12_dog.png`])).toBe('bytes of dog');
    expect(harness.fetched.every((request) => request.credentials === 'omit')).toBe(true);
    expect(urlsOf(calls)).toEqual([]); // nothing goes to the background as a CDN download in ZIP mode
  });

  it('refreshes stale URLs before it fetches', async () => {
    const harness = createHarness({ world: worldWithAttachments() });
    const refresh = vi.spyOn(harness.client, 'refreshAttachmentUrls');
    await runJob(harness, zipJob());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][0]).toEqual([STALE_DOG]);
    expect(harness.fetched.map((request) => request.url)).toEqual([FRESH_CAT, `${STALE_DOG}&refreshed=1`]);
  });

  it('keeps one copy per path', async () => {
    const same = attachmentOf(0, '11', 'cat.png');
    const harness = createHarness({ deps: { exportChat: scriptedExport({ [CHATS[0]]: () => resultOf(0, { attachments: [same, { ...same }, attachmentOf(0, '12', 'dog.png')] }) }) } });
    const calls = await runJob(harness, zipJob());
    expect(harness.fetched).toHaveLength(2);
    expect(Object.keys(await archiveOf(calls)).sort()).toEqual([`${ENTRY}/11_cat.png`, `${ENTRY}/12_dog.png`, 'Test Guild/Text Channels/alpha.json'].sort());
  });

  it('a CDN that answers with an error status is a note on the chat: the chat file is in the archive, the copy is not', async () => {
    const harness = createHarness({ world: worldWithAttachments(), cdn: (url) => (url.includes('/11/') ? 404 : new Uint8Array([9])) });
    const calls = await runJob(harness, zipJob());
    expect(Object.keys(await archiveOf(calls)).sort()).toEqual(['Test Guild/Text Channels/alpha.json', `${ENTRY}/12_dog.png`]);
    expect(itemDones(calls)[0]).toMatchObject({ status: 'done', error: '1 attachment could not be saved' });
    expect(statusesOf(calls)).toEqual(['done']);
  });

  it('a fetch that fails (no network) is the same', async () => {
    const harness = createHarness({
      world: worldWithAttachments(),
      deps: { fetch: (async () => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch },
    });
    const calls = await runJob(harness, zipJob());
    expect(Object.keys(await archiveOf(calls))).toEqual(['Test Guild/Text Channels/alpha.json']);
    expect(itemDones(calls)[0]).toMatchObject({ status: 'done', error: '2 attachments could not be saved' });
  });

  it('never fetches anything that is not on the Discord CDN', async () => {
    const harness = createHarness({
      deps: { exportChat: scriptedExport({ [CHATS[0]]: () => resultOf(0, { attachments: [attachmentOf(0, '11', 'cat.png', 'https://example.com/cat.png'), attachmentOf(0, '12', 'dog.png', 'http://cdn.discordapp.com/dog.png')] }) }) },
    });
    const calls = await runJob(harness, zipJob());
    expect(harness.fetched).toEqual([]);
    expect(itemDones(calls)[0]).toMatchObject({ status: 'done', error: '2 attachments could not be saved' });
  });

  it('lists the entries of the chat in its history entry, after the archive itself', async () => {
    const harness = createHarness({ world: worldWithAttachments() });
    const calls = await runJob(harness, zipJob());
    const archive = blobsOf(calls).at(-1)!;
    expect(itemDones(calls)[0].files).toEqual([
      { filename: archive.filename, downloadId: archive.downloadId },
      { filename: 'Test Guild/Text Channels/alpha.json', downloadId: null },
      { filename: `${ENTRY}/11_cat.png`, downloadId: null },
      { filename: `${ENTRY}/12_dog.png`, downloadId: null },
    ]);
  });

  it('attachments are not fetched for a chat that produced no file', async () => {
    const harness = createHarness({
      deps: { exportChat: scriptedExport({ [CHATS[0]]: () => resultOf(0, { outputs: [], attachments: [attachmentOf(0, '11', 'cat.png')] }) }) },
    });
    await runJob(harness, zipJob());
    expect(harness.fetched).toEqual([]);
  });
});
