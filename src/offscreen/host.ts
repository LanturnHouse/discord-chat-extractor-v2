/**
 * The offscreen document's side of the background <-> offscreen protocol (docs/PLAN.md §3, §5.3). It owns the messaging, the
 * blob URLs and the keep-alive and knows nothing about Discord: the engine behind it is an `EngineRunner` (runner.ts).
 *
 *  - on load: `engine/ready` (the background waits for it after creating the document);
 *  - `engine/run`    -> acknowledged at once, then `runner.run(job, io)`; one job at a time; `engine/keepalive` every 20 s while
 *                       it runs (a long rate-limit wait would otherwise let the service worker go to sleep);
 *  - `engine/cancel` -> `runner.cancel(jobId)` + `io.signal` aborts;
 *  - `engine/revoke` -> `URL.revokeObjectURL` (the background says when a blob download is over).
 * Messages to the background go out in order, one at a time. Everything touching `chrome.runtime`, `URL` and timers comes in
 * through `HostDeps`, so the host runs in tests without a browser.
 */
import type { BgError, EngineJob, FromOffscreen, HistoryEntry, JobState } from '@/shared';
import { EngineSaveError } from './runner';
import type { EngineIO, EngineRunner } from './runner';

export const KEEPALIVE_INTERVAL_MS = 20_000;

/** The slice of `chrome.runtime` the host uses. */
export interface HostRuntime {
  id: string;
  sendMessage(message: unknown): Promise<unknown>;
  onMessage: {
    addListener(
      listener: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean | void,
    ): void;
  };
}

export interface HostDeps {
  runtime: HostRuntime;
  runner: EngineRunner;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  keepaliveMs?: number;
}

export interface OffscreenHost {
  /** Stops the keep-alive and ignores every further message (tests). */
  dispose(): void;
}

type FinishedState = Extract<JobState['state'], 'done' | 'cancelled' | 'failed'>;

