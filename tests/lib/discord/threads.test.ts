import { describe, expect, it, vi } from 'vitest';
import { DiscordApiError } from '@/lib/discord/client';
import type { DiscordClient, ThreadSearchPage, ThreadSearchQuery } from '@/lib/discord/client';
import { createMockClient, MOCK_IDS } from '@/lib/discord/mock';
import { listThreads, MAX_INDEX_RETRIES } from '@/lib/discord/threads';
import type { Channel } from '@/lib/discord/types';

const mock = createMockClient({ latencyMs: 0 });

const thread = (id: number, extra: Partial<Channel> = {}): Channel => ({ id: String(5000 + id), type: 11, name: `post ${id}`, ...extra });
const threads = (from: number, count: number): Channel[] => Array.from({ length: count }, (_, i) => thread(from + i));
const ready = (list: Channel[], hasMore = false): ThreadSearchPage => ({ status: 'ready', threads: list, hasMore });
const indexing = (retryAfterMs: number | null = null): ThreadSearchPage => ({ status: 'indexing', retryAfterMs });

interface Call {
  channelId: string;
  query: ThreadSearchQuery;
}

/** A client whose thread search answers from `script` (one entry per call, in order) and records every call. */
function scripted(script: Array<ThreadSearchPage | Error | ((call: Call) => ThreadSearchPage)>) {
  const calls: Call[] = [];
  const pending = [...script];
  const client: DiscordClient = {
    ...mock,
    searchThreads: async (channelId, query) => {
      calls.push({ channelId, query: { ...query } });
      const next = pending.shift();
      if (next === undefined) throw new Error(`unexpected extra search #${calls.length}`);
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(calls[calls.length - 1]!) : next;
    },
  };
  return { client, calls };
}

const sleeps = () => {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
};

const queries = (calls: readonly Call[]): Array<[boolean, number]> => calls.map((c) => [c.query.archived, c.query.offset]);

describe('listThreads: both archived states', () => {
  it('asks for the active threads first, then the archived ones, and returns them in that order', async () => {
    const s = scripted([ready([thread(1), thread(2)]), ready([thread(3)])]);
    const result = await listThreads(s.client, '12');
    expect(result).toEqual({ threads: [thread(1, { parent_id: '12' }), thread(2, { parent_id: '12' }), thread(3, { parent_id: '12' })], error: null, truncated: false });
    expect(queries(s.calls)).toEqual([
      [false, 0],
      [true, 0],
    ]);
    expect(new Set(s.calls.map((c) => c.channelId))).toEqual(new Set(['12']));
  });

  it('a channel without threads is an empty list after two requests', async () => {
    const s = scripted([ready([]), ready([])]);
    expect(await listThreads(s.client, '12')).toEqual({ threads: [], error: null, truncated: false });
    expect(s.calls).toHaveLength(2);
  });

  it('fills in a missing parent_id with the channel that was searched and keeps an existing one', async () => {
    const s = scripted([ready([thread(1), thread(2, { parent_id: '99' })]), ready([])]);
    const result = await listThreads(s.client, '12');
    expect(result.threads.map((t) => [t.id, t.parent_id])).toEqual([
      ['5001', '12'],
      ['5002', '99'],
    ]);
  });

  it('does not change the objects it was given', async () => {
    const original = thread(1);
    const s = scripted([ready([original]), ready([])]);
    await listThreads(s.client, '12');
    expect(original.parent_id).toBeUndefined();
  });
});

