/**
 * Messages from the offscreen download engine (`FromOffscreen`, docs/PLAN.md §5.3). The router only lets them through when
 * they come from the offscreen document itself.
 *
 *  engine/ready       the document's listener exists: a job start that waits for it may continue
 *  engine/keepalive   every 20 s while a job runs; receiving any message is what keeps the worker alive, nothing to do
 *  engine/progress    a full `JobState` snapshot -> `SESSION.job` (coalesced, at most 4 writes/s) + badge
 *  engine/saveBlob    save a blob URL of the document   -> `{ downloadId }`
 *  engine/saveUrl     save a Discord CDN URL (attachment) -> `{ downloadId }`
 *  engine/itemDone    history entry + incremental marker + queue bookkeeping (store.ts `recordItemResult`)
 *  engine/finished    the final job state, notification, badge, offscreen cleanup (jobs.ts `finishJob`)
 *  engine/authError   Discord answered 401: compare-and-clear the value the job used
 */
import type { BgResponse } from '@/shared';
import { revokeToken, verifyAccount } from './account';
import { saveDownload } from './downloads';
import { authorizationOfJob, finishJob } from './jobs';
import { notifyEngineReady } from './offscreen';
import { flushProgress, queueProgress } from './progress';
import { invalid, ok } from './response';
import { isActiveJob, readBgState, readJob, recordItemResult } from './store';
import { isNumericId, isRecord } from './util';
import { validateHistoryEntry } from './validate';

export const ENGINE_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'engine/ready',
  'engine/keepalive',
  'engine/progress',
  'engine/saveBlob',
  'engine/saveUrl',
  'engine/itemDone',
  'engine/finished',
  'engine/authError',
]);

async function onProgress(message: Record<string, unknown>): Promise<BgResponse> {
  const snapshot = message.job;
  if (!isRecord(snapshot) || typeof snapshot.jobId !== 'string') return invalid('job must be a job state');
  const stored = await readJob();
  // A snapshot of a job that is not the running one (a late message of the previous job) must not replace a queued one.
  if (isActiveJob(stored) && stored.jobId === snapshot.jobId) queueProgress(snapshot);
  return ok();
}

async function onItemDone(message: Record<string, unknown>): Promise<BgResponse> {
  const { jobId, entry: rawEntry, lastMessageId } = message;
  if (typeof jobId !== 'string') return invalid('jobId must be a string');
  await flushProgress(); // the item's final status (e.g. cancelled) may still be queued
  const job = await readJob();
  if (job === null || job.jobId !== jobId) return invalid('no such job');

  const checked = validateHistoryEntry(rawEntry);
  if (!checked.ok) return invalid(checked.message);
  const entry = checked.value;
  if (entry.accountId !== job.accountId) return invalid('entry belongs to another account');
  const item = job.items.find((candidate) => candidate.key === entry.target.channelId);
  if (item === undefined) return invalid('entry is for a chat that is not part of the job');

  const state = await readBgState();
  await recordItemResult(job.accountId, {
    entry,
    lastMessageId: isNumericId(lastMessageId) ? lastMessageId : null,
    touchQueue: !(state.jobId === jobId && state.source === 'history'), // a job from the history leaves the queue alone
    cancelled: item.status === 'cancelled',
  });
  return ok();
}

async function onFinished(message: Record<string, unknown>): Promise<BgResponse> {
  const { jobId, state } = message;
  if (typeof jobId !== 'string') return invalid('jobId must be a string');
  if (state !== 'done' && state !== 'cancelled' && state !== 'failed') return invalid('state must be done, cancelled or failed');
  await finishJob(jobId, state);
  return ok();
}

async function onAuthError(message: Record<string, unknown>): Promise<BgResponse> {
  const { jobId } = message;
  if (typeof jobId !== 'string') return invalid('jobId must be a string');
  const used = authorizationOfJob(jobId);
  if (used !== undefined) await revokeToken(used);
  else void verifyAccount(); // the worker restarted since the job began: ask Discord about whatever is stored instead
  return ok();
}

/** Dispatches one `engine/*` message. Never rejects. */
export async function handleEngineMessage(message: Record<string, unknown>): Promise<BgResponse<unknown>> {
  switch (message.type) {
    case 'engine/ready':
      notifyEngineReady();
      return ok();
    case 'engine/keepalive':
      return ok();
    case 'engine/progress':
      return onProgress(message);
    case 'engine/saveBlob':
      return saveDownload('blob', message);
    case 'engine/saveUrl':
      return saveDownload('url', message);
    case 'engine/itemDone':
      return onItemDone(message);
    case 'engine/finished':
      return onFinished(message);
    case 'engine/authError':
      return onAuthError(message);
    default:
      return invalid('unknown engine message');
  }
}
