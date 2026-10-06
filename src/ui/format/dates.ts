/*
 * The date range UI works with `<input type="date">` values ("2026-10-06", the user's calendar day) while the export settings
 * hold ISO instants (docs/PLAN.md §5.1). A day always means the user's LOCAL day: from = 00:00:00.000, to = 23:59:59.999.
 * (Ported from v1's topbar/dates.ts.)
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A local date-time on the given calendar day, or null when the day does not exist (2026-02-30). */
function localDate(value: string, hours: number, minutes: number, seconds: number, milliseconds: number): Date | null {
  const match = DATE_PATTERN.exec(value);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // `new Date(y, m, d)` maps the years 0-99 to 1900-1999; setFullYear does not.
  const date = new Date(2000, 0, 1);
  date.setFullYear(year, month - 1, day);
  date.setHours(hours, minutes, seconds, milliseconds);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

/** ISO instant of the start of the given local day (00:00:00.000), or null for an empty / invalid value. */
export function startOfDayIso(value: string): string | null {
  return localDate(value, 0, 0, 0, 0)?.toISOString() ?? null;
}

/** ISO instant of the very end (23:59:59.999) of the given local day, or null for an empty / invalid value. */
export function endOfDayIso(value: string): string | null {
  return localDate(value, 23, 59, 59, 999)?.toISOString() ?? null;
}

/** The local calendar day of an ISO instant as an `<input type="date">` value; '' for null / unparsable input. */
export function isoToDateInput(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** True when both days are valid and the start lies after the end (the same day is fine). Compares instants, not strings. */
export function isInvertedRange(from: string, to: string): boolean {
  const start = startOfDayIso(from);
  const end = endOfDayIso(to);
  return start !== null && end !== null && Date.parse(start) > Date.parse(end);
}

/** What the two date inputs currently show. `*Partial`: the user began typing a date that is not complete yet (the input's value is '' then). */
export interface RangeFields {
  from: string;
  to: string;
  fromPartial: boolean;
  toPartial: boolean;
}

/** `invalid`: a field holds something that is not a real day; `inverted`: both are days but the start is after the end. */
export interface RangeProblem {
  kind: 'invalid' | 'inverted';
  from: boolean;
  to: boolean;
}

/** Why the inputs cannot be exported as they are (null = they can, and an empty field means "no limit"). */
export function checkRange({ from, to, fromPartial, toPartial }: RangeFields): RangeProblem | null {
  const fromInvalid = fromPartial || (from !== '' && startOfDayIso(from) === null);
  const toInvalid = toPartial || (to !== '' && endOfDayIso(to) === null);
  if (fromInvalid || toInvalid) return { kind: 'invalid', from: fromInvalid, to: toInvalid };
  return isInvertedRange(from, to) ? { kind: 'inverted', from: true, to: true } : null;
}
