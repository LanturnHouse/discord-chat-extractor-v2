import { describe, expect, it } from 'vitest';
import { emojiUrl } from '../../../../src/lib/discord/cdn';
import { createMockClient, MOCK_IDS } from '../../../../src/lib/discord/mock';
import type { Message, User } from '../../../../src/lib/discord/types';
import { exportMock, textOf } from '../exportKit';
import { mdFormat } from '../../../../src/lib/export/formats/md';
import {
  escapeInline,
  escapeText,
  markdownText,
  mdAutolink,
  mdCodeBlock,
  mdDestination,
  mdInlineCode,
  mdLink,
  quoteLines,
} from '../../../../src/lib/export/formats/mdRender';
import type { Chunk, WriterOptions, ExportTarget, WriterContext, WriterSummary } from '../../../../src/lib/export/types';
import { linkHostNote, misleadingLinkHost } from '../../../../src/lib/markdown/linkHost';
import type { MarkdownContext } from '../../../../src/lib/markdown/types';
import { buildNameResolver } from '../../../../src/lib/message';
import { expectLinearScaling, inflateMessages } from '../scaling';

const NBSP = String.fromCharCode(0xa0);
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
  const writer = mdFormat.createWriter(ctx);
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

const NAMES = buildNameResolver({ users: { '2000': 'Bob' }, channels: { '5': 'general' }, roles: { '9': 'Mods' } });
const MD_CTX: MarkdownContext = { names: NAMES, locale: 'en', timeZone: 'UTC' };
const md = (content: string): string => markdownText(content, MD_CTX);

/** A list marker followed by another block construct: CommonMark renders "- # x" as a heading inside the item. */
const LIST_ITEM_STARTING_A_BLOCK = /^(?:>\s?)*\s*(?:[-+*]|\d+[.)])\s+(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s)/;

/** Removes fenced code blocks and inline code spans: what is left is what a viewer interprets as markdown. */
function withoutCode(text: string): string {
  const kept: string[] = [];
  let fence = 0;
  for (const line of text.split('\n')) {
    const content = line.replace(/^(?:>\s?)+/, '');
    if (fence > 0) {
      if (new RegExp(`^\`{${fence},}\\s*$`).test(content)) fence = 0;
      continue;
    }
    // The info string of a backtick fence cannot contain backticks; "```a``b```" is an inline code span.
    const open = /^(`{3,})[^`]*$/.exec(content);
    if (open) {
      fence = open[1].length;
      continue;
    }
    kept.push(withoutCodeSpans(line));
  }
  // `<scheme:...>` autolinks are inert whatever they contain, except the angle-bracket form of a link destination.
  const joined = kept.join('\n');
  return joined.replace(/<https?:\/\/[^<>\s]*>/g, (match, offset: number) => {
    const escapedAngle = unescaped(joined, '<').includes(offset) === false;
    const destination = joined.slice(offset - 2, offset) === '](' && unescaped(joined, ']').includes(offset - 2);
    return escapedAngle || destination ? match : 'U';
  });
}

function withoutCodeSpans(line: string): string {
  let out = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      out += ch + line[i + 1];
      i += 1;
    } else if (ch !== '`') {
      out += ch;
    } else {
      let run = 1;
      while (line[i + run] === '`') run += 1;
      const close = line.indexOf('`'.repeat(run), i + run);
      if (close === -1) {
        out += '`'.repeat(run);
        i += run - 1;
      } else {
        // A placeholder keeps the line's structure: "```a```---" must not turn into a line of dashes.
        out += 'C';
        i = close + run - 1;
      }
    }
  }
  return out;
}

/** Indices of `char` that are not escaped (not preceded by an odd number of backslashes). */
function unescaped(text: string, char: string): number[] {
  const found: number[] = [];
  for (let i = text.indexOf(char); i !== -1; i = text.indexOf(char, i + 1)) {
    let backslashes = 0;
    while (i - backslashes - 1 >= 0 && text[i - backslashes - 1] === '\\') backslashes += 1;
    if (backslashes % 2 === 0) found.push(i);
  }
  return found;
}

