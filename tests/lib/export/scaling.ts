import { expect } from 'vitest';
import type { Message } from '../../../src/lib/discord/types';

/**
 * Timing helpers for the export tests. The suite runs its files in parallel, so a fixed time budget ("under two
 * seconds") fails a correct build as soon as the machine is busy. These tests compare a run with a smaller run of
 * the same work instead, in the same process, which is what a performance regression looks like.
 */

export interface ScalingOptions {
  /** Size of the baseline run (messages, characters, ...). */
  small: number;
  /** Size of the measured run. */
  large: number;
  /** How much slower than proportional the large run may be. Linear work scores 1, quadratic work `large / small`. Default 4. */
  slack?: number;
  /** A noisy measurement is repeated this many times before the test fails. */
  attempts?: number;
}

function bestOf(runs: number, work: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    work();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/**
 * Fails when `work(large)` takes disproportionally longer than `work(small)`: linear work takes `large / small` times
 * as long (10 for 2,000 -> 20,000), quadratic work the square of that (100); the limit is `slack` times the linear case
 * (40). A GC pause or a busy CPU can inflate one measurement, so the check is repeated; work that really is superlinear
 * fails every attempt. Returns what the last `work(large)` returned, for the functional assertions of the caller.
 */
export function expectLinearScaling<T>(work: (size: number) => T, { small, large, slack = 4, attempts = 3 }: ScalingOptions): T {
  const limit = (large / small) * slack;
  let result = work(small); // warm-up: code loading, regex compilation, caches
  let ratio = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < attempts && ratio >= limit; attempt += 1) {
    // A baseline below a millisecond would make the ratio a measure of timer resolution.
    const baseline = Math.max(bestOf(3, () => void work(small)), 1);
    const measured = bestOf(2, () => {
      result = work(large);
    });
    ratio = Math.min(ratio, measured / baseline);
  }
  expect(ratio, `time grew ${ratio.toFixed(1)}x for ${large / small}x the work (limit ${limit}x)`).toBeLessThan(limit);
  return result;
}

/** `total` messages made from `messages` repeated, with unique ids and timestamps 1.5 s apart. */
export function inflateMessages(messages: readonly Message[], total: number): Message[] {
  const start = Date.parse('2026-01-01T00:00:00Z');
  return Array.from({ length: total }, (_, i): Message => ({
    ...messages[i % messages.length],
    id: String(200000000000000000n + BigInt(i)),
    timestamp: new Date(start + i * 1500).toISOString(),
  }));
}
