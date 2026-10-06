import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL, SESSION } from '@/shared';
import type { ItemProgress, JobState } from '@/shared';
import { BADGE_ALERT_COLOR, BADGE_COLOR, affectsBadge, computeBadge } from '@/background/badge';
import { createFakeBrowser } from './fakeChrome';
import type { FakeBrowser, FakePage } from './fakeChrome';
import {
  ACCOUNT_ID,
  CHANNEL_A,
  CHANNEL_B,
  CHANNEL_C,
  OTHER_ACCOUNT_ID,
  OTHER_TOKEN,
  bootLoggedIn,
  guildTarget,
  historyEntry,
  installEngine,
  queueItem,
  scriptedEngine,
  seedConsent,
  seedQueue,
  settle,
  snapshot,
  startJobWith,
  userPayload,
  waitFor,
} from './helpers';
import type { FakeDiscordApi, ScriptedEngine } from './helpers';

const item = (status: ItemProgress['status'], key = '1'): ItemProgress => ({ key, label: key, status, phase: null, fetched: 0, expected: 200, error: null, files: [] });
const job = (statuses: ItemProgress['status'][], state: JobState['state'] = 'running'): JobState => ({
  jobId: 'j',
  accountId: ACCOUNT_ID,
  startedAt: 1,
  finishedAt: state === 'running' || state === 'paused' ? null : 2,
  state,
  pausedReason: state === 'paused' ? 'rate-limit' : null,
  zip: false,
  items: statuses.map((status, index) => item(status, String(index + 1))),
});

describe('computeBadge (docs/PLAN.md §7.2)', () => {
  it('shows the number of chats in the list while idle, blank when it is empty', () => {
    expect(computeBadge({ job: null, alert: false, queueCount: 0 })).toEqual({ text: '', color: BADGE_COLOR });
    expect(computeBadge({ job: null, alert: false, queueCount: 1 })).toEqual({ text: '1', color: BADGE_COLOR });
    expect(computeBadge({ job: null, alert: false, queueCount: 37 }).text).toBe('37');
    expect(computeBadge({ job: null, alert: false, queueCount: 999 }).text).toBe('999');
    expect(computeBadge({ job: null, alert: false, queueCount: 1000 }).text).toBe('999+');
  });

  it('shows done/total while a job runs', () => {
    expect(computeBadge({ job: job(['waiting', 'waiting', 'waiting']), alert: false, queueCount: 3 })).toEqual({ text: '0/3', color: BADGE_COLOR });
    expect(computeBadge({ job: job(['done', 'running', 'waiting']), alert: false, queueCount: 3 }).text).toBe('1/3');
    expect(computeBadge({ job: job(['done', 'done', 'running']), alert: false, queueCount: 3 }).text).toBe('2/3');
  });

  it('counts every finished item (done, partial, failed, cancelled) as processed, not the running or waiting ones', () => {
    expect(computeBadge({ job: job(['done', 'partial', 'failed', 'cancelled', 'running', 'waiting', 'paused']), alert: false, queueCount: 0 }).text).toBe('4/7');
    expect(computeBadge({ job: job(['done', 'partial', 'failed', 'cancelled']), alert: false, queueCount: 0 }).text).toBe('4/4');
    expect(computeBadge({ job: job(['running', 'waiting', 'paused']), alert: false, queueCount: 0 }).text).toBe('0/3');
  });

  it('keeps showing progress while the job is paused for a rate limit', () => {
    expect(computeBadge({ job: job(['done', 'waiting'], 'paused'), alert: false, queueCount: 2 }).text).toBe('1/2');
  });

  it('switches to a percentage when done/total would be longer than 4 characters', () => {
    const many = (done: number, total: number) => job([...Array(done).fill('done'), ...Array(total - done).fill('waiting')] as ItemProgress['status'][]);
    expect(computeBadge({ job: many(2, 10), alert: false, queueCount: 0 }).text).toBe('2/10'); // exactly 4 characters
    expect(computeBadge({ job: many(10, 10), alert: false, queueCount: 0 }).text).toBe('100%');
    expect(computeBadge({ job: many(12, 20), alert: false, queueCount: 0 }).text).toBe('60%');
    expect(computeBadge({ job: many(99, 100), alert: false, queueCount: 0 }).text).toBe('99%');
    expect(computeBadge({ job: many(100, 200), alert: false, queueCount: 0 }).text).toBe('50%');
    expect(computeBadge({ job: many(0, 12), alert: false, queueCount: 0 }).text).toBe('0/12'); // 4 characters: still fits
    expect(computeBadge({ job: many(0, 120), alert: false, queueCount: 0 }).text).toBe('0%');
    expect(computeBadge({ job: many(1, 150), alert: false, queueCount: 0 }).text).toBe('0%');
    expect(computeBadge({ job: many(3, 9), alert: false, queueCount: 0 }).text).toBe('3/9');
  });

  it('never shows a percentage of 100 before everything is done (it rounds down)', () => {
    const almost = job([...Array(199).fill('done'), 'running'] as ItemProgress['status'][]);
    expect(computeBadge({ job: almost, alert: false, queueCount: 0 }).text).toBe('99%');
  });

  it('shows a red "!" after a job that ended with failures, until the popup was opened', () => {
    expect(computeBadge({ job: job(['done', 'failed'], 'done'), alert: true, queueCount: 4 })).toEqual({ text: '!', color: BADGE_ALERT_COLOR });
    expect(computeBadge({ job: null, alert: true, queueCount: 0 }).text).toBe('!');
    expect(computeBadge({ job: job(['done', 'failed'], 'done'), alert: false, queueCount: 4 }).text).toBe('4');
  });

  it('a running job outranks the failure flag and the list size', () => {
    expect(computeBadge({ job: job(['waiting']), alert: true, queueCount: 9 })).toEqual({ text: '0/1', color: BADGE_COLOR });
  });

  it('a finished job shows the list size again', () => {
    for (const state of ['done', 'cancelled', 'failed'] as const) expect(computeBadge({ job: job(['done'], state), alert: false, queueCount: 2 }).text).toBe('2');
  });
});

