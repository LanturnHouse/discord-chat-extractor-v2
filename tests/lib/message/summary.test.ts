import { describe, expect, it } from 'vitest';
import type { Message, User } from '@/lib/discord/types';
import type { NameResolver } from '@/lib/markdown/types';
import { buildNameResolver, getStrings, type MessageLocale } from '@/lib/message';
import { describeBody } from '@/lib/message/summary';
import { fastestRunMs } from '../markdown/timing';

const user = (id: string, over: Partial<User> = {}): User => ({ id, username: `user${id}`, ...over });
const ALICE = user('1', { global_name: 'Alice' });

function msg(over: Partial<Message> = {}): Message {
  return {
    id: '100',
    channel_id: '1',
    author: ALICE,
    content: '',
    timestamp: '2026-10-06T06:00:00.000000+00:00',
    edited_timestamp: null,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    type: 0,
    ...over,
  };
}

const DEFAULT_MAX = 200;

function bodyOf(message: Message, locale: MessageLocale = 'en', max = DEFAULT_MAX, names?: NameResolver): string {
  const strings = getStrings(locale);
  return describeBody(message, strings, max, names, strings.attachment);
}

const sum = (content: string, over: Partial<Message> = {}, locale: MessageLocale = 'en', max = DEFAULT_MAX): string =>
  bodyOf(msg({ content, ...over }), locale, max);

describe('describeBody: markdown stripping', () => {
  it('returns plain text unchanged', () => {
    expect(sum('hello world')).toBe('hello world');
  });

  it('removes emphasis markers', () => {
    expect(sum('**bold** and *italic* and __under__ and ~~gone~~ and _it_')).toBe('bold and italic and under and gone and it');
    expect(sum('***both***')).toBe('both');
  });

  it('keeps literal delimiters that do not form a pair', () => {
    expect(sum('2 * 3 * 4 = 24')).toBe('2 * 3 * 4 = 24');
    expect(sum('a lone * star')).toBe('a lone * star');
    expect(sum('unclosed **bold')).toBe('unclosed **bold');
    expect(sum('snake_case_name stays')).toBe('snake_case_name stays');
    expect(sum('50% ~~ off')).toBe('50% ~~ off');
  });

  it('strips code spans and fenced blocks but keeps their text', () => {
    expect(sum('run `npm test` now')).toBe('run npm test now');
    expect(sum('```js\nconst a = 1;\n```')).toBe('const a = 1;');
    expect(sum('```inline```')).toBe('inline');
    expect(sum('before\n```\ncode\n```\nafter')).toBe('before code after');
  });

  it('strips quotes, headings and subtext prefixes', () => {
    expect(sum('> quoted')).toBe('quoted');
    expect(sum('>>> block\nquote')).toBe('block quote');
    expect(sum('# Title\n## Sub\n### Sub-sub\n-# small')).toBe('Title Sub Sub-sub small');
    expect(sum('a > b')).toBe('a > b');
  });

  it('keeps list bullets as text', () => {
    expect(sum('- one\n- two')).toBe('- one - two');
  });

  it('reduces masked links to their label and keeps bare / angle-bracket URLs', () => {
    expect(sum('see [the docs](https://example.com/docs) now')).toBe('see the docs now');
    expect(sum('go to <https://example.com/x>')).toBe('go to https://example.com/x');
    expect(sum('plain https://example.com/x')).toBe('plain https://example.com/x');
  });

  it('hides spoiler text', () => {
    expect(sum('it was ||the butler||')).toBe('it was [spoiler]');
    expect(sum('it was ||the butler||', {}, 'ko')).toBe('it was [스포일러]');
  });

  it('turns custom emoji into :name:', () => {
    expect(sum('hi <:party:123456789012345678> and <a:dance:987654321098765432>')).toBe('hi :party: and :dance:');
  });

  it('resolves user mentions from the message itself', () => {
    expect(sum('hey <@2> and <@!3>', { mentions: [user('2', { global_name: 'Bob' }), user('3', { username: 'carol' })] })).toBe(
      'hey @Bob and @carol',
    );
  });

  it('prefers the supplied resolver and uses it for roles and channels', () => {
    const names = buildNameResolver({ users: { '2': 'Robert' }, roles: { '8': 'Mods' }, channels: { '9': 'general' } });
    const out = bodyOf(msg({ content: '<@2> <@&8> <#9>', mentions: [user('2', { global_name: 'Bob' })] }), 'en', DEFAULT_MAX, names);
    expect(out).toBe('@Robert @Mods #general');
  });

  it('falls back to mention_channels and to the body renderer placeholders for unknown ids', () => {
    expect(sum('<#9>', { mention_channels: [{ id: '9', guild_id: '1', type: 0, name: 'elsewhere' }] })).toBe('#elsewhere');
    // The same placeholders as the message body of an export (renderText), see plain.test.ts.
    expect(sum('<@5> <@&6> <#7>')).toBe('@Unknown User @deleted-role #unknown-channel');
    expect(sum('<@5> <@&6> <#7>', {}, 'ko')).toBe('@알 수 없는 사용자 @삭제된-역할 #알 수 없는 채널');
  });

  it('keeps @everyone and @here', () => {
    expect(sum('@everyone and @here')).toBe('@everyone and @here');
  });

  it('renders timestamps as UTC date-times', () => {
    expect(sum('at <t:1791266652:f>')).toBe('at 2026-10-06 06:04:12 UTC');
    expect(sum('at <t:1791266652>')).toBe('at 2026-10-06 06:04:12 UTC');
    // A token that is not a valid date stays literal, exactly like in the message body.
    expect(sum('far <t:9999999999999:R>')).toBe('far <t:9999999999999:R>');
  });

  it('collapses all whitespace, including CRLF and tabs, into single spaces', () => {
    expect(sum('a\r\n\r\nb\t\tc    d')).toBe('a b c d');
  });

  it('removes control and bidi-override characters', () => {
    const bidi = String.fromCharCode(0x202e);
    expect(sum(`ab${bidi}cd${String.fromCharCode(0)}ef`)).toBe('ab cd ef');
  });
});

