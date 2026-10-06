import { describe, expect, it } from 'vitest';
import type { Message, User } from '@/lib/discord/types';
import { shouldGroupWithPrevious } from '@/lib/message';

const user = (id: string, over: Partial<User> = {}): User => ({ id, username: `user${id}`, ...over });

function msg(over: Partial<Message> = {}): Message {
  return {
    id: '100',
    channel_id: '1',
    author: user('1'),
    content: 'hi',
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

const at = (iso: string, over: Partial<Message> = {}): Message => msg({ timestamp: iso, ...over });

describe('shouldGroupWithPrevious', () => {
  const T0 = '2026-10-06T06:00:00.000Z';

  it('groups the same author within the window', () => {
    expect(shouldGroupWithPrevious(at(T0), at('2026-10-06T06:03:00.000Z'), 'Asia/Seoul')).toBe(true);
    expect(shouldGroupWithPrevious(at(T0), at(T0), 'Asia/Seoul')).toBe(true);
  });

  it('does not group at exactly 7:00, but groups 1 ms earlier', () => {
    expect(shouldGroupWithPrevious(at(T0), at('2026-10-06T06:07:00.000Z'), 'Asia/Seoul')).toBe(false);
    expect(shouldGroupWithPrevious(at(T0), at('2026-10-06T06:06:59.999Z'), 'Asia/Seoul')).toBe(true);
    expect(shouldGroupWithPrevious(at(T0), at('2026-10-06T06:07:00.001Z'), 'Asia/Seoul')).toBe(false);
  });

  it('treats Discord microsecond timestamps the same way', () => {
    expect(
      shouldGroupWithPrevious(
        at('2026-10-06T06:00:00.000000+00:00'),
        at('2026-10-06T06:06:59.999999+00:00'),
        'UTC',
      ),
    ).toBe(true);
  });

  it('never groups without a previous message', () => {
    expect(shouldGroupWithPrevious(undefined, at(T0), 'UTC')).toBe(false);
  });

  it('never groups different authors', () => {
    expect(shouldGroupWithPrevious(at(T0), at('2026-10-06T06:01:00Z', { author: user('2') }), 'UTC')).toBe(false);
  });

  it('never groups system messages, on either side', () => {
    const join = at('2026-10-06T06:01:00Z', { type: 7 });
    expect(shouldGroupWithPrevious(at(T0), join, 'UTC')).toBe(false);
    expect(shouldGroupWithPrevious(at(T0, { type: 6 }), at('2026-10-06T06:01:00Z'), 'UTC')).toBe(false);
  });

  it('does not group a reply (type 19, message_reference or referenced_message), but groups what follows it', () => {
    const next = at('2026-10-06T06:01:00Z');
    expect(shouldGroupWithPrevious(at(T0), { ...next, type: 19 }, 'UTC')).toBe(false);
    expect(shouldGroupWithPrevious(at(T0), { ...next, message_reference: { message_id: '5' } }, 'UTC')).toBe(false);
    expect(shouldGroupWithPrevious(at(T0), { ...next, referenced_message: msg({ id: '5' }) }, 'UTC')).toBe(false);
    expect(shouldGroupWithPrevious(at(T0, { type: 19, message_reference: { message_id: '5' } }), next, 'UTC')).toBe(true);
  });

  it('does not group across local midnight even when the gap is tiny', () => {
    const before = at('2026-10-06T14:58:00Z'); // 23:58 in Seoul
    const after = at('2026-10-06T15:01:00Z'); // 00:01 next day in Seoul
    expect(shouldGroupWithPrevious(before, after, 'Asia/Seoul')).toBe(false);
    expect(shouldGroupWithPrevious(before, after, 'UTC')).toBe(true);
  });

  it('uses the New York day boundary', () => {
    const before = at('2026-10-07T03:58:00Z'); // 23:58 EDT Oct 6
    const after = at('2026-10-07T04:01:00Z'); // 00:01 EDT Oct 7
    expect(shouldGroupWithPrevious(before, after, 'America/New_York')).toBe(false);
  });

  it('measures the 7 minutes in absolute time across a DST jump', () => {
    // 01:58 EST -> 03:03 EDT is only 5 minutes of real time.
    const before = at('2026-03-08T06:58:00Z');
    const after = at('2026-03-08T07:03:00Z');
    expect(shouldGroupWithPrevious(before, after, 'America/New_York')).toBe(true);
  });

  it('keeps webhook messages with different names or avatars apart', () => {
    const hook = (name: string, avatar: string | null, iso: string): Message =>
      at(iso, { webhook_id: '9', author: user('9', { username: name, avatar }) });
    expect(shouldGroupWithPrevious(hook('A', null, T0), hook('A', null, '2026-10-06T06:01:00Z'), 'UTC')).toBe(true);
    expect(shouldGroupWithPrevious(hook('A', null, T0), hook('B', null, '2026-10-06T06:01:00Z'), 'UTC')).toBe(false);
    expect(shouldGroupWithPrevious(hook('A', 'x', T0), hook('A', 'y', '2026-10-06T06:01:00Z'), 'UTC')).toBe(false);
  });

  it('does not group when a timestamp is unparsable', () => {
    expect(shouldGroupWithPrevious(at('garbage'), at(T0), 'UTC')).toBe(false);
    expect(shouldGroupWithPrevious(at(T0), at(''), 'UTC')).toBe(false);
  });

  it('does not throw on a message without an author', () => {
    const broken = { ...at(T0), author: undefined } as unknown as Message;
    expect(shouldGroupWithPrevious(broken, at(T0), 'UTC')).toBe(false);
    expect(shouldGroupWithPrevious(at(T0), broken, 'UTC')).toBe(false);
  });
});
