import { describe, expect, it, vi } from 'vitest';
import { collectMessages, collectMessagesResult, MAX_COLLECT_COUNT } from '@/lib/discord/collect';
import type { CollectOptions } from '@/lib/discord/collect';
import { DiscordApiError } from '@/lib/discord/client';
import type { DiscordClient, GetMessagesOptions } from '@/lib/discord/client';
import { createMockClient, MOCK_IDS } from '@/lib/discord/mock';
import { compareSnowflakes, snowflakeToTimestamp, timestampToSnowflake } from '@/lib/discord/snowflake';
import type { Message, Snowflake } from '@/lib/discord/types';

const mock = createMockClient({ latencyMs: 0 });

const NONE: CollectOptions = { count: null, fromMs: null, toMs: null, afterId: null };
const opts = (overrides: Partial<CollectOptions> = {}): CollectOptions => ({ ...NONE, ...overrides });

interface Recorded {
  channelId: string;
  options: GetMessagesOptions;
}

/** The demo client with every `getMessages` call recorded (and counted as in flight, to prove the walk is serial). */
function spy(base: DiscordClient = mock) {
  const calls: Recorded[] = [];
  let active = 0;
  let maxActive = 0;
  const client: DiscordClient = {
    ...base,
    kind: 'mock',
    getMessages: async (channelId, options = {}, signal) => {
      calls.push({ channelId, options: { ...options } });
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await base.getMessages(channelId, options, signal);
      } finally {
        active -= 1;
      }
    },
  };
  return { client, calls, maxActive: () => maxActive };
}

/** The whole history oldest -> newest, by the simplest possible backward walk (independent of the collector under test). */
async function history(channelId: string): Promise<Message[]> {
  const pages: Message[][] = [];
  let before: Snowflake | undefined;
  for (;;) {
    const page = await mock.getMessages(channelId, before === undefined ? { limit: 100 } : { before, limit: 100 });
    if (page.length === 0) break;
    pages.unshift([...page].reverse());
    before = page[page.length - 1]!.id;
  }
  return pages.flat();
}

const ids = (messages: readonly Message[]): string[] => messages.map((m) => m.id);
const timeOf = (message: Message): number => Date.parse(message.timestamp);

function isAscending(messages: readonly Message[]): boolean {
  return messages.every((m, i) => i === 0 || compareSnowflakes(messages[i - 1]!.id, m.id) < 0);
}

describe('collectMessages: whole channels (edge cases around the page size)', () => {
  it.each([
    ['edge-199', MOCK_IDS.edge199Channel, 199, 2],
    ['edge-200', MOCK_IDS.edge200Channel, 200, 3],
    ['edge-201', MOCK_IDS.edge201Channel, 201, 3],
    ['edge-400', MOCK_IDS.edge400Channel, 400, 5],
    ['edge-401', MOCK_IDS.edge401Channel, 401, 5],
  ])('%s: every message once, oldest first, in the fewest requests (%i messages, %i requests)', async (_name, channelId, total, requests) => {
    const all = await history(channelId);
    expect(all).toHaveLength(total);
    const s = spy();
    const result = await collectMessages(s.client, channelId, opts());
    expect(ids(result)).toEqual(ids(all));
    expect(isAscending(result)).toBe(true);
    // A full page is followed by another request; a short page (the start of the channel) or an empty one ends the walk.
    expect(s.calls).toHaveLength(requests);
    expect(s.maxActive()).toBe(1);
  });

  it('asks for 100 per request and walks back with the oldest id of the previous page as the cursor', async () => {
    const s = spy();
    const result = await collectMessages(s.client, MOCK_IDS.edge401Channel, opts());
    expect(s.calls.map((c) => c.options.limit)).toEqual([100, 100, 100, 100, 100]);
    expect(s.calls[0]!.options.before).toBeUndefined();
    expect(s.calls[0]!.options.after).toBeUndefined();
    const all = ids(result);
    expect(s.calls.slice(1).map((c) => c.options.before)).toEqual([all[301], all[201], all[101], all[1]]);
    expect(new Set(s.calls.map((c) => c.channelId))).toEqual(new Set([MOCK_IDS.edge401Channel]));
  });

  it('collects a long channel completely', async () => {
    const all = await history(MOCK_IDS.generalChannel);
    expect(all.length).toBeGreaterThan(2600);
    const result = await collectMessages(mock, MOCK_IDS.generalChannel, opts());
    expect(ids(result)).toEqual(ids(all));
  });

  it('an empty channel is an empty list after a single request', async () => {
    const s = spy();
    expect(await collectMessages(s.client, MOCK_IDS.emptyChannel, opts())).toEqual([]);
    expect(s.calls).toHaveLength(1);
  });

  it('a DM and a thread work like any other channel', async () => {
    expect((await collectMessages(mock, MOCK_IDS.dmFriend, opts())).length).toBeGreaterThan(300);
    expect(ids(await collectMessages(mock, MOCK_IDS.generalThread, opts()))).toEqual(ids(await history(MOCK_IDS.generalThread)));
  });
});

