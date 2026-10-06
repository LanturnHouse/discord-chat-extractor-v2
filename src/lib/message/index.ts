/**
 * Message semantics shared by the UI and every exporter. Pure functions, no React, no I/O.
 * See docs/ARCHITECTURE.md ("src/lib/message/").
 */
export { displayName, buildNameResolver } from './names';
export type { MessageNameResolver, NameResolverInit } from './names';

export { isSystemMessage, systemMessageText } from './system';

export { acronymOf, glyphsOf, initialOf, toneOf } from './initials';

export { classifyAttachment, isSpoilerAttachment, attachmentMediaUrl, formatBytes } from './attachments';
export type { AttachmentKind } from './attachments';

export {
  formatClock,
  formatDateTime,
  formatDayLabel,
  formatFullTooltip,
  dayKey,
  isSameDay,
  timestampMs,
} from './time';

export { shouldGroupWithPrevious } from './grouping';

export { normalizeEmbed } from './embed';
export type { NormalizedEmbed, EmbedMediaView } from './embed';

export { reactionView, stickerView, pollView, forwardView } from './views';
export type { ReactionView, StickerView, PollView, PollAnswerView, ForwardSnapshotView } from './views';

export { referenceView } from './reference';
export type { ReferenceView } from './reference';

export { getStrings } from './strings';
export type { MessageLocale, MessageStrings } from './strings';
