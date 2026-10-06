/**
 * One whole job (docs/PLAN.md §6): its chats strictly one after the other with a random pause (`ITEM_GAP`) between them, each
 * one exported and saved (item.ts), and every outcome reported to the background: progress snapshots, a history entry
 * (`io.itemDone`) for every chat that ended `done`, `partial` or `failed`, and `io.finished` once at the end.
 *
 *  - A user cancel stops at once. The chat in flight gets no entry (it is reported cancelled in the progress only); the chats that
 *    never started stay waiting for the background to close.
 *  - A 401 (the client's `onAuthError`) ends the job after the chat it hit: that chat is judged like any other (partial when it
 *    saved something), the chats that never started are reported failed ("log in again") and the job is `failed`.
 *  - ZIP mode has ONE archive for the job. It is saved last, and when the job stops early (cancel, 401) with chats in it, as a
 *    partial archive. A chat in the archive only counts as saved once the archive is: the history entries of ZIP mode are sent after
 *    it, with the archive's download id first in their files; if the archive cannot be saved those chats are reported failed
 *    (and neither leave the list nor move the incremental marker).
 *  - Everything about a chat that was only a problem of that chat (an error, a failed save, a full ZIP) never stops the job.
 */
import { ITEM_GAP, ZipAssembler, isAbortError, randomGapMs, zipFilePath } from '@/lib';
import type { ChatError } from '@/lib';
import type { EngineJob, HistoryEntry, JobState, ResolvedQueueItem } from '@/shared';
import type { EngineIO } from '../runner';
import type { ItemContext } from './context';
import { failedOutcome, runItem } from './item';
import { JobProgress, MAX_LISTED_FILES } from './progress';
import { createTexts } from './texts';
import type { Locale } from './texts';
import type { ItemOutcome, ResolvedDeps, SavedFile } from './types';

export type FinalState = Extract<JobState['state'], 'done' | 'cancelled' | 'failed'>;

/** Why the loop over the chats ended early. */
type Stop = 'cancelled' | 'auth' | 'fatal';

/** ZIP mode: a chat that ended, waiting for the archive to be saved before it is reported to the history. */
interface Ended {
  index: number;
  item: ResolvedQueueItem;
  outcome: ItemOutcome;
}

function historyEntry(ctx: ItemContext, item: ResolvedQueueItem, outcome: ItemOutcome): HistoryEntry {
  return {
    id: ctx.deps.newId(),
    accountId: ctx.job.accountId,
    target: item.target,
    settings: item.settings,
    finishedAt: ctx.deps.now(),
    status: outcome.status,
    messageCount: outcome.messageCount,
    files: outcome.files.slice(0, MAX_LISTED_FILES).map((file) => ({ filename: file.filename, downloadId: file.downloadId })),
    error: outcome.error === null ? null : outcome.error.message,
  };
}

/** The pause between two chats. false: the job was cancelled meanwhile. */
async function waitBetweenItems(deps: ResolvedDeps, signal: AbortSignal): Promise<boolean> {
  try {
    await deps.sleep(randomGapMs(ITEM_GAP, deps.random), signal);
    return true;
  } catch (error) {
    if (signal.aborted || isAbortError(error)) return false;
    throw error;
  }
}

/**
 * ZIP mode, after the last chat: saves the archive (when it holds anything) and then reports the chats that ended. Returns why the
 * archive could not be saved, or null.
 */
async function closeArchive(ctx: ItemContext, ended: readonly Ended[], partial: boolean): Promise<ChatError | null> {
  const { job, io, deps, texts, progress, archive } = ctx;
  let saved: SavedFile | null = null;
  let failure: ChatError | null = null;
  if (archive !== null && archive.entryCount > 0) {
    try {
      const blob = await archive.finish();
      const filename = zipFilePath(job.settings.folderName, new Date(deps.now()), { timeZone: job.timeZone, partial, locale: job.locale });
      saved = { filename, downloadId: await io.saveBlob(job.jobId, null, blob, filename) };
    } catch (error) {
      failure = texts.zipSaveFailure(error);
    }
  }
  for (const { index, item, outcome } of ended) {
    let result = outcome;
    if (outcome.inArchive) {
      if (saved === null) {
        result = failedOutcome(failure ?? texts.zipSaveFailure(undefined));
        await progress.finish(index, result); // it looked done while the archive was still to be saved
      } else {
        result = { ...outcome, files: [saved, ...outcome.files] };
      }
    }
    await io.itemDone(job.jobId, historyEntry(ctx, item, result), result.lastMessageId);
  }
  return failure;
}

/** Runs the job and reports everything but `io.finished` (the caller says that, once, with the returned state). */
export async function runJob(job: EngineJob, io: EngineIO, deps: ResolvedDeps, signal: AbortSignal): Promise<FinalState> {
  const locale: Locale = job.locale === 'ko' ? 'ko' : 'en';
  const texts = createTexts(locale, job.authorization);
  const progress = new JobProgress(job, io, deps.now, deps.progressIntervalMs);

  let authFailed = false;
  const client = deps.createClient({
    getAuthorization: () => job.authorization,
    onAuthError: () => {
      authFailed = true;
      void io.authError(job.jobId);
    },
    onPause: () => progress.pause(),
    onResume: () => progress.resume(),
  });
  const ctx: ItemContext = {
    job,
    io,
    client,
    deps,
    texts,
    progress,
    signal,
    archive: job.settings.zipAll ? new ZipAssembler(() => new Date(deps.now()), deps.zipLimits) : null,
    usedZipPaths: new Set<string>(),
  };

  await progress.start();
  const ended: Ended[] = [];
  let stop: Stop | null = null;
  let index = 0;
  try {
    for (; index < job.items.length; index += 1) {
      if (signal.aborted || (index > 0 && !(await waitBetweenItems(deps, signal)))) {
        stop = 'cancelled';
        break;
      }
      const item = job.items[index];
      let outcome: ItemOutcome;
      try {
        outcome = await runItem(ctx, item, index);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          await progress.cancel(index, texts.kindError('cancelled'));
          stop = 'cancelled';
          break;
        }
        outcome = failedOutcome(texts.thrown(error)); // nothing is meant to throw here: this chat failed, the job goes on
      }

      await progress.finish(index, outcome);
      if (ctx.archive === null) {
        await io.itemDone(job.jobId, historyEntry(ctx, item, outcome), outcome.lastMessageId);
      } else {
        ended.push({ index, item, outcome });
      }
      if (authFailed) {
        stop = 'auth';
        await progress.failFrom(index + 1, texts.kindError('auth'));
        break;
      }
    }
  } catch (error) {
    // Not supposed to happen. The job is closed (its chats failed) instead of being left hanging.
    stop = 'fatal';
    await progress.failFrom(index + 1, texts.kindError('interrupted'));
    await progress.failFrom(index, texts.thrown(error));
  }

  const archiveFailure = ctx.archive === null ? null : await closeArchive(ctx, ended, stop !== null);
  const state: FinalState = stop === 'cancelled' ? 'cancelled' : stop !== null || archiveFailure !== null ? 'failed' : 'done';
  await progress.complete(state);
  return state;
}
