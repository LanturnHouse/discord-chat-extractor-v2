import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, DEFAULT_EXPORT_SETTINGS, type JobState } from '@/shared';
import {
  asBgResponse,
  latestHealth,
  normalizeAccount,
  normalizeExpanded,
  normalizeExportSettings,
  normalizeGroupSettings,
  normalizeGroups,
  normalizeHealth,
  normalizeHistory,
  normalizeJob,
  normalizeQueue,
  normalizeSettings,
  normalizeStatus,
  normalizeTarget,
  normalizeTheme,
} from '@/ui/platform/normalize';

const target = { kind: 'guild-channel', channelId: '10', guildId: '20', guildName: 'Sample Server', channelName: 'general' };

describe('normalizeExportSettings: every field is checked on its own', () => {
  it('nothing, or garbage, gives the defaults (as a fresh object)', () => {
    for (const raw of [undefined, null, 5, 'x', [], {}]) {
      const result = normalizeExportSettings(raw);
      expect(result, String(raw)).toEqual(DEFAULT_EXPORT_SETTINGS);
      expect(result).not.toBe(DEFAULT_EXPORT_SETTINGS);
      expect(result.content).not.toBe(DEFAULT_EXPORT_SETTINGS.content);
    }
  });

  it('keeps valid values', () => {
    const own = {
      count: null,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-31T23:59:59.999Z',
      format: 'xlsx',
      htmlTheme: 'light',
      includeAttachments: true,
      includeThreads: true,
      incremental: true,
      content: { includeBots: false, includeSystem: false, includeReactions: false, includeEmbeds: false },
    };
    expect(normalizeExportSettings(own)).toEqual(own);
  });

  it('a bad field falls back alone, the good ones stay', () => {
    const result = normalizeExportSettings({ count: 1.5, format: 'pdf', htmlTheme: 'blue', from: 'yesterday', to: 5, includeAttachments: 'yes', content: { includeBots: 0, includeEmbeds: false }, incremental: true });
    expect(result).toEqual({ ...DEFAULT_EXPORT_SETTINGS, content: { ...DEFAULT_EXPORT_SETTINGS.content, includeEmbeds: false }, incremental: true });
  });

  it('count: null means "전체", a whole number from 1 to 1,000,000 is kept, anything else is the default', () => {
    expect(normalizeExportSettings({ count: null }).count).toBeNull();
    expect(normalizeExportSettings({ count: 1 }).count).toBe(1);
    expect(normalizeExportSettings({ count: 1_000_000 }).count).toBe(1_000_000);
    for (const count of [0, -3, 1_000_001, 2.5, '5', Number.NaN, Number.POSITIVE_INFINITY, undefined]) expect(normalizeExportSettings({ count }).count, String(count)).toBe(200);
  });

  it('a null date is "no bound", an invalid one is dropped to no bound, an absent one is the default', () => {
    expect(normalizeExportSettings({ from: null, to: null })).toMatchObject({ from: null, to: null });
    expect(normalizeExportSettings({ from: 'nope' }).from).toBeNull();
  });
});

describe('normalizeSettings', () => {
  it('nothing stored is the default app settings (consent not given)', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_APP_SETTINGS);
    expect(normalizeSettings(undefined).consentAt).toBeNull();
  });

  it('keeps valid values and replaces invalid ones one by one', () => {
    const result = normalizeSettings({
      common: { count: 5, format: 'csv' },
      showButtons: false,
      zipAll: 'maybe',
      folderName: 'My Backups',
      timeZone: ' ',
      language: 'fr',
      consentAt: 1_700_000_000_000,
      notifyOnComplete: false,
    });
    expect(result.common).toEqual({ ...DEFAULT_EXPORT_SETTINGS, count: 5, format: 'csv', content: { ...DEFAULT_EXPORT_SETTINGS.content } });
    expect(result).toMatchObject({ showButtons: false, zipAll: false, folderName: 'My Backups', timeZone: 'auto', language: 'auto', consentAt: 1_700_000_000_000, notifyOnComplete: false });
  });

  it('consentAt is a finite number or null', () => {
    for (const consentAt of ['today', Number.NaN, Number.POSITIVE_INFINITY, {}, true]) expect(normalizeSettings({ consentAt }).consentAt, String(consentAt)).toBeNull();
  });
});

