import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL, SESSION } from '@/shared';
import { createFakeBrowser } from './fakeChrome';
import type { FakeBrowser, FakePage } from './fakeChrome';
import {
  ACCOUNT_ID,
  CATEGORY_ID,
  GUILD_ID,
  TOKEN,
  bootWorker,
  guildTarget,
  installFakeDiscordApi,
  seedGuildAccess,
  settle,
  userPayload,
  waitFor,
} from './helpers';
import type { FakeDiscordApi } from './helpers';

let fake: FakeBrowser;
let api: FakeDiscordApi;
let popup: FakePage;
let content: FakePage;

/** The worker is up, the user has NOT agreed yet, and Discord knows the token. */
beforeEach(async () => {
  fake = createFakeBrowser();
  api = installFakeDiscordApi();
  api.users.set(TOKEN, userPayload(ACCOUNT_ID));
  seedGuildAccess(api);
  await bootWorker(fake, { agreed: false });
  popup = fake.createPage({ kind: 'popup' });
  content = fake.createContentScript(7, `https://discord.com/channels/${GUILD_ID}/1`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const agree = () => popup.send({ to: 'bg', type: 'settings/patch', patch: { consentAt: 1_760_000_000_000 } });
const withdraw = () => popup.send({ to: 'bg', type: 'settings/patch', patch: { consentAt: null } });

describe('before the user has agreed: nothing is read from Discord', () => {
  it('the authorization of the page is not stored, and Discord is not asked whose it is', async () => {
    fake.captureToken(TOKEN);
    await settle();
    expect(fake.session.has(SESSION.token)).toBe(false);
    expect(fake.session.has(SESSION.tokenCapturedAt)).toBe(false);
    expect(api.calls).toEqual([]);
  });

  it('the buttons of the page get "no-consent", and no server list is loaded', async () => {
    await expect(content.send({ to: 'bg', type: 'queue/toggle', target: guildTarget() })).resolves.toEqual({ ok: false, error: 'no-consent' });
    await expect(content.send({ to: 'bg', type: 'queue/addGuild', guildId: GUILD_ID, guildName: 'Sample' })).resolves.toEqual({ ok: false, error: 'no-consent' });
    await expect(
      content.send({ to: 'bg', type: 'queue/addCategory', guildId: GUILD_ID, guildName: 'Sample', categoryId: CATEGORY_ID, categoryName: 'Chat' }),
    ).resolves.toEqual({ ok: false, error: 'no-consent' });
    await expect(content.send({ to: 'bg', type: 'queue/groupInfo', guildId: GUILD_ID, guildName: 'Sample' })).resolves.toEqual({ ok: false, error: 'no-consent' });
    expect(api.calls).toEqual([]);
  });

  it('a message that is not even valid is still refused as invalid, not as a missing consent', async () => {
    await expect(content.send({ to: 'bg', type: 'queue/groupInfo', guildId: 'x' })).resolves.toMatchObject({ ok: false, error: 'invalid' });
  });
});

describe('agreeing', () => {
  it('opens the gate: the next request of the page is captured and its account verified', async () => {
    fake.captureToken(TOKEN);
    await settle();
    expect(fake.session.has(SESSION.token)).toBe(false);

    await expect(agree()).resolves.toMatchObject({ ok: true });
    await settle();
    fake.captureToken(TOKEN); // Discord's page sends requests all the time
    await waitFor(() => fake.session.peek(SESSION.account));
    expect(fake.session.peek(SESSION.token)).toBe(TOKEN);
    expect(api.calls.map((call) => call.url)).toEqual([expect.stringContaining('/users/@me')]);
    await expect(content.send({ to: 'bg', type: 'queue/toggle', target: guildTarget() })).resolves.toEqual({ ok: true, data: { queued: true } });
  });
});

describe('withdrawing the consent', () => {
  it('removes the authorization and the account at once, and nothing is captured again', async () => {
    await agree();
    await settle();
    fake.captureToken(TOKEN);
    await waitFor(() => fake.session.peek(SESSION.account));
    api.calls.length = 0;

    await expect(withdraw()).resolves.toMatchObject({ ok: true });
    await waitFor(() => !fake.session.has(SESSION.token));
    await waitFor(() => fake.session.peek(SESSION.account) === null);
    expect(fake.local.peek(LOCAL.settings)).toMatchObject({ consentAt: null });

    fake.captureToken(TOKEN);
    await settle();
    expect(fake.session.has(SESSION.token)).toBe(false);
    expect(api.calls).toEqual([]);
    await expect(content.send({ to: 'bg', type: 'queue/toggle', target: guildTarget() })).resolves.toEqual({ ok: false, error: 'no-consent' });
  });
});

describe('a worker that starts after the user has agreed', () => {
  it('reads the agreement from storage before it looks at the first request', async () => {
    const other = createFakeBrowser();
    api.users.set(TOKEN, userPayload(ACCOUNT_ID));
    other.local.seed({ [LOCAL.settings]: { consentAt: 1_700_000_000_000 } });
    await bootWorker(other);
    other.captureToken(TOKEN);
    await waitFor(() => other.session.peek(SESSION.account));
    expect(other.session.peek(SESSION.token)).toBe(TOKEN);
  });
});
