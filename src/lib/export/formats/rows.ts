import type { Attachment, Embed, Message } from '../../discord/types';
import type { MarkdownContext } from '../../markdown/types';
import {
  forwardView,
  getStrings,
  normalizeEmbed,
  referenceView,
  stickerView,
  systemMessageText,
  type ReferenceView,
} from '../../message';
import type { WriterContext } from '../types';
import {
  attachmentView,
  authorName,
  isBotMessage,
  listOf,
  markdownContext,
  plainText,
  pollLines,
  reactionParts,
} from './parts';
import { cleanText, formatStamp, getExportStrings, oneLine, resolveTimeZone, truncate, type ColumnKey, type ExportLocale } from './text';

/**
 * Tabular model shared by CSV and XLSX: one row per message, every cell a string.
 *
 * Cell values are plain text, not neutralised: CSV prefixes a quote where a spreadsheet could read a formula
 * (csv.ts), XLSX needs nothing because its builder only ever writes string cells.
 * Message and author ids are strings on purpose: snowflakes exceed 2^53, a number cell would round them.
 */

export interface RowColumn {
  key: ColumnKey;
  /** Excel column width in characters. */
  width: number;
  /** Message bodies and lists span several lines. */
  wrap: boolean;
  /** The cell holds a Discord id (a bare run of digits): a spreadsheet must not read it as a number (see csv.ts). */
  id?: true;
}

export const ROW_COLUMNS: readonly RowColumn[] = [
  { key: 'messageId', width: 22, wrap: false, id: true },
  { key: 'timestamp', width: 20, wrap: false },
  { key: 'edited', width: 20, wrap: false },
  { key: 'authorId', width: 22, wrap: false, id: true },
  { key: 'author', width: 20, wrap: false },
  { key: 'bot', width: 6, wrap: false },
  { key: 'content', width: 80, wrap: true },
  { key: 'attachments', width: 50, wrap: true },
  { key: 'embeds', width: 50, wrap: true },
  { key: 'stickers', width: 20, wrap: true },
  { key: 'reactions', width: 24, wrap: true },
  { key: 'replyTo', width: 22, wrap: false, id: true },
  { key: 'type', width: 12, wrap: false },
];

const LOCAL_FILES_COLUMN: RowColumn = { key: 'localFiles', width: 50, wrap: true };

/**
 * The columns of a table. `withLocalFiles` (the export saves attachment copies) adds "Local Files" right behind
 * "Attachments": one saved path per line, in the order of the attachment lines. Without it the table is the v1 layout.
 */
export function rowColumns(withLocalFiles: boolean): readonly RowColumn[] {
  if (!withLocalFiles) return ROW_COLUMNS;
  const at = ROW_COLUMNS.findIndex((column) => column.key === 'attachments') + 1;
  return [...ROW_COLUMNS.slice(0, at), LOCAL_FILES_COLUMN, ...ROW_COLUMNS.slice(at)];
}

export function rowHeaders(locale: ExportLocale, withLocalFiles = false): string[] {
  const { columns } = getExportStrings(locale);
  return rowColumns(withLocalFiles).map((column) => columns[column.key]);
}

/** One-line embed summaries stay short; the full text is in the TXT / Markdown / JSON exports. */
const DESCRIPTION_MAX = 300;
const FIELD_MAX = 150;
const PART_MAX = 200;

/** Ids are snowflake strings; anything else the API might send is stringified rather than dropped. */
function idText(value: unknown): string {
  return typeof value === 'string' ? oneLine(value) : typeof value === 'number' ? String(value) : '';
}

/** `title | description | Name: value; ... | footer | url`, one line per embed. */
function embedSummary(embed: Embed, md: MarkdownContext): string {
  const e = normalizeEmbed(embed);
  const parts: string[] = [];
  const add = (text: string | null, max = PART_MAX): void => {
    const line = oneLine(text);
    if (line !== '') parts.push(truncate(line, max));
  };
  add(e.author?.name ?? null);
  add(e.title);
  add(e.description === null ? null : plainText(e.description, md), DESCRIPTION_MAX);
  for (const field of e.fields) {
    const name = oneLine(field.name);
    const value = oneLine(plainText(field.value, md));
    add(name === '' ? value : value === '' ? name : `${name}: ${value}`, FIELD_MAX);
  }
  add(e.footer?.text ?? null);
  add(e.titleUrl);
  if (parts.length === 0) add(e.provider);
  return parts.length > 0 ? parts.join(' | ') : getStrings(md.locale).embed;
}

