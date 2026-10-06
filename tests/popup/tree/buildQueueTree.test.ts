import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_SETTINGS, type ChatTarget, type ExportSettings, type GroupInfo, type HistoryEntry, type ItemProgress, type QueueItem } from '@/shared';
import {
  MAX_SUBTITLE_NAMES,
  buildQueueTree,
  channelNameOf,
  describeGroup,
  finishedChatsOf,
  type BuildQueueTreeInput,
  type ChannelRowModel,
  type GroupNodeModel,
  type TreeRowModel,
} from '@/popup/tree/buildQueueTree';

// Neutral fixtures: server "Alpha" (g1) with the categories "Study" (c1) and "Lounge" (c2); a second server "Beta" (g2).
const G1 = 'g1';
const G2 = 'g2';
const C1 = 'c1';
const C2 = 'c2';
const ICON = 'https://cdn.discordapp.com/icons/g1/hash.png?size=64';

const common: ExportSettings = { ...DEFAULT_EXPORT_SETTINGS, count: 200 };
const with5: ExportSettings = { ...DEFAULT_EXPORT_SETTINGS, count: 5 };
const with7: ExportSettings = { ...DEFAULT_EXPORT_SETTINGS, count: 7 };
const with9: ExportSettings = { ...DEFAULT_EXPORT_SETTINGS, count: 9 };

let clock = 0;
/** A chat of "Alpha" by default; `addedAt` counts up in creation order unless given. */
function chat(key: string, over: Partial<ChatTarget> = {}, extra: Partial<QueueItem> = {}): QueueItem {
  clock += 1;
  return {
    key,
    target: { kind: 'guild-channel', channelId: key, guildId: G1, guildName: 'Alpha', channelName: `ch-${key}`, parentId: null, parentName: null, ...over },
    settings: null,
    addedAt: clock * 1000,
    ...extra,
  };
}
const dm = (key: string, name: string, extra: Partial<QueueItem> = {}): QueueItem => chat(key, { kind: 'dm', guildId: null, guildName: null, channelName: name }, extra);
const inCategory = (key: string, category: string, categoryName: string, extra: Partial<QueueItem> = {}): QueueItem =>
  chat(key, { parentId: category, parentName: categoryName }, extra);

const group = (kind: GroupInfo['kind'], guildId: string, channelIds: string[], extra: Partial<GroupInfo> = {}): GroupInfo => ({ kind, guildId, channelIds, updatedAt: 1, ...extra });

function tree(items: QueueItem[], over: Partial<BuildQueueTreeInput> = {}) {
  return buildQueueTree({ items, groups: {}, groupSettings: {}, common, expanded: [], ...over });
}

const asGroup = (row: TreeRowModel | undefined): GroupNodeModel => {
  if (row?.type !== 'group') throw new Error(`expected a group, got ${row?.type}`);
  return row;
};
const asChannel = (row: TreeRowModel | undefined): ChannelRowModel => {
  if (row === undefined || row.type === 'group') throw new Error(`expected a chat, got ${row?.type}`);
  return row;
};
/** A readable outline: "guild:g1(3) > [category:c1(2) > #a, #b], #c" */
function outline(rows: readonly TreeRowModel[]): string[] {
  return rows.flatMap((row) => {
    if (row.type === 'group') return [`${row.kind}:${row.id}(${row.count})`, ...outline(row.children).map((line) => `  ${line}`)];
    return [`${row.path.map((part) => `${part.kind}:${part.name} › `).join('')}${row.name}`];
  });
}

describe('buildQueueTree: the basic shapes', () => {
  it('an empty list is an empty tree', () => {
    expect(tree([])).toEqual({ rows: [], count: 0 });
  });

  it('DMs only: flat rows at the top, no group, no compression, ordered by addedAt', () => {
    const model = tree([dm('d2', 'Robin', { addedAt: 20 }), dm('d1', 'Alex', { addedAt: 10 }), chat('x', { kind: 'group-dm', guildId: null, channelName: 'Trio' }, { addedAt: 30 })]);
    expect(model.rows.map((row) => row.type)).toEqual(['dm', 'dm', 'dm']);
    expect(model.rows.map((row) => asChannel(row).name)).toEqual(['Alex', 'Robin', 'Trio']);
    for (const row of model.rows) {
      expect(asChannel(row)).toMatchObject({ depth: 0, path: [], source: 'common' });
      expect(asChannel(row).tooltip).toBe(asChannel(row).fullLabel);
    }
    expect(model.count).toBe(3);
  });

  it('a DM never joins a server, even when its target carries a guild id', () => {
    const odd = chat('d1', { kind: 'dm', guildId: G1, channelName: 'Odd' });
    expect(outline(tree([odd, chat('1')]).rows)).toEqual(['Odd', 'guild:Alpha › #ch-1']);
  });

  it('a chat without a server (guild id missing) is a flat row at the top', () => {
    const model = tree([chat('1', { guildId: null, guildName: null })]);
    expect(asChannel(model.rows[0])).toMatchObject({ type: 'channel', depth: 0, path: [], name: '#ch-1', fullLabel: '#ch-1' });
  });

  it('a single channel of a server is compressed to "서버 › #채널"', () => {
    const only = chat('1', {}, { addedAt: 5 });
    const row = asChannel(tree([only]).rows[0]);
    expect(row).toMatchObject({ type: 'channel', depth: 0, name: '#ch-1', fullLabel: 'Alpha > #ch-1', tooltip: 'Alpha › #ch-1' });
    expect(row.path).toEqual([{ kind: 'guild', name: 'Alpha', iconUrl: null }]);
  });

  it('the compressed server shows its recorded icon, and the full path (with the category) in the tooltip', () => {
    const groups = {
      [G1]: group('guild', G1, ['1', '2'], { name: 'Alpha Recorded', iconUrl: ICON }),
      [C1]: group('category', G1, ['1', '2'], { name: 'Study' }),
    };
    // channel 1 is the only queued channel of the server (so the server is not "whole"): it is compressed, the category is left out
    const row = asChannel(tree([inCategory('1', C1, 'ignored')], { groups }).rows[0]);
    expect(row.path).toEqual([{ kind: 'guild', name: 'Alpha Recorded', iconUrl: ICON }]);
    expect(row.tooltip).toBe('Alpha Recorded › Study › #ch-1');
    expect(row.depth).toBe(0);
  });

  it('a server with several chats is a group line; its chats are below it at depth 1', () => {
    const model = tree([chat('1'), chat('2')]);
    const server = asGroup(model.rows[0]);
    expect(server).toMatchObject({ kind: 'guild', id: G1, guildId: G1, depth: 0, name: 'Alpha', count: 2, keys: ['1', '2'], complete: false, expanded: false });
    expect(server.children.map((row) => [asChannel(row).name, asChannel(row).depth])).toEqual([['#ch-1', 1], ['#ch-2', 1]]);
    expect(model.rows).toHaveLength(1);
  });

  it('two servers are two top-level nodes, ordered by their earliest chat', () => {
    const items = [chat('a1', { guildId: G2, guildName: 'Beta' }, { addedAt: 50 }), chat('b1', {}, { addedAt: 10 }), chat('a2', { guildId: G2, guildName: 'Beta' }, { addedAt: 5 }), chat('b2', {}, { addedAt: 90 })];
    const model = tree(items);
    expect(model.rows.map((row) => asGroup(row).id)).toEqual([G2, G1]); // Beta's earliest chat (5) is before Alpha's (10)
  });
});

