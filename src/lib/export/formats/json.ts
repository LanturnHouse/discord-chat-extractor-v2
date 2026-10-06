import type { Attachment, Message } from '../../discord/types';
import type { Chunk, ExportWriter, FormatModule, WriterContext, WriterSummary } from '../types';
import { applyContentOptions } from './content';
import { localPathOf } from './parts';

// The line and paragraph separators are invisible, and a literal one inside a regex literal would end the line of source:
// they are built from their code points.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const SEPARATORS = new RegExp(`[${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`, 'g');

/** U+2028/2029 are legal inside JSON strings but split "lines" in some tools; escaping keeps one message per line. */
function compactLine(message: Message): string {
  return JSON.stringify(message).replace(SEPARATORS, (ch) => (ch === LINE_SEPARATOR ? '\\u2028' : '\\u2029'));
}

/** The attachment with `local_path` (the saved copy, relative to the exported file) placed right behind `url`. */
function withLocalPath(attachment: Attachment, paths: ReadonlyMap<string, string>): Attachment {
  const local = localPathOf(attachment, paths);
  if (local === null) return attachment;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attachment)) {
    if (key === 'local_path') continue;
    result[key] = value;
    if (key === 'url') result.local_path = local;
  }
  if (!('url' in attachment)) result.local_path = local;
  return result as unknown as Attachment;
}

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

/** `message` with `local_path` on every attachment that has a saved copy (forwarded snapshots included); the same object when none has. */
function withLocalPaths(message: Message, paths: ReadonlyMap<string, string>): Message {
  if (paths.size === 0 || !isObject(message)) return message;
  let result = message;
  if (Array.isArray(message.attachments) && message.attachments.some((a) => isObject(a) && localPathOf(a, paths) !== null)) {
    result = { ...result, attachments: message.attachments.map((a) => (isObject(a) ? withLocalPath(a, paths) : a)) };
  }
  if (Array.isArray(message.message_snapshots)) {
    const snapshots = message.message_snapshots.map((snapshot) => {
      const inner = snapshot?.message;
      if (!isObject(inner) || !Array.isArray(inner.attachments) || !inner.attachments.some((a) => isObject(a) && localPathOf(a, paths) !== null)) return snapshot;
      return { ...snapshot, message: { ...inner, attachments: inner.attachments.map((a) => (isObject(a) ? withLocalPath(a, paths) : a)) } };
    });
    if (snapshots.some((snapshot, index) => snapshot !== message.message_snapshots?.[index])) result = { ...result, message_snapshots: snapshots };
  }
  return result;
}

/**
 * One JSON document written incrementally. The counts sit after the `messages` array because they are
 * unknown when the file starts; JSON consumers do not care about key order.
 *
 * The messages are the raw API objects. The content options drop whole messages / the `reactions` and `embeds` parts, and a
 * saved copy of an attachment is announced as `local_path` right behind its `url`.
 */
function createJsonWriter(ctx: WriterContext): ExportWriter {
  const { target, options, exportedAt } = ctx;
  let written = 0;

  return {
    start(): Chunk[] {
      const header = {
        exportedAt: exportedAt.toISOString(),
        generator: 'Discord Chat Extractor',
        channel: {
          id: target.channelId,
          name: target.channelName,
          kind: target.kind,
          guild: target.guildId === null ? null : { id: target.guildId, name: target.guildName },
          category: target.categoryName,
          topic: target.topic,
        },
        range: { after: options.after, before: options.before, limit: options.limit },
        ...(options.incremental === true ? { incremental: true } : {}),
        ...(options.partial === true ? { partial: true } : {}),
      };
      // Strip the closing brace of the pretty-printed header so the message array can be appended to the same object.
      const open = JSON.stringify(header, null, 2).slice(0, -2);
      return [`${open},\n  "messages": [`];
    },

    write(batch: readonly Message[]): Chunk[] {
      const kept = applyContentOptions(batch, options.content);
      if (kept.length === 0) return [];
      const paths = options.attachmentPaths;
      const lines = kept.map((message) => `\n    ${compactLine(paths === undefined ? message : withLocalPaths(message, paths))}`);
      const out = lines.join(',');
      const chunk = written === 0 ? out : `,${out}`;
      written += kept.length;
      return [chunk];
    },

    end(summary: WriterSummary): Chunk[] {
      const tail = {
        messageCount: summary.messageCount,
        firstMessageAt: summary.firstTimestamp,
        lastMessageAt: summary.lastTimestamp,
      };
      // Same trick as in start(): re-open the pretty-printed object to splice its members after the array.
      const members = JSON.stringify(tail, null, 2).slice(2, -2);
      return [`${written === 0 ? '' : '\n  '}],\n${members}\n}\n`];
    },
  };
}

export const jsonFormat: FormatModule = {
  id: 'json',
  label: 'JSON (.json)',
  extension: 'json',
  mime: 'application/json',
  createWriter: createJsonWriter,
};