describe('collectMessages: count = the newest N', () => {
  it.each([1, 2, 99, 100, 101, 150, 199, 200, 201])('count %i on edge-401 is the newest %i messages', async (count) => {
    const all = await history(MOCK_IDS.edge401Channel);
    const result = await collectMessages(mock, MOCK_IDS.edge401Channel, opts({ count }));
    expect(ids(result)).toEqual(ids(all.slice(-count)));
  });

  it('requests no more than is still needed: the last page of a counted export is not fetched in full', async () => {
    const s = spy();
    await collectMessages(s.client, MOCK_IDS.edge401Channel, opts({ count: 250 }));
    expect(s.calls.map((c) => c.options.limit)).toEqual([100, 100, 50]);
    const t = spy();
    await collectMessages(t.client, MOCK_IDS.edge401Channel, opts({ count: 37 }));
    expect(t.calls.map((c) => c.options.limit)).toEqual([37]);
  });

  it('stops without another request once the count is reached', async () => {
    const s = spy();
    await collectMessages(s.client, MOCK_IDS.edge400Channel, opts({ count: 200 }));
    expect(s.calls).toHaveLength(2);
    const t = spy();
    await collectMessages(t.client, MOCK_IDS.edge200Channel, opts({ count: 200 }));
    expect(t.calls).toHaveLength(2); // not a third, empty, request
  });

  it('a count above the number of messages returns the whole channel', async () => {
    const all = await history(MOCK_IDS.edge199Channel);
    expect(ids(await collectMessages(mock, MOCK_IDS.edge199Channel, opts({ count: 1000 })))).toEqual(ids(all));
    expect(ids(await collectMessages(mock, MOCK_IDS.edge199Channel, opts({ count: MAX_COLLECT_COUNT })))).toEqual(ids(all));
  });

  it('the default of the app, 200, on a channel of 2,687 messages', async () => {
    const all = await history(MOCK_IDS.generalChannel);
    const s = spy();
    const result = await collectMessages(s.client, MOCK_IDS.generalChannel, opts({ count: 200 }));
    expect(ids(result)).toEqual(ids(all.slice(-200)));
    expect(s.calls).toHaveLength(2);
  });
});