describe('affectsBadge', () => {
  it('reacts to the job, the account and the private state in session storage, and to any account\'s list in local storage', () => {
    expect(affectsBadge({ [SESSION.job]: {} }, 'session')).toBe(true);
    expect(affectsBadge({ [SESSION.account]: {} }, 'session')).toBe(true);
    expect(affectsBadge({ 'dce.bg.state': {} }, 'session')).toBe(true);
    expect(affectsBadge({ [LOCAL.queue(ACCOUNT_ID)]: {} }, 'local')).toBe(true);
    expect(affectsBadge({ [LOCAL.queue(OTHER_ACCOUNT_ID)]: {}, other: {} }, 'local')).toBe(true);
  });

  it('ignores everything else (the theme is written by the content script all the time)', () => {
    expect(affectsBadge({ [LOCAL.theme]: {} }, 'local')).toBe(false);
    expect(affectsBadge({ [LOCAL.settings]: {} }, 'local')).toBe(false);
    expect(affectsBadge({ [LOCAL.history(ACCOUNT_ID)]: {} }, 'local')).toBe(false);
    expect(affectsBadge({ [LOCAL.lastExported(ACCOUNT_ID)]: {} }, 'local')).toBe(false);
    expect(affectsBadge({ [SESSION.token]: {} }, 'session')).toBe(false);
    expect(affectsBadge({ [SESSION.injectHealth]: {} }, 'session')).toBe(false);
    expect(affectsBadge({ [LOCAL.queue(ACCOUNT_ID)]: {} }, 'session')).toBe(false);
    expect(affectsBadge({ [SESSION.job]: {} }, 'sync')).toBe(false);
  });
});

