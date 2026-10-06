import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL, SESSION } from '@/shared';
import type { AccountInfo } from '@/shared';
import { apiGet } from '@/background/discordApi';
import { avatarUrl, defaultAvatarUrl, parseAccountInfo } from '@/background/account';
import { createFakeBrowser } from './fakeChrome';
import type { FakeBrowser } from './fakeChrome';
import { ACCOUNT_ID, OTHER_ACCOUNT_ID, OTHER_TOKEN, TOKEN, bootWorker, installFakeDiscordApi, settle, userPayload, waitFor } from './helpers';
import type { FakeDiscordApi } from './helpers';

let fake: FakeBrowser;
let api: FakeDiscordApi;
let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
  fake = createFakeBrowser();
  api = installFakeDiscordApi();
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const sessionAccount = () => fake.session.peek<AccountInfo | null>(SESSION.account);
const userCalls = () => api.calls.filter((call) => call.url.endsWith('/api/v9/users/@me'));

describe('account verification', () => {
  it('asks Discord whose the captured token is (direct GET, no cookies) and stores the account', async () => {
    api.users.set(TOKEN, userPayload(ACCOUNT_ID, { username: 'tester', global_name: 'Test Er', avatar: 'a1b2c3' }));
    await bootWorker(fake);
    fake.captureToken(TOKEN);
    await waitFor(sessionAccount);

    expect(userCalls()).toHaveLength(1);
    expect(userCalls()[0]).toMatchObject({
      url: 'https://discord.com/api/v9/users/@me',
      method: 'GET',
      credentials: 'omit',
      headers: { Authorization: TOKEN },
    });
    const expected: AccountInfo = {
      id: ACCOUNT_ID,
      username: 'tester',
      globalName: 'Test Er',
      avatarUrl: `https://cdn.discordapp.com/avatars/${ACCOUNT_ID}/a1b2c3.png?size=128`,
    };
    expect(sessionAccount()).toEqual(expected);
    expect(fake.local.peek(LOCAL.lastAccount)).toEqual(expected);
  });

  it('sends nothing but the Authorization (and Accept) header: no cookies, no client forgery', async () => {
    api.users.set(TOKEN, userPayload());
    await bootWorker(fake);
    fake.captureToken(TOKEN);
    await waitFor(sessionAccount);
    expect(Object.keys(userCalls()[0].headers).sort()).toEqual(['Accept', 'Authorization']);
  });

  it('uses the default CDN avatar (index from the id) when the user has none, and null for a missing display name', async () => {
    api.users.set(TOKEN, userPayload(ACCOUNT_ID, { avatar: null, global_name: null }));
    await bootWorker(fake);
    fake.captureToken(TOKEN);
    const account = (await waitFor(sessionAccount)) as AccountInfo;
    const index = Number((BigInt(ACCOUNT_ID) >> 22n) % 6n);
    expect(account.avatarUrl).toBe(`https://cdn.discordapp.com/embed/avatars/${index}.png`);
    expect(account.globalName).toBeNull();
  });

  it('computes the avatar URLs like the plan says', () => {
    for (const id of ['1', '4194304', '8388608', '25165824', '100000000000000001', '987654321098765432']) {
      expect(defaultAvatarUrl(id)).toBe(`https://cdn.discordapp.com/embed/avatars/${Number((BigInt(id) >> 22n) % 6n)}.png`);
    }
    expect(defaultAvatarUrl('4194304')).toBe('https://cdn.discordapp.com/embed/avatars/1.png');
    expect(avatarUrl('1', 'abc')).toBe('https://cdn.discordapp.com/avatars/1/abc.png?size=128');
    expect(avatarUrl('1', 'a_animated')).toBe('https://cdn.discordapp.com/avatars/1/a_animated.png?size=128');
  });

  it('parseAccountInfo accepts a users/@me answer and refuses junk', () => {
    expect(parseAccountInfo(userPayload('7', { avatar: 'hash' }))).toEqual({ id: '7', username: 'tester', globalName: 'Tester', avatarUrl: 'https://cdn.discordapp.com/avatars/7/hash.png?size=128' });
    for (const raw of [null, 'x', [], {}, { id: 'abc', username: 'x' }, { id: '7' }, { id: '7', username: '' }, { id: 7, username: 'x' }]) {
      expect(parseAccountInfo(raw)).toBeNull();
    }
    // an avatar hash that could change the URL is not used
    expect(parseAccountInfo(userPayload('7', { avatar: '../../evil' }))?.avatarUrl).toBe(defaultAvatarUrl('7'));
    expect(parseAccountInfo(userPayload('7', { username: 'u'.repeat(300) }))?.username).toHaveLength(100);
  });

  it('keeps the account out of the wire format of the token: the stored account has only the contract fields', async () => {
    api.users.set(TOKEN, userPayload(ACCOUNT_ID, { email: 'private@example.com', phone: '+100', mfa_enabled: true }));
    await bootWorker(fake);
    fake.captureToken(TOKEN);
    await waitFor(sessionAccount);
    expect(Object.keys(sessionAccount() as object).sort()).toEqual(['avatarUrl', 'globalName', 'id', 'username']);
    expect(JSON.stringify(fake.local.dump())).not.toContain('private@example.com');
    expect(JSON.stringify(fake.session.dump())).not.toContain('private@example.com');
  });

  it('a token that is not on Discord\'s side valid (401) is removed with compare-and-clear and the account is null', async () => {
    await bootWorker(fake);
    fake.captureToken(TOKEN); // unknown to the fake API: 401
    await waitFor(() => !fake.session.has(SESSION.token));
    await settle();
    expect(fake.session.has(SESSION.tokenCapturedAt)).toBe(false);
    expect(sessionAccount()).toBeNull();
    expect(userCalls()).toHaveLength(1);
  });

  it('a 401 keeps the last known account in LOCAL.lastAccount', async () => {
    api.users.set(TOKEN, userPayload());
    await bootWorker(fake);
    fake.captureToken(TOKEN);
    await waitFor(sessionAccount);
    api.users.delete(TOKEN);
    fake.captureToken(OTHER_TOKEN); // another (invalid) value replaces it
    await waitFor(() => !fake.session.has(SESSION.token));
    await settle();
    expect(sessionAccount()).toBeNull();
    expect((fake.local.peek(LOCAL.lastAccount) as AccountInfo).id).toBe(ACCOUNT_ID);
  });

  it('a 401 for an OLD value does not remove a NEWER capture', async () => {
    api.users.set(OTHER_TOKEN, userPayload(OTHER_ACCOUNT_ID, { username: 'second' }));
    let release: () => void = () => undefined;
    api.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await bootWorker(fake);
    fake.captureToken(TOKEN); // unknown: will get a 401, but the answer is held back
    await waitFor(() => userCalls().length === 1);
    fake.captureToken(OTHER_TOKEN); // a newer capture arrives while the first check is in flight
    await waitFor(() => fake.session.peek(SESSION.token) === OTHER_TOKEN);
    release();
    await waitFor(() => (sessionAccount() as AccountInfo | null)?.id === OTHER_ACCOUNT_ID);
    expect(fake.session.peek(SESSION.token)).toBe(OTHER_TOKEN);
    expect((sessionAccount() as AccountInfo).username).toBe('second');
  });

  it('while the verdict for a NEW token is pending the account is null, never the previous user\'s', async () => {
    api.users.set(TOKEN, userPayload(ACCOUNT_ID));
    api.users.set(OTHER_TOKEN, userPayload(OTHER_ACCOUNT_ID));
    await bootWorker(fake);
    fake.captureToken(TOKEN);
    await waitFor(sessionAccount);
    let release: () => void = () => undefined;
    api.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.captureToken(OTHER_TOKEN);
    await waitFor(() => userCalls().length === 2);
    expect(sessionAccount()).toBeNull();
    release();
    await waitFor(() => (sessionAccount() as AccountInfo | null)?.id === OTHER_ACCOUNT_ID);
    expect((fake.local.peek(LOCAL.lastAccount) as AccountInfo).id).toBe(OTHER_ACCOUNT_ID);
  });

  it('a verdict for a token that was replaced meanwhile is discarded', async () => {
    api.users.set(TOKEN, userPayload(ACCOUNT_ID, { username: 'first' }));
    api.users.set(OTHER_TOKEN, userPayload(OTHER_ACCOUNT_ID, { username: 'second' }));
    let release: () => void = () => undefined;
    api.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await bootWorker(fake);
    fake.captureToken(TOKEN);
    await waitFor(() => userCalls().length === 1);
    fake.captureToken(OTHER_TOKEN);
    await waitFor(() => fake.session.peek(SESSION.token) === OTHER_TOKEN);
    release();
    await waitFor(() => (sessionAccount() as AccountInfo | null)?.id === OTHER_ACCOUNT_ID);
    await settle();
    expect((sessionAccount() as AccountInfo).username).toBe('second');
  });

  it('keeps the token and stays "not verified" on network errors, 429 and 5xx', async () => {
    api.users.set(TOKEN, userPayload());
    for (const force of ['network', 429, 500] as const) {
      fake = createFakeBrowser();
      api.calls.length = 0;
      api.force = force;
      await bootWorker(fake);
      fake.captureToken(TOKEN);
      await waitFor(() => userCalls().length === 1);
      await settle();
      expect(fake.session.peek(SESSION.token)).toBe(TOKEN);
      expect(sessionAccount()).toBeNull();
    }
  });

  it('retries a missing account when the popup asks for the status (throttled to once per 10 s)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
    api.users.set(TOKEN, userPayload());
    api.force = 'network';
    await bootWorker(fake);
    fake.captureToken(TOKEN);
    await settle();
    expect(userCalls()).toHaveLength(1);

    api.force = null;
    const popup = fake.createPage({ kind: 'popup' });
    await popup.send({ to: 'bg', type: 'status/get' });
    await settle();
    expect(userCalls()).toHaveLength(1); // too soon after the failed attempt

    await vi.advanceTimersByTimeAsync(11_000);
    await popup.send({ to: 'bg', type: 'status/get' });
    await settle();
    expect(userCalls()).toHaveLength(2);
    expect((sessionAccount() as AccountInfo).id).toBe(ACCOUNT_ID);
  });

  it('looks the account up again when the worker starts with a token and no account', async () => {
    api.users.set(TOKEN, userPayload());
    fake.session.seed({ [SESSION.token]: TOKEN, [SESSION.tokenCapturedAt]: 1 });
    await bootWorker(fake);
    await waitFor(sessionAccount);
    expect((sessionAccount() as AccountInfo).id).toBe(ACCOUNT_ID);
  });

  it('does not ask again when the account is already there (worker restart)', async () => {
    fake.session.seed({ [SESSION.token]: TOKEN, [SESSION.account]: { id: ACCOUNT_ID, username: 'x', globalName: null, avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png' } });
    await bootWorker(fake);
    await settle();
    expect(api.calls).toHaveLength(0);
  });

  it('does not ask twice for the same token (burst of identical requests)', async () => {
    api.users.set(TOKEN, userPayload());
    await bootWorker(fake);
    for (let i = 0; i < 50; i += 1) fake.captureToken(TOKEN);
    await waitFor(sessionAccount);
    await settle();
    expect(userCalls()).toHaveLength(1);
  });

  it('remembers verdicts for a while: tokens that alternate (two Discord clients) cost one request each', async () => {
    api.users.set(TOKEN, userPayload(ACCOUNT_ID));
    api.users.set(OTHER_TOKEN, userPayload(OTHER_ACCOUNT_ID));
    await bootWorker(fake);
    for (const token of [TOKEN, OTHER_TOKEN, TOKEN, OTHER_TOKEN, TOKEN]) {
      fake.captureToken(token);
      await waitFor(() => fake.session.peek(SESSION.token) === token);
      await settle();
    }
    await waitFor(() => (sessionAccount() as AccountInfo | null)?.id === ACCOUNT_ID);
    expect(userCalls()).toHaveLength(2);
  });

  it('a token Discord already vouched for switches the account at once: no blank account, no extra write, in either direction', async () => {
    api.users.set(TOKEN, userPayload(ACCOUNT_ID));
    api.users.set(OTHER_TOKEN, userPayload(OTHER_ACCOUNT_ID));
    await bootWorker(fake);
    for (const token of [TOKEN, OTHER_TOKEN]) {
      fake.captureToken(token);
      await waitFor(() => (sessionAccount() as AccountInfo | null)?.id === (token === TOKEN ? ACCOUNT_ID : OTHER_ACCOUNT_ID));
    }
    expect(userCalls()).toHaveLength(2);

    fake.session.set.mockClear();
    fake.local.set.mockClear();
    for (const token of [TOKEN, OTHER_TOKEN, TOKEN, OTHER_TOKEN, TOKEN]) {
      fake.captureToken(token);
      await waitFor(() => fake.session.peek(SESSION.token) === token);
      await settle();
      expect((sessionAccount() as AccountInfo | null)?.id).toBe(token === TOKEN ? ACCOUNT_ID : OTHER_ACCOUNT_ID);
    }
    const accountWrites = fake.session.set.mock.calls.map(([items]) => (items as Record<string, unknown>)[SESSION.account]).filter((value) => value !== undefined);
    expect(accountWrites).not.toContain(null); // never blank while flipping
    expect(userCalls()).toHaveLength(2);
    expect(fake.local.set.mock.calls.filter(([items]) => LOCAL.lastAccount in (items as object))).toHaveLength(5); // one per real change
  });

  it('overlapping triggers for the same token cost one request (the second run uses the fresh verdict)', async () => {
    api.users.set(TOKEN, userPayload(ACCOUNT_ID));
    let release: () => void = () => undefined;
    api.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await bootWorker(fake);
    fake.captureToken(TOKEN);
    await waitFor(() => userCalls().length === 1);
    fake.captureToken(OTHER_TOKEN); // while the first check is in flight the value changes ...
    await waitFor(() => fake.session.peek(SESSION.token) === OTHER_TOKEN);
    fake.captureToken(TOKEN); // ... and changes back: another run is queued
    await waitFor(() => fake.session.peek(SESSION.token) === TOKEN);
    release();
    await waitFor(() => (sessionAccount() as AccountInfo | null)?.id === ACCOUNT_ID);
    await settle();
    expect(userCalls()).toHaveLength(1);
  });

  it('a verdict that arrives after the captured value changed again can never overwrite the newer account', async () => {
    api.users.set(TOKEN, userPayload(ACCOUNT_ID, { username: 'first' }));
    api.users.set(OTHER_TOKEN, userPayload(OTHER_ACCOUNT_ID, { username: 'second' }));
    await bootWorker(fake);
    fake.captureToken(OTHER_TOKEN);
    await waitFor(() => (sessionAccount() as AccountInfo | null)?.id === OTHER_ACCOUNT_ID); // second is known now
    let release: () => void = () => undefined;
    api.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.captureToken(TOKEN); // first: verification is slow
    await waitFor(() => userCalls().length === 2);
    api.gate = null;
    fake.captureToken(OTHER_TOKEN); // back to the known value while the first check is still in flight
    await waitFor(() => (sessionAccount() as AccountInfo | null)?.id === OTHER_ACCOUNT_ID);
    release();
    await settle();
    await settle();
    expect((sessionAccount() as AccountInfo).username).toBe('second');
    expect(fake.session.peek(SESSION.token)).toBe(OTHER_TOKEN);
  });

  it('does not ask again about a token that just got a 401, even if a page keeps sending it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
    await bootWorker(fake);
    fake.captureToken(TOKEN); // 401
    await settle();
    expect(userCalls()).toHaveLength(1);
    expect(fake.session.has(SESSION.token)).toBe(false);

    fake.captureToken(TOKEN); // the page still sends the dead value: it is stored again ...
    await settle();
    expect(fake.session.peek(SESSION.token)).toBe(TOKEN);
    expect(userCalls()).toHaveLength(1); // ... but not asked about again right away
    expect(sessionAccount()).toBeNull();

    await vi.advanceTimersByTimeAsync(61_000);
    const popup = fake.createPage({ kind: 'popup' });
    await popup.send({ to: 'bg', type: 'status/get' });
    await settle();
    expect(userCalls()).toHaveLength(2);
    expect(fake.session.has(SESSION.token)).toBe(false);
  });

  it('an answer that is not a user is ignored', async () => {
    api.users.set(TOKEN, { hello: 'world' });
    await bootWorker(fake);
    fake.captureToken(TOKEN);
    await waitFor(() => userCalls().length === 1);
    await settle();
    expect(sessionAccount()).toBeNull();
    expect(fake.session.peek(SESSION.token)).toBe(TOKEN);
  });

  it('a token removed from storage leaves no account', async () => {
    api.users.set(TOKEN, userPayload());
    await bootWorker(fake);
    fake.captureToken(TOKEN);
    await waitFor(sessionAccount);
    await fake.session.remove([SESSION.token, SESSION.tokenCapturedAt]);
    await waitFor(() => sessionAccount() === null);
  });

  it('never logs, and the token only ever travels in the Authorization header of users/@me', async () => {
    api.users.set(TOKEN, userPayload());
    await bootWorker(fake);
    fake.captureToken(TOKEN);
    await waitFor(sessionAccount);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(fake.local.dump())).not.toContain(TOKEN);
    expect(api.calls.every((call) => !call.url.includes(TOKEN))).toBe(true);
  });
});

