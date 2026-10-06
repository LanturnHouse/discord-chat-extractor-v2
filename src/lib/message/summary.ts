import type { Message, Snowflake } from '../discord/types';
import type { NameResolver } from '../markdown/types';
import { displayName } from './names';
import { plainFromMarkdown, type PlainContext } from './plain';
import type { MessageStrings } from './strings';
import { oneLine, str } from './text';

const hasItems = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

/**
 * Name lookups for stripping a message's mentions: the caller's resolver first (it knows the whole channel),
 * then the data the message itself carries (`mentions`, `mention_channels`).
 */
function contextFor(msg: Message, strings: MessageStrings, names: NameResolver | undefined): PlainContext {
  let users: Map<Snowflake, string> | undefined;
  return {
    strings,
    user(id) {
      const known = names?.user(id);
      if (known !== undefined) return known;
      if (!users) {
        users = new Map();
        if (Array.isArray(msg.mentions)) {
          for (const u of msg.mentions) {
            const name = u && typeof u.id === 'string' ? displayName(u) : '';
            if (name) users.set(u.id, name);
          }
        }
      }
      return users.get(id);
    },
    channel(id) {
      const known = names?.channel(id);
      if (known !== undefined) return known;
      return Array.isArray(msg.mention_channels) ? msg.mention_channels.find((c) => c?.id === id)?.name : undefined;
    },
    role: (id) => names?.role(id),
  };
}

function firstEmbedText(msg: Message, ctx: PlainContext, max: number): string {
  if (!Array.isArray(msg.embeds)) return '';
  for (const embed of msg.embeds) {
    for (const candidate of [embed?.title, embed?.description, embed?.author?.name]) {
      const text = plainFromMarkdown(str(candidate) ?? '', ctx, max);
      if (text) return text;
    }
  }
  return '';
}

/**
 * One line describing a user-authored message: its text, else a marker for what it carries.
 * `attachmentText` is what an attachment-only message reads as ("Click to see attachment" in reply previews).
 */
export function describeBody(
  msg: Message,
  strings: MessageStrings,
  max: number,
  names: NameResolver | undefined,
  attachmentText: string,
): string {
  const ctx = contextFor(msg, strings, names);
  const text = plainFromMarkdown(str(msg.content) ?? '', ctx, max);
  if (text) return text;
  if (hasItems(msg.attachments)) return attachmentText;
  if (hasItems(msg.sticker_items)) return strings.sticker;
  const embedText = firstEmbedText(msg, ctx, max);
  if (embedText) return embedText;
  if (hasItems(msg.embeds)) return strings.embed;
  if (msg.poll) {
    const question = oneLine(str(msg.poll.question?.text), max);
    return oneLine(question ? `${strings.poll} ${question}` : strings.poll, max);
  }
  const snapshot = Array.isArray(msg.message_snapshots) ? msg.message_snapshots[0]?.message : undefined;
  if (snapshot) {
    const inner = plainFromMarkdown(str(snapshot.content) ?? '', ctx, max);
    return oneLine(inner ? `${strings.forwarded} ${inner}` : strings.forwarded, max);
  }
  return '';
}