describe('the badge in the worker', () => {
  let fake: FakeBrowser;
  let popup: FakePage;
  let content: FakePage;
  let api: FakeDiscordApi;

  beforeEach(async () => {
    fake = createFakeBrowser();
    ({ popup, api } = await bootLoggedIn(fake));
    content = fake.createContentScript(7);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const toggle = (channelId: string) => content.send({ to: 'bg', type: 'queue/toggle', target: guildTarget(channelId) });

  it('is blank when there is nothing in the list', async () => {
    await settle();
    expect(fake.badge.text).toBe('');
  });

  it('follows the list: add, add, remove, clear', async () => {
    await toggle(CHANNEL_A);
    await waitFor(() => fake.badge.text === '1');
    expect(fake.badge.color).toBe(BADGE_COLOR);
    await toggle(CHANNEL_B);
    await waitFor(() => fake.badge.text === '2');
    await toggle(CHANNEL_A);
    await waitFor(() => fake.badge.text === '1');
    await popup.send({ to: 'bg', type: 'queue/clear' });
    await waitFor(() => fake.badge.text === '');
  });

  it('shows the list of the CURRENT account', async () => {
    await toggle(CHANNEL_A);
    await waitFor(() => fake.badge.text === '1');
    api.users.set(OTHER_TOKEN, userPayload(OTHER_ACCOUNT_ID));
    fake.captureToken(OTHER_TOKEN);
    await waitFor(() => fake.badge.text === ''); // the other account has an empty list
    await toggle(CHANNEL_B);
    await toggle(CHANNEL_C);
    await waitFor(() => fake.badge.text === '2');
  });

  it('is blank while no account is verified', async () => {
    await toggle(CHANNEL_A);
    await waitFor(() => fake.badge.text === '1');
    await fake.session.remove([SESSION.token, SESSION.tokenCapturedAt]);
    await waitFor(() => fake.badge.text === '');
  });

  it('does not touch the badge when nothing about it changed', async () => {
    await toggle(CHANNEL_A);
    await waitFor(() => fake.badge.text === '1');
    const calls = fake.badge.textCalls;
    await fake.local.set({ [LOCAL.theme]: { scheme: 'dark', themeClasses: [], vars: {}, lang: 'ko', capturedAt: 1 } });
    await fake.local.set({ [LOCAL.settings]: { consentAt: 5 } });
    await settle();
    expect(fake.badge.textCalls).toBe(calls);
  });

  it('only sets a colour for a text (an empty badge needs none)', async () => {
    await toggle(CHANNEL_A);
    await waitFor(() => fake.badge.text === '1');
    vi.mocked(chrome.action.setBadgeBackgroundColor).mockClear();
    await toggle(CHANNEL_A);
    await waitFor(() => fake.badge.text === '');
    expect(chrome.action.setBadgeBackgroundColor).not.toHaveBeenCalled();
  });

  describe('during a job', () => {
    let engine: ScriptedEngine;
    let jobId: string;

    beforeEach(async () => {
      engine = scriptedEngine();
      installEngine(fake, { runner: engine.runner });
      seedConsent(fake);
      seedQueue(fake, [queueItem(guildTarget(CHANNEL_A)), queueItem(guildTarget(CHANNEL_B)), queueItem(guildTarget(CHANNEL_C))]);
      jobId = await startJobWith(popup, engine);
    });

    it('shows done/total and follows the engine\'s progress', async () => {
      await waitFor(() => fake.badge.text === '0/3');
      await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'done' }, [CHANNEL_B]: { status: 'running' } }));
      await waitFor(() => fake.badge.text === '1/3');
      expect(fake.badge.color).toBe(BADGE_COLOR);
    });

    it('goes back to the list size when the job ends cleanly (finished items have left the list)', async () => {
      await engine.io!.itemDone(jobId, historyEntry(guildTarget(CHANNEL_A)), '5');
      await engine.io!.itemDone(jobId, historyEntry(guildTarget(CHANNEL_B)), '6');
      await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'done' }, [CHANNEL_B]: { status: 'done' }, [CHANNEL_C]: { status: 'cancelled' } }));
      await engine.io!.finished(jobId, 'cancelled');
      await waitFor(() => fake.badge.text === '1');
    });

    it('turns into a red "!" when the job ended with failures, and goes when the popup asks for the status', async () => {
      await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'failed' }, [CHANNEL_B]: { status: 'done' }, [CHANNEL_C]: { status: 'done' } }));
      await engine.io!.finished(jobId, 'done');
      await waitFor(() => fake.badge.text === '!');
      expect(fake.badge.color).toBe(BADGE_ALERT_COLOR);
      await settle();
      expect(fake.badge.text).toBe('!'); // it stays
      await popup.send({ to: 'bg', type: 'status/get' });
      await waitFor(() => fake.badge.text === '3'); // the list still has the three chats (no itemDone was sent)
    });

    it('the "!" survives a worker restart and later changes of the list (it is state, not a timer)', async () => {
      await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'failed' } }));
      await engine.io!.finished(jobId, 'done');
      await waitFor(() => fake.badge.text === '!');
      await toggle(CHANNEL_A); // the list changes
      await settle();
      expect(fake.badge.text).toBe('!');
    });
  });
});
