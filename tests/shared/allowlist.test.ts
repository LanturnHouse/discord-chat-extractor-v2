import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  API_BASE_PATH,
  API_GET_ALLOWLIST,
  TRANSPORT_ALLOWLIST,
  isApiGetPathAllowed,
  isTransportRequestAllowed,
} from '@/shared';

const CHANNEL = '987654321098765432';
const GUILD = '123456789012345678';
const REFRESH = '/api/v9/attachments/refresh-urls';

describe('isTransportRequestAllowed: allow-listed requests', () => {
  const getPaths = [
    '/api/v9/users/@me',
    '/api/v9/users/@me?with_analytics_token=false',
    `/api/v9/users/@me/guilds/${GUILD}/member`,
    `/api/v9/channels/${CHANNEL}`,
    `/api/v9/channels/${CHANNEL}/messages`,
    `/api/v9/channels/${CHANNEL}/messages?limit=100`,
    `/api/v9/channels/${CHANNEL}/messages?limit=100&before=${CHANNEL}`,
    `/api/v9/channels/${CHANNEL}/threads/search?archived=true&sort_by=last_message_time&sort_order=desc&limit=25&offset=0`,
    `/api/v9/channels/${CHANNEL}/threads/archived/public?limit=25`,
    `/api/v9/guilds/${GUILD}`,
    `/api/v9/guilds/${GUILD}/channels`,
    `/api/v9/guilds/${GUILD}/roles`,
    `/api/v9/guilds/${GUILD}/members/@me`,
    '/api/v9/users/@me?',
    '/api/v9/channels/1',
    '/api/v9/channels/000123/messages', // leading zeros are still digits
  ];

  it.each(getPaths)('GET %s', (path) => {
    expect(isTransportRequestAllowed('GET', path)).toBe(true);
  });

  it('POST is allowed on exactly /api/v9/attachments/refresh-urls', () => {
    expect(isTransportRequestAllowed('POST', REFRESH)).toBe(true);
  });

  it('GET on the refresh-urls path passes the allow-list too (the plan allows GET on every listed path)', () => {
    expect(isTransportRequestAllowed('GET', REFRESH)).toBe(true);
  });
});

describe('isTransportRequestAllowed: methods', () => {
  it.each(['PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE', 'get', 'Get', 'post', ' GET', 'GET ', 'GET\n', ''])(
    'refuses method %j on an allow-listed GET path',
    (method) => {
      expect(isTransportRequestAllowed(method, `/api/v9/channels/${CHANNEL}/messages?limit=100`)).toBe(false);
    },
  );

  it.each([
    '/api/v9/users/@me',
    `/api/v9/channels/${CHANNEL}`,
    `/api/v9/channels/${CHANNEL}/messages`,
    `/api/v9/guilds/${GUILD}/roles`,
    `/api/v9/users/@me/guilds/${GUILD}/member`,
  ])('refuses POST on %s (only refresh-urls takes POST)', (path) => {
    expect(isTransportRequestAllowed('POST', path)).toBe(false);
  });

  it('refuses POST with a query string even on refresh-urls (the endpoint takes a JSON body)', () => {
    expect(isTransportRequestAllowed('POST', `${REFRESH}?x=1`)).toBe(false);
    expect(isTransportRequestAllowed('POST', `${REFRESH}?`)).toBe(false);
  });

  it('refuses POST on near-misses of refresh-urls', () => {
    expect(isTransportRequestAllowed('POST', `${REFRESH}/`)).toBe(false);
    expect(isTransportRequestAllowed('POST', `${REFRESH}x`)).toBe(false);
    expect(isTransportRequestAllowed('POST', '/api/v10/attachments/refresh-urls')).toBe(false);
    expect(isTransportRequestAllowed('POST', '/api/v9/attachments')).toBe(false);
    expect(isTransportRequestAllowed('POST', '/api/v9/attachments/refresh-url')).toBe(false);
  });

  it('refuses non-string methods', () => {
    expect(isTransportRequestAllowed(undefined as unknown as string, '/api/v9/users/@me')).toBe(false);
    expect(isTransportRequestAllowed(null as unknown as string, '/api/v9/users/@me')).toBe(false);
    expect(isTransportRequestAllowed(['GET'] as unknown as string, '/api/v9/users/@me')).toBe(false);
  });
});

