import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_SETTINGS, type ChatTarget, type ExportSettings } from '@/shared';
import { endOfDayIso, startOfDayIso } from '@/ui/format/dates';
import { summaryStrings } from '@/ui/format/strings';
import { FORMAT_CHIPS, FORMAT_NAMES, describeRange, discordCdnUrl, formatTargetLabel, safeImageUrl, summarizeSettings } from '@/ui/format/summary';
import { browserTimeZone, formatDateTime, resolveTimeZone, supportedTimeZones, toIsoString } from '@/ui/format/time';

const fmt = (n: number): string => new Intl.NumberFormat('en').format(n);
const defaults = (patch: Partial<ExportSettings> = {}): ExportSettings => ({ ...DEFAULT_EXPORT_SETTINGS, content: { ...DEFAULT_EXPORT_SETTINGS.content }, ...patch });
const ko = summaryStrings.ko;
const en = summaryStrings.en;

describe('formatTargetLabel (docs/PLAN.md §7.2)', () => {
  const channel: ChatTarget = { kind: 'guild-channel', channelId: '1', guildId: '2', guildName: 'Sample Server', channelName: 'general' };

  it('a channel is "서버 > #채널"', () => {
    expect(formatTargetLabel(channel)).toBe('Sample Server > #general');
  });

  it('a DM or group DM is just the name', () => {
    expect(formatTargetLabel({ kind: 'dm', channelId: '3', guildId: null, guildName: null, channelName: 'Alex' })).toBe('Alex');
    expect(formatTargetLabel({ kind: 'group-dm', channelId: '4', guildId: null, guildName: null, channelName: 'Alex, Sam' })).toBe('Alex, Sam');
  });

  it('a forum is "서버 > #포럼"', () => {
    expect(formatTargetLabel({ ...channel, kind: 'forum', channelName: 'questions' })).toBe('Sample Server > #questions');
  });

  it('a thread is "서버 > #부모 > 스레드", without the parent "서버 > 스레드"', () => {
    expect(formatTargetLabel({ ...channel, kind: 'thread', channelName: 'weekend plans', parentName: 'general' })).toBe('Sample Server > #general > weekend plans');
    expect(formatTargetLabel({ ...channel, kind: 'thread', channelName: 'weekend plans', parentName: null })).toBe('Sample Server > weekend plans');
  });

  it('a missing or blank server name is left out', () => {
    expect(formatTargetLabel({ ...channel, guildName: null })).toBe('#general');
    expect(formatTargetLabel({ ...channel, guildName: '  ' })).toBe('#general');
  });

  it('a blank channel name falls back to the id, so a row is never empty', () => {
    expect(formatTargetLabel({ ...channel, channelName: ' ' })).toBe('Sample Server > #1');
    expect(formatTargetLabel({ kind: 'dm', channelId: '3', guildId: null, guildName: null, channelName: '' })).toBe('3');
  });
});

describe('summarizeSettings (the line under a row: 200개 · HTML · 기간 없음)', () => {
  it('the defaults', () => {
    expect(summarizeSettings(defaults(), ko, fmt)).toBe('200개 · HTML · 기간 없음');
    expect(summarizeSettings(defaults(), en, fmt)).toBe('200 messages · HTML · No date range');
  });

  it('"전체" for no limit, the chip of every format', () => {
    expect(summarizeSettings(defaults({ count: null }), ko, fmt)).toBe('전체 · HTML · 기간 없음');
    for (const [format, chip] of Object.entries(FORMAT_CHIPS)) {
      expect(summarizeSettings(defaults({ format: format as ExportSettings['format'] }), ko, fmt)).toContain(` · ${chip} · `);
    }
  });

  it('the extras are appended in the order 첨부 · 스레드 · 새 메시지만, only when switched on', () => {
    expect(summarizeSettings(defaults({ includeAttachments: true }), ko, fmt)).toBe('200개 · HTML · 기간 없음 · 첨부');
    expect(summarizeSettings(defaults({ includeAttachments: true, includeThreads: true, incremental: true }), ko, fmt)).toBe(
      '200개 · HTML · 기간 없음 · 첨부 · 스레드 · 새 메시지만',
    );
    expect(summarizeSettings(defaults({ incremental: true }), en, fmt)).toBe('200 messages · HTML · No date range · new only');
  });

  it('formats a big count with separators and says "1 message" in the singular', () => {
    expect(summarizeSettings(defaults({ count: 1_000_000 }), ko, fmt)).toBe('1,000,000개 · HTML · 기간 없음');
    expect(summarizeSettings(defaults({ count: 1 }), en, fmt)).toBe('1 message · HTML · No date range');
  });

  it('describes the range by local calendar days', () => {
    const from = startOfDayIso('2026-01-01');
    const to = endOfDayIso('2026-03-31');
    expect(describeRange({ from, to }, ko)).toBe('2026-01-01 ~ 2026-03-31');
    expect(describeRange({ from, to: null }, ko)).toBe('2026-01-01부터');
    expect(describeRange({ from: null, to }, ko)).toBe('2026-03-31까지');
    expect(describeRange({ from, to }, en)).toBe('2026-01-01 – 2026-03-31');
    expect(describeRange({ from, to: null }, en)).toBe('From 2026-01-01');
    expect(describeRange({ from: null, to }, en)).toBe('Until 2026-03-31');
    expect(describeRange({ from: null, to: null }, ko)).toBe('기간 없음');
  });

  it('every format has a card title and a chip', () => {
    expect(Object.keys(FORMAT_NAMES).sort()).toEqual(['csv', 'html', 'json', 'md', 'txt', 'xlsx']);
    expect(Object.keys(FORMAT_CHIPS).sort()).toEqual(['csv', 'html', 'json', 'md', 'txt', 'xlsx']);
    expect(FORMAT_NAMES.xlsx).toBe('Excel (.xlsx)');
  });
});

