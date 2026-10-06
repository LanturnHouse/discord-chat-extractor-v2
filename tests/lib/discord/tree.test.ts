import { describe, expect, it } from 'vitest';
import type { ChannelKind, ChannelNode, GuildNode } from '@/lib/discord/model';
import type { Channel, User } from '@/lib/discord/types';
import { CDN_BASE } from '@/lib/discord/constants';
import {
  buildDmNodes,
  buildGuildTree,
  channelKindOf,
  chatKindOf,
  isExportable,
  makeDmExportTarget,
  makeGuildExportTarget,
  toGuildNode,
} from '@/lib/discord/tree';

const GUILD_ID = '900000000000000000';

describe('chatKindOf', () => {
  it.each<[number, string | null]>([
    [0, 'guild-channel'],
    [1, 'dm'],
    [2, 'guild-channel'],
    [3, 'group-dm'],
    [4, null],
    [5, 'guild-channel'],
    [10, 'thread'],
    [11, 'thread'],
    [12, 'thread'],
    [13, 'guild-channel'],
    [14, null],
    [15, 'forum'],
    [16, 'forum'],
    [99, null],
    [-1, null],
  ])('channel type %i is %s', (type, kind) => {
    expect(chatKindOf(type)).toBe(kind);
  });
});

function ch(id: string, type: number, extra: Partial<Channel> = {}): Channel {
  return { id, type, guild_id: GUILD_ID, name: `ch-${id}`, ...extra };
}

const ids = (nodes: { id: string }[]): string[] => nodes.map((n) => n.id);

describe('channelKindOf', () => {
  it.each<[number, ChannelKind]>([
    [0, 'text'],
    [1, 'dm'],
    [2, 'voice'],
    [3, 'group-dm'],
    [4, 'category'],
    [5, 'announcement'],
    [10, 'thread'],
    [11, 'thread'],
    [12, 'thread'],
    [13, 'stage'],
    [14, 'other'],
    [15, 'forum'],
    [16, 'media'],
    [6, 'other'],
    [999, 'other'],
  ])('type %i -> %s', (type, kind) => {
    expect(channelKindOf(type)).toBe(kind);
  });
});

describe('toGuildNode', () => {
  it('builds a sized icon url and the owner flag', () => {
    const node = toGuildNode({ id: '123456789012345678', name: 'Guild', icon: 'abcdef', owner: true });
    expect(node).toEqual({
      id: '123456789012345678',
      name: 'Guild',
      iconUrl: `${CDN_BASE}/icons/123456789012345678/abcdef.png?size=96`,
      owner: true,
    });
  });

  it('has no icon url without a hash and defaults owner to false', () => {
    expect(toGuildNode({ id: '1', name: 'G', icon: null })).toEqual({ id: '1', name: 'G', iconUrl: null, owner: false });
  });
});

