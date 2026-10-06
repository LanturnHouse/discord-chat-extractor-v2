import { describe, expect, it } from 'vitest';
import { appSettingsStrings, consentStrings, historyStrings, popupStrings } from '@/popup/strings';
import { summaryStrings } from '@/ui/format/strings';
import { commonStrings } from '@/ui/i18n/common';
import { LOCALES, defineStrings, getStrings, resolveLocale, resolveUiLocale } from '@/ui/i18n/core';
import { settingsStrings } from '@/ui/settings/strings';

// Every table the UI ships. A new table must be added here: the check below is what keeps ko and en in step at run time (the
// compile-time half is `defineStrings`, which rejects a missing or mismatching key in `en`).
const TABLES: Record<string, { ko: Record<string, unknown>; en: Record<string, unknown> }> = {
  commonStrings,
  summaryStrings,
  settingsStrings,
  popupStrings,
  consentStrings,
  appSettingsStrings,
  historyStrings,
};

describe('defineStrings', () => {
  const table = defineStrings({
    ko: { title: '제목', count: (n: number) => `${n}개` },
    en: { title: 'Title', count: (n) => `${n} items` },
  });

  it('returns the table unchanged and picks a locale', () => {
    expect(getStrings(table, 'ko').title).toBe('제목');
    expect(getStrings(table, 'en').title).toBe('Title');
    expect(getStrings(table, 'ko').count(3)).toBe('3개');
    expect(getStrings(table, 'en').count(3)).toBe('3 items');
    expect(LOCALES).toEqual(['ko', 'en']);
  });

  it('rejects locales with different shapes at compile time', () => {
    // These calls are only checked by `tsc` (the directives fail the typecheck if a call stops being an error).
    // @ts-expect-error `en` lacks a key that `ko` has
    defineStrings({ ko: { a: 'x', b: 'y' }, en: { a: 'x' } });
    // @ts-expect-error `en` has a key that `ko` lacks
    defineStrings({ ko: { a: 'x' }, en: { a: 'x', b: 'y' } });
    // @ts-expect-error a string in one locale, a function in the other
    defineStrings({ ko: { a: 'x' }, en: { a: () => 'x' } });
    // @ts-expect-error function parameters must match
    defineStrings({ ko: { n: (count: number) => `${count}` }, en: { n: (count: string) => count } });
    // @ts-expect-error only strings and functions returning strings are allowed
    defineStrings({ ko: { n: 1 }, en: { n: 1 } });
    expect(true).toBe(true);
  });
});

describe('every shipped string table (docs/PLAN.md §7.4: ko and en with key parity)', () => {
  for (const [name, table] of Object.entries(TABLES)) {
    describe(name, () => {
      const { ko, en } = table;

      it('has the same keys in both languages', () => {
        expect(Object.keys(en).sort()).toEqual(Object.keys(ko).sort());
        expect(Object.keys(ko).length).toBeGreaterThan(0);
      });

      it('has the same kind of value for every key (string / function with the same number of parameters)', () => {
        for (const key of Object.keys(ko)) {
          expect(typeof en[key], key).toBe(typeof ko[key]);
          if (typeof ko[key] === 'function') expect((en[key] as (...args: never[]) => string).length, key).toBe((ko[key] as (...args: never[]) => string).length);
        }
      });

      it('has no empty, padded or untranslated text', () => {
        for (const key of Object.keys(ko)) {
          for (const [language, strings] of [['ko', ko], ['en', en]] as const) {
            const value = strings[key];
            if (typeof value !== 'string') continue;
            expect(value.trim(), `${language}.${key}`).not.toBe('');
            expect(value, `${language}.${key}`).toBe(value.trim());
          }
        }
      });

      it('the Korean text is Korean and the English text is not', () => {
        const hangul = /[가-힣]/;
        for (const key of Object.keys(ko)) {
          const korean = ko[key];
          const english = en[key];
          if (typeof korean !== 'string' || typeof english !== 'string') continue;
          // Names that are the same in every language (formats, "HTML", the app's "ZIP") are the exception.
          if (korean === english) continue;
          expect(hangul.test(english), `en.${key}`).toBe(false);
        }
      });
    });
  }

  it('the function strings produce text in both languages', () => {
    const t = popupStrings;
    const fmt = (n: number): string => String(n);
    expect(t.ko.startItem('채널')).toContain('채널');
    expect(t.en.startItem('channel')).toContain('channel');
    expect(t.ko.overallText(1, 4, 25, fmt)).toBe('1/4 · 25%');
    expect(t.en.overallText(1, 4, 25, fmt)).toBe('1/4 · 25%');
    expect(t.ko.progressCount(120, 200, fmt)).toBe('120 / 200개');
    expect(t.en.progressCount(120, 200, fmt)).toBe('120 / 200');
    expect(t.ko.progressCount(7, null, fmt)).toBe('7개');
    expect(t.en.progressCount(1, null, fmt)).toBe('1 message');
    expect(t.en.progressCount(7, null, fmt)).toBe('7 messages');
  });
});