describe('collectMessages: date ranges', () => {
  it('from / to are inclusive and exact to the millisecond', async () => {
    const all = await history(MOCK_IDS.edge400Channel);
    const mid = all[150]!;
    const t = timeOf(mid);
    const sameMs = (ms: number) => all.filter((m) => timeOf(m) === ms);

    // from = the time of a message: that message (and everything posted in the same millisecond) is in
    const atFrom = await collectMessages(mock, MOCK_IDS.edge400Channel, opts({ fromMs: t }));
    expect(ids(atFrom)).toEqual(ids(all.filter((m) => timeOf(m) >= t)));
    expect(atFrom).toContainEqual(expect.objectContaining({ id: mid.id }));
    // one millisecond later it is out
    const afterFrom = await collectMessages(mock, MOCK_IDS.edge400Channel, opts({ fromMs: t + 1 }));
    expect(ids(afterFrom)).toEqual(ids(all.filter((m) => timeOf(m) > t)));
    expect(ids(afterFrom)).not.toContain(mid.id);

    // to = the time of a message: it is in
    const atTo = await collectMessages(mock, MOCK_IDS.edge400Channel, opts({ toMs: t }));
    expect(ids(atTo)).toEqual(ids(all.filter((m) => timeOf(m) <= t)));
    expect(ids(atTo)).toEqual(expect.arrayContaining(ids(sameMs(t))));
    const beforeTo = await collectMessages(mock, MOCK_IDS.edge400Channel, opts({ toMs: t - 1 }));
    expect(ids(beforeTo)).toEqual(ids(all.filter((m) => timeOf(m) < t)));
  });

  it('from + to give exactly the messages inside', async () => {
    const all = await history(MOCK_IDS.edge400Channel);
    const fromMs = timeOf(all[100]!);
    const toMs = timeOf(all[299]!);
    const result = await collectMessages(mock, MOCK_IDS.edge400Channel, opts({ fromMs, toMs }));
    expect(ids(result)).toEqual(ids(all.filter((m) => timeOf(m) >= fromMs && timeOf(m) <= toMs)));
    expect(result.length).toBeGreaterThan(150);
  });

  it('a range ending in the past starts the walk at SF(to + 1), not at the newest message', async () => {
    const all = await history(MOCK_IDS.edge400Channel);
    const toMs = timeOf(all[299]!);
    const s = spy();
    await collectMessages(s.client, MOCK_IDS.edge400Channel, opts({ toMs, count: 5 }));
    expect(s.calls[0]!.options.before).toBe(timestampToSnowflake(toMs + 1));
    expect(s.calls[0]!.options.limit).toBe(5);
  });

  it('a range that starts in the middle stops at the lower bound: no request goes past it', async () => {
    const all = await history(MOCK_IDS.edge401Channel);
    const fromMs = timeOf(all[320]!); // inside the newest page of 100 (indices 301..400)
    const s = spy();
    const result = await collectMessages(s.client, MOCK_IDS.edge401Channel, opts({ fromMs }));
    expect(ids(result)).toEqual(ids(all.filter((m) => timeOf(m) >= fromMs)));
    expect(s.calls).toHaveLength(1);
  });

  it('a range that reaches the lower bound on the second page stops there', async () => {
    const all = await history(MOCK_IDS.edge401Channel);
    const fromMs = timeOf(all[250]!);
    const s = spy();
    const result = await collectMessages(s.client, MOCK_IDS.edge401Channel, opts({ fromMs }));
    expect(ids(result)).toEqual(ids(all.filter((m) => timeOf(m) >= fromMs)));
    expect(s.calls).toHaveLength(2);
  });

  it('count + range = the NEWEST N inside the range (not the first N after its start)', async () => {
    const all = await history(MOCK_IDS.edge400Channel);
    const fromMs = timeOf(all[50]!);
    const toMs = timeOf(all[349]!);
    const inside = all.filter((m) => timeOf(m) >= fromMs && timeOf(m) <= toMs);
    expect(inside.length).toBeGreaterThan(250);
    for (const count of [1, 10, 100, 101, 250]) {
      const result = await collectMessages(mock, MOCK_IDS.edge400Channel, opts({ count, fromMs, toMs }));
      expect(ids(result)).toEqual(ids(inside.slice(-count)));
    }
    // fewer messages in the range than the count: all of them
    const fewer = await collectMessages(mock, MOCK_IDS.edge400Channel, opts({ count: 1000, fromMs, toMs }));
    expect(ids(fewer)).toEqual(ids(inside));
  });

  it('a window above the newest message is empty after one request', async () => {
    const all = await history(MOCK_IDS.edge200Channel);
    const s = spy();
    const result = await collectMessages(s.client, MOCK_IDS.edge200Channel, opts({ fromMs: timeOf(all[all.length - 1]!) + 1 }));
    expect(result).toEqual([]);
    expect(s.calls).toHaveLength(1);
  });

  it('a window below the oldest message is empty after one request', async () => {
    const all = await history(MOCK_IDS.edge200Channel);
    const s = spy();
    const result = await collectMessages(s.client, MOCK_IDS.edge200Channel, opts({ toMs: timeOf(all[0]!) - 1 }));
    expect(result).toEqual([]);
    expect(s.calls).toHaveLength(1);
  });

  it('a window before the Discord epoch makes no request at all', async () => {
    const s = spy();
    expect(await collectMessages(s.client, MOCK_IDS.edge200Channel, opts({ toMs: 1_000_000_000_000 }))).toEqual([]);
    expect(s.calls).toHaveLength(0);
  });

  it('a range that covers the whole channel changes nothing', async () => {
    const all = await history(MOCK_IDS.edge200Channel);
    const result = await collectMessages(mock, MOCK_IDS.edge200Channel, opts({ fromMs: 0, toMs: Date.UTC(2100, 0, 1) }));
    expect(ids(result)).toEqual(ids(all));
  });

  it('a range of a single instant (from = to) is valid', async () => {
    const all = await history(MOCK_IDS.edge200Channel);
    const t = timeOf(all[77]!);
    const result = await collectMessages(mock, MOCK_IDS.edge200Channel, opts({ fromMs: t, toMs: t }));
    expect(ids(result)).toEqual(ids(all.filter((m) => timeOf(m) === t)));
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps messages posted in the very first millisecond of the range (SF(from) - 1 is the exclusive bound)', async () => {
    const all = await history(MOCK_IDS.edge200Channel);
    const first = all[10]!;
    const fromMs = snowflakeToTimestamp(first.id);
    const result = await collectMessages(mock, MOCK_IDS.edge200Channel, opts({ fromMs }));
    expect(ids(result)).toContain(first.id);
  });
});

