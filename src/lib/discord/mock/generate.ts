import { MessageType } from '../types';
import type { Message, Snowflake } from '../types';
import { MOCK_ME } from './cast';
import { HOUR, SECOND, isoOf, messageId } from './ids';
import { KINDS, makeReactions } from './kinds';
import type { BuildCtx } from './kinds';
import { planChannel } from './plan';
import { createRng } from './prng';
import { buildTimeline } from './timeline';
import type { MessageProfile } from './types';

/** Pure function of the profile, so it is safe to share between clients. Cheap (one number per message). */
const timelines = new Map<string, readonly number[]>();

function timelineFor(profile: MessageProfile): readonly number[] {
  let times = timelines.get(profile.seedKey);
  if (!times) {
    times = buildTimeline(profile);
    timelines.set(profile.seedKey, times);
  }
  return times;
}

/** Id of the newest message without generating any content (the channel listing needs it). */
export function lastMessageIdOf(profile: MessageProfile): Snowflake | null {
  if (profile.count === 0) return null;
  const times = timelineFor(profile);
  return messageId(profile.seedKey, times[profile.count - 1], profile.count - 1);
}

/**
 * Builds a channel's complete history, oldest first. Message `i` only depends on the profile and `i`
 * (plus earlier messages for replies), so the result never changes between runs or clients.
 */
export function generateMessages(profile: MessageProfile): Message[] {
  const times = timelineFor(profile);
  const plan = planChannel(profile);
  const messages: Message[] = [];

  for (let i = 0; i < profile.count; i++) {
    const entry = plan[i];
    const ts = times[i];
    const id = messageId(profile.seedKey, ts, i);
    const target = entry.target !== undefined ? messages[entry.target] : undefined;
    const rng = createRng(`${profile.seedKey}/m${i}`);

    const context = (variant: number): BuildCtx => ({
      rng,
      index: i,
      ts,
      id,
      channelId: profile.channelId,
      guild: profile.guild,
      author: entry.author,
      pool: profile.authors,
      lang: profile.lang,
      casual: profile.flavour === 'dm' || profile.flavour === 'group-dm',
      variant,
      me: MOCK_ME,
      target,
      threads: profile.threads,
    });

    const ctx = context(entry.variant);
    const parts = KINDS[entry.kind].build(ctx) ?? KINDS.text.build(context(0));
    if (!parts) throw new Error('mock: the text builder must always produce a message');

    const message: Message = {
      id,
      channel_id: profile.channelId,
      author: entry.author,
      content: '',
      timestamp: isoOf(ts),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      attachments: [],
      embeds: [],
      pinned: false,
      type: 0,
      flags: 0,
      ...parts,
    };
    if (entry.edited) message.edited_timestamp = isoOf(ts + rng.int(30 * SECOND, 2 * HOUR));
    if (entry.reactions) message.reactions = makeReactions(ctx);
    if (message.type === MessageType.ChannelPinnedMessage && target) target.pinned = true;
    messages.push(message);
  }
  return messages;
}
