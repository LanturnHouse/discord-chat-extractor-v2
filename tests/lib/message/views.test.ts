import { describe, expect, it } from 'vitest';
import type { Message, Poll, Reaction, StickerItem, User } from '@/lib/discord/types';
import { forwardView, pollView, reactionView, stickerView } from '@/lib/message';

const user = (id: string, over: Partial<User> = {}): User => ({ id, username: `user${id}`, ...over });

function msg(over: Partial<Message> = {}): Message {
  return {
    id: '100',
    channel_id: '1',
    author: user('1'),
    content: '',
    timestamp: '2026-10-06T06:00:00.000000+00:00',
    edited_timestamp: null,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    type: 0,
    ...over,
  };
}

describe('reactionView', () => {
  it('unicode emoji: the label is the emoji itself, no image', () => {
    const smile = String.fromCodePoint(0x1f604);
    expect(reactionView({ count: 3, me: true, emoji: { id: null, name: smile } })).toEqual({
      key: smile,
      label: smile,
      imageUrl: null,
      count: 3,
      me: true,
    });
  });

  it('custom emoji: CDN image and :name: label', () => {
    expect(reactionView({ count: 1, emoji: { id: '123456789012345678', name: 'party' } })).toEqual({
      key: '123456789012345678',
      label: ':party:',
      imageUrl: 'https://cdn.discordapp.com/emojis/123456789012345678.png?size=32',
      count: 1,
      me: false,
    });
  });

  it('animated custom emoji use the animated WebP', () => {
    const view = reactionView({ count: 2, emoji: { id: '42', name: 'dance', animated: true } });
    expect(view.imageUrl).toBe('https://cdn.discordapp.com/emojis/42.webp?size=32&animated=true');
  });

  it('keeps distinct keys for distinct emoji', () => {
    const a = reactionView({ count: 1, emoji: { id: '1', name: 'x' } });
    const b = reactionView({ count: 1, emoji: { id: '2', name: 'x' } });
    expect(a.key).not.toBe(b.key);
  });

  it('never builds an image URL from a non-numeric id', () => {
    const view = reactionView({ count: 1, emoji: { id: '1/../../x?y=z#', name: 'evil' } });
    expect(view.imageUrl).toBeNull();
    expect(view.label).toBe(':evil:');
  });

  it('tolerates missing names, counts and flags', () => {
    expect(reactionView({ emoji: { id: '7', name: null } } as unknown as Reaction)).toMatchObject({
      label: ':emoji:',
      count: 0,
      me: false,
    });
    expect(reactionView({ count: -4, emoji: { id: null, name: 'x' } }).count).toBe(0);
    expect(reactionView({ count: 2.9, emoji: { id: null, name: 'x' } }).count).toBe(2);
    expect(reactionView({ count: Number.NaN, emoji: { id: null, name: 'x' } }).count).toBe(0);
    expect(reactionView({} as unknown as Reaction)).toEqual({ key: '', label: '', imageUrl: null, count: 0, me: false });
  });
});

describe('stickerView', () => {
  it('PNG and APNG stickers use the media host .png', () => {
    expect(stickerView({ id: '55', name: 'Wave', format_type: 1 })).toEqual({
      name: 'Wave',
      imageUrl: 'https://media.discordapp.net/stickers/55.png?size=160',
    });
    expect(stickerView({ id: '55', name: 'Wave', format_type: 2 }).imageUrl).toBe('https://media.discordapp.net/stickers/55.png?size=160');
  });

  it('GIF stickers use .gif', () => {
    expect(stickerView({ id: '55', name: 'Spin', format_type: 4 }).imageUrl).toBe('https://media.discordapp.net/stickers/55.gif?size=160');
  });

  it('Lottie stickers have no static image', () => {
    expect(stickerView({ id: '55', name: 'Fancy', format_type: 3 })).toEqual({ name: 'Fancy', imageUrl: null });
  });

  it('rejects odd ids and survives missing fields', () => {
    expect(stickerView({ id: '../x', name: 'n', format_type: 1 }).imageUrl).toBeNull();
    expect(stickerView({} as unknown as StickerItem)).toEqual({ name: '', imageUrl: null });
    expect(stickerView({ id: '9' } as unknown as StickerItem).imageUrl).toBe('https://media.discordapp.net/stickers/9.png?size=160');
  });
});