describe('buildGuildTree: sorting', () => {
  it('lists uncategorized channels separately and categories ordered by position then id', () => {
    const tree = buildGuildTree(GUILD_ID, [
      ch('203', 4, { position: 2, name: 'late' }),
      ch('202', 4, { position: 1, name: 'tie-b' }),
      ch('201', 4, { position: 1, name: 'tie-a' }),
      ch('100', 0, { position: 9 }),
      ch('101', 0, { position: 3 }),
      ch('300', 0, { parent_id: '201', position: 0 }),
    ]);
    expect(ids(tree.uncategorized)).toEqual(['101', '100']);
    expect(ids(tree.categories)).toEqual(['201', '202', '203']);
    expect(tree.categories.map((c) => c.name)).toEqual(['tie-a', 'tie-b', 'late']);
    expect(ids(tree.categories[0]!.channels)).toEqual(['300']);
  });

  it('puts every non-voice channel before voice and stage channels, each group by position then id', () => {
    const tree = buildGuildTree(GUILD_ID, [
      ch('10', 4),
      ch('11', 2, { parent_id: '10', position: 0 }), // voice at position 0 still comes after all text-like channels
      ch('12', 13, { parent_id: '10', position: 1 }),
      ch('13', 0, { parent_id: '10', position: 7 }),
      ch('14', 5, { parent_id: '10', position: 5 }),
      ch('15', 15, { parent_id: '10', position: 6 }),
      ch('16', 16, { parent_id: '10', position: 6 }),
    ]);
    expect(ids(tree.categories[0]!.channels)).toEqual(['14', '15', '16', '13', '11', '12']);
  });

  it('applies the voice-after-text rule to uncategorized channels as well', () => {
    const tree = buildGuildTree(GUILD_ID, [ch('1', 2, { position: 0 }), ch('2', 0, { position: 5 }), ch('3', 13, { position: 1 })]);
    expect(ids(tree.uncategorized)).toEqual(['2', '1', '3']);
  });

  it('compares ids numerically (not as numbers, not lexicographically) when positions tie', () => {
    const small = '999999999999999999';
    const big = '1000000000000000000';
    const tree = buildGuildTree(GUILD_ID, [ch(big, 0, { position: 0 }), ch(small, 0, { position: 0 })]);
    expect(ids(tree.uncategorized)).toEqual([small, big]);
  });

  it('treats a missing position as 0', () => {
    const tree = buildGuildTree(GUILD_ID, [ch('5', 0, { position: 1 }), ch('6', 0)]);
    expect(ids(tree.uncategorized)).toEqual(['6', '5']);
  });

  it('shows channels whose category is missing from the list as uncategorized instead of losing them', () => {
    const tree = buildGuildTree(GUILD_ID, [ch('1', 0, { parent_id: '404404' })]);
    expect(ids(tree.uncategorized)).toEqual(['1']);
  });

  it('does not mutate its input', () => {
    const input = [ch('2', 0, { position: 2 }), ch('1', 0, { position: 1 })];
    const copy = structuredClone(input);
    buildGuildTree(GUILD_ID, input);
    expect(input).toEqual(copy);
  });
});

describe('buildGuildTree: nodes and access', () => {
  it('maps channel fields', () => {
    const tree = buildGuildTree(GUILD_ID, [
      ch('1', 0, { name: 'general', topic: 'hello', nsfw: true, position: 4, parent_id: '9' }),
      ch('9', 4),
      { id: '2', type: 2 },
    ]);
    expect(tree.byId['1']).toEqual({
      id: '1',
      guildId: GUILD_ID,
      kind: 'text',
      name: 'general',
      parentId: '9',
      position: 4,
      topic: 'hello',
      nsfw: true,
      canView: null,
    });
    expect(tree.byId['2']).toMatchObject({ guildId: GUILD_ID, name: '', parentId: null, position: 0, topic: null, nsfw: false });
  });

  it('keeps hidden channels with canView=false and sets canView from access (missing => null)', () => {
    const tree = buildGuildTree(GUILD_ID, [ch('1', 0), ch('2', 0), ch('3', 0)], [], { '1': true, '2': false });
    expect(tree.uncategorized.map((n) => [n.id, n.canView])).toEqual([
      ['1', true],
      ['2', false],
      ['3', null],
    ]);
  });

  it('has canView null everywhere without an access map', () => {
    const tree = buildGuildTree(GUILD_ID, [ch('1', 0)]);
    expect(tree.byId['1']!.canView).toBeNull();
  });

  it('puts every non-category channel and every thread in byId, but no categories', () => {
    const tree = buildGuildTree(GUILD_ID, [ch('10', 4), ch('11', 0, { parent_id: '10' }), ch('12', 15), ch('13', 2)], [ch('20', 11, { parent_id: '12' })]);
    expect(Object.keys(tree.byId).sort()).toEqual(['11', '12', '13', '20']);
    expect(tree.byId['12']!.kind).toBe('forum');
  });

  it('ignores DM channels and duplicate ids', () => {
    const tree = buildGuildTree(GUILD_ID, [ch('1', 0), ch('1', 0, { name: 'dupe' }), ch('2', 1), ch('3', 3)]);
    expect(ids(tree.uncategorized)).toEqual(['1']);
    expect(tree.byId['1']!.name).toBe('ch-1');
  });

  it('copes with an empty guild', () => {
    expect(buildGuildTree(GUILD_ID, [])).toEqual({ guildId: GUILD_ID, uncategorized: [], categories: [], threadsByParent: {}, byId: {} });
  });
});