describe('buildQueueTree: "whole" servers and categories (isGroupComplete)', () => {
  it('a server with one queued channel that is also its only viewable channel is "complete": a group line, not compressed', () => {
    const groups = { [G1]: group('guild', G1, ['1']) };
    const server = asGroup(tree([chat('1')], { groups }).rows[0]);
    expect(server).toMatchObject({ kind: 'guild', count: 1, complete: true });
  });

  it('one queued channel of a server with more viewable channels: partial, so it is compressed', () => {
    const groups = { [G1]: group('guild', G1, ['1', '2']) };
    expect(asChannel(tree([chat('1')], { groups }).rows[0]).path).toHaveLength(1);
  });

  it('every viewable channel queued: "complete" with the right count (threads count as chats too)', () => {
    const groups = { [G1]: group('guild', G1, ['1', '2']) };
    const server = asGroup(tree([chat('1'), chat('2'), chat('t', { kind: 'thread', parentId: '1', parentName: 'ch-1', channelName: 'talk' })], { groups }).rows[0]);
    expect(server).toMatchObject({ complete: true, count: 3 });
  });

  it('a group info without any channel is never "complete"', () => {
    const groups = { [G1]: group('guild', G1, []) };
    expect(asChannel(tree([chat('1')], { groups }).rows[0]).path).toHaveLength(1); // compressed
  });

  it('a whole category is a group line of its own (not compressed), "complete" with its chats below it at depth 2', () => {
    const groups = {
      [G1]: group('guild', G1, ['1', '2', '3']),
      [C1]: group('category', G1, ['1', '2']),
    };
    const server = asGroup(tree([inCategory('1', C1, 'Study'), inCategory('2', C1, 'Study'), chat('3')], { groups }).rows[0]);
    expect(server.complete).toBe(true);
    const category = asGroup(server.children.find((row) => row.type === 'group'));
    expect(category).toMatchObject({ kind: 'category', id: C1, depth: 1, name: 'Study', count: 2, complete: true, keys: ['1', '2'] });
    expect(category.children.map((row) => asChannel(row).depth)).toEqual([2, 2]);
  });

  it('a whole category with ONE channel keeps its line ("전체 1개")', () => {
    const groups = { [G1]: group('guild', G1, ['1', '2']), [C1]: group('category', G1, ['1']) };
    const server = asGroup(tree([inCategory('1', C1, 'Study'), chat('2')], { groups }).rows[0]);
    const category = asGroup(server.children[0]);
    expect(category).toMatchObject({ id: C1, count: 1, complete: true });
  });
});

