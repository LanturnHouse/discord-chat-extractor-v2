import type { Attachment, Embed, Message } from '../../discord/types';
import type { MarkdownContext } from '../../markdown/types';
import {
  displayName,
  forwardView,
  getStrings,
  normalizeEmbed,
  referenceView,
  stickerView,
  systemMessageText,
  type ForwardSnapshotView,
} from '../../message';
import type { Chunk, ExportWriter, FormatModule, WriterContext, WriterSummary } from '../types';
import { applyContentOptions } from './content';
import {
  attachmentView,
  authorName,
  channelPath,
  isBotMessage,
  listOf,
  markdownContext,
  plainText,
  pollLines,
  reactionParts,
} from './parts';
import { formatStamp, GENERATOR_NAME, getExportStrings, oneLine, resolveTimeZone, scopeRows, shieldLine, type ExportLocale, type ExportStrings } from './text';

const RULE = '='.repeat(64);

interface Env {
  locale: ExportLocale;
  timeZone: string;
  strings: ExportStrings;
  md: MarkdownContext;
  /** Attachment id -> path of the saved copy (see `WriterOptions.attachmentPaths`). */
  paths: ReadonlyMap<string, string> | undefined;
}

function pushAll(target: string[], lines: readonly string[]): void {
  for (const line of lines) target.push(line);
}

/** Lines of free text (message body, embed description) with anything that looks like log structure defused. */
function bodyLines(text: string): string[] {
  return text === '' ? [] : text.split('\n').map(shieldLine);
}

const section = (title: string): string => `{${title}}`;

function attachmentLines(attachments: readonly Attachment[], env: Env): string[] {
  if (attachments.length === 0) return [];
  const lines = [section(env.strings.attachments)];
  for (const attachment of attachments) {
    const view = attachmentView(attachment, env.locale, env.paths);
    // The saved copy goes right behind the URL: `name (size) url -> path`.
    const where = [view.url, view.local === null ? null : `-> ${view.local}`].filter((part) => part !== null).join(' ');
    lines.push(shieldLine(where === '' ? `${view.name} (${view.size})` : `${view.name} (${view.size}) ${where}`));
  }
  return lines;
}

function embedLines(embed: Embed, env: Env): string[] {
  const e = normalizeEmbed(embed);
  const lines = [section(env.strings.embed)];
  const text = (value: string | null): void => {
    const line = oneLine(value);
    if (line !== '') lines.push(shieldLine(line));
  };
  text(e.author?.name ?? null);
  text(e.title);
  if (e.titleUrl !== null) lines.push(shieldLine(e.titleUrl));
  if (e.description !== null) pushAll(lines, bodyLines(plainText(e.description, env.md)));
  for (const field of e.fields) {
    const name = oneLine(field.name);
    const [first = '', ...rest] = plainText(field.value, env.md).split('\n');
    lines.push(shieldLine(name === '' ? first : `${name}: ${first}`));
    for (const line of rest) lines.push(shieldLine(`  ${line}`));
  }
  const footer = [oneLine(e.footer?.text), e.timestamp === null ? '' : formatStamp(e.timestamp, env.timeZone)].filter((part) => part !== '');
  if (footer.length > 0) lines.push(shieldLine(footer.join(' · ')));
  if (lines.length === 1) text(e.provider);
  return lines;
}

/** Attachments and embeds, which a message and a forwarded snapshot have in common. */
function mediaLines(attachments: readonly Attachment[], embeds: readonly Embed[], env: Env): string[] {
  const lines = attachmentLines(attachments, env);
  for (const embed of embeds) pushAll(lines, embedLines(embed, env));
  return lines;
}

function forwardLines(forward: ForwardSnapshotView, env: Env): string[] {
  const inner: string[] = [];
  if (forward.timestamp !== null) inner.push(`(${formatStamp(forward.timestamp, env.timeZone)})`);
  pushAll(inner, bodyLines(plainText(forward.content, env.md)));
  pushAll(inner, mediaLines(forward.attachments, forward.embeds, env));
  // Quoting keeps the original's lines apart from the message that forwarded it; shieldLine runs again because the
  // prefix changes what the start of the line looks like.
  const lines = [section(env.strings.forwarded)];
  for (const line of inner) lines.push(shieldLine(line === '' ? '>' : `> ${line}`));
  return lines;
}