describe('buildGuildTree: categories', () => {
  it('drops a category only when it is empty AND the user cannot see it', () => {
    const channels = [
      ch('1', 4), // empty, hidden  -> dropped
      ch('2', 4), // empty, visible -> kept
      ch('3', 4), // empty, unknown -> kept
      ch('4', 4), // hidden but has channels -> kept
      ch('40', 0, { parent_id: '4' }),
    ];
    const tree = buildGuildTree(GUILD_ID, channels, [], { '1': false, '2': true, '4': false, '40': true });
    expect(ids(tree.categories)).toEqual(['2', '3', '4']);
  });

  it('keeps hidden channels inside a visible category', () => {
    const tree = buildGuildTree(GUILD_ID, [ch('1', 4), ch('2', 0, { parent_id: '1' })], [], { '1': true, '2': false });
    expect(tree.categories[0]!.channels[0]).toMatchObject({ id: '2', canView: false });
  });
});

describe('buildGuildTree: threads', () => {
  it('attaches threads to their parent, newest (highest id) first, with kind thread', () => {
    const forum = ch('50', 15);
    const threads = [
      ch('100000000000000010', 11, { parent_id: '50', name: 'old' }),
      ch('100000000000000030', 11, { parent_id: '50', name: 'new' }),
      ch('99999999999999999', 11, { parent_id: '50', name: 'oldest, shorter id' }),
      ch('100000000000000020', 12, { parent_id: '51', name: 'other parent' }),
    ];
    const tree = buildGuildTree(GUILD_ID, [forum], threads);
    expect(tree.threadsByParent['50']!.map((t) => t.name)).toEqual(['new', 'old', 'oldest, shorter id']);
    expect(tree.threadsByParent['50']!.every((t) => t.kind === 'thread')).toBe(true);
    expect(ids(tree.threadsByParent['51']!)).toEqual(['100000000000000020']);
  });

  it('flags archived threads, inherits canView from access and de-duplicates', () => {
    const t = ch('70', 11, { parent_id: '50', thread_metadata: { archived: true } });
    const tree = buildGuildTree(GUILD_ID, [ch('50', 0)], [t, { ...t }, ch('71', 11, { parent_id: '50' })], { '70': false, '71': true });
    expect(tree.threadsByParent['50']).toHaveLength(2);
    expect(tree.byId['70']).toMatchObject({ archived: true, canView: false, parentId: '50' });
    expect(tree.byId['71']).toMatchObject({ archived: false, canView: true });
  });

  it('does not add thread entries to the channel lists', () => {
    const tree = buildGuildTree(GUILD_ID, [ch('50', 0), ch('51', 11, { parent_id: '50' })], [ch('52', 11, { parent_id: '50' })]);
    expect(ids(tree.uncategorized)).toEqual(['50']);
    expect(tree.threadsByParent['50']).toHaveLength(1);
    expect(tree.byId['52']).toBeDefined();
  });

  it('keeps a thread without a parent in byId but out of threadsByParent', () => {
    const tree = buildGuildTree(GUILD_ID, [], [ch('9', 11)]);
    expect(tree.byId['9']).toBeDefined();
    expect(tree.threadsByParent).toEqual({});
  });
});

function user(id: string, username: string, extra: Partial<User> = {}): User {
  return { id, username, ...extra };
}

