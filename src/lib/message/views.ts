import { emojiUrl, stickerUrl } from '../discord/cdn';
import type { Attachment, Embed, Message, PartialEmoji, Poll, Reaction, StickerItem } from '../discord/types';
import { count, finiteNumber, isSnowflake, nonEmpty, str } from './text';

export interface ReactionView {
  /** Stable per reaction within a message: the custom emoji id, or the unicode emoji itself. */
  key: string;
  /** Unicode emoji for unicode reactions, `:name:` for custom ones (alt text / text exports). */
  label: string;
  /** CDN image for custom emoji, null for unicode (and for ids that are not snowflakes). */
  imageUrl: string | null;
  count: number;
  me: boolean;
}

/** Reaction chips render at about 16px; 32px covers 2x displays. */
const REACTION_EMOJI_SIZE = 32;

export function reactionView(r: Reaction): ReactionView {
  const emoji: Partial<PartialEmoji> = r?.emoji ?? {};
  const name = nonEmpty(emoji.name);
  const id = emoji.id;
  const custom = id != null;
  const label = custom ? (name ? `:${name}:` : ':emoji:') : (name ?? '');
  return {
    key: custom ? String(id) : (name ?? ''),
    label,
    imageUrl: custom && isSnowflake(id) ? emojiUrl(id, emoji.animated === true, REACTION_EMOJI_SIZE) : null,
    count: count(r?.count),
    me: r?.me === true,
  };
}

export interface StickerView {
  name: string;
  /** null for Lottie stickers and ids that are not snowflakes: show the name only. */
  imageUrl: string | null;
}

export function stickerView(s: StickerItem): StickerView {
  const formatType = finiteNumber(s?.format_type) ?? 1;
  return {
    name: str(s?.name) ?? '',
    imageUrl: isSnowflake(s?.id) ? stickerUrl(s.id, formatType) : null,
  };
}

export interface PollAnswerView {
  text: string;
  /** Unicode emoji, or `:name:` for a custom one. */
  emoji: string | null;
  /** null when the API sent no results at all (vote counts unknown). */
  votes: number | null;
}

export interface PollView {
  question: string;
  answers: PollAnswerView[];
  /** Sum of the per-answer counts (selections, not distinct voters, for multi-select polls); null when unknown. */
  totalVotes: number | null;
  finalized: boolean;
  multiselect: boolean;
}

function pollEmoji(emoji: PartialEmoji | undefined): string | null {
  const name = nonEmpty(emoji?.name);
  if (emoji?.id != null) return name ? `:${name}:` : null;
  return name;
}

export function pollView(poll: Poll): PollView {
  const results = poll?.results;
  // The API omits answers nobody voted for, so with results present a missing answer means 0 votes.
  let counts: Map<number, number> | null = null;
  if (results && typeof results === 'object') {
    counts = new Map();
    if (Array.isArray(results.answer_counts)) {
      for (const entry of results.answer_counts) {
        if (entry && typeof entry.id === 'number') counts.set(entry.id, count(entry.count));
      }
    }
  }

  const answers: PollAnswerView[] = [];
  if (Array.isArray(poll?.answers)) {
    for (const answer of poll.answers) {
      const id = answer?.answer_id;
      answers.push({
        text: str(answer?.poll_media?.text) ?? '',
        emoji: pollEmoji(answer?.poll_media?.emoji),
        votes: counts === null ? null : typeof id === 'number' ? (counts.get(id) ?? 0) : 0,
      });
    }
  }

  let totalVotes: number | null = null;
  if (counts !== null) {
    totalVotes = 0;
    for (const n of counts.values()) totalVotes += n;
  }

  return {
    question: str(poll?.question?.text) ?? '',
    answers,
    totalVotes,
    finalized: results?.is_finalized === true,
    multiselect: poll?.allow_multiselect === true,
  };
}

export interface ForwardSnapshotView {
  content: string;
  attachments: Attachment[];
  embeds: Embed[];
  timestamp: string | null;
}

/** The original messages inside a forwarded message (`message_snapshots`); [] for anything else. */
export function forwardView(msg: Message): ForwardSnapshotView[] {
  const snapshots = msg?.message_snapshots;
  if (!Array.isArray(snapshots)) return [];
  const out: ForwardSnapshotView[] = [];
  for (const snap of snapshots) {
    const inner = snap?.message;
    if (!inner || typeof inner !== 'object') continue;
    out.push({
      content: str(inner.content) ?? '',
      attachments: Array.isArray(inner.attachments) ? inner.attachments : [],
      embeds: Array.isArray(inner.embeds) ? inner.embeds : [],
      timestamp: nonEmpty(inner.timestamp),
    });
  }
  return out;
}
