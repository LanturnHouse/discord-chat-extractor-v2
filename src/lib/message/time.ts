import { getStrings, type MessageLocale } from './strings';

/**
 * Time-zone aware formatting for message lists (thousands of calls per render).
 *
 * Intl is used for the one thing only it can do — resolving an instant to wall-clock fields in an IANA zone
 * (DST included). One Intl.DateTimeFormat is built per zone and memoised. Locale-specific text (month/weekday
 * names, AM/PM, word order) comes from `strings.ts` so it never depends on the ICU build.
 * Resolved fields are cached per (zone, timestamp) because the UI asks for clock, day key and day label of the
 * same message several times.
 *
 * Every function is total: an unparsable timestamp yields '' (or false), never an exception.
 */

interface Fields {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

const FALLBACK_ZONE = 'UTC';
const formatters = new Map<string, Intl.DateTimeFormat>();

function createFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    try {
      formatter = createFormatter(timeZone);
    } catch {
      // Unknown IANA name: fall back to UTC so the output is at least deterministic.
      formatter = formatterFor(FALLBACK_ZONE);
    }
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

const CACHE_LIMIT = 4096;
const fieldCache = new Map<string, Fields | null>();

/** Epoch milliseconds of an ISO-8601 timestamp, or null when it does not parse. */
export function timestampMs(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function fieldsOf(iso: string, timeZone: string): Fields | null {
  const key = `${timeZone}\n${iso}`;
  const cached = fieldCache.get(key);
  if (cached !== undefined) return cached;

  const ms = timestampMs(iso);
  let fields: Fields | null = null;
  if (ms !== null) {
    const out: Fields = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
    for (const part of formatterFor(timeZone).formatToParts(ms)) {
      const value = Number(part.value);
      switch (part.type) {
        case 'year':
          out.year = value;
          break;
        case 'month':
          out.month = value;
          break;
        case 'day':
          out.day = value;
          break;
        case 'hour':
          out.hour = value % 24; // some ICU builds still report midnight as 24
          break;
        case 'minute':
          out.minute = value;
          break;
        case 'second':
          out.second = value;
          break;
        default:
          break;
      }
    }
    fields = out;
  }
  if (fieldCache.size >= CACHE_LIMIT) fieldCache.clear();
  fieldCache.set(key, fields);
  return fields;
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));
const pad4 = (n: number): string => String(n).padStart(4, '0');

/** 0 = Sunday. Sakamoto's algorithm: pure arithmetic, no Date object. */
function weekdayOf(year: number, month: number, day: number): number {
  const offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const y = month < 3 ? year - 1 : year;
  return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + offsets[month - 1]! + day) % 7;
}

function clockText(f: Fields, locale: MessageLocale): string {
  const s = getStrings(locale);
  const hour12 = f.hour % 12 || 12;
  const period = f.hour < 12 ? s.am : s.pm;
  const time = `${hour12}:${pad2(f.minute)}`;
  return locale === 'ko' ? `${period} ${time}` : `${time} ${period}`;
}

function dayText(f: Fields, locale: MessageLocale): string {
  if (locale === 'ko') return `${f.year}년 ${f.month}월 ${f.day}일`;
  return `${getStrings(locale).months[f.month - 1]} ${f.day}, ${f.year}`;
}

/** "오후 3:04" / "3:04 PM" */
export function formatClock(iso: string, tz: string, locale: MessageLocale): string {
  const f = fieldsOf(iso, tz);
  return f ? clockText(f, locale === 'ko' ? 'ko' : 'en') : '';
}

/** 'YYYY-MM-DD HH:mm:ss', 24h, zero padded. Locale-independent on purpose (exports, sorting, diffing). */
export function formatDateTime(iso: string, tz: string, _locale?: MessageLocale): string {
  const f = fieldsOf(iso, tz);
  if (!f) return '';
  return `${pad4(f.year)}-${pad2(f.month)}-${pad2(f.day)} ${pad2(f.hour)}:${pad2(f.minute)}:${pad2(f.second)}`;
}

/** "2026년 10월 6일" / "October 6, 2026" */
export function formatDayLabel(iso: string, tz: string, locale: MessageLocale): string {
  const f = fieldsOf(iso, tz);
  return f ? dayText(f, locale === 'ko' ? 'ko' : 'en') : '';
}

/** "2026년 10월 6일 화요일 오후 3:04" / "Tuesday, October 6, 2026 at 3:04 PM" */
export function formatFullTooltip(iso: string, tz: string, locale: MessageLocale): string {
  const f = fieldsOf(iso, tz);
  if (!f) return '';
  const loc: MessageLocale = locale === 'ko' ? 'ko' : 'en';
  const weekday = getStrings(loc).weekdays[weekdayOf(f.year, f.month, f.day)]!;
  const clock = clockText(f, loc);
  return loc === 'ko' ? `${dayText(f, loc)} ${weekday} ${clock}` : `${weekday}, ${dayText(f, loc)} at ${clock}`;
}

/** 'YYYY-MM-DD' of the instant in `tz`; '' for an unparsable timestamp. */
export function dayKey(iso: string, tz: string): string {
  const f = fieldsOf(iso, tz);
  return f ? `${pad4(f.year)}-${pad2(f.month)}-${pad2(f.day)}` : '';
}

export function isSameDay(aIso: string, bIso: string, tz: string): boolean {
  const a = dayKey(aIso, tz);
  return a !== '' && a === dayKey(bIso, tz);
}
