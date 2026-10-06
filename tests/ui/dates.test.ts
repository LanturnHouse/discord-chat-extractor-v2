import { describe, expect, it } from 'vitest';
import { checkRange, endOfDayIso, isInvertedRange, isoToDateInput, startOfDayIso } from '@/ui/format/dates';

// The expected instants are built from LOCAL date parts, so the tests hold in every time zone the suite runs in.
const local = (y: number, m: number, d: number, h: number, min: number, s: number, ms: number): string => new Date(y, m - 1, d, h, min, s, ms).toISOString();

describe('day bounds (docs/PLAN.md §5.1: start 00:00:00.000, end 23:59:59.999, local)', () => {
  it('startOfDayIso is the first millisecond of the local day', () => {
    expect(startOfDayIso('2026-03-05')).toBe(local(2026, 3, 5, 0, 0, 0, 0));
    const start = new Date(startOfDayIso('2026-03-05')!);
    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()]).toEqual([2026, 2, 5, 0, 0, 0, 0]);
  });

  it('endOfDayIso is the last millisecond of the local day', () => {
    expect(endOfDayIso('2026-03-05')).toBe(local(2026, 3, 5, 23, 59, 59, 999));
    const end = new Date(endOfDayIso('2026-03-05')!);
    expect([end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()]).toEqual([23, 59, 59, 999]);
  });

  it('the two bounds of one day are 24 hours minus 1 ms apart (DST days excepted)', () => {
    const span = Date.parse(endOfDayIso('2026-06-15')!) - Date.parse(startOfDayIso('2026-06-15')!);
    expect(span).toBeGreaterThanOrEqual(23 * 3_600_000);
    expect(span).toBeLessThanOrEqual(25 * 3_600_000);
  });

  it('empty, malformed and impossible days give null', () => {
    for (const value of ['', '2026-3-5', '26-03-05', 'abc', '2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31']) {
      expect(startOfDayIso(value), value).toBeNull();
      expect(endOfDayIso(value), value).toBeNull();
    }
  });

  it('a leap day exists only in a leap year', () => {
    expect(startOfDayIso('2028-02-29')).not.toBeNull();
    expect(startOfDayIso('2026-02-29')).toBeNull();
  });

  it('years below 100 are not mapped to 19xx', () => {
    expect(new Date(startOfDayIso('0050-01-01')!).getFullYear()).toBe(50);
  });
});

describe('isoToDateInput', () => {
  it('shows the local calendar day of an instant', () => {
    expect(isoToDateInput(local(2026, 3, 5, 0, 0, 0, 0))).toBe('2026-03-05');
    expect(isoToDateInput(local(2026, 3, 5, 23, 59, 59, 999))).toBe('2026-03-05');
  });

  it('round-trips with the day bounds', () => {
    expect(isoToDateInput(startOfDayIso('2026-12-31'))).toBe('2026-12-31');
    expect(isoToDateInput(endOfDayIso('2026-12-31'))).toBe('2026-12-31');
  });

  it('null and unparsable input give an empty field', () => {
    expect(isoToDateInput(null)).toBe('');
    expect(isoToDateInput('not a date')).toBe('');
  });

  it('pads the year to four digits', () => {
    expect(isoToDateInput(startOfDayIso('0050-01-01'))).toBe('0050-01-01');
  });
});

describe('ranges', () => {
  it('the same day is not inverted, a later start is', () => {
    expect(isInvertedRange('2026-03-05', '2026-03-05')).toBe(false);
    expect(isInvertedRange('2026-03-04', '2026-03-05')).toBe(false);
    expect(isInvertedRange('2026-03-06', '2026-03-05')).toBe(true);
  });

  it('an empty side is never inverted', () => {
    expect(isInvertedRange('', '2026-03-05')).toBe(false);
    expect(isInvertedRange('2026-03-05', '')).toBe(false);
  });

  it('checkRange: nothing wrong, an unfinished date, an impossible day, an inverted range', () => {
    const base = { from: '', to: '', fromPartial: false, toPartial: false };
    expect(checkRange(base)).toBeNull();
    expect(checkRange({ ...base, from: '2026-01-01', to: '2026-01-31' })).toBeNull();
    expect(checkRange({ ...base, fromPartial: true })).toEqual({ kind: 'invalid', from: true, to: false });
    expect(checkRange({ ...base, to: '2026-02-30' })).toEqual({ kind: 'invalid', from: false, to: true });
    expect(checkRange({ ...base, from: '2026-02-01', to: '2026-01-01' })).toEqual({ kind: 'inverted', from: true, to: true });
  });
});
