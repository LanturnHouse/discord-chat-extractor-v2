/**
 * The verdict on a chat (src/offscreen/engine/item.ts `conclude`, docs/PLAN.md §6.3, §6.7) and the helpers around the attachments
 * (src/offscreen/engine/attachments.ts), on their own: what `exportChat` reported plus what the saving step managed decides
 * done / partial / failed, the reason that is shown, and whether the chat moves the incremental marker.
 */
import { describe, expect, it, vi } from 'vitest';
import { DiscordApiError } from '@/lib';
import type { ExportChatResult } from '@/lib';
import { conclude, failedOutcome } from '@/offscreen/engine/item';
import { downloadAttachment, uniqueByPath } from '@/offscreen/engine/attachments';
import { createTexts } from '@/offscreen/engine/texts';
import type { SaveReport } from '@/offscreen/engine/types';
import { TOKEN, attachmentOf, messageIdAt, resultOf } from './kit';

const texts = createTexts('en', TOKEN);
const NEWEST = messageIdAt(2);

const report = (overrides: Partial<SaveReport> = {}): SaveReport => ({
  outputs: 1,
  savedOutputs: 1,
  files: [{ filename: 'a.json', downloadId: 1 }],
  outputError: null,
  attachmentsMissed: 0,
  limitError: null,
  ...overrides,
});

const network = { kind: 'network', message: 'raw' } as const;
const saveError = texts.saveFailure(new Error('refused'));

describe('conclude', () => {
  it('everything saved: done, with the newest message as the marker, the files and no error', () => {
    expect(conclude(texts, resultOf(0), report(), false)).toEqual({
      status: 'done',
      messageCount: 3,
      lastMessageId: NEWEST,
      files: [{ filename: 'a.json', downloadId: 1 }],
      error: null,
      inArchive: false,
    });
  });

  it('done with nothing to save (nothing new): still done, no files, a null marker', () => {
    const outcome = conclude(texts, resultOf(0, { outputs: [], messageCount: 0, lastMessageId: null }), report({ outputs: 0, savedOutputs: 0, files: [] }), false);
    expect(outcome).toMatchObject({ status: 'done', messageCount: 0, lastMessageId: null, files: [], error: null });
  });

  it('attachments that were left out are a note on a done chat', () => {
    expect(conclude(texts, resultOf(0), report({ attachmentsMissed: 3 }), false)).toMatchObject({ status: 'done', lastMessageId: NEWEST, error: { kind: 'unknown', message: '3 attachments could not be saved' } });
  });

  it('a ZIP that ran full while the attachments were added makes the chat partial, with that reason and no marker', () => {
    const limit = texts.zipLimit('entries');
    expect(conclude(texts, resultOf(0), report({ limitError: limit, attachmentsMissed: 2 }), true)).toMatchObject({ status: 'partial', lastMessageId: null, error: limit, inArchive: true });
  });

  it('what the library reports as partial stays partial, with its reason in the language of the job and no marker', () => {
    const result: ExportChatResult = resultOf(0, { status: 'partial', lastMessageId: null, error: network });
    expect(conclude(texts, result, report(), false)).toMatchObject({ status: 'partial', lastMessageId: null, messageCount: 3, error: { kind: 'network', message: 'Could not connect to the network' } });
  });

  it('a problem the library reported comes before a problem of the saving step', () => {
    const result: ExportChatResult = resultOf(0, { status: 'partial', lastMessageId: null, error: network });
    expect(conclude(texts, result, report({ outputs: 2, savedOutputs: 1, outputError: saveError }), false).error).toEqual({ kind: 'network', message: 'Could not connect to the network' });
  });

  it('files that could not all be saved: partial, with the reason of the save, no marker', () => {
    expect(conclude(texts, resultOf(0), report({ outputs: 2, savedOutputs: 1, outputError: saveError }), false)).toMatchObject({ status: 'partial', lastMessageId: null, error: saveError });
  });

  it('nothing could be saved: failed, with the reason of the save, nothing counted', () => {
    expect(conclude(texts, resultOf(0), report({ savedOutputs: 0, files: [], outputError: saveError }), false)).toEqual({
      status: 'failed',
      messageCount: 0,
      lastMessageId: null,
      files: [],
      error: saveError,
      inArchive: false,
    });
  });

  it('nothing could be saved of a chat the library gave up on halfway: the failure of the save still wins (there was data, it is lost)', () => {
    const result: ExportChatResult = resultOf(0, { status: 'partial', lastMessageId: null, error: network });
    expect(conclude(texts, result, report({ savedOutputs: 0, files: [], outputError: saveError }), false)).toMatchObject({ status: 'failed', error: saveError });
  });

  it('a chat the library could not export at all: failed with its reason', () => {
    const result: ExportChatResult = resultOf(0, { outputs: [], status: 'failed', messageCount: 0, lastMessageId: null, error: { kind: 'forbidden', message: 'raw' } });
    expect(conclude(texts, result, report({ outputs: 0, savedOutputs: 0, files: [] }), false)).toEqual(failedOutcome({ kind: 'forbidden', message: "You don't have permission to view this channel" }));
  });

  it('is in the archive only when something of it was added to the archive', () => {
    expect(conclude(texts, resultOf(0), report(), true).inArchive).toBe(true);
    expect(conclude(texts, resultOf(0), report(), false).inArchive).toBe(false);
    expect(conclude(texts, resultOf(0, { outputs: [] }), report({ outputs: 0, savedOutputs: 0, files: [] }), true).inArchive).toBe(false);
    expect(conclude(texts, resultOf(0), report({ savedOutputs: 0, files: [], outputError: saveError }), true).inArchive).toBe(false);
  });

  it('only a done chat has a marker, whatever else the library said', () => {
    const outcomes = [
      conclude(texts, resultOf(0), report(), false),
      conclude(texts, resultOf(0), report({ limitError: texts.zipLimit('bytes') }), true),
      conclude(texts, resultOf(0, { status: 'partial', error: network }), report(), false),
      conclude(texts, resultOf(0), report({ savedOutputs: 0, outputError: saveError }), false),
    ];
    expect(outcomes.map((outcome) => [outcome.status, outcome.lastMessageId])).toEqual([['done', NEWEST], ['partial', null], ['partial', null], ['failed', null]]);
  });
});

