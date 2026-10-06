/**
 * Small helpers shared by the background modules: an async mutex, error text that is safe to hand to other contexts, and
 * the id check every message validator uses. No chrome.* access here.
 */

/**
 * A FIFO async mutex. Tasks run one at a time in call order; a task that throws does not block the ones queued behind it
 * (the caller of the failing task still sees the error).
 *
 * The service worker is the only writer of the extension's storage, but its message handlers are async and interleave at
 * every `await`, so every read-modify-write of a storage key goes through one of these (see store.ts for the lock order).
 */
export interface Mutex {
  run<T>(task: () => Promise<T> | T): Promise<T>;
}

export function createMutex(): Mutex {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T> | T): Promise<T> {
      const result = tail.then(task);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A Discord snowflake as it travels in JSON: a string of digits (1..20 of them: a u64 has at most 20). */
export const isNumericId = (value: unknown): value is string => typeof value === 'string' && /^\d{1,20}$/.test(value);

/** Runs of token-like characters (the authorization value is a ~70 character `[A-Za-z0-9._-]` string). */
const TOKEN_LIKE = /[A-Za-z0-9_.-]{24,}/g;

/**
 * Text of an error that may be shown to the popup or logged. The authorization value never appears in an error the worker
 * builds itself; this is the safety net for messages that come from elsewhere (fetch, chrome.*): anything that looks like a
 * token (a long run of token characters) is replaced, and the text is cut to `max` characters.
 */
export function describeError(error: unknown, max = 200): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';
  return raw.replace(TOKEN_LIKE, '[redacted]').slice(0, max);
}

/** Compares two snowflakes numerically (`a > b` as strings of different length would sort wrongly). */
export function compareIds(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The larger of two snowflakes; `null`/`undefined` count as "none". */
export function maxId(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return compareIds(a, b) >= 0 ? a : b;
}
