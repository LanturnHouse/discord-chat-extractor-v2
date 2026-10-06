import { describe, expect, it } from 'vitest';
import { failedStatusOf, isFailedStatus } from '@/popup/progress';

const failedBefore = { lastResult: { status: 'failed' as const, message: 'x', at: 1 } };
const clean = { lastResult: null };

describe('failedStatusOf: why a chat of the list did not finish (the chat rows and the group chips both ask this)', () => {
  it('the job\'s row wins when it says failed, partial or cancelled', () => {
    expect(failedStatusOf(clean, { status: 'failed' }, true)).toBe('failed');
    expect(failedStatusOf(clean, { status: 'partial' }, false)).toBe('partial');
    expect(failedStatusOf(failedBefore, { status: 'cancelled' }, true)).toBe('cancelled');
  });

  it('a chat that is part of the running job shows its progress, not an old failure', () => {
    expect(failedStatusOf(failedBefore, { status: 'running' }, true)).toBeNull();
    expect(failedStatusOf(failedBefore, { status: 'waiting' }, true)).toBeNull();
  });

  it('a chat that is not in the job (or no job is running) keeps what its last attempt left on it', () => {
    expect(failedStatusOf(failedBefore, undefined, true)).toBe('failed');
    expect(failedStatusOf(failedBefore, undefined, false)).toBe('failed');
    expect(failedStatusOf(failedBefore, { status: 'done' }, false)).toBe('failed');
    expect(failedStatusOf({ lastResult: undefined }, undefined, false)).toBeNull();
    expect(failedStatusOf(clean, { status: 'done' }, false)).toBeNull();
  });

  it('isFailedStatus: only the three states that stay in the list', () => {
    expect(['waiting', 'running', 'paused', 'done', 'partial', 'failed', 'cancelled'].filter((status) => isFailedStatus(status as never))).toEqual(['partial', 'failed', 'cancelled']);
  });
});