function messageText(message: Message, env: Env): string {
  const { locale, strings } = env;
  const lines: string[] = [];
  const stamp = formatStamp(message.timestamp, env.timeZone);
  const system = systemMessageText(message, locale);

  if (system !== null) {
    lines.push(`[${stamp}] * ${oneLine(system)}`);
  } else {
    lines.push(`[${stamp}] ${authorName(message, locale)}${isBotMessage(message) ? ` [${strings.bot}]` : ''}`);

    const reference = referenceView(message, locale);
    if (reference?.kind === 'reply') {
      const who = reference.author === null ? '' : `${strings.replyingTo(oneLine(displayName(reference.author)) || getStrings(locale).unknownUser)} `;
      lines.push(`> ↪ ${who}${reference.preview}`.trimEnd());
    }

    const content = bodyLines(plainText(message.content, env.md));
    const editedMark = message.edited_timestamp ? `(${strings.edited})` : '';
    if (content.length > 0) {
      if (editedMark !== '') content[content.length - 1] += ` ${editedMark}`;
      pushAll(lines, content);
    } else if (editedMark !== '') {
      lines.push(editedMark);
    }
  }

  pushAll(lines, mediaLines(listOf(message.attachments), listOf(message.embeds), env));

  const stickers = listOf(message.sticker_items)
    .map((sticker) => stickerView(sticker))
    .filter((view) => oneLine(view.name) !== '' || view.imageUrl !== null);
  if (stickers.length > 0) {
    lines.push(section(strings.stickers));
    for (const view of stickers) lines.push(shieldLine([oneLine(view.name), view.imageUrl ?? ''].filter((part) => part !== '').join(' ')));
  }

  if (system === null && message.poll) {
    lines.push(section(strings.poll));
    for (const line of pollLines(message.poll, locale)) lines.push(shieldLine(line));
  }
  if (system === null) {
    for (const forward of forwardView(message)) pushAll(lines, forwardLines(forward, env));
  }

  const reactions = reactionParts(message);
  if (reactions.length > 0) {
    lines.push(section(strings.reactions));
    lines.push(shieldLine(reactions.map((reaction) => `${reaction.label} ${reaction.count}`).join('  ')));
  }
  return lines.join('\n');
}

/**
 * Human-readable log. The header is written before the first message, when the message count is not yet known,
 * so count and range of what was actually exported are in the footer.
 */
function createTxtWriter(ctx: WriterContext): ExportWriter {
  const { target, options, exportedAt } = ctx;
  const timeZone = resolveTimeZone(options.timeZone);
  const strings = getExportStrings(options.locale);
  const env: Env = { locale: options.locale, timeZone, strings, md: markdownContext(ctx), paths: options.attachmentPaths };

  return {
    start(): Chunk[] {
      const lines = [RULE];
      if (target.guildName) lines.push(`${strings.server}: ${oneLine(target.guildName)}`);
      lines.push(`${strings.channel}: ${channelPath(target)}`);
      const topic = oneLine(target.topic);
      if (topic !== '') lines.push(`${strings.topic}: ${topic}`);
      for (const [label, value] of scopeRows(options, timeZone)) lines.push(`${label}: ${value}`);
      lines.push(
        `${strings.exportedAt}: ${formatStamp(exportedAt.toISOString(), timeZone)} (${timeZone})`,
        `${strings.generator}: ${GENERATOR_NAME}`,
        RULE,
      );
      return [`${lines.join('\n')}\n\n`];
    },

    write(batch: readonly Message[]): Chunk[] {
      let out = '';
      for (const message of applyContentOptions(batch, options.content)) out += `${messageText(message, env)}\n\n`;
      return out === '' ? [] : [out];
    },

    end(summary: WriterSummary): Chunk[] {
      const lines = [RULE, `${strings.messages}: ${summary.messageCount}`];
      if (summary.firstTimestamp) lines.push(`${strings.firstMessage}: ${formatStamp(summary.firstTimestamp, timeZone)}`);
      if (summary.lastTimestamp) lines.push(`${strings.lastMessage}: ${formatStamp(summary.lastTimestamp, timeZone)}`);
      lines.push(RULE);
      return [`${lines.join('\n')}\n`];
    },
  };
}

export const txtFormat: FormatModule = {
  id: 'txt',
  label: 'Text (.txt)',
  extension: 'txt',
  mime: 'text/plain;charset=utf-8',
  createWriter: createTxtWriter,
};
