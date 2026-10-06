import { DiscordApiError } from './client';

/** Longest single wait (429 `retry_after`, block-page back-off) we are willing to sit through. Longer => fail with 'rate-limited'. */
export const MAX_RATE_LIMIT_WAIT_MS = 5 * 60_000;
/**
 * A 429 that asks for more than this is not a per-route bucket (Discord's own buckets reset within seconds): it is an IP /
 * Cloudflare style ban that applies to every route, so it holds the whole client instead of letting each other route send
 * one more request into the ban.
 */
export const GLOBAL_HOLD_THRESHOLD_MS = 60_000;
/** How many times a request that got HTTP 429 is retried before giving up. */
export const MAX_RATE_LIMIT_RETRIES = 6;
/** Retries for 5xx responses and network errors. */
export const MAX_TRANSIENT_RETRIES = 3;
/**
 * A 400 / 403 without a JSON error body (a Cloudflare / anti-abuse page) is retried after each of these waits, in order,
 * and reported as 'blocked' when the last retry is answered the same way (docs/PLAN.md §6.2).
 */
export const BLOCKED_RETRY_WAITS_MS: readonly number[] = Object.freeze([30_000, 60_000, 120_000]);

/** Used when a 429 carries no usable wait hint at all. */
const FALLBACK_RETRY_AFTER_MS = 1_000;
const MAX_TRACKED_BUCKETS = 256;
const MAX_TRACKED_ROUTES = 2_048;

/** A range of waiting times; the actual wait is drawn uniformly from it. */
export interface GapRange {
  minMs: number;
  maxMs: number;
}

/** Pause between two consecutive message-page requests (docs/PLAN.md §6.2): a human-ish 0.7 - 1.5 s, drawn per gap. */
export const DEFAULT_PAGE_GAP: GapRange = Object.freeze({ minMs: 700, maxMs: 1500 });
/** Pause between two chats of one job (docs/PLAN.md §6.2). The engine owns that loop; the numbers live here with the others. */
export const ITEM_GAP: GapRange = Object.freeze({ minMs: 2000, maxMs: 4000 });
/** No pause at all: what tests inject. */
export const NO_GAP: GapRange = Object.freeze({ minMs: 0, maxMs: 0 });

/** The slice of `Headers` we read (lets tests pass plain fakes). */
export interface HeadersLike {
  get(name: string): string | null;
}

export function abortedError(): DiscordApiError {
  return new DiscordApiError('aborted', 'The request was cancelled.');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedError();
}

/** setTimeout-based sleep that rejects with `DiscordApiError('aborted')` as soon as `signal` fires. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A draw from `range` in whole milliseconds. A malformed range (NaN, negative, max below min) degrades to its lower bound or 0. */
export function randomGapMs(range: GapRange, random: () => number = Math.random): number {
  const min = Number.isFinite(range.minMs) && range.minMs > 0 ? range.minMs : 0;
  const max = Number.isFinite(range.maxMs) && range.maxMs > min ? range.maxMs : min;
  const r = Math.min(0.999999, Math.max(0, random()));
  return Math.round(min + r * (max - min));
}