/** 'message' | 'reply' | 'forward' | 'system' | 'type-<n>' for other user-authored kinds (slash commands ...). */
function typeLabel(message: Message, isSystem: boolean, reference: ReferenceView | null): string {
  if (isSystem) return 'system';
  if (reference?.kind === 'forward') return 'forward';
  if (reference?.kind === 'reply') return 'reply';
  const type = typeof message.type === 'number' && Number.isFinite(message.type) ? message.type : 0;
  return type === 0 ? 'message' : `type-${type}`;
}

/** Does the table have the "Local Files" column? It does exactly when the export saves attachment copies (a path map is given). */
export function hasLocalFilesColumn(options: WriterContext['options']): boolean {
  return options.attachmentPaths !== undefined;
}

/**
 * Returns the function that turns one message into the cells of a row (same order as `rowColumns(hasLocalFilesColumn(...))`).
 *
 * Content holds the text; for system messages the localised sentence; polls and forwarded messages are appended
 * as text so that no message looks empty. Attachments (also those of a forward) are one URL per line, or the file
 * name when the URL is not http(s). With saved copies, "Local Files" holds the path of each copy on the line of its
 * attachment (a line stays empty for an attachment without a copy). Reply To is the id of the replied-to message.
 */
export function createRowBuilder(ctx: WriterContext): (message: Message) => string[] {
  const { locale } = ctx.options;
  const timeZone = resolveTimeZone(ctx.options.timeZone);
  const md = markdownContext(ctx);
  const strings = getStrings(locale);
  const withLocalFiles = hasLocalFilesColumn(ctx.options);
  const paths = ctx.options.attachmentPaths;

  return (message) => {
    const system = systemMessageText(message, locale);
    const reference = system === null ? referenceView(message, locale) : null;
    const forwards = system === null ? forwardView(message) : [];

    const content: string[] = [];
    if (system !== null) {
      content.push(oneLine(system));
    } else {
      const text = plainText(message.content, md);
      if (text !== '') content.push(text);
      if (message.poll) {
        const [question = '', ...rest] = pollLines(message.poll, locale);
        content.push([`${strings.poll} ${question}`.trimEnd(), ...rest].join('\n'));
      }
      for (const forward of forwards) {
        const text = plainText(forward.content, md);
        content.push(text === '' ? strings.forwarded : `${strings.forwarded}\n${text}`);
      }
    }

    const attachments: string[] = [];
    const localFiles: string[] = [];
    const embeds: string[] = [];
    const addAttachments = (list: readonly Attachment[]): void => {
      for (const attachment of list) {
        const view = attachmentView(attachment, locale, paths);
        attachments.push(view.url ?? view.name);
        localFiles.push(view.local ?? '');
      }
    };
    const addEmbeds = (list: readonly Embed[]): void => {
      for (const embed of list) embeds.push(embedSummary(embed, md));
    };
    addAttachments(listOf(message.attachments));
    addEmbeds(listOf(message.embeds));
    for (const forward of forwards) {
      addAttachments(forward.attachments);
      addEmbeds(forward.embeds);
    }

    const stickers = listOf(message.sticker_items)
      .map((sticker) => oneLine(stickerView(sticker).name))
      .filter((name) => name !== '');
    const reactions = reactionParts(message).map((reaction) => `${reaction.label} ${reaction.count}`);
    const edited = message.edited_timestamp ? formatStamp(message.edited_timestamp, timeZone) : '';
    const replyTo =
      reference?.kind === 'reply' ? idText(message.message_reference?.message_id ?? message.referenced_message?.id) : '';

    // Trailing empty lines carry no information (and would end the cell with a line break).
    while (localFiles.length > 0 && localFiles[localFiles.length - 1] === '') localFiles.pop();

    const cells = [
      idText(message.id),
      formatStamp(message.timestamp, timeZone),
      edited,
      idText(message.author?.id),
      authorName(message, locale),
      isBotMessage(message) ? 'Y' : '',
      cleanText(content.join('\n')),
      cleanText(attachments.join('\n')),
      ...(withLocalFiles ? [cleanText(localFiles.join('\n'))] : []),
      cleanText(embeds.join('\n')),
      stickers.join('; '),
      reactions.join('; '),
      replyTo,
      typeLabel(message, system !== null, reference),
    ];
    return cells;
  };
}
