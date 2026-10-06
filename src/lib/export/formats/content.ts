import type { ContentOptions } from '@/shared/types';
import type { Message } from '../../discord/types';
import { isSystemMessage } from '../../message';
import { isBotMessage } from './parts';

/**
 * Content options (docs/PLAN.md #12) shared by every writer: which messages are left out entirely (bots / webhooks, system
 * notices) and which parts of the remaining ones are dropped (reactions, embeds).
 *
 * Nothing is copied unless something has to change: with everything included the batch itself is returned, and a message that
 * has nothing to drop is returned as the very same object, so applying the options twice is harmless.
 */

function isEverythingIncluded(content: ContentOptions): boolean {
  return content.includeBots && content.includeSystem && content.includeReactions && content.includeEmbeds;
}

const hasItems = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

/** `message` without the parts the options leave out; the same object when it has none of them. */
export function omitOptionalParts(message: Message, content: ContentOptions): Message {
  let result: Message = message;

  if (!content.includeReactions && 'reactions' in result) {
    const { reactions: _reactions, ...rest } = result;
    result = rest as Message;
  }

  if (!content.includeEmbeds) {
    if (hasItems(result.embeds)) result = { ...result, embeds: [] };
    if (Array.isArray(result.message_snapshots) && result.message_snapshots.some((snapshot) => hasItems(snapshot?.message?.embeds))) {
      result = {
        ...result,
        message_snapshots: result.message_snapshots.map((snapshot) =>
          hasItems(snapshot?.message?.embeds) ? { ...snapshot, message: { ...snapshot.message, embeds: [] } } : snapshot,
        ),
      };
    }
  }
  return result;
}

/**
 * The messages of `batch` that the options keep, in order, with the dropped parts removed. Entries that are not objects (a
 * garbage API answer) are passed through for the writer to deal with, as they would be without any options.
 */
export function applyContentOptions(batch: readonly Message[], content: ContentOptions | undefined): readonly Message[] {
  if (content === undefined || isEverythingIncluded(content)) return batch;
  const kept: Message[] = [];
  for (const message of batch) {
    if (message === null || typeof message !== 'object') {
      kept.push(message);
      continue;
    }
    if (!content.includeBots && isBotMessage(message)) continue;
    if (!content.includeSystem && isSystemMessage(message)) continue;
    kept.push(omitOptionalParts(message, content));
  }
  return kept;
}
