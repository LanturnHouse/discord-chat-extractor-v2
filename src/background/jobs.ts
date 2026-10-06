/**
 * Download jobs (docs/PLAN.md §3, §5.3, §6.3, §6.7): starting one (`job/start`, `history/rerun`), cancelling it, closing it
 * when the engine reports `engine/finished`, and cleaning up a job whose engine is gone.
 *
 * Everything that changes `SESSION.job` runs under `jobLock`, so two quick `job/start` messages cannot both pass the "not
 * busy" check, and a finish cannot interleave with a progress write. The effective settings of every item are fixed here, at
 * the start (item > category > server > common, `resolveEffectiveSettings`): changing the common settings or a group's settings
 * later does not touch a running job. The authorization goes to the engine inside `engine/run` and nowhere else.
 */
import { resolveEffectiveSettings } from '@/shared';
import type { AccountInfo, AppSettings, BgResponse, EngineJob, GroupMap, GroupSettingsMap, JobState, QueueItem, ResolvedQueueItem } from '@/shared';
import { settleAndClose } from './downloads';
import { buildJobState, finalizeJob, hasFailures } from './jobState';
import type { FinalJobState } from './jobState';
import { resolveLocale, resolveTimeZone } from './locale';
import { notifyFinished } from './notify';
import { ensureOffscreen, offscreenExists, sendToOffscreen } from './offscreen';
import { flushProgress } from './progress';
import { fail, invalid, ok } from './response';
import {
  isActiveJob,
  jobLock,
  markQueueResults,
  readAccount,
  readBgState,
  readHistory,
  readJob,
  readLastExported,
  readQueueState,
  readSettings,
  readToken,
  updateBgState,
  writeJob,
} from './store';
import { describeError, isNumericId } from './util';

/**
 * The authorization each job was started with, in memory only. `engine/authError` compares against it so a 401 for the value
 * the engine used can never remove a NEWER capture. Lost when the worker restarts (the handler then asks Discord instead).
 */
const jobAuthorization = new Map<string, string>();

export function authorizationOfJob(jobId: string): string | undefined {
  return jobAuthorization.get(jobId);
}

const MAX_KEYS = 5000;

/** 'all', or the set of channel ids to run; null when the message is malformed. */
function parseKeys(raw: unknown): 'all' | Set<string> | null {
  if (raw === 'all') return 'all';
  if (!Array.isArray(raw) || raw.length > MAX_KEYS) return null;
  const keys = new Set<string>();
  for (const key of raw) {
    if (!isNumericId(key)) return null;
    keys.add(key);
  }
  return keys;
}

type Preflight =
  | { ok: true; settings: AppSettings; account: AccountInfo; token: string }
  | { ok: false; response: BgResponse<never> };

/**
 * What every job start needs, checked in this order: consent (`consentAt`), a verified account with a stored authorization,
 * and no other job running. A "running" job whose offscreen document is gone can never finish: it is closed as interrupted
 * so it does not block new jobs forever. Must run inside `jobLock`.
 */
async function preflight(): Promise<Preflight> {
  const settings = await readSettings();
  if (settings.consentAt === null) return { ok: false, response: fail('no-consent') };
  const [account, token] = await Promise.all([readAccount(), readToken()]);
  if (account === null || token === null) return { ok: false, response: fail('no-account') };
  const running = await readJob();
  if (isActiveJob(running)) {
    if (await offscreenExists()) return { ok: false, response: fail('busy') };
    await interruptLocked(running);
  }
  return { ok: true, settings, account, token };
}

interface Plan {
  settings: AppSettings;
  account: AccountInfo;
  token: string;
  items: ResolvedQueueItem[];
  source: 'queue' | 'history';
}

/** Writes the new job, brings the engine up and hands it the work. Must run inside `jobLock`. */
async function launch({ settings, account, token, items, source }: Plan): Promise<BgResponse<{ jobId: string }>> {
  const jobId = crypto.randomUUID();
  const previous = await readJob();
  await writeJob(buildJobState({ jobId, accountId: account.id, items, zip: settings.zipAll, now: Date.now() }));
  await updateBgState((state) => {
    state.jobId = jobId;
    state.source = source;
    state.lastDownloadId = null;
    state.alert = false;
  });
  jobAuthorization.set(jobId, token);
  try {
    await ensureOffscreen();
    const engineJob: EngineJob = {
      jobId,
      accountId: account.id,
      authorization: token,
      items,
      settings,
      lastExported: await readLastExported(account.id),
      locale: await resolveLocale(settings.language),
      timeZone: resolveTimeZone(settings.timeZone),
    };
    await sendToOffscreen({ to: 'offscreen', type: 'engine/run', job: engineJob });
  } catch (error) {
    // The engine never got the job: it is as if the start had not happened (the caller shows the error from the answer).
    jobAuthorization.delete(jobId);
    await writeJob(previous);
    void settleAndClose();
    return fail('unknown', describeError(error));
  }
  return ok({ jobId });
}

/**
 * An item with the settings it runs with, fixed now: the item's own settings, else its category's, else its server's, else the
 * common settings (`resolveEffectiveSettings`, docs/PLAN.md §5.5); always deep copies.
 */
function resolveItem(
  item: Pick<QueueItem, 'key' | 'target' | 'settings'>,
  settings: AppSettings,
  groupSettings: GroupSettingsMap,
  groups: GroupMap,
): ResolvedQueueItem {
  return { key: item.key, target: structuredClone(item.target), settings: resolveEffectiveSettings(item, settings.common, groupSettings, groups).settings };
}