describe('isTransportRequestAllowed: paths that are not on the list', () => {
  const notListed = [
    // other API versions / prefixes / casing
    '/api/v10/users/@me',
    '/api/v8/users/@me',
    '/api/v9.1/users/@me',
    '/api/users/@me',
    '/api/v9',
    '/api/v9/',
    '/API/v9/users/@me',
    '/Api/v9/users/@me',
    'api/v9/users/@me',
    '/v9/users/@me',
    '/users/@me',
    // right area, wrong shape
    '/api/v9/users/@me/',
    '/api/v9/users/@me/guilds',
    '/api/v9/users/@me/channels',
    '/api/v9/users/@me/billing/payment-sources',
    '/api/v9/users/@me/relationships',
    '/api/v9/users/123456789',
    `/api/v9/users/@me/guilds/${GUILD}`,
    `/api/v9/users/@me/guilds/${GUILD}/member/extra`,
    '/api/v9/users/@me/guilds/abc/member',
    '/api/v9/users/@me/guilds//member',
    '/api/v9/channels',
    '/api/v9/channels/',
    '/api/v9/channels/abc',
    '/api/v9/channels/abc/messages',
    '/api/v9/channels/12a3/messages',
    '/api/v9/channels/-1/messages',
    '/api/v9/channels/1.5/messages',
    '/api/v9/channels//messages',
    '/api/v9/channels/123/messages/',
    '/api/v9/channels/123/messages/456',
    '/api/v9/channels/123/messages/456/reactions',
    '/api/v9/channels/123/pins',
    '/api/v9/channels/123/invites',
    '/api/v9/channels/123/webhooks',
    '/api/v9/channels/123/typing',
    '/api/v9/channels/123/threads',
    '/api/v9/channels/123/threads/archived/private',
    '/api/v9/channels/123/threads/archived/public/extra',
    '/api/v9/channels/123/threads/search/extra',
    '/api/v9/guilds',
    '/api/v9/guilds/',
    '/api/v9/guilds/abc',
    '/api/v9/guilds/123/members',
    '/api/v9/guilds/123/members/456',
    '/api/v9/guilds/123/members/@me/extra',
    '/api/v9/guilds/123/audit-logs',
    '/api/v9/guilds/123/invites',
    '/api/v9/guilds/123/bans',
    '/api/v9/guilds/123/threads/active',
    '/api/v9/guilds/123/channels/456',
    '/api/v9/guilds/123/roles/456',
    '/api/v9/attachments',
    '/api/v9/attachments/',
    '/api/v9/attachments/refresh-urls/',
    '/api/v9/attachments/refresh-urls/extra',
    '/api/v9/auth/login',
    '/api/v9/oauth2/tokens',
    '/api/v9/science',
    '/api/v9/applications',
    '',
    '/',
  ];

  it.each(notListed)('GET %j', (path) => {
    expect(isTransportRequestAllowed('GET', path)).toBe(false);
  });
});

describe('isTransportRequestAllowed: path traversal and encoding tricks', () => {
  const tricks = [
    // dot segments
    '/api/v9/channels/123/../users/@me',
    '/api/v9/channels/123/messages/../../../users/@me/billing',
    '/api/v9/channels/123/./messages',
    '/api/v9/../v10/users/@me',
    '/api/v9/users/@me/../../../../etc/passwd',
    '/api/v9/channels/123/messages/..',
    '/api/v9/channels/../messages',
    '/api/v9/channels/.../messages',
    '/../api/v9/users/@me',
    '/api/v9/channels/123/..%2f..%2fusers/@me',
    // percent-encoded slashes, dots, backslashes and digits
    '/api/v9/channels/123%2fmessages',
    '/api/v9/channels/123%2Fmessages',
    '/api/v9/channels%2f123/messages',
    '/api/v9%2fusers/@me',
    '/api%2fv9/users/@me',
    '/api/v9/channels/123/%2e%2e/users/@me',
    '/api/v9/channels/123/%2E%2E/%2E%2E/users/@me',
    '/api/v9/channels/%2e%2e/messages',
    '/api/v9/channels/%31%32%33/messages',
    '/api/v9/channels/123%5cmessages',
    '/api/v9/channels/123/messages%00',
    '/api/v9/users/%40me',
    '/api/v9/users/@me%2f',
    // double encoding
    '/api/v9/channels/123%252fmessages',
    // backslashes (some parsers treat them as slashes)
    '/api/v9/channels/123\\messages',
    '/api\\v9/users/@me',
    '\\api\\v9\\users\\@me',
    '/api/v9/channels/123/messages?x=\\..\\..',
    // fragments never belong to a request path
    '/api/v9/users/@me#fragment',
    '/api/v9/users/@me?x=1#fragment',
    '/api/v9/users/@me#/../../x',
    // doubled slashes
    '//api/v9/users/@me',
    '/api//v9/users/@me',
    '/api/v9//users/@me',
    '/api/v9/channels//123/messages',
  ];

  it.each(tricks)('refuses %j', (path) => {
    expect(isTransportRequestAllowed('GET', path)).toBe(false);
    expect(isTransportRequestAllowed('POST', path)).toBe(false);
  });
});

