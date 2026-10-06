import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveDiscordClient, createDiscordClient } from '@/lib/discord/api';
import type { LiveDiscordClientOptions, PauseEvent } from '@/lib/discord/api';
import { DiscordApiError } from '@/lib/discord/client';
import { BLOCKED_RETRY_WAITS_MS, DEFAULT_PAGE_GAP, MAX_RATE_LIMIT_WAIT_MS, NO_GAP, backoffDelayMs } from '@/lib/discord/rateLimit';
import { createFetchTransport } from '@/lib/discord/transport';
import type { HttpTransport, TransportRequest } from '@/lib/discord/transport';
import type { Channel } from '@/lib/discord/types';

const TOKEN = 'SECRET.token-value_123';
const BASE = 'https://discord.com/api/v9';

interface Call {
  url: string;
  init: RequestInit;
}
type Reply = Response | Error | ((call: Call) => Response | Promise<Response>);

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Cloudflare-style block page: HTML, no Discord error body. */
const blockPage = (status = 403): Response => new Response('<html>Access denied</html>', { status, headers: { 'content-type': 'text/html' } });

/** A fake fetch that serves `replies` in order, plus a fake clock whose injected `sleep` records and advances time. */
function setup(replies: Reply[], opts: Partial<LiveDiscordClientOptions> = {}) {
  let now = 1_000_000;
  const sleeps: number[] = [];
  const calls: Call[] = [];
  const pending = [...replies];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: Call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const reply = pending.shift();
    if (reply === undefined) throw new Error(`unexpected extra request: ${call.url}`);
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(call) : reply;
  }) as typeof fetch;
  const client = new LiveDiscordClient({
    getAuthorization: () => TOKEN,
    transport: createFetchTransport({ fetch: fakeFetch }),
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    random: () => 0.5,
    pageGap: NO_GAP,
    ...opts,
  });
  return { client, calls, sleeps, urls: () => calls.map((c) => c.url), advance: (ms: number) => (now += ms), now: () => now };
}

async function errorOf(promise: Promise<unknown>): Promise<DiscordApiError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(DiscordApiError);
    return e as DiscordApiError;
  }
  throw new Error('expected the promise to reject');
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A fetch reply that never answers on its own and rejects like a real fetch when the request is aborted. */
function hangUntilAborted(onStart?: () => void): Reply {
  return (call) =>
    new Promise<Response>((_, reject) => {
      const abort = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (call.init.signal?.aborted) abort();
      call.init.signal?.addEventListener('abort', abort);
      onStart?.();
    });
}

/** A sleep that never finishes by itself: only the abort signal ends it. */
const sleepUntilAborted = (onStart?: () => void): LiveDiscordClientOptions['sleep'] => (_ms, signal) =>
  new Promise<void>((_, reject) => {
    onStart?.();
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

afterEach(() => vi.unstubAllGlobals());

/** `GET /guilds/1/roles`: the simplest request that answers an array; stands in for "any request" below. */
const anyGet = (client: LiveDiscordClient, signal?: AbortSignal) => client.getGuildRoles('1', signal);
const ANY_URL = `${BASE}/guilds/1/roles`;

describe('LiveDiscordClient: basics', () => {
  it('is a live client, also through the factory', () => {
    expect(setup([]).client.kind).toBe('live');
    expect(createDiscordClient({ getAuthorization: () => TOKEN }).kind).toBe('live');
  });

  it('sends GET with the raw authorization value (no Bearer prefix) as the only header', async () => {
    const h = setup([json({ id: '1', username: 'me' })]);
    const me = await h.client.getMe();
    expect(me).toEqual({ id: '1', username: 'me' });
    expect(h.calls).toHaveLength(1);
    const { url, init } = h.calls[0]!;
    expect(url).toBe(`${BASE}/users/@me`);
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ Authorization: TOKEN });
    expect(init.body).toBeUndefined();
  });

  it('never lets the value follow redirects or ride along with cookies', async () => {
    const h = setup([json({ id: '1', username: 'me' })]);
    await h.client.getMe();
    expect(h.calls[0]!.init.redirect).toBe('error');
    expect(h.calls[0]!.init.credentials).toBe('omit');
  });

  it('resolves the authorization on every request (async getters, refreshed values, stray whitespace)', async () => {
    const values = ['  first-token\n', 'second-token'];
    const h = setup([json([]), json([])], { getAuthorization: async () => values.shift() ?? null });
    await anyGet(h.client);
    await anyGet(h.client);
    expect(h.calls.map((c) => (c.init.headers as Record<string, string>).Authorization)).toEqual(['first-token', 'second-token']);
  });

  it('resolves it again for the retry after a 429 wait, so a refreshed value is the one that is sent', async () => {
    const values = ['old-token', 'new-token'];
    const h = setup([json({ retry_after: 5 }, 429), json([])], { getAuthorization: () => values.shift() ?? null });
    await anyGet(h.client);
    expect(h.calls.map((c) => (c.init.headers as Record<string, string>).Authorization)).toEqual(['old-token', 'new-token']);
  });

  it('resolves it again for the retry after a 5xx', async () => {
    const values = ['old-token', 'new-token'];
    const h = setup([json({}, 503), json([])], { getAuthorization: () => values.shift() ?? null });
    await anyGet(h.client);
    expect(h.calls.map((c) => (c.init.headers as Record<string, string>).Authorization)).toEqual(['old-token', 'new-token']);
  });

  it('uses the global fetch (as a plain function) when no transport is injected', async () => {
    const globalFetch = vi.fn(async () => json({ id: '1', username: 'via-global' }));
    vi.stubGlobal('fetch', globalFetch);
    const client = new LiveDiscordClient({ getAuthorization: () => TOKEN });
    await expect(client.getMe()).resolves.toMatchObject({ username: 'via-global' });
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch.mock.calls[0]).toEqual([`${BASE}/users/@me`, expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'error' })]);
  });
});

describe('LiveDiscordClient: injectable transport', () => {
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    status,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
  });

  it('hands the transport the method, the path with its query, the headers and the signal, and nothing else', async () => {
    const seen: TransportRequest[] = [];
    const transport: HttpTransport = async (request) => {
      seen.push(request);
      return answer(200, []);
    };
    const client = new LiveDiscordClient({ getAuthorization: () => TOKEN, transport, pageGap: NO_GAP });
    const controller = new AbortController();
    await client.getMessages('123', { before: '456', limit: 10 }, controller.signal);
    expect(seen).toEqual([
      { method: 'GET', path: '/api/v9/channels/123/messages?limit=10&before=456', headers: { Authorization: TOKEN }, signal: controller.signal },
    ]);
    expect('body' in seen[0]!).toBe(false);
  });

  it('works with any transport: a plain object that is not a Response is enough', async () => {
    const transport: HttpTransport = async () => answer(200, { id: '7', username: 'plain' });
    const client = new LiveDiscordClient({ getAuthorization: () => TOKEN, transport });
    await expect(client.getMe()).resolves.toEqual({ id: '7', username: 'plain' });
  });

  it('turns whatever the transport throws into a "network" error after the retries, never a raw error', async () => {
    const cause = new Error('socket hang up');
    let calls = 0;
    const transport: HttpTransport = async () => {
      calls += 1;
      throw cause;
    };
    const client = new LiveDiscordClient({ getAuthorization: () => TOKEN, transport, sleep: async () => undefined, random: () => 0.5 });
    const error = await errorOf(client.getMe());
    expect(error.kind).toBe('network');
    expect(error.cause).toBe(cause);
    expect(calls).toBe(4);
  });

  it('reports a body that cannot be read as a network error', async () => {
    const transport: HttpTransport = async () => ({
      status: 200,
      headers: new Headers(),
      text: async () => {
        throw new TypeError('terminated');
      },
    });
    const client = new LiveDiscordClient({ getAuthorization: () => TOKEN, transport });
    expect((await errorOf(client.getMe())).kind).toBe('network');
  });

  it('still maps an error answer whose body cannot be read by its status', async () => {
    const transport: HttpTransport = async () => ({
      status: 404,
      headers: new Headers(),
      text: async () => {
        throw new TypeError('terminated');
      },
    });
    const client = new LiveDiscordClient({ getAuthorization: () => TOKEN, transport });
    expect((await errorOf(client.getMe())).kind).toBe('not-found');
  });
});

