import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '@/lib/markdown/parse';
import { formatRelativeTime, formatTimestamp, mentionLabel, renderText } from '@/lib/markdown/renderText';
import type { MarkdownContext } from '@/lib/markdown/types';

const USERS: Record<string, string> = { '1': 'Alice', '2': '한글유저' };
const CHANNELS: Record<string, string> = { '5': 'general' };
const ROLES: Record<string, string> = { '9': 'Mods' };

const makeCtx = (locale: 'ko' | 'en' = 'en', timeZone = 'UTC'): MarkdownContext => ({
  names: { user: (id) => USERS[id], channel: (id) => CHANNELS[id], role: (id) => ROLES[id] },
  locale,
  timeZone,
});

const text = (md: string, ctx = makeCtx()) => renderText(parseMarkdown(md), ctx);

describe('renderText: inline formatting', () => {
  it.each([
    ['plain', 'hello', 'hello'],
    ['bold, italic and underline lose their markers', '**b** *i* _i2_ __u__', 'b i i2 u'],
    ['bold italic', '***bi***', 'bi'],
    ['strike keeps its markers', 'a ~~gone~~ b', 'a ~~gone~~ b'],
    ['spoilers stay visible but marked', 'a ||secret|| b', 'a ||secret|| b'],
    ['spoiler with formatting inside', '||**x** y||', '||x y||'],
    ['inline code keeps backticks', 'run `ls -la`', 'run `ls -la`'],
    ['inline code containing a backtick', '``a ` b``', '`` a ` b ``'],
    ['newlines', 'a\nb\n\nc', 'a\nb\n\nc'],
    ['escapes are resolved', '\\*not bold\\*', '*not bold*'],
    ['korean', '**안녕** 세계', '안녕 세계'],
  ])('%s', (_name, input, expected) => {
    expect(text(input)).toBe(expected);
  });
});

describe('renderText: links', () => {
  it.each([
    ['bare link', 'see https://a.com/x.', 'see https://a.com/x.'],
    ['suppressed-embed link', '<https://a.com>', 'https://a.com'],
    ['masked link shows the target', '[docs](https://a.com/d)', 'docs (https://a.com/d)'],
    ['masked link whose text is the url', '[https://a.com](https://a.com)', 'https://a.com'],
    ['masked link with formatted text', '[**docs**](https://a.com)', 'docs (https://a.com)'],
    ['unsafe masked link is not a link at all', '[x](javascript:alert(1))', '[x](javascript:alert(1))'],
  ])('%s', (_name, input, expected) => {
    expect(text(input)).toBe(expected);
  });
});

describe('renderText: mentions, emoji, timestamps', () => {
  it.each([
    ['known user', '<@1>', 'en', '@Alice'],
    ['known user with nickname syntax', '<@!2>', 'en', '@한글유저'],
    ['unknown user (en)', '<@999>', 'en', '@Unknown User'],
    ['unknown user (ko)', '<@999>', 'ko', '@알 수 없는 사용자'],
    ['known channel', '<#5>', 'en', '#general'],
    ['unknown channel (en)', '<#6>', 'en', '#unknown-channel'],
    ['unknown channel (ko)', '<#6>', 'ko', '#알 수 없는 채널'],
    ['known role', '<@&9>', 'en', '@Mods'],
    ['unknown role (en)', '<@&10>', 'en', '@deleted-role'],
    ['unknown role (ko)', '<@&10>', 'ko', '@삭제된-역할'],
    ['everyone and here', '@everyone @here', 'en', '@everyone @here'],
    ['custom emoji', 'a <:smile:111> b', 'en', 'a :smile: b'],
    ['animated emoji', '<a:dance:222>', 'en', ':dance:'],
    ['mention inside a sentence', 'hi <@1>, see <#5>!', 'en', 'hi @Alice, see #general!'],
  ] as const)('%s', (_name, input, locale, expected) => {
    expect(text(input, makeCtx(locale))).toBe(expected);
  });

  it('treats an empty resolved name like an unknown one', () => {
    const ctx: MarkdownContext = { names: { user: () => '', channel: () => '', role: () => '' }, locale: 'en', timeZone: 'UTC' };
    expect(renderText(parseMarkdown('<@1> <#2> <@&3>'), ctx)).toBe('@Unknown User #unknown-channel @deleted-role');
  });

  it('mentionLabel only handles mention nodes', () => {
    expect(mentionLabel({ type: 'text', text: 'x' }, makeCtx())).toBeNull();
    expect(mentionLabel({ type: 'mentionEveryone' }, makeCtx())).toBe('@everyone');
  });
});

