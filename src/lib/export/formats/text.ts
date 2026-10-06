import { oneLine } from '../../message/text';
import { formatDateTime } from '../../message/time';
import type { ExportLocale, WriterOptions } from '../types';

/**
 * Fixed words of the text-based export formats (TXT, Markdown, CSV, XLSX) and the helpers that make
 * attacker-controlled text safe to embed in them. Message semantics (system messages, reply previews, byte sizes)
 * live in src/lib/message; this file only holds what is specific to the exported documents.
 */

export type { ExportLocale } from '../types';

export const GENERATOR_NAME = 'Discord Chat Extractor';

export type ColumnKey =
  | 'messageId'
  | 'timestamp'
  | 'edited'
  | 'authorId'
  | 'author'
  | 'bot'
  | 'content'
  | 'attachments'
  | 'localFiles'
  | 'embeds'
  | 'stickers'
  | 'reactions'
  | 'replyTo'
  | 'type';

export interface ExportStrings {
  server: string;
  channel: string;
  topic: string;
  range: string;
  exportedAt: string;
  generator: string;
  messages: string;
  firstMessage: string;
  lastMessage: string;
  /**
   * Describes which messages were requested; `null` means unbounded (no start, no end, no count). A count always means the
   * newest messages (inside the range, when there is one).
   */
  rangeText: (after: string | null, before: string | null, limit: number | null) => string;
  /** Header rows that only appear for an incremental / partial export: label and value. */
  incremental: string;
  incrementalValue: string;
  status: string;
  partialValue: string;
  /** Name of the worksheet that describes the scope of an XLSX export. */
  infoSheet: string;

  /** Section titles (TXT prints them as `{Title}`). */
  attachments: string;
  embed: string;
  stickers: string;
  poll: string;
  forwarded: string;
  reactions: string;
  /** Single sticker, used where a sticker cannot be shown as an image. */
  sticker: string;

  edited: string;
  bot: string;
  replyingTo: (name: string) => string;

  votes: (n: number) => string;
  totalVotes: (n: number) => string;
  multipleChoice: string;
  pollEnded: string;

  columns: Record<ColumnKey, string>;
}

/** "1,000" in both languages. */
const formatCount = (n: number): string => n.toLocaleString('en-US');

const EN: ExportStrings = {
  server: 'Server',
  channel: 'Channel',
  topic: 'Topic',
  range: 'Range',
  exportedAt: 'Exported',
  generator: 'Generator',
  messages: 'Messages',
  firstMessage: 'First message',
  lastMessage: 'Last message',
  rangeText: (after, before, limit) => {
    const span = after !== null && before !== null ? `${after} to ${before}` : after !== null ? `from ${after}` : before !== null ? `until ${before}` : null;
    if (limit === null) return span ?? 'all messages';
    const count = `${formatCount(limit)} ${limit === 1 ? 'message' : 'messages'}`;
    return span === null ? `newest ${count}` : `${span}: newest ${count}`;
  },
  incremental: 'Incremental',
  incrementalValue: 'only messages after the previous export',
  status: 'Status',
  partialValue: 'Partial - the export stopped early, so messages may be missing',
  infoSheet: 'Info',

  attachments: 'Attachments',
  embed: 'Embed',
  stickers: 'Stickers',
  poll: 'Poll',
  forwarded: 'Forwarded',
  reactions: 'Reactions',
  sticker: 'Sticker',

  edited: 'edited',
  bot: 'BOT',
  replyingTo: (name) => `Replying to ${name}:`,

  votes: (n) => `${n} ${n === 1 ? 'vote' : 'votes'}`,
  totalVotes: (n) => `${n} ${n === 1 ? 'vote' : 'votes'} in total`,
  multipleChoice: 'Multiple choice',
  pollEnded: 'Ended',

  columns: {
    messageId: 'Message ID',
    timestamp: 'Timestamp',
    edited: 'Edited',
    authorId: 'Author ID',
    author: 'Author',
    bot: 'Bot',
    content: 'Content',
    attachments: 'Attachments',
    localFiles: 'Local Files',
    embeds: 'Embeds',
    stickers: 'Stickers',
    reactions: 'Reactions',
    replyTo: 'Reply To',
    type: 'Type',
  },
};