describe('uniqueByPath', () => {
  it('keeps the first attachment of every path, in order', () => {
    const one = attachmentOf(0, '1', 'a.png');
    const two = attachmentOf(0, '2', 'b.png');
    const again = { ...one, url: 'https://cdn.discordapp.com/other' };
    expect(uniqueByPath([one, two, again], (attachment) => attachment.path)).toEqual([one, two]);
    expect(uniqueByPath([one, again], (attachment) => attachment.zipPath)).toEqual([one]);
    expect(uniqueByPath([], (attachment) => attachment.path)).toEqual([]);
  });

  it('decides by the path it is asked about: different ids are different files, whatever the URL', () => {
    const one = attachmentOf(0, '1', 'a.png');
    const other = attachmentOf(0, '2', 'a.png');
    expect(uniqueByPath([one, other], (attachment) => attachment.path)).toHaveLength(2);
    expect(uniqueByPath([one, other], () => 'same')).toEqual([one]);
  });
});

describe('downloadAttachment', () => {
  const signal = () => new AbortController().signal;

  it('returns the bytes of an answer that is ok, asking without credentials and under the signal', async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([4, 5, 6])));
    const controller = new AbortController();
    const blob = await downloadAttachment(fetchFn as unknown as typeof fetch, 'https://cdn.discordapp.com/a', controller.signal);
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
    expect(fetchFn).toHaveBeenCalledWith('https://cdn.discordapp.com/a', { credentials: 'omit', signal: controller.signal });
  });

  it('returns null for an error status and does not read what follows it', async () => {
    const response = new Response('gone', { status: 404 });
    const cancel = vi.spyOn(response.body as ReadableStream, 'cancel');
    expect(await downloadAttachment((async () => response) as unknown as typeof fetch, 'https://cdn.discordapp.com/a', signal())).toBeNull();
    expect(cancel).toHaveBeenCalled();
  });

  it('returns null when the request fails', async () => {
    expect(await downloadAttachment((async () => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch, 'https://cdn.discordapp.com/a', signal())).toBeNull();
  });

  it('returns null when reading the body fails', async () => {
    const broken = { ok: true, body: null, blob: () => Promise.reject(new TypeError('network error')) };
    expect(await downloadAttachment((async () => broken) as unknown as typeof fetch, 'https://cdn.discordapp.com/a', signal())).toBeNull();
  });

  it('passes a cancel on: whatever the request rejects with, once the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(downloadAttachment((async () => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch, 'https://cdn.discordapp.com/a', controller.signal)).rejects.toThrow('Failed to fetch');
    await expect(downloadAttachment((async () => Promise.reject(new DOMException('aborted', 'AbortError'))) as unknown as typeof fetch, 'https://cdn.discordapp.com/a', signal())).rejects.toMatchObject({ name: 'AbortError' });
    await expect(downloadAttachment((async () => Promise.reject(new DiscordApiError('aborted', 'x'))) as unknown as typeof fetch, 'https://cdn.discordapp.com/a', signal())).rejects.toMatchObject({ name: 'AbortError' });
  });
});
