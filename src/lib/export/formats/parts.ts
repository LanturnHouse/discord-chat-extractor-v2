import type { Attachment, Message, Poll } from '../../discord/types';
import { parseMarkdown } from '../../markdown/parse';
import { renderText } from '../../markdown/renderText';
import type { MarkdownContext } from '../../markdown/types';
import { safeUrl } from '../../markdown/url';
import {
  classifyAttachment,
  displayName,
  formatBytes,
  getStrings,
  isSpoilerAttachment,
  pollView,
  reactionView,
  type AttachmentKind,
} from '../../message';
import type { ExportTarget, WriterContext } from '../types';
import { cleanText, getExportStrings, oneLine, resolveTimeZone, type ExportLocale } from './text';

/**
 * Message pieces shared by the text-based formats. Everything returned here is already safe to print: control
 * characters and bidi overrides are gone, names are single-line, URLs are http(s) only.
 */

export function markdownContext(ctx: WriterContext): MarkdownContext {
  return { names: ctx.names, locale: ctx.options.locale, timeZone: resolveTimeZone(ctx.options.timeZone) };
}

/** An API list that may be missing or garbage. */
export function listOf<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

export function authorName(message: Message, locale: ExportLocale): string {
  return (message.author ? oneLine(displayName(message.author)) : '') || getStrings(locale).unknownUser;
}

/** Bots and webhooks, which post without a human behind them. */
export function isBotMessage(message: Message): boolean {
  return message.author?.bot === true || Boolean(message.webhook_id);
}

/** Message text as readable plain text: markdown syntax removed, mentions resolved, spoilers visible, custom emoji as `:name:`. */
export function plainText(content: unknown, md: MarkdownContext): string {
  if (typeof content !== 'string' || content === '') return '';
  return cleanText(renderText(parseMarkdown(cleanText(content)), md)).trim();
}

/**
 * A saved copy's path as the exported file may use it: relative, forward slashes, no empty / `.` / `..` segments, no control
 * characters. Anything else (an absolute path, a traversal, a first segment with a colon that reads as a URL scheme or a drive
 * letter: `javascript:...`, `C:/...`) is refused: null. (The paths the engine builds never have a colon: file names are sanitised.)
 */
export function safeLocalPath(path: unknown): string | null {
  if (typeof path !== 'string' || path === '' || path.length > 1024) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(path) || path.startsWith('/')) return null;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  if (segments[0]!.includes(':')) return null;
  return path;
}

/** Everything that is not a letter (of any script), digit, combining mark or `-_.~` is percent-encoded (as UTF-8). */
const NOT_URL_SAFE = /[^\p{L}\p{N}\p{M}\-_.~]/gu;
const encoder = new TextEncoder();

function percentEncode(character: string): string {
  return Array.from(encoder.encode(character), (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
}

/**
 * A local path as a URL reference for `href` / `src` / Markdown destinations: every segment percent-encoded, so spaces, `#`,
 * `?`, quotes and brackets can neither end the reference early nor change its meaning, while Korean (or any other) letters
 * stay readable. null for a path `safeLocalPath` refuses.
 */
export function localHref(path: unknown): string | null {
  const safe = safeLocalPath(path);
  return safe === null ? null : safe.split('/').map((segment) => segment.replace(NOT_URL_SAFE, percentEncode)).join('/');
}

/** The path of the saved copy of `attachment`, or null when there is none (or it is not a path the file may link to). */
export function localPathOf(attachment: Attachment, paths: ReadonlyMap<string, string> | undefined): string | null {
  if (paths === undefined || typeof attachment?.id !== 'string') return null;
  return safeLocalPath(paths.get(attachment.id));
}

export interface AttachmentView {
  /** Single-line file name. */
  name: string;
  /** "12.3 KB". */
  size: string;
  /** Normalised http(s) URL; null for anything else (the demo client uses data: URIs). */
  url: string | null;
  /** Path of the saved copy relative to the exported file, when the export saved one. */
  local: string | null;
  kind: AttachmentKind;
  spoiler: boolean;
  /** Alt text the uploader gave, single-line. */
  description: string | null;
}

export function attachmentView(attachment: Attachment, locale: ExportLocale, paths?: ReadonlyMap<string, string>): AttachmentView {
  const url = typeof attachment?.url === 'string' ? safeUrl(attachment.url) : null;
  return {
    name: oneLine(attachment?.filename) || oneLine(attachment?.id) || getStrings(locale).attachment,
    size: formatBytes(attachment?.size, locale),
    url,
    local: localPathOf(attachment, paths),
    kind: classifyAttachment(attachment),
    spoiler: isSpoilerAttachment(attachment),
    description: oneLine(attachment?.description) || null,
  };
}

/** Poll as plain lines: question, numbered answers with vote counts, then a summary line. */
export function pollLines(poll: Poll, locale: ExportLocale): string[] {
  const strings = getExportStrings(locale);
  const view = pollView(poll);
  const lines: string[] = [];
  const question = oneLine(view.question);
  if (question !== '') lines.push(question);
  view.answers.forEach((answer, index) => {
    const label = [answer.emoji === null ? '' : oneLine(answer.emoji), oneLine(answer.text)].filter((part) => part !== '').join(' ');
    const votes = answer.votes === null ? '' : `: ${strings.votes(answer.votes)}`;
    lines.push(`${index + 1}. ${label}${votes}`);
  });
  const facts: string[] = [];
  if (view.multiselect) facts.push(strings.multipleChoice);
  if (view.finalized) facts.push(strings.pollEnded);
  if (view.totalVotes !== null) facts.push(strings.totalVotes(view.totalVotes));
  if (facts.length > 0) lines.push(facts.join(' · '));
  return lines;
}

export interface ReactionPart {
  /** Unicode emoji or `:name:`. */
  label: string;
  count: number;
}

export function reactionParts(message: Message): ReactionPart[] {
  return listOf(message.reactions).map((reaction) => {
    const view = reactionView(reaction);
    return { label: oneLine(view.label) || '?', count: view.count };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// document metadata
// ---------------------------------------------------------------------------------------------------------------------

const isDirectMessage = (target: ExportTarget): boolean => target.kind === 'dm' || target.kind === 'group-dm';

/** "#general", "#general / thread name" or the DM's name. */
export function channelDisplay(target: ExportTarget): string {
  const name = oneLine(target.channelName) || target.channelId;
  if (isDirectMessage(target)) return name;
  if (target.kind === 'thread') {
    const parent = oneLine(target.parentChannelName);
    return parent === '' ? name : `#${parent} / ${name}`;
  }
  return `#${name}`;
}

/** "Category / #general"; DMs have no category. */
export function channelPath(target: ExportTarget): string {
  const category = isDirectMessage(target) ? '' : oneLine(target.categoryName);
  return category === '' ? channelDisplay(target) : `${category} / ${channelDisplay(target)}`;
}
