/**
 * The download engine of the offscreen document (docs/PLAN.md §3, §6): the real `EngineRunner` behind the host's seam (runner.ts).
 *
 * Per job it builds one Discord client over the fetch transport (the authorization of the job stays in memory and only ever goes
 * into the header of an allow-listed API request), walks through the chats one after the other (job.ts), exports each with the
 * library (`exportChat`), saves the files (save.ts) and reports progress, history entries and the end of the job through `io`.
 *
 * `cancel(jobId)` and `io.signal` both mean "the user cancelled": they end up in the one abort signal the work runs under.
 */
import { abortableSleep, createDiscordClient, createFetchTransport, exportChat } from '@/lib';
import type { EngineRunner } from '../runner';
import { runJob } from './job';
import type { FinalState } from './job';
import type { EngineDeps, ResolvedDeps } from './types';

export type { EngineDeps } from './types';

export const DEFAULT_PROGRESS_INTERVAL_MS = 250;

function resolveDeps(deps: EngineDeps): ResolvedDeps {
  return {
    createClient: deps.createClient ?? ((options) => createDiscordClient({ ...options, transport: createFetchTransport() })),
    exportChat: deps.exportChat ?? exportChat,
    // Always called as a plain function: a detached `fetch` throws "Illegal invocation".
    fetch: deps.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    sleep: deps.sleep ?? abortableSleep,
    random: deps.random ?? Math.random,
    now: deps.now ?? (() => Date.now()),
    newId: deps.newId ?? (() => crypto.randomUUID()),
    progressIntervalMs: deps.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS,
    zipLimits: deps.zipLimits,
  };
}

export function createEngineRunner(deps: EngineDeps = {}): EngineRunner {
  const resolved = resolveDeps(deps);
  /** The abort controller of the job that is running, by job id. */
  const running = new Map<string, AbortController>();

  return {
    async run(job, io): Promise<void> {
      const controller = new AbortController();
      running.set(job.jobId, controller);
      const onAbort = (): void => controller.abort();
      if (io.signal.aborted) controller.abort();
      else io.signal.addEventListener('abort', onAbort, { once: true });

      let state: FinalState = 'failed'; // what a job that broke down is
      try {
        state = await runJob(job, io, resolved, controller.signal);
      } finally {
        io.signal.removeEventListener('abort', onAbort);
        if (running.get(job.jobId) === controller) running.delete(job.jobId);
        await io.finished(job.jobId, state); // exactly once, last, whatever happened
      }
    },

    cancel(jobId: string): void {
      running.get(jobId)?.abort();
    },
  };
}
