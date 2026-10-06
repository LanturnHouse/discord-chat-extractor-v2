import { describe, expect, it } from 'vitest';
import type { Message, User } from '@/lib/discord/types';
import { displayName, isSystemMessage, systemMessageText } from '@/lib/message';

const user = (id: string, over: Partial<User> = {}): User => ({ id, username: `user${id}`, ...over });
const ALICE = user('1', { username: 'alice', global_name: 'Alice' });
const BOB = user('2', { username: 'bob', global_name: 'Bob' });

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
    type: 7,
    ...over,
  };
}

const text = (m: Message, locale: 'ko' | 'en'): string => {
  const out = systemMessageText(m, locale);
  if (out === null) throw new Error('expected a system text');
  return out;
};

describe('displayName', () => {
  it('prefers a non-blank global_name, trimmed', () => {
    expect(displayName(user('1', { username: 'alice', global_name: '  Alice  ' }))).toBe('Alice');
  });

  it('falls back to the username when global_name is missing, null or blank', () => {
    expect(displayName(user('1', { username: 'alice' }))).toBe('alice');
    expect(displayName(user('1', { username: 'alice', global_name: null }))).toBe('alice');
    expect(displayName(user('1', { username: 'alice', global_name: '   ' }))).toBe('alice');
  });

  it('does not throw for a user without a username', () => {
    expect(displayName({ id: '1' } as unknown as User)).toBe('');
  });
});

describe('isSystemMessage', () => {
  it('is false for user-authored types and for a missing type', () => {
    for (const type of [0, 19, 20, 21, 23]) expect(isSystemMessage(msg({ type }))).toBe(false);
    expect(isSystemMessage({ ...msg(), type: undefined } as unknown as Message)).toBe(false);
  });

  it('is true for every other type', () => {
    for (const type of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 18, 22, 24, 25, 26, 27, 28, 29, 30, 31, 32, 44, 46, 999]) {
      expect(isSystemMessage(msg({ type }))).toBe(true);
    }
  });
});

describe('systemMessageText: user-authored types', () => {
  it('returns null', () => {
    for (const type of [0, 19, 20, 21, 23]) {
      expect(systemMessageText(msg({ type, content: 'hello' }), 'en')).toBeNull();
      expect(systemMessageText(msg({ type, content: 'hello' }), 'ko')).toBeNull();
    }
  });
});

