/**
 * THE SEAM between the offscreen host (host.ts: messaging, blob URLs, keep-alive) and the download engine (A2).
 *
 * The real engine (engine/index.ts, `createEngineRunner`, step A2) implements `EngineRunner` and is wired in `src/offscreen/index.ts`;
 * the placeholder of step A1 (stubEngine.ts) stays for the tests of the background. The host is never allowed to look inside a job.
 *
 * What the host guarantees:
 *  - `run(job, io)` is called once per `engine/run` message, never while another job is running. The host has already answered
 *    `{ ok: true }` to the background; `run` just does the work and returns (resolved or rejected) when it is over.
 *  - `cancel(jobId)` is called when the background sends `engine/cancel` for the running job; `io.signal` is aborted at the same
 *    moment (use whichever suits: pass the signal to `fetch`, or poll a flag). After a cancel the runner must still finish
 *    the job properly (see "Finishing" below), it just stops fetching.
 *  - Every `io.*` call below goes to the background in call order, one message at a time (a slow `saveBlob` delays the progress
 *    messages queued behind it, never the other way round).
 *  - If `run` returns or throws WITHOUT having called `io.finished(...)`, the host reports `engine/finished('failed')` so the job
 *    cannot hang; calling `io.finished` yourself is the normal way.
 *  - The `authorization` of the job is in `job.authorization`: keep it in memory, never log it, never put it in an error, a file
 *    or a message other than the HTTP header of an allow-listed request.
 *
 * What the background does with what the engine sends (see src/background/engine.ts):
 *  - `io.progress(state)`: a FULL `JobState` snapshot. The background keeps its own copy of `jobId`, `accountId`, `startedAt`,
 *    `zip` and the item list with labels (it created them); from your snapshot it takes `state` ('running' | 'paused' with
 *    `pausedReason: 'rate-limit'`) and, per item (matched by `key`), `status`, `phase`, `fetched`, `expected`, `error` and
 *    `files`. A finished item (done / partial / failed / cancelled) cannot go back to waiting or running. Writes to storage are
 *    coalesced to at most 4 per second, so report as often as you like.
 *  - `io.itemDone(...)`: call it once for every item that ends `done`, `partial` or `failed` (not for items the user cancelled:
 *    those are reported as status 'cancelled' in the progress snapshots and need no entry). The background appends the history
 *    entry (newest first, max 200), advances the incremental marker for `done` only (`lastMessageId` = newest message id of
 *    the export, or null), removes `done` items from the list and gives `partial`/`failed` ones a retry hint.
 *    `entry.accountId` must be `job.accountId` and `entry.target.channelId` an item key of the job, or the entry is refused.
 *  - `io.saveBlob` / `io.saveUrl`: `filename` is a path relative to the Downloads folder, already cleaned segment by segment
 *    (docs/PLAN.md §6.6); the background checks it again (no absolute path, no `..`, no empty segment, no forbidden characters)
 *    and answers `{ downloadId }`, or the call rejects with an `EngineSaveError`. `saveUrl` only takes `https://cdn.discordapp.com`
 *    and `https://media.discordapp.net` URLs.
 *  - `io.authError(jobId)`: Discord answered 401 to a request. The background removes the stored authorization if it is still
 *    the value this job used. The job itself carries on or ends by your decision.
 *
 * Finishing: report every item's final status in a last progress snapshot, then `await io.finished(job.jobId, state)` with
 * 'done' (all items were processed, whatever their individual results), 'cancelled' (the user cancelled) or 'failed' (the engine
 * itself broke). Items still waiting/running at that point are closed by the background (cancelled, or failed/interrupted).
 */
import type { BgError, EngineJob, HistoryEntry, JobState } from '@/shared';

/** A save request was refused or failed. `code` is the background's error code (`'invalid'` for a rejected filename or URL, ...). */
export class EngineSaveError extends Error {
  readonly code: BgError | 'unreachable';

  constructor(code: BgError | 'unreachable', message: string) {
    super(message);
    this.name = 'EngineSaveError';
    this.code = code;
  }
}

/** What the engine can do to the outside world. One instance per `run`. Methods that return a promise never reject, except the two saves. */
export interface EngineIO {
  /** Aborted when the background cancels this job (`engine/cancel`). */
  readonly signal: AbortSignal;

  /** A full `JobState` snapshot (see the file comment for which fields count). Fire and forget; the promise resolves once delivered. */
  progress(job: JobState): Promise<void>;

  /**
   * Turns `blob` into an object URL, asks the background to download it (`engine/saveBlob`) and resolves with Chrome's download
   * id. The background revokes the URL when the download is over (`engine/revoke`); if it refuses, the URL is revoked here and
   * the promise rejects with an `EngineSaveError`. `itemKey` is the chat the file belongs to, or null for a ZIP of several chats.
   */
  saveBlob(jobId: string, itemKey: string | null, blob: Blob, filename: string): Promise<number>;

  /** Asks the background to download a Discord CDN URL (an attachment, individual-file mode). Resolves with the download id. */
  saveUrl(jobId: string, itemKey: string, url: string, filename: string): Promise<number>;

  /** An item ended done / partial / failed. `lastMessageId`: newest exported message id (only meaningful for `done`), or null. */
  itemDone(jobId: string, entry: HistoryEntry, lastMessageId: string | null): Promise<void>;

  /** Discord rejected the authorization (401). */
  authError(jobId: string): Promise<void>;

  /** The job is over. Call it exactly once, last. */
  finished(jobId: string, state: Extract<JobState['state'], 'done' | 'cancelled' | 'failed'>): Promise<void>;
}

/** The download engine: engine/index.ts is the real one, stubEngine.ts a placeholder for tests. */
export interface EngineRunner {
  /** Runs the whole job (all items, one after the other). Resolves or rejects when it is over; reports through `io`. */
  run(job: EngineJob, io: EngineIO): Promise<void>;
  /** The user cancelled `jobId`: stop fetching, close the job (see "Finishing"). Idempotent; unknown ids are ignored. */
  cancel(jobId: string): void;
}