describe('LiveDiscordClient: the allow-list gate', () => {
  /** The private door every request goes through: a request that is not on the allow-list must never reach the transport. */
  const send = (client: LiveDiscordClient, method: string, path: string): Promise<unknown> =>
    (client as unknown as { request(spec: { method: string; path: string }, signal?: AbortSignal): Promise<unknown> }).request({ method, path });

  const REFUSED: Array<[string, string]> = [
    ['GET', '/api/v9/users/@me/guilds'],
    ['GET', '/api/v9/users/@me/channels'],
    ['GET', '/api/v9/guilds/1/threads/active'],
    ['GET', '/api/v9/channels/1/messages/2'],
    ['GET', '/api/v9/channels/1/pins'],
    ['GET', '/api/v8/users/@me'],
    ['GET', '/api/v9/users/@me/../../x'],
    ['GET', 'https://evil.test/api/v9/users/@me'],
    ['GET', '//evil.test/api/v9/users/@me'],
    ['GET', '/api/v9/users/@me\r\nX-Evil: 1'],
    ['POST', '/api/v9/channels/1/messages'],
    ['POST', '/api/v9/users/@me'],
    ['POST', '/api/v9/attachments/refresh-urls?x=1'],
    ['DELETE', '/api/v9/channels/1'],
    ['PUT', '/api/v9/channels/1/messages'],
    ['PATCH', '/api/v9/users/@me'],
    ['get', '/api/v9/users/@me'],
  ];

  it.each(REFUSED)('refuses %s %s without sending anything', async (method, path) => {
    const calls: TransportRequest[] = [];
    const client = new LiveDiscordClient({
      getAuthorization: () => TOKEN,
      transport: async (request) => {
        calls.push(request);
        return { status: 200, headers: new Headers(), text: async () => '[]' };
      },
    });
    const error = await errorOf(send(client, method, path));
    expect(error.kind).toBe('not-allowed');
    expect(error.message).not.toContain(TOKEN);
    expect(calls).toHaveLength(0);
  });

  it('does not even ask for the authorization value when the request is refused', async () => {
    const getAuthorization = vi.fn(() => TOKEN);
    const client = new LiveDiscordClient({ getAuthorization, transport: async () => ({ status: 200, headers: new Headers(), text: async () => '[]' }) });
    await errorOf(send(client, 'GET', '/api/v9/users/@me/guilds'));
    expect(getAuthorization).not.toHaveBeenCalled();
  });

  it('lets every request the client makes itself through', async () => {
    const paths: string[] = [];
    const client = new LiveDiscordClient({
      getAuthorization: () => TOKEN,
      pageGap: NO_GAP,
      transport: async (request) => {
        paths.push(`${request.method} ${request.path}`);
        const body =
          request.path.includes('/threads/search') ? { threads: [], has_more: false }
          : request.path.endsWith('refresh-urls') ? { refreshed_urls: [] }
          : request.path.endsWith('/messages?limit=5') || request.path.endsWith('/channels') || request.path.endsWith('/roles') ? []
          : { id: '1', roles: [], user: { id: '2' } };
        return { status: 200, headers: new Headers(), text: async () => JSON.stringify(body) };
      },
    });
    await client.getMe();
    await client.getChannel('10');
    await client.getGuild('20');
    await client.getGuildChannels('20');
    await client.getGuildRoles('20');
    await client.getMyMember('20');
    await client.getMessages('10', { limit: 5 });
    await client.searchThreads('10', { archived: false, offset: 0 });
    await client.searchThreads('10', { archived: true, offset: 25 });
    await client.refreshAttachmentUrls(['https://cdn.discordapp.com/attachments/1/2/a.png?ex=1']);
    expect(paths).toEqual([
      'GET /api/v9/users/@me',
      'GET /api/v9/channels/10',
      'GET /api/v9/guilds/20',
      'GET /api/v9/guilds/20/channels',
      'GET /api/v9/guilds/20/roles',
      'GET /api/v9/users/@me/guilds/20/member',
      'GET /api/v9/channels/10/messages?limit=5',
      'GET /api/v9/channels/10/threads/search?archived=false&sort_by=last_message_time&sort_order=desc&limit=25&offset=0',
      'GET /api/v9/channels/10/threads/search?archived=true&sort_by=last_message_time&sort_order=desc&limit=25&offset=25',
      'POST /api/v9/attachments/refresh-urls',
    ]);
  });
});

describe('LiveDiscordClient: missing or unusable authorization', () => {
  it.each([null, '', '   '])('fails with kind "auth" without touching the network for the value %j', async (value) => {
    const onAuthError = vi.fn();
    const h = setup([], { getAuthorization: () => value, onAuthError });
    const error = await errorOf(h.client.getMe());
    expect(error.kind).toBe('auth');
    expect(h.calls).toHaveLength(0);
    expect(onAuthError).not.toHaveBeenCalled();
  });

  it('refuses a value that is not a valid header value', async () => {
    const h = setup([], { getAuthorization: () => 'abc def\nghi' });
    expect((await errorOf(h.client.getMe())).kind).toBe('auth');
    expect(h.calls).toHaveLength(0);
  });
});

describe('LiveDiscordClient: ids are validated before any request', () => {
  it('rejects path-traversal style ids', async () => {
    const h = setup([]);
    for (const evil of ['../../../evil', '123/../../x', '1%2f2', '@evil.test', '//evil.test']) {
      expect((await errorOf(h.client.getChannel(evil))).kind).toBe('unknown');
      expect((await errorOf(h.client.getGuild(evil))).kind).toBe('unknown');
      expect((await errorOf(h.client.getGuildChannels(evil))).kind).toBe('unknown');
      expect((await errorOf(h.client.getGuildRoles(evil))).kind).toBe('unknown');
      expect((await errorOf(h.client.getMyMember(evil))).kind).toBe('unknown');
      expect((await errorOf(h.client.searchThreads(evil, { archived: false, offset: 0 }))).kind).toBe('unknown');
      expect((await errorOf(h.client.getMessages(evil))).kind).toBe('unknown');
    }
    expect(h.calls).toHaveLength(0);
  });

  it.each([-1, 1.5, Number.NaN, 9976, 100_000])('rejects the thread search offset %s', async (offset) => {
    const h = setup([]);
    expect((await errorOf(h.client.searchThreads('1', { archived: false, offset }))).kind).toBe('unknown');
    expect(h.calls).toHaveLength(0);
  });
});