describe('safeImageUrl', () => {
  it('lets the Discord CDN (https) and inline images through', () => {
    expect(safeImageUrl('https://cdn.discordapp.com/avatars/1/a.png')).toBe('https://cdn.discordapp.com/avatars/1/a.png');
    expect(safeImageUrl('https://media.discordapp.net/x.png')).toBe('https://media.discordapp.net/x.png');
    expect(safeImageUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(safeImageUrl('data:image/svg+xml;utf8,%3Csvg%3E')).toBe('data:image/svg+xml;utf8,%3Csvg%3E');
  });

  it('refuses everything else', () => {
    for (const url of [
      'http://cdn.discordapp.com/a.png',
      'https://example.com/a.png',
      'https://cdn.discordapp.com.evil.test/a.png',
      'javascript:alert(1)',
      'data:text/html;base64,AAAA',
      'chrome://settings',
      'file:///etc/passwd',
      'not a url',
      '',
      null,
      undefined,
    ]) {
      expect(safeImageUrl(url), String(url)).toBeNull();
    }
  });
});

describe('time helpers', () => {
  it('resolveTimeZone: "auto" and unknown zones mean the browser zone', () => {
    expect(resolveTimeZone('auto')).toBeUndefined();
    expect(resolveTimeZone('  ')).toBeUndefined();
    expect(resolveTimeZone('Not/AZone')).toBeUndefined();
    expect(resolveTimeZone('Asia/Seoul')).toBe('Asia/Seoul');
  });

  it('formatDateTime uses the language and the time zone of the settings', () => {
    const moment = Date.UTC(2026, 9, 6, 6, 4, 0); // 2026-10-06 06:04 UTC
    expect(formatDateTime(moment, 'ko', 'Asia/Seoul')).toContain('3:04');
    expect(formatDateTime(moment, 'ko', 'Asia/Seoul')).toContain('오후');
    // Newer ICU versions put a narrow no-break space before AM / PM.
    expect(formatDateTime(moment, 'en', 'UTC').replace(/\s/g, ' ')).toBe('Oct 6, 2026, 6:04 AM');
    expect(formatDateTime(moment, 'en', 'Pacific/Auckland')).toContain('Oct 6, 2026');
  });

  it('formatDateTime gives nothing for a missing or impossible time', () => {
    for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 9e15]) expect(formatDateTime(value, 'en'), String(value)).toBe('');
  });

  it('toIsoString', () => {
    expect(toIsoString(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(toIsoString(Number.NaN)).toBeUndefined();
    expect(toIsoString(9e15)).toBeUndefined();
  });

  it('the zone list is sorted and contains the usual zones; the browser zone is a string', () => {
    const zones = supportedTimeZones();
    expect(zones).toEqual([...zones].sort((a, b) => a.localeCompare(b, 'en')));
    expect(zones).toContain('Asia/Seoul');
    expect(typeof browserTimeZone()).toBe('string');
  });
});

describe('discordCdnUrl (server icons: the one host the background records)', () => {
  it('passes an https address on cdn.discordapp.com', () => {
    expect(discordCdnUrl('https://cdn.discordapp.com/icons/1/a.png?size=64')).toBe('https://cdn.discordapp.com/icons/1/a.png?size=64');
  });

  it('refuses everything else', () => {
    for (const url of [
      null,
      undefined,
      '',
      'http://cdn.discordapp.com/icons/1/a.png',
      'https://media.discordapp.net/icons/1/a.png',
      'https://discordapp.com/icons/1/a.png',
      'https://cdn.discordapp.com.evil.example/a.png',
      'https://cdn.discordapp.com@evil.example/a.png',
      'https://user:pw@cdn.discordapp.com/a.png',
      'https://cdn.discordapp.com:8443/a.png',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
      '//cdn.discordapp.com/a.png',
      'cdn.discordapp.com/a.png',
    ]) {
      expect(discordCdnUrl(url), String(url)).toBeNull();
    }
  });
});
