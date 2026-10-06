import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, DEFAULT_EXPORT_SETTINGS } from '@/shared';
import type { ItemProgress, JobState } from '@/shared';
import {
  isDiscordCdnUrl,
  isOwnBlobUrl,
  isSafeRelativePath,
  isTerminalStatus,
  mergeProgress,
  normalizeExportSettings,
  normalizeGroupSettings,
  normalizeGroups,
  normalizeHistory,
  normalizeJob,
  normalizeLastExported,
  normalizeQueue,
  normalizeSettings,
  sanitizeFolderName,
  validateExportSettings,
  validateGroupSettingsRequest,
  validateHistoryEntry,
  validateKeyList,
  validateQueueItem,
  validateSettingsPatch,
  validateTarget,
} from '@/background/validate';
import { ACCOUNT_ID, CATEGORY_ID, CHANNEL_A, CHANNEL_B, DM_CHANNEL, GUILD_ID, dmTarget, exportSettings, guildTarget, queueItem } from './helpers';

const expectOk = <T>(result: { ok: boolean; value?: T; message?: string }): T => {
  expect(result.message).toBeUndefined();
  expect(result.ok).toBe(true);
  return result.value as T;
};

const expectBad = (result: { ok: boolean; message?: string }, fragment?: string): void => {
  expect(result.ok).toBe(false);
  if (fragment !== undefined) expect(result.message).toContain(fragment);
};

describe('validateTarget', () => {
  it('accepts a guild channel and returns only the known fields', () => {
    const target = expectOk(validateTarget({ ...guildTarget(), extra: 'x', __proto__: { polluted: true } }));
    expect(target).toEqual(guildTarget());
    expect(Object.keys(target).sort()).toEqual(['channelId', 'channelName', 'guildId', 'guildName', 'kind']);
  });

  it('accepts DMs, group DMs, threads and forums', () => {
    expect(expectOk(validateTarget(dmTarget())).kind).toBe('dm');
    expect(expectOk(validateTarget(dmTarget(DM_CHANNEL, { kind: 'group-dm', channelName: 'Group' }))).kind).toBe('group-dm');
    const thread = expectOk(
      validateTarget(guildTarget(CHANNEL_B, { kind: 'thread', parentId: CHANNEL_A, parentName: 'general', channelType: 11 })),
    );
    expect(thread).toMatchObject({ kind: 'thread', parentId: CHANNEL_A, parentName: 'general', channelType: 11 });
    expect(expectOk(validateTarget(guildTarget(CHANNEL_B, { kind: 'forum', channelType: 15 }))).kind).toBe('forum');
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'target'],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expectBad(validateTarget(value), 'object');
  });

  it.each(['channel', '', 'DM', 'guild_channel', 5, null, undefined])('rejects kind %j', (kind) => {
    expectBad(validateTarget({ ...guildTarget(), kind }), 'kind');
  });

  it.each(['abc', '12a', '', ' 1', '1 ', '-1', '1.5', '123456789012345678901', 123, null, undefined, ['1']])('rejects channelId %j', (channelId) => {
    expectBad(validateTarget({ ...guildTarget(), channelId }), 'channelId');
  });

  it.each(['x', '', 12, undefined, '1e3'])('rejects guildId %j', (guildId) => {
    expectBad(validateTarget({ ...guildTarget(), guildId }), 'guildId');
  });

  it('keeps DMs and guild chats apart: a DM has no guildId, a guild chat needs one', () => {
    expectBad(validateTarget(dmTarget(DM_CHANNEL, { guildId: GUILD_ID })), 'no guildId');
    expectBad(validateTarget(dmTarget(DM_CHANNEL, { kind: 'group-dm', guildId: GUILD_ID })), 'no guildId');
    for (const kind of ['guild-channel', 'thread', 'forum'] as const) {
      expectBad(validateTarget(guildTarget(CHANNEL_A, { kind, guildId: null })), 'needs a guildId');
    }
  });

  it('cleans names: control and bidi characters go, whitespace collapses, the ends are trimmed', () => {
    const target = expectOk(validateTarget(guildTarget(CHANNEL_A, { channelName: '  gen\u202Eeral\n\tchat\u0000  ', guildName: ' Test\u200B  Server ' })));
    expect(target.channelName).toBe('general chat');
    expect(target.guildName).toBe('Test Server');
  });

  it('limits names to 100 characters (code points: an emoji counts once)', () => {
    expectOk(validateTarget(guildTarget(CHANNEL_A, { channelName: 'a'.repeat(100) })));
    expectOk(validateTarget(guildTarget(CHANNEL_A, { channelName: '😀'.repeat(100) })));
    expectBad(validateTarget(guildTarget(CHANNEL_A, { channelName: 'a'.repeat(101) })), 'channelName');
    expectBad(validateTarget(guildTarget(CHANNEL_A, { channelName: 'a'.repeat(5000) })), 'channelName');
    expectBad(validateTarget(guildTarget(CHANNEL_A, { guildName: 'g'.repeat(101) })), 'guildName');
    expectBad(validateTarget(guildTarget(CHANNEL_A, { parentName: 'p'.repeat(101) })), 'parentName');
  });

  it('needs a real channel name', () => {
    for (const channelName of ['', '   ', '\u200B\u202E', undefined, 5, null]) {
      expectBad(validateTarget({ ...guildTarget(), channelName }), 'channelName');
    }
  });

  it('treats an empty or missing guild/parent name as unknown', () => {
    expect(expectOk(validateTarget({ ...guildTarget(), guildName: '  ' })).guildName).toBeNull();
    const { guildName: _omit, ...withoutGuildName } = guildTarget();
    expect(expectOk(validateTarget(withoutGuildName)).guildName).toBeNull();
    expect(expectOk(validateTarget({ ...guildTarget(), parentName: '' })).parentName).toBeNull();
  });

  it('validates parentId, parentName and channelType when present', () => {
    expectBad(validateTarget({ ...guildTarget(), parentId: 'abc' }), 'parentId');
    expect(expectOk(validateTarget({ ...guildTarget(), parentId: null })).parentId).toBeNull();
    for (const channelType of [-1, 65, 1.5, '0', NaN, null]) expectBad(validateTarget({ ...guildTarget(), channelType }), 'channelType');
    expect(expectOk(validateTarget({ ...guildTarget(), channelType: 0 })).channelType).toBe(0);
  });

  it('keeps an iconUrl only when it is on the Discord CDN, and otherwise drops just the icon', () => {
    const cdn = 'https://cdn.discordapp.com/avatars/1/abc.png?size=64';
    expect(expectOk(validateTarget(dmTarget(DM_CHANNEL, { iconUrl: cdn }))).iconUrl).toBe(cdn);
    for (const iconUrl of ['http://cdn.discordapp.com/a.png', 'https://evil.example/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', `https://cdn.discordapp.com/${'a'.repeat(600)}`]) {
      expect(expectOk(validateTarget(dmTarget(DM_CHANNEL, { iconUrl }))).iconUrl).toBeNull();
    }
    expect(expectOk(validateTarget(dmTarget(DM_CHANNEL, { iconUrl: null }))).iconUrl).toBeNull();
  });
});