describe('renderText: timestamps', () => {
  // 1543392060 = 2018-11-28T08:01:00Z (the example from Discord's documentation)
  it.each([
    ['t', '8:01 AM'],
    ['T', '8:01:00 AM'],
    ['d', '11/28/2018'],
    ['D', 'November 28, 2018'],
    ['f', 'November 28, 2018 8:01 AM'],
    ['F', 'Wednesday, November 28, 2018 8:01 AM'],
    ['R', 'November 28, 2018 8:01 AM'], // static files have no "now": relative falls back to f
    ['s', '11/28/2018 8:01 AM'],
    ['S', '11/28/2018 8:01:00 AM'],
  ] as const)('en / UTC / style %s', (style, expected) => {
    expect(text(`<t:1543392060:${style}>`)).toBe(expected);
  });

  it.each([
    ['t', '오전 8:01'],
    ['D', '2018년 11월 28일'],
    ['f', '2018년 11월 28일 오전 8:01'],
    ['F', '2018년 11월 28일 수요일 오전 8:01'],
    ['d', '2018. 11. 28.'],
  ] as const)('ko / UTC / style %s', (style, expected) => {
    expect(text(`<t:1543392060:${style}>`, makeCtx('ko'))).toBe(expected);
  });

  it('defaults to style f', () => {
    expect(text('<t:1543392060>')).toBe('November 28, 2018 8:01 AM');
  });

  it('honours the time zone', () => {
    expect(text('<t:1543392060:f>', makeCtx('en', 'Asia/Seoul'))).toBe('November 28, 2018 5:01 PM');
    expect(text('<t:1543392060:f>', makeCtx('en', 'America/New_York'))).toBe('November 28, 2018 3:01 AM');
    expect(text('<t:1543392060:f>', makeCtx('ko', 'Asia/Seoul'))).toBe('2018년 11월 28일 오후 5:01');
  });

  it('crosses the date line with the zone', () => {
    // 2018-11-28T23:30:00Z is already the 29th in Seoul
    expect(text('<t:1543447800:d>', makeCtx('en', 'Asia/Seoul'))).toBe('11/29/2018');
    expect(text('<t:1543447800:d>', makeCtx('en', 'UTC'))).toBe('11/28/2018');
  });

  it('falls back to UTC for an invalid time zone instead of throwing', () => {
    expect(text('<t:1543392060:f>', makeCtx('en', 'Not/AZone'))).toBe('November 28, 2018 8:01 AM');
  });

  it('never contains narrow no-break spaces', () => {
    expect(formatTimestamp(1543392060, 'f', makeCtx())).not.toMatch(/[  ]/);
  });

  it('formats negative and zero timestamps', () => {
    expect(formatTimestamp(0, 'f', makeCtx())).toBe('January 1, 1970 12:00 AM');
    expect(formatTimestamp(-86400, 'd', makeCtx())).toBe('12/31/1969');
  });

  it('returns the raw number for dates outside the Date range', () => {
    expect(formatTimestamp(1e20, 'f', makeCtx())).toBe(String(1e20));
    expect(formatTimestamp(Number.NaN, 'f', makeCtx())).toBe('NaN');
  });
});

