import { describe, expect, it } from 'vitest';
import { createMockClient, MOCK_IDS } from '../../../../src/lib/discord/mock';
import type { Message, User } from '../../../../src/lib/discord/types';
import { createRowBuilder, ROW_COLUMNS, rowHeaders } from '../../../../src/lib/export/formats/rows';
import type { WriterOptions, ExportTarget, WriterContext } from '../../../../src/lib/export/types';
import { buildNameResolver } from '../../../../src/lib/message';

const ALICE: User = { id: '1000', username: 'alice', global_name: 'Alice' };
const BOB: User = { id: '2000', username: 'bob' };
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
  topic: null,
};
const NO_NAMES = { user: () => undefined, channel: () => undefined, role: () => undefined };

function context(overrides: { options?: Partial<WriterOptions>; names?: WriterContext['names'] } = {}): WriterContext {
  return {
    target: TARGET,
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
    timestamp: `2026-10-05T12:00:${String(n).padStart(2, '0')}.000000+00:00`,
    edited_timestamp: null,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    type: 0,
    ...extra,
  };
}

const row = (m: Message, ctx: WriterContext = context()): string[] => createRowBuilder(ctx)(m);

const CELL = Object.fromEntries(ROW_COLUMNS.map((column, index) => [column.key, index])) as Record<(typeof ROW_COLUMNS)[number]['key'], number>;

describe('columns', () => {
  it('has the documented columns in order', () => {
    expect(ROW_COLUMNS.map((c) => c.key)).toEqual([
      'messageId',
      'timestamp',
      'edited',
      'authorId',
      'author',
      'bot',
      'content',
      'attachments',
      'embeds',
      'stickers',
      'reactions',
      'replyTo',
      'type',
    ]);
  });

  it('sizes the columns for a spreadsheet, wrapping the long text ones', () => {
    const byKey = Object.fromEntries(ROW_COLUMNS.map((c) => [c.key, c]));
    expect(byKey.messageId.width).toBe(22);
    expect(byKey.timestamp.width).toBe(20);
    expect(byKey.author.width).toBe(20);
    expect(byKey.content).toMatchObject({ width: 80, wrap: true });
    expect(byKey.attachments).toMatchObject({ width: 50, wrap: true });
    expect(byKey.messageId.wrap).toBe(false);
  });

  it('localises the header row', () => {
    expect(rowHeaders('en')).toEqual([
      'Message ID',
      'Timestamp',
      'Edited',
      'Author ID',
      'Author',
      'Bot',
      'Content',
      'Attachments',
      'Embeds',
      'Stickers',
      'Reactions',
      'Reply To',
      'Type',
    ]);
    expect(rowHeaders('ko')).toEqual([
      '메시지 ID',
      '시각',
      '수정 시각',
      '작성자 ID',
      '작성자',
      '봇',
      '내용',
      '첨부 파일',
      '임베드',
      '스티커',
      '리액션',
      '답장 대상',
      '유형',
    ]);
  });
});

