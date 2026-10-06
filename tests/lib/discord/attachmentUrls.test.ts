import { describe, expect, it } from 'vitest';
import { isAttachmentUrlStale, isRefreshableUrl, refreshAttachmentUrls, URL_REFRESH_AFTER_MS } from '@/lib/discord/attachmentUrls';
import { DiscordApiError } from '@/lib/discord/client';
import type { DiscordClient, RefreshedUrl } from '@/lib/discord/client';
import { createMockClient, mockRefreshedUrl } from '@/lib/discord/mock';

const mock = createMockClient({ latencyMs: 0 });

const url = (n: number, host = 'cdn.discordapp.com'): string => `https://${host}/attachments/1/${n}/file${n}.png?ex=65f00000&is=65ef0000&hm=sig${n}&`;

/** A client whose refresh endpoint is `handler`; every batch it receives is recorded. */
function scripted(handler: (urls: readonly string[], call: number) => RefreshedUrl[] | Error) {
  const batches: string[][] = [];
  const client: DiscordClient = {
    ...mock,
    refreshAttachmentUrls: async (urls) => {
      batches.push([...urls]);
      const answer = handler(urls, batches.length - 1);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { client, batches };
}

const echo = (urls: readonly string[]): RefreshedUrl[] => urls.map((original) => ({ original, refreshed: `${original}fresh=1` }));

describe('refreshAttachmentUrls', () => {
  it('returns a Map from every original url to its refreshed url', async () => {
    const s = scripted((urls) => echo(urls));
    const result = await refreshAttachmentUrls(s.client, [url(1), url(2)]);
    expect(result).toBeInstanceOf(Map);
    expect([...result]).toEqual([
      [url(1), `${url(1)}fresh=1`],
      [url(2), `${url(2)}fresh=1`],
    ]);
  });

  it('sends batches of at most 50, in order', async () => {
    const urls = Array.from({ length: 120 }, (_, i) => url(i));
    const s = scripted((batch) => echo(batch));
    const result = await refreshAttachmentUrls(s.client, urls);
    expect(s.batches.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(s.batches.flat()).toEqual(urls);
    expect(result.size).toBe(120);
  });

  it('exactly 50 is one batch, 51 are two, none are none', async () => {
    const a = scripted((batch) => echo(batch));
    await refreshAttachmentUrls(a.client, Array.from({ length: 50 }, (_, i) => url(i)));
    expect(a.batches).toHaveLength(1);
    const b = scripted((batch) => echo(batch));
    await refreshAttachmentUrls(b.client, Array.from({ length: 51 }, (_, i) => url(i)));
    expect(b.batches.map((x) => x.length)).toEqual([50, 1]);
    const c = scripted((batch) => echo(batch));
    expect((await refreshAttachmentUrls(c.client, [])).size).toBe(0);
    expect(c.batches).toHaveLength(0);
  });

  it('asks about each url once and only about Discord CDN urls', async () => {
    const s = scripted((batch) => echo(batch));
    const result = await refreshAttachmentUrls(s.client, [
      url(1),
      url(1),
      url(2, 'media.discordapp.net'),
      'https://example.com/a.png',
      'http://cdn.discordapp.com/attachments/1/2/a.png',
      'https://cdn.discordapp.com.evil.test/attachments/1/2/a.png',
      'https://discord.com/api/v9/users/@me',
      'not a url',
      '',
      7 as unknown as string,
    ]);
    expect(s.batches).toEqual([[url(1), url(2, 'media.discordapp.net')]]);
    expect([...result.keys()]).toEqual([url(1), url(2, 'media.discordapp.net')]);
  });

  it('makes no request at all when nothing is a Discord CDN url', async () => {
    const s = scripted((batch) => echo(batch));
    expect((await refreshAttachmentUrls(s.client, ['https://example.com/x.png', 'nope'])).size).toBe(0);
    expect(s.batches).toHaveLength(0);
  });

  it('leaves out urls Discord did not answer for, so the caller falls back to the original', async () => {
    const s = scripted((batch) => echo(batch.slice(0, 1)));
    const result = await refreshAttachmentUrls(s.client, [url(1), url(2)]);
    expect([...result.keys()]).toEqual([url(1)]);
    expect(result.get(url(2)) ?? url(2)).toBe(url(2));
  });

  it('ignores answers for urls that were not asked about and refreshed urls that do not point at the CDN', async () => {
    const s = scripted(() => [
      { original: url(9), refreshed: `${url(9)}fresh=1` },
      { original: url(1), refreshed: 'https://evil.test/steal.png' },
      { original: url(2), refreshed: 'javascript:alert(1)' },
      { original: url(3), refreshed: '' },
      { original: url(4), refreshed: `${url(4)}fresh=1` },
    ]);
    const result = await refreshAttachmentUrls(s.client, [url(1), url(2), url(3), url(4)]);
    expect([...result]).toEqual([[url(4), `${url(4)}fresh=1`]]);
  });

  it('is best effort: a failed batch ends the refresh and keeps what was refreshed before it', async () => {
    const s = scripted((batch, call) => (call === 1 ? new DiscordApiError('server', 'down', { status: 500 }) : echo(batch)));
    const urls = Array.from({ length: 120 }, (_, i) => url(i));
    const result = await refreshAttachmentUrls(s.client, urls);
    expect(s.batches).toHaveLength(2); // the third batch is not tried after the second failed
    expect(result.size).toBe(50);
    expect([...result.keys()]).toEqual(urls.slice(0, 50));
  });

  it('does not throw for a 401 or a 403 either (the client reports those through its callbacks)', async () => {
    for (const kind of ['auth', 'forbidden', 'blocked', 'rate-limited', 'network'] as const) {
      const s = scripted(() => new DiscordApiError(kind, 'nope'));
      await expect(refreshAttachmentUrls(s.client, [url(1)])).resolves.toEqual(new Map());
    }
    const odd = scripted(() => new TypeError('boom'));
    await expect(refreshAttachmentUrls(odd.client, [url(1)])).resolves.toEqual(new Map());
  });

  it('rejects when the signal is aborted: before the first batch, between batches, and inside a request', async () => {
    const pre = new AbortController();
    pre.abort();
    const a = scripted((batch) => echo(batch));
    await expect(refreshAttachmentUrls(a.client, [url(1)], { signal: pre.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(a.batches).toHaveLength(0);

    const between = new AbortController();
    const b = scripted((batch) => {
      between.abort();
      return echo(batch);
    });
    await expect(
      refreshAttachmentUrls(b.client, Array.from({ length: 80 }, (_, i) => url(i)), { signal: between.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(b.batches).toHaveLength(1);

    const inside = scripted(() => new DiscordApiError('aborted', 'cancelled'));
    await expect(refreshAttachmentUrls(inside.client, [url(1)])).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('passes the signal on to the client', async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const client: DiscordClient = {
      ...mock,
      refreshAttachmentUrls: async (urls, signal) => {
        seen.push(signal);
        return echo(urls);
      },
    };
    await refreshAttachmentUrls(client, [url(1)], { signal: controller.signal });
    expect(seen).toEqual([controller.signal]);
  });

  it('works with the demo client', async () => {
    const result = await refreshAttachmentUrls(mock, [url(1), url(2)]);
    expect(result.get(url(1))).toBe(mockRefreshedUrl(url(1)));
    expect(mockRefreshedUrl(url(1))).toContain('refreshed=1');
  });
});

describe('isRefreshableUrl', () => {
  it.each([
    [url(1), true],
    [url(1, 'media.discordapp.net'), true],
    ['https://CDN.DISCORDAPP.COM/attachments/1/2/a.png', true],
    ['http://cdn.discordapp.com/attachments/1/2/a.png', false],
    ['https://cdn.discordapp.com.evil.test/a.png', false],
    ['https://evil.test/cdn.discordapp.com/a.png', false],
    ['https://discord.com/x', false],
    ['https://images-ext-1.discordapp.net/x', false],
    ['data:image/png;base64,AAAA', false],
    ['', false],
    [null, false],
    [undefined, false],
    [5, false],
  ])('%s -> %s', (value, expected) => {
    expect(isRefreshableUrl(value)).toBe(expected);
  });
});

describe('isAttachmentUrlStale', () => {
  const issued = Date.parse('2026-10-06T00:00:00Z') / 1000;
  const signed = (is: number, ex: number): string => `https://cdn.discordapp.com/attachments/1/2/a.png?ex=${ex.toString(16)}&is=${is.toString(16)}&hm=abc&`;
  const HOUR = 3_600_000;

  it('is stale when it was issued more than 6 hours ago', () => {
    const u = signed(issued, issued + 24 * 3600);
    expect(URL_REFRESH_AFTER_MS).toBe(6 * HOUR);
    expect(isAttachmentUrlStale(u, issued * 1000)).toBe(false);
    expect(isAttachmentUrlStale(u, issued * 1000 + 5 * HOUR)).toBe(false);
    expect(isAttachmentUrlStale(u, issued * 1000 + 6 * HOUR)).toBe(false);
    expect(isAttachmentUrlStale(u, issued * 1000 + 6 * HOUR + 1)).toBe(true);
    expect(isAttachmentUrlStale(u, issued * 1000 + 23 * HOUR)).toBe(true);
  });

  it('takes another age limit', () => {
    const u = signed(issued, issued + 24 * 3600);
    expect(isAttachmentUrlStale(u, issued * 1000 + HOUR + 1, HOUR)).toBe(true);
    expect(isAttachmentUrlStale(u, issued * 1000 + HOUR, HOUR)).toBe(false);
  });

  it('is stale once it has expired, whatever its age says', () => {
    const u = signed(issued, issued + 3600);
    expect(isAttachmentUrlStale(u, issued * 1000 + 2 * HOUR)).toBe(true);
    const expiredOnly = `https://cdn.discordapp.com/a.png?ex=${(issued + 10).toString(16)}`;
    expect(isAttachmentUrlStale(expiredOnly, (issued + 10) * 1000)).toBe(true);
    expect(isAttachmentUrlStale(expiredOnly, (issued + 9) * 1000)).toBe(false);
  });

  it('is never stale when nothing is known: no parameters, garbage, not a url', () => {
    expect(isAttachmentUrlStale('https://cdn.discordapp.com/attachments/1/2/a.png', Date.now())).toBe(false);
    expect(isAttachmentUrlStale('https://cdn.discordapp.com/a.png?ex=zzz&is=nothex', Date.now())).toBe(false);
    expect(isAttachmentUrlStale('https://cdn.discordapp.com/a.png?ex=&is=', Date.now())).toBe(false);
    expect(isAttachmentUrlStale('not a url', Date.now())).toBe(false);
    expect(isAttachmentUrlStale('', Date.now())).toBe(false);
  });

  it('works with the real clock too', () => {
    const now = Date.now();
    const fresh = signed(Math.floor(now / 1000), Math.floor(now / 1000) + 86_400);
    expect(isAttachmentUrlStale(fresh, now)).toBe(false);
    const old = signed(Math.floor(now / 1000) - 7 * 3600, Math.floor(now / 1000) + 17 * 3600);
    expect(isAttachmentUrlStale(old, now)).toBe(true);
  });
});

describe('the demo client\'s refresh endpoint', () => {
  it('answers every url and refuses a batch above 50', async () => {
    const refreshed = await mock.refreshAttachmentUrls([url(1), url(2)]);
    expect(refreshed.map((r) => r.original)).toEqual([url(1), url(2)]);
    await expect(mock.refreshAttachmentUrls(Array.from({ length: 51 }, (_, i) => url(i)))).rejects.toBeInstanceOf(DiscordApiError);
  });

  it('is cancellable', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(mock.refreshAttachmentUrls([url(1)], controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
  });
});

