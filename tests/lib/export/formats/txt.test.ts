import { describe, expect, it } from 'vitest';
import { createMockClient, MOCK_IDS } from '../../../../src/lib/discord/mock';
import type { Message, User } from '../../../../src/lib/discord/types';
import { exportMock, textOf } from '../exportKit';
import { txtFormat } from '../../../../src/lib/export/formats/txt';
import { cleanText, getExportStrings, oneLine, resolveTimeZone, shieldLine, truncate } from '../../../../src/lib/export/formats/text';
import type { Chunk, ExportTarget, WriterContext, WriterOptions, WriterSummary } from '../../../../src/lib/export/types';
import { buildNameResolver } from '../../../../src/lib/message';
import { oneLine as messageOneLine, truncate as messageTruncate } from '../../../../src/lib/message/text';
import { expectLinearScaling, inflateMessages } from '../scaling';

const ALICE: User = { id: '1000', username: 'alice', global_name: 'Alice' };
const BOB: User = { id: '2000', username: 'bob', global_name: 'Bob' };
const BOT: User = { id: '4000', username: 'helper', bot: true };

const OPTIONS: WriterOptions = { after: null, before: null, limit: null, htmlTheme: 'dark', locale: 'en', timeZone: 'UTC' };
const TARGET: ExportTarget = {
  channelId: '555',
  kind: 'text',
  channelName: 'general',
  guildId: '777',
  guildName: 'My Server',
  categoryName: 'Text Channels',
  parentChannelName: null,
  topic: 'Welcome!',
};
const NO_NAMES = { user: () => undefined, channel: () => undefined, role: () => undefined };
const RULE = '='.repeat(64);
const RLO = String.fromCharCode(0x202e);
const ZWJ = String.fromCharCode(0x200d);
const BIDI_CONTROLS = new RegExp(`[${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}]`);

function context(overrides: { options?: Partial<WriterOptions>; target?: Partial<ExportTarget>; names?: WriterContext['names'] } = {}): WriterContext {
  return {
    target: { ...TARGET, ...overrides.target },
    options: { ...OPTIONS, ...overrides.options },
    exportedAt: new Date('2026-10-06T12:34:56.000Z'),
    names: overrides.names ?? NO_NAMES,
  };
}

function message(n: number, content: string, extra: Partial<Message> = {}): Message {
  return {
    id: String(100000000000000000n + BigInt(n)),
    channel_id: '555',
    author: ALICE,
    content,
    timestamp: `2026-10-05T12:00:${String(n % 60).padStart(2, '0')}.000000+00:00`,
    edited_timestamp: null,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    type: 0,
    ...extra,
  };
}

function asText(chunks: Chunk[]): string {
  return chunks.map((c) => (typeof c === 'string' ? c : new TextDecoder().decode(c))).join('');
}

function render(batches: Message[][], ctx: WriterContext = context(), summary?: Partial<WriterSummary>): string {
  const writer = txtFormat.createWriter(ctx);
  const all = batches.flat();
  const chunks: Chunk[] = [...writer.start()];
  for (const batch of batches) chunks.push(...writer.write(batch));
  chunks.push(
    ...writer.end({
      messageCount: all.length,
      firstTimestamp: all[0]?.timestamp ?? null,
      lastTimestamp: all[all.length - 1]?.timestamp ?? null,
      ...summary,
    }),
  );
  return asText(chunks);
}

/** Lines that a reader or script would take for the start of a message. */
const HEADER_LINE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] /;
const headerLines = (text: string): string[] => text.split('\n').filter((line) => HEADER_LINE.test(line));

