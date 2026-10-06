import { describe, expect, it } from 'vitest';
import type { Message, User } from '@/lib/discord/types';
import { buildNameResolver } from '@/lib/message';

const user = (id: string, over: Partial<User> = {}): User => ({ id, username: `user${id}`, ...over });

function msg(over: Partial<Message> = {}): Message {
  return {
    id: '100',
    channel_id: '1',
    author: user('1', { global_name: 'Alice' }),
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

describe('buildNameResolver', () => {
  it('starts from the init maps', () => {
    const r = buildNameResolver({ channels: { c1: 'general' }, roles: { r1: 'Mods' }, users: { u1: 'Zed' } });
    expect(r.channel('c1')).toBe('general');
    expect(r.role('r1')).toBe('Mods');
    expect(r.user('u1')).toBe('Zed');
    expect(r.user('nobody')).toBeUndefined();
    expect(r.channel('nobody')).toBeUndefined();
    expect(r.role('nobody')).toBeUndefined();
  });

  it('works with no init at all', () => {
    const r = buildNameResolver();
    expect(r.user('1')).toBeUndefined();
  });

  it('learns display names from authors and mentions', () => {
    const r = buildNameResolver();
    r.addMessages([
      msg({ mentions: [user('2', { global_name: 'Bob' }), user('3', { username: 'carol', global_name: null })] }),
    ]);
    expect(r.user('1')).toBe('Alice');
    expect(r.user('2')).toBe('Bob');
    expect(r.user('3')).toBe('carol');
  });

  it('also learns from replied-to messages, forward snapshots and interactions', () => {
    const r = buildNameResolver();
    r.addMessages([
      msg({
        referenced_message: msg({ author: user('4', { global_name: 'Dave' }), mentions: [user('5', { global_name: 'Eve' })] }),
        message_snapshots: [{ message: { content: '', mentions: [user('6', { global_name: 'Frank' })] } }],
        interaction: { id: '9', type: 2, name: 'x', user: user('7', { global_name: 'Grace' }) },
        interaction_metadata: { id: '9', type: 2, user: user('8', { global_name: 'Heidi' }) },
      }),
    ]);
    expect(r.user('4')).toBe('Dave');
    expect(r.user('5')).toBe('Eve');
    expect(r.user('6')).toBe('Frank');
    expect(r.user('7')).toBe('Grace');
    expect(r.user('8')).toBe('Heidi');
  });

  it('keeps accumulating across addMessages calls and picks up renames', () => {
    const r = buildNameResolver();
    r.addMessages([msg({ author: user('1', { global_name: 'Old' }) })]);
    r.addMessages([msg({ author: user('2', { global_name: 'Second' }) })]);
    expect(r.user('1')).toBe('Old');
    expect(r.user('2')).toBe('Second');
    r.addMessages([msg({ author: user('1', { global_name: 'New' }) })]);
    expect(r.user('1')).toBe('New');
  });

  it('learns channel names from mention_channels, but the channel tree wins', () => {
    const r = buildNameResolver();
    r.addMessages([msg({ mention_channels: [{ id: 'c9', guild_id: 'g', type: 0, name: 'elsewhere' }] })]);
    expect(r.channel('c9')).toBe('elsewhere');
    r.setChannels({ c9: 'tree-name' });
    expect(r.channel('c9')).toBe('tree-name');
    r.setChannels({});
    expect(r.channel('c9')).toBe('elsewhere');
  });

  it('setChannels / setRoles replace the previous map', () => {
    const r = buildNameResolver({ channels: { a: 'one' }, roles: { a: 'R1' } });
    r.setChannels({ b: 'two' });
    r.setRoles({ b: 'R2' });
    expect(r.channel('a')).toBeUndefined();
    expect(r.channel('b')).toBe('two');
    expect(r.role('a')).toBeUndefined();
    expect(r.role('b')).toBe('R2');
  });

  it('does not let prototype-ish ids resolve to inherited members', () => {
    const r = buildNameResolver({ users: { u: 'x' } });
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(r.user(id)).toBeUndefined();
      expect(r.channel(id)).toBeUndefined();
      expect(r.role(id)).toBeUndefined();
    }
  });

  it('accepts hostile ids as ordinary keys', () => {
    const init = JSON.parse('{"__proto__": "evil", "constructor": "ctor"}') as Record<string, string>;
    const r = buildNameResolver({ users: init, channels: init, roles: init });
    expect(r.user('__proto__')).toBe('evil');
    expect(r.channel('constructor')).toBe('ctor');
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });

  it('tolerates messages with missing or malformed fields', () => {
    const r = buildNameResolver();
    const broken = [
      {},
      { author: null, mentions: null },
      { author: { id: 5 }, mentions: [null, {}, { id: '6' }] },
      { mention_channels: [null, { id: 'x' }], message_snapshots: [null, {}] },
      null,
    ] as unknown as Message[];
    expect(() => r.addMessages(broken)).not.toThrow();
    expect(r.user('6')).toBeUndefined();
  });

  it('ignores users whose display name would be empty', () => {
    const r = buildNameResolver();
    r.addMessages([msg({ author: { id: '7' } as unknown as User })]);
    expect(r.user('7')).toBeUndefined();
  });
});