describe('isTransportRequestAllowed: other hosts', () => {
  const hosts = [
    'https://discord.com/api/v9/users/@me',
    'https://evil.example/api/v9/users/@me',
    `https://evil.example/api/v9/channels/${CHANNEL}/messages`,
    'http://discord.com/api/v9/users/@me',
    'http://localhost/api/v9/users/@me',
    'http://127.0.0.1:5858/api/v9/users/@me',
    '//discord.com/api/v9/users/@me',
    '//evil.example/api/v9/users/@me',
    '///evil.example/api/v9/users/@me',
    '/\\evil.example/api/v9/users/@me',
    '\\\\evil.example/api/v9/users/@me',
    'discord.com/api/v9/users/@me',
    '@evil.example/api/v9/users/@me',
    'https://cdn.discordapp.com/api/v9/users/@me',
    'javascript:alert(1)',
    'data:text/plain,/api/v9/users/@me',
    'file:///api/v9/users/@me',
    `https://evil.example/?next=/api/v9/channels/${CHANNEL}/messages`,
    '/redirect?to=https://evil.example/api/v9/users/@me',
  ];

  it.each(hosts)('refuses %j', (path) => {
    expect(isTransportRequestAllowed('GET', path)).toBe(false);
    expect(isTransportRequestAllowed('POST', path)).toBe(false);
  });
});

describe('isTransportRequestAllowed: query strings and control characters', () => {
  it('lets the query string carry anything printable (it never reaches the route)', () => {
    expect(isTransportRequestAllowed('GET', `/api/v9/channels/${CHANNEL}/messages?limit=100&before=1&after=2&around=3`)).toBe(true);
    expect(isTransportRequestAllowed('GET', `/api/v9/channels/${CHANNEL}/messages?a=%2f%2e%2e%2f&b=//x`)).toBe(true);
    expect(isTransportRequestAllowed('GET', '/api/v9/users/@me?x=y?z')).toBe(true);
  });

  it.each([
    ['LF', '/api/v9/users/@me\n'],
    ['CRLF', '/api/v9/users/@me\r\n'],
    ['LF inside the query', '/api/v9/users/@me?x=1\nHost: evil.example'],
    ['CRLF inside the query', '/api/v9/users/@me?x=1\r\nX-Evil: 1'],
    ['TAB in the path', '/api/v9/chan\tnels/123'],
    ['TAB in the query', '/api/v9/users/@me?x=\t1'],
    ['NUL', '/api/v9/users/@me\u0000'],
    ['space in the query', '/api/v9/users/@me?a b'],
    ['leading space', ' /api/v9/users/@me'],
    ['trailing space', '/api/v9/users/@me '],
    ['DEL', '/api/v9/users/@me?x=\u007f'],
    ['line separator', '/api/v9/users/@me?x= '],
    ['non-ASCII digit', '/api/v9/channels/١٢٣/messages'],
    ['full-width digit', '/api/v9/channels/１２３/messages'],
    ['non-ASCII in the query', '/api/v9/users/@me?q=한글'],
    ['non-ASCII slash lookalike', '/api/v9/channels/123∕messages'],
  ])('refuses %s', (_label, path) => {
    expect(isTransportRequestAllowed('GET', path)).toBe(false);
  });

  it('refuses absurdly long paths', () => {
    expect(isTransportRequestAllowed('GET', `/api/v9/channels/1/messages?x=${'a'.repeat(3000)}`)).toBe(false);
    expect(isTransportRequestAllowed('GET', `/api/v9/channels/1/messages?x=${'a'.repeat(1000)}`)).toBe(true);
  });

  it('refuses non-string paths', () => {
    for (const path of [undefined, null, 42, {}, [], ['/api/v9/users/@me'], { toString: () => '/api/v9/users/@me' }]) {
      expect(isTransportRequestAllowed('GET', path as unknown as string)).toBe(false);
    }
  });
});