describe('buildQueueTree: categories inside a server', () => {
  const groups = {
    [G1]: group('guild', G1, ['0', '1', '2', '3', '4', '5'], { name: 'Alpha', iconUrl: ICON }),
    [C1]: group('category', G1, ['1', '2', '3'], { name: 'Study' }),
    [C2]: group('category', G1, ['4', '5'], { name: 'Lounge' }),
  };

  it('several categories and an uncategorised channel, in sidebar order; one-queued categories are compressed to "카테고리 › #채널"', () => {
    const items = [
      inCategory('5', C2, 'x', { addedAt: 1 }), // alone in "Lounge" (partial): compressed
      inCategory('1', C1, 'x', { addedAt: 2 }),
      inCategory('2', C1, 'x', { addedAt: 3 }),
      chat('0', {}, { addedAt: 4 }), // no category
    ];
    const model = tree(items, { groups });
    expect(outline(model.rows)).toEqual([
      'guild:g1(4)',
      '  #ch-0',
      '  category:c1(2)',
      '    #ch-1',
      '    #ch-2',
      '  category:Lounge › #ch-5',
    ]);
    const server = asGroup(model.rows[0]);
    expect(server.name).toBe('Alpha');
    expect(server.iconUrl).toBe(ICON);
    const compressed = asChannel(server.children[2]);
    expect(compressed).toMatchObject({ depth: 1, tooltip: 'Alpha › Lounge › #ch-5' });
    expect(compressed.path).toEqual([{ kind: 'category', name: 'Lounge', iconUrl: null }]);
  });

  it('the group line of a category counts only what is queued', () => {
    const items = [inCategory('1', C1, 'x'), inCategory('2', C1, 'x')];
    const category = asGroup(asGroup(tree(items, { groups }).rows[0]).children[0]);
    expect(category).toMatchObject({ count: 2, complete: false }); // 3 viewable channels, 2 queued
  });

  it('a category without recorded info is told by the parent name of its chats, else by the fallback', () => {
    const named = asGroup(asGroup(tree([inCategory('1', 'cx', 'Notes'), inCategory('2', 'cx', 'Notes')]).rows[0]).children[0]);
    expect(named).toMatchObject({ id: 'cx', name: 'Notes' });
    const unnamed = asGroup(asGroup(tree([chat('1', { parentId: 'cx' }), chat('2', { parentId: 'cx' })], { fallbackNames: { category: '카테고리' } }).rows[0]).children[0]);
    expect(unnamed.name).toBe('카테고리');
  });

  it('a category with settings of its own, holding one chat, keeps its line (and the server of that single chat stays a group too)', () => {
    const items = [inCategory('1', C1, 'x')];
    const model = tree(items, { groups, groupSettings: { [C1]: with9 } });
    const server = asGroup(model.rows[0]); // not compressed: it would hide the only line that edits the category's settings
    const category = asGroup(server.children[0]);
    expect(category).toMatchObject({ id: C1, count: 1, hasOwnSettings: true, settingsSource: 'category' });
    expect(asChannel(category.children[0]).source).toBe('category');
  });

  it('a server with settings of its own keeps its line even with one chat', () => {
    const server = asGroup(tree([chat('1')], { groupSettings: { [G1]: with7 } }).rows[0]);
    expect(server).toMatchObject({ kind: 'guild', count: 1, hasOwnSettings: true, settingsSource: 'guild' });
  });

  it('a category compresses inside a server that stays a group', () => {
    const items = [chat('0'), inCategory('4', C2, 'x')];
    const server = asGroup(tree(items, { groups }).rows[0]);
    expect(outline([server])).toEqual(['guild:g1(2)', '  #ch-0', '  category:Lounge › #ch-4']);
  });
});

describe('buildQueueTree: threads and forums', () => {
  it('a forum sits in its category like any channel; a thread goes below the server (its parent id is a channel, not a category)', () => {
    const groups = { [G1]: group('guild', G1, ['f', 'g', 'h']), [C1]: group('category', G1, ['f', 'g']) };
    const forum = chat('f', { kind: 'forum', parentId: C1, parentName: 'Study', channelName: 'help' });
    const sibling = inCategory('g', C1, 'Study');
    const thread = chat('t', { kind: 'thread', parentId: 'g', parentName: 'ch-g', channelName: 'weekend' });
    const server = asGroup(tree([forum, sibling, thread], { groups }).rows[0]);
    expect(outline([server])).toEqual(['guild:g1(3)', '  category:c1(2)', '    #help', '    #ch-g', '  #ch-g > weekend']);
  });

  it('a thread without a recorded category and with a thread-style parent id is directly under the server', () => {
    const thread = chat('t', { kind: 'thread', parentId: 'p', parentName: 'general', channelName: 'idea' });
    const server = asGroup(tree([thread, chat('1')]).rows[0]);
    expect(server.children.map((row) => asChannel(row).depth)).toEqual([1, 1]);
  });

  it('a lone thread is compressed like any other chat: "서버 › #부모 > 스레드"', () => {
    const row = asChannel(tree([chat('t', { kind: 'thread', parentId: 'p', parentName: 'general', channelName: 'idea' })]).rows[0]);
    expect(row.path).toHaveLength(1);
    expect(row.name).toBe('#general > idea');
    expect(row.fullLabel).toBe('Alpha > #general > idea');
  });

  it('a thread whose parent name is unknown is named by itself', () => {
    expect(channelNameOf({ kind: 'thread', channelId: 't', guildId: G1, guildName: 'Alpha', channelName: 'idea', parentName: null })).toBe('idea');
    expect(channelNameOf({ kind: 'forum', channelId: 'f', guildId: G1, guildName: 'Alpha', channelName: 'help' })).toBe('#help');
    expect(channelNameOf({ kind: 'dm', channelId: 'd', guildId: null, guildName: null, channelName: 'Alex' })).toBe('Alex');
    expect(channelNameOf({ kind: 'guild-channel', channelId: 'c9', guildId: G1, guildName: 'Alpha', channelName: '  ' })).toBe('#c9');
  });
});

