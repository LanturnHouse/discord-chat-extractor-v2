import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL, SESSION } from '@/shared';
import type { AccountInfo, InjectHealth, JobState } from '@/shared';
import { createFakeBrowser } from './fakeChrome';
import type { FakeBrowser, FakePage } from './fakeChrome';
import { ACCOUNT_ID, CHANNEL_A, TOKEN, bootLoggedIn, bootWorker, installFakeDiscordApi, settle, waitFor } from './helpers';

let fake: FakeBrowser;
let popup: FakePage;

beforeEach(async () => {
  fake = createFakeBrowser();
  ({ popup } = await bootLoggedIn(fake));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const status = async () => ((await popup.send({ to: 'bg', type: 'status/get' })) as { ok: true; data: Record<string, unknown> }).data;
const health = (overrides: Partial<InjectHealth> = {}): InjectHealth => ({ ok: true, reason: null, checkedAt: 1000, url: 'https://discord.com/channels/@me', ...overrides });
const reportHealth = (page: FakePage, value: unknown) => page.send({ to: 'bg', type: 'inject/health', health: value });

describe('status/get', () => {
  it('reports the account, the last account, the open Discord tabs, the latest health and the job', async () => {
    const job: JobState = { jobId: 'j1', accountId: ACCOUNT_ID, startedAt: 1, finishedAt: null, state: 'running', pausedReason: null, zip: false, items: [] };
    fake.session.seed({ [SESSION.job]: job });
    fake.tabs = [
      { id: 1, url: 'https://discord.com/channels/@me', windowId: 1, active: true },
      { id: 2, url: 'https://ptb.discord.com/app', windowId: 1, active: false },
      { id: 3, url: 'https://canary.discord.com/', windowId: 2, active: true },
    ];
    const content = fake.createContentScript(1);
    await reportHealth(content, health({ ok: false, reason: 'no sidebar', checkedAt: 5000 }));

    const data = await status();
    expect(data.account).toMatchObject({ id: ACCOUNT_ID, username: 'tester' });
    expect(data.lastAccount).toMatchObject({ id: ACCOUNT_ID });
    expect(data.discordTabs).toBe(3);
    expect(data.health).toEqual(health({ ok: false, reason: 'no sidebar', checkedAt: 5000 }));
    expect(data.job).toEqual(job);
  });

  it('counts only Discord web client tabs (exact origins) with the chrome.tabs.query URL filter', async () => {
    fake.tabs = [
      { id: 1, url: 'https://discord.com/channels/@me', windowId: 1, active: true },
      { id: 2, url: 'https://support.discord.com/', windowId: 1, active: false },
      { id: 3, url: 'https://discord.com.evil.example/', windowId: 1, active: false },
      { id: 4, url: 'https://www.youtube.com/', windowId: 1, active: false },
      { id: 5, url: 'http://discord.com/', windowId: 1, active: false },
    ];
    expect((await status()).discordTabs).toBe(1);
    expect(vi.mocked(chrome.tabs.query)).toHaveBeenCalledWith({ url: ['https://discord.com/*', 'https://ptb.discord.com/*', 'https://canary.discord.com/*'] });
  });

  it('has nothing for the optional parts on a fresh browser', async () => {
    const other = createFakeBrowser();
    installFakeDiscordApi();
    await bootWorker(other);
    const data = ((await other.createPage().send({ to: 'bg', type: 'status/get' })) as { data: unknown }).data;
    expect(data).toEqual({ account: null, lastAccount: null, discordTabs: 0, health: null, job: null });
  });

  it('keeps the last account when there is no current one (the token went away)', async () => {
    await fake.session.remove([SESSION.token, SESSION.tokenCapturedAt]);
    await waitFor(() => fake.session.peek(SESSION.account) === null);
    const data = await status();
    expect(data.account).toBeNull();
    expect((data.lastAccount as AccountInfo).id).toBe(ACCOUNT_ID);
  });

  it('never contains the authorization value', async () => {
    expect(JSON.stringify(await popup.send({ to: 'bg', type: 'status/get' }))).not.toContain(TOKEN);
  });

  it('acknowledges a failed job: the red "!" goes away', async () => {
    fake.session.seed({ [SESSION.job]: { jobId: 'j', accountId: ACCOUNT_ID, startedAt: 1, finishedAt: 2, state: 'done', pausedReason: null, zip: false, items: [] } });
    await fake.session.set({ 'dce.bg.state': { jobId: 'j', source: 'queue', lastDownloadId: null, blobs: {}, alert: true } }); // fires onChanged -> badge
    await waitFor(() => fake.badge.text === '!');
    expect(fake.badge.color).toBe('#D83C3E');
    await status();
    await waitFor(() => fake.badge.text === '');
  });
});

describe('inject/health', () => {
  it('stores the report of a tab under its tab id', async () => {
    fake.tabs = [{ id: 7, url: 'https://discord.com/channels/@me', windowId: 1, active: true }];
    const content = fake.createContentScript(7);
    await expect(reportHealth(content, health({ checkedAt: 42 }))).resolves.toEqual({ ok: true });
    expect(fake.session.peek(SESSION.injectHealth)).toEqual({ '7': health({ checkedAt: 42 }) });
  });

  it('keeps the newest report of every tab and answers status/get with the latest of all', async () => {
    fake.tabs = [
      { id: 7, url: 'https://discord.com/channels/@me', windowId: 1, active: true },
      { id: 8, url: 'https://discord.com/channels/1/2', windowId: 1, active: false },
    ];
    await reportHealth(fake.createContentScript(7), health({ checkedAt: 100, reason: 'first' }));
    await reportHealth(fake.createContentScript(8), health({ ok: false, checkedAt: 300, reason: 'newest' }));
    await reportHealth(fake.createContentScript(7), health({ checkedAt: 200, reason: 'second report of tab 7' }));
    expect(Object.keys(fake.session.peek(SESSION.injectHealth) as object).sort()).toEqual(['7', '8']);
    expect((await status()).health).toMatchObject({ checkedAt: 300, reason: 'newest', ok: false });
  });

  it('forgets a tab that is closed (tabs.onRemoved) and ignores closed tabs in the status', async () => {
    fake.tabs = [
      { id: 7, url: 'https://discord.com/channels/@me', windowId: 1, active: true },
      { id: 8, url: 'https://discord.com/channels/1/2', windowId: 1, active: false },
    ];
    await reportHealth(fake.createContentScript(7), health({ checkedAt: 100 }));
    await reportHealth(fake.createContentScript(8), health({ checkedAt: 200, reason: 'tab 8' }));
    fake.tabs = fake.tabs.filter((tab) => tab.id !== 8);
    expect((await status()).health).toMatchObject({ checkedAt: 100 }); // tab 8 is gone: not "the latest" any more
    fake.onTabRemoved.dispatch(8);
    await waitFor(() => !('8' in (fake.session.peek(SESSION.injectHealth) as object)));
    expect(Object.keys(fake.session.peek(SESSION.injectHealth) as object)).toEqual(['7']);
  });

  it('prunes the reports of tabs that no longer exist when a new report comes in', async () => {
    fake.tabs = [{ id: 7, url: 'https://discord.com/channels/@me', windowId: 1, active: true }];
    fake.session.seed({ [SESSION.injectHealth]: { '5': health(), '6': health() } });
    await reportHealth(fake.createContentScript(7), health({ checkedAt: 9 }));
    expect(Object.keys(fake.session.peek(SESSION.injectHealth) as object)).toEqual(['7']);
  });

  it('caps what it keeps at 50 tabs, newest first', async () => {
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [String(100 + index), health({ checkedAt: index })]));
    fake.tabs = Array.from({ length: 61 }, (_, index) => ({ id: 100 + index, url: 'https://discord.com/channels/@me', windowId: 1, active: false }));
    fake.session.seed({ [SESSION.injectHealth]: many });
    await reportHealth(fake.createContentScript(160), health({ checkedAt: 1000 }));
    const kept = Object.keys(fake.session.peek(SESSION.injectHealth) as object);
    expect(kept).toHaveLength(50);
    expect(kept).toContain('160');
    expect(kept).not.toContain('100'); // the oldest report went
  });

  it('cuts the reason and keeps only origin and path of the URL (no query string, no fragment)', async () => {
    const content = fake.createContentScript(7, 'https://discord.com/channels/1/2?x=1#y');
    await reportHealth(content, health({ reason: 'r'.repeat(500), url: 'https://discord.com/channels/1/2?token=abc&x=1#frag' }));
    const stored = (fake.session.peek(SESSION.injectHealth) as Record<string, InjectHealth>)['7'];
    expect(stored.reason).toHaveLength(200);
    expect(stored.url).toBe('https://discord.com/channels/1/2');
  });

  it('falls back to the sender\'s URL when the report has none', async () => {
    const content = fake.createContentScript(7, 'https://discord.com/channels/9/8?z=1');
    await reportHealth(content, { ok: true, reason: null, checkedAt: 5 });
    expect((fake.session.peek(SESSION.injectHealth) as Record<string, InjectHealth>)['7'].url).toBe('https://discord.com/channels/9/8');
  });

  it.each([
    ['not an object', 'ok'],
    ['no ok flag', { reason: null, checkedAt: 1, url: 'https://discord.com/' }],
    ['ok as a string', { ok: 'yes', reason: null, checkedAt: 1, url: 'https://discord.com/' }],
    ['a numeric reason', { ok: true, reason: 5, checkedAt: 1, url: 'https://discord.com/' }],
    ['no time', { ok: true, reason: null, url: 'https://discord.com/' }],
    ['a non-finite time', { ok: true, reason: null, checkedAt: Infinity, url: 'https://discord.com/' }],
  ])('refuses a report that is %s', async (_label, value) => {
    await expect(reportHealth(fake.createContentScript(7), value)).resolves.toMatchObject({ ok: false, error: 'invalid' });
    expect(fake.session.has(SESSION.injectHealth)).toBe(false);
  });

  it('needs a tab: the popup cannot file a report', async () => {
    await expect(reportHealth(popup, health())).resolves.toEqual({ ok: false, error: 'invalid', message: 'inject/health must come from a tab' });
  });
});