describe('systemMessageText: exact wording', () => {
  it('recipient add / remove / leave', () => {
    const add = msg({ type: 1, mentions: [BOB] });
    expect(text(add, 'en')).toBe('Alice added Bob to the group.');
    expect(text(add, 'ko')).toBe('Alice님이 Bob님을 그룹에 추가했어요.');
    const remove = msg({ type: 2, mentions: [BOB] });
    expect(text(remove, 'en')).toBe('Alice removed Bob from the group.');
    expect(text(remove, 'ko')).toBe('Alice님이 Bob님을 그룹에서 내보냈어요.');
    const leave = msg({ type: 2, mentions: [ALICE] });
    expect(text(leave, 'en')).toBe('Alice left the group.');
    expect(text(leave, 'ko')).toBe('Alice님이 그룹을 나갔어요.');
  });

  it('copes with a missing recipient', () => {
    expect(text(msg({ type: 1, mentions: [] }), 'en')).toBe('Alice added someone to the group.');
    expect(text(msg({ type: 1, mentions: [] }), 'ko')).toBe('Alice님이 누군가님을 그룹에 추가했어요.');
    expect(text({ ...msg({ type: 2 }), mentions: undefined } as unknown as Message, 'en')).toBe(
      'Alice removed someone from the group.',
    );
  });

  it('channel name, icon, pin, join', () => {
    expect(text(msg({ type: 4, content: 'new-name' }), 'en')).toBe('Alice changed the channel name: new-name');
    expect(text(msg({ type: 4, content: 'new-name' }), 'ko')).toBe('Alice님이 채널 이름을 변경했어요: new-name');
    expect(text(msg({ type: 4, content: '' }), 'en')).toBe('Alice changed the channel name.');
    expect(text(msg({ type: 5 }), 'en')).toBe('Alice changed the channel icon.');
    expect(text(msg({ type: 5 }), 'ko')).toBe('Alice님이 채널 아이콘을 변경했어요.');
    expect(text(msg({ type: 6 }), 'en')).toBe('Alice pinned a message to this channel.');
    expect(text(msg({ type: 6 }), 'ko')).toBe('Alice님이 이 채널에 메시지를 고정했어요.');
    expect(text(msg({ type: 7 }), 'en')).toBe('Alice joined the server.');
    expect(text(msg({ type: 7 }), 'ko')).toBe('Alice님이 서버에 참여했어요.');
  });

  it('boosts, with and without a count in content', () => {
    expect(text(msg({ type: 8 }), 'en')).toBe('Alice boosted the server.');
    expect(text(msg({ type: 8, content: '1' }), 'en')).toBe('Alice boosted the server.');
    expect(text(msg({ type: 8, content: '3' }), 'en')).toBe('Alice boosted the server 3 times.');
    expect(text(msg({ type: 8, content: '3' }), 'ko')).toBe('Alice님이 서버를 3번 부스트했어요.');
    expect(text(msg({ type: 8, content: 'lots' }), 'en')).toBe('Alice boosted the server.');
    expect(text(msg({ type: 8, content: '0' }), 'en')).toBe('Alice boosted the server.');
  });

  it('boost tiers report the level reached', () => {
    expect(text(msg({ type: 9 }), 'en')).toBe('Alice boosted the server. The server has reached Level 1!');
    expect(text(msg({ type: 10, content: '2' }), 'en')).toBe('Alice boosted the server 2 times. The server has reached Level 2!');
    expect(text(msg({ type: 11 }), 'en')).toContain('Level 3');
    expect(text(msg({ type: 9 }), 'ko')).toBe('Alice님이 서버를 부스트했어요. 서버가 레벨 1에 도달했어요!');
    expect(text(msg({ type: 11, content: '4' }), 'ko')).toBe('Alice님이 서버를 4번 부스트했어요. 서버가 레벨 3에 도달했어요!');
  });

  it('thread and follow, stage events', () => {
    expect(text(msg({ type: 18, content: 'Release plan' }), 'en')).toBe('Alice started a thread: Release plan');
    expect(text(msg({ type: 18, content: 'Release plan' }), 'ko')).toBe('Alice님이 스레드를 시작했어요: Release plan');
    expect(text(msg({ type: 18 }), 'en')).toBe('Alice started a thread.');
    expect(text(msg({ type: 12, content: 'News' }), 'en')).toBe('Alice added a channel follow to this channel: News');
    expect(text(msg({ type: 27, content: 'AMA' }), 'en')).toBe('Alice started the Stage: AMA');
    expect(text(msg({ type: 28, content: 'AMA' }), 'ko')).toBe('Alice님이 스테이지를 종료했어요: AMA');
    expect(text(msg({ type: 29 }), 'en')).toBe('Alice is now a speaker.');
    expect(text(msg({ type: 30 }), 'ko')).toBe('Alice님이 발언을 요청했어요.');
    expect(text(msg({ type: 31, content: 'Q&A' }), 'en')).toBe('Alice changed the Stage topic: Q&A');
  });

  it('automod and role subscription', () => {
    expect(text(msg({ type: 24 }), 'en')).toBe('AutoMod took action on a message from Alice.');
    expect(text(msg({ type: 24 }), 'ko')).toBe('AutoMod가 Alice님의 메시지에 조치를 취했어요.');
    expect(text(msg({ type: 25 }), 'en')).toBe('Alice subscribed to a role.');
    expect(text(msg({ type: 25 }), 'ko')).toBe('Alice님이 역할을 구독했어요.');
  });

  it('discovery notices and the invite reminder have no human actor', () => {
    expect(text(msg({ type: 14 }), 'en')).toMatch(/removed from Server Discovery/);
    expect(text(msg({ type: 15 }), 'en')).toMatch(/eligible for Server Discovery again/);
    expect(text(msg({ type: 22 }), 'en')).toMatch(/invite/i);
    expect(text(msg({ type: 14 }), 'ko')).toMatch(/서버 탐색/);
    expect(text(msg({ type: 15 }), 'ko')).toMatch(/서버 탐색/);
    expect(text(msg({ type: 22 }), 'ko')).toMatch(/초대/);
  });
});

