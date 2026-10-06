/**
 * Saving files for the engine, and the life of the blob URLs and the offscreen document around it (docs/PLAN.md §3, §5.3, §8):
 * `engine/saveBlob` / `engine/saveUrl` -> chrome.downloads, `engine/revoke` once a download is over, the document closed when
 * nothing needs it. The engine is played through the real offscreen host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION } from '@/shared';
import type { JobState } from '@/shared';
import { EngineSaveError } from '@/offscreen/runner';
import { BG_STATE_KEY } from '@/background/store';
import type { BgState } from '@/background/store';
import { EXTENSION_ID, EXTENSION_URL, createFakeBrowser } from './fakeChrome';
import type { FakeBrowser, FakePage } from './fakeChrome';
import {
  CHANNEL_A,
  CHANNEL_B,
  bootLoggedIn,
  guildTarget,
  installEngine,
  queueItem,
  scriptedEngine,
  seedConsent,
  seedQueue,
  settle,
  startJobWith,
  waitFor,
} from './helpers';
import type { EngineHarness, ScriptedEngine } from './helpers';

let fake: FakeBrowser;
let popup: FakePage;
let engine: ScriptedEngine;
let harness: EngineHarness;
let jobId: string;

const bgState = () => fake.session.peek<BgState>(BG_STATE_KEY) as BgState;
const pendingBlobs = () => Object.keys(bgState()?.blobs ?? {});
const html = () => new Blob(['<html></html>'], { type: 'text/html' });
const rawSave = (message: Record<string, unknown>) => harness.page!.send({ to: 'bg', ...message });

beforeEach(async () => {
  fake = createFakeBrowser();
  ({ popup } = await bootLoggedIn(fake));
  engine = scriptedEngine();
  harness = installEngine(fake, { runner: engine.runner });
  seedConsent(fake);
  seedQueue(fake, [queueItem(guildTarget(CHANNEL_A)), queueItem(guildTarget(CHANNEL_B))]);
  jobId = await startJobWith(popup, engine);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('engine/saveBlob', () => {
  it('downloads the blob URL with the filename, uniquify and no dialog, and answers with the download id', async () => {
    const downloadId = await engine.io!.saveBlob(jobId, CHANNEL_A, html(), 'Discord Export/Test Server - general (2026-10-06).html');
    expect(downloadId).toBe(1);
    expect(fake.downloads.items).toHaveLength(1);
    expect(fake.downloads.items[0].options).toEqual({
      url: harness.blobUrls[0],
      filename: 'Discord Export/Test Server - general (2026-10-06).html',
      conflictAction: 'uniquify',
      saveAs: false,
    });
    expect(harness.blobUrls[0]).toMatch(new RegExp(`^blob:chrome-extension://${EXTENSION_ID}/`));
  });

  it('accepts a null item key (one ZIP for several chats)', async () => {
    await expect(engine.io!.saveBlob(jobId, null, html(), 'Discord Export/Discord Export 2026-10-06 1530.zip')).resolves.toBe(1);
  });

  it('remembers the pending blob download (in session storage, so a worker restart does not forget it) and the last download id', async () => {
    const first = await engine.io!.saveBlob(jobId, CHANNEL_A, html(), 'a.html');
    const second = await engine.io!.saveBlob(jobId, CHANNEL_B, html(), 'b.html');
    expect(bgState().blobs).toEqual({ [first]: harness.blobUrls[0], [second]: harness.blobUrls[1] });
    expect(bgState().lastDownloadId).toBe(second);
    expect(bgState().jobId).toBe(jobId);
  });

  it('revokes the blob URL when the download completes, and only then', async () => {
    const id = await engine.io!.saveBlob(jobId, CHANNEL_A, html(), 'a.html');
    await settle();
    expect(harness.revoked).toEqual([]);
    fake.completeDownload(id);
    await waitFor(() => harness.revoked.length === 1);
    expect(harness.revoked).toEqual([harness.blobUrls[0]]);
    await waitFor(() => pendingBlobs().length === 0);
  });

  it('revokes it when the download is interrupted too (cancelled by the user, disk full)', async () => {
    const id = await engine.io!.saveBlob(jobId, CHANNEL_A, html(), 'a.html');
    fake.interruptDownload(id);
    await waitFor(() => harness.revoked.length === 1);
    expect(pendingBlobs()).toEqual([]);
  });

  it('revokes each URL once, whatever the event order', async () => {
    const first = await engine.io!.saveBlob(jobId, CHANNEL_A, html(), 'a.html');
    const second = await engine.io!.saveBlob(jobId, CHANNEL_B, html(), 'b.html');
    fake.completeDownload(second);
    await waitFor(() => harness.revoked.length === 1);
    expect(harness.revoked).toEqual([harness.blobUrls[1]]);
    fake.completeDownload(first);
    await waitFor(() => harness.revoked.length === 2);
    fake.onDownloadChanged.dispatch({ id: first, state: { current: 'complete' } }); // a repeated event
    await settle();
    expect(harness.revoked).toHaveLength(2);
  });

  it('a download that finishes before it was recorded is revoked anyway', async () => {
    fake.downloads.autoComplete = true;
    await engine.io!.saveBlob(jobId, CHANNEL_A, html(), 'a.html');
    await waitFor(() => harness.revoked.length === 1);
    await waitFor(() => pendingBlobs().length === 0);
  });

  it('ignores downloads that are not ours (nothing to revoke, nothing closes)', async () => {
    fake.onDownloadChanged.dispatch({ id: 999, state: { previous: 'in_progress', current: 'complete' } });
    await settle();
    expect(harness.revoked).toEqual([]);
    expect(fake.offscreen.open).toBe(true);
    // and events that are not a state change
    const id = await engine.io!.saveBlob(jobId, CHANNEL_A, html(), 'a.html');
    fake.onDownloadChanged.dispatch({ id, filename: { current: '/x/a.html' } });
    fake.onDownloadChanged.dispatch({ id, state: { current: 'in_progress' } });
    await settle();
    expect(harness.revoked).toEqual([]);
    expect(pendingBlobs()).toEqual([String(id)]);
  });

  describe('is refused (and the engine host frees the blob URL itself)', () => {
    it.each([
      ['an absolute path', '/etc/passwd'],
      ['a drive path', 'C:\\Windows\\x.html'],
      ['a parent segment', 'Discord Export/../../x.html'],
      ['an empty segment', 'Discord Export//x.html'],
      ['a backslash', 'Discord Export\\x.html'],
      ['an empty name', ''],
      ['a trailing slash', 'Discord Export/'],
      ['a wildcard', 'Discord Export/*.html'],
    ])('a filename with %s', async (_label, filename) => {
      await expect(engine.io!.saveBlob(jobId, CHANNEL_A, html(), filename)).rejects.toMatchObject({ name: 'EngineSaveError', code: 'invalid' });
      expect(fake.downloads.items).toEqual([]);
      expect(harness.revoked).toEqual(harness.blobUrls); // freed straight away: nobody else knows it
      expect(pendingBlobs()).toEqual([]);
    });

    it('the error says why (and carries no secret)', async () => {
      const error = await engine.io!.saveBlob(jobId, CHANNEL_A, html(), '../x').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(EngineSaveError);
      expect((error as EngineSaveError).message).toMatch(/relative path/);
    });
  });

  describe('raw messages that the host would never send', () => {
    const base = () => ({ type: 'engine/saveBlob', jobId, itemKey: null, url: `blob:${EXTENSION_URL}0f8fad5b`, filename: 'a.html' });

    it.each([
      ['a URL that is not a blob', { url: 'https://cdn.discordapp.com/a.png' }],
      ['a blob of a web page', { url: 'blob:https://discord.com/0f8fad5b' }],
      ['a blob of another extension', { url: 'blob:chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/0f8fad5b' }],
      ['a file: URL', { url: 'file:///C:/secret.txt' }],
      ['no URL', { url: undefined }],
      ['no job id', { jobId: undefined }],
      ['another job', { jobId: 'some-other-job' }],
      ['an item key that is a number', { itemKey: 5 }],
      ['no filename', { filename: undefined }],
    ])('%s', async (_label, overrides) => {
      await expect(rawSave({ ...base(), ...overrides })).resolves.toMatchObject({ ok: false, error: 'invalid' });
      expect(fake.downloads.items).toEqual([]);
    });
  });

  it('is refused once the job is over (a late message of a finished job)', async () => {
    await engine.io!.finished(jobId, 'done');
    await expect(rawSave({ type: 'engine/saveBlob', jobId, itemKey: null, url: `blob:${EXTENSION_URL}0f8fad5b`, filename: 'a.html' })).resolves.toMatchObject({
      ok: false,
      error: 'invalid',
    });
    expect(fake.downloads.items).toEqual([]);
  });

  it('turns a browser error into a failed save and frees the blob URL', async () => {
    fake.downloads.failNext = new Error('Download canceled by the user');
    const error = await engine.io!.saveBlob(jobId, CHANNEL_A, html(), 'a.html').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'EngineSaveError', code: 'unknown', message: 'Download canceled by the user' });
    expect(harness.revoked).toEqual(harness.blobUrls);
    expect(pendingBlobs()).toEqual([]);
  });

  it('a browser that answers with no download id is a failed save', async () => {
    (chrome.downloads.download as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await expect(engine.io!.saveBlob(jobId, CHANNEL_A, html(), 'a.html')).rejects.toMatchObject({ code: 'unknown' });
  });
});

describe('engine/saveUrl (attachments, one file at a time)', () => {
  const cdn = 'https://cdn.discordapp.com/attachments/1/2/photo.png?ex=1&is=2&hm=3';

  it('downloads a Discord CDN URL straight away and does not track it (no blob to free)', async () => {
    const id = await engine.io!.saveUrl(jobId, CHANNEL_A, cdn, 'Discord Export/Test Server - general_files/2_photo.png');
    expect(fake.downloads.items[0].options).toEqual({
      url: cdn,
      filename: 'Discord Export/Test Server - general_files/2_photo.png',
      conflictAction: 'uniquify',
      saveAs: false,
    });
    expect(pendingBlobs()).toEqual([]);
    expect(bgState().lastDownloadId).toBe(id);
    fake.completeDownload(id);
    await settle();
    expect(harness.revoked).toEqual([]);
  });

  it('accepts media.discordapp.net as well', async () => {
    await expect(engine.io!.saveUrl(jobId, CHANNEL_A, 'https://media.discordapp.net/attachments/1/2/a.gif', 'f/a.gif')).resolves.toBe(1);
  });

  it.each([
    ['plain http', 'http://cdn.discordapp.com/a.png'],
    ['another host', 'https://example.com/a.png'],
    ['a lookalike host', 'https://cdn.discordapp.com.evil.example/a.png'],
    ['the API', 'https://discord.com/api/v9/users/@me'],
    ['a blob', 'blob:chrome-extension://x/y'],
    ['a data URL', 'data:text/html,<script>1</script>'],
    ['a file URL', 'file:///C:/x.png'],
    ['credentials in the URL', 'https://user:pw@cdn.discordapp.com/a.png'],
  ])('refuses %s', async (_label, url) => {
    await expect(engine.io!.saveUrl(jobId, CHANNEL_A, url, 'f/a.png')).rejects.toMatchObject({ code: 'invalid' });
    expect(fake.downloads.items).toEqual([]);
  });

  it('refuses an unsafe filename and a missing item key', async () => {
    await expect(engine.io!.saveUrl(jobId, CHANNEL_A, cdn, '../a.png')).rejects.toMatchObject({ code: 'invalid' });
    await expect(rawSave({ type: 'engine/saveUrl', jobId, itemKey: null, url: cdn, filename: 'f/a.png' })).resolves.toMatchObject({ ok: false, error: 'invalid' });
    await expect(rawSave({ type: 'engine/saveUrl', jobId, url: cdn, filename: 'f/a.png' })).resolves.toMatchObject({ ok: false, error: 'invalid' });
    expect(fake.downloads.items).toEqual([]);
  });

  it('is refused for a job that is not running', async () => {
    await engine.io!.finished(jobId, 'done');
    await expect(rawSave({ type: 'engine/saveUrl', jobId, itemKey: CHANNEL_A, url: cdn, filename: 'f/a.png' })).resolves.toMatchObject({ ok: false, error: 'invalid' });
  });
});

describe('the offscreen document and its blobs', () => {
  it('stays open while the job runs, even with no downloads pending', async () => {
    const id = await engine.io!.saveBlob(jobId, CHANNEL_A, html(), 'a.html');
    fake.completeDownload(id);
    await waitFor(() => harness.revoked.length === 1);
    await settle();
    expect(fake.offscreen.open).toBe(true);
  });

  it('is closed when the job is over and no download is pending', async () => {
    await engine.io!.finished(jobId, 'done');
    await waitFor(() => !fake.offscreen.open);
    expect(fake.offscreen.closeCalls).toBe(1);
  });

  it('is kept until the last blob download has settled, then closed', async () => {
    const first = await engine.io!.saveBlob(jobId, CHANNEL_A, html(), 'a.html');
    const second = await engine.io!.saveBlob(jobId, null, html(), 'a.zip');
    await engine.io!.finished(jobId, 'done');
    await settle();
    expect(fake.offscreen.open).toBe(true); // the files are still being read from its blob URLs
    fake.completeDownload(first);
    await waitFor(() => harness.revoked.length === 1);
    await settle();
    expect(fake.offscreen.open).toBe(true);
    fake.interruptDownload(second);
    await waitFor(() => !fake.offscreen.open);
    expect(harness.revoked).toHaveLength(2);
  });

  it('is not closed by a download of a job that is not the last one running (a new job started meanwhile)', async () => {
    const id = await engine.io!.saveBlob(jobId, CHANNEL_A, html(), 'a.html');
    await engine.io!.finished(jobId, 'done');
    engine.finish();
    const second = await startJobWith(popup, engine, [CHANNEL_B]);
    expect(second).not.toBe(jobId);
    fake.completeDownload(id);
    await waitFor(() => harness.revoked.length === 1);
    await settle();
    expect(fake.offscreen.open).toBe(true); // the new job needs it
    expect(fake.offscreen.createCalls).toBe(1); // and it never had to be created again
  });

  it('a URL saved by saveUrl does not keep the document open', async () => {
    await engine.io!.saveUrl(jobId, CHANNEL_A, 'https://cdn.discordapp.com/attachments/1/2/a.png', 'f/a.png');
    await engine.io!.finished(jobId, 'done');
    await waitFor(() => !fake.offscreen.open);
  });
});

describe('after a worker restart', () => {
  /** The same browser, a fresh worker: what a restarted service worker finds in storage and in the browser. */
  async function restartWorker(): Promise<void> {
    fake.onMessage.listeners.length = 0;
    fake.storageChanged.listeners.length = 0;
    fake.onBeforeSendHeaders.listeners.length = 0;
    fake.onDownloadChanged.listeners.length = 0;
    fake.onNotificationClicked.listeners.length = 0;
    fake.onNotificationButtonClicked.listeners.length = 0;
    fake.onCommand.listeners.length = 0;
    fake.onTabRemoved.listeners.length = 0;
    fake.onStartup.listeners.length = 0;
    fake.onInstalled.listeners.length = 0;
    vi.resetModules();
    vi.stubGlobal('chrome', fake.chrome);
    await import('@/background/index');
    await settle();
  }

  it('still revokes a blob URL it remembered (the pending set survives in session storage)', async () => {
    const id = await engine.io!.saveBlob(jobId, CHANNEL_A, html(), 'a.html');
    await restartWorker();
    fake.completeDownload(id);
    await waitFor(() => harness.revoked.length === 1);
    expect(pendingBlobs()).toEqual([]);
  });

  it('closes a leftover document at start when the job is over and its downloads finished while the worker slept', async () => {
    const id = await engine.io!.saveBlob(jobId, CHANNEL_A, html(), 'a.html');
    await engine.io!.finished(jobId, 'done');
    await settle();
    expect(fake.offscreen.open).toBe(true);
    // the browser finishes the download while no worker is listening
    fake.onDownloadChanged.listeners.length = 0;
    fake.completeDownload(id);
    await restartWorker();
    await waitFor(() => !fake.offscreen.open);
    expect(harness.revoked).toEqual([harness.blobUrls[0]]);
    expect(pendingBlobs()).toEqual([]);
  });

  it('keeps the document when a remembered download is still in progress', async () => {
    await engine.io!.saveBlob(jobId, CHANNEL_A, html(), 'a.html');
    await engine.io!.finished(jobId, 'done');
    await settle();
    await restartWorker();
    await settle();
    expect(fake.offscreen.open).toBe(true);
    expect(pendingBlobs()).toHaveLength(1);
  });

  it('does not touch the document while a job is running', async () => {
    await restartWorker();
    await settle();
    expect(fake.offscreen.open).toBe(true);
    expect((fake.session.peek(SESSION.job) as JobState).state).toBe('running');
  });
});

describe('without a document (it was closed before the browser reported the download)', () => {
  it('forgets the pending download quietly', async () => {
    const id = await engine.io!.saveBlob(jobId, CHANNEL_A, html(), 'a.html');
    await engine.io!.finished(jobId, 'done');
    await settle();
    // the document disappears (crash) while the download is pending
    harness.host?.dispose();
    harness.page?.close();
    harness.page = null;
    fake.offscreen.open = false;
    fake.completeDownload(id);
    await waitFor(() => pendingBlobs().length === 0);
    expect(fake.offscreen.closeCalls).toBe(0);
  });
});

describe('the engine host and a refused save, seen from the engine', () => {
  it('rejects with an EngineSaveError that has a code', async () => {
    const error = await engine.io!.saveBlob(jobId, CHANNEL_A, html(), '/abs.html').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineSaveError);
    expect((error as EngineSaveError).code).toBe('invalid');
  });
});
