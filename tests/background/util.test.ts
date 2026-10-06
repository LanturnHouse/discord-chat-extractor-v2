import { describe, expect, it } from 'vitest';
import { compareIds, createMutex, describeError, isNumericId, isRecord, maxId } from '@/background/util';
import { TOKEN } from './helpers';

describe('createMutex', () => {
  it('runs tasks one at a time, in call order', async () => {
    const mutex = createMutex();
    const log: string[] = [];
    const slow = mutex.run(async () => {
      log.push('slow start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      log.push('slow end');
    });
    const fast = mutex.run(() => {
      log.push('fast');
    });
    await Promise.all([slow, fast]);
    expect(log).toEqual(['slow start', 'slow end', 'fast']);
  });

  it('hands every caller its own result', async () => {
    const mutex = createMutex();
    const results = await Promise.all([mutex.run(() => 1), mutex.run(async () => 2), mutex.run(() => 3)]);
    expect(results).toEqual([1, 2, 3]);
  });

  it('a failing task rejects only its own caller and does not block the next', async () => {
    const mutex = createMutex();
    const failing = mutex.run(() => {
      throw new Error('boom');
    });
    const after = mutex.run(() => 'still runs');
    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBe('still runs');
  });

  it('a rejected async task does not poison the queue either', async () => {
    const mutex = createMutex();
    const failing = mutex.run(async () => {
      throw new Error('async boom');
    });
    await expect(failing).rejects.toThrow('async boom');
    await expect(mutex.run(() => 7)).resolves.toBe(7);
  });
});

describe('id helpers', () => {
  it('isNumericId accepts 1..20 digits in a string only', () => {
    for (const value of ['1', '123456789012345678', '18446744073709551615', '000123']) expect(isNumericId(value)).toBe(true);
    for (const value of ['', 'abc', '12a', '1 2', '-1', '1.5', '123456789012345678901', 123, null, undefined, {}, ['1']]) {
      expect(isNumericId(value)).toBe(false);
    }
  });

  it('compares snowflakes numerically, not as text', () => {
    expect(compareIds('9', '10')).toBe(-1);
    expect(compareIds('10', '9')).toBe(1);
    expect(compareIds('123456789012345678', '123456789012345678')).toBe(0);
    expect(compareIds('999999999999999999', '1000000000000000000')).toBe(-1);
  });

  it('maxId picks the larger id and treats null/undefined as nothing', () => {
    expect(maxId('9', '10')).toBe('10');
    expect(maxId('10', '9')).toBe('10');
    expect(maxId(undefined, '5')).toBe('5');
    expect(maxId('5', null)).toBe('5');
    expect(maxId(null, undefined)).toBeNull();
  });

  it('isRecord rejects arrays and null', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });
});

describe('describeError', () => {
  it('uses the message of an Error, a string as is, and a placeholder for anything else', () => {
    expect(describeError(new Error('disk full'))).toBe('disk full');
    expect(describeError('plain')).toBe('plain');
    expect(describeError({ weird: true })).toBe('unknown error');
    expect(describeError(undefined)).toBe('unknown error');
  });

  it('replaces anything that looks like an authorization value', () => {
    const text = describeError(new Error(`request failed for ${TOKEN} (status 401)`));
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('MTIzNDU2');
    expect(text).toContain('[redacted]');
    expect(text).toContain('status 401');
  });

  it('cuts long text', () => {
    expect(describeError(new Error('word '.repeat(200))).length).toBe(200);
    expect(describeError(new Error('abc def ghi'), 5)).toBe('abc d');
  });
});
