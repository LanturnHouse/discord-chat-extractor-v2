/** What the steps of one chat need to know about the job they belong to. */
import type { DiscordClient, ZipAssembler } from '@/lib';
import type { EngineJob } from '@/shared';
import type { EngineIO } from '../runner';
import type { JobProgress } from './progress';
import type { JobTexts } from './texts';
import type { ResolvedDeps } from './types';

export interface ItemContext {
  job: EngineJob;
  io: EngineIO;
  /** The job's one Discord client. */
  client: DiscordClient;
  deps: ResolvedDeps;
  texts: JobTexts;
  progress: JobProgress;
  /** Aborted when the user cancels the job. */
  signal: AbortSignal;
  /** ZIP mode: the archive every chat of the job goes into (null: individual files). */
  archive: ZipAssembler | null;
  /** ZIP mode: entry paths taken so far (`exportChat` keeps its own entries apart from them). */
  usedZipPaths: Set<string>;
}
