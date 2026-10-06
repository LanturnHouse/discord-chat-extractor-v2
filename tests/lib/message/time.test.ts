import { describe, expect, it } from 'vitest';
import {
  dayKey,
  formatClock,
  formatDateTime,
  formatDayLabel,
  formatFullTooltip,
  isSameDay,
  timestampMs,
} from '@/lib/message';
import { expectLinearScaling } from '../export/scaling';

const SEOUL = 'Asia/Seoul';
const NY = 'America/New_York';

describe('formatClock', () => {
  it('formats Korean and English 12-hour clocks in the given zone', () => {
    const iso = '2026-10-06T06:04:00.000000+00:00'; // 15:04 in Seoul, 02:04 in New York (EDT)
    expect(formatClock(iso, SEOUL, 'ko')).toBe('오후 3:04');
    expect(formatClock(iso, SEOUL, 'en')).toBe('3:04 PM');
    expect(formatClock(iso, NY, 'ko')).toBe('오전 2:04');
    expect(formatClock(iso, NY, 'en')).toBe('2:04 AM');
  });

  it('uses a plain ASCII space before AM/PM (no ICU narrow no-break space)', () => {
    expect(formatClock('2026-10-06T06:04:00Z', SEOUL, 'en')).toMatch(/^3:04 PM$/);
  });

  it('shows midnight and noon as 12', () => {
    expect(formatClock('2026-10-06T15:00:00Z', SEOUL, 'en')).toBe('12:00 AM');
    expect(formatClock('2026-10-06T15:00:00Z', SEOUL, 'ko')).toBe('오전 12:00');
    expect(formatClock('2026-10-06T03:00:00Z', SEOUL, 'en')).toBe('12:00 PM');
    expect(formatClock('2026-10-06T03:00:00Z', SEOUL, 'ko')).toBe('오후 12:00');
    expect(formatClock('2026-10-06T03:09:00Z', SEOUL, 'en')).toBe('12:09 PM');
  });

  it('honours the offset written in the ISO string', () => {
    expect(formatClock('2026-10-06T15:04:00+09:00', SEOUL, 'en')).toBe('3:04 PM');
    expect(formatClock('2026-10-06T15:04:00+09:00', 'UTC', 'en')).toBe('6:04 AM');
  });
});

describe('formatDateTime', () => {
  it('is YYYY-MM-DD HH:mm:ss in 24h, zero padded, regardless of locale', () => {
    expect(formatDateTime('2026-01-02T03:04:05Z', 'UTC', 'ko')).toBe('2026-01-02 03:04:05');
    expect(formatDateTime('2026-01-02T03:04:05Z', 'UTC', 'en')).toBe('2026-01-02 03:04:05');
  });

  it('is zone aware', () => {
    expect(formatDateTime('2026-10-06T06:04:12.123456+00:00', SEOUL, 'en')).toBe('2026-10-06 15:04:12');
    expect(formatDateTime('2026-10-06T06:04:12.123456+00:00', NY, 'en')).toBe('2026-10-06 02:04:12');
  });

  it('never prints hour 24 at midnight', () => {
    expect(formatDateTime('2026-10-06T15:00:00Z', SEOUL, 'en')).toBe('2026-10-07 00:00:00');
    expect(formatDateTime('2026-10-06T14:59:59Z', SEOUL, 'en')).toBe('2026-10-06 23:59:59');
    expect(formatDateTime('2026-10-07T04:00:00Z', NY, 'en')).toBe('2026-10-07 00:00:00');
  });

  it('handles the New York spring-forward gap (2026-03-08 02:00 -> 03:00)', () => {
    expect(formatDateTime('2026-03-08T06:59:59Z', NY, 'en')).toBe('2026-03-08 01:59:59');
    expect(formatDateTime('2026-03-08T07:00:00Z', NY, 'en')).toBe('2026-03-08 03:00:00');
    expect(formatClock('2026-03-08T07:00:00Z', NY, 'en')).toBe('3:00 AM');
  });

  it('handles the New York fall-back repeat (2026-11-01 01:30 happens twice)', () => {
    expect(formatDateTime('2026-11-01T05:30:00Z', NY, 'en')).toBe('2026-11-01 01:30:00'); // EDT
    expect(formatDateTime('2026-11-01T06:30:00Z', NY, 'en')).toBe('2026-11-01 01:30:00'); // EST
    expect(formatDateTime('2026-11-01T07:00:00Z', NY, 'en')).toBe('2026-11-01 02:00:00');
    expect(isSameDay('2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', NY)).toBe(true);
  });

  it('keeps a 25-hour fall-back day as one day and a 23-hour spring day as one day', () => {
    expect(dayKey('2026-11-01T04:00:00Z', NY)).toBe('2026-11-01'); // 00:00 EDT
    expect(dayKey('2026-11-02T04:59:59Z', NY)).toBe('2026-11-01'); // 23:59:59 EST
    expect(dayKey('2026-11-02T05:00:00Z', NY)).toBe('2026-11-02');
    expect(dayKey('2026-03-08T04:59:59Z', NY)).toBe('2026-03-07');
    expect(dayKey('2026-03-08T05:00:00Z', NY)).toBe('2026-03-08');
    expect(dayKey('2026-03-09T03:59:59Z', NY)).toBe('2026-03-08'); // 23:59:59 EDT
    expect(dayKey('2026-03-09T04:00:00Z', NY)).toBe('2026-03-09');
  });

  it('does not shift Asia/Seoul across the year (no DST)', () => {
    expect(formatClock('2026-01-15T00:00:00Z', SEOUL, 'en')).toBe('9:00 AM');
    expect(formatClock('2026-07-15T00:00:00Z', SEOUL, 'en')).toBe('9:00 AM');
  });
});

