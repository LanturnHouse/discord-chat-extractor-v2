import { describe, expect, it } from 'vitest';
import { LANGS, resolveLang, strings } from '@/content/i18n';

describe('strings', () => {
  it('ko and en have the same keys, of the same kind (text or function)', () => {
    expect(Object.keys(strings.en).sort()).toEqual(Object.keys(strings.ko).sort());
    for (const key of Object.keys(strings.ko) as (keyof typeof strings.ko)[]) {
      expect(typeof strings.en[key], key).toBe(typeof strings.ko[key]);
    }
  });

  it('no string is empty, and the functions return text', () => {
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(strings[lang])) {
        const text = typeof value === 'function' ? (value as (n: number) => string)(3) : value;
        expect(typeof text, `${lang}.${key}`).toBe('string');
        expect(text.trim(), `${lang}.${key}`).not.toBe('');
      }
    }
  });

  it('the texts of the plan (PLAN §7.1), word for word', () => {
    expect(strings.ko.tooltipAdd).toBe('다운로드 목록에 추가');
    expect(strings.ko.tooltipRemove).toBe('다운로드 목록에서 빼기');
    expect(strings.ko.tooltipCategory).toBe('이 카테고리 채널 전부 추가');
    expect(strings.ko.toastAdded).toBe('다운로드 목록에 추가했어요 · 공통 설정');
    expect(strings.ko.toastRemoved).toBe('목록에서 뺐어요');
    expect(strings.ko.toastCategoryAdded(7)).toBe('채널 7개를 추가했어요');
    expect(strings.ko.toastNoAccount).toBe('디스코드 계정을 확인하는 중이에요. 잠시 후 다시 눌러 주세요');
  });

  it('the texts of the server button (PLAN §7.1), word for word, in both languages', () => {
    expect(strings.ko.tooltipGuild).toBe('이 서버 채널 전부 추가');
    expect(strings.en.tooltipGuild).toBe('Add every channel in this server');
    expect(strings.ko.toastGuildNothing).toBe('추가할 채널이 없어요 (이미 모두 목록에 있어요)');
    expect(strings.en.toastGuildNothing).toBe('Nothing to add (every channel is already in the list)');
    // "channels were added" is the same sentence as the category button's
    expect(strings.ko.toastCategoryAdded(12)).toBe('채널 12개를 추가했어요');
    expect(strings.en.toastCategoryAdded(12)).toBe('Added 12 channels');
    // a server without anything to add reads differently from an empty category
    expect(strings.ko.toastEmptyGuild).toBe('이 서버에는 담을 채널이 없어요');
    expect(strings.en.toastEmptyGuild).toBe('This server has no channels to add');
    expect(strings.ko.toastEmptyGuild).not.toBe(strings.ko.toastEmpty);
    expect(strings.en.toastEmptyGuild).not.toBe(strings.en.toastEmpty);
  });

  it('the category and server buttons are toggles: add / remove texts for the tooltip and the label (PLAN §2, §7.1), both languages', () => {
    expect(strings.ko.tooltipCategory).toBe('이 카테고리 채널 전부 추가');
    expect(strings.ko.tooltipCategoryRemove).toBe('이 카테고리 채널 전부 빼기');
    expect(strings.ko.tooltipGuild).toBe('이 서버 채널 전부 추가');
    expect(strings.ko.tooltipGuildRemove).toBe('이 서버 채널 전부 빼기');
    expect(strings.en.tooltipCategory).toBe('Add every channel in this category');
    expect(strings.en.tooltipCategoryRemove).toBe('Remove every channel in this category');
    expect(strings.en.tooltipGuild).toBe('Add every channel in this server');
    expect(strings.en.tooltipGuildRemove).toBe('Remove every channel in this server');
  });

  it('the toast for removed channels (PLAN §7.1), word for word', () => {
    expect(strings.ko.toastCategoryRemoved(5)).toBe('채널 5개를 목록에서 뺐어요');
    expect(strings.en.toastCategoryRemoved(5)).toBe('Removed 5 channels from the list');
  });

  it('English counts: one channel / many', () => {
    expect(strings.en.toastCategoryAdded(1)).toBe('Added 1 channel');
    expect(strings.en.toastCategoryAdded(2)).toBe('Added 2 channels');
    expect(strings.en.toastCategoryAdded(40)).toBe('Added 40 channels');
    expect(strings.en.toastCategoryRemoved(1)).toBe('Removed 1 channel from the list');
    expect(strings.en.toastCategoryRemoved(2)).toBe('Removed 2 channels from the list');
    expect(strings.en.toastCategoryRemoved(40)).toBe('Removed 40 channels from the list');
  });

  it('never put technical detail in front of the user (no HTTP codes, paths or API words)', () => {
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(strings[lang])) {
        const text = typeof value === 'function' ? (value as (n: number) => string)(2) : value;
        expect(text, `${lang}.${key}`).not.toMatch(/\b(?:HTTP|API|token|403|401|429)\b|\/api/i);
      }
    }
  });
});

describe('resolveLang (PLAN §7.4)', () => {
  it('an explicit setting always wins', () => {
    expect(resolveLang('ko', 'en-US', 'en')).toBe('ko');
    expect(resolveLang('en', 'ko', 'ko')).toBe('en');
  });

  it('auto follows the page language (<html lang>), then the browser UI language', () => {
    expect(resolveLang('auto', 'ko', 'en')).toBe('ko');
    expect(resolveLang('auto', 'en-US', 'ko')).toBe('en');
    expect(resolveLang('auto', 'ja', 'ko')).toBe('en'); // any other language: English
    expect(resolveLang('auto', '', 'ko-KR')).toBe('ko');
    expect(resolveLang('auto', null, 'en-GB')).toBe('en');
    expect(resolveLang('auto', undefined, undefined)).toBe('ko'); // the product default
    expect(resolveLang('auto', '', '')).toBe('ko');
    expect(resolveLang('auto', ' KO ', '')).toBe('ko');
  });
});
