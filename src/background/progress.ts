/**
 * `engine/progress` handling (docs/PLAN.md §5.3): the engine reports often (every page of messages), the popup and the
 * badge only need a few updates per second, and every write of `SESSION.job` wakes every listener. So snapshots are coalesced
 * and written at most 4 times a second: the first one goes out at once, later ones within 250 ms wait for the end of that
 * window and only the newest is written.
 */
import { isActiveJob, jobLock, readJob, writeJob } from './store';
import { mergeProgress } from './validate';

export const MIN_WRITE_INTERVAL_MS = 250;

let pending: unknown = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastWriteAt = 0;

/** Takes an `engine/progress` snapshot (the whole `JobState` as the engine sees it). Returns at once. */
export function queueProgress(snapshot: unknown): void {
  pending = snapshot;
  if (timer !== null) return; // a write is already scheduled and will pick up the newest snapshot
  const wait = lastWriteAt + MIN_WRITE_INTERVAL_MS - Date.now();
  if (wait <= 0) {
    void flushProgress();
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    void flushProgress();
  }, wait);
}

/** Writes the newest queued snapshot now (the final state of a job must not wait for the timer). Never rejects. */
export async function flushProgress(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const snapshot = pending;
  pending = null;
  if (snapshot === null) return;
  lastWriteAt = Date.now();
  await jobLock
    .run(async () => {
      const stored = await readJob();
      if (!isActiveJob(stored)) return; // the job is over (or there is none): a late snapshot changes nothing
      const merged = mergeProgress(stored, snapshot);
      if (merged !== null) await writeJob(merged);
    })
    .catch(() => undefined);
}

/** Drops anything queued (tests; a new worker starts without it anyway). */
export function resetProgressState(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  pending = null;
  lastWriteAt = 0;
}