describe('discord/open', () => {
  it('opens Discord when no Discord tab exists', async () => {
    await expect(popup.send({ to: 'bg', type: 'discord/open' })).resolves.toEqual({ ok: true });
    expect(fake.tabsCreated).toEqual([{ url: 'https://discord.com/channels/@me' }]);
    expect(fake.tabUpdates).toEqual([]);
  });

  it('focuses an existing Discord tab and its window instead of opening another one', async () => {
    fake.tabs = [
      { id: 4, url: 'https://www.youtube.com/', windowId: 1, active: true },
      { id: 5, url: 'https://discord.com/channels/@me', windowId: 3, active: false },
    ];
    await expect(popup.send({ to: 'bg', type: 'discord/open' })).resolves.toEqual({ ok: true });
    expect(fake.tabUpdates).toEqual([{ tabId: 5, props: { active: true } }]);
    expect(fake.windowUpdates).toEqual([{ windowId: 3, info: { focused: true } }]);
    expect(fake.tabsCreated).toEqual([]);
  });

  it('prefers a Discord tab that is already the visible one in its window', async () => {
    fake.tabs = [
      { id: 5, url: 'https://discord.com/channels/@me', windowId: 1, active: false },
      { id: 6, url: 'https://ptb.discord.com/channels/@me', windowId: 2, active: true },
    ];
    await popup.send({ to: 'bg', type: 'discord/open' });
    expect(fake.tabUpdates.map((update) => update.tabId)).toEqual([6]);
    expect(fake.windowUpdates.map((update) => update.windowId)).toEqual([2]);
  });

  it('reports a failure instead of throwing', async () => {
    vi.mocked(chrome.tabs.create).mockRejectedValueOnce(new Error('No browser window'));
    await expect(popup.send({ to: 'bg', type: 'discord/open' })).resolves.toEqual({ ok: false, error: 'unknown', message: 'No browser window' });
  });
});