const KO: ExportStrings = {
  server: '서버',
  channel: '채널',
  topic: '주제',
  range: '범위',
  exportedAt: '내보낸 시각',
  generator: '생성 도구',
  messages: '메시지 수',
  firstMessage: '첫 메시지',
  lastMessage: '마지막 메시지',
  rangeText: (after, before, limit) => {
    const span = after !== null && before !== null ? `${after} ~ ${before}` : after !== null ? `${after}부터` : before !== null ? `${before}까지` : null;
    if (limit === null) return span ?? '전체 메시지';
    const count = `${formatCount(limit)}개`;
    return span === null ? `최근 ${count} 메시지` : `${span} 최근 ${count}`;
  },
  incremental: '증분',
  incrementalValue: '지난번 내보낸 이후의 메시지만',
  status: '상태',
  partialValue: '부분 저장 - 중간에 중단되어 일부 메시지가 빠졌을 수 있습니다',
  infoSheet: '정보',

  attachments: '첨부 파일',
  embed: '임베드',
  stickers: '스티커',
  poll: '투표',
  forwarded: '전달된 메시지',
  reactions: '리액션',
  sticker: '스티커',

  edited: '수정됨',
  bot: 'BOT',
  replyingTo: (name) => `${name}님에게 답장:`,

  votes: (n) => `${n}표`,
  totalVotes: (n) => `총 ${n}표`,
  multipleChoice: '복수 선택',
  pollEnded: '종료됨',

  columns: {
    messageId: '메시지 ID',
    timestamp: '시각',
    edited: '수정 시각',
    authorId: '작성자 ID',
    author: '작성자',
    bot: '봇',
    content: '내용',
    attachments: '첨부 파일',
    localFiles: '저장된 파일',
    embeds: '임베드',
    stickers: '스티커',
    reactions: '리액션',
    replyTo: '답장 대상',
    type: '유형',
  },
};

/** Total on purpose: an unexpected locale value falls back to English instead of throwing. */
export function getExportStrings(locale: ExportLocale | string): ExportStrings {
  return locale === 'ko' ? KO : EN;
}

// ---------------------------------------------------------------------------------------------------------------------
// text hygiene
// ---------------------------------------------------------------------------------------------------------------------

// Line/paragraph separators and bidi controls are invisible, so they are built from code points instead of being
// written into the source.
const fromCodes = (...codes: number[]): string => String.fromCharCode(...codes);
const LINE_SEPARATORS = fromCodes(0x2028, 0x2029);
const BIDI_CONTROLS = `${fromCodes(0x202a)}-${fromCodes(0x202e)}${fromCodes(0x2066)}-${fromCodes(0x2069)}`;
const REPLACEMENT_CHARACTER = fromCodes(0xfffd);
const LONE_SURROGATE_SOURCE = String.raw`[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]`;

/** Characters (and lone surrogates) that `cleanText` has to touch; lets clean input skip the replacements entirely. */
const NEEDS_CLEANING = new RegExp(
  String.raw`[\x00-\x08\x0B-\x1F\x7F-\x9F${LINE_SEPARATORS}${BIDI_CONTROLS}]|${LONE_SURROGATE_SOURCE}`,
);
/** CR, CRLF, VT, FF and the Unicode line/paragraph separators all mean "new line" to a reader. */
const LINE_BREAKS = new RegExp(String.raw`\r\n?|[\x0B\x0C${LINE_SEPARATORS}]`, 'g');
/** C0/C1 controls (tab and LF excepted) and bidi override/embedding/isolate characters, which are used for display spoofing. */
const CONTROLS = new RegExp(String.raw`[\x00-\x08\x0E-\x1F\x7F-\x9F${BIDI_CONTROLS}]`, 'g');
const LONE_SURROGATE = new RegExp(LONE_SURROGATE_SOURCE, 'g');

/**
 * Multi-line text that is safe to write into any export: LF line endings only, no control or bidi-override
 * characters, no lone surrogates. Non-strings become ''.
 */
export function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (!NEEDS_CLEANING.test(value)) return value;
  return value.replace(LINE_BREAKS, '\n').replace(CONTROLS, '').replace(LONE_SURROGATE, REPLACEMENT_CHARACTER);
}

/**
 * Single-line text for names, titles and file names (control and bidi characters become spaces, whitespace runs
 * collapse) and the surrogate-safe cut with an ellipsis. They are the ones the shared message module uses for system
 * lines and previews, so a name reads the same wherever it appears in an export.
 */
export { oneLine, truncate } from '../../message/text';

const zoneCache = new Map<string, string>();

