/** Language and time zone of a job: the 'auto' settings resolved to concrete values (the engine gets no 'auto'). */
import { LOCAL } from '@/shared';
import type { AppSettings } from '@/shared';
import { getLocal } from './store';
import { isRecord } from './util';

export type Locale = 'ko' | 'en';

/**
 * 'ko' / 'en' as set. 'auto' follows the Discord page language that the content script stores in `LOCAL.theme.lang`
 * ('ko...' -> 'ko', anything else -> 'en'), and only without one the browser UI language (docs/PLAN.md §7.4: the same rule
 * the popup and the content script use, so the exported file speaks the language of the app).
 */
export async function resolveLocale(language: AppSettings['language']): Promise<Locale> {
  if (language === 'ko' || language === 'en') return language;
  const theme = await getLocal(LOCAL.theme);
  const pageLanguage = isRecord(theme) && typeof theme.lang === 'string' ? theme.lang.trim() : '';
  const source = pageLanguage !== '' ? pageLanguage : chrome.i18n.getUILanguage();
  return source.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

/** 'auto' becomes the browser's IANA zone; an explicit zone is passed through. */
export function resolveTimeZone(setting: string): string {
  return setting === 'auto' ? Intl.DateTimeFormat().resolvedOptions().timeZone : setting;
}