function parseNonNegative(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Seconds (possibly fractional) -> whole milliseconds, rounded up; `toFixed` strips float noise such as 1100.0000000000002. */
function secondsToMs(seconds: number): number {
  return Math.ceil(Number((seconds * 1000).toFixed(6)));
}

export interface RateLimitHeaders {
  bucket: string | null;
  limit: number | null;
  remaining: number | null;
  resetAfterMs: number | null;
  global: boolean;
}

export function parseRateLimitHeaders(headers: HeadersLike): RateLimitHeaders {
  const resetAfter = parseNonNegative(headers.get('x-ratelimit-reset-after'));
  const bucket = headers.get('x-ratelimit-bucket');
  return {
    bucket: bucket !== null && bucket.trim() !== '' ? bucket.trim() : null,
    limit: parseNonNegative(headers.get('x-ratelimit-limit')),
    remaining: parseNonNegative(headers.get('x-ratelimit-remaining')),
    resetAfterMs: resetAfter === null ? null : secondsToMs(resetAfter),
    global: headers.get('x-ratelimit-global')?.trim().toLowerCase() === 'true',
  };
}

export interface RetryAfter {
  ms: number;
  global: boolean;
}

/**
 * How long a 429 asks us to wait. Discord's JSON body (`retry_after`, float seconds) is the most precise hint;
 * then the `Retry-After` header (Cloudflare 429s have no JSON), then `X-RateLimit-Reset-After`, then a 1 s default.
 */
export function parseRetryAfter(headers: HeadersLike, body: unknown): RetryAfter {
  const obj = typeof body === 'object' && body !== null ? (body as { retry_after?: unknown; global?: unknown }) : {};
  const seconds =
    parseNonNegative(obj.retry_after) ??
    parseNonNegative(headers.get('retry-after')) ??
    parseNonNegative(headers.get('x-ratelimit-reset-after'));
  return {
    ms: seconds === null ? FALLBACK_RETRY_AFTER_MS : secondsToMs(seconds),
    global: obj.global === true || headers.get('x-ratelimit-global')?.trim().toLowerCase() === 'true',
  };
}

/**
 * Exponential back-off with "equal jitter": the delay for retry `attempt` (0-based) is uniformly spread
 * over [exp/2, exp] where exp = min(cap, base * 2^attempt). Keeps clients from retrying in lock-step.
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random, baseMs = 1_000, capMs = 8_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(exp / 2 + r * (exp / 2));
}

/** Discord's "major parameter" of a route (rate-limit buckets are per channel / guild / webhook). */
export function majorParameter(pathname: string): string {
  const m = /^\/(?:api\/v\d+\/)?(channels|guilds|webhooks)\/(\d+)/.exec(pathname);
  return m ? `${m[1]}/${m[2]}` : '';
}

/**
 * Bookkeeping for Discord's rate limits. Pure apart from the injected clock: it never sleeps itself,
 * it only says how long the caller has to wait (`delayFor`) and learns from responses.
 */
export class RateLimiter {
  /** state key -> epoch ms until which that bucket is exhausted */
  private readonly blockedUntil = new Map<string, number>();
  /** request path -> Discord bucket id (learned from `X-RateLimit-Bucket`) */
  private readonly bucketOfPath = new Map<string, string>();
  private globalUntil = 0;

  constructor(private readonly now: () => number) {}

  /** Milliseconds to wait before a request to `pathname` may be sent (0 = go). A global hold counts for every route. */
  delayFor(pathname: string): number {
    let until = this.globalUntil;
    const bucketUntil = this.blockedUntil.get(this.stateKey(pathname));
    if (bucketUntil !== undefined) until = Math.max(until, bucketUntil);
    return Math.max(0, until - this.now());
  }

  /** Call after every HTTP response (any status). */
  recordResponse(pathname: string, headers: RateLimitHeaders): void {
    const now = this.now();
    if (headers.bucket !== null) {
      if (this.bucketOfPath.size >= MAX_TRACKED_ROUTES) this.bucketOfPath.clear();
      this.bucketOfPath.set(pathname, headers.bucket);
    }
    if (headers.remaining === null || headers.resetAfterMs === null) return;
    const key = this.stateKey(pathname);
    if (headers.remaining <= 0) {
      this.blockedUntil.set(key, now + headers.resetAfterMs);
      this.prune(now);
    } else {
      this.blockedUntil.delete(key);
    }
  }

  /**
   * Call on HTTP 429 with the wait Discord asked for. A `global` 429 and any wait beyond `GLOBAL_HOLD_THRESHOLD_MS` hold
   * EVERY route; a shorter wait blocks the route's bucket only. A block is never shortened.
   */
  recordRateLimited(pathname: string, waitMs: number, global: boolean): void {
    if (global || waitMs > GLOBAL_HOLD_THRESHOLD_MS) {
      this.holdAll(waitMs);
      return;
    }
    const key = this.stateKey(pathname);
    this.blockedUntil.set(key, Math.max(this.blockedUntil.get(key) ?? 0, this.now() + waitMs));
  }

  /** Stops every route for `waitMs` (a block page, an IP ban). A hold is never shortened. */
  holdAll(waitMs: number): void {
    this.globalUntil = Math.max(this.globalUntil, this.now() + waitMs);
  }

  private stateKey(pathname: string): string {
    const bucket = this.bucketOfPath.get(pathname);
    return bucket !== undefined ? `${bucket}:${majorParameter(pathname)}` : `route:${pathname}`;
  }

  private prune(now: number): void {
    if (this.blockedUntil.size <= MAX_TRACKED_BUCKETS) return;
    for (const [key, until] of this.blockedUntil) if (until <= now) this.blockedUntil.delete(key);
  }
}

/**
 * Spacing of consecutive paged requests (message pages ...). The gap is drawn when a request finishes, so asking again and
 * again gives the same answer until the clock catches up. The first request is never delayed.
 */
export class Pacer {
  private nextAt: number | null = null;

  constructor(
    private readonly now: () => number,
    private readonly random: () => number,
    private readonly gap: GapRange,
  ) {}

  /** Milliseconds to wait before the next paced request may start (0 = go). */
  delay(): number {
    return this.nextAt === null ? 0 : Math.max(0, this.nextAt - this.now());
  }

  /** Call when a paced request is over, whatever its outcome. */
  finished(): void {
    const gap = randomGapMs(this.gap, this.random);
    this.nextAt = gap > 0 ? this.now() + gap : null;
  }
}

interface QueueEntry {
  start(): void;
}

/**
 * Runs async tasks strictly one at a time in FIFO order. A task that is still waiting for its turn can be
 * cancelled through its AbortSignal without waiting for the tasks in front of it; a running task must watch the signal itself.
 */
export class SerialQueue {
  private readonly waiting: QueueEntry[] = [];
  private running = false;

  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortedError());
        return;
      }
      let onAbort: (() => void) | undefined;
      const entry: QueueEntry = {
        start: () => {
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
          new Promise<T>((done) => done(task())).then(resolve, reject).finally(() => {
            this.running = false;
            this.pump();
          });
        },
      };
      if (signal) {
        onAbort = () => {
          const index = this.waiting.indexOf(entry);
          if (index === -1) return;
          this.waiting.splice(index, 1);
          reject(abortedError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.waiting.push(entry);
      this.pump();
    });
  }

  private pump(): void {
    if (this.running) return;
    const next = this.waiting.shift();
    if (!next) return;
    this.running = true;
    next.start();
  }
}