/** The zone itself, or 'UTC' when it is not a valid IANA name (the time helpers fall back to UTC too, so labels stay truthful). */
export function resolveTimeZone(zone: string): string {
  let resolved = zoneCache.get(zone);
  if (resolved === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
      resolved = zone;
    } catch {
      resolved = 'UTC';
    }
    zoneCache.set(zone, resolved);
  }
  return resolved;
}

/** 'YYYY-MM-DD HH:mm:ss' in `timeZone`; an unparsable timestamp is shown as it was sent rather than dropped. */
export function formatStamp(iso: unknown, timeZone: string): string {
  if (typeof iso !== 'string') return '';
  return formatDateTime(iso, timeZone) || oneLine(iso);
}

/**
 * Which messages an export file holds, in the file's language ("all messages", "newest 200 messages",
 * "2026-01-01 00:00:00 to 2026-02-01 23:59:59: newest 500 messages", ...). `scope` is the scope the file was asked for:
 * a count means the newest messages, inside the range when there is one. Every text-based header and the HTML header card
 * print this one text.
 */
export function describeScope(scope: Pick<WriterOptions, 'after' | 'before' | 'limit'>, locale: ExportLocale, timeZone: string): string {
  const show = (iso: string | null): string | null => (iso === null ? null : formatStamp(iso, timeZone));
  // The caller validated the count before the export started, so a header never has to print a nonsensical one.
  const limit = typeof scope.limit === 'number' && Number.isInteger(scope.limit) && scope.limit > 0 ? scope.limit : null;
  return getExportStrings(locale).rangeText(show(scope.after), show(scope.before), limit);
}

/**
 * The header rows that describe the SCOPE of a file, as [label, value]: always the range, then "incremental" and "partial"
 * when they apply. Every text-based header and the HTML header card show these rows in this order; without the flags the
 * only row is the range, which is exactly the header v1 wrote.
 */
export function scopeRows(options: WriterOptions, timeZone: string): Array<readonly [label: string, value: string]> {
  const strings = getExportStrings(options.locale);
  const rows: Array<readonly [string, string]> = [[strings.range, describeScope(options, options.locale, timeZone)]];
  if (options.incremental === true) rows.push([strings.incremental, strings.incrementalValue]);
  if (options.partial === true) rows.push([strings.status, strings.partialValue]);
  return rows;
}

/**
 * Whether a file is worth an explanation of its scope beyond "all messages": a count, a range, an incremental export or an
 * export that stopped early. (The XLSX export adds its info worksheet only then, so a plain full export stays a single sheet.)
 */
export function hasRestrictedScope(options: Pick<WriterOptions, 'after' | 'before' | 'limit' | 'incremental' | 'partial'>): boolean {
  return options.after !== null || options.before !== null || options.limit !== null || options.incremental === true || options.partial === true;
}

// ---------------------------------------------------------------------------------------------------------------------
// TXT structure shielding
// ---------------------------------------------------------------------------------------------------------------------

/** Literal `{Section}` markers of both locales; a message line equal to one of them would fake a section. */
const SECTION_MARKERS: ReadonlySet<string> = new Set(
  [EN, KO].flatMap((s) => [s.attachments, s.embed, s.stickers, s.poll, s.forwarded, s.reactions].map((title) => `{${title}}`)),
);
const MAX_MARKER_LENGTH = Math.max(...[...SECTION_MARKERS].map((marker) => marker.length));
/** `[2026-10-05 12:00` is enough to recognise a message or system-message line. */
const STAMP_LINE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

/**
 * TXT lets readers (and scripts) tell structure from content by looking at the start of a line. A message that
 * contains a line which looks like a message header, a section marker, a reply line or a rule would forge structure,
 * so such a line gets a leading backslash. Every user-derived line of a TXT export passes through here.
 */
export function shieldLine(line: string): string {
  let i = 0;
  while (i < line.length && (line.charCodeAt(i) === 0x20 || line.charCodeAt(i) === 0x09)) i += 1;
  switch (line.charCodeAt(i)) {
    case 0x5b: // [
      return STAMP_LINE.test(line.slice(i, i + 17)) ? `\\${line}` : line;
    case 0x7b: // {
      return line.length - i <= MAX_MARKER_LENGTH + 4 && SECTION_MARKERS.has(line.slice(i).trimEnd()) ? `\\${line}` : line;
    case 0x3e: // >
      return line.startsWith('> ↪', i) ? `\\${line}` : line;
    case 0x3d: // =
      return line.startsWith('===', i) ? `\\${line}` : line;
    case 0x21aa: // ↪
      return `\\${line}`;
    default:
      return line;
  }
}
