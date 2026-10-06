/**
 * One chat of a job: `exportChat` (messages -> files), then saving the files (save.ts), then the verdict (docs/PLAN.md §6.3):
 * everything saved is `done`; data saved but something went wrong on the way is `partial`; nothing saved is `failed`. A user
 * cancel is not a verdict: it rejects with an `AbortError` and the chat leaves nothing behind (ZIP) or only what was already
 * downloaded (individual files).
 */
import type { ChatError, ExportChatResult } from '@/lib';
import type { ResolvedQueueItem } from '@/shared';
import { throwIfCancelled } from './cancel';
import type { ItemContext } from './context';
import { saveIndividually, saveToArchive } from './save';
import type { JobTexts } from './texts';
import type { ItemOutcome, SaveReport } from './types';

export const failedOutcome = (error: ChatError): ItemOutcome => ({ status: 'failed', messageCount: 0, lastMessageId: null, files: [], error, inArchive: false });

/** The verdict on a chat from what `exportChat` reported and what the saving step managed. */
export function conclude(texts: JobTexts, result: ExportChatResult, report: SaveReport, zip: boolean): ItemOutcome {
  const reported = result.error === null ? null : texts.chatError(result.error);
  if (report.outputs > 0 && report.savedOutputs === 0) return failedOutcome(report.outputError ?? reported ?? texts.kindError('unknown'));
  if (result.status === 'failed') return failedOutcome(reported ?? texts.kindError('unknown'));

  const inArchive = zip && report.savedOutputs > 0;
  const incomplete = result.status === 'partial' || report.savedOutputs < report.outputs || report.limitError !== null;
  if (incomplete) {
    return {
      status: 'partial',
      messageCount: result.messageCount,
      lastMessageId: null,
      files: report.files,
      error: reported ?? report.outputError ?? report.limitError ?? texts.kindError('unknown'),
      inArchive,
    };
  }
  return {
    status: 'done',
    messageCount: result.messageCount,
    lastMessageId: result.lastMessageId,
    files: report.files,
    // The chat is saved in full; a copy of an attachment that is missing is only worth a note.
    error: report.attachmentsMissed > 0 ? texts.attachmentsMissed(report.attachmentsMissed) : null,
    inArchive,
  };
}

/** Exports and saves chat `index` of the job. Rejects with an `AbortError` when the user cancels. */
export async function runItem(ctx: ItemContext, item: ResolvedQueueItem, index: number): Promise<ItemOutcome> {
  const { job, deps, progress, signal, texts } = ctx;
  const zip = ctx.archive !== null;
  await progress.begin(index);

  const result = await deps.exportChat(ctx.client, item.target, item.settings, {
    signal,
    timeZone: job.timeZone,
    locale: job.locale,
    lastExportedId: item.settings.incremental ? (job.lastExported[item.key] ?? null) : null,
    dateInFileName: job.settings.dateInFileName,
    folderName: job.settings.folderName,
    zip,
    ...(zip ? { usedZipPaths: ctx.usedZipPaths } : {}),
    onProgress: (phase, fetched) => progress.phase(phase, fetched),
    now: () => new Date(deps.now()),
    sleep: deps.sleep,
  });
  throwIfCancelled(signal); // a cancel that came while the files were being written: the chat is dropped like any other

  const report = zip ? await saveToArchive(ctx, result) : await saveIndividually(ctx, item, result);
  return conclude(texts, result, report, zip);
}
