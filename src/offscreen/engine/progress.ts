/**
 * The engine's `JobState`: one row per chat of the job, changed as the job goes and reported to the background as full
 * snapshots (`io.progress`, docs/PLAN.md §5.3). The background keeps its own copy of the ids, the start time, the ZIP flag and the
 * labels and takes `state` and, per row, `status`, `phase`, `fetched`, `expected`, `error` and `files` from here.
 *
 * Reporting: a change of phase or status goes out at once; a change of the message count alone at most every
 * `progressIntervalMs` (four times a second): the next snapshot carries whatever was skipped. Rows are replaced, never edited, so
 * a snapshot (which only copies the list) stays what it was when it was taken.
 */
import type { ChatError } from '@/lib';
import type { ChatTarget, EngineJob, ItemPhase, ItemProgress, JobState, ResolvedQueueItem } from '@/shared';
import type { EngineIO } from '../runner';
import type { ItemOutcome } from './types';

/** Saved files named on a row (a chat with thousands of attachments names the first ones only; the background keeps 100 anyway). */
export const MAX_LISTED_FILES = 100;

/** "<server> > #<channel>" (as the background labels the rows), the name of a DM, "#<channel>" for a server chat without a known server. */
export function labelOf(target: ChatTarget): string {
  if (target.kind === 'dm' || target.kind === 'group-dm') return target.channelName;
  return target.guildName ? `${target.guildName} > #${target.channelName}` : `#${target.channelName}`;
}

type FinalJobState = Extract<JobState['state'], 'done' | 'cancelled' | 'failed'>;

export class JobProgress {
  private readonly items: ItemProgress[];
  private readonly base: Omit<JobState, 'items' | 'state' | 'pausedReason' | 'finishedAt'>;
  private state: JobState['state'] = 'running';
  private pausedReason: JobState['pausedReason'] = null;
  private finishedAt: number | null = null;
  /** The chat that is being worked on (-1: none), the one `phase`, `pause` and `resume` talk about. */
  private current = -1;
  private lastSentAt = Number.NEGATIVE_INFINITY;

  constructor(
    job: EngineJob,
    private readonly io: EngineIO,
    private readonly now: () => number,
    private readonly intervalMs: number,
  ) {
    this.items = job.items.map(
      (item: ResolvedQueueItem): ItemProgress => ({
        key: item.key,
        label: labelOf(item.target),
        status: 'waiting',
        phase: null,
        fetched: 0,
        expected: item.settings.count,
        error: null,
        files: [],
      }),
    );
    this.base = { jobId: job.jobId, accountId: job.accountId, startedAt: now(), zip: job.settings.zipAll };
  }

  /** The state as it is now: a copy of the list of rows (the rows themselves are never edited). */
  snapshot(): JobState {
    return { ...this.base, state: this.state, pausedReason: this.pausedReason, finishedAt: this.finishedAt, items: [...this.items] };
  }

  private send(): Promise<void> {
    this.lastSentAt = this.now();
    return this.io.progress(this.snapshot());
  }

  private replace(index: number, patch: Partial<ItemProgress>): void {
    this.items[index] = { ...this.items[index], ...patch };
  }

  /** The first snapshot: every chat waiting. */
  start(): Promise<void> {
    return this.send();
  }

  /** Chat `index` starts: running, looking the chat up. */
  begin(index: number): Promise<void> {
    this.current = index;
    this.replace(index, { status: 'running', phase: 'resolving', fetched: 0, error: null, files: [] });
    return this.send();
  }

  /** The chat in progress is in `phase` and has `fetched` messages. A new phase is reported at once, a new count throttled. */
  phase(phase: ItemPhase, fetched?: number): void {
    const row = this.items[this.current];
    if (row === undefined) return;
    const count = fetched ?? row.fetched;
    if (row.phase === phase && row.fetched === count) return;
    const changedPhase = row.phase !== phase;
    this.replace(this.current, { phase, fetched: count });
    if (changedPhase || this.now() - this.lastSentAt >= this.intervalMs) void this.send();
  }

  /** The client waits out a rate limit (or a block page): the job and its running chat are paused. */
  pause(): void {
    this.state = 'paused';
    this.pausedReason = 'rate-limit';
    const row = this.items[this.current];
    if (row?.status === 'running') this.replace(this.current, { status: 'paused' });
    void this.send();
  }

  /** The wait is over. */
  resume(): void {
    this.state = 'running';
    this.pausedReason = null;
    const row = this.items[this.current];
    if (row?.status === 'paused') this.replace(this.current, { status: 'running' });
    void this.send();
  }

  /** Chat `index` ended `done`, `partial` or `failed` (also used to correct a row afterwards). */
  finish(index: number, outcome: ItemOutcome): Promise<void> {
    const failed = outcome.status === 'failed';
    this.replace(index, {
      status: outcome.status,
      phase: null,
      fetched: failed ? this.items[index].fetched : outcome.messageCount,
      error: outcome.error,
      files: outcome.files.slice(0, MAX_LISTED_FILES).map((file) => file.filename),
    });
    return this.send();
  }

  /** The user cancelled chat `index`: nothing of it is kept. */
  cancel(index: number, error: ChatError): Promise<void> {
    this.replace(index, { status: 'cancelled', phase: null, error, files: [] });
    return this.send();
  }

  /** Chats from `from` on that never ran, closed with `error` (the job stopped). Chats that are over keep their result. */
  failFrom(from: number, error: ChatError): Promise<void> {
    for (let index = from; index < this.items.length; index += 1) {
      const row = this.items[index];
      if (row.status === 'waiting' || row.status === 'running' || row.status === 'paused') {
        this.replace(index, { status: 'failed', phase: null, error, files: [] });
      }
    }
    return this.send();
  }

  /** The last snapshot of the job. */
  complete(state: FinalJobState): Promise<void> {
    this.state = state;
    this.pausedReason = null;
    this.finishedAt = this.now();
    this.current = -1;
    return this.send();
  }
}