describe('collectMessages: incremental (afterId is exclusive)', () => {
  it('returns only the messages newer than the marker', async () => {
    const all = await history(MOCK_IDS.edge401Channel);
    const result = await collectMessages(mock, MOCK_IDS.edge401Channel, opts({ afterId: all[200]!.id }));
    expect(ids(result)).toEqual(ids(all.slice(201)));
  });

  it('the marker message itself is not included', async () => {
    const all = await history(MOCK_IDS.edge200Channel);
    const result = await collectMessages(mock, MOCK_IDS.edge200Channel, opts({ afterId: all[100]!.id }));
    expect(ids(result)).not.toContain(all[100]!.id);
    expect(result[0]!.id).toBe(all[101]!.id);
  });

  it('nothing new: an empty list after one request (the newest page is already behind the marker)', async () => {
    const all = await history(MOCK_IDS.edge200Channel);
    const s = spy();
    expect(await collectMessages(s.client, MOCK_IDS.edge200Channel, opts({ afterId: all[all.length - 1]!.id }))).toEqual([]);
    expect(s.calls).toHaveLength(1);
  });

  it('a marker older than the whole channel gives the whole channel', async () => {
    const all = await history(MOCK_IDS.edge199Channel);
    expect(ids(await collectMessages(mock, MOCK_IDS.edge199Channel, opts({ afterId: '1' })))).toEqual(ids(all));
    expect(ids(await collectMessages(mock, MOCK_IDS.edge199Channel, opts({ afterId: '000123' })))).toEqual(ids(all));
  });

  it('stops walking at the marker, so only the new pages are requested', async () => {
    const all = await history(MOCK_IDS.edge401Channel);
    const s = spy();
    await collectMessages(s.client, MOCK_IDS.edge401Channel, opts({ afterId: all[350]!.id }));
    expect(s.calls).toHaveLength(1);
    const t = spy();
    await collectMessages(t.client, MOCK_IDS.edge401Channel, opts({ afterId: all[150]!.id }));
    expect(t.calls).toHaveLength(3);
  });

  it('with a count: the newest N after the marker (there may be a gap behind them)', async () => {
    const all = await history(MOCK_IDS.edge401Channel);
    const result = await collectMessages(mock, MOCK_IDS.edge401Channel, opts({ afterId: all[100]!.id, count: 50 }));
    expect(ids(result)).toEqual(ids(all.slice(-50)));
    const few = await collectMessages(mock, MOCK_IDS.edge401Channel, opts({ afterId: all[390]!.id, count: 50 }));
    expect(ids(few)).toEqual(ids(all.slice(391)));
  });

  it('combines with a start: the stricter lower bound wins', async () => {
    const all = await history(MOCK_IDS.edge400Channel);
    const fromMs = timeOf(all[100]!);
    const marker = all[200]!.id;
    const strict = await collectMessages(mock, MOCK_IDS.edge400Channel, opts({ fromMs, afterId: marker }));
    expect(ids(strict)).toEqual(ids(all.slice(201)));
    const looser = await collectMessages(mock, MOCK_IDS.edge400Channel, opts({ fromMs: timeOf(all[300]!), afterId: all[50]!.id }));
    expect(ids(looser)).toEqual(ids(all.filter((m) => timeOf(m) >= timeOf(all[300]!))));
  });

  it('combines with an end: messages after the end are not requested, the marker still applies', async () => {
    const all = await history(MOCK_IDS.edge400Channel);
    const toMs = timeOf(all[299]!);
    const result = await collectMessages(mock, MOCK_IDS.edge400Channel, opts({ toMs, afterId: all[199]!.id }));
    expect(ids(result)).toEqual(ids(all.filter((m) => compareSnowflakes(m.id, all[199]!.id) > 0 && timeOf(m) <= toMs)));
  });

  it('a marker at or above the end of the window is an empty list without any request', async () => {
    const all = await history(MOCK_IDS.edge400Channel);
    const toMs = timeOf(all[100]!);
    const s = spy();
    expect(await collectMessages(s.client, MOCK_IDS.edge400Channel, opts({ toMs, afterId: all[300]!.id }))).toEqual([]);
    expect(s.calls).toHaveLength(0);
  });
});