/** `<` that a viewer could read as HTML: not escaped, and neither our own <sub> tags nor an http(s) autolink. */
function rawHtml(text: string): string[] {
  const visible = withoutCode(text);
  return unescaped(visible, '<')
    .map((i) => visible.slice(i, i + 24))
    .filter((s) => !/^<\/?sub>/.test(s) && !/^<https?:\/\//.test(s));
}

/** Destinations of `![alt](url)` images (an image is fetched by the viewer as soon as the file is opened). */
function imageDestinations(text: string): string[] {
  const visible = withoutCode(text);
  const found: string[] = [];
  for (const bang of unescaped(visible, '!')) {
    if (visible[bang + 1] !== '[') continue;
    const close = unescaped(visible.slice(bang), ']').find((i) => visible[bang + i + 1] === '(');
    if (close !== undefined) found.push(visible.slice(bang + close + 1, bang + close + 60));
  }
  return found;
}

/** Link or image destinations that are not http(s). */
function unsafeDestinations(text: string): string[] {
  const visible = withoutCode(text);
  return unescaped(visible, ']')
    .filter((i) => visible[i + 1] === '(')
    .map((i) => visible.slice(i + 1, i + 40))
    .filter((s) => !/^\(<?https?:\/\//.test(s));
}

describe('mdFormat', () => {
  it('describes itself', () => {
    expect(mdFormat.id).toBe('md');
    expect(mdFormat.label).toBe('Markdown (.md)');
    expect(mdFormat.extension).toBe('md');
    expect(mdFormat.mime).toBe('text/markdown;charset=utf-8');
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

    it('writes the documented document', () => {
      expect(render([[original, reply, files, join, code]], context({ names: NAMES }))).toBe(
        [
          '# My Server - #general',
          '',
          '- **Server:** My Server',
          '- **Channel:** Text Channels / #general',
          '- **Topic:** Welcome!',
          '- **Range:** all messages',
          '- **Exported:** 2026-10-06 12:34:56 (UTC)',
          '- **Generator:** Discord Chat Extractor',
          '',
          '---',
          '',
          '## 2026-10-05',
          '',
          '**Alice** <sub>12:00:01</sub>',
          '',
          'hello',
          '',
          '**Bob** <sub>12:00:02 (edited)</sub>',
          '',
          '> ↪ Replying to **Alice**: hello',
          '',
          'hi **Alice**',
          '',
          '👍 3 · ![:party:](https://cdn.discordapp.com/emojis/123456789012345678.png?size=32) 2',
          '',
          '**Alice** <sub>12:00:03</sub>',
          '',
          '[report.pdf](https://cdn.discordapp.com/attachments/1/2/report.pdf) (2 KB)',
          '',
          '![photo.png](https://cdn.discordapp.com/attachments/1/3/photo.png)',
          '',
          '<sub>12:00:04</sub> *helper joined the server.*',
          '',
          '**Alice** <sub>12:00:05</sub>',
          '',
          'see **@Bob**:',
          '',
          '```js',
          'let a = 1;',
          '```',
          '',
          '---',
          '',
          '- **Messages:** 5',
          '- **First message:** 2026-10-05 12:00:01',
          '- **Last message:** 2026-10-05 12:00:05',
          '',
        ].join('\n'),
      );
    });

    it('describes the requested range, including a message count, in both languages', () => {
      const range = (options: Partial<WriterOptions>): string => render([[]], context({ options })).split('\n').find((line) => /^- \*\*(Range|범위):/.test(line)) ?? '';
      expect(range({})).toBe('- **Range:** all messages');
      expect(range({ limit: 200 })).toBe('- **Range:** newest 200 messages');
      expect(range({ after: '2026-01-01T00:00:00.000Z', limit: 500 })).toBe('- **Range:** from 2026-01-01 00:00:00: newest 500 messages');
      expect(range({ before: '2026-03-01T00:00:00.000Z', limit: 200 })).toBe('- **Range:** until 2026-03-01 00:00:00: newest 200 messages');
      expect(range({ after: '2026-01-01T00:00:00.000Z', before: '2026-03-01T00:00:00.000Z', timeZone: 'Asia/Seoul' })).toBe(
        '- **Range:** 2026-01-01 09:00:00 to 2026-03-01 09:00:00',
      );
      expect(range({ locale: 'ko', limit: 200 })).toBe('- **범위:** 최근 200개 메시지');
      expect(range({ locale: 'ko', after: '2026-01-01T00:00:00.000Z', before: '2026-03-01T00:00:00.000Z', limit: 500 })).toBe(
        '- **범위:** 2026-01-01 00:00:00 ~ 2026-03-01 00:00:00 최근 500개',
      );
    });

    it('writes the fixed words in Korean', () => {
      const text = render([[original, reply, join]], context({ options: { locale: 'ko' } }));
      expect(text.split('\n').slice(0, 9)).toEqual([
        '# My Server - #general',
        '',
        '- **서버:** My Server',
        '- **채널:** Text Channels / #general',
        '- **주제:** Welcome!',
        '- **범위:** 전체 메시지',
        '- **내보낸 시각:** 2026-10-06 12:34:56 (UTC)',
        '- **생성 도구:** Discord Chat Extractor',
        '',
      ]);
      expect(text).toContain('**Bob** <sub>12:00:02 (수정됨)</sub>');
      expect(text).toContain('> ↪ **Alice**님에게 답장: hello');
      expect(text).toContain('<sub>12:00:04</sub> *helper님이 서버에 참여했어요.*');
      expect(text).toContain('- **메시지 수:** 3\n- **첫 메시지:** 2026-10-05 12:00:01\n- **마지막 메시지:** 2026-10-05 12:00:04\n');
    });
  });

  describe('document structure', () => {
    it('is valid for an empty channel: title, metadata, a zero count and one rule', () => {
      const text = render([[], []], context(), { messageCount: 0, firstTimestamp: null, lastTimestamp: null });
      expect(text).toBe(
        [
          '# My Server - #general',
          '',
          '- **Server:** My Server',
          '- **Channel:** Text Channels / #general',
          '- **Topic:** Welcome!',
          '- **Range:** all messages',
          '- **Exported:** 2026-10-06 12:34:56 (UTC)',
          '- **Generator:** Discord Chat Extractor',
          '',
          '---',
          '',
          '- **Messages:** 0',
          '',
        ].join('\n'),
      );
    });

    it('titles DMs and threads without a server', () => {
      const dm = render([[]], context({ target: { kind: 'dm', channelName: '김민준', guildId: null, guildName: null, categoryName: null, topic: null } }));
      expect(dm.startsWith('# 김민준\n\n- **Channel:** 김민준\n- **Range:**')).toBe(true);
      const thread = render([[]], context({ target: { kind: 'thread', channelName: 'lunch poll', parentChannelName: 'general' } }));
      expect(thread).toContain('# My Server - #general / lunch poll\n');
      expect(thread).toContain('- **Channel:** Text Channels / #general / lunch poll\n');
    });

    it('writes one day heading per day, also across batches', () => {
      const day = (d: number, s: number): Message => message(s, `m${d}-${s}`, { timestamp: `2026-10-0${d}T10:00:${String(s).padStart(2, '0')}.000000+00:00` });
      const text = render([[day(5, 1), day(5, 2)], [day(5, 3), day(6, 4)], [day(6, 5)], [day(8, 6)]]);
      expect(text.split('\n').filter((l) => l.startsWith('## '))).toEqual(['## 2026-10-05', '## 2026-10-06', '## 2026-10-08']);
      expect(text.indexOf('## 2026-10-06')).toBeGreaterThan(text.indexOf('m5-3'));
      expect(text.indexOf('## 2026-10-06')).toBeLessThan(text.indexOf('m6-4'));
    });

    it('draws the day boundaries in the export time zone', () => {
      const late = message(1, 'late', { timestamp: '2026-10-05T23:30:00.000000+00:00' });
      const early = message(2, 'early', { timestamp: '2026-10-06T00:30:00.000000+00:00' });
      const headings = (timeZone: string) => render([[late, early]], context({ options: { timeZone } })).split('\n').filter((l) => l.startsWith('## '));
      expect(headings('UTC')).toEqual(['## 2026-10-05', '## 2026-10-06']);
      expect(headings('Asia/Seoul')).toEqual(['## 2026-10-06']);
      expect(render([[late]], context({ options: { timeZone: 'Asia/Seoul' } }))).toContain('**Alice** <sub>08:30:00</sub>');
    });

    it('writes identical output for one batch and for seven batches', () => {
      const messages = Array.from({ length: 60 }, (_, i) =>
        message(i + 1, i % 5 === 0 ? `multi\nline **${i}** 안녕` : `message ${i}`, {
          author: i % 2 === 0 ? ALICE : BOB,
          timestamp: `2026-10-0${1 + Math.floor(i / 12)}T10:00:${String(i % 60).padStart(2, '0')}.000000+00:00`,
          reactions: i % 7 === 0 ? [{ count: i, emoji: { id: null, name: '👍' } }] : undefined,
        }),
      );
      const sevenBatches = [messages.slice(0, 5), messages.slice(5, 9), messages.slice(9, 10), messages.slice(10, 30), [], messages.slice(30, 45), messages.slice(45)];
      expect(render(sevenBatches)).toBe(render([messages]));
    });

    it('emits only string chunks and creates independent writers', () => {
      const a = mdFormat.createWriter(context());
      const b = mdFormat.createWriter(context());
      const chunks = [...a.start(), ...a.write([message(1, 'x')]), ...a.end({ messageCount: 1, firstTimestamp: null, lastTimestamp: null })];
      expect(chunks.every((c) => typeof c === 'string')).toBe(true);
      expect(asText(b.write([message(1, 'y')]))).toContain('## 2026-10-05');
    });
  });

  describe('author line', () => {
    it('marks bots and webhooks', () => {
      const text = render([[message(1, 'x', { author: BOT }), message(2, 'y', { webhook_id: '5' })]]);
      expect(text).toContain('**helper** `BOT` <sub>12:00:01</sub>');
      expect(text).toContain('**Alice** `BOT` <sub>12:00:02</sub>');
    });

    it('escapes names that are markdown or HTML', () => {
      const evil: User = { id: '66', username: 'evil', global_name: '**<img src=x onerror=alert(1)>** [x](https://evil.example) # `x`' };
      const text = render([[message(1, 'x', { author: evil })]]);
      expect(text).toContain('**\\*\\*\\<img src=x onerror=alert(1)>\\*\\* \\[x\\](https://evil.example) # \\`x\\`** <sub>12:00:01</sub>');
      expect(rawHtml(text)).toEqual([]);
    });

    it('keeps a name that contains line breaks on one line', () => {
      const evil: User = { id: '66', username: 'evil', global_name: 'Eve\n\n## 2026-01-01\n---' };
      const text = render([[message(1, 'x', { author: evil })]]);
      expect(text).toContain('**Eve ## 2026-01-01 ---** <sub>');
      expect(text.split('\n').filter((l) => l.startsWith('## '))).toEqual(['## 2026-10-05']);
    });

    it('shows replies, also for deleted and unavailable originals', () => {
      const original = message(1, 'the **original** message');
      const text = render([
        [
          original,
          message(2, 'a', { type: 19, message_reference: { message_id: original.id }, referenced_message: original }),
          message(3, 'b', { type: 19, message_reference: { message_id: '404' }, referenced_message: null }),
          message(4, 'c', { type: 19, message_reference: { message_id: '404' } }),
        ],
      ]);
      expect(text).toContain('> ↪ Replying to **Alice**: the original message\n\na\n');
      expect(text).toContain('> ↪ *Original message was deleted*\n\nb\n');
      expect(text).toContain('> ↪ *Original message is unavailable*\n\nc\n');
    });

    it('does not let a reply preview or name inject anything', () => {
      const original = message(1, '<script>alert(1)</script> [x](javascript:alert(1)) **b**', { author: { id: '7', username: 'x', global_name: '<b>x</b>' } });
      const text = render([[original, message(2, 'a', { type: 19, message_reference: { message_id: original.id }, referenced_message: original })]]);
      expect(rawHtml(text)).toEqual([]);
      expect(unsafeDestinations(text)).toEqual([]);
    });
  });

  describe('message content', () => {
    it('keeps Korean, emoji and zero-width joiners', () => {
      const body = '안녕하세요 👋 🇰🇷 👨‍👩‍👧‍👦 こんにちは';
      expect(render([[message(1, body)]])).toContain(`\n\n${body}\n\n`);
    });

    it('writes system messages as one italic line with the time', () => {
      const text = render([[message(1, '', { type: 7 }), message(2, '', { type: 4, content: '*new* <b>name' })]]);
      expect(text).toContain('<sub>12:00:01</sub> *Alice joined the server.*\n');
      expect(text).toContain('<sub>12:00:02</sub> *Alice changed the channel name: \\*new\\* \\<b>name*\n');
    });

    it('renders a message with nothing in it as just its author line', () => {
      expect(render([[message(1, '')]])).toContain('**Alice** <sub>12:00:01</sub>\n\n---\n');
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

  describe('attachments', () => {
    const att = (over: Record<string, unknown>) => ({ id: '1', filename: 'a.png', size: 1536, url: 'https://cdn.discordapp.com/attachments/1/1/a.png?ex=1&hm=2', ...over });

    it('shows images from Discord inline and everything else as a link with its size', () => {
      const m = message(1, '', {
        attachments: [
          att({}),
          att({ filename: 'doc.pdf', url: 'https://cdn.discordapp.com/attachments/1/1/doc.pdf', content_type: 'application/pdf' }),
          att({ filename: 'photo.jpg', url: 'https://example.com/photo.jpg', content_type: 'image/jpeg' }),
          att({ filename: 'SPOILER_secret.png', url: 'https://cdn.discordapp.com/attachments/1/1/SPOILER_secret.png' }),
          att({ filename: 'alt.png', description: 'A [cat]', url: 'https://media.discordapp.net/attachments/1/1/alt.png' }),
        ],
      });
      const text = render([[m]]);
      expect(text).toContain('\n![a.png](https://cdn.discordapp.com/attachments/1/1/a.png?ex=1&hm=2)\n');
      expect(text).toContain('\n[doc.pdf](https://cdn.discordapp.com/attachments/1/1/doc.pdf) (1.5 KB)\n');
      expect(text).toContain('\n[photo.jpg](https://example.com/photo.jpg) (1.5 KB)\n');
      expect(text).toContain('\n[SPOILER_secret.png](https://cdn.discordapp.com/attachments/1/1/SPOILER_secret.png) (1.5 KB)\n');
      expect(text).toContain('\n![A \\[cat\\]](https://media.discordapp.net/attachments/1/1/alt.png)\n');
    });

    it('never links data:, javascript: or other non-http(s) URLs', () => {
      const m = message(1, '', {
        attachments: [att({ url: 'data:image/png;base64,AAAA' }), att({ filename: 'x.png', url: 'javascript:alert(1)' }), att({ filename: 'y.png', url: 'file:///etc/passwd' })],
      });
      const text = render([[m]]);
      expect(unsafeDestinations(text)).toEqual([]);
      expect(text).not.toContain('javascript:');
      expect(text).not.toContain('data:');
      expect(text).not.toContain('file:');
      expect(text).toContain('\na.png (1.5 KB)\n');
    });

    it('escapes hostile file names and URLs with parentheses or spaces', () => {
      const m = message(1, '', {
        attachments: [
          att({ filename: 'a](https://evil.example) <script>.pdf', url: 'https://cdn.discordapp.com/attachments/1/1/x.pdf' }),
          att({ filename: 'b.pdf', url: 'https://cdn.discordapp.com/attachments/1/1/file (1).pdf' }),
          att({ filename: '`code`*bold*.zip', url: 'https://cdn.discordapp.com/attachments/1/1/c.zip' }),
        ],
      });
      const text = render([[m]]);
      expect(text).toContain('[a\\](https://evil.example) \\<script>.pdf](https://cdn.discordapp.com/attachments/1/1/x.pdf) (1.5 KB)');
      expect(text).toContain('[b.pdf](<https://cdn.discordapp.com/attachments/1/1/file%20(1).pdf>) (1.5 KB)');
      expect(text).toContain('[\\`code\\`\\*bold\\*.zip](https://cdn.discordapp.com/attachments/1/1/c.zip) (1.5 KB)');
      expect(rawHtml(text)).toEqual([]);
    });
  });

  describe('embeds', () => {
    it('writes an embed as a block quote with title link, description, fields, image and footer', () => {
      const m = message(1, '', {
        embeds: [
          {
            type: 'rich',
            title: 'Maintenance *soon*',
            url: 'https://example.com/status',
            description: 'Tonight **02:00**\n[details](https://example.com/d)',
            author: { name: 'Status Page', url: 'https://example.com' },
            fields: [
              { name: 'Affected', value: 'API, Web' },
              { name: 'Notes', value: '- one\n- two' },
            ],
            image: { url: 'https://example.org/chart.png', proxy_url: 'https://media.discordapp.net/external/chart.png', width: 10, height: 10 },
            footer: { text: 'Status Bot' },
            timestamp: '2026-10-05T12:00:00.000000+00:00',
          },
        ],
      });
      expect(render([[m]])).toContain(
        [
          '> <sub>[Status Page](https://example.com/)</sub>',
          '>',
          '> **[Maintenance \\*soon\\*](https://example.com/status)**',
          '>',
          '> Tonight **02:00**  ',
          '> [details](https://example.com/d)',
          '>',
          '> **Affected**  ',
          '> API, Web',
          '>',
          '> **Notes**  ',
          '> - one',
          '> - two',
          '>',
          '> ![Maintenance \\*soon\\*](https://media.discordapp.net/external/chart.png)',
          '>',
          '> <sub>Status Bot · 2026-10-05 12:00:00</sub>',
          '',
        ].join('\n'),
      );
    });

    it('does not hot-link images from other hosts, and shows a title-less embed as its URL', () => {
      const m = message(1, '', {
        embeds: [
          { type: 'image', url: 'https://example.com/cat.png', thumbnail: { url: 'https://example.com/t.png' }, image: { url: 'https://example.com/i.png' } },
          { type: 'link', url: 'javascript:alert(1)' },
          {},
        ],
      });
      const text = render([[m]]);
      expect(text).toContain('\n> <https://example.com/cat.png>\n');
      expect(text).not.toContain('![');
      expect(text).not.toContain('javascript:');
      expect(text).toContain('\n> \\[embed\\]\n');
    });

    it('escapes everything an embed author controls', () => {
      const m = message(1, '', {
        embeds: [
          {
            title: '<script>alert(1)</script>',
            description: '<img src=x onerror=alert(1)> [x](javascript:alert(1)) <!-- c',
            fields: [{ name: '<b>n</b>', value: '# fake\n---\n> q' }],
            footer: { text: '<u>f</u>' },
            author: { name: '[a](https://evil.example)' },
          },
        ],
      });
      const text = render([[m]]);
      expect(rawHtml(text)).toEqual([]);
      expect(unsafeDestinations(text)).toEqual([]);
      expect(text).not.toMatch(/^> ?#{1,3} /m);
    });
  });

  describe('stickers, polls, forwards and reactions', () => {
    it('shows PNG stickers as images from Discord and Lottie stickers as text', () => {
      const m = message(1, '', {
        sticker_items: [
          { id: '123', name: 'wave *hi*', format_type: 1 },
          { id: '124', name: '웃는 고양이', format_type: 3 },
        ],
      });
      const text = render([[m]]);
      expect(text).toContain('![wave \\*hi\\*](https://media.discordapp.net/stickers/123.png?size=160)');
      expect(text).toContain('*Sticker: 웃는 고양이*');
    });

    it('writes polls as a quote with votes', () => {
      const m = message(1, '', {
        poll: {
          question: { text: 'Lunch? *now*' },
          answers: [
            { answer_id: 1, poll_media: { text: 'Ramen', emoji: { id: null, name: '🍜' } } },
            { answer_id: 2, poll_media: { text: 'Pizza' } },
          ],
          allow_multiselect: true,
          results: { is_finalized: true, answer_counts: [{ id: 1, count: 3 }] },
        },
      });
      expect(render([[m]])).toContain(
        ['> **Poll:** Lunch? \\*now\\*', '>', '> 1. 🍜 Ramen — 3 votes', '> 2. Pizza — 0 votes', '>', '> <sub>Multiple choice · Ended · 3 votes in total</sub>', ''].join('\n'),
      );
      expect(render([[m]], context({ options: { locale: 'ko' } }))).toContain('> **투표:** Lunch? \\*now\\*');
    });

    it('writes forwarded messages as a quote, with nested embeds', () => {
      const m = message(1, '', {
        message_reference: { type: 1, message_id: '5', channel_id: '6' },
        message_snapshots: [
          {
            message: {
              content: 'original **text**',
              timestamp: '2026-10-01T08:00:00.000000+00:00',
              attachments: [{ id: '1', filename: 'a.zip', size: 2048, url: 'https://cdn.discordapp.com/attachments/1/1/a.zip' }],
              embeds: [{ title: 'Embedded', url: 'https://example.com/e' }],
            },
          },
        ],
      });
      expect(render([[m]])).toContain(
        [
          '> *Forwarded*',
          '>',
          '> <sub>2026-10-01 08:00:00</sub>',
          '>',
          '> original **text**',
          '>',
          '> [a.zip](https://cdn.discordapp.com/attachments/1/1/a.zip) (2 KB)',
          '>',
          '> > **[Embedded](https://example.com/e)**',
          '',
        ].join('\n'),
      );
    });

    it('writes custom reaction emoji as images from the Discord CDN', () => {
      const m = message(1, 'x', {
        reactions: [
          { count: 12, emoji: { id: null, name: '🔥' } },
          { count: 1, emoji: { id: '77', name: 'pepe_happy', animated: false } },
          { count: 2, emoji: { id: '78', name: 'dance', animated: true } },
          { count: 3, emoji: { id: 'not-a-number', name: 'broken' } },
        ],
      });
      expect(render([[m]])).toContain(
        `🔥 12 · ![:pepe_happy:](${emojiUrl('77', false, 32)}) 1 · ![:dance:](${emojiUrl('78', true, 32)}) 2 · :broken: 3\n`,
      );
    });
  });

  describe('hostile content', () => {
    const hostile = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<!-- unclosed comment',
      '<a href="javascript:alert(1)">x</a>',
      '<iframe src="https://evil.example"></iframe>',
      '<svg/onload=alert(1)>',
      '<<script>>alert(1)<</script>',
      '&lt;script&gt;alert(1)&lt;/script&gt; &#60;b&#62;',
      '[click me](javascript:alert(1)) [data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==) [vb](vbscript:msgbox(1))',
      '![x](https://tracker.example/pixel.gif)',
      'wow![x](https://tracker.example/pixel.gif)',
      '[![x](https://tracker.example/pixel.gif)](https://evil.example)',
      '<javascript:alert(1)> <file:///etc/passwd> <ftp://x>',
      '[ref]: javascript:alert(1)\n[ref]',
      '<https://example.com/ok> and <https://example.com/a"onmouseover="alert(1)>',
      '<sub>forged</sub> <sub onclick=alert(1)>x</sub>',
      '[x](<https://example.com/a b>) [y](https://example.com/a)b)',
    ];

    it('never writes raw HTML, comments or non-http(s) link destinations', () => {
      const messages = hostile.map((body, i) => message(i + 1, body));
      const text = render([messages]);
      expect(rawHtml(text)).toEqual([]);
      expect(unsafeDestinations(text)).toEqual([]);
      expect(text).not.toMatch(/(^|[^\\])!\[x\]\(https:\/\/tracker/m);
    });

    it.each([
      ['<script>alert(1)</script>', '\\<script>alert(1)\\</script>'],
      ['<img src=x onerror=alert(1)>', '\\<img src=x onerror=alert(1)>'],
      ['<!-- c', '\\<!-- c'],
      ['&lt;b&gt; &#60;', '\\&lt;b\\&gt; \\&#60;'],
      ['[x](javascript:alert(1))', '\\[x\\](javascript:alert(1))'],
      ['![x](https://a.com/x.png)', '\\![x](https://a.com/x.png)'],
      ['wow![x](https://a.com/x.png)', 'wow\\![x](https://a.com/x.png)'],
    ])('escapes %j', (input, expected) => {
      expect(md(input)).toBe(expected);
    });

    it('cannot forge headings, rules, quotes, lists or code through message text', () => {
      const forged = ['# Title', '## 2026-10-05', '### x', '#### four', '---', '===', '> quote', '- item', '+ plus', '* star', '1) one', '2. two', '~~~', '    code', '| a | b |'].join('\n');
      const text = render([[message(1, forged)]]);
      const lines = text.split('\n');
      expect(lines.filter((l) => /^#{1,3} /.test(l))).toEqual(['# My Server - #general', '## 2026-10-05']);
      expect(lines.filter((l) => l === '---')).toHaveLength(2);
      expect(lines.filter((l) => /^(```|~~~)/.test(l))).toEqual([]);
      expect(text).not.toMatch(/^ {4}\S/m);
    });

    it.each([
      ['a heading', '- # Forged heading', '- \\# Forged heading'],
      ['a deeper heading', '- ## two', '- \\## two'],
      ['a quote', '- > forged quote', '- \\> forged quote'],
      ['an ordered list', '- 1. nested', '- 1\\. nested'],
      ['an ordered list with a parenthesis', '- 1) x', '- 1\\) x'],
      ['a bullet list', '- - nested bullet', '- \\- nested bullet'],
      ['a plus list', '- + plus', '- \\+ plus'],
      ['a rule', '- ---', '- \\---'],
      ['a setext underline', '- ===', '- \\==='],
      ['a code fence', '- ~~~', '- \\~\\~\\~'],
      ['a heading after a star bullet', '* # star item', '- \\# star item'],
      ['a heading in an ordered item', '1. # ordered forged', '1. \\# ordered forged'],
      ['a quote in an ordered item', '2. > q', '2. \\> q'],
      ['a heading in a nested item', '- a\n  - # deep forged', '- a\n  - \\# deep forged'],
      ['every item of a list', '- a\n- > b\n- # c', '- a\n- \\> b\n- \\# c'],
      ['a nested ordered list in an ordered item', '1. a\n2. 3. x', '1. a\n2. 3\\. x'],
      ['a heading in a quoted list', '> - # x', '> - \\# x'],
    ])('cannot forge %s at the start of a list item', (_name, input, expected) => {
      expect(md(input)).toBe(expected);
    });

    it('leaves list items alone that only look similar', () => {
      expect(md('- #hashtag\n- a > b\n- 1.5 liters\n- -5 degrees')).toBe('- #hashtag\n- a > b\n- 1.5 liters\n- -5 degrees');
    });

    it('keeps content that looks like a message header from becoming one', () => {
      const text = render([[message(1, '**Admin** <sub>12:00:00</sub>\n\n**Admin** `BOT`')]]);
      expect(text).toContain('**Admin** \\<sub>12:00:00\\</sub>');
      expect(rawHtml(text)).toEqual([]);
    });

    it('holds its guarantees for thousands of random strings built from syntax characters', () => {
      let seed = 0x9e3779b9;
      const random = (): number => {
        seed ^= seed << 13;
        seed >>>= 0;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        seed >>>= 0;
        return seed / 4294967296;
      };
      const tokens = [
        '<', '>', '<script>', '</b>', '<!--', '[', ']', '(', ')', '![', '](', 'javascript:', 'https://example.com/a', 'http://evil.example/x.png', '`', '```', '``', '*', '**', '_', '__', '~', '~~', '||',
        '#', '## ', '### 2026-10-05', '---', '===', '+ ', '- ', '1. ', '1) ', '> ', '>>> ', '-# ', '\\', '&amp;', '&#60;', ':', '@', '@everyone', '<@1>', '<#2>', '<@&3>', '<:e:5>', '<t:0>', 'a', 'b c', ' ', '\n', '\n\n',
        '    ', '\t', '안녕', '😀', '|', '<https://x.y/z>', '[a](https://x.y/z)', '[a](<https://x.y/(z)>)', '![a](https://x.y/z.png)', '[a](data:text/html,x)',
      ];
      const problems: string[] = [];
      for (let i = 0; i < 3000; i += 1) {
        const length = 1 + Math.floor(random() * 40);
        let body = '';
        for (let t = 0; t < length; t += 1) body += tokens[Math.floor(random() * tokens.length)];
        const text = render([[message(1, body)]]);
        const lines = withoutCode(text).split('\n');
        const issues: string[] = [];
        if (rawHtml(text).length > 0) issues.push('raw html');
        if (unsafeDestinations(text).length > 0) issues.push('unsafe destination');
        if (!imageDestinations(text).every((d) => /^\(<?https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//.test(d))) issues.push('foreign image');
        if (lines.filter((l) => /^#{1,3} /.test(l)).length !== 2) issues.push('extra heading');
        if (lines.filter((l) => /^\s{0,3}(-+|=+)\s*$/.test(l)).length !== 2) issues.push('rule or setext underline');
        if (lines.some((l) => LIST_ITEM_STARTING_A_BLOCK.test(l))) issues.push('block construct at the start of a list item');
        const unquoted = lines.map((l) => l.replace(/^(?:>\s?)+/, ''));
        if (unquoted.filter((l) => /^#{1,3} /.test(l)).length !== 2) issues.push('heading inside a quote');
        if (issues.length > 0) problems.push(`${JSON.stringify(body)}: ${issues.join(', ')}`);
      }
      expect(problems).toEqual([]);
    });

    it('survives an enormous line and a flood of block markers in time proportional to their size', () => {
      // `percent` scales every repetition count; 100 is 2 MB of "x" plus the floods below.
      const text = expectLinearScaling(
        (percent) => {
          const times = (count: number): number => Math.round((count * percent) / 100);
          return render([
            [
              message(1, 'x'.repeat(times(2_000_000))),
              message(2, '> a\nb\n'.repeat(times(60_000))),
              message(3, '- a\n'.repeat(times(60_000))),
              message(4, '\n'.repeat(times(300_000))),
              message(5, `a${'\n'.repeat(times(250_000))}b`),
              message(6, '*a '.repeat(times(100_000))),
              message(7, '[a](https://example.com) '.repeat(times(40_000))),
            ],
          ]);
        },
        { small: 10, large: 100 },
      );
      expect(text.length).toBeGreaterThan(2_000_000);
    });

    it('normalises line endings and drops control characters before rendering', () => {
      const text = render([[message(1, 'a\r\nb\rc\u0007d\u000Be')]]);
      expect(text).not.toMatch(/[\r\u0007\u000B]/);
      expect(text).toContain('a  \nb  \ncd  \ne');
    });
  });

  it('works end to end through exportChat with the demo client', async () => {
    const result = await exportMock(MOCK_IDS.showcaseChannel, 'md');
    expect(result).toMatchObject({ status: 'done', error: null });
    expect(result.outputs).toHaveLength(1);
    const [output] = result.outputs;
    expect(output!.path).toBe('Discord Export/개발자 라운지 - feature-showcase (2026-10-06).md');
    expect(output!.mime).toBe('text/markdown;charset=utf-8');
    const text = textOf(output!);
    expect(text.startsWith('# 개발자 라운지 - #feature-showcase\n\n- **Server:** 개발자 라운지\n')).toBe(true);
    expect(text).toContain(`- **Messages:** ${result.messageCount}\n`);
    expect(text).toContain('**@Sam Patel**');
    expect(rawHtml(text)).toEqual([]);
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

    it('renders every feature with a safe, well-formed structure', async () => {
      const { messages, names } = await showcase();
      const text = render([messages], context({ names, target, options: { timeZone: 'Asia/Seoul' } }));
      const lines = text.split('\n');

      // title, day headings in ascending order, exactly two rules
      expect(lines[0]).toBe('# Dev Lounge - #showcase');
      const days = lines.filter((l) => l.startsWith('## '));
      expect(days.length).toBeGreaterThan(5);
      expect(days.every((d) => /^## \d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
      expect([...days].sort()).toEqual(days);
      expect(new Set(days).size).toBe(days.length);
      expect(lines.filter((l) => /^#{1,3} /.test(l))).toHaveLength(days.length + 1);
      expect(lines.filter((l) => l === '---')).toHaveLength(2);

      // every author line, one per non-system message
      expect(lines.filter((l) => /^\*\*.+\*\* (`BOT` )?<sub>\d{2}:\d{2}:\d{2}[^<]*<\/sub>$/.test(l)).length).toBeGreaterThan(100);

      // formatting is preserved
      expect(text).toContain('**굵은 글씨**, *기울임*, __밑줄__, ~~취소선~~, ||스포일러||, `인라인 코드` 테스트');
      expect(text).toContain('```ts\ninterface User {');
      expect(text).toContain('> 한 줄 인용문입니다');
      expect(text).toContain('#### 제목 1');
      expect(text).toContain('<sub>작은 글씨 (subtext)</sub>');
      expect(text).toContain('- 사과\n- 바나나\n  - 노란 바나나');
      expect(text).toContain('1. 첫 번째\n2. 두 번째\n3. 세 번째\n   - 하위 항목');
      expect(text).toContain('[Example Domain](https://example.com/)');
      expect(text).toContain('**@Sam Patel**');
      expect(text).toContain('**#empty-channel**');
      expect(text).toMatch(/!\[:pepe_happy:\]\(https:\/\/cdn\.discordapp\.com\/emojis\/\d+\.png\?size=32\)/);

      // embeds, stickers, polls, forwards, replies, system lines, edits
      expect(text).toContain('> **[Scheduled maintenance](https://example.com/status)**');
      expect(text).toContain('![wave](https://media.discordapp.net/stickers/');
      expect(text).toContain('> **Poll:** 점심 뭐 먹을까요?');
      expect(text).toContain('> *Forwarded*');
      expect(text).toContain('> ↪ Replying to **Release Notifier**');
      expect(text).toContain('> ↪ *Original message was deleted*');
      expect(text).toContain('*A Really Remarkably Long Display Name That Will Overflow Narrow Layouts joined the server.*');
      expect(text).toContain('(edited)</sub>');
      expect(text).toContain('`BOT`');

      // safety
      expect(rawHtml(text)).toEqual([]);
      expect(unsafeDestinations(text)).toEqual([]);
      const imageHosts = new Set([...text.matchAll(/!\[[^\]]*\]\((https?:\/\/[^/)]+)/g)].map((m) => m[1]));
      expect([...imageHosts].every((host) => /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)$/.test(host))).toBe(true);
      expect(text).not.toMatch(/[\r\u0000-\u0008\u000B-\u001F]/);
    });

    it('is localised in Korean', async () => {
      const { messages, names } = await showcase();
      const text = render([messages], context({ names, target, options: { locale: 'ko' } }));
      expect(text).toContain('- **서버:** Dev Lounge');
      expect(text).toContain('님에게 답장:');
      expect(text).toContain('님이 서버에 참여했어요.');
      expect(text).toContain('(수정됨)</sub>');
      expect(text).toContain('> *전달된 메시지*');
      expect(text).toContain('> **투표:**');
    });

    it('writes 20,000 messages in time proportional to their number', async () => {
      const { messages, names } = await showcase();
      const inflated = inflateMessages(messages, 20_000);
      const size = expectLinearScaling(
        (count) => {
          const writer = mdFormat.createWriter(context({ names }));
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

describe('markdownText', () => {
  it.each([
    ['inline formatting', '**b** *i* _i2_ __u__ ~~s~~ ||sp||', '**b** *i* *i2* __u__ ~~s~~ ||sp||'],
    ['bold italic', '***both***', '***both***'],
    ['nested formatting', '**a *b* c** ~~**d**~~', '**a *b* c** ~~**d**~~'],
    ['inline code', '`code` and ``a ` b``', '`code` and ``a ` b``'],
    ['code with markdown inside stays literal', '`**x** <b>`', '`**x** <b>`'],
    ['fenced code with language', '```ts\nlet a = 1;\n```', '```ts\nlet a = 1;\n```'],
    ['fenced code between text', 'before\n```\ncode\n```\nafter', 'before\n\n```\ncode\n```\n\nafter'],
    ['single quote', '> quote', '> quote'],
    ['multi-line quote', '> one\n> two', '> one  \n> two'],
    ['quote to the end', '>>> all\nquoted', '> all  \n> quoted'],
    ['headings are demoted below the document headings', '# H1\n## H2\n### H3\ntext', '#### H1\n\n##### H2\n\n###### H3\n\ntext'],
    ['subtext', '-# small', '<sub>small</sub>'],
    ['nested bullet list', '- a\n- b\n  - c', '- a\n- b\n  - c'],
    ['ordered list', '1. a\n2. b\n   - c', '1. a\n2. b\n   - c'],
    ['masked link', '[text](https://example.com/x)', '[text](https://example.com/x)'],
    ['masked link with parentheses in the URL', '[a (b)](https://example.com/a_(b))', '[a (b)](<https://example.com/a_(b)>)'],
    ['bare link', 'see https://example.com/a_b_c.', 'see <https://example.com/a_b_c>.'],
    ['suppressed-embed link', '<https://example.com/x>', '<https://example.com/x>'],
    ['mentions', 'hey <@2000>, <#5> and <@&9>', 'hey **@Bob**, **#general** and **@Mods**'],
    ['mention inside bold is not bolded twice', '**hi <@2000>**', '**hi @Bob**'],
    ['unknown mentions', '<@999> <#7> <@&8>', '**@Unknown User** **#unknown-channel** **@deleted-role**'],
    ['everyone and here', '@everyone @here', '**@everyone** **@here**'],
    ['custom emoji', '<:wave:123> <a:dance:456>', '![:wave:](https://cdn.discordapp.com/emojis/123.png?size=32) ![:dance:](https://cdn.discordapp.com/emojis/456.webp?size=32&animated=true)'],
    ['timestamp', '<t:0:f>', 'January 1, 1970 12:00 AM'],
    ['line break', 'a\nb', 'a  \nb'],
    ['blank line', 'a\n\nb', 'a\n\nb'],
    ['several blank lines', 'a\n\n\n\nb', 'a\n\nb'],
    ['text around a quote', 'text\n> q\nafter', 'text\n\n> q\n\nafter'],
    ['multi-line spoiler', '||two\nlines||', '||two  \nlines||'],
    ['Korean', '**굵게** 와 *기울임* 😀', '**굵게** 와 *기울임* 😀'],
  ])('%s', (_name, input, expected) => {
    expect(md(input)).toBe(expected);
  });

  it.each([
    ['star between spaces', '2 * 3', '2 \\* 3'],
    ['snake_case stays readable', 'snake_case_name', 'snake_case_name'],
    ['a lone underscore', '_x', '\\_x'],
    ['brackets', 'a [b] c', 'a \\[b\\] c'],
    ['angle brackets', '<b>x</b>', '\\<b>x\\</b>'],
    ['entities', '&amp; &lt; & x &#35;', '\\&amp; \\&lt; & x \\&#35;'],
    ['four hashes', '#### four', '\\#### four'],
    ['hashtag', '#hashtag', '#hashtag'],
    ['ordered-list lookalike', '1) x', '1\\) x'],
    ['plus', '+ x', '\\+ x'],
    ['rule lookalike', '---', '\\---'],
    ['setext underline', '===', '\\==='],
    ['lone dash', '-', '\\-'],
    ['tilde fence', '~~~', '\\~\\~\\~'],
    ['paired single tildes', 'a ~ b ~ c', 'a \\~ b \\~ c'],
    ['a single tilde', 'only ~ one', 'only ~ one'],
    ['indented code lookalike', 'x\n    indented', `x  \n${NBSP.repeat(4)}indented`],
    ['tab-indented', 'x\n\ttab', `x  \n${NBSP.repeat(4)}tab`],
    ['backslash before a letter', 'back\\slash', 'back\\slash'],
    ['trailing backslash', 'end \\', 'end \\\\'],
    ['mid-line quote marker', 'a > b', 'a > b'],
    ['mid-line hash', 'a # b', 'a # b'],
  ])('escapes %s', (_name, input, expected) => {
    expect(md(input)).toBe(expected);
  });

  it('escapes block syntax only at the start of a line', () => {
    expect(escapeText('# x', true)).toBe('\\# x');
    expect(escapeText('# x', false)).toBe('# x');
    expect(escapeText('> x', true)).toBe('\\> x');
    expect(escapeText('> x', false)).toBe('> x');
    expect(escapeText('*x', false)).toBe('\\*x');
  });

  it('returns an empty string for empty or non-string input', () => {
    expect(md('')).toBe('');
    expect(markdownText(undefined, MD_CTX)).toBe('');
    expect(markdownText(5, MD_CTX)).toBe('');
  });
});

describe('markdownText: link text that names another site (MD-1)', () => {
  it('appends the real host to a label that looks like a different address, exactly like the HTML export', () => {
    expect(md('[https://good.example](https://evil.example/login)')).toBe(`[https://good.example${linkHostNote('evil.example')}](https://evil.example/login)`);
    expect(md('[https://good.example](https://evil.example/login)')).toBe('[https://good.example ↗ (evil.example)](https://evil.example/login)');
    expect(md('[good.example](https://evil.example/)')).toBe('[good.example ↗ (evil.example)](https://evil.example/)');
  });

  it('shows the port, and exposes a look-alike (homograph) target in punycode', () => {
    expect(md('[https://good.example](https://evil.example:8443/x)')).toBe('[https://good.example ↗ (evil.example:8443)](https://evil.example:8443/x)');
    expect(md('[apple.com](https://xn--pple-43d.com/)')).toBe('[apple.com ↗ (xn--pple-43d.com)](https://xn--pple-43d.com/)');
  });

  it('puts the note after formatted label text, still inside the link', () => {
    expect(md('[**good.example**](https://evil.example/)')).toBe('[**good.example** ↗ (evil.example)](https://evil.example/)');
  });

  it('judges the visible label, not its markup: a label that only looks harmless once rendered is still caught', () => {
    expect(md('[good.**example**](https://evil.example/)')).toBe('[good.**example** ↗ (evil.example)](https://evil.example/)');
  });

  it('agrees with misleadingLinkHost, which also drives the HTML export, for every label it flags', () => {
    for (const [label, url] of [
      ['https://good.com@evil.example', 'https://evil.example/x'],
      ['discord。com', 'https://evil.example/'],
      ['example.com or discord.com', 'https://example.com/'],
    ]) {
      const host = misleadingLinkHost(label, url);
      expect(host).not.toBeNull();
      expect(md(`[${label}](${url})`)).toContain(linkHostNote(host as string));
    }
  });

  it.each([
    ['ordinary words', '[docs](https://example.com/x)', '[docs](https://example.com/x)'],
    ['the label is the very host', '[example.com](https://example.com/x)', '[example.com](https://example.com/x)'],
    ['the label is the very URL', '[https://example.com/a](https://example.com/a)', '[https://example.com/a](https://example.com/a)'],
    ['www and letter case do not count as another site', '[WWW.Example.com](https://example.com/)', '[WWW.Example.com](https://example.com/)'],
    ['a file name is not an address', '[README.md](https://example.com/readme)', '[README.md](https://example.com/readme)'],
    ['a version number is not an address', '[v1.2.3](https://example.com/releases)', '[v1.2.3](https://example.com/releases)'],
    ['a path on the same site', '[example.com/archive.tar.gz](https://example.com/files)', '[example.com/archive.tar.gz](https://example.com/files)'],
    ['an internationalised name and its punycode form are the same site', '[bücher.de](https://xn--bcher-kva.de/)', '[bücher.de](https://xn--bcher-kva.de/)'],
    ['Korean text', '[여기를 눌러 주세요](https://example.com/x)', '[여기를 눌러 주세요](https://example.com/x)'],
  ])('leaves a harmless link untouched: %s', (_name, input, expected) => {
    expect(md(input)).toBe(expected);
  });

  it('does not add a note to a bare URL: it is its own label', () => {
    expect(md('see https://good.example/x')).toBe('see <https://good.example/x>');
  });

  it('says nothing when there is no link to mislead: the destination is not http(s), or the label is empty', () => {
    expect(md('[https://good.example](javascript:alert(1))')).not.toContain('↗');
    expect(md('[](https://evil.example/)')).not.toContain('↗');
  });
});

describe('mdRender helpers', () => {
  it('escapes single-line text', () => {
    expect(escapeInline('  a\n*b* [c]  ')).toBe('a \\*b\\* \\[c\\]');
    expect(escapeInline(null)).toBe('');
  });

  it('builds code spans that survive backticks and padding', () => {
    expect(mdInlineCode('x')).toBe('`x`');
    expect(mdInlineCode('a`b')).toBe('``a`b``');
    expect(mdInlineCode('`x`')).toBe('`` `x` ``');
    expect(mdInlineCode(' x ')).toBe('`  x  `');
    expect(mdInlineCode('a\nb')).toBe('`a b`');
  });

  it('builds code blocks whose fence is longer than any backtick run inside', () => {
    expect(mdCodeBlock('ts', 'x')).toBe('```ts\nx\n```');
    expect(mdCodeBlock(null, 'a ``` b')).toBe('````\na ``` b\n````');
    expect(mdCodeBlock(null, '`````')).toBe('``````\n`````\n``````');
    expect(mdCodeBlock('a b`c', 'x')).toBe('```abc\nx\n```');
  });

  it('builds links and destinations', () => {
    expect(mdDestination('https://a.com/x')).toBe('https://a.com/x');
    expect(mdDestination('https://a.com/(x)')).toBe('<https://a.com/(x)>');
    expect(mdDestination('https://a.com/a\\b')).toBe('https://a.com/a%5Cb');
    expect(mdLink('label', 'https://a.com')).toBe('[label](https://a.com/)');
    expect(mdLink('label', 'javascript:alert(1)')).toBe('label');
    expect(mdLink('label', null)).toBe('label');
    expect(mdAutolink('https://a.com/a_b')).toBe('<https://a.com/a_b>');
    expect(mdAutolink('https://a.com/a b')).toBe('<https://a.com/a%20b>');
    expect(mdAutolink('javascript:alert(1)')).toBeNull();
    expect(mdAutolink('data:text/html,x')).toBeNull();
  });

  it('quotes every line, keeping blank lines inside the quote', () => {
    expect(quoteLines('a\n\nb')).toBe('> a\n>\n> b');
  });
});
