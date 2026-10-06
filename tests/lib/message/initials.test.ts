import { describe, expect, it } from 'vitest';
import { acronymOf, glyphsOf, initialOf, toneOf } from '@/lib/message';
import { MAX_ACRONYM_GLYPHS } from '@/lib/message/initials';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('glyphsOf', () => {
  it('splits into user-perceived characters', () => {
    expect(glyphsOf('abc')).toEqual(['a', 'b', 'c']);
    expect(glyphsOf('가나')).toEqual(['가', '나']);
    expect(glyphsOf('')).toEqual([]);
  });

  it('keeps surrogate pairs, flags, joined emoji and combining marks in one piece', () => {
    expect(glyphsOf('𠮷a')).toEqual(['𠮷', 'a']);
    expect(glyphsOf('🇰🇷a')).toEqual(['🇰🇷', 'a']);
    expect(glyphsOf('👨‍👩‍👧a')).toEqual(['👨‍👩‍👧', 'a']);
    expect(glyphsOf('éx')).toEqual(['é', 'x']);
  });
});

describe('acronymOf', () => {
  it('takes the first letter of every word', () => {
    expect(acronymOf('Open Source Garage')).toBe('OSG');
    expect(acronymOf('Dev Lounge')).toBe('DL');
    expect(acronymOf('Archive of 2024...')).toBe('Ao2');
  });

  it('keeps the case of the name', () => {
    expect(acronymOf('my little server')).toBe('mls');
  });

  it('stops after four glyphs', () => {
    expect(MAX_ACRONYM_GLYPHS).toBe(4);
    expect(acronymOf('The Extremely Long Server Name That Keeps Going')).toBe('TELS');
  });

  it('handles Hangul and other CJK without spaces as one word', () => {
    expect(acronymOf('개발자 라운지')).toBe('개라');
    expect(acronymOf('개발자라운지')).toBe('개');
    expect(acronymOf('日本語 サーバー')).toBe('日サ');
    expect(acronymOf('𠮷野家 Fan')).toBe('𠮷F');
  });

  it('keeps emoji whole, also when they are the first glyph of a word', () => {
    expect(acronymOf('🎮🔥 Game Night 🎲✨')).toBe('🎮GN🎲');
    expect(acronymOf('👨‍👩‍👧 Family')).toBe('👨‍👩‍👧F');
    expect(acronymOf('🇰🇷 Korea')).toBe('🇰🇷K');
    expect(acronymOf('🍕')).toBe('🍕');
  });

  it('skips words that are only punctuation and finds the first real character of a word', () => {
    expect(acronymOf('Rock - Paper & Scissors')).toBe('RPS');
    expect(acronymOf('(Beta) Testers')).toBe('BT');
    expect(acronymOf('A/B:C*?')).toBe('A');
    expect(acronymOf('<b>bold</b> & "quotes" <script>alert(1)</script>')).toBe('bqs');
  });

  it('ignores the possessive and extra white space', () => {
    expect(acronymOf("John's Server")).toBe('JS');
    expect(acronymOf('  a \t b\n c  ')).toBe('abc');
  });

  it('counts digits and letters of any script', () => {
    expect(acronymOf('2024 Archive')).toBe('2A');
    expect(acronymOf('مجتمع المطورين')).toHaveLength(2);
    expect(acronymOf('Éclair école')).toBe('Éé');
  });

  it('falls back to the first visible character, then to a question mark', () => {
    expect(acronymOf('!!!')).toBe('!');
    expect(acronymOf('  - -  ')).toBe('-');
    expect(acronymOf('')).toBe('?');
    expect(acronymOf('   ')).toBe('?');
  });

  it('never produces a lone surrogate', () => {
    for (const name of ['𠮷', '😀😀 😀', 'a𠮷b c', '👍🏽 ok']) expect(acronymOf(name)).not.toMatch(LONE_SURROGATE);
  });
});

describe('initialOf', () => {
  it('is the upper-cased first character', () => {
    expect(initialOf('alice')).toBe('A');
    expect(initialOf('Bob')).toBe('B');
    expect(initialOf('김민준')).toBe('김');
    expect(initialOf('ñandú')).toBe('Ñ');
  });

  it('skips leading white space', () => {
    expect(initialOf('  carol')).toBe('C');
    expect(initialOf('\n\tdave')).toBe('D');
  });

  it('keeps a flag, a joined emoji or a letter with combining marks whole', () => {
    expect(initialOf('🇰🇷 Korea')).toBe('🇰🇷');
    expect(initialOf('👨‍👩‍👧 Family')).toBe('👨‍👩‍👧');
    expect(initialOf('e\u0301cole')).toBe('E\u0301');
    expect(initialOf('𠮷野家')).toBe('𠮷');
  });

  it('falls back to a question mark for an empty name', () => {
    expect(initialOf('')).toBe('?');
    expect(initialOf('   ')).toBe('?');
  });

  it('never produces a lone surrogate', () => {
    for (const name of ['𠮷', '😀', '👍🏽 ok']) expect(initialOf(name)).not.toMatch(LONE_SURROGATE);
  });
});

describe('toneOf', () => {
  it('is the sum of the character codes modulo the six colours of the palette', () => {
    expect(toneOf('0')).toBe(0); // 48 % 6
    expect(toneOf('1')).toBe(1); // 49 % 6
    expect(toneOf('12')).toBe(3); // (49 + 50) % 6
    expect(toneOf('')).toBe(0);
  });

  it('stays inside the palette and is stable for an id', () => {
    for (const id of ['175928847299117063', '1', '999999999999999999', 'not-a-number', '한글']) {
      expect(toneOf(id)).toBe(toneOf(id));
      expect(toneOf(id)).toBeGreaterThanOrEqual(0);
      expect(toneOf(id)).toBeLessThan(6);
    }
  });

  it('gives anything that is not a string the first colour', () => {
    for (const id of [undefined, null, 12, {}, ['1']]) expect(toneOf(id)).toBe(0);
  });
});
