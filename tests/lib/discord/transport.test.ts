import { describe, expect, it, vi } from 'vitest';
import { DiscordApiError } from '@/lib/discord/client';
import { createFetchTransport, describePath, isTrustedApiUrl } from '@/lib/discord/transport';
import type { TransportRequest } from '@/lib/discord/transport';

const BASE = 'https://discord.com/api/v9';
const TOKEN = 'SECRET.token-value_123';

const request = (overrides: Partial<TransportRequest> = {}): TransportRequest => ({
  method: 'GET',
  path: '/api/v9/users/@me',
  headers: { Authorization: TOKEN },
  ...overrides,
});

function fakeFetch(body = '{}', status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(body, { status });
  });
  return { impl: impl as unknown as typeof fetch, calls, spy: impl };
}

describe('createFetchTransport', () => {
  it('fetches https://discord.com + path with credentials omitted and redirects refused', async () => {
    const f = fakeFetch('{"id":"1"}');
    const transport = createFetchTransport({ fetch: f.impl });
    const controller = new AbortController();
    const response = await transport(request({ path: '/api/v9/channels/123/messages?limit=100&before=5', signal: controller.signal }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"id":"1"}');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe('https://discord.com/api/v9/channels/123/messages?limit=100&before=5');
    expect(f.calls[0]!.init).toMatchObject({
      method: 'GET',
      headers: { Authorization: TOKEN },
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'error',
    });
    expect(f.calls[0]!.init.body).toBeUndefined();
  });

  it('sends the body of a POST', async () => {
    const f = fakeFetch('{"refreshed_urls":[]}');
    const transport = createFetchTransport({ fetch: f.impl });
    await transport(request({ method: 'POST', path: '/api/v9/attachments/refresh-urls', headers: { Authorization: TOKEN, 'Content-Type': 'application/json' }, body: '{"attachment_urls":[]}' }));
    expect(f.calls[0]!.init.method).toBe('POST');
    expect(f.calls[0]!.init.body).toBe('{"attachment_urls":[]}');
    expect(f.calls[0]!.init.headers).toEqual({ Authorization: TOKEN, 'Content-Type': 'application/json' });
  });

  it('uses the global fetch as a plain function when none is injected (a detached fetch throws "Illegal invocation")', async () => {
    const globalFetch = vi.fn(async function (this: unknown, ..._args: unknown[]) {
      expect(this === undefined || this === globalThis).toBe(true);
      return new Response('{}');
    });
    vi.stubGlobal('fetch', globalFetch);
    try {
      await createFetchTransport()(request());
      expect(globalFetch).toHaveBeenCalledTimes(1);
      expect(globalFetch.mock.calls[0]![0]).toBe('https://discord.com/api/v9/users/@me');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('honours a custom base URL, also with a trailing slash', async () => {
    const f = fakeFetch();
    await createFetchTransport({ fetch: f.impl, baseUrl: 'https://proxy.example.test/' })(request());
    expect(f.calls[0]!.url).toBe('https://proxy.example.test/api/v9/users/@me');
  });

  it('rejects an invalid base URL up front, without URL.canParse (missing before Chrome 120)', () => {
    expect(() => createFetchTransport({ baseUrl: 'not a url' })).toThrow(TypeError);
    const withCanParse = URL as unknown as { canParse?: unknown };
    const original = Object.getOwnPropertyDescriptor(URL, 'canParse');
    delete withCanParse.canParse;
    try {
      expect(typeof URL.canParse).toBe('undefined');
      expect(() => createFetchTransport()).not.toThrow();
      expect(() => createFetchTransport({ baseUrl: 'not a url' })).toThrow(TypeError);
    } finally {
      if (original) Object.defineProperty(URL, 'canParse', original);
    }
  });

  it('refuses to send credentials when the base URL carries credentials', async () => {
    const f = fakeFetch();
    const error = await createFetchTransport({ fetch: f.impl, baseUrl: 'https://user:pw@discord.com' })(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscordApiError);
    expect((error as DiscordApiError).kind).toBe('not-allowed');
    expect(f.calls).toHaveLength(0);
  });

  describe('is the last gate before the network: it re-checks the allow-list itself', () => {
    it.each<[string, string]>([
      ['GET', '/api/v9/users/@me/guilds'],
      ['GET', '/api/v9/users/@me/channels'],
      ['GET', '/api/v9/channels/1/messages/2'],
      ['GET', '/api/v8/users/@me'],
      ['GET', 'https://evil.test/api/v9/users/@me'],
      ['GET', '//evil.test/api/v9/users/@me'],
      ['GET', '/api/v9/users/@me/../../../x'],
      ['POST', '/api/v9/channels/1/messages'],
      ['POST', '/api/v9/attachments/refresh-urls?x=1'],
      ['DELETE', '/api/v9/channels/1'],
    ])('%s %s is refused without a fetch', async (method, path) => {
      const f = fakeFetch();
      const transport = createFetchTransport({ fetch: f.impl });
      const error = await transport(request({ method: method as 'GET', path })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DiscordApiError);
      expect((error as DiscordApiError).kind).toBe('not-allowed');
      expect((error as Error).message).not.toContain(TOKEN);
      expect(f.calls).toHaveLength(0);
    });
  });

  it('passes a fetch rejection through untouched (the client classifies it)', async () => {
    const cause = new TypeError('Failed to fetch');
    const transport = createFetchTransport({
      fetch: (async () => {
        throw cause;
      }) as unknown as typeof fetch,
    });
    await expect(transport(request())).rejects.toBe(cause);
  });
});

describe('isTrustedApiUrl', () => {
  it.each([
    ['https://discord.com/api/v9/users/@me', true],
    ['https://discord.com/api/v9', true],
    ['https://discord.com/api/v9/channels/1/messages?limit=5', true],
    ['https://discord.com/api/v9.evil.com/x', false],
    ['https://discord.com/api/v90/x', false],
    ['https://discord.com/api/v9/../../evil', false],
    ['https://discord.com/api/v9/%2e%2e/%2e%2e/evil', false],
    ['https://discord.com.evil.test/api/v9/users/@me', false],
    ['https://evil.test/https://discord.com/api/v9/', false],
    ['https://discord.com@evil.test/api/v9/users/@me', false],
    ['https://user:pw@discord.com/api/v9/users/@me', false],
    ['http://discord.com/api/v9/users/@me', false],
    ['https://discord.com:8443/api/v9/users/@me', false],
    ['https://cdn.discordapp.com/avatars/1/a.png', false],
    ['//evil.test/api/v9/users/@me', false],
    ['not a url', false],
    ['', false],
  ])('isTrustedApiUrl(%s) -> %s', (url, expected) => {
    expect(isTrustedApiUrl(url, BASE)).toBe(expected);
  });

  it('treats an unparsable base as untrusted', () => {
    expect(isTrustedApiUrl('https://discord.com/api/v9/x', 'nope')).toBe(false);
  });
});

describe('describePath', () => {
  it('drops the query string (cursors) and caps the length', () => {
    expect(describePath('/api/v9/channels/1/messages?limit=100&before=9')).toBe('/api/v9/channels/1/messages');
    expect(describePath('/x'.repeat(200))).toHaveLength(123);
    expect(describePath('/x'.repeat(200)).endsWith('...')).toBe(true);
  });
});