describe("isApiGetPathAllowed (the background worker's own direct GETs, docs/PLAN.md §8)", () => {
  it.each([
    '/api/v9/users/@me',
    '/api/v9/users/@me?x=1',
    `/api/v9/channels/${CHANNEL}`,
    `/api/v9/channels/${CHANNEL}?x=1`,
    `/api/v9/guilds/${GUILD}`,
    `/api/v9/guilds/${GUILD}?with_counts=true`,
    `/api/v9/guilds/${GUILD}/channels`,
    `/api/v9/guilds/${GUILD}/channels?x=1`,
    // permission filtering for category / server adds (docs/PLAN.md §3)
    `/api/v9/guilds/${GUILD}/roles`,
    `/api/v9/guilds/${GUILD}/members/@me`,
    `/api/v9/users/@me/guilds/${GUILD}/member`,
  ])('allows %s', (path) => {
    expect(isApiGetPathAllowed(path)).toBe(true);
  });

  it.each([
    // on the transport list but not on the background's direct-GET list
    `/api/v9/channels/${CHANNEL}/messages`,
    `/api/v9/channels/${CHANNEL}/messages?limit=100`,
    `/api/v9/channels/${CHANNEL}/threads/search?archived=true`,
    `/api/v9/channels/${CHANNEL}/threads/archived/public`,
    REFRESH,
    `/api/v9/guilds/${GUILD}/roles/1`,
    `/api/v9/users/@me/guilds/${GUILD}/member/x`,
    `/api/v9/users/@me/guilds/${GUILD}`,
    // not on any list
    '/api/v9/users/@me/guilds',
    '/api/v9/users/123',
    `/api/v9/guilds/${GUILD}/members`,
    `/api/v9/guilds/${GUILD}/channels/${CHANNEL}`,
    '/api/v9/channels/abc',
    '/api/v9/guilds/abc/channels',
    // shape / version / casing
    '/api/v10/users/@me',
    '/api/users/@me',
    '/API/v9/users/@me',
    '/api/v9/users/@me/',
    `/api/v9/guilds/${GUILD}/channels/`,
    '',
    '/',
  ])('refuses %j', (path) => {
    expect(isApiGetPathAllowed(path)).toBe(false);
  });

  it.each([
    '/api/v9/channels/123/../users/@me',
    '/api/v9/guilds/123/channels/../../users/@me',
    '/api/v9/channels/123%2f..%2fusers/@me',
    '/api/v9/channels/%2e%2e/123',
    '/api/v9/guilds/123%2fchannels',
    '/api/v9/channels/123\\..\\users',
    '/api/v9/users/@me#fragment',
    '/api/v9/users/@me\r\n',
    '/api/v9/users/@me?a b',
    '//discord.com/api/v9/users/@me',
    'https://discord.com/api/v9/users/@me',
    'https://evil.example/api/v9/users/@me',
    '//evil.example/api/v9/guilds/1',
    '/api/v9//users/@me',
    '/api/v9/channels/１２３',
  ])('refuses the trick %j', (path) => {
    expect(isApiGetPathAllowed(path)).toBe(false);
  });

  it('refuses non-string paths', () => {
    for (const path of [undefined, null, 1, {}, []]) expect(isApiGetPathAllowed(path as unknown as string)).toBe(false);
  });
});

describe('the allow-list constants', () => {
  it('are non-empty, frozen and use stateless regexes (no g/y flag: .test() must not carry lastIndex)', () => {
    for (const list of [TRANSPORT_ALLOWLIST, API_GET_ALLOWLIST]) {
      expect(list.length).toBeGreaterThan(0);
      expect(Object.isFrozen(list)).toBe(true);
      for (const pattern of list) {
        expect(pattern).toBeInstanceOf(RegExp);
        expect(pattern.flags).toBe('');
        expect(pattern.source.startsWith('^')).toBe(true);
        expect(pattern.source.endsWith('$')).toBe(true);
      }
    }
  });

  it('all start with API_BASE_PATH', () => {
    const prefix = `^${API_BASE_PATH.replaceAll('/', '\\/')}\\/`;
    for (const pattern of [...TRANSPORT_ALLOWLIST, ...API_GET_ALLOWLIST]) expect(pattern.source.startsWith(prefix)).toBe(true);
  });

  it('every direct-GET path of the background worker is also a transport path (it is the narrower list)', () => {
    const samples = [
      '/api/v9/users/@me',
      `/api/v9/channels/${CHANNEL}`,
      `/api/v9/guilds/${GUILD}`,
      `/api/v9/guilds/${GUILD}/channels`,
      `/api/v9/guilds/${GUILD}/channels?x=1`,
    ];
    for (const path of samples) {
      expect(isApiGetPathAllowed(path)).toBe(true);
      expect(isTransportRequestAllowed('GET', path)).toBe(true);
    }
  });

  it('TRANSPORT_ALLOWLIST is the pattern of docs/PLAN.md §8', () => {
    const plan = readFileSync(new URL('../../docs/PLAN.md', import.meta.url), 'utf8');
    const quoted = [...plan.matchAll(/`(\^\/api\/v9\/\(users\/@me\|[^`]+)`/g)].map((m) => m[1]);
    expect(quoted).toHaveLength(1);
    expect(TRANSPORT_ALLOWLIST).toHaveLength(1);
    expect(TRANSPORT_ALLOWLIST[0]!.source.replaceAll('\\/', '/')).toBe(quoted[0]);
  });
});