describe('buildQueueTree: unknown or stale group information', () => {
  it('without LOCAL.groups: names come from the chats, no icon, never "complete", ordered by addedAt', () => {
    const items = [chat('2', {}, { addedAt: 20 }), chat('1', {}, { addedAt: 10 })];
    const server = asGroup(tree(items).rows[0]);
    expect(server).toMatchObject({ name: 'Alpha', iconUrl: null, complete: false });
    expect(server.children.map((row) => asChannel(row).key)).toEqual(['1', '2']);
  });

  it('no name anywhere: the fallback names are used', () => {
    const items = [chat('1', { guildName: null }), chat('2', { guildName: ' ' })];
    expect(asGroup(tree(items, { fallbackNames: { guild: '서버' } }).rows[0]).name).toBe('서버');
    expect(asGroup(tree(items).rows[0]).name).toBe('Server'); // the built-in fallback when the caller passes none
  });

  it('the recorded name wins over the name the chat carried', () => {
    const groups = { [G1]: group('guild', G1, ['1', '2'], { name: 'Renamed' }) };
    expect(asGroup(tree([chat('1'), chat('2')], { groups }).rows[0]).name).toBe('Renamed');
  });

  it('a group info of the wrong kind under the id is ignored', () => {
    const groups = { [G1]: group('category', G1, ['1', '2'], { name: 'Not a server' }) };
    const server = asGroup(tree([chat('1'), chat('2')], { groups }).rows[0]);
    expect(server).toMatchObject({ name: 'Alpha', complete: false });
  });

  it('only an https://cdn.discordapp.com icon is ever offered', () => {
    const iconOf = (iconUrl: string | null) => asGroup(tree([chat('1'), chat('2')], { groups: { [G1]: group('guild', G1, ['1', '2', '3'], { iconUrl }) } }).rows[0]).iconUrl;
    expect(iconOf(ICON)).toBe(ICON);
    expect(iconOf(null)).toBeNull();
    expect(iconOf('http://cdn.discordapp.com/icons/1/a.png')).toBeNull();
    expect(iconOf('https://media.discordapp.net/icons/1/a.png')).toBeNull();
    expect(iconOf('https://evil.example/a.png')).toBeNull();
    expect(iconOf('https://cdn.discordapp.com@evil.example/a.png')).toBeNull();
    expect(iconOf('data:image/png;base64,AAAA')).toBeNull();
    expect(iconOf('javascript:alert(1)')).toBeNull();
    expect(iconOf('not a url')).toBeNull();
  });
});

describe('buildQueueTree: ordering', () => {
  it('the top level is ordered by the earliest addedAt inside each node, whatever the stored order', () => {
    const items = [
      chat('1', {}, { addedAt: 300 }),
      chat('2', {}, { addedAt: 310 }),
      dm('d', 'Alex', { addedAt: 200 }),
      chat('b1', { guildId: G2, guildName: 'Beta' }, { addedAt: 100 }),
    ];
    expect(tree(items).rows.map((row) => (row.type === 'group' ? row.id : row.type === 'channel' ? `${row.path[0]?.name}` : row.name))).toEqual(['Beta', 'Alex', G1]);
  });

  it('under a server the sidebar order wins over addedAt (categories by their first channel), threads and unknowns come last by addedAt', () => {
    const groups = {
      [G1]: group('guild', G1, ['0', '1', '2', '4', '5']),
      [C1]: group('category', G1, ['1', '2']),
      [C2]: group('category', G1, ['4', '5']),
    };
    const items = [
      inCategory('5', C2, 'Lounge', { addedAt: 1 }),
      chat('t', { kind: 'thread', channelName: 'late', parentId: '1' }, { addedAt: 2 }), // not in any list
      inCategory('2', C1, 'Study', { addedAt: 3 }),
      chat('0', {}, { addedAt: 4 }),
      inCategory('4', C2, 'Lounge', { addedAt: 5 }),
      inCategory('1', C1, 'Study', { addedAt: 6 }),
      chat('9', {}, { addedAt: 0 }), // viewable? unknown to the groups: after everything that has a position
    ];
    const server = asGroup(tree(items, { groups }).rows[0]);
    expect(outline([server])).toEqual([
      'guild:g1(7)',
      '  #ch-0',
      '  category:c1(2)',
      '    #ch-1',
      '    #ch-2',
      '  category:c2(2)',
      '    #ch-4',
      '    #ch-5',
      '  #ch-9', // no position: after the known ones, by addedAt (0 < 2)
      '  late', // a thread without a known parent name: its own name
    ]);
  });

  it('equal times keep the stored order (no dependence on the sort algorithm)', () => {
    const items = ['a', 'b', 'c', 'd'].map((key) => chat(key, {}, { addedAt: 7 }));
    expect(asGroup(tree(items).rows[0]).keys).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a server whose info lists only some of its chats still sorts the rest after them', () => {
    const groups = { [G1]: group('guild', G1, ['2', '9']) };
    const items = [chat('1', {}, { addedAt: 1 }), chat('2', {}, { addedAt: 2 })];
    expect(asGroup(tree(items, { groups }).rows[0]).keys).toEqual(['2', '1']);
  });
});

describe('buildQueueTree: expanded / collapsed and the subtitle of a collapsed server', () => {
  const items = ['1', '2', '3', '4', '5'].map((key) => chat(key));

  it('everything is collapsed unless its id is in `expanded` (array or set)', () => {
    expect(asGroup(tree(items).rows[0]).expanded).toBe(false);
    expect(asGroup(tree(items, { expanded: [G1] }).rows[0]).expanded).toBe(true);
    expect(asGroup(tree(items, { expanded: new Set([G1]) }).rows[0]).expanded).toBe(true);
    expect(asGroup(tree(items, { expanded: ['other'] }).rows[0]).expanded).toBe(false);
  });

  it('a collapsed server lists the first channel names with an ellipsis flag when there are more', () => {
    const subtitle = asGroup(tree(items).rows[0]).subtitle;
    expect(MAX_SUBTITLE_NAMES).toBe(3);
    expect(subtitle).toEqual({ names: ['#ch-1', '#ch-2', '#ch-3'], more: true });
    expect(asGroup(tree(items.slice(0, 3)).rows[0]).subtitle).toEqual({ names: ['#ch-1', '#ch-2', '#ch-3'], more: false });
    expect(asGroup(tree(items.slice(0, 2)).rows[0]).subtitle).toEqual({ names: ['#ch-1', '#ch-2'], more: false });
  });

  it('an open server has no subtitle, and a category never has one', () => {
    expect(asGroup(tree(items, { expanded: [G1] }).rows[0]).subtitle).toBeNull();
    const groups = { [C1]: group('category', G1, ['1', '2', '3']) };
    const category = asGroup(asGroup(tree(['1', '2'].map((key) => inCategory(key, C1, 'Study')), { groups }).rows[0]).children[0]);
    expect(category.subtitle).toBeNull();
  });

  it('the subtitle follows the order the channels are shown in (below categories too)', () => {
    const groups = { [G1]: group('guild', G1, ['1', '2', '3']), [C1]: group('category', G1, ['2', '3']) };
    const list = [inCategory('3', C1, 'Study'), chat('1'), inCategory('2', C1, 'Study')];
    expect(asGroup(tree(list, { groups }).rows[0]).subtitle?.names).toEqual(['#ch-1', '#ch-2', '#ch-3']);
  });

  it('the children are built whether or not the group is open (the UI decides what to draw)', () => {
    expect(asGroup(tree(items).rows[0]).children).toHaveLength(5);
  });
});