describe('collectMessages: progress', () => {
  it('reports the number of messages collected so far after every page that added some', async () => {
    const seen: number[] = [];
    await collectMessages(mock, MOCK_IDS.edge401Channel, opts({ onProgress: (n) => seen.push(n) }));
    expect(seen).toEqual([100, 200, 300, 400, 401]);
  });

  it('with a count the last report is the count', async () => {
    const seen: number[] = [];
    await collectMessages(mock, MOCK_IDS.edge401Channel, opts({ count: 250, onProgress: (n) => seen.push(n) }));
    expect(seen).toEqual([100, 200, 250]);
  });

  it('is not called when nothing was found', async () => {
    const onProgress = vi.fn();
    await collectMessages(mock, MOCK_IDS.emptyChannel, opts({ onProgress }));
    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe('collectMessages: failures', () => {
  it('a forbidden channel rejects with the client error', async () => {
    const error = await collectMessages(mock, MOCK_IDS.forbiddenChannel, opts()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscordApiError);
    expect(error).toMatchObject({ kind: 'forbidden', status: 403 });
    const hidden = await collectMessages(mock, MOCK_IDS.hiddenChannel, opts()).catch((e: unknown) => e);
    expect(hidden).toMatchObject({ kind: 'forbidden' });
  });

  it('an unknown channel and a forum (no messages of its own) reject too', async () => {
    expect(await collectMessages(mock, MOCK_IDS.unknownChannel, opts()).catch((e: unknown) => e)).toMatchObject({ kind: 'not-found' });
    expect(await collectMessages(mock, MOCK_IDS.forumChannel, opts()).catch((e: unknown) => e)).toMatchObject({ kind: 'unknown', status: 400 });
  });

  it('collectMessagesResult keeps what was collected before the failure: the newest messages, oldest first', async () => {
    const all = await history(MOCK_IDS.edge401Channel);
    let calls = 0;
    const failing: DiscordClient = {
      ...mock,
      getMessages: async (channelId, options, signal) => {
        calls += 1;
        if (calls === 3) throw new DiscordApiError('server', 'down', { status: 500 });
        return mock.getMessages(channelId, options, signal);
      },
    };
    const result = await collectMessagesResult(failing, MOCK_IDS.edge401Channel, opts());
    expect(result.failed).toBe(true);
    expect(result.error).toMatchObject({ kind: 'server' });
    expect(ids(result.messages)).toEqual(ids(all.slice(-200)));
    // the strict variant throws the same error
    calls = 0;
    await expect(collectMessages(failing, MOCK_IDS.edge401Channel, opts())).rejects.toMatchObject({ kind: 'server' });
  });

  it('a failure on the very first request is a failed result without messages', async () => {
    const result = await collectMessagesResult(mock, MOCK_IDS.forbiddenChannel, opts());
    expect(result).toMatchObject({ failed: true, messages: [] });
    expect(result.error).toMatchObject({ kind: 'forbidden' });
  });

  it('a successful walk is not failed', async () => {
    const result = await collectMessagesResult(mock, MOCK_IDS.edge199Channel, opts());
    expect(result.failed).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.messages).toHaveLength(199);
  });

  it('whatever was thrown is carried, even a non-Error value', async () => {
    const odd: DiscordClient = {
      ...mock,
      getMessages: async () => {
        throw 'plain string';
      },
    };
    const result = await collectMessagesResult(odd, '1', opts());
    expect(result).toMatchObject({ failed: true, error: 'plain string' });
  });
});

describe('collectMessages: cancel', () => {
  it('rejects without a request when the signal is already aborted', async () => {
    const s = spy();
    const controller = new AbortController();
    controller.abort();
    const error = await collectMessages(s.client, MOCK_IDS.edge200Channel, opts({ signal: controller.signal })).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(s.calls).toHaveLength(0);
  });

  it('stops between pages and rejects (collectMessagesResult too: a cancel is not a result)', async () => {
    const controller = new AbortController();
    const s = spy();
    const promise = collectMessages(s.client, MOCK_IDS.edge401Channel, opts({ signal: controller.signal, onProgress: (n) => n >= 200 && controller.abort() }));
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.calls).toHaveLength(2);

    const second = new AbortController();
    await expect(
      collectMessagesResult(mock, MOCK_IDS.edge401Channel, opts({ signal: second.signal, onProgress: () => second.abort() })),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects when the request itself is aborted', async () => {
    const controller = new AbortController();
    const hanging: DiscordClient = {
      ...mock,
      getMessages: (_channelId, _options, signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(new DiscordApiError('aborted', 'cancelled')));
          controller.abort();
        }),
    };
    await expect(collectMessagesResult(hanging, '1', opts({ signal: controller.signal }))).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('a DOMException AbortError from a custom client also rejects (not a failed result)', async () => {
    const custom: DiscordClient = {
      ...mock,
      getMessages: async () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
    };
    await expect(collectMessagesResult(custom, '1', opts())).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('collectMessages: a misbehaving server', () => {
  const msg = (id: bigint, extra: Partial<Message> = {}): Message => ({
    id: id.toString(),
    channel_id: '1',
    author: { id: '9', username: 'u' },
    content: `m${id}`,
    timestamp: '2026-10-05T12:00:00.000Z',
    edited_timestamp: null,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    type: 0,
    ...extra,
  });
  const BASE = 700_000_000_000_000_000n;
  const range = (from: number, to: number): Message[] => Array.from({ length: to - from + 1 }, (_, i) => msg(BASE + BigInt(to - i)));

  /** A client whose `getMessages` is a function of the call number and the request. */
  const scripted = (handler: (call: number, options: GetMessagesOptions) => Message[]) => {
    let call = 0;
    const calls: GetMessagesOptions[] = [];
    const client: DiscordClient = {
      ...mock,
      getMessages: async (_channelId, options = {}) => {
        calls.push({ ...options });
        return handler(call++, options);
      },
    };
    return { client, calls };
  };

  it('a server that ignores `before` (the same page again) ends the walk instead of looping', async () => {
    const page = range(1, 100);
    const s = scripted(() => page);
    const result = await collectMessages(s.client, '1', opts());
    expect(result).toHaveLength(100);
    expect(s.calls).toHaveLength(2);
    expect(isAscending(result)).toBe(true);
  });

  it('a server that ignores `limit` cannot push the result past the count', async () => {
    const s = scripted(() => range(1, 100));
    const result = await collectMessages(s.client, '1', opts({ count: 30 }));
    expect(result).toHaveLength(30);
    expect(ids(result)).toEqual(ids(range(71, 100).reverse()));
    expect(s.calls[0]!.limit).toBe(30);
  });

  it('pages in the wrong order and duplicates are sorted out', async () => {
    const shuffled = [...range(1, 100)].sort((a, b) => (Number(BigInt(a.id) % 7n) - Number(BigInt(b.id) % 7n)) || a.id.localeCompare(b.id));
    const withDupes = [...shuffled, shuffled[0]!, shuffled[5]!];
    const s = scripted((call) => (call === 0 ? withDupes : []));
    const result = await collectMessages(s.client, '1', opts());
    expect(result).toHaveLength(100);
    expect(isAscending(result)).toBe(true);
    expect(new Set(ids(result)).size).toBe(100);
  });

  it('entries without a usable id are skipped', async () => {
    const page = [...range(1, 98), null, { content: 'no id' }, { id: 'abc' }, { id: 5 }] as unknown as Message[];
    const s = scripted((call) => (call === 0 ? page : []));
    const result = await collectMessages(s.client, '1', opts());
    expect(result).toHaveLength(98);
  });

  it('a page that is not an array ends the walk with what was collected', async () => {
    const s = scripted((call) => (call === 0 ? range(1, 100) : (null as unknown as Message[])));
    expect(await collectMessages(s.client, '1', opts())).toHaveLength(100);
  });

  it('a short page is the start of the channel (no further request)', async () => {
    const s = scripted(() => range(1, 40));
    expect(await collectMessages(s.client, '1', opts())).toHaveLength(40);
    expect(s.calls).toHaveLength(1);
  });

  it('messages at or below the lower bound inside a page are cut off, the ones above are kept', async () => {
    const s = scripted(() => range(1, 100));
    const result = await collectMessages(s.client, '1', opts({ afterId: (BASE + 60n).toString() }));
    expect(ids(result)).toEqual(ids(range(61, 100).reverse()));
    expect(s.calls).toHaveLength(1);
  });
});

describe('collectMessages: validation', () => {
  it.each([0, -1, 1.5, Number.NaN, MAX_COLLECT_COUNT + 1, Number.POSITIVE_INFINITY])('rejects the count %s', async (count) => {
    const s = spy();
    await expect(collectMessages(s.client, MOCK_IDS.edge200Channel, opts({ count }))).rejects.toThrow(RangeError);
    expect(s.calls).toHaveLength(0);
  });

  it('accepts the bounds of the count', async () => {
    await expect(collectMessages(mock, MOCK_IDS.edge199Channel, opts({ count: 1 }))).resolves.toHaveLength(1);
    await expect(collectMessages(mock, MOCK_IDS.edge199Channel, opts({ count: MAX_COLLECT_COUNT }))).resolves.toHaveLength(199);
  });

  it('rejects times that are not numbers, a start after the end and a marker that is not an id', async () => {
    await expect(collectMessages(mock, MOCK_IDS.edge200Channel, opts({ fromMs: Number.NaN }))).rejects.toThrow(RangeError);
    await expect(collectMessages(mock, MOCK_IDS.edge200Channel, opts({ toMs: Number.POSITIVE_INFINITY }))).rejects.toThrow(RangeError);
    await expect(collectMessages(mock, MOCK_IDS.edge200Channel, opts({ fromMs: 2000, toMs: 1000 }))).rejects.toThrow(/start is later/);
    await expect(collectMessages(mock, MOCK_IDS.edge200Channel, opts({ afterId: 'abc' }))).rejects.toThrow(RangeError);
    await expect(collectMessages(mock, MOCK_IDS.edge200Channel, opts({ afterId: '12 3' }))).rejects.toThrow(RangeError);
  });

  it('collectMessagesResult validates too (a programmer error is thrown, not returned)', async () => {
    await expect(collectMessagesResult(mock, MOCK_IDS.edge200Channel, opts({ count: 0 }))).rejects.toThrow(RangeError);
  });
});
