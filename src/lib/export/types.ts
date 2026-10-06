import type { ContentOptions, ExportFormat } from '@/shared/types';
import type { ChannelKind } from '../discord/model';
import type { Message, Snowflake } from '../discord/types';
import type { NameResolver } from '../markdown/types';

/** Language of the fixed strings inside exported files (headers, system messages, "Pinned a message" ...). */
export type ExportLocale = 'ko' | 'en';

/** One chat (channel / DM / thread) as the writers see it: self-contained, carries everything needed for file headers. */
export interface ExportTarget {
  channelId: Snowflake;
  kind: ChannelKind;
  channelName: string;
  guildId: Snowflake | null;
  /** null for DMs / group DMs. */
  guildName: string | null;
  categoryName: string | null;
  /** Threads: the parent channel name. */
  parentChannelName: string | null;
  topic: string | null;
  /** Guild icon (or DM avatar) URL; optional decoration for headers. */
  iconUrl?: string | null;
}

export type Chunk = string | Uint8Array;

/**
 * What a file of one chat holds and how it is written. Without the optional fields the file is the plain export of every message
 * (the v1 output): all content included, attachments as CDN links, a complete export of the stated scope.
 */
export interface WriterOptions {
  /**
   * The requested scope, for the header of the file. A count with a range means the newest `limit` messages INSIDE the range;
   * all three null means the whole history.
   */
  after: string | null;
  before: string | null;
  limit: number | null;
  /** HTML export colour scheme (`<html data-theme>`). */
  htmlTheme: 'dark' | 'light';
  locale: ExportLocale;
  /** IANA time zone used to print timestamps. */
  timeZone: string;
  /** Only the messages after the previous export were requested (shown in the header). */
  incremental?: boolean;
  /** The export stopped early, so the file may lack messages (shown in the header / info). */
  partial?: boolean;
  /** Which kinds of messages and message parts to leave out. Default: nothing is left out. */
  content?: ContentOptions;
  /**
   * Attachment id -> path of the saved copy, relative to the exported file. HTML and Markdown link to it instead of the CDN;
   * TXT, CSV, XLSX and JSON print it next to the URL. Attachments without an entry stay CDN links.
   */
  attachmentPaths?: ReadonlyMap<string, string>;
}

export interface WriterContext {
  target: ExportTarget;
  options: WriterOptions;
  exportedAt: Date;
  names: NameResolver;
}

export interface WriterSummary {
  messageCount: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
}

/**
 * Streaming-ish writer for ONE chat. The caller feeds messages in **chronological order** (oldest -> newest),
 * in consecutive batches (a batch never overlaps another). Writers keep their own state between batches
 * (e.g. last author for grouping, last date for day dividers). Output chunks are concatenated in call order.
 * Binary formats (xlsx) may return everything from `end()`.
 */
export interface ExportWriter {
  start(): Chunk[];
  write(batch: readonly Message[]): Chunk[];
  end(summary: WriterSummary): Chunk[];
}

/** One export format: its file type and the factory of its writers. */
export interface FormatModule {
  id: ExportFormat;
  /** Human label, e.g. "HTML (.html)". */
  label: string;
  /** File extension without dot. */
  extension: string;
  mime: string;
  createWriter(ctx: WriterContext): ExportWriter;
}
