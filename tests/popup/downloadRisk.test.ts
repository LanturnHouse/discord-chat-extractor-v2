import { describe, expect, it } from 'vitest';
import {
  RISK_MAX_CHATS,
  RISK_MAX_CHATS_WITH_THREADS,
  RISK_MAX_MESSAGES,
  assessDownloadRisk,
  type DownloadRisk,
} from '@/popup/downloadRisk';
import { DEFAULT_EXPORT_SETTINGS, type ChatKind, type ExportSettings, type GroupInfo, type GroupMap, type GroupSettingsMap, type QueueItem } from '@/shared';

/*
 * assessDownloadRisk: which starts ask the person first (Discord can limit an account that makes a lot of automated requests).
 * The judgement is on the EFFECTIVE settings of each chat (item > category > server > common), like the background's job start.
 */

const GUILD = '2000000000000000001';
const OTHER_GUILD = '2000000000000000002';
const CATEGORY = '4000000000000000001';

const settingsWith = (patch: Partial<ExportSettings> = {}): ExportSettings => ({ ...DEFAULT_EXPORT_SETTINGS, content: { ...DEFAULT_EXPORT_SETTINGS.content }, ...patch });
const COMMON = settingsWith({ count: 200 });

interface ChatOptions {
  kind?: ChatKind;
  guildId?: string | null;
  settings?: ExportSettings | null;
}

let counter = 0;
function chat(options: ChatOptions = {}): QueueItem {
  const kind = options.kind ?? 'guild-channel';
  const guildId = options.guildId === undefined ? (kind === 'dm' || kind === 'group-dm' ? null : GUILD) : options.guildId;
  const channelId = `3${String(++counter).padStart(17, '0')}`;
  return {
    key: channelId,
    target: { kind, channelId, guildId, guildName: guildId === null ? null : 'Sample Server', channelName: `chat-${counter}`, parentId: null, parentName: null },
    settings: options.settings ?? null,
    addedAt: counter,
  };
}
const chats = (count: number, options: ChatOptions = {}): QueueItem[] => Array.from({ length: count }, () => chat(options));

const NO_GROUP_SETTINGS: GroupSettingsMap = {};
const NO_GROUPS: GroupMap = {};
const assess = (items: readonly QueueItem[], common: ExportSettings = COMMON, groupSettings: GroupSettingsMap = NO_GROUP_SETTINGS, groups: GroupMap = NO_GROUPS): DownloadRisk =>
  assessDownloadRisk(items, common, groupSettings, groups);

describe('the thresholds are named constants', () => {
  it('10 chats, 20,000 messages, 3 chats with threads', () => {
    expect(RISK_MAX_CHATS).toBe(10);
    expect(RISK_MAX_MESSAGES).toBe(20_000);
    expect(RISK_MAX_CHATS_WITH_THREADS).toBe(3);
  });
});

describe('an ordinary download is not risky', () => {
  it('nothing to start: not risky, no estimate', () => {
    expect(assess([])).toEqual({ risky: false, reasons: [], chats: 0, messageEstimate: null });
  });

  it('one chat with the common settings (200 messages)', () => {
    expect(assess(chats(1))).toEqual({ risky: false, reasons: [], chats: 1, messageEstimate: 200 });
  });

  it('a few chats with their own settings, all bounded', () => {
    const items = [chat({ settings: settingsWith({ count: 5_000 }) }), chat({ settings: settingsWith({ count: null, from: '2026-01-01T00:00:00.000Z' }) }), chat()];
    expect(assess(items)).toMatchObject({ risky: false, reasons: [], chats: 3 });
  });
});

describe('many-chats: more than 10 chats', () => {
  it('10 chats are fine, 11 are not (boundary)', () => {
    expect(assess(chats(10))).toMatchObject({ risky: false, reasons: [], chats: 10 });
    expect(assess(chats(11))).toEqual({ risky: true, reasons: ['many-chats'], chats: 11, messageEstimate: 2_200 });
  });

  it('counts DMs, threads and forums as chats too', () => {
    const items = [...chats(4, { kind: 'dm' }), ...chats(3, { kind: 'group-dm' }), ...chats(2, { kind: 'thread' }), ...chats(2, { kind: 'forum' })];
    expect(items).toHaveLength(11);
    expect(assess(items).reasons).toEqual(['many-chats']);
  });

  it('11 DMs on their own are many chats and nothing else', () => {
    expect(assess(chats(11, { kind: 'dm' }))).toMatchObject({ risky: true, reasons: ['many-chats'], chats: 11 });
  });
});