describe('validateExportSettings', () => {
  it('accepts the defaults and returns a fresh object', () => {
    const result = expectOk(validateExportSettings(DEFAULT_EXPORT_SETTINGS));
    expect(result).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(result).not.toBe(DEFAULT_EXPORT_SETTINGS);
    expect(result.content).not.toBe(DEFAULT_EXPORT_SETTINGS.content);
  });

  it('accepts count null (everything) and the limits 1 and 1,000,000', () => {
    for (const count of [null, 1, 200, 1_000_000]) expect(validateExportSettings(exportSettings({ count })).ok).toBe(true);
  });

  it.each([0, -5, 1_000_001, 1.5, NaN, Infinity, '200', undefined])('rejects count %j', (count) => {
    expectBad(validateExportSettings({ ...exportSettings(), count }), 'count');
  });

  it('checks the date range: ISO 8601 UTC strings, from not after to', () => {
    const from = '2026-01-01T00:00:00.000Z';
    const to = '2026-12-31T23:59:59.999Z';
    expect(validateExportSettings(exportSettings({ from, to })).ok).toBe(true);
    expect(validateExportSettings(exportSettings({ from, to: from })).ok).toBe(true);
    expect(validateExportSettings(exportSettings({ from, to: null })).ok).toBe(true);
    expect(validateExportSettings(exportSettings({ from: null, to })).ok).toBe(true);
    expect(validateExportSettings(exportSettings({ from: '2026-01-01T00:00:00Z' })).ok).toBe(true);
    expectBad(validateExportSettings(exportSettings({ from: to, to: from })), 'from must not be after to');
  });

  it.each(['2026-01-01', '2026-01-01T00:00:00', '2026-01-01T00:00:00+09:00', 'yesterday', '', '2026-13-01T00:00:00.000Z', '2026-02-31T00:00:00.000Z', 20260101, undefined])(
    'rejects the time %j',
    (value) => {
      expectBad(validateExportSettings({ ...exportSettings(), from: value }), 'from');
      expectBad(validateExportSettings({ ...exportSettings(), to: value }), 'to');
    },
  );

  it('knows the formats and themes', () => {
    for (const format of ['html', 'txt', 'md', 'xlsx', 'csv', 'json'] as const) expect(validateExportSettings(exportSettings({ format })).ok).toBe(true);
    for (const format of ['pdf', 'HTML', '', null, undefined]) expectBad(validateExportSettings({ ...exportSettings(), format }), 'format');
    expect(validateExportSettings(exportSettings({ htmlTheme: 'light' })).ok).toBe(true);
    expectBad(validateExportSettings({ ...exportSettings(), htmlTheme: 'blue' }), 'htmlTheme');
  });

  it('needs every boolean and the content options', () => {
    for (const key of ['includeAttachments', 'includeThreads', 'incremental']) {
      expectBad(validateExportSettings({ ...exportSettings(), [key]: 'yes' }), key);
      expectBad(validateExportSettings({ ...exportSettings(), [key]: undefined }), key);
    }
    expectBad(validateExportSettings({ ...exportSettings(), content: undefined }), 'content');
    for (const key of ['includeBots', 'includeSystem', 'includeReactions', 'includeEmbeds']) {
      expectBad(validateExportSettings({ ...exportSettings(), content: { ...exportSettings().content, [key]: 1 } }), key);
    }
  });

  it('drops unknown fields', () => {
    const result = expectOk(validateExportSettings({ ...exportSettings(), secret: 'x', content: { ...exportSettings().content, extra: true } }));
    expect(result).toEqual(exportSettings());
  });

  it.each([null, undefined, 'settings', 5, []])('rejects %j', (value) => {
    expectBad(validateExportSettings(value), 'object');
  });
});

