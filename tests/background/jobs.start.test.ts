/**
 * `job/start` (docs/PLAN.md §3, §5.3, §6.3): the checks in their order, how a job is built (effective settings fixed at the
 * start, labels, locale, time zone), and how the offscreen document and the engine are brought up. The engine here is a
 * scripted one that only records what it was given.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL, SESSION } from '@/shared';
import type { AccountInfo, AppSettings, JobState } from '@/shared';
import { startOffscreenHost } from '@/offscreen/host';
import { createFakeBrowser } from './fakeChrome';
import type { FakeBrowser, FakePage } from './fakeChrome';
import {
  ACCOUNT_ID,
  CHANNEL_A,
  CHANNEL_B,
  CHANNEL_C,
  DM_CHANNEL,
  GUILD_ID,
  TOKEN,
  bootLoggedIn,
  bootWorker,
  dmTarget,
  exportSettings,
  guildTarget,
  installEngine,
  installFakeDiscordApi,
  queueItem,
  scriptedEngine,
  seedConsent,
  seedQueue,
  settle,
  snapshot,
  startJobWith,
  waitFor,
} from './helpers';
import type { EngineHarness, ScriptedEngine } from './helpers';

let fake: FakeBrowser;
let popup: FakePage;
let engine: ScriptedEngine;
let harness: EngineHarness;

beforeEach(async () => {
  fake = createFakeBrowser();
  ({ popup } = await bootLoggedIn(fake));
  engine = scriptedEngine();
  harness = installEngine(fake, { runner: engine.runner });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const start = (keys: unknown = 'all') => popup.send({ to: 'bg', type: 'job/start', keys }) as Promise<{ ok: boolean; data?: { jobId: string }; error?: string; message?: string }>;
const storedJob = () => fake.session.peek<JobState>(SESSION.job);

describe('the checks, in order', () => {
  it('without consent: "no-consent", and nothing is created', async () => {
    seedQueue(fake, [queueItem()]);
    await expect(start()).resolves.toEqual({ ok: false, error: 'no-consent' });
    expect(fake.session.has(SESSION.job)).toBe(false);
    expect(fake.offscreen.createCalls).toBe(0);
  });

  it('a settings record without consentAt (or with null) is no consent', async () => {
    seedQueue(fake, [queueItem()]);
    fake.local.seed({ [LOCAL.settings]: { consentAt: null, zipAll: true } });
    await expect(start()).resolves.toMatchObject({ ok: false, error: 'no-consent' });
  });

  it('with consent but no account: "no-account"', async () => {
    const other = createFakeBrowser();
    installFakeDiscordApi();
    await bootWorker(other);
    seedConsent(other);
    await expect(other.createPage().send({ to: 'bg', type: 'job/start', keys: 'all' })).resolves.toEqual({ ok: false, error: 'no-account' });
    expect(other.offscreen.createCalls).toBe(0);
  });

  it('an account whose authorization is gone cannot start a job either', async () => {
    seedConsent(fake);
    seedQueue(fake, [queueItem()]);
    await fake.session.remove([SESSION.token]); // the account stays until the storage listener has cleared it ...
    await expect(start()).resolves.toMatchObject({ ok: false, error: 'no-account' });
  });

  it('with nothing to run: "empty" (an empty list, keys that are not in the list, no keys)', async () => {
    seedConsent(fake);
    await expect(start()).resolves.toEqual({ ok: false, error: 'empty' });
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A))]);
    await expect(start([CHANNEL_B])).resolves.toEqual({ ok: false, error: 'empty' });
    await expect(start([])).resolves.toEqual({ ok: false, error: 'empty' });
    expect(fake.offscreen.createCalls).toBe(0);
  });

  it('checks consent before account before busy before empty', async () => {
    const other = createFakeBrowser();
    installFakeDiscordApi();
    await bootWorker(other);
    const page = other.createPage();
    await expect(page.send({ to: 'bg', type: 'job/start', keys: 'all' })).resolves.toEqual({ ok: false, error: 'no-consent' });
    seedConsent(other);
    await expect(page.send({ to: 'bg', type: 'job/start', keys: 'all' })).resolves.toEqual({ ok: false, error: 'no-account' });
  });

  it.each([
    ['a string', 'queue'],
    ['a number', 5],
    ['null', null],
    ['undefined', undefined],
    ['an object', { 0: CHANNEL_A }],
    ['non-numeric ids', ['abc']],
    ['a number among the ids', [CHANNEL_A, 5]],
    ['more than 5000 keys', Array.from({ length: 5001 }, () => '1')],
  ])('refuses keys that are %s ("invalid") without looking at anything else', async (_label, keys) => {
    await expect(popup.send({ to: 'bg', type: 'job/start', keys })).resolves.toMatchObject({ ok: false, error: 'invalid' });
    expect(fake.session.has(SESSION.job)).toBe(false);
  });

  it('is "busy" while a job runs, and the second start changes nothing', async () => {
    seedConsent(fake);
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A)), queueItem(guildTarget(CHANNEL_B))]);
    const jobId = await startJobWith(popup, engine);
    await expect(start()).resolves.toEqual({ ok: false, error: 'busy' });
    expect(storedJob()?.jobId).toBe(jobId);
    expect(engine.jobs).toHaveLength(1);
    expect(fake.offscreen.createCalls).toBe(1);
  });

  it('two starts at once: one wins, the other is "busy"', async () => {
    seedConsent(fake);
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A))]);
    const [first, second] = await Promise.all([start(), start()]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect([first.error, second.error].filter(Boolean)).toEqual(['busy']);
    await settle();
    expect(engine.jobs).toHaveLength(1);
  });

  it('is "busy" while the job is paused (waiting out a rate limit)', async () => {
    seedConsent(fake);
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A))]);
    await startJobWith(popup, engine);
    await engine.io!.progress(snapshot(engine.jobs[0], {}, { state: 'paused', pausedReason: 'rate-limit' }));
    await waitFor(() => storedJob()?.state === 'paused');
    await expect(start()).resolves.toEqual({ ok: false, error: 'busy' });
  });

  it('can start again once the previous job is over', async () => {
    seedConsent(fake);
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A))]);
    const first = await startJobWith(popup, engine);
    await engine.io!.finished(first, 'done');
    engine.finish();
    await waitFor(() => storedJob()?.state === 'done');
    const second = await startJobWith(popup, engine);
    expect(second).not.toBe(first);
    expect(storedJob()?.jobId).toBe(second);
  });
});

describe('what the job is made of', () => {
  beforeEach(() => {
    seedConsent(fake, { language: 'en' });
  });

  it('runs the whole list in list order for "all", or only the listed keys (still in list order)', async () => {
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A)), queueItem(dmTarget()), queueItem(guildTarget(CHANNEL_B))]);
    await startJobWith(popup, engine, 'all');
    expect(engine.jobs[0].items.map((item) => item.key)).toEqual([CHANNEL_A, DM_CHANNEL, CHANNEL_B]);
    await engine.io!.finished(engine.jobs[0].jobId, 'done');
    engine.finish();
    await waitFor(() => storedJob()?.state === 'done');

    await startJobWith(popup, engine, [CHANNEL_B, CHANNEL_A]);
    expect(engine.jobs[1].items.map((item) => item.key)).toEqual([CHANNEL_A, CHANNEL_B]);
  });

  it('fixes the effective settings of every item now: item.settings ?? common, as deep copies', async () => {
    const own = exportSettings({ count: 50, format: 'xlsx', includeAttachments: true });
    const common = exportSettings({ count: null, format: 'json', htmlTheme: 'light' });
    fake.local.seed({ [LOCAL.settings]: { consentAt: 1, language: 'en', common } });
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A), { settings: own }), queueItem(guildTarget(CHANNEL_B))]);
    await startJobWith(popup, engine);

    const job = engine.jobs[0];
    expect(job.items[0].settings).toEqual(own);
    expect(job.items[1].settings).toEqual(common);
    // changing the common settings afterwards does not reach the running job
    await popup.send({ to: 'bg', type: 'settings/patch', patch: { common: exportSettings({ count: 5, format: 'csv' }) } });
    expect(job.items[1].settings).toEqual(common);
    expect(storedJob()?.items.map((item) => item.expected)).toEqual([50, null]);
  });

  it('hands the engine a complete EngineJob', async () => {
    fake.local.seed({
      [LOCAL.settings]: { consentAt: 1, language: 'ko', zipAll: true, folderName: 'Mine', timeZone: 'Asia/Seoul' },
      [LOCAL.lastExported(ACCOUNT_ID)]: { [CHANNEL_A]: '900', [CHANNEL_B]: '901', junk: 'x' },
    });
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A))]);
    const jobId = await startJobWith(popup, engine);
    const job = engine.jobs[0];
    expect(job).toMatchObject({
      jobId,
      accountId: ACCOUNT_ID,
      authorization: TOKEN,
      locale: 'ko',
      timeZone: 'Asia/Seoul',
      lastExported: { [CHANNEL_A]: '900', [CHANNEL_B]: '901' },
      settings: { zipAll: true, folderName: 'Mine', language: 'ko', timeZone: 'Asia/Seoul', consentAt: 1 },
    });
    expect(job.items).toEqual([{ key: CHANNEL_A, target: guildTarget(CHANNEL_A), settings: exportSettings() }]);
    expect(Object.keys(job).sort()).toEqual(['accountId', 'authorization', 'items', 'jobId', 'lastExported', 'locale', 'settings', 'timeZone']);
  });

  it('gives the authorization to the engine and to nobody else (not the job state, not storage.local, not the answer)', async () => {
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A))]);
    const response = await start();
    await waitFor(() => engine.jobs.length === 1);
    expect(engine.jobs[0].authorization).toBe(TOKEN);
    expect(JSON.stringify(response)).not.toContain(TOKEN);
    expect(JSON.stringify(storedJob())).not.toContain(TOKEN);
    expect(JSON.stringify(fake.local.dump())).not.toContain(TOKEN);
    // in session storage it exists only as the token record itself
    const withoutToken = Object.fromEntries(Object.entries(fake.session.dump()).filter(([key]) => key !== SESSION.token));
    expect(JSON.stringify(withoutToken)).not.toContain(TOKEN);
  });

  it('writes the initial job state: all waiting, labels, expected counts, the zip flag', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    fake.local.seed({ [LOCAL.settings]: { consentAt: 1, zipAll: true } });
    seedQueue(fake, [
      queueItem(guildTarget(CHANNEL_A, { guildName: 'Test Server', channelName: 'general' })),
      queueItem(dmTarget(DM_CHANNEL, { channelName: 'Friend' }), { settings: exportSettings({ count: null }) }),
      queueItem(guildTarget(CHANNEL_B, { kind: 'thread', channelName: 'a thread', guildName: null })),
      queueItem(dmTarget(CHANNEL_C, { kind: 'group-dm', channelName: 'Study group' })),
    ]);
    const jobId = await startJobWith(popup, engine);
    expect(storedJob()).toEqual({
      jobId,
      accountId: ACCOUNT_ID,
      startedAt: 1_760_000_000_000,
      finishedAt: null,
      state: 'running',
      pausedReason: null,
      zip: true,
      items: [
        { key: CHANNEL_A, label: 'Test Server > #general', status: 'waiting', phase: null, fetched: 0, expected: 200, error: null, files: [] },
        { key: DM_CHANNEL, label: 'Friend', status: 'waiting', phase: null, fetched: 0, expected: null, error: null, files: [] },
        { key: CHANNEL_B, label: '#a thread', status: 'waiting', phase: null, fetched: 0, expected: 200, error: null, files: [] },
        { key: CHANNEL_C, label: 'Study group', status: 'waiting', phase: null, fetched: 0, expected: 200, error: null, files: [] },
      ],
    });
  });

  it('does not touch the list when a job starts (items leave it only when they are done)', async () => {
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A)), queueItem(guildTarget(CHANNEL_B))]);
    await startJobWith(popup, engine);
    expect((fake.local.peek(LOCAL.queue(ACCOUNT_ID)) as unknown[]).length).toBe(2);
  });

  it('answers with the job id', async () => {
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A))]);
    const response = await start();
    expect(response).toEqual({ ok: true, data: { jobId: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
    expect(storedJob()?.jobId).toBe(response.data?.jobId);
  });
});

describe('locale and time zone of the job', () => {
  const lastJob = () => engine.jobs[engine.jobs.length - 1];

  beforeEach(() => {
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A))]);
  });

  async function run(language: AppSettings['language'], theme?: { lang: string }, ui = 'en-US'): Promise<'ko' | 'en'> {
    fake.local.seed({ [LOCAL.settings]: { consentAt: 1, language } });
    if (theme) fake.local.seed({ [LOCAL.theme]: { scheme: 'dark', themeClasses: [], vars: {}, capturedAt: 1, ...theme } });
    fake.uiLanguage = ui;
    const jobId = await startJobWith(popup, engine);
    const locale = lastJob().locale;
    await engine.io!.finished(jobId, 'done');
    engine.finish();
    await waitFor(() => storedJob()?.state === 'done');
    return locale;
  }

  it('an explicit language wins over everything', async () => {
    expect(await run('ko', { lang: 'en-US' }, 'en-US')).toBe('ko');
    expect(await run('en', { lang: 'ko' }, 'ko-KR')).toBe('en');
  });

  it('"auto" follows the Discord page language first: ko... -> ko, anything else -> en', async () => {
    expect(await run('auto', { lang: 'ko' }, 'en-US')).toBe('ko');
    expect(await run('auto', { lang: 'ko-KR' }, 'en-US')).toBe('ko');
    expect(await run('auto', { lang: 'en-US' }, 'ko-KR')).toBe('en'); // the page language, not the browser's, decides when there is one
    expect(await run('auto', { lang: 'ja' }, 'ko-KR')).toBe('en');
  });

  it('"auto" without a page language follows the browser UI language', async () => {
    expect(await run('auto', undefined, 'ko-KR')).toBe('ko');
    expect(await run('auto', undefined, 'ko')).toBe('ko');
    expect(await run('auto', undefined, 'en-GB')).toBe('en');
    expect(await run('auto', undefined, 'fr')).toBe('en');
    expect(await run('auto', { lang: '  ' }, 'ko-KR')).toBe('ko'); // an empty page language counts as none
  });

  it('resolves "auto" time zone to the browser\'s IANA zone and passes an explicit one through', async () => {
    fake.local.seed({ [LOCAL.settings]: { consentAt: 1, timeZone: 'auto' } });
    const first = await startJobWith(popup, engine);
    expect(lastJob().timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(lastJob().timeZone).not.toBe('auto');
    await engine.io!.finished(first, 'done');
    engine.finish();
    await waitFor(() => storedJob()?.state === 'done');

    fake.local.seed({ [LOCAL.settings]: { consentAt: 1, timeZone: 'America/New_York' } });
    await startJobWith(popup, engine);
    expect(lastJob().timeZone).toBe('America/New_York');
    expect(lastJob().settings.timeZone).toBe('America/New_York');
  });
});

describe('bringing up the offscreen document', () => {
  beforeEach(() => {
    seedConsent(fake);
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A))]);
  });

  it('creates one document for reason BLOBS with a justification and waits for its engine', async () => {
    await startJobWith(popup, engine);
    expect(fake.offscreen.createCalls).toBe(1);
    expect(fake.offscreen.lastParams).toEqual({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: expect.stringMatching(/^.{20,}$/),
    });
    // duplicates are guarded with getContexts: there is only ever one offscreen document, so the context type is the whole filter
    expect(vi.mocked(chrome.runtime.getContexts)).toHaveBeenCalledWith({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  });

  it('reuses a document that already exists instead of creating a second one', async () => {
    fake.offscreen.open = true; // left over, e.g. from the previous job's pending downloads
    harness.page = fake.createPage({ kind: 'offscreen' });
    harness.host = startOffscreenHost({ runtime: harness.page.runtime, runner: engine.runner });
    await settle();
    await startJobWith(popup, engine);
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled(); // not even attempted
    expect(fake.offscreen.createCalls).toBe(0);
    expect(engine.jobs).toHaveLength(1);
  });

  it('survives losing the race for the single document (creation fails, but the document is there)', async () => {
    const original = fake.offscreen.onCreate;
    vi.mocked(chrome.offscreen.createDocument).mockImplementationOnce(async () => {
      await original?.();
      fake.offscreen.open = true;
      throw new Error('Only a single offscreen document may be created.');
    });
    const response = await start();
    expect(response).toMatchObject({ ok: true });
  });

  it('fails the start (and restores the previous job state) when the document cannot be created', async () => {
    const previous: JobState = { jobId: 'old', accountId: ACCOUNT_ID, startedAt: 1, finishedAt: 2, state: 'done', pausedReason: null, zip: false, items: [] };
    fake.session.seed({ [SESSION.job]: previous });
    vi.mocked(chrome.offscreen.createDocument).mockRejectedValueOnce(new Error('offscreen is not available'));
    const response = await start();
    expect(response).toEqual({ ok: false, error: 'unknown', message: expect.stringContaining('offscreen is not available') });
    expect(storedJob()).toEqual(previous);
    // nothing is stuck: the next try works
    await expect(start()).resolves.toMatchObject({ ok: true });
  });

  it('fails the start when the engine never says it is ready (10 s), closing the document', async () => {
    vi.useFakeTimers();
    fake.offscreen.onCreate = () => undefined; // a document without an engine
    const pending = start();
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(pending).resolves.toEqual({ ok: false, error: 'unknown', message: expect.stringContaining('did not start') });
    expect(fake.offscreen.open).toBe(false);
    expect(fake.offscreen.closeCalls).toBe(1);
    expect(storedJob() ?? null).toBeNull();
  });

  it('accepts an engine that says "ready" only after createDocument has returned', async () => {
    vi.useFakeTimers();
    fake.offscreen.onCreate = () => {
      setTimeout(() => {
        const page = fake.createPage({ kind: 'offscreen' });
        startOffscreenHost({ runtime: page.runtime, runner: engine.runner });
      }, 500);
    };
    const pending = start();
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(engine.jobs).toHaveLength(1);
  });

  it('fails the start when the engine does not accept the job', async () => {
    fake.offscreen.onCreate = () => {
      const page = fake.createPage({ kind: 'offscreen' });
      page.runtime.onMessage.addListener(() => false); // listens, but never answers engine/run
      void page.send({ to: 'bg', type: 'engine/ready' });
    };
    const response = await start();
    expect(response).toMatchObject({ ok: false, error: 'unknown' });
    expect(storedJob() ?? null).toBeNull();
  });

  it('a job that is running or paused with no document at all is closed as interrupted so it cannot block new jobs', async () => {
    const stale: JobState = {
      jobId: 'stale',
      accountId: ACCOUNT_ID,
      startedAt: 1,
      finishedAt: null,
      state: 'running',
      pausedReason: null,
      zip: false,
      items: [{ key: CHANNEL_A, label: 'x', status: 'running', phase: 'messages', fetched: 4, expected: 200, error: null, files: [] }],
    };
    fake.session.seed({ [SESSION.job]: stale });
    const response = await start();
    expect(response).toMatchObject({ ok: true });
    await waitFor(() => engine.jobs.length === 1);
    expect(storedJob()?.jobId).not.toBe('stale');
  });
});

describe('the account of a job', () => {
  it('is the verified current account, and an item keeps the target the content script sent', async () => {
    seedConsent(fake);
    seedQueue(fake, [queueItem(guildTarget(CHANNEL_A, { parentId: '300000000000000001', parentName: 'Study', channelType: 0 }))]);
    await startJobWith(popup, engine);
    const account = fake.session.peek<AccountInfo>(SESSION.account);
    expect(engine.jobs[0].accountId).toBe(account?.id);
    expect(engine.jobs[0].items[0].target).toMatchObject({ guildId: GUILD_ID, parentName: 'Study', channelType: 0 });
  });
});
