/**
 * Worker start-up (docs/PLAN.md §6.3). An MV3 worker is started for any event and suspended again after ~30 s idle, so this
 * runs on every start and must be idempotent:
 *  1. a job that says "running" while its offscreen document is gone is closed as failed/interrupted (this finishes BEFORE the
 *     first message is handled: `whenBooted`), so a stale job can neither block a new one nor be mistaken for a live one;
 *  2. a leftover offscreen document is closed once nothing needs it;
 *  3. a stored authorization without a verified account is looked up again;
 *  4. the badge is brought in line with the stored state (it starts blank after a browser restart).
 * Steps 2 to 4 do not delay message handling.
 */
import { ensureAccount } from './account';
import { refreshBadge } from './badge';
import { settleAndClose } from './downloads';
import { recoverOrphanedJob } from './jobs';

let booted: Promise<void> | null = null;

/** Starts the start-up work once per worker lifetime (further calls return the same promise). Never rejects. */
export function startBootstrap(): Promise<void> {
  booted ??= (async () => {
    try {
      await recoverOrphanedJob();
    } catch {
      // storage unavailable: the next start tries again
    }
    void settleAndClose();
    ensureAccount();
    void refreshBadge();
  })();
  return booted;
}

/** Resolves when step 1 is done (immediately when the bootstrap was never started, as in unit tests of single handlers). */
export function whenBooted(): Promise<void> {
  return booted ?? Promise.resolve();
}

/** Forgets that the bootstrap ran (tests only). */
export function resetBootstrap(): void {
  booted = null;
}