describe('normalizeExportSettings and normalizeSettings (lenient reads)', () => {
  it('falls back to the defaults for nothing, junk or the wrong type', () => {
    for (const raw of [undefined, null, 'x', 5, [], {}]) {
      expect(normalizeExportSettings(raw)).toEqual(DEFAULT_EXPORT_SETTINGS);
      expect(normalizeSettings(raw)).toEqual(DEFAULT_APP_SETTINGS);
    }
  });

  it('returns copies that can be edited without touching the frozen defaults', () => {
    const settings = normalizeSettings(undefined);
    settings.common.content.includeBots = false;
    settings.common.count = 5;
    expect(DEFAULT_APP_SETTINGS.common.content.includeBots).toBe(true);
    expect(DEFAULT_APP_SETTINGS.common.count).toBe(200);
  });

  it('merges the stored fields over the defaults, the common settings field by field', () => {
    const settings = normalizeSettings({
      common: { count: null, format: 'xlsx', content: { includeBots: false } },
      zipAll: true,
      folderName: 'My Exports',
      language: 'ko',
      consentAt: 12345,
    });
    expect(settings.common).toEqual({ ...DEFAULT_EXPORT_SETTINGS, count: null, format: 'xlsx', content: { ...DEFAULT_EXPORT_SETTINGS.content, includeBots: false } });
    expect(settings).toMatchObject({ zipAll: true, folderName: 'My Exports', language: 'ko', consentAt: 12345, showButtons: true, notifyOnComplete: true });
  });

  it('repairs a bad field on its own without losing the good ones', () => {
    const settings = normalizeSettings({
      common: { count: 0, format: 'pdf', htmlTheme: 'light', from: 'x', to: 5, includeThreads: 'yes', incremental: true },
      showButtons: 'no',
      folderName: '///',
      timeZone: 'Mars/Base',
      language: 'fr',
      consentAt: 'yesterday',
    });
    expect(settings.common).toEqual({ ...DEFAULT_EXPORT_SETTINGS, htmlTheme: 'light', incremental: true });
    expect(settings).toMatchObject({ showButtons: true, folderName: '___', timeZone: 'auto', language: 'auto', consentAt: null });
  });

  it('refuses a contradictory range (it keeps neither end)', () => {
    const common = normalizeExportSettings({ from: '2026-12-31T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' });
    expect(common.from).toBeNull();
    expect(common.to).toBeNull();
  });

  it('accepts null as the count (all messages) and a real time zone', () => {
    expect(normalizeSettings({ common: { count: null }, timeZone: 'Asia/Seoul' })).toMatchObject({ common: { count: null }, timeZone: 'Asia/Seoul' });
  });
});