describe('txtFormat', () => {
  it('describes itself', () => {
    expect(txtFormat.id).toBe('txt');
    expect(txtFormat.label).toBe('Text (.txt)');
    expect(txtFormat.extension).toBe('txt');
    expect(txtFormat.mime).toBe('text/plain;charset=utf-8');
  });

  describe('exact output', () => {
    const original = message(1, 'hello');
    const reply = message(2, 'hi **Alice**', {
      author: BOB,
      type: 19,
      edited_timestamp: '2026-10-05T12:05:00.000000+00:00',
      message_reference: { message_id: original.id },
      referenced_message: original,
      reactions: [
        { count: 3, emoji: { id: null, name: '👍' } },
        { count: 2, emoji: { id: '123456789012345678', name: 'party' } },
      ],
    });
    const files = message(3, '', {
      attachments: [
        { id: '9', filename: 'report.pdf', size: 2048, url: 'https://cdn.discordapp.com/attachments/1/2/report.pdf' },
        { id: '10', filename: 'photo.png', size: 10, url: 'https://cdn.discordapp.com/attachments/1/3/photo.png' },
      ],
    });
    const join = message(4, '', { author: BOT, type: 7 });
    const code = message(5, 'see <@2000>:\n```js\nlet a = 1;\n```');
    const messages = [original, reply, files, join, code];

    it('writes the documented log layout', () => {
      const names = buildNameResolver({ users: { '2000': 'Bob' } });
      expect(render([messages], context({ names }))).toBe(
        [
          RULE,
          'Server: My Server',
          'Channel: Text Channels / #general',
          'Topic: Welcome!',
          'Range: all messages',
          'Exported: 2026-10-06 12:34:56 (UTC)',
          'Generator: Discord Chat Extractor',
          RULE,
          '',
          '[2026-10-05 12:00:01] Alice',
          'hello',
          '',
          '[2026-10-05 12:00:02] Bob',
          '> ↪ Replying to Alice: hello',
          'hi Alice (edited)',
          '{Reactions}',
          '👍 3  :party: 2',
          '',
          '[2026-10-05 12:00:03] Alice',
          '{Attachments}',
          'report.pdf (2 KB) https://cdn.discordapp.com/attachments/1/2/report.pdf',
          'photo.png (10 B) https://cdn.discordapp.com/attachments/1/3/photo.png',
          '',
          '[2026-10-05 12:00:04] * helper joined the server.',
          '',
          '[2026-10-05 12:00:05] Alice',
          'see @Bob:',
          '```js',
          'let a = 1;',
          '```',
          '',
          RULE,
          'Messages: 5',
          'First message: 2026-10-05 12:00:01',
          'Last message: 2026-10-05 12:00:05',
          RULE,
          '',
        ].join('\n'),
      );
    });

    it('writes the same words in Korean', () => {
      const text = render([[original, reply, join]], context({ options: { locale: 'ko' } }));
      expect(text).toBe(
        [
          RULE,
          '서버: My Server',
          '채널: Text Channels / #general',
          '주제: Welcome!',
          '범위: 전체 메시지',
          '내보낸 시각: 2026-10-06 12:34:56 (UTC)',
          '생성 도구: Discord Chat Extractor',
          RULE,
          '',
          '[2026-10-05 12:00:01] Alice',
          'hello',
          '',
          '[2026-10-05 12:00:02] Bob',
          '> ↪ Alice님에게 답장: hello',
          'hi Alice (수정됨)',
          '{리액션}',
          '👍 3  :party: 2',
          '',
          '[2026-10-05 12:00:04] * helper님이 서버에 참여했어요.',
          '',
          RULE,
          '메시지 수: 3',
          '첫 메시지: 2026-10-05 12:00:01',
          '마지막 메시지: 2026-10-05 12:00:04',
          RULE,
          '',
        ].join('\n'),
      );
    });
  });

  describe('header and footer', () => {
    it('is a valid file for an empty channel: header, no messages, a zero count', () => {
      const text = render([[], []], context(), { messageCount: 0, firstTimestamp: null, lastTimestamp: null });
      expect(text).toBe(
        [RULE, 'Server: My Server', 'Channel: Text Channels / #general', 'Topic: Welcome!', 'Range: all messages', 'Exported: 2026-10-06 12:34:56 (UTC)', 'Generator: Discord Chat Extractor', RULE, '', RULE, 'Messages: 0', RULE, ''].join('\n'),
      );
    });

    it('leaves out the server and topic lines for a DM and shows the DM name', () => {
      const text = render([[]], context({ target: { kind: 'dm', channelName: '김민준', guildId: null, guildName: null, categoryName: null, topic: null } }));
      expect(text.split('\n').slice(0, 5)).toEqual([RULE, 'Channel: 김민준', 'Range: all messages', 'Exported: 2026-10-06 12:34:56 (UTC)', 'Generator: Discord Chat Extractor']);
    });

    it('shows threads under their parent channel', () => {
      const text = render([[]], context({ target: { kind: 'thread', channelName: 'lunch poll', parentChannelName: 'general' } }));
      expect(text).toContain('Channel: Text Channels / #general / lunch poll\n');
    });

    it('describes the requested range in the export time zone', () => {
      const bounded = context({ options: { after: '2026-01-01T00:00:00.000Z', before: '2026-02-01T00:00:00.000Z', timeZone: 'Asia/Seoul' } });
      expect(render([[]], bounded)).toContain('Range: 2026-01-01 09:00:00 to 2026-02-01 09:00:00\n');
      expect(render([[]], context({ options: { after: '2026-01-01T00:00:00.000Z' } }))).toContain('Range: from 2026-01-01 00:00:00\n');
      expect(render([[]], context({ options: { before: '2026-02-01T00:00:00.000Z', locale: 'ko' } }))).toContain('범위: 2026-02-01 00:00:00까지\n');
    });

    it('describes a message count: always the NEWEST N, inside the range when there is one (the first-N-from-a-start reading of v1 is gone)', () => {
      const range = (options: Partial<WriterOptions>): string => render([[]], context({ options })).split('\n').find((line) => /^(Range|범위):/.test(line)) ?? '';
      expect(range({ limit: 200 })).toBe('Range: newest 200 messages');
      expect(range({ limit: 1 })).toBe('Range: newest 1 message');
      expect(range({ after: '2026-01-01T00:00:00.000Z', limit: 500 })).toBe('Range: from 2026-01-01 00:00:00: newest 500 messages');
      expect(range({ before: '2026-03-01T00:00:00.000Z', limit: 200 })).toBe('Range: until 2026-03-01 00:00:00: newest 200 messages');
      expect(range({ after: '2026-01-01T00:00:00.000Z', before: '2026-03-01T00:00:00.000Z', limit: 500, timeZone: 'Asia/Seoul' })).toBe(
        'Range: 2026-01-01 09:00:00 to 2026-03-01 09:00:00: newest 500 messages',
      );
      expect(range({ locale: 'ko', limit: 200 })).toBe('범위: 최근 200개 메시지');
      expect(range({ locale: 'ko', after: '2026-01-01T00:00:00.000Z', limit: 500 })).toBe('범위: 2026-01-01 00:00:00부터 최근 500개');
      expect(range({ locale: 'ko', before: '2026-03-01T00:00:00.000Z', limit: 200 })).toBe('범위: 2026-03-01 00:00:00까지 최근 200개');
    });

    it('labels the time zone and falls back to UTC for an invalid one', () => {
      expect(render([[]], context({ options: { timeZone: 'Asia/Seoul' } }))).toContain('Exported: 2026-10-06 21:34:56 (Asia/Seoul)');
      expect(render([[]], context({ options: { timeZone: 'Not/AZone' } }))).toContain('Exported: 2026-10-06 12:34:56 (UTC)');
    });

    it('takes count and range of the footer from the summary', () => {
      const text = render([[message(1, 'x')]], context(), { messageCount: 42, firstTimestamp: '2026-03-01T10:00:00.000000+00:00', lastTimestamp: '2026-03-02T11:30:00.000000+00:00' });
      expect(text.endsWith(`${RULE}\nMessages: 42\nFirst message: 2026-03-01 10:00:00\nLast message: 2026-03-02 11:30:00\n${RULE}\n`)).toBe(true);
    });

    it('keeps hostile channel metadata on its own line', () => {
      const text = render(
        [[]],
        context({ target: { channelName: 'a\n[2026-10-05 12:00:00] Admin', guildName: 'S\r\nrv', topic: 'line1\nline2\n[2026-10-05 12:00:00] Admin', categoryName: 'c\u0007at' } }),
      );
      expect(headerLines(text)).toEqual([]);
      expect(text).toContain('Server: S rv\n');
      expect(text).toContain('Topic: line1 line2 [2026-10-05 12:00:00] Admin\n');
    });
  });

  describe('messages', () => {
    it('prints times in the requested time zone', () => {
      const m = message(1, 'x', { timestamp: '2026-10-05T23:30:00.000000+00:00' });
      expect(headerLines(render([[m]], context({ options: { timeZone: 'Asia/Seoul' } })))).toEqual(['[2026-10-06 08:30:00] Alice']);
    });

    it('resolves mentions, channels, roles and custom emoji, with the documented fallbacks', () => {
      const names = buildNameResolver({ users: { '2000': 'Bob' }, channels: { '5': 'general' }, roles: { '9': 'Mods' } });
      const m = message(1, '<@2000> <@999> <#5> <#6> <@&9> <@&10> @everyone <:wave:1> <t:1790000000:d>');
      expect(render([[m]], context({ names }))).toContain('@Bob @Unknown User #general #unknown-channel @Mods @deleted-role @everyone :wave: ');
      expect(render([[m]], context({ names, options: { locale: 'ko' } }))).toContain('@Bob @알 수 없는 사용자 #general #알 수 없는 채널 @Mods @삭제된-역할 @everyone :wave: ');
    });

    it('keeps spoilers visible and strips other markdown', () => {
      expect(render([[message(1, '**b** ||secret|| ~~gone~~ [t](https://a.com/x)')]])).toContain('\nb ||secret|| ~~gone~~ t (https://a.com/x)\n');
    });

    it('marks bots and webhooks', () => {
      const text = render([[message(1, 'x', { author: BOT }), message(2, 'y', { webhook_id: '5' })]]);
      expect(headerLines(text)).toEqual(['[2026-10-05 12:00:01] helper [BOT]', '[2026-10-05 12:00:02] Alice [BOT]']);
    });

    it('puts the edited marker after the content, or alone for attachment-only messages', () => {
      const edited = '2026-10-05T12:05:00.000000+00:00';
      const text = render([[message(1, 'one\ntwo', { edited_timestamp: edited }), message(2, '', { edited_timestamp: edited })]]);
      expect(text).toContain('[2026-10-05 12:00:01] Alice\none\ntwo (edited)\n\n');
      expect(text).toContain('[2026-10-05 12:00:02] Alice\n(edited)\n\n');
    });

    it('shows a reply header, also for deleted and unavailable originals', () => {
      const original = message(1, 'the **original** message');
      const text = render([
        [
          original,
          message(2, 'a', { type: 19, message_reference: { message_id: original.id }, referenced_message: original }),
          message(3, 'b', { type: 19, message_reference: { message_id: '404' }, referenced_message: null }),
          message(4, 'c', { type: 19, message_reference: { message_id: '404' } }),
          message(5, 'd', { type: 19, message_reference: { message_id: original.id }, referenced_message: { ...message(9, '', { attachments: [{ id: '1', filename: 'a.png', size: 1, url: 'https://cdn.discordapp.com/a.png' }] }), author: BOB } }),
        ],
      ]);
      expect(text).toContain('Alice\n> ↪ Replying to Alice: the original message\na\n');
      expect(text).toContain('\n> ↪ Original message was deleted\nb\n');
      expect(text).toContain('\n> ↪ Original message is unavailable\nc\n');
      expect(text).toContain('\n> ↪ Replying to Bob: Click to see attachment\nd\n');
    });

    it.each(['en', 'ko'] as const)('spells unresolvable mentions in a reply preview like in the body (%s)', (locale) => {
      const content = 'hello <@999> in <#888> and <@&777>';
      const original = message(1, content);
      const reply = message(2, content, { type: 19, message_reference: { message_id: original.id }, referenced_message: original });
      const lines = render([[reply]], context({ options: { locale } })).split('\n');
      const preview = (lines.find((l) => l.startsWith('> ↪ ')) ?? '').replace(/^> ↪ .*?: /, '');
      const body = lines.find((l) => l.startsWith('hello ')) ?? '';
      expect(preview).toBe(body);
      expect(body).toContain(locale === 'ko' ? '#알 수 없는 채널' : '#unknown-channel');
    });

    it('lists attachment name, size and URL, and the name only when there is no http(s) URL', () => {
      const m = message(1, '', {
        attachments: [
          { id: '1', filename: 'a b.png', size: 1536, url: 'https://cdn.discordapp.com/attachments/1/1/a%20b.png?ex=1&hm=2' },
          { id: '2', filename: 'inline.png', size: 3, url: 'data:image/png;base64,AAAA' },
          { id: '3', filename: 'js.png', size: 3, url: 'javascript:alert(1)' },
        ],
      });
      expect(render([[m]])).toContain(
        '{Attachments}\na b.png (1.5 KB) https://cdn.discordapp.com/attachments/1/1/a%20b.png?ex=1&hm=2\ninline.png (3 B)\njs.png (3 B)\n\n',
      );
    });

    it('prints embeds with title, URL, description, fields and footer', () => {
      const m = message(1, 'see this', {
        embeds: [
          {
            type: 'rich',
            title: 'Maintenance',
            url: 'https://example.com/status',
            description: 'Tonight **02:00**\nsecond line',
            author: { name: 'Status Page' },
            fields: [
              { name: 'Affected', value: 'API' },
              { name: 'Notes', value: 'one\ntwo' },
            ],
            footer: { text: 'Status Bot' },
            timestamp: '2026-10-05T12:00:00.000000+00:00',
          },
          { type: 'link', url: 'https://example.com/plain' },
        ],
      });
      expect(render([[m]])).toContain(
        [
          'see this',
          '{Embed}',
          'Status Page',
          'Maintenance',
          'https://example.com/status',
          'Tonight 02:00',
          'second line',
          'Affected: API',
          'Notes: one',
          '  two',
          'Status Bot · 2026-10-05 12:00:00',
          '{Embed}',
          'https://example.com/plain',
          '',
        ].join('\n'),
      );
    });

    it('prints stickers, polls, forwarded messages and reactions', () => {
      const sticker = message(1, '', {
        sticker_items: [
          { id: '123', name: 'wave', format_type: 1 },
          { id: '124', name: '웃는 고양이', format_type: 3 },
        ],
      });
      const poll = message(2, '', {
        poll: {
          question: { text: 'Lunch?' },
          answers: [
            { answer_id: 1, poll_media: { text: 'Ramen', emoji: { id: null, name: '🍜' } } },
            { answer_id: 2, poll_media: { text: 'Pizza' } },
          ],
          results: { is_finalized: false, answer_counts: [{ id: 1, count: 1 }, { id: 2, count: 2 }] },
        },
      });
      const forward = message(3, '', {
        message_reference: { type: 1, message_id: '5', channel_id: '6' },
        message_snapshots: [
          {
            message: {
              content: 'original **text**\nsecond',
              timestamp: '2026-10-01T08:00:00.000000+00:00',
              attachments: [{ id: '1', filename: 'a.zip', size: 2048, url: 'https://cdn.discordapp.com/attachments/1/1/a.zip' }],
              embeds: [{ title: 'Embedded' }],
            },
          },
        ],
      });
      const text = render([[sticker, poll, forward]]);
      expect(text).toContain('{Stickers}\nwave https://media.discordapp.net/stickers/123.png?size=160\n웃는 고양이\n');
      expect(text).toContain('{Poll}\nLunch?\n1. 🍜 Ramen: 1 vote\n2. Pizza: 2 votes\n3 votes in total\n');
      expect(text).toContain(
        [
          '{Forwarded}',
          '> (2026-10-01 08:00:00)',
          '> original text',
          '> second',
          '> {Attachments}',
          '> a.zip (2 KB) https://cdn.discordapp.com/attachments/1/1/a.zip',
          '> {Embed}',
          '> Embedded',
          '',
        ].join('\n'),
      );
    });

    it('prints every system message as one line starting with *', () => {
      const names = buildNameResolver();
      const text = render([
        [
          message(1, '', { type: 7 }),
          message(2, '', { type: 6, message_reference: { message_id: '1' } }),
          message(3, '', { type: 8 }),
          message(4, '', { type: 18, content: 'my thread' }),
          message(5, '', { type: 4, content: 'new\nname' }),
          message(6, '', { type: 3, call: { participants: ['1000', '2000'], ended_timestamp: '2026-10-05T12:05:06.000000+00:00' } }),
        ],
      ], context({ names }));
      expect(text).toContain('[2026-10-05 12:00:01] * Alice joined the server.\n');
      expect(text).toContain('[2026-10-05 12:00:02] * Alice pinned a message to this channel.\n');
      expect(text).toContain('[2026-10-05 12:00:03] * Alice boosted the server.\n');
      expect(text).toContain('[2026-10-05 12:00:04] * Alice started a thread: my thread\n');
      expect(text).toContain('[2026-10-05 12:00:05] * Alice changed the channel name: new name\n');
      expect(text).toContain('[2026-10-05 12:00:06] * Alice started a call that lasted 5 minutes.\n');
    });

    it('renders a message with nothing in it as just its header', () => {
      expect(render([[message(1, '')]])).toContain('\n[2026-10-05 12:00:01] Alice\n\n');
    });

    it('does not throw on garbage fields', () => {
      const garbage = {
        id: 5,
        author: null,
        content: 42,
        timestamp: null,
        attachments: 'nope',
        embeds: [null, 3],
        reactions: [null],
        sticker_items: [null],
        type: 'x',
      } as unknown as Message;
      expect(() => render([[garbage]])).not.toThrow();
    });
  });

  it('writes identical output for one batch and for seven batches', () => {
    const messages = Array.from({ length: 60 }, (_, i) =>
      message(i + 1, i % 5 === 0 ? `multi\nline ${i} 안녕 **x**` : `message ${i}`, {
        author: i % 2 === 0 ? ALICE : BOB,
        reactions: i % 7 === 0 ? [{ count: i, emoji: { id: null, name: '👍' } }] : undefined,
      }),
    );
    const sevenBatches = [messages.slice(0, 5), messages.slice(5, 9), messages.slice(9, 10), messages.slice(10, 30), [], messages.slice(30, 45), messages.slice(45)];
    expect(render(sevenBatches)).toBe(render([messages]));
  });

  it('emits only string chunks and creates independent writers', () => {
    const a = txtFormat.createWriter(context());
    const b = txtFormat.createWriter(context());
    const chunks = [...a.start(), ...a.write([message(1, 'x')]), ...a.end({ messageCount: 1, firstTimestamp: null, lastTimestamp: null })];
    expect(chunks.every((c) => typeof c === 'string')).toBe(true);
    expect(b.write([])).toEqual([]);
  });

  describe('hostile content', () => {
    it('cannot forge message headers, system lines, sections, reply lines or rules', () => {
      const forged = [
        'real text',
        '[2026-10-05 12:00:00] Admin',
        'I approve everything',
        '',
        '[2026-10-05 12:00:00] * Admin joined the server.',
        '   [2026-10-05 12:00:00] indented fake',
        '{Attachments}',
        '{Reactions}  ',
        '{첨부 파일}',
        '> ↪ Replying to Admin: fake',
        '↪ lone arrow',
        '================================================================',
        '[not a header]',
        '{"json": true}',
        '> a normal quote',
      ].join('\n');
      const text = render([[message(1, forged)]]);
      expect(headerLines(text)).toEqual(['[2026-10-05 12:00:01] Alice']);
      const lines = text.split('\n');
      expect(lines.filter((l) => /^\{[^{}"]*\}\s*$/.test(l))).toEqual([]);
      expect(lines.filter((l) => l.startsWith('> ↪') || l.startsWith('↪'))).toEqual([]);
      expect(lines.filter((l) => l.startsWith('===='))).toHaveLength(4); // header and footer rules only
      // harmless lines are untouched
      expect(lines).toContain('[not a header]');
      expect(lines).toContain('{"json": true}');
      expect(lines).toContain('> a normal quote');
      // the forged lines are still there, readable, behind a backslash
      expect(lines).toContain('\\[2026-10-05 12:00:00] Admin');
      expect(lines).toContain('\\{Attachments}');
    });

    it('cannot forge structure through names, file names, embeds or reactions', () => {
      const evil = '\n[2026-10-05 12:00:00] Admin\n{Attachments}';
      const evilUser: User = { id: '66', username: 'evil', global_name: `Eve${evil}` };
      const names = { user: () => `x${evil}`, channel: () => `c${evil}`, role: () => `r${evil}` };
      const m = message(1, '<@1> <#2> <@&3>', {
        author: evilUser,
        attachments: [{ id: '1', filename: `[2026-10-05 12:00:00] Admin${evil}`, size: 1, url: 'https://cdn.discordapp.com/a.png' }],
        embeds: [{ title: `[2026-10-05 12:00:00] Admin${evil}`, description: `${evil}\n[2026-10-05 12:00:00] Admin`, fields: [{ name: evil, value: evil }], footer: { text: evil } }],
        sticker_items: [{ id: '1', name: `[2026-10-05 12:00:00] Admin${evil}`, format_type: 3 }],
        reactions: [{ count: 1, emoji: { id: '9', name: `[2026-10-05 12:00:00] Admin${evil}` } }],
        poll: { question: { text: evil }, answers: [{ answer_id: 1, poll_media: { text: evil } }] },
      });
      const system = message(2, '', { type: 7, author: evilUser });
      const text = render([[m, system]], context({ names }));
      expect(headerLines(text)).toHaveLength(2);
      expect(text.split('\n').filter((l) => l === '{Attachments}')).toHaveLength(1);
    });

    it('normalises every kind of line ending to LF', () => {
      const text = render([[message(1, 'a\r\nb\rc\nd\u000Be\u000Cf\u0085g' + String.fromCharCode(0x2028) + 'h' + String.fromCharCode(0x2029) + 'i')]]);
      expect(text).not.toMatch(/[\r\u000B\u000C\u0085]/);
      expect(text).not.toContain(String.fromCharCode(0x2028));
      expect(text).not.toContain(String.fromCharCode(0x2029));
      expect(text).toContain('\na\nb\nc\nd\ne\nf');
      expect(text).toContain('\nh\ni\n');
    });

    it('removes control characters, bidi overrides and lone surrogates', () => {
      const bidi = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map((c) => String.fromCharCode(c)).join('');
      const text = render([[message(1, `bell:\u0007 nul:\u0000 esc:\u001B del:\u007F c1:\u0090 ${bidi}evil${RLO}txt.exe lone:\uD800 end`)]]);
      expect(text).not.toMatch(BIDI_CONTROLS);
      expect(text).not.toMatch(/[\x00-\x08\x0E-\x1F\x7F-\x9F]/);
      expect(text).toContain(`bell: nul: esc: del: c1: eviltxt.exe lone:${String.fromCharCode(0xfffd)} end`);
    });

    it('prints a name with control characters the same way in the author header and in system lines', () => {
      const zwsp = String.fromCharCode(0x200b);
      const odd: User = { id: '5000', username: `Ev${RLO}il${zwsp}name` };
      const text = render([[message(1, 'hi', { author: odd }), message(2, '', { author: odd, type: 7 })]]);
      expect(text).toContain(`] Ev il${zwsp}name\nhi\n`);
      expect(text).toContain(`] * Ev il${zwsp}name joined the server.\n`);
    });

    it('uses one single-line helper with the message module', () => {
      expect(oneLine).toBe(messageOneLine);
      expect(truncate).toBe(messageTruncate);
    });

    it('keeps tabs and zero-width joiners (they are part of the text)', () => {
      expect(render([[message(1, `a\tb 👨${ZWJ}👩${ZWJ}👧`)]])).toContain(`\na\tb 👨${ZWJ}👩${ZWJ}👧\n`);
    });

    it('handles an enormous single line in time proportional to its length and keeps it whole', () => {
      const text = expectLinearScaling(
        (length) => render([[message(1, 'x'.repeat(length)), message(2, `${'y'.repeat(length / 4)} ${'z'.repeat(length / 4)}`)]]),
        { small: 200_000, large: 2_000_000 },
      );
      expect(text).toContain(`\n${'x'.repeat(2_000_000)}\n`);
    });

    it('handles content that is nothing but line breaks, spaces or tabs in time proportional to its length', () => {
      const text = expectLinearScaling(
        (length) =>
          render([[message(1, '\n'.repeat(length)), message(2, ' '.repeat(length)), message(3, `${'\t'.repeat(length / 15)}x\n`.repeat(50)), message(4, `a${'\n'.repeat(length)}b`)]]),
        { small: 30_000, large: 300_000 },
      );
      expect(headerLines(text)).toHaveLength(4);
      expect(text).toContain('a\n\n');
    });

    it('survives markdown-looking and HTML-looking content as text', () => {
      const text = render([[message(1, '<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) # not a heading? **x**')]]);
      expect(text).toContain('<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) # not a heading? x');
    });
  });

  it('works end to end through exportChat with the demo client', async () => {
    const result = await exportMock(MOCK_IDS.showcaseChannel, 'txt', { ctx: { locale: 'ko' } });
    expect(result).toMatchObject({ status: 'done', error: null });
    expect(result.outputs).toHaveLength(1);
    const [output] = result.outputs;
    expect(output!.path).toBe('Discord Export/개발자 라운지 - feature-showcase (2026-10-06).txt');
    expect(output!.mime).toBe('text/plain;charset=utf-8');
    const text = textOf(output!);
    expect(
      text.startsWith(
        `${RULE}\n서버: 개발자 라운지\n채널: 💬 일반 GENERAL / #feature-showcase\n주제: One of everything: markdown, attachments, embeds, system messages …\n범위: 전체 메시지\n내보낸 시각: 2026-10-06 21:00:00 (Asia/Seoul)\n`,
      ),
    ).toBe(true);
    expect(headerLines(text)).toHaveLength(result.messageCount);
    expect(text).toContain(`메시지 수: ${result.messageCount}\n`);
    // mentions are resolved from the messages the engine has seen
    expect(text).toContain('@Sam Patel');
  });

  describe('mock showcase channel', () => {
    async function showcase(): Promise<{ messages: Message[]; names: ReturnType<typeof buildNameResolver> }> {
      const client = createMockClient({ latencyMs: 0 });
      const messages: Message[] = [];
      let before: string | undefined;
      for (;;) {
        const page = await client.getMessages(MOCK_IDS.showcaseChannel, { before, limit: 100 });
        if (page.length === 0) break;
        messages.push(...page);
        before = page[page.length - 1].id;
      }
      messages.reverse();
      const names = buildNameResolver();
      names.addMessages(messages);
      const channels = await client.getGuildChannels(MOCK_IDS.bigGuild);
      names.setChannels(Object.fromEntries(channels.map((c) => [c.id, c.name ?? ''])));
      const roles = await client.getGuildRoles(MOCK_IDS.bigGuild);
      names.setRoles(Object.fromEntries(roles.map((r) => [r.id, r.name])));
      return { messages, names };
    }

    const target: Partial<ExportTarget> = { channelName: 'showcase', guildName: 'Dev Lounge', categoryName: 'General', topic: 'Every feature once' };

    it('writes one header per message and every feature section', async () => {
      const { messages, names } = await showcase();
      const text = render([messages], context({ names, target, options: { timeZone: 'Asia/Seoul' } }));
      expect(headerLines(text)).toHaveLength(messages.length);
      for (const marker of ['{Attachments}', '{Embed}', '{Stickers}', '{Poll}', '{Forwarded}', '{Reactions}']) expect(text).toContain(`\n${marker}\n`);
      expect(text).toContain('> ↪ Replying to ');
      expect(text).toContain('> ↪ Original message was deleted');
      expect(text).toContain('] * ');
      expect(text).toContain('joined the server.');
      expect(text).toContain('(edited)');
      expect(text).toContain('[BOT]');
      expect(text).toContain('Channel: General / #showcase\n');
      expect(text).toContain(`Messages: ${messages.length}\n`);
      // custom emoji and mentions come out as text
      expect(text).toContain(':pepe_happy:');
      expect(text).toContain('@Sam Patel');
      expect(text).toContain('#empty-channel');
      expect(text).not.toContain('<:');
      // inside a code block the mention syntax is text and stays untouched
      expect(text).toContain('<@123>');
    });

    it('is localised in Korean', async () => {
      const { messages, names } = await showcase();
      const text = render([messages], context({ names, target, options: { locale: 'ko' } }));
      for (const marker of ['{첨부 파일}', '{임베드}', '{스티커}', '{투표}', '{전달된 메시지}', '{리액션}']) expect(text).toContain(`\n${marker}\n`);
      expect(text).toContain('님에게 답장:');
      expect(text).toContain('님이 서버에 참여했어요.');
      expect(text).toContain('(수정됨)');
      expect(text).toContain('서버: Dev Lounge\n');
    });

    it('contains only LF line endings and no control characters', async () => {
      const { messages, names } = await showcase();
      const text = render([messages], context({ names }));
      expect(text).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
      expect(text.endsWith('\n')).toBe(true);
    });

    it('writes 20,000 messages in time proportional to their number', async () => {
      const { messages, names } = await showcase();
      const inflated = inflateMessages(messages, 20_000);
      const size = expectLinearScaling(
        (count) => {
          const writer = txtFormat.createWriter(context({ names }));
          let bytes = writer.start().join('').length;
          for (let i = 0; i < count; i += 100) bytes += writer.write(inflated.slice(i, Math.min(count, i + 100))).join('').length;
          bytes += writer.end({ messageCount: count, firstTimestamp: null, lastTimestamp: null }).reduce((sum, chunk) => sum + chunk.length, 0);
          return bytes;
        },
        { small: 2_000, large: 20_000 },
      );
      expect(size).toBeGreaterThan(20_000 * 40);
    });
  });
});

describe('text helpers', () => {
  describe('shieldLine', () => {
    it('escapes lines that look like structure, also when indented', () => {
      expect(shieldLine('[2026-10-05 12:00:00] Admin')).toBe('\\[2026-10-05 12:00:00] Admin');
      expect(shieldLine('  [2026-10-05 12:00] x')).toBe('\\  [2026-10-05 12:00] x');
      expect(shieldLine('{Embed}')).toBe('\\{Embed}');
      expect(shieldLine('{임베드}  ')).toBe('\\{임베드}  ');
      expect(shieldLine('> ↪ Replying to x: y')).toBe('\\> ↪ Replying to x: y');
      expect(shieldLine('↪ x')).toBe('\\↪ x');
      expect(shieldLine('=== x')).toBe('\\=== x');
    });

    it('leaves ordinary lines alone', () => {
      for (const line of ['', 'hello', '[1/2] done', '[2026-10-05] no time', '{x}', '{"a":1}', '> quote', '== two', '- item', '1. item', '    code']) {
        expect(shieldLine(line)).toBe(line);
      }
    });
  });

  describe('cleanText / oneLine / truncate', () => {
    it('cleans multi-line text', () => {
      expect(cleanText('a\r\nb\rc\u0007d')).toBe('a\nb\ncd');
      expect(cleanText('plain 안녕 👋')).toBe('plain 안녕 👋');
      expect(cleanText(undefined)).toBe('');
      expect(cleanText(42)).toBe('');
    });

    it('collapses text to one line', () => {
      expect(oneLine('  a \n\t b  \r\n c ')).toBe('a b c');
      expect(oneLine(null)).toBe('');
    });

    it('truncates without splitting surrogate pairs', () => {
      expect(truncate('abcdef', 10)).toBe('abcdef');
      expect(truncate('abcdef', 4)).toBe('abc…');
      expect(truncate('ab😀cd', 4)).toBe('ab…');
    });
  });

  it('knows both languages and falls back to English', () => {
    expect(getExportStrings('ko').edited).toBe('수정됨');
    expect(getExportStrings('en').edited).toBe('edited');
    expect(getExportStrings('fr').edited).toBe('edited');
  });

  it('resolves time zones', () => {
    expect(resolveTimeZone('Asia/Seoul')).toBe('Asia/Seoul');
    expect(resolveTimeZone('Nope/Zone')).toBe('UTC');
    expect(resolveTimeZone('')).toBe('UTC');
  });
});