describe('LiveDiscordClient: errors never contain the authorization value', () => {
  const echo = { message: `Invalid token ${TOKEN} supplied`, code: 0 };

  it.each([400, 401, 403, 404, 418])('redacts a value echoed back in a %i response', async (status) => {
    const h = setup([json(echo, status)]);
    const error = await errorOf(h.client.getMe());
    expect(error.message).not.toContain(TOKEN);
    expect(`${error.name}: ${error.message}\n${error.stack ?? ''}`).not.toContain(TOKEN);
    expect(error.message).toContain('[redacted]');
  });

  it('redacts it from persistent 5xx errors', async () => {
    const h = setup([json(echo, 500), json(echo, 500), json(echo, 500), json(echo, 500)]);
    const error = await errorOf(h.client.getMe());
    expect(error.kind).toBe('server');
    expect(error.message).not.toContain(TOKEN);
  });

  it('redacts every value the call used, also one that was refreshed between retries', async () => {
    const values = ['first-token-aaa', 'second-token-bbb'];
    const h = setup([json({ retry_after: 1 }, 429), json({ message: 'echo first-token-aaa and second-token-bbb' }, 400)], {
      getAuthorization: () => values.shift() ?? null,
    });
    const error = await errorOf(anyGet(h.client));
    expect(error.message).not.toContain('first-token-aaa');
    expect(error.message).not.toContain('second-token-bbb');
    expect(error.message).toContain('[redacted]');
  });

  it('keeps it out of network errors, rate-limit errors, block-page errors and URLs', async () => {
    const network = setup(Array.from({ length: 4 }, () => new TypeError(`fetch failed for ${TOKEN}`)));
    const networkError = await errorOf(network.client.getMe());
    expect(networkError.kind).toBe('network');
    expect(networkError.message).not.toContain(TOKEN);

    const limited = setup([json({ message: `slow down ${TOKEN}`, retry_after: 6000 }, 429)]);
    const limitedError = await errorOf(limited.client.getMe());
    expect(limitedError.message).not.toContain(TOKEN);

    const blocked = setup([blockPage(), blockPage(), blockPage(), blockPage()]);
    const blockedError = await errorOf(blocked.client.getMe());
    expect(blockedError.kind).toBe('blocked');
    expect(blockedError.message).not.toContain(TOKEN);

    for (const call of [...network.calls, ...limited.calls, ...blocked.calls]) expect(call.url).not.toContain(TOKEN);
  });
});

describe('LiveDiscordClient: endpoints', () => {
  it('getMe, getChannel, getGuild, getGuildChannels and getGuildRoles hit the right endpoints and return the body', async () => {
    const me = { id: '42', username: 'me' };
    const channel: Channel = { id: '5', type: 0, name: 'general', guild_id: '123', parent_id: '4' };
    const guild = { id: '123', name: 'My Server', icon: null };
    const channels: Channel[] = [{ id: '5', type: 0, name: 'general' }];
    const roles = [{ id: '9', name: '@everyone', permissions: '1024', position: 0 }];
    const h = setup([json(me), json(channel), json(guild), json(channels), json(roles)]);
    expect(await h.client.getMe()).toEqual(me);
    expect(await h.client.getChannel('5')).toEqual(channel);
    expect(await h.client.getGuild('123')).toEqual(guild);
    expect(await h.client.getGuildChannels('123')).toEqual(channels);
    expect(await h.client.getGuildRoles('123')).toEqual(roles);
    expect(h.urls()).toEqual([`${BASE}/users/@me`, `${BASE}/channels/5`, `${BASE}/guilds/123`, `${BASE}/guilds/123/channels`, `${BASE}/guilds/123/roles`]);
  });

  it('rejects unexpected response shapes with kind "unknown"', async () => {
    const h = setup([json({ nope: true }), json({ no: 'id' }), json({ no: 'id' }), json('text'), json({ id: 1 })]);
    expect((await errorOf(h.client.getGuildChannels('1'))).kind).toBe('unknown');
    expect((await errorOf(h.client.getMe())).kind).toBe('unknown');
    expect((await errorOf(h.client.getChannel('1'))).kind).toBe('unknown');
    expect((await errorOf(h.client.getMyMember('1'))).kind).toBe('unknown');
    expect((await errorOf(h.client.getGuild('1'))).kind).toBe('unknown');
  });

  it('rejects a 200 response whose body is not JSON', async () => {
    const h = setup([new Response('<html>oops</html>', { status: 200 })]);
    expect((await errorOf(anyGet(h.client))).kind).toBe('unknown');
  });
});

describe('LiveDiscordClient: getMyMember', () => {
  it('uses the current-user-guild-member endpoint first and maps the result', async () => {
    const user = { id: '42', username: 'me' };
    const h = setup([json({ roles: ['1', '2'], user, nick: 'ignored', joined_at: 'ignored' })]);
    expect(await h.client.getMyMember('123')).toEqual({ roles: ['1', '2'], user });
    expect(h.urls()).toEqual([`${BASE}/users/@me/guilds/123/member`]);
  });

  it('falls back to /guilds/{id}/members/@me when the first endpoint says no', async () => {
    for (const status of [403, 404, 400]) {
      const h = setup([json({ message: 'nope', code: 0 }, status), json({ roles: ['5'], user: { id: '42', username: 'me' } })]);
      expect(await h.client.getMyMember('123')).toEqual({ roles: ['5'], user: { id: '42', username: 'me' } });
      expect(h.urls()).toEqual([`${BASE}/users/@me/guilds/123/member`, `${BASE}/guilds/123/members/@me`]);
    }
  });

  it('falls back at once when the first endpoint answers a block page: a block is not waited out for an endpoint that may not exist for user tokens', async () => {
    const h = setup([blockPage(), json({ roles: ['5'] })]);
    expect(await h.client.getMyMember('123')).toEqual({ roles: ['5'] });
    expect(h.sleeps).toEqual([]);
  });

  it('does not treat a 401 from the first (OAuth-oriented) endpoint as an expired authorization', async () => {
    const onAuthError = vi.fn();
    const h = setup([json({ message: '401: Unauthorized' }, 401), json({ roles: ['5'] })], { onAuthError });
    expect(await h.client.getMyMember('123')).toEqual({ roles: ['5'] });
    expect(onAuthError).not.toHaveBeenCalled();
  });

  it('reports a genuine 401 from the fallback endpoint', async () => {
    const onAuthError = vi.fn();
    const h = setup([json({}, 401), json({}, 401)], { onAuthError });
    expect((await errorOf(h.client.getMyMember('123'))).kind).toBe('auth');
    expect(onAuthError).toHaveBeenCalledTimes(1);
  });

  it('does not fall back on server errors, rate limits or aborts', async () => {
    const server = setup([json({}, 500), json({}, 500), json({}, 500), json({}, 500)]);
    expect((await errorOf(server.client.getMyMember('123'))).kind).toBe('server');
    expect(server.urls().every((u) => u.endsWith('/users/@me/guilds/123/member'))).toBe(true);

    const controller = new AbortController();
    const aborted = setup([hangUntilAborted(() => controller.abort())]);
    expect((await errorOf(aborted.client.getMyMember('123', controller.signal))).kind).toBe('aborted');
    expect(aborted.calls).toHaveLength(1);
  });

  it('tolerates a member without usable roles', async () => {
    const h = setup([json({ roles: 'none', user: 'nobody' })]);
    expect(await h.client.getMyMember('123')).toEqual({ roles: [] });
  });
});

describe('LiveDiscordClient: getMessages', () => {
  it('builds the query from limit / before / after', async () => {
    const h = setup([json([]), json([]), json([])]);
    await h.client.getMessages('123', { before: '456', limit: 100 });
    await h.client.getMessages('123', { after: '789' });
    await h.client.getMessages('123');
    expect(h.urls()).toEqual([
      `${BASE}/channels/123/messages?limit=100&before=456`,
      `${BASE}/channels/123/messages?limit=50&after=789`,
      `${BASE}/channels/123/messages?limit=50`,
    ]);
  });

  it.each<[number | undefined, number]>([
    [undefined, 50],
    [0, 1],
    [-5, 1],
    [1, 1],
    [99, 99],
    [100, 100],
    [101, 100],
    [500, 100],
    [25.9, 25],
    [Number.NaN, 50],
    [Number.POSITIVE_INFINITY, 100],
    [Number.NEGATIVE_INFINITY, 1],
  ])('clamps limit %s to %i', async (limit, expected) => {
    const h = setup([json([])]);
    await h.client.getMessages('123', { limit });
    expect(new URL(h.calls[0]!.url).searchParams.get('limit')).toBe(String(expected));
  });

  it('returns the messages exactly as the API sent them (newest first)', async () => {
    const page = [{ id: '3' }, { id: '2' }, { id: '1' }];
    const h = setup([json(page)]);
    expect(await h.client.getMessages('123')).toEqual(page);
  });

  it.each(['', 'abc', '12 3', '1/../2', '123?x=1', '1.5', '-1', '1e5', '１２３', '1'.repeat(26)])('rejects the non-numeric id %j', async (bad) => {
    const h = setup([]);
    expect((await errorOf(h.client.getMessages(bad))).kind).toBe('unknown');
    expect((await errorOf(h.client.getMessages('123', { before: bad }))).kind).toBe('unknown');
    expect((await errorOf(h.client.getMessages('123', { after: bad }))).kind).toBe('unknown');
    expect(h.calls).toHaveLength(0);
  });
});

