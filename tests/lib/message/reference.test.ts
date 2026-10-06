import { describe, expect, it } from 'vitest';
import type { Message, User } from '@/lib/discord/types';
import { referenceView } from '@/lib/message';

const user = (id: string, over: Partial<User> = {}): User => ({ id, username: `user${id}`, ...over });
const ALICE = user('1', { global_name: 'Alice' });
const BOB = user('2', { global_name: 'Bob' });

function msg(over: Partial<Message> = {}): Message {
  return {
    id: '100',
    channel_id: '1',
    author: ALICE,
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

const reply = (original: Partial<Message> | null | undefined, over: Partial<Message> = {}): Message =>
  msg({
    type: 19,
    content: 'sure',
    message_reference: { message_id: '50', channel_id: '1' },
    ...(original === undefined ? {} : { referenced_message: original === null ? null : msg({ id: '50', author: BOB, ...original }) }),
    ...over,
  });

type Reply = Extract<NonNullable<ReturnType<typeof referenceView>>, { kind: 'reply' }>;
const asReply = (m: Message, locale: 'ko' | 'en' = 'en'): Reply => {
  const v = referenceView(m, locale);
  if (!v || v.kind !== 'reply') throw new Error('expected a reply view');
  return v;
};

describe('referenceView: replies', () => {
  it('shows the replied-to author and a one-line preview', () => {
    const v = asReply(reply({ content: 'who wants lunch?' }));
    expect(v).toEqual({ kind: 'reply', author: BOB, preview: 'who wants lunch?', deleted: false });
  });

  it('collapses newlines and strips simple markdown in the preview', () => {
    const v = asReply(reply({ content: '**Heads up**\n\n> quoted\nsee `code` and [link](https://example.com)' }));
    expect(v.preview).toBe('Heads up quoted see code and link');
  });

  it('caps the preview at 140 characters including the ellipsis', () => {
    const v = asReply(reply({ content: 'word '.repeat(100) }));
    expect(v.preview.length).toBeLessThanOrEqual(140);
    expect(v.preview.endsWith('…')).toBe(true);
    expect(v.preview).not.toMatch(/\s…$/);
  });

  it('does not cut a surrogate pair in half', () => {
    const emoji = String.fromCodePoint(0x1f600);
    const v = asReply(reply({ content: emoji.repeat(200) }));
    expect(v.preview.length).toBeLessThanOrEqual(140);
    const withoutEllipsis = v.preview.slice(0, -1);
    expect(withoutEllipsis).toBe(emoji.repeat(withoutEllipsis.length / 2));
  });

  it('attachment-only originals say "Click to see attachment" / "첨부 파일 보기"', () => {
    const attachment = { id: '1', filename: 'a.png', size: 1, url: 'https://cdn.discordapp.com/a.png' };
    expect(asReply(reply({ content: '', attachments: [attachment] }), 'en').preview).toBe('Click to see attachment');
    expect(asReply(reply({ content: '', attachments: [attachment] }), 'ko').preview).toBe('첨부 파일 보기');
  });

  it('content wins over attachments', () => {
    const attachment = { id: '1', filename: 'a.png', size: 1, url: 'https://cdn.discordapp.com/a.png' };
    expect(asReply(reply({ content: 'look', attachments: [attachment] })).preview).toBe('look');
  });

  it('handles sticker-only, embed-only and poll-only originals', () => {
    expect(asReply(reply({ content: '', sticker_items: [{ id: '5', name: 'Wave', format_type: 1 }] })).preview).toBe('[sticker]');
    expect(asReply(reply({ content: '', sticker_items: [{ id: '5', name: 'Wave', format_type: 1 }] }), 'ko').preview).toBe('[스티커]');
    expect(asReply(reply({ content: '', embeds: [{ title: 'Build **passed**' }] })).preview).toBe('Build passed');
    expect(asReply(reply({ content: '', embeds: [{ description: 'Only a description' }] })).preview).toBe('Only a description');
    expect(asReply(reply({ content: '', embeds: [{ type: 'image' }] })).preview).toBe('[embed]');
    expect(asReply(reply({ content: '', poll: { question: { text: 'Lunch?' }, answers: [] } })).preview).toBe('[poll] Lunch?');
  });

  it('shows spoilers as a marker instead of the hidden text', () => {
    expect(asReply(reply({ content: 'the butler did it ||it was him||' })).preview).toBe('the butler did it [spoiler]');
  });

  it('resolves mentions from the original message', () => {
    const v = asReply(reply({ content: 'hi <@3>', mentions: [user('3', { global_name: 'Carol' })] }));
    expect(v.preview).toBe('hi @Carol');
  });

  it('describes a replied-to system message with its system text', () => {
    expect(asReply(reply({ type: 7, content: '', author: BOB })).preview).toBe('Bob joined the server.');
  });

  it('works for thread starter messages (type 21)', () => {
    const starter = msg({ type: 21, content: '', message_reference: { message_id: '50' }, referenced_message: msg({ id: '50', author: BOB, content: 'first post' }) });
    expect(asReply(starter)).toMatchObject({ author: BOB, preview: 'first post', deleted: false });
  });

  it('treats a referenced_message on a default-type message as a reply too', () => {
    const odd = msg({ type: 0, content: 'x', referenced_message: msg({ id: '50', author: BOB, content: 'orig' }) });
    expect(asReply(odd).preview).toBe('orig');
  });
});

describe('referenceView: deleted or unavailable originals', () => {
  it('explicit null means deleted', () => {
    expect(asReply(reply(null), 'en')).toEqual({ kind: 'reply', author: null, preview: 'Original message was deleted', deleted: true });
    expect(asReply(reply(null), 'ko').preview).toBe('원본 메시지가 삭제되었어요');
  });

  it('absent referenced_message means unknown', () => {
    const v = asReply(reply(undefined));
    expect(v).toMatchObject({ author: null, deleted: true });
    expect(v.preview).toBe('Original message is unavailable');
    expect(asReply(reply(undefined), 'ko').preview).toBe('원본 메시지를 불러올 수 없어요');
  });

  it('a reply whose original has no author still renders', () => {
    const v = asReply(reply({ author: undefined as unknown as User, content: 'orphan' }));
    expect(v).toMatchObject({ author: null, preview: 'orphan', deleted: false });
  });
});

describe('referenceView: forwards and non-references', () => {
  it('detects a forward by reference type 1', () => {
    expect(referenceView(msg({ message_reference: { type: 1, message_id: '9', channel_id: '8' } }), 'en')).toEqual({ kind: 'forward' });
  });

  it('detects a forward by its snapshots', () => {
    expect(referenceView(msg({ message_snapshots: [{ message: { content: 'x' } }] }), 'ko')).toEqual({ kind: 'forward' });
  });

  it('is null for ordinary messages', () => {
    expect(referenceView(msg({ content: 'plain' }), 'en')).toBeNull();
    expect(referenceView(msg({ message_snapshots: [] }), 'en')).toBeNull();
  });

  it('is null for a crossposted message (reference present, but no reply)', () => {
    expect(referenceView(msg({ message_reference: { type: 0, message_id: '9', channel_id: '8', guild_id: '7' } }), 'en')).toBeNull();
  });

  it('is null for system messages even though a pin carries a reference', () => {
    const pin = msg({ type: 6, message_reference: { message_id: '9' }, referenced_message: msg({ id: '9', content: 'pinned' }) });
    expect(referenceView(pin, 'en')).toBeNull();
  });

  it('does not throw on an empty message', () => {
    expect(referenceView({} as unknown as Message, 'en')).toBeNull();
  });
});