describe('the strings of the queue tree (5th change): every key in both languages, with working plurals', () => {
  const ko = popupStrings.ko;
  const en = popupStrings.en;
  const fmt = (n: number): string => String(n);
  const KEYS = [
    'guildBadge',
    'categoryBadge',
    'guildBadgeTitle',
    'categoryBadgeTitle',
    'unknownServer',
    'unknownCategory',
    'groupCount',
    'groupCountAll',
    'groupCountTitle',
    'groupCountAllTitle',
    'overrideChip',
    'overrideChipTitle',
    'subtitleMore',
    'startGroup',
    'editGroup',
    'removeGroup',
    'removeGroupConfirm',
    'removeGroupYes',
    'removeGroupNo',
    'groupProgressLabel',
    'groupProgressText',
    'parentCommon',
    'parentGuild',
    'parentCategory',
    'editFollows',
    'editHasOwn',
    'editParentNow',
    'editRevert',
    'editRevertGuild',
    'editRevertCategory',
    'guildSettingsTitle',
    'categorySettingsTitle',
    'groupAppliesTo',
    'groupOverridesNotice',
    'groupNoteNew',
    'groupNoteOwn',
    'groupRevert',
    'groupRevertTitle',
    'groupMissing',
  ] as const;

  it('are all there, in Korean and in English', () => {
    for (const key of KEYS) {
      expect(ko[key], `ko.${key}`).toBeDefined();
      expect(en[key], `en.${key}`).toBeDefined();
    }
  });

  it('Korean: the words of docs/PLAN.md §7.2a', () => {
    expect(ko.guildBadge).toBe('서버 설정');
    expect(ko.categoryBadge).toBe('카테고리 설정');
    expect(ko.groupCount(3, fmt)).toBe('3개');
    expect(ko.groupCountAll(3, fmt)).toBe('전체 3개');
    expect(ko.overrideChip(2, fmt)).toBe('개별 2');
    expect(ko.removeGroupConfirm(7, fmt)).toBe('채널 7개를 목록에서 뺄까요?');
    expect(ko.guildSettingsTitle('샘플')).toBe('서버 설정 · 샘플');
    expect(ko.categorySettingsTitle('샘플')).toBe('카테고리 설정 · 샘플');
    expect(ko.groupAppliesTo(4, fmt)).toBe('채널 4개에 적용돼요');
    expect(ko.groupOverridesNotice(2, fmt)).toBe('아래 개별 설정 2개가 이 설정으로 바뀌어요');
    expect(ko.editRevert).toBe('공통 설정으로 되돌리기');
    expect(ko.editRevertGuild).toBe('서버 설정으로 되돌리기');
    expect(ko.editRevertCategory).toBe('카테고리 설정으로 되돌리기');
    expect(ko.groupRevert).toBe('상위 설정으로 되돌리기');
  });

  it('Korean: the parent\'s name takes the particle 을 (all three names end in a consonant)', () => {
    for (const parent of [ko.parentCommon, ko.parentGuild, ko.parentCategory]) {
      expect(ko.editFollows(parent)).toContain(`${parent}을 따라가요`);
      expect(ko.editHasOwn(parent)).toContain(`${parent}을 바꿔도`);
    }
    expect(ko.editParentNow(ko.parentGuild, '200개')).toBe('서버 설정: 200개');
  });

  it('English: singular and plural', () => {
    expect(en.groupCount(1, fmt)).toBe('1 chat');
    expect(en.groupCount(2, fmt)).toBe('2 chats');
    expect(en.groupCountAll(3, fmt)).toBe('All 3');
    expect(en.overrideChip(2, fmt)).toBe('2 own');
    expect(en.overrideChipTitle(1, fmt)).toBe('1 chat has settings of their own');
    expect(en.overrideChipTitle(2, fmt)).toBe('2 chats have settings of their own');
    expect(en.removeGroupConfirm(1, fmt)).toBe('Remove 1 chat from the list?');
    expect(en.removeGroupConfirm(7, fmt)).toBe('Remove 7 chats from the list?');
    expect(en.groupAppliesTo(1, fmt)).toBe('Applies to 1 chat');
    expect(en.groupAppliesTo(4, fmt)).toBe('Applies to 4 chats');
    expect(en.groupOverridesNotice(1, fmt)).toBe('1 setting of chats below will be replaced by these');
    expect(en.groupOverridesNotice(2, fmt)).toBe('2 settings of chats below will be replaced by these');
    expect(en.guildSettingsTitle('Sample')).toBe('Server settings · Sample');
    expect(en.categorySettingsTitle('Sample')).toBe('Category settings · Sample');
  });

  it('English: the sentence forms of the parent are lower case, the line that names it starts with a capital', () => {
    expect(en.editFollows(en.parentCategory)).toBe('This chat follows the category settings. Saving here gives it settings of its own.');
    expect(en.editHasOwn(en.parentGuild)).toBe('This chat has settings of its own. Changing the server settings does not affect it.');
    expect(en.editParentNow(en.parentCommon, '200 messages')).toBe('Common settings: 200 messages');
    expect(en.editRevertGuild).toBe('Reset to server settings');
    expect(en.editRevertCategory).toBe('Reset to category settings');
    expect(en.editRevert).toBe('Reset to common settings');
  });

  it('the names of the buttons of a group line are different from the ones of a chat row (so a test, and a screen reader, can tell them apart)', () => {
    for (const strings of [ko, en]) {
      expect(strings.startGroup('X')).not.toBe(strings.startItem('X'));
      expect(strings.editGroup('X')).toContain('X');
      expect(strings.removeGroup('X')).toContain('X');
      expect(strings.groupProgressLabel('X')).toContain('X');
    }
    // and "전체 다운로드" (the footer button) is not contained in any of them
    expect(ko.startGroup('X')).not.toContain('전체 다운로드');
  });

  it('the fallback names and the ellipsis of the subtitle', () => {
    expect(ko.unknownServer).toBe('서버');
    expect(ko.unknownCategory).toBe('카테고리');
    expect(en.unknownServer).toBe('Server');
    expect(en.unknownCategory).toBe('Category');
    expect(ko.subtitleMore).toBe('…');
    expect(en.subtitleMore).toBe('…');
  });
});