describe('LiveDiscordClient: searchThreads', () => {
  const post = (id: string, extra: Partial<Channel> = {}): Channel => ({ id, type: 11, name: `post ${id}`, ...extra });
  const search = (id: string, archived: boolean, offset: number): string =>
    `${BASE}/channels/${id}/threads/search?archived=${archived}&sort_by=last_message_time&sort_order=desc&limit=25&offset=${offset}`;

  it('requests exactly the documented search and returns the ready page', async () => {
    const h = setup([json({ threads: [post('101', { parent_id: '12' }), post('102')], has_more: true, total_results: 40 })]);
    const page = await h.client.searchThreads('12', { archived: false, offset: 0 });
    expect(page).toEqual({ status: 'ready', threads: [post('101', { parent_id: '12' }), post('102')], hasMore: true });
    expect(h.urls()).toEqual([search('12', false, 0)]);
  });

  it('passes archived and offset through', async () => {
    const h = setup([json({ threads: [] }), json({ threads: [] })]);
    await h.client.searchThreads('12', { archived: true, offset: 25 });
    await h.client.searchThreads('12', { archived: false, offset: 9975 });
    expect(h.urls()).toEqual([search('12', true, 25), search('12', false, 9975)]);
  });

  it('only a has_more that is exactly true means "more"', async () => {
    const h = setup([json({ threads: [post('1')], has_more: 'yes' }), json({ threads: [post('1')] }), json({ threads: [post('1')], has_more: true })]);
    expect((await h.client.searchThreads('12', { archived: false, offset: 0 })).status).toBe('ready');
    const pages = [await h.client.searchThreads('12', { archived: false, offset: 0 }), await h.client.searchThreads('12', { archived: false, offset: 0 })];
    expect(pages.map((p) => (p.status === 'ready' ? p.hasMore : null))).toEqual([false, true]);
  });

  it('drops entries that are not channel objects', async () => {
    const h = setup([json({ threads: [post('101'), 'x', null, { name: 'no id' }, 7] })]);
    const page = await h.client.searchThreads('12', { archived: false, offset: 0 });
    expect(page.status === 'ready' && page.threads.map((t) => t.id)).toEqual(['101']);
  });

  describe('index not ready (HTTP 202)', () => {
    const notIndexed = (retryAfter?: number): Response =>
      json({ message: 'Index not yet available. Try again later', code: 110000, documents_indexed: 0, ...(retryAfter === undefined ? {} : { retry_after: retryAfter }) }, 202);

    it('is reported as "indexing" with the retry hint in milliseconds, not as an empty result', async () => {
      const h = setup([notIndexed(2), notIndexed(), notIndexed(0.25)]);
      expect(await h.client.searchThreads('12', { archived: false, offset: 0 })).toEqual({ status: 'indexing', retryAfterMs: 2000 });
      expect(await h.client.searchThreads('12', { archived: false, offset: 0 })).toEqual({ status: 'indexing', retryAfterMs: null });
      expect(await h.client.searchThreads('12', { archived: false, offset: 0 })).toEqual({ status: 'indexing', retryAfterMs: 250 });
      expect(h.sleeps).toEqual([]);
    });

    it('also recognises the code 110000 on its own and a bare 202', async () => {
      const h = setup([json({ code: 110000, message: 'Index not yet available', retry_after: 1 }), json({}, 202)]);
      expect(await h.client.searchThreads('12', { archived: false, offset: 0 })).toEqual({ status: 'indexing', retryAfterMs: 1000 });
      expect((await h.client.searchThreads('12', { archived: false, offset: 0 })).status).toBe('indexing');
    });

    it('does not mistake a 202 that carries a threads array for "not ready"', async () => {
      const h = setup([json({ threads: [post('101')], has_more: false }, 202)]);
      const page = await h.client.searchThreads('12', { archived: false, offset: 0 });
      expect(page.status === 'ready' && page.threads).toHaveLength(1);
    });

    it('is scoped to the thread search: a 202 elsewhere is an ordinary answer', async () => {
      const h = setup([json([{ id: '7', type: 0 }], 202)]);
      await expect(h.client.getGuildChannels('1')).resolves.toEqual([{ id: '7', type: 0 }]);
    });
  });

  it('rejects a malformed answer', async () => {
    const h = setup([json('nonsense'), json({ threads: 'no' })]);
    expect((await errorOf(h.client.searchThreads('12', { archived: false, offset: 0 }))).kind).toBe('unknown');
    expect((await errorOf(h.client.searchThreads('12', { archived: false, offset: 0 }))).kind).toBe('unknown');
  });

  it('maps a 403 / 404 on the search like any other request', async () => {
    const h = setup([json({ message: 'Missing Access', code: 50001 }, 403), json({ message: 'Unknown Channel', code: 10003 }, 404)]);
    expect((await errorOf(h.client.searchThreads('12', { archived: false, offset: 0 }))).kind).toBe('forbidden');
    expect((await errorOf(h.client.searchThreads('12', { archived: false, offset: 0 }))).kind).toBe('not-found');
  });

  it('waits out a 429 on the search like on any request', async () => {
    const h = setup([json({ retry_after: 2 }, 429), json({ threads: [post('1')] })]);
    const page = await h.client.searchThreads('12', { archived: false, offset: 0 });
    expect(page.status).toBe('ready');
    expect(h.sleeps).toEqual([2000]);
  });
});

