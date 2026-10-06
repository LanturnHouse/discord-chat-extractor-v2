/**
 * PLACEHOLDER engine (step A1): reports every item as `failed` ('unknown', "engine not implemented") through the real
 * protocol - progress, `itemDone`, `finished` - so the whole background <-> offscreen flow (job state, history, queue hints,
 * badge, notification, offscreen cleanup, cancel) can be exercised without a Discord. Step A2's real pipeline (engine/) replaced
 * it in `index.ts`; the stub stays as a test double for the background's tests. The contract is documented in runner.ts.
 */
import type { EngineJob, ItemProgress, JobState, ResolvedQueueItem } from '@/shared';
import type { EngineIO, EngineRunner } from './runner';

export const STUB_ERROR_MESSAGE = 'engine not implemented';

export interface StubOptions {
  /** Pause per item while it "runs" (ms). 0 (default) still yields once, so progress messages go out in order. */
  itemDelayMs?: number;
  now?: () => number;
  newId?: () => string;
}

const isDirect = (item: ResolvedQueueItem): boolean => item.target.kind === 'dm' || item.target.kind === 'group-dm';

function labelOf(item: ResolvedQueueItem): string {
  if (isDirect(item)) return item.target.channelName;
  return item.target.guildName ? `${item.target.guildName} > #${item.target.channelName}` : `#${item.target.channelName}`;
}

export function createStubRunner(options: StubOptions = {}): EngineRunner {
  const itemDelayMs = options.itemDelayMs ?? 0;
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const cancelled = new Set<string>();

  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  return {
    async run(job: EngineJob, io: EngineIO): Promise<void> {
      const items: ItemProgress[] = job.items.map((item) => ({
        key: item.key,
        label: labelOf(item),
        status: 'waiting',
        phase: null,
        fetched: 0,
        expected: item.settings.count,
        error: null,
        files: [],
      }));
      const state: JobState = {
        jobId: job.jobId,
        accountId: job.accountId,
        startedAt: now(),
        finishedAt: null,
        state: 'running',
        pausedReason: null,
        zip: job.settings.zipAll,
        items,
      };
      const report = (): Promise<void> => io.progress(structuredClone(state));
      const isCancelled = (): boolean => io.signal.aborted || cancelled.has(job.jobId);

      await report();
      for (const [index, item] of job.items.entries()) {
        const progress = items[index];
        if (isCancelled()) break;
        progress.status = 'running';
        progress.phase = 'resolving';
        await report();
        await pause(itemDelayMs);
        if (isCancelled()) {
          progress.status = 'cancelled';
          progress.phase = null;
          progress.error = { kind: 'cancelled', message: 'Cancelled.' };
          break;
        }
        progress.status = 'failed';
        progress.phase = null;
        progress.error = { kind: 'unknown', message: STUB_ERROR_MESSAGE };
        await report();
        await io.itemDone(
          job.jobId,
          {
            id: newId(),
            accountId: job.accountId,
            target: item.target,
            settings: item.settings,
            finishedAt: now(),
            status: 'failed',
            messageCount: 0,
            files: [],
            error: STUB_ERROR_MESSAGE,
          },
          null,
        );
      }

      const wasCancelled = isCancelled();
      cancelled.delete(job.jobId);
      state.state = wasCancelled ? 'cancelled' : 'done';
      state.finishedAt = now();
      await report();
      await io.finished(job.jobId, wasCancelled ? 'cancelled' : 'done');
    },

    cancel(jobId: string): void {
      cancelled.add(jobId);
    },
  };
}
