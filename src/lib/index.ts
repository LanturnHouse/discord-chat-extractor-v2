/**
 * Public API of the core library: what the offscreen engine imports (docs/PLAN.md §6). Everything else under `src/lib` is
 * internal to the library and its tests. `src/lib` imports nothing outside itself except `@/shared`.
 *
 * The demo client (`./discord/mock`) is not part of it: it is for tests and development only.
 */

// --- Discord access ----------------------------------------------------------------------------------------------------
export { createDiscordClient } from './discord/api';
export type { LiveDiscordClientOptions, PauseEvent } from './discord/api';
export { createFetchTransport } from './discord/transport';
export type { FetchTransportOptions, HttpTransport, TransportRequest, TransportResponse } from './discord/transport';
export { DiscordApiError, isAbortError } from './discord/client';
export type { DiscordClient, DiscordErrorKind, GetMessagesOptions, RefreshedUrl, ThreadSearchPage, ThreadSearchQuery } from './discord/client';
export { collectMessages, collectMessagesResult, MAX_COLLECT_COUNT } from './discord/collect';
export type { CollectOptions, CollectResult } from './discord/collect';
export { listThreads } from './discord/threads';
export type { ListThreadsOptions, ThreadListResult } from './discord/threads';
export { isAttachmentUrlStale, isRefreshableUrl, refreshAttachmentUrls, URL_REFRESH_AFTER_MS } from './discord/attachmentUrls';
export type { RefreshUrlsOptions } from './discord/attachmentUrls';
export { abortableSleep, BLOCKED_RETRY_WAITS_MS, DEFAULT_PAGE_GAP, ITEM_GAP, NO_GAP, randomGapMs } from './discord/rateLimit';
export type { GapRange } from './discord/rateLimit';
export { compareSnowflakes, isSnowflake } from './discord/snowflake';
export type { Channel, Message, Snowflake } from './discord/types';

// --- Export ------------------------------------------------------------------------------------------------------------
export { describeChatError, exportChat } from './export/chat';
export type { ChatAttachment, ChatError, ChatOutput, ExportChatContext, ExportChatResult } from './export/chat';
export { MAX_ZIP_ENTRIES, MAX_ZIP_INPUT_BYTES, ZipAssembler, ZipLimitError } from './export/zip';
export type { ZipAddOptions, ZipData, ZipLimitKind } from './export/zip';
export { dateStamp, zipFileName, zipFilePath } from './export/filename';
export type { ZipNameOptions } from './export/filename';
export type { ExportLocale } from './export/types';