describe('downloads/show', () => {
  it('reveals a download in the file manager', async () => {
    await expect(popup.send({ to: 'bg', type: 'downloads/show', downloadId: 12 })).resolves.toEqual({ ok: true });
    expect(fake.downloads.shown).toEqual([12]);
    expect(fake.downloads.defaultFolderShown).toBe(0);
  });

  it('opens the default downloads folder for null', async () => {
    await expect(popup.send({ to: 'bg', type: 'downloads/show', downloadId: null })).resolves.toEqual({ ok: true });
    expect(fake.downloads.defaultFolderShown).toBe(1);
    expect(fake.downloads.shown).toEqual([]);
  });

  it('accepts download id 0', async () => {
    await popup.send({ to: 'bg', type: 'downloads/show', downloadId: 0 });
    expect(fake.downloads.shown).toEqual([0]);
  });

  it.each([-1, 1.5, '3', undefined, {}, NaN])('refuses the id %j', async (downloadId) => {
    await expect(popup.send({ to: 'bg', type: 'downloads/show', downloadId })).resolves.toMatchObject({ ok: false, error: 'invalid' });
    expect(fake.downloads.shown).toEqual([]);
    expect(fake.downloads.defaultFolderShown).toBe(0);
  });

  it('reports a browser error instead of throwing', async () => {
    vi.mocked(chrome.downloads.show).mockImplementationOnce(() => {
      throw new Error('Invalid download id');
    });
    await expect(popup.send({ to: 'bg', type: 'downloads/show', downloadId: 99 })).resolves.toEqual({ ok: false, error: 'unknown', message: 'Invalid download id' });
  });
});

