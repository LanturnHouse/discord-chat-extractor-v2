import { describe, expect, it } from 'vitest';
import type { ContentOptions } from '@/shared/types';
import type { Message } from '../../../../src/lib/discord/types';
import { applyContentOptions, omitOptionalParts } from '../../../../src/lib/export/formats/content';

const EVERYTHING: ContentOptions = { includeBots: true, includeSystem: true, includeReactions: true, includeEmbeds: true };
const only = (overrides: Partial<ContentOptions>): ContentOptions => ({ ...EVERYTHING, ...overrides });

function message(id: number, extra: Partial<Message> = {}): Message {
  return {
    id: String(100000000000000000n + BigInt(id)),
    channel_id: '1',
    author: { id: '10', username: 'alice' },
    content: `message ${id}`,
    timestamp: '2026-10-05T12:00:00.000Z',
    edited_timestamp: null,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    type: 0,
    ...extra,
  };
}

const human = message(1);
const bot = message(2, { author: { id: '20', username: 'helper', bot: true } });
const webhook = message(3, { webhook_id: '777' });
const join = message(4, { type: 7 });
const pin = message(5, { type: 6 });
const reply = message(6, { type: 19 });
const withReactions = message(7, { reactions: [{ count: 1, emoji: { id: null, name: '👍' } }] });
const withEmbeds = message(8, { embeds: [{ type: 'rich', title: 'An embed' }] });
const forwarded = message(9, {
  message_snapshots: [
    { message: { content: 'one', embeds: [{ type: 'rich', title: 'inner' }], attachments: [] } },
    { message: { content: 'two', embeds: [], attachments: [] } },
  ],
} as Partial<Message>);

describe('applyContentOptions', () => {
  it('returns the very same batch when there are no options or everything is included', () => {
    const batch = [human, bot, join];
    expect(applyContentOptions(batch, undefined)).toBe(batch);
    expect(applyContentOptions(batch, EVERYTHING)).toBe(batch);
  });

  it('drops bot and webhook messages', () => {
    expect(applyContentOptions([human, bot, webhook, join], only({ includeBots: false }))).toEqual([human, join]);
  });

  it('drops system messages: joins, pins, calls ... but not replies', () => {
    expect(applyContentOptions([human, join, pin, reply], only({ includeSystem: false }))).toEqual([human, reply]);
  });

  it('keeps the order, and a bot that is a system message is dropped by either option', () => {
    const botJoin = message(10, { type: 7, author: { id: '20', username: 'helper', bot: true } });
    const batch = [human, botJoin, bot, join, reply];
    expect(applyContentOptions(batch, only({ includeBots: false }))).toEqual([human, join, reply]);
    expect(applyContentOptions(batch, only({ includeSystem: false }))).toEqual([human, bot, reply]);
    expect(applyContentOptions(batch, only({ includeBots: false, includeSystem: false }))).toEqual([human, reply]);
  });

  it('removes the reactions of the messages that stay', () => {
    const [kept] = applyContentOptions([withReactions], only({ includeReactions: false }));
    expect(kept).toBeDefined();
    expect('reactions' in kept!).toBe(false);
    expect(kept!.content).toBe(withReactions.content);
  });

  it('empties the embeds, those of forwarded messages included', () => {
    const [plain, fwd] = applyContentOptions([withEmbeds, forwarded], only({ includeEmbeds: false }));
    expect(plain!.embeds).toEqual([]);
    expect(fwd!.message_snapshots![0]!.message.embeds).toEqual([]);
    expect(fwd!.message_snapshots![1]!.message.embeds).toEqual([]);
    expect(fwd!.message_snapshots![0]!.message.content).toBe('one');
  });

  it('never changes the messages it was given', () => {
    const before = structuredClone([withReactions, withEmbeds, forwarded]);
    applyContentOptions([withReactions, withEmbeds, forwarded], only({ includeReactions: false, includeEmbeds: false }));
    expect([withReactions, withEmbeds, forwarded]).toEqual(before);
  });

  it('returns the same message object when it has nothing to drop', () => {
    const [a, b] = applyContentOptions([human, withEmbeds], only({ includeReactions: false }));
    expect(a).toBe(human);
    expect(b).toBe(withEmbeds);
  });

  it('is idempotent: applying the options twice changes nothing more', () => {
    const options = only({ includeBots: false, includeSystem: false, includeReactions: false, includeEmbeds: false });
    const once = applyContentOptions([human, bot, join, withReactions, withEmbeds, forwarded], options);
    const twice = applyContentOptions(once, options);
    expect(twice).toEqual(once);
    for (let i = 0; i < once.length; i += 1) expect(twice[i]).toBe(once[i]);
  });

  it('passes entries that are not objects through for the writer to deal with', () => {
    const garbage = [null, 'text', 7, undefined] as unknown as Message[];
    expect(applyContentOptions([human, ...garbage], only({ includeBots: false, includeEmbeds: false }))).toEqual([human, ...garbage]);
  });

  it('copes with messages without author, embeds or snapshots', () => {
    const bare = { id: '1', channel_id: '1', content: '', timestamp: 't', type: 0 } as unknown as Message;
    expect(applyContentOptions([bare], only({ includeBots: false, includeSystem: false, includeReactions: false, includeEmbeds: false }))).toEqual([bare]);
    const odd = message(11, { embeds: 'nope', message_snapshots: [null, { message: null }] } as unknown as Partial<Message>);
    expect(() => applyContentOptions([odd], only({ includeEmbeds: false }))).not.toThrow();
  });

  it('handles a big batch in one pass', () => {
    const batch = Array.from({ length: 20_000 }, (_, i) => (i % 3 === 0 ? bot : i % 3 === 1 ? human : join));
    const kept = applyContentOptions(batch, only({ includeBots: false, includeSystem: false }));
    expect(kept).toHaveLength(Math.ceil((20_000 - 1) / 3));
    expect(kept.every((m) => m === human)).toBe(true);
  });
});

describe('omitOptionalParts', () => {
  it('only touches what the options leave out', () => {
    const rich = message(12, { reactions: [{ count: 2, emoji: { id: null, name: '🎉' } }], embeds: [{ type: 'rich', title: 'x' }] });
    expect(omitOptionalParts(rich, EVERYTHING)).toBe(rich);
    const noReactions = omitOptionalParts(rich, only({ includeReactions: false }));
    expect('reactions' in noReactions).toBe(false);
    expect(noReactions.embeds).toHaveLength(1);
    const noEmbeds = omitOptionalParts(rich, only({ includeEmbeds: false }));
    expect(noEmbeds.reactions).toHaveLength(1);
    expect(noEmbeds.embeds).toEqual([]);
  });

  it('does not add a reactions key to a message that has none', () => {
    expect('reactions' in omitOptionalParts(human, only({ includeReactions: false }))).toBe(false);
  });

  it('removes an empty reactions key too, so the file does not carry it', () => {
    const empty = message(13, { reactions: [] });
    expect('reactions' in omitOptionalParts(empty, only({ includeReactions: false }))).toBe(false);
  });
});