interface ActiveRun {
  jobId: string;
  controller: AbortController;
  keepalive: ReturnType<typeof setInterval> | null;
  finishedSent: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function isEngineJob(value: unknown): value is EngineJob {
  return (
    isRecord(value) &&
    typeof value.jobId === 'string' &&
    typeof value.accountId === 'string' &&
    typeof value.authorization === 'string' &&
    Array.isArray(value.items) &&
    isRecord(value.settings)
  );
}

export function startOffscreenHost(deps: HostDeps): OffscreenHost {
  const { runtime, runner } = deps;
  const createObjectURL = deps.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectURL = deps.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
  const keepaliveMs = deps.keepaliveMs ?? KEEPALIVE_INTERVAL_MS;

  let disposed = false;
  let active: ActiveRun | null = null;
  /** Tail of the outgoing message chain: every message waits for the one before it to be answered. */
  let outbox: Promise<void> = Promise.resolve();

  /** Sends one message to the background after all earlier ones were answered; resolves with its answer. */
  function send(message: FromOffscreen): Promise<unknown> {
    const answer = outbox.then(() => runtime.sendMessage(message));
    outbox = answer.then(
      () => undefined,
      () => undefined,
    );
    return answer;
  }

  /** `send` for messages nobody needs an answer to: failures (worker gone, listener missing) are not the engine's problem. */
  const sendQuietly = (message: FromOffscreen): Promise<void> =>
    send(message).then(
      () => undefined,
      () => undefined,
    );

  function releaseRun(run: ActiveRun): void {
    if (run.keepalive !== null) clearInterval(run.keepalive);
    run.keepalive = null;
    if (active === run) active = null; // the next job may start right away, even if the runner's promise is still unwinding
  }

  /** The id of the download in a `saveBlob` / `saveUrl` answer, or an `EngineSaveError` saying why there is none. */
  function downloadIdOf(response: unknown): number {
    if (isRecord(response) && response.ok === true && isRecord(response.data) && Number.isInteger(response.data.downloadId)) {
      return response.data.downloadId as number;
    }
    if (isRecord(response) && response.ok === false && typeof response.error === 'string') {
      throw new EngineSaveError(response.error as BgError, typeof response.message === 'string' ? response.message : 'The save was refused.');
    }
    throw new EngineSaveError('unreachable', 'The background did not answer the save request.');
  }

  function createIO(run: ActiveRun): EngineIO {
    return {
      signal: run.controller.signal,
      progress: (job: JobState) => sendQuietly({ to: 'bg', type: 'engine/progress', job }),
      saveBlob: async (jobId: string, itemKey: string | null, blob: Blob, filename: string): Promise<number> => {
        let url: string;
        try {
          url = createObjectURL(blob);
        } catch {
          throw new EngineSaveError('unknown', 'The file could not be prepared for download.'); // e.g. no memory left for the blob
        }
        try {
          return downloadIdOf(await send({ to: 'bg', type: 'engine/saveBlob', jobId, itemKey, url, filename }));
        } catch (error) {
          revokeObjectURL(url); // the background did not take the URL over: nobody else will free it
          throw error instanceof EngineSaveError ? error : new EngineSaveError('unreachable', 'The background could not be reached.');
        }
      },
      saveUrl: async (jobId: string, itemKey: string, url: string, filename: string): Promise<number> => {
        try {
          return downloadIdOf(await send({ to: 'bg', type: 'engine/saveUrl', jobId, itemKey, url, filename }));
        } catch (error) {
          throw error instanceof EngineSaveError ? error : new EngineSaveError('unreachable', 'The background could not be reached.');
        }
      },
      itemDone: (jobId: string, entry: HistoryEntry, lastMessageId: string | null) =>
        sendQuietly({ to: 'bg', type: 'engine/itemDone', jobId, entry, lastMessageId }),
      authError: (jobId: string) => sendQuietly({ to: 'bg', type: 'engine/authError', jobId }),
      finished: (jobId: string, state: FinishedState) => {
        run.finishedSent = true;
        releaseRun(run);
        return sendQuietly({ to: 'bg', type: 'engine/finished', jobId, state });
      },
    };
  }

  function startRun(job: EngineJob): { ok: boolean; error?: BgError; message?: string } {
    if (active !== null) return { ok: false, error: 'busy', message: 'a job is already running' };
    const run: ActiveRun = { jobId: job.jobId, controller: new AbortController(), keepalive: null, finishedSent: false };
    run.keepalive = setInterval(() => void sendQuietly({ to: 'bg', type: 'engine/keepalive', jobId: job.jobId }), keepaliveMs);
    active = run;
    const io = createIO(run);
    let result: Promise<void>;
    try {
      result = Promise.resolve(runner.run(job, io)); // started right away, inside this message
    } catch (error) {
      result = Promise.reject(error);
    }
    void result
      .catch(() => undefined) // reported below: the job is closed as failed
      .then(async () => {
        if (!run.finishedSent) await io.finished(job.jobId, 'failed'); // a runner that just returns must not leave the job hanging
        releaseRun(run);
      });
    return { ok: true };
  }

  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (disposed || !isRecord(message) || message.to !== 'offscreen') return false;
    if (sender.id !== runtime.id) return false;
    switch (message.type) {
      case 'engine/run':
        if (!isEngineJob(message.job)) sendResponse({ ok: false, error: 'invalid', message: 'engine/run needs a job' });
        else sendResponse(startRun(message.job));
        return false;
      case 'engine/cancel':
        if (typeof message.jobId === 'string' && active !== null && active.jobId === message.jobId) {
          active.controller.abort();
          runner.cancel(message.jobId);
        }
        sendResponse({ ok: true });
        return false;
      case 'engine/revoke':
        if (typeof message.url === 'string' && message.url.startsWith('blob:')) revokeObjectURL(message.url);
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });

  void sendQuietly({ to: 'bg', type: 'engine/ready' });

  return {
    dispose() {
      disposed = true;
      if (active !== null) releaseRun(active);
    },
  };
}