describe('unbounded: a chat with every message and no start date', () => {
  const everything = settingsWith({ count: null, from: null });

  it('one chat with count null and no from date, alone', () => {
    expect(assess(chats(1, { settings: everything }))).toEqual({ risky: true, reasons: ['unbounded'], chats: 1, messageEstimate: null });
  });

  it('a start date bounds it, an end date alone does not', () => {
    expect(assess([chat({ settings: settingsWith({ count: null, from: '2026-01-01T00:00:00.000Z' }) })]).risky).toBe(false);
    expect(assess([chat({ settings: settingsWith({ count: null, from: null, to: '2026-03-31T14:59:59.999Z' }) })]).reasons).toEqual(['unbounded']);
  });

  it('a count bounds it, with or without a start date', () => {
    expect(assess([chat({ settings: settingsWith({ count: 1, from: null }) })]).risky).toBe(false);
    expect(assess([chat({ settings: settingsWith({ count: 1_000_000, from: null }) })]).risky).toBe(false); // one chat: the size alone is not a bulk download
  });

  it('one such chat among bounded ones is enough', () => {
    const items = [...chats(3), chat({ settings: everything }), ...chats(2)];
    expect(assess(items)).toMatchObject({ risky: true, reasons: ['unbounded'], chats: 6 });
  });

  it('a DM can be unbounded too', () => {
    expect(assess([chat({ kind: 'dm', settings: everything })]).reasons).toEqual(['unbounded']);
  });

  it('the common settings count when the chat follows them', () => {
    expect(assess(chats(2), everything)).toMatchObject({ risky: true, reasons: ['unbounded'], chats: 2, messageEstimate: null });
  });
});

describe('many-messages: the requested counts add up to more than 20,000', () => {
  it('20,000 is fine, 20,001 is not (boundary)', () => {
    const at = [chat({ settings: settingsWith({ count: 10_000 }) }), chat({ settings: settingsWith({ count: 10_000 }) })];
    expect(assess(at)).toEqual({ risky: false, reasons: [], chats: 2, messageEstimate: 20_000 });
    const over = [chat({ settings: settingsWith({ count: 10_000 }) }), chat({ settings: settingsWith({ count: 10_001 }) })];
    expect(assess(over)).toEqual({ risky: true, reasons: ['many-messages'], chats: 2, messageEstimate: 20_001 });
  });

  it('adds up the counts of every chat, the ones that follow the common settings included', () => {
    const items = [...chats(3), chat({ settings: settingsWith({ count: 19_500 }) })];
    expect(assess(items)).toMatchObject({ risky: true, reasons: ['many-messages'], messageEstimate: 20_100 });
  });

  it('a chat without a count adds nothing: it is the "unbounded" rule, or has a start date', () => {
    const items = [chat({ settings: settingsWith({ count: 20_000 }) }), chat({ settings: settingsWith({ count: null, from: '2026-01-01T00:00:00.000Z' }) })];
    expect(assess(items)).toEqual({ risky: false, reasons: [], chats: 2, messageEstimate: 20_000 });
    expect(assess([chat({ settings: settingsWith({ count: null, from: '2026-01-01T00:00:00.000Z' }) }), ...chats(1, { settings: settingsWith({ count: null, from: '2026-02-01T00:00:00.000Z' }) })]).messageEstimate).toBeNull();
  });

  it('a single chat is never "many messages", however big its count is', () => {
    expect(assess(chats(1, { settings: settingsWith({ count: 1_000_000 }) }))).toEqual({ risky: false, reasons: [], chats: 1, messageEstimate: 1_000_000 });
  });

  it('the estimate is null when no chat has a count', () => {
    expect(assess(chats(2, { settings: settingsWith({ count: null, from: '2026-01-01T00:00:00.000Z' }) })).messageEstimate).toBeNull();
    expect(assess([]).messageEstimate).toBeNull();
  });
});

describe('threads: a chat includes its threads while more than 3 chats are started', () => {
  const withThreads = settingsWith({ includeThreads: true });

  it('3 chats are fine, 4 are not (boundary)', () => {
    expect(assess(chats(3, { settings: withThreads }))).toMatchObject({ risky: false, reasons: [] });
    expect(assess(chats(4, { settings: withThreads }))).toMatchObject({ risky: true, reasons: ['threads'], chats: 4 });
  });

  it('one chat with threads among four is enough', () => {
    expect(assess([...chats(3), chat({ settings: withThreads })]).reasons).toEqual(['threads']);
    expect(assess(chats(4)).reasons).toEqual([]);
  });

  it('one chat with threads and nothing else is fine', () => {
    expect(assess(chats(1, { settings: withThreads })).risky).toBe(false);
  });

  it('follows the common settings too', () => {
    expect(assess(chats(4), settingsWith({ count: 200, includeThreads: true })).reasons).toEqual(['threads']);
  });

  it('only a text channel looks for threads: DMs, threads and forums with the switch on do not count', () => {
    const on = { settings: withThreads };
    expect(assess(chats(4, { kind: 'dm', ...on })).reasons).toEqual([]);
    expect(assess(chats(4, { kind: 'group-dm', ...on })).reasons).toEqual([]);
    expect(assess(chats(4, { kind: 'thread', ...on })).reasons).toEqual([]);
    expect(assess(chats(4, { kind: 'forum', ...on })).reasons).toEqual([]);
    // ...but a text channel among them does
    expect(assess([...chats(3, { kind: 'dm', ...on }), chat(on)]).reasons).toEqual(['threads']);
  });
});