describe('dayKey / isSameDay', () => {
  it('flips exactly at local midnight in Seoul', () => {
    expect(dayKey('2026-10-06T14:59:59.999Z', SEOUL)).toBe('2026-10-06');
    expect(dayKey('2026-10-06T15:00:00.000Z', SEOUL)).toBe('2026-10-07');
  });

  it('flips exactly at local midnight in New York (EDT, UTC-4)', () => {
    expect(dayKey('2026-10-07T03:59:59.999Z', NY)).toBe('2026-10-06');
    expect(dayKey('2026-10-07T04:00:00.000Z', NY)).toBe('2026-10-07');
  });

  it('crosses year and leap-day boundaries correctly', () => {
    expect(dayKey('2026-12-31T14:59:59Z', SEOUL)).toBe('2026-12-31');
    expect(dayKey('2026-12-31T15:00:00Z', SEOUL)).toBe('2027-01-01');
    expect(dayKey('2028-02-28T15:00:00Z', SEOUL)).toBe('2028-02-29');
    expect(dayKey('2028-02-29T15:00:00Z', SEOUL)).toBe('2028-03-01');
  });

  it('isSameDay depends on the zone', () => {
    const a = '2026-10-06T14:58:00Z';
    const b = '2026-10-06T15:01:00Z';
    expect(isSameDay(a, b, 'UTC')).toBe(true);
    expect(isSameDay(a, b, SEOUL)).toBe(false);
  });
});

describe('formatDayLabel / formatFullTooltip', () => {
  it('formats the day divider in both languages', () => {
    expect(formatDayLabel('2026-10-06T06:00:00Z', SEOUL, 'ko')).toBe('2026년 10월 6일');
    expect(formatDayLabel('2026-10-06T06:00:00Z', SEOUL, 'en')).toBe('October 6, 2026');
    expect(formatDayLabel('2026-01-05T00:00:00Z', 'UTC', 'en')).toBe('January 5, 2026');
  });

  it('uses the zone for the day label', () => {
    expect(formatDayLabel('2026-10-06T15:30:00Z', SEOUL, 'en')).toBe('October 7, 2026');
    expect(formatDayLabel('2026-10-06T15:30:00Z', NY, 'en')).toBe('October 6, 2026');
  });

  it('formats the full tooltip with the weekday', () => {
    expect(formatFullTooltip('2026-10-06T06:04:00Z', SEOUL, 'ko')).toBe('2026년 10월 6일 화요일 오후 3:04');
    expect(formatFullTooltip('2026-10-06T06:04:00Z', SEOUL, 'en')).toBe('Tuesday, October 6, 2026 at 3:04 PM');
  });

  it('computes every weekday correctly (cross-checked against Date over 20 years)', () => {
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const start = Date.UTC(2015, 0, 1, 12);
    for (let day = 0; day < 365 * 20 + 5; day += 1) {
      const ms = start + day * 86_400_000;
      const expected = names[new Date(ms).getUTCDay()]!;
      expect(formatFullTooltip(new Date(ms).toISOString(), 'UTC', 'en').startsWith(`${expected},`)).toBe(true);
    }
  });
});

