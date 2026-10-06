/**
 * The whole background <-> offscreen flow against the STUB engine (step A1's deliverable): start, progress, per-item results,
 * the end of the job, the notification, cancelling, and the offscreen document's life; plus `history/rerun`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL, SESSION } from '@/shared';
import type { HistoryEntry, JobState } from '@/shared';
import { createStubRunner, STUB_ERROR_MESSAGE } from '@/offscreen/stubEngine';
import { createFakeBrowser } from './fakeChrome';
import type { FakeBrowser, FakePage } from './fakeChrome';
import {
  ACCOUNT_ID,
  CHANNEL_A,
  CHANNEL_B,
  CHANNEL_C,
  DM_CHANNEL,
  bootLoggedIn,
  bootWorker,
  dmTarget,
  exportSettings,
  guildTarget,
  historyEntry,
  installEngine,
  installFakeDiscordApi,
  queueItem,
  scriptedEngine,
  seedConsent,
  seedQueue,
  settle,
  startJobWith,
  storedQueue,
  waitFor,
} from './helpers';
import type { EngineHarness, ScriptedEngine } from './helpers';

let fake: FakeBrowser;
let popup: FakePage;
let harness: EngineHarness;

const storedJob = () => fake.session.peek<JobState>(SESSION.job) as JobState;
const history = () => fake.local.peek<HistoryEntry[]>(LOCAL.history(ACCOUNT_ID)) ?? [];
const startAll = () => popup.send({ to: 'bg', type: 'job/start', keys: 'all' }) as Promise<{ ok: boolean; data?: { jobId: string } }>;

const A = guildTarget(CHANNEL_A, { channelName: 'general' });
const B = guildTarget(CHANNEL_B, { channelName: 'random' });
const D = dmTarget(DM_CHANNEL);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a whole job with the stub engine', () => {
  beforeEach(async () => {
    fake = createFakeBrowser();
    ({ popup } = await bootLoggedIn(fake));
    harness = installEngine(fake, { runner: createStubRunner() });
    seedConsent(fake, { language: 'en' });
    seedQueue(fake, [queueItem(A), queueItem(B), queueItem(D)]);
  });

  it('runs every item to a "failed / unknown / engine not implemented" result and ends as done', async () => {
    const response = await startAll();
    expect(response.ok).toBe(true);
    await waitFor(() => storedJob().state === 'done');
    const job = storedJob();
    expect(job.jobId).toBe(response.data?.jobId);
    expect(job.finishedAt).toEqual(expect.any(Number));
    expect(job.items.map((item) => [item.key, item.status, item.error])).toEqual([
      [CHANNEL_A, 'failed', { kind: 'unknown', message: STUB_ERROR_MESSAGE }],
      [CHANNEL_B, 'failed', { kind: 'unknown', message: STUB_ERROR_MESSAGE }],
      [DM_CHANNEL, 'failed', { kind: 'unknown', message: STUB_ERROR_MESSAGE }],
    ]);
    expect(STUB_ERROR_MESSAGE).toBe('engine not implemented');
    expect(job.items.map((item) => item.label)).toEqual(['Test Server > #general', 'Test Server > #random', 'Friend']);
  });

  it('records a failed history entry per item, newest first, and keeps the chats in the list with the reason', async () => {
    await startAll();
    await waitFor(() => storedJob().state === 'done');
    expect(history().map((entry) => entry.target.channelId)).toEqual([DM_CHANNEL, CHANNEL_B, CHANNEL_A]);
    for (const entry of history()) {
      expect(entry).toMatchObject({ accountId: ACCOUNT_ID, status: 'failed', messageCount: 0, files: [], error: STUB_ERROR_MESSAGE });
      expect(entry.settings).toEqual(exportSettings()); // the effective settings the item ran with
    }
    expect(storedQueue(fake).map((item) => item.key)).toEqual([CHANNEL_A, CHANNEL_B, DM_CHANNEL]);
    for (const item of storedQueue(fake)) expect(item.lastResult).toMatchObject({ status: 'failed', message: STUB_ERROR_MESSAGE });
    expect(fake.local.has(LOCAL.lastExported(ACCOUNT_ID))).toBe(false); // only `done` items move the marker
  });

  it('tells the user: failure notification, red "!" badge, until the popup is opened', async () => {
    await startAll();
    await waitFor(() => storedJob().state === 'done');
    await waitFor(() => fake.badge.text === '!');
    expect(fake.notifications.created).toHaveLength(1);
    expect(fake.notifications.created[0].options).toMatchObject({ title: 'Some downloads failed', message: '0 chats · 0 messages' });
    await popup.send({ to: 'bg', type: 'status/get' });
    await waitFor(() => fake.badge.text === '3');
  });

  it('shows each item running before it fails (phase resolving), one at a time', async () => {
    vi.useFakeTimers();
    harness = installEngine(fake, { runner: createStubRunner({ itemDelayMs: 1000 }) });
    await startAll();
    await vi.advanceTimersByTimeAsync(500);
    await settle();
    expect(storedJob().items.map((item) => item.status)).toEqual(['running', 'waiting', 'waiting']);
    expect(storedJob().items[0].phase).toBe('resolving');
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(storedJob().items.map((item) => item.status)).toEqual(['failed', 'running', 'waiting']);
    await vi.advanceTimersByTimeAsync(2500);
    await settle();
    expect(storedJob().state).toBe('done');
  });

  it('closes the offscreen document when it is over and creates a new one for the next job', async () => {
    await startAll();
    await waitFor(() => storedJob().state === 'done');
    await waitFor(() => !fake.offscreen.open);
    expect(fake.offscreen.createCalls).toBe(1);
    expect(fake.offscreen.closeCalls).toBe(1);
    expect(harness.page).toBeNull();
    await startAll();
    await waitFor(() => fake.offscreen.createCalls === 2);
    await waitFor(() => storedJob().state === 'done' && !fake.offscreen.open);
    expect(fake.offscreen.createCalls).toBe(2);
  });

  it('keeps the service worker alive while the job runs: keepalive every 20 s, answered', async () => {
    vi.useFakeTimers();
    harness = installEngine(fake, { runner: createStubRunner({ itemDelayMs: 25_000 }), host: { keepaliveMs: 20_000 } });
    const seen: string[] = [];
    fake.onMessage.listeners.unshift((message) => {
      if ((message as { type?: string }).type === 'engine/keepalive') seen.push('keepalive');
      return false;
    });
    await startAll();
    await vi.advanceTimersByTimeAsync(41_000);
    expect(seen).toEqual(['keepalive', 'keepalive']);
    await vi.advanceTimersByTimeAsync(40_000);
    await settle();
    expect(storedJob().state).toBe('done');
    const after = seen.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen.length).toBe(after); // no keepalives once the job is over
  });

  it('cancelling: the item in flight and the ones waiting are cancelled, finished ones keep their result', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_000);
    harness = installEngine(fake, { runner: createStubRunner({ itemDelayMs: 1000 }) });
    seedQueue(fake, [queueItem(A), queueItem(B), queueItem(D), queueItem(guildTarget(CHANNEL_C, { channelName: 'late' }))]);
    await startAll();
    await vi.advanceTimersByTimeAsync(1500); // A failed, B is running
    await settle();
    expect(storedJob().items.map((item) => item.status)).toEqual(['failed', 'running', 'waiting', 'waiting']);

    await expect(popup.send({ to: 'bg', type: 'job/cancel' })).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(1000);
    await settle();

    const job = storedJob();
    expect(job.state).toBe('cancelled');
    expect(job.items.map((item) => item.status)).toEqual(['failed', 'cancelled', 'cancelled', 'cancelled']);
    expect(job.items[1].error).toMatchObject({ kind: 'cancelled' });
    // history: only what really ended (A failed); the cancelled item left no entry
    expect(history().map((entry) => entry.target.channelId)).toEqual([CHANNEL_A]);
    // list hints: A failed, B (in flight) cancelled, the ones that never started have none
    const hints = Object.fromEntries(storedQueue(fake).map((item) => [item.key, item.lastResult?.status ?? null]));
    expect(hints).toEqual({ [CHANNEL_A]: 'failed', [CHANNEL_B]: 'cancelled', [DM_CHANNEL]: null, [CHANNEL_C]: null });
    expect(fake.notifications.created).toEqual([]);
    await waitFor(() => !fake.offscreen.open);
  });

  it('cancelling before anything started is fine too', async () => {
    vi.useFakeTimers();
    harness = installEngine(fake, { runner: createStubRunner({ itemDelayMs: 1000 }) });
    await startAll();
    await vi.advanceTimersByTimeAsync(10);
    await popup.send({ to: 'bg', type: 'job/cancel' });
    await vi.advanceTimersByTimeAsync(1100);
    await settle();
    expect(storedJob().state).toBe('cancelled');
    expect(storedJob().items.every((item) => item.status === 'cancelled')).toBe(true);
  });

  it('can run again after a cancellation', async () => {
    vi.useFakeTimers();
    harness = installEngine(fake, { runner: createStubRunner({ itemDelayMs: 500 }) });
    await startAll();
    await vi.advanceTimersByTimeAsync(100);
    await popup.send({ to: 'bg', type: 'job/cancel' });
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(storedJob().state).toBe('cancelled');
    const again = await startAll();
    expect(again.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(storedJob().state).toBe('done');
  });

  it('a stub that returns without reporting would leave the job hanging; the host closes it as failed', async () => {
    harness = installEngine(fake, { runner: { run: async () => undefined, cancel: () => undefined } });
    await startAll();
    await waitFor(() => storedJob().state === 'failed');
    expect(storedJob().items.every((item) => item.error?.kind === 'interrupted')).toBe(true);
  });

  it('an engine that throws is closed as failed too', async () => {
    harness = installEngine(fake, {
      runner: {
        run: () => Promise.reject(new Error('boom')),
        cancel: () => undefined,
      },
    });
    await startAll();
    await waitFor(() => storedJob().state === 'failed');
  });
});

describe('history/rerun', () => {
  let engine: ScriptedEngine;
  const own = exportSettings({ count: 50, format: 'md', includeAttachments: true });
  const old = (target = A, overrides: Partial<HistoryEntry> = {}) => historyEntry(target, { id: `h-${target.channelId}`, settings: own, ...overrides });
  const rerun = (id: unknown) => popup.send({ to: 'bg', type: 'history/rerun', id }) as Promise<{ ok: boolean; data?: { jobId: string }; error?: string; message?: string }>;

  beforeEach(async () => {
    fake = createFakeBrowser();
    ({ popup } = await bootLoggedIn(fake));
    engine = scriptedEngine();
    harness = installEngine(fake, { runner: engine.runner });
    seedConsent(fake, { language: 'en', common: exportSettings({ count: 10, format: 'json' }) });
    fake.local.seed({ [LOCAL.history(ACCOUNT_ID)]: [old(A), old(D, { id: 'h-dm' })] });
  });

  it('starts a one-item job from the entry\'s target and the settings it was run with (not the common settings)', async () => {
    const response = await rerun('h-' + CHANNEL_A);
    expect(response).toEqual({ ok: true, data: { jobId: expect.any(String) } });
    await waitFor(() => engine.jobs.length === 1);
    expect(engine.jobs[0].items).toEqual([{ key: CHANNEL_A, target: A, settings: own }]);
    expect(engine.jobs[0].settings.common).toEqual(exportSettings({ count: 10, format: 'json' }));
    expect(storedJob()).toMatchObject({ jobId: response.data?.jobId, state: 'running' });
    expect(storedJob().items).toEqual([expect.objectContaining({ key: CHANNEL_A, label: 'Test Server > #general', expected: 50, status: 'waiting' })]);
  });

  it('never runs incrementally ("다시 받기" downloads the same scope again): the engine gets the entry\'s settings with `incremental` off', async () => {
    const incremental = exportSettings({ count: 50, from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', format: 'md', includeAttachments: true, incremental: true });
    fake.local.seed({
      [LOCAL.history(ACCOUNT_ID)]: [old(A, { settings: incremental })],
      [LOCAL.lastExported(ACCOUNT_ID)]: { [CHANNEL_A]: '900000000000000010' }, // a marker exists: an incremental run would skip up to it
    });
    await rerun('h-' + CHANNEL_A);
    await waitFor(() => engine.jobs.length === 1);
    // everything else (count, period, format, options) is what the entry ran with
    expect(engine.jobs[0].items).toEqual([{ key: CHANNEL_A, target: A, settings: { ...incremental, incremental: false } }]);
    expect(engine.jobs[0].items[0].settings.incremental).toBe(false);
    expect(history()[0].settings.incremental).toBe(true); // the stored entry itself is left as it was
    expect(storedJob().items[0].expected).toBe(50);
  });

  it('an entry that did not run incrementally stays as it was, whatever the common settings say', async () => {
    seedConsent(fake, { common: exportSettings({ count: 10, incremental: true }) });
    await rerun('h-' + CHANNEL_A);
    await waitFor(() => engine.jobs.length === 1);
    expect(engine.jobs[0].items[0].settings).toEqual(own);
    expect(engine.jobs[0].settings.common.incremental).toBe(true); // the common settings are not edited either
  });

  it('only "download again" forces it off: a normal job/start keeps `incremental` (own settings and common settings alike)', async () => {
    seedConsent(fake, { common: exportSettings({ incremental: true }) });
    seedQueue(fake, [queueItem(A, { settings: exportSettings({ incremental: true, format: 'csv' }) }), queueItem(B)]);
    await startJobWith(popup, engine, 'all');
    expect(engine.jobs[0].items.map((item) => [item.key, item.settings.incremental])).toEqual([
      [CHANNEL_A, true],
      [CHANNEL_B, true],
    ]);
  });

  it('does not touch the list: not when it starts, not when the chat is done, not when it fails', async () => {
    seedQueue(fake, [queueItem(A), queueItem(B)]);
    const queueBefore = JSON.stringify(storedQueue(fake));
    const { data } = await rerun('h-' + CHANNEL_A);
    await waitFor(() => engine.jobs.length === 1);
    expect(JSON.stringify(storedQueue(fake))).toBe(queueBefore);

    await engine.io!.itemDone(data!.jobId, historyEntry(A, { id: 'new-1', settings: own }), '900000000000000010');
    expect(JSON.stringify(storedQueue(fake))).toBe(queueBefore); // the queued copy of the same chat stays
    await engine.io!.finished(data!.jobId, 'done');
    expect(JSON.stringify(storedQueue(fake))).toBe(queueBefore);
  });

  it('still records the result: a new history entry and (for done) the incremental marker', async () => {
    const { data } = await rerun('h-' + CHANNEL_A);
    await waitFor(() => engine.jobs.length === 1);
    await engine.io!.itemDone(data!.jobId, historyEntry(A, { id: 'new-1', settings: own, messageCount: 42 }), '900000000000000010');
    expect(history().map((entry) => entry.id)).toEqual(['new-1', 'h-' + CHANNEL_A, 'h-dm']);
    expect(fake.local.peek(LOCAL.lastExported(ACCOUNT_ID))).toEqual({ [CHANNEL_A]: '900000000000000010' });
  });

  it('a failed re-run leaves no retry hint in the list (the list was not part of it)', async () => {
    seedQueue(fake, [queueItem(A)]);
    const { data } = await rerun('h-' + CHANNEL_A);
    await waitFor(() => engine.jobs.length === 1);
    await engine.io!.progress({ ...storedJob(), items: [{ ...storedJob().items[0], status: 'failed', error: { kind: 'network', message: 'timeout' } }] });
    await engine.io!.itemDone(data!.jobId, historyEntry(A, { id: 'new-2', status: 'failed', error: 'timeout' }), null);
    await engine.io!.finished(data!.jobId, 'done');
    expect(storedQueue(fake)[0].lastResult).toBeUndefined();
    expect(fake.badge.text).toBe('!'); // but the user is told that it failed
  });

  it('a normal job afterwards works as usual again (items leave the list when done)', async () => {
    seedQueue(fake, [queueItem(A), queueItem(B)]);
    const first = await rerun('h-' + CHANNEL_A);
    await waitFor(() => engine.jobs.length === 1);
    await engine.io!.finished(first.data!.jobId, 'done');
    engine.finish();
    await waitFor(() => storedJob().state === 'done');
    const second = await startJobWith(popup, engine, [CHANNEL_B]);
    await engine.io!.itemDone(second, historyEntry(B, { id: 'new-b' }), '5');
    expect(storedQueue(fake).map((item) => item.key)).toEqual([CHANNEL_A]);
  });

  it('checks like a normal start: consent, account, busy', async () => {
    fake.local.seed({ [LOCAL.settings]: { consentAt: null } });
    await expect(rerun('h-' + CHANNEL_A)).resolves.toEqual({ ok: false, error: 'no-consent' });
    seedConsent(fake);
    await rerun('h-' + CHANNEL_A);
    await waitFor(() => engine.jobs.length === 1);
    await expect(rerun('h-dm')).resolves.toEqual({ ok: false, error: 'busy' });

    const other = createFakeBrowser();
    installFakeDiscordApi();
    await bootWorker(other);
    seedConsent(other);
    await expect(other.createPage().send({ to: 'bg', type: 'history/rerun', id: 'h-1' })).resolves.toEqual({ ok: false, error: 'no-account' });
  });

  it('refuses an entry that does not exist, and ids that are not ids', async () => {
    await expect(rerun('nope')).resolves.toEqual({ ok: false, error: 'invalid', message: 'history entry not found' });
    for (const id of [undefined, null, 5, '', 'x'.repeat(101), {}]) await expect(rerun(id)).resolves.toMatchObject({ ok: false, error: 'invalid' });
    expect(engine.jobs).toEqual([]);
  });

  it('only finds entries of the current account', async () => {
    fake.local.seed({ [LOCAL.history('100000000000000002')]: [old(B, { id: 'h-other', accountId: '100000000000000002' })] });
    await expect(rerun('h-other')).resolves.toMatchObject({ ok: false, error: 'invalid' });
  });

  it('a damaged history entry is simply not there', async () => {
    fake.local.seed({ [LOCAL.history(ACCOUNT_ID)]: [{ id: 'broken', target: { kind: 'nope' } }] });
    await expect(rerun('broken')).resolves.toMatchObject({ ok: false, error: 'invalid' });
  });

  it('zip follows the setting, like any job', async () => {
    fake.local.seed({ [LOCAL.settings]: { consentAt: 1, zipAll: true } });
    await rerun('h-' + CHANNEL_A);
    await waitFor(() => engine.jobs.length === 1);
    expect(storedJob().zip).toBe(true);
    expect(engine.jobs[0].settings.zipAll).toBe(true);
  });
});
