/**
 * `exportChat` (docs/PLAN.md §6): ONE chat in, files out. The demo world gives realistic chats (names, categories, DMs, a
 * showcase of message features); small hand-made worlds (tests/lib/export/fakeClient.ts) give exact control over times, ids
 * and failures. Threads / forums are in chatThreads.test.ts, saved attachments and whole jobs in chatFiles.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { ExportFormat, ExportSettings } from '@/shared/types';
import { DiscordApiError, isAbortError } from '../../../src/lib/discord/client';
import { collectMessages } from '../../../src/lib/discord/collect';
import { MOCK_IDS } from '../../../src/lib/discord/mock';
import type { Channel, Message } from '../../../src/lib/discord/types';
import { describeChatError, exportChat } from '../../../src/lib/export/chat';
import type { ExportChatContext, ExportChatResult } from '../../../src/lib/export/chat';
import { loadExportFormat } from '../../../src/lib/export/formats';
import { bytesOf, context, exportMock, mock, settings, target, textOf } from './exportKit';
import { BOB, BOT, CATEGORY_ID, channel, DAY0, fakeClient, GUILD, GUILD_ID, idAt, msg, TEXT_ID } from './fakeClient';
import type { FakeClient, FakeWorld, Failure, FakeCall } from './fakeClient';

// ---------------------------------------------------------------------------------------------------------------------
// set-up
// ---------------------------------------------------------------------------------------------------------------------

function world(extra: Partial<FakeWorld> = {}, count = 10): FakeWorld {
  return {
    guild: GUILD,
    roles: [{ id: '900000000000000001', name: 'Moderators', permissions: '0', position: 1 }],
    channels: [channel(CATEGORY_ID, 4, { name: 'Text Channels' }), channel(TEXT_ID, 0, { name: 'general', parent_id: CATEGORY_ID, topic: 'Welcome' })],
    messages: { [TEXT_ID]: Array.from({ length: count }, (_, minutes) => msg(minutes, `m${minutes}`)) },
    ...extra,
  };
}

const fake = (extra: Partial<FakeWorld> = {}, fail?: (call: FakeCall) => Failure | Promise<Failure>, count = 10): FakeClient => fakeClient(world(extra, count), fail);

interface Over {
  target?: Partial<Parameters<typeof target>[1]>;
  settings?: Partial<ExportSettings>;
  ctx?: Partial<ExportChatContext>;
}

/** One chat of a hand-made world, as JSON unless said otherwise. */
function chat(client: FakeClient, over: Over = {}, format: ExportFormat = 'json', channelId = TEXT_ID): Promise<ExportChatResult> {
  return exportChat(client, target(channelId, { guildId: GUILD_ID, ...over.target }), settings(format, over.settings), context(over.ctx));
}

interface JsonChat {
  channel: { id: string; name: string; kind: string; guild: { id: string; name: string } | null; category: string | null; topic: string | null };
  range: { after: string | null; before: string | null; limit: number | null };
  incremental?: boolean;
  partial?: boolean;
  messages: Message[];
  messageCount: number;
}

const docOf = (result: ExportChatResult, index = 0): JsonChat => JSON.parse(textOf(result.outputs[index]!)) as JsonChat;
const contents = (result: ExportChatResult, index = 0): string[] => docOf(result, index).messages.map((m) => m.content);
const range = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `m${from + i}`);
const at = (minutes: number): string => new Date(DAY0 + minutes * 60_000).toISOString();

const apiError = (kind: DiscordApiError['kind'], extra: { status?: number; retryAfterMs?: number } = {}): DiscordApiError => new DiscordApiError(kind, `raw ${kind}`, extra);

// ---------------------------------------------------------------------------------------------------------------------
// describeChatError
// ---------------------------------------------------------------------------------------------------------------------