describe('sanitizeFolderName', () => {
  it.each([
    ['Discord Export', 'Discord Export'],
    ['  padded  ', 'padded'],
    ['a/b', 'a_b'],
    ['a\\b', 'a_b'],
    ['a<b>c:d"e|f?g*h', 'a_b_c_d_e_f_g_h'],
    ['100%', '100_'],
    ['tab\there', 'tab here'],
    ['ctrl\u0007char', 'ctrl_char'],
    ['bidi\u202Etxt', 'biditxt'],
    ['...hidden', 'hidden'],
    ['trailing. .', 'trailing'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['COM1', '_COM1'],
    ['Console', 'Console'],
    ['한글 폴더', '한글 폴더'],
  ])('%j -> %j', (input, expected) => {
    expect(sanitizeFolderName(input)).toBe(expected);
  });

  it('is empty when nothing usable is left', () => {
    for (const input of ['', '   ', '...', '. .', '\u200B\u202E']) expect(sanitizeFolderName(input)).toBe('');
  });

  it('cuts to 60 characters and does not leave a trailing dot or space behind', () => {
    expect(sanitizeFolderName('a'.repeat(100))).toBe('a'.repeat(60));
    expect(sanitizeFolderName(`${'a'.repeat(59)} b`)).toBe('a'.repeat(59));
    expect(Array.from(sanitizeFolderName('😀'.repeat(100)))).toHaveLength(60);
  });
});

describe('validateSettingsPatch', () => {
  it('accepts the empty patch and ignores unknown keys', () => {
    expect(expectOk(validateSettingsPatch({}))).toEqual({});
    expect(expectOk(validateSettingsPatch({ nothing: 1, toString: 'x' }))).toEqual({});
  });

  it.each([null, undefined, 'patch', 5, []])('rejects %j', (value) => {
    expectBad(validateSettingsPatch(value), 'object');
  });

  it('validates the booleans', () => {
    for (const key of ['showButtons', 'showQueuedIndicator', 'zipAll', 'dateInFileName', 'notifyOnComplete']) {
      expect(expectOk(validateSettingsPatch({ [key]: false }))).toEqual({ [key]: false });
      expectBad(validateSettingsPatch({ [key]: 'false' }), key);
      expectBad(validateSettingsPatch({ [key]: null }), key);
    }
  });

  it('takes `common` as a whole valid ExportSettings (no partial common)', () => {
    const common = exportSettings({ count: null, format: 'json' });
    expect(expectOk(validateSettingsPatch({ common }))).toEqual({ common });
    expectBad(validateSettingsPatch({ common: { count: 5 } }), 'common');
    expectBad(validateSettingsPatch({ common: { ...common, count: 0 } }), 'common: count');
    expectBad(validateSettingsPatch({ common: { ...common, from: '2026-12-31T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' } }), 'from must not be after to');
    expectBad(validateSettingsPatch({ common: null }), 'common');
  });

  it('sanitises the folder name and refuses one with nothing left', () => {
    expect(expectOk(validateSettingsPatch({ folderName: 'a/b' }))).toEqual({ folderName: 'a_b' });
    expect(expectOk(validateSettingsPatch({ folderName: 'x'.repeat(90) })).folderName).toBe('x'.repeat(60));
    for (const folderName of ['', '   ', '...', 5, null, undefined, 'x'.repeat(5000)]) expectBad(validateSettingsPatch({ folderName }), 'folderName');
  });

  it('accepts auto or a real IANA time zone', () => {
    for (const timeZone of ['auto', 'Asia/Seoul', 'America/New_York', 'UTC']) expect(expectOk(validateSettingsPatch({ timeZone }))).toEqual({ timeZone });
    for (const timeZone of ['Mars/Base', '', 5, null, 'x'.repeat(100)]) expectBad(validateSettingsPatch({ timeZone }), 'timeZone');
  });

  it('accepts the three languages', () => {
    for (const language of ['auto', 'ko', 'en']) expect(expectOk(validateSettingsPatch({ language }))).toEqual({ language });
    for (const language of ['fr', 'KO', '', 5, null]) expectBad(validateSettingsPatch({ language }), 'language');
  });

  it('accepts null or a finite non-negative time as consentAt', () => {
    expect(expectOk(validateSettingsPatch({ consentAt: null }))).toEqual({ consentAt: null });
    expect(expectOk(validateSettingsPatch({ consentAt: 1_700_000_000_000 }))).toEqual({ consentAt: 1_700_000_000_000 });
    for (const consentAt of [-1, NaN, Infinity, '1700000000000', undefined, {}]) expectBad(validateSettingsPatch({ consentAt }), 'consentAt');
  });

  it('refuses the whole patch when one value is bad', () => {
    expectBad(validateSettingsPatch({ showButtons: true, language: 'fr' }), 'language');
  });
});

describe('isSafeRelativePath', () => {
  it.each([
    'file.html',
    'Discord Export/Test Server - general (2026-10-06).html',
    'Discord Export/DM - Friend (2026-10-06)_files/123_photo.png',
    'a/b/c.txt',
    '한글/파일.md',
    'name with spaces/and (parens) [1].json',
    'v1.2.3/file.tar.gz',
    '%20/file',
  ])('accepts %j', (path) => {
    expect(isSafeRelativePath(path)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['absolute', '/etc/passwd'],
    ['drive letter', 'C:/Windows/x'],
    ['drive letter with backslash', 'C:\\Windows\\x'],
    ['UNC', '\\\\server\\share\\x'],
    ['backslash separator', 'a\\b'],
    ['parent segment', 'a/../b'],
    ['leading parent', '../a'],
    ['only parent', '..'],
    ['dot segment', 'a/./b'],
    ['only dot', '.'],
    ['dots segment', 'a/.../b'],
    ['empty segment', 'a//b'],
    ['trailing slash', 'a/'],
    ['blank segment', 'a/ /b'],
    ['colon (alternate data stream)', 'a:b'],
    ['star', 'a*b'],
    ['question mark', 'a?b'],
    ['quote', 'a"b'],
    ['angle brackets', 'a<b>'],
    ['pipe', 'a|b'],
    ['NUL', 'a\u0000b'],
    ['newline', 'a\nb'],
    ['DEL', 'a\u007fb'],
    ['too long', `${'a'.repeat(200)}/${'b'.repeat(201)}`],
  ])('rejects %s', (_label, path) => {
    expect(isSafeRelativePath(path)).toBe(false);
  });

  it('rejects things that are not strings', () => {
    for (const value of [undefined, null, 5, {}, ['a'], true]) expect(isSafeRelativePath(value)).toBe(false);
  });
});

describe('URL checks', () => {
  it('isDiscordCdnUrl: https on the two CDN hosts only', () => {
    for (const url of ['https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&is=2&hm=3', 'https://media.discordapp.net/attachments/1/2/a.png']) {
      expect(isDiscordCdnUrl(url)).toBe(true);
    }
    for (const url of [
      'http://cdn.discordapp.com/a.png',
      'https://cdn.discordapp.com.evil.example/a.png',
      'https://evil.example/https://cdn.discordapp.com/a.png',
      'https://discord.com/api/v9/users/@me',
      'https://user:pass@cdn.discordapp.com/a.png',
      'https://cdn.discordapp.com:8443/a.png',
      'https://sub.cdn.discordapp.com/a.png',
      'blob:chrome-extension://x/y',
      'data:text/plain,hi',
      'cdn.discordapp.com/a.png',
      '',
      `https://cdn.discordapp.com/${'a'.repeat(3000)}`,
    ]) {
      expect(isDiscordCdnUrl(url)).toBe(false);
    }
    expect(isDiscordCdnUrl(undefined)).toBe(false);
    expect(isDiscordCdnUrl(5)).toBe(false);
  });

  it('isOwnBlobUrl: only this extension\'s blob URLs', () => {
    const id = 'abcdefghijklmnopabcdefghijklmnop';
    expect(isOwnBlobUrl(`blob:chrome-extension://${id}/0f8fad5b-d9cb-469f-a165-70867728950e`, id)).toBe(true);
    for (const url of [
      'blob:chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/uuid',
      `blob:https://discord.com/${id}`,
      `chrome-extension://${id}/offscreen.html`,
      `blob:chrome-extension://${id}`,
      'https://cdn.discordapp.com/a.png',
      '',
      undefined,
      5,
    ]) {
      expect(isOwnBlobUrl(url, id)).toBe(false);
    }
  });
});

describe('validateQueueItem (queue/upsert)', () => {
  it('accepts an item that follows the common settings (settings: null)', () => {
    expect(expectOk(validateQueueItem(queueItem()))).toEqual(queueItem());
  });

  it('accepts an item with its own settings and a lastResult', () => {
    const item = queueItem(guildTarget(), { settings: exportSettings({ count: 50 }), lastResult: { status: 'failed', message: 'forbidden', at: 5 } });
    expect(expectOk(validateQueueItem(item))).toEqual(item);
  });

  it('refuses a key that is not the channel id, bad settings and a bad time', () => {
    expectBad(validateQueueItem({ ...queueItem(), key: CHANNEL_B }), 'key');
    expectBad(validateQueueItem({ ...queueItem(), settings: { count: 5 } }), 'item.settings');
    expectBad(validateQueueItem({ ...queueItem(), settings: undefined }), 'item.settings');
    expectBad(validateQueueItem({ ...queueItem(), addedAt: 'now' }), 'addedAt');
    expectBad(validateQueueItem({ ...queueItem(), addedAt: -1 }), 'addedAt');
    expectBad(validateQueueItem({ ...queueItem(), target: { ...guildTarget(), kind: 'nope' } }), 'kind');
    expectBad(validateQueueItem(null), 'object');
  });

  it('distinguishes "no lastResult" (keep the stored one) from an explicit null and from a malformed one', () => {
    expect('lastResult' in expectOk(validateQueueItem(queueItem()))).toBe(false);
    expect(expectOk(validateQueueItem({ ...queueItem(), lastResult: null })).lastResult).toBeNull();
    expectBad(validateQueueItem({ ...queueItem(), lastResult: { status: 'done', message: 'x', at: 1 } }), 'lastResult');
    expectBad(validateQueueItem({ ...queueItem(), lastResult: 'failed' }), 'lastResult');
  });
});

describe('normalizeQueue (lenient read)', () => {
  it('is empty for anything that is not an array', () => {
    for (const raw of [undefined, null, {}, 'x', 5]) expect(normalizeQueue(raw)).toEqual([]);
  });

  it('keeps valid items in order and drops invalid ones, wrong keys and duplicates', () => {
    const queue = normalizeQueue([
      queueItem(guildTarget(CHANNEL_A)),
      { key: 'nope', target: guildTarget(CHANNEL_B), settings: null, addedAt: 1 },
      queueItem(guildTarget(CHANNEL_A, { channelName: 'duplicate' })),
      'junk',
      null,
      { key: CHANNEL_B, target: { kind: 'nope' }, settings: null, addedAt: 1 },
      queueItem(dmTarget()),
    ]);
    expect(queue.map((item) => item.key)).toEqual([CHANNEL_A, DM_CHANNEL]);
    expect(queue[0].target.channelName).toBe('general');
  });

  it('turns damaged item settings into "follow the common settings" and repairs addedAt / lastResult', () => {
    const [item] = normalizeQueue([{ ...queueItem(), settings: { count: -1 }, addedAt: 'x', lastResult: { status: 'bogus' } }]);
    expect(item.settings).toBeNull();
    expect(item.addedAt).toBe(0);
    expect('lastResult' in item).toBe(false);
  });

  it('keeps own settings and a valid lastResult', () => {
    const own = queueItem(guildTarget(), { settings: exportSettings({ format: 'csv' }), lastResult: { status: 'partial', message: 'm', at: 9 } });
    expect(normalizeQueue([own])).toEqual([own]);
  });
});

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: 'h1',
  accountId: ACCOUNT_ID,
  target: guildTarget(),
  settings: exportSettings(),
  finishedAt: 1_700_000_000_000,
  status: 'done',
  messageCount: 12,
  files: [{ filename: 'Discord Export/a.html', downloadId: 3 }],
  error: null,
  ...overrides,
});