describe('history/clear', () => {
  const entry = (id: string) => ({
    id,
    accountId: ACCOUNT_ID,
    target: { kind: 'guild-channel', channelId: CHANNEL_A, guildId: '200000000000000001', guildName: 'Test Server', channelName: 'general' },
    settings: { count: 200, from: null, to: null, format: 'html', htmlTheme: 'dark', includeAttachments: false, includeThreads: false, incremental: false, content: { includeBots: true, includeSystem: true, includeReactions: true, includeEmbeds: true } },
    finishedAt: 5,
    status: 'done',
    messageCount: 3,
    files: [],
    error: null,
  });

  it('clears the history of the current account only', async () => {
    fake.local.seed({ [LOCAL.history(ACCOUNT_ID)]: [entry('a'), entry('b')], [LOCAL.history('100000000000000002')]: [entry('c')] });
    await expect(popup.send({ to: 'bg', type: 'history/clear' })).resolves.toEqual({ ok: true });
    expect(fake.local.peek(LOCAL.history(ACCOUNT_ID))).toEqual([]);
    expect(fake.local.peek<unknown[]>(LOCAL.history('100000000000000002'))).toHaveLength(1);
  });

  it('answers "no-account" without an account', async () => {
    const other = createFakeBrowser();
    installFakeDiscordApi();
    await bootWorker(other);
    await expect(other.createPage().send({ to: 'bg', type: 'history/clear' })).resolves.toEqual({ ok: false, error: 'no-account' });
  });
});

describe('the worker keeps working while it settles', () => {
  it('(sanity) a settled worker has nothing pending', async () => {
    await settle();
    expect(fake.session.peek(SESSION.account)).toBeTruthy();
  });
});