describe('listThreads: paging with has_more', () => {
  it('follows has_more, advancing the offset by the threads received, and stops at the first page that says no more', async () => {
    const s = scripted([ready(threads(0, 25), true), ready(threads(25, 10), false), ready([])]);
    const result = await listThreads(s.client, '12');
    expect(result.threads).toHaveLength(35);
    expect(queries(s.calls)).toEqual([
      [false, 0],
      [false, 25],
      [true, 0],
    ]);
  });

  it('pages the archived threads the same way', async () => {
    const s = scripted([ready([]), ready(threads(0, 25), true), ready(threads(25, 25), true), ready(threads(50, 3), false)]);
    const result = await listThreads(s.client, '12');
    expect(result.threads).toHaveLength(53);
    expect(queries(s.calls)).toEqual([
      [false, 0],
      [true, 0],
      [true, 25],
      [true, 50],
    ]);
  });

  it('is not limited to a few pages: a busy forum is listed completely', async () => {
    const pages = Array.from({ length: 8 }, (_, i) => ready(threads(i * 25, 25), i < 7));
    const s = scripted([...pages, ready([])]);
    const result = await listThreads(s.client, '12');
    expect(result.threads).toHaveLength(200);
    expect(s.calls).toHaveLength(9);
    expect(s.calls.slice(0, 8).map((c) => c.query.offset)).toEqual([0, 25, 50, 75, 100, 125, 150, 175]);
  });

  it('stops at Discord\'s offset limit (9975) and says it was truncated', async () => {
    const s = scripted(
      Array.from({ length: 800 }, () => (call: Call): ThreadSearchPage => ready(threads(call.query.offset + (call.query.archived ? 100_000 : 0), 25), true)),
    );
    const result = await listThreads(s.client, '12');
    // Per state the offsets 0, 25, ... 9975 are asked for (400 requests); the next one would be 10000, which Discord refuses.
    expect(s.calls).toHaveLength(800);
    expect(Math.max(...s.calls.map((c) => c.query.offset))).toBe(9975);
    expect(s.calls.filter((c) => c.query.archived)).toHaveLength(400);
    expect(result.threads).toHaveLength(20_000);
    expect(result.error).toBeNull();
    expect(result.truncated).toBe(true);
  });

  it('a listing that ends exactly at the limit with has_more false is not truncated', async () => {
    const s = scripted([...Array.from({ length: 399 }, (_, i) => ready(threads(i * 25, 25), true)), ready(threads(9975, 25), false), ready([])]);
    const result = await listThreads(s.client, '12');
    expect(result.threads).toHaveLength(10_000);
    expect(result.truncated).toBe(false);
  });

  it('never loops on an empty page even if has_more is true, and tolerates repeated threads', async () => {
    const s = scripted([ready([thread(1), thread(2)], true), ready([], true), ready([thread(1), thread(2), thread(3)], false)]);
    const result = await listThreads(s.client, '12');
    expect(result.threads.map((t) => t.id)).toEqual(['5001', '5002', '5003']);
    expect(s.calls).toHaveLength(3);
  });

  it('dedupes by id across pages and across the archived states', async () => {
    const s = scripted([ready([thread(1), thread(2)], true), ready([thread(2), thread(3)], false), ready([thread(3), thread(4)], false)]);
    const result = await listThreads(s.client, '12');
    expect(result.threads.map((t) => t.id)).toEqual(['5001', '5002', '5003', '5004']);
  });
});