describe('formatRelativeTime', () => {
  const now = 1_700_000_000_000;
  const at = (offsetSeconds: number) => now / 1000 + offsetSeconds;

  it.each([
    [-5, '5 seconds ago', '5초 전'],
    [30, 'in 30 seconds', '30초 후'],
    [-90, '1 minute ago', '1분 전'],
    [-7200, '2 hours ago', '2시간 전'],
    [5 * 3600, 'in 5 hours', '5시간 후'],
    [-3 * 86400, '3 days ago', '3일 전'],
    [-800 * 86400, '2 years ago', '2년 전'],
  ])('offset %is', (offset, en, ko) => {
    expect(formatRelativeTime(at(offset), 'en', now)).toBe(en);
    expect(formatRelativeTime(at(offset), 'ko', now)).toBe(ko);
  });

  it('uses the current time by default', () => {
    expect(formatRelativeTime(Date.now() / 1000 + 3 * 3600, 'en')).toMatch(/in [23] hours/);
  });
});

describe('renderText: block elements', () => {
  it.each([
    ['code block with language', '```js\nconst a = 1;\n```', '```js\nconst a = 1;\n```'],
    ['code block without language', '```\nx\n```', '```\nx\n```'],
    ['code block content is untouched', '```\n**not bold** <@1>\n```', '```\n**not bold** <@1>\n```'],
    ['quote', '> a\n> b', '> a\n> b'],
    ['quote with a blank line', '> a\n> \n> b', '> a\n>\n> b'],
    ['>>> quote', '>>> a\nb', '> a\n> b'],
    ['quote with formatting and mention', '> **hi** <@1>', '> hi @Alice'],
    ['heading levels', '# a\n## b\n### c', '# a\n## b\n### c'],
    ['heading with formatting', '# **bold** title', '# bold title'],
    ['subtext', '-# small print', '-# small print'],
    ['bullet list', '- a\n- b', '- a\n- b'],
    ['asterisk bullets become dashes', '* a\n* b', '- a\n- b'],
    ['ordered list', '1. a\n2. b', '1. a\n2. b'],
    ['ordered list numbering from the first number', '3. a\n4. b', '3. a\n4. b'],
    ['nested list', '- a\n  - b\n    - c\n- d', '- a\n  - b\n    - c\n- d'],
    ['list item formatting', '- **a** ~~b~~', '- a ~~b~~'],
    ['ordered inside bullets', '- a\n  1. b\n  2. c', '- a\n  1. b\n  2. c'],
  ])('%s', (_name, input, expected) => {
    expect(text(input)).toBe(expected);
  });

  it.each([
    ['text, heading, text', 'a\n# H\nb', 'a\n# H\nb'],
    ['blank line before a heading', 'a\n\n# H', 'a\n\n# H'],
    ['blank line after a heading', '# H\n\nb', '# H\n\nb'],
    ['text then quote then text', 'a\n> q\nb', 'a\n> q\nb'],
    ['text then list then text', 'a\n- x\nb', 'a\n- x\nb'],
    ['two blocks in a row', '# H\n> q', '# H\n> q'],
    ['code block between paragraphs', 'a\n```x```\nb', 'a\n```\nx\n```\nb'],
    ['mid-line code block moves onto its own lines', 'run ```x``` now', 'run \n```\nx\n```\n now'],
  ])('keeps blocks on their own lines: %s', (_name, input, expected) => {
    expect(text(input)).toBe(expected);
  });

  it('round-trips a realistic message', () => {
    const md = [
      '# Release notes',
      'Thanks <@1>! See <#5> and https://a.com/x.',
      '> quoted **text**',
      '- fixed `bug`',
      '- added ~~nothing~~ docs',
      '```ts',
      'const x = 1;',
      '```',
      '||spoiler||',
    ].join('\n');
    expect(text(md)).toBe(
      [
        '# Release notes',
        'Thanks @Alice! See #general and https://a.com/x.',
        '> quoted text',
        '- fixed `bug`',
        '- added ~~nothing~~ docs',
        '```ts',
        'const x = 1;',
        '```',
        '||spoiler||',
      ].join('\n'),
    );
  });

  it('renders an empty node list as an empty string', () => {
    expect(renderText([], makeCtx())).toBe('');
  });
});
