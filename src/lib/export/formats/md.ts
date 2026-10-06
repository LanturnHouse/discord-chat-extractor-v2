import type { Attachment, Embed, Message, Poll, StickerItem } from '../../discord/types';
import type { MarkdownContext } from '../../markdown/types';
import { isDiscordMediaUrl, safeUrl } from '../../markdown/url';
import {
  dayKey,
  displayName,
  formatDateTime,
  forwardView,
  getStrings,
  normalizeEmbed,
  pollView,
  reactionView,
  referenceView,
  stickerView,
  systemMessageText,
  type ForwardSnapshotView,
} from '../../message';
import type { Chunk, ExportWriter, FormatModule, WriterContext, WriterSummary } from '../types';
import { applyContentOptions } from './content';
import { escapeInline, markdownText, mdAutolink, mdDestination, mdLink, quoteLines } from './mdRender';
import {
  attachmentView,
  authorName,
  channelDisplay,
  channelPath,
  isBotMessage,
  listOf,
  localHref,
  markdownContext,
} from './parts';
import { formatStamp, GENERATOR_NAME, getExportStrings, oneLine, resolveTimeZone, scopeRows, type ExportLocale, type ExportStrings } from './text';

const HARD_BREAK = '  \n';

interface Env {
  locale: ExportLocale;
  timeZone: string;
  strings: ExportStrings;
  md: MarkdownContext;
  /** Attachment id -> path of the saved copy (see `WriterOptions.attachmentPaths`). */
  paths: ReadonlyMap<string, string> | undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// message parts
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A saved copy is linked by its relative path (an image that is not a spoiler is shown inline: it is a file next to the
 * document). Otherwise images are shown inline only when they are on Discord's CDN and not marked as spoilers (privacy:
 * nothing else is ever fetched when the file is opened); everything else is a plain link.
 */
function attachmentBlock(attachment: Attachment, env: Env): string {
  const view = attachmentView(attachment, env.locale, env.paths);
  const name = escapeInline(view.name);
  const local = localHref(view.local);
  if (local !== null) {
    if (view.kind === 'image' && !view.spoiler) return `![${escapeInline(view.description ?? view.name)}](${mdDestination(local)})`;
    return `[${name}](${mdDestination(local)}) (${view.size})`;
  }
  if (view.url === null) return `${name} (${view.size})`;
  if (view.kind === 'image' && !view.spoiler && isDiscordMediaUrl(view.url)) {
    return `![${escapeInline(view.description ?? view.name)}](${mdDestination(view.url)})`;
  }
  return `${mdLink(name, view.url)} (${view.size})`;
}

function embedBlock(embed: Embed, env: Env): string {
  const e = normalizeEmbed(embed);
  const paragraphs: string[] = [];
  if (e.author) paragraphs.push(`<sub>${mdLink(escapeInline(e.author.name), e.author.url)}</sub>`);
  if (e.title !== null) paragraphs.push(`**${mdLink(escapeInline(e.title), e.titleUrl)}**`);
  else if (e.titleUrl !== null) paragraphs.push(mdAutolink(e.titleUrl) ?? escapeInline(e.titleUrl));
  if (e.description !== null) {
    const description = markdownText(e.description, env.md);
    if (description !== '') paragraphs.push(description);
  }
  for (const field of e.fields) {
    const name = escapeInline(field.name);
    const value = markdownText(field.value, env.md);
    if (name === '') paragraphs.push(value);
    else paragraphs.push(value === '' ? `**${name}**` : `**${name}**${HARD_BREAK}${value}`);
  }
  const imageUrl = e.image === null ? null : safeUrl(e.image.url);
  if (imageUrl !== null) paragraphs.push(`![${escapeInline(e.title ?? e.provider ?? '')}](${mdDestination(imageUrl)})`);
  const footer = [e.footer === null ? '' : escapeInline(e.footer.text), e.timestamp === null ? '' : escapeInline(formatStamp(e.timestamp, env.timeZone))]
    .filter((part) => part !== '')
    .join(' · ');
  if (footer !== '') paragraphs.push(`<sub>${footer}</sub>`);
  if (paragraphs.length === 0) paragraphs.push(escapeInline(getStrings(env.locale).embed));
  return quoteLines(paragraphs.join('\n\n'));
}