describe('resolveLocale', () => {
  it('an explicit preference wins over the browser language', () => {
    expect(resolveLocale('ko', 'en-US')).toBe('ko');
    expect(resolveLocale('en', 'ko-KR')).toBe('en');
  });

  it("'auto' maps ko* to Korean and any other known language to English", () => {
    for (const language of ['ko', 'ko-KR', 'KO', ' ko-kp ']) expect(resolveLocale('auto', language)).toBe('ko');
    for (const language of ['en-US', 'ja', 'de-DE', 'zh-CN']) expect(resolveLocale('auto', language)).toBe('en');
  });

  it("'auto' without any language information is Korean, the product default", () => {
    for (const language of ['', '  ', undefined, null]) expect(resolveLocale('auto', language)).toBe('ko');
  });
});

describe('resolveUiLocale (docs/PLAN.md §7.4: settings.language -> dce.theme lang -> chrome.i18n.getUILanguage())', () => {
  it('an explicit language setting wins over everything', () => {
    expect(resolveUiLocale('en', 'ko', 'ko-KR')).toBe('en');
    expect(resolveUiLocale('ko', 'en', 'en-US')).toBe('ko');
  });

  it("'auto' follows the Discord page language first", () => {
    expect(resolveUiLocale('auto', 'ko', 'en-US')).toBe('ko');
    expect(resolveUiLocale('auto', 'en-GB', 'ko-KR')).toBe('en');
    expect(resolveUiLocale('auto', 'ja', 'ko-KR')).toBe('en');
  });

  it("'auto' falls back to the browser UI language when the page language is missing or empty", () => {
    expect(resolveUiLocale('auto', undefined, 'en-US')).toBe('en');
    expect(resolveUiLocale('auto', null, 'ko')).toBe('ko');
    expect(resolveUiLocale('auto', '', 'en')).toBe('en');
    expect(resolveUiLocale('auto', '   ', 'ko-KR')).toBe('ko');
  });

  it("'auto' with nothing known is Korean", () => {
    expect(resolveUiLocale('auto', undefined, undefined)).toBe('ko');
    expect(resolveUiLocale('auto', '', '')).toBe('ko');
  });
});
