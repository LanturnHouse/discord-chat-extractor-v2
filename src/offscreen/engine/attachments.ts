/**
 * The attachments of a chat (docs/PLAN.md §6.5): which ones to save (one per target path), fresh URLs for the stale ones, and
 * the bytes of one from the CDN (ZIP mode; in individual-file mode the background downloads the URL itself).
 */
import { isAbortError, isAttachmentUrlStale, isRefreshableUrl, refreshAttachmentUrls } from '@/lib';
import type { ChatAttachment, DiscordClient } from '@/lib';

/** The attachments with one entry per path (the first one wins): two entries for one path would only overwrite each other. */
export function uniqueByPath(attachments: readonly ChatAttachment[], pathOf: (attachment: ChatAttachment) => string): ChatAttachment[] {
  const seen = new Set<string>();
  const unique: ChatAttachment[] = [];
  for (const attachment of attachments) {
    const path = pathOf(attachment);
    if (seen.has(path)) continue;
    seen.add(path);
    unique.push(attachment);
  }
  return unique;
}

/**
 * Fresh signed URLs for the attachments whose URL is stale (older than six hours, see `isAttachmentUrlStale`): original -> new.
 * Asks Discord only when there is something stale; a URL it does not answer for is simply absent (use the original then). Only a
 * cancel rejects.
 */
export async function refreshStale(client: DiscordClient, attachments: readonly ChatAttachment[], nowMs: number, signal: AbortSignal): Promise<Map<string, string>> {
  const stale = attachments.map((attachment) => attachment.url).filter((url) => isAttachmentUrlStale(url, nowMs));
  return stale.length === 0 ? new Map() : refreshAttachmentUrls(client, stale, { signal });
}

/** Only Discord's attachment CDN is ever downloaded from (the extension has no permission for anything else). */
export const isDownloadable = (url: string): boolean => isRefreshableUrl(url);

/**
 * The bytes of an attachment, straight from the CDN: no cookies, no authorization (the signed URL is the permission). `null`
 * when it could not be downloaded (an error status, no network); a cancel rejects.
 */
export async function downloadAttachment(fetchFn: typeof fetch, url: string, signal: AbortSignal): Promise<Blob | null> {
  try {
    const response = await fetchFn(url, { credentials: 'omit', signal });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return null;
    }
    return await response.blob();
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error;
    return null;
  }
}