/**
 * `job/start`: run `keys` (queue items by channel id, or 'all') with their effective settings. The queue, the recorded groups
 * and the group settings are read in one storage call, so the settings of every item come from one consistent picture.
 */
export function startJob(rawKeys: unknown): Promise<BgResponse<{ jobId: string }>> {
  const keys = parseKeys(rawKeys);
  if (keys === null) return Promise.resolve(invalid('keys must be "all" or an array of channel ids'));
  return jobLock.run(async () => {
    const pre = await preflight();
    if (!pre.ok) return pre.response;
    const { items: queue, groups, groupSettings } = await readQueueState(pre.account.id);
    const wanted = keys === 'all' ? queue : queue.filter((item) => keys.has(item.key));
    if (wanted.length === 0) return fail('empty');
    return launch({ ...pre, items: wanted.map((item) => resolveItem(item, pre.settings, groupSettings, groups)), source: 'queue' });
  });
}

/**
 * `history/rerun` ("다시 받기"): a one-item job from a history entry (its target and the settings it was run with); the queue is
 * not touched. The run is never incremental, whatever the entry was run with: it downloads the same scope again (the same count
 * and period) instead of only the messages that are new since the last export. The history entry itself stays as it was.
 */
export function rerunFromHistory(rawId: unknown): Promise<BgResponse<{ jobId: string }>> {
  if (typeof rawId !== 'string' || rawId === '' || rawId.length > 100) return Promise.resolve(invalid('id must be a history entry id'));
  return jobLock.run(async () => {
    const pre = await preflight();
    if (!pre.ok) return pre.response;
    const entry = (await readHistory(pre.account.id)).find((candidate) => candidate.id === rawId);
    if (entry === undefined) return invalid('history entry not found');
    // the entry's own settings are the item's settings (the highest level): no group or common setting can reach them
    const item = { key: entry.target.channelId, target: entry.target, settings: { ...entry.settings, incremental: false } };
    return launch({ ...pre, items: [resolveItem(item, pre.settings, {}, {})], source: 'history' });
  });
}

/**
 * `job/cancel`: asks the engine to stop; it answers with `engine/finished('cancelled')`. The request runs under `jobLock`, so a
 * cancel that arrives while a job is still being started waits until the engine has the job (and then reaches it). If the
 * engine cannot be reached it is gone, nobody else would ever finish the job, and it is closed here. No running job: nothing
 * to do.
 */
export async function cancelJob(): Promise<BgResponse> {
  const attempt = await jobLock.run(async () => {
    const job = await readJob();
    if (!isActiveJob(job)) return null;
    try {
      await sendToOffscreen({ to: 'offscreen', type: 'engine/cancel', jobId: job.jobId });
      return { jobId: job.jobId, delivered: true };
    } catch {
      return { jobId: job.jobId, delivered: false };
    }
  });
  if (attempt !== null && !attempt.delivered) await finishJob(attempt.jobId, 'cancelled');
  return ok();
}

/**
 * Stores a final job state. If the write is refused (storage quota), it is tried again without the lists of saved files, the
 * only part that can be big: a job must never be left "running" just because its summary was too large.
 */
async function writeFinalJob(job: JobState): Promise<void> {
  try {
    await writeJob(job);
  } catch {
    await writeJob({ ...job, items: job.items.map((item) => ({ ...item, files: [] })) });
  }
}

/**
 * The job is over (`engine/finished`, or the engine vanished while the user cancelled): the final state is stored (items the
 * engine left unfinished are closed, see `finalizeJob`), the retry hints go to the queue, the failure badge and the
 * notification follow, and the offscreen document is closed once its downloads have settled. A job that is not the running
 * one (already finished, or another job) is ignored. Once the final state is stored, nothing after it can fail the job.
 */
export async function finishJob(jobId: string, finalState: FinalJobState): Promise<void> {
  await flushProgress(); // the engine's last word comes first
  const outcome = await jobLock.run(async () => {
    const job = await readJob();
    if (!isActiveJob(job) || job.jobId !== jobId) return null;
    const closed = finalizeJob(job, finalState, Date.now());
    await writeFinalJob(closed.job);
    const bg = await readBgState();
    return { ...closed, source: bg.jobId === jobId ? bg.source : 'queue', startedAt: job.startedAt };
  });
  if (outcome === null) return;
  jobAuthorization.delete(jobId);
  if (outcome.source === 'queue') await markQueueResults(outcome.job.accountId, outcome.marks, outcome.startedAt).catch(() => undefined);
  const failures = hasFailures(outcome.job);
  await updateBgState((state) => {
    state.alert = failures;
  }).catch(() => undefined);
  await notifyFinished(outcome.job);
  void settleAndClose();
}

/** The running job's engine is gone: close the job as failed/interrupted. Must run inside `jobLock`. */
async function interruptLocked(job: JobState): Promise<void> {
  const closed = finalizeJob(job, 'failed', Date.now());
  await writeFinalJob(closed.job);
  jobAuthorization.delete(job.jobId);
  const bg = await readBgState();
  if (bg.jobId !== job.jobId || bg.source === 'queue') await markQueueResults(job.accountId, closed.marks, job.startedAt).catch(() => undefined);
  await updateBgState((state) => {
    state.alert = true;
  }).catch(() => undefined);
}

/**
 * Worker start (docs/PLAN.md §6.3): a job that says "running" while no offscreen document exists lost its engine (browser
 * restart, crash). It is marked failed and its unfinished items `interrupted`. Must finish before any message is handled.
 */
export function recoverOrphanedJob(): Promise<void> {
  return jobLock.run(async () => {
    const job = await readJob();
    if (!isActiveJob(job)) return;
    if (await offscreenExists()) return;
    await interruptLocked(job);
  });
}