function stickerBlock(sticker: StickerItem, env: Env): string | null {
  const view = stickerView(sticker);
  const name = escapeInline(view.name);
  const url = view.imageUrl === null ? null : safeUrl(view.imageUrl);
  if (url !== null && isDiscordMediaUrl(url)) return `![${name}](${mdDestination(url)})`;
  const label = env.strings.sticker;
  return `*${name === '' ? label : `${label}: ${name}`}*`;
}

function pollBlock(poll: Poll, env: Env): string {
  const { strings } = env;
  const view = pollView(poll);
  const paragraphs = [`**${strings.poll}:** ${escapeInline(view.question)}`.trimEnd()];
  const answers = view.answers.map((answer, index) => {
    const label = [answer.emoji === null ? '' : escapeInline(answer.emoji), escapeInline(answer.text)].filter((part) => part !== '').join(' ');
    return `${index + 1}. ${label}${answer.votes === null ? '' : ` — ${strings.votes(answer.votes)}`}`;
  });
  if (answers.length > 0) paragraphs.push(answers.join('\n'));
  const facts: string[] = [];
  if (view.multiselect) facts.push(strings.multipleChoice);
  if (view.finalized) facts.push(strings.pollEnded);
  if (view.totalVotes !== null) facts.push(strings.totalVotes(view.totalVotes));
  if (facts.length > 0) paragraphs.push(`<sub>${facts.join(' · ')}</sub>`);
  return quoteLines(paragraphs.join('\n\n'));
}

function forwardBlock(forward: ForwardSnapshotView, env: Env): string {
  const paragraphs = [`*${escapeInline(env.strings.forwarded)}*`];
  if (forward.timestamp !== null) paragraphs.push(`<sub>${escapeInline(formatStamp(forward.timestamp, env.timeZone))}</sub>`);
  const content = markdownText(forward.content, env.md);
  if (content !== '') paragraphs.push(content);
  for (const attachment of forward.attachments) paragraphs.push(attachmentBlock(attachment, env));
  for (const embed of forward.embeds) paragraphs.push(embedBlock(embed, env));
  return quoteLines(paragraphs.join('\n\n'));
}

function reactionsLine(message: Message): string | null {
  const parts = listOf(message.reactions).map((reaction) => {
    const view = reactionView(reaction);
    const label = escapeInline(view.label) || '?';
    const emoji = view.imageUrl === null ? label : `![${label}](${mdDestination(view.imageUrl)})`;
    return `${emoji} ${view.count}`;
  });
  return parts.length === 0 ? null : parts.join(' · ');
}

/** Time of day for the author line: `HH:mm:ss`, or the timestamp as sent when it does not parse. */
function clockOf(message: Message, timeZone: string): string {
  const full = typeof message.timestamp === 'string' ? formatDateTime(message.timestamp, timeZone) : '';
  return full === '' ? escapeInline(message.timestamp) : full.slice(11);
}

