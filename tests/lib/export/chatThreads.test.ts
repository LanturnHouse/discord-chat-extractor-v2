/**
 * `exportChat` with threads (docs/PLAN.md §6.4, #10): a text channel with `includeThreads` gives its own file plus one per
 * thread, a forum / media channel is nothing but its posts. Exact control over thread ids and times comes from the hand-made
 * world of tests/lib/export/fakeClient.ts; the demo world confirms the shape on realistic data.
 */
import { describe, expect, it } from 'vitest';
import type { ExportSettings } from '@/shared/types';
import { DiscordApiError } from '../../../src/lib/discord/client';
import { MOCK_IDS } from '../../../src/lib/discord/mock';
import type { Channel, Message } from '../../../src/lib/discord/types';
import { exportChat } from '../../../src/lib/export/chat';
import type { ExportChatContext, ExportChatResult } from '../../../src/lib/export/chat';
import { context, exportMock, settings, target, textOf } from './exportKit';
import { BOT, CATEGORY_ID, channel, DAY0, fakeClient, FORUM_ID, GUILD, GUILD_ID, idAt, msg, NEWS_ID, TEXT_ID, thread } from './fakeClient';
import type { FakeCall, FakeClient, FakeWorld, Failure } from './fakeClient';

// ---------------------------------------------------------------------------------------------------------------------
// the world: a text channel with an old, an archived and a new thread
// ---------------------------------------------------------------------------------------------------------------------

/** Created two days before the channel's messages; last message at minute 5. */
const OLD = thread(idAt(-2880), TEXT_ID, 'Old thread', { last_message_id: idAt(5) });
/** Archived thread; last message at minute 8. */
const ARCHIVED = thread(idAt(-100), TEXT_ID, 'Archived thread', { thread_metadata: { archived: true }, last_message_id: idAt(8) });
/** Created at minute 20; last message at minute 40. */
const NEW = thread(idAt(20), TEXT_ID, 'New thread', { last_message_id: idAt(40) });

const inThread = (id: string, minutes: number, content: string, extra: Partial<Message> = {}): Message => msg(minutes, content, extra, id);

function world(extra: Partial<FakeWorld> = {}): FakeWorld {
  return {
    guild: GUILD,
    channels: [channel(CATEGORY_ID, 4, { name: 'Text Channels' }), channel(TEXT_ID, 0, { name: 'general', parent_id: CATEGORY_ID }), OLD, ARCHIVED, NEW],
    messages: {
      [TEXT_ID]: [msg(0, 'm0'), msg(1, 'm1'), msg(2, 'm2')],
      [OLD.id]: [inThread(OLD.id, -2870, 'old first'), inThread(OLD.id, 5, 'old last')],
      [ARCHIVED.id]: [inThread(ARCHIVED.id, -90, 'archived first'), inThread(ARCHIVED.id, 8, 'archived last')],
      [NEW.id]: [inThread(NEW.id, 21, 'new first'), inThread(NEW.id, 30, 'new second'), inThread(NEW.id, 40, 'new last')],
    },
    threads: { [TEXT_ID]: [NEW, OLD, ARCHIVED] },
    ...extra,
  };
}

const fake = (extra: Partial<FakeWorld> = {}, fail?: (call: FakeCall) => Failure | Promise<Failure>): FakeClient => fakeClient(world(extra), fail);

function run(client: FakeClient, over: { settings?: Partial<ExportSettings>; ctx?: Partial<ExportChatContext>; channelId?: string } = {}): Promise<ExportChatResult> {
  const withThreads: Partial<ExportSettings> = { includeThreads: true, ...over.settings };
  return exportChat(client, target(over.channelId ?? TEXT_ID, { guildId: GUILD_ID }), settings('json', withThreads), context(over.ctx));
}

interface JsonChat {
  channel: { id: string; name: string; kind: string; guild: { name: string } | null; category: string | null };
  incremental?: boolean;
  partial?: boolean;
  messages: Array<{ content: string }>;
}
const docOf = (result: ExportChatResult, index: number): JsonChat => JSON.parse(textOf(result.outputs[index]!)) as JsonChat;
const contents = (result: ExportChatResult, index: number): string[] => docOf(result, index).messages.map((m) => m.content);
const names = (result: ExportChatResult): string[] => result.outputs.map((_, i) => docOf(result, i).channel.name);
const at = (minutes: number): string => new Date(DAY0 + minutes * 60_000).toISOString();
const apiError = (kind: DiscordApiError['kind']): DiscordApiError => new DiscordApiError(kind, `raw ${kind}`);
const asked = (client: FakeClient, id: string): number => client.calls('getMessages').filter((call) => call.id === id).length;