describe('apiGet (the worker\'s own allow-listed GET)', () => {
  it.each([
    '/api/v9/users/@me/guilds',
    '/api/v9/users/@me/channels',
    '/api/v9/channels/1/messages',
    '/api/v9/guilds/1/roles/2',
    '/api/v9/attachments/refresh-urls',
    '/api/v10/users/@me',
    '/users/@me',
    'https://evil.example/api/v9/users/@me',
    '//evil.example/api/v9/users/@me',
    '/api/v9/users/@me#x',
    '/api/v9/../v9/users/@me',
    '',
  ])('refuses %j without any request', async (path) => {
    await expect(apiGet(path, TOKEN)).resolves.toEqual({ ok: false, kind: 'forbidden-path' });
    expect(api.calls).toHaveLength(0);
  });

  it.each(['/api/v9/users/@me', '/api/v9/channels/123', '/api/v9/guilds/123', '/api/v9/guilds/123/channels'])('lets %s through', async (path) => {
    await apiGet(path, TOKEN);
    expect(api.calls.map((call) => call.url)).toEqual([`https://discord.com${path}`]);
  });

  it('reports 401 as unauthorized, other statuses and network errors as values (never throws, never leaks the token)', async () => {
    api.users.set(TOKEN, userPayload());
    await expect(apiGet('/api/v9/users/@me', OTHER_TOKEN)).resolves.toEqual({ ok: false, kind: 'unauthorized', status: 401 });
    api.force = 503;
    await expect(apiGet('/api/v9/users/@me', TOKEN)).resolves.toEqual({ ok: false, kind: 'http', status: 503 });
    api.force = 'network';
    const result = await apiGet('/api/v9/users/@me', TOKEN);
    expect(result).toEqual({ ok: false, kind: 'network' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('treats a body that is not JSON as a failed request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })));
    await expect(apiGet('/api/v9/users/@me', TOKEN)).resolves.toEqual({ ok: false, kind: 'http', status: 200 });
  });

  it('never follows a redirect (the Authorization header must not leave discord.com)', async () => {
    await apiGet('/api/v9/users/@me', TOKEN);
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe('error');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
  });
});
