import { describe, expect, it } from 'vitest';
import type { MyMember } from '@/lib/discord/client';
import {
  ADMINISTRATOR,
  CONNECT,
  READ_MESSAGE_HISTORY,
  VIEW_CHANNEL,
  computeBasePermissions,
  computeChannelPermissions,
  resolveChannelAccess,
} from '@/lib/discord/permissions';
import type { Channel, PermissionOverwrite, Role } from '@/lib/discord/types';

const GUILD = '900000000000000000';
const USER = '800000000000000001';
const ROLE_A = '700000000000000001';
const ROLE_B = '700000000000000002';
const ROLE_OTHER = '700000000000000003';
const READ = VIEW_CHANNEL | READ_MESSAGE_HISTORY;

const bits = (value: bigint): string => value.toString();

function role(id: string, permissions: bigint, position = 1): Role {
  return { id, name: `role-${id}`, permissions: bits(permissions), position };
}

function overwrite(id: string, type: 0 | 1, allow: bigint, deny: bigint): PermissionOverwrite {
  return { id, type, allow: bits(allow), deny: bits(deny) };
}

let nextId = 100;
function channel(type: number, overwrites: PermissionOverwrite[] = [], extra: Partial<Channel> = {}): Channel {
  // BigInt: ids above 2^53 would collapse into each other as plain numbers.
  return { id: String(600000000000000000n + BigInt(nextId++)), type, permission_overwrites: overwrites, ...extra };
}

const member = (...roles: string[]): MyMember => ({ roles });

describe('permission constants', () => {
  it('match Discord bit positions', () => {
    expect(ADMINISTRATOR).toBe(8n);
    expect(VIEW_CHANNEL).toBe(1024n);
    expect(READ_MESSAGE_HISTORY).toBe(65536n);
    expect(CONNECT).toBe(1048576n);
  });
});

describe('computeBasePermissions', () => {
  it('uses @everyone and the roles the member has, nothing else', () => {
    const roles = [role(GUILD, VIEW_CHANNEL), role(ROLE_A, READ_MESSAGE_HISTORY), role(ROLE_OTHER, ADMINISTRATOR)];
    const base = computeBasePermissions(GUILD, {}, roles, member(ROLE_A));
    expect(base).toBe(READ);
  });

  it('gives the owner everything', () => {
    const base = computeBasePermissions(GUILD, { owner: true }, [], member());
    expect(base & READ).toBe(READ);
    expect(base & ADMINISTRATOR).toBe(ADMINISTRATOR);
  });

  it('gives ADMINISTRATOR holders everything', () => {
    const roles = [role(GUILD, 0n), role(ROLE_A, ADMINISTRATOR)];
    const base = computeBasePermissions(GUILD, {}, roles, member(ROLE_A));
    expect(base & READ).toBe(READ);
  });

  it("OR-s in Discord's own figure from the guild list", () => {
    const base = computeBasePermissions(GUILD, { permissions: bits(READ) }, [], member());
    expect(base).toBe(READ);
    const admin = computeBasePermissions(GUILD, { permissions: bits(ADMINISTRATOR) }, [], member());
    expect(admin & READ).toBe(READ);
  });

  it('ignores a malformed permission string instead of throwing', () => {
    const roles = [{ ...role(GUILD, 0n), permissions: 'not-a-number' }];
    expect(computeBasePermissions(GUILD, { permissions: '' }, roles, member())).toBe(0n);
  });
});