describe('describeBody: non-text messages', () => {
  it('uses [attachment] / [첨부 파일] for attachment-only messages', () => {
    const attachments = [{ id: '1', filename: 'a.png', size: 1, url: 'https://cdn.discordapp.com/a.png' }];
    expect(sum('', { attachments })).toBe('[attachment]');
    expect(sum('', { attachments }, 'ko')).toBe('[첨부 파일]');
    expect(sum('caption', { attachments })).toBe('caption');
  });

  it('describes sticker, embed, poll and forward messages', () => {
    expect(sum('', { sticker_items: [{ id: '1', name: 's', format_type: 1 }] })).toBe('[sticker]');
    expect(sum('', { embeds: [{ title: 'Release **1.0**' }] })).toBe('Release 1.0');
    expect(sum('', { embeds: [{ author: { name: 'bot' } }] })).toBe('bot');
    expect(sum('', { embeds: [{}] })).toBe('[embed]');
    expect(sum('', { poll: { question: { text: 'Lunch?' }, answers: [] } })).toBe('[poll] Lunch?');
    expect(sum('', { poll: { question: {}, answers: [] } })).toBe('[poll]');
    expect(sum('', { message_snapshots: [{ message: { content: 'orig **text**' } }] })).toBe('[forwarded message] orig text');
    expect(sum('', { message_snapshots: [{ message: { content: '' } }] }, 'ko')).toBe('[전달된 메시지]');
  });

  it('is empty for a message with nothing to show', () => {
    expect(sum('')).toBe('');
  });
});

describe('describeBody: length', () => {
  it('truncates to the requested length, ellipsis included', () => {
    const out = sum('abcdefghij '.repeat(100));
    expect(out.length).toBeLessThanOrEqual(DEFAULT_MAX);
    expect(out.endsWith('…')).toBe(true);
    expect(sum('abcdefghijklmnop', {}, 'en', 8)).toBe('abcdefg…');
  });

  it('does not split a surrogate pair when truncating', () => {
    const emoji = String.fromCodePoint(0x1f600);
    const out = sum(emoji.repeat(50), {}, 'en', 10);
    expect(out.length).toBeLessThanOrEqual(10);
    const body = out.slice(0, -1);
    expect(body).toBe(emoji.repeat(body.length / 2));
  });
});

describe('describeBody: hostile input stays fast and safe', () => {
  const nasty: Record<string, string> = {
    stars: '*'.repeat(50_000),
    unders: '_'.repeat(50_000),
    starSpace: '* '.repeat(25_000),
    mixedPairs: 'a*b_c~d|e'.repeat(6_000),
    ticks: '`'.repeat(50_000),
    tripleTicks: '```a'.repeat(10_000),
    brackets: '['.repeat(50_000),
    linkish: '[a](http://'.repeat(5_000),
    angles: '<'.repeat(50_000),
    angleMentions: '<@'.repeat(25_000),
    pipes: '||'.repeat(25_000),
    openPipes: '|| a '.repeat(10_000),
    hashes: '#'.repeat(50_000),
    quotes: '> '.repeat(25_000),
    tilde: '~~ a '.repeat(10_000),
  };

  for (const [name, content] of Object.entries(nasty)) {
    it(`handles ${name} quickly`, () => {
      let out = '';
      // The input is cut to a fixed scan limit first, so this is cheap; the ceiling only catches a quadratic path.
      expect(fastestRunMs(500, () => void (out = sum(content)))).toBeLessThan(500);
      expect(out.length).toBeLessThanOrEqual(DEFAULT_MAX);
      expect(out).not.toMatch(/[\r\n]/);
    });
  }

  it('processes a long realistic message without scanning all of it', () => {
    const scanAll = (): void => {
      for (let i = 0; i < 200; i += 1) sum(`**line ${i}** `.repeat(2000));
    };
    expect(fastestRunMs(2000, scanAll)).toBeLessThan(2000);
  });
});

describe('strings table', () => {
  it('has identical shapes in both languages', () => {
    const en = getStrings('en');
    const ko = getStrings('ko');
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    expect(ko.months).toHaveLength(12);
    expect(en.months).toHaveLength(12);
    expect(ko.weekdays).toHaveLength(7);
    expect(en.weekdays).toHaveLength(7);
  });

  it('falls back to English for anything unexpected', () => {
    expect(getStrings('fr')).toBe(getStrings('en'));
    expect(getStrings(undefined)).toBe(getStrings('en'));
    expect(getStrings(null)).toBe(getStrings('en'));
  });
});