describe('validateHistoryEntry / normalizeHistory', () => {
  it('accepts a complete entry', () => {
    expect(expectOk(validateHistoryEntry(entry()))).toEqual(entry());
  });

  it.each([
    [{ id: '' }, 'id'],
    [{ id: 5 }, 'id'],
    [{ accountId: 'x' }, 'accountId'],
    [{ target: { kind: 'nope' } }, 'target'],
    [{ settings: {} }, 'settings'],
    [{ finishedAt: 'x' }, 'finishedAt'],
    [{ status: 'cancelled' }, 'status'],
    [{ messageCount: -1 }, 'messageCount'],
    [{ messageCount: 1.5 }, 'messageCount'],
    [{ files: 'a.html' }, 'files'],
    [{ error: 5 }, 'error'],
  ])('rejects %j', (overrides, fragment) => {
    expectBad(validateHistoryEntry(entry(overrides)), fragment);
  });

  it('drops malformed file records and cuts a long error', () => {
    const result = expectOk(
      validateHistoryEntry(
        entry({ files: [{ filename: 'a.html', downloadId: null }, { filename: 5 }, 'x', { filename: 'b.html', downloadId: -1 }, { filename: 'c.html', downloadId: 7 }], error: 'e'.repeat(1000) }),
      ),
    );
    expect(result.files).toEqual([
      { filename: 'a.html', downloadId: null },
      { filename: 'c.html', downloadId: 7 },
    ]);
    expect(result.error).toHaveLength(300);
  });

  it('normalizeHistory keeps order, drops invalid and duplicate entries and caps at 200', () => {
    const many = Array.from({ length: 250 }, (_, index) => entry({ id: `h${index}` }));
    expect(normalizeHistory(many)).toHaveLength(200);
    expect(normalizeHistory(many)[0].id).toBe('h0');
    expect(normalizeHistory([entry({ id: 'a' }), entry({ id: 'a', messageCount: 99 }), { junk: true }, entry({ id: 'b' })]).map((e) => e.id)).toEqual(['a', 'b']);
    for (const raw of [undefined, null, {}, 'x']) expect(normalizeHistory(raw)).toEqual([]);
  });
});