describe('computeChannelPermissions', () => {
  const compute = (base: bigint, ch: Channel, m: MyMember = member()) => computeChannelPermissions(base, ch, GUILD, m, USER);

  it('returns the base permissions when there are no overwrites', () => {
    expect(compute(READ, channel(0))).toBe(READ);
    expect(compute(READ, { id: '1', type: 0 })).toBe(READ);
  });

  it('lets ADMINISTRATOR ignore every overwrite', () => {
    const ch = channel(0, [overwrite(GUILD, 0, 0n, VIEW_CHANNEL)]);
    expect(compute(ADMINISTRATOR, ch) & READ).toBe(READ);
  });

  it('applies the @everyone overwrite (deny hides, allow reveals)', () => {
    expect(compute(READ, channel(0, [overwrite(GUILD, 0, 0n, VIEW_CHANNEL)])) & VIEW_CHANNEL).toBe(0n);
    expect(compute(0n, channel(0, [overwrite(GUILD, 0, READ, 0n)]))).toBe(READ);
  });

  it('ignores overwrites for roles the member does not have', () => {
    const ch = channel(0, [overwrite(ROLE_OTHER, 0, 0n, VIEW_CHANNEL)]);
    expect(compute(READ, ch, member(ROLE_A))).toBe(READ);
  });

  it('role overwrites beat the @everyone overwrite', () => {
    const ch = channel(0, [overwrite(GUILD, 0, 0n, VIEW_CHANNEL), overwrite(ROLE_A, 0, VIEW_CHANNEL, 0n)]);
    expect(compute(READ, ch, member(ROLE_A)) & VIEW_CHANNEL).toBe(VIEW_CHANNEL);
  });

  it('aggregates role overwrites: all denies first, then all allows (an allow on any role wins over a deny on another)', () => {
    const ch = channel(0, [overwrite(ROLE_A, 0, 0n, VIEW_CHANNEL), overwrite(ROLE_B, 0, VIEW_CHANNEL, 0n)]);
    expect(compute(READ, ch, member(ROLE_A, ROLE_B)) & VIEW_CHANNEL).toBe(VIEW_CHANNEL);
    expect(compute(READ, ch, member(ROLE_A)) & VIEW_CHANNEL).toBe(0n);
  });

  it('member overwrites beat role overwrites', () => {
    const denied = channel(0, [overwrite(ROLE_A, 0, VIEW_CHANNEL, 0n), overwrite(USER, 1, 0n, VIEW_CHANNEL)]);
    expect(compute(READ, denied, member(ROLE_A)) & VIEW_CHANNEL).toBe(0n);
    const allowed = channel(0, [overwrite(ROLE_A, 0, 0n, VIEW_CHANNEL), overwrite(USER, 1, VIEW_CHANNEL, 0n)]);
    expect(compute(READ, allowed, member(ROLE_A)) & VIEW_CHANNEL).toBe(VIEW_CHANNEL);
  });

  it('ignores member overwrites of other users, and a role id equal to the user id', () => {
    const ch = channel(0, [overwrite('800000000000000999', 1, 0n, VIEW_CHANNEL), overwrite(USER, 0, 0n, VIEW_CHANNEL)]);
    expect(compute(READ, ch)).toBe(READ);
  });

  it('does not treat a member-type overwrite with the guild id as the @everyone overwrite', () => {
    const ch = channel(0, [overwrite(GUILD, 1, 0n, VIEW_CHANNEL)]);
    expect(compute(READ, ch)).toBe(READ);
  });
});

