import type { Message, User } from '../discord/types';
import { isSystemMessage, systemMessageText } from './system';
import { getStrings, type MessageLocale } from './strings';
import { describeBody } from './summary';
import { oneLine } from './text';

export type ReferenceView =
  | {
      kind: 'reply';
      /** Author of the replied-to message; null when that message is deleted or was not delivered. */
      author: User | null;
      /** Single line, at most 140 UTF-16 units. */
      preview: string;
      /** True when the original is gone or unavailable (`preview` then says which). */
      deleted: boolean;
    }
  | { kind: 'forward' };

const PREVIEW_MAX = 140;

function isForward(msg: Message): boolean {
  return msg.message_reference?.type === 1 || (Array.isArray(msg.message_snapshots) && msg.message_snapshots.length > 0);
}

/**
 * What to show above a message: a reply header, a "forwarded" marker, or nothing.
 *
 * `referenced_message`: absent => the API did not try to load it (state unknown); `null` => the original was
 * deleted. Both render as an unavailable original, with different wording.
 * Pin/system messages carry a reference too but are rendered as system lines, so they get no header.
 */
export function referenceView(msg: Message, locale: MessageLocale): ReferenceView | null {
  if (isForward(msg)) return { kind: 'forward' };
  if (isSystemMessage(msg)) return null;

  const isReply = msg.type === 19 || msg.type === 21 || msg.referenced_message != null;
  if (!isReply) return null;

  const strings = getStrings(locale);
  const ref = msg.referenced_message;
  if (!ref || typeof ref !== 'object') {
    return {
      kind: 'reply',
      author: null,
      preview: ref === null ? strings.replyDeleted : strings.replyUnavailable,
      deleted: true,
    };
  }

  const system = systemMessageText(ref, locale);
  const preview =
    system !== null ? oneLine(system, PREVIEW_MAX) : describeBody(ref, strings, PREVIEW_MAX, undefined, strings.replyAttachment);
  return { kind: 'reply', author: ref.author ?? null, preview, deleted: false };
}
