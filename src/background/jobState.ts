/**
 * The pure part of job handling: labels, the initial `JobState`, how a job is closed (finished, cancelled, interrupted) and
 * the numbers the notification and the badge show. No chrome.* access.
 */
import type { ChatTarget, ItemProgress, JobState, ResolvedQueueItem } from '@/shared';
import type { QueueMark } from './store';
import { isDirectMessageKind, isTerminalStatus } from './validate';

/** "<guildName> > #<channelName>", or just the name for a DM (a guild chat without a known guild name: "#<channelName>"). */
export function formatLabel(target: ChatTarget): string {
  if (isDirectMessageKind(target.kind)) return target.channelName;
  return target.guildName ? `${target.guildName} > #${target.channelName}` : `#${target.channelName}`;
}

/** A new job: every item waiting; `expected` is the item's message limit (null = no limit). */
export function buildJobState(args: {
  jobId: string;
  accountId: string;
  items: readonly ResolvedQueueItem[];
  zip: boolean;
  now: number;
}): JobState {
  return {
    jobId: args.jobId,
    accountId: args.accountId,
    startedAt: args.now,
    finishedAt: null,
    state: 'running',
    pausedReason: null,
    zip: args.zip,
    items: args.items.map(
      (item): ItemProgress => ({
        key: item.key,
        label: formatLabel(item.target),
        status: 'waiting',
        phase: null,
        fetched: 0,
        expected: item.settings.count,
        error: null,
        files: [],
      }),
    ),
  };
}

export type FinalJobState = Extract<JobState['state'], 'done' | 'cancelled' | 'failed'>;

/**
 * The final state of a job. Items the engine did not finish are closed here: 'cancelled' when the job was cancelled,
 * otherwise `failed` / `interrupted` (the engine stopped or vanished). The returned `marks` are the queue hints (`lastResult`)
 * of the items that were really attempted (reported failed, partial or cancelled by the engine, or caught in flight when the
 * job ended); items that never started get no hint, they simply stay in the list.
 */
export function finalizeJob(job: JobState, finalState: FinalJobState, now: number): { job: JobState; marks: QueueMark[] } {
  const marks: QueueMark[] = [];
  const items = job.items.map((item): ItemProgress => {
    if (isTerminalStatus(item.status)) {
      if (item.status !== 'done') marks.push(markOf(item, now));
      return item;
    }
    const cancelled = finalState === 'cancelled';
    const closed: ItemProgress = {
      ...item,
      status: cancelled ? 'cancelled' : 'failed',
      phase: null,
      error: cancelled
        ? { kind: 'cancelled', message: 'Cancelled.' }
        : { kind: 'interrupted', message: 'The download engine stopped before this chat was finished.' },
    };
    if (item.status === 'running' || item.status === 'paused') marks.push(markOf(closed, now));
    return closed;
  });
  return { job: { ...job, state: finalState, finishedAt: now, pausedReason: null, items }, marks };
}

function markOf(item: ItemProgress, now: number): QueueMark {
  return { key: item.key, status: item.status as QueueMark['status'], message: item.error?.message ?? item.status, at: now };
}

/** Did anything go wrong that the user should look at? (A user cancellation alone is not a failure.) */
export function hasFailures(job: JobState): boolean {
  return job.state === 'failed' || job.items.some((item) => item.status === 'failed' || item.status === 'partial');
}

/** Chats that produced a file (done or partial) and the messages in them (what the notification reports). */
export function summarizeJob(job: JobState): { chats: number; messages: number; failures: number } {
  let chats = 0;
  let messages = 0;
  let failures = 0;
  for (const item of job.items) {
    if (item.status === 'done' || item.status === 'partial') {
      chats += 1;
      messages += item.fetched;
    }
    if (item.status === 'failed' || item.status === 'partial') failures += 1;
  }
  return { chats, messages, failures };
}