function messageBlocks(message: Message, env: Env): string[] {
  const { locale, strings } = env;
  const blocks: string[] = [];
  const clock = clockOf(message, env.timeZone);
  const system = systemMessageText(message, locale);

  if (system !== null) {
    blocks.push(`${clock === '' ? '' : `<sub>${clock}</sub> `}*${escapeInline(system)}*`);
  } else {
    const edited = message.edited_timestamp ? `(${escapeInline(strings.edited)})` : '';
    const time = [clock, edited].filter((part) => part !== '').join(' ');
    const bot = isBotMessage(message) ? ` \`${strings.bot}\`` : '';
    blocks.push(`**${escapeInline(authorName(message, locale))}**${bot}${time === '' ? '' : ` <sub>${time}</sub>`}`);

    const reference = referenceView(message, locale);
    if (reference?.kind === 'reply') {
      const preview = escapeInline(reference.preview);
      if (reference.author === null) {
        blocks.push(`> ↪ *${preview}*`.trimEnd());
      } else {
        const who = `**${escapeInline(oneLine(displayName(reference.author)) || getStrings(locale).unknownUser)}**`;
        blocks.push(`> ↪ ${strings.replyingTo(who)} ${preview}`.trimEnd());
      }
    }
    const content = markdownText(message.content, env.md);
    if (content !== '') blocks.push(content);
  }

  for (const attachment of listOf(message.attachments)) blocks.push(attachmentBlock(attachment, env));
  for (const embed of listOf(message.embeds)) blocks.push(embedBlock(embed, env));
  for (const sticker of listOf(message.sticker_items)) {
    const block = stickerBlock(sticker, env);
    if (block !== null) blocks.push(block);
  }
  if (system === null && message.poll) blocks.push(pollBlock(message.poll, env));
  if (system === null) {
    for (const forward of forwardView(message)) blocks.push(forwardBlock(forward, env));
  }
  const reactions = reactionsLine(message);
  if (reactions !== null) blocks.push(reactions);
  return blocks;
}

// ---------------------------------------------------------------------------------------------------------------------
// document
// ---------------------------------------------------------------------------------------------------------------------

function bullet(label: string, value: string): string {
  return `- **${label}:** ${value}`;
}

function createMdWriter(ctx: WriterContext): ExportWriter {
  const { target, options, exportedAt } = ctx;
  const timeZone = resolveTimeZone(options.timeZone);
  const strings = getExportStrings(options.locale);
  const env: Env = { locale: options.locale, timeZone, strings, md: markdownContext(ctx), paths: options.attachmentPaths };
  /** Day heading last written; carried across batches. */
  let currentDay = '';
  let wroteMessages = false;

  return {
    start(): Chunk[] {
      const channel = escapeInline(channelDisplay(target));
      const guild = escapeInline(target.guildName);
      const topic = escapeInline(target.topic);
      const lines = [`# ${guild === '' ? channel : `${guild} - ${channel}`}`, ''];
      if (guild !== '') lines.push(bullet(strings.server, guild));
      lines.push(bullet(strings.channel, escapeInline(channelPath(target))));
      if (topic !== '') lines.push(bullet(strings.topic, topic));
      for (const [label, value] of scopeRows(options, timeZone)) lines.push(bullet(label, escapeInline(value)));
      lines.push(
        bullet(strings.exportedAt, `${escapeInline(formatStamp(exportedAt.toISOString(), timeZone))} (${escapeInline(timeZone)})`),
        bullet(strings.generator, GENERATOR_NAME),
        '',
        '---',
        '',
        '',
      );
      return [lines.join('\n')];
    },

    write(batch: readonly Message[]): Chunk[] {
      let out = '';
      for (const message of applyContentOptions(batch, options.content)) {
        const day = dayKey(message.timestamp, timeZone);
        if (day !== '' && day !== currentDay) {
          currentDay = day;
          out += `## ${day}\n\n`;
        }
        out += `${messageBlocks(message, env).join('\n\n')}\n\n`;
      }
      if (out === '') return [];
      wroteMessages = true;
      return [out];
    },

    end(summary: WriterSummary): Chunk[] {
      // The header already ends with a rule; a second one right behind it would be noise.
      const lines = wroteMessages ? ['---', ''] : [];
      lines.push(bullet(strings.messages, String(summary.messageCount)));
      if (summary.firstTimestamp) lines.push(bullet(strings.firstMessage, escapeInline(formatStamp(summary.firstTimestamp, timeZone))));
      if (summary.lastTimestamp) lines.push(bullet(strings.lastMessage, escapeInline(formatStamp(summary.lastTimestamp, timeZone))));
      return [`${lines.join('\n')}\n`];
    },
  };
}

export const mdFormat: FormatModule = {
  id: 'md',
  label: 'Markdown (.md)',
  extension: 'md',
  mime: 'text/markdown;charset=utf-8',
  createWriter: createMdWriter,
};