describe('buildDmNodes', () => {
  const alice = user('300000000000000001', 'alice', { global_name: 'Alice A', avatar: 'av1' });
  const bob = user('300000000000000002', 'bob', { global_name: null });
  const carol = user('300000000000000003', 'carol', { global_name: '   ' });

  it('keeps only 1:1 and group DMs', () => {
    const nodes = buildDmNodes([
      { id: '1', type: 1, recipients: [alice] },
      { id: '2', type: 3, recipients: [alice, bob] },
      { id: '3', type: 0 },
      { id: '4', type: 2 },
    ]);
    expect(nodes.map((n) => n.kind).sort()).toEqual(['dm', 'group-dm']);
  });

  it('sorts by last_message_id descending, null last, ties by channel id descending', () => {
    const nodes = buildDmNodes([
      { id: '10', type: 1, recipients: [alice], last_message_id: '500' },
      { id: '11', type: 1, recipients: [alice], last_message_id: null },
      { id: '12', type: 1, recipients: [alice], last_message_id: '1500' },
      { id: '13', type: 1, recipients: [alice], last_message_id: '500' },
      { id: '14', type: 1, recipients: [alice] },
      { id: '15', type: 1, recipients: [alice], last_message_id: '99' },
    ]);
    // 1500 > 500 > 99 as numbers (not as strings), then the channels without messages, newest channel id first.
    expect(ids(nodes)).toEqual(['12', '13', '10', '15', '14', '11']);
    expect(nodes.find((n) => n.id === '14')!.lastMessageId).toBeNull();
  });

  it('names a 1:1 DM after the recipient: global name, else username (also for blank global names)', () => {
    const names = buildDmNodes([
      { id: '1', type: 1, recipients: [alice] },
      { id: '2', type: 1, recipients: [bob] },
      { id: '3', type: 1, recipients: [carol] },
    ]).map((n) => [n.id, n.name]);
    expect(names).toEqual(
      expect.arrayContaining([
        ['1', 'Alice A'],
        ['2', 'bob'],
        ['3', 'carol'],
      ]),
    );
  });

  it('names a group after its name, else its recipients joined with ", "', () => {
    const nodes = buildDmNodes([
      { id: '1', type: 3, name: 'Study group', recipients: [alice, bob] },
      { id: '2', type: 3, name: null, recipients: [alice, bob] },
      { id: '3', type: 3, name: '  ', recipients: [bob, carol] },
    ]);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n.name]));
    expect(byId).toEqual({ '1': 'Study group', '2': 'Alice A, bob', '3': 'bob, carol' });
  });

  it('uses the recipient avatar for 1:1 DMs and falls back to the default avatar', () => {
    const [withAvatar, withoutAvatar] = buildDmNodes([
      { id: '2', type: 1, recipients: [alice] },
      { id: '1', type: 1, recipients: [bob] },
    ]);
    expect(withAvatar!.iconUrl).toBe(`${CDN_BASE}/avatars/${alice.id}/av1.png?size=80`);
    expect(withoutAvatar!.iconUrl).toMatch(new RegExp(`^${CDN_BASE}/embed/avatars/[0-5]\\.png$`));
  });

  it('uses the group icon when set, else the first recipient avatar', () => {
    const nodes = buildDmNodes([
      { id: '5', type: 3, icon: 'gh', recipients: [alice] },
      { id: '4', type: 3, icon: null, recipients: [alice, bob] },
    ]);
    expect(nodes.find((n) => n.id === '5')!.iconUrl).toBe(`${CDN_BASE}/channel-icons/5/gh.png?size=80`);
    expect(nodes.find((n) => n.id === '4')!.iconUrl).toBe(`${CDN_BASE}/avatars/${alice.id}/av1.png?size=80`);
  });

  it('maps recipients with name, username and an always resolvable avatar', () => {
    const [node] = buildDmNodes([{ id: '1', type: 3, recipients: [alice, bob] }]);
    expect(node!.recipients).toEqual([
      { id: alice.id, name: 'Alice A', username: 'alice', avatarUrl: `${CDN_BASE}/avatars/${alice.id}/av1.png?size=80` },
      { id: bob.id, name: 'bob', username: 'bob', avatarUrl: expect.stringContaining('/embed/avatars/') },
    ]);
  });

  it('survives DMs without recipients', () => {
    const nodes = buildDmNodes([
      { id: '1', type: 1 },
      { id: '2', type: 3 },
    ]);
    for (const n of nodes) {
      expect(n.name).not.toBe('');
      expect(n.iconUrl).toMatch(/^https:\/\//);
    }
  });
});