// ---------------------------------------------------------------------------------------------------------------------
// a text channel with threads
// ---------------------------------------------------------------------------------------------------------------------

describe('exportChat: a text channel with includeThreads', () => {
  it('writes the channel and then one file per thread, oldest thread first', async () => {
    const result = await run(fake());
    expect(result).toMatchObject({ status: 'done', error: null, messageCount: 3 + 2 + 2 + 3 });
    expect(names(result)).toEqual(['general', 'Old thread', 'Archived thread', 'New thread']);
    expect(contents(result, 0)).toEqual(['m0', 'm1', 'm2']);
    expect(contents(result, 1)).toEqual(['old first', 'old last']);
    expect(contents(result, 2)).toEqual(['archived first', 'archived last']);
    expect(contents(result, 3)).toEqual(['new first', 'new second', 'new last']);
  });

  it('names the files <server> - <parent> - <thread> and puts them next to the channel in a ZIP', async () => {
    const result = await run(fake());
    expect(result.outputs.map((o) => o.path)).toEqual([
      'Discord Export/Test Guild - general (2026-10-06).json',
      'Discord Export/Test Guild - general - Old thread (2026-10-06).json',
      'Discord Export/Test Guild - general - Archived thread (2026-10-06).json',
      'Discord Export/Test Guild - general - New thread (2026-10-06).json',
    ]);
    expect(result.outputs.map((o) => o.zipPath)).toEqual([
      'Test Guild/Text Channels/general.json',
      'Test Guild/Text Channels/general - Old thread.json',
      'Test Guild/Text Channels/general - Archived thread.json',
      'Test Guild/Text Channels/general - New thread.json',
    ]);
  });

  it('describes a thread as a thread of its parent: kind, guild and the category of the parent', async () => {
    const result = await run(fake());
    expect(docOf(result, 1).channel).toMatchObject({ id: OLD.id, name: 'Old thread', kind: 'thread', guild: { name: 'Test Guild' }, category: 'Text Channels' });
  });

  it('the marker for the next incremental export is the newest message of the chat and its threads', async () => {
    const result = await run(fake());
    expect(result.lastMessageId).toBe(idAt(40));
  });

  it('asks the thread search of the channel, active threads and archived ones', async () => {
    const client = fake();
    await run(client);
    expect(client.calls('searchThreads').map((c) => [c.id, (c.options as { archived: boolean }).archived])).toEqual([
      [TEXT_ID, false],
      [TEXT_ID, true],
    ]);
  });

  it('does not look for threads unless asked to', async () => {
    const client = fake();
    const result = await run(client, { settings: { includeThreads: false } });
    expect(result.outputs).toHaveLength(1);
    expect(client.calls('searchThreads')).toHaveLength(0);
    expect(client.calls('getMessages').every((call) => call.id === TEXT_ID)).toBe(true);
  });

  it('looks for the threads of a text channel and of an announcement channel, and of nothing else', async () => {
    const news = channel(NEWS_ID, 5, { name: 'news', parent_id: CATEGORY_ID });
    const voice = channel('800000000000000030', 2, { name: 'voice', parent_id: CATEGORY_ID });
    const dm: Channel = { id: '800000000000000040', type: 1, recipients: [{ id: '2000', username: 'bob' }] };
    const extra: Partial<FakeWorld> = {
      channels: [...world().channels, news, voice, dm],
      messages: { ...world().messages, [NEWS_ID]: [msg(0, 'n', {}, NEWS_ID)], [voice.id]: [msg(0, 'v', {}, voice.id)], [dm.id]: [msg(0, 'd', {}, dm.id)] },
      threads: { [TEXT_ID]: [], [NEWS_ID]: [], [voice.id]: [], [OLD.id]: [] },
    };
    for (const [id, expected] of [[NEWS_ID, true], [voice.id, false], [dm.id, false], [OLD.id, false], [CATEGORY_ID, false]] as const) {
      const client = fake(extra);
      await run(client, { channelId: id });
      expect(client.calls('searchThreads').length > 0, id).toBe(expected);
    }
  });

  it('works on the demo world: the channel and its two active threads', async () => {
    const result = await exportMock(MOCK_IDS.generalChannel, 'json', { settings: { count: 5, includeThreads: true } });
    expect(result).toMatchObject({ status: 'done', messageCount: 15 });
    expect(result.outputs.map((o) => o.path)).toEqual([
      'Discord Export/개발자 라운지 - general (2026-10-06).json',
      'Discord Export/개발자 라운지 - general - 점심 메뉴 투표 🍜 (2026-10-06).json',
      'Discord Export/개발자 라운지 - general - v2.0 릴리즈 노트 토론 (2026-10-06).json',
    ]);
  });

  it('applies the count to every file: the newest N of the channel and of each thread', async () => {
    const result = await run(fake(), { settings: { count: 1 } });
    expect(result.outputs.map((_, i) => contents(result, i))).toEqual([['m2'], ['old last'], ['archived last'], ['new last']]);
    expect(result.messageCount).toBe(4);
  });

  it('applies the content options to every file, and a thread with nothing left to show gets no file', async () => {
    const botThread = thread(idAt(25), TEXT_ID, 'Bots only', { last_message_id: idAt(26) });
    const client = fake({
      channels: [...world().channels, botThread],
      messages: { ...world().messages, [botThread.id]: [inThread(botThread.id, 26, 'beep', { author: BOT })] },
      threads: { [TEXT_ID]: [NEW, OLD, ARCHIVED, botThread] },
    });
    const result = await run(client, { settings: { content: { includeBots: false, includeSystem: true, includeReactions: true, includeEmbeds: true } } });
    expect(names(result)).toEqual(['general', 'Old thread', 'Archived thread', 'New thread']);
    expect(asked(client, botThread.id)).toBe(1);
    expect(result.lastMessageId).toBe(idAt(40));
  });

  it('gives threads with the same title different names, in the file system and in a ZIP', async () => {
    const a = thread(idAt(10), TEXT_ID, 'Same title', { last_message_id: idAt(11) });
    const b = thread(idAt(12), TEXT_ID, 'same TITLE', { last_message_id: idAt(13) });
    const result = await run(
      fake({
        channels: [...world().channels, a, b],
        messages: { [TEXT_ID]: [msg(0, 'm0')], [a.id]: [inThread(a.id, 11, 'a')], [b.id]: [inThread(b.id, 13, 'b')] },
        threads: { [TEXT_ID]: [a, b] },
      }),
    );
    expect(result.outputs).toHaveLength(3);
    const paths = result.outputs.map((o) => o.path.toLowerCase());
    expect(new Set(paths).size).toBe(3);
    expect(paths[1]).toBe('discord export/test guild - general - same title (2026-10-06).json');
    expect(paths[2]).toBe(`discord export/test guild - general - same title [${b.id}] (2026-10-06).json`);
    const zip = result.outputs.map((o) => o.zipPath.toLowerCase());
    expect(new Set(zip).size).toBe(3);
  });

  it('names a thread without a name after its id', async () => {
    const unnamed = thread(idAt(10), TEXT_ID, '', { last_message_id: idAt(11) });
    const result = await run(
      fake({ channels: [...world().channels, unnamed], messages: { [TEXT_ID]: [], [unnamed.id]: [inThread(unnamed.id, 11, 'x')] }, threads: { [TEXT_ID]: [unnamed] } }),
    );
    expect(docOf(result, 1).channel.name).toBe(unnamed.id);
  });

  it('writes the channel file even without messages, but no file for a thread without messages', async () => {
    const quiet = thread(idAt(10), TEXT_ID, 'Quiet', { last_message_id: null });
    const result = await run(fake({ channels: [...world().channels, quiet], messages: { [TEXT_ID]: [] }, threads: { [TEXT_ID]: [quiet] } }));
    expect(result.status).toBe('done');
    expect(names(result)).toEqual(['general']);
    expect(result.messageCount).toBe(0);
  });

  it('a thread that is not in the thread search of its parent is not exported', async () => {
    const result = await run(fake({ threads: { [TEXT_ID]: [NEW] } }));
    expect(names(result)).toEqual(['general', 'New thread']);
  });

  it('reports the phases: messages, threads, writing, with counts over the whole chat', async () => {
    const events: Array<[string, number]> = [];
    const result = await run(fake(), { ctx: { onProgress: (phase, n) => events.push([phase, n]) } });
    const phases = events.map(([phase]) => phase);
    expect(phases[0]).toBe('resolving');
    expect(phases.indexOf('threads')).toBeGreaterThan(phases.indexOf('messages'));
    expect(phases.indexOf('writing')).toBeGreaterThan(phases.lastIndexOf('messages'));
    expect(events.find(([phase]) => phase === 'threads')).toEqual(['threads', 3]);
    expect(events[events.length - 1]).toEqual(['writing', result.messageCount]);
    const counts = events.filter(([phase]) => phase === 'messages').map(([, n]) => n);
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
    expect(counts[counts.length - 1]).toBe(result.messageCount);
  });

  it('asks for the messages of one chat after the other', async () => {
    let active = 0;
    let most = 0;
    const client = fake({}, async (call) => {
      if (call.method !== 'getMessages') return undefined;
      active += 1;
      most = Math.max(most, active);
      await Promise.resolve();
      active -= 1;
      return undefined;
    });
    await run(client);
    expect(client.calls('getMessages')).toHaveLength(4);
    expect(most).toBe(1);
  });

  it('waits out a thread index that is not ready, with the injected sleep', async () => {
    const base = fake();
    let first = true;
    const client: FakeClient = {
      ...base,
      searchThreads: async (id, query, signal) => {
        if (first) {
          first = false;
          return { status: 'indexing', retryAfterMs: 1234 };
        }
        return base.searchThreads(id, query, signal);
      },
    };
    const waits: number[] = [];
    const result = await run(client, { ctx: { sleep: async (ms) => void waits.push(ms) } });
    expect(waits).toEqual([1234]);
    expect(names(result)).toEqual(['general', 'Old thread', 'Archived thread', 'New thread']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// skipping threads that cannot hold anything of the window
// ---------------------------------------------------------------------------------------------------------------------

describe('exportChat: threads outside the window are not even asked for', () => {
  it('skips threads that were last active before the start of the range', async () => {
    const client = fake();
    const result = await run(client, { settings: { from: at(30) } });
    expect(names(result)).toEqual(['general', 'New thread']);
    expect(asked(client, OLD.id)).toBe(0);
    expect(asked(client, ARCHIVED.id)).toBe(0);
    expect(contents(result, 1)).toEqual(['new second', 'new last']);
  });

  it('keeps a thread whose last activity is exactly at the start', async () => {
    const client = fake();
    const result = await run(client, { settings: { from: at(8) } });
    expect(names(result)).toEqual(['general', 'Archived thread', 'New thread']);
    expect(contents(result, 1)).toEqual(['archived last']);
  });

  it('skips threads that started after the end of the range', async () => {
    const client = fake();
    const result = await run(client, { settings: { to: at(10) } });
    expect(names(result)).toEqual(['general', 'Old thread', 'Archived thread']);
    expect(asked(client, NEW.id)).toBe(0);
  });

  it('skips threads with nothing after the previous export', async () => {
    const client = fake();
    const result = await run(client, { settings: { incremental: true }, ctx: { lastExportedId: idAt(10) } });
    expect(names(result)).toEqual(['New thread']);
    expect(contents(result, 0)).toEqual(['new first', 'new second', 'new last']);
    expect(docOf(result, 0).incremental).toBe(true);
    expect(asked(client, OLD.id)).toBe(0);
    expect(asked(client, ARCHIVED.id)).toBe(0);
    expect(result.lastMessageId).toBe(idAt(40));
  });

  it('writes nothing at all when nothing is new anywhere', async () => {
    const result = await run(fake(), { settings: { incremental: true }, ctx: { lastExportedId: idAt(40) } });
    expect(result).toMatchObject({ status: 'done', outputs: [], messageCount: 0, lastMessageId: null });
  });

  it('asks for a thread whose last message is unknown, and for one that points at a deleted message', async () => {
    const unknown = thread(idAt(10), TEXT_ID, 'No last id', { last_message_id: undefined });
    const deleted = thread(idAt(11), TEXT_ID, 'Deleted last', { last_message_id: idAt(9999) });
    const client = fake({
      channels: [...world().channels, unknown, deleted],
      messages: { [TEXT_ID]: [], [unknown.id]: [inThread(unknown.id, 12, 'u')], [deleted.id]: [inThread(deleted.id, 13, 'd')] },
      threads: { [TEXT_ID]: [unknown, deleted] },
    });
    const result = await run(client, { settings: { from: at(5) } });
    expect(names(result)).toEqual(['general', 'No last id', 'Deleted last']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// failures around threads
// ---------------------------------------------------------------------------------------------------------------------

describe('exportChat: failures around threads', () => {
  it('a thread search that is refused still gives the channel file, and the result is partial', async () => {
    const result = await run(fake({}, (call) => (call.method === 'searchThreads' ? apiError('forbidden') : undefined)));
    expect(result).toMatchObject({ status: 'partial', messageCount: 3, lastMessageId: null, error: { kind: 'forbidden' } });
    expect(names(result)).toEqual(['general']);
    // the channel's own file is complete: it is not marked partial
    expect(result.outputs[0]!.path).toBe('Discord Export/Test Guild - general (2026-10-06).json');
    expect(docOf(result, 0).partial).toBeUndefined();
  });

  it('says in the message that the problem is about the threads, in both languages', async () => {
    const refused = (): FakeClient => fake({}, (call) => (call.method === 'searchThreads' ? apiError('forbidden') : undefined));
    expect((await run(refused())).error).toEqual({ kind: 'forbidden', message: 'Threads: No access to this channel (403).' });
    expect((await run(refused(), { ctx: { locale: 'ko' } })).error).toEqual({ kind: 'forbidden', message: '스레드: 이 채널에 접근할 수 없습니다 (403).' });
    const unreadable = fake({}, (call) => (call.method === 'getMessages' && call.id === NEW.id ? apiError('not-found') : undefined));
    expect((await run(unreadable)).error).toEqual({ kind: 'not-found', message: 'Threads: Channel not found or deleted (404).' });
  });

  it('does not label a problem of the channel itself', async () => {
    const client = fake({}, (call) => (call.method === 'getMessages' && call.id === TEXT_ID ? apiError('forbidden') : undefined));
    expect((await run(client)).error).toEqual({ kind: 'forbidden', message: 'No access to this channel (403).' });
  });

  it('keeps the threads of the pages that were listed before the search failed', async () => {
    const many: Channel[] = Array.from({ length: 30 }, (_, i) => thread(idAt(100 + i), TEXT_ID, `t${i}`, { last_message_id: idAt(200 + i) }));
    const messages: Record<string, Message[]> = { [TEXT_ID]: [msg(0, 'm0')] };
    for (const t of many) messages[t.id] = [inThread(t.id, 201, `in ${t.name ?? ''}`)];
    const client = fake(
      { channels: [...world().channels, ...many], messages, threads: { [TEXT_ID]: many } },
      (call) => (call.method === 'searchThreads' && (call.options as { offset: number }).offset === 25 ? apiError('network') : undefined),
    );
    const result = await run(client);
    expect(result.status).toBe('partial');
    expect(result.error?.kind).toBe('network');
    expect(result.outputs).toHaveLength(1 + 25);
  });

  it('a thread index that never becomes ready is reported, after a bounded number of waits', async () => {
    const base = fake();
    const client: FakeClient = { ...base, searchThreads: async () => ({ status: 'indexing', retryAfterMs: 5 }) };
    const waits: number[] = [];
    const result = await run(client, { ctx: { sleep: async (ms) => void waits.push(ms) } });
    expect(result.status).toBe('partial');
    expect(result.error?.kind).toBe('unknown');
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.length).toBeLessThanOrEqual(10);
    expect(names(result)).toEqual(['general']);
  });

  it('a thread that cannot be read is skipped and the others are still exported', async () => {
    const client = fake({}, (call) => (call.method === 'getMessages' && call.id === OLD.id ? apiError('forbidden') : undefined));
    const result = await run(client);
    expect(result.status).toBe('partial');
    expect(result.error?.kind).toBe('forbidden');
    expect(names(result)).toEqual(['general', 'Archived thread', 'New thread']);
    expect(result.lastMessageId).toBeNull();
  });

  it('a failure that would hit every request stops the remaining threads', async () => {
    for (const kind of ['rate-limited', 'auth', 'blocked', 'network', 'server'] as const) {
      const client = fake({}, (call) => (call.method === 'getMessages' && call.id === OLD.id ? apiError(kind) : undefined));
      const result = await run(client);
      expect(result.status, kind).toBe('partial');
      expect(result.error?.kind, kind).toBe(kind);
      expect(names(result), kind).toEqual(['general']);
      expect(asked(client, ARCHIVED.id), kind).toBe(0);
      expect(asked(client, NEW.id), kind).toBe(0);
    }
  });

  it('a thread cut short by an error is written as partial, and the others carry on when it was a local one', async () => {
    const many = Array.from({ length: 250 }, (_, i) => inThread(OLD.id, i + 50, `o${i}`));
    const client = fake(
      { messages: { ...world().messages, [OLD.id]: many } },
      (call) => (call.method === 'getMessages' && call.id === OLD.id && call.n === 1 ? apiError('forbidden') : undefined),
    );
    const result = await run(client);
    expect(result.status).toBe('partial');
    expect(names(result)).toEqual(['general', 'Old thread', 'Archived thread', 'New thread']);
    expect(docOf(result, 1).partial).toBe(true);
    expect(result.outputs[1]!.path).toBe('Discord Export/Test Guild - general - Old thread (2026-10-06) (partial).json');
    expect(result.outputs[1]!.zipPath).toBe('Test Guild/Text Channels/general - Old thread (partial).json');
    expect(contents(result, 1)).toHaveLength(100);
    expect(docOf(result, 2).partial).toBeUndefined();
  });

  it('a channel that cannot be read does not keep its threads from being exported when the failure is a local one', async () => {
    const client = fake({}, (call) => (call.method === 'getMessages' && call.id === TEXT_ID ? apiError('forbidden') : undefined));
    const result = await run(client);
    expect(result.status).toBe('partial');
    expect(result.error?.kind).toBe('forbidden');
    expect(names(result)).toEqual(['Old thread', 'Archived thread', 'New thread']);
  });

  it('a failure that hits every request while reading the channel leaves the threads alone', async () => {
    const client = fake({}, (call) => (call.method === 'getMessages' && call.id === TEXT_ID ? apiError('server') : undefined));
    const result = await run(client);
    expect(result).toMatchObject({ status: 'failed', outputs: [] });
    expect(client.calls('searchThreads')).toHaveLength(0);
    expect(asked(client, OLD.id)).toBe(0);
  });

  it('reports the first problem when there are several', async () => {
    const client = fake({}, (call) => {
      if (call.method === 'getMessages' && call.id === OLD.id) return apiError('forbidden');
      if (call.method === 'getMessages' && call.id === NEW.id) return apiError('not-found');
      return undefined;
    });
    const result = await run(client);
    expect(result.error?.kind).toBe('forbidden');
    expect(names(result)).toEqual(['general', 'Archived thread']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// forum and media channels
// ---------------------------------------------------------------------------------------------------------------------

describe('exportChat: forum and media channels are their posts', () => {
  const post = (id: number, name: string, extra: Partial<Channel> = {}): Channel => thread(idAt(id), FORUM_ID, name, { type: 11, ...extra });
  const P1 = post(10, 'Post One', { last_message_id: idAt(14) });
  const P2 = post(30, 'Post Two', { last_message_id: idAt(32) });
  const P3 = post(-60, 'Old Post', { thread_metadata: { archived: true }, last_message_id: idAt(-50) });

  function forumWorld(type = 15): Partial<FakeWorld> {
    return {
      channels: [channel(CATEGORY_ID, 4, { name: 'Text Channels' }), channel(FORUM_ID, type, { name: 'questions', parent_id: CATEGORY_ID }), P1, P2, P3],
      messages: {
        [P1.id]: [inThread(P1.id, 11, 'p1 a'), inThread(P1.id, 12, 'p1 b'), inThread(P1.id, 14, 'p1 c')],
        [P2.id]: [inThread(P2.id, 31, 'p2 a'), inThread(P2.id, 32, 'p2 b')],
        [P3.id]: [inThread(P3.id, -55, 'p3 a'), inThread(P3.id, -50, 'p3 b')],
      },
      threads: { [FORUM_ID]: [P2, P1, P3] },
    };
  }
  const forum = (extra: Partial<FakeWorld> = {}, fail?: (call: FakeCall) => Failure | Promise<Failure>): FakeClient => fakeClient(world({ ...forumWorld(), ...extra }), fail);
  const exportForum = (client: FakeClient, over: { settings?: Partial<ExportSettings>; ctx?: Partial<ExportChatContext> } = {}): Promise<ExportChatResult> =>
    exportChat(client, target(FORUM_ID, { kind: 'forum', guildId: GUILD_ID }), settings('json', over.settings), context(over.ctx));

  it('writes one file per post, oldest first, and none for the forum itself', async () => {
    const client = forum();
    const result = await exportForum(client);
    expect(result).toMatchObject({ status: 'done', error: null, messageCount: 7 });
    expect(names(result)).toEqual(['Old Post', 'Post One', 'Post Two']);
    expect(asked(client, FORUM_ID)).toBe(0);
    expect(contents(result, 1)).toEqual(['p1 a', 'p1 b', 'p1 c']);
  });

  it('puts the posts of a forum into a folder named after it inside a ZIP', async () => {
    const result = await exportForum(forum());
    expect(result.outputs.map((o) => o.zipPath)).toEqual([
      'Test Guild/Text Channels/questions/Old Post.json',
      'Test Guild/Text Channels/questions/Post One.json',
      'Test Guild/Text Channels/questions/Post Two.json',
    ]);
    expect(result.outputs.map((o) => o.path)).toEqual([
      'Discord Export/Test Guild - questions - Old Post (2026-10-06).json',
      'Discord Export/Test Guild - questions - Post One (2026-10-06).json',
      'Discord Export/Test Guild - questions - Post Two (2026-10-06).json',
    ]);
  });

  it('lists the posts although includeThreads is off: a forum has nothing else', async () => {
    const client = forum();
    const result = await exportForum(client, { settings: { includeThreads: false } });
    expect(result.outputs).toHaveLength(3);
    expect(client.calls('searchThreads').length).toBeGreaterThan(0);
  });

  it('treats a media channel the same way', async () => {
    const result = await exportForum(forum(forumWorld(16)));
    expect(names(result)).toEqual(['Old Post', 'Post One', 'Post Two']);
  });

  it('describes a post as a thread of the forum', async () => {
    const result = await exportForum(forum());
    expect(docOf(result, 1).channel).toMatchObject({ id: P1.id, kind: 'thread', name: 'Post One', guild: { name: 'Test Guild' }, category: 'Text Channels' });
  });

  it('is done, with nothing to write, for a forum without posts', async () => {
    const result = await exportForum(forum({ threads: { [FORUM_ID]: [] } }));
    expect(result).toEqual({ outputs: [], messageCount: 0, lastMessageId: null, attachments: [], status: 'done', error: null });
  });

  it('is failed when the posts cannot be listed', async () => {
    const result = await exportForum(forum({}, (call) => (call.method === 'searchThreads' ? apiError('forbidden') : undefined)));
    expect(result).toMatchObject({ status: 'failed', outputs: [], error: { kind: 'forbidden', message: 'Posts: No access to this channel (403).' } });
    const korean = await exportForum(forum({}, (call) => (call.method === 'searchThreads' ? apiError('forbidden') : undefined)), { ctx: { locale: 'ko' } });
    expect(korean.error?.message).toBe('게시글: 이 채널에 접근할 수 없습니다 (403).');
  });

  it('is partial when some posts are written and then the posts run out of luck', async () => {
    const result = await exportForum(forum({}, (call) => (call.method === 'getMessages' && call.id === P1.id ? apiError('rate-limited') : undefined)));
    expect(result.status).toBe('partial');
    expect(names(result)).toEqual(['Old Post']);
  });

  it('applies range and count to every post', async () => {
    const result = await exportForum(forum(), { settings: { count: 1, from: at(0) } });
    expect(names(result)).toEqual(['Post One', 'Post Two']);
    expect(result.outputs.map((_, i) => contents(result, i))).toEqual([['p1 c'], ['p2 b']]);
  });

  it('exports an incremental forum: only the posts with something new', async () => {
    const result = await exportForum(forum(), { settings: { incremental: true }, ctx: { lastExportedId: idAt(12) } });
    expect(names(result)).toEqual(['Post One', 'Post Two']);
    expect(contents(result, 0)).toEqual(['p1 c']);
    expect(result.lastMessageId).toBe(idAt(32));
  });

  it('works on the demo forum: one file per post, the posts in a folder of the forum', async () => {
    const result = await exportMock(MOCK_IDS.forumChannel, 'txt', { settings: { count: 5 } });
    expect(result).toMatchObject({ status: 'done', messageCount: 25 });
    expect(result.outputs).toHaveLength(5);
    expect(result.outputs.every((o) => o.zipPath.startsWith('개발자 라운지/💻 DEVELOPMENT/질문-게시판/'))).toBe(true);
  });
});