describe('buildQueueTree: settings badges, sources and overrides', () => {
  const groups = {
    [G1]: group('guild', G1, ['1', '2', '3', '4']),
    [C1]: group('category', G1, ['1', '2']),
  };

  it('a chat reports where its settings come from: item > category > server > common', () => {
    const items = [inCategory('1', C1, 'S', { settings: with5 }), inCategory('2', C1, 'S'), chat('3'), chat('4', { guildId: G2, guildName: 'Beta' })];
    const model = tree(items, { groups, groupSettings: { [C1]: with9, [G1]: with7 }, expanded: [G1, C1] });
    const alpha = asGroup(model.rows.find((row) => row.type === 'group' && row.id === G1));
    const category = asGroup(alpha.children.find((row) => row.type === 'group'));
    expect(category.children.map((row) => asChannel(row).source)).toEqual(['item', 'category']);
    expect(asChannel(alpha.children.find((row) => row.type !== 'group')).source).toBe('guild');
    expect(asChannel(alpha.children.find((row) => row.type !== 'group')).settings.count).toBe(7);
    const beta = asChannel(model.rows.find((row) => row.type === 'channel'));
    expect(beta.source).toBe('common');
    expect(beta.settings.count).toBe(200);
  });

  it('the settings of a row are copies: changing them never touches the input', () => {
    const items = [chat('1'), chat('2')];
    const row = asChannel(asGroup(tree(items, { groupSettings: { [G1]: with7 } }).rows[0]).children[0]);
    row.settings.count = 1;
    row.settings.content.includeBots = false;
    expect(with7.count).toBe(7);
    expect(with7.content.includeBots).toBe(true);
  });

  it('group lines: own settings -> "서버 설정" / "카테고리 설정"; none -> what the chats really follow (the server\'s, else the common ones)', () => {
    const items = [inCategory('1', C1, 'S'), inCategory('2', C1, 'S'), chat('3')];
    const plain = asGroup(tree(items, { groups }).rows[0]);
    expect(plain.settingsSource).toBe('common');
    expect(asGroup(plain.children[0]).settingsSource).toBe('common');

    const serverOnly = asGroup(tree(items, { groups, groupSettings: { [G1]: with7 } }).rows[0]);
    expect(serverOnly).toMatchObject({ settingsSource: 'guild', hasOwnSettings: true });
    expect(asGroup(serverOnly.children.find((row) => row.type === 'group'))).toMatchObject({ settingsSource: 'guild', hasOwnSettings: false });

    const both = asGroup(tree(items, { groups, groupSettings: { [G1]: with7, [C1]: with9 } }).rows[0]);
    expect(asGroup(both.children.find((row) => row.type === 'group'))).toMatchObject({ settingsSource: 'category', hasOwnSettings: true });

    const categoryOnly = asGroup(tree(items, { groups, groupSettings: { [C1]: with9 } }).rows[0]);
    expect(categoryOnly).toMatchObject({ settingsSource: 'common', hasOwnSettings: false });
  });

  it('"개별 N": the chats below a line that have settings of their own', () => {
    const items = [inCategory('1', C1, 'S', { settings: with5 }), inCategory('2', C1, 'S'), chat('3', {}, { settings: with9 }), chat('4')];
    const server = asGroup(tree(items, { groups }).rows[0]);
    expect(server.overrideCount).toBe(2);
    expect(asGroup(server.children.find((row) => row.type === 'group')).overrideCount).toBe(1);
    expect(asGroup(tree([chat('1'), chat('2')]).rows[0]).overrideCount).toBe(0);
  });

  it('a one-line row still says where its chat\'s settings come from', () => {
    const row = asChannel(tree([inCategory('1', C1, 'S', { settings: with5 })], { groups }).rows[0]);
    expect(row).toMatchObject({ source: 'item', depth: 0 });
    expect(row.path).toHaveLength(1);
  });
});

