/**
 * Saving what `exportChat` produced for one chat (docs/PLAN.md §6.3, §6.5), in the two modes of a job:
 *
 *  - individual files: every output becomes a Blob and a download (`io.saveBlob`), every attachment a download of its CDN URL
 *    (`io.saveUrl`), one after the other;
 *  - ZIP: every output and every attachment (its bytes fetched from the CDN here) is added to the job's one archive. The
 *    attachments are fetched BEFORE anything of the chat is added, so a cancel leaves nothing of an unfinished chat in the archive.
 *
 * Neither mode ever fails the chat because of an attachment; a ZIP that ran full or a file that could not be saved is reported in
 * the `SaveReport` for `conclude` (item.ts) to turn into a status.
 */
import { ZipLimitError } from '@/lib';
import type { ChatOutput, ExportChatResult } from '@/lib';
import type { ResolvedQueueItem } from '@/shared';
import { downloadAttachment, isDownloadable, refreshStale, uniqueByPath } from './attachments';
import { throwIfCancelled } from './cancel';
import type { ItemContext } from './context';
import type { SaveReport } from './types';

const emptyReport = (outputs: number): SaveReport => ({ outputs, savedOutputs: 0, files: [], outputError: null, attachmentsMissed: 0, limitError: null });

/** A file's content as the bytes or text a Blob takes (fflate hands out ArrayBuffer-backed views; the cast only narrows the typings). */
const blobPartOf = (data: ChatOutput['data']): BlobPart => (typeof data === 'string' ? data : (data as Uint8Array<ArrayBuffer>));

/**
 * Individual-file mode. The outputs are handed over (and released) one by one; the attachments are saved after them, and only when
 * at least one file of the chat reached the disk (without it there is nothing for them to belong to).
 */
export async function saveIndividually(ctx: ItemContext, item: ResolvedQueueItem, result: ExportChatResult): Promise<SaveReport> {
  const { io, job, texts, progress, signal } = ctx;
  const report = emptyReport(result.outputs.length);

  // Taken out of the result so that each file's data can be freed as soon as it was handed over.
  const pending = result.outputs.splice(0);
  progress.phase('saving');
  for (let output = pending.shift(); output !== undefined; output = pending.shift()) {
    throwIfCancelled(signal);
    try {
      const downloadId = await io.saveBlob(job.jobId, item.key, new Blob([blobPartOf(output.data)], { type: output.mime }), output.path);
      report.files.push({ filename: output.path, downloadId });
      report.savedOutputs += 1;
    } catch (error) {
      report.outputError ??= texts.saveFailure(error);
    }
  }

  const attachments = uniqueByPath(result.attachments, (attachment) => attachment.path);
  if (report.savedOutputs === 0 || attachments.length === 0) return report;
  throwIfCancelled(signal);
  progress.phase('attachments');
  const fresh = await refreshStale(ctx.client, attachments, ctx.deps.now(), signal);
  for (const attachment of attachments) {
    throwIfCancelled(signal);
    const url = fresh.get(attachment.url) ?? attachment.url;
    if (!isDownloadable(url)) {
      report.attachmentsMissed += 1;
      continue;
    }
    try {
      const downloadId = await io.saveUrl(job.jobId, item.key, url, attachment.path);
      report.files.push({ filename: attachment.path, downloadId });
    } catch {
      report.attachmentsMissed += 1; // the chat is saved; only this copy is missing
    }
  }
  return report;
}

/** ZIP mode: the chat's files and attachments go into the archive of the job. */
export async function saveToArchive(ctx: ItemContext, result: ExportChatResult): Promise<SaveReport> {
  const { texts, progress, signal } = ctx;
  const zip = ctx.archive;
  if (zip === null) throw new Error('saveToArchive needs the job archive.');
  const report = emptyReport(result.outputs.length);

  const downloaded: Array<{ path: string; blob: Blob }> = [];
  const attachments = uniqueByPath(result.attachments, (attachment) => attachment.zipPath);
  if (result.outputs.length > 0 && attachments.length > 0) {
    progress.phase('attachments');
    const fresh = await refreshStale(ctx.client, attachments, ctx.deps.now(), signal);
    for (const attachment of attachments) {
      throwIfCancelled(signal);
      const full = zip.limitFor(0);
      if (full !== null) {
        report.limitError ??= texts.zipLimit(full); // nothing more fits: do not download what cannot be kept
        break;
      }
      const url = fresh.get(attachment.url) ?? attachment.url;
      const blob = isDownloadable(url) ? await downloadAttachment(ctx.deps.fetch, url, signal) : null;
      if (blob === null) report.attachmentsMissed += 1;
      else downloaded.push({ path: attachment.zipPath, blob });
    }
  }

  // From here on it is local work that is not interrupted: a chat is in the archive completely or not at all.
  progress.phase('saving');
  const pending = result.outputs.splice(0);
  for (let output = pending.shift(); output !== undefined; output = pending.shift()) {
    try {
      const path = await zip.add(output.zipPath, output.data);
      ctx.usedZipPaths.add(path);
      report.files.push({ filename: path, downloadId: null });
      report.savedOutputs += 1;
    } catch (error) {
      report.outputError ??= error instanceof ZipLimitError ? texts.zipLimit(error.limit) : texts.thrown(error);
    }
  }
  if (report.savedOutputs === 0) return report;
  for (const { path, blob } of downloaded) {
    try {
      const entry = await zip.add(path, blob);
      ctx.usedZipPaths.add(entry);
      report.files.push({ filename: entry, downloadId: null });
    } catch (error) {
      if (error instanceof ZipLimitError) {
        report.limitError ??= texts.zipLimit(error.limit);
        break;
      }
      report.attachmentsMissed += 1;
    }
  }
  return report;
}