describe('describeChatError', () => {
  it.each([
    ['auth', 'auth', 'Not signed in to Discord (401).', 'Discord에 로그인되어 있지 않습니다 (401).'],
    ['forbidden', 'forbidden', 'No access to this channel (403).', '이 채널에 접근할 수 없습니다 (403).'],
    ['not-found', 'not-found', 'Channel not found or deleted (404).', '채널을 찾을 수 없거나 삭제되었습니다 (404).'],
    ['blocked', 'blocked', 'Discord (or a network filter in front of it) blocked the requests; try again later.', 'Discord(또는 앞단의 네트워크 필터)가 요청을 차단했습니다. 잠시 후 다시 시도하세요.'],
    ['rate-limited', 'rate-limited', 'Discord rate limit reached; try again later.', 'Discord 요청 한도에 도달했습니다. 잠시 후 다시 시도하세요.'],
    ['network', 'network', 'Network error while contacting Discord.', 'Discord에 연결하는 중 네트워크 오류가 발생했습니다.'],
    ['server', 'server', 'Discord server error; try again later.', 'Discord 서버 오류입니다. 잠시 후 다시 시도하세요.'],
  ] as const)('maps %s to the shared kind %s with a fixed message in both languages', (kind, shared, en, ko) => {
    expect(describeChatError(apiError(kind), 'en')).toEqual({ kind: shared, message: en });
    expect(describeChatError(apiError(kind), 'ko')).toEqual({ kind: shared, message: ko });
  });

  it('never prints the raw message of an error it knows (it could carry anything the server said)', () => {
    expect(describeChatError(new DiscordApiError('server', 'Bearer abc.def.ghi leaked'), 'en').message).not.toContain('abc.def.ghi');
  });

  it.each(['unknown', 'not-allowed'] as const)('reports %s as unknown and keeps its own message', (kind) => {
    expect(describeChatError(apiError(kind), 'en')).toEqual({ kind: 'unknown', message: `raw ${kind}` });
  });

  it('says how long Discord asked to wait when that is a minute or more, rounded up', () => {
    expect(describeChatError(apiError('rate-limited', { retryAfterMs: 300_000 }), 'en').message).toBe('Discord asked us to wait 5 min - try again later.');
    expect(describeChatError(apiError('rate-limited', { retryAfterMs: 61_000 }), 'en').message).toBe('Discord asked us to wait 2 min - try again later.');
    expect(describeChatError(apiError('rate-limited', { retryAfterMs: 300_000 }), 'ko').message).toBe('Discord에서 5분 동안 기다려 달라고 요청했습니다. 나중에 다시 시도하세요.');
    expect(describeChatError(apiError('rate-limited', { retryAfterMs: 59_999 }), 'en').message).toBe('Discord rate limit reached; try again later.');
    expect(describeChatError(apiError('rate-limited'), 'en').message).toBe('Discord rate limit reached; try again later.');
    // only a rate limit carries a wait
    expect(describeChatError(apiError('server', { retryAfterMs: 600_000 }), 'en').message).toBe('Discord server error; try again later.');
  });

  it('describes anything else by its message, and falls back to English for an unexpected locale', () => {
    expect(describeChatError(new TypeError('boom'), 'en')).toEqual({ kind: 'unknown', message: 'boom' });
    expect(describeChatError('plain text', 'ko')).toEqual({ kind: 'unknown', message: 'plain text' });
    expect(describeChatError(apiError('auth'), 'xx' as never).message).toBe('Not signed in to Discord (401).');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// a finished export
// ---------------------------------------------------------------------------------------------------------------------

describe('exportChat: a finished export of one chat', () => {
  it.each(['txt', 'md', 'html', 'csv', 'json', 'xlsx'] as const)('%s: one output with the right path, ZIP path, MIME type and data', async (format) => {
    const result = await exportMock(MOCK_IDS.showcaseChannel, format);
    const module = await loadExportFormat(format);
    expect(result).toMatchObject({ status: 'done', error: null, attachments: [] });
    expect(result.outputs).toHaveLength(1);
    const [output] = result.outputs;
    expect(output!.mime).toBe(module.mime);
    expect(output!.path).toBe(`Discord Export/개발자 라운지 - feature-showcase (2026-10-06).${module.extension}`);
    expect(output!.zipPath).toBe(`개발자 라운지/💬 일반 GENERAL/feature-showcase.${module.extension}`);
    if (format === 'xlsx') {
      expect(output!.data).toBeInstanceOf(Uint8Array);
      expect(String.fromCharCode(...bytesOf(output!).slice(0, 2))).toBe('PK');
    } else {
      expect(typeof output!.data).toBe('string');
    }
    const all = await collectMessages(mock(), MOCK_IDS.showcaseChannel, { count: null, fromMs: null, toMs: null, afterId: null });
    expect(result.messageCount).toBe(all.length);
    expect(result.lastMessageId).toBe(all[all.length - 1]!.id);
  });

  it('uses the MIME types and extensions that the engine saves with', async () => {
    const mimes: Record<ExportFormat, string> = {
      txt: 'text/plain;charset=utf-8',
      md: 'text/markdown;charset=utf-8',
      html: 'text/html;charset=utf-8',
      csv: 'text/csv;charset=utf-8',
      json: 'application/json',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    for (const [format, mime] of Object.entries(mimes) as Array<[ExportFormat, string]>) {
      const result = await exportMock(MOCK_IDS.edge199Channel, format, { settings: { count: 3 } });
      expect(result.outputs[0]!.mime).toBe(mime);
      expect(result.outputs[0]!.path.endsWith(`.${format}`)).toBe(true);
      expect(result.outputs[0]!.zipPath.endsWith(`.${format}`)).toBe(true);
    }
  });

  it('writes the messages oldest to newest, every message exactly once', async () => {
    const result = await chat(fake({}, undefined, 250));
    expect(contents(result)).toEqual(range(0, 249));
    expect(result.messageCount).toBe(250);
    expect(docOf(result).messageCount).toBe(250);
    expect(result.lastMessageId).toBe(idAt(249));
  });

  it('is a complete, valid file for a chat without messages', async () => {
    const result = await chat(fake({ messages: {} }));
    expect(result).toMatchObject({ status: 'done', error: null, messageCount: 0, lastMessageId: null });
    expect(result.outputs).toHaveLength(1);
    expect(docOf(result).messages).toEqual([]);
    const mocked = await exportMock(MOCK_IDS.emptyChannel, 'html');
    expect(mocked.outputs).toHaveLength(1);
    expect(textOf(mocked.outputs[0]!)).toContain('No messages were found for this export.');
  });

  it('gives every chat the same files when it is exported twice with the same clock', async () => {
    const first = await chat(fake());
    const second = await chat(fake());
    expect(second).toEqual(first);
  });

  it('does not touch what the caller passed in', async () => {
    const given = settings('json', { count: 4, from: at(0), to: at(9) });
    const copy = structuredClone(given);
    const targetGiven = target(TEXT_ID, { guildId: GUILD_ID });
    const targetCopy = structuredClone(targetGiven);
    await exportChat(fake(), targetGiven, given, context());
    expect(given).toEqual(copy);
    expect(targetGiven).toEqual(targetCopy);
  });

  it('streams in batches: a long chat produces one output, whatever its size', async () => {
    const result = await chat(fake({}, undefined, 1050));
    expect(result.outputs).toHaveLength(1);
    expect(result.messageCount).toBe(1050);
    expect(contents(result)).toEqual(range(0, 1049));
  });
});

describe('exportChat: names and kinds come from the API, the DOM names are only a fallback', () => {
  it('describes the chat as Discord does', async () => {
    const result = await chat(fake());
    expect(docOf(result).channel).toEqual({
      id: TEXT_ID,
      name: 'general',
      kind: 'text',
      guild: { id: GUILD_ID, name: 'Test Guild' },
      category: 'Text Channels',
      topic: 'Welcome',
    });
    expect(result.outputs[0]!.path).toBe('Discord Export/Test Guild - general (2026-10-06).json');
    expect(result.outputs[0]!.zipPath).toBe('Test Guild/Text Channels/general.json');
  });

  it('falls back to the names the page showed when Discord does not say', async () => {
    const bare = fakeClient({ channels: [channel(TEXT_ID, 0)], messages: { [TEXT_ID]: [msg(0, 'hello')] } });
    const result = await chat(bare, { target: { guildName: 'DOM Guild', channelName: 'DOM channel', parentName: 'DOM Category' } });
    expect(docOf(result).channel).toMatchObject({ name: 'DOM channel', guild: { id: GUILD_ID, name: 'DOM Guild' }, category: 'DOM Category', topic: null });
    expect(result.outputs[0]!.path).toBe('Discord Export/DOM Guild - DOM channel (2026-10-06).json');
  });

  it('corrects the kind of a chat from its channel type', async () => {
    const dm = await exportMock(MOCK_IDS.dmFriend, 'json', { target: { kind: 'guild-channel', guildId: MOCK_IDS.bigGuild, guildName: 'wrong' }, settings: { count: 3 } });
    expect(docOf(dm).channel).toMatchObject({ kind: 'dm', guild: null, category: null, name: '김민준' });
    expect(dm.outputs[0]!.zipPath).toBe('Direct Messages/김민준.json');
    expect(dm.outputs[0]!.path).toBe('Discord Export/DM - 김민준 (2026-10-06).json');

    const group = await exportMock(MOCK_IDS.groupDmNamed, 'json', { target: { kind: 'guild-channel' }, settings: { count: 3 } });
    expect(docOf(group).channel).toMatchObject({ kind: 'group-dm', name: '주말 보드게임 모임 🎲' });

    const threadResult = await exportMock(MOCK_IDS.generalThread, 'json', { target: { kind: 'guild-channel' }, settings: { count: 3 } });
    expect(docOf(threadResult).channel).toMatchObject({ kind: 'thread', name: '점심 메뉴 투표 🍜', guild: { name: '개발자 라운지' } });
    expect(threadResult.outputs[0]!.zipPath).toBe('개발자 라운지/💬 일반 GENERAL/general - 점심 메뉴 투표 🍜.json');
  });

  it('names a DM by its partner, and a group DM by its name or else by its members', async () => {
    const named = await exportMock(MOCK_IDS.groupDmUnnamed, 'json', { target: { kind: 'group-dm' }, settings: { count: 1 } });
    expect(docOf(named).channel.name).toBe('Alex Rivera, Sam Patel, Jordan Lee');
    const legacy = await exportMock(MOCK_IDS.dmLegacyDiscriminator, 'json', { target: { kind: 'dm' }, settings: { count: 1 } });
    expect(docOf(legacy).channel.name).not.toBe('from the DOM');
  });

  it('exports a voice channel and refuses a category', async () => {
    const voice = await exportMock(MOCK_IDS.voiceChannel, 'txt', { settings: { count: 2 } });
    expect(voice.status).toBe('done');
    const category = await exportMock(MOCK_IDS.generalCategory, 'txt');
    expect(category).toMatchObject({ status: 'failed', outputs: [], messageCount: 0, lastMessageId: null, error: { kind: 'unknown', message: 'This channel has no messages to export.' } });
    const korean = await exportMock(MOCK_IDS.generalCategory, 'txt', { ctx: { locale: 'ko' } });
    expect(korean.error?.message).toBe('이 채널에는 내보낼 메시지가 없습니다.');
  });

  it('keeps Windows device names and hostile names out of paths', async () => {
    const con = await exportMock(MOCK_IDS.reservedNameChannel, 'txt', { settings: { count: 1 } });
    expect(con.outputs[0]!.zipPath.endsWith('/_con.txt')).toBe(true);
    for (const output of (await exportMock(MOCK_IDS.generalChannel, 'txt', { settings: { count: 1 }, ctx: { folderName: '../../evil/..' } })).outputs) {
      expect(output.path.split('/')).not.toContain('..');
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// which messages
// ---------------------------------------------------------------------------------------------------------------------

describe('exportChat: the message window', () => {
  it('exports the newest N messages for a count', async () => {
    const result = await chat(fake(), { settings: { count: 3 } });
    expect(contents(result)).toEqual(['m7', 'm8', 'm9']);
    expect(docOf(result).range).toEqual({ after: null, before: null, limit: 3 });
  });

  it('includes the messages exactly at the start and the end of a range', async () => {
    const result = await chat(fake(), { settings: { from: at(3), to: at(6) } });
    expect(contents(result)).toEqual(['m3', 'm4', 'm5', 'm6']);
    expect(docOf(result).range).toEqual({ after: at(3), before: at(6), limit: null });
  });

  it('a count with a range is the newest N inside the range', async () => {
    const result = await chat(fake(), { settings: { from: at(2), to: at(7), count: 2 } });
    expect(contents(result)).toEqual(['m6', 'm7']);
  });

  it('a range without any message is a valid, empty file', async () => {
    const result = await chat(fake(), { settings: { from: at(100), to: at(200) } });
    expect(result).toMatchObject({ status: 'done', messageCount: 0, lastMessageId: null });
    expect(result.outputs).toHaveLength(1);
    expect(docOf(result).messages).toEqual([]);
  });

  it('accepts a range that starts and ends at the same instant', async () => {
    expect(contents(await chat(fake(), { settings: { from: at(4), to: at(4) } }))).toEqual(['m4']);
  });

  it.each([
    [{ count: 0 }, 'the message count 0 is not an integer from 1 to 1000000'],
    [{ count: -5 }, 'the message count -5 is not an integer from 1 to 1000000'],
    [{ count: 1.5 }, 'the message count 1.5 is not an integer from 1 to 1000000'],
    [{ count: 1_000_001 }, 'the message count 1000001 is not an integer from 1 to 1000000'],
    [{ count: Number.NaN }, 'the message count NaN is not an integer from 1 to 1000000'],
    [{ from: 'yesterday' }, 'the start of the range is not a date'],
    [{ to: 'tomorrow' }, 'the end of the range is not a date'],
    [{ from: at(5), to: at(1) }, 'the start of the range is later than its end'],
    [{ format: 'pdf' as ExportFormat }, 'unknown format pdf'],
  ] as Array<[Partial<ExportSettings>, string]>)('refuses the settings %j before it asks Discord anything', async (bad, reason) => {
    const client = fake();
    const phases: string[] = [];
    const result = await chat(client, { settings: bad, ctx: { onProgress: (phase) => phases.push(phase) } });
    expect(result).toEqual({
      outputs: [],
      messageCount: 0,
      lastMessageId: null,
      attachments: [],
      status: 'failed',
      error: { kind: 'unknown', message: `Invalid export settings: ${reason}` },
    });
    expect(client.log).toEqual([]);
    expect(phases).toEqual([]);
    const korean = await chat(fake(), { settings: bad, ctx: { locale: 'ko' } });
    expect(korean.error?.message.startsWith('내보내기 설정이 올바르지 않습니다: ')).toBe(true);
  });

  it('accepts the largest count', async () => {
    expect((await chat(fake(), { settings: { count: 1_000_000 } })).messageCount).toBe(10);
  });
});

describe('exportChat: incremental exports', () => {
  const marker = idAt(4);

  it('exports only what is newer than the previous export and says so in the file', async () => {
    const result = await chat(fake(), { settings: { incremental: true }, ctx: { lastExportedId: marker } });
    expect(contents(result)).toEqual(range(5, 9));
    expect(docOf(result).incremental).toBe(true);
    expect(result.lastMessageId).toBe(idAt(9));
    expect(result.status).toBe('done');
  });

  it('writes no file when nothing is new, and leaves the marker alone (null)', async () => {
    const client = fake();
    const result = await chat(client, { settings: { incremental: true }, ctx: { lastExportedId: idAt(9) } });
    expect(result).toEqual({ outputs: [], messageCount: 0, lastMessageId: null, attachments: [], status: 'done', error: null });
    expect(client.calls('getMessages')).toHaveLength(1);
  });

  it('is a full export when the setting is off, when there is no previous export, or when the marker is not an id', async () => {
    for (const [incremental, lastExportedId] of [[false, marker], [true, null], [true, 'not an id'], [true, '']] as const) {
      const result = await chat(fake(), { settings: { incremental }, ctx: { lastExportedId } });
      expect(contents(result), `${String(incremental)} ${String(lastExportedId)}`).toEqual(range(0, 9));
      expect(docOf(result).incremental).toBeUndefined();
    }
  });

  it('combines with a count: the newest N of what is new', async () => {
    const result = await chat(fake(), { settings: { incremental: true, count: 2 }, ctx: { lastExportedId: marker } });
    expect(contents(result)).toEqual(['m8', 'm9']);
  });

  it('combines with a range: the later of the two lower bounds wins', async () => {
    const byMarker = await chat(fake(), { settings: { incremental: true, from: at(2) }, ctx: { lastExportedId: marker } });
    expect(contents(byMarker)).toEqual(range(5, 9));
    const byDate = await chat(fake(), { settings: { incremental: true, from: at(7) }, ctx: { lastExportedId: marker } });
    expect(contents(byDate)).toEqual(range(7, 9));
  });

  it('moves the marker over messages that the content options drop, so they are not looked at again', async () => {
    const messages = [msg(0, 'human'), msg(1, 'bot', { author: BOT })];
    const options = { content: { includeBots: false, includeSystem: true, includeReactions: true, includeEmbeds: true } };
    const first = await chat(fake({ messages: { [TEXT_ID]: messages } }), { settings: options });
    expect(contents(first)).toEqual(['human']);
    expect(first.lastMessageId).toBe(idAt(1));
    // the next incremental export finds only the dropped bot message: nothing to write, but the marker is known
    const next = await chat(fake({ messages: { [TEXT_ID]: [...messages, msg(2, 'bot again', { author: BOT })] } }), {
      settings: { ...options, incremental: true },
      ctx: { lastExportedId: idAt(1) },
    });
    expect(next).toMatchObject({ status: 'done', outputs: [], messageCount: 0, lastMessageId: idAt(2) });
  });

  it('does not advance the marker for an export that did not finish', async () => {
    const failing = fake({}, (call) => (call.method === 'getMessages' && call.n === 1 ? apiError('server') : undefined), 250);
    const result = await chat(failing, { settings: { incremental: true }, ctx: { lastExportedId: idAt(0) } });
    expect(result.status).toBe('partial');
    expect(result.lastMessageId).toBeNull();
  });
});

describe('exportChat: content options', () => {
  const rich = msg(3, 'rich', { reactions: [{ count: 1, emoji: { id: null, name: '👍' } }], embeds: [{ type: 'rich', title: 'An embed' }] });
  const mixed = [msg(0, 'human'), msg(1, 'bot', { author: BOT }), msg(2, 'join', { type: 7 }), rich, msg(4, 'hook', { webhook_id: '777' })];
  const content = (overrides: Partial<ExportSettings['content']>): Partial<ExportSettings> => ({
    content: { includeBots: true, includeSystem: true, includeReactions: true, includeEmbeds: true, ...overrides },
  });

  it('counts and writes only the messages the options keep, but moves the marker over all of them', async () => {
    const client = (): FakeClient => fake({ messages: { [TEXT_ID]: mixed } });
    const all = await chat(client());
    expect(contents(all)).toEqual(['human', 'bot', 'join', 'rich', 'hook']);
    const noBots = await chat(client(), { settings: content({ includeBots: false }) });
    expect(contents(noBots)).toEqual(['human', 'join', 'rich']);
    expect(noBots.messageCount).toBe(3);
    expect(docOf(noBots).messageCount).toBe(3);
    expect(noBots.lastMessageId).toBe(idAt(4));
    const noSystem = await chat(client(), { settings: content({ includeSystem: false }) });
    expect(contents(noSystem)).toEqual(['human', 'bot', 'rich', 'hook']);
    const neither = await chat(client(), { settings: content({ includeBots: false, includeSystem: false }) });
    expect(contents(neither)).toEqual(['human', 'rich']);
  });

  it('drops reactions and embeds from the messages that stay', async () => {
    const result = await chat(fake({ messages: { [TEXT_ID]: mixed } }), { settings: content({ includeReactions: false, includeEmbeds: false }) });
    const written = docOf(result).messages.find((m) => m.content === 'rich')!;
    expect('reactions' in written).toBe(false);
    expect(written.embeds).toEqual([]);
  });

  it('applies to every format', async () => {
    for (const format of ['txt', 'md', 'html', 'csv'] as const) {
      const result = await chat(fake({ messages: { [TEXT_ID]: mixed } }), { settings: content({ includeBots: false, includeSystem: false, includeReactions: false, includeEmbeds: false }) }, format);
      const text = textOf(result.outputs[0]!);
      expect(text, format).toContain('human');
      expect(text, format).not.toContain('beep');
      expect(text, format).not.toContain('An embed');
      expect(text, format).not.toContain('👍');
    }
  });

  it('still writes the file of a chat whose messages were all dropped', async () => {
    const result = await chat(fake({ messages: { [TEXT_ID]: [msg(0, 'bot', { author: BOT })] } }), { settings: content({ includeBots: false }) });
    expect(result).toMatchObject({ status: 'done', messageCount: 0, lastMessageId: idAt(0) });
    expect(result.outputs).toHaveLength(1);
    expect(docOf(result).messages).toEqual([]);
  });

  it('keeps the author of the dropped messages out of the file', async () => {
    const result = await chat(fake({ messages: { [TEXT_ID]: [msg(0, 'hello', { author: BOB }), msg(1, 'beep', { author: BOT })] } }), { settings: content({ includeBots: false }) }, 'txt');
    const text = textOf(result.outputs[0]!);
    expect(text).toContain('Bob');
    expect(text).not.toContain('helper');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// settings that reach the files
// ---------------------------------------------------------------------------------------------------------------------

describe('exportChat: context and settings reach the files', () => {
  it('writes the export time in the requested zone, in the header and in the name', async () => {
    const late = new Date('2026-10-06T20:30:00Z');
    const utc = await chat(fake(), { ctx: { timeZone: 'UTC', now: () => late } }, 'txt');
    expect(utc.outputs[0]!.path).toBe('Discord Export/Test Guild - general (2026-10-06).txt');
    expect(textOf(utc.outputs[0]!)).toContain('Exported: 2026-10-06 20:30:00 (UTC)');
    const seoul = await chat(fake(), { ctx: { timeZone: 'Asia/Seoul', now: () => late } }, 'txt');
    expect(seoul.outputs[0]!.path).toBe('Discord Export/Test Guild - general (2026-10-07).txt');
    expect(textOf(seoul.outputs[0]!)).toContain('Exported: 2026-10-07 05:30:00 (Asia/Seoul)');
  });

  it('writes the fixed words in the requested language', async () => {
    const en = textOf((await chat(fake(), { ctx: { locale: 'en' } }, 'txt')).outputs[0]!);
    const ko = textOf((await chat(fake(), { ctx: { locale: 'ko' } }, 'txt')).outputs[0]!);
    expect(en).toContain('Range: all messages');
    expect(ko).toContain('범위: 전체 메시지');
  });

  it('describes the range and the count in the header', async () => {
    const text = textOf((await chat(fake(), { settings: { count: 3, from: at(2) }, ctx: { timeZone: 'UTC' } }, 'txt')).outputs[0]!);
    expect(text).toContain('Range: from 2026-10-01 00:02:00: newest 3 messages');
  });

  it('puts the HTML theme into the file', async () => {
    const dark = textOf((await chat(fake(), { settings: { htmlTheme: 'dark' } }, 'html')).outputs[0]!);
    const light = textOf((await chat(fake(), { settings: { htmlTheme: 'light' } }, 'html')).outputs[0]!);
    expect(dark).toContain('<html lang="en" data-theme="dark">');
    expect(light).toContain('<html lang="en" data-theme="light">');
  });

  it('leaves the date out of the name when asked to', async () => {
    const result = await chat(fake(), { ctx: { dateInFileName: false } });
    expect(result.outputs[0]!.path).toBe('Discord Export/Test Guild - general.json');
    expect(result.outputs[0]!.zipPath).toBe('Test Guild/Text Channels/general.json');
  });

  it('saves into the folder that was asked for, segment by segment', async () => {
    expect((await chat(fake(), { ctx: { folderName: 'My Exports' } })).outputs[0]!.path).toBe('My Exports/Test Guild - general (2026-10-06).json');
    expect((await chat(fake(), { ctx: { folderName: 'a/b\\c' } })).outputs[0]!.path).toBe('a/b/c/Test Guild - general (2026-10-06).json');
    expect((await chat(fake(), { ctx: { folderName: '' } })).outputs[0]!.path.startsWith('Discord Export/')).toBe(true);
    expect((await chat(fake(), { ctx: { folderName: ' . ' } })).outputs[0]!.path.startsWith('Discord Export/')).toBe(true);
  });

  it('uses the injected clock, never the real one, when it is given', async () => {
    const result = await chat(fake(), { ctx: { now: () => new Date('2031-02-03T04:05:06Z'), timeZone: 'UTC' } }, 'txt');
    expect(result.outputs[0]!.path).toContain('(2031-02-03)');
    expect(textOf(result.outputs[0]!)).toContain('2031-02-03 04:05:06');
  });

  it('reads the real clock without an injected one', async () => {
    const before = Date.now();
    const result = await exportChat(fake(), target(TEXT_ID, { guildId: GUILD_ID }), settings('json'), { timeZone: 'UTC', locale: 'en', lastExportedId: null, dateInFileName: true, folderName: 'Discord Export' });
    const exportedAt = Date.parse((JSON.parse(textOf(result.outputs[0]!)) as { exportedAt: string }).exportedAt);
    expect(exportedAt).toBeGreaterThanOrEqual(before);
    expect(exportedAt).toBeLessThanOrEqual(Date.now());
  });

  it('turns an unknown theme into dark and an unknown locale into English', async () => {
    const html = textOf((await chat(fake(), { settings: { htmlTheme: 'neon' as never }, ctx: { locale: 'xx' as never } }, 'html')).outputs[0]!);
    expect(html).toContain('<html lang="en" data-theme="dark">');
  });

  it('mentions in the messages are written with the names the guild gives them', async () => {
    const text = '<@2000> asked <@&900000000000000001> in <#' + TEXT_ID + '>';
    const client = fake({ messages: { [TEXT_ID]: [msg(0, text, { mentions: [BOB], mention_roles: ['900000000000000001'] })] } });
    const out = textOf((await chat(client, {}, 'txt')).outputs[0]!);
    expect(out).toContain('@Bob asked @Moderators in #general');
  });

  it('knows the authors of replies and forwarded messages', async () => {
    const reply = msg(1, 'answer', { type: 19, referenced_message: msg(0, 'question', { author: BOB }), message_reference: { message_id: idAt(0) } });
    const out = textOf((await chat(fake({ messages: { [TEXT_ID]: [reply] } }), {}, 'txt')).outputs[0]!);
    expect(out).toContain('Replying to Bob');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// failures
// ---------------------------------------------------------------------------------------------------------------------

describe('exportChat: failures are results, not exceptions', () => {
  const kinds = [
    ['auth', 'auth'],
    ['forbidden', 'forbidden'],
    ['not-found', 'not-found'],
    ['blocked', 'blocked'],
    ['rate-limited', 'rate-limited'],
    ['network', 'network'],
    ['server', 'server'],
    ['unknown', 'unknown'],
  ] as const;

  it.each(kinds)('%s while looking the chat up: failed, nothing written', async (kind, shared) => {
    const client = fake({}, (call) => (call.method === 'getChannel' ? apiError(kind) : undefined));
    const result = await chat(client);
    expect(result).toMatchObject({ status: 'failed', outputs: [], messageCount: 0, lastMessageId: null, attachments: [], error: { kind: shared } });
    expect(client.calls('getMessages')).toHaveLength(0);
  });

  it.each(kinds)('%s on the first page of messages: failed, nothing written', async (kind, shared) => {
    const result = await chat(fake({}, (call) => (call.method === 'getMessages' ? apiError(kind) : undefined)));
    expect(result).toMatchObject({ status: 'failed', outputs: [], messageCount: 0, lastMessageId: null, error: { kind: shared } });
  });

  it.each(kinds)('%s after some pages: the messages that were reached are kept, marked partial', async (kind, shared) => {
    const client = fake({}, (call) => (call.method === 'getMessages' && call.n === 1 ? apiError(kind) : undefined), 250);
    const result = await chat(client);
    expect(result).toMatchObject({ status: 'partial', messageCount: 100, lastMessageId: null, error: { kind: shared } });
    expect(result.outputs).toHaveLength(1);
    // the newest messages come first when walking backwards: that is what the file holds
    expect(contents(result)).toEqual(range(150, 249));
    expect(docOf(result).partial).toBe(true);
    expect(result.outputs[0]!.path).toBe('Discord Export/Test Guild - general (2026-10-06) (partial).json');
    expect(result.outputs[0]!.zipPath).toBe('Test Guild/Text Channels/general (partial).json');
  });

  it('names the partial file in Korean and says why in every text header', async () => {
    const client = (): FakeClient => fake({}, (call) => (call.method === 'getMessages' && call.n === 1 ? apiError('network') : undefined), 250);
    const ko = await chat(client(), { ctx: { locale: 'ko' } }, 'txt');
    expect(ko.outputs[0]!.path).toBe('Discord Export/Test Guild - general (2026-10-06) (부분).txt');
    expect(ko.error?.message).toBe('Discord에 연결하는 중 네트워크 오류가 발생했습니다.');
    expect(textOf(ko.outputs[0]!)).toContain('상태: 부분 저장 - 중간에 중단되어 일부 메시지가 빠졌을 수 있습니다');
    const en = await chat(client(), {}, 'txt');
    expect(textOf(en.outputs[0]!)).toContain('Status: Partial - the export stopped early, so messages may be missing');
    for (const format of ['md', 'html'] as const) {
      expect(textOf((await chat(client(), {}, format)).outputs[0]!), format).toContain('Partial - the export stopped early');
    }
  });

  it('a rate limit with a long wait says how long, in both languages', async () => {
    const limited = (): FakeClient => fake({}, (call) => (call.method === 'getMessages' ? apiError('rate-limited', { retryAfterMs: 180_000 }) : undefined));
    expect((await chat(limited())).error).toEqual({ kind: 'rate-limited', message: 'Discord asked us to wait 3 min - try again later.' });
    expect((await chat(limited(), { ctx: { locale: 'ko' } })).error?.message).toBe('Discord에서 3분 동안 기다려 달라고 요청했습니다. 나중에 다시 시도하세요.');
  });

  it('reports a failure that is not a DiscordApiError by its message', async () => {
    const first = await chat(fake({}, (call) => (call.method === 'getMessages' ? new TypeError('boom') : undefined)));
    expect(first).toMatchObject({ status: 'failed', error: { kind: 'unknown', message: 'boom' } });
    const later = await chat(fake({}, (call) => (call.method === 'getMessages' && call.n === 1 ? new RangeError('later') : undefined), 250));
    expect(later).toMatchObject({ status: 'partial', error: { kind: 'unknown', message: 'later' } });
  });

  it('turns a bug inside the export into a failed result of this chat, not an exception', async () => {
    const client = fake();
    const broken = { ...client, getChannel: async () => null as unknown as Channel };
    expect(await chat(broken as FakeClient)).toMatchObject({ status: 'failed', outputs: [], error: { kind: 'unknown' } });
  });

  it('reports forbidden and hidden chats of the demo world as no access, an unknown id as not found', async () => {
    for (const id of [MOCK_IDS.forbiddenChannel, MOCK_IDS.hiddenChannel]) {
      expect(await exportMock(id, 'txt')).toMatchObject({ status: 'failed', outputs: [], error: { kind: 'forbidden', message: 'No access to this channel (403).' } });
    }
    expect(await exportMock(MOCK_IDS.unknownChannel, 'txt')).toMatchObject({ status: 'failed', error: { kind: 'not-found', message: 'Channel not found or deleted (404).' } });
    expect((await exportMock(MOCK_IDS.unknownChannel, 'txt', { ctx: { locale: 'ko' } })).error?.message).toBe('채널을 찾을 수 없거나 삭제되었습니다 (404).');
  });

  it('keeps going when the guild lookups fail for a reason other than the session', async () => {
    const client = fake({}, (call) => (call.method === 'getGuild' || call.method === 'getGuildChannels' || call.method === 'getGuildRoles' ? apiError('forbidden') : undefined));
    const result = await chat(client, { target: { guildName: 'DOM Guild', channelName: 'DOM name' } });
    expect(result.status).toBe('done');
    // the channel itself still names the chat; the guild falls back to the page's name
    expect(docOf(result).channel).toMatchObject({ name: 'general', guild: { name: 'DOM Guild' } });
  });

  it('stops for a rejected session even in the optional guild lookups', async () => {
    const client = fake({}, (call) => (call.method === 'getGuildChannels' ? apiError('auth') : undefined));
    expect(await chat(client)).toMatchObject({ status: 'failed', error: { kind: 'auth' } });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------------------------------------------------

describe('exportChat: cancel', () => {
  const aborted = async (promise: Promise<unknown>): Promise<unknown> => promise.then(
    () => 'resolved',
    (error: unknown) => (isAbortError(error) ? 'aborted' : error),
  );

  it('rejects with an AbortError before the first request when the signal is already aborted', async () => {
    const client = fake();
    const controller = new AbortController();
    controller.abort();
    expect(await aborted(chat(client, { ctx: { signal: controller.signal } }))).toBe('aborted');
    expect(client.log).toEqual([]);
  });

  it('rejects with an AbortError, named so, when it is cancelled while the chat is looked up', async () => {
    const controller = new AbortController();
    const client = fake({}, (call) => {
      if (call.method !== 'getChannel') return undefined;
      controller.abort();
      return new DiscordApiError('aborted', 'The request was aborted');
    });
    const error = await chat(client, { ctx: { signal: controller.signal } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('AbortError');
  });

  it('rejects when it is cancelled between two pages, and nothing is returned', async () => {
    const controller = new AbortController();
    const client = fake({}, (call) => {
      if (call.method === 'getMessages' && call.n === 1) controller.abort();
      return undefined;
    }, 250);
    expect(await aborted(chat(client, { ctx: { signal: controller.signal } }))).toBe('aborted');
    expect(client.calls('getMessages')).toHaveLength(2);
  });

  it('a cancel wins over whatever error the cancelled request ended with', async () => {
    for (const make of [() => new Error('socket closed'), () => apiError('network'), () => apiError('server')]) {
      const controller = new AbortController();
      const client = fake({}, (call) => {
        if (call.method !== 'getMessages' || call.n !== 1) return undefined;
        controller.abort();
        return make();
      }, 250);
      expect(await aborted(chat(client, { ctx: { signal: controller.signal } }))).toBe('aborted');
    }
  });

  it('rejects when it is cancelled while the guild is looked up, and does not remember the half-done lookup', async () => {
    const controller = new AbortController();
    let first = true;
    const client = fake({}, (call) => {
      if (call.method === 'getGuildChannels' && first) {
        first = false;
        controller.abort();
        return new DiscordApiError('aborted', 'x');
      }
      return undefined;
    });
    expect(await aborted(chat(client, { ctx: { signal: controller.signal } }))).toBe('aborted');
    const again = await chat(client);
    expect(again.status).toBe('done');
    expect(client.calls('getGuildChannels')).toHaveLength(2);
  });

  it('rejects when it is cancelled during the thread search', async () => {
    const controller = new AbortController();
    const client = fake({ threads: { [TEXT_ID]: [] } }, (call) => {
      if (call.method !== 'searchThreads') return undefined;
      controller.abort();
      return apiError('network');
    });
    expect(await aborted(chat(client, { settings: { includeThreads: true }, ctx: { signal: controller.signal } }))).toBe('aborted');
  });

  it('a cancel while the files are being written does not take the finished chat away: the caller decides', async () => {
    const controller = new AbortController();
    const result = await chat(fake(), { ctx: { signal: controller.signal, onProgress: (phase) => phase === 'writing' && controller.abort() } });
    expect(result).toMatchObject({ status: 'done', messageCount: 10 });
    expect(result.outputs).toHaveLength(1);
  });

  it('works without a signal, and with one that never fires', async () => {
    const controller = new AbortController();
    expect((await chat(fake(), { ctx: { signal: controller.signal } })).status).toBe('done');
    expect((await chat(fake())).status).toBe('done');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// progress
// ---------------------------------------------------------------------------------------------------------------------

describe('exportChat: progress', () => {
  it('reports the phases in order and the message count as it grows', async () => {
    const events: Array<[ItemPhaseName, number]> = [];
    const result = await chat(fake({}, undefined, 250), { ctx: { onProgress: (phase, n) => events.push([phase, n]) } });
    expect(events[0]).toEqual(['resolving', 0]);
    expect(events[events.length - 1]).toEqual(['writing', 250]);
    const counts = events.filter(([phase]) => phase === 'messages').map(([, n]) => n);
    expect(counts.slice(0, 3)).toEqual([100, 200, 250]);
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
    expect(counts[counts.length - 1]).toBe(result.messageCount);
    const order = events.map(([phase]) => phase);
    expect(order.indexOf('resolving')).toBeLessThan(order.indexOf('messages'));
    expect(order.lastIndexOf('messages')).toBeLessThan(order.indexOf('writing'));
    expect(order).not.toContain('threads');
  });

  it('a throwing callback does not fail the export', async () => {
    let calls = 0;
    const result = await chat(fake({}, undefined, 250), {
      ctx: {
        onProgress: () => {
          calls += 1;
          throw new Error('the observer is broken');
        },
      },
    });
    expect(result).toMatchObject({ status: 'done', error: null, messageCount: 250 });
    expect(calls).toBeGreaterThan(4);
  });

  it('works without a callback', async () => {
    expect((await chat(fake())).status).toBe('done');
  });

  it('reports a chat without messages as resolving, messages (none), writing', async () => {
    const events: string[] = [];
    await chat(fake({ messages: {} }), { ctx: { onProgress: (phase, n) => events.push(`${phase}:${n}`) } });
    expect(events).toEqual(['resolving:0', 'messages:0', 'writing:0']);
  });
});

type ItemPhaseName = Parameters<NonNullable<ExportChatContext['onProgress']>>[0];

// ---------------------------------------------------------------------------------------------------------------------
// guild lookups
// ---------------------------------------------------------------------------------------------------------------------

describe('exportChat: the guild is looked up once per client', () => {
  const second = '800000000000000020';
  const twoChannels = (): Partial<FakeWorld> => ({
    channels: [
      channel(CATEGORY_ID, 4, { name: 'Text Channels' }),
      channel(TEXT_ID, 0, { name: 'general', parent_id: CATEGORY_ID }),
      channel(second, 0, { name: 'random', parent_id: CATEGORY_ID }),
    ],
    messages: { [TEXT_ID]: [msg(0, 'a')], [second]: [msg(1, 'b', {}, second)] },
  });
  const counts = (client: FakeClient): number[] => [client.calls('getGuild').length, client.calls('getGuildChannels').length, client.calls('getGuildRoles').length];

  it('asks for the guild, its channels and its roles once for all chats of that guild', async () => {
    const client = fake(twoChannels());
    await chat(client, {}, 'json', TEXT_ID);
    await chat(client, {}, 'json', second);
    expect(counts(client)).toEqual([1, 1, 1]);
  });

  it('chats exported at the same time share one lookup', async () => {
    const client = fake(twoChannels());
    const [a, b] = await Promise.all([chat(client, {}, 'json', TEXT_ID), chat(client, {}, 'json', second)]);
    expect([a.status, b.status]).toEqual(['done', 'done']);
    expect(counts(client)).toEqual([1, 1, 1]);
  });

  it('a new client (a new job) asks again', async () => {
    await chat(fake(twoChannels()));
    const fresh = fake(twoChannels());
    await chat(fresh);
    expect(counts(fresh)).toEqual([1, 1, 1]);
  });

  it('asks again for the next chat when a lookup failed for a reason that may pass', async () => {
    for (const kind of ['network', 'server', 'rate-limited', 'blocked'] as const) {
      const client = fake(twoChannels(), (call) => (call.method === 'getGuildRoles' && call.n === 0 ? apiError(kind) : undefined));
      const first = await chat(client, {}, 'json', TEXT_ID);
      expect(first.status, kind).toBe('done');
      await chat(client, {}, 'json', second);
      expect(counts(client), kind).toEqual([2, 2, 2]);
    }
  });

  it('remembers a lookup that was refused for good', async () => {
    const client = fake(twoChannels(), (call) => (call.method === 'getGuildRoles' ? apiError('forbidden') : undefined));
    await chat(client, {}, 'json', TEXT_ID);
    await chat(client, {}, 'json', second);
    expect(counts(client)).toEqual([1, 1, 1]);
  });

  it('does not look up anything for a DM', async () => {
    const dm: Channel = { id: '800000000000000040', type: 1, recipients: [BOB] };
    const client = fakeClient({ channels: [dm], messages: { [dm.id]: [msg(0, 'hi', {}, dm.id)] } });
    const result = await exportChat(client, target(dm.id, { kind: 'dm', guildId: null }), settings('json'), context());
    expect(result.status).toBe('done');
    expect(client.calls('getGuild')).toHaveLength(0);
    expect(client.calls('getGuildChannels')).toHaveLength(0);
    expect(client.calls('getGuildRoles')).toHaveLength(0);
    expect(docOf(result).channel).toMatchObject({ name: 'Bob', kind: 'dm', guild: null });
  });

  it('asks for messages strictly one after the other', async () => {
    let active = 0;
    let most = 0;
    const client = fake({}, async (call) => {
      if (call.method !== 'getMessages') return undefined;
      active += 1;
      most = Math.max(most, active);
      await Promise.resolve();
      active -= 1;
      return undefined;
    }, 450);
    await chat(client);
    expect(client.calls('getMessages')).toHaveLength(5);
    expect(most).toBe(1);
  });

  it('asks for 100 messages per request, walking back with the oldest id as the cursor', async () => {
    const client = fake({}, undefined, 250);
    await chat(client);
    expect(client.log.filter((line) => line.startsWith('getMessages'))).toEqual([
      `getMessages:${TEXT_ID}`,
      `getMessages:${TEXT_ID}:before=${idAt(150)}`,
      `getMessages:${TEXT_ID}:before=${idAt(50)}`,
    ]);
  });
});