describe('buildQueueTree: progress of the running job', () => {
  const progress = (key: string, patch: Partial<ItemProgress> = {}): ItemProgress => ({ key, label: key, status: 'waiting', phase: null, fetched: 0, expected: 100, error: null, files: [], ...patch });
  const items = [chat('1'), chat('2'), chat('3'), dm('d', 'Alex')];

  it('a running job: the group line aggregates the rows of its chats (finished/total, each running one with its own fraction)', () => {
    const job = {
      state: 'running' as const,
      items: [progress('1', { status: 'done' }), progress('2', { status: 'running', phase: 'messages', fetched: 50 }), progress('3'), progress('d', { status: 'running', fetched: 10 })],
    };
    const model = tree(items, { job });
    const server = asGroup(model.rows.find((row) => row.type === 'group'));
    expect(server.progress).toEqual({ finished: 1, total: 3, ratio: (1 + 0.5 + 0) / 3 });
    expect(asChannel(server.children[1]).progress).toBe(job.items[1]);
    expect(asChannel(model.rows.find((row) => row.type === 'dm')).progress?.key).toBe('d');
  });

  it('a group none of whose chats is in the job has no progress, and neither has any group without a job', () => {
    const job = { state: 'running' as const, items: [progress('d')] };
    expect(asGroup(tree(items, { job }).rows.find((row) => row.type === 'group')).progress).toBeNull();
    expect(asGroup(tree(items).rows.find((row) => row.type === 'group')).progress).toBeNull();
    expect(asGroup(tree(items, { job: null }).rows.find((row) => row.type === 'group')).progress).toBeNull();
  });

  it('a paused job still counts; an ended one shows no group progress but every chat keeps its own row (failure notes)', () => {
    const rows = [progress('1', { status: 'failed' }), progress('2', { status: 'done' })];
    const paused = asGroup(tree(items, { job: { state: 'paused', items: rows } }).rows.find((row) => row.type === 'group'));
    expect(paused.progress).toEqual({ finished: 2, total: 2, ratio: 1 });
    const ended = tree(items, { job: { state: 'done', items: rows } });
    const server = asGroup(ended.rows.find((row) => row.type === 'group'));
    expect(server.progress).toBeNull();
    expect(asChannel(server.children[0]).progress?.status).toBe('failed');
  });

  it('a one-line row carries its own progress', () => {
    const job = { state: 'running' as const, items: [progress('9', { status: 'running', fetched: 20 })] };
    expect(asChannel(tree([chat('9')], { job }).rows[0]).progress?.fetched).toBe(20);
  });
});

/*
 * The background takes a chat out of the list the moment it is done (store.ts recordItemResult) and writes it to the history in
 * the same step. The group lines must keep counting such a chat: "1 of 4 done" never becomes "0 of 3".
 */