describe('normalizeLastExported', () => {
  it('keeps numeric channel -> message id pairs only', () => {
    expect(normalizeLastExported({ [CHANNEL_A]: '900', abc: '1', [CHANNEL_B]: 'x', 7: 5, [DM_CHANNEL]: '1000' })).toEqual({ [CHANNEL_A]: '900', [DM_CHANNEL]: '1000' });
    for (const raw of [undefined, null, [], 'x']) expect(normalizeLastExported(raw)).toEqual({});
  });
});

describe('normalizeGroups (lenient read of LOCAL.groups)', () => {
  const group = (overrides: Record<string, unknown> = {}) => ({ kind: 'category', guildId: GUILD_ID, channelIds: [CHANNEL_A, CHANNEL_B], updatedAt: 1_700_000_000_000, ...overrides });

  it('keeps well-formed guild and category groups as they are', () => {
    const stored = { [GUILD_ID]: group({ kind: 'guild' }), [CATEGORY_ID]: group(), [DM_CHANNEL]: group({ channelIds: [] }) };
    expect(normalizeGroups(stored)).toEqual(stored);
  });

  it('is not a record: empty', () => {
    for (const raw of [undefined, null, [], 'x', 5]) expect(normalizeGroups(raw)).toEqual({});
  });

  it('drops an entry whose key is not an id, whose kind is unknown, whose guild is not an id or whose channel list is not a list', () => {
    const normalized = normalizeGroups({
      abc: group(),
      [CHANNEL_A]: group({ kind: 'server' }),
      [CHANNEL_B]: group({ guildId: 'g' }),
      [DM_CHANNEL]: group({ channelIds: 'nope' }),
      [CATEGORY_ID]: 'x',
      [GUILD_ID]: group(),
    });
    expect(Object.keys(normalized)).toEqual([GUILD_ID]);
  });

  it('repairs the fields: only numeric channel ids (each once) survive, a bad time becomes 0, unknown fields go', () => {
    const [entry] = Object.values(normalizeGroups({ [CATEGORY_ID]: group({ channelIds: [CHANNEL_A, 'x', 5, CHANNEL_A, null, CHANNEL_B], updatedAt: 'later', extra: true }) }));
    expect(entry).toEqual({ kind: 'category', guildId: GUILD_ID, channelIds: [CHANNEL_A, CHANNEL_B], updatedAt: 0 });
    for (const updatedAt of [-1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(Object.values(normalizeGroups({ [CATEGORY_ID]: group({ updatedAt }) }))[0].updatedAt).toBe(0);
    }
  });

  describe('name and iconUrl (5th change)', () => {
    const ICON = `https://cdn.discordapp.com/icons/${GUILD_ID}/abcdef0123456789.png?size=64`;
    const one = (id: string, overrides: Record<string, unknown>) => normalizeGroups({ [id]: group(overrides) })[id];

    it('keeps a name and a guild icon, and a null of either', () => {
      expect(one(GUILD_ID, { kind: 'guild', name: 'Test Server', iconUrl: ICON })).toMatchObject({ name: 'Test Server', iconUrl: ICON });
      expect(one(GUILD_ID, { kind: 'guild', name: null, iconUrl: null })).toMatchObject({ name: null, iconUrl: null });
      expect(one(CATEGORY_ID, { name: 'Study' })).toMatchObject({ name: 'Study' });
    });

    it('an older record without them stays without them (nothing is invented)', () => {
      const entry = one(GUILD_ID, { kind: 'guild' });
      expect('name' in entry).toBe(false);
      expect('iconUrl' in entry).toBe(false);
    });

    it('cleans the name and leaves out one that is not usable', () => {
      expect(one(CATEGORY_ID, { name: '  Stu‮dy  ' }).name).toBe('Study');
      for (const name of [5, '', '   ', 'x'.repeat(101), {}, undefined]) expect('name' in one(CATEGORY_ID, { name })).toBe(false);
    });

    it('an icon must be a Discord CDN URL: anything else is left out; a category never has one', () => {
      for (const iconUrl of ['https://evil.example/a.png', 'javascript:alert(1)', 5, ICON + 'x'.repeat(500), undefined]) {
        expect('iconUrl' in one(GUILD_ID, { kind: 'guild', iconUrl })).toBe(false);
      }
      expect('iconUrl' in one(CATEGORY_ID, { iconUrl: ICON })).toBe(false);
    });
  });
});

describe('normalizeGroupSettings (lenient read of LOCAL.groupSettings)', () => {
  it('keeps complete valid settings by numeric group id', () => {
    const stored = { [GUILD_ID]: exportSettings({ format: 'md' }), [CATEGORY_ID]: exportSettings({ count: null, includeAttachments: true }) };
    expect(normalizeGroupSettings(stored)).toEqual(stored);
  });

  it('is not a record: empty', () => {
    for (const raw of [undefined, null, [], 'x', 5]) expect(normalizeGroupSettings(raw)).toEqual({});
  });

  it('drops an entry whose key is not an id or whose settings are incomplete or invalid (that group then follows the next level up)', () => {
    const normalized = normalizeGroupSettings({
      abc: exportSettings(),
      [CHANNEL_A]: { count: 5 },
      [CHANNEL_B]: exportSettings({ count: 0 }),
      [DM_CHANNEL]: 'x',
      [CATEGORY_ID]: null,
      [GUILD_ID]: exportSettings({ format: 'csv' }),
    });
    expect(normalized).toEqual({ [GUILD_ID]: exportSettings({ format: 'csv' }) });
  });

  it('returns copies holding only the known fields', () => {
    const stored = { [GUILD_ID]: { ...exportSettings(), extra: 1 } };
    expect(normalizeGroupSettings(stored)[GUILD_ID]).toEqual(exportSettings());
    expect(normalizeGroupSettings(stored)[GUILD_ID]).not.toBe(stored[GUILD_ID]);
  });
});

describe('validateGroupSettingsRequest (queue/setGroupSettings)', () => {
  const request = (overrides: Record<string, unknown> = {}) => ({ kind: 'category', guildId: GUILD_ID, groupId: CATEGORY_ID, settings: exportSettings({ count: 50 }), ...overrides });

  it('accepts a category or a server group with settings, and with null', () => {
    expect(expectOk(validateGroupSettingsRequest(request()))).toEqual({ kind: 'category', guildId: GUILD_ID, groupId: CATEGORY_ID, settings: exportSettings({ count: 50 }) });
    expect(expectOk(validateGroupSettingsRequest(request({ kind: 'guild', groupId: GUILD_ID })))).toMatchObject({ kind: 'guild', groupId: GUILD_ID });
    expect(expectOk(validateGroupSettingsRequest(request({ settings: null }))).settings).toBeNull();
  });

  it('returns a fresh, trimmed copy of the settings', () => {
    const settings = { ...exportSettings(), extra: 'x', content: { ...exportSettings().content, extra: 1 } };
    const value = expectOk(validateGroupSettingsRequest(request({ settings })));
    expect(value.settings).toEqual(exportSettings());
    expect(value.settings).not.toBe(settings);
  });

  it.each([
    ['kind is missing', { kind: undefined }],
    ['kind is unknown', { kind: 'channel' }],
    ['guildId is not numeric', { guildId: 'abc' }],
    ['guildId is a number', { guildId: 200000000000000001 }],
    ['guildId is missing', { guildId: undefined }],
    ['groupId is not numeric', { groupId: 'study' }],
    ['groupId is missing', { groupId: undefined }],
    ['the groupId of a server is not its guildId', { kind: 'guild', groupId: CATEGORY_ID }],
    ['settings are missing', { settings: undefined }],
    ['settings are a string', { settings: 'dark' }],
    ['settings are incomplete', { settings: { count: 5 } }],
    ['the count is 0', { settings: exportSettings({ count: 0 }) }],
    ['the count is 1000001', { settings: exportSettings({ count: 1_000_001 }) }],
    ['the count is a fraction', { settings: exportSettings({ count: 1.5 }) }],
    ['the range ends before it starts', { settings: exportSettings({ from: '2026-12-31T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }) }],
    ['the format is unknown', { settings: { ...exportSettings(), format: 'pdf' } }],
    ['the HTML theme is unknown', { settings: { ...exportSettings(), htmlTheme: 'blue' } }],
    ['a content option is not a boolean', { settings: { ...exportSettings(), content: { ...exportSettings().content, includeBots: 'yes' } } }],
  ])('refuses the request when %s', (_label, overrides) => {
    const result = validateGroupSettingsRequest(request(overrides));
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toEqual(expect.any(String));
  });

  it('accepts the edges of the count: 1, 1000000 and null', () => {
    for (const count of [1, 1_000_000, null]) expect(validateGroupSettingsRequest(request({ settings: exportSettings({ count }) })).ok).toBe(true);
  });
});

describe('validateKeyList (queue/removeMany)', () => {
  it('accepts an array of numeric-string keys and removes duplicates, keeping the order', () => {
    expect(expectOk(validateKeyList([CHANNEL_B, CHANNEL_A, CHANNEL_B]))).toEqual([CHANNEL_B, CHANNEL_A]);
    expect(expectOk(validateKeyList([]))).toEqual([]);
  });

  it('accepts exactly 5000 keys and refuses 5001 (the duplicates count: the limit is on the message)', () => {
    const keys = Array.from({ length: 5000 }, (_, index) => String(400000000000000000n + BigInt(index)));
    expect(expectOk(validateKeyList(keys))).toHaveLength(5000);
    expect(validateKeyList([...keys, keys[0]]).ok).toBe(false);
  });

  it.each([undefined, null, 'abc', 5, {}, { length: 1 }])('refuses %j (not an array)', (raw) => {
    expect(validateKeyList(raw).ok).toBe(false);
  });

  it.each([[['abc']], [[5]], [[null]], [['']], [[CHANNEL_A, 'x']], [[['1']]], [['1'.repeat(21)]]])('refuses the array %j (a key that is not a numeric string)', (raw) => {
    expect(validateKeyList(raw).ok).toBe(false);
  });
});

describe('job progress', () => {
  const item = (key: string, overrides: Partial<ItemProgress> = {}): ItemProgress => ({
    key,
    label: `label ${key}`,
    status: 'waiting',
    phase: null,
    fetched: 0,
    expected: 200,
    error: null,
    files: [],
    ...overrides,
  });
  const job = (overrides: Partial<JobState> = {}): JobState => ({
    jobId: 'job-1',
    accountId: ACCOUNT_ID,
    startedAt: 1000,
    finishedAt: null,
    state: 'running',
    pausedReason: null,
    zip: false,
    items: [item(CHANNEL_A), item(CHANNEL_B)],
    ...overrides,
  });

  it('terminal statuses are the four that end an item', () => {
    for (const status of ['done', 'partial', 'failed', 'cancelled'] as const) expect(isTerminalStatus(status)).toBe(true);
    for (const status of ['waiting', 'running', 'paused'] as const) expect(isTerminalStatus(status)).toBe(false);
  });

  it('mergeProgress takes the dynamic fields from the engine and keeps what the worker created', () => {
    const merged = mergeProgress(
      job(),
      job({
        accountId: 'someone else',
        startedAt: 5,
        zip: true,
        items: [item(CHANNEL_A, { label: 'engine label', status: 'running', phase: 'messages', fetched: 100, expected: 200, files: ['a.html'] }), item(CHANNEL_B)],
      }),
    );
    expect(merged).toMatchObject({ jobId: 'job-1', accountId: ACCOUNT_ID, startedAt: 1000, zip: false, state: 'running' });
    expect(merged?.items[0]).toEqual(item(CHANNEL_A, { status: 'running', phase: 'messages', fetched: 100, files: ['a.html'] }));
  });

  it('ignores a snapshot of another job, junk and snapshots without items', () => {
    expect(mergeProgress(job(), job({ jobId: 'other' }))).toBeNull();
    expect(mergeProgress(job(), null)).toBeNull();
    expect(mergeProgress(job(), 'x')).toBeNull();
    expect(mergeProgress(job(), { jobId: 'job-1' })).toBeNull();
  });

  it('maps paused to paused/rate-limit and every other state back to running', () => {
    expect(mergeProgress(job(), job({ state: 'paused', pausedReason: 'rate-limit' }))).toMatchObject({ state: 'paused', pausedReason: 'rate-limit' });
    for (const state of ['running', 'done', 'cancelled', 'failed'] as const) {
      expect(mergeProgress(job({ state: 'paused', pausedReason: 'rate-limit' }), job({ state }))).toMatchObject({ state: 'running', pausedReason: null, finishedAt: null });
    }
  });

  it('keeps the stored item when the engine does not mention it and never adds items', () => {
    const merged = mergeProgress(job(), { ...job(), items: [item(CHANNEL_B, { status: 'running' }), item('999', { status: 'running' })] });
    expect(merged?.items.map((i) => [i.key, i.status])).toEqual([
      [CHANNEL_A, 'waiting'],
      [CHANNEL_B, 'running'],
    ]);
  });

  it('a finished item cannot come back to life, but its details can still be completed', () => {
    const stored = job({ items: [item(CHANNEL_A, { status: 'done', fetched: 10 }), item(CHANNEL_B, { status: 'failed' })] });
    const merged = mergeProgress(stored, { ...job(), items: [item(CHANNEL_A, { status: 'running', fetched: 3 }), item(CHANNEL_B, { status: 'waiting' })] });
    expect(merged?.items).toEqual(stored.items);
    const more = mergeProgress(stored, { ...job(), items: [item(CHANNEL_A, { status: 'done', fetched: 12, files: ['x.html'] }), item(CHANNEL_B)] });
    expect(more?.items[0]).toMatchObject({ status: 'done', fetched: 12, files: ['x.html'] });
  });

  it('refuses malformed values field by field', () => {
    const bad = {
      ...job(),
      items: [
        {
          key: CHANNEL_A,
          status: 'sleeping',
          phase: 'dreaming',
          fetched: -4,
          expected: 'lots',
          error: { kind: 'oops', message: 'x' },
          files: 'a.html',
        },
      ],
    };
    expect(mergeProgress(job(), bad)?.items[0]).toEqual(item(CHANNEL_A));
    const good = {
      ...job(),
      items: [{ key: CHANNEL_A, status: 'running', phase: 'writing', fetched: 7, expected: null, error: { kind: 'network', message: 'm'.repeat(500) }, files: ['a', 5, 'b'] }],
    };
    const merged = mergeProgress(job(), good)?.items[0];
    expect(merged).toMatchObject({ status: 'running', phase: 'writing', fetched: 7, expected: null, files: ['a', 'b'] });
    expect(merged?.error?.message).toHaveLength(300);
  });

  it('normalizeJob only checks the shape', () => {
    expect(normalizeJob(job())).toEqual(job());
    for (const raw of [undefined, null, 'x', {}, { jobId: 'a' }, { ...job(), state: 'sleeping' }, { ...job(), items: 'x' }, { ...job(), accountId: 5 }]) {
      expect(normalizeJob(raw)).toBeNull();
    }
  });
});

describe('fixtures', () => {
  it('use ids the validators accept', () => {
    expect(validateTarget(guildTarget(CATEGORY_ID)).ok).toBe(true);
  });
});
