import { dayKey, formatClock, timestampMs, type MessageLocale } from '../../../message';

/** Value for `<time datetime>`; undefined for an unparsable timestamp (the attribute is then left out). */
export function dateTimeAttr(iso: string | null | undefined): string | undefined {
  const ms = timestampMs(iso);
  return ms === null ? undefined : new Date(ms).toISOString();
}

/**
 * Timestamp next to an author name: short numeric date plus the clock, e.g. "10/06/2026 3:04 PM" /
 * "2026. 10. 06. 오후 3:04". Built from the memoised day key and clock text, so no Intl object is created per message.
 * '' for an unparsable timestamp.
 */
export function headerTimestamp(iso: string, timeZone: string, locale: MessageLocale): string {
  const day = dayKey(iso, timeZone);
  if (day === '') return '';
  const [year, month, date] = day.split('-');
  const clock = formatClock(iso, timeZone, locale);
  return locale === 'ko' ? `${year}. ${month}. ${date}. ${clock}` : `${month}/${date}/${year} ${clock}`;
}
