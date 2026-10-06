/**
 * Timing guard for the tests that feed hostile input to the parser. The suite runs its files in parallel, so one
 * measurement can be several times slower than the code really is (a busy CPU, a GC pause). The work is therefore run
 * again, up to `maxRuns` times, until one run is under the limit: a build only fails when it is slow on every run, which
 * is what code with a quadratic path looks like. Pick `limitMs` far above the linear cost and far below the quadratic one.
 * Returns the fastest run, so the caller can assert on it (and print it when it fails).
 */
export function fastestRunMs(limitMs: number, work: () => void, maxRuns = 6): number {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < maxRuns && best >= limitMs; run += 1) {
    const started = performance.now();
    work();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}
