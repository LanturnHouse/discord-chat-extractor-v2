import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '@/lib/markdown/parse';
import { renderText } from '@/lib/markdown/renderText';
import type { MarkdownContext } from '@/lib/markdown/types';
import { getStrings } from '@/lib/message';
import { plainFromMarkdown, type PlainContext } from '@/lib/message/plain';
import { oneLine } from '@/lib/message/text';

const NAMES: Record<string, string> = { '1': 'Alice' };

function plainContext(locale: 'ko' | 'en', over: Partial<PlainContext> = {}): PlainContext {
  return {
    strings: getStrings(locale),
    user: (id) => NAMES[id],
    channel: (id) => (id === '2' ? 'general' : undefined),
    role: (id) => (id === '3' ? 'Mods' : undefined),
    ...over,
  };
}

function markdownContext(locale: 'ko' | 'en', timeZone = 'UTC'): MarkdownContext {
  return { locale, timeZone, names: { user: (id) => NAMES[id], channel: (id) => (id === '2' ? 'general' : undefined), role: (id) => (id === '3' ? 'Mods' : undefined) } };
}

/** What the message body of an export shows for the same text (the full-fidelity renderer, collapsed to one line). */
const bodyText = (content: string, locale: 'ko' | 'en', timeZone = 'UTC'): string =>
  oneLine(renderText(parseMarkdown(content), markdownContext(locale, timeZone)));

const plain = (content: string, locale: 'ko' | 'en' = 'en', over: Partial<PlainContext> = {}): string =>
  plainFromMarkdown(content, plainContext(locale, over));

describe('plainFromMarkdown: same labels as the message body', () => {
  const MENTIONS = ['<@1>', '<@999>', '<@!999>', '<@&3>', '<@&998>', '<#2>', '<#997>', '@everyone', '@here', '<:party:123456789012345678>', 'hi <@999> in <#997> and <@&998>'];

  for (const locale of ['en', 'ko'] as const) {
    it.each(MENTIONS)(`reads "%s" like the body does (${locale})`, (content) => {
      expect(plain(content, locale)).toBe(bodyText(content, locale));
    });
  }

  it('spells an unresolvable mention, channel and role like the body, in both languages', () => {
    expect(plain('<@999> <#997> <@&998>', 'en')).toBe('@Unknown User #unknown-channel @deleted-role');
    expect(plain('<@999> <#997> <@&998>', 'ko')).toBe('@알 수 없는 사용자 #알 수 없는 채널 @삭제된-역할');
  });

  it('resolves known ids through the context', () => {
    expect(plain('<@1> <#2> <@&3>')).toBe('@Alice #general @Mods');
  });
});

describe('plainFromMarkdown: time zone', () => {
  const TOKEN = '<t:1700000000:f>';

  it('writes the instant in UTC, labelled, when the viewer zone is unknown', () => {
    expect(plain(`at ${TOKEN}`)).toBe('at 2023-11-14 22:13:20 UTC');
  });

  it('uses the same formatter as the body once a zone is supplied', () => {
    for (const locale of ['en', 'ko'] as const) {
      expect(plain(`at ${TOKEN}`, locale, { timeZone: 'Asia/Seoul' })).toBe(bodyText(`at ${TOKEN}`, locale, 'Asia/Seoul'));
    }
    expect(plain(`at ${TOKEN}`, 'en', { timeZone: 'Asia/Seoul' })).toBe('at November 15, 2023 7:13 AM');
  });

  it('honours the style letter once a zone is supplied', () => {
    expect(plain('<t:1700000000:d>', 'en', { timeZone: 'UTC' })).toBe('11/14/2023');
    expect(plain('<t:1700000000:T>', 'en', { timeZone: 'UTC' })).toBe('10:13:20 PM');
  });

  it('keeps a token that does not hold a valid date as text, like the body', () => {
    expect(plain('far <t:9999999999999:R>')).toBe('far <t:9999999999999:R>');
  });
});

describe('plainFromMarkdown: structure', () => {
  it('does not resolve mentions inside code', () => {
    expect(plain('`<@1>` and ```<@1>```')).toBe('<@1> and <@1>');
  });

  it('keeps escaped markers literal', () => {
    expect(plain(String.raw`\*not bold\* and \_not italic\_`)).toBe('*not bold* and _not italic_');
  });

  it('numbers ordered lists and keeps nested items', () => {
    expect(plain('1. first\n2. second\n  - nested')).toBe('1. first 2. second - nested');
  });

  it('separates block nodes from the text around them', () => {
    expect(plain('before\n```\ncode\n```\nafter')).toBe('before code after');
    expect(plain('# Title\ntext')).toBe('Title text');
  });

  it('hides spoilers behind the localised marker', () => {
    expect(plain('||secret|| tail', 'en')).toBe('[spoiler] tail');
    expect(plain('||비밀||', 'ko')).toBe('[스포일러]');
  });

  it('cuts to max units with an ellipsis and never beyond the scan limit', () => {
    expect(plainFromMarkdown('abcdefghij', plainContext('en'), 5)).toBe('abcd…');
    expect(plain('x'.repeat(10_000)).length).toBeLessThanOrEqual(2000);
  });

  it('does not call the context for names it never needs', () => {
    let calls = 0;
    const counting = plainContext('en', {
      user: () => {
        calls += 1;
        return undefined;
      },
    });
    plainFromMarkdown('no mentions at all', counting);
    expect(calls).toBe(0);
  });
});
