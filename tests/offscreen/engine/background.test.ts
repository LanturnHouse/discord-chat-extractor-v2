/**
 * The download engine against the REAL background worker: the popup starts a job, the worker builds it and brings up the offscreen
 * host with the engine in it, the engine runs over a fake Discord, and everything it says goes through the worker's validation into
 * storage (history, incremental markers, the list), `chrome.downloads`, the notification and the badge. What the engine reports is
 * only right when the worker accepts and stores it, so this is where the protocol is checked end to end (docs/PLAN.md §5.3, §6.7).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordApiError } from '@/lib';
import type { LiveDiscordClientOptions } from '@/lib';
import { LOCAL, SESSION } from '@/shared';
import type { HistoryEntry, JobState, QueueItem } from '@/shared';
import { createEngineRunner } from '@/offscreen/engine';
import type { EngineDeps } from '@/offscreen/engine';
import { createFakeBrowser } from '../../background/fakeChrome';
import type { FakeBrowser, FakePage } from '../../background/fakeChrome';
import { ACCOUNT_ID, TOKEN, bootLoggedIn, installEngine, queueItem, seedConsent, seedQueue, settle, storedQueue, waitFor } from '../../background/helpers';
import type { EngineHarness } from '../../background/helpers';
import { CHATS, chatTarget, chatWorld, exportSettings, fakeClient, messageIdAt } from './kit';
import type { FakeCall, FakeWorld } from './kit';

let fake: FakeBrowser;
let popup: FakePage;
let harness: EngineHarness;
/** The options the engine built its client with (what the live client would call back: `onAuthError`, ...). */
let clientOptions: LiveDiscordClientOptions[];

const storedJob = () => fake.session.peek<JobState>(SESSION.job) as JobState;
const history = () => fake.local.peek<HistoryEntry[]>(LOCAL.history(ACCOUNT_ID)) ?? [];
const markers = () => fake.local.peek<Record<string, string>>(LOCAL.lastExported(ACCOUNT_ID)) ?? {};
const hint = (key: string) => (storedQueue(fake).find((item) => item.key === key) as QueueItem).lastResult;
const queueKeys = () => storedQueue(fake).map((item) => item.key);
const done = () => waitFor(() => ['done', 'cancelled', 'failed'].includes(storedJob()?.state) && storedJob().state);

interface Scenario {
  world?: FakeWorld;
  fail?: (call: FakeCall) => DiscordApiError | Error | undefined | Promise<DiscordApiError | Error | undefined>;
  app?: Record<string, unknown>;
  chats?: readonly number[];
  settings?: Partial<ReturnType<typeof exportSettings>>;
  deps?: EngineDeps;
}