describe('buildQueueTree: a running job whose finished chats have already left the list', () => {
  const progress = (key: string, patch: Partial<ItemProgress> = {}): ItemProgress => ({ key, label: key, status: 'waiting', phase: null, fetched: 0, expected: 100, error: null, files: [], ...patch });
  const START = 10_000;
  /** The history entry the background writes for a chat that is done. */
  const doneEntry = (item: QueueItem, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
    id: `h-${item.key}`,
    accountId: 'a',
    target: item.target,
    settings: common,
    finishedAt: START + 5_000,
    status: 'done',
    messageCount: 1,
    files: [],
    error: null,
    ...over,
  });
  const running = (...items: ItemProgress[]) => ({ state: 'running' as const, startedAt: START, items });
  const outOfTheList = [chat('1'), chat('2'), chat('3'), chat('4')];
  const [first, ...rest] = outOfTheList;

  it('a server of 4 chats, one done and gone: 1 of 4 (25 %), not 0 of 3', () => {
    const job = running(progress('1', { status: 'done' }), progress('2'), progress('3'), progress('4'));
    const server = asGroup(tree(rest, { job, history: [doneEntry(first)] }).rows[0]);
    expect(server.count).toBe(3);
    expect(server.progress).toEqual({ finished: 1, total: 4, ratio: 0.25 });
  });

  it('every completion keeps the total: 2 of 4 after the second chat is done and gone, with the running one counting by its fraction', () => {
    const job = running(progress('1', { status: 'done' }), progress('2', { status: 'done' }), progress('3', { status: 'running', phase: 'messages', fetched: 50 }), progress('4'));
    const server = asGroup(tree(rest.slice(1), { job, history: [doneEntry(first), doneEntry(rest[0])] }).rows[0]);
    expect(server.progress).toEqual({ finished: 2, total: 4, ratio: (2 + 0.5) / 4 });
  });

  it('with ONE chat left the group keeps its line and its aggregate (it does not shrink to "서버 › #채널")', () => {
    const job = running(progress('1', { status: 'done' }), progress('2', { status: 'done' }), progress('3', { status: 'done' }), progress('4', { status: 'running', fetched: 10 }));
    const history = [doneEntry(first), doneEntry(rest[0]), doneEntry(rest[1])];
    const model = tree([rest[2]], { job, history });
    const server = asGroup(model.rows[0]);
    expect(server).toMatchObject({ kind: 'guild', count: 1, complete: false });
    expect(server.progress).toMatchObject({ finished: 3, total: 4 });
    expect(server.progress?.ratio).toBeCloseTo(0.775, 10);
    expect(server.children.map((row) => asChannel(row).depth)).toEqual([1]);
    // the job is over: nothing is running any more, the group is one line again
    const ended = tree([rest[2]], { job: { ...job, state: 'done' }, history });
    expect(asChannel(ended.rows[0]).path).toHaveLength(1);
  });

  it('a category counts its own finished chats only, a server counts all of them (below every category)', () => {
    const inStudy = [inCategory('1', C1, 'Study'), inCategory('2', C1, 'Study'), inCategory('3', C1, 'Study')];
    const inLounge = [inCategory('4', C2, 'Lounge'), inCategory('5', C2, 'Lounge')];
    const groups = { [G1]: group('guild', G1, ['1', '2', '3', '4', '5', '6']), [C1]: group('category', G1, ['1', '2', '3']), [C2]: group('category', G1, ['4', '5', '6']) };
    const job = running(progress('1', { status: 'done' }), progress('2'), progress('3'), progress('4', { status: 'done' }), progress('5'));
    const model = tree([inStudy[1], inStudy[2], inLounge[1]], { groups, job, history: [doneEntry(inStudy[0]), doneEntry(inLounge[0])] });
    const server = asGroup(model.rows[0]);
    const [study, lounge] = server.children.map(asGroup);
    expect(server.progress).toEqual({ finished: 2, total: 5, ratio: 2 / 5 });
    expect(study.progress).toEqual({ finished: 1, total: 3, ratio: 1 / 3 });
    expect(lounge.progress).toEqual({ finished: 1, total: 2, ratio: 1 / 2 });
  });

  it('a paused job counts them too', () => {
    const job = { state: 'paused' as const, startedAt: START, items: [progress('1', { status: 'done' }), progress('2'), progress('3'), progress('4')] };
    expect(asGroup(tree(rest, { job, history: [doneEntry(first)] }).rows[0]).progress).toEqual({ finished: 1, total: 4, ratio: 0.25 });
  });

  it('when the history entry comes before the job row says "done" (the two are written separately), the chat counts all the same', () => {
    const job = running(progress('1', { status: 'running', phase: 'saving', fetched: 100 }), progress('2'), progress('3'), progress('4'));
    const server = asGroup(tree(rest, { job, history: [doneEntry(first)] }).rows[0]);
    expect(server.progress?.total).toBe(4);
    expect(server.progress?.finished).toBe(0);
  });

  it('only what belongs to this job counts: older entries, partial / failed ones, chats the job has no row for, DMs', () => {
    const job = running(progress('1', { status: 'done' }), progress('2'), progress('3'), progress('4'));
    const stranger = chat('x');
    const history = [
      doneEntry(first, { finishedAt: START - 1 }), // finished before the job started
      doneEntry(rest[0], { status: 'partial' }), // would still be in the list
      doneEntry(stranger), // the job has no row for it
      doneEntry(dm('d', 'Alex')),
    ];
    expect(asGroup(tree(rest, { job, history }).rows[0]).progress).toEqual({ finished: 0, total: 3, ratio: 0 });
    expect(asGroup(tree(rest, { job, history: [...history, doneEntry(first)] }).rows[0]).progress).toEqual({ finished: 1, total: 4, ratio: 0.25 });
  });

  it('a chat counts once: two history entries of it, or a chat that was added to the list again, never double', () => {
    const job = running(progress('1', { status: 'done' }), progress('2'), progress('3'), progress('4'));
    const twice = tree(rest, { job, history: [doneEntry(first), doneEntry(first, { id: 'again' })] });
    expect(asGroup(twice.rows[0]).progress).toEqual({ finished: 1, total: 4, ratio: 0.25 });
    const back = tree([first, ...rest], { job, history: [doneEntry(first)] }); // in the list again: a member like any other
    expect(asGroup(back.rows[0]).progress).toEqual({ finished: 1, total: 4, ratio: 0.25 });
  });

  it('no job, an ended job, or no history: nothing changes (no progress; a lone chat is one line)', () => {
    const rows = [progress('1', { status: 'done' }), progress('2')];
    expect(asGroup(tree(rest, { history: [doneEntry(first)] }).rows[0]).progress).toBeNull();
    expect(asGroup(tree(rest, { job: { state: 'done', startedAt: START, items: rows }, history: [doneEntry(first)] }).rows[0]).progress).toBeNull();
    expect(asGroup(tree(rest, { job: running(...rows) }).rows[0]).progress).toEqual({ finished: 0, total: 1, ratio: 0 });
    expect(asChannel(tree([rest[0]], { job: running(...rows) }).rows[0]).path).toHaveLength(1);
  });

  it('a download started again from the history leaves the list alone: the group of a chat that is not in the job shows no progress and still compresses', () => {
    const job = running(progress('1', { status: 'done' }), progress('9'));
    const model = tree([rest[0]], { job, history: [doneEntry(first)] }); // "1" is only in the history, the chat of the list ("2") is not in the job
    expect(asChannel(model.rows[0]).path).toHaveLength(1);
    expect(asChannel(model.rows[0]).progress).toBeUndefined();
  });

  it('finishedChatsOf: the chats of the job that are in the history and not in the list, once each, with their targets', () => {
    const job = running(progress('1'), progress('2'), progress('3'));
    const found = finishedChatsOf([doneEntry(first, { finishedAt: START + 1 }), doneEntry(first), doneEntry(rest[0]), doneEntry(rest[1])], job, new Set(['3']));
    expect(found.map((item) => item.key)).toEqual(['1', '2']);
    expect(found[0]).toMatchObject({ target: first.target, settings: null, addedAt: START + 1 });
    expect(finishedChatsOf([doneEntry(first)], null, new Set())).toEqual([]);
    expect(finishedChatsOf([doneEntry(first)], { state: 'done', startedAt: START, items: job.items }, new Set())).toEqual([]);
  });
});