describe('LiveDiscordClient: refreshAttachmentUrls', () => {
  const url = (n: number): string => `https://cdn.discordapp.com/attachments/1/2/file${n}.png?ex=65f&is=65e&hm=abc${n}`;

  it('POSTs { attachment_urls } as JSON to the one allowed path and maps the answer', async () => {
    const h = setup([json({ refreshed_urls: [{ original: url(1), refreshed: `${url(1)}&new=1` }, { original: url(2), refreshed: `${url(2)}&new=1` }] })]);
    const refreshed = await h.client.refreshAttachmentUrls([url(1), url(2)]);
    expect(refreshed).toEqual([
      { original: url(1), refreshed: `${url(1)}&new=1` },
      { original: url(2), refreshed: `${url(2)}&new=1` },
    ]);
    const { url: requested, init } = h.calls[0]!;
    expect(requested).toBe(`${BASE}/attachments/refresh-urls`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: TOKEN, 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({ attachment_urls: [url(1), url(2)] });
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
  });

  it('makes no request for an empty list and refuses more than 50 urls in one request', async () => {
    const h = setup([]);
    expect(await h.client.refreshAttachmentUrls([])).toEqual([]);
    const tooMany = await errorOf(h.client.refreshAttachmentUrls(Array.from({ length: 51 }, (_, i) => url(i))));
    expect(tooMany.kind).toBe('unknown');
    expect(h.calls).toHaveLength(0);
  });

  it('accepts exactly 50 urls', async () => {
    const h = setup([json({ refreshed_urls: [] })]);
    await h.client.refreshAttachmentUrls(Array.from({ length: 50 }, (_, i) => url(i)));
    expect(JSON.parse(String(h.calls[0]!.init.body)).attachment_urls).toHaveLength(50);
  });

  it('skips malformed entries of the answer and rejects an answer without a list', async () => {
    const h = setup([json({ refreshed_urls: [{ original: url(1), refreshed: 'x' }, { original: 5 }, 'text', null] }), json({ nope: [] })]);
    expect(await h.client.refreshAttachmentUrls([url(1)])).toEqual([{ original: url(1), refreshed: 'x' }]);
    expect((await errorOf(h.client.refreshAttachmentUrls([url(1)]))).kind).toBe('unknown');
  });

  it('is an ordinary request otherwise: the 401 is reported, a 429 is waited out', async () => {
    const onAuthError = vi.fn();
    const h = setup([json({ retry_after: 2 }, 429), json({}, 401)], { onAuthError });
    expect((await errorOf(h.client.refreshAttachmentUrls([url(1)]))).kind).toBe('auth');
    expect(h.sleeps).toEqual([2000]);
    expect(onAuthError).toHaveBeenCalledWith(TOKEN);
  });
});

describe('LiveDiscordClient: rate limiting', () => {
  it('waits retry_after (float seconds, from the body) on a 429 and then succeeds', async () => {
    const h = setup([json({ message: 'You are being rate limited.', retry_after: 1.5, global: false }, 429, { 'retry-after': '2' }), json([{ id: '7', type: 0 }])]);
    await expect(h.client.getGuildChannels('1')).resolves.toEqual([{ id: '7', type: 0 }]);
    expect(h.sleeps).toEqual([1500]);
    expect(h.calls).toHaveLength(2);
  });

  it('prefers the JSON retry_after over the Retry-After header, and the header over the 1 s default', async () => {
    const jsonFirst = setup([json({ retry_after: 4 }, 429, { 'retry-after': '9' }), json([])]);
    await anyGet(jsonFirst.client);
    expect(jsonFirst.sleeps).toEqual([4000]);

    const headerOnly = setup([new Response('<html>Error 1015</html>', { status: 429, headers: { 'retry-after': '3' } }), json([])]);
    await anyGet(headerOnly.client);
    expect(headerOnly.sleeps).toEqual([3000]);

    const nothing = setup([new Response('', { status: 429 }), json([])]);
    await anyGet(nothing.client);
    expect(nothing.sleeps).toEqual([1000]);
  });

  it('honours a global rate limit', async () => {
    const h = setup([json({ retry_after: 2, global: true }, 429, { 'x-ratelimit-global': 'true' }), json([]), json([])]);
    await anyGet(h.client);
    await h.client.getGuildChannels('1');
    expect(h.sleeps).toEqual([2000]);
  });

  it('gives up with "rate-limited" (and the wait it would have needed) when the wait exceeds the cap', async () => {
    const h = setup([json({ retry_after: MAX_RATE_LIMIT_WAIT_MS / 1000 + 90 }, 429)]);
    const error = await errorOf(anyGet(h.client));
    expect(error.kind).toBe('rate-limited');
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(MAX_RATE_LIMIT_WAIT_MS + 90_000);
    expect(h.sleeps).toEqual([]);
    expect(h.calls).toHaveLength(1);
  });

  it('accepts a wait of exactly the cap', async () => {
    const h = setup([json({ retry_after: MAX_RATE_LIMIT_WAIT_MS / 1000 }, 429), json([])]);
    await anyGet(h.client);
    expect(h.sleeps).toEqual([MAX_RATE_LIMIT_WAIT_MS]);
  });

  it('remembers a rejected long wait: the same route fails fast instead of hammering Discord', async () => {
    const h = setup([json({ retry_after: 900 }, 429), json([])]);
    await errorOf(anyGet(h.client));
    const again = await errorOf(anyGet(h.client));
    expect(again.kind).toBe('rate-limited');
    expect(again.retryAfterMs).toBeGreaterThan(MAX_RATE_LIMIT_WAIT_MS);
    expect(h.calls).toHaveLength(1);
  });

  it('a 429 that asks for far more than the cap (Cloudflare / IP-ban style) blocks the WHOLE client, not just that route', async () => {
    let now = 5_000_000;
    const h = setup([new Response('<html>Error 1015</html>', { status: 429, headers: { 'retry-after': '3600' } }), json([{ id: '1' }])], { now: () => now });
    const first = await errorOf(h.client.getMessages('111'));
    expect(first).toMatchObject({ kind: 'rate-limited', status: 429, retryAfterMs: 3_600_000 });

    // other channels, other routes: fail fast without sending anything into the ban
    for (const request of [h.client.getMessages('222'), h.client.getMessages('333'), anyGet(h.client), h.client.getMe(), h.client.searchThreads('4', { archived: false, offset: 0 })]) {
      const error = await errorOf(request);
      expect(error.kind).toBe('rate-limited');
      expect(error.retryAfterMs).toBeGreaterThan(3_500_000);
    }
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);

    // ...and everything works again once the announced time has passed
    now += 3_600_000;
    await expect(h.client.getMessages('222')).resolves.toEqual([{ id: '1' }]);
    expect(h.calls).toHaveLength(2);
  });

  it('a wait between 60 s and the cap holds EVERY route, also when the wait is cancelled', async () => {
    const entered = deferred();
    const controller = new AbortController();
    const waits: number[] = [];
    let blocking = true;
    const h = setup([json({ retry_after: 90 }, 429), json([])], {
      sleep: (ms, signal) => {
        waits.push(ms);
        if (!blocking) return Promise.resolve();
        return new Promise<void>((_, reject) => {
          entered.resolve();
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      },
    });
    const first = errorOf(h.client.getMessages('111', {}, controller.signal));
    await entered.promise;
    controller.abort();
    expect((await first).kind).toBe('aborted');
    expect(h.calls).toHaveLength(1);
    blocking = false;

    // Another route asks right after: the hold of the cancelled wait is still there, so it waits the 90 s first.
    await h.client.getGuildChannels('2');
    expect(waits).toEqual([90_000, 90_000]);
    expect(h.calls).toHaveLength(2);
  });

  it('a per-route wait of 60 s or less leaves the other routes alone even when it was cancelled', async () => {
    const entered = deferred();
    const controller = new AbortController();
    const waits: number[] = [];
    let blocking = true;
    const h = setup([json({ retry_after: 30 }, 429), json([]), json([])], {
      sleep: (ms, signal) => {
        waits.push(ms);
        if (!blocking) return Promise.resolve();
        return new Promise<void>((_, reject) => {
          entered.resolve();
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      },
    });
    const first = errorOf(h.client.getMessages('111', {}, controller.signal));
    await entered.promise;
    controller.abort();
    await first;
    blocking = false;

    await h.client.getMessages('222'); // another channel: the block of channel 111 does not apply
    expect(waits).toEqual([30_000]);
    await h.client.getMessages('111'); // the blocked route still has to wait (the clock did not advance)
    expect(waits).toEqual([30_000, 30_000]);
  });

  it('remembers a rejected global limit for every route', async () => {
    const h = setup([json({ retry_after: 900, global: true }, 429)]);
    await errorOf(anyGet(h.client));
    expect((await errorOf(h.client.getGuildChannels('1'))).kind).toBe('rate-limited');
    expect(h.calls).toHaveLength(1);
  });

  it('retries a 429 at most 6 times', async () => {
    const h = setup(Array.from({ length: 8 }, () => json({ retry_after: 0.1 }, 429)));
    const error = await errorOf(anyGet(h.client));
    expect(error.kind).toBe('rate-limited');
    expect(error.retryAfterMs).toBe(100);
    expect(h.calls).toHaveLength(7);
    expect(h.sleeps).toEqual([100, 100, 100, 100, 100, 100]);
  });

  it('can recover after several 429s in a row', async () => {
    const h = setup([json({ retry_after: 0.5 }, 429), json({ retry_after: 0.5 }, 429), json([])]);
    await anyGet(h.client);
    expect(h.sleeps).toEqual([500, 500]);
  });

  it('waits for the bucket reset when X-RateLimit-Remaining is 0 (only for that route)', async () => {
    const exhausted = { 'x-ratelimit-bucket': 'bkt', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '2.5' };
    const h = setup([
      json([], 200, exhausted), // roles of guild 1: exhausted
      json([]), // channels of guild 1: other route, no wait
      json([], 200, { 'x-ratelimit-bucket': 'bkt', 'x-ratelimit-remaining': '4', 'x-ratelimit-reset-after': '2.5' }), // roles again, after the wait
      json([]), // roles a third time: requests remain
    ]);
    await anyGet(h.client);
    await h.client.getGuildChannels('1');
    expect(h.sleeps).toEqual([]);
    await anyGet(h.client);
    expect(h.sleeps).toEqual([2500]);
    await anyGet(h.client);
    expect(h.sleeps).toEqual([2500]);
  });

  it('fails with "rate-limited" instead of sleeping when a bucket reset is far away', async () => {
    const h = setup([json([], 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '3600' })]);
    await anyGet(h.client);
    const error = await errorOf(anyGet(h.client));
    expect(error.kind).toBe('rate-limited');
    expect(error.retryAfterMs).toBe(3_600_000);
    expect(h.calls).toHaveLength(1);
  });

  it('ignores rate-limit headers that are absent (user accounts often send none)', async () => {
    const h = setup([json([]), json([]), json([])]);
    for (let i = 0; i < 3; i++) await anyGet(h.client);
    expect(h.sleeps).toEqual([]);
  });
});

describe('LiveDiscordClient: pacing of paged requests (docs/PLAN.md §6.2)', () => {
  const paced = { pageGap: DEFAULT_PAGE_GAP, random: () => 0.5 };

  it('does not pause at all with no gap configured (what tests inject)', async () => {
    const h = setup(Array.from({ length: 6 }, () => json([])), { pageGap: NO_GAP });
    for (let i = 0; i < 6; i++) await h.client.getMessages('111');
    expect(h.sleeps).toEqual([]);
    expect(h.calls).toHaveLength(6);
  });

  it('is 0.7 - 1.5 s by default', async () => {
    const h = setup([json([]), json([])], { pageGap: undefined, random: () => 0 });
    await h.client.getMessages('111');
    await h.client.getMessages('111', { before: '5' });
    expect(h.sleeps).toEqual([700]);

    const high = setup([json([]), json([])], { pageGap: undefined, random: () => 0.999999 });
    await high.client.getMessages('111');
    await high.client.getMessages('111', { before: '5' });
    expect(high.sleeps).toEqual([1500]);
  });

  it('waits a drawn gap between consecutive message pages, never before the first one', async () => {
    const h = setup(Array.from({ length: 4 }, () => json([])), paced);
    await h.client.getMessages('111');
    expect(h.sleeps).toEqual([]);
    await h.client.getMessages('111', { before: '9' });
    await h.client.getMessages('111', { before: '8' });
    await h.client.getMessages('111', { before: '7' });
    expect(h.sleeps).toEqual([1100, 1100, 1100]);
  });

  it('draws a fresh gap each time', async () => {
    const draws = [0, 0.999999, 0.5];
    const h = setup(Array.from({ length: 4 }, () => json([])), { pageGap: DEFAULT_PAGE_GAP, random: () => draws.shift() ?? 0 });
    for (let i = 0; i < 4; i++) await h.client.getMessages('111', { before: String(9 - i) });
    expect(h.sleeps).toEqual([700, 1500, 1100]);
  });

  it('counts the time that has passed since the previous page', async () => {
    const h = setup([json([]), json([]), json([])], paced);
    await h.client.getMessages('111');
    h.advance(400);
    await h.client.getMessages('111', { before: '9' });
    expect(h.sleeps).toEqual([700]);
    h.advance(5000);
    await h.client.getMessages('111', { before: '8' });
    expect(h.sleeps).toEqual([700]);
  });

  it('does not pause between requests that are not pages (channel / guild lookups)', async () => {
    const h = setup([json({ id: '1', type: 0 }), json({ id: '2' }), json([]), json([])], paced);
    await h.client.getChannel('1');
    await h.client.getGuild('2');
    await h.client.getGuildChannels('2');
    await h.client.getGuildRoles('2');
    expect(h.sleeps).toEqual([]);
  });

  it('keeps the gap to the previous page across other requests', async () => {
    const h = setup([json([]), json({ id: '1', type: 0 }), json([])], paced);
    await h.client.getMessages('111');
    await h.client.getChannel('1');
    await h.client.getMessages('111', { before: '9' });
    expect(h.sleeps).toEqual([1100]);
  });

  it('paces thread-search pages and URL refresh batches like message pages', async () => {
    const h = setup([json({ threads: [] }), json({ threads: [] }), json({ refreshed_urls: [] }), json([])], paced);
    await h.client.searchThreads('1', { archived: false, offset: 0 });
    await h.client.searchThreads('1', { archived: true, offset: 0 });
    await h.client.refreshAttachmentUrls(['https://cdn.discordapp.com/attachments/1/2/a.png']);
    await h.client.getMessages('1');
    expect(h.sleeps).toEqual([1100, 1100, 1100]);
  });

  it('counts a failed request as a page too (the next one still waits)', async () => {
    const h = setup([json({ message: 'nope', code: 50001 }, 403), json([])], paced);
    await errorOf(h.client.getMessages('111'));
    await h.client.getMessages('111', { before: '9' });
    expect(h.sleeps).toEqual([1100]);
  });

  it('is cancellable like every other wait', async () => {
    const entered = deferred();
    const controller = new AbortController();
    const h = setup([json([]), json([])], { ...paced, sleep: sleepUntilAborted(() => entered.resolve()) });
    await h.client.getMessages('111');
    const second = errorOf(h.client.getMessages('111', { before: '9' }, controller.signal));
    await entered.promise;
    controller.abort();
    expect((await second).kind).toBe('aborted');
    expect(h.calls).toHaveLength(1);
  });

  it('combines with a rate-limit wait instead of adding to it', async () => {
    const h = setup([json([], 200, { 'x-ratelimit-bucket': 'b', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '3' }), json([])], paced);
    await h.client.getMessages('111');
    await h.client.getMessages('111', { before: '9' });
    // The 3 s bucket reset is waited; the 1.1 s page gap has passed by then.
    expect(h.sleeps).toEqual([3000]);
  });
});

describe('LiveDiscordClient: onPause / onResume', () => {
  it('announce a rate-limit wait of two seconds or more, with its length and end time', async () => {
    const events: Array<PauseEvent | 'resume'> = [];
    const h = setup([json({ retry_after: 3 }, 429), json([])], {
      onPause: (event) => events.push(event),
      onResume: () => events.push('resume'),
    });
    await anyGet(h.client);
    expect(events).toEqual([{ reason: 'rate-limit', waitMs: 3000, resumeAt: 1_000_000 + 3000 }, 'resume']);
  });

  it('stay quiet for short waits', async () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const h = setup([json({ retry_after: 1 }, 429), json([])], { onPause, onResume });
    await anyGet(h.client);
    expect(onPause).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it('announce the waits of a block page as "blocked"', async () => {
    const events: Array<PauseEvent | 'resume'> = [];
    const h = setup([blockPage(), json([])], { onPause: (event) => events.push(event), onResume: () => events.push('resume') });
    await anyGet(h.client);
    expect(events).toEqual([{ reason: 'blocked', waitMs: 30_000, resumeAt: 1_000_000 + 30_000 }, 'resume']);
  });

  it('call onResume when the wait is cancelled, and a throwing callback never breaks the request', async () => {
    const entered = deferred();
    const controller = new AbortController();
    const onResume = vi.fn();
    const h = setup([json({ retry_after: 30 }, 429)], {
      sleep: sleepUntilAborted(() => entered.resolve()),
      onPause: () => {
        throw new Error('broken callback');
      },
      onResume,
    });
    const request = errorOf(anyGet(h.client, controller.signal));
    await entered.promise;
    controller.abort();
    expect((await request).kind).toBe('aborted');
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});

describe('LiveDiscordClient: error mapping', () => {
  it('maps 401 to "auth" and calls onAuthError only once per rejected value, without retrying', async () => {
    const onAuthError = vi.fn();
    const h = setup([json({ message: '401: Unauthorized', code: 0 }, 401), json({ message: '401: Unauthorized', code: 0 }, 401)], { onAuthError });
    const first = await errorOf(h.client.getMe());
    expect(first).toMatchObject({ kind: 'auth', status: 401 });
    expect((await errorOf(h.client.getChannel('1'))).kind).toBe('auth');
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toEqual([]);
  });

  it('hands onAuthError the value that was actually sent for the failing request', async () => {
    const onAuthError = vi.fn();
    const h = setup([json({}, 401)], { onAuthError });
    await errorOf(h.client.getMe());
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(onAuthError).toHaveBeenCalledWith(TOKEN);
  });

  it('reports the value of the attempt that got the 401, not the one resolved first (refreshed during a 429 wait)', async () => {
    const values = ['T1-stale', 'T2-fresh'];
    const onAuthError = vi.fn();
    const h = setup([json({ retry_after: 5 }, 429), json({}, 401)], { getAuthorization: () => values.shift() ?? null, onAuthError });
    expect((await errorOf(anyGet(h.client))).kind).toBe('auth');
    expect(onAuthError).toHaveBeenCalledExactlyOnceWith('T2-fresh');
  });

  it('reports a different rejected value again, but never the same one twice', async () => {
    const values = ['T1', 'T1', 'T2', 'T2'];
    const onAuthError = vi.fn();
    const h = setup(Array.from({ length: 4 }, () => json({}, 401)), { getAuthorization: () => values.shift() ?? null, onAuthError });
    for (let i = 0; i < 4; i++) await errorOf(h.client.getMe());
    expect(onAuthError.mock.calls).toEqual([['T1'], ['T2']]);
  });

  it('still reports "auth" when the onAuthError callback throws', async () => {
    const h = setup([json({}, 401)], {
      onAuthError: () => {
        throw new Error('callback failure');
      },
    });
    expect((await errorOf(h.client.getMe())).kind).toBe('auth');
  });

  describe('HTTP 403', () => {
    it.each([
      [50001, 'Missing Access'],
      [50013, 'Missing Permissions'],
      [50009, 'Channel verification level is too high for you to gain access to this resource'],
    ])('code %i means "forbidden" and the code is exposed', async (code, message) => {
      const h = setup([json({ message, code }, 403)]);
      const error = await errorOf(h.client.getMessages('123'));
      expect(error).toMatchObject({ kind: 'forbidden', status: 403, code });
      expect(error.message).toContain(String(code));
      expect(error.message).toContain('/channels/123/messages');
      expect(h.calls).toHaveLength(1);
      expect(h.sleeps).toEqual([]);
    });

    it.each([
      [40333, 'internal network error'],
      [10008, 'Unknown Message'],
      [20001, 'Something account level'],
      [999999, 'A code nobody has heard of'],
    ])('JSON code %i (not a missing permission) is "unknown", never "forbidden" and never retried', async (code, message) => {
      const h = setup([json({ message, code }, 403)]);
      const error = await errorOf(h.client.getMessages('123'));
      expect(error).toMatchObject({ kind: 'unknown', status: 403, code });
      expect(error.message).toContain(String(code));
      expect(error.message).not.toMatch(/no access/i);
      expect(h.calls).toHaveLength(1);
      expect(h.sleeps).toEqual([]);
    });

    it.each([
      ['a JSON body without a code', () => json({ message: '403: Forbidden' }, 403)],
      ['a generic code 0', () => json({ message: '403: Forbidden', code: 0 }, 403)],
    ])('%s is "unknown" with no code and a message that does not claim "no access"', async (_label, reply) => {
      const h = setup([reply()]);
      const error = await errorOf(h.client.getMessages('123'));
      expect(error).toMatchObject({ kind: 'unknown', status: 403 });
      expect(error.code).toBeUndefined();
      expect(error.message).toContain('403');
      expect(error.message).not.toMatch(/no access|missing access/i);
    });
  });

  describe('HTTP 404 and Discord code 10003', () => {
    it('404 is "not-found" with or without a Discord body', async () => {
      const h = setup([json({ message: 'Unknown Channel', code: 10003 }, 404), new Response('', { status: 404 }), json('just a string', 404)]);
      expect(await errorOf(h.client.getMe())).toMatchObject({ kind: 'not-found', status: 404, code: 10003 });
      expect((await errorOf(h.client.getMe())).kind).toBe('not-found');
      expect((await errorOf(h.client.getMe())).kind).toBe('not-found');
    });

    it('code 10003 is "not-found" whatever the status', async () => {
      const h = setup([json({ message: 'Unknown Channel', code: 10003 }, 400), json({ message: 'Unknown Channel', code: 10003 }, 403)]);
      expect(await errorOf(h.client.getMessages('1'))).toMatchObject({ kind: 'not-found', status: 400, code: 10003 });
      expect(await errorOf(h.client.getMessages('1'))).toMatchObject({ kind: 'not-found', status: 403, code: 10003 });
    });
  });

  describe('400 / 403 without a JSON error body = blocked (docs/PLAN.md §6.2)', () => {
    it.each([
      ['an HTML page', () => blockPage(403)],
      ['an HTML page on a 400', () => blockPage(400)],
      ['an empty body', () => new Response('', { status: 403 })],
      ['a plain-text body', () => new Response('error code: 1020', { status: 403 })],
      ['a JSON value that is not an object', () => json('Forbidden', 403)],
    ])('%s is retried after 30, 60 and 120 s and then reported as "blocked"', async (_label, reply) => {
      const h = setup([reply(), reply(), reply(), reply(), json([])]);
      const error = await errorOf(anyGet(h.client));
      expect(error).toMatchObject({ kind: 'blocked' });
      expect(error.status).toBe(reply().status);
      expect(h.sleeps).toEqual([...BLOCKED_RETRY_WAITS_MS]);
      expect(h.sleeps).toEqual([30_000, 60_000, 120_000]);
      expect(h.calls).toHaveLength(4);
      expect(error.message).toMatch(/blocked|refused/i);
    });

    it('recovers when a retry gets a real answer', async () => {
      const h = setup([blockPage(), blockPage(), json([{ id: '1', type: 0 }])]);
      await expect(h.client.getGuildChannels('1')).resolves.toEqual([{ id: '1', type: 0 }]);
      expect(h.sleeps).toEqual([30_000, 60_000]);
    });

    it('a block page holds EVERY route for the wait, also when that wait is cancelled', async () => {
      const entered = deferred();
      const controller = new AbortController();
      const waits: number[] = [];
      let blocking = true;
      const h = setup([blockPage(), json([]), json([])], {
        sleep: (ms, signal) => {
          waits.push(ms);
          if (!blocking) return Promise.resolve();
          return new Promise<void>((_, reject) => {
            entered.resolve();
            signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          });
        },
      });
      const first = errorOf(h.client.getMessages('111', {}, controller.signal));
      await entered.promise;
      controller.abort();
      await first;
      blocking = false;
      await h.client.getGuildChannels('2'); // a different route still waits for the hold
      expect(waits).toEqual([30_000, 30_000]);
    });

    it('a JSON error body is never a block page: a 400 with a Discord code is "unknown" at once', async () => {
      const h = setup([json({ message: 'Invalid Form Body', code: 50035 }, 400)]);
      const error = await errorOf(anyGet(h.client));
      expect(error).toMatchObject({ kind: 'unknown', status: 400, code: 50035 });
      expect(h.sleeps).toEqual([]);
      expect(h.calls).toHaveLength(1);
    });

    it('is cancellable while it waits', async () => {
      const entered = deferred();
      const controller = new AbortController();
      const h = setup([blockPage(), json([])], { sleep: sleepUntilAborted(() => entered.resolve()) });
      const request = errorOf(anyGet(h.client, controller.signal));
      await entered.promise;
      controller.abort();
      expect((await request).kind).toBe('aborted');
      expect(h.calls).toHaveLength(1);
    });
  });

  it('exposes the Discord error code on other errors too', async () => {
    const h = setup([
      json({ message: 'Unknown Channel', code: 10003 }, 404),
      json({ message: '401: Unauthorized', code: 0 }, 401),
      json({ message: 'Invalid Form Body', code: 50035 }, 400),
      json({ message: 'The resource is being rate limited.', code: 20028, retry_after: 6000 }, 429),
    ]);
    expect(await errorOf(h.client.getMe())).toMatchObject({ kind: 'not-found', code: 10003 });
    expect((await errorOf(h.client.getMe())).code).toBeUndefined();
    expect(await errorOf(h.client.getMe())).toMatchObject({ kind: 'unknown', code: 50035 });
    expect(await errorOf(h.client.getMe())).toMatchObject({ kind: 'rate-limited', code: 20028 });
  });

  it('copes with error bodies that are not Discord JSON', async () => {
    const h = setup([json('just a string', 404), json({ message: 'x'.repeat(5000) }, 409)]);
    expect((await errorOf(h.client.getMe())).kind).toBe('not-found');
    expect((await errorOf(h.client.getMe())).message.length).toBeLessThan(400);
  });

  it('retries 5xx with exponential back-off and jitter, then succeeds', async () => {
    const h = setup([json({ message: 'oops' }, 503), new Response('bad gateway', { status: 502 }), json([])]);
    await anyGet(h.client);
    expect(h.sleeps).toEqual([backoffDelayMs(0, () => 0.5), backoffDelayMs(1, () => 0.5)]);
    expect(h.sleeps).toEqual([750, 1500]);
    expect(h.calls).toHaveLength(3);
  });

  it('gives up on 5xx after 3 retries with kind "server"', async () => {
    const h = setup(Array.from({ length: 6 }, () => json({ message: 'down' }, 500)));
    const error = await errorOf(anyGet(h.client));
    expect(error).toMatchObject({ kind: 'server', status: 500 });
    expect(h.calls).toHaveLength(4);
    expect(h.sleeps).toHaveLength(3);
    expect(h.sleeps[2]!).toBeGreaterThan(h.sleeps[0]!);
  });

  it('retries network errors, then succeeds', async () => {
    const h = setup([new TypeError('fetch failed'), new TypeError('fetch failed'), json([])]);
    await anyGet(h.client);
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toHaveLength(2);
  });

  it('gives up on network errors after 3 retries with kind "network" and keeps the cause', async () => {
    const cause = new TypeError('fetch failed');
    const h = setup(Array.from({ length: 6 }, () => cause));
    const error = await errorOf(anyGet(h.client));
    expect(error.kind).toBe('network');
    expect(error.cause).toBe(cause);
    expect(h.calls).toHaveLength(4);
  });

  it('wraps a failing sleep implementation instead of leaking a raw error', async () => {
    const h = setup([json({}, 503), json([])], {
      sleep: async () => {
        throw new Error('timer broke');
      },
    });
    expect((await errorOf(anyGet(h.client))).kind).toBe('unknown');
  });
});

describe('LiveDiscordClient: abort', () => {
  it('rejects without any request when the signal is already aborted', async () => {
    const h = setup([]);
    const controller = new AbortController();
    controller.abort();
    const error = await errorOf(anyGet(h.client, controller.signal));
    expect(error.kind).toBe('aborted');
    expect(error.name).toBe('AbortError');
    expect(h.calls).toHaveLength(0);
  });

  it('cancels a rate-limit wait', async () => {
    const entered = deferred();
    const controller = new AbortController();
    const h = setup([json({ retry_after: 30 }, 429), json([])], { sleep: sleepUntilAborted(() => entered.resolve()) });
    const request = errorOf(anyGet(h.client, controller.signal));
    await entered.promise;
    controller.abort();
    expect((await request).kind).toBe('aborted');
    expect(h.calls).toHaveLength(1);
  });

  it('cancels a back-off wait after a 5xx', async () => {
    const entered = deferred();
    const controller = new AbortController();
    const h = setup([json({}, 500), json([])], {
      sleep: (_ms, signal) =>
        new Promise<void>((_, reject) => {
          entered.resolve();
          signal?.addEventListener('abort', () => reject(new Error('whatever the sleeper throws')));
        }),
    });
    const request = errorOf(anyGet(h.client, controller.signal));
    await entered.promise;
    controller.abort();
    expect((await request).kind).toBe('aborted');
    expect(h.calls).toHaveLength(1);
  });

  it('cancels an in-flight request and does not retry it', async () => {
    const started = deferred();
    const controller = new AbortController();
    const h = setup([hangUntilAborted(() => started.resolve()), json([])]);
    const request = errorOf(anyGet(h.client, controller.signal));
    await started.promise;
    controller.abort();
    expect((await request).kind).toBe('aborted');
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it('passes the signal on to the transport', async () => {
    const controller = new AbortController();
    const h = setup([json([])]);
    await anyGet(h.client, controller.signal);
    expect(h.calls[0]!.init.signal).toBe(controller.signal);
  });

  it('cancels a request that is still waiting in the queue, without disturbing the others', async () => {
    const gate = deferred<Response>();
    const h = setup([() => gate.promise, json([{ id: '9', type: 0 }])]);

    const first = h.client.getMe();
    const controller = new AbortController();
    const queued = errorOf(h.client.getChannel('3', controller.signal));
    const third = h.client.getGuildChannels('4');

    controller.abort();
    expect((await queued).kind).toBe('aborted');
    expect(h.calls).toHaveLength(1); // the aborted request never reached fetch, the first one is still in flight

    gate.resolve(json({ id: '1', username: 'me' }));
    await expect(first).resolves.toMatchObject({ username: 'me' });
    await expect(third).resolves.toEqual([{ id: '9', type: 0 }]);
    expect(h.urls()).toEqual([`${BASE}/users/@me`, `${BASE}/guilds/4/channels`]);
  });
});

describe('LiveDiscordClient: strictly serial processing', () => {
  it('never has two requests in flight and keeps call order', async () => {
    let active = 0;
    let maxActive = 0;
    const reply: Reply = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active--;
      return json([]);
    };
    const h = setup(Array.from({ length: 5 }, () => reply));
    await Promise.all([
      h.client.getGuildRoles('1'),
      h.client.getGuildChannels('1'),
      h.client.getGuildRoles('2'),
      h.client.getMessages('3'),
      h.client.getMessages('4', { before: '5' }),
    ]);
    expect(maxActive).toBe(1);
    expect(h.urls()).toEqual([
      `${BASE}/guilds/1/roles`,
      `${BASE}/guilds/1/channels`,
      `${BASE}/guilds/2/roles`,
      `${BASE}/channels/3/messages?limit=50`,
      `${BASE}/channels/4/messages?limit=50&before=5`,
    ]);
  });

  it('keeps one request at a time even while another one is retrying', async () => {
    let active = 0;
    let maxActive = 0;
    const track =
      (response: () => Response): Reply =>
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        return response();
      };
    const h = setup([track(() => json({}, 503)), track(() => json([])), track(() => json([]))]);
    await Promise.all([anyGet(h.client), h.client.getGuildChannels('1')]);
    expect(maxActive).toBe(1);
    // The retry of the first request goes before the second request starts.
    expect(h.urls()).toEqual([ANY_URL, ANY_URL, `${BASE}/guilds/1/channels`]);
  });
});
