import type { ItemProgress, ItemStatus, JobState, QueueItem } from '@/shared';

/** Progress of one item as 0..1 (null = the total is not known). */
export function progressRatio(progress: Pick<ItemProgress, 'fetched' | 'expected' | 'status'>): number | null {
  if (progress.status === 'done') return 1;
  if (progress.expected === null || progress.expected <= 0) return null;
  return Math.min(1, progress.fetched / progress.expected);
}

const FINISHED: ReadonlySet<ItemProgress['status']> = new Set(['done', 'partial', 'failed', 'cancelled']);

/**
 * How many of `job.items` are over, and how far they are as a whole (0..1; each running item counts with its own fraction).
 * The footer uses it for the whole job and the queue tree for the chats inside one server or category.
 */
export function overallProgress(job: Pick<JobState, 'items'>): { finished: number; total: number; ratio: number | null } {
  const total = job.items.length;
  if (total === 0) return { finished: 0, total: 0, ratio: null };
  let finished = 0;
  let sum = 0;
  for (const item of job.items) {
    if (FINISHED.has(item.status)) {
      finished++;
      sum += 1;
    } else if (item.status === 'running' || item.status === 'paused') {
      sum += Math.min(0.99, progressRatio(item) ?? 0);
    }
  }
  return { finished, total, ratio: sum / total };
}

export type FailedStatus = 'partial' | 'failed' | 'cancelled';

export const isFailedStatus = (status: ItemStatus): status is FailedStatus => status === 'partial' || status === 'failed' || status === 'cancelled';

/**
 * Why a chat of the list did not finish, or null: the job's row when it says so, else - when the chat is not part of the running
 * job - what the last attempt left on the item itself (failed, partial and cancelled chats stay in the list, docs/PLAN.md §6.7).
 * A chat that is part of the running job shows its progress instead of an old failure. The chat rows and the group lines (the
 * "미완료 N" chip of a collapsed group) both ask this, so they always agree.
 */
export function failedStatusOf(item: Pick<QueueItem, 'lastResult'>, progress: Pick<ItemProgress, 'status'> | undefined, jobActive: boolean): FailedStatus | null {
  if (progress !== undefined && isFailedStatus(progress.status)) return progress.status;
  if (jobActive && progress !== undefined) return null;
  return item.lastResult?.status ?? null;
}
