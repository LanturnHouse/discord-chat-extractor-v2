/** The keyboard shortcut (#15): `add-current-chat` asks the content script of the Discord tab in front to toggle its chat. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBrowser } from './fakeChrome';
import type { FakeBrowser } from './fakeChrome';
import { bootWorker, installFakeDiscordApi, settle } from './helpers';

let fake: FakeBrowser;

beforeEach(async () => {
  fake = createFakeBrowser();
  installFakeDiscordApi();
  await bootWorker(fake);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const toggleMessage = { to: 'content', type: 'shortcut/toggleCurrent' };
const press = async (command: string, tab?: unknown) => {
  fake.onCommand.dispatch(command, tab);
  await settle();
};

describe('chrome.commands.onCommand', () => {
  it('is registered while the worker script runs', () => {
    expect(fake.onCommand.listeners).toHaveLength(1);
  });

  it('sends shortcut/toggleCurrent to the content script of the active Discord tab', async () => {
    fake.tabs = [
      { id: 3, url: 'https://discord.com/channels/1/2', windowId: 1, active: true },
      { id: 4, url: 'https://discord.com/channels/1/3', windowId: 1, active: false },
    ];
    const content = fake.createContentScript(3, 'https://discord.com/channels/1/2');
    const received = vi.fn(() => false);
    content.runtime.onMessage.addListener(received);
    await press('add-current-chat');
    expect(fake.tabMessages).toEqual([{ tabId: 3, message: toggleMessage }]);
    expect(received).toHaveBeenCalledWith(toggleMessage, expect.anything(), expect.anything());
  });

  it('uses the tab Chrome hands over when it is a Discord tab', async () => {
    fake.tabs = [{ id: 9, url: 'https://discord.com/channels/@me', windowId: 1, active: true }];
    await press('add-current-chat', { id: 9, url: 'https://discord.com/channels/@me', active: true });
    expect(fake.tabMessages).toEqual([{ tabId: 9, message: toggleMessage }]);
    expect(vi.mocked(chrome.tabs.query)).not.toHaveBeenCalled();
  });

  it.each(['https://discord.com/channels/@me', 'https://ptb.discord.com/channels/1/2', 'https://canary.discord.com/app'])('works on %s', async (url) => {
    fake.tabs = [{ id: 5, url, windowId: 1, active: true }];
    await press('add-current-chat');
    expect(fake.tabMessages.map((entry) => entry.tabId)).toEqual([5]);
  });

  it('asks the active tab of the window in front when Chrome gives no tab', async () => {
    fake.tabs = [
      { id: 1, url: 'https://discord.com/channels/@me', windowId: 2, active: true }, // another window
      { id: 2, url: 'https://discord.com/channels/9/9', windowId: 1, active: true },
      { id: 3, url: 'https://discord.com/channels/9/8', windowId: 1, active: false },
    ];
    await press('add-current-chat');
    expect(vi.mocked(chrome.tabs.query)).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(fake.tabMessages.map((entry) => entry.tabId)).toEqual([2]);
  });

  it('falls back to the active tab when the tab it was given is not a Discord page', async () => {
    fake.tabs = [{ id: 2, url: 'https://discord.com/channels/9/9', windowId: 1, active: true }];
    await press('add-current-chat', { id: 77, url: 'https://example.com/', active: true });
    expect(fake.tabMessages.map((entry) => entry.tabId)).toEqual([2]);
  });

  it.each([
    ['another site', 'https://www.youtube.com/watch?v=1'],
    ['a lookalike host', 'https://discord.com.evil.example/channels/1/2'],
    ['a lookalike domain', 'https://evildiscord.com/'],
    ['the support site', 'https://support.discord.com/'],
    ['plain http', 'http://discord.com/channels/@me'],
    ['a page without a visible URL', undefined],
  ])('does nothing on %s', async (_label, url) => {
    fake.tabs = [{ id: 6, url, windowId: 1, active: true }];
    await press('add-current-chat', fake.tabs[0]);
    expect(fake.tabMessages).toEqual([]);
  });

  it('does nothing when there is no active tab at all', async () => {
    fake.tabs = [];
    await press('add-current-chat');
    expect(fake.tabMessages).toEqual([]);
  });

  it('ignores other commands', async () => {
    fake.tabs = [{ id: 3, url: 'https://discord.com/channels/1/2', windowId: 1, active: true }];
    await press('something-else', fake.tabs[0]);
    await press('', fake.tabs[0]);
    expect(fake.tabMessages).toEqual([]);
  });

  it('does not fail when the tab has no content script (opened before the extension was installed)', async () => {
    fake.tabs = [{ id: 3, url: 'https://discord.com/channels/1/2', windowId: 1, active: true }];
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    await press('add-current-chat', fake.tabs[0]);
    process.off('unhandledRejection', unhandled);
    expect(fake.tabMessages).toHaveLength(1); // it tried; the rejection was swallowed
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('does not fail when asking for the active tab fails', async () => {
    vi.mocked(chrome.tabs.query).mockRejectedValueOnce(new Error('No current window'));
    await press('add-current-chat');
    expect(fake.tabMessages).toEqual([]);
  });

  it('a tab without an id cannot be messaged', async () => {
    await press('add-current-chat', { url: 'https://discord.com/channels/@me' });
    expect(fake.tabMessages).toEqual([]);
  });
});