describe('pollView', () => {
  const poll: Poll = {
    question: { text: 'Lunch?' },
    answers: [
      { answer_id: 1, poll_media: { text: 'Pizza', emoji: { id: null, name: String.fromCodePoint(0x1f355) } } },
      { answer_id: 2, poll_media: { text: 'Sushi', emoji: { id: '77', name: 'sushi' } } },
      { answer_id: 3, poll_media: { text: 'Salad' } },
    ],
    allow_multiselect: true,
    results: { is_finalized: true, answer_counts: [{ id: 1, count: 5, me_voted: true }, { id: 2, count: 2 }] },
  };

  it('maps a finalized multiselect poll', () => {
    expect(pollView(poll)).toEqual({
      question: 'Lunch?',
      answers: [
        { text: 'Pizza', emoji: String.fromCodePoint(0x1f355), votes: 5 },
        { text: 'Sushi', emoji: ':sushi:', votes: 2 },
        { text: 'Salad', emoji: null, votes: 0 }, // omitted from answer_counts => nobody voted
      ],
      totalVotes: 7,
      finalized: true,
      multiselect: true,
    });
  });

  it('reports unknown votes as null when the API sent no results', () => {
    const out = pollView({ question: { text: 'Q' }, answers: [{ answer_id: 1, poll_media: { text: 'A' } }] });
    expect(out).toEqual({
      question: 'Q',
      answers: [{ text: 'A', emoji: null, votes: null }],
      totalVotes: null,
      finalized: false,
      multiselect: false,
    });
  });

  it('an unfinished poll with results is not finalized', () => {
    const out = pollView({ ...poll, results: { is_finalized: false, answer_counts: [] } });
    expect(out.finalized).toBe(false);
    expect(out.totalVotes).toBe(0);
    expect(out.answers.every((a) => a.votes === 0)).toBe(true);
  });

  it('tolerates a malformed poll', () => {
    expect(pollView({} as unknown as Poll)).toEqual({ question: '', answers: [], totalVotes: null, finalized: false, multiselect: false });
    const out = pollView({
      question: {},
      answers: [null, { answer_id: 'x', poll_media: null }, {}] as unknown as Poll['answers'],
      results: { is_finalized: true, answer_counts: [null, { id: 1, count: -3 }] } as unknown as Poll['results'],
    });
    expect(out.answers).toHaveLength(3);
    expect(out.answers.every((a) => a.text === '' && a.votes === 0)).toBe(true);
    expect(out.totalVotes).toBe(0);
  });
});

describe('forwardView', () => {
  it('lists the snapshots of a forwarded message', () => {
    const attachment = { id: '1', filename: 'a.png', size: 1, url: 'https://cdn.discordapp.com/a.png' };
    const out = forwardView(
      msg({
        message_reference: { type: 1, message_id: '5', channel_id: '6' },
        message_snapshots: [
          { message: { content: 'original', timestamp: '2026-10-05T01:00:00.000000+00:00', attachments: [attachment], embeds: [{ title: 'e' }] } },
          { message: { content: 'second' } },
        ],
      }),
    );
    expect(out).toEqual([
      { content: 'original', attachments: [attachment], embeds: [{ title: 'e' }], timestamp: '2026-10-05T01:00:00.000000+00:00' },
      { content: 'second', attachments: [], embeds: [], timestamp: null },
    ]);
  });

  it('is empty for ordinary messages and malformed snapshots', () => {
    expect(forwardView(msg())).toEqual([]);
    expect(forwardView({} as unknown as Message)).toEqual([]);
    expect(forwardView(msg({ message_snapshots: 'x' as unknown as [] }))).toEqual([]);
    expect(forwardView(msg({ message_snapshots: [null, {}, { message: null }] as unknown as [] }))).toEqual([]);
  });

  it('defaults missing pieces of a snapshot', () => {
    const out = forwardView(msg({ message_snapshots: [{ message: { content: undefined, attachments: 'x', embeds: null } as never }] }));
    expect(out).toEqual([{ content: '', attachments: [], embeds: [], timestamp: null }]);
  });
});
