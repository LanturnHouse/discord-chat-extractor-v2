import type { Snowflake } from './types';

/** Discord epoch: 2015-01-01T00:00:00.000Z */
export const DISCORD_EPOCH = 1420070400000n;

/** Creation time (unix ms) encoded in a snowflake. */
export function snowflakeToTimestamp(id: Snowflake): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

/** Smallest snowflake for a given unix-ms time (useful as an `after` / `before` cursor for date ranges). */
export function timestampToSnowflake(ms: number): Snowflake {
  const rel = BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH;
  return (rel > 0n ? rel << 22n : 0n).toString();
}

/** Numeric comparison of decimal-string snowflakes without BigInt: shorter is smaller, otherwise lexicographic. */
export function compareSnowflakes(a: Snowflake, b: Snowflake): -1 | 0 | 1 {
  if (a === b) return 0;
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : 1;
}

/** Sort ascending (oldest first) by id. Returns a new array. */
export function sortByIdAsc<T extends { id: Snowflake }>(items: readonly T[]): T[] {
  return [...items].sort((x, y) => compareSnowflakes(x.id, y.id));
}

const DIGITS = /^\d+$/;

/** True for a plain decimal id (what `BigInt()` accepts without surprises: no sign, no hex, no whitespace). */
export function isSnowflake(value: unknown): value is Snowflake {
  return typeof value === 'string' && DIGITS.test(value);
}

/** `snowflakeToTimestamp` for ids that may not be plain decimal numbers (BigInt would throw on those): null for those. */
export function snowflakeTimeOrNull(id: unknown): number | null {
  return isSnowflake(id) ? snowflakeToTimestamp(id) : null;
}

/** The same id without leading zeros, so that string comparison is numeric (`compareSnowflakes` needs that). */
export function normalizeSnowflake(id: Snowflake): Snowflake {
  return BigInt(id).toString();
}
