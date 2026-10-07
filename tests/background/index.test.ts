/**
 * The service worker entry (src/background/index.ts): every chrome event listener is registered synchronously at the top level
 * (an MV3 requirement: Chrome only wakes a suspended worker for listeners that exist when its script first runs), the token
 * capture is wired like v1's, and a whole session never lets the authorization value out of session storage.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL, SESSION } from '@/shared';
import { DISCORD_API_URL_PATTERNS } from '@/background/token';
import { createFakeBrowser } from './fakeChrome';
import type { FakeBrowser } from './fakeChrome';
import {
  CHANNEL_A,
  DM_CHANNEL,
  OTHER_TOKEN,
  TOKEN,
  bootLoggedIn,
  bootWorker,
  dmTarget,
  guildTarget,
  historyEntry,
  installEngine,
  installFakeDiscordApi,
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

let fake: FakeBrowser;
let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
  fake = createFakeBrowser();
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('listener registration', () => {
  /** Every FakeEvent the worker may listen to, by name. */
  const events = (browser: FakeBrowser) => ({
    'webRequest.onBeforeSendHeaders': browser.onBeforeSendHeaders,
    'storage.onChanged': browser.storageChanged,
    'runtime.onMessage': browser.onMessage,
    'runtime.onStartup': browser.onStartup,
    'runtime.onInstalled': browser.onInstalled,
    'downloads.onChanged': browser.onDownloadChanged,
    'notifications.onClicked': browser.onNotificationClicked,
    'notifications.onButtonClicked': browser.onNotificationButtonClicked,
    'commands.onCommand': browser.onCommand,
    'tabs.onRemoved': browser.onTabRemoved,
  });

  it('registers each of its listeners exactly once', async () => {
    installFakeDiscordApi();
    await bootWorker(fake);
    for (const [name, event] of Object.entries(events(fake))) expect(event.listeners, name).toHaveLength(1);
    expect(fake.onNotificationClosed.listeners).toHaveLength(0);
  });

  it('registers all of them before the worker makes its first asynchronous chrome call (top level, synchronously)', async () => {
    installFakeDiscordApi();
    let asyncStarted = false;
    const late: string[] = [];
    const originalGet = fake.session.get.getMockImplementation()!;
    fake.session.get.mockImplementation(async (...args) => {
      asyncStarted = true;
      return originalGet(...args);
    });
    for (const [name, event] of Object.entries(events(fake))) {
      const add = event.addListener;
      event.addListener = ((listener: never, ...extra: unknown[]) => {
        if (asyncStarted) late.push(name);
        return add(listener, ...extra);
      }) as typeof event.addListener;
    }
    await bootWorker(fake);
    expect(asyncStarted).toBe(true);
    expect(late).toEqual([]);
  });

  it('only index.ts (and the dev reload) call addListener: no module registers a listener lazily', () => {
    const dir = new URL('../../src/background/', import.meta.url);
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith('.ts') && file !== 'index.ts' && file !== 'devReload.ts')
      .filter((file) => /\.addListener\(/.test(readFileSync(new URL(file, dir), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('observes only Discord API XHR traffic, read-only (no blocking), without extraHeaders (no cookie headers)', async () => {
    installFakeDiscordApi();
    await bootWorker(fake);
    const [filter, extraInfoSpec] = fake.onBeforeSendHeaders.extras[0];
    expect(filter).toEqual({ urls: DISCORD_API_URL_PATTERNS, types: ['xmlhttprequest'] });
    expect(DISCORD_API_URL_PATTERNS).toEqual([
      'https://discord.com/api/*',
      'https://ptb.discord.com/api/*',
      'https://canary.discord.com/api/*',
    ]);
    expect(extraInfoSpec).toEqual(['requestHeaders']);
    expect(extraInfoSpec).not.toContain('extraHeaders');
    expect(extraInfoSpec).not.toContain('blocking');
  });
});

describe('token capture wiring (the v1 module)', () => {
  it('stores the token a Discord page sent, returns nothing from the listener, and writes it once', async () => {
    const api = installFakeDiscordApi();
    api.users.set(TOKEN, userPayload());
    await bootWorker(fake);
    const [result] = fake.onBeforeSendHeaders.dispatch(fake.discordRequest(TOKEN));
    expect(result).toBeUndefined();
    await waitFor(() => fake.session.peek(SESSION.token) === TOKEN);
    for (let i = 0; i < 50; i += 1) fake.captureToken(TOKEN);
    await settle();
    const writes = fake.session.set.mock.calls.filter(([items]) => SESSION.token in (items as object));
    expect(writes).toHaveLength(1);
    expect(typeof fake.session.peek(SESSION.tokenCapturedAt)).toBe('number');
  });

  it('ignores requests that did not come from a Discord page', async () => {
    installFakeDiscordApi();
    await bootWorker(fake);
    fake.captureToken(TOKEN, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop');
    fake.captureToken(TOKEN, 'https://example.com');
    fake.captureToken(TOKEN, 'https://discord.com.evil.example');
    await settle();
    expect(fake.session.has(SESSION.token)).toBe(false);
  });

  it('captures a token again after it was removed from storage', async () => {
    const api = installFakeDiscordApi();
    api.users.set(TOKEN, userPayload());
    await bootWorker(fake);
    fake.captureToken(TOKEN);
    await waitFor(() => fake.session.peek(SESSION.token) === TOKEN);
    await fake.session.remove([SESSION.token, SESSION.tokenCapturedAt]);
    await settle();
    fake.captureToken(TOKEN);
    await waitFor(() => fake.session.peek(SESSION.token) === TOKEN);
  });
});

describe('the authorization value never leaves session storage', () => {
  it('a whole session (login, list, job, history, notification) puts it nowhere else', async () => {
    const { popup } = await bootLoggedIn(fake);
    const content = fake.createContentScript(7);
    const engine = scriptedEngine();
    const harness = installEngine(fake, { runner: engine.runner });
    seedConsent(fake, { language: 'en' });

    await content.send({ to: 'bg', type: 'queue/toggle', target: guildTarget(CHANNEL_A) });
    await content.send({ to: 'bg', type: 'queue/toggle', target: dmTarget() });
    await popup.send({ to: 'bg', type: 'settings/patch', patch: { zipAll: true } });
    const jobId = await startJobWith(popup, engine);
    await engine.io!.progress(snapshot(engine.jobs[0], { [CHANNEL_A]: { status: 'done', fetched: 3 } }));
    await engine.io!.saveBlob(jobId, null, new Blob(['x']), 'Discord Export/a.zip');
    await engine.io!.saveUrl(jobId, DM_CHANNEL, 'https://cdn.discordapp.com/attachments/1/2/a.png', 'f/a.png');
    await engine.io!.itemDone(jobId, historyEntry(guildTarget(CHANNEL_A)), '77');
    await engine.io!.authError(jobId);
    await engine.io!.finished(jobId, 'done');
    await popup.send({ to: 'bg', type: 'status/get' });
    await settle();

    const everywhereElse = JSON.stringify({
      local: fake.local.dump(),
      session: Object.fromEntries(Object.entries(fake.session.dump()).filter(([key]) => key !== SESSION.token)),
      notifications: fake.notifications.created,
      downloads: fake.downloads.items,
      tabs: [fake.tabMessages, fake.tabsCreated, fake.tabUpdates],
      badge: fake.badge,
      console: consoleSpies.map((spy) => spy.mock.calls),
    });
    expect(everywhereElse).not.toContain(TOKEN);
    expect(everywhereElse).not.toContain(TOKEN.slice(0, 24));
    // the only message that carries it is the engine/run to the offscreen document
    const sendMessage = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
    const carriers = (sendMessage.mock.calls as unknown[][]).filter(([message]) => JSON.stringify(message).includes(TOKEN));
    expect(carriers.map(([message]) => (message as { type: string }).type)).toEqual(['engine/run']);
    expect(harness.revoked).toBeDefined();
  });

  it('and nothing is ever logged', async () => {
    const api = installFakeDiscordApi();
    api.users.set(TOKEN, userPayload());
    await bootWorker(fake);
    fake.captureToken(TOKEN);
    await waitFor(() => fake.session.peek(SESSION.account));
    fake.captureToken(OTHER_TOKEN); // a 401 path
    await waitFor(() => !fake.session.has(SESSION.token));
    await settle();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('storage.local keeps only the keys of the contract', async () => {
    const { popup } = await bootLoggedIn(fake);
    seedConsent(fake);
    await popup.send({ to: 'bg', type: 'queue/toggle', target: guildTarget(CHANNEL_A) });
    await popup.send({ to: 'bg', type: 'settings/patch', patch: { zipAll: true } });
    await settle();
    const allowed = [LOCAL.settings, LOCAL.queue('100000000000000001'), LOCAL.lastAccount];
    expect(fake.local.keys().sort()).toEqual([...new Set(allowed)].sort());
  });

  it('session storage keeps the contract keys plus the worker\'s one private record', async () => {
    const { popup } = await bootLoggedIn(fake);
    const content = fake.createContentScript(7);
    await content.send({ to: 'bg', type: 'inject/health', health: { ok: true, reason: null, checkedAt: 1, url: 'https://discord.com/channels/@me' } });
    await popup.send({ to: 'bg', type: 'status/get' });
    await settle();
    const contract: string[] = [SESSION.token, SESSION.tokenCapturedAt, SESSION.account, SESSION.job, SESSION.injectHealth];
    for (const key of fake.session.keys()) expect([...contract, 'dce.bg.state'], key).toContain(key);
  });
});