describe('all of the reasons together, always in the same order', () => {
  it('many-chats, unbounded, many-messages, threads', () => {
    const items = [
      ...chats(9),
      chat({ settings: settingsWith({ count: null, from: null }) }),
      chat({ settings: settingsWith({ count: 25_000, includeThreads: true }) }),
      chat(),
    ];
    expect(assess(items)).toEqual({ risky: true, reasons: ['many-chats', 'unbounded', 'many-messages', 'threads'], chats: 12, messageEstimate: 9 * 200 + 25_000 + 200 });
  });
});

describe('the effective settings decide: item > category > server > common', () => {
  const groups: Record<string, GroupInfo> = {
    [CATEGORY]: { kind: 'category', guildId: GUILD, channelIds: [], updatedAt: 1, name: 'Study' },
  };
  const inCategory = (settings: ExportSettings | null = null): QueueItem => {
    const item = chat({ settings });
    groups[CATEGORY] = { ...groups[CATEGORY], channelIds: [...groups[CATEGORY].channelIds, item.key] };
    return item;
  };

  it('the settings of a server apply to the chats that follow them', () => {
    const groupSettings: GroupSettingsMap = { [GUILD]: settingsWith({ count: 9_000 }) };
    const items = chats(3); // common says 200 each; the server says 9,000
    expect(assess(items, COMMON, groupSettings, NO_GROUPS)).toEqual({ risky: true, reasons: ['many-messages'], chats: 3, messageEstimate: 27_000 });
    expect(assess(items, COMMON, NO_GROUP_SETTINGS, NO_GROUPS).risky).toBe(false);
  });

  it('the settings of another server do not apply', () => {
    expect(assess(chats(3), COMMON, { [OTHER_GUILD]: settingsWith({ count: 9_000 }) }, NO_GROUPS).risky).toBe(false);
  });

  it('a category beats its server', () => {
    const a = inCategory();
    const b = inCategory();
    const c = chat(); // follows the server
    const groupSettings: GroupSettingsMap = { [GUILD]: settingsWith({ count: 100 }), [CATEGORY]: settingsWith({ count: 15_000 }) };
    expect(assess([a, b, c], COMMON, groupSettings, groups)).toMatchObject({ risky: true, reasons: ['many-messages'], messageEstimate: 15_000 + 15_000 + 100 });
    // without the category's settings the same chats are small
    expect(assess([a, b, c], COMMON, { [GUILD]: settingsWith({ count: 100 }) }, groups)).toMatchObject({ risky: false, messageEstimate: 300 });
  });

  it('the settings of a chat beat both: a bounded chat in an unbounded category is fine, a chat that reads everything in a bounded one is not', () => {
    const own = inCategory(settingsWith({ count: 50 }));
    const followsCategory = inCategory();
    const groupSettings: GroupSettingsMap = { [CATEGORY]: settingsWith({ count: null, from: null }) };
    expect(assess([own], COMMON, groupSettings, groups).risky).toBe(false);
    expect(assess([followsCategory], COMMON, groupSettings, groups).reasons).toEqual(['unbounded']);
    expect(assess([own, followsCategory], COMMON, groupSettings, groups).reasons).toEqual(['unbounded']);

    const everything = inCategory(settingsWith({ count: null, from: null }));
    expect(assess([everything], COMMON, { [CATEGORY]: settingsWith({ count: 10 }) }, groups).reasons).toEqual(['unbounded']);
  });

  it('mixes all four sources in one start: threads from the server, a large count from a chat, "everything" from the common settings of a DM', () => {
    const fromServer = chats(3); // the server switches threads on
    const own = chat({ settings: settingsWith({ count: 30_000 }) }); // a server chat with its own settings: no threads
    const dm = chat({ kind: 'dm' }); // follows the common settings, which read everything
    const groupSettings: GroupSettingsMap = { [GUILD]: settingsWith({ count: 100, includeThreads: true }) };
    const common = settingsWith({ count: null, from: null });
    expect(assess([...fromServer, own, dm], common, groupSettings, NO_GROUPS)).toEqual({
      risky: true,
      reasons: ['unbounded', 'many-messages', 'threads'],
      chats: 5,
      messageEstimate: 3 * 100 + 30_000,
    });
  });

  it('a DM never follows the settings of a server', () => {
    const dms = chats(4, { kind: 'dm' });
    expect(assess(dms, COMMON, { [GUILD]: settingsWith({ count: null, from: null, includeThreads: true }) }, NO_GROUPS).risky).toBe(false);
  });

  it('does not change what it is given', () => {
    const items = chats(12, { settings: settingsWith({ count: 5_000 }) });
    const common = settingsWith({ count: 200 });
    const before = JSON.stringify([items, common]);
    assess(items, common);
    expect(JSON.stringify([items, common])).toBe(before);
  });
});
