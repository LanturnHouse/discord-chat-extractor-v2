import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL, SESSION } from '@/shared';
import { createFakeBrowser, EXTENSION_ID, EXTENSION_URL } from './fakeChrome';
import type { FakeBrowser, FakePage } from './fakeChrome';
import {
  ACCOUNT_ID,
  CHANNEL_A,
  GUILD_ID,
  OTHER_TOKEN,
  TOKEN,
  bootLoggedIn,
  bootWorker,
  exportSettings,
  guildTarget,
  installFakeDiscordApi,
  queueItem,
  seedGuildAccess,
  settle,
  storedQueue,
} from './helpers';
import type { FakeDiscordApi } from './helpers';

let fake: FakeBrowser;
let popup: FakePage;
let api: FakeDiscordApi;

beforeEach(async () => {
  fake = createFakeBrowser();
  ({ popup, api } = await bootLoggedIn(fake));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Calls the worker's onMessage listener directly with a hand-made sender, like Chrome does. */
async function callListener(message: unknown, sender: chrome.runtime.MessageSender) {
  const listener = fake.onMessage.listeners[0];
  const sendResponse = vi.fn();
  const returned = listener(message, sender, sendResponse);
  if (returned === true) await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
  return { returned, sendResponse, response: sendResponse.mock.calls[0]?.[0] };
}

const discordTab = { id: 7, url: 'https://discord.com/channels/@me', windowId: 1, active: true } as chrome.tabs.Tab;
const contentSender = (url = 'https://discord.com/channels/@me'): chrome.runtime.MessageSender => ({
  id: EXTENSION_ID,
  url,
  tab: { ...discordTab, url },
  frameId: 0,
});

describe('registration', () => {
  it('has exactly one onMessage listener, registered while the worker script runs', () => {
    expect(fake.onMessage.listeners).toHaveLength(1);
  });
});

describe('messages that are not for the background', () => {
  it.each([
    ['to content', { to: 'content', type: 'shortcut/toggleCurrent' }],
    ['to offscreen', { to: 'offscreen', type: 'engine/run' }],
    ['to the popup', { to: 'popup', type: 'x' }],
    ['without a `to`', { type: 'status/get' }],
    ['a string', 'status/get'],
    ['null', null],
    ['an array', ['bg']],
    ['a number', 5],
  ])('are ignored without an answer: %s', async (_label, message) => {
    const { returned, sendResponse } = await callListener(message, { id: EXTENSION_ID, url: `${EXTENSION_URL}popup.html` });
    expect(returned).toBe(false);
    await settle();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('a message to the offscreen document sent through the popup\'s channel does not get an answer from the worker', async () => {
    const offscreen = fake.createPage({ kind: 'offscreen' });
    const listener = vi.fn(() => false);
    offscreen.runtime.onMessage.addListener(listener);
    await expect(popup.send({ to: 'offscreen', type: 'engine/revoke', url: 'blob:x' })).resolves.toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('answering', () => {
  it('says synchronously that the answer comes later and answers with the BgResponse envelope', async () => {
    const { returned, response } = await callListener({ to: 'bg', type: 'status/get' }, { id: EXTENSION_ID, url: `${EXTENSION_URL}popup.html` });
    expect(returned).toBe(true);
    expect(response).toMatchObject({ ok: true, data: { discordTabs: 0 } });
  });

  it('refuses an unknown type and a missing type from an extension page', async () => {
    await expect(popup.send({ to: 'bg', type: 'nope' })).resolves.toEqual({ ok: false, error: 'invalid', message: 'unknown message type' });
    await expect(popup.send({ to: 'bg' })).resolves.toEqual({ ok: false, error: 'invalid', message: 'message has no type' });
    await expect(popup.send({ to: 'bg', type: 5 })).resolves.toEqual({ ok: false, error: 'invalid', message: 'message has no type' });
  });

  it('turns an exception in a handler into { ok: false, error: "unknown" } without leaking secrets', async () => {
    fake.session.get.mockRejectedValueOnce(new Error(`storage exploded near ${TOKEN}`));
    const response = (await popup.send({ to: 'bg', type: 'status/get' })) as { ok: boolean; error: string; message: string };
    expect(response).toMatchObject({ ok: false, error: 'unknown' });
    expect(response.message).not.toContain(TOKEN);
    expect(response.message).toContain('[redacted]');
  });

  it('does not throw when the sender is gone before the answer is ready', async () => {
    const listener = fake.onMessage.listeners[0];
    const sendResponse = vi.fn(() => {
      throw new Error('The message port closed before a response was received.');
    });
    expect(listener({ to: 'bg', type: 'status/get' }, { id: EXTENSION_ID, url: `${EXTENSION_URL}popup.html` }, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    await settle();
  });
});

describe('who may send (docs/PLAN.md §8)', () => {
  const contentAllowed = [
    { type: 'queue/toggle', target: guildTarget() },
    { type: 'queue/addCategory', guildId: '1', guildName: 'g', categoryId: '2', categoryName: 'c' },
    { type: 'queue/addGuild', guildId: '1', guildName: 'g' },
    { type: 'queue/groupInfo', guildId: '1', guildName: 'g' },
    { type: 'inject/health', health: { ok: true, reason: null, checkedAt: 1, url: 'https://discord.com/channels/@me' } },
  ];
  const popupOnly = [
    { type: 'queue/upsert', item: {} },
    { type: 'queue/setGroupSettings', kind: 'guild', guildId: GUILD_ID, groupId: GUILD_ID, settings: null },
    { type: 'queue/remove', key: CHANNEL_A },
    { type: 'queue/removeMany', keys: [CHANNEL_A] },
    { type: 'queue/clear' },
    { type: 'settings/patch', patch: { showButtons: false } },
    { type: 'job/start', keys: 'all' },
    { type: 'job/cancel' },
    { type: 'history/rerun', id: 'x' },
    { type: 'history/clear' },
    { type: 'downloads/show', downloadId: null },
    { type: 'discord/open' },
    { type: 'status/get' },
  ];
  const engineMessages = [
    { type: 'engine/ready' },
    { type: 'engine/keepalive', jobId: 'j' },
    { type: 'engine/authError', jobId: 'j' },
    { type: 'engine/progress', job: {} },
    { type: 'engine/saveBlob', jobId: 'j', itemKey: null, url: 'blob:x', filename: 'a.html' },
    { type: 'engine/saveUrl', jobId: 'j', itemKey: CHANNEL_A, url: 'https://cdn.discordapp.com/a', filename: 'a.png' },
    { type: 'engine/itemDone', jobId: 'j', entry: {}, lastMessageId: null },
    { type: 'engine/finished', jobId: 'j', state: 'done' },
  ];
  const refused = { ok: false, error: 'invalid' };

  it.each(['https://discord.com/channels/@me', 'https://ptb.discord.com/channels/@me', 'https://canary.discord.com/channels/1/2'])(
    'a content script on %s may send the five content messages',
    async (url) => {
      const page = fake.createContentScript(9, url);
      for (const message of contentAllowed) {
        const response = (await page.send({ to: 'bg', ...message })) as { ok: boolean; error?: string; message?: string };
        expect(response.message).not.toBe('sender not allowed');
        expect(response.message).not.toBe('sender not allowed for this message');
      }
    },
  );

  it.each(popupOnly.map((message) => [message.type, message] as const))('a content script may NOT send %s', async (_type, message) => {
    const page = fake.createContentScript(9);
    await expect(page.send({ to: 'bg', ...message })).resolves.toMatchObject({ ...refused, message: 'sender not allowed for this message' });
  });

  it.each(engineMessages.map((message) => [message.type, message] as const))('a content script may NOT send %s', async (_type, message) => {
    const page = fake.createContentScript(9);
    await expect(page.send({ to: 'bg', ...message })).resolves.toMatchObject({ ...refused, message: 'sender not allowed for this message' });
  });

  it.each(engineMessages.map((message) => [message.type, message] as const))('the popup may NOT send the engine message %s', async (_type, message) => {
    await expect(popup.send({ to: 'bg', ...message })).resolves.toMatchObject({ ...refused, message: 'sender not allowed for this message' });
  });

  it.each(popupOnly.map((message) => [message.type, message] as const))('the offscreen document may NOT send %s', async (_type, message) => {
    const offscreen = fake.createPage({ kind: 'offscreen' });
    await expect(offscreen.send({ to: 'bg', ...message })).resolves.toMatchObject({ ...refused, message: 'sender not allowed for this message' });
  });

  it.each(contentAllowed.map((message) => [message.type, message] as const))('the offscreen document may NOT send %s', async (_type, message) => {
    const offscreen = fake.createPage({ kind: 'offscreen' });
    await expect(offscreen.send({ to: 'bg', ...message })).resolves.toMatchObject({ ...refused, message: 'sender not allowed for this message' });
  });

  it('the offscreen document may send engine messages, and the popup everything else', async () => {
    const offscreen = fake.createPage({ kind: 'offscreen' });
    await expect(offscreen.send({ to: 'bg', type: 'engine/ready' })).resolves.toEqual({ ok: true });
    await expect(offscreen.send({ to: 'bg', type: 'engine/keepalive', jobId: 'j' })).resolves.toEqual({ ok: true });
    await expect(popup.send({ to: 'bg', type: 'status/get' })).resolves.toMatchObject({ ok: true });
    await expect(popup.send({ to: 'bg', type: 'queue/toggle', target: guildTarget() })).resolves.toEqual({ ok: true, data: { queued: true } });
  });

  it('queue/addGuild (the server button): a content script and the popup may send it, and it is really handled', async () => {
    api.guildChannels.set(GUILD_ID, [{ id: CHANNEL_A, type: 0, name: 'general', parent_id: null, position: 0 }]);
    seedGuildAccess(api);
    const page = fake.createContentScript(9, `https://discord.com/channels/${GUILD_ID}/${CHANNEL_A}`);
    const guild = { to: 'bg', type: 'queue/addGuild', guildId: GUILD_ID, guildName: 'Test Server' };
    await expect(page.send(guild)).resolves.toEqual({ ok: true, data: { added: 1, skipped: 0, removed: 0 } });
    expect(storedQueue(fake).map((item) => item.key)).toEqual([CHANNEL_A]);
    await expect(popup.send(guild)).resolves.toEqual({ ok: true, data: { added: 0, skipped: 0, removed: 1 } }); // a toggle: everything is in, so it all goes
    expect(storedQueue(fake)).toEqual([]);
  });

  it('queue/groupInfo: a content script and the popup may send it, and it is really handled (the groups of the guild are stored)', async () => {
    api.guildChannels.set(GUILD_ID, [{ id: CHANNEL_A, type: 0, name: 'general', parent_id: null, position: 0 }]);
    seedGuildAccess(api);
    const page = fake.createContentScript(9, `https://discord.com/channels/${GUILD_ID}/${CHANNEL_A}`);
    const info = { to: 'bg', type: 'queue/groupInfo', guildId: GUILD_ID, guildName: 'Test Server' };
    await expect(page.send(info)).resolves.toEqual({ ok: true });
    expect(fake.local.peek<Record<string, { channelIds: string[] }>>(LOCAL.groups(ACCOUNT_ID))?.[GUILD_ID].channelIds).toEqual([CHANNEL_A]);
    await expect(popup.send(info)).resolves.toEqual({ ok: true });
    expect(storedQueue(fake)).toEqual([]); // it never touches the list
  });

  it.each([
    ['another extension', { id: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', url: `${EXTENSION_URL}popup.html` }],
    ['a content script on a lookalike host', { id: EXTENSION_ID, url: 'https://discord.com.evil.example/channels', tab: discordTab }],
    ['a content script on the CDN', { id: EXTENSION_ID, url: 'https://cdn.discordapp.com/x', tab: discordTab }],
    ['a Discord URL without a tab', { id: EXTENSION_ID, url: 'https://discord.com/channels/@me' }],
  ] as Array<[string, chrome.runtime.MessageSender]>)('refuses queue/groupInfo from %s, without any request to Discord', async (_label, sender) => {
    const calls = api.calls.length;
    const { response } = await callListener({ to: 'bg', type: 'queue/groupInfo', guildId: GUILD_ID, guildName: 'Test Server' }, sender);
    expect(response).toEqual({ ok: false, error: 'invalid', message: 'sender not allowed' });
    expect(api.calls).toHaveLength(calls);
    expect(fake.local.has(LOCAL.groups(ACCOUNT_ID))).toBe(false);
  });

  it.each([
    ['another extension', { id: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', url: `${EXTENSION_URL}popup.html` }],
    ['a content script on a lookalike host', { id: EXTENSION_ID, url: 'https://discord.com.evil.example/channels', tab: discordTab }],
    ['a content script on the CDN', { id: EXTENSION_ID, url: 'https://cdn.discordapp.com/x', tab: discordTab }],
    ['a Discord URL without a tab', { id: EXTENSION_ID, url: 'https://discord.com/channels/@me' }],
  ] as Array<[string, chrome.runtime.MessageSender]>)('refuses queue/addGuild from %s, without any request to Discord', async (_label, sender) => {
    const calls = api.calls.length;
    const { response } = await callListener({ to: 'bg', type: 'queue/addGuild', guildId: GUILD_ID, guildName: 'Test Server' }, sender);
    expect(response).toEqual({ ok: false, error: 'invalid', message: 'sender not allowed' });
    expect(api.calls).toHaveLength(calls);
    expect(storedQueue(fake)).toEqual([]);
  });

  describe('queue/setGroupSettings and queue/removeMany (5th change): extension pages only', () => {
    const setSettings = { to: 'bg', type: 'queue/setGroupSettings', kind: 'guild', guildId: GUILD_ID, groupId: GUILD_ID, settings: exportSettings({ count: 7 }) };
    const removeAll = { to: 'bg', type: 'queue/removeMany', keys: [CHANNEL_A] };

    beforeEach(() => {
      fake.local.seed({ [LOCAL.queue(ACCOUNT_ID)]: [queueItem(guildTarget(CHANNEL_A), { settings: exportSettings({ format: 'csv' }) })] });
    });

    it.each(['https://discord.com/channels/@me', 'https://ptb.discord.com/channels/@me', 'https://canary.discord.com/channels/1/2'])(
      'a content script on %s is refused, and nothing is changed',
      async (url) => {
        const page = fake.createContentScript(9, url);
        await expect(page.send(setSettings)).resolves.toEqual({ ok: false, error: 'invalid', message: 'sender not allowed for this message' });
        await expect(page.send(removeAll)).resolves.toEqual({ ok: false, error: 'invalid', message: 'sender not allowed for this message' });
        expect(fake.local.has(LOCAL.groupSettings(ACCOUNT_ID))).toBe(false);
        expect(storedQueue(fake)).toEqual([queueItem(guildTarget(CHANNEL_A), { settings: exportSettings({ format: 'csv' }) })]);
      },
    );

    it('the offscreen document is refused, and so is a sender that is nobody we talk to', async () => {
      const offscreen = fake.createPage({ kind: 'offscreen' });
      for (const message of [setSettings, removeAll]) {
        await expect(offscreen.send(message)).resolves.toMatchObject({ ok: false, error: 'invalid', message: 'sender not allowed for this message' });
      }
      for (const sender of [
        { id: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', url: `${EXTENSION_URL}popup.html` },
        { id: EXTENSION_ID, url: 'https://discord.com.evil.example/channels', tab: discordTab },
        { id: EXTENSION_ID, url: 'https://discord.com/channels/@me' }, // a Discord URL without a tab
      ] as chrome.runtime.MessageSender[]) {
        for (const message of [setSettings, removeAll]) {
          const { response } = await callListener(message, sender);
          expect(response).toEqual({ ok: false, error: 'invalid', message: 'sender not allowed' });
        }
      }
      expect(fake.local.has(LOCAL.groupSettings(ACCOUNT_ID))).toBe(false);
      expect(storedQueue(fake)).toHaveLength(1);
    });

    it('the popup and an extension page in a tab may send them, and they are really handled', async () => {
      await expect(popup.send(setSettings)).resolves.toEqual({ ok: true, data: { cleared: 1 } });
      expect(fake.local.peek(LOCAL.groupSettings(ACCOUNT_ID))).toEqual({ [GUILD_ID]: exportSettings({ count: 7 }) });
      const page = fake.createPage({ kind: 'extension-tab', url: 'popup.html' });
      await expect(page.send(removeAll)).resolves.toEqual({ ok: true, data: { removed: 1 } });
      expect(storedQueue(fake)).toEqual([]);
      expect(fake.local.peek(LOCAL.groupSettings(ACCOUNT_ID))).toEqual({}); // the last channel of the server left: its settings went with it
    });
  });

  it('an extension page opened in a tab counts as an extension page, not as a content script', async () => {
    const page = fake.createPage({ kind: 'extension-tab', url: 'popup.html' });
    await expect(page.send({ to: 'bg', type: 'status/get' })).resolves.toMatchObject({ ok: true });
    await expect(page.send({ to: 'bg', type: 'queue/clear' })).resolves.toEqual({ ok: true });
  });

  it.each([
    ['another extension', { id: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', url: `${EXTENSION_URL}popup.html` }],
    ['no extension id', { url: `${EXTENSION_URL}popup.html` }],
    ['no url', { id: EXTENSION_ID }],
    ['a content script on another site', { id: EXTENSION_ID, url: 'https://example.com/', tab: discordTab }],
    ['a content script on a lookalike host', { id: EXTENSION_ID, url: 'https://discord.com.evil.example/channels', tab: discordTab }],
    ['a content script on a lookalike domain', { id: EXTENSION_ID, url: 'https://evildiscord.com/channels', tab: discordTab }],
    ['a content script over http', { id: EXTENSION_ID, url: 'http://discord.com/channels', tab: discordTab }],
    ['a content script on the CDN', { id: EXTENSION_ID, url: 'https://cdn.discordapp.com/x', tab: discordTab }],
    ['a content script on the support site', { id: EXTENSION_ID, url: 'https://support.discord.com/', tab: discordTab }],
    ['a Discord URL without a tab', { id: EXTENSION_ID, url: 'https://discord.com/channels/@me' }],
    ['a page of another extension', { id: EXTENSION_ID, url: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/popup.html' }],
    ['garbage as the url', { id: EXTENSION_ID, url: 'not a url', tab: discordTab }],
  ] as Array<[string, chrome.runtime.MessageSender]>)('refuses a message from %s', async (_label, sender) => {
    const { returned, response } = await callListener({ to: 'bg', type: 'queue/toggle', target: guildTarget() }, sender);
    expect(returned).toBe(true);
    expect(response).toEqual({ ok: false, error: 'invalid', message: 'sender not allowed' });
    expect(storedQueue(fake)).toEqual([]);
  });

  it('accepts the three Discord origins for content scripts, and only those', async () => {
    for (const url of ['https://discord.com/channels/@me', 'https://ptb.discord.com/app', 'https://canary.discord.com/']) {
      const { response } = await callListener({ to: 'bg', type: 'queue/toggle', target: guildTarget() }, contentSender(url));
      expect(response).toMatchObject({ ok: true });
    }
  });

  it('judges a content script by the URL of the page, not by what the message says', async () => {
    const { response } = await callListener(
      { to: 'bg', type: 'queue/toggle', target: guildTarget(), sender: { url: 'https://discord.com' }, url: 'https://discord.com' },
      { id: EXTENSION_ID, url: 'https://example.com/https://discord.com/', tab: discordTab },
    );
    expect(response).toEqual({ ok: false, error: 'invalid', message: 'sender not allowed' });
  });
});

describe('no authorization value ever leaves the worker through the router', () => {
  it('status/get and every refusal are free of it', async () => {
    const responses = [
      await popup.send({ to: 'bg', type: 'status/get' }),
      await popup.send({ to: 'bg', type: 'nope' }),
      await fake.createContentScript(9).send({ to: 'bg', type: 'queue/clear' }),
    ];
    for (const response of responses) {
      expect(JSON.stringify(response)).not.toContain(TOKEN);
      expect(JSON.stringify(response)).not.toContain(OTHER_TOKEN);
    }
    expect(fake.session.peek(SESSION.token)).toBe(TOKEN);
    expect(JSON.stringify(fake.local.dump())).not.toContain(TOKEN);
    expect(fake.local.has(LOCAL.queue('x'))).toBe(false);
  });
});

describe('a worker without an account', () => {
  it('still answers status/get and settings messages', async () => {
    const other = createFakeBrowser();
    installFakeDiscordApi();
    await bootWorker(other);
    const page = other.createPage({ kind: 'popup' });
    await expect(page.send({ to: 'bg', type: 'status/get' })).resolves.toEqual({
      ok: true,
      data: { account: null, lastAccount: null, discordTabs: 0, health: null, job: null },
    });
  });
});