describe('systemMessageText: calls', () => {
  const call = (call: Message['call'], over: Partial<Message> = {}): Message => msg({ type: 3, call, ...over });

  it('started (no end yet, or no call object at all)', () => {
    expect(text(call({ participants: ['1'], ended_timestamp: null }), 'en')).toBe('Alice started a call.');
    expect(text(msg({ type: 3 }), 'en')).toBe('Alice started a call.');
    expect(text(msg({ type: 3 }), 'ko')).toBe('Alice님이 통화를 시작했어요.');
  });

  it('ended with a duration', () => {
    const lasted = (end: string, locale: 'ko' | 'en') =>
      text(call({ participants: ['1', '2'], ended_timestamp: end }), locale);
    expect(lasted('2026-10-06T06:05:00.000000+00:00', 'en')).toBe('Alice started a call that lasted 5 minutes.');
    expect(lasted('2026-10-06T06:05:00.000000+00:00', 'ko')).toBe('Alice님이 시작한 통화가 5분 동안 이어졌어요.');
    expect(lasted('2026-10-06T06:00:42.000000+00:00', 'en')).toBe('Alice started a call that lasted 42 seconds.');
    expect(lasted('2026-10-06T06:01:00.000000+00:00', 'en')).toBe('Alice started a call that lasted 1 minute.');
    expect(lasted('2026-10-06T06:00:01.000000+00:00', 'en')).toBe('Alice started a call that lasted 1 second.');
    expect(lasted('2026-10-06T07:05:00.000000+00:00', 'en')).toBe('Alice started a call that lasted 1 hour 5 minutes.');
    expect(lasted('2026-10-06T09:00:00.000000+00:00', 'en')).toBe('Alice started a call that lasted 3 hours.');
    expect(lasted('2026-10-06T07:05:00.000000+00:00', 'ko')).toBe('Alice님이 시작한 통화가 1시간 5분 동안 이어졌어요.');
  });

  it('ended with only the caller present is a missed call', () => {
    const missed = call({ participants: ['1'], ended_timestamp: '2026-10-06T06:00:30.000000+00:00' });
    expect(text(missed, 'en')).toBe('Missed call from Alice.');
    expect(text(missed, 'ko')).toBe('Alice님의 부재중 통화');
    expect(text(call({ participants: [], ended_timestamp: '2026-10-06T06:00:30.000000+00:00' }), 'en')).toBe(
      'Missed call from Alice.',
    );
  });

  it('falls back to "started" when the end time is unusable', () => {
    expect(text(call({ participants: ['1', '2'], ended_timestamp: 'junk' }), 'en')).toBe('Alice started a call.');
    expect(text(call({ participants: ['1', '2'], ended_timestamp: '2026-10-06T05:00:00Z' }), 'en')).toBe('Alice started a call.');
  });
});

describe('systemMessageText: coverage of every listed type, both languages', () => {
  const ACTOR_TYPES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 18, 24, 25, 27, 28, 29, 30, 31];
  const ACTORLESS_TYPES = [14, 15, 22];

  it('is a non-empty single line that names the author wherever there is an actor', () => {
    for (const locale of ['en', 'ko'] as const) {
      for (const type of [...ACTOR_TYPES, ...ACTORLESS_TYPES]) {
        const out = text(msg({ type, mentions: [BOB], content: 'x' }), locale);
        expect(out.length, `type ${type} ${locale}`).toBeGreaterThan(0);
        expect(out, `type ${type} ${locale}`).not.toMatch(/[\r\n]/);
        expect(out, `type ${type} ${locale}`).not.toMatch(/System message|시스템 메시지/);
        if (ACTOR_TYPES.includes(type)) expect(out, `type ${type} ${locale}`).toContain('Alice');
      }
    }
  });

  it('English and Korean wording differ for every type', () => {
    for (const type of [...ACTOR_TYPES, ...ACTORLESS_TYPES]) {
      expect(text(msg({ type, mentions: [BOB] }), 'en')).not.toBe(text(msg({ type, mentions: [BOB] }), 'ko'));
    }
  });

  it('uses the generic line for unknown / unlisted types', () => {
    for (const type of [13, 16, 17, 26, 32, 44, 46, 999]) {
      expect(text(msg({ type }), 'en')).toBe(`[System message (type ${type})]`);
      expect(text(msg({ type }), 'ko')).toBe(`[시스템 메시지 (유형 ${type})]`);
    }
  });
});

describe('systemMessageText: hostile and missing data', () => {
  it('uses the username when there is no display name, and a placeholder when there is no author', () => {
    expect(text(msg({ type: 7, author: user('9', { username: 'zed' }) }), 'en')).toBe('zed joined the server.');
    const orphan = { ...msg({ type: 7 }), author: undefined } as unknown as Message;
    expect(text(orphan, 'en')).toBe('Unknown user joined the server.');
    expect(text(orphan, 'ko')).toBe('알 수 없는 사용자님이 서버에 참여했어요.');
  });

  it('keeps every output on one line and bounded, whatever the content', () => {
    const bidi = String.fromCharCode(0x202e);
    const hostile = `line1\nline2\r\n${bidi}evil${'x'.repeat(5000)}`;
    for (const type of [4, 12, 18, 27, 28, 31]) {
      const out = text(msg({ type, content: hostile }), 'en');
      expect(out).not.toMatch(/[\r\n]/);
      expect(out).not.toContain(bidi);
      expect(out.length).toBeLessThan(250);
    }
    const name = user('5', { username: 'x', global_name: `A\nB${bidi}C` });
    expect(text(msg({ type: 7, author: name }), 'en')).toBe('A B C joined the server.');
  });

  it('does not throw on a message that is mostly empty', () => {
    const bare = { type: 7 } as unknown as Message;
    expect(systemMessageText(bare, 'en')).toBe('Unknown user joined the server.');
    expect(systemMessageText({ type: 3 } as unknown as Message, 'ko')).toBe('알 수 없는 사용자님이 통화를 시작했어요.');
  });

  it('falls back to English for an unexpected locale', () => {
    expect(systemMessageText(msg({ type: 7 }), 'de' as unknown as 'en')).toBe('Alice joined the server.');
  });
});