describe('buildQueueTree: chats that did not finish are counted on the group lines ("미완료 N")', () => {
  const progress = (key: string, patch: Partial<ItemProgress> = {}): ItemProgress => ({ key, label: key, status: 'waiting', phase: null, fetched: 0, expected: 100, error: null, files: [], ...patch });
  const result = (status: 'partial' | 'failed' | 'cancelled') => ({ lastResult: { status, message: 'x', at: 1 } });
  const groups = { [G1]: group('guild', G1, ['1', '2', '3', '4', '5']), [C1]: group('category', G1, ['2', '3']) };
  const items = [chat('1', {}, result('failed')), inCategory('2', C1, 'Study', result('partial')), inCategory('3', C1, 'Study'), chat('4', {}, result('cancelled')), chat('5')];

  it('a server counts failed, partial and cancelled chats at every depth, a category its own; a group without any says 0', () => {
    const server = asGroup(tree(items, { groups }).rows[0]);
    expect(server.failedCount).toBe(3);
    expect(asGroup(server.children.find((row) => row.type === 'group')).failedCount).toBe(1);
    expect(asGroup(tree([chat('1'), chat('2')]).rows[0]).failedCount).toBe(0);
    expect(asGroup(tree([chat('1', {}, { lastResult: null }), chat('2')]).rows[0]).failedCount).toBe(0);
  });

  it('collapsed or open, the count is the same (the chats below are not what is counted from)', () => {
    expect(asGroup(tree(items, { groups, expanded: [] }).rows[0]).failedCount).toBe(3);
    expect(asGroup(tree(items, { groups, expanded: [G1, C1] }).rows[0]).failedCount).toBe(3);
  });

  it('the job\'s row decides while a job is active: a chat that runs again is not "미완료", one that failed in this job is', () => {
    const rows = [progress('1', { status: 'running', fetched: 3 }), progress('5', { status: 'failed', error: { kind: 'network', message: 'offline' } })];
    const server = asGroup(tree(items, { groups, job: { state: 'running', items: rows } }).rows[0]);
    // 1: runs again (its old failure is not shown), 2 and 4: not in the job, their old result stays, 5: failed in this job
    expect(server.failedCount).toBe(3);
    const ended = asGroup(tree(items, { groups, job: { state: 'done', items: [progress('1', { status: 'done' }), progress('5', { status: 'cancelled' })] } }).rows[0]);
    expect(ended.failedCount).toBe(4); // 1, 2 and 4 with their notes (the job is over: the rows show them again), 5 with its row
  });

  it('a chat that is a one-line row shows its own failure, there is no group line to count it', () => {
    const row = asChannel(tree([chat('1', {}, result('failed'))]).rows[0]);
    expect(row.type).toBe('channel');
    expect(row.item.lastResult?.status).toBe('failed');
  });
});

describe('buildQueueTree: keys and counts', () => {
  it('a group lists the keys of its chats in the order they are shown, categories included', () => {
    const groups = { [G1]: group('guild', G1, ['0', '1', '2', '3']), [C1]: group('category', G1, ['2', '3']) };
    const items = [inCategory('3', C1, 'S'), chat('0'), inCategory('2', C1, 'S'), chat('1')];
    const server = asGroup(tree(items, { groups }).rows[0]);
    expect(server.keys).toEqual(['0', '1', '2', '3']);
    expect(asGroup(server.children.find((row) => row.type === 'group')).keys).toEqual(['2', '3']);
    expect(server.count).toBe(4);
  });

  it('the count of the tree is the number of chats, DMs included', () => {
    expect(tree([chat('1'), chat('2'), dm('d', 'Alex')]).count).toBe(3);
  });
});

describe('describeGroup (what the group settings screen shows)', () => {
  const groups = {
    [G1]: group('guild', G1, ['1', '2', '3'], { name: 'Alpha' }),
    [C1]: group('category', G1, ['1', '2'], { name: 'Study' }),
  };
  const items = [inCategory('1', C1, 'S', { settings: with5 }), inCategory('2', C1, 'S'), chat('3', {}, { settings: with9 }), chat('x', { guildId: G2, guildName: 'Beta' }), dm('d', 'Alex')];
  const input = { items, groups, groupSettings: {}, common };

  it('is null when nothing queued belongs to the group', () => {
    expect(describeGroup('guild', 'nope', input)).toBeNull();
    expect(describeGroup('category', 'nope', input)).toBeNull();
    expect(describeGroup('category', C2, input)).toBeNull();
  });

  it('a server: its queued chats, name, the common settings when it has none, and the overrides below', () => {
    const description = describeGroup('guild', G1, input)!;
    expect(description).toMatchObject({ kind: 'guild', id: G1, guildId: G1, name: 'Alpha', keys: ['1', '2', '3'], ownSettings: null });
    expect(description.effective).toEqual(common);
    expect(description.overrides).toEqual({ itemKeys: ['1', '3'], categoryIds: [] });
  });

  it('a category: its chats only; effective settings are its own, else the server\'s, else the common ones; the overrides below it', () => {
    expect(describeGroup('category', C1, input)).toMatchObject({ kind: 'category', id: C1, guildId: G1, name: 'Study', keys: ['1', '2'], overrides: { itemKeys: ['1'], categoryIds: [] } });
    expect(describeGroup('category', C1, input)!.effective.count).toBe(200);
    expect(describeGroup('category', C1, { ...input, groupSettings: { [G1]: with7 } })!.effective.count).toBe(7);
    const own = describeGroup('category', C1, { ...input, groupSettings: { [G1]: with7, [C1]: with9 } })!;
    expect(own.effective.count).toBe(9);
    expect(own.ownSettings?.count).toBe(9);
  });

  it('a server\'s overrides include the settings of its categories', () => {
    const description = describeGroup('guild', G1, { ...input, groupSettings: { [C1]: with9, [G1]: with7 } })!;
    expect(description.overrides).toEqual({ itemKeys: ['1', '3'], categoryIds: [C1] });
    expect(description.ownSettings?.count).toBe(7);
  });

  it('the settings it returns are copies', () => {
    const description = describeGroup('guild', G1, { ...input, groupSettings: { [G1]: with7 } })!;
    description.effective.count = 1;
    description.ownSettings!.count = 2;
    expect(with7.count).toBe(7);
  });

  it('names fall back like the tree does', () => {
    expect(describeGroup('guild', G1, { ...input, groups: {} })!.name).toBe('Alpha');
    expect(describeGroup('guild', G1, { ...input, groups: {}, items: [chat('1', { guildName: null }), chat('2', { guildName: null })], fallbackNames: { guild: '서버' } })!.name).toBe('서버');
    expect(describeGroup('category', 'cx', { ...input, groups: {}, items: [inCategory('1', 'cx', '')], fallbackNames: { category: '카테고리' } })!.name).toBe('카테고리');
  });
});