describe('robustness', () => {
  it('returns empty output for unparsable or missing timestamps instead of throwing', () => {
    for (const bad of ['', 'not a date', '2026-13-45T99:99:99Z']) {
      expect(formatClock(bad, SEOUL, 'ko')).toBe('');
      expect(formatDateTime(bad, SEOUL, 'ko')).toBe('');
      expect(formatDayLabel(bad, SEOUL, 'en')).toBe('');
      expect(formatFullTooltip(bad, SEOUL, 'en')).toBe('');
      expect(dayKey(bad, SEOUL)).toBe('');
      expect(isSameDay(bad, bad, SEOUL)).toBe(false);
    }
    expect(formatClock(undefined as unknown as string, SEOUL, 'ko')).toBe('');
    expect(timestampMs(undefined)).toBeNull();
    expect(timestampMs('2026-10-06T00:00:00Z')).toBe(Date.UTC(2026, 9, 6));
  });

  it('falls back to UTC for an unknown time zone', () => {
    expect(formatDateTime('2026-10-06T06:04:00Z', 'Mars/Olympus', 'en')).toBe('2026-10-06 06:04:00');
  });

  it('falls back to English for an unexpected locale value', () => {
    expect(formatClock('2026-10-06T06:04:00Z', SEOUL, 'fr' as unknown as 'en')).toBe('3:04 PM');
  });

  it('accepts Discord microsecond timestamps', () => {
    expect(formatDateTime('2026-10-06T06:04:12.999999+00:00', 'UTC', 'en')).toBe('2026-10-06 06:04:12');
  });
});

describe('memoisation and speed', () => {
  it('builds one Intl.DateTimeFormat per zone, however many calls and locales', () => {
    const zone = 'Pacific/Auckland'; // not used by any other test, so its formatter does not exist yet
    const Original = Intl.DateTimeFormat;
    let built = 0;
    class Counting extends Original {
      constructor(...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
        super(...args);
        if ((args[1] as Intl.DateTimeFormatOptions | undefined)?.timeZone === zone) built += 1;
      }
    }
    Intl.DateTimeFormat = Counting as unknown as typeof Intl.DateTimeFormat;
    try {
      for (let i = 0; i < 500; i += 1) {
        const iso = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
        formatClock(iso, zone, 'ko');
        formatClock(iso, zone, 'en');
        formatDateTime(iso, zone, 'en');
        formatDayLabel(iso, zone, 'ko');
        formatFullTooltip(iso, zone, 'en');
        dayKey(iso, zone);
      }
    } finally {
      Intl.DateTimeFormat = Original;
    }
    expect(built).toBe(1);
  });

  it('formats 30,000 distinct timestamps in time proportional to their number', () => {
    const base = Date.UTC(2026, 0, 1);
    let run = 0;
    expectLinearScaling(
      (count) => {
        // Every run uses timestamps that no earlier run has seen: repeated ones would come out of the field cache,
        // which would make the small baseline cheaper per item than the large run.
        const from = base + run * 100_000_000_000;
        run += 1;
        for (let i = 0; i < count; i += 1) formatDateTime(new Date(from + i * 61_000).toISOString(), NY, 'en');
      },
      { small: 3_000, large: 30_000 },
    );
  });
});
