import type { Message } from '../discord/types';
import { isSystemMessage } from './system';
import { dayKey, timestampMs } from './time';

/** Discord collapses a follow-up message into the previous one only while strictly inside this window. */
const GROUP_WINDOW_MS = 7 * 60 * 1000;

function isReply(msg: Message): boolean {
  return msg.type === 19 || msg.message_reference != null || msg.referenced_message != null;
}

/**
 * Cozy-layout grouping: may `cur` omit avatar + name because it continues `prev`?
 * Same author, neither a system message, `cur` not a reply/forward, same calendar day in `tz`,
 * and strictly less than 7 minutes apart (exactly 7:00 starts a new group).
 */
export function shouldGroupWithPrevious(prev: Message | undefined, cur: Message, tz: string): boolean {
  if (!prev || !prev.author || !cur.author) return false;
  if (prev.author.id !== cur.author.id) return false;
  if (isSystemMessage(prev) || isSystemMessage(cur)) return false;
  if (isReply(cur)) return false;
  // A webhook posts every message under one id but with a per-message name and avatar.
  if (
    cur.webhook_id != null &&
    (prev.author.username !== cur.author.username || (prev.author.avatar ?? null) !== (cur.author.avatar ?? null))
  ) {
    return false;
  }

  const a = timestampMs(prev.timestamp);
  const b = timestampMs(cur.timestamp);
  if (a === null || b === null) return false;
  if (Math.abs(b - a) >= GROUP_WINDOW_MS) return false;
  return dayKey(prev.timestamp, tz) === dayKey(cur.timestamp, tz);
}
