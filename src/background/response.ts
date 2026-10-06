/** Builders for the `BgResponse` envelope every handler answers with (docs/PLAN.md §5.3). */
import type { BgError, BgResponse } from '@/shared';

export function ok(): BgResponse;
export function ok<T>(data: T): BgResponse<T>;
export function ok(data?: unknown): BgResponse<unknown> {
  return { ok: true, data };
}

export function fail(error: BgError, message?: string): BgResponse<never> {
  return message === undefined ? { ok: false, error } : { ok: false, error, message };
}

export const invalid = (message: string): BgResponse<never> => fail('invalid', message);