describe('resolveChannelAccess', () => {
  const baseArgs = (channels: Channel[], roles: Role[] = [role(GUILD, READ)], m: MyMember = member(), threads?: Channel[]) => ({
    guildId: GUILD,
    userId: USER,
    guild: {},
    roles,
    member: m,
    channels,
    threads,
  });

  it('is true when VIEW_CHANNEL and READ_MESSAGE_HISTORY are both present', () => {
    const ch = channel(0);
    expect(resolveChannelAccess(baseArgs([ch]))[ch.id]).toBe(true);
  });

  it('is false without VIEW_CHANNEL or without READ_MESSAGE_HISTORY', () => {
    const noView = channel(0, [overwrite(GUILD, 0, 0n, VIEW_CHANNEL)]);
    const noHistory = channel(0, [overwrite(GUILD, 0, 0n, READ_MESSAGE_HISTORY)]);
    const access = resolveChannelAccess(baseArgs([noView, noHistory]));
    expect(access[noView.id]).toBe(false);
    expect(access[noHistory.id]).toBe(false);
  });

  it('shows a channel to a role granted by an overwrite while everybody else is denied', () => {
    const secret = channel(0, [overwrite(GUILD, 0, 0n, VIEW_CHANNEL), overwrite(ROLE_A, 0, VIEW_CHANNEL, 0n)]);
    const roles = [role(GUILD, READ), role(ROLE_A, 0n)];
    expect(resolveChannelAccess(baseArgs([secret], roles, member(ROLE_A)))[secret.id]).toBe(true);
    expect(resolveChannelAccess(baseArgs([secret], roles, member()))[secret.id]).toBe(false);
  });

  it('only needs VIEW_CHANNEL for categories', () => {
    const category = channel(4, [overwrite(GUILD, 0, 0n, READ_MESSAGE_HISTORY)]);
    const hiddenCategory = channel(4, [overwrite(GUILD, 0, 0n, VIEW_CHANNEL)]);
    const access = resolveChannelAccess(baseArgs([category, hiddenCategory]));
    expect(access[category.id]).toBe(true);
    expect(access[hiddenCategory.id]).toBe(false);
  });

  it('lets the owner and administrators see everything', () => {
    const ch = channel(0, [overwrite(GUILD, 0, 0n, READ)]);
    const owner = resolveChannelAccess({ ...baseArgs([ch], []), guild: { owner: true } });
    expect(owner[ch.id]).toBe(true);
    const admin = resolveChannelAccess(baseArgs([ch], [role(GUILD, 0n), role(ROLE_A, ADMINISTRATOR)], member(ROLE_A)));
    expect(admin[ch.id]).toBe(true);
  });

  it('applies the same rule to stage, announcement and forum channels', () => {
    const channels = [channel(13), channel(5), channel(15), channel(15, [overwrite(GUILD, 0, 0n, VIEW_CHANNEL)])];
    const access = resolveChannelAccess(baseArgs(channels));
    expect(channels.map((c) => access[c.id])).toEqual([true, true, true, false]);
  });

  describe('voice channels need CONNECT as well (Get Channel Messages: "if the channel is a voice channel, they must also have CONNECT")', () => {
    const withConnect = [role(GUILD, READ | CONNECT)];

    it('is true with VIEW_CHANNEL + READ_MESSAGE_HISTORY + CONNECT', () => {
      const voice = channel(2);
      expect(resolveChannelAccess(baseArgs([voice], withConnect))[voice.id]).toBe(true);
    });

    it('is false when the base permissions lack CONNECT, while a text channel with the same permissions stays readable', () => {
      const voice = channel(2);
      const text = channel(0);
      const access = resolveChannelAccess(baseArgs([voice, text]));
      expect(access[voice.id]).toBe(false);
      expect(access[text.id]).toBe(true);
    });

    it('is false when an overwrite denies CONNECT on a voice channel that can still be seen', () => {
      const voice = channel(2, [overwrite(GUILD, 0, 0n, CONNECT)]);
      const text = channel(0, [overwrite(GUILD, 0, 0n, CONNECT)]);
      const access = resolveChannelAccess(baseArgs([voice, text], withConnect));
      expect(access[voice.id]).toBe(false);
      expect(access[text.id]).toBe(true);
    });

    it('is true again for a role that is allowed CONNECT by an overwrite', () => {
      const voice = channel(2, [overwrite(GUILD, 0, 0n, CONNECT), overwrite(ROLE_A, 0, CONNECT, 0n)]);
      const roles = [role(GUILD, READ | CONNECT), role(ROLE_A, 0n)];
      expect(resolveChannelAccess(baseArgs([voice], roles, member(ROLE_A)))[voice.id]).toBe(true);
      expect(resolveChannelAccess(baseArgs([voice], roles, member()))[voice.id]).toBe(false);
    });

    it('lets the owner and administrators in whatever the overwrites say', () => {
      const voice = channel(2, [overwrite(GUILD, 0, 0n, CONNECT)]);
      expect(resolveChannelAccess({ ...baseArgs([voice], []), guild: { owner: true } })[voice.id]).toBe(true);
      const admin = resolveChannelAccess(baseArgs([voice], [role(GUILD, 0n), role(ROLE_A, ADMINISTRATOR)], member(ROLE_A)));
      expect(admin[voice.id]).toBe(true);
    });

    it('does not apply to stage channels (the docs name voice channels only; a wrong lock would block the export)', () => {
      const stage = channel(13, [overwrite(GUILD, 0, 0n, CONNECT)]);
      expect(resolveChannelAccess(baseArgs([stage]))[stage.id]).toBe(true);
    });

    it('is inherited by threads of a voice channel', () => {
      const voice = channel(2);
      const thread = channel(11, [], { parent_id: voice.id });
      expect(resolveChannelAccess(baseArgs([voice], undefined, undefined, [thread]))[thread.id]).toBe(false);
    });
  });

  it('lets threads inherit from their parent channel', () => {
    const open = channel(0);
    const hidden = channel(15, [overwrite(GUILD, 0, 0n, VIEW_CHANNEL)]);
    const t1 = channel(11, [], { parent_id: open.id });
    const t2 = channel(11, [], { parent_id: hidden.id });
    const access = resolveChannelAccess(baseArgs([open, hidden], undefined, undefined, [t1, t2]));
    expect(access[t1.id]).toBe(true);
    expect(access[t2.id]).toBe(false);
  });

  it('also resolves thread-type entries inside `channels` through their parent', () => {
    const parent = channel(0, [overwrite(GUILD, 0, 0n, VIEW_CHANNEL)]);
    const thread = channel(12, [], { parent_id: parent.id });
    expect(resolveChannelAccess(baseArgs([parent, thread]))[thread.id]).toBe(false);
  });

  it('leaves out threads whose parent is unknown (=> unknown access)', () => {
    const orphan = channel(11, [], { parent_id: '123' });
    const noParent = channel(11);
    const access = resolveChannelAccess(baseArgs([], undefined, undefined, [orphan, noParent]));
    expect(access).toEqual({});
  });
});
