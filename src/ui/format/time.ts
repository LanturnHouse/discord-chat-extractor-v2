import type { Locale } from '../i18n/core';

/** `settings.timeZone` as an `Intl` time zone: 'auto' (the browser's own) and unknown zone names are `undefined`. */
export function resolveTimeZone(setting: string): string | undefined {
  if (setting === 'auto' || setting.trim() === '') return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone: setting });
    return setting;
  } catch {
    return undefined;
  }
}

/** "2026. 10. 6. 오후 3:04" / "Oct 6, 2026, 3:04 PM" in the app language, in the time zone of the settings. */
export function formatDateTime(epochMs: number, locale: Locale, timeZone: string = 'auto'): string {
  const date = new Date(epochMs);
  if (!Number.isFinite(epochMs) || epochMs <= 0 || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale === 'ko' ? 'ko-KR' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: resolveTimeZone(timeZone),
  }).format(date);
}

/** An epoch time as an ISO string for `<time dateTime>`; undefined when it is not a valid date. */
export function toIsoString(epochMs: number): string | undefined {
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** The browser's own time zone ("Asia/Seoul"), '' when unknown. */
export function browserTimeZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

/** The IANA zones this browser knows, sorted ([] where `Intl.supportedValuesOf` does not exist). */
export function supportedTimeZones(): string[] {
  try {
    return [...Intl.supportedValuesOf('timeZone')].sort((a, b) => a.localeCompare(b, 'en'));
  } catch {
    return [];
  }
}