describe('normalizeTarget / normalizeQueue', () => {
  it('a target needs a kind, a channel id and a channel name', () => {
    expect(normalizeTarget(target)).toEqual({ ...target });
    for (const bad of [null, 'x', { ...target, kind: 'voice' }, { ...target, channelId: '' }, { ...target, channelId: 5 }, { ...target, channelName: undefined }]) {
      expect(normalizeTarget(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('optional fields are kept only when valid', () => {
    expect(normalizeTarget({ ...target, parentId: '9', parentName: 'cat', channelType: 5, iconUrl: 'https://cdn.discordapp.com/x.png' })).toMatchObject({ parentId: '9', parentName: 'cat', channelType: 5, iconUrl: 'https://cdn.discordapp.com/x.png' });
    expect(normalizeTarget({ ...target, channelType: 'x' })).not.toHaveProperty('channelType');
  });

  it('a queue keeps the valid items in order, skipping garbage and duplicate keys', () => {
    const queue = normalizeQueue([
      { key: '10', target, settings: null, addedAt: 1 },
      'junk',
      { key: '11', target: { ...target, channelId: '11' }, settings: { count: 3 }, addedAt: 2, lastResult: { status: 'failed', message: 'no access', at: 5 } },
      { key: '10', target, settings: null, addedAt: 3 },
      { key: '12', target: { kind: 'nope' }, settings: null, addedAt: 4 },
      { target: { ...target, channelId: '13' } },
    ]);
    expect(queue.map((item) => item.key)).toEqual(['10', '11', '13']);
    expect(queue[0]).toEqual({ key: '10', target, settings: null, addedAt: 1 });
    expect(queue[1].settings).toEqual({ ...DEFAULT_EXPORT_SETTINGS, count: 3, content: { ...DEFAULT_EXPORT_SETTINGS.content } });
    expect(queue[1].lastResult).toEqual({ status: 'failed', message: 'no access', at: 5 });
    expect(queue[2]).toMatchObject({ key: '13', settings: null, addedAt: 0 }); // the key falls back to the channel id
  });

  it('settings that are not an object follow the common settings; not an array is an empty list', () => {
    expect(normalizeQueue([{ key: '10', target, settings: 'x', addedAt: 1 }])[0].settings).toBeNull();
    for (const raw of [undefined, null, {}, 'x', 5]) expect(normalizeQueue(raw)).toEqual([]);
  });

  it('a last result needs a known status', () => {
    expect(normalizeQueue([{ key: '10', target, settings: null, addedAt: 1, lastResult: { status: 'done', message: 'x', at: 1 } }])[0]).not.toHaveProperty('lastResult');
  });
});

describe('normalizeHistory', () => {
  const entry = {
    id: 'h1',
    accountId: '1',
    target,
    settings: { count: 10 },
    finishedAt: 5,
    status: 'done',
    messageCount: 10,
    files: [{ filename: 'a.html', downloadId: 7 }, { filename: 'b.html', downloadId: null }, { filename: 5 }, 'x'],
    error: null,
  };

  it('keeps valid entries and cleans their files', () => {
    const [first] = normalizeHistory([entry]);
    expect(first).toMatchObject({ id: 'h1', status: 'done', messageCount: 10, error: null });
    expect(first.files).toEqual([{ filename: 'a.html', downloadId: 7 }, { filename: 'b.html', downloadId: null }]);
    expect(first.settings.count).toBe(10);
  });

  it('skips entries without an id, a known status or a valid target', () => {
    expect(normalizeHistory([{ ...entry, id: '' }, { ...entry, status: 'weird' }, { ...entry, target: null }, null, 'x'])).toEqual([]);
    expect(normalizeHistory('nope')).toEqual([]);
  });

  it('a negative or fractional message count is made sane', () => {
    expect(normalizeHistory([{ ...entry, messageCount: -4 }])[0].messageCount).toBe(0);
    expect(normalizeHistory([{ ...entry, messageCount: 4.9 }])[0].messageCount).toBe(4);
  });
});

describe('normalizeJob', () => {
  const job = {
    jobId: 'j1',
    accountId: '1',
    startedAt: 1,
    finishedAt: null,
    state: 'running',
    pausedReason: null,
    zip: false,
    items: [
      { key: '10', label: 'Sample Server > #general', status: 'running', phase: 'messages', fetched: 5, expected: 10, error: null, files: [] },
      { key: '11', label: 'x', status: 'weird', phase: 'nowhere', fetched: -1, expected: 0, error: { kind: 'bad', message: 'm' }, files: ['a', 5] },
      { label: 'no key' },
    ],
  };

  it('keeps a job and cleans its items', () => {
    const result = normalizeJob(job) as JobState;
    expect(result.state).toBe('running');
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ key: '10', status: 'running', phase: 'messages', fetched: 5, expected: 10 });
    expect(result.items[1]).toEqual({ key: '11', label: 'x', status: 'waiting', phase: null, fetched: 0, expected: null, error: { kind: 'unknown', message: 'm' }, files: ['a'] });
  });

  it('is null without an id or a known state', () => {
    for (const raw of [null, undefined, {}, { ...job, jobId: '' }, { ...job, state: 'dancing' }, 'x']) expect(normalizeJob(raw)).toBeNull();
  });

  it('pausedReason is only ever "rate-limit" or null', () => {
    expect(normalizeJob({ ...job, state: 'paused', pausedReason: 'rate-limit' })?.pausedReason).toBe('rate-limit');
    expect(normalizeJob({ ...job, pausedReason: 'other' })?.pausedReason).toBeNull();
  });
});

describe('accounts, health, theme, status', () => {
  it('normalizeAccount needs an id and a username', () => {
    expect(normalizeAccount({ id: '1', username: 'u', globalName: 'U', avatarUrl: 'https://cdn.discordapp.com/a.png' })).toEqual({ id: '1', username: 'u', globalName: 'U', avatarUrl: 'https://cdn.discordapp.com/a.png' });
    expect(normalizeAccount({ id: '1', username: 'u' })).toEqual({ id: '1', username: 'u', globalName: null, avatarUrl: '' });
    for (const raw of [null, {}, { id: '', username: 'u' }, { id: '1' }, 'x']) expect(normalizeAccount(raw)).toBeNull();
  });

  it('normalizeHealth and latestHealth (the most recent report of all tabs)', () => {
    expect(normalizeHealth({ ok: false, reason: 'x', checkedAt: 5, url: 'u' })).toEqual({ ok: false, reason: 'x', checkedAt: 5, url: 'u' });
    expect(normalizeHealth({ reason: 'x' })).toBeNull();
    expect(
      latestHealth({
        '1': { ok: true, reason: null, checkedAt: 10, url: 'a' },
        '2': { ok: false, reason: 'broken', checkedAt: 20, url: 'b' },
        '3': 'junk',
      }),
    ).toMatchObject({ ok: false, reason: 'broken', checkedAt: 20 });
    expect(latestHealth({})).toBeNull();
    expect(latestHealth(null)).toBeNull();
  });

  it('normalizeTheme keeps the scheme, the classes, the variables and the language', () => {
    expect(normalizeTheme({ scheme: 'light', themeClasses: ['theme-light', 5], vars: { '--text-default': '#222', '--x': 5 }, lang: 'ko', capturedAt: 7 })).toEqual({
      scheme: 'light',
      themeClasses: ['theme-light'],
      vars: { '--text-default': '#222' },
      lang: 'ko',
      capturedAt: 7,
    });
    expect(normalizeTheme({})).toEqual({ scheme: 'dark', themeClasses: [], vars: {}, lang: '', capturedAt: 0 });
    expect(normalizeTheme(null)).toBeNull();
  });

  it('normalizeStatus', () => {
    expect(normalizeStatus({ account: null, lastAccount: null, discordTabs: 2.7, health: null, job: null })).toEqual({ account: null, lastAccount: null, discordTabs: 2, health: null, job: null });
    expect(normalizeStatus({ discordTabs: -3 })?.discordTabs).toBe(0);
    expect(normalizeStatus(undefined)).toBeNull();
    expect(normalizeStatus('x')).toBeNull();
  });
});

describe('asBgResponse', () => {
  it('passes a well-formed answer through', () => {
    expect(asBgResponse({ ok: true, data: { jobId: 'j' } })).toEqual({ ok: true, data: { jobId: 'j' } });
    expect(asBgResponse({ ok: false, error: 'no-account' })).toEqual({ ok: false, error: 'no-account' });
    expect(asBgResponse({ ok: false, error: 'empty', message: 'nothing' })).toEqual({ ok: false, error: 'empty', message: 'nothing' });
  });

  it('every error code of the contract is understood', () => {
    for (const error of ['no-account', 'no-consent', 'busy', 'empty', 'invalid', 'forbidden-path', 'http', 'unknown']) {
      expect(asBgResponse({ ok: false, error })).toEqual({ ok: false, error });
    }
  });

  it('anything else is an unknown error', () => {
    expect(asBgResponse(undefined)).toMatchObject({ ok: false, error: 'unknown' });
    expect(asBgResponse({ ok: false, error: 'mystery', message: '' })).toEqual({ ok: false, error: 'unknown' });
  });
});

describe('normalizeGroups (LOCAL.groups: names, icons and viewable channels of servers and categories)', () => {
  const guild = { kind: 'guild', guildId: '20', channelIds: ['1', '2'], updatedAt: 5, name: 'Sample Server', iconUrl: 'https://cdn.discordapp.com/icons/20/a.png' };

  it('keeps good groups, with the optional name and icon', () => {
    const result = normalizeGroups({ '20': guild, '30': { kind: 'category', guildId: '20', channelIds: ['1'], updatedAt: 6, name: 'Study' } });
    expect(result['20']).toEqual(guild);
    expect(result['30']).toEqual({ kind: 'category', guildId: '20', channelIds: ['1'], updatedAt: 6, name: 'Study' });
    expect('iconUrl' in result['30']).toBe(false); // absent stays absent
  });

  it('an old record without name and icon is fine; a null name or icon stays null', () => {
    expect(normalizeGroups({ '20': { kind: 'guild', guildId: '20', channelIds: [], updatedAt: 1 } })['20']).toEqual({ kind: 'guild', guildId: '20', channelIds: [], updatedAt: 1 });
    expect(normalizeGroups({ '20': { ...guild, name: null, iconUrl: null } })['20']).toMatchObject({ name: null, iconUrl: null });
    expect(normalizeGroups({ '20': { ...guild, name: 5, iconUrl: {} } })['20']).toMatchObject({ name: null, iconUrl: null });
  });

  it('malformed groups are skipped, malformed channel ids dropped, a bad time becomes 0', () => {
    const result = normalizeGroups({
      a: 'x',
      b: null,
      c: { kind: 'planet', guildId: '1', channelIds: [] },
      d: { kind: 'guild', channelIds: [] },
      e: { kind: 'guild', guildId: '', channelIds: [] },
      f: { kind: 'guild', guildId: '1' },
      g: { kind: 'guild', guildId: '1', channelIds: 'nope' },
      '': { kind: 'guild', guildId: '1', channelIds: [] },
      h: { kind: 'category', guildId: '1', channelIds: ['1', 2, null, '', '3'], updatedAt: 'later' },
    });
    expect(Object.keys(result)).toEqual(['h']);
    expect(result.h).toEqual({ kind: 'category', guildId: '1', channelIds: ['1', '3'], updatedAt: 0 });
  });

  it('anything that is not a record gives an empty map', () => {
    for (const raw of [undefined, null, 5, 'x', [], [guild]]) expect(normalizeGroups(raw), String(raw)).toEqual({});
  });

  it('a key named __proto__ is just a key', () => {
    const raw = JSON.parse(`{"__proto__":{"kind":"guild","guildId":"1","channelIds":[]}}`) as unknown;
    const result = normalizeGroups(raw);
    expect(Object.keys(result)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});

describe('normalizeGroupSettings (LOCAL.groupSettings)', () => {
  it('completes every settings object with the defaults and skips what is not an object', () => {
    const result = normalizeGroupSettings({ '20': { count: 5, format: 'md' }, '30': 'x', '40': null, '50': [], '60': {} });
    expect(Object.keys(result).sort()).toEqual(['20', '60']);
    expect(result['20']).toEqual({ ...DEFAULT_EXPORT_SETTINGS, count: 5, format: 'md', content: { ...DEFAULT_EXPORT_SETTINGS.content } });
    expect(result['60']).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(result['60']).not.toBe(DEFAULT_EXPORT_SETTINGS);
  });

  it('anything that is not a record gives an empty map; an empty key is skipped', () => {
    for (const raw of [undefined, null, 5, 'x', [], [{}]]) expect(normalizeGroupSettings(raw), String(raw)).toEqual({});
    expect(normalizeGroupSettings({ '': {} })).toEqual({});
  });
});

describe('normalizeExpanded (LOCAL.uiExpanded)', () => {
  it('keeps the non-empty strings once each', () => {
    expect(normalizeExpanded(['a', 'b', 'a', '', 5, null, {}, 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('anything that is not an array gives an empty list', () => {
    for (const raw of [undefined, null, 'a', 5, {}, { 0: 'a' }]) expect(normalizeExpanded(raw), String(raw)).toEqual([]);
  });
});
