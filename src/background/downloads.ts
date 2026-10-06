/**
 * Saving files for the engine (docs/PLAN.md §3, §5.3, §8) and keeping the offscreen document alive exactly as long as its blob
 * URLs are needed:
 *  - `engine/saveBlob` (a blob URL of the offscreen document) and `engine/saveUrl` (a Discord CDN URL, attachments saved one by
 *    one) end in `chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false })` after the filename
 *    and the URL were checked again;
 *  - every blob download is remembered (`BgState.blobs`, in session storage so a worker restart does not forget it) until
 *    Chrome reports it complete or interrupted; then the engine is told to revoke the blob URL (`engine/revoke`);
 *  - once no job is running and no blob download is pending, the offscreen document is closed.
 */
import type { BgResponse } from '@/shared';
import { fail, invalid, ok } from './response';
import { closeOffscreenDocument, offscreenLock } from './offscreen';
import { isActiveJob, readBgState, readJob, updateBgState } from './store';
import { describeError } from './util';
import { isDiscordCdnUrl, isOwnBlobUrl, isSafeRelativePath } from './validate';

export type SaveKind = 'blob' | 'url';

/** Tells the offscreen document to free a blob URL. Nobody listening (document already gone) is fine. */
function revokeBlobUrl(url: string): void {
  chrome.runtime.sendMessage({ to: 'offscreen', type: 'engine/revoke', url }).catch(() => undefined);
}

/** Removes a download from the pending set and returns the blob URL it was reading (null: not ours / already settled). */
function takePendingBlob(downloadId: number): Promise<string | null> {
  return updateBgState((state) => {
    const key = String(downloadId);
    const url = state.blobs[key];
    delete state.blobs[key];
    return url ?? null;
  });
}

/**
 * `engine/saveBlob` and `engine/saveUrl`. The job must be the running one. Answers `{ downloadId }`.
 * A blob URL has to be one of this extension's own; a CDN URL has to be https on the Discord CDN; the filename a relative
 * path without absolute parts, `..` or empty segments.
 */
export async function saveDownload(kind: SaveKind, message: Record<string, unknown>): Promise<BgResponse<{ downloadId: number }>> {
  const { jobId, itemKey, url, filename } = message;
  if (typeof jobId !== 'string') return invalid('jobId must be a string');
  if (kind === 'url' ? typeof itemKey !== 'string' : itemKey !== null && typeof itemKey !== 'string') return invalid('itemKey is malformed');
  if (!isSafeRelativePath(filename)) return invalid('filename must be a relative path without "..", empty segments or forbidden characters');
  if (kind === 'blob' ? !isOwnBlobUrl(url, chrome.runtime.id) : !isDiscordCdnUrl(url)) {
    return invalid(kind === 'blob' ? 'url must be a blob URL of the download engine' : 'url must be an https URL on the Discord CDN');
  }
  const job = await readJob();
  if (!isActiveJob(job) || job.jobId !== jobId) return invalid('no running job with that id');

  let downloadId: number;
  try {
    downloadId = await chrome.downloads.download({ url: url as string, filename, conflictAction: 'uniquify', saveAs: false });
  } catch (error) {
    return fail('unknown', describeError(error));
  }
  if (typeof downloadId !== 'number') return fail('unknown', 'The browser did not start the download.');

  await updateBgState((state) => {
    state.lastDownloadId = downloadId;
    if (kind === 'blob') state.blobs[String(downloadId)] = url as string;
  });
  // A small file can finish before it was recorded above, and nothing would report it again: look once more.
  if (kind === 'blob') await settleIfFinished(downloadId);
  return ok({ downloadId });
}

async function settleIfFinished(downloadId: number): Promise<void> {
  try {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item !== undefined && item.state === 'in_progress') return;
    await settlePending(downloadId);
  } catch {
    // the download vanished or search failed: settleAndClose reconciles later
  }
}

async function settlePending(downloadId: number): Promise<void> {
  const url = await takePendingBlob(downloadId);
  if (url === null) return;
  revokeBlobUrl(url);
  await settleAndClose();
}

/** `chrome.downloads.onChanged`: one of our blob downloads reached 'complete' or 'interrupted' -> revoke its blob URL, maybe close the document. */
export async function onDownloadChanged(delta: chrome.downloads.DownloadDelta): Promise<void> {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  await settlePending(delta.id);
}

/**
 * Closes the offscreen document when nothing needs it any more: no job is running and every blob download has settled. The
 * pending set is reconciled with Chrome first (a completion event can be missed while the worker is suspended). Safe to call
 * at any time; never rejects.
 */
export function settleAndClose(): Promise<void> {
  return offscreenLock
    .run(async () => {
      if (isActiveJob(await readJob())) return;
      const { blobs } = await readBgState();
      for (const id of Object.keys(blobs)) {
        const [item] = await chrome.downloads.search({ id: Number(id) });
        if (item !== undefined && item.state === 'in_progress') continue;
        const url = await takePendingBlob(Number(id));
        if (url !== null) revokeBlobUrl(url);
      }
      if (Object.keys((await readBgState()).blobs).length > 0) return;
      await closeOffscreenDocument();
    })
    .catch(() => undefined);
}

/**
 * `downloads/show`: reveal a file in the file manager; null (or a download that no longer exists) opens the default
 * downloads folder.
 */
export async function showDownload(downloadId: unknown): Promise<BgResponse> {
  if (downloadId !== null && !(typeof downloadId === 'number' && Number.isInteger(downloadId) && downloadId >= 0)) {
    return invalid('downloadId must be null or a non-negative integer');
  }
  try {
    if (downloadId === null) chrome.downloads.showDefaultFolder();
    else chrome.downloads.show(downloadId);
    return ok();
  } catch (error) {
    return fail('unknown', describeError(error));
  }
}

/** Notification click: show the job's last file, or the downloads folder when there is none (or it cannot be shown). */
export async function showJobFolder(downloadId: number | null): Promise<void> {
  const result = await showDownload(downloadId);
  if (!result.ok && downloadId !== null) await showDownload(null);
}