describe('listThreads: index not ready (HTTP 202)', () => {
  it('waits the retry hint and asks the same page again', async () => {
    const w = sleeps();
    const s = scripted([indexing(2000), ready([thread(1)]), ready([])]);
    const result = await listThreads(s.client, '12', { sleep: w.sleep });
    expect(result.threads.map((t) => t.id)).toEqual(['5001']);
    expect(result.error).toBeNull();
    expect(w.waits).toEqual([2000]);
    expect(queries(s.calls)).toEqual([
      [false, 0],
      [false, 0],
      [true, 0],
    ]);
  });

  it('uses a short default wait when there is no hint, and caps a long one', async () => {
    const w = sleeps();
    const s = scripted([indexing(null), indexing(120_000), indexing(250), ready([]), ready([])]);
    await listThreads(s.client, '12', { sleep: w.sleep });
    expect(w.waits).toEqual([3000, 30_000, 250]);
  });

  it('retries each request at most 5 times and then returns what it has together with the error (no throw)', async () => {
    const w = sleeps();
    const s = scripted([ready([thread(1)], false), ...Array.from({ length: MAX_INDEX_RETRIES + 1 }, () => indexing(1000))]);
    const result = await listThreads(s.client, '12', { sleep: w.sleep });
    expect(MAX_INDEX_RETRIES).toBe(5);
    expect(result.threads.map((t) => t.id)).toEqual(['5001']);
    expect(result.error).toBeInstanceOf(DiscordApiError);
    expect(result.error).toMatchObject({ kind: 'unknown', status: 202 });
    expect(w.waits).toEqual([1000, 1000, 1000, 1000, 1000]);
    expect(s.calls).toHaveLength(1 + 6); // the active page, then the archived page asked 6 times
  });

  it('the retry budget is per request: a later page that is also not ready gets its own retries', async () => {
    const w = sleeps();
    const s = scripted([
      indexing(100),
      indexing(100),
      ready(threads(0, 25), true),
      indexing(100),
      ready(threads(25, 5), false),
      ready([]),
    ]);
    const result = await listThreads(s.client, '12', { sleep: w.sleep });
    expect(result.threads).toHaveLength(30);
    expect(result.error).toBeNull();
    expect(w.waits).toEqual([100, 100, 100]);
  });

  it('can be cancelled while it waits, and rejects', async () => {
    const controller = new AbortController();
    const s = scripted([indexing(5000), ready([])]);
    const sleep = (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((_, reject) => {
        signal?.addEventListener('abort', () => reject(new DiscordApiError('aborted', 'cancelled')));
        controller.abort();
      });
    await expect(listThreads(s.client, '12', { signal: controller.signal, sleep })).rejects.toMatchObject({ kind: 'aborted' });
    expect(s.calls).toHaveLength(1);
  });

  it('a real timer is used by default (abortable)', async () => {
    vi.useFakeTimers();
    try {
      const s = scripted([indexing(2000), ready([thread(1)]), ready([])]);
      const promise = listThreads(s.client, '12');
      await vi.advanceTimersByTimeAsync(1999);
      expect(s.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await promise;
      expect(result.threads).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('listThreads: errors do not throw, they come back with what was found', () => {
  it('an error on the first request: no threads and the error', async () => {
    const error = new DiscordApiError('forbidden', 'Missing Access', { status: 403, code: 50001 });
    const s = scripted([error]);
    const result = await listThreads(s.client, '12');
    expect(result).toEqual({ threads: [], error, truncated: false });
    expect(s.calls).toHaveLength(1);
  });

  it('an error on a later page keeps the earlier pages', async () => {
    const error = new DiscordApiError('server', 'down', { status: 500 });
    const s = scripted([ready(threads(0, 25), true), error]);
    const result = await listThreads(s.client, '12');
    expect(result.threads).toHaveLength(25);
    expect(result.error).toBe(error);
    expect(s.calls).toHaveLength(2);
  });

  it('an error on the archived pass keeps the active threads', async () => {
    const error = new DiscordApiError('rate-limited', 'slow down', { status: 429, retryAfterMs: 900_000 });
    const s = scripted([ready([thread(1), thread(2)]), error]);
    const result = await listThreads(s.client, '12');
    expect(result.threads.map((t) => t.id)).toEqual(['5001', '5002']);
    expect(result.error).toBe(error);
  });

  it('wraps an error that is not a DiscordApiError', async () => {
    const s = scripted([new TypeError('boom')]);
    const result = await listThreads(s.client, '12');
    expect(result.error).toBeInstanceOf(DiscordApiError);
    expect(result.error).toMatchObject({ kind: 'unknown', message: 'boom' });
  });

  it('a cancel rejects instead of returning (cancellation is not a result)', async () => {
    const s = scripted([new DiscordApiError('aborted', 'cancelled')]);
    await expect(listThreads(s.client, '12')).rejects.toMatchObject({ kind: 'aborted' });

    const controller = new AbortController();
    controller.abort();
    const t = scripted([ready([])]);
    await expect(listThreads(t.client, '12', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(t.calls).toHaveLength(0);
  });

  it('a cancel between pages rejects', async () => {
    const controller = new AbortController();
    const s = scripted([() => {
      controller.abort();
      return ready(threads(0, 25), true);
    }]);
    await expect(listThreads(s.client, '12', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.calls).toHaveLength(1);
  });

  it('passes the signal on to every search', async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const client: DiscordClient = {
      ...mock,
      searchThreads: async (_channelId, _query, signal) => {
        seen.push(signal);
        return ready([]);
      },
    };
    await listThreads(client, '12', { signal: controller.signal });
    expect(seen).toEqual([controller.signal, controller.signal]);
  });
});

describe('listThreads: the demo world', () => {
  it('lists the posts of the forum, newest activity first within a page, none archived', async () => {
    const result = await listThreads(mock, MOCK_IDS.forumChannel);
    expect(result.error).toBeNull();
    expect(result.threads.map((t) => t.id).sort()).toEqual([...MOCK_IDS.forumThreads].sort());
    expect(result.threads.every((t) => t.parent_id === MOCK_IDS.forumChannel)).toBe(true);
  });

  it('lists the threads of a text channel', async () => {
    const result = await listThreads(mock, MOCK_IDS.generalChannel);
    expect(result.threads.map((t) => t.id).sort()).toEqual([MOCK_IDS.generalThread, MOCK_IDS.generalThread2].sort());
  });

  it('a channel without threads gives an empty list', async () => {
    expect((await listThreads(mock, MOCK_IDS.edge200Channel)).threads).toEqual([]);
  });

  it('a forbidden channel comes back as an error with no threads', async () => {
    const result = await listThreads(mock, MOCK_IDS.forbiddenChannel);
    expect(result.threads).toEqual([]);
    expect(result.error).toMatchObject({ kind: 'forbidden' });
  });

  it('an unknown channel comes back as not-found', async () => {
    expect((await listThreads(mock, MOCK_IDS.unknownChannel)).error).toMatchObject({ kind: 'not-found' });
  });
});