describe('export targets and isExportable', () => {
  const guild: GuildNode = { id: GUILD_ID, name: 'My Server', iconUrl: 'https://cdn.example/icon.png', owner: false };

  const tree = buildGuildTree(
    GUILD_ID,
    [
      ch('10', 4, { name: 'Text Channels' }),
      ch('11', 0, { name: 'general', parent_id: '10', topic: 'Welcome' }),
      ch('12', 15, { name: 'help-forum', parent_id: '10' }),
      ch('13', 0, { name: 'lonely' }),
      ch('14', 15, { name: 'loose-forum' }),
    ],
    [
      ch('20', 11, { name: 'How do I?', parent_id: '12' }),
      ch('21', 11, { name: 'Loose post', parent_id: '14' }),
      ch('22', 11, { name: 'Orphan', parent_id: '999' }),
    ],
  );

  it('resolves the category of a normal channel', () => {
    expect(makeGuildExportTarget(tree.byId['11']!, guild, tree)).toEqual({
      channelId: '11',
      kind: 'text',
      channelName: 'general',
      guildId: GUILD_ID,
      guildName: 'My Server',
      categoryName: 'Text Channels',
      parentChannelName: null,
      topic: 'Welcome',
      iconUrl: 'https://cdn.example/icon.png',
    });
  });

  it('has no category for uncategorized channels', () => {
    expect(makeGuildExportTarget(tree.byId['13']!, guild, tree).categoryName).toBeNull();
  });

  it("resolves a thread's parent channel name and the parent's category", () => {
    const target = makeGuildExportTarget(tree.byId['20']!, guild, tree);
    expect(target).toMatchObject({ kind: 'thread', channelName: 'How do I?', parentChannelName: 'help-forum', categoryName: 'Text Channels' });
  });

  it('handles threads of uncategorized parents and threads with unknown parents', () => {
    expect(makeGuildExportTarget(tree.byId['21']!, guild, tree)).toMatchObject({ parentChannelName: 'loose-forum', categoryName: null });
    expect(makeGuildExportTarget(tree.byId['22']!, guild, tree)).toMatchObject({ parentChannelName: null, categoryName: null });
  });

  it('builds a DM target without guild information', () => {
    const [dm] = buildDmNodes([{ id: '77', type: 1, recipients: [{ id: '5', username: 'dave', global_name: 'Dave' }] }]);
    expect(makeDmExportTarget(dm!)).toEqual({
      channelId: '77',
      kind: 'dm',
      channelName: 'Dave',
      guildId: null,
      guildName: null,
      categoryName: null,
      parentChannelName: null,
      topic: null,
      iconUrl: dm!.iconUrl,
    });
  });

  it('builds a group DM target', () => {
    const [dm] = buildDmNodes([{ id: '78', type: 3, name: 'Gang', recipients: [] }]);
    expect(makeDmExportTarget(dm!)).toMatchObject({ kind: 'group-dm', channelName: 'Gang', guildId: null });
  });

  const node = (kind: ChannelKind, canView: boolean | null): ChannelNode => ({
    id: '1',
    guildId: GUILD_ID,
    kind,
    name: 'n',
    parentId: null,
    position: 0,
    topic: null,
    nsfw: false,
    canView,
  });

  it('exports readable kinds the user can (or maybe can) see', () => {
    for (const kind of ['text', 'announcement', 'voice', 'stage', 'thread', 'dm', 'group-dm'] as const) {
      expect(isExportable(node(kind, true))).toBe(true);
      expect(isExportable(node(kind, null))).toBe(true);
      expect(isExportable(node(kind, false))).toBe(false);
    }
  });

  it('never exports containers or unsupported kinds', () => {
    for (const kind of ['forum', 'media', 'category', 'other'] as const) {
      expect(isExportable(node(kind, true))).toBe(false);
      expect(isExportable(node(kind, null))).toBe(false);
    }
  });
});
