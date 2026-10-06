import { describe, expect, it } from 'vitest';
import {
  DISCORD_EPOCH,
  compareSnowflakes,
  isSnowflake,
  normalizeSnowflake,
  snowflakeTimeOrNull,
  snowflakeToTimestamp,
  sortByIdAsc,
  timestampToSnowflake,
} from '@/lib/discord/snowflake';

describe('snowflakeToTimestamp', () => {
  it("decodes the example from Discord's documentation", () => {
    expect(snowflakeToTimestamp('175928847299117063')).toBe(1462015105796);
  });

  it('decodes the Discord epoch itself', () => {
    expect(snowflakeToTimestamp('0')).toBe(Number(DISCORD_EPOCH));
  });

  it('is exact for ids above 2^53 (no float precision loss)', () => {
    const id = '1234567890123456789';
    expect(Number(id).toString()).not.toBe(id); // the id really is not representable as a double
    expect(snowflakeToTimestamp(id)).toBe(Number((1234567890123456789n >> 22n) + DISCORD_EPOCH));
  });
});

describe('timestampToSnowflake', () => {
  it('round-trips with snowflakeToTimestamp', () => {
    for (const ms of [1462015105796, Date.UTC(2020, 5, 17, 12, 30, 15, 123), Date.UTC(2026, 9, 6)]) {
      expect(snowflakeToTimestamp(timestampToSnowflake(ms))).toBe(ms);
    }
  });

  it('clamps times at or before the Discord epoch to "0"', () => {
    expect(timestampToSnowflake(Number(DISCORD_EPOCH))).toBe('0');
    expect(timestampToSnowflake(0)).toBe('0');
    expect(timestampToSnowflake(-5)).toBe('0');
  });

  it('floors fractional milliseconds', () => {
    expect(timestampToSnowflake(1462015105796.9)).toBe(timestampToSnowflake(1462015105796));
  });

  it('produces the smallest id of that millisecond (all low bits zero)', () => {
    expect(BigInt(timestampToSnowflake(1462015105796)) & 0x3fffffn).toBe(0n);
    expect(compareSnowflakes(timestampToSnowflake(1462015105796), '175928847299117063')).toBe(-1);
  });
});

describe('compareSnowflakes', () => {
  it('compares numerically even when lengths differ', () => {
    expect(compareSnowflakes('999999999999999999', '1000000000000000000')).toBe(-1);
    expect(compareSnowflakes('1000000000000000000', '999999999999999999')).toBe(1);
    expect(compareSnowflakes('9', '10')).toBe(-1);
  });

  it('compares equal-length ids lexicographically', () => {
    expect(compareSnowflakes('175928847299117063', '175928847299117064')).toBe(-1);
    expect(compareSnowflakes('275928847299117063', '175928847299117064')).toBe(1);
  });

  it('returns 0 for identical ids', () => {
    expect(compareSnowflakes('42', '42')).toBe(0);
  });
});

describe('sortByIdAsc', () => {
  const items = [{ id: '1000000000000000000' }, { id: '999999999999999999' }, { id: '1000000000000000001' }];

  it('sorts oldest first without mutating the input', () => {
    const before = items.map((i) => i.id);
    expect(sortByIdAsc(items).map((i) => i.id)).toEqual(['999999999999999999', '1000000000000000000', '1000000000000000001']);
    expect(items.map((i) => i.id)).toEqual(before);
  });

  it('handles empty and single-element arrays', () => {
    expect(sortByIdAsc([])).toEqual([]);
    expect(sortByIdAsc([{ id: '5' }])).toEqual([{ id: '5' }]);
  });
});

describe('isSnowflake', () => {
  it.each(['0', '1', '175928847299117063', '000123', '1'.repeat(30)])('accepts the plain decimal id %s', (id) => {
    expect(isSnowflake(id)).toBe(true);
  });

  it.each(['', ' 1', '1 ', '-1', '+1', '1.5', '1e5', '0x10', 'abc', '１２３', 123, null, undefined, {}])('rejects %j', (value) => {
    expect(isSnowflake(value)).toBe(false);
  });
});

describe('snowflakeTimeOrNull', () => {
  it('is the creation time for a numeric id and null for anything BigInt would choke on', () => {
    expect(snowflakeTimeOrNull('175928847299117063')).toBe(1462015105796);
    expect(snowflakeTimeOrNull('abc')).toBeNull();
    expect(snowflakeTimeOrNull('')).toBeNull();
    expect(snowflakeTimeOrNull(null)).toBeNull();
    expect(snowflakeTimeOrNull(5)).toBeNull();
  });
});

describe('normalizeSnowflake', () => {
  it('strips leading zeros so that string comparison is numeric', () => {
    expect(normalizeSnowflake('000123')).toBe('123');
    expect(normalizeSnowflake('0')).toBe('0');
    expect(normalizeSnowflake('175928847299117063')).toBe('175928847299117063');
    expect(compareSnowflakes(normalizeSnowflake('0009'), '10')).toBe(-1);
  });
});