/** Seeds the list with the chats, wires the real engine over a fake Discord and starts the job from the popup. */
async function start(scenario: Scenario = {}): Promise<void> {
  seedConsent(fake, { language: 'en', timeZone: 'UTC', ...scenario.app });
  seedQueue(fake, (scenario.chats ?? [0, 1, 2]).map((n) => queueItem(chatTarget(n), { settings: exportSettings({ count: null, format: 'json', ...scenario.settings }) })));
  const client = fakeClient(scenario.world ?? chatWorld(), scenario.fail);
  harness = installEngine(fake, {
    runner: createEngineRunner({
      createClient: (opts) => (clientOptions.push(opts), client),
      sleep: async () => undefined,
      random: () => 0,
      fetch: (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch,
      ...scenario.deps,
    }),
  });
  const response = (await popup.send({ to: 'bg', type: 'job/start', keys: 'all' })) as { ok: boolean };
  expect(response.ok).toBe(true);
}

beforeEach(async () => {
  clientOptions = [];
  fake = createFakeBrowser();
  ({ popup } = await bootLoggedIn(fake));
  fake.downloads.autoComplete = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('individual files through the worker', () => {
  it('saves every chat, records it in the history with the download ids, moves the markers, clears the list and says it is done', async () => {
    await start();
    expect(await done()).toBe('done');
    await settle();

    expect(fake.downloads.items.map((item) => item.filename)).toEqual([
      expect.stringMatching(/^Discord Export\/Test Guild - alpha \(\d{4}-\d{2}-\d{2}\)\.json$/),
      expect.stringMatching(/^Discord Export\/Test Guild - beta \(\d{4}-\d{2}-\d{2}\)\.json$/),
      expect.stringMatching(/^Discord Export\/Test Guild - gamma \(\d{4}-\d{2}-\d{2}\)\.json$/),
    ]);
    expect(history().map((entry) => [entry.target.channelId, entry.status, entry.messageCount])).toEqual([[CHATS[2], 'done', 3], [CHATS[1], 'done', 3], [CHATS[0], 'done', 3]]);
    expect(history().map((entry) => entry.accountId)).toEqual([ACCOUNT_ID, ACCOUNT_ID, ACCOUNT_ID]);
    expect(history()[0].files).toEqual([{ filename: fake.downloads.items[2].filename, downloadId: fake.downloads.items[2].id }]);
    expect(markers()).toEqual({ [CHATS[0]]: messageIdAt(2), [CHATS[1]]: messageIdAt(2), [CHATS[2]]: messageIdAt(2) });
    expect(queueKeys()).toEqual([]);
    expect(storedJob().items.map((row) => [row.status, row.fetched])).toEqual([['done', 3], ['done', 3], ['done', 3]]);
    expect(fake.notifications.created.at(-1)?.options.title).toBe('Download complete');
  });

  it('frees the blob URLs when the downloads are over and closes the offscreen document afterwards', async () => {
    await start({ chats: [0, 1] });
    await done();
    await waitFor(() => fake.offscreen.closeCalls > 0);
    expect(harness.blobUrls).toHaveLength(2);
    expect([...harness.revoked].sort()).toEqual([...harness.blobUrls].sort());
  });

  it('a chat that fails or ends partial stays in the list with the reason; only the finished one moves its marker', async () => {
    await start({
      world: chatWorld([{}, {}, { messages: 250 }]),
      fail: (call) => {
        if (call.method === 'getChannel' && call.id === CHATS[1]) return new DiscordApiError('forbidden', 'raw', { status: 403, code: 50001 });
        if (call.method === 'getMessages' && call.id === CHATS[2] && call.n === 1) return new DiscordApiError('network', 'raw');
        return undefined;
      },
    });
    expect(await done()).toBe('done');
    await settle();
    expect(history().map((entry) => [entry.target.channelId, entry.status])).toEqual([[CHATS[2], 'partial'], [CHATS[1], 'failed'], [CHATS[0], 'done']]);
    expect(markers()).toEqual({ [CHATS[0]]: messageIdAt(2) });
    expect(queueKeys()).toEqual([CHATS[1], CHATS[2]]);
    expect(hint(CHATS[1])).toMatchObject({ status: 'failed', message: "You don't have permission to view this channel" });
    expect(hint(CHATS[2])).toMatchObject({ status: 'partial', message: 'Could not connect to the network' });
    expect(fake.downloads.items.map((item) => item.filename)).toContainEqual(expect.stringContaining('(partial)'));
    expect(fake.notifications.created.at(-1)?.options.title).toBe('Some downloads failed');
  });

  it('attachments are downloaded from their CDN URLs by the browser, next to the file', async () => {
    const issued = Math.floor(Date.now() / 1000) - 60;
    await start({ chats: [0], settings: { includeAttachments: true }, world: chatWorld([{ attachments: [['11', 'cat.png', issued]] }]) });
    expect(await done()).toBe('done');
    const downloads = fake.downloads.items;
    expect(downloads.map((item) => item.filename)).toEqual([
      expect.stringMatching(/^Discord Export\/Test Guild - alpha \(\d{4}-\d{2}-\d{2}\)\.json$/),
      expect.stringMatching(/^Discord Export\/Test Guild - alpha \(\d{4}-\d{2}-\d{2}\)_files\/11_cat\.png$/),
    ]);
    expect(downloads[1].url).toContain('https://cdn.discordapp.com/attachments/1/2/11/cat.png');
    expect(history()[0].files.map((file) => file.downloadId)).toEqual([downloads[0].id, downloads[1].id]);
  });

  it('a download the browser refuses fails that chat, with the reason, and the job goes on', async () => {
    fake.downloads.failNext = new Error('Download blocked');
    await start({ chats: [0, 1] });
    expect(await done()).toBe('done');
    expect(history().map((entry) => [entry.target.channelId, entry.status, entry.error])).toEqual([[CHATS[1], 'done', null], [CHATS[0], 'failed', 'Could not save the file (Download blocked)']]);
    expect(queueKeys()).toEqual([CHATS[0]]);
    expect(markers()).toEqual({ [CHATS[1]]: messageIdAt(2) });
  });

  it('incremental: the marker the worker holds is what the engine continues from, and a second run has nothing new', async () => {
    fake.local.seed({ [LOCAL.lastExported(ACCOUNT_ID)]: { [CHATS[0]]: messageIdAt(1) } });
    await start({ chats: [0], settings: { incremental: true } });
    expect(await done()).toBe('done');
    await settle();
    expect(history()[0]).toMatchObject({ status: 'done', messageCount: 1 });
    expect(markers()).toEqual({ [CHATS[0]]: messageIdAt(2) });
    expect(queueKeys()).toEqual([]);
  });
});

describe('a ZIP through the worker', () => {
  const app = { zipAll: true };

  it('is one download; the chats are in the history with it, the list is cleared, the markers move', async () => {
    await start({ app });
    expect(await done()).toBe('done');
    await settle();
    expect(fake.downloads.items).toHaveLength(1);
    const [archive] = fake.downloads.items;
    expect(archive.filename).toMatch(/^Discord Export\/Discord Export \d{4}-\d{2}-\d{2} \d{4}\.zip$/);
    expect(history().map((entry) => entry.files[0])).toEqual([{ filename: archive.filename, downloadId: archive.id }, { filename: archive.filename, downloadId: archive.id }, { filename: archive.filename, downloadId: archive.id }]);
    expect(history().map((entry) => entry.files[1].downloadId)).toEqual([null, null, null]);
    expect(markers()).toEqual({ [CHATS[0]]: messageIdAt(2), [CHATS[1]]: messageIdAt(2), [CHATS[2]]: messageIdAt(2) });
    expect(queueKeys()).toEqual([]);
    expect(storedJob().zip).toBe(true);
  });

  it('an archive the browser refuses fails every chat in it: nothing leaves the list or moves a marker', async () => {
    fake.downloads.failNext = new Error('Download blocked');
    await start({ app, chats: [0, 1] });
    expect(await done()).toBe('failed');
    await settle();
    expect(history().map((entry) => [entry.status, entry.error])).toEqual([['failed', 'Could not save the ZIP file (Download blocked)'], ['failed', 'Could not save the ZIP file (Download blocked)']]);
    expect(markers()).toEqual({});
    expect(queueKeys()).toEqual([CHATS[0], CHATS[1]]);
    expect(hint(CHATS[0])).toMatchObject({ status: 'failed', message: 'Could not save the ZIP file (Download blocked)' });
    expect(storedJob().items.map((row) => row.status)).toEqual(['failed', 'failed']);
  });
});

describe('cancelling through the worker', () => {
  /** Cancels from the popup while chat `n` walks its second page. */
  const cancelDuring = (n: number) => async (call: FakeCall) => {
    if (call.method === 'getMessages' && call.id === CHATS[n] && call.n === 1) await popup.send({ to: 'bg', type: 'job/cancel' });
    return undefined;
  };

  it('stops the job: the chat in flight is cancelled and stays in the list as such, the finished one is recorded, the rest is untouched', async () => {
    await start({ world: chatWorld([{}, { messages: 250 }, {}]), fail: cancelDuring(1) });
    expect(await done()).toBe('cancelled');
    await settle();
    expect(storedJob().items.map((row) => row.status)).toEqual(['done', 'cancelled', 'cancelled']);
    expect(history().map((entry) => entry.target.channelId)).toEqual([CHATS[0]]);
    expect(queueKeys()).toEqual([CHATS[1], CHATS[2]]);
    expect(hint(CHATS[1])).toMatchObject({ status: 'cancelled' });
    expect(hint(CHATS[2])).toBeUndefined();
    expect(fake.notifications.created).toEqual([]); // the user was there
  });

  it('in ZIP mode the finished chats are saved as a partial archive and recorded', async () => {
    await start({ app: { zipAll: true }, world: chatWorld([{}, { messages: 250 }, {}]), fail: cancelDuring(1) });
    expect(await done()).toBe('cancelled');
    await settle();
    expect(fake.downloads.items).toHaveLength(1);
    expect(fake.downloads.items[0].filename).toMatch(/\(partial\)\.zip$/);
    expect(history().map((entry) => [entry.target.channelId, entry.status, entry.files[0].downloadId])).toEqual([[CHATS[0], 'done', fake.downloads.items[0].id]]);
    expect(markers()).toEqual({ [CHATS[0]]: messageIdAt(2) });
    expect(queueKeys()).toEqual([CHATS[1], CHATS[2]]);
  });
});

describe('a 401 through the worker', () => {
  it('has the worker forget the rejected authorization, fails the chats that could not run and the job', async () => {
    await start({
      fail: (call) => {
        if (call.method !== 'getMessages' || call.id !== CHATS[1]) return undefined;
        clientOptions[0]?.onAuthError?.(TOKEN);
        return new DiscordApiError('auth', 'raw 401', { status: 401 });
      },
    });
    expect(await done()).toBe('failed');
    await settle();
    expect(fake.session.peek(SESSION.token)).toBeUndefined();
    expect(storedJob().items.map((row) => row.status)).toEqual(['done', 'failed', 'failed']);
    expect(storedJob().items[2].error).toMatchObject({ kind: 'auth' });
    expect(history().map((entry) => [entry.target.channelId, entry.status])).toEqual([[CHATS[1], 'failed'], [CHATS[0], 'done']]);
    expect(queueKeys()).toEqual([CHATS[1], CHATS[2]]);
    expect(hint(CHATS[2])).toMatchObject({ status: 'failed', message: 'Your Discord login has expired. Please reload Discord' });
  });
});