describe('hand-written fixture', () => {
  const original = message(1, 'hello');
  const reply = message(2, 'hi **Alice**', {
    author: BOB,
    type: 19,
    edited_timestamp: '2026-10-05T12:05:00.000000+00:00',
    message_reference: { message_id: original.id, channel_id: '555' },
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

  it('builds the exact cells', () => {
    const build = createRowBuilder(context());
    expect(build(original)).toEqual(['100000000000000001', '2026-10-05 12:00:01', '', '1000', 'Alice', '', 'hello', '', '', '', '', '', 'message']);
    expect(build(reply)).toEqual([
      '100000000000000002',
      '2026-10-05 12:00:02',
      '2026-10-05 12:05:00',
      '2000',
      'bob',
      '',
      'hi Alice',
      '',
      '',
      '',
      '👍 3; :party: 2',
      '100000000000000001',
      'reply',
    ]);
    expect(build(files)).toEqual([
      '100000000000000003',
      '2026-10-05 12:00:03',
      '',
      '1000',
      'Alice',
      '',
      '',
      'https://cdn.discordapp.com/attachments/1/2/report.pdf\nhttps://cdn.discordapp.com/attachments/1/3/photo.png',
      '',
      '',
      '',
      '',
      'message',
    ]);
    expect(build(join)).toEqual(['100000000000000004', '2026-10-05 12:00:04', '', '4000', 'helper', 'Y', 'helper joined the server.', '', '', '', '', '', 'system']);
  });

  it('produces one cell per column', () => {
    for (const m of [original, reply, files, join]) expect(row(m)).toHaveLength(ROW_COLUMNS.length);
  });
});

describe('cells', () => {
  it('keeps snowflakes exact as strings (they exceed 2^53)', () => {
    const m = message(1, 'x', { id: '1234567890123456789', author: { ...ALICE, id: '9007199254740993' } });
    const cells = row(m);
    expect(cells[CELL.messageId]).toBe('1234567890123456789');
    expect(cells[CELL.authorId]).toBe('9007199254740993');
  });

  it('prints timestamps in the requested time zone', () => {
    const m = message(1, 'x', { timestamp: '2026-10-05T23:30:00.000000+00:00', edited_timestamp: '2026-10-06T00:15:30.000000+00:00' });
    expect(row(m, context({ options: { timeZone: 'Asia/Seoul' } })).slice(1, 3)).toEqual(['2026-10-06 08:30:00', '2026-10-06 09:15:30']);
    expect(row(m, context({ options: { timeZone: 'America/New_York' } })).slice(1, 3)).toEqual(['2026-10-05 19:30:00', '2026-10-05 20:15:30']);
  });

  it('falls back to UTC for an unknown time zone and shows an unparsable timestamp as sent', () => {
    expect(row(message(1, 'x'), context({ options: { timeZone: 'Not/AZone' } }))[CELL.timestamp]).toBe('2026-10-05 12:00:01');
    expect(row(message(1, 'x', { timestamp: 'garbage' }))[CELL.timestamp]).toBe('garbage');
  });

  it('marks bots and webhooks', () => {
    expect(row(message(1, 'x', { author: BOT }))[CELL.bot]).toBe('Y');
    expect(row(message(1, 'x', { webhook_id: '999' }))[CELL.bot]).toBe('Y');
    expect(row(message(1, 'x'))[CELL.bot]).toBe('');
  });

  it('falls back to the user name, and to a placeholder when the author is missing', () => {
    expect(row(message(1, 'x', { author: BOB }))[CELL.author]).toBe('bob');
    const orphan = message(1, 'x');
    delete (orphan as Partial<Message>).author;
    expect(row(orphan)[CELL.author]).toBe('Unknown user');
    expect(row(orphan, context({ options: { locale: 'ko' } }))[CELL.author]).toBe('알 수 없는 사용자');
    expect(row(orphan)[CELL.authorId]).toBe('');
  });

  it('resolves mentions, channels and roles through the name resolver and falls back when unknown', () => {
    const names = buildNameResolver({ users: { '2000': 'Bob' }, channels: { '5': 'general' }, roles: { '9': 'Mods' } });
    const m = message(1, 'hey <@2000> in <#5> for <@&9> and <@999> <#6> <@&10>');
    expect(row(m, context({ names }))[CELL.content]).toBe('hey @Bob in #general for @Mods and @Unknown User #unknown-channel @deleted-role');
    expect(row(m, context({ names, options: { locale: 'ko' } }))[CELL.content]).toBe('hey @Bob in #general for @Mods and @알 수 없는 사용자 #알 수 없는 채널 @삭제된-역할');
  });

  it('writes content as plain text: markdown removed, spoilers visible, custom emoji as :name:', () => {
    const m = message(1, '**bold** *it* ||secret|| <:wave:123> `code` [t](https://a.com/x)');
    expect(row(m)[CELL.content]).toBe('bold it ||secret|| :wave: `code` t (https://a.com/x)');
  });

  it('keeps Korean text, emoji and line breaks', () => {
    const m = message(1, '안녕하세요 👋\n두 번째 줄\n\n세 번째 🇰🇷');
    expect(row(m)[CELL.content]).toBe('안녕하세요 👋\n두 번째 줄\n\n세 번째 🇰🇷');
  });

  it('formats <t:..> timestamps in the export time zone', () => {
    const unix = Date.UTC(2026, 9, 5, 12, 0, 0) / 1000;
    const m = message(1, `at <t:${unix}:F>`);
    expect(row(m, context({ options: { timeZone: 'UTC' } }))[CELL.content]).toBe('at Monday, October 5, 2026 12:00 PM');
    expect(row(m, context({ options: { timeZone: 'Asia/Seoul' } }))[CELL.content]).toBe('at Monday, October 5, 2026 9:00 PM');
  });

  it('strips control characters and bidi overrides and normalises line breaks', () => {
    const rlo = String.fromCharCode(0x202e);
    const m = message(1, `a\u0007b${rlo}c\r\nd\re${String.fromCharCode(0x2028)}f`);
    const content = row(m)[CELL.content];
    expect(content).toBe('abc\nd\ne\nf');
  });

  it('exposes the reply target and type', () => {
    const original = message(1, 'hello');
    const reply = message(2, 'x', { type: 19, message_reference: { message_id: original.id }, referenced_message: original });
    expect(row(reply).slice(CELL.replyTo)).toEqual([original.id, 'reply']);
    const deleted = message(3, 'x', { type: 19, message_reference: { message_id: '42' }, referenced_message: null });
    expect(row(deleted).slice(CELL.replyTo)).toEqual(['42', 'reply']);
  });

  it('classifies forwards, system messages and other kinds', () => {
    const forward = message(1, '', {
      message_reference: { type: 1, message_id: '5', channel_id: '6' },
      message_snapshots: [
        {
          message: {
            content: 'original **text**',
            timestamp: '2026-10-01T00:00:00.000000+00:00',
            attachments: [{ id: '1', filename: 'a.zip', size: 1, url: 'https://cdn.discordapp.com/attachments/1/1/a.zip' }],
            embeds: [{ title: 'Forwarded embed', url: 'https://example.com/e' }],
          },
        },
      ],
    });
    const cells = row(forward);
    expect(cells[CELL.type]).toBe('forward');
    expect(cells[CELL.replyTo]).toBe('');
    expect(cells[CELL.content]).toBe('[forwarded message]\noriginal text');
    expect(cells[CELL.attachments]).toBe('https://cdn.discordapp.com/attachments/1/1/a.zip');
    expect(cells[CELL.embeds]).toBe('Forwarded embed | https://example.com/e');

    expect(row(message(1, 'x', { type: 20 }))[CELL.type]).toBe('type-20');
    expect(row(message(1, '', { type: 6 }))[CELL.type]).toBe('system');
    expect(row(message(1, '', { type: 6 }))[CELL.content]).toBe('Alice pinned a message to this channel.');
    expect(row(message(1, '', { type: 6 }), context({ options: { locale: 'ko' } }))[CELL.content]).toBe('Alice님이 이 채널에 메시지를 고정했어요.');
    expect(row(message(1, '', { type: 999 }))[CELL.content]).toBe('[System message (type 999)]');
  });

  it('lists attachment URLs one per line and uses the name when the URL is not http(s)', () => {
    const m = message(1, '', {
      attachments: [
        { id: '1', filename: 'a.png', size: 1, url: 'https://cdn.discordapp.com/attachments/1/1/a.png?ex=1&hm=2' },
        { id: '2', filename: 'inline.png', size: 1, url: 'data:image/png;base64,AAAA' },
        { id: '3', filename: 'evil.png', size: 1, url: 'javascript:alert(1)' },
      ],
    });
    expect(row(m)[CELL.attachments]).toBe('https://cdn.discordapp.com/attachments/1/1/a.png?ex=1&hm=2\ninline.png\nevil.png');
  });

  it('summarises embeds on one line each', () => {
    const m = message(1, '', {
      embeds: [
        {
          type: 'rich',
          title: 'Maintenance',
          url: 'https://example.com/status',
          description: 'Tonight **02:00**\nsome [details](https://example.com/d)',
          author: { name: 'Status Page' },
          fields: [
            { name: 'Affected', value: 'API\nWeb' },
            { name: 'Owner', value: 'Infra' },
          ],
          footer: { text: 'Status Bot' },
        },
        { type: 'image', url: 'https://example.com/cat.png' },
        {},
      ],
    });
    expect(row(m)[CELL.embeds]).toBe(
      [
        'Status Page | Maintenance | Tonight 02:00 some details (https://example.com/d) | Affected: API Web | Owner: Infra | Status Bot | https://example.com/status',
        'https://example.com/cat.png',
        '[embed]',
      ].join('\n'),
    );
  });

  it('truncates very long embed descriptions in the summary', () => {
    const m = message(1, '', { embeds: [{ title: 't', description: 'x'.repeat(5000) }] });
    const summary = row(m)[CELL.embeds];
    expect(summary.length).toBeLessThan(400);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('lists stickers and reactions', () => {
    const m = message(1, '', {
      sticker_items: [
        { id: '1', name: 'wave', format_type: 1 },
        { id: '2', name: '웃는 고양이', format_type: 3 },
      ],
      reactions: [
        { count: 12, emoji: { id: null, name: '🔥' } },
        { count: 1, emoji: { id: '77', name: 'pepe_happy' } },
      ],
    });
    const cells = row(m);
    expect(cells[CELL.stickers]).toBe('wave; 웃는 고양이');
    expect(cells[CELL.reactions]).toBe('🔥 12; :pepe_happy: 1');
  });

  it('appends polls to the content, in both languages', () => {
    const m = message(1, '', {
      poll: {
        question: { text: 'Lunch?' },
        answers: [
          { answer_id: 1, poll_media: { text: 'Ramen', emoji: { id: null, name: '🍜' } } },
          { answer_id: 2, poll_media: { text: 'Pizza' } },
        ],
        allow_multiselect: true,
        results: { is_finalized: true, answer_counts: [{ id: 1, count: 3 }] },
      },
    });
    expect(row(m)[CELL.content]).toBe('[poll] Lunch?\n1. 🍜 Ramen: 3 votes\n2. Pizza: 0 votes\nMultiple choice · Ended · 3 votes in total');
    expect(row(m, context({ options: { locale: 'ko' } }))[CELL.content]).toBe('[투표] Lunch?\n1. 🍜 Ramen: 3표\n2. Pizza: 0표\n복수 선택 · 종료됨 · 총 3표');
  });

  it('does not throw on garbage fields', () => {
    const garbage = {
      id: 5,
      author: { id: 7, username: 3 },
      content: 42,
      timestamp: null,
      attachments: 'nope',
      embeds: [null, 3],
      reactions: [null],
      sticker_items: [null],
      mentions: null,
      type: 'x',
    } as unknown as Message;
    const cells = row(garbage);
    expect(cells).toHaveLength(ROW_COLUMNS.length);
    expect(cells.every((cell) => typeof cell === 'string')).toBe(true);
  });
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
    return { messages, names };
  }

  it('turns every message into a full row of clean text', async () => {
    const { messages, names } = await showcase();
    const build = createRowBuilder(context({ names }));
    const control = new RegExp(String.raw`[\x00-\x08\x0B-\x1F\x7F-\x9F]|\r`);
    const types = new Set<string>();
    for (const m of messages) {
      const cells = build(m);
      expect(cells).toHaveLength(ROW_COLUMNS.length);
      expect(cells[CELL.messageId]).toBe(m.id);
      expect(cells[CELL.timestamp]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      for (const cell of cells) expect(control.test(cell)).toBe(false);
      types.add(cells[CELL.type]);
    }
    expect(types).toEqual(new Set(['message', 'reply', 'forward', 'system', 'type-20']));
  });

  it('never leaves a message without any visible information', async () => {
    const { messages, names } = await showcase();
    const build = createRowBuilder(context({ names }));
    for (const m of messages) {
      const cells = build(m);
      const informative = [CELL.content, CELL.attachments, CELL.embeds, CELL.stickers].some((i) => cells[i] !== '');
      expect(informative, `message ${m.id}`).toBe(true);
    }
  });
});
